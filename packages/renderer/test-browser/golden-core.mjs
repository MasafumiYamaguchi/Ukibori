// #30 static-CPU-golden core (verify + explicit maintenance update).
//
// `createGoldenRunner({ oracle, catalog })` computes the deterministic CPU
// oracle buffers for every fixture marked `golden` in the catalog and either
// verifies them against the checked-in `goldens/cpu-goldens.json` or
// regenerates that file.
//
// Rules (#30 "Static CPU goldens"):
//
//   - normal test/CI runs only VERIFY goldens (`golden-core.verify`)
//   - regeneration happens ONLY through the explicit maintenance command
//     (`npm run goldens:update -w ukibori-renderer`); it prints exactly which
//     fixture/buffer digest changed and is never run implicitly
//   - the CPU renderer is NEVER changed to update a failing golden: a golden
//     change must first be classified and explained as a semantic change, and
//     the updated file is a reviewable diff
//   - digests embed fixture id, categories, logical/render dimensions, DPR
//     and the full relevant parameter set (catalog params), so a dimension or
//     parameter change cannot preserve a stale digest accidentally
//   - integer/RGBA buffers hash canonical little-endian bytes; f32 buffers
//     canonicalize non-finite/-0 and quantize with the buffer's declared
//     absolute tolerance before hashing (see oracle.canonicalBufferBytes)
//   - goldens store compact SHA-256 digests plus small human-readable probes
//     (coordinates and values), never large binary dumps

import { CATALOG_VERSION, POLICY_TABLE, policyFor } from "./catalog.mjs";

/** Buffer -> canonical byte kind (integer/RGBA buffers are exact bytes). */
export const BUFFER_KIND = Object.freeze({
  height: "f32",
  coverage: "u32",
  objectId: "u32",
  materialId: "u32",
  casterHeight: "f32",
  normal: "f32",
  visibility: "f32",
  diffuse: "f32",
  specular: "f32",
  lightingColor: "u8",
});

/** Buffers with channels != 1 in the probe reading (normal = xyz triples). */
const PROBE_CHANNELS = { normal: 3 };

export function kindFor(name) {
  if (name.startsWith("canvas-frame-")) {
    return "u8";
  }
  const kind = BUFFER_KIND[name];
  if (kind === undefined) {
    throw new Error(`golden: no canonical kind for buffer "${name}"`);
  }
  return kind;
}

function toleranceFor(name) {
  const policy =
    name.startsWith("canvas-frame-")
      ? policyFor("canvas")
      : policyFor(name === "lightingColor" ? "lightingColor" : name);
  if (policy === null) {
    throw new Error(`golden: no policy for buffer "${name}"`);
  }
  return policy.tolerance;
}

export function createGoldenRunner({ oracle, catalog }) {
  const goldenFixtures = [...catalog.computeFixtures, ...catalog.presentationFixtures].filter(
    (fixture) => fixture.golden,
  );

  /**
   * Compute every golden buffer for one fixture: { name, kind, data, rw, rh }.
   * The CPU oracle functions are the ACTUAL TypeScript semantic references
   * (`computeNormals` / `computeVisibility` / `shadePreparedFields` /
   * `compositePixelBytes`), fed with the CPU reference fields and the same
   * effective (sanitized, f32-rounded) options the GPU passes use.
   */
  function computeFixtureBuffers(fixture) {
    const { sanitizeNormalOptions, sanitizeAmbient } = oracle.sanitizerApi;
    const buffers = [];
    if (fixture.synthetic === true) {
      const normal = oracle.normalOracle(
        fixture.field,
        fixture.width,
        fixture.height,
        sanitizeNormalOptions(fixture.normalOptions),
      );
      buffers.push({
        name: "normal",
        kind: "f32",
        data: normal,
        rw: fixture.width,
        rh: fixture.height,
      });
      return buffers;
    }
    if (fixture.shadowSynth === true || fixture.optionChange === true) {
      throw new Error(`golden: fixture "${fixture.id}" has no static CPU goldens (dynamic-only)`);
    }
    if (fixture.renders !== undefined || fixture.buffers.some((name) => name.startsWith("canvas-frame-"))) {
      const frames =
        fixture.renders ??
        [
          {
            scene: fixture.scene,
            dpr: fixture.dpr,
            normalOptions: fixture.normalOptions,
            shadowOptions: fixture.shadowOptions,
            lightingOptions: fixture.lightingOptions,
            compositeOptions: fixture.compositeOptions,
          },
        ];
      frames.forEach((frame, frameIndex) => {
        const dpr = frame.dpr ?? 1;
        const shadowOptions = oracle.effectiveShadowOptions(frame.scene, dpr, frame.shadowOptions);
        const ambient = sanitizeAmbient(frame.lightingOptions?.ambient);
        const reference = oracle.presentationReference(
          frame.scene,
          dpr,
          shadowOptions,
          ambient,
          frame.compositeOptions,
        );
        buffers.push({
          name: `canvas-frame-${frameIndex}`,
          kind: "u8",
          data: reference.ref,
          rw: reference.rw,
          rh: reference.rh,
        });
      });
      return buffers;
    }
    const scene = fixture.scene;
    const dpr = fixture.dpr;
    const oracleFields = oracle.cpuOracle(scene, dpr);
    const casterOracle = oracle.cpuCasterOracle(scene, dpr);
    const normal = oracle.normalOracle(
      oracleFields.height,
      oracleFields.rw,
      oracleFields.rh,
      sanitizeNormalOptions(fixture.normalOptions),
    );
    const shadowOptions = oracle.effectiveShadowOptions(scene, dpr, fixture.shadowOptions);
    const visibility = oracle.stableShadowOracle(
      scene,
      oracleFields.rw,
      oracleFields.rh,
      oracleFields.height,
      casterOracle.height,
      oracleFields.objectId,
      dpr,
      shadowOptions,
    );
    const ambient = sanitizeAmbient(fixture.lightingOptions?.ambient);
    const lighting = oracle.lightingOracleCPU(
      scene,
      oracleFields.rw,
      oracleFields.rh,
      normal,
      oracleFields.objectId,
      visibility,
      { ambient },
    );
    const entries = [
      ["height", oracleFields.height],
      ["coverage", oracleFields.coverage],
      ["objectId", oracleFields.objectId],
      ["materialId", oracleFields.materialId],
      ["casterHeight", casterOracle.height],
      ["normal", normal],
      ["visibility", visibility],
      ["diffuse", lighting.diffuse],
      ["specular", lighting.specular],
      ["lightingColor", lighting.color],
    ];
    for (const [name, data] of entries) {
      buffers.push({
        name,
        kind: kindFor(name),
        data,
        rw: oracleFields.rw,
        rh: oracleFields.rh,
      });
    }
    return buffers;
  }

  /** Compute { digest, probes } for one buffer of a fixture. */
  async function digestBuffer(fixture, buffer) {
    const digest = await oracle.bufferDigest(
      fixture,
      buffer.name,
      buffer.kind,
      buffer.data,
      toleranceFor(buffer.name),
    );
    const probes = oracle.probesFor(buffer.name, buffer.kind, buffer.data, buffer.rw, buffer.rh);
    return { digest, probes };
  }

  /** Full golden record set for the catalog (fixture -> buffers with digests). */
  async function computeAll() {
    const records = [];
    for (const fixture of goldenFixtures) {
      const buffers = [];
      for (const buffer of computeFixtureBuffers(fixture)) {
        const { digest, probes } = await digestBuffer(fixture, buffer);
        buffers.push({
          name: buffer.name,
          policy: policyFor(buffer.name.startsWith("canvas-frame-") ? "canvas" : buffer.name).buffer,
          tolerance: toleranceFor(buffer.name),
          kind: buffer.kind,
          digest,
          probes,
        });
      }
      records.push({
        id: fixture.id,
        logical: fixture.logical,
        dpr: fixture.dpr,
        render: fixture.render,
        params: fixture.params,
        buffers,
      });
    }
    return records;
  }

  /** Map fixture-id -> Map(bufferName -> golden buffer record) for comparison. */
  function digestIndex(records) {
    const index = new Map();
    for (const record of records) {
      index.set(record.id, new Map(record.buffers.map((b) => [b.name, b])));
    }
    return index;
  }

  /**
   * Verify the checked-in goldens: recompute every digest and compare.
   * Returns { ok, totalFixtures, totalBuffers, changes: [{fixtureId, buffer,
   * policy, tolerance, oldDigest, newDigest}], records }.
   */
  async function verify(goldens) {
    const records = await computeAll();
    const fresh = digestIndex(records);
    const checked = digestIndex(goldens.goldens);
    const changes = [];
    const expectedHeader = goldenFile([]);
    const checkedHeader = {
      format: goldens.format,
      catalogVersion: goldens.catalogVersion,
      policyTable: goldens.policyTable,
      generatedBy: goldens.generatedBy,
    };
    const currentHeader = {
      format: expectedHeader.format,
      catalogVersion: expectedHeader.catalogVersion,
      policyTable: expectedHeader.policyTable,
      generatedBy: expectedHeader.generatedBy,
    };
    if (JSON.stringify(checkedHeader) !== JSON.stringify(currentHeader)) {
      changes.push({
        fixtureId: "@golden-file",
        buffer: "@metadata",
        policy: "exact",
        tolerance: 0,
        oldDigest: JSON.stringify(checkedHeader),
        newDigest: JSON.stringify(currentHeader),
      });
    }
    for (const [id, bufferRecords] of fresh) {
      const previous = checked.get(id);
      for (const [name, buffer] of bufferRecords) {
        const oldDigest = previous?.get(name)?.digest;
        if (oldDigest !== buffer.digest) {
          changes.push({
            fixtureId: id,
            buffer: name,
            policy: policyFor(name.startsWith("canvas-frame-") ? "canvas" : name).buffer,
            tolerance: toleranceFor(name),
            oldDigest: oldDigest ?? null,
            newDigest: buffer.digest,
          });
        }
      }
    }
    // A stale fixture/buffer is also a golden mismatch. Without this reverse
    // pass, deleting a fixture from the catalog could leave dead expectations
    // in the checked-in file while verification still reported success.
    for (const [id, bufferRecords] of checked) {
      const current = fresh.get(id);
      for (const [name, buffer] of bufferRecords) {
        if (current?.has(name) !== true) {
          changes.push({
            fixtureId: id,
            buffer: name,
            policy: buffer.policy ?? "exact",
            tolerance: buffer.tolerance ?? 0,
            oldDigest: buffer.digest,
            newDigest: null,
          });
        }
      }
    }
    return {
      ok: changes.length === 0,
      totalFixtures: records.length,
      totalBuffers: records.reduce((sum, record) => sum + record.buffers.length, 0),
      changes,
      records,
    };
  }

  return {
    goldenFixtures,
    computeFixtureBuffers,
    verify,
    update: async (goldens) => {
      const records = await computeAll();
      const changes = [];
      const previous = digestIndex(goldens.goldens);
      // The FILE HEADER (format/catalogVersion/policyTable) is part of the
      // reviewable diff too: an intentional policy-description edit must be
      // persistable via --update, otherwise the update pass silently exits
      // "no changes" while verify keeps failing on the stale header.
      const expectedHeader = goldenFile([]);
      const checkedHeader = {
        format: goldens.format,
        catalogVersion: goldens.catalogVersion,
        policyTable: goldens.policyTable,
        generatedBy: goldens.generatedBy,
      };
      const currentHeader = {
        format: expectedHeader.format,
        catalogVersion: expectedHeader.catalogVersion,
        policyTable: expectedHeader.policyTable,
        generatedBy: expectedHeader.generatedBy,
      };
      if (JSON.stringify(checkedHeader) !== JSON.stringify(currentHeader)) {
        changes.push({
          fixtureId: "@golden-file",
          buffer: "@metadata",
          policy: "exact",
          tolerance: 0,
          oldDigest: JSON.stringify(checkedHeader),
          newDigest: JSON.stringify(currentHeader),
        });
      }
      for (const record of records) {
        for (const buffer of record.buffers) {
          const oldDigest = previous.get(record.id)?.get(buffer.name)?.digest;
          if (oldDigest !== buffer.digest) {
            changes.push({
              fixtureId: record.id,
              buffer: buffer.name,
              policy: buffer.policy,
              tolerance: buffer.tolerance,
              oldDigest: oldDigest ?? null,
              newDigest: buffer.digest,
            });
          }
        }
      }
      return {
        changes,
        records,
        totalFixtures: records.length,
        totalBuffers: records.reduce((sum, record) => sum + record.buffers.length, 0),
      };
    },
  };
}

/** The goldens file header (versioned; never embed timestamps in digests). */
export function goldenFile(records) {
  return {
    format: "ukibori-cpu-goldens-v1",
    catalogVersion: CATALOG_VERSION,
    policyTable: POLICY_TABLE,
    generatedBy: "npm run goldens:update -w ukibori-renderer (scripts/golden-cpu.mjs)",
    goldens: records,
  };
}
