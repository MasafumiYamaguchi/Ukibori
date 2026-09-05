import { vi } from "vitest";

/**
 * Shared DOM stubs for jsdom (no layout, no canvas 2d).
 */

/**
 * Give every element a measurable rect so the physical layer renders. The
 * rect adapts to an element's own inline width/height when set (mirroring
 * real layout), which is what UkiboriText's fixed sizing relies on.
 */
export function stubElementRects(
  rect = { left: 10, top: 20, width: 120, height: 40 },
): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ): DOMRect {
    const el = this as HTMLElement;
    const inlineWidth =
      typeof el.style?.width === "string" ? parseFloat(el.style.width) : NaN;
    const inlineHeight =
      typeof el.style?.height === "string" ? parseFloat(el.style.height) : NaN;
    const width = Number.isFinite(inlineWidth) ? inlineWidth : rect.width;
    const height = Number.isFinite(inlineHeight) ? inlineHeight : rect.height;
    return {
      left: rect.left,
      top: rect.top,
      width,
      height,
      x: rect.left,
      y: rect.top,
      right: rect.left + width,
      bottom: rect.top + height,
    } as DOMRect;
  });
}

/** A minimal 2d context so canvas rasterization works in jsdom. */
export function stubCanvas2d(): void {
  if (typeof (globalThis as { ImageData?: unknown }).ImageData === "undefined") {
    (globalThis as { ImageData: unknown }).ImageData = class {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
  }
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    (function (
      this: HTMLCanvasElement,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ..._args: any[]
    ): CanvasRenderingContext2D | null {
    const width = this.width;
    const height = this.height;
    const imageData = () => {
      const data = new Uint8ClampedArray(width * height * 4);
      // Ink the center glyph area so masks are non-empty.
      for (let i = 0; i < width * height; i++) {
        const x = i % width;
        const y = Math.floor(i / width);
        const inGlyph = x >= width / 4 && x < (3 * width) / 4 && y >= height / 4 && y < (3 * height) / 4;
        data[i * 4 + 3] = inGlyph ? 255 : 0;
      }
      return { width, height, data };
    };
    return {
      font: "",
      textAlign: "left",
      textBaseline: "alphabetic",
      fillStyle: "#000",
      clearRect: () => undefined,
      fillText: () => undefined,
      // #52 fidelity gate input: font bounding metrics (the same values CSS
      // line layout would resolve for the stub font).
      measureText: (text: string) => ({
        text,
        width: text.length * 10,
        fontBoundingBoxAscent: height * 0.8,
        fontBoundingBoxDescent: height * 0.2,
        actualBoundingBoxAscent: height * 0.5,
        actualBoundingBoxDescent: height * 0.1,
      }),
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      closePath: () => undefined,
      fill: () => undefined,
      getImageData: () => imageData(),
      putImageData: () => undefined,
    } as unknown as CanvasRenderingContext2D;
    }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
  );
}

/**
 * #52 fidelity gate seam: make the LIVE layout measurement usable in jsdom
 * (a single text line box). Without this stub the fidelity gate correctly
 * keeps the DOM ink delegated-off (mask geometry only), which is its own
 * pinned fallback behavior.
 */
export function stubTextLineBox(): void {
  // jsdom's Range has no getClientRects implementation — provide a
  // replaceable empty one first, then report exactly one line box.
  if (Range.prototype.getClientRects === undefined) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      value: () => [] as unknown as DOMRectList,
      configurable: true,
      writable: true,
    });
  }
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
    this: Range,
  ): DOMRectList {
    // UkiboriText rasterizes its single-text-node span; report exactly one
    // line box. The exact geometry is irrelevant to the gate (it must be a
    // single finite rect); the mask ink position it produces is not
    // asserted in jsdom (the canvas itself is stubbed).
    const line = {
      left: 0,
      top: 0,
      width: 120,
      height: 40,
      right: 120,
      bottom: 40,
      x: 0,
      y: 0,
      toJSON: () => line,
    } as DOMRect;
    return [line] as unknown as DOMRectList;
  });
}
