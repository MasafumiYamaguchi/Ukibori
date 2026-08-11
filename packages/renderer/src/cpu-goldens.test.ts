import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as api from "./index";
// @ts-expect-error - test-browser modules are plain ESM without declarations
import { createCatalog, CATALOG_VERSION } from "../test-browser/catalog.mjs";
// @ts-expect-error - test-browser modules are plain ESM without declarations
import { createGoldenRunner, kindFor } from "../test-browser/golden-core.mjs";
// @ts-expect-error - test-browser modules are plain ESM without declarations
import { createOracle } from "../test-browser/oracle.mjs";

/**
 * #30 static CPU golden verification (runs on every `npm test`).
 *
 * The checked-in goldens (test-browser/goldens/cpu-goldens.json) pin the
 * deterministic CPU oracle outputs for the representative fixtures; a
 * semantic regression that hits BOTH the CPU renderer and the GPU shaders
 * cannot hide behind dynamic CPU<->GPU agreement. This test only VERIFIES:
 * regeneration happens exclusively through the explicit maintenance command
 * `npm run goldens:update -w ukibori-renderer`, which prints exactly which
 * fixture/buffer changed. The CPU renderer is never changed merely to
 * update a failing golden — classify and explain the semantic change first.
 */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const goldensPath = resolve(packageRoot, "test-browser", "goldens", "cpu-goldens.json");

const catalog = createCatalog(api);
const oracle = createOracle(api);
const runner = createGoldenRunner({ oracle, catalog });
const goldens = JSON.parse(readFileSync(goldensPath, "utf8"));

/** Structural types for the untyped test-browser modules and goldens JSON. */
interface PolicyEntry {
  buffer: string;
  policy: string;
  tolerance: number;
  description: string;
}
interface GoldenBuffer {
  name: string;
  policy: string;
  tolerance: number;
  kind: string;
  digest: string;
  probes: { x: number; y: number; v: string | number; label?: string }[];
}
interface GoldenRecord {
  id: string;
  logical: { width: number; height: number };
  render: { width: number; height: number };
  dpr: number;
  params: { dpr: number; scene: unknown; render: unknown };
  buffers: GoldenBuffer[];
}
interface GoldenFile {
  format: string;
  catalogVersion: number;
  policyTable: PolicyEntry[];
  goldens: GoldenRecord[];
}
interface FixtureLike {
  id: string;
  categories: string[];
  buffers: string[];
  golden: boolean;
  scene?: unknown;
  params: { dpr: number; scene: any; render: unknown };
}
const goldenFileData = goldens as GoldenFile;

describe("#30 static CPU goldens — checked-in file integrity", () => {
  it("has the versioned format and catalog version", () => {
    expect(goldenFileData.format).toBe("ukibori-cpu-goldens-v1");
    expect(goldenFileData.catalogVersion).toBe(CATALOG_VERSION);
    expect(Array.isArray(goldenFileData.goldens)).toBe(true);
    expect(goldenFileData.goldens.length).toBeGreaterThan(0);
  });

  it("declares one policy entry per compared buffer with a visible tolerance", () => {
    const policies = goldenFileData.policyTable;
    expect(Array.isArray(policies)).toBe(true);
    const names = new Set(policies.map((entry) => entry.buffer));
    for (const name of [
      "encodedHeader",
      "coverage",
      "objectId",
      "materialId",
      "visibility",
      "height",
      "casterHeight",
      "normal",
      "diffuse",
      "specular",
      "lightingColor",
      "canvas",
    ]) {
      expect(names.has(name)).toBe(true);
    }
    const byName = new Map<string, PolicyEntry>(policies.map((entry) => [entry.buffer, entry]));
    expect(byName.get("height")!.tolerance).toBe(1e-4);
    expect(byName.get("casterHeight")!.tolerance).toBe(1e-4);
    expect(byName.get("normal")!.tolerance).toBe(1e-4);
    expect(byName.get("diffuse")!.tolerance).toBe(1e-3);
    expect(byName.get("specular")!.tolerance).toBe(1e-3);
    expect(byName.get("coverage")!.policy).toBe("exact");
    expect(byName.get("objectId")!.policy).toBe("exact");
    expect(byName.get("materialId")!.policy).toBe("exact");
    expect(byName.get("visibility")!.policy).toBe("exact-0-1");
  });

  it("stores compact sha-256 digests with human-readable probes only", () => {
    for (const record of goldenFileData.goldens) {
      expect(record.id).toBeTruthy();
      expect(record.buffers.length).toBeGreaterThan(0);
      for (const buffer of record.buffers) {
        expect(buffer.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(Array.isArray(buffer.probes)).toBe(true);
        for (const probe of buffer.probes) {
          expect(typeof probe.x).toBe("number");
          expect(typeof probe.y).toBe("number");
          expect("v" in probe).toBe(true);
        }
      }
    }
  });

  it("embeds logical/render dimensions, DPR and parameters in every record", () => {
    for (const record of goldenFileData.goldens) {
      expect(record.logical.width).toBeGreaterThan(0);
      expect(record.logical.height).toBeGreaterThan(0);
      expect(record.render.width).toBe(Math.max(1, Math.floor(record.logical.width * Math.fround(record.dpr))));
      expect(record.render.height).toBe(Math.max(1, Math.floor(record.logical.height * Math.fround(record.dpr))));
      expect(record.params).toBeTruthy();
      expect(record.params.dpr).toBe(record.dpr);
      expect(record.params.scene).toBeTruthy();
    }
  });
});

describe("#30 static CPU goldens — verification", () => {
  it("recomputes every golden digest and finds zero changes", async () => {
    const report = await runner.verify(goldens);
    if (!report.ok) {
      // surface exactly which fixture/buffer/policy/tolerance changed so a
      // failing golden is immediately actionable
      for (const change of report.changes) {
        expect.fail(
          `golden mismatch: fixture ${change.fixtureId} buffer ${change.buffer} ` +
            `(policy ${change.policy}, tolerance ${change.tolerance}) ` +
            `digest ${change.oldDigest ?? "(missing)"} -> ${change.newDigest ?? "(missing)"} ` +
            `— classify and explain the semantic change, then run ` +
            `npm run goldens:update -w ukibori-renderer and review the JSON diff`,
        );
      }
    }
    expect(report.ok).toBe(true);
    expect(report.totalFixtures).toBe(goldenFileData.goldens.length);
  });

  it("rejects stale buffers and stale golden-file metadata", async () => {
    const stale = structuredClone(goldens) as GoldenFile;
    stale.catalogVersion += 1;
    stale.goldens[0]!.buffers.push({
      ...stale.goldens[0]!.buffers[0]!,
      name: "stale-buffer",
    });
    const report = await runner.verify(stale);
    expect(report.ok).toBe(false);
    expect(report.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fixtureId: "@golden-file", buffer: "@metadata" }),
        expect.objectContaining({ fixtureId: stale.goldens[0]!.id, buffer: "stale-buffer", newDigest: null }),
      ]),
    );
  });

  it("every golden fixture in the catalog has a digest for every compared buffer", () => {
    const byId = new Map<string, GoldenRecord>(
      goldenFileData.goldens.map((record) => [record.id, record]),
    );
    const goldenFixtures = [...(catalog.computeFixtures as FixtureLike[]), ...(catalog.presentationFixtures as FixtureLike[])].filter(
      (fixture) => fixture.golden,
    );
    expect(goldenFixtures.length).toBe(goldenFileData.goldens.length);
    for (const fixture of goldenFixtures) {
      const record = byId.get(fixture.id);
      expect(record).toBeTruthy();
      const bufferNames = new Set(record!.buffers.map((buffer) => buffer.name));
      for (const buffer of fixture.buffers) {
        expect(bufferNames.has(buffer)).toBe(true);
        expect(kindFor(buffer)).toBeTruthy(); // only known buffers are goldened
      }
    }
    // and no non-golden fixture leaks into the goldens file
    const goldenIds = new Set(goldenFixtures.map((fixture) => fixture.id));
    for (const record of goldenFileData.goldens) {
      expect(goldenIds.has(record.id)).toBe(true);
    }
  });

  it("f32 buffers canonicalize non-finite/-0 and quantize with the declared tolerance", async () => {
    // -0 becomes +0; NaN/Inf are fixed tokens; a 1e-4 tolerance quantizes
    const bytes = oracle.canonicalBufferBytes(
      "f32",
      new Float32Array([-0, NaN, Infinity, -Infinity, 1.00004, 0.99996, 0.5]),
      1e-4,
    );
    const view = new DataView(bytes.buffer);
    expect(view.getFloat32(0, true)).toBe(0); // -0 canonicalized
    expect(view.getUint32(4, true)).toBe(0x7fc00000); // NaN token
    expect(view.getUint32(8, true)).toBe(0x7f800000); // +Inf token
    expect(view.getUint32(12, true)).toBe(0xff800000); // -Inf token
    expect(view.getFloat32(16, true)).toBe(1); // 1.00004 -> quantized to 1
    expect(view.getFloat32(20, true)).toBe(1); // 0.99996 -> quantized to 1
    expect(view.getFloat32(24, true)).toBe(0.5); // untouched (exact)
    // u32 buffers are canonical little-endian bytes
    const u32 = oracle.canonicalBufferBytes("u32", new Uint32Array([0x01020304, 0]), 0);
    expect(Array.from(u32)).toEqual([0x04, 0x03, 0x02, 0x01, 0, 0, 0, 0]);
  });

  it("the golden payload embeds parameters, so a parameter change breaks the digest", async () => {
    const fixture = (catalog.computeFixtures as FixtureLike[]).find(
      (f) => f.id === "rounded-flat-dpr1",
    );
    expect(fixture).toBeTruthy();
    const data = new Float32Array([1, 2]);
    const digestA = await oracle.bufferDigest(fixture!, "height", "f32", data, 1e-4);
    const modified = {
      ...fixture!,
      params: {
        ...fixture!.params,
        scene: { ...fixture!.params.scene, width: fixture!.params.scene.width + 1 },
      },
    };
    const digestB = await oracle.bufferDigest(modified, "height", "f32", data, 1e-4);
    expect(digestA).not.toBe(digestB);
  });
});
