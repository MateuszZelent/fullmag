use fullmag_ir::BackendTarget;
use fullmag_ir::ExecutionDevice;
use fullmag_ir::PhysicsGraphRealizationStateIR;
use fullmag_ir::PrescribedSotFormulaIR;
use fullmag_ir::PrescribedSotV1DriveIR;
use fullmag_ir::ProblemIR;
use fullmag_ir::RegionRefIR;
use fullmag_ir::SlonczewskiRealizationIR;
use fullmag_ir::SpinTorqueModuleIR;
use fullmag_plan::{resolve_physics_graph, resolve_physics_modules};

fn racetrack_problem() -> ProblemIR {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json"
    ))
    .expect("racetrack fixture must be valid JSON");
    let lowering = fixture
        .get("normalized_problem_ir_contract")
        .and_then(|value| value.get("expected_lowering"))
        .expect("racetrack fixture must contain typed expected_lowering");
    let mut problem: ProblemIR =
        serde_json::from_value(lowering.clone()).expect("fixture lowering must parse");

    problem.problem_meta.runtime_metadata.insert(
        "runtime_selection".into(),
        serde_json::json!({
            "backend": "fdm",
            "device": "cpu",
            "gpu_count": 0,
            "device_index": null,
            "cpu_threads": null,
            "execution_mode": "strict",
            "execution_precision": "double"
        }),
    );
    problem.spin_transport_modules[0].requested_execution.device = ExecutionDevice::Cpu;
    problem.spin_transport_modules[0].solver.engine = "auto".into();
    problem
}

fn drift_diffusion_torque(id: &str, solve_id: &str) -> SpinTorqueModuleIR {
    SpinTorqueModuleIR::DriftDiffusionSpinTorque {
        schema_version: "drift_diffusion_spin_torque.v1".to_string(),
        id: id.to_string(),
        solve_id: solve_id.to_string(),
        target: RegionRefIR {
            object_id: "fm".to_string(),
            region_id: None,
        },
        formula_version: "transport_torque_angular_momentum.fullmag.v1".to_string(),
    }
}

fn zhang_li_torque(id: &str, current_source: &str) -> SpinTorqueModuleIR {
    SpinTorqueModuleIR::ZhangLi {
        schema_version: Some("zhang_li_torque.v1".to_string()),
        id: Some(id.to_string()),
        target: Some(RegionRefIR {
            object_id: "fm".to_string(),
            region_id: None,
        }),
        formula_version: "zhang_li.mumax3.v1".to_string(),
        operator_version: Some("zl_mumax3_central_v1".to_string()),
        current_density: None,
        current_source: Some(current_source.to_string()),
        degree: 0.4,
        beta: 0.03,
        lande_g: Some(2.0),
    }
}

fn slonczewski_torque(id: &str, current_source: &str) -> SpinTorqueModuleIR {
    SpinTorqueModuleIR::Slonczewski {
        schema_version: Some("slonczewski_torque.v1".to_string()),
        id: Some(id.to_string()),
        target: Some(RegionRefIR {
            object_id: "fm".to_string(),
            region_id: None,
        }),
        formula_version: "slonczewski.fullmag.v2".to_string(),
        current_density: None,
        current_source: Some(current_source.to_string()),
        degree: 0.4,
        spin_polarization: [0.0, 0.0, 1.0],
        stack_normal: Some([0.0, 0.0, 1.0]),
        lambda_asymmetry: 1.0,
        epsilon_prime: 0.0,
        free_layer_thickness_m: Some(1.0e-9),
        fixed_layer_position: None,
        realization: Some(SlonczewskiRealizationIR::ThinLayerHomogenized {
            realization_version: "slonczewski_thin_layer_homogenized.v1".to_string(),
        }),
    }
}

fn prescribed_sot_torque(id: &str, current_source: &str) -> SpinTorqueModuleIR {
    SpinTorqueModuleIR::PrescribedSot {
        schema_version: "prescribed_sot.v1".to_string(),
        id: id.to_string(),
        target: Some(RegionRefIR {
            object_id: "fm".to_string(),
            region_id: None,
        }),
        formula: PrescribedSotFormulaIR::FullmagV1 {
            drive: PrescribedSotV1DriveIR::VectorCurrentSource {
                current_source_id: current_source.to_string(),
                drive_direction: [1.0, 0.0, 0.0],
                interface_normal: [0.0, 0.0, 1.0],
            },
            xi_dl: 0.1,
            xi_fl: 0.01,
            free_layer_thickness_m: 1.0e-9,
        },
    }
}

fn typed_torque_graph_problem(
    torque: SpinTorqueModuleIR,
    family_payload: serde_json::Value,
    dependency: &str,
    edge_kind: &str,
) -> ProblemIR {
    let mut problem = racetrack_problem();
    problem.spin_torque_modules = vec![torque];
    let charge_payload =
        serde_json::to_value(&problem.current_modules[0]).expect("serialize charge source");
    let spin_payload =
        serde_json::to_value(&problem.spin_transport_modules[0]).expect("serialize spin source");
    problem.physics_graph = Some(serde_json::json!({
        "schema_version": "physics_graph.v1",
        "scene_revision": 47,
        "modules": [
            {
                "id":"charge",
                "kind":"current_transport",
                "applies_to":[{"kind":"cross_object","object_ids":["fm","hm"]}],
                "solve_domain":[{"object_id":"hm"},{"object_id":"fm"}],
                "depends_on":[],
                "activation":"active",
                "source_path":"/current_modules/0",
                "family_payload":charge_payload
            },
            {
                "id":"spin",
                "kind":"spin_transport",
                "applies_to":[{"kind":"cross_object","object_ids":["fm","hm"]}],
                "solve_domain":[{"object_id":"hm"},{"object_id":"fm"}],
                "depends_on":["charge"],
                "activation":"active",
                "source_path":"/spin_transport_modules/0",
                "family_payload":spin_payload
            },
            {
                "id":"torque",
                "kind":"spin_torque",
                "applies_to":[{"kind":"object","object_id":"fm"}],
                "solve_domain":[],
                "depends_on":[dependency],
                "activation":"active",
                "source_path":"/spin_torque_modules/0",
                "family_payload":family_payload
            }
        ],
        "edges": [
            {
                "kind":"current_to_spin_transport",
                "source_id":"charge",
                "target_id":"spin",
                "status":"active"
            },
            {
                "kind": edge_kind,
                "source_id": dependency,
                "target_id": "torque",
                "status": "active"
            }
        ]
    }));
    problem
}

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
fn source_bound_torque_families_accept_their_exact_declared_semantic_edge() {
    let cases = [
        (
            "drift diffusion",
            drift_diffusion_torque("torque", "spin"),
            "spin",
            "spin_transport_to_torque",
        ),
        (
            "current driven",
            zhang_li_torque("torque", "charge"),
            "charge",
            "current_to_torque",
        ),
        (
            "nested prescribed SOT current drive",
            prescribed_sot_torque("torque", "charge"),
            "charge",
            "current_to_torque",
        ),
    ];

    for (case, torque, dependency, edge_kind) in cases {
        let payload = serde_json::to_value(&torque).expect("serialize typed torque");
        let problem = typed_torque_graph_problem(torque, payload, dependency, edge_kind);
        problem
            .validate()
            .unwrap_or_else(|errors| panic!("{case} typed ProblemIR must validate: {errors:?}"));
        assert!(resolve_physics_graph(&problem)
            .unwrap_or_else(|errors| panic!("{case} graph must resolve: {errors:?}"))
            .is_some());
        if case == "drift diffusion" {
            fullmag_plan::plan(&problem)
                .unwrap_or_else(|error| panic!("{case} primary plan must resolve: {error:?}"));
        }
    }
}

#[test]
fn source_bound_torque_families_reject_semantic_edge_loopholes() {
    let drift = drift_diffusion_torque("torque", "spin");
    let drift_payload = serde_json::to_value(&drift).expect("serialize drift torque");
    let zhang_li = zhang_li_torque("torque", "charge");
    let zhang_li_payload = serde_json::to_value(&zhang_li).expect("serialize Zhang-Li torque");
    let cases = [
        (
            "drift diffusion swapped source",
            drift.clone(),
            drift_payload.clone(),
            "spin",
            serde_json::json!([{"kind":"current_to_torque","source_id":"charge","target_id":"torque","status":"active"}]),
        ),
        (
            "drift diffusion extra wrong edge",
            drift.clone(),
            drift_payload.clone(),
            "spin",
            serde_json::json!([
                {"kind":"spin_transport_to_torque","source_id":"spin","target_id":"torque","status":"active"},
                {"kind":"current_to_torque","source_id":"charge","target_id":"torque","status":"active"}
            ]),
        ),
        (
            "drift diffusion missing edge",
            drift.clone(),
            drift_payload.clone(),
            "spin",
            serde_json::json!([]),
        ),
        (
            "drift diffusion duplicate edge",
            drift.clone(),
            drift_payload.clone(),
            "spin",
            serde_json::json!([
                {"kind":"spin_transport_to_torque","source_id":"spin","target_id":"torque","status":"active"},
                {"kind":"spin_transport_to_torque","source_id":"spin","target_id":"torque","status":"active"}
            ]),
        ),
        (
            "drift diffusion payload dependency mismatch",
            drift.clone(),
            serde_json::json!({"kind":"drift_diffusion_spin_torque","solve_id":"charge"}),
            "spin",
            serde_json::json!([{"kind":"spin_transport_to_torque","source_id":"spin","target_id":"torque","status":"active"}]),
        ),
        (
            "current driven swapped source",
            zhang_li.clone(),
            zhang_li_payload.clone(),
            "charge",
            serde_json::json!([{"kind":"spin_transport_to_torque","source_id":"spin","target_id":"torque","status":"active"}]),
        ),
        (
            "current family inverse spin edge",
            zhang_li.clone(),
            zhang_li_payload.clone(),
            "spin",
            serde_json::json!([{"kind":"spin_transport_to_torque","source_id":"spin","target_id":"torque","status":"active"}]),
        ),
        (
            "spin family inverse current edge",
            drift,
            drift_payload,
            "charge",
            serde_json::json!([{"kind":"current_to_torque","source_id":"charge","target_id":"torque","status":"active"}]),
        ),
    ];

    for (case, torque, payload, dependency, edges) in cases {
        let mut problem =
            typed_torque_graph_problem(torque, payload, dependency, "spin_transport_to_torque");
        problem.physics_graph.as_mut().expect("typed graph")["edges"] = edges;
        let errors =
            resolve_physics_graph(&problem).expect_err(&format!("{case} graph must fail closed"));
        assert!(
            errors.iter().any(|error| error.contains("torque 'torque'")),
            "{case} must identify the rejected torque contract: {errors:?}"
        );
        let plan_error = fullmag_plan::plan(&problem)
            .expect_err(&format!("{case} primary plan must fail closed"));
        assert!(
            plan_error
                .reasons
                .iter()
                .any(|error| error.contains("torque 'torque'")),
            "{case} primary plan must identify the rejected torque contract: {plan_error:?}"
        );
    }
}

#[test]
fn typed_drift_diffusion_torque_rejects_coordinated_current_graph_mutation() {
    let problem = typed_torque_graph_problem(
        drift_diffusion_torque("torque", "spin"),
        serde_json::json!({
            "kind": "zhang_li",
            "current_source": "charge"
        }),
        "charge",
        "current_to_torque",
    );

    let errors = resolve_physics_graph(&problem)
        .expect_err("typed drift-diffusion torque must reject a coordinated current graph");
    assert!(
        errors.iter().any(|error| {
            error.contains("torque 'torque'") && error.contains("typed spin_torque_modules")
        }),
        "typed/graph mismatch must identify canonical torque ownership: {errors:?}"
    );
}

#[test]
fn typed_current_torque_rejects_coordinated_spin_graph_mutation() {
    let problem = typed_torque_graph_problem(
        zhang_li_torque("torque", "charge"),
        serde_json::json!({
            "kind": "drift_diffusion_spin_torque",
            "solve_id": "spin"
        }),
        "spin",
        "spin_transport_to_torque",
    );

    let errors = resolve_physics_graph(&problem)
        .expect_err("typed current torque must reject a coordinated spin graph");
    assert!(
        errors.iter().any(|error| {
            error.contains("torque 'torque'") && error.contains("typed spin_torque_modules")
        }),
        "inverse typed/graph mismatch must identify canonical torque ownership: {errors:?}"
    );
}

#[test]
fn typed_torque_rejects_non_object_graph_family_payload() {
    let problem = typed_torque_graph_problem(
        drift_diffusion_torque("torque", "spin"),
        serde_json::Value::Null,
        "spin",
        "spin_transport_to_torque",
    );

    let errors = resolve_physics_graph(&problem)
        .expect_err("typed torque must reject an absent graph family payload");
    assert!(
        errors.iter().any(|error| {
            error.contains("torque 'torque'") && error.contains("typed spin_torque_modules")
        }),
        "non-object graph payload must identify canonical torque ownership: {errors:?}"
    );
}

#[test]
fn typed_torque_families_accept_matching_canonical_graph_payloads() {
    let cases = [
        (
            "drift diffusion",
            drift_diffusion_torque("torque", "spin"),
            "spin",
            "spin_transport_to_torque",
        ),
        (
            "Zhang-Li",
            zhang_li_torque("torque", "charge"),
            "charge",
            "current_to_torque",
        ),
        (
            "Slonczewski",
            slonczewski_torque("torque", "charge"),
            "charge",
            "current_to_torque",
        ),
        (
            "prescribed SOT",
            prescribed_sot_torque("torque", "charge"),
            "charge",
            "current_to_torque",
        ),
    ];

    for (case, torque, dependency, edge_kind) in cases {
        let payload = serde_json::to_value(&torque).expect("serialize typed torque");
        let problem = typed_torque_graph_problem(torque, payload, dependency, edge_kind);
        problem
            .validate()
            .unwrap_or_else(|errors| panic!("{case} typed ProblemIR must validate: {errors:?}"));
        assert!(resolve_physics_graph(&problem)
            .unwrap_or_else(|errors| panic!("{case} typed graph must resolve: {errors:?}"))
            .is_some());
        if case == "drift diffusion" {
            fullmag_plan::plan(&problem).unwrap_or_else(|error| {
                panic!("{case} typed problem must use the primary planner: {error:?}")
            });
        }
    }
}

#[test]
fn typed_torque_cardinality_is_enforced_by_direct_and_primary_planners() {
    let torque = drift_diffusion_torque("torque", "spin");
    let payload = serde_json::to_value(&torque).expect("serialize typed torque");

    let exactly_one = typed_torque_graph_problem(
        torque.clone(),
        payload.clone(),
        "spin",
        "spin_transport_to_torque",
    );
    assert!(resolve_physics_graph(&exactly_one)
        .expect("exactly one typed torque must resolve directly")
        .is_some());
    fullmag_plan::plan(&exactly_one).expect("exactly one typed torque must reach the primary plan");

    let mut zero = exactly_one.clone();
    zero.spin_torque_modules.clear();
    let direct_zero =
        resolve_physics_graph(&zero).expect_err("graph-only torque must fail direct resolution");
    assert!(direct_zero.iter().any(|error| {
        error.contains("torque 'torque'")
            && error.contains("exactly one canonical typed spin_torque_modules record")
    }));
    let planned_zero =
        fullmag_plan::plan(&zero).expect_err("graph-only torque must fail primary planning");
    assert!(planned_zero.reasons.iter().any(|error| {
        error.contains("torque 'torque'")
            && error.contains("exactly one canonical typed spin_torque_modules record")
    }));

    let mut multiple = exactly_one;
    multiple.spin_torque_modules.push(torque);
    let direct_multiple = resolve_physics_graph(&multiple)
        .expect_err("ambiguous typed torque must fail direct resolution");
    assert!(direct_multiple.iter().any(|error| {
        error.contains("torque 'torque'")
            && error.contains("exactly one canonical typed spin_torque_modules record")
    }));
    let planned_multiple = fullmag_plan::plan(&multiple)
        .expect_err("ambiguous typed torque must fail primary planning");
    assert!(planned_multiple.reasons.iter().any(|error| {
        error.contains("canonical torque id 'torque'") && error.contains("duplicate")
    }));
}

#[test]
fn canonical_typed_torque_requires_one_graph_node_with_exact_spin_torque_kind() {
    let torque = drift_diffusion_torque("torque", "spin");
    let payload = serde_json::to_value(&torque).expect("serialize typed torque");
    let baseline = typed_torque_graph_problem(torque, payload, "spin", "spin_transport_to_torque");

    for case in [
        "missing node",
        "missing kind",
        "null kind",
        "unknown kind",
        "wrong known kind",
        "duplicate node",
    ] {
        let mut problem = baseline.clone();
        let graph = problem
            .physics_graph
            .as_mut()
            .and_then(serde_json::Value::as_object_mut)
            .expect("typed graph");
        let modules = graph["modules"]
            .as_array_mut()
            .expect("typed graph modules");
        match case {
            "missing node" => {
                modules.retain(|module| {
                    module.get("id").and_then(serde_json::Value::as_str) != Some("torque")
                });
                graph["edges"]
                    .as_array_mut()
                    .expect("typed graph edges")
                    .retain(|edge| {
                        edge.get("target_id").and_then(serde_json::Value::as_str) != Some("torque")
                    });
            }
            "duplicate node" => {
                let duplicate = modules
                    .iter()
                    .find(|module| {
                        module.get("id").and_then(serde_json::Value::as_str) == Some("torque")
                    })
                    .expect("typed torque graph node")
                    .clone();
                modules.push(duplicate);
            }
            kind_case => {
                let module = modules
                    .iter_mut()
                    .find(|module| {
                        module.get("id").and_then(serde_json::Value::as_str) == Some("torque")
                    })
                    .and_then(serde_json::Value::as_object_mut)
                    .expect("typed torque graph node");
                match kind_case {
                    "missing kind" => {
                        module.remove("kind");
                    }
                    "null kind" => {
                        module.insert("kind".to_string(), serde_json::Value::Null);
                    }
                    "unknown kind" => {
                        module.insert("kind".to_string(), serde_json::json!("banana"));
                    }
                    "wrong known kind" => {
                        module.insert("kind".to_string(), serde_json::json!("current_transport"));
                    }
                    _ => unreachable!("covered case"),
                }
            }
        }

        let direct = resolve_physics_graph(&problem)
            .expect_err(&format!("{case} must fail direct graph resolution"));
        assert!(
            direct.iter().any(|error| {
                error.contains("canonical typed spin_torque_modules record 'torque'")
                    && error.contains("physics_graph module")
            }),
            "{case} must identify the missing or mistyped canonical graph node: {direct:?}"
        );

        let planned =
            fullmag_plan::plan(&problem).expect_err(&format!("{case} must fail primary planning"));
        assert!(
            planned.reasons.iter().any(|error| {
                error.contains("canonical typed spin_torque_modules record 'torque'")
                    && error.contains("physics_graph module")
            }),
            "{case} primary error must retain the canonical graph-node contract: {planned:?}"
        );
    }
}

#[test]
fn unknown_graph_records_are_provenance_only_or_fail_closed() {
    for activation in ["active", "configured", "inactive", "blocked"] {
        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fdm;
        problem.physics_graph = Some(serde_json::json!({
            "schema_version": "physics_graph.v1",
            "scene_revision": 48,
            "modules": [{
                "id": "future:module",
                "kind": "banana",
                "applies_to": [{"kind": "object", "object_id": "strip"}],
                "solve_domain": [{"object_id": "strip"}],
                "depends_on": [],
                "activation": activation,
                "source_path": "/future/0",
                "family_payload": {}
            }],
            "edges": []
        }));

        let direct = resolve_physics_graph(&problem).expect_err(&format!(
            "unknown {activation} record must fail direct resolution"
        ));
        assert!(
            direct.iter().any(|error| {
                error.contains("future:module")
                    && error.contains("unknown kind 'banana'")
                    && error.contains("unsupported or unresolved")
            }),
            "unknown {activation} record must report its provenance-only contract: {direct:?}"
        );
        let planned = fullmag_plan::plan(&problem).expect_err(&format!(
            "unknown {activation} record must fail primary planning"
        ));
        assert!(planned.reasons.iter().any(|error| {
            error.contains("future:module")
                && error.contains("unknown kind 'banana'")
                && error.contains("unsupported or unresolved")
        }));
    }

    for activation in ["unsupported", "unresolved"] {
        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fdm;
        problem.physics_graph = Some(serde_json::json!({
            "schema_version": "physics_graph.v1",
            "scene_revision": 48,
            "modules": [{
                "id": "future:module",
                "kind": "banana",
                "applies_to": [{"kind": "object", "object_id": "strip"}],
                "solve_domain": [{"object_id": "strip"}],
                "depends_on": [],
                "activation": activation,
                "source_path": "/future/0",
                "family_payload": {}
            }],
            "edges": []
        }));

        assert!(resolve_physics_graph(&problem)
            .unwrap_or_else(|errors| panic!("{activation} unknown record must resolve: {errors:?}"))
            .is_some());
        let modules =
            resolve_physics_modules(&problem, BackendTarget::Fdm).unwrap_or_else(|errors| {
                panic!("{activation} unknown record must resolve: {errors:?}")
            });
        assert_eq!(modules[0].status, activation);
        assert!(modules[0].fdm_cell_mask_id.is_none());

        let plan = fullmag_plan::plan(&problem)
            .unwrap_or_else(|error| panic!("{activation} unknown record must plan: {error:?}"));
        let provenance = plan
            .provenance
            .physics_graph
            .as_ref()
            .expect("graph provenance");
        assert_eq!(provenance.modules[0].status, activation);
        assert!(provenance.modules[0].fdm_cell_mask_id.is_none());
        let realization = provenance.realization.as_ref().expect("graph realization");
        assert!(realization.resolved_module_ids.is_empty());
        assert_eq!(
            realization.modules[0].state,
            PhysicsGraphRealizationStateIR::SemanticOnly
        );
        assert!(realization.modules[0].realized_fdm_mask_digest.is_none());
        assert_eq!(realization.modules[0].realized_cell_count, 0);
    }
}

#[test]
fn typed_torque_rejects_unknown_graph_family_in_direct_and_primary_planners() {
    let torque = drift_diffusion_torque("torque", "spin");
    let mut payload = serde_json::to_value(&torque).expect("serialize typed torque");
    payload["kind"] = serde_json::json!("banana");
    let problem = typed_torque_graph_problem(torque, payload, "spin", "spin_transport_to_torque");

    let direct = resolve_physics_graph(&problem)
        .expect_err("unknown graph torque family must fail direct resolution");
    assert!(direct.iter().any(|error| {
        error.contains("torque 'torque'")
            && error.contains("unknown family 'banana'")
            && error.contains("spin_torque_modules")
    }));
    let planned = fullmag_plan::plan(&problem)
        .expect_err("unknown graph torque family must fail primary planning");
    assert!(planned.reasons.iter().any(|error| {
        error.contains("torque 'torque'")
            && error.contains("unknown family 'banana'")
            && error.contains("spin_torque_modules")
    }));
}

#[test]
fn duplicate_cross_family_typed_torque_ids_fail_closed() {
    let slonczewski = slonczewski_torque("torque", "charge");
    let payload = serde_json::to_value(&slonczewski).expect("serialize typed torque");
    let mut problem =
        typed_torque_graph_problem(slonczewski, payload, "charge", "current_to_torque");
    problem
        .spin_torque_modules
        .push(zhang_li_torque("torque", "charge"));

    let validation_errors = problem
        .validate()
        .expect_err("cross-family canonical torque IDs must be globally unique");
    assert!(
        validation_errors.iter().any(|error| {
            error.contains("canonical torque id 'torque'") && error.contains("duplicate")
        }),
        "ProblemIR validation must identify the duplicate canonical torque identity: {validation_errors:?}"
    );

    let graph_errors = resolve_physics_graph(&problem)
        .expect_err("the direct graph resolver must reject an ambiguous typed torque identity");
    assert!(
        graph_errors.iter().any(|error| {
            error.contains("torque 'torque'")
                && error.contains("canonical typed spin_torque_modules")
                && error.contains("exactly one")
        }),
        "graph resolution must fail closed on the ambiguous typed identity: {graph_errors:?}"
    );

    let plan_error = fullmag_plan::plan(&problem)
        .expect_err("the primary planner must reject duplicate canonical torque IDs");
    assert!(plan_error.reasons.iter().any(|error| {
        error.contains("canonical torque id 'torque'") && error.contains("duplicate")
    }));
}

#[test]
fn typed_torque_source_module_requires_exact_kind() {
    let torque = drift_diffusion_torque("torque", "spin");
    let payload = serde_json::to_value(&torque).expect("serialize typed torque");
    let mut problem =
        typed_torque_graph_problem(torque, payload, "spin", "spin_transport_to_torque");
    let modules = problem
        .physics_graph
        .as_mut()
        .and_then(|graph| graph.get_mut("modules"))
        .and_then(serde_json::Value::as_array_mut)
        .expect("typed graph modules");
    modules
        .iter_mut()
        .find(|module| module.get("id").and_then(serde_json::Value::as_str) == Some("spin"))
        .and_then(serde_json::Value::as_object_mut)
        .expect("spin source module")
        .remove("kind");

    problem
        .validate()
        .expect("typed ProblemIR remains valid independently of its malformed graph copy");
    let graph_errors = resolve_physics_graph(&problem)
        .expect_err("a typed torque source module without kind must fail closed");
    assert!(
        graph_errors.iter().any(|error| {
            error.contains("torque 'torque'")
                && error.contains("source 'spin'")
                && error.contains("spin_transport")
        }),
        "missing source kind must identify the exact typed source contract: {graph_errors:?}"
    );

    let plan_error = fullmag_plan::plan(&problem)
        .expect_err("the primary planner must reject a source module without its exact kind");
    assert!(plan_error.reasons.iter().any(|error| {
        error.contains("torque 'torque'")
            && error.contains("source 'spin'")
            && error.contains("spin_transport")
    }));
}

#[test]
fn typed_torque_edge_status_must_match_module_activation() {
    for activation in [
        "active",
        "configured",
        "inactive",
        "blocked",
        "unsupported",
        "unresolved",
    ] {
        let torque = drift_diffusion_torque("torque", "spin");
        let payload = serde_json::to_value(&torque).expect("serialize typed torque");
        let mut problem =
            typed_torque_graph_problem(torque, payload, "spin", "spin_transport_to_torque");
        let graph = problem
            .physics_graph
            .as_mut()
            .and_then(serde_json::Value::as_object_mut)
            .expect("typed graph");
        graph["modules"]
            .as_array_mut()
            .expect("typed graph modules")
            .iter_mut()
            .find(|module| module.get("id").and_then(serde_json::Value::as_str) == Some("torque"))
            .expect("typed torque module")["activation"] =
            serde_json::Value::String(activation.to_string());
        graph["edges"]
            .as_array_mut()
            .expect("typed graph edges")
            .iter_mut()
            .find(|edge| {
                edge.get("target_id").and_then(serde_json::Value::as_str) == Some("torque")
            })
            .expect("typed torque edge")["status"] =
            serde_json::Value::String(activation.to_string());

        problem
            .validate()
            .expect("typed ProblemIR remains valid independently of its malformed graph copy");
        assert!(resolve_physics_graph(&problem)
            .unwrap_or_else(|errors| panic!("{activation} typed graph must resolve: {errors:?}"))
            .is_some());
        let resolved = resolve_physics_modules(&problem, BackendTarget::Fdm)
            .unwrap_or_else(|errors| panic!("{activation} modules must resolve: {errors:?}"));
        let resolved_torque = resolved
            .iter()
            .find(|module| module.module_id == "torque")
            .expect("resolved typed torque");
        assert_eq!(resolved_torque.status, activation);
        assert_eq!(
            resolved_torque.fdm_cell_mask_id.is_some(),
            matches!(activation, "active" | "configured"),
            "only executable activation states may materialize an FDM mask"
        );
        if matches!(activation, "active" | "configured") {
            fullmag_plan::plan(&problem).unwrap_or_else(|error| {
                panic!("{activation} primary plan must remain executable: {error:?}")
            });
        } else {
            let error = fullmag_plan::plan(&problem).expect_err(&format!(
                "{activation} torque must not be executable through the primary plan"
            ));
            assert!(
                error.reasons.iter().any(|reason| {
                    reason.contains("spin transport 'spin'")
                        && reason.contains("no DriftDiffusionSpinTorque target")
                }),
                "{activation} primary plan must fail because torque is non-executable: {error:?}"
            );
        }
    }
}

fn assert_typed_torque_status_rejected(field: &str, malformed: Option<serde_json::Value>) {
    let torque = drift_diffusion_torque("torque", "spin");
    let payload = serde_json::to_value(&torque).expect("serialize typed torque");
    let mut problem =
        typed_torque_graph_problem(torque, payload, "spin", "spin_transport_to_torque");
    let graph = problem
        .physics_graph
        .as_mut()
        .and_then(serde_json::Value::as_object_mut)
        .expect("typed graph");
    if field.starts_with("module") {
        let module = graph["modules"]
            .as_array_mut()
            .expect("typed graph modules")
            .iter_mut()
            .find(|module| module.get("id").and_then(serde_json::Value::as_str) == Some("torque"))
            .and_then(serde_json::Value::as_object_mut)
            .expect("typed torque module");
        match malformed {
            Some(value) => {
                module.insert("activation".to_string(), value);
            }
            None => {
                module.remove("activation");
            }
        }
    } else {
        let edge = graph["edges"]
            .as_array_mut()
            .expect("typed graph edges")
            .iter_mut()
            .find(|edge| {
                edge.get("target_id").and_then(serde_json::Value::as_str) == Some("torque")
            })
            .and_then(serde_json::Value::as_object_mut)
            .expect("typed torque edge");
        match malformed {
            Some(value) => {
                edge.insert("status".to_string(), value);
            }
            None => {
                edge.remove("status");
            }
        }
    }

    let direct =
        resolve_physics_graph(&problem).expect_err(&format!("{field} must fail direct resolution"));
    assert!(
        direct.iter().any(|error| {
            error.contains(if field.starts_with("module") {
                "physics_graph torque 'torque' activation"
            } else {
                "physics_graph torque 'torque' semantic edge status"
            }) && error.contains("configured|active|inactive|blocked|unsupported|unresolved")
        }),
        "{field} must report the closed vocabulary: {direct:?}"
    );
    let planned =
        fullmag_plan::plan(&problem).expect_err(&format!("{field} must fail primary planning"));
    assert!(
        planned.reasons.iter().any(
            |error| error.contains("configured|active|inactive|blocked|unsupported|unresolved")
        ),
        "{field} primary plan must preserve the closed-vocabulary error: {planned:?}"
    );
}

#[test]
fn typed_torque_requires_explicit_string_activation_and_edge_status() {
    for (field, malformed) in [
        ("module activation missing", None),
        (
            "module activation non-string",
            Some(serde_json::Value::Null),
        ),
        ("edge status missing", None),
        ("edge status non-string", Some(serde_json::Value::Null)),
    ] {
        assert_typed_torque_status_rejected(field, malformed);
    }
}

#[test]
fn typed_torque_rejects_unknown_activation_status_banana() {
    assert_typed_torque_status_rejected(
        "module activation unknown",
        Some(serde_json::json!("banana")),
    );
}

#[test]
fn typed_torque_rejects_unknown_semantic_edge_status_banana() {
    assert_typed_torque_status_rejected("edge status unknown", Some(serde_json::json!("banana")));
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
fn lane_mismatch_degrades_active_and_configured_without_changing_other_states() {
    for activation in [
        "active",
        "configured",
        "inactive",
        "blocked",
        "unsupported",
        "unresolved",
    ] {
        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fdm;
        problem.physics_graph = Some(serde_json::json!({
            "schema_version": "physics_graph.v1",
            "scene_revision": 49,
            "modules": [{
                "id": "current:film",
                "kind": "current_transport",
                "applies_to": [{"kind": "object", "object_id": "strip"}],
                "solve_domain": [{"object_id": "strip"}],
                "depends_on": [],
                "activation": activation,
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

        let expected_status = if matches!(activation, "active" | "configured") {
            "unsupported"
        } else {
            activation
        };
        let resolved = resolve_physics_modules(&problem, BackendTarget::Fdm)
            .unwrap_or_else(|errors| panic!("{activation} lane mismatch must resolve: {errors:?}"));
        assert_eq!(resolved[0].status, expected_status);
        assert!(resolved[0].fdm_cell_mask_id.is_none());
        if matches!(activation, "active" | "configured") {
            assert!(resolved[0]
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("requests lane 'fem'")
                    && reason.contains("resolved lane is 'fdm'")));
        } else {
            assert!(resolved[0].reason.as_deref().is_some_and(
                |reason| reason.contains(&format!("activation status '{activation}' retained"))
            ));
        }

        let plan = fullmag_plan::plan(&problem)
            .unwrap_or_else(|error| panic!("{activation} lane mismatch must plan: {error:?}"));
        let provenance = plan
            .provenance
            .physics_graph
            .as_ref()
            .expect("graph provenance");
        let module = &provenance.modules[0];
        assert_eq!(module.requested_lane, BackendTarget::Fem);
        assert_eq!(module.resolved_lane, BackendTarget::Fdm);
        assert_eq!(module.status, expected_status);
        assert!(module.fdm_cell_mask_id.is_none());
        let realization = provenance.realization.as_ref().expect("graph realization");
        assert!(realization.resolved_module_ids.is_empty());
        assert_eq!(
            realization.modules[0].state,
            PhysicsGraphRealizationStateIR::SemanticOnly
        );
        assert!(realization.modules[0].realized_fdm_mask_digest.is_none());
        assert_eq!(realization.modules[0].realized_cell_count, 0);
    }
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
    let torque = SpinTorqueModuleIR::ZhangLi {
        schema_version: Some("zhang_li_torque.v1".to_string()),
        id: Some("sp5_zhang_li".to_string()),
        target: Some(RegionRefIR {
            object_id: "plate".to_string(),
            region_id: None,
        }),
        formula_version: "zhang_li.mumax3.v1".to_string(),
        operator_version: Some("zl_mumax3_central_v1".to_string()),
        current_density: Some([1.0e12, 0.0, 0.0]),
        current_source: None,
        degree: 1.0,
        beta: 0.05,
        lande_g: Some(2.0),
    };
    let family_payload = serde_json::to_value(&torque).expect("serialize typed Zhang-Li torque");
    problem.spin_torque_modules = vec![torque];
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
            "source_path": "/spin_torque_modules/0",
            "family_payload": family_payload
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
