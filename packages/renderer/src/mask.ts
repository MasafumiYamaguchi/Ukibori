import { clamp } from "./math";
import type { MaskSource } from "./scene";

/**
 * #19 mask geometry: alpha mask -> signed distance field.
 *
 * The mask's binary silhouette (alpha >= 0.5, i.e. >= 128 for Uint8) is
 * converted to an exact Euclidean signed distance field on the mask pixel
 * grid (Felzenszwalb-Huttenlocher 1D-sweep EDT, applied twice: rows then
 * columns). Distances are in MASK PIXEL units: negative inside the
 * silhouette, positive outside — the same sign convention as the rounded-rect
 * SDF, so profiles and coverage behave identically.
 *
 * A single mask object's SDF is computed once (WeakMap cache) and shared by
 * every geometry evaluation. Rasterization (canvas text, icons, etc.) stays
 * outside the renderer: this module only consumes `MaskSource`.
 */

export interface MaskSdf {
  width: number;
  height: number;
  /** signed distance per mask pixel, row-major, in mask-pixel units */
  sdf: Float32Array;
}

const maskSdfCache = new WeakMap<MaskSource, MaskSdf>();

/**
 * Signed distance field for a mask (cached per mask object). For masks with
 * no ink the field is far-positive everywhere (no coverage); for fully-inked
 * masks it is far-negative everywhere.
 */
export function getMaskSdf(mask: MaskSource): MaskSdf {
  let sdf = maskSdfCache.get(mask);
  if (sdf === undefined) {
    sdf = computeMaskSdf(mask);
    maskSdfCache.set(mask, sdf);
  }
  return sdf;
}

export function computeMaskSdf(mask: MaskSource): MaskSdf {
  const { width, height } = mask;
  const n = width * height;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = mask.alpha instanceof Uint8Array ? mask.alpha[i] / 255 : mask.alpha[i];
    inside[i] = a >= 0.5 ? 1 : 0;
  }
  // Squared-distance transform with seeds = background (distances of ink
  // pixels to the nearest background) and seeds = foreground (distances of
  // background pixels to the nearest ink).
  const maxDim = Math.max(width, height);
  const far = 4 * maxDim * maxDim + 1; // beyond any real squared distance
  const fIn = new Float64Array(n);
  const fOut = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    fIn[i] = inside[i] ? far : 0;
    fOut[i] = inside[i] ? 0 : far;
  }
  const dToBg2 = edt2dSquared(fIn, width, height);
  const dToFg2 = edt2dSquared(fOut, width, height);
  const sdf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sdf[i] = inside[i] ? -Math.sqrt(dToBg2[i]) : Math.sqrt(dToFg2[i]);
  }
  return { width, height, sdf };
}

/** Bilinear sample of the SDF at CONTINUOUS mask-pixel coordinates (clamped). */
export function sampleMaskSdfAt(sdf: MaskSdf, px: number, py: number): number {
  const fx = clamp(px - 0.5, 0, sdf.width - 1);
  const fy = clamp(py - 0.5, 0, sdf.height - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, sdf.width - 1);
  const y1 = Math.min(y0 + 1, sdf.height - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = sdf.sdf[y0 * sdf.width + x0];
  const v10 = sdf.sdf[y0 * sdf.width + x1];
  const v01 = sdf.sdf[y1 * sdf.width + x0];
  const v11 = sdf.sdf[y1 * sdf.width + x1];
  const top = v00 + (v10 - v00) * tx;
  const bottom = v01 + (v11 - v01) * tx;
  return top + (bottom - top) * ty;
}

/** Build a binary mask from ASCII art: '#' = ink, any other char = empty. */
export function maskFromAscii(rows: string[]): MaskSource {
  const height = rows.length;
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const alpha = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    for (let x = 0; x < width; x++) {
      alpha[y * width + x] = row[x] === "#" ? 1 : 0;
    }
  }
  return { width, height, alpha };
}

/**
 * Exact 2D Euclidean squared-distance transform (Felzenszwalb-Huttenlocher):
 * 1D sweeps along rows, then along columns. `f` holds per-pixel seed values
 * (0 = seed, `far` otherwise) and the result is the squared distance to the
 * nearest seed per pixel.
 */
function edt2dSquared(f: Float64Array, width: number, height: number): Float64Array {
  const out = new Float64Array(width * height);
  const maxDim = Math.max(width, height);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);
  const line = new Float64Array(maxDim);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      line[x] = f[y * width + x];
    }
    edt1d(line, width, v, z);
    for (let x = 0; x < width; x++) {
      out[y * width + x] = line[x];
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      line[y] = out[y * width + x];
    }
    edt1d(line, height, v, z);
    for (let y = 0; y < height; y++) {
      out[y * width + x] = line[y];
    }
  }
  return out;
}

/** Felzenszwalb-Huttenlocher 1D distance transform (lower envelope of parabolas). */
function edt1d(f: Float64Array, n: number, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = 0;
    while (true) {
      const qv = v[k];
      s = ((f[q] + q * q) - (f[qv] + qv * qv)) / (2 * q - 2 * qv);
      if (s > z[k]) {
        break;
      }
      k--;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) {
      k++;
    }
    const qv = v[k];
    f[q] = (q - qv) * (q - qv) + f[qv];
  }
}
