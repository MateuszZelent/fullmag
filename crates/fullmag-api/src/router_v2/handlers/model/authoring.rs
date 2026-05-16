//! Authoring resource endpoints.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::schemas::authoring::{
    AuthoringTransactionRequest, AuthoringTransactionResponse, GeometryRealizationRequest,
    MagnetizationAssetPatchRequest, MagnetizationAssetResource, MaterialPatchRequest,
    MaterialPropertiesResource, MaterialResource, NullableF64PatchValue, NullableStringPatchValue,
    NullableU32PatchValue, ObjectCreateRequest, ObjectGeometryPatchRequest,
    ObjectInteractionPatchRequest, ObjectInteractionResource, ObjectPatchRequest,
    RegionListResource, RegionPatchRequest, RegionResource, ScenePatchRequest, SceneResource,
    StudyRuntimePatchRequest, StudyRuntimeResource, UniverseFitRequest, UniversePatchRequest,
    UniverseResource,
};
use crate::types::{AppState, ScriptSourceResponse, ScriptSyncRequest, ScriptSyncResponse};
use fullmag_authoring::{
    geometry_capabilities, realize_geometry_scene, validate_geometry_scene, GeometryBackendTarget,
    GeometryCapabilitiesResource, GeometryDiagnostic, GeometryDiagnosticsResource,
    GeometryRealizationSnapshot, GeometryValidationResource, MagnetizationAsset, SceneDocument,
    SceneGeometry, SceneMaterialAsset, SceneObject, SceneRegionOverride,
    ScriptBuilderMagneticInteractionEntry, ScriptBuilderMagneticInteractionKind,
    ScriptBuilderUniverseState, Transform3D,
};

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/scene",
    responses(
        (status = 200, description = "Current canonical authoring scene document", body = SceneResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_scene(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SceneResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    SceneResource::from_scene_document(scene)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/model/scene",
    request_body = Value,
    responses(
        (status = 200, description = "Committed canonical authoring scene document", body = SceneResource),
        (status = 400, description = "Invalid scene document payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "model"
)]
pub async fn replace_authoring_scene(
    State(state): State<Arc<AppState>>,
    Json(scene_value): Json<Value>,
) -> Result<Json<SceneResource>, ApiError> {
    let scene_document: SceneDocument = serde_json::from_value(scene_value).map_err(|error| {
        ApiError::bad_request(format!("invalid scene document payload: {error}"))
    })?;
    let committed = crate::commit_current_live_scene_document(&state, scene_document).await?;
    SceneResource::from_scene_document(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/scene",
    request_body = ScenePatchRequest,
    responses(
        (status = 200, description = "Committed canonical authoring scene after merge patch", body = SceneResource),
        (status = 400, description = "Invalid scene patch payload"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_scene(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ScenePatchRequest>,
) -> Result<Json<SceneResource>, ApiError> {
    let current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let patched_scene = apply_scene_merge_patch(&current_scene, &req.merge_patch)?;
    let committed = crate::commit_current_live_scene_document(&state, patched_scene).await?;
    SceneResource::from_scene_document(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/geometry/capabilities",
    responses(
        (status = 200, description = "Backend-owned geometry primitive and CSG capability matrix", body = GeometryCapabilitiesResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_geometry_capabilities(
    State(state): State<Arc<AppState>>,
) -> Result<Json<GeometryCapabilitiesResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    Ok(Json(geometry_capabilities(scene.revision)))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/geometry/validation",
    responses(
        (status = 200, description = "Backend geometry validation diagnostics for the current scene", body = GeometryValidationResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_geometry_validation(
    State(state): State<Arc<AppState>>,
) -> Result<Json<GeometryValidationResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let backend_target = GeometryBackendTarget::from_scene(&scene);
    Ok(Json(validate_geometry_scene(&scene, backend_target)))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/geometry/realizations",
    request_body = GeometryRealizationRequest,
    responses(
        (status = 200, description = "Derived geometry realization snapshot for the current scene", body = GeometryRealizationSnapshot),
        (status = 400, description = "Invalid backend target"),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn create_authoring_geometry_realization(
    State(state): State<Arc<AppState>>,
    Json(req): Json<GeometryRealizationRequest>,
) -> Result<Json<GeometryRealizationSnapshot>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let backend_target = req
        .backend_target
        .as_deref()
        .map(parse_geometry_backend_target)
        .transpose()?
        .unwrap_or_else(|| GeometryBackendTarget::from_scene(&scene));
    Ok(Json(realize_geometry_scene(&scene, backend_target)))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/geometry/realizations/current",
    responses(
        (status = 200, description = "Current derived geometry realization snapshot", body = GeometryRealizationSnapshot),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_current_authoring_geometry_realization(
    State(state): State<Arc<AppState>>,
) -> Result<Json<GeometryRealizationSnapshot>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let backend_target = GeometryBackendTarget::from_scene(&scene);
    Ok(Json(realize_geometry_scene(&scene, backend_target)))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/geometry/diagnostics",
    responses(
        (status = 200, description = "Current geometry diagnostics", body = GeometryDiagnosticsResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_geometry_diagnostics(
    State(state): State<Arc<AppState>>,
) -> Result<Json<GeometryDiagnosticsResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let validation = validate_geometry_scene(&scene, GeometryBackendTarget::from_scene(&scene));
    Ok(Json(GeometryDiagnosticsResource {
        scene_revision: validation.scene_revision,
        backend_target: validation.backend_target,
        status: validation.status,
        diagnostics: validation.diagnostics,
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/geometry/diagnostics/{diagnostic_id}",
    params(
        ("diagnostic_id" = String, Path, description = "Geometry diagnostic id")
    ),
    responses(
        (status = 200, description = "Current geometry diagnostic", body = GeometryDiagnostic),
        (status = 404, description = "No active workspace, scene document, or diagnostic"),
    ),
    tag = "model"
)]
pub async fn get_authoring_geometry_diagnostic(
    State(state): State<Arc<AppState>>,
    Path(diagnostic_id): Path<String>,
) -> Result<Json<GeometryDiagnostic>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let validation = validate_geometry_scene(&scene, GeometryBackendTarget::from_scene(&scene));
    let diagnostic = validation
        .diagnostics
        .into_iter()
        .find(|diagnostic| diagnostic.id == diagnostic_id || diagnostic.code == diagnostic_id)
        .ok_or_else(|| ApiError::not_found(format!("diagnostic not found: {diagnostic_id}")))?;
    Ok(Json(diagnostic))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/objects",
    request_body = ObjectCreateRequest,
    responses(
        (status = 200, description = "Committed canonical scene after object creation", body = Value),
        (status = 400, description = "Invalid object payload"),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn create_authoring_object(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ObjectCreateRequest>,
) -> Result<Json<Value>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_create_object_transaction(
        &mut scene,
        req.base_revision,
        req.object_id,
        req.name,
        req.geometry,
        req.transform,
        req.material_ref,
        req.region_name,
        req.magnetization_ref,
        req.material_asset,
        req.magnetization_asset,
        req.universe,
        req.study_universe_mesh,
    )?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    serde_json::to_value(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/objects/{object_id}",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    request_body = ObjectPatchRequest,
    responses(
        (status = 200, description = "Committed canonical scene after object patch", body = Value),
        (status = 404, description = "No active workspace, scene document, or object"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_object(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
    Json(req): Json<ObjectPatchRequest>,
) -> Result<Json<Value>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_object_patch(&mut scene, &object_id, req)?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    serde_json::to_value(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/model/objects/{object_id}",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    responses(
        (status = 200, description = "Committed canonical scene after object deletion", body = Value),
        (status = 404, description = "No active workspace, scene document, or object"),
    ),
    tag = "model"
)]
pub async fn delete_authoring_object(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_delete_object_transaction(&mut scene, None, &object_id)?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    serde_json::to_value(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/regions",
    responses(
        (status = 200, description = "Current object-derived region resources", body = RegionListResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_regions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RegionListResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let realization = realize_geometry_scene(&scene, GeometryBackendTarget::from_scene(&scene));
    let regions = realization
        .region_candidates
        .iter()
        .map(|candidate| {
            let object = scene
                .objects
                .iter()
                .find(|object| object.id == candidate.object_id);
            let name = object
                .and_then(|object| object.region_name.as_ref())
                .filter(|value| !value.trim().is_empty())
                .cloned()
                .unwrap_or_else(|| {
                    object
                        .map(|object| object.name.clone())
                        .unwrap_or_else(|| candidate.id.clone())
                });
            let interaction_refs = object
                .map(|object| {
                    object
                        .physics_stack
                        .iter()
                        .map(|entry| magnetic_interaction_kind_id(entry.kind).to_string())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            RegionResource {
                region_id: candidate.id.clone(),
                name,
                source: "object".to_string(),
                source_object_ids: vec![candidate.object_id.clone()],
                source_body_ids: candidate.source_body_ids.clone(),
                material_ref: candidate.material_ref.clone(),
                magnetization_ref: candidate.magnetization_ref.clone(),
                interaction_refs,
                mesh_part_ids: Vec::new(),
                enabled: object.map(|object| object.visible).unwrap_or(true),
                bounds_min: candidate.bounds_min,
                bounds_max: candidate.bounds_max,
            }
        })
        .collect();
    Ok(Json(RegionListResource {
        scene_revision: scene.revision,
        geometry_realization_revision: realization.realization_revision,
        regions,
    }))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/regions/{region_id}",
    params(
        ("region_id" = String, Path, description = "Object-derived region id or name")
    ),
    request_body = RegionPatchRequest,
    responses(
        (status = 200, description = "Committed canonical authoring scene after region patch", body = Value),
        (status = 404, description = "No active workspace, scene document, or region"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_region(
    State(state): State<Arc<AppState>>,
    Path(region_id): Path<String>,
    Json(req): Json<RegionPatchRequest>,
) -> Result<Json<Value>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let object = find_scene_object_for_region_mut(&mut scene, &region_id)?;
    let mut mesh_dirty = false;
    if let Some(name) = req.name {
        let name = name.trim();
        object.region_name = if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        };
        mesh_dirty = true;
    }
    if let Some(enabled) = req.enabled {
        object.visible = enabled;
        mesh_dirty = true;
    }
    if let Some(magnetization_ref) = req.magnetization_ref {
        let region_override_id = canonical_region_id_for_object(object, &region_id);
        match magnetization_ref {
            NullableStringPatchValue::Value(value) => {
                let value = value.trim();
                if value.is_empty() {
                    object.region_overrides.remove(&region_override_id);
                } else {
                    object
                        .region_overrides
                        .entry(region_override_id)
                        .or_insert_with(SceneRegionOverride::default)
                        .magnetization_ref = Some(value.to_string());
                }
            }
            NullableStringPatchValue::Null => {
                object.region_overrides.remove(&region_override_id);
            }
        }
    }
    if mesh_dirty {
        mark_object_mesh_dirty(object);
    }
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    serde_json::to_value(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/objects/{object_id}/geometry",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    request_body = ObjectGeometryPatchRequest,
    responses(
        (status = 200, description = "Committed object geometry patch", body = Value),
        (status = 400, description = "Invalid geometry patch payload"),
        (status = 404, description = "No active workspace or object not found"),
        (status = 409, description = "Base scene revision does not match current scene revision"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_object_geometry(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
    Json(req): Json<ObjectGeometryPatchRequest>,
) -> Result<Json<Value>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_object_geometry_patch(
        &mut scene,
        &object_id,
        req.base_revision,
        req.geometry,
        req.transform,
    )?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    serde_json::to_value(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/universe",
    responses(
        (status = 200, description = "Canonical authoring Universe resource", body = UniverseResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_universe(
    State(state): State<Arc<AppState>>,
) -> Result<Json<UniverseResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    build_universe_resource(&scene).map(Json)
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/universe",
    request_body = UniversePatchRequest,
    responses(
        (status = 200, description = "Committed canonical Universe resource", body = UniverseResource),
        (status = 400, description = "Invalid Universe payload"),
        (status = 404, description = "No active workspace"),
        (status = 409, description = "Base scene revision does not match current scene revision"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_universe(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UniversePatchRequest>,
) -> Result<Json<UniverseResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_universe_patch(
        &mut scene,
        req.base_revision,
        req.universe,
        req.sync_study_universe_mesh,
    )?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    build_universe_resource(&committed).map(Json)
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/universe/fit",
    request_body = UniverseFitRequest,
    responses(
        (status = 200, description = "Committed Universe fitted to realized object bounds", body = UniverseResource),
        (status = 400, description = "Scene has no realizable object bounds"),
        (status = 404, description = "No active workspace"),
        (status = 409, description = "Base scene revision does not match current scene revision"),
    ),
    tag = "model"
)]
pub async fn fit_authoring_universe(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UniverseFitRequest>,
) -> Result<Json<UniverseResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_universe_fit(
        &mut scene,
        req.base_revision,
        req.padding,
        req.minimum_size,
        req.sync_study_universe_mesh,
    )?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    build_universe_resource(&committed).map(Json)
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
    path = "/v2/sessions/current/model/magnetization-assets/{asset_id}",
    params(
        ("asset_id" = String, Path, description = "Canonical magnetization asset id")
    ),
    responses(
        (status = 200, description = "Canonical magnetization asset", body = MagnetizationAssetResource),
        (status = 404, description = "No active workspace or magnetization asset not found"),
    ),
    tag = "model"
)]
pub async fn get_authoring_magnetization_asset(
    State(state): State<Arc<AppState>>,
    Path(asset_id): Path<String>,
) -> Result<Json<MagnetizationAssetResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let asset = scene
        .magnetization_assets
        .iter()
        .find(|entry| entry.id == asset_id)
        .ok_or_else(|| ApiError::not_found(format!("magnetization asset not found: {asset_id}")))?;
    build_magnetization_asset_resource(&scene, asset).map(Json)
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/magnetization-assets/{asset_id}",
    params(
        ("asset_id" = String, Path, description = "Canonical magnetization asset id")
    ),
    request_body = MagnetizationAssetPatchRequest,
    responses(
        (status = 200, description = "Committed canonical magnetization asset", body = MagnetizationAssetResource),
        (status = 400, description = "Invalid magnetization asset payload"),
        (status = 404, description = "No active workspace or magnetization asset not found"),
        (status = 409, description = "Base scene revision does not match current scene revision"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_magnetization_asset(
    State(state): State<Arc<AppState>>,
    Path(asset_id): Path<String>,
    Json(req): Json<MagnetizationAssetPatchRequest>,
) -> Result<Json<MagnetizationAssetResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    check_base_scene_revision(&scene, req.base_revision)?;
    let asset: MagnetizationAsset =
        serde_json::from_value(Value::Object(req.asset.into_iter().collect())).map_err(
            |error| ApiError::bad_request(format!("invalid magnetization asset payload: {error}")),
        )?;
    if asset.id != asset_id {
        return Err(ApiError::bad_request(format!(
            "magnetization asset id mismatch: path '{asset_id}' payload '{}'",
            asset.id
        )));
    }
    upsert_magnetization_asset(&mut scene, asset);
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let asset = committed
        .magnetization_assets
        .iter()
        .find(|entry| entry.id == asset_id)
        .ok_or_else(|| {
            ApiError::internal(format!("committed magnetization asset missing: {asset_id}"))
        })?;
    build_magnetization_asset_resource(&committed, asset).map(Json)
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
        AuthoringTransactionRequest::PatchObjectGeometry {
            object_id,
            base_revision,
            geometry,
            transform,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_object_geometry_patch(
                &mut current_scene,
                &object_id,
                base_revision,
                geometry,
                transform,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("patch_object_geometry", committed)
        }
        AuthoringTransactionRequest::CreateObject {
            base_revision,
            object_id,
            name,
            geometry,
            transform,
            material_ref,
            region_name,
            magnetization_ref,
            material_asset,
            magnetization_asset,
            universe,
            study_universe_mesh,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_create_object_transaction(
                &mut current_scene,
                base_revision,
                object_id,
                name,
                geometry,
                transform,
                material_ref,
                region_name,
                magnetization_ref,
                material_asset,
                magnetization_asset,
                universe,
                study_universe_mesh,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("create_object", committed)
        }
        AuthoringTransactionRequest::DeleteObject {
            base_revision,
            object_id,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_delete_object_transaction(&mut current_scene, base_revision, &object_id)?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("delete_object", committed)
        }
        AuthoringTransactionRequest::RenameObject {
            base_revision,
            object_id,
            name,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_rename_object_transaction(&mut current_scene, base_revision, &object_id, name)?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("rename_object", committed)
        }
        AuthoringTransactionRequest::CommitObjectTransform {
            base_revision,
            object_id,
            transform,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_commit_object_transform_transaction(
                &mut current_scene,
                base_revision,
                &object_id,
                transform,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("commit_object_transform", committed)
        }
        AuthoringTransactionRequest::PatchUniverse {
            base_revision,
            universe,
            sync_study_universe_mesh,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_patch_universe_transaction(
                &mut current_scene,
                base_revision,
                universe,
                sync_study_universe_mesh,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("patch_universe", committed)
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

fn build_universe_resource(scene: &SceneDocument) -> Result<UniverseResource, ApiError> {
    let realization = realize_geometry_scene(scene, GeometryBackendTarget::from_scene(scene));
    Ok(UniverseResource {
        scene_revision: scene.revision,
        universe: scene
            .universe
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| {
                ApiError::internal(format!("failed to serialize universe: {error}"))
            })?,
        study_universe_mesh: scene
            .study
            .universe_mesh
            .as_ref()
            .map(serde_json::to_value)
            .transpose()
            .map_err(|error| {
                ApiError::internal(format!("failed to serialize study universe mesh: {error}"))
            })?,
        object_bounds_min: realization.bounds_min,
        object_bounds_max: realization.bounds_max,
        mesh_dirty: scene
            .objects
            .iter()
            .any(|object| object.tags.iter().any(|tag| tag == "mesh:dirty")),
    })
}

fn apply_universe_patch(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    universe_value: Value,
    sync_study_universe_mesh: bool,
) -> Result<(), ApiError> {
    apply_patch_universe_transaction(
        scene,
        base_revision,
        universe_value,
        sync_study_universe_mesh,
    )
}

fn apply_universe_fit(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    padding: Option<[f64; 3]>,
    minimum_size: Option<[f64; 3]>,
    sync_study_universe_mesh: bool,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let realization = realize_geometry_scene(scene, GeometryBackendTarget::from_scene(scene));
    let (Some(bounds_min), Some(bounds_max)) = (realization.bounds_min, realization.bounds_max)
    else {
        return Err(ApiError::bad_request(
            "scene has no realizable object bounds",
        ));
    };
    let padding = padding.unwrap_or([0.0, 0.0, 0.0]);
    let minimum_size = minimum_size.unwrap_or([0.0, 0.0, 0.0]);
    let min = [
        bounds_min[0] - padding[0],
        bounds_min[1] - padding[1],
        bounds_min[2] - padding[2],
    ];
    let max = [
        bounds_max[0] + padding[0],
        bounds_max[1] + padding[1],
        bounds_max[2] + padding[2],
    ];
    let size = [
        (max[0] - min[0]).max(minimum_size[0]),
        (max[1] - min[1]).max(minimum_size[1]),
        (max[2] - min[2]).max(minimum_size[2]),
    ];
    let center = [
        0.5 * (min[0] + max[0]),
        0.5 * (min[1] + max[1]),
        0.5 * (min[2] + max[2]),
    ];
    let mut universe = scene
        .universe
        .clone()
        .unwrap_or(ScriptBuilderUniverseState {
            mode: "box".to_string(),
            size: None,
            center: None,
            padding: None,
            airbox_hmax: None,
            airbox_hmin: None,
            airbox_growth_rate: None,
        });
    universe.mode = "box".to_string();
    universe.size = Some(size);
    universe.center = Some(center);
    universe.padding = Some(padding);
    scene.universe = Some(universe.clone());
    if sync_study_universe_mesh {
        scene.study.universe_mesh = Some(universe);
    }
    mark_all_object_meshes_dirty(scene);
    Ok(())
}

fn parse_geometry_backend_target(raw: &str) -> Result<GeometryBackendTarget, ApiError> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "fem" => Ok(GeometryBackendTarget::Fem),
        "fdm" => Ok(GeometryBackendTarget::Fdm),
        other => Err(ApiError::bad_request(format!(
            "unsupported geometry backend target: {other}"
        ))),
    }
}

fn apply_object_geometry_patch(
    scene: &mut SceneDocument,
    object_id: &str,
    base_revision: Option<u64>,
    geometry_value: Value,
    transform_value: Option<Value>,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let geometry: SceneGeometry = serde_json::from_value(geometry_value).map_err(|error| {
        ApiError::bad_request(format!("invalid object geometry payload: {error}"))
    })?;
    let transform: Option<Transform3D> = transform_value
        .map(|value| {
            serde_json::from_value(value).map_err(|error| {
                ApiError::bad_request(format!("invalid object transform payload: {error}"))
            })
        })
        .transpose()?;
    let object = find_scene_object_mut(scene, object_id)?;
    object.geometry = geometry;
    if let Some(transform) = transform {
        object.transform = transform;
    }
    mark_object_mesh_dirty(object);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_create_object_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: String,
    name: String,
    geometry_value: Value,
    transform_value: Option<Value>,
    material_ref: Option<String>,
    region_name: Option<String>,
    magnetization_ref: Option<String>,
    material_asset_value: Option<Value>,
    magnetization_asset_value: Option<Value>,
    universe_value: Option<Value>,
    study_universe_mesh_value: Option<Value>,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let object_id = object_id.trim().to_string();
    if object_id.is_empty() {
        return Err(ApiError::bad_request("object_id must not be empty"));
    }
    if scene
        .objects
        .iter()
        .any(|object| object.id == object_id || object.name == object_id)
    {
        return Err(ApiError::conflict(format!(
            "object already exists: {object_id}"
        )));
    }
    let geometry: SceneGeometry = serde_json::from_value(geometry_value).map_err(|error| {
        ApiError::bad_request(format!("invalid object geometry payload: {error}"))
    })?;
    let transform: Transform3D = transform_value
        .map(|value| {
            serde_json::from_value(value).map_err(|error| {
                ApiError::bad_request(format!("invalid object transform payload: {error}"))
            })
        })
        .transpose()?
        .unwrap_or_default();
    let material_asset: Option<SceneMaterialAsset> = material_asset_value
        .map(|value| {
            serde_json::from_value(value).map_err(|error| {
                ApiError::bad_request(format!("invalid material asset payload: {error}"))
            })
        })
        .transpose()?;
    let magnetization_asset: Option<MagnetizationAsset> = magnetization_asset_value
        .map(|value| {
            serde_json::from_value(value).map_err(|error| {
                ApiError::bad_request(format!("invalid magnetization asset payload: {error}"))
            })
        })
        .transpose()?;
    let universe: Option<ScriptBuilderUniverseState> = universe_value
        .map(|value| {
            serde_json::from_value(value).map_err(|error| {
                ApiError::bad_request(format!("invalid universe payload: {error}"))
            })
        })
        .transpose()?;
    let study_universe_mesh: Option<ScriptBuilderUniverseState> = study_universe_mesh_value
        .map(|value| {
            serde_json::from_value(value).map_err(|error| {
                ApiError::bad_request(format!("invalid study_universe_mesh payload: {error}"))
            })
        })
        .transpose()?;
    let material_ref = material_ref
        .or_else(|| material_asset.as_ref().map(|material| material.id.clone()))
        .or_else(|| scene.materials.first().map(|material| material.id.clone()))
        .unwrap_or_default();
    let magnetization_ref = magnetization_ref
        .or_else(|| magnetization_asset.as_ref().map(|asset| asset.id.clone()))
        .or_else(|| {
            scene
                .magnetization_assets
                .first()
                .map(|asset| asset.id.clone())
        });
    if let Some(material_asset) = material_asset {
        upsert_material_asset(scene, material_asset);
    }
    if let Some(magnetization_asset) = magnetization_asset {
        upsert_magnetization_asset(scene, magnetization_asset);
    }
    if let Some(universe) = universe {
        scene.universe = Some(universe);
    }
    if let Some(study_universe_mesh) = study_universe_mesh {
        scene.study.universe_mesh = Some(study_universe_mesh);
    }
    let mut object = SceneObject {
        id: object_id,
        name: name.trim().to_string(),
        geometry,
        transform,
        material_ref,
        region_name: region_name.filter(|value| !value.trim().is_empty()),
        magnetization_ref: magnetization_ref.filter(|value| !value.trim().is_empty()),
        region_overrides: Default::default(),
        physics_stack: Vec::new(),
        object_mesh: None,
        mesh_override: None,
        notes: None,
        visible: true,
        locked: false,
        tags: Vec::new(),
    };
    mark_object_mesh_dirty(&mut object);
    scene.objects.push(object);
    Ok(())
}

fn upsert_material_asset(scene: &mut SceneDocument, material: SceneMaterialAsset) {
    if let Some(existing) = scene
        .materials
        .iter_mut()
        .find(|entry| entry.id == material.id)
    {
        *existing = material;
        return;
    }
    scene.materials.push(material);
}

fn upsert_magnetization_asset(scene: &mut SceneDocument, asset: MagnetizationAsset) {
    if let Some(existing) = scene
        .magnetization_assets
        .iter_mut()
        .find(|entry| entry.id == asset.id)
    {
        *existing = asset;
        return;
    }
    scene.magnetization_assets.push(asset);
}

fn apply_delete_object_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let before = scene.objects.len();
    scene
        .objects
        .retain(|object| object.id != object_id && object.name != object_id);
    if scene.objects.len() == before {
        return Err(ApiError::not_found(format!(
            "object not found: {object_id}"
        )));
    }
    mark_all_object_meshes_dirty(scene);
    Ok(())
}

fn apply_rename_object_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    name: String,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let object = find_scene_object_mut(scene, object_id)?;
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("object name must not be empty"));
    }
    object.name = name.to_string();
    Ok(())
}

fn apply_commit_object_transform_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    transform_value: Value,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let transform: Transform3D = serde_json::from_value(transform_value).map_err(|error| {
        ApiError::bad_request(format!("invalid object transform payload: {error}"))
    })?;
    let object = find_scene_object_mut(scene, object_id)?;
    object.transform = transform;
    mark_object_mesh_dirty(object);
    Ok(())
}

fn apply_patch_universe_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    universe_value: Value,
    sync_study_universe_mesh: bool,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let universe: ScriptBuilderUniverseState = serde_json::from_value(universe_value)
        .map_err(|error| ApiError::bad_request(format!("invalid universe payload: {error}")))?;
    scene.universe = Some(universe.clone());
    if sync_study_universe_mesh {
        scene.study.universe_mesh = Some(universe);
    }
    mark_all_object_meshes_dirty(scene);
    Ok(())
}

fn apply_object_patch(
    scene: &mut SceneDocument,
    object_id: &str,
    req: ObjectPatchRequest,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, req.base_revision)?;
    let object = find_scene_object_mut(scene, object_id)?;
    let mut mesh_dirty = false;
    if let Some(name) = req.name {
        let name = name.trim();
        if name.is_empty() {
            return Err(ApiError::bad_request("object name must not be empty"));
        }
        object.name = name.to_string();
    }
    if let Some(notes) = req.notes {
        let notes = notes.trim();
        object.notes = if notes.is_empty() {
            None
        } else {
            Some(notes.to_string())
        };
    }
    if let Some(visible) = req.visible {
        object.visible = visible;
    }
    if let Some(material_ref) = req.material_ref {
        object.material_ref = material_ref;
        mesh_dirty = true;
    }
    if let Some(region_name) = req.region_name {
        let region_name = region_name.trim();
        object.region_name = if region_name.is_empty() {
            None
        } else {
            Some(region_name.to_string())
        };
        mesh_dirty = true;
    }
    if let Some(magnetization_ref) = req.magnetization_ref {
        object.magnetization_ref = if magnetization_ref.trim().is_empty() {
            None
        } else {
            Some(magnetization_ref)
        };
    }
    if let Some(geometry_value) = req.geometry {
        object.geometry = serde_json::from_value(geometry_value).map_err(|error| {
            ApiError::bad_request(format!("invalid object geometry payload: {error}"))
        })?;
        mesh_dirty = true;
    }
    if let Some(transform_value) = req.transform {
        object.transform = serde_json::from_value(transform_value).map_err(|error| {
            ApiError::bad_request(format!("invalid object transform payload: {error}"))
        })?;
        mesh_dirty = true;
    }
    if mesh_dirty {
        mark_object_mesh_dirty(object);
    }
    Ok(())
}

fn check_base_scene_revision(
    scene: &SceneDocument,
    base_revision: Option<u64>,
) -> Result<(), ApiError> {
    if let Some(base_revision) = base_revision {
        if base_revision != scene.revision {
            return Err(ApiError::conflict(format!(
                "scene revision mismatch: base={base_revision}, current={}",
                scene.revision
            )));
        }
    }
    Ok(())
}

fn find_scene_object_mut<'a>(
    scene: &'a mut SceneDocument,
    object_id: &str,
) -> Result<&'a mut SceneObject, ApiError> {
    scene
        .objects
        .iter_mut()
        .find(|entry| entry.id == object_id || entry.name == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))
}

fn find_scene_object_for_region_mut<'a>(
    scene: &'a mut SceneDocument,
    region_id: &str,
) -> Result<&'a mut SceneObject, ApiError> {
    scene
        .objects
        .iter_mut()
        .find(|entry| {
            entry.region_name.as_deref() == Some(region_id)
                || format!("region:{}", entry.id) == region_id
                || entry.id == region_id
                || entry.name == region_id
        })
        .ok_or_else(|| ApiError::not_found(format!("region not found: {region_id}")))
}

fn canonical_region_id_for_object(object: &SceneObject, requested_region_id: &str) -> String {
    let object_default_region_id = format!("region:{}", object.id);
    if object.region_name.as_deref() == Some(requested_region_id) {
        return requested_region_id.to_string();
    }
    if requested_region_id == object.id
        || requested_region_id == object.name
        || requested_region_id == object_default_region_id
    {
        return object
            .region_name
            .clone()
            .unwrap_or(object_default_region_id);
    }
    requested_region_id.to_string()
}

fn mark_object_mesh_dirty(object: &mut SceneObject) {
    if !object.tags.iter().any(|tag| tag == "mesh:dirty") {
        object.tags.push("mesh:dirty".to_string());
    }
}

fn mark_all_object_meshes_dirty(scene: &mut SceneDocument) {
    for object in &mut scene.objects {
        mark_object_mesh_dirty(object);
    }
}

fn magnetic_interaction_kind_id(kind: ScriptBuilderMagneticInteractionKind) -> &'static str {
    match kind {
        ScriptBuilderMagneticInteractionKind::Exchange => "exchange",
        ScriptBuilderMagneticInteractionKind::Demag => "demag",
        ScriptBuilderMagneticInteractionKind::InterfacialDmi => "interfacial_dmi",
        ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy => "uniaxial_anisotropy",
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

fn build_magnetization_asset_resource(
    scene: &SceneDocument,
    asset: &MagnetizationAsset,
) -> Result<MagnetizationAssetResource, ApiError> {
    let asset = serde_json::to_value(asset).map_err(|error| {
        ApiError::internal(format!("failed to serialize magnetization asset: {error}"))
    })?;
    let asset = asset.as_object().cloned().ok_or_else(|| {
        ApiError::internal("serialized magnetization asset was not a JSON object")
    })?;
    Ok(MagnetizationAssetResource {
        scene_revision: scene.revision,
        asset: asset.into_iter().collect(),
    })
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
