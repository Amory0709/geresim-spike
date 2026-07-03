# Geresim-Spike

WebGL fragment-shader volume rendering of an unstructured hexahedral mesh,
using the technique described by Miranda and Celes (Tecgraf/PUC-Rio +
Petrobras, SIBGRAPI 2011 / TVC 2012).

## Try it

Open https://amory0709.github.io/geresim-spike/

(or `index.html` locally — needs a static server because of `fetch()`)

## Files

| File | Purpose |
|---|---|
| `index.html` | The full spike (HTML + GLSL fragment shader). Three render modes: wire / solid / geresim (toggle in the HUD). |
| `candidates/hexa.vtk` | Test data: 10,648-cell pure-hex unstructured VTK mesh (BSD/MIT, from pyvista/vtk-data). |
| `smoke_test.mjs` | Node validation of the JS precompute (no browser required). Run with `node smoke_test.mjs`. |

## Technique (TL;DR)

- **CPU precompute**: 8³ coarse grid maps tiles to cell AABBs. For each 32³ voxel, linear inverse-trilinear at the cell center finds (u,v,w). Result is a `R32UI` 3D texture of cell indices.
- **GPU fragment shader**: ray-march through the 3D texture, sample per-cell 8-corner data from a 2D `RGBA32F` texture, compute trilinear scalar + analytic gradient (used as pseudo-normal for Blinn-Phong), composite front-to-back.
- **Cell-by-cell look** comes from the trilinear gradient being constant within a cell but discontinuous at cell faces (see #364 in the originating conversation).

## Status

Spike validation — cell index precompute yields ~35% voxel coverage (rest
are micro-cells too small to hit a 32³ grid, or fall on cell boundaries the
linear approximation fudges). Visual confirmation pending.
