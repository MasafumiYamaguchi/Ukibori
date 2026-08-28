import { describe, expect, it } from "vitest";
import { NO_OWNER } from "../compose";
import { normalizeVec3 } from "../math";
import { createScene } from "../scene";
import type { Scene } from "../scene";
import {
  ABI_MAGIC,
  ABI_VERSION,
  FLAG_CASTS_SHADOW,
  HEADER_SIZE,
  MASK_OFFSET_ALPHA_BYTE_LENGTH,
  MASK_OFFSET_ALPHA_FORMAT,
  MASK_OFFSET_HEIGHT,
  MASK_OFFSET_PIXEL_OFFSET,
  MASK_OFFSET_WIDTH,
  SURFACE_OFFSET_BEVEL_WIDTH,
  SURFACE_OFFSET_BOUNDS,
  SURFACE_OFFSET_ELEVATION,
  SURFACE_OFFSET_FLAGS,
  SURFACE_OFFSET_LOCAL_SIZE,
  SURFACE_OFFSET_MASK_INDEX,
  SURFACE_OFFSET_MATERIAL_INDEX,
  SURFACE_OFFSET_OBJECT_ID,
  SURFACE_OFFSET_PAINT_ORDER,
  SURFACE_OFFSET_PROFILE_KIND,
  SURFACE_OFFSET_RADIUS,
  SURFACE_OFFSET_SHAPE_KIND,
  SURFACE_OFFSET_THICKNESS,
  SURFACE_OFFSET_TRANSFORM_ROW0,
  SURFACE_OFFSET_TRANSFORM_ROW1,
  MATERIAL_OFFSET_BASE_COLOR,
  MATERIAL_OFFSET_IOR,
  MATERIAL_OFFSET_METALLIC,
  MATERIAL_OFFSET_ROUGHNESS,
  sceneSectionLayout,
} from "./layout";
import { encodeScene, parseHeader } from "./encode";
import { validateEncodedScene } from "./validate";
import { texelCenterToLogical } from "./layout";

function roundedScene(): Scene {
  return createScene({
    width: 100,
    height: 80,
    surfaces: [
      {
        id: "card-a",
        position: { x: 10.25, y: 20.5 },
        size: { x: 60, y: 40 },
        elevation: 2,
        thickness: 3,
        bevelWidth: 1,
        shape: { kind: "roundedRect", radius: 8 },
        profile: { kind: "bevel" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: false,
      },
      {
        id: "card-b",
        position: { x: 10.25, y: 20.5 },
        size: { x: 30, y: 20 },
        elevation: 1,
        thickness: 0,
        bevelWidth: 0,
        shape: { kind: "roundedRect", radius: 2 },
        profile: { kind: "flat" },
        material: "metal",
        castsShadow: false,
        receivesShadow: true,
      },
    ],
    light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 2 },
    environment: { intensity: 0.5, diffuseIntensity: 0.8, specularIntensity: 0.4 },
    exposure: 1.25,
  });
}

describe("encodeScene — determinism and header", () => {
  it("produces byte-identical output for the same scene and DPR", () => {
    const a = encodeScene(roundedScene(), 1.5).bytes;
    const b = encodeScene(roundedScene(), 1.5).bytes;
    expect(a).toEqual(b);
  });

  it("does not read the Scene object again after encoding", () => {
    const scene = roundedScene();
    const first = encodeScene(scene, 1).bytes;
    scene.surfaces.push(scene.surfaces[0]);
    const second = encodeScene(scene, 1).bytes;
    expect(second).not.toEqual(first);
    expect(encodeScene(roundedScene(), 1).bytes).toEqual(first);
  });

  it("writes the header fields at their documented offsets", () => {
    const { bytes } = encodeScene(roundedScene(), 1.5);
    const view = new DataView(bytes.buffer);
    const light = normalizeVec3({ x: -0.6, y: -0.8, z: 1 });
    expect(view.getUint32(0, true)).toBe(ABI_MAGIC);
    expect(view.getUint32(4, true)).toBe(ABI_VERSION);
    expect(view.getUint32(8, true)).toBe(HEADER_SIZE);
    expect(view.getUint32(12, true)).toBe(bytes.byteLength);
    expect(view.getUint32(16, true)).toBe(100);
    expect(view.getUint32(20, true)).toBe(80);
    expect(view.getUint32(24, true)).toBe(150);
    expect(view.getUint32(28, true)).toBe(120);
    expect(view.getFloat32(32, true)).toBe(Math.fround(1.5));
    expect(view.getUint32(36, true)).toBe(2);
    expect(view.getUint32(44, true)).toBe(2);
    expect(view.getUint32(48, true)).toBe(0x3); // coordinate flags: top-left origin | +y down
    expect(view.getFloat32(64, true)).toBe(Math.fround(light.x));
    expect(view.getFloat32(68, true)).toBe(Math.fround(light.y));
    expect(view.getFloat32(72, true)).toBe(Math.fround(light.z));
    expect(view.getFloat32(80, true)).toBe(2);
    expect(view.getFloat32(84, true)).toBe(Math.fround(1.25));
    expect(view.getFloat32(96, true)).toBe(0.5);
    expect(view.getFloat32(100, true)).toBe(Math.fround(0.8));
    expect(view.getFloat32(104, true)).toBe(Math.fround(0.4));
    // #45: lightColor at 112..124 (linear RGB, w = 0); the roundedScene
    // light carries no color -> white default
    expect(view.getFloat32(112, true)).toBe(1);
    expect(view.getFloat32(116, true)).toBe(1);
    expect(view.getFloat32(120, true)).toBe(1);
    expect(view.getUint32(124, true)).toBe(0);
    expect(parseHeader(bytes)).toMatchObject({
      logicalWidth: 100,
      logicalHeight: 80,
      renderWidth: 150,
      renderHeight: 120,
      surfaceCount: 2,
      maskCount: 0,
      materialCount: 2,
      lightColor: { r: 1, g: 1, b: 1 },
    });
  });

  it("encodes a colored light at 112..124 and parses it back (f32-rounded)", () => {
    const scene = roundedScene();
    scene.light.color = { r: 1, g: 0.55, b: Math.fround(0.25) };
    const { bytes } = encodeScene(scene, 1);
    const view = new DataView(bytes.buffer);
    expect(view.getFloat32(112, true)).toBe(1);
    expect(view.getFloat32(116, true)).toBe(Math.fround(0.55));
    expect(view.getFloat32(120, true)).toBe(Math.fround(0.25));
    expect(view.getUint32(124, true)).toBe(0); // deterministic zero w
    expect(parseHeader(bytes).lightColor).toEqual({
      r: 1,
      g: Math.fround(0.55),
      b: Math.fround(0.25),
    });
  });

  it("always writes the current ABI version (v2) and rejects nothing upstream", () => {
    const { bytes } = encodeScene(roundedScene(), 1);
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(4, true)).toBe(2);
    expect(parseHeader(bytes).version).toBe(2);
  });

  it("encodes an explicit v2 black light as all-zero RGB (legal, not a sentinel)", () => {
    const scene = createScene({
      ...roundedScene(),
      light: { ...roundedScene().light, color: { r: 0, g: 0, b: 0 } },
    });
    const { bytes } = encodeScene(scene, 1);
    const view = new DataView(bytes.buffer);
    expect(view.getFloat32(112, true)).toBe(0);
    expect(view.getFloat32(116, true)).toBe(0);
    expect(view.getFloat32(120, true)).toBe(0);
    expect(view.getUint32(124, true)).toBe(0);
    expect(parseHeader(bytes).lightColor).toEqual({ r: 0, g: 0, b: 0 });
    expect(scene.light.color).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("CPU Scene, parsed ABI and WGSL-visible bytes share the SAME canonical f32 light color", () => {
    // #45 CPU/WebGPU parity: createScene sanitizes the color to canonical
    // f32 values; the encoder packs those EXACT values; the WGSL shader
    // reads the very same f32 bytes. No backend may round independently.
    const scene = createScene({
      ...roundedScene(),
      light: { ...roundedScene().light, color: { r: 0.1, g: 0.3, b: 1.7 } },
    });
    const canonical = {
      r: Math.fround(0.1),
      g: Math.fround(0.3),
      b: Math.fround(1.7),
    };
    // 1. Scene.light.color is the canonical f32 value
    expect(scene.light.color).toEqual(canonical);
    // 2. the parsed ABI lightColor equals it exactly
    const { bytes } = encodeScene(scene, 1);
    expect(parseHeader(bytes).lightColor).toEqual(canonical);
    // 3. the raw bytes the WGSL `SceneHeader.lightColor` reads ARE those
    //    canonical f32 bit patterns (little-endian)
    const view = new DataView(bytes.buffer);
    expect(view.getFloat32(112, true)).toBe(canonical.r);
    expect(view.getFloat32(116, true)).toBe(canonical.g);
    expect(view.getFloat32(120, true)).toBe(canonical.b);
    expect(validateEncodedScene(bytes).ok).toBe(true);
  });

  it("rejects invalid DPR values", () => {
    for (const dpr of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => encodeScene(roundedScene(), dpr)).toThrow(/devicePixelRatio/);
    }
  });

  it("derives render dimensions with floor(logical * dpr) without mutating the scene", () => {
    const scene = roundedScene();
    const before = { width: scene.width, height: scene.height };
    const { bytes } = encodeScene(scene, 2);
    expect(scene.width).toBe(before.width);
    expect(scene.height).toBe(before.height);
    expect(parseHeader(bytes).renderWidth).toBe(200);
    expect(parseHeader(bytes).renderHeight).toBe(160);
  });

  it("uses floor (not round) for fractional render dimensions", () => {
    const scene = createScene({ width: 33, height: 33 });
    // 33 * 1.5 = 49.5: floor -> 49 (round would give 50)
    const header = parseHeader(encodeScene(scene, 1.5).bytes);
    expect(header.renderWidth).toBe(49);
    expect(header.renderHeight).toBe(49);
  });

  it("maps render texel centers to logical coordinates as (texel + 0.5) / dpr", () => {
    expect(texelCenterToLogical(0, 1)).toBe(0.5);
    expect(texelCenterToLogical(0, 2)).toBe(0.25);
    expect(texelCenterToLogical(3, 1.5)).toBeCloseTo(3.5 / 1.5);
  });
});

describe("encodeScene — surface records", () => {
  it("assigns stable numeric ids and array paint order (last-surface-wins tie rule)", () => {
    const { bytes } = encodeScene(roundedScene(), 1);
    const layout = sceneSectionLayout(parseHeader(bytes));
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 2; i++) {
      const record = layout.surfacesOffset + i * 128;
      expect(view.getUint32(record + SURFACE_OFFSET_OBJECT_ID, true)).toBe(i);
      expect(view.getUint32(record + SURFACE_OFFSET_PAINT_ORDER, true)).toBe(i);
      expect(view.getUint32(record + SURFACE_OFFSET_MATERIAL_INDEX, true)).toBe(i);
    }
  });

  it("encodes shape, profile, elevation/thickness/bevel and shadow flags at the documented offsets", () => {
    const { bytes } = encodeScene(roundedScene(), 1);
    const layout = sceneSectionLayout(parseHeader(bytes));
    const view = new DataView(bytes.buffer);
    const record = layout.surfacesOffset;
    expect(view.getUint32(record + SURFACE_OFFSET_SHAPE_KIND, true)).toBe(0);
    expect(view.getUint32(record + SURFACE_OFFSET_PROFILE_KIND, true)).toBe(1);
    expect(view.getUint32(record + SURFACE_OFFSET_MASK_INDEX, true)).toBe(NO_OWNER);
    expect(view.getFloat32(record + SURFACE_OFFSET_ELEVATION, true)).toBe(2);
    expect(view.getFloat32(record + SURFACE_OFFSET_THICKNESS, true)).toBe(3);
    expect(view.getFloat32(record + SURFACE_OFFSET_BEVEL_WIDTH, true)).toBe(1);
    expect(view.getFloat32(record + SURFACE_OFFSET_RADIUS, true)).toBe(8);
    expect(view.getUint32(record + SURFACE_OFFSET_FLAGS, true)).toBe(FLAG_CASTS_SHADOW);
    expect(view.getUint32(record + SURFACE_OFFSET_FLAGS + 128, true)).toBe(0x2);
  });

  it("encodes an explicit local/scene transform: identity scale + +y-down translation", () => {
    const { bytes } = encodeScene(roundedScene(), 1);
    const layout = sceneSectionLayout(parseHeader(bytes));
    const view = new DataView(bytes.buffer);
    const record = layout.surfacesOffset;
    const f = (offset: number) => view.getFloat32(record + offset, true);
    expect([f(SURFACE_OFFSET_TRANSFORM_ROW0), f(SURFACE_OFFSET_TRANSFORM_ROW0 + 4), f(SURFACE_OFFSET_TRANSFORM_ROW0 + 8)]).toEqual([1, 0, Math.fround(10.25)]);
    expect([f(SURFACE_OFFSET_TRANSFORM_ROW1), f(SURFACE_OFFSET_TRANSFORM_ROW1 + 4), f(SURFACE_OFFSET_TRANSFORM_ROW1 + 8)]).toEqual([0, 1, Math.fround(20.5)]);
    expect(f(SURFACE_OFFSET_LOCAL_SIZE)).toBe(60);
    expect(f(SURFACE_OFFSET_LOCAL_SIZE + 4)).toBe(40);
  });

  it("encodes conservative scene-space bounds covering the transformed footprint", () => {
    const { bytes } = encodeScene(roundedScene(), 1);
    const layout = sceneSectionLayout(parseHeader(bytes));
    const view = new DataView(bytes.buffer);
    const record = layout.surfacesOffset;
    const f = (offset: number) => view.getFloat32(record + offset, true);
    expect([
      f(SURFACE_OFFSET_BOUNDS),
      f(SURFACE_OFFSET_BOUNDS + 4),
      f(SURFACE_OFFSET_BOUNDS + 8),
      f(SURFACE_OFFSET_BOUNDS + 12),
    ]).toEqual([Math.fround(10.25), Math.fround(20.5), Math.fround(70.25), Math.fround(60.5)]);
  });

  it("rounds every float to f32", () => {
    const { bytes } = encodeScene(roundedScene(), 1);
    const view = new DataView(bytes.buffer);
    expect(view.getFloat32(32, true)).toBe(Math.fround(1));
  });
});

describe("encodeScene — material and mask tables", () => {
  it("packs materials in first-appearance order with resolved preset values", () => {
    const { bytes } = encodeScene(roundedScene(), 1);
    const layout = sceneSectionLayout(parseHeader(bytes));
    const view = new DataView(bytes.buffer);
    const record = layout.materialsOffset;
    const f = (offset: number) => view.getFloat32(record + offset, true);
    // silicone preset: linear baseColor (0.78, 0.8, 0.83), roughness 0.4, ior 1.45
    expect(f(MATERIAL_OFFSET_BASE_COLOR)).toBe(Math.fround(0.78));
    expect(f(MATERIAL_OFFSET_BASE_COLOR + 4)).toBe(Math.fround(0.8));
    expect(f(MATERIAL_OFFSET_BASE_COLOR + 8)).toBe(Math.fround(0.83));
    expect(f(MATERIAL_OFFSET_ROUGHNESS)).toBe(Math.fround(0.4));
    expect(f(MATERIAL_OFFSET_METALLIC)).toBe(0);
    expect(f(MATERIAL_OFFSET_IOR)).toBe(Math.fround(1.45));
    // metal preset at record 1
    expect(f(MATERIAL_OFFSET_BASE_COLOR + 64)).toBe(Math.fround(0.72));
    expect(f(MATERIAL_OFFSET_METALLIC + 64)).toBe(1);
  });

  it("encodes mask records and alpha blobs with 16-byte padding", () => {
    const alpha = new Float32Array([0.25, 0.5, 0.75, 1]);
    const mask = { width: 2, height: 2, alpha };
    const scene = createScene({
      width: 40,
      height: 40,
      surfaces: [
        {
          id: "glyph",
          position: { x: 10, y: 10 },
          size: { x: 20, y: 20 },
          elevation: 1,
          shape: { kind: "mask", mask },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: false,
          receivesShadow: false,
        },
        {
          id: "glyph-2",
          position: { x: 0, y: 0 },
          size: { x: 20, y: 20 },
          elevation: 0,
          shape: { kind: "mask", mask },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: false,
          receivesShadow: false,
        },
      ],
    });
    const { bytes } = encodeScene(scene, 1);
    const header = parseHeader(bytes);
    const layout = sceneSectionLayout(header);
    const view = new DataView(bytes.buffer);
    expect(header.maskCount).toBe(1);
    const record = layout.masksOffset;
    expect(view.getUint32(record + MASK_OFFSET_WIDTH, true)).toBe(2);
    expect(view.getUint32(record + MASK_OFFSET_HEIGHT, true)).toBe(2);
    expect(view.getUint32(record + MASK_OFFSET_ALPHA_FORMAT, true)).toBe(0);
    expect(view.getUint32(record + MASK_OFFSET_ALPHA_BYTE_LENGTH, true)).toBe(16);
    expect(view.getUint32(record + MASK_OFFSET_PIXEL_OFFSET, true)).toBe(layout.maskPixelsOffset);
    const expected = new Uint8Array(16);
    const expectedView = new DataView(expected.buffer);
    for (let i = 0; i < 4; i++) {
      expectedView.setFloat32(i * 4, alpha[i], true);
    }
    expect(bytes.subarray(layout.maskPixelsOffset, layout.maskPixelsOffset + 16)).toEqual(expected);
  });

  it("packs f32 mask alphas little-endian per element, even from a non-zero byteOffset view", () => {
    // Non-zero byteOffset Float32Array view into a shared backing buffer:
    // only the 4 viewed elements may be encoded.
    const backing = new ArrayBuffer(48);
    const filler = new Float32Array(backing);
    filler[0] = 123;
    filler[1] = 456;
    const alpha = new Float32Array(backing, 8, 4);
    alpha.set([0.25, 0.5, 0.75, 1]);
    const scene = createScene({
      width: 20,
      height: 20,
      surfaces: [
        {
          id: "glyph",
          position: { x: 0, y: 0 },
          size: { x: 10, y: 10 },
          elevation: 0,
          shape: { kind: "mask", mask: { width: 2, height: 2, alpha } },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: false,
          receivesShadow: false,
        },
      ],
    });
    const { bytes } = encodeScene(scene, 1);
    const layout = sceneSectionLayout(parseHeader(bytes));
    const expected = new Uint8Array(16);
    const expectedView = new DataView(expected.buffer);
    for (let i = 0; i < 4; i++) {
      expectedView.setFloat32(i * 4, alpha[i], true);
    }
    expect(bytes.subarray(layout.maskPixelsOffset, layout.maskPixelsOffset + 16)).toEqual(expected);
    // the filler values never leak into the payload
    expect(expected.includes(0)).toBe(true);
  });

  it("encodes u8 masks and leaves no DOM/string ids in the buffer", () => {
    const alpha = new Uint8Array([0, 128, 255, 64]);
    const scene = createScene({
      width: 20,
      height: 20,
      surfaces: [
        {
          id: "icon",
          position: { x: 0, y: 0 },
          size: { x: 10, y: 10 },
          elevation: 0,
          shape: { kind: "mask", mask: { width: 2, height: 2, alpha } },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: false,
          receivesShadow: false,
        },
      ],
    });
    const { bytes } = encodeScene(scene, 1);
    const header = parseHeader(bytes);
    const layout = sceneSectionLayout(header);
    const view = new DataView(bytes.buffer);
    const record = layout.masksOffset;
    expect(view.getUint32(record + MASK_OFFSET_ALPHA_FORMAT, true)).toBe(1);
    expect(view.getUint32(record + MASK_OFFSET_ALPHA_BYTE_LENGTH, true)).toBe(4);
    expect(bytes.subarray(layout.maskPixelsOffset, layout.maskPixelsOffset + 4)).toEqual(alpha);
    const utf8 = new TextDecoder().decode(bytes);
    expect(utf8.includes("icon")).toBe(false);
  });
});
