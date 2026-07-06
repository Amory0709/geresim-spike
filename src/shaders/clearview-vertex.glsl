#version 300 es
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
// Face buffer is RG32UI, width=uTexWidth, height=ceil(faceCount*2/uTexWidth).
// Two texels per face, packed linearly:
//   linear idx 2*faceId+0 = vertex indices, +1 = edge indices.
//
// Vertex buffer is RGBA32F, width=uTexWidth, height=ceil(vertexCount/uTexWidth).
// Edge buffer is RG32F, similar.

precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;

// face count = 54000 for SPE-9
uniform int uFaceCount;
uniform int uTexWidth;       // texture row width for face/vertex/edge buffers

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

ivec2 linearToTexel(int linearIdx) {
    return ivec2(linearIdx % uTexWidth, linearIdx / uTexWidth);
}

void main() {
    int vertexId = gl_VertexID % 6;  // 0..5 = 6 vertices per face (2 triangles)
    // 2 triangles per face: (v0, v3, v1) and (v2, v1, v3)
    int cornerId;
    if (vertexId == 0) cornerId = 0;
    else if (vertexId == 1) cornerId = 3;
    else if (vertexId == 2) cornerId = 1;
    else if (vertexId == 3) cornerId = 2;
    else if (vertexId == 4) cornerId = 1;
    else /* vertexId == 5 */ cornerId = 3;

    int faceId = gl_VertexID / 6;

    // Fetch face data (2 texels per face).
    uvec4 faceVertices = texelFetch(uFaceTex, linearToTexel(faceId * 2 + 0), 0);
    uvec4 faceEdges    = texelFetch(uFaceTex, linearToTexel(faceId * 2 + 1), 0);

    uint vIdx[4];
    vIdx[0] = faceVertices.r;
    vIdx[1] = faceVertices.g;
    vIdx[2] = faceVertices.b;
    vIdx[3] = faceVertices.a;

    uint eIdx[4];
    eIdx[0] = faceEdges.r;
    eIdx[1] = faceEdges.g;
    eIdx[2] = faceEdges.b;
    eIdx[3] = faceEdges.a;

    for (int i = 0; i < 4; i++) {
        vec4 vData = texelFetch(uVertexTex, linearToTexel(int(vIdx[i])), 0);
        vVertexPositions[i] = vData.xyz;
        vVertexAttributes[i] = vData.a;

        vec2 eData = texelFetch(uEdgeTex, linearToTexel(int(eIdx[i])), 0).rg;
        vLineAttributes[i] = eData.r;
        vEdgeLodValues[i]  = eData.g;
    }

    vec4 thisVertexData = texelFetch(uVertexTex, linearToTexel(int(vIdx[cornerId])), 0);
    vec4 worldPos = uModelMatrix * vec4(thisVertexData.xyz, 1.0);
    vFragmentPositionWorld = worldPos.xyz;

    gl_Position = uModelViewProjection * vec4(thisVertexData.xyz, 1.0);
}