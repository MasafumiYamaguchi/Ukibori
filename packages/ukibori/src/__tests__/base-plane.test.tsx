import { act } from "react";
import { render } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { UkiboriDom } from "ukibori-dom";
import { Surface, Ukibori } from "../index";
import { stubCanvas2d, stubElementRects } from "../test/dom";

afterEach(() => vi.restoreAllMocks());
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

it("updates and removes floor color while preserving the layer and DOM semantics", async () => {
  stubElementRects(); stubCanvas2d();
  let layer: UkiboriDom | null = null;
  const tree = (color?: string) => <Ukibori backend="cpu" basePlaneColor={color} dpr={1}
    schedule={cb => cb()} onReady={value => { layer = value; }}>
    <Surface sceneId="receiver" as="button" material="matte" elevation={1}>Select me</Surface>
  </Ukibori>;
  const { rerender, getByRole } = render(tree("#abc")); await flush();
  const first = layer!;
  const entry = first.registry.get("receiver"), button = getByRole("button");
  const setter = vi.spyOn(first, "setBasePlaneColor");
  rerender(tree("#def")); await flush();
  expect(layer).toBe(first); expect(first.registry.get("receiver")).toBe(entry);
  expect(getByRole("button")).toBe(button); expect(setter).toHaveBeenLastCalledWith("#def");
  rerender(tree()); await flush(); expect(setter).toHaveBeenLastCalledWith(undefined);
});

it("keeps the same semantic SSR markup with a floor color supplied", () => {
  const tree = (color?: string) => <Ukibori basePlaneColor={color}><button>DOM action</button></Ukibori>;
  expect(renderToString(tree("#abc"))).toBe(renderToString(tree()));
});


it("hydrates a physical-floor page without replacing the semantic button", async () => {
  stubElementRects(); stubCanvas2d();
  const clicked = vi.fn(), errors: unknown[] = [];
  const element = <Ukibori backend="cpu" basePlaneColor="#abc" dpr={1}><button onClick={clicked}>Hydrated DOM</button></Ukibori>;
  const host = document.createElement("div"); host.innerHTML = renderToString(element); document.body.appendChild(host);
  const button = host.querySelector("button")!;
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => { root = hydrateRoot(host, element, { onRecoverableError: error => errors.push(error) }); });
  await flush();
  expect(errors).toEqual([]); expect(host.querySelector("button")).toBe(button);
  act(() => button.click()); expect(clicked).toHaveBeenCalledOnce();
  act(() => root.unmount()); host.remove();
});
