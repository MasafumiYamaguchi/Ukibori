#!/usr/bin/env node
// Usage: node scripts/bench-lighting-environment.mjs /absolute/before.mjs [results.json]
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import * as after from '../dist/index.js';
import { surfaceGridScene } from './bench/lib/scenes.mjs';
const before = await import(pathToFileURL(process.argv[2]).href);
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
// Reuse and mutate one scene across calls to expose stale frame preparation.
const parityScene = after.createScene(surfaceGridScene({ width: 32, height: 16, count: 4 }));
const parityComposed = after.composeSdfHeightField(parityScene);
const parityInput = { normal: after.computeNormals(parityComposed.height), objectId: parityComposed.objectId };
let mutationParityCases = 0;
for (const direction of [{x:0,y:0,z:1}, {x:0,y:0,z:-1}, {x:0.6,y:0,z:0.8}, {x:-0.6,y:0.8,z:0}]) {
  for (const roughness of [0, 0.5, 1]) {
    for (const metallic of [0, 1]) {
      parityScene.light.direction = direction;
      parityScene.materials = { silicone: { baseColor:{r:0.7,g:0.1,b:0.3}, roughness, metallic, ior:2.4 } };
      parityScene.environment.intensity = roughness;
      const expected = before.shadePreparedFields(parityScene, parityInput);
      const actual = after.shadePreparedFields(parityScene, parityInput);
      for (const field of ['diffuse', 'specular', 'color']) assert.deepEqual(actual[field].data, expected[field].data, `mutation-${mutationParityCases}/${field}`);
      mutationParityCases++;
    }
  }
}
for (const [width, height, count] of [[320,180,1], [320,180,64], [640,360,16]]) {
  const scene = after.createScene(surfaceGridScene({ width, height, count }));
  const composed = after.composeSdfHeightField(scene);
  const normal = after.computeNormals(composed.height);
  const visibility = new after.HostBuffer({ width, height, channels:1, format:'f32' });
  for (let i = 0; i < visibility.data.length; i++) visibility.data[i] = (i % 17) / 16;
  const input = { normal, objectId: composed.objectId, visibility };
  for (const intensity of [0, 0.5, 4]) {
    scene.environment.intensity = intensity;
    const name = `${width}x${height}-${count}-surfaces-env-${intensity}`;
    const expected = before.shadePreparedFields(scene, input);
    const actual = after.shadePreparedFields(scene, input);
    for (const field of ['diffuse', 'specular', 'color']) assert.deepEqual(actual[field].data, expected[field].data, `${name}/${field}`);
    const implementations = [before, after];
    for (const api of implementations) for (let i = 0; i < 5; i++) api.shadePreparedFields(scene, input);
    const rounds = [[], []];
    for (let round = 0; round < 15; round++) {
      for (const index of round % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now();
        implementations[index].shadePreparedFields(scene, input);
        rounds[index].push(performance.now() - start);
      }
    }
    const beforeMs = median(rounds[0]), afterMs = median(rounds[1]);
    results.push({ name, beforeMs, afterMs, speedup: beforeMs / afterMs, rounds });
    console.log(`${name}: ${beforeMs.toFixed(3)} -> ${afterMs.toFixed(3)} ms (${(beforeMs / afterMs).toFixed(2)}x)`);
  }
}
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify({
  node: process.version, cpu: cpus()[0].model, warmups: 5, parity: 'all diffuse/specular f32 values and RGBA8 bytes exact in 9 timed cases and 24 mutation cases', mutationParityCases,
  beforeBundleSha256: createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'),
  afterBundleSha256: createHash('sha256').update(readFileSync(new URL('../dist/index.js', import.meta.url))).digest('hex'),
  results,
}, null, 2) + '\n');
