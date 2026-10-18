import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
const root=new URL("../src/",import.meta.url),cache=new Map();
function moduleAt(url){if(!cache.has(url.href))cache.set(url.href,new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url,"utf8")),{identifier:url.href}));return cache.get(url.href);}
const entry=moduleAt(new URL("modules/inspector/panels/antenna/AntennaDriveBindingsModel.ts",root));
await entry.link((name,referrer)=>moduleAt(name.startsWith("@/")?new URL(`${name.slice(2)}.ts`,root):new URL(`${name}.ts`,referrer.identifier)));await entry.evaluate();
const {antennaDriveBindingOptions:options,validateAntennaDriveBinding:validate}=entry.namespace;
const drive={id:"drive",projection_ref:"p1",port_mode_id:"port1"};
const port={id:"port1",source_object_id:"source",current_transport_id:"charge"};
const stage={id:"solve1",source_object_id:"source",current_transport_id:"charge",port_mode_ids:["port1"],outputs:[{id:"basis1",quantity:"H_ant_basis"}]};
const projection={id:"p1",solution:{kind:"stage_output",stage_id:"solve1",output_id:"basis1"},target:{kind:"object",object_id:"target"}};
const scene={objects:[{id:"source",name:"Antenna"},{id:"target",name:"Receiver"}],current_transports:[{name:"charge"}],antenna_port_modes:[port,{...port,id:"port2"}],antenna_field_solve_stages:[stage,{...stage,id:"solve2",port_mode_ids:["port2"],outputs:[{id:"basis2",quantity:"H_ant_basis"}]}],antenna_target_projections:[projection,{...projection,id:"p2",solution:{kind:"stage_output",stage_id:"solve2",output_id:"basis2"}}]};
let checks=0;const check=(name,run)=>{run();checks++;console.log(`PASS ${name}`);};
check("both compatible pairs preserve their exact IDs",()=>assert.equal(JSON.stringify(options(scene,drive).map(o=>[o.projectionRef,o.portModeId])),JSON.stringify([["p1","port1"],["p2","port2"]])));
check("projection label includes the actual target name",()=>assert.match(options(scene,drive)[1].label,/Receiver/));
check("valid rebind accepts the paired port",()=>validate(scene,drive,{...drive,projection_ref:"p2",port_mode_id:"port2"}));
check("mismatched port is refused",()=>assert.throws(()=>validate(scene,drive,{...drive,projection_ref:"p2"}),/matching port/));
for(const [name,mutate] of [
 ["locked source",s=>{s.objects[0].locked=true;}],
 ["missing source",s=>{s.objects=s.objects.slice(1);}],
 ["duplicate source",s=>{s.objects.push({...s.objects[0]});}],
 ["missing target",s=>{s.objects=s.objects.slice(0,1);}],
 ["duplicate target",s=>{s.objects.push({...s.objects[1]});}],
 ["duplicate original projection",s=>{s.antenna_target_projections.push({...s.antenna_target_projections[0]});}],
 ["missing original projection",s=>{s.antenna_target_projections=s.antenna_target_projections.slice(1);}],
])check(name+" yields no borrowed fallback",()=>{const copy=structuredClone(scene);mutate(copy);assert.equal(options(copy,drive).length,0);});
for(const [name,mutate] of [
 ["foreign source",s=>{s.antenna_field_solve_stages[1].source_object_id="foreign";}],
 ["wrong output quantity",s=>{s.antenna_field_solve_stages[1].outputs[0].quantity="H_ant";}],
 ["ambiguous stage",s=>{s.antenna_field_solve_stages.push({...s.antenna_field_solve_stages[1]});}],
 ["ambiguous port",s=>{s.antenna_port_modes.push({...s.antenna_port_modes[1]});}],
 ["ambiguous output",s=>{s.antenna_field_solve_stages[1].outputs.push({...s.antenna_field_solve_stages[1].outputs[0]});}],
 ["missing transport",s=>{s.antenna_field_solve_stages[1].current_transport_id="missing";}],
 ["mismatched port transport",s=>{s.antenna_port_modes[1].current_transport_id="other";}],
 ["multiple stage ports",s=>{s.antenna_field_solve_stages[1].port_mode_ids.push("port1");}],
])check(name+" cannot be chosen",()=>{const copy=structuredClone(scene);mutate(copy);assert.equal(options(copy,drive).some(o=>o.projectionRef==="p2"),false);});
check("selection and validation do not mutate the source",()=>{const before=JSON.stringify(scene);options(scene,drive);validate(scene,drive,{...drive,projection_ref:"p2",port_mode_id:"port2"});assert.equal(JSON.stringify(scene),before);});
console.log(JSON.stringify({state:"passed",checks,scope:"interpreted production binding choices; not field qualification or solve"}));
