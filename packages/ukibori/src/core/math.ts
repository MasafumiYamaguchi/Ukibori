export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundTo(value: number, precision: number): number {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Returns a finite number within [min, max].
 * - value: used when finite, otherwise fallback is used
 * - fallback: must be finite; if not, min is used
 * The result is always finite and deterministic.
 */
export function sanitizeNumber(value: number, fallback: number, min: number, max: number): number {
  const safeFallback = isFiniteNumber(fallback) ? clamp(fallback, min, max) : min;
  return isFiniteNumber(value) ? clamp(value, min, max) : safeFallback;
}
