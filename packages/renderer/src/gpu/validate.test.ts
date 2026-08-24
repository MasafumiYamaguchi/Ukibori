import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { Scene } from "../scene";
import { encodeScene, parseHeader } from "./encode";
import { HEADER_SIZE, sceneSectionLayout } from "./layout";
import { validateEncodedScene } from "./validate";

function fixtureScene(): Scene {
  return createScene({
    width: 100,
    height: 80,
    surfaces: [
      {
        id: "card-a",
        position: { x: 10, y: 20 },
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
    ],
    light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 2 },
    environment: { intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 },
    exposure: 1.25,
  });
}

function validBytes(): Uint8Array {
  return encodeScene(fixtureScene(), 1.5).bytes;
}

function mutate(bytes: Uint8Array, offset: number, mutateFn: (view: DataView) => void): Uint8Array {
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  mutateFn(view);
  return copy;
}

function surfaceOffset(bytes: Uint8Array): number {
  return sceneSectionLayout(parseHeader(bytes)).surfacesOffset;
}

function expectRejected(bytes: Uint8Array, pattern: RegExp | string): void {
  const result = validateEncodedScene(bytes);
  expect(result.ok).toBe(false);
  expect(result.errors.some((error) => error.match(pattern))).toBe(true);
}

describe("validateEncodedScene — valid fixtures", () => {
  it("accepts an encoded scene and returns its parsed header", () => {
    const bytes = validBytes();
    const result = validateEncodedScene(bytes);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.header?.surfaceCount).toBe(1);
    expect(result.header?.renderWidth).toBe(150);
  });

  it("is deterministic across equal inputs", () => {
    expect(validateEncodedScene(validBytes())).toEqual(validateEncodedScene(validBytes()));
  });
});

describe("validateEncodedScene — malformed headers", () => {
  it("rejects a truncated buffer", () => {
    expectRejected(validBytes().subarray(0, 100), /too short/);
  });

  it("rejects a non-Uint8Array input", () => {
    const result = validateEncodedScene("garbage" as unknown as Uint8Array);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/must be a Uint8Array/);
  });

  it("rejects a wrong magic", () => {
    expectRejected(mutate(validBytes(), 0, (v) => v.setUint32(0, 0xdeadbeef, true)), /invalid magic/);
  });

  it("rejects an unsupported version", () => {
    expectRejected(mutate(validBytes(), 4, (v) => v.setUint32(4, 99, true)), /unsupported ABI version 99/);
  });

  it("rejects a wrong header size", () => {
    expectRejected(mutate(validBytes(), 8, (v) => v.setUint32(8, 64, true)), /invalid header size 64/);
  });

  it("rejects a totalByteLength mismatch", () => {
    const bytes = validBytes();
    expectRejected(
      mutate(bytes, 12, (v) => v.setUint32(12, bytes.byteLength - 1, true)),
      /totalByteLength does not match buffer length/,
    );
  });

  it("rejects missing or unknown coordinate flags and nonzero reserved header bytes", () => {
    expectRejected(mutate(validBytes(), 48, (v) => v.setUint32(48, 0x1, true)), /coordinate flags 0x1 != expected 0x3/);
    expectRejected(mutate(validBytes(), 48, (v) => v.setUint32(48, 0x7, true)), /coordinate flags 0x7 != expected 0x3/);
    expectRejected(mutate(validBytes(), 48, (v) => v.setUint32(48, 0x8, true)), /unknown coordinate flag bits: 0x8/);
    // Offset 88 now carries the #41 light angular radius: negative/NaN is
    // rejected; a valid non-negative value passes.
    expectRejected(
      mutate(validBytes(), 88, (v) => v.setFloat32(88, -1, true)),
      /light angular radius at offset 88/,
    );
    expectRejected(
      mutate(validBytes(), 88, (v) => v.setFloat32(88, Number.NaN, true)),
      /light angular radius at offset 88/,
    );
    expectRejected(mutate(validBytes(), 92, (v) => v.setUint32(92, 7, true)), /reserved u32 at offset 92/);
    expectRejected(mutate(validBytes(), 112, (v) => v.setUint32(112, 7, true)), /reserved u32 at 112/);
    expectRejected(mutate(validBytes(), 76, (v) => v.setUint32(76, 1, true)), /light direction padding/);
  });
});

describe("validateEncodedScene — counts, ranges and offsets", () => {
  it("rejects a surface count whose section range exceeds the buffer", () => {
    expectRejected(mutate(validBytes(), 36, (v) => v.setUint32(36, 0xffffffff, true)), /section range/);
  });

  it("rejects out-of-range and duplicate object ids", () => {
    const record = surfaceOffset(validBytes());
    expectRejected(mutate(validBytes(), record + 0, (v) => v.setUint32(record, 5, true)), /objectId 5 != record index 0/);
    expectRejected(mutate(validBytes(), record + 4, (v) => v.setUint32(record + 4, 3, true)), /paintOrder 3 != record index 0/);
  });

  it("rejects misaligned mask pixel offsets and overflow ranges", () => {
    const scene = createScene({
      width: 20,
      height: 20,
      surfaces: [
        {
          id: "m",
          position: { x: 0, y: 0 },
          size: { x: 10, y: 10 },
          elevation: 0,
          shape: { kind: "mask", mask: { width: 2, height: 2, alpha: new Float32Array([0, 0, 0, 0]) } },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: false,
          receivesShadow: false,
        },
      ],
    });
    const bytes = encodeScene(scene, 1).bytes;
    const layout = sceneSectionLayout(parseHeader(bytes));
    expectRejected(mutate(bytes, layout.masksOffset + 16, (v) => v.setUint32(layout.masksOffset + 16, layout.maskPixelsOffset + 1, true)), /pixelOffset 3[0-9]+ != expected/);
    expectRejected(mutate(bytes, layout.masksOffset + 16, (v) => v.setUint32(layout.masksOffset + 16, bytes.byteLength + 1, true)), /outside the buffer/);
  });
});

describe("validateEncodedScene — invalid surface records", () => {
  it("rejects invalid shape and profile enums", () => {
    const record = surfaceOffset(validBytes());
    expectRejected(mutate(validBytes(), record + 8, (v) => v.setUint32(record + 8, 7, true)), /invalid shapeKind 7/);
    expectRejected(mutate(validBytes(), record + 32, (v) => v.setUint32(record + 32, 9, true)), /invalid profileKind 9/);
  });

  it("rejects out-of-range material references", () => {
    const record = surfaceOffset(validBytes());
    expectRejected(mutate(validBytes(), record + 12, (v) => v.setUint32(record + 12, 4, true)), /materialIndex 4 out of range/);
  });

  it("rejects invalid mask references", () => {
    const record = surfaceOffset(validBytes());
    expectRejected(mutate(validBytes(), record + 36, (v) => v.setUint32(record + 36, 0, true)), /maskIndex must be NO_OWNER/);
    const maskScene = createScene({
      width: 20,
      height: 20,
      surfaces: [
        {
          id: "m",
          position: { x: 0, y: 0 },
          size: { x: 10, y: 10 },
          elevation: 0,
          shape: { kind: "mask", mask: { width: 2, height: 2, alpha: new Float32Array([0, 0, 0, 0]) } },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: false,
          receivesShadow: false,
        },
      ],
    });
    const maskBytes = encodeScene(maskScene, 1).bytes;
    const recordOffset = surfaceOffset(maskBytes);
    expectRejected(mutate(maskBytes, recordOffset + 36, (v) => v.setUint32(recordOffset + 36, 3, true)), /maskIndex 3 out of range/);
  });

  it("rejects non-finite and negative geometry", () => {
    const record = surfaceOffset(validBytes());
    expectRejected(mutate(validBytes(), record + 16, (v) => v.setFloat32(record + 16, NaN, true)), /elevation must be finite/);
    expectRejected(mutate(validBytes(), record + 20, (v) => v.setFloat32(record + 20, -1, true)), /thickness must be finite and >= 0/);
    expectRejected(mutate(validBytes(), record + 24, (v) => v.setFloat32(record + 24, -1, true)), /bevelWidth must be finite and >= 0/);
    expectRejected(mutate(validBytes(), record + 40, (v) => v.setFloat32(record + 40, -2, true)), /radius must be finite and >= 0/);
    expectRejected(mutate(validBytes(), record + 48 + 8, (v) => v.setFloat32(record + 48 + 8, NaN, true)), /transform must be finite/);
  });

  it("rejects invalid flag values and nonzero reserved record bytes", () => {
    const record = surfaceOffset(validBytes());
    expectRejected(mutate(validBytes(), record + 28, (v) => v.setUint32(record + 28, 0x8, true)), /reserved flag bits/);
    expectRejected(mutate(validBytes(), record + 44, (v) => v.setUint32(record + 44, 1, true)), /reserved0 must be 0/);
    expectRejected(mutate(validBytes(), record + 112, (v) => v.setUint32(record + 112, 1, true)), /reserved1 byte at 112/);
  });

  it("rejects non-positive local sizes", () => {
    const record = surfaceOffset(validBytes());
    expectRejected(mutate(validBytes(), record + 96, (v) => v.setFloat32(record + 96, 0, true)), /local size.x must be finite and > 0/);
  });

  it("rejects inconsistent conservative bounds", () => {
    const record = surfaceOffset(validBytes());
    expectRejected(mutate(validBytes(), record + 88, (v) => v.setFloat32(record + 88, 999, true)), /bounds .* != conservative footprint/);
  });
});

describe("validateEncodedScene — invalid materials, masks and light", () => {
  it("rejects out-of-range material parameters", () => {
    const bytes = validBytes();
    const materialsOffset = sceneSectionLayout(parseHeader(bytes)).materialsOffset;
    expectRejected(mutate(bytes, materialsOffset + 12, (v) => v.setFloat32(materialsOffset + 12, 2, true)), /roughness must be finite in \[0, 1\]/);
    expectRejected(mutate(bytes, materialsOffset + 16, (v) => v.setFloat32(materialsOffset + 16, -0.5, true)), /metallic must be finite in \[0, 1\]/);
    expectRejected(mutate(bytes, materialsOffset + 20, (v) => v.setFloat32(materialsOffset + 20, 0.9, true)), /ior must be finite and >= 1/);
    expectRejected(mutate(bytes, materialsOffset + 0, (v) => v.setFloat32(materialsOffset + 0, 1.5, true)), /baseColor channel 0/);
    expectRejected(mutate(bytes, materialsOffset + 28, (v) => v.setUint32(materialsOffset + 28, 1, true)), /reserved byte at 28/);
  });

  it("rejects invalid mask record fields", () => {
    const scene = createScene({
      width: 20,
      height: 20,
      surfaces: [
        {
          id: "m",
          position: { x: 0, y: 0 },
          size: { x: 10, y: 10 },
          elevation: 0,
          shape: { kind: "mask", mask: { width: 2, height: 2, alpha: new Float32Array([0.25, 0.5, 0.75, 1]) } },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: false,
          receivesShadow: false,
        },
      ],
    });
    const bytes = encodeScene(scene, 1).bytes;
    const maskRecord = sceneSectionLayout(parseHeader(bytes)).masksOffset;
    expectRejected(mutate(bytes, maskRecord + 8, (v) => v.setUint32(maskRecord + 8, 5, true)), /invalid alphaFormat 5/);
    expectRejected(mutate(bytes, maskRecord + 12, (v) => v.setUint32(maskRecord + 12, 8, true)), /alphaByteLength 8 != 16/);
    expectRejected(mutate(bytes, maskRecord + 0, (v) => v.setUint32(maskRecord + 0, 0, true)), /width must be > 0/);
  });

  it("rejects out-of-range f32 mask alpha and nonzero blob padding", () => {
    const f32Bytes = encodeScene(
      createScene({
        width: 20,
        height: 20,
        surfaces: [
          {
            id: "m",
            position: { x: 0, y: 0 },
            size: { x: 10, y: 10 },
            elevation: 0,
            shape: { kind: "mask", mask: { width: 2, height: 2, alpha: new Float32Array([0.25, 0.5, 0.75, 1]) } },
            profile: { kind: "flat" },
            material: "silicone",
            castsShadow: false,
            receivesShadow: false,
          },
        ],
      }),
      1,
    ).bytes;
    const f32Layout = sceneSectionLayout(parseHeader(f32Bytes));
    expectRejected(mutate(f32Bytes, f32Layout.maskPixelsOffset, (v) => v.setFloat32(f32Layout.maskPixelsOffset, 2.0, true)), /f32 alpha at byte 0 must be in \[0, 1\]/);

    const u8Bytes = encodeScene(
      createScene({
        width: 20,
        height: 20,
        surfaces: [
          {
            id: "m",
            position: { x: 0, y: 0 },
            size: { x: 10, y: 10 },
            elevation: 0,
            shape: { kind: "mask", mask: { width: 2, height: 2, alpha: new Uint8Array([0, 128, 255, 64]) } },
            profile: { kind: "flat" },
            material: "silicone",
            castsShadow: false,
            receivesShadow: false,
          },
        ],
      }),
      1,
    ).bytes;
    const u8Layout = sceneSectionLayout(parseHeader(u8Bytes));
    expectRejected(mutate(u8Bytes, u8Layout.maskPixelsOffset + 4, (v) => v.setUint8(u8Layout.maskPixelsOffset + 4, 1)), /blob padding byte/);
  });

  it("rejects invalid light direction, intensities, exposure and environment", () => {
    expectRejected(mutate(validBytes(), 64, (v) => v.setFloat32(64, 5, true)), /light direction must be a unit vector/);
    expectRejected(mutate(validBytes(), 80, (v) => v.setFloat32(80, -1, true)), /light intensity must be finite and >= 0/);
    expectRejected(mutate(validBytes(), 84, (v) => v.setFloat32(84, NaN, true)), /exposure must be finite and >= 0/);
    expectRejected(mutate(validBytes(), 96, (v) => v.setFloat32(96, -1, true)), /environment intensity must be finite and >= 0/);
    expectRejected(mutate(validBytes(), 100, (v) => v.setFloat32(100, 2, true)), /environment diffuseIntensity must be finite in \[0, 1\]/);
    expectRejected(mutate(validBytes(), 104, (v) => v.setFloat32(104, -0.5, true)), /environment specularIntensity must be finite in \[0, 1\]/);
  });

  it("rejects inconsistent render dimensions", () => {
    expectRejected(mutate(validBytes(), 24, (v) => v.setUint32(24, 999, true)), /renderWidth 999 != max\(1, floor\(logicalWidth \* dpr\)\)/);
  });
});

describe("validateEncodedScene — empty scene edge case", () => {
  it("accepts a scene with no surfaces", () => {
    const scene = createScene({ width: 10, height: 10 });
    const result = validateEncodedScene(encodeScene(scene, 1).bytes);
    expect(result.ok).toBe(true);
    expect(result.header?.surfaceCount).toBe(0);
    expect(result.header?.materialCount).toBe(0);
  });
});
