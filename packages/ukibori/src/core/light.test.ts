import { describe, expect, it } from "vitest";
import { DEFAULT_LIGHT, LIGHT_PRECISION, isValidVector, normalizeLight } from "./light";
import type { LightVector } from "../types";

const NORMALIZED_DEFAULT = { x: -0.424264, y: -0.565685, z: 0.707107 };

function magnitude(v: LightVector): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

describe("isValidVector", () => {
  it("accepts finite triples and rejects NaN/Infinity/undefined", () => {
    expect(isValidVector({ x: 1, y: 2, z: 3 })).toBe(true);
    expect(isValidVector({ x: NaN, y: 2, z: 3 })).toBe(false);
    expect(isValidVector({ x: 1, y: Infinity, z: 3 })).toBe(false);
    expect(isValidVector({ x: 1, y: 2, z: -Infinity })).toBe(false);
    expect(isValidVector({ x: 1, y: 2, z: undefined } as unknown as LightVector)).toBe(false);
  });
});

describe("normalizeLight", () => {
  it("normalizes a valid vector to unit length preserving direction", () => {
    const result = normalizeLight({ x: -0.6, y: -0.8, z: 1 });
    expect(magnitude(result)).toBeCloseTo(1, 5);
    expect(result).toEqual(NORMALIZED_DEFAULT);
  });

  it("leaves an already-unit vector unchanged", () => {
    expect(normalizeLight({ x: 1, y: 0, z: 0 })).toEqual({ x: 1, y: 0, z: 0 });
    expect(normalizeLight({ x: 0, y: 0, z: -1 })).toEqual({ x: 0, y: 0, z: -1 });
  });

  it("returns normalized DEFAULT_LIGHT for a zero-length vector", () => {
    expect(normalizeLight({ x: 0, y: 0, z: 0 })).toEqual(NORMALIZED_DEFAULT);
  });

  it("falls back for NaN components", () => {
    expect(normalizeLight({ x: NaN, y: 0, z: 1 })).toEqual(NORMALIZED_DEFAULT);
    expect(normalizeLight({ x: 1, y: NaN, z: 1 })).toEqual(NORMALIZED_DEFAULT);
    expect(normalizeLight({ x: 1, y: 1, z: NaN })).toEqual(NORMALIZED_DEFAULT);
  });

  it("falls back for Infinity components", () => {
    expect(normalizeLight({ x: Infinity, y: 0, z: 1 })).toEqual(NORMALIZED_DEFAULT);
    expect(normalizeLight({ x: 1, y: 0, z: -Infinity })).toEqual(NORMALIZED_DEFAULT);
  });

  it("falls back for missing components", () => {
    expect(normalizeLight({ x: 1, y: 0 } as unknown as LightVector)).toEqual(NORMALIZED_DEFAULT);
  });

  it("falls back for extreme components that overflow the length", () => {
    expect(normalizeLight({ x: 1e308, y: 1e308, z: 1e308 })).toEqual(NORMALIZED_DEFAULT);
  });

  it("uses the provided fallback when input is invalid or degenerate", () => {
    const fallback = { x: 0, y: 0, z: 1 };
    expect(normalizeLight({ x: NaN, y: 0, z: 1 }, fallback)).toEqual({ x: 0, y: 0, z: 1 });
    expect(normalizeLight({ x: 0, y: 0, z: 0 }, fallback)).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("ignores a degenerate provided fallback and uses DEFAULT_LIGHT", () => {
    expect(normalizeLight({ x: NaN, y: 0, z: 1 }, { x: 0, y: 0, z: 0 })).toEqual(NORMALIZED_DEFAULT);
  });

  it("does not mutate its inputs", () => {
    const input: LightVector = { x: -0.6, y: -0.8, z: 1 };
    const fallback: LightVector = { x: 0, y: 0, z: 1 };
    const inputSnapshot = { ...input };
    const fallbackSnapshot = { ...fallback };
    normalizeLight(input, fallback);
    expect(input).toEqual(inputSnapshot);
    expect(fallback).toEqual(fallbackSnapshot);
  });

  it("returns a fresh object every call", () => {
    const input = { x: -0.6, y: -0.8, z: 1 };
    const a = normalizeLight(input);
    const b = normalizeLight(input);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    expect(a).not.toBe(input);
  });

  it("is deterministic across calls", () => {
    const input = { x: 3, y: -4, z: 12 };
    expect(normalizeLight(input)).toEqual(normalizeLight(input));
    expect(normalizeLight(input)).toEqual({ x: 0.230769, y: -0.307692, z: 0.923077 });
  });

  it("rounds components to LIGHT_PRECISION decimals", () => {
    const result = normalizeLight({ x: 1, y: 1, z: 1 });
    for (const component of [result.x, result.y, result.z]) {
      const decimals = (String(component).split(".")[1] ?? "").length;
      expect(decimals).toBeLessThanOrEqual(LIGHT_PRECISION);
    }
  });

  it("handles negative components as directions", () => {
    expect(normalizeLight({ x: 0, y: 0, z: -1 })).toEqual({ x: 0, y: 0, z: -1 });
    expect(normalizeLight({ x: -1, y: 0, z: 0 })).toEqual({ x: -1, y: 0, z: 0 });
  });

  it("keeps DEFAULT_LIGHT stable", () => {
    expect(DEFAULT_LIGHT).toEqual({ x: -0.6, y: -0.8, z: 1 });
  });
});
