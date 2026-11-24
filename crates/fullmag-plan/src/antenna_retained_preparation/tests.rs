use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn problem() -> ProblemIR {
    // Structural planning fixture only; it does not authenticate the historical solve.
    let mut wire: Value = serde_json::from_str(include_str!("../../../../tests/fixtures/runtime/antenna-standalone-pipeline.json")).unwrap();
    let ir = &mut wire["ir"];
    ir["study"]["selection"] = json!({"stage_id":"inspect_antenna","port_mode_id":"port"});
    let mut mesh: fullmag_ir::MeshIR = serde_json::from_value(ir["geometry_assets"]["fem_mesh_assets"][0]["mesh"].clone()).unwrap();
    for (index, marker) in mesh.element_markers.iter_mut().enumerate() { *marker = (index % 4 + 1) as u32; }
    ir["geometry_assets"]["fem_mesh_assets"][0]["mesh"] = serde_json::to_value(&mesh).unwrap();
    ir["geometry_assets"]["fem_mesh_assets"][0].as_object_mut().unwrap().remove("mesh_source");
    let pin = |c: char| format!("sha256:{}",c.to_string().repeat(64));
    let task = format!("task-{:x}",Sha256::digest(b"run-source\0source-step"));
    let reference = json!({"asset_id":format!("script-file-{}","a".repeat(64)),"content_sha256":"b".repeat(64)});
    let observations = ["signal", "return"].iter().flat_map(|part| ["in", "out"].map(move |end|
        json!({"id":format!("{part}-{end}"),"part_id":part,"selector":if end=="in" {"local_u_min"} else {"local_u_max"},
            "faces":[{"face_vertex_ids":[1,2,3],"part_cell_ordinal":0,"bridge_cell_ordinal":1}],"normal_convention":"outward_from_part"}))).collect::<Vec<_>>();
    let parts = ["signal", "return", "inlet", "outlet"].iter().enumerate().map(|(index, id)|
        json!({"part_id":id,"element_ordinals":(index..mesh.cell_count()).step_by(4).map(|n|n as u64).collect::<Vec<_>>(),"material_assignment_index":0})).collect::<Vec<_>>();
    ir["current_modules"][0]["gauge"] = "zero_mean".into();
    ir["current_modules"][0]["conservative_current_source"] = json!({"kind":"retained_preparation_asset",
        "schema_version":"retained_preparation_asset_source.v1","object_id":"antenna","geometry_id":"antenna","preparation_asset":reference,
        "historical_prepared_source":{"schema_version":"conservative_current_source.v2","revision":pin('1'),"object_id":"antenna","geometry_id":"antenna",
            "mesh_digest":mesh.mixed_topology_fingerprint_v3().unwrap(),"authored_input_digest":pin('1'),"materials_digest":pin('2'),
            "stable_vertex_ids":(1..=mesh.nodes.len() as u64).collect::<Vec<_>>(),"material_parts":parts,"terminal_observations":observations,
            "closure":{"kind":"closed_geometry","operator_version":"fem_closed_current_geometry.v2","revision":pin('1'),"digest":pin('1'),
                "source_cuts":[{"id":"cut","translation_m":[0.,0.,0.],"potential_drop_v":1.,"face_pairs":[{"minus_face_vertex_ids":[1,2,3],"plus_face_vertex_ids":[4,5,6]}]}]}},
        "historical_preparation":{"receipt_schema_version":"task_preparation_receipt.v1","run_id":"run-source","step_id":"source-step","task_id":task,
            "preparation_id":format!("prep-{task}"),"input_fingerprint":"c".repeat(64),"plan_fingerprint":pin('3'),"payload_sha256":"d".repeat(64),"receipt_sha256":"e".repeat(64)},
        "authored_closure":{"kind":"closed_geometry","schema_version":"structured_current_closure.v2","closure_id":"loop","source_cuts":[{
            "source_cut_id":"cut","circuit_id":"loop","region":{"object_id":"antenna","region_id":"inlet"},
            "plane":{"coordinate_frame":"object","axis":"x","offset_m":0.,"normal":"positive_axis"},
            "drive":{"kind":"impressed_potential_jump","schema_version":"impressed_potential_jump.v1","drive_id":"drive","potential_jump_V":1.}}]}});
    ir["antenna_port_modes"][0]["schema_version"] = "antenna_port_mode.v3".into();
    ir["antenna_port_modes"][0]["normalization"] = json!({"kind":"source_cut_rt0","source_cut_ref":"cut","orientation":"minus_outward"});
    let stage = &mut ir["antenna_field_solve_stages"][0];
    stage["retained_current_source"] = json!({"kind":"published_inspection","project_id":"project-source","run_id":"run-source",
        "task_id":task,"attempt_id":"attempt-source","ownership_epoch":"1","artifact_id":"artifact-source","object_ref":"f".repeat(64)});
    stage["retained_source_preparation"] = reference;
    stage["oersted_realization"] = "analytic_rt0_surface".into();
    stage["surface_field_policy"] = json!({"policy_version":fullmag_ir::ANTENNA_SURFACE_FIELD_POLICY_VERSION,
        "limits":{"total":vec![1_000_000_u64;14],"per_target":vec![100_000_u64;14],"maximum_raw_integer_bits":8192,
            "maximum_reduced_fraction_bits":8192,"maximum_lifetime_peak_rss_bytes":268435456,"guard_interval_events":128,"maximum_total_seconds":600.,"maximum_target_seconds":120.},
        "tolerances":{"absolute_field_apm":1e-9,"relative_field":1e-5,"cancellation_floor_apm":1e-6,"scalar_relative_80":1e-45,"scalar_relative_120":1e-55,
            "angle_relative_80":1e-45,"angle_relative_120":1e-55,"binary_scalar_epsilon_factor":16.,"binary_roundoff_epsilon_factor":64.,"binary_cancellation_limit":1e8,"highprecision_cancellation_limit":1e40}});
    serde_json::from_value(ir.take()).unwrap()
}
#[test]
fn source_asset_selects_own_plan_and_refuses_old_operation_and_fresh_transport() {
    let problem = problem();
    let plan = crate::validate_retained_preparation_field_operation(&problem,"inspect_antenna","port","inspection").unwrap();
    assert_eq!(plan.schema_version,fullmag_ir::ANTENNA_RETAINED_PREPARATION_FIELD_PLAN_SCHEMA);
    assert_eq!(plan.stage.retained_source_preparation.as_ref(),Some(&plan.preparation_asset));
    assert!(crate::validate_retained_current_field_operation(&problem,"inspect_antenna","port","inspection").is_err());
    assert!(crate::plan_antenna_field_solve_execution(&problem,"inspect_antenna","port").is_err());
    let wire = serde_json::to_value(&plan).unwrap();
    assert!(serde_json::from_value::<fullmag_ir::AntennaRetainedCurrentFieldPlanIR>(wire.clone()).is_err());
    assert_eq!(serde_json::from_value::<AntennaRetainedPreparationFieldPlanIR>(wire).unwrap(),plan);
}
#[test]
fn target_change_preserves_explicit_historical_source_and_asset() {
    let first = problem(); let a = plan_retained_preparation_field_inspection(&first,"inspect_antenna","port").unwrap();
    let mut second = first.clone();
    second.geometry_assets.as_mut().unwrap().fem_mesh_assets[1].mesh.as_mut().unwrap().nodes[0][0] += 0.125;
    let b = plan_retained_preparation_field_inspection(&second,"inspect_antenna","port").unwrap();
    assert_eq!(a.preparation_asset,b.preparation_asset); assert_eq!(first.current_modules,second.current_modules);
    assert_ne!(a.field_sampling.topology_digest,b.field_sampling.topology_digest);
}
#[test]
fn mismatched_asset_and_missing_frozen_carrier_are_refused() {
    for case in ["stage", "source", "mesh", "mesh_hash", "locator"] {
        let mut problem = problem();
        match case {
            "stage" => problem.antenna_field_solve_stages[0].retained_source_preparation = None,
            "source" => problem.antenna_field_solve_stages[0].retained_source_preparation.as_mut().unwrap().content_sha256 = "0".repeat(64),
            "mesh" => problem.geometry_assets.as_mut().unwrap().fem_mesh_assets[0].mesh = None,
            "mesh_hash" => problem.geometry_assets.as_mut().unwrap().fem_mesh_assets[0].mesh.as_mut().unwrap().nodes[0][0] += 0.125,
            "locator" => problem.antenna_field_solve_stages[0].retained_current_source = None,
            _ => unreachable!(),
        }
        assert!(plan_retained_preparation_field_inspection(&problem,"inspect_antenna","port").is_err(),"{case}");
    }
}

fn bound_source_fixture() -> (ProblemIR, Value, Vec<f64>) {
    let mut problem = problem();
    let sigma = vec![4.0; problem.geometry_assets.as_ref().unwrap().fem_mesh_assets[0].mesh.as_ref().unwrap().cell_count()];
    let fullmag_ir::CurrentModuleIR::CurrentTransport {definition:Some(definition),..} = &mut problem.current_modules[0] else {panic!()};
    let fullmag_ir::ConservativeCurrentSourceIR::RetainedPreparationAsset(source) = definition.conservative_current_source.as_mut().unwrap() else {panic!()};
    let mut mapping = serde_json::to_value(&source.historical_prepared_source.material_parts).unwrap();
    for part in mapping.as_array_mut().unwrap() {
        for value in part["element_ordinals"].as_array_mut().unwrap() { *value = Value::String(value.to_string()); }
    }
    source.historical_prepared_source.materials_digest = fullmag_ir::transport_identity::tagged_json_digest(&json!({
        "schema":"antenna_coincident_material_binding.v2","assignments":definition.materials,"material_parts":mapping,
        "resolved_conductivity_spm_per_element":sigma})).unwrap();
    let historical = source.historical_prepared_source.clone();
    let authored = serde_json::to_value(&source.authored_closure).unwrap();
    // Use the unchanged old authored-input builder as the independent historical identity oracle.
    // This test fixture supplies no durable parent authority and does not execute transport.
    let mut original = problem.clone();
    let fullmag_ir::CurrentModuleIR::CurrentTransport {definition:Some(definition),..} = &mut original.current_modules[0] else {panic!()};
    definition.conservative_current_source = Some(fullmag_ir::ConservativeCurrentSourceIR::ClosedGeometryPotentialJump(historical));
    original.problem_meta.runtime_metadata.insert("antenna_coincident_preparations".into(),json!([{
        "current_transport_id":"antenna_charge","object_id":"antenna","geometry_id":"antenna",
        "preparation":{"authored_intent":authored,"prepared_mesh_workflow":{"per_geometry":[{"geometry":"antenna","mode":"custom","hmax":1.0}]},"prepared_per_object_recipes":{}}}]));
    let fullmag_ir::CurrentModuleIR::CurrentTransport {definition:Some(definition),..} = &original.current_modules[0] else {panic!()};
    let preimage = crate::antenna_closed_loop_authored_input_preimage(&original,definition,&original.antenna_field_solve_stages[0],&original.antenna_port_modes[0]).unwrap();
    let digest = fullmag_ir::transport_identity::tagged_json_digest(&preimage).unwrap();
    let fullmag_ir::CurrentModuleIR::CurrentTransport {definition:Some(definition),..} = &mut problem.current_modules[0] else {panic!()};
    let fullmag_ir::ConservativeCurrentSourceIR::RetainedPreparationAsset(source) = definition.conservative_current_source.as_mut().unwrap() else {panic!()};
    let historical = &mut source.historical_prepared_source;
    historical.revision = digest.clone(); historical.authored_input_digest = digest.clone();
    let fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry {revision,digest:closure_digest,..} = &mut historical.closure else {panic!()};
    *revision = digest.clone(); *closure_digest = digest;
    (problem,preimage,sigma)
}
#[test]
fn strict_source_identity_accepts_original_and_new_target_but_rejects_changed_physics() {
    let (problem,original,sigma) = bound_source_fixture();
    let check = |problem:&ProblemIR| crate::validate_retained_preparation_authored_source(problem,&problem.antenna_field_solve_stages[0],&original,&sigma);
    check(&problem).unwrap();
    let mut target = problem.clone();
    target.geometry_assets.as_mut().unwrap().fem_mesh_assets[1].mesh.as_mut().unwrap().nodes[0][0] += 0.125;
    target.problem_meta.runtime_metadata.insert("mesh_workflow".into(),json!({"domain_mesh_mode":"new_universe",
        "per_geometry":[{"geometry":"antenna","mode":"inherit"}]}));
    check(&target).unwrap();
    for case in ["geometry","material","voltage","port","solver","execution","mesh","custom_policy","spoofed_inherit"] {
        let mut changed = problem.clone();
        match case {
            "geometry" => {
                let mut wire = serde_json::to_value(&changed.geometry).unwrap(); wire["entries"][0]["scale"] = 2.0.into();
                changed.geometry = serde_json::from_value(wire).unwrap();
            },
            "port" => changed.antenna_port_modes[0].branches[0].signed_weight = 0.5,
            "execution" => { changed.problem_meta.runtime_metadata.insert("runtime_selection".into(),json!({"device":"cpu","changed":true})); },
            "mesh" => changed.geometry_assets.as_mut().unwrap().fem_mesh_assets[0].mesh.as_mut().unwrap().nodes[0][0] += 0.125,
            "custom_policy" => {changed.problem_meta.runtime_metadata.insert("mesh_workflow".into(),json!({"per_geometry":[{"geometry":"antenna","mode":"custom","hmax":0.5}]}));},
            "spoofed_inherit" => {changed.problem_meta.runtime_metadata.insert("mesh_workflow".into(),json!({"per_geometry":[{"geometry":"antenna","mode":"inherit","hmax":0.5}]}));},
            _ => {
                let fullmag_ir::CurrentModuleIR::CurrentTransport {definition:Some(definition),..} = &mut changed.current_modules[0] else {panic!()};
                match case {
                    "material" => definition.materials[0].material.sigma_spm = 5.0,
                    "solver" => definition.solver.linear.max_iterations += 1,
                    "voltage" => {
                        let fullmag_ir::ConservativeCurrentSourceIR::RetainedPreparationAsset(source) = definition.conservative_current_source.as_mut().unwrap() else {panic!()};
                        let fullmag_ir::StructuredCurrentClosureIR::ClosedGeometry {source_cuts,..} = &mut source.authored_closure;
                        source_cuts[0].drive.impressed_potential_jump_mut().potential_jump_v = 2.0;
                    },
                    _ => unreachable!(),
                }
            },
        }
        assert!(check(&changed).is_err(),"{case}");
    }
}

#[test]
fn source_recipe_cannot_be_dropped_or_faked_while_other_historical_recipes_remain_independent() {
    for (owner, expected_ok) in [("antenna", false), ("probe", true)] {
        let (mut problem, mut original, sigma) = bound_source_fixture();
        original["per_object_recipes"][owner] = json!({"hmax":0.5});
        let digest = fullmag_ir::transport_identity::tagged_json_digest(&original).unwrap();
        let fullmag_ir::CurrentModuleIR::CurrentTransport {definition:Some(definition),..} = &mut problem.current_modules[0] else {panic!()};
        let fullmag_ir::ConservativeCurrentSourceIR::RetainedPreparationAsset(source) = definition.conservative_current_source.as_mut().unwrap() else {panic!()};
        let historical = &mut source.historical_prepared_source;
        historical.revision = digest.clone(); historical.authored_input_digest = digest.clone();
        let fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry {revision,digest:closure_digest,..} = &mut historical.closure else {panic!()};
        *revision = digest.clone(); *closure_digest = digest;
        let result = crate::validate_retained_preparation_authored_source(&problem,&problem.antenna_field_solve_stages[0],&original,&sigma);
        assert_eq!(result.is_ok(), expected_ok, "{owner}: {result:?}");
    }
}
