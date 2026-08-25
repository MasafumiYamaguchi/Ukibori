/**
 * #43 shadow-visibility reconstruction pass WGSL — a retained compute stage
 * between the #41 ShadowPass and the LightingPass:
 *
 *     ShadowPass (rawVisibility, exact sampled k/n)
 *     -> ShadowReconstructionPass (edge-aware reconstruction)
 *     -> reconstructedVisibility
 *     -> LightingPass / PresentationPass
 *
 * The physically sampled RAW field stays available for debugging/parity;
 * this pass is a RECONSTRUCTOR of that field, never the source of the
 * penumbra shape: a small gated box filter with FIXED uniform spatial
 * weights whose footprint is bounded by the sanitized `radiusTexels` —
 * never an arbitrary blur radius. The #41 ray geometry (caster/receiver
 * separation x angularRadius) alone determines the physical penumbra width.
 *
 * ## Fixed CPU semantics mirrored here (the oracle is
 * `packages/renderer/src/shadow-reconstruct.ts`)
 *
 * For texel g = ty * width + tx the filter walks the clamped
 * `(2r+1)^2` neighborhood in FIXED row-major order (dy outer from -r to +r,
 * dx inner), applying two deterministic edge gates BEFORE accumulating:
 *
 * - ownership gate: neighbor objectId != center objectId -> skipped
 *   (NO_OWNER matches only NO_OWNER), so shadows never leak through
 *   unrelated foreground receivers;
 * - height gate: |centerHeight - neighborHeight| > heightGate (scene units,
 *   f32 comparison) -> skipped, so smoothing never crosses object
 *   silhouettes or steep bevels.
 *
 * Surviving taps share ONE fixed weight; the output is `sum / taps`
 * clamped into [0, 1] (`taps == 0` keeps the center value). The tap order
 * mirrors the CPU reference line-by-line; the quotient `sum / tapCount` is
 * NOT dyadic, so cross-backend parity uses the documented tight tolerance
 * (never a bit-identical promise — the GPU accumulates/divides in f32, the
 * CPU rounds the exact f64 quotient once).
 *
 * ## Region dispatch / halo (#32/#43)
 *
 * The pass supports the shared band dispatch (`yOffset`/`regionEnd`, same
 * guards as every field pass). Because the filter READS raw visibility of
 * neighboring texels, the pipeline expands the dispatched band by
 * `radiusTexels` rows on each side (clipped to the frame): every consumed
 * output row is written this frame while out-of-band reads hit RETAINED raw
 * texels that the #32 planner's shadow halo proves unchanged. Reads never
 * consult the reconstruction output itself, so no cross-band feedback can
 * occur.
 *
 * ## ReconstructionParams — 32 bytes, align 16, little-endian host packing
 *
 * | offset | size | field            | meaning                                |
 * |--------|------|------------------|----------------------------------------|
 * | 0      | 4    | width (u32)      | render width (texels)                  |
 * | 4      | 4    | height (u32)     | render height (texels)                 |
 * | 8      | 4    | radiusTexels     | sanitized integer filter radius        |
 * |        |      | (u32)            | (single dpr conversion on the host)    |
 * | 12     | 4    | yOffset (u32)    | band texel offset (0 = full frame)     |
 * | 16     | 4    | regionEnd (u32)  | exclusive region end (0 = full frame)  |
 * | 20     | 4    | heightGate (f32) | scene-unit height-discontinuity gate   |
 * | 24     | 8    | _pad0..1         | 0 (vec4 alignment)                     |
 *
 * All offsets are pinned by `reconstruction-pass.ts` (host) and by the Node
 * contract tests.
 */

/** Dispatch workgroup size for the reconstruction pass (mirrors the field passes). */
export const RECONSTRUCTION_WORKGROUP_SIZE = 64;

/** ReconstructionParams uniform byte length (16-byte aligned). */
export const RECONSTRUCTION_PARAMS_BYTE_LENGTH = 32;

/** Logical output bytes per render texel: one tightly packed f32 scalar. */
export const RECONSTRUCTION_OUTPUT_BYTES_PER_TEXEL = 4;

export const RECONSTRUCTION_PASS_WGSL = /* wgsl */ `
// #43 reconstruction pass params (32 bytes, align 16; offsets pinned by
// reconstruction-pass.ts)
struct ReconstructionParams {
  width: u32,          //  0 render width (texels)
  height: u32,         //  4 render height (texels)
  radiusTexels: u32,   //  8 sanitized integer filter radius (>= 1 here)
  yOffset: u32,        // 12 #32 band texel offset (0 = full frame)
  regionEnd: u32,      // 16 exclusive region end (0 = full-frame sentinel)
  heightGate: f32,     // 20 scene-unit height-discontinuity gate
  _pad0: u32,          // 24
  _pad1: u32,          // 28
}                      // size ${RECONSTRUCTION_PARAMS_BYTE_LENGTH}, align 16

const NO_OWNER: u32 = 0xffffffffu;

@group(0) @binding(0) var<uniform> params: ReconstructionParams;
// Exact #41 raw visibility field (read-only; NEVER written here).
@group(0) @binding(1) var<storage, read> inRawVisibility: array<f32>;
// Full visible height field (edge-guidance input).
@group(0) @binding(2) var<storage, read> inHeight: array<f32>;
// Object-id field (u32 ABI surface index or NO_OWNER).
@group(0) @binding(3) var<storage, read> objectId: array<u32>;
// Reconstructed visibility, one tightly packed f32 scalar per texel.
@group(0) @binding(4) var<storage, read_write> outReconstructed: array<f32>;

@compute @workgroup_size(RECONSTRUCTION_WORKGROUP_SIZE)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // Same band guards as every field pass: the historical full-frame bound,
  // then the exclusive region end (dispatch padding can never write a
  // retained texel outside the dispatched band).
  let g = gid.x + params.yOffset;
  let texelCount = params.width * params.height;
  if (g >= texelCount) {
    return; // in-shader bounds guard
  }
  if (params.regionEnd != 0u && g >= params.regionEnd) {
    return; // region-bound guard
  }
  let tx = g % params.width;
  let ty = g / params.width;
  let centerY = inHeight[g];
  let centerOwner = objectId[g];
  // Uniform-weight gated box average over the clamped neighborhood, in
  // FIXED row-major declaration order (dy outer -r..+r, dx inner): the
  // exact tap sequence the CPU oracle accumulates. Raw visibility values
  // are dyadic k/n rationals, so the f32 accumulation is EXACT and the tap
  // order cannot change the result on either backend.
  var sum = 0.0;
  var taps = 0u;
  let r = i32(params.radiusTexels);
  for (var dy = -r; dy <= r; dy += 1) {
    let ny = clamp(i32(ty) + dy, 0, i32(params.height) - 1);
    for (var dx = -r; dx <= r; dx += 1) {
      let nx = clamp(i32(tx) + dx, 0, i32(params.width) - 1);
      let ng = u32(ny) * params.width + u32(nx);
      if (objectId[ng] != centerOwner) {
        continue; // ownership gate: never bleed across receiver boundaries
      }
      let nh = inHeight[ng];
      if (abs(centerY - nh) > params.heightGate) {
        continue; // height gate: never smooth across height discontinuities
      }
      sum = sum + inRawVisibility[ng];
      taps = taps + 1u;
    }
  }
  let vis = select(sum / f32(taps), inRawVisibility[g], taps == 0u);
  outReconstructed[g] = clamp(vis, 0.0, 1.0);
}
`;
