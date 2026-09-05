import { act } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCanvas2d, stubElementRects } from "../test/dom";
import { Ukibori, UkiboriText } from "../index";
import type { UkiboriDom } from "ukibori-dom";

/**
 * React PLAY glyph path (#21): <UkiboriText> keeps the text as DOM-owned
 * accessible content and rasterizes its glyph into a #19 MaskSource that
 * participates in the physical scene (mask surface registered in the shared
 * layer).
 */

const flushAsync = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UkiboriText glyph integration", () => {
  it("registers a mask surface while the DOM text stays visible and accessible", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText sceneId="play" text="PLAY" elevation={6} thickness={0.8} bevelWidth={1.1} material="metal" />
      </Ukibori>,
    );
    await flushAsync();

    // DOM-owned text: visible, selectable, semantic.
    const textNode = screen.getByText("PLAY");
    expect(textNode.tagName).toBe("SPAN");
    expect(textNode.textContent).toBe("PLAY");

    // The layer holds the mask surface for the glyph.
    const layerNow = layer!;
    expect(layerNow.registry.has("play")).toBe(true);
    const entry = layerNow.registry.get("play")!;
    expect(entry.options.shape.kind).toBe("mask");
    if (entry.options.shape.kind === "mask") {
      expect(entry.options.shape.mask.width).toBeGreaterThan(0);
      expect(entry.options.shape.mask.height).toBeGreaterThan(0);
    }

    // The scene rendered with the glyph as physical geometry (buffers exist).
    expect(layerNow.debugBuffers()).not.toBeNull();
    const objectId = layerNow.debugObjectId();
    expect(objectId).not.toBeNull();
  });

  it("updates the mask when the text changes (retained updateSurface)", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const { rerender } = render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText sceneId="g" text="PLAY" elevation={6} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    const maskBefore = (layer!.registry.get("g")!.options.shape as { kind: "mask"; mask: unknown }).mask;

    rerender(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText sceneId="g" text="STOP" elevation={6} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    expect(screen.getByText("STOP")).toBeInTheDocument();
    const shape = layer!.registry.get("g")!.options.shape;
    expect(shape.kind).toBe("mask");
    const maskAfter = (shape as { kind: "mask"; mask: unknown }).mask;
    // A fresh rasterization: new mask object, same retained surface entry.
    expect(maskAfter).not.toBe(maskBefore);
  });
});

describe("UkiboriText #52 physical ink compositing policy", () => {
  it("delegates the glyph ink to the physical relief while the node, text and aria stay intact", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const { unmount } = render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText
          sceneId="play"
          text="PLAY"
          aria-label="Play button label"
          elevation={3}
          thickness={0.8}
          bevelWidth={1.1}
          material="metal"
        />
      </Ukibori>,
    );
    await flushAsync();
    const span = screen.getByText("PLAY");
    // The compositing policy: the physical glyph is the visual representation,
    // so the DOM ink is suppressed through the managed attribute.
    expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");
    // Nothing else about the DOM changes: node, text, aria, layout.
    expect(span.tagName).toBe("SPAN");
    expect(span.textContent).toBe("PLAY");
    expect(span.getAttribute("aria-label")).toBe("Play button label");
    expect(span.style.width).not.toBe("");
    // Selection still works on the (transparent-ink) text.
    const range = document.createRange();
    range.selectNodeContents(span);
    expect(range.toString()).toBe("PLAY");
    // The physical scene still holds the glyph.
    expect(layer!.registry.get("play")!.options.shape.kind).toBe("mask");

    await act(async () => {
      unmount();
    });
    // The span is gone with the tree; a re-render would show plain text again
    // (the attribute is owned by the layer's registration).
  });

  it("keeps the DOM text fully visible in css mode (physical-only suppression)", async () => {
    stubElementRects();
    stubCanvas2d();
    render(
      <Ukibori backend="css" schedule={(cb) => cb()}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    const span = screen.getByText("PLAY");
    expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(span.getAttribute("data-ukibori-surface")).toBeNull();
    expect(span.textContent).toBe("PLAY");
  });

  it("keeps the DOM text fully visible without a provider", () => {
    stubElementRects();
    render(<UkiboriText text="PLAY" />);
    const span = screen.getByText("PLAY");
    expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
  });

  it("keeps the DOM text visible when rasterization fails (plain DOM fallback)", async () => {
    stubElementRects();
    // Same failure seam as the sizing-policy test: only the 300x150 capability
    // probe canvas works; the element-sized rasterizer canvas fails.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (function (
        this: HTMLCanvasElement,
      ): CanvasRenderingContext2D | null {
        const functional = {
          clearRect: () => undefined,
          fillText: () => undefined,
          getImageData: () => ({ width: 0, height: 0, data: new Uint8ClampedArray(0) }),
          putImageData: () => undefined,
        } as unknown as CanvasRenderingContext2D;
        if (this.width === 300 && this.height === 150) {
          return functional;
        }
        return null;
      }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    const span = screen.getByText("PLAY");
    expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(span.getAttribute("data-ukibori-surface")).toBeNull();
    expect(layer!.registry.has("play")).toBe(false);
  });
});

describe("UkiboriText sizing policy (bare usage)", () => {
  it("satisfies the #19 isotropic mapping with fractional initial dimensions", async () => {
    // No demo CSS: a bare span whose initial box is fractional.
    stubElementRects({ left: 10, top: 20, width: 103.3, height: 24.6 });
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const errors: unknown[] = [];
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)} onError={(e) => errors.push(e)}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    // The scene must build: the span box is fixed to the rasterized pixel
    // dims, so the mask mapping is exactly isotropic (no createScene error).
    expect(errors).toHaveLength(0);
    const span = screen.getByText("PLAY");
    expect(span.style.width).toBe("103px");
    expect(span.style.height).toBe("25px");
    const entry = layer!.registry.get("play")!;
    expect(entry.options.shape.kind).toBe("mask");
    expect(layer!.debugBuffers()).not.toBeNull();
  });

  it("stays plain DOM text when rasterization fails (no rounded-rectangle substitute)", async () => {
    stubElementRects();
    // The capability probe canvas (default 300x150) works, but the rasterizer
    // canvas (element-sized) fails -> no mask can exist.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (function (
        this: HTMLCanvasElement,
      ): CanvasRenderingContext2D | null {
        // The capability probe canvas keeps its default 300x150 size; every
        // element-sized canvas (the rasterizer, the overlay) must be usable
        // too, so only the probe gets a functional context.
        const functional = {
          clearRect: () => undefined,
          fillText: () => undefined,
          getImageData: () => ({ width: 0, height: 0, data: new Uint8ClampedArray(0) }),
          putImageData: () => undefined,
        } as unknown as CanvasRenderingContext2D;
        if (this.width === 300 && this.height === 150) {
          return functional;
        }
        // The rasterizer canvas is element-sized: fail, so no mask exists.
        return null;
      }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    // Plain DOM text: visible, untouched, and NOT registered as a
    // rounded-rectangle substitute.
    const span = screen.getByText("PLAY");
    expect(span.tagName).toBe("SPAN");
    expect(span.textContent).toBe("PLAY");
    expect(span.getAttribute("data-ukibori-surface")).toBeNull();
    expect(span.style.width).toBe("");
    expect(layer!.registry.has("play")).toBe(false);
    expect(layer!.registry.size).toBe(0);
  });
});

describe("UkiboriText layout policy", () => {
  it("uses inline-block so width/height apply in real browser layout", async () => {
    // A bare span (no demo CSS): the default display must make the fixed
    // width/height take effect, otherwise the DOM footprint could diverge
    // from the mask footprint (inline spans ignore width/height).
    stubElementRects({ left: 10, top: 20, width: 120, height: 40 });
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const errors: unknown[] = [];
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)} onError={(e) => errors.push(e)}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    expect(errors).toHaveLength(0);
    const span = screen.getByText("PLAY");
    expect(span.style.display).toBe("inline-block");
    expect(span.style.width).toBe("120px");
    expect(span.style.height).toBe("40px");
    const entry = layer!.registry.get("play")!;
    const mask = (entry.options.shape as { kind: "mask"; mask: { width: number; height: number } }).mask;
    // The mask footprint and the DOM box are the same integer dimensions.
    expect(mask.width).toBe(120);
    expect(mask.height).toBe(40);
  });

  it("user width/height influence the initial measurement but the mask dims stay authoritative", async () => {
    stubElementRects({ left: 10, top: 20, width: 80.4, height: 39.6 });
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const errors: unknown[] = [];
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)} onError={(e) => errors.push(e)}>
        <UkiboriText
          sceneId="play"
          text="PLAY"
          elevation={3}
          thickness={0.8}
          style={{ width: "80.4px", height: "39.6px" }}
        />
      </Ukibori>,
    );
    await flushAsync();
    expect(errors).toHaveLength(0);
    const span = screen.getByText("PLAY");
    // The final DOM box equals the integer mask footprint — the aspects can
    // never diverge, and no scene error occurs.
    expect(span.style.width).toBe("80px");
    expect(span.style.height).toBe("40px");
    expect(span.style.display).toBe("inline-block");
    const entry = layer!.registry.get("play")!;
    const mask = (entry.options.shape as { kind: "mask"; mask: { width: number; height: number } }).mask;
    expect(mask.width).toBe(80);
    expect(mask.height).toBe(40);
    expect(layer!.debugBuffers()).not.toBeNull();
  });
});
