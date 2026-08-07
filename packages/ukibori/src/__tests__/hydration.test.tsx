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
  it("produces identical markup server-side and client-side", () => {
    const element = createElement(
      Ukibori,
      { light: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
      createElement(Surface, { as: "button", elevation: 6, radius: 20, variant: "raised" }, "Hello"),
    );
    const serverHtml = renderToString(element);
    const { container } = render(element);
    expect(normalizeMarkup(container.innerHTML)).toBe(normalizeMarkup(serverHtml));
  });

  it("hydrates server HTML without mismatch and keeps handlers working", () => {
    const onClick = vi.fn();
    const element = createElement(
      Ukibori,
      null,
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
