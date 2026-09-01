use super::common::*;
use super::field_sweep::{
    build_frequency_domain_field_sweep_artifact, write_frequency_domain_field_sweep_artifact,
};
use super::kittel::{
    build_kittel_fit_artifact, write_k0_kittel_validation_artifacts, write_kittel_fit_artifact,
};
use crate::eigen::types::{
    EigenSolverModel, KSampleDescriptor, PathSolveResult, SingleKModeResult, SingleKSolveResult,
    TrackedBranch,
};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
pub(super) struct ModeSummaryArtifact {
    mode_id: String,
    raw_mode_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_id: Option<usize>,
    mode_field_id: String,
    mode_field_resource_key: String,
    frequency_hz: f64,
    frequency_real_hz: f64,
    frequency_imag_hz: f64,
    angular_frequency_rad_per_s: f64,
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    phasor_convention: &'static str,
    eigenvalue_mapping: &'static str,
    norm: f64,
    max_amplitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_norm: Option<f64>,
    residual_absolute_l2: f64,
    residual_relative_l2: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_linf: Option<f64>,
    mass_norm: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_mean_abs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_max_abs: Option<f64>,
    omega_rad_s: f64,
    #[serde(rename = "gamma_rad_s_T")]
    gamma_rad_s_t: f64,
    #[serde(rename = "gamma0_rad_s_per_A_m")]
    gamma0_rad_s_per_a_m: f64,
    #[serde(rename = "mu0_T_m_per_A")]
    mu0_t_m_per_a: f64,
    dominant_polarization: String,
    k_vector: [f64; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) relax_to_eigen_handoff_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_mesh_topology_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct SampleArtifact {
    sample_id: String,
    sample_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    k_vector: [f64; 3],
    path_s: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    segment_index: Option<usize>,
    t_in_segment: f64,
    modes: Vec<ModeSummaryArtifact>,
}

#[derive(Debug, Clone, Serialize)]
struct PathArtifact<'a> {
    schema_version: &'static str,
    solver_model: &'a str,
    sample_count: usize,
    samples: Vec<SampleArtifact>,
}

#[derive(Debug, Clone, Serialize)]
struct BranchPointArtifact {
    sample_index: usize,
    raw_mode_index: usize,
    frequency_hz: f64,
    frequency_real_hz: f64,
    frequency_imag_hz: f64,
    angular_frequency_rad_per_s: f64,
    tracking_confidence: f64,
    tracking_score_source: &'static str,
    modal_overlap_available: bool,
    mode_field_id: String,
    mode_field_resource_key: String,
    overlap_prev: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modal_overlap_unavailable_reason: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
struct BranchArtifact {
    branch_id: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    points: Vec<BranchPointArtifact>,
}

#[derive(Debug, Clone, Serialize)]
struct BranchesArtifact {
    schema_version: &'static str,
    solver_model: String,
    tracking_score_source: &'static str,
    modal_overlap_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    modal_overlap_unavailable_reason: Option<&'static str>,
    branches: Vec<BranchArtifact>,
    diagnostics: TrackingDiagnosticsArtifact,
}

#[derive(Debug, Clone, Serialize)]
struct TrackingDiagnosticsArtifact {
    tracking_score_source: &'static str,
    modal_overlap_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_overlap: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    median_overlap: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modal_overlap_unavailable_reason: Option<&'static str>,
}

pub(super) fn summarize_mode(
    sample: &SingleKSolveResult,
    mode: &SingleKModeResult,
    solver_model: EigenSolverModel,
) -> ModeSummaryArtifact {
    let mode_field_id = eigen_mode_field_id(sample.sample.sample_index, mode.raw_mode_index);
    let mode_field_resource_key = eigen_mode_field_resource_key(&mode_field_id);
    let residual_absolute_l2 = finite_or_default(mode.residual_norm, 0.0);
    let residual_relative_l2 = residual_absolute_l2;
    let residual_linf = finite_or_default(mode.residual_linf, residual_absolute_l2);
    let tangent_leakage_mean_abs = finite_or_default(mode.tangent_leakage_mean_abs, 0.0);
    let tangent_leakage_max_abs = finite_or_default(mode.tangent_leakage_max_abs, 0.0);
    let diagnostics = sample_native_solver_diagnostics(sample);
    ModeSummaryArtifact {
        mode_id: format!(
            "sample-{:04}/mode-{:04}",
            sample.sample.sample_index, mode.raw_mode_index
        ),
        raw_mode_index: mode.raw_mode_index,
        branch_id: mode.branch_id,
        mode_field_id,
        mode_field_resource_key,
        frequency_hz: mode.frequency_real_hz,
        frequency_real_hz: mode.frequency_real_hz,
        frequency_imag_hz: mode.frequency_imag_hz,
        angular_frequency_rad_per_s: mode.angular_frequency_rad_per_s,
        eigenvalue_real: mode.eigenvalue_real,
        eigenvalue_imag: mode.eigenvalue_imag,
        phasor_convention: modal_phasor_convention(solver_model),
        eigenvalue_mapping: modal_eigenvalue_mapping(solver_model),
        norm: mode.norm,
        max_amplitude: mode.max_amplitude,
        residual_norm: Some(residual_absolute_l2),
        residual_absolute_l2,
        residual_relative_l2,
        residual_linf: Some(residual_linf),
        mass_norm: resolved_mode_mass_norm(mode),
        tangent_leakage_mean_abs: Some(tangent_leakage_mean_abs),
        tangent_leakage_max_abs: Some(tangent_leakage_max_abs.max(tangent_leakage_mean_abs)),
        omega_rad_s: mode.angular_frequency_rad_per_s,
        gamma_rad_s_t: reference_modal_gamma_rad_s_t(),
        gamma0_rad_s_per_a_m: REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M,
        mu0_t_m_per_a: crate::MU0,
        dominant_polarization: mode.dominant_polarization.clone(),
        k_vector: sample.sample.k_vector,
        relax_to_eigen_handoff_sha256: diagnostic_string(
            diagnostics,
            "relax_to_eigen_handoff_sha256",
        ),
        source_mesh_topology_sha256: diagnostic_string(diagnostics, "source_mesh_topology_sha256"),
    }
}

fn branch_point_modal_overlap_available(
    result: &PathSolveResult,
    branch: &TrackedBranch,
    point_index: usize,
) -> bool {
    if point_index == 0 {
        return false;
    }
    let Some(previous_point) = branch.points.get(point_index - 1) else {
        return false;
    };
    let Some(current_point) = branch.points.get(point_index) else {
        return false;
    };
    let previous_mode = result_mode(
        result,
        previous_point.sample_index,
        previous_point.raw_mode_index,
    );
    let current_mode = result_mode(
        result,
        current_point.sample_index,
        current_point.raw_mode_index,
    );
    matches!(
        (previous_mode, current_mode),
        (Some(previous), Some(current))
            if previous.reduced_vector.is_some() && current.reduced_vector.is_some()
    )
}

fn branch_point_tracking_score_source(
    result: &PathSolveResult,
    branch: &TrackedBranch,
    point_index: usize,
) -> &'static str {
    if point_index == 0 {
        return "seed";
    }
    if branch_point_modal_overlap_available(result, branch, point_index) {
        "modal_overlap_weighted_score"
    } else {
        "frequency_score_fallback"
    }
}

fn branch_point_tracking_unavailable_reason(
    result: &PathSolveResult,
    branch: &TrackedBranch,
    point_index: usize,
) -> Option<&'static str> {
    if point_index == 0 || branch_point_modal_overlap_available(result, branch, point_index) {
        None
    } else {
        Some("mode_vectors_unavailable")
    }
}

fn find_branch_point<'a>(
    result: &'a PathSolveResult,
    sample_index: usize,
    raw_mode_index: usize,
) -> Option<(&'a TrackedBranch, usize)> {
    result.branches.iter().find_map(|branch| {
        branch
            .points
            .iter()
            .position(|point| {
                point.sample_index == sample_index && point.raw_mode_index == raw_mode_index
            })
            .map(|point_index| (branch, point_index))
    })
}

fn mode_tracking_score_source(
    result: &PathSolveResult,
    sample_index: usize,
    raw_mode_index: usize,
) -> &'static str {
    find_branch_point(result, sample_index, raw_mode_index)
        .map(|(branch, point_index)| {
            branch_point_tracking_score_source(result, branch, point_index)
        })
        .unwrap_or("seed")
}

fn tracking_summary(result: &PathSolveResult) -> TrackingDiagnosticsArtifact {
    let mut saw_modal_overlap = false;
    let mut saw_frequency_fallback = false;
    let mut saw_non_seed = false;
    let mut modal_overlaps = Vec::new();
    for branch in &result.branches {
        for point_index in 0..branch.points.len() {
            match branch_point_tracking_score_source(result, branch, point_index) {
                "modal_overlap_weighted_score" => {
                    saw_modal_overlap = true;
                    saw_non_seed = true;
                    if let Some(overlap) = branch.points[point_index].overlap_prev {
                        if overlap.is_finite() {
                            modal_overlaps.push(overlap);
                        }
                    }
                }
                "frequency_score_fallback" => {
                    saw_frequency_fallback = true;
                    saw_non_seed = true;
                }
                _ => {}
            }
        }
    }
    let tracking_score_source = match (saw_modal_overlap, saw_frequency_fallback, saw_non_seed) {
        (true, true, _) => "mixed_modal_overlap_and_frequency_fallback",
        (true, false, _) => "modal_overlap_weighted_score",
        (false, true, _) => "frequency_score_fallback",
        (false, false, false) => "seed_only",
        (false, false, true) => "frequency_score_fallback",
    };
    modal_overlaps.sort_by(f64::total_cmp);
    let min_overlap = modal_overlaps.first().copied();
    let median_overlap = if modal_overlaps.is_empty() {
        None
    } else {
        let mid = modal_overlaps.len() / 2;
        Some(if modal_overlaps.len() % 2 == 0 {
            (modal_overlaps[mid - 1] + modal_overlaps[mid]) * 0.5
        } else {
            modal_overlaps[mid]
        })
    };
    TrackingDiagnosticsArtifact {
        tracking_score_source,
        modal_overlap_available: saw_modal_overlap,
        min_overlap,
        median_overlap,
        modal_overlap_unavailable_reason: (!saw_modal_overlap && saw_frequency_fallback)
            .then_some("mode_vectors_unavailable"),
    }
}

fn tracking_summary_from_branch_artifacts(
    branches: &[BranchArtifact],
) -> TrackingDiagnosticsArtifact {
    let mut saw_modal_overlap = false;
    let mut saw_frequency_fallback = false;
    let mut saw_non_seed = false;
    let mut modal_overlaps = Vec::new();
    for branch in branches {
        for point in &branch.points {
            match point.tracking_score_source {
                "modal_overlap_weighted_score" => {
                    saw_modal_overlap = true;
                    saw_non_seed = true;
                    if let Some(overlap) = point.overlap_prev {
                        if overlap.is_finite() {
                            modal_overlaps.push(overlap);
                        }
                    }
                }
                "frequency_score_fallback" => {
                    saw_frequency_fallback = true;
                    saw_non_seed = true;
                }
                _ => {}
            }
        }
    }
    let tracking_score_source = match (saw_modal_overlap, saw_frequency_fallback, saw_non_seed) {
        (true, true, _) => "mixed_modal_overlap_and_frequency_fallback",
        (true, false, _) => "modal_overlap_weighted_score",
        (false, true, _) => "frequency_score_fallback",
        (false, false, false) => "seed_only",
        (false, false, true) => "frequency_score_fallback",
    };
    modal_overlaps.sort_by(f64::total_cmp);
    let min_overlap = modal_overlaps.first().copied();
    let median_overlap = if modal_overlaps.is_empty() {
        None
    } else {
        let mid = modal_overlaps.len() / 2;
        Some(if modal_overlaps.len() % 2 == 0 {
            (modal_overlaps[mid - 1] + modal_overlaps[mid]) * 0.5
        } else {
            modal_overlaps[mid]
        })
    };
    TrackingDiagnosticsArtifact {
        tracking_score_source,
        modal_overlap_available: saw_modal_overlap,
        min_overlap,
        median_overlap,
        modal_overlap_unavailable_reason: (!saw_modal_overlap && saw_frequency_fallback)
            .then_some("mode_vectors_unavailable"),
    }
}

fn write_eigen_solver_diagnostics_artifact(
    base_dir: &Path,
    result: &PathSolveResult,
) -> std::io::Result<()> {
    let diagnostics_path = base_dir
        .join("eigen")
        .join("diagnostics")
        .join("solver.v1.json");
    if let Some(parent) = diagnostics_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mode_count = result
        .samples
        .iter()
        .map(|sample| sample.modes.len())
        .sum::<usize>();
    fs::write(
        diagnostics_path,
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
            "study_product": "modal_eigen",
            "status": "ready",
            "complete": true,
            "algebraic_form": "reference_effective_field_generalized",
            "matrix_equation": "K u = lambda M u",
            "phasor_convention": "not_applicable_real_reference",
            "eigenvalue_mapping": "omega_rad_s = gamma0_rad_s_per_A_m * max(lambda_A_per_m, 0)",
            "frequency_mapping": "frequency_hz = omega_rad_s / (2*pi)",
            "production_gyrotropic_mapping": false,
            "solver_model": result.solver_model.as_str(),
            "sample_count": result.samples.len(),
            "mode_count": mode_count,
            "notes": result.notes,
        }))
        .unwrap(),
    )
}

fn dispersion_frequency_source(result: &PathSolveResult) -> Option<&'static str> {
    result.dispersion_validation.as_ref()?;
    if result.solver_model == EigenSolverModel::ReferenceThinFilmDeBvKalinikosN0 {
        Some("analytic_reference_model")
    } else {
        Some("numeric_modal_solver_with_analytic_comparison")
    }
}

fn dispersion_reference_model(result: &PathSolveResult) -> Option<&'static str> {
    result.dispersion_validation.as_ref()?;
    if result.solver_model == EigenSolverModel::ReferenceThinFilmDeBvKalinikosN0 {
        Some("kalinikos_slab_n0")
    } else {
        None
    }
}

fn dispersion_dynamic_demag_operator_source(result: &PathSolveResult) -> Option<&'static str> {
    result.dispersion_validation.as_ref()?;
    if result.solver_model == EigenSolverModel::ReferenceThinFilmDeBvKalinikosN0 {
        Some("analytic_thin_film_de_bv_reference_not_fem_demag_k")
    } else {
        Some("numeric_modal_solver")
    }
}

pub fn write_frequency_domain_eigen_manifest(
    base_dir: &Path,
    result: &PathSolveResult,
) -> std::io::Result<()> {
    write_eigen_solver_diagnostics_artifact(base_dir, result)?;
    let manifest_dir = base_dir.join("frequency_domain");
    fs::create_dir_all(&manifest_dir)?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| format!("unix:{}", duration.as_secs()))
        .unwrap_or_else(|_| "unix:0".to_string());
    let mode_metadata_paths = eigen_mode_metadata_paths(result);
    let mode_field_resources = eigen_mode_field_resources(result);
    let sample_count = result.samples.len();
    let field_sweep_v1_path = build_frequency_domain_field_sweep_artifact(result)?
        .is_some()
        .then_some("eigen/field_sweep.v1.json");
    let fmr_kittel_fit_v1_path = build_kittel_fit_artifact(result)?
        .is_some()
        .then_some("fmr/kittel_fit.v1.json");
    let calculation_mode = eigen_calculation_mode(result);
    let dispersion_published = calculation_mode == "dispersion_modal";
    let tracking = tracking_summary(result);
    let solver_classification = modal_solver_classification(result.solver_model);
    let (requested_execution, resolved_execution) =
        modal_manifest_execution(result, solver_classification);
    let (
        physics_contract_version,
        operator_dictionary_version,
        implementation_state,
        validation_state,
        validated_scope,
        assembly_kind,
        operator_input_signature_sha256,
        boundary_gauge,
        spectral,
        phase_constraint_sha256,
        equilibrium_artifact_sha256,
        linearization_state_sha256,
        periodic_mesh_certificate_sha256,
    ) = modal_manifest_hardened_fields(result);
    let diagnostics = modal_native_solver_diagnostics(result);
    let production_native_solver_available =
        diagnostic_bool(diagnostics, "production_solver_available")
            .unwrap_or(solver_classification.production_native_solver_available);
    let validation_artifact = diagnostic_bool(diagnostics, "validation_only")
        .unwrap_or(solver_classification.validation_artifact);
    let phase_convention = diagnostic_string(diagnostics, "phasor_convention")
        .unwrap_or_else(|| "exp_minus_i_omega_t".to_string());
    let spin_wave_bc = diagnostic_string(diagnostics, "demag_kind")
        .or_else(|| diagnostic_string(diagnostics, "spin_wave_bc"))
        .unwrap_or_else(|| {
            if calculation_mode == "dispersion_modal" {
                "periodic".to_string()
            } else {
                "planned".to_string()
            }
        });
    let periodic_or_floquet = if result
        .samples
        .iter()
        .any(|sample| sample.sample.k_vector.iter().any(|value| value.abs() > 0.0))
    {
        "bloch_or_path_sampling".to_string()
    } else if result.include_demag {
        "periodic_k0".to_string()
    } else {
        "none".to_string()
    };
    let manifest = FrequencyDomainArtifactManifest {
        schema_version: "frequency_domain_manifest.v1",
        analysis_family: "magnetic_frequency_domain",
        study_product: "modal_eigen",
        revision: format!(
            "eigen:{}:{}:{}",
            result.solver_model.as_str(),
            sample_count,
            mode_metadata_paths.len()
        ),
        session_id: "current",
        run_id: "current",
        stage_id: "eigenmodes",
        stage_kind: "eigenmodes",
        created_at,
        requested_execution,
        resolved_execution,
        fem_eigen_execution_resolution: diagnostics
            .and_then(|value| value.get("fem_eigen_execution_resolution"))
            .cloned(),
        native_execution_attestation: diagnostics
            .and_then(|value| value.get("native_execution_attestation"))
            .cloned(),
        physics: FrequencyDomainPhysics {
            analysis_family: "magnetic_frequency_domain",
            llg_gamma0_si: None,
            llg_alpha: None,
            phase_convention,
            frequency_units: "Hz",
            field_units: "dimensionless_delta_m",
            normalization: "unit_l2",
            spin_wave_bc,
            periodic_or_floquet,
            equilibrium_residual_summary: None,
            response_map_axes: Vec::new(),
        },
        artifacts: FrequencyDomainArtifactIndex {
            solver_diagnostics_path: Some("eigen/diagnostics/solver.v1.json"),
            spectrum_v2_path: Some("eigen/spectrum.v2.json"),
            branches_v2_path: dispersion_published.then_some("eigen/branches.v2.json"),
            dispersion_csv_path: dispersion_published.then_some("eigen/dispersion.csv"),
            eigen_diagnostics_v2_path: None,
            response_sweep_v1_path: None,
            response_sweep_v2_path: None,
            response_map_v1_path: None,
            response_map_v2_path: None,
            response_diagnostics_v1_path: None,
            response_progress_v1_path: None,
            response_cancel_requested_v1_path: None,
            field_sweep_v1_path,
            fmr_peaks_v1_path: None,
            fmr_resonance_fits_v1_path: None,
            fmr_kittel_fit_v1_path,
            mode_metadata_paths,
            frequency_point_paths: Vec::new(),
        },
        resources: FrequencyDomainResourceIndex {
            spectrum_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
            ),
            branches_resource_key: dispersion_published
                .then_some("/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2"),
            dispersion_resource_key: dispersion_published
                .then_some("/v2/sessions/current/analysis/frequency-domain/eigen/dispersion"),
            diagnostics_resource_key: None,
            eigen_diagnostics_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
            ),
            response_sweep_resource_key: None,
            response_map_resource_key: None,
            response_progress_resource_key: None,
            response_cancel_requested_resource_key: None,
            response_diagnostics_resource_key: None,
            mode_field_resources,
            response_field_resources: Vec::new(),
        },
        validation: FrequencyDomainValidation {
            dispersion_validation: dispersion_published
                .then(|| result.dispersion_validation.as_ref())
                .flatten(),
            k0_kittel_validation: result.k0_kittel_validation.as_ref(),
            dispersion_frequency_source: dispersion_published
                .then(|| dispersion_frequency_source(result))
                .flatten(),
            dispersion_reference_model: dispersion_published
                .then(|| dispersion_reference_model(result))
                .flatten(),
            dynamic_demag_operator_source: dispersion_published
                .then(|| dispersion_dynamic_demag_operator_source(result))
                .flatten(),
        },
        diagnostics: FrequencyDomainDiagnostics {
            status: "ready",
            complete: true,
            requested_frequency_point_count: sample_count,
            completed_frequency_point_count: sample_count,
            written_frequency_point_artifacts: 0,
            interrupted: false,
            tracking_score_source: Some(tracking.tracking_score_source),
            modal_overlap_available: Some(tracking.modal_overlap_available),
            modal_overlap_unavailable_reason: tracking.modal_overlap_unavailable_reason,
        },
        capabilities: FrequencyDomainCapabilitySnapshot {
            driven_response_artifact_available: false,
            modal_artifact_available: true,
            production_native_solver_available,
            validation_artifact,
        },
        physics_contract_version,
        operator_dictionary_version,
        implementation_state,
        validation_state,
        validated_scope,
        assembly_kind,
        operator_input_signature_sha256,
        boundary_gauge,
        spectral,
        phase_constraint_sha256,
        equilibrium_artifact_sha256,
        linearization_state_sha256,
        periodic_mesh_certificate_sha256,
    };
    fs::write(
        manifest_dir.join("manifest.v1.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )?;
    let _ = write_frequency_domain_field_sweep_artifact(base_dir, result)?;
    let _ = write_kittel_fit_artifact(base_dir, result)?;
    write_k0_kittel_validation_artifacts(base_dir, result)?;
    Ok(())
}

fn eigen_mode_metadata_paths(result: &PathSolveResult) -> Vec<String> {
    result
        .samples
        .iter()
        .flat_map(|sample| {
            sample.modes.iter().map(|mode| {
                format!(
                    "eigen/modes/sample_{:04}/mode_{:04}.json",
                    sample.sample.sample_index, mode.raw_mode_index
                )
            })
        })
        .collect()
}

fn eigen_mode_field_resources(result: &PathSolveResult) -> Vec<String> {
    result
        .samples
        .iter()
        .flat_map(|sample| {
            sample.modes.iter().map(|mode| {
                format!(
                    "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{}/{}/meta",
                    sample.sample.sample_index, mode.raw_mode_index
                )
            })
        })
        .collect()
}

pub fn write_path_bundle(base_dir: &Path, result: &PathSolveResult) -> std::io::Result<()> {
    let eigen_dir = base_dir.join("eigen");
    fs::create_dir_all(&eigen_dir)?;
    let samples: Vec<SampleArtifact> = result
        .samples
        .iter()
        .map(|sample| SampleArtifact {
            sample_id: format!("bias-field-sample-{:04}", sample.sample.sample_index),
            sample_index: sample.sample.sample_index,
            label: sample.sample.label.clone(),
            k_vector: sample.sample.k_vector,
            path_s: sample.sample.path_s,
            segment_index: sample.sample.segment_index,
            t_in_segment: sample.sample.t_in_segment,
            modes: sample
                .modes
                .iter()
                .map(|mode| summarize_mode(sample, mode, result.solver_model))
                .collect(),
        })
        .collect();
    let spectrum_artifact = PathArtifact {
        schema_version: "eigen_spectrum.v2",
        solver_model: result.solver_model.as_str(),
        sample_count: samples.len(),
        samples: samples.clone(),
    };
    fs::write(
        eigen_dir.join("spectrum.v2.json"),
        serde_json::to_vec_pretty(&spectrum_artifact).unwrap(),
    )?;
    let spectrum_v3_samples = result
        .samples
        .iter()
        .map(|sample| {
            let modes = sample
                .modes
                .iter()
                .map(|mode| {
                    let mut value =
                        serde_json::to_value(summarize_mode(sample, mode, result.solver_model))
                            .expect("mode summary must serialize");
                    value["component_participation"] =
                        serde_json::to_value(&mode.component_participation)
                            .expect("validated component participation must serialize");
                    value
                })
                .collect::<Vec<_>>();
            serde_json::json!({
                "sample_id": format!(
                    "bias-field-sample-{:04}",
                    sample.sample.sample_index
                ),
                "sample_index": sample.sample.sample_index,
                "label": sample.sample.label,
                "k_vector": sample.sample.k_vector,
                "path_s": sample.sample.path_s,
                "segment_index": sample.sample.segment_index,
                "t_in_segment": sample.sample.t_in_segment,
                "modes": modes,
            })
        })
        .collect::<Vec<_>>();
    fs::write(
        eigen_dir.join("spectrum.v3.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": "eigen_spectrum.v3",
            "solver_model": result.solver_model.as_str(),
            "sample_count": spectrum_v3_samples.len(),
            "samples": spectrum_v3_samples,
        }))
        .unwrap(),
    )?;
    let path_artifact = PathArtifact {
        schema_version: "2",
        solver_model: result.solver_model.as_str(),
        sample_count: samples.len(),
        samples: samples.clone(),
    };
    fs::write(
        eigen_dir.join("path.json"),
        serde_json::to_vec_pretty(&path_artifact).unwrap(),
    )?;
    fs::write(
        eigen_dir.join("samples.json"),
        serde_json::to_vec_pretty(&samples).unwrap(),
    )?;
    Ok(())
}

pub fn write_branch_bundle(base_dir: &Path, result: &PathSolveResult) -> std::io::Result<()> {
    let eigen_dir = base_dir.join("eigen");
    fs::create_dir_all(&eigen_dir)?;
    let branches: Vec<BranchArtifact> = result
        .branches
        .iter()
        .map(|branch| BranchArtifact {
            branch_id: branch.branch_id,
            label: branch.label.clone(),
            points: branch
                .points
                .iter()
                .enumerate()
                .map(|(point_index, point)| {
                    let mode_field_id =
                        eigen_mode_field_id(point.sample_index, point.raw_mode_index);
                    let mode_field_resource_key = eigen_mode_field_resource_key(&mode_field_id);
                    BranchPointArtifact {
                        sample_index: point.sample_index,
                        raw_mode_index: point.raw_mode_index,
                        frequency_hz: point.frequency_real_hz,
                        frequency_real_hz: point.frequency_real_hz,
                        frequency_imag_hz: point.frequency_imag_hz,
                        angular_frequency_rad_per_s: point.frequency_real_hz
                            * std::f64::consts::TAU,
                        tracking_confidence: point.tracking_confidence,
                        tracking_score_source: branch_point_tracking_score_source(
                            result,
                            branch,
                            point_index,
                        ),
                        modal_overlap_available: branch_point_modal_overlap_available(
                            result,
                            branch,
                            point_index,
                        ),
                        mode_field_id,
                        mode_field_resource_key,
                        overlap_prev: point.overlap_prev,
                        modal_overlap_unavailable_reason: branch_point_tracking_unavailable_reason(
                            result,
                            branch,
                            point_index,
                        ),
                    }
                })
                .collect(),
        })
        .collect();
    let tracking = tracking_summary_from_branch_artifacts(&branches);
    let branches_v2 = BranchesArtifact {
        schema_version: "eigen_branches.v2",
        solver_model: result.solver_model.as_str().to_string(),
        tracking_score_source: tracking.tracking_score_source,
        modal_overlap_available: tracking.modal_overlap_available,
        modal_overlap_unavailable_reason: tracking.modal_overlap_unavailable_reason,
        branches: branches.clone(),
        diagnostics: tracking.clone(),
    };
    fs::write(
        eigen_dir.join("branches.v2.json"),
        serde_json::to_vec_pretty(&branches_v2).unwrap(),
    )?;
    let payload = BranchesArtifact {
        schema_version: "2",
        solver_model: result.solver_model.as_str().to_string(),
        tracking_score_source: tracking.tracking_score_source,
        modal_overlap_available: tracking.modal_overlap_available,
        modal_overlap_unavailable_reason: tracking.modal_overlap_unavailable_reason,
        branches,
        diagnostics: tracking,
    };
    fs::write(
        eigen_dir.join("branches.json"),
        serde_json::to_vec_pretty(&payload).unwrap(),
    )?;

    let mut csv = Vec::<u8>::new();
    writeln!(
        &mut csv,
        "sample_index,branch_id,raw_mode_index,frequency_real_hz,frequency_imag_hz,tracking_confidence,overlap_prev"
    )?;
    for branch in &result.branches {
        for point in &branch.points {
            writeln!(
                &mut csv,
                "{},{},{},{:.16e},{:.16e},{:.6},{}",
                point.sample_index,
                branch.branch_id,
                point.raw_mode_index,
                point.frequency_real_hz,
                point.frequency_imag_hz,
                point.tracking_confidence,
                point
                    .overlap_prev
                    .map(|value| format!("{value:.6}"))
                    .unwrap_or_default(),
            )?;
        }
    }
    fs::write(eigen_dir.join("branch_table.csv"), csv)?;

    let mut dispersion = Vec::<u8>::new();
    writeln!(
        &mut dispersion,
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,analytic_frequency_hz,relative_error,validation_geometry,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key"
    )?;
    for sample in &result.samples {
        let k = sample.sample.k_vector;
        let label = sample.sample.label.clone().unwrap_or_default();
        for mode in &sample.modes {
            let validation_columns = de_bv_analytic_csv_columns(result, &sample.sample, mode);
            writeln!(
                &mut dispersion,
                "{},{:.16e},{:.16e},{:.16e},{:.16e},{},{},{},{:.16e},{:.16e},{},{},{},{},{},{},{},{},{}",
                sample.sample.sample_index,
                sample.sample.path_s,
                k[0],
                k[1],
                k[2],
                label,
                mode.raw_mode_index,
                mode.branch_id
                    .map(|branch_id| branch_id.to_string())
                    .unwrap_or_default(),
                mode.frequency_real_hz,
                mode.angular_frequency_rad_per_s,
                validation_columns.analytic_frequency_hz,
                validation_columns.relative_error,
                validation_columns.geometry,
                "",
                mode.residual_norm
                    .map(|value| format!("{value:.16e}"))
                    .unwrap_or_default(),
                resolve_overlap_score(result, sample.sample.sample_index, mode),
                mode_tracking_score_source(result, sample.sample.sample_index, mode.raw_mode_index),
                eigen_mode_field_id(sample.sample.sample_index, mode.raw_mode_index),
                eigen_mode_field_resource_key(&eigen_mode_field_id(
                    sample.sample.sample_index,
                    mode.raw_mode_index
                )),
            )?;
        }
    }
    fs::write(eigen_dir.join("dispersion.csv"), dispersion)?;
    Ok(())
}

fn resolve_overlap_score(
    result: &PathSolveResult,
    sample_index: usize,
    mode: &SingleKModeResult,
) -> String {
    mode.branch_id
        .and_then(|branch_id| {
            result
                .branches
                .iter()
                .find(|branch| branch.branch_id == branch_id)
                .and_then(|branch| {
                    branch.points.iter().find(|point| {
                        point.sample_index == sample_index
                            && point.raw_mode_index == mode.raw_mode_index
                    })
                })
                .and_then(|point| point.overlap_prev)
        })
        .map(|value| value.to_string())
        .unwrap_or_default()
}

struct DeBvAnalyticCsvColumns {
    analytic_frequency_hz: String,
    relative_error: String,
    geometry: String,
}

fn de_bv_analytic_csv_columns(
    result: &PathSolveResult,
    sample: &KSampleDescriptor,
    mode: &SingleKModeResult,
) -> DeBvAnalyticCsvColumns {
    let Some(validation) = result.dispersion_validation.as_ref() else {
        return DeBvAnalyticCsvColumns {
            analytic_frequency_hz: String::new(),
            relative_error: String::new(),
            geometry: String::new(),
        };
    };
    if validation.kind != "thin_film_de_bv_low_k"
        || validation.analytic_model != "kalinikos_slab_n0"
    {
        return DeBvAnalyticCsvColumns {
            analytic_frequency_hz: String::new(),
            relative_error: String::new(),
            geometry: String::new(),
        };
    }
    let Some(reference) = result.dispersion_analytic_reference.as_ref() else {
        return DeBvAnalyticCsvColumns {
            analytic_frequency_hz: String::new(),
            relative_error: String::new(),
            geometry: String::new(),
        };
    };
    let Some(geometry) = de_bv_validation_geometry_for_sample(validation, sample.sample_index)
    else {
        return DeBvAnalyticCsvColumns {
            analytic_frequency_hz: String::new(),
            relative_error: String::new(),
            geometry: String::new(),
        };
    };
    let analytic_frequency_hz = kalinikos_slab_n0_frequency_hz(
        vector_norm(sample.k_vector),
        geometry,
        vector_norm(reference.external_field),
        validation.film_thickness_m,
        reference.exchange_stiffness,
        reference.saturation_magnetisation,
        reference.gyromagnetic_ratio,
    );
    let relative_error = (mode.frequency_real_hz - analytic_frequency_hz).abs()
        / analytic_frequency_hz.abs().max(1.0);
    DeBvAnalyticCsvColumns {
        analytic_frequency_hz: format!("{analytic_frequency_hz:.16e}"),
        relative_error: format!("{relative_error:.16e}"),
        geometry: geometry.to_string(),
    }
}

fn de_bv_validation_geometry_for_sample(
    validation: &fullmag_ir::FemEigenDispersionValidationIR,
    sample_index: usize,
) -> Option<&'static str> {
    let sample_index = u32::try_from(sample_index).ok()?;
    validation.scenarios.iter().find_map(|scenario| {
        if !scenario.sample_indices.contains(&sample_index) {
            return None;
        }
        match scenario.geometry.as_str() {
            "de" | "damon_eshbach" | "damon-eshbach" => Some("damon_eshbach"),
            "bv" | "backward_volume" | "backward-volume" => Some("backward_volume"),
            _ => None,
        }
    })
}

pub(super) fn kalinikos_slab_n0_frequency_hz(
    k_norm: f64,
    geometry: &str,
    bias_field_a_per_m: f64,
    film_thickness_m: f64,
    exchange_stiffness_j_per_m: f64,
    saturation_magnetisation_a_per_m: f64,
    gamma0_rad_s_per_a_m: f64,
) -> f64 {
    let exchange_field = 2.0 * exchange_stiffness_j_per_m * k_norm * k_norm
        / (crate::MU0 * saturation_magnetisation_a_per_m);
    let p_factor = if k_norm == 0.0 {
        0.0
    } else {
        let kd = k_norm * film_thickness_m;
        1.0 - (1.0 - (-kd).exp()) / kd
    };
    let common = bias_field_a_per_m + exchange_field;
    let (factor_a, factor_b) = match geometry {
        "damon_eshbach" => (
            common + saturation_magnetisation_a_per_m * (1.0 - p_factor),
            common + saturation_magnetisation_a_per_m * p_factor,
        ),
        "backward_volume" => (
            common,
            common + saturation_magnetisation_a_per_m * (1.0 - p_factor),
        ),
        _ => unreachable!("validated DE/BV geometry is normalized before analytic evaluation"),
    };
    gamma0_rad_s_per_a_m * (factor_a * factor_b).sqrt() / std::f64::consts::TAU
}

pub(super) fn vector_norm(vector: [f64; 3]) -> f64 {
    vector.iter().map(|value| value * value).sum::<f64>().sqrt()
}
