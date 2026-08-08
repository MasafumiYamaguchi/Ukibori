import { act, createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Surface, Ukibori } from "../index";

/**
 * Real DOM semantics survive enhancement (#21): the registered element IS
 * the caller's element — events, focus, ARIA, form behavior, children and
 * refs stay untouched.
 */

const flushAsync = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

describe("semantic DOM under the physical layer", () => {
  it("a real button stays a real button with events, focus and ARIA", async () => {
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Ukibori schedule={(cb) => cb()}>
        <Surface
          as="button"
          id="primary"
          type="submit"
          aria-label="Primary action"
          onClick={onClick}
          ref={ref}
          elevation={4}
          thickness={2}
        >
          Press me
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const button = screen.getByRole("button");
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveAttribute("aria-label", "Primary action");
    expect(ref.current).toBe(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    // Focus behavior is DOM-owned: the element is focusable.
    act(() => {
      button.focus();
    });
    expect(document.activeElement).toBe(button);
  });

  it("keeps children and text DOM-owned", async () => {
    render(
      <Ukibori schedule={(cb) => cb()}>
        <Surface as="button" id="b" elevation={4} thickness={2}>
          <strong>Bold</strong> label
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const button = screen.getByRole("button");
    expect(button.querySelector("strong")?.textContent).toBe("Bold");
    expect(button.textContent).toBe("Bold label");
  });

  it("an input keeps form behavior", async () => {
    const onChange = vi.fn();
    render(
      <Ukibori schedule={(cb) => cb()}>
        <Surface
          as="input"
          id="field"
          type="text"
          aria-label="Name"
          placeholder="Name"
          defaultValue="ada"
          onChange={onChange}
          elevation={2}
          thickness={1}
        />
      </Ukibori>,
    );
    await flushAsync();
    const input = screen.getByLabelText("Name") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveAttribute("placeholder", "Name");
    fireEvent.change(input, { target: { value: "grace" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("does not remove focus-visible behavior (no outline manipulation)", async () => {
    render(
      <Ukibori schedule={(cb) => cb()}>
        <Surface as="button" id="f" elevation={4} thickness={2}>
          Focus me
        </Surface>
      </Ukibori>,
    );
    await flushAsync();
    const button = screen.getByRole("button");
    // The layer never touches outline / focus styles.
    expect(button.style.outline).toBe("");
    expect(button.style.outlineStyle).toBe("");
  });
});
