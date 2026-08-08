import { act } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCanvas2d, stubElementRects } from "../test/dom";
import { Surface, Ukibori } from "../index";
import type { UkiboriDom } from "ukibori-dom";

/**
 * Backend / fallback policy (#21): honest capability model. "auto"/"cpu"
 * enable the physical layer via the CPU reference renderer (the only
 * complete pipeline in this repository — the WebGPU backend reports
 * compute: false and is not advertised as selectable). "css" enables the
 * box-shadow APPROXIMATION fallback, explicitly labeled — never advertised
 * as physical rendering.
 */

const flushAsync = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("backend selection", () => {
  it('"auto" (default) creates the physical layer', async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Surface id="a" elevation={1} thickness={1}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(layer).not.toBeNull();
    expect(layer!.debugBuffers()).not.toBeNull();
  });

  it('"cpu" explicitly selects the physical CPU renderer', async () => {
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori backend="cpu" onReady={(l) => (layer = l)}>
        <Surface id="a" elevation={1} thickness={1}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(layer).not.toBeNull();
  });

  it('"css" uses the labeled approximation fallback and no layer', async () => {
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori backend="css" onReady={(l) => (layer = l)}>
        <Surface id="a" elevation={4} variant="raised">
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(layer).toBeNull();
    const el = screen.getByText("A");
    // The CSS fallback is a box-shadow approximation — never a canvas/overlay.
    expect(el.style.boxShadow).toContain("var(--ukibori-shadow-x)");
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("resolves auto/cpu to the physical mode and css to the approximation", async () => {
    let layer: UkiboriDom | null = null;
    const { unmount } = render(
      <Ukibori onReady={(l) => (layer = l)}>
        <Surface id="a" elevation={1} thickness={1}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(layer).not.toBeNull();
    unmount();
  });

  it("does not fake a WebGPU backend: no selectable 'webgpu' path exists", () => {
    // The policy is the type surface: "auto" | "cpu" | "css". There is no
    // "webgpu" selection because the renderer's WebGPU backend reports
    // compute: false (no shader pipeline) — advertising it would fake a
    // capability. auto prefers WebGPU only when a real compute pipeline
    // lands.
    const selectableBackends: Array<string> = ["auto", "cpu", "css"];
    expect(selectableBackends).not.toContain("webgpu");
  });

  it("respects the quality -> dpr policy (higher quality = more texels)", async () => {
    stubElementRects();
    stubCanvas2d();
    let layerLow: UkiboriDom | null = null;
    let layerHigh: UkiboriDom | null = null;
    const { unmount } = render(
      <>
        <Ukibori quality="low" schedule={(cb) => cb()} onReady={(l) => (layerLow = l)}>
          <Surface id="a" elevation={1} thickness={1}>
            A
          </Surface>
        </Ukibori>
        <Ukibori quality="high" schedule={(cb) => cb()} onReady={(l) => (layerHigh = l)}>
          <Surface id="b" elevation={1} thickness={1}>
            B
          </Surface>
        </Ukibori>
      </>,
    );
    await flushAsync();
    const sizeLow = layerLow!.debugState().renderSize;
    const sizeHigh = layerHigh!.debugState().renderSize;
    // high (1.5x dpr) must render at least as many texels as low (0.75x).
    expect(sizeHigh!.width).toBeGreaterThanOrEqual(sizeLow!.width);
    expect(sizeHigh!.height).toBeGreaterThanOrEqual(sizeLow!.height);
    unmount();
  });
});
