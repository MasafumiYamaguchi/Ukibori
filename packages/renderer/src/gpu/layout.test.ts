import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { NO_OWNER } from "../compose";
import {
  ABI_MAGIC,
  ABI_VERSION,
  HEADER_SIZE,
  MASK_STRIDE,
  MATERIAL_STRIDE,
  SCENE_FLAG_DEFAULT,
  SCENE_FLAG_KNOWN_MASK,
  SCENE_FLAG_ORIGIN_TOP_LEFT,
  SCENE_FLAG_Y_DOWN,
  SURFACE_STRIDE,
  sceneSectionLayout,
  texelCenterToLogical,
} from "./layout";
import type { EncodedHeader } from "./layout";
import { WGSL_LAYOUT } from "./wgsl";

function header(overrides: Partial<EncodedHeader> = {}): EncodedHeader {
  return {
    magic: ABI_MAGIC,
    version: ABI_VERSION,
    headerSize: HEADER_SIZE,
    totalByteLength: 128 + 2 * SURFACE_STRIDE + MASK_STRIDE + 3 * MATERIAL_STRIDE + 48,
    logicalWidth: 100,
    logicalHeight: 80,
    renderWidth: 100,
    renderHeight: 80,
    dpr: 1,
    surfaceCount: 2,
    maskCount: 1,
    materialCount: 3,
    coordinateFlags: SCENE_FLAG_DEFAULT,
    lightDirection: { x: 0, y: 0, z: 1 },
    lightIntensity: 1,
    exposure: 1,
    lightAngularRadius: 0,
    lightColor: { r: 1, g: 1, b: 1 },
    environment: { intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 },
    ...overrides,
  };
}

describe("ABI v2 layout constants", () => {
  it("pins the versioned header/stride contract", () => {
    expect(ABI_VERSION).toBe(2);
    expect(ABI_MAGIC).toBe(0x554b4942);
    expect(HEADER_SIZE).toBe(128);
    expect(SURFACE_STRIDE).toBe(128);
    expect(MASK_STRIDE).toBe(32);
    expect(MATERIAL_STRIDE).toBe(64);
    expect(NO_OWNER).toBe(0xffffffff);
  });

  it("documents the v1->v2 header evolution of offsets 112..128", () => {
    // v1: 112..128 reserved zero (no light color); v2 (#45): lightColor
    // vec4. The layout docs must say so — a silent v1->black reinterpretation
    // is the forbidden legacy corruption.
    const source = readLayoutSource();
    expect(source).toContain("ABI_VERSION = 2");
    expect(source).toContain("v1");
    expect(source).toContain("reserved zero");
    expect(source).toContain("lightColor");
  });

  it("derives 16-byte-aligned section ranges from the header counts", () => {
    const layout = sceneSectionLayout(header());
    expect(layout.surfacesOffset).toBe(128);
    expect(layout.masksOffset).toBe(128 + 2 * SURFACE_STRIDE);
    expect(layout.materialsOffset).toBe(layout.masksOffset + MASK_STRIDE);
    expect(layout.maskPixelsOffset).toBe(layout.materialsOffset + 3 * MATERIAL_STRIDE);
    for (const offset of [
      layout.surfacesOffset,
      layout.masksOffset,
      layout.materialsOffset,
      layout.maskPixelsOffset,
    ]) {
      expect(offset % 16).toBe(0);
    }
    expect(layout.totalByteLength).toBe(128 + 2 * SURFACE_STRIDE + MASK_STRIDE + 3 * MATERIAL_STRIDE + 48);
    expect(layout.maskPixelsByteLength).toBe(48);
  });

  it("keeps the WGSL layout in lockstep with the TypeScript layout", () => {
    expect(WGSL_LAYOUT).toContain(`const SURFACE_STRIDE: u32 = ${SURFACE_STRIDE}u;`);
    expect(WGSL_LAYOUT).toContain(`const MASK_STRIDE: u32 = ${MASK_STRIDE}u;`);
    expect(WGSL_LAYOUT).toContain(`const MATERIAL_STRIDE: u32 = ${MATERIAL_STRIDE}u;`);
    expect(WGSL_LAYOUT).toContain(`// size ${HEADER_SIZE}, align 16`);
    expect(WGSL_LAYOUT).toContain("// 48 (a, b, tx, 0)");
    expect(WGSL_LAYOUT).toContain("//  0 (LINEAR rgb)");
    expect(WGSL_LAYOUT).toContain("NO_OWNER");
    expect(WGSL_LAYOUT).toContain("var<storage, read>");
    expect(WGSL_LAYOUT).toContain("coordinateFlags: u32,    // 48");
    expect(WGSL_LAYOUT).toContain("COORDINATE_FLAGS_EXPECTED");
    expect(WGSL_LAYOUT).toContain("fn texelCenterToLogical(texel: u32, dpr: f32) -> f32");
  });

  it("pins the coordinate-flag and texel-mapping contract", () => {
    expect(SCENE_FLAG_ORIGIN_TOP_LEFT).toBe(0x1);
    expect(SCENE_FLAG_Y_DOWN).toBe(0x2);
    expect(SCENE_FLAG_DEFAULT).toBe(0x3);
    expect(SCENE_FLAG_KNOWN_MASK).toBe(0x3);
    expect(texelCenterToLogical(0, 1)).toBe(0.5);
    expect(texelCenterToLogical(0, 2)).toBe(0.25);
    expect(texelCenterToLogical(1, 2)).toBe(0.75);
  });

  it("references the same NO_OWNER sentinel in WGSL comments", () => {
    expect(WGSL_LAYOUT).toContain(`NO_OWNER ${NO_OWNER}`);
  });
});

function readLayoutSource(): string {
  return readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "layout.ts"),
    "utf8",
  );
}
