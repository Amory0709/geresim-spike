#version 300 es
// ST-3+4+5+7: ClearView (Unified) fragment shader.
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/ClearView/HexMeshUnified.glsl
//   Fragment.ClearView_ObjectSpace section (we use object-space focus like
//   the reference does — the screen-space variant uses viewportSize and
//   projects the sphere center to screen, which requires a separate uniform
//   we don't yet wire up; object-space is simpler and good enough).
//
// Pipeline: compute blended color + depth, then call gatherFragmentCustomDepth.

precision highp float;
precision highp int;

in vec3 vFragmentPositionWorld;
flat in vec3 vVertexPositions[4];
flat in float vLineAttributes[4];
flat in float vEdgeLodValues[4];
flat in float vVertexAttributes[4];

uniform sampler2D uCellScalarTex;  // 1 texel per face
uniform int uFaceCount;

uniform vec3  uCameraPosition;
uniform vec3  uLookingDirection;

uniform vec3  uSphereCenter;
uniform float uSphereRadius;

uniform float uLineWidth;
uniform float uMaxLodValue;
uniform float uSelectedLodValueFocus;
uniform float uSelectedLodValueContext;
uniform float uImportantLineBoostFactor;

uniform vec3  uBackgroundColor;
uniform vec3  uForegroundColor;

uniform vec3  uEdgeColor;
uniform float uScalarMin;
uniform float uScalarMax;

#include "antialiasing.glsl"
#include "point-to-line-distance.glsl"
#include "clearview-helpers.glsl"
#include "ppll-gather.glsl"

// Viridis 5-stop colormap (matches existing renderer).
vec3 colormap(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c0 = vec3(0.267, 0.004, 0.329);
    vec3 c1 = vec3(0.231, 0.322, 0.545);
    vec3 c2 = vec3(0.129, 0.569, 0.549);
    vec3 c3 = vec3(0.369, 0.788, 0.384);
    vec3 c4 = vec3(0.992, 0.906, 0.145);
    if (t < 0.25) return mix(c0, c1, t / 0.25);
    if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
    if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
    return mix(c3, c4, (t - 0.75) / 0.25);
}

void main() {
    // ---- 1. Distance / focus math ----
    float distanceToFocusPointNormalized =
        min(length(vFragmentPositionWorld - uSphereCenter) / uSphereRadius, 1.0);
    float fragmentDistance = length(vFragmentPositionWorld - uCameraPosition);

    // focusFactor: 1 inside focus region, smoothstep blend [0.7, 1.0] on the
    // sphere edge, 0 outside.
    const float LOD_BLEND_FACTOR_BLEND_START = 0.7;
    float focusFactor = 1.0;
    if (distanceToFocusPointNormalized >= 1.0) {
        focusFactor = 0.0;
    } else if (distanceToFocusPointNormalized > LOD_BLEND_FACTOR_BLEND_START) {
        float t = (distanceToFocusPointNormalized - LOD_BLEND_FACTOR_BLEND_START)
                / (1.0 - LOD_BLEND_FACTOR_BLEND_START);
        focusFactor = 1.0 - t * t * (3.0 - 2.0 * t);
    }

    // contextFactor: pow(d, 4) for context region (faint), 1 for far region.
    vec3 rayOrigin = uCameraPosition;
    vec3 rayDirection = normalize(vFragmentPositionWorld - uCameraPosition);
    float contextFactor = 1.0;
    {
        float t0, t1;
        vec3 intersectionPosition;
        bool intersectsSphere = raySphereIntersection(rayOrigin, rayDirection,
                uSphereCenter, uSphereRadius, t0, t1, intersectionPosition);
        bool fragInSphere = CLEARVIEW_SQR(vFragmentPositionWorld.x - uSphereCenter.x)
                + CLEARVIEW_SQR(vFragmentPositionWorld.y - uSphereCenter.y)
                + CLEARVIEW_SQR(vFragmentPositionWorld.z - uSphereCenter.z)
                <= CLEARVIEW_SQR(uSphereRadius);
        if (intersectsSphere && (fragInSphere || fragmentDistance < t1)) {
            vec3 negLook = -uLookingDirection;
            vec3 projPt;
            rayPlaneIntersection(rayOrigin, rayDirection, uSphereCenter, negLook, projPt);
            float sphereDist = length(projPt - uSphereCenter) / uSphereRadius;
            contextFactor = pow(sphereDist, 4.0);
        }
    }

    // ---- 2. Line width scales with focus distance ----
    float lineWidthPrime = uLineWidth * (-distanceToFocusPointNormalized * 0.3 + 1.0);
    float lineRadius = lineWidthPrime / 2.0;

    // ---- 3. Volume color (scalar-based, modulated by context opacity) ----
    // Use average of 4 face corner scalars (sampled from vVertexAttributes)
    // for the cell color, or fetch the per-face scalar directly.
    int faceId = int(gl_FragCoord.x) + int(gl_FragCoord.y) * 1000;  // dummy
    // The face ID is not directly available in fragment; instead use the
    // average of the 4 face-local vertex attributes (which already encode
    // the per-cell average scalar via the per-corner scalar in the vertex
    // buffer). This is a per-face average, not per-cell, but it's close
    // enough for the wireframe overlay.
    float cellScalar = 0.25 * (vVertexAttributes[0] + vVertexAttributes[1]
                             + vVertexAttributes[2] + vVertexAttributes[3]);
    vec3 baseColor = colormap((cellScalar - uScalarMin)
                              / max(uScalarMax - uScalarMin, 1e-6));

    vec4 volumeColor = vec4(baseColor, 1.0);
    volumeColor.a *= contextFactor;

    vec4 blendedColor = volumeColor;

    // ---- 4. Highlight edges ----
    const float LOD_EPSILON = 0.001;
    float discreteSelectedLodValueFocus = max(uSelectedLodValueFocus * uMaxLodValue, LOD_EPSILON);
    float discreteSelectedLodValueContext = max(uSelectedLodValueContext * uMaxLodValue, LOD_EPSILON);

    bool isLineNear = false;
    float minDistance = 1e9;
    int minDistanceIndex = 0;
    float minDistanceAll = 1e9;
    int minDistanceIndexAll = 0;
    float currentDistance;

    for (int i = 0; i < 4; i++) {
        currentDistance = getDistanceToLineSegment(
                vFragmentPositionWorld,
                vVertexPositions[i], vVertexPositions[(i + 1) % 4]);

        float lodLevelFocus = max(
                (vLineAttributes[i] < 1.0 - uImportantLineBoostFactor ? 0.0 : 1.0) * uMaxLodValue,
                discreteSelectedLodValueFocus);

        float lodLineValue = vEdgeLodValues[i];
        float discreteLodValue = lodLineValue * uMaxLodValue;
        float lodLevelOpacityFactor = mix(
                discreteLodValue <= discreteSelectedLodValueContext + LOD_EPSILON ? 1.0 : 0.0,
                discreteLodValue <= discreteSelectedLodValueFocus + LOD_EPSILON ? 1.0 : 0.0,
                focusFactor);
        bool drawLine = lodLevelOpacityFactor > 0.01;

        if (currentDistance < minDistance && drawLine) {
            minDistance = currentDistance;
            minDistanceIndex = i;
            isLineNear = true;
        }
        if (currentDistance < minDistanceAll) {
            minDistanceAll = currentDistance;
            minDistanceIndexAll = i;
        }
    }

    if (isLineNear && minDistance <= lineRadius) {
        float depthCueFactor = min(contextFactor, focusFactor);
        float lodLineValue = vEdgeLodValues[minDistanceIndex];
        float lodLevelOpacityFactor = mix(
                lodLineValue <= uSelectedLodValueContext + LOD_EPSILON ? 1.0 : 0.0,
                lodLineValue <= uSelectedLodValueFocus + LOD_EPSILON ? 1.0 : 0.0,
                focusFactor);

        // Line base color (could be per-edge attribute colored, but we use
        // the user-configurable uEdgeColor as a fixed hue).
        vec3 lineBaseColor = uEdgeColor;

        vec3 lineBaseColorFocus = mix(lineBaseColor, uBackgroundColor, 0.3);
        vec3 lineBaseColorContext = mix(baseColor, uForegroundColor, 0.3);
        lineBaseColor = mix(lineBaseColorContext, lineBaseColorFocus, focusFactor);

        float lineCoordinates = max(minDistance / lineRadius, 0.0);

        float EPSILON = clamp(getAntialiasingFactor(fragmentDistance / lineRadius),
                              0.0, 0.49);
        float coverage = 1.0 - smoothstep(1.0 - 2.0 * EPSILON, 1.0, lineCoordinates);

        vec4 lineColor = vec4(lineBaseColor, coverage * lodLevelOpacityFactor);

        // Back-to-front alpha blend.
        blendedColor.a = lineColor.a + volumeColor.a * (1.0 - lineColor.a);
        blendedColor.rgb = lineColor.rgb * lineColor.a
                         + volumeColor.rgb * volumeColor.a * (1.0 - lineColor.a);
        if (blendedColor.a > 1e-4) {
            blendedColor.rgb /= blendedColor.a;
        }
    }

    // ---- 5. PPLL gather ----
    gatherFragmentCustomDepth(blendedColor, fragmentDistance);
}