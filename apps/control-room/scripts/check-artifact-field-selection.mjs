import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const root=new URL("../src/",import.meta.url),cache=new Map();
function load(url){if(!cache.has(url.href)){const resolved=existsSync(url)?url:new URL(url.href.replace(/\.ts$/,"/index.ts"));cache.set(url.href,new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(resolved,"utf8"),{mode:"transform"}),{identifier:resolved.href}));}return cache.get(url.href);}
const entry=load(new URL("kernel/visualization/artifactFieldSelection.ts",root));
await entry.link((name,parent)=>load(name.startsWith("@/")?new URL(`${name.slice(2)}.ts`,root):new URL(`${name}.ts`,parent.identifier)));await entry.evaluate();
const {artifactInspectionQuantity:gate,artifactSelectionForQuantity:select}=entry.namespace;
function catalog(q="J_charge"){return {quantities:[{id:q,n_comp:q==="V_electric"?1:3,unit:q==="V_electric"?"V":q==="J_charge"?"A/m^2":"A/m",resolved_capability:{quantity_id:q,lane:"artifact_inspection_read_only",provider:"available",request:"field_vector",render:"renderable",publication:"interactive",materialization:"materialized",carriers:[{payload_state:"historical",components:q==="V_electric"?1:3,indexing:q==="V_electric"?"source_nodes":q==="J_charge"?"tet4_cell_local_nodes":"sample_nodes"}]}}]};}
let checks=0;function check(name,run){run();checks++;console.log(`PASS ${name}`);}
for(const q of ["H_ant","J_charge","V_electric"])check(`${q} historical lane admitted`,()=>assert.equal(gate(catalog(q),q),true));
for(const [name,mutate] of [
 ["live solver lane",c=>{c.quantities[0].resolved_capability.lane="live";}],
 ["current payload",c=>{c.quantities[0].resolved_capability.carriers[0].payload_state="current";}],
 ["not materialized",c=>{c.quantities[0].resolved_capability.materialization="unmaterialized";}],
 ["unsupported provider",c=>{c.quantities[0].resolved_capability.provider="unavailable";}],
 ["wrong unit",c=>{c.quantities[0].unit="A/m";}],
 ["wrong component count",c=>{c.quantities[0].n_comp=1;}],
 ["wrong indexing",c=>{c.quantities[0].resolved_capability.carriers[0].indexing="sample_nodes";}],
 ["wrong capability quantity",c=>{c.quantities[0].resolved_capability.quantity_id="H_ant";}],
 ["duplicate entry",c=>{c.quantities.push(structuredClone(c.quantities[0]));}],
 ["no compatible carrier",c=>{c.quantities[0].resolved_capability.carriers=[];}],
])check(`${name} cannot take over a solver field`,()=>{const c=catalog();mutate(c);assert.equal(gate(c,"J_charge"),false);});
check("missing catalog and unsupported quantity stay outside artifact routing",()=>{assert.equal(gate(null,"H_ant"),false);assert.equal(gate(catalog(),"V_electric"),false);});
for(const [name,mutate] of [["wrong V unit",c=>{c.quantities[0].unit="A/m";}],["vector V",c=>{c.quantities[0].n_comp=3;}],["wrong V indexing",c=>{c.quantities[0].resolved_capability.carriers[0].indexing="sample_nodes";}]])check(name,()=>{const c=catalog("V_electric");mutate(c);assert.equal(gate(c,"V_electric"),false);});
const pin={identity:{sessionId:"s",sessionEpoch:"e",requestScopeEpoch:"r"},runId:"run",runtimeStageId:"stage",authoredStageId:"solve",sourceObjectId:"source",quantityId:"H_ant",carrierId:"h-carrier",carrierRevision:"9",carrierScopeKind:"full",carrierScopeId:null};
check("H to J preserves owner and clears every H carrier pin",()=>{const before=structuredClone(pin),next=select(pin,"J_charge");assert.deepEqual(next,{identity:pin.identity,runId:"run",runtimeStageId:"stage",authoredStageId:"solve",sourceObjectId:"source",quantityId:"J_charge"});assert.deepEqual(pin,before);});
check("same quantity preserves stable pinned identity",()=>assert.strictEqual(select(pin,"H_ant"),pin));
check("legacy untyped carrier is never adopted by name",()=>{const legacy={...pin};delete legacy.quantityId;assert.equal(select(legacy,"H_ant").carrierId,undefined);});
const {artifactInspectorFieldBinding:bind,artifactInspectorMetadataMatchesBinding:matches}=entry.namespace;
const targetScope={scopeKind:"object",scopeId:"source"};
const bindPin=(selection=pin,q="H_ant",scope=targetScope,c=catalog(q))=>bind({catalog:c,quantityId:q,selection,sessionIdentity:pin.identity,targetScope:scope});
check("ordinary and missing catalog do not acquire historical ownership",()=>{assert.equal(bindPin(pin,"H_ant",targetScope,null).historical,false);const c=catalog("H_ant");c.quantities[0].resolved_capability.lane="live";assert.equal(bindPin(pin,"H_ant",targetScope,c).historical,false);});
check("historical lane remains blocked without complete immutable pins",()=>{for(const key of ["runId","runtimeStageId","authoredStageId","sourceObjectId","carrierId","carrierRevision","quantityId"]){for(const value of [undefined,""," "]){const result=bindPin({...pin,[key]:value});assert.equal(result.historical,true,key);assert.equal(result.query,null,key);assert.equal(result.identityKey,null,key);}}assert.equal(bindPin(null).query,null);});
check("session changes and empty session identities block historical requests",()=>{for(const key of ["sessionId","sessionEpoch","requestScopeEpoch"]){assert.equal(bindPin({...pin,identity:{...pin.identity,[key]:"other"}}).query,null);assert.equal(bind({...{catalog:catalog("H_ant"),quantityId:"H_ant",selection:pin,targetScope},sessionIdentity:{...pin.identity,[key]:" "}}).query,null);}});
check("quantity mismatch cannot reuse carrier pins",()=>assert.equal(bindPin(pin,"J_charge").query,null));
check("full carrier binding emits only immutable query selectors",()=>assert.deepEqual(bindPin().query,{stage_id:"stage",carrier_id:"h-carrier",expected_carrier_revision:"9",view:"full",scope_kind:"full",scope_id:null}));
check("object scope requires an exact target while full carrier remains valid",()=>{const objectPin={...pin,carrierScopeKind:"object",carrierScopeId:"source"};assert.equal(bindPin(objectPin).query.scope_id,"source");for(const scope of [null,{scopeKind:"full",scopeId:null},{scopeKind:"object",scopeId:"foreign"}])assert.equal(bindPin(objectPin,"H_ant",scope).query,null);assert.equal(bindPin({...pin,carrierScopeKind:"full",carrierScopeId:"foreign"}).query,null);assert.ok(bindPin(pin,"H_ant",null).query);});
check("identity keys separate every owner pin and target scope without delimiter collisions",()=>{const base=bindPin().identityKey;for(const key of ["runId","runtimeStageId","authoredStageId","sourceObjectId","carrierId","carrierRevision"])assert.notEqual(bindPin({...pin,[key]:`${pin[key]}x`}).identityKey,base,key);assert.notEqual(bindPin(pin,"H_ant",{scopeKind:"object",scopeId:"other"}).identityKey,base);assert.notEqual(bindPin({...pin,runId:"a|b",authoredStageId:"c"}).identityKey,bindPin({...pin,runId:"a",authoredStageId:"b|c"}).identityKey);});
function metadata(q="H_ant"){return {quantity_id:q,unit:q==="V_electric"?"V":q==="J_charge"?"A/m^2":"A/m",components:q==="V_electric"?1:3,state:"stale_complete",materialization_reason_code:"historical_inspection_read_only",resolved_capability:catalog(q).quantities[0].resolved_capability,artifact_field_locator:{carrier_id:pin.carrierId,carrier_revision:pin.carrierRevision,carrier_scope_kind:"full",carrier_scope_id:null,indexing:q==="V_electric"?"source_nodes":q==="J_charge"?"tet4_cell_local_nodes":"sample_nodes",owner:{session_id:"s",session_epoch:"e",request_scope_epoch:"r",run_id:"run",runtime_stage_id:"stage",authored_stage_id:"solve",object_id:"source",historical_inspection:true}}};}
for(const q of ["H_ant","J_charge","V_electric"])check(`${q} metadata admits exact immutable owner`,()=>assert.equal(matches(metadata(q),bindPin({...pin,quantityId:q},q)),true));
check("foreign metadata owner is rejected despite HTTP success",()=>{for(const key of ["session_id","session_epoch","request_scope_epoch","run_id","runtime_stage_id","authored_stage_id","object_id"]){const m=metadata();m.artifact_field_locator.owner[key]="foreign";assert.equal(matches(m,bindPin()),false,key);}for(const key of ["carrier_id","carrier_revision","carrier_scope_kind","carrier_scope_id"]){const m=metadata();m.artifact_field_locator[key]="foreign";assert.equal(matches(m,bindPin()),false,key);}});
check("metadata semantic contract and historical lane cannot change under the binding",()=>{for(const [key,value] of [["quantity_id","J_charge"],["unit","1/m"],["components",1],["state","current"],["materialization_reason_code","current"]]){const m=metadata();m[key]=value;assert.equal(matches(m,bindPin()),false,key);}const m=metadata();m.resolved_capability.lane="live";assert.equal(matches(m,bindPin()),false);m.resolved_capability=metadata().resolved_capability;m.artifact_field_locator.owner.historical_inspection=false;assert.equal(matches(m,bindPin()),false);assert.equal(matches(null,bindPin()),false);assert.equal(matches(metadata(),bindPin(null)),false);});
check("matching object metadata is admitted and wrong indexing is rejected",()=>{const selection={...pin,carrierScopeKind:"object",carrierScopeId:"source"},m=metadata();m.artifact_field_locator.carrier_scope_kind="object";m.artifact_field_locator.carrier_scope_id="source";assert.equal(matches(m,bindPin(selection)),true);m.artifact_field_locator.indexing="source_nodes";assert.equal(matches(m,bindPin(selection)),false);});
check("new matching sessions get separate metadata range identities",()=>{for(const key of ["sessionId","sessionEpoch","requestScopeEpoch"]){const identity={...pin.identity,[key]:"new"};const next=bind({catalog:catalog("H_ant"),quantityId:"H_ant",selection:{...pin,identity},sessionIdentity:identity,targetScope});assert.ok(next.query);assert.notEqual(next.identityKey,bindPin().identityKey);}});
check("malformed locator and owner are rejected without throwing",()=>{for(const locator of [{},{owner:null},{owner:[]},[],"invalid",null]){const m=metadata();m.artifact_field_locator=locator;assert.equal(matches(m,bindPin()),false);}});
// Interpret the real resource wrapper with deterministic hook dependencies.
let currentResource={data:metadata(),status:"ready",error:null,revision:1,refetch:()=>{}},lastQuery;
const wrapper=new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("kernel/resources/useVisualizationFieldMeta.ts",root),"utf8"),{mode:"transform"}));
await wrapper.link(name=>{
 if(name==="../visualization/artifactFieldSelection")return entry;
 if(name==="react")return new vm.SyntheticModule(["useMemo"],function(){this.setExport("useMemo",factory=>factory());});
 if(name==="./studyRuntimeResources")return new vm.SyntheticModule(["useFieldMetaResource"],function(){this.setExport("useFieldMetaResource",query=>{lastQuery=query;return currentResource;});});
 throw new Error(`Unexpected resource wrapper dependency: ${name}`);
});await wrapper.evaluate();
const readMeta=(binding=bindPin(),enabled=true)=>wrapper.namespace.useVisualizationFieldMeta({binding,enabled,quantityId:"H_ant",component:"magnitude",scope_kind:"object",scope_id:"source"});
check("metadata reader sends exact immutable selectors and strict errors",()=>{assert.strictEqual(readMeta().data,currentResource.data);assert.equal(lastQuery.stage_id,"stage");assert.equal(lastQuery.carrier_id,"h-carrier");assert.equal(lastQuery.expected_carrier_revision,"9");assert.equal(lastQuery.scope_kind,"full");assert.equal(lastQuery.enabled,true);assert.equal(lastQuery.strictErrors,true);});
check("incomplete owner disables reader and hides retained data",()=>{const value=readMeta(bindPin(null));assert.equal(lastQuery.enabled,false);assert.equal(value.data,null);assert.equal(value.status,"idle");});
check("foreign successful response becomes a resource error",()=>{const m=metadata();m.artifact_field_locator.owner.run_id="foreign";currentResource={...currentResource,data:m};const value=readMeta();assert.equal(value.data,null);assert.equal(value.status,"error");assert.match(value.error.message,/immutable inspection/);});
check("disabled reader safely ignores retained malformed metadata",()=>{currentResource={...currentResource,data:{...metadata(),artifact_field_locator:{}}};const value=readMeta(bindPin(),false);assert.equal(value.data,null);assert.equal(value.status,"idle");assert.equal(value.error,null);});
check("failed refresh cannot expose a retained historical range",()=>{currentResource={...currentResource,data:metadata(),refreshError:new Error("refresh failed")};const value=readMeta();assert.equal(value.data,null);assert.equal(value.status,"error");assert.equal(value.error.message,"refresh failed");});
check("ordinary reader keeps its previous resource contract",()=>{const value=readMeta({historical:false,query:null,identityKey:null,expectedOwner:null});assert.strictEqual(value,currentResource);assert.equal(lastQuery.scope_kind,"object");assert.equal(lastQuery.strictErrors,false);});
check("invalid advertised historical contract never enables an ordinary reader",()=>{for(const mutate of [c=>{c.quantities[0].unit="1/m";},c=>{c.quantities[0].n_comp=1;},c=>{c.quantities[0].resolved_capability.carriers=[];},c=>{c.quantities[0].resolved_capability.provider="unavailable";},c=>{c.quantities.push(structuredClone(c.quantities[0]));}]){const c=catalog("H_ant");mutate(c);const binding=bind({catalog:c,quantityId:"H_ant",selection:pin,sessionIdentity:pin.identity,targetScope});assert.equal(binding.historical,true);assert.equal(binding.query,null);const value=readMeta(binding);assert.equal(lastQuery.enabled,false);assert.equal(value.data,null);assert.equal(value.status,"idle");}});
check("catalog refresh failure keeps retained historical identity and blocks requests",()=>{const input={catalog:catalog("H_ant"),quantityId:"H_ant",selection:pin,sessionIdentity:pin.identity,targetScope};const ready=bind(input);assert.ok(ready.query);for(const state of ["loading","refreshError"]){const blocked=bind({...input,catalogReady:false});assert.equal(blocked.historical,true,state);assert.equal(blocked.query,null);assert.equal(blocked.identityKey,null);const value=readMeta(blocked);assert.equal(lastQuery.enabled,false);assert.equal(value.data,null);assert.equal(value.status,"idle");}assert.equal(bind(input).identityKey,ready.identityKey);});

const rangeKey=entry.namespace.artifactSurfaceRangeKey;
check("rendered surface identity separates projection and every immutable owner pin",()=>{
 const b=bindPin(), key=rangeKey(b.expectedOwner,b.query,"raw_nodal");
 assert.equal(key,rangeKey(b.expectedOwner,b.query,undefined));assert.notEqual(key,rangeKey(b.expectedOwner,b.query,"surface_faces"));
 for(const field of Object.keys(b.expectedOwner))assert.notEqual(key,rangeKey({...b.expectedOwner,[field]:"changed"},b.query,"raw_nodal"),field);
 for(const field of ["carrier_id","expected_carrier_revision","scope_kind","scope_id"])assert.notEqual(key,rangeKey(b.expectedOwner,{...b.query,[field]:"changed"},"raw_nodal"),field);
 assert.equal(rangeKey(null,b.query,"raw_nodal"),null);assert.equal(rangeKey(b.expectedOwner,null,"raw_nodal"),null);
});
const storeModule=load(new URL("modules/viewport-3d/viewport3dStore.ts",root));
await storeModule.link((name,parent)=>{
 if(name==="react")return new vm.SyntheticModule(["useCallback","useSyncExternalStore"],function(){this.setExport("useCallback",fn=>fn);this.setExport("useSyncExternalStore",(_subscribe,snapshot)=>snapshot());});
 // Visual-profile initialization is unrelated to range selection; no WebGL dependency is loaded.
 if(name==="./viewport3dVisualProfile")return new vm.SyntheticModule(["DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID","getViewport3DVisualProfile"],function(){this.setExport("DEFAULT_VIEWPORT_3D_VISUAL_PROFILE_ID","interactive");this.setExport("getViewport3DVisualProfile",()=>({antialias:true}));});
 return load(name.startsWith("@/")?new URL(`${name.slice(2)}.ts`,root):new URL(`${name}.ts`,parent.identifier));
});await storeModule.evaluate();
check("rendered range store isolates live, owner and projection identities",()=>{
 const b=bindPin(),inspectionKey=rangeKey(b.expectedOwner,b.query,"surface_faces"), range={min:-2,max:3};
 const query={quantityId:"H_ant",component:"x",scopeKind:"full",scopeId:null,inspectionKey};
 const row={...query,range}, resolve=storeModule.namespace.resolveViewport3DRenderedScalarRange;
 assert.strictEqual(resolve([row],query),range);
 for(const key of [undefined,"foreign",rangeKey(b.expectedOwner,b.query,"raw_nodal")])assert.equal(resolve([row],{...query,inspectionKey:key}),null);
 assert.equal(resolve([{...row,inspectionKey:undefined}],query),null);
 assert.strictEqual(resolve([{...row,inspectionKey:undefined}],{...query,inspectionKey:undefined}),range);
});
check("owner-only range change notifies subscribers even with identical numeric bounds",()=>{
 const store=storeModule.namespace.viewport3dStore;let calls=0;const stop=store.subscribe(()=>calls++);
 const row={quantityId:"H_ant",component:"x",scopeKind:"full",scopeId:null,inspectionKey:"owner-a",range:{min:0,max:1}};
 store.setRenderedScalarRanges([row]);const before=calls;store.setRenderedScalarRanges([{...row}]);assert.equal(calls,before);
 store.setRenderedScalarRanges([{...row,inspectionKey:"owner-b"}]);assert.equal(calls,before+1);stop();store.setRenderedScalarRanges([]);
});
check("dedicated inspection blocks ordinary metadata while its catalog is missing or invalid",()=>{
 for(const c of [null,{quantities:[]},catalog("H_ant")]){
  const binding=bind({catalog:c,catalogReady:false,inspectionOnly:true,quantityId:"H_ant",selection:pin,sessionIdentity:pin.identity,targetScope});
  assert.equal(binding.historical,true);assert.equal(binding.query,null);const value=readMeta(binding);assert.equal(lastQuery.enabled,false);assert.equal(value.data,null);
 }
 const binding=bind({catalog:catalog("H_ant"),inspectionOnly:true,quantityId:"H_eff",selection:pin,sessionIdentity:pin.identity,targetScope});assert.equal(binding.historical,true);assert.equal(binding.query,null);
});
check("owned accounting rejects stale owner/build adoption and clears without touching a newer owner",()=>{
 const store=storeModule.namespace.viewport3dStore;
 const value={key:"owner-a",fieldBufferId:"field",vectorBuildKey:"build-a",capacity:{fullCount:5,surfaceCount:4},decodedSampleCount:5,availableGlyphCount:4,expectedGlyphCount:2,adoptedGlyphCount:null};
 store.setArtifactInspectionPresentation(value);assert.equal(store.getArtifactInspectionPresentation("foreign"),null);
 for(const [key,build,count] of [["foreign","build-a",2],["owner-a","old-build",2],["owner-a","build-a",3]])store.updateArtifactGlyphAdoption(key,build,count);
 assert.equal(store.getArtifactInspectionPresentation("owner-a").adoptedGlyphCount,null);
 store.updateArtifactGlyphAdoption("owner-a","build-a",2);assert.equal(store.getArtifactInspectionPresentation("owner-a").adoptedGlyphCount,2);
 store.setArtifactInspectionPresentation({...value});assert.equal(store.getArtifactInspectionPresentation("owner-a").adoptedGlyphCount,2);
 store.setArtifactInspectionPresentation({...value,vectorBuildKey:"build-b"});assert.equal(store.getArtifactInspectionPresentation("owner-a").adoptedGlyphCount,null);
 store.clearArtifactInspectionPresentation("owner-a","build-a");assert.ok(store.getArtifactInspectionPresentation("owner-a"));
 store.setArtifactInspectionPresentation({...value,key:"owner-b"});store.clearArtifactInspectionPresentation("owner-a","build-b");assert.ok(store.getArtifactInspectionPresentation("owner-b"));
 store.clearArtifactInspectionPresentation("owner-b","build-a");assert.equal(store.getArtifactInspectionPresentation("owner-b"),null);
});
const adoptionModule=load(new URL("modules/viewport-3d/model/viewport3DRenderAdoptionRegistry.ts",root));await adoptionModule.link((name,parent)=>load(new URL(`${name}.ts`,parent.identifier)));await adoptionModule.evaluate();
check("GPU receipt selection matches exact carrier, field, build and request-scope epoch",()=>{
 const registry=adoptionModule.namespace.createViewport3DRenderAdoptionRegistry();const session={sessionId:"s",sessionEpoch:"e",requestScopeEpoch:"r"};registry.setSessionIdentity(session);
 const receipt={ownerId:"a",carrierId:"carrier",fieldBufferId:"field",vectorBuildKey:"build",resourceKey:"resource",sessionIdentity:session,itemCount:2,byteLength:128};
 assert.equal(registry.recordVectorAdoption(receipt).status,"adopted");
 const query={...session,carrierId:"carrier",fieldBufferId:"field",vectorBuildKey:"build"};assert.equal(registry.latestActiveAdoption(query).itemCount,2);
 for(const key of ["carrierId","fieldBufferId","vectorBuildKey","requestScopeEpoch"])assert.equal(registry.latestActiveAdoption({...query,[key]:"foreign"}),null,key);
});
const panelModel=load(new URL("modules/inspector/panels/ObjectVisualizationPanelModel.ts",root));await panelModel.link((name,parent)=>load(name.startsWith("@/")?new URL(`${name.slice(2)}.ts`,root):new URL(`${name}.ts`,parent.identifier)));await panelModel.evaluate();
check("standalone artifact Inspector resolves only an explicit object without a magnetic backend",()=>{
 const target={kind:"object",id:"object:antenna"},selection={kind:"object.antenna.visualization"};
 for(const lane of ["unresolved","fdm","fem"]){assert.strictEqual(panelModel.namespace.resolveObjectVisualizationTargetForLane({artifactInspection:true,lane,selection,selectionTarget:target}),target);assert.deepEqual(panelModel.namespace.resolveObjectVisualizationResourceGates({artifactInspection:true,lane,target}),{fdm:false,fem:false});}
 assert.equal(panelModel.namespace.resolveObjectVisualizationTargetForLane({lane:"unresolved",selection,selectionTarget:target}),null);
 for(const kind of ["region","fdm-domain","fdm-native-layer","airbox"])assert.equal(panelModel.namespace.resolveObjectVisualizationTargetForLane({artifactInspection:true,lane:"fem",selection,selectionTarget:{kind,id:"foreign"}}),null);
});
check("admitted historical result never appears as live magnetic materialization",()=>{
 const ready={catalogReady:true,catalogError:false,quantityAvailable:true,ownerReady:true,presentationReady:true},resolve=panelModel.namespace.resolveArtifactInspectionDataState;
 assert.equal(resolve(ready),"Historical snapshot");assert.equal(resolve({...ready,presentationReady:false}),"Loading historical result");assert.equal(resolve({...ready,ownerReady:false}),"Select execution");assert.equal(resolve({...ready,quantityAvailable:false}),"Select a compatible field");assert.equal(resolve({...ready,catalogReady:false}),"Loading catalog");assert.equal(resolve({...ready,catalogError:true}),"Unavailable");
});
check("Universe overview does not wait for a field rejected by its sampling mesh",()=>{
 const source=readFileSync(new URL("modules/inspector/panels/ObjectVisualizationPanel.tsx",root),"utf8");
 const initializer=source.match(/const dataState = (artifactInspection \?[\s\S]*?);\n  const targetFieldAvailability/)[1];
 const h=catalog("H_ant");
 const state={artifactInspection:true,artifactInspectionOwner:pin,catalogOwnerReady:true,catalogOwnerError:false,
  rawQuantityCatalog:{data:h,status:"ready"},rawFieldCatalog:{status:"ready"},
  quantityCatalog:{data:h},fieldCatalog:{data:{quantities:[]}},
  settings:{activeQuantityId:"H_ant"},artifactPresentation:null,
  artifactInspectionQuantity:gate,resolveArtifactInspectionDataState:panelModel.namespace.resolveArtifactInspectionDataState};
 assert.equal(vm.runInNewContext(initializer,state),"Select a compatible field");
 state.fieldCatalog.data.quantities=[{quantity_id:"H_ant"}];
 assert.equal(vm.runInNewContext(initializer,state),"Loading historical result");
 state.artifactPresentation={};
 assert.equal(vm.runInNewContext(initializer,state),"Historical snapshot");
 state.fieldCatalog.data.quantities=[];
 assert.equal(vm.runInNewContext(initializer,state),"Select a compatible field");
});
check("Universe inspection never hides explicit live Airbox quantities in a scene with antennas",()=>{
 const route=entry.namespace.artifactUniverseInspectionRoute;
 assert.equal(route("H_demag",true,true),false);
 assert.equal(route("H_demag",true,false),false);
 assert.equal(route("m",true,false),false);
 assert.equal(route("H_ant",true,true),false);
 assert.equal(route("H_ant",true,false),true);
 assert.equal(route("H_ant",false,false),false);
});
check("canonical Airbox presentation accepts historical topology without accepting foreign targets",()=>{
 const target={kind:"airbox",id:"airbox"};
 assert.strictEqual(panelModel.namespace.resolveObjectVisualizationTargetForLane({artifactInspection:true,lane:"fem",selection:{kind:"airbox.visualization"},selectionTarget:target}),target);
});
check("Universe metadata binds accepted global mesh while generic legacy inspection remains readable",()=>{
 const presentationTarget={kind:"airbox",id:"airbox"};
 const binding=bind({catalog:catalog("H_ant"),quantityId:"H_ant",selection:pin,sessionIdentity:pin.identity,targetScope:{scopeKind:"full",scopeId:null},presentationTarget});
 const m=metadata(), locator=m.artifact_field_locator;
 assert.equal(matches(m,binding),false);assert.equal(matches(m,bindPin()),true);
 locator.owner.accepted_artifact={project_id:"p",task_id:"t",attempt_id:"a",ownership_epoch:"1",artifact_id:"i",object_ref:"a".repeat(64)};
 locator.sample_carrier={domain:{kind:"global"},carrier_kind:"fem_domain_mesh_asset",location:"node",topology_digest:"sha256:"+"b".repeat(64)};
 assert.equal(matches(m,binding),true);assert.equal(locator.owner.object_id,"source");
 const key=entry.namespace.artifactCarrierPresentationKey(binding.expectedOwner,binding.query,presentationTarget);
 assert.notEqual(key,entry.namespace.artifactCarrierPresentationKey(binding.expectedOwner,binding.query));
 assert.equal(key,entry.namespace.artifactCarrierPresentationKey(binding.expectedOwner,binding.query,{...presentationTarget}));
 for(const [field,value] of [["carrier_kind","fem_mesh_asset:geometry"],["location","cell"],["topology_digest","bad"]]){
  const bad=structuredClone(m);bad.artifact_field_locator.sample_carrier[field]=value;assert.equal(matches(bad,binding),false,field);
 }
 for(const q of ["V_electric","J_charge"]){
  const blocked=bind({catalog:catalog(q),quantityId:q,selection:{...pin,quantityId:q},sessionIdentity:pin.identity,targetScope:null,presentationTarget});
  assert.equal(blocked.query,null,q);
 }
});
const universeRoute=entry.namespace.artifactUniverseInspectionRoute;
const liveUniverse=entry.namespace.artifactUniverseCatalogHasExplicitLiveQuantity;
const discovery={ownerSelected:true,liveCatalogReady:true};
function liveUniverseCatalog(q="H_demag"){
 const c=catalog(q),entry=c.quantities[0];entry.domain="full_domain";
 entry.resolved_capability.lane="fem_cpu";entry.resolved_capability.carriers[0].payload_state="current";
 return c;
}
check("selected execution discovers historical catalog from empty or unavailable magnetic selection",()=>{
 for(const q of ["","H_demag","H_ant"]){assert.equal(universeRoute(q,true,false,discovery),true);}
});
check("discovery requires a selected execution and inspection context",()=>{
 for(const q of ["","H_demag","H_ant"]){
  assert.equal(universeRoute(q,true,false,{...discovery,ownerSelected:false}),false);
  assert.equal(universeRoute(q,false,false,discovery),false);
 }
});
check("pending or failed live catalog cannot trigger historical takeover",()=>{
 for(const q of ["","H_demag","H_ant"])assert.equal(universeRoute(q,true,false,{...discovery,liveCatalogReady:false}),false);
});
for(const q of ["H_demag","H_ant"])check(`compatible current ${q} keeps live priority`,()=>{
 const c=liveUniverseCatalog(q);assert.equal(liveUniverse(c,q),true);
 assert.equal(universeRoute(q,true,liveUniverse(c,q),discovery),false);
});
check("live discovery rejects missing, duplicate and unsupported current contracts",()=>{
 assert.equal(liveUniverse(null,"H_demag"),false);assert.equal(liveUniverse(liveUniverseCatalog(),""),false);
 for(const mutate of [c=>c.quantities.push(structuredClone(c.quantities[0])),
  c=>{c.quantities[0].domain="magnetic_only";},
  c=>{c.quantities[0].resolved_capability.provider="unavailable";},
  c=>{c.quantities[0].resolved_capability.lane="artifact_inspection_read_only";},
  c=>{c.quantities[0].resolved_capability.publication="offline";},
  c=>{c.quantities[0].resolved_capability.quantity_id="H_ant";},
  c=>{c.quantities[0].resolved_capability.carriers[0].components=1;},
  c=>{c.quantities[0].resolved_capability.carriers[0].payload_state="historical";},
  c=>{c.quantities[0].resolved_capability.carriers=[];}]){
  const c=liveUniverseCatalog();mutate(c);assert.equal(liveUniverse(c,"H_demag"),false);
 }
});
check("discovery preserves active quantity and owner pins without claiming data",()=>{
 const selected={activeQuantityId:"H_demag",owner:structuredClone(pin)},before=structuredClone(selected);
 assert.equal(universeRoute(selected.activeQuantityId,true,false,discovery),true);
 assert.deepEqual(selected,before);assert.equal(gate({quantities:[]},"H_ant"),false);
});
check("Global provenance gate remains required after discovery",()=>{
 const locator=metadata().artifact_field_locator;
 assert.equal(entry.namespace.artifactFieldLocatorHasAcceptedGlobalSampling(locator),false);
 locator.owner.accepted_artifact={project_id:"p",task_id:"t",attempt_id:"a",ownership_epoch:"1",artifact_id:"i",object_ref:"a".repeat(64)};
 locator.sample_carrier={domain:{kind:"global"},carrier_kind:"fem_domain_mesh_asset",location:"node",topology_digest:"sha256:"+"b".repeat(64)};
 assert.equal(entry.namespace.artifactFieldLocatorHasAcceptedGlobalSampling(locator),true);
 for(const indexing of ["point_samples","source_nodes"]){const bad=structuredClone(locator);bad.indexing=indexing;assert.equal(entry.namespace.artifactFieldLocatorHasAcceptedGlobalSampling(bad),false);}
});
// Run the actual overlay hook: a conductor-only live H must not suppress Universe inspection.
let overlayLiveCatalog = liveUniverseCatalog("H_ant"), overlayExecutionCalls = [];
let overlayInspectionState = "retained", overlayScopedCalls = [], overlayPayloadEnabled = [];
const availabilityModule = load(new URL("kernel/visualization/artifactInspectionAvailability.ts", root));
await availabilityModule.link((name, parent) => load(new URL(name + ".ts", parent.identifier)));
await availabilityModule.evaluate();
const overlayNoResource = () => ({ status: "loading", data: null, error: null, refreshError: null });
const overlayBindings = {
  useQuantityCatalogResource: options => {
    if (options.stageId === undefined) return { status: "ready", data: overlayLiveCatalog, error: null, refreshError: null };
    overlayScopedCalls.push(options); return overlayNoResource();
  },
  useFieldCatalogResource: options => { overlayScopedCalls.push(options); return overlayNoResource(); },
  useFieldMetaResource: options => { overlayPayloadEnabled.push(options.enabled); return overlayNoResource(); },
  useStageExecutionResource: options => {
    overlayExecutionCalls.push(options);
    return { status: "ready", data: { session_id: "s", session_epoch: "e", request_scope_epoch: "r", run_id: "run",
      stages: [{ stage_id: "stage", antenna_solve_stage_id: "solve", status: "completed",
        ...(overlayInspectionState === "unknown" ? {} : { antenna_inspection: { state: overlayInspectionState } }) }] }, error: null, refreshError: null };
  },
};
function overlaySynthetic(values) {
  return new vm.SyntheticModule(Object.keys(values), function () { for (const [key, value] of Object.entries(values)) this.setExport(key, value); });
}
const overlayHook = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(new URL("modules/viewport-3d/hooks/useArtifactFieldOverlay.ts", root), "utf8"), { mode: "transform" }));
await overlayHook.link(name => {
  if (name === "react") return overlaySynthetic({ useMemo: fn => fn(), useEffect: () => {}, useEffectEvent: fn => fn });
  if (name === "@/kernel/visualization/artifactFieldSelection") return entry;
  if (name === "@/kernel/visualization/artifactInspectionAvailability") return availabilityModule;
  if (name === "@/kernel/resources/studyRuntimeResources") return overlaySynthetic(overlayBindings);
  if (name === "@/kernel/resources/useSessionStatus") return overlaySynthetic({ useSessionResourceIdentity: () => pin.identity });
  if (name === "@/kernel/visualization/useObjectVisualization") return overlaySynthetic({
    useObjectVisualizationSelector: fn => fn({ artifactFieldSelection: pin }),
    useObjectVisualizationController: () => ({ getSnapshot: () => ({ artifactFieldSelection: pin }), setArtifactFieldSelection: () => assert.fail("Read must not mutate selection") }),
  });
  if (name === "../model/artifactFieldOverlayModel") return overlaySynthetic({ artifactInspectionOwnerPlan: entry.namespace.artifactInspectionOwnerPlan,
    artifactOverlayLocator: () => assert.fail("Loading metadata must not be admitted"), artifactUniverseInspectionLocator: () => assert.fail("Loading metadata must not be admitted"),
    prepareArtifactFieldOverlay: () => assert.fail("No payload is ready"), presentArtifactFieldOverlay: () => assert.fail("No payload is ready") });
  if (name === "../model/artifactFieldCarrierModel") return overlaySynthetic({ artifactCarrierQueries: () => assert.fail("No locator is ready"), admitArtifactFieldCarrier: () => assert.fail("No payload is ready") });
  if (name === "../viewport3dResources") return overlaySynthetic({
    useViewport3DFieldVectorRequest: (_request, enabled) => { overlayPayloadEnabled.push(enabled); return overlayNoResource(); },
    useViewport3DArtifactTopology: query => { overlayPayloadEnabled.push(Boolean(query)); return overlayNoResource(); },
  });
  if (name === "../model/viewport3DFieldDataPlan") return overlaySynthetic({ buildViewport3DFieldResourceRequestId: () => "disabled-request" });
  throw new Error(`Unexpected overlay hook import ${name}`);
});
await overlayHook.evaluate();
check("actual Universe hook preserves inspection when live H is conductor-only", () => {
  overlayLiveCatalog = liveUniverseCatalog("H_ant"); overlayLiveCatalog.quantities[0].domain = "magnetic_only"; overlayExecutionCalls = [];
  assert.equal(entry.namespace.artifactCatalogHasExplicitLiveQuantity(overlayLiveCatalog, "H_ant"), true,
    "Regression must distinguish generic live eligibility from Universe eligibility");
  const result = overlayHook.namespace.useArtifactFieldOverlay("H_ant", null, {}, false,
    [{ id: "solve", source_object_id: "source" }], { kind: "airbox", id: "airbox" });
  assert.equal(overlayExecutionCalls.length, 1); assert.equal(overlayExecutionCalls[0].enabled, true);
  assert.equal(result.historical, true, "A magnetic-only live carrier cannot take over the Universe route");
  assert.equal(result.selectedStageId, "stage");
  assert.equal(overlayScopedCalls.length, 2);
  assert.ok(overlayScopedCalls.every(options => options.enabled && options.stageId === "stage"));
});
check("actual Universe hook gives compatible full-domain live H priority", () => {
  overlayLiveCatalog = liveUniverseCatalog("H_ant"); overlayExecutionCalls = [];
  const result = overlayHook.namespace.useArtifactFieldOverlay("H_ant", null, {}, false,
    [{ id: "solve", source_object_id: "source" }], { kind: "airbox", id: "airbox" });
  assert.equal(overlayExecutionCalls[0].enabled, false); assert.equal(result.historical, false);
});
for (const state of ["retained", "absent", "unknown"]) check("actual Universe hook gates catalog and payload reads for " + state + " registry state", () => {
  overlayInspectionState = state;
  overlayLiveCatalog = liveUniverseCatalog("H_ant"); overlayLiveCatalog.quantities[0].domain = "magnetic_only";
  overlayExecutionCalls = []; overlayScopedCalls = []; overlayPayloadEnabled = [];
  const result = overlayHook.namespace.useArtifactFieldOverlay("H_ant", null, {}, false,
    [{ id: "solve", source_object_id: "source" }], { kind: "airbox", id: "airbox" });
  assert.equal(overlayExecutionCalls[0].enabled, true);
  assert.equal(result.selectedStageId, state === "retained" ? "stage" : "");
  assert.equal(overlayScopedCalls.length, 2);
  assert.ok(overlayScopedCalls.every(options => options.enabled === (state === "retained")));
  assert.ok(overlayPayloadEnabled.every(enabled => enabled === false), "Registry discovery cannot qualify unloaded payloads");
  assert.equal(result.model, null);
  assert.equal(result.catalog, null);
});
console.log(JSON.stringify({status:"passed",checks,unit_test_compilation:false}));
