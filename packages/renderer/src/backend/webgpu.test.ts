import { describe, expect, it } from "vitest";
import { createWebGpuBackend, isWebGpuSupported, WebGpuBackend } from "./webgpu";

describe("WebGPU backend availability", () => {
  it("reports unsupported in Node (no navigator.gpu)", async () => {
    await expect(isWebGpuSupported()).resolves.toBe(false);
  });

  it("returns null backend when unsupported", async () => {
    await expect(createWebGpuBackend()).resolves.toBeNull();
  });
});

interface MockGpuBuffer {
  rec: {
    size: number;
    usage: number;
    data: Uint8Array;
    destroyed: boolean;
    mapped: boolean;
  };
}

type MockGpu = MockGpuBuffer & {
  readonly size: number;
  destroy(): void;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
};

function mockDevice() {
  const records = new Set<MockGpuBuffer["rec"]>();
  const created: Array<{ size: number; usage: number }> = [];
  const writes: Array<{ buffer: MockGpuBuffer["rec"]; bytes: Uint8Array }> = [];
  const copies: Array<{ src: MockGpuBuffer["rec"]; dst: MockGpuBuffer["rec"]; size: number }> = [];
  const mapAsyncCalls: Array<MockGpuBuffer["rec"]> = [];

  const makeBuffer = (desc: { size: number; usage: number }): MockGpu => {
    created.push({ size: desc.size, usage: desc.usage });
    const rec: MockGpuBuffer["rec"] = {
      size: desc.size,
      usage: desc.usage,
      data: new Uint8Array(desc.size),
      destroyed: false,
      mapped: false,
    };
    records.add(rec);
    const gpu: MockGpu = {
      rec,
      size: desc.size,
      destroy: (): void => {
        rec.destroyed = true;
      },
      mapAsync: (): Promise<void> => {
        mapAsyncCalls.push(rec);
        rec.mapped = true;
        return Promise.resolve();
      },
      getMappedRange: (): ArrayBuffer => rec.data.buffer as ArrayBuffer,
      unmap: (): void => {
        rec.mapped = false;
      },
    };
    return gpu;
  };

  const queue = {
    writeBuffer: (target: MockGpu, dstByteOffset: number, source: Uint8Array): void => {
      target.rec.data.set(source, dstByteOffset);
      writes.push({ buffer: target.rec, bytes: new Uint8Array(source) });
    },
    // Deliberately NO copyBufferToBuffer: the only legal readback path is a
    // GPUCommandEncoder recorded and submitted through the queue, so a
    // fabricated queue shortcut fails here at runtime.
    submit: (commandBuffers: MockCommandBuffer[]): void => {
      for (const commandBuffer of commandBuffers) {
        for (const copy of commandBuffer.copies) {
          copies.push({ src: copy.src.rec, dst: copy.dst.rec, size: copy.size });
          copy.dst.rec.data.set(copy.src.rec.data.subarray(copy.srcOffset, copy.srcOffset + copy.size), copy.dstOffset);
        }
      }
    },
  };

  const createCommandEncoder = (): MockCommandBuffer => {
    const copies: Array<{
      src: MockGpu;
      srcOffset: number;
      dst: MockGpu;
      dstOffset: number;
      size: number;
    }> = [];
    const encoder: MockCommandBuffer = {
      copies,
      copyBufferToBuffer: (
        src: MockGpu,
        srcOffset: number,
        dst: MockGpu,
        dstOffset: number,
        size: number,
      ): void => {
        copies.push({ src, srcOffset, dst, dstOffset, size });
      },
      finish: (): MockCommandBuffer => encoder,
    };
    return encoder;
  };

  const device = {
    queue,
    createBuffer: makeBuffer,
    createCommandEncoder,
    destroy: (): void => {},
  };

  return {
    device,
    records,
    created,
    writes,
    copies,
    mapAsyncCalls,
  };
}

interface MockCommandBuffer {
  copies: Array<{
    src: MockGpu;
    srcOffset: number;
    dst: MockGpu;
    dstOffset: number;
    size: number;
  }>;
  copyBufferToBuffer(
    src: MockGpu,
    srcOffset: number,
    dst: MockGpu,
    dstOffset: number,
    size: number,
  ): void;
  finish(): MockCommandBuffer;
}

describe("WebGpuBackend — #24 usage/readback design", () => {
  it("keeps capabilities.compute false until the full GPU pipeline exists (#26)", () => {
    const mock = mockDevice();
    const backend = new WebGpuBackend(mock.device as unknown as GPUDevice);
    // #26 adds only the normal stage: the height/normal/lighting/shadow
    // pipeline is still partial, so the backend must not advertise compute
    expect(backend.capabilities.compute).toBe(false);
    expect(backend.capabilities).toMatchObject({
      backend: "webgpu",
      readback: true,
      upload: true,
    });
  });

  it("creates production buffers with STORAGE|COPY_DST|COPY_SRC only (no MAP_READ)", async () => {
    const mock = mockDevice();
    const backend = new WebGpuBackend(mock.device as unknown as GPUDevice);
    await backend.createBuffer({ width: 4, height: 4, channels: 1, format: "u32" });
    expect(mock.created).toHaveLength(1);
    expect(mock.created[0].usage).toBe(0x80 | 0x8 | 0x4);
    expect(mock.created[0].usage & 0x1).toBe(0);
  });

  it("writeBytes transfers padded rows through queue.writeBuffer", async () => {
    const mock = mockDevice();
    const backend = new WebGpuBackend(mock.device as unknown as GPUDevice);
    const buffer = await backend.createBuffer({ width: 3, height: 2, channels: 3, format: "u8" });
    const bytes = new Uint8Array(18);
    for (let i = 0; i < 18; i++) {
      bytes[i] = i;
    }
    await buffer.writeBytes(bytes);
    expect(mock.writes).toHaveLength(1);
    // row bytes 9 -> padded row 12, 2 rows -> 24 bytes; row 1 starts at 12
    expect(mock.writes[0].bytes).toHaveLength(24);
    expect(mock.writes[0].bytes.subarray(0, 9)).toEqual(bytes.subarray(0, 9));
    expect(mock.writes[0].bytes.subarray(12, 21)).toEqual(bytes.subarray(9, 18));
  });

  it("readBytes copies via a command encoder, submits, and maps only the staging buffer", async () => {
    const mock = mockDevice();
    const backend = new WebGpuBackend(mock.device as unknown as GPUDevice);
    const buffer = await backend.createBuffer({ width: 3, height: 2, channels: 3, format: "u8" });
    const raw = new Uint8Array(18);
    for (let i = 0; i < 18; i++) {
      raw[i] = i;
    }
    await buffer.writeBytes(raw);

    const read = await buffer.readBytes();
    const [production, staging] = [...mock.records];
    expect(production.usage).toBe(0x80 | 0x8 | 0x4);
    expect(staging.usage).toBe(0x1 | 0x8); // MAP_READ | COPY_DST
    // the copy is recorded on an encoder and applied on queue.submit
    expect(mock.copies).toHaveLength(1);
    expect(mock.copies[0].src).toBe(production);
    expect(mock.copies[0].dst).toBe(staging);
    expect(mock.copies[0].size).toBe(24); // padded byte length
    expect(mock.mapAsyncCalls).toEqual([staging]);
    expect(mock.mapAsyncCalls).not.toContain(production);
    expect(read).toEqual(raw);
    expect(staging.destroyed).toBe(true);
  });

  it("fails if production code called a fabricated queue copy shortcut", async () => {
    const mock = mockDevice();
    const backend = new WebGpuBackend(mock.device as unknown as GPUDevice);
    const buffer = await backend.createBuffer({ width: 1, height: 1, channels: 1, format: "u8" });
    await buffer.writeBytes(new Uint8Array([1]));
    // The mock queue deliberately has no copyBufferToBuffer; a production
    // call through a structural cast would throw here at runtime.
    expect(
      (mock.device.queue as unknown as { copyBufferToBuffer?: unknown }).copyBufferToBuffer,
    ).toBeUndefined();
    const read = await buffer.readBytes();
    expect(read).toEqual(new Uint8Array([1]));
  });

  it("dispose() destroys the device", async () => {
    const mock = mockDevice();
    let deviceDestroyed = false;
    const backend = new WebGpuBackend(
      { ...mock.device, destroy: (): void => { deviceDestroyed = true; } } as unknown as GPUDevice,
    );
    backend.dispose();
    expect(deviceDestroyed).toBe(true);
  });
});
