// @vitest-environment node
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Surface, Ukibori } from "../index";

/**
 * SSR contract (#21): the server never touches window / document / canvas /
 * WebGPU / DOM measurement / UkiboriDom. Physical-mode server output is
 * ORDINARY SEMANTIC DOM (no canvas, no box-shadow, no managed attributes).
 * The CSS approximation fallback (backend="css") is the only styling that
 * renders server-side, and it is deterministic.
 */

describe("SSR rendering (node environment, no window/document)", () => {
  it("physical mode renders ordinary semantic DOM without touching the DOM", () => {
    const html = renderToString(
      createElement(
        Ukibori,
        { light: { x: -0.6, y: -0.8, z: 1 } },
        createElement(
          Surface,
          { as: "button", className: "user-class", elevation: 6, thickness: 2 },
          "Hello",
        ),
      ),
    );
    expect(html).toContain("<button");
    expect(html).toContain("user-class");
    expect(html).toContain("Hello");
    // No physical/canvas artifacts, no CSS approximation, no managed attrs.
    expect(html).not.toContain("box-shadow");
    expect(html).not.toContain("<canvas");
    expect(html).not.toContain("data-ukibori");
  });

  it("css fallback mode renders the box-shadow approximation deterministically", () => {
    const element = createElement(
      Ukibori,
      { backend: "css", light: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
      createElement(
        Surface,
        { as: "button", elevation: 6, radius: 20, variant: "inset" },
        "Hello",
      ),
    );
    const a = renderToString(element);
    expect(a).toContain("<button");
    expect(a).toContain("Hello");
    expect(a).toContain("box-shadow");
    expect(a).toContain("var(--ukibori-shadow-x)");
    expect(a).toContain("--ukibori-elevation:6px");
    expect(a).toContain("inset");
    expect(renderToString(element)).toBe(a);
  });

  it("renders provider-less surfaces as plain semantic DOM", () => {
    const html = renderToString(createElement(Surface, { elevation: 4 }, "solo"));
    expect(html).toContain("solo");
    expect(html).not.toContain("box-shadow");
  });

  it("css fallback renders glass with its fixed translucent background", () => {
    const html = renderToString(
      createElement(
        Ukibori,
        { backend: "css" },
        createElement(Surface, { material: "glass", elevation: 6 }, "frosted"),
      ),
    );
    expect(html).toContain("--ukibori-material:glass");
    expect(html).toContain("background-color:rgba(255, 255, 255, 0.32)");
    expect(html).toContain("backdrop-filter:blur(10px) saturate(1.15)");
    expect(html).not.toContain("color-mix");
  });

  it("css fallback normalizes unknown materials during SSR", () => {
    const html = renderToString(
      createElement(
        Ukibori,
        { backend: "css" },
        createElement(Surface, { material: "plastic" as never, elevation: 4 }, "x"),
      ),
    );
    expect(html).toContain("--ukibori-material:silicone");
  });
});
