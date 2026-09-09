import { afterEach, describe, expect, it, vi } from "vitest";
import { rasterizeSvgPath, SvgPathRasterCache, validateSvgPathShape } from "./svg-path";
import { buildScene } from "./scene-builder";
import { SurfaceRegistry } from "./registry";
import type { SvgPathShape } from "./types";

const SHAPE: SvgPathShape = { kind: "svgPath", d: "M0 0H10V10H0Z", viewBox: [0, 0, 10, 10] };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SVG path authoring raster", () => {
  it("bounds retained masks with LRU eviction", () => {
    const cache = new SvgPathRasterCache(2);
    const a = { width: 1, height: 1, alpha: new Float32Array([0]) };
    const b = { width: 1, height: 1, alpha: new Float32Array([0]) };
    const c = { width: 1, height: 1, alpha: new Float32Array([0]) };
    cache.set("a", a);
    cache.set("b", b);
    expect(cache.get("a")).toBe(a);
    cache.set("c", c);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(a);
    expect(cache.size).toBe(2);
    expect(cache.rasterizations).toBe(3);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("validates path-data-only descriptors and rejects SVG markup", () => {
    expect(() => validateSvgPathShape(SHAPE)).not.toThrow();
    expect(() => validateSvgPathShape({ ...SHAPE, d: "<svg><path/></svg>" })).toThrow(/path data only/);
    expect(() => validateSvgPathShape({ ...SHAPE, viewBox: [0, 0, 0, 10] })).toThrow(/viewBox/);
  });

  it("uses centered isotropic fit, fillRule, and preserves AA coverage", () => {
    class FakePath {
      readonly d: string;
      constructor(d: string) {
        this.d = d;
      }
    }
    const calls: unknown[] = [];
    const alpha = new Uint8ClampedArray(4 * 4 * 4);
    alpha[3] = 127;
    const context = {
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: vi.fn(),
      setTransform: vi.fn((...args: unknown[]) => calls.push(args)),
      fillStyle: "",
      fill: vi.fn((path: FakePath, rule: string) => calls.push([path.d, rule])),
      getImageData: vi.fn(() => ({ data: alpha })),
    } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
    const createElement = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "canvas") {
        return canvas as unknown as HTMLCanvasElement;
      }
      return document.createElementNS("http://www.w3.org/1999/xhtml", tag);
    });
    vi.stubGlobal("Path2D", FakePath);

    const mask = rasterizeSvgPath({ ...SHAPE, fillRule: "evenodd" }, 4, 4);
    expect(canvas.width).toBe(4);
    expect(canvas.height).toBe(4);
    expect(calls).toContainEqual(["M0 0H10V10H0Z", "evenodd"]);
    expect(mask.alpha[0]).toBeCloseTo(127 / 255, 6);
    expect(createElement).toHaveBeenCalledWith("canvas");
  });

  it("retains one generated mask across light-only scene rebuilds and keys DPR/path changes", () => {
    class FakePath {
      constructor(readonly d: string) {}
    }
    const context = {
      save: vi.fn(), restore: vi.fn(), clearRect: vi.fn(), setTransform: vi.fn(),
      fillStyle: "", fill: vi.fn(),
      getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
        data: new Uint8ClampedArray(w * h * 4),
      })),
    } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
    const element = document.createElement("div");
    const createElement = vi.spyOn(document, "createElement").mockImplementation((tag: string) =>
      tag === "canvas"
        ? (canvas as unknown as HTMLCanvasElement)
        : document.createElementNS("http://www.w3.org/1999/xhtml", tag),
    );
    vi.stubGlobal("Path2D", FakePath);
    const registry = new SurfaceRegistry();
    registry.add({
      id: "gear", element, options: {
        id: "gear", shape: SHAPE, elevation: 1, thickness: 2, material: "silicone",
      }, geometry: { x: 0, y: 0, w: 32, h: 32, radius: 0 }, dirty: false, inkDelegated: false,
    });
    const input = { registry, region: { x: 0, y: 0, w: 32, h: 32 }, dpr: 1,
      light: { direction: { x: 0, y: 0, z: 1 }, intensity: 1 } };
    const first = buildScene(input);
    const second = buildScene(input);
    expect(createElement).toHaveBeenCalledTimes(1);
    const firstMask = first.surfaces[0]!.shape;
    const secondMask = second.surfaces[0]!.shape;
    expect(firstMask.kind).toBe("mask");
    expect(secondMask.kind).toBe("mask");
    if (firstMask.kind === "mask" && secondMask.kind === "mask") {
      expect(firstMask.mask).toBe(secondMask.mask);
    }
    buildScene({ ...input, dpr: 2 });
    expect(createElement).toHaveBeenCalledTimes(2);
    registry.get("gear")!.options = { ...registry.get("gear")!.options,
      shape: { ...SHAPE, d: "M0 0H8V8H0Z" } };
    buildScene(input);
    expect(createElement).toHaveBeenCalledTimes(3);
  });
});
