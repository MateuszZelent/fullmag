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
        serde_json::json!({"object_id": "obj_free_layer", "region_id": "free_layer"})
    );
    assert_eq!(
        value["magnetization_modules"][0]["target"],
        serde_json::json!({"object_id": "obj_free_layer", "region_id": "free_layer"})
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
    problem
        .material_assignments
        .push(ObjectMaterialAssignmentIR::new(
            "assignment_object_level",
            RegionRefIR {
                object_id: "obj_strip".into(),
                region_id: None,
            },
            "Py",
        ));

    let value = serde_json::to_value(problem).unwrap();
    assert_eq!(
        value["material_assignments"][0]["target"],
        serde_json::json!({"object_id": "obj_strip", "region_id": "strip"})
    );
    assert_eq!(
        value["material_assignments"][1]["target"],
        serde_json::json!({"object_id": "obj_strip"})
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
