import { afterEach, describe, expect, it } from "vitest";
import { createScene } from "../scene";
import { lightScene } from "../lighting";
import type { LightingOptions } from "../lighting";
import { HostBuffer } from "../buffer";
import { WasmCpuPipeline } from "./pipeline";
import { selectWasmBackend, resetWasmSelectionCache } from "./selection";
import type { WasmSelectionReport } from "./selection";
// @ts-expect-error - test-browser modules are plain ESM without declarations
import { createCatalog } from "../../test-browser/catalog.mjs";
import * as api from "../index";

/**
 * #33 WasmCpuPipeline parity + lifecycle.
 *
 * The pipeline consumes the canonical Scene, runs ONLY the normal stage in
 * WASM and composes the complete fallback output through the existing
 * reference stages. Because the WASM normal field is bit-identical to the
 * TypeScript oracle, the FULL output must match `lightScene` byte-for-byte
 * over the existing #30 catalog scene fixtures — preserving the
 * established #13-#21 semantics and the #22 color cases.
 */

afterEach(() => {
  resetWasmSelectionCache();
});

async function buildPipeline(): Promise<{ pipeline: WasmCpuPipeline; selection: WasmSelectionReport }> {
  const selection = await selectWasmBackend({ force: "wasm" });
  expect(selection.selected).toBe("wasm");
  const pipeline = await WasmCpuPipeline.load({ kernel: selection.kernel ?? undefined, selection });
  return { pipeline, selection };
}

/** Byte-exact comparison of two HostBuffers with the same spec. */
function expectBuffersEqual(label: string, a: HostBuffer, b: HostBuffer): void {
  expect(a.spec).toEqual(b.spec);
  const av = new Uint8Array(a.data.buffer);
  const bv = new Uint8Array(b.data.buffer);
  expect(av.length).toBe(bv.length);
  for (let i = 0; i < av.length; i++) {
    if (av[i] !== bv[i]) {
      expect.fail(`${label}: byte mismatch at ${i} (${av[i]} vs ${bv[i]})`);
    }
  }
}

/** All catalog scene fixtures that map 1:1 onto `lightScene` semantics
 * (logical render extent, dpr 1) — the full #13-#22 case set. */
function sceneFixtures() {
  const catalog = createCatalog(api) as {
    computeFixtures: Array<{
      id: string;
      dpr?: number;
      scene?: unknown;
      synthetic?: boolean;
      shadowSynth?: boolean;
      optionChange?: boolean;
      normalOptions?: unknown;
      shadowOptions?: unknown;
      lightingOptions?: unknown;
    }>;
  };
  return catalog.computeFixtures.filter(
    (fixture) =>
      fixture.scene !== undefined &&
      (fixture.dpr ?? 1) === 1 &&
      fixture.synthetic !== true &&
      fixture.shadowSynth !== true &&
      fixture.optionChange !== true,
  );
}

describe("#33 WasmCpuPipeline — full fallback parity vs lightScene (exact)", () => {
  it("reports the WASM stage provenance and stats on every render", async () => {
    const { pipeline } = await buildPipeline();
    const scene = createScene({
      width: 24,
      height: 18,
      surfaces: [
        {
          id: "s",
          position: { x: 6, y: 4 },
          size: { x: 12, y: 10 },
          elevation: 2,
          thickness: 1,
          bevelWidth: 2,
          shape: { kind: "roundedRect", radius: 3 },
          profile: { kind: "bevel" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
    });
    const result = await pipeline.render({ scene });
    expect(result.wasmStages).toEqual({
      height: "typescript",
      objectId: "typescript",
      normal: "wasm",
      visibility: "typescript",
      lighting: "typescript",
    });
    expect(result.wasmStats.kernelVersion).toBe(1);
    // stats are cumulative on the shared kernel: measure the delta of this
    // render's transfer (24x18 texels -> 1728 input bytes, 5184 output)
    expect(result.wasmStats.jsToWasmBytes).toBeGreaterThanOrEqual(24 * 18 * 4);
    expect(result.wasmStats.wasmToJsBytes).toBeGreaterThanOrEqual(24 * 18 * 12);
    expect(result.wasmStats.kernelMs).toBeGreaterThanOrEqual(0);
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
    // the report reflects the CURRENT render, and the buffers are correct
    expect(result.normal.spec).toEqual({ width: 24, height: 18, channels: 3, format: "f32" });
    expect(result.color.spec).toEqual({ width: 24, height: 18, channels: 4, format: "u8" });
  });

  it("matches lightScene byte-for-byte across every catalog scene fixture", async () => {
    const { pipeline } = await buildPipeline();
    const fixtures = sceneFixtures();
    expect(fixtures.length).toBeGreaterThan(20);
    for (const fixture of fixtures) {
      const scene = fixture.scene as Parameters<typeof createScene>[0] extends never ? never : never;
      const options: LightingOptions = {
        normal: fixture.normalOptions as LightingOptions["normal"],
        shadow: fixture.shadowOptions as LightingOptions["shadow"],
        ambient: (fixture.lightingOptions as { ambient?: number } | undefined)?.ambient,
      };
      const wasm = await pipeline.render({ scene: scene as never, lighting: options });
      const oracle = lightScene(scene as never, options);
      expectBuffersEqual(`${fixture.id}/height`, wasm.height, oracle.height);
      expectBuffersEqual(`${fixture.id}/normal`, wasm.normal, oracle.normal);
      expectBuffersEqual(`${fixture.id}/visibility`, wasm.visibility!, oracle.visibility!);
      expectBuffersEqual(`${fixture.id}/diffuse`, wasm.diffuse, oracle.diffuse);
      expectBuffersEqual(`${fixture.id}/specular`, wasm.specular, oracle.specular);
      expectBuffersEqual(`${fixture.id}/color`, wasm.color, oracle.color);
    }
  });
});

describe("#33 WasmCpuPipeline — cancellation and disposal", () => {
  const scene = () =>
    createScene({
      width: 32,
      height: 24,
      surfaces: [
        {
          id: "s",
          position: { x: 4, y: 4 },
          size: { x: 20, y: 14 },
          elevation: 2,
          thickness: 1,
          bevelWidth: 2,
          shape: { kind: "roundedRect", radius: 4 },
          profile: { kind: "bevel" },
          material: "metal",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
      light: { direction: { x: 0.5, y: 0.4, z: 1 }, intensity: 1.5 },
      environment: { intensity: 0.5 },
      exposure: 1.2,
    });

  it("rejects with AbortError when cancelled before a stage and publishes nothing", async () => {
    const { pipeline } = await buildPipeline();
    const controller = new AbortController();
    controller.abort();
    await expect(pipeline.render({ scene: scene(), signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("cancels at the next stage boundary when aborted mid-render", async () => {
    const { pipeline } = await buildPipeline();
    const controller = new AbortController();
    // aborting during the (async) render lands at a JS stage boundary — the
    // render must reject with AbortError instead of publishing
    const render = pipeline.render({ scene: scene(), signal: controller.signal });
    controller.abort();
    await expect(render).rejects.toMatchObject({ name: "AbortError" });
    // the pipeline stays usable afterwards
    const result = await pipeline.render({ scene: scene() });
    expect(result.color.spec.width).toBe(32);
  });

  it("rejects new renders after disposal (idempotent)", async () => {
    const { pipeline } = await buildPipeline();
    pipeline.dispose();
    pipeline.dispose();
    await expect(pipeline.render({ scene: scene() })).rejects.toThrow(/disposed/);
  });

  it("disposal releases the kernel so a fresh pipeline can be built", async () => {
    const { pipeline } = await buildPipeline();
    pipeline.dispose();
    const fresh = await WasmCpuPipeline.load();
    const result = await fresh.render({ scene: scene() });
    expect(result.wasmStages.normal).toBe("wasm");
    expect(result.color.spec.width).toBe(32);
    fresh.dispose();
  });
});
