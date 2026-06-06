//! Authoring resource endpoints.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde_json::{Number, Value};

use crate::error::ApiError;
use crate::schemas::authoring::{
    AuthoringTransactionRequest, AuthoringTransactionResponse, CouplingListResource,
    CouplingResource, GeometryRealizationRequest, MagnetizationAssetPatchRequest,
    MagnetizationAssetResource, MaterialParameterFieldListResource, MaterialParameterFieldResource,
    MaterialPatchRequest, MaterialPropertiesResource, MaterialResource, NullableF64PatchValue,
    NullableStringPatchValue, NullableU32PatchValue, ObjectCreateRequest,
    ObjectGeometryPatchRequest, ObjectInteractionPatchRequest, ObjectInteractionResource,
    ObjectPatchRequest, ObjectRegionCreateRequest, ObjectRegionDuplicateRequest,
    ObjectRegionPatchRequest, ObjectRegionReorderRequest, RegionDiagnosticResource,
    RegionDiagnosticsResource, RegionListResource, RegionPatchRequest, RegionResource,
    ScenePatchRequest, SceneResource, StudyRuntimePatchRequest, StudyRuntimeResource,
    UniverseFitRequest, UniversePatchRequest, UniverseResource,
};
use crate::types::{AppState, ScriptSourceResponse, ScriptSyncRequest, ScriptSyncResponse};
use fullmag_authoring::{
    geometry_capabilities, realize_geometry_scene, validate_geometry_scene, GeometryBackendTarget,
    GeometryCapabilitiesResource, GeometryDiagnostic, GeometryDiagnosticsResource,
    GeometryRealizationSnapshot, GeometryRegionCandidate, GeometryValidationResource,
    MagnetizationAsset, SceneDocument, SceneGeometry, SceneMaterialAsset, SceneObject,
    SceneRegionOverride, ScriptBuilderMagneticInteractionEntry,
    ScriptBuilderMagneticInteractionKind, ScriptBuilderUniverseState, Transform3D,
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
    post,
    path = "/v2/sessions/current/model/objects/{object_id}/regions",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    request_body = ObjectRegionCreateRequest,
    responses(
        (status = 200, description = "Committed canonical scene after object region creation", body = SceneResource),
        (status = 400, description = "Invalid object region payload"),
        (status = 404, description = "No active workspace, scene document, or object"),
    ),
    tag = "model"
)]
pub async fn create_authoring_object_region(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
    Json(req): Json<ObjectRegionCreateRequest>,
) -> Result<Json<SceneResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_create_object_region_transaction(&mut scene, req.base_revision, &object_id, req.region)?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    SceneResource::from_scene_document(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/objects/{object_id}/regions/{region_id}",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id"),
        ("region_id" = String, Path, description = "Authored object region id or name")
    ),
    request_body = ObjectRegionPatchRequest,
    responses(
        (status = 200, description = "Committed canonical scene after object region patch", body = SceneResource),
        (status = 400, description = "Invalid object region patch"),
        (status = 404, description = "No active workspace, scene document, object, or region"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_object_region(
    State(state): State<Arc<AppState>>,
    Path((object_id, region_id)): Path<(String, String)>,
    Json(req): Json<ObjectRegionPatchRequest>,
) -> Result<Json<SceneResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_patch_object_region_transaction(
        &mut scene,
        req.base_revision,
        &object_id,
        &region_id,
        req.patch,
    )?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    SceneResource::from_scene_document(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/model/objects/{object_id}/regions/{region_id}",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id"),
        ("region_id" = String, Path, description = "Authored object region id or name")
    ),
    responses(
        (status = 200, description = "Committed canonical scene after object region deletion", body = SceneResource),
        (status = 404, description = "No active workspace, scene document, object, or region"),
    ),
    tag = "model"
)]
pub async fn delete_authoring_object_region(
    State(state): State<Arc<AppState>>,
    Path((object_id, region_id)): Path<(String, String)>,
) -> Result<Json<SceneResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_delete_object_region_transaction(&mut scene, None, &object_id, &region_id)?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    SceneResource::from_scene_document(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/objects/{object_id}/regions/{region_id}/duplicate",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id"),
        ("region_id" = String, Path, description = "Authored object region id or name")
    ),
    request_body = ObjectRegionDuplicateRequest,
    responses(
        (status = 200, description = "Committed canonical scene after object region duplication", body = SceneResource),
        (status = 400, description = "Invalid object region duplicate request"),
        (status = 404, description = "No active workspace, scene document, object, or region"),
    ),
    tag = "model"
)]
pub async fn duplicate_authoring_object_region(
    State(state): State<Arc<AppState>>,
    Path((object_id, region_id)): Path<(String, String)>,
    Json(req): Json<ObjectRegionDuplicateRequest>,
) -> Result<Json<SceneResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_duplicate_object_region_transaction(
        &mut scene,
        req.base_revision,
        &object_id,
        &region_id,
        req.name,
    )?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    SceneResource::from_scene_document(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/objects/{object_id}/regions/reorder",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id")
    ),
    request_body = ObjectRegionReorderRequest,
    responses(
        (status = 200, description = "Committed canonical scene after object region reorder", body = SceneResource),
        (status = 400, description = "Invalid object region reorder request"),
        (status = 404, description = "No active workspace, scene document, object, or region"),
    ),
    tag = "model"
)]
pub async fn reorder_authoring_object_regions(
    State(state): State<Arc<AppState>>,
    Path(object_id): Path<String>,
    Json(req): Json<ObjectRegionReorderRequest>,
) -> Result<Json<SceneResource>, ApiError> {
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_reorder_object_regions_transaction(
        &mut scene,
        req.base_revision,
        &object_id,
        req.region_ids,
    )?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    SceneResource::from_scene_document(committed)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/regions",
    responses(
        (status = 200, description = "Current authored object region resources", body = RegionListResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_regions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RegionListResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    Ok(Json(RegionListResource {
        scene_revision: scene.revision,
        geometry_realization_revision: scene.revision,
        regions: authored_region_resources(&scene),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/realized-regions",
    responses(
        (status = 200, description = "Current geometry-realized body region resources", body = RegionListResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_realized_regions(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RegionListResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let realization = realize_geometry_scene(&scene, GeometryBackendTarget::from_scene(&scene));
    Ok(Json(RegionListResource {
        scene_revision: scene.revision,
        geometry_realization_revision: realization.realization_revision,
        regions: realized_region_resources(&scene, realization.region_candidates),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/region-diagnostics",
    responses(
        (status = 200, description = "Current authored object region diagnostics", body = RegionDiagnosticsResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_region_diagnostics(
    State(state): State<Arc<AppState>>,
) -> Result<Json<RegionDiagnosticsResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    Ok(Json(RegionDiagnosticsResource {
        scene_revision: scene.revision,
        diagnostics: authored_region_diagnostics(&scene),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/material-fields",
    responses(
        (status = 200, description = "Current authored material parameter field resources", body = MaterialParameterFieldListResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_material_fields(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MaterialParameterFieldListResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    Ok(Json(MaterialParameterFieldListResource {
        scene_revision: scene.revision,
        fields: authored_material_field_resources(&scene),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/couplings",
    responses(
        (status = 200, description = "Current authored coupling resources", body = CouplingListResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_couplings(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CouplingListResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    Ok(Json(CouplingListResource {
        scene_revision: scene.revision,
        couplings: authored_coupling_resources(&scene),
    }))
}

fn authored_region_resources(scene: &SceneDocument) -> Vec<RegionResource> {
    scene
        .objects
        .iter()
        .flat_map(|object| {
            let fields = object
                .material_parameter_fields
                .iter()
                .filter_map(|field| material_field_resource(object, field))
                .collect::<Vec<_>>();
            let mut represented_region_ids = Vec::new();
            let mut resources = object
                .regions
                .iter()
                .filter_map(|region| {
                    let resource =
                        region_resource_for_authored_region(object, region, fields.clone())?;
                    represented_region_ids.push(resource.region_id.clone());
                    represented_region_ids
                        .push(canonical_region_id_for_object(object, &resource.region_id));
                    Some(resource)
                })
                .collect::<Vec<_>>();
            for override_region_id in object.region_overrides.keys() {
                let canonical_region_id =
                    canonical_region_id_for_object(object, override_region_id);
                if represented_region_ids.iter().any(|region_id| {
                    region_id == override_region_id || region_id == &canonical_region_id
                }) {
                    continue;
                }
                let region = serde_json::json!({
                    "region_id": override_region_id,
                    "owner_object": object.id,
                    "name": object.region_name.as_deref().unwrap_or(override_region_id.as_str()),
                });
                if let Some(resource) =
                    region_resource_for_authored_region(object, &region, fields.clone())
                {
                    resources.push(resource);
                }
            }
            resources
        })
        .collect()
}

fn realized_region_resources(
    scene: &SceneDocument,
    candidates: Vec<GeometryRegionCandidate>,
) -> Vec<RegionResource> {
    candidates
        .into_iter()
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
                region_id: candidate.id,
                name,
                source: "realized_geometry_region".to_string(),
                region_kind: Some("realized_body_region".to_string()),
                owner_object_id: Some(candidate.object_id.clone()),
                owner_path: Some(candidate.source_geometry_path.clone()),
                source_object_ids: vec![candidate.object_id],
                source_body_ids: candidate.source_body_ids,
                priority: None,
                frame: None,
                shape: None,
                mesh_policy: None,
                material_overrides: Vec::new(),
                material_parameter_fields: Vec::new(),
                texture_override: None,
                realization_policy: None,
                realization_status: Some("realized".to_string()),
                material_ref: candidate.material_ref,
                magnetization_ref: candidate.magnetization_ref,
                interaction_refs,
                mesh_part_ids: Vec::new(),
                enabled: object.map(|object| object.visible).unwrap_or(true),
                bounds_min: candidate.bounds_min,
                bounds_max: candidate.bounds_max,
            }
        })
        .collect()
}

fn authored_region_diagnostics(scene: &SceneDocument) -> Vec<RegionDiagnosticResource> {
    let mut diagnostics = Vec::new();
    for region in authored_region_resources(scene) {
        let owner = region
            .owner_object_id
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        if region.source == "authored_object_region" {
            diagnostics.push(RegionDiagnosticResource {
                diagnostic_id: format!("region:{}:pending-realization", region.region_id),
                severity: "info".to_string(),
                code: "authored_region_pending_realization".to_string(),
                message: "Authored region is present in the canonical model; realized mesh/material region data will be produced by a compatible mesh/materialization path.".to_string(),
                region_id: region.region_id.clone(),
                owner_object_id: owner.clone(),
                realization_status: region.realization_status.clone(),
                capability_gate: Some("regions.realized_materialization".to_string()),
            });
        }
        if region.mesh_policy.is_some() {
            diagnostics.push(RegionDiagnosticResource {
                diagnostic_id: format!("region:{}:mesh-policy-pending", region.region_id),
                severity: "warning".to_string(),
                code: "region_mesh_policy_requires_rebuild".to_string(),
                message: "Region mesh policy is authored but not applied to the currently realized mesh until a compatible mesh rebuild/materialization path runs.".to_string(),
                region_id: region.region_id.clone(),
                owner_object_id: owner.clone(),
                realization_status: region.realization_status.clone(),
                capability_gate: Some("regions.mesh_policy".to_string()),
            });
        }
        if !region.material_overrides.is_empty() || !region.material_parameter_fields.is_empty() {
            diagnostics.push(RegionDiagnosticResource {
                diagnostic_id: format!("region:{}:material-pending", region.region_id),
                severity: "warning".to_string(),
                code: "region_material_realization_pending".to_string(),
                message: "Region material override or material field is authored; planner/runtime must materialize it or block execution rather than silently dropping it.".to_string(),
                region_id: region.region_id.clone(),
                owner_object_id: owner.clone(),
                realization_status: region.realization_status.clone(),
                capability_gate: Some("regions.material_override".to_string()),
            });
        }
        if region
            .realization_policy
            .as_deref()
            .is_some_and(|policy| matches!(policy, "conformal" | "project" | "projected"))
        {
            diagnostics.push(RegionDiagnosticResource {
                diagnostic_id: format!("region:{}:explicit-realization-policy", region.region_id),
                severity: "warning".to_string(),
                code: "region_realization_policy_capability_gated".to_string(),
                message: "Region requests an explicit realization policy; execution must prove conformal/projected realization or fail with a capability diagnostic.".to_string(),
                region_id: region.region_id.clone(),
                owner_object_id: owner,
                realization_status: region.realization_status,
                capability_gate: Some("regions.conformal_or_projected_boundary".to_string()),
            });
        }
    }
    diagnostics
}

fn region_resource_for_authored_region(
    object: &SceneObject,
    region: &Value,
    material_fields: Vec<MaterialParameterFieldResource>,
) -> Option<RegionResource> {
    let map = region.as_object()?;
    let region_id = value_string(map.get("region_id")).unwrap_or_else(|| {
        let name = value_string(map.get("name")).unwrap_or_else(|| "region".to_string());
        format!("{}:{name}", object.id)
    });
    let name = value_string(map.get("name")).unwrap_or_else(|| region_id.clone());
    let owner_object = value_string(map.get("owner_object")).unwrap_or_else(|| object.id.clone());
    let region_fields = material_fields
        .into_iter()
        .filter(|field| field.source_region_id.as_deref() == Some(region_id.as_str()))
        .map(|field| serde_json::to_value(field).unwrap_or_else(|_| Value::Null))
        .filter(|value| !value.is_null())
        .collect::<Vec<_>>();
    let canonical_region_id = canonical_region_id_for_object(object, &region_id);
    let magnetization_ref = object
        .region_overrides
        .get(&region_id)
        .or_else(|| object.region_overrides.get(&canonical_region_id))
        .and_then(|override_entry| override_entry.magnetization_ref.clone())
        .or_else(|| value_string(map.get("magnetization_ref")));
    Some(RegionResource {
        region_id: region_id.clone(),
        name,
        source: "authored_object_region".to_string(),
        region_kind: Some("object_region".to_string()),
        owner_object_id: Some(owner_object.clone()),
        owner_path: Some(format!("{owner_object}/{region_id}")),
        source_object_ids: vec![owner_object],
        source_body_ids: Vec::new(),
        priority: value_i64(map.get("priority")),
        frame: value_string(map.get("frame")),
        shape: map.get("shape").cloned(),
        mesh_policy: map.get("mesh_policy").cloned(),
        material_overrides: value_array(map.get("material_overrides")),
        material_parameter_fields: region_fields,
        texture_override: map.get("texture_override").cloned(),
        realization_policy: value_string(map.get("realization_policy")),
        realization_status: Some("authored_pending_realization".to_string()),
        material_ref: object.material_ref.clone(),
        magnetization_ref,
        interaction_refs: object
            .physics_stack
            .iter()
            .map(|entry| magnetic_interaction_kind_id(entry.kind).to_string())
            .collect(),
        mesh_part_ids: Vec::new(),
        enabled: value_bool(map.get("enabled")).unwrap_or(true) && object.visible,
        bounds_min: object.geometry.bounds_min.unwrap_or([0.0; 3]),
        bounds_max: object.geometry.bounds_max.unwrap_or([0.0; 3]),
    })
}

fn authored_material_field_resources(scene: &SceneDocument) -> Vec<MaterialParameterFieldResource> {
    scene
        .objects
        .iter()
        .flat_map(|object| {
            object
                .material_parameter_fields
                .iter()
                .filter_map(|field| material_field_resource(object, field))
        })
        .collect()
}

fn material_field_resource(
    object: &SceneObject,
    field: &Value,
) -> Option<MaterialParameterFieldResource> {
    let map = field.as_object()?;
    let assignment_id = value_string(map.get("assignment_id")).unwrap_or_else(|| {
        let parameter =
            value_string(map.get("parameter")).unwrap_or_else(|| "parameter".to_string());
        format!("{}:{parameter}:field", object.id)
    });
    let owner_object = value_string(map.get("owner_object")).unwrap_or_else(|| object.id.clone());
    let parameter = value_string(map.get("parameter"))?;
    let value = map.get("value").cloned().unwrap_or(Value::Null);
    Some(MaterialParameterFieldResource {
        assignment_id,
        owner_object_id: owner_object.clone(),
        owner_path: Some(owner_object),
        parameter,
        source_region_id: value_string(map.get("region_id")),
        priority: value_i64(map.get("priority")),
        unit: value
            .as_object()
            .and_then(|value_map| value_string(value_map.get("unit"))),
        frame: value
            .as_object()
            .and_then(|value_map| value_string(value_map.get("frame"))),
        location: value
            .as_object()
            .and_then(|value_map| value_string(value_map.get("location"))),
        field: value,
        realization_status: Some("authored_pending_realization".to_string()),
    })
}

fn authored_coupling_resources(scene: &SceneDocument) -> Vec<CouplingResource> {
    scene
        .couplings
        .iter()
        .filter_map(|coupling| {
            let map = coupling.as_object()?;
            let coupling_id = value_string(map.get("coupling_id"))?;
            let kind = value_string(map.get("kind"))?;
            Some(CouplingResource {
                coupling_id,
                coupling_kind: kind.clone(),
                enabled: value_bool(map.get("enabled")).unwrap_or(true),
                source: map.get("source").cloned().unwrap_or(Value::Null),
                target: map.get("target").cloned().unwrap_or(Value::Null),
                params: map
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({ "kind": kind })),
                capability_policy: value_string(map.get("capability_policy")),
                realization_status: Some(coupling_realization_status(&kind).to_string()),
            })
        })
        .collect()
}

fn coupling_realization_status(kind: &str) -> &'static str {
    match kind {
        "rkky" | "interlayer_exchange" => "requires_runtime_capability",
        _ => "authored_pending_realization",
    }
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn value_bool(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

fn value_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

fn value_f64(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn value_vec3(value: Option<&Value>) -> Option<[f64; 3]> {
    let values = value.and_then(Value::as_array)?;
    if values.len() != 3 {
        return None;
    }
    let resolved = [
        values[0].as_f64()?,
        values[1].as_f64()?,
        values[2].as_f64()?,
    ];
    resolved
        .iter()
        .all(|value| value.is_finite())
        .then_some(resolved)
}

fn value_array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
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
    if let Some(name) = req.name {
        let name = name.trim();
        object.region_name = if name.is_empty() {
            None
        } else {
            Some(name.to_string())
        };
    }
    if let Some(enabled) = req.enabled {
        object.visible = enabled;
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
        if let Some(value) = properties.dbulk {
            material.properties.dbulk = match value {
                NullableF64PatchValue::Value(value) => Some(value),
                NullableF64PatchValue::Null => None,
            };
        }
    }

    sync_interfacial_dmi_for_material(&mut scene, &material_id);
    sync_bulk_dmi_for_material(&mut scene, &material_id);

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
    let material_dbulk = material_dbulk_for_object(&scene, &object_id);
    let object = scene
        .objects
        .iter_mut()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;

    apply_interaction_patch(object, kind, material_dind, material_dbulk, req)?;

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
        AuthoringTransactionRequest::CreateObjectRegion {
            base_revision,
            object_id,
            region,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_create_object_region_transaction(
                &mut current_scene,
                base_revision,
                &object_id,
                region,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("create_object_region", committed)
        }
        AuthoringTransactionRequest::PatchObjectRegion {
            base_revision,
            object_id,
            region_id,
            patch,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_patch_object_region_transaction(
                &mut current_scene,
                base_revision,
                &object_id,
                &region_id,
                patch,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("patch_object_region", committed)
        }
        AuthoringTransactionRequest::DeleteObjectRegion {
            base_revision,
            object_id,
            region_id,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_delete_object_region_transaction(
                &mut current_scene,
                base_revision,
                &object_id,
                &region_id,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("delete_object_region", committed)
        }
        AuthoringTransactionRequest::ReorderObjectRegions {
            base_revision,
            object_id,
            region_ids,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_reorder_object_regions_transaction(
                &mut current_scene,
                base_revision,
                &object_id,
                region_ids,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("reorder_object_regions", committed)
        }
        AuthoringTransactionRequest::CreateCoupling {
            base_revision,
            coupling,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_create_coupling_transaction(&mut current_scene, base_revision, coupling)?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("create_coupling", committed)
        }
        AuthoringTransactionRequest::PatchCoupling {
            base_revision,
            coupling_id,
            patch,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_patch_coupling_transaction(
                &mut current_scene,
                base_revision,
                &coupling_id,
                patch,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("patch_coupling", committed)
        }
        AuthoringTransactionRequest::DeleteCoupling {
            base_revision,
            coupling_id,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_delete_coupling_transaction(&mut current_scene, base_revision, &coupling_id)?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("delete_coupling", committed)
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
            airbox_grading: None,
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
        regions: Vec::new(),
        allocated_region_ids: Vec::new(),
        material_parameter_fields: Vec::new(),
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

fn apply_create_object_region_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    mut region: Value,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let object = find_scene_object_mut(scene, object_id)?;
    let region_name = value_string(region.get("name"))
        .ok_or_else(|| ApiError::bad_request("object region requires name"))?;
    let region_id = allocate_object_region_id(object);
    if object.regions.iter().any(|entry| {
        value_id(entry, &["region_id", "id"]).as_deref() == Some(region_id.as_str())
            || value_string(entry.get("name")).as_deref() == Some(region_name.as_str())
    }) {
        return Err(ApiError::conflict(format!(
            "object region already exists: {region_name}"
        )));
    }
    if let Some(map) = region.as_object_mut() {
        map.remove("id");
        map.insert("region_id".to_string(), Value::String(region_id));
        map.insert("owner_object".to_string(), Value::String(object.id.clone()));
    } else {
        return Err(ApiError::bad_request(
            "object region payload must be an object",
        ));
    }
    clamp_object_region_shape_to_owner(object, &mut region);
    object.regions.push(region);
    Ok(())
}

fn apply_patch_object_region_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    region_id: &str,
    patch: Value,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    reject_object_region_identity_patch(&patch)?;
    if value_bool(patch.get("enabled")) == Some(false) {
        ensure_region_has_no_active_couplings(scene, object_id, region_id)?;
    }
    let object = find_scene_object_mut(scene, object_id)?;
    if let Some(region_name) = value_string(patch.get("name")) {
        if object.regions.iter().any(|entry| {
            !value_matches_id(entry, region_id, &["region_id", "id", "name"])
                && value_string(entry.get("name")).as_deref() == Some(region_name.as_str())
        }) {
            return Err(ApiError::conflict(format!(
                "object region already exists: {region_name}"
            )));
        }
    }
    let owner_bounds = object_region_owner_bounds(object);
    let region = find_object_region_mut(object, region_id)?;
    merge_patch_value(region, &patch);
    clamp_object_region_shape_to_owner_bounds(owner_bounds, region);
    Ok(())
}

fn apply_delete_object_region_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    region_id: &str,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let object = find_scene_object_mut(scene, object_id)?;
    let before = object.regions.len();
    object
        .regions
        .retain(|entry| !value_matches_id(entry, region_id, &["region_id", "id", "name"]));
    if object.regions.len() == before {
        return Err(ApiError::not_found(format!(
            "object region not found: {region_id}"
        )));
    }
    object
        .material_parameter_fields
        .retain(|field| value_string(field.get("region_id")).as_deref() != Some(region_id));
    scene
        .couplings
        .retain(|coupling| !coupling_references_region(coupling, object_id, region_id));
    Ok(())
}

fn apply_duplicate_object_region_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    region_id: &str,
    requested_name: Option<String>,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let object = find_scene_object_mut(scene, object_id)?;
    let source = object
        .regions
        .iter()
        .find(|entry| value_matches_id(entry, region_id, &["region_id", "id", "name"]))
        .cloned()
        .ok_or_else(|| ApiError::not_found(format!("object region not found: {region_id}")))?;
    let source_name = value_string(source.get("name"))
        .ok_or_else(|| ApiError::bad_request("source object region has no name"))?;
    let duplicate_name = requested_name
        .as_deref()
        .and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .unwrap_or_else(|| allocate_object_region_name(object, &source_name));
    if object
        .regions
        .iter()
        .any(|entry| value_string(entry.get("name")).as_deref() == Some(duplicate_name.as_str()))
    {
        return Err(ApiError::conflict(format!(
            "object region already exists: {duplicate_name}"
        )));
    }
    let duplicate_region_id = allocate_object_region_id(object);
    let mut duplicate = source;
    if let Some(map) = duplicate.as_object_mut() {
        map.insert("name".to_string(), Value::String(duplicate_name));
        map.insert("region_id".to_string(), Value::String(duplicate_region_id));
        map.insert("owner_object".to_string(), Value::String(object.id.clone()));
        map.remove("id");
    } else {
        return Err(ApiError::bad_request(
            "object region payload must be an object",
        ));
    }
    clamp_object_region_shape_to_owner(object, &mut duplicate);
    object.regions.push(duplicate);
    Ok(())
}

fn apply_reorder_object_regions_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    region_ids: Vec<String>,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let object = find_scene_object_mut(scene, object_id)?;
    if region_ids.len() != object.regions.len() {
        return Err(ApiError::bad_request(
            "region_ids must include every existing object region exactly once",
        ));
    }
    let mut reordered = Vec::with_capacity(object.regions.len());
    for region_id in region_ids {
        let index = object
            .regions
            .iter()
            .position(|entry| value_matches_id(entry, &region_id, &["region_id", "id", "name"]))
            .ok_or_else(|| ApiError::bad_request(format!("unknown region id: {region_id}")))?;
        reordered.push(object.regions.remove(index));
    }
    if !object.regions.is_empty() {
        return Err(ApiError::bad_request(
            "region_ids must include every existing object region exactly once",
        ));
    }
    object.regions = reordered;
    Ok(())
}

fn apply_create_coupling_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    coupling: Value,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let coupling_id = value_id(&coupling, &["coupling_id", "id"])
        .ok_or_else(|| ApiError::bad_request("coupling requires coupling_id"))?;
    if scene
        .couplings
        .iter()
        .any(|entry| value_matches_id(entry, &coupling_id, &["coupling_id", "id"]))
    {
        return Err(ApiError::conflict(format!(
            "coupling already exists: {coupling_id}"
        )));
    }
    if !coupling.is_object() {
        return Err(ApiError::bad_request("coupling payload must be an object"));
    }
    ensure_active_coupling_targets_enabled_regions(scene, &coupling)?;
    scene.couplings.push(coupling);
    Ok(())
}

fn apply_patch_coupling_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    coupling_id: &str,
    patch: Value,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let coupling_index = scene
        .couplings
        .iter()
        .position(|entry| value_matches_id(entry, coupling_id, &["coupling_id", "id"]))
        .ok_or_else(|| ApiError::not_found(format!("coupling not found: {coupling_id}")))?;
    let mut patched = scene.couplings[coupling_index].clone();
    merge_patch_value(&mut patched, &patch);
    ensure_active_coupling_targets_enabled_regions(scene, &patched)?;
    scene.couplings[coupling_index] = patched;
    Ok(())
}

fn apply_delete_coupling_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    coupling_id: &str,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let before = scene.couplings.len();
    scene
        .couplings
        .retain(|entry| !value_matches_id(entry, coupling_id, &["coupling_id", "id"]));
    if scene.couplings.len() == before {
        return Err(ApiError::not_found(format!(
            "coupling not found: {coupling_id}"
        )));
    }
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

fn find_object_region_mut<'a>(
    object: &'a mut SceneObject,
    region_id: &str,
) -> Result<&'a mut Value, ApiError> {
    object
        .regions
        .iter_mut()
        .find(|entry| value_matches_id(entry, region_id, &["region_id", "id", "name"]))
        .ok_or_else(|| ApiError::not_found(format!("object region not found: {region_id}")))
}

#[derive(Clone, Copy)]
struct ObjectRegionOwnerBounds {
    center: [f64; 3],
    size: [f64; 3],
}

fn clamp_object_region_shape_to_owner(object: &SceneObject, region: &mut Value) {
    clamp_object_region_shape_to_owner_bounds(object_region_owner_bounds(object), region);
}

fn clamp_object_region_shape_to_owner_bounds(
    owner_bounds: Option<ObjectRegionOwnerBounds>,
    region: &mut Value,
) {
    let Some(owner_bounds) = owner_bounds else {
        return;
    };
    let Some(region_map) = region.as_object_mut() else {
        return;
    };
    let Some(shape) = region_map.get_mut("shape") else {
        return;
    };
    clamp_shape_value_to_owner_bounds(shape, owner_bounds);
}

fn object_region_owner_bounds(object: &SceneObject) -> Option<ObjectRegionOwnerBounds> {
    if let Some(bounds) =
        owner_bounds_from_min_max(object.geometry.bounds_min, object.geometry.bounds_max)
    {
        return Some(bounds);
    }
    let params = object.geometry.geometry_params.as_object()?;
    let center = value_vec3(params.get("center")).unwrap_or([0.0, 0.0, 0.0]);
    let size = match object.geometry.geometry_kind.as_str() {
        "Box" => value_vec3(params.get("size")),
        "Cylinder" => {
            let radius = value_f64(params.get("radius"))?;
            let height = value_f64(params.get("height"))?;
            Some([radius * 2.0, radius * 2.0, height])
        }
        "ArchWaveguide" => {
            let length = value_f64(params.get("length"))?;
            let width = value_f64(params.get("width"))?;
            let height = value_f64(params.get("height"))?;
            Some([length, width, height])
        }
        _ => None,
    }?;
    owner_bounds_from_center_size(center, size)
}

fn owner_bounds_from_min_max(
    min: Option<[f64; 3]>,
    max: Option<[f64; 3]>,
) -> Option<ObjectRegionOwnerBounds> {
    let min = min?;
    let max = max?;
    owner_bounds_from_center_size(
        [
            (min[0] + max[0]) * 0.5,
            (min[1] + max[1]) * 0.5,
            (min[2] + max[2]) * 0.5,
        ],
        [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    )
}

fn owner_bounds_from_center_size(
    center: [f64; 3],
    size: [f64; 3],
) -> Option<ObjectRegionOwnerBounds> {
    center
        .iter()
        .chain(size.iter())
        .all(|value| value.is_finite())
        .then_some(())?;
    size.iter().all(|value| *value > 0.0).then_some(())?;
    Some(ObjectRegionOwnerBounds { center, size })
}

fn clamp_shape_value_to_owner_bounds(shape: &mut Value, owner_bounds: ObjectRegionOwnerBounds) {
    let Some(shape_map) = shape.as_object_mut() else {
        return;
    };
    let Some(kind) = value_string(shape_map.get("kind")) else {
        return;
    };
    let center = value_vec3(shape_map.get("center")).unwrap_or(owner_bounds.center);
    match kind.as_str() {
        "box" => {
            let size = value_vec3(shape_map.get("size")).unwrap_or(owner_bounds.size);
            let half_extents = [
                clamp_f64(size[0].max(0.0), 0.0, owner_bounds.size[0]) * 0.5,
                clamp_f64(size[1].max(0.0), 0.0, owner_bounds.size[1]) * 0.5,
                clamp_f64(size[2].max(0.0), 0.0, owner_bounds.size[2]) * 0.5,
            ];
            shape_map.insert(
                "center".to_string(),
                vec3_value(clamp_center_to_owner(center, half_extents, owner_bounds)),
            );
            shape_map.insert(
                "size".to_string(),
                vec3_value([
                    half_extents[0] * 2.0,
                    half_extents[1] * 2.0,
                    half_extents[2] * 2.0,
                ]),
            );
        }
        "sphere" => {
            let radius = clamp_f64(
                value_f64(shape_map.get("radius")).unwrap_or(owner_bounds.size[0] * 0.5),
                0.0,
                owner_bounds
                    .size
                    .iter()
                    .copied()
                    .fold(f64::INFINITY, f64::min)
                    * 0.5,
            );
            let half_extents = [radius, radius, radius];
            shape_map.insert(
                "center".to_string(),
                vec3_value(clamp_center_to_owner(center, half_extents, owner_bounds)),
            );
            shape_map.insert("radius".to_string(), f64_value(radius));
        }
        "cylinder" => {
            let axis = value_vec3(shape_map.get("axis")).unwrap_or([0.0, 0.0, 1.0]);
            let dominant_axis = dominant_axis_index(axis);
            let radial_axes = match dominant_axis {
                0 => [1, 2],
                1 => [0, 2],
                _ => [0, 1],
            };
            let radius = clamp_f64(
                value_f64(shape_map.get("radius"))
                    .unwrap_or(owner_bounds.size[radial_axes[0]] * 0.25),
                0.0,
                owner_bounds.size[radial_axes[0]].min(owner_bounds.size[radial_axes[1]]) * 0.5,
            );
            let height = clamp_f64(
                value_f64(shape_map.get("height")).unwrap_or(owner_bounds.size[dominant_axis]),
                0.0,
                owner_bounds.size[dominant_axis],
            );
            let mut half_extents = [radius, radius, radius];
            half_extents[dominant_axis] = height * 0.5;
            shape_map.insert(
                "center".to_string(),
                vec3_value(clamp_center_to_owner(center, half_extents, owner_bounds)),
            );
            shape_map.insert("height".to_string(), f64_value(height));
            shape_map.insert("radius".to_string(), f64_value(radius));
        }
        _ => {}
    }
}

fn clamp_center_to_owner(
    center: [f64; 3],
    half_extents: [f64; 3],
    owner_bounds: ObjectRegionOwnerBounds,
) -> [f64; 3] {
    [0, 1, 2].map(|axis| {
        let min = owner_bounds.center[axis] - owner_bounds.size[axis] * 0.5 + half_extents[axis];
        let max = owner_bounds.center[axis] + owner_bounds.size[axis] * 0.5 - half_extents[axis];
        if min <= max {
            clamp_f64(center[axis], min, max)
        } else {
            owner_bounds.center[axis]
        }
    })
}

fn dominant_axis_index(axis: [f64; 3]) -> usize {
    let abs = [axis[0].abs(), axis[1].abs(), axis[2].abs()];
    if abs[0] >= abs[1] && abs[0] >= abs[2] {
        0
    } else if abs[1] >= abs[2] {
        1
    } else {
        2
    }
}

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

fn vec3_value(value: [f64; 3]) -> Value {
    Value::Array(value.into_iter().map(f64_value).collect())
}

fn f64_value(value: f64) -> Value {
    Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

fn reject_object_region_identity_patch(patch: &Value) -> Result<(), ApiError> {
    let Some(map) = patch.as_object() else {
        return Err(ApiError::bad_request(
            "object region patch payload must be an object",
        ));
    };
    for key in ["region_id", "id", "owner_object"] {
        if map.contains_key(key) {
            return Err(ApiError::bad_request(format!(
                "object region patch cannot modify {key}"
            )));
        }
    }
    Ok(())
}

fn allocate_object_region_id(object: &mut SceneObject) -> String {
    seed_allocated_region_ids(object);
    let owner = if object.id.trim().is_empty() {
        object.name.as_str()
    } else {
        object.id.as_str()
    };
    let mut suffix = 1_u64;
    let mut candidate = format!("{owner}:r{suffix}");
    while object
        .allocated_region_ids
        .iter()
        .any(|existing| existing == &candidate)
    {
        suffix += 1;
        candidate = format!("{owner}:r{suffix}");
    }
    object.allocated_region_ids.push(candidate.clone());
    candidate
}

fn allocate_object_region_name(object: &SceneObject, source_name: &str) -> String {
    let source_name = source_name.trim();
    let base = if source_name.is_empty() {
        "region copy".to_string()
    } else {
        format!("{source_name} copy")
    };
    let mut candidate = base.clone();
    let mut suffix = 2_u64;
    while object
        .regions
        .iter()
        .any(|entry| value_string(entry.get("name")).as_deref() == Some(candidate.as_str()))
    {
        candidate = format!("{base} {suffix}");
        suffix += 1;
    }
    candidate
}

fn seed_allocated_region_ids(object: &mut SceneObject) {
    let existing_ids: Vec<String> = object
        .regions
        .iter()
        .filter_map(|region| value_id(region, &["region_id", "id"]))
        .collect();
    for region_id in existing_ids {
        if !object
            .allocated_region_ids
            .iter()
            .any(|existing| existing == &region_id)
        {
            object.allocated_region_ids.push(region_id);
        }
    }
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

fn value_id(value: &Value, fields: &[&str]) -> Option<String> {
    fields
        .iter()
        .find_map(|field| value_string(value.get(*field)))
}

fn value_matches_id(value: &Value, requested_id: &str, fields: &[&str]) -> bool {
    value_id(value, fields).as_deref() == Some(requested_id)
}

fn coupling_references_region(coupling: &Value, object_id: &str, region_id: &str) -> bool {
    ["source", "target"].iter().any(|field| {
        coupling
            .get(*field)
            .is_some_and(|endpoint| endpoint_references_region(endpoint, object_id, region_id))
    })
}

fn ensure_region_has_no_active_couplings(
    scene: &SceneDocument,
    object_id: &str,
    region_id: &str,
) -> Result<(), ApiError> {
    if let Some(coupling_id) = scene
        .couplings
        .iter()
        .filter(|coupling| value_bool(coupling.get("enabled")).unwrap_or(true))
        .find(|coupling| coupling_references_region(coupling, object_id, region_id))
        .and_then(|coupling| value_id(coupling, &["coupling_id", "id"]))
    {
        return Err(ApiError::conflict(format!(
            "object region '{region_id}' is referenced by active coupling '{coupling_id}'; disable or delete the coupling before disabling the region"
        )));
    }
    Ok(())
}

fn ensure_active_coupling_targets_enabled_regions(
    scene: &SceneDocument,
    coupling: &Value,
) -> Result<(), ApiError> {
    if !value_bool(coupling.get("enabled")).unwrap_or(true) {
        return Ok(());
    }
    for field in ["source", "target"] {
        let Some(endpoint) = coupling.get(field) else {
            continue;
        };
        let Some((object_id, region_id)) = endpoint_region_ref(endpoint) else {
            continue;
        };
        if scene.objects.iter().any(|object| {
            object.id == object_id
                && object.regions.iter().any(|region| {
                    value_matches_id(region, &region_id, &["region_id", "id", "name"])
                        && !value_bool(region.get("enabled")).unwrap_or(true)
                })
        }) {
            let coupling_id = value_id(coupling, &["coupling_id", "id"])
                .unwrap_or_else(|| "coupling".to_string());
            return Err(ApiError::conflict(format!(
                "coupling '{coupling_id}' {field}.region_id '{region_id}' references disabled object_region"
            )));
        }
    }
    Ok(())
}

fn endpoint_region_ref(endpoint: &Value) -> Option<(String, String)> {
    if value_string(endpoint.get("kind")).as_deref() != Some("region") {
        return None;
    }
    Some((
        value_string(endpoint.get("object"))?,
        value_string(endpoint.get("region_id"))?,
    ))
}

fn endpoint_references_region(endpoint: &Value, object_id: &str, region_id: &str) -> bool {
    value_string(endpoint.get("kind")).as_deref() == Some("region")
        && value_string(endpoint.get("object")).as_deref() == Some(object_id)
        && value_string(endpoint.get("region_id")).as_deref() == Some(region_id)
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
        ScriptBuilderMagneticInteractionKind::BulkDmi => "bulk_dmi",
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
            dbulk: material.properties.dbulk,
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

fn sync_bulk_dmi_for_material(scene: &mut SceneDocument, material_id: &str) {
    let material_dbulk = scene
        .materials
        .iter()
        .find(|entry| entry.id == material_id)
        .and_then(|entry| entry.properties.dbulk)
        .unwrap_or(0.0);
    for object in &mut scene.objects {
        if object.material_ref != material_id {
            continue;
        }
        if let Some(interaction) = object
            .physics_stack
            .iter_mut()
            .find(|entry| entry.kind == ScriptBuilderMagneticInteractionKind::BulkDmi)
        {
            let mut params = match interaction.params.clone() {
                Some(Value::Object(map)) => map,
                _ => Default::default(),
            };
            params.insert("dbulk".to_string(), Value::from(material_dbulk));
            interaction.params = Some(Value::Object(params));
        }
    }
}

fn parse_interaction_kind(raw: &str) -> Result<ScriptBuilderMagneticInteractionKind, ApiError> {
    match raw {
        "exchange" => Ok(ScriptBuilderMagneticInteractionKind::Exchange),
        "demag" => Ok(ScriptBuilderMagneticInteractionKind::Demag),
        "interfacial_dmi" => Ok(ScriptBuilderMagneticInteractionKind::InterfacialDmi),
        "bulk_dmi" => Ok(ScriptBuilderMagneticInteractionKind::BulkDmi),
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
        ScriptBuilderMagneticInteractionKind::BulkDmi => "bulk_dmi",
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

fn material_dbulk_for_object(scene: &SceneDocument, object_id: &str) -> Option<f64> {
    let object = scene.objects.iter().find(|entry| entry.id == object_id)?;
    scene
        .materials
        .iter()
        .find(|entry| entry.id == object.material_ref)
        .and_then(|entry| entry.properties.dbulk)
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
    material_dbulk: Option<f64>,
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
        ScriptBuilderMagneticInteractionKind::BulkDmi => Value::Object(
            [(
                "dbulk".to_string(),
                Value::from(material_dbulk.unwrap_or(1e-3)),
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
