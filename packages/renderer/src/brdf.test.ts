import { describe, expect, it } from "vitest";
import {
  brdfDirect,
  dGgx,
  dielectricF0,
  f0ForMaterial,
  fresnelSchlick,
  smithGgxVisibility,
} from "./brdf";
import { MATERIAL_PRESETS } from "./material";
import type { Material } from "./material";

const dielectric: Material = {
  baseColor: { r: 0.6, g: 0.6, b: 0.6 },
  roughness: 0.5,
  metallic: 0,
  ior: 1.5,
};

const metal: Material = {
  baseColor: { r: 0.72, g: 0.7, b: 0.68 },
  roughness: 0.2,
  metallic: 1,
};

describe("dielectricF0 / f0ForMaterial", () => {
  it("derives dielectric F0 from IOR", () => {
    expect(dielectricF0(1.5)).toBeCloseTo(0.04, 12);
    expect(dielectricF0(1.0)).toBe(0);
  });

  it("uses IOR-derived F0 for dielectrics and baseColor for metals", () => {
    const d = f0ForMaterial(dielectric);
    expect(d.r).toBeCloseTo(0.04, 12);
    expect(d.g).toBeCloseTo(0.04, 12);
    const m = f0ForMaterial(metal);
    expect(m.r).toBe(metal.baseColor.r);
    expect(m.b).toBe(metal.baseColor.b);
  });
});

describe("dGgx", () => {
  it("peaks at nDotH = 1 and is narrower for low roughness", () => {
    const low = dGgx(1, 0.2);
    const high = dGgx(1, 0.9);
    expect(low).toBeGreaterThan(high);
    expect(low).toBeGreaterThan(0);
    // sharp peak falls off quickly
    expect(dGgx(0.95, 0.2)).toBeLessThan(low);
    expect(dGgx(0.95, 0.9)).toBeGreaterThanOrEqual(0);
  });

  it("is finite for all finite inputs", () => {
    for (const r of [0, 0.1, 0.5, 1]) {
      for (const h of [0, 0.25, 0.5, 0.75, 1]) {
        expect(Number.isFinite(dGgx(h, r))).toBe(true);
      }
    }
  });
});

describe("smithGgxVisibility", () => {
  it("is finite and positive for grazing-to-head-on angles", () => {
    for (const r of [0.05, 0.2, 0.5, 1]) {
      for (const a of [0.05, 0.3, 0.7, 1]) {
        const v = smithGgxVisibility(a, a, r);
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  it("vanishes when either angle is 0", () => {
    expect(smithGgxVisibility(0, 1, 0.5)).toBe(0);
    expect(smithGgxVisibility(1, 0, 0.5)).toBe(0);
  });
});

describe("fresnelSchlick", () => {
  it("returns F0 at normal incidence and 1 at grazing", () => {
    const f0 = f0ForMaterial(dielectric);
    const headOn = fresnelSchlick(1, f0);
    expect(headOn.r).toBeCloseTo(0.04, 12);
    const grazing = fresnelSchlick(0, f0);
    expect(grazing.r).toBeCloseTo(1, 12);
  });
});

describe("brdfDirect", () => {
  it("has no diffuse term for metals", () => {
    const r = brdfDirect(metal, 0.8, 0.9, 0.95);
    expect(r.diffuse.r).toBe(0);
    expect(r.diffuse.g).toBe(0);
    expect(r.specular.r).toBeGreaterThan(0);
  });

  it("has both diffuse and specular for dielectrics", () => {
    const r = brdfDirect(dielectric, 0.8, 0.9, 0.95);
    expect(r.diffuse.r).toBeGreaterThan(0);
    expect(r.specular.r).toBeGreaterThan(0);
  });

  it("narrows the highlight with decreasing roughness", () => {
    const glossy: Material = { ...dielectric, roughness: 0.2 };
    const rough: Material = { ...dielectric, roughness: 0.9 };
    const peakGlossy = brdfDirect(glossy, 1, 1, 1).specular.r;
    const peakRough = brdfDirect(rough, 1, 1, 1).specular.r;
    expect(peakGlossy).toBeGreaterThan(peakRough);
  });

  it("is finite and roughly energy-conserving across a sweep", () => {
    for (const roughness of [0.2, 0.5, 0.9]) {
      for (const angle of [0.1, 0.3, 0.6, 1]) {
        const r = brdfDirect(dielectric, angle, angle, angle);
        expect(Number.isFinite(r.diffuse.r)).toBe(true);
        expect(Number.isFinite(r.specular.r)).toBe(true);
        expect(r.diffuse.r).toBeGreaterThanOrEqual(0);
        expect(r.specular.r).toBeGreaterThanOrEqual(0);
        // loose energy conservation bound: outgoing <= 2 * incoming at LDR scale
        expect(r.diffuse.r + r.specular.r).toBeLessThan(2);
      }
    }
  });

  it("returns zero for nDotL or nDotV <= 0", () => {
    const z1 = brdfDirect(dielectric, 0, 1, 1);
    const z2 = brdfDirect(dielectric, 1, 0, 1);
    expect(z1.diffuse.r).toBe(0);
    expect(z1.specular.r).toBe(0);
    expect(z2.specular.r).toBe(0);
  });
});

describe("presets are BRDF parameters, not CSS tokens", () => {
  it("silicone/matte/metal have the expected parameter structure", () => {
    expect(MATERIAL_PRESETS.silicone.metallic).toBe(0);
    expect(MATERIAL_PRESETS.silicone.ior).toBe(1.45);
    expect(MATERIAL_PRESETS.silicone.roughness).toBeGreaterThan(0);
    expect(MATERIAL_PRESETS.matte.roughness).toBeGreaterThan(MATERIAL_PRESETS.silicone.roughness);
    expect(MATERIAL_PRESETS.matte.metallic).toBe(0);
    expect(MATERIAL_PRESETS.metal.metallic).toBe(1);
    expect(MATERIAL_PRESETS.metal.roughness).toBeGreaterThan(0);
  });

  it("produces visibly different responses for the three presets", () => {
    const s = brdfDirect(MATERIAL_PRESETS.silicone, 0.8, 0.9, 0.95);
    const m = brdfDirect(MATERIAL_PRESETS.matte, 0.8, 0.9, 0.95);
    const me = brdfDirect(MATERIAL_PRESETS.metal, 0.8, 0.9, 0.95);
    expect(s.diffuse.r).not.toBeCloseTo(me.diffuse.r, 6); // metal has no diffuse
    expect(s.specular.r).not.toBeCloseTo(m.specular.r, 6); // roughness differs
    expect(s.specular.r).not.toBeCloseTo(me.specular.r, 6);
  });
});
