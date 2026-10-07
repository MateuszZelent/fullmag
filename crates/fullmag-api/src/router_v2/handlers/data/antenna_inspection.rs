//! Separate inspection resources: raw V/RT0/H is never a qualified field basis.
use std::fs;
use std::io::Read;
use std::path::{Component, Path as FsPath, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue};
use axum::response::Response;
use fullmag_ir::FieldTargetIR;
use fullmag_runner::{
    AntennaExternalLeadPayloadRef, AntennaExternalLeadSolutionManifest,
    AntennaExternalLeadSolutionRef, LoadedAntennaExternalLeadSolution,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use super::antenna::AntennaFieldTargetResource;
use crate::error::ApiError;
use crate::session::current_artifact_dir;
use crate::types::{AppState, CurrentLiveRequestContext, SessionStateResponse};

const RECORD_NAME: &str = "antenna_external_lead_stage_output.v1.json";
const RECORD_LIMIT: usize = 1 << 20;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AntennaInspectionReferenceResource {
    pub stage_id: String,
    pub output_id: String,
    pub content_digest: String,
}

impl AntennaInspectionReferenceResource {
    fn runner_reference(&self) -> AntennaExternalLeadSolutionRef {
        AntennaExternalLeadSolutionRef {
            stage_id: self.stage_id.clone(),
            output_id: self.output_id.clone(),
            content_digest: self.content_digest.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AntennaInspectionOutputResource {
    pub kind: String,
    pub inspection_ref: AntennaInspectionReferenceResource,
    pub manifest_ref: String,
    pub payload_units: std::collections::BTreeMap<String, String>,
    pub reused_existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AntennaInspectionStageRecordResource {
    pub schema_version: String,
    pub stage_kind: String,
    pub resolved_action: String,
    pub stage_id: String,
    pub port_mode_id: String,
    pub output_id: String,
    pub status: String,
    pub qualification: String,
    pub field_scope: String,
    pub outputs: Vec<AntennaInspectionOutputResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AntennaInspectionPayloadResource {
    pub path: String,
    pub sha256: String,
    pub byte_count: u64,
    pub scalar_type: String,
    pub layout: String,
    pub unit: String,
    pub value_count: u64,
}

impl From<AntennaExternalLeadPayloadRef> for AntennaInspectionPayloadResource {
    fn from(value: AntennaExternalLeadPayloadRef) -> Self {
        Self {
            path: value.path,
            sha256: value.sha256,
            byte_count: value.byte_count,
            scalar_type: value.scalar_type,
            layout: value.layout,
            unit: value.unit,
            value_count: value.value_count,
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AntennaInspectionSamplingResource {
    pub domain: AntennaFieldTargetResource,
    pub carrier_kind: String,
    pub location: String,
    pub topology_digest: String,
    pub sample_count: u64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AntennaInspectionManifestResource {
    pub schema_version: String,
    pub validation_scope: String,
    pub source_object_id: String,
    pub current_transport_id: String,
    pub drive_id: String,
    pub closure_revision: String,
    pub input_pins: Value,
    pub requested_execution: Value,
    pub resolved_execution: Value,
    pub solver_policy: Value,
    pub sampling_carrier: AntennaInspectionSamplingResource,
    pub charge_content_sha256: String,
    pub source_content_sha256: String,
    pub field_content_sha256: String,
    pub content_digest: String,
    pub bundle: AntennaInspectionPayloadResource,
    pub sample_positions: AntennaInspectionPayloadResource,
    pub magnetic_field: AntennaInspectionPayloadResource,
    pub device_vertex_ids: AntennaInspectionPayloadResource,
    pub device_potential: AntennaInspectionPayloadResource,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AntennaExternalLeadInspectionResource {
    pub resource_id: String,
    pub session_id: String,
    pub session_epoch: String,
    pub request_scope_epoch: String,
    pub run_id: String,
    pub runtime_stage_id: String,
    pub stage_revision: u64,
    pub record_content_digest: String,
    #[serde(flatten)]
    pub record: AntennaInspectionStageRecordResource,
    pub manifest: Option<AntennaInspectionManifestResource>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AntennaInspectionPayloadQuery {
    pub content_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct InspectionOwner {
    request_context: CurrentLiveRequestContext,
    session_id: String,
    session_epoch: String,
    run_id: String,
    runtime_stage_id: String,
    artifact_dir: PathBuf,
    artifact_refs: Vec<String>,
}

struct InspectionSnapshot {
    owner: InspectionOwner,
    stage_revision: u64,
}

fn capture(
    snapshot: &SessionStateResponse,
    stage_id: &str,
    request_context: CurrentLiveRequestContext,
) -> Result<InspectionSnapshot, ApiError> {
    let execution = snapshot
        .stage_execution
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no stage execution state"))?;
    let mut stages = execution
        .stages
        .iter()
        .filter(|stage| stage.stage_id.as_deref() == Some(stage_id));
    let stage = stages
        .next()
        .ok_or_else(|| ApiError::not_found("inspection stage not found"))?;
    if stages.next().is_some() {
        return Err(invalid("duplicate runtime stage identity"));
    }
    let epoch = crate::router_v2::handlers::sessions::current_live_session_epoch(snapshot);
    let run_id = snapshot
        .run
        .as_ref()
        .map(|run| run.run_id.clone())
        .unwrap_or_else(|| snapshot.session.run_id.clone());
    Ok(InspectionSnapshot {
        owner: InspectionOwner {
            request_context,
            session_id: snapshot.session.session_id.clone(),
            session_epoch: epoch,
            run_id,
            runtime_stage_id: stage_id.into(),
            artifact_dir: current_artifact_dir(snapshot)
                .ok_or_else(|| ApiError::not_found("no current artifact root"))?,
            artifact_refs: stage.artifact_refs.clone(),
        },
        stage_revision: snapshot.state_version,
    })
}

async fn snapshot(state: &Arc<AppState>, stage_id: &str) -> Result<InspectionSnapshot, ApiError> {
    let request_context = crate::capture_current_live_request_context(state).await?;
    let _transition = state.current_live_session_transition.lock().await;
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state.current_live_session_epoch.load(Ordering::Acquire),
    )?;
    capture(
        snapshot,
        stage_id,
        request_context,
    )
}

async fn check_owner(state: &Arc<AppState>, expected: &InspectionOwner) -> Result<(), ApiError> {
    let actual = snapshot(state, &expected.runtime_stage_id)
        .await
        .map_err(|_| {
            ApiError::conflict_with_code(
                "inspection_owner_changed",
                "inspection session/run/stage changed during read",
            )
        })?;
    if actual.owner != *expected {
        return Err(ApiError::conflict_with_code(
            "inspection_owner_changed",
            "inspection owner or artifact refs changed during read",
        ));
    }
    Ok(())
}

fn invalid(message: impl Into<String>) -> ApiError {
    ApiError::unprocessable_with_code("invalid_antenna_inspection", message)
}

fn nonblank(value: &str) -> bool {
    !value.trim().is_empty() && value.len() <= 4096 && !value.contains('\0')
}

fn parse_record(bytes: &[u8]) -> Result<AntennaInspectionStageRecordResource, ApiError> {
    if bytes.is_empty() || bytes.len() > RECORD_LIMIT {
        return Err(invalid("inspection record exceeds byte bound"));
    }
    let record: AntennaInspectionStageRecordResource = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("invalid inspection record shape: {error}")))?;
    if record.schema_version != "antenna_external_lead_stage_output.v1"
        || record.stage_kind != "antenna_field_solve"
        || record.resolved_action != "external_lead_inspection"
        || record.qualification != "NOT VERIFIED"
        || record.field_scope != "external_electrode_truncation"
        || ![&record.stage_id, &record.port_mode_id, &record.output_id]
            .into_iter()
            .all(|s| nonblank(s))
    {
        return Err(invalid("inspection schema/scope/identity mismatch"));
    }
    match record.status.as_str() {
        "inspection_only" if record.outputs.len() == 1 && record.diagnostic.is_none() => {
            let output = &record.outputs[0];
            let reference = &output.inspection_ref;
            let digest = reference
                .content_digest
                .strip_prefix("sha256:")
                .filter(|s| {
                    s.len() == 64
                        && s.bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or_else(|| invalid("invalid inspection digest"))?;
            let expected_manifest = format!(
                "antenna/external_lead_solutions/{}/{digest}/manifest.v1.json",
                reference.output_id
            );
            let expected_units = serde_json::json!({"V": "V", "RT0_coefficients": "A", "H": "A/m", "positions": "m"});
            if output.kind != "antenna_external_lead_inspection"
                || reference.stage_id != record.stage_id
                || reference.output_id != record.output_id
                || output.manifest_ref != expected_manifest
                || serde_json::to_value(&output.payload_units)
                    .map_err(|e| invalid(e.to_string()))?
                    != expected_units
            {
                return Err(invalid("inspection reference/units/manifest path mismatch"));
            }
        }
        "failed" | "cancelled"
            if record.outputs.is_empty()
                && record
                    .diagnostic
                    .as_deref()
                    .is_some_and(|s| !s.trim().is_empty() && !s.contains('\0')) => {}
        _ => return Err(invalid("inspection status/output contract mismatch")),
    }
    Ok(record)
}

fn read_registered_record(owner: &InspectionOwner) -> Result<Vec<u8>, ApiError> {
    let mut refs = owner.artifact_refs.iter().filter(|reference| {
        FsPath::new(reference)
            .file_name()
            .is_some_and(|name| name == RECORD_NAME)
    });
    let reference = refs.next().ok_or_else(|| {
        ApiError::not_found_with_code(
            "missing_antenna_inspection",
            "stage has no registered inspection result",
        )
    })?;
    if refs.next().is_some() {
        return Err(invalid("multiple registered inspection records"));
    }
    let reference = FsPath::new(reference);
    let root = fs::canonicalize(&owner.artifact_dir)?;
    let relative = if reference.is_absolute() {
        reference
            .strip_prefix(&owner.artifact_dir)
            .or_else(|_| reference.strip_prefix(&root))
            .map_err(|_| invalid("registered inspection record escapes artifact root"))?
    } else if !owner.artifact_dir.is_absolute() && reference.starts_with(&owner.artifact_dir) {
        reference
            .strip_prefix(&owner.artifact_dir)
            .map_err(|_| invalid("invalid relative inspection record"))?
    } else {
        reference
    };
    if !relative
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err(invalid(
            "inspection record path contains traversal or alias components",
        ));
    }
    let expected = PathBuf::from("antenna")
        .join("external_lead_stage_outputs")
        .join(&owner.runtime_stage_id)
        .join(RECORD_NAME);
    if relative != expected {
        return Err(invalid(
            "inspection record is outside its registered runtime stage namespace",
        ));
    }
    // Operator root aliases are allowed; descendants must be real, unaliased paths.
    // These checks assume trusted local writers, not a hostile TOCTOU filesystem.
    let mut path = root.clone();
    for component in relative.components() {
        path.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ApiError::not_found_with_code(
                    "missing_antenna_inspection",
                    "registered inspection record is missing",
                )
            } else {
                ApiError::internal(error.to_string())
            }
        })?;
        if metadata.file_type().is_symlink()
            || fs::canonicalize(&path)? != path
            || !path.starts_with(&root)
        {
            return Err(invalid(
                "inspection record descendant aliases or escapes artifact root",
            ));
        }
        if path.file_name().is_some_and(|name| name == RECORD_NAME) {
            if !metadata.is_file() || metadata.len() > RECORD_LIMIT as u64 {
                return Err(invalid("inspection record is not a bounded regular file"));
            }
        } else if !metadata.is_dir() {
            return Err(invalid("inspection record parent is not a directory"));
        }
    }
    let mut file = fs::File::open(&path)?;
    let length = file.metadata()?.len();
    if length > RECORD_LIMIT as u64 {
        return Err(invalid("inspection record grew before read"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(RECORD_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > RECORD_LIMIT
        || bytes.len() as u64 != length
        || file.metadata()?.len() != length
    {
        return Err(invalid("inspection record changed during bounded read"));
    }
    Ok(bytes)
}

fn json_value<T: Serialize>(value: &T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::internal(e.to_string()))
}

fn manifest_resource(
    manifest: AntennaExternalLeadSolutionManifest,
) -> Result<AntennaInspectionManifestResource, ApiError> {
    let domain = match manifest.sampling_carrier.domain {
        FieldTargetIR::Global {} => AntennaFieldTargetResource::Global,
        FieldTargetIR::Object { object_id } => AntennaFieldTargetResource::Object { object_id },
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => AntennaFieldTargetResource::Region {
            object_id,
            region_id,
        },
    };
    Ok(AntennaInspectionManifestResource {
        schema_version: manifest.schema_version,
        validation_scope: "manifest_only".into(),
        source_object_id: manifest.source_object_id,
        current_transport_id: manifest.current_transport_id,
        drive_id: manifest.drive_id,
        closure_revision: manifest.closure_revision,
        input_pins: json_value(&manifest.input_pins)?,
        requested_execution: json_value(&manifest.requested_execution)?,
        resolved_execution: json_value(&manifest.resolved_execution)?,
        solver_policy: json_value(&manifest.solver_policy)?,
        sampling_carrier: AntennaInspectionSamplingResource {
            domain,
            carrier_kind: manifest.sampling_carrier.carrier_kind,
            location: manifest.sampling_carrier.location,
            topology_digest: manifest.sampling_carrier.topology_digest,
            sample_count: manifest.sampling_carrier.sample_count,
        },
        charge_content_sha256: manifest.charge_content_sha256,
        source_content_sha256: manifest.source_content_sha256,
        field_content_sha256: manifest.field_content_sha256,
        content_digest: manifest.content_digest,
        bundle: manifest.bundle.into(),
        sample_positions: manifest.sample_positions.into(),
        magnetic_field: manifest.magnetic_field.into(),
        device_vertex_ids: manifest.device_vertex_ids.into(),
        device_potential: manifest.device_potential.into(),
    })
}

fn validate_port(
    record: &AntennaInspectionStageRecordResource,
    manifest: &AntennaExternalLeadSolutionManifest,
) -> Result<(), ApiError> {
    if manifest.port_mode_id != record.port_mode_id {
        return Err(invalid("inspection stage/manifest port identity mismatch"));
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/antenna/stages/{stage_id}/external-lead-inspection",
    params(
        ("stage_id" = String, Path, description = "Exact runtime stage ID, not the authored antenna stage ID"),
        ("x-fullmag-session-scope" = Option<String>, Header, description = "Canonical current-session scope; stale scope is rejected before artifact reads"),
        ("If-None-Match" = Option<String>, Header, description = "Previous strong ETag"),
    ),
    responses(
        (status = 200, description = "Inspection record and manifest-only metadata; never a drive basis", body = AntennaExternalLeadInspectionResource),
        (status = 304, description = "Unchanged manifest-only resource"),
        (status = 404, description = "No registered inspection result", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale request scope or owner changed during read", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Invalid inspection record or manifest", body = crate::schemas::common::ApiErrorResponse),
        (status = 500, description = "Filesystem or worker failure", body = crate::schemas::common::ApiErrorResponse),
    ),
    tag = "data"
)]
pub async fn get_antenna_external_lead_inspection(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let snapshot = snapshot(&state, &stage_id).await?;
    let owner = snapshot.owner.clone();
    let resource = tokio::task::spawn_blocking(move || {
        let bytes = read_registered_record(&snapshot.owner)?;
        let record = parse_record(&bytes)?;
        let manifest = if let Some(output) = record.outputs.first() {
            let manifest = fullmag_runner::load_published_antenna_external_lead_solution_manifest(
                &snapshot.owner.artifact_dir,
                &output.inspection_ref.runner_reference(),
            )
            .map_err(|e| invalid(e.message))?;
            validate_port(&record, &manifest)?;
            Some(manifest_resource(manifest)?)
        } else {
            None
        };
        Ok::<_, ApiError>(AntennaExternalLeadInspectionResource {
            resource_id: format!(
                "data/antenna/stages/{}/external-lead-inspection",
                snapshot.owner.runtime_stage_id
            ),
            session_id: snapshot.owner.session_id,
            session_epoch: snapshot.owner.session_epoch,
            request_scope_epoch: snapshot.owner.request_context.request_scope_epoch,
            run_id: snapshot.owner.run_id,
            runtime_stage_id: snapshot.owner.runtime_stage_id,
            stage_revision: snapshot.stage_revision,
            record_content_digest: format!("sha256:{}", digest(&bytes)),
            record,
            manifest,
        })
    })
    .await
    .map_err(|e| ApiError::internal(format!("inspection metadata worker: {e}")))??;
    check_owner(&state, &owner).await?;
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&digest(
        &serde_json::to_vec(&resource).map_err(|e| ApiError::internal(e.to_string()))?,
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &resource))
}

fn select_payload(
    loaded: LoadedAntennaExternalLeadSolution,
    kind: &str,
) -> Result<(AntennaExternalLeadPayloadRef, Vec<u8>), ApiError> {
    let (descriptor, bytes) = match kind {
        "bundle" => (loaded.manifest.bundle, loaded.canonical_bundle),
        "sample_positions" => (
            loaded.manifest.sample_positions,
            loaded
                .sample_positions_xyz_m
                .into_iter()
                .flatten()
                .flat_map(f64::to_le_bytes)
                .collect(),
        ),
        "magnetic_field" => (
            loaded.manifest.magnetic_field,
            loaded
                .magnetic_field_xyz_apm
                .into_iter()
                .flatten()
                .flat_map(f64::to_le_bytes)
                .collect(),
        ),
        "device_vertex_ids" => (
            loaded.manifest.device_vertex_ids,
            loaded
                .device_vertex_ids
                .into_iter()
                .flat_map(u64::to_le_bytes)
                .collect(),
        ),
        "device_potential" => (
            loaded.manifest.device_potential,
            loaded
                .device_potential_v
                .into_iter()
                .flat_map(f64::to_le_bytes)
                .collect(),
        ),
        _ => return Err(ApiError::bad_request("unknown inspection payload kind")),
    };
    if descriptor.byte_count != bytes.len() as u64 || descriptor.sha256 != digest(&bytes) {
        return Err(invalid(
            "selected inspection payload differs from verified manifest",
        ));
    }
    Ok((descriptor, bytes))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/antenna/stages/{stage_id}/external-lead-inspection/payloads/{payload_kind}",
    params(
        ("stage_id" = String, Path, description = "Exact runtime stage ID"),
        ("payload_kind" = String, Path, description = "bundle, sample_positions, magnetic_field, device_vertex_ids, device_potential"),
        ("content_digest" = String, Query, description = "Required sha256: digest from inspection_ref, not the stage record digest"),
        ("x-fullmag-session-scope" = Option<String>, Header, description = "Canonical current-session scope; stale scope is rejected before artifact reads"),
        ("If-None-Match" = Option<String>, Header, description = "Previous strong ETag"),
        ("Range" = Option<String>, Header, description = "One byte range"),
    ),
    responses(
        (status = 200, description = "Fully verified inspection binary payload", content_type = "application/octet-stream"),
        (status = 206, description = "Verified payload byte range", content_type = "application/octet-stream"),
        (status = 304, description = "Unchanged, after full integrity validation"),
        (status = 400, description = "Invalid payload kind or query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "No registered result", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale request scope, owner changed, terminal result or digest mismatch", body = crate::schemas::common::ApiErrorResponse),
        (status = 416, description = "Invalid byte range"),
        (status = 422, description = "Invalid manifest or binary payload", body = crate::schemas::common::ApiErrorResponse),
        (status = 500, description = "Filesystem or worker failure", body = crate::schemas::common::ApiErrorResponse),
    ),
    tag = "data"
)]
pub async fn get_antenna_external_lead_inspection_payload(
    State(state): State<Arc<AppState>>,
    Path((stage_id, payload_kind)): Path<(String, String)>,
    query: Result<Query<AntennaInspectionPayloadQuery>, axum::extract::rejection::QueryRejection>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(|error| {
        ApiError::bad_request(format!("invalid inspection payload query: {error}"))
    })?;
    if ![
        "bundle",
        "sample_positions",
        "magnetic_field",
        "device_vertex_ids",
        "device_potential",
    ]
    .contains(&payload_kind.as_str())
    {
        return Err(ApiError::bad_request("unknown inspection payload kind"));
    }
    let snapshot = snapshot(&state, &stage_id).await?;
    let owner = snapshot.owner.clone();
    let (etag, bytes) = tokio::task::spawn_blocking(move || {
        let record = parse_record(&read_registered_record(&snapshot.owner)?)?;
        let output = record.outputs.first().ok_or_else(|| {
            ApiError::conflict_with_code(
                "inspection_has_no_payload",
                "failed/cancelled inspection has no payload",
            )
        })?;
        if output.inspection_ref.content_digest != query.content_digest {
            return Err(ApiError::conflict_with_code(
                "inspection_digest_mismatch",
                "inspection revision differs from requested digest",
            ));
        }
        let loaded = fullmag_runner::load_published_antenna_external_lead_solution(
            &snapshot.owner.artifact_dir,
            &output.inspection_ref.runner_reference(),
        )
        .map_err(|e| invalid(e.message))?;
        validate_port(&record, &loaded.manifest)?;
        let (descriptor, bytes) = select_payload(loaded, &payload_kind)?;
        let token = serde_json::to_vec(&(
            &snapshot.owner.session_id,
            &snapshot.owner.session_epoch,
            &snapshot.owner.request_context.request_scope_epoch,
            &snapshot.owner.run_id,
            snapshot.stage_revision,
            &snapshot.owner.runtime_stage_id,
            &record.stage_id,
            &record.output_id,
            &query.content_digest,
            &payload_kind,
            &descriptor.sha256,
        ))
        .map_err(|e| ApiError::internal(e.to_string()))?;
        Ok::<_, ApiError>((
            crate::router_v2::handlers::shared::stable_strong_etag(&digest(&token)),
            bytes,
        ))
    })
    .await
    .map_err(|e| ApiError::internal(format!("inspection payload worker: {e}")))??;
    check_owner(&state, &owner).await?;
    Ok(
        crate::router_v2::handlers::shared::conditional_binary_response_with_content_type(
            &headers,
            &etag,
            bytes,
            HeaderValue::from_static("application/octet-stream"),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn inspection_owner_recheck_rejects_same_identity_reopen() {
        let state = crate::router_v2::tests::test_app_state_with_live_session().await;
        {
            let mut current = state.current_live_state.write().await;
            current.as_mut().unwrap().stage_execution = Some(serde_json::from_value(serde_json::json!({
                "total_stages": 1, "runtime_state": "failed",
                "stages": [{"stage_id": "stage-000", "kind": "study_pipeline_antenna_field_solve",
                    "status": "failed", "artifact_refs": []}]
            })).unwrap());
        }
        let captured = snapshot(&state, "stage-000").await.unwrap();
        check_owner(&state, &captured.owner).await.unwrap();
        state.current_live_session_epoch.fetch_add(1, Ordering::Release);
        let error = check_owner(&state, &captured.owner).await.unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(error.code.as_deref(), Some("inspection_owner_changed"));
    }
}
