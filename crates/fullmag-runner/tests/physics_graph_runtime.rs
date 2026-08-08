use fullmag_ir::{BackendTarget, ProblemIR};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

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
