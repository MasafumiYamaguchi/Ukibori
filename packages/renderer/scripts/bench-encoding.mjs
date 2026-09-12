#!/usr/bin/env node
// Compare two built renderer bundles in alternating order; assert byte parity
// before timing. Usage: node scripts/bench-encoding.mjs /absolute/before.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import * as after from '../dist/index.js';
import { surfaceGridScene, maskHeavyScene } from './bench/lib/scenes.mjs';
const before = await import(pathToFileURL(process.argv[2]).href);
const median = xs => [...xs].sort((a,b) => a-b)[Math.floor(xs.length/2)];
const cases = [];
for (const count of [9, 64, 512, 2048]) {
  for (const unique of [false, true]) {
    const input = surfaceGridScene({width: 1920, height: 1080, count});
    if (unique) {
      input.materials = {};
      input.surfaces.forEach((s,i) => {
        s.material = `material-${i}`;
        input.materials[s.material] = {baseColor:{r:(i%10)/10,g:0.3,b:0.4},roughness:0.5,metallic:0};
      });
    }
    cases.push({name:`surfaces-${count}-${unique?'unique':'shared'}`,input});
  }
}
for (const type of ['u8','f32']) {
  for (const resolution of [32, 256]) {
    const input = maskHeavyScene({width:1920,height:1080,maskCount:16,maskResolution:resolution});
    for (const surface of input.surfaces) if(surface.shape.kind === 'mask') {
      const source=surface.shape.mask.alpha;
      const alpha=type==='u8'?new Uint8Array(source.length+8).subarray(4,-4):new Float32Array(source.length+8).subarray(4,-4);
      for(let i=0;i<source.length;i++) {
        const value=source instanceof Uint8Array?source[i]/255:source[i];
        alpha[i]=type==='u8'?Math.round(value*255):value;
      }
      surface.shape.mask.alpha=alpha;
    }
    cases.push({name:`masks-16-${resolution}-${type}`,input});
  }
}
const results=[];
for(const {name,input} of cases) {
  const scene=after.createScene(input);
  for(const dpr of [1,1.5,2]) assert.deepEqual(after.encodeScene(scene,dpr).bytes,before.encodeScene(scene,dpr).bytes,name);
  const funcs=[()=>before.encodeScene(scene,1),()=>after.encodeScene(scene,1)];
  for(const f of funcs) for(let i=0;i<200;i++) f();
  const timings=[[],[]];
  const iterations=name.includes('256')?20:100;
  for(let round=0;round<15;round++) for(const index of round%2?[1,0]:[0,1]) {
    const start=performance.now();
    for(let i=0;i<iterations;i++) funcs[index]();
    timings[index].push((performance.now()-start)/iterations);
  }
  const baselineMs=median(timings[0]), optimizedMs=median(timings[1]);
  const result={name,iterations,baselineMs,optimizedMs,speedup:baselineMs/optimizedMs,rounds:timings};
  results.push(result);
  console.log(`${name}: ${baselineMs.toFixed(4)} -> ${optimizedMs.toFixed(4)} ms (${result.speedup.toFixed(2)}x)`);
}
if(process.argv[3]) writeFileSync(process.argv[3],JSON.stringify({node:process.version,cpu:cpus()[0].model,warmups:200,beforeBundleSha256:createHash('sha256').update(readFileSync(process.argv[2])).digest('hex'),afterBundleSha256:createHash('sha256').update(readFileSync(new URL('../dist/index.js',import.meta.url))).digest('hex'),byteParity:'36 cases, exact',results},null,2)+'\n');
