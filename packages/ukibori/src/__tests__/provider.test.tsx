import { useContext, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UkiboriContext, DEFAULT_COLOR, DEFAULT_INTENSITY, Surface, Ukibori } from "../index";
import type { UkiboriContextValue } from "../context";

const NORMALIZED_DEFAULT = { x: -0.424264, y: -0.565685, z: 0.707107 };

function ContextProbe() {
  const ctx = useContext(UkiboriContext);
  return (
    <pre data-testid="probe">
      {JSON.stringify({ light: ctx.light, intensity: ctx.intensity, color: ctx.color })}
    </pre>
  );
}

function readContext(el: HTMLElement): { light: { x: number; y: number; z: number }; intensity: number; color: string } {
  return JSON.parse(el.textContent ?? "");
}

describe("Ukibori provider", () => {
  it("normalizes the light before exposing it to surfaces", () => {
    render(
      <Ukibori light={{ x: -0.6, y: -0.8, z: 1 }}>
        <ContextProbe />
      </Ukibori>,
    );
    const ctx = readContext(screen.getByTestId("probe"));
    expect(ctx.light).toEqual(NORMALIZED_DEFAULT);
  });

  it("falls back to the normalized default for invalid light", () => {
    render(
      <Ukibori light={{ x: NaN, y: 0, z: 1 } as never}>
        <ContextProbe />
      </Ukibori>,
    );
    expect(readContext(screen.getByTestId("probe")).light).toEqual(NORMALIZED_DEFAULT);
  });

  it("sanitizes invalid and out-of-range intensity", () => {
    const probe = (intensity: number) =>
      render(
        <Ukibori intensity={intensity}>
          <ContextProbe />
        </Ukibori>,
      );
    const a = probe(NaN);
    expect(readContext(a.container.firstElementChild as HTMLElement).intensity).toBe(DEFAULT_INTENSITY);
    const b = probe(-5);
    expect(readContext(b.container.firstElementChild as HTMLElement).intensity).toBe(0);
    const c = probe(99);
    expect(readContext(c.container.firstElementChild as HTMLElement).intensity).toBe(2);
  });

  it("falls back to DEFAULT_COLOR for invalid colors", () => {
    for (const color of ["", "   ", 123, undefined] as never[]) {
      const { container } = render(
        <Ukibori color={color}>
          <ContextProbe />
        </Ukibori>,
      );
      expect(readContext(container.firstElementChild as HTMLElement).color).toBe(DEFAULT_COLOR);
    }
  });

  it("keeps a valid color", () => {
    render(
      <Ukibori color="#112233">
        <ContextProbe />
      </Ukibori>,
    );
    expect(readContext(screen.getByTestId("probe")).color).toBe("#112233");
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
      <Ukibori light={{ x: -0.6, y: -0.8, z: 1 }}>
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
      <Ukibori light={{ x: -0.6, y: -0.8, z: 1 }}>
        <Consumer />
      </Ukibori>,
    );
    rerender(
      <Ukibori light={{ x: 0, y: 0, z: 1 }}>
        <Consumer />
      </Ukibori>,
    );
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1].light).toEqual({ x: 0, y: 0, z: 1 });
  });

  it("applies the sanitized intensity to surface shadows", () => {
    render(
      <Ukibori light={{ x: 1, y: 0, z: 0 }} intensity={NaN}>
        <Surface elevation={4}>Hello</Surface>
      </Ukibori>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.boxShadow).toContain("rgba(0, 0, 0, 0.3)");
  });
});
