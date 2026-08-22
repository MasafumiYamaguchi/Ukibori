import { NO_OWNER } from "../compose";
import { parseHeader } from "./encode";
import type { EncodedHeader } from "./layout";
import {
  ABI_MAGIC,
  ABI_VERSION,
  ALPHA_FORMAT_F32,
  ALPHA_FORMAT_U8,
  FLAG_RESERVED_MASK,
  HEADER_SIZE,
  SCENE_FLAG_DEFAULT,
  SCENE_FLAG_KNOWN_MASK,
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
  sceneSectionLayout,
} from "./layout";

/**
 * #24 strict validator — checks the ACTUAL ENCODED BYTES of an ABI v1 scene,
 * never the source `Scene` object. It is the byte-level counterpart of
 * `encodeScene` and is safe for Node unit tests and for defending later GPU
 * uploads against corrupted or foreign buffers.
 *
 * Rejected (each with a specific error message):
 *
 * - malformed headers: wrong magic, unsupported version, wrong header size,
 *   length mismatch, missing/unknown coordinate flags, nonzero reserved/
 *   padding bytes
 * - invalid counts / section ranges and wrong or misaligned offsets / byte
 *   lengths (mask pixel offsets must match the sequential cursor layout)
 * - non-finite values anywhere
 * - invalid enum (shapeKind / profileKind / alphaFormat) or flag values
 *   (reserved surface flag bits, material flags)
 * - duplicate or out-of-range object ids (`objectId`/`paintOrder` must equal
 *   the record index, materialIndex/maskIndex must be in range)
 * - invalid referenced material/mask ranges, including `maskIndex` not
 *   `NO_OWNER` on non-mask shapes and mask alpha byte ranges beyond the
 *   buffer or past the mask-pixel section
 * - inconsistent derived data: render dimensions must equal
 *   `max(1, floor(logical * dpr))`, bounds must equal the conservative
 *   transformed footprint, mask alpha lengths must equal the exact pixel
 *   raster size, f32 alpha must be finite and in [0, 1]
 *
 * The validator never throws for invalid content; `ok: false` with a
 * non-empty `errors` list is the contract. `parseHeader` remains the
 * throwing structural parser used by the uploader.
 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  header?: EncodedHeader;
}

export function validateEncodedScene(bytes: Uint8Array): ValidationResult {
  const errors: string[] = [];
  const check = (condition: boolean, message: string): void => {
    if (!condition) {
      errors.push(message);
    }
  };

  let header: EncodedHeader;
  try {
    header = parseHeader(bytes);
  } catch (error) {
    check(false, error instanceof Error ? error.message : String(error));
    return { ok: false, errors };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readF32 = (offset: number): number => view.getFloat32(offset, true);
  const readU32 = (offset: number): number => view.getUint32(offset, true);

  check(header.magic === ABI_MAGIC, `invalid magic 0x${header.magic.toString(16)}`);
  check(header.version === ABI_VERSION, `unsupported ABI version ${header.version}`);
  check(header.headerSize === HEADER_SIZE, `invalid header size ${header.headerSize}`);
  check(bytes.byteLength === header.totalByteLength, "totalByteLength does not match buffer length");
  check(header.logicalWidth > 0, `logicalWidth must be > 0, got ${header.logicalWidth}`);
  check(header.logicalHeight > 0, `logicalHeight must be > 0, got ${header.logicalHeight}`);
  check(isFinitePositive(header.dpr), `dpr must be finite and > 0, got ${header.dpr}`);
  check(
    header.renderWidth === renderDimension(header.logicalWidth, header.dpr),
    `renderWidth ${header.renderWidth} != max(1, floor(logicalWidth * dpr))`,
  );
  check(
    header.renderHeight === renderDimension(header.logicalHeight, header.dpr),
    `renderHeight ${header.renderHeight} != max(1, floor(logicalHeight * dpr))`,
  );

  check(
    header.coordinateFlags === SCENE_FLAG_DEFAULT,
    `coordinate flags 0x${header.coordinateFlags.toString(16)} != expected 0x${SCENE_FLAG_DEFAULT.toString(16)} (origin top-left | +y down)`,
  );
  check(
    (header.coordinateFlags & ~SCENE_FLAG_KNOWN_MASK) === 0,
    `unknown coordinate flag bits: 0x${(header.coordinateFlags & ~SCENE_FLAG_KNOWN_MASK).toString(16)}`,
  );
  for (let offset = 52; offset < 64; offset += 4) {
    check(readU32(offset) === 0, `header reserved u32 at ${offset} must be 0`);
  }
  // Offset 88 carries the #41 light angular radius (radians, f32): finite
  // and >= 0 after packing; offset 92 stays reserved-zero.
  const angularRadius = readF32(88);
  check(
    Number.isFinite(angularRadius) && angularRadius >= 0,
    `light angular radius at offset 88 must be a finite non-negative f32, got ${angularRadius}`,
  );
  check(readU32(92) === 0, "header reserved u32 at offset 92 must be 0");
  for (let offset = 112; offset < HEADER_SIZE; offset += 4) {
    check(readU32(offset) === 0, `header reserved u32 at ${offset} must be 0`);
  }
  check(readU32(76) === 0, "light direction padding (offset 76) must be 0");
  check(readU32(108) === 0, "environment padding (offset 108) must be 0");

  const lx = readF32(64);
  const ly = readF32(68);
  const lz = readF32(72);
  const lightLen = Math.hypot(lx, ly, lz);
  check(
    isFinite(lx) && isFinite(ly) && isFinite(lz) && Math.abs(lightLen - 1) < 1e-3,
    `light direction must be a unit vector, got (${lx}, ${ly}, ${lz})`,
  );
  check(
    isFiniteNonNegative(header.lightIntensity),
    `light intensity must be finite and >= 0, got ${header.lightIntensity}`,
  );
  check(
    isFiniteNonNegative(header.exposure),
    `exposure must be finite and >= 0, got ${header.exposure}`,
  );
  const env = header.environment;
  check(
    isFiniteNonNegative(env.intensity),
    `environment intensity must be finite and >= 0, got ${env.intensity}`,
  );
  for (const [label, value] of [
    ["diffuseIntensity", env.diffuseIntensity],
    ["specularIntensity", env.specularIntensity],
  ] as const) {
    check(
      isFiniteNumber(value) && value >= 0 && value <= 1,
      `environment ${label} must be finite in [0, 1], got ${value}`,
    );
  }

  const layout = sceneSectionLayout(header);
  check(
    layout.totalByteLength <= bytes.byteLength,
    "section ranges exceed the buffer length",
  );

  // Surface records.
  if (checkSectionRange(layout.surfacesOffset, layout.surfacesByteLength, bytes, check)) {
    for (let i = 0; i < header.surfaceCount; i++) {
      const record = layout.surfacesOffset + i * SURFACE_STRIDE;
      const label = `surface[${i}]`;
      const objectId = readU32(record + SURFACE_OFFSET_OBJECT_ID);
      check(objectId === i, `${label} objectId ${objectId} != record index ${i}`);
      const paintOrder = readU32(record + SURFACE_OFFSET_PAINT_ORDER);
      check(paintOrder === i, `${label} paintOrder ${paintOrder} != record index ${i}`);
      const shapeKind = readU32(record + SURFACE_OFFSET_SHAPE_KIND);
      check(
        shapeKind === SHAPE_ROUNDED_RECT || shapeKind === SHAPE_MASK,
        `${label} invalid shapeKind ${shapeKind}`,
      );
      const profileKind = readU32(record + SURFACE_OFFSET_PROFILE_KIND);
      check(
        profileKind === PROFILE_FLAT || profileKind === PROFILE_BEVEL,
        `${label} invalid profileKind ${profileKind}`,
      );
      const materialIndex = readU32(record + SURFACE_OFFSET_MATERIAL_INDEX);
      check(
        materialIndex < header.materialCount,
        `${label} materialIndex ${materialIndex} out of range (< ${header.materialCount})`,
      );
      const maskIndex = readU32(record + SURFACE_OFFSET_MASK_INDEX);
      if (shapeKind === SHAPE_MASK) {
        check(maskIndex < header.maskCount, `${label} maskIndex ${maskIndex} out of range (< ${header.maskCount})`);
      } else {
        check(maskIndex === NO_OWNER, `${label} maskIndex must be NO_OWNER on non-mask shapes, got ${maskIndex}`);
      }
      for (const [offset, name] of [
        [SURFACE_OFFSET_ELEVATION, "elevation"],
        [SURFACE_OFFSET_THICKNESS, "thickness"],
        [SURFACE_OFFSET_BEVEL_WIDTH, "bevelWidth"],
      ] as const) {
        const value = readF32(record + offset);
        check(isFiniteNonNegative(value), `${label} ${name} must be finite and >= 0, got ${value}`);
      }
      const radius = readF32(record + SURFACE_OFFSET_RADIUS);
      check(isFiniteNonNegative(radius), `${label} radius must be finite and >= 0, got ${radius}`);
      if (shapeKind === SHAPE_MASK) {
        check(radius === 0, `${label} radius must be 0 for mask shapes, got ${radius}`);
      }
      const flags = readU32(record + SURFACE_OFFSET_FLAGS);
      check(
        (flags & FLAG_RESERVED_MASK) === 0,
        `${label} reserved flag bits set: 0x${(flags & FLAG_RESERVED_MASK).toString(16)}`,
      );
      check(readU32(record + 44) === 0, `${label} reserved0 must be 0`);
      const row0 = [
        readF32(record + SURFACE_OFFSET_TRANSFORM_ROW0 + 0),
        readF32(record + SURFACE_OFFSET_TRANSFORM_ROW0 + 4),
        readF32(record + SURFACE_OFFSET_TRANSFORM_ROW0 + 8),
      ];
      const row1 = [
        readF32(record + SURFACE_OFFSET_TRANSFORM_ROW1 + 0),
        readF32(record + SURFACE_OFFSET_TRANSFORM_ROW1 + 4),
        readF32(record + SURFACE_OFFSET_TRANSFORM_ROW1 + 8),
      ];
      check(row0.every(isFiniteNumber) && row1.every(isFiniteNumber), `${label} transform must be finite`);
      check(readU32(record + SURFACE_OFFSET_TRANSFORM_ROW0 + 12) === 0, `${label} transform row0 padding must be 0`);
      check(readU32(record + SURFACE_OFFSET_TRANSFORM_ROW1 + 12) === 0, `${label} transform row1 padding must be 0`);
      const sizeX = readF32(record + SURFACE_OFFSET_LOCAL_SIZE + 0);
      const sizeY = readF32(record + SURFACE_OFFSET_LOCAL_SIZE + 4);
      check(sizeX > 0 && isFinite(sizeX), `${label} local size.x must be finite and > 0, got ${sizeX}`);
      check(sizeY > 0 && isFinite(sizeY), `${label} local size.y must be finite and > 0, got ${sizeY}`);
      check(
        readU32(record + SURFACE_OFFSET_LOCAL_SIZE + 8) === 0 &&
          readU32(record + SURFACE_OFFSET_LOCAL_SIZE + 12) === 0,
        `${label} localSize padding must be 0`,
      );
      const boundsMinX = readF32(record + SURFACE_OFFSET_BOUNDS + 0);
      const boundsMinY = readF32(record + SURFACE_OFFSET_BOUNDS + 4);
      const boundsMaxX = readF32(record + SURFACE_OFFSET_BOUNDS + 8);
      const boundsMaxY = readF32(record + SURFACE_OFFSET_BOUNDS + 12);
      check(
        [boundsMinX, boundsMinY, boundsMaxX, boundsMaxY].every(isFiniteNumber) &&
          boundsMinX <= boundsMaxX &&
          boundsMinY <= boundsMaxY,
        `${label} bounds must be finite with min <= max`,
      );
      const expected = conservativeBounds(row0, row1, sizeX, sizeY);
      check(
        boundsMinX === expected[0] &&
          boundsMinY === expected[1] &&
          boundsMaxX === expected[2] &&
          boundsMaxY === expected[3],
        `${label} bounds (${boundsMinX}, ${boundsMinY}, ${boundsMaxX}, ${boundsMaxY}) != conservative footprint (${expected})`,
      );
      for (let offset = 112; offset < 128; offset += 4) {
        check(readU32(record + offset) === 0, `${label} reserved1 byte at ${offset} must be 0`);
      }
    }
  }

  // Mask records + pixel blobs.
  if (checkSectionRange(layout.masksOffset, layout.masksByteLength, bytes, check)) {
    let expectedPixelOffset = layout.maskPixelsOffset;
    for (let i = 0; i < header.maskCount; i++) {
      const record = layout.masksOffset + i * MASK_STRIDE;
      const label = `mask[${i}]`;
      const width = readU32(record + MASK_OFFSET_WIDTH);
      const height = readU32(record + MASK_OFFSET_HEIGHT);
      const format = readU32(record + MASK_OFFSET_ALPHA_FORMAT);
      const byteLength = readU32(record + MASK_OFFSET_ALPHA_BYTE_LENGTH);
      const pixelOffset = readU32(record + MASK_OFFSET_PIXEL_OFFSET);
      check(width > 0, `${label} width must be > 0, got ${width}`);
      check(height > 0, `${label} height must be > 0, got ${height}`);
      const validFormat = format === ALPHA_FORMAT_F32 || format === ALPHA_FORMAT_U8;
      check(validFormat, `${label} invalid alphaFormat ${format}`);
      if (validFormat) {
        const expectedLength = width * height * (format === ALPHA_FORMAT_F32 ? 4 : 1);
        check(
          byteLength === expectedLength,
          `${label} alphaByteLength ${byteLength} != ${expectedLength} for ${width}x${height}`,
        );
        check(
          pixelOffset === expectedPixelOffset,
          `${label} pixelOffset ${pixelOffset} != expected ${expectedPixelOffset}`,
        );
        check(
          pixelOffset >= layout.maskPixelsOffset && pixelOffset + byteLength <= bytes.byteLength,
          `${label} pixel range [${pixelOffset}, ${pixelOffset + byteLength}) outside the buffer`,
        );
        if (pixelOffset + byteLength <= bytes.byteLength) {
          for (let p = pixelOffset + byteLength; p < align16(pixelOffset + byteLength); p++) {
            check(bytes[p] === 0, `${label} blob padding byte at ${p} must be 0`);
          }
          if (format === ALPHA_FORMAT_F32) {
            for (let k = 0; k < byteLength; k += 4) {
              const alpha = view.getFloat32(pixelOffset + k, true);
              if (!(alpha >= 0 && alpha <= 1)) {
                errors.push(`${label} f32 alpha at byte ${k} must be in [0, 1], got ${alpha}`);
                break;
              }
            }
          }
        }
      }
      for (let offset = 20; offset < MASK_STRIDE; offset += 4) {
        check(readU32(record + offset) === 0, `${label} reserved u32 at ${offset} must be 0`);
      }
      expectedPixelOffset = align16(expectedPixelOffset + byteLength);
    }
  }

  // Material records.
  if (checkSectionRange(layout.materialsOffset, layout.materialsByteLength, bytes, check)) {
    for (let i = 0; i < header.materialCount; i++) {
      const record = layout.materialsOffset + i * MATERIAL_STRIDE;
      const label = `material[${i}]`;
      for (let c = 0; c < 3; c++) {
        const channel = readF32(record + MATERIAL_OFFSET_BASE_COLOR + c * 4);
        check(
          isFiniteNumber(channel) && channel >= 0 && channel <= 1,
          `${label} baseColor channel ${c} must be finite in [0, 1], got ${channel}`,
        );
      }
      const roughness = readF32(record + MATERIAL_OFFSET_ROUGHNESS);
      check(isFiniteNumber(roughness) && roughness >= 0 && roughness <= 1, `${label} roughness must be finite in [0, 1], got ${roughness}`);
      const metallic = readF32(record + MATERIAL_OFFSET_METALLIC);
      check(isFiniteNumber(metallic) && metallic >= 0 && metallic <= 1, `${label} metallic must be finite in [0, 1], got ${metallic}`);
      const ior = readF32(record + MATERIAL_OFFSET_IOR);
      check(isFiniteNumber(ior) && ior >= 1, `${label} ior must be finite and >= 1, got ${ior}`);
      check(readU32(record + MATERIAL_OFFSET_FLAGS) === 0, `${label} flags must be 0`);
      for (let offset = 28; offset < MATERIAL_STRIDE; offset += 4) {
        check(readU32(record + offset) === 0, `${label} reserved byte at ${offset} must be 0`);
      }
    }
  }

  return { ok: errors.length === 0, errors, header };
}

function renderDimension(logical: number, dpr: number): number {
  return Math.max(1, Math.floor(logical * dpr));
}

function conservativeBounds(
  row0: number[],
  row1: number[],
  sizeX: number,
  sizeY: number,
): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of [
    [0, 0],
    [sizeX, 0],
    [0, sizeY],
    [sizeX, sizeY],
  ]) {
    const sceneX = row0[0] * lx + row0[1] * ly + row0[2];
    const sceneY = row1[0] * lx + row1[1] * ly + row1[2];
    minX = Math.min(minX, sceneX);
    minY = Math.min(minY, sceneY);
    maxX = Math.max(maxX, sceneX);
    maxY = Math.max(maxY, sceneY);
  }
  return [Math.fround(minX), Math.fround(minY), Math.fround(maxX), Math.fround(maxY)];
}

function checkSectionRange(
  offset: number,
  byteLength: number,
  bytes: Uint8Array,
  check: (condition: boolean, message: string) => void,
): boolean {
  const ok = offset >= 0 && byteLength >= 0 && offset + byteLength <= bytes.byteLength;
  check(ok, `section range [${offset}, ${offset + byteLength}) exceeds buffer length ${bytes.byteLength}`);
  return ok;
}

function align16(length: number): number {
  return Math.ceil(length / 16) * 16;
}

function isFiniteNumber(v: number): boolean {
  return Number.isFinite(v);
}

function isFiniteNonNegative(v: number): boolean {
  return Number.isFinite(v) && v >= 0;
}

function isFinitePositive(v: number): boolean {
  return Number.isFinite(v) && v > 0;
}
