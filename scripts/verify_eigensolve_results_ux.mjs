const {chromium}=await import(process.env.FULLMAG_PLAYWRIGHT_MODULE ?? new URL('../apps/control-room/node_modules/playwright/index.mjs',import.meta.url).href);
import {writeFile} from 'node:fs/promises';
const out=process.env.FULLMAG_UX_EVIDENCE ?? '/tmp/fullmag-results-ux';
await (await import('node:fs/promises')).mkdir(out,{recursive:true});
const origin=process.env.FULLMAG_UI_URL ?? 'http://localhost:3217';
const status=await (await fetch(origin+'/v2/sessions/current/status')).json();
const run=status.run.run_id;
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1600,height:1100}});
const evidence={capturedAt:new Date().toISOString(),scope:'Read-only UX inspection in separate browser; no solver submissions or session changes',errors:[],blockedMutations:[],views:[]};
page.on('pageerror', e=>evidence.errors.push(e.message));
await page.route('**/*',async route=>{const q=route.request();const path=new URL(q.url()).pathname;if(['GET','HEAD','OPTIONS'].includes(q.method())||q.method()==='POST'&&path==='/v2/sessions/current/visualization/client-acks')return route.continue();evidence.blockedMutations.push({method:q.method(),path});return route.abort();});
const tree=id=>page.locator(`[role="treeitem"][data-node-id="${id}"]`);
async function expand(id){const n=tree(id);await n.waitFor({timeout:30000});if(await n.getAttribute('aria-expanded')==='false')await n.locator('.fm-explorer-tree-row__branch').first().click();}
async function capture(name){await page.waitForTimeout(350);const data=await page.locator('.fm-inspector').evaluate(el=>{const body=el.querySelector('.fm-inspector__content');const text=el.innerText;return {text,unavailableCount:(text.match(/unavailable|not available/ig)||[]).length,notApplicableCount:(text.match(/not applicable/ig)||[]).length,controlCount:el.querySelectorAll('input,select,button').length,activeTab:el.querySelector('[role=tab][aria-selected=true]')?.textContent,scrollableDescendants:[...el.querySelectorAll('*')].filter(n=>n.scrollHeight>n.clientHeight+100&&n.clientHeight>0).map(n=>({className:n.className,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight})).slice(0,8),bodyClientHeight:body?.clientHeight,bodyScrollHeight:body?.scrollHeight};});evidence.views.push({name,...data});if(process.env.FULLMAG_UX_SCREENSHOTS !== '0') await page.screenshot({timeout:60000,path:`${out}/current-${name}.png`});}
try{
 await page.goto(`${origin}/workspace`,{waitUntil:'domcontentloaded',timeout:60000});
 const analysis=page.locator('.fm-viewport-tabs__trigger').filter({hasText:/^Analysis$/}); if(await analysis.count())await analysis.first().click();
 await page.locator('.fm-explorer .fm-tabs-trigger').filter({hasText:/^Results$/}).click({timeout:60000});
 const root=`results:run:${run}`, family=root+':k-resolved', stage=family+':stage:eigenmodes:modal_eigen';
 await expand(root);await expand(family);await tree(family).click();await capture('category');
 await expand(stage);await expand(stage+':modes-at-k');
 const mode=page.locator('[role="treeitem"][data-node-id]').filter({hasText:/Sample 5 · Mode 0/}).last();
 await mode.click();await page.waitForTimeout(700);await capture('mode-overview');
 const tabs=page.locator('.fm-inspector__tabs [role="tab"]');
 evidence.inspectorTabs=await tabs.allTextContents();
 for(const label of ['Data','Provenance','Diagnostics']){const tab=tabs.filter({hasText:new RegExp('^'+label+'$')});if(await tab.count()){await tab.click();await capture('mode-'+label.toLowerCase());}}
 const modes=evidence.views.filter(v=>v.name.startsWith('mode-'));
 if(new Set(modes.map(v=>v.text)).size!==4)throw Error('Inspector tabs repeat the same content');
 if(evidence.views[0].unavailableCount || evidence.views[0].notApplicableCount)throw Error('Collection masquerades as missing individual result');
 evidence.treeLabels=await page.locator('[role="treeitem"] .fm-explorer-tree-row__label').allTextContents();
}catch(e){evidence.failure=String(e.stack||e);process.exitCode=1;}finally{await writeFile(`${out}/browser-audit.json`,JSON.stringify(evidence,null,2));await browser.close();console.log(JSON.stringify({failure:evidence.failure,errors:evidence.errors,blockedMutations:evidence.blockedMutations,views:evidence.views.map(({text,...v})=>v)}));}
