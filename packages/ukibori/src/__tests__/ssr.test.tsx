// @vitest-environment node
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Surface, Ukibori } from "../index";

const ELEMENT = createElement(
  Ukibori,
  { light: { x: -0.6, y: -0.8, z: 1 } },
  createElement(
    Surface,
    { as: "button", className: "user-class", elevation: 6, radius: 20, variant: "inset" },
    "Hello",
  ),
);

describe("SSR rendering (node environment, no window/document)", () => {
  it("renders to HTML without touching the DOM", () => {
    const html = renderToString(ELEMENT);
    expect(html).toContain("<button");
    expect(html).toContain("user-class");
    expect(html).toContain("Hello");
    expect(html).toContain("box-shadow");
    expect(html).toContain("var(--ukibori-shadow-x)");
    expect(html).toContain("background-color:var(--ukibori-color)");
    expect(html).toContain("--ukibori-color:#e4e8ef");
    expect(html).toContain("var(--ukibori-shadow-color");
    expect(html).toContain("--ukibori-elevation:6px");
    expect(html).toContain("--ukibori-radius:20px");
    expect(html).toContain("inset");
  });

  it("is deterministic across repeated renders", () => {
    const a = renderToString(ELEMENT);
    const b = renderToString(ELEMENT);
    expect(a).toBe(b);
  });

  it("renders provider-less surfaces safely", () => {
    const html = renderToString(createElement(Surface, { elevation: 4 }, "solo"));
    expect(html).toContain("box-shadow");
  });

  it("renders glass with its fixed translucent background", () => {
    const html = renderToString(
      createElement(
        Ukibori,
        null,
        createElement(Surface, { material: "glass", elevation: 6 }, "frosted"),
      ),
    );
    expect(html).toContain("--ukibori-material:glass");
    expect(html).toContain("background-color:rgba(255, 255, 255, 0.32)");
    expect(html).toContain("backdrop-filter:blur(10px) saturate(1.15)");
    expect(html).not.toContain("color-mix");
  });

  it("normalizes unknown materials during SSR", () => {
    const html = renderToString(
      createElement(Surface, { material: "plastic" as never, elevation: 4 }, "x"),
    );
    expect(html).toContain("--ukibori-material:silicone");
  });
});
