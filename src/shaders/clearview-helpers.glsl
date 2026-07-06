// ST-5: ClearView focus-sphere opacity helpers.
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/ClearView/ClearView.glsl
// Adapted: sphereCenter/sphereRadius/cameraPosition/lookingDirection are
// already declared as globals in the fragment shader.

#include "ray-intersection.glsl"

/**
 * Returns opacity factor for the context region: 1.0 for fragments behind
 * the focus sphere, pow(d, 4) for fragments in front of / inside the sphere.
 * The 4th-power falloff gives a smooth, lens-like transition.
 */
float getClearViewContextFragmentOpacityFactor(vec3 fragmentPositionWorld) {
    vec3 rayOrigin = cameraPosition;
    vec3 rayDirection = normalize(fragmentPositionWorld - cameraPosition);
    float fragmentDepth = length(fragmentPositionWorld - cameraPosition);

    float t0, t1;
    vec3 intersectionPosition;
    bool intersectsSphere = raySphereIntersection(
            rayOrigin, rayDirection, sphereCenter, sphereRadius, t0, t1, intersectionPosition);
    bool fragmentInSphere = CLEARVIEW_SQR(fragmentPositionWorld.x - sphereCenter.x)
            + CLEARVIEW_SQR(fragmentPositionWorld.y - sphereCenter.y)
            + CLEARVIEW_SQR(fragmentPositionWorld.z - sphereCenter.z)
            <= CLEARVIEW_SQR(sphereRadius);

    float opacityFactor = 1.0;
    if (intersectsSphere && (fragmentInSphere || fragmentDepth < t1)) {
        vec3 negativeLookingDirection = -lookingDirection;
        vec3 projectedPoint;
        rayPlaneIntersection(rayOrigin, rayDirection, sphereCenter,
                             negativeLookingDirection, projectedPoint);
        float sphereDistance = length(projectedPoint - sphereCenter) / sphereRadius;
        opacityFactor = pow(sphereDistance, 4.0);
    }

    return opacityFactor;
}