// ST-3: Point-to-line distance helpers (used by ClearView fragment shader).
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/Utils/PointToLineDistance.glsl
// Identical to reference except for indentation.

/**
 * Computes the distance of a point to a line.
 */
float getDistanceToLine(vec3 p, vec3 l0, vec3 l1) {
    vec3 v = l1 - l0;
    vec3 w = p - l0;
    float c1 = dot(v, w);
    float c2 = dot(v, v);

    float b = c1 / c2;
    vec3 pb = l0 + b * v;
    return length(p - pb);
}

/**
 * Computes the distance of a point to a line segment.
 */
float getDistanceToLineSegment(vec3 p, vec3 l0, vec3 l1) {
    vec3 v = l1 - l0;
    vec3 w = p - l0;
    float c1 = dot(v, w);
    if (c1 <= 0.0) {
        return length(p - l0);
    }

    float c2 = dot(v, v);
    if (c2 <= c1) {
        return length(p - l1);
    }

    float b = c1 / c2;
    vec3 pb = l0 + b * v;
    return length(p - pb);
}