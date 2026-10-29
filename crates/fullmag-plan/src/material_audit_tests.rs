use super::*;

fn mesh_with_nodes(nodes: Vec<[f64; 3]>, cells: Vec<[u32; 4]>) -> fullmag_ir::MeshIR {
    fullmag_ir::MeshIR {
        nodes,
        cells: fullmag_ir::FemConnectivityIR::from_tet4(cells),
        ..Default::default()
    }
}

#[test]
fn local_spacing_is_rotation_invariant_and_ignores_disconnected_nodes() {
    let base = mesh_with_nodes(
        vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
        vec![[0, 1, 2, 3]],
    );
    assert_eq!(fem_node_spacings(&base), vec![1.; 4]);
    let mut rotated = base.clone();
    let (s, c) = 0.731_f64.sin_cos();
    for p in &mut rotated.nodes {
        *p = [c * p[0] - s * p[1], s * p[0] + c * p[1], p[2]];
    }
    rotated.nodes.push([1e-15, 100., 100.]);
    assert!(fem_node_spacings(&rotated)[..4]
        .iter()
        .all(|h| (h - 1.).abs() < 1e-14));
}

#[test]
fn local_spacing_tracks_refinement_instead_of_global_minimum() {
    let mesh = mesh_with_nodes(
        vec![
            [0., 0., 0.],
            [1., 0., 0.],
            [0., 1., 0.],
            [0., 0., 1.],
            [10., 0., 0.],
            [10.1, 0., 0.],
            [10., 0.1, 0.],
            [10., 0., 0.1],
        ],
        vec![[0, 1, 2, 3], [4, 5, 6, 7]],
    );
    let spacing = fem_node_spacings(&mesh);
    assert_eq!(&spacing[..4], &[1.; 4]);
    assert!(spacing[4..].iter().all(|h| (h - 0.1).abs() < 1e-14));
}

#[test]
fn mesh_relative_requires_positive_local_scale() {
    use crate::material_transition::ResolvedMaterialTransition;
    let transition = ResolvedMaterialTransition::MeshRelative {
        cells: 3,
        scope: fullmag_ir::MaterialTransitionScopeIR::Boundary,
    };
    assert!(transition_weight(-0.1, transition, f64::NAN).is_err());
    assert!(transition_weight(-0.1, transition, 0.).is_err());
    assert_eq!(
        transition_weight(-0.1, ResolvedMaterialTransition::Sharp, f64::NAN).unwrap(),
        1.
    );
    assert_eq!(transition_weight(0., transition, 1.).unwrap(), 0.5);
    assert_eq!(transition_weight(1.5, transition, 1.).unwrap(), 0.);
}

#[test]
fn spatial_parameter_uses_each_samples_local_transition_width() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.object_regions.push(
        serde_json::from_value(serde_json::json!({
            "region_id": "strip:core", "owner_object": "strip", "name": "core",
            "shape": {"kind": "box", "center": [0.0,0.0,0.0], "size": [2.0,2.0,2.0]},
            "frame": "object", "enabled": true, "priority": 0,
            "material_transition": {"kind": "mesh_relative", "cells": 3, "scope": "boundary"},
            "material_overrides": [{"parameter": "ms", "priority": 0, "conflict_policy": "error",
                "value": {"kind": "constant", "value": 400000.0}}],
            "realization_policy": "inherit"
        }))
        .unwrap(),
    );
    let points = [[1.5, 0.0, 0.0], [-1.5, 0.0, 0.0]];
    let values = resolve_spatial_parameter(
        &problem,
        "strip",
        MaterialParameterNameIR::Ms,
        800000.0,
        &points,
        MaterialSampleSpacing::PerPoint(&[1.0, 0.1]),
        [0.0; 3],
    )
    .unwrap();
    assert!((values[0] - (800000.0 - 400000.0 * 7.0 / 27.0)).abs() < 1e-8);
    assert_eq!(values[1], 800000.0);
}
