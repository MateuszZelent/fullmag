use fullmag_ir::ProblemIR;

#[test]
fn physics_graph_is_optional_and_round_trips_through_problem_ir() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 7,
        "modules": [],
        "edges": []
    }));
    let encoded = serde_json::to_value(&problem).expect("ProblemIR serialization");
    assert_eq!(
        encoded["physics_graph"]["schema_version"],
        "physics_graph.v1"
    );
    let decoded: ProblemIR = serde_json::from_value(encoded).expect("ProblemIR deserialization");
    assert_eq!(decoded.physics_graph, problem.physics_graph);
}

#[test]
fn legacy_problem_ir_without_physics_graph_remains_readable() {
    let problem = ProblemIR::bootstrap_example();
    let mut encoded = serde_json::to_value(problem).expect("ProblemIR serialization");
    encoded
        .as_object_mut()
        .expect("ProblemIR object")
        .remove("physics_graph");
    let decoded: ProblemIR = serde_json::from_value(encoded).expect("legacy ProblemIR");
    assert!(decoded.physics_graph.is_none());
}
