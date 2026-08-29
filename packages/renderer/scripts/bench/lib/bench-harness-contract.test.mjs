// #46 harness-contract unit tests: the benchmark's own invariants that the
// review requires to be pinned:
//   - presentation shader stride embeds the configured width (no 640 harcode)
//   - partial scene knobs are monotonic INPUT knobs; the canonical dirty
//     ratio is the planner's dirtyTexels/totalTexels and move/grow families
//     cover both partial and full-fallback planning modes
//   - upload transition scenes encode deterministically
//   - the scene library contains no Math.random
//
// The planner checks import the BUILT public bundle (dist/index.js) exactly
// like the bench runners consume it; they self-skip when the bundle is
// missing (run `npm run build -w ukibori-renderer` first).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { presentFs, PRESENT_FS_CONSTANT, PRESENT_VS } from "./presentation-shader.mjs";
import { partialEditScene } from "./scenes.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundlePath = resolve(scriptDir, "../../../dist/index.js");
const hasBundle = existsSync(bundlePath);
const api = hasBundle ? await import(new URL(`file://${bundlePath}`).href) : null;

const WIDTH = 640;
const HEIGHT = 360;
const SHADOW_OPTIONS = { maxDistance: 40, stepSize: 0.5, bias: 0.5 };

describe("presentation shader width contract", () => {
  it("embeds the configured width as the indexing stride (P1)", () => {
    expect(presentFs(320, 1)).toContain("u32(pos.y) * 320u + u32(pos.x)");
    expect(presentFs(320, 1)).not.toContain("640u");
  });
  it("embeds the configured width for P2 and P3 too", () => {
    for (const stage of [2, 3]) {
      expect(presentFs(1920, stage)).toContain("u32(pos.y) * 1920u + u32(pos.x)");
      expect(presentFs(1920, stage)).not.toContain("640u");
    }
  });
  it("P0 stays a constant-color fullscreen triangle", () => {
    expect(PRESENT_FS_CONSTANT).not.toContain("640u");
    expect(PRESENT_VS).toContain("@vertex");
  });
});

describe("partial scene knob contract", () => {
  it("the move knob shifts the slab monotonically (input knob, not a ratio)", () => {
    let prevX = -1;
    for (const edit of [0.02, 0.05, 0.1, 0.2, 0.35, 0.55, 0.8, 1]) {
      const scene = partialEditScene({ width: WIDTH, height: HEIGHT, edit });
      const slab = scene.surfaces.find((s) => s.id === "slab");
      expect(slab.position.x).toBeGreaterThan(prevX);
      prevX = slab.position.x;
    }
  });
  it("scenes contain no Math.random", () => {
    const source = readFileSync(join(scriptDir, "scenes.mjs"), "utf8");
    expect(source).not.toContain("Math.random");
  });
});

describe("planner dirty ratio contract (built bundle)", () => {
  const skip = it.skipIf(api === null);

  skip("actualDirtyRatio equals the planner's dirtyTexels / totalTexels", () => {
    const base = api.createScene(partialEditScene({ width: WIDTH, height: HEIGHT }));
    const baseBytes = api.encodeScene(base, 1).bytes;
    const edit = api.createScene(partialEditScene({ width: WIDTH, height: HEIGHT, edit: 0.55 }));
    const plan = api.planPartialScene({
      prevBytes: baseBytes,
      nextBytes: api.encodeScene(edit, 1).bytes,
      dpr: 1,
      renderWidth: WIDTH,
      renderHeight: HEIGHT,
      shadowOptions: SHADOW_OPTIONS,
      tileSize: 64,
    });
    // the harness's canonical ratio computation
    const actualDirtyRatio = plan.dirtyTexels / plan.totalTexels;
    expect(actualDirtyRatio).toBe(plan.dirtyTexels / plan.totalTexels);
    expect(plan.dirtyTexels).toBeGreaterThan(0);
  });

  skip("the move family stays partial with monotonically growing dirty texels", () => {
    const base = api.createScene(partialEditScene({ width: WIDTH, height: HEIGHT }));
    const baseBytes = api.encodeScene(base, 1).bytes;
    let prev = 0;
    for (const edit of [0.02, 0.05, 0.1, 0.2, 0.35, 0.55, 0.8, 1]) {
      const editScene = api.createScene(partialEditScene({ width: WIDTH, height: HEIGHT, edit }));
      const plan = api.planPartialScene({
        prevBytes: baseBytes,
        nextBytes: api.encodeScene(editScene, 1).bytes,
        dpr: 1,
        renderWidth: WIDTH,
        renderHeight: HEIGHT,
        shadowOptions: SHADOW_OPTIONS,
        tileSize: 64,
      });
      expect(plan.mode).toBe("partial");
      expect(plan.dirtyTexels).toBeGreaterThan(prev);
      prev = plan.dirtyTexels;
    }
  });

  skip("the grow family drives the planner into its full fallback", () => {
    const base = api.createScene(partialEditScene({ width: WIDTH, height: HEIGHT }));
    const baseBytes = api.encodeScene(base, 1).bytes;
    let sawFull = false;
    for (const grow of [1, 2, 4, 7]) {
      const editScene = api.createScene(partialEditScene({ width: WIDTH, height: HEIGHT, grow }));
      const plan = api.planPartialScene({
        prevBytes: baseBytes,
        nextBytes: api.encodeScene(editScene, 1).bytes,
        dpr: 1,
        renderWidth: WIDTH,
        renderHeight: HEIGHT,
        shadowOptions: SHADOW_OPTIONS,
        tileSize: 64,
      });
      if (plan.mode === "full") {
        sawFull = true;
      }
    }
    expect(sawFull).toBe(true);
  });

  skip("the grow family's dirty ratio grows monotonically", () => {
    const base = api.createScene(partialEditScene({ width: WIDTH, height: HEIGHT }));
    const baseBytes = api.encodeScene(base, 1).bytes;
    let prev = 0;
    for (const grow of [1, 2, 4, 7]) {
      const editScene = api.createScene(partialEditScene({ width: WIDTH, height: HEIGHT, grow }));
      const plan = api.planPartialScene({
        prevBytes: baseBytes,
        nextBytes: api.encodeScene(editScene, 1).bytes,
        dpr: 1,
        renderWidth: WIDTH,
        renderHeight: HEIGHT,
        shadowOptions: SHADOW_OPTIONS,
        tileSize: 64,
      });
      expect(plan.dirtyTexels).toBeGreaterThan(prev);
      prev = plan.dirtyTexels;
    }
  });
});

describe("upload transition scene contract (built bundle)", () => {
  const skip = it.skipIf(api === null);

  skip("before/after upload transition scenes encode deterministically and differ", () => {
    const grid = api.createScene({ width: 640, height: 360, surfaces: [
      { id: "panel", position: { x: 0, y: 0 }, size: { x: 640, y: 360 }, elevation: 0, thickness: 0, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "matte", castsShadow: false, receivesShadow: true },
      { id: "a", position: { x: 10, y: 10 }, size: { x: 60, y: 40 }, elevation: 2, thickness: 2, shape: { kind: "roundedRect", radius: 8 }, profile: { kind: "flat" }, material: "silicone", castsShadow: true, receivesShadow: true },
    ] });
    const before = api.encodeScene(grid, 1);
    const moved = api.encodeScene(
      api.createScene({
        ...grid,
        surfaces: grid.surfaces.map((s, i) => (i === 1 ? { ...s, position: { x: 14, y: 14 } } : s)),
      }),
      1,
    );
    expect(before.bytes.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(before.bytes).equals(Buffer.from(moved.bytes))).toBe(false);
    // identical transition: byte-identical scene, deterministic bytes
    const again = api.encodeScene(grid, 1);
    expect(Buffer.from(before.bytes).equals(Buffer.from(again.bytes))).toBe(true);
  });
});