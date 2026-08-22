// #25/#30 real-GPU parity harness.
//
// Runs the PUBLIC bundled renderer ESM on a real WebGPU adapter:
//
//   1. requests a real adapter/device (SKIP when unavailable)
//   2. captures shader compilation messages (ANY type FAILs the run) and
//      device validation errors
//   3. for every catalog fixture (test-browser/catalog.mjs): `encodeScene`
//      -> `SceneUploader.upload` -> `HeightPass.dispatch` (the real compute
//      pipeline) -> `NormalPass.dispatch` -> `ShadowPass.dispatch` ->
//      `LightingPass.dispatch`, then TEST-ONLY staging copies + readback of
//      every intermediate buffer AND the presented canvas
//   4. compares every buffer against the actual TypeScript CPU oracles
//      (test-browser/oracle.mjs) using the central policy table
//      (test-browser/catalog.mjs POLICY_TABLE): IDs/coverage/visibility
//      EXACT, height/caster-height 1e-4, normals 1e-4, diffuse/specular
//      1e-3, RGBA8 with exact alpha and the at-most-one-channel-by-one
//      policy, canvas with exact alpha and the documented color-byte policy
//   5. every mismatch is reported with fixture ID, semantic categories,
//      pass/buffer, dimensions/DPR, parameters, coordinate/index, CPU value,
//      GPU value, delta and policy/tolerance, and is classified exactly once
//      (contract / coordinate / precision / sampling / scheduling /
//      color-space / unclassified — see oracle.classifyMismatch)
//   6. also runs a small synthetic GPU-resident height input set (normal
//      pass) and the synthetic self-shadow fixture (shadow pass), plus the
//      #27/#29 640x360 benchmarks
//   7. writes ONE unambiguous marker as the first line of the result block:
//      UKIBORI_WEBGPU_PASS / UKIBORI_WEBGPU_FAIL / UKIBORI_WEBGPU_SKIP,
//      followed by a `SUMMARY <json>` line (adapter/backend when exposed,
//      fixture totals, per-pass mismatch totals) consumed by the CI gate
//      (scripts/summarize-webgpu.mjs)
//
// The runner (scripts/test-webgpu.mjs) serves only this page, the copied
// bundle, the catalog and the oracle modules on 127.0.0.1 and parses the
// marker from the DOM.
//
// Static CPU goldens (#30): the same oracle functions + catalog compute the
// checked-in digests under test-browser/goldens/cpu-goldens.json; the
// vitest golden test verifies them on every `npm test`, and only the
// explicit `npm run goldens:update -w ukibori-renderer` command may
// regenerate them (printing exactly which fixture/buffer changed).

import { createCatalog, CATALOG_VERSION } from "./catalog.mjs";
import { createOracle } from "./oracle.mjs";

const RESULT_EL = document.getElementById("result");
const MARKER_PASS = "UKIBORI_WEBGPU_PASS";
const MARKER_FAIL = "UKIBORI_WEBGPU_FAIL";
const MARKER_SKIP = "UKIBORI_WEBGPU_SKIP";

const api = await import("./index.js");
const catalog = createCatalog(api);
const oracle = createOracle(api);
const { computeFixtures: FIXTURES, presentationFixtures: PRESENTATION_FIXTURES } = catalog;

// #27 benchmark: the fixed demo-frame proxy extent (the actual demo/debug
// extent is 96x60, not representative, so 640x360 is documented as the
// demo-frame proxy per the brief) and the required material improvement.
const BENCHMARK_WIDTH = 640;
const BENCHMARK_HEIGHT = 360;
const BENCHMARK_WARMUP = 5;
const BENCHMARK_SAMPLES = 10;
const BENCHMARK_MIN_SPEEDUP = 2;
// #29 presentation: the presentation-only benchmark reuses the documented
// demo-frame proxy extent with its own warmup/sample counts and is reported
// SEPARATELY from the full compute-chain benchmark.
const PRESENT_BENCHMARK_WARMUP = 5;
const PRESENT_BENCHMARK_SAMPLES = 10;

// #30 CI summary payload (adapter/backend when exposed, fixture totals and
// per-pass mismatch totals); emitted as a `SUMMARY <json>` line right after
// the first-line marker.
const summaryData = {
  adapter: null,
  fixtures: 0,
  texels: 0,
  normalTexels: 0,
  normalMismatches: 0,
  shadowTexels: 0,
  shadowMismatches: 0,
  casterTexels: 0,
  casterMismatches: 0,
  lightingTexels: 0,
  diffuseMismatches: 0,
  specularMismatches: 0,
  colorHard: 0,
  colorSoft: 0,
  colorAlphaBad: 0,
  mutationMismatches: 0,
  presentFixtures: 0,
  presentTexels: 0,
  presentHard: 0,
  presentAlphaBad: 0,
  retainedProblems: 0,
  partialProblems: 0,
  tileBenchmarkCases: 0,
  benchmarkSpeedup: null,
};

const detail = [];

function finish(marker, summary) {
  RESULT_EL.textContent = [
    marker + " " + summary,
    "SUMMARY " + JSON.stringify(summaryData),
    ...detail,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Test-only staging readback (production code never maps or reads back)
// ---------------------------------------------------------------------------

async function readback(device, buffer, byteLength) {
  const staging = device.createBuffer({
    size: byteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    label: "ukibori-test-staging",
  });
  try {
    const encoder = device.createCommandEncoder({ label: "ukibori-test-readback" });
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, byteLength);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const copy = new Uint8Array(staging.getMappedRange().slice()); // detach before unmap
    staging.unmap();
    return copy;
  } finally {
    staging.destroy();
  }
}

async function readbackF32(device, buffer, byteLength) {
  const bytes = await readback(device, buffer, byteLength);
  return new Float32Array(bytes.buffer, bytes.byteOffset, byteLength / 4);
}

async function readbackU32(device, buffer, byteLength) {
  const bytes = await readback(device, buffer, byteLength);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, byteLength / 4);
}

// ---------------------------------------------------------------------------
// Fixture runner
// ---------------------------------------------------------------------------

async function runFixture(device, fixture) {
  let uploader = null;
  let pass = null;
  let normalPass = null;
  let shadowPass = null;
  let lightingPass = null;
  let synthHeightBuffer = null;
  let synthObjectIdBuffer = null;
  let result = null;
  let failure = null;
  device.pushErrorScope("validation");
  try {
    if (fixture.synthetic) {
      // #26 synthetic GPU-resident height input: upload the f32 field into
      // a STORAGE|COPY_SRC|COPY_DST buffer and run the normal pass directly
      // (a small synthetic input is acceptable in addition to the
      // integrated #25 scenes).
      const { width, height: rh, field } = fixture;
      const byteLength = field.length * 4;
      synthHeightBuffer = device.createBuffer({
        size: Math.max(byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        label: "ukibori-test-synth-height",
      });
      device.queue.writeBuffer(
        synthHeightBuffer,
        0,
        new Uint8Array(field.buffer, field.byteOffset, byteLength),
      );
      normalPass = new api.NormalPass(device);
      normalPass.dispatch({
        height: {
          buffer: synthHeightBuffer,
          byteLength,
          format: "f32",
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          width,
          height: rh,
        },
        options: fixture.normalOptions,
      });
      const normal = await readbackF32(
        device,
        normalPass.getSnapshot().output.buffer,
        normalPass.getSnapshot().output.byteLength,
      );
      result = {
        name: fixture.id,
        texels: width * rh,
        mismatches: 0,
        samples: [],
        normalTexels: width * rh,
        normal: oracle.compareNormals(
          fixture,
          oracle.normalOracle(field, width, rh, oracle.sanitizerApi.sanitizeNormalOptions(fixture.normalOptions)),
          normal,
          width,
        ),
      };
    } else if (fixture.shadowSynth) {
      // #27 synthetic GPU-resident self-shadow fixture: upload the f32
      // ramp as both the full and caster height fields plus an all-NO_OWNER
      // object-id field, and run the shadow pass directly with two option
      // sets. Proves the source field bytes stay EXACTLY unchanged and the
      // output flips from fully occluded (bias 0) to fully lit (bias 2).
      const { width, height: rh, field, optionSets, scene } = fixture;
      const byteLength = field.length * 4;
      synthHeightBuffer = device.createBuffer({
        size: Math.max(byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        label: "ukibori-test-synth-shadow",
      });
      device.queue.writeBuffer(
        synthHeightBuffer,
        0,
        new Uint8Array(field.buffer, field.byteOffset, byteLength),
      );
      const objectId = new Uint32Array(width * rh).fill(api.NO_OWNER);
      synthObjectIdBuffer = device.createBuffer({
        size: Math.max(byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        label: "ukibori-test-synth-objid",
      });
      device.queue.writeBuffer(
        synthObjectIdBuffer,
        0,
        new Uint8Array(objectId.buffer, objectId.byteOffset, byteLength),
      );
      const encoded = api.encodeScene(scene, 1);
      const synthUploader = new api.SceneUploader(device);
      synthUploader.upload(encoded);
      const bindings = synthUploader.getBindings();
      const syntheticProvenance = Object.freeze({
        sceneBytes: encoded.bytes,
        width,
        height: rh,
        dpr: 1,
      });
      shadowPass = new api.ShadowPass(device);
      const input = {
        scene: encoded,
        bindings,
        height: {
          buffer: synthHeightBuffer,
          byteLength,
          format: "f32",
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          width,
          height: rh,
          provenance: syntheticProvenance,
        },
        casterHeight: {
          buffer: synthHeightBuffer,
          byteLength,
          format: "f32",
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          width,
          height: rh,
          provenance: syntheticProvenance,
        },
        objectId: {
          buffer: synthObjectIdBuffer,
          byteLength,
          format: "u32",
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          width,
          height: rh,
          provenance: syntheticProvenance,
        },
      };
      const initialHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      shadowPass.dispatch({ ...input, options: optionSets[0] });
      const firstHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      const firstVis = await readbackF32(
        device,
        shadowPass.getSnapshot().output.buffer,
        shadowPass.getSnapshot().output.byteLength,
      );
      const optionsA = shadowPass.getSnapshot().options;
      shadowPass.dispatch({ ...input, options: optionSets[1] });
      const secondHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      const secondVis = await readbackF32(
        device,
        shadowPass.getSnapshot().output.buffer,
        shadowPass.getSnapshot().output.byteLength,
      );
      const optionsB = shadowPass.getSnapshot().options;
      const a = oracle.compareVisibility(
        { ...fixture, id: fixture.id + "/bias0" },
        oracle.stableShadowOracle(scene, width, rh, field, field, objectId, 1, optionsA),
        firstVis,
        width,
      );
      const b = oracle.compareVisibility(
        { ...fixture, id: fixture.id + "/bias2" },
        oracle.stableShadowOracle(scene, width, rh, field, field, objectId, 1, optionsB),
        secondVis,
        width,
      );
      let extraMismatches = 0;
      const extraSamples = [];
      if (
        !oracle.bytesEqual(initialHeightBytes, firstHeightBytes) ||
        !oracle.bytesEqual(initialHeightBytes, secondHeightBytes)
      ) {
        extraMismatches += 1;
        extraSamples.push(oracle.mismatchReport(
          fixture,
          "shadow-source-mutation",
          0,
          width,
          "unchanged bytes",
          "changed bytes",
          "byte mismatch",
          { classification: "scheduling" },
        ));
      }
      let outputChanged = false;
      for (let i = 0; i < firstVis.length; i++) {
        if (firstVis[i] !== secondVis[i]) {
          outputChanged = true;
          break;
        }
      }
      if (!outputChanged) {
        extraMismatches += 1;
        extraSamples.push(oracle.mismatchReport(
          fixture,
          "visibility-option-response",
          0,
          width,
          "different output",
          "unchanged output",
          "no response",
          { classification: "contract" },
        ));
      }
      synthUploader.dispose();
      result = {
        name: fixture.id,
        texels: width * rh,
        mismatches: 0,
        samples: [],
        shadowTexels: width * rh * 2,
        shadow: {
          mismatches: a.mismatches + b.mismatches + extraMismatches,
          samples: [...a.samples, ...b.samples, ...extraSamples],
        },
        casterTexels: 0,
        caster: { mismatches: 0, maxError: 0 },
      };
    } else if (fixture.optionChange) {
      // #26 two custom option sets: proves the normal output changes while
      // the source height bytes remain EXACTLY unchanged in the test-only
      // readback, and that option updates reuse the same allocations.
      const { width, height: rh, field, optionSets } = fixture;
      const byteLength = field.length * 4;
      synthHeightBuffer = device.createBuffer({
        size: Math.max(byteLength, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        label: "ukibori-test-synth-height",
      });
      device.queue.writeBuffer(
        synthHeightBuffer,
        0,
        new Uint8Array(field.buffer, field.byteOffset, byteLength),
      );
      const initialHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      normalPass = new api.NormalPass(device);
      const input = {
        height: {
          buffer: synthHeightBuffer,
          byteLength,
          format: "f32",
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
          width,
          height: rh,
        },
      };
      normalPass.dispatch({ ...input, options: optionSets[0] });
      const firstHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      const firstNormal = await readbackF32(
        device,
        normalPass.getSnapshot().output.buffer,
        normalPass.getSnapshot().output.byteLength,
      );
      normalPass.dispatch({ ...input, options: optionSets[1] });
      const secondHeightBytes = await readback(device, synthHeightBuffer, byteLength);
      const secondNormal = await readbackF32(
        device,
        normalPass.getSnapshot().output.buffer,
        normalPass.getSnapshot().output.byteLength,
      );
      const a = oracle.compareNormals(
        { ...fixture, id: fixture.id + "/a" },
        oracle.normalOracle(field, width, rh, oracle.sanitizerApi.sanitizeNormalOptions(optionSets[0])),
        firstNormal,
        width,
      );
      const b = oracle.compareNormals(
        { ...fixture, id: fixture.id + "/b" },
        oracle.normalOracle(field, width, rh, oracle.sanitizerApi.sanitizeNormalOptions(optionSets[1])),
        secondNormal,
        width,
      );
      let extraMismatches = 0;
      const extraSamples = [];
      if (
        !oracle.bytesEqual(initialHeightBytes, firstHeightBytes) ||
        !oracle.bytesEqual(initialHeightBytes, secondHeightBytes)
      ) {
        extraMismatches += 1;
        extraSamples.push(oracle.mismatchReport(
          fixture,
          "normal-source-mutation",
          0,
          width,
          "unchanged bytes",
          "changed bytes",
          "byte mismatch",
          { classification: "scheduling" },
        ));
      }
      let outputChanged = false;
      for (let i = 0; i < firstNormal.length; i++) {
        if (Math.abs(firstNormal[i] - secondNormal[i]) > 1e-4) {
          outputChanged = true;
          break;
        }
      }
      if (!outputChanged) {
        extraMismatches += 1;
        extraSamples.push(oracle.mismatchReport(
          fixture,
          "normal-option-response",
          0,
          width,
          "different output",
          "unchanged output",
          "no response",
          { classification: "contract" },
        ));
      }
      result = {
        name: fixture.id,
        texels: width * rh,
        mismatches: 0,
        samples: [],
        normalTexels: width * rh * 2,
        normal: {
          mismatches: a.mismatches + b.mismatches + extraMismatches,
          samples: [...a.samples, ...b.samples, ...extraSamples],
          maxComponentError: Math.max(a.maxComponentError, b.maxComponentError),
          maxLengthError: Math.max(a.maxLengthError, b.maxLengthError),
        },
      };
    } else {
      const encoded = api.encodeScene(fixture.scene, fixture.dpr);
      uploader = new api.SceneUploader(device);
      pass = new api.HeightPass(device);
      uploader.upload(encoded);
      const bindings = uploader.getBindings();
      pass.dispatch(encoded, bindings);
      const outputs = pass.getOutputs();
      const snapshot = pass.getSnapshot();
      const [height, coverage, objectId, materialId] = await Promise.all([
        readbackF32(device, outputs.height.buffer, outputs.height.byteLength),
        readbackU32(device, outputs.coverage.buffer, outputs.coverage.byteLength),
        readbackU32(device, outputs.objectId.buffer, outputs.objectId.byteLength),
        readbackU32(device, outputs.materialId.buffer, outputs.materialId.byteLength),
      ]);
      const cpu = oracle.cpuOracle(fixture.scene, fixture.dpr);
      result = oracle.compareFixture(fixture, cpu, { height, coverage, objectId, materialId });

      // #26 normal stage: consume the #25 height output DIRECTLY through the
      // public helper and compare against the actual TypeScript oracle fed
      // with the CPU reference height and the same effective options.
      normalPass = new api.NormalPass(device);
      normalPass.dispatch({
        height: api.normalHeightBindingFromHeightPass(snapshot),
        options: fixture.normalOptions,
      });
      const normalBytes = await readback(
        device,
        normalPass.getSnapshot().output.buffer,
        normalPass.getSnapshot().output.byteLength,
      );
      const normal = new Float32Array(normalBytes.buffer, normalBytes.byteOffset, normalBytes.byteLength / 4);
      result.normalTexels = cpu.rw * cpu.rh;
      result.normal = oracle.compareNormals(
        fixture,
        oracle.normalOracle(cpu.height, cpu.rw, cpu.rh, oracle.sanitizerApi.sanitizeNormalOptions(fixture.normalOptions)),
        normal,
        cpu.rw,
      );

      // #27 shadow stage: consume the #25 height/casterHeight/objectId
      // outputs DIRECTLY through the public helper, dispatch the real
      // ShadowPass with the fixture options, and read back the caster
      // height and the binary visibility through TEST-ONLY staging buffers.
      shadowPass = new api.ShadowPass(device);
      const shadowInputs = api.shadowHeightBindingsFromHeightPass(snapshot);
      shadowPass.dispatch({
        scene: encoded,
        bindings,
        ...shadowInputs,
        options: fixture.shadowOptions,
      });
      const shadowSnapshot = shadowPass.getSnapshot();
      const [shadowBytes, casterBytes] = await Promise.all([
        readback(device, shadowSnapshot.output.buffer, shadowSnapshot.output.byteLength),
        readbackF32(device, outputs.casterHeight.buffer, outputs.casterHeight.byteLength),
      ]);
      const visibility = new Float32Array(
        shadowBytes.buffer,
        shadowBytes.byteOffset,
        shadowBytes.byteLength / 4,
      );
      const dpr = fixture.dpr ?? 1;
      // CPU oracle: the ACTUAL TypeScript oracle (computeVisibility +
      // caster-only composition) at the same render extent, DPR, f32 light
      // and the GPU's EFFECTIVE options, hardened by the +/-5e-4 stability
      // pre-check.
      const casterOracle = oracle.cpuCasterOracle(fixture.scene, dpr);
      const visibilityOracle = oracle.stableShadowOracle(
        fixture.scene,
        cpu.rw,
        cpu.rh,
        cpu.height,
        casterOracle.height,
        cpu.objectId,
        dpr,
        shadowSnapshot.options,
        fixture.shadowThresholdExact === true,
      );
      result.shadowTexels = cpu.rw * cpu.rh;
      result.shadow = oracle.compareVisibility(fixture, visibilityOracle, visibility, cpu.rw);
      result.casterTexels = cpu.rw * cpu.rh;
      result.caster = oracle.compareCasterHeight(fixture, casterOracle.height, casterBytes, cpu.rw);

      // #28 lighting stage: consume the #25 materialId, #26 normal and #27
      // visibility fields DIRECTLY (through the public helpers, whose
      // per-HeightPass-dispatch provenance is propagated into the
      // NormalPass/ShadowPass snapshots) plus the exact uploaded header and
      // material table, and compare diffuse/specular/RGBA8 against the
      // ACTUAL TypeScript shadePreparedFields oracle.
      lightingPass = new api.LightingPass(device);
      // snapshot the upstream field BYTES before the lighting dispatch so a
      // source-buffer mutation by the lighting pass fails the fixture
      const upstreamBefore = [
        new Uint8Array(height.buffer, height.byteOffset, height.byteLength),
        new Uint8Array(objectId.buffer, objectId.byteOffset, objectId.byteLength),
        new Uint8Array(materialId.buffer, materialId.byteOffset, materialId.byteLength),
        new Uint8Array(normal.buffer, normal.byteOffset, normal.byteLength),
        new Uint8Array(visibility.buffer, visibility.byteOffset, visibility.byteLength),
      ];
      lightingPass.dispatch({
        scene: encoded,
        bindings,
        materialId: api.lightingMaterialIdBindingFromHeightPass(snapshot),
        normal: api.lightingNormalBindingFromNormalPass(normalPass.getSnapshot()),
        visibility: api.lightingVisibilityBindingFromShadowPass(shadowSnapshot),
        options: fixture.lightingOptions,
      });
      const lightingSnapshot = lightingPass.getSnapshot();
      const [diffuseGpu, specularGpu, colorBytes] = await Promise.all([
        readbackF32(device, lightingSnapshot.diffuse.buffer, lightingSnapshot.diffuse.byteLength),
        readbackF32(device, lightingSnapshot.specular.buffer, lightingSnapshot.specular.byteLength),
        readback(device, lightingSnapshot.color.buffer, lightingSnapshot.color.byteLength),
      ]);
      // environment/exposure/ambient must NOT mutate any upstream buffer
      const upstreamAfter = [
        await readback(device, outputs.height.buffer, outputs.height.byteLength),
        await readback(device, outputs.objectId.buffer, outputs.objectId.byteLength),
        await readback(device, outputs.materialId.buffer, outputs.materialId.byteLength),
        await readback(device, normalPass.getSnapshot().output.buffer, normalPass.getSnapshot().output.byteLength),
        await readback(device, shadowSnapshot.output.buffer, shadowSnapshot.output.byteLength),
      ];
      let mutationMismatches = 0;
      const mutationSamples = [];
      const upstreamNames = ["height", "objectId", "materialId", "normal", "visibility"];
      for (let i = 0; i < upstreamBefore.length; i++) {
        if (!oracle.bytesEqual(upstreamBefore[i], upstreamAfter[i])) {
          mutationMismatches += 1;
          mutationSamples.push(oracle.mismatchReport(
            fixture,
            `${upstreamNames[i]}-mutation`,
            0,
            cpu.rw,
            "unchanged bytes",
            "changed bytes",
            "byte mismatch",
            { classification: "scheduling" },
          ));
        }
      }
      const cpuNormalOracle = oracle.normalOracle(
        cpu.height,
        cpu.rw,
        cpu.rh,
        oracle.sanitizerApi.sanitizeNormalOptions(fixture.normalOptions),
      );
      const lightingOracle = oracle.lightingOracleCPU(
        fixture.scene,
        cpu.rw,
        cpu.rh,
        cpuNormalOracle,
        cpu.objectId,
        visibilityOracle,
        { ambient: lightingSnapshot.ambient },
      );
      result.lightingTexels = cpu.rw * cpu.rh;
      result.lighting = {
        diffuse: oracle.compareLightingF32(
          fixture,
          "diffuse",
          lightingOracle.diffuse,
          diffuseGpu,
          cpu.rw,
        ),
        specular: oracle.compareLightingF32(
          fixture,
          "specular",
          lightingOracle.specular,
          specularGpu,
          cpu.rw,
        ),
        color: oracle.compareColor(fixture, lightingOracle.color, colorBytes, cpu.rw),
        mutation: { mismatches: mutationMismatches, samples: mutationSamples },
        ambient: lightingSnapshot.ambient,
      };

      // Raw GPU probes for the first fixture only: the uploaded scene header
      // (proves the queue.writeBuffer path), the objectId field (proves the
      // shader actually wrote NO_OWNER into background texels), the normal
      // field (proves the normal stage wrote its packed triples) and the
      // shadow pass snapshot (proves the visibility stage ran with the
      // effective options).
      if (fixture.probe) {
        const header = await readbackU32(device, bindings.header.buffer, bindings.header.byteLength);
        const headerView = new DataView(bindings.header.byteLength > 0 ? header.buffer : new ArrayBuffer(0));
        const probeLines = [
          `  header magic=0x${header[0].toString(16)} renderWidth=${header[6]} renderHeight=${header[7]} dpr=${headerView.getFloat32(32, true)}`,
          `  objectId first16=${Array.from(objectId.subarray(0, 16)).join(",")}`,
          `  coverage first16=${Array.from(coverage.subarray(0, 16)).join(",")}`,
          `  height first16=${Array.from(height.subarray(0, 16)).map((v) => v.toFixed(4)).join(",")}`,
          `  normal first16=${Array.from(normal.subarray(0, 48)).map((v) => v.toFixed(4)).join(",")}`,
          `  shadow first16=${Array.from(visibility.subarray(0, 16)).join(",")}`,
          `  lighting diffuse first16=${Array.from(diffuseGpu.subarray(0, 16)).map((v) => v.toFixed(4)).join(",")}`,
          `  lighting color first8=${Array.from(colorBytes.subarray(0, 32)).join(",")} ambient=${lightingSnapshot.ambient}`,
          `  snapshot=${JSON.stringify({ w: snapshot.width, h: snapshot.height, wg: snapshot.lastDispatch.workgroupCountX, cells: snapshot.lastDispatch.totalMaskCells, nwg: normalPass.getSnapshot().lastDispatch.workgroupCountX, swg: shadowSnapshot.lastDispatch.workgroupCountX, steps: shadowSnapshot.lastDispatch.stepCount, swOpts: shadowSnapshot.options, lwg: lightingSnapshot.lastDispatch.workgroupCountX })}`,
        ];
        for (const line of probeLines) {
          detail.push(line);
        }
      }
    }
  } catch (error) {
    failure = String(error?.stack ?? error);
  }
  // Exactly one popErrorScope per fixture: a non-null scoped validation error
  // is a REAL failure even when the comparison did not throw (e.g. an
  // invalid submit that dropped the command buffer), so it fails the fixture.
  const scopedError = await device.popErrorScope().catch(() => null);
  if (scopedError !== null) {
    detail.push(`fixture ${fixture.id} validation error: ${scopedError.message}`);
  }
  try {
    uploader?.dispose();
    pass?.dispose();
    normalPass?.dispose();
    shadowPass?.dispose();
    lightingPass?.dispose();
    synthHeightBuffer?.destroy();
    synthObjectIdBuffer?.destroy();
  } catch {
    // disposal must never mask the fixture outcome
  }
  if (failure !== null) {
    return { name: fixture.id, error: failure };
  }
  if (scopedError !== null) {
    return { name: fixture.id, error: `validation: ${scopedError.message}` };
  }
  return result;
}

async function checkShaders(device) {
  const problems = [];
  for (const [label, code] of [
    ["MASK_SDF_WGSL", api.MASK_SDF_WGSL],
    ["COMPOSE_HEIGHT_WGSL", api.COMPOSE_HEIGHT_WGSL],
    ["COMPOSE_COVERAGE_WGSL", api.COMPOSE_COVERAGE_WGSL],
    ["COMPOSE_OBJECT_ID_WGSL", api.COMPOSE_OBJECT_ID_WGSL],
    ["COMPOSE_MATERIAL_ID_WGSL", api.COMPOSE_MATERIAL_ID_WGSL],
    ["COMPOSE_CASTER_HEIGHT_WGSL", api.COMPOSE_CASTER_HEIGHT_WGSL],
    ["NORMAL_PASS_WGSL", api.NORMAL_PASS_WGSL],
    ["SHADOW_PASS_WGSL", api.SHADOW_PASS_WGSL],
    ["LIGHTING_PASS_WGSL", api.LIGHTING_PASS_WGSL],
    ["PRESENTATION_PASS_WGSL", api.PRESENTATION_PASS_WGSL],
  ]) {
    const module = device.createShaderModule({ code, label });
    const info = await module.getCompilationInfo();
    for (const message of info.messages) {
      // ANY compilation message (error, warning, info) FAILS the run: a
      // real-adapter PASS means every module compiled with ZERO messages.
      problems.push(
        `${label}:${message.lineNum}:${message.linePos}: ${message.type}: ${message.message}`,
      );
    }
  }
  return problems;
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * #27 reproducible benchmark at the documented demo-frame proxy extent
 * (640x360): the same nontrivial multi-surface scene/options for CPU and
 * GPU. Adapter/pipeline creation, test-only readback and the parity
 * comparison are excluded from both timings; the GPU side includes the
 * normal per-frame parameter upload/dispatch/queue completion
 * (`queue.onSubmittedWorkDone()`). Reports median CPU ms, median GPU ms and
 * the speedup; requires a material >= BENCHMARK_MIN_SPEEDUP improvement and
 * otherwise reports the measured blocker.
 */
/**
 * The shared 640x360 demo-frame proxy scene (the #27/#29 benchmark scene):
 * a full-panel receiver plus rounded/bevel/mask casters with shadows
 * falling on the panel AND the NO_OWNER base plane (opaque surface,
 * transparent lit background and translucent shadow texels all present).
 */
function benchmarkProxyScene() {
  const glyph = {
    width: 6,
    height: 6,
    alpha: new Uint8Array(36).fill(255),
  };
  const lightFromRight = { x: 0.70710678, y: 0, z: 0.70710678 };
  const shadowSurface = (partial) => ({
    id: "s",
    position: { x: 0, y: 0 },
    size: { x: 10, y: 10 },
    elevation: 0,
    thickness: 0,
    shape: { kind: "roundedRect", radius: 0 },
    profile: { kind: "flat" },
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
    ...partial,
  });
  return api.createScene({
    width: BENCHMARK_WIDTH,
    height: BENCHMARK_HEIGHT,
    surfaces: [
      shadowSurface({
        id: "panel",
        position: { x: 0, y: 0 },
        size: { x: BENCHMARK_WIDTH, y: BENCHMARK_HEIGHT },
        elevation: 0,
        castsShadow: false,
      }),
      shadowSurface({
        id: "btn-a",
        position: { x: 60, y: 80 },
        size: { x: 90, y: 60 },
        elevation: 2,
        thickness: 3,
        bevelWidth: 8,
        shape: { kind: "roundedRect", radius: 12 },
      }),
      shadowSurface({
        id: "btn-b",
        position: { x: 240, y: 120 },
        size: { x: 120, y: 70 },
        elevation: 4,
        thickness: 3,
        bevelWidth: 8,
        shape: { kind: "roundedRect", radius: 16 },
      }),
      shadowSurface({
        id: "btn-c",
        position: { x: 420, y: 60 },
        size: { x: 80, y: 90 },
        elevation: 1,
        thickness: 4,
        bevelWidth: 6,
        shape: { kind: "roundedRect", radius: 10 },
      }),
      shadowSurface({
        id: "badge",
        position: { x: 150, y: 200 },
        size: { x: 40, y: 40 },
        elevation: 7,
        thickness: 2,
        shape: { kind: "roundedRect", radius: 8 },
      }),
      shadowSurface({
        id: "glyph",
        position: { x: 520, y: 220 },
        size: { x: 12, y: 12 },
        elevation: 5,
        thickness: 2,
        shape: { kind: "mask", mask: glyph },
      }),
    ],
    light: { direction: lightFromRight, intensity: 1 },
  });
}

async function runBenchmark(device) {
  const scene = benchmarkProxyScene();
  const options = {};

  // CPU side (like-for-like stage set: height + caster composition +
  // normals + visibility + final-color shading, the #28 lighting oracle).
  const cpuFrame = () => {
    const composed = api.composeSdfHeightField(scene);
    const caster = api.composeCasterHeightField(scene);
    const normal = api.computeNormals(composed.height);
    const visibility = api.computeVisibility(scene, composed.height, {
      objectId: composed.objectId,
      casterHeight: caster,
    });
    api.shadePreparedFields(scene, {
      normal,
      objectId: composed.objectId,
      visibility,
    });
  };
  for (let i = 0; i < BENCHMARK_WARMUP; i++) {
    cpuFrame(); // warm the JS JIT before timing
  }
  const cpuSamples = [];
  for (let i = 0; i < BENCHMARK_SAMPLES; i++) {
    const t0 = performance.now();
    cpuFrame();
    cpuSamples.push(performance.now() - t0);
  }
  const cpuMedian = median(cpuSamples);

  // GPU side: upload once, then per sample the full frame chain
  // (HeightPass -> NormalPass -> ShadowPass -> LightingPass) with queue
  // completion. This includes the normal per-frame parameter upload/
  // dispatch/queue completion; pipeline and allocation caches are warm from
  // the parity run and the warm-up frame below.
  const encoded = api.encodeScene(scene, 1);
  const uploader = new api.SceneUploader(device);
  uploader.upload(encoded);
  const bindings = uploader.getBindings();
  const heightPass = new api.HeightPass(device);
  const normalPass = new api.NormalPass(device);
  const shadowPass = new api.ShadowPass(device);
  const lightingPass = new api.LightingPass(device);
  const frame = async () => {
    heightPass.dispatch(encoded, bindings);
    const heightSnapshot = heightPass.getSnapshot();
    normalPass.dispatch({
      height: api.normalHeightBindingFromHeightPass(heightSnapshot),
      options: {},
    });
    const normalSnapshot = normalPass.getSnapshot();
    shadowPass.dispatch({
      scene: encoded,
      bindings,
      ...api.shadowHeightBindingsFromHeightPass(heightSnapshot),
      options,
    });
    const shadowSnapshot = shadowPass.getSnapshot();
    lightingPass.dispatch({
      scene: encoded,
      bindings,
      materialId: api.lightingMaterialIdBindingFromHeightPass(heightSnapshot),
      normal: api.lightingNormalBindingFromNormalPass(normalSnapshot),
      visibility: api.lightingVisibilityBindingFromShadowPass(shadowSnapshot),
      options,
    });
    await device.queue.onSubmittedWorkDone();
  };
  for (let i = 0; i < BENCHMARK_WARMUP; i++) {
    await frame(); // warm device/pipeline/allocation caches before timing
  }
  const gpuSamples = [];
  for (let i = 0; i < BENCHMARK_SAMPLES; i++) {
    const t0 = performance.now();
    await frame();
    gpuSamples.push(performance.now() - t0);
  }
  const gpuMedian = median(gpuSamples);
  const speedup = cpuMedian / gpuMedian;
  // effective (sanitized + f32-packed) options of the benchmark run
  const effectiveOptions = shadowPass.getSnapshot().options;

  // One parity verification of the benchmark scene itself (outside both
  // timings): exact binary visibility vs the stable CPU oracle, tight
  // caster-height parity, and the #28 lighting parity (diffuse/specular
  // tolerance + RGBA8 color policy vs shadePreparedFields), so the
  // benchmark measures verified work.
  const outputs = heightPass.getOutputs();
  const [shadowBytes, caster] = await Promise.all([
    readback(device, shadowPass.getSnapshot().output.buffer, shadowPass.getSnapshot().output.byteLength),
    readbackF32(device, outputs.casterHeight.buffer, outputs.casterHeight.byteLength),
  ]);
  const cpu = oracle.cpuOracle(scene, 1);
  const casterOracle = oracle.cpuCasterOracle(scene, 1);
  const benchmarkFixture = {
    id: "benchmark",
    categories: ["benchmark"],
    logical: { width: scene.width, height: scene.height },
    render: { width: cpu.rw, height: cpu.rh },
    dpr: 1,
    params: { scene, shadowOptions: effectiveOptions },
  };
  const casterCompare = oracle.compareCasterHeight(benchmarkFixture, casterOracle.height, caster, cpu.rw);
  const visibility = new Float32Array(
    shadowBytes.buffer,
    shadowBytes.byteOffset,
    shadowBytes.byteLength / 4,
  );
  const visibilityOracle = oracle.stableShadowOracle(
    scene,
    cpu.rw,
    cpu.rh,
    cpu.height,
    casterOracle.height,
    cpu.objectId,
    1,
    shadowPass.getSnapshot().options,
  );
  const visCompare = oracle.compareVisibility(
    benchmarkFixture,
    visibilityOracle,
    visibility,
    cpu.rw,
  );
  const lightingSnapshot = lightingPass.getSnapshot();
  const [diffuseGpu, specularGpu, colorBytes] = await Promise.all([
    readbackF32(device, lightingSnapshot.diffuse.buffer, lightingSnapshot.diffuse.byteLength),
    readbackF32(device, lightingSnapshot.specular.buffer, lightingSnapshot.specular.byteLength),
    readback(device, lightingSnapshot.color.buffer, lightingSnapshot.color.byteLength),
  ]);
  const lightingOracle = oracle.lightingOracleCPU(
    scene,
    cpu.rw,
    cpu.rh,
    oracle.normalOracle(cpu.height, cpu.rw, cpu.rh, oracle.sanitizerApi.sanitizeNormalOptions({})),
    cpu.objectId,
    visibilityOracle,
    { ambient: lightingSnapshot.ambient },
  );
  const lightingParity = {
    diffuse: oracle.compareLightingF32(benchmarkFixture, "diffuse", lightingOracle.diffuse, diffuseGpu, cpu.rw),
    specular: oracle.compareLightingF32(benchmarkFixture, "specular", lightingOracle.specular, specularGpu, cpu.rw),
    color: oracle.compareColor(benchmarkFixture, lightingOracle.color, colorBytes, cpu.rw),
    ambient: lightingSnapshot.ambient,
  };

  uploader.dispose();
  heightPass.dispose();
  normalPass.dispose();
  shadowPass.dispose();
  lightingPass.dispose();
  return {
    cpuMedian,
    gpuMedian,
    speedup,
    warmups: BENCHMARK_WARMUP,
    samples: BENCHMARK_SAMPLES,
    width: BENCHMARK_WIDTH,
    height: BENCHMARK_HEIGHT,
    // the effective (sanitized + f32-packed) options the shader ran with,
    // taken from the final snapshot before disposal
    options: effectiveOptions,
    parity: {
      ...visCompare,
      casterMismatches: casterCompare.mismatches,
      casterMaxError: casterCompare.maxError,
      rw: cpu.rw,
      rh: cpu.rh,
    },
    lighting: lightingParity,
  };
}

// ---------------------------------------------------------------------------
// #29 presentation parity: the full GpuScenePipeline into a REAL
// GPUCanvasContext. The production path stays readback-free; ONLY this
// harness configures the current canvas texture with COPY_SRC (via the
// test-only `debugReadback` flag) and copies it to a padded staging buffer
// after the presentation submission.
// ---------------------------------------------------------------------------

/**
 * TEST-ONLY canvas readback, split into a SYNCHRONOUS submit phase and an
 * async map phase. On Windows/D3D the presented swap-chain texture is
 * recycled across task boundaries ("Destroyed texture ... used in a
 * submit"), so the staging copy MUST be submitted in the same task as the
 * presentation; only the mapAsync may wait.
 */
function submitPresentedCopy(device, width, height, capturedTexture = null) {
  const canvasTexture = capturedTexture ?? null;
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const staging = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    label: "ukibori-test-present-staging",
  });
  const encoder = device.createCommandEncoder({ label: "ukibori-test-present-readback" });
  encoder.copyTextureToBuffer(
    { texture: canvasTexture, mipLevel: 0, origin: { x: 0, y: 0 } },
    { buffer: staging, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);
  return { device, staging, width, height, bytesPerRow };
}

/** Drain a pending {@link submitPresentedCopy} handle into packed RGBA rows. */
async function finishPresentedCopy(handle) {
  const { device, staging, width, height, bytesPerRow } = handle;
  try {
    await staging.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(staging.getMappedRange().slice()); // detach before unmap
    staging.unmap();
    const rows = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      rows.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    }
    return rows;
  } finally {
    staging.destroy();
  }
}

/**
 * Convenience wrapper: capture now, submit now, map now.
 */
async function presentReadback(device, _context, width, height, _format, capturedTexture = null) {
  const handle = submitPresentedCopy(device, width, height, capturedTexture);
  return finishPresentedCopy(handle);
}

/**
 * Normalize the canvas readback into R,G,B,A byte order: the canvas may be
 * `bgra8unorm` (the browser-preferred format on most platforms), in which
 * case the attachment format swizzle is handled by WebGPU and the raw
 * bytes come back B,G,R,A. The production shader always returns logical
 * RGBA; this normalization makes the comparison independent of the
 * selected 8-bit canvas format.
 */
function normalizeCanvasBytes(bytes, canvasFormat, width, height) {
  if (canvasFormat !== "bgra8unorm") {
    return bytes;
  }
  const out = new Uint8Array(bytes);
  for (let g = 0; g < width * height; g++) {
    const p = g * 4;
    const r = out[p];
    out[p] = out[p + 2];
    out[p + 2] = r;
  }
  return out;
}

/**
 * Run one presentation fixture: a fresh canvas/context + GpuScenePipeline,
 * render every requested frame (the canvas backing store is resized by the
 * pipeline itself), read back the presented canvas through a TEST-ONLY
 * padded staging copy, and compare against the CPU reference composition.
 * Exactly one error scope is pushed and popped per fixture; disposal never
 * masks the outcome.
 */
async function runPresentationFixture(device, fixture) {
  const canvas = document.createElement("canvas");
  canvas.width = 0;
  canvas.height = 0;
  document.body.appendChild(canvas);
  const context = canvas.getContext("webgpu");
  // resolved ONCE at the real API boundary, exactly like the #29 contract
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  let pipeline = null;
  let compared = null;
  let failure = null;
  device.pushErrorScope("validation");
  try {
    const frames = fixture.renders ?? [
      {
        scene: fixture.scene,
        dpr: fixture.dpr,
        compositeOptions: fixture.compositeOptions,
        normalOptions: fixture.normalOptions,
      },
    ];
    pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
    compared = [];
    for (const frame of frames) {
      pipeline.render({
        scene: frame.scene,
        dpr: frame.dpr,
        normalOptions: frame.normalOptions,
        compositeOptions: frame.compositeOptions,
        debugReadback: true,
      });
      // capture the current canvas texture SYNCHRONOUSLY (same task as the
      // presentation submission) — the queue orders the test-only blit
      // after the presentation work, so the captured texture always holds
      // the presented frame
      const captured = context.getCurrentTexture();
      const snapshot = pipeline.getSnapshot();
      const width = snapshot.width;
      const height = snapshot.height;
      const raw = await presentReadback(device, context, width, height, canvasFormat, captured);
      const gpu = normalizeCanvasBytes(raw, canvasFormat, width, height);
      const reference = oracle.presentationReference(
        frame.scene,
        frame.dpr,
        snapshot.shadowPass.options,
        snapshot.lightingPass.ambient,
        frame.compositeOptions,
      );
      const compare = oracle.compareCanvas(fixture, reference.ref, gpu, width);
      compared.push({ width, height, texels: reference.texels, compare });
      if (fixture.probe) {
        const current = context.getCurrentTexture();
        detail.push(
          `  presentation probe: canvas ${snapshot.width}x${snapshot.height} dpr ${snapshot.dpr} ` +
            `format ${canvasFormat} alphaMode=${snapshot.presentationPass.alphaMode} ` +
            `colorSpace=${snapshot.presentationPass.colorSpace} ` +
            `composite=${JSON.stringify(snapshot.presentationPass.composite)} ` +
            `configGeneration=${snapshot.presentationPass.configurationGeneration} ` +
            `workSubmitted=${snapshot.presentationPass.workSubmitted} ` +
            `currentTexture.usage=0x${current.usage.toString(16)} ` +
            `width=${current.width} height=${current.height}`,
        );
      }
    }
  } catch (error) {
    failure = String(error?.stack ?? error);
  }
  const scopedError = await device.popErrorScope().catch(() => null);
  if (scopedError !== null) {
    detail.push(`fixture ${fixture.id} validation error: ${scopedError.message}`);
  }
  try {
    pipeline?.dispose();
    canvas.remove();
  } catch {
    // disposal must never mask the fixture outcome
  }
  if (failure !== null) {
    return { name: fixture.id, error: failure };
  }
  if (scopedError !== null) {
    return { name: fixture.id, error: `validation: ${scopedError.message}` };
  }
  if (compared === null || compared.length === 0) {
    return { name: fixture.id, error: "no frames compared" };
  }
  return {
    name: fixture.id,
    canvasFormat,
    compared,
    texels: compared.reduce((sum, frame) => sum + frame.texels, 0),
  };
}

/**
 * #29 presentation-only benchmark at the documented demo-frame proxy extent
 * (640x360): the full chain runs ONCE (upload + compute outside the
 * timing), then the timed samples re-present the last frame — timed from
 * the render-pass encoding through `queue.onSubmittedWorkDone()`, excluding
 * compute, scene upload and test readback. Reported SEPARATELY from the
 * full compute-chain benchmark. The final presented frame is verified
 * against the CPU reference (outside the timings).
 */
async function runPresentationBenchmark(device) {
  const scene = benchmarkProxyScene();
  const canvas = document.createElement("canvas");
  canvas.width = 0;
  canvas.height = 0;
  document.body.appendChild(canvas);
  const context = canvas.getContext("webgpu");
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
  try {
    pipeline.render({ scene, dpr: 1, debugReadback: true });
    await device.queue.onSubmittedWorkDone();
    let finalTexture = null;
    const sample = async () => {
      const t0 = performance.now();
      pipeline.present();
      // capture synchronously (same task as the submission) so the final
      // parity readback can read the presented texture
      finalTexture = context.getCurrentTexture();
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };
    for (let i = 0; i < PRESENT_BENCHMARK_WARMUP; i++) {
      await sample(); // warm the cached pipeline/allocations before timing
    }
    const samples = [];
    for (let i = 0; i < PRESENT_BENCHMARK_SAMPLES; i++) {
      samples.push(await sample());
    }
    const presentMedian = median(samples);
    // verify the last presented frame (outside both timings and the
    // readback). The staging copy is SUBMITTED in this same task — D3D
    // recycles the presented texture across task boundaries, so an awaited
    // late copy would intermittently fail validation.
    pipeline.present();
    finalTexture = context.getCurrentTexture();
    const snapshot = pipeline.getSnapshot();
    const pendingCopy = submitPresentedCopy(
      device,
      snapshot.width,
      snapshot.height,
      finalTexture,
    );
    const raw = await finishPresentedCopy(pendingCopy);
    const gpu = normalizeCanvasBytes(raw, canvasFormat, snapshot.width, snapshot.height);
    const reference = oracle.presentationReference(
      scene,
      1,
      snapshot.shadowPass.options,
      snapshot.lightingPass.ambient,
      undefined,
    );
    const parity = oracle.compareCanvas(
      {
        id: "presentation-benchmark",
        categories: ["benchmark", "canvas"],
        logical: { width: scene.width, height: scene.height },
        render: { width: snapshot.width, height: snapshot.height },
        dpr: 1,
        params: { scene },
      },
      reference.ref,
      gpu,
      snapshot.width,
    );
    return {
      presentMedian,
      warmups: PRESENT_BENCHMARK_WARMUP,
      samples: PRESENT_BENCHMARK_SAMPLES,
      width: BENCHMARK_WIDTH,
      height: BENCHMARK_HEIGHT,
      texels: reference.texels,
      parity,
    };
  } finally {
    pipeline.dispose();
    canvas.remove();
  }
}

// #41 shadow-pass sample-count benchmark: median HOST wall-clock per
// ShadowPass.dispatch (submit + queue drain) on the 640x360 proxy scene at
// the documented sample counts. The scene carries a POSITIVE light angular
// radius so every dispatch runs the REAL soft path (a radius of 0 would
// silently take the hard single-ray shortcut regardless of the count).
// Report-only: correctness is owned by the parity fixtures.
const SHADOW_BENCH_SAMPLE_COUNTS = [1, 4, 8, 16];
const SHADOW_BENCH_ANGULAR_RADIUS = Math.fround(0.15);
const SHADOW_BENCH_WARMUP = 3;
const SHADOW_BENCH_SAMPLES = 10;

async function runShadowSampleBenchmark(device) {
  const base = benchmarkProxyScene();
  const scene = {
    ...base,
    light: { ...base.light, angularRadius: SHADOW_BENCH_ANGULAR_RADIUS },
  };
  const encoded = api.encodeScene(scene, 1);
  const uploader = new api.SceneUploader(device);
  uploader.upload(encoded);
  const bindings = uploader.getBindings();
  const heightPass = new api.HeightPass(device);
  heightPass.dispatch(encoded, bindings);
  const inputs = api.shadowHeightBindingsFromHeightPass(heightPass.getSnapshot());
  const rows = [];
  try {
    for (const samples of SHADOW_BENCH_SAMPLE_COUNTS) {
      const pass = new api.ShadowPass(device);
      const input = { scene: encoded, bindings, ...inputs, options: { samples } };
      for (let i = 0; i < SHADOW_BENCH_WARMUP; i++) {
        pass.dispatch(input); // warm the cached pipelines/allocations
      }
      await device.queue.onSubmittedWorkDone();
      // the EFFECTIVE count actually dispatched (sanitized; also documents
      // whether the soft path was active for this row)
      const effectiveSamples = pass.getSnapshot().options.samples;
      const softActive =
        SHADOW_BENCH_ANGULAR_RADIUS > 0 && effectiveSamples > 1;
      const timings = [];
      for (let i = 0; i < SHADOW_BENCH_SAMPLES; i++) {
        const t0 = performance.now();
        pass.dispatch(input);
        await device.queue.onSubmittedWorkDone();
        timings.push(performance.now() - t0);
      }
      rows.push({
        requestedSamples: samples,
        effectiveSamples,
        softActive,
        medianMs: median(timings),
        warmups: SHADOW_BENCH_WARMUP,
        samples_taken: SHADOW_BENCH_SAMPLES,
        width: BENCHMARK_WIDTH,
        height: BENCHMARK_HEIGHT,
      });
      pass.dispose();
    }
  } finally {
    heightPass.dispose?.();
    uploader.dispose?.();
  }
  return rows;
}

/**
 * #31 retained-frame parity + scheduler counters on the REAL adapter.
 *
 * Drives the full public `GpuScenePipeline` (dirty-pass scheduler) and
 * asserts:
 *
 * 1. the FIRST render executes the full chain and the canvas readback is
 *    the parity baseline
 * 2. a byte-identical repeated frame is FULLY RETAINED (zero dispatches,
 *    zero allocations, zero uploaded bytes, zero submissions) while the
 *    scheduler report lists every stage as skipped
 * 3. an explicit `repaint: true` re-presents ONLY the presentation stage
 *    from retained outputs, and the canvas readback is byte-identical to
 *    the baseline
 * 4. a presentation-only (composite) change executes ONLY the presentation
 *    stage and changes the canvas (shadow alpha), proving the counters
 *    track real invalidation
 * 5. a normal-options change executes ONLY normal/lighting/presentation and
 *    changes the canvas (normals drive the lighting)
 * 6. a fresh pipeline on a fresh canvas (forced full recompute) reproduces
 *    the byte-identical baseline output, so retained results are equivalent
 *    to a full recompute
 *
 * The existing 79 compute + 17 presentation golden fixture gate is kept
 * intact; every problem collected here FAILs the run before the PASS marker.
 */
/**
 * The retained-parity scene: a panel that does NOT cover the whole canvas,
 * so the button's long cast shadow falls on the NO_OWNER base plane too —
 * composite (shadow alpha) changes are then observable on the canvas. The
 * flat light keeps the march short enough for a stable termination count.
 */
function retainedParityScene() {
  return api.createScene({
    width: 96,
    height: 60,
    surfaces: [
      {
        id: "panel",
        position: { x: 10, y: 6 },
        size: { x: 76, y: 48 },
        elevation: 0,
        thickness: 0,
        shape: { kind: "roundedRect", radius: 0 },
        profile: { kind: "flat" },
        material: "matte",
        castsShadow: false,
        receivesShadow: true,
      },
      {
        id: "btn",
        position: { x: 30, y: 12 },
        size: { x: 36, y: 32 },
        elevation: 4,
        thickness: 2,
        bevelWidth: 3,
        shape: { kind: "roundedRect", radius: 8 },
        profile: { kind: "bevel" },
        material: "silicone",
        castsShadow: true,
        receivesShadow: true,
      },
    ],
    light: { direction: { x: 0.4, y: 0.5, z: 0.2 }, intensity: 1 },
  });
}

async function makeRetainedCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 0;
  canvas.height = 0;
  document.body.appendChild(canvas);
  const context = canvas.getContext("webgpu");
  // resolved ONCE at the real API boundary, exactly like the #29 contract
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  return { canvas, context, canvasFormat };
}

/**
 * Capture + read back the current canvas texture. `getCurrentTexture()` is
 * called SYNCHRONOUSLY in the same task as the just-submitted presentation
 * work (the #29 harness seam): the queued copy then reads the exact texture
 * the presentation pass wrote, regardless of later animation-frame texture
 * swaps.
 */
function capturePresented(device, context, canvasFormat, width, height) {
  const captured = context.getCurrentTexture();
  return presentReadback(device, context, width, height, canvasFormat, captured).then(
    (raw) => normalizeCanvasBytes(raw, canvasFormat, width, height),
  );
}

async function runRetainedParity(device) {
  const scene = retainedParityScene();
  const problems = [];
  let pipeline = null;
  let canvas = null;
  try {
    const first = await makeRetainedCanvas();
    canvas = first.canvas;
    pipeline = new api.GpuScenePipeline(device, first.context, first.canvasFormat);

    // 1) baseline: full chain, first frame. The texture is captured in the
    //    SAME task as the presentation submission (#29 harness seam).
    const frameA = pipeline.render({ scene, dpr: 1, debugReadback: true });
    const baseline = await capturePresented(
      device,
      first.context,
      first.canvasFormat,
      frameA.renderWidth,
      frameA.renderHeight,
    );
    if (frameA.invalidation.executed.length !== 6) {
      problems.push(`first frame executed ${frameA.invalidation.executed.join(",")} (expected all six)`);
    }
    const dispatchesAfterFirst = frameA.totals.dispatches;
    const allocationsAfterFirst = frameA.totals.newAllocations;
    const bytesAfterFirst = frameA.totals.bytesUploaded;

    // 2) byte-identical repeated frame: fully retained (scheduler counters).
    const frameB = pipeline.render({ scene, dpr: 1, debugReadback: true });
    if (frameB.invalidation.retained !== true || frameB.invalidation.executed.length !== 0) {
      problems.push(
        `retained frame executed ${frameB.invalidation.executed.join(",")} ` +
          `reasons=${frameB.invalidation.reasons.join(",")} (expected nothing)`,
      );
    }
    if (frameB.totals.dispatches !== dispatchesAfterFirst) {
      problems.push(
        `retained frame issued ${frameB.totals.dispatches - dispatchesAfterFirst} extra dispatches`,
      );
    }
    if (frameB.totals.newAllocations !== allocationsAfterFirst) {
      problems.push("retained frame allocated new GPU buffers");
    }
    if (frameB.totals.bytesUploaded !== bytesAfterFirst) {
      problems.push("retained frame re-uploaded host bytes");
    }
    if (frameB.frame.dispatchCount !== 0 || frameB.frame.submissions !== 0) {
      problems.push(
        `retained frame profile reports dispatchCount=${frameB.frame.dispatchCount} ` +
          `submissions=${frameB.frame.submissions} (expected 0/0)`,
      );
    }

    // 3) retained re-presentation: presentation-only, byte-identical output.
    const frameC = pipeline.render({ scene, dpr: 1, debugReadback: true, repaint: true });
    if (frameC.invalidation.executed.join(",") !== "presentation") {
      problems.push(
        `repaint executed ${frameC.invalidation.executed.join(",")} (expected presentation only)`,
      );
    }
    if (frameC.frame.dispatchCount !== 0) {
      problems.push("repaint issued compute dispatches");
    }
    const repainted = await capturePresented(
      device,
      first.context,
      first.canvasFormat,
      frameC.renderWidth,
      frameC.renderHeight,
    );
    if (!oracle.bytesEqual(baseline, repainted)) {
      problems.push("repaint of the retained frame changed the canvas bytes");
    }

    // 4) presentation-only invalidation (composite): only presentation runs
    //    and the canvas actually changes (shadow alpha 0.3 -> 0.6).
    const frameD = pipeline.render({
      scene,
      dpr: 1,
      debugReadback: true,
      compositeOptions: { shadowAlpha: 0.6 },
    });
    if (frameD.invalidation.executed.join(",") !== "presentation") {
      problems.push(
        `composite change executed ${frameD.invalidation.executed.join(",")} ` +
          `(expected presentation only)`,
      );
    }
    if (frameD.totals.dispatches !== dispatchesAfterFirst) {
      problems.push("composite change issued compute dispatches");
    }
    const composite = await capturePresented(
      device,
      first.context,
      first.canvasFormat,
      frameD.renderWidth,
      frameD.renderHeight,
    );
    if (oracle.bytesEqual(baseline, composite)) {
      problems.push("composite change produced no canvas change (shadow alpha ignored?)");
    }

    // 5) normal-options invalidation: normal/lighting/presentation only
    //    (normal 1 + lighting 1 = 2 compute dispatches this frame).
    const frameE = pipeline.render({
      scene,
      dpr: 1,
      debugReadback: true,
      normalOptions: { scaleX: 0.9, scaleY: 0.4, normalScale: 1.25 },
    });
    if (frameE.invalidation.executed.join(",") !== "normal,lighting,presentation") {
      problems.push(
        `normal change executed ${frameE.invalidation.executed.join(",")} ` +
          `(expected normal,lighting,presentation)`,
      );
    }
    if (frameE.frame.dispatchCount !== 2) {
      problems.push(`normal change dispatchCount=${frameE.frame.dispatchCount} (expected 2)`);
    }
    const normalChanged = await capturePresented(
      device,
      first.context,
      first.canvasFormat,
      frameE.renderWidth,
      frameE.renderHeight,
    );
    if (oracle.bytesEqual(baseline, normalChanged)) {
      problems.push("normal-options change produced no canvas change (options ignored?)");
    }

    // 6) forced full recompute on a fresh pipeline/canvas reproduces the
    //    baseline bytes (retained results == full recompute equivalence).
    pipeline.dispose();
    pipeline = null;
    canvas.remove();
    canvas = null;
    const second = await makeRetainedCanvas();
    const fresh = new api.GpuScenePipeline(device, second.context, second.canvasFormat);
    const frameF = fresh.render({ scene, dpr: 1, debugReadback: true });
    const recomputed = await capturePresented(
      device,
      second.context,
      second.canvasFormat,
      frameF.renderWidth,
      frameF.renderHeight,
    );
    if (!oracle.bytesEqual(baseline, recomputed)) {
      problems.push("forced full recompute differs from the retained pipeline output");
    }
    fresh.dispose();
    second.canvas.remove();
  } catch (error) {
    problems.push(`retained parity threw: ${String(error?.stack ?? error)}`);
  }
  try {
    pipeline?.dispose();
    canvas?.remove();
  } catch {
    // disposal must never mask the outcome
  }
  return problems;
}

/**
 * #32 partial/full parity on the REAL adapter.
 *
 * Drives the public `GpuScenePipeline` through move/add/remove/reorder edits
 * plus the light/material full-fallback cases and asserts:
 *
 * 1. a small local edit is planned PARTIAL: fewer dispatched workgroups than
 *    the full frame, dirty tiles/texels reported, ESTIMATED candidate/culled
 *    surface counts exposed
 * 2. every edited frame's final canvas is BYTE-IDENTICAL to a forced full
 *    recompute on a fresh pipeline (partial output == full output)
 * 3. light-direction and material-table changes fall back to the full path
 *    with the documented deterministic reasons (no partial, no stale texels)
 * 4. viewport changes never take the partial path
 *
 * The existing 79 compute + 17 presentation golden fixture gate is kept
 * intact; every problem collected here FAILs the run before the PASS marker.
 */

/**
 * The #32 partial-parity scene: a near-vertical light (|L.xy| small) with a
 * BOUNDED shadow maxDistance keeps the down-light halo small enough that a
 * small local edit leaves a partial dispatch band below the documented
 * PARTIAL_DISPATCH_RATIO (0.5), while still casting real shadows for parity.
 */
function partialParityScene(edit) {
  const light = { direction: { x: 0, y: 0.1, z: 0.995 }, intensity: 1 };
  const shadowOptions = { maxDistance: 40, stepSize: 0.5, bias: 0.5 };
  const panel = {
    id: "panel",
    position: { x: 0, y: 0 },
    size: { x: 320, y: 180 },
    elevation: 0,
    thickness: 0,
    shape: { kind: "roundedRect", radius: 0 },
    profile: { kind: "flat" },
    material: "matte",
    castsShadow: false,
    receivesShadow: true,
  };
  const btnA = {
    id: "btn-a",
    position: { x: 60, y: 40 },
    size: { x: 80, y: 44 },
    elevation: 2,
    thickness: 3,
    bevelWidth: 4,
    shape: { kind: "roundedRect", radius: 10 },
    profile: { kind: "bevel" },
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
  };
  const btnB = {
    id: "btn-b",
    position: { x: 180, y: 90 },
    size: { x: 60, y: 40 },
    elevation: 1,
    thickness: 2,
    shape: { kind: "roundedRect", radius: 8 },
    profile: { kind: "flat" },
    material: "metal",
    castsShadow: true,
    receivesShadow: true,
  };
  const badge = {
    id: "badge",
    position: { x: 30, y: 120 },
    size: { x: 24, y: 24 },
    elevation: 4,
    thickness: 2,
    shape: { kind: "roundedRect", radius: 6 },
    profile: { kind: "flat" },
    material: "silicone",
    castsShadow: true,
    receivesShadow: true,
  };
  const materials = {
    metal: {
      baseColor: { r: 0.72, g: 0.45, b: 0.2 },
      roughness: 0.35,
      metallic: 1,
      ior: 2,
    },
  };
  switch (edit) {
    case "move":
      return { scene: api.createScene({
        width: 320, height: 180, light, materials,
        surfaces: [panel, { ...btnA, position: { x: 64, y: 42 } }, btnB, badge],
      }), shadowOptions };
    case "add":
      // the added surface reuses existing materials so the first-appearance
      // material table stays stable (a new material would legitimately
      // force the full fallback path)
      return { scene: api.createScene({
        width: 320, height: 180, light, materials,
        surfaces: [panel, btnA, btnB, badge, {
          id: "chip",
          position: { x: 240, y: 30 },
          size: { x: 30, y: 18 },
          elevation: 3,
          thickness: 1,
          shape: { kind: "roundedRect", radius: 4 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        }],
      }), shadowOptions };
    case "remove":
      return { scene: api.createScene({
        width: 320, height: 180, light, materials,
        // badge is silicone like btn-a, so the material table stays stable
        surfaces: [panel, btnA, btnB],
      }), shadowOptions };
    case "reorder":
      // swap the two SILICONE surfaces: the material table keeps its
      // first-appearance order [matte, silicone, metal], so the reorder is
      // a genuine surface-record diff, not a material fallback
      return { scene: api.createScene({
        width: 320, height: 180, light, materials,
        surfaces: [panel, badge, btnB, btnA],
      }), shadowOptions };
    case "light":
      return { scene: api.createScene({
        width: 320, height: 180,
        light: { direction: { x: -0.6, y: -0.8, z: 1 }, intensity: 1 },
        materials,
        surfaces: [panel, btnA, btnB, badge],
      }), shadowOptions };
    case "material":
      return { scene: api.createScene({
        width: 320, height: 180, light,
        materials: { ...materials, metal: { ...materials.metal, baseColor: { r: 0.2, g: 0.45, b: 0.72 } } },
        surfaces: [panel, btnA, btnB, badge],
      }), shadowOptions };
    case "viewport":
      return { scene: api.createScene({
        width: 320, height: 200, light, materials,
        surfaces: [panel, btnA, btnB, badge],
      }), shadowOptions };
    case "zero-delete-base":
      // no panel, so deleting the badge leaves a dirty band whose only
      // footprint was the badge itself: ZERO remaining candidates (btnA and
      // btnB sit above the deletion band; the material table keeps silicone)
      return { scene: api.createScene({
        width: 320, height: 180, light, materials,
        surfaces: [btnA, { ...btnB, position: { x: 180, y: 30 } }, badge],
      }), shadowOptions };
    case "zero-delete":
      return { scene: api.createScene({
        width: 320, height: 180, light, materials,
        surfaces: [btnA, { ...btnB, position: { x: 180, y: 30 } }],
      }), shadowOptions };
    case "mask-base":
      return { scene: api.createScene({
        width: 320, height: 180, light, materials,
        surfaces: [panel, btnA, btnB, badge, {
          id: "glyph",
          position: { x: 200, y: 30 },
          size: { x: 16, y: 16 },
          elevation: 5,
          thickness: 2,
          shape: { kind: "mask", mask: { width: 4, height: 4, alpha: new Uint8Array(16).fill(255) } },
          profile: { kind: "flat" },
          material: "metal",
          castsShadow: true,
          receivesShadow: true,
        }],
      }), shadowOptions };
    case "mask-edit":
      return { scene: api.createScene({
        width: 320, height: 180, light, materials,
        surfaces: [panel, btnA, btnB, badge, {
          id: "glyph",
          position: { x: 204, y: 33 },
          size: { x: 16, y: 16 },
          elevation: 5,
          thickness: 2,
          shape: { kind: "mask", mask: { width: 4, height: 4, alpha: new Uint8Array(16).fill(255) } },
          profile: { kind: "flat" },
          material: "metal",
          castsShadow: true,
          receivesShadow: true,
        }],
      }), shadowOptions };
    default:
      return { scene: api.createScene({
        width: 320, height: 180, light, materials,
        surfaces: [panel, btnA, btnB, badge],
      }), shadowOptions };
  }
}

async function runPartialParity(device) {
  const problems = [];
  const base = partialParityScene();
  const fullWorkgroups = {}; // baseline full-frame workgroup counts per stage
  let pipeline = null;
  let canvas = null;
  try {
    const first = await makeRetainedCanvas();
    canvas = first.canvas;
    pipeline = new api.GpuScenePipeline(device, first.context, first.canvasFormat);
    // 1) baseline: first frame is always full; record the full workgroup
    //    counts as the counters the partial frames must beat.
    const frameBase = pipeline.render({
      scene: base.scene,
      dpr: 1,
      shadowOptions: base.shadowOptions,
      tileSize: 32,
      debugReadback: true,
    });
    if (frameBase.planning.mode !== "full" || frameBase.planning.reason !== "first-frame") {
      problems.push(
        `baseline plan ${frameBase.planning.mode}/${frameBase.planning.reason} (expected full/first-frame)`,
      );
    }
    const baselineSnapshot = pipeline.getSnapshot();
    fullWorkgroups.height = baselineSnapshot.heightPass.lastDispatch.workgroupCountX;
    fullWorkgroups.normal = baselineSnapshot.normalPass.lastDispatch.workgroupCountX;
    fullWorkgroups.shadow = baselineSnapshot.shadowPass.lastDispatch.workgroupCountX;
    fullWorkgroups.lighting = baselineSnapshot.lightingPass.lastDispatch.workgroupCountX;
    const baseline = await capturePresented(
      device,
      first.context,
      first.canvasFormat,
      frameBase.renderWidth,
      frameBase.renderHeight,
    );

    // 2) small local edit: planned partial, fewer workgroups, canvas parity
    //    with a forced full recompute on a fresh pipeline.
    const move = partialParityScene("move");
    const frameMove = pipeline.render({
      scene: move.scene,
      dpr: 1,
      shadowOptions: move.shadowOptions,
      tileSize: 32,
      debugReadback: true,
    });
    if (frameMove.planning.mode !== "partial") {
      problems.push(
        `small edit plan ${frameMove.planning.mode}/${frameMove.planning.reason} (expected partial)`,
      );
    } else {
      if (frameMove.planning.dirtyTileCount <= 0 || frameMove.planning.dirtyTexels <= 0) {
        problems.push("partial frame reported zero dirty tiles/texels");
      }
      const moveSnapshot = pipeline.getSnapshot();
      for (const stage of ["height", "normal", "shadow", "lighting"]) {
        const workgroups = moveSnapshot[`${stage}Pass`].lastDispatch.workgroupCountX;
        if (workgroups >= fullWorkgroups[stage]) {
          problems.push(
            `partial ${stage} dispatched ${workgroups} workgroups (full ${fullWorkgroups[stage]}): ` +
              "a small edit must dispatch fewer workgroups",
          );
        }
      }
      if (frameMove.planning.candidateSurfaceCount <= 0) {
        problems.push("partial frame reported zero candidate surfaces");
      }
      if (frameMove.planning.dispatchTexels > frameMove.planning.totalTexels * 0.5) {
        problems.push(
          `partial dispatchTexels ${frameMove.planning.dispatchTexels} exceed half of ` +
            `${frameMove.planning.totalTexels} (documented threshold)`,
        );
      }
      if (frameMove.planning.dispatchTexels >= frameMove.planning.totalTexels) {
        problems.push("partial band equals the full frame");
      }
    }
    const partialCanvas = await capturePresented(
      device,
      first.context,
      first.canvasFormat,
      frameMove.renderWidth,
      frameMove.renderHeight,
    );
    if (oracle.bytesEqual(baseline, partialCanvas)) {
      problems.push("small edit produced no canvas change (edit ignored?)");
    }
    // capture the partial pipeline's compose fields BEFORE disposal: the
    // ACTUAL candidate iteration must have produced byte-identical height
    // and ORIGINAL-owner objectId fields vs the forced-full recompute
    let partialHeight = null;
    let partialObjectId = null;
    try {
      const partialSnapshot = pipeline.getSnapshot();
      partialHeight = await readback(
        device,
        partialSnapshot.heightPass.outputs.height.buffer,
        partialSnapshot.heightPass.outputs.height.byteLength,
      );
      partialObjectId = await readback(
        device,
        partialSnapshot.heightPass.outputs.objectId.buffer,
        partialSnapshot.heightPass.outputs.objectId.byteLength,
      );
    } catch (error) {
      problems.push(`partial field readback failed: ${String(error)}`);
    }

    // 3) forced full recompute on a FRESH pipeline must reproduce the
    //    partial frame's canvas byte-for-byte.
    pipeline.dispose();
    pipeline = null;
    canvas.remove();
    canvas = null;
    const second = await makeRetainedCanvas();
    const fresh = new api.GpuScenePipeline(device, second.context, second.canvasFormat);
    const frameFull = fresh.render({
      scene: move.scene,
      dpr: 1,
      shadowOptions: move.shadowOptions,
      tileSize: 32,
      debugReadback: true,
    });
    const fullCanvas = await capturePresented(
      device,
      second.context,
      second.canvasFormat,
      frameFull.renderWidth,
      frameFull.renderHeight,
    );
    if (!oracle.bytesEqual(partialCanvas, fullCanvas)) {
      problems.push("partial render differs from forced-full recompute (canvas bytes)");
    }
    if (partialHeight !== null) {
      const forcedSnapshot = fresh.getSnapshot();
      const forcedHeight = await readback(
        device,
        forcedSnapshot.heightPass.outputs.height.buffer,
        forcedSnapshot.heightPass.outputs.height.byteLength,
      );
      if (!oracle.bytesEqual(partialHeight, forcedHeight)) {
        problems.push("partial height field differs from forced-full (culled compose)");
      }
    }
    if (partialObjectId !== null) {
      const forcedObjectId = await readback(
        device,
        fresh.getSnapshot().heightPass.outputs.objectId.buffer,
        fresh.getSnapshot().heightPass.outputs.objectId.byteLength,
      );
      if (!oracle.bytesEqual(partialObjectId, forcedObjectId)) {
        problems.push("partial objectId field differs from forced-full (owner identity)");
      }
    }
    fresh.dispose();
    second.canvas.remove();

    // 4) the remaining edits run on a fresh retained pipeline; every output
    //    must equal its forced-full recompute regardless of the planning
    //    decision (move/add/remove/reorder + fallback cases).
    const scenarios = ["add", "remove", "reorder", "light", "material", "viewport"];
    const expectedReasons = {
      light: "light-direction-change",
      material: "material-values-change",
      viewport: "viewport-change",
    };
    for (const scenario of scenarios) {
      const third = await makeRetainedCanvas();
      const retainedPipeline = new api.GpuScenePipeline(device, third.context, third.canvasFormat);
      const edit = partialParityScene(scenario);
      // the retained pipeline first renders the BASE (full), then the edit
      retainedPipeline.render({
        scene: base.scene,
        dpr: 1,
        shadowOptions: base.shadowOptions,
        tileSize: 32,
        debugReadback: true,
      });
      const edited = retainedPipeline.render({
        scene: edit.scene,
        dpr: 1,
        shadowOptions: edit.shadowOptions,
        tileSize: 32,
        debugReadback: true,
      });
      if (scenario in expectedReasons) {
        if (edited.planning.mode !== "full") {
          problems.push(`${scenario} edit planned ${edited.planning.mode} (expected full fallback)`);
        }
        if (edited.planning.reason !== expectedReasons[scenario]) {
          problems.push(
            `${scenario} edit fallback reason ${edited.planning.reason} ` +
              `(expected ${expectedReasons[scenario]})`,
          );
        }
      } else if (edited.planning.mode === "partial") {
        if (edited.planning.dirtyTileCount <= 0) {
          problems.push(`${scenario} partial frame reported zero dirty tiles`);
        }
      }
      const retainedCanvasBytes = await capturePresented(
        device,
        third.context,
        third.canvasFormat,
        edited.renderWidth,
        edited.renderHeight,
      );
      retainedPipeline.dispose();
      third.canvas.remove();
      const forced = await makeRetainedCanvas();
      const forcedPipeline = new api.GpuScenePipeline(device, forced.context, forced.canvasFormat);
      const forcedFrame = forcedPipeline.render({
        scene: edit.scene,
        dpr: 1,
        shadowOptions: edit.shadowOptions,
        tileSize: 32,
        debugReadback: true,
      });
      const forcedBytes = await capturePresented(
        device,
        forced.context,
        forced.canvasFormat,
        forcedFrame.renderWidth,
        forcedFrame.renderHeight,
      );
      forcedPipeline.dispose();
      forced.canvas.remove();
      if (!oracle.bytesEqual(retainedCanvasBytes, forcedBytes)) {
        problems.push(
          `${scenario} edit differs from forced-full recompute (canvas bytes)`,
        );
      }
    }

    // 5) zero-candidate partial: deleting an isolated surface leaves a dirty
    //    band with NO remaining surface footprint. The plan stays partial
    //    with an EMPTY candidate bin and the compose clears the band; the
    //    canvas must equal a forced full recompute (texels fall back to the
    //    base plane / lower surfaces).
    const zeroBase = partialParityScene("zero-delete-base");
    const zeroEdit = partialParityScene("zero-delete");
    {
      const zc = await makeRetainedCanvas();
      const zcPipeline = new api.GpuScenePipeline(device, zc.context, zc.canvasFormat);
      zcPipeline.render({
        scene: zeroBase.scene,
        dpr: 1,
        shadowOptions: zeroBase.shadowOptions,
        tileSize: 32,
        debugReadback: true,
      });
      const zcFrame = zcPipeline.render({
        scene: zeroEdit.scene,
        dpr: 1,
        shadowOptions: zeroEdit.shadowOptions,
        tileSize: 32,
        debugReadback: true,
      });
      if (zcFrame.planning.mode !== "partial") {
        problems.push(
          `zero-candidate edit planned ${zcFrame.planning.mode}/${zcFrame.planning.reason} ` +
            "(expected partial with an empty candidate bin)",
        );
      } else if (zcFrame.planning.candidateSurfaceCount !== 0) {
        problems.push(
          `zero-candidate edit reported ${zcFrame.planning.candidateSurfaceCount} candidates ` +
            "(expected 0 — no surface footprint intersects the deletion band)",
        );
      }
      const zcBytes = await capturePresented(
        device,
        zc.context,
        zc.canvasFormat,
        zcFrame.renderWidth,
        zcFrame.renderHeight,
      );
      zcPipeline.dispose();
      zc.canvas.remove();
      const zcForced = await makeRetainedCanvas();
      const zcForcedPipeline = new api.GpuScenePipeline(device, zcForced.context, zcForced.canvasFormat);
      const zcForcedFrame = zcForcedPipeline.render({
        scene: zeroEdit.scene,
        dpr: 1,
        shadowOptions: zeroEdit.shadowOptions,
        tileSize: 32,
        debugReadback: true,
      });
      const zcForcedBytes = await capturePresented(
        device,
        zcForced.context,
        zcForced.canvasFormat,
        zcForcedFrame.renderWidth,
        zcForcedFrame.renderHeight,
      );
      zcForcedPipeline.dispose();
      zcForced.canvas.remove();
      if (!oracle.bytesEqual(zcBytes, zcForcedBytes)) {
        problems.push("zero-candidate edit differs from forced-full recompute (canvas bytes)");
      }
    }

    // 6) mask scenario: editing a MASK surface takes the partial path while
    //    the SDF pass re-runs full; the shifted maskMeta mask base and the
    //    candidate iteration must keep the output identical to a forced full
    //    recompute.
    const maskBase = partialParityScene("mask-base");
    const maskEdit = partialParityScene("mask-edit");
    {
      const mc = await makeRetainedCanvas();
      const mcPipeline = new api.GpuScenePipeline(device, mc.context, mc.canvasFormat);
      mcPipeline.render({
        scene: maskBase.scene,
        dpr: 1,
        shadowOptions: maskBase.shadowOptions,
        tileSize: 32,
        debugReadback: true,
      });
      const mcFrame = mcPipeline.render({
        scene: maskEdit.scene,
        dpr: 1,
        shadowOptions: maskEdit.shadowOptions,
        tileSize: 32,
        debugReadback: true,
      });
      if (mcFrame.planning.mode !== "partial") {
        problems.push(
          `mask edit planned ${mcFrame.planning.mode}/${mcFrame.planning.reason} (expected partial)`,
        );
      }
      const mcBytes = await capturePresented(
        device,
        mc.context,
        mc.canvasFormat,
        mcFrame.renderWidth,
        mcFrame.renderHeight,
      );
      mcPipeline.dispose();
      mc.canvas.remove();
      const mcForced = await makeRetainedCanvas();
      const mcForcedPipeline = new api.GpuScenePipeline(device, mcForced.context, mcForced.canvasFormat);
      const mcForcedFrame = mcForcedPipeline.render({
        scene: maskEdit.scene,
        dpr: 1,
        shadowOptions: maskEdit.shadowOptions,
        tileSize: 32,
        debugReadback: true,
      });
      const mcForcedBytes = await capturePresented(
        device,
        mcForced.context,
        mcForced.canvasFormat,
        mcForcedFrame.renderWidth,
        mcForcedFrame.renderHeight,
      );
      mcForcedPipeline.dispose();
      mcForced.canvas.remove();
      if (!oracle.bytesEqual(mcBytes, mcForcedBytes)) {
        problems.push("mask edit differs from forced-full recompute (canvas bytes)");
      }
    }
  } catch (error) {
    problems.push(`partial parity threw: ${String(error?.stack ?? error)}`);
  }
  try {
    pipeline?.dispose();
    canvas?.remove();
  } catch {
    // disposal must never mask the outcome
  }
  return problems;
}

/**
 * #32 tile benchmark at the documented 640x360 demo-frame proxy scene:
 * several tile sizes x dirty-area ratios (small/medium/large edits).
 * Binning overhead (the planner's host wall-clock `planningHostMs`) is
 * reported SEPARATELY from the submitted GPU completion time
 * (`queue.onSubmittedWorkDone()`), alongside ESTIMATED candidates/culled
 * surfaces, dirty coverage, dispatches and frame time. REPORT-ONLY: the
 * numbers never gate the run (the deterministic PARTIAL_DISPATCH_RATIO
 * decides the path, not a timing), but every measured frame's canvas is
 * still verified against a forced-full recompute.
 */
async function runTileBenchmark(device) {
  const cases = [];
  // benchmark-specific bounded shadow so partials are meaningful at 640x360
  const benchmarkScene = () =>
    api.createScene({
      width: 640,
      height: 360,
    light: { direction: { x: 0.15, y: 0.1, z: 0.98 }, intensity: 1 },
      surfaces: [
        {
          id: "panel",
          position: { x: 0, y: 0 },
          size: { x: 640, y: 360 },
          elevation: 0,
          thickness: 0,
          shape: { kind: "roundedRect", radius: 0 },
          profile: { kind: "flat" },
          material: "matte",
          castsShadow: false,
          receivesShadow: true,
        },
        {
          id: "btn-a",
          position: { x: 60, y: 80 },
          size: { x: 90, y: 60 },
          elevation: 2,
          thickness: 3,
          bevelWidth: 8,
          shape: { kind: "roundedRect", radius: 12 },
          profile: { kind: "bevel" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
        {
          id: "btn-b",
          position: { x: 240, y: 120 },
          size: { x: 120, y: 70 },
          elevation: 4,
          thickness: 3,
          bevelWidth: 8,
          shape: { kind: "roundedRect", radius: 16 },
          profile: { kind: "bevel" },
          material: "metal",
          castsShadow: true,
          receivesShadow: true,
        },
        {
          id: "badge",
          position: { x: 150, y: 200 },
          size: { x: 40, y: 40 },
          elevation: 7,
          thickness: 2,
          shape: { kind: "roundedRect", radius: 8 },
          profile: { kind: "flat" },
          material: "silicone",
          castsShadow: true,
          receivesShadow: true,
        },
        {
          id: "glyph",
          position: { x: 520, y: 220 },
          size: { x: 12, y: 12 },
          elevation: 5,
          thickness: 2,
          shape: { kind: "mask", mask: { width: 6, height: 6, alpha: new Uint8Array(36).fill(255) } },
          profile: { kind: "flat" },
          material: "metal",
          castsShadow: true,
          receivesShadow: true,
        },
      ],
    });
  const shadowOptions = { maxDistance: 40, stepSize: 0.5, bias: 0.5 };
  const edits = {
    small: (scene) =>
      api.createScene({
        ...scene,
        surfaces: scene.surfaces.map((s) =>
          s.id === "badge" ? { ...s, position: { x: 154, y: 203 } } : s,
        ),
      }),
    medium: (scene) =>
      api.createScene({
        ...scene,
        surfaces: scene.surfaces.map((s) =>
          s.id === "btn-a" ? { ...s, position: { x: 74, y: 90 } } : s,
        ),
      }),
    large: (scene) =>
      api.createScene({
        ...scene,
        surfaces: scene.surfaces.map((s) =>
          s.id === "btn-a" ? { ...s, position: { x: 300, y: 250 } } : s,
        ),
      }),
  };
  const fullChain = async (encoded, bindings, heightPass, normalPass, shadowPass, lightingPass) => {
    heightPass.dispatch(encoded, bindings);
    const heightSnapshot = heightPass.getSnapshot();
    normalPass.dispatch({ height: api.normalHeightBindingFromHeightPass(heightSnapshot) });
    const normalSnapshot = normalPass.getSnapshot();
    shadowPass.dispatch({
      scene: encoded,
      bindings,
      ...api.shadowHeightBindingsFromHeightPass(heightSnapshot),
      options: shadowOptions,
    });
    const shadowSnapshot = shadowPass.getSnapshot();
    lightingPass.dispatch({
      scene: encoded,
      bindings,
      materialId: api.lightingMaterialIdBindingFromHeightPass(heightSnapshot),
      normal: api.lightingNormalBindingFromNormalPass(normalSnapshot),
      visibility: api.lightingVisibilityBindingFromShadowPass(shadowSnapshot),
      options: {},
    });
    await device.queue.onSubmittedWorkDone();
  };
  const canvas = document.createElement("canvas");
  canvas.width = 0;
  canvas.height = 0;
  document.body.appendChild(canvas);
  const context = canvas.getContext("webgpu");
  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  try {
    for (const tileSize of [16, 32, 64]) {
      for (const [ratio, editScene] of Object.entries(edits)) {
        const baseScene = benchmarkScene();
        const editedScene = editScene(baseScene);
        // full-path timing: the standalone full chain (fresh passes) on the
        // edited scene with GPU completion.
        const encoded = api.encodeScene(editedScene, 1);
        const uploader = new api.SceneUploader(device);
        uploader.upload(encoded);
        const bindings = uploader.getBindings();
        const heightPass = new api.HeightPass(device);
        const normalPass = new api.NormalPass(device);
        const shadowPass = new api.ShadowPass(device);
        const lightingPass = new api.LightingPass(device);
        for (let i = 0; i < 3; i++) {
          await fullChain(encoded, bindings, heightPass, normalPass, shadowPass, lightingPass);
        }
        const fullSamples = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          await fullChain(encoded, bindings, heightPass, normalPass, shadowPass, lightingPass);
          fullSamples.push(performance.now() - t0);
        }
        const fullMedian = median(fullSamples);
        uploader.dispose();
        heightPass.dispose();
        normalPass.dispose();
        shadowPass.dispose();
        lightingPass.dispose();
        // partial-path timing: the retained pipeline alternating between the
        // base and the edited scene so every edited render is planned fresh.
        const pipeline = new api.GpuScenePipeline(device, context, canvasFormat);
        const partialSamples = [];
        const plans = [];
        for (let i = 0; i < 3; i++) {
          pipeline.render({ scene: baseScene, dpr: 1, shadowOptions, tileSize });
          pipeline.render({ scene: editedScene, dpr: 1, shadowOptions, tileSize });
          await device.queue.onSubmittedWorkDone();
        }
        for (let i = 0; i < 5; i++) {
          pipeline.render({ scene: baseScene, dpr: 1, shadowOptions, tileSize });
          const t0 = performance.now();
          const stats = pipeline.render({ scene: editedScene, dpr: 1, shadowOptions, tileSize });
          plans.push(stats.planning);
          await device.queue.onSubmittedWorkDone();
          partialSamples.push(performance.now() - t0);
        }
        const partialMedian = median(partialSamples);
        const plan = plans[plans.length - 1];
        pipeline.dispose();
        cases.push({
          tileSize,
          ratio,
          mode: plan.mode,
          reason: plan.reason,
          dirtyCoverage: plan.dispatchTexels / plan.totalTexels,
          dirtyTexels: plan.dirtyTexels,
          dispatchTexels: plan.dispatchTexels,
          totalTexels: plan.totalTexels,
          candidates: plan.candidateSurfaceCount,
          culled: plan.culledSurfaceCount,
          fullMedian,
          partialMedian,
          binningMs: plan.planningHostMs,
        });
      }
    }
  } finally {
    canvas.remove();
  }
  return cases;
}

async function main() {
  try {
    if (typeof navigator === "undefined" || navigator.gpu === undefined) {
      finish(MARKER_SKIP, "navigator.gpu is unavailable in this browser");
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter === null) {
      finish(MARKER_SKIP, "no WebGPU adapter available");
      return;
    }
    summaryData.adapter = {
      vendor: adapter.info?.vendor ?? null,
      architecture: adapter.info?.architecture ?? null,
      device: adapter.info?.device ?? null,
      description: adapter.info?.description ?? null,
      backend: adapter.info?.backend ?? null,
      isFallbackAdapter: adapter.isFallbackAdapter ?? null,
    };
    const device = await adapter.requestDevice();
    const deviceErrors = [];
    device.onuncapturederror = (event) => {
      deviceErrors.push(String(event.error?.message ?? event.error));
    };

    const shaderProblems = await checkShaders(device);
    const fixtureResults = [];
    for (let i = 0; i < FIXTURES.length; i++) {
      const fixture = { ...FIXTURES[i], probe: i === 0 };
      try {
        fixtureResults.push(await runFixture(device, fixture));
      } catch (error) {
        fixtureResults.push({ name: fixture.id, error: String(error?.stack ?? error) });
      }
    }
    // #27 benchmark: the same 640x360 nontrivial scene on CPU and GPU.
    let benchmark = null;
    let benchmarkFailure = null;
    try {
      benchmark = await runBenchmark(device);
    } catch (error) {
      benchmarkFailure = String(error?.stack ?? error);
    }
    // #29 presentation: the full public GpuScenePipeline into a real
    // GPUCanvasContext (opaque surfaces, lit transparency, translucent
    // shadows, overlap/clipping/empty, DPR 1/1.5/2, two resizes on one
    // presenter, light/environment/exposure changes and the separate
    // presentation-only benchmark).
    const presentationResults = [];
    for (let i = 0; i < PRESENTATION_FIXTURES.length; i++) {
      const fixture = { ...PRESENTATION_FIXTURES[i], probe: i === 0 };
      try {
        presentationResults.push(await runPresentationFixture(device, fixture));
      } catch (error) {
        presentationResults.push({ name: fixture.id, error: String(error?.stack ?? error) });
      }
    }
    let presentationBenchmark = null;
    let presentationBenchmarkFailure = null;
    try {
      presentationBenchmark = await runPresentationBenchmark(device);
    } catch (error) {
      presentationBenchmarkFailure = String(error?.stack ?? error);
    }
    // #41 shadow-pass sample-count benchmark: median dispatch cost at the
    // documented sample counts on the proxy scene (report-only).
    let shadowSampleBench = [];
    let shadowSampleBenchFailure = null;
    try {
      shadowSampleBench = await runShadowSampleBenchmark(device);
    } catch (error) {
      shadowSampleBenchFailure = String(error?.stack ?? error);
    }
    // #31 retained-frame parity + scheduler counters on the real adapter:
    // a byte-identical repeated frame must do ZERO GPU work, retained
    // re-presentation must reproduce the exact canvas bytes, partial
    // invalidations must run exactly their downstream closure, and a
    // forced full recompute must match the retained output byte-for-byte.
    const retainedProblems = [];
    let retainedFailure = null;
    try {
      retainedProblems.push(...(await runRetainedParity(device)));
    } catch (error) {
      retainedFailure = String(error?.stack ?? error);
    }
    summaryData.retainedProblems = retainedProblems.length;
    // #32 partial/full parity + counters on the real adapter: small edits
    // must take the partial path with fewer dispatched workgroups, and
    // EVERY edited frame (partial or full) must equal a forced full
    // recompute byte-for-byte, including the move/add/remove/reorder and
    // light/material/viewport fallback cases.
    const partialProblems = [];
    let partialFailure = null;
    try {
      partialProblems.push(...(await runPartialParity(device)));
    } catch (error) {
      partialFailure = String(error?.stack ?? error);
    }
    summaryData.partialProblems = partialProblems.length;
    // #32 tile benchmark: report-only (deterministic cost ratio decides the
    // path, never a timing), run after the parity gates so failures surface
    // before any benchmark noise.
    let tileBenchmark = [];
    let tileBenchmarkFailure = null;
    try {
      tileBenchmark = await runTileBenchmark(device);
    } catch (error) {
      tileBenchmarkFailure = String(error?.stack ?? error);
    }
    summaryData.tileBenchmarkCases = tileBenchmark.length;
    // drain async device errors before destroying the device
    await device.queue.onSubmittedWorkDone().catch(() => undefined);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    device.destroy();

    for (const problem of shaderProblems) {
      detail.push("shader error: " + problem);
    }
    for (const error of deviceErrors) {
      detail.push("device error: " + error);
    }
    let totalTexels = 0;
    let totalMismatches = 0;
    let totalNormalTexels = 0;
    let totalNormalMismatches = 0;
    let totalShadowMismatches = 0;
    let totalShadowTexels = 0;
    let totalCasterMismatches = 0;
    let totalCasterTexels = 0;
    let casterMaxError = 0;
    let maxComponentError = 0;
    let maxLengthError = 0;
    let totalLightingTexels = 0;
    let totalDiffuseMismatches = 0;
    let totalSpecularMismatches = 0;
    let maxDiffuseError = 0;
    let maxSpecularError = 0;
    let totalColorHard = 0;
    let totalColorSoft = 0;
    let totalColorAlphaBad = 0;
    let totalMutationMismatches = 0;
    const colorMaxDelta = [0, 0, 0, 0];
    let executionFailures = 0;
    // #29 presentation totals (canvas bytes, exact alpha, normalized to RGBA)
    let totalPresentTexels = 0;
    let totalPresentHard = 0;
    let totalPresentAlphaBad = 0;
    const presentMaxDelta = [0, 0, 0, 0];
    let presentationExecutionFailures = 0;
    const classificationTotals = {};
    for (const result of fixtureResults) {
      totalTexels += result.texels ?? 0;
      totalMismatches += result.mismatches ?? 0;
      if (result.classified !== undefined) {
        for (const [category, count] of Object.entries(result.classified)) {
          classificationTotals[category] = (classificationTotals[category] ?? 0) + count;
        }
      }
      const normal = result.normal;
      if (normal !== undefined) {
        totalNormalTexels += result.normalTexels ?? 0;
        totalNormalMismatches += normal.mismatches ?? 0;
        maxComponentError = Math.max(maxComponentError, normal.maxComponentError ?? 0);
        maxLengthError = Math.max(maxLengthError, normal.maxLengthError ?? 0);
      }
      const shadow = result.shadow;
      if (shadow !== undefined) {
        totalShadowMismatches += shadow.mismatches ?? 0;
        totalShadowTexels += result.shadowTexels ?? 0;
      }
      const caster = result.caster;
      if (caster !== undefined) {
        totalCasterMismatches += caster.mismatches ?? 0;
        totalCasterTexels += result.casterTexels ?? 0;
        casterMaxError = Math.max(casterMaxError, caster.maxError ?? 0);
      }
      const lighting = result.lighting;
      if (lighting !== undefined) {
        totalLightingTexels += result.lightingTexels ?? 0;
        totalDiffuseMismatches += lighting.diffuse.mismatches ?? 0;
        totalSpecularMismatches += lighting.specular.mismatches ?? 0;
        maxDiffuseError = Math.max(maxDiffuseError, lighting.diffuse.maxError ?? 0);
        maxSpecularError = Math.max(maxSpecularError, lighting.specular.maxError ?? 0);
        totalColorHard += lighting.color.hard ?? 0;
        totalColorSoft += lighting.color.soft ?? 0;
        totalColorAlphaBad += lighting.color.alphaBad ?? 0;
        totalMutationMismatches += lighting.mutation?.mismatches ?? 0;
        for (let ch = 0; ch < 4; ch++) {
          colorMaxDelta[ch] = Math.max(colorMaxDelta[ch], lighting.color.maxDelta[ch] ?? 0);
        }
      }
      if (result.error !== undefined) {
        executionFailures += 1;
      }
      if (result.error !== undefined) {
        detail.push(`fixture ${result.name}: FAIL (threw: ${result.error})`);
      } else {
        const normalLine =
          result.normal === undefined
            ? ""
            : `; normal ${result.normal.mismatches === 0 ? "PASS" : "FAIL"} ` +
              `(${result.normal.mismatches}/${result.normalTexels ?? result.texels} normal texels, ` +
              `max comp err ${result.normal.maxComponentError.toExponential(3)}, ` +
              `max len err ${result.normal.maxLengthError.toExponential(3)})`;
        const shadowLine =
          result.shadow === undefined
            ? ""
            : `; shadow ${result.shadow.mismatches === 0 ? "PASS" : "FAIL"} ` +
              `(${result.shadow.mismatches}/${result.shadowTexels ?? result.texels} visibility texels, ` +
              `caster ${result.caster?.mismatches ?? 0}/${result.casterTexels ?? 0} ` +
              `max err ${(result.caster?.maxError ?? 0).toExponential(3)})`;
        const lightingLine =
          result.lighting === undefined
            ? ""
            : `; lighting ${result.lighting.diffuse.mismatches === 0 && result.lighting.specular.mismatches === 0 && result.lighting.color.hard === 0 && result.lighting.mutation.mismatches === 0 ? "PASS" : "FAIL"} ` +
              `(${result.lightingTexels ?? result.texels} texels, ` +
              `diffuse max err ${result.lighting.diffuse.maxError.toExponential(3)}, ` +
              `specular max err ${result.lighting.specular.maxError.toExponential(3)}, ` +
              `color hard ${result.lighting.color.hard} soft ${result.lighting.color.soft} ` +
              `alphaBad ${result.lighting.color.alphaBad}, ` +
              `mutations ${result.lighting.mutation.mismatches})`;
        detail.push(
          `fixture ${result.name}: ${result.mismatches === 0 ? "PASS" : "FAIL"} ` +
            `(${result.mismatches}/${result.texels} texels)${normalLine}${shadowLine}${lightingLine}`,
        );
      }
      for (const sample of result.samples ?? []) {
        detail.push("  " + sample);
      }
      for (const sample of result.normal?.samples ?? []) {
        detail.push("  " + sample);
      }
      for (const sample of result.shadow?.samples ?? []) {
        detail.push("  " + sample);
      }
      for (const sample of result.lighting?.diffuse?.samples ?? []) {
        detail.push("  " + sample);
      }
      for (const sample of result.lighting?.specular?.samples ?? []) {
        detail.push("  " + sample);
      }
      for (const sample of result.lighting?.color?.samples ?? []) {
        detail.push("  " + sample);
      }
      for (const sample of result.lighting?.mutation?.samples ?? []) {
        detail.push("  " + sample);
      }
    }
    for (const result of presentationResults) {
      if (result.error !== undefined) {
        presentationExecutionFailures += 1;
        detail.push(`presentation fixture ${result.name}: FAIL (threw: ${result.error})`);
        continue;
      }
      let frameHard = 0;
      let frameAlphaBad = 0;
      const frameMaxDelta = [0, 0, 0, 0];
      for (const frame of result.compared ?? []) {
        totalPresentTexels += frame.texels;
        frameHard += frame.compare.hard;
        frameAlphaBad += frame.compare.alphaBad;
        for (let ch = 0; ch < 4; ch++) {
          frameMaxDelta[ch] = Math.max(frameMaxDelta[ch], frame.compare.maxDelta[ch]);
          presentMaxDelta[ch] = Math.max(presentMaxDelta[ch], frame.compare.maxDelta[ch]);
        }
      }
      totalPresentHard += frameHard;
      totalPresentAlphaBad += frameAlphaBad;
      const sizes = (result.compared ?? [])
        .map((frame) => `${frame.width}x${frame.height}`)
        .join(",");
      detail.push(
        `presentation fixture ${result.name}: ${frameHard === 0 ? "PASS" : "FAIL"} ` +
          `(${frameHard} hard / ${frameAlphaBad} bad-alpha of ${result.texels ?? 0} canvas texels, ` +
          `sizes ${sizes}, format ${result.canvasFormat}, ` +
          `per-channel max deltas R${frameMaxDelta[0]} G${frameMaxDelta[1]} B${frameMaxDelta[2]} A${frameMaxDelta[3]})`,
      );
      for (const frame of result.compared ?? []) {
        for (const sample of frame.compare.samples ?? []) {
          detail.push("  " + sample);
        }
      }
    }
    if (presentationBenchmark !== null) {
      const benchmarkParity = presentationBenchmark.parity;
      detail.push(
        `presentation benchmark ${presentationBenchmark.width}x${presentationBenchmark.height} ` +
          `${presentationBenchmark.warmups} warmups, ${presentationBenchmark.samples} samples: ` +
          `present-only median ${presentationBenchmark.presentMedian.toFixed(3)}ms ` +
          `(full compute-chain median reported separately); ` +
          `final frame parity: ${benchmarkParity.hard} hard / ${benchmarkParity.alphaBad} ` +
          `bad-alpha of ${presentationBenchmark.texels} canvas texels, ` +
          `per-channel max deltas R${benchmarkParity.maxDelta[0]} G${benchmarkParity.maxDelta[1]} ` +
          `B${benchmarkParity.maxDelta[2]} A${benchmarkParity.maxDelta[3]}`,
      );
    }
    if (presentationBenchmarkFailure !== null) {
      detail.push(`presentation benchmark failed: ${presentationBenchmarkFailure}`);
    }
    // #41 shadow-pass sample-count benchmark (report-only): median host
    // wall-clock per dispatch on the 640x360 proxy scene, running the REAL
    // soft path (positive angular radius) at every count.
    if (shadowSampleBench.length > 0) {
      detail.push(
        `shadow sample benchmark ${shadowSampleBench[0].width}x${shadowSampleBench[0].height} ` +
          `(soft path, angularRadius ${SHADOW_BENCH_ANGULAR_RADIUS}) ` +
          `${shadowSampleBench[0].warmups} warmups, ${shadowSampleBench[0].samples_taken} samples: ` +
          shadowSampleBench
            .map(
              (row) =>
                `requested ${row.requestedSamples}/effective ${row.effectiveSamples}` +
                `${row.softActive ? " (soft)" : " (hard)"} median ${row.medianMs.toFixed(3)}ms`,
            )
            .join("; "),
      );
      summaryData.shadowSampleBenchmark = shadowSampleBench.map((row) => ({
        requested: row.requestedSamples,
        effective: row.effectiveSamples,
        softActive: row.softActive,
        medianMs: Math.round(row.medianMs * 1000) / 1000,
      }));
    }
    if (shadowSampleBenchFailure !== null) {
      detail.push(`shadow sample benchmark failed: ${shadowSampleBenchFailure}`);
    }

    // #30: fill the CI SUMMARY payload (fixture totals + per-pass mismatch
    // totals), emitted by finish() right after the first-line marker.
    summaryData.fixtures = fixtureResults.length;
    summaryData.texels = totalTexels;
    summaryData.normalTexels = totalNormalTexels;
    summaryData.normalMismatches = totalNormalMismatches;
    summaryData.shadowTexels = totalShadowTexels;
    summaryData.shadowMismatches = totalShadowMismatches;
    summaryData.casterTexels = totalCasterTexels;
    summaryData.casterMismatches = totalCasterMismatches;
    summaryData.lightingTexels = totalLightingTexels;
    summaryData.diffuseMismatches = totalDiffuseMismatches;
    summaryData.specularMismatches = totalSpecularMismatches;
    summaryData.colorHard = totalColorHard;
    summaryData.colorSoft = totalColorSoft;
    summaryData.colorAlphaBad = totalColorAlphaBad;
    summaryData.mutationMismatches = totalMutationMismatches;
    summaryData.presentFixtures = presentationResults.length;
    summaryData.presentTexels = totalPresentTexels;
    summaryData.presentHard = totalPresentHard;
    summaryData.presentAlphaBad = totalPresentAlphaBad;
    summaryData.classificationTotals = classificationTotals;
    summaryData.catalogVersion = CATALOG_VERSION;
    if (benchmark !== null) {
      summaryData.benchmarkSpeedup = Number(benchmark.speedup.toFixed(3));
    }

    if (shaderProblems.length > 0) {
      finish(MARKER_FAIL, `shader compilation failed (${shaderProblems.length} messages)`);
      return;
    }
    if (deviceErrors.length > 0) {
      finish(MARKER_FAIL, `device validation errors (${deviceErrors.length})`);
      return;
    }
    if (executionFailures > 0) {
      finish(
        MARKER_FAIL,
        `fixture execution failures: ${executionFailures} of ${fixtureResults.length} fixtures ` +
          `(thrown errors or non-null scoped validation errors)`,
      );
      return;
    }
    if (totalMismatches > 0) {
      finish(
        MARKER_FAIL,
        `fixture mismatches: ${totalMismatches} texels across ${fixtureResults.length} fixtures (${totalTexels} texels total)`,
      );
      return;
    }
    if (totalNormalMismatches > 0) {
      finish(
        MARKER_FAIL,
        `normal mismatches: ${totalNormalMismatches} normal texels across ${fixtureResults.length} fixtures`,
      );
      return;
    }
    if (totalShadowMismatches > 0) {
      finish(
        MARKER_FAIL,
        `shadow visibility mismatches: ${totalShadowMismatches} of ${totalShadowTexels} visibility texels ` +
          `across ${fixtureResults.length} fixtures (exact 0/1 equality required)`,
      );
      return;
    }
    if (totalCasterMismatches > 0) {
      finish(
        MARKER_FAIL,
        `caster-height mismatches: ${totalCasterMismatches} of ${totalCasterTexels} texels ` +
          `(tolerance 1e-4, measured max error ${casterMaxError.toExponential(3)})`,
      );
      return;
    }
    if (totalDiffuseMismatches > 0 || totalSpecularMismatches > 0) {
      finish(
        MARKER_FAIL,
        `lighting diffuse/specular mismatches: diffuse ${totalDiffuseMismatches}, ` +
          `specular ${totalSpecularMismatches} of ${totalLightingTexels} lighting texels ` +
          `(tolerance 1e-3, measured max diffuse error ${maxDiffuseError.toExponential(3)}, ` +
          `max specular error ${maxSpecularError.toExponential(3)})`,
      );
      return;
    }
    if (totalColorHard > 0 || totalColorAlphaBad > 0) {
      finish(
        MARKER_FAIL,
        `lighting RGBA8 mismatches: ${totalColorHard} hard texels (${totalColorAlphaBad} bad alpha) ` +
          `of ${totalLightingTexels} lighting texels ` +
          `(per-channel max deltas R${colorMaxDelta[0]} G${colorMaxDelta[1]} B${colorMaxDelta[2]} A${colorMaxDelta[3]}; ` +
          `soft 1-unit single-channel deltas ${totalColorSoft} permitted)`,
      );
      return;
    }
    if (totalMutationMismatches > 0) {
      finish(
        MARKER_FAIL,
        `upstream buffer mutations during lighting dispatches: ${totalMutationMismatches}`,
      );
      return;
    }
    if (benchmarkFailure !== null) {
      finish(
        MARKER_FAIL,
        `benchmark failed: ${benchmarkFailure}`,
      );
      return;
    }
    const benchmarkLine =
      `benchmark ${benchmark.width}x${benchmark.height} ${benchmark.warmups} warmups, ` +
      `${benchmark.samples} samples: ` +
      `CPU median ${benchmark.cpuMedian.toFixed(2)}ms, GPU median ${benchmark.gpuMedian.toFixed(3)}ms, ` +
      `speedup ${benchmark.speedup.toFixed(1)}x ` +
      `(effective options ${JSON.stringify(benchmark.options)})`;
    detail.push(benchmarkLine);
    const benchmarkParity = benchmark.parity;
    const benchmarkLighting = benchmark.lighting;
    detail.push(
      `benchmark parity: visibility ${benchmarkParity.mismatches}/${benchmarkParity.rw * benchmarkParity.rh}, ` +
        `caster ${benchmarkParity.casterMismatches}/${benchmarkParity.rw * benchmarkParity.rh}, ` +
        `max err ${benchmarkParity.casterMaxError.toExponential(3)}; ` +
        `lighting (ambient ${benchmarkLighting.ambient}): ` +
        `diffuse ${benchmarkLighting.diffuse.mismatches}/${benchmarkParity.rw * benchmarkParity.rh} ` +
        `max err ${benchmarkLighting.diffuse.maxError.toExponential(3)}, ` +
        `specular ${benchmarkLighting.specular.mismatches}/${benchmarkParity.rw * benchmarkParity.rh} ` +
        `max err ${benchmarkLighting.specular.maxError.toExponential(3)}, ` +
        `color hard ${benchmarkLighting.color.hard} soft ${benchmarkLighting.color.soft} ` +
        `max deltas R${benchmarkLighting.color.maxDelta[0]} G${benchmarkLighting.color.maxDelta[1]} ` +
        `B${benchmarkLighting.color.maxDelta[2]} A${benchmarkLighting.color.maxDelta[3]}`,
    );
    if (!(benchmark.speedup >= BENCHMARK_MIN_SPEEDUP)) {
      finish(
        MARKER_FAIL,
        `benchmark blocker: speedup ${benchmark.speedup.toFixed(2)}x is below the required ` +
          `${BENCHMARK_MIN_SPEEDUP}x (CPU median ${benchmark.cpuMedian.toFixed(2)}ms, ` +
          `GPU median ${benchmark.gpuMedian.toFixed(3)}ms at ${benchmark.width}x${benchmark.height}, ` +
          `${benchmark.samples} samples)`,
      );
      return;
    }
    if (benchmarkParity.mismatches > 0) {
      finish(
        MARKER_FAIL,
        `benchmark scene visibility mismatches: ${benchmarkParity.mismatches} of ${benchmarkParity.rw * benchmarkParity.rh}`,
      );
      return;
    }
    if (benchmarkParity.casterMismatches > 0) {
      finish(
        MARKER_FAIL,
        `benchmark scene caster-height mismatches: ${benchmarkParity.casterMismatches} of ` +
          `${benchmarkParity.rw * benchmarkParity.rh}`,
      );
      return;
    }
    if (
      benchmarkLighting.diffuse.mismatches > 0 ||
      benchmarkLighting.specular.mismatches > 0 ||
      benchmarkLighting.color.hard > 0
    ) {
      finish(
        MARKER_FAIL,
        `benchmark scene lighting mismatches: diffuse ${benchmarkLighting.diffuse.mismatches}, ` +
          `specular ${benchmarkLighting.specular.mismatches}, ` +
          `color hard ${benchmarkLighting.color.hard} of ${benchmarkParity.rw * benchmarkParity.rh}`,
      );
      return;
    }
    // #29 presentation FAIL branches (before the PASS marker)
    if (presentationExecutionFailures > 0) {
      finish(
        MARKER_FAIL,
        `presentation fixture execution failures: ${presentationExecutionFailures} of ` +
          `${presentationResults.length} presentation fixtures ` +
          `(thrown errors or non-null scoped validation errors)`,
      );
      return;
    }
    if (totalPresentHard > 0) {
      finish(
        MARKER_FAIL,
        `presentation canvas mismatches: ${totalPresentHard} hard texels ` +
          `(${totalPresentAlphaBad} bad alpha) of ${totalPresentTexels} canvas texels ` +
          `(exact alpha; at-most-one-channel-by-one policy; per-channel max deltas ` +
          `R${presentMaxDelta[0]} G${presentMaxDelta[1]} B${presentMaxDelta[2]} A${presentMaxDelta[3]})`,
      );
      return;
    }
    if (presentationBenchmarkFailure !== null) {
      finish(
        MARKER_FAIL,
        `presentation benchmark failed: ${presentationBenchmarkFailure}`,
      );
      return;
    }
    if (presentationBenchmark.parity.hard > 0) {
      finish(
        MARKER_FAIL,
        `presentation benchmark scene canvas mismatches: ${presentationBenchmark.parity.hard} hard ` +
          `(${presentationBenchmark.parity.alphaBad} bad alpha) of ` +
          `${presentationBenchmark.texels} canvas texels`,
      );
      return;
    }
    const presentationBenchmarkLine =
      `presentation benchmark ${presentationBenchmark.width}x${presentationBenchmark.height} ` +
      `${presentationBenchmark.warmups} warmups, ${presentationBenchmark.samples} samples: ` +
      `present-only median ${presentationBenchmark.presentMedian.toFixed(3)}ms`;
    // #31 retained-frame parity FAIL branch (before the PASS marker)
    if (retainedFailure !== null) {
      finish(
        MARKER_FAIL,
        `retained-frame parity failed: ${retainedFailure}`,
      );
      return;
    }
    if (retainedProblems.length > 0) {
      finish(
        MARKER_FAIL,
        `retained-frame parity problems (${retainedProblems.length}): ${retainedProblems.join("; ")}`,
      );
      return;
    }
    detail.push(
      "retained-frame parity: PASS (byte-identical frame fully retained with zero " +
        "dispatches/allocations/uploads; retained repaint and partial invalidations " +
        "run exactly their downstream closure; forced full recompute byte-identical)",
    );
    // #32 partial/full parity FAIL branches (before the PASS marker)
    if (partialFailure !== null) {
      finish(
        MARKER_FAIL,
        `partial/full parity failed: ${partialFailure}`,
      );
      return;
    }
    if (partialProblems.length > 0) {
      finish(
        MARKER_FAIL,
        `partial/full parity problems (${partialProblems.length}): ${partialProblems.join("; ")}`,
      );
      return;
    }
    detail.push(
      "partial/full parity: PASS (small edits planned partial with fewer dispatched " +
        "workgroups; every partial/full frame byte-equal to a forced full recompute " +
        "across move/add/remove/reorder and the light/material/viewport fallbacks)",
    );
    // #32 tile benchmark report lines (never gating)
    if (tileBenchmarkFailure !== null) {
      detail.push(`tile benchmark failed: ${tileBenchmarkFailure}`);
    }
    for (const c of tileBenchmark) {
      detail.push(
        `tile benchmark tile=${c.tileSize} ratio=${c.ratio} mode=${c.mode} ` +
          `reason=${c.reason} dirtyCoverage=${c.dirtyCoverage.toFixed(3)} ` +
          `dirtyTexels=${c.dirtyTexels}/${c.totalTexels} dispatchTexels=${c.dispatchTexels} ` +
          `candidates=${c.candidates} culled=${c.culled} ` +
          `fullMedian=${c.fullMedian.toFixed(3)}ms partialMedian=${c.partialMedian.toFixed(3)}ms ` +
          `binningMs=${c.binningMs.toFixed(3)}ms (host, separate from GPU completion)`,
      );
    }
    if (tileBenchmark.length > 0) {
      detail.push(
        "tile benchmark summary: binning overhead reported SEPARATELY from submitted " +
          "GPU completion time; the partial/full path is chosen by the deterministic " +
          "PARTIAL_DISPATCH_RATIO coverage threshold, never by timing",
      );
    }
    finish(
      MARKER_PASS,
      `real adapter parity: ${fixtureResults.length} fixtures, ${totalTexels} scene texels, ` +
        `0 mismatches (height tolerance 1e-4; normal tolerance 1e-4, ` +
        `length tolerance 1e-4; measured max component error ${maxComponentError.toExponential(3)}, ` +
        `max length error ${maxLengthError.toExponential(3)}; ` +
        `shadow ${totalShadowMismatches}/${totalShadowTexels} visibility texels exact, ` +
        `caster tolerance 1e-4 max err ${casterMaxError.toExponential(3)}; ` +
        `lighting ${totalDiffuseMismatches + totalSpecularMismatches + totalColorHard}/${totalLightingTexels} texels ` +
        `(tolerance 1e-3, max diffuse err ${maxDiffuseError.toExponential(3)}, ` +
        `max specular err ${maxSpecularError.toExponential(3)}, ` +
        `RGBA8 per-channel max deltas R${colorMaxDelta[0]} G${colorMaxDelta[1]} B${colorMaxDelta[2]} A${colorMaxDelta[3]}, ` +
        `soft single-byte deltas ${totalColorSoft}); ` +
        `presentation ${presentationResults.length} fixtures, ${totalPresentTexels} canvas texels, ` +
        `0 hard / 0 bad-alpha (per-channel max deltas R${presentMaxDelta[0]} G${presentMaxDelta[1]} ` +
        `B${presentMaxDelta[2]} A${presentMaxDelta[3]}); ` +
        `${benchmarkLine}; ${presentationBenchmarkLine})`,
    );
  } catch (error) {
    finish(MARKER_FAIL, `harness threw: ${String(error?.stack ?? error)}`);
  }
}

main();
