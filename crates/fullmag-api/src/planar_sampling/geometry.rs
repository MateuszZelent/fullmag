use super::frame::{cross, dot};

#[derive(Debug, Clone)]
pub(super) struct LinearVertex {
    pub position: [f64; 3],
    pub value: Vec<f64>,
}

#[derive(Debug, Clone)]
struct ConvexPolyhedron {
    faces: Vec<Vec<LinearVertex>>,
}

#[derive(Debug, Clone)]
pub(super) struct MeasureIntegral {
    pub measure: f64,
    pub integral: Vec<f64>,
}

pub(super) fn projected_pixel_bounds(
    vertices: &[LinearVertex],
    bounds_uv_m: [f64; 4],
    resolution: [u32; 2],
    s_bounds: [f64; 2],
) -> Option<([u32; 2], [u32; 2])> {
    let u_min = vertices
        .iter()
        .map(|vertex| vertex.position[0])
        .fold(f64::INFINITY, f64::min);
    let u_max = vertices
        .iter()
        .map(|vertex| vertex.position[0])
        .fold(f64::NEG_INFINITY, f64::max);
    let v_min = vertices
        .iter()
        .map(|vertex| vertex.position[1])
        .fold(f64::INFINITY, f64::min);
    let v_max = vertices
        .iter()
        .map(|vertex| vertex.position[1])
        .fold(f64::NEG_INFINITY, f64::max);
    let projected_s_min = vertices
        .iter()
        .map(|vertex| vertex.position[2])
        .fold(f64::INFINITY, f64::min);
    let projected_s_max = vertices
        .iter()
        .map(|vertex| vertex.position[2])
        .fold(f64::NEG_INFINITY, f64::max);
    if u_max < bounds_uv_m[0]
        || u_min > bounds_uv_m[1]
        || v_max < bounds_uv_m[2]
        || v_min > bounds_uv_m[3]
        || projected_s_max < s_bounds[0]
        || projected_s_min > s_bounds[1]
    {
        return None;
    }
    let axis_bounds =
        |low: f64, high: f64, monitor_low: f64, monitor_high: f64, size: u32| -> [u32; 2] {
            let step = (monitor_high - monitor_low) / size as f64;
            let first = ((low - monitor_low) / step).floor() as i64;
            let last = ((high - monitor_low) / step).floor() as i64;
            [
                first.clamp(0, size as i64 - 1) as u32,
                last.clamp(0, size as i64 - 1) as u32,
            ]
        };
    Some((
        axis_bounds(u_min, u_max, bounds_uv_m[0], bounds_uv_m[1], resolution[0]),
        axis_bounds(v_min, v_max, bounds_uv_m[2], bounds_uv_m[3], resolution[1]),
    ))
}

pub(super) fn integrate_clipped_tetra(
    vertices: [LinearVertex; 4],
    bounds: [f64; 6],
) -> MeasureIntegral {
    let [a, b, c, d] = vertices;
    let mut polyhedron = ConvexPolyhedron {
        faces: vec![
            vec![a.clone(), c.clone(), b.clone()],
            vec![a.clone(), b.clone(), d.clone()],
            vec![a.clone(), d.clone(), c.clone()],
            vec![b, c, d],
        ],
    };
    for (axis, limit, keep_greater) in [
        (0, bounds[0], true),
        (0, bounds[1], false),
        (1, bounds[2], true),
        (1, bounds[3], false),
        (2, bounds[4], true),
        (2, bounds[5], false),
    ] {
        polyhedron = clip_polyhedron(polyhedron, axis, limit, keep_greater);
        if polyhedron.faces.is_empty() {
            return MeasureIntegral {
                measure: 0.0,
                integral: Vec::new(),
            };
        }
    }
    integrate_polyhedron(&polyhedron)
}

pub(super) fn integrate_clipped_convex_element(
    vertices: &[LinearVertex],
    faces: &[&[usize]],
    bounds: [f64; 6],
) -> MeasureIntegral {
    let mut polyhedron = ConvexPolyhedron {
        faces: faces
            .iter()
            .map(|face| face.iter().map(|index| vertices[*index].clone()).collect())
            .collect(),
    };
    for (axis, limit, keep_greater) in [
        (0, bounds[0], true),
        (0, bounds[1], false),
        (1, bounds[2], true),
        (1, bounds[3], false),
        (2, bounds[4], true),
        (2, bounds[5], false),
    ] {
        polyhedron = clip_polyhedron(polyhedron, axis, limit, keep_greater);
        if polyhedron.faces.is_empty() {
            return MeasureIntegral {
                measure: 0.0,
                integral: Vec::new(),
            };
        }
    }
    integrate_polyhedron(&polyhedron)
}

/// Clip an element against a pixel prism and integrate a field evaluated by
/// `evaluate` (the element's own basis) over the clipped region. The region is
/// split into tetrahedra around its vertex centroid and each tetrahedron uses
/// the five-point degree-3 rule, so fields that are not affine in physical
/// space (Prism6, Hex8, Pyramid5 interpolants) are integrated with the
/// element basis instead of linear vertex interpolation along clipped edges.
pub(super) fn integrate_clipped_element_quadrature(
    positions: &[[f64; 3]],
    faces: &[&[usize]],
    bounds: [f64; 6],
    n_comp: usize,
    evaluate: impl Fn([f64; 3]) -> Option<Vec<f64>>,
) -> MeasureIntegral {
    let empty = MeasureIntegral {
        measure: 0.0,
        integral: Vec::new(),
    };
    let mut polyhedron = ConvexPolyhedron {
        faces: faces
            .iter()
            .map(|face| {
                face.iter()
                    .map(|index| LinearVertex {
                        position: positions[*index],
                        value: Vec::new(),
                    })
                    .collect()
            })
            .collect(),
    };
    for (axis, limit, keep_greater) in [
        (0, bounds[0], true),
        (0, bounds[1], false),
        (1, bounds[2], true),
        (1, bounds[3], false),
        (2, bounds[4], true),
        (2, bounds[5], false),
    ] {
        polyhedron = clip_polyhedron(polyhedron, axis, limit, keep_greater);
        if polyhedron.faces.is_empty() {
            return empty;
        }
    }
    let mut unique = Vec::new();
    for vertex in polyhedron.faces.iter().flatten() {
        push_unique(&mut unique, vertex.clone());
    }
    if unique.len() < 4 {
        return empty;
    }
    let center = [0, 1, 2].map(|axis| {
        unique.iter().map(|vertex| vertex.position[axis]).sum::<f64>() / unique.len() as f64
    });
    let mut measure = 0.0;
    let mut integral = vec![0.0; n_comp];
    for face in &polyhedron.faces {
        for index in 1..face.len().saturating_sub(1) {
            let corners = [
                center,
                face[0].position,
                face[index].position,
                face[index + 1].position,
            ];
            let volume = tetra_volume(corners[0], corners[1], corners[2], corners[3]);
            if volume == 0.0 {
                continue;
            }
            // Degree-3 rule: centroid weight −4/5, four points (1/2,1/6,1/6,1/6) weight 9/20.
            let mut points = vec![(-0.8, [0.25; 4])];
            for vertex in 0..4 {
                let mut barycentric = [1.0 / 6.0; 4];
                barycentric[vertex] = 0.5;
                points.push((0.45, barycentric));
            }
            let mut accumulated = vec![0.0; n_comp];
            for (weight, barycentric) in points {
                let point = [0, 1, 2].map(|axis| {
                    (0..4)
                        .map(|corner| barycentric[corner] * corners[corner][axis])
                        .sum::<f64>()
                });
                let Some(value) = evaluate(point) else {
                    return empty;
                };
                for component in 0..n_comp {
                    accumulated[component] += weight * value[component];
                }
            }
            measure += volume;
            for component in 0..n_comp {
                integral[component] += volume * accumulated[component];
            }
        }
    }
    MeasureIntegral { measure, integral }
}

fn clip_polyhedron(
    polyhedron: ConvexPolyhedron,
    axis: usize,
    limit: f64,
    keep_greater: bool,
) -> ConvexPolyhedron {
    if !limit.is_finite() {
        return polyhedron;
    }
    let inside = |vertex: &LinearVertex| {
        if keep_greater {
            vertex.position[axis] >= limit - 1.0e-13
        } else {
            vertex.position[axis] <= limit + 1.0e-13
        }
    };
    let mut faces = Vec::new();
    let mut cap = Vec::new();
    for face in polyhedron.faces {
        if face.is_empty() {
            continue;
        }
        let mut clipped = Vec::new();
        for index in 0..face.len() {
            let current = &face[index];
            let next = &face[(index + 1) % face.len()];
            let current_inside = inside(current);
            let next_inside = inside(next);
            if current_inside {
                clipped.push(current.clone());
            }
            if current_inside != next_inside {
                let denominator = next.position[axis] - current.position[axis];
                if denominator.abs() <= f64::EPSILON {
                    continue;
                }
                let t = ((limit - current.position[axis]) / denominator).clamp(0.0, 1.0);
                let intersection = interpolate(current, next, t);
                clipped.push(intersection.clone());
                push_unique(&mut cap, intersection);
            }
        }
        deduplicate_polygon(&mut clipped);
        if clipped.len() >= 3 {
            faces.push(clipped);
        }
    }
    if cap.len() >= 3 {
        sort_cap(&mut cap, axis);
        faces.push(cap);
    }
    ConvexPolyhedron { faces }
}

fn interpolate(a: &LinearVertex, b: &LinearVertex, t: f64) -> LinearVertex {
    LinearVertex {
        position: [0, 1, 2]
            .map(|axis| a.position[axis] + t * (b.position[axis] - a.position[axis])),
        value: a
            .value
            .iter()
            .zip(&b.value)
            .map(|(a, b)| a + t * (b - a))
            .collect(),
    }
}

fn push_unique(vertices: &mut Vec<LinearVertex>, candidate: LinearVertex) {
    if vertices
        .iter()
        .any(|vertex| distance_sq(vertex.position, candidate.position) <= 1.0e-24)
    {
        return;
    }
    vertices.push(candidate);
}

fn deduplicate_polygon(vertices: &mut Vec<LinearVertex>) {
    let mut unique = Vec::with_capacity(vertices.len());
    for vertex in vertices.drain(..) {
        push_unique(&mut unique, vertex);
    }
    *vertices = unique;
}

fn sort_cap(vertices: &mut [LinearVertex], axis: usize) {
    let center = [0, 1, 2].map(|coordinate| {
        vertices
            .iter()
            .map(|vertex| vertex.position[coordinate])
            .sum::<f64>()
            / vertices.len() as f64
    });
    let (first, second) = match axis {
        0 => (1, 2),
        1 => (0, 2),
        _ => (0, 1),
    };
    vertices.sort_by(|a, b| {
        let angle_a =
            (a.position[second] - center[second]).atan2(a.position[first] - center[first]);
        let angle_b =
            (b.position[second] - center[second]).atan2(b.position[first] - center[first]);
        angle_a.total_cmp(&angle_b)
    });
}

fn integrate_polyhedron(polyhedron: &ConvexPolyhedron) -> MeasureIntegral {
    let mut unique = Vec::new();
    for vertex in polyhedron.faces.iter().flatten() {
        push_unique(&mut unique, vertex.clone());
    }
    if unique.len() < 4 {
        return MeasureIntegral {
            measure: 0.0,
            integral: Vec::new(),
        };
    }
    let center = LinearVertex {
        position: [0, 1, 2].map(|axis| {
            unique
                .iter()
                .map(|vertex| vertex.position[axis])
                .sum::<f64>()
                / unique.len() as f64
        }),
        value: (0..unique[0].value.len())
            .map(|component| {
                unique
                    .iter()
                    .map(|vertex| vertex.value[component])
                    .sum::<f64>()
                    / unique.len() as f64
            })
            .collect(),
    };
    let mut measure = 0.0;
    let mut integral = vec![0.0; center.value.len()];
    for face in &polyhedron.faces {
        for index in 1..face.len() - 1 {
            let a = &face[0];
            let b = &face[index];
            let c = &face[index + 1];
            let volume = tetra_volume(center.position, a.position, b.position, c.position);
            if volume == 0.0 {
                continue;
            }
            measure += volume;
            for component in 0..integral.len() {
                integral[component] += volume
                    * (center.value[component]
                        + a.value[component]
                        + b.value[component]
                        + c.value[component])
                    / 4.0;
            }
        }
    }
    MeasureIntegral { measure, integral }
}

fn tetra_volume(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> f64 {
    dot(sub(b, a), cross(sub(c, a), sub(d, a))).abs() / 6.0
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn distance_sq(a: [f64; 3], b: [f64; 3]) -> f64 {
    let delta = sub(a, b);
    dot(delta, delta)
}
