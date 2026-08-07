import type { LightVector, Variant } from "../types";
import { clamp, isFiniteNumber, roundTo, sanitizeNumber } from "./math";

export const ELEVATION_MAX = 100;
export const INTENSITY_MAX = 2;
export const RADIUS_MAX = 1000;
export const PX_PRECISION = 2;

export interface ShadowSpec {
  shadowDx: number;
  shadowDy: number;
  shadowBlur: number;
  shadowSpread: number;
  shadowAlpha: number;
  highlightDx: number;
  highlightDy: number;
  highlightBlur: number;
  highlightAlpha: number;
}

export interface ShadowOptions {
  /** Should already be normalized (see normalizeLight). */
  light: LightVector;
  elevation: number;
  intensity: number;
  variant: Variant;
}

/**
 * Derives shadow/highlight offsets, blur, spread and alpha from a normalized
 * light vector, elevation and intensity. Pure, deterministic, never mutates
 * inputs, and always returns finite values.
 *
 * Model (documented approximation):
 * - raised: dark shadow cast away from the light, highlight on the light side
 * - inset:  dark inner shadow on the light side, highlight on the opposite side
 * - offset magnitude scales with elevation and the light's xy components
 * - blur grows with elevation and intensity, but shrinks when light is
 *   overhead (z close to 1): zFactor = 1.2 - 0.6 * z
 * - alpha is derived from intensity and clamped to a subtle range
 */
export function getShadowSpec({ light, elevation, intensity, variant }: ShadowOptions): ShadowSpec {
  const elev = sanitizeNumber(elevation, 0, 0, ELEVATION_MAX);
  const inten = sanitizeNumber(intensity, 1, 0, INTENSITY_MAX);
  const isInset = variant === "inset";

  // A normalized light has components within [-1, 1]; clamp defensively so
  // extreme raw components cannot overflow the px math below.
  const sx = isFiniteNumber(light.x) ? clamp(light.x, -1, 1) : 0;
  const sy = isFiniteNumber(light.y) ? clamp(light.y, -1, 1) : 0;
  const sz = isFiniteNumber(light.z) ? clamp(light.z, 0, 1) : 1;

  const dir = isInset ? 1 : -1;
  const zFactor = 1.2 - 0.6 * sz;
  const insetTighten = isInset ? 0.85 : 1;

  const shadowDx = roundTo(elev * sx * dir, PX_PRECISION);
  const shadowDy = roundTo(elev * sy * dir, PX_PRECISION);
  const shadowBlur = roundTo(elev * zFactor * (0.8 + 0.4 * inten) * insetTighten, PX_PRECISION);
  const shadowSpread = roundTo(elev * 0.1 * inten * (isInset ? -0.5 : 1), PX_PRECISION);
  const shadowAlpha = clamp(0.3 * inten, 0, 0.5);

  const highlightDx = roundTo(elev * sx * dir * -0.4, PX_PRECISION);
  const highlightDy = roundTo(elev * sy * dir * -0.4, PX_PRECISION);
  const highlightBlur = roundTo(elev * zFactor * 0.45 * insetTighten, PX_PRECISION);
  const highlightAlpha = clamp(0.4 * inten, 0, 0.55);

  return {
    shadowDx,
    shadowDy,
    shadowBlur,
    shadowSpread,
    shadowAlpha,
    highlightDx,
    highlightDy,
    highlightBlur,
    highlightAlpha,
  };
}
