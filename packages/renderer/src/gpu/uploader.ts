import type { EncodedScene } from "./encode";
import { parseHeader } from "./encode";
import {
  ABI_MAGIC,
  ABI_VERSION,
  GPU_USAGE_STORAGE_BUFFER,
  HEADER_SIZE,
  SURFACE_STRIDE,
  sceneSectionLayout,
} from "./layout";
import type { EncodedHeader } from "./layout";

/**
 * #24 GPU upload owner — owns the GPU-side allocations for one encoded
 * scene and moves host bytes to the GPU between normal frames.
 *
 * Guarantees:
 *
 * - BATCHED uploads: every transfer is a single `GPUQueue.writeBuffer`
 *   call per non-empty section, issued back-to-back inside one `upload()`
 *   with no per-call sync, no `mapAsync` and NO CPU readback of any kind
 *   (the injected device interface does not even expose a readback path)
 * - ALLOCATION REUSE: a GPU allocation is kept while it is at least as
 *   large as the section it hosts; uploads only grow (dispose + recreate)
 *   when a section outgrows its allocation, and never shrink, so steady
 *   scenes allocate once and reuse forever
 * - COMPLETE BINDINGS: every section — including EMPTY ones (mask records,
 *   mask pixels) — has a legal non-zero GPU allocation so a complete bind
 *   group can always be constructed; `getBindings()` exposes the stable,
 *   read-only snapshot consumed by later compute passes (#25/#26)
 * - EXPLICIT OWNERSHIP: `dispose()` destroys every owned allocation; the
 *   owner does not touch buffers it did not create
 *
 * ## Trusted-encoder boundary / validation
 *
 * Full byte-level validation is available as the opt-in
 * `validateEncodedScene`. `upload()` performs a BOUNDED structural
 * validation of the header before touching counts, offsets or the device:
 * magic, version, header size, exact total length, finite positive DPR and
 * section arithmetic that must land exactly inside the buffer. A corrupt
 * header therefore cannot request huge or out-of-range allocations.
 *
 * All allocations use `STORAGE | COPY_DST | COPY_SRC` so later compute
 * passes (#25/#26) can read them directly. The minimal structural device
 * interface makes the policy testable with a small mock device in Node.
 */
export interface GpuBufferLike {
  readonly size: number;
  destroy(): void;
}

export interface GpuQueueLike {
  writeBuffer(
    buffer: GpuBufferLike,
    dstByteOffset: number,
    source: Uint8Array,
    srcOffset?: number,
    srcSize?: number,
  ): void;
}

export interface GpuUploadDeviceLike {
  readonly queue: GpuQueueLike;
  createBuffer(desc: { size: number; usage: number }): GpuBufferLike;
}

/** Usage for every scene allocation (spec-fixed bit values). */
export const SCENE_ALLOCATION_USAGE = GPU_USAGE_STORAGE_BUFFER;

/**
 * Smallest legal allocation; empty sections get this dummy buffer.
 *
 * Sized to one full scene record (SURFACE_STRIDE, the largest stride) so a
 * complete bind group ALWAYS validates for compute consumers (#25): a
 * pipeline derives a per-binding minimum buffer size from the shader (a
 * runtime-sized array that is read requires at least one element), so a
 * 16-byte dummy would be rejected by pipelines whose shader reads the
 * section. Dummies still never carry data (logical byteLength stays 0).
 */
export const MIN_ALLOCATION_BYTES = SURFACE_STRIDE;

export interface UploadStats {
  /** number of writeBuffer calls issued (one per non-empty section) */
  writeCalls: number;
  /** host bytes transferred this frame */
  bytesUploaded: number;
  /** total GPU allocations currently owned (always 5 after first upload) */
  allocationCount: number;
  /** GPU buffers created by this upload (0 on a fully reused frame) */
  newAllocations: number;
}

export interface UploadBinding {
  /** GPU allocation; never undefined while the uploader holds a scene */
  buffer: GpuBufferLike;
  /** logical bytes of the encoded section (0 for an empty section) */
  byteLength: number;
}

/** Stable read-only binding snapshot for compute passes (#25/#26). */
export interface SceneBindings {
  /** 128-byte scene header (uniform-like storage binding) */
  header: UploadBinding;
  /** array<SurfaceRecord> */
  surfaces: UploadBinding;
  /** array<MaskRecord> */
  masks: UploadBinding;
  /** mask alpha payloads (array<u32> view) */
  maskPixels: UploadBinding;
  /** array<MaterialRecord> */
  materials: UploadBinding;
  /** total encoded scene byte length (== encoded.bytes.byteLength) */
  sceneByteLength: number;
  /**
   * Read-only O(1) provenance identity: the EXACT `bytes` object of the
   * last encoded scene uploaded (a reference, never a scene-section copy).
   * Consumers compare it by reference to the scene they are about to
   * dispatch, so same-length bindings from a DIFFERENT scene are rejected
   * before any device call (#25). Never mutate the referenced bytes.
   */
  provenance: Uint8Array;
}

type SectionName = "header" | "surfaces" | "masks" | "maskPixels" | "materials";

export class SceneUploader {
  private readonly allocations = new Map<SectionName, GpuBufferLike>();
  private readonly sectionByteLengths = new Map<SectionName, number>();
  private sceneByteLength = 0;
  private provenance: Uint8Array | null = null;
  private newAllocations = 0;

  constructor(private readonly device: GpuUploadDeviceLike) {}

  /**
   * Upload one encoded scene; see class docs for batching/reuse policy.
   * Rejects corrupt headers (bounded structural validation) before any
   * allocation or device call. Records the exact `scene.bytes` object as
   * the O(1) provenance identity of the resulting bindings.
   */
  upload(scene: EncodedScene): UploadStats {
    const header = assertBoundedSceneStructure(scene.bytes);
    const layout = sceneSectionLayout(header);
    const sections: Array<[SectionName, number, number]> = [
      ["header", 0, layout.headerByteLength],
      ["surfaces", layout.surfacesOffset, layout.surfacesByteLength],
      ["masks", layout.masksOffset, layout.masksByteLength],
      ["materials", layout.materialsOffset, layout.materialsByteLength],
      ["maskPixels", layout.maskPixelsOffset, layout.maskPixelsByteLength],
    ];
    this.sceneByteLength = scene.bytes.byteLength;
    this.provenance = scene.bytes;
    let writeCalls = 0;
    let bytesUploaded = 0;
    for (const [name, offset, byteLength] of sections) {
      const buffer = this.ensureAllocation(name, byteLength);
      this.sectionByteLengths.set(name, byteLength);
      if (byteLength === 0) {
        continue; // empty section: dummy allocation, nothing to transfer
      }
      this.device.queue.writeBuffer(buffer, 0, scene.bytes.subarray(offset, offset + byteLength));
      writeCalls += 1;
      bytesUploaded += byteLength;
    }
    const created = this.newAllocations;
    this.newAllocations = 0;
    return {
      writeCalls,
      bytesUploaded,
      allocationCount: this.allocations.size,
      newAllocations: created,
    };
  }

  /**
   * Stable read-only binding snapshot. Buffers are never exposed for
   * writing; later passes bind them DIRECTLY (they must never be copied
   * into new host/GPU buffers) and create their own write targets when
   * they produce data. `provenance` is the exact `bytes` object of the
   * last uploaded scene (O(1) identity, never a copy). Throws if no scene
   * is currently bound (never uploaded or disposed).
   */
  getBindings(): SceneBindings {
    if (this.sceneByteLength === 0 || this.allocations.size === 0 || this.provenance === null) {
      throw new Error("no scene bound: upload() has not been called or dispose() was called");
    }
    const binding = (name: SectionName): UploadBinding => {
      const buffer = this.allocations.get(name);
      if (buffer === undefined) {
        throw new Error(`missing allocation for section ${name}`);
      }
      return { buffer, byteLength: this.sectionByteLengths.get(name) ?? 0 };
    };
    return {
      header: binding("header"),
      surfaces: binding("surfaces"),
      masks: binding("masks"),
      maskPixels: binding("maskPixels"),
      materials: binding("materials"),
      sceneByteLength: this.sceneByteLength,
      provenance: this.provenance,
    };
  }

  /** Destroy every owned GPU allocation. Idempotent. */
  dispose(): void {
    for (const buffer of this.allocations.values()) {
      buffer.destroy();
    }
    this.allocations.clear();
    this.sectionByteLengths.clear();
    this.sceneByteLength = 0;
    this.provenance = null;
    this.newAllocations = 0;
  }

  private ensureAllocation(name: SectionName, byteLength: number): GpuBufferLike {
    const required = Math.max(byteLength, MIN_ALLOCATION_BYTES);
    const current = this.allocations.get(name);
    if (current !== undefined && current.size >= required) {
      return current;
    }
    if (current !== undefined) {
      current.destroy();
    }
    const created = this.device.createBuffer({ size: required, usage: SCENE_ALLOCATION_USAGE });
    this.allocations.set(name, created);
    this.newAllocations += 1;
    return created;
  }
}

/**
 * Bounded structural validation run by `upload()` before any allocation:
 * magic, version, header size, exact total length, finite positive DPR and
 * section arithmetic that lands exactly inside the buffer. Returns the
 * parsed header on success; throws with a specific message otherwise.
 * Full byte-level validation is the opt-in `validateEncodedScene`.
 */
export function assertBoundedSceneStructure(bytes: Uint8Array): EncodedHeader {
  const header = parseHeader(bytes);
  if (header.magic !== ABI_MAGIC) {
    throw new Error(`invalid magic 0x${header.magic.toString(16)}`);
  }
  if (header.version !== ABI_VERSION) {
    throw new Error(`unsupported ABI version ${header.version}`);
  }
  if (header.headerSize !== HEADER_SIZE) {
    throw new Error(`invalid header size ${header.headerSize}`);
  }
  if (header.totalByteLength !== bytes.byteLength) {
    throw new Error(
      `totalByteLength ${header.totalByteLength} != buffer length ${bytes.byteLength}`,
    );
  }
  if (!(Number.isFinite(header.dpr) && header.dpr > 0)) {
    throw new Error(`dpr must be finite and > 0, got ${header.dpr}`);
  }
  const layout = sceneSectionLayout(header);
  const sections: Array<[string, number, number]> = [
    ["header", 0, layout.headerByteLength],
    ["surfaces", layout.surfacesOffset, layout.surfacesByteLength],
    ["masks", layout.masksOffset, layout.masksByteLength],
    ["materials", layout.materialsOffset, layout.materialsByteLength],
    ["maskPixels", layout.maskPixelsOffset, layout.maskPixelsByteLength],
  ];
  for (const [name, offset, byteLength] of sections) {
    if (!(byteLength >= 0 && offset + byteLength <= bytes.byteLength)) {
      throw new Error(
        `${name} section range [${offset}, ${offset + byteLength}) exceeds buffer length ${bytes.byteLength}`,
      );
    }
  }
  return header;
}
