import { createRef, useState } from "react";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Toggle from "@radix-ui/react-toggle";
import { PressSurface } from "../../../../demo/src/interaction/PressSurface";
import { Ukibori } from "../index";

afterEach(() => vi.restoreAllMocks());
function pointer(button: HTMLElement, type: string, pointerType = "touch") {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerId: 1, button: 0, isPrimary: true, pointerType }); fireEvent(button, event);
}
describe("native press recipe and headless composition", () => {
  it("forwards Radix props/ref/click, focus and ARIA without an extra DOM button", () => {
    const ref = createRef<HTMLButtonElement>(), onClick = vi.fn();
    function Example() { const [selected, setSelected] = useState(false); return <Ukibori backend="css"><Toggle.Root asChild pressed={selected} onPressedChange={setSelected}><PressSurface ref={ref} selected={selected} reducedMotion onClick={onClick}>Toggle</PressSurface></Toggle.Root></Ukibori>; }
    const { container } = render(<Example />); const button = screen.getByRole("button");
    expect(container.querySelectorAll("button")).toHaveLength(1); expect(ref.current).toBe(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(button); expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute("aria-pressed", "true"); expect(button).toHaveAttribute("data-progress", "0.375");
    button.focus(); expect(document.activeElement).toBe(button); expect(button.style.outline).toBe("");
  });
  it("handles pointer/touch cancel, lost capture, keyboard, blur and disabled", () => {
    const view = render(<PressSurface reducedMotion>Press</PressSurface>); const button = screen.getByRole("button");
    for (const cancel of ["pointerup", "pointercancel", "lostpointercapture"]) {
      pointer(button, "pointerdown"); expect(button).toHaveAttribute("data-progress", "1");
      pointer(button, cancel); expect(button).toHaveAttribute("data-progress", "0");
    }
    for (const key of [" ", "Enter"]) {
      fireEvent.keyDown(button, { key }); expect(button).toHaveAttribute("data-progress", "1");
      fireEvent.keyUp(button, { key }); expect(button).toHaveAttribute("data-progress", "0");
    }
    fireEvent.keyDown(button, { key: " " }); fireEvent.blur(button); expect(button).toHaveAttribute("data-progress", "0");
    pointer(button, "pointerdown"); view.rerender(<PressSurface disabled reducedMotion>Press</PressSurface>);
    expect(button).toBeDisabled(); expect(button).toHaveAttribute("data-progress", "0");
    pointer(button, "pointerdown"); expect(button).toHaveAttribute("data-progress", "0");
  });
  it("honors consumer prevention of press handlers", () => {
    render(<PressSurface reducedMotion onPointerDown={event => event.preventDefault()} onKeyDown={event => event.preventDefault()}>Press</PressSurface>);
    const button = screen.getByRole("button"); pointer(button, "pointerdown"); fireEvent.keyDown(button, { key: " " });
    expect(button).toHaveAttribute("data-progress", "0");
  });
  it("hydrates server output in place and retains native click semantics", () => {
    const onClick = vi.fn();
    const element = <PressSurface selected reducedMotion onClick={onClick} aria-pressed>Hydrate</PressSurface>;
    const host = document.createElement("div"); host.innerHTML = renderToString(element); document.body.append(host);
    const original = host.querySelector("button"), errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot>;
    act(() => { root = hydrateRoot(host, element, { onRecoverableError: error => errors.push(error) }); });
    expect(host.querySelector("button")).toBe(original); expect(errors).toEqual([]);
    fireEvent.click(original!); expect(onClick).toHaveBeenCalledTimes(1);
    act(() => root.unmount()); host.remove();
  });
});

it("cancels window blur and a captured pointer release outside the button", () => {
  const onClick = vi.fn(); render(<PressSurface reducedMotion onClick={onClick}>Press</PressSurface>);
  const button = screen.getByRole("button");
  pointer(button, "pointerdown", "mouse"); fireEvent(window, new Event("blur"));
  expect(button).toHaveAttribute("data-progress", "0");
  pointer(button, "pointerdown", "mouse");
  const up = new Event("pointerup", { bubbles: true }); Object.assign(up, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent(button, up); fireEvent.click(button); expect(onClick).not.toHaveBeenCalled();
  fireEvent.click(button); expect(onClick).toHaveBeenCalledTimes(1);
});
