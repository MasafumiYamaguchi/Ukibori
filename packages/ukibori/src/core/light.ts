import type { LightVector } from "../types";
import { isFiniteNumber, roundTo } from "./math";

export const DEFAULT_LIGHT: LightVector = { x: -0.6, y: -0.8, z: 1 };

export const LIGHT_PRECISION = 6;

export function isValidVector(light: LightVector): boolean {
  return isFiniteNumber(light.x) && isFiniteNumber(light.y) && isFiniteNumber(light.z);
}

function normalizeRaw(x: number, y: number, z: number): LightVector | null {
  const length = Math.sqrt(x * x + y * y + z * z);
  if (length === 0 || !Number.isFinite(length)) {
    return null;
  }
  return {
    x: roundTo(x / length, LIGHT_PRECISION),
    y: roundTo(y / length, LIGHT_PRECISION),
    z: roundTo(z / length, LIGHT_PRECISION),
  };
}

/**
 * Normalizes a light vector to unit length without mutating any input.
 *
 * Fallback rules (deterministic):
 * - any non-finite component (NaN / Infinity / undefined) -> fallback
 * - zero-length vector -> fallback
 * - fallback itself invalid or degenerate -> normalized DEFAULT_LIGHT
 * - normalized components are rounded to LIGHT_PRECISION decimals
 */
export function normalizeLight(light: LightVector, fallback: LightVector = DEFAULT_LIGHT): LightVector {
  if (isValidVector(light)) {
    const normalized = normalizeRaw(light.x, light.y, light.z);
    if (normalized) {
      return normalized;
    }
  }
  const safeFallback = isValidVector(fallback) ? fallback : DEFAULT_LIGHT;
  const normalizedFallback = normalizeRaw(safeFallback.x, safeFallback.y, safeFallback.z);
  if (normalizedFallback) {
    return normalizedFallback;
  }
  return normalizeRaw(DEFAULT_LIGHT.x, DEFAULT_LIGHT.y, DEFAULT_LIGHT.z) ?? { x: 0, y: 0, z: 1 };
}
