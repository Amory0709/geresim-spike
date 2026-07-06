// ST-7: PPLL (per-pixel linked list) header for WebGL2.
//
// Reference: /tmp/HexVolumeRenderer/Data/Shaders/LinkedList/LinkedListHeader.glsl
// The reference uses SSBOs and an atomic_uint counter. WebGL2 supports both
// natively, so the same pattern works — we just declare image2D textures
// instead of SSBOs for the per-pixel head pointer and fragment storage.
//
// A fragment node stores:
//   .color: uvec4 = packed color (rgb in 30 bits) + alpha in 1 channel
//   .depth: float = distance from camera to fragment
//   .next:  uint  = index of next node in fragmentBuffer (0xFFFFFFFF = end)
//
// We pack as RGBA32UI:
//   .r = color (rgb10 + alpha10 packed)
//   .g = depth (32-bit float reinterpreted as uint)
//   .b = next
//   .a = unused

// Per-pixel head pointer (one uint per pixel).
// NOTE: WebGL2 GLSL ES 3.00 does NOT support `binding = N` on images.
// Image binding is done via gl.bindImageTexture(unit, tex, ...) where
// unit is an image unit index (0..MAX_IMAGE_UNITS-1).
layout(r32ui) uniform highp uimage2D uStartOffsetTex;

// Fragment node storage (one node per texel).
layout(rgba32ui) uniform highp uimage2D uFragmentBufferTex;

// Global atomic counter — shared by all fragments.
// Atomic counters DO support layout(binding=N, offset=0) in WebGL2.
layout(binding = 0, offset = 0) uniform atomic_uint uFragCounter;

uniform int uViewportW;
uniform int uViewportH;
uniform uint uLinkedListSize;   // max fragments we can store (size of fragmentBuffer)

uint addrGen(ivec2 addr2D) {
    return uint(addr2D.x) + uint(uViewportW) * uint(addr2D.y);
}

// Pack a vec4 color (rgb in [0,1], alpha in [0,1]) into a single uint using
// 10 bits per channel. Reference: ColorPack.glsl packColor30bit + FloatPack.
// We only pack RGB (30 bits total); alpha is unused in this packing because
// we use a separate channel for depth (next) and the original alpha can be
// reconstructed from RGB if needed. For simplicity we drop HDR and clamp to
// [0,1] — SPE-9 scalar range is well within this.
uint packColor(vec4 c) {
    uint r = uint(clamp(c.r, 0.0, 1.0) * 1023.0 + 0.5) & 0x3FFu;
    uint g = uint(clamp(c.g, 0.0, 1.0) * 1023.0 + 0.5) & 0x3FFu;
    uint b = uint(clamp(c.b, 0.0, 1.0) * 1023.0 + 0.5) & 0x3FFu;
    uint a = uint(clamp(c.a, 0.0, 1.0) * 1023.0 + 0.5) & 0x3FFu;
    return r | (g << 10) | (b << 20) | (a << 30);
}

vec4 unpackColor(uint packed) {
    vec4 c;
    c.r = float(packed & 0x3FFu) / 1023.0;
    c.g = float((packed >> 10) & 0x3FFu) / 1023.0;
    c.b = float((packed >> 20) & 0x3FFu) / 1023.0;
    c.a = float((packed >> 30) & 0x3FFu) / 1023.0;
    return c;
}

// Reinterpret a float as uint (for depth storage).
uint floatBitsToUint_(float f) {
    return floatBitsToUint(f);
}

float uintBitsToFloat_(uint u) {
    return uintBitsToFloat(u);
}