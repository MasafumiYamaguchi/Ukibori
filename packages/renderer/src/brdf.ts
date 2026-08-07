import { clamp } from "./math";
import { DEFAULT_IOR } from "./material";
import type { Material } from "./material";
import type { LinearRgb } from "./types";

/**
 * #16 BRDF: Cook-Torrance microfacet model (CPU reference — the formulas the
 * WGSL path will mirror).
 *
 *     f = diffuse + specular
 *     specular = D_GGX * V_Smith * F_Schlick
 *     diffuse  = baseColor * (1 - F) * (1 - metallic) * NdotL
 *
 * - NDF: GGX / Trowbridge-Reitz (`alpha = roughness^2`)
 * - Geometry: height-correlated Smith visibility
 *   `V = 0.5 / (GGXV + GGXL)` (includes the 4*NdotV*NdotL denominator)
 * - Fresnel: Schlick; F0 = mix(dielectric IOR F0, baseColor, metallic)
 * - diffuse: energy-conserving (kd = (1 - F) * (1 - metallic)); metals have
 *   no diffuse term
 *
 * All outputs are finite for finite inputs; inputs that fail the
 * NdotL/NdotV > 0 condition yield zero contribution.
 */

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

/** GGX / Trowbridge-Reitz normal distribution function. */
export function dGgx(nDotH: number, roughness: number): number {
  const alpha = roughness * roughness;
  const a2 = alpha * alpha;
  const denom = Math.max(nDotH * nDotH * (a2 - 1) + 1, 1e-7);
  return a2 / (Math.PI * denom * denom);
}

/**
 * Height-correlated Smith visibility (UE4 form). Caller guarantees
 * `nDotL > 0` and `nDotV > 0`; otherwise returns 0.
 */
export function smithGgxVisibility(nDotL: number, nDotV: number, roughness: number): number {
  if (nDotL <= 0 || nDotV <= 0) {
    return 0;
  }
  const a2 = roughness ** 4;
  const gv = nDotL * Math.sqrt(nDotV * nDotV * (1 - a2) + a2);
  const gl = nDotV * Math.sqrt(nDotL * nDotL * (1 - a2) + a2);
  const denom = gv + gl;
  return denom > 0 ? 0.5 / denom : 0;
}

/** Schlick Fresnel, per channel. */
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
  /** baseColor * (1 - F) * (1 - metallic) * NdotL (linear) */
  diffuse: LinearRgb;
  /** D * V * F (linear, already F0-tinted) */
  specular: LinearRgb;
}

export function brdfDirect(
  m: Material,
  nDotL: number,
  nDotV: number,
  nDotH: number,
): BrdfResult {
  const l = Math.max(nDotL, 0);
  const v = Math.max(nDotV, 0);
  const zero: LinearRgb = { r: 0, g: 0, b: 0 };
  if (l <= 0 || v <= 0) {
    return { diffuse: zero, specular: zero };
  }
  const f = fresnelSchlick(v, f0ForMaterial(m));
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
      r: m.baseColor.r * kd.r * l,
      g: m.baseColor.g * kd.g * l,
      b: m.baseColor.b * kd.b * l,
    },
    specular,
  };
}
