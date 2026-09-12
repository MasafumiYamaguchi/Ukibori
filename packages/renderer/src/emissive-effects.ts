import type { Scene } from './scene';
import type { HostBuffer } from './buffer';
import { BASE_MATERIAL, resolveMaterial } from './material';
import { NO_OWNER } from './compose';
export interface EmissiveEffectsOptions {
  /** Screen-space diffuse light from visible emitters (approximate, not GI). */
  illumination?: {
    intensity?: number;
    radius?: number;
  };
  /** HDR emission bloom, independent of illumination. Radius is in scene units. */
  bloom?: {
    intensity?: number;
    radius?: number;
    threshold?: number;
  };
  /** Illumination sample grid half-width: 2..6, default 4. Bloom uses a separable Gaussian. */
  quality?: number;
  /** @internal Similarity scale for DOM scenes already expressed in device pixels. */
  coordinateScale?: number;
}
export interface EffectiveEmissiveEffects {
  lightIntensity: number;
  lightRadius: number;
  bloomIntensity: number;
  bloomRadius: number;
  threshold: number;
  quality: number;
}
const boundedNumber = (value: number | undefined, fallback: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.fround(Math.min(max, Math.max(0, value))) : fallback;
export function sanitizeEmissiveEffects(options: EmissiveEffectsOptions = {}): EffectiveEmissiveEffects {
  const scale = typeof options.coordinateScale === "number" && Number.isFinite(options.coordinateScale) && options.coordinateScale > 0 ? options.coordinateScale : 1;
  return { lightIntensity: options.illumination ? boundedNumber(options.illumination.intensity, 1, 8) : 0,
    lightRadius: boundedNumber(options.illumination?.radius, 48, 256) * scale,
    bloomIntensity: options.bloom ? boundedNumber(options.bloom.intensity, 0.6, 8) : 0,
    bloomRadius: boundedNumber(options.bloom?.radius, 24, 128) * scale, threshold: boundedNumber(options.bloom?.threshold, 1, 65504),
    quality: Math.max(2, Math.min(6, Math.round(boundedNumber(options.quality, 4, 6)))) };
}
export function emissiveEffectsActive(e: EffectiveEmissiveEffects): boolean {
  return (e.lightIntensity > 0 && e.lightRadius > 0) || (e.bloomIntensity > 0 && e.bloomRadius > 0);
}
/** DOM scenes are already scaled to device pixels; radiometric values never scale. */
export function scaleEmissiveEffects(options: EmissiveEffectsOptions | undefined, dpr: number): EmissiveEffectsOptions | undefined {
  if (!options)
    return undefined;
  return { ...options, coordinateScale: dpr };
}
export interface EmissiveEffectFields {
  color: HostBuffer;
  objectId: HostBuffer;
  height: HostBuffer;
  normal: HostBuffer;
  visibility?: HostBuffer;
}
const decode = (v: number) => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
const encode = (v: number) => { const x = Math.min(1, Math.max(0, v)); return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055; };
/** Premultiplied overlay bytes. Visible-source screen-space approximation shared with WGSL. */
function renderIllumination(scene: Scene, fields: EmissiveEffectFields, e: EffectiveEmissiveEffects, shadowColor: readonly number[] = [12, 16, 28], shadowAlpha = 0.3, dpr = 1): Uint8Array {
  if (!Number.isFinite(dpr) || dpr <= 0)
    throw new RangeError('invalid emissive dpr');
  const expected = [[fields.color, 'u8', 4], [fields.objectId, 'u32', 1], [fields.height, 'f32', 1], [fields.normal, 'f32', 3], [fields.visibility, 'f32', 1]] as const;
  for (const [field, format, channels] of expected) {
    if (field && (field.spec.format !== format || field.spec.channels !== channels))
      throw new Error('invalid emissive field format');
  }
  const { width: w, height: h } = fields.color.spec;
  for (const field of [fields.objectId, fields.height, fields.normal, fields.visibility]) {
    if (field && (field.spec.width !== w || field.spec.height !== h))
      throw new Error('emissive field extent mismatch');
  }
  const materials = scene.surfaces.map(s => resolveMaterial(scene.materials, s.material));
  const materialAt = (i: number) => materials[fields.objectId.data[i]] ?? BASE_MATERIAL;
  const emissionAt = (i: number) => materialAt(i).emissive ?? { r: 0, g: 0, b: 0 };
  const result = new Uint8Array(w * h * 4), q = e.quality;
  const exposure = Math.min(65504, scene.exposure);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const g = y * w + x, owned = fields.objectId.data[g] !== NO_OWNER, base = materialAt(g).baseColor;
      const light = [0, 0, 0];
      if (e.lightIntensity > 0 && e.lightRadius > 0)
        for (let ky = -q; ky <= q; ky++)
          for (let kx = -q; kx <= q; kx++) {
            const step = e.lightRadius * dpr / q;
            const xx = Math.round((Math.floor(x / step) + kx) * step), yy = Math.round((Math.floor(y / step) + ky) * step);
            const u = (xx - x) / (e.lightRadius * dpr), v = (yy - y) / (e.lightRadius * dpr), r2 = u * u + v * v;
            if (r2 > 1)
              continue;
            if (e.lightIntensity > 0 && e.lightRadius > 0 && r2 > 0) {
              if (xx < 0 || xx >= w || yy < 0 || yy >= h)
                continue;
              const n = yy * w + xx;
              if (fields.objectId.data[n] === NO_OWNER || fields.objectId.data[n] === fields.objectId.data[g])
                continue;
              const em = emissionAt(n);
              if (em.r + em.g + em.b <= 0)
                continue;
              const dx = (xx - x) / dpr, dy = (yy - y) / dpr;
              // Lift the sampled virtual light above the emitter to approximate lateral spill.
              const z = fields.height.data[n] + e.lightRadius * 0.15, dz = z - fields.height.data[g];
              const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
              const cosine = Math.max(0, (fields.normal.data[g * 3] * dx + fields.normal.data[g * 3 + 1] * dy + fields.normal.data[g * 3 + 2] * dz) / Math.max(distance, 0.001));
              let blocked = false;
              for (let s = 1; s <= 4; s++) {
                const t = s / 5, px = Math.round(x + (xx - x) * t), py = Math.round(y + (yy - y) * t), p = py * w + px;
                if (fields.objectId.data[p] !== fields.objectId.data[n] && fields.objectId.data[p] !== fields.objectId.data[g] && fields.height.data[p] > fields.height.data[g] + dz * t + e.lightRadius * 0.002) {
                  blocked = true;
                  break;
                }
              }
              if (blocked)
                continue;
              const area = (e.lightRadius / q) ** 2;
              const factor = cosine * (1 - r2) * area / (Math.PI * Math.max(distance * distance, area));
              for (let c = 0; c < 3; c++)
                light[c] += Math.min(65504, [em.r, em.g, em.b][c]) * factor;
            }
          }
      const a0 = owned ? 1 : Math.round(shadowAlpha * 255) / 255 * (1 - Math.min(1, Math.max(0, fields.visibility?.data[g] ?? 1)));
      const rgb = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const glow = light[c] * [base.r, base.g, base.b][c] * exposure * e.lightIntensity;
        rgb[c] = owned ? encode(decode(fields.color.data[g * 4 + c]) + glow) : Math.min(1, shadowColor[c] / 255 * a0 + encode(glow));
      }
      const alpha = owned ? 1 : Math.max(a0, ...rgb);
      for (let c = 0; c < 3; c++)
        result[g * 4 + c] = Math.round(rgb[c] * 255);
      result[g * 4 + 3] = Math.round(alpha * 255);
    }
  return result;
}
/** HDR emission is blurred before adding it to the displayed illumination. */
export function renderEmissiveEffects(scene: Scene, fields: EmissiveEffectFields, e: EffectiveEmissiveEffects, shadowColor: readonly number[] = [12, 16, 28], shadowAlpha = 0.3, dpr = 1): Uint8Array {
  const output = renderIllumination(scene, fields, { ...e, bloomIntensity: 0 }, shadowColor, shadowAlpha, dpr);
  if (!(e.bloomIntensity > 0 && e.bloomRadius > 0))
    return output;
  const { width, height } = fields.color.spec;
  const radius = e.bloomRadius * dpr, count = Math.ceil(radius);
  const weights = Array.from({ length: count * 2 + 1 }, (_, i) => Math.exp(-4.5 * ((i - count) / radius) ** 2));
  const total = weights.reduce((a, b) => a + b, 0);
  const emission = new Float32Array(width * height * 3), horizontal = new Float32Array(emission.length);
  const materials = scene.surfaces.map(s => resolveMaterial(scene.materials, s.material));
  for (let i = 0; i < width * height; i++) {
    const em = materials[fields.objectId.data[i]]?.emissive;
    if (!em)
      continue;
    const rgb = [em.r, em.g, em.b].map(v => Math.min(65504, v) * Math.min(65504, scene.exposure));
    const peak = Math.max(...rgb), factor = peak > 0 ? Math.max(0, peak - e.threshold) / peak : 0;
    for (let c = 0; c < 3; c++)
      emission[i * 3 + c] = rgb[c] * factor;
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -count; k <= count; k++)
          if (x + k >= 0 && x + k < width)
            sum += emission[(y * width + x + k) * 3 + c] * weights[k + count];
        horizontal[(y * width + x) * 3 + c] = sum / total;
      }
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const g = y * width + x, owned = fields.objectId.data[g] !== NO_OWNER;
      const a0 = Math.round(shadowAlpha * 255) / 255 * (1 - Math.min(1, Math.max(0, fields.visibility?.data[g] ?? 1)));
      let alpha = owned ? 1 : a0;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -count; k <= count; k++)
          if (y + k >= 0 && y + k < height)
            sum += horizontal[((y + k) * width + x) * 3 + c] * weights[k + count];
        const glow = sum / total * e.bloomIntensity;
        const shadow = owned ? 0 : shadowColor[c] / 255 * a0;
        const spill = Math.max(0, output[g * 4 + c] / 255 - shadow);
        const rgb = Math.min(1, shadow + encode(decode(spill * 255) + glow));
        output[g * 4 + c] = Math.round(rgb * 255);
        alpha = Math.max(alpha, rgb);
      }
      output[g * 4 + 3] = Math.round(alpha * 255);
    }
  return output;
}
