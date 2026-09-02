use super::common::*;
use crate::eigen::response_block_real::{
    FieldDrivenResponseSweepArtifact, ResponseExcitationProvenanceArtifact,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Error, ErrorKind};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

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

struct ResponseProgressSnapshot {
    total_frequency_points: u64,
    completed_frequency_points: u64,
    written_frequency_point_artifacts: u64,
    partial_artifacts_available: bool,
    latest_artifact_manifest_path: String,
    progress_json: String,
}

impl ResponseProgressSnapshot {
    fn new(
        state: &'static str,
        status: &'static str,
        complete: bool,
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        latest_artifact_manifest_path: &str,
    ) -> Self {
        let partial_artifacts_available =
            completed_frequency_points > 0 || written_frequency_point_artifacts > 0;
        let progress_json = serde_json::json!({
            "schema_version": "frequency_domain_sweep_progress.v1",
            "state": state,
            "status": status,
            "complete": complete,
            "total_frequency_points": total_frequency_points,
            "completed_frequency_points": completed_frequency_points,
            "written_frequency_point_artifacts": written_frequency_point_artifacts,
            "current_frequency_hz": current_frequency_hz,
            "partial_artifacts_available": partial_artifacts_available,
            "latest_artifact_manifest_path": latest_artifact_manifest_path,
        })
        .to_string();
        Self {
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            partial_artifacts_available,
            latest_artifact_manifest_path: latest_artifact_manifest_path.to_string(),
            progress_json,
        }
    }

    fn interrupted(
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        latest_artifact_manifest_path: &str,
    ) -> Self {
        Self::new(
            "interrupted",
            "interrupted",
            false,
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            latest_artifact_manifest_path,
        )
    }

    fn completed(
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        latest_artifact_manifest_path: &str,
    ) -> Self {
        Self::new(
            "completed",
            "ready",
            true,
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            latest_artifact_manifest_path,
        )
    }

    fn cancelling(
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        latest_artifact_manifest_path: &str,
    ) -> Self {
        Self::new(
            "cancel_requested",
            "cancel_requested",
            false,
            total_frequency_points,
            completed_frequency_points,
            written_frequency_point_artifacts,
            current_frequency_hz,
            latest_artifact_manifest_path,
        )
    }
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
        topology_fingerprint: None,
        mesh_generation_id: None,
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
        ResponseProgressSnapshot::interrupted(
            requested_frequency_point_count as u64,
            artifact.points.len() as u64,
            artifact.points.len() as u64,
            current_frequency_hz.unwrap_or(0.0),
            "response/artifact_manifest.json",
        )
    } else {
        ResponseProgressSnapshot::completed(
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
    let progress = ResponseProgressSnapshot::cancelling(
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
        fem_eigen_execution_resolution: None,
        native_execution_attestation: None,
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
