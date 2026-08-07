import { describe, expect, it } from "vitest";
import { clamp, isFiniteNumber, isValidVec3, lerp, normalizeVec3 } from "./math";

describe("clamp", () => {
  it("clamps below min and above max", () => {
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

describe("lerp", () => {
  it("interpolates linearly", () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(2, 4, 0)).toBe(2);
    expect(lerp(2, 4, 1)).toBe(4);
  });
});

describe("isFiniteNumber", () => {
  it("accepts finite numbers only", () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-1.5)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(-Infinity)).toBe(false);
    expect(isFiniteNumber("1")).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
  });
});

describe("isValidVec3", () => {
  it("rejects non-finite components", () => {
    expect(isValidVec3({ x: 0, y: 0, z: 1 })).toBe(true);
    expect(isValidVec3({ x: NaN, y: 0, z: 1 })).toBe(false);
    expect(isValidVec3({ x: 0, y: Infinity, z: 1 })).toBe(false);
    expect(isValidVec3(null)).toBe(false);
    expect(isValidVec3({ x: 0, y: 1 })).toBe(false);
  });
});

describe("normalizeVec3", () => {
  it("normalizes a valid vector to unit length", () => {
    const n = normalizeVec3({ x: 0, y: 0, z: 5 });
    expect(n).toEqual({ x: 0, y: 0, z: 1 });
    const d = Math.hypot(0.6, 0.8, 0.6);
    const m = normalizeVec3({ x: 0.6, y: 0.8, z: 0.6 });
    expect(m.x).toBeCloseTo(0.6 / d, 12);
    expect(m.y).toBeCloseTo(0.8 / d, 12);
    expect(m.z).toBeCloseTo(0.6 / d, 12);
  });

  it("falls back on zero-length and invalid input", () => {
    expect(normalizeVec3({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 1 });
    expect(normalizeVec3({ x: NaN, y: 0, z: 1 })).toEqual({ x: 0, y: 0, z: 1 });
    expect(normalizeVec3({ x: 0, y: 1, z: Infinity })).toEqual({ x: 0, y: 0, z: 1 });
    expect(normalizeVec3({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })).toEqual({
      x: 1,
      y: 0,
      z: 0,
    });
    expect(normalizeVec3({ x: NaN, y: 1, z: 0 }, { x: 1, y: 0, z: 0 })).toEqual({
      x: 1,
      y: 0,
      z: 0,
    });
  });

  it("never returns non-finite values", () => {
    for (const bad of [
      { x: NaN, y: NaN, z: NaN },
      { x: Infinity, y: 0, z: -Infinity },
      { x: 0, y: 0, z: 0 },
    ]) {
      const n = normalizeVec3(bad);
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(Number.isFinite(n.z)).toBe(true);
    }
  });
});
