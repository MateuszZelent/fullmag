use crate::eigen::response_block_real::{
    build_field_driven_response_sweep_artifact, solve_field_driven_block_real_sweep,
    solve_field_driven_block_real_sweep_with_interrupt, BlockRealHarmonicTemplate,
    FieldDrivenResponseSweepArtifact, ResponseExcitationProvenanceArtifact,
};
use crate::eigen::types::{PathSolveResult, SingleKModeResult, SingleKSolveResult};
use crate::native_fem::FrequencyDomainSweepProgress;
use nalgebra::DVector;
use num_complex::Complex64;
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
struct ModeSummaryArtifact {
    raw_mode_index: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_id: Option<usize>,
    mode_field_id: String,
    mode_field_resource_key: String,
    frequency_real_hz: f64,
    frequency_imag_hz: f64,
    angular_frequency_rad_per_s: f64,
    eigenvalue_real: f64,
    eigenvalue_imag: f64,
    norm: f64,
    max_amplitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_norm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_linf: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_mean_abs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_max_abs: Option<f64>,
    dominant_polarization: String,
    k_vector: [f64; 3],
}

#[derive(Debug, Clone, Serialize)]
struct SampleArtifact {
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
    frequency_real_hz: f64,
    frequency_imag_hz: f64,
    tracking_confidence: f64,
    overlap_prev: Option<f64>,
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
    branches: Vec<BranchArtifact>,
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
    normalization: &'static str,
    damping_policy: &'static str,
    mode_field_id: String,
    mode_field_resource_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_norm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    residual_linf: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_mean_abs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tangent_leakage_max_abs: Option<f64>,
    dominant_polarization: String,
    k_vector: [f64; 3],
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
    resolved_execution: FrequencyDomainResolvedExecution<'a>,
    physics: FrequencyDomainPhysics<'a>,
    artifacts: FrequencyDomainArtifactIndex,
    resources: FrequencyDomainResourceIndex,
    diagnostics: FrequencyDomainDiagnostics,
    capabilities: FrequencyDomainCapabilitySnapshot,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainRequestedExecution<'a> {
    calculation_mode: &'static str,
    backend: &'static str,
    device: &'static str,
    precision: &'static str,
    execution_mode: &'static str,
    ui_mode: &'static str,
    operator: &'a str,
    solver_family: &'static str,
    solve_equation: &'static str,
    include_demag: bool,
    damping_policy: &'a str,
    equilibrium_source: &'static str,
    k_sampling: &'static str,
    outputs: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainResolvedExecution<'a> {
    backend: &'static str,
    device: &'static str,
    precision: &'static str,
    engine: &'a str,
    native_backend: &'static str,
    reference_or_production: &'static str,
    container_image: Option<&'static str>,
    build_features: Vec<&'static str>,
    demag_realization: &'static str,
    solver_library: &'a str,
    solver_algorithm: &'a str,
    solve_kind: &'static str,
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainPhysics<'a> {
    analysis_family: &'static str,
    llg_gamma0_si: Option<f64>,
    llg_alpha: Option<f64>,
    phase_convention: &'static str,
    frequency_units: &'static str,
    field_units: &'static str,
    normalization: &'static str,
    spin_wave_bc: &'static str,
    periodic_or_floquet: &'static str,
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
}

#[derive(Debug, Clone, Serialize)]
struct FrequencyDomainCapabilitySnapshot {
    driven_response_artifact_available: bool,
    modal_artifact_available: bool,
    production_native_solver_available: bool,
    validation_artifact: bool,
}

#[derive(Debug, Clone, Serialize)]
struct ResponseFrequencyPointArtifact<'a> {
    schema_version: &'static str,
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

fn summarize_mode(sample: &SingleKSolveResult, mode: &SingleKModeResult) -> ModeSummaryArtifact {
    let mode_field_id = eigen_mode_field_id(sample.sample.sample_index, mode.raw_mode_index);
    let mode_field_resource_key = eigen_mode_field_resource_key(&mode_field_id);
    ModeSummaryArtifact {
        raw_mode_index: mode.raw_mode_index,
        branch_id: mode.branch_id,
        mode_field_id,
        mode_field_resource_key,
        frequency_real_hz: mode.frequency_real_hz,
        frequency_imag_hz: mode.frequency_imag_hz,
        angular_frequency_rad_per_s: mode.angular_frequency_rad_per_s,
        eigenvalue_real: mode.eigenvalue_real,
        eigenvalue_imag: mode.eigenvalue_imag,
        norm: mode.norm,
        max_amplitude: mode.max_amplitude,
        residual_norm: mode.residual_norm,
        residual_linf: mode.residual_linf,
        tangent_leakage_mean_abs: mode.tangent_leakage_mean_abs,
        tangent_leakage_max_abs: mode.tangent_leakage_max_abs,
        dominant_polarization: mode.dominant_polarization.clone(),
        k_vector: sample.sample.k_vector,
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
        return Ok(());
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
            device: "cpu",
            precision: "double",
            execution_mode: "extended",
            ui_mode: "auto",
            operator: "linearized_llg",
            solver_family: "frequency_response",
            solve_equation: "(i omega B - L) q = f",
            include_demag: false,
            damping_policy: artifact.damping_policy.as_str(),
            equilibrium_source: "provided_or_planned",
            k_sampling: "single",
            outputs: vec!["susceptibility_tensor"],
        },
        resolved_execution: FrequencyDomainResolvedExecution {
            backend: "fem",
            device: "cpu",
            precision: "double",
            engine: artifact.backend_engine_id.as_str(),
            native_backend: "runner_validation",
            reference_or_production: "reference",
            container_image: None,
            build_features: Vec::new(),
            demag_realization: "none_or_validation_contract",
            solver_library: "nalgebra",
            solver_algorithm: artifact.solver_model.as_str(),
            solve_kind: "direct_harmonic_response",
        },
        physics: FrequencyDomainPhysics {
            analysis_family: "magnetic_frequency_domain",
            llg_gamma0_si: None,
            llg_alpha: None,
            phase_convention: "exp_minus_i_omega_t",
            frequency_units: "Hz",
            field_units: "A/m",
            normalization: "unit_l2",
            spin_wave_bc: "planned",
            periodic_or_floquet: "none",
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
        diagnostics: FrequencyDomainDiagnostics {
            status,
            complete,
            requested_frequency_point_count,
            completed_frequency_point_count: artifact.points.len(),
            written_frequency_point_artifacts: artifact.points.len(),
            interrupted,
        },
        capabilities: FrequencyDomainCapabilitySnapshot {
            driven_response_artifact_available: true,
            modal_artifact_available: false,
            production_native_solver_available: false,
            validation_artifact: true,
        },
    };
    fs::write(
        manifest_dir.join("manifest.v1.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )?;
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
    let calculation_mode = eigen_calculation_mode(result);
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
        requested_execution: FrequencyDomainRequestedExecution {
            calculation_mode,
            backend: "fem",
            device: "cpu",
            precision: "double",
            execution_mode: "extended",
            ui_mode: "auto",
            operator: "linearized_llg",
            solver_family: "modal_eigen",
            solve_equation: "L q = omega M q",
            include_demag: false,
            damping_policy: "ignore",
            equilibrium_source: "provided_or_planned",
            k_sampling: if sample_count > 1 { "path" } else { "single" },
            outputs: vec!["spectrum", "branches", "dispersion", "mode_fields"],
        },
        resolved_execution: FrequencyDomainResolvedExecution {
            backend: "fem",
            device: "cpu",
            precision: "double",
            engine: "runner.reference_eigen",
            native_backend: "runner_validation",
            reference_or_production: "reference",
            container_image: None,
            build_features: Vec::new(),
            demag_realization: "none_or_validation_contract",
            solver_library: "nalgebra",
            solver_algorithm: result.solver_model.as_str(),
            solve_kind: "modal_eigen",
        },
        physics: FrequencyDomainPhysics {
            analysis_family: "magnetic_frequency_domain",
            llg_gamma0_si: None,
            llg_alpha: None,
            phase_convention: "exp_minus_i_omega_t",
            frequency_units: "Hz",
            field_units: "dimensionless_delta_m",
            normalization: "unit_l2",
            spin_wave_bc: "planned",
            periodic_or_floquet: if calculation_mode == "dispersion_modal" {
                "bloch_or_path_sampling"
            } else {
                "none"
            },
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
        diagnostics: FrequencyDomainDiagnostics {
            status: "ready",
            complete: true,
            requested_frequency_point_count: sample_count,
            completed_frequency_point_count: sample_count,
            written_frequency_point_artifacts: 0,
            interrupted: false,
        },
        capabilities: FrequencyDomainCapabilitySnapshot {
            driven_response_artifact_available: false,
            modal_artifact_available: true,
            production_native_solver_available: false,
            validation_artifact: true,
        },
    };
    fs::write(
        manifest_dir.join("manifest.v1.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )?;
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
            sample_index: sample.sample.sample_index,
            label: sample.sample.label.clone(),
            k_vector: sample.sample.k_vector,
            path_s: sample.sample.path_s,
            segment_index: sample.sample.segment_index,
            t_in_segment: sample.sample.t_in_segment,
            modes: sample
                .modes
                .iter()
                .map(|mode| summarize_mode(sample, mode))
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
                .map(|point| BranchPointArtifact {
                    sample_index: point.sample_index,
                    raw_mode_index: point.raw_mode_index,
                    frequency_real_hz: point.frequency_real_hz,
                    frequency_imag_hz: point.frequency_imag_hz,
                    tracking_confidence: point.tracking_confidence,
                    overlap_prev: point.overlap_prev,
                })
                .collect(),
        })
        .collect();
    let branches_v2 = BranchesArtifact {
        schema_version: "eigen_branches.v2",
        solver_model: result.solver_model.as_str().to_string(),
        branches: branches.clone(),
    };
    fs::write(
        eigen_dir.join("branches.v2.json"),
        serde_json::to_vec_pretty(&branches_v2).unwrap(),
    )?;
    let payload = BranchesArtifact {
        schema_version: "2",
        solver_model: result.solver_model.as_str().to_string(),
        branches,
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
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score"
    )?;
    for sample in &result.samples {
        let k = sample.sample.k_vector;
        let label = sample.sample.label.clone().unwrap_or_default();
        for mode in &sample.modes {
            writeln!(
                &mut dispersion,
                "{},{:.16e},{:.16e},{:.16e},{:.16e},{},{},{},{:.16e},{:.16e},{},{},{}",
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
                "",
                mode.residual_norm
                    .map(|value| format!("{value:.16e}"))
                    .unwrap_or_default(),
                resolve_overlap_score(result, sample.sample.sample_index, mode),
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

pub fn write_mode_bundle(base_dir: &Path, result: &PathSolveResult) -> std::io::Result<()> {
    let eigen_dir = base_dir.join("eigen").join("modes");
    for sample in &result.samples {
        let sample_dir = eigen_dir.join(format!("sample_{:04}", sample.sample.sample_index));
        fs::create_dir_all(&sample_dir)?;
        for mode in &sample.modes {
            let real = mode.lifted_real.as_deref().unwrap_or(&[]);
            let imag = mode.lifted_imag.as_deref().unwrap_or(&[]);
            let amplitude = mode.amplitude.as_deref().unwrap_or(&[]);
            let mode_field_id =
                eigen_mode_field_id(sample.sample.sample_index, mode.raw_mode_index);
            let mode_field_resource_key = eigen_mode_field_resource_key(&mode_field_id);
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
                normalization: "unit_l2",
                damping_policy: "ignore",
                mode_field_id,
                mode_field_resource_key,
                residual_norm: mode.residual_norm,
                residual_linf: mode.residual_linf,
                tangent_leakage_mean_abs: mode.tangent_leakage_mean_abs,
                tangent_leakage_max_abs: mode.tangent_leakage_max_abs,
                dominant_polarization: mode.dominant_polarization.clone(),
                k_vector: sample.sample.k_vector,
                value_kind: "complex_spatial_vector",
                component_basis: "global_xyz",
                component_count: 3,
                components: ["x", "y", "z"],
                payload_encoding: "f64_interleaved_real_imag_xyz",
                binary_layout: "complex_f64_pairs_little_endian",
                complex_pair_count: real.len().max(imag.len()) * 3,
                payload_value_count: real.len().max(imag.len()) * 6,
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
                mode_field_sample_count: real.len().max(imag.len()),
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
                &format!(
                    "eigen/mode_fields/sample_{:04}/mode_{:04}/vector.bin",
                    sample.sample.sample_index, mode.raw_mode_index
                ),
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
                }],
                relaxation_steps: 0,
                solver_model: EigenSolverModel::ReferenceScalarTangent,
                solver_notes: vec!["test fixture".to_string()],
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
            solver_model: EigenSolverModel::ReferenceScalarTangent,
            notes: vec!["single sample".to_string()],
        }
    }

    #[test]
    fn eigen_artifact_writer_emits_v2_contract_files() {
        let temp = TempDirGuard::new("eigen-artifacts-v2");
        let result = sample_result();

        write_path_bundle(&temp.path, &result).expect("path bundle should write");
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

        let dispersion = std::fs::read_to_string(eigen_dir.join("dispersion.csv"))
            .expect("dispersion.csv should be written");
        let mut dispersion_lines = dispersion.lines();
        assert_eq!(
            dispersion_lines.next(),
            Some(
                "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score"
            )
        );
        let dispersion_row = dispersion_lines
            .next()
            .expect("dispersion.csv should include a mode row");
        assert!(
            dispersion_row
                .split(',')
                .nth(11)
                .is_some_and(|value| !value.is_empty()),
            "dispersion.csv residual_norm column should be populated, row={dispersion_row}"
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
            family_manifest["capabilities"]["modal_artifact_available"],
            true
        );
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
