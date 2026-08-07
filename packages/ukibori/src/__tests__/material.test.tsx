import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Surface, Ukibori } from "../index";

const LIGHT = { x: 1, y: 0, z: 0 } as const;

function renderSurface(node: React.ReactNode) {
  return render(<Ukibori light={LIGHT}>{node}</Ukibori>);
}

describe("Surface material presets", () => {
  it("applies matte tokens: softer shadow, flat highlight, wider blur", () => {
    renderSurface(<Surface material="matte" elevation={4}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-material")).toBe("matte");
    expect(el.style.getPropertyValue("--ukibori-shadow-alpha")).toBe("0.24");
    expect(el.style.getPropertyValue("--ukibori-highlight-alpha")).toBe("0.14");
    expect(el.style.getPropertyValue("--ukibori-shadow-blur")).toBe("7.78px");
    expect(el.style.getPropertyValue("--ukibori-shadow-spread")).toBe("0.2px");
    expect(el.style.getPropertyValue("--ukibori-highlight-blur")).toBe("2.92px");
    expect(el.style.backgroundColor).toBe("var(--ukibori-color)");
    expect(el.style.getPropertyValue("backdrop-filter")).toBe("");
  });

  it("applies glass tokens: fixed translucent bg, border, backdrop blur", () => {
    renderSurface(<Surface material="glass" elevation={4}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-material")).toBe("glass");
    expect(el.style.backgroundColor).toBe("rgba(255, 255, 255, 0.32)");
    expect(el.style.backdropFilter).toBe("blur(10px) saturate(1.15)");
    expect(el.style.borderWidth).toBe("1px");
    expect(el.style.borderStyle).toBe("solid");
    expect(el.style.borderColor).toBe("rgba(255, 255, 255, 0.4)");
    expect(el.style.backgroundImage).toContain("linear-gradient");
    expect(el.style.getPropertyValue("--ukibori-shadow-alpha")).toBe("0.21");
    expect(el.style.getPropertyValue("--ukibori-highlight-alpha")).toBe("0.54");
  });

  it("applies metal tokens: gloss gradient, border, stronger highlights", () => {
    renderSurface(<Surface material="metal" elevation={4}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-material")).toBe("metal");
    expect(el.style.backgroundImage).toContain("linear-gradient(145deg");
    expect(el.style.borderColor).toBe("rgba(255, 255, 255, 0.22)");
    expect(el.style.getPropertyValue("--ukibori-highlight-alpha")).toBe("0.68");
    expect(el.style.getPropertyValue("--ukibori-shadow-alpha")).toBe("0.345");
    expect(el.style.getPropertyValue("--ukibori-shadow-blur")).toBe("4.61px");
    expect(el.style.getPropertyValue("--ukibori-shadow-spread")).toBe("0.5px");
    expect(el.style.getPropertyValue("backdrop-filter")).toBe("");
    expect(el.style.backgroundColor).toBe("var(--ukibori-color)");
  });

  it("normalizes an unknown material to silicone in variables and rendering", () => {
    renderSurface(<Surface material={"plastic" as never} elevation={4}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-material")).toBe("silicone");
    expect(el.style.getPropertyValue("--ukibori-shadow-alpha")).toBe("0.3");
    expect(el.style.getPropertyValue("--ukibori-highlight-alpha")).toBe("0.4");
    expect(el.style.getPropertyValue("backdrop-filter")).toBe("");
    expect(el.style.borderWidth).toBe("");
  });
});

describe("Surface material overrides", () => {
  it("applies partial token overrides on top of the preset", () => {
    renderSurface(
      <Surface material="silicone" materialOverrides={{ shadowAlpha: 0.5 }} elevation={4}>
        Hello
      </Surface>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-shadow-alpha")).toBe("0.15");
    expect(el.style.getPropertyValue("--ukibori-shadow-blur")).toBe("5.76px");
    expect(el.style.getPropertyValue("--ukibori-highlight-alpha")).toBe("0.4");
  });

  it("allows combining several overridden tokens", () => {
    renderSurface(
      <Surface material="glass" materialOverrides={{ surfaceColor: "rgba(255, 255, 255, 0.5)", backdropFilter: null }}>
        Hello
      </Surface>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.backgroundColor).toBe("rgba(255, 255, 255, 0.5)");
    expect(el.style.getPropertyValue("backdrop-filter")).toBe("");
    expect(el.style.borderWidth).toBe("1px");
  });

  it("sanitizes runtime junk in materialOverrides without emitting invalid CSS", () => {
    renderSurface(
      <Surface
        material="silicone"
        materialOverrides={{ shadowAlpha: NaN, borderWidth: -5, backgroundImage: 42 } as never}
        elevation={4}
      >
        Hello
      </Surface>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-shadow-alpha")).toBe("0.3");
    expect(el.style.borderWidth).toBe("");
    expect(el.style.backgroundImage).toBe("");
  });

  it("keeps the user style winning over material rendering", () => {
    renderSurface(
      <Surface
        material="metal"
        style={{ boxShadow: "none", backgroundColor: "red", border: "0", backgroundImage: "none" }}
      >
        Hello
      </Surface>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.boxShadow).toBe("none");
    expect(el.style.backgroundColor).toBe("red");
    expect(el.style.borderWidth).toBe("0px");
    expect(el.style.backgroundImage).toBe("none");
  });
});

describe("Surface material accessibility", () => {
  it("keeps button semantics and focusability with metal decorations", () => {
    renderSurface(
      <Surface as="button" material="metal" aria-label="action">
        Go
      </Surface>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-label", "action");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button.style.outlineStyle).toBe("");
  });

  it("keeps glass readable: fixed translucent background and no focus interference", () => {
    renderSurface(
      <Surface as="button" material="glass">
        Go
      </Surface>,
    );
    const button = screen.getByRole("button");
    expect(button.style.backgroundColor).toBe("rgba(255, 255, 255, 0.32)");
    expect(button.style.outlineStyle).toBe("");
    button.focus();
    expect(button).toBe(document.activeElement);
  });
});
