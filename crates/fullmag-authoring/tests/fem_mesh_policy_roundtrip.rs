use fullmag_ir::MeshSemanticsIR;

#[test]
fn public_authored_policy_round_trips_without_legacy_mesh_workflow() {
    let authored = serde_json::json!({
        "requested_policy": {
            "schema_version": "fem_mesh_policy.v1",
            "geometric_element_order": 1,
            "materials": [{
                "target": {"object_id": "obj_film"},
                "strategy_intent": "thin_film_tetrahedral",
                "maximum_element_size": 3e-9,
                "minimum_element_size": 1e-9
            }],
            "interfaces": [],
            "airbox": {
                "law": "linear",
                "near_element_size": 3e-9,
                "far_element_size": 30e-9,
                "transition_distance": 100e-9
            },
            "sweeps": [],
            "growth": {
                "definition_id": "adjacent_size_growth.v1",
                "cell_size_definition_id": "cell.max_edge.v1",
                "max_neighbor_ratio": 1.3,
                "relative_tolerance": 0.05
            },
            "quality": {"thresholds": []}
        }
    });

    let semantics: MeshSemanticsIR = serde_json::from_value(authored).unwrap();
    let policy = semantics.requested_policy.as_ref().unwrap();
    policy.validate().unwrap();
    let fingerprint = policy.policy_fingerprint().unwrap();
    let canonical = serde_json::to_value(&semantics).unwrap();
    assert!(canonical.get("runtime_metadata").is_none());

    let decoded: MeshSemanticsIR = serde_json::from_value(canonical).unwrap();
    assert_eq!(decoded.requested_policy, semantics.requested_policy);
    assert_eq!(
        decoded
            .requested_policy
            .as_ref()
            .unwrap()
            .policy_fingerprint()
            .unwrap(),
        fingerprint
    );
}

#[test]
fn requested_policy_absence_is_distinct_from_explicit_null() {
    let missing: MeshSemanticsIR = serde_json::from_value(serde_json::json!({})).unwrap();
    assert!(missing.requested_policy.is_none());

    let error = serde_json::from_value::<MeshSemanticsIR>(serde_json::json!({
        "requested_policy": null
    }))
    .expect_err("explicit requested_policy=null must fail closed")
    .to_string();
    assert!(error.contains("fem_mesh_policy_malformed_value"), "{error}");
    assert!(error.contains("/requested_policy"), "{error}");
}
