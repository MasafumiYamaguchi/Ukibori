export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const BUFFER_FORMATS = ["f32", "u16", "u32", "u8"] as const;

export type BufferFormat = (typeof BUFFER_FORMATS)[number];

export interface BufferSpec {
  width: number;
  height: number;
  /** number of channels per pixel, 1..4 */
  channels: 1 | 2 | 3 | 4;
  format: BufferFormat;
}

export interface RenderBuffer {
  readonly spec: BufferSpec;
  writeBytes(bytes: Uint8Array, byteOffset?: number): Promise<void>;
  readBytes(): Promise<Uint8Array>;
  dispose(): void;
}

export interface BufferData {
  spec: BufferSpec;
  bytes: Uint8Array;
}

export interface BackendCapabilities {
  backend: "webgpu" | "cpu";
  /** height/normal/lighting/shadow pipeline can run on this backend */
  compute: boolean;
  readback: boolean;
  upload: boolean;
}

export interface RenderBackend {
  readonly kind: "webgpu" | "cpu";
  readonly capabilities: BackendCapabilities;
  createBuffer(spec: BufferSpec): Promise<RenderBuffer>;
  dispose(): void;
}

/**
 * Buffer semantics fixed by the scene contract (issue #13):
 *
 * - height     : absolute scene-space z, f32 scalar
 * - normal     : normalized surface normal (xyz), f32 x3
 * - objectId   : topmost surface owner at each pixel, u32 scalar
 * - visibility : cast-shadow visibility 0..1, f32 scalar
 * - color      : final RGBA8 color target
 */
export const HEIGHT_SPEC = (width: number, height: number): BufferSpec => ({
  width,
  height,
  channels: 1,
  format: "f32",
});

export const NORMAL_SPEC = (width: number, height: number): BufferSpec => ({
  width,
  height,
  channels: 3,
  format: "f32",
});

export const OBJECT_ID_SPEC = (width: number, height: number): BufferSpec => ({
  width,
  height,
  channels: 1,
  format: "u32",
});

export const VISIBILITY_SPEC = (width: number, height: number): BufferSpec => ({
  width,
  height,
  channels: 1,
  format: "f32",
});

export const COLOR_SPEC = (width: number, height: number): BufferSpec => ({
  width,
  height,
  channels: 4,
  format: "u8",
});
