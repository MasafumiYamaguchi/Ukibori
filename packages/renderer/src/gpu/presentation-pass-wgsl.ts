/**
 * #29 presentation-pass WGSL shader — the thin final GPU stage that presents
 * the exact #28 output directly to a real `GPUCanvasContext` without a
 * GPU-to-CPU readback or CPU bitmap upload.
 *
 * One fullscreen triangle (3 vertices, triangle-list) covers the viewport;
 * the fragment stage derives integer texel coordinates from
 * `@builtin(position)` and indexes the three GPU-resident fields directly:
 *
 * | group 0 binding | type   | meaning                                      |
 * |-----------------|--------|----------------------------------------------|
 * | 0               | uniform| PresentationParams (32 bytes)                 |
 * | 1               | storage| color: array<u32> (#28 packed RGBA8, read)   |
 * | 2               | storage| objectId: array<u32> (#25 u32 ids, read)     |
 * | 3               | storage| visibility: array<f32> (#27 f32, read)       |
 *
 * ## Fixed DOM composition semantics mirrored here (the oracle is
 * `packages/renderer/src/gpu/composite.ts` + `compositeSurfaceImage`)
 *
 * - `objectId != NO_OWNER`: output the packed #28 R,G,B bytes with alpha 1
 *   (opaque surface; alpha 255).
 * - `objectId == NO_OWNER` and `visibility >= 0.5`: transparent black
 *   `(0, 0, 0, 0)` (the page background IS the lit base plane).
 * - `objectId == NO_OWNER` and `visibility < 0.5`: the sanitized shadow
 *   color at the sanitized alpha. The canvas is configured with
 *   `alphaMode: "premultiplied"`, so the translucent output is PREMULTIPLIED:
 *   `(f32(r) * f32(sa) / 255 / 255, ..., sa / 255)` (IEEE f32 arithmetic —
 *   the byte round-trip `round(v * 255)` equals `round(f32(r) * f32(sa) /
 *   255)`, matching the CPU helper).
 * - No vertical flip: framebuffer y grows downward, so `position.y` maps
 *   directly to the row-major height-field texel row.
 * - No second gamma transform: the #28 bytes are already sRGB encoded; their
 *   normalized numeric values are the canvas encoding (the canvas
 *   `colorSpace` is explicitly `"srgb"`).
 *
 * ## PresentationParams — 32 bytes, align 16, little-endian host packing
 *
 * | offset | size | field          | meaning                        |
 * |--------|------|----------------|--------------------------------|
 * | 0      | 4    | width (u32)    | render width (texels)          |
 * | 4      | 4    | height (u32)   | render height (texels)         |
 * | 8      | 4    | shadowR (u32)  | sanitized shadow color byte    |
 * | 12     | 4    | shadowG (u32)  | sanitized shadow color byte    |
 * | 16     | 4    | shadowB (u32)  | sanitized shadow color byte    |
 * | 20     | 4    | shadowAlphaByte (u32) | floor(alpha * 255 + 0.5) |
 * | 24     | 8    | _pad0/_pad1    | 0                              |
 *
 * Offsets are pinned by `presentation-pass.ts` (host) and the Node contract
 * tests. The selected canvas format is `rgba8unorm` or `bgra8unorm`; the
 * shader always returns logical RGBA and WebGPU handles the attachment
 * format swizzle.
 */

/** PresentationParams uniform byte length (32 bytes, 16-byte aligned). */
export const PRESENTATION_PARAMS_BYTE_LENGTH = 32;

export const PRESENTATION_PASS_WGSL = /* wgsl */ `
// #29 presentation pass params (32 bytes, align 16; offsets pinned by
// presentation-pass.ts)
struct PresentationParams {
  width: u32,            //  0 render width (texels)
  height: u32,           //  4 render height (texels)
  shadowR: u32,          //  8 sanitized shadow color byte
  shadowG: u32,          // 12 sanitized shadow color byte
  shadowB: u32,          // 16 sanitized shadow color byte
  shadowAlphaByte: u32,  // 20 floor(alpha * 255 + 0.5)
  _pad0: u32,            // 24
  _pad1: u32,            // 28
}                        // size 32, align 16

const NO_OWNER: u32 = 0xffffffffu;
// The #28 colors are already sRGB encoded: their normalized numeric values
// ARE the sRGB canvas encoding (no second gamma transform, no tone map).
const UNORM_SCALE: f32 = 1.0 / 255.0;

@group(0) @binding(0) var<uniform> params: PresentationParams;
// The exact #28 packed RGBA8 color field (little-endian byte order R, G, B,
// A; alpha 255). Read-only storage, bound DIRECTLY, never copied.
@group(0) @binding(1) var<storage, read> colorField: array<u32>;
// The exact #25 u32 object-id field (NO_OWNER = base plane).
@group(0) @binding(2) var<storage, read> objectId: array<u32>;
// The exact #27 f32 visibility field (1 = lit, 0 = shadowed).
@group(0) @binding(3) var<storage, read> visibilityField: array<f32>;

// One fullscreen triangle; the vertex stage needs no bindings.
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  var pos = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>(3.0, -1.0),
    vec2<f32>(-1.0, 3.0),
  );
  return vec4<f32>(pos[vi], 0.0, 1.0);
}

// #29 fixed composition semantics (the CPU oracle is composite.ts /
// compositeSurfaceImage). Framebuffer y grows downward, so position.y maps
// directly to the row-major texel row (no vertical flip).
@fragment
fn fs_main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let x = u32(pos.x);
  let y = u32(pos.y);
  // Guard the extent before indexing the storage arrays.
  if (x >= params.width || y >= params.height) {
    return vec4<f32>(0.0);
  }
  let index = y * params.width + x;
  let owner = objectId[index];
  if (owner != NO_OWNER) {
    // Opaque surface: the packed #28 R,G,B bytes with alpha 255.
    let packed = colorField[index];
    let r = f32(packed & 0xffu) * UNORM_SCALE;
    let g = f32((packed >> 8u) & 0xffu) * UNORM_SCALE;
    let b = f32((packed >> 16u) & 0xffu) * UNORM_SCALE;
    return vec4<f32>(r, g, b, 1.0);
  }
  // #41: CONTINUOUS visibility — the base-plane tint scales with the
  // occlusion strength. Hard inputs ({0, 1}) reproduce the historical bytes
  // exactly: strength 1 -> the full premultiplied tint, strength 0 ->
  // transparent black.
  let vis = clamp(visibilityField[index], 0.0, 1.0);
  let strength = 1.0 - vis;
  if (strength <= 0.0) {
    // Fully lit base plane: transparent black (the page IS the base plane).
    return vec4<f32>(0.0);
  }
  // Shadowed base plane: the sanitized shadow tint scaled by the strength,
  // PREMULTIPLIED for the alphaMode: "premultiplied" canvas. IEEE f32
  // arithmetic mirrors compositeShadowPremultipliedBytes exactly:
  //   channel value = f32(c) * f32(sa) / 255 / 255  (byte round-trip = c)
  // with both alpha and channels additionally scaled by strength.
  let alpha = f32(params.shadowAlphaByte) * strength * UNORM_SCALE;
  let sr = f32(params.shadowR) * f32(params.shadowAlphaByte) / 255.0 * strength * UNORM_SCALE;
  let sg = f32(params.shadowG) * f32(params.shadowAlphaByte) / 255.0 * strength * UNORM_SCALE;
  let sb = f32(params.shadowB) * f32(params.shadowAlphaByte) / 255.0 * strength * UNORM_SCALE;
  return vec4<f32>(sr, sg, sb, alpha);
}
`;
