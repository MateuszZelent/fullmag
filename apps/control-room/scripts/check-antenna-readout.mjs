import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const sourceRoot = new URL("../src/", import.meta.url), modules = new Map();
function moduleAt(url) {
  if (!modules.has(url.href)) modules.set(url.href, new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8")), { identifier: url.href }));
  return modules.get(url.href);
}
const readoutModule = moduleAt(new URL("../src/modules/inspector/panels/antenna/AntennaReadoutModel.ts", import.meta.url));
await readoutModule.link((name, referrer) => moduleAt(name.startsWith("@/") ? new URL(`${name.slice(2)}.ts`, sourceRoot) : new URL(`${name}.ts`, referrer.identifier)));
await readoutModule.evaluate();
const { formatAntennaParameter, partitionAntennaReadout } = readoutModule.namespace;
let checks=0;
const check=(name,run)=>{run();checks++;console.log(`PASS ${name}`);};
for (const [value,unit,expected] of [[-0.02,"A","-20 mA"],[0,"A","0 A"],[1,"A","1 A"],[1e-4,"A","0.0001 A"],[5e9,"Hz","5 GHz"],[750e6,"Hz","750 MHz"],[1e-9,"s","1 ns"],[-2e-12,"s","-2 ps"],[0,"s","0 s"],[1e-15,"s","1e-15 s"],[1e-6,"s","1 µs"],[5.8e7,"S/m","58 MS/m"],[1,"rad","1 rad"],[0.5,"","0.5"]]) {
  check(`physical value ${value} ${unit} preserves its scale/sign`,()=>assert.equal(formatAntennaParameter(value,unit),expected));
}
for (const value of [NaN,Infinity,null,undefined,"0",false]) check(`unavailable input ${String(value)} is not a zero result`,()=>assert.equal(formatAntennaParameter(value,"A"),"unavailable A"));
check("partition keeps every row exactly once and preserves order",()=>{
  const rows=[{label:"Validation",value:"invalid"},{label:"ID",value:"immutable",mono:true},{label:"Runtime error",value:"HTTP error",section:"runtime"},{label:"Current",value:"-20 mA"},{label:"Digest",value:"sha256:exact",mono:true,section:"runtime"}];
  const before=JSON.stringify(rows),groups=partitionAntennaReadout(rows);
  assert.deepEqual(groups.parameters.map(row=>row.label),["Validation","Current"]);
  assert.deepEqual(groups.runtime.map(row=>row.label),["Runtime error"]);
  assert.deepEqual(groups.identity.map(row=>row.label),["ID","Digest"]);
  assert.equal(new Set([...groups.parameters,...groups.runtime,...groups.identity]).size,rows.length);
  assert.equal(JSON.stringify(rows),before);
});
console.log(JSON.stringify({state:"passed",checks,scope:"interpreted production readout formatting and grouping; no unit compilation or solve"}));
