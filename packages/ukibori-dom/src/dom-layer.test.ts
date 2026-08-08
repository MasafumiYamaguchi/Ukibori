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
    // Positioning semantics are NEVER changed (the overlay paints at
    // z-index -1, so the DOM text stays above it without position:relative).
    expect(button.style.position).toBe("static");

    layer.unregister("primary");
    expect(button.style.getPropertyValue("background")).toBe("red");
    expect(button.style.getPropertyValue("box-shadow")).toBe("1px 2px 3px black");
    expect(button.style.position).toBe("static");
    layer.dispose();
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
    // Document-origin contract: always a direct child of document.body,
    // positioned at the region's DOCUMENT coordinates.
    expect(canvas.parentElement).toBe(document.body);
    expect(canvas.style.zIndex).toBe("-1");
    expect(canvas.style.left).toBe("36px");
    expect(canvas.style.top).toBe("136px");
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
    // The failed registrations must not have touched the DOM styles.
    expect(other.style.getPropertyValue("background")).toBe("blue");
    expect(other.style.getPropertyValue("box-shadow")).toBe("");
    expect(button.style.getPropertyValue("background")).toBe("transparent");
    expect(layer.registry.size).toBe(1);
    layer.dispose();
    expect(other.style.getPropertyValue("background")).toBe("blue");
    expect(button.style.getPropertyValue("background")).toBe("");
  });

  it("updateSurface renames atomically across registry maps and scene identity", () => {
    const fake = makeFakeOverlay();
    const layer = new UkiboriDom({
      overlay: { factory: () => fake.overlay },
      schedule: (cb) => cb(),
      observe: false,
    });
    layer.register(button, BUTTON_OPTIONS);
    layer.updateSurface("primary", { id: "renamed", elevation: 9 });
    expect(layer.registry.has("primary")).toBe(false);
    expect(layer.registry.has("renamed")).toBe(true);
    expect(layer.registry.get("renamed")?.element).toBe(button);
    expect(layer.registry.get("renamed")?.options.id).toBe("renamed");
    // The scene identity moves with the registry.
    layer.render();
    const objectId = layer.debugObjectId();
    expect(objectId).not.toBeNull();
    // Renaming onto an existing id is rejected BEFORE any state changes.
    layer.register(document.createElement("div"), {
      ...BUTTON_OPTIONS,
      id: "taken",
      shape: { kind: "roundedRect", radius: 2 },
    });
    expect(() => layer.updateSurface("renamed", { id: "taken" })).toThrow(
      /duplicate surface id/,
    );
    expect(layer.registry.has("renamed")).toBe(true);
    expect(layer.registry.get("renamed")?.options.elevation).toBe(9);
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
    const resizes = fake.calls.filter((c) => c.type === "resize");
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
});
