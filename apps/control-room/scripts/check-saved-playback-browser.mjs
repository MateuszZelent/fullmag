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
let scenarioPhase="setup";
let startupCameraInitialization=null;
let visualizationBaseline;
const networkTrace=[];
const resultPayloads=new Map();
const resultSampleRequests=[];
const visualizationTrace=[];
const timeout=Math.min(Number(process.env.CONTROL_ROOM_BROWSER_QA_TIMEOUT_MS ?? 180000),180000);
try {
  proxy=await startBrowserQaLoopbackProxy(publicUrl,probeUrl);
  browser=await chromium.launch({headless:true,args:["--no-sandbox","--enable-unsafe-swiftshader","--use-angle=swiftshader-webgl"]});
  context=await browser.newContext({viewport:{width:1500,height:1000},deviceScaleFactor:1,serviceWorkers:"block"});
  page=await context.newPage(); page.setDefaultTimeout(timeout);
  page.on("pageerror",e=>{errors.push(e.message);if(/Rendered (fewer|more) hooks|order of Hooks/i.test(e.message))hookErrors.push(e.message);});
  page.on("console",m=>{if(m.type()==="error" && /Rendered (fewer|more) hooks|Context Lost|WebGL.*error/i.test(m.text())) errors.push(m.text());});
  context.on("request",request=>{
    const path=new URL(request.url()).pathname;
    if(/\/results\/arrays\/[^/]+\/samples\/[0-9]+$/.test(path)) resultSampleRequests.push(path);
    // Observer leases and render acknowledgements accompany the restored live
    // viewport. Neither dispatches a command or changes scientific state.
    const observerLease=/^\/v2\/sessions\/current\/clients(?:\/[^/]+)?$/.test(path);
    const renderAck=request.method()==="POST" && path==="/v2/sessions/current/visualization/client-acks";
    if(request.method()!=="GET" && /\/v2\/sessions\//.test(path) && !observerLease && !renderAck) solverRequests.push({path,method:request.method(),phase:scenarioPhase,body:request.postData()?.slice(0,6000) ?? null});
  });
  // Observe every page in this browser context, and retain a bounded trace of
  // remote camera revisions. A global state change is not proof of its caller.
  context.on("response",async response=>{
    if(new URL(response.url()).pathname!=="/v2/sessions/current/visualization/state" || response.status()!==200)return;
    const phase=scenarioPhase;
    try {
      const state=await response.json();
      if(visualizationTrace.length<64 && visualizationTrace.at(-1)?.revision!==state.revision) {
        visualizationTrace.push({phase,method:response.request().method(),revision:state.revision,camera:state.camera});
      }
    } catch {
      // A document navigation may dispose a body before the observer reads it.
      // Mutation requests remain independently recorded above.
    }
  });
  const sessionsBeforeResponse=await context.request.get(proxy.origin+"/v2/sessions");
  assert.equal(sessionsBeforeResponse.status(),200);
  const sessionsBefore=await sessionsBeforeResponse.json();
  const sessionIdsBefore=sessionsBefore.sessions.map(session=>session.id ?? session.session_id).sort();
  const commandsBefore=await context.request.get(proxy.origin+"/v2/sessions/current/simulation/commands");
  assert.equal(commandsBefore.status(),200);
  const commandLedgerBefore=(await commandsBefore.json()).commands;
  for(const event of ["request","requestfinished","requestfailed","response"]) {
    context.on(event,value=>{
      if(value.url().includes("/playback/frames/")) networkTrace.push({event,url:value.url()});
    });
  }
  // Observe the bytes read by the application, including its bounded stream
  // adapter. CDP response.body() can lose cancelled/streamed response bodies.
  // This hook preserves fetch, byte limits, cancellation and returned chunks;
  // only a bounded diagnostic copy is retained until the stream is complete.
  await page.exposeFunction("__fullmagQaRecordBinary",({url,hash,bytes})=>{
    assert(/^[a-f0-9]{64}$/.test(hash));
    assert(Number.isSafeInteger(bytes) && bytes>0 && bytes<=64*1024*1024);
    const path=new URL(url).pathname;
    const frame=path.match(new RegExp("/v2/workspace/items/"+itemId+"/playback/frames/([0-9]+)$"));
    const sample=path.match(new RegExp("/v2/(?:workspace/items/"+itemId+"/results|sessions/current/data/results)/arrays/([^/]+)/samples/([0-9]+)$"));
    if(frame)payloads.set(Number(frame[1]),{hash,bytes});
    else if(sample)resultPayloads.set(decodeURIComponent(sample[1])+":"+sample[2],hash);
    else assert.fail("Unexpected binary observation path.");
    assert(payloads.size+resultPayloads.size<=128,"Binary observation exceeded its key budget.");
  });
  await page.addInitScript(({itemId})=>{
    const originalFetch=window.fetch.bind(window);
    window.fetch=async (...args)=>{
      const response=await originalFetch(...args);
      if(!response.ok || !response.url)return response;
      const path=new URL(response.url).pathname;
      const frame=path.startsWith("/v2/workspace/items/"+itemId+"/playback/frames/");
      const sample=(path.startsWith("/v2/workspace/items/"+itemId+"/results/arrays/")
        || path.startsWith("/v2/sessions/current/data/results/arrays/")) && /\/samples\/[0-9]+$/.test(path);
      if(!frame&&!sample)return response;
      const report=async buffer=>{
        if(buffer.byteLength>64*1024*1024)throw new Error("QA binary observation byte budget exceeded.");
        const digest=await crypto.subtle.digest("SHA-256",buffer);
        const hash=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,"0")).join("");
        await window.__fullmagQaRecordBinary({url:response.url,hash,bytes:buffer.byteLength});
      };
      const arrayBuffer=response.arrayBuffer.bind(response);
      response.arrayBuffer=async ()=>{const buffer=await arrayBuffer();await report(buffer);return buffer;};
      if(response.body) {
        const getReader=response.body.getReader.bind(response.body);
        response.body.getReader=(...readerArgs)=>{
          const reader=getReader(...readerArgs);
          const read=reader.read.bind(reader);
          const chunks=[];
          let size=0,reported=false;
          reader.read=async (...readArgs)=>{
            const next=await read(...readArgs);
            if(next.done && !reported) {
              reported=true;
              const buffer=new Uint8Array(size);
              let offset=0;
              for(const chunk of chunks){buffer.set(chunk,offset);offset+=chunk.byteLength;}
              chunks.length=0;
              await report(buffer.buffer);
            } else if(!next.done) {
              size+=next.value.byteLength;
              if(size>64*1024*1024)throw new Error("QA binary stream observation byte budget exceeded.");
              chunks.push(next.value.slice());
            }
            return next;
          };
          return reader;
        };
      }
      return response;
    };
  },{itemId});
  const detailResponse=await context.request.get(proxy.origin+"/v2/workspace/items/"+itemId);
  assert.equal(detailResponse.status(),200);
  const manifestResponse=await context.request.get(proxy.origin+"/v2/workspace/items/"+itemId+"/playback");
  assert.equal(manifestResponse.status(),200);
  const manifest=await manifestResponse.json();
  assert.equal(manifest.schema,"fullmag.saved_playback.v1");
  const stage=manifest.stages[0];

  assert(Number.isSafeInteger(stage.frame_count) && stage.frame_count>=3 && stage.frame_count<=100000);
  const indices=[0,Math.floor((stage.frame_count-1)/2),stage.frame_count-1],expected=[];
  for(const index of indices) {
    const query=new URLSearchParams({stage_id:stage.stage_id,revision:manifest.revision});
    const response=await context.request.get(proxy.origin+"/v2/workspace/items/"+itemId+"/playback/frames/"+index+"?"+query);
    assert.equal(response.status(),200);
    const bytes=await response.body();
    assert.equal(bytes.length,(manifest.fem_mesh?.node_count ?? manifest.grid_cells_xyz.reduce((a,b)=>a*b,1))*24);
    expected.push(sha(bytes));
  }
  const initialVisualizationResponse=await context.request.get(proxy.origin+"/v2/sessions/current/visualization/state");
  assert.equal(initialVisualizationResponse.status(),200);
  const initialVisualization=await initialVisualizationResponse.json();
  scenarioPhase="initial-home";
  await page.goto(proxy.origin+"/home",{waitUntil:"domcontentloaded",timeout});
  const row=page.locator("#fm-start-result-"+itemId);
  if(!await row.isVisible()) {
    const filter=page.getByRole("combobox",{name:"Show projects, scripts, results or all"});
    if(await filter.count()) {await filter.click();await page.getByRole("option",{name:"Results",exact:true}).click();}
  }
  await row.waitFor({state:"visible"});
  // Home overlays the mounted live workspace. A fresh live camera fits its first
  // bounds and persists that pose after the registry idle interval. Complete this
  // initialization before taking the read-only playback baseline.
  if(initialVisualization.revision===0) {
    for(let attempt=0;attempt<120;attempt++) {
      const response=await context.request.get(proxy.origin+"/v2/sessions/current/visualization/state");
      assert.equal(response.status(),200);
      const state=await response.json();
      if(state.revision!==initialVisualization.revision) {
        assert.equal(solverRequests.length,1,"Unexpected mutations during live camera initialization.");
        const request=solverRequests[0];
        assert.equal(request.phase,"initial-home");
        assert.equal(request.path,"/v2/sessions/current/visualization/state");
        assert.equal(request.method,"PATCH");
        const patch=JSON.parse(request.body);
        assert.deepEqual(Object.keys(patch),["camera"]);
        assert.deepEqual(Object.keys(patch.camera).sort(),["fov_degrees","orthographic_scale","position","projection","target","up"]);
        for(const key of ["position","target","up"]) {
          assert.equal(patch.camera[key].length,3);
          assert(patch.camera[key].every(Number.isFinite));
        }
        assert(Number.isFinite(patch.camera.fov_degrees));
        assert.equal(patch.camera.orthographic_scale,null);
        assert.equal(patch.camera.projection,"perspective");
        startupCameraInitialization={...request,revision_before:initialVisualization.revision,revision_after:state.revision};
        solverRequests.length=0;
        break;
      }
      await page.waitForTimeout(250);
    }
    assert(startupCameraInitialization,"Fresh live camera did not finish initialization before playback.");
  }
  const baselineResponse=await context.request.get(proxy.origin+"/v2/sessions/current/visualization/state");
  assert.equal(baselineResponse.status(),200);
  visualizationBaseline=await baselineResponse.json();
  scenarioPhase="saved-folder-playback";
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
    else if(index===stage.frame_count-1) await slider.press("End");
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
  // Exercise the actual exported-folder browser in the same application group.
  let catalogCursor=null, selectedOutput=null, outputCount=0;
  for(let count=0;count<50;count++) {
    const query=new URLSearchParams({limit:"200",...(catalogCursor?{cursor:catalogCursor}:{})});
    const response=await context.request.get(proxy.origin+"/v2/workspace/items/"+itemId+"/results?"+query);
    assert.equal(response.status(),200);
    const catalog=await response.json();outputCount=catalog.total_count;
    for(const entry of catalog.entries) {
      if(entry.kind!=="zarr_array")continue;
      const response=await context.request.get(proxy.origin+"/v2/workspace/items/"+itemId+"/results/arrays/"+entry.array_id+"?"+new URLSearchParams({revision:catalog.revision}));
      if(!response.ok())continue;
      const array=await response.json();
      if(array.quantity_id==="m" && array.can_visualize_3d && array.sample_count>=3) {selectedOutput={entry,array};break;}
    }
    if(selectedOutput || !catalog.next_cursor)break;
    catalogCursor=catalog.next_cursor;
  }
  assert(selectedOutput,"Result folder has no qualified magnetization array.");
  const sourceDetails=page.getByRole("region",{name:"Saved result outputs",exact:true}).locator("details");
  assert.equal(await sourceDetails.getAttribute("open"),null,"Technical source details should start collapsed.");
  await sourceDetails.locator("summary").click();
  assert((await sourceDetails.textContent()).includes(selectedOutput.array.revision),"Source details lost the full catalog revision.");
  await sourceDetails.locator("summary").click();
  result={...result,source_details_disclosure_verified:true};
  const resultIndices=[0,Math.floor((selectedOutput.array.sample_count-1)/2),selectedOutput.array.sample_count-1];
  const physicalCoordinates=selectedOutput.array.coordinates;
  for(const index of resultIndices) {
    const coordinate=physicalCoordinates.find(value=>value.sample_index===index);
    assert.equal(coordinate?.kind,"physical_time","Saved result is missing its physical-time coordinate.");
    assert(Number.isFinite(coordinate.value),"Saved result has a non-finite physical time.");
  }
  const expectedResults=new Map();
  for(const index of resultIndices) {
    const response=await context.request.get(proxy.origin+"/v2/workspace/items/"+itemId+"/results/arrays/"+selectedOutput.array.id+"/samples/"+index+"?"+new URLSearchParams({revision:selectedOutput.array.revision}));
    assert.equal(response.status(),200);
    expectedResults.set(index,sha(await response.body()));
  }
  const outputRow=page.locator('[data-entry-id="'+selectedOutput.entry.id+'"] > div > [data-entry-select="true"]');
  for(let count=0;count<50 && !await outputRow.count();count++)await page.getByRole("button",{name:"Next page",exact:true}).click();
  const samplesBeforeSelection=resultSampleRequests.length;
  await outputRow.click();
  const outputInspector=page.getByRole("region",{name:"Results output Inspector"});
  await outputInspector.getByRole("slider",{name:"Saved sample index"}).waitFor({state:"visible"});
  assert.equal(await page.getByRole("region",{name:"Inspector",exact:true}).getByRole("tab").count(),0,"Output Inspector exposes inactive generic tabs.");
  result={...result,output_inspector_continuous_sections_verified:true};
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(resultSampleRequests.length,samplesBeforeSelection,"Selecting metadata fetched a decoded sample while its preview was closed.");
  result={...result,closed_values_preview_no_sample_request:true};
  await outputInspector.getByRole("button",{name:"Load into 3D",exact:true}).click();
  const snapshot=page.getByRole("region",{name:"Saved results 3D viewport"});
  await page.waitForFunction(()=>document.querySelector('[data-results-snapshot-status="ready"]'));
  const snapshotCanvas=snapshot.locator("canvas"), retainedCanvas=await snapshotCanvas.elementHandle();
  assert.equal(await page.locator("canvas").count(),1,"Results created a second 3D canvas.");
  const component=outputInspector.getByRole("combobox",{name:"Visualization component"});
  await component.click();await page.getByRole("option",{name:"x",exact:true}).click();
  const resultCanvasHashes=[];
  const resultInspectorHandle=await outputInspector.elementHandle();
  for(const index of [...resultIndices,0]) {
    const slider=outputInspector.getByRole("slider",{name:"Saved sample index"});
    if(index===0)await slider.press("Home");
    else if(index===selectedOutput.array.sample_count-1)await slider.press("End");
    else {
      const bounds=await slider.boundingBox();assert(bounds);
      await page.mouse.click(bounds.x+bounds.width/2,bounds.y+bounds.height/2);
      for(let step=0;step<8;step++) {
        const value=Number(await slider.inputValue());
        if(value===index)break;
        await slider.press(value<index?"ArrowRight":"ArrowLeft");
      }
      assert.equal(Number(await slider.inputValue()),index);
    }
    await page.waitForFunction(index=>document.querySelector('[data-results-snapshot-status="ready"]')?.getAttribute("data-results-snapshot-index")===String(index),index);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert(await resultInspectorHandle.evaluate(node=>node.isConnected),"Results Inspector remounted while scrubbing.");
    assert(await retainedCanvas.evaluate(node=>node.isConnected),"Results canvas remounted while scrubbing.");
    const key=selectedOutput.array.id+":"+index;
    for(let attempt=0;attempt<500&&!resultPayloads.has(key);attempt++)await page.waitForTimeout(20);
    assert.equal(resultPayloads.get(key),expectedResults.get(index),"Results UI received a different sample payload.");
    resultCanvasHashes.push(sha(await snapshotCanvas.screenshot({type:"png"})));
  }
  // Hold one uncached sample request so the real renderer must show a
  // truthful retained frame, then release the original backend response.
  let delayedIndex=null;
  for(let index=1;index<selectedOutput.array.sample_count;index++) {
    if(!resultSampleRequests.some(path=>path.endsWith("/samples/"+index))) {delayedIndex=index;break;}
  }
  assert(delayedIndex!==null,"Latency proof needs an uncached saved sample.");
  const delayedPath="/v2/workspace/items/"+itemId+"/results/arrays/"+selectedOutput.array.id+"/samples/"+delayedIndex;
  const delayedRoute=url=>decodeURIComponent(url.pathname)===delayedPath;
  let releaseSample;
  let heldRequest=false;
  const sampleGate=new Promise(resolve=>{releaseSample=resolve;});
  const holdSample=async route=>{heldRequest=true;await sampleGate;await route.continue();};
  await page.route(delayedRoute,holdSample);
  try {
    const beforePose=await snapshotCanvas.getAttribute("data-saved-camera-pose");
    const beforeLegend=await snapshot.getByLabel("Saved result color scale").textContent();
    const sampleSlider=outputInspector.getByRole("slider",{name:"Saved sample index"});
    for(let index=0;index<delayedIndex;index++)await sampleSlider.press("ArrowRight");
    await page.waitForFunction(index=>{
      const view=document.querySelector('[data-results-snapshot-status="loading"]');
      return view?.getAttribute("data-results-snapshot-index")===String(index)
        && view?.getAttribute("data-results-snapshot-displayed-index")==="0";
    },delayedIndex);
    for(let attempt=0;attempt<500&&!heldRequest;attempt++)await page.waitForTimeout(20);
    assert(heldRequest,"The expected sample request was not delayed.");
    assert(await retainedCanvas.evaluate(node=>node.isConnected),"Loading the next sample remounted the canvas.");
    assert.equal(await snapshotCanvas.getAttribute("data-saved-camera-pose"),beforePose,"Pending sample changed the camera.");
    assert.equal(await snapshot.getByLabel("Saved result color scale").textContent(),beforeLegend,"Pending sample relabelled the retained colors.");
    assert((await snapshot.textContent()).includes("Requested:"),"Pending sample is not distinguished from the displayed frame.");
    const pendingScreenshot=await snapshot.screenshot({type:"png"});
    assert(pendingScreenshot.length<=512*1024);
    result={...result,pending_snapshot_screenshot_base64:pendingScreenshot.toString("base64")};
    releaseSample();
    await page.waitForFunction(index=>{
      const view=document.querySelector('[data-results-snapshot-status="ready"]');
      return view?.getAttribute("data-results-snapshot-index")===String(index)
        && view?.getAttribute("data-results-snapshot-displayed-index")===String(index);
    },delayedIndex);
    const expectedResponse=await context.request.get(proxy.origin+delayedPath+"?"+new URLSearchParams({revision:selectedOutput.array.revision}));
    assert.equal(expectedResponse.status(),200);
    const expectedHash=sha(await expectedResponse.body());
    const delayedKey=selectedOutput.array.id+":"+delayedIndex;
    for(let attempt=0;attempt<500&&!resultPayloads.has(delayedKey);attempt++)await page.waitForTimeout(20);
    assert.equal(resultPayloads.get(delayedKey),expectedHash,"Released sample differs from its saved output.");
    result={...result,pending_snapshot_retained_verified:true,delayed_sample_index:delayedIndex};
    await sampleSlider.press("Home");
    await page.waitForFunction(()=>document.querySelector('[data-results-snapshot-status="ready"]')?.getAttribute("data-results-snapshot-index")==="0");
  } finally {
    releaseSample();
    await page.unroute(delayedRoute,holdSample);
  }
  // Inject a read failure for an uncached frame. The retained image must keep
  // its actual coordinate/legend and a later selection must recover normally.
  const failedIndex=selectedOutput.array.sample_count-2;
  assert(!resultSampleRequests.some(path=>path.endsWith("/samples/"+failedIndex)),"Error proof requires an uncached penultimate sample.");
  const failedPath="/v2/workspace/items/"+itemId+"/results/arrays/"+selectedOutput.array.id+"/samples/"+failedIndex;
  const failedRoute=url=>decodeURIComponent(url.pathname)===failedPath;
  let failedRequests=0;
  const failSample=async route=>{failedRequests++;await route.fulfill({status:503,json:{code:"qa_sample_unavailable",message:"QA saved sample temporarily unavailable"}});};
  const errorSlider=outputInspector.getByRole("slider",{name:"Saved sample index"});
  await errorSlider.press("End");
  await page.waitForFunction(index=>document.querySelector('[data-results-snapshot-status="ready"]')?.getAttribute("data-results-snapshot-displayed-index")===String(index),failedIndex+1);
  const errorPose=await snapshotCanvas.getAttribute("data-saved-camera-pose");
  const errorLegend=await snapshot.getByLabel("Saved result color scale").textContent();
  await page.route(failedRoute,failSample);
  try {
    await errorSlider.press("ArrowLeft");
    await page.waitForFunction(index=>{
      const view=document.querySelector('[data-results-snapshot-status="error"]');
      return view?.getAttribute("data-results-snapshot-index")===String(index)
        && view?.getAttribute("data-results-snapshot-displayed-index")===String(index+1);
    },failedIndex);
    assert(failedRequests>0,"The requested sample did not reach the controlled failure.");
    await snapshot.getByRole("alert").waitFor({state:"visible"});
    assert(await retainedCanvas.evaluate(node=>node.isConnected),"Sample read failure replaced the canvas.");
    assert.equal(await snapshotCanvas.getAttribute("data-saved-camera-pose"),errorPose,"Read failure changed the camera.");
    assert.equal(await snapshot.getByLabel("Saved result color scale").textContent(),errorLegend,"Read failure relabelled the retained colors.");
    assert((await snapshot.textContent()).includes("Requested:"),"Read failure hides the requested/displayed distinction.");
    assert(await snapshot.getByRole("button",{name:"Return to live",exact:true}).isEnabled(),"Read failure disabled return to live.");
    const errorScreenshot=await snapshot.screenshot({type:"png"});
    assert(errorScreenshot.length<=512*1024);
    result={...result,sample_error_screenshot_base64:errorScreenshot.toString("base64")};
  } finally {
    await page.unroute(failedRoute,failSample);
  }
  await errorSlider.press("End");
  await page.waitForFunction(index=>document.querySelector('[data-results-snapshot-status="ready"]')?.getAttribute("data-results-snapshot-displayed-index")===String(index),failedIndex+1);
  await errorSlider.press("ArrowLeft");
  await page.waitForFunction(index=>document.querySelector('[data-results-snapshot-status="ready"]')?.getAttribute("data-results-snapshot-displayed-index")===String(index),failedIndex);
  const recoveredResponse=await context.request.get(proxy.origin+failedPath+"?"+new URLSearchParams({revision:selectedOutput.array.revision}));
  assert.equal(recoveredResponse.status(),200);
  const recoveredHash=sha(await recoveredResponse.body());
  for(let attempt=0;attempt<500&&!resultPayloads.has(selectedOutput.array.id+":"+failedIndex);attempt++)await page.waitForTimeout(20);
  assert.equal(resultPayloads.get(selectedOutput.array.id+":"+failedIndex),recoveredHash,"Recovered sample differs from persisted data.");
  await errorSlider.press("Home");
  await page.waitForFunction(()=>document.querySelector('[data-results-snapshot-status="ready"]')?.getAttribute("data-results-snapshot-displayed-index")==="0");
  result={...result,sample_read_error_retained_verified:true,sample_read_error_reselection_recovered:true,failed_sample_index:failedIndex};
  assert(new Set(resultCanvasHashes.slice(0,3)).size>1,"Results samples did not change the rendered canvas.");
  assert.equal((await component.textContent()).trim(),"x","Snapshot appearance was not retained.");
  assert(await retainedCanvas.evaluate(node=>node.isConnected),"Scrubbing replaced the shared canvas.");
  const snapshotGl=await snapshotCanvas.evaluate(node=>{const gl=node.getContext("webgl2")??node.getContext("webgl");return {lost:gl?.isContextLost()??true,width:gl?.drawingBufferWidth??0,height:gl?.drawingBufferHeight??0};});
  assert(!snapshotGl.lost&&snapshotGl.width>0&&snapshotGl.height>0);
  result={...result,results_browser_verified:true,output_count:outputCount,per_snapshot_settings_retained:true};
  await page.locator('[data-diagnostics-source="live-session"]').waitFor({state:"visible"});
  for(const panel of [
    {id:"panel-right",menu:"Inspector panel menu",restore:"Restore Inspector"},
    {id:"panel-left",menu:"Saved folder panel menu",restore:"Restore Saved folder"},
    {id:"panel-bottom",menu:"Diagnostics panel menu",restore:"Restore Diagnostics"},
  ]) {
    const frame=page.locator('[data-panel-frame="'+panel.id+'"]');
    await page.getByRole("button",{name:panel.menu,exact:true}).click();
    await page.getByRole("menuitem",{name:"Hide panel",exact:true}).click();
    await frame.waitFor({state:"hidden"});
    await page.getByRole("button",{name:panel.restore,exact:true}).click();
    await frame.waitFor({state:"visible"});
    assert(await retainedCanvas.evaluate(node=>node.isConnected),"Hiding a panel replaced the snapshot canvas.");
    assert(await resultInspectorHandle.evaluate(node=>node.isConnected),"Hiding a panel remounted the Inspector.");
  }
  const folderFrame=page.locator('[data-panel-frame="panel-left"]');
  await page.getByRole("button",{name:"Saved folder panel menu",exact:true}).click();
  await page.getByRole("menuitem",{name:"Float panel",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-panel-frame="panel-left"]')?.getAttribute("data-panel-mode")==="floating");
  await page.getByRole("button",{name:"Saved folder panel menu",exact:true}).click();
  await page.getByRole("menuitem",{name:"Dock panel",exact:true}).click();
  assert.equal(await folderFrame.getAttribute("data-panel-mode"),"docked");
  result={...result,saved_panels_hide_restore_verified:true,saved_folder_float_dock_verified:true};
  const layoutChecks=[];
  let compactScreenshot;
  for(const viewport of [{width:1280,height:900},{width:1024,height:900},{width:768,height:900},{width:1920,height:1080},{width:1500,height:1000}]) {
    await page.setViewportSize(viewport);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const layout=await page.evaluate(()=>({
      width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
      results_tree_boxes:[...document.querySelectorAll('[aria-label="Saved result outputs"], [aria-label="Result output entries"]')].map(node=>({label:node.getAttribute("aria-label"),x:node.getBoundingClientRect().x,width:node.getBoundingClientRect().width,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,scrollLeft:node.scrollLeft})),
      primary_controls:[...document.querySelectorAll('[aria-label="Saved sample index"], [aria-label="Visualization component"]')].map(node=>{const r=node.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {label:node.getAttribute("aria-label"),center_visible:Boolean(hit && (hit===node || node.contains(hit)))};}),
      tree_labels:[...document.querySelectorAll('[data-entry-select="true"][data-entry-kind="zarr_array"] > span:first-child')].map(node=>({text:node.textContent,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth})),
      scrolled_elements:[...document.querySelectorAll("*")].filter(node=>node.scrollLeft>0).map(node=>({tag:node.tagName,role:node.getAttribute("role"),className:typeof node.className==="string"?node.className:"",scrollLeft:node.scrollLeft,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,x:node.getBoundingClientRect().x})).slice(0,15),
    }));
    result={...result,layout_checks:[...layoutChecks,{...viewport,...layout}]};
    assert(layout.scrollWidth<=layout.width+1,"Results layout causes page-wide horizontal overflow.");
    assert(layout.results_tree_boxes.every(box=>box.scrollLeft===0 && box.scrollWidth<=box.clientWidth+1),"Result tree is wider than its panel or has scrolled its labels out of view.");
    assert(layout.tree_labels.length>=3 && layout.tree_labels.every(label=>label.clientWidth>0 && label.scrollWidth<=label.clientWidth+1),"The narrow output tree obscures a field or table name.");
    const reachableControls=[];
    for(const control of [outputInspector.getByRole("slider",{name:"Saved sample index"}),component]) {
      await control.scrollIntoViewIfNeeded();
      await control.click({trial:true});
      const probe=await control.evaluate(node=>{
        const r=node.getBoundingClientRect();
        const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
        return {label:node.getAttribute("aria-label"),center_visible:Boolean(hit && (hit===node || node.contains(hit)))};
      });
      assert(probe.center_visible,"Primary Inspector control remains obscured after scrolling: "+probe.label);
      reachableControls.push(probe);
    }
    layoutChecks.push({...viewport,...layout,reachable_controls:reachableControls});
    if(viewport.width===1280)compactScreenshot=await page.screenshot({type:"png"});
  }
  assert(layoutChecks.every(value=>value.reachable_controls.every(control=>control.center_visible)),"Snapshot navigation or component controls cannot be reached inside the Inspector.");
  assert(compactScreenshot.length<=512*1024);
  result={...result,layout_checks:layoutChecks,compact_screenshot_base64:compactScreenshot.toString("base64")};
  const fitPose=JSON.parse(await snapshotCanvas.getAttribute("data-saved-camera-pose"));
  await snapshotCanvas.hover();
  await page.mouse.wheel(0,450);
  await page.waitForFunction(before=>{
    const pose=JSON.parse(document.querySelector(".fm-results-snapshot-canvas canvas")?.getAttribute("data-saved-camera-pose")??"null");
    return pose && pose.position.some((value,index)=>Math.abs(value-before.position[index])>1e-9);
  },fitPose);
  const zoomedPose=await snapshotCanvas.getAttribute("data-saved-camera-pose");
  await page.getByRole("button",{name:"Fit view",exact:true}).click();
  await page.waitForFunction(before=>document.querySelector(".fm-results-snapshot-canvas canvas")?.getAttribute("data-saved-camera-pose")!==before,zoomedPose);
  const fittedPose=JSON.parse(await snapshotCanvas.getAttribute("data-saved-camera-pose"));
  assert(fittedPose.position.every(Number.isFinite));
  result={...result,saved_camera_fit_verified:true};
  const screenshot=await page.screenshot({type:"png"});
  evidenceScreenshot=screenshot;
  assert(new Set(canvasHashes).size>1,"Different fields did not change the rendered canvas.");
  assert(screenshot.length<=512*1024,"Screenshot exceeds managed evidence bound.");
  scenarioPhase="first-return-live";
  await snapshot.getByRole("button",{name:"Return to live",exact:true}).click();
  assert.equal(await page.locator('[data-results-snapshot-status]').count(),0);
  await page.getByRole("button",{name:"Return to live",exact:true}).waitFor({state:"hidden"});
  await page.getByRole("heading",{name:"Result output",exact:true}).waitFor({state:"hidden"});
  const liveViewport=page.getByRole("region",{name:"3D viewport",exact:true});
  await liveViewport.waitFor({state:"visible"});
  assert.equal(await liveViewport.getAttribute("data-view-source"),"current");
  const liveCanvas=liveViewport.locator("canvas");
  await liveCanvas.waitFor({state:"visible"});
  const liveGl=await liveCanvas.evaluate(node=>{const gl=node.getContext("webgl2")??node.getContext("webgl");const rect=node.getBoundingClientRect();return {visible:rect.width>0&&rect.height>0,lost:gl?.isContextLost()??true,width:gl?.drawingBufferWidth??0,height:gl?.drawingBufferHeight??0};});
  assert(liveGl.visible&&!liveGl.lost&&liveGl.width>0&&liveGl.height>0,"Return to live did not restore a visible working 3D canvas.");
  const liveScreenshot=await page.screenshot({type:"png"});
  assert(liveScreenshot.length<=512*1024);
  result={...result,live_screenshot_base64:liveScreenshot.toString("base64"),live_return_verified:true,live_view_source:"current",live_drawing_buffer:[liveGl.width,liveGl.height],results_sample_indices:resultIndices,results_sample_sha256:[...expectedResults.values()],results_canvas_changed:true};
  // Repeat through Explorer > Results for the just-completed live run.
  const currentCatalogResponse=await context.request.get(proxy.origin+"/v2/sessions/current/data/results");
  assert.equal(currentCatalogResponse.status(),200);
  const currentCatalog=await currentCatalogResponse.json();
  const currentEntry=currentCatalog.entries.find(entry=>entry.array_id===selectedOutput.array.id);
  assert(currentEntry,"Current run does not expose the saved magnetization array.");
  resultPayloads.clear();
  const explorer=page.getByRole("region",{name:"Explorer",exact:true});
  await explorer.getByRole("tab",{name:"Results",exact:true}).click();
  const currentRow=explorer.locator('[data-entry-id="'+currentEntry.id+'"] > div > [data-entry-select="true"]');
  // An uncommitted Model Builder draft must survive both Results entry paths.
  // Only edit local form state; never Apply or change the scientific session.
  scenarioPhase="object-draft-navigation";
  await explorer.getByRole("tab",{name:"Model",exact:true}).click();
  for(const nodeId of ["model:session","model:objects"]) {
    const node=explorer.locator('[data-node-id="'+nodeId+'"]');
    await node.waitFor({state:"visible"});
    if(await node.getAttribute("aria-expanded")==="false")await node.locator(".fm-explorer-tree-row__branch").click();
  }
  const objectNode=explorer.locator('[role="treeitem"][data-node-id^="model:object:"]').first();
  await objectNode.click();
  const objectName=page.locator(".fm-inspector").getByRole("textbox",{name:"Name",exact:true});
  await objectName.waitFor({state:"visible"});
  const originalObjectName=await objectName.inputValue();
  const draftObjectName=originalObjectName+" QA unsaved draft";
  await objectName.fill(draftObjectName);
  await explorer.getByRole("tab",{name:"Results",exact:true}).click();
  await currentRow.click();
  const dirtyDialog=page.getByRole("dialog",{name:"Unapplied Inspector changes",exact:true});
  await dirtyDialog.waitFor({state:"visible"});
  await dirtyDialog.getByRole("button",{name:"Cancel",exact:true}).click();
  assert.equal(await objectName.inputValue(),draftObjectName,"Cancelling Results selection lost the object draft.");
  assert.equal(await liveViewport.getAttribute("data-view-source"),"current");
  assert.equal(await page.locator('[data-results-snapshot-status]').count(),0);
  await page.getByRole("tablist",{name:"Ribbon tabs",exact:true}).getByRole("tab",{name:"Results",exact:true}).click();
  await page.getByRole("tablist",{name:"Results source",exact:true}).getByRole("tab",{name:"Saved",exact:true}).click();
  const guardedFolders=page.getByRole("region",{name:"Workspace result folders",exact:true});
  await guardedFolders.locator('[data-workspace-result-id="'+itemId+'"] button').click();
  await guardedFolders.getByRole("alert").filter({hasText:"Apply or cancel the current object edit"}).waitFor({state:"visible"});
  assert.equal(await objectName.inputValue(),draftObjectName,"Opening a saved folder lost the object draft.");
  assert.equal(await page.locator('[data-saved-results-playback="read-only"]').count(),0);
  await page.getByRole("tablist",{name:"Ribbon tabs",exact:true}).getByRole("tab",{name:"Workspace",exact:true}).click();
  await explorer.getByRole("tab",{name:"Results",exact:true}).click();
  await currentRow.click();
  await dirtyDialog.waitFor({state:"visible"});
  await dirtyDialog.getByRole("button",{name:"Discard",exact:true}).click();
  await outputInspector.waitFor({state:"visible"});
  await explorer.getByRole("tab",{name:"Model",exact:true}).click();
  await objectNode.click();
  assert.equal(await objectName.inputValue(),originalObjectName,"Discard did not restore the persisted object name.");
  await explorer.getByRole("tab",{name:"Results",exact:true}).click();
  result={...result,object_draft_cancel_preserved:true,object_draft_saved_folder_guarded:true,object_draft_discard_verified:true};
  if(manifest.fem_mesh) {
    scenarioPhase="airbox-draft-navigation";
    await explorer.getByRole("tab",{name:"Model",exact:true}).click();
    for(const nodeId of ["model:universe","model:airbox","model:airbox:mesh"]) {
      const node=explorer.locator('[data-node-id="'+nodeId+'"]');
      await node.waitFor({state:"visible"});
      if(await node.getAttribute("aria-expanded")==="false")await node.locator(".fm-explorer-tree-row__branch").click();
    }
    const airboxNode=explorer.locator('[data-node-id="model:airbox:mesh:parameters"]');
    await airboxNode.click();
    const airboxSize=page.locator(".fm-inspector").getByRole("textbox",{name:"Maximum element size",exact:true});
    await airboxSize.waitFor({state:"visible"});
    // This FEM fixture has an authored positive hmax. Visibility precedes the
    // asynchronous policy read, so do not capture its temporary empty draft.
    await page.waitForFunction(node=>Number(node.value)>0,await airboxSize.elementHandle());
    const originalAirboxSize=await airboxSize.inputValue();
    const draftAirboxSize=String(Number(originalAirboxSize)*1.25);
    await airboxSize.fill(draftAirboxSize);
    await explorer.getByRole("tab",{name:"Results",exact:true}).click();
    await currentRow.click();
    await dirtyDialog.waitFor({state:"visible"});
    await dirtyDialog.getByRole("button",{name:"Cancel",exact:true}).click();
    assert.equal(await airboxSize.inputValue(),draftAirboxSize,"Cancelling Results selection lost the Airbox draft.");
    await page.getByRole("tablist",{name:"Ribbon tabs",exact:true}).getByRole("tab",{name:"Results",exact:true}).click();
    await page.getByRole("tablist",{name:"Results source",exact:true}).getByRole("tab",{name:"Saved",exact:true}).click();
    await guardedFolders.locator('[data-workspace-result-id="'+itemId+'"] button').click();
    await guardedFolders.getByRole("alert").filter({hasText:"Choose Apply or Cancel for pending Inspector changes"}).waitFor({state:"visible"});
    assert.equal(await airboxSize.inputValue(),draftAirboxSize,"Opening a saved folder lost the Airbox draft.");
    assert.equal(await page.locator('[data-saved-results-playback="read-only"]').count(),0);
    await page.getByRole("tablist",{name:"Ribbon tabs",exact:true}).getByRole("tab",{name:"Workspace",exact:true}).click();
    await explorer.getByRole("tab",{name:"Results",exact:true}).click();
    await currentRow.click();
    await dirtyDialog.waitFor({state:"visible"});
    await dirtyDialog.getByRole("button",{name:"Discard",exact:true}).click();
    await outputInspector.waitFor({state:"visible"});
    await explorer.getByRole("tab",{name:"Model",exact:true}).click();
    await airboxNode.click();
    assert.equal(await airboxSize.inputValue(),originalAirboxSize,"Discard did not restore the persisted Airbox policy.");
    await explorer.getByRole("tab",{name:"Results",exact:true}).click();
    result={...result,airbox_draft_cancel_preserved:true,airbox_draft_saved_folder_guarded:true,airbox_draft_discard_verified:true};
  }
  scenarioPhase="current-result-playback";
  await currentRow.click();
  const currentTreeitem=explorer.locator('[data-entry-id="'+currentEntry.id+'"]');
  assert(await currentTreeitem.evaluate(node=>document.activeElement===node),"Clicking the result did not focus its treeitem.");
  await currentTreeitem.press("Enter");
  assert.equal(await currentTreeitem.getAttribute("aria-selected"),"true","Keyboard selection bubbled into a parent output.");
  assert.equal(await currentTreeitem.getAttribute("tabindex"),"0","Focused result is not the roving tree tab stop.");
  await outputInspector.getByRole("button",{name:"Load into 3D",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-results-snapshot-status="ready"]'));
  await explorer.getByRole("tab",{name:"Model",exact:true}).click();
  await objectNode.click();
  const historicalContext=page.getByRole("region",{name:"Historical viewport context",exact:true});
  await historicalContext.waitFor({state:"visible"});
  assert.equal(await page.locator('[data-results-snapshot-status="ready"]').count(),1);
  const modelContextScreenshot=await page.screenshot({type:"png"});
  assert(modelContextScreenshot.length<=512*1024);
  result={...result,model_context_screenshot_base64:modelContextScreenshot.toString("base64")};
  await objectName.fill(draftObjectName);
  await historicalContext.getByRole("button",{name:"Return to live",exact:true}).click();
  await liveViewport.waitFor({state:"visible"});
  assert.equal(await liveViewport.getAttribute("data-view-source"),"current");
  assert.equal(await objectName.inputValue(),draftObjectName,"Return to live discarded the current model draft.");
  assert.equal(await objectNode.getAttribute("aria-selected"),"true","Return to live changed the selected model object.");
  await historicalContext.waitFor({state:"hidden"});
  assert.equal(await page.locator('[data-results-snapshot-status]').count(),0);
  await explorer.getByRole("tab",{name:"Results",exact:true}).click();
  await currentRow.click();
  await dirtyDialog.waitFor({state:"visible"});
  await dirtyDialog.getByRole("button",{name:"Discard",exact:true}).click();
  await outputInspector.getByRole("button",{name:"Load into 3D",exact:true}).click();
  result={...result,model_inspector_historical_context_verified:true,return_live_preserves_model_draft:true};
  for(const index of [0,selectedOutput.array.sample_count-1,0]) {
    await outputInspector.getByRole("slider",{name:"Saved sample index"}).press(index===0?"Home":"End");
    await page.waitForFunction(index=>document.querySelector('[data-results-snapshot-status="ready"]')?.getAttribute("data-results-snapshot-index")===String(index),index);
    const key=selectedOutput.array.id+":"+index;
    for(let attempt=0;attempt<500&&!resultPayloads.has(key);attempt++)await page.waitForTimeout(20);
    assert.equal(resultPayloads.get(key),expectedResults.get(index),"Current-run Inspector did not adopt the saved sample.");
  }
  scenarioPhase="current-result-playback";
  const lastSample=selectedOutput.array.sample_count-1;
  await outputInspector.getByRole("slider",{name:"Saved sample index"}).press("End");
  await page.waitForFunction(index=>document.querySelector('[data-results-snapshot-status="ready"]')?.getAttribute("data-results-snapshot-index")===String(index),lastSample);
  const fileEntry=currentCatalog.entries.find(entry=>entry.kind==="file" && entry.path.endsWith(".json"));
  assert(fileEntry,"Current results lack a metadata file for the reselection check.");
  await explorer.locator('[data-entry-id="'+fileEntry.id+'"] > div > [data-entry-select="true"]').click();
  await outputInspector.getByRole("heading",{name:"File preview",exact:true}).waitFor({state:"visible"});
  await currentRow.click();
  assert.equal(Number(await outputInspector.getByRole("slider",{name:"Saved sample index"}).inputValue()),lastSample,"Reopening the displayed dataset reset its Inspector sample.");
  assert.equal(await snapshot.getAttribute("data-results-snapshot-index"),String(lastSample));
  result={...result,sample_reselection_verified:true};
  // Tables must expose their persisted column names, not anonymous values.
  const tableEntry=currentCatalog.entries.find(entry=>entry.kind==="zarr_array" && entry.path.endsWith("/table"));
  assert(tableEntry,"The completed run lacks its autosave table.");
  const tableBase=proxy.origin+"/v2/sessions/current/data/results/arrays/"+tableEntry.array_id;
  const tableResponse=await context.request.get(tableBase+"?"+new URLSearchParams({revision:currentCatalog.revision}));
  assert.equal(tableResponse.status(),200);
  const table=await tableResponse.json();
  const tableColumns=["t","step","mx","my","mz","e_total"];
  assert.deepEqual(table.quantity_ids,tableColumns,"Results API lost the persisted table column order.");
  assert(table.can_read_values && !table.can_visualize_3d);
  await explorer.locator('[data-entry-id="'+tableEntry.id+'"] > div > [data-entry-select="true"]').click();
  const decodedValues=outputInspector.getByRole("button",{name:"Decoded values",exact:true});
  if(await decodedValues.getAttribute("aria-expanded")!=="true")await decodedValues.click();
  for(const index of [0,table.sample_count-1]) {
    await outputInspector.getByRole("slider",{name:"Saved sample index"}).press(index===0?"Home":"End");
    const expectedTable=await context.request.get(tableBase+"/samples/"+index+"?"+new URLSearchParams({revision:table.revision}));
    assert.equal(expectedTable.status(),200);
    const expectedBytes=await expectedTable.body();
    assert.equal(expectedBytes.length,tableColumns.length*8);
    const key=table.id+":"+index;
    for(let attempt=0;attempt<500&&!resultPayloads.has(key);attempt++)await page.waitForTimeout(20);
    assert.equal(resultPayloads.get(key),sha(expectedBytes),"Table Inspector loaded a different sample.");
    await page.waitForFunction(columns=>{
      const group=[...document.querySelectorAll('[data-slot="inspector-group"]')]
        .find(node=>node.querySelector("h3")?.textContent==="Decoded values");
      const items=[...(group?.querySelectorAll("ol li")??[])].map(node=>node.textContent);
      return items.length===columns.length && columns.every((column,index)=>items[index].startsWith(column+": "));
    },tableColumns);
  }
  result={...result,table_columns_verified:tableColumns,table_sample_indices:[0,table.sample_count-1]};
  await currentRow.click();
  assert.equal(Number(await outputInspector.getByRole("slider",{name:"Saved sample index"}).inputValue()),lastSample);
  const preResetZoomPose=await snapshotCanvas.getAttribute("data-saved-camera-pose");
  await snapshotCanvas.hover();
  await page.mouse.wheel(0,450);
  await page.waitForFunction(before=>document.querySelector(".fm-results-snapshot-canvas canvas")?.getAttribute("data-saved-camera-pose")!==before,preResetZoomPose);
  const beforeReset=await snapshotCanvas.getAttribute("data-saved-camera-pose");
  await page.keyboard.press("Control+Shift+P");
  await page.getByPlaceholder("Search commands").fill("Reset 3D Camera");
  await page.getByRole("option",{name:/Reset 3D Camera/}).click();
  await page.waitForFunction(before=>document.querySelector(".fm-results-snapshot-canvas canvas")?.getAttribute("data-saved-camera-pose")!==before,beforeReset);
  result={...result,saved_camera_reset_verified:true};
  await page.getByRole("button",{name:/^Color theme:/}).click();
  await page.getByRole("menuitemradio",{name:"Dark",exact:true}).click();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const darkScreenshot=await page.screenshot({type:"png"});
  assert(darkScreenshot.length<=512*1024);
  result={...result,dark_screenshot_base64:darkScreenshot.toString("base64")};
  await page.getByRole("button",{name:/^Color theme:/}).click();
  await page.getByRole("menuitemradio",{name:"Light",exact:true}).click();
  // Deliver a real, already-fetched historical payload only after returning to
  // Live. A late response must not reactivate the historical render source.
  const currentSamplePrefix="/v2/sessions/current/data/results/arrays/"+selectedOutput.array.id+"/samples/";
  let lateIndex=null;
  for(let index=1;index<selectedOutput.array.sample_count;index++) {
    if(!resultSampleRequests.some(path=>decodeURIComponent(path)===currentSamplePrefix+index)) {lateIndex=index;break;}
  }
  assert(lateIndex!==null,"Late-response proof needs an uncached current-run sample.");
  const latePath=currentSamplePrefix+lateIndex;
  await outputInspector.getByRole("slider",{name:"Saved sample index"}).press("Home");
  await page.waitForFunction(()=>document.querySelector('[data-results-snapshot-status="ready"]')?.getAttribute("data-results-snapshot-index")==="0");
  const lateRoute=url=>decodeURIComponent(url.pathname)===latePath;
  let releaseLate,finishLate,lateReady=false,lateError=null;
  const lateGate=new Promise(resolve=>{releaseLate=resolve;});
  const lateFinished=new Promise(resolve=>{finishLate=resolve;});
  const holdLate=async route=>{
    try {
      const response=await route.fetch();
      assert.equal(response.status(),200);
      lateReady=true;
      await lateGate;
      await route.fulfill({response});
    } catch(error) {lateError=error;}
    finally {finishLate();}
  };
  await page.route(lateRoute,holdLate);
  try {
    for(let index=0;index<lateIndex;index++)await outputInspector.getByRole("slider",{name:"Saved sample index"}).press("ArrowRight");
    await page.waitForFunction(index=>document.querySelector('[data-results-snapshot-status="loading"]')?.getAttribute("data-results-snapshot-index")===String(index),lateIndex);
    for(let attempt=0;attempt<500&&!lateReady&&!lateError;attempt++)await page.waitForTimeout(20);
    if(lateError)throw lateError;
    assert(lateReady,"Late historical response was not captured.");
    await snapshot.getByRole("button",{name:"Return to live",exact:true}).click();
    await liveViewport.waitFor({state:"visible"});
    await outputInspector.waitFor({state:"hidden"});
    releaseLate();
    await lateFinished;
    if(lateError)throw lateError;
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await liveViewport.getAttribute("data-view-source"),"current");
    assert.equal(await page.locator('[data-results-snapshot-status]').count(),0,"Late response restored the historical viewport.");
    assert.equal(await outputInspector.count(),0,"Late response restored the historical Inspector.");
    result={...result,return_live_pending_sample_verified:true};
  } finally {
    releaseLate();
    await page.unroute(lateRoute,holdLate);
  }
  result={...result,current_run_results_verified:true,current_run_id:currentCatalog.run_id};
  await explorer.getByRole("searchbox",{name:"Search saved result outputs",exact:true}).fill("fields/m");
  await page.getByRole("tablist",{name:"Ribbon tabs",exact:true}).getByRole("tab",{name:"Results",exact:true}).click();
  const navigator=page.getByRole("region",{name:"Results",exact:true});
  const navigatorSearch=navigator.getByRole("searchbox",{name:"Search saved result outputs",exact:true});
  await navigatorSearch.waitFor({state:"visible"});
  assert.equal(await navigatorSearch.inputValue(),"fields/m","Changing Results host lost the output filter.");
  await navigatorSearch.fill("");
  await page.getByRole("tablist",{name:"Ribbon tabs",exact:true}).getByRole("tab",{name:"Workspace",exact:true}).click();
  await explorer.waitFor({state:"visible"});
  assert.equal(await explorer.getByRole("searchbox",{name:"Search saved result outputs",exact:true}).inputValue(),"","Explorer did not adopt the shared Results filter.");
  await page.getByRole("tablist",{name:"Ribbon tabs",exact:true}).getByRole("tab",{name:"Results",exact:true}).click();
  result={...result,results_navigation_state_retained:true};
  await page.getByRole("tablist",{name:"Results source",exact:true}).getByRole("tab",{name:"Saved",exact:true}).click();
  const savedFolders=page.getByRole("region",{name:"Workspace result folders",exact:true});
  await savedFolders.waitFor({state:"visible"});
  await savedFolders.locator('[data-workspace-result-id="'+itemId+'"] button').click();
  await source.waitFor({state:"visible"});
  await page.waitForFunction(()=>document.querySelector(".fm-saved-playback-viewport")?.getAttribute("data-saved-frame-state")==="ready");
  await page.getByRole("region",{name:"Saved results playback",exact:true}).getByRole("button",{name:"Return to live",exact:true}).click();
  await liveViewport.waitFor({state:"visible"});
  assert.equal(await liveViewport.getAttribute("data-view-source"),"current");
  scenarioPhase="terminal-live";
  result={...result,results_saved_folder_entry_verified:true};
  const finalStatusResponse=await context.request.get(proxy.origin+"/v2/sessions/current/status");
  assert.equal(finalStatusResponse.status(),200);
  const finalStatus=await finalStatusResponse.json();
  assert.equal(finalStatus.solver.state,"completed","Final live telemetry proof requires a completed run.");
  const scope="session="+encodeURIComponent(finalStatus.session.session_id)
    +"&epoch="+encodeURIComponent(finalStatus.session.session_epoch)
    +"&request_scope_epoch="+encodeURIComponent(finalStatus.session.request_scope_epoch);
  const scalarResponse=await context.request.get(proxy.origin+"/v2/sessions/current/data/scalars?tail=true&limit=1",{headers:{"x-fullmag-session-scope":scope}});
  assert.equal(scalarResponse.status(),200);
  const scalar=await scalarResponse.json();
  assert.equal(scalar.returned_rows,1);
  const scalarRow=Object.fromEntries(scalar.columns.map((column,index)=>[column,scalar.rows[0][index]]));
  assert.equal(scalarRow.step,finalStatus.run.solver_steps,"Live scalar resource remained at an intermediate step.");
  assert.equal(scalarRow.time,finalStatus.run.solver_time,"Live scalar time differs from the completed run.");
  assert.equal(scalar.observation_frames[0].session_epoch,finalStatus.session.session_epoch);
  assert.equal(scalar.observation_frames[0].source_step,scalarRow.step);
  assert.equal(scalar.observation_frames[0].source_time_seconds,scalarRow.time);
  await page.getByRole("region",{name:"Simulation telemetry",exact:true}).waitFor({state:"visible"});
  await page.waitForFunction(({step,time})=>{
    const metrics=[...document.querySelectorAll(".fm-footer-telemetry__metric")];
    const value=label=>metrics.find(node=>node.querySelector(".fm-footer-telemetry__metric-label span")?.textContent===label)
      ?.querySelector(".fm-footer-telemetry__metric-value span")?.textContent;
    return Number(value("Step")?.replaceAll(",",""))===step && Number(value("Sim time"))===time;
  },{step:scalarRow.step,time:scalarRow.time});
  const terminalLiveScreenshot=await page.screenshot({type:"png"});
  assert(terminalLiveScreenshot.length<=512*1024);
  result={...result,terminal_live_scalars_verified:true,terminal_live_step:scalarRow.step,terminal_live_time_s:scalarRow.time,
    terminal_live_scalar_revision:scalar.revision,terminal_live_observation_frame:scalar.observation_frames[0],
    terminal_live_screenshot_base64:terminalLiveScreenshot.toString("base64")};

  await page.goto(proxy.origin+"/home",{waitUntil:"domcontentloaded",timeout});
  await row.waitFor({state:"visible"});
  assert.equal(await page.locator(".fm-saved-playback-viewport").count(),0);
  assert.deepEqual(errors,[]);
  assert.deepEqual(solverRequests,[],"Read-only playback sent a session mutation.");
  const visualizationAfter=await context.request.get(proxy.origin+"/v2/sessions/current/visualization/state");
  assert.equal(visualizationAfter.status(),200);
  assert.deepEqual(await visualizationAfter.json(),visualizationBaseline,"Playback changed persisted live visualization state.");
  const commandsAfter=await context.request.get(proxy.origin+"/v2/sessions/current/simulation/commands");
  assert.equal(commandsAfter.status(),200);
  assert.deepEqual((await commandsAfter.json()).commands,commandLedgerBefore,"Result browsing changed the simulation command ledger.");
  const sessionsAfterResponse=await context.request.get(proxy.origin+"/v2/sessions");
  assert.equal(sessionsAfterResponse.status(),200);
  const sessionsAfter=await sessionsAfterResponse.json();
  assert.deepEqual(sessionsAfter.sessions.map(session=>session.id ?? session.session_id).sort(),sessionIdsBefore,"Result browsing changed simulation sessions.");
  // Qualify publication-state UX with controlled availability responses and
  // real catalog data. This does not claim an in-progress solver publication.
  await context.close();
  context=await browser.newContext({viewport:{width:1500,height:1000},deviceScaleFactor:1,serviceWorkers:"block"});
  let publicationMode="pending",publicationChecks=0;
  const publicationWrites=[];
  await context.route(url=>url.pathname==="/v2/sessions/current/data/results",async route=>{
    publicationChecks++;
    if(publicationMode==="published")return route.continue();
    const code=publicationMode==="pending"?"current_results_not_published":"current_results_publication_missing";
    // Preserve the real API instance/contract headers; a headerless 409 is an
    // invalid transport identity, not the publication state under test.
    const response=await route.fetch();
    assert.equal(response.status(),200);
    await route.fulfill({response,status:409,json:{code,message:publicationMode==="pending"?"no canonical accepted output receipt has been published":"Completed run output publication is missing"}});
  });
  page=await context.newPage();page.setDefaultTimeout(timeout);
  page.on("pageerror",error=>errors.push(error.message));
  page.on("request",request=>{
    const path=new URL(request.url()).pathname;
    const observerLease=/^\/v2\/sessions\/current\/clients(?:\/[^/]+)?$/.test(path);
    const renderAck=request.method()==="POST"&&path==="/v2/sessions/current/visualization/client-acks";
    if(request.method()!=="GET"&&path.startsWith("/v2/sessions/")&&!observerLease&&!renderAck)publicationWrites.push({method:request.method(),path});
  });
  await page.goto(proxy.origin+"/workspace",{waitUntil:"domcontentloaded",timeout});
  const publicationExplorer=page.getByRole("region",{name:"Explorer",exact:true});
  await publicationExplorer.getByRole("tab",{name:"Results",exact:true}).click();
  const publicationTree=publicationExplorer.getByRole("region",{name:"Saved result outputs",exact:true});
  await publicationTree.getByRole("status").filter({hasText:"Waiting for results publication"}).waitFor({state:"visible"});
  assert.equal(await publicationTree.getByRole("alert").count(),0,"Expected publication waiting was shown as a failure.");
  const firstPublicationCheck=publicationChecks;
  for(let attempt=0;attempt<400&&publicationChecks===firstPublicationCheck;attempt++)await page.waitForTimeout(50);
  assert(publicationChecks>firstPublicationCheck,"Visible Results did not check for publication again.");
  const publicationScreenshot=await publicationTree.screenshot({type:"png"});
  assert(publicationScreenshot.length<=512*1024);
  publicationMode="missing";
  await publicationTree.getByRole("alert").filter({hasText:"Completed run output publication is missing"}).waitFor({state:"visible"});
  assert.equal(await publicationTree.getByText("Waiting for results publication",{exact:false}).count(),0,"A terminal publication failure was hidden as waiting.");
  publicationMode="published";
  await publicationTree.locator('[data-entry-id="'+currentEntry.id+'"] > div > [data-entry-select="true"]').waitFor({state:"visible"});
  assert.equal(await publicationTree.getByRole("alert").count(),0,"Publication success retained an obsolete error.");
  assert.equal(await publicationTree.getByText("Waiting for results publication",{exact:false}).count(),0);
  assert.deepEqual(publicationWrites,[],"Publication monitoring attempted a session mutation.");
  result={...result,publication_waiting_ui_verified:true,publication_failure_distinct_verified:true,publication_catalog_arrival_verified:true,
    publication_evidence:"browser-availability-fixture-with-real-published-catalog",publication_poll_count:publicationChecks,
    publication_waiting_screenshot_base64:publicationScreenshot.toString("base64")};
  // Exercise the no-session shell with real saved data and explicitly injected
  // empty session discovery. Preserve the real completed session in the backend.
  await context.close();
  context=await browser.newContext({viewport:{width:1500,height:1000},deviceScaleFactor:1,serviceWorkers:"block"});
  const noSessionWrites=[];
  let noSessionDiscoveries=0;
  await context.route(url=>url.pathname==="/v2/sessions" || url.pathname.startsWith("/v2/sessions/"),async route=>{
    const request=route.request();
    if(request.method()!=="GET") {
      noSessionWrites.push({method:request.method(),path:new URL(request.url()).pathname});
      await route.fulfill({status:409,json:{code:"no_active_session",message:"No active session in the UI test."}});
    } else if(new URL(request.url()).pathname==="/v2/sessions") {
      noSessionDiscoveries++;
      await route.fulfill({status:200,json:{...sessionsBefore,sessions:[]}});
    } else {
      await route.fulfill({status:404,json:{code:"not_found",message:"no active local live workspace"}});
    }
  });
  page=await context.newPage();page.setDefaultTimeout(timeout);
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(proxy.origin+"/home",{waitUntil:"domcontentloaded",timeout});
  const noSessionRow=page.locator("#fm-start-result-"+itemId);
  if(!await noSessionRow.isVisible()) {
    const filter=page.getByRole("combobox",{name:"Show projects, scripts, results or all"});
    if(await filter.count()) {await filter.click();await page.getByRole("option",{name:"Results",exact:true}).click();}
  }
  await noSessionRow.waitFor({state:"visible"});
  await noSessionRow.click();
  await page.locator('button[data-action="open-results-viewer"]').click();
  const noSessionHeader=page.getByRole("region",{name:"Saved results playback",exact:true});
  await noSessionHeader.getByRole("button",{name:"Close results",exact:true}).waitFor({state:"visible"});
  assert.equal(await page.getByRole("button",{name:"Return to live",exact:true}).count(),0,"The no-session view promises a live workspace.");
  await page.waitForFunction(()=>document.querySelector(".fm-saved-playback-viewport")?.getAttribute("data-saved-frame-state")==="ready");
  const noSessionOutput=page.locator('[data-entry-id="'+selectedOutput.entry.id+'"] > div > [data-entry-select="true"]');
  for(let count=0;count<50 && !await noSessionOutput.count();count++)await page.getByRole("button",{name:"Next page",exact:true}).click();
  await noSessionOutput.click();
  const noSessionInspector=page.getByRole("region",{name:"Results output Inspector",exact:true});
  await noSessionInspector.getByRole("button",{name:"Close results",exact:true}).waitFor({state:"visible"});
  await noSessionInspector.getByRole("button",{name:"Load into 3D",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-results-snapshot-status="ready"]'));
  await noSessionInspector.getByRole("slider",{name:"Saved sample index"}).press("End");
  await page.waitForFunction(index=>document.querySelector('[data-results-snapshot-status="ready"]')?.getAttribute("data-results-snapshot-index")===String(index),selectedOutput.array.sample_count-1);
  const noSessionSnapshot=page.getByRole("region",{name:"Saved results 3D viewport",exact:true});
  await noSessionSnapshot.getByRole("button",{name:"Close results",exact:true}).waitFor({state:"visible"});
  assert.equal(await page.getByRole("button",{name:"Return to live",exact:true}).count(),0);
  const noSessionScreenshot=await page.screenshot({type:"png"});
  assert(noSessionScreenshot.length<=512*1024);
  await noSessionSnapshot.getByRole("button",{name:"Close results",exact:true}).click();
  await noSessionRow.waitFor({state:"visible"});
  assert.equal(await page.locator('[data-results-snapshot-status]').count(),0);
  assert.equal(await page.getByRole("region",{name:"3D viewport",exact:true}).count(),0);
  await noSessionRow.click();
  await page.locator('button[data-action="open-results-viewer"]').click();
  await page.getByRole("region",{name:"Saved results playback Inspector",exact:true})
    .getByRole("button",{name:"Close results",exact:true}).click();
  await noSessionRow.waitFor({state:"visible"});
  assert.equal(await page.locator('[data-saved-results-playback="read-only"]').count(),0);
  // A folder without the legacy playback descriptor still opens its output
  // browser. Inject only that optional descriptor failure; retain real catalog.
  await context.route(url=>url.pathname==="/v2/workspace/items/"+itemId+"/playback",route=>
    route.fulfill({status:422,json:{code:"saved_playback_unsupported",message:"No legacy playback descriptor in this UI fixture."}}));
  await noSessionRow.click();
  await page.locator('button[data-action="open-results-viewer"]').click();
  const browserOnlyInspector=page.getByRole("region",{name:"Results output Inspector",exact:true});
  await browserOnlyInspector.getByRole("button",{name:"Close results",exact:true}).waitFor({state:"visible"});
  await page.getByRole("region",{name:"Results 3D viewport",exact:true})
    .getByRole("button",{name:"Close results",exact:true}).waitFor({state:"visible"});
  assert.equal(await page.getByRole("button",{name:"Return to live",exact:true}).count(),0);
  await browserOnlyInspector.getByRole("button",{name:"Close results",exact:true}).click();
  await noSessionRow.waitFor({state:"visible"});
  assert.equal(await page.locator('[data-saved-results-playback="read-only"]').count(),0);
  assert(noSessionDiscoveries>0);
  assert.deepEqual(noSessionWrites,[],"No-session result browsing attempted a session mutation.");
  assert.deepEqual(errors,[]);
  result={...result,no_session_close_to_home_verified:true,no_session_legacy_inspector_close_verified:true,no_session_browser_only_close_verified:true,
    no_session_evidence:"browser-session-discovery-fixture-with-real-result-data",
    no_session_screenshot_base64:noSessionScreenshot.toString("base64")};
  result={schema:"fullmag.docker-dev-saved-playback-result.v1",state:"passed",scenario:"saved-playback",
    item_id:itemId,public_url:publicUrl,probe_url:probeUrl,playwright_version:version,
    browser_gpu_mode:process.env.CONTROL_ROOM_BROWSER_GPU_MODE,script_sha256:scriptSha,
    geometry_kind:manifest.fem_mesh ? "fem" : "fdm",frame_count:stage.frame_count,
    frame_indices:indices,frame_sha256:expected,canvas_visible:true,context_lost:false,
    ...result,field_payloads_verified:true,changed_canvas:true,inspector_stable:true,
    camera_stable:true,visualization_trace:visualizationTrace,payload_evidence:"application_body_reads",live_visualization_unchanged:true,startup_camera_initialization:startupCameraInitialization,hook_errors:hookErrors,errors,screenshot_base64:screenshot.toString("base64")};
} catch(error) {
  try {evidenceScreenshot = await page?.screenshot({type:"png",timeout:5000}) ?? evidenceScreenshot;} catch {}
  result={...result,schema:"fullmag.docker-dev-saved-playback-result.v1",state:"failed",scenario:"saved-playback",
    item_id:itemId,session_mutations:solverRequests,visualization_trace:visualizationTrace,startup_camera_initialization:startupCameraInitialization,errors:[...errors,error?.stack??String(error)],network_trace:networkTrace.slice(-24),screenshot_base64:evidenceScreenshot?.toString("base64")};
  process.exitCode=1;
} finally {
  await context?.close();await browser?.close();await proxy?.close();
}
process.stdout.write(JSON.stringify(result)+"\n");
