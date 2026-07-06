// ST-9: ClearView (Unified) renderer for Three.js + WebGL2.
//
// 3-pass pipeline:
//   1. Clear:    fullscreen quad → reset startOffset to -1
//   2. Gather:   per-face triangles → atomic insertion into PPLL
//   3. Resolve:  fullscreen quad → walk + sort + alpha blend
//
// Reference: /tmp/HexVolumeRenderer/src/Mesh/HexMesh/Renderers/
//            ClearViewRenderer_FacesUnified.cpp (3-pass architecture)

import * as THREE from 'three';
import { buildClearViewBuffers } from './buffer-data.js';
import {
  uploadFaceTexture,
  uploadVertexTexture,
  uploadEdgeTexture,
  uploadCellScalarTexture,
  createStartOffsetImage,
  createFragmentBufferImage,
} from './textures.js';
import { loadShaders } from './shader-loader.js';

// Fragment buffer dimensions. Tuned for SPE-9 (54000 faces, ~30-60 depth).
// 2048 × 2048 = 4M fragments ≈ 64 MB at RGBA32UI.
const FRAG_BUFFER_W = 2048;
const FRAG_BUFFER_H = 2048;
const LINKED_LIST_SIZE = FRAG_BUFFER_W * FRAG_BUFFER_H;

const MAX_NUM_FRAGS_RESOLVE = 32;   // per-pixel resolve cutoff (insertion sort cap)

/**
 * Runtime detection: does this WebGL2 context support image2D + atomic_uint?
 * SwiftShader's WebGL2 implementation does NOT support either — it returns
 * null/undefined for MAX_IMAGE_UNITS. Real GPUs (NVIDIA/AMD/Intel/Apple) and
 * modern SwiftShader (post-2024) all support both.
 */
export function supportsPPLL(gl) {
  try {
    // Try to compile a minimal fragment shader using layout(r32ui) uimage2D.
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, `#version 300 es
precision highp float;
layout(r32ui) uniform highp uimage2D testImg;
layout(binding=0, offset=0) uniform atomic_uint testCounter;
out vec4 fragColor;
void main() {
  uint x = atomicCounterIncrement(testCounter);
  imageAtomicExchange(testImg, ivec2(0), x);
  fragColor = vec4(1.0);
}`);
    gl.compileShader(fs);
    const ok = gl.getShaderParameter(fs, gl.COMPILE_STATUS);
    gl.deleteShader(fs);
    return ok;
  } catch (e) {
    return false;
  }
}

export class ClearViewRenderer {
  constructor(gl, mesh, camera, canvas, shaders) {
    this.gl = gl;
    this.mesh = mesh;
    this.camera = camera;
    this.canvas = canvas;
    this.shaders = shaders;

    // Build CPU-side buffers.
    this.buffers = buildClearViewBuffers(mesh);
    this.faceCount = this.buffers.faceCount;

    // Upload data textures.
    this.faceTex = uploadFaceTexture(gl, this.buffers.faces);
    this.vertexTex = uploadVertexTexture(gl, this.buffers.vertices);
    this.edgeTex = uploadEdgeTexture(gl, this.buffers.edges);

    // Per-face cell scalar (for color lookup; currently we use vertex average
    // instead, but this texture is reserved for future use).
    this.cellScalarTex = uploadCellScalarTexture(gl, this.buffers.cellScalar);

    // PPLL textures (allocated lazily based on viewport size).
    this.startOffsetTex = null;
    this.fragmentBufferTex = null;
    this.viewportW = 0;
    this.viewportH = 0;

    // Compile shaders and create programs.
    this.gatherProgram = this._compileProgram(shaders.clearviewVertex, shaders.clearviewFragment);
    this.clearProgram  = this._compileProgram(this._fullscreenVertexShader(), shaders.ppllClear);
    this.resolveProgram= this._compileProgram(this._fullscreenVertexShader(), shaders.ppllResolve);

    // VAOs.
    this._setupVAOs();

    // Atomic counter buffer.
    this._setupAtomicCounter();

    // Sphere picking state.
    this.sphereCenter = new THREE.Vector3();
    this._initSphereCenter();
    this.sphereRadius = 200;   // overridden by caller via setSphereRadius
    this.lineWidth = 4.0;

    // Find mesh bbox for sphere default position.
    const bbox = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let p = 0; p < mesh.nPoints; p++) {
      v.set(mesh.positions[p*3], mesh.positions[p*3+1], mesh.positions[p*3+2]);
      bbox.expandByPoint(v);
    }
    this.bbox = bbox;

    // Mouse picking.
    this._dragging = false;
    this._lastMouseX = 0;
    this._lastMouseY = 0;
    this._mouseDownHandler = this._onMouseDown.bind(this);
    this._mouseUpHandler = this._onMouseUp.bind(this);
    this._mouseMoveHandler = this._onMouseMove.bind(this);
    canvas.addEventListener('pointerdown', this._mouseDownHandler);
    window.addEventListener('pointerup', this._mouseUpHandler);
    window.addEventListener('pointermove', this._mouseMoveHandler);
  }

  _initSphereCenter() {
    // Center of the mesh, computed once.
    const bb = this._computeBbox();
    this.sphereCenter.set(
      (bb.min.x + bb.max.x) * 0.5,
      (bb.min.y + bb.max.y) * 0.5,
      (bb.min.z + bb.max.z) * 0.5
    );
  }

  _computeBbox() {
    const bb = new THREE.Box3();
    const v = new THREE.Vector3();
    for (let p = 0; p < this.mesh.nPoints; p++) {
      v.set(this.mesh.positions[p*3], this.mesh.positions[p*3+1], this.mesh.positions[p*3+2]);
      bb.expandByPoint(v);
    }
    return bb;
  }

  _compileProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(vs);
      console.error('[clearview] vertex shader compile failed:', log);
      console.error('[clearview] source:\n' + vsSrc);
      throw new Error('Vertex shader compile failed: ' + log);
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(fs);
      console.error('[clearview] fragment shader compile failed:', log);
      console.error('[clearview] source:\n' + fsSrc);
      throw new Error('Fragment shader compile failed: ' + log);
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      console.error('[clearview] program link failed:', log);
      throw new Error('Program link failed: ' + log);
    }
    // Cache uniform locations.
    const uniforms = {};
    const numUniforms = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < numUniforms; i++) {
      const info = gl.getActiveUniform(prog, i);
      uniforms[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return { program: prog, uniforms };
  }

  _fullscreenVertexShader() {
    return `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
void main() {
  gl_Position = vec4(aPosition.xy, 0.0, 1.0);
}`;
  }

  _setupVAOs() {
    const gl = this.gl;

    // Gather VAO: no vertex attributes (we use gl_VertexID only).
    this.gatherVAO = gl.createVertexArray();

    // Clear and Resolve VAOs: fullscreen triangle.
    const fsQuad = new Float32Array([
      -1, -1, 0,
       3, -1, 0,
      -1,  3, 0,
    ]);
    this.fsVBO = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fsVBO);
    gl.bufferData(gl.ARRAY_BUFFER, fsQuad, gl.STATIC_DRAW);

    this.clearVAO = gl.createVertexArray();
    gl.bindVertexArray(this.clearVAO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    this.resolveVAO = gl.createVertexArray();
    gl.bindVertexArray(this.resolveVAO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
  }

  _setupAtomicCounter() {
    const gl = this.gl;
    // Atomic counter buffer: zero-filled Uint32. Bound to binding=0 as
    // declared in ppll-header.glsl (single counter, offset=0).
    this.atomicCounterBuf = gl.createBuffer();
    const zeroData = new Uint32Array([0]);
    gl.bindBuffer(gl.ATOMIC_COUNTER_BUFFER, this.atomicCounterBuf);
    gl.bufferData(gl.ATOMIC_COUNTER_BUFFER, zeroData, gl.DYNAMIC_COPY);
    gl.bindBufferBase(gl.ATOMIC_COUNTER_BUFFER, 0, this.atomicCounterBuf);
    gl.bindBuffer(gl.ATOMIC_COUNTER_BUFFER, null);
  }

  _ensurePPLLBuffers(width, height) {
    if (this.startOffsetTex && this.viewportW === width && this.viewportH === height) {
      return;
    }
    if (this.startOffsetTex) {
      this.gl.deleteTexture(this.startOffsetTex);
    }
    if (this.fragmentBufferTex) {
      this.gl.deleteTexture(this.fragmentBufferTex);
    }
    this.startOffsetTex = createStartOffsetImage(this.gl, width, height);
    this.fragmentBufferTex = createFragmentBufferImage(this.gl, FRAG_BUFFER_W, FRAG_BUFFER_H);
    this.viewportW = width;
    this.viewportH = height;
  }

  _resetAtomicCounter() {
    // Reset the atomic counter to zero by uploading zeros.
    const gl = this.gl;
    const zeroData = new Uint32Array([0]);
    gl.bindBuffer(gl.ATOMIC_COUNTER_BUFFER, this.atomicCounterBuf);
    gl.bufferSubData(gl.ATOMIC_COUNTER_BUFFER, 0, zeroData);
    gl.bindBuffer(gl.ATOMIC_COUNTER_BUFFER, null);
  }

  _setUniform1i(progObj, name, val) {
    if (progObj.uniforms[name]) this.gl.uniform1i(progObj.uniforms[name], val);
  }
  _setUniform1f(progObj, name, val) {
    if (progObj.uniforms[name]) this.gl.uniform1f(progObj.uniforms[name], val);
  }
  _setUniform3fv(progObj, name, val) {
    if (progObj.uniforms[name]) this.gl.uniform3fv(progObj.uniforms[name], val);
  }
  _setUniformMatrix4fv(progObj, name, val) {
    if (progObj.uniforms[name]) this.gl.uniformMatrix4fv(progObj.uniforms[name], false, val);
  }
  _setUniform2f(progObj, name, a, b) {
    if (progObj.uniforms[name]) this.gl.uniform2f(progObj.uniforms[name], a, b);
  }

  // ------- Picking -------

  _onMouseDown(e) {
    this._dragging = true;
    this._lastMouseX = e.clientX;
    this._lastMouseY = e.clientY;
  }

  _onMouseUp() {
    this._dragging = false;
  }

  _onMouseMove(e) {
    if (!this._dragging) return;
    const dx = e.clientX - this._lastMouseX;
    const dy = e.clientY - this._lastMouseY;
    this._lastMouseX = e.clientX;
    this._lastMouseY = e.clientY;

    // Move sphere center in screen-space direction.
    // Convert screen delta to world delta using camera right/up vectors.
    const camPos = this.camera.position;
    const camTarget = new THREE.Vector3();
    this.camera.getWorldDirection(camTarget).multiplyScalar(-1).add(camPos);

    const dist = camPos.distanceTo(camTarget);
    const fovY = this.camera.fov * Math.PI / 180;
    const worldPerPixel = (2 * dist * Math.tan(fovY / 2)) / this.canvas.height;

    const right = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(camTarget, camPos).normalize(),
      this.camera.up
    ).normalize();
    const up = new THREE.Vector3().crossVectors(right,
      new THREE.Vector3().subVectors(camTarget, camPos).normalize()
    ).normalize();

    this.sphereCenter.add(right.clone().multiplyScalar(dx * worldPerPixel));
    this.sphereCenter.add(up.clone().multiplyScalar(-dy * worldPerPixel));
  }

  setSphereRadius(r) { this.sphereRadius = r; }
  setLineWidth(w) { this.lineWidth = w; }

  // ------- Render -------

  render(renderer, scene, camera) {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this._ensurePPLLBuffers(w, h);
    this._resetAtomicCounter();

    // ----- Pass 1: clear startOffset -----
    renderer.setRenderTarget(null);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    gl.useProgram(this.clearProgram.program);
    gl.bindVertexArray(this.clearVAO);

    // Bind image2D textures to texture units first.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.startOffsetTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.fragmentBufferTex);

    // image2D bindings (binding points).
    gl.bindImageTexture(0, this.startOffsetTex, 0, false, 0, gl.READ_WRITE, gl.R32UI);
    gl.bindImageTexture(1, this.fragmentBufferTex, 0, false, 0, gl.READ_WRITE, gl.RGBA32UI);
    // Atomic counter (already bound at construction, but re-bind for safety).
    gl.bindBufferBase(gl.ATOMIC_COUNTER_BUFFER, 0, this.atomicCounterBuf);

    this._setUniform1i(this.clearProgram, 'uStartOffsetTex', 0);
    this._setUniform1i(this.clearProgram, 'uFragmentBufferTex', 1);
    this._setUniform1i(this.clearProgram, 'uViewportW', w);
    this._setUniform1i(this.clearProgram, 'uViewportH', h);
    this._setUniform1i(this.clearProgram, 'uLinkedListSize', LINKED_LIST_SIZE);

    // Atomic counter binding requires the program to have an active atomic
    // counter at the matching location. Skip if program doesn't have it
    // (some drivers are picky).
    const atomicIdx = gl.getProgramParameter
      ? gl.getProgramParameter(this.clearProgram.program, gl.ACTIVE_ATOMIC_COUNTER_BUFFERS)
      : -1;

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ----- Pass 2: gather -----
    gl.useProgram(this.gatherProgram.program);

    // Bind image2D textures.
    gl.bindImageTexture(0, this.startOffsetTex, 0, false, 0, gl.READ_WRITE, gl.R32UI);
    gl.bindImageTexture(1, this.fragmentBufferTex, 0, false, 0, gl.READ_WRITE, gl.RGBA32UI);
    gl.bindBufferBase(gl.ATOMIC_COUNTER_BUFFER, 0, this.atomicCounterBuf);

    // Bind data textures.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.faceTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.vertexTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.edgeTex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.cellScalarTex);

    this._setUniform1i(this.gatherProgram, 'uFaceTex', 0);
    this._setUniform1i(this.gatherProgram, 'uVertexTex', 1);
    this._setUniform1i(this.gatherProgram, 'uEdgeTex', 2);
    this._setUniform1i(this.gatherProgram, 'uCellScalarTex', 3);
    this._setUniform1i(this.gatherProgram, 'uStartOffsetTex', 0);
    this._setUniform1i(this.gatherProgram, 'uFragmentBufferTex', 1);
    this._setUniform1i(this.gatherProgram, 'uViewportW', w);
    this._setUniform1i(this.gatherProgram, 'uViewportH', h);
    this._setUniform1i(this.gatherProgram, 'uLinkedListSize', LINKED_LIST_SIZE);

    this._setUniform1i(this.gatherProgram, 'uFaceCount', this.faceCount);
    this._setUniform1i(this.gatherProgram, 'uTexWidth', this.buffers.texWidth);

    // Camera matrices.
    const mvp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._setUniformMatrix4fv(this.gatherProgram, 'uModelViewProjection', mvp.elements);
    this._setUniformMatrix4fv(this.gatherProgram, 'uModelMatrix', camera.matrixWorldInverse.elements);

    this._setUniform3fv(this.gatherProgram, 'uCameraPosition', camera.position.toArray());
    const lookDir = new THREE.Vector3();
    camera.getWorldDirection(lookDir);
    this._setUniform3fv(this.gatherProgram, 'uLookingDirection', lookDir.toArray());

    this._setUniform3fv(this.gatherProgram, 'uSphereCenter', this.sphereCenter.toArray());
    this._setUniform1f(this.gatherProgram, 'uSphereRadius', this.sphereRadius);
    this._setUniform1f(this.gatherProgram, 'uLineWidth', this.lineWidth);

    this._setUniform1f(this.gatherProgram, 'uMaxLodValue', 1.0);
    this._setUniform1f(this.gatherProgram, 'uSelectedLodValueFocus', 0.4);
    this._setUniform1f(this.gatherProgram, 'uSelectedLodValueContext', 0.7);
    this._setUniform1f(this.gatherProgram, 'uImportantLineBoostFactor', 0.5);

    this._setUniform3fv(this.gatherProgram, 'uBackgroundColor', [0, 0, 0]);
    this._setUniform3fv(this.gatherProgram, 'uForegroundColor', [1, 1, 1]);

    this._setUniform3fv(this.gatherProgram, 'uEdgeColor', [0, 0, 0]);
    this._setUniform1f(this.gatherProgram, 'uScalarMin', this.buffers.sMin);
    this._setUniform1f(this.gatherProgram, 'uScalarMax', this.buffers.sMax);
    this._setUniform1f(this.gatherProgram, 'uFovY', camera.fov * Math.PI / 180);
    this._setUniform2f(this.gatherProgram, 'uViewportSize', w, h);

    gl.bindVertexArray(this.gatherVAO);
    gl.drawArrays(gl.TRIANGLES, 0, this.faceCount * 6);

    // ----- Pass 3: resolve -----
    gl.useProgram(this.resolveProgram.program);
    gl.bindImageTexture(0, this.startOffsetTex, 0, false, 0, gl.READ_ONLY, gl.R32UI);
    gl.bindImageTexture(1, this.fragmentBufferTex, 0, false, 0, gl.READ_ONLY, gl.RGBA32UI);

    this._setUniform1i(this.resolveProgram, 'uStartOffsetTex', 0);
    this._setUniform1i(this.resolveProgram, 'uFragmentBufferTex', 1);
    this._setUniform1i(this.resolveProgram, 'uViewportW', w);
    this._setUniform1i(this.resolveProgram, 'uViewportH', h);
    this._setUniform1i(this.resolveProgram, 'uLinkedListSize', LINKED_LIST_SIZE);

    gl.bindVertexArray(this.resolveVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(null);
    gl.useProgram(null);
    gl.bindImageTexture(0, null, 0, false, 0, gl.READ_WRITE, gl.R32UI);
    gl.bindImageTexture(1, null, 0, false, 0, gl.READ_WRITE, gl.RGBA32UI);
  }

  dispose() {
    const gl = this.gl;
    this.canvas.removeEventListener('pointerdown', this._mouseDownHandler);
    window.removeEventListener('pointerup', this._mouseUpHandler);
    window.removeEventListener('pointermove', this._mouseMoveHandler);

    gl.deleteProgram(this.gatherProgram.program);
    gl.deleteProgram(this.clearProgram.program);
    gl.deleteProgram(this.resolveProgram.program);

    gl.deleteTexture(this.faceTex);
    gl.deleteTexture(this.vertexTex);
    gl.deleteTexture(this.edgeTex);
    gl.deleteTexture(this.cellScalarTex);
    if (this.startOffsetTex) gl.deleteTexture(this.startOffsetTex);
    if (this.fragmentBufferTex) gl.deleteTexture(this.fragmentBufferTex);

    gl.deleteBuffer(this.fsVBO);
    gl.deleteBuffer(this.atomicCounterBuf);
    gl.deleteVertexArray(this.gatherVAO);
    gl.deleteVertexArray(this.clearVAO);
    gl.deleteVertexArray(this.resolveVAO);
  }
}