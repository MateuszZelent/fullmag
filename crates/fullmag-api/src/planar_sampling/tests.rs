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
fn planar_fdm_grid_overlay_is_physical_deduplicated_and_fmfg_v1() {
    let field =
        FdmPlanarField::new(1, [2, 2, 1], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], vec![1.0; 4]).unwrap();
    let frame =
        crate::planar_sampling::frame::ResolvedFrame::try_from_ir(&fullmag_ir::PlanarFrameIR {
            origin_m: [0.0, 0.0, 0.5],
            u_axis: [1.0, 0.0, 0.0],
            v_axis: [0.0, 1.0, 0.0],
            normal: [0.0, 0.0, 1.0],
            preset: Some(fullmag_ir::PlanarFramePresetIR::Xy),
            normalization_version: "planar_frame_v1".to_string(),
            extent: fullmag_ir::PlanarExtentIR::Explicit {
                u_min_m: 0.0,
                u_max_m: 2.0,
                v_min_m: 0.0,
                v_max_m: 2.0,
            },
        })
        .unwrap();

    let overlay = crate::planar_sampling::fdm::build_grid_overlay(&field, &frame).unwrap();
    assert_eq!(
        overlay.segments.len(),
        12,
        "shared cell edges must be deduplicated"
    );
    assert!(overlay.segments.iter().all(|segment| {
        segment
            .a_uv_m
            .iter()
            .chain(&segment.b_uv_m)
            .all(|value| value.is_finite())
    }));
    let bytes = crate::fdm_planar_grid_overlay::serialize_fmfg_v1(&overlay).unwrap();
    assert_eq!(&bytes[..4], b"FMFG");
    assert_eq!(u32::from_le_bytes(bytes[4..8].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(bytes[8..12].try_into().unwrap()), 12);
}

#[test]
fn planar_fdm_grid_overlay_honors_membership_mask() {
    let field = FdmPlanarField::new(1, [2, 1, 1], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], vec![1.0; 2])
        .unwrap()
        .with_membership_mask(vec![true, false])
        .unwrap();
    let frame = crate::planar_sampling::frame::ResolvedFrame::try_from_ir(&PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: 2.0,
            v_min_m: 0.0,
            v_max_m: 1.0,
        },
        ..explicit_frame([0.0, 0.0, 0.5], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    })
    .unwrap();

    let overlay = crate::planar_sampling::fdm::build_grid_overlay(&field, &frame).unwrap();
    assert_eq!(overlay.segments.len(), 4);
    assert!(overlay
        .segments
        .iter()
        .all(|segment| { segment.a_uv_m[0] <= 1.0 && segment.b_uv_m[0] <= 1.0 }));
}

#[test]
fn planar_fdm_grid_overlay_deduplicates_plane_on_shared_cell_wall() {
    let field =
        FdmPlanarField::new(1, [2, 1, 1], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], vec![1.0; 2]).unwrap();
    let frame = crate::planar_sampling::frame::ResolvedFrame::try_from_ir(&PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: 1.0,
            v_min_m: 0.0,
            v_max_m: 1.0,
        },
        ..explicit_frame([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0])
    })
    .unwrap();

    let overlay = crate::planar_sampling::fdm::build_grid_overlay(&field, &frame).unwrap();
    assert_eq!(overlay.segments.len(), 4);
}

#[test]
fn planar_fdm_grid_overlay_supports_arbitrary_normalized_frame() {
    let field =
        FdmPlanarField::new(1, [1, 1, 1], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], vec![1.0]).unwrap();
    let inverse_sqrt_two = 1.0 / 2.0_f64.sqrt();
    let inverse_sqrt_three = 1.0 / 3.0_f64.sqrt();
    let frame = crate::planar_sampling::frame::ResolvedFrame::try_from_ir(&PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: -1.0,
            u_max_m: 1.0,
            v_min_m: -1.0,
            v_max_m: 1.0,
        },
        ..explicit_frame(
            [0.5, 0.5, 0.5],
            [inverse_sqrt_two, -inverse_sqrt_two, 0.0],
            [inverse_sqrt_three; 3],
        )
    })
    .unwrap();

    let overlay = crate::planar_sampling::fdm::build_grid_overlay(&field, &frame).unwrap();
    assert_eq!(overlay.segments.len(), 6);
}

#[test]
fn planar_fdm_grid_overlay_fails_instead_of_truncating_segment_budget() {
    let side = 317_u32;
    let field = FdmPlanarField::new(
        1,
        [side, side, 1],
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        vec![1.0; (side * side) as usize],
    )
    .unwrap();
    let frame = crate::planar_sampling::frame::ResolvedFrame::try_from_ir(&PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: side as f64,
            v_min_m: 0.0,
            v_max_m: side as f64,
        },
        ..explicit_frame([0.0, 0.0, 0.5], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    })
    .unwrap();

    let error = crate::planar_sampling::fdm::build_grid_overlay(&field, &frame).unwrap_err();
    assert!(error.to_string().contains("planar_mesh_budget_exceeded"));
}

#[test]
fn planar_sampling_fdm_plane_supports_large_production_raster() {
    let field = FdmPlanarField::new(
        1,
        [16, 12, 4],
        [-0.5; 3],
        [0.0625, 1.0 / 12.0, 0.25],
        vec![1.0; 768],
    )
    .unwrap();
    let frame = explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
    let started = std::time::Instant::now();
    let result = PlanarSamplingEngine::sample_fdm(
        &field,
        &request(frame, PlanarOperatorIR::PlaneSample, [1024, 1024]),
    )
    .unwrap();

    assert_eq!(result.scalar_values.len(), 1024 * 1024);
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "large FDM plane sample exceeded the production 2 s budget: {:?}",
        started.elapsed()
    );
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
fn planar_sampling_fdm_depth_projection_preserves_nanometer_scale_measure() {
    let nm = 1.0e-9;
    let field = FdmPlanarField::new(
        1,
        [16, 12, 4],
        [-40.0 * nm, -30.0 * nm, -10.0 * nm],
        [5.0 * nm; 3],
        vec![800_000.0; 16 * 12 * 4],
    )
    .unwrap();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: -40.0 * nm,
            u_max_m: 40.0 * nm,
            v_min_m: -30.0 * nm,
            v_max_m: 30.0 * nm,
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
            [32, 32],
        ),
    )
    .unwrap();

    assert!(
        result
            .occupancy
            .iter()
            .any(|support| *support != Occupancy::Empty),
        "nanometer-scale depth projection must retain occupied measure"
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

#[test]
fn fdm_membership_mask_excludes_cells_from_plane_and_depth_sampling() {
    let field = FdmPlanarField::new(
        1,
        [2, 1, 1],
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        vec![4.0, 9.0],
    )
    .unwrap()
    .with_membership_mask(vec![true, false])
    .unwrap();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: 2.0,
            v_min_m: 0.0,
            v_max_m: 1.0,
        },
        ..explicit_frame([0.0, 0.0, 0.5], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    };
    let plane = request(frame.clone(), PlanarOperatorIR::PlaneSample, [2, 1]);
    let result = PlanarSamplingEngine::sample_fdm(&field, &plane).unwrap();
    assert_eq!(
        result.occupancy,
        vec![Occupancy::Occupied, Occupancy::Empty]
    );
    assert_eq!(result.scalar_values[0], 4.0);
    assert!(result.scalar_values[1].is_nan());

    let depth = request(
        frame,
        PlanarOperatorIR::DepthProjection {
            reduction: PlanarReductionIR::MeanOccupied,
            empty_policy: EmptyPolicyIR::ExcludeEmpty,
        },
        [2, 1],
    );
    let result = PlanarSamplingEngine::sample_fdm(&field, &depth).unwrap();
    assert_eq!(
        result.occupancy,
        vec![Occupancy::Occupied, Occupancy::Empty]
    );
    assert_eq!(result.scalar_values[0], 4.0);
    assert!(result.scalar_values[1].is_nan());
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
fn planar_sampling_prism6_p1_reproduces_affine_world_field() {
    let nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [0.0, 1.0, 1.0],
    ];
    let values = nodes
        .iter()
        .map(|point| 2.0 * point[0] - 3.0 * point[1] + 5.0 * point[2] + 7.0)
        .collect();
    let field = FemPlanarField::new_mixed(
        1,
        nodes,
        vec![super::FemPlanarElement::Prism6([0, 1, 2, 3, 4, 5])],
        vec![1],
        values,
    )
    .unwrap();

    let (_, value) = super::fem::interpolate_at(&field, [0.2, 0.3, 0.4]).unwrap();
    assert!((value[0] - (2.0 * 0.2 - 3.0 * 0.3 + 5.0 * 0.4 + 7.0)).abs() < 1.0e-12);
}

#[test]
fn planar_sampling_prism6_plane_volume_surface_and_overlay_are_supported() {
    let nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [0.0, 1.0, 1.0],
    ];
    let field = FemPlanarField::new_mixed(
        1,
        nodes,
        vec![super::FemPlanarElement::Prism6([0, 1, 2, 3, 4, 5])],
        vec![1],
        vec![4.0; 6],
    )
    .unwrap();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: 1.0,
            v_min_m: 0.0,
            v_max_m: 1.0,
        },
        ..explicit_frame([0.0, 0.0, 0.5], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    };

    let plane = PlanarSamplingEngine::sample_fem(
        &field,
        &request(frame.clone(), PlanarOperatorIR::PlaneSample, [1, 1]),
    )
    .unwrap();
    assert_eq!(plane.scalar_values, vec![4.0]);
    assert_eq!(plane.overlay.unwrap().polygons.len(), 1);

    let depth = PlanarSamplingEngine::sample_fem(
        &field,
        &request(
            frame.clone(),
            PlanarOperatorIR::DepthProjection {
                reduction: PlanarReductionIR::MeanOccupied,
                empty_policy: EmptyPolicyIR::ExcludeEmpty,
            },
            [1, 1],
        ),
    )
    .unwrap();
    assert!((depth.scalar_values[0] - 4.0).abs() < 1.0e-12);

    let surface = PlanarSamplingEngine::sample_fem(
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
    assert!((surface.scalar_values[0] - 4.0).abs() < 1.0e-12);
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
    assert!(overlay.segments.iter().all(|segment| matches!(
        segment.kind,
        crate::planar_sampling::PlanarOverlaySegmentKind::TargetBoundary
    )));
    let fmcs = crate::fem_cross_section::serialize_planar_overlay_fmcs_v4(&overlay);
    assert_eq!(&fmcs[0..4], b"FMCS");
    assert_eq!(u32::from_le_bytes(fmcs[4..8].try_into().unwrap()), 4);
    assert!(fmcs.len() >= 160);
}

#[test]
fn planar_overlay_classifies_selected_topology_without_float_boundary_heuristics() {
    let interior_field = FemPlanarField::new(
        1,
        vec![
            [0.0, 0.0, -1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -2.0],
        ],
        vec![[0, 1, 2, 3], [0, 1, 2, 4]],
        vec![1, 1],
        vec![1.0; 5],
    )
    .expect("two selected tetrahedra sharing one face");
    let frame = explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
    let overlay = PlanarSamplingEngine::sample_fem(
        &interior_field,
        &request(frame, PlanarOperatorIR::PlaneSample, [1, 1]),
    )
    .expect("sample shared-face topology")
    .overlay
    .expect("FEM overlay");
    assert!(overlay.segments.iter().any(|segment| matches!(
        segment.kind,
        crate::planar_sampling::PlanarOverlaySegmentKind::MeshInterior
    )));
    assert!(overlay.segments.iter().any(|segment| matches!(
        segment.kind,
        crate::planar_sampling::PlanarOverlaySegmentKind::TargetBoundary
    )));

    let degenerate_field = FemPlanarField::new(
        1,
        vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, -1.0],
            [0.0, 0.0, 1.0],
        ],
        vec![[0, 1, 2, 3]],
        vec![1],
        vec![1.0; 4],
    )
    .expect("one tetrahedron touching the plane at a vertex");
    let frame = explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
    let overlay = PlanarSamplingEngine::sample_fem(
        &degenerate_field,
        &request(frame, PlanarOperatorIR::PlaneSample, [1, 1]),
    )
    .expect("sample degenerate topology")
    .overlay
    .expect("FEM overlay");
    assert!(overlay.segments.iter().any(|segment| matches!(
        segment.kind,
        crate::planar_sampling::PlanarOverlaySegmentKind::UnclassifiedDegenerate
    )));
}

#[test]
fn planar_sampling_fem_plane_preserves_nanometer_scale_tetrahedra() {
    let nm = 1.0e-9;
    let field = FemPlanarField::new(
        1,
        vec![
            [0.0, 0.0, 0.0],
            [10.0 * nm, 0.0, 0.0],
            [0.0, 10.0 * nm, 0.0],
            [0.0, 0.0, 10.0 * nm],
        ],
        vec![[0, 1, 2, 3]],
        vec![1],
        vec![2.0; 4],
    )
    .unwrap();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: 2.0 * nm,
            v_min_m: 0.0,
            v_max_m: 2.0 * nm,
        },
        ..explicit_frame([0.0, 0.0, 2.0 * nm], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0])
    };
    let result = PlanarSamplingEngine::sample_fem(
        &field,
        &request(frame, PlanarOperatorIR::PlaneSample, [1, 1]),
    )
    .unwrap();

    assert_eq!(result.occupancy, vec![Occupancy::Occupied]);
    assert!((result.scalar_values[0] - 2.0).abs() < 1.0e-12);
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
    assert!(error
        .message
        .starts_with("unsupported_region_boundary_projection:"));
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

#[test]
fn planar_sampling_surface_preserves_nanometer_scale_boundary_measure() {
    let nm = 1.0e-9;
    let field = FemPlanarField::new(
        1,
        vec![
            [0.0, 0.0, 0.0],
            [10.0 * nm, 0.0, 0.0],
            [0.0, 10.0 * nm, 0.0],
            [0.0, 0.0, 10.0 * nm],
        ],
        vec![[0, 1, 2, 3]],
        vec![1],
        vec![2.0; 4],
    )
    .unwrap();
    let frame = PlanarFrameIR {
        extent: PlanarExtentIR::Explicit {
            u_min_m: 0.0,
            u_max_m: 10.0 * nm,
            v_min_m: 0.0,
            v_max_m: 10.0 * nm,
        },
        ..explicit_frame([0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0])
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

    assert!(result
        .occupancy
        .iter()
        .any(|occupancy| *occupancy != Occupancy::Empty));
    assert!(result.meta.occupied_measure > 0.0);
}
