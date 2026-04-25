//! Authoring resource endpoints.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::schemas::authoring::{
    AuthoringTransactionRequest, AuthoringTransactionResponse, MaterialPatchRequest,
    MaterialPropertiesResource, MaterialResource, NullableF64PatchValue, NullableU32PatchValue,
    ObjectInteractionPatchRequest, ObjectInteractionResource, ScenePatchRequest,
    StudyRuntimePatchRequest, StudyRuntimeResource,
};
use crate::types::{AppState, ScriptSourceResponse, ScriptSyncRequest, ScriptSyncResponse};
use fullmag_authoring::{
    SceneDocument, SceneObject, ScriptBuilderMagneticInteractionEntry,
    ScriptBuilderMagneticInteractionKind,
};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/scene",
    responses(
        (status = 200, description = "Current canonical authoring scene document", body = Value),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
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
    path = "/v2/sessions/current/model/scene",
    request_body = Value,
    responses(
        (status = 200, description = "Committed canonical authoring scene document", body = Value),
        (status = 400, description = "Invalid scene document payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "model"
)]
pub async fn replace_authoring_scene(
    State(state): State<Arc<AppState>>,
    Json(scene_value): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let scene_document: SceneDocument = serde_json::from_value(scene_value).map_err(|error| {
        ApiError::bad_request(format!("invalid scene document payload: {error}"))
    })?;
    let committed = crate::commit_current_live_scene_document(&state, scene_document).await?;
    serde_json::to_value(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/scene",
    request_body = ScenePatchRequest,
    responses(
        (status = 200, description = "Committed canonical authoring scene after merge patch", body = Value),
        (status = 400, description = "Invalid scene patch payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "model"
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
    path = "/v2/sessions/current/model/study",
    responses(
        (status = 200, description = "Requested runtime selection stored in the canonical scene document", body = StudyRuntimeResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_study_runtime(
    State(state): State<Arc<AppState>>,
) -> Result<Json<StudyRuntimeResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    Ok(Json(build_study_runtime_resource(&scene)))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/study",
    request_body = StudyRuntimePatchRequest,
    responses(
        (status = 200, description = "Committed requested runtime selection", body = StudyRuntimeResource),
        (status = 404, description = "No active workspace"),
    ),
    tag = "model"
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
        scene.study.requested_cpu_threads = match value {
            NullableU32PatchValue::Value(value) => Some(value),
            NullableU32PatchValue::Null => None,
        };
    }

    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    Ok(Json(build_study_runtime_resource(&committed)))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/materials/{material_id}",
    params(
        ("material_id" = String, Path, description = "Canonical material asset id")
    ),
    responses(
        (status = 200, description = "Canonical material asset", body = MaterialResource),
        (status = 404, description = "No active workspace or material not found"),
    ),
    tag = "model"
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
    path = "/v2/sessions/current/model/materials/{material_id}",
    params(
        ("material_id" = String, Path, description = "Canonical material asset id")
    ),
    request_body = MaterialPatchRequest,
    responses(
        (status = 200, description = "Committed canonical material asset", body = MaterialResource),
        (status = 404, description = "No active workspace or material not found"),
    ),
    tag = "model"
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
            material.properties.ms = match value {
                NullableF64PatchValue::Value(value) => Some(value),
                NullableF64PatchValue::Null => None,
            };
        }
        if let Some(value) = properties.aex {
            material.properties.aex = match value {
                NullableF64PatchValue::Value(value) => Some(value),
                NullableF64PatchValue::Null => None,
            };
        }
        if let Some(value) = properties.alpha {
            material.properties.alpha = value;
        }
        if let Some(value) = properties.dind {
            material.properties.dind = match value {
                NullableF64PatchValue::Value(value) => Some(value),
                NullableF64PatchValue::Null => None,
            };
        }
    }

    sync_interfacial_dmi_for_material(&mut scene, &material_id);

    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let material = committed
        .materials
        .iter()
        .find(|entry| entry.id == material_id)
        .ok_or_else(|| ApiError::internal(format!("committed material missing: {material_id}")))?;
    Ok(Json(build_material_resource(material)))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/objects/{object_id}/interactions/{interaction_kind}",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id"),
        ("interaction_kind" = String, Path, description = "Interaction kind: exchange | demag | interfacial_dmi | uniaxial_anisotropy")
    ),
    responses(
        (status = 200, description = "Canonical object interaction resource", body = ObjectInteractionResource),
        (status = 404, description = "No active workspace, object not found, or optional interaction missing"),
    ),
    tag = "model"
)]
pub async fn get_authoring_object_interaction(
    State(state): State<Arc<AppState>>,
    Path((object_id, interaction_kind)): Path<(String, String)>,
) -> Result<Json<ObjectInteractionResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let kind = parse_interaction_kind(&interaction_kind)?;
    let object = scene
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    let interaction = find_interaction(object, kind);
    if interaction.is_none() && !is_required_interaction(kind) {
        return Err(ApiError::not_found(format!(
            "interaction not found: {interaction_kind}"
        )));
    }
    Ok(Json(build_object_interaction_resource(
        object,
        kind,
        interaction,
    )))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/objects/{object_id}/interactions/{interaction_kind}",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id"),
        ("interaction_kind" = String, Path, description = "Interaction kind: exchange | demag | interfacial_dmi | uniaxial_anisotropy")
    ),
    request_body = ObjectInteractionPatchRequest,
    responses(
        (status = 200, description = "Committed canonical object interaction resource", body = ObjectInteractionResource),
        (status = 400, description = "Invalid interaction patch payload"),
        (status = 404, description = "No active workspace or object not found"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_object_interaction(
    State(state): State<Arc<AppState>>,
    Path((object_id, interaction_kind)): Path<(String, String)>,
    Json(req): Json<ObjectInteractionPatchRequest>,
) -> Result<Json<ObjectInteractionResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let kind = parse_interaction_kind(&interaction_kind)?;
    let material_dind = material_dind_for_object(&scene, &object_id);
    let object = scene
        .objects
        .iter_mut()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;

    apply_interaction_patch(object, kind, material_dind, req)?;

    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let object = committed
        .objects
        .iter()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::internal(format!("committed object missing: {object_id}")))?;
    let interaction = find_interaction(object, kind);
    Ok(Json(build_object_interaction_resource(
        object,
        kind,
        interaction,
    )))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/transactions",
    request_body = AuthoringTransactionRequest,
    responses(
        (status = 200, description = "Committed authoring transaction", body = AuthoringTransactionResponse),
        (status = 400, description = "Invalid authoring transaction payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "model"
)]
pub async fn commit_authoring_transaction(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AuthoringTransactionRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let (transaction_kind, committed) = match req {
        AuthoringTransactionRequest::ReplaceScene { scene } => {
            let scene_document: SceneDocument = serde_json::from_value(scene).map_err(|error| {
                ApiError::bad_request(format!("invalid scene document payload: {error}"))
            })?;
            let committed =
                crate::commit_current_live_scene_document(&state, scene_document).await?;
            ("replace_scene", committed)
        }
        AuthoringTransactionRequest::MergePatch { merge_patch } => {
            let current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            let patched_scene = apply_scene_merge_patch(&current_scene, &merge_patch)?;
            let committed =
                crate::commit_current_live_scene_document(&state, patched_scene).await?;
            ("merge_patch", committed)
        }
    };

    let committed_scene = serde_json::to_value(&committed).map_err(|error| {
        ApiError::internal(format!("failed to serialize scene document: {error}"))
    })?;

    Ok(Json(AuthoringTransactionResponse {
        transaction_kind: transaction_kind.to_string(),
        scene_revision: committed.revision,
        committed_scene,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/script",
    responses(
        (status = 200, description = "Current canonical Python source for the active workspace", body = ScriptSourceResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "model"
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
    path = "/v2/sessions/current/model/syncs",
    request_body = ScriptSyncRequest,
    responses(
        (status = 200, description = "Canonical Python rewritten from authoring state", body = ScriptSyncResponse),
        (status = 404, description = "No active workspace"),
    ),
    tag = "model"
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
    let mut scene_value = serde_json::to_value(scene).map_err(|error| {
        ApiError::internal(format!("failed to serialize scene document: {error}"))
    })?;
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

fn sync_interfacial_dmi_for_material(scene: &mut SceneDocument, material_id: &str) {
    let material_dind = scene
        .materials
        .iter()
        .find(|entry| entry.id == material_id)
        .and_then(|entry| entry.properties.dind)
        .unwrap_or(0.0);
    for object in &mut scene.objects {
        if object.material_ref != material_id {
            continue;
        }
        if let Some(interaction) = object
            .physics_stack
            .iter_mut()
            .find(|entry| entry.kind == ScriptBuilderMagneticInteractionKind::InterfacialDmi)
        {
            let mut params = match interaction.params.clone() {
                Some(Value::Object(map)) => map,
                _ => Default::default(),
            };
            params.insert("dind".to_string(), Value::from(material_dind));
            interaction.params = Some(Value::Object(params));
        }
    }
}

fn parse_interaction_kind(raw: &str) -> Result<ScriptBuilderMagneticInteractionKind, ApiError> {
    match raw {
        "exchange" => Ok(ScriptBuilderMagneticInteractionKind::Exchange),
        "demag" => Ok(ScriptBuilderMagneticInteractionKind::Demag),
        "interfacial_dmi" => Ok(ScriptBuilderMagneticInteractionKind::InterfacialDmi),
        "uniaxial_anisotropy" => Ok(ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy),
        _ => Err(ApiError::bad_request(format!(
            "unsupported interaction kind: {raw}"
        ))),
    }
}

fn interaction_kind_str(kind: ScriptBuilderMagneticInteractionKind) -> &'static str {
    match kind {
        ScriptBuilderMagneticInteractionKind::Exchange => "exchange",
        ScriptBuilderMagneticInteractionKind::Demag => "demag",
        ScriptBuilderMagneticInteractionKind::InterfacialDmi => "interfacial_dmi",
        ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy => "uniaxial_anisotropy",
    }
}

fn is_required_interaction(kind: ScriptBuilderMagneticInteractionKind) -> bool {
    matches!(
        kind,
        ScriptBuilderMagneticInteractionKind::Exchange
            | ScriptBuilderMagneticInteractionKind::Demag
    )
}

fn material_dind_for_object(scene: &SceneDocument, object_id: &str) -> Option<f64> {
    let object = scene.objects.iter().find(|entry| entry.id == object_id)?;
    scene
        .materials
        .iter()
        .find(|entry| entry.id == object.material_ref)
        .and_then(|entry| entry.properties.dind)
}

fn find_interaction(
    object: &SceneObject,
    kind: ScriptBuilderMagneticInteractionKind,
) -> Option<&ScriptBuilderMagneticInteractionEntry> {
    object.physics_stack.iter().find(|entry| entry.kind == kind)
}

fn build_object_interaction_resource(
    object: &SceneObject,
    kind: ScriptBuilderMagneticInteractionKind,
    interaction: Option<&ScriptBuilderMagneticInteractionEntry>,
) -> ObjectInteractionResource {
    let (present, enabled, params) = match interaction {
        Some(entry) => (
            true,
            entry.enabled,
            entry
                .params
                .clone()
                .unwrap_or_else(|| Value::Object(Default::default())),
        ),
        None => (false, false, Value::Object(Default::default())),
    };
    ObjectInteractionResource {
        object_id: object.id.clone(),
        interaction_kind: interaction_kind_str(kind).to_string(),
        present,
        enabled,
        params,
    }
}

fn apply_interaction_patch(
    object: &mut SceneObject,
    kind: ScriptBuilderMagneticInteractionKind,
    material_dind: Option<f64>,
    req: ObjectInteractionPatchRequest,
) -> Result<(), ApiError> {
    if req.present == Some(false) && is_required_interaction(kind) {
        return Err(ApiError::bad_request(format!(
            "cannot remove required interaction: {}",
            interaction_kind_str(kind)
        )));
    }

    if req.present == Some(false) {
        object.physics_stack.retain(|entry| entry.kind != kind);
        return Ok(());
    }

    let default_params = match kind {
        ScriptBuilderMagneticInteractionKind::InterfacialDmi => Value::Object(
            [(
                "dind".to_string(),
                Value::from(material_dind.unwrap_or(1e-3)),
            )]
            .into_iter()
            .collect(),
        ),
        ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy => serde_json::json!({
            "ku1": 0.0,
            "axis": [0.0, 0.0, 1.0]
        }),
        _ => Value::Object(Default::default()),
    };

    if let Some(existing) = object
        .physics_stack
        .iter_mut()
        .find(|entry| entry.kind == kind)
    {
        if let Some(enabled) = req.enabled {
            existing.enabled = enabled;
        }
        if let Some(params) = req.params {
            existing.params = Some(Value::Object(expect_object_params(params, kind)?));
        }
        return Ok(());
    }

    object
        .physics_stack
        .push(ScriptBuilderMagneticInteractionEntry {
            kind,
            enabled: req.enabled.unwrap_or(true),
            params: Some(Value::Object(expect_object_params(
                req.params.unwrap_or(default_params),
                kind,
            )?)),
        });
    Ok(())
}

fn expect_object_params(
    value: Value,
    kind: ScriptBuilderMagneticInteractionKind,
) -> Result<serde_json::Map<String, Value>, ApiError> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(ApiError::bad_request(format!(
            "invalid params payload for interaction: {}",
            interaction_kind_str(kind)
        ))),
    }
}
