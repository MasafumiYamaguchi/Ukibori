import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Surface, Ukibori } from "../index";

const RAISED_EXPECTED =
  "-4px 0px 5.76px 0.4px var(--ukibori-shadow-color, rgba(0, 0, 0, 0.3)), " +
  "1.6px 0px 2.16px 0 var(--ukibori-highlight-color, rgba(255, 255, 255, 0.4))";

const INSET_EXPECTED =
  "inset 4px 0px 4.9px -0.2px var(--ukibori-shadow-color, rgba(0, 0, 0, 0.3)), " +
  "inset -1.6px 0px 1.84px 0 var(--ukibori-highlight-color, rgba(255, 255, 255, 0.4))";

const DEFAULT_LIGHT_PROPS = { x: 1, y: 0, z: 0 } as const;

function renderSurface(node: React.ReactNode) {
  return render(<Ukibori light={DEFAULT_LIGHT_PROPS}>{node}</Ukibori>);
}

describe("Surface rendering", () => {
  it("renders children inside a div by default", () => {
    renderSurface(<Surface>Hello</Surface>);
    expect(screen.getByText("Hello").tagName).toBe("DIV");
  });

  it("renders the polymorphic element type", () => {
    renderSurface(<Surface as="button">Go</Surface>);
    expect(screen.getByRole("button")).toBeInTheDocument();
    renderSurface(<Surface as="a" href="/path">Link</Surface>);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/path");
    renderSurface(<Surface as="span">Span</Surface>);
    expect(screen.getByText("Span").tagName).toBe("SPAN");
  });

  it("forwards element-specific props and events", () => {
    const onClick = vi.fn();
    renderSurface(
      <Surface as="button" type="submit" onClick={onClick} aria-label="go" data-testid="btn">
        Go
      </Surface>,
    );
    const button = screen.getByTestId("btn");
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveAttribute("aria-label", "go");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("forwards a ref to the rendered element", () => {
    const ref = createRef<HTMLButtonElement>();
    renderSurface(
      <Surface as="button" ref={ref}>
        Go
      </Surface>,
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.textContent).toBe("Go");
  });

  it("keeps user className and merges it", () => {
    renderSurface(<Surface className="user-class">Hello</Surface>);
    expect(screen.getByText("Hello")).toHaveClass("user-class");
  });
});

describe("Surface style composition", () => {
  it("applies internal style and lets user style win on conflicts", () => {
    renderSurface(
      <Surface style={{ color: "red", "--ukibori-radius": "99px" } as React.CSSProperties}>Hello</Surface>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.color).toBe("red");
    expect(el.style.getPropertyValue("--ukibori-radius")).toBe("99px");
    expect(el.style.borderRadius).toBe("12px");
    expect(el.style.getPropertyValue("--ukibori-elevation")).toBe("4px");
  });

  it("lets a user boxShadow fully replace the internal shadow", () => {
    renderSurface(<Surface style={{ boxShadow: "none" }}>Hello</Surface>);
    expect(screen.getByText("Hello").style.boxShadow).toBe("none");
  });

  it("allows intentional override of shadow colors via CSS variables", () => {
    renderSurface(
      <Surface
        style={{ "--ukibori-shadow-color": "rgba(255, 0, 0, 0.9)" } as React.CSSProperties}
      >
        Hello
      </Surface>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-shadow-color")).toBe("rgba(255, 0, 0, 0.9)");
    expect(el.style.boxShadow).toContain("var(--ukibori-shadow-color, rgba(0, 0, 0, 0.3))");
  });
});

describe("Surface shadow output", () => {
  it("emits the expected raised box-shadow for known inputs", () => {
    renderSurface(<Surface elevation={4} variant="raised">Hello</Surface>);
    expect(screen.getByText("Hello").style.boxShadow).toBe(RAISED_EXPECTED);
  });

  it("emits an inset box-shadow for the inset variant", () => {
    renderSurface(<Surface elevation={4} variant="inset">Hello</Surface>);
    expect(screen.getByText("Hello").style.boxShadow).toBe(INSET_EXPECTED);
  });

  it("reflects elevation and radius props in CSS variables and borderRadius", () => {
    renderSurface(<Surface elevation={6} radius={20}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-elevation")).toBe("6px");
    expect(el.style.getPropertyValue("--ukibori-radius")).toBe("20px");
    expect(el.style.borderRadius).toBe("20px");
  });

  it("treats an unknown variant as raised", () => {
    renderSurface(<Surface variant={"embossed" as never}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.boxShadow).toBe(RAISED_EXPECTED);
    expect(el.style.boxShadow).not.toContain("inset");
  });

  it("sanitizes invalid elevation to the default", () => {
    renderSurface(<Surface elevation={NaN}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-elevation")).toBe("4px");
    expect(Number.isFinite(Number.parseFloat(el.style.boxShadow))).toBe(true);
  });
});

describe("Surface outside a provider", () => {
  it("renders with safe defaults and deterministic shadows", () => {
    render(<Surface elevation={4}>Hello</Surface>);
    const el = screen.getByText("Hello");
    const expected =
      "1.7px 2.26px 3.72px 0.4px var(--ukibori-shadow-color, rgba(0, 0, 0, 0.3)), " +
      "-0.68px -0.91px 1.4px 0 var(--ukibori-highlight-color, rgba(255, 255, 255, 0.4))";
    expect(el.style.boxShadow).toBe(expected);
    expect(el.style.getPropertyValue("--ukibori-elevation")).toBe("4px");
  });
});
