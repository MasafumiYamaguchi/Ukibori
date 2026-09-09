import type { MaskSource } from "ukibori-renderer";
import type { DomShape } from "./types";

/** Bounded per-layer cache size; masks are immutable and may be large. */
const DEFAULT_CACHE_LIMIT = 64;

/**
 * Option A quality policy: keep Canvas2D's antialiased coverage at the
 * effective device footprint and feed it to the existing binary SDF path.
 * This token is part of the cache key so a future quality policy cannot
 * accidentally reuse masks made with different raster settings.
 */
export const SVG_PATH_RASTER_QUALITY = "coverage-v1" as const;

/**
 * Small LRU owned by a DOM layer. Keeping ownership here makes disposing a
 * layer release every generated mask, while the limit also protects callers
 * that use buildScene directly from unbounded path/resize churn.
 */
export class SvgPathRasterCache {
  private readonly entries = new Map<string, MaskSource>();
  private readonly limit: number;
  private rasterizationCount = 0;

  constructor(limit = DEFAULT_CACHE_LIMIT) {
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_CACHE_LIMIT;
  }

  get(key: string): MaskSource | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: MaskSource): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    this.rasterizationCount += 1;
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  get rasterizations(): number {
    return this.rasterizationCount;
  }
}

/** A stable cache key for authoring SVG paths and their raster footprint. */
export function svgPathRasterKey(
  shape: Extract<DomShape, { kind: "svgPath" }>,
  width: number,
  height: number,
): string;
/** @deprecated The five numeric argument form is retained for source compatibility. */
export function svgPathRasterKey(
  shape: Extract<DomShape, { kind: "svgPath" }>,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
  width: number,
  height: number,
): string;
export function svgPathRasterKey(
  shape: Extract<DomShape, { kind: "svgPath" }>,
  ...dimensions: number[]
): string {
  // The legacy form supplied CSS size and DPR as well. They are deliberately
  // ignored: only the effective raster dimensions affect generated pixels.
  const width = dimensions.length === 2 ? dimensions[0] : dimensions[3];
  const height = dimensions.length === 2 ? dimensions[1] : dimensions[4];
  return [
    SVG_PATH_RASTER_QUALITY,
    shape.d,
    ...shape.viewBox,
    shape.fillRule ?? "nonzero",
    width,
    height,
  ].join("\u0000");
}

/**
 * Rasterize path-data-only SVG into an anti-aliased coverage mask.
 * No SVG markup is parsed or injected; unsupported document features never
 * enter the DOM. Alpha is retained as Float32 coverage for the renderer.
 */
export function rasterizeSvgPath(
  shape: Extract<DomShape, { kind: "svgPath" }>,
  width: number,
  height: number,
): MaskSource {
  validateSvgPathShape(shape);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError(`SVG path raster footprint must be positive (${width}x${height})`);
  }
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    throw new Error("SVG path rasterization unavailable: DOM canvas is not available");
  }
  const Path2DConstructor = (globalThis as { Path2D?: new (d?: string) => Path2D }).Path2D;
  if (Path2DConstructor === undefined) {
    throw new Error("SVG path rasterization unavailable: Path2D is not supported");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("SVG path rasterization unavailable: canvas 2d is not supported");
  }
  let path: Path2D;
  try {
    path = new Path2DConstructor(shape.d);
  } catch (error) {
    throw new TypeError(`invalid SVG path data: ${error instanceof Error ? error.message : String(error)}`);
  }
  const [minX, minY, viewWidth, viewHeight] = shape.viewBox;
  const scale = Math.min(width / viewWidth, height / viewHeight);
  const offsetX = (width - viewWidth * scale) / 2 - minX * scale;
  const offsetY = (height - viewHeight * scale) / 2 - minY * scale;
  context.save();
  try {
    context.clearRect(0, 0, width, height);
    context.setTransform(scale, 0, 0, scale, offsetX, offsetY);
    context.fillStyle = "#fff";
    context.fill(path, shape.fillRule ?? "nonzero");
  } finally {
    context.restore();
  }
  const data = context.getImageData(0, 0, width, height).data;
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = data[i * 4 + 3] / 255;
  }
  return { width, height, alpha };
}

/** Validate the descriptor; Path2D validates path syntax itself. */
export function validateSvgPathShape(
  shape: Extract<DomShape, { kind: "svgPath" }>,
): void {
  if (typeof shape.d !== "string" || shape.d.trim().length === 0) {
    throw new TypeError("SVG path d must be a non-empty path-data string");
  }
  if (
    !Array.isArray(shape.viewBox) ||
    shape.viewBox.length !== 4 ||
    shape.viewBox.some((v) => typeof v !== "number" || !Number.isFinite(v))
  ) {
    throw new TypeError("SVG path viewBox must contain four finite numbers");
  }
  const [, , width, height] = shape.viewBox;
  if (width <= 0 || height <= 0) {
    throw new RangeError("SVG path viewBox width and height must be > 0");
  }
  if (shape.fillRule !== undefined && shape.fillRule !== "nonzero" && shape.fillRule !== "evenodd") {
    throw new TypeError(`unsupported SVG path fillRule "${String(shape.fillRule)}"`);
  }
  if (/[<>]/.test(shape.d)) {
    throw new TypeError("SVG path d accepts path data only, not SVG markup");
  }
}
