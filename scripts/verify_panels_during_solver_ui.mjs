// Observer only: a separately submitted, exact real solver run is required.
// Fail if the solver is not running before AND after every panel operation.
const {chromium}=await import(process.env.FULLMAG_PLAYWRIGHT_MODULE ?? new URL('../apps/control-room/node_modules/playwright/index.mjs',import.meta.url).href);
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const out=process.env.FULLMAG_UX_EVIDENCE ?? '/tmp/fullmag-live-panel-proof';await mkdir(out,{recursive:true});
const origin=process.env.FULLMAG_UI_URL ?? 'http://localhost:3217';
let expectedRun=process.env.FULLMAG_EXPECTED_RUN;
const expectedRunFile=process.env.FULLMAG_EXPECTED_RUN_FILE;
if(!expectedRun&&!expectedRunFile)throw Error('FULLMAG_EXPECTED_RUN is required: never attach to an unrelated live run');const b=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});const p=await b.newPage({viewport:{width:1600,height:1100}});p.setDefaultTimeout(60000);
const proof={startedAt:new Date().toISOString(),errors:[],mutations:[],snapshots:[],actions:[]};
p.on('pageerror',e=>proof.errors.push(e.message));
await p.route('**/*',async route=>{const r=route.request(),path=new URL(r.url()).pathname;if(['GET','HEAD','OPTIONS'].includes(r.method())||r.method()==='POST'&&path==='/v2/sessions/current/visualization/client-acks'||r.method()==='PATCH'&&path==='/v2/sessions/current/visualization/state')return route.continue();proof.mutations.push({method:r.method(),path});return route.abort();});
const state=async()=>{const r=await fetch(origin+'/v2/sessions/current/status');if(!r.ok){const error=new Error('Status '+r.status);error.status=r.status;throw error;}const d=await r.json();return {at:new Date().toISOString(),run:d.run?.run_id,steps:d.run?.solver_steps,time:d.run?.solver_time,state:d.solver?.state,stage:d.run?.stage_label,revision:d.revision,session:d.session?.session_id};};
let activeRun;
const observed=async()=>{const s=await state();proof.snapshots.push(s);if(activeRun&&s.run!==activeRun)throw Error('Run identity changed during panel operation');return s;};
async function action(name,fn){const before=await observed();if(before.state!=='running')throw Error('Solver not running before '+name+': '+before.state);await fn();const after=await observed();proof.actions.push({name,before,after});console.log(JSON.stringify({name,state:after.state,run:after.run,steps:after.steps}));if(after.state!=='running')throw Error('Solver ceased running during '+name);await writeFile(out+'/progress.json',JSON.stringify(proof,null,2));}
const menu=(title)=>p.getByRole('button',{name:title+' panel menu',exact:true});
async function choose(title,name){await menu(title).click();await p.getByRole('menuitem',{name,exact:true}).click();}
try{
 await p.goto(origin+'/workspace',{waitUntil:'domcontentloaded',timeout:60000});await menu('Inspector').waitFor();console.log('BROWSER_READY');
 const deadline=Date.now()+600000;
 while(Date.now()<deadline){
  if(!expectedRun&&expectedRunFile){
   try{
    expectedRun=(await readFile(expectedRunFile,'utf8')).trim();
    if(!/^run-live-[a-f0-9]{64}$/.test(expectedRun))throw Error('Invalid expected run file');
   }catch(error){if(error.code!=='ENOENT')throw error;}
  }
  let s;
  try{s=await state();}
  catch(error){
   // Session retirement may reject reads or leave no current session before the new run exists. Never
   // swallow a conflict after attaching: observed() must still fail closed.
   if(error.status!==409 && error.status!==404)throw error;
   proof.preActivationConflicts=(proof.preActivationConflicts??0)+1;
   await p.waitForTimeout(1000);continue;
  }
  if(s.state==='running'&&s.run===expectedRun){activeRun=s.run;proof.initial=s;break;}
  await p.waitForTimeout(1000);
 }
 if(!activeRun)throw Error('No live solver appeared');
 const resizeOnly=process.env.FULLMAG_LIVE_PANEL_CASE==='split-resize-only';
 if(!resizeOnly){
 await action('float diagnostics',()=>choose('Diagnostics','Float panel'));
 await action('dock diagnostics',()=>choose('Diagnostics','Dock panel'));
 await action('float inspector',async()=>{await choose('Inspector','Float panel');await p.locator('[data-panel-frame="panel-right"][data-panel-mode="floating"]').waitFor();});
 const frame=p.locator('[data-panel-frame="panel-right"]');const beforeMove=await frame.boundingBox();
 await action('move inspector',async()=>{const handle=p.getByRole('button',{name:'Move Inspector with arrow keys',exact:true});await handle.focus();await handle.press('ArrowRight');await handle.press('ArrowDown');});
 const moved=await frame.boundingBox();if(!moved||moved.x===beforeMove.x&&moved.y===beforeMove.y)throw Error('Floating inspector did not move');
 const beforeSize=await frame.boundingBox();
 await action('resize inspector',async()=>{const handle=p.getByRole('button',{name:'Resize Inspector with arrow keys',exact:true});await handle.focus();await handle.press('ArrowRight');await handle.press('ArrowDown');});
 const resized=await frame.boundingBox();if(!resized||resized.width===beforeSize.width&&resized.height===beforeSize.height)throw Error('Floating inspector did not resize');
 await action('maximize inspector',()=>choose('Inspector','Maximize panel'));
 await action('restore inspector',()=>choose('Inspector','Restore panel'));
 await action('hide inspector',()=>choose('Inspector','Hide panel'));
 await action('restore hidden inspector',async()=>{await p.locator('[data-restore-panel="panel-right"]').click();});
 await action('dock inspector',()=>choose('Inspector','Dock panel'));

 const drag = async (handle, target) => {
  const r=await handle.boundingBox(); if(!r)throw Error('Missing drag handle');
  await p.mouse.move(r.x+r.width/2,r.y+r.height/2);await p.mouse.down();
  await p.mouse.move(r.x+r.width/2+45,r.y+r.height/2+45,{steps:4});
  const root=await p.locator('#fm-main-content').boundingBox();
  await p.mouse.move(root.x+18,root.y+root.height/2,{steps:5});
  await p.locator('[data-workspace-dock-preview="left"][data-dock-target="workspace"]').waitFor();
  await p.mouse.up();
  await p.locator(`[data-panel-frame="${target}"][data-panel-mode="docked"]`).waitFor();
 };
 await action('mouse drag and edge-dock Inspector title',()=>drag(frame.locator('.fm-panel-chrome__title'),'panel-right'));
 await action('mouse drag and edge-dock Explorer',()=>drag(p.getByRole('button',{name:'Move Explorer with arrow keys',exact:true}),'panel-left'));
 await action('mouse drag and edge-dock Diagnostics',()=>drag(p.getByRole('button',{name:'Move Diagnostics with arrow keys',exact:true}),'panel-bottom'));
 }
 await action('mouse resize docked split',async()=>{
  const h=p.locator('.fm-workspace-docking-tree .fm-resize-handle--vertical').first();await h.waitFor({state:'visible'});
  const r=await h.boundingBox(); const measured=p.locator(`[data-panel-frame="${resizeOnly?'panel-left':'panel-bottom'}"]`);const before=await measured.boundingBox();
  await p.mouse.move(r.x+r.width/2,r.y+r.height/2);await p.mouse.down();await p.mouse.move(r.x+40,r.y+r.height/2,{steps:5});await p.mouse.up();
  await p.waitForTimeout(200);const after=await measured.boundingBox();
  if(Math.abs(after.width-before.width)<10)throw Error('Splitter did not resize');
 });
 await p.screenshot({path:out+'/panels-during-solve.png',timeout:30000});
 if(proof.errors.length||proof.mutations.length)throw Error('Browser errors or solver mutation attempt');
 proof.after=await observed();console.log('PANEL_OPERATIONS_PASS');
 const end=Date.now()+900000;let previous='';
 while(Date.now()<end){const s=await observed();const key=s.state+':'+s.stage;if(key!==previous){console.log(JSON.stringify(s));previous=key;}if(s.state==='completed'){proof.completed=s;break;}if(['failed','cancelled','stopped'].includes(s.state))throw Error('Solver terminal '+s.state);await p.waitForTimeout(3000);}
 if(!proof.completed)throw Error('Solver completion still pending');
 // A completed status alone is insufficient: require the same run's
 // published eigen spectrum, then preserve it beside the lifecycle evidence.
 const publishedDeadline=Date.now()+30000;
 while(Date.now()<publishedDeadline){
  const response=await fetch(origin+'/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v3');
  if(response.ok){const spectrum=await response.json();if(spectrum.run_id===activeRun&&Array.isArray(spectrum.payload?.samples)&&spectrum.payload.samples.some(sample=>Array.isArray(sample.modes)&&sample.modes.length)){
   proof.publishedSpectrum={runId:spectrum.run_id,revision:spectrum.revision,samples:spectrum.payload.samples.length};
   await writeFile(out+'/spectrum.json',JSON.stringify(spectrum,null,2));break;
  }}
  await p.waitForTimeout(1000);
 }
 if(!proof.publishedSpectrum)throw Error('Completed run has no matching published eigen spectrum');
 if(proof.errors.length||proof.mutations.length)throw Error('Browser errors or mutation attempt after panel operations');
 proof.pass=true;
}catch(e){proof.failure=String(e);console.error(e);process.exitCode=1;await p.screenshot({path:out+'/failure.png',timeout:15000}).catch(()=>{});}finally{await writeFile(out+'/report.json',JSON.stringify(proof,null,2));await b.close();}
