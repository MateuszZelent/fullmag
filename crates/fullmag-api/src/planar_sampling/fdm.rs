use crate::error::ApiError;
use fullmag_ir::{EmptyPolicyIR, PlanarOperatorIR, PlanarReductionIR};
use std::collections::BTreeMap;

use super::frame::ResolvedFrame;
use super::geometry::{integrate_clipped_tetra, projected_pixel_bounds, LinearVertex};
use super::provenance;
use super::reduction::{AccumulatorReduction, WeightedAccumulator};
use super::{
    FdmPlanarField, Occupancy, PlanarCompatibilityReduction, PlanarComponent, PlanarMeshOverlay,
    PlanarOverlaySegment, PlanarOverlaySegmentKind, PlanarSampleResult,
    ResolvedPlanarSampleRequest,
};

pub(crate) const MAX_FDM_PLANAR_GRID_SEGMENTS: usize = 200_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum GridIntersectionKey {
    Vertex([u32; 3]),
    Edge([u32; 3], [u32; 3]),
}

#[derive(Debug, Clone, Copy)]
struct GridIntersectionPoint {
    key: GridIntersectionKey,
    uv: [f64; 2],
}

pub(super) fn build_grid_overlay(
    field: &FdmPlanarField,
    frame: &ResolvedFrame,
) -> Result<PlanarMeshOverlay, ApiError> {
    const CORNERS: [[u32; 3]; 8] = [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [0, 0, 1],
        [1, 0, 1],
        [0, 1, 1],
        [1, 1, 1],
    ];
    const EDGES: [(usize, usize); 12] = [
        (0, 1),
        (0, 2),
        (1, 3),
        (2, 3),
        (4, 5),
        (4, 6),
        (5, 7),
        (6, 7),
        (0, 4),
        (1, 5),
        (2, 6),
        (3, 7),
    ];
    let grid = field.grid();
    let origin = field.origin();
    let spacing = field.spacing();
    let tolerance = spacing.into_iter().fold(0.0_f64, f64::max) * 1.0e-12;
    let mut unique =
        BTreeMap::<(GridIntersectionKey, GridIntersectionKey), PlanarOverlaySegment>::new();

    for z in 0..grid[2] {
        for y in 0..grid[1] {
            for x in 0..grid[0] {
                let cell = ((z * grid[1] + y) * grid[0] + x) as usize;
                if !field.contains_cell(cell) {
                    continue;
                }
                let lattice = CORNERS.map(|offset| [x + offset[0], y + offset[1], z + offset[2]]);
                let world = lattice.map(|point| {
                    [
                        origin[0] + point[0] as f64 * spacing[0],
                        origin[1] + point[1] as f64 * spacing[1],
                        origin[2] + point[2] as f64 * spacing[2],
                    ]
                });
                let projected = world.map(|point| frame.project(point));
                let mut points = BTreeMap::<GridIntersectionKey, [f64; 2]>::new();
                for (a, b) in EDGES {
                    let da = projected[a][2];
                    let db = projected[b][2];
                    if da.abs() <= tolerance {
                        points.insert(
                            GridIntersectionKey::Vertex(lattice[a]),
                            [projected[a][0], projected[a][1]],
                        );
                    }
                    if db.abs() <= tolerance {
                        points.insert(
                            GridIntersectionKey::Vertex(lattice[b]),
                            [projected[b][0], projected[b][1]],
                        );
                    }
                    if (da < -tolerance && db > tolerance) || (da > tolerance && db < -tolerance) {
                        let (first, second) = if lattice[a] <= lattice[b] {
                            (lattice[a], lattice[b])
                        } else {
                            (lattice[b], lattice[a])
                        };
                        let pa = if lattice[a] == first {
                            projected[a]
                        } else {
                            projected[b]
                        };
                        let pb = if lattice[a] == first {
                            projected[b]
                        } else {
                            projected[a]
                        };
                        let t = pa[2] / (pa[2] - pb[2]);
                        points.insert(
                            GridIntersectionKey::Edge(first, second),
                            [pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1])],
                        );
                    }
                }
                if points.len() < 3 {
                    continue;
                }
                let center = [
                    points.values().map(|point| point[0]).sum::<f64>() / points.len() as f64,
                    points.values().map(|point| point[1]).sum::<f64>() / points.len() as f64,
                ];
                let mut ordered = points
                    .into_iter()
                    .map(|(key, uv)| GridIntersectionPoint { key, uv })
                    .collect::<Vec<_>>();
                ordered.sort_by(|left, right| {
                    (left.uv[1] - center[1])
                        .atan2(left.uv[0] - center[0])
                        .total_cmp(&(right.uv[1] - center[1]).atan2(right.uv[0] - center[0]))
                });
                for index in 0..ordered.len() {
                    let a = ordered[index];
                    let b = ordered[(index + 1) % ordered.len()];
                    let key = if a.key <= b.key {
                        (a.key, b.key)
                    } else {
                        (b.key, a.key)
                    };
                    if let Some((a_uv_m, b_uv_m)) = clip_segment_to_bounds(a.uv, b.uv, frame.bounds)
                    {
                        unique.insert(
                            key,
                            PlanarOverlaySegment {
                                a_uv_m,
                                b_uv_m,
                                kind: PlanarOverlaySegmentKind::UnclassifiedDegenerate,
                            },
                        );
                    }
                }
                if unique.len() > MAX_FDM_PLANAR_GRID_SEGMENTS {
                    return Err(ApiError::unprocessable(format!(
                        "planar_mesh_budget_exceeded: FDM grid overlay exceeds {MAX_FDM_PLANAR_GRID_SEGMENTS} segments"
                    )));
                }
            }
        }
    }
    Ok(PlanarMeshOverlay {
        frame_origin_m: frame.origin,
        frame_u_axis: frame.u,
        frame_v_axis: frame.v,
        frame_normal: frame.normal,
        bounds_uv_m: frame.bounds,
        polygons: Vec::new(),
        segments: unique.into_values().collect(),
    })
}

fn clip_segment_to_bounds(
    a: [f64; 2],
    b: [f64; 2],
    bounds: [f64; 4],
) -> Option<([f64; 2], [f64; 2])> {
    let delta = [b[0] - a[0], b[1] - a[1]];
    let mut t0 = 0.0_f64;
    let mut t1 = 1.0_f64;
    for (p, q) in [
        (-delta[0], a[0] - bounds[0]),
        (delta[0], bounds[1] - a[0]),
        (-delta[1], a[1] - bounds[2]),
        (delta[1], bounds[3] - a[1]),
    ] {
        if p.abs() <= f64::EPSILON {
            if q < 0.0 {
                return None;
            }
            continue;
        }
        let ratio = q / p;
        if p < 0.0 {
            t0 = t0.max(ratio);
        } else {
            t1 = t1.min(ratio);
        }
        if t0 > t1 {
            return None;
        }
    }
    let start = [a[0] + t0 * delta[0], a[1] + t0 * delta[1]];
    let end = [a[0] + t1 * delta[0], a[1] + t1 * delta[1]];
    (start != end && start.iter().chain(&end).all(|value| value.is_finite()))
        .then_some((start, end))
}

pub(super) fn sample(
    field: &FdmPlanarField,
    request: &ResolvedPlanarSampleRequest,
) -> Result<PlanarSampleResult, ApiError> {
    let frame = ResolvedFrame::try_from_ir(&request.frame)?;
    match &request.operator {
        PlanarOperatorIR::PlaneSample => sample_plane(field, request, frame),
        PlanarOperatorIR::SlabAverage { thickness_m } => sample_volume(
            field,
            request,
            frame,
            Some(*thickness_m),
            PlanarReductionIR::MeanOccupied.into(),
            false,
        ),
        PlanarOperatorIR::DepthProjection {
            reduction,
            empty_policy,
        } => sample_volume(
            field,
            request,
            frame,
            None,
            (*reduction).into(),
            *empty_policy == EmptyPolicyIR::IncludeAirAsZero,
        ),
        PlanarOperatorIR::SurfaceProjection { .. } => Err(ApiError::unprocessable(
            "unsupported_planar_operator: FDM boundary surface topology is not published",
        )),
    }
}

pub(super) fn sample_compatibility_depth(
    field: &FdmPlanarField,
    request: &ResolvedPlanarSampleRequest,
    reduction: PlanarCompatibilityReduction,
    include_air_as_zero: bool,
) -> Result<PlanarSampleResult, ApiError> {
    let frame = ResolvedFrame::try_from_ir(&request.frame)?;
    let reduction = match reduction {
        PlanarCompatibilityReduction::WeightedSum => AccumulatorReduction::WeightedSum,
        PlanarCompatibilityReduction::SampleSum { normal_step } => {
            AccumulatorReduction::SampleSum { normal_step }
        }
        PlanarCompatibilityReduction::Stddev => AccumulatorReduction::Stddev,
    };
    sample_volume(field, request, frame, None, reduction, include_air_as_zero)
}

fn sample_plane(
    field: &FdmPlanarField,
    request: &ResolvedPlanarSampleRequest,
    frame: ResolvedFrame,
) -> Result<PlanarSampleResult, ApiError> {
    let pixel_count = request.resolution[0] as usize * request.resolution[1] as usize;
    let mut occupancy = vec![Occupancy::Empty; pixel_count];
    let mut vectors = vec![[f64::NAN; 3]; pixel_count];
    let mut scalars = vec![f64::NAN; pixel_count];
    let mut source_entity_ids = vec![None; pixel_count];
    for y in 0..request.resolution[1] {
        for x in 0..request.resolution[0] {
            let uv = frame.pixel_center(x, y, request.resolution);
            let point = frame.point(uv[0], uv[1], 0.0);
            let index = (y * request.resolution[0] + x) as usize;
            let Some((cell_id, value)) = cell_value_at(field, point) else {
                continue;
            };
            occupancy[index] = Occupancy::Occupied;
            source_entity_ids[index] = Some(cell_id);
            write_value(value, &mut scalars[index], &mut vectors[index]);
        }
    }
    Ok(PlanarSampleResult {
        meta: provenance::meta(
            request,
            "fdm_cell_constant_plane",
            &occupancy,
            0.0,
            0,
            0,
            0,
            0,
        ),
        scalar_values: scalars,
        vector_values: (field.n_comp() >= 3).then_some(vectors),
        occupancy,
        source_entity_ids,
        overlay: None,
    })
}

fn sample_volume(
    field: &FdmPlanarField,
    request: &ResolvedPlanarSampleRequest,
    frame: ResolvedFrame,
    thickness: Option<f64>,
    reduction: AccumulatorReduction,
    include_air_as_zero: bool,
) -> Result<PlanarSampleResult, ApiError> {
    let pixel_count = request.resolution[0] as usize * request.resolution[1] as usize;
    let mut scalar_accumulators = (0..pixel_count)
        .map(|_| WeightedAccumulator::new(1))
        .collect::<Vec<_>>();
    let mut vector_accumulators = (field.n_comp() >= 3).then(|| {
        (0..pixel_count)
            .map(|_| WeightedAccumulator::new(3))
            .collect::<Vec<_>>()
    });
    let grid = field.grid();
    let origin = field.origin();
    let spacing = field.spacing();
    let half = thickness.map(|value| value * 0.5);
    let s_bounds = half
        .map(|value| [-value, value])
        .unwrap_or([f64::NEG_INFINITY, f64::INFINITY]);
    let du = (frame.bounds[1] - frame.bounds[0]) / request.resolution[0] as f64;
    let dv = (frame.bounds[3] - frame.bounds[2]) / request.resolution[1] as f64;
    const CELL_TETRAHEDRA: [[usize; 4]; 6] = [
        [0, 1, 3, 7],
        [0, 3, 2, 7],
        [0, 2, 6, 7],
        [0, 6, 4, 7],
        [0, 4, 5, 7],
        [0, 5, 1, 7],
    ];

    for z in 0..grid[2] {
        for y in 0..grid[1] {
            for x in 0..grid[0] {
                let cell = ((z * grid[1] + y) * grid[0] + x) as usize;
                if !field.contains_cell(cell) {
                    continue;
                }
                let start = cell * field.n_comp();
                let value = field.values()[start..start + field.n_comp()].to_vec();
                let scalar_val = if field.n_comp() == 1 {
                    value[0]
                } else {
                    crate::planar_sampling::element_evaluator::evaluate_vector_quantity(
                        [value[0], value[1], value[2]],
                        request.component,
                        frame.u,
                        frame.v,
                        frame.normal,
                    )
                };
                let low = [
                    origin[0] + x as f64 * spacing[0],
                    origin[1] + y as f64 * spacing[1],
                    origin[2] + z as f64 * spacing[2],
                ];
                let corners = [
                    [low[0], low[1], low[2]],
                    [low[0] + spacing[0], low[1], low[2]],
                    [low[0], low[1] + spacing[1], low[2]],
                    [low[0] + spacing[0], low[1] + spacing[1], low[2]],
                    [low[0], low[1], low[2] + spacing[2]],
                    [low[0] + spacing[0], low[1], low[2] + spacing[2]],
                    [low[0], low[1] + spacing[1], low[2] + spacing[2]],
                    [
                        low[0] + spacing[0],
                        low[1] + spacing[1],
                        low[2] + spacing[2],
                    ],
                ]
                .map(|position| LinearVertex {
                    position: frame.project(position),
                    value: value.clone(),
                });
                for tetrahedron in CELL_TETRAHEDRA {
                    let vertices = tetrahedron.map(|index| corners[index].clone());
                    let Some((x_bounds, y_bounds)) = projected_pixel_bounds(
                        &vertices,
                        frame.bounds,
                        request.resolution,
                        s_bounds,
                    ) else {
                        continue;
                    };
                    for pixel_y in y_bounds[0]..=y_bounds[1] {
                        for pixel_x in x_bounds[0]..=x_bounds[1] {
                            let pixel = (pixel_y * request.resolution[0] + pixel_x) as usize;
                            let u_min = frame.bounds[0] + pixel_x as f64 * du;
                            let v_min = frame.bounds[2] + pixel_y as f64 * dv;
                            let contribution = integrate_clipped_tetra(
                                vertices.clone(),
                                [
                                    u_min,
                                    u_min + du,
                                    v_min,
                                    v_min + dv,
                                    s_bounds[0],
                                    s_bounds[1],
                                ],
                            );
                            if contribution.measure > 0.0 {
                                scalar_accumulators[pixel]
                                    .add_constant(&[scalar_val], contribution.measure);
                                if let Some(v_accs) = vector_accumulators.as_mut() {
                                    v_accs[pixel]
                                        .add_constant(&value[0..3], contribution.measure);
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let pixel_area = ((frame.bounds[1] - frame.bounds[0]) * (frame.bounds[3] - frame.bounds[2]))
        .abs()
        / pixel_count as f64;
    finish_reduction_dual(
        request,
        scalar_accumulators,
        vector_accumulators,
        reduction,
        pixel_area,
        include_air_as_zero,
        "fdm_cell_volume_weighted",
        thickness.map(|value| pixel_area * value),
        0,
        1,
    )
}

pub(super) fn finish_reduction_dual(
    request: &ResolvedPlanarSampleRequest,
    scalar_accumulators: Vec<WeightedAccumulator>,
    vector_accumulators: Option<Vec<WeightedAccumulator>>,
    reduction: AccumulatorReduction,
    pixel_area: f64,
    include_air_as_zero: bool,
    method: &'static str,
    full_measure: Option<f64>,
    basis_order: u8,
    integration_order: u8,
) -> Result<PlanarSampleResult, ApiError> {
    let count = scalar_accumulators.len();
    let mut occupancy = Vec::with_capacity(count);
    let mut scalar_values = Vec::with_capacity(count);
    let mut occupied_measure = 0.0;

    let vector_values = vector_accumulators.map(|v_accs| {
        v_accs
            .into_iter()
            .map(|acc| match acc.finish(AccumulatorReduction::MeanOccupied, pixel_area) {
                Some(v) => [v[0], v[1], v[2]],
                None => [f64::NAN; 3],
            })
            .collect::<Vec<[f64; 3]>>()
    });

    if request.component == PlanarComponent::Orientation && vector_values.is_some() {
        let v_vals = vector_values.as_ref().unwrap();
        let orientation_epsilon = v_vals
            .iter()
            .map(|v| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt())
            .fold(0.0_f64, f64::max)
            * 1.0e-12;
        let orientation_epsilon = orientation_epsilon.max(1.0e-12);

        for (i, accumulator) in scalar_accumulators.iter().enumerate() {
            occupied_measure += accumulator.weight();
            let v = v_vals[i];
            if accumulator.weight() <= 0.0 {
                occupancy.push(Occupancy::Empty);
                scalar_values.push(if include_air_as_zero { 0.0 } else { f64::NAN });
            } else if !v[0].is_finite() || !v[1].is_finite() || !v[2].is_finite() {
                occupancy.push(Occupancy::UndefinedOrientation);
                scalar_values.push(f64::NAN);
            } else {
                let u = v[0] * request.frame.u_axis[0]
                    + v[1] * request.frame.u_axis[1]
                    + v[2] * request.frame.u_axis[2];
                let v_proj = v[0] * request.frame.v_axis[0]
                    + v[1] * request.frame.v_axis[1]
                    + v[2] * request.frame.v_axis[2];
                let in_plane_norm = (u * u + v_proj * v_proj).sqrt();
                if !in_plane_norm.is_finite() || in_plane_norm <= orientation_epsilon {
                    occupancy.push(Occupancy::UndefinedOrientation);
                    scalar_values.push(f64::NAN);
                } else {
                    let occ = if full_measure
                        .is_some_and(|full| accumulator.weight() < full * (1.0 - 1.0e-10))
                    {
                        Occupancy::Partial
                    } else {
                        Occupancy::Occupied
                    };
                    occupancy.push(occ);
                    let angle = v_proj.atan2(u).rem_euclid(std::f64::consts::TAU)
                        / std::f64::consts::TAU;
                    scalar_values.push(angle);
                }
            }
        }
    } else {
        for accumulator in &scalar_accumulators {
            occupied_measure += accumulator.weight();
            match accumulator.finish(reduction, pixel_area) {
                Some(value) => {
                    let val = value[0];
                    if !val.is_finite() {
                        if request.component == PlanarComponent::Orientation {
                            occupancy.push(Occupancy::UndefinedOrientation);
                            scalar_values.push(f64::NAN);
                        } else {
                            occupancy.push(Occupancy::Empty);
                            scalar_values.push(if include_air_as_zero { 0.0 } else { f64::NAN });
                        }
                    } else {
                        occupancy.push(
                            if full_measure
                                .is_some_and(|full| accumulator.weight() < full * (1.0 - 1.0e-10))
                            {
                                Occupancy::Partial
                            } else {
                                Occupancy::Occupied
                            },
                        );
                        scalar_values.push(val);
                    }
                }
                None => {
                    occupancy.push(Occupancy::Empty);
                    scalar_values.push(if include_air_as_zero { 0.0 } else { f64::NAN });
                }
            }
        }
    }

    Ok(PlanarSampleResult {
        meta: provenance::meta(
            request,
            method,
            &occupancy,
            occupied_measure,
            0,
            0,
            basis_order,
            integration_order,
        ),
        scalar_values,
        vector_values,
        source_entity_ids: vec![None; count],
        occupancy,
        overlay: None,
    })
}

pub(super) fn finish_reduction(
    n_comp: usize,
    request: &ResolvedPlanarSampleRequest,
    accumulators: Vec<WeightedAccumulator>,
    reduction: AccumulatorReduction,
    pixel_area: f64,
    include_air_as_zero: bool,
    method: &'static str,
    full_measure: Option<f64>,
) -> Result<PlanarSampleResult, ApiError> {
    let mut occupancy = Vec::with_capacity(accumulators.len());
    let mut scalar_values = Vec::with_capacity(accumulators.len());
    let mut vector_values = Vec::with_capacity(accumulators.len());
    let mut occupied_measure = 0.0;
    for accumulator in accumulators {
        occupied_measure += accumulator.weight();
        match accumulator.finish(reduction, pixel_area) {
            Some(value) => {
                let val = if n_comp == 1 {
                    value[0]
                } else {
                    crate::planar_sampling::element_evaluator::evaluate_vector_quantity(
                        [value[0], value[1], value[2]],
                        request.component,
                        request.frame.u_axis,
                        request.frame.v_axis,
                        request.frame.normal,
                    )
                };
                if request.component == PlanarComponent::Orientation && val.is_nan() {
                    occupancy.push(Occupancy::UndefinedOrientation);
                    scalar_values.push(f64::NAN);
                } else {
                    occupancy.push(
                        if full_measure
                            .is_some_and(|full| accumulator.weight() < full * (1.0 - 1.0e-10))
                        {
                            Occupancy::Partial
                        } else {
                            Occupancy::Occupied
                        },
                    );
                    scalar_values.push(val);
                }
                vector_values.push(if n_comp >= 3 {
                    [value[0], value[1], value[2]]
                } else {
                    [f64::NAN; 3]
                });
            }
            None => {
                occupancy.push(Occupancy::Empty);
                scalar_values.push(if include_air_as_zero { 0.0 } else { f64::NAN });
                vector_values.push([f64::NAN; 3]);
            }
        }
    }
    Ok(PlanarSampleResult {
        meta: provenance::meta(request, method, &occupancy, occupied_measure, 0, 0, 0, 1),
        scalar_values,
        vector_values: (n_comp >= 3).then_some(vector_values),
        source_entity_ids: vec![None; occupancy.len()],
        occupancy,
        overlay: None,
    })
}

fn cell_value_at(field: &FdmPlanarField, point: [f64; 3]) -> Option<(u32, &[f64])> {
    let mut index = [0u32; 3];
    for axis in 0..3 {
        let coordinate = (point[axis] - field.origin()[axis]) / field.spacing()[axis];
        if coordinate < 0.0 || coordinate >= field.grid()[axis] as f64 {
            return None;
        }
        index[axis] = coordinate.floor() as u32;
    }
    let cell = ((index[2] * field.grid()[1] + index[1]) * field.grid()[0] + index[0]) as usize;
    if !field.contains_cell(cell) {
        return None;
    }
    let start = cell * field.n_comp();
    Some((cell as u32, &field.values()[start..start + field.n_comp()]))
}

fn write_value(value: &[f64], scalar: &mut f64, vector: &mut [f64; 3]) {
    *scalar = if value.len() == 1 {
        value[0]
    } else {
        value
            .iter()
            .map(|component| component * component)
            .sum::<f64>()
            .sqrt()
    };
    if value.len() >= 3 {
        *vector = [value[0], value[1], value[2]];
    }
}
