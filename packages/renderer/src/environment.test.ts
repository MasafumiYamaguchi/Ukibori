import { describe, expect, it } from "vitest";
import { HostBuffer, readElement } from "./buffer";
import { brdfDirect } from "./brdf";
import { NO_OWNER } from "./compose";
import { composeSdfHeightField } from "./geometry";
import {
  DEFAULT_ENVIRONMENT_INTENSITY,
  DEFAULT_ENVIRONMENT_SHARE,
  DEFAULT_EXPOSURE,
  accumulateLinear,
  applyExposure,
  evaluateEnvironment,
  sanitizeEnvironment,
  sanitizeExposure,
} from "./environment";
import type { EnvironmentLight } from "./environment";
import { BASE_MATERIAL, resolveMaterial } from "./material";
import { lightScene, shadeHeightField } from "./lighting";
import { createScene } from "./scene";
import type { Scene } from "./scene";
import type { LinearRgb } from "./types";

/** Full environment fixture: intensity with identity diffuse/specular shares. */
function env(intensity: number, shares: Partial<EnvironmentLight> = {}): EnvironmentLight {
  return {
    intensity,
    diffuseIntensity: shares.diffuseIntensity ?? 1,
    specularIntensity: shares.specularIntensity ?? 1,
  };
}

function heightFrom(values: number[][], width: number, height: number): HostBuffer {
  const buf = new HostBuffer({ width, height, channels: 1, format: "f32" });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      buf.set(x, y, 0, values[y][x]);
    }
  }
  return buf;
}

function noOwnerObjectId(width: number, height: number): HostBuffer {
  const buf = new HostBuffer({ width, height, channels: 1, format: "u32" });
  buf.fill(NO_OWNER);
  return buf;
}

/** Test-side replica of the renderer's sRGB encoder (encoding boundary). */
function srgbEncodeChannel(v: number): number {
  const c = v < 0 ? 0 : v > 1 ? 1 : v;
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

const bevel = { kind: "bevel" } as const;

function buttonScene(light: { x: number; y: number }): Scene {
  return createScene({
    width: 16,
    height: 16,
    surfaces: [
      {
        id: "btn",
        position: { x: 3, y: 3 },
        size: { x: 10, y: 10 },
        elevation: 0,
        thickness: 2,
        bevelWidth: 2,
        shape: { kind: "roundedRect", radius: 2 },
        profile: bevel,
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: { direction: { x: light.x, y: light.y, z: 1 }, intensity: 1 },
  });
}

function raisedButtonScene(light: { x: number; y: number }): Scene {
  return createScene({
    width: 16,
    height: 16,
    surfaces: [
      {
        id: "btn",
        position: { x: 3, y: 3 },
        size: { x: 10, y: 10 },
        elevation: 4,
        thickness: 2,
        bevelWidth: 2,
        shape: { kind: "roundedRect", radius: 2 },
        profile: bevel,
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: { direction: { x: light.x, y: light.y, z: 1 }, intensity: 1 },
  });
}

function materialScene(material: string): Scene {
  return createScene({
    ...buttonScene({ x: -0.6, y: -0.8 }),
    surfaces: [{ ...buttonScene({ x: 0, y: 0 }).surfaces[0], material }],
  });
}

function lum(c: { r: number; g: number; b: number }): number {
  return (c.r + c.g + c.b) / 3;
}

const PLATEAU = { x: 8, y: 8 }; // flat interior pixel of the 10x10 button at (3,3)

describe("sanitizeEnvironment / sanitizeExposure policy", () => {
  it("keeps finite non-negative environment intensity, preserves 0 (OFF)", () => {
    expect(sanitizeEnvironment({ intensity: 0 }).intensity).toBe(0);
    expect(sanitizeEnvironment({ intensity: 2.5 }).intensity).toBe(2.5);
    expect(sanitizeEnvironment(undefined).intensity).toBe(DEFAULT_ENVIRONMENT_INTENSITY);
    expect(sanitizeEnvironment({}).intensity).toBe(DEFAULT_ENVIRONMENT_INTENSITY);
  });

  it("falls back to the default for NaN, Infinity and negative environment intensity", () => {
    for (const intensity of [NaN, Infinity, -Infinity, -1, -0.5]) {
      expect(sanitizeEnvironment({ intensity }).intensity).toBe(DEFAULT_ENVIRONMENT_INTENSITY);
    }
  });

  it("keeps finite diffuse/specular shares in [0, 1], preserving 0", () => {
    expect(sanitizeEnvironment({ intensity: 1 }).diffuseIntensity).toBe(DEFAULT_ENVIRONMENT_SHARE);
    expect(sanitizeEnvironment({ intensity: 1 }).specularIntensity).toBe(DEFAULT_ENVIRONMENT_SHARE);
    expect(
      sanitizeEnvironment({ intensity: 1, diffuseIntensity: 0, specularIntensity: 0 }).diffuseIntensity,
    ).toBe(0);
    expect(
      sanitizeEnvironment({ intensity: 1, diffuseIntensity: 0, specularIntensity: 0 }).specularIntensity,
    ).toBe(0);
    expect(
      sanitizeEnvironment({ intensity: 1, diffuseIntensity: 0.25, specularIntensity: 0.75 }).specularIntensity,
    ).toBe(0.75);
  });

  it("clamps finite shares into [0, 1] and falls back for non-finite values", () => {
    const sanitized = sanitizeEnvironment({ intensity: 1, diffuseIntensity: 5, specularIntensity: -2 });
    expect(sanitized.diffuseIntensity).toBe(1);
    expect(sanitized.specularIntensity).toBe(0);
    // Unified policy: finite shares clamp into [0, 1] (negative -> 0, above
    // 1 -> 1); non-finite (NaN / +-Infinity) fall back to the default 1.
    const clamped = sanitizeEnvironment({ intensity: 1, diffuseIntensity: -0.5, specularIntensity: -0.5 });
    expect(clamped.diffuseIntensity).toBe(0);
    expect(clamped.specularIntensity).toBe(0);
    for (const share of [NaN, Infinity, -Infinity]) {
      const s = sanitizeEnvironment({ intensity: 1, diffuseIntensity: share, specularIntensity: share });
      expect(s.diffuseIntensity).toBe(DEFAULT_ENVIRONMENT_SHARE);
      expect(s.specularIntensity).toBe(DEFAULT_ENVIRONMENT_SHARE);
    }
  });

  it("keeps finite non-negative exposure, preserves 0 (black)", () => {
    expect(sanitizeExposure(0)).toBe(0);
    expect(sanitizeExposure(2.5)).toBe(2.5);
    expect(sanitizeExposure(1e300)).toBe(1e300);
    expect(sanitizeExposure(undefined)).toBe(DEFAULT_EXPOSURE);
  });

  it("falls back to identity 1 for NaN, Infinity and negative exposure", () => {
    for (const exposure of [NaN, Infinity, -Infinity, -1, -0.5]) {
      expect(sanitizeExposure(exposure)).toBe(DEFAULT_EXPOSURE);
    }
  });
});

describe("applyExposure — the linear -> sRGB boundary function", () => {
  it("is the identity at exposure 1 and scales linearly otherwise", () => {
    expect(applyExposure({ r: 0.2, g: 0.4, b: 0.6 }, 1)).toEqual({ r: 0.2, g: 0.4, b: 0.6 });
    expect(applyExposure({ r: 0.2, g: 0.4, b: 0.6 }, 2)).toEqual({ r: 0.4, g: 0.8, b: 1.2 });
    expect(applyExposure({ r: 0.2, g: 0.4, b: 0.6 }, 0)).toEqual({ r: 0, g: 0, b: 0 });
    expect(applyExposure({ r: 0.2, g: 0.4, b: 0.6 }, 1e300)).toEqual({
      r: 2e299,
      g: 4e299,
      b: 6e299,
    });
  });

  it("never clamps: the sRGB encoder saturates large finite results to white", () => {
    const out = applyExposure({ r: 2, g: 3, b: 4 }, 1e300);
    expect(Number.isFinite(out.r)).toBe(true);
    expect(out.r).toBeGreaterThan(1);
    expect(srgbEncodeChannel(out.r)).toBe(255);
  });
});

describe("saturated linear stage (pre-encode finiteness)", () => {
  it("accumulates finite LinearRgb at Number.MAX_VALUE environment scale", () => {
    // roughness 0 dielectric: BOTH environment terms sit at MAX scale
    // (diffuse = baseColor * MAX, specular = MAX * (F0 + (1 - F0) * 1) = MAX),
    // and the direct term is the maximum permitted light intensity.
    const material = { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 0, metallic: 0, ior: 1.5 };
    const envResult = evaluateEnvironment(material, env(Number.MAX_VALUE));
    expect(envResult.diffuse.r).toBeGreaterThan(Number.MAX_VALUE * 0.5);
    expect(envResult.specular.r).toBeGreaterThan(Number.MAX_VALUE * 0.5);
    // #45: the direct term is per-channel (linear-RGB directional-light
    // color x intensity x NdotL x visibility); MAX intensity in every
    // channel exercises the saturation boundary the same way.
    const brdf = brdfDirect(material, 1, 1, 1, 1);
    const linear = accumulateLinear(
      material.baseColor,
      0.08,
      { r: Number.MAX_VALUE, g: Number.MAX_VALUE, b: Number.MAX_VALUE },
      brdf,
      envResult,
    );
    for (const c of [linear.r, linear.g, linear.b]) {
      expect(Number.isFinite(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(0);
    }
    // The multi-term accumulation genuinely overflowed without saturation:
    // the sum of the two env terms alone exceeds the double range.
    expect(envResult.diffuse.r + envResult.specular.r).toBe(Infinity);
  });

  it("keeps the exposure boundary finite at Number.MAX_VALUE scale and with exposure 0", () => {
    const linear: LinearRgb = { r: Number.MAX_VALUE, g: 1.5e308, b: 1e300 };
    const exposed = applyExposure(linear, Number.MAX_VALUE);
    expect(Number.isFinite(exposed.r)).toBe(true);
    expect(Number.isFinite(exposed.g)).toBe(true);
    expect(Number.isFinite(exposed.b)).toBe(true);
    expect(exposed.r).toBe(Number.MAX_VALUE);
    // exposure 0 combination: black and finite even at MAX scale
    const zero = applyExposure(linear, 0);
    expect(zero).toEqual({ r: 0, g: 0, b: 0 });
    expect(Number.isFinite(zero.r)).toBe(true);
  });

  it("renders finite u8 output at Number.MAX_VALUE environment intensity and exposure", () => {
    const scene = createScene({
      ...buttonScene({ x: -0.6, y: -0.8 }),
      environment: { intensity: Number.MAX_VALUE },
      exposure: Number.MAX_VALUE,
    });
    const { color } = lightScene(scene);
    for (let y = 0; y < color.spec.height; y++) {
      for (let x = 0; x < color.spec.width; x++) {
        for (let c = 0; c < 4; c++) {
          const v = color.get(x, y, c);
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
      }
    }
    // The linear stage saturated: everything encodes to white (exposure MAX
    // on a lit scene), never NaN/Infinity.
    expect(color.get(8, 8, 0)).toBe(255);
  });

  it("exposure 0 with Number.MAX_VALUE environment intensity stays black and finite", () => {
    const scene = createScene({
      ...buttonScene({ x: -0.6, y: -0.8 }),
      environment: { intensity: Number.MAX_VALUE },
      exposure: 0,
    });
    const { color } = lightScene(scene);
    for (let y = 0; y < color.spec.height; y++) {
      for (let x = 0; x < color.spec.width; x++) {
        expect(color.get(x, y, 0)).toBe(0);
        expect(color.get(x, y, 1)).toBe(0);
        expect(color.get(x, y, 2)).toBe(0);
        expect(color.get(x, y, 3)).toBe(255);
      }
    }
  });
});

describe("evaluateEnvironment", () => {
  it("gives dielectrics a baseColor-scaled diffuse and metals no diffuse", () => {
    const silicone = resolveMaterial(undefined, "silicone");
    const metal = resolveMaterial(undefined, "metal");
    const dielectric = evaluateEnvironment(silicone, env(0.5));
    expect(dielectric.diffuse.r).toBeCloseTo(silicone.baseColor.r * 0.5, 12);
    expect(dielectric.diffuse.g).toBeCloseTo(silicone.baseColor.g * 0.5, 12);
    const metalResult = evaluateEnvironment(metal, env(0.5));
    expect(metalResult.diffuse.r).toBe(0);
    expect(metalResult.diffuse.g).toBe(0);
    expect(metalResult.diffuse.b).toBe(0);
  });

  it("scales specular by F0 and roughness: metal is bright, matte is subdued", () => {
    const metal = evaluateEnvironment(resolveMaterial(undefined, "metal"), env(0.5));
    const matte = evaluateEnvironment(resolveMaterial(undefined, "matte"), env(0.5));
    // metal F0 = baseColor (0.72): spec stays high outside the direct lobe
    expect(metal.specular.r).toBeGreaterThan(0.3);
    // matte (roughness 0.9): spec collapses toward its tiny F0 (0.04)
    expect(matte.specular.r).toBeLessThan(0.1);
  });

  it("is zero when the environment is off", () => {
    for (const m of ["silicone", "matte", "metal"]) {
      const result = evaluateEnvironment(resolveMaterial(undefined, m), env(0));
      expect(result.diffuse.r).toBe(0);
      expect(result.specular.r).toBe(0);
    }
  });

  it("independently controls diffuse and specular through their shares", () => {
    const silicone = resolveMaterial(undefined, "silicone");
    // diffuse share 0: no environment diffuse, specular unaffected
    const noDiffuse = evaluateEnvironment(silicone, env(0.5, { diffuseIntensity: 0 }));
    expect(noDiffuse.diffuse.r).toBe(0);
    expect(noDiffuse.diffuse.g).toBe(0);
    expect(noDiffuse.specular.r).toBeGreaterThan(0);
    // specular share 0: no environment specular, diffuse unaffected
    const noSpecular = evaluateEnvironment(silicone, env(0.5, { specularIntensity: 0 }));
    expect(noSpecular.specular.r).toBe(0);
    expect(noSpecular.specular.g).toBe(0);
    expect(noSpecular.diffuse.r).toBeGreaterThan(0);
    // full shares equal the unscaled reference
    const full = evaluateEnvironment(silicone, env(0.5));
    const ref = evaluateEnvironment(silicone, { intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 });
    expect(full.diffuse.r).toBe(ref.diffuse.r);
    expect(full.specular.r).toBe(ref.specular.r);
    // shares scale linearly with intensity
    const half = evaluateEnvironment(silicone, env(1, { diffuseIntensity: 0.25, specularIntensity: 0.5 }));
    const whole = evaluateEnvironment(silicone, env(1));
    expect(half.diffuse.r).toBeCloseTo(whole.diffuse.r * 0.25, 12);
    expect(half.specular.r).toBeCloseTo(whole.specular.r * 0.5, 12);
  });

  it("stays finite at roughness/metallic extremes and zero specular share", () => {
    const materials = [
      { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 0, metallic: 0 },
      { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 1, metallic: 1 },
    ];
    for (const m of materials) {
      for (const e of [
        env(1e300),
        env(0),
        env(1e300, { specularIntensity: 0, diffuseIntensity: 0 }),
      ]) {
        const result = evaluateEnvironment(m, e);
        expect(Number.isFinite(result.diffuse.r)).toBe(true);
        expect(Number.isFinite(result.specular.r)).toBe(true);
      }
    }
  });
});

describe("exposure in the lighting pass", () => {
  it("exposure 0 produces finite black output", () => {
    const scene = createScene({ ...buttonScene({ x: -0.6, y: -0.8 }), exposure: 0 });
    const { color } = lightScene(scene);
    for (let y = 0; y < color.spec.height; y++) {
      for (let x = 0; x < color.spec.width; x++) {
        expect(color.get(x, y, 0)).toBe(0);
        expect(color.get(x, y, 1)).toBe(0);
        expect(color.get(x, y, 2)).toBe(0);
        expect(color.get(x, y, 3)).toBe(255);
      }
    }
  });

  it("a very large finite exposure saturates to white without NaN/Infinity", () => {
    const scene = createScene({ ...buttonScene({ x: -0.6, y: -0.8 }), exposure: 1e300 });
    const { color } = lightScene(scene);
    for (let y = 0; y < color.spec.height; y++) {
      for (let x = 0; x < color.spec.width; x++) {
        expect(color.get(x, y, 0)).toBe(255);
        expect(color.get(x, y, 1)).toBe(255);
        expect(color.get(x, y, 2)).toBe(255);
        expect(color.get(x, y, 3)).toBe(255);
      }
    }
  });

  it("invalid exposure values (NaN, Infinity, negative) fall back to identity 1", () => {
    const reference = lightScene(buttonScene({ x: -0.6, y: -0.8 })).color;
    for (const exposure of [NaN, Infinity, -Infinity, -2]) {
      const scene = createScene({ ...buttonScene({ x: -0.6, y: -0.8 }), exposure });
      const { color } = lightScene(scene);
      expect(Array.from(color.data)).toEqual(Array.from(reference.data));
    }
  });

  it("is monotonic: low exposure < default < high exposure at a fixed pixel", () => {
    const colorAt = (exposure: number) =>
      lightScene(createScene({ ...buttonScene({ x: -0.6, y: -0.8 }), exposure })).color;
    const low = colorAt(0.25).get(PLATEAU.x, PLATEAU.y, 0);
    const def = colorAt(1).get(PLATEAU.x, PLATEAU.y, 0);
    const high = colorAt(4).get(PLATEAU.x, PLATEAU.y, 0);
    expect(low).toBeLessThan(def);
    expect(def).toBeLessThan(high);
    expect(high).toBe(255); // exposure 4 saturates the lit plateau
  });

  it("applies exposure to the LINEAR result BEFORE sRGB encoding (exact boundary)", () => {
    // Flat base-plane pixel (BASE_MATERIAL): light straight down, ambient
    // 0.08, environment intensity 0.5, identity shares. Reconstruct the
    // documented pipeline from the exported primitives and assert the
    // emitted byte equals encode(applyExposure(linear)) exactly — proving
    // the exposure boundary sits between linear RGB and the sRGB encoder.
    const flat = heightFrom(
      Array.from({ length: 4 }, () => Array(4).fill(0)),
      4,
      4,
    );
    const m = BASE_MATERIAL;
    const brdf = brdfDirect(m, 1, 1, 1, 1); // NdotL = NdotV = NdotH = VdotH = 1
    const envResult = evaluateEnvironment(m, env(0.5));
    const linear = {
      r:
        m.baseColor.r * 0.08 +
        (brdf.diffuse.r + brdf.specular.r) +
        envResult.diffuse.r +
        envResult.specular.r,
      g:
        m.baseColor.g * 0.08 +
        (brdf.diffuse.g + brdf.specular.g) +
        envResult.diffuse.g +
        envResult.specular.g,
      b:
        m.baseColor.b * 0.08 +
        (brdf.diffuse.b + brdf.specular.b) +
        envResult.diffuse.b +
        envResult.specular.b,
    };
    for (const exposure of [1, 1.5, 0.25]) {
      const scene = createScene({
        width: 4,
        height: 4,
        light: { direction: { x: 0, y: 0, z: 1 }, intensity: 1 },
        environment: { intensity: 0.5 },
        exposure,
      });
      const { color } = shadeHeightField(scene, { height: flat, objectId: noOwnerObjectId(4, 4) });
      const exposed = applyExposure(linear, exposure);
      const expectedR = srgbEncodeChannel(exposed.r);
      const expectedG = srgbEncodeChannel(exposed.g);
      const expectedB = srgbEncodeChannel(exposed.b);
      expect(color.get(1, 1, 0)).toBe(expectedR);
      expect(color.get(1, 1, 1)).toBe(expectedG);
      expect(color.get(1, 1, 2)).toBe(expectedB);
      // Exposure applied BEFORE encoding: at 1.5 the encoded value is a
      // nonlinear read of linear*1.5 (247-class), NOT the clamp of
      // encode(linear)*1.5 (which would saturate to 255).
      if (exposure === 1.5) {
        expect(expectedR).toBeLessThan(255);
        expect(expectedR * 2).toBeGreaterThan(255);
      }
    }
  });
});

describe("environment in the lighting pass", () => {
  it("environment OFF keeps the pre-#22 dark response (ambient + direct only)", () => {
    const off = lightScene(
      createScene({ ...buttonScene({ x: -0.6, y: -0.8 }), environment: { intensity: 0 } }),
    ).color;
    const on = lightScene(
      createScene({ ...buttonScene({ x: -0.6, y: -0.8 }), environment: { intensity: 0.5 } }),
    ).color;
    const lumAt = (buf: HostBuffer) =>
      (buf.get(PLATEAU.x, PLATEAU.y, 0) + buf.get(PLATEAU.x, PLATEAU.y, 1) + buf.get(PLATEAU.x, PLATEAU.y, 2)) / 3;
    const lumOff = lumAt(off);
    const lumOn = lumAt(on);
    // Environment lifts the plateau substantially above the ambient+direct
    // baseline (the issue's starting point).
    expect(lumOn - lumOff).toBeGreaterThan(30);
    // OFF stays at the dim baseline (not blown out toward white).
    expect(lumOff).toBeLessThan(200);
  });

  it("keeps metal outside the direct specular lobe from blacking out", () => {
    const metalOff = lightScene(
      createScene({ ...materialScene("metal"), environment: { intensity: 0 } }),
    ).color;
    const metalOn = lightScene(
      createScene({ ...materialScene("metal"), environment: { intensity: 0.5 } }),
    ).color;
    const off = lum({
      r: metalOff.get(PLATEAU.x, PLATEAU.y, 0),
      g: metalOff.get(PLATEAU.x, PLATEAU.y, 1),
      b: metalOff.get(PLATEAU.x, PLATEAU.y, 2),
    });
    const on = lum({
      r: metalOn.get(PLATEAU.x, PLATEAU.y, 0),
      g: metalOn.get(PLATEAU.x, PLATEAU.y, 1),
      b: metalOn.get(PLATEAU.x, PLATEAU.y, 2),
    });
    expect(on).toBeGreaterThan(off);
    // ON must lift the plateau well above the ambient-only near-black drop.
    expect(off).toBeLessThan(120);
    expect(on).toBeGreaterThan(120);
  });

  it("specularIntensity 0 removes the environment specular while intensity stays on", () => {
    const metalWithSpec = lightScene(
      createScene({
        ...materialScene("metal"),
        environment: { intensity: 1, specularIntensity: 1 },
      }),
    ).color;
    const metalNoSpec = lightScene(
      createScene({
        ...materialScene("metal"),
        environment: { intensity: 1, specularIntensity: 0 },
      }),
    ).color;
    const lumAt = (buf: HostBuffer) =>
      (buf.get(PLATEAU.x, PLATEAU.y, 0) + buf.get(PLATEAU.x, PLATEAU.y, 1) + buf.get(PLATEAU.x, PLATEAU.y, 2)) / 3;
    // Metal has no environment DIFFUSE; only the specular share differentiates
    // the two renders, so the plateau must drop when specular is off.
    expect(lumAt(metalWithSpec)).toBeGreaterThan(lumAt(metalNoSpec));
    // specularIntensity 0 must equal the environment-OFF response for metal
    // (diffuse share irrelevant: metal has no env diffuse).
    const metalEnvOff = lightScene(
      createScene({ ...materialScene("metal"), environment: { intensity: 0 } }),
    ).color;
    const at = (buf: HostBuffer, x: number, y: number, c: number) => buf.get(x, y, c);
    for (const c of [0, 1, 2]) {
      expect(at(metalNoSpec, PLATEAU.x, PLATEAU.y, c)).toBe(
        at(metalEnvOff, PLATEAU.x, PLATEAU.y, c),
      );
    }
  });

  it("is independent of the directional light: it contributes even at intensity 0", () => {
    const render = (envIntensity: number) =>
      lightScene(
        createScene({
          ...buttonScene({ x: -0.6, y: -0.8 }),
          environment: { intensity: envIntensity },
          light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 0 },
        }),
      ).color;
    const off = render(0);
    const on = render(0.5);
    const lumAt = (buf: HostBuffer) =>
      (buf.get(PLATEAU.x, PLATEAU.y, 0) + buf.get(PLATEAU.x, PLATEAU.y, 1) + buf.get(PLATEAU.x, PLATEAU.y, 2)) / 3;
    // With ZERO directional light the environment alone must lift the pixel.
    expect(lumAt(on)).toBeGreaterThan(lumAt(off));
  });

  it("is not scaled by cast-shadow visibility (shadowed pixels still get it)", () => {
    const render = (envIntensity: number) =>
      lightScene(
        createScene({ ...raisedButtonScene({ x: -0.6, y: -0.8 }), environment: { intensity: envIntensity } }),
      );
    const off = render(0);
    const on = render(1);
    let shadowed = false;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (off.visibility!.get(x, y, 0) === 0) {
          shadowed = true;
          const offR = off.color.get(x, y, 0);
          const onR = on.color.get(x, y, 0);
          // The visibility mask is identical in both passes; the pixel must
          // still brighten with environment (no visibility scaling).
          expect(onR).toBeGreaterThan(offR);
        }
      }
    }
    expect(shadowed).toBe(true);
  });

  it("keeps the direct direction-dependent response while the environment is on", () => {
    const left = lightScene(
      createScene({ ...buttonScene({ x: -0.6, y: 0 }), environment: { intensity: 0.5 } }),
    ).color;
    const right = lightScene(
      createScene({ ...buttonScene({ x: 0.6, y: 0 }), environment: { intensity: 0.5 } }),
    ).color;
    const lumBuf = (buf: HostBuffer, x: number, y: number) =>
      (buf.get(x, y, 0) + buf.get(x, y, 1) + buf.get(x, y, 2)) / 3;
    // Bevel edge brightness still follows the light (direct highlight remains).
    expect(lumBuf(left, 4, 8)).toBeGreaterThan(lumBuf(left, 12, 8));
    expect(lumBuf(right, 12, 8)).toBeGreaterThan(lumBuf(right, 4, 8));
  });
});

describe("buffer invariance under environment/exposure changes", () => {
  it("height, normal, objectId, visibility, diffuse and specular are untouched", () => {
    const sceneA = createScene({
      ...buttonScene({ x: -0.6, y: -0.8 }),
      environment: { intensity: 1.5 },
      exposure: 0.3,
    });
    const sceneB = createScene({
      ...buttonScene({ x: -0.6, y: -0.8 }),
      environment: { intensity: 0 },
      exposure: 8,
    });
    const a = lightScene(sceneA);
    const b = lightScene(sceneB);

    for (const name of ["height", "normal", "diffuse", "specular"] as const) {
      expect(Array.from(a[name].data), name).toEqual(Array.from(b[name].data));
    }
    expect(a.visibility).not.toBeNull();
    expect(Array.from(a.visibility!.data)).toEqual(Array.from(b.visibility!.data));

    const oidA = composeSdfHeightField(sceneA).objectId;
    const oidB = composeSdfHeightField(sceneB).objectId;
    expect(Array.from(oidA.data)).toEqual(Array.from(oidB.data));

    // objectId ownership is genuinely exercised (not all NO_OWNER)
    const oidBytes = new Uint8Array(oidA.data.buffer);
    let owners = 0;
    for (let y = 0; y < oidA.spec.height; y++) {
      for (let x = 0; x < oidA.spec.width; x++) {
        if (readElement(oidBytes, oidA.spec, x, y, 0) !== NO_OWNER) {
          owners++;
        }
      }
    }
    expect(owners).toBeGreaterThan(0);
  });

  it("produces finite color everywhere across the roughness/metallic/exposure extremes", () => {
    const materials = [
      { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 0, metallic: 0 },
      { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 1, metallic: 0 },
      { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 0, metallic: 1 },
      { baseColor: { r: 0.6, g: 0.6, b: 0.6 }, roughness: 1, metallic: 1 },
    ];
    // specular intensity 0, environment intensity 0 and extreme values must
    // all keep the output finite for every roughness/metallic combination.
    for (const environment of [
      { intensity: 1e300 },
      { intensity: 0 },
      { intensity: 1e300, specularIntensity: 0 },
      { intensity: 1e300, diffuseIntensity: 0, specularIntensity: 0 },
      { intensity: 0, specularIntensity: 1e300 as never },
    ]) {
      for (const material of materials) {
        const scene = createScene({
          ...buttonScene({ x: -0.6, y: -0.8 }),
          environment,
          exposure: 1e300,
          materials: { custom: material },
          surfaces: [{ ...buttonScene({ x: 0, y: 0 }).surfaces[0], material: "custom" }],
        });
        const { color, diffuse, specular } = lightScene(scene);
        for (let y = 0; y < color.spec.height; y++) {
          for (let x = 0; x < color.spec.width; x++) {
            expect(Number.isFinite(diffuse.get(x, y, 0))).toBe(true);
            expect(Number.isFinite(specular.get(x, y, 0))).toBe(true);
            for (let c = 0; c < 4; c++) {
              expect(Number.isFinite(color.get(x, y, c))).toBe(true);
              expect(color.get(x, y, c)).toBeGreaterThanOrEqual(0);
              expect(color.get(x, y, c)).toBeLessThanOrEqual(255);
            }
          }
        }
      }
    }
  });
});
