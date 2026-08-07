export type {
  BackendCapabilities,
  BufferData,
  BufferFormat,
  BufferSpec,
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
export { clamp, isFiniteNumber, isValidVec2, isValidVec3, lerp, normalizeVec3 } from "./math";
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
export { toPpmBytes, toRgbaBytes } from "./debug/export";
export type { DebugMode, RgbaImage, ToRgbaOptions } from "./debug/export";
export { DEFAULT_LIGHT_DIRECTION, createScene, isHeightProfile } from "./scene";
export type {
  DirectionalLight,
  HeightProfile,
  MaterialRef,
  Scene,
  SceneInput,
  Shape,
  SurfaceNode,
} from "./scene";
export { evaluateProfile } from "./profile";
export {
  NO_OWNER,
  composeHeightField,
  flatRoundedRectHeight,
  sceneMaterials,
} from "./compose";
export type { ComposeOptions, ComposeResult, SurfaceHeightAt, TieBreak } from "./compose";
