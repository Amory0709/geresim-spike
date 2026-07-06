// ST-8: PPLL resolve pass.
//
// Renders a fullscreen quad. For each pixel:
//   1. Walk the linked list from startOffsetTex[pixel]
//   2. Collect up to MAX_NUM_FRAGS entries
//   3. Insertion-sort by depth (ascending)
//   4. Front-to-back alpha blend (smallest depth = closest = drawn first)
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/LinkedList/LinkedListResolve.glsl
//            +LinkedListSort.glsl::blendFTB/insertionSort

#version 300 es
precision highp float;

#include "ppll-header.glsl"

#define MAX_NUM_FRAGS 32

// Per-pixel storage (allocated in fragment shader; 32 entries is 32 × 12 bytes
// = 384 bytes, within typical register-pressure limits).
uint colorList[MAX_NUM_FRAGS];
float depthList[MAX_NUM_FRAGS];

void swapFragments(uint i, uint j) {
    uint cTemp = colorList[i];
    colorList[i] = colorList[j];
    colorList[j] = cTemp;
    float dTemp = depthList[i];
    depthList[i] = depthList[j];
    depthList[j] = dTemp;
}

void main() {
    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);
    if (x >= uViewportW || y >= uViewportH) {
        discard;
    }

    uint fragOffset = imageLoad(uStartOffsetTex, ivec2(x, y)).r;

    int numFrags = 0;
    for (int i = 0; i < MAX_NUM_FRAGS; i++) {
        if (fragOffset == 0xFFFFFFFFu) break;
        uvec4 frag = imageLoad(uFragmentBufferTex, ivec2(int(fragOffset), 0));
        fragOffset = frag.b;

        colorList[i] = frag.r;
        depthList[i] = uintBitsToFloat(frag.g);
        numFrags++;
    }

    if (numFrags == 0) {
        discard;
    }

    // ---- Insertion sort by depth (ascending) ----
    for (uint i = 1u; i < uint(numFrags); ++i) {
        uint fragColor = colorList[i];
        float fragDepth = depthList[i];

        uint j = i;
        while (j >= 1u && depthList[j - 1u] > fragDepth) {
            colorList[j] = colorList[j - 1u];
            depthList[j] = depthList[j - 1u];
            --j;
        }
        colorList[j] = fragColor;
        depthList[j] = fragDepth;
    }

    // ---- Front-to-back alpha blend ----
    vec4 outColor = vec4(0.0);
    for (int i = 0; i < MAX_NUM_FRAGS; i++) {
        if (i >= numFrags) break;
        vec4 src = unpackColor(colorList[i]);
        outColor.rgb = outColor.rgb + (1.0 - outColor.a) * src.a * src.rgb;
        outColor.a   = outColor.a + (1.0 - outColor.a) * src.a;
        // Early-out when fully opaque.
        if (outColor.a > 0.995) break;
    }

    if (outColor.a > 1e-4) {
        outColor.rgb /= outColor.a;
    }

    gl_FragColor = outColor;
}