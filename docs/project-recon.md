# Project Recon — ClearView Implementation Prep

**Date:** 2026-07-06
**Author:** code agent (subagent)
**Project:** `/Users/hihihan/code-workspace/sandbox/amory-site/geresim-spike/`
**Reference:** `/tmp/HexVolumeRenderer/` (TVCG 2021 paper *Interactive Focus+Context Rendering for Hexahedral Mesh Inspection* by Neuhauser et al.)

---

## 1. Existing Application

Single-page Three.js + WebGL2 + GLSL3 application. Loaded via `importmap` from CDN (`three@0.160.0`). No bundler — raw `<script type="module">` in `index.html`. Total ~58 KB / 1700 lines, all inline.

### 1.1 Modes

| `uMode` | Name | Implementation |
|---|---|---|
| 0 | wire | **Placeholder red** — to be replaced with ClearView (this work) |
| 1 | solid | 300-step raymarch, per-cell constant color, alpha-blend, edges overlaid |
| 2 | geresim | 600-step raymarch, Miranda-Celes per-cell gradient shading, alpha-blend, edges overlaid |

Plus toggleable true LineSegments wireframe (orthogonal to mode).

### 1.2 Data Pipeline (SPE-9)

1. **VTK parser** (`parseVTK` in `index.html`): reads legacy ASCII `UNSTRUCTURED_GRID`, extracts `positions` (Float32, nPoints×3), `cellConn` (Uint32, nCells×8 hex vertex indices), `scalars` (Float32, nPoints).
2. **Vertex order remap**: `VTK_TO_STD = [0,1,3,2,4,5,7,6]` applied at write time so the shader gets STD-corner-order data (c000, c100, c010, c110, c001, c101, c011, c111).
3. **Cell data texture** (RGBA32F, 2D): `W = 8 × K` where `K = 16` cells/row. Each cell row contains 8 contiguous texels (one per corner) holding `(x, y, z, scalar)`. `H = ceil(nCells/K)`. Addressed in shader as `texelFetch(uCellData, ivec2(colBase+cornerIdx, row), 0)` where `colBase = (cellIdx % K) * 8` and `row = cellIdx / K`.
4. **Cell index texture** (R32UI, 3D, 64³): per-voxel cell lookup. Built with 8³ coarse-grid AABB prefilter then first-fit selection. Out-of-cell voxels store `0xFFFFFFFF`.
5. **Bbox**: `THREE.Box3` expanded over all points; used for ray-AABB intersection and dynamic step-size scaling.

### 1.3 Shader Uniforms (existing)

```glsl
uniform vec3  uBboxMin, uBboxMax;
uniform sampler2D uCellData;        // RGBA32F, 8 corners/cell
uniform usampler3D uCellIndex;      // R32UI, 64^3 voxel → cell index
uniform int  uGridSize;
uniform vec3  uCamPos, uCamFwd, uCamRight, uCamUp;
uniform float uFovY;
uniform int   uMode, uShowEdges, uEdgeSamp;
uniform float uEdgeAlpha, uBodyAlpha;
uniform vec3  uEdgeColor;
uniform float uScalarMin, uScalarMax;
uniform int   uTexK;
uniform int   uDebug;
```

### 1.4 Diagnostics

- `diagnose.mjs` — playwright + chromium (ANGLE/SwiftShader). Captures HUD text, console, page errors, screenshot. Used for self-testing.
- `compare.mjs`, `verify_render.mjs`, `coverage_check.mjs`, `verify_fron_order.mjs`, `render_fron.mjs`, `smoke_test.mjs`, `test-banner.mjs`, `test-fix.mjs` — analysis/harness scripts.
- `static_server.mjs` — local dev server.

---

## 2. Reference Implementation (`/tmp/HexVolumeRenderer/Data/Shaders/`)

The reference is a C++/OpenGL 4.3 application. We are porting **only the ClearView (Unified) face-based renderer** (specifically `ClearViewRenderer_FacesUnified`). Skipping volume-based variants per `PLAN.md` §Out of scope.

### 2.1 Required Shader Files (9 components)

| # | File | Role |
|---|------|------|
| 1 | `Utils/PointToLineDistance.glsl` | `getDistanceToLineSegment()` — used 4× per fragment |
| 2 | `Utils/RayIntersection.glsl` | `raySphereIntersection()`, `rayPlaneIntersection()` |
| 3 | `ClearView/ClearView.glsl` | `getClearViewContextFragmentOpacityFactor()` — `pow(d, 4)` |
| 4 | `ClearView/HexMeshUnified.glsl` | Vertex + fragment shader (740 lines, core) |
| 5 | `ClearView/FocusOutlineShader.glsl` | Optional focus sphere outline (NOT required by hard constraint but in 9-component list) |
| 6 | `ClearView/DepthCues.glsl` | Depth-based fade (compute + uniforms) |
| 7 | `LinkedList/LinkedListHeader.glsl` | SSBO declarations, atomic counter |
| 8 | `LinkedList/LinkedListGather.glsl` | `gatherFragmentCustomDepth()` — atomic insertion |
| 9 | `LinkedList/LinkedListResolve.glsl` + `LinkedListSort.glsl` | Linked-list traversal + insertion sort + back-to-front blend |

### 2.2 Buffer Layout (reference uses SSBOs — we must adapt)

```
struct HexahedralCellFaceUnified {      // 32 B/face
    uint vertexIdx[4];   // 16 B
    uint edgeIdx[4];     // 16 B
};

struct HexahedralCellVertexUnified {    // 16 B/vertex
    vec3 vertexPosition;   // 12 B (padded to 16 by std430)
    float vertexAttribute; // 4 B
};

struct HexahedralCellEdgeUnified {      // 8 B/edge
    float edgeAttribute;   // 4 B
    float edgeLodValue;    // 4 B
};
```

SPE-9 counts:
- **Faces (per-cell enumeration per PLAN):** 6 × 9000 = 54000 entries → 1.7 MB
- **Vertices:** 8 × 9000 = 72000 entries → 1.15 MB
- **Edges:** 12 × 9000 = 108000 entries → 864 KB

### 2.3 Hard Constraint: WebGL2 Has No SSBO

WebGL2 supports:
- ✅ `usampler2D` / `usampler3D` and `texelFetch`
- ✅ `image2D` / `image3D` with `imageLoad`/`imageStore`
- ✅ `imageAtomicAdd`/`imageAtomicExchange`/etc. on integer images
- ✅ `atomic_uint` counter with `atomicCounterIncrement`/`atomicCounterDecrement`
- ✅ `gl_VertexID` (no need for `OES_draw_buffers_indexed`)
- ❌ **`layout(std430, binding=N) buffer` — NOT supported in WebGL2**

**Strategy:** Encode SSBO data as integer/float **Data Textures** and use `texelFetch` for read, `imageStore`/`imageAtomic*` for write. The header `LinkedListHeader.glsl` declares SSBOs — we must rewrite this for WebGL2.

### 2.4 Mapping from SSBO → image2D

| Reference SSBO | WebGL2 replacement |
|---|---|
| `FaceBuffer` (binding=6) | `usampler2D uFaceBuffer` (RG32UI, 2 texels/face for 8 uints) |
| `VertexBuffer` (binding=7) | `sampler2D uVertexBuffer` (RGBA32F, 1 texel/vertex for vec3+float) |
| `EdgeBuffer` (binding=8) | `sampler2D uEdgeBuffer` (RG32F, 1 texel/edge for 2 floats) |
| `StartOffsetBuffer` (binding=0) | `image2D uStartOffsetTex` (R32UI, W×H) |
| `FragmentBuffer` (binding=1) | `image2D uFragmentBufferTex` (RGBA32UI, 1 texel/fragment) |
| `atomic_uint fragCounter` | same — `layout(binding=0, offset=0) uniform atomic_uint uFragCounter` |

### 2.5 Focus + Context Math (from `ClearView.glsl`)

- `distanceToFocusPointNormalized = clamp(length(p - sphereCenter)/sphereRadius, 0, 1)`
- `focusFactor = 1.0` if `d <= 0.7`, smoothstep blend `[0.7, 1.0]`, else 0
- `contextFactor = pow(d, 4.0)` if `(intersectsSphere && (inSphere || fragmentDepth < t1))`, else 1.0
- `volumeColor.a *= contextFactor` (so context region is faint, focus region is opaque)
- `lineWidthPrime = lineWidth * (-d * 0.3 + 1.0)` (lines get thinner farther from focus)
- `lineRadius = lineWidthPrime / 2.0`
- For each of 4 face edges: `getDistanceToLineSegment(fragmentPos, v[i], v[(i+1)%4])`
- `minDistance` (smallest, must pass LOD), `minDistanceAll` (smallest, ignore LOD for faint outline)
- `lineCoordinates = minDistance / lineRadius`
- `coverage = 1 - smoothstep(1 - 2*EPS, 1, lineCoordinates)`
- `EPSILON = clamp(getAntialiasingFactor(fragmentDistance/lineRadius), 0, 0.49)`
- `getAntialiasingFactor(d) = d / viewportH * fieldOfViewY`

### 2.6 LOD Logic

```glsl
discreteLodValue = edgeLodValue * maxLodValue
discreteSelectedLodFocus   = max(edgeAttribute < 1 - boostFactor ? 0 : maxLodValue, focusLodNorm * maxLodValue)
discreteSelectedLodContext = max(contextLodNorm * maxLodValue, EPS)
drawLine = mix(discreteLodValue <= contextLod ? 1 : 0,
               discreteLodValue <= focusLod ? 1 : 0,
               focusFactor) > 0.01
```

Per PLAN, we don't compute true sheet-collapse LOD; we proxy `edgeLod = 1 - normalizedScalar`. (All edges for a given scalar level pass the threshold — a degenerate but workable simplification.)

### 2.7 Linked-List Resolve

1. `gatherFragmentCustomDepth(blendedColor, fragmentDistance)` (depth = `length(p - cameraPos)`):
   - Skip if `color.a < 1e-4` (or `return` because of `GATHER_NO_DISCARD` — we have two gather sites)
   - `insertIndex = atomicCounterIncrement(fragCounter)`
   - `frag.next = atomicExchange(startOffset[pixelIndex], insertIndex)`
   - `fragmentBuffer[insertIndex] = frag`
2. Resolve pass (fullscreen quad): walk `startOffset[pixelIndex]`, gather up to `MAX_NUM_FRAGS` (32) entries.
3. Insertion-sort by depth.
4. Front-to-back alpha blend (or back-to-front per PLAN: `dst = src*src.a + dst*(1-src.a)` — but reference uses `blendFTB` for accumulator; insertion-sort gives ascending depth so FTB iteration is correct).

### 2.8 Critical Implementation Notes

- **GATHER_NO_DISCARD** must be defined in gather shader because the same shader includes both `getClearViewContextFragmentOpacityFactor()` (returns 0 for some pixels = no frag) and the focus-region gathering. Without it, `discard` would skip the focus gather.
- **Atomic counters require `layout(binding=N, offset=0) uniform atomic_uint`** in WebGL2. Multiple counters share the same binding, distinguished by `offset`.
- **imageStore + imageAtomicExchange** must be on `image2D` declared `readonly coherent` or `coherent writeonly` as appropriate.
- **`gl_VertexID`** works without extensions in WebGL2.
- **`early_fragment_tests`** in WebGL2 is `layout(early_fragment_tests) in;`.
- **`pixel_center_integer`** in WebGL2 is `layout(pixel_center_integer) in vec4 gl_FragCoord;`.

---

## 3. Architecture Decision

### 3.1 Rendering Pipeline (3 passes)

1. **Clear pass**: fullscreen quad → `uStartOffsetTex` written with `-1u` (0xFFFFFFFF).
2. **Gather pass**: per-cell-face rasterization (4 vertices/face, 2 triangles/face, 54000 faces × 2 = 108000 triangles). Fragment shader computes blended color + depth, atomically inserts into PPLL.
3. **Resolve pass**: fullscreen quad → walks each pixel's linked list, sorts, blends to default framebuffer.

### 3.2 Mouse Picking for Focus Sphere

Simplest approach: cast ray from camera through mouse position into scene, intersect with mesh AABB or with a virtual plane through the mesh center. Set `sphereCenter` uniform to the hit position.

Alternative: cast ray and use inverseTrilinear (already in code) to find the cell under the mouse, then set sphereCenter to the cell center.

### 3.3 Mode 0 Button → New Renderer

The existing `uMode == 0` block currently returns early with placeholder red. We replace it with the new ClearView 3-pass pipeline. Modes 1, 2, and the toggleable LineSegments wireframe are preserved.

### 3.4 Fragment Buffer Sizing

For SPE-9 at 1280×800 ≈ 1M pixels. Worst-case depth complexity ≈ 50 (full volume crossings). So 1M × 50 = 50M fragments. At 16 bytes/fragment (RGBA32UI) = 800 MB. Too much.

Practical: 64×64×128 fragment buffer = 524288 entries = 8 MB. If a pixel exceeds this, the `if (insertIndex < linkedListSize)` guard silently drops the fragment. For SPE-9 scale, this should be enough.

Actually, 1280×800 viewport / 64×64 fragments = 32000 × 128 = 4M pixels? No. Let me reconsider.

**Resolution for fragment buffer**:
- Width: viewport width × 1 (one fragment per pixel per insertion) 
- Height: max fragments per pixel (e.g., 128)

If viewport is 1280×800 and we allow 128 fragments per pixel:
- Total fragment buffer = 1280 × 128 = 163840 entries (× 16B = 2.5 MB)

Actually, the simpler design: fragment buffer is a separate texture of size `MAX_FRAGS × 1` (e.g., 1M × 1). Each pixel = one fragment. But then startOffset mapping is (x,y) → first frag index in fragment buffer.

If we keep startOffset at viewport resolution (W×H) and fragment buffer at (MAX_FRAGS, 1):
- Per-pixel: walk linked list of fragments
- Total possible fragments: MAX_FRAGS

For SPE-9 at 1280×800 × depth 50 ≈ 50M worst case. Let's allocate MAX_FRAGS = 2^21 = 2M fragments. That's 32 MB of RGBA32UI. Manageable.

Wait, the existing app draws at devicePixelRatio (capped at 2). So effective canvas size = 2560×1600 at HiDPI. Hmm. For SPE-9 we'd need more.

Let me go with: fragment buffer at 1024 × 1024 = 1M fragments (16 MB). For 1280×800 viewport at depth 50, we'd be over-budget. To handle this, I can:
- Render at lower resolution (downscaled viewport for the gather pass)
- Cap MAX_FRAGS higher (2M = 32MB)

Actually, let me just use a wide format: fragmentBuffer = (4096, 256) = 1M fragments. startOffset = (1280, 800). Each pixel walks its linked list; if more than MAX_NUM_FRAGS in resolve, we just don't sort them all (insertion-sort cutoff).

For SPE-9 specifically, depth complexity is probably ~30-60 in worst case (from the geresim renderer that uses 600 steps). Let me budget MAX_FRAGS = 2M = 32 MB. That covers 1280×800×~2 depth which is probably too low. Hmm.

Let me actually budget 4M = 64 MB. At 2048×1536 viewport × depth 2 = ok. For depth 30 we'd need 60M. 

Better approach: render at half resolution (640×400) for the gather pass, then upscale. Or: just accept some fragment drops at high depth complexity (the resolve pass will still produce visually correct results for visible cells).

I'll go with: fragmentBuffer = 2^22 = 4M entries (64MB), MAX_NUM_FRAGS = 64 in resolve (so each pixel walks up to 64 fragments). For SPE-9 at 1280×800 this gives 4M / 1M ≈ 4 fragments per pixel average — possibly low. Let me increase to 2^23 = 8M = 128MB. That's a lot but should be ok on modern GPUs.

Actually let me check: existing geresim renderer (mode 2) runs at ~30fps on SPE-9. The PPLL gather passes need to handle all face fragments. With 54000 faces × 2 triangles × ~100 visible pixels each = 10M fragments. So we need at least 16M fragment slots to be safe.

Let me budget 16M fragments = 256 MB. That's a lot. Let me use 2M = 32 MB and cap MAX_NUM_FRAGS to 32 in resolve. That gives ~2 frags/pixel average, which might be too low for some scenes.

Alternative: lower the gather viewport resolution. If we gather at 640×400, that's 256K pixels. 2M / 256K = ~8 frags/pixel — reasonable.

Actually, I'm overthinking this. Let me just implement it with reasonable defaults and tune later. Default to:
- fragmentBuffer: 2048 × 1024 = 2M entries (32 MB)
- startOffset: viewport W × H
- MAX_NUM_FRAGS (resolve): 32

For SPE-9 at default canvas size (1280×800), this should work for typical views. Worst-case scenes with high depth will drop fragments but still produce a view.

Actually wait — the canvas's actual drawing buffer size is `renderer.setSize(innerWidth, innerHeight) * pixelRatio`. With `pixelRatio = min(devicePixelRatio, 2)`, on a 1x display it's innerWidth × innerHeight; on 2x display it's 2x. For SPE-9 at 1280×800 (1x), we have ~1M pixels.

Let me allocate fragment buffer = 4M = 64 MB. Each pixel gets ~4 frags on average, but some pixels (looking through the volume) may need more. The `insertIndex < linkedListSize` guard drops the rest silently.

For MAX_NUM_FRAGS in resolve, let's use 16. That keeps the per-pixel cost low.

### 3.5 Buffer Resolution Summary

| Buffer | Format | Size | Bytes |
|---|---|---|---|
| Face (8 uints/face) | RG32UI | 1024 × 256 | 1 MB |
| Vertex (vec3 + float) | RGBA32F | 128 × 256 | 512 KB |
| Edge (float + float) | RG32F | 256 × 128 | 256 KB |
| Cell scalar (per-face lookup) | R32F | 512 × 128 | 256 KB |
| StartOffset | R32UI (image) | W × H | W*H*4 |
| Fragment (4 uints/frag) | RGBA32UI (image) | 2048 × 2048 = 4M | 64 MB |

### 3.6 Files to Create

```
src/
  buffer-data.js        — CPU-side: build face/vertex/edge arrays from VTK mesh
  textures.js           — Upload to DataTextures + image2D-capable textures
  shader-loader.js      — Inline shader sources (since no bundler)
  clearview.js          — Main renderer class (3 passes + uniforms + interaction)
  shaders/
    clearview-vertex.glsl
    clearview-fragment.glsl
    ppll-clear.glsl
    ppll-gather-include.glsl   (just the LinkedListHeader + Gather logic, included in fragment)
    ppll-resolve.glsl
    antialiasing.glsl
    point-to-line-distance.glsl
    ray-intersection.glsl
    clearview-helpers.glsl
```

### 3.7 Files to Modify

- `index.html` — Replace `uMode == 0` placeholder; add HUD controls for ClearView (sphere radius, line width, mouse to move sphere); wire up the 3-pass renderer.

---

## 4. Risk Inventory

1. **WebGL2 imageAtomicExchange on image2D**: ✅ Supported (per spec, EXT in WebGL 1, core in WebGL 2). Should work.
2. **gl_VertexID in WebGL2**: ✅ Supported natively.
3. **Disabling vertex attributes** (since we use gl_VertexID only): ✅ Three.js handles this — just call `gl.drawArrays(gl.TRIANGLES, 0, faceCount*6)`.
4. **Atomic counter increment race**: ✅ Well-defined in WebGL2.
5. **Fragment drops when buffer full**: graceful, just visual artifact.
6. **Camera near/far interaction with focus sphere**: the focus sphere uses world-space distance, so it's independent of camera setup. ✓
7. **Mouse picking**: cast ray, intersect with mesh AABB or find cell. Use existing inverseTrilinear.

---

## 5. ST Plan Recap (per `PLAN.md`)

| ST | Status | Notes |
|---|---|---|
| ST-0 Recon | ✅ this doc | — |
| ST-1 Buffer construction | next | `src/buffer-data.js` + `src/textures.js` |
| ST-2 Vertex shader | | `src/shaders/clearview-vertex.glsl` |
| ST-3 Fragment distance-to-edges | | `src/shaders/point-to-line-distance.glsl` |
| ST-4 Edge coverage + LOD | | integrate into fragment |
| ST-5 Focus sphere | | `clearview-helpers.glsl` + ray-intersection |
| ST-6 PPLL clear | | `ppll-clear.glsl` + `clearview.js#clear()` |
| ST-7 PPLL gather | | include gather logic in fragment |
| ST-8 PPLL resolve | | `ppll-resolve.glsl` + `clearview.js#resolve()` |
| ST-9 Three.js integration | | wire up in `index.html` |
| ST-10 Verification | | (separate subagent task per PLAN) |