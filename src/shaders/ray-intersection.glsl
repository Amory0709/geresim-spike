// ST-5: Ray-sphere and ray-plane intersection (used by ClearView fragment).
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/Utils/RayIntersection.glsl
// Identical except #define SQR made into a function-like macro.

#define CLEARVIEW_SQR(x) ((x)*(x))

/**
 * Ray-sphere intersection. Returns true if the ray hits the sphere.
 * Outputs t0, t1 (parametric distances along the ray) and intersectionPosition.
 */
bool raySphereIntersection(
        vec3 rayOrigin, vec3 rayDirection, vec3 sphereCenter, float sphereRadius,
        out float t0, out float t1, out vec3 intersectionPosition)
{
    float A = CLEARVIEW_SQR(rayDirection.x) + CLEARVIEW_SQR(rayDirection.y) + CLEARVIEW_SQR(rayDirection.z);
    float B = 2.0 * (rayDirection.x * (rayOrigin.x - sphereCenter.x)
                  + rayDirection.y * (rayOrigin.y - sphereCenter.y)
                  + rayDirection.z * (rayOrigin.z - sphereCenter.z));
    float C = CLEARVIEW_SQR(rayOrigin.x - sphereCenter.x)
            + CLEARVIEW_SQR(rayOrigin.y - sphereCenter.y)
            + CLEARVIEW_SQR(rayOrigin.z - sphereCenter.z)
            - CLEARVIEW_SQR(sphereRadius);

    float discriminant = CLEARVIEW_SQR(B) - 4.0 * A * C;
    if (discriminant < 0.0) {
        return false;
    }

    float discriminantSqrt = sqrt(discriminant);
    t0 = (-B - discriminantSqrt) / (2.0 * A);
    t1 = (-B + discriminantSqrt) / (2.0 * A);
    intersectionPosition = rayOrigin + t0 * rayDirection;
    return true;
}

bool rayPlaneIntersection(
        vec3 rayOrigin, vec3 rayDirection, vec3 planePoint, vec3 planeNormal,
        out vec3 intersectionPosition)
{
    float ln = dot(planeNormal, rayDirection);
    if (abs(ln) < 1e-4) {
        return false;
    }
    float pos = dot(planeNormal, rayOrigin) - dot(planeNormal, planePoint);
    float t = -pos / ln;
    intersectionPosition = rayOrigin + t * rayDirection;
    return true;
}