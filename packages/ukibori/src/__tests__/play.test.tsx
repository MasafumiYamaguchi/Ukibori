import { act } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCanvas2d, stubElementRects, stubTextLineBox } from "../test/dom";
import { Surface, Ukibori, UkiboriText } from "../index";
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
    stubTextLineBox();
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

  it("keeps a generic roundedRect surface's DOM text DOM-owned", async () => {
    stubElementRects();
    stubCanvas2d();
    render(
      <Ukibori schedule={(cb) => cb()}>
        <Surface sceneId="btn" as="button" type="button" elevation={4} thickness={2}>
          Delete
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const button = screen.getByText("Delete");
    expect(button.getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(button.getAttribute("data-ukibori-surface")).toBe("");
  });

  it("keeps a generic mask surface's DOM text DOM-owned (shape alone never delegates)", async () => {
    stubElementRects({ left: 10, top: 20, width: 40, height: 40 });
    stubCanvas2d();
    const errors: unknown[] = [];
    render(
      <Ukibori schedule={(cb) => cb()} onError={(e) => errors.push(e)}>
        <Surface
          sceneId="icon"
          shape={{ kind: "mask", mask: { width: 2, height: 2, alpha: new Float32Array([1, 1, 1, 1]) } }}
          style={{ width: "40px", height: "40px" }}
          elevation={2}
          thickness={1}
        >
          Delete
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    // A valid scene (isotropic mask box), the mask surface registered, but
    // the DOM text ink must remain DOM-owned: no delegation attribute.
    expect(errors).toHaveLength(0);
    const label = screen.getByText("Delete");
    expect(label.getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(label.getAttribute("data-ukibori-surface")).toBe("");
  });

  it("keeps nested child text of a generic mask surface visible", async () => {
    stubElementRects({ left: 10, top: 20, width: 40, height: 40 });
    stubCanvas2d();
    const errors: unknown[] = [];
    render(
      <Ukibori schedule={(cb) => cb()} onError={(e) => errors.push(e)}>
        <Surface
          sceneId="icon"
          shape={{ kind: "mask", mask: { width: 2, height: 2, alpha: new Float32Array([1, 1, 1, 1]) } }}
          style={{ width: "40px", height: "40px" }}
          elevation={2}
          thickness={1}
        >
          <span>Delete</span>
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(errors).toHaveLength(0);
    const surface = screen.getByText("Delete").closest("[data-ukibori-surface]");
    expect(surface).not.toBeNull();
    // Neither the surface nor its child carries the ink delegation.
    expect(surface!.getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(screen.getByText("Delete").getAttribute("data-ukibori-physical-ink")).toBeNull();
  });

  it("removes the ink suppression on the physical -> CSS transition (no refcount leak)", async () => {
    stubElementRects();
    stubCanvas2d();
    stubTextLineBox();
    const { rerender } = render(
      <Ukibori backend="auto" schedule={(cb) => cb()}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    const span = screen.getByText("PLAY");
    expect(span.getAttribute("data-ukibori-physical-ink")).toBe("");

    // Repeated delegated retained updates (text/mask object changes).
    for (const text of ["STOP", "PLAY", "WAIT"]) {
      rerender(
        <Ukibori backend="auto" schedule={(cb) => cb()}>
          <UkiboriText sceneId="play" text={text} elevation={3} thickness={0.8} />
        </Ukibori>,
      );
      await flushAsync();
      expect(screen.getByText(text).getAttribute("data-ukibori-physical-ink")).toBe("");
    }

    // physical -> css: the layer lifecycle disposes and every registration
    // is released  Ethe ink must come back exactly once (a leaked refcount
    // would leave the attribute behind).
    rerender(
      <Ukibori backend="css" schedule={(cb) => cb()}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    const spanAfter = screen.getByText("PLAY");
    expect(spanAfter.getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(spanAfter.getAttribute("data-ukibori-surface")).toBeNull();
    expect(spanAfter.textContent).toBe("PLAY");
  });

  /**
   * Deterministic rasterization-failure seam by TEXT: the element-sized
   * rasterizer works for every text except the listed ones, where
   * getImageData throws (a full rasterization failure). Text-based rules
   * stay deterministic even across the async document.fonts.ready
   * re-rasterization. The 300x150 capability probe canvas always works.
   */
  function stubRasterFailures(failTexts: string[]): void {
    stubElementRects();
    let lastText = "";
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (function (
        this: HTMLCanvasElement,
      ): CanvasRenderingContext2D | null {
        const functional = {
          font: "",
          textAlign: "left",
          textBaseline: "alphabetic",
          fillStyle: "#000",
          clearRect: () => undefined,
          fillText: (text: string) => {
            lastText = text;
          },
          measureText: (text: string) => ({
            text,
            width: text.length * 10,
            fontBoundingBoxAscent: 32,
            fontBoundingBoxDescent: 8,
            actualBoundingBoxAscent: 20,
            actualBoundingBoxDescent: 4,
          }),
          getImageData: () => {
            if (failTexts.includes(lastText)) {
              throw new Error("injected raster failure");
            }
            return {
              width: this.width,
              height: this.height,
              data: new Uint8ClampedArray(this.width * this.height * 4),
            };
          },
          putImageData: () => undefined,
        } as unknown as CanvasRenderingContext2D;
        if (this.width === 300 && this.height === 150) {
          return functional;
        }
        return functional;
      }) as unknown as typeof HTMLCanvasElement.prototype.getContext,
    );
  }

  it("drops a stale raster when the current text fails to rasterize (no stale visual glyph)", async () => {
    // PLAY rasterizes fine; every later rasterization fails.
    const failTexts: string[] = ["STOP"];
    stubRasterFailures(failTexts);
    stubTextLineBox();
    let layer: UkiboriDom | null = null;
    const { rerender } = render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText sceneId="play" text="PLAY" aria-label="label" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    expect(screen.getByText("PLAY").getAttribute("data-ukibori-physical-ink")).toBe("");
    expect(layer!.registry.get("play")!.options.shape.kind).toBe("mask");

    // Text changes to STOP and the re-rasterization FAILS: the previous
    // PLAY raster must not stay active  Eno stale physical glyph, the DOM
    // STOP text is the visible fallback, and the delegation is released.
    rerender(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText sceneId="play" text="STOP" aria-label="label" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    const span = screen.getByText("STOP");
    expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(span.textContent).toBe("STOP");
    expect(span.getAttribute("aria-label")).toBe("label");
    const range = document.createRange();
    range.selectNodeContents(span);
    expect(range.toString()).toBe("STOP");
    // The physical glyph is gone with the stale raster (plain DOM fallback).
    expect(layer!.registry.has("play")).toBe(false);
    expect(layer!.registry.size).toBe(0);
    expect(span.style.width).toBe("");
  });

  it("re-acquires the delegation exactly once across success -> failure -> success", async () => {
    // outcomes: PLAY ok, STOP fails, PLAY ok again.
    const failTexts: string[] = ["STOP"];
    stubRasterFailures(failTexts);
    stubTextLineBox();
    const { rerender } = render(
      <Ukibori schedule={(cb) => cb()}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    expect(screen.getByText("PLAY").getAttribute("data-ukibori-physical-ink")).toBe("");

    rerender(
      <Ukibori schedule={(cb) => cb()}>
        <UkiboriText sceneId="play" text="STOP" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    // Failure for the current value: plain DOM fallback, delegation off.
    expect(screen.getByText("STOP").getAttribute("data-ukibori-physical-ink")).toBeNull();

    rerender(
      <Ukibori schedule={(cb) => cb()}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    // Recovery: the delegation is re-acquired...
    expect(screen.getByText("PLAY").getAttribute("data-ukibori-physical-ink")).toBe("");

    // ...and still releasable exactly once (physical -> css structural
    // switch disposes the layer and reveals the ink completely).
    rerender(
      <Ukibori backend="css" schedule={(cb) => cb()}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    const spanAfter = screen.getByText("PLAY");
    expect(spanAfter.getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(spanAfter.textContent).toBe("PLAY");
  });

  it("applies the same fallback when the font prop changes and later fails", async () => {
    // An explicit font prop never matches the (empty) computed font in jsdom:
    // the fidelity gate keeps the ink delegated-off while the raster exists.
    const failTexts: string[] = [];
    stubRasterFailures(failTexts);
    let layer: UkiboriDom | null = null;
    const { rerender } = render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText sceneId="play" text="PLAY" font="700 48px Arial" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    const span = screen.getByText("PLAY");
    // Geometry registered, visual authority stays DOM-side (typography gate).
    expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(span.textContent).toBe("PLAY");
    expect(layer!.registry.get("play")!.options.shape.kind).toBe("mask");

    // font prop change with a failing rasterization: plain DOM fallback.
    failTexts.push("PLAY");
    rerender(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText sceneId="play" text="PLAY" font="700 96px Arial" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    expect(screen.getByText("PLAY").getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(layer!.registry.has("play")).toBe(false);
  });

  it("keeps DOM text visible when live layout metrics are unavailable (fidelity fallback)", async () => {
    // stubCanvas2d WITHOUT the line-box seam: the Range measurement yields
    // no line box, so the raster falls back to the legacy centered placement
    // and MUST NOT take the DOM ink over.
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText sceneId="play" text="PLAY" elevation={3} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    const span = screen.getByText("PLAY");
    // The mask may exist as physical geometry...
    expect(layer!.registry.get("play")!.options.shape.kind).toBe("mask");
    // ...but it is never the visual source of truth: the DOM ink stays.
    expect(span.getAttribute("data-ukibori-physical-ink")).toBeNull();
    expect(span.textContent).toBe("PLAY");
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
    // The final DOM box equals the integer mask footprint  Ethe aspects can
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


