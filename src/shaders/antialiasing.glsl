// ST-4: Anti-aliasing factor for ClearView line coverage.
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/Utils/Antialiasing.glsl

uniform float uFovY;
uniform vec2  uViewportSize;  // pixels (width, height)

float getAntialiasingFactor(float distance) {
    // Pixel-size relative to distance. Smaller pixel-projected distance → smaller AA.
    return distance / uViewportSize.y * uFovY;
}