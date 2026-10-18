import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const root=new URL("../src/",import.meta.url),cache=new Map();
function load(url){if(!cache.has(url.href))cache.set(url.href,new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url,"utf8")),{identifier:url.href}));return cache.get(url.href);}
const entry=load(new URL("kernel/api/fieldQueryIdentity.ts",root));await entry.link((name,parent)=>load(name.startsWith("@/")?new URL(`${name.slice(2)}.ts`,root):new URL(`${name}.ts`,parent.identifier)));await entry.evaluate();
const q=entry.namespace, revision="12297829382473034410";
const first={carrier_id:`artifact:${"a".repeat(64)}:source_nodes`,expected_carrier_revision:revision,expected_generation_id:"a".repeat(64),stage_id:"stage",scope_kind:"object",scope_id:"conductor",component:"full"};
const second={...first,carrier_id:`artifact:${"b".repeat(64)}:source_nodes`};
let checks=0;function check(name,run){run();checks++;console.log(`PASS ${name}`);}
check("different carrier IDs never share a field resource key",()=>assert.notEqual(q.fieldVectorResourceKey("V_electric",first),q.fieldVectorResourceKey("V_electric",second)));
check("canonical equality includes carrier",()=>assert.equal(q.canonicalFieldVectorQueriesEqual(q.canonicalFieldVectorQuery("V_electric",first),q.canonicalFieldVectorQuery("V_electric",second)),false));
check("serialized carrier and u64 revision survive request replay exactly",()=>{const canonical=q.canonicalFieldVectorQuery("V_electric",first),key=q.serializeCanonicalFieldVectorResourceKey(canonical),parsed=q.parseCanonicalFieldVectorResourceKey(key);assert.equal(parsed.carrierId,first.carrier_id);assert.equal(parsed.expectedCarrierRevision,revision);assert.equal(parsed.stageId,"stage");assert.equal(q.canonicalFieldVectorQueriesEqual(canonical,parsed),true);});
check("carrier is part of the transport query",()=>assert.equal(q.canonicalFieldVectorQueryParams(q.canonicalFieldVectorQuery("V_electric",first)).carrier_id,first.carrier_id));
check("different carriers remain distinct inside one session",()=>{const session={sessionId:"s",sessionEpoch:"s@1"};assert.notEqual(q.sessionScopedFieldVectorResourceKey(session,"V_electric",first),q.sessionScopedFieldVectorResourceKey(session,"V_electric",second));});
check("same carrier does not cross session epochs",()=>assert.notEqual(q.sessionScopedFieldVectorResourceKey({sessionId:"s",sessionEpoch:"s@1"},"V_electric",first),q.sessionScopedFieldVectorResourceKey({sessionId:"s",sessionEpoch:"s@2"},"V_electric",first)));
console.log(JSON.stringify({status:"passed",checks,unit_test_compilation:false}));
