import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = new URL("../src/kernel/api/artifactFieldResponseIdentity.ts", import.meta.url);
const { artifactFieldResponseIdentityError: admission } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(readFileSync(source,"utf8"))).toString("base64")}`);
const digest="a".repeat(64), revision="12297829382473034410";
function fixture(q="J_charge") {
  const indexing=q==="V_electric"?"source_nodes":q==="H_ant"?"sample_nodes":"tet4_cell_local_nodes", carrier=`artifact:${digest}:${indexing}`;
  const field={formatVersion:6,quantityId:q,pointCount:4,valueCount:q==="V_electric"?4:12,nComp:q==="V_electric"?1:3,meshTopologyHash:digest,meshTopologyRevision:revision,indexing,scopeKind:"object",scopeId:"conductor",sourceId:`sha256:${"b".repeat(64)}`,sourceRevision:"9007199254740993",fieldGenerationId:`sha256:${"c".repeat(64)}`};
  const query={carrier_id:carrier,expected_carrier_revision:revision,expected_generation_id:digest,stage_id:"immutable-stage",component:"full",scope_kind:"object",scope_id:"conductor"};
  const metadata={component:"full",carrierId:carrier,carrierRevision:revision,carrierDigest:digest,quantityId:q,pointCount:4,valueCount:field.valueCount,nComp:field.nComp,domainGenerationId:digest,fieldIndexing:indexing,scopeKind:"object",scopeId:"conductor",sourceKind:"artifact_inspection",sourceId:field.sourceId,sourceRevision:field.sourceRevision,fieldGenerationId:field.fieldGenerationId,meshTopologyHash:`sha256:${digest}`,identityIssues:[]};
  return {q,query,field,metadata};
}
let checks=0;function check(name,run){run();checks++;console.log(`PASS ${name}`);}
for(const q of ["H_ant","J_charge","V_electric"])check(`${q} exact pinned field admitted`,()=>{const f=fixture(q);assert.equal(admission(f.q,f.query,f.field,f.metadata),null);});
for(const [name,mutate] of [
 ["unsolicited artifact",f=>{delete f.query.carrier_id;}],
 ["wrong carrier",f=>{f.query.carrier_id="another";}],
 ["wrong revision",f=>{f.query.expected_carrier_revision="1";}],
 ["wrong generation",f=>{f.query.expected_generation_id="d".repeat(64);}],
 ["missing stage",f=>{delete f.query.stage_id;}],
 ["empty stage",f=>{f.query.stage_id="  ";}],
 ["different component",f=>{f.query.component="x";}],
 ["different response component",f=>{f.metadata.component="magnitude";}],
 ["different quantity",f=>{f.q="H_ant";}],
 ["different scope",f=>{f.query.scope_kind="full";}],
 ["different object",f=>{f.query.scope_id="other";}],
 ["wrong binary schema",f=>{f.field.formatVersion=5;}],
 ["header/payload issue",f=>{f.metadata.identityIssues=[{field:"scopeId"}];}],
 ["topology digest missing",f=>{f.metadata.meshTopologyHash=null;}],
 ["topology digest mismatch",f=>{f.metadata.meshTopologyHash="d".repeat(64);}],
])check(name,()=>{const f=fixture();mutate(f);assert.equal(typeof admission(f.q,f.query,f.field,f.metadata),"string");});
for(const key of ["component","carrierId","carrierRevision","carrierDigest","quantityId","pointCount","valueCount","nComp","domainGenerationId","fieldIndexing","scopeKind","scopeId","sourceKind","sourceId","sourceRevision","fieldGenerationId"])check(`missing ${key} rejected`,()=>{const f=fixture();delete f.metadata[key];assert.equal(typeof admission(f.q,f.query,f.field,f.metadata),"string");});
check("full-scope carrier allows absent scope ID without adopting object scope",()=>{const f=fixture();f.query.scope_kind=f.field.scopeKind=f.metadata.scopeKind="full";delete f.query.scope_id;f.field.scopeId=f.metadata.scopeId=null;assert.equal(admission(f.q,f.query,f.field,f.metadata),null);});
check("ordinary legacy field behavior remains with its existing validation",()=>{const f=fixture();f.field.formatVersion=5;assert.equal(admission(f.q,{},f.field,f.metadata),null);});
console.log(JSON.stringify({status:"passed",checks,unit_test_compilation:false,scope:"transport request/header identity; owner/topology adapter admission remains mandatory"}));
