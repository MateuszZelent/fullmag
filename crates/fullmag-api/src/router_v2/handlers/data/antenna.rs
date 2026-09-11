//! Thin, session-scoped metadata resources for solved microwave antennas.
//!
//! The runner owns the immutable field and spectrum payloads.  This handler
//! only exposes their verified manifests and links; large numerical arrays
//! remain artifacts rather than being copied into the control-plane resource.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue};
use fullmag_ir::FieldTargetIR;
use fullmag_runner::{
    AntennaSourceSpectrumArtifact, AntennaSourceSpectrumManifest, AntennaSpectrumPayloadRef,
    AntennaSpectrumPayloads,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::artifacts::{read_json_artifact_value, require_current_live_artifact_dir};
use crate::error::ApiError;
use crate::types::AppState;

const FIELD_SOLUTION_SCHEMA: &str = "antenna_field_solution.v1";
const SOURCE_SPECTRUM_SCHEMA_V1: &str = "antenna_source_spectrum_artifact.v1";
const SOURCE_SPECTRUM_SCHEMA_V2: &str = "antenna_source_spectrum_artifact.v2";

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
pub struct AntennaSpectrumPayloadsResource {
    pub k_u_rad_per_m: AntennaFieldBinaryRefResource,
    pub k_v_rad_per_m: AntennaFieldBinaryRefResource,
    pub amplitudes_re_im: AntennaFieldBinaryRefResource,
    pub power: AntennaFieldBinaryRefResource,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payloads: Option<AntennaSpectrumPayloadsResource>,
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
    let v2_path = format!("antenna/source_spectra/{output_id}/spectrum.v2.json");
    let v1_path = format!("antenna/source_spectra/{output_id}/spectrum.v1.json");
    let relative_path =
        if crate::artifacts::try_resolve_artifact_path(&artifact_dir, &v2_path)?.is_some() {
            v2_path
        } else {
            v1_path
        };
    let value = read_json_artifact_value(&artifact_dir, &relative_path)?;
    let parsed = parse_source_spectrum_artifact(&value, &output_id, &relative_path)?;

    let (session_id, session_epoch) = current_session_identity(&state).await?;
    let resource = AntennaSourceSpectrumResource {
        resource_id: format!("antenna/source-spectrum/{output_id}"),
        session_id,
        session_epoch: session_epoch.clone(),
        schema_version: parsed.schema_version,
        request_id: parsed.request_id,
        output_id: parsed.output_id,
        solution_id: parsed.solution_id,
        source_object_id: parsed.source_object_id,
        port_mode_id: parsed.port_mode_id,
        solution_content_digest: parsed.solution_content_digest.clone(),
        content_digest: parsed.content_digest.clone(),
        field_signature: parsed.solution_content_digest,
        target_projection_signature: None,
        quantity: "H_ant_source_spectrum".into(),
        component: parsed.component,
        component_labels: parsed.component_labels,
        k_u_count: parsed.k_u_count,
        k_v_count: parsed.k_v_count,
        amplitude_count: parsed.amplitude_count,
        power_count: parsed.power_count,
        coherent_gain: parsed.coherent_gain,
        equivalent_noise_bandwidth_bins: parsed.equivalent_noise_bandwidth_bins,
        normalization: parsed.normalization,
        amplitude_unit: parsed.amplitude_unit,
        wave_vector_unit: parsed.wave_vector_unit,
        sampling: sampling_resource(parsed.sampling),
        payload: AntennaSpectrumPayloadResource {
            path: relative_path,
            content_type: "application/json".into(),
            format: parsed.payload_format,
        },
        payloads: parsed.payloads.map(payloads_resource),
    };
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "antenna-source-spectrum:{session_epoch}:{output_id}:{}",
        resource.content_digest
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &resource))
}

struct ParsedSourceSpectrumArtifact {
    schema_version: String,
    request_id: String,
    output_id: String,
    solution_id: String,
    source_object_id: String,
    port_mode_id: String,
    solution_content_digest: String,
    content_digest: String,
    component: String,
    component_labels: Vec<String>,
    k_u_count: usize,
    k_v_count: usize,
    amplitude_count: usize,
    power_count: usize,
    coherent_gain: f64,
    equivalent_noise_bandwidth_bins: f64,
    normalization: String,
    amplitude_unit: String,
    wave_vector_unit: String,
    sampling: fullmag_runner::AntennaSpectrumSamplingMetadata,
    payload_format: String,
    payloads: Option<AntennaSpectrumPayloads>,
}

fn parse_source_spectrum_artifact(
    value: &Value,
    output_id: &str,
    relative_path: &str,
) -> Result<ParsedSourceSpectrumArtifact, ApiError> {
    let schema = value
        .get("schema_version")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ApiError::internal(format!(
                "invalid {relative_path} artifact: missing schema_version"
            ))
        })?;
    if schema == SOURCE_SPECTRUM_SCHEMA_V2 {
        let manifest: AntennaSourceSpectrumManifest = serde_json::from_value(value.clone())
            .map_err(|error| {
                ApiError::internal(format!("invalid {relative_path} artifact: {error}"))
            })?;
        if manifest.output_id != output_id
            || manifest.spectrum.output_id != manifest.output_id
            || manifest.spectrum.request_id != manifest.request_id
        {
            return Err(ApiError::internal(
                "antenna source spectrum artifact identity mismatch",
            ));
        }
        return Ok(ParsedSourceSpectrumArtifact {
            schema_version: manifest.schema_version,
            request_id: manifest.request_id,
            output_id: manifest.output_id,
            solution_id: manifest.solution_id,
            source_object_id: manifest.source_object_id,
            port_mode_id: manifest.port_mode_id,
            solution_content_digest: manifest.solution_content_digest,
            content_digest: manifest.content_digest,
            component: manifest.spectrum.component,
            component_labels: manifest.spectrum.component_labels,
            k_u_count: manifest.spectrum.k_u_count,
            k_v_count: manifest.spectrum.k_v_count,
            amplitude_count: manifest.spectrum.amplitude_count,
            power_count: manifest.spectrum.power_count,
            coherent_gain: manifest.spectrum.coherent_gain,
            equivalent_noise_bandwidth_bins: manifest.spectrum.equivalent_noise_bandwidth_bins,
            normalization: manifest.spectrum.normalization,
            amplitude_unit: manifest.spectrum.amplitude_unit,
            wave_vector_unit: manifest.spectrum.wave_vector_unit,
            sampling: manifest.sampling,
            payload_format: "antenna_source_spectrum.v2.json".into(),
            payloads: Some(manifest.payloads),
        });
    }
    if schema != SOURCE_SPECTRUM_SCHEMA_V1 {
        return Err(ApiError::internal(format!(
            "unsupported antenna source spectrum schema '{schema}'"
        )));
    }
    let artifact: AntennaSourceSpectrumArtifact =
        serde_json::from_value(value.clone()).map_err(|error| {
            ApiError::internal(format!("invalid {relative_path} artifact: {error}"))
        })?;
    if artifact.output_id != output_id {
        return Err(ApiError::internal(
            "antenna source spectrum artifact identity mismatch",
        ));
    }
    let spectrum = artifact.spectrum;
    Ok(ParsedSourceSpectrumArtifact {
        schema_version: artifact.schema_version,
        request_id: artifact.request_id,
        output_id: artifact.output_id,
        solution_id: artifact.solution_id,
        source_object_id: artifact.source_object_id,
        port_mode_id: artifact.port_mode_id,
        solution_content_digest: artifact.solution_content_digest,
        content_digest: artifact.content_digest,
        component: spectrum.component,
        component_labels: spectrum.component_labels,
        k_u_count: spectrum.k_u_rad_per_m.len(),
        k_v_count: spectrum.k_v_rad_per_m.len(),
        amplitude_count: spectrum.amplitudes_re_im.len(),
        power_count: spectrum.power.len(),
        coherent_gain: spectrum.coherent_gain,
        equivalent_noise_bandwidth_bins: spectrum.equivalent_noise_bandwidth_bins,
        normalization: spectrum.normalization,
        amplitude_unit: spectrum.amplitude_unit,
        wave_vector_unit: spectrum.wave_vector_unit,
        sampling: artifact.sampling,
        payload_format: "antenna_source_spectrum.v1.json".into(),
        payloads: None,
    })
}

fn payload_ref_resource(reference: AntennaSpectrumPayloadRef) -> AntennaFieldBinaryRefResource {
    AntennaFieldBinaryRefResource {
        path: reference.path,
        sha256: reference.sha256,
        scalar_type: reference.scalar_type,
        layout: reference.layout,
        unit: reference.unit,
        value_count: reference.value_count,
    }
}

fn payloads_resource(payloads: AntennaSpectrumPayloads) -> AntennaSpectrumPayloadsResource {
    AntennaSpectrumPayloadsResource {
        k_u_rad_per_m: payload_ref_resource(payloads.k_u_rad_per_m),
        k_v_rad_per_m: payload_ref_resource(payloads.k_v_rad_per_m),
        amplitudes_re_im: payload_ref_resource(payloads.amplitudes_re_im),
        power: payload_ref_resource(payloads.power),
    }
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/antenna/source-spectra/{output_id}/payloads/{payload_kind}",
    params(
        ("output_id" = String, Path, description = "Published antenna source spectrum output id"),
        ("payload_kind" = String, Path, description = "Binary payload name: k_u_rad_per_m, k_v_rad_per_m, amplitudes_re_im, or power"),
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous binary payload response"),
        ("Range" = Option<String>, Header, description = "Optional single byte range"),
    ),
    responses(
        (status = 200, description = "Binary antenna source-spectrum payload", content_type = "application/octet-stream"),
        (status = 206, description = "Partial binary antenna source-spectrum payload", content_type = "application/octet-stream"),
        (status = 304, description = "Binary payload not modified for the supplied ETag"),
        (status = 404, description = "Source-spectrum payload not found"),
        (status = 416, description = "Requested binary payload range is not satisfiable"),
    ),
    tag = "data"
)]
pub async fn get_antenna_source_spectrum_payload(
    State(state): State<Arc<AppState>>,
    Path((output_id, payload_kind)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let artifact_dir = require_current_live_artifact_dir(&state).await?;
    let manifest_path = format!("antenna/source_spectra/{output_id}/spectrum.v2.json");
    let value = read_json_artifact_value(&artifact_dir, &manifest_path)?;
    let manifest: AntennaSourceSpectrumManifest =
        serde_json::from_value(value).map_err(|error| {
            ApiError::internal(format!("invalid {manifest_path} artifact: {error}"))
        })?;
    if manifest.schema_version != SOURCE_SPECTRUM_SCHEMA_V2 || manifest.output_id != output_id {
        return Err(ApiError::internal(
            "antenna source spectrum manifest identity or schema mismatch",
        ));
    }
    let reference = match payload_kind.as_str() {
        "k_u_rad_per_m" => &manifest.payloads.k_u_rad_per_m,
        "k_v_rad_per_m" => &manifest.payloads.k_v_rad_per_m,
        "amplitudes_re_im" => &manifest.payloads.amplitudes_re_im,
        "power" => &manifest.payloads.power,
        _ => {
            return Err(ApiError::bad_request(format!(
                "unsupported antenna source-spectrum payload '{payload_kind}'"
            )))
        }
    };
    let prefix = format!("antenna/source_spectra/{output_id}/");
    if !reference.path.starts_with(&prefix) {
        return Err(ApiError::internal(
            "antenna source spectrum payload path escapes its output namespace",
        ));
    }
    let resolved = crate::artifacts::try_resolve_artifact_path(&artifact_dir, &reference.path)?
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "source-spectrum payload '{}' not found",
                reference.path
            ))
        })?;
    let bytes = std::fs::read(&resolved).map_err(|error| {
        ApiError::internal(format!("failed to read source-spectrum payload: {error}"))
    })?;
    let scalar_bytes = match reference.scalar_type.as_str() {
        "float64_le" => 8,
        "uint32_le" => 4,
        _ => {
            return Err(ApiError::internal(format!(
                "unsupported source-spectrum payload scalar type '{}'",
                reference.scalar_type
            )))
        }
    };
    let expected_len = reference
        .value_count
        .checked_mul(scalar_bytes)
        .ok_or_else(|| {
            ApiError::internal("source-spectrum payload size overflows address space")
        })?;
    if bytes.len() != expected_len
        || format!("sha256:{:x}", Sha256::digest(&bytes)) != reference.sha256
    {
        return Err(ApiError::internal(format!(
            "source-spectrum payload '{}' hash or size mismatch",
            reference.path
        )));
    }
    let (session_id, session_epoch) = current_session_identity(&state).await?;
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "antenna-source-spectrum-payload:{session_id}:{session_epoch}:{output_id}:{payload_kind}:{}:{}",
        manifest.content_digest, reference.sha256
    ));
    Ok(
        crate::router_v2::handlers::shared::conditional_binary_response_with_content_type(
            &headers,
            &etag,
            bytes,
            HeaderValue::from_static("application/octet-stream"),
        ),
    )
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
