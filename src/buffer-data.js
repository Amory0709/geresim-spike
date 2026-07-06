// ST-1: Build ClearView (Unified) buffers from a parsed VTK mesh.
//
// Reference: chrismile/HexVolumeRenderer/src/Mesh/HexMesh/HexMesh.cpp:2774
//   getSurfaceDataWireframeFacesUnified_AttributePerVertex
//
// We use the *per-cell face enumeration* layout described in PLAN.md §ST-1:
//   faces:   6 × nCells  (e.g. 54000 for SPE-9)
//   vertices: 8 × nCells (each cell owns 8 vertex slots; positions and
//             per-vertex scalar attribute stored in std layout)
//   edges:    12 × nCells
//
// WebGL2 has no SSBOs, so we encode these as DataTextures. See
// docs/project-recon.md §2.4 for the SSBO → image2D mapping.

// Texture row width. WebGL2 minimum guaranteed max texture size is 2048;
// SwiftShader and most desktop GPUs support 8192+. We use 4096 to safely fit
// all of SPE-9's data on any driver (face: 54000*2=108000 texels → 27 rows).
const TEX_WIDTH = 4096;

const VTK_TO_STD = [0, 1, 3, 2, 4, 5, 7, 6];

function texDims(linearCount) {
  return {
    width: TEX_WIDTH,
    height: Math.ceil(linearCount / TEX_WIDTH),
  };
}

// STD hex corner indices:
//   0=c000, 1=c100, 2=c010, 3=c110, 4=c001, 5=c101, 6=c011, 7=c111
//
// Per-cell 12 edges (each is a pair of STD corner indices):
const HEX_EDGES = [
  [0, 1], [1, 3], [2, 3], [0, 2],  // bottom (z=0)
  [4, 5], [5, 7], [6, 7], [4, 6],  // top (z=1)
  [0, 4], [1, 5], [3, 7], [2, 6],  // vertical struts
];

// 6 cell faces. Each face lists 4 STD corner indices in face-local CCW order
// (when viewed from outside the cell) and 4 HEX_EDGES indices in face-local
// order (face-local edge k connects corner k and corner (k+1) % 4).
//
// Derivation: each face is enumerated with corners ordered so that the
// cross product (v1-v0) × (v2-v0) points AWAY from the cell center.
const HEX_FACES = [
  { corners: [0, 2, 3, 1], edges: [3, 2, 1, 0] },  // -z (bottom)
  { corners: [4, 5, 7, 6], edges: [4, 5, 6, 7] },  // +z (top)
  { corners: [0, 1, 5, 4], edges: [0, 9, 4, 8] },  // -y
  { corners: [2, 6, 7, 3], edges: [11, 6, 10, 2] }, // +y
  { corners: [0, 4, 6, 2], edges: [8, 7, 11, 3] },  // -x
  { corners: [1, 3, 7, 5], edges: [1, 10, 5, 9] }, // +x
];

/**
 * Build all ClearView (Unified) buffers for the given mesh.
 *
 * @param {{positions:Float32Array,cellConn:Uint32Array,scalars:Float32Array,nPoints:number,nCells:number}} mesh
 * @returns {{
 *   faces: { texels: Uint32Array, width: number, height: number },  // RG32UI, 2 texels/face
 *   vertices: { texels: Float32Array, width: number, height: number },  // RGBA32F, 1 texel/vertex
 *   edges: { texels: Float32Array, width: number, height: number },  // RG32F, 1 texel/edge
 *   cellScalar: { texels: Float32Array, width: number, height: number },  // R32F, 1 texel/face
 *   faceCount: number, vertexCount: number, edgeCount: number,
 * }}
 */
export function buildClearViewBuffers(mesh) {
  const nCells = mesh.nCells;
  const faceCount = 6 * nCells;          // 54000 for SPE-9
  const vertexCount = 8 * nCells;         // 72000 for SPE-9
  const edgeCount = 12 * nCells;          // 108000 for SPE-9

  // ----- 1. Vertex buffer (RGBA32F, 1 texel = 4 floats = (x, y, z, attr)) -----
  // Per-cell slot k (k = cellIdx * 8 + cornerIdxSTD) stores:
  //   pos = mesh.positions[mesh.cellConn[cellIdx*8 + VTK_TO_STD[cornerIdxSTD]] * 3 + xyz]
  //   attr = mesh.scalars[same index]
  // Pad to TEX_WIDTH row stride.
  const vertexDims = texDims(vertexCount);
  const verticesTex = new Float32Array(vertexDims.width * vertexDims.height * 4);
  for (let c = 0; c < nCells; c++) {
    for (let k = 0; k < 8; k++) {
      const stdCorner = k;
      const vtkCorner = VTK_TO_STD[stdCorner];
      const pi = mesh.cellConn[c * 8 + vtkCorner];
      const linear = c * 8 + stdCorner;
      const col = linear % vertexDims.width;
      const row = Math.floor(linear / vertexDims.width);
      const ti = (row * vertexDims.width + col) * 4;
      verticesTex[ti]     = mesh.positions[pi * 3];
      verticesTex[ti + 1] = mesh.positions[pi * 3 + 1];
      verticesTex[ti + 2] = mesh.positions[pi * 3 + 2];
      verticesTex[ti + 3] = mesh.scalars[pi];
    }
  }

  // ----- 2. Edge buffer (RG32F, 1 texel = 2 floats = (attr, lod)) -----
  // Per-cell slot k (k = cellIdx * 12 + edgeIdx) stores:
  //   attr = max(mesh.scalars[cornerA], mesh.scalars[cornerB]) for that edge
  //          (proxy for the edge's importance/scalar)
  //   lod  = 1 - normalizedScalar (PLAN §ST-1: high scalar = fine LOD, so
  //          high scalar → small LOD value = passes threshold easily)
  //
  // First pass: compute per-cell max scalar (used for LOD normalization)
  let sMin = Infinity, sMax = -Infinity;
  for (let i = 0; i < mesh.scalars.length; i++) {
    if (mesh.scalars[i] < sMin) sMin = mesh.scalars[i];
    if (mesh.scalars[i] > sMax) sMax = mesh.scalars[i];
  }
  const sRange = Math.max(sMax - sMin, 1e-9);

  const edgeDims = texDims(edgeCount);
  const edgesTex = new Float32Array(edgeDims.width * edgeDims.height * 2);
  for (let c = 0; c < nCells; c++) {
    // Per-cell average scalar (for edge LOD proxy)
    let cellScalarAvg = 0;
    for (let k = 0; k < 8; k++) {
      const vtkCorner = VTK_TO_STD[k];
      const pi = mesh.cellConn[c * 8 + vtkCorner];
      cellScalarAvg += mesh.scalars[pi];
    }
    cellScalarAvg /= 8;
    const normScalar = (cellScalarAvg - sMin) / sRange;
    // edgeLodValue: low number = high LOD (passes threshold).
    // High scalar → low LOD value → drawn at both focus and context.
    // Low scalar → high LOD value → only drawn at focus.
    const edgeLod = 1 - normScalar;

    for (let e = 0; e < 12; e++) {
      const [a, b] = HEX_EDGES[e];
      const pia = mesh.cellConn[c * 8 + VTK_TO_STD[a]];
      const pib = mesh.cellConn[c * 8 + VTK_TO_STD[b]];
      const edgeAttr = Math.max(mesh.scalars[pia], mesh.scalars[pib]);
      const linear = c * 12 + e;
      const col = linear % edgeDims.width;
      const row = Math.floor(linear / edgeDims.width);
      const ti = (row * edgeDims.width + col) * 2;
      edgesTex[ti]     = edgeAttr;
      edgesTex[ti + 1] = edgeLod;
    }
  }

  // ----- 3. Face buffer (RG32UI, 2 texels per face = 8 uints per face) -----
  // Texel 0: vertexIdx[0..3] packed as RG32UI (2 uints per texel)
  //   .r = vertexIdx[0]
  //   .g = vertexIdx[1]
  //   .b = vertexIdx[2]
  //   .a = vertexIdx[3]
  // Texel 1: edgeIdx[0..3] packed as RG32UI
  //   .r = edgeIdx[0]
  //   .g = edgeIdx[1]
  //   .b = edgeIdx[2]
  //   .a = edgeIdx[3]
  //
  // Texture layout: width = 2, height = faceCount. (Each face = 1 column of 2 texels.)
  // The shader will compute faceId = gl_VertexID / 6, vertexId = gl_VertexID % 4
  // (4 vertices per face, 2 triangles per face = 6 vertices per face).
  // But the face buffer is indexed by faceId only, with vertexId selecting
  // which corner.
  const faceDims = texDims(faceCount * 2);   // 2 texels per face
  const facesTex = new Uint32Array(faceDims.width * faceDims.height * 4);
  const cellScalarDims = texDims(faceCount);
  const cellScalarTex = new Float32Array(cellScalarDims.width * cellScalarDims.height);

  for (let c = 0; c < nCells; c++) {
    // Per-cell average scalar (used for fragment color)
    let cellScalarAvg = 0;
    for (let k = 0; k < 8; k++) {
      const vtkCorner = VTK_TO_STD[k];
      const pi = mesh.cellConn[c * 8 + vtkCorner];
      cellScalarAvg += mesh.scalars[pi];
    }
    cellScalarAvg /= 8;

    for (let f = 0; f < 6; f++) {
      const faceId = c * 6 + f;
      const face = HEX_FACES[f];

      // Texel 0: vertex indices (4 per face)
      const t0linear = faceId * 2 + 0;
      const t0col = t0linear % faceDims.width;
      const t0row = Math.floor(t0linear / faceDims.width);
      const t0i = (t0row * faceDims.width + t0col) * 4;
      facesTex[t0i + 0] = c * 8 + face.corners[0];
      facesTex[t0i + 1] = c * 8 + face.corners[1];
      facesTex[t0i + 2] = c * 8 + face.corners[2];
      facesTex[t0i + 3] = c * 8 + face.corners[3];

      // Texel 1: edge indices (4 per face)
      const t1linear = faceId * 2 + 1;
      const t1col = t1linear % faceDims.width;
      const t1row = Math.floor(t1linear / faceDims.width);
      const t1i = (t1row * faceDims.width + t1col) * 4;
      facesTex[t1i + 0] = c * 12 + face.edges[0];
      facesTex[t1i + 1] = c * 12 + face.edges[1];
      facesTex[t1i + 2] = c * 12 + face.edges[2];
      facesTex[t1i + 3] = c * 12 + face.edges[3];

      // Cell scalar for this face
      const csCol = faceId % cellScalarDims.width;
      const csRow = Math.floor(faceId / cellScalarDims.width);
      cellScalarTex[csRow * cellScalarDims.width + csCol] = cellScalarAvg;
    }
  }

  return {
    faces: {
      texels: facesTex,
      width: faceDims.width,
      height: faceDims.height,
    },
    vertices: {
      texels: verticesTex,
      width: vertexDims.width,
      height: vertexDims.height,
    },
    edges: {
      texels: edgesTex,
      width: edgeDims.width,
      height: edgeDims.height,
    },
    cellScalar: {
      texels: cellScalarTex,
      width: cellScalarDims.width,
      height: cellScalarDims.height,
    },
    faceCount,
    vertexCount,
    edgeCount,
    sMin,
    sMax,
    texWidth: TEX_WIDTH,
  };
}