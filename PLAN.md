# PLAN — ClearView (Unified) Replication for SPE-9 Reservoir Viewer

**Owner:** code agent · **Target:** `~/code-workspace/sandbox/amory-site/geresim-spike/`
**Reference:** `/tmp/HexVolumeRenderer/` (cloned from chrismile/HexVolumeRenderer, BSD-2-Clause)
**Paper:** Neuhauser, Wang, Westermann. *Interactive Focus+Context Rendering for Hexahedral Mesh Inspection.* TVCG 2021.

---

## Goals
1. Faithfully reproduce the ClearView (Unified) rendering technique.
2. Replace wire mode 0 in `index.html` with the new focus+context renderer.
3. Run at interactive frame rates (≥30 fps) on 9000-cell SPE-9 dataset.

## Hard constraints
- Stack: Three.js + WebGL2 + GLSL3 ES. No new dependencies.
- Dataset: SPE-9 GRDECL → VTK → already loaded by existing pipeline.
- Vertex order: VTK_TO_STD = [0,1,3,2,4,5,7,6].
- **No push to `Amory0709/geresim-spike` without explicit user approval.**
- Commit per ST, conventional commits.

## Out of scope (this round)
- Volumetric ray-march renderer (`ClearViewRenderer_Volume2`).
- LOD-based mesh simplification (`LOD Lines` mode).
- Singular edge color lookup texture (use scalar color instead).
- Tube wireframe alternative.
- Performance beyond 30 fps on 9000 cells.

---

## Subtasks

### ST-0 · Project Recon · ~1–2 h
- Read `index.html` end-to-end; identify current data flow, attribute layouts, uniforms.
- Read `convert_spe9.mjs`; confirm output schema (points, cells, scalars).
- Read `diagnose.mjs`; understand headless verification harness.
- Read `package.json`; confirm Three.js version + any pre-installed dev deps.
- **Output:** `docs/project-recon.md` with data flow diagram, vertex attribute layout, current shader uniforms.

### ST-1 · Face / Vertex / Edge Buffer Construction · ~2–3 h
- Compute face buffer: 6 faces × 9000 cells = 54000 faces.
  - Each face = 4 vertex indices + 4 edge indices (uvec4 + uvec4).
- Compute vertex buffer: 8 unique vertices per cell = 72000 slots (vec3 position + float attribute).
- Compute edge buffer: 12 edges per cell = 108000 slots (float attr + float LOD + uint singularity packed).
- Edge LOD: derived from cell scalar (high scalar = fine LOD, use `1 - normalizedScalar` as LOD proxy).
- Singularity: u32 packed = (valence - 1)<<2 | isBoundary<<1 | isSingular.
- Upload as Data Texture (3× R32UI or RG32UI) since WebGL2 SSBO support is inconsistent.
- **Output:** `src/buffer-data.js` (compute) + `src/textures.js` (upload).

### ST-2 · Per-Face Vertex Shader · ~2–3 h
- Use `gl_VertexID`: `faceId = id / 4`, `cornerId = id % 4`.
- Read 4 vertex positions from face buffer → emit as `flat out vec3 vertexPositions[4]`.
- Read 4 edge attributes + 4 LOD values → emit as `flat out float`.
- For the current corner: pass world position normally.
- Include TransformFeedback setup if needed for PPLL fragment counters.
- **Output:** `src/shaders/vertex.glsl`.

### ST-3 · Fragment Shader — Distance to Edges · ~2 h
- Copy `getDistanceToLineSegment()` from reference `PointToLineDistance.glsl`.
- For each fragment: loop 4 face edges, compute distance to line segment.
- Track `minDistance` + `minDistanceIndex`.
- Track `minDistanceAll` (any edge, no LOD filter) for falloff.
- **Output:** integrate into `src/shaders/fragment.glsl`.

### ST-4 · Fragment Shader — Edge Coverage + LOD · ~2 h
- `lineRadius = lineWidth * (-focusDist * 0.3 + 1.0) / 2.0`.
- `lineCoordinates = minDistance / lineRadius`.
- LOD filter: skip edge if `edgeLod > threshold`.
- `EPSILON = clamp(getAntialiasingFactor(fragmentDistance/lineRadius), 0, 0.49)`.
- `coverage = 1 - smoothstep(1 - 2*EPSILON, 1, lineCoordinates)`.
- Blend line color over volume color using coverage as alpha.
- **Output:** integrate into `src/shaders/fragment.glsl`.

### ST-5 · Fragment Shader — ClearView Focus Sphere · ~2–3 h
- Copy `raySphereIntersection()` from reference `RayIntersection.glsl`.
- Implement `getClearViewContextFragmentOpacityFactor()`:
  - If fragment behind sphere: opacity = 1.
  - If fragment in front of or inside sphere: `opacity = pow(sphereDist, 4)`.
- Implement `focusFactor`:
  - 1.0 inside focus region (smoothstep edge).
- LOD threshold interpolation: `mix(contextLod, focusLod, focusFactor)`.
- Volume color: `volumeColor.a *= pow(distanceToFocus, 4)` for context.
- **Output:** integrate into `src/shaders/fragment.glsl`.

### ST-6 · PPLL Clear Pass · ~1 h
- Render fullscreen quad to RG32UI texture (startOffset).
- Initialize all entries to `0xFFFFFFFF` (no fragment).
- Reset atomic counter to 0.
- **Output:** `src/shaders/ppll-clear.glsl` + `src/pass-clear.js`.

### ST-7 · PPLL Gather Pass · ~3–4 h
- Same vertex+fragment shaders as the main renderer (ST-2 to ST-5).
- Fragment output: `gatherFragmentCustomDepth(blendedColor, fragmentDistance)`.
- Atomic insertion into linked list:
  - `insertIndex = atomicCounterIncrement(fragCounter)`
  - `frag.next = atomicExchange(startOffset[pixelIndex], insertIndex)`
  - `fragmentBuffer[insertIndex] = frag`
- Pack color (RGB 30-bit) + depth (22-bit float) + alpha (10-bit) into uvec2.
- **Output:** `src/shaders/ppll-gather.glsl` + `src/pass-gather.js`.

### ST-8 · PPLL Resolve Pass · ~3–4 h
- Render fullscreen quad.
- For each pixel: traverse linked list, collect up to `MAX_NUM_FRAGS` (e.g., 32).
- Insertion sort by depth (sufficient for SPE-9 scale).
- Back-to-front alpha blending:
  - `result.rgb = src.rgb * src.a + dst.rgb * (1 - src.a)`
  - `result.a = src.a + dst.a * (1 - src.a)`
- Write to default framebuffer.
- **Output:** `src/shaders/ppll-resolve.glsl` + `src/pass-resolve.js`.

### ST-9 · Three.js Integration · ~3–4 h
- New mode 0 = ClearView renderer.
- Pipeline: clear → gather → resolve (3 RenderTargets with ping-pong).
- Mouse picking: cast ray, intersect with hex mesh, set `sphereCenter` uniform.
- Sphere radius uniform: default 200 (scene units), slider in HUD.
- Other uniforms: `cameraPosition`, `lookingDirection`, `lineWidth`, `maxLodValue`, `selectedLodValueFocus/Context`.
- Keep modes 1 (solid) and 2 (geresim) untouched.
- **Output:** modified `index.html` + new files in `src/`.

### ST-10 · Verification (by subagent B)
- Compare each shader file against reference in `/tmp/HexVolumeRenderer/Data/Shaders/ClearView/` and `/LinkedList/`.
- Run `diagnose.mjs`; compare screenshot against reference (open their paper Figure 4-6).
- Produce verification report:
  ```
  Component                      | Reference                    | Impl             | Status
  ------------------------------|------------------------------|------------------|--------
  getDistanceToLineSegment       | PointToLineDistance.glsl     | src/shaders/...  | ✅/❌/⚠️
  raySphereIntersection          | RayIntersection.glsl         | ...              | ✅
  getClearViewContextOpacity     | ClearView.glsl               | ...              | ✅
  ... (9 rows total)
  ```

---

## Reference files (paths)
- `HexMeshUnified.glsl` — main vertex + fragment shader (ClearView mode)
- `ClearView.glsl` — focus sphere helpers
- `PointToLineDistance.glsl` — line distance functions
- `RayIntersection.glsl` — ray-sphere intersection
- `LinkedListGather.glsl` — PPLL insertion
- `LinkedListHeader.glsl` — PPLL data structures
- `LinkedListResolve.glsl` — PPLL traversal + sort
- `LinkedListClear.glsl` — PPLL head pointer init
- `LinkedListSort.glsl` / `LinkedListQuicksort.glsl` — sort algorithms
- `FloatPack.glsl` + `ColorPack.glsl` — bit packing
- `DepthHelper.glsl` — depth utilities

## Acceptance criteria
- [ ] Mode 0 renders SPE-9 with focus sphere visible and movable by mouse.
- [ ] Focus region: edges drawn on cell faces (full LOD), interior transparent.
- [ ] Context region: cells opaque with scalar color, coarse LOD edges (or no edges).
- [ ] Mouse drag: sphere center moves smoothly, ≥30 fps.
- [ ] No z-fighting, no alpha artifacts (back-to-front correct).
- [ ] Modes 1 and 2 still work (no regression).
- [ ] Verifier report: 9/9 components ✅ or ⚠️ with explanation.

## Risks
- **WebGL2 SSBO limitations**: atomic counters work; large SSBOs may not. Use Data Textures as fallback.
- **PPLL memory**: need to allocate large fragment buffer (e.g., 16M slots = 128MB at 8 bytes/slot). Use buffer array trick if needed.
- **gl_VertexID in WebGL2**: requires `OES_draw_buffers_indexed`? No, just standard WebGL2.

## Commit cadence
- ST-0..ST-5: separate commits (one per ST).
- ST-6..ST-8: separate commits.
- ST-9: one commit per logical chunk (pipeline wiring, picking, UI).