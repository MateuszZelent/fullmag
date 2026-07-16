use std::collections::{BTreeMap, BTreeSet};
use std::f64::consts::{FRAC_PI_2, PI};

pub const MIN_VECTOR_NORM: f64 = 1.0e-12;
pub const EXCEPTION_EPSILON: f64 = 1.0e-14;
pub const ANTIPODAL_ANGLE_EPSILON_RAD: f64 = 1.0e-8;
pub const UNDER_RESOLVED_EDGE_ANGLE_RAD: f64 = FRAC_PI_2;

/// Full-thickness average over cell-centred planar cuts.  Each weight is a
/// physical thickness interval, so no endpoint trapezoid is introduced.
/// A single invalid cut invalidates the aggregate rather than silently changing
/// the represented thickness.
pub fn fdm_weighted_mean(charges: &[Option<f64>], weights_m: &[f64]) -> Option<f64> {
    if charges.is_empty() || charges.len() != weights_m.len() {
        return None;
    }
    let mut weighted_sum = 0.0;
    let mut total_weight = 0.0;
    for (charge, weight) in charges.iter().zip(weights_m) {
        let charge = charge.filter(|value| value.is_finite())?;
        if !weight.is_finite() || *weight <= 0.0 {
            return None;
        }
        weighted_sum += charge * weight;
        total_weight += weight;
    }
    (total_weight.is_finite() && total_weight > 0.0)
        .then_some(weighted_sum / total_weight)
        .filter(|value| value.is_finite())
}

/// Uniform physical weights for `count` FEM cuts located at bin midpoints.
pub fn fem_midpoint_weights(count: usize, thickness_m: f64) -> Vec<f64> {
    if count == 0 || !thickness_m.is_finite() || thickness_m <= 0.0 {
        return Vec::new();
    }
    vec![thickness_m / count as f64; count]
}

#[cfg(test)]
mod profile_tests {
    use super::{fdm_weighted_mean, fem_midpoint_weights};

    #[test]
    fn full_thickness_profile_uses_cell_weights_not_endpoint_trapezoids() {
        assert_eq!(
            fdm_weighted_mean(&[Some(0.0), Some(1.0), Some(0.0)], &[1.0, 1.0, 1.0]),
            Some(1.0 / 3.0)
        );
        assert_eq!(fem_midpoint_weights(3, 3.0), vec![1.0, 1.0, 1.0]);
    }

    #[test]
    fn invalid_profile_cut_makes_full_thickness_summary_unavailable() {
        assert_eq!(
            fdm_weighted_mean(&[Some(0.0), None, Some(0.0)], &[1.0, 1.0, 1.0]),
            None
        );
    }
}

/// Backend-neutral, explicitly oriented triangle support.
#[derive(Debug, Clone, Copy)]
pub struct OrientedChargeInput<'a> {
    pub samples: &'a [[f64; 3]],
    pub triangles: &'a [[usize; 3]],
}

impl<'a> OrientedChargeInput<'a> {
    pub fn new(samples: &'a [[f64; 3]], triangles: &'a [[usize; 3]]) -> Self {
        Self { samples, triangles }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrientedChargeQuality {
    pub total_vertex_count: usize,
    pub valid_vertex_count: usize,
    pub total_triangle_count: usize,
    pub valid_triangle_count: usize,
    pub invalid_triangle_count: usize,
    pub exceptional_triangle_count: usize,
    pub max_edge_angle_rad: f64,
    pub min_abs_solid_angle_denominator: f64,
    pub under_resolved: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrientedChargeResult {
    pub charge: f64,
    pub quality: OrientedChargeQuality,
}

/// Pure combinatorial qualification of an explicitly oriented triangle support.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportTopologyQualification {
    pub connected_component_count: usize,
    pub boundary_edge_count: usize,
    pub boundary_loop_count: usize,
    pub euler_characteristic: i64,
    pub duplicate_triangle_count: usize,
    pub nonmanifold_edge_count: usize,
    pub orientation_mismatch_count: usize,
    pub invalid_triangle_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BoundaryQualification {
    pub mean_direction: Option<[f64; 3]>,
    pub max_deviation_rad: Option<f64>,
    pub is_uniform: bool,
}

impl SupportTopologyQualification {
    pub fn is_manifold(&self) -> bool {
        self.duplicate_triangle_count == 0
            && self.nonmanifold_edge_count == 0
            && self.orientation_mismatch_count == 0
            && self.invalid_triangle_count == 0
    }
}

/// Qualify triangle incidence and orientation without attempting to repair the
/// support.  A caller can use the diagnostics to distinguish a hard degenerate
/// support from a valid but non-disk diagnostic integral.
pub fn qualify_support_topology(
    vertex_count: usize,
    triangles: &[[usize; 3]],
) -> SupportTopologyQualification {
    #[derive(Debug, Clone, Copy)]
    struct DirectedEdge {
        triangle: usize,
        from: usize,
        to: usize,
    }

    let mut edges: BTreeMap<(usize, usize), Vec<DirectedEdge>> = BTreeMap::new();
    let mut triangle_adjacency = vec![Vec::<usize>::new(); triangles.len()];
    let mut used_vertices = BTreeSet::new();
    let mut canonical_triangles = BTreeSet::new();
    let mut duplicate_triangle_count = 0;
    let mut invalid_triangle_count = 0;

    for (triangle_index, triangle) in triangles.iter().copied().enumerate() {
        if triangle.iter().any(|index| *index >= vertex_count) {
            invalid_triangle_count += 1;
            continue;
        }
        let mut canonical = triangle;
        canonical.sort_unstable();
        if !canonical_triangles.insert(canonical) {
            duplicate_triangle_count += 1;
        }
        used_vertices.extend(triangle);

        for (from, to) in [
            (triangle[0], triangle[1]),
            (triangle[1], triangle[2]),
            (triangle[2], triangle[0]),
        ] {
            let key = if from < to { (from, to) } else { (to, from) };
            edges.entry(key).or_default().push(DirectedEdge {
                triangle: triangle_index,
                from,
                to,
            });
        }
    }

    let mut boundary_edges = Vec::new();
    let mut nonmanifold_edge_count = 0;
    let mut orientation_mismatch_count = 0;
    for ((low, high), incidence) in &edges {
        match incidence.as_slice() {
            [edge] => boundary_edges.push((edge.from, edge.to)),
            [first, second] => {
                triangle_adjacency[first.triangle].push(second.triangle);
                triangle_adjacency[second.triangle].push(first.triangle);
                if first.from != second.to || first.to != second.from {
                    orientation_mismatch_count += 1;
                }
            }
            many => {
                nonmanifold_edge_count += 1;
                for left in 0..many.len() {
                    for right in (left + 1)..many.len() {
                        triangle_adjacency[many[left].triangle].push(many[right].triangle);
                        triangle_adjacency[many[right].triangle].push(many[left].triangle);
                    }
                }
            }
        }
        let _ = (low, high);
    }

    let mut visited_triangles = vec![false; triangles.len()];
    let mut connected_component_count = 0;
    for triangle_index in 0..triangles.len() {
        if visited_triangles[triangle_index]
            || triangles[triangle_index]
                .iter()
                .any(|index| *index >= vertex_count)
        {
            continue;
        }
        connected_component_count += 1;
        let mut pending = vec![triangle_index];
        visited_triangles[triangle_index] = true;
        while let Some(current) = pending.pop() {
            for neighbor in triangle_adjacency[current].iter().copied() {
                if !visited_triangles[neighbor] {
                    visited_triangles[neighbor] = true;
                    pending.push(neighbor);
                }
            }
        }
    }

    let mut boundary_adjacency: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (from, to) in &boundary_edges {
        boundary_adjacency.entry(*from).or_default().push(*to);
        boundary_adjacency.entry(*to).or_default().push(*from);
    }
    let mut visited_boundary_vertices = BTreeSet::new();
    let mut boundary_loop_count = 0;
    for vertex in boundary_adjacency.keys().copied().collect::<Vec<_>>() {
        if !visited_boundary_vertices.insert(vertex) {
            continue;
        }
        boundary_loop_count += 1;
        let mut pending = vec![vertex];
        while let Some(current) = pending.pop() {
            if let Some(neighbors) = boundary_adjacency.get(&current) {
                for neighbor in neighbors {
                    if visited_boundary_vertices.insert(*neighbor) {
                        pending.push(*neighbor);
                    }
                }
            }
        }
    }

    SupportTopologyQualification {
        connected_component_count,
        boundary_edge_count: boundary_edges.len(),
        boundary_loop_count,
        euler_characteristic: used_vertices.len() as i64 - edges.len() as i64
            + triangles.len() as i64,
        duplicate_triangle_count,
        nonmanifold_edge_count,
        orientation_mismatch_count,
        invalid_triangle_count,
    }
}

/// Qualify whether the boundary is sufficiently close to a constant direction
/// for nearest-integer interpretation.  This does not change the integral.
pub fn qualify_boundary(
    points_uv: &[[f64; 2]],
    samples: &[[f64; 3]],
    boundary_edges: &[[usize; 2]],
) -> Result<BoundaryQualification, TopologicalChargeError> {
    if points_uv.len() != samples.len() {
        return Err(TopologicalChargeError::SampleCountMismatch {
            expected: points_uv.len(),
            actual: samples.len(),
        });
    }
    if boundary_edges.is_empty() {
        return Ok(BoundaryQualification {
            mean_direction: None,
            max_deviation_rad: None,
            is_uniform: false,
        });
    }

    let normalized = samples
        .iter()
        .copied()
        .enumerate()
        .map(|(index, sample)| {
            normalize_sample(sample).ok_or(TopologicalChargeError::InvalidSample { index })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut sums = [0.0_f64; 3];
    let mut compensations = [0.0_f64; 3];
    let mut boundary_vertices = BTreeSet::new();
    for edge in boundary_edges {
        let from = edge[0];
        let to = edge[1];
        if from >= points_uv.len() || to >= points_uv.len() {
            return Err(TopologicalChargeError::BoundaryIndexOutOfBounds {
                index: from.max(to),
                sample_count: points_uv.len(),
            });
        }
        let dx = points_uv[to][0] - points_uv[from][0];
        let dy = points_uv[to][1] - points_uv[from][1];
        let length = dx.hypot(dy);
        if !length.is_finite() || length <= 0.0 {
            continue;
        }
        boundary_vertices.insert(from);
        boundary_vertices.insert(to);
        for component in 0..3 {
            neumaier_add(
                &mut sums[component],
                &mut compensations[component],
                length * normalized[from][component],
            );
            neumaier_add(
                &mut sums[component],
                &mut compensations[component],
                length * normalized[to][component],
            );
        }
    }

    let mean = [
        sums[0] + compensations[0],
        sums[1] + compensations[1],
        sums[2] + compensations[2],
    ];
    let Some(mean_direction) = normalize_sample(mean) else {
        return Ok(BoundaryQualification {
            mean_direction: None,
            max_deviation_rad: None,
            is_uniform: false,
        });
    };

    let max_deviation_rad = boundary_vertices
        .into_iter()
        .map(|index| safe_edge_angle(mean_direction, normalized[index]))
        .fold(0.0_f64, f64::max);
    Ok(BoundaryQualification {
        mean_direction: Some(mean_direction),
        max_deviation_rad: Some(max_deviation_rad),
        is_uniform: max_deviation_rad <= 10.0_f64.to_radians(),
    })
}

#[derive(Debug, Clone)]
pub struct TopologicalChargeResult {
    pub charge: f64,
    pub sample_count: usize,
    pub valid_sample_count: usize,
    pub warnings: Vec<TopologicalChargeWarning>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TopologicalChargeWarningCode {
    NonUnitMagnetization,
    InsufficientSamples,
}

#[derive(Debug, Clone)]
pub struct TopologicalChargeWarning {
    pub code: TopologicalChargeWarningCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TopologicalChargeError {
    SampleCountMismatch { expected: usize, actual: usize },
    TriangleIndexOutOfBounds { index: usize, sample_count: usize },
    BoundaryIndexOutOfBounds { index: usize, sample_count: usize },
    InvalidSample { index: usize },
    ExceptionalTriangle { triangle: usize },
    NoValidTriangles,
    NonFiniteCharge,
}

/// Compute the Berg-Luescher oriented-triangle sum without deciding mesh scope,
/// plane selection, cache identity, or transport status.
///
/// The function is deliberately strict: one invalid support sample or one
/// ambiguous spherical triangle invalidates the result.  It never produces a
/// deceptively harmless zero by silently dropping triangles.
pub fn compute_oriented_charge(
    input: OrientedChargeInput<'_>,
) -> Result<OrientedChargeResult, TopologicalChargeError> {
    if input.triangles.is_empty() {
        return Err(TopologicalChargeError::NoValidTriangles);
    }

    let mut normalized = Vec::with_capacity(input.samples.len());
    for (index, sample) in input.samples.iter().copied().enumerate() {
        normalized
            .push(normalize_sample(sample).ok_or(TopologicalChargeError::InvalidSample { index })?);
    }

    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    let mut max_edge_angle_rad = 0.0_f64;
    let mut min_abs_solid_angle_denominator = f64::INFINITY;

    for (triangle_index, triangle) in input.triangles.iter().copied().enumerate() {
        let a = *normalized.get(triangle[0]).ok_or(
            TopologicalChargeError::TriangleIndexOutOfBounds {
                index: triangle[0],
                sample_count: normalized.len(),
            },
        )?;
        let b = *normalized.get(triangle[1]).ok_or(
            TopologicalChargeError::TriangleIndexOutOfBounds {
                index: triangle[1],
                sample_count: normalized.len(),
            },
        )?;
        let c = *normalized.get(triangle[2]).ok_or(
            TopologicalChargeError::TriangleIndexOutOfBounds {
                index: triangle[2],
                sample_count: normalized.len(),
            },
        )?;

        let edge_angles = [
            safe_edge_angle(a, b),
            safe_edge_angle(b, c),
            safe_edge_angle(c, a),
        ];
        let triangle_max_edge_angle = edge_angles.into_iter().fold(0.0_f64, f64::max);
        max_edge_angle_rad = max_edge_angle_rad.max(triangle_max_edge_angle);

        let numerator = dot(a, cross(b, c));
        let denominator = 1.0 + dot(a, b) + dot(b, c) + dot(c, a);
        min_abs_solid_angle_denominator = min_abs_solid_angle_denominator.min(denominator.abs());
        let antipodal = edge_angles
            .into_iter()
            .any(|angle| PI - angle <= ANTIPODAL_ANGLE_EPSILON_RAD);
        if (numerator.abs() <= EXCEPTION_EPSILON && denominator.abs() <= EXCEPTION_EPSILON)
            || antipodal
        {
            return Err(TopologicalChargeError::ExceptionalTriangle {
                triangle: triangle_index,
            });
        }

        let solid_angle = 2.0 * numerator.atan2(denominator);
        if !solid_angle.is_finite() {
            return Err(TopologicalChargeError::NonFiniteCharge);
        }
        neumaier_add(&mut sum, &mut compensation, solid_angle);
    }

    let charge = (sum + compensation) / (4.0 * PI);
    if !charge.is_finite() {
        return Err(TopologicalChargeError::NonFiniteCharge);
    }

    Ok(OrientedChargeResult {
        charge,
        quality: OrientedChargeQuality {
            total_vertex_count: input.samples.len(),
            valid_vertex_count: input.samples.len(),
            total_triangle_count: input.triangles.len(),
            valid_triangle_count: input.triangles.len(),
            invalid_triangle_count: 0,
            exceptional_triangle_count: 0,
            max_edge_angle_rad,
            min_abs_solid_angle_denominator,
            under_resolved: max_edge_angle_rad >= UNDER_RESOLVED_EDGE_ANGLE_RAD,
        },
    })
}

fn normalize_sample(sample: [f64; 3]) -> Option<[f64; 3]> {
    if sample.iter().any(|component| !component.is_finite()) {
        return None;
    }
    let scale = sample.into_iter().map(f64::abs).fold(0.0_f64, f64::max);
    if scale == 0.0 {
        return None;
    }
    let scaled = [sample[0] / scale, sample[1] / scale, sample[2] / scale];
    let scaled_norm = dot(scaled, scaled).sqrt();
    if !scaled_norm.is_finite() || scale <= MIN_VECTOR_NORM / scaled_norm {
        return None;
    }
    Some([
        scaled[0] / scaled_norm,
        scaled[1] / scaled_norm,
        scaled[2] / scaled_norm,
    ])
}

fn safe_edge_angle(a: [f64; 3], b: [f64; 3]) -> f64 {
    dot(a, b).clamp(-1.0, 1.0).acos()
}

fn neumaier_add(sum: &mut f64, compensation: &mut f64, value: f64) {
    let next = *sum + value;
    if sum.abs() >= value.abs() {
        *compensation += (*sum - next) + value;
    } else {
        *compensation += (value - next) + *sum;
    }
    *sum = next;
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[cfg(test)]
mod tests {
    #[test]
    fn oriented_kernel_reverses_charge_when_every_triangle_is_reversed() {
        let samples = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let forward_triangles = [[0, 1, 2]];
        let reversed_triangles = [[0, 2, 1]];

        let forward = super::compute_oriented_charge(super::OrientedChargeInput::new(
            &samples,
            &forward_triangles,
        ))
        .expect("forward triangle should be valid");
        let reversed = super::compute_oriented_charge(super::OrientedChargeInput::new(
            &samples,
            &reversed_triangles,
        ))
        .expect("reversed triangle should be valid");

        assert!((forward.charge + reversed.charge).abs() <= 1.0e-12);
    }

    #[test]
    fn oriented_kernel_rejects_invalid_samples_instead_of_skipping_them() {
        let samples = [[0.0, 0.0, 1.0], [0.0; 3], [0.0; 3], [0.0; 3]];
        let triangles = [[0, 1, 3], [0, 3, 2]];

        let error =
            super::compute_oriented_charge(super::OrientedChargeInput::new(&samples, &triangles))
                .expect_err("an invalid support must not be reported as a zero charge");

        assert_eq!(
            error,
            super::TopologicalChargeError::InvalidSample { index: 1 }
        );
    }

    #[test]
    fn oriented_kernel_rejects_antipodal_triangle_as_exceptional() {
        let samples = [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let triangles = [[0, 1, 2]];

        let error =
            super::compute_oriented_charge(super::OrientedChargeInput::new(&samples, &triangles))
                .expect_err("an antipodal edge makes the solid angle ambiguous");

        assert_eq!(
            error,
            super::TopologicalChargeError::ExceptionalTriangle { triangle: 0 }
        );
    }

    #[test]
    fn support_qualification_reports_a_single_disk_boundary() {
        let qualification = super::qualify_support_topology(4, &[[0, 1, 2], [0, 2, 3]]);

        assert_eq!(qualification.connected_component_count, 1);
        assert_eq!(qualification.boundary_edge_count, 4);
        assert_eq!(qualification.boundary_loop_count, 1);
        assert_eq!(qualification.euler_characteristic, 1);
        assert_eq!(qualification.duplicate_triangle_count, 0);
        assert_eq!(qualification.nonmanifold_edge_count, 0);
        assert_eq!(qualification.orientation_mismatch_count, 0);
    }

    #[test]
    fn support_qualification_does_not_hide_duplicate_or_orientation_failures() {
        let duplicate = super::qualify_support_topology(3, &[[0, 1, 2], [2, 1, 0]]);
        assert_eq!(duplicate.duplicate_triangle_count, 1);

        let orientation_mismatch = super::qualify_support_topology(4, &[[0, 1, 2], [0, 3, 2]]);
        assert_eq!(orientation_mismatch.orientation_mismatch_count, 1);
    }

    #[test]
    fn support_qualification_reports_nonmanifold_edge_and_disconnected_components() {
        let nonmanifold = super::qualify_support_topology(5, &[[0, 1, 2], [1, 0, 3], [0, 1, 4]]);
        assert_eq!(nonmanifold.nonmanifold_edge_count, 1);

        let disconnected = super::qualify_support_topology(6, &[[0, 1, 2], [3, 4, 5]]);
        assert_eq!(disconnected.connected_component_count, 2);
    }

    #[test]
    fn boundary_qualification_accepts_uniform_length_weighted_boundary() {
        let points = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let samples = [[0.0, 0.0, 1.0]; 4];
        let boundary = [[0, 1], [1, 2], [2, 3], [3, 0]];

        let qualification = super::qualify_boundary(&points, &samples, &boundary)
            .expect("uniform boundary should be valid");

        assert!(qualification.is_uniform);
        assert_eq!(qualification.max_deviation_rad, Some(0.0));
    }

    #[test]
    fn boundary_qualification_rejects_deviation_over_ten_degrees_and_cancelling_mean() {
        let points = [[0.0, 0.0], [1.0, 0.0]];
        let twenty_two_degrees = 22.0_f64.to_radians();
        let samples = [
            [0.0, 0.0, 1.0],
            [twenty_two_degrees.sin(), 0.0, twenty_two_degrees.cos()],
        ];
        let qualification = super::qualify_boundary(&points, &samples, &[[0, 1]])
            .expect("finite boundary should be valid");
        assert!(!qualification.is_uniform);
        assert!(qualification.max_deviation_rad.unwrap() > 10.0_f64.to_radians());

        let cancelling =
            super::qualify_boundary(&points, &[[0.0, 0.0, 1.0], [0.0, 0.0, -1.0]], &[[0, 1]])
                .expect("cancelling boundary has valid samples");
        assert!(cancelling.mean_direction.is_none());
        assert!(!cancelling.is_uniform);
    }
}
