use std::collections::BTreeMap;

use crate::error::ApiError;
use fullmag_ir::{PlanarReductionIR, SurfaceVisibilityPolicyIR};

use super::frame::{cross, dot, ResolvedFrame};
use super::provenance;
use super::reduction::WeightedAccumulator;
use super::{FemPlanarField, Occupancy, PlanarSampleResult, ResolvedPlanarSampleRequest};

#[derive(Debug, Clone, Copy)]
struct BoundaryFace {
    nodes: [u32; 3],
    opposite: u32,
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
    let mut faces_by_key = BTreeMap::<[u32; 3], Vec<BoundaryFace>>::new();
    for (element_index, element) in field.elements().iter().enumerate() {
        if field.markers().get(element_index).copied().unwrap_or(1) == 0 {
            continue;
        }
        let [a, b, c, d] = *element;
        for face in [
            BoundaryFace {
                nodes: [a, b, c],
                opposite: d,
                parent_element_id: element_index as u32,
            },
            BoundaryFace {
                nodes: [a, b, d],
                opposite: c,
                parent_element_id: element_index as u32,
            },
            BoundaryFace {
                nodes: [a, c, d],
                opposite: b,
                parent_element_id: element_index as u32,
            },
            BoundaryFace {
                nodes: [b, c, d],
                opposite: a,
                parent_element_id: element_index as u32,
            },
        ] {
            let mut key = face.nodes;
            key.sort_unstable();
            faces_by_key.entry(key).or_default().push(face);
        }
    }

    let mut pixel_faces = vec![Vec::<(Vec<f64>, f64, f64, f64, u32)>::new(); pixel_count];
    for faces in faces_by_key.values().filter(|faces| faces.len() == 1) {
        let face = faces[0];
        let points = face.nodes.map(|node| field.nodes()[node as usize]);
        let ab = sub(points[1], points[0]);
        let ac = sub(points[2], points[0]);
        let area_vector = cross(ab, ac);
        if dot(area_vector, area_vector) == 0.0 {
            continue;
        }
        let opposite = field.nodes()[face.opposite as usize];
        let outward_sign = if dot(area_vector, sub(opposite, points[0])) > 0.0 {
            -1.0
        } else {
            1.0
        };
        let facing = outward_sign * dot(area_vector, frame.normal);
        let polygon = (0..3)
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
                let Some((value, area, depth)) = integrate_surface_polygon(&clipped) else {
                    continue;
                };
                let pixel = (y * request.resolution[0] + x) as usize;
                pixel_faces[pixel].push((value, area, depth, facing, face.parent_element_id));
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
            let has_front = faces.iter().any(|face| face.3 > 0.0);
            let has_back = faces.iter().any(|face| face.3 < 0.0);
            if has_front && has_back {
                fold_count = fold_count.saturating_add(1);
            }
        }
        match visibility {
            SurfaceVisibilityPolicyIR::Frontmost => {
                faces.sort_by(|a, b| b.2.total_cmp(&a.2));
                faces.truncate(1);
            }
            SurfaceVisibilityPolicyIR::Backmost => {
                faces.sort_by(|a, b| a.2.total_cmp(&b.2));
                faces.truncate(1);
            }
            SurfaceVisibilityPolicyIR::NearestToOrigin => {
                faces.sort_by(|a, b| a.2.abs().total_cmp(&b.2.abs()));
                faces.truncate(1);
            }
            SurfaceVisibilityPolicyIR::AreaWeightedOverlap => {}
        }
        let mut accumulator = WeightedAccumulator::new(field.n_comp());
        let source_entity_id = (faces.len() == 1).then_some(faces[0].4);
        for (value, area, _, _, _) in faces {
            occupied_measure += area;
            accumulator.add(&value, area);
        }
        let value = accumulator
            .finish(PlanarReductionIR::MeanOccupied.into(), 1.0)
            .expect("non-empty boundary face accumulator");
        occupancy.push(if ambiguous {
            Occupancy::OverlapAmbiguous
        } else {
            Occupancy::Occupied
        });
        scalar_values.push(if field.n_comp() == 1 {
            value[0]
        } else {
            value
                .iter()
                .map(|component| component * component)
                .sum::<f64>()
                .sqrt()
        });
        vector_values.push(if field.n_comp() >= 3 {
            [value[0], value[1], value[2]]
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

fn integrate_surface_polygon(polygon: &[SurfaceVertex]) -> Option<(Vec<f64>, f64, f64)> {
    if polygon.len() < 3 {
        return None;
    }
    let mut area = 0.0;
    let mut integral = vec![0.0; polygon[0].value.len()];
    let mut depth_integral = 0.0;
    for index in 1..polygon.len() - 1 {
        let vertices = [&polygon[0], &polygon[index], &polygon[index + 1]];
        let area_vector = cross(
            sub(vertices[1].world, vertices[0].world),
            sub(vertices[2].world, vertices[0].world),
        );
        let triangle_area = 0.5 * dot(area_vector, area_vector).sqrt();
        if triangle_area <= 1.0e-24 {
            continue;
        }
        area += triangle_area;
        for component in 0..integral.len() {
            integral[component] += triangle_area
                * vertices
                    .iter()
                    .map(|vertex| vertex.value[component])
                    .sum::<f64>()
                / 3.0;
        }
        depth_integral +=
            triangle_area * vertices.iter().map(|vertex| vertex.uvn[2]).sum::<f64>() / 3.0;
    }
    (area > 0.0).then(|| {
        (
            integral.into_iter().map(|value| value / area).collect(),
            area,
            depth_integral / area,
        )
    })
}
