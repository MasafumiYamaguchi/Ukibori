import { f0ForMaterial } from "./brdf";
import { clamp, saturatingAdd, saturatingMul } from "./math";
import type { Material } from "./material";
import type { LinearRgb } from "./types";
import type { BrdfResult } from "./brdf";

/**
 * #22 environment illumination and exposure — scene/shared image-level
 * controls applied AFTER the direct lighting result, BEFORE sRGB encoding:
 *
 *     linear direct + environment  ->  exposure  ->  sRGB
 *
 * The environment is a SHARED uniform illumination (no HDRI, cubemap or
 * prefiltered map — deliberately out of scope). It is scene-level, not a
 * per-surface brightness multiplier, and it is NOT scaled by cast-shadow
 * visibility: only the DIRECT contribution carries the #17 visibility term.
 *
 * The environment has three scene/shared controls (all independently
 * controllable):
 *
 * - `intensity`: overall environment strength (0 = environment OFF)
 * - `diffuseIntensity`: 0..1 share applied to the diffuse term
 *   (0 = no environment diffuse)
 * - `specularIntensity`: 0..1 share applied to the specular term
 *   (0 = no environment specular — the metal black-drop lift is off)
 *
 * Environment diffuse:
 *
 *     envDiffuse = baseColor * (1 - metallic) * intensity * diffuseIntensity
 *
 * a simple dielectric hemisphere fill scaled by albedo (metals have no
 * diffuse term, matching the #16 metallic workflow).
 *
 * Environment specular:
 *
 *     envSpecular = intensity * (F0 + (1 - F0) * (1 - roughness)^5)
 *                   * specularIntensity
 *
 * Schlick-style mixing from the F0 term (rough surfaces) toward the full
 * uniform environment (smooth surfaces), per channel. This keeps metal out
 * of the black drop outside the direct specular lobe. The formula is a
 * replaceable boundary: a future HDRI/cubemap implementation swaps
 * `evaluateEnvironment` without touching the lighting pass.
 *
 * Exposure policy (explicit, tested):
 *
 * - exposure 0 is valid: the linear result collapses to black (finite)
 * - any very large finite exposure saturates the sRGB clamp to white
 * - NaN, +-Infinity and negative values are INVALID and fall back to 1
 *   (identity), so a bad value never darkens or corrupts the output
 * - `applyExposure` is the explicit pure-function boundary between linear
 *   RGB and sRGB encoding: a future tone mapper replaces it there
 *
 * Environment controls policy (explicit, tested, consistent across the
 * renderer / DOM layer / React layer):
 *
 * - `intensity`: finite and >= 0; 0 is valid (environment OFF), NaN /
 *   +-Infinity / negative fall back to the default (0.5)
 * - `diffuseIntensity` / `specularIntensity`: finite values CLAMP into
 *   [0, 1] — negative values clamp to 0, values above 1 clamp to 1;
 *   NaN / +-Infinity (non-finite) fall back to the default (1). 0 is valid
 *
 * Numeric safety (explicit, tested):
 *
 * The linear stage (accumulation and exposure) uses overflow-safe
 * SATURATED arithmetic (`saturatingAdd` / `saturatingMul`): every permitted
 * finite input — including Number.MAX_VALUE-scale environment intensity and
 * exposure — produces only finite `LinearRgb` values BEFORE the sRGB/u8
 * encoder. Values above 1 are equivalent for the clamped encoder, so the
 * saturation never changes the rendered color, only guarantees finiteness.
 */

export interface EnvironmentLight {
  /** uniform environment illumination intensity, finite and >= 0 (0 = off) */
  intensity: number;
  /** 0..1 share of the environment applied to the diffuse term (default 1;
   * finite values clamp into [0, 1], negative -> 0) */
  diffuseIntensity: number;
  /** 0..1 share of the environment applied to the specular term (default 1;
   * finite values clamp into [0, 1], negative -> 0; 0 = no environment
   * specular) */
  specularIntensity: number;
}

/** Default shared environment intensity (scene default, also the invalid fallback). */
export const DEFAULT_ENVIRONMENT_INTENSITY = 0.5;

/** Default diffuse/specular share (identity; also the invalid fallback). */
export const DEFAULT_ENVIRONMENT_SHARE = 1;

/** Default exposure multiplier (identity; also the invalid fallback). */
export const DEFAULT_EXPOSURE = 1;

/**
 * Sanitize the scene environment. `intensity` must be finite and >= 0;
 * anything else (missing, NaN, Infinity, negative) falls back to the
 * default 0.5. Intensity 0 is preserved (environment OFF). The diffuse and
 * specular shares are finite values clamped into [0, 1] (negative -> 0,
 * above 1 -> 1); NaN / Infinity fall back to the default 1. Share 0 is
 * preserved.
 */
export function sanitizeEnvironment(
  environment: Partial<EnvironmentLight> | undefined,
): EnvironmentLight {
  const intensity = environment?.intensity;
  return {
    intensity:
      typeof intensity === "number" && Number.isFinite(intensity) && intensity >= 0
        ? intensity
        : DEFAULT_ENVIRONMENT_INTENSITY,
    diffuseIntensity: sanitizeShare(environment?.diffuseIntensity),
    specularIntensity: sanitizeShare(environment?.specularIntensity),
  };
}

/**
 * Sanitize the scene exposure. Finite non-negative values are kept
 * (0 = black, very large = saturate to white); NaN / Infinity / negative
 * fall back to the identity 1.
 */
export function sanitizeExposure(exposure: number | undefined): number {
  return typeof exposure === "number" && Number.isFinite(exposure) && exposure >= 0
    ? exposure
    : DEFAULT_EXPOSURE;
}

/**
 * Accumulate the linear lighting result with overflow-safe saturated
 * arithmetic:
 *
 *     linear = baseColor * ambient + direct * (diffuse + specular)
 *              + environment.diffuse + environment.specular
 *
 * All inputs must be finite; the result is always a finite `LinearRgb`
 * (values that would overflow to +-Infinity saturate to +-Number.MAX_VALUE,
 * which the sRGB encoder clamps to white/black anyway). This is the
 * pre-exposure linear accumulation of the lighting pass.
 */
/**
 * Accumulate the full LINEAR result (#22/#45): the DIRECT contribution is
 * per-channel (directional-light RGB color x intensity x visibility x
 * NdotL x BRDF); ambient and environment are independent of the directional
 * light and never tinted by its color. Saturated arithmetic keeps every
 * finite input producing a finite pre-encode LinearRgb.
 */
export function accumulateLinear(
  base: LinearRgb,
  ambient: number,
  direct: LinearRgb,
  brdf: BrdfResult,
  env: EnvironmentResult,
): LinearRgb {
  const channel = (bc: number, dc: number, sc: number, ed: number, es: number, d: number): number =>
    saturatingAdd(
      saturatingAdd(saturatingMul(bc, ambient), saturatingMul(saturatingAdd(dc, sc), d)),
      saturatingAdd(ed, es),
    );
  return {
    r: channel(base.r, brdf.diffuse.r, brdf.specular.r, env.diffuse.r, env.specular.r, direct.r),
    g: channel(base.g, brdf.diffuse.g, brdf.specular.g, env.diffuse.g, env.specular.g, direct.g),
    b: channel(base.b, brdf.diffuse.b, brdf.specular.b, env.diffuse.b, env.specular.b, direct.b),
  };
}

/**
 * Apply the exposure multiplier to a LINEAR RGB result. This is the
 * explicit pure-function boundary before sRGB encoding: the future tone
 * mapper plugs in here. The multiply is overflow-safe saturated
 * arithmetic, so finite inputs always yield a finite `LinearRgb` — even at
 * Number.MAX_VALUE scale — and the result is never NaN/Infinity. Exposure 0
 * yields black; very large finite exposures yield values the sRGB encoder
 * saturates to white.
 */
export function applyExposure(linear: LinearRgb, exposure: number): LinearRgb {
  return {
    r: saturatingMul(linear.r, exposure),
    g: saturatingMul(linear.g, exposure),
    b: saturatingMul(linear.b, exposure),
  };
}

export interface EnvironmentResult {
  /** baseColor-scaled diffuse:
   * `baseColor * (1 - metallic) * intensity * diffuseIntensity` */
  diffuse: LinearRgb;
  /**
   * F0/roughness specular:
   * `intensity * (F0 + (1 - F0) * (1 - roughness)^5) * specularIntensity`
   * per channel
   */
  specular: LinearRgb;
}

/**
 * Evaluate the shared environment at a surface material. Pure and finite
 * for any finite material/light input (material channels are sanitized to
 * [0, 1] and intensity is finite >= 0, so every product stays finite).
 * This is the replaceable seam for a future HDRI/cubemap environment.
 */
export function evaluateEnvironment(m: Material, env: EnvironmentLight): EnvironmentResult {
  const intensity = env.intensity;
  const f0 = f0ForMaterial(m);
  const t = Math.pow(1 - m.roughness, 5);
  const diffuseScale = intensity * env.diffuseIntensity;
  const specularScale = intensity * env.specularIntensity;
  return {
    diffuse: {
      r: m.baseColor.r * (1 - m.metallic) * diffuseScale,
      g: m.baseColor.g * (1 - m.metallic) * diffuseScale,
      b: m.baseColor.b * (1 - m.metallic) * diffuseScale,
    },
    specular: {
      r: specularScale * (f0.r + (1 - f0.r) * t),
      g: specularScale * (f0.g + (1 - f0.g) * t),
      b: specularScale * (f0.b + (1 - f0.b) * t),
    },
  };
}

function sanitizeShare(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v)
    ? clamp(v, 0, 1)
    : DEFAULT_ENVIRONMENT_SHARE;
}
