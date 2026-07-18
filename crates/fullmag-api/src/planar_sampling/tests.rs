use fullmag_ir::{
    EmptyPolicyIR, PlanarExtentIR, PlanarFrameIR, PlanarOperatorIR, PlanarReductionIR,
};

use super::{
    FdmPlanarField, FemPlanarField, Occupancy, PlanarComponent, PlanarSamplingEngine,
    ResolvedPlanarSampleRequest,
};

fn explicit_frame(origin_m: [f64; 3], u_axis: [f64; 3], normal: [f64; 3]) -> PlanarFrameIR {
    let v_axis = [
        normal[1] * u_axis[2] - normal[2] * u_axis[1],
        normal[2] * u_axis[0] - normal[0] * u_axis[2],
        normal[0] * u_axis[1] - normal[1] * u_axis[0],
    ];
    PlanarFrameIR {
        origin_m,
        u_axis,
        v_axis,
        normal,
        preset: None,
        normalization_version: fullmag_ir::PLANAR_FRAME_NORMALIZATION_VERSION.to_string(),
        extent: PlanarExtentIR::Explicit {
            u_min_m: -0.5,
            u_max_m: 0.5,
            v_min_m: -0.5,
            v_max_m: 0.5,
        },
    }
}

fn request(
    frame: PlanarFrameIR,
    operator: PlanarOperatorIR,
    resolution: [u32; 2],
) -> ResolvedPlanarSampleRequest {
    ResolvedPlanarSampleRequest {
        monitor_id: "manufactured".into(),
        monitor_hash: "test".into(),
        frame,
        operator,
        resolution,
        component: PlanarComponent::Scalar,
    }
}

#[test]
fn planar_sampling_fdm_constant_scalar_and_vector_basis_are_exact() {
    let scalar = FdmPlanarField::new(1, [2, 2, 2], [-0.5; 3], [0.5; 3], vec![7.25; 8]).unwrap();
    let frame = explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
    let result = PlanarSamplingEngine::sample_fdm(
        &scalar,
        &request(frame.clone(), PlanarOperatorIR::PlaneSample, [2, 2]),
    )
    .unwrap();
    assert_eq!(result.scalar_values, vec![7.25; 4]);
    assert!(result
        .occupancy
        .iter()
        .all(|value| *value == Occupancy::Occupied));

    let mut vectors = Vec::new();
    for _ in 0..8 {
        vectors.extend([1.0, 2.0, 3.0]);
    }
    let vector = FdmPlanarField::new(3, [2, 2, 2], [-0.5; 3], [0.5; 3], vectors).unwrap();
    let result = PlanarSamplingEngine::sample_fdm(
        &vector,
        &ResolvedPlanarSampleRequest {
            component: PlanarComponent::MonitorV,
            ..request(frame, PlanarOperatorIR::PlaneSample, [2, 2])
        },
    )
    .unwrap();
    assert_eq!(result.scalar_values, vec![2.0; 4]);
    assert_eq!(result.vector_values.unwrap(), vec![[1.0, 2.0, 3.0]; 4]);
}

#[test]
fn planar_sampling_orientation_uses_monitor_basis_and_masks_zero_vectors() {
    let field = FdmPlanarField::new(
        3,
        [2, 1, 1],
        [-0.5; 3],
        [0.5, 1.0, 1.0],
        vec![1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    )
    .unwrap();
    let frame = explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
    let result = PlanarSamplingEngine::sample_fdm(
        &field,
        &ResolvedPlanarSampleRequest {
            component: PlanarComponent::Orientation,
            ..request(frame, PlanarOperatorIR::PlaneSample, [2, 1])
        },
    )
    .unwrap();

    assert_eq!(result.scalar_values[0], 0.0);
    assert!(result.scalar_values[1].is_nan());
    assert_eq!(result.occupancy[1], Occupancy::UndefinedOrientation);
}

#[test]
fn planar_sampling_fdm_linear_depth_is_measure_weighted_and_masks_empty_pixels() {
    let field = FdmPlanarField::new(
        1,
        [1, 1, 2],
        [-0.5, -0.5, -1.0],
        [1.0, 1.0, 1.0],
        vec![-0.5, 0.5],
    )
    .unwrap();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: -1.5,
            u_max_m: 1.5,
            v_min_m: -0.5,
            v_max_m: 0.5,
        },
        ..explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    };
    let result = PlanarSamplingEngine::sample_fdm(
        &field,
        &request(
            frame,
            PlanarOperatorIR::DepthProjection {
                reduction: PlanarReductionIR::MeanOccupied,
                empty_policy: EmptyPolicyIR::ExcludeEmpty,
            },
            [3, 1],
        ),
    )
    .unwrap();
    assert!(result.scalar_values[0].is_nan());
    assert!((result.scalar_values[1]).abs() < 1.0e-15);
    assert!(result.scalar_values[2].is_nan());
    assert_eq!(
        result.occupancy,
        vec![Occupancy::Empty, Occupancy::Occupied, Occupancy::Empty]
    );
}

#[test]
fn planar_sampling_marks_partial_pixel_prism_occupancy() {
    let field = FdmPlanarField::new(1, [1, 1, 1], [-0.5; 3], [1.0; 3], vec![4.0]).unwrap();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: -1.0,
            u_max_m: 1.0,
            v_min_m: -0.5,
            v_max_m: 0.5,
        },
        ..explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    };
    let result = PlanarSamplingEngine::sample_fdm(
        &field,
        &request(
            frame,
            PlanarOperatorIR::SlabAverage { thickness_m: 1.0 },
            [1, 1],
        ),
    )
    .unwrap();
    assert_eq!(result.scalar_values, vec![4.0]);
    assert_eq!(result.occupancy, vec![Occupancy::Partial]);
    assert_eq!(result.meta.partial_count, 1);
}

fn skew_tetra_field() -> FemPlanarField {
    let nodes = vec![
        [0.0, 0.0, 0.0],
        [2.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 3.0],
    ];
    let values = nodes
        .iter()
        .map(|p| p[0] + 2.0 * p[1] + 3.0 * p[2])
        .collect();
    FemPlanarField::new(1, nodes, vec![[0, 1, 2, 3]], vec![1], values).unwrap()
}

#[test]
fn planar_sampling_fem_p1_linear_arbitrary_plane_is_barycentric() {
    let field = skew_tetra_field();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: -0.05,
            u_max_m: 0.05,
            v_min_m: -0.05,
            v_max_m: 0.05,
        },
        ..explicit_frame(
            [0.25, 0.25, 0.25],
            [1.0 / 2.0_f64.sqrt(), -1.0 / 2.0_f64.sqrt(), 0.0],
            [1.0 / 3.0_f64.sqrt(); 3],
        )
    };
    let result = PlanarSamplingEngine::sample_fem(
        &field,
        &request(frame, PlanarOperatorIR::PlaneSample, [1, 1]),
    )
    .unwrap();
    assert!((result.scalar_values[0] - 1.5).abs() < 1.0e-12);
    let overlay = result
        .overlay
        .expect("FEM plane sampling publishes mesh overlay");
    assert_eq!(overlay.polygons.len(), 1);
    assert!(overlay.polygons[0].vertices_uv_m.len() >= 3);
    let fmcs = crate::fem_cross_section::serialize_planar_overlay_fmcs_v3(&overlay);
    assert_eq!(&fmcs[0..4], b"FMCS");
    assert_eq!(u32::from_le_bytes(fmcs[4..8].try_into().unwrap()), 3);
    assert!(fmcs.len() >= 160);
}

#[test]
fn planar_sampling_fem_volume_mean_is_not_node_count_average_and_is_refinement_invariant() {
    let field = skew_tetra_field();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: 2.0,
            v_min_m: 0.0,
            v_max_m: 1.0,
        },
        ..explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    };
    let req = request(
        frame,
        PlanarOperatorIR::DepthProjection {
            reduction: PlanarReductionIR::MeanOccupied,
            empty_policy: EmptyPolicyIR::ExcludeEmpty,
        },
        [1, 1],
    );
    let coarse = PlanarSamplingEngine::sample_fem(&field, &req).unwrap();
    let expected = 0.5 + 0.5 + 2.25;
    assert!((coarse.scalar_values[0] - expected).abs() < 1.0e-12);

    let refined = field.refine_uniform_p1();
    let fine = PlanarSamplingEngine::sample_fem(&refined, &req).unwrap();
    assert!((fine.scalar_values[0] - coarse.scalar_values[0]).abs() < 1.0e-12);
    assert_ne!(refined.nodes().len(), field.nodes().len());
}

#[test]
fn planar_sampling_surface_reports_projected_overlap() {
    let field = FemPlanarField::new(
        1,
        vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
        ],
        vec![[0, 1, 2, 3], [3, 4, 5, 0]],
        vec![1, 1],
        vec![2.0; 6],
    )
    .unwrap();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: 1.0,
            v_min_m: 0.0,
            v_max_m: 1.0,
        },
        ..explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    };
    let result = PlanarSamplingEngine::sample_fem(
        &field,
        &request(
            frame,
            PlanarOperatorIR::SurfaceProjection {
                boundary: fullmag_ir::SurfaceBoundarySelectorIR::ObjectBoundary,
                visibility_policy: fullmag_ir::SurfaceVisibilityPolicyIR::AreaWeightedOverlap,
            },
            [1, 1],
        ),
    )
    .unwrap();
    assert!((result.scalar_values[0] - 2.0).abs() < 1.0e-12);
    assert!(result.meta.overlap_count > 0);
    assert!(result.meta.non_injective);
}

#[test]
fn planar_sampling_rejects_unpublished_surface_selectors_instead_of_using_object_boundary() {
    let field = FemPlanarField::new(
        1,
        vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        vec![[0, 1, 2, 3]],
        vec![1],
        vec![1.0; 4],
    )
    .unwrap();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: 1.0,
            v_min_m: 0.0,
            v_max_m: 1.0,
        },
        ..explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    };
    let error = PlanarSamplingEngine::sample_fem(
        &field,
        &request(
            frame,
            PlanarOperatorIR::SurfaceProjection {
                boundary: fullmag_ir::SurfaceBoundarySelectorIR::RegionBoundary {
                    region_id: "core".to_string(),
                },
                visibility_policy: fullmag_ir::SurfaceVisibilityPolicyIR::Frontmost,
            },
            [4, 4],
        ),
    )
    .unwrap_err();

    assert_eq!(error.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    assert!(error.message.starts_with("unsupported_region_boundary_projection:"));
}

#[test]
fn planar_sampling_surface_clips_boundary_faces_across_pixel_footprints() {
    let field = FemPlanarField::new(
        1,
        vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        vec![[0, 1, 2, 3]],
        vec![1],
        vec![1.0; 4],
    )
    .unwrap();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: 1.0,
            v_min_m: 0.0,
            v_max_m: 1.0,
        },
        ..explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    };
    let result = PlanarSamplingEngine::sample_fem(
        &field,
        &request(
            frame,
            PlanarOperatorIR::SurfaceProjection {
                boundary: fullmag_ir::SurfaceBoundarySelectorIR::ObjectBoundary,
                visibility_policy: fullmag_ir::SurfaceVisibilityPolicyIR::Frontmost,
            },
            [4, 4],
        ),
    )
    .unwrap();
    assert!(
        result
            .occupancy
            .iter()
            .filter(|occupancy| **occupancy != Occupancy::Empty)
            .count()
            > 4,
        "a rasterized boundary triangle must cover more pixels than its face centroids"
    );
}
