// ST-Fallback: No-PPLL focus sphere controls.
//
// When the WebGL2 backend doesn't support uimage2D / atomic_uint (e.g.
// SwiftShader, some sandboxed environments, or GPUs with incomplete
// image-load-store support), the PPLL pipeline in clearview.js cannot
// run. This module provides an alternative focus+context visualization
// by modulating the per-sample alpha of the existing ray-march shader
// (mode 2 = geresim) using the ClearView formula:
//
//   focusT      = clamp(distance(p, sphereCenter) / sphereRadius, 0, 1)
//   focusMask   = pow(focusT, 4.0)
//   perSampleAlpha *= focusMask
//
// Samples near the focus center become more transparent (so the user
// "sees through" the focus region to whatever is behind), while samples
// outside the focus sphere remain fully opaque (showing the surrounding
// context). This is the same mathematical kernel as ClearView's
// getClearViewContextFragmentOpacityFactor() — only the data source
// differs (face fragment vs. ray-march sample).
//
// The mouse picking here is screen-space drag (same as the PPLL path's
// ClearViewRenderer): horizontal/vertical pixel motion translates to
// camera-right/camera-up motion of the sphere center, with the
// translation magnitude scaled by 1/window-height so dragging is
// resolution-independent.

import * as THREE from 'three';

const SPHERE_CENTER_UNIFORM = 'uSphereCenter';
const SPHERE_RADIUS_UNIFORM = 'uSphereRadius';
const FOCUS_MODE_UNIFORM    = 'uFocusMode';

/**
 * Activates the focus visualization on the given ShaderMaterial by
 * setting the focus-related uniforms and registering mouse handlers.
 *
 * Returns a controller object with `dispose()`, `setSphereRadius()`,
 * and `sphereCenter` for external wiring (HUD sliders, etc).
 */
export function attachFocusControls({ canvas, camera, uniforms, mesh }) {
  // Initial sphere center = mesh bbox center.
  const bbox = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let p = 0; p < mesh.nPoints; p++) {
    v.set(mesh.positions[p * 3], mesh.positions[p * 3 + 1], mesh.positions[p * 3 + 2]);
    bbox.expandByPoint(v);
  }
  const sphereCenter = new THREE.Vector3(
    (bbox.min.x + bbox.max.x) * 0.5,
    (bbox.min.y + bbox.max.y) * 0.5,
    (bbox.min.z + bbox.max.z) * 0.5,
  );

  // Initial radius: 25% of the smallest bbox dimension — fits inside
  // the model without covering it.
  const bboxSize = new THREE.Vector3().subVectors(bbox.max, bbox.min);
  const initialRadius = Math.min(bboxSize.x, bboxSize.y, bboxSize.z) * 0.25;

  // Push initial uniforms.
  uniforms[SPHERE_CENTER_UNIFORM].value.copy(sphereCenter);
  uniforms[SPHERE_RADIUS_UNIFORM].value = initialRadius;
  uniforms[FOCUS_MODE_UNIFORM].value = 1;

  let sphereRadius = initialRadius;

  // ---- Mouse picking (screen-space drag) ----
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(e) {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  }
  function onPointerUp(e) {
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  }
  function onPointerMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    // World-per-pixel scale: project sphere radius onto screen height
    // so the sphere moves at a comfortable rate regardless of zoom.
    const distance = camera.position.distanceTo(sphereCenter);
    const worldPerPixel = (sphereRadius / canvas.clientHeight) * 2.0;

    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    camera.matrixWorld.extractBasis(right, up, new THREE.Vector3());
    sphereCenter.add(right.multiplyScalar(dx * worldPerPixel));
    sphereCenter.add(up.multiplyScalar(-dy * worldPerPixel));

    uniforms[SPHERE_CENTER_UNIFORM].value.copy(sphereCenter);
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointermove', onPointerMove);

  return {
    sphereCenter,
    get sphereRadius() { return sphereRadius; },
    setSphereRadius(r) {
      sphereRadius = r;
      uniforms[SPHERE_RADIUS_UNIFORM].value = r;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      uniforms[FOCUS_MODE_UNIFORM].value = 0;
    },
  };
}