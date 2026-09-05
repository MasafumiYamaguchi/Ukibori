import { HostBuffer } from "./buffer";
import { NO_OWNER } from "./compose";
import { VISIBILITY_SPEC } from "./types";

/**
 * #43 edge-aware shadow-visibility reconstruction — the CPU reference for
 * the GPU reconstruction stage (`gpu/reconstruction-pass.ts`).
 *
 * The #41 area-light ray sampling produces a PHYSICALLY meaningful but, at
 * practical sample counts (4/8), noisy raw visibility field: because every
 * texel used the same deterministic kernel orientation, individual sampled
 * silhouettes stayed spatially coherent and read as several offset hard
 * shadows. #43 decorrelates the sampling per texel (kernel variants), which
 * turns that coherence into spatially decorrelated sampling error — and
 * THIS stage reconstructs a smooth penumbra from it.
 *
 * The stage runs in TWO modes over the same raw field (#53 edge quality):
 *
 * ## Soft mode (area-light path) — value-bilateral box kernel
 *
 * A small box kernel over the RAW field with three deterministic gates:
 *
 * - **height gate** — a neighbor contributes only when its FULL visible
 *   height differs from the center's by at most `RECONSTRUCTION_HEIGHT_GATE`
 *   (f32-rounded comparison on both sides), so smoothing never crosses large
 *   height discontinuities (object silhouettes, steep bevels) and stable
 *   fully-lit / fully-occluded plateaus stay untouched;
 * - **ownership gate** — a neighbor contributes only when its object id
 *   equals the center's (NO_OWNER matches only NO_OWNER), so shadows never
 *   leak through unrelated foreground receivers and receiver/object
 *   boundaries are preserved;
 * - **value weight** (#53) — each tap is weighted by
 *   `exp(-(dv * dv) / (2 * sigma^2))` with `dv` the visibility difference to
 *   the center and `sigma = RECONSTRUCTION_VALUE_SIGMA` visibility units.
 *   #53 measured the previous uniform-weight box on real shadow edges: it
 *   averaged ACROSS narrow shadow bands (a 3-texel dark band lost ~62% of
 *   its depth — thin blockers effectively vanished) while a hard value gate
 *   stopped smoothing the decorrelated sampling salt-and-pepper entirely.
 *   The Gaussian weight resolves both: full-range jumps (0 <-> 1, the thin
 *   band edges) get weight ~3e-4 (excluded, bands keep their depth), while
 *   one-to-two sample-level differences (the sampling noise) keep weight
 *   >= 0.6 (the penumbra still smooths). The physical penumbra WIDTH stays
 *   owned by the #41 ray geometry — the measured transition width of the
 *   filtered field stays within one texel of the uniform box (no new
 *   softness).
 *
 * All tap weights are non-negative and the output is the weighted average in
 * declaration order, clamped into [0, 1] — finite by construction.
 *
 * ## Hard mode (single-ray path) — ring-rule binomial edge refinement
 *
 * The historical hard path writes an EXACT binary {0, 1} field and bypassed
 * reconstruction entirely, so diagonal/curved shadow boundaries displayed as
 * a raw texel staircase (#53 primary cause, measured: transition width 0,
 * zero partial levels at every DPR). The hard mode is a PURE POSTPROCESS of
 * the raw field (no extra ray marching, no shadow semantics touched):
 *
 * - a texel is refined ONLY when its 8-neighbor ring shows EXACTLY TWO
 *   visibility-side transitions with BOTH same-side arcs spanning at least
 *   `RING_EDGE_MIN_ARC` ring texels — i.e. exactly one (locally straight)
 *   shadow boundary passes through the 3x3 window;
 * - the refined value is the separable binomial `(1,2,1)/2 (x) (1,2,1)/2`
 *   over the 3x3 raw window — a ~1-2 texel ramp whose 50% crossing stays on
 *   the binary boundary (symmetric kernel, edge position preserved);
 * - everything else is copied VERBATIM: narrow features (arcs < 3 — a
 *   1-2 texel line's texels see a 1-element arc), isolated texels, corners
 *   (4+ ring transitions) and the 1-texel frame border keep the raw value,
 *   so thin blockers and glyph strokes cannot be diluted and silhouette
 *   corners stay crisp.
 *
 * The binomial of binary values is a dyadic k/16 rational, so CPU and GPU
 * refine BIT-IDENTICALLY (zero-tolerance parity, like the raw field) —
 * see the policy table entry added with #53. The raw {0, 1} contract is
 * NOT weakened: the refined field is the DISPLAY representation consumed by
 * lighting/presentation, while the raw field stays available verbatim as
 * the oracle/debug source (pass snapshot + `enabled: false` bypass).
 *
 * ## Cross-backend parity policy (NOT bit-exact in soft mode)
 *
 * The soft-mode weighted quotient `sum(w * v) / sum(w)` is NOT dyadic: the
 * CPU reference accumulates in f64 and rounds the quotient to f32 once,
 * while the GPU accumulates and divides in f32. Bit-identity must therefore
 * NOT be promised across legal WebGPU backends — the browser parity harness
 * compares the reconstructed field with the SEPARATE documented tight
 * tolerance (`compareReconstructedVisibility`, |diff| <= 1e-6, plus
 * max-abs/max-ULP evidence reporting). RAW #41 visibility keeps its exact
 * dyadic zero-tolerance contract; this stage never weakens it. The #53 hard
 * mode is dyadic and keeps a zero-tolerance contract of its own.
 *
 * ## Units / DPR contract (single conversion point)
 *
 * `radius` and `heightGate` are SCENE-UNIT lengths exactly like
 * `stepSize` / `bias` / `maxDistance`: the renderer never knows a display
 * DPR, so the CSS-space policy (defaults, [0, 4] radius clamp) is owned by
 * the DOM layer (`scaleShadowOptions`), which maps CSS px -> scene units ONCE
 * (radius * displayDpr, gate * displayDpr) before the renderer ever sees the
 * options. The renderer converts the scene-unit radius to INTEGER RENDER
 * TEXELS exactly once — `radiusTexels = min(MAX_RECONSTRUCTION_RADIUS_TEXELS,
 * round(radius * dpr))` — so both backends filter the identical texel
 * neighborhood and the visual result is resolution-independent: a 2-CSS-px
 * radius is 2 texels at DPR 1, 3 at DPR 1.5 and 4 at DPR 2, i.e. the same
 * CSS-space footprint at every SUPPORTED display DPR (`[1, 4]`; the texel
 * cap is sized `round(4 CSS px * 4)` = 16 exactly so the public 4-CSS-px
 * maximum keeps its footprint across that whole range — see the cap's own
 * doc for the documented beyond-range degradation). The height gate is
 * scaled the same way (0.5 CSS px -> 0.5 * dpr scene units), so
 * edge-preservation is DPR-invariant in CSS space. The #53 hard mode reads
 * only the 3x3 raw neighborhood (1-texel halo, DPR-independent by
 * construction).
 *
 * Direct (non-DOM) renderer callers pass scene-unit lengths; the documented
 * defaults (radius 2 scene units, gate 0.5 scene units) equal the CSS-space
 * defaults at DPR 1.
 */

/**
 * Default reconstruction radius (scene units; the DOM's CSS-space default has
 * the same numeric value and is scaled once by the display DPR).
 */
export const DEFAULT_RECONSTRUCTION_RADIUS = 2;

/**
 * CSS-space policy maximum of the PUBLIC reconstruction radius (CSS px).
 * Enforced by the DOM layer (`scaleShadowOptions`) — the single place the
 * CSS-space contract lives; the renderer itself never clamps the scene-unit
 * radius (only the texel cost cap below bounds the filter).
 */
export const MAX_RECONSTRUCTION_RADIUS = 4;

/**
 * Hard cap of the effective texel radius after the single dpr conversion.
 * POLICY (high-DPR contract): the DOM public API promises a CLAMPED
 * `[0, MAX_RECONSTRUCTION_RADIUS]` CSS-px radius whose footprint survives
 * every SUPPORTED display DPR, so this cap is
 * `round(MAX_RECONSTRUCTION_RADIUS * 4)` = 16 texels — the documented
 * supported display-DPR range is `[1, 4]` and inside it a 4-CSS-px request
 * keeps its exact 4-CSS-px footprint (`radiusTexels / displayDpr == 4`).
 * BEYOND the supported range the device-texel cost cap wins and silently
 * reduces the effective CSS footprint (e.g. DPR 5 -> 16/5 = 3.2 CSS px);
 * that degradation is deliberate and documented here rather than hidden.
 *
 * The cap bounds the worst-case tap count `((2r+1)^2 <= 1089)` so the filter
 * cost stays bounded on any device; it is the ONLY filter-cost bound (the
 * CSS-space policy clamp lives in the DOM's `scaleShadowOptions`, the single
 * CSS -> scene-unit conversion point).
 */
export const MAX_RECONSTRUCTION_RADIUS_TEXELS = 16;

/** The supported DOM display-DPR range backing the radiusTexels cap above. */
export const SUPPORTED_DISPLAY_DPR_MAX = 4;

/**
 * Default height-discontinuity gate (SCENE units): neighbors whose full-
 * height gap exceeds this value are excluded from the average (edge of an
 * object / steep bevel). The DOM scales the CSS-space default (0.5 CSS px)
 * by the display DPR once, so the gate is DPR-invariant in CSS space.
 */
export const RECONSTRUCTION_HEIGHT_GATE = 0.5;

/**
 * #53 value-space bilateral sigma (VISIBILITY units, soft mode): a tap's
 * weight is `exp(-(dv)^2 / (2 * sigma^2))` for the visibility difference
 * `dv` to the center. Rationale: the decorrelated per-texel sampling noise
 * is mostly within one-to-two sample levels (weight >= 0.6 at sigma 0.25 —
 * still averaged), while a full 0 <-> 1 jump (a thin shadow band's edge)
 * gets weight exp(-8) ~ 3e-4 (effectively excluded — narrow bands keep
 * their depth instead of being averaged away by the uniform box). Constant
 * in samples/DPR/space — the same f32 value is packed into the WGSL
 * params (`valueSigma`) so both backends weigh identically.
 */
export const RECONSTRUCTION_VALUE_SIGMA = 0.25;

/**
 * #53 hard mode: number of visibility-side transitions around the 8-neighbor
 * ring for a texel to be treated as crossing a single (locally straight)
 * shadow boundary. Two transitions = exactly one boundary through the 3x3
 * window; 0 (interior/empty), 4+ (corners, speckle, crossing features) keep
 * the raw value verbatim.
 */
export const RING_EDGE_TRANSITIONS = 2;

/**
 * #53 hard mode: the minimum span (in ring texels) BOTH same-side arcs must
 * have for the boundary to count as a wide-region edge worth refining.
 * Narrower arcs mean a narrow feature (a 1-2 texel line's texels see a
 * 1-2 element arc) — those keep the raw value verbatim so thin blockers
 * cannot be diluted by the binomial ramp.
 */
export const RING_EDGE_MIN_ARC = 3;

/** Public reconstruction controls (#43): deliberately minimal. */
export interface ShadowReconstructionOptions {
  /**
   * Master switch (default TRUE): the reconstructed field is consumed by
   * lighting/presentation whenever the shadow pass ran the SOFT path.
   * `false` (or a hard-path frame) bypasses the stage — the raw #41 field is
   * consumed directly and presentation bytes stay the unfiltered #41 ones.
   */
  enabled?: boolean;
  /**
   * Filter radius in SCENE UNITS (like `stepSize`/`bias`; the DOM maps the
   * public CSS-px value through the display DPR exactly once). Default 2
   * scene units; converted to integer texels once (`round(radius * dpr)`,
   * capped by `MAX_RECONSTRUCTION_RADIUS_TEXELS`).
   */
  radius?: number;
  /**
   * Height-discontinuity edge gate in SCENE UNITS (default 0.5 scene units;
   * the DOM scales the CSS-space default once). Neighbors whose full-height
   * gap exceeds the gate are excluded from the filter average.
   */
  heightGate?: number;
}

/** Effective (sanitized + f32-packed) reconstruction options actually run. */
export interface ShadowReconstructionEffectiveOptions {
  readonly enabled: boolean;
  /** integer RENDER-texel radius after the single dpr conversion */
  readonly radiusTexels: number;
  /** f32-packed scene-unit height gate actually compared */
  readonly heightGate: number;
}

export interface ReconstructVisibilityOptions {
  /**
   * Ownership buffer (u32, NO_OWNER = base plane) from the composed scene;
   * drives the ownership edge gate. Omitted = everything treated as one
   * ownership group (the base-plane-only fixture case).
   */
  objectId?: HostBuffer;
  /**
   * Render extent sampling DPR (default 1): converts the CSS-px radius into
   * render texels exactly once. Must be finite > 0.
   */
  dpr?: number;
}

/**
 * Sanitize the reconstruction options to the effective values both backends
 * run. `enabled` accepts only literal booleans (everything else -> true);
 * `radius` is a SCENE-UNIT length that must round (f32) to a finite value
 * >= 0 (anything else falls back to the default 2 scene units) and is
 * converted to integer texels ONCE (`round(radius * dpr)`, capped at
 * `MAX_RECONSTRUCTION_RADIUS_TEXELS` — the only filter-cost bound; the CSS-
 * space [0, 4] policy clamp lives in the DOM's `scaleShadowOptions`, the
 * single CSS -> scene-unit conversion point); `heightGate` is a scene-unit
 * length sanitized to a finite f32 >= 0 (fallback 0.5 scene units).
 * Deterministic pure function — the scheduler's option fingerprint consumes
 * exactly this result.
 */
export function sanitizeReconstructionOptions(
  options: ShadowReconstructionOptions = {},
  dpr = 1,
): ShadowReconstructionEffectiveOptions {
  const enabled = typeof options.enabled === "boolean" ? options.enabled : true;
  let radius = DEFAULT_RECONSTRUCTION_RADIUS;
  if (typeof options.radius === "number" && Number.isFinite(options.radius)) {
    const rounded = Math.fround(options.radius);
    if (Number.isFinite(rounded)) {
      // negative radii mean "no radius" (bypass, like radius 0); only
      // non-finite values fall back to the scene-unit default
      radius = rounded < 0 ? 0 : rounded;
    }
  }
  const safeDpr =
    typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const radiusTexels = Math.min(
    MAX_RECONSTRUCTION_RADIUS_TEXELS,
    Math.round(radius * safeDpr),
  );
  let heightGate = RECONSTRUCTION_HEIGHT_GATE;
  if (typeof options.heightGate === "number" && Number.isFinite(options.heightGate)) {
    const rounded = Math.fround(options.heightGate);
    if (Number.isFinite(rounded) && rounded >= 0) {
      heightGate = rounded;
    }
  }
  return { enabled, radiusTexels, heightGate };
}

/**
 * Edge-aware reconstruction of the raw #41 visibility field (CPU reference).
 * For every texel the gated box average over the `(2r+1)^2` neighborhood
 * runs in FIXED row-major declaration order with uniform weights, mirroring
 * the WGSL loop tap-for-tap (same taps, same gate comparisons, same f32
 * sum order). The CPU accumulates in f64 and rounds the final quotient to
 * f32 once; the GPU accumulates/divides in f32 — see the module doc for the
 * documented tolerance policy (not bit-exact).
 *
 * The input field is consumed verbatim (no in-place mutation); the output is
 * a fresh `VISIBILITY_SPEC` buffer clamped into [0, 1].
 */
export function reconstructVisibility(
  rawVisibility: HostBuffer,
  height: HostBuffer,
  options: ReconstructVisibilityOptions = {},
  reconstruction: ShadowReconstructionOptions = {},
): HostBuffer {
  const { width, height: h } = rawVisibility.spec;
  const { enabled, radiusTexels, heightGate } = sanitizeReconstructionOptions(
    reconstruction,
    options.dpr,
  );
  const out = new HostBuffer(VISIBILITY_SPEC(width, h));
  if (!enabled || radiusTexels <= 0) {
    // Bypass: copy the raw field verbatim (historical presentation bytes).
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < width; x++) {
        out.set(x, y, 0, rawVisibility.get(x, y, 0));
      }
    }
    return out;
  }
  const objectId = options.objectId ?? null;
  const gate = Math.fround(heightGate);
  // #53 value-bilateral sigma (f32-packed once; the WGSL weighs identically
  // from the same packed params value).
  const sigma = Math.fround(RECONSTRUCTION_VALUE_SIGMA);
  const twoSigma2 = Math.fround(2 * sigma * sigma);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const centerY = height.get(x, y, 0);
      const centerOwner = objectId !== null ? objectId.get(x, y, 0) : NO_OWNER;
      const centerVis = rawVisibility.get(x, y, 0);
      // Value-weighted gated box average in fixed row-major order; the f64
      // accumulators are rounded once at the quotient (the documented
      // tolerance policy).
      let sum = 0;
      let wsum = 0;
      for (let dy = -radiusTexels; dy <= radiusTexels; dy++) {
        const ny = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -radiusTexels; dx <= radiusTexels; dx++) {
          const nx = Math.min(width - 1, Math.max(0, x + dx));
          if (objectId !== null && objectId.get(nx, ny, 0) !== centerOwner) {
            continue;
          }
          const nh = height.get(nx, ny, 0);
          if (Math.abs(Math.fround(centerY - nh)) > gate) {
            continue;
          }
          const dv = rawVisibility.get(nx, ny, 0) - centerVis;
          // exp(-(dv^2) / (2 sigma^2)) in f64; weights are in (0, 1] and the
          // center's own weight is exactly 1, so wsum >= 1 whenever the loop
          // runs at all — no zero-division fallback is needed beyond the
          // radiusTexels <= 0 bypass above.
          const w = Math.exp(-(dv * dv) / twoSigma2);
          sum += w * rawVisibility.get(nx, ny, 0);
          wsum += w;
        }
      }
      const vis = wsum > 0 ? sum / wsum : centerVis;
      out.set(x, y, 0, Math.min(1, Math.max(0, vis)));
    }
  }
  return out;
}

/**
 * #53 hard-mode edge refinement (CPU reference for the same-named WGSL
 * kernel): a PURE postprocess of the raw binary {0, 1} visibility field.
 *
 * A texel whose 8-neighbor ring shows exactly `RING_EDGE_TRANSITIONS`
 * visibility-side transitions with both same-side arcs spanning at least
 * `RING_EDGE_MIN_ARC` ring texels (exactly one locally-straight shadow
 * boundary through the 3x3 window) is refined to the separable binomial
 * `(1,2,1)/2 (x) (1,2,1)/2` of its 3x3 raw window — a ~1-2 texel coverage
 * ramp whose 50% crossing stays on the binary boundary. Every other texel
 * (interiors, narrow features, isolated texels, corners, the 1-texel frame
 * border) keeps the raw value verbatim.
 *
 * The result is a dyadic k/16 rational computed with exact f32 arithmetic
 * (integer sums of 0/1 values) — CPU and GPU agree BIT-IDENTICALLY. The
 * input is consumed verbatim (no in-place mutation); the output is a fresh
 * `VISIBILITY_SPEC` buffer clamped into [0, 1].
 */
export function refineHardEdgeVisibility(rawVisibility: HostBuffer): HostBuffer {
  const { width, height: h } = rawVisibility.spec;
  const out = new HostBuffer(VISIBILITY_SPEC(width, h));
  // Ring walk order: W, NW, N, NE, E, SE, S, SW (clockwise from west).
  const ringDX = [-1, -1, 0, 1, 1, 1, 0, -1];
  const ringDY = [0, -1, -1, -1, 0, 1, 1, 1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const raw = rawVisibility.get(x, y, 0);
      // The 1-texel frame border keeps the raw value (no full ring).
      if (x === 0 || y === 0 || x === width - 1 || y === h - 1) {
        out.set(x, y, 0, raw);
        continue;
      }
      // Collect the 8 ring sides (clockwise from west), then count ring
      // transitions and the same-side arc lengths on the CYCLIC ring.
      const ringSide: boolean[] = [];
      for (let i = 0; i < 8; i++) {
        ringSide.push(rawVisibility.get(x + ringDX[i], y + ringDY[i], 0) >= 0.5);
      }
      let transitions = 0;
      const arcs: number[] = [];
      let run = 1;
      for (let i = 0; i < 8; i++) {
        const next = ringSide[(i + 1) % 8];
        if (next !== ringSide[i]) {
          transitions += 1;
          arcs.push(run);
          run = 1;
        } else {
          run += 1;
        }
      }
      // `run` holds the final arc's length. A wrap continuation of arcs[0]
      // double-counts index 0 exactly once (it is the arc's first element
      // AND the wrap target), hence the -1; without a wrap transition the
      // final run is its own arc and nothing merges.
      arcs[0] += run - (ringSide[7] === ringSide[0] ? 1 : 0);
      const edgeLike =
        transitions === RING_EDGE_TRANSITIONS &&
        arcs.length === RING_EDGE_TRANSITIONS &&
        Math.min(arcs[0], arcs[1]) >= RING_EDGE_MIN_ARC;
      if (!edgeLike) {
        out.set(x, y, 0, raw);
        continue;
      }
      // Separable binomial (1,2,1)/2 per axis — exact dyadic k/16 in f32.
      const wx = rawVisibility.get(x - 1, y, 0) + 2 * raw + rawVisibility.get(x + 1, y, 0);
      const wxN =
        rawVisibility.get(x - 1, y - 1, 0) +
        2 * rawVisibility.get(x, y - 1, 0) +
        rawVisibility.get(x + 1, y - 1, 0);
      const wxS =
        rawVisibility.get(x - 1, y + 1, 0) +
        2 * rawVisibility.get(x, y + 1, 0) +
        rawVisibility.get(x + 1, y + 1, 0);
      out.set(x, y, 0, Math.min(1, Math.max(0, (wxN + 2 * wx + wxS) / 16)));
    }
  }
  return out;
}
