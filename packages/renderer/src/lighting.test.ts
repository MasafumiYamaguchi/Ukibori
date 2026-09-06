import { describe, expect, it } from "vitest";
import { HostBuffer, readElement } from "./buffer";
import { NO_OWNER } from "./compose";
import { F32_MAX, saturatingMul, saturatingMulF32 } from "./math";
import { lightScene, computeNormals, shadeHeightField, directLightContributionChannel } from "./lighting";
import { createScene } from "./scene";
import type { Scene, SurfaceNode } from "./scene";
import { composeCasterHeightField, composeSdfHeightField } from "./geometry";
import { computeVisibility } from "./shadow";
import { reconstructVisibility, refineHardEdgeVisibility } from "./shadow-reconstruct";
import { brdfDirect } from "./brdf";

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

describe("computeNormals", () => {
  it("points +z on a flat height field", () => {
    const flat = heightFrom(
      Array.from({ length: 4 }, () => Array(4).fill(0)),
      4,
      4,
    );
    const normal = computeNormals(flat);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(normal.get(x, y, 0)).toBeCloseTo(0, 12);
        expect(normal.get(x, y, 1)).toBeCloseTo(0, 12);
        expect(normal.get(x, y, 2)).toBeCloseTo(1, 12);
      }
    }
  });

  it("tilts against the x gradient (ramp H = x)", () => {
    // H(x) = x: dx = 2 per pixel -> N = normalize(-1, 0, 1)
    const ramp = heightFrom(
      [
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
      ],
      4,
      4,
    );
    const normal = computeNormals(ramp);
    const expected = { x: -1 / Math.SQRT2, y: 0, z: 1 / Math.SQRT2 };
    // interior pixels use the symmetric central difference;
    // normals are stored as f32 (#13 semantics), so tolerance is ~1e-6
    expect(normal.get(1, 1, 0)).toBeCloseTo(expected.x, 6);
    expect(normal.get(1, 1, 1)).toBeCloseTo(0, 6);
    expect(normal.get(1, 1, 2)).toBeCloseTo(expected.z, 6);
  });

  it("tilts diagonally for H = x + y", () => {
    const diag = heightFrom(
      [
        [0, 1, 2, 3],
        [1, 2, 3, 4],
        [2, 3, 4, 5],
        [3, 4, 5, 6],
      ],
      4,
      4,
    );
    const normal = computeNormals(diag);
    const len = Math.hypot(1, 1, 1);
    expect(normal.get(1, 1, 0)).toBeCloseTo(-1 / len, 6);
    expect(normal.get(1, 1, 1)).toBeCloseTo(-1 / len, 6);
    expect(normal.get(1, 1, 2)).toBeCloseTo(1 / len, 6);
  });

  it("produces unit-length, finite normals everywhere on a bevel scene", () => {
    const scene = buttonScene({ x: -0.6, y: -0.8 });
    const { height } = lightScene(scene);
    const normal = computeNormals(height);
    const bytes = new Uint8Array(normal.data.buffer);
    for (let y = 0; y < normal.spec.height; y++) {
      for (let x = 0; x < normal.spec.width; x++) {
        const nx = readElement(bytes, normal.spec, x, y, 0);
        const ny = readElement(bytes, normal.spec, x, y, 1);
        const nz = readElement(bytes, normal.spec, x, y, 2);
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 6);
        expect(Number.isFinite(nx)).toBe(true);
      }
    }
  });

  it("sanitizes normalScale: zero, negative and non-finite fall back to a strictly positive value", () => {
    const flat = heightFrom(
      Array.from({ length: 4 }, () => Array(4).fill(0)),
      4,
      4,
    );
    for (const normalScale of [0, -1, NaN, Infinity, -Infinity]) {
      const normal = computeNormals(flat, { normalScale });
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          expect(normal.get(x, y, 0)).toBeCloseTo(0, 6);
          expect(normal.get(x, y, 1)).toBeCloseTo(0, 6);
          expect(normal.get(x, y, 2)).toBeCloseTo(1, 6);
        }
      }
    }
  });

  it("stays finite and unit-length with extreme scale values", () => {
    const ramp = heightFrom(
      [
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
        [0, 1, 2, 3],
      ],
      4,
      4,
    );
    const normal = computeNormals(ramp, { scaleX: 1e200, scaleY: 1e200, normalScale: 1e-200 });
    const bytes = new Uint8Array(normal.data.buffer);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        const nx = readElement(bytes, normal.spec, x, y, 0);
        const ny = readElement(bytes, normal.spec, x, y, 1);
        const nz = readElement(bytes, normal.spec, x, y, 2);
        expect(Number.isFinite(nx)).toBe(true);
        expect(Number.isFinite(ny)).toBe(true);
        expect(Number.isFinite(nz)).toBe(true);
        expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5);
      }
    }
  });

  it("keeps the flat plateau interior at +z on a real bevel surface", () => {
    const scene = buttonScene({ x: 0, y: 0 });
    const { height } = lightScene(scene);
    const normal = computeNormals(height);
    // center plateau pixel: d = -4.5, beyond the bevel band -> flat
    expect(normal.get(8, 8, 0)).toBeCloseTo(0, 4);
    expect(normal.get(8, 8, 1)).toBeCloseTo(0, 4);
    expect(normal.get(8, 8, 2)).toBeCloseTo(1, 4);
  });

  it("tilts normals on bevel edges", () => {
    const scene = buttonScene({ x: 0, y: 0 });
    const { height } = lightScene(scene);
    const normal = computeNormals(height);
    // left edge pixel (4, 8): height rises toward +x -> normal tilts toward -x
    expect(normal.get(4, 8, 0)).toBeLessThan(0);
    expect(normal.get(4, 8, 2)).toBeLessThan(1);
    // right edge pixel (12, 8): mirror
    expect(normal.get(12, 8, 0)).toBeGreaterThan(0);
  });
});

describe("shading", () => {
  it("fully lights a flat surface facing a +z light", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      light: { direction: { x: 0, y: 0, z: 1 }, intensity: 1 },
    });
    const flat = heightFrom(
      Array.from({ length: 4 }, () => Array(4).fill(0)),
      4,
      4,
    );
    const { diffuse } = shadeHeightField(scene, { height: flat, objectId: noOwnerObjectId(4, 4) });
    expect(diffuse.get(1, 1)).toBeCloseTo(1, 12);
  });

  it("scales diffuse with the light tilt", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      light: { direction: { x: 0.6, y: 0, z: 0.8 }, intensity: 1 },
    });
    const flat = heightFrom(
      Array.from({ length: 4 }, () => Array(4).fill(0)),
      4,
      4,
    );
    const { diffuse } = shadeHeightField(scene, { height: flat, objectId: noOwnerObjectId(4, 4) });
    expect(diffuse.get(1, 1)).toBeCloseTo(0.8, 6);
  });

  it("slides the highlight across the bevel when the light moves (not an offset)", () => {
    const left = lightScene(buttonScene({ x: -0.6, y: 0 })).diffuse;
    const right = lightScene(buttonScene({ x: 0.6, y: 0 })).diffuse;
    const row = 8; // horizontal center row through the button
    const argmaxX = (buf: HostBuffer): number => {
      let bestX = 0;
      let best = -Infinity;
      for (let x = 0; x < buf.spec.width; x++) {
        const v = buf.get(x, row, 0);
        if (v > best) {
          best = v;
          bestX = x;
        }
      }
      return bestX;
    };
    const leftX = argmaxX(left);
    const rightX = argmaxX(right);
    expect(leftX).toBeLessThan(8); // bright on the left bevel
    expect(rightX).toBeGreaterThan(8); // bright on the right bevel
    expect(leftX).not.toBe(rightX);
  });

  it("lighting is deterministic", () => {
    const a = lightScene(buttonScene({ x: -0.6, y: -0.8 }));
    const b = lightScene(buttonScene({ x: -0.6, y: -0.8 }));
    expect(Array.from(a.color.data)).toEqual(Array.from(b.color.data));
    expect(Array.from(a.normal.data)).toEqual(Array.from(b.normal.data));
  });

  it("emits valid RGBA8 color with finite values everywhere", () => {
    const { color, diffuse, specular } = lightScene(buttonScene({ x: -0.6, y: -0.8 }));
    for (let y = 0; y < color.spec.height; y++) {
      for (let x = 0; x < color.spec.width; x++) {
        for (let c = 0; c < 4; c++) {
          const v = color.get(x, y, c);
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
        expect(Number.isFinite(diffuse.get(x, y, 0))).toBe(true);
        expect(Number.isFinite(specular.get(x, y, 0))).toBe(true);
      }
    }
    expect(color.get(8, 8, 3)).toBe(255);
  });

  it("brightens toward the light on the bevel (combined color)", () => {
    const left = lightScene(buttonScene({ x: -0.6, y: 0 })).color;
    const right = lightScene(buttonScene({ x: 0.6, y: 0 })).color;
    const lum = (buf: HostBuffer, x: number, y: number) =>
      (buf.get(x, y, 0) + buf.get(x, y, 1) + buf.get(x, y, 2)) / 3;
    // left-light scene is brighter on the left edge than the right edge
    expect(lum(left, 4, 8)).toBeGreaterThan(lum(left, 12, 8));
    // and the right-light scene inverts it
    expect(lum(right, 12, 8)).toBeGreaterThan(lum(right, 4, 8));
  });

  it("uses the owning surface's material: unknown refs throw at creation", () => {
    expect(() =>
      createScene({
        width: 4,
        height: 4,
        surfaces: [
          {
            id: "s",
            position: { x: 0, y: 0 },
            size: { x: 2, y: 2 },
            elevation: 0,
            shape: { kind: "roundedRect", radius: 0 },
            profile: { kind: "bevel" },
            material: "nope",
            castsShadow: true,
            receivesShadow: true,
          },
        ],
      }),
    ).toThrow(/unknown material "nope"/);
  });

  it("falls back to the base material for an invalid non-sentinel owner", () => {
    const scene = createScene({
      width: 4,
      height: 4,
      light: { direction: { x: 0, y: 0, z: 1 }, intensity: 1 },
    });
    const flat = heightFrom(
      Array.from({ length: 4 }, () => Array(4).fill(0)),
      4,
      4,
    );
    const invalidOwner = noOwnerObjectId(4, 4);
    invalidOwner.fill(0); // invalid because this scene has no surfaces

    const fallback = shadeHeightField(scene, { height: flat, objectId: invalidOwner });
    const base = shadeHeightField(scene, {
      height: flat,
      objectId: noOwnerObjectId(4, 4),
    });

    expect(Array.from(fallback.color.data)).toEqual(Array.from(base.color.data));
    expect(Array.from(fallback.specular.data)).toEqual(Array.from(base.specular.data));
  });

  it("applies scene material overrides to the combined color", () => {
    const scene = (material: string) =>
      createScene({
        ...buttonScene({ x: -0.6, y: 0 }),
        surfaces: [{ ...buttonScene({ x: 0, y: 0 }).surfaces[0], material }],
      });
    const lum = (buf: HostBuffer, x: number, y: number) =>
      (buf.get(x, y, 0) + buf.get(x, y, 1) + buf.get(x, y, 2)) / 3;
    const silicone = lightScene(scene("silicone")).color;
    const matte = lightScene(scene("matte")).color;
    const metal = lightScene(scene("metal")).color;
    const p = { x: 4, y: 8 }; // lit bevel pixel
    expect(lum(silicone, p.x, p.y)).not.toBe(lum(matte, p.x, p.y));
    expect(lum(matte, p.x, p.y)).not.toBe(lum(metal, p.x, p.y));
  });

  it("roughness changes the BRDF specular response", () => {
    const scene = (roughness: number) =>
      createScene({
        ...buttonScene({ x: 0, y: 0 }),
        materials: {
          custom: {
            baseColor: { r: 0.6, g: 0.6, b: 0.6 },
            roughness,
            metallic: 0,
            ior: 1.5,
          },
        },
        surfaces: [{ ...buttonScene({ x: 0, y: 0 }).surfaces[0], material: "custom" }],
      });
    const glossy = lightScene(scene(0.15)).specular;
    const rough = lightScene(scene(0.9)).specular;
    const peak = (buf: HostBuffer): number => {
      let best = -Infinity;
      for (let y = 0; y < buf.spec.height; y++) {
        for (let x = 0; x < buf.spec.width; x++) {
          const v = buf.get(x, y, 0);
          if (v > best) best = v;
        }
      }
      return best;
    };
    expect(peak(glossy)).toBeGreaterThan(peak(rough));
  });

  it("metals have no diffuse: metal output differs structurally from dielectric", () => {
    const metalScene = createScene({
      ...buttonScene({ x: 0, y: 0 }),
      surfaces: [{ ...buttonScene({ x: 0, y: 0 }).surfaces[0], material: "metal" }],
    });
    const dielectricScene = buttonScene({ x: 0, y: 0 });
    const metal = lightScene(metalScene);
    const dielectric = lightScene(dielectricScene);
    // base plane (no owner) uses the same base material in both scenes
    expect(metal.color.get(0, 0, 0)).toBe(dielectric.color.get(0, 0, 0));
    // on the button, metallic F0 vs dielectric diffuse produce different colors
    expect(metal.color.get(8, 8, 0)).not.toBe(dielectric.color.get(8, 8, 0));
  });

  it("applies light intensity to direct diffuse/specular lighting", () => {
    const sceneAt = (intensity: number) =>
      createScene({
        ...buttonScene({ x: -0.6, y: -0.8 }),
        light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity },
      });
    const zero = lightScene(sceneAt(0)).color;
    const half = lightScene(sceneAt(0.5)).color;
    const full = lightScene(sceneAt(1)).color;
    const lum = (buf: HostBuffer, x: number, y: number) =>
      (buf.get(x, y, 0) + buf.get(x, y, 1) + buf.get(x, y, 2)) / 3;
    const litPixel = { x: 4, y: 8 }; // bright bevel pixel under this light
    // intensity 0: ambient only -> no lighting gradient (button is symmetric
    // left/right, so both bevel edges must be identical; base plane differs
    // only because it uses the base-plane material)
    expect(Array.from([zero.get(4, 8, 0), zero.get(4, 8, 1), zero.get(4, 8, 2)])).toEqual([
      zero.get(12, 8, 0),
      zero.get(12, 8, 1),
      zero.get(12, 8, 2),
    ]);
    expect(Array.from([zero.get(0, 0, 0), zero.get(0, 0, 1), zero.get(0, 0, 2)])).toEqual([
      zero.get(15, 15, 0),
      zero.get(15, 15, 1),
      zero.get(15, 15, 2),
    ]);
    // ambient-only baseline is darker than any direct-lit pixel
    expect(lum(zero, litPixel.x, litPixel.y)).toBeLessThan(lum(full, litPixel.x, litPixel.y));
    // changing intensity changes the combined result monotonically
    expect(lum(half, litPixel.x, litPixel.y)).toBeGreaterThan(lum(zero, litPixel.x, litPixel.y));
    expect(lum(half, litPixel.x, litPixel.y)).toBeLessThan(lum(full, litPixel.x, litPixel.y));
    // diffuse term scales with intensity
    const dHalf = lightScene(sceneAt(0.5)).diffuse;
    const dFull = lightScene(sceneAt(1)).diffuse;
    expect(dHalf.get(litPixel.x, litPixel.y, 0)).toBe(dFull.get(litPixel.x, litPixel.y, 0));
  });

  it("resolves the degenerate half-vector L = -V without NaN", () => {
    const scene = createScene({
      ...buttonScene({ x: 0, y: 0 }),
      light: { direction: { x: 0, y: 0, z: -1 }, intensity: 1 },
    });
    const { color, diffuse, specular } = lightScene(scene);
    for (let y = 0; y < color.spec.height; y++) {
      for (let x = 0; x < color.spec.width; x++) {
        expect(Number.isFinite(diffuse.get(x, y, 0))).toBe(true);
        expect(Number.isFinite(specular.get(x, y, 0))).toBe(true);
        expect(specular.get(x, y, 0)).toBe(0); // no half vector -> no specular
        for (let c = 0; c < 4; c++) {
          expect(Number.isFinite(color.get(x, y, c))).toBe(true);
        }
      }
    }
    // normals point +z, light points -z -> no direct diffuse either
    for (let y = 0; y < diffuse.spec.height; y++) {
      for (let x = 0; x < diffuse.spec.width; x++) {
        expect(diffuse.get(x, y, 0)).toBe(0);
      }
    }
  });
});

describe("#43 lightScene reconstruction consumption (CPU oracle semantics)", () => {
  // lightScene is the CPU reference the DOM layer and WasmCpuPipeline mirror;
  // on the soft+enabled path the LIGHTING must consume the reconstructed
  // field, and on hard / disabled paths the RAW field — never a path that
  // computes reconstruction and then shades the raw field.
  const slabSurface = {
    id: "slab",
    position: { x: 10, y: 8 },
    size: { x: 12, y: 12 },
    elevation: 2,
    thickness: 4,
    shape: { kind: "roundedRect", radius: 0 } as const,
    profile: { kind: "flat" } as const,
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
  } satisfies SurfaceNode;

  function sceneWith(angularRadius?: number) {
    return createScene({
      width: 48,
      height: 48,
      surfaces: [slabSurface],
      light: {
        direction: { x: -0.6, y: -0.4, z: 0.8 },
        intensity: 1,
        ...(angularRadius !== undefined ? { angularRadius } : {}),
      },
    });
  }

  it("consumes the reconstructed field on the soft path and the raw field on hard/disabled paths", () => {
    const rawFor = (scene: ReturnType<typeof createScene>) => {
      const composed = composeSdfHeightField(scene);
      return {
        composed,
        raw: computeVisibility(scene, composed.height, {
          samples: 8,
          objectId: composed.objectId,
          casterHeight: composed.height,
        }),
      };
    };
    // soft + enabled: the visibility exposed by lightScene MUST equal the
    // reconstructed field (reconstruction consumed, not discarded)
    const softScene = sceneWith(0.2);
    const soft = lightScene(softScene, {
      shadow: { samples: 8, reconstruction: { enabled: true, radius: 2 } },
    });
    const softRaw = rawFor(softScene);
    const recon = reconstructVisibility(
      softRaw.raw,
      softRaw.composed.height,
      { objectId: softRaw.composed.objectId },
      { enabled: true, radius: 2 },
    );
    const { width, height } = soft.visibility!.spec;
    let differsFromRaw = 0;
    let differsFromRecon = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = soft.visibility!.get(x, y, 0);
        if (v !== softRaw.raw.get(x, y, 0)) {
          differsFromRaw += 1;
        }
        if (v !== recon.get(x, y, 0)) {
          differsFromRecon += 1;
        }
      }
    }
    // the soft path genuinely changes the field (the filter is active) and
    // lighting received exactly the reconstructed values
    expect(differsFromRaw).toBeGreaterThan(0);
    expect(differsFromRecon).toBe(0);

    // hard path (#53): visibility is the RING-RULE REFINED field — a pure
    // display postprocess of the raw {0,1} bytes (interiors verbatim,
    // single-boundary texels ramped); `enabled: false` restores the raw.
    const hardScene = sceneWith(0);
    const hard = lightScene(hardScene, {
      shadow: { samples: 8, reconstruction: { enabled: true, radius: 2 } },
    });
    const hardRaw = rawFor(hardScene);
    const hardRefined = refineHardEdgeVisibility(hardRaw.raw);
    let hardDiffersFromRaw = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const expected = hardRefined.get(x, y, 0);
        if (expected !== hardRaw.raw.get(x, y, 0)) {
          hardDiffersFromRaw += 1;
        }
        expect(hard.visibility!.get(x, y, 0)).toBe(expected);
      }
    }
    // the hard refinement genuinely runs (some boundary texels ramped)...
    expect(hardDiffersFromRaw).toBeGreaterThan(0);
    // ...but stays a dyadic k/16 refinement of the raw field
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const v = hard.visibility!.get(x, y, 0);
        const k16 = v * 16;
        expect(Math.abs(k16 - Math.round(k16))).toBeLessThan(1e-9);
      }
    }

    // disabled: visibility stays the raw field of the same soft scene
    const disabled = lightScene(softScene, {
      shadow: { samples: 8, reconstruction: { enabled: false } },
    });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        expect(disabled.visibility!.get(x, y, 0)).toBe(softRaw.raw.get(x, y, 0));
      }
    }
    for (const [scene, raw, samples] of [
      [hardScene, hardRaw.raw, 1],
      [hardScene, hardRaw.raw, 8],
      [softScene, softRaw.raw, 8],
    ] as const) {
      const radiusZero = lightScene(scene, {
        shadow: { samples, reconstruction: { enabled: true, radius: 0 } },
      });
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          expect(radiusZero.visibility!.get(x, y, 0)).toBe(raw.get(x, y, 0));
        }
      }
    }
  });
});

describe("#45 directional-light color (linear RGB)", () => {
  // A panel with a raised slab: direct-lit top texels + cast-shadowed base
  // plane texels exercise the full accumulation path.
  function colorScene(lightColor: { r: number; g: number; b: number } | undefined, angularRadius = 0.2) {
    return createScene({
      width: 48,
      height: 48,
      surfaces: [
        {
          id: "slab",
          position: { x: 12, y: 8 },
          size: { x: 16, y: 16 },
          elevation: 2,
          thickness: 4,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      light: {
        direction: { x: -0.6, y: -0.4, z: 0.8 },
        intensity: 1,
        ...(angularRadius !== undefined ? { angularRadius } : {}),
        ...(lightColor !== undefined ? { color: lightColor } : {}),
      },
      environment: { intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 },
      exposure: 1,
    });
  }

  function rgba(buf: HostBuffer) {
    const out: number[] = [];
    for (let y = 0; y < buf.spec.height; y++) {
      for (let x = 0; x < buf.spec.width; x++) {
        out.push(buf.get(x, y, 0), buf.get(x, y, 1), buf.get(x, y, 2), buf.get(x, y, 3));
      }
    }
    return out;
  }

  it("explicit white color is byte-identical to an omitted color", () => {
    const omitted = rgba(lightScene(colorScene(undefined)).color);
    const white = rgba(lightScene(colorScene({ r: 1, g: 1, b: 1 })).color);
    expect(white).toEqual(omitted);
  });

  it("tints ONLY the directly-illuminated contribution (red light)", () => {
    const white = lightScene(colorScene({ r: 1, g: 1, b: 1 }));
    const red = lightScene(colorScene({ r: 1, g: 0, b: 0 }));
    const { width, height } = white.color.spec;
    let directTinted = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [wr, wg, wb] = [white.color.get(x, y, 0), white.color.get(x, y, 1), white.color.get(x, y, 2)];
        const [rr, rg, rb] = [red.color.get(x, y, 0), red.color.get(x, y, 1), red.color.get(x, y, 2)];
        if (rr > wr || rg < wg || rb < wb) {
          directTinted += 1;
        }
      }
    }
    expect(directTinted).toBeGreaterThan(0);
    // fully shadowed texels keep the ambient+environment response: the red
    // light must never raise green/blue channels there
    let gbRaisedInShadow = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (white.visibility!.get(x, y, 0) !== 0) {
          continue;
        }
        if (red.color.get(x, y, 1) > white.color.get(x, y, 1) || red.color.get(x, y, 2) > white.color.get(x, y, 2)) {
          gbRaisedInShadow += 1;
        }
      }
    }
    expect(gbRaisedInShadow).toBe(0);
  });

  it("ambient and environment are never multiplied by the light color", () => {
    // A HORIZONTAL light is edge-on to every flat surface (normal +z), so
    // max(N.L, 0) = 0 everywhere: NO direct contribution exists. A colored
    // light must then be indistinguishable from white (only ambient +
    // environment remain, neither tinted by the light color).
    const env = { intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 };
    const horizontal = (color: { r: number; g: number; b: number }) =>
      createScene({
        width: 16,
        height: 16,
        surfaces: [
          {
            // a full-coverage panel with zero thickness: every texel is
            // flat (normal +z), so a horizontal light gives max(N.L, 0) = 0
            // EVERYWHERE — no direct contribution, no edge-tilted normals
            id: "s",
            position: { x: 0, y: 0 },
            size: { x: 16, y: 16 },
            elevation: 0,
            thickness: 0,
            shape: { kind: "roundedRect", radius: 0 },
            profile: { kind: "flat" },
            material: "silicone",
            castsShadow: false,
            receivesShadow: true,
          },
        ],
        light: { direction: { x: 1, y: 0, z: 0 }, intensity: 1, color },
        environment: env,
        exposure: 1,
      });
    expect(rgba(lightScene(horizontal({ r: 1, g: 0, b: 0 })).color)).toEqual(
      rgba(lightScene(horizontal({ r: 1, g: 1, b: 1 })).color),
    );
    // intensity 0 with a non-white color: the color must have no effect
    const zeroIntensity = (color: { r: number; g: number; b: number }) =>
      createScene({
        width: 16,
        height: 16,
        surfaces: [],
        light: { direction: { x: -0.6, y: -0.4, z: 0.8 }, intensity: 0, color },
        environment: env,
        exposure: 1,
      });
    expect(rgba(lightScene(zeroIntensity({ r: 1, g: 0, b: 0 })).color)).toEqual(
      rgba(lightScene(zeroIntensity({ r: 1, g: 1, b: 1 })).color),
    );
  });

  it("keeps the scalar diffuse/specular debug buffers independent of the light color", () => {
    const white = lightScene(colorScene({ r: 1, g: 1, b: 1 }));
    const red = lightScene(colorScene({ r: 1, g: 0, b: 0 }));
    const { width, height } = white.diffuse.spec;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        expect(red.diffuse.get(x, y, 0)).toBe(white.diffuse.get(x, y, 0));
        expect(red.specular.get(x, y, 0)).toBe(white.specular.get(x, y, 0));
      }
    }
  });
});

describe("#45 white vs colored light — shadow/reconstruction invariance", () => {
  // Identical geometry/light direction/angularRadius/shadow options with a
  // white vs red light must produce identical height, normals, raw
  // visibility, reconstructed visibility and the caster field — only the
  // final lighting color may differ.
  function fields(color: { r: number; g: number; b: number }) {
    const scene = createScene({
      width: 32,
      height: 32,
      surfaces: [
        {
          id: "slab",
          position: { x: 10, y: 8 },
          size: { x: 12, y: 12 },
          elevation: 2,
          thickness: 4,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      light: { direction: { x: -0.6, y: -0.4, z: 0.8 }, intensity: 1, color, angularRadius: 0.2 },
    });
    const composed = composeSdfHeightField(scene);
    const raw = computeVisibility(scene, composed.height, {
      samples: 8,
      objectId: composed.objectId,
      casterHeight: composed.height,
    });
    const recon = reconstructVisibility(
      raw,
      composed.height,
      { objectId: composed.objectId },
      { enabled: true, radius: 2 },
    );
    const normal = computeNormals(composed.height);
    return { scene, composed, raw, recon, normal };
  }

  function bytes(buf: HostBuffer) {
    return Array.from(buf.data);
  }

  it("white vs red produce identical height/normals/raw/reconstructed/caster fields", () => {
    const white = fields({ r: 1, g: 1, b: 1 });
    const red = fields({ r: 1, g: 0, b: 0 });
    expect(bytes(white.composed.height)).toEqual(bytes(red.composed.height));
    expect(bytes(white.composed.objectId)).toEqual(bytes(red.composed.objectId));
    expect(bytes(composeCasterHeightField(white.scene))).toEqual(bytes(composeCasterHeightField(red.scene)));
    expect(bytes(white.raw)).toEqual(bytes(red.raw));
    expect(bytes(white.recon)).toEqual(bytes(red.recon));
    expect(bytes(white.normal)).toEqual(bytes(red.normal));
    // and the HARD path is equally invariant (angularRadius 0)
    const hard = (color: { r: number; g: number; b: number }) => {
      const scene = createScene({
        width: 32,
        height: 32,
        surfaces: [
          {
            id: "slab",
            position: { x: 10, y: 8 },
            size: { x: 12, y: 12 },
            elevation: 2,
            thickness: 4,
            shape: { kind: "roundedRect", radius: 0 },
            profile: { kind: "flat" },
            material: "silicone",
            castsShadow: true,
            receivesShadow: true,
          },
        ],
        light: { direction: { x: -0.6, y: -0.4, z: 0.8 }, intensity: 1, color },
      });
      const composed = composeSdfHeightField(scene);
      return computeVisibility(scene, composed.height, {
        samples: 8,
        objectId: composed.objectId,
        casterHeight: composed.height,
      });
    };
    expect(bytes(hard({ r: 1, g: 1, b: 1 }))).toEqual(bytes(hard({ r: 1, g: 0, b: 0 })));
  });
});

describe("#45 review — extreme-HDR direct-light overflow semantics (CPU/GPU parity)", () => {
  // A full-coverage flat panel (normal +z everywhere) under a VERTICAL light:
  // NdotL = NdotV = NdotH = 1 and visibility 1 on every texel, so the whole
  // scene is a single deterministic channel evaluation.
  const HDR_MATERIAL = {
    baseColor: { r: 0.1, g: 0.1, b: 0.1 },
    roughness: 1,
    metallic: 1,
    ior: 1.5,
  };

  function hdrScene(
    color: { r: number; g: number; b: number },
    intensity: number,
    exposure: number,
    light: { x: number; y: number; z: number } = { x: 0, y: 0, z: 1 },
  ): Scene {
    return createScene({
      width: 16,
      height: 16,
      surfaces: [
        {
          id: "s",
          position: { x: 0, y: 0 },
          size: { x: 16, y: 16 },
          elevation: 0,
          thickness: 0,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "hdr-metal",
          castsShadow: false,
          receivesShadow: true,
        },
      ],
      materials: { "hdr-metal": HDR_MATERIAL },
      light: { direction: light, intensity, color },
      environment: { intensity: 0, diffuseIntensity: 1, specularIntensity: 1 },
      exposure,
    });
  }

  function srgbByte(linear: number): number {
    const c = Math.min(1, Math.max(0, linear));
    const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(encoded * 255);
  }

  it("keeps a huge lightColor * intensity recoverable through the small BRDF (documented factor order)", () => {
    // lightColor.r = F32_MAX, intensity = 2: lightColor * intensity exceeds
    // F32_MAX, but the BRDF (~0.008 for this material) scales it back below
    // F32_MAX when the SMALL factors multiply first. The canonical order is
    //   brdfSum -> NdotL -> visibility -> intensity -> lightColor
    // with each step saturated in the f32 domain.
    const scene = hdrScene({ r: F32_MAX, g: 2, b: 0 }, 2, 1e-37);
    const { color, diffuse, specular } = lightScene(scene, { ambient: 0 });
    const { width, height } = color.spec;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
          const v = color.get(x, y, c);
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
      }
    }
    // diffuse = NdotL = 1, specular = min(luminance(brdf.specular), 1):
    // the debug buffers stay color-independent.
    expect(diffuse.get(8, 8, 0)).toBe(1);
    expect(Number.isFinite(specular.get(8, 8, 0))).toBe(true);

    // the documented formula reproduces the byte EXACTLY (ambient 0,
    // environment 0, so linear = direct contribution):
    const brdf = brdfDirect(HDR_MATERIAL, 1, 1, 1, 1);
    const directR = directLightContributionChannel(F32_MAX, 2, 1, 1, brdf.diffuse.r, brdf.specular.r);
    expect(directR).toBeLessThan(F32_MAX); // NO premature intermediate saturation
    expect(directR).toBeGreaterThan(0);
    const expectedRed = srgbByte(saturatingMul(directR, 1e-37));
    expect(expectedRed).toBeGreaterThan(0);
    expect(expectedRed).toBeLessThan(255); // visible intermediate, not white-out
    expect(color.get(8, 8, 0)).toBe(expectedRed);
    // green (moderate HDR 2) and blue (0) stay independent and negligible at
    // this exposure: a per-channel regression cannot hide in the red byte.
    expect(color.get(8, 8, 1)).toBe(0);
    expect(color.get(8, 8, 2)).toBe(0);

    // the PRE-REVIEW early-saturation order (lightColor -> intensity ->
    // NdotL -> visibility, THEN the BRDF) would clamp the irradiance at
    // F32_MAX and produce a DIFFERENT visible byte — this is the exact
    // divergence the review blocked.
    const brdfSum = brdf.diffuse.r + brdf.specular.r;
    const premature = saturatingMulF32(
      brdfSum,
      saturatingMulF32(saturatingMulF32(saturatingMulF32(F32_MAX, 2), 1), 1),
    );
    expect(premature).toBeLessThan(directR); // F32_MAX clamp lost information
    expect(srgbByte(saturatingMul(premature, 1e-37))).not.toBe(expectedRed);
  });

  it("saturates at F32_MAX identically when the final direct contribution genuinely overflows", () => {
    // intensity = F32_MAX: brdfSum * F32_MAX * F32_MAX > F32_MAX, so the
    // LAST step saturates at F32_MAX (exposure 1 -> white). Zero factor
    // safety still holds: no NaN, no Infinity.
    const scene = hdrScene({ r: F32_MAX, g: F32_MAX, b: F32_MAX }, F32_MAX, 1);
    const { color } = lightScene(scene, { ambient: 0 });
    expect(color.get(8, 8, 0)).toBe(255);
    expect(color.get(8, 8, 1)).toBe(255);
    expect(color.get(8, 8, 2)).toBe(255);
    expect(Number.isFinite(color.get(8, 8, 0))).toBe(true);
  });

  it("zero NdotL kills the direct term even at F32_MAX light color (no NaN, no white)", () => {
    // A horizontal light is edge-on to the flat panel: NdotL = 0 everywhere.
    // The direct chain must yield exactly 0 (0 * anything = 0, never NaN),
    // so with ambient/environment 0 the output is black and finite.
    const scene = hdrScene({ r: F32_MAX, g: F32_MAX, b: F32_MAX }, F32_MAX, 1, { x: 1, y: 0, z: 0 });
    const { color } = lightScene(scene, { ambient: 0 });
    const { width, height } = color.spec;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        expect(color.get(x, y, 0)).toBe(0);
        expect(color.get(x, y, 1)).toBe(0);
        expect(color.get(x, y, 2)).toBe(0);
        expect(color.get(x, y, 3)).toBe(255);
      }
    }
  });

  it("zero visibility kills the direct term at F32_MAX light color (shadowed texels stay finite)", () => {
    // A raised casting slab with a side light: the shadowed base-plane
    // texels have visibility 0, so their direct term must be exactly 0 even
    // at F32_MAX color/intensity — the ambient+environment response stays
    // and nothing becomes NaN/Infinity.
    const scene = createScene({
      width: 32,
      height: 32,
      surfaces: [
        {
          id: "slab",
          position: { x: 8, y: 8 },
          size: { x: 12, y: 12 },
          elevation: 4,
          thickness: 0,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "hdr-metal",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      materials: { "hdr-metal": HDR_MATERIAL },
      light: { direction: { x: 1, y: 0, z: 0.5 }, intensity: F32_MAX, color: { r: F32_MAX, g: 0, b: 0 } },
      environment: { intensity: 0, diffuseIntensity: 1, specularIntensity: 1 },
      exposure: 1,
    });
    const { color, visibility } = lightScene(scene, { ambient: 0 });
    const { width, height } = color.spec;
    let shadowed = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
          expect(Number.isFinite(color.get(x, y, c))).toBe(true);
        }
        if (visibility!.get(x, y, 0) === 0) {
          shadowed += 1;
          expect(color.get(x, y, 0)).toBe(0);
          expect(color.get(x, y, 1)).toBe(0);
          expect(color.get(x, y, 2)).toBe(0);
        }
      }
    }
    expect(shadowed).toBeGreaterThan(0);
    // lit texels are finite and non-black (the extreme direct term survives
    // the BRDF and saturates the sRGB clamp)
    expect(color.get(15, 15, 0)).toBe(255);
  });
});
