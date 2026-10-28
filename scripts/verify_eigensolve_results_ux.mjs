const {chromium}=await import(process.env.FULLMAG_PLAYWRIGHT_MODULE ?? new URL('../apps/control-room/node_modules/playwright/index.mjs',import.meta.url).href);
import {writeFile} from 'node:fs/promises';
const out=process.env.FULLMAG_UX_EVIDENCE ?? '/tmp/fullmag-results-ux';
await (await import('node:fs/promises')).mkdir(out,{recursive:true});
const injectMissingField = process.env.FULLMAG_UX_MISSING_FIELD === '1';
const origin=process.env.FULLMAG_UI_URL ?? 'http://localhost:3217';
const status=await (await fetch(origin+'/v2/sessions/current/status')).json();
const run=status.run.run_id;
const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1600,height:1100}});
const evidence={capturedAt:new Date().toISOString(),scope:'Published-results UX in separate browser; presentation preferences may persist; no solver submissions or result modifications',presentationWrites:[],errors:[],blockedMutations:[],views:[]};
page.on('pageerror', e=>evidence.errors.push(e.message));
await page.route('**/*',async route=>{const q=route.request();const path=new URL(q.url()).pathname;if(q.method()==='PATCH' && path==='/v2/sessions/current/visualization/state'){evidence.presentationWrites.push({method:q.method(),path});return route.continue();}if(injectMissingField && q.method()==='GET' && path.endsWith('/eigen/mode-field/5/0/meta')) return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Injected test: mode metadata unavailable'})});if(['GET','HEAD','OPTIONS'].includes(q.method())||q.method()==='POST'&&path==='/v2/sessions/current/visualization/client-acks')return route.continue();evidence.blockedMutations.push({method:q.method(),path});return route.abort();});
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
 const mode=page.locator('[role="treeitem"][data-node-id*="sample-0005"][data-node-id*="mode-0000"]').last();
 await mode.click();await page.waitForTimeout(700);await capture('mode-overview');
 if(injectMissingField){
   const action=page.getByRole('button',{name:'Show selected eigen mode in 3D',exact:true});
   if(await action.isEnabled())throw Error('Missing required field metadata still permits visualization');
   await page.waitForFunction(()=>/metadata unavailable/i.test(document.querySelector('.fm-inspector')?.textContent ?? ''),{},{timeout:30000});
   evidence.missingRequiredField={activationDisabled:true,reasonVisible:true};
 } else {
 const tabs=page.locator('.fm-inspector__tabs [role="tab"]');
 evidence.inspectorTabs=await tabs.allTextContents();
 for(const label of ['Data','Provenance','Diagnostics']){const tab=tabs.filter({hasText:new RegExp('^'+label+'$')});if(await tab.count()){await tab.click();await capture('mode-'+label.toLowerCase());}}
 await tabs.filter({hasText:/^Data$/}).focus();
 await page.keyboard.press('ArrowRight');
 await page.waitForFunction(()=>document.querySelector('.fm-inspector__tabs [role=tab][aria-selected=true]')?.textContent==='Provenance');
 evidence.keyboardNavigation=true;
 await tabs.filter({hasText:/^Overview$/}).click();
 evidence.overviewLayouts=[];
 for(const viewport of [{width:1600,height:1100},{width:1440,height:900}]){
   await page.setViewportSize(viewport);await page.waitForTimeout(300);
   const container=await page.locator('.fm-inspector').boundingBox();
   const action=await page.getByRole('button',{name:'Show selected eigen mode in 3D',exact:true}).boundingBox();
   if(!container || !action || action.y+action.height>container.y+container.height || action.x+action.width>container.x+container.width)throw Error('Primary mode action clipped');
   evidence.overviewLayouts.push({viewport,container,action});
 }
 await page.setViewportSize({width:1600,height:1100});
 const appearance=page.locator('.fm-inspector').getByRole('button',{name:'Appearance',exact:true});
 await appearance.click();
 const color=page.getByRole('combobox',{name:'Eigen mode field component',exact:true});
 if(await color.isEnabled())throw Error('Inactive mode appearance can edit another field');
 await page.getByRole('button',{name:'Show selected eigen mode in 3D',exact:true}).click();
 await page.waitForFunction(()=>{const el=document.querySelector('select[aria-label="Eigen mode field component"]');return el && !el.disabled;},{},{timeout:30000});
 await color.selectOption('solid');
 if(await page.getByLabel('Eigen mode colormap',{exact:true}).count())throw Error('Solid color exposes scalar colormap');
 await color.selectOption('magnitude');
 await page.getByLabel('Eigen mode color range mode',{exact:true}).selectOption('manual');
 if(!await page.getByLabel('Eigen mode color minimum',{exact:true}).isVisible())throw Error('Manual color minimum missing');
 await page.getByLabel('Eigen mode color range mode',{exact:true}).selectOption('auto');
 if(await page.getByLabel('Eigen mode color minimum',{exact:true}).count())throw Error('Auto range exposes manual minimum');
 await appearance.click();
 await page.getByRole('button',{name:'Back to chart',exact:true}).click();
 await page.locator('[role="treeitem"][data-node-id*="sample-0007"][data-node-id*="mode-0000"]').last().click();
 await page.waitForTimeout(350);
 if(!await page.locator('.fm-inspector').innerText().then(t=>t.includes('Another mode is active')))throw Error('Selected Gamma impersonates previous active field');
 await appearance.click();
 if(await color.isEnabled())throw Error('Changing k leaves old field appearance editable');
 evidence.appearance={inactiveDisabled:true,activeEnabled:true,conditionalControls:true,differentSampleDisabled:true};
 const modes=evidence.views.filter(v=>v.name.startsWith('mode-'));
 if(new Set(modes.map(v=>v.text)).size!==4)throw Error('Inspector tabs repeat the same content');
 if(evidence.views[0].unavailableCount || evidence.views[0].notApplicableCount)throw Error('Collection masquerades as missing individual result');
 if(evidence.errors.length || evidence.blockedMutations.length)throw Error('Unexpected browser error or mutation');
 evidence.treeLabels=await page.locator('[role="treeitem"] .fm-explorer-tree-row__label').allTextContents();
 }
 if(evidence.errors.length || evidence.blockedMutations.length)throw Error('Unexpected browser error or mutation');
}catch(e){evidence.failure=String(e.stack||e);process.exitCode=1;}finally{await writeFile(`${out}/browser-audit.json`,JSON.stringify(evidence,null,2));await browser.close();console.log(JSON.stringify({failure:evidence.failure,errors:evidence.errors,blockedMutations:evidence.blockedMutations,views:evidence.views.map(({text,...v})=>v)}));}
