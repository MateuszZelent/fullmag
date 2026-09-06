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
    let char_scale = compute_char_scale(&polyhedron, &bounds);
    for (axis, limit, keep_greater) in [
        (0, bounds[0], true),
        (0, bounds[1], false),
        (1, bounds[2], true),
        (1, bounds[3], false),
        (2, bounds[4], true),
        (2, bounds[5], false),
    ] {
        polyhedron = clip_polyhedron(polyhedron, axis, limit, keep_greater, char_scale);
        if polyhedron.faces.is_empty() {
            return MeasureIntegral {
                measure: 0.0,
                integral: Vec::new(),
            };
        }
    }
    integrate_polyhedron(&polyhedron, char_scale)
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
    let char_scale = compute_char_scale(&polyhedron, &bounds);
    for (axis, limit, keep_greater) in [
        (0, bounds[0], true),
        (0, bounds[1], false),
        (1, bounds[2], true),
        (1, bounds[3], false),
        (2, bounds[4], true),
        (2, bounds[5], false),
    ] {
        polyhedron = clip_polyhedron(polyhedron, axis, limit, keep_greater, char_scale);
        if polyhedron.faces.is_empty() {
            return MeasureIntegral {
                measure: 0.0,
                integral: Vec::new(),
            };
        }
    }
    integrate_polyhedron(&polyhedron, char_scale)
}

pub(super) fn decompose_clipped_convex_element(
    positions: &[[f64; 3]],
    faces: &[&[usize]],
    bounds: [f64; 6],
) -> Vec<[[f64; 3]; 4]> {
    let vertices = positions
        .iter()
        .map(|&position| LinearVertex {
            position,
            value: Vec::new(),
        })
        .collect::<Vec<_>>();
    let mut polyhedron = ConvexPolyhedron {
        faces: faces
            .iter()
            .map(|face| face.iter().map(|index| vertices[*index].clone()).collect())
            .collect(),
    };
    let char_scale = compute_char_scale(&polyhedron, &bounds);
    for (axis, limit, keep_greater) in [
        (0, bounds[0], true),
        (0, bounds[1], false),
        (1, bounds[2], true),
        (1, bounds[3], false),
        (2, bounds[4], true),
        (2, bounds[5], false),
    ] {
        polyhedron = clip_polyhedron(polyhedron, axis, limit, keep_greater, char_scale);
        if polyhedron.faces.is_empty() {
            return Vec::new();
        }
    }
    decompose_polyhedron(&polyhedron, char_scale)
}

fn compute_char_scale(polyhedron: &ConvexPolyhedron, bounds: &[f64; 6]) -> f64 {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut count = 0;
    for vertex in polyhedron.faces.iter().flatten() {
        count += 1;
        for axis in 0..3 {
            min[axis] = min[axis].min(vertex.position[axis]);
            max[axis] = max[axis].max(vertex.position[axis]);
        }
    }
    let mut scale = if count > 0 {
        (max[0] - min[0]).max(max[1] - min[1]).max(max[2] - min[2])
    } else {
        1.0
    };
    if scale <= 0.0 || !scale.is_finite() {
        scale = 1.0;
    }
    for i in 0..3 {
        let diff = bounds[2 * i + 1] - bounds[2 * i];
        if diff.is_finite() && diff > 0.0 && diff < scale {
            scale = diff;
        }
    }
    scale
}

fn decompose_polyhedron(polyhedron: &ConvexPolyhedron, char_scale: f64) -> Vec<[[f64; 3]; 4]> {
    let tol_sq = (char_scale * 1.0e-6).powi(2).min(1.0e-24);
    let min_vol = (char_scale.powi(3) * 1.0e-15).min(1.0e-36);
    let mut unique = Vec::new();
    for vertex in polyhedron.faces.iter().flatten() {
        push_unique(&mut unique, vertex.clone(), tol_sq);
    }
    if unique.len() < 4 {
        return Vec::new();
    }
    let center = [0, 1, 2].map(|axis| {
        unique
            .iter()
            .map(|vertex| vertex.position[axis])
            .sum::<f64>()
            / unique.len() as f64
    });
    let mut tetrahedra = Vec::new();
    for face in &polyhedron.faces {
        for index in 1..face.len() - 1 {
            let a = face[0].position;
            let b = face[index].position;
            let c = face[index + 1].position;
            let volume = tetra_volume(center, a, b, c);
            if volume > min_vol {
                tetrahedra.push([center, a, b, c]);
            }
        }
    }
    tetrahedra
}

fn clip_polyhedron(
    polyhedron: ConvexPolyhedron,
    axis: usize,
    limit: f64,
    keep_greater: bool,
    char_scale: f64,
) -> ConvexPolyhedron {
    if !limit.is_finite() {
        return polyhedron;
    }
    let tol_eps = (char_scale * 1.0e-7).min(1.0e-13);
    let tol_sq = (char_scale * 1.0e-6).powi(2).min(1.0e-24);
    let inside = |vertex: &LinearVertex| {
        if keep_greater {
            vertex.position[axis] >= limit - tol_eps
        } else {
            vertex.position[axis] <= limit + tol_eps
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
                push_unique(&mut cap, intersection, tol_sq);
            }
        }
        deduplicate_polygon(&mut clipped, tol_sq);
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

fn push_unique(vertices: &mut Vec<LinearVertex>, candidate: LinearVertex, tol_sq: f64) {
    if vertices
        .iter()
        .any(|vertex| distance_sq(vertex.position, candidate.position) <= tol_sq)
    {
        return;
    }
    vertices.push(candidate);
}

fn deduplicate_polygon(vertices: &mut Vec<LinearVertex>, tol_sq: f64) {
    let mut unique = Vec::with_capacity(vertices.len());
    for vertex in vertices.drain(..) {
        push_unique(&mut unique, vertex, tol_sq);
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

fn integrate_polyhedron(polyhedron: &ConvexPolyhedron, char_scale: f64) -> MeasureIntegral {
    let tol_sq = (char_scale * 1.0e-6).powi(2).min(1.0e-24);
    let min_vol = (char_scale.powi(3) * 1.0e-15).min(1.0e-36);
    let mut unique = Vec::new();
    for vertex in polyhedron.faces.iter().flatten() {
        push_unique(&mut unique, vertex.clone(), tol_sq);
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
            if volume <= min_vol {
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
