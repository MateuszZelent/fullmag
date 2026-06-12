//! Frequency-domain analysis family manifest and artifact resource endpoints.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::artifacts::{
    read_json_artifact_value, read_text_artifact_value, require_current_live_artifact_dir,
    try_resolve_artifact_path,
};
use crate::error::ApiError;
use crate::types::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainAvailabilitySummaryResource {
    pub status: String,
    pub study_kind: String,
    pub driven_response_available: bool,
    pub modal_solver_available: bool,
    pub floquet_modal_available: bool,
    pub floquet_response_available: bool,
    pub dynamic_demag_k_available: bool,
    pub gpu_available: bool,
    pub reason: String,
    pub diagnostics_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainCapabilityEntryResource {
    pub status: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainModalCapabilitiesResource {
    pub reference_cpu: FrequencyDomainCapabilityEntryResource,
    pub production_cpu: FrequencyDomainCapabilityEntryResource,
    pub production_gpu: FrequencyDomainCapabilityEntryResource,
    pub k_path: FrequencyDomainCapabilityEntryResource,
    pub mode_tracking: FrequencyDomainCapabilityEntryResource,
    pub mode_field_payload: FrequencyDomainCapabilityEntryResource,
    pub linewidths: FrequencyDomainCapabilityEntryResource,
    pub absorption_from_modes: FrequencyDomainCapabilityEntryResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainBoundaryCapabilitiesResource {
    pub static_periodic: FrequencyDomainCapabilityEntryResource,
    pub floquet_modal: FrequencyDomainCapabilityEntryResource,
    pub floquet_response: FrequencyDomainCapabilityEntryResource,
    pub periodic_pair_diagnostics: FrequencyDomainCapabilityEntryResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainDemagCapabilitiesResource {
    pub static_periodic_pbc: FrequencyDomainCapabilityEntryResource,
    pub floquet_dynamic_k: FrequencyDomainCapabilityEntryResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainDispersionCapabilitiesResource {
    pub k_path: FrequencyDomainCapabilityEntryResource,
    pub branch_tracking: FrequencyDomainCapabilityEntryResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainValidationCapabilitiesResource {
    pub fmr_k0: FrequencyDomainCapabilityEntryResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainResponseCapabilitiesResource {
    pub magnetic_cpu: FrequencyDomainCapabilityEntryResource,
    pub magnetic_gpu: FrequencyDomainCapabilityEntryResource,
    pub frequency_sweep: FrequencyDomainCapabilityEntryResource,
    pub mode_projected: FrequencyDomainCapabilityEntryResource,
    pub magnetoelastic_quasistatic: FrequencyDomainCapabilityEntryResource,
    pub magnetoelastic_elastodynamic: FrequencyDomainCapabilityEntryResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainVisualizationCapabilitiesResource {
    pub modal_spectrum_chart: FrequencyDomainCapabilityEntryResource,
    pub modal_dispersion_chart: FrequencyDomainCapabilityEntryResource,
    pub mode_table: FrequencyDomainCapabilityEntryResource,
    pub mode_3d_overlay: FrequencyDomainCapabilityEntryResource,
    pub response_sweep_chart: FrequencyDomainCapabilityEntryResource,
    pub response_field_3d_overlay: FrequencyDomainCapabilityEntryResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainCapabilitySnapshotResource {
    pub schema_version: String,
    pub modal: FrequencyDomainModalCapabilitiesResource,
    pub boundary: FrequencyDomainBoundaryCapabilitiesResource,
    pub demag: FrequencyDomainDemagCapabilitiesResource,
    pub dispersion: FrequencyDomainDispersionCapabilitiesResource,
    pub validation: FrequencyDomainValidationCapabilitiesResource,
    pub response: FrequencyDomainResponseCapabilitiesResource,
    pub visualization: FrequencyDomainVisualizationCapabilitiesResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainManifestResource {
    pub schema_version: String,
    pub existing_frequency_response_namespace_preserved: bool,
    pub family_namespace: String,
    pub eigen_namespace: String,
    pub response: FrequencyDomainAvailabilitySummaryResource,
    pub eigenmodes: FrequencyDomainAvailabilitySummaryResource,
    pub floquet_nonzero_k_demag_supported: bool,
    pub capabilities: FrequencyDomainCapabilitySnapshotResource,
    pub response_progress: Option<FrequencyDomainSweepProgressResource>,
    pub response_cancel_requested: Option<FrequencyDomainSweepProgressResource>,
    pub result_manifest: Option<FrequencyDomainJsonArtifactResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainJsonArtifactResource {
    pub schema_version: String,
    pub status: String,
    pub artifact_path: String,
    pub resource_key: String,
    pub payload: Option<Value>,
    pub missing_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainTextArtifactResource {
    pub schema_version: String,
    pub status: String,
    pub artifact_path: String,
    pub resource_key: String,
    pub content_type: String,
    pub text: Option<String>,
    pub missing_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldResource {
    pub schema_version: String,
    pub status: String,
    pub field_id: String,
    pub artifact_path: String,
    pub resource_key: String,
    pub source_family: String,
    pub quantity: String,
    pub value_kind: String,
    pub components: Vec<String>,
    pub available_views: Vec<String>,
    pub default_view: String,
    pub default_phase_rad: Option<f64>,
    pub missing_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainSweepProgressResource {
    pub schema_version: String,
    pub status: String,
    pub complete: bool,
    pub total_frequency_points: u64,
    pub completed_frequency_points: u64,
    pub written_frequency_point_artifacts: u64,
    pub current_frequency_hz: Option<f64>,
    pub partial_artifacts_available: bool,
    pub latest_artifact_manifest_path: Option<String>,
    pub missing_reason: Option<String>,
    pub progress_json: Option<String>,
}

impl From<fullmag_runner::FrequencyDomainAvailabilitySummary>
    for FrequencyDomainAvailabilitySummaryResource
{
    fn from(value: fullmag_runner::FrequencyDomainAvailabilitySummary) -> Self {
        Self {
            status: value.status,
            study_kind: value.study_kind,
            driven_response_available: value.driven_response_available,
            modal_solver_available: value.modal_solver_available,
            floquet_modal_available: value.floquet_modal_available,
            floquet_response_available: value.floquet_response_available,
            dynamic_demag_k_available: value.dynamic_demag_k_available,
            gpu_available: value.gpu_available,
            reason: value.reason,
            diagnostics_json: value.diagnostics_json,
        }
    }
}

impl From<fullmag_runner::FrequencyDomainCapabilityEntry>
    for FrequencyDomainCapabilityEntryResource
{
    fn from(value: fullmag_runner::FrequencyDomainCapabilityEntry) -> Self {
        Self {
            status: value.status,
            reason: value.reason,
        }
    }
}

impl From<fullmag_runner::FrequencyDomainModalCapabilities>
    for FrequencyDomainModalCapabilitiesResource
{
    fn from(value: fullmag_runner::FrequencyDomainModalCapabilities) -> Self {
        Self {
            reference_cpu: value.reference_cpu.into(),
            production_cpu: value.production_cpu.into(),
            production_gpu: value.production_gpu.into(),
            k_path: value.k_path.into(),
            mode_tracking: value.mode_tracking.into(),
            mode_field_payload: value.mode_field_payload.into(),
            linewidths: value.linewidths.into(),
            absorption_from_modes: value.absorption_from_modes.into(),
        }
    }
}

impl From<fullmag_runner::FrequencyDomainBoundaryCapabilities>
    for FrequencyDomainBoundaryCapabilitiesResource
{
    fn from(value: fullmag_runner::FrequencyDomainBoundaryCapabilities) -> Self {
        Self {
            static_periodic: value.static_periodic.into(),
            floquet_modal: value.floquet_modal.into(),
            floquet_response: value.floquet_response.into(),
            periodic_pair_diagnostics: value.periodic_pair_diagnostics.into(),
        }
    }
}

impl From<fullmag_runner::FrequencyDomainDemagCapabilities>
    for FrequencyDomainDemagCapabilitiesResource
{
    fn from(value: fullmag_runner::FrequencyDomainDemagCapabilities) -> Self {
        Self {
            static_periodic_pbc: value.static_periodic_pbc.into(),
            floquet_dynamic_k: value.floquet_dynamic_k.into(),
        }
    }
}

impl From<fullmag_runner::FrequencyDomainDispersionCapabilities>
    for FrequencyDomainDispersionCapabilitiesResource
{
    fn from(value: fullmag_runner::FrequencyDomainDispersionCapabilities) -> Self {
        Self {
            k_path: value.k_path.into(),
            branch_tracking: value.branch_tracking.into(),
        }
    }
}

impl From<fullmag_runner::FrequencyDomainValidationCapabilities>
    for FrequencyDomainValidationCapabilitiesResource
{
    fn from(value: fullmag_runner::FrequencyDomainValidationCapabilities) -> Self {
        Self {
            fmr_k0: value.fmr_k0.into(),
        }
    }
}

impl From<fullmag_runner::FrequencyDomainResponseCapabilities>
    for FrequencyDomainResponseCapabilitiesResource
{
    fn from(value: fullmag_runner::FrequencyDomainResponseCapabilities) -> Self {
        Self {
            magnetic_cpu: value.magnetic_cpu.into(),
            magnetic_gpu: value.magnetic_gpu.into(),
            frequency_sweep: value.frequency_sweep.into(),
            mode_projected: value.mode_projected.into(),
            magnetoelastic_quasistatic: value.magnetoelastic_quasistatic.into(),
            magnetoelastic_elastodynamic: value.magnetoelastic_elastodynamic.into(),
        }
    }
}

impl From<fullmag_runner::FrequencyDomainVisualizationCapabilities>
    for FrequencyDomainVisualizationCapabilitiesResource
{
    fn from(value: fullmag_runner::FrequencyDomainVisualizationCapabilities) -> Self {
        Self {
            modal_spectrum_chart: value.modal_spectrum_chart.into(),
            modal_dispersion_chart: value.modal_dispersion_chart.into(),
            mode_table: value.mode_table.into(),
            mode_3d_overlay: value.mode_3d_overlay.into(),
            response_sweep_chart: value.response_sweep_chart.into(),
            response_field_3d_overlay: value.response_field_3d_overlay.into(),
        }
    }
}

impl From<fullmag_runner::FrequencyDomainCapabilitySnapshot>
    for FrequencyDomainCapabilitySnapshotResource
{
    fn from(value: fullmag_runner::FrequencyDomainCapabilitySnapshot) -> Self {
        Self {
            schema_version: value.schema_version,
            modal: value.modal.into(),
            boundary: value.boundary.into(),
            demag: value.demag.into(),
            dispersion: value.dispersion.into(),
            validation: value.validation.into(),
            response: value.response.into(),
            visualization: value.visualization.into(),
        }
    }
}

impl From<fullmag_runner::FrequencyDomainManifest> for FrequencyDomainManifestResource {
    fn from(value: fullmag_runner::FrequencyDomainManifest) -> Self {
        Self {
            schema_version: value.schema_version,
            existing_frequency_response_namespace_preserved: value
                .existing_frequency_response_namespace_preserved,
            family_namespace: value.family_namespace,
            eigen_namespace: value.eigen_namespace,
            response: value.response.into(),
            eigenmodes: value.eigenmodes.into(),
            floquet_nonzero_k_demag_supported: value.floquet_nonzero_k_demag_supported,
            capabilities: value.capabilities.into(),
            response_progress: None,
            response_cancel_requested: None,
            result_manifest: None,
        }
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
    responses(
        (status = 200, description = "Frequency-domain solver family manifest v1", body = FrequencyDomainManifestResource),
    ),
    tag = "analysis"
)]
pub async fn get_frequency_domain_manifest_v1(
    State(state): State<Arc<AppState>>,
) -> Json<FrequencyDomainManifestResource> {
    let mut manifest: FrequencyDomainManifestResource =
        fullmag_runner::frequency_domain_manifest_v1().into();
    manifest.response_progress = response_progress_resource(&state).await.ok();
    manifest.response_cancel_requested = response_cancel_requested_resource(&state).await.ok();
    manifest.result_manifest = frequency_domain_result_manifest_resource(&state).await.ok();
    Json(manifest)
}

async fn frequency_domain_result_manifest_resource(
    state: &Arc<AppState>,
) -> Result<FrequencyDomainJsonArtifactResource, ApiError> {
    let Json(resource) = json_artifact_resource(
        state,
        "frequency_domain_manifest.v1",
        "frequency_domain/manifest.v1.json",
        "/v2/sessions/current/analysis/frequency-domain/manifest.v1",
    )
    .await?;
    if resource.status == "ready" {
        Ok(resource)
    } else {
        Err(ApiError::not_found(
            "frequency-domain result manifest is missing",
        ))
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
    responses((status = 200, description = "Frequency-domain eigen spectrum v2 resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_eigen_spectrum_v2(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_eigen_spectrum.v1",
        "eigen/spectrum.v2.json",
        "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
    responses((status = 200, description = "Frequency-domain eigen branches v2 resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_eigen_branches_v2(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_eigen_branches.v1",
        "eigen/branches.v2.json",
        "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
    responses((status = 200, description = "Frequency-domain eigen dispersion CSV resource", body = FrequencyDomainTextArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_eigen_dispersion(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainTextArtifactResource>, ApiError> {
    text_artifact_resource(
        &state,
        "frequency_domain_eigen_dispersion.v1",
        "eigen/dispersion.csv",
        "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
        "text/csv; charset=utf-8",
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
    responses((status = 200, description = "Frequency-domain eigen diagnostics v2 resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_eigen_diagnostics_v2(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_eigen_diagnostics.v1",
        "eigen/diagnostics.v2.json",
        "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{mode_index}/meta",
    params(
        ("sample_index" = u32, Path, description = "K-path sample index"),
        ("mode_index" = u32, Path, description = "Raw mode index"),
    ),
    responses((status = 200, description = "Frequency-domain mode field resource metadata", body = FrequencyDomainFieldResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_eigen_mode_field_meta(
    State(state): State<Arc<AppState>>,
    Path((sample_index, mode_index)): Path<(u32, u32)>,
) -> Result<Json<FrequencyDomainFieldResource>, ApiError> {
    let artifact_path = format!(
        "eigen/mode_fields/sample_{:04}/mode_{:04}/vector.bin",
        sample_index, mode_index
    );
    let field_id = format!(
        "analysis:eigen:sample-{:04}:mode-{:04}",
        sample_index, mode_index
    );
    field_resource(
        &state,
        "frequency_domain_mode_field.v1",
        &field_id,
        &artifact_path,
        &format!(
            "/v2/sessions/current/data/fields/{}/samples/vector?view=phase_rotated_real&phase_rad=0",
            field_id
        ),
        "analysis/eigen",
        "delta_m",
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
    responses((status = 200, description = "Frequency-domain driven response sweep resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_response_magnetic_sweep(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource_first_existing(
        &state,
        "frequency_domain_response_sweep_resource.v1",
        &[
            "response/magnetic_response_sweep.v2.json",
            "response/magnetic_response_sweep.v1.json",
        ],
        "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep",
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/response/progress.v1",
    responses((status = 200, description = "Frequency-domain driven response sweep progress resource", body = FrequencyDomainSweepProgressResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_response_progress_v1(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainSweepProgressResource>, ApiError> {
    response_progress_resource(&state).await.map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1",
    responses((status = 200, description = "Frequency-domain driven response sweep cancel-requested progress resource", body = FrequencyDomainSweepProgressResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_response_cancel_requested_v1(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainSweepProgressResource>, ApiError> {
    response_cancel_requested_resource(&state).await.map(Json)
}

async fn response_cancel_requested_resource(
    state: &Arc<AppState>,
) -> Result<FrequencyDomainSweepProgressResource, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    if try_resolve_artifact_path(&artifact_dir, "response/cancel_requested.v1.json")?.is_none() {
        return Err(ApiError::not_found(
            "frequency-domain response cancel-requested progress artifact is missing",
        ));
    }
    serde_json::from_value::<FrequencyDomainSweepProgressResource>(read_json_artifact_value(
        &artifact_dir,
        "response/cancel_requested.v1.json",
    )?)
    .map_err(|error| {
        ApiError::internal(format!(
            "invalid response cancel-requested progress artifact: {error}"
        ))
    })
}

async fn response_progress_resource(
    state: &Arc<AppState>,
) -> Result<FrequencyDomainSweepProgressResource, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    if try_resolve_artifact_path(&artifact_dir, "response/progress.v1.json")?.is_some() {
        let progress = serde_json::from_value::<FrequencyDomainSweepProgressResource>(
            read_json_artifact_value(&artifact_dir, "response/progress.v1.json")?,
        )
        .map_err(|error| {
            ApiError::internal(format!("invalid response progress artifact: {error}"))
        })?;
        return Ok(progress);
    }

    let sweep_path = [
        "response/magnetic_response_sweep.v2.json",
        "response/magnetic_response_sweep.v1.json",
    ]
    .into_iter()
    .find_map(|path| {
        try_resolve_artifact_path(&artifact_dir, path)
            .ok()
            .flatten()
            .map(|_| path)
    });
    let total_frequency_points = sweep_path
        .and_then(|path| read_json_artifact_value(&artifact_dir, path).ok())
        .map(|payload| response_sweep_total_frequency_points(&payload))
        .unwrap_or(0);
    let frequency_points = response_frequency_point_artifacts(&artifact_dir)?;
    let completed_frequency_points = frequency_points.len() as u64;
    let current_frequency_hz = frequency_points
        .last()
        .and_then(|path| read_json_artifact_value(&artifact_dir, path).ok())
        .and_then(|payload| response_frequency_point_hz(&payload));
    let manifest_payload =
        if try_resolve_artifact_path(&artifact_dir, "response/artifact_manifest.json")?.is_some() {
            read_json_artifact_value(&artifact_dir, "response/artifact_manifest.json").ok()
        } else {
            None
        };
    let manifest_path = manifest_payload
        .as_ref()
        .map(|_| "response/artifact_manifest.json".to_string());
    let total_frequency_points = manifest_payload
        .as_ref()
        .and_then(|payload| {
            payload
                .get("requested_frequency_point_count")
                .and_then(Value::as_u64)
        })
        .unwrap_or(total_frequency_points);
    let interrupted = manifest_payload
        .as_ref()
        .and_then(|payload| payload.get("interrupted"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let complete = manifest_payload
        .as_ref()
        .and_then(|payload| payload.get("complete"))
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            !interrupted
                && total_frequency_points > 0
                && completed_frequency_points == total_frequency_points
        });
    let partial_artifacts_available = completed_frequency_points > 0 || sweep_path.is_some();

    Ok(FrequencyDomainSweepProgressResource {
        schema_version: "frequency_domain_sweep_progress.v1".to_string(),
        status: if interrupted {
            "interrupted"
        } else if partial_artifacts_available {
            "ready"
        } else {
            "missing"
        }
        .to_string(),
        complete,
        total_frequency_points,
        completed_frequency_points,
        written_frequency_point_artifacts: completed_frequency_points,
        current_frequency_hz,
        partial_artifacts_available,
        latest_artifact_manifest_path: manifest_path,
        missing_reason: (!partial_artifacts_available)
            .then(|| "response sweep progress artifacts are not present".to_string()),
        progress_json: Some(format!(
            "{{\"schema_version\":\"frequency_domain_sweep_progress.v1\",\"state\":\"{}\",\"partial_artifacts_available\":{}}}",
            if interrupted {
                "interrupted"
            } else if complete {
                "completed"
            } else {
                "not_started"
            },
            partial_artifacts_available
        )),
    })
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/response/diagnostics.v1",
    responses((status = 200, description = "Frequency-domain response diagnostics resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_response_diagnostics_v1(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_response_diagnostics.v1",
        "response/diagnostics.v1.json",
        "/v2/sessions/current/analysis/frequency-domain/response/diagnostics.v1",
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/response/frequency-points/{frequency_index}",
    params(("frequency_index" = u32, Path, description = "Frequency point index")),
    responses((status = 200, description = "Frequency-domain response frequency point resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_response_frequency_point(
    State(state): State<Arc<AppState>>,
    Path(frequency_index): Path<u32>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    let artifact_path = format!(
        "response/frequency_points/frequency_{:04}.json",
        frequency_index
    );
    json_artifact_resource(
        &state,
        "frequency_domain_response_frequency_point.v1",
        &artifact_path,
        &format!(
            "/v2/sessions/current/analysis/frequency-domain/response/frequency-points/{}",
            frequency_index
        ),
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/response/field/{frequency_index}/meta",
    params(("frequency_index" = u32, Path, description = "Frequency point index")),
    responses((status = 200, description = "Frequency-domain response field resource metadata", body = FrequencyDomainFieldResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_response_field_meta(
    State(state): State<Arc<AppState>>,
    Path(frequency_index): Path<u32>,
) -> Result<Json<FrequencyDomainFieldResource>, ApiError> {
    let artifact_path = format!(
        "response/field_payloads/frequency_{:04}/vector.bin",
        frequency_index
    );
    let field_id = format!(
        "analysis:frequency-response:frequency-{:04}",
        frequency_index
    );
    field_resource(
        &state,
        "frequency_domain_response_field.v1",
        &field_id,
        &artifact_path,
        &format!(
            "/v2/sessions/current/data/fields/{}/samples/vector?view=phase_rotated_real&phase_rad=0",
            field_id
        ),
        "analysis/frequency-response",
        "delta_m",
    )
    .await
}

async fn json_artifact_resource(
    state: &Arc<AppState>,
    schema_version: &str,
    artifact_path: &str,
    resource_key: &str,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource_first_existing(state, schema_version, &[artifact_path], resource_key)
        .await
}

async fn json_artifact_resource_first_existing(
    state: &Arc<AppState>,
    schema_version: &str,
    artifact_paths: &[&str],
    resource_key: &str,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(state).await?;
    for artifact_path in artifact_paths {
        if try_resolve_artifact_path(&artifact_dir, artifact_path)?.is_some() {
            return Ok(Json(FrequencyDomainJsonArtifactResource {
                schema_version: schema_version.to_string(),
                status: "ready".to_string(),
                artifact_path: (*artifact_path).to_string(),
                resource_key: resource_key.to_string(),
                payload: Some(read_json_artifact_value(&artifact_dir, artifact_path)?),
                missing_reason: None,
            }));
        }
    }
    Ok(Json(FrequencyDomainJsonArtifactResource {
        schema_version: schema_version.to_string(),
        status: "missing".to_string(),
        artifact_path: artifact_paths
            .first()
            .copied()
            .unwrap_or_default()
            .to_string(),
        resource_key: resource_key.to_string(),
        payload: None,
        missing_reason: Some("artifact is not present in the active workspace".to_string()),
    }))
}

fn response_sweep_total_frequency_points(payload: &Value) -> u64 {
    payload
        .get("points")
        .or_else(|| payload.get("frequencies"))
        .or_else(|| payload.get("frequency_points"))
        .and_then(Value::as_array)
        .map(|points| points.len() as u64)
        .or_else(|| {
            payload
                .get("frequencies_hz")
                .and_then(Value::as_array)
                .map(|frequencies| frequencies.len() as u64)
        })
        .unwrap_or(0)
}

fn response_frequency_point_hz(payload: &Value) -> Option<f64> {
    payload
        .get("frequency_hz")
        .or_else(|| payload.get("frequencyHz"))
        .and_then(Value::as_f64)
}

fn response_frequency_point_artifacts(
    artifact_dir: &std::path::Path,
) -> Result<Vec<String>, ApiError> {
    let frequency_points_dir = artifact_dir.join("response").join("frequency_points");
    if !frequency_points_dir.exists() {
        return Ok(Vec::new());
    }
    if !frequency_points_dir.is_dir() {
        return Err(ApiError::internal(
            "response/frequency_points exists but is not a directory",
        ));
    }
    let mut paths = Vec::new();
    for entry in std::fs::read_dir(&frequency_points_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let relative = path
            .strip_prefix(artifact_dir)
            .unwrap_or(&path)
            .display()
            .to_string();
        paths.push(relative);
    }
    paths.sort();
    Ok(paths)
}

async fn text_artifact_resource(
    state: &Arc<AppState>,
    schema_version: &str,
    artifact_path: &str,
    resource_key: &str,
    content_type: &str,
) -> Result<Json<FrequencyDomainTextArtifactResource>, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(state).await?;
    if try_resolve_artifact_path(&artifact_dir, artifact_path)?.is_some() {
        return Ok(Json(FrequencyDomainTextArtifactResource {
            schema_version: schema_version.to_string(),
            status: "ready".to_string(),
            artifact_path: artifact_path.to_string(),
            resource_key: resource_key.to_string(),
            content_type: content_type.to_string(),
            text: Some(read_text_artifact_value(&artifact_dir, artifact_path)?),
            missing_reason: None,
        }));
    }
    Ok(Json(FrequencyDomainTextArtifactResource {
        schema_version: schema_version.to_string(),
        status: "missing".to_string(),
        artifact_path: artifact_path.to_string(),
        resource_key: resource_key.to_string(),
        content_type: content_type.to_string(),
        text: None,
        missing_reason: Some("artifact is not present in the active workspace".to_string()),
    }))
}

async fn field_resource(
    state: &Arc<AppState>,
    schema_version: &str,
    field_id: &str,
    artifact_path: &str,
    resource_key: &str,
    source_family: &str,
    quantity: &str,
) -> Result<Json<FrequencyDomainFieldResource>, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(state).await?;
    let present = try_resolve_artifact_path(&artifact_dir, artifact_path)?.is_some();
    Ok(Json(FrequencyDomainFieldResource {
        schema_version: schema_version.to_string(),
        status: if present { "ready" } else { "missing" }.to_string(),
        field_id: field_id.to_string(),
        artifact_path: artifact_path.to_string(),
        resource_key: resource_key.to_string(),
        source_family: source_family.to_string(),
        quantity: quantity.to_string(),
        value_kind: "complex_vector".to_string(),
        components: vec!["x".to_string(), "y".to_string(), "z".to_string()],
        available_views: vec![
            "complex".to_string(),
            "real".to_string(),
            "imag".to_string(),
            "abs".to_string(),
            "amplitude".to_string(),
            "phase".to_string(),
            "phase_rotated_real".to_string(),
        ],
        default_view: "phase_rotated_real".to_string(),
        default_phase_rad: Some(0.0),
        missing_reason: (!present)
            .then(|| "field payload is not present in the active workspace".to_string()),
    }))
}
