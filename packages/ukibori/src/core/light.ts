import type { LightVector } from "../types";
import { isFiniteNumber, roundTo } from "./math";

export const DEFAULT_LIGHT: LightVector = { x: -0.6, y: -0.8, z: 1 };

export const LIGHT_PRECISION = 6;

/**
 * Type guard: true only for an object with finite x/y/z components.
 * Never throws: null, undefined, primitives, arrays and partial objects
 * are all rejected safely.
 */
export function isValidVector(value: unknown): value is LightVector {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const vector = value as Record<string, unknown>;
  return isFiniteNumber(vector.x) && isFiniteNumber(vector.y) && isFiniteNumber(vector.z);
}

function normalizeRaw(x: number, y: number, z: number): LightVector | null {
  const length = Math.hypot(x, y, z);
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
 * Fallback rules (deterministic, non-throwing for any runtime input):
 * - any non-finite component (NaN / Infinity / missing / non-number) -> fallback
 * - zero-length vector -> fallback
 * - fallback itself invalid or degenerate -> normalized DEFAULT_LIGHT
 * - huge finite vectors are normalized via Math.hypot so the direction is
 *   preserved even when x^2+y^2+z^2 would overflow
 * - normalized components are rounded to LIGHT_PRECISION decimals
 */
export function normalizeLight(light: unknown, fallback: LightVector = DEFAULT_LIGHT): LightVector {
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
