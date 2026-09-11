//! Thin, session-scoped metadata resources for solved microwave antennas.
//!
//! The runner owns the immutable field and spectrum payloads.  This handler
//! only exposes their verified manifests and links; large numerical arrays
//! remain artifacts rather than being copied into the control-plane resource.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use fullmag_ir::FieldTargetIR;
use fullmag_runner::AntennaSourceSpectrumArtifact;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::artifacts::{read_json_artifact_value, require_current_live_artifact_dir};
use crate::error::ApiError;
use crate::types::AppState;

const FIELD_SOLUTION_SCHEMA: &str = "antenna_field_solution.v1";

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AntennaFieldBinaryRefResource {
    pub path: String,
    pub sha256: String,
    pub scalar_type: String,
    pub layout: String,
    pub unit: String,
    pub value_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AntennaFieldSolutionSignaturesResource {
    pub current_solution_signature: String,
    pub field_solution_signature: String,
    pub target_projection_signatures: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AntennaFieldBasisResource {
    pub port_mode_id: String,
    pub measured_positive_terminal_current_a: f64,
    pub normalization_current_a: f64,
    pub normalization_scale: f64,
    pub current_balance_certificate_digest: String,
    pub electric_potential_per_ampere: AntennaFieldBinaryRefResource,
    pub current_density_per_ampere: AntennaFieldBinaryRefResource,
    pub magnetic_field_per_ampere: AntennaFieldBinaryRefResource,
    pub quadrature_diagnostics: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AntennaFieldSolutionResource {
    pub resource_id: String,
    pub session_id: String,
    pub session_epoch: String,
    pub schema_version: String,
    pub asset_id: String,
    pub status: String,
    pub solution_id: String,
    pub source_object_id: String,
    pub current_transport_id: String,
    pub stage_id: String,
    pub geometry_revision: String,
    pub material_revision: String,
    pub mesh_digest: String,
    pub requested_execution: Value,
    pub resolved_execution: Value,
    pub gauge_policy: String,
    pub solver_policy: Value,
    pub signatures: AntennaFieldSolutionSignaturesResource,
    pub content_digest: String,
    pub quantity: String,
    pub component: String,
    pub target_projection_signature: Option<String>,
    pub conductor_positions: AntennaFieldBinaryRefResource,
    pub sample_positions: AntennaFieldBinaryRefResource,
    pub sample_topology: Option<AntennaFieldBinaryRefResource>,
    pub assumptions: Vec<String>,
    pub bases: Vec<AntennaFieldBasisResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AntennaFieldTargetResource {
    Global,
    Object {
        object_id: String,
    },
    Region {
        object_id: String,
        region_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AntennaSpectrumSamplingResource {
    pub schema_version: String,
    pub solution_id: String,
    pub source_object_id: String,
    pub port_mode_id: String,
    pub target: AntennaFieldTargetResource,
    pub origin_m: [f64; 3],
    pub axis_u: [f64; 3],
    pub axis_v: [f64; 3],
    pub extent_u_m: f64,
    pub extent_v_m: f64,
    pub sample_count_u: u32,
    pub sample_count_v: u32,
    pub interpolation: String,
    pub realization: String,
    pub outside_policy: String,
    pub outside_count: usize,
    pub source_sample_count: usize,
    pub mapping_digest: String,
    pub fourier_origin_uv_m: [f64; 2],
    pub fourier_phase_convention: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AntennaSpectrumPayloadResource {
    pub path: String,
    pub content_type: String,
    pub format: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AntennaSourceSpectrumResource {
    pub resource_id: String,
    pub session_id: String,
    pub session_epoch: String,
    pub schema_version: String,
    pub request_id: String,
    pub output_id: String,
    pub solution_id: String,
    pub source_object_id: String,
    pub port_mode_id: String,
    pub solution_content_digest: String,
    pub content_digest: String,
    pub field_signature: String,
    pub target_projection_signature: Option<String>,
    pub quantity: String,
    pub component: String,
    pub component_labels: Vec<String>,
    pub k_u_count: usize,
    pub k_v_count: usize,
    pub amplitude_count: usize,
    pub power_count: usize,
    pub coherent_gain: f64,
    pub equivalent_noise_bandwidth_bins: f64,
    pub normalization: String,
    pub amplitude_unit: String,
    pub wave_vector_unit: String,
    pub sampling: AntennaSpectrumSamplingResource,
    pub payload: AntennaSpectrumPayloadResource,
}

#[derive(Debug, Deserialize)]
struct StoredFieldSolutionManifest {
    schema_version: String,
    asset_id: String,
    status: String,
    solution_id: String,
    source_object_id: String,
    current_transport_id: String,
    stage_id: String,
    geometry_revision: String,
    material_revision: String,
    mesh_digest: String,
    requested_execution: Value,
    resolved_execution: Value,
    gauge_policy: String,
    solver_policy: Value,
    signatures: AntennaFieldSolutionSignaturesResource,
    content_digest: String,
    conductor_positions: AntennaFieldBinaryRefResource,
    sample_positions: AntennaFieldBinaryRefResource,
    #[serde(default)]
    sample_topology: Option<AntennaFieldBinaryRefResource>,
    assumptions: Vec<String>,
    bases: Vec<AntennaFieldBasisResource>,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/antenna/field-solutions/{solution_id}",
    params(
        ("solution_id" = String, Path, description = "Published antenna field solution id"),
    ),
    responses(
        (status = 200, description = "Published antenna field solution metadata", body = AntennaFieldSolutionResource),
        (status = 304, description = "Field solution metadata not modified for the supplied ETag"),
        (status = 404, description = "Field solution artifact not found"),
    ),
    tag = "data"
)]
pub async fn get_antenna_field_solution(
    State(state): State<Arc<AppState>>,
    Path(solution_id): Path<String>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    let relative_path = format!("antenna/field_solutions/{solution_id}/manifest.v1.json");
    let value = read_json_artifact_value(&artifact_dir, &relative_path)?;
    let manifest: StoredFieldSolutionManifest = serde_json::from_value(value).map_err(|error| {
        ApiError::internal(format!("invalid {relative_path} artifact: {error}"))
    })?;
    if manifest.schema_version != FIELD_SOLUTION_SCHEMA || manifest.solution_id != solution_id {
        return Err(ApiError::internal(
            "antenna field solution manifest identity or schema mismatch",
        ));
    }

    let (session_id, session_epoch) = current_session_identity(&state).await?;
    let target_projection_signature = manifest
        .signatures
        .target_projection_signatures
        .values()
        .next()
        .cloned();
    let resource = AntennaFieldSolutionResource {
        resource_id: format!("antenna/field-solution/{solution_id}"),
        session_id: session_id.clone(),
        session_epoch: session_epoch.clone(),
        schema_version: manifest.schema_version,
        asset_id: manifest.asset_id,
        status: manifest.status,
        solution_id: manifest.solution_id,
        source_object_id: manifest.source_object_id,
        current_transport_id: manifest.current_transport_id,
        stage_id: manifest.stage_id,
        geometry_revision: manifest.geometry_revision,
        material_revision: manifest.material_revision,
        mesh_digest: manifest.mesh_digest,
        requested_execution: manifest.requested_execution,
        resolved_execution: manifest.resolved_execution,
        gauge_policy: manifest.gauge_policy,
        solver_policy: manifest.solver_policy,
        signatures: manifest.signatures,
        content_digest: manifest.content_digest.clone(),
        quantity: "H_ant_basis".into(),
        component: "vector_basis".into(),
        target_projection_signature,
        conductor_positions: manifest.conductor_positions,
        sample_positions: manifest.sample_positions,
        sample_topology: manifest.sample_topology,
        assumptions: manifest.assumptions,
        bases: manifest.bases,
    };
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "antenna-field-solution:{session_epoch}:{solution_id}:{}",
        resource.content_digest
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &resource))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/antenna/source-spectra/{output_id}",
    params(
        ("output_id" = String, Path, description = "Published antenna source spectrum output id"),
    ),
    responses(
        (status = 200, description = "Published antenna source spectrum metadata", body = AntennaSourceSpectrumResource),
        (status = 304, description = "Source spectrum metadata not modified for the supplied ETag"),
        (status = 404, description = "Source spectrum artifact not found"),
    ),
    tag = "data"
)]
pub async fn get_antenna_source_spectrum(
    State(state): State<Arc<AppState>>,
    Path(output_id): Path<String>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    let relative_path = format!("antenna/source_spectra/{output_id}/spectrum.v1.json");
    let value = read_json_artifact_value(&artifact_dir, &relative_path)?;
    let artifact: AntennaSourceSpectrumArtifact =
        serde_json::from_value(value).map_err(|error| {
            ApiError::internal(format!("invalid {relative_path} artifact: {error}"))
        })?;
    if artifact.output_id != output_id {
        return Err(ApiError::internal(
            "antenna source spectrum artifact identity mismatch",
        ));
    }

    let (session_id, session_epoch) = current_session_identity(&state).await?;
    let spectrum = artifact.spectrum;
    let resource = AntennaSourceSpectrumResource {
        resource_id: format!("antenna/source-spectrum/{output_id}"),
        session_id,
        session_epoch: session_epoch.clone(),
        schema_version: artifact.schema_version,
        request_id: artifact.request_id,
        output_id: artifact.output_id,
        solution_id: artifact.solution_id,
        source_object_id: artifact.source_object_id,
        port_mode_id: artifact.port_mode_id,
        solution_content_digest: artifact.solution_content_digest.clone(),
        content_digest: artifact.content_digest.clone(),
        field_signature: artifact.solution_content_digest,
        target_projection_signature: None,
        quantity: "H_ant_source_spectrum".into(),
        component: spectrum.component.clone(),
        component_labels: spectrum.component_labels.clone(),
        k_u_count: spectrum.k_u_rad_per_m.len(),
        k_v_count: spectrum.k_v_rad_per_m.len(),
        amplitude_count: spectrum.amplitudes_re_im.len(),
        power_count: spectrum.power.len(),
        coherent_gain: spectrum.coherent_gain,
        equivalent_noise_bandwidth_bins: spectrum.equivalent_noise_bandwidth_bins,
        normalization: spectrum.normalization,
        amplitude_unit: spectrum.amplitude_unit,
        wave_vector_unit: spectrum.wave_vector_unit,
        sampling: sampling_resource(artifact.sampling),
        payload: AntennaSpectrumPayloadResource {
            path: relative_path,
            content_type: "application/json".into(),
            format: "antenna_source_spectrum.v1.json".into(),
        },
    };
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "antenna-source-spectrum:{session_epoch}:{output_id}:{}",
        resource.content_digest
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &resource))
}

fn sampling_resource(
    sampling: fullmag_runner::AntennaSpectrumSamplingMetadata,
) -> AntennaSpectrumSamplingResource {
    AntennaSpectrumSamplingResource {
        schema_version: sampling.schema_version,
        solution_id: sampling.solution_id,
        source_object_id: sampling.source_object_id,
        port_mode_id: sampling.port_mode_id,
        target: match sampling.target {
            FieldTargetIR::Global {} => AntennaFieldTargetResource::Global,
            FieldTargetIR::Object { object_id } => AntennaFieldTargetResource::Object { object_id },
            FieldTargetIR::Region {
                object_id,
                region_id,
            } => AntennaFieldTargetResource::Region {
                object_id,
                region_id,
            },
        },
        origin_m: sampling.origin_m,
        axis_u: sampling.axis_u,
        axis_v: sampling.axis_v,
        extent_u_m: sampling.extent_u_m,
        extent_v_m: sampling.extent_v_m,
        sample_count_u: sampling.sample_count_u,
        sample_count_v: sampling.sample_count_v,
        interpolation: sampling.interpolation,
        realization: sampling.realization,
        outside_policy: sampling.outside_policy,
        outside_count: sampling.outside_count,
        source_sample_count: sampling.source_sample_count,
        mapping_digest: sampling.mapping_digest,
        fourier_origin_uv_m: sampling.fourier_origin_uv_m,
        fourier_phase_convention: sampling.fourier_phase_convention,
    }
}

async fn current_session_identity(state: &Arc<AppState>) -> Result<(String, String), ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let terminal = matches!(
        snapshot.session.status.as_str(),
        "completed" | "failed" | "cancelled" | "closed"
    );
    let epoch = crate::router_v2::handlers::sessions::status::session_epoch(
        &snapshot.session.session_id,
        snapshot.session.started_at_unix_ms,
        snapshot.session.finished_at_unix_ms,
        terminal,
    );
    Ok((snapshot.session.session_id.clone(), epoch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_spectrum_sampling_maps_all_target_kinds() {
        let targets = [
            FieldTargetIR::Global {},
            FieldTargetIR::Object {
                object_id: "object".into(),
            },
            FieldTargetIR::Region {
                object_id: "object".into(),
                region_id: "region".into(),
            },
        ];
        for target in targets {
            let value = serde_json::to_value(match target {
                FieldTargetIR::Global {} => AntennaFieldTargetResource::Global,
                FieldTargetIR::Object { object_id } => {
                    AntennaFieldTargetResource::Object { object_id }
                }
                FieldTargetIR::Region {
                    object_id,
                    region_id,
                } => AntennaFieldTargetResource::Region {
                    object_id,
                    region_id,
                },
            })
            .unwrap();
            assert!(value.get("kind").is_some());
        }
    }
}
