// Execute actual TypeScript models through Node type stripping; no unit-test compilation.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const model = await import(pathToFileURL(resolve(root, "apps/control-room/src/modules/inspector/panels/antenna/MicrostripGeometryEditorModel.ts")));
const preview = await import(pathToFileURL(resolve(root, "apps/control-room/src/shared/domain/geometry/authoredMicrostripGeometry.ts")));
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const rejects = (run, expression) => { assert.throws(run, expression); checks++; };
const geometry = { geometry_kind: "MicrostripAntennaLayout", geometry_params: {
  length_m: 2e-6, thickness_m: 2e-7, conductivity_s_per_m: 5.8e7,
  stations: [{s:0,signal_width_m:3e-7},{s:0.5,signal_width_m:1e-7},{s:1,signal_width_m:3e-7}],
  return_width_m: 1e-6, return_offset_m: 4e-7,
  conductors:[{id:"signal",kind:"signal"},{id:"return",kind:"return"}],
  terminal_faces:{signal:{inlet:"local_u_min",outlet:"local_u_max"},return:{inlet:"local_u_min",outlet:"local_u_max"}},
  transform:{rotation_matrix:[[0,-1,0],[1,0,0],[0,0,1]],translation_m:[0,-1e-6,0]},
} };
const scene = {revision:7,scene:{id:"session"},objects:[{id:"object",name:"loop",role:"antenna",geometry,material_ref:"",magnetization_ref:null,physics_stack:[],transform:{translation:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}}],
  current_transports:[{kind:"current_transport",name:"charge",model:"ohmic_poisson",coupling:"one_way",domain:[{object_id:"object"}],materials:[{region:{object_id:"object"},material:{sigma_Spm:5.8e7}}],boundaries:[],gauge:"terminal_reference",solver:{engine:"cg"}}],
  antenna_port_modes:[{schema_version:"antenna_port_mode.v2",id:"port",source_object_id:"object",current_transport_id:"charge",normalization_current_a:1,branches:[{id:"signal",inlet_terminal_ref:"signal_in",outlet_terminal_ref:"signal_out",signed_weight:1},{id:"return",inlet_terminal_ref:"return_in",outlet_terminal_ref:"return_out",signed_weight:-1}]}],
  antenna_field_solve_stages:[{id:"solve",source_object_id:"object",current_transport_id:"charge",port_mode_ids:["port"],conservative_current_view_ref:"old-view",model:"quasistatic_conduction_biot_savart3d",oersted_realization:"direct_tetra_quadrature",conductor_mesh_policy:"shared_domain_conforming",solver_policy:"fem_cpu_double_reference",field_sampling_domain:{kind:"global"},target_refs:[{kind:"global"}],outputs:[{id:"field-output",quantity:"H_ant_basis"}]}]};
const pristine = JSON.stringify(scene);
const draft = model.microstripCircuitDraft(geometry,scene,"object");
check(!draft.enabled && Object.values(draft.parameters).every(value=>value==="") && draft.potentialJumpV==="", "Old microstrip remains open; no inferred source or bridge material");
draft.enabled=true; draft.potentialJumpV="0.25";
for (const end of ["inlet","outlet"]) Object.assign(draft.parameters,{[`${end}_connection_length_m`]:"2e-7",[`${end}_connection_width_m`]:"4e-7",[`${end}_connection_offset_v_m`]:"0.",[`${end}_connection_part_id`]:end,[`${end}_connection_conductivity_s_per_m`]:"3e7"});
const patch = model.buildMicrostripCircuitPatch(scene,"object",model.buildMicrostripGeometry(geometry,model.widthStationDraft(geometry)),draft);
const committed=structuredClone({...scene,...patch}); const current=patch.current_transports[0]; const port=patch.antenna_port_modes[0]; const params=patch.objects[0].geometry.geometry_params;
check(JSON.stringify(scene)===pristine,"Actual input resource snapshot immutable");
assert.deepEqual(params.stations,geometry.geometry_params.stations); checks++;
assert.deepEqual(params.transform,geometry.geometry_params.transform); checks++;
check(params.return_width_m===1e-6&&params.loop.enabled,"Broad return and explicit closed-loop geometry retained");
check(current.gauge==="zero_mean" && current.boundaries.length===0 && current.materials.length===4,"Four materials and no terminal actuation");
check(current.materials.map(row=>row.material.sigma_Spm).join() === [5.8e7,5.8e7,3e7,3e7].join(),"Bridge conductivities distinct and explicit");
const cut=current.structured_current_closure.source_cuts[0];
check(cut.plane.coordinate_frame==="object"&&cut.plane.axis==="z"&&Math.abs(cut.plane.offset_m+3e-7)<1e-22,"Source-cut centered strictly in clearance in pre-transform object frame");
check(cut.drive.potential_jump_V===0.25&&cut.region.region_id==="inlet","Actual voltage and inlet material source ownership");
check(port.schema_version==="antenna_port_mode.v3"&&port.normalization.source_cut_ref===cut.source_cut_id&&port.normalization.orientation==="minus_outward","Canonical shared source-cut identity, no current inferred from weights");
assert.deepEqual(port.branches,scene.antenna_port_modes[0].branches); checks++;
check(!("conservative_current_view_ref" in patch.antenna_field_solve_stages[0]),"Stale prepared view removed before regeneration");
const reopened=model.microstripCircuitDraft(patch.objects[0].geometry,committed,"object");
check(model.microstripCircuitEqual(draft,reopened),"ACK/reopen preserves physical draft despite formatting normalization");
const paddedDraft={...draft,parameters:{...draft.parameters,inlet_connection_part_id:" inlet ",outlet_connection_part_id:" outlet "}};
const paddedPatch=model.buildMicrostripCircuitPatch(scene,"object",geometry,paddedDraft);
check(model.microstripCircuitEqual(paddedDraft,model.microstripCircuitDraft(paddedPatch.objects[0].geometry,{...scene,...paddedPatch},"object")),"Canonical part-ID trimming does not leave an acknowledged circuit dirty");
check(!model.microstripCircuitEqual({...paddedDraft,parameters:{...paddedDraft.parameters,inlet_connection_part_id:"new-inlet"}},reopened),"A newer meaningful part-ID edit remains dirty");
const edited={...reopened,potentialJumpV:"-0.3"};
committed.current_transports[0].conservative_current_source={schema_version:"conservative_current_source.v2"};
committed.current_transports[0].closure_receipts={stale:true};
const updated=model.buildMicrostripCircuitPatch(committed,"object",patch.objects[0].geometry,edited);
check(!updated.current_transports[0].conservative_current_source&&!updated.current_transports[0].closure_receipts,"Existing closure edit removes stale preparation receipts");
check(updated.current_transports[0].structured_current_closure.source_cuts[0].source_cut_id===cut.source_cut_id,"Editing voltage retains source identity");
check(model.microstripCircuitSourceKey(geometry,scene,"object")===model.microstripCircuitSourceKey(geometry,{...scene,current_transports:[...scene.current_transports,{name:"unrelated",domain:[{object_id:"other"}]}]},"object"),"Unrelated resource refresh does not create target conflict");
const mesh=preview.buildAuthoredMicrostripGeometry(params,scene.objects[0].transform);
check(mesh.parts.map(part=>part.id).join()==="signal,return,inlet,outlet","Four actual preview volume parts");
check(mesh.positions.length===120&&mesh.indices.length===192,"Two tapered lofts plus two bounded 8-vertex boxes");
check(Math.abs(mesh.boundsMin[1]+1.2e-6)<1e-22&&Math.abs(mesh.boundsMax[1]-1.2e-6)<5e-22,"Rotated bounds include both bridges beyond signal endpoints");
check(preview.buildAuthoredMicrostripGeometry(geometry.geometry_params,scene.objects[0].transform).parts.length===2,"Open geometry preview unchanged");
for (const value of ["", "1e-", "NaN", "Infinity"]) rejects(()=>model.buildMicrostripCircuitPatch(scene,"object",geometry,{...draft,potentialJumpV:value}),/finite/);
for (const value of ["0", "0.", "-0.", "0e-12"]) rejects(()=>model.buildMicrostripCircuitPatch(scene,"object",geometry,{...draft,potentialJumpV:value}),/non-zero/);
rejects(()=>model.buildMicrostripCircuitPatch(scene,"object",geometry,{...draft,parameters:{...draft.parameters,inlet_connection_part_id:"signal"}}),/differ/);
rejects(()=>model.buildMicrostripCircuitPatch(scene,"object",geometry,{...draft,parameters:{...draft.parameters,inlet_connection_offset_v_m:"4e-6"}}),/contact/);
rejects(()=>model.buildMicrostripCircuitPatch(scene,"object",{...geometry,geometry_params:{...geometry.geometry_params,return_offset_m:0}},draft),/positive/);
rejects(()=>preview.buildAuthoredMicrostripGeometry({...params,loop:{...params.loop,outlet_connection_offset_v_m:2e-6}},{}),/contact/);
rejects(()=>model.buildMicrostripCircuitPatch({...scene,current_transports:[scene.current_transports[0],scene.current_transports[0]]},"object",geometry,draft),/exactly one/);
rejects(()=>model.buildMicrostripCircuitPatch({...scene,current_transports:[{...scene.current_transports[0],materials:[{region:{object_id:"object"},material:{sigma_Spm:1}}]}]},"object",geometry,draft),/conductivity/);
rejects(()=>model.buildMicrostripCircuitPatch({...scene,current_transports:[{...scene.current_transports[0],external_lead_preparation:{schema_version:"explicit"}}]},"object",geometry,draft),/Remove/);
rejects(()=>model.buildMicrostripCircuitPatch({...scene,objects:[{...scene.objects[0],locked:true}]},"object",geometry,draft),/Unlock/);
rejects(()=>model.buildMicrostripCircuitPatch({...scene,objects:[{...scene.objects[0],transform:{scale:[2,1,1]}}]},"object",geometry,draft),/unit owner scale/);
const rotatedScene={...scene,objects:[{...scene.objects[0],transform:{rotation_quat:[Math.SQRT1_2,0,0,Math.SQRT1_2],translation:[1e-6,2e-6,3e-6],scale:[1,1,1]}}]};
const rotatedPatch=model.buildMicrostripCircuitPatch(rotatedScene,"object",geometry,draft);
const rotatedMesh=preview.buildAuthoredMicrostripGeometry(rotatedPatch.objects[0].geometry.geometry_params,rotatedScene.objects[0].transform);
check(rotatedMesh.parts.length===4&&Math.abs(rotatedMesh.boundsMin[2]-1.8e-6)<1e-21,"Owner quaternion and inner rigid transform compose for all four preview parts");
if (process.argv.includes("--rotated-scene")) console.log(JSON.stringify({...rotatedScene,...rotatedPatch}));
else if (process.argv.includes("--scene")) console.log(JSON.stringify({...scene,...patch}));
else console.log(`PASS ${checks} actual interpreted microstrip circuit authoring checks; browser/native NOT VERIFIED`);
