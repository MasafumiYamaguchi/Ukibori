import { clamp } from "./math";
import { DEFAULT_IOR } from "./material";
import type { Material } from "./material";
import type { LinearRgb } from "./types";

/**
 * #16 BRDF: Cook-Torrance microfacet model (CPU reference — the formulas the
 * WGSL path will mirror).
 *
 * Both BRDFs are evaluated WITHOUT the cosine lighting factor and without
 * light intensity; the lighting pass applies `NdotL * intensity` to each:
 *
 *     diffuse_brdf  = baseColor * (1 - F) * (1 - metallic) / PI   (Lambert)
 *     specular_brdf = D_GGX * V_Smith * F_Schlick                 (Cook-Torrance)
 *     contribution  = NdotL * intensity * (diffuse_brdf + specular_brdf)
 *
 * - NDF: GGX / Trowbridge-Reitz (`alpha = roughness^2`), regularized so
 *   `roughness = 0` keeps a narrow mirror-like lobe instead of collapsing
 * - Geometry: height-correlated Smith visibility
 *   `V = 0.5 / (GGXV + GGXL)` (includes the 4*NdotV*NdotL denominator)
 * - Fresnel: Schlick at `cosTheta = V·H` (== L·H for a half vector);
 *   F0 = mix(dielectric IOR F0, baseColor, metallic)
 * - diffuse: Lambert with 1/PI; metals have no diffuse term
 *   (kd = (1 - F) * (1 - metallic))
 *
 * All outputs are finite for finite inputs; inputs that fail the
 * NdotL/NdotV > 0 condition yield zero contribution.
 */

/** Minimum alpha for the GGX lobe so roughness = 0 stays mirror-like, not zero. */
export const GGX_ALPHA_EPS = 1e-4;

/**
 * Shared regularized GGX alpha for the whole microfacet model. Both `dGgx`
 * and `smithGgxVisibility` use `a2 = ggxAlpha(roughness)^2`, so NDF and
 * geometry describe the SAME microfacet distribution, including at
 * `roughness = 0`.
 */
export function ggxAlpha(roughness: number): number {
  return Math.max(roughness * roughness, GGX_ALPHA_EPS);
}

/** Dielectric F0 derived from IOR: ((ior - 1) / (ior + 1))^2. */
export function dielectricF0(ior: number): number {
  const v = (ior - 1) / (ior + 1);
  return v * v;
}

/** F0 for the metallic workflow: lerp(dielectric F0, baseColor, metallic). */
export function f0ForMaterial(m: Material): LinearRgb {
  const f0d = dielectricF0(m.ior ?? DEFAULT_IOR);
  return {
    r: f0d + (m.baseColor.r - f0d) * m.metallic,
    g: f0d + (m.baseColor.g - f0d) * m.metallic,
    b: f0d + (m.baseColor.b - f0d) * m.metallic,
  };
}

/**
 * GGX / Trowbridge-Reitz normal distribution function.
 *
 * `alpha = ggxAlpha(roughness)`; at roughness 0 the lobe peaks extremely
 * sharply at NdotH = 1 (mirror-like) instead of collapsing to 0.
 */
export function dGgx(nDotH: number, roughness: number): number {
  const a2 = ggxAlpha(roughness) * ggxAlpha(roughness);
  const denom = Math.max(nDotH * nDotH * (a2 - 1) + 1, 1e-7);
  return a2 / (Math.PI * denom * denom);
}

/**
 * Height-correlated Smith visibility (UE4 form), using the SAME regularized
 * alpha as `dGgx`. Returns 0 when either cosine is <= 0.
 */
export function smithGgxVisibility(nDotL: number, nDotV: number, roughness: number): number {
  if (nDotL <= 0 || nDotV <= 0) {
    return 0;
  }
  const a2 = ggxAlpha(roughness) * ggxAlpha(roughness);
  const gv = nDotL * Math.sqrt(nDotV * nDotV * (1 - a2) + a2);
  const gl = nDotV * Math.sqrt(nDotL * nDotL * (1 - a2) + a2);
  const denom = gv + gl;
  return denom > 0 ? 0.5 / denom : 0;
}

/** Schlick Fresnel, per channel, evaluated at cosTheta = V·H (== L·H). */
export function fresnelSchlick(cosTheta: number, f0: LinearRgb): LinearRgb {
  const c = clamp(cosTheta, 0, 1);
  const t = Math.pow(1 - c, 5);
  return {
    r: f0.r + (1 - f0.r) * t,
    g: f0.g + (1 - f0.g) * t,
    b: f0.b + (1 - f0.b) * t,
  };
}

export interface BrdfResult {
  /** Lambert diffuse BRDF: baseColor * (1 - F) * (1 - metallic) / PI (linear) */
  diffuse: LinearRgb;
  /** Cook-Torrance specular BRDF: D * V * F (linear, already F0-tinted) */
  specular: LinearRgb;
}

/**
 * Evaluate both BRDFs at a point. `nDotVH` is `max(V·H, 0)` — the Fresnel
 * angle (equal to `L·H` for a half vector). The caller applies
 * `NdotL * lightIntensity` to both outputs.
 */
export function brdfDirect(
  m: Material,
  nDotL: number,
  nDotV: number,
  nDotH: number,
  nDotVH: number,
): BrdfResult {
  const l = Math.max(nDotL, 0);
  const v = Math.max(nDotV, 0);
  const zero: LinearRgb = { r: 0, g: 0, b: 0 };
  if (l <= 0 || v <= 0) {
    return { diffuse: zero, specular: zero };
  }
  const f = fresnelSchlick(nDotVH, f0ForMaterial(m));
  const d = dGgx(nDotH, m.roughness);
  const vis = smithGgxVisibility(l, v, m.roughness);
  const specular = {
    r: d * vis * f.r,
    g: d * vis * f.g,
    b: d * vis * f.b,
  };
  const kd = {
    r: (1 - f.r) * (1 - m.metallic),
    g: (1 - f.g) * (1 - m.metallic),
    b: (1 - f.b) * (1 - m.metallic),
  };
  return {
    diffuse: {
      r: (m.baseColor.r * kd.r) / Math.PI,
      g: (m.baseColor.g * kd.g) / Math.PI,
      b: (m.baseColor.b * kd.b) / Math.PI,
    },
    specular,
  };
}
