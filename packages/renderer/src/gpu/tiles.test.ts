import { describe, expect, it } from "vitest";
import { computeNormals } from "../lighting";
import { HostBuffer } from "../buffer";
import { createScene } from "../scene";
import type { Scene, SceneInput, SurfaceNode } from "../scene";
import type { ShadowOptions } from "../shadow";
import { surfaceHeight } from "../geometry";
import { computeVisibility } from "../shadow";
import { NO_OWNER } from "../compose";
import { encodeScene } from "./encode";
import {
  PARTIAL_DISPATCH_RATIO,
  PROFILE_HALO_TEXELS,
  TILE_SIZE_DEFAULT,
  TILE_SIZE_MAX,
  TILE_SIZE_MIN,
  bandForDirtyRect,
  binSurfaceIndices,
  bytesEqual,
  clampTileSize,
  computeTileGrid,
  diffEncodedScenes,
  expandSceneRect,
  expandTexelRect,
  planDispatchChunks,
  planPartialScene,
  sceneRectToTexelRect,
  shadowHalo,
  surfaceTexelFootprint,
  tilesOverlappingRect,
} from "./tiles";

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

const BASE_SCENE: SceneInput = {
  width: 100,
  height: 200,
  surfaces: [
    {
      id: "a",
      position: { x: 10, y: 10 },
      size: { x: 40, y: 30 },
      elevation: 2,
      thickness: 2,
      shape: { kind: "roundedRect", radius: 0 },
      profile: { kind: "flat" },
      material: "silicone",
      castsShadow: true,
      receivesShadow: true,
    },
    {
      id: "b",
      position: { x: 60, y: 140 },
      size: { x: 20, y: 20 },
      elevation: 1,
      thickness: 1,
      shape: { kind: "roundedRect", radius: 0 },
      profile: { kind: "flat" },
      material: "matte",
      castsShadow: true,
      receivesShadow: true,
    },
    {
      // constant matte surface: keeps the first-appearance material table
      // [silicone, matte] stable when "b" is removed or re-materialed
      id: "c",
      position: { x: 10, y: 160 },
      size: { x: 10, y: 10 },
      elevation: 0,
      thickness: 1,
      shape: { kind: "roundedRect", radius: 0 },
      profile: { kind: "flat" },
      material: "matte",
      castsShadow: false,
      receivesShadow: true,
    },
  ],
  light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
};

function scene(input: Partial<SceneInput> = {}): Scene {
  return createScene({ ...BASE_SCENE, ...input });
}

function encoded(input: Partial<SceneInput> = {}, dpr = 1) {
  return encodeScene(scene(input), dpr).bytes;
}

function diff(a: Uint8Array, b: Uint8Array) {
  return diffEncodedScenes(a, b);
}

const smallShadowOptions = { maxDistance: 20, stepSize: 0.5, bias: 0.5 };

// ---------------------------------------------------------------------------
// Tile grid: indexing, edge clipping, deterministic bin membership
// ---------------------------------------------------------------------------

describe("#32 tile grid — indexing and edge clipping", () => {
  it("lays a deterministic grid over the render extent", () => {
    const grid = computeTileGrid(100, 80);
    expect(grid.tileSize).toBe(TILE_SIZE_DEFAULT);
    expect(grid.tilesX).toBe(2);
    expect(grid.tilesY).toBe(2);
    expect(grid.tileCount).toBe(4);
    expect(grid.tileRectAt(0, 0)).toEqual({ x: 0, y: 0, width: 64, height: 64 });
    // right-edge tile is clipped to the extent
    expect(grid.tileRectAt(1, 0)).toEqual({ x: 64, y: 0, width: 36, height: 64 });
    // bottom-edge tile is clipped
    expect(grid.tileRectAt(0, 1)).toEqual({ x: 0, y: 64, width: 64, height: 16 });
    // corner tile is clipped on both axes
    expect(grid.tileRectAt(1, 1)).toEqual({ x: 64, y: 64, width: 36, height: 16 });
  });

  it("rejects out-of-range tile indices", () => {
    const grid = computeTileGrid(100, 80, 32);
    expect(() => grid.tileRectAt(-1, 0)).toThrow(/out of range/);
    expect(() => grid.tileRectAt(0, -1)).toThrow(/out of range/);
    expect(() => grid.tileRectAt(4, 0)).toThrow(/out of range/);
    expect(() => grid.tileRectAt(0, 3)).toThrow(/out of range/);
    expect(() => grid.tileRectAt(1.5, 0)).toThrow(/out of range/);
  });

  it("clamps the configurable tile size into the documented bounds", () => {
    expect(clampTileSize(undefined as unknown as number)).toBe(TILE_SIZE_DEFAULT);
    expect(clampTileSize(4)).toBe(TILE_SIZE_MIN);
    expect(clampTileSize(10000)).toBe(TILE_SIZE_MAX);
    expect(clampTileSize(33.6)).toBe(34);
    expect(computeTileGrid(10, 10, 4).tileSize).toBe(TILE_SIZE_MIN);
    expect(computeTileGrid(10, 10, 1000).tileSize).toBe(TILE_SIZE_MAX);
    expect(computeTileGrid(64, 64, 64).tileCount).toBe(1);
    expect(computeTileGrid(65, 65, 64).tileCount).toBe(4);
  });

  it("bin membership is deterministic and rect-overlap exact", () => {
    const grid = computeTileGrid(100, 80, 32);
    const rect = { x: 30, y: 10, width: 40, height: 30 };
    const first = tilesOverlappingRect(grid, rect);
    const second = tilesOverlappingRect(grid, rect);
    expect(first).toEqual(second);
    // texels x 30..69 span tile columns 0..2 (32px tiles); rows 10..39
    // span tile rows 0..1 (row 0 is 0..31, row 1 is 32..63)
    expect(first.map((t) => [t.x, t.y])).toEqual([
      [0, 0],
      [32, 0],
      [64, 0],
      [0, 32],
      [32, 32],
      [64, 32],
    ]);
    const edge = { x: 31, y: 0, width: 1, height: 64 }; // touches tile (0,0) and (1,0) at the seam
    expect(tilesOverlappingRect(grid, edge)).toHaveLength(2);
  });

  it("computes the dispatch band from the dirty rect's tile rows", () => {
    // dirty rows 10..39 with 32px tiles -> tile rows 0..1 -> band 0..63
    expect(bandForDirtyRect({ x: 0, y: 10, width: 10, height: 30 }, 32, 80)).toEqual({
      y0: 0,
      y1: 63,
    });
    // dirty rows 40..41 -> tile row 1 -> band 32..63
    expect(bandForDirtyRect({ x: 0, y: 40, width: 10, height: 2 }, 32, 80)).toEqual({
      y0: 32,
      y1: 63,
    });
    // bottom clip: dirty rows 70..79 -> tile row 2 -> band 64..79 (clipped to the extent)
    expect(bandForDirtyRect({ x: 0, y: 70, width: 10, height: 10 }, 32, 80)).toEqual({
      y0: 64,
      y1: 79,
    });
  });
});

// ---------------------------------------------------------------------------
// Footprints: negative/out-of-view bounds, bevel/profile halo, shadow halo
// ---------------------------------------------------------------------------

describe("#32 conservative footprints", () => {
  it("converts scene rects to conservative texel rects (cell-overlap rule)", () => {
    // scene [10, 20] x [10, 20] at dpr 1 covers texel cells 10..19 on both axes
    const rect = sceneRectToTexelRect(
      { minX: 10, minY: 10, maxX: 20, maxY: 20 },
      1,
      100,
      80,
    );
    expect(rect).toEqual({ x: 10, y: 10, width: 10, height: 10 });
    // fractional bounds stay conservative
    const frac = sceneRectToTexelRect(
      { minX: 10.4, minY: 10.6, maxX: 20.2, maxY: 20.1 },
      1,
      100,
      80,
    );
    expect(frac).toEqual({ x: 10, y: 10, width: 11, height: 11 });
    // at dpr 1.5 the same scene rect covers more render texels
    const hi = sceneRectToTexelRect({ minX: 10, minY: 10, maxX: 20, maxY: 20 }, 1.5, 150, 120);
    expect(hi).toEqual({ x: 15, y: 15, width: 15, height: 15 });
  });

  it("returns null for empty or out-of-view scene rects", () => {
    expect(sceneRectToTexelRect({ minX: 200, minY: 200, maxX: 210, maxY: 210 }, 1, 100, 80)).toBeNull();
    expect(sceneRectToTexelRect({ minX: -30, minY: -30, maxX: -20, maxY: -20 }, 1, 100, 80)).toBeNull();
    // a zero-width shape at a single point covers no texel cell
    expect(sceneRectToTexelRect({ minX: 20, minY: 20, maxX: 20, maxY: 30 }, 1, 100, 80)).toBeNull();
  });

  it("clips partial overlaps to the render extent", () => {
    const rect = sceneRectToTexelRect({ minX: -5, minY: 10, maxX: 10, maxY: 20 }, 1, 100, 80);
    expect(rect).toEqual({ x: 0, y: 10, width: 10, height: 10 });
  });

  it("expands footprints by the profile halo (bevel/profile boundary support)", () => {
    const base = sceneRectToTexelRect({ minX: 10, minY: 10, maxX: 50, maxY: 40 }, 1, 100, 80)!;
    const haloed = expandTexelRect(base, PROFILE_HALO_TEXELS, 100, 80)!;
    expect(haloed).toEqual({ x: 9, y: 9, width: 42, height: 32 });
    // the expansion is clipped at the extent edges
    const edge = expandTexelRect({ x: 0, y: 0, width: 1, height: 1 }, PROFILE_HALO_TEXELS, 100, 80)!;
    expect(edge).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });

  it("derives surface texel footprints from ABI bounds with the profile halo", () => {
    const bytes = encoded();
    // surface "a": position (10,10) size (40,30) -> bounds (10,10)-(50,40)
    const record = bytes.subarray(128, 128 + 128);
    const footprint = surfaceTexelFootprint(record, 1, 100, 80)!;
    expect(footprint).toEqual({ x: 9, y: 9, width: 42, height: 32 });
    // fully off-view surfaces have no footprint (culled deterministically)
    const offView = encoded({
      surfaces: [
        { ...BASE_SCENE.surfaces![0]!, id: "off", position: { x: 200, y: 200 } },
      ],
    });
    expect(surfaceTexelFootprint(offView.subarray(128, 128 + 128), 1, 100, 80)).toBeNull();
  });

  it("expands a scene rect down-light by the shadow halo (per-axis, sign-aware)", () => {
    // light from upper-left: L = (-0.6, -0.8) -> the shadow falls to the
    // lower-right, so only the right/bottom edges expand
    const halo = shadowHalo(-0.6, -0.8, 20);
    expect(halo).toEqual({ left: 0, right: 12, top: 0, bottom: 16 });
    const expanded = expandSceneRect(
      { minX: 10, minY: 10, maxX: 50, maxY: 40 },
      halo,
    );
    expect(expanded).toEqual({ minX: 10, minY: 10, maxX: 62, maxY: 56 });
    // light from lower-right: L = (0.6, 0.8) -> the shadow falls upper-left
    const up = shadowHalo(0.6, 0.8, 10);
    expect(up).toEqual({ left: 6, right: 0, top: 8, bottom: 0 });
    // a purely vertical light has no horizontal halo
    expect(shadowHalo(0, 0, 100)).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
  });

  it("rejects an invalid shadow maxDistance", () => {
    expect(() => shadowHalo(1, 0, -1)).toThrow(/maxDistance/);
    expect(() => shadowHalo(1, 0, Infinity)).toThrow(/maxDistance/);
  });
});

// ---------------------------------------------------------------------------
// Scene diff: unchanged, move, resize, add, remove, material, local option,
// light/environment, viewport/DPR, unknown changes
// ---------------------------------------------------------------------------

describe("#32 exact scene diff", () => {
  it("reports no change for byte-identical scenes", () => {
    const result = diff(encoded(), encoded());
    expect(result.fullFallback).toBe(false);
    expect(result.dirtySceneRect).toBeNull();
    expect(result.changedSurfaceIndices).toEqual([]);
  });

  it("dirty region covers the OLD and NEW footprints of a moved surface", () => {
    const moved = { ...BASE_SCENE, surfaces: [{ ...BASE_SCENE.surfaces![0]!, position: { x: 12, y: 10 } }, BASE_SCENE.surfaces![1]!, BASE_SCENE.surfaces![2]!] };
    const result = diff(encoded(), encoded(moved));
    expect(result.fullFallback).toBe(false);
    expect(result.changedSurfaceIndices).toEqual([0]);
    expect(result.dirtySceneRect).toEqual({ minX: 10, minY: 10, maxX: 52, maxY: 40 });
  });

  it("dirty region covers the new footprint of a resized surface", () => {
    const resized = { ...BASE_SCENE, surfaces: [{ ...BASE_SCENE.surfaces![0]!, size: { x: 60, y: 30 } }, BASE_SCENE.surfaces![1]!, BASE_SCENE.surfaces![2]!] };
    const result = diff(encoded(), encoded(resized));
    expect(result.changedSurfaceIndices).toEqual([0]);
    expect(result.dirtySceneRect).toEqual({ minX: 10, minY: 10, maxX: 70, maxY: 40 });
  });

  it("dirty region covers the added surface footprint", () => {
    const added = {
      ...BASE_SCENE,
      surfaces: [
        ...BASE_SCENE.surfaces!,
        {
          id: "d",
          position: { x: 45, y: 20 },
          size: { x: 12, y: 12 },
          elevation: 0,
          thickness: 1,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: false,
          receivesShadow: true,
        } as SurfaceNode,
      ],
    };
    const result = diff(encoded(), encoded(added));
    expect(result.fullFallback).toBe(false);
    expect(result.addedOrRemovedSurfaceIndices).toEqual([3]);
    expect(result.dirtySceneRect).toEqual({ minX: 45, minY: 20, maxX: 57, maxY: 32 });
  });

  it("dirty region covers the OLD footprint of a removed surface", () => {
    // the constant matte surface "c" keeps the material table stable when
    // the matte surface "b" is removed; c shifts from index 2 to index 1,
    // so index 1 is a record change (b -> c) and index 2 is removed
    const removed = { ...BASE_SCENE, surfaces: [BASE_SCENE.surfaces![0]!, BASE_SCENE.surfaces![2]!] };
    const result = diff(encoded(), encoded(removed));
    expect(result.fullFallback).toBe(false);
    expect(result.changedSurfaceIndices).toEqual([1]);
    expect(result.addedOrRemovedSurfaceIndices).toEqual([2]);
    // both b's old footprint (60,140)-(80,160) and c's footprint are dirty
    expect(result.dirtySceneRect).toEqual({ minX: 10, minY: 140, maxX: 80, maxY: 170 });
  });

  it("treats a material-table change as a full fallback", () => {
    const matteChange = {
      ...BASE_SCENE,
      materials: { matte: { baseColor: { r: 0.9, g: 0.1, b: 0.1 }, roughness: 0.7, metallic: 0 } },
    };
    const result = diff(encoded(), encoded(matteChange));
    expect(result.fullFallback).toBe(true);
    expect(result.fullFallbackReason).toBe("material-table-change");
  });

  it("localizes a surface material-ref change when the table is stable", () => {
    // surface b moves from "matte" to the already-first-appearing "silicone":
    // the table stays [silicone, matte] (a keeps silicone, c keeps matte),
    // so only record 1 changes and the dirty region stays local
    const local = {
      ...BASE_SCENE,
      surfaces: [
        BASE_SCENE.surfaces![0]!,
        { ...BASE_SCENE.surfaces![1]!, material: "silicone" },
        BASE_SCENE.surfaces![2]!,
      ],
    };
    const result = diff(encoded(), encoded(local));
    expect(result.fullFallback).toBe(false);
    expect(result.changedSurfaceIndices).toEqual([1]);
    expect(result.dirtySceneRect).toEqual({ minX: 60, minY: 140, maxX: 80, maxY: 160 });
  });

  it("localizes a local option change (bevel width) to its surface footprint", () => {
    const beveled = {
      ...BASE_SCENE,
      surfaces: [
        { ...BASE_SCENE.surfaces![0]!, bevelWidth: 4, profile: { kind: "bevel" } } as SurfaceNode,
        BASE_SCENE.surfaces![1]!,
        BASE_SCENE.surfaces![2]!,
      ],
    };
    const result = diff(encoded(), encoded(beveled));
    expect(result.fullFallback).toBe(false);
    expect(result.changedSurfaceIndices).toEqual([0]);
    expect(result.dirtySceneRect).toEqual({ minX: 10, minY: 10, maxX: 50, maxY: 40 });
  });

  it("falls back to full for a global light/environment/exposure change", () => {
    for (const patch of [
      { light: { direction: { x: 0, y: 0, z: 1 } } },
      { light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 2 } },
      { exposure: 1.5 },
      { environment: { intensity: 0.9 } },
    ]) {
      const result = diff(encoded(), encoded(patch));
      expect(result.fullFallback).toBe(true);
      expect(result.fullFallbackReason).toBe("light-or-environment-change");
    }
  });

  it("falls back to full for a viewport/DPR change", () => {
    const viewport = diff(encoded({ width: 120, height: 80 }), encoded());
    expect(viewport.fullFallback).toBe(true);
    expect(viewport.fullFallbackReason).toBe("viewport-change");
    const dprChange = diff(encoded(), encoded({}, 2));
    expect(dprChange.fullFallback).toBe(true);
    expect(dprChange.fullFallbackReason).toBe("viewport-change");
  });

  it("falls back to full for an unknown byte mutation", () => {
    const mutated = encoded().slice();
    mutated[52] = 0x01; // a reserved header byte the diff does not interpret
    const result = diff(encoded(), mutated);
    expect(result.fullFallback).toBe(true);
    expect(result.fullFallbackReason).toBe("unknown-mutation");
  });

  it("dirties surfaces referencing a content-changed mask", () => {
    const glyph = { width: 4, height: 4, alpha: new Uint8Array(16).fill(255) };
    const changedGlyph = {
      width: 4,
      height: 4,
      alpha: Uint8Array.from([255, 0, 255, 0, 0, 255, 0, 255, 255, 0, 255, 0, 0, 255, 0, 255]),
    };
    const withMask = {
      ...BASE_SCENE,
      surfaces: [
        {
          id: "m",
          position: { x: 20, y: 20 },
          size: { x: 8, y: 8 },
          elevation: 3,
          thickness: 1,
          shape: { kind: "mask", mask: glyph },
          profile: { kind: "flat" },
          material: "metal",
          castsShadow: true,
          receivesShadow: true,
        } as SurfaceNode,
      ],
    };
    const changed = {
      ...withMask,
      surfaces: [
        { ...withMask.surfaces![0]!, shape: { kind: "mask", mask: changedGlyph } } as SurfaceNode,
      ],
    };
    const result = diff(encoded(withMask), encoded(changed));
    expect(result.fullFallback).toBe(false);
    // the mask content changed but no surface record byte changed: the mask
    // reference rule must dirty the referencing surface's footprint
    expect(result.changedSurfaceIndices).toEqual([]);
    expect(result.dirtySceneRect).toEqual({ minX: 20, minY: 20, maxX: 28, maxY: 28 });
  });
});

// ---------------------------------------------------------------------------
// Partial/full planning decisions
// ---------------------------------------------------------------------------

describe("#32 partial/full policy", () => {
  const plan = (
    prev: SceneInput,
    next: SceneInput,
    tileSize = 64,
    dpr = 1,
    shadowOptions: ShadowOptions = smallShadowOptions,
  ) =>
    planPartialScene({
      prevBytes: encodeScene(scene(prev), dpr).bytes,
      nextBytes: encodeScene(scene(next), dpr).bytes,
      dpr,
      renderWidth: Math.max(1, Math.floor(scene(next).width * dpr)),
      renderHeight: Math.max(1, Math.floor(scene(next).height * dpr)),
      shadowOptions,
      tileSize,
    });

  it("chooses partial for a small local edit with a bounded shadow halo", () => {
    const next = {
      ...BASE_SCENE,
      surfaces: [{ ...BASE_SCENE.surfaces![0]!, position: { x: 12, y: 11 } }, BASE_SCENE.surfaces![1]!, BASE_SCENE.surfaces![2]!],
    };
    const result = plan(BASE_SCENE, next, 32, 1);
    expect(result.mode).toBe("partial");
    expect(result.band).not.toBeNull();
    expect(result.dirtyTileCount).toBeGreaterThan(0);
    expect(result.dirtyTileCount).toBeLessThan(result.totalTileCount);
    expect(result.dirtyTexels).toBeGreaterThan(0);
    // the deterministic threshold: the band must cover at most half the frame
    expect(result.dispatchTexels).toBeLessThanOrEqual(result.totalTexels * PARTIAL_DISPATCH_RATIO);
    expect(result.dispatchTexels).toBeLessThan(result.totalTexels);
    expect(result.reason).toContain("band");
  });

  it("chooses full when the dirty coverage exceeds the documented threshold", () => {
    const next = {
      ...BASE_SCENE,
      surfaces: [
        { ...BASE_SCENE.surfaces![0]!, position: { x: 60, y: 120 } },
        { ...BASE_SCENE.surfaces![1]!, position: { x: 10, y: 10 } },
        BASE_SCENE.surfaces![2]!,
      ],
    };
    const result = plan(BASE_SCENE, next, 32, 1);
    expect(result.mode).toBe("full");
    expect(result.reason).toContain("band-coverage");
    expect(result.band).toBeNull();
    // the diagnostics still expose the region that would have been dirty
    expect(result.dirtyTexels).toBeGreaterThan(0);
  });

  it("falls back to full when the shadow halo cannot prove locality", () => {
    // a huge maxDistance expands the halo beyond the threshold
    const next = {
      ...BASE_SCENE,
      surfaces: [{ ...BASE_SCENE.surfaces![0]!, position: { x: 12, y: 11 } }, BASE_SCENE.surfaces![1]!, BASE_SCENE.surfaces![2]!],
    };
    const result = plan(BASE_SCENE, next, 32, 1, { maxDistance: 10000 });
    expect(result.mode).toBe("full");
    expect(result.reason).toContain("band-coverage");
  });

  it("chooses full for a viewport/DPR change and for light/material/unknown changes", () => {
    const small = { ...BASE_SCENE, width: 120, height: 80 };
    expect(plan(small, BASE_SCENE).mode).toBe("full");
    expect(plan(BASE_SCENE, small).reason).toBe("viewport-change");
    expect(plan(BASE_SCENE, { ...BASE_SCENE, light: { direction: { x: 0, y: 0, z: 1 } } }).reason).toBe(
      "light-or-environment-change",
    );
    expect(
      plan(BASE_SCENE, {
        ...BASE_SCENE,
        materials: { matte: { baseColor: { r: 1, g: 0, b: 0 }, roughness: 0.5, metallic: 0 } },
      }).reason,
    ).toBe("material-table-change");
  });

  it("reports candidate vs culled surface counts", () => {
    const next = {
      ...BASE_SCENE,
      surfaces: [{ ...BASE_SCENE.surfaces![0]!, position: { x: 12, y: 11 } }, BASE_SCENE.surfaces![1]!, BASE_SCENE.surfaces![2]!],
    };
    const result = plan(BASE_SCENE, next, 32, 1);
    expect(result.candidateSurfaceCount).toBeGreaterThan(0);
    expect(result.candidateSurfaceCount + result.culledSurfaceCount).toBe(3);
    // the distant constant surface is culled while the edited one is a candidate
    expect(result.candidateSurfaceCount).toBe(1);
    expect(result.culledSurfaceCount).toBe(2);
  });

  it("reports the default tile grid on no-change frames", () => {
    const result = plan(BASE_SCENE, BASE_SCENE);
    expect(result.mode).toBe("full");
    expect(result.reason).toBe("no-scene-change");
    expect(result.tileSize).toBe(TILE_SIZE_DEFAULT);
    expect(result.totalTileCount).toBe(computeTileGrid(100, 200).tileCount);
  });
});

// ---------------------------------------------------------------------------
// Property/table tests: planned dirty region vs the CPU oracle's actual
// output difference (partial vs forced-full equivalence)
// ---------------------------------------------------------------------------

describe("#32 property/table — planned dirty region covers every changed texel", () => {
  /** f32-round surface fields so the CPU oracle matches the encoded ABI geometry. */
  function oracleScene(s: Scene): Scene {
    return {
      ...s,
      surfaces: s.surfaces.map((surface) => ({
        ...surface,
        position: { x: Math.fround(surface.position.x), y: Math.fround(surface.position.y) },
        size: { x: Math.fround(surface.size.x), y: Math.fround(surface.size.y) },
        elevation: Math.fround(surface.elevation),
        thickness: Math.fround(surface.thickness ?? 0),
        bevelWidth: Math.fround(surface.bevelWidth ?? 0),
        shape:
          surface.shape.kind === "roundedRect"
            ? { kind: "roundedRect", radius: Math.fround(surface.shape.radius) }
            : surface.shape,
      })),
    };
  }

  function cpuHeightField(s: Scene, rw: number, rh: number, dpr: number) {
    const height = new HostBuffer({ width: rw, height: rh, channels: 1, format: "f32" });
    const objectId = new HostBuffer({ width: rw, height: rh, channels: 1, format: "u32" });
    const caster = new HostBuffer({ width: rw, height: rh, channels: 1, format: "f32" });
    for (let ty = 0; ty < rh; ty++) {
      for (let tx = 0; tx < rw; tx++) {
        const sx = (tx + 0.5) / dpr;
        const sy = (ty + 0.5) / dpr;
        let best = 0;
        let owner = NO_OWNER;
        let casterBest = 0;
        let casterOwner = NO_OWNER;
        for (let i = 0; i < s.surfaces.length; i++) {
          const h = Math.fround(surfaceHeight(s.surfaces[i], sx, sy));
          if (Number.isFinite(h) && h >= 0 && (h > best || h === best)) {
            best = h;
            owner = i;
          }
          if (s.surfaces[i].castsShadow) {
            if (Number.isFinite(h) && h >= 0 && (h > casterBest || h === casterBest)) {
              casterBest = h;
              casterOwner = i;
            }
          }
        }
        height.set(tx, ty, 0, best);
        objectId.set(tx, ty, 0, owner);
        caster.set(tx, ty, 0, casterOwner === NO_OWNER ? 0 : casterBest);
      }
    }
    return { height, objectId, caster };
  }

  function cpuChangedTexels(
    prev: Scene,
    next: Scene,
    rw: number,
    rh: number,
    dpr: number,
    shadowOptions: object,
  ): Set<number> {
    const prevFields = cpuHeightField(prev, rw, rh, dpr);
    const nextFields = cpuHeightField(next, rw, rh, dpr);
    const prevNormals = computeNormals(prevFields.height);
    const nextNormals = computeNormals(nextFields.height);
    const prevVis = computeVisibility(prev, prevFields.height, {
      objectId: prevFields.objectId,
      casterHeight: prevFields.caster,
      dpr,
      ...shadowOptions,
    });
    const nextVis = computeVisibility(next, nextFields.height, {
      objectId: nextFields.objectId,
      casterHeight: nextFields.caster,
      dpr,
      ...shadowOptions,
    });
    const changed = new Set<number>();
    for (let ty = 0; ty < rh; ty++) {
      for (let tx = 0; tx < rw; tx++) {
        const g = ty * rw + tx;
        if (
          Math.abs(prevFields.height.get(tx, ty, 0) - nextFields.height.get(tx, ty, 0)) > 1e-9 ||
          prevVis.get(tx, ty, 0) !== nextVis.get(tx, ty, 0)
        ) {
          changed.add(g);
          continue;
        }
        for (let c = 0; c < 3; c++) {
          if (Math.abs(prevNormals.get(tx, ty, c) - nextNormals.get(tx, ty, c)) > 1e-6) {
            changed.add(g);
            break;
          }
        }
      }
    }
    return changed;
  }

  function inRect(g: number, rw: number, rect: { x: number; y: number; width: number; height: number }): boolean {
    const tx = g % rw;
    const ty = Math.floor(g / rw);
    return tx >= rect.x && tx < rect.x + rect.width && ty >= rect.y && ty < rect.y + rect.height;
  }

  const scenarios: Array<{ name: string; patch: (s: SceneInput) => SceneInput }> = [
    { name: "move-small", patch: (s) => ({ ...s, surfaces: [{ ...s.surfaces![0]!, position: { x: 13, y: 12 } }, s.surfaces![1]!] }) },
    { name: "move-large", patch: (s) => ({ ...s, surfaces: [{ ...s.surfaces![0]!, position: { x: 55, y: 120 } }, s.surfaces![1]!] }) },
    { name: "resize", patch: (s) => ({ ...s, surfaces: [{ ...s.surfaces![0]!, size: { x: 55, y: 20 } }, s.surfaces![1]!] }) },
    // the added surface reuses an existing material so the material table
    // stays stable (a new material would legitimately force a full fallback)
    { name: "add", patch: (s) => ({ ...s, surfaces: [...s.surfaces!, { id: "d", position: { x: 45, y: 20 }, size: { x: 12, y: 12 }, elevation: 3, thickness: 1, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "silicone", castsShadow: true, receivesShadow: true }] }) },
    // removing the matte surface "b" keeps the table stable because the
    // constant matte surface "c" remains
    { name: "remove", patch: (s) => ({ ...s, surfaces: [s.surfaces![0]!, s.surfaces![2]!] }) },
    { name: "overlap-change", patch: (s) => ({ ...s, surfaces: [s.surfaces![0]!, { ...s.surfaces![1]!, position: { x: 30, y: 20 } }] }) },
    { name: "edge-touch", patch: (s) => ({ ...s, surfaces: [{ ...s.surfaces![0]!, position: { x: 58, y: 148 }, size: { x: 42, y: 52 } }, s.surfaces![1]!] }) },
    { name: "off-view", patch: (s) => ({ ...s, surfaces: [{ ...s.surfaces![0]!, position: { x: 300, y: 300 } }, s.surfaces![1]!] }) },
    { name: "caster-shadow", patch: (s) => ({ ...s, surfaces: [{ ...s.surfaces![0]!, position: { x: 14, y: 10 }, thickness: 3 }, s.surfaces![1]!] }) },
  ];

  for (const tileSize of [8, 16, 32, 64]) {
    for (const dpr of [1, 1.5, 2]) {
      it(`covers the CPU-observed output change for every scenario (tile ${tileSize}, dpr ${dpr})`, () => {
        const rw = Math.max(1, Math.floor(100 * dpr));
        const rh = Math.max(1, Math.floor(200 * dpr));
        for (const scenario of scenarios) {
          const prev = oracleScene(createScene({ ...BASE_SCENE }));
          const next = oracleScene(createScene(scenario.patch({ ...BASE_SCENE })));
          const prevBytes = encodeScene(prev, dpr).bytes;
          const nextBytes = encodeScene(next, dpr).bytes;
          const plan = planPartialScene({
            prevBytes,
            nextBytes,
            dpr,
            renderWidth: rw,
            renderHeight: rh,
            shadowOptions: smallShadowOptions,
            tileSize,
          });
          const changed = cpuChangedTexels(prev, next, rw, rh, dpr, smallShadowOptions);
          if (changed.size === 0) {
            // the off-view edit changes no output texel: the planner may
            // legitimately fall back or report an empty region, but must
            // never claim a dirty region that omits a real change
            expect(plan.dirtyRect).toBeNull();
            continue;
          }
          expect(plan.dirtyRect, `${scenario.name} must expose a dirty rect`).not.toBeNull();
          for (const g of changed) {
            expect(inRect(g, rw, plan.dirtyRect!), `${scenario.name} texel ${g} outside planned dirty rect`).toBe(true);
          }
          // a partial decision must also satisfy the documented threshold
          if (plan.mode === "partial") {
            expect(plan.dispatchTexels).toBeLessThanOrEqual(rw * rh * PARTIAL_DISPATCH_RATIO);
          }
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Exact equality helpers
// ---------------------------------------------------------------------------

describe("#32 exact comparisons (no hash shortcuts)", () => {
  it("bytesEqual is exact and length-aware", () => {
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(bytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(bytesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false);
    expect(bytesEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ACTUAL surface binning: conservative candidate indices for the compose
// shaders (band-scoped, original indices, deterministic)
// ---------------------------------------------------------------------------

describe("#32 binSurfaceIndices — conservative candidate bins", () => {
  it("bins ORIGINAL indices whose footprint intersects the rect, deterministically", () => {
    const bytes = encodeScene(scene(), 1).bytes;
    // surface a (10,10)-(50,40) footprint 9..51 x 9..41; b (60,140)-(80,160);
    // c (10,160)-(20,170)
    const band = { x: 0, y: 32, width: 100, height: 32 }; // rows 32..63
    const indices = binSurfaceIndices(bytes, band, 1, 100, 200);
    expect(indices).toEqual([0]); // only a's footprint overlaps rows 32..63
    const lower = binSurfaceIndices(bytes, { x: 0, y: 128, width: 100, height: 23 }, 1, 100, 200);
    expect(lower).toEqual([1]); // b at 139..159 only (c starts at 159..171)
    const bottom = binSurfaceIndices(bytes, { x: 0, y: 161, width: 100, height: 39 }, 1, 100, 200);
    expect(bottom).toEqual([2]); // c at 158..171 only (b ends at 160)
    // identical inputs -> identical bins
    expect(binSurfaceIndices(bytes, band, 1, 100, 200)).toEqual(indices);
  });

  it("returns an empty bin for a rect no surface footprint touches", () => {
    const bytes = encodeScene(scene(), 1).bytes;
    expect(binSurfaceIndices(bytes, { x: 0, y: 0, width: 100, height: 8 }, 1, 100, 200)).toEqual([]);
  });

  it("a band bin is a superset of any narrow dirty-rect bin inside it", () => {
    const bytes = encodeScene(scene(), 1).bytes;
    const band = { x: 0, y: 128, width: 100, height: 64 };
    const dirty = { x: 59, y: 139, width: 22, height: 22 };
    const bandIndices = binSurfaceIndices(bytes, band, 1, 100, 200);
    const dirtyIndices = binSurfaceIndices(bytes, dirty, 1, 100, 200);
    expect(dirtyIndices).toEqual([1]);
    for (const index of dirtyIndices) {
      expect(bandIndices).toContain(index);
    }
  });

  it("exposes the ACTUAL band candidates on a partial plan and every index on a full plan", () => {
    const next = {
      ...BASE_SCENE,
      surfaces: [
        { ...BASE_SCENE.surfaces![0]!, position: { x: 12, y: 11 } },
        BASE_SCENE.surfaces![1]!,
        BASE_SCENE.surfaces![2]!,
      ],
    };
    const partial = planPartialScene({
      prevBytes: encodeScene(scene(BASE_SCENE), 1).bytes,
      nextBytes: encodeScene(scene(next), 1).bytes,
      dpr: 1,
      renderWidth: 100,
      renderHeight: 200,
      shadowOptions: smallShadowOptions,
      tileSize: 32,
    });
    expect(partial.mode).toBe("partial");
    // the candidates are ORIGINAL indices (never reindexed) covering the
    // whole dispatch band, and the counts are actual (the height compose
    // shaders iterate exactly this list)
    expect(partial.candidateIndices.length).toBeGreaterThan(0);
    for (const index of partial.candidateIndices) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(3);
    }
    expect(partial.candidateIndices).toEqual([...partial.candidateIndices].sort((a, b) => a - b));
    expect(partial.candidateSurfaceCount).toBe(partial.candidateIndices.length);
    expect(partial.culledSurfaceCount).toBe(3 - partial.candidateIndices.length);
    // the band candidates include every surface that could own a band texel:
    // the CPU owner of any band texel is either NO_OWNER or a candidate
    const band = { x: 0, y: partial.band!.y0, width: 100, height: partial.band!.y1 - partial.band!.y0 + 1 };
    const s = scene(next);
    for (let ty = band.y; ty < band.y + band.height; ty++) {
      for (let tx = band.x; tx < band.x + band.width; tx++) {
        const sx = tx + 0.5;
        const sy = ty + 0.5;
        let owner = NO_OWNER;
        let best = 0;
        for (let i = 0; i < s.surfaces.length; i++) {
          const h = Math.fround(surfaceHeight(s.surfaces[i], sx, sy));
          if (Number.isFinite(h) && h >= 0 && (h > best || h === best)) {
            best = h;
            owner = i;
          }
        }
        if (owner !== NO_OWNER) {
          expect(partial.candidateIndices).toContain(owner);
        }
      }
    }
    // a full plan carries every original index
    const full = planPartialScene({
      prevBytes: encodeScene(scene(BASE_SCENE), 1).bytes,
      nextBytes: encodeScene(scene(BASE_SCENE), 1).bytes,
      dpr: 1,
      renderWidth: 100,
      renderHeight: 200,
      shadowOptions: smallShadowOptions,
      tileSize: 32,
    });
    expect(full.mode).toBe("full");
    expect(full.candidateIndices).toEqual([0, 1, 2]);
    expect(full.candidateSurfaceCount).toBe(3);
    expect(full.culledSurfaceCount).toBe(0);
  });

  it("handles a zero-candidate partial band (isolated surface deletion)", () => {
    // deleting both lower surfaces leaves a dirty band with NO remaining
    // surface footprint: the plan stays partial with an EMPTY candidate bin.
    // The matte anchor sits BEFORE the deleted surfaces in array order, so
    // its record index is stable and the material table keeps matte.
    const base = createScene({
      width: 100,
      height: 200,
      surfaces: [
        { id: "a", position: { x: 10, y: 10 }, size: { x: 40, y: 30 }, elevation: 2, thickness: 2, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "silicone", castsShadow: true, receivesShadow: true },
        { id: "d", position: { x: 80, y: 20 }, size: { x: 10, y: 10 }, elevation: 0, thickness: 1, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "matte", castsShadow: false, receivesShadow: true },
        { id: "b", position: { x: 60, y: 140 }, size: { x: 20, y: 20 }, elevation: 1, thickness: 1, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "matte", castsShadow: true, receivesShadow: true },
        { id: "c", position: { x: 10, y: 160 }, size: { x: 10, y: 10 }, elevation: 0, thickness: 1, shape: { kind: "roundedRect", radius: 0 }, profile: { kind: "flat" }, material: "matte", castsShadow: false, receivesShadow: true },
      ],
      light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
    });
    const edited = createScene({
      ...base,
      surfaces: [base.surfaces[0], base.surfaces[1]],
    });
    const plan = planPartialScene({
      prevBytes: encodeScene(base, 1).bytes,
      nextBytes: encodeScene(edited, 1).bytes,
      dpr: 1,
      renderWidth: 100,
      renderHeight: 200,
      shadowOptions: { maxDistance: 15, stepSize: 0.5, bias: 0.5 },
      tileSize: 32,
    });
    expect(plan.mode).toBe("partial");
    expect(plan.dirtyTexels).toBeGreaterThan(0);
    // the deletion band (rows 128..191) contains no remaining surface: the
    // compose shaders must clear it without iterating any surface
    expect(plan.candidateIndices).toEqual([]);
    expect(plan.candidateSurfaceCount).toBe(0);
    expect(plan.culledSurfaceCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// planDispatchChunks — limit-split 1D dispatch planning (pure function)
// ---------------------------------------------------------------------------

describe("planDispatchChunks", () => {
  it("returns null when the whole range fits one dispatch", () => {
    // ceil(100 * 80 / 64) = 125 <= 65535
    expect(planDispatchChunks(0, 79, 100, 64, 65535)).toBeNull();
    // exactly at the budget: still a single dispatch
    expect(planDispatchChunks(0, 19, 100, 64, 32)).toBeNull(); // ceil(2000/64)=32
  });

  it("splits into contiguous row chunks within the per-dimension cap", () => {
    // rowsPerChunk = floor(32 * 64 / 100) = 20 -> chunks of exactly 32 WG
    const chunks = planDispatchChunks(0, 79, 100, 64, 32)!;
    expect(chunks).toHaveLength(4);
    expect(chunks.map((c) => [c.y0, c.y1])).toEqual([
      [0, 19],
      [20, 39],
      [40, 59],
      [60, 79],
    ]);
    for (const chunk of chunks) {
      expect(chunk.texels).toBe(2000);
      expect(chunk.workgroups).toBe(32);
    }
  });

  it("covers a sub-range starting above row zero and clips the final chunk", () => {
    // range 10..74 (65 rows): rowsPerChunk = 20 -> 20 + 20 + 20 + 5
    const chunks = planDispatchChunks(10, 74, 100, 64, 32)!;
    expect(chunks.map((c) => [c.y0, c.y1])).toEqual([
      [10, 29],
      [30, 49],
      [50, 69],
      [70, 74],
    ]);
    const last = chunks[chunks.length - 1];
    expect(last.texels).toBe(500);
    expect(last.workgroups).toBe(Math.ceil(500 / 64));
  });

  it("throws when a single row alone exceeds the cap", () => {
    // width 4000 -> ceil(4000/64) = 63 > 32 in ONE row; no split can help
    expect(() => planDispatchChunks(0, 0, 4000, 64, 32)).toThrow(
      /dispatch chunk of 63 workgroups exceeds maxComputeWorkgroupsPerDimension 32/,
    );
  });
});
