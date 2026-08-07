import { describe, expect, it } from "vitest";
import {
  MATERIAL_PRESETS,
  resolveMaterial,
  sanitizeMaterial,
  sanitizeMaterialTable,
} from "./material";

describe("sanitizeMaterial", () => {
  it("clamps roughness and metallic to [0, 1]", () => {
    expect(sanitizeMaterial({ baseColor: { r: 0.5, g: 0.5, b: 0.5 }, roughness: 2, metallic: -1 }).roughness).toBe(1);
    expect(sanitizeMaterial({ baseColor: { r: 0.5, g: 0.5, b: 0.5 }, roughness: -1, metallic: 3 }).metallic).toBe(1);
    expect(sanitizeMaterial({ baseColor: { r: 0.5, g: 0.5, b: 0.5 }, roughness: 0.25, metallic: 0.75 }).roughness).toBe(0.25);
  });

  it("falls back to defaults for non-finite values", () => {
    const m = sanitizeMaterial({ baseColor: { r: 0.5, g: 0.5, b: 0.5 }, roughness: NaN, metallic: Infinity });
    expect(m.roughness).toBe(0.5);
    expect(m.metallic).toBe(0);
    expect(m.ior).toBe(1.5);
  });

  it("sanitizes ior (must be >= 1) and clamps baseColor to [0, 1]", () => {
    const m = sanitizeMaterial({ baseColor: { r: -1, g: 0.5, b: NaN }, roughness: 0.5, metallic: 0, ior: 0.5 });
    expect(m.ior).toBe(1.5);
    expect(m.baseColor.r).toBe(0);
    expect(m.baseColor.g).toBe(0.5);
    expect(m.baseColor.b).toBe(0.6);
    const bright = sanitizeMaterial({ baseColor: { r: 2.5, g: 1, b: 0 }, roughness: 0.5, metallic: 0 });
    expect(bright.baseColor.r).toBe(1); // reflectance/albedo is clamped to [0, 1]
  });
});

describe("resolveMaterial", () => {
  it("uses the scene override table before presets", () => {
    const custom = { baseColor: { r: 0.1, g: 0.2, b: 0.3 }, roughness: 0.11, metallic: 0.22 };
    const r = resolveMaterial({ custom }, "custom");
    expect(r.roughness).toBe(0.11);
    const overridden = resolveMaterial({ silicone: custom }, "silicone");
    expect(overridden.roughness).toBe(0.11);
  });

  it("falls back to built-in presets", () => {
    expect(resolveMaterial(undefined, "silicone")).toBe(MATERIAL_PRESETS.silicone);
    expect(resolveMaterial(undefined, "metal").metallic).toBe(1);
  });

  it("throws for unknown references", () => {
    expect(() => resolveMaterial(undefined, "nope")).toThrow(/unknown material "nope"/);
  });
});

describe("sanitizeMaterialTable", () => {
  it("sanitizes every entry and keeps refs", () => {
    const table = sanitizeMaterialTable({
      a: { baseColor: { r: 0.5, g: 0.5, b: 0.5 }, roughness: 5, metallic: -2 },
    });
    expect(table?.["a"].roughness).toBe(1);
    expect(table?.["a"].metallic).toBe(0);
    expect(sanitizeMaterialTable(undefined)).toBeUndefined();
  });
});
