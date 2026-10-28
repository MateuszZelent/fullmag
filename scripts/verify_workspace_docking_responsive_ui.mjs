const {chromium}=await import(process.env.FULLMAG_PLAYWRIGHT_MODULE ?? new URL('../apps/control-room/node_modules/playwright/index.mjs',import.meta.url).href);
import {mkdir,writeFile} from 'node:fs/promises';
const out=process.env.PROBE_OUT ?? '/tmp/fullmag-docking-responsive'; await mkdir(out,{recursive:true});
const b=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const c=await b.newContext({viewport:{width:895,height:1000}});const p=await c.newPage();p.setDefaultTimeout(30000);
const e={errors:[],blocked:[],widths:[]};p.on('pageerror',x=>e.errors.push(x.message));
await c.route('**/*',r=>{const q=r.request(),s=new URL(q.url()).pathname;if(['GET','HEAD','OPTIONS'].includes(q.method())||s==='/v2/sessions/current/visualization/client-acks'||q.method()==='PATCH'&&s==='/v2/sessions/current/visualization/state')return r.continue();e.blocked.push(s);return r.abort();});
try{
await p.goto('http://localhost:3217/workspace',{waitUntil:'domcontentloaded'});
const panel=p.locator('[data-panel-frame="panel-right"]');await panel.waitFor();console.log('Inspector ready');
await panel.getByRole('button',{name:'Inspector panel menu',exact:true}).click();await p.getByRole('menuitem',{name:'Dock to right of workspace',exact:true}).click();await p.waitForTimeout(500);
await p.waitForFunction(()=>document.querySelector('[data-panel-frame="panel-right"]')?.getAttribute('data-panel-mode')==='docked');e.beforeReload=await panel.getAttribute('data-panel-mode');await p.reload({waitUntil:'domcontentloaded'});await panel.waitFor();await p.waitForTimeout(700);e.afterReload=await panel.getAttribute('data-panel-mode');
await p.screenshot({path:out+'/compact-reload.png'});
for(const width of [1600,1180,895,640,390]){console.log('width',width);await p.setViewportSize({width,height:1000});await p.waitForTimeout(300);e.widths.push(await p.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,panels:[...document.querySelectorAll('[data-workspace-pane]')].map(x=>{const f=x.querySelector('[data-panel-frame]'),g=f?.querySelector('.fm-panel-frame__move'),r=g?.getBoundingClientRect();return {id:x.getAttribute('data-workspace-pane'),mode:f?.getAttribute('data-panel-mode'),grip:r?{x:r.x,y:r.y,w:r.width,h:r.height}:null};})})));await p.screenshot({path:out+`/width-${width}.png`});}
await p.setViewportSize({width:1600,height:1100});await p.waitForTimeout(400);
const title=panel.locator('.fm-panel-chrome__title');await title.click();e.titleClick=await panel.getAttribute('data-panel-mode'); const r=await title.boundingBox();
await p.mouse.move(r.x+r.width/2,r.y+r.height/2);await p.mouse.down();await p.mouse.move(r.x+r.width/2-80,r.y+r.height/2+70,{steps:5});await p.waitForTimeout(200);e.titleDrag=await panel.getAttribute('data-panel-mode');await p.keyboard.press('Escape');await p.mouse.up();e.cancelMode=await panel.getAttribute('data-panel-mode');
await panel.locator('.fm-panel-frame__move').hover();await p.getByRole('tooltip').waitFor();e.tooltip=await p.getByRole('tooltip').innerText();
const start=await title.boundingBox();await p.mouse.move(start.x+start.width/2,start.y+start.height/2);await p.mouse.down();await p.mouse.move(start.x-60,start.y+80,{steps:5});await p.waitForTimeout(200);
const root=await p.locator('#fm-main-content').boundingBox();await p.mouse.move(root.x+18,root.y+root.height/2,{steps:5});await p.locator('[data-workspace-dock-preview="left"][data-dock-target="workspace"]').waitFor();await p.mouse.up();await p.waitForTimeout(300);e.titleDrop=await panel.getAttribute('data-panel-mode');e.dockedBounds=await panel.boundingBox();
await p.screenshot({path:out+'/title-drag-docked.png'});
await p.locator('[data-panel-frame="viewport-main"]').getByRole('button',{name:'Viewport panel menu',exact:true}).click();await p.getByRole('menuitem',{name:'Reset panel arrangement',exact:true}).click();
await p.setViewportSize({width:895,height:1000});
await p.getByRole('button',{name:'Arrange modes left and spectrum right',exact:true}).click();await p.waitForTimeout(400);
e.emptyPreset=await p.locator('.fm-viewport-tabs__surface').boundingBox();
await p.screenshot({path:out+'/narrow-preset.png'});
e.pass=e.beforeReload==='docked'&&e.afterReload==='docked'&&e.titleClick==='docked'&&e.titleDrag==='floating'&&e.cancelMode==='docked'&&e.titleDrop==='docked'&&e.emptyPreset.height>100&&!e.errors.length&&!e.blocked.length&&e.widths.every(x=>x.width===x.scroll&&x.panels.every(y=>!y.grip||y.grip.w>=32&&y.grip.h>=32));
if(!e.pass)throw Error('Responsive docking assertion failed');
}catch(err){e.failure=String(err);await p.screenshot({path:out+'/failure.png'}).catch(()=>{});}
await writeFile(out+'/probe.json',JSON.stringify(e,null,2));console.log(JSON.stringify(e));await b.close();if(e.failure||!e.pass)process.exitCode=1;
