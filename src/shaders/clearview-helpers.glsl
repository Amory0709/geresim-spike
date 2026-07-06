// ST-5: ClearView focus-sphere opacity helpers.
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/ClearView/ClearView.glsl
//
// We declare aliases for the WebGL2-style u-prefixed uniforms so this file
// can use the same identifiers as the reference (cameraPosition, etc.).
// The caller must declare: uCameraPosition (vec3), uLookingDirection (vec3),
// uSphereCenter (vec3), uSphereRadius (float).

#include "ray-intersection.glsl"

#define cameraPosition uCameraPosition
#define lookingDirection uLookingDirection
#define sphereCenter uSphereCenter
#define sphereRadius uSphereRadius

/**
 * Returns opacity factor for the context region: 1.0 for fragments behind
 * the focus sphere, pow(d, 4) for fragments in front of / inside the sphere.
 * The 4th-power falloff gives a smooth, lens-like transition.
 */
float getClearViewContextFragmentOpacityFactor(vec3 fragmentPositionWorld) {
    vec3 rayOrigin = uCameraPosition;
    vec3 rayDirection = normalize(fragmentPositionWorld - uCameraPosition);
    float fragmentDepth = length(fragmentPositionWorld - uCameraPosition);

    float t0, t1;
    vec3 intersectionPosition;
    bool intersectsSphere = raySphereIntersection(
            rayOrigin, rayDirection, uSphereCenter, uSphereRadius, t0, t1, intersectionPosition);
    bool fragmentInSphere = CLEARVIEW_SQR(fragmentPositionWorld.x - uSphereCenter.x)
            + CLEARVIEW_SQR(fragmentPositionWorld.y - uSphereCenter.y)
            + CLEARVIEW_SQR(fragmentPositionWorld.z - uSphereCenter.z)
            <= CLEARVIEW_SQR(uSphereRadius);

    float opacityFactor = 1.0;
    if (intersectsSphere && (fragmentInSphere || fragmentDepth < t1)) {
        vec3 negativeLookingDirection = -uLookingDirection;
        vec3 projectedPoint;
        rayPlaneIntersection(rayOrigin, rayDirection, uSphereCenter,
                             negativeLookingDirection, projectedPoint);
        float sphereDistance = length(projectedPoint - uSphereCenter) / uSphereRadius;
        opacityFactor = pow(sphereDistance, 4.0);
    }

    return opacityFactor;
}