import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Surface, Ukibori } from "../index";

describe("surface smoke test", () => {
  it("renders children inside a div by default (provider-less: plain semantic DOM)", () => {
    render(<Surface>Hello</Surface>);
    expect(screen.getByText("Hello").tagName).toBe("DIV");
    // No enhancement, no CSS approximation without a provider.
    expect(screen.getByText("Hello").style.boxShadow).toBe("");
  });

  it("keeps a user className", () => {
    render(<Surface className="user-class">Hello</Surface>);
    expect(screen.getByText("Hello")).toHaveClass("user-class");
  });

  it("enhances under a physical provider", () => {
    const onReady = () => undefined;
    render(
      <Ukibori onReady={onReady}>
        <Surface>Hello</Surface>
      </Ukibori>,
    );
    expect(screen.getByText("Hello").tagName).toBe("DIV");
  });
});
