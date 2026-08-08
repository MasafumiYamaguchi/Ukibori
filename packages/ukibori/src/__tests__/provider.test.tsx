import { useContext, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { stubCanvas2d } from "../test/dom";
import { UkiboriContext, DEFAULT_COLOR, DEFAULT_INTENSITY, Surface, Ukibori } from "../index";
import type { UkiboriContextValue } from "../context";

const NORMALIZED_DEFAULT = { x: -0.424264, y: -0.565685, z: 0.707107 };

function ContextProbe() {
  const ctx = useContext(UkiboriContext);
  return (
    <pre data-testid="probe">
      {JSON.stringify({
        mode: ctx.mode,
        backend: ctx.backend,
        layer: ctx.layer === null ? "null" : "layer",
        light: ctx.light,
        intensity: ctx.intensity,
        color: ctx.color,
      })}
    </pre>
  );
}

function readContext(el: HTMLElement): {
  mode: string;
  backend: string;
  layer: string;
  light: { x: number; y: number; z: number };
  intensity: number;
  color: string;
} {
  return JSON.parse(el.textContent ?? "");
}

describe("Ukibori provider", () => {
  it("enhances to a single physical layer after effects", async () => {
    stubCanvas2d();
    let layerRef: unknown = "unset";
    render(
      <Ukibori onReady={(layer) => (layerRef = layer)}>
        <ContextProbe />
      </Ukibori>,
    );
    const el = screen.getByTestId("probe");
    // The SSR/initial state is mode "none" (covered by the SSR tests); the
    // enhancement effect promotes to "physical" with one shared layer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readContext(el).mode).toBe("physical");
    expect(layerRef).not.toBeNull();
  });

  it("css backend never creates a layer and exposes the css mode", async () => {
    let layerRef: unknown = "unset";
    render(
      <Ukibori backend="css" onReady={(layer) => (layerRef = layer)}>
        <ContextProbe />
      </Ukibori>,
    );
    const el = screen.getByTestId("probe");
    expect(readContext(el).mode).toBe("css");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readContext(el).mode).toBe("css");
    expect(layerRef).toBeNull();
  });

  it("normalizes the light before exposing it to surfaces", () => {
    render(
      <Ukibori backend="css" light={{ x: -0.6, y: -0.8, z: 1 }}>
        <ContextProbe />
      </Ukibori>,
    );
    expect(readContext(screen.getByTestId("probe")).light).toEqual(NORMALIZED_DEFAULT);
  });

  it("falls back to the normalized default for invalid light", () => {
    render(
      <Ukibori backend="css" light={{ x: NaN, y: 0, z: 1 } as never}>
        <ContextProbe />
      </Ukibori>,
    );
    expect(readContext(screen.getByTestId("probe")).light).toEqual(NORMALIZED_DEFAULT);
  });

  it("sanitizes invalid and out-of-range intensity", () => {
    const probe = (intensity: number) =>
      render(
        <Ukibori backend="css" intensity={intensity}>
          <ContextProbe />
        </Ukibori>,
      );
    const a = probe(NaN);
    expect(readContext(a.container.querySelector('[data-testid="probe"]') as HTMLElement).intensity).toBe(DEFAULT_INTENSITY);
    a.unmount();
    const b = probe(-5);
    expect(readContext(b.container.querySelector('[data-testid="probe"]') as HTMLElement).intensity).toBe(0);
    b.unmount();
    const c = probe(99);
    expect(readContext(c.container.querySelector('[data-testid="probe"]') as HTMLElement).intensity).toBe(2);
    c.unmount();
  });

  it("falls back to DEFAULT_COLOR for invalid colors", () => {
    for (const color of ["", "   ", 123, undefined] as never[]) {
      const { container, unmount } = render(
        <Ukibori backend="css" color={color}>
          <ContextProbe />
        </Ukibori>,
      );
      expect(readContext(container.querySelector('[data-testid="probe"]') as HTMLElement).color).toBe(DEFAULT_COLOR);
      unmount();
    }
  });

  it("keeps the context value referentially stable across re-renders", () => {
    const seen: unknown[] = [];
    function Consumer() {
      const ctx = useContext(UkiboriContext);
      seen.push(ctx);
      const [, setTick] = useState(0);
      return <button onClick={() => setTick((t) => t + 1)}>tick</button>;
    }
    render(
      <Ukibori backend="css" light={{ x: -0.6, y: -0.8, z: 1 }}>
        <Consumer />
      </Ukibori>,
    );
    fireEvent.click(screen.getByText("tick"));
    fireEvent.click(screen.getByText("tick"));
    expect(seen).toHaveLength(3);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
  });

  it("creates a new context value when light props change", () => {
    const seen: UkiboriContextValue[] = [];
    function Consumer() {
      seen.push(useContext(UkiboriContext));
      return null;
    }
    const { rerender } = render(
      <Ukibori backend="css" light={{ x: -0.6, y: -0.8, z: 1 }}>
        <Consumer />
      </Ukibori>,
    );
    rerender(
      <Ukibori backend="css" light={{ x: 0, y: 0, z: 1 }}>
        <Consumer />
      </Ukibori>,
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1].light).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("applies the sanitized intensity to css fallback shadows", () => {
    render(
      <Ukibori backend="css" light={{ x: 1, y: 0, z: 0 }} intensity={NaN}>
        <Surface elevation={4}>Hello</Surface>
      </Ukibori>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-shadow-alpha")).toBe("0.3");
    expect(el.style.getPropertyValue("--ukibori-highlight-alpha")).toBe("0.4");
  });

  it("updates the css fallback background when the provider color changes", () => {
    const { rerender } = render(
      <Ukibori backend="css" color="#112233">
        <Surface>Hello</Surface>
      </Ukibori>,
    );
    expect(screen.getByText("Hello").style.getPropertyValue("--ukibori-color")).toBe("#112233");
    rerender(
      <Ukibori backend="css" color="#334455">
        <Surface>Hello</Surface>
      </Ukibori>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-color")).toBe("#334455");
    expect(el.style.backgroundColor).toBe("var(--ukibori-color)");
  });
});
