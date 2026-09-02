//! Frequency-domain analysis family manifest and artifact resource endpoints.

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use utoipa::{PartialSchema, ToSchema};

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
    pub payload: Option<FrequencyDomainJsonArtifactPayload>,
    /// Content-addressed revision of the immutable JSON artifact bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// SHA-256 digest of the immutable JSON artifact bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_digest: Option<String>,
    /// Actual session that owns the current immutable artifact directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Actual run that owns the current immutable artifact directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Actual stage that published the artifact, when available in live state.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    /// Runtime mesh generation bound to the publishing stage.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_generation_id: Option<String>,
    pub missing_reason: Option<String>,
}

/// Typed control-plane payloads published by the frequency-domain artifact
/// family.  The enum is intentionally untagged so the JSON body remains
/// backward compatible with the existing artifact files: the artifact's
/// `schema_version` remains the discriminator on the wire.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum FrequencyDomainJsonArtifactPayload {
    Manifest(FrequencyDomainManifestArtifactPayload),
    SpectrumV3(FrequencyDomainSpectrumV3ArtifactPayload),
    Spectrum(FrequencyDomainSpectrumArtifactPayload),
    Branches(FrequencyDomainBranchesArtifactPayload),
    FieldSweep(FrequencyDomainFieldSweepArtifactPayload),
    Diagnostics(FrequencyDomainDiagnosticsArtifactPayload),
    Mode(FrequencyDomainModeArtifactPayload),
    ResponseSweep(FrequencyDomainResponseSweepArtifactPayload),
    ResponsePoint(FrequencyDomainResponsePointPayload),
    FmrPeaks(FrequencyDomainFmrPeaksArtifactPayload),
    ResonanceFits(FrequencyDomainResonanceFitsArtifactPayload),
    KittelFit(FrequencyDomainKittelFitArtifactPayload),
}

/// Forward-compatible JSON members preserved beside the documented payload
/// fields. Its schema deliberately permits arbitrary values.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FrequencyDomainArtifactExtras(pub BTreeMap<String, Value>);

impl PartialSchema for FrequencyDomainArtifactExtras {
    fn schema() -> utoipa::openapi::RefOr<utoipa::openapi::schema::Schema> {
        utoipa::openapi::ObjectBuilder::new()
            .additional_properties(Some(
                utoipa::openapi::schema::AdditionalProperties::FreeForm(true),
            ))
            .into()
    }
}

impl ToSchema for FrequencyDomainArtifactExtras {}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainManifestArtifactPayload {
    pub schema_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub study_product: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solve_succeeded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spectrum_completeness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_identity: Option<FrequencyDomainCandidateIdentityPayload>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainSpectrumArtifactPayload {
    pub schema_version: String,
    pub samples: Vec<FrequencyDomainSpectrumSamplePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solve_succeeded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spectrum_completeness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_identity: Option<FrequencyDomainCandidateIdentityPayload>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainCandidateIdentityPayload {
    pub schema_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equilibrium_artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[schema(value_type = Object)]
    pub source_identity: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainSpectrumSamplePayload {
    /// Stable sample identity; `sample_index` is presentation order only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<Vec<FrequencyDomainSpectrumModePayload>>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainSpectrumModePayload {
    /// Stable mode identity within a spectrum sample.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_mode_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_real_hz: Option<f64>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

/// Per-object modal-spectrum contract. Unlike `eigen_spectrum.v2`, this
/// version owns stable sample/mode identities and component participation.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainSpectrumV3ArtifactPayload {
    pub schema_version: String,
    pub samples: Vec<FrequencyDomainSpectrumV3SamplePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solve_succeeded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spectrum_completeness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_identity: Option<FrequencyDomainCandidateIdentityPayload>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainSpectrumV3SamplePayload {
    pub sample_id: String,
    pub sample_index: u64,
    pub modes: Vec<FrequencyDomainSpectrumV3ModePayload>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainSpectrumV3ModePayload {
    pub mode_id: String,
    pub raw_mode_index: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<u64>,
    pub frequency_hz: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_field_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_field_resource_key: Option<String>,
    pub residual_relative_l2: f64,
    pub component_participation: FrequencyDomainModalParticipationPayload,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainModalParticipationPayload {
    pub schema_version: String,
    pub definition_id: String,
    pub status: FrequencyDomainModalParticipationStatus,
    pub quantity_id: String,
    pub quantity_symbol: String,
    pub unit: String,
    pub component_basis: String,
    pub integration_method: String,
    pub qualification: String,
    pub provenance: FrequencyDomainModalParticipationProvenancePayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub global: Option<FrequencyDomainModalParticipationFractionsPayload>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<FrequencyDomainModalObjectParticipationPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable: Option<FrequencyDomainModalParticipationUnavailablePayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrequencyDomainModalParticipationStatus {
    Ready,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainModalParticipationProvenancePayload {
    pub solver_device: String,
    pub observable_lane: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_mesh_identity: Option<FrequencyDomainModeSourceMeshIdentityPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainModalParticipationFractionsPayload {
    pub total: f64,
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainModalObjectParticipationPayload {
    pub object_id: String,
    pub total_fraction: f64,
    pub components: FrequencyDomainModalParticipationFractionsPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainModalParticipationUnavailablePayload {
    pub reason_code: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainBranchesArtifactPayload {
    pub schema_version: String,
    pub branches: Vec<FrequencyDomainBranchPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<FrequencyDomainTrackingDiagnosticsPayload>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainBranchPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<FrequencyDomainBranchPointPayload>>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainBranchPointPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_mode_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_hz: Option<f64>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainTrackingDiagnosticsPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracking_score_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modal_overlap_available: Option<bool>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepAxisPayload {
    pub kind: String,
    pub coordinate: String,
    pub unit: String,
    pub display_conversions: Vec<FrequencyDomainFieldSweepDisplayConversionPayload>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepDisplayConversionPayload {
    pub name: String,
    pub unit: String,
    pub scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepSourcePayload {
    pub kind: String,
    pub artifact: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepUnitsPayload {
    pub frequency: String,
    pub angular_frequency: String,
    pub bias_field: String,
    pub bias_field_display: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_amplitude: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linewidth: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub q_factor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub covariance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepTopologyPayload {
    pub mesh_id: String,
    pub topology_revision: String,
    pub indexing: String,
    pub sample_axis: String,
    pub mode_axis: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepExecutionPayload {
    pub backend: String,
    pub device: String,
    pub precision: String,
    pub execution_mode: String,
    pub engine: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub implementation_id: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_used: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepReferencePayload {
    pub relation: String,
    pub artifact: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepModePayload {
    pub sample_id: String,
    pub mode_id: String,
    pub raw_mode_index: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<u64>,
    pub frequency_hz: f64,
    pub angular_frequency_rad_per_s: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_artifact_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_field_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_field_resource_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub residual_relative_l2: Option<f64>,
    pub source_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_status: Option<String>,
    pub status: String,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepArtifactPayload {
    pub schema_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<FrequencyDomainFieldSweepSourcePayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_sample_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_sample_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_axis: Option<FrequencyDomainFieldSweepAxisPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub units: Option<FrequencyDomainFieldSweepUnitsPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology: Option<FrequencyDomainFieldSweepTopologyPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_execution: Option<FrequencyDomainFieldSweepExecutionPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_execution: Option<FrequencyDomainFieldSweepExecutionPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub samples: Option<Vec<FrequencyDomainFieldSweepSamplePayload>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cross_artifact_refs: Option<Vec<FrequencyDomainFieldSweepReferencePayload>>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFieldSweepSamplePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bias_field_a_per_m: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bias_field_mu0_t: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_axis: Option<FrequencyDomainFieldSweepAxisPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equilibrium_artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linearization_state_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operator_input_signature_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology: Option<FrequencyDomainFieldSweepTopologyPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_ids: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<Vec<FrequencyDomainFieldSweepModePayload>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainDiagnosticsArtifactPayload {
    pub schema_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainModeSourceMeshIdentityPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_generation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_revision: Option<u64>,
    pub topology_fingerprint: String,
    pub indexing: String,
    pub node_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainModeArtifactPayload {
    pub schema_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_mode_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_basis: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_mesh_identity: Option<FrequencyDomainModeSourceMeshIdentityPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_spectrum_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solve_succeeded: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spectrum_completeness: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate_identity: Option<FrequencyDomainCandidateIdentityPayload>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainResponseSweepArtifactPayload {
    pub schema_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<FrequencyDomainResponsePointPayload>>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainResponsePointPayload {
    /// Stable response-point identity; `frequency_index` is presentation order only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_hz: Option<f64>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFmrPeaksArtifactPayload {
    pub schema_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interrupted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peaks: Option<Vec<FrequencyDomainFmrPeakPayload>>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainFmrPeakPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frequency_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainResonanceFitsArtifactPayload {
    pub schema_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fits: Option<Vec<FrequencyDomainResonanceFitPayload>>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainResonanceFitPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_frequency_hz: Option<f64>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainKittelFitArtifactPayload {
    pub schema_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complete: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validation_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<Vec<FrequencyDomainKittelFitPointPayload>>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FrequencyDomainKittelFitPointPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solved_frequency_hz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_frequency_error: Option<f64>,
    #[serde(flatten)]
    pub extra: FrequencyDomainArtifactExtras,
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
    /// Content-addressed revision of the immutable field payload bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// SHA-256 digest of the immutable field payload bytes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_digest: Option<String>,
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
    path = "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v3",
    responses((status = 200, description = "Frequency-domain eigen spectrum v3 resource with per-object component participation", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_eigen_spectrum_v3(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_eigen_spectrum.v3",
        "eigen/spectrum.v3.json",
        "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v3",
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
    path = "/v2/sessions/current/analysis/frequency-domain/eigen/field-sweep",
    responses((status = 200, description = "Frequency-domain eigen field sweep resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_eigen_field_sweep(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_eigen_field_sweep_resource.v1",
        "eigen/field_sweep.v1.json",
        "/v2/sessions/current/analysis/frequency-domain/eigen/field-sweep",
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
    path = "/v2/sessions/current/analysis/frequency-domain/eigen/modes/{sample_index}/{mode_index}",
    params(
        ("sample_index" = u32, Path, description = "K-path sample index"),
        ("mode_index" = u32, Path, description = "Raw mode index within the sample"),
    ),
    responses((status = 200, description = "Revisioned frequency-domain eigen mode resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_eigen_mode(
    State(state): State<Arc<AppState>>,
    Path((sample_index, mode_index)): Path<(u32, u32)>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    let artifact_path = eigen_mode_artifact_path(sample_index, mode_index);
    let resource_key = format!(
        "/v2/sessions/current/analysis/frequency-domain/eigen/modes/{sample_index}/{mode_index}"
    );
    json_artifact_resource(
        &state,
        "frequency_domain_eigen_mode_resource.v1",
        &artifact_path,
        &resource_key,
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
    path = "/v2/sessions/current/analysis/frequency-domain/fmr/peaks",
    responses((status = 200, description = "Frequency-domain FMR peaks resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_fmr_peaks(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_fmr_peaks_resource.v1",
        "fmr/peaks.v1.json",
        "/v2/sessions/current/analysis/frequency-domain/fmr/peaks",
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/fmr/resonance-fits",
    responses((status = 200, description = "Frequency-domain FMR resonance fits resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_fmr_resonance_fits(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_fmr_resonance_fits_resource.v1",
        "fmr/resonance_fits.v1.json",
        "/v2/sessions/current/analysis/frequency-domain/fmr/resonance-fits",
    )
    .await
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/fmr/kittel-fit",
    responses((status = 200, description = "Frequency-domain FMR Kittel fit resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
pub async fn get_frequency_domain_fmr_kittel_fit(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrequencyDomainJsonArtifactResource>, ApiError> {
    json_artifact_resource(
        &state,
        "frequency_domain_fmr_kittel_fit_resource.v1",
        "fmr/kittel_fit.v1.json",
        "/v2/sessions/current/analysis/frequency-domain/fmr/kittel-fit",
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

#[utoipa::path(
    get,
    path = "/v2/sessions/current/analysis/frequency-domain/response/diagnostics.v1",
    responses((status = 200, description = "Frequency-domain response diagnostics compatibility resource", body = FrequencyDomainJsonArtifactResource)),
    tag = "analysis"
)]
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
            let live_identity = frequency_domain_live_artifact_identity(state, artifact_path).await;
            let payload_value = read_json_artifact_value(&artifact_dir, artifact_path)?;
            let payload = decode_frequency_domain_artifact_payload(artifact_path, payload_value)?;
            let content_digest =
                frequency_domain_artifact_content_digest(&artifact_dir, artifact_path)?;
            return Ok(Json(FrequencyDomainJsonArtifactResource {
                schema_version: schema_version.to_string(),
                status: "ready".to_string(),
                artifact_path: (*artifact_path).to_string(),
                resource_key: resource_key.to_string(),
                payload: Some(payload),
                revision: Some(content_digest.clone()),
                content_digest: Some(content_digest),
                session_id: live_identity.session_id,
                run_id: live_identity.run_id,
                stage_id: live_identity.stage_id,
                mesh_generation_id: live_identity.mesh_generation_id,
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
        revision: None,
        content_digest: None,
        session_id: None,
        run_id: None,
        stage_id: None,
        mesh_generation_id: None,
        missing_reason: Some("artifact is not present in the active workspace".to_string()),
    }))
}

#[derive(Default)]
struct FrequencyDomainLiveArtifactIdentity {
    session_id: Option<String>,
    run_id: Option<String>,
    stage_id: Option<String>,
    mesh_generation_id: Option<String>,
}

async fn frequency_domain_live_artifact_identity(
    state: &Arc<AppState>,
    artifact_path: &str,
) -> FrequencyDomainLiveArtifactIdentity {
    let current = state.current_live_state.read().await;
    let Some(snapshot) = current.as_ref() else {
        return FrequencyDomainLiveArtifactIdentity::default();
    };
    let expected_kind_fragment = if artifact_path.starts_with("eigen/") {
        Some("eigen")
    } else if artifact_path.starts_with("response/") {
        Some("frequency")
    } else {
        None
    };
    let stage = snapshot.stage_execution.as_ref().and_then(|execution| {
        execution
            .stages
            .iter()
            .rev()
            .find(|stage| {
                stage.artifact_refs.iter().any(|reference| {
                    reference == artifact_path || reference.ends_with(artifact_path)
                })
            })
            .or_else(|| {
                expected_kind_fragment.and_then(|fragment| {
                    execution.stages.iter().rev().find(|stage| {
                        stage
                            .kind
                            .as_deref()
                            .is_some_and(|kind| kind.contains(fragment))
                    })
                })
            })
            .or_else(|| {
                execution
                    .active_stage_index
                    .and_then(|index| execution.stages.get(index))
            })
    });
    FrequencyDomainLiveArtifactIdentity {
        session_id: Some(snapshot.session.session_id.clone()),
        run_id: snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.clone())
            .or_else(|| Some(snapshot.session.run_id.clone())),
        stage_id: stage.and_then(|stage| stage.stage_id.clone()),
        mesh_generation_id: stage
            .and_then(|stage| stage.mesh_generation_id.clone())
            .or_else(|| {
                snapshot
                    .live_state
                    .as_ref()
                    .and_then(|live| live.latest_step.fem_mesh_generation_id.clone())
            })
            .or_else(|| {
                snapshot
                    .fem_mesh
                    .as_ref()
                    .and_then(|mesh| mesh.generation_id.clone())
            }),
    }
}

fn frequency_domain_artifact_content_digest(
    artifact_dir: &std::path::Path,
    artifact_path: &str,
) -> Result<String, ApiError> {
    let resolved = try_resolve_artifact_path(artifact_dir, artifact_path)?
        .ok_or_else(|| ApiError::not_found(format!("artifact '{artifact_path}' is not present")))?;
    let bytes = std::fs::read(&resolved).map_err(|error| {
        ApiError::internal(format!(
            "failed to read frequency-domain artifact '{}': {error}",
            artifact_path
        ))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

pub(crate) fn decode_frequency_domain_artifact_payload(
    artifact_path: &str,
    value: Value,
) -> Result<FrequencyDomainJsonArtifactPayload, ApiError> {
    let object = value.as_object().ok_or_else(|| {
        ApiError::internal(format!(
            "frequency-domain artifact '{}' must contain a JSON object payload",
            artifact_path
        ))
    })?;
    let schema_version = object
        .get("schema_version")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ApiError::internal(format!(
                "frequency-domain artifact '{}' is missing string schema_version",
                artifact_path
            ))
        })?
        .to_string();
    let (allowed_schemas, payload) = if artifact_path == "frequency_domain/manifest.v1.json" {
        (
            &["frequency_domain_manifest.v1" as &str][..],
            serde_json::from_value::<FrequencyDomainManifestArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::Manifest),
        )
    } else if artifact_path == "eigen/spectrum.v2.json" {
        (
            &["eigen_spectrum.v2" as &str][..],
            serde_json::from_value::<FrequencyDomainSpectrumArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::Spectrum),
        )
    } else if artifact_path == "eigen/spectrum.v3.json" {
        (
            &["eigen_spectrum.v3" as &str][..],
            serde_json::from_value::<FrequencyDomainSpectrumV3ArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::SpectrumV3),
        )
    } else if artifact_path == "eigen/branches.v2.json" {
        (
            &["eigen_branches.v2" as &str][..],
            serde_json::from_value::<FrequencyDomainBranchesArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::Branches),
        )
    } else if artifact_path == "eigen/field_sweep.v1.json" {
        (
            &["eigen/field_sweep.v1" as &str][..],
            serde_json::from_value::<FrequencyDomainFieldSweepArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::FieldSweep),
        )
    } else if artifact_path == "eigen/diagnostics.v2.json"
        || artifact_path == "eigen/diagnostics/solver.v1.json"
    {
        (
            &[
                "frequency_domain_modal_solver_diagnostics.v1",
                "frequency_domain_modal_solver_diagnostics.v2",
            ][..],
            serde_json::from_value::<FrequencyDomainDiagnosticsArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::Diagnostics),
        )
    } else if artifact_path.starts_with("eigen/modes/") {
        (
            &["eigen_mode.v2" as &str][..],
            serde_json::from_value::<FrequencyDomainModeArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::Mode),
        )
    } else if artifact_path == "response/magnetic_response_sweep.v1.json"
        || artifact_path == "response/magnetic_response_sweep.v2.json"
    {
        (
            &["magnetic_response_sweep.v1", "magnetic_response_sweep.v2"][..],
            serde_json::from_value::<FrequencyDomainResponseSweepArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::ResponseSweep),
        )
    } else if artifact_path.starts_with("response/frequency_points/") {
        (
            &["frequency_response_point.v1" as &str][..],
            serde_json::from_value::<FrequencyDomainResponsePointPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::ResponsePoint),
        )
    } else if artifact_path == "response/diagnostics/solver.v1.json"
        || artifact_path == "response/diagnostics.v1.json"
    {
        (
            &[
                "frequency_domain_response_diagnostics.v1",
                "frequency_domain_response_diagnostics.v2",
            ][..],
            serde_json::from_value::<FrequencyDomainDiagnosticsArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::Diagnostics),
        )
    } else if artifact_path == "fmr/peaks.v1.json" {
        (
            &["fmr/peaks.v1" as &str][..],
            serde_json::from_value::<FrequencyDomainFmrPeaksArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::FmrPeaks),
        )
    } else if artifact_path == "fmr/resonance_fits.v1.json" {
        (
            &["fmr/resonance_fits.v1" as &str][..],
            serde_json::from_value::<FrequencyDomainResonanceFitsArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::ResonanceFits),
        )
    } else if artifact_path == "fmr/kittel_fit.v1.json" {
        (
            &["fmr/kittel_fit.v1" as &str][..],
            serde_json::from_value::<FrequencyDomainKittelFitArtifactPayload>(value)
                .map(FrequencyDomainJsonArtifactPayload::KittelFit),
        )
    } else {
        return Err(ApiError::internal(format!(
            "unsupported frequency-domain JSON artifact path '{}', refusing untyped payload",
            artifact_path
        )));
    };

    if !allowed_schemas.contains(&schema_version.as_str()) {
        return Err(ApiError::internal(format!(
            "frequency-domain artifact '{}' has unsupported schema_version '{}', expected one of {}",
            artifact_path,
            schema_version,
            allowed_schemas.join(", ")
        )));
    }

    let payload = payload.map_err(|error| {
        ApiError::internal(format!(
            "invalid typed frequency-domain artifact '{}': {error}",
            artifact_path
        ))
    })?;
    if let FrequencyDomainJsonArtifactPayload::SpectrumV3(spectrum) = &payload {
        validate_frequency_domain_spectrum_v3(spectrum)?;
    }
    if let FrequencyDomainJsonArtifactPayload::FieldSweep(field_sweep) = &payload {
        validate_frequency_domain_field_sweep(field_sweep)?;
    }
    Ok(payload)
}

fn validate_frequency_domain_field_sweep(
    field_sweep: &FrequencyDomainFieldSweepArtifactPayload,
) -> Result<(), ApiError> {
    let has_typed_contract = field_sweep.source.is_some()
        || field_sweep.source_revision.is_some()
        || field_sweep.revision.is_some()
        || field_sweep.scan_axis.is_some()
        || field_sweep.units.is_some()
        || field_sweep.topology.is_some()
        || field_sweep.requested_execution.is_some()
        || field_sweep.resolved_execution.is_some()
        || field_sweep.cross_artifact_refs.is_some();
    if !has_typed_contract {
        return Ok(());
    }

    let Some(source) = field_sweep.source.as_ref() else {
        return Err(ApiError::internal(
            "eigen field sweep is missing typed source provenance",
        ));
    };
    let Some(source_revision) = field_sweep.source_revision.as_ref() else {
        return Err(ApiError::internal(
            "eigen field sweep is missing source_revision",
        ));
    };
    let Some(revision) = field_sweep.revision.as_ref() else {
        return Err(ApiError::internal(
            "eigen field sweep is missing dataset revision",
        ));
    };
    let Some(requested_sample_count) = field_sweep.requested_sample_count else {
        return Err(ApiError::internal(
            "eigen field sweep is missing requested_sample_count",
        ));
    };
    let Some(completed_sample_count) = field_sweep.completed_sample_count else {
        return Err(ApiError::internal(
            "eigen field sweep is missing completed_sample_count",
        ));
    };
    let Some(scan_axis) = field_sweep.scan_axis.as_ref() else {
        return Err(ApiError::internal(
            "eigen field sweep is missing typed scan_axis",
        ));
    };
    let Some(units) = field_sweep.units.as_ref() else {
        return Err(ApiError::internal(
            "eigen field sweep is missing typed units",
        ));
    };
    let Some(topology) = field_sweep.topology.as_ref() else {
        return Err(ApiError::internal(
            "eigen field sweep is missing typed topology",
        ));
    };
    let Some(requested_execution) = field_sweep.requested_execution.as_ref() else {
        return Err(ApiError::internal(
            "eigen field sweep is missing requested_execution provenance",
        ));
    };
    let Some(resolved_execution) = field_sweep.resolved_execution.as_ref() else {
        return Err(ApiError::internal(
            "eigen field sweep is missing resolved_execution provenance",
        ));
    };
    let Some(samples) = field_sweep.samples.as_ref() else {
        return Err(ApiError::internal(
            "eigen field sweep is missing typed samples",
        ));
    };
    let Some(cross_artifact_refs) = field_sweep.cross_artifact_refs.as_ref() else {
        return Err(ApiError::internal(
            "eigen field sweep is missing cross_artifact_refs",
        ));
    };

    if source.kind.trim().is_empty()
        || source.artifact.trim().is_empty()
        || source.revision.trim().is_empty()
        || source_revision.trim().is_empty()
        || revision.trim().is_empty()
    {
        return Err(ApiError::internal(
            "eigen field sweep has incomplete source or revision provenance",
        ));
    }
    if source.revision != *source_revision {
        return Err(ApiError::internal(
            "eigen field sweep source revision does not match source provenance",
        ));
    }
    if completed_sample_count > requested_sample_count {
        return Err(ApiError::internal(
            "eigen field sweep completed_sample_count exceeds requested_sample_count",
        ));
    }
    if field_sweep.complete == Some(true)
        && (completed_sample_count != requested_sample_count
            || samples.len() as u64 != completed_sample_count)
    {
        return Err(ApiError::internal(
            "complete eigen field sweep has inconsistent sample counts",
        ));
    }

    validate_field_sweep_axis(scan_axis, "eigen field sweep scan_axis")?;
    if units.frequency.trim().is_empty()
        || units.angular_frequency.trim().is_empty()
        || units.bias_field.trim().is_empty()
        || units.bias_field_display.trim().is_empty()
    {
        return Err(ApiError::internal(
            "eigen field sweep has incomplete units metadata",
        ));
    }
    validate_field_sweep_topology(topology, "eigen field sweep topology")?;
    validate_field_sweep_execution(requested_execution, "requested_execution")?;
    validate_field_sweep_execution(resolved_execution, "resolved_execution")?;

    let mut sample_ids = BTreeSet::new();
    let mut mode_ids = BTreeSet::new();
    for sample in samples {
        let Some(sample_id) = sample.sample_id.as_ref() else {
            return Err(ApiError::internal(
                "eigen field sweep contains a sample without sample_id",
            ));
        };
        if sample_id.trim().is_empty() || !sample_ids.insert(sample_id) {
            return Err(ApiError::internal(
                "eigen field sweep contains missing or duplicate sample_id",
            ));
        }
        if let Some(axis) = sample.scan_axis.as_ref() {
            validate_field_sweep_axis(axis, "eigen field sweep sample scan_axis")?;
        }
        if let Some(field) = sample.bias_field_a_per_m {
            if field.iter().any(|value| !value.is_finite()) {
                return Err(ApiError::internal(
                    "eigen field sweep contains non-finite bias_field_a_per_m",
                ));
            }
        }
        if let Some(field) = sample.bias_field_mu0_t {
            if field.iter().any(|value| !value.is_finite()) {
                return Err(ApiError::internal(
                    "eigen field sweep contains non-finite bias_field_mu0_t",
                ));
            }
        }
        if let Some(sample_topology) = sample.topology.as_ref() {
            validate_field_sweep_topology(sample_topology, "eigen field sweep sample topology")?;
        }
        if let Some(modes) = sample.modes.as_ref() {
            for mode in modes {
                if mode.sample_id != *sample_id || mode.mode_id.trim().is_empty() {
                    return Err(ApiError::internal(
                        "eigen field sweep mode has invalid sample or mode identity",
                    ));
                }
                if !mode_ids.insert((sample_id, &mode.mode_id)) {
                    return Err(ApiError::internal(
                        "eigen field sweep contains duplicate mode_id",
                    ));
                }
                if !mode.frequency_hz.is_finite()
                    || !mode.angular_frequency_rad_per_s.is_finite()
                    || mode.source_revision.trim().is_empty()
                    || mode.status.trim().is_empty()
                {
                    return Err(ApiError::internal(
                        "eigen field sweep contains invalid mode metadata",
                    ));
                }
                if mode.source_revision != *source_revision {
                    return Err(ApiError::internal(
                        "eigen field sweep mode source revision does not match dataset source_revision",
                    ));
                }
                if let Some(residual) = mode.residual_relative_l2 {
                    if !residual.is_finite() || residual < 0.0 {
                        return Err(ApiError::internal(
                            "eigen field sweep contains invalid residual_relative_l2",
                        ));
                    }
                }
                let has_field_reference = match (
                    &mode.mode_field_id,
                    &mode.mode_field_resource_key,
                ) {
                    (Some(field_id), Some(resource_key))
                        if !field_id.trim().is_empty() && !resource_key.trim().is_empty() => true,
                    (None, None) => false,
                    _ => {
                        return Err(ApiError::internal(
                            "eigen field sweep mode field identity and resource key must be published together",
                        ))
                    }
                };
                let has_mode_artifact = match &mode.mode_artifact_path {
                    Some(path) if !path.trim().is_empty() => true,
                    None => false,
                    Some(_) => {
                        return Err(ApiError::internal(
                            "eigen field sweep mode mode_artifact_path must not be empty",
                        ))
                    }
                };
                if has_field_reference != has_mode_artifact {
                    return Err(ApiError::internal(
                        "eigen field sweep mode artifact path and field reference must be published together",
                    ));
                }
                if let Some(field_status) = mode.field_status.as_ref() {
                    if field_status.trim().is_empty() {
                        return Err(ApiError::internal(
                            "eigen field sweep mode field_status must not be empty",
                        ));
                    }
                    let normalized_status = field_status.trim().to_ascii_lowercase();
                    if (normalized_status == "spectrum-only" && has_field_reference)
                        || (normalized_status == "ready" && !has_field_reference)
                    {
                        return Err(ApiError::internal(
                            "eigen field sweep mode field_status contradicts field availability",
                        ));
                    }
                }
            }
        }
    }

    for reference in cross_artifact_refs {
        if reference.relation.trim().is_empty()
            || reference.artifact.trim().is_empty()
            || reference.revision.trim().is_empty()
        {
            return Err(ApiError::internal(
                "eigen field sweep contains incomplete cross-artifact reference",
            ));
        }
        if reference.relation == "source_spectrum" && reference.revision != *source_revision {
            return Err(ApiError::internal(
                "eigen field sweep source_spectrum revision does not match source_revision",
            ));
        }
    }
    Ok(())
}

fn validate_field_sweep_axis(
    axis: &FrequencyDomainFieldSweepAxisPayload,
    label: &str,
) -> Result<(), ApiError> {
    if axis.kind.trim().is_empty()
        || axis.coordinate.trim().is_empty()
        || axis.unit.trim().is_empty()
    {
        return Err(ApiError::internal(format!(
            "{label} has incomplete identity"
        )));
    }
    for conversion in &axis.display_conversions {
        if conversion.name.trim().is_empty()
            || conversion.unit.trim().is_empty()
            || !conversion.scale.is_finite()
            || conversion.scale == 0.0
        {
            return Err(ApiError::internal(format!(
                "{label} contains invalid display conversion"
            )));
        }
    }
    Ok(())
}

fn validate_field_sweep_topology(
    topology: &FrequencyDomainFieldSweepTopologyPayload,
    label: &str,
) -> Result<(), ApiError> {
    if topology.mesh_id.trim().is_empty()
        || topology.topology_revision.trim().is_empty()
        || topology.indexing.trim().is_empty()
        || topology.sample_axis.trim().is_empty()
        || topology.mode_axis.trim().is_empty()
    {
        return Err(ApiError::internal(format!(
            "{label} has incomplete identity"
        )));
    }
    Ok(())
}

fn validate_field_sweep_execution(
    execution: &FrequencyDomainFieldSweepExecutionPayload,
    label: &str,
) -> Result<(), ApiError> {
    if execution.backend.trim().is_empty()
        || execution.device.trim().is_empty()
        || execution.precision.trim().is_empty()
        || execution.execution_mode.trim().is_empty()
        || execution.engine.trim().is_empty()
        || execution.status.trim().is_empty()
        || execution
            .implementation_id
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        || execution
            .fallback_reason
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
    {
        return Err(ApiError::internal(format!(
            "eigen field sweep {label} has incomplete execution provenance"
        )));
    }
    Ok(())
}

fn validate_frequency_domain_spectrum_v3(
    spectrum: &FrequencyDomainSpectrumV3ArtifactPayload,
) -> Result<(), ApiError> {
    let mut sample_ids = BTreeSet::new();
    let mut mode_ids = BTreeSet::new();
    for sample in &spectrum.samples {
        if sample.sample_id.trim().is_empty() || !sample_ids.insert(&sample.sample_id) {
            return Err(ApiError::internal(
                "eigen spectrum v3 contains missing or duplicate sample_id",
            ));
        }
        for mode in &sample.modes {
            if mode.mode_id.trim().is_empty() || !mode_ids.insert(&mode.mode_id) {
                return Err(ApiError::internal(
                    "eigen spectrum v3 contains missing or duplicate mode_id",
                ));
            }
            if !mode.frequency_hz.is_finite() {
                return Err(ApiError::internal(
                    "eigen spectrum v3 contains non-finite frequency_hz",
                ));
            }
            if !mode.residual_relative_l2.is_finite() || mode.residual_relative_l2 < 0.0 {
                return Err(ApiError::internal(
                    "eigen spectrum v3 contains invalid residual_relative_l2",
                ));
            }
            match (&mode.mode_field_id, &mode.mode_field_resource_key) {
                (Some(field_id), Some(resource_key))
                    if !field_id.trim().is_empty() && !resource_key.trim().is_empty() => {}
                (None, None) => {}
                _ => {
                    return Err(ApiError::internal(
                        "eigen spectrum v3 mode field identity and resource key must be published together",
                    ))
                }
            }
            validate_modal_participation(&mode.component_participation)?;
        }
    }
    Ok(())
}

fn validate_modal_participation(
    participation: &FrequencyDomainModalParticipationPayload,
) -> Result<(), ApiError> {
    if participation.schema_version != "modal_component_participation.v1"
        || participation.definition_id != "volume_weighted_complex_l2_fraction.v1"
        || participation.quantity_id.trim().is_empty()
        || participation.quantity_symbol.trim().is_empty()
        || participation.unit.trim().is_empty()
        || participation.component_basis != "global_cartesian_xyz"
        || participation.integration_method.trim().is_empty()
        || participation.qualification.trim().is_empty()
        || participation.provenance.solver_device.trim().is_empty()
        || participation.provenance.observable_lane.trim().is_empty()
    {
        return Err(ApiError::internal(
            "eigen spectrum v3 has invalid modal component participation metadata",
        ));
    }

    match participation.status {
        FrequencyDomainModalParticipationStatus::Ready => {
            let Some(global) = participation.global.as_ref() else {
                return Err(ApiError::internal(
                    "ready modal component participation is missing global fractions",
                ));
            };
            if participation.objects.is_empty() || participation.unavailable.is_some() {
                return Err(ApiError::internal(
                    "ready modal component participation has inconsistent availability fields",
                ));
            }
            if participation
                .provenance
                .source_mesh_identity
                .as_ref()
                .is_none()
            {
                return Err(ApiError::internal(
                    "ready modal component participation is missing source mesh identity",
                ));
            }
            let tolerance = modal_participation_sum_tolerance(participation.objects.len());
            validate_modal_participation_fractions(global, tolerance)?;
            if (global.total - 1.0).abs() > tolerance {
                return Err(ApiError::internal(
                    "ready modal component participation global total must equal one",
                ));
            }
            let mut object_ids = BTreeSet::new();
            let mut object_total = 0.0;
            let mut object_components = [0.0; 3];
            for object in &participation.objects {
                if object.object_id.trim().is_empty()
                    || !object_ids.insert(&object.object_id)
                    || !object.total_fraction.is_finite()
                    || object.total_fraction < 0.0
                {
                    return Err(ApiError::internal(
                        "ready modal component participation has invalid object coverage",
                    ));
                }
                validate_modal_participation_fractions(&object.components, tolerance)?;
                if (object.components.total - object.total_fraction).abs() > tolerance {
                    return Err(ApiError::internal(
                        "ready modal component participation object total does not match total_fraction",
                    ));
                }
                object_total += object.total_fraction;
                object_components[0] += object.components.x;
                object_components[1] += object.components.y;
                object_components[2] += object.components.z;
            }
            if (object_total - global.total).abs() > tolerance {
                return Err(ApiError::internal(
                    "ready modal component participation object totals do not match global total",
                ));
            }
            if (object_components[0] - global.x).abs() > tolerance
                || (object_components[1] - global.y).abs() > tolerance
                || (object_components[2] - global.z).abs() > tolerance
            {
                return Err(ApiError::internal(
                    "ready modal component participation object components do not match global components",
                ));
            }
        }
        FrequencyDomainModalParticipationStatus::Unavailable => {
            let Some(unavailable) = participation.unavailable.as_ref() else {
                return Err(ApiError::internal(
                    "unavailable modal component participation is missing its reason",
                ));
            };
            if participation.global.is_some()
                || !participation.objects.is_empty()
                || unavailable.reason_code != "component_participation_unavailable"
                || unavailable.detail.trim().is_empty()
            {
                return Err(ApiError::internal(
                    "unavailable modal component participation has inconsistent fields",
                ));
            }
        }
    }
    Ok(())
}

fn validate_modal_participation_fractions(
    fractions: &FrequencyDomainModalParticipationFractionsPayload,
    tolerance: f64,
) -> Result<(), ApiError> {
    if [fractions.total, fractions.x, fractions.y, fractions.z]
        .into_iter()
        .any(|value| !value.is_finite() || value < 0.0)
    {
        return Err(ApiError::internal(
            "modal component participation fractions must be finite and non-negative",
        ));
    }
    if (fractions.x + fractions.y + fractions.z - fractions.total).abs() > tolerance {
        return Err(ApiError::internal(
            "modal component participation component fractions must sum to total",
        ));
    }
    Ok(())
}

fn modal_participation_sum_tolerance(object_count: usize) -> f64 {
    128.0 * f64::EPSILON * (3_usize.saturating_mul(object_count)).max(1) as f64
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
    let content_digest = present
        .then(|| frequency_domain_field_content_digest(&artifact_dir, artifact_path, &metadata))
        .transpose()?;
    Ok(Json(FrequencyDomainFieldResource {
        schema_version: schema_version.to_string(),
        status: if present { "ready" } else { "missing" }.to_string(),
        field_id: field_id.to_string(),
        artifact_path: artifact_path.to_string(),
        resource_key: resource_key.to_string(),
        revision: content_digest.clone(),
        content_digest,
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

#[derive(Debug, Clone, Serialize)]
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

fn frequency_domain_field_content_digest(
    artifact_dir: &std::path::Path,
    artifact_path: &str,
    metadata: &FrequencyDomainFieldMetadata,
) -> Result<String, ApiError> {
    let resolved = try_resolve_artifact_path(artifact_dir, artifact_path)?
        .ok_or_else(|| ApiError::not_found(format!("artifact '{artifact_path}' is not present")))?;
    let payload = std::fs::read(&resolved).map_err(|error| {
        ApiError::internal(format!(
            "failed to read frequency-domain field payload '{}': {error}",
            artifact_path
        ))
    })?;
    let metadata = serde_json::to_vec(metadata).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize frequency-domain field metadata '{}': {error}",
            artifact_path
        ))
    })?;
    let mut digest = Sha256::new();
    digest.update((metadata.len() as u64).to_le_bytes());
    digest.update(metadata);
    digest.update((payload.len() as u64).to_le_bytes());
    digest.update(payload);
    Ok(format!("sha256:{:x}", digest.finalize()))
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
