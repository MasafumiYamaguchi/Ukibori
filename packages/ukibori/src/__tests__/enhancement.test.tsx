import { act } from "react";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubCanvas2d, stubElementRects } from "../test/dom";
import { Surface, Ukibori } from "../index";
import type { UkiboriDom } from "ukibori-dom";

/**
 * Enhancement lifecycle (#21): SSR output is ordinary semantic DOM; the
 * client hydrates it WITHOUT element replacement; enhancement (capability
 * detection -> integration init -> surface registration) happens after
 * hydration/effects and never replaces the initial elements.
 */

const flushAsync = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enhancement after hydration", () => {
  it("hydrates server HTML and enhances the SAME elements (no replacement)", async () => {
    stubElementRects();
    stubCanvas2d();
    const element = (
      <Ukibori light={{ x: -0.6, y: -0.8, z: 1 }}>
        <Surface as="button" type="button" aria-label="enhanced" elevation={4} thickness={2}>
          Press
        </Surface>
      </Ukibori>
    );
    const serverHtml = renderToString(element);
    expect(serverHtml).toContain("<button");
    expect(serverHtml).not.toContain("data-ukibori-surface");

    const host = document.createElement("div");
    host.innerHTML = serverHtml;
    document.body.appendChild(host);

    let root: ReturnType<typeof import("react-dom/client").hydrateRoot>;
    await act(async () => {
      const { hydrateRoot } = await import("react-dom/client");
      root = hydrateRoot(host, element);
    });

    const buttonBefore = host.querySelector("button");
    expect(buttonBefore).not.toBeNull();

    // Enhancement runs after effects: the button node must stay the same.
    await flushAsync();
    const buttonAfter = host.querySelector("button");
    expect(buttonAfter).toBe(buttonBefore);
    expect(buttonAfter?.getAttribute("data-ukibori-surface")).toBe("");
    expect(buttonAfter?.getAttribute("aria-label")).toBe("enhanced");

    await act(async () => {
      root.unmount();
    });
    document.body.removeChild(host);
  });

  it("registers surfaces into the provider layer after enhancement", async () => {
    stubElementRects();
    stubCanvas2d();
    let layer: UkiboriDom | null = null;
    render(
      <Ukibori
        schedule={(cb) => cb()}
        onReady={(l) => (layer = l)}
      >
        <Surface sceneId="a" elevation={2} thickness={1}>
          A
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(layer).not.toBeNull();
    expect(layer!.registry.has("a")).toBe(true);
    expect(layer!.registry.get("a")!.options.elevation).toBe(2);
  });

  it("keeps the DOM structure plain before enhancement (provider-less surface)", () => {
    // No provider: no enhancement, plain semantic element.
    render(<Surface as="button">Solo</Surface>);
    const button = screen.getByRole("button");
    expect(button.getAttribute("data-ukibori-surface")).toBeNull();
    expect(button.style.boxShadow).toBe("");
  });
});
