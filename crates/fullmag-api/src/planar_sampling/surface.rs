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
    param: Vec<f64>,
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
        let face_values: Vec<Vec<f64>> = (0..face.nodes.len())
            .map(|local| {
                (0..field.n_comp())
                    .map(|component| {
                        field.values()[face.nodes[local] as usize * field.n_comp() + component]
                    })
                    .collect()
            })
            .collect();
        let polygon = (0..points.len())
            .map(|local| {
                let param = if points.len() == 3 {
                    match local {
                        0 => vec![1.0, 0.0, 0.0],
                        1 => vec![0.0, 1.0, 0.0],
                        _ => vec![0.0, 0.0, 1.0],
                    }
                } else if points.len() == 4 {
                    match local {
                        0 => vec![0.0, 0.0],
                        1 => vec![1.0, 0.0],
                        2 => vec![1.0, 1.0],
                        _ => vec![0.0, 1.0],
                    }
                } else {
                    vec![0.0; points.len()]
                };
                SurfaceVertex {
                    world: points[local],
                    uvn: frame.project(points[local]),
                    value: face_values[local].clone(),
                    param,
                }
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
                    clip_surface_polygon(polygon.clone(), [u_min, u_min + du, v_min, v_min + dv], &face_values);
                let Some((vec_val, sc_val, area, depth)) =
                    integrate_surface_polygon(&clipped, request.component, &frame, &face_values)
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

fn clip_surface_polygon(
    mut polygon: Vec<SurfaceVertex>,
    bounds: [f64; 4],
    face_values: &[Vec<f64>],
) -> Vec<SurfaceVertex> {
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
                        face_values,
                    ));
                }
            }
        }
        polygon = clipped;
    }
    polygon
}

fn interpolate_surface(
    a: &SurfaceVertex,
    b: &SurfaceVertex,
    t: f64,
    face_values: &[Vec<f64>],
) -> SurfaceVertex {
    let param: Vec<f64> = a
        .param
        .iter()
        .zip(&b.param)
        .map(|(pa, pb)| pa + t * (pb - pa))
        .collect();
    let value = evaluate_face_basis(&param, face_values);
    SurfaceVertex {
        world: [0, 1, 2].map(|axis| a.world[axis] + t * (b.world[axis] - a.world[axis])),
        uvn: [0, 1, 2].map(|axis| a.uvn[axis] + t * (b.uvn[axis] - a.uvn[axis])),
        value,
        param,
    }
}

fn evaluate_face_basis(param: &[f64], face_values: &[Vec<f64>]) -> Vec<f64> {
    let n_comp = face_values[0].len();
    if face_values.len() == 3 {
        (0..n_comp)
            .map(|c| {
                param.get(0).copied().unwrap_or(0.0) * face_values[0][c]
                    + param.get(1).copied().unwrap_or(0.0) * face_values[1][c]
                    + param.get(2).copied().unwrap_or(0.0) * face_values[2][c]
            })
            .collect()
    } else if face_values.len() == 4 {
        let r = param.get(0).copied().unwrap_or(0.0);
        let s = param.get(1).copied().unwrap_or(0.0);
        let n0 = (1.0 - r) * (1.0 - s);
        let n1 = r * (1.0 - s);
        let n2 = r * s;
        let n3 = (1.0 - r) * s;
        (0..n_comp)
            .map(|c| {
                n0 * face_values[0][c]
                    + n1 * face_values[1][c]
                    + n2 * face_values[2][c]
                    + n3 * face_values[3][c]
            })
            .collect()
    } else {
        face_values[0].clone()
    }
}

fn evaluate_scalar_at_vertex(
    vertex: &SurfaceVertex,
    component: PlanarComponent,
    frame: &ResolvedFrame,
) -> f64 {
    if vertex.value.len() == 1 {
        if component == PlanarComponent::Magnitude {
            vertex.value[0].abs()
        } else {
            vertex.value[0]
        }
    } else if component == PlanarComponent::Orientation {
        f64::NAN
    } else {
        let v = [
            vertex.value[0],
            vertex.value.get(1).copied().unwrap_or(0.0),
            vertex.value.get(2).copied().unwrap_or(0.0),
        ];
        super::element_evaluator::evaluate_vector_quantity(
            v,
            component,
            frame.u,
            frame.v,
            frame.normal,
        )
    }
}

fn integrate_triangle_scalar_adaptive(
    v0: &SurfaceVertex,
    v1: &SurfaceVertex,
    v2: &SurfaceVertex,
    component: PlanarComponent,
    frame: &ResolvedFrame,
    face_values: &[Vec<f64>],
    depth: usize,
) -> f64 {
    let m0 = interpolate_surface(v0, v1, 0.5, face_values);
    let m1 = interpolate_surface(v1, v2, 0.5, face_values);
    let m2 = interpolate_surface(v2, v0, 0.5, face_values);

    let s0 = evaluate_scalar_at_vertex(&m0, component, frame);
    let s1 = evaluate_scalar_at_vertex(&m1, component, frame);
    let s2 = evaluate_scalar_at_vertex(&m2, component, frame);
    let coarse = (s0 + s1 + s2) / 3.0;

    let mm0_01 = interpolate_surface(v0, &m0, 0.5, face_values);
    let mm0_12 = interpolate_surface(&m0, &m2, 0.5, face_values);
    let mm0_20 = interpolate_surface(&m2, v0, 0.5, face_values);
    let sub0_coarse = (evaluate_scalar_at_vertex(&mm0_01, component, frame)
        + evaluate_scalar_at_vertex(&mm0_12, component, frame)
        + evaluate_scalar_at_vertex(&mm0_20, component, frame))
        / 3.0;

    let mm1_01 = interpolate_surface(v1, &m1, 0.5, face_values);
    let mm1_12 = interpolate_surface(&m1, &m0, 0.5, face_values);
    let mm1_20 = interpolate_surface(&m0, v1, 0.5, face_values);
    let sub1_coarse = (evaluate_scalar_at_vertex(&mm1_01, component, frame)
        + evaluate_scalar_at_vertex(&mm1_12, component, frame)
        + evaluate_scalar_at_vertex(&mm1_20, component, frame))
        / 3.0;

    let mm2_01 = interpolate_surface(v2, &m2, 0.5, face_values);
    let mm2_12 = interpolate_surface(&m2, &m1, 0.5, face_values);
    let mm2_20 = interpolate_surface(&m1, v2, 0.5, face_values);
    let sub2_coarse = (evaluate_scalar_at_vertex(&mm2_01, component, frame)
        + evaluate_scalar_at_vertex(&mm2_12, component, frame)
        + evaluate_scalar_at_vertex(&mm2_20, component, frame))
        / 3.0;

    let mm3_01 = interpolate_surface(&m0, &m1, 0.5, face_values);
    let mm3_12 = interpolate_surface(&m1, &m2, 0.5, face_values);
    let mm3_20 = interpolate_surface(&m2, &m0, 0.5, face_values);
    let sub3_coarse = (evaluate_scalar_at_vertex(&mm3_01, component, frame)
        + evaluate_scalar_at_vertex(&mm3_12, component, frame)
        + evaluate_scalar_at_vertex(&mm3_20, component, frame))
        / 3.0;

    let fine = 0.25 * (sub0_coarse + sub1_coarse + sub2_coarse + sub3_coarse);
    if depth >= 8 || (fine - coarse).abs() <= 1.0e-6 * (1.0 + fine.abs()) {
        return fine;
    }

    let r0 = integrate_triangle_scalar_adaptive(v0, &m0, &m2, component, frame, face_values, depth + 1);
    let r1 = integrate_triangle_scalar_adaptive(v1, &m1, &m0, component, frame, face_values, depth + 1);
    let r2 = integrate_triangle_scalar_adaptive(v2, &m2, &m1, component, frame, face_values, depth + 1);
    let r3 = integrate_triangle_scalar_adaptive(&m0, &m1, &m2, component, frame, face_values, depth + 1);
    0.25 * (r0 + r1 + r2 + r3)
}

fn integrate_triangle_scalar_exact_or_split(
    v0: &SurfaceVertex,
    v1: &SurfaceVertex,
    v2: &SurfaceVertex,
    component: PlanarComponent,
    frame: &ResolvedFrame,
    face_values: &[Vec<f64>],
) -> f64 {
    if component == PlanarComponent::Magnitude {
        // Check for 1D / collinear zero crossing
        let n_comp = v0.value.len();
        let (is_collinear, signed_vals) = if n_comp == 1 {
            (true, [v0.value[0], v1.value[0], v2.value[0]])
        } else if n_comp >= 3 {
            let diff1 = [
                v1.value[0] - v0.value[0],
                v1.value[1] - v0.value[1],
                v1.value[2] - v0.value[2],
            ];
            let diff2 = [
                v2.value[0] - v0.value[0],
                v2.value[1] - v0.value[1],
                v2.value[2] - v0.value[2],
            ];
            let c = cross(diff1, diff2);
            let c_len_sq = dot(c, c);
            let len1_sq = dot(diff1, diff1);
            let len2_sq = dot(diff2, diff2);
            if c_len_sq <= 1.0e-20 {
                let u_dir = if len1_sq > 1.0e-24 {
                    let inv = 1.0 / len1_sq.sqrt();
                    [diff1[0] * inv, diff1[1] * inv, diff1[2] * inv]
                } else if len2_sq > 1.0e-24 {
                    let inv = 1.0 / len2_sq.sqrt();
                    [diff2[0] * inv, diff2[1] * inv, diff2[2] * inv]
                } else if dot(v0.value[0..3].try_into().unwrap(), v0.value[0..3].try_into().unwrap()) > 1.0e-24 {
                    let v: [f64; 3] = v0.value[0..3].try_into().unwrap();
                    let inv = 1.0 / dot(v, v).sqrt();
                    [v[0] * inv, v[1] * inv, v[2] * inv]
                } else {
                    [1.0, 0.0, 0.0]
                };
                let s0 = dot([v0.value[0], v0.value[1], v0.value[2]], u_dir);
                let s1 = dot([v1.value[0], v1.value[1], v1.value[2]], u_dir);
                let s2 = dot([v2.value[0], v2.value[1], v2.value[2]], u_dir);
                let perp = sub([v0.value[0], v0.value[1], v0.value[2]], [u_dir[0] * s0, u_dir[1] * s0, u_dir[2] * s0]);
                if dot(perp, perp) <= 1.0e-20 {
                    (true, [s0, s1, s2])
                } else {
                    (false, [0.0; 3])
                }
            } else {
                (false, [0.0; 3])
            }
        } else {
            (false, [0.0; 3])
        };

        if is_collinear {
            let [s0, s1, s2] = signed_vals;
            let has_pos = s0 > 1.0e-14 || s1 > 1.0e-14 || s2 > 1.0e-14;
            let has_neg = s0 < -1.0e-14 || s1 < -1.0e-14 || s2 < -1.0e-14;

            if !has_pos || !has_neg {
                // Strictly single sign: affine magnitude on triangle, 3-point rule is algebraically exact
                let sm0 = 0.5 * (s0 + s1).abs();
                let sm1 = 0.5 * (s1 + s2).abs();
                let sm2 = 0.5 * (s2 + s0).abs();
                return (sm0 + sm1 + sm2) / 3.0;
            }

            // Zero crossing exists: split triangle along zero line
            let verts = [(v0, s0), (v1, s1), (v2, s2)];
            let pos_count = verts.iter().filter(|(_, s)| *s > 0.0).count();
            let single_is_pos = pos_count == 1;

            let (single_idx, other1_idx, other2_idx) = if single_is_pos {
                let s_idx = verts.iter().position(|(_, s)| *s > 0.0).unwrap();
                (s_idx, (s_idx + 1) % 3, (s_idx + 2) % 3)
            } else {
                let s_idx = verts.iter().position(|(_, s)| *s < 0.0).unwrap();
                (s_idx, (s_idx + 1) % 3, (s_idx + 2) % 3)
            };

            let vs = verts[single_idx].0;
            let ss = verts[single_idx].1;
            let vo1 = verts[other1_idx].0;
            let so1 = verts[other1_idx].1;
            let vo2 = verts[other2_idx].0;
            let so2 = verts[other2_idx].1;

            let t1 = (ss / (ss - so1)).clamp(0.0, 1.0);
            let t2 = (ss / (ss - so2)).clamp(0.0, 1.0);

            let q1 = interpolate_surface(vs, vo1, t1, face_values);
            let q2 = interpolate_surface(vs, vo2, t2, face_values);

            // Sub-triangle 1: (vs, q1, q2)
            let area_vec1 = cross(sub(q1.world, vs.world), sub(q2.world, vs.world));
            let area1 = 0.5 * dot(area_vec1, area_vec1).sqrt();
            let mean1 = integrate_triangle_scalar_exact_or_split(vs, &q1, &q2, component, frame, face_values);

            // Sub-triangle 2: (q1, vo1, vo2)
            let area_vec2 = cross(sub(vo1.world, q1.world), sub(vo2.world, q1.world));
            let area2 = 0.5 * dot(area_vec2, area_vec2).sqrt();
            let mean2 = integrate_triangle_scalar_exact_or_split(&q1, vo1, vo2, component, frame, face_values);

            // Sub-triangle 3: (q1, vo2, q2)
            let area_vec3 = cross(sub(vo2.world, q1.world), sub(q2.world, q1.world));
            let area3 = 0.5 * dot(area_vec3, area_vec3).sqrt();
            let mean3 = integrate_triangle_scalar_exact_or_split(&q1, vo2, &q2, component, frame, face_values);

            let total_area = area1 + area2 + area3;
            if total_area > 1.0e-36 {
                return (area1 * mean1 + area2 * mean2 + area3 * mean3) / total_area;
            }
        }
    }

    integrate_triangle_scalar_adaptive(v0, v1, v2, component, frame, face_values, 0)
}

fn integrate_surface_quad(
    vertices: &[&SurfaceVertex; 4],
    component: PlanarComponent,
    frame: &ResolvedFrame,
) -> Option<(Vec<f64>, f64, f64, f64)> {
    const GAUSS_PTS: [f64; 2] = [
        0.5 - 0.28867513459481288225,
        0.5 + 0.28867513459481288225,
    ];
    let n_comp = vertices[0].value.len();
    let mut total_area = 0.0;
    let mut integral = vec![0.0; n_comp];
    let mut scalar_integral = 0.0;
    let mut depth_integral = 0.0;

    for &r in &GAUSS_PTS {
        for &t in &GAUSS_PTS {
            let n0 = (1.0 - r) * (1.0 - t);
            let n1 = r * (1.0 - t);
            let n2 = r * t;
            let n3 = (1.0 - r) * t;

            let dr_world = [0, 1, 2].map(|ax| {
                -(1.0 - t) * vertices[0].world[ax]
                    + (1.0 - t) * vertices[1].world[ax]
                    + t * vertices[2].world[ax]
                    - t * vertices[3].world[ax]
            });
            let dt_world = [0, 1, 2].map(|ax| {
                -(1.0 - r) * vertices[0].world[ax]
                    - r * vertices[1].world[ax]
                    + r * vertices[2].world[ax]
                    + (1.0 - r) * vertices[3].world[ax]
            });
            let normal = cross(dr_world, dt_world);
            let da = 0.25 * dot(normal, normal).sqrt();
            if da <= 1.0e-36 || !da.is_finite() {
                continue;
            }
            total_area += da;

            let val: Vec<f64> = (0..n_comp)
                .map(|c| {
                    n0 * vertices[0].value[c]
                        + n1 * vertices[1].value[c]
                        + n2 * vertices[2].value[c]
                        + n3 * vertices[3].value[c]
                })
                .collect();

            for c in 0..n_comp {
                integral[c] += da * val[c];
            }
            if n_comp == 1 {
                scalar_integral += da * val[0];
            } else if component != PlanarComponent::Orientation {
                let v = [
                    val[0],
                    val.get(1).copied().unwrap_or(0.0),
                    val.get(2).copied().unwrap_or(0.0),
                ];
                let s = super::element_evaluator::evaluate_vector_quantity(
                    v,
                    component,
                    frame.u,
                    frame.v,
                    frame.normal,
                );
                scalar_integral += da * s;
            }
            let depth = n0 * vertices[0].uvn[2]
                + n1 * vertices[1].uvn[2]
                + n2 * vertices[2].uvn[2]
                + n3 * vertices[3].uvn[2];
            depth_integral += da * depth;
        }
    }

    (total_area > 0.0).then(|| {
        (
            integral.into_iter().map(|v| v / total_area).collect(),
            scalar_integral / total_area,
            total_area,
            depth_integral / total_area,
        )
    })
}

fn integrate_surface_polygon(
    polygon: &[SurfaceVertex],
    component: PlanarComponent,
    frame: &ResolvedFrame,
    face_values: &[Vec<f64>],
) -> Option<(Vec<f64>, f64, f64, f64)> {
    if polygon.len() < 3 {
        return None;
    }
    if polygon.len() == 4 && component == PlanarComponent::Scalar && face_values.len() == 4 {
        let quad = [&polygon[0], &polygon[1], &polygon[2], &polygon[3]];
        if let Some(res) = integrate_surface_quad(&quad, component, frame) {
            return Some(res);
        }
    }
    let mut area = 0.0;
    let n_comp = polygon[0].value.len();
    let mut integral = vec![0.0; n_comp];
    let mut scalar_integral = 0.0;
    let mut depth_integral = 0.0;
    for index in 1..polygon.len() - 1 {
        let v0 = &polygon[0];
        let v1 = &polygon[index];
        let v2 = &polygon[index + 1];
        let area_vector = cross(
            sub(v1.world, v0.world),
            sub(v2.world, v0.world),
        );
        let triangle_area = 0.5 * dot(area_vector, area_vector).sqrt();
        if triangle_area <= 1.0e-36 || !triangle_area.is_finite() {
            continue;
        }
        area += triangle_area;

        // 3-point midpoint rule in face parametric space
        let m0_param: Vec<f64> = v0.param.iter().zip(&v1.param).map(|(a, b)| 0.5 * (a + b)).collect();
        let m1_param: Vec<f64> = v1.param.iter().zip(&v2.param).map(|(a, b)| 0.5 * (a + b)).collect();
        let m2_param: Vec<f64> = v2.param.iter().zip(&v0.param).map(|(a, b)| 0.5 * (a + b)).collect();

        let val_m0 = evaluate_face_basis(&m0_param, face_values);
        let val_m1 = evaluate_face_basis(&m1_param, face_values);
        let val_m2 = evaluate_face_basis(&m2_param, face_values);

        for c in 0..n_comp {
            integral[c] += triangle_area * (val_m0[c] + val_m1[c] + val_m2[c]) / 3.0;
        }

        if n_comp == 1 && component == PlanarComponent::Scalar {
            scalar_integral += triangle_area * (val_m0[0] + val_m1[0] + val_m2[0]) / 3.0;
        } else if component != PlanarComponent::Orientation {
            let sc_mean = integrate_triangle_scalar_exact_or_split(
                v0,
                v1,
                v2,
                component,
                frame,
                face_values,
            );
            scalar_integral += triangle_area * sc_mean;
        }
        depth_integral +=
            triangle_area * (v0.uvn[2] + v1.uvn[2] + v2.uvn[2]) / 3.0;
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
