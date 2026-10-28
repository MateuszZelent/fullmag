// Independent result windows on published FEM data; no numerical submissions.
// Edge preview, 50/50 snap, cancel and both-floating peers on retained canvases.
const {chromium}=await import(process.env.FULLMAG_PLAYWRIGHT_MODULE ?? new URL('../apps/control-room/node_modules/playwright/index.mjs',import.meta.url).href);
import {writeFile} from 'node:fs/promises';
const out=process.env.FULLMAG_UX_EVIDENCE ?? '/tmp/fullmag-results-ux';
await (await import('node:fs/promises')).mkdir(out,{recursive:true});
const origin=process.env.FULLMAG_UI_URL ?? 'http://localhost:3217';
const initialSample=Number(process.env.FULLMAG_INITIAL_SAMPLE ?? 0);
const targetSample=Number(process.env.FULLMAG_TARGET_SAMPLE ?? 0);
if(![initialSample,targetSample].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('Sample indexes must be nonnegative integers');
const sampleId=n=>String(n).padStart(4,'0');
const status=await (await fetch(origin+'/v2/sessions/current/status')).json();
const run=status.run.run_id;
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context=await browser.newContext({viewport:{width:1600,height:1100}});
const page=await context.newPage();
page.setDefaultTimeout(60000);
const evidence={capturedAt:new Date().toISOString(),runId:run,origin,scope:'Published-results UX in separate browser; presentation preferences may persist; no solver submissions or result modifications',presentationWrites:[],errors:[],blockedMutations:[]};
page.on('pageerror', e=>evidence.errors.push(e.message));
await page.context().route('**/*',async route=>{const q=route.request();const path=new URL(q.url()).pathname;if(q.method()==='PATCH' && path==='/v2/sessions/current/visualization/state'){evidence.presentationWrites.push({method:q.method(),path});return route.continue();}if(['GET','HEAD','OPTIONS'].includes(q.method())||q.method()==='POST'&&path==='/v2/sessions/current/visualization/client-acks')return route.continue();evidence.blockedMutations.push({method:q.method(),path});return route.abort();});
const tree=id=>page.locator(`[role="treeitem"][data-node-id="${id}"]`);
async function expand(id){const n=tree(id);await n.waitFor({timeout:30000});if(await n.getAttribute('aria-expanded')==='false')await n.locator('.fm-explorer-tree-row__branch').first().click();}
await page.addInitScript(()=>{window.__FULLMAG_CONFIG__={enableDiagnosticRecorder:true,diagnosticRecorderMaxRecords:20000,diagnosticRecorderMaxBytes:32*1024*1024,controlRoomApiBase:location.origin};});
try{
 console.log('goto'); await page.goto(`${origin}/workspace`,{waitUntil:'domcontentloaded',timeout:60000});
 const analysis=page.locator('.fm-viewport-tabs__trigger').filter({hasText:/^Analysis$/}); await analysis.first().click({timeout:60000});
 await page.locator('.fm-explorer .fm-tabs-trigger').filter({hasText:/^Results$/}).click({timeout:60000});
 console.log('tree'); const root=`results:run:${run}`, family=root+':k-resolved', stage=family+':stage:eigenmodes:modal_eigen';
 await expand(root);await expand(family);await tree(family).click();
 await expand(stage);await expand(stage+':modes-at-k');
 const mode=page.locator(`[role="treeitem"][data-node-id*="sample-${sampleId(initialSample)}"][data-node-id*="mode-0000"]`).last();
 await mode.click();await page.waitForTimeout(700);

 console.log('activate'); await page.getByRole('button',{name:'Show selected eigen mode in 3D',exact:true}).click();
 await page.locator('.fm-viewport-3d canvas').first().waitFor({state:'visible'});
 await page.waitForTimeout(1500);console.log('viewport ready');
 await page.locator('.fm-inspector').getByRole('button',{name:'Appearance',exact:true}).click();
 const binding=()=>page.evaluate(()=>window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.()?.streams?.timeline?.filter(x=>x.name==='viewport-3d.mode-surface-binding').at(-1)?.detail);
 const canvas=page.locator('.fm-viewport-3d canvas').first();
 await page.waitForFunction(()=>window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.()?.streams?.timeline?.filter(x=>x.name==='viewport-3d.mode-surface-binding').at(-1)?.detail?.complexValueCount>0,null,{timeout:60000}); evidence.initial=await binding(); await page.getByRole('button',{name:'Fit mode',exact:true}).click();

 await page.getByRole('button',{name:'Show dispersion chart and selected mode together',exact:true}).click();
 const host=page.locator('[data-slot-id="viewport-main"]');
 await page.waitForFunction(()=>document.querySelector('[data-slot-id="viewport-main"]')?.getAttribute('data-companion-module-id')==='viewport-3d');
 await page.locator('.fm-analysis-plots__frequency-canvas canvas').waitFor({state:'visible'});
 await canvas.waitFor({state:'visible'});
 evidence.splitBefore={primary:await host.getAttribute('data-active-module-id'),companion:await host.getAttribute('data-companion-module-id')};
 await page.getByRole('combobox',{name:'Mode wavevector',exact:true}).selectOption(String(targetSample));
 await page.getByRole('button',{name:'Animate selected eigen mode phase in 3D',exact:true}).click();
 await page.waitForFunction(quantity=>window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.()?.streams?.timeline?.filter(x=>x.name==='viewport-3d.mode-surface-binding').at(-1)?.detail?.bufferQuantity===quantity,`analysis:eigen:sample-${sampleId(targetSample)}:mode-0000`,{timeout:60000});
 await page.getByRole('button',{name:'Stop selected eigen mode animation',exact:true}).click();
 await page.getByRole('button',{name:'Fit mode',exact:true}).click();
 evidence.splitAfter={primary:await host.getAttribute('data-active-module-id'),companion:await host.getAttribute('data-companion-module-id')};
 if(evidence.splitAfter.primary!=='analysis-plots'||evidence.splitAfter.companion!=='viewport-3d')throw Error('Plotting mode collapsed split');
 evidence.binding=await binding();
 evidence.chartText=await page.locator('.fm-analysis-plots').innerText();
 if(!evidence.chartText.includes('Dispersion'))throw Error('Split lacks dispersion');
 evidence.webgl=await canvas.evaluate(el=>{const gl=el.getContext('webgl2')||el.getContext('webgl');return{width:gl?.drawingBufferWidth,height:gl?.drawingBufferHeight,contextLost:gl?.isContextLost(),visible:el.getBoundingClientRect().width>0};});
 if(evidence.webgl.contextLost!==false||!evidence.webgl.width||!evidence.webgl.height)throw Error('Split WebGL invalid');

 await page.waitForTimeout(1500);
 const original3D=await canvas.elementHandle();
 const originalChart=await page.locator('.fm-analysis-plots__frequency-canvas canvas').elementHandle();
 const win=id=>page.locator(`[data-panel-frame="viewport-module:${id}"]`);
 const choose=async(title,action)=>{await page.getByRole('button',{name:title+' panel menu',exact:true}).click();await page.getByRole('menuitem',{name:action,exact:true}).click();};
 evidence.windowActions=[];
 const assertRetained=async name=>{
  if(!await original3D.evaluate(el=>el.isConnected&&el===document.querySelector('.fm-viewport-3d canvas')))throw Error(name+': 3D remounted');
  if(!await originalChart.evaluate(el=>el.isConnected&&el===document.querySelector('.fm-analysis-plots__frequency-canvas canvas')))throw Error(name+': chart remounted');
  const gl=await original3D.evaluate(el=>{const c=el.getContext('webgl2')||el.getContext('webgl');return{lost:c?.isContextLost(),w:c?.drawingBufferWidth,h:c?.drawingBufferHeight};});
  if(gl.lost!==false||!gl.w||!gl.h)throw Error(name+': invalid WebGL');
  evidence.windowActions.push({name,retained:true,gl});console.log(name);
 };
 const drag=async(handle,dx,dy)=>{const b=await handle.boundingBox();if(!b)throw Error('Missing drag handle');await page.mouse.move(b.x+b.width/2,b.y+b.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width/2+dx,b.y+b.height/2+dy,{steps:12});await page.mouse.up();};

 await page.getByRole('button',{name:'Animate selected eigen mode phase in 3D',exact:true}).click();
 const surface=page.locator('.fm-viewport-tabs__surface');
 const grip=()=>page.getByRole('button',{name:'Move 3D Viewport with arrow keys',exact:true});
 const startDrag=async(x,y)=>{const h=await grip().boundingBox();await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(x,y,{steps:12});};
 const waitDocked=()=>page.waitForFunction(()=>['viewport-3d','analysis-plots'].every(id=>document.querySelector(`[data-panel-frame="viewport-module:${id}"]`)?.getAttribute('data-panel-mode')==='docked'));
 for(const edge of ['left','right','top','bottom']) {
  evidence.stage='snap '+edge;const b=await surface.boundingBox();
  const x=edge==='left'?b.x+8:edge==='right'?b.x+b.width-8:b.x+b.width/2;
  const y=edge==='top'?b.y+8:edge==='bottom'?b.y+b.height-8:b.y+b.height/2;
  await startDrag(x,y);
  await page.locator(`[data-dock-preview="${edge}"]`).waitFor({state:'visible'});
  await assertRetained('preview '+edge);
  if(edge==='left'||edge==='bottom')await page.screenshot({path:out+'/preview-'+edge+'.png'});
  await page.mouse.up();await waitDocked();
  await page.waitForTimeout(300);
  const a=await win('viewport-3d').boundingBox(),c=await win('analysis-plots').boundingBox();
  const horizontal=edge==='left'||edge==='right';
  if(Math.abs(horizontal?a.width-c.width:a.height-c.height)>3)throw Error('Not a 50/50 split: '+edge+' '+JSON.stringify({a,c}));
  if((edge==='left'&&a.x>=c.x)||(edge==='right'&&a.x<=c.x)||(edge==='top'&&a.y>=c.y)||(edge==='bottom'&&a.y<=c.y))throw Error('Wrong snapped order: '+edge);
  await assertRetained('dock '+edge);
  if(edge==='right'||edge==='bottom')await page.screenshot({path:out+'/docked-'+edge+'.png'});
 }
 // Cancel must not commit a target, and an interior drop must remain floating.
 evidence.stage='cancel';let b=await surface.boundingBox();await startDrag(b.x+8,b.y+b.height/2);
 await page.locator('[data-dock-preview="left"]').waitFor({state:'visible'});
 await page.keyboard.press('Escape');await page.mouse.up();await waitDocked();
 if(await page.locator('[data-dock-preview]').count())throw Error('Cancel retained preview');
 await assertRetained('cancel with Escape');
 evidence.stage='interior drop';b=await surface.boundingBox();await startDrag(b.x+b.width/2,b.y+b.height/2);await page.mouse.up();
 await page.waitForFunction(()=>document.querySelector('[data-panel-frame="viewport-module:viewport-3d"]')?.getAttribute('data-panel-mode')==='floating');
 if(await page.locator('[data-dock-preview]').count())throw Error('Interior drop retained preview');
 await assertRetained('interior drop floats');
 // Both-floating layout must snap to two panes without remounting either renderer.
 await page.locator('.fm-viewport-tabs__trigger').filter({hasText:/^Analysis$/}).click();await choose('Analysis','Float panel');
 await page.locator('.fm-viewport-tabs__trigger').filter({hasText:/^3D Viewport$/}).click();
 b=await surface.boundingBox();await startDrag(b.x+b.width-8,b.y+b.height/2);await page.mouse.up();await waitDocked();
 await assertRetained('dock both floating peers');
 await page.getByRole('button',{name:'Stop selected eigen mode animation',exact:true}).click();
 await page.getByRole('button',{name:'Fit mode',exact:true}).click();
 await page.screenshot({path:out+'/snap-final.png'});
 const after=await(await fetch(origin+'/v2/sessions/current/status')).json();if(after.run.run_id!==run)throw Error('Dock changed run');
 if(evidence.errors.length||evidence.blockedMutations.length)throw Error('Browser errors or numerical mutation');
 evidence.pass=true;
} catch(e){evidence.failure=String(e);evidence.stack=e.stack;await page.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}
finally{await writeFile(`${out}/probe.json`,JSON.stringify(evidence,null,2));await browser.close();console.log(JSON.stringify({pass:evidence.pass,failure:evidence.failure,stage:evidence.stage,errors:evidence.errors,blockedMutations:evidence.blockedMutations,windowActions:evidence.windowActions}));}
