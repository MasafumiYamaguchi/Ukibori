import {
  ABI_MAGIC,
  ABI_VERSION,
  HEADER_SIZE,
  MASK_STRIDE,
  MATERIAL_STRIDE,
  NO_OWNER,
  SCENE_FLAG_DEFAULT,
  SCENE_FLAG_ORIGIN_TOP_LEFT,
  SCENE_FLAG_Y_DOWN,
  SURFACE_STRIDE,
} from "./layout";

/**
 * #24 WGSL layout declarations for ABI v1 — MUST match `layout.ts` exactly
 * (same offsets, strides, 32-bit scalars, little-endian storage).
 *
 * Every binding is declared as a `var<storage>` buffer so compute passes
 * (#25/#26) can consume it directly. The offset comments are pinned by the
 * layout tests. The header may also be read as a uniform-like storage
 * binding; it is intentionally NOT a `uniform` block so a single buffer can
 * be shared without re-uploading.
 *
 * Byte-exactness notes:
 *
 * - WGSL `vec3<f32>` is 16-byte aligned but 12 bytes, so `baseColor` +
 *   `roughness` pack into 16 bytes exactly like the host layout.
 * - `array<SurfaceRecord>` stride = `SURFACE_STRIDE` = 128, etc.
 * - all scalars are 32-bit; endianness is little-endian on the host and
 *   defined by WebGPU storage buffers.
 */

export const WGSL_SCENE_BASE = /* wgsl */ `
// Ukibori scene ABI v1 (magic ${ABI_MAGIC.toString(16)}, version ${ABI_VERSION},
// header ${HEADER_SIZE} bytes, sentinel NO_OWNER ${NO_OWNER}).

const SURFACE_STRIDE: u32 = ${SURFACE_STRIDE}u; // 128
const MASK_STRIDE: u32 = ${MASK_STRIDE}u; // 32
const MATERIAL_STRIDE: u32 = ${MATERIAL_STRIDE}u; // 64

// named coordinate flags (header offset 48); must equal SCENE_FLAG_DEFAULT
const COORDINATE_ORIGIN_TOP_LEFT: u32 = ${SCENE_FLAG_ORIGIN_TOP_LEFT}u;
const COORDINATE_Y_DOWN: u32 = ${SCENE_FLAG_Y_DOWN}u;
const COORDINATE_FLAGS_EXPECTED: u32 = ${SCENE_FLAG_DEFAULT}u;

// logical scene coordinate sampled by render texel (tx, ty) at DPR dpr:
// ((tx + 0.5) / dpr, (ty + 0.5) / dpr)  -- must match texelCenterToLogical
fn texelCenterToLogical(texel: u32, dpr: f32) -> f32 {
  return (f32(texel) + 0.5) / dpr;
}

// scene header, 128 bytes, 16-byte aligned
struct SceneHeader {
  magic: u32,              //  0
  version: u32,            //  4
  headerSize: u32,         //  8
  totalByteLength: u32,    // 12
  logicalWidth: u32,       // 16
  logicalHeight: u32,      // 20
  renderWidth: u32,        // 24 (max(1, floor(logical * dpr)))
  renderHeight: u32,       // 28 (max(1, floor(logical * dpr)))
  dpr: f32,                // 32
  surfaceCount: u32,       // 36
  maskCount: u32,          // 40
  materialCount: u32,      // 44
  coordinateFlags: u32,    // 48 (bit0 origin top-left, bit1 +y down)
  _reserved0: u32,         // 52
  _reserved1: u32,         // 56
  _reserved2: u32,         // 60
  lightDirection: vec4<f32>, // 64 (x, y, z, 0)
  lightIntensity: f32,     // 80
  exposure: f32,           // 84
  _reserved3: vec2<f32>,   // 88
  environment: vec4<f32>,  // 96 (intensity, diffuseIntensity, specularIntensity, 0)
  _reserved4: vec4<f32>,   // 112
}                          // size 128, align 16

// surface records, stride 128, alignment 16
struct SurfaceRecord {
  objectId: u32,           //  0 (index into scene.surfaces; NO_OWNER = background)
  paintOrder: u32,         //  4 (== objectId; array paint order, last wins ties)
  shapeKind: u32,          //  8 (0 = roundedRect, 1 = mask)
  materialIndex: u32,      // 12
  elevation: f32,          // 16 (absolute scene z of the base)
  thickness: f32,          // 20
  bevelWidth: f32,         // 24
  flags: u32,              // 28 (bit0 castsShadow, bit1 receivesShadow)
  profileKind: u32,        // 32 (0 = flat, 1 = bevel)
  maskIndex: u32,          // 36 (mask record index, or NO_OWNER)
  radius: f32,             // 40 (roundedRect corner radius)
  _reserved0: u32,         // 44
  localToSceneRow0: vec4<f32>, // 48 (a, b, tx, 0)
  localToSceneRow1: vec4<f32>, // 64 (c, d, ty, 0)
  bounds: vec4<f32>,       // 80 (minX, minY, maxX, maxY)
  localSize: vec4<f32>,    // 96 (width, height, 0, 0)
  _reserved1: vec4<f32>,   // 112
}                          // size 128, align 16

// mask records, stride 32
struct MaskRecord {
  width: u32,              //  0
  height: u32,             //  4
  alphaFormat: u32,        //  8 (0 = f32 alpha, 1 = u8 alpha)
  alphaByteLength: u32,    // 12
  pixelOffset: u32,        // 16 (byte offset of the alpha blob)
  _reserved0: u32,         // 20
  _reserved1: u32,         // 24
  _reserved2: u32,         // 28
}                          // size 32, align 4

// material records, stride 64, alignment 16
struct MaterialRecord {
  baseColor: vec3<f32>,    //  0 (LINEAR rgb)
  roughness: f32,          // 12
  metallic: f32,           // 16
  ior: f32,                // 20
  flags: u32,              // 24 (reserved, 0)
  _reserved0: vec4<f32>,   // 32
  _reserved1: vec4<f32>,   // 48
}                          // size 64, align 16
`;

/**
 * ABI v1 scene bindings (group 0, bindings 0-4). Compute passes must keep
 * these binding NUMBERS stable. A pass module may declare a SUBSET of these
 * bindings (its pipeline layout can bind more than the shader declares, but
 * never fewer); `WGSL_LAYOUT` below is the complete declaration.
 */
export const WGSL_SCENE_BINDINGS = /* wgsl */ `
@group(0) @binding(0) var<storage, read> sceneHeader: SceneHeader;
@group(0) @binding(1) var<storage, read> surfaces: array<SurfaceRecord>;
@group(0) @binding(2) var<storage, read> masks: array<MaskRecord>;
@group(0) @binding(3) var<storage, read> maskPixels: array<u32>;
@group(0) @binding(4) var<storage, read> materials: array<MaterialRecord>;
`;

export const WGSL_LAYOUT = `${WGSL_SCENE_BASE}
${WGSL_SCENE_BINDINGS}`;
