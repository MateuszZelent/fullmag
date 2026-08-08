use fullmag_ir::ProblemIR;
use fullmag_plan::resolve_physics_graph;

#[test]
fn absent_graph_is_accepted_for_legacy_problem_ir() {
    let problem = ProblemIR::bootstrap_example();
    assert!(resolve_physics_graph(&problem)
        .expect("legacy graph resolution")
        .is_none());
}

#[test]
fn active_module_with_missing_source_fails_closed() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 1,
        "modules": [{
            "id": "spin:film",
            "kind": "spin_transport",
            "applies_to": [],
            "solve_domain": [],
            "depends_on": ["missing-current"],
            "activation": "active",
            "authored_state": "authored",
            "capability": "semantic_only",
            "source_path": "/spin_transports/0",
            "family_payload": {}
        }],
        "edges": []
    }));
    let errors = resolve_physics_graph(&problem).expect_err("missing dependency");
    assert!(errors
        .iter()
        .any(|error| error.contains("dependency 'missing-current'")));
}

#[test]
fn blocked_edge_may_retain_absent_source() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 1,
        "modules": [{
            "id": "spin:film",
            "kind": "spin_transport",
            "applies_to": [],
            "solve_domain": [],
            "depends_on": ["missing-current"],
            "activation": "blocked",
            "authored_state": "authored",
            "capability": "semantic_only",
            "source_path": "/spin_transports/0",
            "family_payload": {}
        }],
        "edges": [{"kind": "current_to_spin_transport", "source_id": "missing-current", "target_id": "spin:film", "status": "blocked"}]
    }));
    assert!(resolve_physics_graph(&problem)
        .expect("blocked graph")
        .is_some());
}
