// Signed-DE benchmark mode controls; presentation only, no numerical submissions.
const {chromium}=await import(process.env.FULLMAG_PLAYWRIGHT_MODULE ?? new URL('../apps/control-room/node_modules/playwright/index.mjs',import.meta.url).href);
import {writeFile} from 'node:fs/promises';
const out=process.env.FULLMAG_UX_EVIDENCE ?? '/tmp/fullmag-results-ux';
await (await import('node:fs/promises')).mkdir(out,{recursive:true});
const injectMissingField = process.env.FULLMAG_UX_MISSING_FIELD === '1';
const origin=process.env.FULLMAG_UI_URL ?? 'http://localhost:3217';
const initialSample=Number(process.env.FULLMAG_INITIAL_SAMPLE ?? 5);
const targetSample=Number(process.env.FULLMAG_TARGET_SAMPLE ?? 7);
if(![initialSample,targetSample].every(n=>Number.isSafeInteger(n)&&n>=0))throw Error('Sample indexes must be nonnegative integers');
const sampleId=n=>String(n).padStart(4,'0');
const status=await (await fetch(origin+'/v2/sessions/current/status')).json();
const run=status.run.run_id;
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1600,height:1100}});
page.setDefaultTimeout(60000);
const evidence={capturedAt:new Date().toISOString(),scope:'Published-results UX in separate browser; presentation preferences may persist; no solver submissions or result modifications',presentationWrites:[],errors:[],blockedMutations:[],views:[]};
page.on('pageerror', e=>evidence.errors.push(e.message));
await page.route('**/*',async route=>{const q=route.request();const path=new URL(q.url()).pathname;if(q.method()==='PATCH' && path==='/v2/sessions/current/visualization/state'){evidence.presentationWrites.push({method:q.method(),path});return route.continue();}if(injectMissingField && q.method()==='GET' && path.endsWith('/eigen/mode-field/5/0/meta')) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Injected test: mode metadata unavailable'})});if(['GET','HEAD','OPTIONS'].includes(q.method())||q.method()==='POST'&&path==='/v2/sessions/current/visualization/client-acks')return route.continue();evidence.blockedMutations.push({method:q.method(),path});return route.abort();});
const tree=id=>page.locator(`[role="treeitem"][data-node-id="${id}"]`);
async function expand(id){const n=tree(id);await n.waitFor({timeout:30000});if(await n.getAttribute('aria-expanded')==='false')await n.locator('.fm-explorer-tree-row__branch').first().click();}
async function capture(name){await page.waitForTimeout(350);const data=await page.locator('.fm-inspector').evaluate(el=>{const body=el.querySelector('.fm-inspector__content');const text=el.innerText;return {text,unavailableCount:(text.match(/unavailable|not available/ig)||[]).length,notApplicableCount:(text.match(/not applicable/ig)||[]).length,controlCount:el.querySelectorAll('input,select,button').length,activeTab:el.querySelector('[role=tab][aria-selected=true]')?.textContent,scrollableDescendants:[...el.querySelectorAll('*')].filter(n=>n.scrollHeight>n.clientHeight+100&&n.clientHeight>0).map(n=>({className:n.className,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight})).slice(0,8),bodyClientHeight:body?.clientHeight,bodyScrollHeight:body?.scrollHeight};});evidence.views.push({name,...data});if(process.env.FULLMAG_UX_SCREENSHOTS !== '0') await page.screenshot({timeout:60000,path:`${out}/current-${name}.png`});}
await page.addInitScript(()=>{window.__FULLMAG_CONFIG__={enableDiagnosticRecorder:true,controlRoomApiBase:location.origin};});
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
 const hash=async name=>{const {createHash}=await import('node:crypto');const bytes=await canvas.screenshot({path:`${out}/${name}.png`});return createHash('sha256').update(bytes).digest('hex');};
 const color=page.getByLabel('Eigen mode field component',{exact:true});
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
 await page.getByRole('combobox',{name:'Mode wavevector',exact:true}).scrollIntoViewIfNeeded();
 await page.screenshot({path:out+'/dispersion-mode-inspector.png'});
 const after=await(await fetch(origin+'/v2/sessions/current/status')).json();if(after.run.run_id!==run)throw Error('Split changed run');
 if(evidence.errors.length||evidence.blockedMutations.length)throw Error('Browser errors or numerical mutation');
 evidence.pass=true;
} catch(e){evidence.failure=String(e);evidence.body=(await page.locator('body').innerText()).slice(-6000);evidence.diagnostics=await page.evaluate(()=>window.__FULLMAG_DIAGNOSTIC_RECORDER_EXPORT__?.()?.streams?.timeline?.filter(x=>/mode-field-overlay|mode-surface-binding/.test(x.name||'')).slice(-25));process.exitCode=1;}finally{await writeFile(`${out}/probe.json`,JSON.stringify(evidence,null,2));await browser.close();console.log(JSON.stringify({pass:evidence.pass,failure:evidence.failure,errors:evidence.errors,blockedMutations:evidence.blockedMutations,panelActions:evidence.panelActions}));}
