import { act } from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCanvas2d, stubElementRects } from "../test/dom";
import { Surface, Ukibori } from "../index";
import type { UkiboriDom } from "ukibori-dom";

/**
 * Surface identity/ownership (#21 review): the DOM `id` prop is preserved
 * and forwarded; the RENDERER identity is a separate stable `sceneId`
 * (default: an unconditional useId — hooks are never conditional); a failed
 * register() owns nothing, so its cleanup can never release another
 * surface's registration.
 */

const flushAsync = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("surface identity and ownership", () => {
  it("forwards the ordinary DOM id and uses sceneId for the renderer identity", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Surface id="dom-id" sceneId="scene-a" elevation={2} thickness={1}>
          Hello
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const el = screen.getByText("Hello");
    expect(el.getAttribute("id")).toBe("dom-id");
    expect(layer!.registry.has("scene-a")).toBe(true);
    expect(layer!.registry.has("dom-id")).toBe(false);
  });

  it("keeps the default sceneId stable across prop updates (unconditional useId)", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    const { rerender } = render(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Surface elevation={2} thickness={1}>
          Card
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const current = layer!;
    const entryBefore = current.registry.entries()[0];
    const sceneIdBefore = entryBefore.id;

    rerender(
      <Ukibori schedule={(cb) => cb()} onReady={(l) => (layer = l)}>
        <Surface elevation={9} thickness={3}>
          Card
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    // Same entry, same renderer identity, same insertion position.
    expect(current.registry.entries()[0]).toBe(entryBefore);
    expect(entryBefore.id).toBe(sceneIdBefore);
    expect(entryBefore.options.elevation).toBe(9);
  });

  it("unmounting a failed duplicate does not remove the successful surface", async () => {
    stubElementRects();
    stubCanvas2d();
    const errors: unknown[] = [];
    let layer: UkiboriDom | null = null;
    const tree = (onlyFirst: boolean) => (
      <Ukibori
        schedule={(cb) => cb()}
        onReady={(l) => (layer = l)}
        onError={(e) => errors.push(e)}
      >
        <Surface sceneId="dup" elevation={2} thickness={1}>
          First
        </Surface>
        {!onlyFirst && (
          <Surface sceneId="dup" elevation={4} thickness={2}>
            Second
          </Surface>
        )}
      </Ukibori>
    );
    const { rerender } = render(tree(false));
    await flushAsync();
    const current = layer!;
    // Only the FIRST registration succeeded; the duplicate failed.
    expect(current.registry.has("dup")).toBe(true);
    expect(errors.length).toBeGreaterThan(0);

    // Unmount the FAILED duplicate: its cleanup must not release the
    // successful surface's registration.
    rerender(tree(true));
    await flushAsync();
    expect(current.registry.has("dup")).toBe(true);
    expect(current.registry.get("dup")!.options.elevation).toBe(2);
  });
});
