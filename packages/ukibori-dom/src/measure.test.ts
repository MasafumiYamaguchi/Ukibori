import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureSurfaceElement, readComputedBorderRadius, readPageScroll } from "./measure";
import type { DomSurfaceOptions } from "./types";

const BASE_OPTIONS: DomSurfaceOptions = {
  id: "s",
  shape: { kind: "roundedRect", radius: 4 },
  elevation: 2,
  thickness: 1,
  material: "silicone",
};

function stubRect(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): void {
  const domRect = {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  } as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(domRect);
}

function setScroll(x: number, y: number): void {
  Object.defineProperty(window, "scrollX", { value: x, configurable: true });
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readPageScroll", () => {
  it("reads window scroll offsets", () => {
    setScroll(300, 700);
    expect(readPageScroll()).toEqual({ scrollX: 300, scrollY: 700 });
  });

  it("defaults to zero", () => {
    setScroll(0, 0);
    expect(readPageScroll()).toEqual({ scrollX: 0, scrollY: 0 });
  });
});

describe("measureSurfaceElement", () => {
  beforeEach(() => {
    setScroll(0, 0);
  });

  it("converts a viewport rect into document space and keeps the explicit radius", () => {
    stubRect({ left: 25, top: 35, width: 200, height: 48 });
    const el = document.createElement("button");
    const geo = measureSurfaceElement(el, BASE_OPTIONS);
    expect(geo).toEqual({ x: 25, y: 35, w: 200, h: 48, radius: 4 });
  });

  it("adds page scroll to viewport coordinates", () => {
    stubRect({ left: 25, top: 35, width: 100, height: 20 });
    setScroll(40, 90);
    const el = document.createElement("div");
    const geo = measureSurfaceElement(el, BASE_OPTIONS);
    expect(geo.x).toBe(65);
    expect(geo.y).toBe(125);
  });

  it("falls back to the computed border-radius when radius is omitted", () => {
    stubRect({ left: 0, top: 0, width: 80, height: 32 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      borderTopLeftRadius: "12px",
      position: "static",
    } as unknown as CSSStyleDeclaration);
    const el = document.createElement("div");
    const geo = measureSurfaceElement(el, {
      ...BASE_OPTIONS,
      shape: { kind: "roundedRect" },
    });
    expect(geo.radius).toBe(12);
  });

  it("treats non-px / invalid radii as 0", () => {
    stubRect({ left: 0, top: 0, width: 80, height: 32 });
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      borderTopLeftRadius: "50%",
      position: "static",
    } as unknown as CSSStyleDeclaration);
    const el = document.createElement("div");
    const geo = measureSurfaceElement(el, {
      ...BASE_OPTIONS,
      shape: { kind: "roundedRect" },
    });
    expect(geo.radius).toBe(0);
  });

  it("ignores radius for mask shapes", () => {
    stubRect({ left: 0, top: 0, width: 80, height: 32 });
    const el = document.createElement("div");
    const geo = measureSurfaceElement(el, {
      ...BASE_OPTIONS,
      shape: { kind: "mask", mask: { width: 8, height: 8, alpha: new Float32Array(64) } },
    });
    expect(geo.radius).toBe(0);
  });
});

describe("readComputedBorderRadius", () => {
  it("parses a single px length", () => {
    const el = document.createElement("div");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      borderTopLeftRadius: "8px",
    } as unknown as CSSStyleDeclaration);
    expect(readComputedBorderRadius(el)).toBe(8);
  });

  it("parses the first component of the shorthand", () => {
    const el = document.createElement("div");
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      borderTopLeftRadius: "8px 16px",
    } as unknown as CSSStyleDeclaration);
    expect(readComputedBorderRadius(el)).toBe(8);
  });
});
