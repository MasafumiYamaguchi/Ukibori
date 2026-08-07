import type { MaterialName } from "../types";
import type { ShadowSpec } from "./shadow";
import { clamp, roundTo } from "./math";

export interface MaterialTokens {
  /** multiplier applied to the spec shadow alpha */
  shadowAlpha: number;
  /** multiplier applied to the spec highlight alpha */
  highlightAlpha: number;
  /** multiplier applied to shadow/highlight blur */
  blurScale: number;
  /** multiplier applied to shadow spread */
  spreadScale: number;
  /** surface translucency: 1 = opaque, <1 = translucent background */
  surfaceAlpha: number;
  /** gloss/veil overlay (CSS background-image) or null */
  backgroundImage: string | null;
  /** border width in px (0 = no border) */
  borderWidth: number;
  /** border color (CSS color) or null */
  borderColor: string | null;
  /** backdrop-filter value or null */
  backdropFilter: string | null;
}

/** Type-safe partial token override for users. */
export type MaterialTokensOverride = Partial<MaterialTokens>;

export const DEFAULT_MATERIAL: MaterialName = "silicone";

/**
 * Restrained, physical-approximation presets. Every material differs in
 * several dimensions: shadow/highlight strength, softness, surface
 * translucency, gloss overlay, border and (for glass) backdrop blur.
 */
export const MATERIAL_PRESETS: Record<MaterialName, MaterialTokens> = {
  silicone: {
    shadowAlpha: 1,
    highlightAlpha: 1,
    blurScale: 1,
    spreadScale: 1,
    surfaceAlpha: 1,
    backgroundImage: null,
    borderWidth: 0,
    borderColor: null,
    backdropFilter: null,
  },
  matte: {
    shadowAlpha: 0.8,
    highlightAlpha: 0.35,
    blurScale: 1.35,
    spreadScale: 0.5,
    surfaceAlpha: 1,
    backgroundImage: null,
    borderWidth: 0,
    borderColor: null,
    backdropFilter: null,
  },
  glass: {
    shadowAlpha: 0.7,
    highlightAlpha: 1.35,
    blurScale: 1.15,
    spreadScale: 0.5,
    surfaceAlpha: 0.38,
    backgroundImage: "linear-gradient(rgba(255,255,255,0.14), rgba(255,255,255,0.14))",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.4)",
    backdropFilter: "blur(10px) saturate(1.15)",
  },
  metal: {
    shadowAlpha: 1.15,
    highlightAlpha: 1.7,
    blurScale: 0.8,
    spreadScale: 1.25,
    surfaceAlpha: 1,
    backgroundImage:
      "linear-gradient(145deg, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0.06) 45%, rgba(255,255,255,0) 70%)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    backdropFilter: null,
  },
};

export function isMaterialName(value: unknown): value is MaterialName {
  return typeof value === "string" && value in MATERIAL_PRESETS;
}

/** Unknown material values are normalized to the silicone default. */
export function normalizeMaterialName(material: unknown): MaterialName {
  return isMaterialName(material) ? material : DEFAULT_MATERIAL;
}

/**
 * Resolves a material name (with optional typed partial overrides) into a
 * full token set. Never throws; unknown names fall back to DEFAULT_MATERIAL.
 */
export function resolveMaterialTokens(
  material: unknown,
  overrides?: MaterialTokensOverride,
): MaterialTokens {
  return { ...MATERIAL_PRESETS[normalizeMaterialName(material)], ...(overrides ?? {}) };
}

/**
 * Applies material multipliers to a shadow spec. Pure and deterministic:
 * alpha values are clamped to [0, 1], px values are rounded to PX_PRECISION.
 * The input spec is not mutated.
 */
export function applyMaterialScales(spec: ShadowSpec, tokens: MaterialTokens): ShadowSpec {
  return {
    ...spec,
    shadowAlpha: roundTo(clamp(spec.shadowAlpha * tokens.shadowAlpha, 0, 1), 3),
    shadowBlur: roundTo(spec.shadowBlur * tokens.blurScale, 2),
    shadowSpread: roundTo(spec.shadowSpread * tokens.spreadScale, 2),
    highlightAlpha: roundTo(clamp(spec.highlightAlpha * tokens.highlightAlpha, 0, 1), 3),
    highlightBlur: roundTo(spec.highlightBlur * tokens.blurScale, 2),
  };
}
