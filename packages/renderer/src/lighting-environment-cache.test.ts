import { expect, it } from "vitest";
import { HostBuffer } from "./buffer";
import { NO_OWNER } from "./compose";
import { shadePreparedFields } from "./lighting";
import { createScene } from "./scene";

it("refreshes uniform environment response after in-place material and environment edits", () => {
  const scene = createScene({
    width: 4, height: 1,
    light: { direction: { x: 0, y: 0, z: 1 }, intensity: 0 },
    environment: { intensity: 1, diffuseIntensity: 1, specularIntensity: 0 },
    materials: { custom: { baseColor: { r: 0.5, g: 0, b: 0 }, roughness: 1, metallic: 0 } },
    surfaces: [{
      id: "surface", position: { x: 0, y: 0 }, size: { x: 2, y: 1 },
      elevation: 1, shape: { kind: "roundedRect", radius: 0 },
      profile: { kind: "flat" }, material: "custom", castsShadow: true, receivesShadow: true,
    }],
  });
  const normal = new HostBuffer({ width: 4, height: 1, channels: 3, format: "f32" });
  const objectId = new HostBuffer({ width: 4, height: 1, channels: 1, format: "u32" });
  const visibility = new HostBuffer({ width: 4, height: 1, channels: 1, format: "f32" });
  normal.data.set([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  objectId.data.set([0, 0, NO_OWNER, 1234]);
  visibility.data.set([0, 1, 0, 1]);
  const render = () => shadePreparedFields(scene, { normal, objectId, visibility }, { ambient: 0 }).color;
  const first = render();
  expect(first.get(0, 0, 0)).toBeGreaterThan(0);
  expect(first.get(0, 0, 1)).toBe(0);
  // Environment is independent of visibility; unknown owners use the base.
  expect(first.data.slice(0, 4)).toEqual(first.data.slice(4, 8));
  expect(first.data.slice(8, 12)).toEqual(first.data.slice(12, 16));
  scene.materials!.custom.baseColor = { r: 0, g: 0.5, b: 0 };
  const recolored = render();
  expect(recolored.get(0, 0, 0)).toBe(0);
  expect(recolored.get(0, 0, 1)).toBeGreaterThan(0);
  expect(first.get(0, 0, 0)).toBeGreaterThan(0);
  scene.environment.intensity = 0;
  const dark = render();
  for (let x = 0; x < 4; x++) {
    expect(Array.from(dark.data.slice(x * 4, x * 4 + 4))).toEqual([0, 0, 0, 255]);
  }
  scene.environment.intensity = 1;
  expect(render().data).toEqual(recolored.data);
});
