import { describe, expect, it } from "vitest";
import { ELEVATION_MAX, INTENSITY_MAX, getShadowSpec } from "./shadow";
import { normalizeLight } from "./light";
import type { ShadowSpec } from "./shadow";
import type { LightVector } from "../types";

const FLAT_LIGHT = normalizeLight({ x: 1, y: 0, z: 0 });

const CANONICAL_RAISED: ShadowSpec = {
  shadowDx: -10,
  shadowDy: 0,
  shadowBlur: 14.4,
  shadowSpread: 1,
  shadowAlpha: 0.3,
  highlightDx: 4,
  highlightDy: 0,
  highlightBlur: 5.4,
  highlightAlpha: 0.4,
};

const CANONICAL_INSET: ShadowSpec = {
  shadowDx: 10,
  shadowDy: 0,
  shadowBlur: 12.24,
  shadowSpread: -0.5,
  shadowAlpha: 0.3,
  highlightDx: -4,
  highlightDy: 0,
  highlightBlur: 4.59,
  highlightAlpha: 0.4,
};

describe("getShadowSpec canonical values (light={1,0,0}, elevation=10, intensity=1)", () => {
  it("derives the expected raised spec", () => {
    expect(getShadowSpec({ light: FLAT_LIGHT, elevation: 10, intensity: 1, variant: "raised" })).toEqual(
      CANONICAL_RAISED,
    );
  });

  it("derives the expected inset spec with inverted directions", () => {
    expect(getShadowSpec({ light: FLAT_LIGHT, elevation: 10, intensity: 1, variant: "inset" })).toEqual(
      CANONICAL_INSET,
    );
  });
});

describe("getShadowSpec direction semantics", () => {
  it("casts the raised shadow away from the light and the highlight toward it", () => {
    const light = normalizeLight({ x: -0.6, y: -0.8, z: 1 });
    const spec = getShadowSpec({ light, elevation: 6, intensity: 1, variant: "raised" });
    expect(spec.shadowDx).toBeGreaterThan(0);
    expect(spec.shadowDy).toBeGreaterThan(0);
    expect(spec.highlightDx).toBeLessThan(0);
    expect(spec.highlightDy).toBeLessThan(0);
    expect(spec.shadowDx).toBeCloseTo(2.55, 2);
    expect(spec.shadowDy).toBeCloseTo(3.39, 2);
  });

  it("puts the inset shadow on the light side and highlight opposite", () => {
    const light = normalizeLight({ x: -0.6, y: -0.8, z: 1 });
    const spec = getShadowSpec({ light, elevation: 6, intensity: 1, variant: "inset" });
    expect(spec.shadowDx).toBeLessThan(0);
    expect(spec.shadowDy).toBeLessThan(0);
    expect(spec.highlightDx).toBeGreaterThan(0);
    expect(spec.highlightDy).toBeGreaterThan(0);
  });

  it("produces zero offsets for overhead light", () => {
    const spec = getShadowSpec({ light: { x: 0, y: 0, z: 1 }, elevation: 10, intensity: 1, variant: "raised" });
    expect(spec.shadowDx).toBe(0);
    expect(spec.shadowDy).toBe(0);
    expect(spec.highlightDx).toBe(0);
    expect(spec.highlightDy).toBe(0);
  });

  it("mirrors offsets when the light direction flips", () => {
    const a = getShadowSpec({ light: { x: 1, y: 0, z: 0 }, elevation: 5, intensity: 1, variant: "raised" });
    const b = getShadowSpec({ light: { x: -1, y: 0, z: 0 }, elevation: 5, intensity: 1, variant: "raised" });
    expect(a.shadowDx).toBe(-b.shadowDx);
    expect(a.highlightDx).toBe(-b.highlightDx);
  });
});

describe("getShadowSpec elevation handling", () => {
  it("returns zero offsets and blur at elevation 0", () => {
    const spec = getShadowSpec({ light: FLAT_LIGHT, elevation: 0, intensity: 1, variant: "raised" });
    expect(spec.shadowDx).toBe(0);
    expect(spec.shadowDy).toBe(0);
    expect(spec.shadowBlur).toBe(0);
    expect(spec.shadowSpread).toBe(0);
    expect(spec.highlightBlur).toBe(0);
  });

  it("treats negative elevation as 0", () => {
    const spec = getShadowSpec({ light: FLAT_LIGHT, elevation: -20, intensity: 1, variant: "raised" });
    expect(spec.shadowBlur).toBe(0);
    expect(spec.shadowDx).toBe(0);
  });

  it("clamps extreme elevation to ELEVATION_MAX", () => {
    for (const elevation of [1000, 1e9, Number.MAX_VALUE, Infinity, -Infinity, NaN]) {
      const spec = getShadowSpec({ light: FLAT_LIGHT, elevation, intensity: 1, variant: "raised" });
      const scale = spec.shadowBlur === 0 ? 0 : ELEVATION_MAX;
      expect(spec.shadowDx).toBe(scale === 0 ? 0 : -scale);
      expect(spec.shadowBlur).toBeLessThanOrEqual(ELEVATION_MAX * 1.2 * 1.2);
    }
    const clamped = getShadowSpec({ light: FLAT_LIGHT, elevation: 1e9, intensity: 1, variant: "raised" });
    expect(clamped).toEqual(getShadowSpec({ light: FLAT_LIGHT, elevation: ELEVATION_MAX, intensity: 1, variant: "raised" }));
  });

  it("scales offsets linearly with elevation", () => {
    const low = getShadowSpec({ light: FLAT_LIGHT, elevation: 4, intensity: 1, variant: "raised" });
    const high = getShadowSpec({ light: FLAT_LIGHT, elevation: 8, intensity: 1, variant: "raised" });
    expect(high.shadowDx).toBe(low.shadowDx * 2);
    expect(high.shadowBlur).toBeCloseTo(low.shadowBlur * 2, 2);
  });
});

describe("getShadowSpec intensity handling", () => {
  it("clamps negative intensity to 0 (invisible shadow, blur remains)", () => {
    const spec = getShadowSpec({ light: FLAT_LIGHT, elevation: 10, intensity: -5, variant: "raised" });
    expect(spec.shadowAlpha).toBe(0);
    expect(spec.highlightAlpha).toBe(0);
    expect(spec.shadowSpread).toBe(0);
    expect(spec.shadowBlur).toBe(9.6);
  });

  it("clamps extreme valid intensity to INTENSITY_MAX", () => {
    for (const intensity of [5, 1e9]) {
      const spec = getShadowSpec({ light: FLAT_LIGHT, elevation: 10, intensity, variant: "raised" });
      expect(spec.shadowAlpha).toBe(0.5);
      expect(spec.highlightAlpha).toBe(0.55);
      expect(spec.shadowBlur).toBe(19.2);
      expect(spec.shadowSpread).toBe(2);
    }
  });

  it("treats NaN/Infinity intensity as invalid and falls back to 1", () => {
    for (const intensity of [NaN, Infinity]) {
      const spec = getShadowSpec({ light: FLAT_LIGHT, elevation: 10, intensity, variant: "raised" });
      expect(spec.shadowAlpha).toBe(0.3);
      expect(spec.highlightAlpha).toBe(0.4);
      expect(spec.shadowBlur).toBe(14.4);
      expect(spec.shadowSpread).toBe(1);
    }
  });

  it("keeps alphas within [0, 1] for all intensities", () => {
    for (const intensity of [0, 0.5, 1, 2, 100, -100, NaN, Infinity]) {
      const spec = getShadowSpec({ light: FLAT_LIGHT, elevation: 10, intensity, variant: "inset" });
      expect(spec.shadowAlpha).toBeGreaterThanOrEqual(0);
      expect(spec.shadowAlpha).toBeLessThanOrEqual(1);
      expect(spec.highlightAlpha).toBeGreaterThanOrEqual(0);
      expect(spec.highlightAlpha).toBeLessThanOrEqual(1);
    }
  });
});

describe("getShadowSpec robustness", () => {
  it("treats an unknown variant as raised", () => {
    const unknown = getShadowSpec({
      light: FLAT_LIGHT,
      elevation: 10,
      intensity: 1,
      variant: "embossed" as never,
    });
    expect(unknown).toEqual(CANONICAL_RAISED);
  });

  it("sanitizes a light vector containing NaN", () => {
    const spec = getShadowSpec({ light: { x: NaN, y: 0, z: 0 }, elevation: 10, intensity: 1, variant: "raised" });
    expect(spec.shadowDx).toBe(0);
    expect(spec.highlightDx).toBe(0);
    expect(Number.isFinite(spec.shadowBlur)).toBe(true);
  });

  it("never mutates the light input", () => {
    const light = normalizeLight({ x: -0.6, y: -0.8, z: 1 });
    const snapshot = { ...light };
    getShadowSpec({ light, elevation: 6, intensity: 1, variant: "raised" });
    getShadowSpec({ light, elevation: 30, intensity: 0.5, variant: "inset" });
    expect(light).toEqual(snapshot);
  });

  it("is deterministic and returns fresh objects", () => {
    const options = { light: FLAT_LIGHT, elevation: 6, intensity: 0.8, variant: "inset" as const };
    const a = getShadowSpec(options);
    const b = getShadowSpec(options);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("always returns finite values within bounds for extreme inputs", () => {
    const lights = [
      { x: NaN, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 1e308, y: 1e308, z: 1e308 },
      { x: 1, y: 1, z: 1 },
    ] as LightVector[];
    for (const light of lights) {
      for (const variant of ["raised", "inset"] as const) {
        const spec = getShadowSpec({ light, elevation: 1e9, intensity: 1e9, variant });
        for (const key of Object.keys(spec) as (keyof ShadowSpec)[]) {
          expect(Number.isFinite(spec[key])).toBe(true);
        }
        expect(spec.shadowBlur).toBeLessThanOrEqual(ELEVATION_MAX * 1.2 * (0.8 + 0.4 * INTENSITY_MAX));
        expect(spec.shadowAlpha).toBeLessThanOrEqual(1);
        expect(spec.shadowDx).toBeGreaterThanOrEqual(-ELEVATION_MAX);
        expect(spec.shadowDx).toBeLessThanOrEqual(ELEVATION_MAX);
      }
    }
  });

  it("rounds every px value to 2 decimals", () => {
    const spec = getShadowSpec({ light: FLAT_LIGHT, elevation: 7, intensity: 1.5, variant: "raised" });
    for (const key of ["shadowDx", "shadowDy", "shadowBlur", "shadowSpread", "highlightDx", "highlightDy", "highlightBlur"] as const) {
      const decimals = (String(spec[key]).split(".")[1] ?? "").length;
      expect(decimals).toBeLessThanOrEqual(2);
    }
  });
});
