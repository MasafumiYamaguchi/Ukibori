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
 * The filter is a small cross-bilateral-like box kernel over the RAW field
 * with two deterministic edge gates guided by existing scene geometry:
 *
 * - **height gate** — a neighbor contributes only when its FULL visible
 *   height differs from the center's by at most `RECONSTRUCTION_HEIGHT_GATE`
 *   (f32-rounded comparison on both sides), so smoothing never crosses large
 *   height discontinuities (object silhouettes, steep bevels) and stable
 *   fully-lit / fully-occluded plateaus stay untouched;
 * - **ownership gate** — a neighbor contributes only when its object id
 *   equals the center's (NO_OWNER matches only NO_OWNER), so shadows never
 *   leak through unrelated foreground receivers and receiver/object
 *   boundaries are preserved.
 *
 * All taps share ONE fixed weight; the output is the gated tap average in
 * declaration order, clamped into [0, 1] — finite by construction. The
 * physical penumbra WIDTH stays owned by the #41 ray geometry (caster/
 * receiver separation × angularRadius): this stage is a reconstructor of the
 * sampled field, never the source of the softness, and it never enlarges
 * the footprint beyond `radius` texels.
 *
 * ## Cross-backend parity policy (NOT bit-exact)
 *
 * The reconstruction quotient `sum / tapCount` is NOT dyadic (3/25, 7/49,
 * ...): the CPU reference accumulates in f64 and rounds the quotient to f32
 * once, while the GPU accumulates and divides in f32. Bit-identity must
 * therefore NOT be promised across legal WebGPU backends — the browser
 * parity harness compares the reconstructed field with the SEPARATE
 * documented tight tolerance (`compareReconstructedVisibility`, |diff| <=
 * 1e-6, plus max-abs/max-ULP evidence reporting). RAW #41 visibility keeps
 * its exact dyadic zero-tolerance contract; this stage never weakens it.
 *
 * ## Hard-shadow compatibility
 *
 * Callers bypass reconstruction entirely when the shadow pass ran the hard
 * path (`angularRadius <= 0` or `samples <= 1`) or when
 * `ShadowReconstructionOptions.enabled === false`: the historical {0, 1}
 * visibility flows to lighting/presentation unchanged.
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
 * edge-preservation is DPR-invariant in CSS space.
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
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const centerY = height.get(x, y, 0);
      const centerOwner = objectId !== null ? objectId.get(x, y, 0) : NO_OWNER;
      // Uniform-weight gated box average in fixed row-major order; the f32
      // sum order mirrors the WGSL accumulation exactly.
      let sum = 0;
      let taps = 0;
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
          sum += rawVisibility.get(nx, ny, 0);
          taps += 1;
        }
      }
      const vis = taps > 0 ? sum / taps : rawVisibility.get(x, y, 0);
      out.set(x, y, 0, Math.min(1, Math.max(0, vis)));
    }
  }
  return out;
}
