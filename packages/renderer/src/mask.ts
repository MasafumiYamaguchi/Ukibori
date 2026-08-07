import { clamp } from "./math";
import type { MaskSource } from "./scene";

/**
 * #19 mask geometry: alpha mask -> signed distance field.
 *
 * The mask's binary silhouette (alpha >= 0.5, i.e. >= 128 for Uint8) is
 * converted to a signed distance field in MASK PIXEL units, measured to the
 * ACTUAL SILHOUETTE BOUNDARY GEOMETRY (the axis-aligned unit segments
 * separating ink cells from empty cells), not to opposite-class pixel
 * centers:
 *
 * - the EDT domain is padded with virtual transparent pixels so ink touching
 *   the raster edge has a proper outer boundary; the padded grid is kept in
 *   the result and the continuous sampler interpolates within it, so the
 *   raster edge samples `d = 0` exactly
 * - the exact distance from a pixel center to the boundary segment set is
 *   the minimum of: the perpendicular distance to a vertical segment in the
 *   same row band, the perpendicular distance to a horizontal segment in the
 *   same column band, and the distance to the nearest segment endpoint
 *   (corner point). All three are computed exactly on a 2x grid: 1D
 *   Felzenszwalb-Huttenlocher per row/column band for the perpendiculars and
 *   a 2D FH EDT with the corner points as seeds.
 *
 * Sign convention matches the rounded-rect SDF: negative inside, positive
 * outside.
 *
 * A single mask object's SDF is computed once (WeakMap cache) and shared by
 * every geometry evaluation. MaskSource inputs are treated as IMMUTABLE:
 * do not mutate `alpha` after the mask is used, or the cached SDF will be
 * stale. Rasterization (canvas text, icons, etc.) stays outside the
 * renderer: this module only consumes `MaskSource`.
 */

export interface MaskSdf {
  width: number;
  height: number;
  /** virtual transparent margin (the grid is `width + 2*pad` wide) */
  pad: number;
  /** signed distance per PADDED-grid pixel, row-major, in mask-pixel units */
  sdf: Float32Array;
}

/** Virtual transparent margin around the mask for the outside boundary. */
const PAD = 1;

const maskSdfCache = new WeakMap<MaskSource, MaskSdf>();

/**
 * Signed distance field for a mask (cached per mask object). For masks with
 * no ink the field is far-positive everywhere (no coverage); fully-inked
 * masks get distances to the virtual padding (bounded, negative).
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
  const pw = width + 2 * PAD;
  const ph = height + 2 * PAD;
  // Everything runs on a 2x-scaled grid so pixel centers (odd) and boundary
  // features (even) are separate cells.
  const w2 = 2 * pw;
  const h2 = 2 * ph;
  const n2 = w2 * h2;
  const inside2 = new Uint8Array(n2);
  for (let c = 0; c < pw; c++) {
    for (let r = 0; r < ph; r++) {
      let ink = false;
      if (r >= PAD && r < PAD + height && c >= PAD && c < PAD + width) {
        const i = (r - PAD) * width + (c - PAD);
        const a = mask.alpha instanceof Uint8Array ? mask.alpha[i] / 255 : mask.alpha[i];
        ink = a >= 0.5;
      }
      const v = ink ? 1 : 0;
      const base = 2 * r * w2 + 2 * c;
      inside2[base] = v;
      inside2[base + 1] = v;
      inside2[base + w2] = v;
      inside2[base + w2 + 1] = v;
    }
  }

  const maxDim2 = Math.max(w2, h2);
  const far = 4 * maxDim2 * maxDim2 + 1;
  const lineCap = Math.max(w2, h2);
  const v = new Int32Array(lineCap);
  const z = new Float64Array(lineCap + 1);
  const line = new Float64Array(lineCap);

  // Boundary segments (2x units) and their endpoints (corners).
  const vertByRow: number[][] = Array.from({ length: h2 }, () => []);
  const horByCol: number[][] = Array.from({ length: w2 }, () => []);
  const corners: number[] = [];
  for (let c = 0; c < pw; c++) {
    for (let r = 0; r < ph; r++) {
      const x0 = 2 * c;
      const y0 = 2 * r;
      if (c + 1 < pw) {
        // vertical segment at x = 2c + 2 spanning rows [2r, 2r + 2]
        if (inside2[y0 * w2 + (2 * c + 1)] !== inside2[y0 * w2 + (2 * c + 2)]) {
          vertByRow[2 * r + 1].push(2 * c + 2);
          corners.push(2 * c + 2, y0, 2 * c + 2, y0 + 2);
        }
      }
      if (r + 1 < ph) {
        // horizontal segment at y = 2r + 2 spanning cols [2c, 2c + 2]
        if (inside2[(2 * r + 1) * w2 + x0] !== inside2[(2 * r + 2) * w2 + x0]) {
          horByCol[2 * c + 1].push(2 * r + 2);
          corners.push(x0, 2 * r + 2, x0 + 2, 2 * r + 2);
        }
      }
    }
  }

  // Perpendicular distances: 1D FH per row band (vertical segments) and per
  // column band (horizontal segments), queried at every 2x cell.
  const vert2 = new Float64Array(n2);
  for (let r = 0; r < ph; r++) {
    const band = 2 * r + 1;
    line.fill(far);
    for (const sx of vertByRow[band]) {
      line[sx] = 0;
    }
    edt1d(line, w2, v, z);
    for (let x = 0; x < w2; x++) {
      vert2[band * w2 + x] = line[x];
    }
  }
  const hor2 = new Float64Array(n2);
  for (let c = 0; c < pw; c++) {
    const band = 2 * c + 1;
    line.fill(far);
    for (const sy of horByCol[band]) {
      line[sy] = 0;
    }
    edt1d(line, h2, v, z);
    for (let y = 0; y < h2; y++) {
      hor2[y * w2 + band] = line[y];
    }
  }

  // Corner points: exact 2D EDT with the segment endpoints as seeds.
  const f = new Float64Array(n2);
  f.fill(far);
  for (let i = 0; i < corners.length; i += 2) {
    f[corners[i + 1] * w2 + corners[i]] = 0;
  }
  const corner2 = edt2dSquared(f, w2, h2);

  const sdf = new Float32Array(pw * ph);
  for (let r = 0; r < ph; r++) {
    for (let c = 0; c < pw; c++) {
      const idx = (2 * r + 1) * w2 + (2 * c + 1);
      const d2 = Math.min(vert2[idx], hor2[idx], corner2[idx]);
      const d = Math.sqrt(d2) / 2;
      sdf[r * pw + c] = inside2[idx] ? -d : d;
    }
  }
  return { width, height, pad: PAD, sdf };
}

/**
 * Bilinear sample of the SDF at CONTINUOUS mask-pixel coordinates. The
 * virtual transparent padding is part of the sampled domain, so the raster
 * edge (mask-px 0 / width) interpolates to `d = 0` exactly. Clamped to the
 * padded grid.
 */
export function sampleMaskSdfAt(sdf: MaskSdf, px: number, py: number): number {
  const pw = sdf.width + 2 * sdf.pad;
  const ph = sdf.height + 2 * sdf.pad;
  const fx = clamp(px + sdf.pad - 0.5, 0, pw - 1);
  const fy = clamp(py + sdf.pad - 0.5, 0, ph - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, pw - 1);
  const y1 = Math.min(y0 + 1, ph - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const v00 = sdf.sdf[y0 * pw + x0];
  const v10 = sdf.sdf[y0 * pw + x1];
  const v01 = sdf.sdf[y1 * pw + x0];
  const v11 = sdf.sdf[y1 * pw + x1];
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
