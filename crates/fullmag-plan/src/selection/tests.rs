use fullmag_ir::{
    GeometryEntryIR, ObjectRegionIR, RegionFrameIR, RegionRealizationPolicyIR, RegionShapeIR,
};

use super::geometry::{contains_point, AffineTransform3, BoundaryMembership, GeometryPredicate};

fn box_entry(name: &str, size: [f64; 3]) -> GeometryEntryIR {
    GeometryEntryIR::Box {
        name: name.to_string(),
        size,
    }
}

fn predicate(entry: &GeometryEntryIR) -> GeometryPredicate {
    GeometryPredicate::from_geometry_entry(
        entry,
        AffineTransform3::identity(),
        BoundaryMembership::inclusive(),
    )
    .expect("test geometry should lower")
}

#[test]
fn primitives_include_their_boundary() {
    let cases = [
        (
            box_entry("box", [2.0, 4.0, 6.0]),
            vec![([1.0, 2.0, 3.0], true), ([1.000_001, 0.0, 0.0], false)],
        ),
        (
            GeometryEntryIR::Cylinder {
                name: "cylinder".to_string(),
                radius: 2.0,
                height: 4.0,
                axis: [0.0, 0.0, 5.0],
            },
            vec![([2.0, 0.0, 2.0], true), ([2.000_001, 0.0, 0.0], false)],
        ),
        (
            GeometryEntryIR::Sphere {
                name: "sphere".to_string(),
                radius: 3.0,
            },
            vec![([0.0, 0.0, 3.0], true), ([0.0, 0.0, 3.000_001], false)],
        ),
    ];

    for (entry, samples) in cases {
        let predicate = predicate(&entry);
        for (point, expected) in samples {
            assert_eq!(
                contains_point(&predicate, point).expect("membership should evaluate"),
                expected,
                "{} at {point:?}",
                entry.name()
            );
        }
    }
}

#[test]
fn boolean_csg_matches_set_algebra_for_a_shared_point_corpus() {
    let left = GeometryEntryIR::Translate {
        name: "left".to_string(),
        base: Box::new(box_entry("left-box", [2.0, 2.0, 2.0])),
        by: [-0.5, 0.0, 0.0],
    };
    let right = GeometryEntryIR::Translate {
        name: "right".to_string(),
        base: Box::new(GeometryEntryIR::Sphere {
            name: "right-sphere".to_string(),
            radius: 1.0,
        }),
        by: [0.5, 0.0, 0.0],
    };
    let union = GeometryEntryIR::Union {
        name: "union".to_string(),
        a: Box::new(left.clone()),
        b: Box::new(right.clone()),
    };
    let intersection = GeometryEntryIR::Intersection {
        name: "intersection".to_string(),
        a: Box::new(left.clone()),
        b: Box::new(right.clone()),
    };
    let difference = GeometryEntryIR::Difference {
        name: "difference".to_string(),
        base: Box::new(left.clone()),
        tool: Box::new(right.clone()),
    };
    let left = predicate(&left);
    let right = predicate(&right);
    let union = predicate(&union);
    let intersection = predicate(&intersection);
    let difference = predicate(&difference);

    for ix in -8..=8 {
        for iy in -4..=4 {
            let point = [ix as f64 * 0.25, iy as f64 * 0.25, 0.0];
            let in_left = contains_point(&left, point).unwrap();
            let in_right = contains_point(&right, point).unwrap();
            assert_eq!(contains_point(&union, point).unwrap(), in_left || in_right);
            assert_eq!(
                contains_point(&intersection, point).unwrap(),
                in_left && in_right
            );
            assert_eq!(
                contains_point(&difference, point).unwrap(),
                in_left && !in_right
            );
        }
    }
}

#[test]
fn inverse_affine_applies_translation_rotation_nonuniform_scale_and_pivot() {
    let transform = AffineTransform3 {
        translation_m: [10.0, -2.0, 0.5],
        rotation_xyzw: [
            0.0,
            0.0,
            std::f64::consts::FRAC_1_SQRT_2,
            std::f64::consts::FRAC_1_SQRT_2,
        ],
        scale: [2.0, 3.0, 0.5],
        pivot_m: [1.0, 1.0, 0.0],
    };
    let predicate = GeometryPredicate::from_geometry_entry(
        &box_entry("box", [2.0, 2.0, 2.0]),
        transform,
        BoundaryMembership::inclusive(),
    )
    .unwrap();

    // Forward transform of local [1, 1, 0]: p + R(S(local - p)) + t.
    assert!(contains_point(&predicate, [11.0, -1.0, 0.5]).unwrap());
    // Forward transform of local [1.01, 1, 0] lies outside the local box.
    assert!(!contains_point(&predicate, [11.0, -0.98, 0.5]).unwrap());
}

#[test]
fn object_and_world_region_frames_use_the_same_canonical_evaluator() {
    let mut region = ObjectRegionIR {
        region_id: "core".to_string(),
        owner_object: "body".to_string(),
        name: "Core".to_string(),
        shape: RegionShapeIR::Sphere {
            radius: 0.5,
            center: [1.0, 0.0, 0.0],
        },
        frame: RegionFrameIR::Object,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        realization_policy: RegionRealizationPolicyIR::Project,
        material_transition: None,
    };
    let transform = AffineTransform3 {
        translation_m: [4.0, 0.0, 0.0],
        ..AffineTransform3::identity()
    };
    let object_predicate =
        GeometryPredicate::from_object_region(&region, transform, BoundaryMembership::inclusive())
            .unwrap();
    assert!(contains_point(&object_predicate, [5.5, 0.0, 0.0]).unwrap());

    region.frame = RegionFrameIR::World;
    let world_predicate =
        GeometryPredicate::from_object_region(&region, transform, BoundaryMembership::inclusive())
            .unwrap();
    assert!(contains_point(&world_predicate, [1.5, 0.0, 0.0]).unwrap());
    assert!(!contains_point(&world_predicate, [5.5, 0.0, 0.0]).unwrap());
}

#[test]
fn singular_transform_and_imported_solid_return_typed_errors() {
    let singular = GeometryPredicate::from_geometry_entry(
        &box_entry("box", [1.0; 3]),
        AffineTransform3 {
            scale: [1.0, 0.0, 1.0],
            ..AffineTransform3::identity()
        },
        BoundaryMembership::inclusive(),
    )
    .unwrap();
    assert_eq!(
        contains_point(&singular, [0.0; 3]).unwrap_err().code(),
        "selection_singular_transform"
    );

    let imported = GeometryEntryIR::ImportedGeometry {
        name: "mesh".to_string(),
        source: "mesh.stl".to_string(),
        format: "stl".to_string(),
        scale: Default::default(),
    };
    let error = GeometryPredicate::from_geometry_entry(
        &imported,
        AffineTransform3::identity(),
        BoundaryMembership::inclusive(),
    )
    .unwrap_err();
    assert_eq!(error.code(), "selection_imported_solid_unqualified");
}

#[test]
fn huge_finite_quaternion_and_axis_normalize_without_overflow() {
    let rotated = GeometryPredicate::from_geometry_entry(
        &box_entry("rotated", [4.0, 1.0, 1.0]),
        AffineTransform3 {
            rotation_xyzw: [0.0, 0.0, 1.0e308, 1.0e308],
            ..AffineTransform3::identity()
        },
        BoundaryMembership::inclusive(),
    )
    .unwrap();
    assert!(contains_point(&rotated, [0.0, 1.5, 0.0]).unwrap());
    assert!(!contains_point(&rotated, [1.5, 0.0, 0.0]).unwrap());

    let cylinder = GeometryEntryIR::Cylinder {
        name: "huge-axis".to_string(),
        radius: 0.5,
        height: 4.0,
        axis: [1.0e308, 1.0e308, 0.0],
    };
    let cylinder = predicate(&cylinder);
    assert!(contains_point(&cylinder, [1.0, 1.0, 0.0]).unwrap());
    assert!(!contains_point(&cylinder, [1.0, -1.0, 0.0]).unwrap());
}

#[test]
fn tiny_nonzero_scale_remains_invertible() {
    let predicate = GeometryPredicate::from_geometry_entry(
        &box_entry("tiny-scale", [2.0, 2.0, 2.0]),
        AffineTransform3 {
            scale: [1.0e-300, 1.0, 1.0],
            ..AffineTransform3::identity()
        },
        BoundaryMembership::inclusive(),
    )
    .unwrap();

    assert!(contains_point(&predicate, [0.5e-300, 0.0, 0.0]).unwrap());
    assert!(!contains_point(&predicate, [1.5e-300, 0.0, 0.0]).unwrap());
}

fn parity_geometry() -> GeometryEntryIR {
    GeometryEntryIR::Difference {
        name: "parity-difference".to_string(),
        base: Box::new(GeometryEntryIR::Box {
            name: "parity-base".to_string(),
            size: [4.0, 2.0, 2.0],
        }),
        tool: Box::new(GeometryEntryIR::Translate {
            name: "parity-tool".to_string(),
            base: Box::new(GeometryEntryIR::Sphere {
                name: "parity-sphere".to_string(),
                radius: 0.75,
            }),
            by: [0.5, 0.0, 0.0],
        }),
    }
}

#[test]
fn canonical_regional_field_and_fdm_region_share_one_point_corpus() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/geometry_selection_parity.json"
    ))
    .unwrap();
    let points: Vec<[f64; 3]> = serde_json::from_value(corpus["points"].clone()).unwrap();
    let expected: Vec<bool> = serde_json::from_value(corpus["expected"].clone()).unwrap();
    let geometry = parity_geometry();
    let predicate = predicate(&geometry);
    let canonical = points
        .iter()
        .map(|point| contains_point(&predicate, *point).unwrap())
        .collect::<Vec<_>>();
    let regional =
        crate::regional_field_drive::geometry_mask_membership_for_points(&geometry, &points)
            .unwrap();
    let region = ObjectRegionIR {
        region_id: "parity".to_string(),
        owner_object: "body".to_string(),
        name: "Parity".to_string(),
        shape: RegionShapeIR::Csg {
            expression: Box::new(geometry),
        },
        frame: RegionFrameIR::World,
        enabled: true,
        priority: 0,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        realization_policy: RegionRealizationPolicyIR::Project,
        material_transition: None,
    };
    let fdm = crate::fdm::object_region_membership_for_points(
        &region,
        AffineTransform3::identity(),
        &points,
    )
    .unwrap();

    assert_eq!(canonical, expected);
    assert_eq!(regional, expected);
    assert_eq!(fdm, expected);
}
