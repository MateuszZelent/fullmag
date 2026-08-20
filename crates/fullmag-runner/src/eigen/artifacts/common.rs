use crate::eigen::response_block_real::FieldDrivenResponseSweepArtifact;
use crate::eigen::types::{
    EigenSolverModel, PathSolveResult, SingleKModeResult, SingleKSolveResult,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Error, ErrorKind, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub(super) const REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M: f64 = 2.211e5;

pub(super) fn reference_modal_gamma_rad_s_t() -> f64 {
    REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M / crate::MU0
}

pub(super) fn finite_or_default(value: Option<f64>, default: f64) -> f64 {
    value
        .filter(|candidate| candidate.is_finite())
        .unwrap_or(default)
}

pub(super) fn resolved_mode_mass_norm(mode: &SingleKModeResult) -> f64 {
    finite_or_default(
        mode.mass_norm,
        if mode.norm.is_finite() && mode.norm > 0.0 {
            mode.norm
        } else {
            1.0
        },
    )
}

pub(super) fn modal_phasor_convention(solver_model: EigenSolverModel) -> &'static str {
    match solver_model {
        EigenSolverModel::ProductionCpuShiftInvert
        | EigenSolverModel::ProductionGpuDenseK0Macrospin
        | EigenSolverModel::ProductionGpuModalDeviceKrylov => "exp_i_omega_t",
        _ => "not_applicable_real_reference",
    }
}

pub(super) fn modal_eigenvalue_mapping(solver_model: EigenSolverModel) -> &'static str {
    match solver_model {
        EigenSolverModel::ProductionCpuShiftInvert
        | EigenSolverModel::ProductionGpuDenseK0Macrospin
        | EigenSolverModel::ProductionGpuModalDeviceKrylov => "lambda_eq_i_omega",
        _ => "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m",
    }
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct ModeSourceMeshIdentity {
    pub(super) mesh_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mesh_generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mesh_revision: Option<u64>,
    pub(super) topology_fingerprint: String,
    pub(super) indexing: &'static str,
    pub(super) node_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct FrequencyDomainArtifactManifest<'a> {
    pub(super) schema_version: &'static str,
    pub(super) analysis_family: &'static str,
    pub(super) study_product: &'static str,
    pub(super) revision: String,
    pub(super) session_id: &'static str,
    pub(super) run_id: &'static str,
    pub(super) stage_id: &'static str,
    pub(super) stage_kind: &'static str,
    pub(super) created_at: String,
    pub(super) requested_execution: FrequencyDomainRequestedExecution<'a>,
    pub(super) resolved_execution: FrequencyDomainResolvedExecution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) fem_eigen_execution_resolution: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) native_execution_attestation: Option<serde_json::Value>,
    pub(super) physics: FrequencyDomainPhysics<'a>,
    pub(super) artifacts: FrequencyDomainArtifactIndex,
    pub(super) resources: FrequencyDomainResourceIndex,
    pub(super) validation: FrequencyDomainValidation<'a>,
    pub(super) diagnostics: FrequencyDomainDiagnostics,
    pub(super) capabilities: FrequencyDomainCapabilitySnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) physics_contract_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) operator_dictionary_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) implementation_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) validation_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) validated_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) assembly_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) operator_input_signature_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) boundary_gauge: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) spectral: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) phase_constraint_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) equilibrium_artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) linearization_state_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) periodic_mesh_certificate_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct FrequencyDomainValidation<'a> {
    pub(super) dispersion_validation: Option<&'a fullmag_ir::FemEigenDispersionValidationIR>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) k0_kittel_validation: Option<&'a fullmag_ir::FemEigenK0KittelValidationIR>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) dispersion_frequency_source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) dispersion_reference_model: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) dynamic_demag_operator_source: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct FrequencyDomainRequestedExecution<'a> {
    pub(super) calculation_mode: &'static str,
    pub(super) backend: &'static str,
    pub(super) device: String,
    pub(super) precision: String,
    pub(super) execution_mode: String,
    pub(super) ui_mode: &'static str,
    pub(super) operator: &'a str,
    pub(super) solver_family: &'static str,
    pub(super) solve_equation: &'static str,
    pub(super) include_demag: bool,
    pub(super) damping_policy: &'a str,
    pub(super) equilibrium_source: &'static str,
    pub(super) k_sampling: &'static str,
    pub(super) outputs: Vec<&'static str>,
    pub(super) solver_method: String,
    pub(super) preconditioner: String,
    pub(super) magnetostatic_bc: String,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct FrequencyDomainResolvedExecution {
    pub(super) backend: &'static str,
    pub(super) device: String,
    pub(super) precision: String,
    pub(super) engine: String,
    pub(super) native_backend: String,
    pub(super) reference_or_production: String,
    pub(super) container_image: Option<&'static str>,
    pub(super) build_features: Vec<&'static str>,
    pub(super) demag_realization: String,
    pub(super) solver_library: String,
    pub(super) solver_algorithm: String,
    pub(super) solve_kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) implementation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) operator_residency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) vector_residency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) krylov_residency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) preconditioner_residency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) fallback_used: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) fallback_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) fallback_from_engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) fallback_to_engine: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct FrequencyDomainPhysics<'a> {
    pub(super) analysis_family: &'static str,
    pub(super) llg_gamma0_si: Option<f64>,
    pub(super) llg_alpha: Option<f64>,
    pub(super) phase_convention: String,
    pub(super) frequency_units: &'static str,
    pub(super) field_units: &'static str,
    pub(super) normalization: &'static str,
    pub(super) spin_wave_bc: String,
    pub(super) periodic_or_floquet: String,
    pub(super) equilibrium_residual_summary: Option<&'static str>,
    pub(super) response_map_axes: Vec<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct FrequencyDomainArtifactIndex {
    pub(super) solver_diagnostics_path: Option<&'static str>,
    pub(super) spectrum_v2_path: Option<&'static str>,
    pub(super) branches_v2_path: Option<&'static str>,
    pub(super) dispersion_csv_path: Option<&'static str>,
    pub(super) eigen_diagnostics_v2_path: Option<&'static str>,
    pub(super) response_sweep_v1_path: Option<&'static str>,
    pub(super) response_sweep_v2_path: Option<&'static str>,
    pub(super) response_map_v1_path: Option<&'static str>,
    pub(super) response_map_v2_path: Option<&'static str>,
    pub(super) response_diagnostics_v1_path: Option<&'static str>,
    pub(super) response_progress_v1_path: Option<&'static str>,
    pub(super) response_cancel_requested_v1_path: Option<&'static str>,
    pub(super) field_sweep_v1_path: Option<&'static str>,
    pub(super) fmr_peaks_v1_path: Option<&'static str>,
    pub(super) fmr_resonance_fits_v1_path: Option<&'static str>,
    pub(super) fmr_kittel_fit_v1_path: Option<&'static str>,
    pub(super) mode_metadata_paths: Vec<String>,
    pub(super) frequency_point_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct FrequencyDomainResourceIndex {
    pub(super) spectrum_resource_key: Option<&'static str>,
    pub(super) branches_resource_key: Option<&'static str>,
    pub(super) dispersion_resource_key: Option<&'static str>,
    pub(super) diagnostics_resource_key: Option<&'static str>,
    pub(super) eigen_diagnostics_resource_key: Option<&'static str>,
    pub(super) response_sweep_resource_key: Option<&'static str>,
    pub(super) response_map_resource_key: Option<&'static str>,
    pub(super) response_progress_resource_key: Option<&'static str>,
    pub(super) response_cancel_requested_resource_key: Option<&'static str>,
    pub(super) response_diagnostics_resource_key: Option<&'static str>,
    pub(super) mode_field_resources: Vec<String>,
    pub(super) response_field_resources: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct FrequencyDomainDiagnostics {
    pub(super) status: &'static str,
    pub(super) complete: bool,
    pub(super) requested_frequency_point_count: usize,
    pub(super) completed_frequency_point_count: usize,
    pub(super) written_frequency_point_artifacts: usize,
    pub(super) interrupted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tracking_score_source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) modal_overlap_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) modal_overlap_unavailable_reason: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
pub(super) struct FrequencyDomainCapabilitySnapshot {
    pub(super) driven_response_artifact_available: bool,
    pub(super) modal_artifact_available: bool,
    pub(super) production_native_solver_available: bool,
    pub(super) validation_artifact: bool,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct FrequencyDomainModalSolverClassification {
    pub(super) engine: &'static str,
    pub(super) native_backend: &'static str,
    pub(super) reference_or_production: &'static str,
    pub(super) solver_library: &'static str,
    pub(super) production_native_solver_available: bool,
    pub(super) validation_artifact: bool,
}

/// Stable lifecycle states for server-produced frequency-domain artifacts.
///
/// `complete` is reserved for an artifact whose declared source scope and all
/// referenced payloads are present.  An interrupted or partially populated
/// scan must remain inspectable, but it must never be represented as a
/// complete result by omission of a row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerArtifactStatus {
    Complete,
    Partial,
    Interrupted,
    Corrupt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerArtifactSource {
    pub kind: String,
    pub artifact: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerArtifactReference {
    pub relation: String,
    pub artifact: String,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerArtifactExecution {
    pub backend: String,
    pub device: String,
    pub precision: String,
    pub execution_mode: String,
    pub engine: String,
    pub implementation_id: Option<String>,
    pub status: String,
    pub fallback_used: Option<bool>,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerArtifactUnits {
    pub frequency: String,
    pub angular_frequency: String,
    pub bias_field: String,
    pub bias_field_display: String,
    pub response_amplitude: Option<String>,
    pub linewidth: Option<String>,
    pub q_factor: Option<String>,
    pub covariance: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServerArtifactTopology {
    pub mesh_id: String,
    pub topology_revision: String,
    pub indexing: String,
    pub sample_axis: String,
    pub mode_axis: String,
    pub node_count: Option<usize>,
}

pub(super) fn eigen_mode_field_id(sample_index: usize, raw_mode_index: usize) -> String {
    format!("analysis:eigen:sample-{sample_index:04}:mode-{raw_mode_index:04}")
}

pub(super) fn eigen_mode_field_resource_key(mode_field_id: &str) -> String {
    format!(
        "/v2/sessions/current/data/fields/{mode_field_id}/samples/vector?view=phase_rotated_real&phase_rad=0"
    )
}

pub(super) fn result_mode(
    result: &PathSolveResult,
    sample_index: usize,
    raw_mode_index: usize,
) -> Option<&SingleKModeResult> {
    result
        .samples
        .iter()
        .find(|sample| sample.sample.sample_index == sample_index)
        .and_then(|sample| {
            sample
                .modes
                .iter()
                .find(|mode| mode.raw_mode_index == raw_mode_index)
        })
}

pub(super) fn result_sample(
    result: &PathSolveResult,
    sample_index: usize,
) -> Option<&SingleKSolveResult> {
    result
        .samples
        .iter()
        .find(|sample| sample.sample.sample_index == sample_index)
}

pub(super) fn sample_native_solver_diagnostics(
    sample: &SingleKSolveResult,
) -> Option<&serde_json::Value> {
    let root = sample.solver_diagnostics.as_ref()?;
    if let Some(entries) = root
        .get("sample_solver_diagnostics")
        .and_then(serde_json::Value::as_array)
    {
        if entries.len() == 1 {
            return Some(root);
        }
        return entries
            .iter()
            .find(|entry| {
                entry
                    .get("sample_index")
                    .and_then(serde_json::Value::as_u64)
                    == Some(sample.sample.sample_index as u64)
            })
            .and_then(|entry| entry.get("diagnostics"))
            .or_else(|| entries.first().and_then(|entry| entry.get("diagnostics")));
    }
    Some(root)
}

pub(super) fn sample_external_field(
    result: &PathSolveResult,
    sample_index: usize,
) -> Option<[f64; 3]> {
    result
        .k0_kittel_validation
        .as_ref()
        .and_then(|validation| {
            validation
                .samples
                .iter()
                .find(|sample| sample.sample_index as usize == sample_index)
                .map(|sample| sample.bias_field)
        })
        .or_else(|| {
            result
                .dispersion_analytic_reference
                .as_ref()
                .map(|reference| reference.external_field)
        })
}

pub(super) fn modal_solver_classification(
    solver_model: EigenSolverModel,
) -> FrequencyDomainModalSolverClassification {
    match solver_model {
        EigenSolverModel::ProductionCpuShiftInvert => FrequencyDomainModalSolverClassification {
            engine: "multi_k_orchestrator/slepc_multi_shift_invert_production_cpu_dense",
            native_backend: "native_cpu",
            reference_or_production: "production",
            solver_library: "slepc",
            production_native_solver_available: true,
            validation_artifact: false,
        },
        EigenSolverModel::ProductionGpuDenseK0Macrospin => {
            FrequencyDomainModalSolverClassification {
                engine: "multi_k_orchestrator/gpu_dense_k0_macrospin_modal_eigen",
                native_backend: "native_gpu",
                reference_or_production: "production_gpu",
                solver_library: "cusolverdn",
                production_native_solver_available: true,
                validation_artifact: false,
            }
        }
        EigenSolverModel::ProductionGpuModalDeviceKrylov => {
            FrequencyDomainModalSolverClassification {
                engine: "multi_k_orchestrator/gpu_modal_device_krylov",
                native_backend: "native_gpu",
                reference_or_production: "production_gpu",
                solver_library: "slepc_petsc_hypre_cuda",
                production_native_solver_available: true,
                validation_artifact: false,
            }
        }
        _ => FrequencyDomainModalSolverClassification {
            engine: "runner.reference_eigen",
            native_backend: "runner_validation",
            reference_or_production: "reference",
            solver_library: "nalgebra",
            production_native_solver_available: false,
            validation_artifact: true,
        },
    }
}

pub(super) fn modal_native_solver_diagnostics(
    result: &PathSolveResult,
) -> Option<&serde_json::Value> {
    for sample in &result.samples {
        let Some(root) = sample_native_solver_diagnostics(sample) else {
            continue;
        };
        if root.get("resolved_execution").is_some()
            || root.get("solver_adapter").is_some()
            || root.get("assembly_kind").is_some()
        {
            return Some(root);
        }
    }
    None
}

pub(super) fn diagnostic_string(
    diagnostics: Option<&serde_json::Value>,
    key: &str,
) -> Option<String> {
    diagnostics
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
}

pub(super) fn diagnostic_nested_string(
    diagnostics: Option<&serde_json::Value>,
    object_key: &str,
    key: &str,
) -> Option<String> {
    diagnostics
        .and_then(|value| value.get(object_key))
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
}

pub(super) fn diagnostic_nested_bool(
    diagnostics: Option<&serde_json::Value>,
    object_key: &str,
    key: &str,
) -> Option<bool> {
    diagnostics
        .and_then(|value| value.get(object_key))
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_bool)
}

pub(super) fn diagnostic_bool(diagnostics: Option<&serde_json::Value>, key: &str) -> Option<bool> {
    diagnostics
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_bool)
}

pub(super) fn diagnostic_known_object(
    diagnostics: Option<&serde_json::Value>,
    key: &str,
) -> Option<serde_json::Value> {
    let value = diagnostics.and_then(|diagnostics| diagnostics.get(key))?;
    let object = value.as_object()?;
    if object
        .values()
        .any(|value| value.as_str() == Some("unknown"))
    {
        return None;
    }
    Some(value.clone())
}

pub(super) fn modal_manifest_execution(
    result: &PathSolveResult,
    classification: FrequencyDomainModalSolverClassification,
) -> (
    FrequencyDomainRequestedExecution<'static>,
    FrequencyDomainResolvedExecution,
) {
    let diagnostics = modal_native_solver_diagnostics(result);
    let requested_device = diagnostic_nested_string(diagnostics, "requested_execution", "device")
        .unwrap_or_else(|| {
            if classification.native_backend == "native_gpu" {
                "gpu".to_string()
            } else {
                "cpu".to_string()
            }
        });
    let requested_precision =
        diagnostic_nested_string(diagnostics, "requested_execution", "precision")
            .unwrap_or_else(|| "double".to_string());
    let requested_execution_mode =
        diagnostic_nested_string(diagnostics, "requested_execution", "execution_mode")
            .unwrap_or_else(|| "extended".to_string());
    let requested_solver_method =
        diagnostic_nested_string(diagnostics, "requested_execution", "solver_method")
            .unwrap_or_else(|| match result.solver_model {
                EigenSolverModel::ProductionCpuShiftInvert
                | EigenSolverModel::ProductionGpuDenseK0Macrospin
                | EigenSolverModel::ProductionGpuModalDeviceKrylov => "shift_invert".to_string(),
                _ => "auto".to_string(),
            });
    let requested_preconditioner =
        diagnostic_nested_string(diagnostics, "requested_execution", "preconditioner")
            .unwrap_or_else(|| "not_applicable".to_string());
    let requested_magnetostatic_bc =
        diagnostic_nested_string(diagnostics, "requested_execution", "magnetostatic_bc")
            .or_else(|| {
                result
                    .k0_kittel_periodic_airbox_demag
                    .as_ref()
                    .map(|_| "periodic_airbox_k0".to_string())
            })
            .unwrap_or_else(|| "not_applicable".to_string());
    let calculation_mode = eigen_calculation_mode(result);

    let resolved_device = diagnostic_nested_string(diagnostics, "resolved_execution", "device")
        .unwrap_or_else(|| requested_device.clone());
    let resolved_precision =
        diagnostic_nested_string(diagnostics, "resolved_execution", "precision")
            .unwrap_or_else(|| requested_precision.clone());
    let resolved_engine = diagnostic_nested_string(diagnostics, "resolved_execution", "engine")
        .unwrap_or_else(|| classification.engine.to_string());
    let resolved_native_backend =
        diagnostic_nested_string(diagnostics, "resolved_execution", "native_backend")
            .unwrap_or_else(|| classification.native_backend.to_string());
    let resolved_reference_or_production = diagnostic_bool(diagnostics, "validation_only")
        .and_then(|value| value.then_some("validation".to_string()))
        .unwrap_or_else(|| classification.reference_or_production.to_string());
    let resolved_demag_realization =
        diagnostic_nested_string(diagnostics, "resolved_execution", "demag_realization")
            .or_else(|| {
                result
                    .k0_kittel_periodic_airbox_demag
                    .as_ref()
                    .map(|_| "periodic_airbox_k0".to_string())
            })
            .unwrap_or_else(|| "none_or_validation_contract".to_string());
    let resolved_solver_library =
        diagnostic_nested_string(diagnostics, "resolved_execution", "solver_library")
            .or_else(|| diagnostic_string(diagnostics, "solver_library"))
            .unwrap_or_else(|| classification.solver_library.to_string());
    let resolved_solver_algorithm =
        diagnostic_nested_string(diagnostics, "resolved_execution", "solver_algorithm")
            .or_else(|| diagnostic_string(diagnostics, "solver_adapter"))
            .unwrap_or_else(|| classification.engine.to_string());

    let resolved = FrequencyDomainResolvedExecution {
        backend: "fem",
        device: resolved_device,
        precision: resolved_precision,
        engine: resolved_engine,
        native_backend: resolved_native_backend,
        reference_or_production: resolved_reference_or_production,
        container_image: None,
        build_features: Vec::new(),
        demag_realization: resolved_demag_realization,
        solver_library: resolved_solver_library,
        solver_algorithm: resolved_solver_algorithm,
        solve_kind: "modal_eigen",
        status: diagnostic_nested_string(diagnostics, "resolved_execution", "status"),
        implementation_id: diagnostic_nested_string(
            diagnostics,
            "resolved_execution",
            "implementation_id",
        ),
        operator_residency: diagnostic_nested_string(
            diagnostics,
            "resolved_execution",
            "operator_residency",
        ),
        vector_residency: diagnostic_nested_string(
            diagnostics,
            "resolved_execution",
            "vector_residency",
        ),
        krylov_residency: diagnostic_nested_string(
            diagnostics,
            "resolved_execution",
            "krylov_residency",
        ),
        preconditioner_residency: diagnostic_nested_string(
            diagnostics,
            "resolved_execution",
            "preconditioner_residency",
        ),
        fallback_used: diagnostic_nested_bool(diagnostics, "resolved_execution", "fallback_used"),
        fallback_reason: diagnostic_nested_string(
            diagnostics,
            "resolved_execution",
            "fallback_reason",
        ),
        fallback_from_engine: diagnostic_nested_string(
            diagnostics,
            "resolved_execution",
            "fallback_from_engine",
        ),
        fallback_to_engine: diagnostic_nested_string(
            diagnostics,
            "resolved_execution",
            "fallback_to_engine",
        ),
    };
    let requested = FrequencyDomainRequestedExecution {
        calculation_mode,
        backend: "fem",
        device: requested_device,
        precision: requested_precision,
        execution_mode: requested_execution_mode,
        ui_mode: "auto",
        operator: "linearized_llg",
        solver_family: "modal_eigen",
        solve_equation: "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q",
        include_demag: result.include_demag,
        damping_policy: "ignore",
        equilibrium_source: "provided_or_planned",
        // Multiple samples can also be an authored bias-field sweep at Gamma.
        // Only non-zero k samples are a Bloch/Floquet dispersion path.
        k_sampling: if calculation_mode == "dispersion_modal" {
            "path"
        } else {
            "single"
        },
        outputs: if calculation_mode == "dispersion_modal" {
            vec!["spectrum", "branches", "dispersion", "mode_fields"]
        } else {
            vec!["spectrum", "mode_fields"]
        },
        solver_method: requested_solver_method,
        preconditioner: requested_preconditioner,
        magnetostatic_bc: requested_magnetostatic_bc,
    };
    (requested, resolved)
}

pub(super) fn modal_manifest_hardened_fields(
    result: &PathSolveResult,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<serde_json::Value>,
    Option<serde_json::Value>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let diagnostics = modal_native_solver_diagnostics(result);
    (
        diagnostic_string(diagnostics, "physics_contract_version"),
        diagnostic_string(diagnostics, "operator_dictionary_version"),
        diagnostic_string(diagnostics, "implementation_state"),
        diagnostic_string(diagnostics, "validation_state"),
        diagnostic_string(diagnostics, "validated_scope"),
        diagnostic_string(diagnostics, "assembly_kind"),
        diagnostic_string(diagnostics, "operator_input_signature_sha256"),
        diagnostic_known_object(diagnostics, "boundary_gauge"),
        diagnostic_known_object(diagnostics, "spectral"),
        diagnostic_string(diagnostics, "phase_constraint_sha256"),
        diagnostic_string(diagnostics, "equilibrium_artifact_sha256"),
        diagnostic_string(diagnostics, "linearization_state_sha256"),
        diagnostic_string(diagnostics, "periodic_mesh_certificate_sha256"),
    )
}

pub(super) fn sha256_prefixed(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    format!(
        "sha256:{}",
        digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

pub(super) fn digest_serialized<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("frequency-domain artifact must serialize");
    sha256_prefixed(&bytes)
}

/// Compute the content revision from the complete serialized artifact envelope.
///
/// The self-referential `revision` and `content_sha256` fields are normalized
/// before hashing.  Keeping this normalization at the JSON snapshot boundary
/// makes the digest sensitive to every declared field (including execution,
/// topology, units and cross-artifact references) without requiring each
/// artifact type to duplicate the canonicalization logic.
pub(super) fn canonical_artifact_digest<T: Serialize>(artifact: &T) -> String {
    let mut snapshot = serde_json::to_value(artifact)
        .expect("frequency-domain artifact must serialize to a JSON object");
    if let serde_json::Value::Object(fields) = &mut snapshot {
        fields.insert(
            "revision".to_string(),
            serde_json::Value::String(String::new()),
        );
        fields.insert(
            "content_sha256".to_string(),
            serde_json::Value::String(String::new()),
        );
    }
    digest_serialized(&snapshot)
}

/// Publish a typed JSON artifact by replacement, never by exposing a
/// partially-written destination file.  The response sweep itself remains
/// progressively inspectable through its checkpoint/manifest artifacts; this
/// helper only protects the immutable typed envelope files.
pub(super) fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if !parent.as_os_str().is_empty() {
        fs::create_dir_all(parent)?;
    }
    let filename = path.file_name().ok_or_else(|| {
        Error::new(
            ErrorKind::InvalidInput,
            "typed artifact path must include a file name",
        )
    })?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temporary_path = parent.join(format!(
        ".{}.tmp-{}-{}",
        filename.to_string_lossy(),
        std::process::id(),
        nonce
    ));
    let result = (|| {
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)?;
        temporary.write_all(&bytes)?;
        temporary.sync_all()?;
        drop(temporary);
        fs::rename(&temporary_path, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

pub(super) fn result_source_revision(result: &PathSolveResult) -> String {
    let value = serde_json::json!({
        "solver_model": result.solver_model.as_str(),
        "include_demag": result.include_demag,
        "samples": result.samples.iter().map(|sample| serde_json::json!({
            "sample_index": sample.sample.sample_index,
            "label": sample.sample.label,
            "k_vector": sample.sample.k_vector,
            "path_s": sample.sample.path_s,
            "modes": sample.modes.iter().map(|mode| serde_json::json!({
                "raw_mode_index": mode.raw_mode_index,
                "branch_id": mode.branch_id,
                "frequency_real_hz": mode.frequency_real_hz,
                "frequency_imag_hz": mode.frequency_imag_hz,
                "angular_frequency_rad_per_s": mode.angular_frequency_rad_per_s,
                "eigenvalue_real": mode.eigenvalue_real,
                "eigenvalue_imag": mode.eigenvalue_imag,
                "residual_norm": mode.residual_norm,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
        "branches": result.branches.iter().map(|branch| serde_json::json!({
            "branch_id": branch.branch_id,
            "points": branch.points.iter().map(|point| serde_json::json!({
                "sample_index": point.sample_index,
                "raw_mode_index": point.raw_mode_index,
                "frequency_real_hz": point.frequency_real_hz,
                "frequency_imag_hz": point.frequency_imag_hz,
                "overlap_prev": point.overlap_prev,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    });
    digest_serialized(&value)
}

pub(super) fn response_source_revision(artifact: &FieldDrivenResponseSweepArtifact) -> String {
    digest_serialized(artifact)
}

pub(super) fn server_artifact_units_response(
    source_units: &BTreeMap<&'static str, &'static str>,
) -> ServerArtifactUnits {
    ServerArtifactUnits {
        frequency: "Hz".to_string(),
        angular_frequency: "rad/s".to_string(),
        bias_field: "A/m".to_string(),
        bias_field_display: "mu0 H (T)".to_string(),
        response_amplitude: source_units
            .get("response_amplitude")
            .map(|unit| (*unit).to_string()),
        linewidth: Some("Hz".to_string()),
        q_factor: Some("1".to_string()),
        covariance: None,
    }
}

pub(super) fn server_artifact_units_modal() -> ServerArtifactUnits {
    ServerArtifactUnits {
        frequency: "Hz".to_string(),
        angular_frequency: "rad/s".to_string(),
        bias_field: "A/m".to_string(),
        bias_field_display: "mu0 H (T)".to_string(),
        response_amplitude: None,
        linewidth: None,
        q_factor: None,
        covariance: None,
    }
}

pub(super) fn empty_server_topology() -> ServerArtifactTopology {
    ServerArtifactTopology {
        mesh_id: "topology:not_provided".to_string(),
        topology_revision: "topology:not_provided".to_string(),
        indexing: "sample_index_then_raw_mode_index".to_string(),
        sample_axis: "sample_id".to_string(),
        mode_axis: "mode_id".to_string(),
        node_count: None,
    }
}

pub(super) fn diagnostic_string_any(
    diagnostics: Option<&serde_json::Value>,
    keys: &[&str],
) -> Option<String> {
    keys.iter()
        .find_map(|key| diagnostic_string(diagnostics, key))
}

pub(super) fn is_canonical_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|suffix| {
        suffix.len() == 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

pub(super) fn mode_source_mesh_identity(
    diagnostics: Option<&serde_json::Value>,
    node_count: usize,
) -> std::io::Result<ModeSourceMeshIdentity> {
    let invalid = |message: &str| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("mode field publication requires valid source mesh identity: {message}"),
        )
    };
    let mesh_id = diagnostic_string_any(diagnostics, &["mesh_id", "topology_id"])
        .filter(|value| !value.trim().is_empty() && value != "topology:not_provided")
        .ok_or_else(|| invalid("missing mesh_id"))?;
    let source_mesh_topology_sha256 = diagnostic_string(diagnostics, "source_mesh_topology_sha256");
    let declared_topology_fingerprint = diagnostic_string_any(
        diagnostics,
        &["topology_fingerprint", "source_topology_fingerprint"],
    );
    let topology_fingerprint = source_mesh_topology_sha256
        .clone()
        .or_else(|| declared_topology_fingerprint.clone())
        .ok_or_else(|| invalid("missing topology fingerprint"))?;
    if !is_canonical_sha256(&topology_fingerprint) {
        return Err(invalid(
            "topology fingerprint must be sha256:<64 lowercase hex>",
        ));
    }
    if let (Some(source_topology), Some(declared_fingerprint)) =
        (source_mesh_topology_sha256, declared_topology_fingerprint)
    {
        if source_topology != declared_fingerprint {
            return Err(invalid(
                "source_mesh_topology_sha256 must match topology_fingerprint",
            ));
        }
    }
    Ok(ModeSourceMeshIdentity {
        mesh_id,
        mesh_generation_id: diagnostic_string_any(
            diagnostics,
            &[
                "mesh_generation_id",
                "mesh_generation_identity",
                "domain_generation_id",
            ],
        ),
        mesh_revision: diagnostics
            .and_then(|value| value.get("mesh_revision"))
            .and_then(serde_json::Value::as_u64),
        topology_fingerprint,
        indexing: "full_domain_node_order",
        node_count,
    })
}

pub(super) fn diagnostic_field_a_per_m(
    diagnostics: Option<&serde_json::Value>,
) -> Option<[f64; 3]> {
    let candidates = [
        diagnostics.and_then(|value| value.get("external_field_a_per_m")),
        diagnostics.and_then(|value| value.get("bias_field_a_per_m")),
        diagnostics.and_then(|value| value.get("field_a_per_m")),
        diagnostics
            .and_then(|value| value.get("requested_execution"))
            .and_then(|value| value.get("external_field_a_per_m")),
        diagnostics
            .and_then(|value| value.get("requested_execution"))
            .and_then(|value| value.get("bias_field_a_per_m")),
        diagnostics
            .and_then(|value| value.get("resolved_execution"))
            .and_then(|value| value.get("external_field_a_per_m")),
        diagnostics
            .and_then(|value| value.get("resolved_execution"))
            .and_then(|value| value.get("bias_field_a_per_m")),
    ];
    candidates.into_iter().flatten().find_map(|value| {
        let values = value.as_array()?;
        if values.len() != 3 {
            return None;
        }
        let vector = [
            values[0].as_f64()?,
            values[1].as_f64()?,
            values[2].as_f64()?,
        ];
        vector
            .iter()
            .all(|component| component.is_finite())
            .then_some(vector)
    })
}

pub(super) fn diagnostic_status(
    diagnostics: Option<&serde_json::Value>,
    mode_count: usize,
) -> ServerArtifactStatus {
    match diagnostic_string_any(diagnostics, &["status", "state"]).as_deref() {
        Some("interrupted") | Some("cancelled") | Some("canceled") => {
            ServerArtifactStatus::Interrupted
        }
        Some("corrupt") | Some("invalid") => ServerArtifactStatus::Corrupt,
        Some("partial") | Some("incomplete") | Some("failed") => ServerArtifactStatus::Partial,
        _ if mode_count > 0 => ServerArtifactStatus::Complete,
        _ => ServerArtifactStatus::Partial,
    }
}

pub(super) fn server_execution_from_modal_result(
    result: &PathSolveResult,
) -> (ServerArtifactExecution, ServerArtifactExecution, String) {
    let classification = modal_solver_classification(result.solver_model);
    let (requested, resolved) = modal_manifest_execution(result, classification);
    let runtime_id = modal_native_solver_diagnostics(result)
        .and_then(|diagnostics| {
            diagnostic_string_any(
                Some(diagnostics),
                &["runtime_id", "runtime_bundle_id", "runtime_source_revision"],
            )
        })
        .unwrap_or_else(|| "runtime:not_provided".to_string());
    let requested_execution = ServerArtifactExecution {
        backend: requested.backend.to_string(),
        device: requested.device,
        precision: requested.precision,
        execution_mode: requested.execution_mode,
        engine: "requested_frequency_domain_modal".to_string(),
        implementation_id: None,
        status: "requested".to_string(),
        fallback_used: Some(false),
        fallback_reason: None,
    };
    let resolved_execution = ServerArtifactExecution {
        backend: resolved.backend.to_string(),
        device: resolved.device,
        precision: resolved.precision,
        execution_mode: requested_execution.execution_mode.clone(),
        engine: resolved.engine,
        implementation_id: resolved.implementation_id,
        status: resolved.status.unwrap_or_else(|| "source_only".to_string()),
        fallback_used: resolved.fallback_used,
        fallback_reason: resolved.fallback_reason,
    };
    (requested_execution, resolved_execution, runtime_id)
}

pub(super) fn topology_from_diagnostics(
    diagnostics: Option<&serde_json::Value>,
) -> ServerArtifactTopology {
    let mut topology = empty_server_topology();
    if let Some(value) = diagnostics {
        topology.mesh_id = diagnostic_string_any(Some(value), &["mesh_id", "topology_id"])
            .unwrap_or(topology.mesh_id);
        topology.topology_revision = diagnostic_string_any(
            Some(value),
            &[
                "topology_revision",
                "mesh_revision",
                "topology_content_sha256",
            ],
        )
        .unwrap_or(topology.topology_revision);
        topology.node_count = value
            .get("node_count")
            .and_then(serde_json::Value::as_u64)
            .and_then(|count| usize::try_from(count).ok());
    }
    topology
}

pub(super) fn combine_status(
    statuses: impl IntoIterator<Item = ServerArtifactStatus>,
) -> ServerArtifactStatus {
    let mut saw_partial = false;
    let mut saw_interrupted = false;
    for status in statuses {
        match status {
            ServerArtifactStatus::Corrupt => return ServerArtifactStatus::Corrupt,
            ServerArtifactStatus::Interrupted => saw_interrupted = true,
            ServerArtifactStatus::Partial => saw_partial = true,
            ServerArtifactStatus::Complete => {}
        }
    }
    if saw_interrupted {
        ServerArtifactStatus::Interrupted
    } else if saw_partial {
        ServerArtifactStatus::Partial
    } else {
        ServerArtifactStatus::Complete
    }
}

pub(super) fn finite_min(values: &[f64]) -> Option<f64> {
    values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .reduce(f64::min)
}

pub(super) fn finite_max(values: &[f64]) -> Option<f64> {
    values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .reduce(f64::max)
}

pub(super) fn finite_mean(values: &[f64]) -> Option<f64> {
    let mut count = 0usize;
    let mut sum = 0.0;
    for value in values.iter().copied().filter(|value| value.is_finite()) {
        count += 1;
        sum += value;
    }
    (count > 0).then_some(sum / count as f64)
}

pub(super) fn eigen_calculation_mode(result: &PathSolveResult) -> &'static str {
    // `path_s` is also used as the scan coordinate for a physical bias-field
    // sweep.  It must not turn a k=0 sweep into a Dispersion product.
    if result.samples.iter().any(|sample| {
        sample
            .sample
            .k_vector
            .iter()
            .any(|component| *component != 0.0)
    }) {
        "dispersion_modal"
    } else {
        "free_modes"
    }
}
