/**
 * #26 normal-pass WGSL shader — the GPU-resident normal field stage.
 *
 * This is a SELF-CONTAINED compute module: it consumes the #25 height
 * allocation DIRECTLY (binding 1, `array<f32>` view of the composed f32
 * height field) plus a small uniform, and writes the tightly packed f32 xyz
 * normal triple per render texel (binding 2). The five #24 scene buffers,
 * coverage, objectId and materialId are NOT required for the normal
 * algorithm and are not bound here.
 *
 * ## Pass bindings (group 0, owned by `NormalPass`)
 *
 * | binding | type   | meaning                                     |
 * |---------|--------|---------------------------------------------|
 * | 0       | uniform| NormalPassParams (32 bytes)                 |
 * | 1       | storage| inHeight: array<f32> (#25 height output,    |
 * |         |        | read-only, bound DIRECTLY, never copied)    |
 * | 2       | storage| outNormal: array<f32> (tightly packed xyz,  |
 * |         |        | read_write)                                 |
 *
 * ## NormalPassParams — 32 bytes, little-endian host packing
 *
 * | offset | size | field          | meaning                                      |
 * |--------|------|----------------|----------------------------------------------|
 * | 0      | 4    | scaleX (f32)   | x height-gradient scale (default 0.5)        |
 * | 4      | 4    | scaleY (f32)   | y height-gradient scale (default 0.5)        |
 * | 8      | 4    | normalScale (f32) | z component before normalization (> 0)    |
 * | 12     | 4    | width (u32)    | render width (texels)                        |
 * | 16     | 4    | height (u32)   | render height (texels)                       |
 * | 20     | 4    | workgroupSize (u32) | documented dispatch workgroup size  |
 * | 24     | 4    | yOffset (u32)   | #32 region dispatch texel offset     |
 * |        |      |                 | (0 = full frame; the shader indexes  |
 * |        |      |                 | `g = gid.x + yOffset`)              |
 * | 28     | 4    | regionEnd (u32) | #32 exclusive texel end of the       |
 * |        |      |                 | dispatched region (0 = full-frame    |
 * |        |      |                 | sentinel — a band may legitimately   |
 * |        |      |                 | start at y0 = 0, so the region is    |
 * |        |      |                 | signaled by regionEnd alone; the     |
 * |        |      |                 | shader guards `regionEnd != 0 &&     |
 * |        |      |                 | g >= regionEnd`, so dispatch         |
 * |        |      |                 | padding never writes a retained      |
 * |        |      |                 | texel outside the band)              |
 *
 * `width`/`height` are host-validated (positive integers, u32-bounded texel
 * count, and byte-length-consistent with the bound height field) so the
 * shader's `params.width * params.height` texel count can never overflow u32
 * or sample out of the buffer. All offsets are pinned by
 * `normal-pass.ts` (host) and by the Node contract tests.
 *
 * ## Output layout (documented for later lighting)
 *
 * One tightly packed row-major f32 xyz triple per texel, `12 * width *
 * height` logical bytes — NOT a vec3/16-byte stride. Texel `(tx, ty)`
 * occupies bytes `[(ty * width + tx) * 12, ... + 12)`, i.e. array<f32>
 * indices `[g*3, g*3+1, g*3+2]`. Coordinates: +x right, +y down, +z toward
 * the viewer; a flat field is exactly/approximately `(0, 0, 1)`.
 *
 * ## Derivative semantics (mirrors the CPU oracle `computeNormals`)
 *
 * Symmetric central difference in the interior; at target edges the missing
 * neighbor is replicated/clamped to the edge texel. Lower neighbors use an
 * explicit branch so unsigned subtraction is never evaluated at zero;
 * upper neighbors use `min(tx + 1u, width - 1u)`. No wrap or out-of-buffer
 * smoothing kernel. `dx = H(x1, y) - H(x0, y)`, `dy = H(x, y1) - H(x, y0)`,
 * `N = normalize((-dx * scaleX, -dy * scaleY, normalScale))`: a height that
 * rises toward +x produces a negative normal x component; the same sign
 * rule applies to +y. The normal algorithm never consults coverage/owner,
 * so a background texel adjacent to a height discontinuity may tilt exactly
 * like the CPU oracle (no owner-aware flattening).
 *
 * ## Overflow-safe normalization (f32 exponent alignment)
 *
 * The CPU oracle computes `nx = -dx * scaleX` etc. in f64, where the product
 * of two finite f32 values is always finite. f32 cannot: `dx * scaleX` with
 * both at the largest finite f32 (`3.4e38 * 3.4e38`) overflows to infinity,
 * and a reciprocal of a very large or subnormal maximum may be flushed by a
 * GPU implementation before the multiply. The shader therefore normalizes
 * WITHOUT ever forming an overflowing product or an extreme reciprocal:
 *
 * 1. Each finite f32 factor is decoded from its IEEE-754 bits into a normal-
 *    range mantissa and an integer base-2 exponent. Subnormal inputs are
 *    normalized with integer leading-zero counting, not subnormal arithmetic.
 * 2. The x/y product exponents are added without multiplying the factors.
 *    All three components are then reconstructed relative to their largest
 *    exponent with `ldexp`, so the largest intermediate is in `[1, 4)` and
 *    no derivative-scale product can overflow.
 * 3. Max-component-first normalization now divides only by a normal-range
 *    value in `[1, 4)`. Components too small to survive the shared exponent
 *    alignment are also too small to affect the f32 result at the required
 *    tolerance; at least one component always remains non-zero because the
 *    host guarantees `normalScale > 0`.
 *
 * Every output vector is therefore finite and unit length within f32
 * arithmetic, matching the f64 oracle for every representable input.
 */

/** Dispatch workgroup size for the normal pass (documented, injected into WGSL). */
export const NORMAL_WORKGROUP_SIZE = 64;

/** NormalPassParams uniform byte length (32 bytes). */
export const NORMAL_PARAMS_BYTE_LENGTH = 32;

/** Logical output bytes per render texel: one tightly packed f32 xyz triple. */
export const NORMAL_OUTPUT_BYTES_PER_TEXEL = 12;

export const NORMAL_PASS_WGSL = /* wgsl */ `
// #26 normal pass params (32 bytes, little-endian host packing pinned by
// normal-pass.ts)
struct NormalPassParams {
  scaleX: f32,        //  0 x height-gradient scale (f32, finite, f32-representable)
  scaleY: f32,        //  4 y height-gradient scale (f32, finite, f32-representable)
  normalScale: f32,   //  8 z component before normalization (f32, strictly > 0)
  width: u32,         // 12 render width (texels)
  height: u32,        // 16 render height (texels)
  workgroupSize: u32, // 20 documented dispatch workgroup size
  yOffset: u32,       // 24 #32 region dispatch texel offset (0 = full frame)
  regionEnd: u32,     // 28 #32 exclusive region end (0 = full frame)
}                     // size 32, align 16

const NORMAL_WORKGROUP_SIZE: u32 = ${NORMAL_WORKGROUP_SIZE}u;

@group(0) @binding(0) var<uniform> params: NormalPassParams;
// #25 height output consumed DIRECTLY (read-only storage, never copied).
@group(0) @binding(1) var<storage, read> inHeight: array<f32>;
// Tightly packed row-major f32 xyz triple per texel (12 bytes stride).
@group(0) @binding(2) var<storage, read_write> outNormal: array<f32>;

const ZERO_EXPONENT: i32 = -1024;

// Decode a finite f32 without performing arithmetic on a possibly
// subnormal value. The returned mantissa is in [1, 2), and
// value = sign * mantissa * 2^exponent.
fn finiteExponent(value: f32) -> i32 {
  let magnitudeBits = bitcast<u32>(value) & 0x7fffffffu;
  if (magnitudeBits == 0u) {
    return ZERO_EXPONENT;
  }
  let rawExponent = (magnitudeBits >> 23u) & 0xffu;
  if (rawExponent == 0u) {
    let fraction = magnitudeBits & 0x7fffffu;
    let highestBit = 31u - countLeadingZeros(fraction);
    return i32(highestBit) - 149;
  }
  return i32(rawExponent) - 127;
}

fn finiteMantissa(value: f32) -> f32 {
  let magnitudeBits = bitcast<u32>(value) & 0x7fffffffu;
  if (magnitudeBits == 0u) {
    return 0.0;
  }
  let rawExponent = (magnitudeBits >> 23u) & 0xffu;
  let fraction = magnitudeBits & 0x7fffffu;
  if (rawExponent == 0u) {
    let highestBit = 31u - countLeadingZeros(fraction);
    return f32(fraction) / f32(1u << highestBit);
  }
  return 1.0 + f32(fraction) * 0.00000011920928955078125;
}

fn productExponent(a: f32, b: f32) -> i32 {
  if ((a == 0.0) || (b == 0.0)) {
    return ZERO_EXPONENT;
  }
  return finiteExponent(a) + finiteExponent(b);
}

// Reconstruct a signed product only after aligning it to the shared largest
// exponent. The result is normal-range when this component is dominant.
fn alignedProduct(a: f32, b: f32, sharedExponent: i32) -> f32 {
  if ((a == 0.0) || (b == 0.0)) {
    return 0.0;
  }
  let magnitude = ldexp(
    finiteMantissa(a) * finiteMantissa(b),
    productExponent(a, b) - sharedExponent,
  );
  let isNegative = ((bitcast<u32>(a) ^ bitcast<u32>(b)) & 0x80000000u) != 0u;
  return select(magnitude, -magnitude, isNegative);
}

fn alignedValue(value: f32, sharedExponent: i32) -> f32 {
  return ldexp(finiteMantissa(value), finiteExponent(value) - sharedExponent);
}

@compute @workgroup_size(NORMAL_WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // #32 region dispatch: yOffset (0 on a full frame) shifts the 1D texel
  // index into the dispatched band. The first guard is the historical
  // full-frame bound; the second uses regionEnd (0 = full-frame sentinel; a
  // band may legitimately start at y0 = 0, so the region is signaled by
  // regionEnd alone) to stop the tail workgroup's padded invocations, which
  // lie inside the buffer but past the band end, so they can never write a
  // retained texel outside the band.
  let g = gid.x + params.yOffset;
  let texelCount = params.width * params.height;
  if (g >= texelCount) {
    return; // in-shader bounds guard
  }
  if (params.regionEnd != 0u && g >= params.regionEnd) {
    return; // #32 region-bound guard (padding-safe; never active on a full frame)
  }
  let tx = g % params.width;
  let ty = g / params.width;
  // Symmetric central difference; missing neighbors at target edges are
  // replicated/clamped to the edge texel (never wrapped, never out of
  // buffer). Mirrors computeNormals exactly.
  // Subtract only after the guard: u32 subtraction at zero wraps before a
  // max() call could clamp it.
  var x0 = 0u;
  if (tx > 0u) {
    x0 = tx - 1u;
  }
  let x1 = min(tx + 1u, params.width - 1u);
  var y0 = 0u;
  if (ty > 0u) {
    y0 = ty - 1u;
  }
  let y1 = min(ty + 1u, params.height - 1u);
  let row = ty * params.width;
  let row0 = y0 * params.width;
  let row1 = y1 * params.width;
  let dx = inHeight[row + x1] - inHeight[row + x0];
  let dy = inHeight[row1 + tx] - inHeight[row0 + tx];
  // Sign rule: a height rising toward +x/+y gives a negative x/y component;
  // +z is toward the viewer. Scaling affects only the derivative-to-normal
  // conversion, never the underlying height field. Product exponents are
  // aligned before multiplication, so no finite f32 derivative/scale pair
  // can overflow and no extreme reciprocal is required. Mirrors the f64
  // oracle's vector direction.
  let xExponent = productExponent(dx, params.scaleX);
  let yExponent = productExponent(dy, params.scaleY);
  let zExponent = finiteExponent(params.normalScale);
  let sharedExponent = max(max(xExponent, yExponent), zExponent);
  let qx = -alignedProduct(dx, params.scaleX, sharedExponent);
  let qy = -alignedProduct(dy, params.scaleY, sharedExponent);
  let qz = alignedValue(params.normalScale, sharedExponent);
  let m = max(max(abs(qx), abs(qy)), qz);
  let o = g * 3u;
  let sx = qx / m;
  let sy = qy / m;
  let sz = qz / m;
  let len = sqrt(sx * sx + sy * sy + sz * sz);
  outNormal[o] = sx / len;
  outNormal[o + 1u] = sy / len;
  outNormal[o + 2u] = sz / len;
}
`;
