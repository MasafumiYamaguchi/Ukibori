import type { Vec2, Vec3 } from "./types";

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Overflow-safe saturated addition: `min(a + b, Number.MAX_VALUE)`.
 *
 * Finite inputs whose sum would overflow to +-Infinity are clamped to
 * +-Number.MAX_VALUE instead, so the result is always finite for finite
 * inputs (non-finite inputs pass through unchanged).
 */
export function saturatingAdd(a: number, b: number): number {
  const sum = a + b;
  if (sum > Number.MAX_VALUE) {
    return Number.MAX_VALUE;
  }
  if (sum < -Number.MAX_VALUE) {
    return -Number.MAX_VALUE;
  }
  return sum;
}

/**
 * Overflow-safe saturated multiply: `a * b` clamped to +-Number.MAX_VALUE.
 *
 * Finite inputs whose product would overflow to +-Infinity are clamped to
 * +-Number.MAX_VALUE instead; zero times anything is zero. The result is
 * always finite for finite inputs.
 */
export function saturatingMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  const product = a * b;
  if (Number.isFinite(product)) {
    return product;
  }
  return a < 0 !== b < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isValidVec2(v: unknown): v is Vec2 {
  return (
    typeof v === "object" &&
    v !== null &&
    isFiniteNumber((v as Vec2).x) &&
    isFiniteNumber((v as Vec2).y)
  );
}

export function isValidVec3(v: unknown): v is Vec3 {
  return (
    typeof v === "object" &&
    v !== null &&
    isFiniteNumber((v as Vec3).x) &&
    isFiniteNumber((v as Vec3).y) &&
    isFiniteNumber((v as Vec3).z)
  );
}

/**
 * Normalize a direction vector.
 *
 * Non-finite input and zero-length input fall back to `fallback` (default:
 * +z, pointing at the viewer) so the result is always a finite unit vector.
 */
export function normalizeVec3(v: Vec3, fallback: Vec3 = { x: 0, y: 0, z: 1 }): Vec3 {
  if (!isValidVec3(v)) {
    return { ...fallback };
  }
  const len = Math.hypot(v.x, v.y, v.z);
  if (!(len > 0)) {
    return { ...fallback };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}
