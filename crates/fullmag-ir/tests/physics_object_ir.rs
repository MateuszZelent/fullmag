use fullmag_ir::*;

#[test]
fn v0_4_object_type_does_not_imply_magnetization() {
    let mut problem = ProblemIRV04::bootstrap_example();
    problem.objects = vec![PhysicsObjectIR::new(
        "obj_hm",
        "heavy_metal",
        PhysicsObjectTypeIR::Conductor,
        "heavy_metal_geom",
    )];
    problem.magnetization_modules.clear();

    let value = serde_json::to_value(problem).unwrap();
    assert_eq!(value["objects"][0]["type"], "conductor");
    assert_eq!(value["magnetization_modules"], serde_json::json!([]));
    assert!(value.get("magnets").is_none());
}

#[test]
fn public_problem_ir_writer_remains_v0_3() {
    let value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();

    assert_eq!(value["ir_version"], "0.3.0");
    assert!(value.get("objects").is_none());
    assert!(value.get("magnets").is_some());
}

#[test]
fn v0_3_public_python_mesh_writer_golden_migrates_or_fails_closed() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/golden/mesh-policy/v03-python-writer.v1.json"
    ))
    .expect("public Python mesh writer golden must be valid JSON");

    for case in fixture["cases"].as_array().unwrap() {
        let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
        let metadata = case["writer_metadata"].as_object().unwrap();
        let runtime_metadata = value["problem_meta"]["runtime_metadata"]
            .as_object_mut()
            .unwrap();
        if let Some(mesh_workflow) = metadata.get("mesh_workflow") {
            runtime_metadata.insert("mesh_workflow".to_string(), mesh_workflow.clone());
        }
        if let Some(study_universe) = metadata.get("study_universe") {
            runtime_metadata.insert("study_universe".to_string(), study_universe.clone());
        }

        match case["id"].as_str().unwrap() {
            "numeric_thin_film_airbox" => {
                migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
                let problem: ProblemIRV04 = serde_json::from_value(value).unwrap();
                problem.validate().unwrap();
                let policy = problem.fem_mesh_policy().unwrap();
                assert_eq!(policy.geometric_element_order, 1);
                assert_eq!(policy.materials.len(), 1);
                assert_eq!(policy.materials[0].target.object_id, "obj_strip");
                assert_eq!(
                    policy.materials[0].strategy_intent,
                    FemMeshStrategyIntentIR::ThinFilmTetrahedral
                );
                assert_eq!(policy.interfaces.len(), 1);
                assert_eq!(policy.interfaces[0].maximum_element_size, 8e-9);
                assert_eq!(policy.sweeps.len(), 1);
                assert_eq!(policy.sweeps[0].family_intent, FemElementFamilyIR::Tet4);
                assert_eq!(policy.sweeps[0].layers, 1);
                let airbox = policy.airbox.as_ref().unwrap();
                assert_eq!(airbox.law, FemAirboxGradingLawIR::Geometric);
                assert_eq!(airbox.near_element_size, Some(5e-9));
                assert_eq!(airbox.far_element_size, 80e-9);
                assert_eq!(airbox.element_ratio, Some(1.4));
                assert_eq!(policy.growth.as_ref().unwrap().max_neighbor_ratio, 1.4);
            }
            "explicit_hmax_auto" => {
                let error = migrate_v0_3_problem_ir_to_v0_4(&mut value)
                    .expect_err("explicit hmax='auto' must fail closed");
                assert!(
                    error.contains("fem_mesh_policy_unsupported_legacy_control"),
                    "{error}"
                );
                assert!(error.contains(
                    "/problem_meta/runtime_metadata/mesh_workflow/per_geometry/0/maximum_element_size"
                ));
            }
            "boundary_layer_control" => {
                let error = migrate_v0_3_problem_ir_to_v0_4(&mut value)
                    .expect_err("boundary-layer controls must fail closed");
                assert!(error.contains("fem_mesh_policy_unsupported_legacy_control"));
                assert!(error.contains(
                    "/problem_meta/runtime_metadata/mesh_workflow/per_geometry/0/boundary_layer_count"
                ));
            }
            "size_field_control" => {
                let error = migrate_v0_3_problem_ir_to_v0_4(&mut value)
                    .expect_err("size fields must fail closed");
                assert!(error.contains("fem_mesh_policy_unsupported_legacy_control"));
                assert!(error.contains(
                    "/problem_meta/runtime_metadata/mesh_workflow/per_geometry/0/size_fields"
                ));
            }
            other => panic!("unexpected mesh-policy golden case: {other}"),
        }
    }
}

#[test]
fn v0_3_magnet_migrates_to_object_and_magnetization_module() {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/golden/problem_ir/bootstrap_v0_3_object_migration.json"
    ))
    .unwrap();

    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();

    assert_eq!(value["ir_version"], "0.4.0");
    assert_eq!(value["objects"].as_array().unwrap().len(), 2);
    assert_eq!(value["magnetization_modules"].as_array().unwrap().len(), 1);
    assert_eq!(
        value["objects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|object| object["name"] == "heavy_metal")
            .unwrap()["type"],
        "antenna"
    );
    assert_eq!(
        value["unresolved"][0]["source_path"],
        "/legacy/ambiguous_reference"
    );
    assert_eq!(
        value["material_assignments"][0]["target"],
        serde_json::json!({"object_id": "obj_free_layer"})
    );
    assert_eq!(
        value["magnetization_modules"][0]["target"],
        serde_json::json!({"object_id": "obj_free_layer"})
    );
    assert_eq!(
        value["material_parameter_fields"][0]["owner_object"],
        "obj_free_layer"
    );
    assert_eq!(
        value["surface_boundary_conditions"][0]["surface"]["object_id"],
        "obj_heavy_metal"
    );
    let problem: ProblemIRV04 = serde_json::from_value(value.clone()).unwrap();
    problem
        .validate()
        .expect("migrated whole-object magnet target must validate");
    let round_trip = serde_json::to_value(problem).unwrap();
    assert_eq!(
        round_trip["surface_boundary_conditions"],
        value["surface_boundary_conditions"]
    );
    assert_eq!(round_trip["unresolved"], value["unresolved"]);
    assert!(value.get("magnets").is_none());
}

#[test]
fn v0_4_material_assignments_preserve_object_and_region_targets() {
    let mut problem = ProblemIRV04::bootstrap_example();
    problem.object_regions.push(ObjectRegionIR {
        region_id: "core".into(),
        owner_object: "obj_strip".into(),
        name: "Core".into(),
        shape: RegionShapeIR::Box {
            size: [1.0, 1.0, 1.0],
            center: [0.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        realization_policy: RegionRealizationPolicyIR::Inherit,
        material_transition: None,
    });
    problem
        .material_assignments
        .push(ObjectMaterialAssignmentIR::new(
            "assignment_region_level",
            RegionRefIR {
                object_id: "obj_strip".into(),
                region_id: Some("core".into()),
            },
            "Py",
        ));

    let value = serde_json::to_value(problem).unwrap();
    assert_eq!(
        value["material_assignments"][0]["target"],
        serde_json::json!({"object_id": "obj_strip"})
    );
    assert_eq!(
        value["material_assignments"][1]["target"],
        serde_json::json!({"object_id": "obj_strip", "region_id": "core"})
    );
}

#[test]
fn v0_4_validation_rejects_reference_and_identity_errors_without_type_heuristics() {
    let mut problem = ProblemIRV04::bootstrap_example();
    problem.objects[0].object_id = "duplicate".into();
    problem.objects.push(PhysicsObjectIR::new(
        "duplicate",
        "strip",
        PhysicsObjectTypeIR::Conductor,
        "missing_geometry",
    ));
    problem
        .material_assignments
        .push(ObjectMaterialAssignmentIR::new(
            "assignment",
            RegionRefIR {
                object_id: "missing_object".into(),
                region_id: None,
            },
            "missing_material",
        ));
    problem.interfaces.push(PhysicsInterfaceIR::new(
        "interface",
        "same owner",
        SurfaceRefIR {
            object_id: "duplicate".into(),
            surface_id: "top".into(),
            orientation: [0.0, 0.0, 1.0],
        },
        SurfaceRefIR {
            object_id: "duplicate".into(),
            surface_id: "bottom".into(),
            orientation: [0.0, 0.0, -1.0],
        },
        [0.0, 0.0, 1.0],
    ));
    problem
        .material_assignments
        .push(problem.material_assignments[0].clone());
    problem.interfaces.push(problem.interfaces[0].clone());
    problem.magnetization_modules[0].target.object_id = "missing_module_target".into();
    problem.magnetization_modules[0].material_id = "missing_module_material".into();

    let errors = problem
        .validate()
        .expect_err("invalid V04 problem must fail");
    let joined = errors.join("\n");
    assert!(joined.contains("duplicate object_id 'duplicate'"));
    assert!(joined.contains("duplicate name 'strip'"));
    assert!(joined.contains("geometry_id 'missing_geometry' does not exist"));
    assert!(joined.contains("missing target object 'missing_object'"));
    assert!(joined.contains("missing material 'missing_material'"));
    assert!(joined.contains("duplicate assignment_id 'assignment_obj_strip'"));
    assert!(
        joined.contains("magnetization_modules[0] missing target object 'missing_module_target'")
    );
    assert!(joined.contains("magnetization_modules[0] missing material 'missing_module_material'"));
    assert!(joined.contains("interfaces[1].interface_id must be non-empty and unique"));
    assert!(joined.contains("must reference two different object owners"));
}

#[test]
fn v0_3_migration_rejects_missing_geometry_and_identifier_collisions() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/golden/problem_ir/bootstrap_v0_3_object_migration.json"
    ))
    .unwrap();

    let mut missing_geometry = fixture.clone();
    missing_geometry["magnets"][0]["region"] = serde_json::json!("absent");
    assert!(migrate_v0_3_problem_ir_to_v0_4(&mut missing_geometry)
        .expect_err("unresolved magnet region must fail closed")
        .contains("/magnets/0/region"));

    let mut region_missing_geometry: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/golden/problem_ir/bootstrap_v0_3_object_migration.json"
    ))
    .unwrap();
    region_missing_geometry["regions"][0]["geometry"] = serde_json::json!("missing_geometry");
    assert!(
        migrate_v0_3_problem_ir_to_v0_4(&mut region_missing_geometry)
            .expect_err("region geometry must resolve before magnet migration")
            .contains("/regions/0/geometry")
    );

    let mut collision = fixture;
    collision["geometry"]["entries"] = serde_json::json!([
        {"kind": "box", "name": "free_layer", "size": [1.0, 1.0, 1.0]},
        {"kind": "box", "name": "free_layer", "size": [2.0, 1.0, 1.0]}
    ]);
    assert!(migrate_v0_3_problem_ir_to_v0_4(&mut collision)
        .expect_err("ambiguous geometry identity must fail closed")
        .contains("/geometry/entries/1/name"));

    let mut name_collision: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/golden/problem_ir/bootstrap_v0_3_object_migration.json"
    ))
    .unwrap();
    let duplicate_magnet = name_collision["magnets"][0].clone();
    name_collision["magnets"]
        .as_array_mut()
        .unwrap()
        .push(duplicate_magnet);
    assert!(migrate_v0_3_problem_ir_to_v0_4(&mut name_collision)
        .expect_err("legacy name collision must fail closed")
        .contains("/magnets/1/name"));
}

#[test]
fn v0_3_mesh_workflow_migrates_once_into_v0_4_requested_policy() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["problem_meta"]["runtime_metadata"]["mesh_workflow"] = serde_json::json!({
        "per_geometry": [{
            "geometry": "strip",
            "maximum_element_size": 3e-9,
            "minimum_element_size": 1e-9,
            "order": 1,
            "mesh_strategy": "swept_prism",
            "through_thickness_elements": 3,
            "through_thickness_distribution": "fixed",
            "through_thickness_element_ratio": 1.0,
            "through_thickness_symmetric": false,
            "sweep_face_meshing": "triangular",
            "sweep_direction": "auto",
            "element_family": "prism",
            "transition_policy": "pyramid_to_tetrahedra",
            "exact_layer_count": true,
            "interface_hmax": 2e-9,
            "interface_thickness": 2e-9
        }],
        "airbox": {
            "grading": "geometric",
            "minimum_element_size": 2e-9,
            "maximum_element_size": 20e-9,
            "transition_distance": 80e-9,
            "maximum_element_growth_rate": 1.3
        }
    });

    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
    let migration_fingerprint = value["problem_meta"]["runtime_metadata"]["mesh_policy_migration"]
        ["requested_policy_fingerprint"]
        .as_str()
        .unwrap()
        .to_string();
    let decoded: ProblemIRV04 = serde_json::from_value(value).unwrap();
    let policy = decoded
        .mesh_semantics
        .as_ref()
        .and_then(|semantics| semantics.requested_policy.as_ref())
        .expect("legacy workflow must migrate to typed requested policy");
    policy.validate().unwrap();
    assert_eq!(policy.geometric_element_order, 1);
    assert_eq!(policy.materials[0].target.object_id, "obj_strip");
    assert_eq!(policy.sweeps[0].requested_axis, FemSweepAxisIR::Auto);
    assert_eq!(policy.sweeps[0].family_intent, FemElementFamilyIR::Prism6);
    assert_eq!(policy.policy_fingerprint().unwrap(), migration_fingerprint);
}

#[test]
fn v0_3_real_mesh_workflow_shape_preserves_policy_without_silent_defaults() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["problem_meta"]["runtime_metadata"]["study_universe"] = serde_json::json!({
        "mode": "manual",
        "size": [300e-9, 220e-9, 180e-9],
        "center": [0.0, 0.0, 0.0],
        "airbox_hmax": 40e-9,
        "airbox_hmin": 2e-9,
        "airbox_growth_rate": 1.3,
        "airbox_grading": "auto"
    });
    value["problem_meta"]["runtime_metadata"]["mesh_workflow"] = serde_json::json!({
        "explicit_mesh_api": true,
        "build_requested": true,
        "build_target": "domain",
        "fem": {"order": 1, "hmax": 4e-9},
        "mesh_options": {
            "maximum_element_size": 4e-9,
            "minimum_element_size": 1e-9,
            "maximum_element_growth_rate": 1.4,
            "curvature_factor": 0.25,
            "narrow_region_resolution": 2e-9,
            "compute_quality": true,
            "per_element_quality": true
        },
        "default_mesh": {
            "order": 1,
            "mesh_strategy": "free_tetrahedral"
        },
        "per_geometry": [{
            "geometry": "strip",
            "mode": "inherit",
            "interface_hmax": 2e-9,
            "interface_thickness": 2e-9,
            "transition_distance": "airbox_boundary",
            "edge_hmax": 1.5e-9,
            "edge_thickness": 2e-9,
            "edge_transition_distance": "airbox_boundary"
        }]
    });

    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
    let migration_fingerprint = value["problem_meta"]["runtime_metadata"]["mesh_policy_migration"]
        ["requested_policy_fingerprint"]
        .as_str()
        .unwrap()
        .to_string();
    let decoded: ProblemIRV04 = serde_json::from_value(value).unwrap();
    decoded.validate().unwrap();
    let policy = decoded.fem_mesh_policy().unwrap();
    let material = &policy.materials[0];
    assert_eq!(
        material.strategy_intent,
        FemMeshStrategyIntentIR::Tetrahedral
    );
    assert_eq!(material.maximum_element_size, Some(4e-9));
    assert_eq!(material.minimum_element_size, Some(1e-9));
    assert_eq!(material.curvature_factor, Some(0.25));
    assert_eq!(material.narrow_region_resolution, Some(2e-9));
    assert_eq!(
        material.edge_transition_distance,
        Some(FemMeshTransitionDistanceIR::Boundary(
            FemMeshTransitionBoundaryIR::AirboxBoundary
        ))
    );
    assert_eq!(
        policy.interfaces[0].transition_distance,
        Some(FemMeshTransitionDistanceIR::Boundary(
            FemMeshTransitionBoundaryIR::AirboxBoundary
        ))
    );
    let airbox = policy.airbox.as_ref().unwrap();
    assert_eq!(airbox.law, FemAirboxGradingLawIR::Geometric);
    assert_eq!(airbox.near_element_size, Some(2e-9));
    assert_eq!(airbox.far_element_size, 40e-9);
    assert_eq!(airbox.element_ratio, Some(1.3));
    assert_eq!(
        airbox.transition_distance,
        Some(FemMeshTransitionDistanceIR::Boundary(
            FemMeshTransitionBoundaryIR::AirboxBoundary
        ))
    );
    assert_eq!(policy.growth.as_ref().unwrap().max_neighbor_ratio, 1.3);
    assert_eq!(
        policy.growth.as_ref().unwrap().cell_size_definition_id,
        CELL_MAX_EDGE_SIZE_DEFINITION_ID
    );
    let quality = policy.quality.as_ref().unwrap();
    assert!(quality.compute_summary);
    assert!(quality.per_element);
    assert_eq!(policy.policy_fingerprint().unwrap(), migration_fingerprint);
}

#[test]
fn v0_3_study_universe_airbox_migrates_without_mesh_workflow() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["problem_meta"]["runtime_metadata"]["study_universe"] = serde_json::json!({
        "mode": "manual",
        "size": [300e-9, 220e-9, 180e-9],
        "center": [0.0, 0.0, 0.0],
        "airbox_hmax": 40e-9,
        "airbox_hmin": 2e-9,
        "airbox_growth_rate": 1.3,
        "airbox_grading": "geometric"
    });
    value["problem_meta"]["runtime_metadata"]
        .as_object_mut()
        .unwrap()
        .remove("mesh_workflow");

    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
    let decoded: ProblemIRV04 = serde_json::from_value(value.clone()).unwrap();
    decoded.validate().unwrap();
    let airbox = decoded.fem_mesh_policy().unwrap().airbox.as_ref().unwrap();
    assert_eq!(airbox.law, FemAirboxGradingLawIR::Geometric);
    assert_eq!(airbox.near_element_size, Some(2e-9));
    assert_eq!(airbox.far_element_size, 40e-9);
    assert_eq!(airbox.element_ratio, Some(1.3));
    assert_eq!(
        value["problem_meta"]["runtime_metadata"]["mesh_policy_migration"]["source_path"],
        "/problem_meta/runtime_metadata/study_universe"
    );
    assert_eq!(
        value["problem_meta"]["runtime_metadata"]["mesh_policy_migration"]["source_paths"],
        serde_json::json!(["/problem_meta/runtime_metadata/study_universe"])
    );
    assert!(
        value["problem_meta"]["runtime_metadata"]["mesh_policy_migration"]["source_fingerprint"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    assert_eq!(
        value["problem_meta"]["runtime_metadata"]["mesh_policy_migration"]["resolver_version"],
        "fem_mesh_policy_v03_adapter.v1"
    );
}

#[test]
fn v0_3_global_material_controls_apply_without_per_geometry_entries() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["problem_meta"]["runtime_metadata"]["mesh_workflow"] = serde_json::json!({
        "default_mesh": {
            "order": 1,
            "mesh_strategy": "free_tetrahedral",
            "maximum_element_size": 4e-9,
            "minimum_element_size": 1e-9
        }
    });

    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
    let problem: ProblemIRV04 = serde_json::from_value(value).unwrap();
    let policy = problem.fem_mesh_policy().unwrap();
    assert_eq!(policy.materials.len(), 1);
    assert_eq!(policy.materials[0].target.object_id, "obj_strip");
    assert_eq!(policy.materials[0].maximum_element_size, Some(4e-9));
    assert_eq!(policy.materials[0].minimum_element_size, Some(1e-9));
}

#[test]
fn v0_3_thin_film_layer_controls_migrate_as_tet4_layer_policy() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["problem_meta"]["runtime_metadata"]["mesh_workflow"] = serde_json::json!({
        "per_geometry": [{
            "geometry": "strip",
            "mode": "custom",
            "order": 1,
            "mesh_strategy": "thin_film_tetrahedral",
            "topology": "tetrahedral",
            "through_thickness_elements": 3,
            "through_thickness_distribution": "fixed",
            "through_thickness_element_ratio": 1.0,
            "through_thickness_symmetric": false,
            "sweep_face_meshing": "triangular",
            "exact_layer_count": true
        }]
    });

    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
    let problem: ProblemIRV04 = serde_json::from_value(value).unwrap();
    let policy = problem.fem_mesh_policy().unwrap();
    assert_eq!(policy.sweeps.len(), 1);
    assert_eq!(policy.sweeps[0].family_intent, FemElementFamilyIR::Tet4);
    assert_eq!(policy.sweeps[0].transition, FemTransitionPolicyIR::Reject);
    assert_eq!(policy.sweeps[0].layers, 3);
    assert!(policy.sweeps[0].exact_layers);
}

#[test]
fn v0_3_migration_rejects_unrepresentable_or_symbolic_mesh_controls() {
    for (case_id, workflow, expected_path) in [
        (
            "boundary_layer",
            serde_json::json!({
                "per_geometry": [{
                    "geometry": "strip",
                    "mesh_strategy": "free_tetrahedral",
                    "boundary_layer_count": 2
                }]
            }),
            "/problem_meta/runtime_metadata/mesh_workflow/per_geometry/0/boundary_layer_count",
        ),
        (
            "symbolic_auto",
            serde_json::json!({
                "per_geometry": [{
                    "geometry": "strip",
                    "mesh_strategy": "free_tetrahedral",
                    "maximum_element_size": "auto"
                }]
            }),
            "/problem_meta/runtime_metadata/mesh_workflow/per_geometry/0/maximum_element_size",
        ),
    ] {
        let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
        value["problem_meta"]["runtime_metadata"]["mesh_workflow"] = workflow;
        let error = migrate_v0_3_problem_ir_to_v0_4(&mut value).expect_err(case_id);
        assert!(
            error.contains("fem_mesh_policy_unsupported_legacy_control"),
            "{case_id}: {error}"
        );
        assert!(error.contains(expected_path), "{case_id}: {error}");
    }
}

#[test]
fn v0_3_rejects_typed_v0_4_policy_even_without_legacy_workflow() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["mesh_semantics"] = serde_json::json!({
        "requested_policy": {
            "schema_version": "fem_mesh_policy.v1",
            "geometric_element_order": 1,
            "materials": [],
            "interfaces": [],
            "sweeps": []
        }
    });
    value["problem_meta"]["runtime_metadata"]
        .as_object_mut()
        .unwrap()
        .remove("mesh_workflow");
    value["problem_meta"]["runtime_metadata"]
        .as_object_mut()
        .unwrap()
        .remove("study_universe");

    let error = migrate_v0_3_problem_ir_to_v0_4(&mut value)
        .expect_err("mixed V03/V04 mesh policy must fail closed");
    assert!(error.contains("/mesh_semantics/requested_policy"));
}

#[test]
fn v0_3_fem_hint_p2_fails_without_per_geometry_entries() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["problem_meta"]["runtime_metadata"]["mesh_workflow"] = serde_json::json!({
        "fem": {"order": 2, "hmax": 4e-9}
    });

    let error = migrate_v0_3_problem_ir_to_v0_4(&mut value)
        .expect_err("flat FEM P2 hint must fail before Gmsh");
    assert!(error.contains("fem_mesh_policy_unsupported_element_order"));
    assert!(error.contains("/mesh_semantics/requested_policy/geometric_element_order"));
}

#[test]
fn v0_3_flat_mesh_options_do_not_bleed_first_object_controls_into_other_objects() {
    let mut value: serde_json::Value = serde_json::from_str(include_str!(
        "../../../tests/golden/problem_ir/bootstrap_v0_3_object_migration.json"
    ))
    .unwrap();
    value["problem_meta"]["runtime_metadata"]["mesh_workflow"] = serde_json::json!({
        "mesh_options": {"maximum_element_size": 99e-9},
        "per_geometry": [
            {
                "geometry": "free_layer",
                "mode": "custom",
                "mesh_strategy": "free_tetrahedral",
                "maximum_element_size": 4e-9
            },
            {
                "geometry": "heavy_metal",
                "mode": "custom",
                "mesh_strategy": "free_tetrahedral",
                "minimum_element_size": 1e-9
            }
        ]
    });

    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
    let problem: ProblemIRV04 = serde_json::from_value(value).unwrap();
    let policy = problem.fem_mesh_policy().unwrap();
    let free_layer = policy
        .materials
        .iter()
        .find(|material| material.target.object_id == "obj_free_layer")
        .unwrap();
    let heavy_metal = policy
        .materials
        .iter()
        .find(|material| material.target.object_id == "obj_heavy_metal")
        .unwrap();
    assert_eq!(free_layer.maximum_element_size, Some(4e-9));
    assert_eq!(heavy_metal.maximum_element_size, None);
    assert_eq!(heavy_metal.minimum_element_size, Some(1e-9));
}

#[test]
fn v0_4_execution_policy_and_fingerprint_ignore_legacy_extensions() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["problem_meta"]["runtime_metadata"]["mesh_workflow"] = serde_json::json!({
        "per_geometry": [{
            "geometry": "strip",
            "maximum_element_size": 3e-9,
            "order": 1,
            "mesh_strategy": "thin_film_tetrahedral"
        }],
        "retained_unknown": {"future": true}
    });
    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();
    value["unknown_retained_extension"] = serde_json::json!({"opaque": 1});

    let first: ProblemIRV04 = serde_json::from_value(value.clone()).unwrap();
    let first_policy = first.fem_mesh_policy().unwrap();
    let first_fingerprint = first_policy.policy_fingerprint().unwrap();
    let migration_source_snapshot = value["problem_meta"]["runtime_metadata"]
        ["mesh_policy_migration"]["source_snapshot"]
        .clone();

    value["problem_meta"]["runtime_metadata"]["mesh_workflow"] =
        serde_json::json!({"unrelated": "changed after migration"});
    value["unknown_retained_extension"] = serde_json::json!({"opaque": 2});
    let second: ProblemIRV04 = serde_json::from_value(value).unwrap();
    let second_policy = second.fem_mesh_policy().unwrap();

    assert_eq!(second_policy, first_policy);
    assert_eq!(
        second_policy.policy_fingerprint().unwrap(),
        first_fingerprint
    );
    assert_eq!(
        second.problem_meta.runtime_metadata["mesh_policy_migration"]["source_snapshot"],
        migration_source_snapshot
    );
}

#[test]
fn migrated_p2_geometric_element_order_fails_without_downgrade() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value["problem_meta"]["runtime_metadata"]["mesh_workflow"] = serde_json::json!({
        "per_geometry": [{
            "geometry": "strip",
            "maximum_element_size": 3e-9,
            "order": 2,
            "mesh_strategy": "thin_film_tetrahedral"
        }]
    });

    let error = migrate_v0_3_problem_ir_to_v0_4(&mut value)
        .expect_err("P2 geometry must fail during migration without downgrade");
    assert!(error.contains("fem_mesh_policy_unsupported_element_order"));
    assert!(error.contains("/mesh_semantics/requested_policy/geometric_element_order"));
}

#[test]
fn v0_3_mesh_aliases_reject_malformed_or_conflicting_present_values() {
    for (case_id, hmax, expected_path) in [
        (
            "malformed_alias",
            serde_json::json!("3 nm"),
            "/problem_meta/runtime_metadata/mesh_workflow/per_geometry/0/hmax",
        ),
        (
            "conflicting_alias",
            serde_json::json!(4e-9),
            "/problem_meta/runtime_metadata/mesh_workflow/per_geometry/0/hmax",
        ),
    ] {
        let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
        value["problem_meta"]["runtime_metadata"]["mesh_workflow"] = serde_json::json!({
            "per_geometry": [{
                "geometry": "strip",
                "maximum_element_size": 3e-9,
                "hmax": hmax,
                "order": 1,
                "mesh_strategy": "free_tetrahedral"
            }]
        });
        let error = migrate_v0_3_problem_ir_to_v0_4(&mut value).expect_err(case_id);
        assert!(error.contains(expected_path), "{case_id}: {error}");
    }
}
