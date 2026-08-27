use fullmag_ir::{
    FemCellMeshPartIR, FemCellTypeIR, FemConnectivityIR, MonitorTargetIR, PlanarExtentIR,
    PlanarFrameIR, PlanarOperatorIR,
};
use fullmag_quantities::quantity_spec;
use fullmag_runner::{FemMeshPartPayload, FemMeshPayload};

use crate::router_v2::handlers::data::resolved_spatial_field::{
    EntityMapping, FdmCellMembership, ResolvedSpatialField, SpatialFieldCarrier,
    SpatialFieldProvenance, SpatialFieldSourceKind,
};
use crate::schemas::mesh::FdmRegionLegendEntryResource;

use super::{
    resolve_spatial_target, sample_resolved_target, PlanarComponent, PlanarSampleIdentity,
    ResolvedPlanarSampleRequest, ResolvedSpatialScope,
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
) -> ResolvedPlanarSampleRequest {
    ResolvedPlanarSampleRequest {
        frame,
        operator,
        resolution,
        component: PlanarComponent::Scalar,
    }
}

fn fem_mesh() -> FemMeshPayload {
    FemMeshPayload {
        mesh_name: "two-targets".to_string(),
        mesh_id: "two-targets:1".to_string(),
        nodes: vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [10.0, 0.0, 0.0],
            [11.0, 0.0, 0.0],
            [10.0, 1.0, 0.0],
            [10.0, 0.0, 1.0],
        ],
        cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
        element_markers: vec![1, 1],
        facets: fullmag_ir::FemFacetConnectivityIR::empty(),
        boundary_markers: Vec::new(),
        periodic_boundary_pairs: Vec::new(),
        periodic_node_pairs: Vec::new(),
        object_segments: Vec::new(),
        mesh_parts: vec![
            FemMeshPartPayload {
                id: "left-part".to_string(),
                label: "left".to_string(),
                role: "magnetic_object".to_string(),
                object_id: Some("left".to_string()),
                geometry_id: Some("left-geometry".to_string()),
                material_id: Some("left-material".to_string()),
                element_start: 0,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 0,
                boundary_face_indices: Vec::new(),
                node_start: 0,
                node_count: 4,
                node_indices: vec![0, 1, 2, 3],
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
            },
            FemMeshPartPayload {
                id: "right-part".to_string(),
                label: "right".to_string(),
                role: "magnetic_object".to_string(),
                object_id: Some("right".to_string()),
                geometry_id: Some("right-geometry".to_string()),
                material_id: Some("right-material".to_string()),
                element_start: 1,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 0,
                boundary_face_indices: Vec::new(),
                node_start: 4,
                node_count: 4,
                node_indices: vec![4, 5, 6, 7],
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
            },
        ],
        domain_mesh_mode: Some("shared_domain".to_string()),
        domain_frame: None,
        generation_id: Some("mesh-generation-1".to_string()),
        per_domain_quality: Default::default(),
        build_report: None,
    }
}

fn fem_field(mapping: EntityMapping, values: Vec<f64>) -> ResolvedSpatialField<'static> {
    fem_field_with_mesh(fem_mesh(), mapping, values)
}

fn fem_field_with_mesh(
    mesh: FemMeshPayload,
    mapping: EntityMapping,
    values: Vec<f64>,
) -> ResolvedSpatialField<'static> {
    let mesh = Box::leak(Box::new(mesh));
    let spec = quantity_spec("m").unwrap();
    ResolvedSpatialField {
        quantity_id: "m".to_string(),
        quantity_kind: spec.shape,
        canonical_unit: spec.unit.to_string(),
        component_count: 3,
        default_component: spec.default_component,
        source_kind: SpatialFieldSourceKind::Materialized,
        provenance: SpatialFieldProvenance {
            backend: Some("fem".to_string()),
            device: Some("gpu".to_string()),
            precision: Some("double".to_string()),
        },
        field_generation: Some("run-1:5".to_string()),
        quantity_revision: 7,
        mesh_or_grid_revision: 11,
        source_grid: None,
        values,
        carrier: SpatialFieldCarrier::FemNodes {
            topology: mesh,
            topology_fingerprint: "mesh-fingerprint-1".to_string(),
            mapping,
        },
    }
}

fn scalar_fem_field(mesh: FemMeshPayload, values: Vec<f64>) -> ResolvedSpatialField<'static> {
    let mesh = Box::leak(Box::new(mesh));
    let entity_count = mesh.nodes.len();
    let spec = quantity_spec("demag_phi").unwrap();
    ResolvedSpatialField {
        quantity_id: "demag_phi".to_string(),
        quantity_kind: spec.shape,
        canonical_unit: spec.unit.to_string(),
        component_count: 1,
        default_component: spec.default_component,
        source_kind: SpatialFieldSourceKind::Materialized,
        provenance: SpatialFieldProvenance {
            backend: Some("fem".to_string()),
            device: Some("cpu".to_string()),
            precision: Some("double".to_string()),
        },
        field_generation: Some("run-analytic:1".to_string()),
        quantity_revision: 13,
        mesh_or_grid_revision: 17,
        source_grid: None,
        values,
        carrier: SpatialFieldCarrier::FemNodes {
            topology: mesh,
            topology_fingerprint: "analytic-skew-tet4".to_string(),
            mapping: EntityMapping::Identity { entity_count },
        },
    }
}

fn dynamic_frame(extent: PlanarExtentIR) -> PlanarFrameIR {
    PlanarFrameIR {
        origin_m: [0.0, 0.0, 0.0],
        u_axis: [1.0, 0.0, 0.0],
        v_axis: [0.0, 1.0, 0.0],
        normal: [0.0, 0.0, 1.0],
        preset: None,
        normalization_version: fullmag_ir::PLANAR_FRAME_NORMALIZATION_VERSION.to_string(),
        extent,
    }
}

fn assert_frame_bounds(frame: &PlanarFrameIR, expected: [f64; 4]) {
    let PlanarExtentIR::Explicit {
        u_min_m,
        u_max_m,
        v_min_m,
        v_max_m,
    } = frame.extent
    else {
        panic!("dynamic extent was not resolved");
    };
    assert_eq!([u_min_m, u_max_m, v_min_m, v_max_m], expected);
}

fn scalar_fdm_field(
    membership: FdmCellMembership,
    values: Vec<f64>,
) -> ResolvedSpatialField<'static> {
    let spec = quantity_spec("mat_ms").unwrap();
    ResolvedSpatialField {
        quantity_id: "mat_ms".to_string(),
        quantity_kind: spec.shape,
        canonical_unit: spec.unit.to_string(),
        component_count: 1,
        default_component: spec.default_component,
        source_kind: SpatialFieldSourceKind::Materialized,
        provenance: SpatialFieldProvenance {
            backend: Some("fdm".to_string()),
            device: Some("cpu".to_string()),
            precision: Some("double".to_string()),
        },
        field_generation: Some("run-1:3".to_string()),
        quantity_revision: 5,
        mesh_or_grid_revision: 9,
        source_grid: Some([2, 1, 1]),
        values,
        carrier: SpatialFieldCarrier::FdmCells {
            cells: [2, 1, 1],
            origin_m: Some([0.0, 0.0, 0.0]),
            cell_size_m: Some([1.0, 1.0, 1.0]),
            grid_fingerprint: Some("grid-fingerprint-1".to_string()),
            membership: Some(membership),
            multilayer_scope: None,
        },
    }
}

fn scalar_fdm_field_without_membership() -> ResolvedSpatialField<'static> {
    let mut field = scalar_fdm_field(
        FdmCellMembership {
            object_ids: Vec::new(),
            region_legend: Vec::new(),
            cell_membership: vec![u32::MAX; 2],
        },
        vec![4.0, 9.0],
    );
    let SpatialFieldCarrier::FdmCells { membership, .. } = &mut field.carrier else {
        unreachable!("fixture uses FDM cells");
    };
    *membership = None;
    field
}

fn multi_object_membership(cells: Vec<u32>) -> FdmCellMembership {
    FdmCellMembership {
        object_ids: vec!["left".to_string(), "right".to_string()],
        region_legend: vec![
            FdmRegionLegendEntryResource {
                numeric_id: 1,
                object_id: "left".to_string(),
                region_id: "core".to_string(),
                priority: 0,
            },
            FdmRegionLegendEntryResource {
                numeric_id: 2,
                object_id: "right".to_string(),
                region_id: "core".to_string(),
                priority: 0,
            },
        ],
        cell_membership: cells,
    }
}

#[test]
fn fem_dynamic_bounds_use_only_selected_target_elements() {
    let values = vec![1.0; 8 * 3];
    let field = fem_field(EntityMapping::Identity { entity_count: 8 }, values);

    let target = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Object {
            object_id: "left".to_string(),
        },
        ResolvedSpatialScope::MonitorTarget,
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap();

    assert_eq!(target.selected_entity_ids(), &[0]);
    assert_eq!(target.bounds_world_m(), [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]]);
}

#[test]
fn fem_mesh_part_scope_limits_target_magnetic_and_universe_extents() {
    let field = fem_field(EntityMapping::Identity { entity_count: 8 }, vec![1.0; 24]);
    let target = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Domain,
        ResolvedSpatialScope::MeshPart {
            scope_id: "left-part".to_string(),
        },
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap();

    for extent in [
        PlanarExtentIR::TargetBounds { padding_m: 0.0 },
        PlanarExtentIR::MagneticDomain { padding_m: 0.0 },
        PlanarExtentIR::Universe { padding_m: 0.0 },
    ] {
        let mut frame = dynamic_frame(extent);
        target.resolve_dynamic_extent(&mut frame).unwrap();
        assert_frame_bounds(&frame, [0.0, 1.0, 0.0, 1.0]);
    }
}

#[test]
fn fem_airbox_scope_limits_target_and_universe_and_has_no_magnetic_extent() {
    let mut mesh = fem_mesh();
    mesh.element_markers = vec![1, 0];
    mesh.mesh_parts[1].id = "airbox".to_string();
    mesh.mesh_parts[1].role = "far_air".to_string();
    mesh.mesh_parts[1].object_id = None;
    let field = fem_field_with_mesh(
        mesh,
        EntityMapping::Identity { entity_count: 8 },
        vec![1.0; 24],
    );
    let target = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Domain,
        ResolvedSpatialScope::Airbox { scope_id: None },
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap();

    for extent in [
        PlanarExtentIR::TargetBounds { padding_m: 0.0 },
        PlanarExtentIR::Universe { padding_m: 0.0 },
    ] {
        let mut frame = dynamic_frame(extent);
        target.resolve_dynamic_extent(&mut frame).unwrap();
        assert_frame_bounds(&frame, [10.0, 11.0, 0.0, 1.0]);
    }
    let mut magnetic = dynamic_frame(PlanarExtentIR::MagneticDomain { padding_m: 0.0 });
    let error = target.resolve_dynamic_extent(&mut magnetic).unwrap_err();
    assert!(error.message.contains("planar_extent_empty"));
}

#[test]
fn compact_fem_plane_and_slab_match_equivalent_full_carrier() {
    let vector = [2.0, -3.0, 4.0];
    let full_values = vector.repeat(8);
    let compact_values = vector.repeat(4);
    let full = fem_field(EntityMapping::Identity { entity_count: 8 }, full_values);
    let compact = fem_field(
        EntityMapping::ExplicitLocalToGlobal(vec![0, 1, 2, 3]),
        compact_values,
    );
    let frame = explicit_frame(
        [0.0, 0.0, 0.25],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [0.0, 0.5, 0.0, 0.5],
    );
    for operator in [
        PlanarOperatorIR::PlaneSample,
        PlanarOperatorIR::SlabAverage { thickness_m: 0.5 },
    ] {
        let req = request(frame.clone(), operator.clone(), [2, 2]);
        let req = ResolvedPlanarSampleRequest {
            component: PlanarComponent::Magnitude,
            ..req
        };
        let full_target = resolve_spatial_target(
            &full,
            &MonitorTargetIR::Object {
                object_id: "left".to_string(),
            },
            ResolvedSpatialScope::MonitorTarget,
            &operator,
        )
        .unwrap();
        let compact_target = resolve_spatial_target(
            &compact,
            &MonitorTargetIR::Object {
                object_id: "left".to_string(),
            },
            ResolvedSpatialScope::MonitorTarget,
            &operator,
        )
        .unwrap();

        let full_sample = sample_resolved_target(&full_target, &req).unwrap();
        let compact_sample = sample_resolved_target(&compact_target, &req).unwrap();
        assert_eq!(compact_sample.scalar_values, full_sample.scalar_values);
        assert_eq!(compact_sample.vector_values, full_sample.vector_values);
        assert_eq!(compact_sample.occupancy, full_sample.occupancy);
    }
}

#[test]
fn fdm_object_target_excludes_neighbor_object_cells() {
    let field = scalar_fdm_field(multi_object_membership(vec![1, 2]), vec![4.0, 9.0]);
    let target = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Object {
            object_id: "left".to_string(),
        },
        ResolvedSpatialScope::MonitorTarget,
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap();
    let req = request(
        explicit_frame(
            [0.0, 0.0, 0.5],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 2.0, 0.0, 1.0],
        ),
        PlanarOperatorIR::PlaneSample,
        [2, 1],
    );
    let sample = sample_resolved_target(&target, &req).unwrap();
    assert_eq!(sample.scalar_values[0], 4.0);
    assert!(sample.scalar_values[1].is_nan());
    assert_eq!(target.selected_entity_ids(), &[0]);
}

#[test]
fn airbox_scope_requires_exact_legal_airbox_carrier_quantity() {
    let field = ResolvedSpatialField::from_airbox(
        "H_demag",
        "H_demag",
        "A/m",
        3,
        vec![1.0, 2.0, 3.0],
        [1, 1, 1],
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        "airbox-carrier".to_string(),
        17,
        19,
        23,
        SpatialFieldSourceKind::Persisted,
    )
    .unwrap();
    assert!(resolve_spatial_target(
        &field,
        &MonitorTargetIR::Domain,
        ResolvedSpatialScope::Airbox { scope_id: None },
        &PlanarOperatorIR::PlaneSample,
    )
    .is_ok());

    let non_airbox = scalar_fdm_field(multi_object_membership(vec![1, 2]), vec![4.0, 9.0]);
    let error = resolve_spatial_target(
        &non_airbox,
        &MonitorTargetIR::Domain,
        ResolvedSpatialScope::Airbox { scope_id: None },
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap_err();
    assert!(error.message.contains("airbox"));
}

#[test]
fn fdm_domain_without_membership_has_no_magnetic_extent() {
    let field = scalar_fdm_field_without_membership();
    let target = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Domain,
        ResolvedSpatialScope::MonitorTarget,
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap();
    let mut frame = dynamic_frame(PlanarExtentIR::MagneticDomain { padding_m: 0.0 });
    let error = target.resolve_dynamic_extent(&mut frame).unwrap_err();
    assert!(
        error.message.contains("planar_extent_empty")
            || error.message.contains("missing_fdm_membership")
    );
}

#[test]
fn fdm_airbox_carrier_has_no_implicit_magnetic_extent() {
    let field = ResolvedSpatialField::from_airbox(
        "H_demag",
        "H_demag",
        "A/m",
        3,
        vec![1.0, 2.0, 3.0],
        [1, 1, 1],
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        "airbox-carrier".to_string(),
        17,
        19,
        23,
        SpatialFieldSourceKind::Persisted,
    )
    .unwrap();
    let target = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Domain,
        ResolvedSpatialScope::Airbox { scope_id: None },
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap();
    let mut frame = dynamic_frame(PlanarExtentIR::MagneticDomain { padding_m: 0.0 });
    let error = target.resolve_dynamic_extent(&mut frame).unwrap_err();
    assert!(error.message.contains("planar_extent_empty"));
}

#[test]
fn constant_field_is_invariant_under_frame_rotation_and_resolution() {
    let field = scalar_fdm_field(
        FdmCellMembership {
            object_ids: vec!["body".to_string()],
            region_legend: Vec::new(),
            cell_membership: vec![0, 0],
        },
        vec![6.25, 6.25],
    );
    let target = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Object {
            object_id: "body".to_string(),
        },
        ResolvedSpatialScope::MonitorTarget,
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap();
    let frames = [
        explicit_frame(
            [1.0, 0.5, 0.5],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [-1.0, 1.0, -0.5, 0.5],
        ),
        explicit_frame(
            [1.0, 0.5, 0.5],
            [
                std::f64::consts::FRAC_1_SQRT_2,
                std::f64::consts::FRAC_1_SQRT_2,
                0.0,
            ],
            [
                -std::f64::consts::FRAC_1_SQRT_2,
                std::f64::consts::FRAC_1_SQRT_2,
                0.0,
            ],
            [0.0, 0.0, 1.0],
            [-0.5, 0.5, -0.5, 0.5],
        ),
    ];
    for (frame, resolution) in frames.into_iter().zip([[8, 4], [19, 11]]) {
        let sample = sample_resolved_target(
            &target,
            &request(frame, PlanarOperatorIR::PlaneSample, resolution),
        )
        .unwrap();
        assert!(sample
            .scalar_values
            .iter()
            .zip(&sample.occupancy)
            .filter(|(_, occupancy)| **occupancy != super::Occupancy::Empty)
            .all(|(value, _)| (*value - 6.25).abs() < 1.0e-12));
    }
}

#[test]
fn slab_average_is_measure_weighted_and_refinement_invariant() {
    const TOLERANCE: f64 = 1.0e-10;
    let mut mesh = fem_mesh();
    mesh.nodes = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [2.0, 0.0, 0.0],
        [4.0, 0.0, 0.0],
        [2.0, 1.0, 0.0],
        [2.0, 0.0, 1.0],
    ];
    mesh.cells = FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
    mesh.element_markers = vec![1, 1];
    mesh.mesh_parts.truncate(1);
    mesh.mesh_parts[0].element_start = 0;
    mesh.mesh_parts[0].element_count = 2;
    mesh.mesh_parts[0].node_indices = (0..8).collect();
    let value = |point: [f64; 3]| 1.0 + point[0] + 2.0 * point[1] + 3.0 * point[2];
    let nodal_values = mesh.nodes.iter().copied().map(value).collect::<Vec<_>>();
    let element_means = [
        nodal_values[0..4].iter().sum::<f64>() / 4.0,
        nodal_values[4..8].iter().sum::<f64>() / 4.0,
    ];
    let element_volumes = [1.0 / 6.0, 1.0 / 3.0];
    let analytic_occupied_measure = element_volumes.iter().sum::<f64>();
    let analytic_mean = element_means
        .iter()
        .zip(element_volumes)
        .map(|(mean, volume)| mean * volume)
        .sum::<f64>()
        / analytic_occupied_measure;
    let element_count_mean = element_means.iter().sum::<f64>() / element_means.len() as f64;
    assert_ne!(element_volumes[0], element_volumes[1]);
    assert_ne!(element_means[0], element_means[1]);
    assert!((analytic_mean - element_count_mean).abs() > 0.1);
    let coarse = scalar_fem_field(mesh, nodal_values);
    let target = resolve_spatial_target(
        &coarse,
        &MonitorTargetIR::Domain,
        ResolvedSpatialScope::MonitorTarget,
        &PlanarOperatorIR::SlabAverage { thickness_m: 1.0 },
    )
    .unwrap();
    let refined = target.refine_uniform_p1_for_test();
    let req = request(
        explicit_frame(
            [0.0, 0.0, 0.5],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 4.0, 0.0, 1.0],
        ),
        PlanarOperatorIR::SlabAverage { thickness_m: 1.0 },
        [1, 1],
    );
    let coarse_sample = sample_resolved_target(&target, &req).unwrap();
    let refined_sample = sample_resolved_target(&refined, &req).unwrap();
    let pairs = coarse_sample
        .scalar_values
        .iter()
        .zip(refined_sample.scalar_values.iter())
        .filter(|(coarse, refined)| coarse.is_finite() && refined.is_finite())
        .collect::<Vec<_>>();
    assert_eq!(pairs.len(), 1, "slab must produce a non-empty sample pair");
    assert_ne!(coarse_sample.occupancy[0], super::Occupancy::Empty);
    assert_ne!(refined_sample.occupancy[0], super::Occupancy::Empty);
    assert!((coarse_sample.meta.occupied_measure - analytic_occupied_measure).abs() <= TOLERANCE);
    assert!((refined_sample.meta.occupied_measure - analytic_occupied_measure).abs() <= TOLERANCE);
    assert!(
        (coarse_sample.meta.occupied_measure - refined_sample.meta.occupied_measure).abs()
            <= TOLERANCE
    );
    for (coarse, refined) in pairs {
        assert!((coarse - refined).abs() <= TOLERANCE);
        assert!((coarse - analytic_mean).abs() <= TOLERANCE);
        assert!((refined - analytic_mean).abs() <= TOLERANCE);
    }
}

#[test]
fn sample_identity_distinguishes_target_operator_resolution_quality_and_quantity_revision() {
    let identity =
        |quantity_revision, target_fingerprint: &str, quality: &str, thickness_m, resolution| {
            PlanarSampleIdentity {
                session_id: "session-1".to_string(),
                source_kind: "monitor".to_string(),
                source_id: Some("monitor-1".to_string()),
                source_revision: 3,
                source_hash: "monitor-hash".to_string(),
                domain_generation_id: String::new(),
                scene_revision: 5,
                target_fingerprint: target_fingerprint.to_string(),
                target_kind: "object".to_string(),
                target_id: Some("body".to_string()),
                target_entity_count: 4,
                scope_kind: "monitor_target".to_string(),
                scope_id: None,
                quantity_id: "m".to_string(),
                component: "magnitude".to_string(),
                quantity_revision,
                field_generation: Some("run-1:5".to_string()),
                field_content_fingerprint: None,
                carrier_revision: 11,
                field_source_kind: "materialized".to_string(),
                source_backend: Some("fem".to_string()),
                source_device: Some("gpu".to_string()),
                source_precision: Some("double".to_string()),
                frame: explicit_frame(
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.0, 1.0, 0.0, 1.0],
                ),
                operator: PlanarOperatorIR::SlabAverage { thickness_m },
                resolution,
                quality: quality.to_string(),
            }
        };
    let base = identity(11, "target-fingerprint", "interactive", 0.25, [128, 128]);
    assert_ne!(
        base.cache_key(),
        identity(12, "target-fingerprint", "interactive", 0.25, [128, 128]).cache_key()
    );
    assert_ne!(
        base.cache_key(),
        identity(11, "other-target", "interactive", 0.25, [128, 128]).cache_key()
    );
    assert_ne!(
        base.cache_key(),
        identity(11, "target-fingerprint", "export", 0.25, [128, 128]).cache_key()
    );
    assert_ne!(
        base.cache_key(),
        identity(11, "target-fingerprint", "interactive", 0.5, [128, 128]).cache_key()
    );
    assert_ne!(
        base.cache_key(),
        identity(11, "target-fingerprint", "interactive", 0.25, [256, 128]).cache_key()
    );
}

#[test]
fn empty_target_fails_with_stable_diagnostic() {
    let field = fem_field(EntityMapping::Identity { entity_count: 8 }, vec![1.0; 24]);
    let error = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Object {
            object_id: "missing".to_string(),
        },
        ResolvedSpatialScope::MonitorTarget,
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap_err();
    assert!(error.message.starts_with("empty_target:"));
}

#[test]
fn ambiguous_fdm_membership_fails_closed() {
    let field = scalar_fdm_field(multi_object_membership(vec![0, 2]), vec![4.0, 9.0]);
    let error = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Object {
            object_id: "left".to_string(),
        },
        ResolvedSpatialScope::MonitorTarget,
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap_err();
    assert!(error.message.starts_with("ambiguous_membership:"));
}

#[test]
fn prism6_fem_cell_carrier_samples_without_tet4_fallback() {
    let mut mesh = fem_mesh();
    mesh.nodes[..6].copy_from_slice(&[
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [0.0, 1.0, 1.0],
    ]);
    mesh.cells = FemConnectivityIR {
        types: vec![FemCellTypeIR::Prism6],
        offsets: vec![0, 6],
        nodes: vec![0, 1, 2, 3, 4, 5],
        global_ordinals: vec![0],
        mesh_parts: vec![FemCellMeshPartIR::Magnetic],
    };
    mesh.element_markers = vec![1];
    mesh.mesh_parts[0].element_count = 1;
    let mesh = Box::leak(Box::new(mesh));
    let spec = quantity_spec("m").unwrap();
    let field = ResolvedSpatialField {
        quantity_id: "m".to_string(),
        quantity_kind: spec.shape,
        canonical_unit: spec.unit.to_string(),
        component_count: 3,
        default_component: spec.default_component,
        source_kind: SpatialFieldSourceKind::Materialized,
        provenance: SpatialFieldProvenance {
            backend: Some("fem".to_string()),
            device: None,
            precision: Some("double".to_string()),
        },
        field_generation: None,
        quantity_revision: 7,
        mesh_or_grid_revision: 11,
        source_grid: None,
        values: vec![1.0; 8 * 3],
        carrier: SpatialFieldCarrier::FemNodes {
            topology: mesh,
            topology_fingerprint: "mixed".to_string(),
            mapping: EntityMapping::Identity { entity_count: 8 },
        },
    };
    let target = resolve_spatial_target(
        &field,
        &MonitorTargetIR::MagneticDomain,
        ResolvedSpatialScope::MonitorTarget,
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap();
    let sample = sample_resolved_target(
        &target,
        &ResolvedPlanarSampleRequest {
            component: PlanarComponent::Magnitude,
            ..request(
                explicit_frame(
                    [0.0, 0.0, 0.5],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.0, 0.5, 0.0, 0.5],
                ),
                PlanarOperatorIR::PlaneSample,
                [1, 1],
            )
        },
    )
    .unwrap();
    assert_eq!(sample.scalar_values, vec![3.0_f64.sqrt()]);
}

#[test]
fn out_of_range_selected_tet4_node_fails_without_panicking() {
    let mut mesh = fem_mesh();
    mesh.cells = FemConnectivityIR::from_tet4(vec![[0, 1, 2, 99], [4, 5, 6, 7]]);
    let field = fem_field_with_mesh(
        mesh,
        EntityMapping::Identity { entity_count: 8 },
        vec![1.0; 24],
    );
    let error = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Object {
            object_id: "left".to_string(),
        },
        ResolvedSpatialScope::MonitorTarget,
        &PlanarOperatorIR::PlaneSample,
    )
    .unwrap_err();
    assert!(error.message.contains("node") && error.message.contains("range"));
}

#[test]
fn illegal_surface_support_fails_without_substitution() {
    let field = scalar_fdm_field(multi_object_membership(vec![1, 2]), vec![4.0, 9.0]);
    let error = resolve_spatial_target(
        &field,
        &MonitorTargetIR::Domain,
        ResolvedSpatialScope::MonitorTarget,
        &PlanarOperatorIR::SurfaceProjection {
            boundary: fullmag_ir::SurfaceBoundarySelectorIR::ObjectBoundary,
            visibility_policy: fullmag_ir::SurfaceVisibilityPolicyIR::Frontmost,
        },
    )
    .unwrap_err();
    assert!(error.message.contains("surface") || error.message.contains("boundary"));
}
