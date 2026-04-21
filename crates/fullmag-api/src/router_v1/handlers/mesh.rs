//! Mesh resource endpoints.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::schemas::commands::{CommandResponse, StructuredCommandRequest};
use crate::schemas::mesh::{
    MeshActiveBuildResource, MeshBuildCommandRequest, MeshObjectConfigReplaceRequest,
    MeshObjectConfigResource, MeshSharedDomainConfigReplaceRequest, MeshSharedDomainConfigResource,
    MeshUniverseConfigReplaceRequest, MeshUniverseConfigResource, MeshWorkspaceResource,
};
use crate::types::{AppState, SessionStateResponse};
use fullmag_authoring::{
    SceneDocument, ScriptBuilderMeshState, ScriptBuilderPerGeometryMeshState,
    ScriptBuilderUniverseState,
};

#[utoipa::path(
    get,
    path = "/v1/live/current/mesh/summary",
    responses(
        (status = 200, description = "Current mesh workspace read-model", body = MeshWorkspaceResource),
        (status = 404, description = "No active workspace or mesh summary"),
    ),
    tag = "mesh"
)]
pub async fn get_mesh_summary(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MeshWorkspaceResource>, ApiError> {
    let snapshot = current_snapshot(&state).await?;
    let mesh_workspace = snapshot
        .mesh_workspace
        .ok_or_else(|| ApiError::not_found("no mesh workspace available for current workspace"))?;
    Ok(Json(MeshWorkspaceResource {
        revision: snapshot.state_version,
        mesh_workspace,
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
    let mesh_workspace = snapshot
        .mesh_workspace
        .ok_or_else(|| ApiError::not_found("no mesh workspace available for current workspace"))?;
    Ok(Json(MeshActiveBuildResource {
        revision: snapshot.state_version,
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
    let response = crate::router_v1::handlers::commands::submit_structured_command_impl(
        state,
        &headers,
        StructuredCommandRequest::Remesh {
            mesh_options: req.mesh_options,
            mesh_target: req.mesh_target,
            mesh_reason: req.mesh_reason,
        },
    )
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let config = current_universe_mesh_config(&scene)
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| {
            ApiError::internal(format!("failed to serialize universe mesh config: {error}"))
        })?;
    Ok(Json(MeshUniverseConfigResource {
        revision: scene.revision,
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
    Ok(Json(MeshUniverseConfigResource {
        revision: committed.revision,
        config: Some(config),
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let config = serde_json::to_value(&scene.study.shared_domain_mesh).map_err(|error| {
        ApiError::internal(format!(
            "failed to serialize shared-domain mesh config: {error}"
        ))
    })?;
    Ok(Json(MeshSharedDomainConfigResource {
        revision: scene.revision,
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
    Ok(Json(MeshSharedDomainConfigResource {
        revision: committed.revision,
        config,
    }))
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
        revision: scene.revision,
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
    Ok(Json(MeshObjectConfigResource {
        revision: committed.revision,
        object_id,
        config,
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

fn current_universe_mesh_config(scene: &SceneDocument) -> Option<&ScriptBuilderUniverseState> {
    scene
        .study
        .universe_mesh
        .as_ref()
        .or(scene.universe.as_ref())
}

fn current_object_mesh_config(
    object: &fullmag_authoring::SceneObject,
) -> Option<&ScriptBuilderPerGeometryMeshState> {
    object
        .object_mesh
        .as_ref()
        .or(object.mesh_override.as_ref())
}
