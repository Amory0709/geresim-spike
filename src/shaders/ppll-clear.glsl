// ST-6: PPLL clear pass.
//
// Renders a fullscreen quad. For each pixel, writes 0xFFFFFFFF (= -1u,
// the "end of list" sentinel) to the startOffset texture. Also resets the
// atomic counter via gl.clearBufferfv (handled in JS, not in shader).
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/LinkedList/LinkedListClear.glsl

#version 300 es
precision highp float;

#include "ppll-header.glsl"

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);
    if (x >= uViewportW || y >= uViewportH) return;
    imageStore(uStartOffsetTex, ivec2(x, y), uvec4(0xFFFFFFFFu, 0u, 0u, 0u));
}