// ST-7: PPLL gather functions (fragment insertion).
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/LinkedList/LinkedListGather.glsl
// Adapted for WebGL2 image2D textures.

#include "ppll-header.glsl"

/**
 * Insert a fragment into the per-pixel linked list.
 * The fragment carries its own custom depth (typically length(fragPos - camPos)).
 *
 * IMPORTANT: Must be called exactly once per output fragment (no early-out).
 * GATHER_NO_DISCARD is not relevant here because we have a single fragment
 * shader pass that runs once per rasterized fragment — no separate depth pass.
 */
void gatherFragmentCustomDepth(vec4 color, float depth) {
    if (color.a < 1e-4) {
        return;
    }

    int x = int(gl_FragCoord.x);
    int y = int(gl_FragCoord.y);
    uint pixelIndex = addrGen(ivec2(x, y));

    uint insertIndex = atomicCounterIncrement(uFragCounter);

    if (insertIndex >= uLinkedListSize) {
        // Buffer full — silently drop this fragment.
        return;
    }

    // Read current head of the linked list for this pixel.
    uint oldHead = imageLoad(uStartOffsetTex, ivec2(x, y)).r;

    // Build the new fragment node.
    uvec4 frag;
    frag.r = packColor(color);                              // packed color (rgba 10/10/10/10)
    frag.g = floatBitsToUint(depth);                        // depth as uint bits
    frag.b = oldHead;                                       // next pointer
    frag.a = 0u;                                            // unused

    // Atomically swap the head pointer to point to our new node.
    imageAtomicExchange(uStartOffsetTex, ivec2(x, y), insertIndex);

    // Write the fragment node to the fragment buffer.
    // Fragment buffer index is linear: insertIndex → (insertIndex % W, insertIndex / W)
    ivec2 fragCoord = ivec2(int(insertIndex) % int(uLinkedListSize),
                            int(insertIndex) / int(uLinkedListSize));
    // The above is a simplification; actual fragment buffer dimensions are
    // separate from linked list size. For now, assume fragment buffer is
    // (uLinkedListSize, 1).
    imageStore(uFragmentBufferTex, ivec2(int(insertIndex), 0), frag);
}