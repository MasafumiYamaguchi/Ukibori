import { NO_OWNER } from "../compose";
import { resolveMaterial } from "../material";
import { isFiniteNumber } from "../math";
import type { MaskSource, Scene } from "../scene";
import type { EncodedHeader } from "./layout";
import {
  ABI_MAGIC,
  ABI_VERSION,
  ALPHA_FORMAT_F32,
  ALPHA_FORMAT_U8,
  FLAG_CASTS_SHADOW,
  FLAG_RECEIVES_SHADOW,
  HEADER_SIZE,
  MASK_OFFSET_ALPHA_BYTE_LENGTH,
  MASK_OFFSET_ALPHA_FORMAT,
  MASK_OFFSET_HEIGHT,
  MASK_OFFSET_PIXEL_OFFSET,
  MASK_OFFSET_WIDTH,
  MASK_STRIDE,
  MATERIAL_OFFSET_BASE_COLOR,
  MATERIAL_OFFSET_FLAGS,
  MATERIAL_OFFSET_IOR,
  MATERIAL_OFFSET_METALLIC,
  MATERIAL_OFFSET_ROUGHNESS,
  MATERIAL_STRIDE,
  PROFILE_BEVEL,
  PROFILE_FLAT,
  SCENE_FLAG_DEFAULT,
  SHAPE_MASK,
  SHAPE_ROUNDED_RECT,
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
  SURFACE_STRIDE,
} from "./layout";

/**
 * #24 host-side encoder — a pure, deterministic `Scene` + DPR -> ABI v2
 * bytes mapping with no DOM, no callbacks and no host objects leaking into
 * the buffer.
 *
 * Determinism guarantees:
 *
 * - surfaces are emitted in `scene.surfaces` ARRAY order; `objectId` and
 *   `paintOrder` both equal the array index, so the CPU renderer's
 *   "later surface (higher index) wins exact-height ties" rule is encoded
 *   as an ordering invariant (#13/#24 tie rule)
 * - the material table is packed in first-appearance order with each ref
 *   resolved through `resolveMaterial` (scene overrides, then built-in
 *   presets) — identical to `composeHeightField`'s material-id semantics
 * - masks are packed in first-appearance order by `MaskSource` object
 *   identity (shared masks dedupe)
 * - every float is f32-rounded with `Math.fround` and written little-endian;
 *   Float32 mask alpha payloads are packed PER ELEMENT through a
 *   little-endian DataView (native-endian backing bytes are never copied),
 *   while Uint8 payloads are copied byte-for-byte
 *
 * The input scene is assumed to already be validated (`createScene`); the
 * encoder still throws on structurally invalid input rather than emitting
 * garbage, and `validateEncodedScene` re-checks the BYTES independently.
 *
 * ## DPR / render dimensions
 *
 * `dpr` must be finite and > 0. Render dimensions derive from the logical
 * scene dimensions WITHOUT mutating the scene geometry, using floor to match
 * the existing DOM/reference path:
 *
 *     renderWidth  = max(1, floor(logicalWidth  * f32(dpr)))
 *     renderHeight = max(1, floor(logicalHeight * f32(dpr)))
 *
 * A render texel at integer (tx, ty) samples logical scene coordinates
 * `((tx + 0.5) / dpr, (ty + 0.5) / dpr)` (`texelCenterToLogical`); the
 * `(tx + 0.5)` mapping alone is only correct at DPR 1.
 */
export interface EncodedScene {
  /** ABI v2 little-endian scene bytes (see layout.ts). */
  bytes: Uint8Array;
}

interface EncodedMaterial {
  baseColor: [number, number, number];
  roughness: number;
  metallic: number;
  ior: number;
}

/**
 * Encode a validated scene at a device pixel ratio into the ABI v2 byte
 * buffer. Deterministic: the same scene and DPR always produce identical
 * bytes.
 */
export function encodeScene(scene: Scene, dpr: number): EncodedScene {
  assertFinitePositive(dpr, "devicePixelRatio");
  const dprF = Math.fround(dpr);
  const renderWidth = Math.max(1, Math.floor(scene.width * dprF));
  const renderHeight = Math.max(1, Math.floor(scene.height * dprF));

  const surfaceCount = scene.surfaces.length;
  const materialRefs: string[] = [];
  const materials: EncodedMaterial[] = [];
  const masks: MaskSource[] = [];
  const maskBlobs: Uint8Array[] = [];
  const maskIndexByMask = new Map<MaskSource, number>();

  for (const surface of scene.surfaces) {
    if (!materialRefs.includes(surface.material)) {
      materialRefs.push(surface.material);
      const resolved = resolveMaterial(scene.materials, surface.material);
      materials.push({
        baseColor: [
          Math.fround(resolved.baseColor.r),
          Math.fround(resolved.baseColor.g),
          Math.fround(resolved.baseColor.b),
        ],
        roughness: Math.fround(resolved.roughness),
        metallic: Math.fround(resolved.metallic),
        ior: Math.fround(resolved.ior ?? 1.5),
      });
    }
    if (surface.shape.kind === "mask" && !maskIndexByMask.has(surface.shape.mask)) {
      maskIndexByMask.set(surface.shape.mask, masks.length);
      masks.push(surface.shape.mask);
      const alpha = surface.shape.mask.alpha;
      const blob = packMaskAlpha(alpha);
      maskBlobs.push(blob);
    }
  }

  const maskCount = masks.length;
  const materialCount = materials.length;

  const surfacesOffset = HEADER_SIZE;
  const masksOffset = surfacesOffset + surfaceCount * SURFACE_STRIDE;
  const materialsOffset = masksOffset + maskCount * MASK_STRIDE;
  const maskPixelsOffset = materialsOffset + materialCount * MATERIAL_STRIDE;

  let maskPixelsByteLength = 0;
  const paddedBlobLengths: number[] = [];
  for (const blob of maskBlobs) {
    const padded = align16(blob.byteLength);
    paddedBlobLengths.push(padded);
    maskPixelsByteLength += padded;
  }

  const totalByteLength = maskPixelsOffset + maskPixelsByteLength;
  const bytes = new Uint8Array(totalByteLength);
  const view = new DataView(bytes.buffer);
  bytes.fill(0);

  // Header.
  writeU32(view, 0, ABI_MAGIC);
  writeU32(view, 4, ABI_VERSION);
  writeU32(view, 8, HEADER_SIZE);
  writeU32(view, 12, totalByteLength);
  writeU32(view, 16, scene.width);
  writeU32(view, 20, scene.height);
  writeU32(view, 24, renderWidth);
  writeU32(view, 28, renderHeight);
  writeF32(view, 32, dprF);
  writeU32(view, 36, surfaceCount);
  writeU32(view, 40, maskCount);
  writeU32(view, 44, materialCount);
  writeU32(view, 48, SCENE_FLAG_DEFAULT);
  writeF32(view, 64, Math.fround(scene.light.direction.x));
  writeF32(view, 68, Math.fround(scene.light.direction.y));
  writeF32(view, 72, Math.fround(scene.light.direction.z));
  writeF32(view, 80, Math.fround(scene.light.intensity));
  writeF32(view, 84, Math.fround(scene.exposure));
  // #41 soft-shadow light size (radians; 0 = hard). createScene already
  // sanitized the value to a finite non-negative f32.
  writeF32(view, 88, Math.fround(scene.light.angularRadius ?? 0));
  writeF32(view, 96, Math.fround(scene.environment.intensity));
  writeF32(view, 100, Math.fround(scene.environment.diffuseIntensity));
  writeF32(view, 104, Math.fround(scene.environment.specularIntensity));
  // #45 directional-light linear RGB color at 112..124 (w stays 0 — the
  // buffer is zero-filled). createScene already sanitized the channels to
  // canonical f32 values (missing/non-finite/negative/f32-overflow -> 1,
  // zero stays valid, HDR values > 1 preserved); the fround below is the
  // idempotent ABI pack of that canonical value.
  writeF32(view, 112, Math.fround(scene.light.color.r));
  writeF32(view, 116, Math.fround(scene.light.color.g));
  writeF32(view, 120, Math.fround(scene.light.color.b));

  // Surface records.
  let pixelCursor = maskPixelsOffset;
  for (let i = 0; i < surfaceCount; i++) {
    const surface = scene.surfaces[i];
    const record = surfacesOffset + i * SURFACE_STRIDE;
    writeU32(view, record + SURFACE_OFFSET_OBJECT_ID, i);
    writeU32(view, record + SURFACE_OFFSET_PAINT_ORDER, i);
    const shapeKind = surface.shape.kind === "mask" ? SHAPE_MASK : SHAPE_ROUNDED_RECT;
    writeU32(view, record + SURFACE_OFFSET_SHAPE_KIND, shapeKind);
    writeU32(view, record + SURFACE_OFFSET_MATERIAL_INDEX, materialRefs.indexOf(surface.material));
    writeF32(view, record + SURFACE_OFFSET_ELEVATION, Math.fround(surface.elevation));
    writeF32(view, record + SURFACE_OFFSET_THICKNESS, Math.fround(surface.thickness ?? 0));
    writeF32(view, record + SURFACE_OFFSET_BEVEL_WIDTH, Math.fround(surface.bevelWidth ?? 0));
    let flags = 0;
    if (surface.castsShadow) flags |= FLAG_CASTS_SHADOW;
    if (surface.receivesShadow) flags |= FLAG_RECEIVES_SHADOW;
    writeU32(view, record + SURFACE_OFFSET_FLAGS, flags);
    writeU32(
      view,
      record + SURFACE_OFFSET_PROFILE_KIND,
      surface.profile.kind === "bevel" ? PROFILE_BEVEL : PROFILE_FLAT,
    );
    if (surface.shape.kind === "mask") {
      const maskIndex = maskIndexByMask.get(surface.shape.mask)!;
      writeU32(view, record + SURFACE_OFFSET_MASK_INDEX, maskIndex);
    } else {
      writeU32(view, record + SURFACE_OFFSET_MASK_INDEX, NO_OWNER);
      writeF32(
        view,
        record + SURFACE_OFFSET_RADIUS,
        Math.fround((surface.shape as { kind: "roundedRect"; radius: number }).radius),
      );
    }
    const tx = Math.fround(surface.position.x);
    const ty = Math.fround(surface.position.y);
    writeF32(view, record + SURFACE_OFFSET_TRANSFORM_ROW0 + 0, 1);
    writeF32(view, record + SURFACE_OFFSET_TRANSFORM_ROW0 + 4, 0);
    writeF32(view, record + SURFACE_OFFSET_TRANSFORM_ROW0 + 8, tx);
    writeF32(view, record + SURFACE_OFFSET_TRANSFORM_ROW1 + 0, 0);
    writeF32(view, record + SURFACE_OFFSET_TRANSFORM_ROW1 + 4, 1);
    writeF32(view, record + SURFACE_OFFSET_TRANSFORM_ROW1 + 8, ty);
    const sx = Math.fround(surface.size.x);
    const sy = Math.fround(surface.size.y);
    writeF32(view, record + SURFACE_OFFSET_LOCAL_SIZE + 0, sx);
    writeF32(view, record + SURFACE_OFFSET_LOCAL_SIZE + 4, sy);
    const corners: Array<[number, number]> = [
      [0, 0],
      [sx, 0],
      [0, sy],
      [sx, sy],
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [lx, ly] of corners) {
      const sceneX = 1 * lx + 0 * ly + tx;
      const sceneY = 0 * lx + 1 * ly + ty;
      minX = Math.min(minX, sceneX);
      minY = Math.min(minY, sceneY);
      maxX = Math.max(maxX, sceneX);
      maxY = Math.max(maxY, sceneY);
    }
    writeF32(view, record + SURFACE_OFFSET_BOUNDS + 0, Math.fround(minX));
    writeF32(view, record + SURFACE_OFFSET_BOUNDS + 4, Math.fround(minY));
    writeF32(view, record + SURFACE_OFFSET_BOUNDS + 8, Math.fround(maxX));
    writeF32(view, record + SURFACE_OFFSET_BOUNDS + 12, Math.fround(maxY));
  }

  // Mask records + alpha blobs.
  for (let i = 0; i < maskCount; i++) {
    const mask = masks[i];
    const record = masksOffset + i * MASK_STRIDE;
    writeU32(view, record + MASK_OFFSET_WIDTH, mask.width);
    writeU32(view, record + MASK_OFFSET_HEIGHT, mask.height);
    const alpha = mask.alpha;
    const format = alpha instanceof Float32Array ? ALPHA_FORMAT_F32 : ALPHA_FORMAT_U8;
    writeU32(view, record + MASK_OFFSET_ALPHA_FORMAT, format);
    writeU32(view, record + MASK_OFFSET_ALPHA_BYTE_LENGTH, alpha.byteLength);
    writeU32(view, record + MASK_OFFSET_PIXEL_OFFSET, pixelCursor);
    const blob = maskBlobs[i];
    bytes.set(blob, pixelCursor);
    pixelCursor += paddedBlobLengths[i];
  }

  // Material records.
  for (let i = 0; i < materialCount; i++) {
    const m = materials[i];
    const record = materialsOffset + i * MATERIAL_STRIDE;
    writeF32(view, record + MATERIAL_OFFSET_BASE_COLOR + 0, m.baseColor[0]);
    writeF32(view, record + MATERIAL_OFFSET_BASE_COLOR + 4, m.baseColor[1]);
    writeF32(view, record + MATERIAL_OFFSET_BASE_COLOR + 8, m.baseColor[2]);
    writeF32(view, record + MATERIAL_OFFSET_ROUGHNESS, m.roughness);
    writeF32(view, record + MATERIAL_OFFSET_METALLIC, m.metallic);
    writeF32(view, record + MATERIAL_OFFSET_IOR, m.ior);
    writeU32(view, record + MATERIAL_OFFSET_FLAGS, 0);
  }

  return { bytes };
}

/**
 * Parse and structurally validate the header of an encoded scene. Throws on
 * malformed input; byte-level content validation is `validateEncodedScene`.
 */
export function parseHeader(bytes: Uint8Array): EncodedHeader {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("encoded scene must be a Uint8Array");
  }
  if (bytes.byteLength < HEADER_SIZE) {
    throw new RangeError(`encoded scene too short: ${bytes.byteLength} < ${HEADER_SIZE}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    magic: view.getUint32(0, true),
    version: view.getUint32(4, true),
    headerSize: view.getUint32(8, true),
    totalByteLength: view.getUint32(12, true),
    logicalWidth: view.getUint32(16, true),
    logicalHeight: view.getUint32(20, true),
    renderWidth: view.getUint32(24, true),
    renderHeight: view.getUint32(28, true),
    dpr: view.getFloat32(32, true),
    surfaceCount: view.getUint32(36, true),
    maskCount: view.getUint32(40, true),
    materialCount: view.getUint32(44, true),
    coordinateFlags: view.getUint32(48, true),
    lightDirection: {
      x: view.getFloat32(64, true),
      y: view.getFloat32(68, true),
      z: view.getFloat32(72, true),
    },
    lightIntensity: view.getFloat32(80, true),
    exposure: view.getFloat32(84, true),
    lightAngularRadius: view.getFloat32(88, true),
    lightColor: {
      r: view.getFloat32(112, true),
      g: view.getFloat32(116, true),
      b: view.getFloat32(120, true),
    },
    environment: {
      intensity: view.getFloat32(96, true),
      diffuseIntensity: view.getFloat32(100, true),
      specularIntensity: view.getFloat32(104, true),
    },
  };
}

function align16(length: number): number {
  return Math.ceil(length / 16) * 16;
}

/**
 * Pack a mask alpha payload into the ABI byte representation:
 * Uint8Array payloads are copied byte-for-byte; Float32Array payloads are
 * packed PER ELEMENT through a little-endian DataView so the encoded bytes
 * are little-endian on every host (native-endian backing bytes are never
 * copied). `MaskSource.alpha` may be a non-zero-byteOffset view; only the
 * viewed elements are packed.
 */
function packMaskAlpha(alpha: Float32Array | Uint8Array): Uint8Array {
  if (alpha instanceof Uint8Array) {
    return new Uint8Array(
      alpha.buffer.slice(alpha.byteOffset, alpha.byteOffset + alpha.byteLength),
    );
  }
  const blob = new Uint8Array(alpha.byteLength);
  const view = new DataView(blob.buffer);
  for (let i = 0; i < alpha.length; i++) {
    view.setFloat32(i * 4, alpha[i], true);
  }
  return blob;
}

function writeU32(view: DataView, offset: number, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`cannot encode u32 ${value}`);
  }
  view.setUint32(offset, value, true);
}

function writeF32(view: DataView, offset: number, value: number): void {
  if (!isFiniteNumber(value)) {
    throw new TypeError(`cannot encode non-finite f32 ${String(value)}`);
  }
  view.setFloat32(offset, value, true);
}

function assertFinitePositive(v: number, label: string): void {
  if (!isFiniteNumber(v) || v <= 0) {
    throw new TypeError(`${label} must be a finite number > 0, got ${String(v)}`);
  }
}
