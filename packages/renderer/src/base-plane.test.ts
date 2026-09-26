import { describe, expect, it } from "vitest";
import { HostBuffer } from "./buffer";
import { NO_OWNER } from "./compose";
import { basePlaneMaterial, sanitizeBasePlane } from "./base-plane";
import { createScene } from "./scene";
import { shadePreparedFields } from "./lighting";
import { renderEmissiveEffects, sanitizeEmissiveEffects } from "./emissive-effects";
import { compositePixelBytes } from "./gpu/composite";
import { computeFrameKey, reportInvalidations } from "./gpu/dirty";
import { encodeScene } from "./gpu/encode";

const basePlane = { baseColor: { r: 0.3, g: 0.2, b: 0.1 } };
function fixture() {
  const width = 17, height = 9;
  const field = (format: "u8" | "u32" | "f32", channels: 1 | 3 | 4) => new HostBuffer({ width, height, format, channels });
  const fields = { objectId: field("u32", 1), height: field("f32", 1), normal: field("f32", 3), visibility: field("f32", 1) };
  fields.objectId.fill(NO_OWNER); fields.visibility.fill(0);
  for (let i = 0; i < width * height; i++) fields.normal.data[i * 3 + 2] = 1;
  fields.objectId.set(10, 4, 0, 0); fields.height.set(10, 4, 0, 1);
  const surfaces = ["led", "receiver"].map(id => ({ id, position: { x: 0, y: 0 }, size: { x: 1, y: 1 }, elevation: 0,
    shape: { kind: "roundedRect" as const, radius: 0 }, profile: { kind: "flat" as const }, material: id, castsShadow: true, receivesShadow: true }));
  const scene = createScene({ width, height, surfaces, light: { direction: { x: -1, y: 0, z: 0.2 }, intensity: 2 },
    materials: { led: { baseColor: { r: 0, g: 0, b: 0 }, roughness: 1, metallic: 0, emissive: { r: 4, g: 0.5, b: 0.1 } },
      receiver: basePlaneMaterial(sanitizeBasePlane(basePlane)!) } });
  return { scene, fields };
}
const pixel = (data: ArrayLike<number>, x = 6, y = 4) => Array.from({ length: 4 }, (_, c) => data[(y * 17 + x) * 4 + c]);

describe("physical base receiver (#75)", () => {
  it.each([0, 0.25, 1])("matches a same-material owned flat receiver at visibility %s", visibility => {
    const { scene, fields } = fixture(); fields.visibility.fill(visibility);
    const floor = shadePreparedFields(scene, fields, { basePlane }).color;
    fields.objectId.set(6, 4, 0, 1);
    const surface = shadePreparedFields(scene, fields, { basePlane }).color;
    expect(pixel(floor.data)).toEqual(pixel(surface.data));
  });

  it("only multiplies direct light by visibility and keeps a flat floor normal", () => {
    const { scene, fields } = fixture();
    const shadowed = shadePreparedFields(scene, fields, { basePlane }).color;
    scene.light.intensity = 0;
    expect(pixel(shadePreparedFields(scene, fields, { basePlane }).color.data)).toEqual(pixel(shadowed.data));
    fields.normal.set(6, 4, 0, 1); fields.normal.set(6, 4, 2, 0);
    expect(pixel(shadePreparedFields(scene, fields, { basePlane }).color.data)).toEqual(pixel(shadowed.data));
    scene.light.intensity = 2; fields.visibility.fill(1);
    expect(pixel(shadePreparedFields(scene, fields, { basePlane }).color.data)[0]).toBeGreaterThan(pixel(shadowed.data)[0]!);
  });

  it.each([false, true])("receives emission with visibility unchanged and bloom=%s", bloom => {
    const { scene, fields } = fixture();
    const visibility = fields.visibility.data.slice();
    const effects = sanitizeEmissiveEffects({ illumination: { radius: 8, intensity: 2 }, ...(bloom ? { bloom: { radius: 5 } } : {}) });
    const run = () => renderEmissiveEffects(scene, { ...fields, color: shadePreparedFields(scene, fields, { basePlane }).color }, effects, undefined, undefined, 1, basePlane);
    const lit = run();
    fields.objectId.set(6, 4, 0, 1);
    expect(pixel(run())).toEqual(pixel(lit)); // ownership alone cannot change response
    fields.objectId.set(6, 4, 0, NO_OWNER);
    scene.materials!.led!.emissive = { r: 0, g: 0, b: 0 };
    expect(pixel(lit)[0]).toBeGreaterThan(pixel(run())[0]!);
    expect(pixel(lit)[3]).toBe(255);
    expect(fields.visibility.data).toEqual(visibility);
  });

  it("ignores legacy shadow tint in physical composition and preserves owned surfaces", () => {
    expect(compositePixelBytes(NO_OWNER, 80, 60, 40, 0, { basePlane, shadowColor: [255, 0, 0], shadowAlpha: 1 })).toEqual([80, 60, 40, 255]);
    const { scene, fields } = fixture(); fields.objectId.set(6, 4, 0, 1);
    expect(pixel(shadePreparedFields(scene, fields, { basePlane }).color.data)).toEqual(pixel(shadePreparedFields(scene, fields).color.data));
  });

  it("invalidates lighting on floor-color edits, retains static frames and never invalidates shadows", () => {
    const encoded = encodeScene(createScene({ width: 8, height: 8 }), 1);
    const key = (plane = basePlane) => computeFrameKey(encoded, { dpr: 1, compositeOptions: { basePlane: plane } });
    const first = key();
    expect(reportInvalidations(key(), first, encoded.bytes, encoded.bytes).executed).toEqual([]);
    const changed = reportInvalidations(key({ baseColor: { r: 0.1, g: 0.2, b: 0.3 } }), first, encoded.bytes, encoded.bytes);
    expect(changed.executed).toEqual(["lighting", "presentation"]);
  });
});
