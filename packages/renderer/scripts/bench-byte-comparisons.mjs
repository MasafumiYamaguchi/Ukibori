#!/usr/bin/env node
// Usage: node scripts/bench-byte-comparisons.mjs /absolute/before.mjs [results.json]
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import * as after from '../dist/index.js';
import { maskHeavyScene } from './bench/lib/scenes.mjs';
const before = await import(pathToFileURL(process.argv[2]).href);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
let sink = 0;
function bench(name, run, iterations) {
  assert.deepEqual(run(after), run(before), name);
  const implementations = [before, after];
  for (const api of implementations) for (let i = 0; i < 100; i++) run(api);
  const rounds = [[], []];
  for (let round = 0; round < 15; round++) {
    for (const index of round % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      for (let i = 0; i < iterations; i++) sink += Number(Boolean(run(implementations[index])));
      rounds[index].push((performance.now() - start) / iterations);
    }
  }
  const beforeMs = median(rounds[0]), afterMs = median(rounds[1]);
  results.push({ name, iterations, beforeMs, afterMs, speedup: beforeMs / afterMs, rounds });
  console.log(`${name}: ${beforeMs.toFixed(5)} -> ${afterMs.toFixed(5)} ms (${(beforeMs / afterMs).toFixed(2)}x)`);
}
for (const size of [16, 128, 65536, 4194304]) {
  for (const mismatch of ['equal', 'first', 'last']) {
    const a = new Uint8Array(size).fill(127), b = a.slice();
    if (mismatch !== 'equal') b[mismatch === 'first' ? 0 : size - 1] ^= 1;
    bench(`bytes-${size}-${mismatch}`, api => api.bytesEqual(a, b), size > 65536 && mismatch !== 'first' ? 20 : 2000);
  }
}
for (const resolution of [32, 256]) {
  const scene = after.createScene(maskHeavyScene({ width: 640, height: 360, maskCount: 16, maskResolution: resolution }));
  const a = after.encodeScene(scene, 1).bytes;
  const same = a.slice();
  scene.light.intensity += 0.5;
  const light = after.encodeScene(scene, 1).bytes;
  bench(`classify-16-masks-${resolution}-light-only`, api => api.classifySceneChange(a, light), 100);
  bench(`diff-16-masks-${resolution}-identical`, api => api.diffEncodedScenes(a, same), 100);
  const previousKey = after.computeFrameKey({ bytes: a }, { dpr: 1 });
  bench(`schedule-16-masks-${resolution}-light-only`, api => {
    const key = api.computeFrameKey({ bytes: light }, { dpr: 1 });
    return api.reportInvalidations(key, previousKey, light, a);
  }, 100);
  scene.light.intensity -= 0.5;
  scene.surfaces[0].elevation += 1;
  const moved = after.encodeScene(scene, 1).bytes;
  bench(`diff-16-masks-${resolution}-surface-edit`, api => api.diffEncodedScenes(a, moved), 100);
}
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({
  node: process.version, cpu: cpus()[0].model, warmups: 100,
  beforeBundleSha256: createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'),
  afterBundleSha256: createHash('sha256').update(readFileSync(new URL('../dist/index.js', import.meta.url))).digest('hex'),
  results, sink,
}, null, 2) + '\n');
