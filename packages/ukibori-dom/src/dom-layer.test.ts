import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UkiboriDom } from "./dom-layer";
import { OverlayCanvas } from "./overlay";
import type { Overlay } from "./overlay";
import type { Region, SurfaceImage } from "./types";

interface FakeCall {
  type: "resize" | "position" | "paint";
  region?: Region;
  width?: number;
  height?: number;
  image?: SurfaceImage;
}

function makeFakeOverlay() {
  const calls: FakeCall[] = [];
  let cleared = 0;
  let disposed = false;
  let backend: "cpu" | "webgpu" = "cpu";
  const overlay: Overlay = {
    get activeBackend() {
      return backend;
    },
    setBackend(next: "cpu" | "webgpu") {
      backend = next;
    },
    gpuCanvas() {
      const canvas = document.createElement("canvas");
      canvas.setAttribute("data-fake-gpu-canvas", "");
      return canvas;
    },
    resizeBackingStore(width, height) {
      calls.push({ type: "resize", width, height });
    },
    positionCanvases(region) {
      calls.push({ type: "position", region: { ...region } });
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
    activeBackend: () => backend,
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
  // Real browsers resolve the initial CanvasText system color to a used
  // rgb() value. jsdom leaves the keyword unresolved, so pin an explicit
  // opaque inherited color for physical-ink delegation tests (#56).
  host.style.color = "rgb(0, 0, 0)";
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
    expect(resize?.width).toBe(288);
    expect(resize?.height).toBe(172);
    const position = fake.calls.find((c) => c.type === "position");
    expect(position?.region).toEqual({ x: 36, y: 136, w: 288, h: 172 });

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

    const positions = fake.calls.filter((c) => c.type === "position");
    const last = positions[positions.length - 1];
    expect(last?.region).toEqual({ x: 36, y: 136, w: 348, h: 188 });
    layer.dispose();
  });

  it("suppresses the DOM appearance via a managed attribute, ownership-safe across style updates", () => {
    button.style.background = "red";
    button.style.boxShadow = "1px 2px 3px black";
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layer.register(button, BUTTON_OPTIONS);
    expect(button.getAttribute("data-ukibori-surface")).toBe("");
    // Inline styles are NOT touched: the stylesheet rule does the work, so an
    // app/React inline update while registered cannot double-render.
    expect(button.style.getPropertyValue("background")).toBe("red");
    expect(button.style.position).toBe("");

    // The app updates its own style while registered (React style prop).
    button.style.background = "blue";
    layer.unregister("primary");
    // Unregister reveals the LATEST app-owned style, not a mount-time snapshot.
    expect(button.getAttribute("data-ukibori-surface")).toBeNull();
    expect(button.style.getPropertyValue("background")).toBe("blue");
    expect(button.style.getPropertyValue("box-shadow")).toBe("1px 2px 3px black");
    layer.dispose();
  });

  it("suppresses via the injected stylesheet rule", () => {
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layer.register(button, BUTTON_OPTIONS);
    const style = document.querySelector("style[data-ukibori-style]");
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain("[data-ukibori-surface]");
    expect(style?.textContent).toContain("isolation: isolate");
    layer.dispose();
  });

  describe("#52 physical glyph ink compositing policy", () => {
    /** Isotropic 2x2 mask for a 160x160 stubbed box (scene-builder contract). */
    const MASK = {
      width: 2,
      height: 2,
      alpha: new Float32Array([1, 1, 1, 1]),
    };
    const MASK_B = {
      width: 2,
      height: 2,
      alpha: new Float32Array([1, 0, 0, 1]),
    };
    const MASK_OPTIONS = {
      id: "glyph",
      shape: { kind: "mask", mask: MASK } as const,
      elevation: 3,
      thickness: 0.8,
      bevelWidth: 1.1,
      material: "metal",
      // #52: the explicit glyph delegation intent (UkiboriText contract).
      delegateTextInk: true,
    };

    function maskElement(): HTMLSpanElement {
      const span = document.createElement("span");
      span.textContent = "PLAY";
      host.appendChild(span);
      stubRectFor(span, { left: 60, top: 80, width: 160, height: 160 });
      return span;
    }

    function makeLayer() {
      const fake = makeFakeOverlay();
      const layer = new UkiboriDom({
        overlay: { factory: () => fake.overlay },
        schedule: (cb) => cb(),
        observe: false,
        onError: () => undefined,
      });
      return layer;
    }

    it("delegates DOM text ink only for the explicit glyph intent on a mask shape", () => {
      const layer = makeLayer();
      // A roundedRect surface keeps its DOM ink (only background/box-shadow
      // are suppressed).
      layer.register(button, BUTTON_OPTIONS);
      expect(button.getAttribute("data-ukibori-physical-ink")).toBeNull();
      // A GENERIC mask surface (icon silhouette etc.) keeps its DOM text:
      // shape.kind === "mask" alone must NOT delegate the ink.
      const icon = maskElement();
      layer.register(icon, { ...MASK_OPTIONS, id: "icon", delegateTextInk: undefined });
      expect(icon.getAttribute("data-ukibori-physical-ink")).toBeNull();
      // The UkiboriText contract: explicit intent + mask shape.
      const span = maskElement();
      layer.register(span, MASK_OPTIONS);
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      layer.dispose();
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
      expect(icon.getAttribute("data-ukibori-physical-ink")).toBeNull();
      expect(button.getAttribute("data-ukibori-physical-ink")).toBeNull();
    });

    it("never delegates ink for an explicit intent on a non-mask shape", () => {
      const layer = makeLayer();
      layer.register(button, { ...BUTTON_OPTIONS, delegateTextInk: true });
      expect(button.getAttribute("data-ukibori-physical-ink")).toBeNull();
      layer.dispose();
    });

    it("suppresses ink through the stylesheet, never by touching inline styles", () => {
      const span = maskElement();
      span.style.color = "red";
      const layer = makeLayer();
      layer.register(span, MASK_OPTIONS);
      const style = document.querySelector("style[data-ukibori-style]");
      expect(style?.textContent).toContain("[data-ukibori-physical-ink]");
      expect(style?.textContent).toContain("color: transparent");
      // Inline styles are untouched while registered (app/React updates keep
      // working; the stylesheet rule overrides them).
      expect(span.style.getPropertyValue("color")).toBe("red");
      layer.unregister("glyph");
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
      expect(span.style.getPropertyValue("color")).toBe("red");
      layer.dispose();
    });

    it("follows delegation transitions through updateSurface (edge-triggered, no refcount growth)", () => {
      const span = maskElement();
      const layer = makeLayer();
      layer.register(span, MASK_OPTIONS);
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      // generic mask (no intent) -> suppression released exactly once
      layer.updateSurface("glyph", { shape: { kind: "mask", mask: MASK_B }, delegateTextInk: undefined });
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
      // intent on a NON-mask shape -> still no suppression
      layer.updateSurface("glyph", { shape: { kind: "roundedRect", radius: 8 }, delegateTextInk: true });
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
      // intent + mask again -> re-acquired exactly once
      layer.updateSurface("glyph", { shape: { kind: "mask", mask: MASK } });
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      layer.dispose();
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
    });

    it("keeps the attribute exactly once across repeated delegated updates (unregister)", () => {
      const span = maskElement();
      const layer = makeLayer();
      layer.register(span, MASK_OPTIONS);
      for (let i = 0; i < 10; i++) {
        layer.updateSurface("glyph", {
          shape: { kind: "mask", mask: i % 2 === 0 ? MASK : MASK_B },
          elevation: i,
          material: i % 2 === 0 ? "metal" : "matte",
          thickness: 0.8 + i * 0.1,
        });
      }
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      layer.unregister("glyph");
      // One release, despite one acquire + 10 delegated updates: no leak.
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
      layer.dispose();
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
    });

    it("keeps the attribute exactly once across repeated delegated updates (dispose)", () => {
      const span = maskElement();
      const layer = makeLayer();
      layer.register(span, MASK_OPTIONS);
      for (let i = 0; i < 10; i++) {
        layer.updateSurface("glyph", { thickness: 1 + i * 0.25, bevelWidth: 1 + i * 0.5 });
      }
      layer.dispose();
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
    });

    it("non-mask -> delegated -> delegated updates -> non-mask acquires and releases exactly once", () => {
      const span = maskElement();
      const layer = makeLayer();
      layer.register(span, { ...BUTTON_OPTIONS, id: "glyph", shape: { kind: "roundedRect", radius: 8 } });
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
      layer.updateSurface("glyph", { shape: { kind: "mask", mask: MASK }, delegateTextInk: true });
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      // Delegated retained updates must not re-acquire.
      layer.updateSurface("glyph", { shape: { kind: "mask", mask: MASK_B } });
      layer.updateSurface("glyph", { elevation: 9 });
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      layer.updateSurface("glyph", { shape: { kind: "roundedRect", radius: 4 } });
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
      layer.dispose();
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
    });

    it("never removes a pre-existing application-owned ink attribute, even transiently", async () => {
      const span = maskElement();
      span.setAttribute("data-ukibori-physical-ink", "");
      const mutations: MutationRecord[] = [];
      const observer = new MutationObserver((records) => mutations.push(...records));
      observer.observe(span, { attributes: true, attributeOldValue: true });
      const layer = makeLayer();
      layer.register(span, MASK_OPTIONS);
      layer.invalidate("glyph");
      layer.invalidate("glyph");
      await Promise.resolve();
      expect(mutations.filter((record) => record.attributeName === "data-ukibori-physical-ink")).toEqual([]);
      layer.unregister("glyph");
      // The layer only owns what it created.
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      layer.dispose();
      observer.disconnect();
    });

    it("does not cycle the managed ink attribute while refreshing computed color", async () => {
      const span = maskElement();
      const layer = makeLayer();
      const mutations: MutationRecord[] = [];
      const observer = new MutationObserver((records) => mutations.push(...records));
      observer.observe(span, { attributes: true, attributeOldValue: true });
      layer.register(span, MASK_OPTIONS);
      await Promise.resolve();
      mutations.length = 0;

      span.style.color = "rgb(255, 0, 0)";
      layer.invalidate("glyph");
      span.style.color = "rgb(0, 0, 255)";
      layer.invalidate("glyph");
      await Promise.resolve();

      expect(mutations.filter((record) => record.attributeName === "data-ukibori-physical-ink")).toEqual([]);
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      observer.disconnect();
      layer.dispose();
    });

    it("leaves no ink suppression behind when registration fails", () => {
      const span = maskElement();
      const layer = makeLayer();
      layer.register(span, MASK_OPTIONS);
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      // A second registration of the SAME element must fail atomically and
      // must not disturb the existing (owned) suppression.
      expect(() => layer.register(span, { ...MASK_OPTIONS, id: "other" })).toThrow();
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      layer.dispose();
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
    });

    it("preserves the shared-attribute refcount semantics across layers", () => {
      // Two genuine UkiboriDom instances acquiring the SAME element attribute
      // (the ownership map is module-global and refcounted): the attribute
      // must survive until the LAST owner releases.
      const span = maskElement();
      const layerA = makeLayer();
      const layerB = makeLayer();
      layerA.register(span, MASK_OPTIONS);
      layerB.register(span, { ...MASK_OPTIONS, id: "glyph-b" });
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      layerA.unregister("glyph");
      // B still owns it.
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      layerB.unregister("glyph-b");
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
      layerA.dispose();
      layerB.dispose();
    });

    it("keeps text selection and accessibility semantics intact while suppressed", () => {
      const span = maskElement();
      const layer = makeLayer();
      layer.register(span, MASK_OPTIONS);
      // The node, its text and its aria attributes are untouched by the
      // compositing policy (only the ink-painting CSS properties change).
      expect(span.textContent).toBe("PLAY");
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      const range = document.createRange();
      range.selectNodeContents(span);
      expect(range.toString()).toBe("PLAY");
      layer.dispose();
    });

    it("updates live opaque CSS color and falls back/reacquires for alpha", () => {
      const span = maskElement();
      span.style.color = "rgb(255, 0, 0)";
      const layer = makeLayer();
      layer.register(span, MASK_OPTIONS);
      layer.render();
      const first = layer.debugBuffers()!.color;
      const objectId = layer.debugObjectId()!;
      let sample: { x: number; y: number } | undefined;
      for (let y = 0; y < objectId.spec.height && sample === undefined; y++) {
        for (let x = 0; x < objectId.spec.width; x++) {
          if (objectId.get(x, y, 0) === 0) {
            sample = { x, y };
            break;
          }
        }
      }
      expect(sample).toBeDefined();
      const red = first.get(sample!.x, sample!.y, 0);
      const redBlue = first.get(sample!.x, sample!.y, 2);
      expect(red).toBeGreaterThan(redBlue);

      // The suppression rule leaves computed `color` intact, so live author
      // color is readable without touching the managed attribute.
      span.style.color = "rgb(0, 0, 255)";
      layer.invalidate("glyph");
      const blueField = layer.debugBuffers()!.color;
      expect(blueField.get(sample!.x, sample!.y, 2)).toBeGreaterThan(
        blueField.get(sample!.x, sample!.y, 0),
      );
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");

      span.style.color = "rgba(0, 0, 255, 0.5)";
      layer.invalidate("glyph");
      expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
      const fallbackObjectId = layer.debugObjectId()!;
      for (let y = 0; y < fallbackObjectId.spec.height; y++) {
        for (let x = 0; x < fallbackObjectId.spec.width; x++) {
          expect(fallbackObjectId.get(x, y, 0)).toBe(0xffffffff);
        }
      }

      span.style.color = "rgb(17, 17, 17)";
      layer.invalidate("glyph");
      expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
      const recoveredObjectId = layer.debugObjectId()!;
      expect(recoveredObjectId.get(sample!.x, sample!.y, 0)).toBe(0);
      const recovered = layer.debugBuffers()!.color;
      const blackish = recovered.get(sample!.x, sample!.y, 0);
      expect(blackish).toBeLessThan(red);
      layer.dispose();
    });
  });

  it("leaves absolutely positioned descendants' layout untouched by register/unregister", () => {
    // A surface with an absolutely positioned child: the child's containing
    // block must not change when the surface is registered (no
    // position:relative forcing) or unregistered.
    const surface = document.createElement("div");
    surface.style.width = "160px";
    surface.style.height = "44px";
    const child = document.createElement("div");
    child.style.position = "absolute";
    child.style.left = "11px";
    child.style.top = "7px";
    surface.appendChild(child);
    host.appendChild(surface);
    stubRectFor(surface, { left: 100, top: 200, width: 160, height: 44 });
    const childRect = { left: 111, top: 207, width: 20, height: 12 };
    stubRectFor(child, childRect);

    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    const measure = () => child.getBoundingClientRect();
    const before = { ...measure() };
    layer.register(surface, BUTTON_OPTIONS);
    layer.render();
    const during = { ...measure() };
    expect(surface.style.position).toBe("");
    layer.unregister("primary");
    const after = { ...measure() };
    expect(during).toEqual(before);
    expect(after).toEqual(before);
    expect(surface.style.position).toBe("");
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
    // Stage-root contract (default stage = document.body): the canvas is a
    // direct child of the stage and the stage gets the isolation attribute.
    expect(canvas.parentElement).toBe(document.body);
    expect(document.body.getAttribute("data-ukibori-stage")).toBe("");
    expect(canvas.style.zIndex).toBe("-1");
    // In jsdom the containing block is the initial containing block, so the
    // canvas sits at the region's DOCUMENT coordinates.
    expect(canvas.style.left).toBe("36px");
    expect(canvas.style.top).toBe("136px");
    layer.dispose();
    expect(document.body.contains(canvas)).toBe(false);
  });

  it("works inside an opaque stage: canvas is a first-child of the stage, above its background", () => {
    // The regression case: a registered button inside an ordinary opaque
    // parent. The stage IS that parent; the canvas is inserted inside it so
    // it paints within the stage's stacking context (isolation: isolate) —
    // above the parent's background, below the surface text.
    const opaque = document.createElement("section");
    opaque.style.background = "#fff";
    host.appendChild(opaque);
    opaque.appendChild(button);
    stubRectFor(button, { left: 100, top: 200, width: 160, height: 44 });
    const layer = new UkiboriDom({
      overlay: { stage: opaque },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    const overlay = (layer as unknown as { overlay: OverlayCanvas }).overlay;
    expect(overlay.stage).toBe(opaque);
    expect(overlay.canvas.parentElement).toBe(opaque);
    expect(opaque.firstElementChild).toBe(overlay.canvas);
    expect(opaque.getAttribute("data-ukibori-stage")).toBe("");
    // The button's own positioning is untouched inside the opaque parent.
    expect(button.style.position).toBe("");
    layer.dispose();
  });

  it("positions the canvas relative to a positioned containing block", () => {
    // A positioned wrapper establishes the canvas's containing block: the
    // canvas left/top must be expressed in the wrapper's local coordinates.
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    host.appendChild(wrapper);
    wrapper.appendChild(button);
    stubRectFor(button, { left: 100, top: 200, width: 160, height: 44 });
    stubRectFor(wrapper, { left: 40, top: 60, width: 300, height: 400 });
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    const overlay = (layer as unknown as { overlay: OverlayCanvas }).overlay;
    // jsdom lacks offsetParent: stub it to the positioned wrapper.
    Object.defineProperty(overlay.canvas, "offsetParent", {
      value: wrapper,
      configurable: true,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    // Region doc origin (36, 136) minus the wrapper's doc origin (40, 60).
    expect(overlay.canvas.style.left).toBe("-4px");
    expect(overlay.canvas.style.top).toBe("76px");
    layer.dispose();
  });

  it("compensates a SCROLLED containing block (positioned overflow:auto)", () => {
    // The containing block scrolls its content by (30, 50): the canvas is an
    // absolutely positioned child and moves with the scrolled content, so its
    // left/top must be inflated by the block's scrollLeft/scrollTop.
    const wrapper = document.createElement("div");
    wrapper.style.position = "relative";
    wrapper.style.overflow = "auto";
    host.appendChild(wrapper);
    wrapper.appendChild(button);
    stubRectFor(button, { left: 100, top: 200, width: 160, height: 44 });
    stubRectFor(wrapper, { left: 40, top: 60, width: 300, height: 400 });
    wrapper.scrollLeft = 30;
    wrapper.scrollTop = 50;
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    const overlay = (layer as unknown as { overlay: OverlayCanvas }).overlay;
    Object.defineProperty(overlay.canvas, "offsetParent", {
      value: wrapper,
      configurable: true,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    // Origin = doc (40, 60) - scroll (30, 50) = (10, 10); region (36, 136).
    expect(overlay.canvas.style.left).toBe("26px");
    expect(overlay.canvas.style.top).toBe("126px");
    layer.dispose();
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
    // dpr 2 doubles the backing store (288x172 CSS region -> 576x344 texels).
    expect(resizes[resizes.length - 1]?.width).toBe(576);
    expect(resizes[resizes.length - 1]?.height).toBe(344);
    expect(layer.debugState().dpr).toBe(2);
    const paintsBefore = fake.calls.filter((c) => c.type === "paint").length;
    layer.setShadow({ bias: 0.9 });
    layer.render();
    expect(fake.calls.filter((c) => c.type === "paint").length).toBe(paintsBefore + 1);
    layer.dispose();
  });

  it("setShadow fully replaces the option state (no stale merged fields)", () => {
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layer.setShadow({ stepSize: 0.5, bias: 0.4, maxDistance: 120 });
    expect(layer.debugShadowOptions()).toEqual({ stepSize: 0.5, bias: 0.4, maxDistance: 120 });
    // A later call WITHOUT maxDistance must remove it — nothing is merged.
    layer.setShadow({ bias: 0.2 });
    expect(layer.debugShadowOptions()).toEqual({ bias: 0.2 });
    // `{}` resets every option to its default (handled by the render path).
    layer.setShadow({});
    expect(layer.debugShadowOptions()).toEqual({});
    layer.dispose();
  });

  it("passes environment/exposure through and re-renders without touching the registry", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
      environment: { intensity: 0 },
      exposure: 1,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    const lastImage = () => {
      const all = fake.calls.filter((c) => c.type === "paint");
      return all[all.length - 1]!.image!;
    };
    // Button center pixel in the region grid: (144, 86) with width 288.
    const p = (86 * 288 + 144) * 4;

    // environment OFF: the pre-#22 ambient + direct response.
    const envOff = lastImage().data[p];
    // Retained update: environment ON re-renders the SAME layer and registry.
    layer.setEnvironment({ intensity: 1 });
    layer.render();
    expect(layer).toBeDefined();
    expect(layer.registry.size).toBe(1);
    expect(layer.registry.get("primary")).toBeDefined();
    const envOn = lastImage().data[p];
    expect(envOn).toBeGreaterThan(envOff);
    // Full replacement: absent shares reset to their defaults.
    expect(layer.debugEnvironment()).toEqual({ intensity: 1, diffuseIntensity: 1, specularIntensity: 1 });

    // exposure 0: the linear result collapses to black (still finite/opaque).
    layer.setExposure(0);
    layer.render();
    const zero = lastImage().data;
    expect(zero[p]).toBe(0);
    expect(zero[p + 1]).toBe(0);
    expect(zero[p + 2]).toBe(0);
    expect(zero[p + 3]).toBe(255);
    expect(layer.debugExposure()).toBe(0);
    layer.dispose();
  });

  it("propagates the environment specular share through the retained setter", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
      // A tilted light keeps the metal plateau below direct-specular
      // saturation, so the environment specular share is observable there.
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
      environment: { intensity: 1, specularIntensity: 1 },
    });
    layer.register(button, { ...BUTTON_OPTIONS, material: "metal" });
    layer.render();
    const lastImage = () => {
      const all = fake.calls.filter((c) => c.type === "paint");
      return all[all.length - 1]!.image!;
    };
    const p = (86 * 288 + 144) * 4;
    const withSpecular = lastImage().data[p];

    // Specular share 0: the metal's environment lift disappears while the
    // intensity stays on (metal has no environment diffuse).
    layer.setEnvironment({ intensity: 1, specularIntensity: 0 });
    layer.render();
    expect(layer.debugEnvironment()).toEqual({ intensity: 1, diffuseIntensity: 1, specularIntensity: 0 });
    const withoutSpecular = lastImage().data[p];
    expect(withoutSpecular).toBeLessThan(withSpecular);
    layer.dispose();
  });

  it("sanitizes invalid environment/exposure to the defaults", () => {
    const layer = new UkiboriDom({
      schedule: (cb) => cb(),
      observe: false,
      environment: { intensity: NaN, specularIntensity: 2 },
      exposure: -2,
    });
    expect(layer.debugEnvironment()).toEqual({ intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 });
    expect(layer.debugExposure()).toBe(1);
    layer.setEnvironment({ intensity: -1, diffuseIntensity: Infinity });
    layer.setExposure(Infinity);
    expect(layer.debugEnvironment()).toEqual({ intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 });
    expect(layer.debugExposure()).toBe(1);
    layer.dispose();
  });

  it("setMargin resets to the default when given undefined", () => {
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layer.setMargin(32);
    expect(layer.debugState().region).toBeNull();
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    const withMargin = layer.debugState().region;
    layer.setMargin(undefined);
    layer.render();
    const withDefault = layer.debugState().region;
    expect(withDefault!.x).toBeLessThan(withMargin!.x);
    expect(withDefault!.w).toBeGreaterThan(withMargin!.w);
    layer.dispose();
  });

  it("produces the same CSS-space shadow geometry at dpr 1 and dpr 2", () => {
    // A rounded-rect button plus a mask glyph, with an explicitly configured
    // bias so the scaled shadow options are exercised end-to-end. A diagonal
    // light is required for cast shadows to exist at all.
    const mask = {
      width: 20,
      height: 8,
      alpha: new Float32Array(160).fill(1),
    };
    const render = (dpr: number) => {
      const layer = new UkiboriDom({
        schedule: (cb) => cb(),
        observe: false,
        dpr,
        margin: 16,
        light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
        shadow: { bias: 0.4 },
      });
      layer.register(button, BUTTON_OPTIONS);
      const glyph = document.createElement("div");
      glyph.style.width = "20px";
      glyph.style.height = "8px";
      host.appendChild(glyph);
      stubRectFor(glyph, { left: 110, top: 210, width: 20, height: 8 });
      layer.register(glyph, {
        id: "glyph",
        shape: { kind: "mask", mask },
        elevation: 6,
        thickness: 1,
        bevelWidth: 1,
        material: "metal",
      });
      layer.render();
      const buffers = layer.debugBuffers();
      const objectId = layer.debugObjectId();
      if (buffers === null || objectId === null || buffers.visibility === undefined) {
        throw new Error("expected a render with a shadow pass");
      }
      const out = { height: buffers.height, visibility: buffers.visibility, objectId };
      layer.dispose();
      return out;
    };

    const at1 = render(1);
    const at2 = render(2);
    const { width: w1, height: h1 } = at1.height.spec;

    // The dpr-2 scene is the exact 2x similarity image of the dpr-1 scene and
    // every length-valued shadow parameter was scaled by the same transform.
    // The two texel grids sample different CSS centers, so the comparison is:
    //
    //  (a) heights: on texels with a FLAT 3x3 neighborhood the underlying
    //      field is constant, and the dpr-2 texel that covers the same area
    //      must store exactly 2x the dpr-1 value;
    //  (b) visibility: on texels with a UNIFORM 3x3 visibility neighborhood
    //      (away from the shadow boundary) all four dpr-2 texels of the
    //      covering 2x2 block must match the dpr-1 decision;
    //  (c) the shadowed texel count at dpr 2 must be 4x the dpr-1 count up to
    //      the boundary band (perimeter of the region);
    //  (d) the per-row shadow boundary positions in CSS px must agree within
    //      the dpr-1 texel quantization.
    const isFlat = (x: number, y: number): boolean => {
      let min = Infinity;
      let max = -Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w1 || ny >= h1) {
            return false;
          }
          const v = at1.height.get(nx, ny, 0);
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      return max - min < 1e-9;
    };
    const visUniform = (x: number, y: number): boolean => {
      const center = at1.visibility.get(x, y, 0);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w1 || ny >= h1) {
            return false;
          }
          if (at1.visibility.get(nx, ny, 0) !== center) {
            return false;
          }
        }
      }
      return true;
    };
    const ownerUniform = (x: number, y: number): boolean => {
      const center = at1.objectId.get(x, y, 0);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w1 || ny >= h1) {
            return false;
          }
          if (at1.objectId.get(nx, ny, 0) !== center) {
            return false;
          }
        }
      }
      return true;
    };

    let shadowed1 = 0;
    let boundaryBand = 0;
    for (let y = 0; y < h1; y++) {
      for (let x = 0; x < w1; x++) {
        if (at1.visibility.get(x, y, 0) === 0) {
          shadowed1++;
        }
        if (!visUniform(x, y)) {
          boundaryBand++;
          continue;
        }
        // (b) uniform visibility interior: the whole 2x2 block agrees.
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            expect(at2.visibility.get(2 * x + dx, 2 * y + dy, 0)).toBe(
              at1.visibility.get(x, y, 0),
            );
          }
        }
        // (a) flat height interior: exact 2x similarity.
        if (isFlat(x, y)) {
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              expect(at2.height.get(2 * x + dx, 2 * y + dy, 0)).toBe(
                2 * at1.height.get(x, y, 0),
              );
            }
          }
        }
      }
    }

    // (b2) ownership interior (surface boundaries are a different set of
    // boundaries than shadow boundaries): the 2x2 block must be owned by the
    // same surface.
    for (let y = 0; y < h1; y++) {
      for (let x = 0; x < w1; x++) {
        if (!ownerUniform(x, y)) {
          continue;
        }
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            expect(at2.objectId.get(2 * x + dx, 2 * y + dy, 0)).toBe(
              at1.objectId.get(x, y, 0),
            );
          }
        }
      }
    }

    // The scene must actually contain cast-shadowed pixels.
    expect(shadowed1).toBeGreaterThan(0);

    // (c) dpr-2 shadowed count matches 4x the dpr-1 count within the band.
    let shadowed2 = 0;
    for (let v = 0; v < at2.visibility.spec.height; v++) {
      for (let u = 0; u < at2.visibility.spec.width; u++) {
        if (at2.visibility.get(u, v, 0) === 0) {
          shadowed2++;
        }
      }
    }
    const band = 8 * (w1 + h1);
    expect(shadowed2).toBeGreaterThanOrEqual(4 * shadowed1 - band);
    expect(shadowed2).toBeLessThanOrEqual(4 * shadowed1 + band);

    // (d) the cast-shadow region's CSS-space bounding box agrees within the
    // dpr-1 texel quantization (thin per-row bands make per-row boundary
    // positions unstable between the two grids; the region bounds are not).
    const bbox = (
      vis: typeof at1.visibility,
      toCssX: (u: number) => number,
      toCssY: (v: number) => number,
    ) => {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (let v = 0; v < vis.spec.height; v++) {
        for (let u = 0; u < vis.spec.width; u++) {
          if (vis.get(u, v, 0) !== 0) {
            continue;
          }
          const x = toCssX(u);
          const y = toCssY(v);
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
      return { minX, maxX, minY, maxY };
    };
    const box1 = bbox(at1.visibility, (x) => x + 0.5, (y) => y + 0.5);
    const box2 = bbox(at2.visibility, (u) => (u + 0.5) / 2, (v) => (v + 0.5) / 2);
    for (const key of ["minX", "maxX", "minY", "maxY"] as const) {
      expect(Math.abs(box1[key] - box2[key])).toBeLessThanOrEqual(2);
    }
  });

  it("registration is atomic: a failed duplicate register leaves no suppression behind", () => {
    const other = document.createElement("div");
    other.style.background = "blue";
    host.appendChild(other);
    stubRectFor(other, { left: 400, top: 200, width: 60, height: 20 });
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layer.register(button, BUTTON_OPTIONS);
    // Same element re-registered under another id.
    expect(() => layer.register(button, { ...BUTTON_OPTIONS, id: "again" })).toThrow(
      /already registered/,
    );
    // Same id on a fresh element.
    expect(() => layer.register(other, BUTTON_OPTIONS)).toThrow(/duplicate surface id/);
    // The failed registrations must not have touched the DOM at all.
    expect(other.getAttribute("data-ukibori-surface")).toBeNull();
    expect(button.getAttribute("data-ukibori-surface")).toBe("");
    expect(layer.registry.size).toBe(1);
    layer.dispose();
    expect(button.getAttribute("data-ukibori-surface")).toBeNull();
  });

  it("invalidates on an ancestor mutation that moves a registered element", async () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: true,
    });
    // The button lives inside a wrapper; an ancestor mutation (a sibling
    // inserted above it) moves the button without resizing or touching it.
    const wrapper = document.createElement("div");
    host.appendChild(wrapper);
    wrapper.appendChild(button);
    stubRectFor(button, { left: 100, top: 200, width: 160, height: 44 });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    const resizesBefore = fake.calls.filter((c) => c.type === "position").length;

    const spacer = document.createElement("div");
    spacer.style.height = "80px";
    wrapper.insertBefore(spacer, button);
    stubRectFor(button, { left: 100, top: 280, width: 160, height: 44 });

    // The document-level MutationObserver delivers asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const resizes = fake.calls.filter((c) => c.type === "position");
    expect(resizes.length).toBeGreaterThan(resizesBefore);
    const last = resizes[resizes.length - 1];
    // Region follows the moved button (margin 64 around 100..260 x 280..324).
    expect(last?.region).toEqual({ x: 36, y: 216, w: 288, h: 172 });
    layer.dispose();
  });

  it("updateSurface refuses id changes (ids are immutable, scene order preserved)", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    const second = document.createElement("div");
    host.appendChild(second);
    stubRectFor(second, { left: 300, top: 200, width: 60, height: 20 });
    layer.register(second, { ...BUTTON_OPTIONS, id: "badge" });
    const orderBefore = layer.registry.entries().map((e) => e.id);

    expect(() => layer.updateSurface("primary", { id: "renamed" })).toThrow(/immutable/);
    // Nothing changed: registry keys, element maps and scene order intact.
    expect(layer.registry.entries().map((e) => e.id)).toEqual(orderBefore);
    expect(layer.registry.get("primary")?.options.id).toBe("primary");
    layer.dispose();
  });

  it("treats hidden/zero-size registered surfaces as temporarily non-renderable", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
      margin: 16,
    });
    const hidden = document.createElement("div");
    hidden.style.display = "none";
    host.appendChild(hidden);
    stubRectFor(hidden, { left: 0, top: 0, width: 0, height: 0 });
    layer.register(button, BUTTON_OPTIONS);
    layer.register(hidden, {
      id: "hidden",
      shape: { kind: "roundedRect", radius: 4 },
      elevation: 0,
      thickness: 1,
      material: "silicone",
    });
    // The visible surface must render while the hidden one is registered.
    layer.render();
    const paint1 = fake.calls.find((c) => c.type === "paint");
    expect(paint1?.image?.width).toBe(192);
    expect(layer.registry.size).toBe(2);
    expect(layer.debugState().nodeCount).toBe(2);

    // When the hidden element becomes measurable again it rejoins the scene.
    hidden.style.display = "block";
    stubRectFor(hidden, { left: 300, top: 200, width: 60, height: 20 });
    layer.invalidate("hidden");
    layer.render();
    const resizes = fake.calls.filter((c) => c.type === "position");
    const last = resizes[resizes.length - 1];
    // Region now covers both surfaces (button 100..260 x 200..244, badge
    // 300..360 x 200..220) inflated by the 16px margin.
    expect(last?.region).toEqual({ x: 84, y: 184, w: 292, h: 76 });
    layer.dispose();
  });

  it("observe:false does not wire MutationObserver-driven renders", () => {
    let scheduled = 0;
    const layer = new UkiboriDom({
      schedule: () => {
        scheduled++;
      },
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    const scheduledAfterRegister = scheduled;
    // A text change inside the surface must NOT invalidate when observe:false.
    button.textContent = "changed text";
    expect(scheduled).toBe(scheduledAfterRegister);
    layer.dispose();
  });

  it("releases the stage attribute on dispose, preserving app-owned state", () => {
    // Clean baseline: a layer on the default body stage acquires and releases.
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layer.register(button, BUTTON_OPTIONS);
    expect(document.body.getAttribute("data-ukibori-stage")).toBe("");
    layer.dispose();
    expect(document.body.getAttribute("data-ukibori-stage")).toBeNull();
  });

  it("allows a late unregister after dispose", () => {
    const layer = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layer.register(button, BUTTON_OPTIONS);

    layer.dispose();

    expect(() => layer.unregister("primary")).not.toThrow();
    expect(button.getAttribute("data-ukibori-surface")).toBeNull();
  });

  it("preserves a pre-existing app-owned stage attribute", () => {
    host.setAttribute("data-ukibori-stage", "");
    const layer = new UkiboriDom({
      overlay: { stage: host },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.dispose();
    // The application set the attribute itself: the layer must not remove it.
    expect(host.getAttribute("data-ukibori-stage")).toBe("");
    host.removeAttribute("data-ukibori-stage");
  });

  it("reference-counts the stage attribute across multiple instances", () => {
    const stage = document.createElement("main");
    host.appendChild(stage);
    stage.appendChild(button);
    stubRectFor(button, { left: 100, top: 200, width: 160, height: 44 });
    const layerA = new UkiboriDom({ overlay: { stage }, schedule: (cb) => cb(), observe: false });
    const layerB = new UkiboriDom({ overlay: { stage }, schedule: (cb) => cb(), observe: false });
    layerA.register(button, BUTTON_OPTIONS);
    expect(stage.getAttribute("data-ukibori-stage")).toBe("");
    layerA.dispose();
    // Still owned by layerB.
    expect(stage.getAttribute("data-ukibori-stage")).toBe("");
    layerB.dispose();
    expect(stage.getAttribute("data-ukibori-stage")).toBeNull();
  });

  it("reference-counts the surface attribute across multiple instances", () => {
    const layerA = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    const layerB = new UkiboriDom({ schedule: (cb) => cb(), observe: false });
    layerA.register(button, BUTTON_OPTIONS);
    layerB.register(button, { ...BUTTON_OPTIONS, id: "second" });
    expect(button.getAttribute("data-ukibori-surface")).toBe("");
    layerA.unregister("primary");
    // Still registered in layerB: suppression must remain active.
    expect(button.getAttribute("data-ukibori-surface")).toBe("");
    layerB.unregister("second");
    expect(button.getAttribute("data-ukibori-surface")).toBeNull();
    layerA.dispose();
    layerB.dispose();
  });

  it("settles after an initial render: Ukibori-owned mutations do not schedule renders", async () => {
    // jsdom has no 2d context; paint() must tolerate a null context silently.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    let scheduled = 0;
    const layer = new UkiboriDom({
      schedule: (cb) => {
        scheduled++;
        cb();
      },
      observe: true,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.render();
    const afterRender = scheduled;
    // Flush the document-level MutationObserver microtasks triggered by the
    // layer's own DOM writes (canvas attributes, managed attributes). They
    // must be filtered: no additional renders may be scheduled.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toBe(afterRender);

    // External mutations still invalidate.
    button.setAttribute("style", "width: 120px");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toBe(afterRender + 1);
    layer.dispose();
  });

  it("clearing the #41 angularRadius override restores hard shadows on the SAME instance", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
    });
    const dir = { x: -0.6, y: -0.4, z: Math.sqrt(1 - 0.36 - 0.16) };

    // soft: a positive radius produces CONTINUOUS visibility
    layer.register(button, BUTTON_OPTIONS);
    layer.setLight(dir, 1, 0.5);
    layer.render();
    const softVis = layer.debugBuffers()!.visibility!;
    const softValues: number[] = [];
    for (let y = 0; y < softVis.spec.height; y++) {
      for (let x = 0; x < softVis.spec.width; x++) {
        softValues.push(softVis.get(x, y, 0));
      }
    }
    expect(softValues.some((v) => v > 0 && v < 1)).toBe(true);

    // STALE-STATE REGRESSION: `undefined` must DELETE the stored radius so
    // the renderer default (0 = exact hard shadow) applies again — on the
    // SAME retained instance, not through a rebuild.
    layer.setLight(dir, 1, undefined);
    expect((layer as unknown as { light: { angularRadius?: number } }).light.angularRadius).toBeUndefined();
    layer.render();
    const restoredVis = layer.debugBuffers()!.visibility!;
    const restoredValues: number[] = [];
    for (let y = 0; y < restoredVis.spec.height; y++) {
      for (let x = 0; x < restoredVis.spec.width; x++) {
        restoredValues.push(restoredVis.get(x, y, 0));
      }
    }
    // #53: the DOM display field for a HARD frame is the ring-rule binomial
    // refinement (the visible edge-quality change) — an exact dyadic k/16
    // rational at edge texels, binary {0,1} everywhere else. The soft
    // k/n speckle field is gone; the restore must reproduce exactly the
    // refined hard field (the equality check with the never-soft reference
    // below pins it value-for-value).
    expect(
      restoredValues.every(
        (v) => (v === 0 || v === 1 || (v * 16 === Math.round(v * 16) && v > 0 && v < 1)),
      ),
    ).toBe(true);

    // ...and the restored field equals an independent never-soft instance
    const refFake = makeFakeOverlay();
    const refLayer = new UkiboriDom({
      overlay: { factory: () => refFake.overlay },
      schedule: (cb) => cb(),
      observe: false,
    });
    refLayer.register(button, BUTTON_OPTIONS);
    refLayer.setLight(dir, 1);
    refLayer.render();
    const refVis = refLayer.debugBuffers()!.visibility!;
    const refValues: number[] = [];
    for (let y = 0; y < refVis.spec.height; y++) {
      for (let x = 0; x < refVis.spec.width; x++) {
        refValues.push(refVis.get(x, y, 0));
      }
    }
    expect(restoredValues).toEqual(refValues);

    // NaN also clears the override defensively
    layer.setLight(dir, 1, Number.NaN);
    expect((layer as unknown as { light: { angularRadius?: number } }).light.angularRadius).toBeUndefined();
    layer.render();
    expect(layer.debugBuffers()!.visibility).not.toBeNull();
    layer.dispose();
    refLayer.dispose();
  });

  it("demo debug output settles: idempotent canvas sizing stops scheduling after a one-time resize", async () => {
    // jsdom has no 2d context; paint() must tolerate a null context silently.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    let scheduled = 0;
    const layer = new UkiboriDom({
      schedule: (cb) => {
        scheduled++;
        cb();
      },
      observe: true,
    });
    layer.register(button, BUTTON_OPTIONS);
    // An app-owned debug canvas (like the demo's buffer views) is NOT a
    // Ukibori-managed node: the document observer sees its attribute writes
    // as external mutations.
    const debug = document.createElement("canvas");
    host.appendChild(debug);
    // refreshDebug-equivalent with the idempotency guard from the demo.
    const draw = (width: number, height: number) => {
      if (debug.width !== width) {
        debug.width = width;
      }
      if (debug.height !== height) {
        debug.height = height;
      }
    };
    layer.render();
    const atRest = scheduled;

    // The demo's FIRST refreshDebug: a one-time debug-canvas resize. Exactly
    // one additional render is scheduled.
    draw(288, 172);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterOneTimeResize = scheduled;
    expect(afterOneTimeResize).toBe(atRest + 1);

    // The render it scheduled ran (sync scheduler). Its refreshDebug
    // re-asserts the SAME sizes: the guard writes nothing, so no mutation
    // and no further scheduling — the page settles.
    draw(288, 172);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toBe(afterOneTimeResize);

    // Without the guard the same-value write is still an attribute mutation
    // (jsdom records every setAttribute): the feedback loop would persist.
    debug.width = 288;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toBe(afterOneTimeResize + 1);

    // A real external change invalidates as usual.
    debug.setAttribute("data-marker", "x");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduled).toBe(afterOneTimeResize + 2);
    layer.dispose();
  });
});
