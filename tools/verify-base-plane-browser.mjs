// Optional Playwright browser/DOM validation and screenshots for Issue #75.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const { chromium } = await import(process.env.UKIBORI_PLAYWRIGHT_MODULE ?? 'playwright');
const repo=resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline=process.env.UKIBORI_BASELINE_ROOT;
const servers=[];
async function serve(cwd, port) {
 const server=spawn(process.execPath,[repo+'/node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd,stdio:['ignore','pipe','pipe']}); servers.push(server);
 await new Promise((resolve,reject)=>{server.stdout.on('data',b=>{if(b.toString().includes('Local:'))resolve();});server.on('error',reject);server.on('exit',c=>reject(new Error('vite '+c)));});
}
let browser;
try {
 await serve(repo+'/demo',4173);
 browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--disable-dev-shm-usage','--enable-unsafe-webgpu',...(process.env.WEBGPU_CHROME_NO_SANDBOX==='1'?['--no-sandbox']:[])],env:process.env});
 const page=await browser.newPage({viewport:{width:1200,height:860}});page.setDefaultTimeout(60000);const errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 async function open(url) { console.log('Opening',url); await page.goto(url);await page.waitForFunction(()=>Object.keys(window.__basePlaneLayers??{}).length===6);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))); }
 await open('http://127.0.0.1:4173/base-plane-debug.html?backend=webgpu');
 const status=await page.evaluate(()=>Object.fromEntries(Object.entries(window.__basePlaneLayers).map(([id,layer])=>{const s=layer.debugState();return [id,{backend:s.backend,fallback:s.gpuFallbackReason,renderSize:s.renderSize,keys:Object.keys(s)}];})));
 if(Object.values(status).some(s=>s.backend!=='webgpu'||s.fallback))throw new Error('GPU fallback: '+JSON.stringify({status,errors}));
 await page.screenshot({path:repo+'/docs/issue-75/base-plane-after.png',fullPage:true});
 await page.locator('[data-case="D"]').screenshot({path:repo+'/docs/issue-75/base-plane-bloom-off.png'});
 const button=page.getByRole('button',{name:'DOM interaction check'});await button.focus();
 if(!await button.evaluate(el=>el===document.activeElement))throw new Error('focus failed');
 await button.click();if(await button.textContent()!=='DOM · 1')throw new Error('click failed');
 const selected=await page.locator('[data-case="D"] .floor-label').evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();});
 if(selected!=='PHYSICAL RECEIVER')throw new Error('selection failed');
 const overlays=await page.locator('[data-ukibori-overlay]').evaluateAll(nodes=>nodes.every(n=>getComputedStyle(n).pointerEvents==='none'&&n.getAttribute('aria-hidden')==='true'&&n.getAttribute('tabindex')==='-1'));
 if(!overlays)throw new Error('overlay semantics failed');
 await page.evaluate(()=>{getSelection().removeAllRanges();document.querySelector('[data-case="D"] .floor-stage').style.width='300px';});
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-case="D"] canvas')].find(n=>getComputedStyle(n).display!=='none')?.width===300);
 await page.evaluate(()=>window.__basePlaneLayers.D.setDpr(1.5));
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-case="D"] canvas')].find(n=>getComputedStyle(n).display!=='none').width===450);
 await page.setViewportSize({width:1200,height:600});await page.evaluate(()=>window.scrollTo(0,160));
 const aligned=await page.locator('[data-case="D"] .floor-stage').evaluate(stage=>{const canvas=[...stage.querySelectorAll('canvas')].find(n=>getComputedStyle(n).display!=='none');const s=stage.getBoundingClientRect(),c=canvas.getBoundingClientRect();return Math.abs(s.left-c.left)<0.01&&Math.abs(s.top-c.top)<0.01;});
 if(!aligned)throw new Error('scroll alignment failed');
 await page.setViewportSize({width:1200,height:860});
 await open('http://127.0.0.1:4173/base-plane-debug.html?backend=cpu');
 const cpu=await page.evaluate(()=>Object.values(window.__basePlaneLayers).every(layer=>layer.debugState().backend==='cpu'));
 if(!cpu)throw new Error('CPU rendering unavailable');
 await page.locator('[data-case="D"]').screenshot({path:repo+'/docs/issue-75/base-plane-bloom-off-cpu.png'});
 if(baseline){
 await page.goto('about:blank');
 servers[0].kill();
 await serve(baseline+'/demo',4174);
 await open('http://127.0.0.1:4174/base-plane-debug.html?backend=webgpu&legacy=1');
 await page.screenshot({path:repo+'/docs/issue-75/base-plane-before.png',fullPage:true});
 }
 if(errors.length)throw new Error(errors.join('\n'));
 const report={browser:await browser.version(),adapter:await page.evaluate(async()=>{const a=await navigator.gpu.requestAdapter();return {vendor:a.info.vendor,architecture:a.info.architecture,description:a.info.description};}),gpuCases:Object.keys(status),cpuCases:6,focus:true,click:true,selection:true,overlayInert:true,stageResize:true,dprChange:true,scrollAlignment:true,errors,baseline:baseline?'Separate baseline checkout with identical fixture added for capture':null};
 await writeFile(repo+'/docs/issue-75/browser-validation.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
} finally {await browser?.close();for(const server of servers)server.kill();}
