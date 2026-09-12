import { describe, expect, it } from "vitest";
import { createScene, isHeightProfile } from "./scene";
import type { HeightProfile, SurfaceNode } from "./scene";
import { evaluateProfile } from "./profile";
import { composeSdfHeightField, composeCasterHeightField } from "./geometry";
import { NO_OWNER } from "./compose";
import { encodeScene } from "./gpu/encode";
import { validateEncodedScene } from "./gpu/validate";
import { classifySceneChange } from "./gpu/dirty";
import { createProfileComparisonScene, PROFILE_PRESETS } from "./profile-fixture";
import { planPartialScene } from "./gpu/tiles";

const node = (id: string, profile: HeightProfile, elevation = 10, thickness = 8): SurfaceNode => ({
  id, profile, elevation, thickness, position: { x: 0, y: 0 }, size: { x: 16, y: 16 },
  shape: { kind: "roundedRect", radius: 0 }, bevelWidth: 4,
  material: "matte", castsShadow: true, receivesShadow: true,
});
const scene = (surfaces: SurfaceNode[]) => createScene({ width: 16, height: 16, surfaces });

describe("#61 profile curves and validation", () => {
  it.each([
    ["linear", [0, 0.25, 0.5, 0.75, 1]],
    ["smooth", [0, 0.15625, 0.5, 0.84375, 1]],
    ["convex", [0, 0.0625, 0.25, 0.5625, 1]],
    ["concave", [0, 0.4375, 0.75, 0.9375, 1]],
    ["step", [0, 1, 1, 1, 1]],
  ] as const)("pins independent cross-section samples: %s", (kind, samples) => {
    samples.forEach((expected, i) => expect(evaluateProfile({ kind }, -i, 4, 1)).toBe(expected));
    expect(evaluateProfile({ kind }, 1, 4, 1)).toBe(0);
    expect(evaluateProfile({ kind }, -20, 4, 1)).toBe(1);
    expect(evaluateProfile({ kind }, -0.1, 0, 1)).toBe(1);
  });

  it("preserves old aliases and gives both power orientations exact definitions", () => {
    for (let i = 0; i <= 100; i++) {
      const d = -i / 25;
      expect(evaluateProfile({ kind: "smooth" }, d, 4, 8)).toBe(evaluateProfile({ kind: "bevel" }, d, 4, 8));
      expect(evaluateProfile({ kind: "step" }, d, 4, 8)).toBe(evaluateProfile({ kind: "flat" }, d, 4, 8));
      expect(evaluateProfile({ kind: "power", exponent: 2 }, d, 4, 1)).toBeCloseTo(evaluateProfile({ kind: "convex" }, d, 4, 1), 14);
      expect(evaluateProfile({ kind: "power", exponent: 2, bias: "out" }, d, 4, 1)).toBeCloseTo(evaluateProfile({ kind: "concave" }, d, 4, 1), 14);
    }
  });

  it.each([0, -1, NaN, Infinity, 1e100, 1e-100, "2"])("rejects invalid f32 exponents %s", (exponent) => {
    expect(isHeightProfile({ kind: "power", exponent })).toBe(false);
  });

  it("rejects invalid direction/bias and canonicalizes exponent to f32", () => {
    expect(isHeightProfile({ kind: "linear", mode: "negative" })).toBe(false);
    expect(isHeightProfile({ kind: "power", exponent: 2, bias: "sideways" })).toBe(false);
    const profile = scene([node("p", { kind: "power", exponent: 1.3 })]).surfaces[0].profile;
    expect(profile.kind === "power" && profile.exponent).toBe(Math.fround(1.3));
  });
});

describe("#61 ordered carving", () => {
  const chassis = node("chassis", { kind: "step" }, 0, 10);
  const inset = node("inset", { kind: "smooth", mode: "inset" });

  it("lowers height, material ownership and casting geometry, then allows a later knob", () => {
    const s = scene([chassis, { ...inset, material: "metal", castsShadow: false }]);
    const full = composeSdfHeightField(s);
    expect(full.height.get(8, 8)).toBe(2);
    expect(full.objectId.get(8, 8)).toBe(1);
    expect(full.materialId.get(8, 8)).toBe(full.materials.indexOf("metal"));
    expect(composeCasterHeightField(s).get(8, 8)).toBe(2);
    const knob = node("knob", { kind: "step" }, 2, 4);
    expect(composeSdfHeightField(scene([chassis, inset, knob])).height.get(8, 8)).toBe(6);
    expect(composeSdfHeightField(scene([chassis, knob, inset])).height.get(8, 8)).toBe(2);
    expect(composeCasterHeightField(scene([chassis, inset, { ...knob, castsShadow: false }])).get(8, 8)).toBe(2);
  });

  it("never raises empty geometry, clamps deep cuts, and leaves exact ties owned by the original", () => {
    expect(composeSdfHeightField(scene([inset])).objectId.get(8, 8)).toBe(NO_OWNER);
    const deep = composeSdfHeightField(scene([chassis, { ...inset, thickness: 40 }]));
    expect(deep.height.get(8, 8)).toBe(0);
    expect(deep.objectId.get(8, 8)).toBe(1);
    expect(composeSdfHeightField(scene([chassis, { ...inset, thickness: 0 }])).objectId.get(8, 8)).toBe(0);
    expect(composeSdfHeightField(scene([inset, chassis])).height.get(8, 8)).toBe(10);
  });

  it("uses the same profile for masks and rounded rectangles", () => {
    const mask = { width: 16, height: 16, alpha: new Uint8Array(256).fill(255) };
    for (const kind of PROFILE_PRESETS) {
      const rr = scene([chassis, { ...inset, profile: { kind, mode: "inset" } }]);
      const masked = scene([chassis, { ...inset, profile: { kind, mode: "inset" }, shape: { kind: "mask", mask } }]);
      expect(composeSdfHeightField(masked).height.data).toEqual(composeSdfHeightField(rr).height.data);
      expect(composeCasterHeightField(masked).data).toEqual(composeCasterHeightField(rr).data);
    }
  });

  it("encodes all curves and directions, retaining geometry only for light/material changes", () => {
    const before = encodeScene(scene([inset]), 1).bytes;
    for (const profile of [...PROFILE_PRESETS.map((kind) => ({ kind, mode: "inset" } as HeightProfile)),
      { kind: "power", exponent: 1.3, bias: "out", mode: "inset" } as HeightProfile]) {
      const encoded = encodeScene(scene([node("p", profile)]), 1);
      expect(validateEncodedScene(encoded.bytes).ok).toBe(true);
    }
    for (const profile of [{ kind: "smooth" }, { kind: "power", exponent: 2, mode: "inset" },
      { kind: "power", exponent: 3, bias: "out", mode: "inset" }] as HeightProfile[]) {
      expect(classifySceneChange(before, encodeScene(scene([{ ...inset, profile }]), 1).bytes)).toContain("scene");
    }
    const changed = createScene({ ...scene([inset]), light: { direction: { x: 1, y: 1, z: 1 }, intensity: 2 } });
    expect(classifySceneChange(before, encodeScene(changed, 1).bytes)).not.toContain("scene");
    const material = createScene({ ...scene([inset]), materials: { matte: { baseColor: { r: 1, g: 0, b: 0 }, roughness: 0.1, metallic: 0 } } });
    expect(classifySceneChange(before, encodeScene(material, 1).bytes)).not.toContain("scene");
  });

  it("produces distinct deterministic comparison heights", () => {
    const buffers = composeSdfHeightField(createProfileComparisonScene());
    const raised = PROFILE_PRESETS.map((_, i) => buffers.height.get(16 + i * 72, 40));
    expect(new Set(raised).size).toBe(5);
    const insetHeights = PROFILE_PRESETS.map((_, i) => buffers.height.get(16 + i * 72, 124));
    expect(new Set(insetHeights).size).toBe(5);
    raised.forEach((h, i) => expect(insetHeights[i]).toBeCloseTo(10 - h, 5));
  });

  it("retains ordered candidates and covers every changed carved/caster texel in partial updates", () => {
    const body = { ...chassis, size: { x: 64, y: 256 } };
    const well = { ...inset, position: { x: 24, y: 64 }, castsShadow: false,
      profile: { kind: "power", exponent: 2, mode: "inset" } as HeightProfile };
    const before = createScene({ width: 64, height: 256, surfaces: [body, well] });
    const after = createScene({ ...before, surfaces: [body, { ...well,
      profile: { kind: "power", exponent: 3, mode: "inset" },
    }] });
    const plan = planPartialScene({ prevBytes: encodeScene(before, 1).bytes, nextBytes: encodeScene(after, 1).bytes,
      dpr: 1, renderWidth: 64, renderHeight: 256, tileSize: 8, shadowOptions: { maxDistance: 8 } });
    expect(plan.mode).toBe("partial");
    expect(plan.candidateIndices).toEqual([0, 1]);
    const rect = plan.dirtyRect!;
    for (const fields of [
      [composeSdfHeightField(before).height, composeSdfHeightField(after).height],
      [composeCasterHeightField(before), composeCasterHeightField(after)],
    ]) for (let y = 0; y < 256; y++) for (let x = 0; x < 64; x++) {
      if (fields[0].get(x, y) === fields[1].get(x, y)) continue;
      expect(x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height).toBe(true);
    }
  });
});
