use std::f64::consts::PI;

#[derive(Debug, Clone, Copy)]
pub struct TopologicalChargeInput<'a> {
    pub samples: &'a [[f64; 3]],
    pub nx: usize,
    pub ny: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct TopologicalChargeTriangleInput<'a> {
    pub samples: &'a [[f64; 3]],
    pub triangles: &'a [[usize; 3]],
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
}

pub fn compute_topological_charge_grid(
    input: TopologicalChargeInput<'_>,
) -> Result<TopologicalChargeResult, TopologicalChargeError> {
    let expected = input.nx.saturating_mul(input.ny);
    if input.samples.len() != expected {
        return Err(TopologicalChargeError::SampleCountMismatch {
            expected,
            actual: input.samples.len(),
        });
    }

    let mut warnings = Vec::new();
    if input.nx < 2 || input.ny < 2 {
        warnings.push(TopologicalChargeWarning {
            code: TopologicalChargeWarningCode::InsufficientSamples,
            message: "Topological charge requires at least a 2x2 sample grid.".to_string(),
        });
        return Ok(TopologicalChargeResult {
            charge: 0.0,
            sample_count: input.samples.len(),
            valid_sample_count: 0,
            warnings,
        });
    }

    let (normalized, valid_sample_count, normalize_warnings) =
        normalize_samples(input.samples, norm_warning_tolerance(expected));
    warnings.extend(normalize_warnings);

    let mut solid_angle_sum = 0.0;
    for y in 0..(input.ny - 1) {
        for x in 0..(input.nx - 1) {
            let p00 = normalized[index(x, y, input.nx)];
            let p10 = normalized[index(x + 1, y, input.nx)];
            let p01 = normalized[index(x, y + 1, input.nx)];
            let p11 = normalized[index(x + 1, y + 1, input.nx)];

            if let (Some(a), Some(b), Some(c)) = (p00, p10, p11) {
                solid_angle_sum += triangle_solid_angle(a, b, c);
            }
            if let (Some(a), Some(b), Some(c)) = (p00, p11, p01) {
                solid_angle_sum += triangle_solid_angle(a, b, c);
            }
        }
    }

    Ok(TopologicalChargeResult {
        charge: solid_angle_sum / (4.0 * PI),
        sample_count: input.samples.len(),
        valid_sample_count,
        warnings,
    })
}

pub fn compute_topological_charge_triangles(
    input: TopologicalChargeTriangleInput<'_>,
) -> Result<TopologicalChargeResult, TopologicalChargeError> {
    let mut warnings = Vec::new();
    if input.samples.len() < 3 || input.triangles.is_empty() {
        warnings.push(TopologicalChargeWarning {
            code: TopologicalChargeWarningCode::InsufficientSamples,
            message: "Topological charge requires at least one oriented triangle.".to_string(),
        });
        return Ok(TopologicalChargeResult {
            charge: 0.0,
            sample_count: input.samples.len(),
            valid_sample_count: 0,
            warnings,
        });
    }

    for triangle in input.triangles {
        for index in triangle {
            if *index >= input.samples.len() {
                return Err(TopologicalChargeError::TriangleIndexOutOfBounds {
                    index: *index,
                    sample_count: input.samples.len(),
                });
            }
        }
    }

    let (normalized, valid_sample_count, normalize_warnings) =
        normalize_samples(input.samples, norm_warning_tolerance(input.samples.len()));
    warnings.extend(normalize_warnings);

    let mut solid_angle_sum = 0.0;
    for triangle in input.triangles {
        let a = normalized[triangle[0]];
        let b = normalized[triangle[1]];
        let c = normalized[triangle[2]];
        if let (Some(a), Some(b), Some(c)) = (a, b, c) {
            solid_angle_sum += triangle_solid_angle(a, b, c);
        }
    }

    Ok(TopologicalChargeResult {
        charge: solid_angle_sum / (4.0 * PI),
        sample_count: input.samples.len(),
        valid_sample_count,
        warnings,
    })
}

fn normalize_samples(
    samples: &[[f64; 3]],
    norm_tolerance: f64,
) -> (Vec<Option<[f64; 3]>>, usize, Vec<TopologicalChargeWarning>) {
    let mut saw_non_unit = false;
    let normalized: Vec<Option<[f64; 3]>> = samples
        .iter()
        .map(|sample| {
            let norm_squared = dot(*sample, *sample);
            if norm_squared <= 1.0e-24 || !norm_squared.is_finite() {
                saw_non_unit = true;
                return None;
            }
            let norm = norm_squared.sqrt();
            if (norm - 1.0).abs() > norm_tolerance {
                saw_non_unit = true;
            }
            Some([sample[0] / norm, sample[1] / norm, sample[2] / norm])
        })
        .collect();
    let valid_sample_count = normalized.iter().filter(|sample| sample.is_some()).count();
    let warnings = if saw_non_unit {
        vec![TopologicalChargeWarning {
            code: TopologicalChargeWarningCode::NonUnitMagnetization,
            message: "One or more magnetization samples were normalized or rejected.".to_string(),
        }]
    } else {
        Vec::new()
    };
    (normalized, valid_sample_count, warnings)
}

fn norm_warning_tolerance(samples: usize) -> f64 {
    let samples = samples.max(1) as f64;
    (1.0 / samples).clamp(1.0e-6, 1.0e-3)
}

fn index(x: usize, y: usize, nx: usize) -> usize {
    y * nx + x
}

fn triangle_solid_angle(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> f64 {
    let numerator = dot(a, cross(b, c));
    let denominator = 1.0 + dot(a, b) + dot(b, c) + dot(c, a);
    2.0 * numerator.atan2(denominator)
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
    use super::{
        compute_topological_charge_grid, compute_topological_charge_triangles,
        TopologicalChargeInput, TopologicalChargeTriangleInput, TopologicalChargeWarningCode,
    };

    fn uniform_grid(nx: usize, ny: usize) -> Vec<[f64; 3]> {
        vec![[0.0, 0.0, 1.0]; nx * ny]
    }

    fn neel_skyrmion_grid(nx: usize, ny: usize, radius: f64, wall_width: f64) -> Vec<[f64; 3]> {
        let mut samples = Vec::with_capacity(nx * ny);
        let center_x = 0.5 * (nx - 1) as f64;
        let center_y = 0.5 * (ny - 1) as f64;
        let span = 2.4 * radius;

        for y in 0..ny {
            let py = ((y as f64 - center_y) / center_y.max(1.0)) * span;
            for x in 0..nx {
                let px = ((x as f64 - center_x) / center_x.max(1.0)) * span;
                let r = (px * px + py * py).sqrt();
                let phi = py.atan2(px);
                let theta = 2.0 * (-(r - radius) / wall_width).exp().atan();
                samples.push([
                    theta.sin() * phi.cos(),
                    theta.sin() * phi.sin(),
                    theta.cos(),
                ]);
            }
        }

        samples
    }

    #[test]
    fn uniform_magnetization_has_zero_topological_charge() {
        let result = compute_topological_charge_grid(TopologicalChargeInput {
            samples: &uniform_grid(17, 19),
            nx: 17,
            ny: 19,
        })
        .expect("uniform grid should be valid");

        assert!(result.charge.abs() < 1.0e-6, "charge was {}", result.charge);
        assert_eq!(result.sample_count, 17 * 19);
        assert_eq!(result.valid_sample_count, 17 * 19);
        assert!(result.warnings.is_empty());
    }

    #[test]
    fn analytic_neel_skyrmion_integrates_to_unit_charge_with_known_orientation() {
        let samples = neel_skyrmion_grid(81, 81, 1.0, 0.12);

        let result = compute_topological_charge_grid(TopologicalChargeInput {
            samples: &samples,
            nx: 81,
            ny: 81,
        })
        .expect("skyrmion grid should be valid");

        assert!(
            (result.charge + 1.0).abs() < 0.08,
            "expected Q close to -1 for this orientation, got {}",
            result.charge
        );
        assert_eq!(result.valid_sample_count, 81 * 81);
    }

    #[test]
    fn zero_length_vectors_emit_warning_and_do_not_panic() {
        let mut samples = uniform_grid(5, 5);
        samples[12] = [0.0, 0.0, 0.0];

        let result = compute_topological_charge_grid(TopologicalChargeInput {
            samples: &samples,
            nx: 5,
            ny: 5,
        })
        .expect("grid with one invalid vector should return a diagnostic result");

        assert_eq!(result.valid_sample_count, 24);
        assert!(result.charge.is_finite());
        let non_unit_warning = result
            .warnings
            .iter()
            .find(|warning| warning.code == TopologicalChargeWarningCode::NonUnitMagnetization)
            .expect("zero vector should emit a non-unit magnetization warning");
        assert!(non_unit_warning.message.contains("normalized or rejected"));
    }

    #[test]
    fn oriented_triangle_mesh_integrates_like_grid() {
        let nx = 41;
        let ny = 41;
        let samples = neel_skyrmion_grid(nx, ny, 1.0, 0.12);
        let mut triangles = Vec::new();
        for y in 0..(ny - 1) {
            for x in 0..(nx - 1) {
                let p00 = y * nx + x;
                let p10 = y * nx + x + 1;
                let p01 = (y + 1) * nx + x;
                let p11 = (y + 1) * nx + x + 1;
                triangles.push([p00, p10, p11]);
                triangles.push([p00, p11, p01]);
            }
        }

        let result = compute_topological_charge_triangles(TopologicalChargeTriangleInput {
            samples: &samples,
            triangles: &triangles,
        })
        .expect("oriented triangle mesh should be valid");

        assert!(
            (result.charge + 1.0).abs() < 0.12,
            "expected Q close to -1 for oriented skyrmion mesh, got {}",
            result.charge
        );
        assert_eq!(result.sample_count, nx * ny);
        assert_eq!(result.valid_sample_count, nx * ny);
    }
}
