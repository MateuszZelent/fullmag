use super::common::*;
use crate::eigen::types::{
    EigenSolverModel, K0KittelPeriodicAirboxDemagMetrics, KSampleDescriptor, PathSolveResult,
    SingleKModeResult, SingleKSolveResult, TrackedBranch, TrackedBranchPoint,
};
use crate::types::AuxiliaryArtifact;
use num_complex::Complex64;
use serde::{Deserialize, Serialize};
use serde_json::Value;
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

/// Reconstruct the small `PathSolveResult` view needed by the Kittel selector
/// from the canonical physical bias-field sweep artifacts.  The sweep owner
/// executes every sample independently; this adapter is deliberately
/// post-solve only and never feeds the analytical reference back into the
/// native operator.
pub(crate) fn k0_kittel_validation_auxiliary_artifacts_from_bias_field_sweep(
    validation: &fullmag_ir::FemEigenK0KittelValidationIR,
    spectrum: &Value,
    branches: &Value,
    diagnostics: &Value,
    artifacts: &[AuxiliaryArtifact],
    mesh_resolution_m: f64,
    airbox_size_m: f64,
) -> std::io::Result<Vec<AuxiliaryArtifact>> {
    let solver_model = solver_model_from_bias_field_sweep(spectrum, diagnostics);
    let branch_map = bias_field_branch_map(branches);
    let samples = spectrum
        .get("samples")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            invalid_k0_kittel_artifact("physical Kittel adapter requires spectrum.samples")
        })?;
    if samples.is_empty() {
        return Err(invalid_k0_kittel_artifact(
            "physical Kittel adapter requires at least one solved sample",
        ));
    }

    let mut path_samples = Vec::with_capacity(samples.len());
    for sample in samples {
        let sample_index = required_usize(sample, "sample_index", "spectrum sample")?;
        let k_vector = array3(sample.get("k_vector"), "k_vector", "spectrum sample")?;
        let sample_diagnostics = diagnostics
            .get("sample_solver_diagnostics")
            .and_then(Value::as_array)
            .and_then(|entries| {
                entries.iter().find(|entry| {
                    entry.get("sample_index").and_then(Value::as_u64) == Some(sample_index as u64)
                })
            })
            .and_then(|entry| entry.get("diagnostics"))
            .cloned()
            .or_else(|| Some(diagnostics.clone()));
        let modes_json = sample
            .get("modes")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                invalid_k0_kittel_artifact(format!(
                    "physical Kittel adapter sample {sample_index} has no modes"
                ))
            })?;
        let mut modes = Vec::with_capacity(modes_json.len());
        for mode_json in modes_json {
            let raw_mode_index = mode_json
                .get("raw_mode_index")
                .or_else(|| mode_json.get("index"))
                .and_then(Value::as_u64)
                .ok_or_else(|| {
                    invalid_k0_kittel_artifact(format!(
                        "physical Kittel adapter sample {sample_index} has a mode without raw_mode_index"
                    ))
                })? as usize;
            let metadata = find_bias_field_mode_metadata(artifacts, sample_index, raw_mode_index);
            let (reduced_vector, lifted_real, lifted_imag, node_mass_weights) = metadata
                .as_ref()
                .map(|metadata| parse_bias_field_mode_vectors(metadata, artifacts))
                .transpose()?
                .unwrap_or_default();
            let branch_id = mode_json
                .get("branch_id")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .or_else(|| branch_map.get(&(sample_index, raw_mode_index)).copied());
            modes.push(SingleKModeResult {
                raw_mode_index,
                branch_id,
                frequency_real_hz: finite_json_f64(
                    mode_json,
                    &["frequency_real_hz", "frequency_hz"],
                )
                .unwrap_or(0.0),
                frequency_imag_hz: finite_json_f64(mode_json, &["frequency_imag_hz"])
                    .unwrap_or(0.0),
                angular_frequency_rad_per_s: finite_json_f64(
                    mode_json,
                    &["angular_frequency_rad_per_s", "omega_rad_s"],
                )
                .unwrap_or(0.0),
                eigenvalue_real: finite_json_f64(mode_json, &["eigenvalue_real"]).unwrap_or(0.0),
                eigenvalue_imag: finite_json_f64(mode_json, &["eigenvalue_imag"]).unwrap_or(0.0),
                norm: finite_json_f64(mode_json, &["norm"]).unwrap_or(1.0),
                mass_norm: finite_json_f64(mode_json, &["mass_norm"]),
                max_amplitude: finite_json_f64(mode_json, &["max_amplitude"]).unwrap_or(0.0),
                residual_norm: finite_json_f64(
                    mode_json,
                    &["residual_relative_l2", "residual_norm"],
                ),
                residual_linf: finite_json_f64(mode_json, &["residual_linf"]),
                tangent_leakage_mean_abs: finite_json_f64(mode_json, &["tangent_leakage_mean_abs"]),
                tangent_leakage_max_abs: finite_json_f64(mode_json, &["tangent_leakage_max_abs"]),
                tangent_leakage_weighted_relative_l2: finite_json_f64(
                    mode_json,
                    &["tangent_leakage_weighted_relative_l2"],
                ),
                dominant_polarization: mode_json
                    .get("dominant_polarization")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                reduced_vector,
                lifted_real,
                lifted_imag,
                amplitude: None,
                phase: None,
                node_mass_weights,
                component_participation:
                    crate::eigen::ModalParticipationObservable::unavailable_without_context(
                        solver_model_device(solver_model),
                    ),
            });
        }
        path_samples.push(SingleKSolveResult {
            sample: KSampleDescriptor {
                sample_index,
                label: sample
                    .get("label")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                segment_index: sample
                    .get("segment_index")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
                path_s: sample.get("path_s").and_then(Value::as_f64).unwrap_or(0.0),
                t_in_segment: sample
                    .get("t_in_segment")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0),
                k_vector,
            },
            modes,
            relaxation_steps: 0,
            solver_model,
            solver_notes: vec!["physical bias-field sweep postsolve adapter".to_string()],
            solver_diagnostics: sample_diagnostics,
        });
    }

    let tracked_branches = branches_from_bias_field_sweep(branches);
    if tracked_branches.is_empty() {
        return Err(invalid_k0_kittel_artifact(
            "physical Kittel adapter requires tracked branches",
        ));
    }
    let metrics_diagnostics = path_samples
        .first()
        .and_then(sample_native_solver_diagnostics)
        .ok_or_else(|| {
            invalid_k0_kittel_artifact(
                "physical Kittel adapter requires per-sample native diagnostics",
            )
        })?;
    let metrics = K0KittelPeriodicAirboxDemagMetrics {
        mesh_resolution_m,
        airbox_size_m,
        phi_dof_count: required_u64_any(
            metrics_diagnostics,
            &["phi_dof_count", "augmented_phi_dof_count"],
            "phi_dof_count",
        )?,
        augmented_phi_dof_count: required_u64_any(
            metrics_diagnostics,
            &["augmented_phi_dof_count", "phi_dof_count"],
            "augmented_phi_dof_count",
        )?,
        poisson_constraint_relative_residual: required_f64_any(
            metrics_diagnostics,
            &["poisson_constraint_relative_residual"],
            "poisson_constraint_relative_residual",
        )?,
        magnetic_pair_count: required_u64_any(
            metrics_diagnostics,
            &["magnetic_pair_count"],
            "magnetic_pair_count",
        )?,
        airbox_pair_count: required_u64_any(
            metrics_diagnostics,
            &["airbox_pair_count"],
            "airbox_pair_count",
        )?,
        effective_magnetisation_a_per_m: validation
            .material
            .effective_magnetisation
            .filter(|value| value.is_finite() && *value > 0.0)
            .ok_or_else(|| {
                invalid_k0_kittel_artifact(
                    "physical Kittel adapter requires positive effective_magnetisation",
                )
            })?,
        // This field is replaced by the selected branch's independently
        // computed error in `k0_kittel_validation_auxiliary_artifacts`.
        relative_kittel_frequency_error: 0.0,
    };
    let result = PathSolveResult {
        samples: path_samples,
        branches: tracked_branches,
        solver_model,
        notes: vec!["physical bias-field sweep postsolve adapter".to_string()],
        include_demag: true,
        dispersion_validation: None,
        k0_kittel_validation: Some(validation.clone()),
        dispersion_analytic_reference: None,
        k0_kittel_periodic_airbox_demag: Some(metrics),
    };
    let mut output = k0_kittel_validation_auxiliary_artifacts(&result)?;
    if let Some(fit) = build_kittel_fit_artifact(&result)? {
        output.push(AuxiliaryArtifact {
            relative_path: "fmr/kittel_fit.v1.json".to_string(),
            bytes: serde_json::to_vec_pretty(&fit).map_err(|error| {
                invalid_k0_kittel_artifact(format!(
                    "failed to serialize physical Kittel fit artifact: {error}"
                ))
            })?,
        });
    }
    Ok(output)
}

fn required_usize(value: &Value, key: &str, context: &str) -> std::io::Result<usize> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| invalid_k0_kittel_artifact(format!("{context} is missing integer {key}")))
}

fn array3(value: Option<&Value>, key: &str, context: &str) -> std::io::Result<[f64; 3]> {
    let values = value
        .and_then(Value::as_array)
        .filter(|values| values.len() == 3)
        .ok_or_else(|| invalid_k0_kittel_artifact(format!("{context} is missing {key}[3]")))?;
    let mut result = [0.0; 3];
    for (index, value) in values.iter().enumerate() {
        result[index] = value
            .as_f64()
            .filter(|value| value.is_finite())
            .ok_or_else(|| {
                invalid_k0_kittel_artifact(format!("{context} has non-finite {key}[{index}]"))
            })?;
    }
    Ok(result)
}

fn finite_json_f64(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
    })
}

fn required_u64_any(value: &Value, keys: &[&str], label: &str) -> std::io::Result<u64> {
    keys.iter()
        .find_map(|key| {
            value.get(*key).and_then(Value::as_u64).or_else(|| {
                value
                    .get("periodic_mesh_certificate")
                    .and_then(|certificate| certificate.get(*key))
                    .and_then(Value::as_u64)
            })
        })
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            invalid_k0_kittel_artifact(format!("native diagnostics are missing positive {label}"))
        })
}

fn required_f64_any(value: &Value, keys: &[&str], label: &str) -> std::io::Result<f64> {
    keys.iter()
        .find_map(|key| {
            value
                .get(*key)
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value >= 0.0)
        })
        .ok_or_else(|| {
            invalid_k0_kittel_artifact(format!("native diagnostics are missing finite {label}"))
        })
}

fn solver_model_device(model: EigenSolverModel) -> &'static str {
    match model {
        EigenSolverModel::ProductionGpuDenseK0Macrospin
        | EigenSolverModel::ProductionGpuModalDeviceKrylov => "gpu",
        _ => "cpu",
    }
}

fn solver_model_from_bias_field_sweep(spectrum: &Value, diagnostics: &Value) -> EigenSolverModel {
    let name = spectrum
        .get("solver_model")
        .or_else(|| spectrum.get("solver_id"))
        .or_else(|| diagnostics.get("solver_model"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    match name {
        "k0_poisson_airbox_gpu_petsc_slepc"
        | "k0_poisson_airbox_gpu_modal_device_krylov"
        | "gpu_modal_device_krylov" => EigenSolverModel::ProductionGpuModalDeviceKrylov,
        "gpu_dense_k0_macrospin_modal_eigen" => EigenSolverModel::ProductionGpuDenseK0Macrospin,
        "k0_poisson_airbox_cpu_schur_slepc" | "slepc_multi_shift_invert_production_cpu_dense" => {
            EigenSolverModel::ProductionCpuShiftInvert
        }
        _ => EigenSolverModel::ReferenceFull2x2Tangent,
    }
}

fn bias_field_branch_map(branches: &Value) -> std::collections::BTreeMap<(usize, usize), usize> {
    let mut map = std::collections::BTreeMap::new();
    for branch in branches
        .get("branches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(branch_id) = branch.get("branch_id").and_then(Value::as_u64) else {
            continue;
        };
        for point in branch
            .get("points")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let (Some(sample_index), Some(raw_mode_index)) = (
                point.get("sample_index").and_then(Value::as_u64),
                point.get("raw_mode_index").and_then(Value::as_u64),
            ) else {
                continue;
            };
            map.insert(
                (sample_index as usize, raw_mode_index as usize),
                branch_id as usize,
            );
        }
    }
    map
}

fn branches_from_bias_field_sweep(branches: &Value) -> Vec<TrackedBranch> {
    branches
        .get("branches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|branch| {
            let branch_id = branch.get("branch_id").and_then(Value::as_u64)? as usize;
            let points = branch
                .get("points")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|point| {
                    Some(TrackedBranchPoint {
                        sample_index: point.get("sample_index").and_then(Value::as_u64)? as usize,
                        raw_mode_index: point.get("raw_mode_index").and_then(Value::as_u64)?
                            as usize,
                        frequency_real_hz: finite_json_f64(
                            point,
                            &["frequency_real_hz", "frequency_hz"],
                        )?,
                        frequency_imag_hz: finite_json_f64(point, &["frequency_imag_hz"])
                            .unwrap_or(0.0),
                        tracking_confidence: finite_json_f64(point, &["tracking_confidence"])
                            .unwrap_or(1.0),
                        overlap_prev: finite_json_f64(point, &["overlap_prev"]),
                    })
                })
                .collect::<Vec<_>>();
            Some(TrackedBranch {
                branch_id,
                label: branch
                    .get("label")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                points,
            })
        })
        .collect()
}

fn find_bias_field_mode_metadata(
    artifacts: &[AuxiliaryArtifact],
    sample_index: usize,
    raw_mode_index: usize,
) -> Option<Value> {
    let paths = [
        format!("eigen/modes/sample_{sample_index:04}/mode_{raw_mode_index:04}.json"),
        format!("eigen/modes/sample_{sample_index:04}_mode_{raw_mode_index:04}.json"),
    ];
    paths.iter().find_map(|path| {
        artifacts
            .iter()
            .find(|artifact| artifact.relative_path == *path)
            .and_then(|artifact| serde_json::from_slice::<Value>(&artifact.bytes).ok())
    })
}

fn parse_bias_field_mode_vectors(
    metadata: &Value,
    artifacts: &[AuxiliaryArtifact],
) -> std::io::Result<(
    Option<Vec<Complex64>>,
    Option<Vec<[f64; 3]>>,
    Option<Vec<[f64; 3]>>,
    Option<Vec<f64>>,
)> {
    let mut real = vec3_array(metadata.get("real"));
    let mut imag = vec3_array(metadata.get("imag"));
    let mut weights = metadata
        .get("node_mass_weights")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|value| {
                    value
                        .as_f64()
                        .filter(|value| value.is_finite() && *value > 0.0)
                })
                .collect::<Vec<_>>()
        })
        .filter(|values| !values.is_empty());
    if real.is_empty() && imag.is_empty() {
        let payload_path = metadata
            .get("compatibility_binary_payload_path")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                invalid_k0_kittel_artifact(
                    "physical Kittel adapter mode metadata has no Cartesian payload",
                )
            })?;
        let payload = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == payload_path)
            .ok_or_else(|| {
                invalid_k0_kittel_artifact(format!(
                    "physical Kittel adapter is missing mode payload {payload_path}"
                ))
            })?;
        let (payload_real, payload_imag) = parse_complex_xyz_binary_payload(&payload.bytes)?;
        real = payload_real;
        imag = payload_imag;
    } else if real.len() != imag.len() {
        return Err(invalid_k0_kittel_artifact(
            "physical Kittel adapter mode metadata has asymmetric real/imag payloads",
        ));
    }
    if let Some(weights_ref) = weights.as_ref() {
        let count = weights_ref.len();
        if real.len() > count {
            real.truncate(count);
        }
        if imag.len() > count {
            imag.truncate(count);
        }
    }
    let count = real.len().max(imag.len());
    if count == 0 {
        return Ok((None, None, None, weights));
    }
    let mut reduced = Vec::with_capacity(count * 3);
    for index in 0..count {
        let r = real.get(index).copied().unwrap_or([0.0; 3]);
        let i = imag.get(index).copied().unwrap_or([0.0; 3]);
        for component in 0..3 {
            reduced.push(Complex64::new(r[component], i[component]));
        }
    }
    if weights.as_ref().is_some_and(|values| values.len() != count) {
        weights = None;
    }
    Ok((Some(reduced), Some(real), Some(imag), weights))
}

fn parse_complex_xyz_binary_payload(
    bytes: &[u8],
) -> std::io::Result<(Vec<[f64; 3]>, Vec<[f64; 3]>)> {
    const BYTES_PER_NODE: usize = 3 * 2 * std::mem::size_of::<f64>();
    if bytes.is_empty() || bytes.len() % BYTES_PER_NODE != 0 {
        return Err(invalid_k0_kittel_artifact(
            "physical Kittel adapter mode payload is not f64 interleaved real/imag xyz",
        ));
    }
    let node_count = bytes.len() / BYTES_PER_NODE;
    let mut real = Vec::with_capacity(node_count);
    let mut imag = Vec::with_capacity(node_count);
    for node_bytes in bytes.chunks_exact(BYTES_PER_NODE) {
        let mut node_real = [0.0; 3];
        let mut node_imag = [0.0; 3];
        for component in 0..3 {
            let offset = component * 2 * std::mem::size_of::<f64>();
            let real_bytes: [u8; 8] = node_bytes[offset..offset + 8]
                .try_into()
                .expect("f64 payload slice has fixed width");
            let imag_bytes: [u8; 8] = node_bytes[offset + 8..offset + 16]
                .try_into()
                .expect("f64 payload slice has fixed width");
            node_real[component] = f64::from_le_bytes(real_bytes);
            node_imag[component] = f64::from_le_bytes(imag_bytes);
            if !node_real[component].is_finite() || !node_imag[component].is_finite() {
                return Err(invalid_k0_kittel_artifact(
                    "physical Kittel adapter mode payload contains a non-finite value",
                ));
            }
        }
        real.push(node_real);
        imag.push(node_imag);
    }
    Ok((real, imag))
}

fn vec3_array(value: Option<&Value>) -> Vec<[f64; 3]> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let values = entry.as_array()?;
            if values.len() != 3 {
                return None;
            }
            Some([
                values[0].as_f64().filter(|value| value.is_finite())?,
                values[1].as_f64().filter(|value| value.is_finite())?,
                values[2].as_f64().filter(|value| value.is_finite())?,
            ])
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
    let mut periodic_airbox_metrics = if validation.demag_kind.as_deref()
        == Some("periodic_airbox_k0")
    {
        let metrics = result.k0_kittel_periodic_airbox_demag.as_ref().ok_or_else(|| {
            invalid_k0_kittel_artifact(
                "K0-3 periodic_airbox_k0 Kittel artifacts require real PA-E4b FEM-airbox metrics; synthetic or generic modal paths must not emit production periodic-airbox claims",
            )
        })?;
        validate_k0_kittel_periodic_airbox_metrics(validation, metrics)?;
        Some(metrics.clone())
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

    // The native PA-E4b diagnostics carry structural Poisson metrics, while
    // the Kittel frequency comparison is intentionally performed only here,
    // after the physical sweep has produced its modes.  Keep the convergence
    // receipt honest by replacing the legacy placeholder with the selected
    // branch's independently computed maximum error.
    if let Some(metrics) = periodic_airbox_metrics.as_mut() {
        metrics.relative_kittel_frequency_error = selected_branch.max_relative_frequency_error;
    }

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
    let demag = if let Some(metrics) = periodic_airbox_metrics.as_ref() {
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
            bytes: k0_kittel_periodic_airbox_convergence_csv_bytes(validation, &metrics),
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
