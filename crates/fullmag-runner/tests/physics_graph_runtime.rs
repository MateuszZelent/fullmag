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
    assert_eq!(artifact["realization"]["resolved_module_ids"], serde_json::json!(["current:strip"]));
    assert!(artifact["realization"]["executed_module_ids"].is_null());
    assert_eq!(artifact["realization"]["modules"][0]["state"], "resolved");
    assert!(artifact["realization"]["modules"][0]["realized_fdm_mask_digest"]
        .as_str()
        .is_some_and(|digest| digest.starts_with("sha256:")));

    fs::remove_dir_all(output_dir).expect("remove runtime artifact fixture");
}
