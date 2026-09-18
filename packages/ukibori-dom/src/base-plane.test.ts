import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBasePlaneColor, measureBasePlaneRegion } from "./base-plane";
import { UkiboriDom } from "./dom-layer";
import type { Overlay } from "./overlay";
import type { Region, SurfaceImage } from "./types";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("explicit DOM base plane", () => {
  it("converts opaque sRGB once and rejects unsupported backgrounds explicitly", () => {
    expect(parseBasePlaneColor("#808080")!.baseColor.r).toBeCloseTo(0.2158605, 6);
    expect(parseBasePlaneColor("#abc")).toEqual(parseBasePlaneColor("rgb(170,187,204)"));
    expect(parseBasePlaneColor(undefined)).toBeUndefined();
    for (const css of ["transparent", "rgba(1,2,3,0.5)", "linear-gradient(red,blue)", "var(--floor)", ""]) {
      expect(() => parseBasePlaneColor(css)).toThrow(/opaque sRGB/);
    }
  });

  it("covers the entire padding box, renders an empty floor, updates and clears without stale pixels", () => {
    const stage = document.createElement("section"); document.body.append(stage);
    let width = 24, left = 10;
    Object.defineProperties(stage, { clientWidth: { get: () => width }, clientHeight: { value: 12 }, clientLeft: { value: 2 }, clientTop: { value: 2 } });
    vi.spyOn(stage, "getBoundingClientRect").mockImplementation(() => ({ left, top: 20, width: width + 4, height: 16, x: left, y: 20, right: left + width + 4, bottom: 36, toJSON() {} }));
    const paints: SurfaceImage[] = [], positions: Region[] = [];
    const clear = vi.fn();
    const overlay: Overlay = { activeBackend: "cpu", setBackend() {}, gpuCanvas() { throw new Error("CPU fixture"); },
      resizeBackingStore() {}, positionCanvases(region) { positions.push(region); }, paint(image) { paints.push(image); }, clear, dispose() {} };
    const layer = new UkiboriDom({ basePlaneColor: "#808080", overlay: { stage, factory: () => overlay }, observe: false, schedule() {}, dpr: 1 });
    try {
      expect(measureBasePlaneRegion(stage)).toEqual({ x: 12, y: 22, w: 24, h: 12 });
      layer.render();
      expect(paints.at(-1)).toMatchObject({ width: 24, height: 12 });
      expect(paints[0]!.data.every((v, i) => i % 4 !== 3 || v === 255)).toBe(true);
      layer.render(); expect(paints).toHaveLength(1);
      layer.setBasePlaneColor("rgb(128,128,128)"); layer.render(); expect(paints).toHaveLength(1);
      layer.setBasePlaneColor("#eeeeee"); layer.render();
      expect(paints.at(-1)!.data[0]).toBeGreaterThan(paints[0]!.data[0]!);
      width = 32; left = 30; layer.render();
      expect(paints.at(-1)).toMatchObject({ width: 32, height: 12 });
      expect(positions.at(-1)).toEqual({ x: 32, y: 22, w: 32, h: 12 });
      expect(() => layer.setBasePlaneColor("transparent")).toThrow();
      const count = paints.length; layer.render(); expect(paints).toHaveLength(count);
      layer.setBasePlaneColor(undefined); layer.render(); expect(clear).toHaveBeenCalled();
    } finally { layer.dispose(); }
  });

  it("keeps retained baked surfaces aligned when the stage origin changes", () => {
    const stage = document.createElement("section"), surface = document.createElement("button");
    stage.append(surface); document.body.append(stage);
    let left = 10;
    const rect = (x: number, y: number, w: number, h: number): DOMRect => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON() {} });
    Object.defineProperties(stage, { clientWidth: { value: 24 }, clientHeight: { value: 12 } });
    vi.spyOn(stage, "getBoundingClientRect").mockImplementation(() => rect(left, 20, 24, 12));
    const measure = vi.spyOn(surface, "getBoundingClientRect").mockImplementation(() => rect(left + 4, 24, 4, 4));
    const overlay: Overlay = { activeBackend: "cpu", setBackend() {}, gpuCanvas() { throw new Error("CPU fixture"); },
      resizeBackingStore() {}, positionCanvases() {}, paint() {}, clear() {}, dispose() {} };
    const layer = new UkiboriDom({ basePlaneColor: "#808080", overlay: { stage, factory: () => overlay }, observe: false, schedule() {}, dpr: 1 });
    try {
      layer.registerBake("static");
      layer.register(surface, { id: "button", shape: { kind: "roundedRect", radius: 0 }, elevation: 1, thickness: 1, material: "silicone", bakeId: "static" });
      layer.render();
      const owners = layer.debugObjectId()!.data.slice();
      const measurements = measure.mock.calls.length;
      layer.render(); expect(measure).toHaveBeenCalledTimes(measurements);
      left = 50; layer.render();
      expect(layer.debugObjectId()!.data).toEqual(owners);
      expect(layer.debugState().lastRebakeSurfaceCount).toBe(1);
    } finally { layer.dispose(); }
  });
});
