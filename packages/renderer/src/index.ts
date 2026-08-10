export type {
  BackendCapabilities,
  BufferData,
  BufferFormat,
  BufferSpec,
  LinearRgb,
  RenderBackend,
  RenderBuffer,
  Vec2,
  Vec3,
} from "./types";
export {
  COLOR_SPEC,
  HEIGHT_SPEC,
  NORMAL_SPEC,
  OBJECT_ID_SPEC,
  VISIBILITY_SPEC,
} from "./types";
export {
  clamp,
  isFiniteNumber,
  isValidVec2,
  isValidVec3,
  lerp,
  normalizeVec3,
  saturatingAdd,
  saturatingMul,
} from "./math";
export {
  HostBuffer,
  assertValidSpec,
  byteLength,
  elementSize,
  readBufferData,
  readElement,
  sampleLine,
} from "./buffer";
export { CpuBackend } from "./backend/cpu";
export { WebGpuBackend, createWebGpuBackend, isWebGpuSupported } from "./backend/webgpu";
export {
  ABI_MAGIC,
  ABI_VERSION,
  ALPHA_FORMAT_F32,
  ALPHA_FORMAT_U8,
  FLAG_CASTS_SHADOW,
  FLAG_RECEIVES_SHADOW,
  GPU_USAGE_STAGING_BUFFER,
  GPU_USAGE_STORAGE_BUFFER,
  HEADER_SIZE,
  MASK_STRIDE,
  MATERIAL_STRIDE,
  PROFILE_BEVEL,
  PROFILE_FLAT,
  SCENE_FLAG_DEFAULT,
  SCENE_FLAG_KNOWN_MASK,
  SCENE_FLAG_ORIGIN_TOP_LEFT,
  SCENE_FLAG_Y_DOWN,
  SHAPE_MASK,
  SHAPE_ROUNDED_RECT,
  SURFACE_STRIDE,
  sceneSectionLayout,
  texelCenterToLogical,
} from "./gpu/layout";
export type { EncodedHeader, SceneSectionLayout } from "./gpu/layout";
export { encodeScene, parseHeader } from "./gpu/encode";
export type { EncodedScene } from "./gpu/encode";
export { validateEncodedScene } from "./gpu/validate";
export type { ValidationResult } from "./gpu/validate";
export { SceneUploader, assertBoundedSceneStructure } from "./gpu/uploader";
export type {
  GpuBufferLike,
  GpuQueueLike,
  GpuUploadDeviceLike,
  SceneBindings,
  UploadBinding,
  UploadStats,
} from "./gpu/uploader";
export { WGSL_LAYOUT } from "./gpu/wgsl";
export {
  COMPOSE_CASTER_HEIGHT_WGSL,
  COMPOSE_COVERAGE_WGSL,
  COMPOSE_HEIGHT_WGSL,
  COMPOSE_MATERIAL_ID_WGSL,
  COMPOSE_OBJECT_ID_WGSL,
  HEIGHT_PASS_PARAMS_BYTE_LENGTH,
  MASK_META_STRIDE,
  MASK_SDF_WGSL,
  WORKGROUP_SIZE,
} from "./gpu/height-pass-wgsl";
export {
  COMPUTE_STAGE_VISIBILITY,
  GPU_USAGE_UNIFORM,
  HEIGHT_PASS_OUTPUT_USAGE,
  HeightPass,
} from "./gpu/height-pass";
export type {
  GpuBindGroupEntryLike,
  GpuBindGroupLayoutEntryLike,
  GpuBindGroupLayoutLike,
  GpuBindGroupLike,
  GpuBufferBindingLike,
  GpuCommandBufferLike,
  GpuCommandEncoderLike,
  GpuComputeDeviceLike,
  GpuComputePassEncoderLike,
  GpuComputePipelineLike,
  GpuLimitsLike,
  GpuPipelineLayoutLike,
  GpuShaderModuleLike,
  HeightPassDispatchStats,
  HeightPassLastDispatch,
  HeightPassOutputBinding,
  HeightPassOutputFormat,
  HeightPassOutputs,
  HeightPassProvenance,
  HeightPassSnapshot,
} from "./gpu/height-pass";
export {
  NORMAL_OUTPUT_BYTES_PER_TEXEL,
  NORMAL_PARAMS_BYTE_LENGTH,
  NORMAL_PASS_WGSL,
  NORMAL_WORKGROUP_SIZE,
} from "./gpu/normal-pass-wgsl";
export {
  NORMAL_PASS_OUTPUT_USAGE,
  NormalPass,
  normalHeightBindingFromHeightPass,
  sanitizeNormalOptions,
} from "./gpu/normal-pass";
export type {
  NormalEffectiveOptions,
  NormalHeightBinding,
  NormalOutputBinding,
  NormalPassDispatchStats,
  NormalPassInput,
  NormalPassLastDispatch,
  NormalPassSnapshot,
} from "./gpu/normal-pass";
export {
  MAX_SHADOW_STEP_COUNT,
  SHADOW_OUTPUT_BYTES_PER_TEXEL,
  SHADOW_PARAMS_BYTE_LENGTH,
  SHADOW_PASS_WGSL,
  SHADOW_WORKGROUP_SIZE,
} from "./gpu/shadow-pass-wgsl";
export {
  SHADOW_PASS_OUTPUT_USAGE,
  ShadowPass,
  sanitizeShadowOptions,
  shadowHeightBindingsFromHeightPass,
} from "./gpu/shadow-pass";
export type {
  ShadowEffectiveOptions,
  ShadowFieldBinding,
  ShadowOutputBinding,
  ShadowPassDispatchStats,
  ShadowPassInput,
  ShadowPassLastDispatch,
  ShadowPassSnapshot,
  ShadowSanitizeContext,
} from "./gpu/shadow-pass";
export {
  UkiboriRenderer,
  createRenderer,
  testPatternBytes,
} from "./renderer";
export type {
  CreatedRenderer,
  CreateRendererOptions,
  Quality,
  RendererOptions,
} from "./renderer";
export { toCategoryRgba, toPpmBytes, toRgbaBytes } from "./debug/export";
export type { DebugMode, RgbaImage, ToRgbaOptions } from "./debug/export";
export { DEFAULT_LIGHT_DIRECTION, createScene, isHeightProfile, isShape } from "./scene";
export type {
  DirectionalLight,
  HeightProfile,
  MaskSource,
  MaterialRef,
  Scene,
  SceneInput,
  Shape,
  SurfaceNode,
} from "./scene";
export { evaluateProfile } from "./profile";
export {
  composeCasterHeightField,
  composeSdfHeightField,
  generateSdfDebug,
  maskSurfaceHeight,
  roundedRectSdf,
  roundedRectSurfaceHeight,
  surfaceHeight,
} from "./geometry";
export type { SdfDebugBuffers } from "./geometry";
export { computeMaskSdf, getMaskSdf, maskFromAscii, sampleMaskSdfAt } from "./mask";
export type { MaskSdf } from "./mask";
export {
  DEFAULT_ENVIRONMENT_INTENSITY,
  DEFAULT_ENVIRONMENT_SHARE,
  DEFAULT_EXPOSURE,
  accumulateLinear,
  applyExposure,
  evaluateEnvironment,
  sanitizeEnvironment,
  sanitizeExposure,
} from "./environment";
export type { EnvironmentLight, EnvironmentResult } from "./environment";
export { computeNormals, lightScene, shadeHeightField } from "./lighting";
export type { LightingBuffers, LightingOptions, NormalOptions, ShadeInput } from "./lighting";
export {
  computeVisibility,
  isOccludedWithContext,
  marchShadowRay,
  prepareShadowContext,
  sampleHeightAt,
  traceShadowRay,
} from "./shadow";
export type { ShadowContext, ShadowMarchSample, ShadowOptions, ShadowRayResult, VisibilityOptions } from "./shadow";
export {
  BASE_MATERIAL,
  DEFAULT_IOR,
  MATERIAL_PRESETS,
  resolveMaterial,
  sanitizeMaterial,
  sanitizeMaterialTable,
} from "./material";
export type { Material } from "./material";
export {
  brdfDirect,
  dGgx,
  dielectricF0,
  f0ForMaterial,
  fresnelSchlick,
  ggxAlpha,
  smithGgxVisibility,
} from "./brdf";
export type { BrdfResult } from "./brdf";
export {
  NO_OWNER,
  composeHeightField,
  flatRoundedRectHeight,
  sceneMaterials,
} from "./compose";
export type { ComposeOptions, ComposeResult, SurfaceHeightAt, TieBreak } from "./compose";
