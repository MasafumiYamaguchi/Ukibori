import { act } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCanvas2d, stubElementRects } from "../test/dom";
import { Surface, Ukibori } from "../index";
import type { UkiboriDom } from "ukibori-dom";

/**
 * Registry lifecycle (#21): mount registers, prop updates go through the
 * RETAINED updateSurface path (insertion/paint order stable), unmount
 * unregisters. One provider owns one shared layer for many surfaces.
 */

const flushAsync = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registry lifecycle", () => {
  it("mount registers, prop update uses the retained path, unmount unregisters", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const { rerender } = render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Surface sceneId="card" elevation={4} thickness={2}>
          Card
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const current = layer!;
    expect(current.registry.has("card")).toBe(true);
    expect(current.registry.get("card")!.options.elevation).toBe(4);

    // Prop update -> updateSurface keeps the SAME entry (no re-register).
    const entryBefore = current.registry.get("card");
    rerender(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Surface sceneId="card" elevation={9} thickness={3}>
          Card
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(current.registry.get("card")).toBe(entryBefore);
    expect(current.registry.get("card")!.options.elevation).toBe(9);
    expect(current.registry.get("card")!.options.thickness).toBe(3);

    // Unmount the surface -> the retained node is removed.
    rerender(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <span>gone</span>
      </Ukibori>,
    );
    await flushAsync();
    expect(current.registry.has("card")).toBe(false);
    expect(screen.queryByText("Card")).toBeNull();
  });

  it("keeps scene insertion order stable across updates (ids never re-key)", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const tree = (
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Surface sceneId="first" elevation={1} thickness={1}>
          First
        </Surface>
        <Surface sceneId="second" elevation={2} thickness={1}>
          Second
        </Surface>
      </Ukibori>
    );
    const { rerender } = render(tree);
    await flushAsync();
    const current = layer!;
    const orderBefore = current.registry.entries().map((e) => e.id);
    expect(orderBefore).toEqual(["first", "second"]);

    rerender(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Surface sceneId="first" elevation={9} thickness={2}>
          First
        </Surface>
        <Surface sceneId="second" elevation={2} thickness={1}>
          Second
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(current.registry.entries().map((e) => e.id)).toEqual(orderBefore);
    expect(current.registry.get("first")!.options.elevation).toBe(9);
  });

  it("one shared provider renderer serves multiple surfaces", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Surface sceneId="a" elevation={1} thickness={1}>
          A
        </Surface>
        <Surface sceneId="b" elevation={3} thickness={2}>
          B
        </Surface>
        <Surface sceneId="c" elevation={2} thickness={1}>
          C
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const current = layer!;
    expect(current.registry.size).toBe(3);
    expect(current.registry.has("a")).toBe(true);
    expect(current.registry.has("b")).toBe(true);
    expect(current.registry.has("c")).toBe(true);
    // The scene renders through the shared layer (intermediate buffers exist).
    expect(current.debugBuffers()).not.toBeNull();
  });

  it("unmounts the provider cleanly: stage attribute and overlay released", async () => {
    stubElementRects();
    stubCanvas2d();
    const { unmount } = render(
      <Ukibori schedule={(cb) => cb()}>
        <Surface sceneId="x" elevation={1} thickness={1}>
          X
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const container = document.body.firstElementChild!;
    const wrapper = container.firstElementChild!;
    expect(wrapper.getAttribute("data-ukibori-stage")).toBe("");
    expect(wrapper.firstElementChild?.tagName).toBe("CANVAS");

    unmount();
    await flushAsync();
    expect(wrapper.getAttribute("data-ukibori-stage")).toBeNull();
    expect(wrapper.querySelector("canvas")).toBeNull();
  });
});

describe("#41 angularRadius retained-update semantics", () => {
  // Heavy jsdom + CPU-render fixture: keep it cheap (low quality) and give
  // it headroom under full-suite parallel load.
  it(
    "removing the prop clears the stored radius on the SAME layer",
    async () => {
      stubElementRects();
      stubCanvas2d();
      let layer: UkiboriDom | null = null;
      const { rerender } = render(
        <Ukibori
          schedule={(cb) => cb()}
          onReady={(l) => (layer = l)}
          angularRadius={0.5}
          quality="low"
        >
          <Surface sceneId="card" elevation={4} thickness={2}>
            Card
          </Surface>
        </Ukibori>,
      );
      await flushAsync();
      const current = layer!;
      // soft override stored
      expect(
        (current as unknown as { light: { angularRadius?: number } }).light.angularRadius,
      ).toBe(0.5);

      // Prop removal -> the retained update effect calls
      // setLight(dir, intensity, undefined) -> DELETE -> renderer default 0.
      rerender(
        <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
          <Surface sceneId="card" elevation={4} thickness={2}>
            Card
          </Surface>
        </Ukibori>,
      );
      await flushAsync();
      expect(
        (current as unknown as { light: { angularRadius?: number } }).light.angularRadius,
      ).toBeUndefined();
    },
    20_000,
  );
});
