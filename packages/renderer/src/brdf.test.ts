import { describe, expect, it } from "vitest";
import {
  GGX_ALPHA_EPS,
  brdfDirect,
  dGgx,
  dielectricF0,
  f0ForMaterial,
  fresnelSchlick,
  smithGgxVisibility,
} from "./brdf";
import { MATERIAL_PRESETS, sanitizeMaterial } from "./material";
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

  it("keeps F0 in [0, 1] for clamped albedo", () => {
    const m = sanitizeMaterial({
      baseColor: { r: 3, g: -2, b: 0.5 },
      roughness: 0.5,
      metallic: 0.7,
    });
    expect(m.baseColor.r).toBe(1);
    expect(m.baseColor.g).toBe(0);
    const f0 = f0ForMaterial(m);
    for (const c of [f0.r, f0.g, f0.b]) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });
});

describe("dGgx", () => {
  it("peaks at nDotH = 1 and is narrower for low roughness", () => {
    const low = dGgx(1, 0.2);
    const high = dGgx(1, 0.9);
    expect(low).toBeGreaterThan(high);
    expect(low).toBeGreaterThan(0);
    expect(dGgx(0.95, 0.2)).toBeLessThan(low);
    expect(dGgx(0.95, 0.9)).toBeGreaterThanOrEqual(0);
  });

  it("regularizes roughness 0: a sharp mirror-like lobe, not a collapse", () => {
    const peak = dGgx(1, 0);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeGreaterThan(dGgx(1, 0.2)); // stronger than any rough lobe
    expect(dGgx(0.95, 0)).toBeLessThan(peak / 100); // extremely narrow
    expect(GGX_ALPHA_EPS).toBeGreaterThan(0);
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
    expect(fresnelSchlick(1, f0).r).toBeCloseTo(0.04, 12);
    expect(fresnelSchlick(0, f0).r).toBeCloseTo(1, 12);
  });

  it("stays in [0, 1] and rises monotonically toward grazing", () => {
    const f0 = f0ForMaterial(dielectric);
    let prev = 0;
    for (const c of [1, 0.8, 0.5, 0.2, 0.01, 0]) {
      const f = fresnelSchlick(c, f0);
      expect(f.r).toBeGreaterThanOrEqual(0);
      expect(f.r).toBeLessThanOrEqual(1);
      expect(f.r).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = f.r;
    }
  });
});

describe("brdfDirect", () => {
  it("uses V·H (not N·V) for the Fresnel angle: specular changes with V·H while N·V is fixed", () => {
    const nDotL = 0.8;
    const nDotV = 0.6; // fixed
    const nDotH = 0.9; // fixed
    const headOn = brdfDirect(dielectric, nDotL, nDotV, nDotH, 1); // F = F0 (small)
    const grazing = brdfDirect(dielectric, nDotL, nDotV, nDotH, 0.2); // F large
    expect(headOn.specular.r).not.toBeCloseTo(grazing.specular.r, 6);
    // Fresnel rises toward grazing: F(V·H = 0.2) > F(V·H = 1)
    expect(grazing.specular.r).toBeGreaterThan(headOn.specular.r);
  });

  it("returns the Lambert diffuse BRDF (1/PI, no cosine) for dielectrics", () => {
    // F0 = 0.04, cos(V·H) = 1 -> F = 0.04; kd = 0.96
    // diffuse = baseColor * kd / PI
    const r = brdfDirect(dielectric, 0.8, 0.9, 0.9, 1);
    expect(r.diffuse.r).toBeCloseTo((0.6 * 0.96) / Math.PI, 10);
    expect(r.diffuse.r).toBeLessThan(0.6); // 1/PI keeps it below the albedo
  });

  it("matches the Cook-Torrance formula D·V·F exactly", () => {
    const nDotL = 0.8;
    const nDotV = 0.9;
    const nDotH = 0.7;
    const nDotVH = 0.95;
    const r = brdfDirect(dielectric, nDotL, nDotV, nDotH, nDotVH);
    const f0 = f0ForMaterial(dielectric);
    const F = fresnelSchlick(nDotVH, f0);
    const D = dGgx(nDotH, dielectric.roughness);
    const V = smithGgxVisibility(nDotL, nDotV, dielectric.roughness);
    expect(r.specular.r).toBeCloseTo(D * V * F.r, 12);
    expect(r.specular.g).toBeCloseTo(D * V * F.g, 12);
  });

  it("has no diffuse term for metals", () => {
    const r = brdfDirect(metal, 0.8, 0.9, 0.95, 0.9);
    expect(r.diffuse.r).toBe(0);
    expect(r.diffuse.g).toBe(0);
    expect(r.specular.r).toBeGreaterThan(0);
  });

  it("has both diffuse and specular for dielectrics", () => {
    const r = brdfDirect(dielectric, 0.8, 0.9, 0.95, 0.9);
    expect(r.diffuse.r).toBeGreaterThan(0);
    expect(r.specular.r).toBeGreaterThan(0);
  });

  it("narrows the highlight with decreasing roughness", () => {
    const glossy: Material = { ...dielectric, roughness: 0.2 };
    const rough: Material = { ...dielectric, roughness: 0.9 };
    const peakGlossy = brdfDirect(glossy, 1, 1, 1, 1).specular.r;
    const peakRough = brdfDirect(rough, 1, 1, 1, 1).specular.r;
    expect(peakGlossy).toBeGreaterThan(peakRough);
  });

  it("keeps diffuse and specular in range for clamped albedo", () => {
    const m = sanitizeMaterial({
      baseColor: { r: 5, g: -1, b: 0.7 },
      roughness: 0.3,
      metallic: 0.5,
      ior: 1.5,
    });
    const r = brdfDirect(m, 0.9, 0.9, 0.9, 0.9);
    for (const c of [r.diffuse.r, r.diffuse.g, r.diffuse.b, r.specular.r, r.specular.g, r.specular.b]) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
    }
    expect(r.diffuse.r).toBeLessThanOrEqual(1 / Math.PI); // kd <= 1, albedo <= 1
  });

  it("returns zero for nDotL or nDotV <= 0", () => {
    const z1 = brdfDirect(dielectric, 0, 1, 1, 1);
    const z2 = brdfDirect(dielectric, 1, 0, 1, 1);
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
    const s = brdfDirect(MATERIAL_PRESETS.silicone, 0.8, 0.9, 0.95, 0.9);
    const m = brdfDirect(MATERIAL_PRESETS.matte, 0.8, 0.9, 0.95, 0.9);
    const me = brdfDirect(MATERIAL_PRESETS.metal, 0.8, 0.9, 0.95, 0.9);
    expect(s.diffuse.r).not.toBeCloseTo(me.diffuse.r, 6); // metal has no diffuse
    expect(s.specular.r).not.toBeCloseTo(m.specular.r, 6); // roughness differs
    expect(s.specular.r).not.toBeCloseTo(me.specular.r, 6);
  });
});
