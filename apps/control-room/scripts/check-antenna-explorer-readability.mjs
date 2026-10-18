import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import vm from "node:vm";

const root = new URL("../src/", import.meta.url), cache = new Map();
function moduleAt(url) {
  if (cache.has(url.href)) return cache.get(url.href);
  const sourceModule = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(url, "utf8")), { identifier: url.href });
  cache.set(url.href, sourceModule); return sourceModule;
}
const url = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL("modules/explorer/builders/objectExplorerNodes.ts", root);
const entry = moduleAt(url);
await entry.link((name, referrer) => moduleAt(name.startsWith("@/") ? new URL(`${name.slice(2)}.ts`, root)
  : process.argv[2] && referrer === entry ? new URL(`modules/explorer/builders/${name}.ts`, root) : new URL(`${name}.ts`, referrer.identifier)));
await entry.evaluate(); const build = entry.namespace.buildObjectExplorerNode;
const scene = {
  objects: [{ id:"source",name:"Metal",role:"antenna" }, { id:"receiver",name:"Waveguide",regions:[{region_id:"roi",name:"Interaction",owner_object:"receiver"}] }],
  current_transports:[{name:"charge",kind:"current_transport",model:"ohmic_poisson",domain:[{object_id:"source"}],boundaries:[]}],
  antenna_port_modes:[{id:"port:long/1",schema_version:"antenna_port_mode.v2",source_object_id:"source",current_transport_id:"charge",normalization_current_a:1,branches:[]}],
  antenna_field_solve_stages:[{id:"solve:long/1",source_object_id:"source",current_transport_id:"charge",port_mode_ids:["port:long/1"],outputs:[{id:"basis",quantity:"H_ant_basis"}],field_sampling_domain:{kind:"global"},target_refs:[{kind:"object",object_id:"receiver"}],model:"quasistatic_conduction_biot_savart3d"}],
  antenna_target_projections:[{id:"projection:long/1",solution:{kind:"stage_output",stage_id:"solve:long/1",output_id:"basis"},target:{kind:"object",object_id:"receiver"},output_id:"projected"}],
  solved_antenna_drives:[{id:"drive:long/1",name:"Authored RF",projection_ref:"projection:long/1",port_mode_id:"port:long/1",peak_current_a:0.01,waveform:{kind:"sinusoidal",frequency_hz:1e9},time_origin:"stage_local",activation:{kind:"all_time_evolution"}}],
  antenna_spectrum_requests:[{id:"spectrum:long/1",solution_ref:{kind:"stage_output",stage_id:"solve:long/1",output_id:"basis"},component:"z",window:"hann",transform:"spatial_fft"}],
};
const flat = nodes => nodes.flatMap(node => [node,...flat(node.children ?? [])]);
const tree = input => flat([build({id:"source",label:"Metal",objectRole:"antenna"},{scene:input})]);
const node = (input, kind) => tree(input).find(item=>item.kind===`object.antenna.${kind}`);
let checks=0;
const check=(name,run)=>{run();checks++;console.log(`PASS ${name}`);};
check("port label is readable while full identity remains available",()=>{const n=node(scene,"port");assert.equal(n.label,"Port 1");assert.equal(n.antennaResourceId,"port:long/1");assert.ok(n.statusReason.includes("port:long/1"));});
check("field definition keeps immutable command input",()=>{const n=node(scene,"solution");assert.equal(n.label,"Field solve 1");assert.equal(n.contextCommandInputs["study.add-antenna-field-solve-stage"].stageId,"solve:long/1");assert.equal(n.status,"validation-blocked");assert.match(n.statusReason,/mesh-exact ConservativeCurrentView/);});
check("projection displays the target name, not a storage ID",()=>{const n=node(scene,"projection");assert.equal(n.label,"Projection 1 → Waveguide");assert.equal(n.badge,"authored binding");assert.ok(n.statusReason.includes("projection:long/1")&&n.statusReason.includes("receiver"));});
check("spectrum remains explicitly a source spectrum",()=>{const n=node(scene,"spectrum");assert.equal(n.label,"Source spectrum 1");assert.equal(n.badge,"z · hann");assert.match(n.statusReason,/not a measured magnetization response/);});
check("authored drive name is preserved",()=>assert.equal(node(scene,"drive").label,"Authored RF"));
check("rename changes only display identity",()=>{const updated=structuredClone(scene);updated.solved_antenna_drives[0].name="New RF";assert.equal(node(updated,"drive").label,"New RF");assert.equal(node(updated,"drive").id,node(scene,"drive").id);assert.equal(node(updated,"drive").antennaResourceId,"drive:long/1");});
check("duplicate target names remain disambiguated by immutable object IDs",()=>{const updated=structuredClone(scene);updated.objects.push({id:"other",name:"Waveguide"});assert.equal(node(updated,"projection").label,"Projection 1 → Waveguide [receiver]");});
check("missing target never borrows another object's name",()=>{const updated=structuredClone(scene);updated.objects=updated.objects.filter(o=>o.id!=="receiver");assert.match(node(updated,"projection").label,/Missing object · receiver/);});
check("ambiguous target ID fails closed for label resolution",()=>{const updated=structuredClone(scene);updated.objects.push({...updated.objects[1],name:"Wrong"});assert.match(node(updated,"projection").label,/Ambiguous object · receiver/);assert.ok(!node(updated,"projection").label.includes("Wrong"));});
check("region label includes its owner",()=>{const updated=structuredClone(scene);updated.antenna_target_projections[0].target={kind:"region",object_id:"receiver",region_id:"roi"};assert.equal(node(updated,"projection").label,"Projection 1 → Waveguide / Interaction");});
check("duplicate region names include the stable region ID",()=>{const updated=structuredClone(scene);updated.objects[1].regions.push({region_id:"other",name:"Interaction",owner_object:"receiver"});updated.antenna_target_projections[0].target={kind:"region",object_id:"receiver",region_id:"roi"};assert.match(node(updated,"projection").label,/Interaction \[roi\]/);});
check("mismatched region owner is shown as missing",()=>{const updated=structuredClone(scene);updated.objects[1].regions[0].owner_object="other";updated.antenna_target_projections[0].target={kind:"region",object_id:"receiver",region_id:"roi"};assert.match(node(updated,"projection").label,/Missing region · roi/);});
check("Global projection remains explicitly global",()=>{const updated=structuredClone(scene);updated.antenna_target_projections[0].target={kind:"global"};assert.equal(node(updated,"projection").label,"Projection 1 → Global");});
check("labels never mutate the source scene",()=>{const before=JSON.stringify(scene);tree(scene);assert.equal(JSON.stringify(scene),before);});
console.log(JSON.stringify({state:"passed",checks,scope:"interpreted production Explorer builder; no unit tests or solver qualification"}));
