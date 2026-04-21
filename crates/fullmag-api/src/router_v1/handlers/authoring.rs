//! Authoring resource endpoints.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::schemas::authoring::{
    AuthoringTransactionRequest, AuthoringTransactionResponse, MaterialPatchRequest,
    MaterialPropertiesResource, MaterialResource, ScenePatchRequest, StudyRuntimePatchRequest,
    StudyRuntimeResource,
};
use crate::types::{AppState, ScriptSourceResponse, ScriptSyncRequest, ScriptSyncResponse};
use fullmag_authoring::SceneDocument;

#[utoipa::path(
    get,
    path = "/v1/live/current/authoring/scene",
    responses(
        (status = 200, description = "Current canonical authoring scene document", body = Value),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "authoring"
)]
pub async fn get_authoring_scene(
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    serde_json::to_value(scene)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    put,
    path = "/v1/live/current/authoring/scene",
    request_body = Value,
    responses(
        (status = 200, description = "Committed canonical authoring scene document", body = Value),
        (status = 400, description = "Invalid scene document payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "authoring"
)]
pub async fn replace_authoring_scene(
    State(state): State<Arc<AppState>>,
    Json(scene_value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let scene_document: SceneDocument = serde_json::from_value(scene_value)
        .map_err(|error| ApiError::bad_request(format!("invalid scene document payload: {error}")))?;
    let committed = crate::commit_current_live_scene_document(&state, scene_document).await?;
    serde_json::to_value(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    patch,
    path = "/v1/live/current/authoring/scene",
    request_body = ScenePatchRequest,
    responses(
        (status = 200, description = "Committed canonical authoring scene after merge patch", body = Value),
        (status = 400, description = "Invalid scene patch payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "authoring"
)]
pub async fn patch_authoring_scene(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ScenePatchRequest>,
) -> Result<Json<Value>, ApiError> {
    let current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let patched_scene = apply_scene_merge_patch(&current_scene, &req.merge_patch)?;
    let committed = crate::commit_current_live_scene_document(&state, patched_scene).await?;
    serde_json::to_value(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/authoring/study/runtime",
    responses(
        (status = 200, description = "Requested runtime selection stored in the canonical scene document", body = StudyRuntimeResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "authoring"
)]
pub async fn get_authoring_study_runtime(
    State(state): State<Arc<AppState>>,
) -> Result<Json<StudyRuntimeResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    Ok(Json(build_study_runtime_resource(&scene)))
}

#[utoipa::path(
    patch,
    path = "/v1/live/current/authoring/study/runtime",
    request_body = StudyRuntimePatchRequest,
    responses(
        (status = 200, description = "Committed requested runtime selection", body = StudyRuntimeResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "authoring"
)]
pub async fn patch_authoring_study_runtime(
    State(state): State<Arc<AppState>>,
    Json(req): Json<StudyRuntimePatchRequest>,
) -> Result<Json<StudyRuntimeResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    if let Some(value) = req.requested_backend {
        scene.study.requested_backend = value;
    }
    if let Some(value) = req.requested_device {
        scene.study.requested_device = value;
    }
    if let Some(value) = req.requested_precision {
        scene.study.requested_precision = value;
    }
    if let Some(value) = req.requested_mode {
        scene.study.requested_mode = value;
    }
    if let Some(value) = req.requested_cpu_threads {
        scene.study.requested_cpu_threads = parse_nullable_u32_patch(
            value,
            "requested_cpu_threads",
        )?;
    }

    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    Ok(Json(build_study_runtime_resource(&committed)))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/authoring/model/materials/{material_id}",
    params(
        ("material_id" = String, Path, description = "Canonical material asset id")
    ),
    responses(
        (status = 200, description = "Canonical material asset", body = MaterialResource),
        (status = 404, description = "No active workspace or material not found"),
    ),
    tag = "authoring"
)]
pub async fn get_authoring_material(
    State(state): State<Arc<AppState>>,
    Path(material_id): Path<String>,
) -> Result<Json<MaterialResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let material = scene
        .materials
        .iter()
        .find(|entry| entry.id == material_id)
        .ok_or_else(|| ApiError::not_found(format!("material not found: {material_id}")))?;
    Ok(Json(build_material_resource(material)))
}

#[utoipa::path(
    patch,
    path = "/v1/live/current/authoring/model/materials/{material_id}",
    params(
        ("material_id" = String, Path, description = "Canonical material asset id")
    ),
    request_body = MaterialPatchRequest,
    responses(
        (status = 200, description = "Committed canonical material asset", body = MaterialResource),
        (status = 404, description = "No active workspace or material not found"),
    ),
    tag = "authoring"
)]
pub async fn patch_authoring_material(
    State(state): State<Arc<AppState>>,
    Path(material_id): Path<String>,
    Json(req): Json<MaterialPatchRequest>,
) -> Result<Json<MaterialResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let material = scene
        .materials
        .iter_mut()
        .find(|entry| entry.id == material_id)
        .ok_or_else(|| ApiError::not_found(format!("material not found: {material_id}")))?;

    if let Some(name) = req.name {
        material.name = name;
    }
    if let Some(properties) = req.properties {
        if let Some(value) = properties.ms {
            material.properties.ms = parse_nullable_f64_patch(value, "Ms")?;
        }
        if let Some(value) = properties.aex {
            material.properties.aex = parse_nullable_f64_patch(value, "Aex")?;
        }
        if let Some(value) = properties.alpha {
            material.properties.alpha = value;
        }
        if let Some(value) = properties.dind {
            material.properties.dind = parse_nullable_f64_patch(value, "Dind")?;
        }
    }

    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let material = committed
        .materials
        .iter()
        .find(|entry| entry.id == material_id)
        .ok_or_else(|| ApiError::internal(format!("committed material missing: {material_id}")))?;
    Ok(Json(build_material_resource(material)))
}

#[utoipa::path(
    post,
    path = "/v1/live/current/authoring/transactions",
    request_body = AuthoringTransactionRequest,
    responses(
        (status = 200, description = "Committed authoring transaction", body = AuthoringTransactionResponse),
        (status = 400, description = "Invalid authoring transaction payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "authoring"
)]
pub async fn commit_authoring_transaction(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AuthoringTransactionRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let (transaction_kind, committed) = match req {
        AuthoringTransactionRequest::ReplaceScene { scene } => {
            let scene_document: SceneDocument = serde_json::from_value(scene)
                .map_err(|error| ApiError::bad_request(format!("invalid scene document payload: {error}")))?;
            let committed = crate::commit_current_live_scene_document(&state, scene_document).await?;
            ("replace_scene", committed)
        }
        AuthoringTransactionRequest::MergePatch { merge_patch } => {
            let current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            let patched_scene = apply_scene_merge_patch(&current_scene, &merge_patch)?;
            let committed = crate::commit_current_live_scene_document(&state, patched_scene).await?;
            ("merge_patch", committed)
        }
    };

    let committed_scene = serde_json::to_value(&committed)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))?;

    Ok(Json(AuthoringTransactionResponse {
        transaction_kind: transaction_kind.to_string(),
        scene_revision: committed.revision,
        committed_scene,
    }))
}

#[utoipa::path(
    get,
    path = "/v1/live/current/authoring/script/source",
    responses(
        (status = 200, description = "Current canonical Python source for the active workspace", body = ScriptSourceResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "authoring"
)]
pub async fn get_authoring_script_source(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ScriptSourceResponse>, ApiError> {
    crate::script::get_current_live_script_source(&state)
        .await
        .map(Json)
}

#[utoipa::path(
    post,
    path = "/v1/live/current/authoring/script/sync",
    request_body = ScriptSyncRequest,
    responses(
        (status = 200, description = "Canonical Python rewritten from authoring state", body = ScriptSyncResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "authoring"
)]
pub async fn sync_authoring_script(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ScriptSyncRequest>,
) -> Result<Json<ScriptSyncResponse>, ApiError> {
    crate::script::sync_current_live_script_with_request(&state, req)
        .await
        .map(Json)
}

fn apply_scene_merge_patch(
    scene: &SceneDocument,
    merge_patch: &Value,
) -> Result<SceneDocument, ApiError> {
    let mut scene_value = serde_json::to_value(scene)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))?;
    merge_patch_value(&mut scene_value, merge_patch);
    serde_json::from_value(scene_value)
        .map_err(|error| ApiError::bad_request(format!("invalid scene patch payload: {error}")))
}

fn merge_patch_value(target: &mut Value, patch: &Value) {
    match patch {
        Value::Object(patch_map) => {
            if !target.is_object() {
                *target = Value::Object(serde_json::Map::new());
            }
            let target_map = target
                .as_object_mut()
                .expect("target is object after normalization");
            for (key, patch_value) in patch_map {
                if patch_value.is_null() {
                    target_map.remove(key);
                    continue;
                }
                match target_map.get_mut(key) {
                    Some(existing) => merge_patch_value(existing, patch_value),
                    None => {
                        target_map.insert(key.clone(), patch_value.clone());
                    }
                }
            }
        }
        _ => {
            *target = patch.clone();
        }
    }
}

fn build_study_runtime_resource(scene: &SceneDocument) -> StudyRuntimeResource {
    StudyRuntimeResource {
        backend: scene.study.backend.clone(),
        requested_backend: scene.study.requested_backend.clone(),
        requested_device: scene.study.requested_device.clone(),
        requested_precision: scene.study.requested_precision.clone(),
        requested_mode: scene.study.requested_mode.clone(),
        requested_cpu_threads: scene.study.requested_cpu_threads,
    }
}

fn build_material_resource(material: &fullmag_authoring::SceneMaterialAsset) -> MaterialResource {
    MaterialResource {
        id: material.id.clone(),
        name: material.name.clone(),
        properties: MaterialPropertiesResource {
            ms: material.properties.ms,
            aex: material.properties.aex,
            alpha: material.properties.alpha,
            dind: material.properties.dind,
        },
    }
}

fn parse_nullable_u32_patch(value: Value, field_name: &str) -> Result<Option<u32>, ApiError> {
    match value {
        Value::Null => Ok(None),
        Value::Number(number) => number
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .map(Some)
            .ok_or_else(|| ApiError::bad_request(format!("invalid `{field_name}` patch value"))),
        _ => Err(ApiError::bad_request(format!(
            "invalid `{field_name}` patch value"
        ))),
    }
}

fn parse_nullable_f64_patch(value: Value, field_name: &str) -> Result<Option<f64>, ApiError> {
    match value {
        Value::Null => Ok(None),
        Value::Number(number) => number
            .as_f64()
            .map(Some)
            .ok_or_else(|| ApiError::bad_request(format!("invalid `{field_name}` patch value"))),
        _ => Err(ApiError::bad_request(format!(
            "invalid `{field_name}` patch value"
        ))),
    }
}
