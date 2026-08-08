import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Surface, Ukibori } from "../index";

/**
 * These tests exercise the CSS APPROXIMATION fallback path
 * (`backend="css"`, explicitly labeled — not physical rendering) plus the
 * plain semantic DOM behavior of the physical path.
 */

const RAISED_SHADOW =
  "var(--ukibori-shadow-x) var(--ukibori-shadow-y) var(--ukibori-shadow-blur) var(--ukibori-shadow-spread) var(--ukibori-shadow-color, rgba(0, 0, 0, var(--ukibori-shadow-alpha))), " +
  "var(--ukibori-highlight-x) var(--ukibori-highlight-y) var(--ukibori-highlight-blur) 0 var(--ukibori-highlight-color, rgba(255, 255, 255, var(--ukibori-highlight-alpha)))";

const INSET_SHADOW =
  "inset var(--ukibori-shadow-x) var(--ukibori-shadow-y) var(--ukibori-shadow-blur) var(--ukibori-shadow-spread) var(--ukibori-shadow-color, rgba(0, 0, 0, var(--ukibori-shadow-alpha))), " +
  "inset var(--ukibori-highlight-x) var(--ukibori-highlight-y) var(--ukibori-highlight-blur) 0 var(--ukibori-highlight-color, rgba(255, 255, 255, var(--ukibori-highlight-alpha)))";

const DEFAULT_LIGHT_PROPS = { x: 1, y: 0, z: 0 } as const;

function renderCssSurface(node: React.ReactNode) {
  return render(<Ukibori backend="css" light={DEFAULT_LIGHT_PROPS}>{node}</Ukibori>);
}

describe("Surface rendering (css fallback mode)", () => {
  it("renders children inside a div by default", () => {
    renderCssSurface(<Surface>Hello</Surface>);
    expect(screen.getByText("Hello").tagName).toBe("DIV");
  });

  it("renders the polymorphic element type", () => {
    renderCssSurface(<Surface as="button">Go</Surface>);
    expect(screen.getByRole("button")).toBeInTheDocument();
    renderCssSurface(<Surface as="a" href="/path">Link</Surface>);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/path");
    renderCssSurface(<Surface as="span">Span</Surface>);
    expect(screen.getByText("Span").tagName).toBe("SPAN");
  });

  it("forwards element-specific props and events", () => {
    const onClick = vi.fn();
    renderCssSurface(
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
    renderCssSurface(
      <Surface as="button" ref={ref}>
        Go
      </Surface>,
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.textContent).toBe("Go");
  });

  it("keeps user className and merges it", () => {
    renderCssSurface(<Surface className="user-class">Hello</Surface>);
    expect(screen.getByText("Hello")).toHaveClass("user-class");
  });
});

describe("Surface style composition (css fallback)", () => {
  it("applies internal style and lets user style win on conflicts", () => {
    renderCssSurface(
      <Surface style={{ color: "red", "--ukibori-radius": "99px" } as React.CSSProperties}>Hello</Surface>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.color).toBe("red");
    expect(el.style.getPropertyValue("--ukibori-radius")).toBe("99px");
    expect(el.style.borderRadius).toBe("var(--ukibori-radius)");
    expect(el.style.getPropertyValue("--ukibori-elevation")).toBe("4px");
  });

  it("lets a user boxShadow fully replace the internal shadow", () => {
    renderCssSurface(<Surface style={{ boxShadow: "none" }}>Hello</Surface>);
    expect(screen.getByText("Hello").style.boxShadow).toBe("none");
  });

  it("keeps the var() structure while a user override changes the referenced value", () => {
    renderCssSurface(
      <Surface elevation={4} style={{ "--ukibori-shadow-blur": "10px" } as React.CSSProperties}>Hello</Surface>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-shadow-blur")).toBe("10px");
    expect(el.style.boxShadow).toBe(RAISED_SHADOW);
  });

  it("allows intentional override of shadow colors via CSS variables", () => {
    renderCssSurface(
      <Surface
        style={{ "--ukibori-shadow-color": "rgba(255, 0, 0, 0.9)" } as React.CSSProperties}
      >
        Hello
      </Surface>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-shadow-color")).toBe("rgba(255, 0, 0, 0.9)");
    expect(el.style.boxShadow).toContain(
      "var(--ukibori-shadow-color, rgba(0, 0, 0, var(--ukibori-shadow-alpha)))",
    );
  });
});

describe("Surface shadow output (css fallback)", () => {
  it("emits a var()-based box-shadow referencing computed variables", () => {
    renderCssSurface(<Surface elevation={4} variant="raised">Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.boxShadow).toBe(RAISED_SHADOW);
    expect(el.style.getPropertyValue("--ukibori-shadow-x")).toBe("-4px");
    expect(el.style.getPropertyValue("--ukibori-shadow-y")).toBe("0px");
    expect(el.style.getPropertyValue("--ukibori-shadow-blur")).toBe("5.76px");
    expect(el.style.getPropertyValue("--ukibori-shadow-spread")).toBe("0.4px");
    expect(el.style.getPropertyValue("--ukibori-shadow-alpha")).toBe("0.3");
    expect(el.style.getPropertyValue("--ukibori-highlight-x")).toBe("1.6px");
    expect(el.style.getPropertyValue("--ukibori-highlight-y")).toBe("0px");
    expect(el.style.getPropertyValue("--ukibori-highlight-blur")).toBe("2.16px");
    expect(el.style.getPropertyValue("--ukibori-highlight-alpha")).toBe("0.4");
  });

  it("emits an inset box-shadow with inset keyword and mirrored variables", () => {
    renderCssSurface(<Surface elevation={4} variant="inset">Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.boxShadow).toBe(INSET_SHADOW);
    expect(el.style.getPropertyValue("--ukibori-variant")).toBe("inset");
    expect(el.style.getPropertyValue("--ukibori-shadow-x")).toBe("4px");
    expect(el.style.getPropertyValue("--ukibori-shadow-spread")).toBe("-0.2px");
    expect(el.style.getPropertyValue("--ukibori-highlight-x")).toBe("-1.6px");
  });

  it("reflects elevation and radius props in CSS variables and var() references", () => {
    renderCssSurface(<Surface elevation={6} radius={20}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-elevation")).toBe("6px");
    expect(el.style.getPropertyValue("--ukibori-radius")).toBe("20px");
    expect(el.style.borderRadius).toBe("var(--ukibori-radius)");
  });

  it("connects the context color to backgroundColor via --ukibori-color", () => {
    render(
      <Ukibori backend="css" color="#112233">
        <Surface>Hello</Surface>
      </Ukibori>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-color")).toBe("#112233");
    expect(el.style.backgroundColor).toBe("var(--ukibori-color)");
  });

  it("normalizes an unknown variant to raised everywhere", () => {
    renderCssSurface(<Surface variant={"embossed" as never}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-variant")).toBe("raised");
    expect(el.style.boxShadow).toBe(RAISED_SHADOW);
    expect(el.style.boxShadow).not.toContain("inset");
  });

  it("sanitizes invalid elevation to the default", () => {
    renderCssSurface(<Surface elevation={NaN}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.getPropertyValue("--ukibori-elevation")).toBe("4px");
    expect(el.style.boxShadow).toBe(RAISED_SHADOW);
  });
});

describe("Surface under a physical provider (no enhancement styling)", () => {
  it("keeps the element's own style untouched before/without the physical layer", () => {
    // A physical provider enhances after effects; the RENDERED output stays
    // the plain semantic element with the user's own style.
    render(
      <Ukibori>
        <Surface style={{ color: "red" }} elevation={4}>Hello</Surface>
      </Ukibori>,
    );
    const el = screen.getByText("Hello");
    expect(el.style.color).toBe("red");
    // No CSS approximation styling leaks into the physical path.
    expect(el.style.boxShadow).toBe("");
    expect(el.style.getPropertyValue("--ukibori-elevation")).toBe("");
  });
});

describe("Surface outside a provider", () => {
  it("renders plain semantic DOM with no approximation styling", () => {
    render(<Surface elevation={4}>Hello</Surface>);
    const el = screen.getByText("Hello");
    expect(el.style.boxShadow).toBe("");
    expect(el.style.getPropertyValue("--ukibori-color")).toBe("");
  });
});
