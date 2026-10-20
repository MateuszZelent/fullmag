import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const root=new URL("../src/",import.meta.url), read=path=>readFileSync(new URL(path,root),"utf8");
// Evaluate actual production declarations with hook/transport spies; no React bundle or test compilation.
function declaration(source,name){const matches=[`export function ${name}(`,`function ${name}(`,`export async function ${name}<`,`async function ${name}<`];const start=matches.map(m=>source.indexOf(m)).find(n=>n>=0);assert.ok(start>=0,name);const closing=source.slice(start).match(/\n}\r?(?=\n|$)/);assert.ok(closing,name);return source.slice(start,start+closing.index+2);}
let identity={sessionId:"s",sessionEpoch:"s@1",requestScopeEpoch:"instance:1"}, lastOptions, lastQuery, ignored=0;
const error=new Error("Missing exact immutable carrier");let fail=false;
const transport=(_q,query)=>{lastQuery=query;return fail?Promise.reject(error):Promise.resolve({revision:1});};
const context=vm.createContext({URLSearchParams,encodeURIComponent,Promise,console,
 useMemo:run=>run(),useCallback:run=>run,useKernel:()=>({api:{data:{fields:{availability:transport,meta:transport}}},bus:{}}),
 useResource:options=>{lastOptions=options;return options;},
 useSessionResourceIdentity:()=>identity,
 resolveCanonicalQuantityId:q=>q,normalizeQuantityIdOrDefault:q=>q,
 ignoreMissingFieldMetaResource:()=>{ignored++;return null;},
 DATA_FIELD_AVAILABILITY_PATH:"/v2/sessions/current/data/fields/{quantity_id}/availability",
 DATA_FIELD_META_PATH:"/v2/sessions/current/data/fields/{quantity_id}/meta",
});
async function evaluate(source){const m=new vm.SourceTextModule(stripTypeScriptTypes(source),{context});await m.link(()=>{throw new Error("Unexpected unbound production dependency");});await m.evaluate();return m.namespace;}
const session=read("kernel/resources/sessionResourceIdentity.ts"),scoped=read("kernel/resources/useSessionScopedResourceKey.ts");
const availability=read("kernel/resources/fieldAvailabilityResources.ts"),meta=read("kernel/resources/studyRuntimeResources.ts");
const order=availability.slice(availability.indexOf("const FIELD_AVAILABILITY_QUERY_ORDER"),availability.indexOf("[];",availability.indexOf("const FIELD_AVAILABILITY_QUERY_ORDER"))+3);
const source=[declaration(session,"sessionRequestScopeKey"),declaration(session,"sessionScopedResourceKey"),declaration(scoped,"useSessionScopedResourceKey"),order,
 ...["normalizeAvailabilityQueryValue","resolveFieldAvailabilityResourceKey","resolveFieldAvailabilityRevision","useFieldAvailabilityResource"].map(n=>declaration(availability,n)),
 ...["fieldMetaQueryEntries","normalizeFieldMetaScopeId","resolveFieldMetaResourceKey","fieldMetaFreshnessRevision","useFieldMetaResource"].map(n=>declaration(meta,n))].join("\n");
const api=await evaluate(source), pins={stage_id:"stage",carrier_id:`artifact:${"a".repeat(64)}:source_nodes`,expected_carrier_revision:"12297829382473034410",view:"full",scope_kind:"object",scope_id:"conductor"};
const signal=new AbortController().signal;
let checks=0;async function check(name,run){await run();checks++;console.log(`PASS ${name}`);}
for(const name of ["useFieldAvailabilityResource","useFieldMetaResource"]) {
 await check(`${name} transports every exact pin and scopes its key`,async()=>{api[name]({quantityId:"V_electric",...pins});const options=lastOptions;assert.equal(options.enabled,true);await options.load({signal,sessionScopeKey:"confirmed"});for(const [key,value] of Object.entries(pins)){assert.equal(lastQuery[key],value);assert.equal(new URL(options.resourceKey.split("|").at(-1),"http://fixture").searchParams.get(key),value);}});
 await check(`${name} separates carrier, revision, stage and session incarnations`,()=>{const key=()=>{api[name]({quantityId:"V_electric",...pins});return lastOptions.resourceKey;};const before=key();for(const part of ["carrier_id","expected_carrier_revision","stage_id"]){api[name]({quantityId:"V_electric",...pins,[part]:"other"});assert.notEqual(lastOptions.resourceKey,before);}identity={...identity,requestScopeEpoch:"instance:2"};assert.notEqual(key(),before);identity={...identity,requestScopeEpoch:"instance:1"};});
 await check(`${name} remains disabled before session confirmation`,()=>{const old=identity;identity=null;api[name]({quantityId:"V_electric",...pins});assert.equal(lastOptions.enabled,false);identity=old;});
}
await check("availability request uses the same whitespace normalization as its cache key",async()=>{api.useFieldAvailabilityResource({quantityId:"V_electric",...Object.fromEntries(Object.entries(pins).map(([key,value])=>[key,` ${value} `]))});const options=lastOptions;await options.load({signal});for(const [key,value] of Object.entries(pins))assert.equal(lastQuery[key],value);assert.equal(options.resourceKey.includes("%20"),false);});
await check("strict immutable metadata errors cannot be converted into missing-resource success",async()=>{fail=true;ignored=0;api.useFieldMetaResource({quantityId:"V_electric",...pins,strictErrors:true});await assert.rejects(lastOptions.load({signal}),e=>e===error);assert.equal(ignored,0);fail=false;});
await check("ordinary metadata retains its existing missing-resource policy",async()=>{fail=true;ignored=0;api.useFieldMetaResource({quantityId:"V_electric",...pins});assert.equal(await lastOptions.load({signal}),null);assert.equal(ignored,1);fail=false;});
const viewport=read("modules/viewport-3d/viewport3dResources.ts");
const entries=new Map(),inflight=new Map();let retained=null,requests=0,notModified=false;
const cache={get:key=>entries.get(key),peek:key=>entries.get(key),set:(key,value)=>entries.set(key,value),delete:key=>entries.delete(key)};
Object.assign(context,{sessionScopedResourceKey:api.sessionScopedResourceKey,topologyCache:cache,viewport3DSessionIdentityGeneration:0,
 getInflightBinaryResource:(_cache,key)=>inflight.get(key),retainInflightBinaryResource:()=>{},setInflightBinaryResource:(_cache,key,value)=>inflight.set(key,value),clearInflightBinaryResource:(_cache,key)=>inflight.delete(key),
 recordVisualizationDebugPerformanceMetric:()=>{},AbortController,
 DATA_DOMAIN_TOPOLOGY_PATH:"/v2/sessions/current/data/domain/topology",
 useViewport3DSessionIdentity:()=>identity,
 useResource:options=>{lastOptions=options;return {status:"ready",data:retained};},
 useKernel:()=>({api:{data:{domain:{topology:async()=>{requests++;return notModified?{status:"not-modified"}:{status:"ready",data:{nodes:"immutable"},etag:"revision",responseMetadata:{carrierId:"carrier",carrierRevision:"17"},byteLength:32};}}}}}),
});
const topology=await evaluate([declaration(viewport,"loadCachedBinaryResource"),declaration(viewport,"loadCachedBinaryResourceEntry"),declaration(viewport,"useViewport3DArtifactTopology")].join("\n")+"\nexport { loadCachedBinaryResourceEntry };" );
await check("topology retains data, headers and revision after cache eviction without refetch",async()=>{
 const query={carrier_id:"carrier",expected_carrier_revision:"17"};
 topology.useViewport3DArtifactTopology(query);retained=await lastOptions.load({signal});
 const before=topology.useViewport3DArtifactTopology(query);assert.equal(before.responseMetadata.carrierId,"carrier");
 entries.clear();const after=topology.useViewport3DArtifactTopology(query);
 assert.equal(after.data,before.data);assert.equal(after.responseMetadata,before.responseMetadata);
 assert.equal(lastOptions.resolveRevision(retained),"revision");assert.equal(requests,1);
});
await check("topology 304 retains the same atomic geometry envelope",async()=>{
 topology.useViewport3DArtifactTopology({carrier_id:"carrier",expected_carrier_revision:"17"});
 entries.set(lastOptions.resourceKey,retained);notModified=true;
 assert.equal(await lastOptions.load({signal}),retained);assert.equal(requests,2);
});
await check("concurrent entry and legacy consumers share one request and retain their public result shapes",async()=>{
 entries.clear();let calls=0;const data={nodes:"shared"},metadata={carrierId:"shared-carrier"};
 const request=async()=>{calls++;await Promise.resolve();return {status:"ready",data,responseMetadata:metadata,etag:"shared-revision",byteLength:16};};
 const [entry,legacy]=await Promise.all([topology.loadCachedBinaryResourceEntry(cache,"shared",request),topology.loadCachedBinaryResource(cache,"shared",request)]);
 assert.equal(calls,1);assert.equal(entry.data,data);assert.equal(entry.metadata,metadata);assert.equal(legacy,data);assert.equal(inflight.size,0);
});
console.log(JSON.stringify({status:"passed",checks,unit_test_compilation:false,scope:"actual production declarations with hook/transport spies; not React lifecycle or HTTP qualification"}));
