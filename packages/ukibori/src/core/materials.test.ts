import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATERIAL,
  MATERIAL_PRESETS,
  applyMaterialScales,
  isMaterialName,
  normalizeMaterialName,
  resolveMaterialTokens,
  sanitizeMaterialOverrides,
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
      surfaceColor: null,
      backgroundImage: null,
      borderWidth: 0,
      borderColor: null,
      backdropFilter: null,
    });
  });

  it("glass has a fixed translucent surface color, backdrop filter and border", () => {
    const glass = MATERIAL_PRESETS.glass;
    expect(glass.surfaceColor).toContain("rgba(");
    expect(glass.surfaceColor).not.toBeNull();
    expect(glass.backdropFilter).toContain("blur(");
    expect(glass.borderWidth).toBeGreaterThan(0);
    expect(glass.borderColor).not.toBeNull();
    expect(glass.backgroundImage).not.toBeNull();
  });

  it("metal has gloss, border and stronger highlights, no fixed surface color", () => {
    const metal = MATERIAL_PRESETS.metal;
    expect(metal.surfaceColor).toBeNull();
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

  it("rejects prototype-chain names with own-property-only matching", () => {
    for (const protoName of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
      expect(isMaterialName(protoName)).toBe(false);
      expect(normalizeMaterialName(protoName)).toBe(DEFAULT_MATERIAL);
    }
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
    expect(resolved.surfaceColor).toBe(MATERIAL_PRESETS.glass.surfaceColor);
  });

  it("does not mutate the preset table", () => {
    const before = JSON.stringify(MATERIAL_PRESETS.silicone);
    resolveMaterialTokens("silicone", { shadowAlpha: 0.1 });
    expect(JSON.stringify(MATERIAL_PRESETS.silicone)).toBe(before);
  });
});

describe("sanitizeMaterialOverrides", () => {
  it("clamps out-of-range numeric overrides", () => {
    expect(sanitizeMaterialOverrides({ shadowAlpha: 99 })).toEqual({ shadowAlpha: 2 });
    expect(sanitizeMaterialOverrides({ highlightAlpha: -5 })).toEqual({ highlightAlpha: 0 });
    expect(sanitizeMaterialOverrides({ borderWidth: 1e9 })).toEqual({ borderWidth: 100 });
    expect(sanitizeMaterialOverrides({ borderWidth: -3 })).toEqual({ borderWidth: 0 });
  });

  it("drops NaN/Infinity numeric overrides", () => {
    expect(sanitizeMaterialOverrides({ shadowAlpha: NaN })).toEqual({});
    expect(sanitizeMaterialOverrides({ blurScale: Infinity })).toEqual({});
    expect(sanitizeMaterialOverrides({ spreadScale: -Infinity })).toEqual({});
  });

  it("drops wrongly-typed overrides", () => {
    expect(sanitizeMaterialOverrides({ shadowAlpha: "1" })).toEqual({});
    expect(sanitizeMaterialOverrides({ borderWidth: "2px" })).toEqual({});
    expect(sanitizeMaterialOverrides({ backgroundImage: 42 })).toEqual({});
    expect(sanitizeMaterialOverrides({ borderColor: [] })).toEqual({});
    expect(sanitizeMaterialOverrides({ surfaceColor: { color: "red" } })).toEqual({});
    expect(sanitizeMaterialOverrides({ backdropFilter: ["blur(1px)"] })).toEqual({});
  });

  it("keeps valid string and null overrides, drops empty strings", () => {
    expect(sanitizeMaterialOverrides({ surfaceColor: "rgba(1, 2, 3, 0.5)" })).toEqual({
      surfaceColor: "rgba(1, 2, 3, 0.5)",
    });
    expect(sanitizeMaterialOverrides({ backdropFilter: null })).toEqual({ backdropFilter: null });
    expect(sanitizeMaterialOverrides({ borderColor: "" })).toEqual({});
    expect(sanitizeMaterialOverrides({ backgroundImage: "   " })).toEqual({});
  });

  it("ignores non-object overrides entirely", () => {
    for (const junk of [42, "x", true, null, undefined, []]) {
      expect(sanitizeMaterialOverrides(junk)).toEqual({});
    }
  });

  it("never lets non-finite values pass through resolveMaterialTokens", () => {
    const resolved = resolveMaterialTokens("silicone", {
      shadowAlpha: NaN,
      highlightAlpha: Infinity,
      blurScale: -5,
      spreadScale: 1e9,
      borderWidth: "thick",
      backgroundImage: 42,
      surfaceColor: null,
    } as never);
    expect(resolved.shadowAlpha).toBe(1);
    expect(resolved.highlightAlpha).toBe(1);
    expect(resolved.blurScale).toBe(0);
    expect(resolved.spreadScale).toBe(2);
    expect(resolved.borderWidth).toBe(0);
    expect(resolved.backgroundImage).toBeNull();
    expect(resolved.surfaceColor).toBeNull();
    const clamped = resolveMaterialTokens("metal", { shadowAlpha: 99 } as never);
    expect(clamped.shadowAlpha).toBe(2);
  });
});

describe("applyMaterialScales", () => {
  it("scales alpha with clamps and px values with rounding", () => {
    const tokens: MaterialTokens = {
      shadowAlpha: 2,
      highlightAlpha: 2,
      blurScale: 1.5,
      spreadScale: 0.5,
      surfaceColor: null,
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
