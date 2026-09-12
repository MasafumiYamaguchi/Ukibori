import { expect, it } from "vitest";
import { computeMaskSdf } from "./mask";

it("matches an independent segment-distance oracle on irregular silhouettes", () => {
  let seed = 61;
  for (let sample = 0; sample < 40; sample++) {
    const width = 8, height = 8;
    const alpha = Uint8Array.from({ length: width * height }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed >>> 30 ? 255 : 0;
    });
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && alpha[y * width + x] >= 128;
    const segments: number[][] = [];
    for (let y = -1; y < height; y++) for (let x = -1; x < width; x++) {
      if (inside(x, y) !== inside(x + 1, y)) segments.push([x + 1, y, x + 1, y + 1]);
      if (inside(x, y) !== inside(x, y + 1)) segments.push([x, y + 1, x + 1, y + 1]);
    }
    const sdf = computeMaskSdf({ width, height, alpha });
    for (let r = 0; r < height + 2; r++) for (let c = 0; c < width + 2; c++) {
      const x = c - 0.5, y = r - 0.5;
      const distance = Math.min(...segments.map(([x0, y0, x1, y1]) =>
        Math.hypot(x - Math.max(x0, Math.min(x1, x)), y - Math.max(y0, Math.min(y1, y)))));
      expect(sdf.sdf[r * (width + 2) + c]).toBeCloseTo(inside(c - 1, r - 1) ? -distance : distance, 6);
    }
  }
});
