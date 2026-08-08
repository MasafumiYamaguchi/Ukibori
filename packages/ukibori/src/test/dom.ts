import { vi } from "vitest";

/**
 * Shared DOM stubs for jsdom (no layout, no canvas 2d).
 */

/** Give every element a measurable rect so the physical layer renders. */
export function stubElementRects(
  rect = { left: 10, top: 20, width: 120, height: 40 },
): void {
  const domRect = {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  } as DOMRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(domRect);
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
