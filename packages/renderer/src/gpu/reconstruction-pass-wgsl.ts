/**
 * #43/#53 shadow-visibility reconstruction pass WGSL — a retained compute
 * stage between the #41 ShadowPass and the LightingPass:
 *
 *     ShadowPass (rawVisibility, exact sampled k/n)
 *     -> ShadowReconstructionPass (mode 0: soft value-bilateral penumbra
 *        reconstruction | mode 1: hard ring-rule binomial edge refinement)
 *     -> reconstructedVisibility (the DISPLAY field)
 *     -> LightingPass / PresentationPass
 *
 * The physically sampled RAW field stays available for debugging/parity;
 * this pass is a RECONSTRUCTOR of that field, never the source of the
 * penumbra shape: the soft mode is a small gated box filter with
 * value-space Gaussian weights whose footprint is bounded by the sanitized
 * `radiusTexels` — never an arbitrary blur radius; the hard mode (#53) is a
 * pure postprocess with no ray marching at all. The #41 ray geometry
 * (caster/receiver separation x angularRadius) alone determines the
 * physical penumbra width.
 *
 * ## Fixed CPU semantics mirrored here (the oracle is
 * `packages/renderer/src/shadow-reconstruct.ts`)
 *
 * ### Mode 0 — soft (area-light path)
 *
 * For texel g = ty * width + tx the filter walks the clamped
 * `(2r+1)^2` neighborhood in FIXED row-major order (dy outer from -r to +r,
 * dx inner), applying three deterministic gates/weights BEFORE accumulating:
 *
 * - ownership gate: neighbor objectId != center objectId -> skipped
 *   (NO_OWNER matches only NO_OWNER), so shadows never leak through
 *   unrelated foreground receivers;
 * - height gate: |centerHeight - neighborHeight| > heightGate (scene units,
 *   f32 comparison) -> skipped, so smoothing never crosses object
 *   silhouettes or steep bevels;
 * - value weight (#53): each surviving tap weighs
 *   `exp(-(dv*dv) / (2 * valueSigma^2))` for the visibility difference `dv`
 *   to the center. #53 measured the uniform-weight box averaging ACROSS
 *   narrow shadow bands (a 3-texel dark band lost ~62% of its depth — thin
 *   blockers effectively vanished); the Gaussian weight excludes full-range
 *   jumps (weight ~3e-4) while one-to-two sample-level differences (the
 *   decorrelated sampling noise) keep weight >= 0.6, so the penumbra still
 *   smooths and the penumbra WIDTH is unchanged (the measured transition
 *   width stays within one texel of the uniform box).
 *
 * The output is `sum(w * v) / sum(w)` clamped into [0, 1] (the center tap
 * always survives its own gates with weight exactly 1, so the divisor is
 * never zero). The tap/weight order mirrors the CPU reference
 * line-by-line; the quotient is NOT dyadic, so cross-backend parity uses
 * the documented tight tolerance (never a bit-identical promise — the GPU
 * accumulates/divides in f32, the CPU rounds the exact f64 quotient once).
 *
 * ### Mode 1 — hard (single-ray path, #53)
 *
 * The historical hard path wrote an EXACT binary {0, 1} field and bypassed
 * this stage, so diagonal/curved shadow boundaries displayed as a raw texel
 * staircase (#53 primary cause, measured: transition width 0, zero partial
 * levels at every DPR). The hard mode is a PURE POSTPROCESS of the raw
 * field (no ray marching, no shadow semantics touched):
 *
 * - a texel is refined ONLY when its 8-neighbor ring (clockwise W, NW, N,
 *   NE, E, SE, S, SW) shows EXACTLY `RING_EDGE_TRANSITIONS` (2)
 *   visibility-side transitions with BOTH same-side arcs spanning at least
 *   `RING_EDGE_MIN_ARC` (3) ring texels — exactly one locally-straight
 *   shadow boundary through the 3x3 window;
 * - the refined value is the separable binomial
 *   `(1,2,1)/2 (x) (1,2,1)/2` over the 3x3 RAW window — a ~1-2 texel
 *   coverage ramp whose 50% crossing stays on the binary boundary (edge
 *   position preserved); the binary taps make the result an exact dyadic
 *   k/16 rational in f32, so CPU and GPU agree BIT-IDENTICALLY (zero
 *   tolerance, like the raw field);
 * - everything else is copied VERBATIM: narrow features (arcs < 3), isolated
 *   texels, corners (4+ transitions) and the 1-texel frame border keep the
 *   raw value — thin blockers cannot be diluted and silhouette corners stay
 *   crisp.
 *
 * The raw {0, 1} contract is NOT weakened: the refined field is the DISPLAY
 * representation consumed by lighting/presentation, while the raw field
 * stays available verbatim as the oracle/debug source (pass snapshot +
 * the `enabled: false` bypass).
 *
 * ## Region dispatch / halo (#32/#43/#53)
 *
 * The pass supports the shared band dispatch (`yOffset`/`regionEnd`, same
 * guards as every field pass). Because both modes READ neighboring raw
 * visibility, the pipeline expands the dispatched band by the mode's read
 * radius on each side (clipped to the frame): soft mode `radiusTexels`
 * rows, hard mode the 1-texel ring — every consumed output row is written
 * this frame while out-of-band reads hit RETAINED raw texels that the #32
 * planner's shadow halo proves unchanged. Reads never consult the
 * reconstruction output itself, so no cross-band feedback can occur.
 *
 * ## ReconstructionParams — 32 bytes, align 16, little-endian host packing
 *
 * | offset | size | field            | meaning                                |
 * |--------|------|------------------|----------------------------------------|
 * | 0      | 4    | width (u32)      | render width (texels)                  |
 * | 4      | 4    | height (u32)     | render height (texels)                 |
 * | 8      | 4    | radiusTexels     | sanitized integer filter radius        |
 * |        |      | (u32)            | (single dpr conversion on the host;    |
 * |        |      |                  | soft mode only — the hard mode reads   |
 * |        |      |                  | the fixed 3x3 ring)                    |
 * | 12     | 4    | yOffset (u32)    | band texel offset (0 = full frame)     |
 * | 16     | 4    | regionEnd (u32)  | exclusive region end (0 = full frame)  |
 * | 20     | 4    | heightGate (f32) | scene-unit height-discontinuity gate   |
 * | 24     | 4    | valueSigma (f32) | #53 value-bilateral sigma (visibility  |
 * |        |      |                  | units; soft mode only)                 |
 * | 28     | 4    | mode (u32)       | 0 = soft bilateral, 1 = hard refinement|
 *
 * All offsets are pinned by `reconstruction-pass.ts` (host) and by the Node
 * contract tests.
 */

/** Dispatch workgroup size for the reconstruction pass (mirrors the field passes). */
export const RECONSTRUCTION_WORKGROUP_SIZE = 64;

/** ReconstructionParams uniform byte length (16-byte aligned). */
export const RECONSTRUCTION_PARAMS_BYTE_LENGTH = 32;

/**
 * #53 reconstruction mode selectors (packed into `ReconstructionParams.mode`).
 * Mode 0 = soft value-bilateral penumbra reconstruction (#43 + #53 kernel
 * change); mode 1 = hard ring-rule binomial edge refinement (#53).
 */
export const RECONSTRUCTION_MODE_SOFT = 0;
export const RECONSTRUCTION_MODE_HARD = 1;

/** Logical output bytes per render texel: one tightly packed f32 scalar. */
export const RECONSTRUCTION_OUTPUT_BYTES_PER_TEXEL = 4;

export const RECONSTRUCTION_PASS_WGSL = /* wgsl */ `
// #43/#53 reconstruction pass params (32 bytes, align 16; offsets pinned by
// reconstruction-pass.ts)
struct ReconstructionParams {
  width: u32,          //  0 render width (texels)
  height: u32,         //  4 render height (texels)
  radiusTexels: u32,   //  8 sanitized integer filter radius (>= 1 here,
                       //    soft mode only)
  yOffset: u32,        // 12 #32 band texel offset (0 = full frame)
  regionEnd: u32,      // 16 exclusive region end (0 = full-frame sentinel)
  heightGate: f32,     // 20 scene-unit height-discontinuity gate
  valueSigma: f32,     // 24 #53 value-bilateral sigma (visibility units)
  mode: u32,           // 28 0 = soft bilateral, 1 = hard ring-binomial
}                      // size ${RECONSTRUCTION_PARAMS_BYTE_LENGTH}, align 16

// The dispatch workgroup size, injected from the host constant above (the
// @compute attribute below references THIS declared value; like every
// interpolated host constant here it must exist as a WGSL declaration or the
// module fails to compile on real devices).
const RECONSTRUCTION_WORKGROUP_SIZE: u32 = ${RECONSTRUCTION_WORKGROUP_SIZE}u;

// #53 hard-mode ring semantics (mirrors RING_EDGE_TRANSITIONS /
// RING_EDGE_MIN_ARC in shadow-reconstruct.ts — the CPU oracle is the single
// source of these constants; see the module doc).
const RING_EDGE_TRANSITIONS: u32 = 2u;
const RING_EDGE_MIN_ARC: i32 = 3;

const NO_OWNER: u32 = 0xffffffffu;

@group(0) @binding(0) var<uniform> params: ReconstructionParams;
// Exact #41 raw visibility field (read-only; NEVER written here).
@group(0) @binding(1) var<storage, read> inRawVisibility: array<f32>;
// Full visible height field (edge-guidance input; soft mode only).
@group(0) @binding(2) var<storage, read> inHeight: array<f32>;
// Object-id field (u32 ABI surface index or NO_OWNER; soft mode only).
@group(0) @binding(3) var<storage, read> objectId: array<u32>;
// Reconstructed visibility, one tightly packed f32 scalar per texel.
@group(0) @binding(4) var<storage, read_write> outReconstructed: array<f32>;

// #53 hard mode: the separable binomial (1,2,1)/2 per axis over the 3x3 raw
// window — an exact dyadic k/16 rational for binary taps (f32-exact).
fn hardBinomial(tx: u32, ty: u32) -> f32 {
  let wxN = inRawVisibility[(ty - 1u) * params.width + tx - 1u]
          + 2.0 * inRawVisibility[(ty - 1u) * params.width + tx]
          + inRawVisibility[(ty - 1u) * params.width + tx + 1u];
  let wx = inRawVisibility[ty * params.width + tx - 1u]
         + 2.0 * inRawVisibility[ty * params.width + tx]
         + inRawVisibility[ty * params.width + tx + 1u];
  let wxS = inRawVisibility[(ty + 1u) * params.width + tx - 1u]
          + 2.0 * inRawVisibility[(ty + 1u) * params.width + tx]
          + inRawVisibility[(ty + 1u) * params.width + tx + 1u];
  return (wxN + 2.0 * wx + wxS) / 16.0;
}

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

  if (params.mode == 1u) {
    // ---- #53 HARD MODE: ring-rule binomial edge refinement ----
    // The 1-texel frame border keeps the raw value (no full ring; mirrors
    // the CPU oracle exactly).
    if (tx == 0u || ty == 0u || tx == params.width - 1u || ty == params.height - 1u) {
      outReconstructed[g] = clamp(inRawVisibility[g], 0.0, 1.0);
      return;
    }
    // Ring walk clockwise from west: W, NW, N, NE, E, SE, S, SW.
    var ringDX = array<i32, 8>(-1, -1, 0, 1, 1, 1, 0, -1);
    var ringDY = array<i32, 8>(0, -1, -1, -1, 0, 1, 1, 1);
    var ringSide: array<bool, 8>;
    for (var i = 0; i < 8; i += 1) {
      let nx = i32(tx) + ringDX[i];
      let ny = i32(ty) + ringDY[i];
      ringSide[i] = inRawVisibility[u32(ny) * params.width + u32(nx)] >= 0.5;
    }
    // Count transitions, remembering a canonical start immediately after a
    // transition. The subsequent linear run counts all 8 ring elements once;
    // the cyclic wrap edge is never mistaken for a ninth element.
    var transitions = 0u;
    var start = 0u;
    for (var i = 0u; i < 8u; i += 1u) {
      let previous = ringSide[(i + 7u) % 8u];
      if (ringSide[i] != previous) {
        transitions = transitions + 1u;
        start = i;
      }
    }
    var arcA = 1;
    if (transitions == RING_EDGE_TRANSITIONS) {
      while (arcA < 8 && ringSide[(start + u32(arcA)) % 8u] == ringSide[start]) {
        arcA = arcA + 1;
      }
    }
    let arcB = 8 - arcA;
    let centerSide = inRawVisibility[g] >= 0.5;
    let centerArc = select(arcB, arcA, centerSide == ringSide[start]);
    // 4/4 refines either side. For 3/5, only a center on the majority arc
    // refines; a center on the minority arc is a one-texel tip/spur.
    if (transitions == RING_EDGE_TRANSITIONS &&
        min(arcA, arcB) >= RING_EDGE_MIN_ARC && centerArc >= 8 - centerArc) {
      outReconstructed[g] = clamp(hardBinomial(tx, ty), 0.0, 1.0);
    } else {
      outReconstructed[g] = clamp(inRawVisibility[g], 0.0, 1.0);
    }
    return;
  }

  // ---- #43/#53 SOFT MODE: value-bilateral gated box average ----
  let centerY = inHeight[g];
  let centerOwner = objectId[g];
  let centerVis = inRawVisibility[g];
  let twoSigma2 = 2.0 * params.valueSigma * params.valueSigma;
  // Value-weighted gated box average over the clamped neighborhood, in
  // FIXED row-major declaration order (dy outer -r..+r, dx inner): the
  // exact tap sequence and weight order the CPU oracle accumulates.
  var sum = 0.0;
  var wsum = 0.0;
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
      let dv = inRawVisibility[ng] - centerVis;
      let w = exp(-(dv * dv) / twoSigma2);
      sum = sum + w * inRawVisibility[ng];
      wsum = wsum + w;
    }
  }
  // The center tap always survives its own gates with weight exactly 1, so
  // wsum >= 1; the select keeps the historical taps == 0 fallback shape.
  let vis = select(sum / wsum, centerVis, wsum <= 0.0);
  outReconstructed[g] = clamp(vis, 0.0, 1.0);
}
`;
