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
        <UkiboriText id="play" text="PLAY" elevation={6} thickness={0.8} bevelWidth={1.1} material="metal" />
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
        <UkiboriText id="g" text="PLAY" elevation={6} thickness={0.8} />
      </Ukibori>,
    );
    await flushAsync();
    const maskBefore = (layer!.registry.get("g")!.options.shape as { kind: "mask"; mask: unknown }).mask;

    rerender(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <UkiboriText id="g" text="STOP" elevation={6} thickness={0.8} />
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
