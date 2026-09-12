import { act } from "react";
import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UkiboriDom } from "ukibori-dom";
import { Surface, Ukibori } from "../index";
import type { Material } from "../index";
import { stubCanvas2d, stubElementRects } from "../test/dom";
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
afterEach(() => vi.restoreAllMocks());

it("forwards emissive material updates and removal while retaining the layer and registration", async () => {
  stubElementRects(); stubCanvas2d();
  let layer: UkiboriDom | null = null;
  const materials: Record<string, Material> = { silicone: {
    baseColor: { r: 0, g: 0, b: 0 }, roughness: 1, metallic: 0, emissive: { r: 2, g: 0, b: 0 },
  } };
  const tree = (table?: Record<string, Material>) => <Ukibori backend="cpu" materials={table}
    schedule={cb => cb()} onReady={value => { layer = value; }}>
    <Surface sceneId="led" material="silicone" elevation={1}>LED</Surface>
  </Ukibori>;
  const { rerender } = render(tree(materials)); await flush();
  const first = layer!;
  const entry = first.registry.get("led");
  const setter = vi.spyOn(first, "setMaterials");
  materials.silicone.emissive!.r = 0;
  materials.silicone.emissive!.g = 3;
  rerender(tree(materials)); await flush();
  expect(layer).toBe(first);
  expect(first.registry.get("led")).toBe(entry);
  expect(setter).toHaveBeenLastCalledWith(expect.objectContaining({ silicone: expect.objectContaining({ emissive: { r: 0, g: 3, b: 0 } }) }));
  rerender(tree()); await flush();
  expect(setter).toHaveBeenLastCalledWith({});
  expect(layer).toBe(first);
});
