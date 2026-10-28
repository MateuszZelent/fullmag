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


 const pane=id=>page.locator(`[data-panel-frame="${id}"]`);
 const titles={'panel-left':'Explorer','panel-right':'Inspector','panel-bottom':'Diagnostics'};
 const inspectorNode=await page.locator('.fm-inspector').elementHandle();
 const explorerNode=await page.locator('.fm-explorer').elementHandle();
 const footerNode=await page.locator('[data-workspace-pane="panel-bottom"] [data-slot-id="panel-bottom"]').elementHandle();
 const assertAllRetained=async name=>{await assertRetained(name);for(const node of [inspectorNode,explorerNode,footerNode])if(!node||!await node.evaluate(el=>el.isConnected))throw Error(name+': panel remounted');};
 await page.getByRole('button',{name:'Arrange modes left and spectrum right',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-slot-id="viewport-main"]')?.getAttribute('data-active-module-id')==='viewport-3d');
 await page.getByRole('button',{name:'Back to chart',exact:true}).click();
 if(await host.getAttribute('data-active-module-id')!=='viewport-3d'||await host.getAttribute('data-companion-module-id')!=='analysis-plots')throw Error('Back to chart collapsed preset');
 await page.getByRole('button',{name:'Animate selected eigen mode phase in 3D',exact:true}).click();
 await assertAllRetained('preset modes left, spectrum right');
 await page.waitForTimeout(250);
 if((await win('viewport-3d').boundingBox()).x >= (await win('analysis-plots').boundingBox()).x)throw Error('Preset order incorrect');
 await page.screenshot({path:out+'/modes-left-spectrum-right.png'});
 const workspaceRoot=page.locator('#fm-main-content');
 async function snap(id,target,edge){
  evidence.stage=`${id} ${edge} of ${target}`;
  const h=await pane(id).getByRole('button',{name:`Move ${titles[id]} with arrow keys`,exact:true}).boundingBox();
  await page.mouse.move(h.x+h.width/2,h.y+h.height/2);await page.mouse.down();await page.mouse.move(h.x+h.width/2+45,h.y+h.height/2+45,{steps:6});
  await page.waitForFunction(id=>document.querySelector(`[data-panel-frame="${id}"]`)?.getAttribute('data-panel-mode')==='floating',id);
  await page.waitForTimeout(250);
  const b=await (target==='workspace'?workspaceRoot:pane(target)).boundingBox();const inset=target==='workspace'?8:24;
  const x=edge==='left'?b.x+inset:edge==='right'?b.x+b.width-inset:b.x+b.width/2;
  const y=edge==='top'?b.y+inset:edge==='bottom'?b.y+b.height-inset:b.y+b.height/2;
  await page.mouse.move(x,y,{steps:12});
  await page.locator(`[data-workspace-dock-preview="${edge}"][data-dock-target="${target}"]`).waitFor({state:'visible'});
  if(id==='panel-right'&&target==='workspace')await page.screenshot({path:out+'/inspector-dock-preview.png'});
  await page.mouse.up();await page.waitForFunction(id=>document.querySelector(`[data-panel-frame="${id}"]`)?.getAttribute('data-panel-mode')==='docked',id);
  await page.waitForTimeout(250);await assertAllRetained(evidence.stage);
  const a=await pane(id).boundingBox();if(!a.width||!a.height)throw Error('Empty docked pane');
 }
 await snap('panel-right','workspace','left');
 await snap('panel-right','viewport-main','bottom');
 await snap('panel-left','workspace','right');
 await snap('panel-left','viewport-main','top');
 await snap('panel-bottom','workspace','left');
 await snap('panel-bottom','panel-right','right');
 await page.screenshot({path:out+'/custom-all-panels.png'});
 const saved=await page.evaluate(()=>localStorage.getItem('fullmag.workspace.dock-tree.v1'));
 const second=await context.newPage();second.on('pageerror',e=>evidence.errors.push(e.message));
 await second.goto(origin+'/workspace',{waitUntil:'domcontentloaded'});
 await second.locator('[data-workspace-pane="panel-right"]').waitFor({state:'visible'});
 await second.waitForTimeout(700);
 const restored=await second.evaluate(()=>localStorage.getItem('fullmag.workspace.dock-tree.v1'));
 const structure=node=>node.kind==='pane'?node.pane:[node.axis,structure(node.first),structure(node.second)];
 if(JSON.stringify(structure(JSON.parse(saved)))!==JSON.stringify(structure(JSON.parse(restored))))throw Error('Dock tree did not persist');
 evidence.persistedStructure=structure(JSON.parse(restored));await second.close();
 await pane('viewport-main').getByRole('button',{name:'Viewport panel menu',exact:true}).click();await page.getByRole('menuitem',{name:'Reset panel arrangement',exact:true}).click();
 await page.waitForTimeout(400);await assertAllRetained('reset workspace without remount');
 await page.getByRole('button',{name:'Arrange modes left and spectrum right',exact:true}).click();
 await page.getByRole('button',{name:'Stop selected eigen mode animation',exact:true}).click();
 await page.getByRole('button',{name:'Fit mode',exact:true}).click();
 await page.screenshot({path:out+'/final-modes-spectrum-inspector.png'});
 const after=await(await fetch(origin+'/v2/sessions/current/status')).json();if(after.run.run_id!==run)throw Error('Workspace docking changed run');
 if(evidence.errors.length||evidence.blockedMutations.length)throw Error('Browser errors or numerical mutation');
 evidence.pass=true;
} catch(e){evidence.failure=String(e);evidence.stack=e.stack;await page.screenshot({path:out+'/failure.png'}).catch(()=>{});process.exitCode=1;}
finally{await writeFile(`${out}/probe.json`,JSON.stringify(evidence,null,2));await browser.close();console.log(JSON.stringify({pass:evidence.pass,failure:evidence.failure,stage:evidence.stage,errors:evidence.errors,blockedMutations:evidence.blockedMutations,actions:evidence.windowActions}));}
