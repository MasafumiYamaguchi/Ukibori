import { act } from "react";
import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { stubCanvas2d, stubElementRects } from "../test/dom";
import { Surface, Ukibori } from "../index";
import type { UkiboriDom } from "ukibori-dom";
import type { HeightProfile } from "ukibori-renderer";

afterEach(() => vi.restoreAllMocks());

it("updates power exponent, orientation and inset mode on the retained Surface entry", async () => {
  stubCanvas2d(); stubElementRects();
  let layer: UkiboriDom | null = null;
  const view = (profile: HeightProfile) => <Ukibori schedule={(cb) => cb()} onReady={(value) => { layer = value; }}>
    <Surface sceneId="profile" profile={profile} elevation={10} thickness={8}>Profile</Surface>
  </Ukibori>;
  const { rerender, unmount } = render(view({ kind: "power", exponent: 2 }));
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await flush();
  const entry = layer!.registry.get("profile")!;
  for (const profile of [
    { kind: "power", exponent: 3 },
    { kind: "power", exponent: 3, bias: "out" },
    { kind: "power", exponent: 3, bias: "out", mode: "inset" },
  ] as HeightProfile[]) {
    rerender(view(profile)); await flush();
    expect(layer!.registry.get("profile")).toBe(entry);
    expect(entry.options.profile).toEqual(profile);
  }
  unmount();
});
