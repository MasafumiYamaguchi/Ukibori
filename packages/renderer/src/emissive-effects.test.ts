import { describe, expect, it } from "vitest";
import { HostBuffer } from "./buffer";
import { createScene } from "./scene";
import { NO_OWNER } from "./compose";
import { renderEmissiveEffects, sanitizeEmissiveEffects, scaleEmissiveEffects, emissiveEffectsActive } from "./emissive-effects";

function fixture(emission = 4) {
  const width = 17, height = 9;
  const field = (format: "u8" | "u32" | "f32", channels: 1 | 3 | 4) => new HostBuffer({ width, height, format, channels });
  const fields = { color: field("u8", 4), objectId: field("u32", 1), height: field("f32", 1), normal: field("f32", 3), visibility: field("f32", 1) };
  fields.objectId.fill(NO_OWNER); fields.visibility.fill(1);
  for (let i = 0; i < width * height; i++) fields.normal.data[i * 3 + 2] = 1;
  // One bright emitter and a separate receiving surface. Black input isolates effects.
  fields.objectId.set(10, 4, 0, 0); fields.height.set(10, 4, 0, 1);
  fields.objectId.set(6, 4, 0, 1);
  const surfaces = ["led", "receiver", "wall"].map(id => ({ id, position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, elevation: 0,
    shape: { kind: "roundedRect" as const, radius: 0 }, profile: { kind: "flat" as const }, material: id === "led" ? "led" : "matte", castsShadow: true, receivesShadow: true }));
  const scene = createScene({ width, height, surfaces, materials: { led: { baseColor: { r: 0, g: 0, b: 0 }, roughness: 1, metallic: 0, emissive: { r: emission, g: 0, b: 0 } } } });
  return { scene, fields };
}
const pixel = (bytes: Uint8Array, x: number, y = 4) => Array.from(bytes.slice((y * 17 + x) * 4, (y * 17 + x + 1) * 4));

describe("emissive screen-space effects", () => {
  it("is opt-in, bounds cost and scales radii after sanitization", () => {
    expect(emissiveEffectsActive(sanitizeEmissiveEffects())).toBe(false);
    const options = { illumination: { intensity: Infinity, radius: 256 }, bloom: { intensity: -1, radius: 128 }, quality: 999 };
    const e = sanitizeEmissiveEffects(scaleEmissiveEffects(options, 2));
    expect(e).toMatchObject({ lightRadius: 512, bloomRadius: 256, lightIntensity: 1, bloomIntensity: 0, quality: 6 });
    expect(options.illumination.radius).toBe(256);
  });
  it("uses HDR emission before clipping and writes a valid transparent halo", () => {
    const { scene, fields } = fixture();
    const run = (threshold: number) => renderEmissiveEffects(scene, fields, sanitizeEmissiveEffects({ bloom: { radius: 8, threshold } }));
    const output = run(1);
    expect(pixel(output, 8)[0]).toBeGreaterThan(0);
    expect(pixel(run(8), 8)).toEqual([0, 0, 0, 0]);
    expect(pixel(output, 0)).toEqual([0, 0, 0, 0]);
    for (let i = 0; i < output.length; i += 4) for (let c = 0; c < 3; c++) expect(output[i + c]).toBeLessThanOrEqual(output[i + 3]);
    scene.exposure = 0;
    expect(pixel(run(1), 8)).toEqual([0, 0, 0, 0]);
  });
  it("illuminates neighbors independently of bloom and respects normal and intervening height", () => {
    const { scene, fields } = fixture();
    const e = sanitizeEmissiveEffects({ illumination: { radius: 8, intensity: 2 } });
    const run = () => pixel(renderEmissiveEffects(scene, fields, e), 6)[0];
    const lit = run(); expect(lit).toBeGreaterThan(0);
    fields.normal.set(6, 4, 2, -1); expect(run()).toBe(0);
    fields.normal.set(6, 4, 2, 1);
    fields.objectId.set(8, 4, 0, 2); fields.height.set(8, 4, 0, 10);
    expect(run()).toBeLessThan(lit);
  });
  it("preserves illumination under the DOM device-space similarity transform", () => {
    const { scene, fields } = fixture();
    const options = { illumination: { radius: 8, intensity: 2 } };
    const expected = renderEmissiveEffects(scene, fields, sanitizeEmissiveEffects(options));
    const scaled = Object.fromEntries(Object.entries(fields).map(([name, source]) => {
      const target = new HostBuffer({ ...source.spec, width: 34, height: 18 });
      for (let y = 0; y < 18; y++) for (let x = 0; x < 34; x++) for (let c = 0; c < source.spec.channels; c++)
        target.set(x, y, c, source.get(Math.floor(x / 2), Math.floor(y / 2), c) * (name === "height" ? 2 : 1));
      return [name, target];
    })) as typeof fields;
    const actual = renderEmissiveEffects(scene, scaled, sanitizeEmissiveEffects(scaleEmissiveEffects(options, 2)));
    for (let c = 0; c < 4; c++) expect(actual[(8 * 34 + 12) * 4 + c]).toBe(expected[(4 * 17 + 6) * 4 + c]);
  });
  it("keeps non-emitting scenes dark and validates field formats", () => {
    const { scene, fields } = fixture(0);
    const e = sanitizeEmissiveEffects({ illumination: {}, bloom: {} });
    expect(pixel(renderEmissiveEffects(scene, fields, e), 8)).toEqual([0, 0, 0, 0]);
    expect(() => renderEmissiveEffects(scene, fields, e, undefined, undefined, 0)).toThrow(/dpr/);
    expect(() => renderEmissiveEffects(scene, { ...fields, normal: fields.height }, e)).toThrow(/format/);
  });
});
