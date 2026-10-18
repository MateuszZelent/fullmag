import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const root = new URL("../src/", import.meta.url), cache = new Map();
function load(url) { if (!cache.has(url.href)) cache.set(url.href, new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8")), { identifier: url.href })); return cache.get(url.href); }
const entry = load(new URL("modules/viewport-3d/model/artifactFieldOverlayModel.ts", root));
await entry.link((name, parent) => load(name.startsWith("@/") ? new URL(`${name.slice(2)}.ts`, root) : new URL(`${name}.ts`, parent.identifier))); await entry.evaluate();
const { buildArtifactFieldOverlayModel: build } = entry.namespace;
const carrier = cache.get(new URL("modules/viewport-3d/model/artifactFieldCarrierModel.ts", root).href).namespace;
const digest = "a".repeat(64), content = `sha256:${"b".repeat(64)}`, source = `sha256:${"c".repeat(64)}`;
const owner = Object.fromEntries(["session_id", "session_epoch", "request_scope_epoch", "run_id", "runtime_stage_id", "authored_stage_id", "module_id", "object_id", "output_id", "native_mesh_identity", "native_topology_identity"].map(key => [key, key]));
Object.assign(owner, { source_digest: source, content_digest: content, historical_inspection: true });
const positions = Float64Array.from([0,0,0, 1,0,0, 0,1,0, 0,0,1, 0,0,0, 0,1,0, 1,0,0, 0,0,-1]);
const first = 9007199254740992n;
const ids = BigUint64Array.from([first,first+1n,first+2n,first+3n, first,first+2n,first+1n,first+4n]);
const locator = { carrier_scope_kind: "object", carrier_scope_id: "object_id", carrier_id: `artifact:${digest}:tet4_cell_local_nodes`, carrier_digest: digest, carrier_revision: "1", indexing: "tet4_cell_local_nodes", sample_count: 8, coordinate_frame: "world", coordinate_unit: "m", topology_binary_schema: "FMMT.v2", owner };
const mapping = { indexing: "tet4_cell_local_nodes", identityIds: ids, elementOrdinals: BigUint64Array.from([10n,10n,10n,10n,20n,20n,20n,20n]), localVertexIndices: Uint8Array.from([0,1,2,3,0,1,2,3]) };
const values = Float64Array.from([1,2,3, 2,3,4, 3,4,5, 4,5,6, -10,-20,-30, -20,-30,-40, -30,-40,-50, -40,-50,-60]);
const field = { formatVersion: 6, sourceKind: "artifact_inspection", artifactMapping: mapping, domainGenerationId: digest, meshTopologyHash: digest, meshTopologyRevision: "1", sourceId: source, fieldGenerationId: content, scopeKind: "object", scopeId: "object_id", indexing: "tet4_cell_local_nodes", pointCount: 8, quantityId: "J_charge", nComp: 3, values, sourceRevision: "2" };
const topology = { formatVersion: 2, nodeCount: 8, positions, cellTypes: Uint32Array.from([1,1]), cellOffsets: Uint32Array.from([0,4,8]), cellNodes: Uint32Array.from([0,1,2,3,4,5,6,7]) };
const headers = { carrierId: locator.carrier_id, carrierDigest: digest, carrierRevision: "1", identityIssues: [] }, geometry = { ...headers, coordinateFrame: "world", coordinateUnit: "m" };
const settings = { shaderColorMode: "x", vectorsVisible: true, vectorBudget: 8, vectorLengthScale: 1, vectorCenteringEnabled: false, scalarColorPalette: "viridis", vectorColorMode: "magnitude", shaderVisible: true, wireframeVisible: true };
function fixture() { return structuredClone({ locator, field, topology, headers, geometry, settings }); }
function render(f) { return build(carrier.admitArtifactFieldCarrier(f.locator, f.field, f.headers, f.topology, f.geometry), f.settings); }
let checks = 0;
function check(name, run) { run(); checks++; console.log(`PASS ${name}`); }
check("two J cells retain six exterior faces and distinct local values", () => {
  const f = fixture(), before = JSON.stringify([...f.field.values]), model = render(f);
  assert.equal(model.quantityId, "J_charge"); assert.equal(model.unit, "A/m^2"); assert.equal(model.surfaceTriangles.length, 18);
  for (let i=0; i<18; i+=3) { const face = [...model.surfaceTriangles.subarray(i,i+3)]; assert.ok(face.every(v=>v<4) || face.every(v=>v>=4)); assert.notDeepEqual(face.slice().sort((a,b)=>a-b), [0,1,2]); assert.notDeepEqual(face.slice().sort((a,b)=>a-b), [4,5,6]); }
  assert.deepEqual([...model.scalarValues], [1,2,3,4,-10,-20,-30,-40]);
  for (let i=0; i<values.length; i++) assert.ok(Math.abs(model.surfaceVectorValues[i] * model.surfaceVectorScale - values[i]) < 1e-5);
  assert.equal(JSON.stringify([...f.field.values]), before); assert.deepEqual(f.topology.positions, positions); assert.deepEqual(f.field.artifactMapping.identityIds, ids);
});
check("presentation reuses immutable geometry preparation and raw field arrays", () => {
  const f = fixture();
  const data = entry.namespace.prepareArtifactFieldOverlay(carrier.admitArtifactFieldCarrier(f.locator, f.field, f.headers, f.topology, f.geometry));
  const original = entry.namespace.presentArtifactFieldOverlay(data, f.settings);
  const updated = entry.namespace.presentArtifactFieldOverlay(data, { ...f.settings, scalarColorPalette: "plasma", surfaceOpacityPercent: 45 });
  assert.strictEqual(updated.geometry, original.geometry);
  for (const key of ["positions", "surfaceTriangles", "surfaceEdges", "surfaceVectorValues"]) assert.strictEqual(updated[key], original[key]);
  assert.deepEqual(updated.scalarValues, original.scalarValues);
  assert.deepEqual(f.field.values, values);
});
check("authored glyph budget selects exact local samples without deleting the surface",()=>{
 const f=fixture();f.settings.vectorBudget=3;const model=render(f);
 assert.equal(model.surfaceTriangles.length,18);assert.equal(model.count,8);
 assert.deepEqual([...model.vectorSampleIndices],[0,3,7]);assert.equal(model.vectorSegments.length,21);
 assert.deepEqual([...model.scalarValues],[1,2,3,4,-10,-20,-30,-40]);
 const full=render(fixture());for(let i=0;i<3;i++)for(let axis=0;axis<6;axis++)assert.equal(model.vectorSegments[i*7+axis],full.vectorSegments[model.vectorSampleIndices[i]*7+axis]);
 assert.deepEqual([...render(f).vectorSampleIndices],[0,3,7]);
});
check("zero glyph budget preserves surfaces and raw fields",()=>{const f=fixture();f.settings.vectorBudget=0;const model=render(f);assert.equal(model.vectorSegments,null);assert.equal(model.vectorSampleIndices.length,0);assert.equal(model.surfaceTriangles.length,18);assert.equal(model.maximum,4);});
for (const [name, mutate] of [
  ["same stable ID has other geometry", f=>{f.topology.positions[12]=0.01;}],
  ["same stable ID has different signed zero", f=>{f.topology.positions[12]=-0;}],
  ["duplicate physical cell", f=>{f.field.artifactMapping.identityIds.set(ids.subarray(0,4),4); f.topology.positions.set(positions.subarray(0,12),12);}],
  ["overlapping neighbors", f=>{f.topology.positions[23]=2;}],
  ["degenerate cell", f=>{f.topology.positions[11]=0;}],
  ["trace count mismatch", f=>{f.field.artifactMapping.identityIds=ids.slice(0,7);}],
  ["local topology merges values", f=>{f.topology.cellNodes[4]=0;}],
  ["invalid vector budget is rejected", f=>{f.settings.vectorBudget=NaN;}],
  ["non-finite J", f=>{f.field.values[0]=Infinity;}],
]) check(name, ()=>{const f=fixture();mutate(f);assert.throws(()=>render(f));});
check("equal coordinates with different IDs do not merge", ()=>{const f=fixture();for(let i=4;i<8;i++)f.field.artifactMapping.identityIds[i]+=100n; assert.equal(render(f).surfaceTriangles.length,24);});
const boundary = cache.get(new URL("modules/viewport-3d/model/artifactTet4Boundary.ts", root).href).namespace.artifactCellLocalBoundary;
check("third neighbor on one stable face is rejected", ()=>{
  const xyz = new Float64Array(positions.length + 12); xyz.set(positions); xyz.set([0,0,0,1,0,0,0,1,0,0,0,2], positions.length);
  const stable = new BigUint64Array(12); stable.set(ids); stable.set([first,first+1n,first+2n,first+5n],8);
  assert.throws(()=>boundary(xyz,stable));
});
for (const [name,mutate] of [
  ["missing local ordinals", f=>{f.field.artifactMapping.elementOrdinals=null;}],
  ["duplicate element identity", f=>{f.field.artifactMapping.elementOrdinals.fill(10n);}],
  ["mixed local element", f=>{f.field.artifactMapping.elementOrdinals[1]=11n;}],
  ["wrong local order", f=>{f.field.artifactMapping.localVertexIndices[1]=0;}],
]) check(name,()=>{const f=fixture();mutate(f);assert.throws(()=>render(f));});
check("J metadata requires its canonical unit and historical owner lane", ()=>{
  const c = { quantity_id: "J_charge", provider: "available", request: "field_vector", materialization: "materialized", render: "renderable", publication: "interactive", reason_code: "historical_inspection_read_only", lane: "artifact_inspection_read_only", carriers: [{ carrier_id: locator.carrier_id, carrier_fingerprint: digest, scope_kind: "object", scope_id: "object_id", payload_state: "historical", payload_version: "FMVP.v6", components: 3, indexing: "tet4_cell_local_nodes" }] };
  const m = { quantity_id:"J_charge",unit:"A/m^2",components:3,state:"stale_complete",materialization_reason_code:"historical_inspection_read_only",resolved_capability:c,artifact_field_locator:locator };
  const session = { sessionId:"session_id",sessionEpoch:"session_epoch",requestScopeEpoch:"request_scope_epoch" };
  assert.equal(entry.namespace.artifactOverlayLocator(m,session,"object_id","J_charge").carrier_id,locator.carrier_id);
  assert.throws(()=>entry.namespace.artifactOverlayLocator({...m,unit:"A/m"},session,"object_id","J_charge"));
  assert.throws(()=>entry.namespace.artifactOverlayLocator({...m,resolved_capability:{...c,lane:"live"}},session,"object_id","J_charge"));
  assert.throws(()=>entry.namespace.artifactOverlayLocator(m,{...session,sessionEpoch:"other"},"object_id","J_charge"));
  assert.throws(()=>entry.namespace.artifactOverlayLocator(m,session,"foreign","J_charge"));
  assert.throws(()=>entry.namespace.artifactOverlayLocator(m,session,"object_id"));
});
for (const indexing of ["sample_nodes", "point_samples"]) check(`existing raw H keeps its ${indexing} carrier and SI unit`, ()=>{
  const f=fixture(); f.locator.indexing=indexing; f.locator.sample_count=4; f.locator.carrier_id=`artifact:${digest}:${indexing}`;
  Object.assign(f.field,{quantityId:"H_ant",pointCount:4,indexing,values:values.slice(0,12),artifactMapping:{indexing,identityIds:BigUint64Array.from([0n,1n,2n,3n]),elementOrdinals:null,localVertexIndices:null}});
  f.topology.positions=positions.slice(0,12);f.topology.nodeCount=4;
  Object.assign(f.topology,indexing==="sample_nodes"?{cellTypes:Uint32Array.from([1]),cellOffsets:Uint32Array.from([0,4]),cellNodes:Uint32Array.from([0,1,2,3])}:{cellTypes:undefined,cellOffsets:undefined,cellNodes:undefined});
  f.headers.carrierId=f.locator.carrier_id; f.geometry.carrierId=f.locator.carrier_id;
  if(indexing==="point_samples"){f.settings.shaderVisible=false;f.settings.wireframeVisible=false;}
  const model=render(f);assert.equal(model.quantityId,"H_ant");assert.equal(model.unit,"A/m");assert.equal(model.count,4);
  assert.equal(model.surfaceTriangles?.length??0,indexing==="sample_nodes"?12:0);assert.equal(model.vectorSegments.length,28);
  const capability={quantity_id:"H_ant",provider:"available",request:"field_vector",materialization:"materialized",render:"renderable",publication:"interactive",reason_code:"historical_inspection_read_only",lane:"artifact_inspection_read_only",carriers:[{carrier_id:f.locator.carrier_id,carrier_fingerprint:digest,scope_kind:"object",scope_id:"object_id",payload_state:"historical",payload_version:"FMVP.v6",components:3,indexing}]};
  const metadata={quantity_id:"H_ant",unit:"A/m",components:3,state:"stale_complete",materialization_reason_code:"historical_inspection_read_only",resolved_capability:capability,artifact_field_locator:f.locator};
  assert.equal(entry.namespace.artifactOverlayLocator(metadata,{sessionId:"session_id",sessionEpoch:"session_epoch",requestScopeEpoch:"request_scope_epoch"},"object_id").carrier_id,f.locator.carrier_id);
});
check("signed V uses source-node scalar interpolation and never creates vector glyphs",()=>{
  const f=fixture(), indexing="source_nodes";
  Object.assign(f.locator,{indexing,sample_count:4,carrier_id:`artifact:${digest}:${indexing}`});
  Object.assign(f.field,{quantityId:"V_electric",nComp:1,pointCount:4,indexing,values:Float64Array.from([-2,0,1,4]),artifactMapping:{indexing,identityIds:ids.slice(0,4),elementOrdinals:null,localVertexIndices:null}});
  Object.assign(f.topology,{positions:positions.slice(0,12),nodeCount:4,cellTypes:Uint32Array.from([1]),cellOffsets:Uint32Array.from([0,4]),cellNodes:Uint32Array.from([0,1,2,3])});
  f.headers.carrierId=f.locator.carrier_id;f.geometry.carrierId=f.locator.carrier_id;f.settings.vectorBudget=0;
  const m=render(f);assert.equal(m.scalar,true);assert.equal(m.unit,"V");assert.equal(m.minimum,-2);assert.equal(m.maximum,4);assert.deepEqual([...m.scalarValues],[-2,0,1,4]);assert.equal(m.vectorSegments,null);assert.equal(m.surfaceVectorValues.length,0);assert.equal(m.surfaceTriangles.length,12);
  const normalized=m.geometry.surfaceScalarValues;assert.equal(normalized[0],0);assert.equal(normalized[3],1);assert.ok(Math.abs(normalized[1]-1/3)<1e-7);assert.equal(normalized[2],.5);
  f.settings.surfaceProjectionMode="surface_faces";const face=render(f);
  assert.equal(face.surface.scalarValues.length,12);assert.ok(Math.abs(face.minimum+1/3)<1e-12);assert.ok(Math.abs(face.maximum-5/3)<1e-12);
  assert.deepEqual([...face.scalarValues],[-2,0,1,4]);
  assert.equal(Math.min(...face.surface.scalarValues),0);assert.equal(Math.max(...face.surface.scalarValues),1);
  f.field.nComp=3;assert.throws(()=>render(f));
});
const glyphRenderer=load(new URL("modules/viewport-3d/layers/vectorGlyphGeometry.ts",root));
await glyphRenderer.link((name,parent)=>load(name.startsWith("@/")?new URL(`${name.slice(2)}.ts`,root):new URL(`${name}.ts`,parent.identifier)));await glyphRenderer.evaluate();
for(const count of [7,14])check(`${count} samples keep exact renderer glyph cardinality`,()=>{
  const f=fixture(),indexing="point_samples";f.locator.indexing=indexing;f.locator.sample_count=count;f.locator.carrier_id=`artifact:${digest}:${indexing}`;
  const xyz=Float64Array.from(Array.from({length:count},(_,i)=>[0,0,i]).flat()), data=Float64Array.from(Array.from({length:count},(_,i)=>[i+1,0,0]).flat());
  Object.assign(f.field,{quantityId:"H_ant",pointCount:count,indexing,values:data,artifactMapping:{indexing,identityIds:BigUint64Array.from(Array.from({length:count},(_,i)=>BigInt(i))),elementOrdinals:null,localVertexIndices:null}});
  Object.assign(f.topology,{positions:xyz,nodeCount:count,cellTypes:undefined,cellOffsets:undefined,cellNodes:undefined});f.headers.carrierId=f.locator.carrier_id;f.geometry.carrierId=f.locator.carrier_id;
  f.settings.shaderVisible=false;f.settings.wireframeVisible=false;f.settings.vectorBudget=count;
  const model=render(f),transforms=glyphRenderer.namespace.buildVectorGlyphTransforms(model.vectorSegments);
  assert.equal(transforms.count,count);
  for(let i=0;i<count;i++)assert.deepEqual([...transforms.directions.subarray(i*3,i*3+3)],[1,0,0]);
  f.settings.geometryScope="surface";assert.throws(()=>render(f),/owned boundary/);
});
check("surface scope excludes interior H samples and preserves global values and scale",()=>{
 const f=fixture();f.settings.visible=true;const indexing="sample_nodes",cells=[0,1,2,4,0,1,4,3,0,4,2,3,4,1,2,3];
 f.locator.indexing=indexing;f.locator.sample_count=5;f.locator.carrier_id=`artifact:${digest}:${indexing}`;
 Object.assign(f.field,{quantityId:"H_ant",pointCount:5,indexing,values:Float64Array.from([1,0,0,0,2,0,0,0,3,-4,0,0,0,0,2]),artifactMapping:{indexing,identityIds:BigUint64Array.from([0n,1n,2n,3n,4n]),elementOrdinals:null,localVertexIndices:null}});
 Object.assign(f.topology,{positions:Float64Array.from([0,0,0,1,0,0,0,1,0,0,0,1,.2,.2,.2]),nodeCount:5,cellTypes:Uint32Array.from([1,1,1,1]),cellOffsets:Uint32Array.from([0,4,8,12,16]),cellNodes:Uint32Array.from(cells)});
 f.headers.carrierId=f.locator.carrier_id;f.geometry.carrierId=f.locator.carrier_id;
 const full=render({...f,settings:{...f.settings,geometryScope:"full"}}),surface=render({...f,settings:{...f.settings,geometryScope:"surface"}});
 assert.deepEqual([...full.pointSampleIndices],[0,1,2,3,4]);assert.deepEqual([...surface.pointSampleIndices],[0,1,2,3]);
 assert.equal(full.glyphCount,5);assert.equal(surface.glyphCount,4);assert.equal(surface.surfaceTriangles.length,12);
 const counts=entry.namespace.artifactInspectionPresentation(surface);assert.equal(counts.capacity.fullCount,5);assert.equal(counts.capacity.surfaceCount,4);assert.equal(counts.decodedSampleCount,5);assert.equal(counts.adoptedGlyphCount,null);
 const faces=render({...f,settings:{...f.settings,geometryScope:"surface",surfaceProjectionMode:"surface_faces"}});assert.equal(entry.namespace.artifactInspectionPresentation(faces).key,counts.key);assert.equal(entry.namespace.artifactInspectionPresentation(faces).capacity.surfaceCount,4);

 assert.deepEqual(surface.scalarValues,full.scalarValues);assert.equal(surface.maximumVectorNorm,full.maximumVectorNorm);
 for(let i=0;i<4;i++)for(let axis=0;axis<7;axis++)assert.equal(surface.vectorSegments[i*7+axis],full.vectorSegments[i*7+axis]);
});
check("surface J keeps original boundary-local slots and distinct values",()=>{
 const f=fixture(),corners=[[0,0,0],[1,0,0],[0,1,0],[0,0,1],[.2,.2,.2]],cells=[0,1,2,4,0,1,4,3,0,4,2,3,4,1,2,3];
 f.locator.sample_count=16;Object.assign(f.field,{pointCount:16,values:Float64Array.from(cells.flatMap((_,i)=>[i+1,0,0])),artifactMapping:{indexing:"tet4_cell_local_nodes",identityIds:BigUint64Array.from(cells.map(i=>first+BigInt(i))),elementOrdinals:BigUint64Array.from(cells.map((_,i)=>BigInt(Math.floor(i/4)))),localVertexIndices:Uint8Array.from(cells.map((_,i)=>i%4))}});
 Object.assign(f.topology,{positions:Float64Array.from(cells.flatMap(i=>corners[i])),nodeCount:16,cellTypes:Uint32Array.from([1,1,1,1]),cellOffsets:Uint32Array.from([0,4,8,12,16]),cellNodes:Uint32Array.from(cells.map((_,i)=>i))});
 const full=render({...f,settings:{...f.settings,vectorBudget:16,geometryScope:"full"}}),surface=render({...f,settings:{...f.settings,vectorBudget:16,geometryScope:"surface"}});
 assert.equal(full.glyphCount,16);assert.equal(surface.glyphCount,12);const counts=entry.namespace.artifactInspectionPresentation(surface);assert.equal(counts.capacity.fullCount,16);assert.equal(counts.capacity.surfaceCount,12);assert.equal(counts.decodedSampleCount,16);assert.deepEqual([...surface.vectorSampleIndices],[0,1,2,4,5,7,8,10,11,13,14,15]);
 assert.deepEqual([...surface.scalarValues],Array.from({length:16},(_,i)=>i+1));
 assert.equal(surface.surfaceTriangles.length,12);
});
const derivedCacheModule=load(new URL("modules/viewport-3d/build-engine/cache/viewport3dDerivedBufferCache.ts",root));
await derivedCacheModule.link((name,parent)=>load(new URL(`${name}.ts`,parent.identifier)));await derivedCacheModule.evaluate();
check("pending glyph selection cannot adopt transforms from another budget",()=>{
 const f=fixture(),full=render(f),small=render({...f,settings:{...f.settings,vectorBudget:3}}),cache=derivedCacheModule.namespace.createViewport3DDerivedBufferCache({maxBytes:1024,maxEntries:4});
 const group=model=>`${model.key}:${model.glyphSelectionKey}`;
 cache.putReady({buffer:{sourceIndices:full.vectorSampleIndices},estimatedBytes:32,fieldRevision:"2",groupKey:group(full),key:"full",lane:"vector-glyph",targetRevision:"1",topologyRevision:"1"});
 assert.equal(cache.resolveVisible({fieldRevision:"2",groupKey:group(small),key:"pending-small",lane:"vector-glyph",targetRevision:"1",topologyRevision:"1"}).state,"invalid");
 const nextField=fixture();nextField.field.fieldGenerationId=`sha256:${"e".repeat(64)}`;nextField.locator.owner.content_digest=nextField.field.fieldGenerationId;const nextPhysical=render(nextField);
 assert.equal(cache.resolveVisible({fieldRevision:"2",groupKey:group(nextPhysical),key:"pending-physical",lane:"vector-glyph",targetRevision:"1",topologyRevision:"1"}).state,"invalid");
 const recolored=render({...f,settings:{...f.settings,scalarColorPalette:"plasma"}});
 assert.equal(group(recolored),group(full));assert.equal(cache.resolveVisible({fieldRevision:"2",groupKey:group(recolored),key:"pending-color",lane:"vector-glyph",targetRevision:"1",topologyRevision:"1"}).state,"stale-compatible");
 cache.dispose();
});
check("surface lift translates anchors without changing vectors or raw J",()=>{
 const f=fixture(),base=render({...f,settings:{...f.settings,geometryScope:"surface",vectorCenteringEnabled:true}}),lifted=render({...f,settings:{...f.settings,geometryScope:"surface",vectorCenteringEnabled:true,vectorSurfaceOffsetEnabled:true,vectorSurfaceOffsetScale:0}});
 assert.ok(lifted.surfaceOffsetDistance>0);assert.notDeepEqual([...lifted.vectorSegments],[...base.vectorSegments]);
 assert.deepEqual(lifted.scalarValues,base.scalarValues);assert.deepEqual(lifted.geometry.field.values,values);
 for(let i=0;i<base.glyphCount;i++)for(let axis=0;axis<3;axis++){
  const start=i*7+axis,end=start+3,delta=lifted.vectorSegments[start]-base.vectorSegments[start];
  assert.ok(Math.abs(delta-(lifted.vectorSegments[end]-base.vectorSegments[end]))<1e-6);
  assert.ok(Math.abs(delta-lifted.geometry.surfaceNormals[lifted.vectorSampleIndices[i]*3+axis]*lifted.surfaceOffsetDistance)<1e-6);
 }
 assert.deepEqual(lifted.pointSampleIndices,base.pointSampleIndices);assert.deepEqual(lifted.geometry.positions,base.geometry.positions);
 assert.notEqual(lifted.glyphStyleKey,base.glyphStyleKey);
});
check("surface normals share geometry identity without averaging local J values",()=>{
 const model=render(fixture()),normals=model.geometry.surfaceNormals;
 for(const [a,b] of [[0,4],[1,6],[2,5]])for(let axis=0;axis<3;axis++)assert.equal(normals[a*3+axis],normals[b*3+axis]);
 assert.deepEqual([...model.scalarValues],[1,2,3,4,-10,-20,-30,-40]);
 for(let i=0;i<8;i++)assert.ok(Math.abs(Math.hypot(...normals.subarray(i*3,i*3+3))-1)<1e-6);
});
check("lift clearance follows shared center/tail semantics and full scope keeps physical anchors",()=>{
 const f=fixture(),settings={...f.settings,geometryScope:"surface",vectorSurfaceOffsetEnabled:true,vectorSurfaceOffsetScale:0};
 const tail=render({...f,settings:{...settings,vectorCenteringEnabled:false}}),center=render({...f,settings:{...settings,vectorCenteringEnabled:true}}),extra=render({...f,settings:{...settings,vectorSurfaceOffsetScale:.5,vectorCenteringEnabled:true}});
 assert.equal(tail.surfaceOffsetDistance,center.surfaceOffsetDistance*2);assert.equal(extra.surfaceOffsetDistance,tail.surfaceOffsetDistance);
 const full=render({...f,settings:{...settings,geometryScope:"full"}});assert.equal(full.surfaceOffsetDistance,0);assert.deepEqual(full.vectorSegments,render(fixture()).vectorSegments);
 assert.throws(()=>render({...f,settings:{...settings,vectorSurfaceOffsetScale:NaN}}),/surface gap/);
});
check("face projection preserves separate local J traces and averages components before norm",()=>{
 const f=fixture();f.settings.surfaceProjectionMode="surface_faces";f.settings.shaderColorMode="magnitude";
 const m=render(f);assert.equal(m.surface.positions.length,54);assert.equal(m.surface.triangles.length,18);
 const norms=[];
 for(let face=0;face<m.surfaceTriangles.length;face+=3){
  const mean=[0,0,0];for(let c=0;c<3;c++)for(let a=0;a<3;a++)mean[a]+=f.field.values[m.surfaceTriangles[face+c]*3+a]/3;
  norms.push(Math.hypot(...mean));
  for(let c=0;c<3;c++)for(let a=0;a<3;a++)assert.ok(Math.abs(m.surface.values[(face+c)*3+a]-mean[a])<1e-12);
 }
 assert.ok(Math.abs(m.minimum-Math.min(...norms))<1e-12);assert.ok(Math.abs(m.maximum-Math.max(...norms))<1e-12);
 assert.deepEqual(f.field.values,values);assert.deepEqual(m.vectorSegments,render(fixture()).vectorSegments);
 const data=entry.namespace.prepareArtifactFieldOverlay(carrier.admitArtifactFieldCarrier(f.locator,f.field,f.headers,f.topology,f.geometry));
 const a=entry.namespace.presentArtifactFieldOverlay(data,f.settings),b=entry.namespace.presentArtifactFieldOverlay(data,{...f.settings,scalarColorPalette:"plasma"});assert.strictEqual(a.surface,b.surface);
});
check("unsupported thickness projection is explicit only when a surface is requested",()=>{
 const f=fixture();f.settings.surfaceProjectionMode="thickness_average_z";assert.throws(()=>render(f),/Thickness projection/);
 f.settings.shaderVisible=false;assert.equal(render(f).surface.values,f.field.values);
});
check("published surface range carries projected bounds and exact immutable owner",()=>{
 const f=fixture();f.settings.visible=true;f.settings.surfaceProjectionMode="surface_faces";const model=render(f);
 const [row]=entry.namespace.artifactRenderedSurfaceRanges(model);assert.equal(row.range.min,model.minimum);assert.equal(row.range.max,model.maximum);
 assert.equal(row.component,"x");assert.equal(row.scopeKind,"object");assert.equal(row.scopeId,"object_id");
 const key=cache.get(new URL("kernel/visualization/artifactFieldSelection.ts",root).href).namespace.artifactSurfaceRangeKey;
 assert.equal(row.inspectionKey,key({...model.locator.owner,quantityId:"J_charge"},{carrier_id:model.locator.carrier_id,expected_carrier_revision:model.locator.carrier_revision,scope_kind:"object",scope_id:"object_id"},"surface_faces"));
 for(const settings of [{...f.settings,visible:false},{...f.settings,shaderVisible:false},{...f.settings,surfaceColorSource:"solid"}])assert.deepEqual(entry.namespace.artifactRenderedSurfaceRanges(build(carrier.admitArtifactFieldCarrier(f.locator,f.field,f.headers,f.topology,f.geometry),settings)),[]);
 assert.deepEqual(entry.namespace.artifactRenderedSurfaceRanges(null),[]);
});
check("source inspection accepts its own separate sampling carrier without adopting a foreign source",()=>{
 const quantity="H_ant",target="sampling-target", sourceObject="source-antenna";
 const h={...locator,carrier_scope_id:target,indexing:"sample_nodes",owner:{...owner,object_id:sourceObject}};
 const c={quantity_id:quantity,provider:"available",request:"field_vector",materialization:"materialized",render:"renderable",publication:"interactive",reason_code:"historical_inspection_read_only",lane:"artifact_inspection_read_only",carriers:[{carrier_id:h.carrier_id,carrier_fingerprint:digest,scope_kind:"object",scope_id:target,payload_state:"historical",payload_version:"FMVP.v6",components:3,indexing:"sample_nodes"}]};
 h.carrier_id=`artifact:${digest}:sample_nodes`;c.carriers[0].carrier_id=h.carrier_id;
 const m={quantity_id:quantity,unit:"A/m",components:3,state:"stale_complete",materialization_reason_code:"historical_inspection_read_only",resolved_capability:c,artifact_field_locator:h};
 const session={sessionId:owner.session_id,sessionEpoch:owner.session_epoch,requestScopeEpoch:owner.request_scope_epoch};
 assert.throws(()=>entry.namespace.artifactOverlayLocator(m,session,sourceObject,"H_ant"));
 assert.equal(entry.namespace.artifactOverlayLocator(m,session,sourceObject,"H_ant",sourceObject).carrier_scope_id,target);
 assert.throws(()=>entry.namespace.artifactOverlayLocator(m,session,"foreign-source","H_ant",sourceObject));
 assert.throws(()=>entry.namespace.artifactOverlayLocator({...m,artifact_field_locator:{...h,owner:{...h.owner,object_id:"foreign-source"}}},session,sourceObject,"H_ant",sourceObject));
 assert.equal(entry.namespace.artifactOverlayLocator(m,session,target,"H_ant").carrier_scope_id,target);
});
check("carrier accounting never labels requested glyphs as GPU adoption",()=>{
 const f=fixture();f.settings.visible=true;const model=render(f),counts=entry.namespace.artifactInspectionPresentation(model);assert.equal(counts.expectedGlyphCount,8);assert.equal(counts.adoptedGlyphCount,null);
 assert.equal(entry.namespace.artifactInspectionPresentation(render({...f,settings:{...f.settings,vectorBudget:0}})).adoptedGlyphCount,0);
 assert.equal(entry.namespace.artifactInspectionPresentation(render({...f,settings:{...f.settings,visible:false}})).expectedGlyphCount,0);
 assert.equal(entry.namespace.artifactInspectionPresentation(null),null);
});
console.log(JSON.stringify({status:"passed",checks,unit_test_compilation:false,browser_qualification:false}));
