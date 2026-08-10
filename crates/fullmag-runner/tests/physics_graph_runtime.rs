use fullmag_ir::{BackendTarget, OutputIR, ProblemIR, RegionRefIR, SpinTorqueModuleIR};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn exact_torque_problem() -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.spin_torque_modules = vec![SpinTorqueModuleIR::ZhangLi {
        schema_version: Some("zhang_li_torque.v1".to_string()),
        id: Some("torque:strip".to_string()),
        target: Some(RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        }),
        formula_version: "zhang_li.mumax3.v1".to_string(),
        operator_version: Some("zl_mumax3_central_v1".to_string()),
        current_density: Some([1.0e12, 0.0, 0.0]),
        current_source: None,
        degree: 1.0,
        beta: 0.05,
        lande_g: Some(2.0),
    }];
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 48,
        "modules": [{
            "id": "torque:strip",
            "kind": "spin_torque",
            "applies_to": [{"kind": "object", "object_id": "strip"}],
            "solve_domain": [{"object_id": "strip"}],
            "depends_on": [],
            "activation": "active",
            "authored_state": "authored",
            "capability": "reference_executable",
            "source_path": "/spin_torque_modules/0",
            "family_payload": {"kind": "zhang_li"}
        }],
        "edges": []
    }));
    problem
}

fn exact_field_drive_direct_minimizer_problem() -> ProblemIR {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.problem_meta.runtime_metadata.insert(
        "study_pipeline".to_string(),
        serde_json::json!({"version":"study_pipeline.v1","nodes":[{"id":"relax","enabled":true}]}),
    );
    problem
        .problem_meta
        .runtime_metadata
        .insert("active_stage_id".to_string(), serde_json::json!("relax"));
    problem.field_drives = vec![fullmag_ir::RegionalFieldDriveIR {
        id: "drive:global".to_string(),
        name: "Global transverse field".to_string(),
        kind: fullmag_ir::FieldDriveKindIR::Regional,
        enabled: true,
        target: fullmag_ir::FieldTargetIR::Global {},
        amplitude_b_t: 1.0e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: fullmag_ir::FieldSpatialProfileIR::Uniform {},
        waveform: fullmag_ir::TimeDependenceIR::Constant,
        time_origin: fullmag_ir::FieldTimeOriginIR::StageLocal,
        activation: fullmag_ir::DriveActivationIR::StageIds {
            stage_ids: vec!["relax".to_string()],
        },
        migration: None,
    }];
    problem.study = fullmag_ir::StudyIR::Relaxation {
        algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        dynamics: None,
        stop: fullmag_ir::RelaxStopIR {
            torque_tolerance_apm: Some(1.0e-3),
            energy_tolerance_j: None,
            max_steps: Some(4),
            max_relaxation_time_s: None,
        },
        sampling: problem.study.sampling().clone(),
    };
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 50,
        "modules": [{
            "id": "drive:global",
            "kind": "regional_field_drive",
            "applies_to": [{"kind": "global"}],
            "solve_domain": [{"kind": "global"}],
            "depends_on": [],
            "activation": "active",
            "authored_state": "authored",
            "capability": "reference_executable",
            "source_path": "/field_drives/0",
            "family_payload": {"kind": "regional"}
        }],
        "edges": []
    }));
    problem
}

fn unique_output_dir(label: &str) -> std::path::PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must be monotonic")
        .as_nanos();
    std::env::temp_dir().join(format!("fullmag-{label}-{}-{suffix}", std::process::id()))
}

#[test]
fn cancel_on_initial_snapshot_does_not_claim_torque_execution() {
    let problem = exact_torque_problem();
    let plan = fullmag_plan::plan(&problem).expect("exact torque plan");
    let output_dir = unique_output_dir("physics-graph-cancel-before-evaluation");
    let display = || fullmag_runner::DisplaySelectionState::default();

    let result =
        fullmag_runner::run_planned_problem_with_live_preview_interruptible_with_initial_snapshot(
            &problem,
            &plan,
            1.0e-13,
            &output_dir,
            1,
            &display,
            None,
            true,
            |_| fullmag_runner::StepAction::Stop,
        )
        .expect("initial callback cancellation");
    assert_eq!(result.status, fullmag_runner::RunStatus::Cancelled);

    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(output_dir.join("metadata.json")).expect("run metadata"))
            .expect("metadata JSON");
    assert!(metadata["execution_provenance"]["executed_physics_module_ids"].is_null());
    fs::remove_dir_all(output_dir).expect("remove cancellation fixture");
}

#[test]
fn accepted_fdm_step_streams_exact_torque_id_in_field_metadata() {
    let problem = exact_torque_problem();
    let mut plan = fullmag_plan::plan(&problem).expect("exact torque plan");
    plan.output_plan.outputs = vec![OutputIR::Field {
        name: "m".to_string(),
        every_seconds: 1.0e-13,
    }];
    let output_dir = unique_output_dir("physics-graph-streaming-owner");
    let result = fullmag_runner::run_planned_problem(&problem, &plan, 1.0e-13, &output_dir)
        .expect("accepted FDM step");
    assert_eq!(result.status, fullmag_runner::RunStatus::Completed);

    let field: serde_json::Value = serde_json::from_slice(
        &fs::read(output_dir.join("fields/m/step_000001.json")).expect("streamed field"),
    )
    .expect("field JSON");
    assert_eq!(
        field["provenance"]["executed_physics_module_ids"],
        serde_json::json!(["torque:strip"])
    );
    fs::remove_dir_all(output_dir).expect("remove streaming fixture");
}

#[test]
fn accepted_fdm_direct_minimizer_evaluation_records_only_energy_module_id() {
    let problem = exact_field_drive_direct_minimizer_problem();
    let output_dir = unique_output_dir("physics-graph-direct-minimizer-owner");

    let result = fullmag_runner::run_problem(&problem, 1.0e-13, &output_dir)
        .expect("accepted FDM direct-minimizer evaluation");
    assert_eq!(result.status, fullmag_runner::RunStatus::Completed);

    let metadata: serde_json::Value =
        serde_json::from_slice(&fs::read(output_dir.join("metadata.json")).expect("run metadata"))
            .expect("metadata JSON");
    assert_eq!(
        metadata["execution_provenance"]["executed_physics_module_ids"],
        serde_json::json!(["drive:global"])
    );
    fs::remove_dir_all(output_dir).expect("remove direct-minimizer fixture");
}

#[test]
fn fdm_runtime_artifact_contains_concrete_graph_realization() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 46,
        "modules": [{
            "id": "current:strip",
            "kind": "current_transport",
            "applies_to": [{"kind": "object", "object_id": "strip"}],
            "solve_domain": [{"object_id": "strip"}],
            "depends_on": [],
            "activation": "active",
            "authored_state": "authored",
            "capability": "reference_executable",
            "source_path": "/current_modules/0",
            "family_payload": {}
        }],
        "edges": []
    }));

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must be monotonic")
        .as_nanos();
    let output_dir = std::env::temp_dir().join(format!(
        "fullmag-physics-graph-runtime-{}-{suffix}",
        std::process::id()
    ));
    let result = fullmag_runner::run_problem(&problem, 1.0e-13, &output_dir)
        .expect("FDM runtime should publish the graph artifact");
    assert_eq!(result.status, fullmag_runner::RunStatus::Completed);

    let artifact: serde_json::Value = serde_json::from_slice(
        &fs::read(output_dir.join("physics/physics_graph_provenance.v1.json"))
            .expect("graph provenance artifact must exist"),
    )
    .expect("graph provenance artifact must be valid JSON");
    assert_eq!(
        artifact["realization"]["schema_version"],
        fullmag_ir::PHYSICS_GRAPH_REALIZATION_SCHEMA
    );
    assert_eq!(
        artifact["realization"]["resolved_module_ids"],
        serde_json::json!(["current:strip"])
    );
    assert!(artifact["realization"]["executed_module_ids"].is_null());
    assert_eq!(artifact["realization"]["modules"][0]["state"], "resolved");
    assert!(
        artifact["realization"]["modules"][0]["realized_fdm_mask_digest"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("sha256:"))
    );

    fs::remove_dir_all(output_dir).expect("remove runtime artifact fixture");
}

#[cfg(feature = "fem-gpu")]
#[test]
fn fem_runtime_artifact_contains_concrete_graph_realization() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fem;
    problem.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
        fdm: None,
        fem: Some(fullmag_ir::FemHintsIR {
            order: 1,
            hmax: 2.0e-9,
            mesh: Some("meshes/unit_tet.msh".to_string()),
            demag_solver_policy: None,
        }),
        hybrid: None,
    });
    problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: Vec::new(),
        fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
            geometry_name: "strip".to_string(),
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: Some(fullmag_ir::MeshIR {
                mesh_name: "strip".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                    [0, 1, 2],
                    [0, 3, 1],
                    [0, 2, 3],
                    [1, 3, 2],
                ]),
                boundary_markers: vec![1, 1, 1, 1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
        }],
        fem_domain_mesh_asset: None,
    });
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 47,
        "modules": [{
            "id": "exchange:global",
            "kind": "exchange",
            "applies_to": [{"kind": "global"}],
            "solve_domain": [{"kind": "global"}],
            "depends_on": [],
            "activation": "active",
            "authored_state": "authored",
            "capability": "reference_executable",
            "source_path": "/energy_terms/0",
            "family_payload": {}
        }],
        "edges": []
    }));

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must be monotonic")
        .as_nanos();
    let output_dir = std::env::temp_dir().join(format!(
        "fullmag-physics-graph-fem-runtime-{}-{suffix}",
        std::process::id()
    ));
    let result = fullmag_runner::run_problem(&problem, 1.0e-13, &output_dir)
        .expect("managed FEM runtime should publish the graph artifact");
    assert_eq!(result.status, fullmag_runner::RunStatus::Completed);

    let artifact: serde_json::Value = serde_json::from_slice(
        &fs::read(output_dir.join("physics/physics_graph_provenance.v1.json"))
            .expect("FEM graph provenance artifact must exist"),
    )
    .expect("FEM graph provenance artifact must be valid JSON");
    assert_eq!(
        artifact["realization"]["schema_version"],
        fullmag_ir::PHYSICS_GRAPH_REALIZATION_SCHEMA
    );
    assert_eq!(
        artifact["realization"]["resolved_module_ids"],
        serde_json::json!(["exchange:global"])
    );
    assert_eq!(artifact["realization"]["modules"][0]["state"], "resolved");
    assert_eq!(
        artifact["realization"]["modules"][0]["realized_cell_count"],
        1
    );
    assert_eq!(
        artifact["realization"]["modules"][0]["realized_fem_marker_ids"],
        serde_json::json!([1])
    );
    assert!(
        artifact["realization"]["modules"][0]["topology_fingerprint"]
            .as_str()
            .is_some_and(|fingerprint| fingerprint.starts_with("sha256:"))
    );

    fs::remove_dir_all(output_dir).expect("remove FEM runtime artifact fixture");
}
