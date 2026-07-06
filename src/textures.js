// ST-1: Upload ClearView buffer data to GPU as textures.
//
// All WebGL2 textures created here support the operations the ClearView
// shaders need:
//   - DataTexture (RG32UI / RGBA32F / RG32F / R32F): read via texelFetch
//   - image2D-capable textures (for startOffset/fragment buffers): read
//     AND written via imageLoad/imageStore/imageAtomicExchange. WebGL2
//     supports these natively on integer internal formats.

import * as THREE from 'three';

/**
 * Upload the face buffer to a GPU texture (RG32UI, 2x H).
 * Each face = 2 texels:
 *   texel (0, faceId) → vertexIdx[0..3] in .r/.g/.b/.a
 *   texel (1, faceId) → edgeIdx[0..3]   in .r/.g/.b/.a
 */
export function uploadFaceTexture(gl, faces) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32UI, faces.width, faces.height);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, faces.width, faces.height,
                   gl.RG_INTEGER, gl.UNSIGNED_INT, faces.texels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Upload the vertex buffer (RGBA32F, W x 1).
 * Each texel = (x, y, z, scalar) for one cell-corner slot.
 */
export function uploadVertexTexture(gl, vertices) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, vertices.width, vertices.height);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, vertices.width, vertices.height,
                   gl.RGBA, gl.FLOAT, vertices.texels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Upload the edge buffer (RG32F, W x 1).
 * Each texel = (edgeAttribute, edgeLodValue).
 */
export function uploadEdgeTexture(gl, edges) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RG32F, edges.width, edges.height);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, edges.width, edges.height,
                   gl.RG, gl.FLOAT, edges.texels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Upload the cell scalar per-face buffer (R32F, W x 1).
 * Each texel = average scalar for the cell owning this face.
 */
export function uploadCellScalarTexture(gl, cellScalar) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, cellScalar.width, cellScalar.height);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cellScalar.width, cellScalar.height,
                   gl.RED, gl.FLOAT, cellScalar.texels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Allocate the PPLL startOffset buffer (R32UI, W x H, image2D-compatible).
 * Width × Height = viewport pixel size. Each pixel = head of a linked list.
 * Initialized to 0xFFFFFFFF (-1 as uint).
 */
export function createStartOffsetImage(gl, width, height) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32UI, width, height);
  // Initialize to -1 (0xFFFFFFFF) — end-of-list sentinel.
  const init = new Uint32Array(width * height);
  init.fill(0xFFFFFFFF);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height,
                   gl.RED_INTEGER, gl.UNSIGNED_INT, init);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/**
 * Allocate the PPLL fragment buffer (RGBA32UI, W x H, image2D-compatible).
 * Each pixel = one fragment node (color + depth + next).
 * Initialized to all zeros.
 */
export function createFragmentBufferImage(gl, width, height) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32UI, width, height);
  // Initialize to zero — next=0 means "no fragment here yet".
  const init = new Uint32Array(width * height * 4);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height,
                   gl.RGBA_INTEGER, gl.UNSIGNED_INT, init);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}