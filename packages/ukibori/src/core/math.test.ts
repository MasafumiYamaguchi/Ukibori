import { describe, expect, it } from "vitest";
import { clamp, isFiniteNumber, roundTo, sanitizeNumber } from "./math";

describe("isFiniteNumber", () => {
  it("accepts finite numbers", () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-1.5)).toBe(true);
    expect(isFiniteNumber(Number.MAX_VALUE)).toBe(true);
    expect(isFiniteNumber(-0)).toBe(true);
  });

  it("rejects NaN and infinities", () => {
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(-Infinity)).toBe(false);
  });

  it("rejects non-numbers", () => {
    expect(isFiniteNumber("1" as unknown as number)).toBe(false);
    expect(isFiniteNumber(null as unknown as number)).toBe(false);
    expect(isFiniteNumber(undefined as unknown as number)).toBe(false);
    expect(isFiniteNumber({} as unknown as number)).toBe(false);
  });
});

describe("clamp", () => {
  it("returns the value when inside the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("clamps values above max and below min", () => {
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(1e9, 0, 100)).toBe(100);
  });

  it("propagates NaN (caller must sanitize first)", () => {
    expect(Number.isNaN(clamp(NaN, 0, 10))).toBe(true);
  });
});

describe("roundTo", () => {
  it("rounds to the requested precision", () => {
    expect(roundTo(1.2345, 2)).toBe(1.23);
    expect(roundTo(1.25, 1)).toBe(1.3);
    expect(roundTo(0.125, 2)).toBe(0.13);
    expect(roundTo(12.5, 0)).toBe(13);
  });

  it("rounds negative values with Math.round semantics", () => {
    expect(roundTo(-2.5, 0)).toBe(-2);
    expect(roundTo(-1.2345, 2)).toBe(-1.23);
  });

  it("is deterministic for the same input", () => {
    const a = roundTo(3.141592653589793, 2);
    const b = roundTo(3.141592653589793, 2);
    expect(a).toBe(b);
    expect(a).toBe(3.14);
  });
});

describe("sanitizeNumber", () => {
  it("passes valid in-range values through", () => {
    expect(sanitizeNumber(5, 0, 0, 100)).toBe(5);
    expect(sanitizeNumber(0, 0, 0, 100)).toBe(0);
    expect(sanitizeNumber(100, 0, 0, 100)).toBe(100);
  });

  it("clamps out-of-range values", () => {
    expect(sanitizeNumber(1000, 0, 0, 100)).toBe(100);
    expect(sanitizeNumber(-10, 0, 0, 100)).toBe(0);
  });

  it("falls back on NaN and infinities", () => {
    expect(sanitizeNumber(NaN, 7, 0, 100)).toBe(7);
    expect(sanitizeNumber(Infinity, 7, 0, 100)).toBe(7);
    expect(sanitizeNumber(-Infinity, 7, 0, 100)).toBe(7);
  });

  it("clamps an out-of-range fallback", () => {
    expect(sanitizeNumber(NaN, 1000, 0, 100)).toBe(100);
    expect(sanitizeNumber(NaN, -5, 0, 100)).toBe(0);
  });

  it("uses min when the fallback itself is invalid", () => {
    expect(sanitizeNumber(NaN, NaN, 0, 100)).toBe(0);
    expect(sanitizeNumber(NaN, Infinity, 0, 100)).toBe(0);
  });

  it("always returns a finite result for arbitrary junk input", () => {
    const junk = [NaN, Infinity, -Infinity, 1e308, -1e308, 0, 42, Number.MAX_SAFE_INTEGER];
    for (const value of junk) {
      for (const fallback of junk) {
        const result = sanitizeNumber(value, fallback, 0, 100);
        expect(Number.isFinite(result)).toBe(true);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(100);
      }
    }
  });
});
