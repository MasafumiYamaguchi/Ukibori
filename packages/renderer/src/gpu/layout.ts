import { NO_OWNER } from "../compose";
import type { Vec2, Vec3 } from "../types";

/**
 * #24 GPU scene/buffer ABI v1 — byte-exact layout shared by the host encoder,
 * the strict validator, the GPU upload owner, and the WGSL declarations.
 *
 * This module is the SINGLE SOURCE OF TRUTH for every offset, stride and
 * sentinel. `wgsl.ts` mirrors these numbers as WGSL structs; both must stay
 * in lockstep (the layout tests pin the key constants).
 *
 * ## Coordinate semantics (fixed here, matching the #13 scene contract)
 *
 * - logical scene x/y are CSS-pixel units, +x right, +y down; the scene
 *   origin is the top-left corner of the logical region
 * - +z is toward the viewer; elevation is absolute scene-space z
 * - pixel (x, y) of a render target samples the CONTINUOUS scene position
 *   `(x + 0.5, y + 0.5)` (pixel centers) at DPR 1; at DPR > 1 the render
 *   texel at integer `(tx, ty)` samples logical scene coordinates
 *   `((tx + 0.5) / dpr, (ty + 0.5) / dpr)` (see `texelCenterToLogical`)
 * - render dimensions derive from the logical dimensions and the DPR:
 *   `render = max(1, floor(logical * dpr))` (floor, matching the existing
 *   DOM/reference path); encoding never mutates the logical scene geometry
 *
 * ## Encoding rules
 *
 * - the whole scene is ONE little-endian byte buffer; every scalar is 32-bit
 * - records are arrays with a constant stride; every section starts on a
 *   16-byte boundary and every record is 16-byte aligned
 * - all floating-point values are f32-rounded (`Math.fround`) and packed
 *   little-endian (mask alpha payloads are packed per-f32 through a
 *   little-endian DataView, never copied as native-endian backing bytes)
 * - reserved/padding bytes are always zero (strict-validated)
 * - `objectId` is the surface INDEX into `scene.surfaces` (0-based),
 *   `0xffffffff` (`NO_OWNER`) is reserved for background/no owner; surface
 *   string ids are debugging identities and are never written
 */

export const ABI_MAGIC = 0x554b4942; // "UKIB" tag, little-endian u32
export const ABI_VERSION = 1;
export const HEADER_SIZE = 128;

/**
 * Scene header (HEADER_SIZE = 128 bytes, alignment 16).
 *
 * | offset | size | field                                            |
 * |--------|------|--------------------------------------------------|
 * | 0      | 4    | magic (u32, ABI_MAGIC)                            |
 * | 4      | 4    | version (u32, ABI_VERSION)                        |
 * | 8      | 4    | headerSize (u32, 128)                             |
 * | 12     | 4    | totalByteLength (u32, == buffer length)           |
 * | 16     | 4    | logicalWidth (u32, CSS pixels)                    |
 * | 20     | 4    | logicalHeight (u32, CSS pixels)                   |
 * | 24     | 4    | renderWidth (u32, max(1, floor(logical * dpr)))   |
 * | 28     | 4    | renderHeight (u32, same rule)                     |
 * | 32     | 4    | dpr (f32, finite > 0)                             |
 * | 36     | 4    | surfaceCount (u32)                                |
 * | 40     | 4    | maskCount (u32)                                   |
 * | 44     | 4    | materialCount (u32)                               |
 * | 48     | 4    | coordinateFlags (u32, must equal SCENE_FLAG_DEFAULT) |
 * | 52..64 | 12   | reserved (u32, 0)                                 |
 * | 64     | 16   | lightDirection (vec4: x, y, z, 0; unit vector)    |
 * | 80     | 4    | lightIntensity (f32, >= 0)                        |
 * | 84     | 4    | exposure (f32, >= 0)                              |
 * | 88     | 4    | lightAngularRadius (#41 f32 radians, >= 0;        |
 * |        |      |            0 = hard shadow)                       |
 * | 92     | 4    | reserved (u32, 0)                                 |
 * | 96     | 16   | environment (vec4: intensity, diffuseIntensity,   |
 * |        |      |            specularIntensity, 0)                  |
 * | 112..128| 16  | reserved (u32, 0)                                 |
 */

export const SURFACE_STRIDE = 128;
export const MASK_STRIDE = 32;
export const MATERIAL_STRIDE = 64;

export { NO_OWNER };

/**
 * Named header coordinate flags (offset 48). The encoder always writes
 * `ORIGIN_TOP_LEFT | Y_DOWN`; the strict validator requires exactly this
 * combination so the coordinate convention is part of the ABI, not prose.
 */
export const SCENE_FLAG_ORIGIN_TOP_LEFT = 0x1;
export const SCENE_FLAG_Y_DOWN = 0x2;
export const SCENE_FLAG_KNOWN_MASK = SCENE_FLAG_ORIGIN_TOP_LEFT | SCENE_FLAG_Y_DOWN;
export const SCENE_FLAG_DEFAULT = SCENE_FLAG_ORIGIN_TOP_LEFT | SCENE_FLAG_Y_DOWN;

/**
 * Logical scene coordinate sampled by a render texel at DPR `dpr`.
 * Render pixel/texel center (tx + 0.5, ty + 0.5) maps to logical scene
 * position ((tx + 0.5) / dpr, (ty + 0.5) / dpr). Later compute passes must
 * use this mapping (or its WGSL twin) rather than guessing.
 */
export function texelCenterToLogical(texel: number, dpr: number): number {
  return (texel + 0.5) / dpr;
}

/**
 * Surface record (SURFACE_STRIDE = 128 bytes, alignment 16).
 *
 * | offset | size | field                                            |
 * |--------|------|--------------------------------------------------|
 * | 0      | 4    | objectId (u32, == record index, unique in scene)  |
 * | 4      | 4    | paintOrder (u32, == objectId; array paint order)  |
 * | 8      | 4    | shapeKind (u32: 0 = roundedRect, 1 = mask)        |
 * | 12     | 4    | materialIndex (u32, < materialCount)              |
 * | 16     | 4    | elevation (f32, absolute scene z of the base)     |
 * | 20     | 4    | thickness (f32 >= 0)                              |
 * | 24     | 4    | bevelWidth (f32 >= 0)                             |
 * | 28     | 4    | flags (u32; bit0 castsShadow, bit1 receivesShadow)|
 * | 32     | 4    | profileKind (u32: 0 = flat, 1 = bevel)            |
 * | 36     | 4    | maskIndex (u32, < maskCount when mask, else NO_OWNER) |
 * | 40     | 4    | radius (f32 >= 0, roundedRect corner radius)      |
 * | 44     | 4    | reserved0 (u32, 0)                                |
 * | 48     | 16   | localToSceneRow0 (vec4: a, b, tx, 0)              |
 * | 64     | 16   | localToSceneRow1 (vec4: c, d, ty, 0)              |
 * | 80     | 16   | bounds (vec4: minX, minY, maxX, maxY)             |
 * | 96     | 16   | localSize (vec4: width, height, 0, 0)             |
 * | 112    | 16   | reserved1 (vec4, 0)                               |
 *
 * The explicit local/scene transform maps LOCAL coordinates (origin at the
 * surface top-left, +x right, +y down, extent `localSize`) into scene
 * coordinates:
 *
 *     xScene = a * xLocal + b * yLocal + tx
 *     yScene = c * xLocal + d * yLocal + ty
 *
 * Today's `SurfaceNode` supports only position + size, so the encoder emits
 * the identity-scale transform `(1, 0, position.x), (0, 1, position.y)`.
 * Later renderer passes MUST use this transform rather than reconstructing
 * placement from `position`, keeping the ABI stable when transforms grow.
 *
 * `bounds` is the CONSERVATIVE scene-space AABB of the transformed local
 * footprint `[0, localSize.x] x [0, localSize.y]` (corners transformed,
 * min/max taken).
 */
export const SURFACE_OFFSET_OBJECT_ID = 0;
export const SURFACE_OFFSET_PAINT_ORDER = 4;
export const SURFACE_OFFSET_SHAPE_KIND = 8;
export const SURFACE_OFFSET_MATERIAL_INDEX = 12;
export const SURFACE_OFFSET_ELEVATION = 16;
export const SURFACE_OFFSET_THICKNESS = 20;
export const SURFACE_OFFSET_BEVEL_WIDTH = 24;
export const SURFACE_OFFSET_FLAGS = 28;
export const SURFACE_OFFSET_PROFILE_KIND = 32;
export const SURFACE_OFFSET_MASK_INDEX = 36;
export const SURFACE_OFFSET_RADIUS = 40;
export const SURFACE_OFFSET_TRANSFORM_ROW0 = 48;
export const SURFACE_OFFSET_TRANSFORM_ROW1 = 64;
export const SURFACE_OFFSET_BOUNDS = 80;
export const SURFACE_OFFSET_LOCAL_SIZE = 96;

/** Surface flags bit 0: the surface casts cast-shadow rays. */
export const FLAG_CASTS_SHADOW = 0x1;
/** Surface flags bit 1: the surface receives cast-shadow visibility. */
export const FLAG_RECEIVES_SHADOW = 0x2;
export const FLAG_RESERVED_MASK = ~(FLAG_CASTS_SHADOW | FLAG_RECEIVES_SHADOW) >>> 0;

/**
 * Mask record (MASK_STRIDE = 32 bytes).
 *
 * | offset | size | field                                        |
 * |--------|------|----------------------------------------------|
 * | 0      | 4    | width (u32, positive)                        |
 * | 4      | 4    | height (u32, positive)                       |
 * | 8      | 4    | alphaFormat (u32: 0 = f32, 1 = u8)           |
 * | 12     | 4    | alphaByteLength (u32, exact alpha bytes)     |
 * | 16     | 4    | pixelOffset (u32, byte offset of the blob)   |
 * | 20..32 | 12   | reserved (u32, 0)                            |
 *
 * The alpha blob lives in the mask-pixel section, byte offset `pixelOffset`,
 * `alphaByteLength` bytes, each blob padded to a 16-byte multiple (padding
 * zero). `alphaFormat` 0 is Float32Array (0..1), 1 is Uint8Array (0..255),
 * row-major, mapping onto the surface footprint isotropically (#13).
 */
export const MASK_OFFSET_WIDTH = 0;
export const MASK_OFFSET_HEIGHT = 4;
export const MASK_OFFSET_ALPHA_FORMAT = 8;
export const MASK_OFFSET_ALPHA_BYTE_LENGTH = 12;
export const MASK_OFFSET_PIXEL_OFFSET = 16;

export const ALPHA_FORMAT_F32 = 0;
export const ALPHA_FORMAT_U8 = 1;

/**
 * Material record (MATERIAL_STRIDE = 64 bytes).
 *
 * | offset | size | field                                  |
 * |--------|------|----------------------------------------|
 * | 0      | 12   | baseColor (vec3, LINEAR sRGB albedo)   |
 * | 12     | 4    | roughness (f32 in [0, 1])              |
 * | 16     | 4    | metallic (f32 in [0, 1])               |
 * | 20     | 4    | ior (f32 >= 1)                         |
 * | 24     | 4    | flags (u32, reserved, 0)               |
 * | 32..64 | 32   | reserved (vec4 + vec4, 0)              |
 *
 * The table is packed in FIRST-APPEARANCE order across `scene.surfaces`,
 * matching `composeHeightField`'s material-id semantics, with each ref
 * resolved through `resolveMaterial` (scene overrides then built-in
 * presets). Later lighting passes index this table by `materialIndex`.
 */
export const MATERIAL_OFFSET_BASE_COLOR = 0;
export const MATERIAL_OFFSET_ROUGHNESS = 12;
export const MATERIAL_OFFSET_METALLIC = 16;
export const MATERIAL_OFFSET_IOR = 20;
export const MATERIAL_OFFSET_FLAGS = 24;

/** Record section enums. */
export const SHAPE_ROUNDED_RECT = 0;
export const SHAPE_MASK = 1;
export const PROFILE_FLAT = 0;
export const PROFILE_BEVEL = 1;

/** WebGPU `GPUBufferUsage` bit values (spec-fixed; usable in Node tests). */
export const GPU_USAGE_MAP_READ = 0x1;
export const GPU_USAGE_COPY_SRC = 0x4;
export const GPU_USAGE_COPY_DST = 0x8;
export const GPU_USAGE_STORAGE = 0x80;

export const GPU_USAGE_STORAGE_BUFFER = GPU_USAGE_STORAGE | GPU_USAGE_COPY_DST | GPU_USAGE_COPY_SRC;
export const GPU_USAGE_STAGING_BUFFER = GPU_USAGE_MAP_READ | GPU_USAGE_COPY_DST;

/**
 * Parsed scene header. All scalar fields come straight off the encoded
 * bytes; section offsets derive from the counts (see `sceneSectionLayout`).
 */
export interface EncodedHeader {
  magic: number;
  version: number;
  headerSize: number;
  totalByteLength: number;
  logicalWidth: number;
  logicalHeight: number;
  renderWidth: number;
  renderHeight: number;
  dpr: number;
  surfaceCount: number;
  maskCount: number;
  materialCount: number;
  /** named coordinate flags (offset 48); must equal SCENE_FLAG_DEFAULT */
  coordinateFlags: number;
  lightDirection: Vec3;
  lightIntensity: number;
  exposure: number;
  /** #41 light angular radius in radians (f32, >= 0; 0 = hard shadow) */
  lightAngularRadius: number;
  environment: { intensity: number; diffuseIntensity: number; specularIntensity: number };
}

/** Byte ranges of each section inside an encoded scene. */
export interface SceneSectionLayout {
  headerByteLength: number;
  surfacesOffset: number;
  surfacesByteLength: number;
  masksOffset: number;
  masksByteLength: number;
  materialsOffset: number;
  materialsByteLength: number;
  maskPixelsOffset: number;
  maskPixelsByteLength: number;
  totalByteLength: number;
}

/** Compute section byte ranges from a parsed header (16-byte aligned). */
export function sceneSectionLayout(header: EncodedHeader): SceneSectionLayout {
  const surfacesOffset = HEADER_SIZE;
  const masksOffset = surfacesOffset + header.surfaceCount * SURFACE_STRIDE;
  const materialsOffset = masksOffset + header.maskCount * MASK_STRIDE;
  const maskPixelsOffset = materialsOffset + header.materialCount * MATERIAL_STRIDE;
  const surfacesByteLength = header.surfaceCount * SURFACE_STRIDE;
  const masksByteLength = header.maskCount * MASK_STRIDE;
  const materialsByteLength = header.materialCount * MATERIAL_STRIDE;
  const maskPixelsByteLength = header.totalByteLength - maskPixelsOffset;
  return {
    headerByteLength: HEADER_SIZE,
    surfacesOffset,
    surfacesByteLength,
    masksOffset,
    masksByteLength,
    materialsOffset,
    materialsByteLength,
    maskPixelsOffset,
    maskPixelsByteLength,
    totalByteLength: header.totalByteLength,
  };
}

export const SCENE_HEADER_FIELDS = [
  "magic",
  "version",
  "headerSize",
  "totalByteLength",
  "logicalWidth",
  "logicalHeight",
  "renderWidth",
  "renderHeight",
  "dpr",
  "surfaceCount",
  "maskCount",
  "materialCount",
  "coordinateFlags",
  "lightDirection",
  "lightIntensity",
  "exposure",
  "environment",
] as const;

export type Vec2Like = Pick<Vec2, "x" | "y">;
