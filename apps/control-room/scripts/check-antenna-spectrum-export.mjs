import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source=readFileSync(new URL("../src/modules/inspector/panels/antenna/AntennaSpectrumExportModel.ts",import.meta.url),"utf8");
const {spectrumExportChunks,writeSpectrumExport}=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);
const data={spectrum:{output_id:"fft",unit:"V/A",provenance:"pełne źródło"},kU:[-1,0,1],kV:[],amplitudes:Array.from({length:9001},(_,i)=>i%2?-i/7:i/3),power:[Number.MIN_VALUE,Number.MAX_VALUE]};
const expected={export_schema:"fullmag_source_spectrum_export.v1",manifest:data.spectrum,data:{k_u_rad_per_m:data.kU,k_v_rad_per_m:data.kV,amplitudes_re_im:data.amplitudes,power:data.power}};
let checks=0;async function check(name,run){await run();checks++;console.log(`PASS ${name}`);}
await check("full-resolution stream preserves every value, SI metadata, UTF-8 and provenance",async()=>{
 const chunks=[];for await(const part of spectrumExportChunks(data,new AbortController().signal))chunks.push(part);
 assert.deepEqual(JSON.parse(chunks.join("")),expected);assert.ok(chunks.length>10);
});
await check("sink writes are serialized with backpressure and close exactly once",async()=>{
 let active=0,maximum=0,closed=0,aborted=0;const chunks=[];
 await writeSpectrumExport(data,{async write(chunk){active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,0));chunks.push(chunk);active--;},async close(){closed++;},async abort(){aborted++;}},new AbortController().signal);
 assert.equal(maximum,1);assert.equal(closed,1);assert.equal(aborted,0);assert.deepEqual(JSON.parse(chunks.join("")),expected);
});
await check("invalidation aborts a blocked write and never commits a file",async()=>{
 const controller=new AbortController();let started,closed=0,aborted=0,rejectWrite;
 const writing=new Promise(resolve=>{started=resolve;});
 const result=writeSpectrumExport(data,{write(){started();return new Promise((_resolve,reject)=>{rejectWrite=reject;});},async close(){closed++;},async abort(){aborted++;rejectWrite?.(controller.signal.reason);}},controller.signal);
 const rejected=assert.rejects(result,error=>error===controller.signal.reason);
 await writing;controller.abort();await rejected;assert.ok(aborted>=1);assert.equal(closed,0);
});
await check("write failure aborts partial output and preserves original error",async()=>{
 const failure=new Error("disk full");let closed=0,aborted=0;
 await assert.rejects(writeSpectrumExport(data,{async write(){throw failure;},async close(){closed++;},async abort(){aborted++;}},new AbortController().signal),error=>error===failure);
 assert.equal(closed,0);assert.equal(aborted,1);
});
await check("already invalidated source is never serialized or written",async()=>{
 const controller=new AbortController();controller.abort();let writes=0;
 await assert.rejects(writeSpectrumExport(data,{async write(){writes++;},async close(){throw Error("unexpected commit");},async abort(){}},controller.signal),error=>error===controller.signal.reason);assert.equal(writes,0);
});
console.log(JSON.stringify({status:"passed",checks,unit_test_compilation:false,scope:"production generator and sink; browser picker and compatibility Blob memory not qualified"}));
