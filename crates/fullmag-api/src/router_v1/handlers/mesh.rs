//! Mesh resource endpoints.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::field_store::serialize_fem_mesh_topology_binary_v1;
use crate::schemas::commands::CommandResponse;
use crate::schemas::mesh::{
    MeshActiveBuildResource, MeshBuildCommandRequest, MeshBuildHistoryResource,
    MeshCapabilitiesResource, MeshInterfaceConfigReplaceRequest, MeshInterfaceConfigResource,
    MeshInterfaceQualityResource, MeshInterfaceReportResource,
    MeshLastSuccessfulBuildResource, MeshObjectConfigReplaceRequest, MeshObjectConfigResource,
    MeshObjectQualityResource, MeshObjectReportResource, MeshObjectSizeFieldResource,
    MeshObjectSegmentResource, MeshPartResource, MeshSharedDomainManifestResource,
    MeshSharedDomainConfigReplaceRequest, MeshSharedDomainConfigResource,
    MeshSharedDomainQualityResource, MeshSharedDomainReportResource,
    MeshSummaryResource, MeshUniverseConfigReplaceRequest, MeshUniverseConfigResource,
    MeshUniverseQualityResource, MeshUniverseReportResource,
};
use crate::types::{AppState, SessionCommand, SessionStateResponse};
use fullmag_authoring::{
    SceneDocument, SceneMeshInterface, SceneObject, ScriptBuilderMeshState,
    ScriptBuilderPerGeometryMeshState, ScriptBuilderUniverseState,
};
use fullmag_runner::{FemMeshObjectSegment, FemMeshPayload};

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/summary",
    responses(
        (status = 200, description = "Current mesh summary", body = MeshSummaryResource),
        (status = 304, description = "Mesh summary not modified for the supplied ETag"),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_summary(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let body = MeshSummaryResource {
        revision: snapshot.mesh_revision,
        mesh_summary: mesh_workspace.get("mesh_summary").cloned(),
        mesh_quality_summary: mesh_workspace.get("mesh_quality_summary").cloned(),
        effective_airbox_target: mesh_workspace.get("effective_airbox_target").cloned(),
        effective_per_object_targets: mesh_workspace.get("effective_per_object_targets").cloned(),
    };
    let etag = super::stable_strong_etag(&format!("mesh-summary:{}", snapshot.mesh_revision));
    Ok(super::conditional_json_response(&headers, &etag, &body))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/capabilities",
    responses(
        (status = 200, description = "Current mesh capability read-model", body = MeshCapabilitiesResource),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_capabilities(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshCapabilitiesResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    Ok(Json(MeshCapabilitiesResource {
        revision: snapshot.mesh_revision,
        mesh_capabilities: mesh_workspace.get("mesh_capabilities").cloned(),
        mesh_adaptivity_state: mesh_workspace.get("mesh_adaptivity_state").cloned(),
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/builds/active",
    responses(
        (status = 200, description = "Current active mesh build projection", body = MeshActiveBuildResource),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_active_build(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshActiveBuildResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    Ok(Json(MeshActiveBuildResource {
        revision: snapshot.mesh_build_revision,
        active_build: mesh_workspace.get("active_build").cloned(),
        mesh_pipeline_status: mesh_workspace.get("mesh_pipeline_status").cloned(),
        effective_airbox_target: mesh_workspace.get("effective_airbox_target").cloned(),
        effective_per_object_targets: mesh_workspace.get("effective_per_object_targets").cloned(),
        last_build_summary: mesh_workspace.get("last_build_summary").cloned(),
        last_build_error: mesh_workspace
            .get("last_build_error")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/builds/history",
    responses(
        (status = 200, description = "Mesh build history", body = MeshBuildHistoryResource),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_build_history(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshBuildHistoryResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let history = mesh_workspace
        .get("mesh_history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    Ok(Json(MeshBuildHistoryResource {
        revision: snapshot.mesh_build_revision,
        history,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/builds/last-success",
    responses(
        (status = 200, description = "Last successful mesh build projection", body = MeshLastSuccessfulBuildResource),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_last_successful_build(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshLastSuccessfulBuildResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    Ok(Json(MeshLastSuccessfulBuildResource {
        revision: snapshot.mesh_build_revision,
        last_success: mesh_workspace.get("last_build_summary").cloned(),
        effective_airbox_target: mesh_workspace.get("effective_airbox_target").cloned(),
        effective_per_object_targets: mesh_workspace.get("effective_per_object_targets").cloned(),
        last_build_error: mesh_workspace
            .get("last_build_error")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    }))
}

#[utoipa::path(
    post,
    path = "/v1/live/current/mesh/builds/commands",
    request_body = MeshBuildCommandRequest,
    responses(
        (status = 200, description = "Mesh build command accepted", body = CommandResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn submit_mesh_build_command(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<MeshBuildCommandRequest>,
) -> Result<Json<CommandResponse>, ApiError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let command = SessionCommand {
        seq: 0,
        command_id: format!("fm-{}", uuid::Uuid::new_v4()),
        kind: "remesh".to_string(),
        created_at_unix_ms: now,
        until_seconds: None,
        max_steps: None,
        torque_tolerance: None,
        energy_tolerance: None,
        integrator: None,
        fixed_timestep: None,
        max_error: None,
        relax_algorithm: None,
        relax_alpha: None,
        mesh_options: req.mesh_options,
        mesh_target: req.mesh_target,
        mesh_reason: req.mesh_reason,
        state_path: None,
        state_format: None,
        state_dataset: None,
        state_sample_index: None,
        display_selection: None,
        preview_config: None,
        stages: None,
    };
    let response =
        crate::router_v1::handlers::commands::enqueue_session_command_impl(state, &headers, command)
            .await?;
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/universe/config",
    responses(
        (status = 200, description = "Current universe mesh config", body = MeshUniverseConfigResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_universe_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshUniverseConfigResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let config = current_universe_mesh_config(scene)
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!("failed to serialize universe mesh config: {error}"))
        })?;
    Ok(Json(MeshUniverseConfigResource {
        revision: snapshot.mesh_revision,
        config,
    }))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/mesh/universe/config",
    request_body = MeshUniverseConfigReplaceRequest,
    responses(
        (status = 200, description = "Committed universe mesh config", body = MeshUniverseConfigResource),
        (status = 400, description = "Invalid universe mesh config payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn replace_mesh_universe_config(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MeshUniverseConfigReplaceRequest>,
) -> Result<Json<MeshUniverseConfigResource>, ApiError> {
    let config: ScriptBuilderUniverseState =
        serde_json::from_value(req.config).map_err(|error| {
            ApiError::bad_request(format!("invalid universe mesh config payload: {error}"))
        })?;
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    scene.study.universe_mesh = Some(config.clone());
    if scene.universe.is_none() {
        scene.universe = Some(config.clone());
    }
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let config = current_universe_mesh_config(&committed)
        .ok_or_else(|| ApiError::internal("committed universe mesh config missing"))?;
    let config = serde_json::to_value(config).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize committed universe mesh config: {error}"
        ))
    })?;
    let revision = current_snapshot(&state).await?.mesh_revision;
    Ok(Json(MeshUniverseConfigResource {
        revision,
        config: Some(config),
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/universe/report",
    responses(
        (status = 200, description = "Universe mesh report", body = MeshUniverseReportResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_universe_report(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshUniverseReportResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let report = Some(json!({
        "config": current_universe_mesh_config(scene),
        "effective_airbox_target": mesh_workspace.get("effective_airbox_target").cloned().unwrap_or(Value::Null),
        "mesh_summary": mesh_workspace.get("mesh_summary").cloned().unwrap_or(Value::Null),
        "last_build_summary": mesh_workspace.get("last_build_summary").cloned().unwrap_or(Value::Null),
    }));
    Ok(Json(MeshUniverseReportResource {
        revision: snapshot.mesh_revision,
        report,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/universe/quality",
    responses(
        (status = 200, description = "Universe mesh quality projection", body = MeshUniverseQualityResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_universe_quality(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshUniverseQualityResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let quality = Some(json!({
        "mesh_quality_summary": mesh_workspace.get("mesh_quality_summary").cloned().unwrap_or(Value::Null),
        "effective_airbox_target": mesh_workspace.get("effective_airbox_target").cloned().unwrap_or(Value::Null),
    }));
    Ok(Json(MeshUniverseQualityResource {
        revision: snapshot.mesh_revision,
        quality,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/shared-domain/config",
    responses(
        (status = 200, description = "Current shared-domain mesh config", body = MeshSharedDomainConfigResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_shared_domain_config(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshSharedDomainConfigResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let config = serde_json::to_value(&scene.study.shared_domain_mesh).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize shared-domain mesh config: {error}"
        ))
    })?;
    Ok(Json(MeshSharedDomainConfigResource {
        revision: snapshot.mesh_revision,
        config,
    }))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/mesh/shared-domain/config",
    request_body = MeshSharedDomainConfigReplaceRequest,
    responses(
        (status = 200, description = "Committed shared-domain mesh config", body = MeshSharedDomainConfigResource),
        (status = 400, description = "Invalid shared-domain mesh config payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn replace_mesh_shared_domain_config(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MeshSharedDomainConfigReplaceRequest>,
) -> Result<Json<MeshSharedDomainConfigResource>, ApiError> {
    let config: ScriptBuilderMeshState = serde_json::from_value(req.config).map_err(|error| {
        ApiError::bad_request(format!(
            "invalid shared-domain mesh config payload: {error}"
        ))
    })?;
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    scene.study.shared_domain_mesh = config.clone();
    scene.study.mesh_defaults = config.clone();
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let config = serde_json::to_value(&committed.study.shared_domain_mesh).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize committed shared-domain mesh config: {error}"
        ))
    })?;
    let revision = current_snapshot(&state).await?.mesh_revision;
    Ok(Json(MeshSharedDomainConfigResource { revision, config }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/shared-domain/report",
    responses(
        (status = 200, description = "Shared-domain mesh report", body = MeshSharedDomainReportResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_shared_domain_report(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshSharedDomainReportResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let report = Some(json!({
        "mesh_summary": mesh_workspace.get("mesh_summary").cloned().unwrap_or(Value::Null),
        "mesh_pipeline_status": mesh_workspace.get("mesh_pipeline_status").cloned().unwrap_or(Value::Null),
        "last_build_summary": mesh_workspace.get("last_build_summary").cloned().unwrap_or(Value::Null),
    }));
    Ok(Json(MeshSharedDomainReportResource {
        revision: snapshot.mesh_revision,
        report,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/shared-domain/quality",
    responses(
        (status = 200, description = "Shared-domain mesh quality", body = MeshSharedDomainQualityResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_shared_domain_quality(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshSharedDomainQualityResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    Ok(Json(MeshSharedDomainQualityResource {
        revision: snapshot.mesh_revision,
        quality: mesh_workspace.get("mesh_quality_summary").cloned(),
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/shared-domain/manifest",
    responses(
        (status = 200, description = "Shared-domain mesh manifest for tree/selection metadata", body = MeshSharedDomainManifestResource),
        (status = 304, description = "Shared-domain mesh manifest not modified for the supplied ETag"),
        (status = 204, description = "No FEM mesh available"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_shared_domain_manifest(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    match snapshot.fem_mesh.as_ref() {
        Some(mesh) => {
            let body = MeshSharedDomainManifestResource {
                revision: snapshot.mesh_revision,
                mesh_name: mesh.mesh_name.clone(),
                mesh_id: mesh.mesh_id.clone(),
                generation_id: mesh.generation_id.clone(),
                domain_mesh_mode: mesh.domain_mesh_mode.clone(),
                object_segments: mesh
                    .object_segments
                    .iter()
                    .map(MeshObjectSegmentResource::from)
                    .collect(),
                mesh_parts: mesh.mesh_parts.iter().map(MeshPartResource::from).collect(),
            };
            let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
            let etag = super::stable_strong_etag(&format!(
                "mesh-shared-domain-manifest:{generation_id}:{}",
                snapshot.mesh_revision
            ));
            Ok(super::conditional_json_response(&headers, &etag, &body))
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/shared-domain/topology",
    responses(
        (status = 200, description = "Binary shared-domain FEM topology (FMMT)", content_type = "application/octet-stream"),
        (status = 304, description = "Shared-domain topology not modified for the supplied ETag"),
        (status = 204, description = "No FEM mesh available"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_shared_domain_topology(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    match snapshot.fem_mesh.as_ref() {
        Some(mesh) => {
            let binary = serialize_fem_mesh_topology_binary_v1(mesh);
            let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
            let etag = super::stable_strong_etag(&format!(
                "mesh-shared-domain-topology:{generation_id}:{}",
                snapshot.mesh_revision
            ));
            Ok(super::conditional_binary_response(&headers, &etag, binary))
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/objects/{object_id}/config",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Current per-object mesh config", body = MeshObjectConfigResource),
        (status = 404, description = "No active workspace, scene document, or object"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_object_config(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<MeshObjectConfigResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let object = scene
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let config = current_object_mesh_config(object)
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!("failed to serialize object mesh config: {error}"))
        })?;
    Ok(Json(MeshObjectConfigResource {
        revision: snapshot.mesh_revision,
        object_id,
        config,
    }))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/mesh/objects/{object_id}/config",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    request_body = MeshObjectConfigReplaceRequest,
    responses(
        (status = 200, description = "Committed per-object mesh config", body = MeshObjectConfigResource),
        (status = 400, description = "Invalid per-object mesh config payload"),
        (status = 404, description = "No active workspace or object"),
    ),
    tag = "mesh"
)]
pub async fn replace_mesh_object_config(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
    Json(req): Json<MeshObjectConfigReplaceRequest>,
) -> Result<Json<MeshObjectConfigResource>, ApiError> {
    let config = req
        .config
        .map(serde_json::from_value::<ScriptBuilderPerGeometryMeshState>)
        .transpose()
        .map_err(|error| {
            ApiError::bad_request(format!("invalid object mesh config payload: {error}"))
        })?;
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let object = scene
        .objects
        .iter_mut()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    object.object_mesh = config.clone();
    object.mesh_override = config.clone();
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let object = committed
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::internal(format!("committed object missing: {object_id}")))?;
    let config = current_object_mesh_config(object)
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize committed object mesh config: {error}"
            ))
        })?;
    let revision = current_snapshot(&state).await?.mesh_revision;
    Ok(Json(MeshObjectConfigResource {
        revision,
        object_id,
        config,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/objects/{object_id}/report",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Per-object mesh report", body = MeshObjectReportResource),
        (status = 404, description = "No active workspace or object"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_object_report(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<MeshObjectReportResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let object = scene
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let report = Some(json!({
        "object_id": object.id,
        "object_name": object.name,
        "config": current_object_mesh_config(object),
        "effective_target": mesh_workspace
            .get("effective_per_object_targets")
            .and_then(|targets| targets.get(object_id.as_str()))
            .cloned()
            .unwrap_or(Value::Null),
        "last_build_summary": mesh_workspace.get("last_build_summary").cloned().unwrap_or(Value::Null),
    }));
    Ok(Json(MeshObjectReportResource {
        revision: snapshot.mesh_revision,
        object_id,
        report,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/objects/{object_id}/quality",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Per-object mesh quality", body = MeshObjectQualityResource),
        (status = 404, description = "No active workspace or object"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_object_quality(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<MeshObjectQualityResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    scene
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let mesh_workspace = current_mesh_workspace(&snapshot)?;
    let quality = object_quality(&snapshot, mesh_workspace, &object_id);
    Ok(Json(MeshObjectQualityResource {
        revision: snapshot.mesh_revision,
        object_id,
        quality,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/objects/{object_id}/size-field",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Per-object size-field projection", body = MeshObjectSizeFieldResource),
        (status = 404, description = "No active workspace or object"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_object_size_field(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<MeshObjectSizeFieldResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let object = scene
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let size_field = current_object_mesh_config(object).map(|config| {
        json!({
            "size_fields": config.size_fields,
            "operations": config.operations,
        })
    });
    Ok(Json(MeshObjectSizeFieldResource {
        revision: snapshot.mesh_revision,
        object_id,
        size_field,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/objects/{object_id}/topology",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Binary per-object FEM topology (FMMT)", content_type = "application/octet-stream"),
        (status = 304, description = "Per-object topology not modified for the supplied ETag"),
        (status = 204, description = "No FEM mesh available"),
        (status = 404, description = "No active workspace or object mesh"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_object_topology(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(object_id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    match snapshot.fem_mesh.as_ref() {
        Some(mesh) => {
            let object_mesh = subset_object_mesh(mesh, &object_id)
                .ok_or_else(|| ApiError::not_found(format!("object mesh not found: {object_id}")))?;
            let binary = serialize_fem_mesh_topology_binary_v1(&object_mesh);
            let generation_id = mesh.generation_id.as_deref().unwrap_or("no-generation");
            let etag = super::stable_strong_etag(&format!(
                "mesh-object-topology:{object_id}:{generation_id}:{}",
                snapshot.mesh_revision
            ));
            Ok(super::conditional_binary_response(&headers, &etag, binary))
        }
        None => Ok(StatusCode::NO_CONTENT.into_response()),
    }
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/interfaces/{interface_id}/config",
    params(
        ("interface_id" = String, Path, description = "Canonical stable interface id")
    ),
    responses(
        (status = 200, description = "Current per-interface mesh config", body = MeshInterfaceConfigResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_interface_config(
    State(state): State<Arc<AppState>>,
    Path(interface_id): Path<String>,
) -> Result<Json<MeshInterfaceConfigResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let config = scene
        .study
        .mesh_interfaces
        .iter()
        .find(|entry| entry.interface_id == interface_id)
        .map(|entry| serde_json::to_value(&entry.config))
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!("failed to serialize interface mesh config: {error}"))
        })?;
    Ok(Json(MeshInterfaceConfigResource {
        revision: snapshot.mesh_revision,
        interface_id,
        config,
    }))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/mesh/interfaces/{interface_id}/config",
    params(
        ("interface_id" = String, Path, description = "Canonical stable interface id")
    ),
    request_body = MeshInterfaceConfigReplaceRequest,
    responses(
        (status = 200, description = "Committed per-interface mesh config", body = MeshInterfaceConfigResource),
        (status = 400, description = "Invalid interface mesh config payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn replace_mesh_interface_config(
    State(state): State<Arc<AppState>>,
    Path(interface_id): Path<String>,
    Json(req): Json<MeshInterfaceConfigReplaceRequest>,
) -> Result<Json<MeshInterfaceConfigResource>, ApiError> {
    let config = req
        .config
        .map(serde_json::from_value::<ScriptBuilderPerGeometryMeshState>)
        .transpose()
        .map_err(|error| {
            ApiError::bad_request(format!("invalid interface mesh config payload: {error}"))
        })?;
    let (owner_a, owner_b) = resolve_interface_owners(&interface_id, req.owner_a, req.owner_b)?;

    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    if let Some(index) = scene
        .study
        .mesh_interfaces
        .iter()
        .position(|entry| entry.interface_id == interface_id)
    {
        if let Some(config) = config.clone() {
            scene.study.mesh_interfaces[index] = SceneMeshInterface {
                interface_id: interface_id.clone(),
                owner_a: owner_a.clone(),
                owner_b: owner_b.clone(),
                config,
            };
        } else {
            scene.study.mesh_interfaces.remove(index);
        }
    } else if let Some(config) = config.clone() {
        scene.study.mesh_interfaces.push(SceneMeshInterface {
            interface_id: interface_id.clone(),
            owner_a: owner_a.clone(),
            owner_b: owner_b.clone(),
            config,
        });
    }

    let _committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let snapshot = current_snapshot(&state).await?;
    let committed_scene = current_scene_document(&snapshot)?;
    let config = committed_scene
        .study
        .mesh_interfaces
        .iter()
        .find(|entry| entry.interface_id == interface_id)
        .map(|entry| serde_json::to_value(&entry.config))
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!(
                "failed to serialize committed interface mesh config: {error}"
            ))
        })?;
    Ok(Json(MeshInterfaceConfigResource {
        revision: snapshot.mesh_revision,
        interface_id,
        config,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/interfaces/{interface_id}/report",
    params(
        ("interface_id" = String, Path, description = "Canonical stable interface id")
    ),
    responses(
        (status = 200, description = "Per-interface mesh report", body = MeshInterfaceReportResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_interface_report(
    State(state): State<Arc<AppState>>,
    Path(interface_id): Path<String>,
) -> Result<Json<MeshInterfaceReportResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let scene = current_scene_document(&snapshot)?;
    let report = scene
        .study
        .mesh_interfaces
        .iter()
        .find(|entry| entry.interface_id == interface_id)
        .map(|entry| {
            json!({
                "interface_id": entry.interface_id,
                "owner_a": entry.owner_a,
                "owner_b": entry.owner_b,
                "config": entry.config,
            })
        });
    Ok(Json(MeshInterfaceReportResource {
        revision: snapshot.mesh_revision,
        interface_id,
        report,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/interfaces/{interface_id}/quality",
    params(
        ("interface_id" = String, Path, description = "Canonical stable interface id")
    ),
    responses(
        (status = 200, description = "Per-interface mesh quality", body = MeshInterfaceQualityResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_interface_quality(
    State(state): State<Arc<AppState>>,
    Path(interface_id): Path<String>,
) -> Result<Json<MeshInterfaceQualityResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    Ok(Json(MeshInterfaceQualityResource {
        revision: snapshot.mesh_revision,
        interface_id,
        quality: None,
    }))
}

async fn current_snapshot(state: &Arc<AppState>) -> Result<SessionStateResponse, ApiError> {
    state
        .current_live_state
        .read()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))
}

fn current_scene_document(snapshot: &SessionStateResponse) -> Result<&SceneDocument, ApiError> {
    snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no scene document available for current workspace"))
}

fn current_mesh_workspace(snapshot: &SessionStateResponse) -> Result<&Value, ApiError> {
    snapshot
        .mesh_workspace
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no mesh workspace available for current workspace"))
}

fn current_universe_mesh_config(scene: &SceneDocument) -> Option<&ScriptBuilderUniverseState> {
    scene
        .study
        .universe_mesh
        .as_ref()
        .or(scene.universe.as_ref())
}

fn current_object_mesh_config(object: &SceneObject) -> Option<&ScriptBuilderPerGeometryMeshState> {
    object
        .object_mesh
        .as_ref()
        .or(object.mesh_override.as_ref())
}

fn resolve_interface_owners(
    interface_id: &str,
    owner_a: Option<String>,
    owner_b: Option<String>,
) -> Result<(String, String), ApiError> {
    match (owner_a, owner_b) {
        (Some(owner_a), Some(owner_b)) => Ok((owner_a, owner_b)),
        (Some(owner_a), None) => {
            let (_, parsed_b) = parse_interface_owners(interface_id).ok_or_else(|| {
                ApiError::bad_request(format!(
                    "interface owners missing and interface_id is not parseable: {interface_id}"
                ))
            })?;
            Ok((owner_a, parsed_b))
        }
        (None, Some(owner_b)) => {
            let (parsed_a, _) = parse_interface_owners(interface_id).ok_or_else(|| {
                ApiError::bad_request(format!(
                    "interface owners missing and interface_id is not parseable: {interface_id}"
                ))
            })?;
            Ok((parsed_a, owner_b))
        }
        (None, None) => parse_interface_owners(interface_id).ok_or_else(|| {
            ApiError::bad_request(format!(
                "interface owners missing and interface_id is not parseable: {interface_id}"
            ))
        }),
    }
}

fn parse_interface_owners(interface_id: &str) -> Option<(String, String)> {
    let (owner_a, owner_b) = interface_id.split_once('|')?;
    if owner_a.is_empty() || owner_b.is_empty() {
        return None;
    }
    Some((owner_a.to_string(), owner_b.to_string()))
}

fn object_quality(
    snapshot: &SessionStateResponse,
    mesh_workspace: &Value,
    object_id: &str,
) -> Option<Value> {
    let effective_target = mesh_workspace
        .get("effective_per_object_targets")
        .and_then(|targets| targets.get(object_id))
        .cloned();
    let marker = effective_target
        .as_ref()
        .and_then(|target| target.get("marker"))
        .and_then(Value::as_u64)
        .map(|marker| marker as u32);
    let per_domain_quality = marker
        .and_then(|marker| snapshot.fem_mesh.as_ref()?.per_domain_quality.get(&marker).cloned())
        .and_then(|quality| serde_json::to_value(quality).ok());
    Some(json!({
        "marker": marker,
        "effective_target": effective_target.unwrap_or(Value::Null),
        "per_domain_quality": per_domain_quality.unwrap_or(Value::Null),
    }))
}

fn subset_object_mesh(mesh: &FemMeshPayload, object_id: &str) -> Option<FemMeshPayload> {
    let segment = mesh
        .object_segments
        .iter()
        .find(|segment| segment.object_id == object_id)?;
    let node_start = segment.node_start as usize;
    let node_end = node_start.saturating_add(segment.node_count as usize);
    let element_start = segment.element_start as usize;
    let element_end = element_start.saturating_add(segment.element_count as usize);
    let face_start = segment.boundary_face_start as usize;
    let face_end = face_start.saturating_add(segment.boundary_face_count as usize);

    let nodes = mesh.nodes.get(node_start..node_end)?.to_vec();
    let elements = mesh
        .elements
        .get(element_start..element_end)?
        .iter()
        .map(|element| {
            [
                element[0] - segment.node_start,
                element[1] - segment.node_start,
                element[2] - segment.node_start,
                element[3] - segment.node_start,
            ]
        })
        .collect::<Vec<_>>();
    let boundary_faces = mesh
        .boundary_faces
        .get(face_start..face_end)?
        .iter()
        .map(|face| {
            [
                face[0] - segment.node_start,
                face[1] - segment.node_start,
                face[2] - segment.node_start,
            ]
        })
        .collect::<Vec<_>>();
    let element_markers = mesh
        .element_markers
        .get(element_start..element_end)
        .map(|markers| markers.to_vec())
        .unwrap_or_default();
    let boundary_markers = mesh
        .boundary_markers
        .get(face_start..face_end)
        .map(|markers| markers.to_vec())
        .unwrap_or_default();
    let quality_markers = element_markers.iter().copied().collect::<BTreeSet<_>>();
    let per_domain_quality = quality_markers
        .iter()
        .filter_map(|marker| {
            mesh.per_domain_quality
                .get(marker)
                .cloned()
                .map(|quality| (*marker, quality))
        })
        .collect::<HashMap<_, _>>();

    Some(FemMeshPayload {
        mesh_name: format!("{}:{object_id}", mesh.mesh_name),
        mesh_id: format!("{}:{object_id}", mesh.mesh_id),
        nodes,
        elements,
        element_markers,
        boundary_faces,
        boundary_markers,
        object_segments: vec![FemMeshObjectSegment {
            object_id: object_id.to_string(),
            geometry_id: segment.geometry_id.clone(),
            node_start: 0,
            node_count: segment.node_count,
            element_start: 0,
            element_count: segment.element_count,
            boundary_face_start: 0,
            boundary_face_count: segment.boundary_face_count,
        }],
        mesh_parts: Vec::new(),
        domain_mesh_mode: mesh.domain_mesh_mode.clone(),
        domain_frame: mesh.domain_frame.clone(),
        generation_id: mesh.generation_id.clone(),
        per_domain_quality,
    })
}
