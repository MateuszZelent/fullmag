use super::*;
use fullmag_ir::{AntennaRetainedCurrentSourceIR, FemConnectivityIR};
use serde_json::{json, Value};

fn problem() -> ProblemIR {
    // This is a shape/planning fixture, not an authenticated or qualified parent.
    let mut wire: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/runtime/antenna-standalone-pipeline.json"
    )).unwrap();
    let ir = &mut wire["ir"];
    ir["study"]["selection"] = json!({"stage_id":"inspect_antenna", "port_mode_id":"port"});
    let assets = ir["geometry_assets"]["fem_mesh_assets"].as_array_mut().unwrap();
    assets.retain(|asset| asset["geometry_name"] == "probe");
    let stage = &mut ir["antenna_field_solve_stages"][0];
    stage["retained_current_source"] = json!({"kind":"published_inspection", "project_id":"project-source",
        "run_id":"run-source", "task_id":"task-source", "attempt_id":"attempt-source",
        "ownership_epoch":"18446744073709551615", "artifact_id":"artifact-source", "object_ref":"a".repeat(64)});
    stage["oersted_realization"] = "analytic_rt0_surface".into();
    stage["surface_field_policy"] = json!({
        "policy_version":fullmag_ir::ANTENNA_SURFACE_FIELD_POLICY_VERSION,
        "limits":{"total":vec![1_000_000_u64;14], "per_target":vec![100_000_u64;14],
            "maximum_raw_integer_bits":8192, "maximum_reduced_fraction_bits":8192,
            "maximum_lifetime_peak_rss_bytes":268435456, "guard_interval_events":128,
            "maximum_total_seconds":600.0, "maximum_target_seconds":120.0},
        "tolerances":{"absolute_field_apm":1e-9,"relative_field":1e-5,"cancellation_floor_apm":1e-6,
            "scalar_relative_80":1e-45,"scalar_relative_120":1e-55,"angle_relative_80":1e-45,"angle_relative_120":1e-55,
            "binary_scalar_epsilon_factor":16.0,"binary_roundoff_epsilon_factor":64.0,
            "binary_cancellation_limit":1e8,"highprecision_cancellation_limit":1e40}
    });
    serde_json::from_value(ir.take()).unwrap()
}

fn plan(problem: &ProblemIR) -> Result<AntennaRetainedCurrentFieldPlanIR, PlanError> {
    plan_retained_current_field_inspection(problem, "inspect_antenna", "port")
}

#[test]
fn plans_new_target_without_a_source_mesh_or_authorization_claim() {
    let problem = problem();
    assert!(problem.magnets.is_empty());
    assert_eq!(problem.geometry_assets.as_ref().unwrap().fem_mesh_assets.len(), 1);
    let planned = plan(&problem).unwrap();
    assert_eq!(planned.schema_version, ANTENNA_RETAINED_CURRENT_FIELD_PLAN_SCHEMA);
    assert_eq!(planned.stage, problem.antenna_field_solve_stages[0]);
    assert_eq!(planned.field_sampling.positions_xyz_m.len(), 4);
    assert_eq!(planned.field_sampling.cells.require_tet4().unwrap(), vec![[0,1,2,3]]);
    assert_eq!(planned.requested_execution.device, ExecutionDevice::Cpu);
    let wire = serde_json::to_value(&planned).unwrap();
    assert_eq!(wire.as_object().unwrap().len(), 4);
    assert!(wire.get("source_mesh").is_none());
    assert_eq!(serde_json::from_value::<AntennaRetainedCurrentFieldPlanIR>(wire.clone()).unwrap(), planned);
    let mut invalid = wire.clone(); invalid["accepted_source_digest"] = "a".repeat(64).into();
    assert!(serde_json::from_value::<AntennaRetainedCurrentFieldPlanIR>(invalid).is_err());
    for version in ["", "antenna_field_only_plan.v1", "antenna_retained_current_field_plan.v2"] {
        let mut invalid = wire.clone(); invalid["schema_version"] = version.into();
        assert!(serde_json::from_value::<AntennaRetainedCurrentFieldPlanIR>(invalid).is_err());
    }
    // The original transport planner must continue to refuse this operation.
    assert!(crate::plan_antenna_field_solve_execution(&problem, "inspect_antenna", "port")
        .unwrap_err().to_string().contains("fresh charge transport is forbidden"));
}

#[test]
fn changing_only_the_target_keeps_the_exact_parent_locator() {
    let first = problem();
    let a = plan(&first).unwrap();
    let mut second = first;
    second.geometry_assets.as_mut().unwrap().fem_mesh_assets[0].mesh.as_mut().unwrap().nodes[0][0] += 0.125;
    let b = plan(&second).unwrap();
    assert_eq!(a.stage.retained_current_source, b.stage.retained_current_source);
    assert_ne!(a.field_sampling.topology_digest, b.field_sampling.topology_digest);
    assert_ne!(a.field_sampling.positions_xyz_m, b.field_sampling.positions_xyz_m);
}

#[test]
fn stage_port_and_study_selection_cannot_be_substituted() {
    let problem = problem();
    assert!(plan_retained_current_field_inspection(&problem, "missing", "port").is_err());
    assert!(plan_retained_current_field_inspection(&problem, "inspect_antenna", "missing").is_err());
    let mut invalid = problem;
    let StudyIR::AntennaFieldSolve { selection: Some(selection), .. } = &mut invalid.study else { panic!() };
    selection.port_mode_id = "other".into();
    assert!(plan(&invalid).is_err());
}

#[test]
fn refuses_fresh_source_legacy_view_missing_policy_and_extra_output() {
    for case in ["source", "legacy", "policy", "output", "epoch"] {
        let mut invalid = problem();
        let stage = &mut invalid.antenna_field_solve_stages[0];
        match case {
            "source" => stage.retained_current_source = None,
            "legacy" => stage.conservative_current_view_ref = Some("legacy".into()),
            "policy" => stage.surface_field_policy = None,
            "output" => stage.outputs.push(fullmag_ir::AntennaNamedOutputIR {id:"extra".into(),quantity:"J_charge".into()}),
            "epoch" => {let AntennaRetainedCurrentSourceIR::PublishedInspection {ownership_epoch, ..} = stage.retained_current_source.as_mut().unwrap(); *ownership_epoch = "01".into();}
            _ => unreachable!(),
        }
        assert!(plan(&invalid).is_err(), "{case}");
    }
}

#[test]
fn refuses_implicit_device_gpu_fdm_single_and_non_strict_execution() {
    for device in [None, Some("auto"), Some("gpu"), Some("cuda"), Some("cuda:0")] {
        let mut invalid = problem();
        let metadata = &mut invalid.problem_meta.runtime_metadata;
        if let Some(device) = device {metadata.insert("runtime_device_override".into(), json!({"device":device}));}
        else {metadata.remove("runtime_selection");}
        assert!(plan(&invalid).is_err(), "device={device:?}");
    }
    let mut invalid = problem(); invalid.backend_policy.requested_backend = BackendTarget::Fdm;
    assert!(plan(&invalid).is_err());
    let mut invalid = problem(); invalid.backend_policy.execution_precision = ExecutionPrecision::Single;
    assert!(plan(&invalid).is_err());
    let mut invalid = problem(); invalid.validation_profile.execution_mode = ExecutionMode::Extended;
    assert!(plan(&invalid).is_err());
}

#[test]
fn sampling_requires_its_own_finite_nonempty_tet4_asset() {
    for case in ["asset", "empty", "finite", "mixed"] {
        let mut invalid = problem();
        let assets = invalid.geometry_assets.as_mut().unwrap();
        if case == "asset" { assets.fem_mesh_assets.clear(); }
        else {
            let mesh = assets.fem_mesh_assets[0].mesh.as_mut().unwrap();
            match case {
                "empty" => mesh.cells = FemConnectivityIR::empty(),
                "finite" => mesh.nodes[0][0] = f64::NAN,
                "mixed" => mesh.cells.types[0] = fullmag_ir::FemCellTypeIR::Hex8,
                _ => unreachable!(),
            }
        }
        assert!(plan(&invalid).is_err(), "{case}");
    }
}

#[test]
fn global_and_field_only_routes_keep_the_same_retained_identity() {
    let mut problem = problem();
    let source = problem.antenna_field_solve_stages[0].retained_current_source.clone();
    let assets = problem.geometry_assets.as_mut().unwrap();
    assets.fem_domain_mesh_asset = Some(fullmag_ir::FemDomainMeshAssetIR {
        mesh_source: None, mesh: assets.fem_mesh_assets[0].mesh.clone(),
        region_markers: vec![], object_region_markers: vec![], build_report: None,
    });
    let stage = &mut problem.antenna_field_solve_stages[0];
    stage.field_sampling_domain = fullmag_ir::FieldTargetIR::Global {};
    stage.target_refs = vec![stage.field_sampling_domain.clone()];
    let StudyIR::AntennaFieldSolve {sampling, ..} = &problem.study else {panic!()};
    problem.study = StudyIR::FieldOnly {sampling:sampling.clone()};
    let planned = plan(&problem).unwrap();
    assert_eq!(planned.stage.retained_current_source, source);
    assert_eq!(planned.field_sampling.carrier_kind, "fem_domain_mesh_asset");
}

#[test]
fn region_sampling_still_requires_an_explicit_qualified_carrier() {
    let error = resolve_field_sampling(&problem(), &fullmag_ir::FieldTargetIR::Region {
        object_id:"probe".into(), region_id:"region".into(),
    }).unwrap_err();
    assert!(error.to_string().contains("explicit point-cloud carrier"));
}


#[test]
fn canonical_standalone_and_field_only_planning_preserve_the_typed_operation() {
    let mut problem = problem();
    let operation = plan(&problem).unwrap();
    let standalone = crate::plan(&problem).unwrap();
    let fullmag_ir::BackendPlanIR::AntennaRetainedCurrentFieldInspection(actual) = &standalone.backend_plan
        else {panic!("standalone retained stage must not select a fresh transport carrier")};
    assert_eq!(actual, &operation);
    let wire = serde_json::to_value(&standalone).unwrap();
    assert_eq!(wire["backend_plan"]["kind"], "antenna_retained_current_field_inspection");
    assert!(wire["backend_plan"].get("source_mesh").is_none());
    assert_eq!(serde_json::from_value::<fullmag_ir::ExecutionPlanIR>(wire).unwrap(), standalone);
    let StudyIR::AntennaFieldSolve {sampling, ..} = &problem.study else {panic!()};
    problem.study = StudyIR::FieldOnly {sampling:sampling.clone()};
    problem.problem_meta.runtime_metadata.insert("active_stage_id".into(), "inspect_antenna".into());
    assert_eq!(crate::plan(&problem).unwrap(), standalone);
}

#[test]
fn retained_locator_and_target_changes_are_included_in_the_canonical_plan() {
    let first = problem();
    let a = serde_json::to_value(crate::plan(&first).unwrap()).unwrap();
    let mut changed = first.clone();
    let AntennaRetainedCurrentSourceIR::PublishedInspection {object_ref, ..} =
        changed.antenna_field_solve_stages[0].retained_current_source.as_mut().unwrap();
    *object_ref = "b".repeat(64);
    assert_ne!(a, serde_json::to_value(crate::plan(&changed).unwrap()).unwrap());
    let mut changed = first;
    changed.geometry_assets.as_mut().unwrap().fem_mesh_assets[0].mesh.as_mut().unwrap().nodes[0][0] += 0.125;
    assert_ne!(a, serde_json::to_value(crate::plan(&changed).unwrap()).unwrap());
}
