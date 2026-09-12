import { describe, expect, it } from "vitest";
import { HostBuffer } from "./buffer";
import { createScene } from "./scene";
import { sanitizeMaterial } from "./material";
import { shadePreparedFields } from "./lighting";
import { encodeScene, parseHeader } from "./gpu/encode";
import { validateEncodedScene } from "./gpu/validate";
import { classifySceneChange, reportInvalidations, computeFrameKey } from "./gpu/dirty";
import { MATERIAL_OFFSET_EMISSIVE, MATERIAL_STRIDE, sceneSectionLayout } from "./gpu/layout";

const material = { baseColor: { r: 0, g: 0, b: 0 }, roughness: 1, metallic: 0 };
function fixture(emissive?: { r: number; g: number; b: number }, exposure = 1) {
  return createScene({ width: 2, height: 1, exposure,
    light: { direction: { x: 0, y: 0, z: -1 }, intensity: 0, color: { r: 0, g: 0, b: 0 } },
    environment: { intensity: 0, diffuseIntensity: 0, specularIntensity: 0 },
    materials: { led: { ...material, emissive } },
    surfaces: [{ id: "led", position: { x: 0, y: 0 }, size: { x: 2, y: 1 }, elevation: 1,
      shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "led", castsShadow: true, receivesShadow: true }],
  });
}
function fields() {
  const normal = new HostBuffer({ width: 2, height: 1, channels: 3, format: "f32" });
  normal.data.set([0, 0, 1, 0, 0, -1]);
  const objectId = new HostBuffer({ width: 2, height: 1, channels: 1, format: "u32" });
  const visibility = new HostBuffer({ width: 2, height: 1, channels: 1, format: "f32" });
  visibility.data.set([0, 1]);
  return { normal, objectId, visibility };
}

describe("emissive material", () => {
  it("defaults to black and canonicalizes HDR channels without mutating input", () => {
    expect(sanitizeMaterial(material).emissive).toBeUndefined();
    const input = { ...material, emissive: { r: 4.2, g: -1, b: Infinity } };
    expect(sanitizeMaterial(input).emissive).toEqual({ r: Math.fround(4.2), g: 0, b: 0 });
    expect(input.emissive.g).toBe(-1);
    for (const invalid of [NaN, -Infinity, Number.MAX_VALUE, -0]) {
      expect(sanitizeMaterial({ ...material, emissive: { r: invalid, g: 0, b: 0 } }).emissive?.r).toBe(0);
    }
  });
  it("emits in darkness and shadow, independent of normal, with exposure before sRGB", () => {
    const input = fields();
    for (const [exposure, r, g] of [[0, 0, 0], [0.125, 137, 49], [1, 255, 137], [2, 255, 188]]) {
      const output = shadePreparedFields(fixture({ r: 2, g: 0.25, b: 0 }, exposure), input, { ambient: 0 });
      const expected = [r, g, 0, 255];
      expect(Array.from(output.color.data)).toEqual([...expected, ...expected]);
      expect(Array.from(output.specular.data)).toEqual([0, 0]);
    }
    const black = shadePreparedFields(fixture(), input, { ambient: 0 });
    expect(Array.from(black.color.data)).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
  });
  it("packs emission in existing stride and rejects invalid values and old ABI", () => {
    const { bytes } = encodeScene(fixture({ r: 4, g: 0.25, b: 1 }), 1);
    const layout = sceneSectionLayout(parseHeader(bytes));
    const view = new DataView(bytes.buffer);
    expect(MATERIAL_STRIDE).toBe(64);
    expect([0, 4, 8].map(offset => view.getFloat32(layout.materialsOffset + MATERIAL_OFFSET_EMISSIVE + offset, true))).toEqual([4, 0.25, 1]);
    expect(validateEncodedScene(bytes).ok).toBe(true);
    for (const invalid of [-1, NaN, Infinity]) {
      const bad = bytes.slice();
      new DataView(bad.buffer).setFloat32(layout.materialsOffset + MATERIAL_OFFSET_EMISSIVE, invalid, true);
      expect(validateEncodedScene(bad).ok).toBe(false);
    }
    for (const version of [1, 2, 3]) {
      const old = bytes.slice(); new DataView(old.buffer).setUint32(4, version, true);
      expect(validateEncodedScene(old).ok).toBe(false);
    }
  });
  it("schedules only upload, lighting and presentation for emission changes/removal", () => {
    const frames = [fixture(), fixture({ r: 2, g: 0, b: 0 }), fixture()];
    for (let i = 1; i < frames.length; i++) {
      const a = encodeScene(frames[i - 1], 1), b = encodeScene(frames[i], 1);
      expect(classifySceneChange(a.bytes, b.bytes)).toEqual(["material-values"]);
      expect(reportInvalidations(computeFrameKey(b, { dpr: 1 }), computeFrameKey(a, { dpr: 1 }), b.bytes, a.bytes).executed)
        .toEqual(["upload", "lighting", "presentation"]);
    }
  });
});
