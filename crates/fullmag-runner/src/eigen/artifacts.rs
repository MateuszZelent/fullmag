use crate::eigen::response_block_real::{
    build_field_driven_response_sweep_artifact, solve_field_driven_block_real_sweep,
    solve_field_driven_block_real_sweep_with_interrupt, BlockRealHarmonicTemplate,
    FieldDrivenResponseSweepArtifact, ResponseExcitationProvenanceArtifact,
};
use crate::eigen::types::{
    EigenSolverModel, K0KittelPeriodicAirboxDemagMetrics, KSampleDescriptor, PathSolveResult,
    SingleKModeResult, SingleKSolveResult, TrackedBranch,
};
use crate::native_fem::FrequencyDomainSweepProgress;
use crate::types::AuxiliaryArtifact;
use nalgebra::DVector;
use num_complex::Complex64;
use serde::Deserialize;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Error, ErrorKind, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M: f64 = 2.211e5;

fn reference_modal_gamma_rad_s_t() -> f64 {
    REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M / crate::MU0
}

fn finite_or_default(value: Option<f64>, default: f64) -> f64 {
    value
        .filter(|candidate| candidate.is_finite())
        .unwrap_or(default)
}

fn resolved_mode_mass_norm(mode: &SingleKModeResult) -> f64 {
    finite_or_default(
        mode.mass_norm,
        if mode.norm.is_finite() && mode.norm > 0.0 {
            mode.norm
        } else {
            1.0
        },
    )
}

fn modal_phasor_convention(solver_model: EigenSolverModel) -> &'static str {
    match solver_model {
        EigenSolverModel::ProductionCpuShiftInvert
        | EigenSolverModel::ProductionGpuDenseK0Macrospin
        | EigenSolverModel::ProductionGpuModalDeviceKrylov => "exp_i_omega_t",
        _ => "not_applicable_real_reference",
    }
}

fn modal_eigenvalue_mapping(solver_model: EigenSolverModel) -> &'static str {
    match solver_model {
        EigenSolverModel::ProductionCpuShiftInvert
        | EigenSolverModel::ProductionGpuDenseK0Macrospin
        | EigenSolverModel::ProductionGpuModalDeviceKrylov => "lambda_eq_i_omega",
        _ => "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m",
    }
}

#[derive(Debug, Clone, Serialize)]
struct ModeSummaryArtifact {
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
    relax_to_eigen_handoff_sha256: Option<String>,
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

#[derive(Debug, Clone, Serialize)]
struct ModeAmplitudeSummary {
    sample_count: usize,
    max: Option<f64>,
    mean: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
struct ModeComponentSummary {
    real_sample_count: usize,
    imag_sample_count: usize,
    component_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct ModeSourceMeshIdentity {
    mesh_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mesh_generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mesh_revision: Option<u64>,
    topology_fingerprint: String,
    indexing: &'static str,
    node_count: usize,
}

#[derive(Debug, Clone, Serialize)]
struct ModeArtifact {
    schema_version: &'static str,
    solver_model: String,
    sample_index: usize,
    raw_mode_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_id: Option<usize>,
    frequency_hz: f64,
    frequency_real_hz: f64,
    frequency_imag_hz: f64,
    angular_frequency_rad_per_s: f64,
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    phasor_convention: &'static str,
    eigenvalue_mapping: &'static str,
    omega_rad_s: f64,
    #[serde(rename = "gamma_rad_s_T")]
    gamma_rad_s_t: f64,
    #[serde(rename = "gamma0_rad_s_per_A_m")]
    gamma0_rad_s_per_a_m: f64,
    #[serde(rename = "mu0_T_m_per_A")]
    mu0_t_m_per_a: f64,
    normalization: &'static str,
    damping_policy: &'static str,
    mode_field_id: String,
    mode_field_resource_key: String,
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
    dominant_polarization: String,
    k_vector: [f64; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    external_field_a_per_m: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assembly_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operator_input_signature_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase_constraint_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibrium_artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    linearization_state_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    periodic_mesh_certificate_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relax_to_eigen_handoff_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_mesh_topology_sha256: Option<String>,
    source_mesh_identity: ModeSourceMeshIdentity,
    value_kind: &'static str,
    component_basis: &'static str,
    component_count: usize,
    components: [&'static str; 3],
    storage_format: &'static str,
    compatibility_binary_payload_path: String,
    payload_encoding: &'static str,
    binary_layout: &'static str,
    complex_pair_count: usize,
    payload_value_count: usize,
    available_views: [&'static str; 7],
    default_view: &'static str,
    default_phase_rad: f64,
    mode_field_sample_count: usize,
    amplitude_summary: ModeAmplitudeSummary,
    component_summary: ModeComponentSummary,
}

#[derive(Debug, Clone, Serialize)]
struct ResponseArtifactManifest<'a> {
    schema_version: &'static str,
    sweep_artifact: &'static str,
    requested_frequency_point_count: usize,
    completed_frequency_point_count: usize,
    frequency_point_count: usize,
    frequency_point_artifacts: Vec<String>,
    status: &'static str,
    complete: bool,
    interrupted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancellation_reason: Option<&'static str>,
    producer: &'a str,
}

#[derive(Debug, Clone, Serialize)]
struct ResponseSweepV2Artifact<'a> {
    schema_version: &'static str,
    source_sweep_artifact: &'static str,
    status: &'static str,
    complete: bool,
    interrupted: bool,
    requested_frequency_point_count: usize,
    completed_frequency_point_count: usize,
    backend_engine_id: &'a str,
    solve_kind: &'static str,
    solver_model: &'a str,
    damping_policy: &'a str,
    lane_classification: &'a str,
    matrix_layout: &'a str,
    excitation_kind: &'a str,
    si_units: &'a std::collections::BTreeMap<&'static str, &'static str>,
    frequency_point_artifact_paths: Vec<String>,
    response_field_payload_paths: Vec<String>,
    points: Vec<ResponseSweepV2PointArtifact>,
}

#[derive(Debug, Clone, Serialize)]
struct ResponseSweepV2PointArtifact {
    point_id: String,
    frequency_index: usize,
    frequency_hz: f64,
    angular_frequency_rad_per_s: f64,
    storage_format: &'static str,
    zarr_store_path: &'static str,
    zarr_array_path: String,
    zarr_chunk_path: String,
    zarr_dtype: &'static str,
    zarr_shape: [usize; 3],
    zarr_chunk_shape: [usize; 3],
    zarr_compressor: Option<&'static str>,
    compatibility_binary_payload_path: String,
    response_field_payload_path: String,
    frequency_point_artifact_path: String,
    response_field_binary_layout: &'static str,
    max_response_amplitude: Option<f64>,
    phase_rad: Option<f64>,
    absorbed_power_density: f64,
    residual_l2_norm: f64,
    relative_residual_l2_norm: f64,
    excitation_provenance: ResponseExcitationProvenanceArtifact,
}

#[derive(Debug, Clone, Serialize)]
struct ResponseDiagnosticsArtifact<'a> {
    schema_version: &'static str,
    status: &'static str,
    complete: bool,
    interrupted: bool,
    requested_frequency_point_count: usize,
    completed_frequency_point_count: usize,
    frequency_min_hz: Option<f64>,
    frequency_max_hz: Option<f64>,
    residual_l2_norm_max: Option<f64>,
    residual_l2_norm_mean: Option<f64>,
    relative_residual_l2_norm_max: Option<f64>,
    tangent_leakage_l2_norm_max: Option<f64>,
    solver_model: &'a str,
    backend_engine_id: &'a str,
    lane_classification: &'a str,
    solve_kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct ResponseProgressArtifact<'a> {
    schema_version: &'static str,
    status: &'static str,
    state: &'static str,
    complete: bool,
    total_frequency_points: u64,
    completed_frequency_points: u64,
    written_frequency_point_artifacts: u64,
    current_frequency_hz: Option<f64>,
    partial_artifacts_available: bool,
    latest_artifact_manifest_path: Option<&'a str>,
    missing_reason: Option<&'static str>,
    progress_json: &'a str,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainArtifactManifest<'a> {
    schema_version: &'static str,
    analysis_family: &'static str,
    study_product: &'static str,
    revision: String,
    session_id: &'static str,
    run_id: &'static str,
    stage_id: &'static str,
    stage_kind: &'static str,
    created_at: String,
    requested_execution: FrequencyDomainRequestedExecution<'a>,
    resolved_execution: FrequencyDomainResolvedExecution,
    physics: FrequencyDomainPhysics<'a>,
    artifacts: FrequencyDomainArtifactIndex,
    resources: FrequencyDomainResourceIndex,
    validation: FrequencyDomainValidation<'a>,
    diagnostics: FrequencyDomainDiagnostics,
    capabilities: FrequencyDomainCapabilitySnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    physics_contract_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operator_dictionary_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    implementation_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    validation_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    validated_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assembly_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operator_input_signature_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    boundary_gauge: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    spectral: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase_constraint_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    equilibrium_artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    linearization_state_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    periodic_mesh_certificate_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainValidation<'a> {
    dispersion_validation: Option<&'a fullmag_ir::FemEigenDispersionValidationIR>,
    #[serde(skip_serializing_if = "Option::is_none")]
    k0_kittel_validation: Option<&'a fullmag_ir::FemEigenK0KittelValidationIR>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dispersion_frequency_source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dispersion_reference_model: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dynamic_demag_operator_source: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainRequestedExecution<'a> {
    calculation_mode: &'static str,
    backend: &'static str,
    device: String,
    precision: String,
    execution_mode: String,
    ui_mode: &'static str,
    operator: &'a str,
    solver_family: &'static str,
    solve_equation: &'static str,
    include_demag: bool,
    damping_policy: &'a str,
    equilibrium_source: &'static str,
    k_sampling: &'static str,
    outputs: Vec<&'static str>,
    solver_method: String,
    preconditioner: String,
    magnetostatic_bc: String,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainResolvedExecution {
    backend: &'static str,
    device: String,
    precision: String,
    engine: String,
    native_backend: String,
    reference_or_production: String,
    container_image: Option<&'static str>,
    build_features: Vec<&'static str>,
    demag_realization: String,
    solver_library: String,
    solver_algorithm: String,
    solve_kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    implementation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    operator_residency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    vector_residency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    krylov_residency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preconditioner_residency: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_used: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_from_engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fallback_to_engine: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainPhysics<'a> {
    analysis_family: &'static str,
    llg_gamma0_si: Option<f64>,
    llg_alpha: Option<f64>,
    phase_convention: String,
    frequency_units: &'static str,
    field_units: &'static str,
    normalization: &'static str,
    spin_wave_bc: String,
    periodic_or_floquet: String,
    equilibrium_residual_summary: Option<&'static str>,
    response_map_axes: Vec<&'a str>,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainArtifactIndex {
    solver_diagnostics_path: Option<&'static str>,
    spectrum_v2_path: Option<&'static str>,
    branches_v2_path: Option<&'static str>,
    dispersion_csv_path: Option<&'static str>,
    eigen_diagnostics_v2_path: Option<&'static str>,
    response_sweep_v1_path: Option<&'static str>,
    response_sweep_v2_path: Option<&'static str>,
    response_map_v1_path: Option<&'static str>,
    response_map_v2_path: Option<&'static str>,
    response_diagnostics_v1_path: Option<&'static str>,
    response_progress_v1_path: Option<&'static str>,
    response_cancel_requested_v1_path: Option<&'static str>,
    field_sweep_v1_path: Option<&'static str>,
    fmr_peaks_v1_path: Option<&'static str>,
    fmr_resonance_fits_v1_path: Option<&'static str>,
    fmr_kittel_fit_v1_path: Option<&'static str>,
    mode_metadata_paths: Vec<String>,
    frequency_point_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainResourceIndex {
    spectrum_resource_key: Option<&'static str>,
    branches_resource_key: Option<&'static str>,
    dispersion_resource_key: Option<&'static str>,
    diagnostics_resource_key: Option<&'static str>,
    eigen_diagnostics_resource_key: Option<&'static str>,
    response_sweep_resource_key: Option<&'static str>,
    response_map_resource_key: Option<&'static str>,
    response_progress_resource_key: Option<&'static str>,
    response_cancel_requested_resource_key: Option<&'static str>,
    response_diagnostics_resource_key: Option<&'static str>,
    mode_field_resources: Vec<String>,
    response_field_resources: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainDiagnostics {
    status: &'static str,
    complete: bool,
    requested_frequency_point_count: usize,
    completed_frequency_point_count: usize,
    written_frequency_point_artifacts: usize,
    interrupted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tracking_score_source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modal_overlap_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modal_overlap_unavailable_reason: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainCapabilitySnapshot {
    driven_response_artifact_available: bool,
    modal_artifact_available: bool,
    production_native_solver_available: bool,
    validation_artifact: bool,
}

#[derive(Debug, Clone, Copy)]
struct FrequencyDomainModalSolverClassification {
    engine: &'static str,
    native_backend: &'static str,
    reference_or_production: &'static str,
    solver_library: &'static str,
    production_native_solver_available: bool,
    validation_artifact: bool,
}

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

#[derive(Debug, Clone, Serialize)]
struct ResponseFrequencyPointArtifact<'a> {
    schema_version: &'static str,
    point_id: String,
    frequency_index: usize,
    frequency_hz: f64,
    angular_frequency_rad_per_s: f64,
    source_sweep_artifact: &'static str,
    field_payload_path: String,
    response_field_payload_path: String,
    storage_format: &'static str,
    zarr_store_path: &'static str,
    zarr_array_path: String,
    zarr_chunk_path: String,
    zarr_dtype: &'static str,
    zarr_shape: [usize; 3],
    zarr_chunk_shape: [usize; 3],
    zarr_compressor: Option<&'static str>,
    compatibility_binary_payload_path: String,
    value_kind: &'static str,
    component_basis: &'static str,
    component_count: usize,
    components: [&'static str; 3],
    payload_encoding: &'static str,
    binary_layout: &'static str,
    complex_pair_count: usize,
    payload_value_count: usize,
    available_views: [&'static str; 7],
    default_view: &'static str,
    default_phase_rad: f64,
    response_field_binary_layout: &'static str,
    point: &'a crate::eigen::response_block_real::FieldDrivenResponseSweepPointArtifact,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSweepAxisArtifact {
    pub kind: String,
    pub coordinate: String,
    pub unit: String,
    pub display_conversions: Vec<FieldSweepDisplayConversion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSweepDisplayConversion {
    pub name: String,
    pub unit: String,
    pub scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyDomainFieldSweepModeArtifact {
    pub sample_id: String,
    pub mode_id: String,
    pub raw_mode_index: usize,
    pub branch_id: Option<usize>,
    pub frequency_hz: f64,
    pub angular_frequency_rad_per_s: f64,
    pub mode_artifact_path: String,
    pub mode_field_id: String,
    pub mode_field_resource_key: String,
    pub residual_relative_l2: Option<f64>,
    pub source_revision: String,
    pub status: ServerArtifactStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyDomainFieldSweepSampleArtifact {
    pub sample_id: String,
    pub sample_index: Option<usize>,
    pub scan_axis: FieldSweepAxisArtifact,
    pub bias_field_a_per_m: [f64; 3],
    pub bias_field_mu0_t: [f64; 3],
    pub equilibrium_artifact_sha256: Option<String>,
    pub linearization_state_sha256: Option<String>,
    pub operator_input_signature_sha256: Option<String>,
    pub topology: ServerArtifactTopology,
    pub branch_ids: Vec<usize>,
    pub modes: Vec<FrequencyDomainFieldSweepModeArtifact>,
    pub status: ServerArtifactStatus,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrequencyDomainFieldSweepArtifact {
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
    pub requested_sample_count: usize,
    pub completed_sample_count: usize,
    pub scan_axis: FieldSweepAxisArtifact,
    pub units: ServerArtifactUnits,
    pub topology: ServerArtifactTopology,
    pub requested_execution: ServerArtifactExecution,
    pub resolved_execution: ServerArtifactExecution,
    pub samples: Vec<FrequencyDomainFieldSweepSampleArtifact>,
    pub cross_artifact_refs: Vec<ServerArtifactReference>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FmrPeakSourceKind {
    ModalCoupling,
    DrivenResponse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FmrPeakSource {
    pub kind: FmrPeakSourceKind,
    pub artifact: String,
    pub revision: String,
    pub coupling_observable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FmrPeakUncertainty {
    pub kind: String,
    pub frequency_hz: Option<f64>,
    pub amplitude: Option<f64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FmrPeakArtifact {
    pub peak_id: String,
    pub source_artifact: String,
    pub source_revision: String,
    pub source_frequency_index: usize,
    pub sample_id: Option<String>,
    pub mode_id: Option<String>,
    pub frequency_hz: f64,
    pub response_amplitude: f64,
    pub bracketed: bool,
    pub uncertainty: FmrPeakUncertainty,
    pub status: ServerArtifactStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FmrPeaksArtifact {
    pub schema_version: &'static str,
    pub artifact_id: String,
    pub source: FmrPeakSource,
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
    pub algorithm: String,
    pub algorithm_parameters: BTreeMap<String, String>,
    pub units: ServerArtifactUnits,
    pub topology: ServerArtifactTopology,
    pub requested_execution: ServerArtifactExecution,
    pub resolved_execution: ServerArtifactExecution,
    pub requested_point_count: usize,
    pub completed_point_count: usize,
    pub peaks: Vec<FmrPeakArtifact>,
    pub cross_artifact_refs: Vec<ServerArtifactReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResonanceFitArtifact {
    pub fit_id: String,
    pub peak_id: Option<String>,
    pub source_peak_revision: String,
    pub model: String,
    pub fit_range_hz: [f64; 2],
    pub baseline: f64,
    pub weights: Option<Vec<f64>>,
    pub peak_frequency_hz: Option<f64>,
    pub linewidth_hz: Option<f64>,
    pub q_factor: Option<f64>,
    pub coefficients: Option<[f64; 3]>,
    pub covariance: Option<[[f64; 3]; 3]>,
    pub conditioning: Option<f64>,
    pub residual_l2: Option<f64>,
    pub uncertainty: FmrPeakUncertainty,
    pub status: ServerArtifactStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResonanceFitsArtifact {
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
    pub algorithm: String,
    pub units: ServerArtifactUnits,
    pub topology: ServerArtifactTopology,
    pub requested_execution: ServerArtifactExecution,
    pub resolved_execution: ServerArtifactExecution,
    pub fits: Vec<ResonanceFitArtifact>,
    pub cross_artifact_refs: Vec<ServerArtifactReference>,
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

fn summarize_mode(
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

fn eigen_mode_field_id(sample_index: usize, raw_mode_index: usize) -> String {
    format!("analysis:eigen:sample-{sample_index:04}:mode-{raw_mode_index:04}")
}

fn eigen_mode_field_resource_key(mode_field_id: &str) -> String {
    format!(
        "/v2/sessions/current/data/fields/{mode_field_id}/samples/vector?view=phase_rotated_real&phase_rad=0"
    )
}

fn result_mode(
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

fn result_sample(result: &PathSolveResult, sample_index: usize) -> Option<&SingleKSolveResult> {
    result
        .samples
        .iter()
        .find(|sample| sample.sample.sample_index == sample_index)
}

fn sample_native_solver_diagnostics(sample: &SingleKSolveResult) -> Option<&serde_json::Value> {
    let root = sample.solver_diagnostics.as_ref()?;
    if let Some(entries) = root
        .get("sample_solver_diagnostics")
        .and_then(serde_json::Value::as_array)
    {
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

fn sample_external_field(result: &PathSolveResult, sample_index: usize) -> Option<[f64; 3]> {
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

fn modal_solver_classification(
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

fn modal_native_solver_diagnostics(result: &PathSolveResult) -> Option<&serde_json::Value> {
    for sample in &result.samples {
        let Some(root) = sample.solver_diagnostics.as_ref() else {
            continue;
        };
        if let Some(diagnostics) = root
            .get("sample_solver_diagnostics")
            .and_then(serde_json::Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(|entry| entry.get("diagnostics"))
        {
            return Some(diagnostics);
        }
        if root.get("resolved_execution").is_some()
            || root.get("solver_adapter").is_some()
            || root.get("assembly_kind").is_some()
        {
            return Some(root);
        }
    }
    None
}

fn diagnostic_string(diagnostics: Option<&serde_json::Value>, key: &str) -> Option<String> {
    diagnostics
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_str)
        .map(ToOwned::to_owned)
}

fn diagnostic_nested_string(
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

fn diagnostic_nested_bool(
    diagnostics: Option<&serde_json::Value>,
    object_key: &str,
    key: &str,
) -> Option<bool> {
    diagnostics
        .and_then(|value| value.get(object_key))
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_bool)
}

fn diagnostic_bool(diagnostics: Option<&serde_json::Value>, key: &str) -> Option<bool> {
    diagnostics
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_bool)
}

fn diagnostic_known_object(
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

fn modal_manifest_execution(
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
        calculation_mode: eigen_calculation_mode(result),
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
        k_sampling: if result.samples.len() > 1 {
            "path"
        } else {
            "single"
        },
        outputs: vec!["spectrum", "branches", "dispersion", "mode_fields"],
        solver_method: requested_solver_method,
        preconditioner: requested_preconditioner,
        magnetostatic_bc: requested_magnetostatic_bc,
    };
    (requested, resolved)
}

fn modal_manifest_hardened_fields(
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

fn mode_amplitude_summary(amplitude: &[f64]) -> ModeAmplitudeSummary {
    let finite = amplitude
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    let max = finite
        .iter()
        .copied()
        .max_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let mean = if finite.is_empty() {
        None
    } else {
        Some(finite.iter().sum::<f64>() / finite.len() as f64)
    };
    ModeAmplitudeSummary {
        sample_count: amplitude.len(),
        max,
        mean,
    }
}

fn mode_component_summary(real: &[[f64; 3]], imag: &[[f64; 3]]) -> ModeComponentSummary {
    ModeComponentSummary {
        real_sample_count: real.len(),
        imag_sample_count: imag.len(),
        component_count: 3,
    }
}

fn sha256_prefixed(bytes: &[u8]) -> String {
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

fn digest_serialized<T: Serialize>(value: &T) -> String {
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
fn canonical_artifact_digest<T: Serialize>(artifact: &T) -> String {
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
fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
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

fn result_source_revision(result: &PathSolveResult) -> String {
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

fn response_source_revision(artifact: &FieldDrivenResponseSweepArtifact) -> String {
    digest_serialized(artifact)
}

fn server_artifact_units_response(
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

fn server_artifact_units_modal() -> ServerArtifactUnits {
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

fn empty_server_topology() -> ServerArtifactTopology {
    ServerArtifactTopology {
        mesh_id: "topology:not_provided".to_string(),
        topology_revision: "topology:not_provided".to_string(),
        indexing: "sample_index_then_raw_mode_index".to_string(),
        sample_axis: "sample_id".to_string(),
        mode_axis: "mode_id".to_string(),
        node_count: None,
    }
}

fn diagnostic_string_any(diagnostics: Option<&serde_json::Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| diagnostic_string(diagnostics, key))
}

fn is_canonical_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|suffix| {
        suffix.len() == 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    })
}

fn mode_source_mesh_identity(
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

fn diagnostic_field_a_per_m(diagnostics: Option<&serde_json::Value>) -> Option<[f64; 3]> {
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

fn diagnostic_status(
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

fn server_execution_from_modal_result(
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

fn field_sweep_axis() -> FieldSweepAxisArtifact {
    FieldSweepAxisArtifact {
        kind: "bias_field".to_string(),
        coordinate: "bias_field_a_per_m".to_string(),
        unit: "A/m".to_string(),
        display_conversions: vec![FieldSweepDisplayConversion {
            name: "mu0_H".to_string(),
            unit: "T".to_string(),
            scale: crate::MU0,
        }],
    }
}

fn topology_from_diagnostics(diagnostics: Option<&serde_json::Value>) -> ServerArtifactTopology {
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

fn combine_status(
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

/// Build the physical bias-field scan artifact from per-sample solver
/// provenance.  Kittel validation metadata is deliberately not consulted as
/// an input source; when native diagnostics do not declare a field, no scan is
/// emitted instead of inventing one from an oracle configuration.
pub fn build_frequency_domain_field_sweep_artifact(
    result: &PathSolveResult,
) -> std::io::Result<Option<FrequencyDomainFieldSweepArtifact>> {
    if result.samples.is_empty() {
        return Ok(None);
    }
    let mut samples = Vec::with_capacity(result.samples.len());
    for sample in &result.samples {
        let diagnostics = sample_native_solver_diagnostics(sample);
        let Some(bias_field_a_per_m) = diagnostic_field_a_per_m(diagnostics) else {
            return Ok(None);
        };
        let topology = topology_from_diagnostics(diagnostics);
        let mut status = diagnostic_status(diagnostics, sample.modes.len());
        let mode_values_valid = sample.modes.iter().all(|mode| {
            mode.frequency_real_hz.is_finite()
                && mode.frequency_real_hz >= 0.0
                && mode.frequency_imag_hz.is_finite()
                && mode.angular_frequency_rad_per_s.is_finite()
                && mode
                    .residual_norm
                    .map(|value| value.is_finite() && value >= 0.0)
                    .unwrap_or(true)
        });
        if !mode_values_valid {
            status = ServerArtifactStatus::Corrupt;
        }
        let branch_ids = sample
            .modes
            .iter()
            .filter_map(|mode| mode.branch_id)
            .collect::<Vec<_>>();
        let sample_id = format!("bias-field-sample-{:04}", sample.sample.sample_index);
        let modes = sample
            .modes
            .iter()
            .map(|mode| FrequencyDomainFieldSweepModeArtifact {
                sample_id: sample_id.clone(),
                mode_id: format!(
                    "sample-{:04}/mode-{:04}",
                    sample.sample.sample_index, mode.raw_mode_index
                ),
                raw_mode_index: mode.raw_mode_index,
                branch_id: mode.branch_id,
                frequency_hz: mode.frequency_real_hz,
                angular_frequency_rad_per_s: mode.angular_frequency_rad_per_s,
                mode_artifact_path: format!(
                    "eigen/modes/sample_{:04}/mode_{:04}.json",
                    sample.sample.sample_index, mode.raw_mode_index
                ),
                mode_field_id: eigen_mode_field_id(sample.sample.sample_index, mode.raw_mode_index),
                mode_field_resource_key: eigen_mode_field_resource_key(&eigen_mode_field_id(
                    sample.sample.sample_index,
                    mode.raw_mode_index,
                )),
                residual_relative_l2: mode.residual_norm,
                source_revision: result_source_revision(result),
                status,
            })
            .collect::<Vec<_>>();
        let stop_reason = diagnostic_string_any(diagnostics, &["stop_reason", "failure_reason"]);
        samples.push(FrequencyDomainFieldSweepSampleArtifact {
            sample_id,
            sample_index: Some(sample.sample.sample_index),
            scan_axis: field_sweep_axis(),
            bias_field_a_per_m,
            bias_field_mu0_t: bias_field_a_per_m.map(|value| value * crate::MU0),
            equilibrium_artifact_sha256: diagnostic_string_any(
                diagnostics,
                &["equilibrium_artifact_sha256", "equilibrium_content_sha256"],
            ),
            linearization_state_sha256: diagnostic_string_any(
                diagnostics,
                &["linearization_state_sha256", "linearization_content_sha256"],
            ),
            operator_input_signature_sha256: diagnostic_string_any(
                diagnostics,
                &["operator_input_signature_sha256"],
            ),
            topology,
            branch_ids,
            modes,
            status,
            stop_reason,
        });
    }
    let mut status = combine_status(samples.iter().map(|sample| sample.status));
    let topology_consistent = samples.windows(2).all(|window| {
        window[0].topology.mesh_id == window[1].topology.mesh_id
            && window[0].topology.topology_revision == window[1].topology.topology_revision
    });
    if !topology_consistent && status == ServerArtifactStatus::Complete {
        status = ServerArtifactStatus::Partial;
    }
    let requested_sample_count = result
        .samples
        .iter()
        .filter_map(|sample| {
            let diagnostics = sample_native_solver_diagnostics(sample)?;
            diagnostics
                .get("field_sweep")
                .and_then(|value| value.get("requested_sample_count"))
                .or_else(|| diagnostics.get("requested_sample_count"))
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| usize::try_from(value).ok())
        })
        .max()
        .unwrap_or(samples.len())
        .max(samples.len());
    let completed_sample_count = samples
        .iter()
        .filter(|sample| sample.status == ServerArtifactStatus::Complete)
        .count();
    let complete = status == ServerArtifactStatus::Complete
        && completed_sample_count == requested_sample_count
        && samples.iter().all(|sample| {
            sample.equilibrium_artifact_sha256.is_some()
                && sample.linearization_state_sha256.is_some()
                && sample.operator_input_signature_sha256.is_some()
                && sample.status == ServerArtifactStatus::Complete
        });
    let status = if status == ServerArtifactStatus::Complete && !complete {
        ServerArtifactStatus::Partial
    } else {
        status
    };
    let (requested_execution, resolved_execution, runtime_id) =
        server_execution_from_modal_result(result);
    let source_revision = result_source_revision(result);
    let mut artifact = FrequencyDomainFieldSweepArtifact {
        schema_version: "eigen/field_sweep.v1",
        artifact_id: "analysis:eigen:field-sweep".to_string(),
        source: ServerArtifactSource {
            kind: "modal_eigensolve".to_string(),
            artifact: "eigen/spectrum.v2.json".to_string(),
            revision: source_revision.clone(),
        },
        source_revision: source_revision.clone(),
        run_id: "run:current".to_string(),
        stage_id: "stage:eigenmodes".to_string(),
        scope_id: "scope:bias-field".to_string(),
        runtime_id,
        revision: String::new(),
        content_sha256: String::new(),
        status,
        complete,
        interrupted: status == ServerArtifactStatus::Interrupted,
        stop_reason: samples.iter().find_map(|sample| sample.stop_reason.clone()),
        requested_sample_count,
        completed_sample_count,
        scan_axis: field_sweep_axis(),
        units: server_artifact_units_modal(),
        topology: if topology_consistent {
            samples
                .first()
                .map(|sample| sample.topology.clone())
                .unwrap_or_else(empty_server_topology)
        } else {
            ServerArtifactTopology {
                mesh_id: "topology:inconsistent".to_string(),
                topology_revision: "topology:inconsistent".to_string(),
                ..empty_server_topology()
            }
        },
        requested_execution,
        resolved_execution,
        samples,
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

pub fn write_frequency_domain_field_sweep_artifact(
    base_dir: &Path,
    result: &PathSolveResult,
) -> std::io::Result<bool> {
    let Some(mut artifact) = build_frequency_domain_field_sweep_artifact(result)? else {
        return Ok(false);
    };
    let spectrum_path = base_dir.join("eigen").join("spectrum.v2.json");
    let branches_path = base_dir.join("eigen").join("branches.v2.json");
    let spectrum_revision = sha256_prefixed(&fs::read(&spectrum_path)?);
    let branches_revision = sha256_prefixed(&fs::read(&branches_path)?);
    artifact.source.revision = spectrum_revision.clone();
    artifact.source_revision = spectrum_revision.clone();
    for sample in &mut artifact.samples {
        for mode in &mut sample.modes {
            mode.source_revision = spectrum_revision.clone();
        }
    }
    artifact.cross_artifact_refs = vec![
        ServerArtifactReference {
            relation: "source_spectrum".to_string(),
            artifact: "eigen/spectrum.v2.json".to_string(),
            revision: spectrum_revision,
        },
        ServerArtifactReference {
            relation: "source_branches".to_string(),
            artifact: "eigen/branches.v2.json".to_string(),
            revision: branches_revision,
        },
    ];
    artifact.content_sha256 = canonical_artifact_digest(&artifact);
    artifact.revision = artifact.content_sha256.clone();
    let path = base_dir.join("eigen").join("field_sweep.v1.json");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    write_json_atomic(&path, &artifact)?;
    Ok(true)
}

fn response_execution_identity(
    artifact: &FieldDrivenResponseSweepArtifact,
) -> ServerArtifactExecution {
    ServerArtifactExecution {
        backend: "fem".to_string(),
        device: "not_provided".to_string(),
        precision: "not_provided".to_string(),
        execution_mode: "not_provided".to_string(),
        engine: artifact.backend_engine_id.clone(),
        implementation_id: Some(artifact.solver_model.clone()),
        status: "source_artifact".to_string(),
        fallback_used: None,
        fallback_reason: None,
    }
}

fn fmr_artifact_topology() -> ServerArtifactTopology {
    ServerArtifactTopology {
        mesh_id: "topology:not_provided".to_string(),
        topology_revision: "topology:not_provided".to_string(),
        indexing: "frequency_index".to_string(),
        sample_axis: "frequency_index".to_string(),
        mode_axis: "not_applicable".to_string(),
        node_count: None,
    }
}

fn response_point_amplitude(
    point: &crate::eigen::response_block_real::FieldDrivenResponseSweepPointArtifact,
) -> std::io::Result<f64> {
    finite_max(&point.response_amplitude).ok_or_else(|| {
        Error::new(
            ErrorKind::InvalidData,
            "FMR peak extraction requires finite response_amplitude values",
        )
    })
}

fn fmr_peak_uncertainty() -> FmrPeakUncertainty {
    FmrPeakUncertainty {
        kind: "not_estimated".to_string(),
        frequency_hz: None,
        amplitude: None,
        reason: Some("response sweep has no noise or covariance model".to_string()),
    }
}

fn response_peak_indices(amplitudes: &[f64]) -> Vec<usize> {
    if amplitudes.is_empty() {
        return Vec::new();
    }
    if amplitudes.len() == 1 {
        return vec![0];
    }
    let mut indices = Vec::new();
    for index in 0..amplitudes.len() {
        let is_peak = if index == 0 {
            amplitudes[index] > amplitudes[index + 1]
        } else if index + 1 == amplitudes.len() {
            amplitudes[index] >= amplitudes[index - 1]
        } else {
            amplitudes[index] >= amplitudes[index - 1]
                && amplitudes[index] >= amplitudes[index + 1]
                && (amplitudes[index] > amplitudes[index - 1]
                    || amplitudes[index] > amplitudes[index + 1])
        };
        if is_peak {
            indices.push(index);
        }
    }
    indices
}

pub fn build_fmr_peaks_artifact_with_progress(
    source: &FieldDrivenResponseSweepArtifact,
    source_revision: &str,
    requested_point_count: usize,
    interrupted: bool,
) -> std::io::Result<FmrPeaksArtifact> {
    if source.points.is_empty() {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "FMR peak extraction requires at least one driven response point",
        ));
    }
    if source.excitation_kind != "field" {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "FMR peak extraction requires a field-driven response source",
        ));
    }
    if source.points.iter().any(|point| {
        !point.frequency_hz.is_finite()
            || point.frequency_hz < 0.0
            || !point.angular_frequency_rad_per_s.is_finite()
    }) {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "FMR peak extraction requires finite non-negative frequency samples",
        ));
    }
    let amplitudes = source
        .points
        .iter()
        .map(response_point_amplitude)
        .collect::<std::io::Result<Vec<_>>>()?;
    let source_revision = source_revision.to_string();
    let peaks = response_peak_indices(&amplitudes)
        .into_iter()
        .map(|frequency_index| FmrPeakArtifact {
            peak_id: format!("response-peak-{frequency_index:04}"),
            source_artifact: "response/magnetic_response_sweep.v2.json".to_string(),
            source_revision: source_revision.clone(),
            source_frequency_index: frequency_index,
            sample_id: None,
            mode_id: None,
            frequency_hz: source.points[frequency_index].frequency_hz,
            response_amplitude: amplitudes[frequency_index],
            bracketed: frequency_index > 0 && frequency_index + 1 < source.points.len(),
            uncertainty: fmr_peak_uncertainty(),
            status: if interrupted {
                ServerArtifactStatus::Interrupted
            } else {
                ServerArtifactStatus::Complete
            },
        })
        .collect::<Vec<_>>();
    let status = if interrupted {
        ServerArtifactStatus::Interrupted
    } else {
        ServerArtifactStatus::Complete
    };
    let complete = !interrupted && source.points.len() == requested_point_count;
    let status = if status == ServerArtifactStatus::Complete && !complete {
        ServerArtifactStatus::Partial
    } else {
        status
    };
    let execution = response_execution_identity(source);
    let mut artifact = FmrPeaksArtifact {
        schema_version: "fmr/peaks.v1",
        artifact_id: "analysis:fmr:peaks".to_string(),
        source: FmrPeakSource {
            kind: FmrPeakSourceKind::DrivenResponse,
            artifact: "response/magnetic_response_sweep.v2.json".to_string(),
            revision: source_revision.clone(),
            coupling_observable: Some("max_response_amplitude".to_string()),
        },
        source_revision: source_revision.clone(),
        run_id: "run:current".to_string(),
        stage_id: "stage:frequency-response".to_string(),
        scope_id: "scope:driven-response".to_string(),
        runtime_id: "runtime:not_provided".to_string(),
        revision: String::new(),
        content_sha256: String::new(),
        status,
        complete,
        interrupted,
        stop_reason: interrupted.then_some("interrupt_requested".to_string()),
        algorithm: "select_local_maxima_of_max_response_amplitude".to_string(),
        algorithm_parameters: BTreeMap::from([
            (
                "endpoint_peaks_are_bracketed".to_string(),
                "false".to_string(),
            ),
            (
                "response_quantity".to_string(),
                "max_response_amplitude".to_string(),
            ),
        ]),
        units: server_artifact_units_response(&source.si_units),
        topology: fmr_artifact_topology(),
        requested_execution: execution.clone(),
        resolved_execution: execution,
        requested_point_count,
        completed_point_count: source.points.len(),
        peaks,
        cross_artifact_refs: vec![ServerArtifactReference {
            relation: "source_response".to_string(),
            artifact: "response/magnetic_response_sweep.v2.json".to_string(),
            revision: source_revision,
        }],
    };
    artifact.content_sha256 = canonical_artifact_digest(&artifact);
    artifact.revision = artifact.content_sha256.clone();
    Ok(artifact)
}

pub fn build_fmr_peaks_artifact(
    source: &FieldDrivenResponseSweepArtifact,
    source_revision: &str,
    interrupted: bool,
) -> std::io::Result<FmrPeaksArtifact> {
    build_fmr_peaks_artifact_with_progress(
        source,
        source_revision,
        source.points.len(),
        interrupted,
    )
}

fn local_quadratic_fit(
    frequencies: [f64; 3],
    amplitudes: [f64; 3],
) -> Option<([f64; 3], f64, f64)> {
    let [x0, x1, x2] = frequencies;
    let [y0, y1, y2] = amplitudes;
    let denominator = (x0 - x1) * (x0 - x2) * (x1 - x2);
    if !denominator.is_finite() || denominator.abs() <= f64::EPSILON {
        return None;
    }
    let a = (y0 * (x1 - x2) + y1 * (x2 - x0) + y2 * (x0 - x1)) / denominator;
    let b = (y0 * (x2 * x2 - x1 * x1) + y1 * (x0 * x0 - x2 * x2) + y2 * (x1 * x1 - x0 * x0))
        / denominator;
    let c = (y0 * x1 * x2 * (x1 - x2) + y1 * x2 * x0 * (x2 - x0) + y2 * x0 * x1 * (x0 - x1))
        / denominator;
    if !a.is_finite() || !b.is_finite() || !c.is_finite() || a >= 0.0 {
        return None;
    }
    let vertex = -b / (2.0 * a);
    if !vertex.is_finite() || vertex < x0.min(x2) || vertex > x0.max(x2) {
        return None;
    }
    let residual_l2 = [x0, x1, x2]
        .into_iter()
        .zip([y0, y1, y2])
        .map(|(x, y)| {
            let error = a * x * x + b * x + c - y;
            error * error
        })
        .sum::<f64>()
        .sqrt();
    Some(([a, b, c], vertex, residual_l2))
}

pub fn build_resonance_fits_artifact(
    peaks: &FmrPeaksArtifact,
    source: &FieldDrivenResponseSweepArtifact,
) -> std::io::Result<ResonanceFitsArtifact> {
    let mut fits = Vec::new();
    for peak in peaks.peaks.iter().filter(|peak| peak.bracketed) {
        let index = peak.source_frequency_index;
        let Some(left) = source.points.get(index.saturating_sub(1)) else {
            continue;
        };
        let Some(center) = source.points.get(index) else {
            continue;
        };
        let Some(right) = source.points.get(index + 1) else {
            continue;
        };
        let y = [
            response_point_amplitude(left)?,
            response_point_amplitude(center)?,
            response_point_amplitude(right)?,
        ];
        let x = [left.frequency_hz, center.frequency_hz, right.frequency_hz];
        let Some((coefficients, fitted_frequency_hz, residual_l2)) = local_quadratic_fit(x, y)
        else {
            continue;
        };
        fits.push(ResonanceFitArtifact {
            fit_id: format!("resonance-fit-{index:04}"),
            peak_id: Some(peak.peak_id.clone()),
            source_peak_revision: peaks.revision.clone(),
            model: "quadratic_local_peak".to_string(),
            fit_range_hz: [x[0], x[2]],
            baseline: y[0].min(y[2]),
            weights: None,
            peak_frequency_hz: Some(fitted_frequency_hz),
            linewidth_hz: None,
            q_factor: None,
            coefficients: Some(coefficients),
            covariance: None,
            conditioning: Some(1.0 / ((x[0] - x[2]).abs().max(f64::MIN_POSITIVE))),
            residual_l2: Some(residual_l2),
            uncertainty: fmr_peak_uncertainty(),
            status: ServerArtifactStatus::Partial,
        });
    }
    let status = if peaks.interrupted {
        ServerArtifactStatus::Interrupted
    } else if fits.is_empty() {
        ServerArtifactStatus::Partial
    } else {
        ServerArtifactStatus::Partial
    };
    let execution = response_execution_identity(source);
    let mut artifact = ResonanceFitsArtifact {
        schema_version: "fmr/resonance_fits.v1",
        artifact_id: "analysis:fmr:resonance-fits".to_string(),
        source: ServerArtifactSource {
            kind: "fmr_peaks".to_string(),
            artifact: "fmr/peaks.v1.json".to_string(),
            revision: peaks.revision.clone(),
        },
        source_revision: peaks.revision.clone(),
        run_id: peaks.run_id.clone(),
        stage_id: peaks.stage_id.clone(),
        scope_id: peaks.scope_id.clone(),
        runtime_id: peaks.runtime_id.clone(),
        revision: String::new(),
        content_sha256: String::new(),
        status,
        complete: false,
        interrupted: peaks.interrupted,
        stop_reason: if fits.is_empty() {
            Some("no_bracketed_peak_with_valid_fit_window".to_string())
        } else {
            Some("covariance_not_estimated".to_string())
        },
        algorithm: "quadratic_local_peak_without_statistical_covariance".to_string(),
        units: server_artifact_units_response(&source.si_units),
        topology: fmr_artifact_topology(),
        requested_execution: execution.clone(),
        resolved_execution: execution,
        fits,
        cross_artifact_refs: vec![ServerArtifactReference {
            relation: "source_peaks".to_string(),
            artifact: "fmr/peaks.v1.json".to_string(),
            revision: peaks.revision.clone(),
        }],
    };
    artifact.content_sha256 = canonical_artifact_digest(&artifact);
    artifact.revision = artifact.content_sha256.clone();
    Ok(artifact)
}

pub fn write_fmr_analysis_artifacts(
    base_dir: &Path,
    source: &FieldDrivenResponseSweepArtifact,
    requested_point_count: usize,
    interrupted: bool,
) -> std::io::Result<()> {
    let source_revision = response_source_revision(source);
    let peaks = build_fmr_peaks_artifact_with_progress(
        source,
        &source_revision,
        requested_point_count,
        interrupted,
    )?;
    let fits = build_resonance_fits_artifact(&peaks, source)?;
    let fmr_dir = base_dir.join("fmr");
    fs::create_dir_all(&fmr_dir)?;
    write_json_atomic(&fmr_dir.join("peaks.v1.json"), &peaks)?;
    write_json_atomic(&fmr_dir.join("resonance_fits.v1.json"), &fits)?;
    Ok(())
}

pub fn write_response_sweep_artifact(
    base_dir: &Path,
    artifact: &FieldDrivenResponseSweepArtifact,
) -> std::io::Result<()> {
    let response_dir = base_dir.join("response");
    fs::create_dir_all(&response_dir)?;
    fs::write(
        response_dir.join("magnetic_response_sweep.v1.json"),
        serde_json::to_vec_pretty(artifact).unwrap(),
    )?;
    Ok(())
}

pub fn write_response_sweep_bundle(
    base_dir: &Path,
    artifact: &FieldDrivenResponseSweepArtifact,
) -> std::io::Result<()> {
    write_response_sweep_bundle_with_progress(base_dir, artifact, artifact.points.len(), false)
}

pub fn write_response_sweep_bundle_with_progress(
    base_dir: &Path,
    artifact: &FieldDrivenResponseSweepArtifact,
    requested_frequency_point_count: usize,
    interrupted: bool,
) -> std::io::Result<()> {
    write_response_sweep_artifact(base_dir, artifact)?;
    let response_dir = base_dir.join("response");
    let frequency_points_dir = response_dir.join("frequency_points");
    fs::create_dir_all(&frequency_points_dir)?;
    if !artifact.points.is_empty() {
        write_response_zarr_store_metadata(base_dir)?;
    }

    let mut frequency_point_artifacts = Vec::with_capacity(artifact.points.len());
    for (index, point) in artifact.points.iter().enumerate() {
        let relative_path = format!("response/frequency_points/frequency_{index:04}.json");
        let zarr_array_path = response_zarr_array_path(index);
        let zarr_chunk_path = response_zarr_chunk_path(index);
        let compatibility_payload_path = response_compatibility_payload_path(index);
        let response_field_values = response_spatial_vector_values(&point.m_complex);
        let response_field_sample_count = response_field_values.len() / 3;
        write_complex_response_field_payloads(base_dir, index, &response_field_values)?;
        let point_artifact = ResponseFrequencyPointArtifact {
            schema_version: "frequency_response_point.v1",
            point_id: point.point_id.clone(),
            frequency_index: index,
            frequency_hz: point.frequency_hz,
            angular_frequency_rad_per_s: point.angular_frequency_rad_per_s,
            source_sweep_artifact: "response/magnetic_response_sweep.v1.json",
            field_payload_path: zarr_chunk_path.clone(),
            response_field_payload_path: zarr_chunk_path.clone(),
            storage_format: "zarr",
            zarr_store_path: response_zarr_store_path(),
            zarr_array_path,
            zarr_chunk_path,
            zarr_dtype: "<f8",
            zarr_shape: [response_field_sample_count, 3, 2],
            zarr_chunk_shape: [response_field_sample_count.max(1), 3, 2],
            zarr_compressor: None,
            compatibility_binary_payload_path: compatibility_payload_path,
            value_kind: "complex_spatial_vector",
            component_basis: "global_xyz",
            component_count: 3,
            components: ["x", "y", "z"],
            payload_encoding: "f64_interleaved_real_imag_xyz",
            binary_layout: "complex_f64_pairs_little_endian",
            complex_pair_count: response_field_values.len(),
            payload_value_count: response_field_values.len() * 2,
            available_views: [
                "complex",
                "real",
                "imag",
                "abs",
                "amplitude",
                "phase",
                "phase_rotated_real",
            ],
            default_view: "phase_rotated_real",
            default_phase_rad: 0.0,
            response_field_binary_layout: "complex_f64_pairs_little_endian",
            point,
        };
        fs::write(
            base_dir.join(&relative_path),
            serde_json::to_vec_pretty(&point_artifact).unwrap(),
        )?;
        frequency_point_artifacts.push(relative_path);
    }

    let manifest = ResponseArtifactManifest {
        schema_version: "frequency_response_artifact_manifest.v1",
        sweep_artifact: "response/magnetic_response_sweep.v1.json",
        requested_frequency_point_count,
        completed_frequency_point_count: artifact.points.len(),
        frequency_point_count: artifact.points.len(),
        frequency_point_artifacts,
        status: if interrupted {
            "interrupted"
        } else {
            "completed"
        },
        complete: !interrupted && artifact.points.len() == requested_frequency_point_count,
        interrupted,
        cancellation_reason: interrupted.then_some("interrupt_requested"),
        producer: artifact.backend_engine_id.as_str(),
    };
    fs::write(
        response_dir.join("artifact_manifest.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )?;
    write_response_sweep_v2_artifact(&response_dir, artifact, &manifest)?;
    write_response_diagnostics_artifact(
        &response_dir,
        artifact,
        requested_frequency_point_count,
        manifest.status,
        manifest.complete,
        manifest.interrupted,
    )?;
    write_response_progress_artifact(
        &response_dir,
        artifact,
        requested_frequency_point_count,
        manifest.status,
        manifest.complete,
        manifest.interrupted,
    )?;
    if manifest.interrupted {
        write_response_cancel_requested_artifact(
            &response_dir,
            artifact,
            requested_frequency_point_count,
        )?;
    }
    write_frequency_domain_response_manifest(
        base_dir,
        artifact,
        requested_frequency_point_count,
        manifest.frequency_point_artifacts.clone(),
        manifest.status,
        manifest.complete,
        manifest.interrupted,
    )?;
    if !artifact.points.is_empty() {
        write_fmr_analysis_artifacts(
            base_dir,
            artifact,
            requested_frequency_point_count,
            interrupted,
        )?;
    }
    Ok(())
}

fn write_response_sweep_v2_artifact(
    response_dir: &Path,
    artifact: &FieldDrivenResponseSweepArtifact,
    manifest: &ResponseArtifactManifest<'_>,
) -> std::io::Result<()> {
    let points = artifact
        .points
        .iter()
        .enumerate()
        .map(|(index, point)| {
            let response_field_values = response_spatial_vector_values(&point.m_complex);
            let response_field_sample_count = response_field_values.len() / 3;
            let zarr_array_path = response_zarr_array_path(index);
            let zarr_chunk_path = response_zarr_chunk_path(index);
            ResponseSweepV2PointArtifact {
                point_id: format!("frequency-point-{index:04}"),
                frequency_index: index,
                frequency_hz: point.frequency_hz,
                angular_frequency_rad_per_s: point.angular_frequency_rad_per_s,
                storage_format: "zarr",
                zarr_store_path: response_zarr_store_path(),
                zarr_array_path,
                zarr_chunk_path: zarr_chunk_path.clone(),
                zarr_dtype: "<f8",
                zarr_shape: [response_field_sample_count, 3, 2],
                zarr_chunk_shape: [response_field_sample_count.max(1), 3, 2],
                zarr_compressor: None,
                compatibility_binary_payload_path: response_compatibility_payload_path(index),
                response_field_payload_path: zarr_chunk_path,
                frequency_point_artifact_path: format!(
                    "response/frequency_points/frequency_{index:04}.json"
                ),
                response_field_binary_layout: "complex_f64_pairs_little_endian",
                max_response_amplitude: finite_max(&point.response_amplitude),
                phase_rad: dominant_phase_rad(point),
                absorbed_power_density: point.absorbed_power_density,
                residual_l2_norm: point.residual_l2_norm,
                relative_residual_l2_norm: point.relative_residual_l2_norm,
                excitation_provenance: point.excitation_provenance.clone(),
            }
        })
        .collect::<Vec<_>>();
    let frequency_point_artifact_paths = points
        .iter()
        .map(|point| point.frequency_point_artifact_path.clone())
        .collect::<Vec<_>>();
    let response_field_payload_paths = points
        .iter()
        .map(|point| point.response_field_payload_path.clone())
        .collect::<Vec<_>>();
    let sweep = ResponseSweepV2Artifact {
        schema_version: "magnetic_response_sweep.v2",
        source_sweep_artifact: "response/magnetic_response_sweep.v1.json",
        status: manifest.status,
        complete: manifest.complete,
        interrupted: manifest.interrupted,
        requested_frequency_point_count: manifest.requested_frequency_point_count,
        completed_frequency_point_count: manifest.completed_frequency_point_count,
        backend_engine_id: artifact.backend_engine_id.as_str(),
        solve_kind: "direct_harmonic_response",
        solver_model: artifact.solver_model.as_str(),
        damping_policy: artifact.damping_policy.as_str(),
        lane_classification: artifact.lane_classification.as_str(),
        matrix_layout: artifact.matrix_layout,
        excitation_kind: artifact.excitation_kind,
        si_units: &artifact.si_units,
        frequency_point_artifact_paths,
        response_field_payload_paths,
        points,
    };
    fs::write(
        response_dir.join("magnetic_response_sweep.v2.json"),
        serde_json::to_vec_pretty(&sweep).unwrap(),
    )
}

fn dominant_phase_rad(
    point: &crate::eigen::response_block_real::FieldDrivenResponseSweepPointArtifact,
) -> Option<f64> {
    point
        .response_amplitude
        .iter()
        .zip(point.response_phase.iter())
        .filter(|(_, phase)| phase.is_finite())
        .max_by(|(left_amplitude, _), (right_amplitude, _)| {
            left_amplitude
                .partial_cmp(right_amplitude)
                .unwrap_or(std::cmp::Ordering::Less)
        })
        .map(|(_, phase)| *phase)
}

fn write_response_progress_artifact(
    response_dir: &Path,
    artifact: &FieldDrivenResponseSweepArtifact,
    requested_frequency_point_count: usize,
    status: &'static str,
    complete: bool,
    interrupted: bool,
) -> std::io::Result<()> {
    let current_frequency_hz = artifact.points.last().map(|point| point.frequency_hz);
    let progress = if interrupted {
        FrequencyDomainSweepProgress::interrupted(
            requested_frequency_point_count as u64,
            artifact.points.len() as u64,
            artifact.points.len() as u64,
            current_frequency_hz.unwrap_or(0.0),
            "response/artifact_manifest.json",
        )
    } else {
        FrequencyDomainSweepProgress::completed(
            requested_frequency_point_count as u64,
            artifact.points.len() as u64,
            artifact.points.len() as u64,
            current_frequency_hz.unwrap_or(0.0),
            "response/artifact_manifest.json",
        )
    };
    let progress_artifact = ResponseProgressArtifact {
        schema_version: "frequency_domain_sweep_progress.v1",
        status: if status == "completed" {
            "ready"
        } else {
            status
        },
        state: if interrupted {
            "interrupted"
        } else if complete {
            "completed"
        } else {
            "not_started"
        },
        complete,
        total_frequency_points: progress.total_frequency_points,
        completed_frequency_points: progress.completed_frequency_points,
        written_frequency_point_artifacts: progress.written_frequency_point_artifacts,
        current_frequency_hz,
        partial_artifacts_available: progress.partial_artifacts_available,
        latest_artifact_manifest_path: (!progress.latest_artifact_manifest_path.is_empty())
            .then_some(progress.latest_artifact_manifest_path.as_str()),
        missing_reason: None,
        progress_json: progress.progress_json.as_str(),
    };
    fs::write(
        response_dir.join("progress.v1.json"),
        serde_json::to_vec_pretty(&progress_artifact).unwrap(),
    )
}

fn write_response_cancel_requested_artifact(
    response_dir: &Path,
    artifact: &FieldDrivenResponseSweepArtifact,
    requested_frequency_point_count: usize,
) -> std::io::Result<()> {
    let current_frequency_hz = artifact.points.last().map(|point| point.frequency_hz);
    let progress = FrequencyDomainSweepProgress::cancelling(
        requested_frequency_point_count as u64,
        artifact.points.len() as u64,
        artifact.points.len() as u64,
        current_frequency_hz.unwrap_or(0.0),
        "response/artifact_manifest.json",
    );
    let progress_artifact = ResponseProgressArtifact {
        schema_version: "frequency_domain_sweep_progress.v1",
        status: "cancel_requested",
        state: "cancel_requested",
        complete: false,
        total_frequency_points: progress.total_frequency_points,
        completed_frequency_points: progress.completed_frequency_points,
        written_frequency_point_artifacts: progress.written_frequency_point_artifacts,
        current_frequency_hz,
        partial_artifacts_available: progress.partial_artifacts_available,
        latest_artifact_manifest_path: (!progress.latest_artifact_manifest_path.is_empty())
            .then_some(progress.latest_artifact_manifest_path.as_str()),
        missing_reason: None,
        progress_json: progress.progress_json.as_str(),
    };
    fs::write(
        response_dir.join("cancel_requested.v1.json"),
        serde_json::to_vec_pretty(&progress_artifact).unwrap(),
    )
}

fn response_zarr_store_path() -> &'static str {
    "response/field_payloads.zarr"
}

fn response_zarr_frequency_group_path(frequency_index: usize) -> String {
    format!("response/field_payloads.zarr/frequency_{frequency_index:04}")
}

fn response_zarr_array_path(frequency_index: usize) -> String {
    format!(
        "{}/vector_xyz_complex",
        response_zarr_frequency_group_path(frequency_index)
    )
}

fn response_zarr_chunk_path(frequency_index: usize) -> String {
    format!("{}/0.0.0", response_zarr_array_path(frequency_index))
}

fn response_spatial_vector_values(values: &[[f64; 2]]) -> Vec<[f64; 2]> {
    if values.len() % 3 == 0 {
        return values.to_vec();
    }
    let mut spatial_values = Vec::with_capacity(values.len() * 3);
    for value in values {
        spatial_values.push(*value);
        spatial_values.push([0.0, 0.0]);
        spatial_values.push([0.0, 0.0]);
    }
    spatial_values
}

fn response_compatibility_payload_path(frequency_index: usize) -> String {
    format!("response/field_payloads/frequency_{frequency_index:04}/vector.bin")
}

fn write_response_zarr_store_metadata(base_dir: &Path) -> std::io::Result<()> {
    let store_dir = base_dir.join(response_zarr_store_path());
    fs::create_dir_all(&store_dir)?;
    fs::write(
        store_dir.join(".zgroup"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "zarr_format": 2,
        }))
        .unwrap(),
    )?;
    fs::write(
        store_dir.join(".zattrs"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "fullmag_kind": "frequency_domain_response_field_store",
            "schema_version": 1,
            "preferred_container": "zarr",
            "quantity_ids": ["dynamic_response"],
            "axes": ["frequency", "complex_pair", "complex"],
            "complex_order": ["real", "imag"],
            "storage_layout": "complex_pair_major",
            "compatibility_binary_exports": true,
        }))
        .unwrap(),
    )
}

fn write_response_zarr_array_metadata(
    base_dir: &Path,
    frequency_index: usize,
    complex_pair_count: usize,
) -> std::io::Result<()> {
    let sample_count = complex_pair_count / 3;
    let group_dir = base_dir.join(response_zarr_frequency_group_path(frequency_index));
    let array_dir = base_dir.join(response_zarr_array_path(frequency_index));
    fs::create_dir_all(&array_dir)?;
    fs::write(
        group_dir.join(".zgroup"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "zarr_format": 2,
        }))
        .unwrap(),
    )?;
    fs::write(
        array_dir.join(".zarray"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "zarr_format": 2,
            "shape": [sample_count, 3, 2],
            "chunks": [sample_count.max(1), 3, 2],
            "dtype": "<f8",
            "compressor": serde_json::Value::Null,
            "fill_value": 0.0,
            "order": "C",
            "filters": serde_json::Value::Null,
            "dimension_separator": ".",
        }))
        .unwrap(),
    )?;
    fs::write(
        array_dir.join(".zattrs"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "quantity_id": "dynamic_response",
            "unit": "A_per_m",
            "value_kind": "complex_spatial_vector",
            "component_basis": "global_xyz",
            "axes": ["spatial_sample", "component", "complex"],
            "component_order": ["x", "y", "z"],
            "complex_order": ["real", "imag"],
            "frequency_index": frequency_index,
            "sample_count": sample_count,
            "complex_pair_count": complex_pair_count,
            "storage_layout": "aos_xyz_complex_pairs",
        }))
        .unwrap(),
    )
}

fn complex_response_field_payload_bytes(values: &[[f64; 2]]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(values.len() * 2 * std::mem::size_of::<f64>());
    for [real, imag] in values {
        bytes.extend_from_slice(&real.to_le_bytes());
        bytes.extend_from_slice(&imag.to_le_bytes());
    }
    bytes
}

fn write_complex_response_field_payloads(
    base_dir: &Path,
    frequency_index: usize,
    values: &[[f64; 2]],
) -> std::io::Result<()> {
    write_response_zarr_array_metadata(base_dir, frequency_index, values.len())?;
    let bytes = complex_response_field_payload_bytes(values);
    let zarr_chunk_path = base_dir.join(response_zarr_chunk_path(frequency_index));
    if let Some(parent) = zarr_chunk_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(zarr_chunk_path, &bytes)?;
    let compatibility_path = base_dir.join(response_compatibility_payload_path(frequency_index));
    if let Some(parent) = compatibility_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(compatibility_path, bytes)
}

fn write_complex_vector_field_payload(
    base_dir: &Path,
    relative_path: &str,
    real_values: &[[f64; 3]],
    imag_values: &[[f64; 3]],
) -> std::io::Result<()> {
    if real_values.is_empty() || imag_values.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "complex vector payload requires non-empty real and imaginary Cartesian samples",
        ));
    }
    if real_values.len() != imag_values.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "complex vector payload length mismatch: real={}, imag={}",
                real_values.len(),
                imag_values.len()
            ),
        ));
    }
    let path = base_dir.join(relative_path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut bytes = Vec::with_capacity(real_values.len() * 3 * 2 * std::mem::size_of::<f64>());
    for (real, imag) in real_values.iter().zip(imag_values.iter()) {
        for component in 0..3 {
            if !real[component].is_finite() || !imag[component].is_finite() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "complex vector payload contains a non-finite Cartesian component",
                ));
            }
            bytes.extend_from_slice(&real[component].to_le_bytes());
            bytes.extend_from_slice(&imag[component].to_le_bytes());
        }
    }
    fs::write(path, bytes)
}

fn write_response_diagnostics_artifact(
    response_dir: &Path,
    artifact: &FieldDrivenResponseSweepArtifact,
    requested_frequency_point_count: usize,
    status: &'static str,
    complete: bool,
    interrupted: bool,
) -> std::io::Result<()> {
    let residuals = artifact
        .points
        .iter()
        .map(|point| point.residual_l2_norm)
        .collect::<Vec<_>>();
    let relative_residuals = artifact
        .points
        .iter()
        .map(|point| point.relative_residual_l2_norm)
        .collect::<Vec<_>>();
    let tangent_leakage = artifact
        .points
        .iter()
        .filter_map(|point| point.tangent_leakage.l2_norm)
        .collect::<Vec<_>>();
    let frequencies = artifact
        .points
        .iter()
        .map(|point| point.frequency_hz)
        .collect::<Vec<_>>();
    let diagnostics = ResponseDiagnosticsArtifact {
        schema_version: "frequency_domain_response_diagnostics.v1",
        status,
        complete,
        interrupted,
        requested_frequency_point_count,
        completed_frequency_point_count: artifact.points.len(),
        frequency_min_hz: finite_min(&frequencies),
        frequency_max_hz: finite_max(&frequencies),
        residual_l2_norm_max: finite_max(&residuals),
        residual_l2_norm_mean: finite_mean(&residuals),
        relative_residual_l2_norm_max: finite_max(&relative_residuals),
        tangent_leakage_l2_norm_max: finite_max(&tangent_leakage),
        solver_model: artifact.solver_model.as_str(),
        backend_engine_id: artifact.backend_engine_id.as_str(),
        lane_classification: artifact.lane_classification.as_str(),
        solve_kind: "direct_harmonic_response",
    };
    let diagnostics_bytes = serde_json::to_vec_pretty(&diagnostics).unwrap();
    let solver_diagnostics_path = response_dir.join("diagnostics").join("solver.v1.json");
    if let Some(parent) = solver_diagnostics_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&solver_diagnostics_path, &diagnostics_bytes)?;
    fs::write(response_dir.join("diagnostics.v1.json"), diagnostics_bytes)?;
    Ok(())
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

fn finite_min(values: &[f64]) -> Option<f64> {
    values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .reduce(f64::min)
}

fn finite_max(values: &[f64]) -> Option<f64> {
    values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .reduce(f64::max)
}

fn finite_mean(values: &[f64]) -> Option<f64> {
    let mut count = 0usize;
    let mut sum = 0.0;
    for value in values.iter().copied().filter(|value| value.is_finite()) {
        count += 1;
        sum += value;
    }
    (count > 0).then_some(sum / count as f64)
}

fn write_frequency_domain_response_manifest(
    base_dir: &Path,
    artifact: &FieldDrivenResponseSweepArtifact,
    requested_frequency_point_count: usize,
    frequency_point_artifacts: Vec<String>,
    status: &'static str,
    complete: bool,
    interrupted: bool,
) -> std::io::Result<()> {
    let manifest_dir = base_dir.join("frequency_domain");
    fs::create_dir_all(&manifest_dir)?;
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| format!("unix:{}", duration.as_secs()))
        .unwrap_or_else(|_| "unix:0".to_string());
    let response_field_resources = frequency_point_artifacts
        .iter()
        .enumerate()
        .map(|(index, _)| {
            format!("/v2/sessions/current/analysis/frequency-domain/response/field/{index}/meta")
        })
        .collect::<Vec<_>>();
    let manifest = FrequencyDomainArtifactManifest {
        schema_version: "frequency_domain_manifest.v1",
        analysis_family: "magnetic_frequency_domain",
        study_product: "driven_response",
        revision: format!(
            "response:{}:{}:{}",
            status,
            artifact.points.len(),
            requested_frequency_point_count
        ),
        session_id: "current",
        run_id: "current",
        stage_id: "frequency-response",
        stage_kind: "frequency_response",
        created_at,
        requested_execution: FrequencyDomainRequestedExecution {
            calculation_mode: "frequency_response",
            backend: "fem",
            device: "cpu".to_string(),
            precision: "double".to_string(),
            execution_mode: "extended".to_string(),
            ui_mode: "auto",
            operator: "linearized_llg",
            solver_family: "frequency_response",
            solve_equation: "(i omega B - L) q = f",
            include_demag: false,
            damping_policy: artifact.damping_policy.as_str(),
            equilibrium_source: "provided_or_planned",
            k_sampling: "single",
            outputs: vec!["susceptibility_tensor"],
            solver_method: "direct_harmonic_response".to_string(),
            preconditioner: "not_applicable".to_string(),
            magnetostatic_bc: "not_applicable".to_string(),
        },
        resolved_execution: FrequencyDomainResolvedExecution {
            backend: "fem",
            device: "cpu".to_string(),
            precision: "double".to_string(),
            engine: artifact.backend_engine_id.clone(),
            native_backend: "runner_validation".to_string(),
            reference_or_production: "reference".to_string(),
            container_image: None,
            build_features: Vec::new(),
            demag_realization: "none_or_validation_contract".to_string(),
            solver_library: "nalgebra".to_string(),
            solver_algorithm: artifact.solver_model.clone(),
            solve_kind: "direct_harmonic_response",
            status: Some(if complete { "ok" } else { "partial" }.to_string()),
            implementation_id: Some(artifact.backend_engine_id.clone()),
            operator_residency: Some("host".to_string()),
            vector_residency: Some("host".to_string()),
            krylov_residency: Some("host".to_string()),
            preconditioner_residency: Some("not_applicable".to_string()),
            fallback_used: Some(false),
            fallback_reason: None,
            fallback_from_engine: None,
            fallback_to_engine: None,
        },
        physics: FrequencyDomainPhysics {
            analysis_family: "magnetic_frequency_domain",
            llg_gamma0_si: None,
            llg_alpha: None,
            phase_convention: "exp_minus_i_omega_t".to_string(),
            frequency_units: "Hz",
            field_units: "A/m",
            normalization: "unit_l2",
            spin_wave_bc: "planned".to_string(),
            periodic_or_floquet: "none".to_string(),
            equilibrium_residual_summary: None,
            response_map_axes: vec!["frequency_hz"],
        },
        artifacts: FrequencyDomainArtifactIndex {
            solver_diagnostics_path: Some("response/diagnostics/solver.v1.json"),
            spectrum_v2_path: None,
            branches_v2_path: None,
            dispersion_csv_path: None,
            eigen_diagnostics_v2_path: None,
            response_sweep_v1_path: Some("response/magnetic_response_sweep.v1.json"),
            response_sweep_v2_path: Some("response/magnetic_response_sweep.v2.json"),
            response_map_v1_path: None,
            response_map_v2_path: None,
            response_diagnostics_v1_path: Some("response/diagnostics/solver.v1.json"),
            response_progress_v1_path: Some("response/progress.v1.json"),
            response_cancel_requested_v1_path: interrupted
                .then_some("response/cancel_requested.v1.json"),
            field_sweep_v1_path: None,
            fmr_peaks_v1_path: (!artifact.points.is_empty()).then_some("fmr/peaks.v1.json"),
            fmr_resonance_fits_v1_path: (!artifact.points.is_empty())
                .then_some("fmr/resonance_fits.v1.json"),
            fmr_kittel_fit_v1_path: None,
            mode_metadata_paths: Vec::new(),
            frequency_point_paths: frequency_point_artifacts,
        },
        resources: FrequencyDomainResourceIndex {
            spectrum_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
            ),
            branches_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
            ),
            dispersion_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
            ),
            diagnostics_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1",
            ),
            eigen_diagnostics_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
            ),
            response_sweep_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
            ),
            response_map_resource_key: None,
            response_progress_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/response/progress.v1",
            ),
            response_cancel_requested_resource_key: interrupted.then_some(
                "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1",
            ),
            response_diagnostics_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1",
            ),
            mode_field_resources: Vec::new(),
            response_field_resources,
        },
        validation: FrequencyDomainValidation {
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_frequency_source: None,
            dispersion_reference_model: None,
            dynamic_demag_operator_source: None,
        },
        diagnostics: FrequencyDomainDiagnostics {
            status,
            complete,
            requested_frequency_point_count,
            completed_frequency_point_count: artifact.points.len(),
            written_frequency_point_artifacts: artifact.points.len(),
            interrupted,
            tracking_score_source: None,
            modal_overlap_available: None,
            modal_overlap_unavailable_reason: None,
        },
        capabilities: FrequencyDomainCapabilitySnapshot {
            driven_response_artifact_available: true,
            modal_artifact_available: false,
            production_native_solver_available: false,
            validation_artifact: true,
        },
        physics_contract_version: None,
        operator_dictionary_version: None,
        implementation_state: None,
        validation_state: None,
        validated_scope: None,
        assembly_kind: None,
        operator_input_signature_sha256: None,
        boundary_gauge: None,
        spectral: None,
        phase_constraint_sha256: None,
        equilibrium_artifact_sha256: None,
        linearization_state_sha256: None,
        periodic_mesh_certificate_sha256: None,
    };
    fs::write(
        manifest_dir.join("manifest.v1.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )?;
    Ok(())
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
            "execution_lane": solver_classification.reference_or_production,
            "solver_algorithm": result.solver_model.as_str(),
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

fn write_k0_kittel_validation_artifacts(
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
            branches_v2_path: Some("eigen/branches.v2.json"),
            dispersion_csv_path: Some("eigen/dispersion.csv"),
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
            branches_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
            ),
            dispersion_resource_key: Some(
                "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
            ),
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
            dispersion_validation: result.dispersion_validation.as_ref(),
            k0_kittel_validation: result.k0_kittel_validation.as_ref(),
            dispersion_frequency_source: dispersion_frequency_source(result),
            dispersion_reference_model: dispersion_reference_model(result),
            dynamic_demag_operator_source: dispersion_dynamic_demag_operator_source(result),
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

fn eigen_calculation_mode(result: &PathSolveResult) -> &'static str {
    if result.samples.len() > 1
        || result.samples.iter().any(|sample| {
            sample.sample.path_s != 0.0
                || sample
                    .sample
                    .k_vector
                    .iter()
                    .any(|component| *component != 0.0)
        })
    {
        "dispersion_modal"
    } else {
        "free_modes"
    }
}

pub fn solve_and_write_field_driven_response_sweep_bundle(
    base_dir: &Path,
    template: &BlockRealHarmonicTemplate,
    frequencies_rad_per_s: &[f64],
    field_excitation: &DVector<Complex64>,
    backend_engine_id: &str,
    solver_model: &str,
    damping_policy: &str,
    lane_classification: &str,
) -> Result<FieldDrivenResponseSweepArtifact, String> {
    let points =
        solve_field_driven_block_real_sweep(template, frequencies_rad_per_s, field_excitation)?;
    let artifact = build_field_driven_response_sweep_artifact(
        &points,
        backend_engine_id,
        solver_model,
        damping_policy,
        lane_classification,
    );
    write_response_sweep_bundle(base_dir, &artifact)
        .map_err(|error| format!("failed to write response sweep bundle: {error}"))?;
    Ok(artifact)
}

pub fn solve_and_write_field_driven_response_sweep_bundle_with_interrupt(
    base_dir: &Path,
    template: &BlockRealHarmonicTemplate,
    frequencies_rad_per_s: &[f64],
    field_excitation: &DVector<Complex64>,
    should_interrupt_after_completed_points: impl FnMut(usize) -> bool,
    backend_engine_id: &str,
    solver_model: &str,
    damping_policy: &str,
    lane_classification: &str,
) -> Result<FieldDrivenResponseSweepArtifact, String> {
    let outcome = solve_field_driven_block_real_sweep_with_interrupt(
        template,
        frequencies_rad_per_s,
        field_excitation,
        should_interrupt_after_completed_points,
    )?;
    let artifact = build_field_driven_response_sweep_artifact(
        &outcome.points,
        backend_engine_id,
        solver_model,
        damping_policy,
        lane_classification,
    );
    write_response_sweep_bundle_with_progress(
        base_dir,
        &artifact,
        outcome.requested_point_count,
        outcome.interrupted,
    )
    .map_err(|error| format!("failed to write response sweep bundle: {error}"))?;
    Ok(artifact)
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

fn kalinikos_slab_n0_frequency_hz(
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

fn vector_norm(vector: [f64; 3]) -> f64 {
    vector.iter().map(|value| value * value).sum::<f64>().sqrt()
}

pub fn write_mode_bundle(base_dir: &Path, result: &PathSolveResult) -> std::io::Result<()> {
    for sample in &result.samples {
        let diagnostics = sample_native_solver_diagnostics(sample);
        for mode in &sample.modes {
            let real = mode.lifted_real.as_deref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "mode field publication requires reconstructed global_xyz real payload",
                )
            })?;
            let imag = mode.lifted_imag.as_deref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "mode field publication requires reconstructed global_xyz imaginary payload",
                )
            })?;
            if real.is_empty() || imag.is_empty() || real.len() != imag.len() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "mode field publication requires equal non-empty real/imag payloads: real={}, imag={}",
                        real.len(),
                        imag.len()
                    ),
                ));
            }
            mode_source_mesh_identity(diagnostics, real.len())?;
        }
    }
    let eigen_dir = base_dir.join("eigen").join("modes");
    for sample in &result.samples {
        let sample_dir = eigen_dir.join(format!("sample_{:04}", sample.sample.sample_index));
        fs::create_dir_all(&sample_dir)?;
        for mode in &sample.modes {
            let real = mode.lifted_real.as_deref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "mode field publication requires reconstructed global_xyz real payload",
                )
            })?;
            let imag = mode.lifted_imag.as_deref().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "mode field publication requires reconstructed global_xyz imaginary payload",
                )
            })?;
            if real.is_empty() || imag.is_empty() || real.len() != imag.len() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!(
                        "mode field publication requires equal non-empty real/imag payloads: real={}, imag={}",
                        real.len(),
                        imag.len()
                    ),
                ));
            }
            let amplitude = mode.amplitude.as_deref().unwrap_or(&[]);
            let mode_field_id =
                eigen_mode_field_id(sample.sample.sample_index, mode.raw_mode_index);
            let mode_field_resource_key = eigen_mode_field_resource_key(&mode_field_id);
            let compatibility_binary_payload_path = format!(
                "eigen/mode_fields/sample_{:04}/mode_{:04}/vector.bin",
                sample.sample.sample_index, mode.raw_mode_index
            );
            let residual_absolute_l2 = finite_or_default(mode.residual_norm, 0.0);
            let residual_relative_l2 = residual_absolute_l2;
            let residual_linf = finite_or_default(mode.residual_linf, residual_absolute_l2);
            let tangent_leakage_mean_abs = finite_or_default(mode.tangent_leakage_mean_abs, 0.0);
            let tangent_leakage_max_abs =
                finite_or_default(mode.tangent_leakage_max_abs, 0.0).max(tangent_leakage_mean_abs);
            let diagnostics = sample_native_solver_diagnostics(sample);
            let payload = ModeArtifact {
                schema_version: "2",
                solver_model: result.solver_model.as_str().to_string(),
                sample_index: sample.sample.sample_index,
                raw_mode_index: mode.raw_mode_index,
                branch_id: mode.branch_id,
                frequency_hz: mode.frequency_real_hz,
                frequency_real_hz: mode.frequency_real_hz,
                frequency_imag_hz: mode.frequency_imag_hz,
                angular_frequency_rad_per_s: mode.angular_frequency_rad_per_s,
                eigenvalue_real: mode.eigenvalue_real,
                eigenvalue_imag: mode.eigenvalue_imag,
                phasor_convention: modal_phasor_convention(result.solver_model),
                eigenvalue_mapping: modal_eigenvalue_mapping(result.solver_model),
                omega_rad_s: mode.angular_frequency_rad_per_s,
                gamma_rad_s_t: reference_modal_gamma_rad_s_t(),
                gamma0_rad_s_per_a_m: REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M,
                mu0_t_m_per_a: crate::MU0,
                normalization: "unit_l2",
                damping_policy: "ignore",
                mode_field_id,
                mode_field_resource_key,
                residual_norm: Some(residual_absolute_l2),
                residual_absolute_l2,
                residual_relative_l2,
                residual_linf: Some(residual_linf),
                mass_norm: resolved_mode_mass_norm(mode),
                tangent_leakage_mean_abs: Some(tangent_leakage_mean_abs),
                tangent_leakage_max_abs: Some(tangent_leakage_max_abs),
                dominant_polarization: mode.dominant_polarization.clone(),
                k_vector: sample.sample.k_vector,
                external_field_a_per_m: sample_external_field(result, sample.sample.sample_index),
                assembly_kind: diagnostic_string(diagnostics, "assembly_kind"),
                operator_input_signature_sha256: diagnostic_string(
                    diagnostics,
                    "operator_input_signature_sha256",
                ),
                phase_constraint_sha256: diagnostic_string(diagnostics, "phase_constraint_sha256"),
                equilibrium_artifact_sha256: diagnostic_string(
                    diagnostics,
                    "equilibrium_artifact_sha256",
                ),
                linearization_state_sha256: diagnostic_string(
                    diagnostics,
                    "linearization_state_sha256",
                ),
                periodic_mesh_certificate_sha256: diagnostic_string(
                    diagnostics,
                    "periodic_mesh_certificate_sha256",
                ),
                relax_to_eigen_handoff_sha256: diagnostic_string(
                    diagnostics,
                    "relax_to_eigen_handoff_sha256",
                ),
                source_mesh_topology_sha256: diagnostic_string(
                    diagnostics,
                    "source_mesh_topology_sha256",
                ),
                source_mesh_identity: mode_source_mesh_identity(diagnostics, real.len())?,
                value_kind: "complex_spatial_vector",
                component_basis: "global_xyz",
                component_count: 3,
                components: ["x", "y", "z"],
                storage_format: "binary_compatibility_exports",
                compatibility_binary_payload_path: compatibility_binary_payload_path.clone(),
                payload_encoding: "f64_interleaved_real_imag_xyz",
                binary_layout: "complex_f64_pairs_little_endian",
                complex_pair_count: real.len() * 3,
                payload_value_count: real.len() * 6,
                available_views: [
                    "complex",
                    "real",
                    "imag",
                    "abs",
                    "amplitude",
                    "phase",
                    "phase_rotated_real",
                ],
                default_view: "phase_rotated_real",
                default_phase_rad: 0.0,
                mode_field_sample_count: real.len(),
                amplitude_summary: mode_amplitude_summary(amplitude),
                component_summary: mode_component_summary(real, imag),
            };
            let mode_bytes = serde_json::to_vec_pretty(&payload).unwrap();
            fs::write(
                eigen_dir.join(format!(
                    "sample_{:04}_mode_{:04}.json",
                    sample.sample.sample_index, mode.raw_mode_index
                )),
                &mode_bytes,
            )?;
            fs::write(
                sample_dir.join(format!("mode_{:04}.json", mode.raw_mode_index)),
                mode_bytes,
            )?;
            write_complex_vector_field_payload(
                base_dir,
                &compatibility_binary_payload_path,
                real,
                imag,
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eigen::response_block_real::{
        build_field_driven_response_sweep_artifact, solve_field_driven_block_real_sweep,
        BlockRealHarmonicTemplate,
    };
    use crate::eigen::types::{
        EigenSolverModel, KSampleDescriptor, PathSolveResult, SingleKModeResult,
        SingleKSolveResult, TrackedBranch, TrackedBranchPoint,
    };
    use nalgebra::{DMatrix, DVector};
    use num_complex::Complex64;
    use serde_json::Value;
    use std::path::PathBuf;

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(slug: &str) -> Self {
            let path = std::env::temp_dir()
                .join(format!("fullmag-runner-{slug}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("temp test dir should be created");
            Self { path }
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn sample_result() -> PathSolveResult {
        sample_result_with_solver_model(EigenSolverModel::ReferenceScalarTangent)
    }

    fn sample_result_with_solver_model(solver_model: EigenSolverModel) -> PathSolveResult {
        PathSolveResult {
            samples: vec![SingleKSolveResult {
                sample: KSampleDescriptor {
                    sample_index: 0,
                    label: Some("G".to_string()),
                    segment_index: Some(0),
                    path_s: 0.0,
                    t_in_segment: 0.0,
                    k_vector: [0.0, 0.0, 0.0],
                },
                modes: vec![SingleKModeResult {
                    raw_mode_index: 0,
                    branch_id: Some(0),
                    frequency_real_hz: 1.0e9,
                    frequency_imag_hz: 0.0,
                    angular_frequency_rad_per_s: std::f64::consts::TAU * 1.0e9,
                    eigenvalue_real: 0.0,
                    eigenvalue_imag: std::f64::consts::TAU * 1.0e9,
                    norm: 1.0,
                    mass_norm: Some(7.25),
                    max_amplitude: 1.0,
                    residual_norm: Some(1.25e-9),
                    residual_linf: Some(2.5e-10),
                    tangent_leakage_mean_abs: Some(3.0e-12),
                    tangent_leakage_max_abs: Some(4.0e-12),
                    dominant_polarization: "linear".to_string(),
                    reduced_vector: Some(vec![Complex64::new(1.0, 0.0)]),
                    lifted_real: Some(vec![[1.0, 0.0, 0.0]]),
                    lifted_imag: Some(vec![[0.0, 1.0, 0.0]]),
                    amplitude: Some(vec![1.0]),
                    phase: Some(vec![0.0]),
                    node_mass_weights: None,
                }],
                relaxation_steps: 0,
                solver_model,
                solver_notes: vec!["test fixture".to_string()],
                solver_diagnostics: Some(serde_json::json!({
                    "mesh_id": "mesh:test",
                    "mesh_generation_id": "mesh-generation:test",
                    "mesh_revision": 17,
                    "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                })),
            }],
            branches: vec![TrackedBranch {
                branch_id: 0,
                label: Some("B0".to_string()),
                points: vec![TrackedBranchPoint {
                    sample_index: 0,
                    raw_mode_index: 0,
                    frequency_real_hz: 1.0e9,
                    frequency_imag_hz: 0.0,
                    tracking_confidence: 1.0,
                    overlap_prev: None,
                }],
            }],
            solver_model,
            notes: vec!["single sample".to_string()],
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        }
    }

    fn sample_result_with_modal_overlap_tracking() -> PathSolveResult {
        let mut result =
            sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
        let mut sample_1 = result.samples[0].clone();
        sample_1.sample.sample_index = 1;
        sample_1.sample.label = Some("X".to_string());
        sample_1.sample.path_s = 10_000_000.0;
        sample_1.sample.k_vector = [10_000_000.0, 0.0, 0.0];
        sample_1.modes[0].frequency_real_hz = 1.25e9;
        sample_1.modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU * 1.25e9;
        sample_1.modes[0].eigenvalue_imag = std::f64::consts::TAU * 1.25e9;
        let mut sample_2 = sample_1.clone();
        sample_2.sample.sample_index = 2;
        sample_2.sample.label = Some("G".to_string());
        sample_2.sample.path_s = 20_000_000.0;
        sample_2.sample.k_vector = [0.0, 0.0, 0.0];
        sample_2.modes[0].frequency_real_hz = 1.5e9;
        sample_2.modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU * 1.5e9;
        sample_2.modes[0].eigenvalue_imag = std::f64::consts::TAU * 1.5e9;
        result.samples.push(sample_1);
        result.samples.push(sample_2);
        result.branches[0].points.push(TrackedBranchPoint {
            sample_index: 1,
            raw_mode_index: 0,
            frequency_real_hz: 1.25e9,
            frequency_imag_hz: 0.0,
            tracking_confidence: 0.8,
            overlap_prev: Some(0.8),
        });
        result.branches[0].points.push(TrackedBranchPoint {
            sample_index: 2,
            raw_mode_index: 0,
            frequency_real_hz: 1.5e9,
            frequency_imag_hz: 0.0,
            tracking_confidence: 0.6,
            overlap_prev: Some(0.6),
        });
        result.notes = vec!["modal overlap tracking".to_string()];
        result
    }

    fn sample_result_with_k0_kittel_sweep() -> PathSolveResult {
        let mut result =
            sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
        let template = result.samples[0].clone();
        let fields_a_per_m = [40_000.0, 80_000.0, 120_000.0];

        result.samples.clear();
        result.branches = vec![TrackedBranch {
            branch_id: 0,
            label: Some("k0_kittel_uniform_branch".to_string()),
            points: Vec::new(),
        }];

        for (sample_index, field_a_per_m) in fields_a_per_m.iter().copied().enumerate() {
            let frequency_hz =
                REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M * field_a_per_m / std::f64::consts::TAU;
            let mut sample = template.clone();
            sample.sample.sample_index = sample_index;
            sample.sample.label = Some(format!("H{sample_index}"));
            sample.sample.path_s = sample_index as f64;
            sample.sample.t_in_segment = sample_index as f64 / (fields_a_per_m.len() - 1) as f64;
            sample.sample.k_vector = [0.0, 0.0, 0.0];
            sample.modes[0].frequency_real_hz = frequency_hz;
            sample.modes[0].frequency_imag_hz = 0.0;
            sample.modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU * frequency_hz;
            sample.modes[0].eigenvalue_real = 0.0;
            sample.modes[0].eigenvalue_imag = std::f64::consts::TAU * frequency_hz;
            result.samples.push(sample);
            result.branches[0].points.push(TrackedBranchPoint {
                sample_index,
                raw_mode_index: 0,
                frequency_real_hz: frequency_hz,
                frequency_imag_hz: 0.0,
                tracking_confidence: 1.0,
                overlap_prev: (sample_index > 0).then_some(1.0),
            });
        }

        result.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: None,
            demag_kind: None,
            model: "macrospin_larmor".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: None,
            },
            samples: fields_a_per_m
                .iter()
                .copied()
                .enumerate()
                .map(|(sample_index, field_a_per_m)| {
                    fullmag_ir::FemEigenK0KittelValidationSampleIR {
                        sample_index: sample_index as u32,
                        bias_field: [field_a_per_m, 0.0, 0.0],
                    }
                })
                .collect(),
        });
        result.notes = vec!["k0 Kittel field sweep".to_string()];
        result
    }

    #[test]
    fn eigen_artifact_writer_emits_v2_contract_files() {
        let temp = TempDirGuard::new("eigen-artifacts-v2");
        let result = sample_result();

        write_path_bundle(&temp.path, &result).expect("path bundle should write");
        write_branch_bundle(&temp.path, &result).expect("branch bundle should write");
        write_branch_bundle(&temp.path, &result).expect("branch bundle should write");
        write_mode_bundle(&temp.path, &result).expect("mode bundle should write");
        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain eigen manifest should write");

        let eigen_dir = temp.path.join("eigen");
        let spectrum: Value = serde_json::from_slice(
            &std::fs::read(eigen_dir.join("spectrum.v2.json"))
                .expect("spectrum.v2.json should be written"),
        )
        .expect("spectrum.v2.json should be valid JSON");
        assert_eq!(spectrum["schema_version"], "eigen_spectrum.v2");
        assert_eq!(spectrum["sample_count"], 1);
        assert_eq!(
            spectrum["samples"][0]["sample_id"],
            "bias-field-sample-0000"
        );
        assert_eq!(
            spectrum["samples"][0]["modes"][0]["mode_id"],
            "sample-0000/mode-0000"
        );
        assert_eq!(
            spectrum["samples"][0]["modes"][0]["mode_field_id"],
            "analysis:eigen:sample-0000:mode-0000"
        );
        assert_eq!(
            spectrum["samples"][0]["modes"][0]["mode_field_resource_key"],
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
        );

        let branches: Value = serde_json::from_slice(
            &std::fs::read(eigen_dir.join("branches.v2.json"))
                .expect("branches.v2.json should be written"),
        )
        .expect("branches.v2.json should be valid JSON");
        assert_eq!(branches["schema_version"], "eigen_branches.v2");
        assert_eq!(branches["tracking_score_source"], "seed_only");
        assert_eq!(branches["modal_overlap_available"], false);
        assert_eq!(
            branches["diagnostics"]["tracking_score_source"],
            "seed_only"
        );
        assert_eq!(branches["diagnostics"]["modal_overlap_available"], false);
        assert_eq!(
            branches["branches"][0]["points"][0]["tracking_score_source"],
            "seed"
        );
        assert_eq!(
            branches["branches"][0]["points"][0]["modal_overlap_available"],
            false
        );
        assert_eq!(
            branches["branches"][0]["points"][0]["mode_field_id"],
            "analysis:eigen:sample-0000:mode-0000"
        );
        assert_eq!(
            branches["branches"][0]["points"][0]["mode_field_resource_key"],
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
        );

        let dispersion = std::fs::read_to_string(eigen_dir.join("dispersion.csv"))
            .expect("dispersion.csv should be written");
        let mut dispersion_lines = dispersion.lines();
        let dispersion_header = dispersion_lines
            .next()
            .expect("dispersion.csv should include a header");
        assert_eq!(
            Some(dispersion_header),
            Some(
                "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,analytic_frequency_hz,relative_error,validation_geometry,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key"
            )
        );
        let dispersion_row = dispersion_lines
            .next()
            .expect("dispersion.csv should include a mode row");
        let dispersion_columns = dispersion_row.split(',').collect::<Vec<_>>();
        let header_columns = dispersion_header.split(',').collect::<Vec<_>>();
        let column = |name: &str| {
            header_columns
                .iter()
                .position(|column| *column == name)
                .expect("dispersion column should exist")
        };
        assert!(
            dispersion_columns
                .get(column("residual_norm"))
                .is_some_and(|value| !value.is_empty()),
            "dispersion.csv residual_norm column should be populated, row={dispersion_row}"
        );
        assert_eq!(
            dispersion_columns.get(column("tracking_score_source")),
            Some(&"seed")
        );
        assert_eq!(
            dispersion_columns.get(column("mode_field_id")),
            Some(&"analysis:eigen:sample-0000:mode-0000")
        );
        assert_eq!(
            dispersion_columns.get(column("mode_field_resource_key")),
            Some(&"/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0")
        );

        let mode: Value = serde_json::from_slice(
            &std::fs::read(eigen_dir.join("modes/sample_0000_mode_0000.json"))
                .expect("flat v2 mode artifact should be written"),
        )
        .expect("mode artifact should be valid JSON");
        assert_eq!(mode["sample_index"], 0);
        assert_eq!(mode["raw_mode_index"], 0);
        assert_eq!(mode["frequency_hz"], 1.0e9);
        assert_eq!(mode["frequency_real_hz"], 1.0e9);
        assert_eq!(
            mode["mode_field_id"],
            "analysis:eigen:sample-0000:mode-0000"
        );
        assert_eq!(
            mode["mode_field_resource_key"],
            "/v2/sessions/current/data/fields/analysis:eigen:sample-0000:mode-0000/samples/vector?view=phase_rotated_real&phase_rad=0"
        );
        for required in [
            "residual_norm",
            "residual_linf",
            "tangent_leakage_mean_abs",
            "tangent_leakage_max_abs",
        ] {
            assert!(
                mode[required].as_f64().is_some(),
                "mode artifact should include numeric {required}: {mode}"
            );
        }
        assert_eq!(mode["mode_field_sample_count"], 1);
        assert_eq!(mode["amplitude_summary"]["sample_count"], 1);
        assert_eq!(mode["amplitude_summary"]["max"], 1.0);
        assert_eq!(mode["mass_norm"], 7.25);
        assert_eq!(mode["component_summary"]["real_sample_count"], 1);
        assert_eq!(mode["component_summary"]["imag_sample_count"], 1);
        assert_eq!(mode["value_kind"], "complex_spatial_vector");
        assert_eq!(mode["component_basis"], "global_xyz");
        assert_eq!(mode["component_count"], 3);
        assert_eq!(mode["components"], serde_json::json!(["x", "y", "z"]));
        assert_eq!(mode["payload_encoding"], "f64_interleaved_real_imag_xyz");
        assert_eq!(mode["binary_layout"], "complex_f64_pairs_little_endian");
        assert_eq!(mode["complex_pair_count"], 3);
        assert_eq!(mode["payload_value_count"], 6);
        assert_eq!(
            mode["available_views"],
            serde_json::json!([
                "complex",
                "real",
                "imag",
                "abs",
                "amplitude",
                "phase",
                "phase_rotated_real"
            ])
        );
        assert_eq!(mode["default_view"], "phase_rotated_real");
        assert_eq!(mode["default_phase_rad"], 0.0);
        assert!(
            mode.get("real").is_none()
                && mode.get("imag").is_none()
                && mode.get("amplitude").is_none()
                && mode.get("phase").is_none(),
            "mode metadata must not inline vector arrays: {mode}"
        );

        assert!(eigen_dir.join("path.json").is_file());
        assert!(eigen_dir.join("branches.json").is_file());
        assert!(eigen_dir.join("branch_table.csv").is_file());
        assert!(eigen_dir.join("modes/sample_0000/mode_0000.json").is_file());
        let nested_mode: Value = serde_json::from_slice(
            &std::fs::read(eigen_dir.join("modes/sample_0000/mode_0000.json"))
                .expect("nested mode artifact should be written"),
        )
        .expect("nested mode artifact should be valid JSON");
        assert_eq!(nested_mode["mode_field_id"], mode["mode_field_id"]);
        assert_eq!(nested_mode["mass_norm"], mode["mass_norm"]);
        assert_eq!(
            nested_mode["mode_field_resource_key"],
            mode["mode_field_resource_key"]
        );
        let mode_field =
            std::fs::read(eigen_dir.join("mode_fields/sample_0000/mode_0000/vector.bin"))
                .expect("mode vector payload should be written");
        assert_eq!(mode_field.len(), 3 * 2 * std::mem::size_of::<f64>());

        let family_manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain eigen manifest should be written"),
        )
        .expect("frequency-domain eigen manifest should be valid JSON");
        assert_eq!(
            family_manifest["schema_version"],
            "frequency_domain_manifest.v1"
        );
        assert_eq!(
            family_manifest["analysis_family"],
            "magnetic_frequency_domain"
        );
        assert_eq!(family_manifest["study_product"], "modal_eigen");
        assert_eq!(family_manifest["stage_kind"], "eigenmodes");
        assert_eq!(
            family_manifest["requested_execution"]["calculation_mode"],
            "free_modes"
        );
        assert_eq!(
            family_manifest["physics"]["analysis_family"],
            "magnetic_frequency_domain"
        );
        assert_eq!(
            family_manifest["physics"]["phase_convention"],
            "exp_minus_i_omega_t"
        );
        assert_eq!(family_manifest["physics"]["frequency_units"], "Hz");
        assert_eq!(
            family_manifest["physics"]["field_units"],
            "dimensionless_delta_m"
        );
        assert_eq!(family_manifest["physics"]["normalization"], "unit_l2");
        assert_eq!(
            family_manifest["artifacts"]["spectrum_v2_path"],
            "eigen/spectrum.v2.json"
        );
        assert_eq!(
            family_manifest["artifacts"]["solver_diagnostics_path"],
            "eigen/diagnostics/solver.v1.json"
        );
        assert!(temp.path.join("eigen/diagnostics/solver.v1.json").is_file());
        assert_eq!(
            family_manifest["artifacts"]["mode_metadata_paths"][0],
            "eigen/modes/sample_0000/mode_0000.json"
        );
        assert_eq!(
            family_manifest["resources"]["mode_field_resources"][0],
            "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/0/0/meta"
        );
        assert_eq!(
            family_manifest["diagnostics"]["tracking_score_source"],
            "seed_only"
        );
        assert_eq!(
            family_manifest["diagnostics"]["modal_overlap_available"],
            false
        );
        assert_eq!(
            family_manifest["capabilities"]["modal_artifact_available"],
            true
        );
    }

    #[test]
    fn eigen_branch_writer_reports_modal_overlap_statistics() {
        let temp = TempDirGuard::new("eigen-branch-overlap-stats");
        let result = sample_result_with_modal_overlap_tracking();

        write_branch_bundle(&temp.path, &result).expect("branch bundle should write");

        let branches: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("eigen/branches.v2.json"))
                .expect("branches.v2.json should be written"),
        )
        .expect("branches.v2.json should be valid JSON");
        assert_eq!(
            branches["diagnostics"]["tracking_score_source"],
            "modal_overlap_weighted_score"
        );
        assert_eq!(branches["diagnostics"]["modal_overlap_available"], true);
        assert_eq!(branches["diagnostics"]["min_overlap"], 0.6);
        assert_eq!(branches["diagnostics"]["median_overlap"], 0.7);
    }

    #[test]
    fn eigen_manifest_marks_production_cpu_shift_invert_as_native_production() {
        let temp = TempDirGuard::new("eigen-artifacts-production-manifest");
        let result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);

        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain eigen manifest should write");

        let family_manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain eigen manifest should be written"),
        )
        .expect("frequency-domain eigen manifest should be valid JSON");

        assert_eq!(
            family_manifest["resolved_execution"]["engine"],
            "multi_k_orchestrator/slepc_multi_shift_invert_production_cpu_dense"
        );
        assert_eq!(
            family_manifest["resolved_execution"]["native_backend"],
            "native_cpu"
        );
        assert_eq!(
            family_manifest["resolved_execution"]["reference_or_production"],
            "production"
        );
        assert_eq!(
            family_manifest["resolved_execution"]["solver_library"],
            "slepc"
        );
        assert_eq!(
            family_manifest["capabilities"]["production_native_solver_available"],
            true
        );
        assert_eq!(
            family_manifest["capabilities"]["validation_artifact"],
            false
        );
    }

    #[test]
    fn eigen_manifest_preserves_native_gpu_execution_and_hardened_provenance() {
        let temp = TempDirGuard::new("eigen-artifacts-native-gpu-provenance");
        let mut result =
            sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
        result.include_demag = true;
        result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "sample_solver_diagnostics": [{
                "diagnostics": {
                    "physics_contract_version": "micromagnetics_frequency_domain_v5",
                    "operator_dictionary_version": "FrequencyOperatorDictionary.v1",
                    "implementation_state": "executable",
                    "validation_state": "unvalidated",
                    "validated_scope": "fem_k0_periodic_airbox_p1_double_gpu_device_krylov",
                    "assembly_kind": "mfem_weak_form_shared_domain",
                    "operator_input_signature_sha256": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                    "production_solver_available": true,
                    "validation_only": false,
                    "boundary_gauge": {
                        "magnetostatic_bc": "periodic_airbox_k0",
                        "outer_boundary_kind": "poisson_robin",
                        "robin_beta": 8.0e6,
                        "robin_beta_unit": "1/m",
                        "gauge_policy": "none",
                        "gauge_reason": "coercive_outer_boundary",
                        "eta_row_present": false
                    },
                    "spectral": {
                        "spectral_transform": "shift_invert",
                        "spectral_scalar_mode": "real_split",
                        "sigma_real_per_s": 0.0,
                        "sigma_imag_rad_per_s": 1.0e10
                    },
                    "phase_constraint_sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "equilibrium_artifact_sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                    "linearization_state_sha256": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                    "periodic_mesh_certificate_sha256": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
                    "phasor_convention": "exp_plus_i_omega_t",
                    "requested_execution": {
                        "device": "gpu",
                        "precision": "double",
                        "execution_mode": "strict",
                        "solver_method": "shift_invert",
                        "preconditioner": "shifted_schur_device",
                        "magnetostatic_bc": "periodic_airbox_k0"
                    },
                    "resolved_execution": {
                        "device": "gpu",
                        "precision": "double",
                        "engine": "gpu_petsc_slepc_cuda",
                        "implementation_id": "k0_poisson_airbox_gpu_petsc_slepc",
                        "status": "ok",
                        "operator_residency": "device",
                        "vector_residency": "device",
                        "krylov_residency": "device",
                        "preconditioner_residency": "device",
                        "solver_library": "SLEPc/PETSc/hypre CUDA",
                        "fallback_used": false,
                        "fallback_reason": null
                    }
                }
            }]
        }));

        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain manifest should write");
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain manifest should be written"),
        )
        .expect("frequency-domain manifest should parse");

        assert_eq!(manifest["requested_execution"]["device"], "gpu");
        assert_eq!(manifest["requested_execution"]["execution_mode"], "strict");
        assert_eq!(
            manifest["requested_execution"]["preconditioner"],
            "shifted_schur_device"
        );
        assert_eq!(manifest["resolved_execution"]["device"], "gpu");
        assert_eq!(
            manifest["resolved_execution"]["engine"],
            "gpu_petsc_slepc_cuda"
        );
        assert_eq!(
            manifest["resolved_execution"]["implementation_id"],
            "k0_poisson_airbox_gpu_petsc_slepc"
        );
        assert_eq!(manifest["resolved_execution"]["krylov_residency"], "device");
        assert_eq!(
            manifest["capabilities"]["production_native_solver_available"],
            true
        );
        assert_eq!(manifest["capabilities"]["validation_artifact"], false);
        assert_eq!(manifest["assembly_kind"], "mfem_weak_form_shared_domain");
        assert_eq!(
            manifest["operator_input_signature_sha256"],
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        );
        assert_eq!(
            manifest["boundary_gauge"]["outer_boundary_kind"],
            "poisson_robin"
        );
        assert_eq!(manifest["spectral"]["spectral_scalar_mode"], "real_split");
        assert_eq!(
            manifest["phase_constraint_sha256"],
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
    }

    #[test]
    fn eigen_artifacts_write_k0_kittel_summary_and_points() {
        let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-summary");
        let result = sample_result_with_k0_kittel_sweep();

        write_path_bundle(&temp.path, &result).expect("path bundle should write");
        write_branch_bundle(&temp.path, &result).expect("branch bundle should write");
        write_mode_bundle(&temp.path, &result).expect("mode bundle should write");
        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain eigen manifest should write");

        let validation_dir = temp.path.join("validation/kittel_k0_pbc");
        let summary: Value = serde_json::from_slice(
            &std::fs::read(validation_dir.join("summary.v1.json"))
                .expect("Kittel k0 summary should be written"),
        )
        .expect("Kittel k0 summary should be valid JSON");
        assert_eq!(
            summary["schema_version"],
            "frequency_domain_kittel_k0_validation.v1"
        );
        assert_eq!(summary["status"], "passed");
        assert_eq!(summary["model"], "macrospin_larmor");
        assert_eq!(summary["sweep_point_count"], 3);
        assert!(
            summary["max_relative_frequency_error"]
                .as_f64()
                .expect("max relative error should be numeric")
                <= 0.05
        );

        let points_csv = std::fs::read_to_string(validation_dir.join("points.v1.csv"))
            .expect("Kittel k0 points CSV should be written");
        let rows = points_csv.lines().collect::<Vec<_>>();
        assert_eq!(rows.len(), 4);
        assert!(rows[0].starts_with("case_id,demag_kind,field_index,H0_A_per_m,mu0_H0_T"));
        assert!(rows[0].contains("relative_frequency_error"));

        let kittel_fit: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("fmr/kittel_fit.v1.json"))
                .expect("typed Kittel fit artifact should be written"),
        )
        .expect("typed Kittel fit artifact should be valid JSON");
        assert_eq!(kittel_fit["schema_version"], "fmr/kittel_fit.v1");
        assert_eq!(kittel_fit["source"]["artifact"], "eigen/spectrum.v2.json");
        assert_eq!(kittel_fit["model"], "macrospin_larmor");
        assert_eq!(kittel_fit["complete"], false);
    }

    #[test]
    fn mode_bundle_preserves_k0_operator_provenance() {
        let temp = TempDirGuard::new("eigen-artifacts-mode-provenance");
        let mut result = sample_result_with_k0_kittel_sweep();
        result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "mesh_id": "mesh:test",
            "assembly_kind": "mfem_weak_form_shared_domain",
            "operator_input_signature_sha256": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            "phase_constraint_sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "equilibrium_artifact_sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "linearization_state_sha256": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "relax_to_eigen_handoff_sha256": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            "source_mesh_topology_sha256": "sha256:9999999999999999999999999999999999999999999999999999999999999999",
            "periodic_mesh_certificate_sha256": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        }));

        write_mode_bundle(&temp.path, &result).expect("mode bundle should write");
        let mode: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("eigen/modes/sample_0000/mode_0000.json"))
                .expect("mode metadata should be written"),
        )
        .expect("mode metadata should parse");

        assert_eq!(
            mode["external_field_a_per_m"],
            serde_json::json!([40_000.0, 0.0, 0.0])
        );
        assert_eq!(mode["assembly_kind"], "mfem_weak_form_shared_domain");
        assert_eq!(
            mode["operator_input_signature_sha256"],
            "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
        );
        assert_eq!(
            mode["linearization_state_sha256"],
            "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        );
        assert_eq!(
            mode["relax_to_eigen_handoff_sha256"],
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        );
        assert_eq!(
            mode["source_mesh_topology_sha256"],
            "sha256:9999999999999999999999999999999999999999999999999999999999999999"
        );
    }

    #[test]
    fn mode_bundle_binds_field_payload_to_immutable_source_mesh_identity() {
        let temp = TempDirGuard::new("eigen-artifacts-mode-source-mesh");
        let mut result = sample_result();
        result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "mesh_id": "mesh:test",
            "mesh_generation_id": "mesh-generation:test",
            "mesh_revision": 17,
            "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }));

        write_mode_bundle(&temp.path, &result).expect("mode bundle should write");
        let mode: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("eigen/modes/sample_0000/mode_0000.json"))
                .expect("mode metadata should be written"),
        )
        .expect("mode metadata should parse");

        assert_eq!(
            mode["source_mesh_identity"],
            serde_json::json!({
                "mesh_id": "mesh:test",
                "mesh_generation_id": "mesh-generation:test",
                "mesh_revision": 17,
                "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "indexing": "full_domain_node_order",
                "node_count": 1,
            })
        );
    }

    #[test]
    fn mode_bundle_rejects_invalid_source_mesh_identity_before_publication() {
        for (slug, diagnostics) in [
            ("missing", serde_json::json!({})),
            (
                "missing-mesh-id",
                serde_json::json!({
                    "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                }),
            ),
            (
                "noncanonical-topology",
                serde_json::json!({
                    "mesh_id": "mesh:test",
                    "topology_fingerprint": "mesh-rev:1",
                }),
            ),
        ] {
            let temp = TempDirGuard::new(&format!("eigen-artifacts-mode-source-mesh-{slug}"));
            let mut result = sample_result();
            result.samples[0].solver_diagnostics = Some(diagnostics);

            let error = write_mode_bundle(&temp.path, &result)
                .expect_err("invalid source mesh identity must block mode-field publication");

            assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
            assert!(error.to_string().contains("source mesh identity"));
            assert!(!temp.path.join("eigen/modes").exists());
            assert!(!temp.path.join("eigen/mode_fields").exists());
        }
    }

    #[test]
    fn k0_kittel_artifacts_reject_periodic_airbox_without_real_metrics() {
        let mut result = sample_result_with_k0_kittel_sweep();
        let validation = result
            .k0_kittel_validation
            .as_mut()
            .expect("fixture should carry K0 Kittel validation");
        validation.case_id = Some("K0-3".to_string());
        validation.demag_kind = Some("periodic_airbox_k0".to_string());
        validation.model = "thin_film_in_plane".to_string();
        validation.material.effective_magnetisation = Some(800_000.0);

        let err = k0_kittel_validation_auxiliary_artifacts(&result)
            .expect_err("periodic_airbox_k0 must require real PA-E4b metrics");

        assert!(
            err.to_string().contains("PA-E4b")
                && err.to_string().contains("production periodic-airbox")
        );
    }

    #[test]
    fn k0_kittel_artifacts_accept_periodic_airbox_with_real_metrics() {
        let mut result = sample_result_with_k0_kittel_sweep();
        let effective_magnetisation = 800_000.0;
        let fields_a_per_m = [40_000.0, 80_000.0, 120_000.0];
        let validation = result
            .k0_kittel_validation
            .as_mut()
            .expect("fixture should carry K0 Kittel validation");
        validation.case_id = Some("K0-3".to_string());
        validation.demag_kind = Some("periodic_airbox_k0".to_string());
        validation.model = "thin_film_in_plane".to_string();
        validation.relative_tolerance = 0.02;
        validation.material.effective_magnetisation = Some(effective_magnetisation);

        for ((sample, branch_point), field_a_per_m) in result
            .samples
            .iter_mut()
            .zip(
                result
                    .branches
                    .get_mut(0)
                    .expect("fixture should have a tracked branch")
                    .points
                    .iter_mut(),
            )
            .zip(fields_a_per_m)
        {
            let frequency_hz = REFERENCE_MODAL_GAMMA0_RAD_S_PER_A_M
                * (field_a_per_m * (field_a_per_m + effective_magnetisation)).sqrt()
                / std::f64::consts::TAU;
            sample.modes[0].frequency_real_hz = frequency_hz;
            sample.modes[0].frequency_imag_hz = 0.0;
            sample.modes[0].angular_frequency_rad_per_s = std::f64::consts::TAU * frequency_hz;
            sample.modes[0].eigenvalue_real = 0.0;
            sample.modes[0].eigenvalue_imag = std::f64::consts::TAU * frequency_hz;
            branch_point.frequency_real_hz = frequency_hz;
            branch_point.frequency_imag_hz = 0.0;
        }
        result.k0_kittel_periodic_airbox_demag = Some(K0KittelPeriodicAirboxDemagMetrics {
            mesh_resolution_m: 5.0e-9,
            airbox_size_m: 80.0e-9,
            phi_dof_count: 8,
            augmented_phi_dof_count: 9,
            poisson_constraint_relative_residual: 1.0e-12,
            magnetic_pair_count: 4,
            airbox_pair_count: 6,
            effective_magnetisation_a_per_m: effective_magnetisation,
            relative_kittel_frequency_error: 0.0,
        });

        let artifacts = k0_kittel_validation_auxiliary_artifacts(&result)
            .expect("periodic_airbox_k0 should accept real PA-E4b metrics");
        assert!(artifacts
            .iter()
            .any(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/points.v1.csv"));
        assert!(artifacts
            .iter()
            .any(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/summary.v1.json"));
        let convergence = artifacts
            .iter()
            .find(|artifact| {
                artifact.relative_path == "validation/kittel_k0_pbc/convergence.v1.csv"
            })
            .expect("periodic_airbox_k0 should emit convergence CSV");
        let convergence_csv =
            std::str::from_utf8(&convergence.bytes).expect("convergence should be UTF-8 CSV");
        assert!(convergence_csv.contains("periodic_airbox_k0"));
        assert!(convergence_csv.contains("poisson_residual_relative"));

        let summary_artifact = artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/summary.v1.json")
            .expect("summary should be emitted");
        let summary: Value =
            serde_json::from_slice(&summary_artifact.bytes).expect("summary should be valid JSON");
        assert_eq!(summary["status"], "passed");
        assert_eq!(summary["case_id"], "K0-3");
        assert_eq!(summary["demag_kind"], "periodic_airbox_k0");
        assert_eq!(summary["demag"]["gauge_policy"], "mean_zero_augmented");
        assert_eq!(summary["demag"]["phi_dof_count"], 8);
        assert_eq!(summary["demag"]["augmented_phi_dof_count"], 9);
        assert_eq!(summary["demag"]["magnetic_pair_count"], 4);
        assert_eq!(summary["demag"]["airbox_pair_count"], 6);
        assert_eq!(summary["demag"]["production_periodic_airbox_claim"], true);
        assert!(
            summary["demag"]["poisson_constraint_relative_residual"]
                .as_f64()
                .expect("poisson residual should be numeric")
                <= 1.0e-8
        );
    }

    #[test]
    fn k0_kittel_selector_prefers_uniform_branch_over_frequency_only_match() {
        let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-uniform-selector");
        let mut result = sample_result_with_k0_kittel_sweep();

        result.branches = vec![
            TrackedBranch {
                branch_id: 0,
                label: Some("nonuniform_frequency_match".to_string()),
                points: Vec::new(),
            },
            TrackedBranch {
                branch_id: 1,
                label: Some("uniform_kittel_mode".to_string()),
                points: Vec::new(),
            },
        ];

        for sample_result in &mut result.samples {
            let expected_frequency = sample_result.modes[0].frequency_real_hz;
            let mut nonuniform = sample_result.modes[0].clone();
            nonuniform.raw_mode_index = 0;
            nonuniform.frequency_real_hz = expected_frequency;
            nonuniform.angular_frequency_rad_per_s = std::f64::consts::TAU * expected_frequency;
            nonuniform.eigenvalue_imag = std::f64::consts::TAU * expected_frequency;
            nonuniform.reduced_vector = Some(vec![
                Complex64::new(1.0, 0.0),
                Complex64::new(-1.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(-1.0, 0.0),
            ]);

            let mut uniform = sample_result.modes[0].clone();
            uniform.raw_mode_index = 1;
            uniform.frequency_real_hz = expected_frequency * 1.001;
            uniform.angular_frequency_rad_per_s = std::f64::consts::TAU * uniform.frequency_real_hz;
            uniform.eigenvalue_imag = std::f64::consts::TAU * uniform.frequency_real_hz;
            uniform.reduced_vector = Some(vec![
                Complex64::new(1.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(1.0, 0.0),
            ]);

            sample_result.modes = vec![nonuniform, uniform];
            let sample_index = sample_result.sample.sample_index;
            result.branches[0].points.push(TrackedBranchPoint {
                sample_index,
                raw_mode_index: 0,
                frequency_real_hz: expected_frequency,
                frequency_imag_hz: 0.0,
                tracking_confidence: 1.0,
                overlap_prev: (sample_index > 0).then_some(1.0),
            });
            result.branches[1].points.push(TrackedBranchPoint {
                sample_index,
                raw_mode_index: 1,
                frequency_real_hz: expected_frequency * 1.001,
                frequency_imag_hz: 0.0,
                tracking_confidence: 1.0,
                overlap_prev: (sample_index > 0).then_some(1.0),
            });
        }

        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain eigen manifest should write");

        let summary: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("validation/kittel_k0_pbc/summary.v1.json"))
                .expect("Kittel k0 summary should be written"),
        )
        .expect("Kittel k0 summary should be valid JSON");
        assert_eq!(summary["selected_branch"]["branch_id"], 1);
        assert!(
            summary["mode_selection"]["minimum_uniformity_score"]
                .as_f64()
                .expect("uniformity score should be numeric")
                > 0.99
        );
    }

    #[test]
    fn k0_kittel_validation_rejects_modes_without_native_vectors() {
        let mut result = sample_result_with_k0_kittel_sweep();
        for sample in &mut result.samples {
            for mode in &mut sample.modes {
                mode.reduced_vector = None;
                mode.lifted_real = None;
                mode.lifted_imag = None;
            }
        }

        let err = k0_kittel_validation_auxiliary_artifacts(&result)
            .expect_err("K0 Kittel validation must not fabricate a uniform mode");
        assert!(err.to_string().contains("no tracked eigen branch"));
    }

    #[test]
    fn k0_kittel_selector_does_not_use_expected_frequency_as_a_tiebreaker() {
        let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-frequency-tiebreaker");
        let mut result = sample_result_with_k0_kittel_sweep();

        result.branches = vec![
            TrackedBranch {
                branch_id: 0,
                label: Some("tracked_branch_zero".to_string()),
                points: Vec::new(),
            },
            TrackedBranch {
                branch_id: 1,
                label: Some("analytical_frequency_match".to_string()),
                points: Vec::new(),
            },
        ];

        for sample_result in &mut result.samples {
            let expected_frequency = sample_result.modes[0].frequency_real_hz;
            let mut branch_zero_mode = sample_result.modes[0].clone();
            branch_zero_mode.raw_mode_index = 0;
            branch_zero_mode.frequency_real_hz = expected_frequency * 1.001;
            branch_zero_mode.angular_frequency_rad_per_s =
                std::f64::consts::TAU * branch_zero_mode.frequency_real_hz;
            branch_zero_mode.eigenvalue_imag = branch_zero_mode.angular_frequency_rad_per_s;
            branch_zero_mode.reduced_vector = Some(vec![
                Complex64::new(1.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(1.0, 0.0),
            ]);

            let mut analytical_match_mode = sample_result.modes[0].clone();
            analytical_match_mode.raw_mode_index = 1;
            analytical_match_mode.frequency_real_hz = expected_frequency;
            analytical_match_mode.angular_frequency_rad_per_s =
                std::f64::consts::TAU * analytical_match_mode.frequency_real_hz;
            analytical_match_mode.eigenvalue_imag =
                analytical_match_mode.angular_frequency_rad_per_s;
            analytical_match_mode.reduced_vector = Some(vec![
                Complex64::new(1.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(1.0, 0.0),
            ]);

            sample_result.modes = vec![branch_zero_mode, analytical_match_mode];
            let sample_index = sample_result.sample.sample_index;
            result.branches[0].points.push(TrackedBranchPoint {
                sample_index,
                raw_mode_index: 0,
                frequency_real_hz: expected_frequency * 1.001,
                frequency_imag_hz: 0.0,
                tracking_confidence: 1.0,
                overlap_prev: (sample_index > 0).then_some(1.0),
            });
            result.branches[1].points.push(TrackedBranchPoint {
                sample_index,
                raw_mode_index: 1,
                frequency_real_hz: expected_frequency,
                frequency_imag_hz: 0.0,
                tracking_confidence: 1.0,
                overlap_prev: (sample_index > 0).then_some(1.0),
            });
        }

        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain eigen manifest should write");

        let summary: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("validation/kittel_k0_pbc/summary.v1.json"))
                .expect("Kittel k0 summary should be written"),
        )
        .expect("Kittel k0 summary should be valid JSON");
        assert_eq!(summary["selected_branch"]["branch_id"], 0);
        assert!(
            summary["max_relative_frequency_error"]
                .as_f64()
                .expect("relative error should be numeric")
                > 0.0009
        );
    }

    #[test]
    fn k0_kittel_selector_uses_mass_weighted_uniformity_when_weights_are_available() {
        let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-mass-weighted-selector");
        let mut result = sample_result_with_k0_kittel_sweep();

        result.branches = vec![
            TrackedBranch {
                branch_id: 0,
                label: Some("unweighted_uniform_only".to_string()),
                points: Vec::new(),
            },
            TrackedBranch {
                branch_id: 1,
                label: Some("mass_weighted_uniform".to_string()),
                points: Vec::new(),
            },
        ];

        for sample_result in &mut result.samples {
            let expected_frequency = sample_result.modes[0].frequency_real_hz;
            let mass_weights = vec![1000.0, 1.0];

            let mut unweighted_uniform = sample_result.modes[0].clone();
            unweighted_uniform.raw_mode_index = 0;
            unweighted_uniform.frequency_real_hz = expected_frequency;
            unweighted_uniform.angular_frequency_rad_per_s =
                std::f64::consts::TAU * expected_frequency;
            unweighted_uniform.eigenvalue_imag = std::f64::consts::TAU * expected_frequency;
            unweighted_uniform.reduced_vector = Some(vec![
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(1.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
            ]);
            unweighted_uniform.node_mass_weights = Some(mass_weights.clone());

            let mut mass_weighted_uniform = sample_result.modes[0].clone();
            mass_weighted_uniform.raw_mode_index = 1;
            mass_weighted_uniform.frequency_real_hz = expected_frequency * 1.001;
            mass_weighted_uniform.angular_frequency_rad_per_s =
                std::f64::consts::TAU * mass_weighted_uniform.frequency_real_hz;
            mass_weighted_uniform.eigenvalue_imag =
                std::f64::consts::TAU * mass_weighted_uniform.frequency_real_hz;
            mass_weighted_uniform.reduced_vector = Some(vec![
                Complex64::new(1.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(-1.0, 0.0),
                Complex64::new(0.0, 0.0),
                Complex64::new(0.0, 0.0),
            ]);
            mass_weighted_uniform.node_mass_weights = Some(mass_weights);

            sample_result.modes = vec![unweighted_uniform, mass_weighted_uniform];
            let sample_index = sample_result.sample.sample_index;
            result.branches[0].points.push(TrackedBranchPoint {
                sample_index,
                raw_mode_index: 0,
                frequency_real_hz: expected_frequency,
                frequency_imag_hz: 0.0,
                tracking_confidence: 1.0,
                overlap_prev: (sample_index > 0).then_some(1.0),
            });
            result.branches[1].points.push(TrackedBranchPoint {
                sample_index,
                raw_mode_index: 1,
                frequency_real_hz: expected_frequency * 1.001,
                frequency_imag_hz: 0.0,
                tracking_confidence: 1.0,
                overlap_prev: (sample_index > 0).then_some(1.0),
            });
        }

        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain eigen manifest should write");

        let summary: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("validation/kittel_k0_pbc/summary.v1.json"))
                .expect("Kittel k0 summary should be written"),
        )
        .expect("Kittel k0 summary should be valid JSON");
        assert_eq!(summary["selected_branch"]["branch_id"], 1);
    }

    #[test]
    fn field_sweep_builder_does_not_fabricate_bias_field_from_kittel_metadata() {
        let result = sample_result_with_k0_kittel_sweep();
        let artifact = build_frequency_domain_field_sweep_artifact(&result)
            .expect("field-sweep builder should validate the source");
        assert!(
            artifact.is_none(),
            "Kittel oracle metadata is not a physical bias-field source"
        );
    }

    #[test]
    fn field_sweep_builder_preserves_sample_and_mode_identity_and_marks_missing_handoff_partial() {
        let mut result =
            sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
        result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "external_field_a_per_m": [40_000.0, 0.0, 0.0],
            "mesh_id": "mesh:test",
            "topology_revision": "mesh-rev:1",
            "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "operator_input_signature_sha256": "sha256:operator",
            "equilibrium_artifact_sha256": "sha256:equilibrium",
            "linearization_state_sha256": "sha256:linearization",
            "status": "completed"
        }));
        let artifact = build_frequency_domain_field_sweep_artifact(&result)
            .expect("field-sweep builder should validate the source")
            .expect("declared physical bias field should produce an artifact");
        assert_eq!(artifact.schema_version, "eigen/field_sweep.v1");
        assert_eq!(artifact.status, ServerArtifactStatus::Complete);
        assert!(artifact.complete);
        assert_eq!(artifact.samples[0].sample_id, "bias-field-sample-0000");
        assert_eq!(
            artifact.samples[0].modes[0].sample_id,
            "bias-field-sample-0000"
        );
        assert_eq!(
            artifact.samples[0].modes[0].mode_id,
            "sample-0000/mode-0000"
        );
        assert_eq!(artifact.samples[0].bias_field_a_per_m, [40_000.0, 0.0, 0.0]);
        assert_eq!(
            artifact.samples[0].modes[0].mode_field_id,
            "analysis:eigen:sample-0000:mode-0000"
        );
        assert_eq!(
            artifact.samples[0]
                .operator_input_signature_sha256
                .as_deref(),
            Some("sha256:operator")
        );
    }

    #[test]
    fn partial_field_sweep_uses_declared_requested_count_and_completed_statuses() {
        let mut result =
            sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
        result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "external_field_a_per_m": [40_000.0, 0.0, 0.0],
            "mesh_id": "mesh:test",
            "topology_revision": "mesh-rev:1",
            "operator_input_signature_sha256": "sha256:operator",
            "equilibrium_artifact_sha256": "sha256:equilibrium",
            "linearization_state_sha256": "sha256:linearization",
            "status": "completed",
            "field_sweep": {
                "requested_sample_count": 3,
                "completed_sample_count": 1
            }
        }));

        let artifact = build_frequency_domain_field_sweep_artifact(&result)
            .expect("partial field-sweep source should validate")
            .expect("physical bias field should produce a typed artifact");

        assert_eq!(artifact.requested_sample_count, 3);
        assert_eq!(artifact.completed_sample_count, 1);
        assert_eq!(artifact.status, ServerArtifactStatus::Partial);
        assert!(!artifact.complete);
    }

    #[test]
    fn field_sweep_writer_binds_to_published_spectrum_and_branches_bytes() {
        let temp = TempDirGuard::new("field-sweep-published-source-digests");
        let mut result =
            sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
        result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "external_field_a_per_m": [40_000.0, 0.0, 0.0],
            "mesh_id": "mesh:test",
            "topology_revision": "mesh-rev:1",
            "topology_fingerprint": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "operator_input_signature_sha256": "sha256:operator",
            "equilibrium_artifact_sha256": "sha256:equilibrium",
            "linearization_state_sha256": "sha256:linearization",
            "status": "completed"
        }));
        write_path_bundle(&temp.path, &result).expect("spectrum should be published first");
        write_branch_bundle(&temp.path, &result).expect("branches should be published first");
        write_mode_bundle(&temp.path, &result).expect("mode metadata should be published first");

        write_frequency_domain_field_sweep_artifact(&temp.path, &result)
            .expect("field sweep should bind published sources");

        let field_sweep: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("eigen/field_sweep.v1.json"))
                .expect("field sweep should be written"),
        )
        .expect("field sweep should be valid JSON");
        let spectrum_revision = sha256_prefixed(
            &std::fs::read(temp.path.join("eigen/spectrum.v2.json"))
                .expect("spectrum bytes should be readable"),
        );
        let branches_revision = sha256_prefixed(
            &std::fs::read(temp.path.join("eigen/branches.v2.json"))
                .expect("branches bytes should be readable"),
        );

        assert_eq!(field_sweep["source"]["revision"], spectrum_revision);
        assert_eq!(field_sweep["source_revision"], spectrum_revision);
        assert_eq!(
            field_sweep["cross_artifact_refs"],
            serde_json::json!([
                {"relation": "source_spectrum", "artifact": "eigen/spectrum.v2.json", "revision": spectrum_revision},
                {"relation": "source_branches", "artifact": "eigen/branches.v2.json", "revision": branches_revision},
            ])
        );
    }

    #[test]
    fn typed_artifact_revision_binds_execution_and_topology() {
        let mut result =
            sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
        result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "external_field_a_per_m": [40_000.0, 0.0, 0.0],
            "mesh_id": "mesh:test",
            "topology_revision": "mesh-rev:1",
            "operator_input_signature_sha256": "sha256:operator",
            "equilibrium_artifact_sha256": "sha256:equilibrium",
            "linearization_state_sha256": "sha256:linearization",
            "status": "completed"
        }));
        let artifact = build_frequency_domain_field_sweep_artifact(&result)
            .expect("field-sweep builder should validate the source")
            .expect("declared physical bias field should produce an artifact");

        assert_eq!(artifact.revision, artifact.content_sha256);
        assert_eq!(artifact.revision, canonical_artifact_digest(&artifact));

        let mut execution_changed = artifact.clone();
        execution_changed.resolved_execution.device = "gpu".to_string();
        assert_ne!(
            artifact.revision,
            canonical_artifact_digest(&execution_changed),
            "execution provenance must be covered by the content revision"
        );

        let mut topology_changed = artifact.clone();
        topology_changed.topology.topology_revision = "mesh-rev:2".to_string();
        assert_ne!(
            artifact.revision,
            canonical_artifact_digest(&topology_changed),
            "topology provenance must be covered by the content revision"
        );
    }

    #[test]
    fn typed_json_writer_replaces_complete_envelope_without_temp_residue() {
        let temp = TempDirGuard::new("typed-json-atomic-writer");
        let path = temp.path.join("fmr/peaks.v1.json");
        write_json_atomic(&path, &serde_json::json!({"revision": "same-length-a"}))
            .expect("first typed artifact publication should succeed");
        write_json_atomic(&path, &serde_json::json!({"revision": "same-length-b"}))
            .expect("replacement typed artifact publication should succeed");

        let value: Value = serde_json::from_slice(
            &std::fs::read(&path).expect("replacement artifact should remain readable"),
        )
        .expect("replacement artifact should remain valid JSON");
        assert_eq!(value["revision"], "same-length-b");
        let temporary_files = std::fs::read_dir(path.parent().expect("parent directory"))
            .expect("typed artifact directory should be readable")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(temporary_files, 0);
    }

    #[test]
    fn fmr_peaks_are_derived_only_from_driven_response_and_carry_revision() {
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_diagonal_element(1, 1, 1.0),
            mass: DMatrix::from_diagonal_element(1, 1, 1.0),
            damping: Some(DMatrix::from_diagonal_element(1, 1, 0.1)),
        };
        let frequencies = [1.0, 2.0, 3.0, 4.0];
        let excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));
        let response = solve_field_driven_block_real_sweep(&template, &frequencies, &excitation)
            .expect("response fixture should solve");
        let source = build_field_driven_response_sweep_artifact(
            &response,
            "test.response",
            "test_solver",
            "gilbert",
            "validation",
        );
        let peaks = build_fmr_peaks_artifact(&source, "sha256:response-source", false)
            .expect("peaks should derive from a valid driven response");
        assert_eq!(peaks.schema_version, "fmr/peaks.v1");
        assert_eq!(peaks.source.kind, FmrPeakSourceKind::DrivenResponse);
        assert_eq!(peaks.source.revision, "sha256:response-source");
        assert_eq!(peaks.units.frequency, "Hz");
        assert_eq!(
            peaks.units.response_amplitude.as_deref(),
            Some("normalized_magnetization")
        );
        assert!(peaks.units.covariance.is_none());
        assert_eq!(peaks.status, ServerArtifactStatus::Complete);
        assert!(!peaks.peaks.is_empty());
        assert!(peaks.peaks.iter().all(|peak| {
            peak.source_artifact == "response/magnetic_response_sweep.v2.json"
                && peak.sample_id.is_none()
                && peak.mode_id.is_none()
                && peak.peak_id == format!("response-peak-{:04}", peak.source_frequency_index)
        }));
    }

    #[test]
    fn fmr_peaks_reject_nonfinite_frequency_source() {
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_diagonal_element(1, 1, 1.0),
            mass: DMatrix::from_diagonal_element(1, 1, 1.0),
            damping: Some(DMatrix::from_diagonal_element(1, 1, 0.1)),
        };
        let response = solve_field_driven_block_real_sweep(
            &template,
            &[1.0, 2.0],
            &DVector::from_element(1, Complex64::new(1.0, 0.0)),
        )
        .expect("response fixture should solve");
        let mut source = build_field_driven_response_sweep_artifact(
            &response,
            "test.response",
            "test_solver",
            "gilbert",
            "validation",
        );
        source.points[0].frequency_hz = f64::NAN;
        let error = build_fmr_peaks_artifact(&source, "sha256:response-source", false)
            .expect_err("non-finite frequency must fail closed");
        assert!(error.to_string().contains("finite non-negative frequency"));
    }

    #[test]
    fn interrupted_response_produces_partial_fmr_artifacts_without_complete_claim() {
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_diagonal_element(1, 1, 1.0),
            mass: DMatrix::from_diagonal_element(1, 1, 1.0),
            damping: Some(DMatrix::from_diagonal_element(1, 1, 0.1)),
        };
        let response = solve_field_driven_block_real_sweep_with_interrupt(
            &template,
            &[1.0, 2.0, 3.0],
            &DVector::from_element(1, Complex64::new(1.0, 0.0)),
            |completed| completed >= 1,
        )
        .expect("response fixture should solve");
        let source = build_field_driven_response_sweep_artifact(
            &response.points,
            "test.response",
            "test_solver",
            "gilbert",
            "validation",
        );
        let peaks = build_fmr_peaks_artifact_with_progress(
            &source,
            "sha256:response-source",
            3,
            response.interrupted,
        )
        .expect("partial response remains a valid derived artifact");
        assert_eq!(peaks.status, ServerArtifactStatus::Interrupted);
        assert!(!peaks.complete);
        assert!(peaks.interrupted);
        assert_eq!(peaks.requested_point_count, 3);
        assert_eq!(peaks.completed_point_count, 1);

        let temp = TempDirGuard::new("response-artifact-interrupted-fmr");
        write_response_sweep_bundle_with_progress(&temp.path, &source, 3, true)
            .expect("interrupted response writer should preserve typed analysis artifacts");
        let written_peaks: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("fmr/peaks.v1.json"))
                .expect("interrupted peaks artifact should be written"),
        )
        .expect("interrupted peaks artifact should be valid JSON");
        let written_fits: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("fmr/resonance_fits.v1.json"))
                .expect("interrupted fits artifact should be written"),
        )
        .expect("interrupted fits artifact should be valid JSON");
        assert_eq!(written_peaks["status"], "interrupted");
        assert_eq!(written_peaks["complete"], false);
        assert_eq!(written_fits["status"], "interrupted");
        assert_eq!(written_fits["complete"], false);
    }

    #[test]
    fn kittel_fit_contains_only_postsolve_comparison_and_digest_bound_source() {
        let result = sample_result_with_k0_kittel_sweep();
        let fit = build_kittel_fit_artifact(&result)
            .expect("Kittel fit artifact should be derivable from a solved oracle fixture")
            .expect("fixture declares a postsolve Kittel oracle");
        assert_eq!(fit.schema_version, "fmr/kittel_fit.v1");
        assert_eq!(fit.model, "macrospin_larmor");
        assert_eq!(fit.units.frequency, "Hz");
        assert_eq!(fit.points.len(), 3);
        assert!(fit
            .points
            .iter()
            .all(|point| point.sample_id.starts_with("bias-field-sample-")));
        assert!(fit
            .points
            .iter()
            .all(|point| point.mode_id == "sample-0000/mode-0000"
                || point.mode_id == "sample-0001/mode-0000"
                || point.mode_id == "sample-0002/mode-0000"));
        assert!(fit.source.revision.starts_with("sha256:"));
        assert!(!fit.source.revision.is_empty());
        assert_eq!(fit.status, ServerArtifactStatus::Partial);
        assert!(!fit.complete);
        assert_eq!(
            fit.stop_reason.as_deref(),
            Some("statistical_fit_covariance_not_available")
        );
    }

    #[test]
    fn eigen_manifest_carries_k0_kittel_validation_contract() {
        let temp = TempDirGuard::new("eigen-artifacts-k0-kittel-validation");
        let result = sample_result_with_k0_kittel_sweep();

        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain eigen manifest should write");

        let manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain eigen manifest should be written"),
        )
        .expect("frequency-domain eigen manifest should be valid JSON");

        assert_eq!(
            manifest["validation"]["k0_kittel_validation"]["kind"],
            "k0_kittel_field_sweep"
        );
        assert_eq!(
            manifest["validation"]["k0_kittel_validation"]["model"],
            "macrospin_larmor"
        );
        assert_eq!(
            manifest["validation"]["k0_kittel_validation"]["field_units"],
            "A_per_m"
        );
        assert_eq!(
            manifest["validation"]["k0_kittel_validation"]["material"]["effective_magnetisation"],
            Value::Null
        );
        assert_eq!(
            manifest["validation"]["k0_kittel_validation"]["samples"]
                .as_array()
                .expect("samples should be an array")
                .len(),
            3
        );
        assert!(manifest["artifacts"]["field_sweep_v1_path"].is_null());
        assert_eq!(
            manifest["artifacts"]["fmr_kittel_fit_v1_path"],
            "fmr/kittel_fit.v1.json"
        );
    }

    #[test]
    fn production_dispersion_with_de_bv_validation_writes_analytic_columns() {
        let temp = TempDirGuard::new("eigen-artifacts-production-de-bv-analytic");
        let mut result =
            sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);
        result.samples[0].sample.k_vector = [1.5e6, 0.0, 0.0];
        result.samples[0].sample.path_s = 1.5e6;
        result.include_demag = true;
        result.dispersion_validation = Some(fullmag_ir::FemEigenDispersionValidationIR {
            kind: "thin_film_de_bv_low_k".to_string(),
            analytic_model: "kalinikos_slab_n0".to_string(),
            film_thickness_m: 20e-9,
            equilibrium_magnetization: [1.0, 0.0, 0.0],
            film_normal: [0.0, 0.0, 1.0],
            frequency_window_hz: fullmag_ir::FemEigenDispersionValidationWindowIR {
                min: 0.0,
                max: 5.0e9,
            },
            max_k_rad_per_m: 3.0e6,
            max_relative_error: 0.10,
            scenarios: vec![fullmag_ir::FemEigenDispersionValidationScenarioIR {
                geometry: "backward_volume".to_string(),
                branch_id: "branch_0".to_string(),
                sample_indices: vec![0],
            }],
        });
        result.dispersion_analytic_reference =
            Some(crate::eigen::types::DispersionAnalyticReferenceContext {
                external_field: [40_000.0, 0.0, 0.0],
                exchange_stiffness: 3.5e-12,
                saturation_magnetisation: 140e3,
                gyromagnetic_ratio: 2.211e5,
            });
        let expected_analytic = kalinikos_slab_n0_frequency_hz(
            vector_norm(result.samples[0].sample.k_vector),
            "backward_volume",
            40_000.0,
            20e-9,
            3.5e-12,
            140e3,
            2.211e5,
        );
        result.samples[0].modes[0].frequency_real_hz = expected_analytic * 1.01;
        result.samples[0].modes[0].angular_frequency_rad_per_s =
            std::f64::consts::TAU * result.samples[0].modes[0].frequency_real_hz;

        write_path_bundle(&temp.path, &result).expect("path bundle should write");
        write_branch_bundle(&temp.path, &result).expect("branch bundle should write");
        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain manifest should write");

        let dispersion = std::fs::read_to_string(temp.path.join("eigen/dispersion.csv"))
            .expect("dispersion.csv should be written");
        let mut lines = dispersion.lines();
        let header: Vec<&str> = lines
            .next()
            .expect("dispersion header should exist")
            .split(',')
            .collect();
        let row: Vec<&str> = lines
            .next()
            .expect("dispersion row should exist")
            .split(',')
            .collect();
        let column = |name: &str| {
            header
                .iter()
                .position(|column| *column == name)
                .expect("dispersion column should exist")
        };
        assert_eq!(row[column("validation_geometry")], "backward_volume");
        let analytic: f64 = row[column("analytic_frequency_hz")]
            .parse()
            .expect("analytic_frequency_hz should parse");
        let relative_error: f64 = row[column("relative_error")]
            .parse()
            .expect("relative_error should parse");
        assert!((analytic - expected_analytic).abs() / expected_analytic < 1.0e-12);
        assert!((relative_error - 0.01).abs() < 1.0e-12);

        let manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain manifest should be written"),
        )
        .expect("frequency-domain manifest should parse");
        assert_eq!(
            manifest["requested_execution"]["include_demag"],
            Value::Bool(true)
        );
        assert_eq!(
            manifest["validation"]["dispersion_frequency_source"],
            "numeric_modal_solver_with_analytic_comparison"
        );
        assert_eq!(
            manifest["validation"]["dynamic_demag_operator_source"],
            "numeric_modal_solver"
        );
        assert!(manifest["validation"]
            .get("dispersion_reference_model")
            .is_none());
    }

    #[test]
    fn de_bv_reference_manifest_names_analytic_frequency_source_not_demag_k() {
        let temp = TempDirGuard::new("eigen-artifacts-de-bv-reference-source");
        let mut result =
            sample_result_with_solver_model(EigenSolverModel::ReferenceThinFilmDeBvKalinikosN0);
        result.include_demag = true;
        result.dispersion_validation = Some(fullmag_ir::FemEigenDispersionValidationIR {
            kind: "thin_film_de_bv_low_k".to_string(),
            analytic_model: "kalinikos_slab_n0".to_string(),
            film_thickness_m: 20e-9,
            equilibrium_magnetization: [1.0, 0.0, 0.0],
            film_normal: [0.0, 0.0, 1.0],
            frequency_window_hz: fullmag_ir::FemEigenDispersionValidationWindowIR {
                min: 0.0,
                max: 5.0e9,
            },
            max_k_rad_per_m: 3.0e6,
            max_relative_error: 0.10,
            scenarios: vec![fullmag_ir::FemEigenDispersionValidationScenarioIR {
                geometry: "backward_volume".to_string(),
                branch_id: "branch_0".to_string(),
                sample_indices: vec![0],
            }],
        });

        write_frequency_domain_eigen_manifest(&temp.path, &result)
            .expect("frequency-domain manifest should write");

        let manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain manifest should be written"),
        )
        .expect("frequency-domain manifest should parse");
        assert_eq!(
            manifest["requested_execution"]["include_demag"],
            Value::Bool(true)
        );
        assert_eq!(
            manifest["validation"]["dispersion_frequency_source"],
            "analytic_reference_model"
        );
        assert_eq!(
            manifest["validation"]["dispersion_reference_model"],
            "kalinikos_slab_n0"
        );
        assert_eq!(
            manifest["validation"]["dynamic_demag_operator_source"],
            "analytic_thin_film_de_bv_reference_not_fem_demag_k"
        );
    }

    #[test]
    fn production_cpu_shift_invert_mode_artifacts_use_production_phasor_contract() {
        let temp = TempDirGuard::new("eigen-artifacts-production-phasor");
        let result = sample_result_with_solver_model(EigenSolverModel::ProductionCpuShiftInvert);

        write_path_bundle(&temp.path, &result).expect("path bundle should write");
        write_mode_bundle(&temp.path, &result).expect("mode bundle should write");

        let eigen_dir = temp.path.join("eigen");
        let spectrum: Value = serde_json::from_slice(
            &std::fs::read(eigen_dir.join("spectrum.v2.json"))
                .expect("spectrum.v2.json should be written"),
        )
        .expect("spectrum.v2.json should be valid JSON");
        assert_eq!(
            spectrum["samples"][0]["modes"][0]["phasor_convention"],
            "exp_i_omega_t"
        );
        assert_eq!(
            spectrum["samples"][0]["modes"][0]["eigenvalue_mapping"],
            "lambda_eq_i_omega"
        );

        let nested_mode: Value = serde_json::from_slice(
            &std::fs::read(eigen_dir.join("modes/sample_0000/mode_0000.json"))
                .expect("nested mode artifact should be written"),
        )
        .expect("nested mode artifact should be valid JSON");
        assert_eq!(nested_mode["phasor_convention"], "exp_i_omega_t");
        assert_eq!(nested_mode["eigenvalue_mapping"], "lambda_eq_i_omega");
    }

    #[test]
    fn response_artifact_writer_emits_v1_contract_file() {
        let temp = TempDirGuard::new("response-artifact-v1");
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_element(1, 1, 4.0),
            mass: DMatrix::from_element(1, 1, 1.0),
            damping: Some(DMatrix::from_element(1, 1, 0.5)),
        };
        let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));
        let sweep = solve_field_driven_block_real_sweep(&template, &[2.0], &field_excitation)
            .expect("field-driven sweep should solve");
        let artifact = build_field_driven_response_sweep_artifact(
            &sweep,
            "runner.dense_block_real",
            "dense_block_real_lu",
            "gilbert_linear",
            "local_validation",
        );

        write_response_sweep_artifact(&temp.path, &artifact)
            .expect("response sweep artifact should write");

        let artifact_path = temp.path.join("response/magnetic_response_sweep.v1.json");
        let value: Value = serde_json::from_slice(
            &std::fs::read(&artifact_path).expect("response artifact should be written"),
        )
        .expect("response artifact should be valid JSON");

        assert_eq!(value["schema_version"], "magnetic_response_sweep.v1");
        assert_eq!(value["backend_engine_id"], "runner.dense_block_real");
        assert_eq!(value["point_count"], 1);
        assert_eq!(value["points"][0]["point_id"], "frequency-point-0000");
        assert_eq!(value["si_units"]["frequency_hz"], "Hz");
        assert_eq!(value["points"][0]["angular_frequency_rad_per_s"], 2.0);
        assert_eq!(
            value["points"][0]["m_complex"][0],
            serde_json::json!([0.0, -1.0])
        );
        assert_eq!(
            value["points"][0]["response_phase"][0],
            -std::f64::consts::FRAC_PI_2
        );
        assert_eq!(
            value["points"][0]["tangent_leakage"]["kind"],
            "not_evaluated_dense_validation",
        );
        assert_eq!(value["points"][0]["excitation_provenance"]["kind"], "field");
        assert_eq!(
            value["points"][0]["excitation_provenance"]["phase_rad"],
            0.0
        );
    }

    #[test]
    fn response_artifact_bundle_emits_partial_progress_files() {
        let temp = TempDirGuard::new("response-artifact-bundle");
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_element(1, 1, 4.0),
            mass: DMatrix::from_element(1, 1, 1.0),
            damping: Some(DMatrix::from_element(1, 1, 0.5)),
        };
        let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));
        let sweep = solve_field_driven_block_real_sweep(&template, &[2.0, 3.0], &field_excitation)
            .expect("field-driven sweep should solve");
        let artifact = build_field_driven_response_sweep_artifact(
            &sweep,
            "runner.dense_block_real",
            "dense_block_real_lu",
            "gilbert_linear",
            "local_validation",
        );

        write_response_sweep_bundle(&temp.path, &artifact)
            .expect("response sweep bundle should write");

        let response_dir = temp.path.join("response");
        let manifest: Value = serde_json::from_slice(
            &std::fs::read(response_dir.join("artifact_manifest.json"))
                .expect("artifact manifest should be written"),
        )
        .expect("artifact manifest should be valid JSON");
        let point: Value = serde_json::from_slice(
            &std::fs::read(response_dir.join("frequency_points/frequency_0001.json"))
                .expect("second frequency point should be written"),
        )
        .expect("frequency point should be valid JSON");

        assert_eq!(
            manifest["schema_version"],
            "frequency_response_artifact_manifest.v1"
        );
        assert_eq!(manifest["frequency_point_count"], 2);
        assert_eq!(
            manifest["frequency_point_artifacts"][1],
            "response/frequency_points/frequency_0001.json"
        );
        assert_eq!(point["schema_version"], "frequency_response_point.v1");
        assert_eq!(point["point_id"], "frequency-point-0001");
        assert_eq!(point["frequency_index"], 1);
        assert_eq!(point["point"]["angular_frequency_rad_per_s"], 3.0);
        assert_eq!(
            point["response_field_payload_path"],
            "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"
        );
        assert_eq!(
            point["field_payload_path"],
            "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"
        );
        assert_eq!(point["storage_format"], "zarr");
        assert_eq!(point["zarr_store_path"], "response/field_payloads.zarr");
        assert_eq!(
            point["compatibility_binary_payload_path"],
            "response/field_payloads/frequency_0001/vector.bin"
        );
        assert_eq!(point["payload_encoding"], "f64_interleaved_real_imag_xyz");
        assert_eq!(point["binary_layout"], "complex_f64_pairs_little_endian");
        assert_eq!(point["value_kind"], "complex_spatial_vector");
        assert_eq!(point["component_basis"], "global_xyz");
        assert_eq!(point["component_count"], 3);
        assert_eq!(point["components"], serde_json::json!(["x", "y", "z"]));
        assert_eq!(point["complex_pair_count"], 3);
        assert_eq!(point["payload_value_count"], 6);
        assert_eq!(point["zarr_shape"], serde_json::json!([1, 3, 2]));
        assert_eq!(point["zarr_chunk_shape"], serde_json::json!([1, 3, 2]));
        assert_eq!(
            point["available_views"],
            serde_json::json!([
                "complex",
                "real",
                "imag",
                "abs",
                "amplitude",
                "phase",
                "phase_rotated_real"
            ])
        );
        assert_eq!(point["default_view"], "phase_rotated_real");
        assert_eq!(point["default_phase_rad"], 0.0);
        let payload = std::fs::read(
            response_dir.join("field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"),
        )
        .expect("response field Zarr payload should be written");
        assert_eq!(payload.len(), 48);
        let zattrs: Value = serde_json::from_slice(
            &std::fs::read(
                response_dir.join("field_payloads.zarr/frequency_0001/vector_xyz_complex/.zattrs"),
            )
            .expect("response field Zarr attrs should be written"),
        )
        .expect("response field Zarr attrs should be valid JSON");
        assert_eq!(zattrs["quantity_id"], "dynamic_response");
        assert_eq!(
            zattrs["axes"],
            serde_json::json!(["spatial_sample", "component", "complex"])
        );
        assert_eq!(
            zattrs["component_order"],
            serde_json::json!(["x", "y", "z"])
        );
        assert_eq!(zattrs["complex_order"], serde_json::json!(["real", "imag"]));
        assert!(response_dir
            .join("field_payloads/frequency_0001/vector.bin")
            .is_file());
        assert!(response_dir
            .join("magnetic_response_sweep.v1.json")
            .is_file());

        let peaks: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("fmr/peaks.v1.json"))
                .expect("typed FMR peaks artifact should be written"),
        )
        .expect("typed FMR peaks artifact should be valid JSON");
        assert_eq!(peaks["schema_version"], "fmr/peaks.v1");
        assert_eq!(
            peaks["source"]["artifact"],
            "response/magnetic_response_sweep.v2.json"
        );
        assert_eq!(peaks["status"], "complete");
        assert_eq!(peaks["complete"], true);

        let fits: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("fmr/resonance_fits.v1.json"))
                .expect("typed resonance fits artifact should be written"),
        )
        .expect("typed resonance fits artifact should be valid JSON");
        assert_eq!(fits["schema_version"], "fmr/resonance_fits.v1");
        assert_eq!(fits["source"]["artifact"], "fmr/peaks.v1.json");
        assert_eq!(fits["complete"], false);
    }

    #[test]
    fn dense_validation_response_entrypoint_solves_and_writes_bundle() {
        let temp = TempDirGuard::new("response-solve-write-bundle");
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_element(1, 1, 4.0),
            mass: DMatrix::from_element(1, 1, 1.0),
            damping: Some(DMatrix::from_element(1, 1, 0.5)),
        };
        let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));

        let artifact = solve_and_write_field_driven_response_sweep_bundle(
            &temp.path,
            &template,
            &[2.0, 3.0],
            &field_excitation,
            "runner.dense_block_real",
            "dense_block_real_lu",
            "gilbert_linear",
            "local_validation",
        )
        .expect("dense validation response entrypoint should solve and write");

        assert_eq!(artifact.schema_version, "magnetic_response_sweep.v1");
        assert_eq!(artifact.point_count, 2);
        assert!(temp
            .path
            .join("response/frequency_points/frequency_0000.json")
            .is_file());
        assert!(temp.path.join("response/artifact_manifest.json").is_file());
        let response_v2: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("response/magnetic_response_sweep.v2.json"))
                .expect("response v2 sweep should be written"),
        )
        .expect("response v2 sweep should be valid JSON");
        assert_eq!(response_v2["schema_version"], "magnetic_response_sweep.v2");
        assert_eq!(response_v2["solve_kind"], "direct_harmonic_response");
        assert_eq!(
            response_v2["source_sweep_artifact"],
            "response/magnetic_response_sweep.v1.json"
        );
        assert_eq!(response_v2["status"], "completed");
        assert_eq!(response_v2["complete"], true);
        assert_eq!(response_v2["completed_frequency_point_count"], 2);
        assert_eq!(response_v2["points"][1]["point_id"], "frequency-point-0001");
        assert_eq!(
            response_v2["frequency_point_artifact_paths"][1],
            "response/frequency_points/frequency_0001.json"
        );
        assert_eq!(
            response_v2["response_field_payload_paths"][1],
            "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"
        );
        assert_eq!(
            response_v2["points"][1]["frequency_point_artifact_path"],
            "response/frequency_points/frequency_0001.json"
        );
        assert_eq!(
            response_v2["points"][1]["response_field_payload_path"],
            "response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0"
        );
        assert_eq!(response_v2["points"][1]["storage_format"], "zarr");
        assert_eq!(
            response_v2["points"][1]["compatibility_binary_payload_path"],
            "response/field_payloads/frequency_0001/vector.bin"
        );
        assert_eq!(
            response_v2["points"][1]["excitation_provenance"]["kind"],
            "field"
        );
        assert_eq!(
            response_v2["points"][1]["excitation_provenance"]["phase_rad"],
            0.0
        );
        assert!(
            response_v2["points"][1]["phase_rad"].is_number(),
            "response v2 point should expose scalar phase for charting"
        );
        let family_manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain manifest should be written"),
        )
        .expect("frequency-domain manifest should be valid JSON");
        assert_eq!(
            family_manifest["artifacts"]["response_sweep_v2_path"],
            "response/magnetic_response_sweep.v2.json"
        );
        assert_eq!(
            family_manifest["artifacts"]["fmr_peaks_v1_path"],
            "fmr/peaks.v1.json"
        );
        assert_eq!(
            family_manifest["artifacts"]["fmr_resonance_fits_v1_path"],
            "fmr/resonance_fits.v1.json"
        );
        assert!(
            family_manifest["artifacts"]["response_map_v1_path"].is_null(),
            "frequency response sweep must not claim a response-map v1 artifact"
        );
        assert!(
            family_manifest["artifacts"]["response_map_v2_path"].is_null(),
            "frequency response sweep must not claim a response-map v2 artifact"
        );
        assert!(
            family_manifest["resources"]["response_map_resource_key"].is_null(),
            "frequency response sweep must not claim a response-map resource"
        );
        assert_eq!(
            family_manifest["requested_execution"]["solver_family"],
            "frequency_response"
        );
        assert_eq!(
            family_manifest["requested_execution"]["solve_equation"],
            "(i omega B - L) q = f"
        );
        assert_eq!(
            family_manifest["resolved_execution"]["solve_kind"],
            "direct_harmonic_response"
        );
        assert_eq!(
            family_manifest["resolved_execution"]["native_backend"],
            "runner_validation"
        );
        assert_eq!(
            family_manifest["resolved_execution"]["reference_or_production"],
            "reference"
        );
        assert_eq!(
            family_manifest["capabilities"]["production_native_solver_available"],
            false
        );
        assert_eq!(family_manifest["capabilities"]["validation_artifact"], true);
        let progress: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("response/progress.v1.json"))
                .expect("response progress should be written"),
        )
        .expect("response progress should be valid JSON");
        assert_eq!(progress["status"], "ready");
        assert_eq!(progress["complete"], true);
        assert_eq!(progress["total_frequency_points"], 2);
        assert_eq!(progress["completed_frequency_points"], 2);
        assert_eq!(progress["written_frequency_point_artifacts"], 2);
        assert_eq!(progress["partial_artifacts_available"], true);
        assert!(progress["progress_json"]
            .as_str()
            .expect("progress_json should be a string")
            .contains("\"state\":\"completed\""));
    }

    #[test]
    fn dense_validation_response_entrypoint_writes_interrupted_partial_bundle() {
        let temp = TempDirGuard::new("response-interrupted-bundle");
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_element(1, 1, 4.0),
            mass: DMatrix::from_element(1, 1, 1.0),
            damping: Some(DMatrix::from_element(1, 1, 0.5)),
        };
        let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));

        let artifact = solve_and_write_field_driven_response_sweep_bundle_with_interrupt(
            &temp.path,
            &template,
            &[2.0, 3.0, 4.0],
            &field_excitation,
            |completed_points| completed_points >= 1,
            "runner.dense_block_real",
            "dense_block_real_lu",
            "gilbert_linear",
            "local_validation",
        )
        .expect("interrupted dense validation response should write partial bundle");

        let manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("response/artifact_manifest.json"))
                .expect("artifact manifest should be written"),
        )
        .expect("artifact manifest should be valid JSON");
        let family_manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain manifest should be written"),
        )
        .expect("frequency-domain manifest should be valid JSON");

        assert_eq!(artifact.point_count, 1);
        assert_eq!(manifest["requested_frequency_point_count"], 3);
        assert_eq!(manifest["completed_frequency_point_count"], 1);
        assert_eq!(manifest["frequency_point_count"], 1);
        assert_eq!(manifest["status"], "interrupted");
        assert_eq!(manifest["complete"], false);
        assert_eq!(manifest["interrupted"], true);
        assert_eq!(manifest["cancellation_reason"], "interrupt_requested");
        assert_eq!(
            family_manifest["schema_version"],
            "frequency_domain_manifest.v1"
        );
        assert_eq!(
            family_manifest["analysis_family"],
            "magnetic_frequency_domain"
        );
        assert_eq!(family_manifest["study_product"], "driven_response");
        assert_eq!(family_manifest["stage_kind"], "frequency_response");
        assert_eq!(family_manifest["diagnostics"]["status"], "interrupted");
        assert_eq!(family_manifest["diagnostics"]["complete"], false);
        assert_eq!(
            family_manifest["artifacts"]["response_sweep_v1_path"],
            "response/magnetic_response_sweep.v1.json"
        );
        assert_eq!(
            family_manifest["artifacts"]["solver_diagnostics_path"],
            "response/diagnostics/solver.v1.json"
        );
        assert_eq!(
            family_manifest["artifacts"]["response_diagnostics_v1_path"],
            "response/diagnostics/solver.v1.json"
        );
        assert_eq!(
            family_manifest["artifacts"]["response_progress_v1_path"],
            "response/progress.v1.json"
        );
        assert_eq!(
            family_manifest["artifacts"]["response_cancel_requested_v1_path"],
            "response/cancel_requested.v1.json"
        );
        assert!(
            family_manifest["artifacts"]["response_map_v1_path"].is_null(),
            "partial response sweep must not claim a response-map v1 artifact"
        );
        assert!(
            family_manifest["artifacts"]["response_map_v2_path"].is_null(),
            "partial response sweep must not claim a response-map v2 artifact"
        );
        assert!(
            family_manifest["resources"]["response_map_resource_key"].is_null(),
            "partial response sweep must not claim a response-map resource"
        );
        assert_eq!(
            family_manifest["resources"]["response_progress_resource_key"],
            "/v2/sessions/current/analysis/frequency-domain/response/progress.v1"
        );
        assert_eq!(
            family_manifest["resources"]["response_cancel_requested_resource_key"],
            "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1"
        );
        assert_eq!(
            family_manifest["resources"]["response_diagnostics_resource_key"],
            "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1"
        );
        let diagnostics: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("response/diagnostics/solver.v1.json"))
                .expect("response diagnostics should be written"),
        )
        .expect("response diagnostics should be valid JSON");
        assert_eq!(
            diagnostics["schema_version"],
            "frequency_domain_response_diagnostics.v1"
        );
        assert_eq!(diagnostics["solve_kind"], "direct_harmonic_response");
        assert_eq!(diagnostics["status"], "interrupted");
        assert_eq!(diagnostics["complete"], false);
        assert_eq!(diagnostics["completed_frequency_point_count"], 1);
        let progress: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("response/progress.v1.json"))
                .expect("response progress should be written"),
        )
        .expect("response progress should be valid JSON");
        assert_eq!(
            progress["schema_version"],
            "frequency_domain_sweep_progress.v1"
        );
        assert_eq!(progress["status"], "interrupted");
        assert_eq!(progress["complete"], false);
        assert_eq!(progress["total_frequency_points"], 3);
        assert_eq!(progress["completed_frequency_points"], 1);
        assert_eq!(progress["written_frequency_point_artifacts"], 1);
        assert_eq!(progress["partial_artifacts_available"], true);
        assert_eq!(
            progress["latest_artifact_manifest_path"],
            "response/artifact_manifest.json"
        );
        let cancel_requested: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("response/cancel_requested.v1.json"))
                .expect("cancel-requested progress should be written"),
        )
        .expect("cancel-requested progress should be valid JSON");
        assert_eq!(
            cancel_requested["schema_version"],
            "frequency_domain_sweep_progress.v1"
        );
        assert_eq!(cancel_requested["status"], "cancel_requested");
        assert_eq!(cancel_requested["complete"], false);
        assert_eq!(cancel_requested["total_frequency_points"], 3);
        assert_eq!(cancel_requested["completed_frequency_points"], 1);
        assert_eq!(cancel_requested["written_frequency_point_artifacts"], 1);
        assert_eq!(cancel_requested["partial_artifacts_available"], true);
        assert!(cancel_requested["progress_json"]
            .as_str()
            .expect("cancel-requested progress_json should be a string")
            .contains("\"state\":\"cancel_requested\""));
        assert!(temp
            .path
            .join("response/frequency_points/frequency_0000.json")
            .is_file());
        assert!(temp
            .path
            .join("response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0")
            .is_file());
        assert!(temp
            .path
            .join("response/field_payloads/frequency_0000/vector.bin")
            .is_file());
        assert!(!temp
            .path
            .join("response/frequency_points/frequency_0001.json")
            .exists());
        assert!(!temp
            .path
            .join("response/field_payloads.zarr/frequency_0001/vector_xyz_complex/0.0.0")
            .exists());
        assert!(!temp
            .path
            .join("response/field_payloads/frequency_0001/vector.bin")
            .exists());
    }

    #[test]
    fn dense_validation_response_entrypoint_writes_pre_first_point_cancel_bundle() {
        let temp = TempDirGuard::new("response-pre-first-point-cancel-bundle");
        let template = BlockRealHarmonicTemplate {
            stiffness: DMatrix::from_element(1, 1, 4.0),
            mass: DMatrix::from_element(1, 1, 1.0),
            damping: Some(DMatrix::from_element(1, 1, 0.5)),
        };
        let field_excitation = DVector::from_element(1, Complex64::new(1.0, 0.0));

        let artifact = solve_and_write_field_driven_response_sweep_bundle_with_interrupt(
            &temp.path,
            &template,
            &[2.0, 3.0, 4.0],
            &field_excitation,
            |completed_points| completed_points == 0,
            "runner.dense_block_real",
            "dense_block_real_lu",
            "gilbert_linear",
            "local_validation",
        )
        .expect("pre-first-point cancellation should write an interrupted bundle");

        let manifest: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("response/artifact_manifest.json"))
                .expect("artifact manifest should be written"),
        )
        .expect("artifact manifest should be valid JSON");
        let progress: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("response/progress.v1.json"))
                .expect("response progress should be written"),
        )
        .expect("response progress should be valid JSON");
        let cancel_requested: Value = serde_json::from_slice(
            &std::fs::read(temp.path.join("response/cancel_requested.v1.json"))
                .expect("cancel-requested progress should be written"),
        )
        .expect("cancel-requested progress should be valid JSON");

        assert_eq!(artifact.point_count, 0);
        assert_eq!(manifest["requested_frequency_point_count"], 3);
        assert_eq!(manifest["completed_frequency_point_count"], 0);
        assert_eq!(manifest["frequency_point_count"], 0);
        assert_eq!(manifest["status"], "interrupted");
        assert_eq!(manifest["complete"], false);
        assert_eq!(manifest["interrupted"], true);
        assert_eq!(progress["status"], "interrupted");
        assert_eq!(progress["completed_frequency_points"], 0);
        assert_eq!(progress["written_frequency_point_artifacts"], 0);
        assert_eq!(progress["partial_artifacts_available"], false);
        assert!(progress["progress_json"]
            .as_str()
            .expect("progress_json should be a string")
            .contains("\"partial_artifacts_available\":false"));
        assert_eq!(cancel_requested["status"], "cancel_requested");
        assert_eq!(cancel_requested["completed_frequency_points"], 0);
        assert_eq!(cancel_requested["written_frequency_point_artifacts"], 0);
        assert_eq!(cancel_requested["partial_artifacts_available"], false);
        assert!(cancel_requested["progress_json"]
            .as_str()
            .expect("cancel-requested progress_json should be a string")
            .contains("\"partial_artifacts_available\":false"));
        assert!(!temp
            .path
            .join("response/frequency_points/frequency_0000.json")
            .exists());
        assert!(!temp
            .path
            .join("response/field_payloads/frequency_0000/vector.bin")
            .exists());
        assert!(!temp
            .path
            .join("response/field_payloads.zarr/frequency_0000/vector_xyz_complex/0.0.0")
            .exists());
    }
}
