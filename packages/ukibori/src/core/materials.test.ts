import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATERIAL,
  MATERIAL_PRESETS,
  applyMaterialScales,
  isMaterialName,
  normalizeMaterialName,
  resolveMaterialTokens,
} from "./materials";
import type { MaterialTokens } from "./materials";
import { getShadowSpec } from "./shadow";

const BASE_SPEC = getShadowSpec({ light: { x: 1, y: 0, z: 0 }, elevation: 10, intensity: 1, variant: "raised" });

describe("material presets", () => {
  it("exposes all four presets", () => {
    expect(Object.keys(MATERIAL_PRESETS).sort()).toEqual(["glass", "matte", "metal", "silicone"]);
  });

  it("gives every preset a materially different token set", () => {
    const names = Object.keys(MATERIAL_PRESETS) as (keyof typeof MATERIAL_PRESETS)[];
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        expect(MATERIAL_PRESETS[names[i]]).not.toEqual(MATERIAL_PRESETS[names[j]]);
      }
    }
  });

  it("silicone is the neutral identity preset", () => {
    expect(MATERIAL_PRESETS.silicone).toEqual({
      shadowAlpha: 1,
      highlightAlpha: 1,
      blurScale: 1,
      spreadScale: 1,
      surfaceAlpha: 1,
      backgroundImage: null,
      borderWidth: 0,
      borderColor: null,
      backdropFilter: null,
    });
  });

  it("glass is translucent with a backdrop filter and border", () => {
    const glass = MATERIAL_PRESETS.glass;
    expect(glass.surfaceAlpha).toBeLessThan(1);
    expect(glass.backdropFilter).toContain("blur(");
    expect(glass.borderWidth).toBeGreaterThan(0);
    expect(glass.borderColor).not.toBeNull();
    expect(glass.backgroundImage).not.toBeNull();
  });

  it("metal has gloss, border and stronger highlights, no translucency", () => {
    const metal = MATERIAL_PRESETS.metal;
    expect(metal.surfaceAlpha).toBe(1);
    expect(metal.backgroundImage).toContain("linear-gradient");
    expect(metal.highlightAlpha).toBeGreaterThan(1);
    expect(metal.backdropFilter).toBeNull();
  });

  it("matte is flatter and softer than silicone", () => {
    const matte = MATERIAL_PRESETS.matte;
    expect(matte.shadowAlpha).toBeLessThan(1);
    expect(matte.highlightAlpha).toBeLessThan(0.5);
    expect(matte.blurScale).toBeGreaterThan(1);
  });
});

describe("material name normalization", () => {
  it("accepts known names", () => {
    expect(isMaterialName("glass")).toBe(true);
    expect(normalizeMaterialName("metal")).toBe("metal");
  });

  it("normalizes unknown values to silicone without throwing", () => {
    for (const junk of ["plastic", "wood", "", 42, null, undefined, {}, [], true]) {
      expect(() => normalizeMaterialName(junk)).not.toThrow();
      expect(normalizeMaterialName(junk)).toBe(DEFAULT_MATERIAL);
      expect(isMaterialName(junk)).toBe(false);
    }
  });
});

describe("resolveMaterialTokens", () => {
  it("resolves each preset to itself", () => {
    for (const name of ["silicone", "matte", "glass", "metal"] as const) {
      expect(resolveMaterialTokens(name)).toEqual(MATERIAL_PRESETS[name]);
    }
  });

  it("falls back to silicone for unknown names", () => {
    expect(resolveMaterialTokens("plastic")).toEqual(MATERIAL_PRESETS.silicone);
    expect(resolveMaterialTokens(undefined)).toEqual(MATERIAL_PRESETS.silicone);
  });

  it("applies partial overrides on top of the preset", () => {
    const resolved = resolveMaterialTokens("silicone", { shadowAlpha: 0.5, borderWidth: 2 });
    expect(resolved.shadowAlpha).toBe(0.5);
    expect(resolved.borderWidth).toBe(2);
    expect(resolved.highlightAlpha).toBe(1);
    expect(resolved.blurScale).toBe(1);
  });

  it("applies overrides on a non-default preset", () => {
    const resolved = resolveMaterialTokens("glass", { backdropFilter: null });
    expect(resolved.backdropFilter).toBeNull();
    expect(resolved.surfaceAlpha).toBe(MATERIAL_PRESETS.glass.surfaceAlpha);
  });

  it("does not mutate the preset table", () => {
    const before = JSON.stringify(MATERIAL_PRESETS.silicone);
    resolveMaterialTokens("silicone", { shadowAlpha: 0.1 });
    expect(JSON.stringify(MATERIAL_PRESETS.silicone)).toBe(before);
  });
});

describe("applyMaterialScales", () => {
  it("scales alpha with clamps and px values with rounding", () => {
    const tokens: MaterialTokens = {
      shadowAlpha: 2,
      highlightAlpha: 2,
      blurScale: 1.5,
      spreadScale: 0.5,
      surfaceAlpha: 1,
      backgroundImage: null,
      borderWidth: 0,
      borderColor: null,
      backdropFilter: null,
    };
    const scaled = applyMaterialScales(BASE_SPEC, tokens);
    expect(scaled.shadowAlpha).toBe(0.6);
    expect(scaled.highlightAlpha).toBe(0.8);
    expect(scaled.shadowBlur).toBe(21.6);
    expect(scaled.shadowSpread).toBe(0.5);
    expect(scaled.shadowDx).toBe(BASE_SPEC.shadowDx);
  });

  it("never mutates the input spec", () => {
    const snapshot = { ...BASE_SPEC };
    applyMaterialScales(BASE_SPEC, MATERIAL_PRESETS.metal);
    expect(BASE_SPEC).toEqual(snapshot);
  });

  it("is deterministic and returns a fresh object", () => {
    const a = applyMaterialScales(BASE_SPEC, MATERIAL_PRESETS.glass);
    const b = applyMaterialScales(BASE_SPEC, MATERIAL_PRESETS.glass);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it("identity scaling leaves the spec unchanged", () => {
    expect(applyMaterialScales(BASE_SPEC, MATERIAL_PRESETS.silicone)).toEqual(BASE_SPEC);
  });
});
