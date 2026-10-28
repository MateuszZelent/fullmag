#!/usr/bin/env node
// Uses existing published results. Never submits Solve or Compute Fields.
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const value = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; };
const run = value('--run', null), stage = value('--stage', 'eigenmodes');
if (!run || !/^[A-Za-z0-9._:-]+$/.test(run) || !/^[A-Za-z0-9._:-]+$/.test(stage)) throw new Error('Usage: node scripts/verify_eigensolve_modal_workbench_ui.mjs --run RUN [--url URL] [--stage STAGE] [--output REPORT.json]');
const url = value('--url', 'http://localhost:3217/workspace');
const output = resolve(value('--output', '/tmp/eigensolve-modal-workbench-ui.evidence.json'));
const screenshots = resolve(value('--screenshots', dirname(output)));
await mkdir(dirname(output), { recursive: true }); await mkdir(screenshots, { recursive: true });
const { chromium } = await import(process.env.FULLMAG_PLAYWRIGHT_MODULE ?? new URL('../apps/control-room/node_modules/playwright/index.mjs', import.meta.url).href);
import {writeFile} from 'node:fs/promises';
const b=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const p=await b.newPage({viewport:{width:1600,height:1100}});const proof={schema:'eigensolve.modal-workbench-ui.v1',url,run,stage,sourceSha:value('--source-sha',null),scope:'UI against published FEM artifacts; SwiftShader rendering is not hardware GPU or convergence qualification',errors:[],httpFailures:[],modes:[],layouts:[]};
p.setDefaultTimeout(30000);
proof.blockedMutations=[];
await p.route('**/*', async route=>{ const request=route.request(); const path=new URL(request.url()).pathname; if(['GET','HEAD','OPTIONS'].includes(request.method()) || request.method()==='POST' && path==='/v2/sessions/current/visualization/client-acks') return route.continue(); proof.blockedMutations.push({method:request.method(),path});return route.abort(); });
p.on('pageerror',e=>proof.errors.push(e.message));
p.on('response',response=>{if(response.status()>=400)proof.httpFailures.push({path:new URL(response.url()).pathname,status:response.status()});});
await p.addInitScript(origin=>{window.__FULLMAG_ENABLE_CHART_DIAGNOSTICS__=true;window.__FULLMAG_CONFIG__={enableDiagnosticRecorder:true,controlRoomApiBase:origin};},new URL(url).origin);
try{
 await p.goto(url,{waitUntil:'domcontentloaded',timeout:120000});
 await p.locator('.fm-explorer .fm-tabs-trigger').filter({hasText:/^Results$/}).click({timeout:60000});
 const response = await p.request.get(new URL('/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2', url).href);
 if (!response.ok()) throw new Error(`Spectrum HTTP ${response.status()}`);
 const spectrum = await response.json();
 if (spectrum.run_id !== run || spectrum.stage_id !== stage || spectrum.status !== 'ready' || spectrum.generation_status !== 'member_verified_owner_bound') throw new Error('Published spectrum owner is not the requested run/stage');
 proof.owner = {runId: spectrum.run_id, stageId:spectrum.stage_id, generationId:spectrum.generation_id, revision:spectrum.revision};
 const published = spectrum.payload.samples;
 const selectedSamples = value('--samples', null)?.split(',').map(Number) ?? [...new Set([0, Math.floor((published.length-1)/4), Math.floor((published.length-1)/2), Math.ceil(3*(published.length-1)/4), published.length-1])].map(i=>published[i].sample_index);
 const root=`results:run:${run}`;
 for(const id of [root,root+':k-resolved',root+`:k-resolved:stage:${stage}:modal_eigen`]){
  const n=p.locator(`[role="treeitem"][data-node-id="${id}"]`);await n.waitFor({timeout:60000});if(await n.getAttribute('aria-expanded')==='false')await n.locator('.fm-explorer-tree-row__branch').first().click();
 }
 await p.locator(`[role="treeitem"][data-node-id="${root}:k-resolved:stage:${stage}:modal_eigen:dispersion"]`).click();
 await p.locator('.fm-analysis-plots__frequency-canvas canvas').waitFor({state:'visible',timeout:60000});
 const legend=p.getByRole('group',{name:'Frequency-domain series'});for(const btn of await legend.getByRole('button').all())if(await btn.getAttribute('aria-pressed')==='false')await btn.click();
 await p.waitForTimeout(800);
 proof.series=await p.evaluate(()=>window.__FULLMAG_CHART_DIAGNOSTICS__.readRenderedOption().series.map(s=>({name:s.name,type:s.type,data:s.data})));
 proof.comparisonSummary=await p.locator('.fm-analysis-plots__physical-details').allTextContents();
 if (published.length !== 15) throw new Error('This signed-DE acceptance lane requires the documented 15-sample benchmark');
 const computed = proof.series.find(entry=>entry.type==='scatter');
 if (!computed || computed.data.length !== published.reduce((n,sample)=>n+sample.modes.length,0)) throw new Error('Rendered modes do not cover the published spectrum');
 const flatModes = published.flatMap(sample=>sample.modes.map(mode=>({sample,mode})));
 const divisor = computed.name.endsWith('[GHz]') ? 1e9 : computed.name.endsWith('[MHz]') ? 1e6 : computed.name.endsWith('[Hz]') ? 1 : null;
 if (!divisor) throw new Error('Unrecognized frequency display unit');
 for (const point of computed.data) {
   const source = flatModes[point[2]];
   if (!source || Math.abs(point[1]*divisor-source.mode.frequency_hz)>Math.max(1, Math.abs(source.mode.frequency_hz))*1e-12) throw new Error('Rendered frequency differs from its published source row');
 }
 for(const sample of selectedSamples){
  await p.locator('.fm-analysis-plots').evaluate(e=>e.scrollTop=0);await p.waitForTimeout(250);
  const row = flatModes.findIndex(entry=>entry.sample.sample_index===sample && entry.mode.raw_mode_index===0);
  const renderedIndex = computed.data.findIndex(point=>point[2]===row);
  if (renderedIndex<0) throw new Error(`No returned raw mode 0 for sample ${sample}`);
  const point=await p.evaluate(i=>window.__FULLMAG_CHART_DIAGNOSTICS__.resolveRenderedDataPoint(0,i),renderedIndex);
  if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw Error(`Invalid rendered sample ${sample}`);
  await p.mouse.click(point.x,point.y);
  const action=p.getByRole('button',{name:'View selected mode in 3D',exact:true});await action.scrollIntoViewIfNeeded();await action.click();
  const field=`analysis:eigen:sample-${String(sample).padStart(4,'0')}:mode-0000`;
  await p.waitForFunction(field=>{
    const all=window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.()?.streams?.timeline??[];const e=all.filter(x=>x.name==='viewport-3d.mode-surface-binding').at(-1)?.detail;return e?.bufferQuantity===field&&e?.complexValueCount>0&&e?.surfaceVisible;
  },field,{timeout:60000});
  const modeCanvas=p.locator('.fm-viewport-3d canvas').first();
  await modeCanvas.waitFor({state:'visible',timeout:60000});
  const webgl = await modeCanvas.evaluate(canvas=>{
    const gl=canvas.getContext('webgl2')??canvas.getContext('webgl');
    return {contextLost:gl?.isContextLost()??true,width:gl?.drawingBufferWidth??0,height:gl?.drawingBufferHeight??0};
  });
  if(webgl.contextLost||webgl.width<=0||webgl.height<=0)throw Error(`Mode ${sample} has no healthy WebGL drawing buffer`);
  proof.modes.push({sample,point,canvasVisible:true,webgl,surface:await p.evaluate(()=>{const all=window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.()?.streams?.timeline??[];return all.filter(x=>x.name==='viewport-3d.mode-surface-binding').at(-1)?.detail;})});
  await p.getByRole('button',{name:'Fit mode',exact:true}).click();
  console.log(`Rendered sample ${sample}`);
  if(sample===7)await p.screenshot({path:`${screenshots}/modal-sample-${sample}-3d.png`});
  await p.locator('.fm-viewport-tabs__trigger').filter({hasText:/^Analysis$/}).click();
  await p.locator('.fm-analysis-plots__frequency-canvas canvas').waitFor({state:'visible',timeout:30000});
 }
 // A reference click must never leave an actionable FEM mode under the cursor.
 await p.locator('.fm-analysis-plots').evaluate(e=>e.scrollTop=0);await p.waitForTimeout(300);
 if (!proof.series[1]?.data.length) throw new Error('Import a reference curve through the UI before this comparison check');
 const numericalX = computed.data.map(point=>point[0]);
 const farthest = proof.series[1].data.map((point,index)=>({index,distance:Math.min(...numericalX.map(x=>Math.abs(x-point[0])))})).sort((a,b)=>b.distance-a.distance)[0].index;
 const ref=await p.evaluate(i=>window.__FULLMAG_CHART_DIAGNOSTICS__.resolveRenderedDataPoint(1,i),farthest);
 await p.mouse.click(ref.x,ref.y);await p.waitForTimeout(250);
 proof.referenceHasModeAction=await p.getByRole('button',{name:'View selected mode in 3D',exact:true}).count();
 if(proof.referenceHasModeAction)throw Error('Analytical reference exposed a FEM mode action');
 // Re-select Gamma and validate both coordinate systems after actual resize settles.
 const gammaIndex=computed.data.findIndex(point=>point[0]===0);
 const gamma=await p.evaluate(i=>window.__FULLMAG_CHART_DIAGNOSTICS__.resolveRenderedDataPoint(0,i),gammaIndex);await p.mouse.click(gamma.x,gamma.y);
 for(const axis of ['k-path distance s','kᵧ']){
  await p.getByRole('combobox',{name:'Dispersion wavevector coordinate',exact:true}).click();await p.getByRole('option',{name:axis,exact:true}).click();await p.waitForTimeout(500);
  const points=await p.evaluate(()=>[0,7,14].map(i=>window.__FULLMAG_CHART_DIAGNOSTICS__.resolveRenderedDataPoint(0,i)));
  const expected = axis === 'k-path distance s' ? [0,25e6,50e6] : [-25e6,0,25e6];
  if(points.some((point,index)=>!point || Math.abs(point.data[0]-expected[index])>1e-6)) throw new Error(`Wrong rendered axis coordinates: ${axis}`);
  const canvas = await p.locator('.fm-analysis-plots__frequency-canvas canvas').boundingBox();
  if(!canvas || points.some(point=>point.x<canvas.x || point.x>canvas.x+canvas.width || point.y<canvas.y || point.y>canvas.y+canvas.height)) throw new Error(`Axis switch left points outside the rendered canvas: ${axis}`);
  proof.layouts.push({axis,points});
 }
 for(const viewport of [{width:1600,height:1100},{width:1440,height:900},{width:1100,height:900}]){
  await p.setViewportSize(viewport);await p.locator('.fm-analysis-plots').evaluate(e=>e.scrollTop=0);await p.waitForTimeout(800);
  const bounds=await p.locator('.fm-analysis-plots, .fm-analysis-plots__frequency-canvas').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().toJSON()));
  const [host,plot]=bounds;
  if(!host||!plot||plot.left<host.left||plot.right>host.right||plot.top<host.top||plot.bottom>host.bottom)throw Error(`Plot clipped at ${viewport.width}×${viewport.height}: ${JSON.stringify(bounds)}`);
  proof.layouts.push({viewport,bounds});await p.screenshot({path:`${screenshots}/modal-workbench-${viewport.width}.png`});
 }
 if(proof.errors.length || proof.httpFailures.length || proof.blockedMutations.length)throw Error('Browser or HTTP errors occurred');
 const plotBounds=()=>p.locator('.fm-analysis-plots__frequency-canvas').boundingBox();
 await p.setViewportSize({width:1440,height:900}); await p.waitForTimeout(500);
 const before=await plotBounds();
 await p.getByRole('button',{name:'Show / hide lower panel',exact:true}).click();await p.waitForTimeout(500);
 const hidden=await plotBounds();
 if(!before || !hidden || hidden.height<=before.height)throw Error('Hiding lower panel did not increase chart space');
 proof.lowerPanelToggle={before,hidden};
 await p.screenshot({path:`${screenshots}/modal-workbench-focused.png`});
 await p.getByRole('button',{name:'Show / hide lower panel',exact:true}).click();await p.waitForTimeout(500);
 const restored=await plotBounds();
 if(!restored || Math.abs(restored.height-before.height)>2)throw Error('Lower panel toggle did not restore chart layout');
 proof.lowerPanelToggle.restored=restored;
 proof.runtimeVersion=(await p.locator('body').innerText()).match(/0\.1\.0-dev\.[^\s]+/)?.[0]??null;
 console.log(JSON.stringify({modes:proof.modes.map(m=>({sample:m.sample,field:m.surface.bufferQuantity,complex:m.surface.complexValueCount})),referenceHasModeAction:proof.referenceHasModeAction,errors:proof.errors,layouts:proof.layouts}));
}catch(e){proof.failure=String(e);console.error(e);await p.screenshot({timeout:15000,path:`${screenshots}/modal-workbench-failed.png`}).catch(error=>{proof.failureScreenshot=String(error);});process.exitCode=1;}
finally{await writeFile(output,JSON.stringify(proof,null,2));await b.close();}
