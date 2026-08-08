import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UkiboriDom } from "./dom-layer";
import { OverlayCanvas } from "./overlay";
import type { Overlay } from "./overlay";
import type { Region, SurfaceImage } from "./types";

interface FakeCall {
  type: "resize" | "paint";
  region?: Region;
  dpr?: number;
  image?: SurfaceImage;
}

function makeFakeOverlay() {
  const calls: FakeCall[] = [];
  let cleared = 0;
  let disposed = false;
  const overlay: Overlay = {
    resizeAndPosition(region, dpr) {
      calls.push({ type: "resize", region: { ...region }, dpr });
    },
    paint(image) {
      calls.push({ type: "paint", image });
    },
    clear() {
      cleared++;
    },
    dispose() {
      disposed = true;
    },
  };
  return {
    overlay,
    calls,
    cleared: () => cleared,
    disposed: () => disposed,
  };
}

function stubRectFor(el: Element, rect: { left: number; top: number; width: number; height: number }) {
  const domRect = {
    ...rect,
    x: rect.left,
    y: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
  } as DOMRect;
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue(domRect);
}

const BUTTON_OPTIONS = {
  id: "primary",
  shape: { kind: "roundedRect", radius: 10 } as const,
  elevation: 4,
  thickness: 2,
  bevelWidth: 3,
  material: "silicone",
};

let host: HTMLDivElement;
let button: HTMLButtonElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Primary action");
  button.textContent = "Press me";
  host.appendChild(button);
  stubRectFor(button, { left: 100, top: 200, width: 160, height: 44 });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("UkiboriDom — DOM integration", () => {
  it("registers a real DOM button and renders it onto the overlay without replacing the DOM", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();

    // The overlay covers the region (button rect inflated by the shadow margin).
    const resize = fake.calls.find((c) => c.type === "resize");
    expect(resize?.region).toEqual({ x: 36, y: 136, w: 288, h: 172 });
    expect(resize?.dpr).toBe(1);

    const paint = fake.calls.find((c) => c.type === "paint");
    expect(paint?.image?.width).toBe(288);
    expect(paint?.image?.height).toBe(172);
    // Pixel at the button's center: opaque surface (physical relief).
    const alpha = paint?.image?.data[(86 * 288 + 144) * 4 + 3];
    expect(alpha).toBe(255);
    // Pixel up-left of the button, inside the shadow margin: base plane, lit -> transparent.
    const baseAlpha = paint?.image?.data[(10 * 288 + 10) * 4 + 3];
    expect(baseAlpha).toBe(0);

    // The DOM button is untouched: same element, DOM-owned semantics intact.
    expect(host.contains(button)).toBe(true);
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Primary action");
    expect(button.textContent).toBe("Press me");

    const clickSpy = vi.fn();
    button.addEventListener("click", clickSpy);
    button.click();
    expect(clickSpy).toHaveBeenCalledTimes(1);

    expect(layer.debugState().nodeCount).toBe(1);
    expect(layer.debugState().region).toEqual({ x: 36, y: 136, w: 288, h: 172 });
    expect(layer.debugBuffers()).not.toBeNull();
    layer.dispose();
  });

  it("mount/unmount updates the retained scene and clears the overlay when empty", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    const second = document.createElement("div");
    stubRectFor(second, { left: 300, top: 200, width: 60, height: 20 });
    host.appendChild(second);
    layer.register(second, { ...BUTTON_OPTIONS, id: "badge", elevation: 8, thickness: 1 });
    layer.render();
    expect(layer.debugState().nodeCount).toBe(2);

    layer.unregister("primary");
    layer.render();
    expect(layer.debugState().nodeCount).toBe(1);
    expect(layer.registry.has("primary")).toBe(false);

    layer.unregister("badge");
    layer.render();
    expect(fake.cleared()).toBeGreaterThan(0);
    expect(layer.debugState().region).toBeNull();
    layer.dispose();
  });

  it("re-measures on invalidation and the overlay follows the new geometry (resize)", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();

    stubRectFor(button, { left: 100, top: 200, width: 220, height: 60 });
    layer.invalidate("primary");
    layer.render();

    const resizes = fake.calls.filter((c) => c.type === "resize");
    const last = resizes[resizes.length - 1];
    expect(last?.region).toEqual({ x: 36, y: 136, w: 348, h: 188 });
    layer.dispose();
  });

  it("suppresses the DOM background/shadow on mount and restores them on unmount", () => {
    button.style.background = "red";
    button.style.boxShadow = "1px 2px 3px black";
    button.style.position = "static";
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layer.register(button, BUTTON_OPTIONS);
    expect(button.style.getPropertyValue("background")).toBe("transparent");
    expect(button.style.getPropertyPriority("background")).toBe("important");
    expect(button.style.getPropertyValue("box-shadow")).toBe("none");
    // Forced positioned so the DOM text paints above the overlay.
    expect(button.style.position).toBe("relative");

    layer.unregister("primary");
    expect(button.style.getPropertyValue("background")).toBe("red");
    expect(button.style.getPropertyValue("box-shadow")).toBe("1px 2px 3px black");
    expect(button.style.position).toBe("static");
    layer.dispose();
  });

  it("the overlay canvas is pointer-events:none and inert to AT / focus", () => {
    // jsdom has no 2d context; paint() must tolerate a null context silently.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    const overlay = (layer as unknown as { overlay: OverlayCanvas }).overlay;
    const canvas = overlay.canvas;
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    expect(canvas.style.pointerEvents).toBe("none");
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.getAttribute("role")).toBe("presentation");
    expect(canvas.tabIndex).toBe(-1);
    expect(canvas.parentElement).toBe(document.body);
    layer.dispose();
    expect(document.body.contains(canvas)).toBe(false);
  });

  it("skips re-render when scroll re-measures identical geometry", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: true,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    const paintsAfterFirst = fake.calls.filter((c) => c.type === "paint").length;
    expect(paintsAfterFirst).toBe(1);

    // Scroll with document-relative coordinates: geometry is unchanged.
    document.dispatchEvent(new Event("scroll"));
    expect(fake.calls.filter((c) => c.type === "paint").length).toBe(1);

    // Scroll after a real geometry change re-renders.
    stubRectFor(button, { left: 130, top: 210, width: 160, height: 44 });
    document.dispatchEvent(new Event("scroll"));
    const paints = fake.calls.filter((c) => c.type === "paint").length;
    expect(paints).toBe(2);
    layer.dispose();
  });

  it("updateSurface merges options and a fresh mask identity rebuilds the scene", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    const firstPaint = fake.calls.filter((c) => c.type === "paint").length;

    layer.updateSurface("primary", { elevation: 9 });
    layer.render();
    expect(layer.debugState().nodeCount).toBe(1);

    // A new mask object identity invalidates the renderer's per-mask SDF
    // cache. The mask aspect must be isotropic with the 160x44 button
    // (160/44 == 40/11) or createScene rejects it (#19 mapping contract).
    const mask = { width: 40, height: 11, alpha: new Float32Array(440).fill(1) };
    layer.updateSurface("primary", { shape: { kind: "mask", mask } });
    layer.render();
    expect(fake.calls.filter((c) => c.type === "paint").length).toBe(firstPaint + 2);
    layer.dispose();
  });

  it("reports render errors through onError instead of throwing", () => {
    const fake = makeFakeOverlay();
    const errors: unknown[] = [];
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      // Do not auto-render on register: only the explicit render() below runs.
      schedule: () => {},
      observe: false,
      onError: (e) => errors.push(e),
    });
    // Unknown material ref -> renderer createScene throws.
    layer.register(button, { ...BUTTON_OPTIONS, material: "does-not-exist" });
    expect(() => layer.render()).not.toThrow();
    expect(errors.length).toBe(1);
    expect(String(errors[0])).toContain("unknown material");
    layer.dispose();
  });

  it("exposes the intermediate renderer buffers for debug views", () => {
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    const buffers = layer.debugBuffers();
    expect(buffers).not.toBeNull();
    expect(buffers!.color.spec.width).toBe(288);
    expect(buffers!.visibility).not.toBeNull();
    expect(buffers!.height.spec.height).toBe(172);
    layer.dispose();
  });

  it("exposes the ownership buffer used for compositing", () => {
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    const objectId = layer.debugObjectId();
    expect(objectId).not.toBeNull();
    // The button footprint (scene coords) is owned by surface index 0.
    expect(objectId!.get(144, 86, 0)).toBe(0);
    // The base-plane margin is unowned.
    expect(objectId!.get(10, 10, 0)).toBe(0xffffffff);
    layer.dispose();
  });

  it("re-renders at a new dpr and with new shadow options", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    layer.setDpr(2);
    layer.render();
    const resizes = fake.calls.filter((c) => c.type === "resize");
    expect(resizes[resizes.length - 1]?.dpr).toBe(2);
    expect(layer.debugState().dpr).toBe(2);
    const paintsBefore = fake.calls.filter((c) => c.type === "paint").length;
    layer.setShadow({ bias: 0.9 });
    layer.render();
    expect(fake.calls.filter((c) => c.type === "paint").length).toBe(paintsBefore + 1);
    layer.dispose();
  });
});
