//! Frequency-domain analysis family manifest and artifact resource endpoints.

use std::{collections::BTreeMap, sync::Arc};

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
    pub static_periodic_response_available: bool,
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
    pub reference_cpu: FrequencyDomainCapabilityEntryResource,
    pub production_cpu: FrequencyDomainCapabilityEntryResource,
    pub production_cpu_gamma_k_path: FrequencyDomainCapabilityEntryResource,
    pub production_gpu: FrequencyDomainCapabilityEntryResource,
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
    pub floquet_nonzero_k_response_supported: bool,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path_metadata: Option<FrequencyDomainKPathMetadataResource>,
    pub missing_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainKPathMetadataResource {
    pub sampling: FrequencyDomainKPathSamplingResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainKPathSamplingResource {
    pub kind: String,
    pub points: Vec<FrequencyDomainKPathControlPointResource>,
    pub samples_per_segment: Vec<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainKPathControlPointResource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[schema(min_items = 3, max_items = 3)]
    pub k_vector: [f64; 3],
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_basis: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_count: Option<u64>,
    pub components: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary_layout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complex_pair_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_value_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zarr_store_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zarr_array_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zarr_chunk_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zarr_dtype: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zarr_shape: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zarr_chunk_shape: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zarr_compressor: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compatibility_binary_payload_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tangent_field_payload_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tangent_payload_encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tangent_value_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tangent_component_basis: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tangent_component_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tangent_components: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tangent_complex_pair_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tangent_payload_value_count: Option<u64>,
    pub available_views: Vec<String>,
    pub default_view: String,
    pub default_phase_rad: Option<f64>,
    pub missing_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainSweepProgressResource {
    pub schema_version: String,
    pub status: String,
    pub state: String,
    pub complete: bool,
    pub total_frequency_points: u64,
    pub completed_frequency_points: u64,
    pub written_frequency_point_artifacts: u64,
    pub current_frequency_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_min_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_max_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demag_mode: Option<String>,
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
            static_periodic_response_available: value.static_periodic_response_available,
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
            reference_cpu: value.reference_cpu.into(),
            production_cpu: value.production_cpu.into(),
            production_cpu_gamma_k_path: value.production_cpu_gamma_k_path.into(),
            production_gpu: value.production_gpu.into(),
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
            floquet_nonzero_k_response_supported: value.floquet_nonzero_k_response_supported,
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
    let Json(mut resource) = text_artifact_resource(
        &state,
        "frequency_domain_eigen_dispersion.v1",
        "eigen/dispersion.csv",
        "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
        "text/csv; charset=utf-8",
    )
    .await?;
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    if try_resolve_artifact_path(&artifact_dir, "eigen/dispersion/path.json")?.is_some() {
        let path_metadata =
            read_dispersion_path_metadata_resource(&artifact_dir, "eigen/dispersion/path.json")?;
        if let Some(text) = resource.text.as_deref() {
            validate_dispersion_path_metadata_against_csv(&path_metadata, text).map_err(
                |error| {
                    ApiError::internal(format!(
                        "invalid eigen/dispersion/path.json against eigen/dispersion.csv: {error}"
                    ))
                },
            )?;
        }
        resource.path_metadata = Some(path_metadata);
    }
    Ok(Json(resource))
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
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    let artifact_path =
        eigen_mode_field_preferred_payload_path(&artifact_dir, sample_index, mode_index)?;
    let field_id = format!(
        "analysis:eigen:sample-{:04}:mode-{:04}",
        sample_index, mode_index
    );
    let metadata =
        eigen_mode_field_metadata(&artifact_dir, sample_index, mode_index, &artifact_path)?;
    field_resource(
        &state,
        "frequency_domain_mode_field.v1",
        &field_id,
        &artifact_path,
        &analysis_field_vector_resource_key(&field_id, "phase_rotated_real", Some(0.0)),
        "analysis/eigen",
        "delta_m",
        metadata,
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
    let sweep_payload =
        sweep_path.and_then(|path| read_json_artifact_value(&artifact_dir, path).ok());
    let frequency_range_hz = sweep_payload
        .as_ref()
        .and_then(response_sweep_frequency_range_hz);
    let total_frequency_points = sweep_payload
        .as_ref()
        .map(response_sweep_total_frequency_points)
        .unwrap_or(0);
    let frequency_points = response_frequency_point_artifacts(&artifact_dir)?;
    let completed_frequency_points = frequency_points.len() as u64;
    let current_frequency_hz = frequency_points
        .last()
        .and_then(|path| read_json_artifact_value(&artifact_dir, path).ok())
        .and_then(|payload| response_frequency_point_hz(&payload));
    let frequency_domain_manifest_payload =
        if try_resolve_artifact_path(&artifact_dir, "frequency_domain/manifest.v1.json")?.is_some()
        {
            read_json_artifact_value(&artifact_dir, "frequency_domain/manifest.v1.json").ok()
        } else {
            None
        };
    let legacy_manifest_payload =
        if try_resolve_artifact_path(&artifact_dir, "response/artifact_manifest.json")?.is_some() {
            read_json_artifact_value(&artifact_dir, "response/artifact_manifest.json").ok()
        } else {
            None
        };
    let manifest_payload = frequency_domain_manifest_payload
        .as_ref()
        .or(legacy_manifest_payload.as_ref());
    let manifest_path = manifest_payload.map(|payload| {
        if payload.get("schema_version").and_then(Value::as_str)
            == Some("frequency_domain_manifest.v1")
        {
            "frequency_domain/manifest.v1.json".to_string()
        } else {
            "response/artifact_manifest.json".to_string()
        }
    });
    let total_frequency_points = manifest_payload
        .and_then(|payload| {
            payload
                .get("requested_frequency_point_count")
                .and_then(Value::as_u64)
                .or_else(|| {
                    frequency_domain_manifest_diagnostics_u64(payload, "requested_frequency_count")
                })
                .or_else(|| {
                    payload
                        .get("requested_execution")
                        .and_then(|requested| requested.get("frequency_point_count"))
                        .and_then(Value::as_u64)
                })
                .or_else(|| payload.get("point_count").and_then(Value::as_u64))
        })
        .unwrap_or(total_frequency_points);
    let completed_frequency_points = manifest_payload
        .and_then(frequency_domain_manifest_completed_frequency_points)
        .unwrap_or(completed_frequency_points);
    let written_frequency_point_artifacts = manifest_payload
        .and_then(|payload| {
            frequency_domain_manifest_diagnostics_u64(payload, "written_frequency_point_artifacts")
        })
        .unwrap_or(completed_frequency_points);
    let manifest_status = manifest_payload
        .and_then(|payload| payload.get("status"))
        .and_then(Value::as_str);
    let interrupted = manifest_payload
        .and_then(|payload| payload.get("interrupted"))
        .and_then(Value::as_bool)
        .or_else(|| manifest_status.map(|status| status == "interrupted"))
        .unwrap_or(false);
    let unavailable = manifest_status == Some("unavailable");
    let complete = manifest_payload
        .and_then(|payload| payload.get("complete"))
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            !interrupted
                && !unavailable
                && total_frequency_points > 0
                && completed_frequency_points == total_frequency_points
        });
    let partial_artifacts_available = written_frequency_point_artifacts > 0 || sweep_path.is_some();
    let state = if interrupted {
        "interrupted"
    } else if unavailable {
        "unavailable"
    } else if complete {
        "completed"
    } else if partial_artifacts_available {
        "running"
    } else {
        "not_started"
    };

    let status = if interrupted {
        "interrupted"
    } else if unavailable {
        "unavailable"
    } else if partial_artifacts_available {
        "ready"
    } else {
        "missing"
    }
    .to_string();
    let progress_json = serde_json::json!({
        "schema_version": "frequency_domain_sweep_progress.v1",
        "status": status.clone(),
        "complete": complete,
        "state": state,
        "total_frequency_points": total_frequency_points,
        "completed_frequency_points": completed_frequency_points,
        "written_frequency_point_artifacts": written_frequency_point_artifacts,
        "current_frequency_hz": current_frequency_hz,
        "frequency_min_hz": frequency_range_hz.map(|range| range.0),
        "frequency_max_hz": frequency_range_hz.map(|range| range.1),
        "partial_artifacts_available": partial_artifacts_available,
        "latest_artifact_manifest_path": manifest_path.clone(),
    })
    .to_string();

    Ok(FrequencyDomainSweepProgressResource {
        schema_version: "frequency_domain_sweep_progress.v1".to_string(),
        status,
        state: state.to_string(),
        complete,
        total_frequency_points,
        completed_frequency_points,
        written_frequency_point_artifacts,
        current_frequency_hz,
        frequency_min_hz: frequency_range_hz.map(|range| range.0),
        frequency_max_hz: frequency_range_hz.map(|range| range.1),
        demag_mode: None,
        partial_artifacts_available,
        latest_artifact_manifest_path: manifest_path,
        missing_reason: if unavailable {
            Some("frequency-domain response is unavailable".to_string())
        } else {
            (!partial_artifacts_available)
                .then(|| "response sweep progress artifacts are not present".to_string())
        },
        progress_json: Some(progress_json),
    })
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1",
    responses((status = 200, description = "Frequency-domain response diagnostics resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_response_solver_diagnostics_v1(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_response_diagnostics.v1",
        "response/diagnostics/solver.v1.json",
        "/v2/sessions/current/analysis/frequency-domain/response/diagnostics/solver.v1",
    )
    .await
}

pub async fn get_frequency_domain_response_diagnostics_v1(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_response_diagnostics.v1",
        "response/diagnostics/solver.v1.json",
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
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    let artifact_path =
        response_frequency_point_artifact_path_from_sweep(&artifact_dir, frequency_index)?
            .unwrap_or_else(|| {
                format!(
                    "response/frequency_points/frequency_{:04}.json",
                    frequency_index
                )
            });
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

fn response_frequency_point_artifact_path_from_sweep(
    artifact_dir: &std::path::Path,
    frequency_index: u32,
) -> Result<Option<String>, ApiError> {
    response_sweep_linked_path(
        artifact_dir,
        frequency_index,
        "frequency_point_artifact_path",
        "frequency_point_artifact_paths",
    )
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
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    let frequency_point_artifact_path =
        response_frequency_point_artifact_path_from_sweep(&artifact_dir, frequency_index)?
            .unwrap_or_else(|| {
                format!(
                    "response/frequency_points/frequency_{:04}.json",
                    frequency_index
                )
            });
    let point_metadata =
        response_field_payload_metadata(&artifact_dir, &frequency_point_artifact_path)?;
    let artifact_path = if let Some(path) =
        response_field_payload_path_from_manifest(&artifact_dir, frequency_index)?
    {
        path
    } else if let Some(path) =
        response_field_payload_path_from_sweep(&artifact_dir, frequency_index)?
    {
        path
    } else if let Some(path) = response_field_payload_path_from_point_artifact(
        &artifact_dir,
        &frequency_point_artifact_path,
    )? {
        path
    } else {
        format!(
            "response/field_payloads.zarr/frequency_{:04}/vector_xyz_complex/0.0.0",
            frequency_index
        )
    };
    let field_id = format!(
        "analysis:frequency-response:frequency-{:04}",
        frequency_index
    );
    let resource_key = analysis_field_vector_resource_key(
        &field_id,
        &point_metadata.default_view,
        point_metadata.default_phase_rad,
    );
    field_resource(
        &state,
        "frequency_domain_response_field.v1",
        &field_id,
        &artifact_path,
        &resource_key,
        "analysis/frequency-response",
        "delta_m",
        Some(point_metadata),
    )
    .await
}

fn analysis_field_vector_resource_key(
    field_id: &str,
    default_view: &str,
    default_phase_rad: Option<f64>,
) -> String {
    format!(
        "/v2/sessions/current/data/fields/{}/samples/vector?view={}&phase_rad={}",
        field_id,
        default_view,
        default_phase_rad.unwrap_or(0.0)
    )
}

fn response_field_payload_path_from_manifest(
    artifact_dir: &std::path::Path,
    frequency_index: u32,
) -> Result<Option<String>, ApiError> {
    if try_resolve_artifact_path(artifact_dir, "frequency_domain/manifest.v1.json")?.is_none() {
        return Ok(None);
    }
    let manifest = read_json_artifact_value(artifact_dir, "frequency_domain/manifest.v1.json")?;
    Ok(manifest
        .get("resources")
        .and_then(|resources| resources.get("response_field_resources"))
        .and_then(Value::as_array)
        .and_then(|resources| {
            resources.iter().find_map(|resource| {
                let resource = resource.as_object()?;
                let index = resource.get("frequency_index")?.as_u64()?;
                if index == u64::from(frequency_index) {
                    resource
                        .get("payload_path")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                }
            })
        }))
}

fn response_field_payload_path_from_sweep(
    artifact_dir: &std::path::Path,
    frequency_index: u32,
) -> Result<Option<String>, ApiError> {
    response_sweep_linked_path(
        artifact_dir,
        frequency_index,
        "response_field_payload_path",
        "response_field_payload_paths",
    )
}

fn response_field_payload_path_from_point_artifact(
    artifact_dir: &std::path::Path,
    frequency_point_artifact_path: &str,
) -> Result<Option<String>, ApiError> {
    if try_resolve_artifact_path(artifact_dir, frequency_point_artifact_path)?.is_none() {
        return Ok(None);
    }
    let payload = read_json_artifact_value(artifact_dir, frequency_point_artifact_path)?;
    payload
        .get("field_payload_path")
        .and_then(Value::as_str)
        .map(str::to_string)
        .map(Some)
        .ok_or_else(|| {
            ApiError::internal(format!(
                "missing required frequency response field_payload_path in '{}'",
                frequency_point_artifact_path
            ))
        })
}

fn response_sweep_linked_path(
    artifact_dir: &std::path::Path,
    frequency_index: u32,
    point_field: &str,
    list_field: &str,
) -> Result<Option<String>, ApiError> {
    if try_resolve_artifact_path(artifact_dir, "response/magnetic_response_sweep.v2.json")?
        .is_none()
    {
        return Ok(None);
    }
    let sweep = read_json_artifact_value(artifact_dir, "response/magnetic_response_sweep.v2.json")?;
    if let Some(path) = sweep
        .get("points")
        .and_then(Value::as_array)
        .and_then(|points| {
            points.iter().find_map(|point| {
                let point = point.as_object()?;
                let index = point.get("frequency_index")?.as_u64()?;
                if index == u64::from(frequency_index) {
                    point
                        .get(point_field)
                        .and_then(Value::as_str)
                        .map(str::to_string)
                } else {
                    None
                }
            })
        })
    {
        return Ok(Some(path));
    }
    Ok(sweep
        .get(list_field)
        .and_then(Value::as_array)
        .and_then(|paths| paths.get(frequency_index as usize))
        .and_then(Value::as_str)
        .map(str::to_string))
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

fn response_sweep_frequency_range_hz(payload: &Value) -> Option<(f64, f64)> {
    let mut frequencies = Vec::new();
    if let Some(points) = payload
        .get("points")
        .or_else(|| payload.get("frequency_points"))
        .and_then(Value::as_array)
    {
        frequencies.extend(
            points
                .iter()
                .filter_map(response_frequency_point_hz)
                .filter(|value| value.is_finite() && *value > 0.0),
        );
    }
    if let Some(values) = payload
        .get("frequencies")
        .or_else(|| payload.get("frequencies_hz"))
        .and_then(Value::as_array)
    {
        frequencies.extend(
            values
                .iter()
                .filter_map(Value::as_f64)
                .filter(|value| value.is_finite() && *value > 0.0),
        );
    }
    let mut iter = frequencies.into_iter();
    let first = iter.next()?;
    Some(iter.fold((first, first), |(min_hz, max_hz), value| {
        (min_hz.min(value), max_hz.max(value))
    }))
}

fn frequency_domain_manifest_diagnostics_u64(payload: &Value, field_name: &str) -> Option<u64> {
    payload
        .get("diagnostics")
        .and_then(|diagnostics| diagnostics.get(field_name))
        .and_then(Value::as_u64)
}

fn frequency_domain_manifest_completed_frequency_points(payload: &Value) -> Option<u64> {
    frequency_domain_manifest_diagnostics_u64(payload, "completed_frequency_point_count")
        .or_else(|| frequency_domain_manifest_diagnostics_u64(payload, "completed_frequency_count"))
}

fn response_frequency_point_hz(payload: &Value) -> Option<f64> {
    payload
        .get("frequency_hz")
        .or_else(|| payload.get("frequencyHz"))
        .or_else(|| {
            payload.get("point").and_then(|point| {
                point
                    .get("frequency_hz")
                    .or_else(|| point.get("frequencyHz"))
            })
        })
        .and_then(Value::as_f64)
}

fn response_frequency_point_artifacts(
    artifact_dir: &std::path::Path,
) -> Result<Vec<String>, ApiError> {
    if try_resolve_artifact_path(artifact_dir, "response/magnetic_response_sweep.v2.json")?
        .is_some()
    {
        let sweep =
            read_json_artifact_value(artifact_dir, "response/magnetic_response_sweep.v2.json")?;
        let linked_paths = sweep
            .get("frequency_point_artifact_paths")
            .and_then(Value::as_array)
            .map(|paths| {
                paths
                    .iter()
                    .filter_map(Value::as_str)
                    .filter_map(|path| {
                        try_resolve_artifact_path(artifact_dir, path)
                            .ok()
                            .flatten()
                            .map(|_| path.to_string())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !linked_paths.is_empty() {
            return Ok(linked_paths);
        }
    }

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

fn read_dispersion_path_metadata_resource(
    artifact_dir: &std::path::Path,
    artifact_path: &str,
) -> Result<FrequencyDomainKPathMetadataResource, ApiError> {
    let value = read_json_artifact_value(artifact_dir, artifact_path)?;
    let normalized = if value.get("sampling").is_some() {
        value
    } else {
        serde_json::json!({ "sampling": value })
    };
    let mut resource =
        serde_json::from_value::<FrequencyDomainKPathMetadataResource>(normalized)
            .map_err(|error| ApiError::internal(format!("invalid {artifact_path}: {error}")))?;
    normalize_and_validate_dispersion_path_metadata(&mut resource)
        .map_err(|error| ApiError::internal(format!("invalid {artifact_path}: {error}")))?;
    Ok(resource)
}

fn normalize_and_validate_dispersion_path_metadata(
    resource: &mut FrequencyDomainKPathMetadataResource,
) -> Result<(), String> {
    let sampling = &mut resource.sampling;
    if sampling.kind != "path" {
        return Err(format!(
            "sampling.kind must be `path`, got `{}`",
            sampling.kind
        ));
    }
    if sampling.points.len() < 2 {
        return Err("sampling.points must include at least two control points".to_string());
    }
    for (point_index, point) in sampling.points.iter_mut().enumerate() {
        if !point.k_vector.iter().all(|value| value.is_finite()) {
            return Err(format!(
                "sampling.points[{point_index}].k_vector must contain finite values"
            ));
        }
        if let Some(label) = point.label.as_mut() {
            let trimmed = label.trim();
            if trimmed.is_empty() {
                point.label = None;
            } else if trimmed.len() != label.len() {
                *label = trimmed.to_string();
            }
        }
    }
    if sampling
        .samples_per_segment
        .iter()
        .any(|sample_count| *sample_count == 0)
    {
        return Err("sampling.samples_per_segment entries must be positive".to_string());
    }
    let expected_segment_count = if sampling.closed.unwrap_or(false) {
        sampling.points.len()
    } else {
        sampling.points.len() - 1
    };
    if sampling.samples_per_segment.len() != expected_segment_count {
        return Err(format!(
            "sampling expected {expected_segment_count} samples_per_segment entries, got {}",
            sampling.samples_per_segment.len()
        ));
    }
    Ok(())
}

#[derive(Debug, Clone)]
struct DispersionCsvPathSample {
    k_vector: [f64; 3],
    label: Option<String>,
}

fn validate_dispersion_path_metadata_against_csv(
    resource: &FrequencyDomainKPathMetadataResource,
    csv_content: &str,
) -> Result<(), String> {
    let csv_samples = parse_dispersion_csv_path_samples(csv_content)?;
    if csv_samples.is_empty() {
        return Ok(());
    }
    let expected_samples = expand_dispersion_path_metadata_samples(resource)?;
    for (sample_index, csv_sample) in csv_samples {
        let expected = expected_samples.get(sample_index as usize).ok_or_else(|| {
            format!(
                "dispersion.csv sample_index {sample_index} is outside path_metadata sample range"
            )
        })?;
        for (component_index, (actual, expected)) in csv_sample
            .k_vector
            .iter()
            .zip(expected.k_vector.iter())
            .enumerate()
        {
            if (actual - expected).abs() > 1.0e-6 {
                return Err(format!(
                    "dispersion.csv sample_index {sample_index} k_vector[{component_index}] \
                     = {actual} does not match path_metadata {expected}"
                ));
            }
        }
        if let (Some(actual_label), Some(expected_label)) =
            (csv_sample.label.as_deref(), expected.label.as_deref())
        {
            if actual_label != expected_label {
                return Err(format!(
                    "dispersion.csv sample_index {sample_index} label `{actual_label}` \
                     does not match path_metadata `{expected_label}`"
                ));
            }
        }
    }
    Ok(())
}

fn expand_dispersion_path_metadata_samples(
    resource: &FrequencyDomainKPathMetadataResource,
) -> Result<Vec<DispersionCsvPathSample>, String> {
    let sampling = &resource.sampling;
    let mut samples = Vec::new();
    let Some(first_point) = sampling.points.first() else {
        return Ok(samples);
    };
    samples.push(DispersionCsvPathSample {
        k_vector: first_point.k_vector,
        label: first_point.label.clone(),
    });
    for (segment_index, sample_count) in sampling.samples_per_segment.iter().enumerate() {
        let start = &sampling.points[segment_index % sampling.points.len()];
        let end = &sampling.points[(segment_index + 1) % sampling.points.len()];
        for offset in 1..=*sample_count {
            let t = offset as f64 / *sample_count as f64;
            let k_vector = [
                start.k_vector[0] + (end.k_vector[0] - start.k_vector[0]) * t,
                start.k_vector[1] + (end.k_vector[1] - start.k_vector[1]) * t,
                start.k_vector[2] + (end.k_vector[2] - start.k_vector[2]) * t,
            ];
            let label = (offset == *sample_count)
                .then(|| end.label.clone())
                .flatten();
            samples.push(DispersionCsvPathSample { k_vector, label });
        }
    }
    Ok(samples)
}

fn parse_dispersion_csv_path_samples(
    csv_content: &str,
) -> Result<BTreeMap<u64, DispersionCsvPathSample>, String> {
    let Some((header_line_number, header_line)) = csv_content
        .lines()
        .enumerate()
        .find(|(_, line)| !line.trim().is_empty())
    else {
        return Ok(BTreeMap::new());
    };
    let headers = header_line.split(',').map(str::trim).collect::<Vec<_>>();
    let find_column = |labels: &[&str]| {
        labels
            .iter()
            .find_map(|label| headers.iter().position(|header| header == label))
            .ok_or_else(|| format!("dispersion.csv missing {}", labels.join(" or ")))
    };
    let sample_index_col = find_column(&["sample_index"])?;
    let kx_col = find_column(&["kx_rad_per_m", "kx"])?;
    let ky_col = find_column(&["ky_rad_per_m", "ky"])?;
    let kz_col = find_column(&["kz_rad_per_m", "kz"])?;
    let label_col = headers.iter().position(|header| *header == "label");
    let mut samples: BTreeMap<u64, DispersionCsvPathSample> = BTreeMap::new();
    for (line_number, line) in csv_content.lines().enumerate() {
        if line_number <= header_line_number {
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let columns = trimmed.split(',').map(str::trim).collect::<Vec<_>>();
        let column = |name: &str, index: usize| {
            columns.get(index).copied().ok_or_else(|| {
                format!(
                    "dispersion.csv row {} missing {name} column value",
                    line_number + 1
                )
            })
        };
        let sample_index = column("sample_index", sample_index_col)?
            .parse::<u64>()
            .map_err(|error| {
                format!(
                    "invalid sample_index value in dispersion.csv row {}: {error}",
                    line_number + 1
                )
            })?;
        let parse_f64 = |name: &str, index: usize| {
            let raw = column(name, index)?;
            let value = raw.parse::<f64>().map_err(|error| {
                format!(
                    "invalid {name} value in dispersion.csv row {}: {error}",
                    line_number + 1
                )
            })?;
            if value.is_finite() {
                Ok(value)
            } else {
                Err(format!(
                    "dispersion.csv row {} {name} must be finite",
                    line_number + 1
                ))
            }
        };
        let label = label_col
            .and_then(|index| columns.get(index).copied())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let sample = DispersionCsvPathSample {
            k_vector: [
                parse_f64("kx", kx_col)?,
                parse_f64("ky", ky_col)?,
                parse_f64("kz", kz_col)?,
            ],
            label,
        };
        if let Some(existing) = samples.get(&sample_index) {
            for (component_index, (left, right)) in existing
                .k_vector
                .iter()
                .zip(sample.k_vector.iter())
                .enumerate()
            {
                if (left - right).abs() > 1.0e-12 {
                    return Err(format!(
                        "dispersion.csv sample_index {sample_index} has inconsistent \
                         k_vector[{component_index}] values"
                    ));
                }
            }
            if existing
                .label
                .as_deref()
                .filter(|value| !value.is_empty())
                .is_some()
                && sample
                    .label
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .is_some()
                && existing.label != sample.label
            {
                return Err(format!(
                    "dispersion.csv sample_index {sample_index} has inconsistent labels"
                ));
            }
            continue;
        }
        samples.insert(sample_index, sample);
    }
    Ok(samples)
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
            path_metadata: None,
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
        path_metadata: None,
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
    metadata: Option<FrequencyDomainFieldMetadata>,
) -> Result<Json<FrequencyDomainFieldResource>, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(state).await?;
    let present = try_resolve_artifact_path(&artifact_dir, artifact_path)?.is_some();
    let metadata = metadata.unwrap_or_default();
    Ok(Json(FrequencyDomainFieldResource {
        schema_version: schema_version.to_string(),
        status: if present { "ready" } else { "missing" }.to_string(),
        field_id: field_id.to_string(),
        artifact_path: artifact_path.to_string(),
        resource_key: resource_key.to_string(),
        source_family: source_family.to_string(),
        quantity: quantity.to_string(),
        value_kind: metadata.value_kind,
        component_basis: metadata.component_basis,
        component_count: metadata.component_count,
        components: metadata.components,
        payload_encoding: metadata.payload_encoding,
        binary_layout: metadata.binary_layout,
        complex_pair_count: metadata.complex_pair_count,
        payload_value_count: metadata.payload_value_count,
        storage_format: metadata.storage_format,
        zarr_store_path: metadata.zarr_store_path,
        zarr_array_path: metadata.zarr_array_path,
        zarr_chunk_path: metadata.zarr_chunk_path,
        zarr_dtype: metadata.zarr_dtype,
        zarr_shape: metadata.zarr_shape,
        zarr_chunk_shape: metadata.zarr_chunk_shape,
        zarr_compressor: metadata.zarr_compressor,
        compatibility_binary_payload_path: metadata.compatibility_binary_payload_path,
        tangent_field_payload_path: metadata.tangent_field_payload_path,
        tangent_payload_encoding: metadata.tangent_payload_encoding,
        tangent_value_kind: metadata.tangent_value_kind,
        tangent_component_basis: metadata.tangent_component_basis,
        tangent_component_count: metadata.tangent_component_count,
        tangent_components: metadata.tangent_components,
        tangent_complex_pair_count: metadata.tangent_complex_pair_count,
        tangent_payload_value_count: metadata.tangent_payload_value_count,
        available_views: metadata.available_views,
        default_view: metadata.default_view,
        default_phase_rad: metadata.default_phase_rad,
        missing_reason: (!present)
            .then(|| "field payload is not present in the active workspace".to_string()),
    }))
}

#[derive(Debug, Clone)]
struct FrequencyDomainFieldMetadata {
    value_kind: String,
    component_basis: Option<String>,
    component_count: Option<u64>,
    components: Vec<String>,
    payload_encoding: Option<String>,
    binary_layout: Option<String>,
    complex_pair_count: Option<u64>,
    payload_value_count: Option<u64>,
    storage_format: Option<String>,
    zarr_store_path: Option<String>,
    zarr_array_path: Option<String>,
    zarr_chunk_path: Option<String>,
    zarr_dtype: Option<String>,
    zarr_shape: Option<Vec<u64>>,
    zarr_chunk_shape: Option<Vec<u64>>,
    zarr_compressor: Option<Value>,
    compatibility_binary_payload_path: Option<String>,
    tangent_field_payload_path: Option<String>,
    tangent_payload_encoding: Option<String>,
    tangent_value_kind: Option<String>,
    tangent_component_basis: Option<String>,
    tangent_component_count: Option<u64>,
    tangent_components: Option<Vec<String>>,
    tangent_complex_pair_count: Option<u64>,
    tangent_payload_value_count: Option<u64>,
    available_views: Vec<String>,
    default_view: String,
    default_phase_rad: Option<f64>,
}

impl Default for FrequencyDomainFieldMetadata {
    fn default() -> Self {
        Self {
            value_kind: "complex_vector".to_string(),
            component_basis: None,
            component_count: Some(3),
            components: vec!["x".to_string(), "y".to_string(), "z".to_string()],
            payload_encoding: None,
            binary_layout: None,
            complex_pair_count: None,
            payload_value_count: None,
            storage_format: None,
            zarr_store_path: None,
            zarr_array_path: None,
            zarr_chunk_path: None,
            zarr_dtype: None,
            zarr_shape: None,
            zarr_chunk_shape: None,
            zarr_compressor: None,
            compatibility_binary_payload_path: None,
            tangent_field_payload_path: None,
            tangent_payload_encoding: None,
            tangent_value_kind: None,
            tangent_component_basis: None,
            tangent_component_count: None,
            tangent_components: None,
            tangent_complex_pair_count: None,
            tangent_payload_value_count: None,
            available_views: default_complex_field_views(),
            default_view: "phase_rotated_real".to_string(),
            default_phase_rad: Some(0.0),
        }
    }
}

fn default_complex_field_views() -> Vec<String> {
    vec![
        "complex".to_string(),
        "real".to_string(),
        "imag".to_string(),
        "abs".to_string(),
        "amplitude".to_string(),
        "phase".to_string(),
        "phase_rotated_real".to_string(),
    ]
}

fn optional_u64_array_field(
    payload: &Value,
    field: &str,
    artifact_path: &str,
    label: &str,
) -> Result<Option<Vec<u64>>, ApiError> {
    let Some(value) = payload.get(field) else {
        return Ok(None);
    };
    let Some(array) = value.as_array() else {
        return Err(ApiError::internal(format!(
            "invalid {label} {field} in '{artifact_path}'"
        )));
    };
    let mut out = Vec::with_capacity(array.len());
    for item in array {
        let Some(value) = item.as_u64() else {
            return Err(ApiError::internal(format!(
                "invalid {label} {field} in '{artifact_path}'"
            )));
        };
        out.push(value);
    }
    Ok((!out.is_empty()).then_some(out))
}

fn copy_storage_metadata(
    payload: &Value,
    metadata: &mut FrequencyDomainFieldMetadata,
    artifact_path: &str,
    label: &str,
) -> Result<(), ApiError> {
    metadata.storage_format = payload
        .get("storage_format")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.zarr_store_path = payload
        .get("zarr_store_path")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.zarr_array_path = payload
        .get("zarr_array_path")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.zarr_chunk_path = payload
        .get("zarr_chunk_path")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.zarr_dtype = payload
        .get("zarr_dtype")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.zarr_shape = optional_u64_array_field(payload, "zarr_shape", artifact_path, label)?;
    metadata.zarr_chunk_shape =
        optional_u64_array_field(payload, "zarr_chunk_shape", artifact_path, label)?;
    metadata.zarr_compressor = payload.get("zarr_compressor").cloned();
    metadata.compatibility_binary_payload_path = payload
        .get("compatibility_binary_payload_path")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(())
}

fn response_field_payload_metadata(
    artifact_dir: &std::path::Path,
    frequency_point_artifact_path: &str,
) -> Result<FrequencyDomainFieldMetadata, ApiError> {
    if try_resolve_artifact_path(artifact_dir, frequency_point_artifact_path)?.is_none() {
        return Ok(FrequencyDomainFieldMetadata::default());
    }
    let payload = read_json_artifact_value(artifact_dir, frequency_point_artifact_path)?;
    let mut metadata = FrequencyDomainFieldMetadata::default();
    metadata.value_kind = payload
        .get("value_kind")
        .and_then(Value::as_str)
        .unwrap_or(&metadata.value_kind)
        .to_string();
    metadata.component_basis = payload
        .get("component_basis")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.component_count = payload.get("component_count").and_then(Value::as_u64);
    if let Some(components) = payload
        .get("components")
        .and_then(Value::as_array)
        .map(|components| {
            components
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|components| !components.is_empty())
    {
        metadata.components = components;
    }
    metadata.payload_encoding = payload
        .get("payload_encoding")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.binary_layout = payload
        .get("binary_layout")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.complex_pair_count = payload.get("complex_pair_count").and_then(Value::as_u64);
    metadata.payload_value_count = payload.get("payload_value_count").and_then(Value::as_u64);
    copy_storage_metadata(
        &payload,
        &mut metadata,
        frequency_point_artifact_path,
        "frequency response field",
    )?;
    metadata.tangent_field_payload_path = payload
        .get("tangent_field_payload_path")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.tangent_payload_encoding = payload
        .get("tangent_payload_encoding")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.tangent_value_kind = payload
        .get("tangent_value_kind")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.tangent_component_basis = payload
        .get("tangent_component_basis")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.tangent_component_count = payload
        .get("tangent_component_count")
        .and_then(Value::as_u64);
    metadata.tangent_components = payload
        .get("tangent_components")
        .and_then(Value::as_array)
        .map(|components| {
            components
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .filter(|components| !components.is_empty());
    metadata.tangent_complex_pair_count = payload
        .get("tangent_complex_pair_count")
        .and_then(Value::as_u64);
    metadata.tangent_payload_value_count = payload
        .get("tangent_payload_value_count")
        .and_then(Value::as_u64);
    if let Some(available_views) = payload.get("available_views") {
        metadata.available_views = parse_available_views(
            frequency_point_artifact_path,
            "frequency response field",
            available_views,
        )?;
    }
    metadata.default_view = payload
        .get("default_view")
        .and_then(Value::as_str)
        .unwrap_or(&metadata.default_view)
        .to_string();
    metadata.default_phase_rad = payload
        .get("default_phase_rad")
        .and_then(Value::as_f64)
        .or(metadata.default_phase_rad);
    validate_component_count(
        frequency_point_artifact_path,
        "frequency response field",
        metadata.component_count,
        true,
    )?;
    validate_complex_payload_counts(
        frequency_point_artifact_path,
        "frequency response field",
        metadata.complex_pair_count,
        metadata.payload_value_count,
        true,
    )?;
    validate_available_views(
        frequency_point_artifact_path,
        "frequency response field",
        &metadata.available_views,
    )?;
    validate_default_view(
        frequency_point_artifact_path,
        "frequency response field",
        &metadata.available_views,
        &metadata.default_view,
    )?;
    validate_default_phase_rad(
        frequency_point_artifact_path,
        "frequency response field",
        metadata.default_phase_rad,
    )?;
    let tangent_metadata_present = metadata.tangent_field_payload_path.is_some()
        || metadata.tangent_component_count.is_some()
        || metadata.tangent_complex_pair_count.is_some()
        || metadata.tangent_payload_value_count.is_some();
    validate_component_count(
        frequency_point_artifact_path,
        "frequency response tangent field",
        metadata.tangent_component_count,
        tangent_metadata_present,
    )?;
    validate_complex_payload_counts(
        frequency_point_artifact_path,
        "frequency response tangent field",
        metadata.tangent_complex_pair_count,
        metadata.tangent_payload_value_count,
        tangent_metadata_present,
    )?;
    Ok(metadata)
}

fn eigen_mode_field_metadata(
    artifact_dir: &std::path::Path,
    sample_index: u32,
    mode_index: u32,
    artifact_path: &str,
) -> Result<Option<FrequencyDomainFieldMetadata>, ApiError> {
    let mode_artifact_path = format!(
        "eigen/modes/sample_{:04}/mode_{:04}.json",
        sample_index, mode_index
    );
    let mode_metadata =
        eigen_mode_field_metadata_from_mode_artifact(artifact_dir, &mode_artifact_path)?;
    let payload_metadata = eigen_mode_field_payload_metadata(artifact_dir, artifact_path)?;
    if mode_metadata.is_none() && payload_metadata.is_some() {
        return Err(ApiError::internal(format!(
            "eigen mode field payload '{}' is present but metadata '{}' is missing",
            artifact_path, mode_artifact_path
        )));
    }
    let mut metadata = mode_metadata.unwrap_or_default();
    if let Some(payload_metadata) = payload_metadata {
        if let Some(payload_value_count) = payload_metadata.payload_value_count {
            let expected = metadata.payload_value_count.unwrap_or(payload_value_count);
            if expected != payload_value_count {
                return Err(ApiError::internal(format!(
                    "eigen mode field payload_value_count mismatch between '{}' and '{}'",
                    mode_artifact_path, artifact_path
                )));
            }
            metadata.payload_value_count = Some(payload_value_count);
        }
        if let Some(complex_pair_count) = payload_metadata.complex_pair_count {
            let expected = metadata.complex_pair_count.unwrap_or(complex_pair_count);
            if expected != complex_pair_count {
                return Err(ApiError::internal(format!(
                    "eigen mode field complex_pair_count mismatch between '{}' and '{}'",
                    mode_artifact_path, artifact_path
                )));
            }
            metadata.complex_pair_count = Some(complex_pair_count);
        }
    }
    validate_component_count(
        &mode_artifact_path,
        "eigen mode field",
        metadata.component_count,
        true,
    )?;
    validate_complex_payload_counts(
        &mode_artifact_path,
        "eigen mode field",
        metadata.complex_pair_count,
        metadata.payload_value_count,
        try_resolve_artifact_path(artifact_dir, artifact_path)?.is_some(),
    )?;
    validate_available_views(
        &mode_artifact_path,
        "eigen mode field",
        &metadata.available_views,
    )?;
    validate_default_view(
        &mode_artifact_path,
        "eigen mode field",
        &metadata.available_views,
        &metadata.default_view,
    )?;
    validate_default_phase_rad(
        &mode_artifact_path,
        "eigen mode field",
        metadata.default_phase_rad,
    )?;
    Ok(Some(metadata))
}

fn eigen_mode_artifact_path(sample_index: u32, mode_index: u32) -> String {
    format!("eigen/modes/sample_{sample_index:04}/mode_{mode_index:04}.json")
}

fn legacy_eigen_mode_field_payload_path(sample_index: u32, mode_index: u32) -> String {
    format!("eigen/mode_fields/sample_{sample_index:04}/mode_{mode_index:04}/vector.bin")
}

fn eigen_mode_field_preferred_payload_path(
    artifact_dir: &std::path::Path,
    sample_index: u32,
    mode_index: u32,
) -> Result<String, ApiError> {
    let mode_artifact_path = eigen_mode_artifact_path(sample_index, mode_index);
    if try_resolve_artifact_path(artifact_dir, &mode_artifact_path)?.is_some() {
        let mode = read_json_artifact_value(artifact_dir, &mode_artifact_path)?;
        for field in ["zarr_chunk_path", "compatibility_binary_payload_path"] {
            if let Some(path) = mode.get(field).and_then(Value::as_str) {
                if try_resolve_artifact_path(artifact_dir, path)?.is_some() {
                    return Ok(path.to_string());
                }
            }
        }
    }
    Ok(legacy_eigen_mode_field_payload_path(
        sample_index,
        mode_index,
    ))
}

fn eigen_mode_field_metadata_from_mode_artifact(
    artifact_dir: &std::path::Path,
    mode_artifact_path: &str,
) -> Result<Option<FrequencyDomainFieldMetadata>, ApiError> {
    let Some(path) = try_resolve_artifact_path(artifact_dir, mode_artifact_path)? else {
        return Ok(None);
    };
    let payload: Value = serde_json::from_slice(&std::fs::read(&path).map_err(|error| {
        ApiError::internal(format!(
            "failed to read eigen mode field metadata '{}': {}",
            mode_artifact_path, error
        ))
    })?)
    .map_err(|error| {
        ApiError::internal(format!(
            "invalid eigen mode field metadata JSON '{}': {}",
            mode_artifact_path, error
        ))
    })?;
    let mut metadata = FrequencyDomainFieldMetadata::default();
    metadata.value_kind = payload
        .get("value_kind")
        .and_then(Value::as_str)
        .unwrap_or(&metadata.value_kind)
        .to_string();
    metadata.component_basis = payload
        .get("component_basis")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(metadata.component_basis);
    metadata.component_count = payload.get("component_count").and_then(Value::as_u64);
    if let Some(components) = payload.get("components") {
        metadata.components = parse_available_views(
            mode_artifact_path,
            "eigen mode field components",
            components,
        )?;
    }
    metadata.payload_encoding = payload
        .get("payload_encoding")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.binary_layout = payload
        .get("binary_layout")
        .and_then(Value::as_str)
        .map(str::to_string);
    metadata.complex_pair_count = payload.get("complex_pair_count").and_then(Value::as_u64);
    metadata.payload_value_count = payload.get("payload_value_count").and_then(Value::as_u64);
    copy_storage_metadata(
        &payload,
        &mut metadata,
        mode_artifact_path,
        "eigen mode field",
    )?;
    if let Some(available_views) = payload.get("available_views") {
        metadata.available_views =
            parse_available_views(mode_artifact_path, "eigen mode field", available_views)?;
    }
    metadata.default_view = payload
        .get("default_view")
        .and_then(Value::as_str)
        .unwrap_or(&metadata.default_view)
        .to_string();
    metadata.default_phase_rad = payload
        .get("default_phase_rad")
        .and_then(Value::as_f64)
        .or(metadata.default_phase_rad);
    Ok(Some(metadata))
}

fn eigen_mode_field_payload_metadata(
    artifact_dir: &std::path::Path,
    artifact_path: &str,
) -> Result<Option<FrequencyDomainFieldMetadata>, ApiError> {
    let Some(path) = try_resolve_artifact_path(artifact_dir, artifact_path)? else {
        return Ok(None);
    };
    let byte_count = std::fs::metadata(&path)
        .map_err(|error| {
            ApiError::internal(format!(
                "failed to read eigen mode field payload metadata '{}': {}",
                artifact_path, error
            ))
        })?
        .len();
    if byte_count % 8 != 0 {
        return Err(ApiError::internal(format!(
            "invalid eigen mode field payload byte count in '{}'",
            artifact_path
        )));
    }
    let payload_value_count = byte_count / 8;
    if payload_value_count == 0 || payload_value_count % 6 != 0 {
        return Err(ApiError::internal(format!(
            "eigen mode field payload '{}' must contain complex xyz vector values",
            artifact_path
        )));
    }
    let mut metadata = FrequencyDomainFieldMetadata::default();
    metadata.value_kind = "complex_spatial_vector".to_string();
    metadata.component_basis = Some("global_xyz".to_string());
    metadata.payload_encoding = Some("f64_interleaved_real_imag_xyz".to_string());
    metadata.binary_layout = Some("complex_f64_pairs_little_endian".to_string());
    metadata.complex_pair_count = Some(payload_value_count / 2);
    metadata.payload_value_count = Some(payload_value_count);
    Ok(Some(metadata))
}

fn validate_component_count(
    artifact_path: &str,
    label: &str,
    component_count: Option<u64>,
    required: bool,
) -> Result<(), ApiError> {
    let Some(component_count) = component_count else {
        if required {
            return Err(ApiError::internal(format!(
                "missing required {label} component_count in '{artifact_path}'"
            )));
        }
        return Ok(());
    };
    if component_count == 0 || component_count > 64 {
        return Err(ApiError::internal(format!(
            "invalid {label} component_count in '{artifact_path}'"
        )));
    }
    Ok(())
}

fn validate_available_views(
    artifact_path: &str,
    label: &str,
    available_views: &[String],
) -> Result<(), ApiError> {
    for required_view in ["complex", "real", "imag", "phase", "phase_rotated_real"] {
        if !available_views.iter().any(|view| view == required_view) {
            return Err(ApiError::internal(format!(
                "missing required {label} available view '{required_view}' in '{artifact_path}'"
            )));
        }
    }
    if !available_views
        .iter()
        .any(|view| view == "abs" || view == "amplitude")
    {
        return Err(ApiError::internal(format!(
            "missing required {label} available view 'abs' or 'amplitude' in '{artifact_path}'"
        )));
    }
    Ok(())
}

fn parse_available_views(
    artifact_path: &str,
    label: &str,
    value: &Value,
) -> Result<Vec<String>, ApiError> {
    let Some(views) = value.as_array() else {
        return Err(ApiError::internal(format!(
            "invalid {label} available_views in '{artifact_path}'"
        )));
    };
    if views.is_empty() {
        return Err(ApiError::internal(format!(
            "invalid {label} available_views in '{artifact_path}'"
        )));
    }
    views
        .iter()
        .map(|view| {
            view.as_str().map(str::to_string).ok_or_else(|| {
                ApiError::internal(format!(
                    "invalid {label} available_views in '{artifact_path}'"
                ))
            })
        })
        .collect()
}

fn validate_default_view(
    artifact_path: &str,
    label: &str,
    available_views: &[String],
    default_view: &str,
) -> Result<(), ApiError> {
    if !available_views.iter().any(|view| view == default_view) {
        return Err(ApiError::internal(format!(
            "invalid {label} default_view '{default_view}' is not listed in available_views in '{artifact_path}'"
        )));
    }
    Ok(())
}

fn validate_default_phase_rad(
    artifact_path: &str,
    label: &str,
    default_phase_rad: Option<f64>,
) -> Result<(), ApiError> {
    let Some(default_phase_rad) = default_phase_rad else {
        return Ok(());
    };
    if !default_phase_rad.is_finite() {
        return Err(ApiError::internal(format!(
            "invalid {label} default_phase_rad in '{artifact_path}'"
        )));
    }
    Ok(())
}

fn validate_complex_payload_counts(
    artifact_path: &str,
    label: &str,
    complex_pair_count: Option<u64>,
    payload_value_count: Option<u64>,
    required: bool,
) -> Result<(), ApiError> {
    let Some(complex_pair_count) = complex_pair_count else {
        if required {
            return Err(ApiError::internal(format!(
                "missing required {label} complex_pair_count in '{artifact_path}'"
            )));
        }
        return Ok(());
    };
    let Some(payload_value_count) = payload_value_count else {
        if required {
            return Err(ApiError::internal(format!(
                "missing required {label} payload_value_count in '{artifact_path}'"
            )));
        }
        return Ok(());
    };
    let Some(expected_payload_value_count) = complex_pair_count.checked_mul(2) else {
        return Err(ApiError::internal(format!(
            "{label} complex_pair_count overflows payload_value_count in '{artifact_path}'"
        )));
    };
    if payload_value_count != expected_payload_value_count {
        return Err(ApiError::internal(format!(
            "invalid {label} payload_value_count in '{artifact_path}'"
        )));
    }
    Ok(())
}
