use crate::error::ApiError;
use fullmag_ir::{EmptyPolicyIR, PlanarOperatorIR, PlanarReductionIR};

use super::fdm::finish_reduction;
use super::frame::{cross, dot, ResolvedFrame};
use super::geometry::{integrate_clipped_tetra, projected_pixel_bounds, LinearVertex};
use super::provenance;
use super::reduction::{AccumulatorReduction, WeightedAccumulator};
use super::surface;
use super::{
    FemPlanarField, Occupancy, PlanarCompatibilityReduction, PlanarSampleResult,
    ResolvedPlanarSampleRequest,
};
use super::{PlanarMeshOverlay, PlanarOverlayPolygon, PlanarOverlaySegment};

pub(super) fn sample(
    field: &FemPlanarField,
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
        PlanarOperatorIR::SurfaceProjection {
            boundary,
            visibility_policy,
        } => match boundary {
            fullmag_ir::SurfaceBoundarySelectorIR::ObjectBoundary => {
                surface::sample_boundary(field, request, frame, *visibility_policy)
            }
            fullmag_ir::SurfaceBoundarySelectorIR::RegionBoundary { .. } => {
                Err(ApiError::unprocessable_entity(
                    "unsupported_region_boundary_projection: FEM region-boundary topology is not published",
                ))
            }
            fullmag_ir::SurfaceBoundarySelectorIR::NamedSurface { .. } => {
                Err(ApiError::unprocessable_entity(
                    "unsupported_named_surface_projection: FEM named-surface topology is not published",
                ))
            }
        },
    }
}

pub(super) fn sample_compatibility_depth(
    field: &FemPlanarField,
    request: &ResolvedPlanarSampleRequest,
    reduction: PlanarCompatibilityReduction,
) -> Result<PlanarSampleResult, ApiError> {
    let frame = ResolvedFrame::try_from_ir(&request.frame)?;
    let reduction = match reduction {
        PlanarCompatibilityReduction::WeightedSum => AccumulatorReduction::WeightedSum,
        PlanarCompatibilityReduction::SampleSum { normal_step } => {
            AccumulatorReduction::SampleSum { normal_step }
        }
        PlanarCompatibilityReduction::Stddev => AccumulatorReduction::Stddev,
    };
    sample_volume(field, request, frame, None, reduction, false)
}

pub(super) fn build_overlay(field: &FemPlanarField, frame: &ResolvedFrame) -> PlanarMeshOverlay {
    const EDGES: [(usize, usize); 6] = [(0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)];
    let mut polygons = Vec::new();
    let mut segments = Vec::new();
    for (element_index, element) in field.elements().iter().enumerate() {
        if field.markers().get(element_index).copied().unwrap_or(1) == 0 {
            continue;
        }
        let nodes = element.map(|index| field.nodes()[index as usize]);
        let projected = nodes.map(|point| frame.project(point));
        let mut points = Vec::<([f64; 2], [f64; 3])>::new();
        for (a, b) in EDGES {
            let da = projected[a][2];
            let db = projected[b][2];
            if da.abs() <= 1.0e-12 {
                push_overlay_point(&mut points, [projected[a][0], projected[a][1]], nodes[a]);
            }
            if db.abs() <= 1.0e-12 {
                push_overlay_point(&mut points, [projected[b][0], projected[b][1]], nodes[b]);
            }
            if da.signum() == db.signum() || (da - db).abs() <= f64::EPSILON {
                continue;
            }
            let t = da / (da - db);
            let world =
                [0, 1, 2].map(|axis| nodes[a][axis] + t * (nodes[b][axis] - nodes[a][axis]));
            let uv = [
                projected[a][0] + t * (projected[b][0] - projected[a][0]),
                projected[a][1] + t * (projected[b][1] - projected[a][1]),
            ];
            push_overlay_point(&mut points, uv, world);
        }
        if points.len() < 3 {
            continue;
        }
        let center = [
            points.iter().map(|point| point.0[0]).sum::<f64>() / points.len() as f64,
            points.iter().map(|point| point.0[1]).sum::<f64>() / points.len() as f64,
        ];
        points.sort_by(|a, b| {
            (a.0[1] - center[1])
                .atan2(a.0[0] - center[0])
                .total_cmp(&(b.0[1] - center[1]).atan2(b.0[0] - center[0]))
        });
        for index in 0..points.len() {
            segments.push(PlanarOverlaySegment {
                a_uv_m: points[index].0,
                b_uv_m: points[(index + 1) % points.len()].0,
            });
        }
        polygons.push(PlanarOverlayPolygon {
            vertices_uv_m: points.iter().map(|point| point.0).collect(),
            parent_element_id: element_index as u32,
        });
    }
    PlanarMeshOverlay {
        frame_origin_m: frame.origin,
        frame_u_axis: frame.u,
        frame_v_axis: frame.v,
        frame_normal: frame.normal,
        bounds_uv_m: frame.bounds,
        polygons,
        segments,
    }
}

fn push_overlay_point(points: &mut Vec<([f64; 2], [f64; 3])>, uv: [f64; 2], world: [f64; 3]) {
    if points
        .iter()
        .any(|point| (point.0[0] - uv[0]).powi(2) + (point.0[1] - uv[1]).powi(2) <= 1.0e-24)
    {
        return;
    }
    points.push((uv, world));
}

fn sample_plane(
    field: &FemPlanarField,
    request: &ResolvedPlanarSampleRequest,
    frame: ResolvedFrame,
) -> Result<PlanarSampleResult, ApiError> {
    let pixel_count = request.resolution[0] as usize * request.resolution[1] as usize;
    let mut occupancy = vec![Occupancy::Empty; pixel_count];
    let mut scalar_values = vec![f64::NAN; pixel_count];
    let mut vector_values = vec![[f64::NAN; 3]; pixel_count];
    let mut source_entity_ids = vec![None; pixel_count];
    let du = (frame.bounds[1] - frame.bounds[0]) / request.resolution[0] as f64;
    let dv = (frame.bounds[3] - frame.bounds[2]) / request.resolution[1] as f64;
    for (element_index, element) in field.elements().iter().enumerate() {
        if field.markers().get(element_index).copied().unwrap_or(1) == 0 {
            continue;
        }
        let nodes = element.map(|index| field.nodes()[index as usize]);
        let projected = nodes.map(|point| frame.project(point));
        let n_min = projected
            .iter()
            .map(|point| point[2])
            .fold(f64::INFINITY, f64::min);
        let n_max = projected
            .iter()
            .map(|point| point[2])
            .fold(f64::NEG_INFINITY, f64::max);
        if n_min > 0.0 || n_max < 0.0 {
            continue;
        }
        let u_min = projected
            .iter()
            .map(|point| point[0])
            .fold(f64::INFINITY, f64::min);
        let u_max = projected
            .iter()
            .map(|point| point[0])
            .fold(f64::NEG_INFINITY, f64::max);
        let v_min = projected
            .iter()
            .map(|point| point[1])
            .fold(f64::INFINITY, f64::min);
        let v_max = projected
            .iter()
            .map(|point| point[1])
            .fold(f64::NEG_INFINITY, f64::max);
        let Some((x_start, x_end)) =
            pixel_center_range(u_min, u_max, frame.bounds[0], du, request.resolution[0])
        else {
            continue;
        };
        let Some((y_start, y_end)) =
            pixel_center_range(v_min, v_max, frame.bounds[2], dv, request.resolution[1])
        else {
            continue;
        };
        for y in y_start..=y_end {
            for x in x_start..=x_end {
                let index = (y * request.resolution[0] + x) as usize;
                if occupancy[index] != Occupancy::Empty {
                    continue;
                }
                let uv = frame.pixel_center(x, y, request.resolution);
                let point = frame.point(uv[0], uv[1], 0.0);
                let Some(value) = interpolate_element(field, element, nodes, point) else {
                    continue;
                };
                occupancy[index] = Occupancy::Occupied;
                source_entity_ids[index] = Some(element_index as u32);
                scalar_values[index] = if field.n_comp() == 1 {
                    value[0]
                } else {
                    value
                        .iter()
                        .map(|component| component * component)
                        .sum::<f64>()
                        .sqrt()
                };
                if field.n_comp() >= 3 {
                    vector_values[index] = [value[0], value[1], value[2]];
                }
            }
        }
    }
    let overlay = build_overlay(field, &frame);
    for polygon in &overlay.polygons {
        if polygon.vertices_uv_m.is_empty() {
            continue;
        }
        let centroid = [
            polygon
                .vertices_uv_m
                .iter()
                .map(|point| point[0])
                .sum::<f64>()
                / polygon.vertices_uv_m.len() as f64,
            polygon
                .vertices_uv_m
                .iter()
                .map(|point| point[1])
                .sum::<f64>()
                / polygon.vertices_uv_m.len() as f64,
        ];
        let x = (((centroid[0] - frame.bounds[0]) / (frame.bounds[1] - frame.bounds[0])
            * request.resolution[0] as f64)
            .floor() as i64)
            .clamp(0, request.resolution[0] as i64 - 1) as u32;
        let y = (((centroid[1] - frame.bounds[2]) / (frame.bounds[3] - frame.bounds[2])
            * request.resolution[1] as f64)
            .floor() as i64)
            .clamp(0, request.resolution[1] as i64 - 1) as u32;
        let index = (y * request.resolution[0] + x) as usize;
        if occupancy[index] != Occupancy::Empty {
            continue;
        }
        let Some((element_id, value)) =
            interpolate_at(field, frame.point(centroid[0], centroid[1], 0.0))
        else {
            continue;
        };
        occupancy[index] = Occupancy::Occupied;
        source_entity_ids[index] = Some(element_id);
        scalar_values[index] = if field.n_comp() == 1 {
            value[0]
        } else {
            value
                .iter()
                .map(|component| component * component)
                .sum::<f64>()
                .sqrt()
        };
        if field.n_comp() >= 3 {
            vector_values[index] = [value[0], value[1], value[2]];
        }
    }
    Ok(PlanarSampleResult {
        meta: provenance::meta(
            request,
            "fem_p1_barycentric_plane",
            &occupancy,
            0.0,
            0,
            0,
            1,
            0,
        ),
        scalar_values,
        vector_values: (field.n_comp() >= 3).then_some(vector_values),
        occupancy,
        source_entity_ids,
        overlay: None,
    })
}

fn pixel_center_range(
    projected_min: f64,
    projected_max: f64,
    frame_min: f64,
    pixel_size: f64,
    resolution: u32,
) -> Option<(u32, u32)> {
    let first = ((projected_min - frame_min) / pixel_size - 0.5).ceil() as i64;
    let last = ((projected_max - frame_min) / pixel_size - 0.5).floor() as i64;
    let first = first.max(0);
    let last = last.min(resolution as i64 - 1);
    (first <= last).then_some((first as u32, last as u32))
}

fn sample_volume(
    field: &FemPlanarField,
    request: &ResolvedPlanarSampleRequest,
    frame: ResolvedFrame,
    thickness: Option<f64>,
    reduction: AccumulatorReduction,
    include_air_as_zero: bool,
) -> Result<PlanarSampleResult, ApiError> {
    let count = request.resolution[0] as usize * request.resolution[1] as usize;
    let mut accumulators = (0..count)
        .map(|_| WeightedAccumulator::new(field.n_comp()))
        .collect::<Vec<_>>();
    let du = (frame.bounds[1] - frame.bounds[0]) / request.resolution[0] as f64;
    let dv = (frame.bounds[3] - frame.bounds[2]) / request.resolution[1] as f64;
    let s_bounds = thickness
        .map(|value| [-value * 0.5, value * 0.5])
        .unwrap_or([f64::NEG_INFINITY, f64::INFINITY]);
    for (element_index, element) in field.elements().iter().enumerate() {
        if field.markers().get(element_index).copied().unwrap_or(1) == 0 {
            continue;
        }
        let nodes = element.map(|index| field.nodes()[index as usize]);
        if tetra_volume(nodes) <= 0.0 {
            continue;
        }
        let projected: [LinearVertex; 4] = std::array::from_fn(|local| LinearVertex {
            position: frame.project(nodes[local]),
            value: (0..field.n_comp())
                .map(|component| {
                    field.values()[element[local] as usize * field.n_comp() + component]
                })
                .collect(),
        });
        let Some((x_bounds, y_bounds)) =
            projected_pixel_bounds(&projected, frame.bounds, request.resolution, s_bounds)
        else {
            continue;
        };
        for y in y_bounds[0]..=y_bounds[1] {
            for x in x_bounds[0]..=x_bounds[1] {
                let pixel = (y * request.resolution[0] + x) as usize;
                let u_min = frame.bounds[0] + x as f64 * du;
                let v_min = frame.bounds[2] + y as f64 * dv;
                let contribution = integrate_clipped_tetra(
                    projected.clone(),
                    [
                        u_min,
                        u_min + du,
                        v_min,
                        v_min + dv,
                        s_bounds[0],
                        s_bounds[1],
                    ],
                );
                if contribution.measure <= 0.0 {
                    continue;
                }
                let mean = contribution
                    .integral
                    .iter()
                    .map(|integral| integral / contribution.measure)
                    .collect::<Vec<_>>();
                accumulators[pixel].add(&mean, contribution.measure);
            }
        }
    }
    let pixel_area = ((frame.bounds[1] - frame.bounds[0]) * (frame.bounds[3] - frame.bounds[2]))
        .abs()
        / count as f64;
    finish_reduction(
        field.n_comp(),
        request,
        accumulators,
        reduction,
        pixel_area,
        include_air_as_zero,
        "fem_p1_tetra_volume_weighted",
        thickness.map(|value| pixel_area * value),
    )
}

pub(super) fn interpolate_at(field: &FemPlanarField, point: [f64; 3]) -> Option<(u32, Vec<f64>)> {
    for (element_index, element) in field.elements().iter().enumerate() {
        if field.markers().get(element_index).copied().unwrap_or(1) == 0 {
            continue;
        }
        let nodes = element.map(|index| field.nodes()[index as usize]);
        let Some(result) = interpolate_element(field, element, nodes, point) else {
            continue;
        };
        return Some((element_index as u32, result));
    }
    None
}

fn interpolate_element(
    field: &FemPlanarField,
    element: &[u32; 4],
    nodes: [[f64; 3]; 4],
    point: [f64; 3],
) -> Option<Vec<f64>> {
    let weights = barycentric(nodes, point)?;
    if weights
        .iter()
        .any(|weight| *weight < -1.0e-11 || *weight > 1.0 + 1.0e-11)
    {
        return None;
    }
    let mut result = vec![0.0; field.n_comp()];
    for (local, node) in element.iter().enumerate() {
        for component in 0..field.n_comp() {
            result[component] +=
                weights[local] * field.values()[*node as usize * field.n_comp() + component];
        }
    }
    Some(result)
}

fn barycentric(nodes: [[f64; 3]; 4], point: [f64; 3]) -> Option<[f64; 4]> {
    let a = sub(nodes[0], nodes[3]);
    let b = sub(nodes[1], nodes[3]);
    let c = sub(nodes[2], nodes[3]);
    let p = sub(point, nodes[3]);
    let determinant = dot(a, cross(b, c));
    if determinant == 0.0 {
        return None;
    }
    let w0 = dot(p, cross(b, c)) / determinant;
    let w1 = dot(a, cross(p, c)) / determinant;
    let w2 = dot(a, cross(b, p)) / determinant;
    Some([w0, w1, w2, 1.0 - w0 - w1 - w2])
}

pub(super) fn tetra_volume(nodes: [[f64; 3]; 4]) -> f64 {
    dot(
        sub(nodes[1], nodes[0]),
        cross(sub(nodes[2], nodes[0]), sub(nodes[3], nodes[0])),
    )
    .abs()
        / 6.0
}

pub(super) fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
