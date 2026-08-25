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
 * ## Hard-shadow compatibility
 *
 * Callers bypass reconstruction entirely when the shadow pass ran the hard
 * path (`angularRadius <= 0` or `samples <= 1`) or when
 * `ShadowReconstructionOptions.enabled === false`: the historical {0, 1}
 * visibility flows to lighting/presentation unchanged.
 *
 * ## Units / DPR contract
 *
 * `radius` is a CSS-pixel (scene-unit) length like every other shadow
 * length. It is converted to INTEGER RENDER TEXELS exactly once —
 * `radiusTexels = min(MAX_RECONSTRUCTION_RADIUS_TEXELS,
 * round(radius * dpr))` — so both backends filter the identical texel
 * neighborhood and the visual result is resolution-independent. The
 * dimensionless gates are never dpr-scaled.
 */

/** Default reconstruction radius (CSS px / scene units). */
export const DEFAULT_RECONSTRUCTION_RADIUS = 2;

/** Largest accepted reconstruction radius (CSS px); larger values clamp. */
export const MAX_RECONSTRUCTION_RADIUS = 4;

/**
 * Hard cap of the effective texel radius after the single dpr conversion:
 * bounds the worst-case tap count ((2r+1)^2 ≤ 289) so the filter cost stays
 * bounded on any device.
 */
export const MAX_RECONSTRUCTION_RADIUS_TEXELS = 8;

/**
 * Height-discontinuity gate (SCENE units): neighbors whose full-height gap
 * exceeds this value are excluded from the average (edge of an object /
 * steep bevel). Fixed constant — deliberately not a public knob (#43 asks
 * for minimal controls).
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
  /** Filter radius in CSS px (scene units); default 2, clamped to [0, 4]. */
  radius?: number;
}

/** Effective (sanitized + f32-packed) reconstruction options actually run. */
export interface ShadowReconstructionEffectiveOptions {
  readonly enabled: boolean;
  /** integer RENDER-texel radius after the single dpr conversion */
  readonly radiusTexels: number;
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
 * `radius` must round (f32) to a finite value >= 0 and clamps into
 * `[0, MAX_RECONSTRUCTION_RADIUS]`; the texel radius is the single dpr
 * conversion `round(radius * dpr)` capped at `MAX_RECONSTRUCTION_RADIUS_
 * TEXELS`. Deterministic pure function — the scheduler's option fingerprint
 * consumes exactly this result.
 */
export function sanitizeReconstructionOptions(
  options: ShadowReconstructionOptions = {},
  dpr = 1,
): ShadowReconstructionEffectiveOptions {
  const enabled = typeof options.enabled === "boolean" ? options.enabled : true;
  let radiusPx = DEFAULT_RECONSTRUCTION_RADIUS;
  if (typeof options.radius === "number" && Number.isFinite(options.radius)) {
    const rounded = Math.fround(options.radius);
    if (Number.isFinite(rounded)) {
      radiusPx = Math.min(MAX_RECONSTRUCTION_RADIUS, Math.max(0, rounded));
    }
  }
  const safeDpr =
    typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const radiusTexels = Math.min(
    MAX_RECONSTRUCTION_RADIUS_TEXELS,
    Math.round(radiusPx * safeDpr),
  );
  return { enabled, radiusTexels };
}

/**
 * Edge-aware reconstruction of the raw #41 visibility field (CPU reference).
 * For every texel the gated box average over the `(2r+1)^2` neighborhood
 * runs in FIXED row-major declaration order with uniform weights, mirroring
 * the WGSL loop exactly (same taps, same gate comparisons, same f32 sum
 * order), so CPU and GPU produce identical reconstructed values.
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
  const { enabled, radiusTexels } = sanitizeReconstructionOptions(reconstruction, options.dpr);
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
  const gate = Math.fround(RECONSTRUCTION_HEIGHT_GATE);
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
