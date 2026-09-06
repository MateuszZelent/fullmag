use std::collections::BTreeMap;

use crate::error::ApiError;
use fullmag_ir::{PlanarReductionIR, SurfaceVisibilityPolicyIR};

use super::frame::{cross, dot, ResolvedFrame};
use super::provenance;
use super::reduction::WeightedAccumulator;
use super::{
    FemPlanarField, Occupancy, PlanarComponent, PlanarSampleResult, ResolvedPlanarSampleRequest,
};

#[derive(Debug, Clone)]
struct BoundaryFace {
    nodes: Vec<u32>,
    parent_centroid: [f64; 3],
    parent_element_id: u32,
}

#[derive(Debug, Clone)]
struct SurfaceVertex {
    world: [f64; 3],
    uvn: [f64; 3],
    value: Vec<f64>,
}

pub(super) fn sample_boundary(
    field: &FemPlanarField,
    request: &ResolvedPlanarSampleRequest,
    frame: ResolvedFrame,
    visibility: SurfaceVisibilityPolicyIR,
) -> Result<PlanarSampleResult, ApiError> {
    let pixel_count = request.resolution[0] as usize * request.resolution[1] as usize;
    let mut faces_by_key = BTreeMap::<Vec<u32>, Vec<BoundaryFace>>::new();
    for (element_index, element) in field.elements().iter().enumerate() {
        if field.markers().get(element_index).copied().unwrap_or(1) == 0 {
            continue;
        }
        let parent_centroid = [0, 1, 2].map(|axis| {
            element
                .nodes()
                .iter()
                .map(|node| field.nodes()[*node as usize][axis])
                .sum::<f64>()
                / element.nodes().len() as f64
        });
        for local_face in element.faces() {
            let face = BoundaryFace {
                nodes: local_face
                    .iter()
                    .map(|local| element.nodes()[*local])
                    .collect(),
                parent_centroid,
                parent_element_id: element_index as u32,
            };
            let mut key = face.nodes.clone();
            key.sort_unstable();
            faces_by_key.entry(key).or_default().push(face);
        }
    }

    let mut pixel_faces = vec![Vec::<(Vec<f64>, f64, f64, f64, f64, u32)>::new(); pixel_count];
    for faces in faces_by_key.values().filter(|faces| faces.len() == 1) {
        let face = &faces[0];
        let points = face
            .nodes
            .iter()
            .map(|node| field.nodes()[*node as usize])
            .collect::<Vec<_>>();
        let ab = sub(points[1], points[0]);
        let ac = sub(points[2], points[0]);
        let area_vector = cross(ab, ac);
        if dot(area_vector, area_vector) == 0.0 {
            continue;
        }
        let outward_sign = if dot(area_vector, sub(face.parent_centroid, points[0])) > 0.0 {
            -1.0
        } else {
            1.0
        };
        let facing = outward_sign * dot(area_vector, frame.normal);
        let polygon = (0..points.len())
            .map(|local| SurfaceVertex {
                world: points[local],
                uvn: frame.project(points[local]),
                value: (0..field.n_comp())
                    .map(|component| {
                        field.values()[face.nodes[local] as usize * field.n_comp() + component]
                    })
                    .collect(),
            })
            .collect::<Vec<_>>();
        let du = (frame.bounds[1] - frame.bounds[0]) / request.resolution[0] as f64;
        let dv = (frame.bounds[3] - frame.bounds[2]) / request.resolution[1] as f64;
        let u_min = polygon
            .iter()
            .map(|vertex| vertex.uvn[0])
            .fold(f64::INFINITY, f64::min);
        let u_max = polygon
            .iter()
            .map(|vertex| vertex.uvn[0])
            .fold(f64::NEG_INFINITY, f64::max);
        let v_min = polygon
            .iter()
            .map(|vertex| vertex.uvn[1])
            .fold(f64::INFINITY, f64::min);
        let v_max = polygon
            .iter()
            .map(|vertex| vertex.uvn[1])
            .fold(f64::NEG_INFINITY, f64::max);
        let Some((x_start, x_end)) =
            pixel_overlap_range(u_min, u_max, frame.bounds[0], du, request.resolution[0])
        else {
            continue;
        };
        let Some((y_start, y_end)) =
            pixel_overlap_range(v_min, v_max, frame.bounds[2], dv, request.resolution[1])
        else {
            continue;
        };
        for y in y_start..=y_end {
            for x in x_start..=x_end {
                let u_min = frame.bounds[0] + x as f64 * du;
                let v_min = frame.bounds[2] + y as f64 * dv;
                let clipped =
                    clip_surface_polygon(polygon.clone(), [u_min, u_min + du, v_min, v_min + dv]);
                let Some((vec_val, sc_val, area, depth)) =
                    integrate_surface_polygon(&clipped, request.component, &frame)
                else {
                    continue;
                };
                let pixel = (y * request.resolution[0] + x) as usize;
                pixel_faces[pixel].push((vec_val, sc_val, area, depth, facing, face.parent_element_id));
            }
        }
    }

    let mut occupancy = Vec::with_capacity(pixel_count);
    let mut scalar_values = Vec::with_capacity(pixel_count);
    let mut vector_values = Vec::with_capacity(pixel_count);
    let mut source_entity_ids = Vec::with_capacity(pixel_count);
    let mut occupied_measure = 0.0;
    let mut overlap_count = 0u32;
    let mut fold_count = 0u32;
    for mut faces in pixel_faces {
        if faces.is_empty() {
            occupancy.push(Occupancy::Empty);
            scalar_values.push(f64::NAN);
            vector_values.push([f64::NAN; 3]);
            source_entity_ids.push(None);
            continue;
        }
        let ambiguous = faces.len() > 1;
        if ambiguous {
            overlap_count = overlap_count.saturating_add((faces.len() - 1) as u32);
            let has_front = faces.iter().any(|face| face.4 > 0.0);
            let has_back = faces.iter().any(|face| face.4 < 0.0);
            if has_front && has_back {
                fold_count = fold_count.saturating_add(1);
            }
        }
        match visibility {
            SurfaceVisibilityPolicyIR::Frontmost => {
                faces.sort_by(|a, b| b.3.total_cmp(&a.3));
                faces.truncate(1);
            }
            SurfaceVisibilityPolicyIR::Backmost => {
                faces.sort_by(|a, b| a.3.total_cmp(&b.3));
                faces.truncate(1);
            }
            SurfaceVisibilityPolicyIR::NearestToOrigin => {
                faces.sort_by(|a, b| a.3.abs().total_cmp(&b.3.abs()));
                faces.truncate(1);
            }
            SurfaceVisibilityPolicyIR::AreaWeightedOverlap => {}
        }
        let mut accumulator = WeightedAccumulator::new(field.n_comp());
        let mut scalar_sum = 0.0;
        let mut total_area = 0.0;
        let source_entity_id = (faces.len() == 1).then_some(faces[0].5);
        for (vec_val, sc_val, area, _, _, _) in faces {
            occupied_measure += area;
            total_area += area;
            accumulator.add(&vec_val, area);
            scalar_sum += sc_val * area;
        }
        let mean_vec = accumulator
            .finish(PlanarReductionIR::MeanOccupied.into(), 1.0)
            .expect("non-empty boundary face accumulator");
        let (scalar_val, occ) = if request.component == PlanarComponent::Orientation {
            let vec = [
                mean_vec[0],
                mean_vec.get(1).copied().unwrap_or(0.0),
                mean_vec.get(2).copied().unwrap_or(0.0),
            ];
            let val = super::element_evaluator::evaluate_vector_quantity(
                vec,
                request.component,
                frame.u,
                frame.v,
                frame.normal,
            );
            if !val.is_finite() {
                (f64::NAN, Occupancy::UndefinedOrientation)
            } else if ambiguous {
                (val, Occupancy::OverlapAmbiguous)
            } else {
                (val, Occupancy::Occupied)
            }
        } else {
            let sc = if total_area > 0.0 {
                scalar_sum / total_area
            } else {
                f64::NAN
            };
            if !sc.is_finite() {
                (f64::NAN, Occupancy::Empty)
            } else if ambiguous {
                (sc, Occupancy::OverlapAmbiguous)
            } else {
                (sc, Occupancy::Occupied)
            }
        };
        occupancy.push(occ);
        scalar_values.push(scalar_val);
        vector_values.push(if field.n_comp() >= 3 {
            [mean_vec[0], mean_vec[1], mean_vec[2]]
        } else {
            [f64::NAN; 3]
        });
        source_entity_ids.push(source_entity_id);
    }

    Ok(PlanarSampleResult {
        meta: provenance::meta(
            request,
            "fem_p1_boundary_area_weighted",
            &occupancy,
            occupied_measure,
            overlap_count,
            fold_count,
            1,
            1,
        ),
        scalar_values,
        vector_values: (field.n_comp() >= 3).then_some(vector_values),
        occupancy,
        source_entity_ids,
        overlay: None,
    })
}

fn pixel_overlap_range(
    projected_min: f64,
    projected_max: f64,
    frame_min: f64,
    pixel_size: f64,
    resolution: u32,
) -> Option<(u32, u32)> {
    let first = ((projected_min - frame_min) / pixel_size).floor() as i64;
    let last = ((projected_max - frame_min) / pixel_size).floor() as i64;
    let first = first.max(0);
    let last = last.min(resolution as i64 - 1);
    (first <= last).then_some((first as u32, last as u32))
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn clip_surface_polygon(mut polygon: Vec<SurfaceVertex>, bounds: [f64; 4]) -> Vec<SurfaceVertex> {
    for (axis, limit, keep_greater) in [
        (0, bounds[0], true),
        (0, bounds[1], false),
        (1, bounds[2], true),
        (1, bounds[3], false),
    ] {
        if polygon.is_empty() {
            break;
        }
        let mut clipped = Vec::new();
        for index in 0..polygon.len() {
            let current = &polygon[index];
            let next = &polygon[(index + 1) % polygon.len()];
            let current_inside = if keep_greater {
                current.uvn[axis] >= limit - 1.0e-13
            } else {
                current.uvn[axis] <= limit + 1.0e-13
            };
            let next_inside = if keep_greater {
                next.uvn[axis] >= limit - 1.0e-13
            } else {
                next.uvn[axis] <= limit + 1.0e-13
            };
            if current_inside {
                clipped.push(current.clone());
            }
            if current_inside != next_inside {
                let denominator = next.uvn[axis] - current.uvn[axis];
                if denominator.abs() > f64::EPSILON {
                    clipped.push(interpolate_surface(
                        current,
                        next,
                        ((limit - current.uvn[axis]) / denominator).clamp(0.0, 1.0),
                    ));
                }
            }
        }
        polygon = clipped;
    }
    polygon
}

fn interpolate_surface(a: &SurfaceVertex, b: &SurfaceVertex, t: f64) -> SurfaceVertex {
    SurfaceVertex {
        world: [0, 1, 2].map(|axis| a.world[axis] + t * (b.world[axis] - a.world[axis])),
        uvn: [0, 1, 2].map(|axis| a.uvn[axis] + t * (b.uvn[axis] - a.uvn[axis])),
        value: a
            .value
            .iter()
            .zip(&b.value)
            .map(|(a, b)| a + t * (b - a))
            .collect(),
    }
}

fn integrate_surface_polygon(
    polygon: &[SurfaceVertex],
    component: PlanarComponent,
    frame: &ResolvedFrame,
) -> Option<(Vec<f64>, f64, f64, f64)> {
    if polygon.len() < 3 {
        return None;
    }
    let mut area = 0.0;
    let n_comp = polygon[0].value.len();
    let mut integral = vec![0.0; n_comp];
    let mut scalar_integral = 0.0;
    let mut depth_integral = 0.0;
    for index in 1..polygon.len() - 1 {
        let vertices = [&polygon[0], &polygon[index], &polygon[index + 1]];
        let area_vector = cross(
            sub(vertices[1].world, vertices[0].world),
            sub(vertices[2].world, vertices[0].world),
        );
        let triangle_area = 0.5 * dot(area_vector, area_vector).sqrt();
        if triangle_area <= 1.0e-36 || !triangle_area.is_finite() {
            continue;
        }
        area += triangle_area;
        for c in 0..n_comp {
            integral[c] += triangle_area
                * (vertices[0].value[c] + vertices[1].value[c] + vertices[2].value[c])
                / 3.0;
        }
        if n_comp == 1 {
            scalar_integral += triangle_area
                * (vertices[0].value[0] + vertices[1].value[0] + vertices[2].value[0])
                / 3.0;
        } else if component != PlanarComponent::Orientation {
            let m0 = [
                0.5 * (vertices[0].value[0] + vertices[1].value[0]),
                0.5 * (vertices[0].value.get(1).copied().unwrap_or(0.0)
                    + vertices[1].value.get(1).copied().unwrap_or(0.0)),
                0.5 * (vertices[0].value.get(2).copied().unwrap_or(0.0)
                    + vertices[1].value.get(2).copied().unwrap_or(0.0)),
            ];
            let m1 = [
                0.5 * (vertices[1].value[0] + vertices[2].value[0]),
                0.5 * (vertices[1].value.get(1).copied().unwrap_or(0.0)
                    + vertices[2].value.get(1).copied().unwrap_or(0.0)),
                0.5 * (vertices[1].value.get(2).copied().unwrap_or(0.0)
                    + vertices[2].value.get(2).copied().unwrap_or(0.0)),
            ];
            let m2 = [
                0.5 * (vertices[2].value[0] + vertices[0].value[0]),
                0.5 * (vertices[2].value.get(1).copied().unwrap_or(0.0)
                    + vertices[0].value.get(1).copied().unwrap_or(0.0)),
                0.5 * (vertices[2].value.get(2).copied().unwrap_or(0.0)
                    + vertices[0].value.get(2).copied().unwrap_or(0.0)),
            ];
            let s0 = super::element_evaluator::evaluate_vector_quantity(
                m0,
                component,
                frame.u,
                frame.v,
                frame.normal,
            );
            let s1 = super::element_evaluator::evaluate_vector_quantity(
                m1,
                component,
                frame.u,
                frame.v,
                frame.normal,
            );
            let s2 = super::element_evaluator::evaluate_vector_quantity(
                m2,
                component,
                frame.u,
                frame.v,
                frame.normal,
            );
            scalar_integral += triangle_area * (s0 + s1 + s2) / 3.0;
        }
        depth_integral +=
            triangle_area * (vertices[0].uvn[2] + vertices[1].uvn[2] + vertices[2].uvn[2]) / 3.0;
    }
    (area > 0.0).then(|| {
        (
            integral.into_iter().map(|value| value / area).collect(),
            scalar_integral / area,
            area,
            depth_integral / area,
        )
    })
}
