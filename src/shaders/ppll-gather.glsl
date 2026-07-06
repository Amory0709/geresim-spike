// ST-7: PPLL gather functions (fragment insertion).
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/LinkedList/LinkedListGather.glsl
// Adapted for WebGL2 image2D textures.

#include "ppll-header.glsl"

// Fragment buffer is RGBA32UI at FRAG_BUFFER_W × FRAG_BUFFER_H (see clearview.js).
// Matches createFragmentBufferImage(gl, FRAG_BUFFER_W, FRAG_BUFFER_H).
#define FRAG_BUFFER_W 2048

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

    uint insertIndex = atomicCounterIncrement(uFragCounter);

    if (insertIndex >= uLinkedListSize) {
        // Buffer full — silently drop this fragment.
        return;
    }

    // Atomically swap the head pointer for this pixel, capturing the previous
    // head as our `next` pointer in one atomic step. This avoids the race where
    // two concurrent inserts would both read the same old head, then both
    // overwrite it — orphaning the first fragment.
    uint oldHead = imageAtomicExchange(uStartOffsetTex, ivec2(x, y), insertIndex);

    // Build the new fragment node.
    uvec4 frag;
    frag.r = packColor(color);                              // packed color (rgba 10/10/10/10)
    frag.g = floatBitsToUint(depth);                        // depth as uint bits
    frag.b = oldHead;                                       // next pointer (atomic, race-free)
    frag.a = 0u;                                            // unused

    // Write the fragment node into the 2D fragment buffer. Linear insertIndex
    // is unfolded to (insertIndex % W, insertIndex / W) so writes never go OOB.
    ivec2 fragAddr = ivec2(int(insertIndex) % FRAG_BUFFER_W,
                           int(insertIndex) / FRAG_BUFFER_W);
    imageStore(uFragmentBufferTex, fragAddr, frag);
}