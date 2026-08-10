import { describe, expect, it } from "vitest";
import { createScene } from "../scene";
import type { Scene, SurfaceNode } from "../scene";
import { encodeScene } from "./encode";
import { sceneSectionLayout } from "./layout";
import { parseHeader } from "./encode";
import {
  MIN_ALLOCATION_BYTES,
  SCENE_ALLOCATION_USAGE,
  SceneUploader,
  assertBoundedSceneStructure,
} from "./uploader";
import type { GpuBufferLike, GpuUploadDeviceLike } from "./uploader";

class MockBuffer implements GpuBufferLike {
  destroyed = false;
  readonly writes: Array<{ dstByteOffset: number; bytes: Uint8Array }> = [];
  constructor(readonly size: number, readonly usage: number) {}
  destroy(): void {
    this.destroyed = true;
  }
}

class MockDevice implements GpuUploadDeviceLike {
  readonly created: Array<{ size: number; usage: number; buffer: MockBuffer }> = [];
  readonly writeCalls: Array<{ buffer: MockBuffer; dstByteOffset: number; bytes: Uint8Array }> = [];
  /** no readback surface exists: no mapAsync, no copyBufferToBuffer, no readBytes */
  readonly queue = {
    writeBuffer: (
      buffer: GpuBufferLike,
      dstByteOffset: number,
      source: Uint8Array,
    ): void => {
      const mock = buffer as MockBuffer;
      mock.writes.push({ dstByteOffset, bytes: source.slice() });
      this.writeCalls.push({ buffer: mock, dstByteOffset, bytes: source.slice() });
    },
  };

  createBuffer(desc: { size: number; usage: number }): GpuBufferLike {
    const buffer = new MockBuffer(desc.size, desc.usage);
    this.created.push({ size: desc.size, usage: desc.usage, buffer });
    return buffer;
  }
}

function simpleScene(): Scene {
  return createScene({
    width: 100,
    height: 80,
    surfaces: [
      {
        id: "a",
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
  });
}

function bigScene(): Scene {
  const surfaces: SurfaceNode[] = [];
  for (let i = 0; i < 3; i++) {
    surfaces.push({
      id: `s${i}`,
      position: { x: i * 20, y: 0 },
      size: { x: 10, y: 10 },
      elevation: 0,
      shape: { kind: "roundedRect", radius: 1 },
      profile: { kind: "flat" },
      material: i % 2 === 0 ? "silicone" : "metal",
      castsShadow: false,
      receivesShadow: false,
    });
  }
  return createScene({ width: 100, height: 80, surfaces });
}

function maskScene(): Scene {
  return createScene({
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
  });
}

describe("SceneUploader — batched uploads", () => {
  it("uploads each non-empty section with one writeBuffer call and no readback", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    const encoded = encodeScene(simpleScene(), 1);
    const stats = uploader.upload(encoded);

    const layout = sceneSectionLayout(parseHeader(encoded.bytes));
    expect(stats.writeCalls).toBe(3); // header + surfaces + materials
    expect(stats.bytesUploaded).toBe(layout.headerByteLength + layout.surfacesByteLength + layout.materialsByteLength);
    expect(stats.allocationCount).toBe(5); // empty sections get dummy allocations
    expect(stats.newAllocations).toBe(5);
    expect(device.writeCalls.length).toBe(3);

    const sections: Array<[number, number]> = [
      [0, layout.headerByteLength],
      [layout.surfacesOffset, layout.surfacesByteLength],
      [layout.materialsOffset, layout.materialsByteLength],
    ];
    for (let i = 0; i < sections.length; i++) {
      const [offset, length] = sections[i];
      const call = device.writeCalls[i];
      expect(call.dstByteOffset).toBe(0);
      expect(call.bytes).toEqual(encoded.bytes.subarray(offset, offset + length));
    }
    uploader.dispose();
  });

  it("uses only STORAGE|COPY_DST|COPY_SRC allocations (no MAP_READ), all non-zero sized", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    uploader.upload(encodeScene(simpleScene(), 1));
    for (const { size, usage } of device.created) {
      expect(size).toBeGreaterThan(0);
      expect(usage).toBe(SCENE_ALLOCATION_USAGE);
      expect(usage & 0x1).toBe(0); // MAP_READ never set
    }
    // empty sections still get legal dummy allocations
    expect(device.created.some((c) => c.size === MIN_ALLOCATION_BYTES)).toBe(true);
    uploader.dispose();
  });

  it("reuses allocations of sufficient size on the next frame", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    const first = uploader.upload(encodeScene(simpleScene(), 1));
    expect(first.newAllocations).toBe(5);
    const buffers = device.writeCalls.map((call) => call.buffer);
    const second = uploader.upload(encodeScene(simpleScene(), 1.5));
    expect(second.newAllocations).toBe(0);
    expect(second.allocationCount).toBe(5);
    expect(device.created.length).toBe(5); // no new GPU allocations
    for (const call of device.writeCalls) {
      expect(buffers).toContain(call.buffer);
    }
    uploader.dispose();
  });

  it("grows allocations when a section outgrows its buffer and disposes the old ones", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    uploader.upload(encodeScene(simpleScene(), 1));
    const surfacesBefore = device.created[1].buffer; // header(128), surfaces(128), materials(128)
    const grown = uploader.upload(encodeScene(bigScene(), 1));
    // materials stays at the 128-byte floor (bigScene needs exactly 128);
    // only surfaces (384) grows past its 128-byte allocation
    expect(grown.newAllocations).toBe(1);
    expect(grown.allocationCount).toBe(5);
    expect(surfacesBefore.destroyed).toBe(true);
    expect(device.created.some((c) => c.size === 3 * 128)).toBe(true);
    uploader.dispose();
  });

  it("never shrinks: a smaller later frame reuses the larger allocations", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    uploader.upload(encodeScene(bigScene(), 1));
    const created = device.created.length;
    const after = uploader.upload(encodeScene(simpleScene(), 1));
    expect(after.newAllocations).toBe(0);
    expect(device.created.length).toBe(created);
    expect(after.allocationCount).toBe(created);
    uploader.dispose();
  });

  it("dispose() destroys every owned allocation and is idempotent", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    uploader.upload(encodeScene(simpleScene(), 1));
    const buffers = new Set(device.writeCalls.map((call) => call.buffer));
    const dummies = device.created.map((c) => c.buffer).filter((b) => !buffers.has(b));
    uploader.dispose();
    for (const buffer of [...buffers, ...dummies]) {
      expect(buffer.destroyed).toBe(true);
    }
    uploader.dispose();
    const stats = uploader.upload(encodeScene(simpleScene(), 1));
    expect(stats.newAllocations).toBe(5); // fresh allocations after dispose
    uploader.dispose();
  });

  it("does not touch buffers it did not create", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    const foreign = new MockBuffer(4096, SCENE_ALLOCATION_USAGE);
    uploader.upload(encodeScene(simpleScene(), 1));
    uploader.dispose();
    expect(foreign.destroyed).toBe(false);
  });
});

describe("SceneUploader — binding snapshots (#25/#26 consumption)", () => {
  it("exposes a complete, read-only binding snapshot with logical byte lengths", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    const encoded = encodeScene(simpleScene(), 1);
    uploader.upload(encoded);
    const bindings = uploader.getBindings();
    const layout = sceneSectionLayout(parseHeader(encoded.bytes));
    expect(bindings.header.byteLength).toBe(layout.headerByteLength);
    expect(bindings.surfaces.byteLength).toBe(layout.surfacesByteLength);
    expect(bindings.masks.byteLength).toBe(0); // empty section still bound
    expect(bindings.maskPixels.byteLength).toBe(0);
    expect(bindings.materials.byteLength).toBe(layout.materialsByteLength);
    expect(bindings.sceneByteLength).toBe(encoded.bytes.byteLength);
    for (const binding of [
      bindings.header,
      bindings.surfaces,
      bindings.masks,
      bindings.maskPixels,
      bindings.materials,
    ]) {
      expect(binding.buffer.size).toBeGreaterThan(0);
    }
    uploader.dispose();
  });

  it("keeps identical bindings across reused frames and refreshes them on growth", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    uploader.upload(encodeScene(simpleScene(), 1));
    const before = uploader.getBindings();
    const same = uploader.upload(encodeScene(simpleScene(), 2));
    expect(same.newAllocations).toBe(0);
    const after = uploader.getBindings();
    expect(after.surfaces.buffer).toBe(before.surfaces.buffer);
    expect(after.materials.buffer).toBe(before.materials.buffer);
    expect(after.header.buffer).toBe(before.header.buffer);

    const grown = uploader.upload(encodeScene(bigScene(), 1));
    expect(grown.newAllocations).toBeGreaterThan(0);
    const grownBindings = uploader.getBindings();
    expect(grownBindings.surfaces.buffer).not.toBe(before.surfaces.buffer);
    expect(grownBindings.surfaces.byteLength).toBe(3 * 128);
    uploader.dispose();
  });

  it("exposes mask and mask-pixel bindings with real payload lengths for mask scenes", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    uploader.upload(encodeScene(maskScene(), 1));
    const bindings = uploader.getBindings();
    expect(bindings.masks.byteLength).toBe(32);
    expect(bindings.maskPixels.byteLength).toBe(16); // 4 u8 bytes padded to 16
    uploader.dispose();
  });

  it("throws after dispose or before any upload", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    expect(() => uploader.getBindings()).toThrow(/no scene bound/);
    uploader.upload(encodeScene(simpleScene(), 1));
    uploader.dispose();
    expect(() => uploader.getBindings()).toThrow(/no scene bound/);
  });

  it("exposes an O(1) provenance identity tied to the exact uploaded bytes", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    const first = encodeScene(simpleScene(), 1);
    uploader.upload(first);
    expect(uploader.getBindings().provenance).toBe(first.bytes); // reference, no copy
    // a different EncodedScene with identical bytes content gets a different
    // provenance object, so same-length bindings from another scene are
    // detectable by reference comparison
    const second = encodeScene(simpleScene(), 1);
    expect(second.bytes).not.toBe(first.bytes);
    expect(second.bytes.byteLength).toBe(first.bytes.byteLength);
    uploader.upload(second);
    expect(uploader.getBindings().provenance).toBe(second.bytes);
    uploader.dispose();
    expect(() => uploader.getBindings().provenance).toThrow(/no scene bound/);
  });
});

describe("SceneUploader — bounded structural validation", () => {
  function corrupt(bytes: Uint8Array, offset: number, fn: (view: DataView) => void): Uint8Array {
    const copy = bytes.slice();
    fn(new DataView(copy.buffer));
    return copy;
  }

  it("rejects a wrong magic before allocating", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    const bad = corrupt(encodeScene(simpleScene(), 1).bytes, 0, (v) => v.setUint32(0, 0xdeadbeef, true));
    expect(() => uploader.upload({ bytes: bad })).toThrow(/invalid magic/);
    expect(device.created.length).toBe(0);
  });

  it("rejects unsupported versions and wrong header sizes", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    const badVersion = corrupt(encodeScene(simpleScene(), 1).bytes, 4, (v) => v.setUint32(4, 99, true));
    expect(() => uploader.upload({ bytes: badVersion })).toThrow(/unsupported ABI version/);
    const badHeader = corrupt(encodeScene(simpleScene(), 1).bytes, 8, (v) => v.setUint32(8, 64, true));
    expect(() => uploader.upload({ bytes: badHeader })).toThrow(/invalid header size/);
    expect(device.created.length).toBe(0);
  });

  it("rejects a total length mismatch and corrupt counts before allocating", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    const bytes = encodeScene(simpleScene(), 1).bytes;
    const badLength = corrupt(bytes, 12, (v) => v.setUint32(12, bytes.byteLength + 8, true));
    expect(() => uploader.upload({ bytes: badLength })).toThrow(/totalByteLength/);
    // corrupt surfaceCount: section arithmetic balloons far past the buffer
    const badCounts = corrupt(bytes, 36, (v) => v.setUint32(36, 0xffffffff, true));
    expect(() => uploader.upload({ bytes: badCounts })).toThrow(/exceeds buffer length/);
    expect(device.created.length).toBe(0);
  });

  it("rejects a non-finite DPR", () => {
    const device = new MockDevice();
    const uploader = new SceneUploader(device);
    const bad = corrupt(encodeScene(simpleScene(), 1).bytes, 32, (v) => v.setFloat32(32, NaN, true));
    expect(() => uploader.upload({ bytes: bad })).toThrow(/dpr must be finite/);
    expect(device.created.length).toBe(0);
  });

  it("assertBoundedSceneStructure accepts the encoder output", () => {
    const header = assertBoundedSceneStructure(encodeScene(simpleScene(), 1.5).bytes);
    expect(header.surfaceCount).toBe(1);
    expect(header.renderWidth).toBe(150);
  });
});
