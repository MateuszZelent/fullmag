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
    AntennaExternalLeadCurrentDisplayReceipt, AntennaExternalLeadPayloadRef, AntennaExternalLeadSolutionManifest,
    AntennaExternalLeadSolutionRef, AntennaInspectionDeviceCurrentDisplay, LoadedAntennaExternalLeadSolution,
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
const CLOSED_RECORD_NAME: &str = "antenna_closed_loop_stage_output.v2.json";
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
    #[serde(default)]
    pub reused_existing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AntennaInspectionStageRecordResource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_object_id: Option<String>,
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
pub struct AntennaInspectionCurrentReceiptResource {
    pub schema_version: String,
    pub operator_version: String,
    pub current_evaluator_version: String,
    pub sampling_policy: String,
    pub center_policy: String,
    pub normalization: String,
    pub coordinate_unit: String,
    pub current_density_unit: String,
    pub cell_count: u64,
    pub payload: AntennaInspectionPayloadResource,
}

impl From<AntennaExternalLeadCurrentDisplayReceipt> for AntennaInspectionCurrentReceiptResource {
    fn from(value: AntennaExternalLeadCurrentDisplayReceipt) -> Self {
        Self {
            schema_version: value.schema_version,
            operator_version: value.operator_version,
            current_evaluator_version: value.current_evaluator_version,
            sampling_policy: value.sampling_policy,
            center_policy: value.center_policy,
            normalization: value.normalization,
            coordinate_unit: value.coordinate_unit,
            current_density_unit: value.current_density_unit,
            cell_count: value.cell_count,
            payload: value.payload.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AntennaInspectionCurrentDisplayResource {
    pub receipt: AntennaInspectionCurrentReceiptResource,
    pub center_positions: AntennaInspectionPayloadResource,
    pub center_current_density: AntennaInspectionPayloadResource,
    pub trace_positions: AntennaInspectionPayloadResource,
    pub trace_current_density: AntennaInspectionPayloadResource,
    pub ordered_snapshot: AntennaInspectionPayloadResource,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_display: Option<AntennaInspectionCurrentReceiptResource>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_loop_manifest: Option<Value>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AntennaInspectionDisplayCapabilities {
    pub display: bool,
    pub per_ampere_basis: bool,
    pub source_fft: bool,
    pub llg_drive: bool,
    pub current_density: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AntennaInspectionDisplayResource {
    pub schema_version: String,
    pub resource_id: String,
    pub session_id: String,
    pub session_epoch: String,
    pub request_scope_epoch: String,
    pub run_id: String,
    pub runtime_stage_id: String,
    pub stage_revision: u64,
    pub record_content_digest: String,
    pub content_digest: String,
    pub source_object_id: String,
    pub status: String,
    pub qualification: String,
    pub field_scope: String,
    pub normalization: String,
    pub capabilities: AntennaInspectionDisplayCapabilities,
    pub device_node_count: u64,
    pub device_cell_count: u64,
    pub sampling_carrier: AntennaInspectionSamplingResource,
    pub device_positions: AntennaInspectionPayloadResource,
    pub device_topology: AntennaInspectionPayloadResource,
    pub device_potential: AntennaInspectionPayloadResource,
    pub sample_positions: AntennaInspectionPayloadResource,
    pub magnetic_field: AntennaInspectionPayloadResource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_current: Option<AntennaInspectionCurrentDisplayResource>,
}

/// Shared verified display contract, without Live or accepted-run ownership.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AntennaInspectionDisplayDataResource {
    pub content_digest: String,
    pub source_object_id: String,
    pub status: String,
    pub qualification: String,
    pub field_scope: String,
    pub normalization: String,
    pub capabilities: AntennaInspectionDisplayCapabilities,
    pub device_node_count: u64,
    pub device_cell_count: u64,
    pub sampling_carrier: AntennaInspectionSamplingResource,
    pub device_positions: AntennaInspectionPayloadResource,
    pub device_topology: AntennaInspectionPayloadResource,
    pub device_potential: AntennaInspectionPayloadResource,
    pub sample_positions: AntennaInspectionPayloadResource,
    pub magnetic_field: AntennaInspectionPayloadResource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_current: Option<AntennaInspectionCurrentDisplayResource>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(untagged)]
pub enum AntennaInspectionDisplayFamilyResource {
    ExternalLead(AntennaInspectionDisplayResource),
    ClosedLoop(AntennaClosedLoopInspectionDisplayResource),
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct AntennaClosedLoopInspectionDisplayResource {
    pub schema_version: String,
    pub resource_id: String,
    pub session_id: String,
    pub session_epoch: String,
    pub request_scope_epoch: String,
    pub run_id: String,
    pub runtime_stage_id: String,
    pub stage_revision: u64,
    pub record_content_digest: String,
    pub content_digest: String,
    pub capabilities: AntennaInspectionDisplayCapabilities,
    pub normalization: String,
    pub closed_loop_display: Value,
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

/// Thin registry/record discovery. Retained owners still require full field admission.
pub(crate) async fn inspection_discovery_metadata(
    state: &Arc<AppState>,
    stage_ids: &[String],
    accepted_candidate: bool,
) -> Result<std::collections::BTreeMap<String, crate::schemas::runtime::AntennaInspectionDiscoveryResource>, ApiError> {
    use crate::schemas::runtime::{AntennaInspectionDiscoveryResource as Resource, AntennaInspectionDiscoveryState as Discovery};
    let unknown = |reason: &str| stage_ids.iter().map(|id| (id.clone(), Resource {
        state: Discovery::Unknown, reason_code: reason.into(),
    })).collect::<std::collections::BTreeMap<_, _>>();
    if stage_ids.len() > 64 { return Ok(unknown("inspection_discovery_budget")); }
    if stage_ids.iter().collect::<std::collections::BTreeSet<_>>().len() != stage_ids.len() {
        return Ok(unknown("ambiguous_inspection_owner"));
    }
    if stage_ids.is_empty() { return Ok(std::collections::BTreeMap::new()); }
    let context = crate::capture_current_live_request_context(state).await?;
    // Accepted discovery only admits Succeeded tasks. A negative lifecycle hint
    // skips that registry read; it never proves that an owner is retained.
    let accepted = if accepted_candidate {
        match super::accepted_inspection_fields::stage_ids(state).await {
            Ok(ids) => ids,
            Err(_) => {
                crate::validate_current_live_request_context(state, &context).await?;
                return Ok(unknown("inspection_discovery_unavailable"));
            }
        }
    } else { Vec::new() };
    let legacy = {
        let current = state.current_live_state.read().await;
        let snapshot = current.as_ref().ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(snapshot, &context,
            state.current_live_session_epoch.load(Ordering::Acquire))?;
        stage_ids.iter().filter_map(|id| {
            let registered = snapshot.stage_execution.as_ref().is_some_and(|execution|
                execution.stages.iter().any(|stage| stage.stage_id.as_deref() == Some(id.as_str())
                    && stage.artifact_refs.iter().any(|path| FsPath::new(path).file_name()
                        .is_some_and(|name| name == RECORD_NAME || name == CLOSED_RECORD_NAME))));
            registered.then(|| (id.clone(), capture(snapshot, id, context.clone()).map(|value| value.owner)))
        }).collect::<Vec<_>>()
    };
    let legacy = if legacy.is_empty() {
        std::collections::BTreeMap::new()
    } else {
        let permit = match Arc::clone(&state.quantity_data_plane.accepted_inspection_admission).acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => {
                crate::validate_current_live_request_context(state, &context).await?;
                return Ok(unknown("inspection_discovery_unavailable"));
            }
        };
        let result = tokio::task::spawn_blocking(move || {
            // Cancellation of the HTTP request must not release a still-running reader.
            let _permit = permit;
            legacy.into_iter().map(|(id, owner)| {
                let parsed = owner.and_then(|owner| read_registered_record(&owner))
                    .and_then(|bytes| parse_record(&bytes));
                (id, parsed.map(|record| record.status == "inspection_only"))
            }).collect::<std::collections::BTreeMap<_, _>>()
        }).await;
        match result {
            Ok(legacy) => legacy,
            Err(_) => {
                crate::validate_current_live_request_context(state, &context).await?;
                return Ok(unknown("inspection_discovery_unavailable"));
            }
        }
    };
    crate::validate_current_live_request_context(state, &context).await?;
    Ok(stage_ids.iter().map(|id| {
        let result = inspection_discovery_state(accepted.contains(id), legacy.get(id));
        (id.clone(), result)
    }).collect())
}

fn inspection_discovery_state(
    accepted: bool,
    legacy: Option<&Result<bool, ApiError>>,
) -> crate::schemas::runtime::AntennaInspectionDiscoveryResource {
    use crate::schemas::runtime::{AntennaInspectionDiscoveryResource as Resource, AntennaInspectionDiscoveryState as State};
    let (state, reason) = match (accepted, legacy) {
        (true, Some(_)) => (State::Unknown, "ambiguous_inspection_owner"),
        (true, None) | (false, Some(Ok(true))) => (State::Retained, "retained_inspection_metadata"),
        (false, Some(Err(_))) => (State::Unknown, "inspection_record_invalid"),
        (false, None) | (false, Some(Ok(false))) => (State::Absent, "no_retained_inspection"),
    };
    Resource { state, reason_code: reason.into() }
}

/// One owner-fenced entry into the common data plane; existing inspection guards remain private.
pub(super) async fn verified_inspection_fields(
    state: &Arc<AppState>, requested_stage: Option<&str>,
) -> Result<Option<Arc<super::inspection_field_provider::VerifiedInspectionFields>>, ApiError> {
    if let Some(fields) = super::accepted_inspection_fields::load(state, requested_stage).await? {
        return Ok(Some(fields));
    }
    let request_context=crate::capture_current_live_request_context(state).await?;
    let (captured, mesh_revision, topology_revision)={
        let _transition=state.current_live_session_transition.lock().await;
        let current=state.current_live_state.read().await;
        let Some(snapshot)=current.as_ref() else {return Ok(None);};
        crate::ensure_current_live_request_context(snapshot,&request_context,
            state.current_live_session_epoch.load(Ordering::Acquire))?;
        let candidates=snapshot.stage_execution.as_ref().map(|execution| execution.stages.iter()
            .filter(|stage| requested_stage.is_none_or(|id| stage.stage_id.as_deref()==Some(id)))
            .filter(|stage| stage.artifact_refs.iter().any(|path| FsPath::new(path).file_name()
                .is_some_and(|name| name==RECORD_NAME || name==CLOSED_RECORD_NAME)))
            .collect::<Vec<_>>()).unwrap_or_default();
        if candidates.is_empty() {return Ok(None);}
        if candidates.len()!=1 {return Err(ApiError::conflict_with_code("ambiguous_artifact_field_owner",
            "select one exact runtime stage before reading inspection fields"));}
        let id=candidates[0].stage_id.as_deref().ok_or_else(|| invalid("inspection runtime stage absent"))?;
        (capture(snapshot,id,request_context)?,snapshot.mesh_revision,
            crate::router_v2::handlers::sessions::status::domain_generation_revision(snapshot))
    };
    let expected=captured.owner.clone();
    let observation_state_version=captured.stage_revision;
    let data_plane=Arc::clone(&state.quantity_data_plane);
    // Share admission with accepted artifacts; cancelled HTTP requests must not
    // release the budget while their blocking reader is still decoding payloads.
    let permit=Arc::clone(&data_plane.accepted_inspection_admission).acquire_owned().await
        .map_err(|_| ApiError::internal("inspection reader admission closed"))?;
    let fields=tokio::task::spawn_blocking(move || {
        let _permit=permit;
        let bytes=read_registered_record(&captured.owner)?;
        let record=parse_record(&bytes)?;
        if record.status!="inspection_only" {return Err(ApiError::conflict_with_code("inspection_has_no_payload",
            "failed/cancelled inspection cannot materialize fields"));}
        let key=digest(format!("artifact-samples:{:?}:{}:{}:{}:{}",captured.owner,digest(&bytes),
            captured.stage_revision,mesh_revision,topology_revision).as_bytes());
        let mut owner=crate::schemas::fields::ArtifactFieldOwnerBinding {
            session_id:captured.owner.session_id.clone(),session_epoch:captured.owner.session_epoch.clone(),
            request_scope_epoch:captured.owner.request_context.request_scope_epoch.clone(),run_id:captured.owner.run_id.clone(),
            runtime_stage_id:captured.owner.runtime_stage_id.clone(),authored_stage_id:record.stage_id.clone(),
            module_id:String::new(),object_id:String::new(),output_id:record.output_id.clone(),
            source_digest:String::new(),content_digest:record.outputs[0].inspection_ref.content_digest.clone(),
            observation_mesh_revision:mesh_revision,observation_topology_revision:topology_revision,
            historical_inspection:true,accepted_artifact:None,native_mesh_identity:String::new(),native_topology_identity:String::new(),
        };
        let fields=if record.schema_version=="antenna_closed_loop_stage_output.v2" {
            let loaded=load_closed(&record,&captured.owner.artifact_dir)?;
            // Validate payload bytes before reusing decoded field views.
            if let Some(cached)=data_plane.verified_inspection_cache.lock()
                .map_err(|_| ApiError::internal("inspection cache poisoned"))?.get(&key) {return Ok(cached);}
            let text=|path:&[&str]| -> Result<String,ApiError> {
                let mut value=&loaded.metadata;for part in path {value=&value[*part];}
                value.as_str().filter(|v| nonblank(v)).map(str::to_owned).ok_or_else(|| invalid("verified field owner label absent"))
            };
            owner.object_id=text(&["source_object_id"])?;owner.module_id=text(&["current_transport_id"])?;
            owner.source_digest=text(&["source","accepted_source_state_digest"])?;
            owner.native_mesh_identity=text(&["resolved_execution","mesh_revision"])?;
            owner.native_topology_identity=text(&["resolved_execution","topology_revision"])?;
            super::inspection_field_provider::from_closed(owner,loaded,captured.stage_revision)?
        } else {
            let output=&record.outputs[0];
            let loaded=fullmag_runner::load_published_antenna_external_lead_solution(
                &captured.owner.artifact_dir,&output.inspection_ref.runner_reference()).map_err(|e| invalid(e.message))?;
            validate_port(&record,&loaded.manifest)?;
            // Validate payload bytes before reusing decoded field views.
            if let Some(cached)=data_plane.verified_inspection_cache.lock()
                .map_err(|_| ApiError::internal("inspection cache poisoned"))?.get(&key) {return Ok(cached);}
            owner.object_id=loaded.manifest.source_object_id.clone();owner.module_id=loaded.manifest.current_transport_id.clone();
            owner.source_digest=loaded.manifest.source_content_sha256.clone();
            owner.native_mesh_identity=loaded.manifest.input_pins.device_mesh_ownership_sha256.clone();
            owner.native_topology_identity=loaded.manifest.input_pins.combined_mesh_material_sha256.clone();
            super::inspection_field_provider::from_external(owner,loaded,captured.stage_revision)?
        };
        let fields=Arc::new(fields);
        data_plane.verified_inspection_cache.lock().map_err(|_| ApiError::internal("inspection cache poisoned"))?
            .insert(key,Arc::clone(&fields))?;
        Ok::<_,ApiError>(fields)
    }).await.map_err(|e| ApiError::internal(format!("inspection field worker: {e}")))??;
    check_owner(state,&expected).await?;
    let current=state.current_live_state.read().await;
    let actual=current.as_ref().ok_or_else(||ApiError::conflict("inspection observation disappeared"))?;
    if actual.mesh_revision!=mesh_revision || actual.state_version!=observation_state_version
        || crate::router_v2::handlers::sessions::status::domain_generation_revision(actual)!=topology_revision {
        return Err(ApiError::conflict_with_code("inspection_observation_changed","live observation changed during immutable artifact read"));
    }
    Ok(Some(fields))
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
    let mut value: Value = serde_json::from_slice(bytes)
        .map_err(|error| invalid(format!("invalid inspection JSON: {error}")))?;
    if value["schema_version"] == "antenna_closed_loop_stage_output.v2" {
        if let Some(outputs) = value["outputs"].as_array_mut() {
            for output in outputs {
                if output.get("inspection_ref").is_some() { return Err(invalid("mixed inspection reference families")); }
            }
        }
        let stage_id = value["stage_id"].clone();
        let output_id = value["output_id"].clone();
        if let Some(outputs) = value["outputs"].as_array_mut() {
            for output in outputs {
                output["inspection_ref"] = serde_json::json!({"stage_id": stage_id, "output_id": output_id, "content_digest": output["content_digest"]});
            }
        }
    }
    let record: AntennaInspectionStageRecordResource = serde_json::from_value(value)
        .map_err(|error| invalid(format!("invalid inspection record shape: {error}")))?;
    let manifest_basename = match record.schema_version.as_str() {
        "antenna_external_lead_stage_output.v1" => "manifest.v1.json",
        "antenna_external_lead_stage_output.v2" | "antenna_closed_loop_stage_output.v2" => "manifest.v2.json",
        _ => return Err(invalid("unsupported inspection record schema")),
    };
    let closed = record.schema_version == "antenna_closed_loop_stage_output.v2";
    if record.stage_kind != "antenna_field_solve"
        || record.resolved_action != if closed { "closed_loop_inspection" } else { "external_lead_inspection" }
        || record.qualification != "NOT VERIFIED"
        || record.field_scope != if closed { "full_closed_loop.inspection_only.v2" } else { "external_electrode_truncation" }
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
            let expected_manifest = if closed {
                format!("antenna/field_solutions/{}/manifest.v2.json", reference.output_id)
            } else { format!("antenna/external_lead_solutions/{}/{digest}/{manifest_basename}", reference.output_id) };
            let mut expected_units = serde_json::json!({"V": "V", "RT0_coefficients": "A", "H": "A/m", "positions": "m"});
            if record.schema_version == "antenna_external_lead_stage_output.v2" {
                expected_units["J_charge"] = "A/m^2".into();
            }
            if closed { expected_units = serde_json::json!({"V_electric":"V", "J_charge":"A/m^2", "H_ant":"A/m", "H_ant_per_a":"1/m", "positions":"m"}); }
            if (closed && (output.content_digest.as_deref() != Some(reference.content_digest.as_str()) || output.source.is_none() || record.source_object_id.is_none()))
                || (!closed && (output.content_digest.is_some() || output.source.is_some() || record.source_object_id.is_some()))
                || output.kind != if closed { "antenna_closed_loop_inspection" } else { "antenna_external_lead_inspection" }
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
            if matches!(record.schema_version.as_str(), "antenna_external_lead_stage_output.v1" | "antenna_closed_loop_stage_output.v2")
                && record.outputs.is_empty()
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
            .is_some_and(|name| name == RECORD_NAME || name == CLOSED_RECORD_NAME)
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
    let closed = relative.file_name().is_some_and(|name| name == CLOSED_RECORD_NAME);
    let expected = PathBuf::from("antenna")
        .join(if closed { "closed_loop_stage_outputs" } else { "external_lead_stage_outputs" })
        .join(&owner.runtime_stage_id)
        .join(if closed { CLOSED_RECORD_NAME } else { RECORD_NAME });
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
        if path.file_name().is_some_and(|name| name == RECORD_NAME || name == CLOSED_RECORD_NAME) {
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
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
    if (value["schema_version"] == "antenna_closed_loop_stage_output.v2") != closed {
        return Err(invalid("inspection record generation differs from registered namespace"));
    }
    Ok(bytes)
}

fn load_closed(record: &AntennaInspectionStageRecordResource, root: &FsPath)
    -> Result<fullmag_runner::LoadedAntennaClosedLoopInspection, ApiError> {
    let output = record.outputs.first().ok_or_else(|| ApiError::conflict_with_code("inspection_has_no_payload", "failed/cancelled inspection has no payload"))?;
    let loaded = fullmag_runner::load_published_antenna_closed_loop_inspection(root,
        &output.manifest_ref, &record.stage_id, &record.output_id, &record.port_mode_id,
        &output.inspection_ref.content_digest).map_err(|e| invalid(e.message))?;
    if record.source_object_id.as_deref() != loaded.metadata["source_object_id"].as_str()
        || output.source.as_ref() != loaded.metadata.get("source") { return Err(invalid("closed-loop record source differs from verified native owner")); }
    Ok(loaded)
}

fn json_value<T: Serialize>(value: &T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::internal(e.to_string()))
}

pub(super) fn manifest_resource(
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
        current_display: manifest.current_display.map(Into::into),
    })
}

fn validate_port(
    record: &AntennaInspectionStageRecordResource,
    manifest: &AntennaExternalLeadSolutionManifest,
) -> Result<(), ApiError> {
    let generation_matches = inspection_generation_matches(
        &record.schema_version, &manifest.schema_version, manifest.current_display.is_some());
    if !generation_matches || manifest.port_mode_id != record.port_mode_id
        || manifest.stage_id != record.stage_id || manifest.output_id != record.output_id
    {
        return Err(invalid("inspection stage/manifest generation or identity mismatch"));
    }
    Ok(())
}

fn inspection_generation_matches(record_schema: &str, manifest_schema: &str, has_current: bool) -> bool {
    matches!(
        (record_schema, manifest_schema, has_current),
        ("antenna_external_lead_stage_output.v1", "antenna_external_lead_solution.v1", false)
            | ("antenna_external_lead_stage_output.v2", "antenna_external_lead_solution.v2", true)
    )
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
        (status = 200, description = "Inspection record; external-lead manifest metadata or fully verified closed-loop thin metadata; never a drive basis", body = AntennaExternalLeadInspectionResource),
        (status = 304, description = "Unchanged inspection resource after family validation"),
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
        let closed = record.schema_version == "antenna_closed_loop_stage_output.v2";
        let closed_loop_manifest = if closed && !record.outputs.is_empty() { Some(load_closed(&record, &snapshot.owner.artifact_dir)?.metadata) } else { None };
        let manifest = if !closed { if let Some(output) = record.outputs.first() {
            let manifest = fullmag_runner::load_published_antenna_external_lead_solution_manifest(
                &snapshot.owner.artifact_dir,
                &output.inspection_ref.runner_reference(),
            )
            .map_err(|e| invalid(e.message))?;
            validate_port(&record, &manifest)?;
            Some(manifest_resource(manifest)?)
        } else { None } } else { None };
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
            closed_loop_manifest,
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

fn device_display_payloads(
    loaded: &LoadedAntennaExternalLeadSolution,
) -> Result<[(AntennaExternalLeadPayloadRef, Vec<u8>); 2], ApiError> {
    let display = loaded.device_display().map_err(|e| invalid(e.message))?;
    let positions_count = display.positions_xyz_m.len() as u64 * 3;
    let topology_count = display.tet4_cells.len() as u64 * 4;
    let positions = display.positions_xyz_m.into_iter().flatten().flat_map(f64::to_le_bytes).collect::<Vec<_>>();
    let topology = display.tet4_cells.into_iter().flatten().flat_map(u32::to_le_bytes).collect::<Vec<_>>();
    Ok([
        ("device_positions", positions, "float64_le", "node_xyz_interleaved", "m", positions_count),
        ("device_topology", topology, "uint32_le", "tet4_connectivity", "1", topology_count),
    ].map(|(kind, bytes, scalar_type, layout, unit, value_count)| {
        (AntennaExternalLeadPayloadRef {
            path: format!("display/{kind}.bin"),
            sha256: digest(&bytes),
            byte_count: bytes.len() as u64,
            scalar_type: scalar_type.into(),
            layout: layout.into(),
            unit: unit.into(),
            value_count,
        }, bytes)
    }))
}

/// Keep native cell-local ordering and vectors; never average RT0 traces at shared nodes.
fn current_display_payloads(
    current: Option<&AntennaInspectionDeviceCurrentDisplay>,
    receipt: Option<&AntennaExternalLeadCurrentDisplayReceipt>,
) -> Result<Option<[(AntennaExternalLeadPayloadRef, Vec<u8>); 4]>, ApiError> {
    let (current, receipt) = match (current, receipt) {
        (None, None) => return Ok(None),
        (Some(current), Some(receipt)) => (current, receipt),
        _ => return Err(invalid("current display decoded payload/receipt mismatch")),
    };
    if current.cells.len() as u64 != receipt.cell_count {
        return Err(invalid("current display decoded cell count differs from receipt"));
    }
    let cell_values = receipt.cell_count.checked_mul(3)
        .ok_or_else(|| invalid("current display center count overflow"))?;
    let trace_values = cell_values.checked_mul(4)
        .ok_or_else(|| invalid("current display trace count overflow"))?;
    let center_positions = current.cells.iter().flat_map(|cell| cell.center_xyz_m)
        .flat_map(f64::to_le_bytes).collect::<Vec<_>>();
    let center_density = current.cells.iter().flat_map(|cell| cell.center_j_apm2)
        .flat_map(f64::to_le_bytes).collect::<Vec<_>>();
    let trace_positions = current.cells.iter().flat_map(|cell| cell.vertex_xyz_m)
        .flatten().flat_map(f64::to_le_bytes).collect::<Vec<_>>();
    let trace_density = current.cells.iter().flat_map(|cell| cell.vertex_j_apm2)
        .flatten().flat_map(f64::to_le_bytes).collect::<Vec<_>>();
    Ok(Some([
        ("current_center_positions", center_positions, "cell_xyz_interleaved", "m", cell_values),
        ("current_center_density", center_density, "cell_vector_xyz_interleaved", "A/m^2", cell_values),
        ("current_trace_positions", trace_positions, "cell_local_vertex_xyz_interleaved", "m", trace_values),
        ("current_trace_density", trace_density, "cell_local_vertex_vector_xyz_interleaved", "A/m^2", trace_values),
    ].map(|(kind, bytes, layout, unit, value_count)| {
        (AntennaExternalLeadPayloadRef {
            path: format!("display/{kind}.bin"), sha256: digest(&bytes),
            byte_count: bytes.len() as u64, scalar_type: "float64_le".into(),
            layout: layout.into(), unit: unit.into(), value_count,
        }, bytes)
    })))
}

fn current_display_resource(
    loaded: &LoadedAntennaExternalLeadSolution,
) -> Result<Option<AntennaInspectionCurrentDisplayResource>, ApiError> {
    let Some([center_positions, center_density, trace_positions, trace_density]) =
        current_display_payloads(loaded.device_current.as_ref(), loaded.manifest.current_display.as_ref())?
        else { return Ok(None); };
    let receipt = loaded.manifest.current_display.clone()
        .ok_or_else(|| invalid("current display receipt missing"))?;
    let ordered_snapshot = receipt.payload.clone().into();
    Ok(Some(AntennaInspectionCurrentDisplayResource {
        receipt: receipt.into(),
        center_positions: center_positions.0.into(),
        center_current_density: center_density.0.into(),
        trace_positions: trace_positions.0.into(),
        trace_current_density: trace_density.0.into(),
        ordered_snapshot,
    }))
}

pub(super) fn inspection_display_data(
    loaded: &LoadedAntennaExternalLeadSolution,
) -> Result<AntennaInspectionDisplayDataResource, ApiError> {
    let [(positions, _), (topology, _)] = device_display_payloads(loaded)?;
    let device_current = current_display_resource(loaded)?;
    if device_current.as_ref().is_some_and(|current| current.receipt.cell_count != topology.value_count / 4) {
        return Err(invalid("current display carrier differs from device topology"));
    }
    let has_current = device_current.is_some();
    let manifest = manifest_resource(loaded.manifest.clone())?;
    Ok(AntennaInspectionDisplayDataResource {
        content_digest: manifest.content_digest,
        source_object_id: manifest.source_object_id,
        status: "inspection_only".into(),
        qualification: "NOT VERIFIED".into(),
        field_scope: "external_electrode_truncation".into(),
        normalization: "raw_authored_current".into(),
        capabilities: AntennaInspectionDisplayCapabilities {
            display: true, per_ampere_basis: false, source_fft: false,
            llg_drive: false, current_density: has_current,
        },
        device_node_count: positions.value_count / 3,
        device_cell_count: topology.value_count / 4,
        sampling_carrier: manifest.sampling_carrier,
        device_positions: positions.into(),
        device_topology: topology.into(),
        device_potential: manifest.device_potential,
        sample_positions: manifest.sample_positions,
        magnetic_field: manifest.magnetic_field,
        device_current,
    })
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/antenna/stages/{stage_id}/external-lead-inspection/display",
    params(
        ("stage_id" = String, Path, description = "Exact runtime stage ID"),
        ("content_digest" = String, Query, description = "Required immutable inspection content digest"),
        ("x-fullmag-session-scope" = Option<String>, Header, description = "Canonical current-session scope"),
        ("If-None-Match" = Option<String>, Header, description = "Previous strong ETag")
    ),
    responses(
        (status = 200, description = "Fully verified immutable display descriptors; no FFT/LLG qualification", body = AntennaInspectionDisplayFamilyResource),
        (status = 304, description = "Unchanged after integrity validation"),
        (status = 400, description = "Invalid query", body = crate::schemas::common::ApiErrorResponse),
        (status = 404, description = "No registered inspection", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale owner, content digest or failed/cancelled result", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Invalid bundle or device ownership", body = crate::schemas::common::ApiErrorResponse),
        (status = 500, description = "Worker failure", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "data"
)]
pub async fn get_antenna_external_lead_inspection_display(
    State(state): State<Arc<AppState>>,
    Path(stage_id): Path<String>,
    query: Result<Query<AntennaInspectionPayloadQuery>, axum::extract::rejection::QueryRejection>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(|error| ApiError::bad_request(format!("invalid inspection display query: {error}")))?;
    let captured = snapshot(&state, &stage_id).await?;
    let owner = captured.owner.clone();
    let resource = tokio::task::spawn_blocking(move || {
        let record_bytes = read_registered_record(&captured.owner)?;
        let record = parse_record(&record_bytes)?;
        let output = record.outputs.first().ok_or_else(|| ApiError::conflict_with_code(
            "inspection_has_no_payload", "failed/cancelled inspection has no display payload"))?;
        if output.inspection_ref.content_digest != query.content_digest {
            return Err(ApiError::conflict_with_code("inspection_digest_mismatch", "inspection revision differs from requested digest"));
        }
        if record.schema_version == "antenna_closed_loop_stage_output.v2" {
            let loaded = load_closed(&record, &captured.owner.artifact_dir)?;
            return serde_json::to_value(AntennaInspectionDisplayFamilyResource::ClosedLoop(AntennaClosedLoopInspectionDisplayResource {
                schema_version: "antenna_inspection_display.closed_loop.v2".into(),
                resource_id: format!("data/antenna/stages/{}/external-lead-inspection/display", captured.owner.runtime_stage_id),
                session_id: captured.owner.session_id, session_epoch: captured.owner.session_epoch,
                request_scope_epoch: captured.owner.request_context.request_scope_epoch,
                run_id: captured.owner.run_id, runtime_stage_id: captured.owner.runtime_stage_id,
                stage_revision: captured.stage_revision, record_content_digest: format!("sha256:{}", digest(&record_bytes)),
                content_digest: output.inspection_ref.content_digest.clone(),
                capabilities: AntennaInspectionDisplayCapabilities { display: true, current_density: true,
                    per_ampere_basis: false, source_fft: false, llg_drive: false },
                normalization: "raw_authored_potential_jump".into(),
                closed_loop_display: loaded.metadata,
            })).map_err(|e| ApiError::internal(e.to_string()));
        }
        let loaded = fullmag_runner::load_published_antenna_external_lead_solution(
            &captured.owner.artifact_dir, &output.inspection_ref.runner_reference(),
        ).map_err(|e| invalid(e.message))?;
        validate_port(&record, &loaded.manifest)?;
        let display = inspection_display_data(&loaded)?;
        let has_current = display.device_current.is_some();
        serde_json::to_value(AntennaInspectionDisplayFamilyResource::ExternalLead(AntennaInspectionDisplayResource {
            schema_version: if has_current { "antenna_inspection_display.v2" } else { "antenna_inspection_display.v1" }.into(),
            resource_id: format!("data/antenna/stages/{}/external-lead-inspection/display", captured.owner.runtime_stage_id),
            session_id: captured.owner.session_id,
            session_epoch: captured.owner.session_epoch,
            request_scope_epoch: captured.owner.request_context.request_scope_epoch,
            run_id: captured.owner.run_id,
            runtime_stage_id: captured.owner.runtime_stage_id,
            stage_revision: captured.stage_revision,
            record_content_digest: format!("sha256:{}", digest(&record_bytes)),
            content_digest: display.content_digest,
            source_object_id: display.source_object_id,
            status: display.status,
            qualification: display.qualification,
            field_scope: display.field_scope,
            normalization: display.normalization,
            capabilities: display.capabilities,
            device_node_count: display.device_node_count,
            device_cell_count: display.device_cell_count,
            sampling_carrier: display.sampling_carrier,
            device_positions: display.device_positions,
            device_topology: display.device_topology,
            device_potential: display.device_potential,
            sample_positions: display.sample_positions,
            magnetic_field: display.magnetic_field,
            device_current: display.device_current,
        })).map_err(|e| ApiError::internal(e.to_string()))
    }).await.map_err(|e| ApiError::internal(format!("inspection display worker: {e}")))??;
    check_owner(&state, &owner).await?;
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&digest(
        &serde_json::to_vec(&resource).map_err(|e| ApiError::internal(e.to_string()))?,
    ));
    Ok(crate::router_v2::handlers::shared::conditional_json_response(&headers, &etag, &resource))
}

pub(super) fn validate_payload_kind(kind: &str) -> Result<(), ApiError> {
    if ![
        "bundle", "sample_positions", "magnetic_field", "device_vertex_ids",
        "device_potential", "device_positions", "device_topology",
        "current_center_positions", "current_center_density", "current_trace_positions",
        "current_trace_density", "current_snapshot",
    ].contains(&kind) {
        return Err(ApiError::bad_request("unknown inspection payload kind"));
    }
    Ok(())
}

pub(super) fn validate_family_payload_kind(kind: &str) -> Result<(), ApiError> {
    if ![
        "stable_vertex_ids", "vertex_xyz", "sample_xyz", "conductivity",
        "v_raw", "v_per_a", "j_center_raw", "j_center_per_a", "j_local_raw", "j_local_per_a",
        "h_raw", "h_per_a", "cells", "faces", "weak", "prepared_preimage", "charge_preimage",
        "source_preimage", "certificate", "authoring_receipt", "direct_evidence", "sample_cells",
    ].contains(&kind) {
        validate_payload_kind(kind)?;
    }
    Ok(())
}

pub(super) fn select_closed_payload(
    mut loaded: fullmag_runner::LoadedAntennaClosedLoopInspection,
    kind: &str,
) -> Result<(String, Vec<u8>), ApiError> {
    let bytes = loaded.payloads.remove(kind)
        .ok_or_else(|| ApiError::bad_request("unknown closed-loop inspection payload kind"))?;
    Ok((digest(&bytes), bytes))
}

pub(super) fn select_payload(
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
        "device_positions" | "device_topology" => {
            let [positions, topology] = device_display_payloads(&loaded)?;
            if kind == "device_positions" { positions } else { topology }
        },
        "current_snapshot" => {
            let receipt = loaded.manifest.current_display.ok_or_else(|| ApiError::conflict_with_code(
                "inspection_current_unavailable", "legacy inspection has no owned current snapshot"))?;
            let current = loaded.device_current.ok_or_else(|| invalid("owned current snapshot missing after load"))?;
            (receipt.payload, current.canonical_payload)
        },
        "current_center_positions" | "current_center_density" | "current_trace_positions"
            | "current_trace_density" => {
            let payloads = current_display_payloads(loaded.device_current.as_ref(), loaded.manifest.current_display.as_ref())?.ok_or_else(|| ApiError::conflict_with_code(
                "inspection_current_unavailable", "legacy inspection has no owned current snapshot"))?;
            let index = match kind {
                "current_center_positions" => 0, "current_center_density" => 1,
                "current_trace_positions" => 2, _ => 3,
            };
            payloads.into_iter().nth(index).ok_or_else(|| invalid("current display payload selection failed"))?
        },
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
        ("payload_kind" = String, Path, description = "bundle, sample_positions, magnetic_field, device_vertex_ids, device_potential, device_positions, device_topology; v2 additionally current_center_positions, current_center_density, current_trace_positions, current_trace_density, current_snapshot"),
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
    validate_family_payload_kind(&payload_kind)?;
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
        let (payload_sha256, bytes) = if record.schema_version == "antenna_closed_loop_stage_output.v2" {
            select_closed_payload(load_closed(&record, &snapshot.owner.artifact_dir)?, &payload_kind)?
        } else {
            let loaded = fullmag_runner::load_published_antenna_external_lead_solution(
                &snapshot.owner.artifact_dir, &output.inspection_ref.runner_reference(),
            ).map_err(|e| invalid(e.message))?;
            validate_port(&record, &loaded.manifest)?;
            let (descriptor, bytes) = select_payload(loaded, &payload_kind)?;
            (descriptor.sha256, bytes)
        };
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
            &payload_sha256,
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

    #[test]
    fn inspection_record_and_manifest_generation_cannot_be_mixed() {
        for (record_schema, manifest_schema, has_current, accepted) in [
            ("antenna_external_lead_stage_output.v1", "antenna_external_lead_solution.v1", false, true),
            ("antenna_external_lead_stage_output.v2", "antenna_external_lead_solution.v2", true, true),
            ("antenna_external_lead_stage_output.v1", "antenna_external_lead_solution.v1", true, false),
            ("antenna_external_lead_stage_output.v2", "antenna_external_lead_solution.v2", false, false),
            ("antenna_external_lead_stage_output.v1", "antenna_external_lead_solution.v2", true, false),
            ("antenna_external_lead_stage_output.v2", "antenna_external_lead_solution.v1", false, false),
        ] {
            assert_eq!(inspection_generation_matches(record_schema, manifest_schema, has_current), accepted);
        }
    }

    fn current_fixture() -> (AntennaInspectionDeviceCurrentDisplay, AntennaExternalLeadCurrentDisplayReceipt) {
        let current = AntennaInspectionDeviceCurrentDisplay {
            // Adapter serialization fixture, not a native solve or scientific qualification.
            canonical_payload: vec![1, 2, 3],
            cells: vec![
                fullmag_runner::AntennaInspectionCurrentDisplayCell {
                    source_element_index: 7, vertex_ids: [1, 2, 3, 4],
                    vertex_xyz_m: [[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
                    vertex_j_apm2: [[1., 2., 3.], [4., 5., 6.], [7., 8., 9.], [10., 11., 12.]],
                    center_xyz_m: [0.25, 0.25, 0.25], center_j_apm2: [13., 14., 15.],
                },
                fullmag_runner::AntennaInspectionCurrentDisplayCell {
                    source_element_index: 12, vertex_ids: [1, 5, 6, 7],
                    vertex_xyz_m: [[0., 0., 0.], [-1., 0., 0.], [0., -1., 0.], [0., 0., -1.]],
                    vertex_j_apm2: [[-1., -2., -3.], [-4., -5., -6.], [-7., -8., -9.], [-10., -11., -12.]],
                    center_xyz_m: [-0.25, -0.25, -0.25], center_j_apm2: [-13., -14., -15.],
                },
            ],
        };
        let receipt = AntennaExternalLeadCurrentDisplayReceipt {
            schema_version: "accepted_external_lead_current_display.ordered.v1".into(),
            operator_version: "fem_accepted_external_lead_current_display.v1".into(),
            current_evaluator_version: "fem_generic_affine_rt0.v1".into(),
            sampling_policy: "cell_center_and_cell_local_vertices.v1".into(),
            center_policy: "vertex_quarter_sum.long_double.v1".into(),
            normalization: "raw_authored_current".into(), coordinate_unit: "m".into(),
            current_density_unit: "A/m^2".into(), cell_count: 2,
            payload: AntennaExternalLeadPayloadRef {
                path: "current_display.v1.bin".into(), sha256: digest(&current.canonical_payload),
                byte_count: 3, scalar_type: "ordered_binary_v1".into(),
                layout: "accepted_external_lead_current_display.ordered.v1".into(),
                unit: "A/m^2".into(), value_count: 3,
            },
        };
        (current, receipt)
    }

    #[test]
    fn current_display_uses_owned_native_centers_and_distinct_cell_local_traces() {
        let (current, receipt) = current_fixture();
        let payloads = current_display_payloads(Some(&current), Some(&receipt)).unwrap().unwrap();
        let decode = |bytes: &[u8]| bytes.chunks_exact(8)
            .map(|bytes| f64::from_le_bytes(bytes.try_into().unwrap())).collect::<Vec<_>>();
        assert_eq!(decode(&payloads[0].1), vec![0.25, 0.25, 0.25, -0.25, -0.25, -0.25]);
        assert_eq!(decode(&payloads[1].1), vec![13., 14., 15., -13., -14., -15.]);
        // Shared vertex ID 1 has two distinct tangential traces, not a nodal average.
        assert_eq!(decode(&payloads[3].1), (1..=12).map(f64::from)
            .chain((1..=12).map(|value| -f64::from(value))).collect::<Vec<_>>());
        for (index, (descriptor, bytes)) in payloads.iter().enumerate() {
            assert_eq!(descriptor.byte_count, bytes.len() as u64);
            assert_eq!(descriptor.sha256, digest(bytes));
            assert_eq!(descriptor.value_count, if index < 2 { 6 } else { 24 });
            assert_eq!(descriptor.byte_count, descriptor.value_count * 8);
            assert_eq!(descriptor.scalar_type, "float64_le");
            assert_eq!(descriptor.unit, if index % 2 == 0 { "m" } else { "A/m^2" });
        }
        assert_eq!(payloads[3].0.layout, "cell_local_vertex_vector_xyz_interleaved");
    }

    #[test]
    fn legacy_display_has_no_current_and_partial_current_state_is_rejected() {
        assert!(current_display_payloads(None, None).unwrap().is_none());
        let (current, mut receipt) = current_fixture();
        assert!(current_display_payloads(Some(&current), None).is_err());
        assert!(current_display_payloads(None, Some(&receipt)).is_err());
        receipt.cell_count = 1;
        assert!(current_display_payloads(Some(&current), Some(&receipt)).is_err());
    }

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
    #[test]
    fn inspection_discovery_distinguishes_registry_retention_absence_and_invalid_metadata() {
        use crate::schemas::runtime::AntennaInspectionDiscoveryState as State;
        assert_eq!(inspection_discovery_state(true, None).state, State::Retained);
        assert_eq!(inspection_discovery_state(false, Some(&Ok(true))).state, State::Retained);
        assert_eq!(inspection_discovery_state(false, None).state, State::Absent);
        assert_eq!(inspection_discovery_state(false, Some(&Ok(false))).state, State::Absent);
        let invalid_record = parse_record(b"{").map(|record| record.status == "inspection_only");
        let unknown = inspection_discovery_state(false, Some(&invalid_record));
        assert_eq!(unknown.state, State::Unknown);
        assert_eq!(unknown.reason_code, "inspection_record_invalid");
        // Registration is discovery; no payload qualification is claimed.
        assert_eq!(serde_json::to_value(inspection_discovery_state(true, None)).unwrap(),
            serde_json::json!({"state": "retained", "reason_code": "retained_inspection_metadata"}));
    }

    #[test]
    fn accepted_and_legacy_owners_for_one_stage_are_ambiguous() {
        use crate::schemas::runtime::AntennaInspectionDiscoveryState as State;
        for legacy in [Ok(true), Ok(false), Err(invalid("foreign registered metadata"))] {
            let result = inspection_discovery_state(true, Some(&legacy));
            assert_eq!(result.state, State::Unknown);
            assert_eq!(result.reason_code, "ambiguous_inspection_owner");
        }
    }

    #[tokio::test]
    async fn failed_antenna_without_a_registered_record_is_absent_without_data_materialization() {
        use crate::schemas::runtime::AntennaInspectionDiscoveryState as State;
        let state = crate::router_v2::tests::test_app_state_with_live_session().await;
        {
            let mut current = state.current_live_state.write().await;
            current.as_mut().unwrap().stage_execution = Some(serde_json::from_value(serde_json::json!({
                "total_stages": 1, "runtime_state": "failed",
                "stages": [{"stage_id": "stage-000", "antenna_solve_stage_id": "antenna-solve",
                    "kind": "study_pipeline_antenna_field_solve", "status": "failed", "artifact_refs": []}]
            })).unwrap());
        }
        let discovered = inspection_discovery_metadata(&state, &["stage-000".into()], false).await.unwrap();
        assert_eq!(discovered["stage-000"].state, State::Absent);
        let current = state.current_live_state.read().await;
        assert_eq!(current.as_ref().unwrap().stage_execution.as_ref().unwrap().stages[0].status,
            crate::types::StageLifecycleState::Failed);
    }

}
