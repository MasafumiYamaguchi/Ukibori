import { describe, expect, it } from "vitest";
import { normalizeVec3 } from "ukibori-renderer";
import { buildScene } from "./scene-builder";
import { SurfaceRegistry } from "./registry";
import type { DomSurfaceOptions, Region } from "./types";

function addSurface(
  registry: SurfaceRegistry,
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  options: Partial<DomSurfaceOptions> = {},
): void {
  registry.add({
    id,
    element: document.createElement("div"),
    options: {
      id,
      shape: { kind: "roundedRect", radius: 6 } as const,
      elevation: 0,
      thickness: 2,
      material: "silicone",
      ...options,
    },
    geometry: { x, y, w, h, radius: options.shape?.kind === "roundedRect" ? 6 : 0 },
    dirty: false,
    inkDelegated: false,
  });
}

const REGION: Region = { x: 8, y: 16, w: 200, h: 100 };
const LIGHT = { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 };

describe("buildScene", () => {
  it("maps document geometry into region-local scene coordinates", () => {
    const registry = new SurfaceRegistry();
    addSurface(registry, "btn", 40, 60, 100, 32);
    const scene = buildScene({ registry, region: REGION, dpr: 1, light: LIGHT });
    expect(scene.width).toBe(200);
    expect(scene.height).toBe(100);
    expect(scene.surfaces).toHaveLength(1);
    const s = scene.surfaces[0];
    expect(s.id).toBe("btn");
    expect(s.position).toEqual({ x: 32, y: 44 }); // 40-8, 60-16
    expect(s.size).toEqual({ x: 100, y: 32 });
  });

  it("scales every scene length by dpr while the light stays dimensionless", () => {
    const registry = new SurfaceRegistry();
    addSurface(registry, "btn", 40, 60, 100, 32, {
      elevation: 3,
      thickness: 2,
      bevelWidth: 4,
    });
    const scene = buildScene({ registry, region: REGION, dpr: 2, light: LIGHT });
    expect(scene.width).toBe(400);
    expect(scene.height).toBe(200);
    const s = scene.surfaces[0];
    expect(s.position).toEqual({ x: 64, y: 88 });
    expect(s.size).toEqual({ x: 200, y: 64 });
    expect(s.elevation).toBe(6);
    expect(s.thickness).toBe(4);
    expect(s.bevelWidth).toBe(8);
    expect(s.shape.kind).toBe("roundedRect");
    expect(scene.light.direction).toEqual(normalizeVec3(LIGHT.direction));
    expect(scene.light.intensity).toBe(1);
  });

  it("keeps the mask identity so the renderer SDF cache (#19) hits", () => {
    const registry = new SurfaceRegistry();
    const mask = { width: 8, height: 8, alpha: new Float32Array(64).fill(1) };
    addSurface(registry, "glyph", 40, 60, 16, 16, { shape: { kind: "mask", mask } });
    const scene = buildScene({ registry, region: REGION, dpr: 1, light: LIGHT });
    const s = scene.surfaces[0];
    expect(s.shape.kind).toBe("mask");
    expect(s.shape.kind === "mask" ? s.shape.mask : null).toBe(mask);
  });

  it("rejects duplicate surface ids at registration (renderer #13 policy)", () => {
    const registry = new SurfaceRegistry();
    addSurface(registry, "dup", 10, 10, 20, 20);
    // The retained registry enforces uniqueness before a scene is ever built.
    expect(() => addSurface(registry, "dup", 10, 10, 20, 20)).toThrow(/duplicate surface id/);
    expect(registry.size).toBe(1);
  });

  it("defaults to the bevel profile and casting/receiving flags", () => {
    const registry = new SurfaceRegistry();
    addSurface(registry, "btn", 40, 60, 100, 32);
    const scene = buildScene({ registry, region: REGION, dpr: 1, light: LIGHT });
    const s = scene.surfaces[0];
    expect(s.profile).toEqual({ kind: "bevel" });
    expect(s.castsShadow).toBe(true);
    expect(s.receivesShadow).toBe(true);
  });

  it("normalizes an invalid light direction to +z", () => {
    const registry = new SurfaceRegistry();
    addSurface(registry, "btn", 40, 60, 100, 32);
    const scene = buildScene({
      registry,
      region: REGION,
      dpr: 1,
      light: { direction: { x: 0, y: 0, z: 0 }, intensity: 1 },
    });
    expect(scene.light.direction).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("passes environment and exposure through to the scene", () => {
    const registry = new SurfaceRegistry();
    addSurface(registry, "btn", 40, 60, 100, 32);
    const scene = buildScene({
      registry,
      region: REGION,
      dpr: 1,
      light: LIGHT,
      environment: { intensity: 0.25, diffuseIntensity: 0.5, specularIntensity: 0 },
      exposure: 3,
    });
    expect(scene.environment.intensity).toBe(0.25);
    expect(scene.environment.diffuseIntensity).toBe(0.5);
    expect(scene.environment.specularIntensity).toBe(0);
    expect(scene.exposure).toBe(3);
  });

  it("defaults environment (intensity 0.5, shares 1) and exposure (1) when omitted", () => {
    const registry = new SurfaceRegistry();
    addSurface(registry, "btn", 40, 60, 100, 32);
    const scene = buildScene({ registry, region: REGION, dpr: 1, light: LIGHT });
    expect(scene.environment).toEqual({ intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 });
    expect(scene.exposure).toBe(1);
  });

  it("resolves material refs from the override table", () => {
    const registry = new SurfaceRegistry();
    addSurface(registry, "btn", 40, 60, 100, 32, { material: "custom" });
    const scene = buildScene({
      registry,
      region: REGION,
      dpr: 1,
      light: LIGHT,
      materials: { custom: { baseColor: { r: 0.2, g: 0.4, b: 0.6 }, roughness: 0.5, metallic: 0 } },
    });
    expect(scene.surfaces[0].material).toBe("custom");
    expect(scene.materials?.custom.roughness).toBe(0.5);
  });

  it("composes delegated CSS baseColor over preset physical parameters", () => {
    const registry = new SurfaceRegistry();
    addSurface(registry, "glyph", 40, 60, 100, 32, { material: "metal" });
    const entry = registry.get("glyph")!;
    entry.inkDelegated = true;
    entry.computedTextColor = { r: 0.01, g: 0.02, b: 0.03 };
    const scene = buildScene({ registry, region: REGION, dpr: 1, light: LIGHT });
    const effective = scene.materials?.[scene.surfaces[0].material];
    expect(scene.surfaces[0].material).toMatch(/^@ukibori-dom\/text-color\//);
    expect(effective).toEqual({
      baseColor: { r: 0.01, g: 0.02, b: 0.03 },
      roughness: 0.2,
      metallic: 1,
      ior: 1.5,
    });
  });

  it("lets CSS win only for baseColor of a delegated custom material", () => {
    const registry = new SurfaceRegistry();
    addSurface(registry, "glyph", 40, 60, 100, 32, { material: "custom" });
    const entry = registry.get("glyph")!;
    entry.inkDelegated = true;
    entry.computedTextColor = { r: 1, g: 0, b: 0 };
    const scene = buildScene({
      registry,
      region: REGION,
      dpr: 1,
      light: LIGHT,
      materials: {
        custom: { baseColor: { r: 0.4, g: 0.5, b: 0.6 }, roughness: 0.37, metallic: 0.62, ior: 1.7 },
      },
    });
    const effective = scene.materials?.[scene.surfaces[0].material];
    expect(effective).toEqual({
      baseColor: { r: 1, g: 0, b: 0 },
      roughness: 0.37,
      metallic: 0.62,
      ior: 1.7,
    });
    expect(scene.materials?.custom.baseColor).toEqual({ r: 0.4, g: 0.5, b: 0.6 });
  });

  it("skips unmeasured surfaces", () => {
    const registry = new SurfaceRegistry();
    registry.add({
      id: "unmeasured",
      element: document.createElement("div"),
      options: {
        id: "unmeasured",
        shape: { kind: "roundedRect", radius: 2 },
        elevation: 0,
        thickness: 1,
        material: "silicone",
      },
      geometry: null,
      dirty: true,
    inkDelegated: false,
    });
    const scene = buildScene({ registry, region: REGION, dpr: 1, light: LIGHT });
    expect(scene.surfaces).toHaveLength(0);
  });
});

