//! Thin, session-scoped metadata resources for solved microwave antennas.
//!
//! The runner owns the immutable field and spectrum payloads.  This handler
//! only exposes their verified manifests and links; large numerical arrays
//! remain artifacts rather than being copied into the control-plane resource.

use std::collections::BTreeMap;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue};
use fullmag_ir::{AntennaFieldSolutionRefIR, FieldTargetIR};
use fullmag_runner::{
    AntennaSourceSpectrumArtifact, AntennaSourceSpectrumManifest, AntennaSpectrumPayloadRef,
    AntennaSpectrumPayloads,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use crate::artifacts::{
    read_json_artifact_value, require_current_live_artifact_dir, sanitize_artifact_relative_path,
    try_resolve_artifact_path,
};
use crate::error::ApiError;
use crate::session::current_artifact_dir;
use crate::types::AppState;

const FIELD_SOLUTION_SCHEMA: &str = "antenna_field_solution.v1";
const ANTENNA_STAGE_OUTPUT_CATALOG_SCHEMA: &str = "stage_output_catalog.v1";
const ANTENNA_STAGE_OUTPUT_CATALOG_NAME: &str = "stage_output_catalog.v1.json";
const SOURCE_SPECTRUM_SCHEMA_V1: &str = "antenna_source_spectrum_artifact.v1";
const SOURCE_SPECTRUM_SCHEMA_V2: &str = "antenna_source_spectrum_artifact.v2";
const SUPPORTED_SOURCE_SPECTRUM_REALIZATIONS: [&str; 2] =
    ["fem_p1_interpolation_v1", "identity_coordinates_v1"];

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
pub struct AntennaStageOutputSolutionReferenceResource {
    pub stage_id: String,
    pub output_id: String,
    pub asset_id: String,
    pub content_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AntennaStageOutputResource {
    pub kind: String,
    pub output_id: String,
    pub solution_ref: AntennaStageOutputSolutionReferenceResource,
    pub manifest_ref: String,
    pub quantity_ids: Vec<String>,
    pub reused_existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AntennaStageOutputCatalogResource {
    pub resource_id: String,
    pub session_id: String,
    pub session_epoch: String,
    pub stage_revision: u64,
    pub schema_version: String,
    pub stage_id: String,
    pub stage_kind: String,
    pub port_mode_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solution_id: Option<String>,
    pub outputs: Vec<AntennaStageOutputResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    pub content_digest: String,
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

#[derive(Debug, Deserialize)]
struct StoredAntennaStageOutputCatalog {
    schema_version: String,
    stage_id: String,
    stage_kind: String,
    port_mode_id: String,
    status: String,
    #[serde(default)]
    solution_id: Option<String>,
    #[serde(default)]
    outputs: Vec<StoredAntennaStageOutput>,
    #[serde(default)]
    diagnostic: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StoredAntennaStageOutput {
    kind: String,
    output_id: String,
    solution_ref: AntennaFieldSolutionRefIR,
    manifest_ref: String,
    #[serde(default)]
    quantity_ids: Vec<String>,
    #[serde(default)]
    reused_existing: bool,
}

struct ResolvedAntennaStageCatalog {
    artifact_dir: PathBuf,
    catalog_path: PathBuf,
    stage_id: String,
    stage_revision: u64,
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/antenna/stages/{stage_id}/output-catalog",
    params(
        ("stage_id" = String, Path, description = "Antenna field-solve stage identifier"),
        ("If-None-Match" = Option<String>, Header, description = "Strong ETag from a previous catalog response"),
    ),
    responses(
        (status = 200, description = "Published antenna stage output catalog", body = AntennaStageOutputCatalogResource),
        (status = 304, description = "Antenna stage output catalog not modified for the supplied ETag"),
        (status = 404, description = "Antenna stage output catalog not found"),
        (status = 409, description = "Antenna stage output catalog identity conflict"),
    ),
    tag = "data"
)]
pub async fn get_antenna_stage_output_catalog(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let resolved = resolve_antenna_stage_catalog(&state, &stage_id).await?;
    let bytes = std::fs::read(&resolved.catalog_path).map_err(|error| {
        ApiError::internal(format!(
            "failed to read antenna stage output catalog '{}': {error}",
            resolved.catalog_path.display()
        ))
    })?;
    let catalog_digest = format!("sha256:{:x}", Sha256::digest(&bytes));
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        ApiError::internal(format!(
            "invalid antenna stage output catalog '{}': {error}",
            resolved.catalog_path.display()
        ))
    })?;
    let parsed = parse_antenna_stage_output_catalog(
        &value,
        &resolved.stage_id,
        &resolved.artifact_dir,
    )?;
    let (session_id, session_epoch) = current_session_identity(&state).await?;
    let resource = AntennaStageOutputCatalogResource {
        resource_id: format!(
            "antenna/stage-output-catalog/{}",
            resolved.stage_id
        ),
        session_id,
        session_epoch: session_epoch.clone(),
        stage_revision: resolved.stage_revision,
        schema_version: parsed.schema_version,
        stage_id: parsed.stage_id,
        stage_kind: parsed.stage_kind,
        port_mode_id: parsed.port_mode_id,
        status: parsed.status,
        solution_id: parsed.solution_id,
        outputs: parsed.outputs,
        diagnostic: parsed.diagnostic,
        content_digest: catalog_digest.clone(),
    };
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "antenna-stage-output-catalog:{session_epoch}:{}:{}",
        resolved.stage_id, catalog_digest
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(
        &headers, &etag, &resource,
    ))
}

async fn resolve_antenna_stage_catalog(
    state: &Arc<AppState>,
    requested_stage_id: &str,
) -> Result<ResolvedAntennaStageCatalog, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let artifact_dir = current_artifact_dir(snapshot)
        .ok_or_else(|| ApiError::not_found("no artifact directory for the active workspace"))?;
    let stage_execution = snapshot
        .stage_execution
        .as_ref()
        .ok_or_else(|| ApiError::not_found("stage execution read-model is not available"))?;
    let direct_match = stage_execution
        .stages
        .iter()
        .enumerate()
        .find(|(index, record)| antenna_stage_identifier_matches(record, *index, requested_stage_id))
        .map(|(index, record)| {
            (
                index,
                record.artifact_refs.clone(),
                record
                    .stage_id
                    .clone()
                    .unwrap_or_else(|| format!("stage-{index:03}")),
            )
        });
    let stage_revision = snapshot.state_version;
    let stage_count = stage_execution.stages.len();
    let candidates = stage_execution
        .stages
        .iter()
        .enumerate()
        .map(|(index, record)| {
            (
                index,
                record.artifact_refs.clone(),
                record
                    .stage_id
                    .clone()
                    .unwrap_or_else(|| format!("stage-{index:03}")),
            )
        })
        .collect::<Vec<_>>();
    drop(guard);

    let candidate_records = direct_match
        .as_ref()
        .map(|candidate| vec![candidate.clone()])
        .unwrap_or(candidates);
    for (_stage_index, artifact_refs, fallback_stage_id) in candidate_records {
        for artifact_ref in artifact_refs {
            let Some(catalog_path) = resolve_antenna_stage_artifact_ref(
                &artifact_dir,
                &artifact_ref,
                ANTENNA_STAGE_OUTPUT_CATALOG_NAME,
            )?
            else {
                continue;
            };
            let catalog_stage_id = read_antenna_stage_catalog_id(&catalog_path)?;
            if direct_match.is_none()
                && catalog_stage_id.as_deref() != Some(requested_stage_id)
            {
                continue;
            }
            return Ok(ResolvedAntennaStageCatalog {
                artifact_dir: artifact_dir.clone(),
                catalog_path,
                stage_id: catalog_stage_id.unwrap_or(fallback_stage_id),
                stage_revision,
            });
        }
    }

    // The final stage uses the session artifact directory itself.  Keep this
    // fallback for older read-model snapshots that predate the explicit
    // artifact_ref publication, while still binding it to the requested last
    // stage rather than scanning arbitrary files.
    if direct_match
        .as_ref()
        .is_some_and(|(stage_index, _, _)| *stage_index + 1 == stage_count)
    {
        let catalog_path = artifact_dir.join(ANTENNA_STAGE_OUTPUT_CATALOG_NAME);
        if catalog_path.is_file() {
            let catalog_stage_id = read_antenna_stage_catalog_id(&catalog_path)?;
            return Ok(ResolvedAntennaStageCatalog {
                artifact_dir,
                catalog_path,
                stage_id: catalog_stage_id.unwrap_or_else(|| {
                    direct_match
                        .as_ref()
                        .map(|(_, _, stage_id)| stage_id.clone())
                        .unwrap_or_else(|| requested_stage_id.to_string())
                }),
                stage_revision,
            });
        }
    }

    Err(ApiError::not_found(format!(
        "antenna stage '{}' output catalog not found",
        requested_stage_id
    )))
}

fn read_antenna_stage_catalog_id(path: &FsPath) -> Result<Option<String>, ApiError> {
    let bytes = std::fs::read(path).map_err(|error| {
        ApiError::internal(format!(
            "failed to read antenna stage output catalog '{}': {error}",
            path.display()
        ))
    })?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| {
        ApiError::internal(format!(
            "invalid antenna stage output catalog '{}': {error}",
            path.display()
        ))
    })?;
    Ok(value
        .get("stage_id")
        .and_then(Value::as_str)
        .map(str::to_string))
}

fn resolve_antenna_stage_artifact_ref(
    artifact_dir: &FsPath,
    artifact_ref: &str,
    filename: &str,
) -> Result<Option<PathBuf>, ApiError> {
    let candidate = FsPath::new(artifact_ref);
    let full_path = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        artifact_dir.join(sanitize_artifact_relative_path(artifact_ref)?)
    };
    let expected_root = artifact_dir
        .parent()
        .map(FsPath::to_path_buf)
        .unwrap_or_else(|| artifact_dir.to_path_buf());
    if full_path.is_absolute() && !full_path.starts_with(&expected_root) {
        return Err(ApiError::bad_request(
            "antenna stage artifact path must stay under the active workspace",
        ));
    }
    if full_path.is_file()
        && full_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name == filename)
    {
        return Ok(Some(full_path));
    }
    if full_path.is_dir() {
        let nested = full_path.join(filename);
        if nested.is_file() {
            return Ok(Some(nested));
        }
    }
    Ok(None)
}

fn antenna_stage_identifier_matches(
    record: &crate::types::StageExecutionRecord,
    index: usize,
    requested: &str,
) -> bool {
    record.stage_id.as_deref() == Some(requested)
        || format!("stage-{index:03}") == requested
        || format!("stage_{index}") == requested
        || index.to_string() == requested
}

#[derive(Debug)]
struct ParsedAntennaStageOutputCatalog {
    schema_version: String,
    stage_id: String,
    stage_kind: String,
    port_mode_id: String,
    status: String,
    solution_id: Option<String>,
    outputs: Vec<AntennaStageOutputResource>,
    diagnostic: Option<String>,
}

fn parse_antenna_stage_output_catalog(
    value: &Value,
    expected_stage_id: &str,
    artifact_dir: &FsPath,
) -> Result<ParsedAntennaStageOutputCatalog, ApiError> {
    let catalog: StoredAntennaStageOutputCatalog = serde_json::from_value(value.clone())
        .map_err(|error| ApiError::internal(format!("invalid antenna stage output catalog: {error}")))?;
    if catalog.schema_version != ANTENNA_STAGE_OUTPUT_CATALOG_SCHEMA {
        return Err(ApiError::internal(format!(
            "unsupported antenna stage output catalog schema '{}'",
            catalog.schema_version
        )));
    }
    if catalog.stage_id != expected_stage_id {
        return Err(ApiError::conflict_with_code(
            "stage_output_identity_conflict",
            format!(
                "antenna stage output catalog belongs to stage '{}' instead of '{}'",
                catalog.stage_id, expected_stage_id
            ),
        ));
    }
    if catalog.stage_kind != "antenna_field_solve" {
        return Err(ApiError::internal(format!(
            "unsupported antenna stage output catalog kind '{}'",
            catalog.stage_kind
        )));
    }
    if catalog.port_mode_id.trim().is_empty() {
        return Err(ApiError::internal(
            "antenna stage output catalog has an empty port_mode_id",
        ));
    }
    match catalog.status.as_str() {
        "ready" if catalog.outputs.is_empty() => {
            return Err(ApiError::internal(
                "ready antenna stage output catalog has no outputs",
            ));
        }
        "cancelled" | "failed" if !catalog.outputs.is_empty() => {
            return Err(ApiError::internal(
                "terminal antenna stage output catalog must not expose outputs",
            ));
        }
        "ready" | "cancelled" | "failed" => {}
        status => {
            return Err(ApiError::internal(format!(
                "unsupported antenna stage output catalog status '{status}'",
            )))
        }
    }

    let mut outputs = Vec::with_capacity(catalog.outputs.len());
    for output in catalog.outputs {
        if output.kind != "antenna_field_solution" {
            return Err(ApiError::internal(format!(
                "unsupported antenna stage output kind '{}'",
                output.kind
            )));
        }
        if output.output_id != output.solution_ref.output_id
            || output.solution_ref.stage_id != expected_stage_id
            || output.solution_ref.output_id.trim().is_empty()
            || output.solution_ref.asset_id.trim().is_empty()
            || output.solution_ref.content_digest.trim().is_empty()
        {
            return Err(ApiError::conflict_with_code(
                "stage_output_identity_conflict",
                format!(
                    "antenna stage output '{}' has an incompatible solution reference",
                    output.output_id
                ),
            ));
        }
        let manifest_ref = sanitize_artifact_relative_path(&output.manifest_ref)?;
        if try_resolve_artifact_path(artifact_dir, &manifest_ref.display().to_string())?.is_none() {
            return Err(ApiError::not_found(format!(
                "antenna field solution manifest '{}' not found",
                output.manifest_ref
            )));
        }
        outputs.push(AntennaStageOutputResource {
            kind: output.kind,
            output_id: output.output_id,
            solution_ref: AntennaStageOutputSolutionReferenceResource {
                stage_id: output.solution_ref.stage_id,
                output_id: output.solution_ref.output_id,
                asset_id: output.solution_ref.asset_id,
                content_digest: output.solution_ref.content_digest,
            },
            manifest_ref: manifest_ref.display().to_string().replace('\\', "/"),
            quantity_ids: output.quantity_ids,
            reused_existing: output.reused_existing,
        });
    }

    Ok(ParsedAntennaStageOutputCatalog {
        schema_version: catalog.schema_version,
        stage_id: catalog.stage_id,
        stage_kind: catalog.stage_kind,
        port_mode_id: catalog.port_mode_id,
        status: catalog.status,
        solution_id: catalog.solution_id,
        outputs,
        diagnostic: catalog.diagnostic,
    })
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
        (status = 422, description = "Source spectrum sampling topology is unsupported"),
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
    validate_source_spectrum_realization(&parsed.sampling.realization)?;
    validate_source_spectrum_payloads(&artifact_dir, &output_id, parsed.payloads.as_ref())?;

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
        (status = 422, description = "Source spectrum sampling topology is unsupported"),
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
    validate_source_spectrum_realization(&manifest.sampling.realization)?;
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
            ApiError::not_found_with_code(
                "missing_payload",
                format!("source-spectrum payload '{}' not found", reference.path),
            )
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

fn validate_source_spectrum_realization(realization: &str) -> Result<(), ApiError> {
    if SUPPORTED_SOURCE_SPECTRUM_REALIZATIONS.contains(&realization) {
        return Ok(());
    }
    Err(ApiError::unprocessable_with_code(
        "unsupported_topology",
        format!(
            "source-spectrum sampling realization '{realization}' is unsupported by this API"
        ),
    ))
}

fn validate_source_spectrum_payloads(
    artifact_dir: &FsPath,
    output_id: &str,
    payloads: Option<&AntennaSpectrumPayloads>,
) -> Result<(), ApiError> {
    let Some(payloads) = payloads else {
        return Ok(());
    };
    let prefix = format!("antenna/source_spectra/{output_id}/");
    for reference in [
        &payloads.k_u_rad_per_m,
        &payloads.k_v_rad_per_m,
        &payloads.amplitudes_re_im,
        &payloads.power,
    ] {
        if !reference.path.starts_with(&prefix) {
            return Err(ApiError::internal(
                "antenna source spectrum payload path escapes its output namespace",
            ));
        }
        if crate::artifacts::try_resolve_artifact_path(artifact_dir, &reference.path)?.is_none() {
            return Err(ApiError::not_found_with_code(
                "missing_payload",
                format!("source-spectrum payload '{}' not found", reference.path),
            ));
        }
    }
    Ok(())
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
    fn antenna_stage_output_catalog_parser_accepts_ready_output_and_verifies_manifest() {
        let artifact_dir = std::env::temp_dir().join(format!(
            "fullmag-antenna-stage-catalog-parser-{}",
            std::process::id()
        ));
        let manifest_ref = "antenna/field_solutions/solution-1/manifest.v1.json";
        let manifest_path = manifest_ref
            .split('/')
            .fold(artifact_dir.clone(), |path, segment| path.join(segment));
        std::fs::create_dir_all(manifest_path.parent().expect("manifest parent"))
            .expect("create manifest directory");
        std::fs::write(&manifest_path, b"{}").expect("write manifest fixture");
        let catalog = serde_json::json!({
            "schema_version": ANTENNA_STAGE_OUTPUT_CATALOG_SCHEMA,
            "stage_id": "solve-1",
            "stage_kind": "antenna_field_solve",
            "port_mode_id": "port-1",
            "status": "ready",
            "outputs": [{
                "kind": "antenna_field_solution",
                "output_id": "solution-1",
                "solution_ref": {
                    "stage_id": "solve-1",
                    "output_id": "solution-1",
                    "asset_id": "asset-1",
                    "content_digest": "sha256:solution-1"
                },
                "manifest_ref": manifest_ref,
                "quantity_ids": ["H_ant_basis"],
                "reused_existing": false
            }]
        });

        let parsed = parse_antenna_stage_output_catalog(&catalog, "solve-1", &artifact_dir)
            .expect("ready catalog should parse");
        assert_eq!(parsed.status, "ready");
        assert_eq!(parsed.outputs[0].solution_ref.asset_id, "asset-1");
        assert_eq!(parsed.outputs[0].manifest_ref, manifest_ref);
        let _ = std::fs::remove_dir_all(artifact_dir);
    }

    #[test]
    fn antenna_stage_output_catalog_parser_rejects_stage_identity_conflict() {
        let catalog = serde_json::json!({
            "schema_version": ANTENNA_STAGE_OUTPUT_CATALOG_SCHEMA,
            "stage_id": "other-stage",
            "stage_kind": "antenna_field_solve",
            "port_mode_id": "port-1",
            "status": "cancelled",
            "outputs": []
        });
        let error = parse_antenna_stage_output_catalog(
            &catalog,
            "solve-1",
            FsPath::new("C:/fullmag/artifacts"),
        )
        .expect_err("catalog from another stage must fail closed");
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(error.code.as_deref(), Some("stage_output_identity_conflict"));
    }

    #[test]
    fn antenna_stage_output_catalog_parser_rejects_ready_catalog_without_outputs() {
        let catalog = serde_json::json!({
            "schema_version": ANTENNA_STAGE_OUTPUT_CATALOG_SCHEMA,
            "stage_id": "solve-1",
            "stage_kind": "antenna_field_solve",
            "port_mode_id": "port-1",
            "status": "ready",
            "outputs": []
        });
        let error = parse_antenna_stage_output_catalog(
            &catalog,
            "solve-1",
            FsPath::new("C:/fullmag/artifacts"),
        )
        .expect_err("ready catalog without outputs must fail closed");
        assert_eq!(error.status, axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    }

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

    #[test]
    fn source_spectrum_api_distinguishes_missing_payload_and_unsupported_topology() {
        let unsupported = validate_source_spectrum_realization("direct_rt0_evaluation_v1")
            .expect_err("unqualified topology must be rejected");
        assert_eq!(unsupported.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(unsupported.code.as_deref(), Some("unsupported_topology"));

        let reference = AntennaSpectrumPayloadRef {
            path: "antenna/source_spectra/output/power.f64le".into(),
            sha256: "sha256:missing".into(),
            scalar_type: "float64_le".into(),
            layout: "kv_ku_power".into(),
            unit: "(A/m/A)^2".into(),
            value_count: 1,
        };
        let payloads = AntennaSpectrumPayloads {
            k_u_rad_per_m: reference.clone(),
            k_v_rad_per_m: reference.clone(),
            amplitudes_re_im: reference.clone(),
            power: reference,
        };
        let artifact_dir = std::env::temp_dir().join(format!(
            "fullmag-antenna-api-missing-payload-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&artifact_dir).expect("create missing-payload fixture");
        let missing = validate_source_spectrum_payloads(
            &artifact_dir,
            "output",
            Some(&payloads),
        )
        .expect_err("missing binary must be reported");
        assert_eq!(missing.status, axum::http::StatusCode::NOT_FOUND);
        assert_eq!(missing.code.as_deref(), Some("missing_payload"));
        let _ = std::fs::remove_dir_all(artifact_dir);
    }
}
