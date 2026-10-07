use fullmag_ir::waveguide_mesh::{WaveguideCrossSectionMeshIR, WaveguideCrossSectionRegionIR};
use fullmag_ir::{
    migrate_v0_3_problem_ir_to_v0_4, GeometryEntryIR, MaterialIR, ObjectRegionIR, PhysicsObjectIR,
    PhysicsObjectTypeIR, ProblemIR, ProblemIRV04, RegionFrameIR, RegionIR,
    RegionRealizationPolicyIR, RegionShapeIR, SpatialRepresentationIR, StudyIRV04,
};
use serde_json::{json, Value};

const RAW_MESH_FIXTURE: &str = include_str!("fixtures/waveguide_cross_section_mesh.v1.json");
const AIR_GEOMETRY_ID: &str = "geometry-waveguide-air";
const AIR_OBJECT_ID: &str = "object-waveguide-air";
const CORE_REGION_ID: &str = "object-region-core";
const AIR_REGION_ID: &str = "object-region-air";

fn full_3d() -> Value {
    json!({ "kind": "full_3d" })
}

fn eigenmodes_v04(spatial_representation: Value, legacy_magnetostatic_bc: Option<Value>) -> Value {
    let mut study = json!({
        "kind": "eigenmodes",
        "dynamics": {
            "kind": "llg",
            "gyromagnetic_ratio": 221100.0,
            "integrator": "auto"
        },
        "operator": { "kind": "linearized_llg", "include_demag": true },
        "count": 1,
        "target": { "kind": "lowest" },
        "equilibrium": { "kind": "provided" },
        "k_sampling": { "kind": "single", "k_vector": [0.0, 0.0, 0.0] },
        "normalization": "unit_l2",
        "damping_policy": "ignore",
        "magnetostatic_bc": "open",
        "sampling": { "outputs": [] },
        "spatial_representation": spatial_representation
    });
    if let Some(boundary_condition) = legacy_magnetostatic_bc {
        study["magnetostatic_bc"] = boundary_condition;
    } else {
        study.as_object_mut().unwrap().remove("magnetostatic_bc");
    }
    study
}

fn frequency_response_v04(
    spatial_representation: Value,
    legacy_magnetostatic_bc: Option<Value>,
) -> Value {
    let mut study = json!({
        "kind": "frequency_response",
        "dynamics": {
            "kind": "llg",
            "gyromagnetic_ratio": 221100.0,
            "integrator": "auto"
        },
        "operator": { "kind": "linearized_llg", "include_demag": true },
        "equilibrium": { "kind": "provided" },
        "k_sampling": { "kind": "single", "k_vector": [0.0, 0.0, 0.0] },
        "normalization": "unit_l2",
        "damping_policy": "include",
        "magnetostatic_bc": "open",
        "excitation": {
            "field_au_per_m": [0.0, 0.0, 1.0],
            "phase_rad": 0.0
        },
        "frequencies_hz": { "values_hz": [1000000000.0, 2000000000.0] },
        "sampling": { "outputs": [] },
        "spatial_representation": spatial_representation
    });
    if let Some(boundary_condition) = legacy_magnetostatic_bc {
        study["magnetostatic_bc"] = boundary_condition;
    } else {
        study.as_object_mut().unwrap().remove("magnetostatic_bc");
    }
    study
}

fn problem_value_with_study(study: Value) -> Value {
    let mut value = serde_json::to_value(ProblemIRV04::bootstrap_example()).unwrap();
    value["study"] = study;
    value
}

fn waveguide_problem_value() -> Value {
    let mut problem = ProblemIRV04::bootstrap_example();
    let core_object_id = problem.objects[0].object_id.clone();
    let material_id = problem.materials[0].name.clone();

    problem.geometry.entries.push(GeometryEntryIR::Box {
        name: AIR_GEOMETRY_ID.to_string(),
        size: [1.0, 1.0, 1.0],
    });
    problem.regions.push(RegionIR {
        name: "waveguide-air".to_string(),
        geometry: AIR_GEOMETRY_ID.to_string(),
    });
    problem.objects.push(PhysicsObjectIR::new(
        AIR_OBJECT_ID,
        "waveguide-air",
        PhysicsObjectTypeIR::Geometry,
        AIR_GEOMETRY_ID,
    ));

    for (region_id, owner_object, name) in [
        (CORE_REGION_ID, core_object_id.as_str(), "waveguide-core"),
        (AIR_REGION_ID, AIR_OBJECT_ID, "waveguide-air-region"),
    ] {
        problem.object_regions.push(ObjectRegionIR {
            region_id: region_id.to_string(),
            owner_object: owner_object.to_string(),
            name: name.to_string(),
            shape: RegionShapeIR::Box {
                size: [1.0, 1.0, 1.0],
                center: [0.0, 0.0, 0.0],
            },
            frame: RegionFrameIR::default(),
            enabled: true,
            priority: 0,
            mesh_policy: None,
            material_overrides: Vec::new(),
            texture_override: None,
            realization_policy: RegionRealizationPolicyIR::default(),
            material_transition: None,
        });
    }

    let mut mesh: WaveguideCrossSectionMeshIR = serde_json::from_str(RAW_MESH_FIXTURE).unwrap();
    for region in &mut mesh.regions {
        match region {
            WaveguideCrossSectionRegionIR::Magnetic {
                object_id,
                material_id: mesh_material_id,
                ..
            } => {
                *object_id = core_object_id.clone();
                *mesh_material_id = material_id.clone();
            }
            WaveguideCrossSectionRegionIR::Air { object_id, .. } => {
                *object_id = AIR_OBJECT_ID.to_string();
            }
        }
    }
    let mesh_value = serde_json::to_value(mesh).unwrap();
    let region_targets = json!({
        "region-magnetic": {
            "object_id": core_object_id,
            "region_id": CORE_REGION_ID
        },
        "region-air": {
            "object_id": AIR_OBJECT_ID
        }
    });

    let mut value = serde_json::to_value(problem).unwrap();
    value["study"] = eigenmodes_v04(
        json!({
            "kind": "waveguide_2p5d",
            "frame": {
                "origin_m": [0.0, 0.0, 0.0],
                "e_u": [1.0, 0.0, 0.0],
                "e_v": [0.0, 1.0, 0.0],
                "axis_unit": [0.0, 0.0, 1.0]
            },
            "cross_section_mesh": mesh_value,
            "region_targets": region_targets,
            "magnetostatic_bc": {
                "kind": "finite_air_cross_section_dirichlet",
                "boundary_component_ids": ["boundary-air-outer"]
            }
        }),
        None,
    );
    value
}

fn legacy_eigen_problem_value(boundary_condition: Option<Value>) -> Value {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    let mut study = eigenmodes_v04(full_3d(), boundary_condition);
    study
        .as_object_mut()
        .unwrap()
        .remove("spatial_representation");
    value["study"] = study;
    value
}

fn contains_error(errors: &[String], needle: &str) -> bool {
    errors.iter().any(|error| error.contains(needle))
}

#[test]
fn v04_full3d_eigenmodes_round_trip_with_exact_tag_and_explicit_bc() {
    let value = problem_value_with_study(eigenmodes_v04(full_3d(), Some(json!("open"))));
    let decoded: ProblemIRV04 = serde_json::from_value(value).unwrap();
    let encoded = serde_json::to_value(&decoded).unwrap();

    assert_eq!(
        encoded["study"]["spatial_representation"]["kind"],
        "full_3d"
    );
    assert_eq!(encoded["study"]["magnetostatic_bc"], "open");
    let reparsed: ProblemIRV04 = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(serde_json::to_value(reparsed).unwrap(), encoded);
}

#[test]
fn v04_preserves_all_five_legacy_study_kinds_with_required_spatial_representation() {
    let base = serde_json::to_value(ProblemIRV04::bootstrap_example()).unwrap();
    let studies = [
        base["study"].clone(),
        json!({
            "kind": "relaxation",
            "algorithm": "projected_gradient_bb",
            "dynamics": null,
            "stop": { "max_steps": 100 },
            "sampling": { "outputs": [] },
            "spatial_representation": full_3d()
        }),
        eigenmodes_v04(full_3d(), Some(json!("open"))),
        frequency_response_v04(full_3d(), Some(json!("open"))),
        json!({
            "kind": "hysteresis",
            "sampling": { "outputs": [] },
            "spatial_representation": full_3d()
        }),
    ];

    for study in studies {
        let kind = study["kind"].as_str().unwrap().to_string();
        let decoded: StudyIRV04 = serde_json::from_value(study).unwrap();
        let encoded = serde_json::to_value(&decoded).unwrap();

        assert_eq!(encoded["kind"], kind);
        assert_eq!(encoded["spatial_representation"]["kind"], "full_3d");
        let reparsed: StudyIRV04 = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(serde_json::to_value(reparsed).unwrap(), encoded);
    }
}

#[test]
fn v04_full3d_frequency_response_requires_and_round_trips_explicit_bc() {
    let value = problem_value_with_study(frequency_response_v04(
        full_3d(),
        Some(json!("periodic_airbox_k0")),
    ));
    let decoded: ProblemIRV04 = serde_json::from_value(value).unwrap();
    let encoded = serde_json::to_value(decoded).unwrap();

    assert_eq!(
        encoded["study"]["spatial_representation"]["kind"],
        "full_3d"
    );
    assert_eq!(encoded["study"]["magnetostatic_bc"], "periodic_airbox_k0");
}

#[test]
fn v04_well_shaped_waveguide_round_trip_keeps_region_targets_and_omits_legacy_bc() {
    let value = waveguide_problem_value();
    let decoded: ProblemIRV04 = serde_json::from_value(value).unwrap();
    let encoded = serde_json::to_value(&decoded).unwrap();

    assert_eq!(
        encoded["study"]["spatial_representation"]["kind"],
        "waveguide_2p5d"
    );
    assert_eq!(
        encoded["study"]["spatial_representation"]["magnetostatic_bc"]["kind"],
        "finite_air_cross_section_dirichlet"
    );
    assert_eq!(
        encoded["study"]["spatial_representation"]["region_targets"]["region-magnetic"]
            ["region_id"],
        CORE_REGION_ID
    );
    assert!(
        encoded["study"]["spatial_representation"]["region_targets"]["region-air"]
            .get("region_id")
            .is_none(),
        "whole-object targets must stay whole-object targets"
    );
    assert!(
        encoded["study"].get("magnetostatic_bc").is_none(),
        "waveguide serialization must omit the legacy spectral BC"
    );

    let reparsed: ProblemIRV04 = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(serde_json::to_value(reparsed).unwrap(), encoded);
    assert!(decoded.validate().is_ok());
    assert_eq!(
        decoded
            .study
            .checked_execution_representation_availability()
            .unwrap_err()
            .to_string(),
        "waveguide_2p5d_unavailable"
    );
}

#[test]
fn waveguide_signed_global_k_control_points_round_trip_and_validate() {
    for k_vector in [[0.0, 0.0, -2.5], [0.0, 0.0, 2.5]] {
        let mut value = waveguide_problem_value();
        value["study"]["k_sampling"]["k_vector"] = json!(k_vector);
        let parsed: ProblemIRV04 = serde_json::from_value(value).unwrap();

        assert!(parsed.validate().is_ok());
        let encoded = serde_json::to_value(parsed).unwrap();
        assert_eq!(encoded["study"]["k_sampling"]["k_vector"], json!(k_vector));
    }

    let mut path_value = waveguide_problem_value();
    path_value["study"]["k_sampling"] = json!({
        "kind": "path",
        "points": [
            { "label": "-k", "k_vector": [0.0, 0.0, -2.5] },
            { "label": "+k", "k_vector": [0.0, 0.0, 2.5] }
        ],
        "samples_per_segment": [4],
        "closed": false
    });
    let parsed: ProblemIRV04 = serde_json::from_value(path_value).unwrap();
    assert!(parsed.validate().is_ok());
    let encoded = serde_json::to_value(parsed).unwrap();
    assert_eq!(
        encoded["study"]["k_sampling"]["points"][0]["k_vector"],
        json!([0.0, 0.0, -2.5])
    );
    assert_eq!(
        encoded["study"]["k_sampling"]["points"][1]["k_vector"],
        json!([0.0, 0.0, 2.5])
    );
}

#[test]
fn waveguide_rejects_transverse_k_and_validates_path_cardinality() {
    let mut transverse = waveguide_problem_value();
    transverse["study"]["k_sampling"]["k_vector"] = json!([1.0, 0.0, 0.0]);
    let parsed: ProblemIRV04 = serde_json::from_value(transverse).unwrap();
    assert!(contains_error(
        &parsed.validate().unwrap_err(),
        "WaveVectorNotCollinear"
    ));

    let mut invalid_path = waveguide_problem_value();
    invalid_path["study"]["k_sampling"] = json!({
        "kind": "path",
        "points": [
            { "k_vector": [0.0, 0.0, -2.5] },
            { "k_vector": [0.0, 0.0, 2.5] }
        ],
        "samples_per_segment": [],
        "closed": false
    });
    let parsed: ProblemIRV04 = serde_json::from_value(invalid_path).unwrap();
    assert!(contains_error(
        &parsed.validate().unwrap_err(),
        "expected 1 samples_per_segment entries, got 0"
    ));
}

#[test]
fn waveguide_rejects_world_coordinate_collapse_after_frame_and_bc_bindings() {
    let mut value = waveguide_problem_value();
    value["study"]["spatial_representation"]["frame"]["origin_m"] = json!([1.0e308, 0.0, 0.0]);
    let parsed: ProblemIRV04 = serde_json::from_value(value).unwrap();

    let errors = parsed.validate().unwrap_err();

    assert!(contains_error(&errors, "DuplicateWorldNodeCoordinates"));
}

#[test]
fn v04_root_unknown_extensions_survive_typed_study_round_trip() {
    let mut value = problem_value_with_study(eigenmodes_v04(full_3d(), Some(json!("open"))));
    value["legacy_marker"] = json!({ "preserved": true });
    let decoded: ProblemIRV04 = serde_json::from_value(value).unwrap();
    assert_eq!(
        serde_json::to_value(decoded).unwrap()["legacy_marker"],
        json!({ "preserved": true })
    );
}

#[test]
fn v04_study_and_spatial_unknown_fields_return_json_pointers() {
    let mut study_unknown =
        problem_value_with_study(eigenmodes_v04(full_3d(), Some(json!("open"))));
    study_unknown["study"]["future_field"] = json!(true);
    let error = serde_json::from_value::<ProblemIRV04>(study_unknown)
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/future_field"));

    let mut spatial_unknown =
        problem_value_with_study(eigenmodes_v04(full_3d(), Some(json!("open"))));
    spatial_unknown["study"]["spatial_representation"]["future_field"] = json!(true);
    let error = serde_json::from_value::<ProblemIRV04>(spatial_unknown)
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/spatial_representation/future_field"));

    let mut mesh_unknown = waveguide_problem_value();
    mesh_unknown["study"]["spatial_representation"]["cross_section_mesh"]["triangles"][0]
        ["future_field"] = json!(true);
    let error = serde_json::from_value::<ProblemIRV04>(mesh_unknown)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("/study/spatial_representation/cross_section_mesh/triangles/0/future_field")
    );
}

#[test]
fn v04_missing_null_and_unknown_spatial_kinds_are_pointer_qualified() {
    let mut missing = problem_value_with_study(eigenmodes_v04(full_3d(), Some(json!("open"))));
    missing["study"]
        .as_object_mut()
        .unwrap()
        .remove("spatial_representation");
    let error = serde_json::from_value::<ProblemIRV04>(missing)
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/spatial_representation"));

    let mut null = problem_value_with_study(eigenmodes_v04(Value::Null, Some(json!("open"))));
    let error = serde_json::from_value::<ProblemIRV04>(null.take())
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/spatial_representation"));

    let mut unknown = problem_value_with_study(eigenmodes_v04(
        json!({ "kind": "future_space" }),
        Some(json!("open")),
    ));
    let error = serde_json::from_value::<ProblemIRV04>(unknown.take())
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/spatial_representation/kind"));
}

#[test]
fn full3d_spectral_studies_reject_missing_or_null_legacy_bc() {
    for make_study in [
        eigenmodes_v04 as fn(Value, Option<Value>) -> Value,
        frequency_response_v04 as fn(Value, Option<Value>) -> Value,
    ] {
        let missing = problem_value_with_study(make_study(full_3d(), None));
        let error = serde_json::from_value::<ProblemIRV04>(missing)
            .unwrap_err()
            .to_string();
        assert!(error.contains("/study/magnetostatic_bc"));

        let null = problem_value_with_study(make_study(full_3d(), Some(Value::Null)));
        let error = serde_json::from_value::<ProblemIRV04>(null)
            .unwrap_err()
            .to_string();
        assert!(error.contains("/study/magnetostatic_bc"));
    }
}

#[test]
fn waveguide_rejects_absent_and_null_distinctly_from_full3d_bc() {
    let absent: ProblemIRV04 = serde_json::from_value(waveguide_problem_value()).unwrap();
    let spatial = absent.study.spatial_representation();
    assert!(matches!(
        spatial,
        SpatialRepresentationIR::Waveguide2p5d { .. }
    ));

    let mut explicit_null = waveguide_problem_value();
    explicit_null["study"]["magnetostatic_bc"] = Value::Null;
    let error = serde_json::from_value::<ProblemIRV04>(explicit_null)
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/magnetostatic_bc"));
}

#[test]
fn direct_study_wire_retains_conditional_bc_presence_rules() {
    let missing_full3d: StudyIRV04 =
        serde_json::from_value(eigenmodes_v04(full_3d(), None)).unwrap();
    assert!(contains_error(
        &missing_full3d.validate().unwrap_err(),
        "magnetostatic_bc is required"
    ));

    let null_bc =
        serde_json::from_value::<StudyIRV04>(eigenmodes_v04(full_3d(), Some(Value::Null)));
    assert!(
        null_bc.is_err(),
        "explicit null must not deserialize as absence"
    );

    let waveguide_value = waveguide_problem_value()["study"].clone();
    let waveguide: StudyIRV04 = serde_json::from_value(waveguide_value.clone()).unwrap();
    assert!(waveguide.validate().is_ok());

    let mut waveguide_null = waveguide_value.clone();
    waveguide_null["magnetostatic_bc"] = Value::Null;
    assert!(serde_json::from_value::<StudyIRV04>(waveguide_null).is_err());

    let mut waveguide_conflict = waveguide_value;
    waveguide_conflict["magnetostatic_bc"] = json!("open");
    let waveguide_conflict: StudyIRV04 = serde_json::from_value(waveguide_conflict).unwrap();
    assert!(contains_error(
        &waveguide_conflict.validate().unwrap_err(),
        "must be absent for waveguide_2p5d"
    ));

    let non_eigen_waveguide = frequency_response_v04(
        waveguide_problem_value()["study"]["spatial_representation"].clone(),
        None,
    );
    let non_eigen: StudyIRV04 = serde_json::from_value(non_eigen_waveguide).unwrap();
    assert!(contains_error(
        &non_eigen.validate().unwrap_err(),
        "supported only for eigenmodes"
    ));
}

#[test]
fn non_eigen_study_rejects_waveguide_at_problem_reader() {
    let mut value = serde_json::to_value(ProblemIRV04::bootstrap_example()).unwrap();
    value["study"]["spatial_representation"] =
        waveguide_problem_value()["study"]["spatial_representation"].clone();
    let error = serde_json::from_value::<ProblemIRV04>(value)
        .unwrap_err()
        .to_string();
    assert!(error.contains("supported only for eigenmodes"));
}

#[test]
fn waveguide_spatial_variant_fields_are_required_and_non_null() {
    for field in [
        "frame",
        "cross_section_mesh",
        "region_targets",
        "magnetostatic_bc",
    ] {
        let mut missing = waveguide_problem_value();
        missing["study"]["spatial_representation"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        let error = serde_json::from_value::<ProblemIRV04>(missing)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!("/study/spatial_representation/{field}")),
            "{field}: {error}"
        );

        let mut null = waveguide_problem_value();
        null["study"]["spatial_representation"][field] = Value::Null;
        let error = serde_json::from_value::<ProblemIRV04>(null)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!("/study/spatial_representation/{field}")),
            "{field}: {error}"
        );
    }
}

#[test]
fn waveguide_boundary_selection_requires_non_null_typed_fields() {
    let mut missing = waveguide_problem_value();
    missing["study"]["spatial_representation"]["magnetostatic_bc"]
        .as_object_mut()
        .unwrap()
        .remove("boundary_component_ids");
    let error = serde_json::from_value::<ProblemIRV04>(missing)
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/spatial_representation/magnetostatic_bc/boundary_component_ids"));

    let mut null = waveguide_problem_value();
    null["study"]["spatial_representation"]["magnetostatic_bc"]["boundary_component_ids"] =
        Value::Null;
    let error = serde_json::from_value::<ProblemIRV04>(null)
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/spatial_representation/magnetostatic_bc/boundary_component_ids"));

    let mut unknown = waveguide_problem_value();
    unknown["study"]["spatial_representation"]["magnetostatic_bc"]["future_field"] = json!(true);
    let error = serde_json::from_value::<ProblemIRV04>(unknown)
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/spatial_representation/magnetostatic_bc/future_field"));
}

#[test]
fn waveguide_empty_and_duplicate_boundary_selections_fail_real_dirichlet_validation() {
    let mut empty = waveguide_problem_value();
    empty["study"]["spatial_representation"]["magnetostatic_bc"]["boundary_component_ids"] =
        json!([]);
    let parsed: ProblemIRV04 = serde_json::from_value(empty).unwrap();
    assert!(contains_error(
        &parsed.validate().unwrap_err(),
        "EmptySelection"
    ));

    let mut duplicate = waveguide_problem_value();
    duplicate["study"]["spatial_representation"]["magnetostatic_bc"]["boundary_component_ids"] =
        json!(["boundary-air-outer", "boundary-air-outer"]);
    let parsed: ProblemIRV04 = serde_json::from_value(duplicate).unwrap();
    assert!(contains_error(
        &parsed.validate().unwrap_err(),
        "DuplicateBoundaryId"
    ));
}

#[test]
fn waveguide_region_targets_are_required_non_null_and_strict() {
    let mut missing = waveguide_problem_value();
    missing["study"]["spatial_representation"]
        .as_object_mut()
        .unwrap()
        .remove("region_targets");
    let error = serde_json::from_value::<ProblemIRV04>(missing)
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/spatial_representation/region_targets"));

    let mut null = waveguide_problem_value();
    null["study"]["spatial_representation"]["region_targets"] = Value::Null;
    let error = serde_json::from_value::<ProblemIRV04>(null)
        .unwrap_err()
        .to_string();
    assert!(error.contains("/study/spatial_representation/region_targets"));

    let mut unknown = waveguide_problem_value();
    unknown["study"]["spatial_representation"]["region_targets"]["region-magnetic"]
        ["future_field"] = json!(1);
    let error = serde_json::from_value::<ProblemIRV04>(unknown)
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("/study/spatial_representation/region_targets/region-magnetic/future_field")
    );
}

#[test]
fn waveguide_region_targets_require_exact_mesh_coverage() {
    let mut missing = waveguide_problem_value();
    missing["study"]["spatial_representation"]["region_targets"]
        .as_object_mut()
        .unwrap()
        .remove("region-air");
    let parsed: ProblemIRV04 = serde_json::from_value(missing).unwrap();
    assert!(contains_error(
        &parsed.validate().unwrap_err(),
        "RegionTargetKeys"
    ));

    let mut extra = waveguide_problem_value();
    extra["study"]["spatial_representation"]["region_targets"]["unmapped"] =
        json!({ "object_id": AIR_OBJECT_ID });
    let parsed: ProblemIRV04 = serde_json::from_value(extra).unwrap();
    assert!(contains_error(
        &parsed.validate().unwrap_err(),
        "RegionTargetKeys"
    ));
}

#[test]
fn waveguide_region_targets_reject_missing_canonical_targets() {
    let mut value = waveguide_problem_value();
    value["study"]["spatial_representation"]["region_targets"]["region-magnetic"]["region_id"] =
        json!("missing-canonical-region");
    let parsed: ProblemIRV04 = serde_json::from_value(value).unwrap();

    assert!(contains_error(
        &parsed.validate().unwrap_err(),
        "MissingObjectRegion"
    ));
}

#[test]
fn waveguide_unknown_boundary_component_id_is_rejected() {
    let mut value = waveguide_problem_value();
    value["study"]["spatial_representation"]["magnetostatic_bc"]["boundary_component_ids"] =
        json!(["missing-boundary"]);
    let parsed: ProblemIRV04 = serde_json::from_value(value).unwrap();

    assert!(contains_error(
        &parsed.validate().unwrap_err(),
        "MissingBoundaryId"
    ));
}

#[test]
fn waveguide_region_targets_preserve_mesh_object_and_canonical_region_owners() {
    let mut mesh_owner_mismatch = waveguide_problem_value();
    mesh_owner_mismatch["study"]["spatial_representation"]["region_targets"]["region-magnetic"]
        ["object_id"] = json!(AIR_OBJECT_ID);
    let parsed: ProblemIRV04 = serde_json::from_value(mesh_owner_mismatch).unwrap();
    assert!(contains_error(
        &parsed.validate().unwrap_err(),
        "MeshRegionObjectMismatch"
    ));

    let mut canonical_owner_mismatch = waveguide_problem_value();
    canonical_owner_mismatch["study"]["spatial_representation"]["region_targets"]
        ["region-magnetic"]["region_id"] = json!(AIR_REGION_ID);
    let parsed: ProblemIRV04 = serde_json::from_value(canonical_owner_mismatch).unwrap();
    assert!(contains_error(
        &parsed.validate().unwrap_err(),
        "ObjectRegionOwnerMismatch"
    ));
}

#[test]
fn migration_defaults_missing_spectral_bc_to_open_with_versioned_provenance() {
    let mut value = legacy_eigen_problem_value(None);
    value["study"]
        .as_object_mut()
        .unwrap()
        .remove("magnetostatic_bc");

    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();

    assert_eq!(value["ir_version"], "0.4.0");
    assert_eq!(value["problem_meta"]["script_api_version"], "0.4.0");
    assert_eq!(value["problem_meta"]["serializer_version"], "0.4.0");
    assert_eq!(value["study"]["spatial_representation"]["kind"], "full_3d");
    assert_eq!(value["study"]["magnetostatic_bc"], "open");
    let record = &value["problem_meta"]["runtime_metadata"]["spatial_representation_migration"];
    assert_eq!(
        record["schema_version"],
        "fullmag.spatial-representation-migration.v1"
    );
    assert_eq!(record["study_presence"], "present");
    assert_eq!(record["spatial_representation_presence"], "missing");
    assert_eq!(record["spatial_representation"], "full_3d");
    assert_eq!(record["magnetostatic_bc_presence"], "missing");
    assert_eq!(
        record["magnetostatic_bc_provenance"],
        "defaulted_from_missing"
    );

    let decoded: ProblemIRV04 = serde_json::from_value(value).unwrap();
    assert!(decoded.validate().is_ok());
}

#[test]
fn migration_preserves_explicit_spectral_bc_and_records_its_presence() {
    let mut value = legacy_eigen_problem_value(Some(json!("floquet_airbox")));
    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();

    assert_eq!(value["study"]["magnetostatic_bc"], "floquet_airbox");
    let record = &value["problem_meta"]["runtime_metadata"]["spatial_representation_migration"];
    assert_eq!(record["magnetostatic_bc_presence"], "explicit");
    assert_eq!(record["magnetostatic_bc_provenance"], "explicit");
    assert_eq!(record["magnetostatic_bc_value"], "floquet_airbox");
}

#[test]
fn migration_rejects_explicit_null_bc_without_mutating_input() {
    let mut value = legacy_eigen_problem_value(Some(Value::Null));
    value["study"]["magnetostatic_bc"] = Value::Null;
    let original = value.clone();

    let error = migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap_err();

    assert!(error.contains("/study/magnetostatic_bc"));
    assert_eq!(value, original);
}

#[test]
fn migration_bootstraps_absent_study_and_records_that_choice() {
    let mut value = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    value.as_object_mut().unwrap().remove("study");

    migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap();

    let record = &value["problem_meta"]["runtime_metadata"]["spatial_representation_migration"];
    assert_eq!(record["study_presence"], "missing");
    assert_eq!(record["study_source"], "historical_bootstrap");
    assert_eq!(record["study_kind"], "time_evolution");
    assert_eq!(value["study"]["spatial_representation"]["kind"], "full_3d");
}

#[test]
fn migration_rejects_conflicting_record_atomically() {
    let mut value = legacy_eigen_problem_value(Some(json!("open")));
    value["problem_meta"]["runtime_metadata"]["spatial_representation_migration"] =
        json!({ "schema_version": "other" });
    let original = value.clone();

    let error = migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap_err();

    assert!(error.contains("/problem_meta/runtime_metadata/spatial_representation_migration"));
    assert_eq!(value, original);
}

#[test]
fn migration_rejects_inconsistent_versions_before_mutation() {
    let mut value = legacy_eigen_problem_value(Some(json!("open")));
    value["problem_meta"]["serializer_version"] = json!("0.2.0");
    let original = value.clone();

    let error = migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap_err();

    assert!(error.contains("/problem_meta/serializer_version"));
    assert_eq!(value, original);
}

#[test]
fn migration_rejects_study_fields_that_typed_v04_cannot_read_atomically() {
    let mut value = legacy_eigen_problem_value(Some(json!("open")));
    value["study"]["unknown_legacy_field"] = json!(true);
    let original = value.clone();

    let error = migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap_err();

    assert!(error.contains("/study/unknown_legacy_field"));
    assert_eq!(value, original);
}

#[test]
fn v04_validation_reports_inconsistent_root_and_metadata_versions() {
    let mut value = serde_json::to_value(ProblemIRV04::bootstrap_example()).unwrap();
    value["ir_version"] = json!("0.3.0");
    value["problem_meta"]["script_api_version"] = json!("0.3.0");
    let parsed: ProblemIRV04 = serde_json::from_value(value).unwrap();

    let errors = parsed.validate().unwrap_err();

    assert!(contains_error(&errors, "ir_version must be '0.4.0'"));
    assert!(contains_error(
        &errors,
        "script_api_version must be '0.4.0'"
    ));
}

#[test]
fn direct_full3d_availability_is_only_the_legacy_staging_route() {
    let study: StudyIRV04 =
        serde_json::from_value(eigenmodes_v04(full_3d(), Some(json!("open")))).unwrap();
    assert_eq!(
        study
            .checked_execution_representation_availability()
            .unwrap(),
        fullmag_ir::StudyIRV04ExecutionRepresentation::Full3dLegacyStaging
    );
}

#[test]
fn standalone_full3d_decoders_never_discard_extra_spatial_intent() {
    for representation in [
        json!({"kind":"full_3d","future_field":true}),
        json!({"kind":"full_3d","frame":null}),
        json!({"kind":"full_3d","cross_section_mesh":{}}),
    ] {
        assert!(
            serde_json::from_value::<SpatialRepresentationIR>(representation.clone()).is_err(),
            "standalone representation accepted {representation}"
        );
        let study = eigenmodes_v04(representation.clone(), Some(json!("open")));
        assert!(
            serde_json::from_value::<StudyIRV04>(study.clone()).is_err(),
            "standalone study discarded {representation}"
        );
        let error = serde_json::from_value::<ProblemIRV04>(problem_value_with_study(study))
            .unwrap_err()
            .to_string();
        assert!(error.contains("/study/spatial_representation/"));
    }
    let representation: SpatialRepresentationIR = serde_json::from_value(full_3d()).unwrap();
    assert_eq!(serde_json::to_value(representation).unwrap(), full_3d());
}

fn complete_material_v04_value() -> Value {
    let mut material =
        serde_json::to_value(ProblemIRV04::bootstrap_example()).unwrap()["materials"][0].clone();

    material["name"] = json!("strict-material");
    material["saturation_magnetisation"] = json!(8.0e5);
    material["exchange_stiffness"] = json!(1.3e-11);
    material["damping"] = json!(0.02);
    material["uniaxial_anisotropy"] = json!(4.1e5);
    material["uniaxial_anisotropy_k2"] = json!(-2.3e3);
    material["anisotropy_axis"] = json!([0.0, 0.6, 0.8]);
    material["cubic_anisotropy_kc1"] = json!(1.1e3);
    material["cubic_anisotropy_kc2"] = json!(-2.2e3);
    material["cubic_anisotropy_kc3"] = json!(3.3e3);
    material["cubic_anisotropy_axis1"] = json!([1.0, 0.0, 0.0]);
    material["cubic_anisotropy_axis2"] = json!([0.0, 1.0, 0.0]);
    material["ms_field"] = json!([8.0e5, 7.9e5]);
    material["a_field"] = json!([1.3e-11, 1.2e-11]);
    material["alpha_field"] = json!([0.02, 0.03]);
    material["ku_field"] = json!([4.1e5, 4.0e5]);
    material["ku2_field"] = json!([-2.3e3, -2.2e3]);
    material["kc1_field"] = json!([1.1e3, 1.0e3]);
    material["kc2_field"] = json!([-2.2e3, -2.1e3]);
    material["kc3_field"] = json!([3.3e3, 3.2e3]);
    material["interfacial_dmi"] = json!(0.001);
    material["bulk_dmi"] = json!(0.002);
    material["dind_field"] = json!([0.003, 0.004]);
    material["dbulk_field"] = json!([0.005, 0.006]);
    material
}

#[test]
fn v04_material_unknown_physics_fields_are_rejected_without_changing_legacy_decoding() {
    let mut v04 = serde_json::to_value(ProblemIRV04::bootstrap_example()).unwrap();
    let mut material = complete_material_v04_value();
    material["future_dmi_model"] = json!({ "coefficient": 0.25 });
    v04["materials"][0] = material.clone();

    let error = serde_json::from_value::<ProblemIRV04>(v04)
        .unwrap_err()
        .to_string();
    assert!(error.contains("/materials/0"), "{error}");
    assert!(error.contains("future_dmi_model"), "{error}");

    let mut legacy_material = material;
    legacy_material
        .as_object_mut()
        .unwrap()
        .remove("future_dmi_model");
    let mut legacy_problem = serde_json::to_value(ProblemIR::bootstrap_example()).unwrap();
    legacy_problem["materials"][0] = legacy_material.clone();
    legacy_problem["materials"][0]["future_dmi_model"] = json!({ "coefficient": 0.25 });
    let decoded_problem: ProblemIR = serde_json::from_value(legacy_problem).unwrap();
    assert_eq!(decoded_problem.materials[0].name, "strict-material");
    assert_eq!(
        serde_json::to_value(&decoded_problem.materials[0]).unwrap(),
        legacy_material
    );

    let mut legacy_material_with_unknown = legacy_material.clone();
    legacy_material_with_unknown["future_dmi_model"] = json!({ "coefficient": 0.25 });
    let decoded_material: MaterialIR =
        serde_json::from_value(legacy_material_with_unknown).unwrap();
    assert_eq!(
        serde_json::to_value(decoded_material).unwrap(),
        legacy_material
    );
}

#[test]
fn v04_material_unknown_field_error_reports_the_material_array_index() {
    let mut problem = serde_json::to_value(ProblemIRV04::bootstrap_example()).unwrap();
    let mut second_material = complete_material_v04_value();
    second_material["name"] = json!("strict-material-second");
    second_material["future_dmi_model"] = json!({ "coefficient": 0.25 });
    problem["materials"]
        .as_array_mut()
        .unwrap()
        .push(second_material);

    let error = serde_json::from_value::<ProblemIRV04>(problem)
        .unwrap_err()
        .to_string();

    assert!(error.contains("/materials/1"), "{error}");
    assert!(error.contains("future_dmi_model"), "{error}");
}

#[test]
fn v04_material_known_scalar_option_and_node_fields_round_trip_exactly() {
    let mut problem = serde_json::to_value(ProblemIRV04::bootstrap_example()).unwrap();
    let material = complete_material_v04_value();
    problem["materials"][0] = material.clone();

    let decoded: ProblemIRV04 = serde_json::from_value(problem).unwrap();
    let encoded = serde_json::to_value(decoded).unwrap();

    assert_eq!(encoded["materials"][0], material);
}

#[test]
fn v04_material_nullable_and_missing_optional_fields_keep_their_defaults() {
    let mut problem = serde_json::to_value(ProblemIRV04::bootstrap_example()).unwrap();
    let mut material = complete_material_v04_value();
    material["uniaxial_anisotropy"] = Value::Null;
    material["anisotropy_axis"] = Value::Null;

    let missing_optionals = [
        "uniaxial_anisotropy_k2",
        "cubic_anisotropy_kc1",
        "cubic_anisotropy_kc2",
        "cubic_anisotropy_kc3",
        "cubic_anisotropy_axis1",
        "cubic_anisotropy_axis2",
        "ms_field",
        "a_field",
        "alpha_field",
        "ku_field",
        "ku2_field",
        "kc1_field",
        "kc2_field",
        "kc3_field",
        "interfacial_dmi",
        "bulk_dmi",
        "dind_field",
        "dbulk_field",
    ];
    for field in missing_optionals {
        material.as_object_mut().unwrap().remove(field);
    }
    problem["materials"][0] = material;

    let decoded: ProblemIRV04 = serde_json::from_value(problem).unwrap();
    let encoded = serde_json::to_value(decoded).unwrap();
    let material = &encoded["materials"][0];

    assert_eq!(material["uniaxial_anisotropy"], Value::Null);
    assert_eq!(material["anisotropy_axis"], Value::Null);
    for field in missing_optionals {
        assert!(material.get(field).is_none(), "unexpected {field}");
    }
}

#[test]
fn migration_rejects_unknown_material_intent_without_mutating_input() {
    let mut value = legacy_eigen_problem_value(Some(json!("open")));
    value["materials"][0]["future_dmi_model"] = json!({ "coefficient": 0.25 });
    let original = value.clone();

    let error = migrate_v0_3_problem_ir_to_v0_4(&mut value).unwrap_err();

    assert!(error.contains("/materials/0"), "{error}");
    assert!(error.contains("future_dmi_model"), "{error}");
    assert_eq!(value, original);
}
