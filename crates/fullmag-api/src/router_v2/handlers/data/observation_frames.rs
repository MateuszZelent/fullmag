use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue};
use axum::response::Response;
use axum::Json;
use fullmag_quantities::{QuantityId, QuantityValue};
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::field_store::{
    serialize_field_vector_binary_v4, FieldVectorBinaryMetadataV4, FieldVectorIndexing,
};
use crate::schemas::observations::{
    ObservationFrameListQuery, ObservationFrameListResource, ObservationFrameResource,
    ObservationFrameStatus,
};
use crate::types::{AppState, CurrentLiveRequestContext};

const OBSERVATION_FRAME_SCHEMA: &str = "observation_frame.v1";
const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 200;

struct LoadedObservationFrame {
    resource: ObservationFrameResource,
    accepted_state_ref: fullmag_quantities::AcceptedStateRef,
}

fn observation_frame_id(
    reference: &fullmag_quantities::AcceptedStateRef,
) -> Result<String, ApiError> {
    let canonical = serde_json::to_vec(reference).map_err(|error| {
        ApiError::internal(format!("serialize accepted observation identity: {error}"))
    })?;
    Ok(format!("frame-{:x}", Sha256::digest(canonical)))
}

fn active_run_id(
    context: &CurrentLiveRequestContext,
    requested_run_id: Option<&str>,
) -> Result<String, ApiError> {
    let run_id = context
        .run_id
        .as_deref()
        .ok_or_else(|| ApiError::not_found("current session has no durable run identity"))?;
    if requested_run_id.is_some_and(|requested| requested != run_id) {
        return Err(ApiError::conflict_with_code(
            "observation_source_conflict",
            "requested observation run differs from the active session run",
        ));
    }
    Ok(run_id.to_owned())
}

fn managed_store_root(state: &AppState) -> Result<PathBuf, ApiError> {
    state
        .submit_store_root
        .clone()
        .ok_or_else(|| ApiError::internal("managed project run storage is not configured"))
}

fn load_observation_frames(
    store_root: PathBuf,
    run_id: String,
) -> Result<Vec<LoadedObservationFrame>, ApiError> {
    let store = fullmag_session::SessionStore::open_existing(&store_root)
        .map_err(|error| ApiError::internal(error.to_string()))?;
    let run_catalog = store
        .read_run_catalog(&run_id)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("durable observation run was not found"))?;
    let artifact_catalog = store
        .read_artifact_catalog(&run_id)
        .map_err(|error| ApiError::internal(error.to_string()))?
        .ok_or_else(|| ApiError::not_found("durable observation artifact catalog was not found"))?;
    artifact_catalog
        .validate()
        .map_err(|error| ApiError::internal(error.to_string()))?;

    let mut frames = Vec::new();
    for task in &run_catalog.tasks {
        if task.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded {
            continue;
        }
        let (Some(attempt_id), Some(ownership_epoch)) =
            (task.attempt_id.as_deref(), task.ownership_epoch)
        else {
            return Err(ApiError::internal(
                "succeeded observation task has no complete attempt identity",
            ));
        };
        let mut manifests = artifact_catalog.entries.iter().filter(|entry| {
            entry.artifact_type == "study_output_manifest"
                && entry.task_id == task.task_id
                && entry.attempt_id == attempt_id
                && entry.ownership_epoch == ownership_epoch
                && entry.status == fullmag_session::FmsArtifactStatus::Published
                && task.artifact_ids.contains(&entry.artifact_id)
        });
        let Some(manifest_entry) = manifests.next() else {
            continue;
        };
        if manifests.next().is_some() {
            return Err(ApiError::internal(
                "observation task has multiple published manifests for its current attempt",
            ));
        }
        let manifest_ref = manifest_entry
            .object_ref
            .as_deref()
            .ok_or_else(|| ApiError::internal("observation manifest has no CAS reference"))?;
        if manifest_ref != manifest_entry.content_sha256 {
            return Err(ApiError::internal(
                "observation manifest digest differs from its CAS reference",
            ));
        }
        let manifest_bytes = store
            .cas()
            .get(manifest_ref)
            .map_err(|error| ApiError::internal(error.to_string()))?
            .ok_or_else(|| ApiError::internal("observation manifest CAS object is missing"))?;
        let manifest: fullmag_session::FmsStudyOutputManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|error| {
                ApiError::internal(format!("invalid observation manifest: {error}"))
            })?;
        manifest
            .validate()
            .map_err(|error| ApiError::internal(error.to_string()))?;
        if manifest.run_id != run_id
            || manifest.task_id != task.task_id
            || manifest.attempt_id != attempt_id
            || manifest.ownership_epoch != ownership_epoch
        {
            return Err(ApiError::internal(
                "observation manifest identity differs from its task",
            ));
        }
        let Some(descriptor) = manifest.observation_source else {
            continue;
        };
        if manifest.accepted_state_ref.as_ref() != Some(&descriptor.accepted_state_ref) {
            return Err(ApiError::internal(
                "observation descriptor differs from the manifest accepted state",
            ));
        }
        for (artifact_id, artifact_type, object_ref) in [
            (
                descriptor.snapshot_artifact_id.as_str(),
                fullmag_session::FMS_OBSERVATION_SNAPSHOT_ARTIFACT_TYPE,
                descriptor.snapshot_object_ref.as_str(),
            ),
            (
                descriptor.state_artifact_id.as_str(),
                fullmag_session::FMS_OBSERVATION_STATE_ARTIFACT_TYPE,
                descriptor.state_object_ref.as_str(),
            ),
        ] {
            let matches = artifact_catalog
                .entries
                .iter()
                .filter(|entry| {
                    entry.artifact_id == artifact_id
                        && entry.task_id == task.task_id
                        && entry.attempt_id == attempt_id
                        && entry.ownership_epoch == ownership_epoch
                        && entry.artifact_type == artifact_type
                        && entry.object_ref.as_deref() == Some(object_ref)
                        && entry.content_sha256 == object_ref
                        && entry.status == fullmag_session::FmsArtifactStatus::Published
                        && entry.study_output.is_none()
                        && task.artifact_ids.contains(&entry.artifact_id)
                })
                .count();
            if matches != 1 || !store.cas().contains(object_ref) {
                return Err(ApiError::internal(
                    "observation carrier is missing or ambiguous",
                ));
            }
        }

        let frame_id = observation_frame_id(&descriptor.accepted_state_ref)?;
        let stage_id = manifest.step_id.clone();
        let resource = ObservationFrameResource {
            schema_version: OBSERVATION_FRAME_SCHEMA.to_owned(),
            frame_id: frame_id.clone(),
            status: ObservationFrameStatus::Complete,
            run_id: run_id.clone(),
            task_id: task.task_id.clone(),
            stage_id,
            attempt_id: attempt_id.to_owned(),
            ownership_epoch,
            accepted_state_ref: (&descriptor.accepted_state_ref).into(),
            adapter_id: descriptor.adapter_id.clone(),
            grid_cells: descriptor.grid_cells,
            quantity_ids: descriptor.quantity_ids.clone(),
            state_codec_id: descriptor.state_codec_id.clone(),
            state_codec_version: descriptor.state_codec_version.clone(),
            magnetization_href: format!(
                "/v2/sessions/current/data/observation-frames/{frame_id}/magnetization"
            ),
        };
        frames.push(LoadedObservationFrame {
            resource,
            accepted_state_ref: descriptor.accepted_state_ref,
        });
    }
    frames.sort_by(|left, right| {
        left.resource
            .accepted_state_ref
            .id
            .accepted_step
            .cmp(&right.resource.accepted_state_ref.id.accepted_step)
            .then_with(|| left.resource.stage_id.cmp(&right.resource.stage_id))
            .then_with(|| left.resource.frame_id.cmp(&right.resource.frame_id))
    });
    Ok(frames)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/observation-frames",
    params(ObservationFrameListQuery),
    responses(
        (status = 200, description = "Immutable observation frames for the active durable run", body = ObservationFrameListResource),
        (status = 400, description = "Invalid cursor or page size"),
        (status = 404, description = "No active durable run or run storage"),
        (status = 409, description = "Requested run differs from the active session")
    ),
    tag = "data"
)]
pub async fn list_observation_frames(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ObservationFrameListQuery>,
) -> Result<Json<ObservationFrameListResource>, ApiError> {
    let context = crate::capture_current_live_request_context(&state).await?;
    let run_id = active_run_id(&context, query.run_id.as_deref())?;
    let store_root = managed_store_root(&state)?;
    let mut frames = tokio::task::spawn_blocking({
        let run_id = run_id.clone();
        move || load_observation_frames(store_root, run_id)
    })
    .await
    .map_err(|error| ApiError::internal(format!("observation frame reader failed: {error}")))??;
    crate::validate_current_live_request_context(&state, &context).await?;

    if let Some(stage_id) = query.stage_id.as_deref() {
        frames.retain(|frame| frame.resource.stage_id == stage_id);
    }
    if let Some(cursor) = query.cursor.as_deref() {
        let position = frames
            .iter()
            .position(|frame| frame.resource.frame_id == cursor)
            .ok_or_else(|| {
                ApiError::bad_request("observation frame cursor is not in this result set")
            })?;
        frames.drain(..=position);
    }
    let limit = query.limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if limit == 0 || limit > MAX_PAGE_SIZE {
        return Err(ApiError::bad_request(
            "observation frame limit must be between 1 and 200",
        ));
    }
    let has_more = frames.len() > limit as usize;
    frames.truncate(limit as usize);
    let next_cursor = has_more
        .then(|| frames.last().map(|frame| frame.resource.frame_id.clone()))
        .flatten();
    Ok(Json(ObservationFrameListResource {
        run_id,
        frames: frames.into_iter().map(|frame| frame.resource).collect(),
        next_cursor,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/observation-frames/{frame_id}",
    params(("frame_id" = String, Path, description = "Immutable observation frame identity")),
    responses(
        (status = 200, description = "Immutable observation frame descriptor", body = ObservationFrameResource),
        (status = 404, description = "Observation frame was not found")
    ),
    tag = "data"
)]
pub async fn get_observation_frame(
    Path(frame_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<ObservationFrameResource>, ApiError> {
    let context = crate::capture_current_live_request_context(&state).await?;
    let run_id = active_run_id(&context, None)?;
    let store_root = managed_store_root(&state)?;
    let frame = tokio::task::spawn_blocking(move || {
        load_observation_frames(store_root, run_id)?
            .into_iter()
            .find(|frame| frame.resource.frame_id == frame_id)
            .ok_or_else(|| ApiError::not_found("observation frame was not found"))
    })
    .await
    .map_err(|error| ApiError::internal(format!("observation frame reader failed: {error}")))??;
    crate::validate_current_live_request_context(&state, &context).await?;
    Ok(Json(frame.resource))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/data/observation-frames/{frame_id}/magnetization",
    params(("frame_id" = String, Path, description = "Immutable observation frame identity")),
    responses(
        (status = 200, description = "Source-qualified FMVP v4 magnetization", content_type = "application/octet-stream"),
        (status = 304, description = "Magnetization payload is unchanged"),
        (status = 404, description = "Observation frame was not found"),
        (status = 422, description = "Observation source cannot materialize magnetization")
    ),
    tag = "data"
)]
pub async fn get_observation_frame_magnetization(
    Path(frame_id): Path<String>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let context = crate::capture_current_live_request_context(&state).await?;
    let run_id = active_run_id(&context, None)?;
    let store_root = managed_store_root(&state)?;
    let (resource, values, accepted_state_ref, topology_hash) =
        tokio::task::spawn_blocking(move || {
            let frames = load_observation_frames(store_root.clone(), run_id)?;
            let frame = frames
                .into_iter()
                .find(|frame| frame.resource.frame_id == frame_id)
                .ok_or_else(|| ApiError::not_found("observation frame was not found"))?;
            let store = fullmag_session::SessionStore::open_existing(store_root)
                .map_err(|error| ApiError::internal(error.to_string()))?;
            let mut loaded = fullmag_runtime_control::load_study_observation_runtime(
                &store,
                &frame.accepted_state_ref,
            )
            .map_err(|error| {
                ApiError::unprocessable(format!("unsupported_missing_primary_state: {error}"))
            })?;
            let batch = loaded
                .runtime
                .compute_quantities(&frame.accepted_state_ref.id, &[QuantityId::M])
                .map_err(|error| {
                    ApiError::unprocessable(format!("unsupported_missing_primary_state: {error}"))
                })?;
            let values = match batch.values.into_iter().next() {
                Some((QuantityId::M, QuantityValue::VectorField(values))) => values,
                _ => {
                    return Err(ApiError::internal(
                        "historical m materializer returned an invalid value",
                    ));
                }
            };
            let mut topology_seed = Vec::new();
            topology_seed.extend_from_slice(frame.accepted_state_ref.id.domain_digest.as_bytes());
            for extent in frame.resource.grid_cells {
                topology_seed.extend_from_slice(&extent.to_le_bytes());
            }
            let topology_hash: [u8; 32] = Sha256::digest(topology_seed).into();
            Ok::<_, ApiError>((
                frame.resource,
                values,
                frame.accepted_state_ref,
                topology_hash,
            ))
        })
        .await
        .map_err(|error| {
            ApiError::internal(format!("observation materializer failed: {error}"))
        })??;
    crate::validate_current_live_request_context(&state, &context).await?;

    let field_generation_id = format!(
        "field:{}:m:{}",
        resource.frame_id, accepted_state_ref.generation.accepted_revision
    );
    let metadata = FieldVectorBinaryMetadataV4 {
        domain_generation_id: &accepted_state_ref.id.domain_digest,
        mesh_topology_revision: accepted_state_ref.generation.accepted_revision,
        mesh_topology_hash: topology_hash,
        scope_kind: "full",
        scope_id: "",
        indexing: FieldVectorIndexing::FullDomain,
        node_indices: &[],
        source_kind: "observation_frame",
        source_id: &resource.frame_id,
        source_revision: accepted_state_ref.generation.accepted_revision,
        field_generation_id: &field_generation_id,
    };
    let binary = serialize_field_vector_binary_v4("m", 3, resource.grid_cells, &values, &metadata)
        .map_err(ApiError::internal)?;
    let topology_hash_header = topology_hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let point_count = values.len() / 3;
    let etag = crate::router_v2::handlers::shared::stable_strong_etag(&format!(
        "{}:{}:m:fmvp4",
        resource.frame_id, accepted_state_ref.id.state_digest
    ));
    let mut response =
        crate::router_v2::handlers::shared::conditional_binary_response(&headers, &etag, binary);
    for (name, value) in [
        ("x-fullmag-encoding", "FMVP;version=4".to_owned()),
        ("x-fullmag-quantity-id", "m".to_owned()),
        (
            "x-fullmag-domain-generation-id",
            accepted_state_ref.id.domain_digest.clone(),
        ),
        ("x-fullmag-mesh-topology-hash", topology_hash_header),
        ("x-fullmag-field-indexing", "full_domain".to_owned()),
        ("x-fullmag-scope-kind", "full".to_owned()),
        ("x-fullmag-n-comp", "3".to_owned()),
        ("x-fullmag-point-count", point_count.to_string()),
        ("x-fullmag-value-count", values.len().to_string()),
        ("x-fullmag-node-index-count", "0".to_owned()),
        ("x-fullmag-source-kind", "observation_frame".to_owned()),
        ("x-fullmag-source-id", resource.frame_id),
        (
            "x-fullmag-source-revision",
            accepted_state_ref.generation.accepted_revision.to_string(),
        ),
        ("x-fullmag-field-generation-id", field_generation_id),
    ] {
        if let Ok(value) = HeaderValue::from_str(&value) {
            response
                .headers_mut()
                .insert(HeaderName::from_static(name), value);
        }
    }
    Ok(response)
}
