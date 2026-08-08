import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stubElementRects } from "../test/dom";
import { Surface, Ukibori } from "../index";

/**
 * Renderer failure must leave usable/readable semantic DOM (#21): a failing
 * registration or scene never removes the element, never breaks events /
 * ARIA / text, and never removes focus-visible behavior.
 */

const flushAsync = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderer failure resilience", () => {
  it("a duplicate scene id fails atomically and leaves the second surface plain and usable", async () => {
    stubElementRects();
    const errors: unknown[] = [];
    render(
      <Ukibori
        schedule={(cb) => cb()}
        onError={(e) => errors.push(e)}
      >
        <Surface sceneId="dup" elevation={4} thickness={2}>
          First
        </Surface>
        <Surface sceneId="dup" elevation={4} thickness={2}>
          Second
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const buttons = screen.getAllByText(/First|Second/);
    expect(buttons).toHaveLength(2);
    // The duplicate registration failed atomically: no suppression left.
    expect(buttons[1].getAttribute("data-ukibori-surface")).toBeNull();
    expect(errors.length).toBeGreaterThan(0);
    // Both elements remain readable, semantic DOM.
    expect(buttons[0].textContent).toBe("First");
    expect(buttons[1].textContent).toBe("Second");
  });

  it("a scene build failure (unknown material ref) keeps the DOM readable and interactive", async () => {
    stubElementRects();
    const errors: unknown[] = [];
    const onClick = vi.fn();
    render(
      <Ukibori schedule={(cb) => cb()} onError={(e) => errors.push(e)}>
        <Surface as="button" sceneId="b" material="does-not-exist" onClick={onClick} elevation={4} thickness={2}>
          Still a button
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(errors.length).toBeGreaterThan(0);
    const button = screen.getByRole("button");
    expect(button.textContent).toBe("Still a button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    // Focus-visible behavior is never touched by the failure path.
    expect(button.style.outline).toBe("");
  });

  it("a disabled physical provider renders plain semantic DOM (high-contrast policy)", async () => {
    // highContrast=true disables enhancement: no layer, no suppression, the
    // app's own styles own the element.
    let layer: unknown = "unset";
    render(
      <Ukibori highContrast={true} onReady={(l) => (layer = l)}>
        <Surface as="button" id="hc" elevation={4} thickness={2}>
          High contrast
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    expect(layer).toBeNull();
    const button = screen.getByRole("button");
    expect(button.getAttribute("data-ukibori-surface")).toBeNull();
    expect(button.style.boxShadow).toBe("");
  });
});
