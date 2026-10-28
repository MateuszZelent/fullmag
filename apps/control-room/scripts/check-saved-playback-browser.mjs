import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startBrowserQaLoopbackProxy } from "./lib/browser-qa-loopback-proxy.mjs";

const [probeUrl,itemId]=process.argv.slice(2);
const publicUrl=process.env.CONTROL_ROOM_PUBLIC_URL;
assert.equal(process.env.CONTROL_ROOM_BROWSER_QA_SCENARIO,"saved-playback");
assert.equal(probeUrl,"http://frontend:8080");
assert(/^[0-9]{1,20}$/.test(itemId));
const require=createRequire(import.meta.url);
const version=require("playwright/package.json").version;
assert.equal(version,process.env.CONTROL_ROOM_EXPECTED_PLAYWRIGHT_VERSION);
const sha=value=>createHash("sha256").update(value).digest("hex");
const scriptSha=sha(await readFile(fileURLToPath(import.meta.url)));
assert.equal(scriptSha,process.env.CONTROL_ROOM_BROWSER_QA_SAVED_PLAYBACK_SCRIPT_SHA256);
const errors=[],hookErrors=[],payloads=new Map(),solverRequests=[];
let proxy,browser,context,page;
let result;
let evidenceScreenshot;
const networkTrace=[];
const timeout=Math.min(Number(process.env.CONTROL_ROOM_BROWSER_QA_TIMEOUT_MS ?? 180000),180000);
try {
  proxy=await startBrowserQaLoopbackProxy(publicUrl,probeUrl);
  browser=await chromium.launch({headless:true,args:["--no-sandbox","--enable-unsafe-swiftshader","--use-angle=swiftshader-webgl"]});
  context=await browser.newContext({viewport:{width:1500,height:1000},deviceScaleFactor:1,serviceWorkers:"block"});
  page=await context.newPage(); page.setDefaultTimeout(timeout);
  page.on("pageerror",e=>{errors.push(e.message);if(/Rendered (fewer|more) hooks|order of Hooks/i.test(e.message))hookErrors.push(e.message);});
  page.on("console",m=>{if(m.type()==="error" && /Rendered (fewer|more) hooks|Context Lost|WebGL.*error/i.test(m.text())) errors.push(m.text());});
  page.on("request",request=>{
    const path=new URL(request.url()).pathname;
    if(request.method()!=="GET" && /\/v2\/sessions\//.test(path)) solverRequests.push({path,method:request.method()});
  });
  const sessionsBeforeResponse=await context.request.get(proxy.origin+"/v2/sessions");
  assert.equal(sessionsBeforeResponse.status(),200);
  const sessionsBefore=await sessionsBeforeResponse.json();
  assert.equal(sessionsBefore.sessions.length,0,"This qualification must start without a simulation session.");
  for(const event of ["request","requestfinished","requestfailed","response"]) {
    context.on(event,value=>{
      if(value.url().includes("/playback/frames/")) networkTrace.push({event,url:value.url()});
    });
  }
  context.on("response",async response=>{
    const url=new URL(response.url());
    const match=url.pathname.match(new RegExp("/v2/workspace/items/"+itemId+"/playback/frames/([0-9]+)$"));
    if(!match || !response.ok())return;
    try {
      const body=await response.body();
      payloads.set(Number(match[1]),{hash:sha(body),bytes:body.length});
    } catch(error) {networkTrace.push({event:"body-unavailable",message:String(error)});}
  });
  context.on("requestfinished",async request=>{
    const url=new URL(request.url());
    const match=url.pathname.match(new RegExp("/v2/workspace/items/"+itemId+"/playback/frames/([0-9]+)$"));
    if(!match)return;
    const response=await request.response();
    if(response?.ok()) {
      try {
        const body=await response.body();
        payloads.set(Number(match[1]),{hash:sha(body),bytes:body.length});
      } catch(error) {networkTrace.push({event:"finished-body-unavailable",message:String(error)});}
    }
  });
  const detailResponse=await context.request.get(proxy.origin+"/v2/workspace/items/"+itemId);
  assert.equal(detailResponse.status(),200);
  const manifestResponse=await context.request.get(proxy.origin+"/v2/workspace/items/"+itemId+"/playback");
  assert.equal(manifestResponse.status(),200);
  const manifest=await manifestResponse.json();
  assert.equal(manifest.schema,"fullmag.saved_playback.v1");
  const stage=manifest.stages[0];
  assert.equal(stage.frame_count,801,"This qualification targets the complete 801-frame YIG recording.");
  const indices=[0,400,800],expected=[];
  for(const index of indices) {
    const query=new URLSearchParams({stage_id:stage.stage_id,revision:manifest.revision});
    const response=await context.request.get(proxy.origin+"/v2/workspace/items/"+itemId+"/playback/frames/"+index+"?"+query);
    assert.equal(response.status(),200);
    const bytes=await response.body();
    assert.equal(bytes.length,manifest.grid_cells_xyz.reduce((a,b)=>a*b,1)*24);
    expected.push(sha(bytes));
  }
  await page.goto(proxy.origin+"/home",{waitUntil:"domcontentloaded",timeout});
  const row=page.locator("#fm-start-result-"+itemId);
  if(!await row.isVisible()) {
    const filter=page.getByRole("combobox",{name:"Show projects, scripts, results or all"});
    if(await filter.count()) {await filter.click();await page.getByRole("option",{name:"Results",exact:true}).click();}
  }
  await row.waitFor({state:"visible"});
  await row.click();
  await page.locator('button[data-action="open-results-viewer"]').click();
  const inspector=page.getByRole("region",{name:"Saved results playback Inspector"});
  await inspector.waitFor({state:"visible"});
  const inspectorHandle=await inspector.elementHandle();
  const slider=page.getByRole("slider",{name:"Saved frame index"});
  const source=page.getByRole("region",{name:"Saved simulation 3D"});
  const canvas=source.locator("canvas");
  let initialCanvas,initialGeometry,initialInstance,initialCamera;
  const canvasHashes=[];
  for(const index of indices) {
    if(index===0) await slider.press("Home");
    else if(index===800) await slider.press("End");
    else {
      const bounds=await page.locator("#fm-saved-results-frame").boundingBox();
      assert(bounds);
      await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
      for(let attempt=0;attempt<8;attempt++) {
        const value=Number(await slider.getAttribute("aria-valuenow"));
        if(value===index)break;
        await slider.press(value<index?"ArrowRight":"ArrowLeft");
      }
    }
    await page.waitForFunction(({index})=>{
      const s=document.querySelector(".fm-saved-playback-viewport");
      return s?.getAttribute("data-saved-frame-index")===String(index) && s?.getAttribute("data-saved-frame-state")==="ready";
    },{index});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.waitForFunction(({index})=>document.querySelector('[aria-label="Saved frame index"]')?.getAttribute("aria-valuenow")===String(index),{index});
    assert(await inspectorHandle.evaluate(node=>node.isConnected),"Inspector was remounted during scrubbing.");
    const expectedTime=stage.times_s[index]*1e9;
    assert((await source.textContent()).includes(expectedTime.toFixed(3)+" ns"));
    const glState=await canvas.evaluate(node=>{
      const gl=node.getContext("webgl2")??node.getContext("webgl");
      const bounds=node.getBoundingClientRect();
      return {visible:bounds.width>0&&bounds.height>0,lost:gl?.isContextLost()??true,
        size:[gl?.drawingBufferWidth??0,gl?.drawingBufferHeight??0],
        geometry:node.dataset.savedGeometryId,instance:node.dataset.savedInstanceId,camera:node.dataset.savedCameraPose};
    });
    assert(glState.visible && !glState.lost && glState.size.every(v=>v>0));
    assert(glState.geometry && glState.instance && glState.camera);
    if(index===0) {
      initialCanvas=await canvas.elementHandle();
      initialGeometry=glState.geometry;initialInstance=glState.instance;initialCamera=glState.camera;
    } else {
      assert(await initialCanvas.evaluate(node=>node.isConnected),"Canvas was replaced by a frame change.");
      assert.equal(glState.geometry,initialGeometry);assert.equal(glState.instance,initialInstance);
      const currentPose=JSON.parse(glState.camera), firstPose=JSON.parse(initialCamera);
      for(const key of ["position","quaternion"]) {
        assert.equal(currentPose[key].length,firstPose[key].length);
        currentPose[key].forEach((value,i)=>assert(Math.abs(value-firstPose[key][i])<1e-9,"Scrubbing moved the camera."));
      }
    }
    evidenceScreenshot=await canvas.screenshot({type:"png"});
    canvasHashes.push(sha(evidenceScreenshot));
    for(let attempt=0;attempt<500&&!payloads.has(index);attempt++) await page.waitForTimeout(20);
    assert.equal(payloads.get(index)?.hash,expected[indices.indexOf(index)],"UI adopted a different field payload.");
    result={drawing_buffer:glState.size};
  }
  const screenshot=await page.screenshot({type:"png"});
  evidenceScreenshot=screenshot;
  assert(new Set(canvasHashes).size>1,"Different fields did not change the rendered canvas.");
  assert(screenshot.length<=512*1024,"Screenshot exceeds managed evidence bound.");
  await inspector.getByRole("button",{name:"Close playback",exact:true}).click();
  await row.waitFor({state:"visible"});
  assert.equal(await page.locator(".fm-saved-playback-viewport").count(),0);
  assert.deepEqual(errors,[]);
  assert.deepEqual(solverRequests,[],"Read-only playback sent a session mutation.");
  const sessionsAfterResponse=await context.request.get(proxy.origin+"/v2/sessions");
  assert.equal(sessionsAfterResponse.status(),200);
  const sessionsAfter=await sessionsAfterResponse.json();
  assert.equal(sessionsAfter.sessions.length,0,"Opening saved results created a simulation session.");
  result={schema:"fullmag.docker-dev-saved-playback-result.v1",state:"passed",scenario:"saved-playback",
    item_id:itemId,public_url:publicUrl,probe_url:probeUrl,playwright_version:version,
    browser_gpu_mode:process.env.CONTROL_ROOM_BROWSER_GPU_MODE,script_sha256:scriptSha,
    frame_indices:indices,frame_sha256:expected,canvas_visible:true,context_lost:false,
    ...result,field_payloads_verified:true,changed_canvas:true,inspector_stable:true,
    camera_stable:true,hook_errors:hookErrors,errors,screenshot_base64:screenshot.toString("base64")};
} catch(error) {
  try {evidenceScreenshot ??= await page?.screenshot({type:"png",timeout:5000});} catch {}
  result={schema:"fullmag.docker-dev-saved-playback-result.v1",state:"failed",scenario:"saved-playback",
    item_id:itemId,errors:[...errors,error?.stack??String(error)],network_trace:networkTrace.slice(-24),screenshot_base64:evidenceScreenshot?.toString("base64")};
  process.exitCode=1;
} finally {
  await context?.close();await browser?.close();await proxy?.close();
}
process.stdout.write(JSON.stringify(result)+"\n");
