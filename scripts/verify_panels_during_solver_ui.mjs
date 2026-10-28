// Observer only: a separately submitted, exact real solver run is required.
// Fail if the solver is not running before AND after every panel operation.
const {chromium}=await import(process.env.FULLMAG_PLAYWRIGHT_MODULE ?? new URL('../apps/control-room/node_modules/playwright/index.mjs',import.meta.url).href);
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.env.FULLMAG_UX_EVIDENCE ?? '/tmp/fullmag-live-panel-proof';await mkdir(out,{recursive:true});
const origin=process.env.FULLMAG_UI_URL ?? 'http://localhost:3217';
const expectedRun=process.env.FULLMAG_EXPECTED_RUN;
if(!expectedRun)throw Error('FULLMAG_EXPECTED_RUN is required: never attach to an unrelated live run');const b=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});const p=await b.newPage({viewport:{width:1600,height:1100}});p.setDefaultTimeout(60000);
const proof={startedAt:new Date().toISOString(),errors:[],mutations:[],snapshots:[],actions:[]};
p.on('pageerror',e=>proof.errors.push(e.message));
await p.route('**/*',async route=>{const r=route.request(),path=new URL(r.url()).pathname;if(['GET','HEAD','OPTIONS'].includes(r.method())||r.method()==='POST'&&path==='/v2/sessions/current/visualization/client-acks'||r.method()==='PATCH'&&path==='/v2/sessions/current/visualization/state')return route.continue();proof.mutations.push({method:r.method(),path});return route.abort();});
const state=async()=>{const r=await fetch(origin+'/v2/sessions/current/status');if(!r.ok)throw Error('Status '+r.status);const d=await r.json();return {at:new Date().toISOString(),run:d.run?.run_id,steps:d.run?.solver_steps,time:d.run?.solver_time,state:d.solver?.state,stage:d.run?.stage_label,revision:d.revision,session:d.session?.session_id};};
let activeRun;
const observed=async()=>{const s=await state();proof.snapshots.push(s);if(activeRun&&s.run!==activeRun)throw Error('Run identity changed during panel operation');return s;};
async function action(name,fn){const before=await observed();if(before.state!=='running')throw Error('Solver not running before '+name+': '+before.state);await fn();const after=await observed();proof.actions.push({name,before,after});console.log(JSON.stringify({name,state:after.state,run:after.run,steps:after.steps}));if(after.state!=='running')throw Error('Solver ceased running during '+name);await writeFile(out+'/progress.json',JSON.stringify(proof,null,2));}
const menu=(title)=>p.getByRole('button',{name:title+' panel menu',exact:true});
async function choose(title,name){await menu(title).click();await p.getByRole('menuitem',{name,exact:true}).click();}
try{
 await p.goto(origin+'/workspace',{waitUntil:'domcontentloaded',timeout:60000});await menu('Inspector').waitFor();console.log('BROWSER_READY');
 const deadline=Date.now()+600000;
 while(Date.now()<deadline){const s=await state();if(s.state==='running' && s.run===expectedRun){activeRun=s.run;proof.initial=s;break;}await p.waitForTimeout(1000);}
 if(!activeRun)throw Error('No live solver appeared');
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
 await action('float diagnostics',()=>choose('Diagnostics','Float panel'));
 await action('dock diagnostics',()=>choose('Diagnostics','Dock panel'));
 await p.screenshot({path:out+'/panels-during-solve.png',timeout:30000});
 if(proof.errors.length||proof.mutations.length)throw Error('Browser errors or solver mutation attempt');
 proof.after=await observed();console.log('PANEL_OPERATIONS_PASS');
 const end=Date.now()+900000;let previous='';
 while(Date.now()<end){const s=await observed();const key=s.state+':'+s.stage;if(key!==previous){console.log(JSON.stringify(s));previous=key;}if(s.state==='completed'){proof.completed=s;break;}if(['failed','cancelled','stopped'].includes(s.state))throw Error('Solver terminal '+s.state);await p.waitForTimeout(3000);}
 if(!proof.completed)throw Error('Solver completion still pending');
 proof.pass=true;
}catch(e){proof.failure=String(e);console.error(e);process.exitCode=1;await p.screenshot({path:out+'/failure.png',timeout:15000}).catch(()=>{});}finally{await writeFile(out+'/report.json',JSON.stringify(proof,null,2));await b.close();}
