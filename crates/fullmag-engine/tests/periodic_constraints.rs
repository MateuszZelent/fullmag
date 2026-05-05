use fullmag_engine::periodic::constraints::{floquet_phase, Complex64, PeriodicDofMap};
use fullmag_engine::periodic::reconstruct::reconstruct_full_complex_vec3;
use fullmag_ir::{MeshPeriodicBoundaryPairIR, MeshPeriodicNodePairIR, PhaseConventionIR};

#[test]
fn static_periodic_merges_slave_into_master() {
    let pairs = vec![
        MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 10,
        },
        MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 1,
            node_b: 11,
        },
    ];

    let map = PeriodicDofMap::from_periodic_pairs_static(12, &pairs).unwrap();

    assert_eq!(map.reduced_node(10), map.reduced_node(0));
    assert_eq!(map.reduced_node(11), map.reduced_node(1));
    assert_eq!(map.phase(10), Complex64::new(1.0, 0.0));
    assert_eq!(map.reduced_node_count, 10);
}

#[test]
fn floquet_phase_uses_minus_i_k_dot_delta_r() {
    let phase = floquet_phase(
        [std::f64::consts::PI, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        PhaseConventionIR::ExpMinusIKDotDeltaR,
    );

    assert!((phase + Complex64::new(1.0, 0.0)).norm() < 1e-12);
}

#[test]
fn floquet_map_uses_boundary_translation() {
    let pairs = vec![MeshPeriodicNodePairIR {
        pair_id: "x_faces".to_string(),
        node_a: 0,
        node_b: 1,
    }];
    let metadata = vec![MeshPeriodicBoundaryPairIR {
        pair_id: "x_faces".to_string(),
        source_marker: None,
        destination_marker: None,
        marker_a: 10,
        marker_b: 11,
        translation: Some([1.0, 0.0, 0.0]),
        tolerance: Some(1e-12),
        axis_hint: None,
        orientation: None,
        pairing_policy: None,
    }];

    let map = PeriodicDofMap::from_periodic_pairs_floquet(
        2,
        &pairs,
        &metadata,
        [std::f64::consts::FRAC_PI_2, 0.0, 0.0],
        PhaseConventionIR::ExpMinusIKDotDeltaR,
    )
    .unwrap();
    let phase = map.phase(1);

    assert_eq!(map.reduced_node(1), map.reduced_node(0));
    assert!(phase.re.abs() < 1e-12);
    assert!((phase.im + 1.0).abs() < 1e-12);
}

#[test]
fn reconstructs_full_complex_vector_from_reduced_space() {
    let pairs = vec![MeshPeriodicNodePairIR {
        pair_id: "x_faces".to_string(),
        node_a: 0,
        node_b: 1,
    }];
    let metadata = vec![MeshPeriodicBoundaryPairIR {
        pair_id: "x_faces".to_string(),
        source_marker: None,
        destination_marker: None,
        marker_a: 10,
        marker_b: 11,
        translation: Some([1.0, 0.0, 0.0]),
        tolerance: Some(1e-12),
        axis_hint: None,
        orientation: None,
        pairing_policy: None,
    }];
    let map = PeriodicDofMap::from_periodic_pairs_floquet(
        2,
        &pairs,
        &metadata,
        [std::f64::consts::PI, 0.0, 0.0],
        PhaseConventionIR::ExpMinusIKDotDeltaR,
    )
    .unwrap();
    let reduced = vec![[Complex64::new(2.0, 0.0); 3]];

    let full = reconstruct_full_complex_vec3(&map, &reduced);

    assert_eq!(full[0][0], Complex64::new(2.0, 0.0));
    assert!((full[1][0] + Complex64::new(2.0, 0.0)).norm() < 1e-12);
}
