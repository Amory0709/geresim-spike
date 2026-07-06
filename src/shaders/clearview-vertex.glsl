// ST-2: ClearView (Unified) vertex shader.
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/ClearView/HexMeshUnified.glsl
//   (the "Vertex" section at the top).
//
// We have 54000 per-cell faces. Each face = 4 vertices, 2 triangles = 6 indices.
// gl_VertexID goes 0..54000*6-1.
//
// We use gl_VertexID only (no vertex attribute buffers).
//
// Face buffer is RG32UI, width=2, height=faceCount. Two texels per face:
//   texel (0, faceId): .r/.g/.b/.a = vertexIdx[0..3]
//   texel (1, faceId): .r/.g/.b/.a = edgeIdx[0..3]
//
// Vertex buffer is RGBA32F, 1 texel per vertex slot:
//   texel (vertexIdx, 0): .xyz = position, .a = scalar attribute
//
// Edge buffer is RG32F, 1 texel per edge slot:
//   texel (edgeIdx, 0): .r = edgeAttribute, .g = edgeLodValue

#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;

// face count = 54000 for SPE-9
uniform int uFaceCount;

uniform usampler2D uFaceTex;
uniform sampler2D uVertexTex;
uniform sampler2D uEdgeTex;

uniform mat4 uModelViewProjection;
uniform mat4 uModelMatrix;  // for world-space fragment position

out vec3 vFragmentPositionWorld;
flat out vec3 vVertexPositions[4];
flat out float vLineAttributes[4];
flat out float vEdgeLodValues[4];
flat out float vVertexAttributes[4];

void main() {
    int vertexId = gl_VertexID % 6;  // 0..5 = 6 vertices per face (2 triangles)
    // 2 triangles per face: (v0, v3, v1) and (v2, v1, v3)
    // Map vertexId → face-local corner index:
    //   triangle 1: ids 0,1,2 → corners 0,3,1
    //   triangle 2: ids 3,4,5 → corners 2,1,3
    int cornerId;
    if (vertexId == 0) cornerId = 0;
    else if (vertexId == 1) cornerId = 3;
    else if (vertexId == 2) cornerId = 1;
    else if (vertexId == 3) cornerId = 2;
    else if (vertexId == 4) cornerId = 1;
    else /* vertexId == 5 */ cornerId = 3;

    int faceId = gl_VertexID / 6;

    // Fetch face data.
    uvec4 faceVertices = texelFetch(uFaceTex, ivec2(0, faceId), 0);
    uvec4 faceEdges    = texelFetch(uFaceTex, ivec2(1, faceId), 0);

    // The 4 face-local vertex indices.
    uint vIdx[4];
    vIdx[0] = faceVertices.r;
    vIdx[1] = faceVertices.g;
    vIdx[2] = faceVertices.b;
    vIdx[3] = faceVertices.a;

    // The 4 face-local edge indices.
    uint eIdx[4];
    eIdx[0] = faceEdges.r;
    eIdx[1] = faceEdges.g;
    eIdx[2] = faceEdges.b;
    eIdx[3] = faceEdges.a;

    // Emit all 4 face corner positions + attributes to the fragment shader.
    for (int i = 0; i < 4; i++) {
        vec4 vData = texelFetch(uVertexTex, ivec2(int(vIdx[i]), 0), 0);
        vVertexPositions[i] = vData.xyz;
        vVertexAttributes[i] = vData.a;

        vec2 eData = texelFetch(uEdgeTex, ivec2(int(eIdx[i]), 0), 0).rg;
        vLineAttributes[i] = eData.r;
        vEdgeLodValues[i]  = eData.g;
    }

    // Compute world position for THIS corner.
    vec4 thisVertexData = texelFetch(uVertexTex, ivec2(int(vIdx[cornerId]), 0), 0);
    vec4 worldPos = uModelMatrix * vec4(thisVertexData.xyz, 1.0);
    vFragmentPositionWorld = worldPos.xyz;

    gl_Position = uModelViewProjection * vec4(thisVertexData.xyz, 1.0);
}