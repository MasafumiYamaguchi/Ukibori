import type { Vec2, Vec3 } from "./types";

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
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
