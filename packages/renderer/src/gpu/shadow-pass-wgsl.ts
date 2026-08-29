import { WGSL_SCENE_BASE } from "./wgsl";

/**
 * #27 shadow-pass WGSL shader — the GPU-resident hard shadow visibility stage.
 *
 * This is a SELF-CONTAINED compute module (one invocation per render texel)
 * that consumes the #25 allocations DIRECTLY — the full visible height
 * field (binding 1), the caster-only height field (binding 2), the full
 * object-id field (binding 3) and the uploaded ABI surface records
 * (binding 4, used ONLY to resolve `receivesShadow` from the SurfaceRecord
 * flags) — plus a small uniform (binding 0), and writes one tightly packed
 * f32 visibility scalar per texel (binding 5): `1.0` lit, `0.0` occluded.
 * No height/ownership/visibility readback exists anywhere in production
 * code; the march itself never samples an out-of-range storage element.
 *
 * ## Fixed #17/#18 CPU semantics mirrored here (the oracle is
 * `packages/renderer/src/shadow.ts`)
 *
 * For a receiver texel at DPR `dpr`, the logical scene position is
 * `P = ((tx + 0.5) / dpr, (ty + 0.5) / dpr, Hfull(P.xy))`. The march
 * follows the NORMALIZED directional light (direction points FROM the
 * receiver TOWARD the light):
 *
 *     for k = 1 .. stepCount:                     (t = f32(k) * stepSize)
 *         sampleXY = P.xy + light.xy * t
 *         rayZ     = f32(P.z + light.z * t)
 *         stop lit if sampleXY leaves the pixel-center rectangle
 *         stop lit if rayZ > maxCasterHeight + bias
 *         occluded if f32(Hcaster(sampleXY)) > f32(rayZ + bias)
 *
 * - `Hfull` (binding 1) supplies the receiver z (f32, never re-rounded).
 * - `Hcaster` (binding 2) is the separately composed caster-only height
 *   field (#27 caster-height pass); a non-casting top surface must never
 *   hide a lower casting surface, so occlusion samples THIS field, never
 *   the full-field owner at a ray sample.
 * - Receiver ownership comes from the #25 object-id field: `NO_OWNER` (the
 *   base plane) RECEIVES shadows; a valid owner with the ABI
 *   `FLAG_RECEIVES_SHADOW` bit clear returns `1.0` before marching; an
 *   invalid owner (never emitted by valid #25 output) follows the CPU
 *   defensive behavior and is treated as receiving.
 * - When the scene has NO casting surface (`hasCasters == 0`) every
 *   invocation returns `1.0` without marching; empty space along a ray is
 *   sampled normally.
 * - Bilinear sampling matches the CPU oracle's DPR-aware conversion:
 *   logical scene position -> render-field interpolation coordinates use
 *   the same center convention, `fx = sx * dpr - 0.5` (the receiver's own
 *   texel maps back to `fx = tx` exactly). Render texel centers are the
 *   samples, interpolation is row-major, and the four lookup indices
 *   replicate the edge (`clamp`), so no wrap and no out-of-bounds element
 *   is ever touched. The march checks the inclusive pixel-center rectangle
 *   in LOGICAL scene units — from the first texel center `0.5 / dpr` to
 *   the LAST texel center `(extent - 0.5) / dpr` on each axis — BEFORE
 *   sampling.
 * - The strict comparison is preserved: an occluder blocks only when its
 *   f32 sampled height is GREATER THAN `f32(rayZ + bias)`; equality is
 *   lit. Operation order mirrors the CPU oracle: `rayZ` is formed in f32
 *   exactly like `Math.fround(rz0 + lz * t)` with f32 `t` (the host keeps
 *   `t = f32(k) * stepSize`, so power-of-two steps stay exact).
 * - Termination: `stepCount = floor(maxDistance / stepSize)` is computed
 *   and bounded on the HOST (`MAX_SHADOW_STEP_COUNT`); the shader iterates
 *   an INTEGER step index, so the u32 loop always terminates even when a
 *   (positive, accepted) subnormal stepSize makes `t` round to a constant
 *   — a value whose f32 rounds to zero is rejected by the host sanitizer
 *   and can never appear here.
 * - #48 ray-bound clipping: projected XY coordinates are monotone along a
 *   ray, so the last in-bounds integer step is found with an exact-arithmetic
 *   binary search. The march then iterates only that prefix; no valid sample
 *   is skipped and the per-step bounds branch is removed.
 * - #48 empty-space culling: the host packs the union of casting-surface
 *   footprint AABBs into the otherwise-unused w lanes of the first four
 *   sample-direction vec4s. Outside that union (with a conservative
 *   two-texel interpolation pad), the caster field is zero and its four
 *   storage reads are skipped whenever the zero base plane cannot satisfy the
 *   strict comparison.
 *
 * ## Conservative early-exit bound (host-derived, no readback)
 *
 * `maxCasterHeight = max(elevation + thickness)` over the CASTING ABI
 * surface records is computed on the host from the already CPU-resident,
 * validated scene bytes — never by scanning the GPU height field. It is an
 * upper bound on every f32 sample of the caster field (flat tops equal
 * `f32(elevation + thickness)`, bevels/SDF edges are lower), so
 * `rayZ > maxCasterHeight + bias` cannot remove a blocker: it only stops
 * the march once no sample can possibly exceed `rayZ + bias`.
 *
 * ## Pass bindings (group 0, owned by `ShadowPass`)
 *
 * | binding | type   | meaning                                        |
 * |---------|--------|------------------------------------------------|
 * | 0       | uniform| ShadowPassParams (2144 bytes)                 |
 * | 1       | storage| inHeight: array<f32> (#25 full height,         |
 * |         |        | read-only, bound DIRECTLY, never copied)       |
 * | 2       | storage| inCasterHeight: array<f32> (#27 caster height, |
 * |         |        | read-only, bound DIRECTLY, never copied)       |
 * | 3       | storage| objectId: array<u32> (#25 object-id, read-only)|
 * | 4       | storage| surfaces: array<SurfaceRecord> (uploaded ABI   |
 * |         |        | records, read-only, receivesShadow only)       |
 * | 5       | storage| outVisibility: array<f32> (read_write)         |
 *
 * ## ShadowPassParams — 2144 bytes, align 16, little-endian host packing
 *
 * | offset | size | field            | meaning                               |
 * |--------|------|------------------|---------------------------------------|
 * | 0      | 4    | dpr (f32)        | render DPR (scene units per texel)    |
 * | 4      | 12   | _pad0..2 (f32)   | 0 (vec4 alignment)                    |
 * | 16     | 16   | lightDirection   | vec4 (x, y, z, 0), normalized light   |
 * |        |      | (vec4<f32>)      | from receiver toward the light        |
 * | 32     | 4    | stepSize (f32)   | march step in scene units (> 0)       |
 * | 36     | 4    | bias (f32)       | self-shadow acne bias (>= 0)          |
 * | 40     | 4    | maxDistance (f32)| maximum march distance                |
 * | 44     | 4    | maxCasterHeight  | host-derived caster-top bound (f32)   |
 * |        |      | (f32)            |                                       |
 * | 48     | 4    | width (u32)      | render width (texels)                 |
 * | 52     | 4    | height (u32)     | render height (texels)                |
 * | 56     | 4    | workgroupSize    | documented dispatch workgroup size    |
 * |        |      | (u32)            |                                       |
 * | 60     | 4    | surfaceCount     | header surface count (u32)            |
 * |        |      | (u32)            |                                       |
 * | 64     | 4    | stepCount (u32)  | floor(maxDistance / stepSize),        |
 * |        |      |                  | <= MAX_SHADOW_STEP_COUNT              |
 * | 68     | 4    | hasCasters (u32) | 1 when any surface has FLAG_CASTS_    |
 * |        |      |                  | SHADOW (early exit 1.0 when 0)        |
 * | 72     | 4    | yOffset (u32)    | #32 region dispatch texel offset      |
 * |        |      |                  | (0 = full frame; the shader indexes   |
 * |        |      |                  | `g = gid.x + yOffset`)               |
 * | 76     | 4    | regionEnd (u32)  | #32 exclusive texel end of the        |
 * |        |      |                  | dispatched region (0 = full-frame     |
 * |        |      |                  | sentinel — a band may legitimately    |
 * |        |      |                  | start at y0 = 0, so the region is     |
 * |        |      |                  | signaled by regionEnd alone; the      |
 * |        |      |                  | shader guards `regionEnd != 0 &&      |
 * |        |      |                  | g >= regionEnd`, so dispatch padding  |
 * |        |      |                  | never writes a retained texel)        |
 * | 80     | 4    | angularRadius    | #41 light angular radius in radians   |
 * |        |      | (f32)            | (0 = hard path)                       |
 * | 84     | 4    | sampleCount (u32)| #41 area-light samples (1 = hard path)|
 * | 88     | 8    | _pad3 (vec2<f32>)| 0 (alignment)                         |
 * | 96..   | 2048 | sampleDirs       | #43 KERNEL_VARIANTS x MAX_SAMPLES     |
 * |        |      | (array<vec4<f32>>,| packed cone directions; variant v's   |
 * |        |      | 128 entries)     | sample s lives at index v*16 + s.     |
 * |        |      |                  | The w lanes of entries 0..3 carry the |
 * |        |      |                  | conservative caster AABB (minX, minY,  |
 * |        |      |                  | maxX, maxY); direction code reads xyz. |
 *
 * `width`/`height` are host-validated (positive integers, u32-bounded
 * texel count, byte-length-consistent with every bound field), so the
 * shader's `params.width * params.height` product and every row/texel
 * index can never overflow u32 or sample out of a buffer. All offsets are
 * pinned by `shadow-pass.ts` (host) and by the Node contract tests.
 *
 * ## Output layout
 *
 * One tightly packed row-major scalar f32 per texel — `4 * width * height`
 * logical bytes; texel `(tx, ty)` lives at array index
 * `ty * width + tx`. Production usage is `STORAGE | COPY_SRC | COPY_DST`,
 * never mapped.
 */

/** Dispatch workgroup size for the shadow pass (documented, injected into WGSL). */
export const SHADOW_WORKGROUP_SIZE = 64;

/**
 * #41 maximum area-light sample count: the params uniform carries a fixed
 * `array<vec4<f32>, SHADOW_MAX_SAMPLES>` of host-computed cone directions
 * per KERNEL VARIANT after the scalar fields.
 */
export const SHADOW_MAX_SAMPLES = 16;

/**
 * #43 deterministic kernel-variant count (mirrors
 * `SHADOW_KERNEL_VARIANTS` in `shadow-sampling.ts`): the uniform packs this
 * many full direction arrays and every texel selects one through the
 * `kernelVariant(tx, ty)` integer hash below, decorrelating neighboring
 * texels' sampling error while both backends trace byte-identical f32
 * directions.
 */
export const SHADOW_KERNEL_VARIANTS = 8;

/**
 * ShadowPassParams uniform byte length: 96 bytes of scalars/padding (16-byte
 * aligned) plus SHADOW_KERNEL_VARIANTS * 16 packed vec4 sample directions =
 * 96 + 8 * 256 = 2144 bytes. The first four direction w lanes are reused for
 * the #48 caster AABB hint; xyz direction values remain byte-identical.
 */
export const SHADOW_PARAMS_BYTE_LENGTH = 96 + SHADOW_KERNEL_VARIANTS * SHADOW_MAX_SAMPLES * 16;

/** Logical output bytes per render texel: one tightly packed f32 scalar. */
export const SHADOW_OUTPUT_BYTES_PER_TEXEL = 4;

/**
 * Hard termination cap for the in-shader march: `stepCount =
 * floor(maxDistance / stepSize)` must be <= this after sanitization, so the
 * u32 loop terminates on every device. 2^24 steps is far beyond any
 * practical march and still trivially terminates.
 */
export const MAX_SHADOW_STEP_COUNT = 1 << 24;

export const SHADOW_PASS_WGSL = /* wgsl */ `
${WGSL_SCENE_BASE}
// #27/#41/#48 shadow pass params (2144 bytes, align 16; offsets pinned by
// shadow-pass.ts)
struct ShadowPassParams {
  dpr: f32,             //  0 render DPR (scene units per render texel)
  _pad0: f32,           //  4
  _pad1: f32,           //  8
  _pad2: f32,           // 12
  lightDirection: vec4<f32>, // 16 (x, y, z, 0) normalized, toward the light
  stepSize: f32,        // 32 march step in scene units (> 0)
  bias: f32,            // 36 self-shadow acne bias (>= 0)
  maxDistance: f32,     // 40 maximum march distance
  maxCasterHeight: f32, // 44 host-derived caster-top bound (f32)
  width: u32,           // 48 render width (texels)
  height: u32,          // 52 render height (texels)
  workgroupSize: u32,   // 56 documented dispatch workgroup size
  surfaceCount: u32,    // 60 header surface count
  stepCount: u32,       // 64 floor(maxDistance / stepSize), capped
  hasCasters: u32,      // 68 1 when any surface casts (early exit when 0)
  yOffset: u32,         // 72 #32 region dispatch texel offset (0 = full frame)
  regionEnd: u32,       // 76 #32 exclusive region end (== texelCount full)
  angularRadius: f32,   // 80 #41 light angular radius in radians (0 = hard)
  sampleCount: u32,     // 84 #41 area-light samples (1 = hard path)
  _pad3: vec2<f32>,     // 88..95
  // #43 host-computed cone directions around lightDirection for EVERY kernel
  // variant (identical f32 components to the CPU oracle's per-variant
  // arrays; variant v's sample s lives at index v * SHADOW_MAX_SAMPLES + s).
  // Unused xyz entries are zero-filled and never read because sampleCount
  // bounds the loop and variant < SHADOW_KERNEL_VARIANTS. The w lanes of the
  // first four entries carry the #48 caster AABB hint (minX, minY, maxX,
  // maxY); all direction reads intentionally consume xyz only.
  sampleDirs: array<vec4<f32>, ${SHADOW_KERNEL_VARIANTS * SHADOW_MAX_SAMPLES}>, // 96..
}                       // size ${SHADOW_PARAMS_BYTE_LENGTH}, align 16

const SHADOW_WORKGROUP_SIZE: u32 = ${SHADOW_WORKGROUP_SIZE}u;
const SHADOW_MAX_SAMPLES: u32 = ${SHADOW_MAX_SAMPLES}u;
// #43 must mirror SHADOW_KERNEL_VARIANTS in shadow-sampling.ts exactly.
const SHADOW_KERNEL_VARIANTS: u32 = ${SHADOW_KERNEL_VARIANTS}u;
const NO_OWNER: u32 = 0xffffffffu;
// ABI SurfaceRecord flags (offset 28): bit0 castsShadow, bit1 receivesShadow
const FLAG_RECEIVES_SHADOW: u32 = 0x2u;

@group(0) @binding(0) var<uniform> params: ShadowPassParams;
// #25 full visible height field (read-only storage, bound DIRECTLY).
@group(0) @binding(1) var<storage, read> inHeight: array<f32>;
// #27 caster-only height field (read-only storage, bound DIRECTLY).
@group(0) @binding(2) var<storage, read> inCasterHeight: array<f32>;
// #25 object-id field (u32 ABI surface index or NO_OWNER).
@group(0) @binding(3) var<storage, read> objectId: array<u32>;
// Uploaded ABI surface records (read-only; only flags are consulted).
@group(0) @binding(4) var<storage, read> surfaces: array<SurfaceRecord>;
// Tightly packed row-major f32 visibility scalar per texel.
@group(0) @binding(5) var<storage, read_write> outVisibility: array<f32>;

// Bilinear sample of the caster height field at a CONTINUOUS LOGICAL scene
// position, mirroring the CPU oracle's DPR-aware conversion (shadow.ts):
// logical -> render-field interpolation coordinates use the same center
// convention, fx = sx * dpr - 0.5 (at dpr 1 this is exactly sx - 0.5).
// Render texel centers are the samples, interpolation is row-major, and the
// four lookup indices replicate the edge (clamp) — no wrap, no out-of-bounds
// element.
fn sampleCasterHeight(sx: f32, sy: f32) -> f32 {
  let fx = clamp(sx * params.dpr - 0.5, 0.0, f32(params.width - 1u));
  let fy = clamp(sy * params.dpr - 0.5, 0.0, f32(params.height - 1u));
  let x0 = u32(floor(fx));
  let y0 = u32(floor(fy));
  let x1 = min(x0 + 1u, params.width - 1u);
  let y1 = min(y0 + 1u, params.height - 1u);
  let tx = fx - f32(x0);
  let ty = fy - f32(y0);
  let row0 = y0 * params.width;
  let row1 = y1 * params.width;
  let v00 = inCasterHeight[row0 + x0];
  let v10 = inCasterHeight[row0 + x1];
  let v01 = inCasterHeight[row1 + x0];
  let v11 = inCasterHeight[row1 + x1];
  let top = v00 + (v10 - v00) * tx;
  let bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

// The bounds predicate deliberately uses the exact arithmetic from the
// historical march.  For a fixed direction, t = f32(k) * stepSize is
// monotone and each projected coordinate is monotone as well, so the set of
// in-bounds integer steps is a prefix.  The binary search below therefore
// finds the last valid step without changing which samples can be visited.
fn rayInBoundsAtStep(px: f32, py: f32, dx: f32, dy: f32, stepIndex: u32) -> bool {
  let t = f32(stepIndex) * params.stepSize;
  let sx = px + dx * t;
  let sy = py + dy * t;
  return !(sx < 0.5 / params.dpr || sx > (f32(params.width) - 0.5) / params.dpr ||
      sy < 0.5 / params.dpr || sy > (f32(params.height) - 0.5) / params.dpr);
}

// Return the largest march index whose sample position is inside the
// inclusive pixel-center rectangle.  stepCount is host-capped, so the
// integer search always terminates.  A ray with no XY travel stays in bounds
// for the whole configured budget and avoids the search entirely.
fn rayBoundsStepLimit(px: f32, py: f32, dx: f32, dy: f32) -> u32 {
  let limit = params.stepCount;
  if (limit == 0u || (dx == 0.0 && dy == 0.0)) {
    return limit;
  }
  if (rayInBoundsAtStep(px, py, dx, dy, limit)) {
    return limit;
  }
  var lo = 0u;
  var hi = limit;
  while (lo < hi) {
    let mid = (lo + hi + 1u) >> 1u;
    if (rayInBoundsAtStep(px, py, dx, dy, mid)) {
      lo = mid;
    } else {
      hi = mid - 1u;
    }
  }
  return lo;
}

/**
 * One #17/#27/#41 height-field occlusion march along the explicit direction
 * (dx, dy, dz) from receiver P = (px, py, rz0). The single hard ray and
 * every #41 area-light cone sample run THIS loop, so the semantics (bounds,
 * f32-multiple march series, maxHeight early exit, strict f32 comparison)
 * are identical by construction. Passing params.lightDirection reproduces
 * the historical hard-shadow result exactly.
 */fn traceOccluded(px: f32, py: f32, rz0: f32, dx: f32, dy: f32, dz: f32) -> bool {
  // Integer step index: the loop terminates on every device (stepCount is
  // host-capped), even when a positive subnormal stepSize makes t round to
  // a constant in f32.
  let stepLimit = rayBoundsStepLimit(px, py, dx, dy);
  let casterPad = 2.0 / params.dpr;
  let casterMinX = params.sampleDirs[0].w - casterPad;
  let casterMinY = params.sampleDirs[1].w - casterPad;
  let casterMaxX = params.sampleDirs[2].w + casterPad;
  let casterMaxY = params.sampleDirs[3].w + casterPad;
  var stepIndex = 1u;
  while (stepIndex <= stepLimit) {
    // Explicit f32-multiple march series (shared with the CPU oracle):
    // t = f32(stepIndex) * stepSize is the correctly-rounded f32 of the
    // exact integer multiple k * stepSize (f32(stepIndex) == k for every
    // k <= 2^24), so a NON-DYADIC step like 0.1 produces the EXACT same
    // series as the CPU's t = fround(k * stepSize) — no per-step f32
    // accumulation drift. stepCount == floor(maxDistance / stepSize) is the
    // host-derived iteration count, bounded by MAX_SHADOW_STEP_COUNT.
    let t = f32(stepIndex) * params.stepSize;
    let sx = px + dx * t;
    let sy = py + dy * t;
    let rayZ = rz0 + dz * t;
    // Conservative host-derived bound: beyond maxCasterHeight + bias no
    // sample can exceed rayZ + bias, so this early exit cannot remove a
    // blocker (mirrors the CPU's maxHeight early exit).
    if (rayZ > params.maxCasterHeight + params.bias) {
      break;
    }
    let threshold = rayZ + params.bias;
    // Empty-space cull: outside the conservative caster union, the caster
    // field is exactly zero.  Keep the read for a negative threshold because
    // the zero base plane can then be a strict occluder.
    if (!(sx >= casterMinX && sx <= casterMaxX && sy >= casterMinY && sy <= casterMaxY) &&
        threshold >= 0.0) {
      stepIndex += 1u;
      continue;
    }
    let sample = sampleCasterHeight(sx, sy);
    // Strict f32 comparison: blocks only when sample > f32(rayZ + bias);
    // equality is lit. Mirrors the CPU operation order.
    if (sample > threshold) {
      return true;
    }
    stepIndex += 1u;
  }
  return false;
}

// #43 deterministic per-texel kernel-variant selection — the EXACT integer
// hash mirrored from softKernelVariant() in shadow-sampling.ts
// (wrapping u32 multiply/xor/shift only; no transcendentals, no mutable
// state, identical semantics to JS Math.imul + >>> 0).
fn kernelVariant(tx: u32, ty: u32) -> u32 {
  var h = (u32(tx + 1u) * 0x9e3779b1u) ^ (u32(ty + 1u) * 0x85ebca77u);
  h = h ^ (h >> 15u);
  h = h * 0x2545f491u;
  h = h ^ (h >> 13u);
  return h % SHADOW_KERNEL_VARIANTS;
}

@compute @workgroup_size(SHADOW_WORKGROUP_SIZE)
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
  // Receiver rules (#17/#18/#27): NO_OWNER (base plane) RECEIVES shadows; a
  // valid owner whose FLAG_RECEIVES_SHADOW bit is clear returns 1.0 before
  // marching; an invalid owner follows the CPU defensive behavior and is
  // treated as receiving (the host validates owner < surfaceCount, so this
  // guard is defensive only).
  let owner = objectId[g];
  var receives = true;
  if (owner != NO_OWNER && owner < params.surfaceCount) {
    receives = (surfaces[owner].flags & FLAG_RECEIVES_SHADOW) != 0u;
  }
  if (!receives) {
    outVisibility[g] = 1.0;
    return;
  }
  // No casting surface: every invocation may return 1.0 without marching.
  if (params.hasCasters == 0u) {
    outVisibility[g] = 1.0;
    return;
  }
  let tx = g % params.width;
  let ty = g / params.width;
  let px = (f32(tx) + 0.5) / params.dpr;
  let py = (f32(ty) + 0.5) / params.dpr;
  let rz0 = inHeight[g];
  // #41 hard/soft selection: with a degenerate cone (angularRadius 0 or a
  // single sample) the historical single-ray path runs and writes exactly
  // {1.0, 0.0}; otherwise each cone sample direction marches the same loop
  // and the lit fraction becomes the continuous visibility scalar.
  if (params.angularRadius <= 0.0 || params.sampleCount <= 1u) {
    let occluded = traceOccluded(
      px,
      py,
      rz0,
      params.lightDirection.x,
      params.lightDirection.y,
      params.lightDirection.z,
    );
    outVisibility[g] = select(1.0, 0.0, occluded);
    return;
  }
  var visible = 0u;
  // #43: this texel marches ITS OWN deterministic kernel variant (the same
  // hash the CPU oracle evaluates), so neighboring texels decorrelate their
  // sampling error while every backend traces byte-identical f32 directions.
  let variantBase = kernelVariant(tx, ty) * SHADOW_MAX_SAMPLES;
  for (var s = 0u; s < params.sampleCount && s < SHADOW_MAX_SAMPLES; s += 1u) {
    let dir = params.sampleDirs[variantBase + s].xyz;
    if (!traceOccluded(px, py, rz0, dir.x, dir.y, dir.z)) {
      visible += 1u;
    }
  }
  // Dyadic sample counts make this quotient exactly representable, so the
  // value is bit-identical to the CPU oracle's visible/samples.
  outVisibility[g] = f32(visible) / f32(params.sampleCount);
}
`;
