import { NO_OWNER } from "../compose";

/**
 * #29 narrow shared CPU compositor helpers — the SINGLE source of truth for
 * the #20 DOM-compositor semantics, consumed by:
 *
 * - `packages/ukibori-dom/src/compositor.ts` (the DOM overlay path; the
 *   shared functions keep its results BYTE-IDENTICAL to the previous inline
 *   formulas — the DOM tests pin the exact bytes)
 * - `PresentationPass` (the #29 GPU final stage mirrors these semantics in
 *   WGSL; the CPU value is the parity oracle)
 * - the real-adapter harness (the CPU reference for canvas readback)
 *
 * The semantics are fixed and must mirror `compositeSurfaceImage` exactly —
 * do not redesign them:
 *
 * 1. `objectId != NO_OWNER`: output the packed renderer R,G,B bytes with
 *    alpha 255.
 * 2. `objectId == NO_OWNER`: the base-plane shadow tint scales with the
 *    #41 CONTINUOUS occlusion strength `clamp(1 - visibility, 0, 1)`:
 *    strength 0 (fully lit) is transparent black, strength 1 (fully
 *    shadowed) is the historical full tint. Hard #17 inputs ({0, 1})
 *    reproduce the previous binary bytes exactly.
 * 3. Shadow color channels are rounded/clamped to integer bytes exactly
 *    like the CPU compositor. Alpha is finite-clamped to `[0, 1]`, default
 *    `0.3`, and encoded with `floor(alpha * 255 + 0.5)` (== `Math.round`
 *    for non-negative alpha).
 * 4. `compositeShadowPremultipliedBytes` returns the PREMULTIPLIED byte
 *    form required by the `alphaMode: "premultiplied"` canvas for a
 *    fully-shadowed translucent texel: each RGB channel is
 *    `f32(sr) * f32(sa) / 255` (IEEE f32 arithmetic, matching the WGSL
 *    shader), then rounded to a byte. Surface RGB is unchanged (alpha 1)
 *    and transparent pixels are `(0,0,0,0)`. Partial strengths scale both
 *    alpha and premultiplied channels by the same factor in WGSL.
 */

export const DEFAULT_SHADOW_COLOR: readonly [number, number, number] = [12, 16, 28];
export const DEFAULT_SHADOW_ALPHA = 0.3;

/** CPU-compatible composite options (mirrors the DOM `CompositeOptions`). */
export interface CompositeOptions {
  /** RGB 0..255 tint for cast shadows on the base plane (default near-black) */
  readonly shadowColor?: readonly [number, number, number];
  /** 0..1 opacity of cast shadows on the base plane (default 0.3) */
  readonly shadowAlpha?: number;
}

/** The sanitized effective composite options (pinned by tests). */
export interface EffectiveCompositeOptions {
  readonly shadowColor: readonly [number, number, number];
  readonly shadowAlpha: number;
}

/**
 * Sanitize composite options with EXACTLY the CPU compositor semantics:
 * shadow color channels are byte-rounded/clamped (`v < 0 -> 0`,
 * `v > 255 -> 255`, else `Math.round(v)`) and alpha is finite-clamped to
 * `[0, 1]` with a `0.3` default for non-finite/absent values.
 */
export function sanitizeCompositeOptions(
  options: CompositeOptions = {},
): EffectiveCompositeOptions {
  const color = options.shadowColor ?? DEFAULT_SHADOW_COLOR;
  const shadowColor: readonly [number, number, number] = [
    clampByte(color[0]),
    clampByte(color[1]),
    clampByte(color[2]),
  ];
  const alpha =
    typeof options.shadowAlpha === "number" && Number.isFinite(options.shadowAlpha)
      ? clamp01(options.shadowAlpha)
      : DEFAULT_SHADOW_ALPHA;
  return { shadowColor, shadowAlpha: alpha };
}

/**
 * The per-texel DOM-compositor decision as NON-premultiplied RGBA bytes
 * (the form the DOM overlay paints). `visibility === null` behaves like a
 * fully-lit background (`vis = 1`), matching `compositeSurfaceImage`.
 */
export function compositePixelBytes(
  owner: number,
  colorR: number,
  colorG: number,
  colorB: number,
  visibility: number | null,
  options: CompositeOptions = {},
): readonly [number, number, number, number] {
  if (owner !== NO_OWNER) {
    return [colorR, colorG, colorB, 255];
  }
  // #41: visibility is CONTINUOUS ([0, 1]); the base-plane shadow tint
  // scales with the occlusion strength (1 - vis). Hard inputs ({0, 1})
  // reproduce the historical bytes exactly: vis 1 -> transparent, vis 0 ->
  // the full sanitized tint at the full sanitized alpha.
  const vis = visibility === null ? 1 : visibility;
  const strength = Math.min(1, Math.max(0, 1 - vis));
  if (!(strength > 0)) {
    return [0, 0, 0, 0];
  }
  const opts = sanitizeCompositeOptions(options);
  const alphaByte = Math.round(opts.shadowAlpha * strength * 255);
  return [opts.shadowColor[0], opts.shadowColor[1], opts.shadowColor[2], alphaByte];
}

/**
 * The PREMULTIPLIED RGBA bytes the GPU presentation pass emits for a
 * shadowed base-plane texel on an `alphaMode: "premultiplied"` canvas:
 * `sa = round(alpha * 255)`, each channel `round(f32(c) * f32(sa) / 255)`
 * with the IEEE f32 arithmetic matching the WGSL shader, alpha `sa`.
 * This is the CPU parity oracle for the canvas readback; surface and
 * transparent pixels are unchanged (`c, c, c, 255` / `0, 0, 0, 0`).
 */
export function compositeShadowPremultipliedBytes(
  options: CompositeOptions = {},
): readonly [number, number, number, number] {
  const opts = sanitizeCompositeOptions(options);
  const alphaByte = Math.round(opts.shadowAlpha * 255);
  return [
    Math.round(Math.fround(Math.fround(opts.shadowColor[0] * alphaByte) / 255)),
    Math.round(Math.fround(Math.fround(opts.shadowColor[1] * alphaByte) / 255)),
    Math.round(Math.fround(Math.fround(opts.shadowColor[2] * alphaByte) / 255)),
    alphaByte,
  ];
}

/** Byte for the alpha channel: `floor(alpha * 255 + 0.5)` (== Math.round for alpha in [0,1]). */
export function compositeShadowAlphaByte(alpha: number): number {
  return Math.round(alpha * 255);
}

/**
 * #41: the PREMULTIPLIED canvas bytes for a base-plane texel at a
 * CONTINUOUS occlusion strength `s = clamp(1 - visibility, 0, 1)`,
 * mirroring the presentation WGSL op-for-op in IEEE f32:
 *
 *   alpha   = f32(saByte) * s            (canvas byte = round(a / 255 * 255))
 *   channel = f32(c) * f32(saByte) / 255 * s   (same quantization)
 *
 * where `saByte` is the sanitized full-strength alpha byte. Strength 0 is
 * fully transparent; strength 1 reproduces
 * {@link compositeShadowPremultipliedBytes} exactly, so hard {0, 1}
 * visibility inputs keep their historical bytes.
 */
export function compositeShadowPremultipliedStrengthBytes(
  strength: number,
  options: CompositeOptions = {},
): readonly [number, number, number, number] {
  const clamped = strength < 0 ? 0 : strength > 1 ? 1 : strength;
  const s = Math.fround(clamped);
  if (!(s > 0)) {
    return [0, 0, 0, 0];
  }
  const opts = sanitizeCompositeOptions(options);
  const saByte = compositeShadowAlphaByte(opts.shadowAlpha);
  const UNORM_SCALE = 1 / 255;
  // alpha: f32(saByte) * s -> unorm -> byte
  const a1 = Math.fround(saByte * s);
  const a2 = Math.fround(a1 * UNORM_SCALE);
  const alphaByte = Math.round(a2 * 255);
  // channels: f32(c) * f32(saByte) / 255 * s -> unorm -> byte
  const ch = (c: number): number => {
    const c1 = Math.fround(c * saByte);
    const c2 = Math.fround(c1 / 255);
    const c3 = Math.fround(c2 * s);
    const c4 = Math.fround(c3 * UNORM_SCALE);
    return Math.round(c4 * 255);
  };
  return [
    ch(opts.shadowColor[0]),
    ch(opts.shadowColor[1]),
    ch(opts.shadowColor[2]),
    alphaByte,
  ];
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
