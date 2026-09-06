use fullmag_ir::{
    EmptyPolicyIR, PlanarExtentIR, PlanarFrameIR, PlanarOperatorIR, PlanarReductionIR,
    SurfaceBoundarySelectorIR, SurfaceVisibilityPolicyIR,
};

use super::{
    FdmPlanarField, FemPlanarElement, FemPlanarField, Occupancy, PlanarComponent,
    PlanarSamplingEngine, ResolvedPlanarSampleRequest,
};

fn explicit_frame(
    origin_m: [f64; 3],
    u_axis: [f64; 3],
    v_axis: [f64; 3],
    normal: [f64; 3],
    bounds: [f64; 4],
) -> PlanarFrameIR {
    PlanarFrameIR {
        origin_m,
        u_axis,
        v_axis,
        normal,
        preset: None,
        normalization_version: fullmag_ir::PLANAR_FRAME_NORMALIZATION_VERSION.to_string(),
        extent: PlanarExtentIR::Explicit {
            u_min_m: bounds[0],
            u_max_m: bounds[1],
            v_min_m: bounds[2],
            v_max_m: bounds[3],
        },
    }
}

fn request(
    frame: PlanarFrameIR,
    operator: PlanarOperatorIR,
    resolution: [u32; 2],
    component: PlanarComponent,
) -> ResolvedPlanarSampleRequest {
    ResolvedPlanarSampleRequest {
        frame,
        operator,
        resolution,
        component,
    }
}

/// C01 / N03: Unit tetrahedron Tet4 with affine field f = x.
/// Nodes: (0,0,0), (1,0,0), (0,1,0), (0,0,1).
/// Exact values:
/// volume = 1/6
/// mean = 1/4 = 0.25
/// rms = sqrt(1/10) ≈ 0.31622776601683794
/// min = 0.0, max = 1.0
/// stddev = sqrt(3/80) ≈ 0.19364916731037085
pub(crate) fn fixture_c01_tet4_unit_x() -> (FemPlanarField, PlanarFrameIR) {
    let nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ];
    let values = vec![0.0, 1.0, 0.0, 0.0];
    let field = FemPlanarField::new(1, nodes, vec![[0, 1, 2, 3]], vec![1], values).unwrap();
    let frame = explicit_frame(
        [0.0, 0.0, 0.5],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0, 1.0],
    );
    (field, frame)
}

/// C02 / N04: Prism6 unit wedge with nodal field f = r * t (x * z).
/// Nodes: (0,0,0), (1,0,0), (0,1,0), (0,0,1), (1,0,1), (0,1,1).
/// Node 4 is (1,0,1) where f = 1. All other nodes f = 0.
/// Sliced by y <= 0.5.
/// Exact volume = 3/8 = 0.375
/// Exact integral = 7/96 ≈ 0.07291666666666667
/// Exact mean = 7/36 ≈ 0.19444444444444445
pub(crate) fn fixture_c02_prism6_rt_wedge() -> (FemPlanarField, PlanarFrameIR) {
    let nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [0.0, 1.0, 1.0],
    ];
    let mut values = vec![0.0; 6];
    values[4] = 1.0;
    let field = FemPlanarField::new_mixed(
        1,
        nodes,
        vec![FemPlanarElement::Prism6([0, 1, 2, 3, 4, 5])],
        vec![1],
        values,
    )
    .unwrap();
    // Frame where U is X, V is Z, normal is Y.
    // origin at [0.0, 0.25, 0.0], slab thickness 0.5 -> y in [0.0, 0.5]
    let frame = explicit_frame(
        [0.0, 0.25, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0],
        [0.0, 1.0, 0.0, 1.0],
    );
    (field, frame)
}

#[test]
fn test_c01_tet4_rms_and_extrema_oracle() {
    let (field, frame) = fixture_c01_tet4_unit_x();
    let req_rms = request(
        frame.clone(),
        PlanarOperatorIR::DepthProjection {
            reduction: PlanarReductionIR::Rms,
            empty_policy: EmptyPolicyIR::ExcludeEmpty,
        },
        [1, 1],
        PlanarComponent::Scalar,
    );
    let result_rms = PlanarSamplingEngine::sample_fem(&field, &req_rms).unwrap();
    let computed_rms = result_rms.scalar_values[0];
    let exact_rms = (1.0_f64 / 10.0).sqrt(); // sqrt(1/10) ≈ 0.316227766

    assert!(
        (computed_rms - exact_rms).abs() < 1e-10,
        "C01 / N03: Tet4 RMS of f=x over unit tetrahedron must be sqrt(1/10) ≈ {exact_rms}, got {computed_rms}"
    );

    let req_min = request(
        frame.clone(),
        PlanarOperatorIR::DepthProjection {
            reduction: PlanarReductionIR::Min,
            empty_policy: EmptyPolicyIR::ExcludeEmpty,
        },
        [1, 1],
        PlanarComponent::Scalar,
    );
    let result_min = PlanarSamplingEngine::sample_fem(&field, &req_min).unwrap();
    assert!(
        (result_min.scalar_values[0] - 0.0).abs() < 1e-10,
        "C01: Tet4 Min of f=x must be 0.0, got {}",
        result_min.scalar_values[0]
    );

    let req_max = request(
        frame,
        PlanarOperatorIR::DepthProjection {
            reduction: PlanarReductionIR::Max,
            empty_policy: EmptyPolicyIR::ExcludeEmpty,
        },
        [1, 1],
        PlanarComponent::Scalar,
    );
    let result_max = PlanarSamplingEngine::sample_fem(&field, &req_max).unwrap();
    assert!(
        (result_max.scalar_values[0] - 1.0).abs() < 1e-10,
        "C01: Tet4 Max of f=x must be 1.0, got {}",
        result_max.scalar_values[0]
    );
}

#[test]
fn test_c02_prism6_rt_clipped_volume_integral() {
    let (field, frame) = fixture_c02_prism6_rt_wedge();
    let req = request(
        frame,
        PlanarOperatorIR::SlabAverage { thickness_m: 0.5 },
        [1, 1],
        PlanarComponent::Scalar,
    );
    let result = PlanarSamplingEngine::sample_fem(&field, &req).unwrap();
    let computed_mean = result.scalar_values[0];
    let exact_mean = 7.0 / 36.0; // 0.1944444...

    assert!(
        (computed_mean - exact_mean).abs() < 1e-6,
        "C02 / N04: Prism6 f=r*t clipped by y<=0.5 must have mean 7/36 ≈ {exact_mean}, got {computed_mean}"
    );
}

#[test]
fn test_c03_c04_fem_plane_sampling_no_centroid_splat_or_clamp() {
    // A single small triangle on XY plane at z=0
    // Vertices in UV: (0.001, 0.001), (0.005, 0.001), (0.001, 0.005)
    // In raster 16x16 over [0, 1] x [0, 1], pixel (0, 0) center is (0.03125, 0.03125),
    // which is strictly outside the triangle.
    let nodes = vec![
        [0.001, 0.001, 0.0],
        [0.005, 0.001, 0.0],
        [0.001, 0.005, 0.0],
        [0.002, 0.002, 0.01],
    ];
    let field = FemPlanarField::new(1, nodes, vec![[0, 1, 2, 3]], vec![1], vec![42.0; 4]).unwrap();
    let frame = explicit_frame(
        [0.5, 0.5, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [-0.5, 0.5, -0.5, 0.5],
    );
    // Origin at [0.5, 0.5, 0.0] with extent [-0.5, 0.5] means UV in [0, 1]
    let req = request(frame, PlanarOperatorIR::PlaneSample, [16, 16], PlanarComponent::Scalar);
    let result = PlanarSamplingEngine::sample_fem(&field, &req).unwrap();

    // Pixel (0, 0) center is at world (0.03125, 0.03125, 0.0), which is outside the triangle.
    // Centroid splat in previous code forced pixel (0, 0) to Occupied!
    // With proper point-center sampling, pixel (0, 0) must NOT be Occupied.
    assert_eq!(
        result.occupancy[0],
        Occupancy::Empty,
        "C04: Pixel (0,0) center is outside the subpixel triangle and must be Empty"
    );

    // C03: Element with u ≈ 2.02 (outside [0, 1] extent)
    let outside_nodes = vec![
        [2.01, 0.5, 0.0],
        [2.03, 0.5, 0.0],
        [2.02, 0.52, 0.0],
        [2.02, 0.5, 0.01],
    ];
    let outside_field = FemPlanarField::new(1, outside_nodes, vec![[0, 1, 2, 3]], vec![1], vec![99.0; 4]).unwrap();
    let outside_frame = explicit_frame(
        [0.5, 0.5, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [-0.5, 0.5, -0.5, 0.5],
    );
    let outside_req = request(outside_frame, PlanarOperatorIR::PlaneSample, [16, 16], PlanarComponent::Scalar);
    let outside_result = PlanarSamplingEngine::sample_fem(&outside_field, &outside_req).unwrap();
    // In column 15 (edge column), no pixel should be occupied by this element!
    for y in 0..16 {
        let idx = (y * 16 + 15) as usize;
        assert_eq!(
            outside_result.occupancy[idx],
            Occupancy::Empty,
            "C03: Polygon outside [0, 1] extent must not be clamped and painted in edge column 15"
        );
    }
}

#[test]
fn test_c09_nonlinear_reduction_vector_component() {
    // Two sample tetrahedra with opposite in-plane vectors: (1, -1, 0) and (-1, 1, 0)
    // Monitor frame axis U = (1/sqrt(2), 1/sqrt(2), 0).
    // In both elements, v . U = 0.
    // The maximum of (v . U) over the domain is 0.0!
    // Componentwise max gives max(v) = (1, 1, 0), which projected onto U gives sqrt(2) ≈ 1.414.
    let nodes = vec![
        // Tet 1
        [0.0, 0.0, 0.0], [0.5, 0.0, 0.0], [0.0, 0.5, 0.0], [0.0, 0.0, 0.5],
        // Tet 2
        [0.5, 0.5, 0.0], [1.0, 0.5, 0.0], [0.5, 1.0, 0.0], [0.5, 0.5, 0.5],
    ];
    let elements = vec![FemPlanarElement::Tet4([0, 1, 2, 3]), FemPlanarElement::Tet4([4, 5, 6, 7])];
    let mut values = Vec::new();
    // Tet 1 has vector (1.0, -1.0, 0.0) at all nodes
    for _ in 0..4 {
        values.extend_from_slice(&[1.0, -1.0, 0.0]);
    }
    // Tet 2 has vector (-1.0, 1.0, 0.0) at all nodes
    for _ in 0..4 {
        values.extend_from_slice(&[-1.0, 1.0, 0.0]);
    }
    let field = FemPlanarField::new_mixed(3, nodes, elements, vec![1, 1], values).unwrap();
    let inv_sqrt2 = 1.0 / 2.0_f64.sqrt();
    let frame = explicit_frame(
        [0.5, 0.5, 0.25],
        [inv_sqrt2, inv_sqrt2, 0.0],
        [-inv_sqrt2, inv_sqrt2, 0.0],
        [0.0, 0.0, 1.0],
        [-0.5, 0.5, -0.5, 0.5],
    );
    let req = request(
        frame,
        PlanarOperatorIR::DepthProjection {
            reduction: PlanarReductionIR::Max,
            empty_policy: EmptyPolicyIR::ExcludeEmpty,
        },
        [1, 1],
        PlanarComponent::MonitorU,
    );
    let result = PlanarSamplingEngine::sample_fem(&field, &req).unwrap();
    let val = result.scalar_values[0];
    assert!(
        val.abs() < 1e-10,
        "C09 / N06: Maximum of v . U must be 0.0, got {val}"
    );
}

#[test]
fn test_c10_normal_vector_undefined_orientation() {
    let scalar = FdmPlanarField::new(3, [1, 1, 1], [0.0; 3], [1.0; 3], vec![0.0, 0.0, 1.0]).unwrap();
    let frame = explicit_frame(
        [0.5, 0.5, 0.5],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [-0.5, 0.5, -0.5, 0.5],
    );
    let req = request(frame, PlanarOperatorIR::PlaneSample, [1, 1], PlanarComponent::Orientation);
    let result = PlanarSamplingEngine::sample_fdm(&scalar, &req).unwrap();
    // In-plane projection is (0,0) with normal (1). Azymut in-plane is undefined!
    assert!(
        result.occupancy[0] == Occupancy::UndefinedOrientation || result.scalar_values[0].is_nan(),
        "C10: Normal vector on XY plane must have undefined orientation"
    );
}

#[test]
fn test_c07_fdm_continuous_slab_not_snapped() {
    // 2 cells in Z: cell 0 on z in [0, 1] with value 0.0; cell 1 on z in [1, 2] with value 1.0.
    let field = FdmPlanarField::new(1, [1, 1, 2], [0.0; 3], [1.0; 3], vec![0.0, 1.0]).unwrap();
    // Continuous slab with center at z = 1.0 (the interface between the two cells) and thickness 1.0.
    // Interval along Z is [0.5, 1.5]: overlaps cell 0 on [0.5, 1.0] (measure 0.5, val 0.0)
    // and cell 1 on [1.0, 1.5] (measure 0.5, val 1.0).
    // Exact mean over the slab is (0.5 * 0.0 + 0.5 * 1.0) / 1.0 = 0.5.
    let frame = explicit_frame(
        [0.5, 0.5, 1.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [-0.5, 0.5, -0.5, 0.5],
    );
    let req = request(
        frame,
        PlanarOperatorIR::SlabAverage { thickness_m: 1.0 },
        [1, 1],
        PlanarComponent::Scalar,
    );
    let result = PlanarSamplingEngine::sample_fdm(&field, &req).unwrap();
    let mean = result.scalar_values[0];
    assert!(
        (mean - 0.5).abs() < 1e-10,
        "C07 / N08: Continuous slab centered at cell boundary z=1.0 must have mean 0.5, got {mean}"
    );
}

#[test]
fn test_py13_surface_magnitude_uses_mean_of_magnitude() {
    let nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, -1.0],
    ];
    // Vector values at nodes: (x - y, 0, 0)
    // node 0 (0,0,0) -> (0,0,0)
    // node 1 (1,0,0) -> (1,0,0)
    // node 2 (0,1,0) -> (-1,0,0)
    // node 3 (0,0,-1) -> (0,0,0)
    let values = vec![
        0.0, 0.0, 0.0,
        1.0, 0.0, 0.0,
        -1.0, 0.0, 0.0,
        0.0, 0.0, 0.0,
    ];
    let field = FemPlanarField::new(3, nodes, vec![[0, 1, 2, 3]], vec![1], values).unwrap();
    let frame = explicit_frame(
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0, 1.0],
    );
    let req = request(
        frame,
        PlanarOperatorIR::SurfaceProjection {
            boundary: SurfaceBoundarySelectorIR::ObjectBoundary,
            visibility_policy: SurfaceVisibilityPolicyIR::Frontmost,
        },
        [1, 1],
        PlanarComponent::Magnitude,
    );
    let result = PlanarSamplingEngine::sample_fem(&field, &req).unwrap();
    let val = result.scalar_values[0];
    // Exact mean of |x - y| over the unit right triangle is 1/3 ≈ 0.3333333333333333.
    // Norm of the mean vector would be 0.0.
    assert!(
        (val - 1.0 / 3.0).abs() < 1e-6,
        "PY13: Surface magnitude must integrate mean of magnitude (1/3), got {val}"
    );
}

#[test]
fn test_py15_nan_in_vector_marks_undefined_orientation() {
    let field = FdmPlanarField::new(
        3,
        [1, 1, 1],
        [0.0; 3],
        [1.0; 3],
        vec![1.0, f64::NAN, 0.0],
    )
    .unwrap();
    let frame = explicit_frame(
        [0.5, 0.5, 0.5],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [-0.5, 0.5, -0.5, 0.5],
    );
    let req = request(
        frame,
        PlanarOperatorIR::PlaneSample,
        [1, 1],
        PlanarComponent::Orientation,
    );
    let result = PlanarSamplingEngine::sample_fdm(&field, &req).unwrap();
    assert_eq!(
        result.occupancy[0],
        Occupancy::UndefinedOrientation,
        "PY15: NaN in vector component must produce UndefinedOrientation occupancy"
    );
}

#[test]
fn test_py07_degenerate_prism6_centroid() {
    let nodes: [[f64; 3]; 6] = [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
    ];
    let centroid = [1.0 / 3.0, 1.0 / 3.0, 0.0];
    let res = crate::planar_sampling::element_evaluator::prism6_invert(&nodes, centroid);
    assert!(
        res.is_none(),
        "PY07: Degenerate zero-height Prism6 must return None, got {res:?}"
    );
}

#[test]
fn test_py10_point_tetrahedron_distance_feature_rank() {
    // 4 points on the x-axis: three at -1/3 and one at 2/3.
    // The convex hull is the line segment [-1/3, 2/3] along X.
    let v0 = [-1.0 / 3.0, 0.0, 0.0];
    let v1 = [-1.0 / 3.0, 0.0, 0.0];
    let v2 = [-1.0 / 3.0, 0.0, 0.0];
    let v3 = [2.0 / 3.0, 0.0, 0.0];
    let p = [0.0, 0.0, 0.0];
    let dist = crate::planar_sampling::element_evaluator::point_tetrahedron_distance(p, v0, v1, v2, v3);
    assert!(
        dist < 1e-12,
        "PY10: Point (0,0,0) is inside segment [-1/3, 2/3], distance must be 0, got {dist}"
    );
}

#[test]
fn test_d05_rank2_small_scale_distance() {
    for scale in [1.0, 1e-6, 1e-13, 1e6] {
        let v0 = [1.0 * scale, 0.0, 0.0];
        let v1 = [0.0, 1.0 * scale, 0.0];
        let v2 = [-1.0 * scale, -1.0 * scale, 0.0];
        let v3 = [1.0 * scale, 0.0, 0.0];
        let p = [0.0, 0.0, 0.0];
        let dist = crate::planar_sampling::element_evaluator::point_tetrahedron_distance(p, v0, v1, v2, v3);
        assert!(
            dist < 1e-11 * scale,
            "D05: Rank-2 distance at scale {scale} must be zero, got {dist}"
        );
    }
}

#[test]
fn test_d06_infinite_vector_does_not_contaminate_finite_neighbors() {
    let field = FdmPlanarField::new(
        3,
        [2, 1, 1],
        [0.0; 3],
        [1.0; 3],
        vec![1.0, 0.0, 0.0, f64::INFINITY, 0.0, 0.0],
    )
    .unwrap();
    let frame = explicit_frame(
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 2.0, 0.0, 1.0],
    );
    let req = request(
        frame,
        PlanarOperatorIR::PlaneSample,
        [2, 1],
        PlanarComponent::Orientation,
    );
    let result = PlanarSamplingEngine::sample_fdm(&field, &req).unwrap();
    assert_eq!(
        result.occupancy[0],
        Occupancy::Occupied,
        "D06: Valid vector must remain Occupied, not contaminated by Inf neighbor"
    );
    assert!(
        (result.scalar_values[0] - 0.0).abs() < 1e-6,
        "D06: In-plane orientation angle must be 0 for [1, 0, 0], got {}",
        result.scalar_values[0]
    );
    assert_eq!(
        result.occupancy[1],
        Occupancy::UndefinedOrientation,
        "D06: Infinite vector must produce UndefinedOrientation"
    );
}

#[test]
fn test_d04_surface_shifted_abs_exact_quadrature() {
    let nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, -1.0],
    ];
    let values = vec![
        -0.5, 0.0, 0.0, // node 0 (0,0,0)
        0.5, 0.0, 0.0,  // node 1 (1,0,0)
        -0.5, 0.0, 0.0, // node 2 (0,1,0)
        -0.5, 0.0, 0.0, // node 3 (0,0,-1)
    ];
    let field = FemPlanarField::new(3, nodes, vec![[0, 1, 2, 3]], vec![1], values).unwrap();
    let frame = explicit_frame(
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 1.0, 0.0, 1.0],
    );
    let req = request(
        frame,
        PlanarOperatorIR::SurfaceProjection {
            boundary: SurfaceBoundarySelectorIR::ObjectBoundary,
            visibility_policy: SurfaceVisibilityPolicyIR::Frontmost,
        },
        [1, 1],
        PlanarComponent::Magnitude,
    );
    let result = PlanarSamplingEngine::sample_fem(&field, &req).unwrap();
    let val = result.scalar_values[0];
    // Analytical integral of |x - 1/2| over unit right triangle is exactly 1/4 = 0.25.
    assert!(
        (val - 0.25).abs() < 1e-4,
        "D04: Surface quadrature on |x - 1/2| must be 0.25, got {val}"
    );
}

#[test]
fn test_d04_py11_prism6_quad_face_exact_quadrature() {
    // Prism with triangular base in XZ: (0,0,0), (1,0,0), (0,0,1) extruded along Y from 0 to 1
    let nodes = vec![
        [0.0, 0.0, 0.0], // 0
        [1.0, 0.0, 0.0], // 1
        [0.0, 0.0, 1.0], // 2
        [0.0, 1.0, 0.0], // 3
        [1.0, 1.0, 0.0], // 4
        [0.0, 1.0, 1.0], // 5
    ];
    // Quad face [0, 1, 4, 3] lies in Z=0 plane: x in [0, 1], y in [0, 1]
    // Value at (1, 1, 0) node 4 is 1.0, all other nodes are 0.0 -> f(x, y) = x * y
    let mut values = vec![0.0; 6];
    values[4] = 1.0;
    let field = FemPlanarField::new_mixed(
        1,
        nodes,
        vec![FemPlanarElement::Prism6([0, 1, 2, 3, 4, 5])],
        vec![1],
        values,
    )
    .unwrap();

    // Frame on Z=0 quad face: origin [0,0,0], U along X, V along Y, normal along -Z
    let frame = explicit_frame(
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, -1.0],
        [0.0, 1.0, 0.0, 1.0],
    );
    let req = request(
        frame,
        PlanarOperatorIR::SurfaceProjection {
            boundary: SurfaceBoundarySelectorIR::ObjectBoundary,
            visibility_policy: SurfaceVisibilityPolicyIR::Frontmost,
        },
        [1, 1],
        PlanarComponent::Scalar,
    );
    let result = PlanarSamplingEngine::sample_fem(&field, &req).unwrap();
    let val = result.scalar_values[0];
    // Analytical integral of x * y over unit square [0,1]^2 is exactly 1/4 = 0.25.
    // Piecewise-linear triangle split gave 1/3 ≈ 0.33333. Gauss 2x2 gives exactly 0.25.
    assert!(
        (val - 0.25).abs() < 1e-4,
        "D04/PY11: Prism6 quad face bilinear f=x*y integral must be 0.25, got {val}"
    );
}

