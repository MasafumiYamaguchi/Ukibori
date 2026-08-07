import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Surface, Ukibori } from "../index";

describe("surface smoke test", () => {
  it("renders children inside a div by default", () => {
    render(
      <Ukibori>
        <Surface>Hello</Surface>
      </Ukibori>,
    );
    expect(screen.getByText("Hello").tagName).toBe("DIV");
  });

  it("keeps a user className", () => {
    render(<Surface className="user-class">Hello</Surface>);
    expect(screen.getByText("Hello")).toHaveClass("user-class");
  });
});
