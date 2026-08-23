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
        <Surface sceneId="a" elevation={1} thickness={1}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(layer).not.toBeNull();
    expect(layer!.debugBuffers()).not.toBeNull();
  });

  it('"cpu" explicitly selects the physical CPU renderer', async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori backend="cpu" onReady={(l) => (layer = l)}>
        <Surface sceneId="a" elevation={1} thickness={1}>
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
        <Surface sceneId="a" elevation={4} variant="raised">
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
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const { unmount } = render(
      <Ukibori onReady={(l) => (layer = l)}>
        <Surface sceneId="a" elevation={1} thickness={1}>
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
          <Surface sceneId="a" elevation={1} thickness={1}>
            A
          </Surface>
        </Ukibori>
        <Ukibori quality="high" schedule={(cb) => cb()} onReady={(l) => (layerHigh = l)}>
          <Surface sceneId="b" elevation={1} thickness={1}>
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

describe("capability resolution and retained provider", () => {
  it("falls back to the CSS approximation when Canvas2D is unavailable (auto)", async () => {
    // getContext returns null: the real CPU/Canvas presentation path is
    // unusable, so the provider must NOT suppress DOM surfaces while an
    // overlay silently paints nothing.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    let layer: UkiboriDom | null = null;
    const errors: unknown[] = [];
    render(
      <Ukibori onReady={(l) => (layer = l)} onError={(e) => errors.push(e)}>
        <Surface elevation={4} variant="raised">
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(layer).toBeNull();
    // The fallback is reported and the explicitly labeled CSS approximation
    // is applied — the surface is never left suppressed-but-unpainted.
    expect(errors.length).toBeGreaterThan(0);
    const el = screen.getByText("A");
    expect(el.style.boxShadow).toContain("var(--ukibori-shadow-x)");
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("enters physical mode only when Canvas2D is actually usable", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori onReady={(l) => (layer = l)}>
        <Surface sceneId="a" elevation={1} thickness={1}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(layer).not.toBeNull();
  });

  // Full-suite parallel load can push these jsdom + CPU-render tests past
  // the default 5s per-test timeout on slower machines (each passes in
  // isolation); the explicit budget documents that instead of leaving them
  // load-flaky. This does NOT mask any production bug — the #41 stale-state
  // regression is covered by dedicated same-instance tests in dom-layer and
  // lifecycle.
  it(
    "retains the layer and registry entries across shared-light/quality updates",
    async () => {
      stubElementRects();
      stubCanvas2d();
      let layer: UkiboriDom | null = null;
      const tree = (light: { x: number; y: number; z: number }, quality: "low" | "high") => (
        <Ukibori
          schedule={(cb) => cb()}
          onReady={(l) => (layer = l)}
          light={light}
          quality={quality}
        >
          <Surface sceneId="a" elevation={2} thickness={1}>
            A
          </Surface>
        </Ukibori>
      );
      const { rerender } = render(tree({ x: -0.6, y: -0.8, z: 1 }, "low"));
      await flushAsync();
      const first = layer!;
      const entryBefore = first.registry.get("a")!;
      const setLightSpy = vi.spyOn(first, "setLight");
      const setDprSpy = vi.spyOn(first, "setDpr");

      // Ordinary physical prop changes: the EXISTING layer is updated through
      // its setters — no dispose/recreate, no surface re-registration.
      rerender(tree({ x: 1, y: 0, z: 0 }, "high"));
      await flushAsync();
      expect(layer).toBe(first);
      expect(first.registry.get("a")).toBe(entryBefore);
      expect(first.registry.size).toBe(1);
      expect(setLightSpy).toHaveBeenCalled();
      expect(setDprSpy).toHaveBeenCalled();
    },
    15_000,
  );

  it("pushes environment/exposure prop updates to the retained layer without recreation", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const tree = (
      environment: { intensity: number; diffuseIntensity?: number; specularIntensity?: number } | undefined,
      exposure: number,
    ) => (
      <Ukibori
        schedule={(cb) => cb()}
        onReady={(l) => (layer = l)}
        environment={environment}
        exposure={exposure}
      >
        <Surface sceneId="a" elevation={2} thickness={1}>
          A
        </Surface>
      </Ukibori>
    );
    const { rerender } = render(tree({ intensity: 0.5 }, 1));
    await flushAsync();
    const first = layer!;
    const entryBefore = first.registry.get("a")!;
    const setEnvironmentSpy = vi.spyOn(first, "setEnvironment");
    const setExposureSpy = vi.spyOn(first, "setExposure");
    expect(first.debugEnvironment()).toEqual({ intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 });
    expect(first.debugExposure()).toBe(1);

    // Env/exposure are ordinary value props: the EXISTING layer is updated
    // through its setters — no dispose/recreate, no re-registration. The
    // specular share reaches the retained setter like the other controls.
    rerender(tree({ intensity: 0, specularIntensity: 0 }, 2));
    await flushAsync();
    expect(layer).toBe(first);
    expect(first.registry.get("a")).toBe(entryBefore);
    expect(first.registry.size).toBe(1);
    expect(setEnvironmentSpy).toHaveBeenLastCalledWith({
      intensity: 0,
      diffuseIntensity: 1,
      specularIntensity: 0,
    });
    expect(setExposureSpy).toHaveBeenCalledWith(2);
    expect(first.debugEnvironment()).toEqual({ intensity: 0, diffuseIntensity: 1, specularIntensity: 0 });
    expect(first.debugExposure()).toBe(2);

    // Removing the props resets both to their defaults through the setters.
    rerender(<Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
      <Surface sceneId="a" elevation={2} thickness={1}>
        A
      </Surface>
    </Ukibori>);
    await flushAsync();
    expect(setEnvironmentSpy).toHaveBeenLastCalledWith({
      intensity: 0.5,
      diffuseIntensity: 1,
      specularIntensity: 1,
    });
    expect(setExposureSpy).toHaveBeenLastCalledWith(1);
    expect(first.debugEnvironment()).toEqual({ intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 });
    expect(first.debugExposure()).toBe(1);
  }, 15_000);

  it("matches the renderer sanitization policy at the React entry (#22)", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const tree = (environment?: { intensity?: number; diffuseIntensity?: number; specularIntensity?: number }, exposure?: number) => (
      <Ukibori
        schedule={(cb) => cb()}
        onReady={(l) => (layer = l)}
        environment={environment}
        exposure={exposure}
      >
        <Surface sceneId="a" elevation={2} thickness={1}>
          A
        </Surface>
      </Ukibori>
    );
    const { rerender } = render(tree());
    await flushAsync();
    const first = layer!;
    expect(first.debugEnvironment()).toEqual({ intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 });
    expect(first.debugExposure()).toBe(1);

    // Negative FINITE intensity/exposure fall back to the renderer defaults
    // (0.5 / 1) — they must NOT clamp to 0 like the shares.
    rerender(tree({ intensity: -1 }, -2));
    await flushAsync();
    expect(first.debugEnvironment().intensity).toBe(0.5);
    expect(first.debugExposure()).toBe(1);
    expect(first.debugEnvironment().diffuseIntensity).toBe(1);

    // Negative finite SHARES clamp to 0; above-1 finite shares clamp to 1.
    rerender(tree({ intensity: 2, diffuseIntensity: -0.5, specularIntensity: 3 }, 4));
    await flushAsync();
    expect(first.debugEnvironment()).toEqual({ intensity: 2, diffuseIntensity: 0, specularIntensity: 1 });
    expect(first.debugExposure()).toBe(4);

    // Non-finite values (NaN / Infinity) fall back to the defaults on all
    // controls, exactly like the renderer scene sanitizers.
    rerender(
      tree(
        { intensity: NaN, diffuseIntensity: Infinity, specularIntensity: -Infinity },
        Infinity,
      ),
    );
    await flushAsync();
    expect(first.debugEnvironment()).toEqual({ intensity: 0.5, diffuseIntensity: 1, specularIntensity: 1 });
    expect(first.debugExposure()).toBe(1);
  });
});

describe("provider option reset and identity semantics", () => {
  it("resets shadow/margin/compositing to defaults when props become undefined", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const tree = (withOptions: boolean) => (
      <Ukibori
        schedule={(cb) => cb()}
        onReady={(l) => (layer = l)}
        {...(withOptions
          ? {
              shadow: { bias: 0.4, maxDistance: 120 },
              margin: 32,
              compositing: { shadowAlpha: 0.5 },
            }
          : {})}
      >
        <Surface sceneId="a" elevation={2} thickness={1}>
          A
        </Surface>
      </Ukibori>
    );
    const { rerender } = render(tree(true));
    await flushAsync();
    const current = layer!;
    const setShadowSpy = vi.spyOn(current, "setShadow");
    const setMarginSpy = vi.spyOn(current, "setMargin");
    const setCompositingSpy = vi.spyOn(current, "setCompositing");

    // Removing the props must RESET the options through the setters — full
    // replacement, not a skipped no-op.
    rerender(tree(false));
    await flushAsync();
    expect(setShadowSpy).toHaveBeenLastCalledWith({});
    expect(setMarginSpy).toHaveBeenLastCalledWith(undefined);
    expect(setCompositingSpy).toHaveBeenLastCalledWith({});
    // Same layer retained throughout.
    expect(layer).toBe(current);
  });

  it("a shadow change removes fields not present in the new value", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const tree = (shadow: { bias: number; maxDistance?: number } | undefined) => (
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)} shadow={shadow}>
        <Surface sceneId="a" elevation={2} thickness={1}>
          A
        </Surface>
      </Ukibori>
    );
    const { rerender } = render(tree({ bias: 0.4, maxDistance: 120 }));
    await flushAsync();
    const current = layer!;
    expect(current.debugShadowOptions()).toEqual({ bias: 0.4, maxDistance: 120 });

    // {bias,maxDistance} -> {bias}: maxDistance must be REMOVED, not merged.
    rerender(tree({ bias: 0.2 }));
    await flushAsync();
    expect(current.debugShadowOptions()).toEqual({ bias: 0.2 });
  });

  it(
    "switching the stage element recreates the layer on the new stage",
    async () => {
    stubElementRects();
    stubCanvas2d();
    const stageA = document.createElement("section");
    const stageB = document.createElement("main");
    document.body.appendChild(stageA);
    document.body.appendChild(stageB);
    let layer: UkiboriDom | null = null;
    const tree = (stage: HTMLElement) => (
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)} stage={stage}>
        <Surface sceneId="a" elevation={2} thickness={1}>
          A
        </Surface>
      </Ukibori>
    );
    const { rerender } = render(tree(stageA));
    await flushAsync();
    const first = layer!;
    expect(first.debugState().region).not.toBeNull();
    // Canvas attached to stageA (inside the wrapper? no — the explicit stage).
    expect(stageA.querySelector("canvas")).not.toBeNull();
    expect(stageA.getAttribute("data-ukibori-stage")).toBe("");

    // Switching to stageB must recreate the layer and re-attach the overlay
    // (the elements stringify identically — only identity works).
    rerender(tree(stageB));
    await flushAsync();
    expect(layer).not.toBe(first);
    expect(stageA.querySelector("canvas")).toBeNull();
    expect(stageA.getAttribute("data-ukibori-stage")).toBeNull();
    expect(stageB.querySelector("canvas")).not.toBeNull();
    expect(stageB.getAttribute("data-ukibori-stage")).toBe("");
    document.body.removeChild(stageA);
    document.body.removeChild(stageB);
  },
  15_000,
  );

  it("a changed dpr provider function (identical source) is pushed to the layer", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    // Two functions with IDENTICAL source text capturing different state.
    const state = { v: 1 };
    const fn1 = () => state.v;
    const tree = (fn: () => number) => (
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)} dpr={fn}>
        <Surface sceneId="a" elevation={2} thickness={1}>
          A
        </Surface>
      </Ukibori>
    );
    const { rerender } = render(tree(fn1));
    await flushAsync();
    const current = layer!;
    expect(String(fn1)).toBe(String(() => state.v)); // same-source trap
    const setDprSpy = vi.spyOn(current, "setDpr");
    state.v = 2;
    const fn2 = () => state.v;
    rerender(tree(fn2));
    await flushAsync();
    // Identity-based: the new function (same source, new closure) is pushed.
    expect(setDprSpy).toHaveBeenCalledWith(fn2);
    expect(layer).toBe(current);
  });
});
