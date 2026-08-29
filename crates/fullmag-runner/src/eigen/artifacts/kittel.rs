use super::common::*;
use crate::eigen::types::{
    K0KittelPeriodicAirboxDemagMetrics, PathSolveResult, SingleKModeResult, TrackedBranch,
};
use crate::types::AuxiliaryArtifact;
use num_complex::Complex64;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Error, ErrorKind};
use std::path::Path;

#[derive(Debug, Clone)]
struct K0KittelExpectedPoint {
    field_index: usize,
    sample_index: usize,
    h0_a_per_m: f64,
    expected_frequency_hz: f64,
}

#[derive(Debug, Clone)]
struct K0KittelSelectedPoint {
    field_index: usize,
    h0_a_per_m: f64,
    expected_frequency_hz: f64,
    eigen_frequency_hz: f64,
    relative_frequency_error: f64,
    selected_mode_index: usize,
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    mode_residual_relative: f64,
    uniformity_score: f64,
    branch_overlap_previous: f64,
    max_m0_dot_delta_m_abs: f64,
    max_periodic_seam_mismatch: f64,
}

#[derive(Debug, Clone)]
struct K0KittelSelectedBranch {
    branch_id: usize,
    label: Option<String>,
    max_relative_frequency_error: f64,
    median_relative_frequency_error: f64,
    minimum_uniformity_score: f64,
    minimum_branch_overlap: f64,
    maximum_tangent_leakage: f64,
    points: Vec<K0KittelSelectedPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KittelFitPointArtifact {
    pub sample_id: String,
    pub mode_id: String,
    pub sample_index: usize,
    pub bias_field_a_per_m: [f64; 3],
    pub expected_frequency_hz: f64,
    pub solved_frequency_hz: f64,
    pub relative_frequency_error: f64,
    pub branch_id: usize,
    pub status: ServerArtifactStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KittelFitParameterArtifact {
    pub name: String,
    pub value: f64,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KittelFitArtifact {
    pub schema_version: &'static str,
    pub artifact_id: String,
    pub source: ServerArtifactSource,
    pub source_revision: String,
    pub run_id: String,
    pub stage_id: String,
    pub scope_id: String,
    pub runtime_id: String,
    pub revision: String,
    pub content_sha256: String,
    pub status: ServerArtifactStatus,
    pub complete: bool,
    pub interrupted: bool,
    pub stop_reason: Option<String>,
    pub model: String,
    pub units: ServerArtifactUnits,
    pub topology: ServerArtifactTopology,
    pub requested_execution: ServerArtifactExecution,
    pub resolved_execution: ServerArtifactExecution,
    pub parameters: Vec<KittelFitParameterArtifact>,
    pub covariance: Option<Vec<Vec<f64>>>,
    pub conditioning: Option<f64>,
    pub validation_status: String,
    pub validation_tolerance_relative: Option<f64>,
    pub excluded_samples: Vec<usize>,
    pub points: Vec<KittelFitPointArtifact>,
    pub cross_artifact_refs: Vec<ServerArtifactReference>,
}

fn invalid_k0_kittel_artifact(message: impl Into<String>) -> Error {
    Error::new(ErrorKind::InvalidData, message.into())
}

fn vector3_norm(value: [f64; 3]) -> f64 {
    value
        .iter()
        .map(|component| component * component)
        .sum::<f64>()
        .sqrt()
}

fn finite_non_negative_or_default(value: Option<f64>, default: f64) -> f64 {
    match value {
        Some(candidate) if candidate.is_finite() && candidate >= 0.0 => candidate,
        _ => default,
    }
}

fn unit_interval_or_default(value: Option<f64>, default: f64) -> f64 {
    match value {
        Some(candidate) if candidate.is_finite() => candidate.clamp(0.0, 1.0),
        _ => default,
    }
}

fn k0_kittel_validation_case_id(validation: &fullmag_ir::FemEigenK0KittelValidationIR) -> &str {
    validation.case_id.as_deref().unwrap_or("K0-1")
}

fn k0_kittel_validation_demag_kind(validation: &fullmag_ir::FemEigenK0KittelValidationIR) -> &str {
    validation.demag_kind.as_deref().unwrap_or("none")
}

fn median_non_negative(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 0 {
        (sorted[mid - 1] + sorted[mid]) * 0.5
    } else {
        sorted[mid]
    }
}

fn complex_norm_sqr(value: Complex64) -> f64 {
    value.re * value.re + value.im * value.im
}

fn uniformity_score_from_complex_xyz(values: &[Complex64]) -> Option<f64> {
    if values.len() < 3 || values.len() % 3 != 0 {
        return None;
    }
    let node_count = values.len() / 3;
    let mut mean = [Complex64::new(0.0, 0.0); 3];
    let mut denominator = 0.0;
    for node in values.chunks_exact(3) {
        for component in 0..3 {
            mean[component] += node[component];
            denominator += complex_norm_sqr(node[component]);
        }
    }
    if !(denominator.is_finite() && denominator > 0.0) {
        return None;
    }
    let inv_node_count = 1.0 / node_count as f64;
    let numerator = node_count as f64
        * mean
            .iter()
            .map(|value| complex_norm_sqr(*value * inv_node_count))
            .sum::<f64>();
    Some((numerator / denominator).clamp(0.0, 1.0))
}

fn weighted_uniformity_score_from_complex_xyz(
    values: &[Complex64],
    weights: &[f64],
) -> Option<f64> {
    if values.len() < 3 || values.len() % 3 != 0 {
        return None;
    }
    let node_count = values.len() / 3;
    if weights.len() != node_count {
        return None;
    }
    let mut total_weight = 0.0;
    let mut mean = [Complex64::new(0.0, 0.0); 3];
    let mut denominator = 0.0;
    for (node, weight) in values.chunks_exact(3).zip(weights.iter().copied()) {
        if !(weight.is_finite() && weight > 0.0) {
            return None;
        }
        total_weight += weight;
        for component in 0..3 {
            mean[component] += node[component] * weight;
            denominator += weight * complex_norm_sqr(node[component]);
        }
    }
    if !(total_weight.is_finite()
        && total_weight > 0.0
        && denominator.is_finite()
        && denominator > 0.0)
    {
        return None;
    }
    let numerator = total_weight
        * mean
            .iter()
            .map(|value| complex_norm_sqr(*value / total_weight))
            .sum::<f64>();
    Some((numerator / denominator).clamp(0.0, 1.0))
}

fn uniformity_score_from_tangent_components(values: &[Complex64]) -> Option<f64> {
    if values.len() < 2 || values.len() % 2 != 0 {
        return None;
    }
    let node_count = values.len() / 2;
    let mut mean = [Complex64::new(0.0, 0.0); 2];
    let mut denominator = 0.0;
    for node_index in 0..node_count {
        let u = values[node_index];
        let v = values[node_index + node_count];
        mean[0] += u;
        mean[1] += v;
        denominator += complex_norm_sqr(u) + complex_norm_sqr(v);
    }
    if !(denominator.is_finite() && denominator > 0.0) {
        return None;
    }
    let inv_node_count = 1.0 / node_count as f64;
    let numerator = node_count as f64
        * mean
            .iter()
            .map(|value| complex_norm_sqr(*value * inv_node_count))
            .sum::<f64>();
    Some((numerator / denominator).clamp(0.0, 1.0))
}

fn weighted_uniformity_score_from_tangent_components(
    values: &[Complex64],
    weights: &[f64],
) -> Option<f64> {
    if values.len() < 2 || values.len() % 2 != 0 {
        return None;
    }
    let node_count = values.len() / 2;
    if weights.len() != node_count {
        return None;
    }
    let mut total_weight = 0.0;
    let mut mean = [Complex64::new(0.0, 0.0); 2];
    let mut denominator = 0.0;
    for node_index in 0..node_count {
        let weight = weights[node_index];
        if !(weight.is_finite() && weight > 0.0) {
            return None;
        }
        let u = values[node_index];
        let v = values[node_index + node_count];
        total_weight += weight;
        mean[0] += u * weight;
        mean[1] += v * weight;
        denominator += weight * (complex_norm_sqr(u) + complex_norm_sqr(v));
    }
    if !(total_weight.is_finite()
        && total_weight > 0.0
        && denominator.is_finite()
        && denominator > 0.0)
    {
        return None;
    }
    let numerator = total_weight
        * mean
            .iter()
            .map(|value| complex_norm_sqr(*value / total_weight))
            .sum::<f64>();
    Some((numerator / denominator).clamp(0.0, 1.0))
}

fn uniformity_score_from_lifted_vectors(real: &[[f64; 3]], imag: &[[f64; 3]]) -> Option<f64> {
    let node_count = real.len().max(imag.len());
    if node_count == 0 {
        return None;
    }
    let mut mean = [Complex64::new(0.0, 0.0); 3];
    let mut denominator = 0.0;
    for index in 0..node_count {
        let real_node = real.get(index).copied().unwrap_or([0.0, 0.0, 0.0]);
        let imag_node = imag.get(index).copied().unwrap_or([0.0, 0.0, 0.0]);
        for component in 0..3 {
            let value = Complex64::new(real_node[component], imag_node[component]);
            mean[component] += value;
            denominator += complex_norm_sqr(value);
        }
    }
    if !(denominator.is_finite() && denominator > 0.0) {
        return None;
    }
    let inv_node_count = 1.0 / node_count as f64;
    let numerator = node_count as f64
        * mean
            .iter()
            .map(|value| complex_norm_sqr(*value * inv_node_count))
            .sum::<f64>();
    Some((numerator / denominator).clamp(0.0, 1.0))
}

fn k0_kittel_mode_uniformity_score(mode: &SingleKModeResult) -> Option<f64> {
    if let Some(values) = mode.reduced_vector.as_deref() {
        if let Some(weights) = mode.node_mass_weights.as_deref() {
            if let Some(score) = weighted_uniformity_score_from_complex_xyz(values, weights)
                .or_else(|| weighted_uniformity_score_from_tangent_components(values, weights))
            {
                return Some(score);
            }
        }
        if let Some(score) = uniformity_score_from_complex_xyz(values)
            .or_else(|| uniformity_score_from_tangent_components(values))
        {
            return Some(score);
        }
    }
    match (mode.lifted_real.as_deref(), mode.lifted_imag.as_deref()) {
        (Some(real), Some(imag)) => uniformity_score_from_lifted_vectors(real, imag),
        (Some(real), None) => uniformity_score_from_lifted_vectors(real, &[]),
        (None, Some(imag)) => uniformity_score_from_lifted_vectors(&[], imag),
        (None, None) => None,
    }
}

fn k0_kittel_expected_frequency_hz(
    validation: &fullmag_ir::FemEigenK0KittelValidationIR,
    h0_a_per_m: f64,
) -> std::io::Result<f64> {
    match validation.model.as_str() {
        "macrospin_larmor" => {
            Ok(REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M * h0_a_per_m / std::f64::consts::TAU)
        }
        "thin_film_in_plane" => {
            let effective_magnetisation = validation
                .material
                .effective_magnetisation
                .filter(|value| value.is_finite() && *value >= 0.0)
                .ok_or_else(|| {
                    invalid_k0_kittel_artifact(
                        "thin_film_in_plane Kittel validation requires finite effective_magnetisation",
                    )
                })?;
            Ok(REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M
                * (h0_a_per_m * (h0_a_per_m + effective_magnetisation)).sqrt()
                / std::f64::consts::TAU)
        }
        other => Err(invalid_k0_kittel_artifact(format!(
            "unsupported K0 Kittel validation model: {other}"
        ))),
    }
}

fn k0_kittel_expected_points(
    validation: &fullmag_ir::FemEigenK0KittelValidationIR,
) -> std::io::Result<Vec<K0KittelExpectedPoint>> {
    validation
        .samples
        .iter()
        .enumerate()
        .map(|(field_index, sample)| {
            let bias_field_a_per_m = sample.bias_field;
            if !bias_field_a_per_m
                .iter()
                .all(|component| component.is_finite())
            {
                return Err(invalid_k0_kittel_artifact(
                    "K0 Kittel validation bias field must be finite",
                ));
            }
            let h0_a_per_m = vector3_norm(bias_field_a_per_m);
            if h0_a_per_m <= 0.0 {
                return Err(invalid_k0_kittel_artifact(
                    "K0 Kittel validation bias field magnitude must be positive",
                ));
            }
            Ok(K0KittelExpectedPoint {
                field_index,
                sample_index: sample.sample_index as usize,
                h0_a_per_m,
                expected_frequency_hz: k0_kittel_expected_frequency_hz(validation, h0_a_per_m)?,
            })
        })
        .collect()
}

fn k0_kittel_branch_candidate(
    result: &PathSolveResult,
    branch: &TrackedBranch,
    expected_points: &[K0KittelExpectedPoint],
) -> Option<K0KittelSelectedBranch> {
    let mut points = Vec::with_capacity(expected_points.len());
    for expected in expected_points {
        let branch_point = branch
            .points
            .iter()
            .find(|point| point.sample_index == expected.sample_index)?;
        let sample = result_sample(result, expected.sample_index)?;
        if vector3_norm(sample.sample.k_vector) > 1.0e-9 {
            return None;
        }
        let mode = result_mode(
            result,
            branch_point.sample_index,
            branch_point.raw_mode_index,
        )?;
        let uniformity_score = k0_kittel_mode_uniformity_score(mode)?;
        if !uniformity_score.is_finite() || !(0.0..=1.0).contains(&uniformity_score) {
            return None;
        }
        let eigen_frequency_hz = mode.frequency_real_hz;
        if !eigen_frequency_hz.is_finite() || eigen_frequency_hz < 0.0 {
            return None;
        }
        let relative_frequency_error = if expected.expected_frequency_hz > 0.0 {
            (eigen_frequency_hz - expected.expected_frequency_hz).abs()
                / expected.expected_frequency_hz
        } else if eigen_frequency_hz == 0.0 {
            0.0
        } else {
            f64::INFINITY
        };
        if !relative_frequency_error.is_finite() || relative_frequency_error < 0.0 {
            return None;
        }
        points.push(K0KittelSelectedPoint {
            field_index: expected.field_index,
            h0_a_per_m: expected.h0_a_per_m,
            expected_frequency_hz: expected.expected_frequency_hz,
            eigen_frequency_hz,
            relative_frequency_error,
            selected_mode_index: branch_point.raw_mode_index,
            eigenvalue_real: mode.eigenvalue_real,
            eigenvalue_imag: mode.eigenvalue_imag,
            mode_residual_relative: finite_non_negative_or_default(mode.residual_norm, 0.0),
            uniformity_score,
            branch_overlap_previous: unit_interval_or_default(branch_point.overlap_prev, 1.0),
            max_m0_dot_delta_m_abs: finite_non_negative_or_default(
                mode.tangent_leakage_max_abs,
                0.0,
            ),
            max_periodic_seam_mismatch: 0.0,
        });
    }

    let errors = points
        .iter()
        .map(|point| point.relative_frequency_error)
        .collect::<Vec<_>>();
    let max_relative_frequency_error = errors.iter().copied().fold(0.0, f64::max);
    let minimum_uniformity_score = points
        .iter()
        .map(|point| point.uniformity_score)
        .fold(1.0, f64::min);
    let minimum_branch_overlap = points
        .iter()
        .map(|point| point.branch_overlap_previous)
        .fold(1.0, f64::min);
    let maximum_tangent_leakage = points
        .iter()
        .map(|point| point.max_m0_dot_delta_m_abs)
        .fold(0.0, f64::max);

    Some(K0KittelSelectedBranch {
        branch_id: branch.branch_id,
        label: branch.label.clone(),
        max_relative_frequency_error,
        median_relative_frequency_error: median_non_negative(&errors),
        minimum_uniformity_score,
        minimum_branch_overlap,
        maximum_tangent_leakage,
        points,
    })
}

fn select_k0_kittel_branch(
    result: &PathSolveResult,
    expected_points: &[K0KittelExpectedPoint],
) -> Option<K0KittelSelectedBranch> {
    result
        .branches
        .iter()
        .filter_map(|branch| k0_kittel_branch_candidate(result, branch, expected_points))
        .max_by(|left, right| {
            left.minimum_uniformity_score
                .total_cmp(&right.minimum_uniformity_score)
                .then_with(|| {
                    left.minimum_branch_overlap
                        .total_cmp(&right.minimum_branch_overlap)
                })
                .then_with(|| {
                    // Branch identity must be deterministic, but the analytical
                    // Kittel frequency is only a post-solve validation metric.
                    right.branch_id.cmp(&left.branch_id)
                })
        })
}

/// Build the Kittel comparison as a postsolve derived artifact.  The declared
/// Kittel samples are used only as an analytical reference: this function
/// never turns them into solver input or into a physical field sweep.
pub fn build_kittel_fit_artifact(
    result: &PathSolveResult,
) -> std::io::Result<Option<KittelFitArtifact>> {
    let Some(validation) = result.k0_kittel_validation.as_ref() else {
        return Ok(None);
    };
    let expected_points = k0_kittel_expected_points(validation)?;
    if expected_points.is_empty() {
        return Ok(None);
    }
    let Some(selected_branch) = select_k0_kittel_branch(result, &expected_points) else {
        return Ok(None);
    };
    let source_revision = result_source_revision(result);
    let (requested_execution, resolved_execution, runtime_id) =
        server_execution_from_modal_result(result);
    let points = selected_branch
        .points
        .iter()
        .map(|point| {
            let expected = expected_points
                .iter()
                .find(|expected| expected.field_index == point.field_index)
                .ok_or_else(|| {
                    Error::new(
                        ErrorKind::InvalidData,
                        "Kittel branch point has no matching declared oracle sample",
                    )
                })?;
            let sample = validation
                .samples
                .iter()
                .find(|sample| sample.sample_index as usize == expected.sample_index)
                .ok_or_else(|| {
                    Error::new(
                        ErrorKind::InvalidData,
                        "Kittel oracle point has no declared bias field",
                    )
                })?;
            Ok(KittelFitPointArtifact {
                sample_id: format!("bias-field-sample-{:04}", expected.sample_index),
                mode_id: format!(
                    "sample-{:04}/mode-{:04}",
                    expected.sample_index, point.selected_mode_index
                ),
                sample_index: expected.sample_index,
                bias_field_a_per_m: sample.bias_field,
                expected_frequency_hz: point.expected_frequency_hz,
                solved_frequency_hz: point.eigen_frequency_hz,
                relative_frequency_error: point.relative_frequency_error,
                branch_id: selected_branch.branch_id,
                status: ServerArtifactStatus::Complete,
            })
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    let validation_status = if validation.relative_tolerance.is_finite()
        && selected_branch.max_relative_frequency_error <= validation.relative_tolerance
    {
        "passed"
    } else {
        "failed"
    };
    let mut parameters = vec![KittelFitParameterArtifact {
        name: "gamma0_rad_s_per_A_m".to_string(),
        value: REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M,
        unit: "rad/(s A/m)".to_string(),
    }];
    if let Some(effective_magnetisation) = validation
        .material
        .effective_magnetisation
        .filter(|value| value.is_finite())
    {
        parameters.push(KittelFitParameterArtifact {
            name: "effective_magnetisation".to_string(),
            value: effective_magnetisation,
            unit: "A/m".to_string(),
        });
    }
    let topologies = result
        .samples
        .iter()
        .map(|sample| topology_from_diagnostics(sample_native_solver_diagnostics(sample)))
        .collect::<Vec<_>>();
    let topology_consistent = topologies.windows(2).all(|window| {
        window[0].mesh_id == window[1].mesh_id
            && window[0].topology_revision == window[1].topology_revision
    });
    let topology = if topology_consistent {
        topologies
            .first()
            .cloned()
            .unwrap_or_else(empty_server_topology)
    } else {
        ServerArtifactTopology {
            mesh_id: "topology:inconsistent".to_string(),
            topology_revision: "topology:inconsistent".to_string(),
            ..empty_server_topology()
        }
    };
    let status = if points
        .iter()
        .all(|point| point.status == ServerArtifactStatus::Complete)
    {
        ServerArtifactStatus::Partial
    } else {
        ServerArtifactStatus::Corrupt
    };
    let mut artifact = KittelFitArtifact {
        schema_version: "fmr/kittel_fit.v1",
        artifact_id: "analysis:fmr:kittel-fit".to_string(),
        source: ServerArtifactSource {
            kind: "postsolve_kittel_oracle".to_string(),
            artifact: "eigen/spectrum.v2.json".to_string(),
            revision: source_revision.clone(),
        },
        source_revision,
        run_id: "run:current".to_string(),
        stage_id: "stage:eigenmodes".to_string(),
        scope_id: "scope:k0-kittel-postsolve".to_string(),
        runtime_id,
        revision: String::new(),
        content_sha256: String::new(),
        status,
        complete: false,
        interrupted: false,
        stop_reason: Some("statistical_fit_covariance_not_available".to_string()),
        model: validation.model.clone(),
        units: server_artifact_units_modal(),
        topology,
        requested_execution,
        resolved_execution,
        parameters,
        covariance: None,
        conditioning: None,
        validation_status: validation_status.to_string(),
        validation_tolerance_relative: Some(validation.relative_tolerance),
        excluded_samples: expected_points
            .iter()
            .filter(|expected| {
                !selected_branch
                    .points
                    .iter()
                    .any(|point| point.field_index == expected.field_index)
            })
            .map(|expected| expected.sample_index)
            .collect(),
        points,
        cross_artifact_refs: vec![ServerArtifactReference {
            relation: "source_spectrum".to_string(),
            artifact: "eigen/spectrum.v2.json".to_string(),
            revision: result_source_revision(result),
        }],
    };
    artifact.content_sha256 = canonical_artifact_digest(&artifact);
    artifact.revision = artifact.content_sha256.clone();
    Ok(Some(artifact))
}

pub fn write_kittel_fit_artifact(
    base_dir: &Path,
    result: &PathSolveResult,
) -> std::io::Result<bool> {
    let Some(artifact) = build_kittel_fit_artifact(result)? else {
        return Ok(false);
    };
    let fmr_dir = base_dir.join("fmr");
    fs::create_dir_all(&fmr_dir)?;
    write_json_atomic(&fmr_dir.join("kittel_fit.v1.json"), &artifact)?;
    Ok(true)
}

fn k0_kittel_points_csv_bytes(
    validation: &fullmag_ir::FemEigenK0KittelValidationIR,
    branch: &K0KittelSelectedBranch,
) -> Vec<u8> {
    let case_id = k0_kittel_validation_case_id(validation);
    let demag_kind = k0_kittel_validation_demag_kind(validation);
    let mut csv = String::from(
        "case_id,demag_kind,field_index,H0_A_per_m,mu0_H0_T,expected_frequency_hz,eigen_frequency_hz,\
relative_frequency_error,selected_mode_index,eigenvalue_real,eigenvalue_imag,\
mode_residual_relative,uniformity_score,branch_overlap_previous,\
max_m0_dot_delta_m_abs,max_periodic_seam_mismatch\n",
    );
    for point in &branch.points {
        csv.push_str(&format!(
            "{},{},{},{:.17e},{:.17e},{:.17e},{:.17e},{:.17e},{},{:.17e},{:.17e},{:.17e},{:.17e},{:.17e},{:.17e},{:.17e}\n",
            case_id,
            demag_kind,
            point.field_index,
            point.h0_a_per_m,
            crate::MU0 * point.h0_a_per_m,
            point.expected_frequency_hz,
            point.eigen_frequency_hz,
            point.relative_frequency_error,
            point.selected_mode_index,
            point.eigenvalue_real,
            point.eigenvalue_imag,
            point.mode_residual_relative,
            point.uniformity_score,
            point.branch_overlap_previous,
            point.max_m0_dot_delta_m_abs,
            point.max_periodic_seam_mismatch,
        ));
    }
    csv.into_bytes()
}

fn validate_k0_kittel_periodic_airbox_metrics(
    validation: &fullmag_ir::FemEigenK0KittelValidationIR,
    metrics: &K0KittelPeriodicAirboxDemagMetrics,
) -> std::io::Result<()> {
    if !(metrics.mesh_resolution_m.is_finite() && metrics.mesh_resolution_m > 0.0) {
        return Err(invalid_k0_kittel_artifact(
            "K0-3 periodic_airbox_k0 metrics require positive finite mesh_resolution_m",
        ));
    }
    if !(metrics.airbox_size_m.is_finite() && metrics.airbox_size_m > 0.0) {
        return Err(invalid_k0_kittel_artifact(
            "K0-3 periodic_airbox_k0 metrics require positive finite airbox_size_m",
        ));
    }
    if metrics.phi_dof_count == 0 {
        return Err(invalid_k0_kittel_artifact(
            "K0-3 periodic_airbox_k0 metrics require positive phi_dof_count",
        ));
    }
    if metrics.augmented_phi_dof_count < metrics.phi_dof_count {
        return Err(invalid_k0_kittel_artifact(
            "K0-3 periodic_airbox_k0 metrics require augmented_phi_dof_count >= phi_dof_count",
        ));
    }
    if !(metrics.poisson_constraint_relative_residual.is_finite()
        && metrics.poisson_constraint_relative_residual >= 0.0
        && metrics.poisson_constraint_relative_residual <= 1.0e-8)
    {
        return Err(invalid_k0_kittel_artifact(
            "K0-3 periodic_airbox_k0 metrics require poisson_constraint_relative_residual <= 1e-8",
        ));
    }
    if metrics.magnetic_pair_count == 0 || metrics.airbox_pair_count == 0 {
        return Err(invalid_k0_kittel_artifact(
            "K0-3 periodic_airbox_k0 metrics require positive magnetic and airbox pair counts",
        ));
    }
    if !(metrics.effective_magnetisation_a_per_m.is_finite()
        && metrics.effective_magnetisation_a_per_m > 0.0)
    {
        return Err(invalid_k0_kittel_artifact(
            "K0-3 periodic_airbox_k0 metrics require positive finite effective magnetisation",
        ));
    }
    if !(metrics.relative_kittel_frequency_error.is_finite()
        && metrics.relative_kittel_frequency_error >= 0.0)
    {
        return Err(invalid_k0_kittel_artifact(
            "K0-3 periodic_airbox_k0 metrics require non-negative finite relative Kittel error",
        ));
    }
    let declared_effective_magnetisation = validation
        .material
        .effective_magnetisation
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| {
            invalid_k0_kittel_artifact(
                "K0-3 periodic_airbox_k0 validation requires positive effective_magnetisation",
            )
        })?;
    let mismatch = (declared_effective_magnetisation - metrics.effective_magnetisation_a_per_m)
        .abs()
        / declared_effective_magnetisation.max(metrics.effective_magnetisation_a_per_m);
    if mismatch > 1.0e-12 {
        return Err(invalid_k0_kittel_artifact(
            "K0-3 periodic_airbox_k0 metrics effective magnetisation does not match validation",
        ));
    }
    Ok(())
}

fn k0_kittel_periodic_airbox_convergence_csv_bytes(
    validation: &fullmag_ir::FemEigenK0KittelValidationIR,
    metrics: &K0KittelPeriodicAirboxDemagMetrics,
) -> Vec<u8> {
    format!(
        "case_id,demag_kind,mesh_resolution_m,airbox_size_m,phi_dof_count,poisson_residual_relative,relative_kittel_frequency_error,effective_magnetisation_A_per_m\n{},{},{:.17e},{:.17e},{},{:.17e},{:.17e},{:.17e}\n",
        k0_kittel_validation_case_id(validation),
        k0_kittel_validation_demag_kind(validation),
        metrics.mesh_resolution_m,
        metrics.airbox_size_m,
        metrics.phi_dof_count,
        metrics.poisson_constraint_relative_residual,
        metrics.relative_kittel_frequency_error,
        metrics.effective_magnetisation_a_per_m,
    )
    .into_bytes()
}

pub(crate) fn k0_kittel_validation_auxiliary_artifacts(
    result: &PathSolveResult,
) -> std::io::Result<Vec<AuxiliaryArtifact>> {
    let Some(validation) = result.k0_kittel_validation.as_ref() else {
        return Ok(Vec::new());
    };
    let periodic_airbox_metrics = if validation.demag_kind.as_deref() == Some("periodic_airbox_k0")
    {
        let metrics = result.k0_kittel_periodic_airbox_demag.as_ref().ok_or_else(|| {
            invalid_k0_kittel_artifact(
                "K0-3 periodic_airbox_k0 Kittel artifacts require real PA-E4b FEM-airbox metrics; synthetic or generic modal paths must not emit production periodic-airbox claims",
            )
        })?;
        validate_k0_kittel_periodic_airbox_metrics(validation, metrics)?;
        Some(metrics)
    } else {
        None
    };
    let expected_points = k0_kittel_expected_points(validation)?;
    if expected_points.len() < 3 {
        return Err(invalid_k0_kittel_artifact(
            "K0 Kittel validation requires at least three field samples",
        ));
    }
    let selected_branch = select_k0_kittel_branch(result, &expected_points).ok_or_else(|| {
        invalid_k0_kittel_artifact(
            "no tracked eigen branch covers all declared K0 Kittel validation samples",
        )
    })?;

    let tolerance = validation.relative_tolerance;
    let status = if tolerance.is_finite()
        && tolerance >= 0.0
        && selected_branch.max_relative_frequency_error <= tolerance
    {
        "passed"
    } else {
        "failed"
    };
    let solver_classification = modal_solver_classification(result.solver_model);
    // A native selected-spectrum adapter can be orchestrated through a path
    // result whose legacy solver_model remains the reference enum.  When that
    // happens, the first native sample diagnostics are the authoritative lane
    // and adapter identity for the Kittel summary; otherwise preserve the
    // established classification for reference and CPU fixtures.
    let native_diagnostics = modal_native_solver_diagnostics(result);
    let summary_execution_lane = if solver_classification.reference_or_production == "reference" {
        diagnostic_string(native_diagnostics, "execution_lane")
            .or_else(|| {
                diagnostic_nested_string(
                    native_diagnostics,
                    "resolved_execution",
                    "reference_or_production",
                )
            })
            .unwrap_or_else(|| solver_classification.reference_or_production.to_string())
    } else {
        solver_classification.reference_or_production.to_string()
    };
    let summary_solver_algorithm = if solver_classification.reference_or_production == "reference" {
        diagnostic_nested_string(native_diagnostics, "resolved_execution", "solver_algorithm")
            .or_else(|| diagnostic_string(native_diagnostics, "solver_adapter"))
            .unwrap_or_else(|| result.solver_model.as_str().to_string())
    } else {
        result.solver_model.as_str().to_string()
    };
    let max_eigen_residual_relative = selected_branch
        .points
        .iter()
        .map(|point| point.mode_residual_relative)
        .fold(0.0, f64::max);
    let demag = if let Some(metrics) = periodic_airbox_metrics {
        serde_json::json!({
            "kind": k0_kittel_validation_demag_kind(validation),
            "effective_magnetisation_A_per_m": metrics.effective_magnetisation_a_per_m,
            "gauge_policy": if metrics.augmented_phi_dof_count > metrics.phi_dof_count {
                "mean_zero_augmented"
            } else {
                "none"
            },
            "phi_dof_count": metrics.phi_dof_count,
            "augmented_phi_dof_count": metrics.augmented_phi_dof_count,
            "poisson_constraint_relative_residual": metrics.poisson_constraint_relative_residual,
            "magnetic_pair_count": metrics.magnetic_pair_count,
            "airbox_pair_count": metrics.airbox_pair_count,
            "production_periodic_airbox_claim": true,
        })
    } else {
        serde_json::json!({
            "kind": k0_kittel_validation_demag_kind(validation),
            "effective_magnetisation_A_per_m": validation.material.effective_magnetisation,
            "gauge_policy": "not_applicable",
            "production_periodic_airbox_claim": false,
        })
    };
    let summary = serde_json::json!({
        "schema_version": "frequency_domain_kittel_k0_validation.v1",
        "status": status,
        "case_id": k0_kittel_validation_case_id(validation),
        "test_id": if validation.case_id.as_deref() == Some("K0-3") { "kittel_k0_pbc_thinfilm_demag_inplane" } else { "kittel_k0_pbc_zeeman_no_demag" },
        "model": validation.model.as_str(),
        "field_units": validation.field_units.as_str(),
        "boundary_condition": "periodic_k0",
        "k_vector_rad_per_m": [0.0, 0.0, 0.0],
        "demag_kind": k0_kittel_validation_demag_kind(validation),
        "demag": demag,
        "sweep_point_count": selected_branch.points.len(),
        "max_relative_frequency_error": selected_branch.max_relative_frequency_error,
        "median_relative_frequency_error": selected_branch.median_relative_frequency_error,
        "selected_branch": {
            "branch_id": selected_branch.branch_id,
            "label": selected_branch.label.as_deref(),
        },
        "mode_selection": {
            "strategy": "uniformity_score_then_tracked_branch_overlap_then_branch_id",
            "minimum_uniformity_score": selected_branch.minimum_uniformity_score,
            "minimum_branch_overlap": selected_branch.minimum_branch_overlap,
            "maximum_tangent_leakage": selected_branch.maximum_tangent_leakage,
        },
        "solver": {
            "backend": "modal_eigen",
            "execution_lane": summary_execution_lane,
            "solver_algorithm": summary_solver_algorithm,
            "requested_mode_count": result
                .samples
                .iter()
                .map(|sample| sample.modes.len())
                .max()
                .unwrap_or(0),
            "max_eigen_residual_relative": max_eigen_residual_relative,
        }
    });
    let mut artifacts = vec![
        AuxiliaryArtifact {
            relative_path: "validation/kittel_k0_pbc/points.v1.csv".to_string(),
            bytes: k0_kittel_points_csv_bytes(validation, &selected_branch),
        },
        AuxiliaryArtifact {
            relative_path: "validation/kittel_k0_pbc/summary.v1.json".to_string(),
            bytes: serde_json::to_vec_pretty(&summary).unwrap(),
        },
    ];
    if let Some(metrics) = periodic_airbox_metrics {
        artifacts.push(AuxiliaryArtifact {
            relative_path: "validation/kittel_k0_pbc/convergence.v1.csv".to_string(),
            bytes: k0_kittel_periodic_airbox_convergence_csv_bytes(validation, metrics),
        });
    }
    Ok(artifacts)
}

pub(super) fn write_k0_kittel_validation_artifacts(
    base_dir: &Path,
    result: &PathSolveResult,
) -> std::io::Result<()> {
    for artifact in k0_kittel_validation_auxiliary_artifacts(result)? {
        let path = base_dir.join(&artifact.relative_path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, artifact.bytes)?;
    }
    Ok(())
}
