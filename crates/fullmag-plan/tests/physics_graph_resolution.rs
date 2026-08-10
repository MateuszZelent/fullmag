use fullmag_ir::BackendTarget;
use fullmag_ir::PhysicsGraphRealizationStateIR;
use fullmag_ir::ProblemIR;
use fullmag_plan::{resolve_physics_graph, resolve_physics_modules};

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

#[test]
fn no_current_module_emits_no_resolved_physics_operator() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 2,
        "modules": [],
        "edges": []
    }));

    let resolved =
        resolve_physics_modules(&problem, BackendTarget::Fdm).expect("empty graph resolution");
    assert!(resolved.is_empty());
}

#[test]
fn object_scope_maps_to_stable_fem_marker_and_fdm_mask() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Auto;
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 7,
        "modules": [{
            "id": "current:film",
            "kind": "current_transport",
            "applies_to": [{"kind": "object", "object_id": "film"}],
            "solve_domain": [{"object_id": "film"}],
            "depends_on": [],
            "activation": "active",
            "authored_state": "authored",
            "capability": "semantic_only",
            "source_path": "/current_modules/0",
            "family_payload": {}
        }],
        "edges": []
    }));

    let fem = resolve_physics_modules(&problem, BackendTarget::Fem).expect("FEM graph resolution");
    assert_eq!(fem[0].scope_key, "object:film");
    assert_eq!(fem[0].resolved_lane, "fem");
    assert_eq!(fem[0].fem_marker_ids.len(), 1);
    assert!(fem[0].fdm_cell_mask_id.is_none());

    let fdm = resolve_physics_modules(&problem, BackendTarget::Fdm).expect("FDM graph resolution");
    assert_eq!(fdm[0].scope_key, "object:film");
    assert_eq!(
        fdm[0].fdm_cell_mask_id.as_deref(),
        Some("physics-mask.v1:current:film:object/film")
    );
}

#[test]
fn module_reordering_does_not_change_semantic_marker_identity() {
    let graph = serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 9,
        "modules": [
            {"id":"b","kind":"oersted_field","applies_to":[{"kind":"global"}],"solve_domain":[],"depends_on":[],"activation":"active","authored_state":"authored","capability":"semantic_only","source_path":"/energy/1","family_payload":{}},
            {"id":"a","kind":"current_transport","applies_to":[{"kind":"object","object_id":"film"}],"solve_domain":[],"depends_on":[],"activation":"active","authored_state":"authored","capability":"semantic_only","source_path":"/current_modules/0","family_payload":{}}
        ],
        "edges": []
    });
    let mut first = ProblemIR::bootstrap_example();
    first.physics_graph = Some(graph.clone());
    let mut second = ProblemIR::bootstrap_example();
    let mut reversed = graph;
    reversed["modules"] = serde_json::json!([
        reversed["modules"][1].clone(),
        reversed["modules"][0].clone()
    ]);
    second.physics_graph = Some(reversed);

    let mut first_resolved = resolve_physics_modules(&first, BackendTarget::Fem).unwrap();
    let mut second_resolved = resolve_physics_modules(&second, BackendTarget::Fem).unwrap();
    first_resolved.sort_by(|left, right| left.module_id.cmp(&right.module_id));
    second_resolved.sort_by(|left, right| left.module_id.cmp(&right.module_id));
    assert_eq!(first_resolved, second_resolved);
}

#[test]
fn planned_graph_has_typed_runtime_provenance_with_scene_and_mesh_revisions() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 42,
        "modules": [{
            "id": "current:film",
            "kind": "current_transport",
            "applies_to": [{"kind": "object", "object_id": "film"}],
            "solve_domain": [{"object_id": "film"}],
            "depends_on": [],
            "activation": "active",
            "authored_state": "authored",
            "capability": "semantic_only",
            "source_path": "/current_modules/0",
            "family_payload": {
                "requested_execution": {
                    "discretization": "fem",
                    "device": "cpu",
                    "precision": "double",
                    "execution_mode": "strict"
                }
            }
        }],
        "edges": []
    }));

    let plan = fullmag_plan::plan(&problem).expect("graph-bearing FDM plan");
    let provenance = plan
        .provenance
        .physics_graph
        .as_ref()
        .expect("typed graph provenance");
    assert_eq!(provenance.schema_version, "physics_graph.runtime.v1");
    assert_eq!(provenance.graph_sha256.len(), 64);
    assert_eq!(
        provenance.graph_sha256,
        fullmag_plan::physics_graph_sha256(&problem)
            .expect("graph digest")
            .expect("graph digest")
    );
    assert_eq!(provenance.scene_revision, 42);
    assert_ne!(provenance.mesh_revision, 0);
    assert_eq!(provenance.requested_lane, BackendTarget::Fdm);
    assert_eq!(provenance.resolved_lane, BackendTarget::Fdm);
    assert_eq!(provenance.modules.len(), 1);
    let module = &provenance.modules[0];
    assert_eq!(module.module_id, "current:film");
    assert_eq!(module.scope, "object:film");
    assert_eq!(module.requested_lane, BackendTarget::Fem);
    assert_eq!(module.resolved_lane, BackendTarget::Fdm);
    assert_eq!(module.status, "unsupported");
    assert!(module.depends_on.is_empty());
}

#[test]
fn planned_graph_realization_distinguishes_resolved_from_executed() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 43,
        "modules": [{
            "id": "current:film",
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

    let plan = fullmag_plan::plan(&problem).expect("graph-bearing FDM plan");
    let realization = plan
        .provenance
        .physics_graph
        .as_ref()
        .and_then(|provenance| provenance.realization.as_ref())
        .expect("concrete realization provenance");
    assert_eq!(realization.executed_module_ids, Vec::<String>::new());
    assert_eq!(realization.resolved_module_ids, vec!["current:film"]);
    assert_eq!(
        realization.modules[0].state,
        PhysicsGraphRealizationStateIR::Resolved
    );
    assert!(realization.modules[0]
        .realized_fdm_mask_digest
        .as_deref()
        .is_some_and(|digest| digest.starts_with("sha256:")));
    assert!(realization.modules[0].realized_cell_count > 0);

    let executed = fullmag_plan::physics_graph_realization_provenance(
        &problem,
        &plan.backend_plan,
        &["current:film".to_string()],
    )
    .expect("runtime realization")
    .expect("graph realization");
    assert_eq!(executed.executed_module_ids, vec!["current:film"]);
    assert_eq!(
        executed.modules[0].state,
        PhysicsGraphRealizationStateIR::Executed
    );
}

#[test]
fn fdm_object_scope_accepts_certified_magnet_and_geometry_aliases() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.magnets[0].name = "plate".to_string();
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 44,
        "modules": [{
            "id": "sp5_zhang_li",
            "kind": "spin_torque",
            "applies_to": [{"kind": "object", "object_id": "plate"}],
            "solve_domain": [{"object_id": "plate"}],
            "depends_on": [],
            "activation": "active",
            "authored_state": "authored",
            "capability": "reference_executable",
            "source_path": "/spin_torques/0",
            "family_payload": {"kind": "zhang_li"}
        }],
        "edges": []
    }));

    let plan = fullmag_plan::plan(&problem).expect("single-grid FDM plan with object aliases");
    let fullmag_ir::BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
        panic!("expected FDM plan");
    };
    let certificate = fdm.grid_certificate.as_ref().expect("grid certificate");
    assert_eq!(certificate.object_ids, vec!["plate", "strip"]);
    assert!(certificate.region_legend.is_empty());

    let realization = plan
        .provenance
        .physics_graph
        .as_ref()
        .and_then(|graph| graph.realization.as_ref())
        .expect("physics graph realization");
    assert_eq!(realization.resolved_module_ids, vec!["sp5_zhang_li"]);
    assert_eq!(
        realization.modules[0].state,
        PhysicsGraphRealizationStateIR::Resolved
    );
    assert!(realization.modules[0].realized_cell_count > 0);
    assert!(realization.modules[0].reason.is_none());
}

#[test]
fn fem_graph_realization_uses_concrete_mesh_element_markers() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fem;
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 45,
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
    problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
        fdm_grid_assets: Vec::new(),
        fem_mesh_assets: Vec::new(),
        fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
            mesh_source: None,
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
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            }),
            region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                geometry_name: "strip".to_string(),
                marker: 1,
            }],
            object_region_markers: Vec::new(),
            build_report: None,
        }),
    });

    let plan = fullmag_plan::plan(&problem).expect("graph-bearing FEM plan");
    assert!(matches!(
        plan.backend_plan,
        fullmag_ir::BackendPlanIR::Fem(_)
    ));
    let realization = plan
        .provenance
        .physics_graph
        .as_ref()
        .and_then(|provenance| provenance.realization.as_ref())
        .expect("concrete FEM realization provenance");
    let module = &realization.modules[0];
    assert_eq!(module.state, PhysicsGraphRealizationStateIR::Resolved);
    assert!(!module.realized_fem_marker_ids.is_empty());
    assert!(module.realized_fdm_mask_digest.is_none());
    assert!(module.realized_cell_count > 0);
    assert!(module.topology_fingerprint.starts_with("sha256:"));
}

#[test]
fn graph_realization_rejects_unknown_execution_observation() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.backend_policy.requested_backend = BackendTarget::Fdm;
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 44,
        "modules": [{
            "id": "current:film",
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
    let plan = fullmag_plan::plan(&problem).expect("graph-bearing FDM plan");
    let errors = fullmag_plan::physics_graph_realization_provenance(
        &problem,
        &plan.backend_plan,
        &["missing-module".to_string()],
    )
    .expect_err("unknown execution observations must fail closed");
    assert!(errors[0].contains("unknown module IDs"));
}
