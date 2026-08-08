import { createElement } from "react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Surface, Ukibori } from "../index";

// Server (React 19) serializes custom properties without a space after the
// colon while the client CSSOM adds spaces; normalize for value comparison.
const normalizeMarkup = (html: string) =>
  html.replace(/;\s*/g, ";").replace(/:\s*/g, ":").replace(/;">/g, '">');

describe("hydration determinism", () => {
  it("produces identical markup server-side and client-side (css fallback)", () => {
    const element = createElement(
      Ukibori,
      { backend: "css", light: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
      createElement(Surface, { as: "button", elevation: 6, radius: 20, variant: "raised" }, "Hello"),
    );
    const serverHtml = renderToString(element);
    const { container } = render(element);
    expect(normalizeMarkup(container.innerHTML)).toBe(normalizeMarkup(serverHtml));
  });

  it("produces identical plain button markup server-side and client-side (physical path)", () => {
    const element = createElement(
      Ukibori,
      { light: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
      createElement(Surface, { as: "button", elevation: 6, thickness: 2 }, "Hello"),
    );
    const serverHtml = renderToString(element);
    // The physical path renders ordinary semantic DOM; the client-side
    // enhancement effect adds the overlay AFTER this comparison, so compare
    // the semantic element markup itself.
    const serverProbe = document.createElement("div");
    serverProbe.innerHTML = serverHtml;
    const serverButton = serverProbe.querySelector("button")!.outerHTML;

    const { container } = render(element);
    const clientButton = container.querySelector("button")!.outerHTML;
    // The client markup equals the server markup plus the single managed
    // enhancement attribute — the element structure is unchanged (hydration
    // never replaces elements).
    const clientStripped = clientButton.replace(' data-ukibori-surface=""', "");
    expect(normalizeMarkup(clientStripped)).toBe(normalizeMarkup(serverButton));
    // No physical artifacts in the button markup itself.
    expect(clientButton).not.toContain("box-shadow");
  });

  it("hydrates server HTML without mismatch and keeps handlers working (css fallback)", () => {
    const onClick = vi.fn();
    const element = createElement(
      Ukibori,
      { backend: "css" },
      createElement(Surface, { as: "button", onClick }, "Hello"),
    );
    const serverHtml = renderToString(element);

    const host = document.createElement("div");
    host.innerHTML = serverHtml;
    document.body.appendChild(host);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let root: ReturnType<typeof hydrateRoot>;
    act(() => {
      root = hydrateRoot(host, element);
    });
    expect(errorSpy).not.toHaveBeenCalled();
    expect(host.innerHTML).toBe(serverHtml);
    errorSpy.mockRestore();

    act(() => {
      screen.getByText("Hello").click();
    });
    expect(onClick).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
    document.body.removeChild(host);
  });
});
