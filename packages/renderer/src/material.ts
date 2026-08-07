import { clamp } from "./math";
import type { LinearRgb } from "./types";

/**
 * #16 material model: physically meaningful BRDF parameters.
 *
 * - `baseColor`: diffuse albedo in LINEAR space (metals use it as F0)
 * - `roughness`: microfacet roughness 0..1 (0 = mirror, 1 = fully rough)
 * - `metallic`: 0 = dielectric, 1 = metal (metallic workflow)
 * - `ior`: dielectric index of refraction; F0 is derived from it (default 1.5)
 *
 * Lighting runs in linear space; sRGB input/output conversion is explicit in
 * the lighting pass. The CSS approximation tokens (shadowAlpha, highlight,
 * gradients...) are deliberately NOT part of this model.
 */
export interface Material {
  baseColor: LinearRgb;
  roughness: number;
  metallic: number;
  ior?: number;
}

/** Material used for the base plane (pixels no surface owns). */
export const BASE_MATERIAL: Material = {
  baseColor: { r: 0.6, g: 0.6, b: 0.6 },
  roughness: 0.5,
  metallic: 0,
};

export const DEFAULT_IOR = 1.5;

/**
 * Built-in BRDF presets. Names are resolution fallbacks for `MaterialRef`
 * when the scene provides no override.
 */
export const MATERIAL_PRESETS: Record<string, Material> = {
  // dielectric, medium roughness, soft broad highlight
  silicone: { baseColor: { r: 0.78, g: 0.8, b: 0.83 }, roughness: 0.4, metallic: 0, ior: 1.45 },
  // dielectric, high roughness, specular subdued
  matte: { baseColor: { r: 0.62, g: 0.62, b: 0.61 }, roughness: 0.9, metallic: 0, ior: 1.5 },
  // metallic, roughness controls the highlight width
  metal: { baseColor: { r: 0.72, g: 0.7, b: 0.68 }, roughness: 0.2, metallic: 1, ior: 1.5 },
};

export function sanitizeMaterial(m: Material): Material {
  return {
    baseColor: {
      r: sanitizeChannel(m.baseColor?.r, 0.6),
      g: sanitizeChannel(m.baseColor?.g, 0.6),
      b: sanitizeChannel(m.baseColor?.b, 0.6),
    },
    roughness: clamp(sanitizeFinite(m.roughness, 0.5), 0, 1),
    metallic: clamp(sanitizeFinite(m.metallic, 0), 0, 1),
    ior: sanitizeIor(m.ior),
  };
}

export function sanitizeMaterialTable(
  materials: Record<string, Material> | undefined,
): Record<string, Material> | undefined {
  if (materials === undefined) {
    return undefined;
  }
  const out: Record<string, Material> = {};
  for (const [ref, material] of Object.entries(materials)) {
    out[ref] = sanitizeMaterial(material);
  }
  return out;
}

/**
 * Resolve a material reference: scene override table first, then built-in
 * presets. Unknown references throw.
 */
export function resolveMaterial(
  materials: Record<string, Material> | undefined,
  ref: string,
): Material {
  const override = materials?.[ref];
  if (override !== undefined) {
    return sanitizeMaterial(override);
  }
  const preset = MATERIAL_PRESETS[ref];
  if (preset !== undefined) {
    return preset;
  }
  throw new Error(`unknown material "${ref}"`);
}

function sanitizeChannel(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return fallback;
  }
  // Reflectance/albedo (and metallic F0): clamp to [0, 1]
  return clamp(v, 0, 1);
}

function sanitizeFinite(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function sanitizeIor(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? v : DEFAULT_IOR;
}
