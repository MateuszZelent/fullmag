//! Authoring resource endpoints.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::router_v2::handlers::transport_authoring_policy::candidate_capability;
use crate::router_v2::handlers::data::field_resolution::flatten_json_field_values;
use crate::schemas::authoring::{
    AuthoringTransactionRequest, AuthoringTransactionResponse, CouplingCreateRequest,
    CouplingDeleteRequest, CouplingEndpointResolutionResource, CouplingListResource,
    CouplingPatchRequest, CouplingResource, CurrentTransportCommitResource,
    CurrentTransportListResource, CurrentTransportMutationRequest, FieldDriveCreateRequest,
    FieldDriveDeleteRequest, FieldDriveListResource, FieldDriveReplaceRequest,
    GeometryRealizationRequest, MagnetizationAssetPatchRequest, MagnetizationAssetResource,
    MaskFieldDriveCreateRequest, MaskFieldDriveListResource, MaskFieldDriveReplaceRequest,
    MaskFieldDriveResource, MaskTermResource, ReadyAntennaListResource, ReadyAntennaTermsRequest,
    ReadyAntennaTermsResource,
    MaterialParameterFieldListResource, MaterialParameterFieldResource, MaterialPatchRequest,
    MagnetizationApplyRequest, MagnetizationApplyScope, MagnetizationApplyTarget,
    MaterialPropertiesResource, MaterialReferenceResource, MaterialResource, NullableF64PatchValue,
    NullableParallelExecutionPatchValue, NullableStringPatchValue, NullableU32PatchValue,
    ObjectCreateRequest,
    ObjectGeometryPatchRequest, ObjectInteractionPatchRequest, ObjectInteractionResource,
    ObjectPatchRequest, ObjectRegionCreateRequest, ObjectRegionDuplicateRequest,
    ObjectRegionPatchRequest, ObjectRegionReorderRequest, OerstedFieldCommitResource,
    OerstedFieldListResource, OerstedFieldMutationRequest, RegionDiagnosticResource,
    RegionDiagnosticsResource, RegionListResource, RegionPatchRequest, RegionResource,
    RegionalFieldDriveResource, SceneCouplingPatch, ScenePatchRequest, SceneResource,
    SpinAuthoringDeleteRequest, SpinInterfaceListResource, SpinInterfaceProjectionItem,
    SpinTorqueCommitResource, SpinTorqueListResource, SpinTorqueMutationRequest,
    SpinTransportCommitResource, SpinTransportListResource, SpinTransportMutationRequest,
    StudyRuntimePatchRequest, StudyRuntimeResource, TransportAuthoringOperation,
    TransportExecutionCapability, TransportSemanticValidation,
    TransportValidationCandidate, TransportValidationIssue, TransportValidationRequest,
    TransportValidationResponse, UniverseFitRequest, UniversePatchRequest, UniverseResource,
};
use crate::types::{
    AppState, LatestFields, ScriptSourceResponse, ScriptSyncRequest, ScriptSyncResponse,
};
use fullmag_authoring::{
    geometry_capabilities, realize_geometry_scene, validate_geometry_scene,
    GeometryBackendTarget, GeometryCapabilitiesResource, GeometryDiagnostic,
    GeometryDiagnosticsResource, GeometryRealizationSnapshot, GeometryRegionCandidate,
    GeometryValidationResource, MagnetizationAsset, SceneCurrentTransport, SceneDocument,
    SceneGeometry, SceneMaterialAsset, SceneMaterialReference, SceneObject, SceneOerstedField,
    SceneRegionOverride, SceneSpinInterface, SceneSpinTorque, SceneSpinTransport,
    ScriptBuilderMagneticInteractionEntry,
    ScriptBuilderMagneticInteractionKind, ScriptBuilderUniverseState, Transform3D,
};

fn spin_commit_scene_resource(scene: SceneDocument) -> Result<SceneResource, ApiError> {
    SceneResource::from_scene_document(scene)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

fn require_spin_base_revision(scene: &SceneDocument, base_revision: u64) -> Result<(), ApiError> {
    check_base_scene_revision(scene, Some(base_revision))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/current-transports", responses((status = 200, body = CurrentTransportListResource)), tag = "model")]
pub async fn get_current_transports(
    State(state): State<Arc<AppState>>,
) -> Result<Json<CurrentTransportListResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    Ok(Json(CurrentTransportListResource {
        scene_revision: scene.revision,
        items: scene.current_transports,
    }))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/current-transports/{id}", params(("id" = String, Path)), responses((status = 200, body = SceneCurrentTransport), (status = 404)), tag = "model")]
pub async fn get_current_transport(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SceneCurrentTransport>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    scene
        .current_transports
        .into_iter()
        .find(|item| item.name() == Some(id.as_str()))
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("current transport not found: {id}")))
}

#[utoipa::path(post, path = "/v2/sessions/current/model/current-transports", request_body = CurrentTransportMutationRequest, responses((status = 200, body = CurrentTransportCommitResource), (status = 409)), tag = "model")]
pub async fn create_current_transport(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CurrentTransportMutationRequest>,
) -> Result<Json<CurrentTransportCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    let name = req.resource.name().ok_or_else(|| {
        ApiError::bad_request("unsupported current transport variants are read-only")
    })?;
    if scene
        .current_transports
        .iter()
        .any(|item| item.name() == Some(name))
    {
        return Err(ApiError::conflict(format!(
            "duplicate current transport id '{name}'"
        )));
    }
    let resource = req.resource;
    ensure_candidate_authorable(
        &scene,
        TransportValidationCandidate::CurrentTransport {
            operation: TransportAuthoringOperation::Create,
            path_id: None,
            resource: resource.clone(),
        },
    )?;
    scene.current_transports.push(resource.clone());
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(CurrentTransportCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(patch, path = "/v2/sessions/current/model/current-transports/{id}", params(("id" = String, Path)), request_body = CurrentTransportMutationRequest, responses((status = 200, body = CurrentTransportCommitResource), (status = 409)), tag = "model")]
pub async fn patch_current_transport(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<CurrentTransportMutationRequest>,
) -> Result<Json<CurrentTransportCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    if req.resource.known().is_none() {
        return Err(ApiError::bad_request(
            "unsupported current transport variants are read-only",
        ));
    }
    if req.resource.name() != Some(id.as_str()) {
        return Err(ApiError::bad_request(
            "current transport resource name must match path id",
        ));
    }
    ensure_candidate_authorable(
        &scene,
        TransportValidationCandidate::CurrentTransport {
            operation: TransportAuthoringOperation::Replace,
            path_id: Some(id.clone()),
            resource: req.resource.clone(),
        },
    )?;
    let slot = scene
        .current_transports
        .iter_mut()
        .find(|item| item.name() == Some(id.as_str()))
        .ok_or_else(|| ApiError::not_found(format!("current transport not found: {id}")))?;
    if slot.known().is_none() {
        return Err(ApiError::bad_request(
            "unsupported current transport variants are read-only",
        ));
    }
    let resource = req.resource;
    *slot = resource.clone();
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(CurrentTransportCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(delete, path = "/v2/sessions/current/model/current-transports/{id}", params(("id" = String, Path)), request_body = SpinAuthoringDeleteRequest, responses((status = 200, body = CurrentTransportCommitResource), (status = 409)), tag = "model")]
pub async fn delete_current_transport(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<SpinAuthoringDeleteRequest>,
) -> Result<Json<CurrentTransportCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    let index = scene
        .current_transports
        .iter()
        .position(|item| item.name() == Some(id.as_str()))
        .ok_or_else(|| ApiError::not_found(format!("current transport not found: {id}")))?;
    if scene.current_transports[index].known().is_none() {
        return Err(ApiError::bad_request(
            "unsupported current transport variants are read-only",
        ));
    }
    let resource = scene.current_transports.remove(index);
    ensure_resulting_scene_authorable(
        &scene,
        &TransportValidationCandidate::CurrentTransport {
            operation: TransportAuthoringOperation::Replace,
            path_id: Some(id.clone()),
            resource: resource.clone(),
        },
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(CurrentTransportCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/spin-transports", responses((status = 200, body = SpinTransportListResource)), tag = "model")]
pub async fn get_spin_transports(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SpinTransportListResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    Ok(Json(SpinTransportListResource {
        scene_revision: scene.revision,
        items: scene.spin_transports,
    }))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/spin-interfaces", responses((status = 200, body = SpinInterfaceListResource)), tag = "model")]
pub async fn get_spin_interfaces(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SpinInterfaceListResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let mut items = Vec::new();
    for transport in &scene.spin_transports {
        let value = serde_json::to_value(transport).map_err(|error| {
            ApiError::internal(format!("failed to project spin interfaces: {error}"))
        })?;
        let Some(owner) = value.get("id").and_then(Value::as_str) else {
            continue;
        };
        for interface in value
            .get("interfaces")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            items.push(SpinInterfaceProjectionItem {
                owner_spin_transport_id: owner.to_string(),
                interface_id: interface
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                known: serde_json::from_value::<SceneSpinInterface>(interface.clone()).is_ok(),
                interface: interface.clone(),
            });
        }
    }
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(Json(SpinInterfaceListResource {
        scene_revision: scene.revision,
        items,
    }))
}

fn replace_or_create<T>(
    items: &mut Vec<T>,
    operation: TransportAuthoringOperation,
    path_id: Option<&str>,
    resource_id: Option<&str>,
    identity: impl Fn(&T) -> Option<&str>,
    resource: T,
) -> Result<(), String> {
    match operation {
        TransportAuthoringOperation::Create => {
            let id = resource_id.ok_or_else(|| "candidate identity is unavailable".to_string())?;
            if items.iter().any(|item| identity(item) == Some(id)) {
                return Err(format!("duplicate candidate identity '{id}'"));
            }
            items.push(resource);
        }
        TransportAuthoringOperation::Replace => {
            let path_id = path_id.ok_or_else(|| "replace requires path_id".to_string())?;
            if resource_id != Some(path_id) {
                return Err("candidate identity must match path_id".to_string());
            }
            let slot = items
                .iter_mut()
                .find(|item| identity(item) == Some(path_id))
                .ok_or_else(|| format!("candidate target not found: {path_id}"))?;
            *slot = resource;
        }
    }
    Ok(())
}

fn apply_validation_candidate(
    scene: &mut SceneDocument,
    candidate: TransportValidationCandidate,
) -> Result<(), String> {
    match candidate {
        TransportValidationCandidate::CurrentTransport {
            operation,
            path_id,
            resource,
        } => {
            let id = resource.name().map(str::to_string);
            replace_or_create(
                &mut scene.current_transports,
                operation,
                path_id.as_deref(),
                id.as_deref(),
                SceneCurrentTransport::name,
                resource,
            )
        }
        TransportValidationCandidate::SpinTransport {
            operation,
            path_id,
            resource,
        } => {
            let id = resource.id().map(str::to_string);
            replace_or_create(
                &mut scene.spin_transports,
                operation,
                path_id.as_deref(),
                id.as_deref(),
                SceneSpinTransport::id,
                resource,
            )
        }
        TransportValidationCandidate::SpinTorque {
            operation,
            path_id,
            resource,
        } => {
            let id = resource.id().to_string();
            replace_or_create(
                &mut scene.spin_torques,
                operation,
                path_id.as_deref(),
                Some(id.as_str()),
                |item| Some(item.id()),
                resource,
            )
        }
        TransportValidationCandidate::OerstedField {
            operation,
            path_id,
            resource,
        } => {
            let id = resource.id().to_string();
            replace_or_create(
                &mut scene.oersted_fields,
                operation,
                path_id.as_deref(),
                Some(id.as_str()),
                |item| Some(item.id()),
                resource,
            )
        }
        TransportValidationCandidate::SpinInterface {
            operation,
            owner_spin_transport_id,
            interface_id,
            resource,
        } => {
            let slot = scene
                .spin_transports
                .iter_mut()
                .find(|item| item.id() == Some(owner_spin_transport_id.as_str()))
                .ok_or_else(|| {
                    format!("owner spin transport not found: {owner_spin_transport_id}")
                })?;
            let mut value = serde_json::to_value(&*slot).map_err(|error| error.to_string())?;
            let interfaces = value
                .get_mut("interfaces")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "owner spin transport has no interfaces array".to_string())?;
            let resource_id = resource.get("id").and_then(Value::as_str);
            match operation {
                TransportAuthoringOperation::Create => {
                    if resource_id.is_some_and(|id| {
                        interfaces
                            .iter()
                            .any(|item| item.get("id").and_then(Value::as_str) == Some(id))
                    }) {
                        return Err(format!(
                            "duplicate spin interface id '{}'",
                            resource_id.unwrap_or_default()
                        ));
                    }
                    interfaces.push(resource);
                }
                TransportAuthoringOperation::Replace => {
                    let interface_id = interface_id
                        .as_deref()
                        .ok_or_else(|| "replace requires interface_id".to_string())?;
                    if resource_id != Some(interface_id) {
                        return Err("interface identity must match interface_id".to_string());
                    }
                    let target = interfaces
                        .iter_mut()
                        .find(|item| item.get("id").and_then(Value::as_str) == Some(interface_id))
                        .ok_or_else(|| format!("spin interface not found: {interface_id}"))?;
                    *target = resource;
                }
            }
            *slot = serde_json::from_value(value).map_err(|error| error.to_string())?;
            Ok(())
        }
    }
}

fn evaluate_transport_candidate(
    scene: &SceneDocument,
    candidate: TransportValidationCandidate,
) -> (TransportSemanticValidation, TransportExecutionCapability) {
    let mut clone = scene.clone();
    let apply_error = apply_validation_candidate(&mut clone, candidate.clone()).err();
    let validation_error = apply_error.or_else(|| {
        fullmag_authoring::validate_scene_document(&clone)
            .err()
            .map(|error| error.message)
    });
    let semantic = match validation_error {
        Some(message) => TransportSemanticValidation {
            valid: false,
            issues: vec![TransportValidationIssue {
                code: "invalid_transport_candidate".to_string(),
                path: "candidate".to_string(),
                message,
            }],
        },
        None => TransportSemanticValidation {
            valid: true,
            issues: Vec::new(),
        },
    };
    let mut execution = candidate_capability(&clone, &candidate);
    execution.authoring_allowed &= semantic.valid;
    (semantic, execution)
}

fn ensure_candidate_authorable(
    scene: &SceneDocument,
    candidate: TransportValidationCandidate,
) -> Result<(), ApiError> {
    let (semantic, capability) = evaluate_transport_candidate(scene, candidate);
    if let Some(issue) = semantic.issues.first() {
        return Err(ApiError::bad_request(issue.message.clone()));
    }
    if !capability.authoring_allowed
        || !matches!(
            capability.status.as_str(),
            "semantic_only" | "source_visible"
        )
    {
        return Err(ApiError::bad_request(capability.reason.unwrap_or_else(
            || "transport candidate capability is unavailable".to_string(),
        )));
    }
    Ok(())
}

fn ensure_resulting_scene_authorable(
    scene: &SceneDocument,
    removed: &TransportValidationCandidate,
) -> Result<(), ApiError> {
    let capability = candidate_capability(scene, removed);
    if !capability.authoring_allowed {
        return Err(ApiError::bad_request(
            capability
                .reason
                .unwrap_or_else(|| "transport resource is read-only".to_string()),
        ));
    }
    fullmag_authoring::validate_scene_document(scene)
        .map_err(|error| ApiError::unprocessable(error.message))
}

#[utoipa::path(post, path = "/v2/sessions/current/model/transport-validation", request_body = TransportValidationRequest, responses((status = 200, body = TransportValidationResponse), (status = 409)), tag = "model")]
pub async fn validate_transport_candidate(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TransportValidationRequest>,
) -> Result<Json<TransportValidationResponse>, ApiError> {
    if req.validation_version != "transport-authoring-validation.v1" {
        return Err(ApiError::bad_request(
            "unsupported transport validation version",
        ));
    }
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    let (semantic, execution) = evaluate_transport_candidate(&scene, req.candidate);
    Ok(Json(TransportValidationResponse {
        validation_version: "transport-authoring-validation.v1".to_string(),
        scene_revision: req.base_revision,
        semantic,
        execution,
    }))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/spin-transports/{id}", params(("id" = String, Path)), responses((status = 200, body = SceneSpinTransport), (status = 404)), tag = "model")]
pub async fn get_spin_transport(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SceneSpinTransport>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    scene
        .spin_transports
        .into_iter()
        .find(|item| item.id() == Some(id.as_str()))
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("spin transport not found: {id}")))
}

#[utoipa::path(post, path = "/v2/sessions/current/model/spin-transports", request_body = SpinTransportMutationRequest, responses((status = 200, body = SpinTransportCommitResource), (status = 409)), tag = "model")]
pub async fn create_spin_transport(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SpinTransportMutationRequest>,
) -> Result<Json<SpinTransportCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    let id = req
        .resource
        .known()
        .map(|resource| resource.id.as_str())
        .ok_or_else(|| {
            ApiError::bad_request("unsupported spin transport variants are read-only")
        })?;
    if scene
        .spin_transports
        .iter()
        .any(|item| item.id() == Some(id))
    {
        return Err(ApiError::conflict(format!(
            "duplicate spin transport id '{id}'"
        )));
    }
    let resource = req.resource;
    ensure_candidate_authorable(
        &scene,
        TransportValidationCandidate::SpinTransport {
            operation: TransportAuthoringOperation::Create,
            path_id: None,
            resource: resource.clone(),
        },
    )?;
    scene.spin_transports.push(resource.clone());
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(SpinTransportCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(patch, path = "/v2/sessions/current/model/spin-transports/{id}", params(("id" = String, Path)), request_body = SpinTransportMutationRequest, responses((status = 200, body = SpinTransportCommitResource), (status = 409)), tag = "model")]
pub async fn patch_spin_transport(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<SpinTransportMutationRequest>,
) -> Result<Json<SpinTransportCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    if req.resource.known().map(|resource| resource.id.as_str()) != Some(id.as_str()) {
        return Err(ApiError::bad_request(
            "known spin transport resource id must match path id",
        ));
    }
    ensure_candidate_authorable(
        &scene,
        TransportValidationCandidate::SpinTransport {
            operation: TransportAuthoringOperation::Replace,
            path_id: Some(id.clone()),
            resource: req.resource.clone(),
        },
    )?;
    let slot = scene
        .spin_transports
        .iter_mut()
        .find(|item| item.id() == Some(id.as_str()))
        .ok_or_else(|| ApiError::not_found(format!("spin transport not found: {id}")))?;
    if slot.known().is_none() {
        return Err(ApiError::bad_request(
            "unsupported spin transport variants are read-only",
        ));
    }
    let resource = req.resource;
    *slot = resource.clone();
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(SpinTransportCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(delete, path = "/v2/sessions/current/model/spin-transports/{id}", params(("id" = String, Path)), request_body = SpinAuthoringDeleteRequest, responses((status = 200, body = SpinTransportCommitResource), (status = 409)), tag = "model")]
pub async fn delete_spin_transport(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<SpinAuthoringDeleteRequest>,
) -> Result<Json<SpinTransportCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    let index = scene
        .spin_transports
        .iter()
        .position(|item| item.id() == Some(id.as_str()))
        .ok_or_else(|| ApiError::not_found(format!("spin transport not found: {id}")))?;
    if scene.spin_transports[index].known().is_none() {
        return Err(ApiError::bad_request(
            "unsupported spin transport variants are read-only",
        ));
    }
    let resource = scene.spin_transports.remove(index);
    ensure_resulting_scene_authorable(
        &scene,
        &TransportValidationCandidate::SpinTransport {
            operation: TransportAuthoringOperation::Replace,
            path_id: Some(id.clone()),
            resource: resource.clone(),
        },
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(SpinTransportCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/spin-torques", responses((status = 200, body = SpinTorqueListResource)), tag = "model")]
pub async fn get_spin_torques(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SpinTorqueListResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    Ok(Json(SpinTorqueListResource {
        scene_revision: scene.revision,
        items: scene.spin_torques,
    }))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/spin-torques/{id}", params(("id" = String, Path)), responses((status = 200, body = SceneSpinTorque), (status = 404)), tag = "model")]
pub async fn get_spin_torque(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SceneSpinTorque>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    scene
        .spin_torques
        .into_iter()
        .find(|item| item.id() == id)
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("spin torque not found: {id}")))
}

#[utoipa::path(post, path = "/v2/sessions/current/model/spin-torques", request_body = SpinTorqueMutationRequest, responses((status = 200, body = SpinTorqueCommitResource), (status = 409)), tag = "model")]
pub async fn create_spin_torque(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SpinTorqueMutationRequest>,
) -> Result<Json<SpinTorqueCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    if scene
        .spin_torques
        .iter()
        .any(|item| item.id() == req.resource.id())
    {
        return Err(ApiError::conflict(format!(
            "duplicate spin torque id '{}'",
            req.resource.id()
        )));
    }
    let resource = req.resource;
    ensure_candidate_authorable(
        &scene,
        TransportValidationCandidate::SpinTorque {
            operation: TransportAuthoringOperation::Create,
            path_id: None,
            resource: resource.clone(),
        },
    )?;
    scene.spin_torques.push(resource.clone());
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(SpinTorqueCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(patch, path = "/v2/sessions/current/model/spin-torques/{id}", params(("id" = String, Path)), request_body = SpinTorqueMutationRequest, responses((status = 200, body = SpinTorqueCommitResource), (status = 409)), tag = "model")]
pub async fn patch_spin_torque(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<SpinTorqueMutationRequest>,
) -> Result<Json<SpinTorqueCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    if req.resource.id() != id {
        return Err(ApiError::bad_request(
            "spin torque resource id must match path id",
        ));
    }
    if scene
        .spin_torques
        .iter()
        .find(|item| item.id() == id)
        .is_some_and(|item| matches!(item, fullmag_authoring::SceneSpinTorque::Unsupported(_)))
    {
        return Err(ApiError::bad_request(
            "unsupported spin torque variants are read-only",
        ));
    }
    ensure_candidate_authorable(
        &scene,
        TransportValidationCandidate::SpinTorque {
            operation: TransportAuthoringOperation::Replace,
            path_id: Some(id.clone()),
            resource: req.resource.clone(),
        },
    )?;
    let slot = scene
        .spin_torques
        .iter_mut()
        .find(|item| item.id() == id)
        .ok_or_else(|| ApiError::not_found(format!("spin torque not found: {id}")))?;
    let resource = req.resource;
    *slot = resource.clone();
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(SpinTorqueCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(delete, path = "/v2/sessions/current/model/spin-torques/{id}", params(("id" = String, Path)), request_body = SpinAuthoringDeleteRequest, responses((status = 200, body = SpinTorqueCommitResource), (status = 409)), tag = "model")]
pub async fn delete_spin_torque(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<SpinAuthoringDeleteRequest>,
) -> Result<Json<SpinTorqueCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    let index = scene
        .spin_torques
        .iter()
        .position(|item| item.id() == id)
        .ok_or_else(|| ApiError::not_found(format!("spin torque not found: {id}")))?;
    if matches!(
        scene.spin_torques[index],
        fullmag_authoring::SceneSpinTorque::Unsupported(_)
    ) {
        return Err(ApiError::bad_request(
            "unsupported spin torque variants are read-only",
        ));
    }
    let resource = scene.spin_torques.remove(index);
    ensure_resulting_scene_authorable(
        &scene,
        &TransportValidationCandidate::SpinTorque {
            operation: TransportAuthoringOperation::Replace,
            path_id: Some(id.clone()),
            resource: resource.clone(),
        },
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(SpinTorqueCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/oersted-fields", responses((status = 200, body = OerstedFieldListResource)), tag = "model")]
pub async fn get_oersted_fields(
    State(state): State<Arc<AppState>>,
) -> Result<Json<OerstedFieldListResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    Ok(Json(OerstedFieldListResource {
        scene_revision: scene.revision,
        items: scene.oersted_fields,
    }))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/oersted-fields/{id}", params(("id" = String, Path)), responses((status = 200, body = SceneOerstedField), (status = 404)), tag = "model")]
pub async fn get_oersted_field(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<SceneOerstedField>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    scene
        .oersted_fields
        .into_iter()
        .find(|item| item.id() == id)
        .map(Json)
        .ok_or_else(|| ApiError::not_found(format!("Oersted field not found: {id}")))
}

#[utoipa::path(post, path = "/v2/sessions/current/model/oersted-fields", request_body = OerstedFieldMutationRequest, responses((status = 200, body = OerstedFieldCommitResource), (status = 409)), tag = "model")]
pub async fn create_oersted_field(
    State(state): State<Arc<AppState>>,
    Json(req): Json<OerstedFieldMutationRequest>,
) -> Result<Json<OerstedFieldCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    if scene
        .oersted_fields
        .iter()
        .any(|item| item.id() == req.resource.id())
    {
        return Err(ApiError::conflict(format!(
            "duplicate Oersted field id '{}'",
            req.resource.id()
        )));
    }
    let resource = req.resource;
    ensure_candidate_authorable(
        &scene,
        TransportValidationCandidate::OerstedField {
            operation: TransportAuthoringOperation::Create,
            path_id: None,
            resource: resource.clone(),
        },
    )?;
    scene.oersted_fields.push(resource.clone());
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(OerstedFieldCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(patch, path = "/v2/sessions/current/model/oersted-fields/{id}", params(("id" = String, Path)), request_body = OerstedFieldMutationRequest, responses((status = 200, body = OerstedFieldCommitResource), (status = 409)), tag = "model")]
pub async fn patch_oersted_field(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<OerstedFieldMutationRequest>,
) -> Result<Json<OerstedFieldCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    if req.resource.id() != id {
        return Err(ApiError::bad_request(
            "Oersted field resource id must match path id",
        ));
    }
    if scene
        .oersted_fields
        .iter()
        .find(|item| item.id() == id)
        .is_some_and(|item| matches!(item, fullmag_authoring::SceneOerstedField::Unsupported(_)))
    {
        return Err(ApiError::bad_request(
            "unsupported Oersted field variants are read-only",
        ));
    }
    ensure_candidate_authorable(
        &scene,
        TransportValidationCandidate::OerstedField {
            operation: TransportAuthoringOperation::Replace,
            path_id: Some(id.clone()),
            resource: req.resource.clone(),
        },
    )?;
    let slot = scene
        .oersted_fields
        .iter_mut()
        .find(|item| item.id() == id)
        .ok_or_else(|| ApiError::not_found(format!("Oersted field not found: {id}")))?;
    let resource = req.resource;
    *slot = resource.clone();
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(OerstedFieldCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

#[utoipa::path(delete, path = "/v2/sessions/current/model/oersted-fields/{id}", params(("id" = String, Path)), request_body = SpinAuthoringDeleteRequest, responses((status = 200, body = OerstedFieldCommitResource), (status = 409)), tag = "model")]
pub async fn delete_oersted_field(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(req): Json<SpinAuthoringDeleteRequest>,
) -> Result<Json<OerstedFieldCommitResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    let index = scene
        .oersted_fields
        .iter()
        .position(|item| item.id() == id)
        .ok_or_else(|| ApiError::not_found(format!("Oersted field not found: {id}")))?;
    if matches!(
        scene.oersted_fields[index],
        fullmag_authoring::SceneOerstedField::Unsupported(_)
    ) {
        return Err(ApiError::bad_request(
            "unsupported Oersted field variants are read-only",
        ));
    }
    let resource = scene.oersted_fields.remove(index);
    ensure_resulting_scene_authorable(
        &scene,
        &TransportValidationCandidate::OerstedField {
            operation: TransportAuthoringOperation::Replace,
            path_id: Some(id.clone()),
            resource: resource.clone(),
        },
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    Ok(Json(OerstedFieldCommitResource {
        scene_revision: committed.revision,
        resource,
        committed_scene: spin_commit_scene_resource(committed)?,
    }))
}

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
    // Read the committed scene while Compute prepares its next immutable run.
    // The loader still validates this identity before returning/publishing it.
    let request_context = crate::capture_current_live_read_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    SceneResource::from_scene_document(scene)
        .map(Json)
        .map_err(|error| ApiError::internal(format!("failed to serialize scene document: {error}")))
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/model/scene",
    request_body = SceneResource,
    responses(
        (status = 200, description = "Committed canonical authoring scene document", body = SceneResource),
        (status = 400, description = "Invalid scene document payload"),
        (status = 404, description = "No active workspace"),
        (status = 409, description = "Scene revision conflict"),
    ),
    tag = "model"
)]
pub async fn replace_authoring_scene(
    State(state): State<Arc<AppState>>,
    Json(scene_value): Json<Value>,
) -> Result<Json<SceneResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene_document: SceneDocument = serde_json::from_value(scene_value).map_err(|error| {
        ApiError::bad_request(format!("invalid scene document payload: {error}"))
    })?;
    let committed = crate::commit_current_live_scene_document_for_context(
        &state,
        &request_context,
        scene_document,
    )
    .await?;
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
        (status = 409, description = "Scene revision conflict"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_scene(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ScenePatchRequest>,
) -> Result<Json<SceneResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let current_scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let patched_scene = apply_scene_merge_patch(&current_scene, &req.merge_patch)?;
    let committed = crate::commit_current_live_scene_document_for_context(
        &state,
        &request_context,
        patched_scene,
    )
    .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_create_object_transaction(
        &mut scene,
        req.base_revision,
        req.object_id,
        req.name,
        req.role,
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
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_object_patch(&mut scene, &object_id, req)?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_delete_object_transaction(&mut scene, None, &object_id)?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_create_object_region_transaction(&mut scene, req.base_revision, &object_id, req.region)?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_patch_object_region_transaction(
        &mut scene,
        req.base_revision,
        &object_id,
        &region_id,
        req.patch,
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_delete_object_region_transaction(&mut scene, None, &object_id, &region_id)?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_duplicate_object_region_transaction(
        &mut scene,
        req.base_revision,
        &object_id,
        &region_id,
        req.name,
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_reorder_object_regions_transaction(
        &mut scene,
        req.base_revision,
        &object_id,
        req.region_ids,
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let revisions =
        current_region_realization_revisions_for_context(&state, &request_context).await?;
    Ok(Json(RegionListResource {
        scene_revision: scene.revision,
        geometry_realization_revision: scene.revision,
        region_topology_revision: Some(revisions.topology),
        region_membership_revision: Some(revisions.membership),
        region_coefficients_revision: Some(revisions.coefficients),
        region_initial_state_revision: Some(revisions.initial_state),
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let realization = realize_geometry_scene(&scene, GeometryBackendTarget::from_scene(&scene));
    let revisions =
        current_region_realization_revisions_for_context(&state, &request_context).await?;
    Ok(Json(RegionListResource {
        scene_revision: scene.revision,
        geometry_realization_revision: realization.realization_revision,
        region_topology_revision: Some(revisions.topology),
        region_membership_revision: Some(revisions.membership),
        region_coefficients_revision: Some(revisions.coefficients),
        region_initial_state_revision: Some(revisions.initial_state),
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let revisions =
        current_region_realization_revisions_for_context(&state, &request_context).await?;
    Ok(Json(RegionDiagnosticsResource {
        scene_revision: scene.revision,
        region_topology_revision: Some(revisions.topology),
        region_membership_revision: Some(revisions.membership),
        region_coefficients_revision: Some(revisions.coefficients),
        region_initial_state_revision: Some(revisions.initial_state),
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        &request_context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    let latest_fields = Some(&snapshot.latest_fields);
    let region_coefficients_revision = snapshot.region_realization_revisions.coefficients;
    Ok(Json(MaterialParameterFieldListResource {
        scene_revision: scene.revision,
        region_coefficients_revision: Some(region_coefficients_revision),
        fields: authored_material_field_resources(&scene, latest_fields),
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let (execution_plan, fem_mesh) = {
        let _transition = state.current_live_session_transition.lock().await;
        let session_epoch = state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire);
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(snapshot, &request_context, session_epoch)?;
        let execution_plan = snapshot
            .metadata
            .as_ref()
            .and_then(crate::shared_json::SharedJson::execution_plan);
        (execution_plan, snapshot.fem_mesh.clone())
    };
    Ok(Json(CouplingListResource {
        scene_revision: scene.revision,
        couplings: authored_coupling_resources(&scene, execution_plan.as_deref(), fem_mesh.as_deref()),
    }))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/field-drives",
    responses(
        (status = 200, description = "Canonical regional field drives", body = FieldDriveListResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_field_drives(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FieldDriveListResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let drives = scene
        .field_drives
        .drives
        .into_iter()
        .map(RegionalFieldDriveResource::from_ir)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| ApiError::internal(format!("failed to serialize field drive: {error}")))?;
    Ok(Json(FieldDriveListResource {
        scene_revision: scene.revision,
        drives,
    }))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/field-drives",
    request_body = FieldDriveCreateRequest,
    responses(
        (status = 200, description = "Created a regional field drive", body = AuthoringTransactionResponse),
        (status = 400, description = "Invalid field drive"),
        (status = 409, description = "Revision conflict or duplicate field drive"),
    ),
    tag = "model"
)]
pub async fn create_authoring_field_drive(
    State(state): State<Arc<AppState>>,
    Json(req): Json<FieldDriveCreateRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_create_field_drive_transaction(
        &mut scene,
        req.base_revision,
        req.drive
            .into_ir()
            .map_err(|error| ApiError::bad_request(format!("invalid field drive: {error}")))?,
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    authoring_transaction_response("create_field_drive", committed)
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/model/field-drives/{drive_id}",
    params(("drive_id" = String, Path, description = "Stable field drive id")),
    request_body = FieldDriveReplaceRequest,
    responses(
        (status = 200, description = "Replaced a regional field drive", body = AuthoringTransactionResponse),
        (status = 400, description = "Invalid field drive"),
        (status = 404, description = "Field drive not found"),
        (status = 409, description = "Revision conflict"),
    ),
    tag = "model"
)]
pub async fn replace_authoring_field_drive(
    State(state): State<Arc<AppState>>,
    Path(drive_id): Path<String>,
    Json(req): Json<FieldDriveReplaceRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_replace_field_drive_transaction(
        &mut scene,
        req.base_revision,
        &drive_id,
        req.drive
            .into_ir()
            .map_err(|error| ApiError::bad_request(format!("invalid field drive: {error}")))?,
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    authoring_transaction_response("replace_field_drive", committed)
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/model/field-drives/{drive_id}",
    params(("drive_id" = String, Path, description = "Stable field drive id")),
    request_body = FieldDriveDeleteRequest,
    responses(
        (status = 200, description = "Deleted a regional field drive", body = AuthoringTransactionResponse),
        (status = 404, description = "Field drive not found"),
        (status = 409, description = "Revision conflict"),
    ),
    tag = "model"
)]
pub async fn delete_authoring_field_drive(
    State(state): State<Arc<AppState>>,
    Path(drive_id): Path<String>,
    Json(req): Json<FieldDriveDeleteRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_delete_field_drive_transaction(&mut scene, req.base_revision, &drive_id)?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    authoring_transaction_response("delete_field_drive", committed)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/mask-field-drives",
    responses(
        (status = 200, description = "Hand-written mask antennas", body = MaskFieldDriveListResource),
        (status = 404, description = "No active workspace or scene document"),
    ),
    tag = "model"
)]
pub async fn get_authoring_mask_field_drives(
    State(state): State<Arc<AppState>>,
) -> Result<Json<MaskFieldDriveListResource>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let drives = scene
        .field_drives
        .mask_drives
        .into_iter()
        .map(MaskFieldDriveResource::from_ir)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| ApiError::internal(format!("failed to serialize mask antenna: {error}")))?;
    Ok(Json(MaskFieldDriveListResource {
        scene_revision: scene.revision,
        drives,
    }))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/mask-field-drives",
    request_body = MaskFieldDriveCreateRequest,
    responses(
        (status = 200, description = "Created a mask antenna", body = AuthoringTransactionResponse),
        (status = 400, description = "Invalid mask antenna"),
        (status = 409, description = "Revision conflict or duplicate field drive"),
    ),
    tag = "model"
)]
pub async fn create_authoring_mask_field_drive(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MaskFieldDriveCreateRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_create_mask_field_drive_transaction(
        &mut scene,
        req.base_revision,
        mask_field_drive_from_resource(req.drive)?,
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    authoring_transaction_response("create_mask_field_drive", committed)
}

#[utoipa::path(
    put,
    path = "/v2/sessions/current/model/mask-field-drives/{drive_id}",
    params(("drive_id" = String, Path, description = "Stable mask antenna id")),
    request_body = MaskFieldDriveReplaceRequest,
    responses(
        (status = 200, description = "Replaced a mask antenna", body = AuthoringTransactionResponse),
        (status = 400, description = "Invalid mask antenna"),
        (status = 404, description = "Mask antenna not found"),
        (status = 409, description = "Revision conflict"),
    ),
    tag = "model"
)]
pub async fn replace_authoring_mask_field_drive(
    State(state): State<Arc<AppState>>,
    Path(drive_id): Path<String>,
    Json(req): Json<MaskFieldDriveReplaceRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_replace_mask_field_drive_transaction(
        &mut scene,
        req.base_revision,
        &drive_id,
        mask_field_drive_from_resource(req.drive)?,
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    authoring_transaction_response("replace_mask_field_drive", committed)
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/model/mask-field-drives/{drive_id}",
    params(("drive_id" = String, Path, description = "Stable mask antenna id")),
    request_body = FieldDriveDeleteRequest,
    responses(
        (status = 200, description = "Deleted a mask antenna", body = AuthoringTransactionResponse),
        (status = 404, description = "Mask antenna not found"),
        (status = 409, description = "Revision conflict"),
    ),
    tag = "model"
)]
pub async fn delete_authoring_mask_field_drive(
    State(state): State<Arc<AppState>>,
    Path(drive_id): Path<String>,
    Json(req): Json<FieldDriveDeleteRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_delete_mask_field_drive_transaction(&mut scene, req.base_revision, &drive_id)?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    authoring_transaction_response("delete_mask_field_drive", committed)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/ready-antennas",
    responses(
        (status = 200, description = "Ready antennas of fullmag.antennas", body = ReadyAntennaListResource),
    ),
    tag = "model"
)]
pub async fn get_ready_antennas(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ReadyAntennaListResource>, ApiError> {
    let repo_root = state.repo_root.clone();
    let registry = tokio::task::spawn_blocking(move || {
        crate::script::ready_antennas_via_python_helper(&repo_root)
    })
    .await
    .map_err(|error| ApiError::internal(format!("ready-antenna registry task failed: {error}")))??;
    serde_json::from_value(registry).map(Json).map_err(|error| {
        ApiError::internal(format!("invalid ready-antenna registry: {error}"))
    })
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/ready-antennas/terms",
    request_body = ReadyAntennaTermsRequest,
    responses(
        (status = 200, description = "Mask terms returned by one ready-antenna call", body = ReadyAntennaTermsResource),
        (status = 400, description = "Unknown antenna or invalid arguments"),
    ),
    tag = "model"
)]
pub async fn build_ready_antenna_terms(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ReadyAntennaTermsRequest>,
) -> Result<Json<ReadyAntennaTermsResource>, ApiError> {
    if req.arguments.values().any(|value| !value.is_finite()) {
        return Err(ApiError::bad_request(
            "ready_antenna_rejected: every argument must be a finite number",
        ));
    }
    let repo_root = state.repo_root.clone();
    let terms = tokio::task::spawn_blocking(move || {
        crate::script::rebuild_ready_antenna_terms_via_python_helper(
            &repo_root,
            &req.function,
            &req.arguments,
        )
    })
    .await
    .map_err(|error| ApiError::internal(format!("ready-antenna task failed: {error}")))??;
    let terms = terms
        .into_iter()
        .map(|term| serde_json::from_value(serde_json::to_value(term)?))
        .collect::<Result<Vec<MaskTermResource>, serde_json::Error>>()
        .map_err(|error| ApiError::internal(format!("failed to serialize mask term: {error}")))?;
    Ok(Json(ReadyAntennaTermsResource { terms }))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/couplings",
    request_body = CouplingCreateRequest,
    responses(
        (status = 200, description = "Created an authored coupling", body = AuthoringTransactionResponse),
        (status = 400, description = "Invalid coupling payload"),
        (status = 409, description = "Revision conflict or duplicate coupling"),
    ),
    tag = "model"
)]
pub async fn create_authoring_coupling(
    State(state): State<Arc<AppState>>,
    Json(req): Json<CouplingCreateRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut current_scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_create_coupling_transaction(&mut current_scene, req.base_revision, req.coupling)?;
    let committed = crate::commit_current_live_scene_document_for_context(
        &state,
        &request_context,
        current_scene,
    )
    .await?;
    authoring_transaction_response("create_coupling", committed)
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/couplings/{coupling_id}",
    params(
        ("coupling_id" = String, Path, description = "Coupling id")
    ),
    request_body = CouplingPatchRequest,
    responses(
        (status = 200, description = "Patched an authored coupling", body = AuthoringTransactionResponse),
        (status = 400, description = "Invalid coupling patch"),
        (status = 404, description = "Coupling not found"),
        (status = 409, description = "Revision conflict"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_coupling(
    State(state): State<Arc<AppState>>,
    Path(coupling_id): Path<String>,
    Json(req): Json<CouplingPatchRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut current_scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_patch_coupling_transaction(
        &mut current_scene,
        req.base_revision,
        &coupling_id,
        req.patch,
    )?;
    let committed = crate::commit_current_live_scene_document_for_context(
        &state,
        &request_context,
        current_scene,
    )
    .await?;
    authoring_transaction_response("patch_coupling", committed)
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/model/couplings/{coupling_id}",
    params(
        ("coupling_id" = String, Path, description = "Coupling id")
    ),
    request_body = CouplingDeleteRequest,
    responses(
        (status = 200, description = "Deleted an authored coupling", body = AuthoringTransactionResponse),
        (status = 404, description = "Coupling not found"),
        (status = 409, description = "Revision conflict"),
    ),
    tag = "model"
)]
pub async fn delete_authoring_coupling(
    State(state): State<Arc<AppState>>,
    Path(coupling_id): Path<String>,
    Json(req): Json<CouplingDeleteRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut current_scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_delete_coupling_transaction(&mut current_scene, req.base_revision, &coupling_id)?;
    let committed = crate::commit_current_live_scene_document_for_context(
        &state,
        &request_context,
        current_scene,
    )
    .await?;
    authoring_transaction_response("delete_coupling", committed)
}

fn authored_region_resources(scene: &SceneDocument) -> Vec<RegionResource> {
    scene
        .objects
        .iter()
        .flat_map(|object| {
            let mut represented_region_ids = Vec::new();
            let mut resources = object
                .regions
                .iter()
                .filter_map(|region| {
                    let region_fields = object
                        .material_parameter_fields
                        .iter()
                        .filter(|field| field.region_id.as_deref() == Some(&region.region_id))
                        .cloned()
                        .collect::<Vec<_>>();
                    let resource = region_resource_for_authored_region(
                        object,
                        &region.region_id,
                        &region.name,
                        &region.owner_object,
                        Some(region.priority),
                        Some(region.frame),
                        Some(region.shape.clone()),
                        region.mesh_policy.clone(),
                        region.material_overrides.clone(),
                        region_fields,
                        region.texture_override.clone(),
                        Some(region.realization_policy),
                        region.enabled,
                    )?;
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
                }) || object.allocated_region_ids.iter().any(|allocated_id| {
                    allocated_id == override_region_id || allocated_id == &canonical_region_id
                }) {
                    continue;
                }
                let region_fields = object
                    .material_parameter_fields
                    .iter()
                    .filter(|field| field.region_id.as_deref() == Some(override_region_id))
                    .cloned()
                    .collect::<Vec<_>>();
                if let Some(resource) = region_resource_for_authored_region(
                    object,
                    override_region_id,
                    object
                        .region_name
                        .as_deref()
                        .unwrap_or(override_region_id.as_str()),
                    &object.id,
                    None,
                    None,
                    None,
                    None,
                    Vec::new(),
                    region_fields,
                    None,
                    None,
                    true,
                ) {
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
        if region.frame.as_deref() == Some("world") {
            diagnostics.push(RegionDiagnosticResource {
                diagnostic_id: format!("region:{}:world-frame-materialization", region.region_id),
                severity: "warning".to_string(),
                code: "region_world_frame_materialization_unsupported".to_string(),
                message: "World-frame authored regions cannot be clamped to the owner object and require an explicit realized materialization path before execution.".to_string(),
                region_id: region.region_id.clone(),
                owner_object_id: owner.clone(),
                realization_status: region.realization_status.clone(),
                capability_gate: Some("regions.realized_materialization".to_string()),
            });
        }
        if region
            .shape
            .as_ref()
            .is_some_and(|shape| matches!(shape, fullmag_authoring::SceneRegionShape::Csg { .. }))
        {
            diagnostics.push(RegionDiagnosticResource {
                diagnostic_id: format!("region:{}:csg-materialization", region.region_id),
                severity: "warning".to_string(),
                code: "region_csg_materialization_unsupported".to_string(),
                message: "CSG authored regions are valid authoring intent, but v1 materialization must prove a compatible realized region before execution.".to_string(),
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
                severity: "info".to_string(),
                code: "region_material_realization_required".to_string(),
                message: "Region material override or material field is authored; execution planning must materialize it or block unsupported runtime paths.".to_string(),
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
    region_id: &str,
    name: &str,
    owner_object: &str,
    priority: Option<i32>,
    frame: Option<fullmag_authoring::SceneRegionFrame>,
    shape: Option<fullmag_authoring::SceneRegionShape>,
    mesh_policy: Option<fullmag_authoring::SceneRegionMeshPolicy>,
    material_overrides: Vec<fullmag_authoring::SceneRegionMaterialOverride>,
    material_parameter_fields: Vec<fullmag_authoring::SceneMaterialParameterAssignment>,
    texture_override: Option<fullmag_authoring::SceneTextureOverride>,
    realization_policy: Option<fullmag_authoring::SceneRegionRealizationPolicy>,
    enabled: bool,
) -> Option<RegionResource> {
    let canonical_region_id = canonical_region_id_for_object(object, region_id);
    let magnetization_ref = object
        .region_overrides
        .get(region_id)
        .or_else(|| object.region_overrides.get(&canonical_region_id))
        .and_then(|override_entry| override_entry.magnetization_ref.clone());

    let frame_str = frame.map(|f| {
        serde_json::to_value(&f)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    });
    let realization_policy_str = realization_policy.map(|p| {
        serde_json::to_value(&p)
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    });

    Some(RegionResource {
        region_id: region_id.to_string(),
        name: name.to_string(),
        source: "authored_object_region".to_string(),
        region_kind: Some("object_region".to_string()),
        owner_object_id: Some(owner_object.to_string()),
        owner_path: Some(format!("{owner_object}/{region_id}")),
        source_object_ids: vec![owner_object.to_string()],
        source_body_ids: Vec::new(),
        priority: priority.map(|p| p as i64),
        frame: frame_str,
        shape,
        mesh_policy,
        material_overrides,
        material_parameter_fields,
        texture_override,
        realization_policy: realization_policy_str,
        realization_status: Some("authored_pending_realization".to_string()),
        material_ref: object.material_ref.clone(),
        magnetization_ref,
        interaction_refs: object
            .physics_stack
            .iter()
            .map(|entry| magnetic_interaction_kind_id(entry.kind).to_string())
            .collect(),
        mesh_part_ids: Vec::new(),
        enabled: enabled && object.visible,
        bounds_min: object.geometry.bounds_min.unwrap_or([0.0; 3]),
        bounds_max: object.geometry.bounds_max.unwrap_or([0.0; 3]),
    })
}

fn authored_material_field_resources(
    scene: &SceneDocument,
    latest_fields: Option<&LatestFields>,
) -> Vec<MaterialParameterFieldResource> {
    scene
        .objects
        .iter()
        .flat_map(|object| {
            object
                .material_parameter_fields
                .iter()
                .filter_map(|field| material_field_resource(object, field, latest_fields))
        })
        .collect()
}

fn material_field_resource(
    _object: &SceneObject,
    field: &fullmag_authoring::SceneMaterialParameterAssignment,
    latest_fields: Option<&LatestFields>,
) -> Option<MaterialParameterFieldResource> {
    let parameter = serde_json::to_value(&field.parameter)
        .unwrap()
        .as_str()
        .unwrap()
        .to_string();
    let unit = match &field.value {
        fullmag_authoring::SceneMaterialParameterField::Constant { unit, .. } => unit.clone(),
        fullmag_authoring::SceneMaterialParameterField::Linear { unit, .. } => unit.clone(),
        fullmag_authoring::SceneMaterialParameterField::Radial { unit, .. } => unit.clone(),
        fullmag_authoring::SceneMaterialParameterField::Sampled { unit, .. } => Some(unit.clone()),
        fullmag_authoring::SceneMaterialParameterField::Function { unit, .. } => unit.clone(),
    };
    let frame = match &field.value {
        fullmag_authoring::SceneMaterialParameterField::Linear { frame, .. } => Some(
            serde_json::to_value(frame)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string(),
        ),
        fullmag_authoring::SceneMaterialParameterField::Radial { frame, .. }
        | fullmag_authoring::SceneMaterialParameterField::Function { frame, .. } => Some(
            serde_json::to_value(frame)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string(),
        ),
        _ => None,
    };
    let location = match &field.value {
        fullmag_authoring::SceneMaterialParameterField::Sampled { location, .. } => Some(
            serde_json::to_value(location)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string(),
        ),
        _ => None,
    };

    let mut realization_status = Some("authored_pending_realization".to_string());
    let mut min = None;
    let mut max = None;
    let mut mean = None;
    let mut sample_count = None;
    let warnings = None;

    if let Some(fields) = latest_fields {
        let lookup_keys = match parameter.as_str() {
            "ms" | "Ms" => &["mat_ms", "Ms", "ms"][..],
            "aex" | "Aex" => &["mat_aex", "Aex", "aex"][..],
            "alpha" => &["mat_alpha", "alpha"][..],
            other => &[other][..],
        };
        let mut raw_val = None;
        for key in lookup_keys {
            if let Some(val) = fields.get(*key) {
                raw_val = Some((*key, val));
                break;
            }
        }

        if let Some((key, raw_val)) = raw_val {
            // The worker records these statistics while publishing one field.
            // Listing authored materials must not hydrate every CAS array.
            if fields.binary_source_is_registered(key, raw_val)
                && raw_val.get("accepted_binary_field").is_some() {
                if let Some(summary) = raw_val.pointer("/layout/accepted_value_summary") {
                    sample_count = summary.get("sample_count").and_then(Value::as_u64);
                    min = summary.get("min").and_then(Value::as_f64);
                    max = summary.get("max").and_then(Value::as_f64);
                    mean = summary.get("mean").and_then(Value::as_f64);
                    if sample_count.is_some_and(|count| count > 0) {
                        realization_status = Some("realized".to_string());
                    }
                }
            }
            let values = flatten_json_field_values(raw_val);
            if !values.is_empty() {
                realization_status = Some("realized".to_string());
                sample_count = Some(values.len() as u64);

                let mut current_min = values[0];
                let mut current_max = values[0];
                let mut sum = 0.0;
                for &v in &values {
                    if v < current_min {
                        current_min = v;
                    }
                    if v > current_max {
                        current_max = v;
                    }
                    sum += v;
                }
                min = Some(current_min);
                max = Some(current_max);
                mean = Some(sum / values.len() as f64);
            }
        }
    }

    Some(MaterialParameterFieldResource {
        assignment_id: field.assignment_id.clone(),
        owner_object_id: field.owner_object.clone(),
        owner_path: Some(field.owner_object.clone()),
        parameter,
        source_region_id: field.region_id.clone(),
        priority: Some(field.priority as i64),
        unit,
        frame,
        location,
        field: field.value.clone(),
        realization_status,
        min,
        max,
        mean,
        sample_count,
        warnings,
    })
}

fn authored_coupling_resources(
    scene: &SceneDocument,
    execution_plan: Option<&fullmag_ir::ExecutionPlanIR>,
    fem_mesh: Option<&fullmag_runner::FemMeshPayload>,
) -> Vec<CouplingResource> {
    scene
        .couplings
        .iter()
        .map(|coupling| {
            let kind = match coupling.kind {
                fullmag_authoring::SceneCouplingKind::Exchange => "exchange",
                fullmag_authoring::SceneCouplingKind::Rkky => "rkky",
                fullmag_authoring::SceneCouplingKind::InterlayerExchange => "interlayer_exchange",
            };
            let capability_policy = serde_json::to_value(&coupling.capability_policy)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string();
            let source_resolution =
                coupling_endpoint_resolution(&coupling.source, execution_plan, fem_mesh);
            let target_resolution =
                coupling_endpoint_resolution(&coupling.target, execution_plan, fem_mesh);
            CouplingResource {
                coupling_id: coupling.coupling_id.clone(),
                coupling_kind: kind.to_string(),
                enabled: coupling.enabled,
                source: coupling.source.clone(),
                target: coupling.target.clone(),
                source_resolution: source_resolution.clone(),
                target_resolution: target_resolution.clone(),
                params: coupling.parameters.clone(),
                capability_policy: Some(capability_policy),
                realization_status: Some(coupling_realization_status(kind).to_string()),
                blocker_reason: coupling_blocker_reason(
                    coupling,
                    &source_resolution,
                    &target_resolution,
                ),
            }
        })
        .collect()
}

fn coupling_endpoint_resolution(
    endpoint: &fullmag_authoring::SceneCouplingEndpoint,
    execution_plan: Option<&fullmag_ir::ExecutionPlanIR>,
    fem_mesh: Option<&fullmag_runner::FemMeshPayload>,
) -> CouplingEndpointResolutionResource {
    match endpoint {
        fullmag_authoring::SceneCouplingEndpoint::Object { object } => {
            CouplingEndpointResolutionResource {
                status: "authored_endpoint_valid".to_string(),
                object_id: object.clone(),
                region_id: None,
                selector: None,
                tolerance: None,
                resolved_face_count: None,
                boundary_face_indices: None,
                boundary_marker_ids: None,
                area: None,
                reason: None,
            }
        }
        fullmag_authoring::SceneCouplingEndpoint::Region { object, region_id } => {
            CouplingEndpointResolutionResource {
                status: "authored_endpoint_valid".to_string(),
                object_id: object.clone(),
                region_id: Some(region_id.clone()),
                selector: None,
                tolerance: None,
                resolved_face_count: None,
                boundary_face_indices: None,
                boundary_marker_ids: None,
                area: None,
                reason: None,
            }
        }
        fullmag_authoring::SceneCouplingEndpoint::Surface { object, selector } => {
            let resolved = match execution_plan {
                Some(fullmag_ir::ExecutionPlanIR {
                    backend_plan: fullmag_ir::BackendPlanIR::Fem(plan),
                    ..
                }) => Some((
                    fullmag_plan::resolve_fem_surface_selector(
                        &plan.mesh,
                        &plan.mesh_parts,
                        object,
                        selector,
                        None,
                    ),
                    plan.mesh.boundary_markers.clone(),
                )),
                _ => fem_mesh.map(|mesh| {
                    let (mesh, mesh_parts) = coupling_resolution_mesh(mesh);
                    (
                        fullmag_plan::resolve_fem_surface_selector(
                            &mesh,
                            &mesh_parts,
                            object,
                            selector,
                            None,
                        ),
                        mesh.boundary_markers,
                    )
                }),
            };
            let Some(resolved) = resolved else {
                return CouplingEndpointResolutionResource {
                    status: "pending_mesh_resolution".to_string(),
                    object_id: object.clone(),
                    region_id: None,
                    selector: Some(selector.clone()),
                    tolerance: None,
                    resolved_face_count: None,
                    boundary_face_indices: None,
                    boundary_marker_ids: None,
                    area: None,
                    reason: Some(
                        "No current FEM execution plan is available for mesh-backed surface resolution."
                            .to_string(),
                    ),
                };
            };
            match resolved {
                (Ok(resolved), boundary_markers) => {
                    let boundary_marker_ids = coupling_boundary_marker_ids(
                        &boundary_markers,
                        &resolved.boundary_face_indices,
                    );
                    let missing_markers = boundary_marker_ids.is_empty();
                    CouplingEndpointResolutionResource {
                        status: if missing_markers {
                            "missing_boundary_markers".to_string()
                        } else {
                            "resolved".to_string()
                        },
                        object_id: object.clone(),
                        region_id: None,
                        selector: Some(resolved.selector),
                        tolerance: Some(resolved.tolerance),
                        resolved_face_count: Some(resolved.facet_global_ordinals.len() as u64),
                        boundary_face_indices: Some(resolved.boundary_face_indices),
                        boundary_marker_ids: Some(boundary_marker_ids),
                        area: Some(resolved.area),
                        reason: missing_markers.then(|| {
                            "Resolved FEM surface has no boundary marker-backed faces; runtime coupling requires shared boundary markers.".to_string()
                        }),
                    }
                }
                (Err(reason), _) => CouplingEndpointResolutionResource {
                    status: "unresolved".to_string(),
                    object_id: object.clone(),
                    region_id: None,
                    selector: Some(selector.clone()),
                    tolerance: None,
                    resolved_face_count: Some(0),
                    boundary_face_indices: Some(Vec::new()),
                    boundary_marker_ids: Some(Vec::new()),
                    area: None,
                    reason: Some(reason),
                },
            }
        }
    }
}

fn coupling_boundary_marker_ids(
    boundary_markers: &[u32],
    boundary_face_indices: &[u32],
) -> Vec<u32> {
    let mut markers = Vec::new();
    for index in boundary_face_indices {
        if let Some(marker) = boundary_markers.get(*index as usize).copied() {
            if !markers.contains(&marker) {
                markers.push(marker);
            }
        }
    }
    markers
}

fn coupling_resolution_mesh(
    mesh: &fullmag_runner::FemMeshPayload,
) -> (fullmag_ir::MeshIR, Vec<fullmag_ir::FemMeshPartIR>) {
    let mesh_ir = fullmag_ir::MeshIR {
        mesh_name: mesh.mesh_name.clone(),
        nodes: mesh.nodes.clone(),
        cells: mesh.cells.clone(),
        element_markers: mesh.element_markers.clone(),
        facets: mesh.facets.clone(),
        boundary_markers: mesh.boundary_markers.clone(),
        periodic_boundary_pairs: mesh.periodic_boundary_pairs.clone(),
        periodic_node_pairs: mesh.periodic_node_pairs.clone(),
        per_domain_quality: Default::default(),
    };
    let mesh_parts = mesh
        .mesh_parts
        .iter()
        .filter_map(|part| {
            let role = match part.role.as_str() {
                "magnetic_object" => fullmag_ir::FemMeshPartRole::MagneticObject,
                "conductor" => fullmag_ir::FemMeshPartRole::Conductor,
                "air" => fullmag_ir::FemMeshPartRole::Air,
                "interface" => fullmag_ir::FemMeshPartRole::Interface,
                "outer_boundary" => fullmag_ir::FemMeshPartRole::OuterBoundary,
                _ => return None,
            };
            Some(fullmag_ir::FemMeshPartIR {
                id: part.id.clone(),
                label: part.label.clone(),
                role,
                object_id: part.object_id.clone(),
                geometry_id: part.geometry_id.clone(),
                material_id: part.material_id.clone(),
                element_selector: fullmag_ir::FemMeshPartSelector::ElementRange {
                    start: part.element_start,
                    count: part.element_count,
                },
                boundary_face_selector: fullmag_ir::FemMeshPartSelector::BoundaryFaceRange {
                    start: part.boundary_face_start,
                    count: part.boundary_face_count,
                },
                node_selector: fullmag_ir::FemMeshPartSelector::NodeRange {
                    start: part.node_start,
                    count: part.node_count,
                },
                boundary_face_indices: part.boundary_face_indices.clone(),
                node_indices: part.node_indices.clone(),
                facet_global_ordinals: part.facet_global_ordinals.clone(),
                bounds_min: part.bounds_min,
                bounds_max: part.bounds_max,
                parent_id: None,
            })
        })
        .collect();
    (mesh_ir, mesh_parts)
}

fn coupling_blocker_reason(
    coupling: &fullmag_authoring::SceneCoupling,
    source_resolution: &CouplingEndpointResolutionResource,
    target_resolution: &CouplingEndpointResolutionResource,
) -> Option<String> {
    if !coupling.enabled {
        return None;
    }
    if let Some(reason) = coupling_endpoint_hard_blocker_reason(source_resolution) {
        return Some(format!("Source {reason}"));
    }
    if let Some(reason) = coupling_endpoint_hard_blocker_reason(target_resolution) {
        return Some(format!("Target {reason}"));
    }
    match coupling.kind {
        fullmag_authoring::SceneCouplingKind::Rkky => Some(
            "RKKY runtime operator is not available for the selected backend; solver start remains blocked."
                .to_string(),
        ),
        fullmag_authoring::SceneCouplingKind::InterlayerExchange => Some(
            "Interlayer exchange runtime operator is not available for the selected backend; solver start remains blocked."
                .to_string(),
        ),
        fullmag_authoring::SceneCouplingKind::Exchange
            if matches!(
                &coupling.source,
                fullmag_authoring::SceneCouplingEndpoint::Surface { .. }
            ) || matches!(
                &coupling.target,
                fullmag_authoring::SceneCouplingEndpoint::Surface { .. }
            ) =>
        {
            Some(
                "Surface exchange runtime operator is not available; endpoint resolution is preview-only."
                    .to_string(),
            )
        }
        fullmag_authoring::SceneCouplingKind::Exchange => None,
    }
    .or_else(|| {
        coupling_endpoint_blocker_reason(source_resolution).map(|reason| format!("Source {reason}"))
    })
    .or_else(|| {
        coupling_endpoint_blocker_reason(target_resolution).map(|reason| format!("Target {reason}"))
    })
}

fn coupling_endpoint_hard_blocker_reason(
    resolution: &CouplingEndpointResolutionResource,
) -> Option<String> {
    match resolution.status.as_str() {
        "unresolved" | "missing_boundary_markers" => coupling_endpoint_blocker_reason(resolution),
        _ => None,
    }
}

fn coupling_endpoint_blocker_reason(
    resolution: &CouplingEndpointResolutionResource,
) -> Option<String> {
    match resolution.status.as_str() {
        "unresolved" => Some(format!(
            "unresolved surface endpoint blocks solver start: {}",
            resolution
                .reason
                .as_deref()
                .unwrap_or("surface selector could not be resolved")
        )),
        "missing_boundary_markers" => Some(format!(
            "surface endpoint lacks boundary marker-backed faces; runtime coupling remains blocked: {}",
            resolution
                .reason
                .as_deref()
                .unwrap_or("missing boundary markers")
        )),
        "pending_mesh_resolution" => Some(format!(
            "surface endpoint is pending mesh resolution; solver start remains blocked: {}",
            resolution
                .reason
                .as_deref()
                .unwrap_or("no current mesh-backed resolution is available")
        )),
        _ => None,
    }
}

fn coupling_realization_status(kind: &str) -> &'static str {
    match kind {
        "rkky" | "interlayer_exchange" => "requires_runtime_capability",
        _ => "authored_pending_realization",
    }
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
        (status = 409, description = "Base scene revision does not match current scene revision"),
    ),
    tag = "model"
)]
pub async fn patch_authoring_region(
    State(state): State<Arc<AppState>>,
    Path(region_id): Path<String>,
    Json(req): Json<RegionPatchRequest>,
) -> Result<Json<Value>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    check_base_scene_revision(&scene, req.base_revision)?;
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
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_object_geometry_patch(
        &mut scene,
        &object_id,
        req.base_revision,
        req.geometry,
        req.transform,
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_universe_patch(
        &mut scene,
        req.base_revision,
        req.universe,
        req.sync_study_universe_mesh,
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_universe_fit(
        &mut scene,
        req.base_revision,
        req.padding,
        req.minimum_size,
        req.sync_study_universe_mesh,
    )?;
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
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
    if let Some(value) = req.parallel_execution {
        scene.study.parallel_execution = match value {
            NullableParallelExecutionPatchValue::Value(value) => value
                .try_into()
                .map_err(|error: String| ApiError::bad_request(error))?,
            NullableParallelExecutionPatchValue::Null => {
                fullmag_ir::ParallelExecutionPolicyIR::default()
            }
        };
    }

    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let material = scene
        .materials
        .iter()
        .find(|entry| entry.id == material_id)
        .ok_or_else(|| ApiError::not_found(format!("material not found: {material_id}")))?;
    let region_coefficients_revision =
        current_region_realization_revisions_for_context(&state, &request_context)
            .await?
            .coefficients;
    Ok(Json(build_material_resource(
        material,
        scene.revision,
        region_coefficients_revision,
    )))
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    apply_patch_material_transaction(&mut scene, None, &material_id, req)?;

    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    let material = committed
        .materials
        .iter()
        .find(|entry| entry.id == material_id)
        .ok_or_else(|| ApiError::internal(format!("committed material missing: {material_id}")))?;
    let region_coefficients_revision =
        current_region_realization_revisions_for_context(&state, &request_context)
            .await?
            .coefficients;
    Ok(Json(build_material_resource(
        material,
        committed.revision,
        region_coefficients_revision,
    )))
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let asset = scene
        .magnetization_assets
        .iter()
        .find(|entry| entry.id == asset_id)
        .ok_or_else(|| ApiError::not_found(format!("magnetization asset not found: {asset_id}")))?;
    let initial_state_revision =
        current_region_realization_revisions_for_context(&state, &request_context)
            .await?
            .initial_state;
    build_magnetization_asset_resource(&scene, asset, initial_state_revision).map(Json)
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
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
    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
    let asset = committed
        .magnetization_assets
        .iter()
        .find(|entry| entry.id == asset_id)
        .ok_or_else(|| {
            ApiError::internal(format!("committed magnetization asset missing: {asset_id}"))
        })?;
    let initial_state_revision =
        current_region_realization_revisions_for_context(&state, &request_context)
            .await?
            .initial_state;
    build_magnetization_asset_resource(&committed, asset, initial_state_revision).map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/objects/{object_id}/interactions/{interaction_kind}",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id"),
        ("interaction_kind" = String, Path, description = "Object interaction kind: exchange | demag | interfacial_dmi | bulk_dmi | uniaxial_anisotropy | cubic_anisotropy")
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    let kind = parse_interaction_kind(&interaction_kind)?;
    if matches!(
        kind,
        ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi
    ) {
        return Err(ApiError::bad_request(
            "rotated_interfacial_dmi is study-scoped; use the scene study patch",
        ));
    }
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
        scene.revision,
    )))
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/objects/{object_id}/interactions/{interaction_kind}",
    params(
        ("object_id" = String, Path, description = "Canonical scene object id"),
        ("interaction_kind" = String, Path, description = "Object interaction kind: exchange | demag | interfacial_dmi | bulk_dmi | uniaxial_anisotropy | cubic_anisotropy")
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let mut scene =
        crate::get_or_load_current_live_scene_document_for_context(&state, &request_context)
            .await?;
    check_base_scene_revision(&scene, req.base_revision)?;
    let kind = parse_interaction_kind(&interaction_kind)?;
    if matches!(
        kind,
        ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi
    ) {
        return Err(ApiError::bad_request(
            "rotated_interfacial_dmi is study-scoped; use the scene study patch",
        ));
    }
    let material_dind = material_dind_for_object(&scene, &object_id);
    let material_dbulk = material_dbulk_for_object(&scene, &object_id);
    let object = scene
        .objects
        .iter_mut()
        .find(|entry| entry.id == object_id)
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;

    apply_interaction_patch(object, kind, material_dind, material_dbulk, req)?;

    let committed =
        crate::commit_current_live_scene_document_for_context(&state, &request_context, scene)
            .await?;
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
        committed.revision,
    )))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/transactions",
    params(("idempotency-key" = Option<String>, Header, description = "Required for a scoped magnetization apply")),
    request_body = AuthoringTransactionRequest,
    responses(
        (status = 200, description = "Committed authoring transaction", body = AuthoringTransactionResponse),
        (status = 400, description = "Invalid authoring transaction payload"),
        (status = 404, description = "No active workspace"),
        (status = 409, description = "Scene revision conflict"),
    ),
    tag = "model"
)]
pub async fn commit_authoring_transaction(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(req): Json<AuthoringTransactionRequest>,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let (transaction_kind, committed) = match req {
        AuthoringTransactionRequest::ApplyMagnetization {
            base_revision, operation_id, target,
        } => {
            return commit_scoped_magnetization_transaction(
                &state, &request_context, &headers, base_revision, operation_id, target,
            ).await;
        }
        AuthoringTransactionRequest::ReplaceScene {
            base_revision,
            scene,
            magnetization_apply,
        } => {
            if let Some(request) = magnetization_apply {
                if crate::router_v2::middleware::session_scope::current_expected_session_scope().is_none() {
                    return Err(ApiError::bad_request("magnetization apply requires a session scope"));
                }
                let base_revision = base_revision.filter(|revision| *revision < u64::MAX)
                    .ok_or_else(|| ApiError::bad_request("magnetization apply requires a valid base_revision"))?;
                let apply = crate::live_authored_initial_state::MagnetizationApply::validate_request(
                    request, base_revision, &scene,
                    headers.get("idempotency-key").and_then(|value| value.to_str().ok()),
                )?;
                let mut proposed: SceneDocument = serde_json::from_value(scene)
                    .map_err(|error| ApiError::bad_request(format!("invalid scene document payload: {error}")))?;
                proposed.revision = base_revision;
                let (committed, receipt) = crate::commit_current_live_magnetization_apply(
                    &state, &request_context, proposed, &apply,
                ).await?;
                crate::validate_current_live_request_context(&state, &request_context).await?;
                let Json(mut response) = authoring_transaction_response("apply_magnetization", committed)?;
                response.magnetization_apply = Some(receipt);
                return Ok(Json(response));
            }
            let mut scene_document: SceneDocument =
                serde_json::from_value(scene).map_err(|error| {
                    ApiError::bad_request(format!("invalid scene document payload: {error}"))
                })?;
            if base_revision.is_some() {
                let current_scene = crate::get_or_load_current_live_scene_document_for_context(
                    &state,
                    &request_context,
                )
                .await?;
                check_base_scene_revision(&current_scene, base_revision)?;
                scene_document.revision = current_scene.revision;
            }
            let committed = crate::commit_current_live_scene_document_for_context(
                &state,
                &request_context,
                scene_document,
            )
            .await?;
            ("replace_scene", committed)
        }
        transaction => {
            let mut current_scene = crate::get_or_load_current_live_scene_document_for_context(
                &state,
                &request_context,
            )
            .await?;
            let transaction_kind =
                apply_authoring_transaction(&mut current_scene, transaction)?;
            let committed = crate::commit_current_live_scene_document_for_context(
                &state,
                &request_context,
                current_scene,
            )
            .await?;
            (transaction_kind, committed)
        }
    };

    // Keep the response fenced so a session transition that completes after
    // the commit cannot publish an ACK for a different current scene.
    crate::validate_current_live_request_context(&state, &request_context).await?;

    authoring_transaction_response(transaction_kind, committed)
}

async fn commit_scoped_magnetization_transaction(
    state: &Arc<AppState>,
    context: &crate::types::CurrentLiveRequestContext,
    headers: &HeaderMap,
    base_revision: u64,
    operation_id: String,
    target: MagnetizationApplyTarget,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    if crate::router_v2::middleware::session_scope::current_expected_session_scope().is_none()
        || base_revision == u64::MAX
    {
        return Err(ApiError::bad_request(
            "magnetization apply requires a session scope and a valid base_revision",
        ));
    }
    let scope = match &target {
        MagnetizationApplyTarget::Object { object_id, .. } => MagnetizationApplyScope {
            object_id: object_id.clone(), region_id: None,
        },
        MagnetizationApplyTarget::Region { object_id, region_id, .. } => MagnetizationApplyScope {
            object_id: object_id.clone(), region_id: Some(region_id.clone()),
        },
    };
    let payload = serde_json::to_value(&target)
        .map_err(|error| ApiError::internal(format!("encode magnetization apply target: {error}")))?;
    let apply = crate::live_authored_initial_state::MagnetizationApply::validate_request(
        MagnetizationApplyRequest { operation_id, scopes: vec![scope] },
        base_revision,
        &payload,
        headers.get("idempotency-key").and_then(|value| value.to_str().ok()),
    )?;
    let (replay, scene) = {
        let current = state.current_live_state.read().await;
        let snapshot = current.as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot, context, state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire),
        )?;
        let replay = snapshot.magnetization_applies.replay(&apply, context, snapshot.scene_document.as_ref())?;
        let scene = if replay.is_none() { snapshot.scene_document.clone() } else { None };
        (replay, scene)
    };
    let (committed, receipt) = if let Some(replay) = replay {
        replay
    } else {
        let mut scene = scene.ok_or_else(|| ApiError::conflict("magnetization apply requires a committed scene"))?;
        check_base_scene_revision(&scene, Some(base_revision))?;
        apply.validate_scopes(&scene)?;
        apply_magnetization_target(&mut scene, target)?;
        crate::commit_current_live_magnetization_apply(state, context, scene, &apply).await?
    };
    crate::validate_current_live_request_context(state, context).await?;
    let Json(mut response) = authoring_transaction_response("apply_magnetization", committed)?;
    response.magnetization_apply = Some(receipt);
    Ok(Json(response))
}

fn apply_magnetization_target(
    scene: &mut SceneDocument,
    target: MagnetizationApplyTarget,
) -> Result<(), ApiError> {
    match target {
        MagnetizationApplyTarget::Object { object_id, asset } => {
            let asset: Option<MagnetizationAsset> = serde_json::from_value(asset)
                .map_err(|error| ApiError::bad_request(format!("invalid magnetization asset payload: {error}")))?;
            let mut reference = None;
            if let Some(mut asset) = asset {
                if scene.magnetization_assets.iter().any(|existing| existing.id == asset.id && existing != &asset)
                    && scene.objects.iter().any(|other| {
                        (other.id != object_id && other.magnetization_ref.as_deref() == Some(asset.id.as_str()))
                            || other.region_overrides.values().any(|region| region.magnetization_ref.as_deref() == Some(asset.id.as_str()))
                    })
                {
                    let digest = fullmag_session::canonical_json_sha256(&serde_json::json!([object_id, asset]));
                    asset.id = format!("mag:scoped:{digest}");
                    if scene.magnetization_assets.iter().any(|existing| existing.id == asset.id && existing != &asset) {
                        return Err(ApiError::conflict("scoped magnetization asset identity conflict"));
                    }
                }
                reference = Some(asset.id.clone());
                upsert_magnetization_asset(scene, asset);
            }
            let object = scene.objects.iter_mut().find(|object| object.id == object_id)
                .ok_or_else(|| ApiError::not_found("magnetization apply object not found"))?;
            object.magnetization_ref = reference;
        }
        MagnetizationApplyTarget::Region { object_id, region_id, texture_override } => {
            let object = scene.objects.iter_mut().find(|object| object.id == object_id)
                .ok_or_else(|| ApiError::not_found("magnetization apply object not found"))?;
            let region = object.regions.iter_mut().find(|region| region.region_id == region_id)
                .ok_or_else(|| ApiError::not_found("magnetization apply region not found"))?;
            region.texture_override = texture_override;
            object.region_overrides.remove(&region_id);
        }
    }
    Ok(())
}

fn apply_authoring_transaction(
    current_scene: &mut SceneDocument,
    req: AuthoringTransactionRequest,
) -> Result<&'static str, ApiError> {
    match req {
        AuthoringTransactionRequest::AssignStudyExecution {
            base_revision,
            execution_profile,
            execution_layers,
        } => {
            let assigned = assign_scene_execution(
                current_scene,
                base_revision,
                execution_profile,
                execution_layers,
            )?;
            *current_scene = assigned;
            Ok("assign_study_execution")
        }
        AuthoringTransactionRequest::ReplaceScene { .. }
        | AuthoringTransactionRequest::ApplyMagnetization { .. } => Err(ApiError::internal(
            "scoped or replacement transaction must use its dedicated commit path",
        )),
        AuthoringTransactionRequest::MergePatch {
            base_revision,
            merge_patch,
        } => {
            check_base_scene_revision(current_scene, base_revision)?;
            *current_scene = apply_scene_merge_patch(current_scene, &merge_patch)?;
            Ok("merge_patch")
        }
        AuthoringTransactionRequest::PatchMagnetization {
            base_revision,
            object_id,
            region_id,
            asset,
            magnetization_ref,
        } => {
            apply_patch_magnetization_transaction(
                current_scene,
                base_revision,
                &object_id,
                region_id.as_deref(),
                asset,
                magnetization_ref,
            )?;
            Ok("patch_magnetization")
        }
        AuthoringTransactionRequest::PatchObjectGeometry {
            object_id,
            base_revision,
            geometry,
            transform,
        } => {
            apply_object_geometry_patch(
                current_scene,
                &object_id,
                base_revision,
                geometry,
                transform,
            )?;
            Ok("patch_object_geometry")
        }
        AuthoringTransactionRequest::CreateObject {
            base_revision,
            object_id,
            name,
            role,
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
            apply_create_object_transaction(
                current_scene,
                base_revision,
                object_id,
                name,
                role,
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
            Ok("create_object")
        }
        AuthoringTransactionRequest::CreateMaterial {
            base_revision,
            material_id,
            name,
            properties,
            references,
            source,
            assign_to_object_id,
        } => {
            apply_create_material_transaction(
                current_scene,
                base_revision,
                material_id,
                name,
                properties,
                references,
                source,
                assign_to_object_id,
            )?;
            Ok("create_material")
        }
        AuthoringTransactionRequest::PatchMaterial {
            base_revision,
            material_id,
            patch,
        } => {
            apply_patch_material_transaction(current_scene, base_revision, &material_id, patch)?;
            Ok("patch_material")
        }
        AuthoringTransactionRequest::DeleteMaterial {
            base_revision,
            material_id,
        } => {
            apply_delete_material_transaction(current_scene, base_revision, &material_id)?;
            Ok("delete_material")
        }
        AuthoringTransactionRequest::DeleteObject {
            base_revision,
            object_id,
        } => {
            apply_delete_object_transaction(current_scene, base_revision, &object_id)?;
            Ok("delete_object")
        }
        AuthoringTransactionRequest::RenameObject {
            base_revision,
            object_id,
            name,
        } => {
            apply_rename_object_transaction(current_scene, base_revision, &object_id, name)?;
            Ok("rename_object")
        }
        AuthoringTransactionRequest::CommitObjectTransform {
            base_revision,
            object_id,
            transform,
        } => {
            apply_commit_object_transform_transaction(
                current_scene,
                base_revision,
                &object_id,
                transform,
            )?;
            Ok("commit_object_transform")
        }
        AuthoringTransactionRequest::PatchUniverse {
            base_revision,
            universe,
            sync_study_universe_mesh,
        } => {
            apply_patch_universe_transaction(
                current_scene,
                base_revision,
                universe,
                sync_study_universe_mesh,
            )?;
            Ok("patch_universe")
        }
        AuthoringTransactionRequest::CreateObjectRegion {
            base_revision,
            object_id,
            region,
        } => {
            apply_create_object_region_transaction(
                current_scene,
                base_revision,
                &object_id,
                region,
            )?;
            Ok("create_object_region")
        }
        AuthoringTransactionRequest::PatchObjectRegion {
            base_revision,
            object_id,
            region_id,
            patch,
        } => {
            apply_patch_object_region_transaction(
                current_scene,
                base_revision,
                &object_id,
                &region_id,
                patch,
            )?;
            Ok("patch_object_region")
        }
        AuthoringTransactionRequest::PatchObjectMaterialFields {
            base_revision,
            object_id,
            fields,
        } => {
            apply_patch_object_material_fields_transaction(
                current_scene,
                base_revision,
                &object_id,
                fields,
            )?;
            Ok("patch_object_material_fields")
        }
        AuthoringTransactionRequest::DeleteObjectRegion {
            base_revision,
            object_id,
            region_id,
        } => {
            apply_delete_object_region_transaction(
                current_scene,
                base_revision,
                &object_id,
                &region_id,
            )?;
            Ok("delete_object_region")
        }
        AuthoringTransactionRequest::ReorderObjectRegions {
            base_revision,
            object_id,
            region_ids,
        } => {
            apply_reorder_object_regions_transaction(
                current_scene,
                base_revision,
                &object_id,
                region_ids,
            )?;
            Ok("reorder_object_regions")
        }
        AuthoringTransactionRequest::CreateCoupling {
            base_revision,
            coupling,
        } => {
            apply_create_coupling_transaction(current_scene, base_revision, coupling)?;
            Ok("create_coupling")
        }
        AuthoringTransactionRequest::PatchCoupling {
            base_revision,
            coupling_id,
            patch,
        } => {
            apply_patch_coupling_transaction(current_scene, base_revision, &coupling_id, patch)?;
            Ok("patch_coupling")
        }
        AuthoringTransactionRequest::DeleteCoupling {
            base_revision,
            coupling_id,
        } => {
            apply_delete_coupling_transaction(current_scene, base_revision, &coupling_id)?;
            Ok("delete_coupling")
        }
        AuthoringTransactionRequest::BooleanCombineObjects {
            base_revision,
            op,
            target_object_id,
            tool_object_ids,
            keep_tools,
            region_merge_policy,
        } => {
            apply_boolean_combine_objects_transaction(
                current_scene,
                base_revision,
                &op,
                &target_object_id,
                &tool_object_ids,
                keep_tools,
                region_merge_policy.as_deref(),
            )?;
            Ok("boolean_combine_objects")
        }
        AuthoringTransactionRequest::UpdateBooleanOperands {
            base_revision,
            object_id,
            op,
            reorder_operand_ids,
            toggle_operand,
            remove_operand_id,
            add_operand,
        } => {
            apply_update_boolean_operands_transaction(
                current_scene,
                base_revision,
                &object_id,
                op.as_deref(),
                reorder_operand_ids,
                toggle_operand,
                remove_operand_id.as_deref(),
                add_operand,
            )?;
            Ok("update_boolean_operands")
        }
        AuthoringTransactionRequest::SeparateObject {
            base_revision,
            object_id,
            mode,
            operand_id,
            keep_in_boolean,
            plane_origin_m,
            plane_normal,
        } => {
            apply_separate_object_transaction(
                current_scene,
                base_revision,
                &object_id,
                &mode,
                operand_id.as_deref(),
                keep_in_boolean,
                plane_origin_m,
                plane_normal,
            )?;
            Ok("separate_object")
        }
        AuthoringTransactionRequest::DuplicateObjects {
            base_revision,
            object_ids,
            offset_m,
            copy_regions,
        } => {
            apply_duplicate_objects_transaction(
                current_scene,
                base_revision,
                &object_ids,
                offset_m,
                copy_regions,
            )?;
            Ok("duplicate_objects")
        }
        AuthoringTransactionRequest::ApplyArray3d {
            base_revision,
            object_id,
            target_operand_id,
            axes,
            merge_overlapping,
            realization,
        } => {
            apply_array_3d_transaction(
                current_scene,
                base_revision,
                &object_id,
                target_operand_id.as_deref(),
                &axes,
                merge_overlapping,
                &realization,
            )?;
            Ok("apply_array_3d")
        }
    }
}

fn authoring_transaction_response(
    transaction_kind: &str,
    committed: SceneDocument,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
    let scene_revision = committed.revision;
    let committed_scene = SceneResource::from_scene_document(committed).map_err(|error| {
        ApiError::internal(format!("failed to project committed scene resource: {error}"))
    })?;

    Ok(Json(AuthoringTransactionResponse {
        transaction_kind: transaction_kind.to_string(),
        scene_revision,
        committed_scene,
        magnetization_apply: None,
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
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let _transition = state.current_live_session_transition.lock().await;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    let response = crate::script::get_current_live_script_source(&state).await?;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    Ok(Json(response))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/syncs",
    request_body = ScriptSyncRequest,
    responses(
        (status = 200, description = "Canonical Python rewritten from authoring state", body = ScriptSyncResponse),
        (status = 400, description = "Scene physics is incomplete; no canonical source was written"),
        (status = 404, description = "No active workspace"),
    ),
    tag = "model"
)]
pub async fn sync_authoring_script(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ScriptSyncRequest>,
) -> Result<(axum::http::HeaderMap, Json<ScriptSyncResponse>), ApiError> {
    let request_context = crate::capture_current_live_request_context(&state).await?;
    let _transition = state.current_live_session_transition.lock().await;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    let response = crate::script::sync_current_live_script_with_request(&state, req).await?;
    crate::validate_current_live_request_context(&state, &request_context).await?;
    let current = state.current_live_state.read().await;
    let snapshot = current.as_ref().ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let scope = crate::current_live_publisher_scope_header(&state, snapshot);
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(crate::router_v2::middleware::session_scope::HEADER_NAME,
        axum::http::HeaderValue::from_str(&scope).map_err(|error| ApiError::internal(error.to_string()))?);
    Ok((headers, Json(response)))
}

fn apply_scene_merge_patch(
    scene: &SceneDocument,
    merge_patch: &Value,
) -> Result<SceneDocument, ApiError> {
    if merge_patch
        .get("study")
        .and_then(|study| study.get("execution_profile"))
        .is_some_and(|profile| !profile.is_null())
    {
        return Err(ApiError::bad_request(
            "execution_profile_requires_atomic_assignment: use assign_study_execution instead of recursively merging immutable profile defaults",
        ));
    }
    let mut scene_value = serde_json::to_value(scene).map_err(|error| {
        ApiError::internal(format!("failed to serialize scene document: {error}"))
    })?;
    merge_patch_value(&mut scene_value, merge_patch);
    serde_json::from_value(scene_value)
        .map_err(|error| ApiError::bad_request(format!("invalid scene patch payload: {error}")))
}

fn assign_scene_execution(
    scene: &SceneDocument,
    base_revision: u64,
    profile: fullmag_ir::ExecutionProfileIR,
    layers: Vec<fullmag_ir::ExecutionRequestLayerIR>,
) -> Result<SceneDocument, ApiError> {
    check_base_scene_revision(scene, Some(base_revision))?;
    let mut assigned = scene.clone();
    assigned.study.execution_profile = Some(profile);
    assigned.study.execution_layers = layers;
    fullmag_authoring::validate_scene_document(&assigned)
        .map_err(|error| ApiError::bad_request(error.message))?;
    Ok(assigned)
}

#[cfg(test)]
#[path = "study_execution_assignment_tests.rs"]
mod study_execution_assignment_tests;

fn apply_patch_magnetization_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    region_id: Option<&str>,
    asset: Option<Value>,
    magnetization_ref: Option<NullableStringPatchValue>,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    if let Some(asset_value) = asset {
        let asset: MagnetizationAsset = serde_json::from_value(asset_value).map_err(|error| {
            ApiError::bad_request(format!("invalid magnetization asset payload: {error}"))
        })?;
        upsert_magnetization_asset(scene, asset);
    }
    if region_id.is_none() && magnetization_ref.is_none() {
        return Err(ApiError::bad_request(
            "patch_magnetization requires magnetization_ref for an object target",
        ));
    }
    let object = find_scene_object_mut(scene, object_id)?;
    if let Some(region_id) = region_id {
        let region_override_id = canonical_region_id_for_object(object, region_id);
        match magnetization_ref {
            Some(NullableStringPatchValue::Value(value)) => {
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
            Some(NullableStringPatchValue::Null) => {
                object.region_overrides.remove(&region_override_id);
            }
            None => {}
        }
        return Ok(());
    }

    if let Some(magnetization_ref) = magnetization_ref {
        object.magnetization_ref = match magnetization_ref {
            NullableStringPatchValue::Value(value) => {
                let value = value.trim();
                (!value.is_empty()).then(|| value.to_string())
            }
            NullableStringPatchValue::Null => None,
        };
    }
    Ok(())
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
        parallel_execution: (&scene.study.parallel_execution).into(),
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
            airbox_curvature_factor: None,
            airbox_narrow_region_resolution: None,
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
    let transform_patch: Option<fullmag_authoring::Transform3DPatch> = transform_value
        .map(|value| {
            serde_json::from_value(value).map_err(|error| {
                ApiError::bad_request(format!("invalid object transform payload: {error}"))
            })
        })
        .transpose()?;
    let object = find_scene_object_mut(scene, object_id)?;
    object.geometry = geometry;
    if let Some(patch) = transform_patch {
        object
            .transform
            .apply_patch(patch)
            .map_err(ApiError::bad_request)?;
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
    role: Option<String>,
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
    let role = match role {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(ApiError::bad_request("object role must not be empty"));
            }
            trimmed.to_string()
        }
        None => "magnet".to_string(),
    };
    let is_magnet = role == "magnet";
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
            let patch: fullmag_authoring::Transform3DPatch =
                serde_json::from_value(value).map_err(|error| {
                    ApiError::bad_request(format!("invalid object transform payload: {error}"))
                })?;
            let mut next = Transform3D::default();
            next.apply_patch(patch).map_err(ApiError::bad_request)?;
            Ok::<Transform3D, ApiError>(next)
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
        .or_else(|| {
            is_magnet
                .then(|| scene.materials.first().map(|material| material.id.clone()))
                .flatten()
        })
        .unwrap_or_default();
    let magnetization_ref = magnetization_ref
        .or_else(|| magnetization_asset.as_ref().map(|asset| asset.id.clone()))
        .or_else(|| {
            is_magnet
                .then(|| {
                    scene
                        .magnetization_assets
                        .first()
                        .map(|asset| asset.id.clone())
                })
                .flatten()
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
        role,
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
        absorbing_boundary: None,
        visualization_hint: Default::default(),
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

fn apply_create_material_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    material_id: String,
    name: String,
    properties: MaterialPropertiesResource,
    references: Vec<MaterialReferenceResource>,
    source: Option<fullmag_authoring::SceneMaterialSource>,
    assign_to_object_id: Option<String>,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let material_id = material_id.trim();
    if material_id.is_empty() {
        return Err(ApiError::bad_request("material_id must not be empty"));
    }
    if scene.materials.iter().any(|entry| entry.id == material_id) {
        return Err(ApiError::conflict(format!(
            "material already exists: {material_id}"
        )));
    }
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("material name must not be empty"));
    }
    crate::material_library::validate_properties(&properties)
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    if let Some(source) = &source {
        fullmag_authoring::validate_material_source(source).map_err(ApiError::bad_request)?;
    }
    let references = material_references_from_resources(
        references,
        source.is_some() || assign_to_object_id.is_some(),
    )?;
    let target_index = assign_to_object_id
        .as_deref()
        .map(|object_id| {
            let index = scene.objects.iter().position(|object| object.id == object_id)
                .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
            if scene.objects[index].role != "magnet" {
                return Err(ApiError::bad_request(
                    "material assignment requires a magnetic object",
                ));
            }
            Ok(index)
        })
        .transpose()?;

    // Validate both sides before changing the scene so failed assignment
    // cannot leave an unassigned material asset behind.
    scene.materials.push(SceneMaterialAsset {
        id: material_id.to_string(),
        name: name.to_string(),
        properties: fullmag_authoring::ScriptBuilderMaterialState {
            ms: properties.ms,
            aex: properties.aex,
            alpha: properties.alpha,
            dind: properties.dind,
            dbulk: properties.dbulk,
            ku1: None,
            ku2: None,
            kc1: None,
            kc2: None,
            kc3: None,
        },
        references,
        source,
    });
    if let Some(index) = target_index {
        assign_object_material(
            &mut scene.objects[index], &scene.materials, material_id.to_owned(), true,
        );
    }
    Ok(())
}

/// Keep explicit activation and preserve legacy enablement when assigning a copy.
fn assign_object_material(
    object: &mut SceneObject,
    materials: &[SceneMaterialAsset],
    material_id: String,
    independent_copy: bool,
) {
    if object.role == "magnet" && material_id != object.material_ref {
        let previous = materials.iter().find(|entry| entry.id == object.material_ref);
        let next = materials.iter().find(|entry| entry.id == material_id);
        if independent_copy || previous.is_some_and(|entry| entry.source.is_some())
            || next.is_some_and(|entry| entry.source.is_some())
        {
            sync_object_dmi_parameters(
                object,
                previous.map(|entry| &entry.properties),
                next.map(|entry| &entry.properties),
                true,
            );
        }
    }
    object.material_ref = material_id;
}

fn sync_object_dmi_parameters(
    object: &mut SceneObject,
    previous: Option<&fullmag_authoring::ScriptBuilderMaterialState>,
    next: Option<&fullmag_authoring::ScriptBuilderMaterialState>,
    preserve_implicit: bool,
) {
    use ScriptBuilderMagneticInteractionKind::{BulkDmi, InterfacialDmi};

    for (kind, key, before, after) in [
        (InterfacialDmi, "dind", previous.and_then(|value| value.dind), next.and_then(|value| value.dind)),
        (BulkDmi, "dbulk", previous.and_then(|value| value.dbulk), next.and_then(|value| value.dbulk)),
    ] {
        let coefficient = Value::from(after.unwrap_or(0.0));
        if let Some(entry) = object.physics_stack.iter_mut().find(|entry| entry.kind == kind) {
            let mut params = match entry.params.take() {
                Some(Value::Object(params)) => params,
                _ => Default::default(),
            };
            params.insert(key.to_owned(), coefficient);
            entry.params = Some(Value::Object(params));
        } else if preserve_implicit {
            let enabled = before.is_some_and(|value| value != 0.0);
            if enabled != after.is_some_and(|value| value != 0.0) {
                object.physics_stack.push(ScriptBuilderMagneticInteractionEntry {
                    kind,
                    enabled,
                    params: Some(Value::Object([(key.to_owned(), coefficient)].into_iter().collect())),
                });
            }
        }
    }
}

fn apply_patch_material_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    material_id: &str,
    patch: MaterialPatchRequest,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let material = scene
        .materials
        .iter_mut()
        .find(|entry| entry.id == material_id)
        .ok_or_else(|| ApiError::not_found(format!("material not found: {material_id}")))?;
    let previous = material.source.as_ref().map(|_| material.properties.clone());
    apply_material_patch_to_asset(material, patch)?;
    for object in scene.objects.iter_mut().filter(|object| object.material_ref == material_id) {
        let preserve_implicit = previous.is_some() && object.role == "magnet";
        sync_object_dmi_parameters(object, previous.as_ref(), Some(&material.properties), preserve_implicit);
    }
    Ok(())
}

fn apply_delete_material_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    material_id: &str,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    if scene
        .objects
        .iter()
        .any(|object| object.material_ref == material_id)
    {
        return Err(ApiError::conflict(format!(
            "material '{material_id}' is assigned to at least one object"
        )));
    }
    let before = scene.materials.len();
    scene.materials.retain(|entry| entry.id != material_id);
    if scene.materials.len() == before {
        return Err(ApiError::not_found(format!(
            "material not found: {material_id}"
        )));
    }
    Ok(())
}

fn apply_material_patch_to_asset(
    material: &mut SceneMaterialAsset,
    req: MaterialPatchRequest,
) -> Result<(), ApiError> {
    if let Some(name) = req.name {
        let name = name.trim();
        if name.is_empty() {
            return Err(ApiError::bad_request("material name must not be empty"));
        }
        material.name = name.to_string();
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
    if let Some(references) = req.references {
        material.references = material_references_from_resources(references, false)?;
    }
    Ok(())
}

fn material_references_from_resources(
    references: Vec<MaterialReferenceResource>,
    preserve_text: bool,
) -> Result<Vec<SceneMaterialReference>, ApiError> {
    references
        .into_iter()
        .map(|reference| {
            let url = trimmed_optional(reference.url.clone());
            if url.as_deref().is_some_and(|url| {
                !(url.starts_with("https://") || url.starts_with("http://"))
            }) {
                return Err(ApiError::bad_request(
                    "material reference url must start with http:// or https://",
                ));
            }
            // Assigning a copy preserves effective references byte for byte.
            Ok(if preserve_text {
                SceneMaterialReference { label: reference.label, url: reference.url, citation: reference.citation }
            } else {
                SceneMaterialReference {
                    label: trimmed_optional(reference.label),
                    url,
                    citation: trimmed_optional(reference.citation),
                }
            })
        })
        .collect()
}

fn trimmed_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
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
    let object_index = resolve_scene_object_index(&scene.objects, object_id)?;
    let removed_object = scene.objects.remove(object_index);
    cascade_cleanup_deleted_object_references(scene, &removed_object.id, &removed_object.name);
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
    let patch: fullmag_authoring::Transform3DPatch =
        serde_json::from_value(transform_value).map_err(|error| {
            ApiError::bad_request(format!("invalid object transform payload: {error}"))
        })?;
    let object = find_scene_object_mut(scene, object_id)?;
    object
        .transform
        .apply_patch(patch)
        .map_err(ApiError::bad_request)?;
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
    mut region: fullmag_authoring::SceneObjectRegion,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let object = find_scene_object_mut(scene, object_id)?;
    let region_name = &region.name;
    if region_name.trim().is_empty() {
        return Err(ApiError::bad_request("object region requires name"));
    }
    let region_id = allocate_object_region_id(object);
    if object
        .regions
        .iter()
        .any(|entry| entry.region_id == region_id || entry.name == *region_name)
    {
        return Err(ApiError::conflict(format!(
            "object region already exists: {region_name}"
        )));
    }
    region.region_id = region_id;
    region.owner_object = object.id.clone();
    clamp_object_region_shape_to_owner(object, &mut region);
    object.regions.push(region);
    mark_object_mesh_dirty(object);
    Ok(())
}

fn apply_patch_object_region_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    region_id: &str,
    patch: crate::schemas::authoring::SceneObjectRegionPatch,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    if patch.id.is_some() || patch.region_id.is_some() || patch.owner_object.is_some() {
        return Err(ApiError::bad_request(
            "object region patch cannot modify identity fields: region_id, id, owner_object",
        ));
    }

    let (canonical_object_id, object_name) = {
        let object_index = resolve_scene_object_index(&scene.objects, object_id)?;
        let object = &scene.objects[object_index];
        (object.id.clone(), object.name.clone())
    };
    if patch.enabled == Some(false) {
        ensure_region_has_no_active_couplings(scene, &canonical_object_id, &object_name, region_id)?;
    }
    let object = find_scene_object_mut(scene, &canonical_object_id)?;
    if let Some(region_name) = &patch.name {
        if object
            .regions
            .iter()
            .any(|entry| entry.region_id != region_id && &entry.name == region_name)
        {
            return Err(ApiError::conflict(format!(
                "object region already exists: {region_name}"
            )));
        }
    }
    let owner_bounds = object_region_owner_bounds(object);
    let region = object
        .regions
        .iter_mut()
        .find(|r| r.region_id == region_id)
        .ok_or_else(|| ApiError::not_found(format!("object region not found: {region_id}")))?;
    let before = region.clone();

    if let Some(name) = patch.name {
        region.name = name;
    }
    if let Some(enabled) = patch.enabled {
        region.enabled = enabled;
    }
    if let Some(shape) = patch.shape {
        region.shape = shape;
    }
    if let Some(frame) = patch.frame {
        region.frame = frame;
    }
    if let Some(mesh_policy) = patch.mesh_policy {
        region.mesh_policy = mesh_policy;
    }
    if let Some(material_overrides) = patch.material_overrides {
        region.material_overrides = material_overrides;
    }
    if let Some(texture_override) = patch.texture_override {
        region.texture_override = texture_override;
    }
    if let Some(material_transition) = patch.material_transition {
        region.material_transition = material_transition;
    }
    if let Some(realization_policy) = patch.realization_policy {
        region.realization_policy =
            realization_policy.unwrap_or(fullmag_authoring::SceneRegionRealizationPolicy::Inherit);
    }
    if let Some(priority) = patch.priority {
        region.priority = priority;
    }

    clamp_object_region_shape_to_owner_bounds(owner_bounds, region);
    // Only realization-relevant fields invalidate the current mesh. Names,
    // material coefficients, textures and transitions keep the topology and
    // are tracked by their own coefficient/initial-state revisions.
    let realization_changed = region.enabled != before.enabled
        || region.shape != before.shape
        || region.frame != before.frame
        || region.mesh_policy != before.mesh_policy
        || region.realization_policy != before.realization_policy
        || region.priority != before.priority;
    if realization_changed {
        mark_object_mesh_dirty(object);
    }
    Ok(())
}

fn apply_patch_object_material_fields_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    fields: Vec<fullmag_authoring::SceneMaterialParameterAssignment>,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let object = find_scene_object_mut(scene, object_id)?;
    for field in &fields {
        if field.owner_object != object.id {
            return Err(ApiError::bad_request(format!(
                "material field '{}' owner_object '{}' must match '{}'",
                field.assignment_id, field.owner_object, object.id
            )));
        }
        if let Some(region_id) = &field.region_id {
            if !object
                .regions
                .iter()
                .any(|region| region.region_id == *region_id)
            {
                return Err(ApiError::bad_request(format!(
                    "material field '{}' references unknown region '{}'",
                    field.assignment_id, region_id
                )));
            }
        }
    }
    object.material_parameter_fields = fields;
    Ok(())
}

fn apply_delete_object_region_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    region_id: &str,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let (canonical_object_id, object_name) = {
        let object = find_scene_object_mut(scene, object_id)?;
        let before = object.regions.len();
        object.regions.retain(|entry| entry.region_id != region_id);
        if object.regions.len() == before {
            return Err(ApiError::not_found(format!(
                "object region not found: {region_id}"
            )));
        }
        // Preserve tombstone so the deleted region ID is never reused.
        if !object
            .allocated_region_ids
            .iter()
            .any(|allocated_id| allocated_id == region_id)
        {
            object.allocated_region_ids.push(region_id.to_string());
        }
        let canonical_region_id = canonical_region_id_for_object(object, region_id);
        let override_keys_to_remove: Vec<String> = object
            .region_overrides
            .keys()
            .filter(|override_key| {
                override_key.as_str() == region_id
                    || override_key.as_str() == canonical_region_id
                    || canonical_region_id_for_object(object, override_key) == canonical_region_id
            })
            .cloned()
            .collect();
        for key in override_keys_to_remove {
            object.region_overrides.remove(&key);
        }
        object
            .material_parameter_fields
            .retain(|field| field.region_id.as_deref() != Some(region_id));
        if let Some(fullmag_ir::AbsorbingBoundaryIR::Layers(config)) =
            object.absorbing_boundary.as_mut()
        {
            config.layers.retain(|layer| {
                layer.region_id.as_deref() != Some(region_id)
                    && !matches!(
                        &layer.geometry,
                        fullmag_ir::SpatialAbsorbingGeometryIR::RegionBoundary {
                            region_id: boundary_region_id
                        } if boundary_region_id == region_id
                    )
            });
            if config.layers.is_empty() {
                object.absorbing_boundary = None;
            }
        }
        mark_object_mesh_dirty(object);
        (object.id.clone(), object.name.clone())
    };
    cascade_cleanup_deleted_region_references(scene, &canonical_object_id, &object_name, region_id);
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
        .find(|entry| entry.region_id == region_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found(format!("object region not found: {region_id}")))?;
    let source_name = &source.name;
    let duplicate_name = requested_name
        .as_deref()
        .and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .unwrap_or_else(|| allocate_object_region_name(object, source_name));
    if object
        .regions
        .iter()
        .any(|entry| entry.name == duplicate_name)
    {
        return Err(ApiError::conflict(format!(
            "object region already exists: {duplicate_name}"
        )));
    }
    let duplicate_region_id = allocate_object_region_id(object);
    let mut duplicate = source;
    duplicate.name = duplicate_name;
    duplicate.region_id = duplicate_region_id;
    duplicate.owner_object = object.id.clone();
    clamp_object_region_shape_to_owner(object, &mut duplicate);
    object.regions.push(duplicate);
    mark_object_mesh_dirty(object);
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
            .position(|entry| entry.region_id == region_id)
            .ok_or_else(|| ApiError::bad_request(format!("unknown region id: {region_id}")))?;
        reordered.push(object.regions.remove(index));
    }
    if !object.regions.is_empty() {
        return Err(ApiError::bad_request(
            "region_ids must include every existing object region exactly once",
        ));
    }
    object.regions = reordered;
    mark_object_mesh_dirty(object);
    Ok(())
}

fn apply_create_coupling_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    coupling: fullmag_authoring::SceneCoupling,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let coupling_id = &coupling.coupling_id;
    if coupling_id.trim().is_empty() {
        return Err(ApiError::bad_request("coupling requires coupling_id"));
    }
    if scene
        .couplings
        .iter()
        .any(|entry| entry.coupling_id == *coupling_id)
    {
        return Err(ApiError::conflict(format!(
            "coupling already exists: {coupling_id}"
        )));
    }
    ensure_active_coupling_targets_enabled_regions(scene, &coupling)?;
    scene.couplings.push(coupling);
    Ok(())
}

fn validate_field_drive_scene(scene: &SceneDocument) -> Result<(), ApiError> {
    fullmag_authoring::validate_scene_document(scene)
        .map_err(|error| ApiError::bad_request(format!("invalid field drive scene: {error}")))
}

/// A mask antenna from its resource, with every equation, array and name
/// checked before it enters the scene (the codes of `mask-function-v1`).
fn mask_field_drive_from_resource(
    resource: MaskFieldDriveResource,
) -> Result<fullmag_ir::MaskFieldDriveIR, ApiError> {
    let drive = resource
        .into_ir()
        .map_err(|error| ApiError::bad_request(format!("invalid mask antenna: {error}")))?;
    let mut errors = Vec::new();
    drive.validate_definition("drive", &mut errors);
    if errors.is_empty() {
        Ok(drive)
    } else {
        Err(ApiError::bad_request(errors.join("\n")))
    }
}

fn mask_field_drive_identity_taken(
    scene: &SceneDocument,
    drive: &fullmag_ir::MaskFieldDriveIR,
    except_index: Option<usize>,
) -> bool {
    scene
        .field_drives
        .drives
        .iter()
        .any(|entry| entry.id == drive.id || entry.name == drive.name)
        || scene
            .field_drives
            .mask_drives
            .iter()
            .enumerate()
            .any(|(index, entry)| {
                Some(index) != except_index && (entry.id == drive.id || entry.name == drive.name)
            })
}

fn apply_create_mask_field_drive_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    drive: fullmag_ir::MaskFieldDriveIR,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    if mask_field_drive_identity_taken(scene, &drive, None) {
        return Err(ApiError::conflict(format!(
            "field drive id or name already exists: {}/{}",
            drive.id, drive.name
        )));
    }
    scene.field_drives.mask_drives.push(drive);
    if let Err(error) = validate_field_drive_scene(scene) {
        scene.field_drives.mask_drives.pop();
        return Err(error);
    }
    Ok(())
}

fn apply_replace_mask_field_drive_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    drive_id: &str,
    drive: fullmag_ir::MaskFieldDriveIR,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    if drive.id != drive_id {
        return Err(ApiError::bad_request(
            "mask antenna replacement cannot modify the stable id",
        ));
    }
    let index = scene
        .field_drives
        .mask_drives
        .iter()
        .position(|entry| entry.id == drive_id)
        .ok_or_else(|| ApiError::not_found(format!("mask antenna not found: {drive_id}")))?;
    if mask_field_drive_identity_taken(scene, &drive, Some(index)) {
        return Err(ApiError::conflict(format!(
            "field drive name already exists: {}",
            drive.name
        )));
    }
    let previous = std::mem::replace(&mut scene.field_drives.mask_drives[index], drive);
    if let Err(error) = validate_field_drive_scene(scene) {
        scene.field_drives.mask_drives[index] = previous;
        return Err(error);
    }
    Ok(())
}

fn apply_delete_mask_field_drive_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    drive_id: &str,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let index = scene
        .field_drives
        .mask_drives
        .iter()
        .position(|entry| entry.id == drive_id)
        .ok_or_else(|| ApiError::not_found(format!("mask antenna not found: {drive_id}")))?;
    let removed = scene.field_drives.mask_drives.remove(index);
    if let Err(error) = validate_field_drive_scene(scene) {
        scene.field_drives.mask_drives.insert(index, removed);
        return Err(error);
    }
    Ok(())
}

fn apply_create_field_drive_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    drive: fullmag_ir::RegionalFieldDriveIR,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    if scene
        .field_drives
        .drives
        .iter()
        .any(|entry| entry.id == drive.id || entry.name == drive.name)
    {
        return Err(ApiError::conflict(format!(
            "field drive id or name already exists: {}/{}",
            drive.id, drive.name
        )));
    }
    scene.field_drives.drives.push(drive);
    if let Err(error) = validate_field_drive_scene(scene) {
        scene.field_drives.drives.pop();
        return Err(error);
    }
    Ok(())
}

fn apply_replace_field_drive_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    drive_id: &str,
    drive: fullmag_ir::RegionalFieldDriveIR,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    if drive.id != drive_id {
        return Err(ApiError::bad_request(
            "field drive replacement cannot modify the stable id",
        ));
    }
    let index = scene
        .field_drives
        .drives
        .iter()
        .position(|entry| entry.id == drive_id)
        .ok_or_else(|| ApiError::not_found(format!("field drive not found: {drive_id}")))?;
    if scene
        .field_drives
        .drives
        .iter()
        .enumerate()
        .any(|(other, entry)| other != index && entry.name == drive.name)
    {
        return Err(ApiError::conflict(format!(
            "field drive name already exists: {}",
            drive.name
        )));
    }
    let previous = std::mem::replace(&mut scene.field_drives.drives[index], drive);
    if let Err(error) = validate_field_drive_scene(scene) {
        scene.field_drives.drives[index] = previous;
        return Err(error);
    }
    Ok(())
}

fn apply_delete_field_drive_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    drive_id: &str,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let before = scene.field_drives.drives.len();
    scene
        .field_drives
        .drives
        .retain(|entry| entry.id != drive_id);
    if scene.field_drives.drives.len() == before {
        return Err(ApiError::not_found(format!(
            "field drive not found: {drive_id}"
        )));
    }
    validate_field_drive_scene(scene)
}

fn apply_patch_coupling_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    coupling_id: &str,
    patch: SceneCouplingPatch,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    if patch.coupling_id.is_some() {
        return Err(ApiError::bad_request(
            "coupling patch cannot modify identity field: coupling_id",
        ));
    }
    let coupling_index = scene
        .couplings
        .iter()
        .position(|entry| entry.coupling_id == coupling_id)
        .ok_or_else(|| ApiError::not_found(format!("coupling not found: {coupling_id}")))?;
    let coupling = &scene.couplings[coupling_index];
    let mut coupling_val = serde_json::to_value(coupling)
        .map_err(|error| ApiError::internal(format!("failed to serialize coupling: {error}")))?;
    let patch = serde_json::to_value(patch).map_err(|error| {
        ApiError::internal(format!("failed to serialize coupling patch: {error}"))
    })?;
    merge_patch_value(&mut coupling_val, &patch);
    let patched: fullmag_authoring::SceneCoupling =
        serde_json::from_value(coupling_val).map_err(|error| {
            ApiError::bad_request(format!("invalid patch payload for coupling: {error}"))
        })?;
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
        .retain(|entry| entry.coupling_id != coupling_id);
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
    let object = find_object_mut(&mut scene.objects, object_id)?;
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
        // RegionRealizationImpact independently checks magnetic support.
        assign_object_material(object, &scene.materials, material_ref, false);
    }
    if let Some(region_name) = req.region_name {
        let region_name = region_name.trim();
        let next_region_name = if region_name.is_empty() {
            None
        } else {
            Some(region_name.to_string())
        };
        if object.region_name != next_region_name {
            object.region_name = next_region_name;
            mesh_dirty = true;
        }
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
        let patch: fullmag_authoring::Transform3DPatch =
            serde_json::from_value(transform_value).map_err(|error| {
                ApiError::bad_request(format!("invalid object transform payload: {error}"))
            })?;
        object
            .transform
            .apply_patch(patch)
            .map_err(ApiError::bad_request)?;
        mesh_dirty = true;
    }
    if let Some(boundary_value) = req.absorbing_boundary {
        object.absorbing_boundary = boundary_value
            .map(|value| {
                serde_json::from_value(value).map_err(|error| {
                    ApiError::bad_request(format!("invalid absorbing boundary payload: {error}"))
                })
            })
            .transpose()?;
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
            return Err(ApiError::conflict_with_code(
                "revision_conflict",
                format!(
                    "scene revision mismatch: base={base_revision}, current={}",
                    scene.revision
                ),
            ));
        }
    }
    Ok(())
}

fn find_scene_object_mut<'a>(
    scene: &'a mut SceneDocument,
    object_id: &str,
) -> Result<&'a mut SceneObject, ApiError> {
    find_object_mut(&mut scene.objects, object_id)
}

/// Resolve a canonical object ID first, then accept a unique legacy name alias.
/// If the input is not an ID and matches multiple names, reject it instead of
/// mutating whichever object happens to appear first in the scene vector.
fn resolve_scene_object_index(
    objects: &[SceneObject],
    object_ref: &str,
) -> Result<usize, ApiError> {
    if let Some(index) = objects.iter().position(|entry| entry.id == object_ref) {
        return Ok(index);
    }

    let mut matches = objects
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.name == object_ref)
        .map(|(index, _)| index);
    let Some(index) = matches.next() else {
        return Err(ApiError::not_found(format!("object not found: {object_ref}")));
    };
    if matches.next().is_some() {
        return Err(ApiError::conflict(format!(
            "object name is ambiguous: {object_ref}; use the canonical object id"
        )));
    }
    Ok(index)
}

fn find_object_mut<'a>(
    objects: &'a mut [SceneObject],
    object_id: &str,
) -> Result<&'a mut SceneObject, ApiError> {
    let index = resolve_scene_object_index(objects, object_id)?;
    Ok(&mut objects[index])
}

#[derive(Clone, Copy)]
struct ObjectRegionOwnerBounds {
    center: [f64; 3],
    size: [f64; 3],
}

fn clamp_object_region_shape_to_owner(
    object: &SceneObject,
    region: &mut fullmag_authoring::SceneObjectRegion,
) {
    clamp_object_region_shape_to_owner_bounds(object_region_owner_bounds(object), region);
}

fn clamp_object_region_shape_to_owner_bounds(
    owner_bounds: Option<ObjectRegionOwnerBounds>,
    region: &mut fullmag_authoring::SceneObjectRegion,
) {
    if region.frame != fullmag_authoring::SceneRegionFrame::Object {
        return;
    }
    let Some(owner_bounds) = owner_bounds else {
        return;
    };
    clamp_shape_to_owner_bounds(&mut region.shape, owner_bounds);
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

fn clamp_shape_to_owner_bounds(
    shape: &mut fullmag_authoring::SceneRegionShape,
    owner_bounds: ObjectRegionOwnerBounds,
) {
    match shape {
        fullmag_authoring::SceneRegionShape::Box { size, center } => {
            let half_extents = [
                clamp_f64(size[0].max(0.0), 0.0, owner_bounds.size[0]) * 0.5,
                clamp_f64(size[1].max(0.0), 0.0, owner_bounds.size[1]) * 0.5,
                clamp_f64(size[2].max(0.0), 0.0, owner_bounds.size[2]) * 0.5,
            ];
            *center = clamp_center_to_owner(*center, half_extents, owner_bounds);
            *size = [
                half_extents[0] * 2.0,
                half_extents[1] * 2.0,
                half_extents[2] * 2.0,
            ];
        }
        fullmag_authoring::SceneRegionShape::Sphere { radius, center } => {
            let max_r = owner_bounds
                .size
                .iter()
                .copied()
                .fold(f64::INFINITY, f64::min)
                * 0.5;
            let r = clamp_f64(*radius, 0.0, max_r);
            let half_extents = [r, r, r];
            *center = clamp_center_to_owner(*center, half_extents, owner_bounds);
            *radius = r;
        }
        fullmag_authoring::SceneRegionShape::Cylinder {
            radius,
            height,
            center,
            axis,
        } => {
            let norm = axis.iter().map(|value| value * value).sum::<f64>().sqrt();
            let unit = if norm > 1e-15 {
                axis.map(|value| value / norm)
            } else {
                [0.0, 0.0, 1.0]
            };
            let axis_abs = unit.map(f64::abs);
            let owner_half = owner_bounds.size.map(|value| value * 0.5);
            let mut half_height = (*height).max(0.0) * 0.5;
            for index in 0..3 {
                if axis_abs[index] > 1e-15 {
                    half_height = half_height.min(owner_half[index] / axis_abs[index]);
                }
            }
            let mut r = (*radius).max(0.0);
            for index in 0..3 {
                let radial_factor = (1.0 - axis_abs[index] * axis_abs[index]).max(0.0).sqrt();
                if radial_factor > 1e-15 {
                    let available = (owner_half[index] - axis_abs[index] * half_height).max(0.0);
                    r = r.min(available / radial_factor);
                }
            }
            let half_extents = [0, 1, 2].map(|index| {
                axis_abs[index] * half_height
                    + r * (1.0 - axis_abs[index] * axis_abs[index]).max(0.0).sqrt()
            });
            *center = clamp_center_to_owner(*center, half_extents, owner_bounds);
            *height = half_height * 2.0;
            *radius = r;
        }
        fullmag_authoring::SceneRegionShape::Csg { .. } => {}
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

fn clamp_f64(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
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
    while object.regions.iter().any(|entry| entry.name == candidate) {
        candidate = format!("{base} {suffix}");
        suffix += 1;
    }
    candidate
}

fn seed_allocated_region_ids(object: &mut SceneObject) {
    let existing_ids: Vec<String> = object
        .regions
        .iter()
        .map(|region| region.region_id.clone())
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

fn coupling_references_region(
    coupling: &fullmag_authoring::SceneCoupling,
    object_id: &str,
    object_name: &str,
    region_id: &str,
) -> bool {
    endpoint_references_region(&coupling.source, object_id, object_name, region_id)
        || endpoint_references_region(&coupling.target, object_id, object_name, region_id)
}

fn coupling_references_object(
    coupling: &fullmag_authoring::SceneCoupling,
    object_id: &str,
    object_name: &str,
) -> bool {
    endpoint_references_object(&coupling.source, object_id, object_name)
        || endpoint_references_object(&coupling.target, object_id, object_name)
}

fn ensure_region_has_no_active_couplings(
    scene: &SceneDocument,
    object_id: &str,
    object_name: &str,
    region_id: &str,
) -> Result<(), ApiError> {
    if let Some(coupling) = scene
        .couplings
        .iter()
        .filter(|coupling| coupling.enabled)
        .find(|coupling| coupling_references_region(coupling, object_id, object_name, region_id))
    {
        let coupling_id = &coupling.coupling_id;
        return Err(ApiError::conflict(format!(
            "object region '{region_id}' is referenced by active coupling '{coupling_id}'; disable or delete the coupling before disabling the region"
        )));
    }
    Ok(())
}

fn ensure_active_coupling_targets_enabled_regions(
    scene: &SceneDocument,
    coupling: &fullmag_authoring::SceneCoupling,
) -> Result<(), ApiError> {
    if !coupling.enabled {
        return Ok(());
    }

    let check_endpoint = |endpoint: &fullmag_authoring::SceneCouplingEndpoint,
                          field_name: &str|
     -> Result<(), ApiError> {
        if let fullmag_authoring::SceneCouplingEndpoint::Region {
            object: object_id,
            region_id,
        } = endpoint
        {
            if scene.objects.iter().any(|object| {
                object.id == *object_id
                    && object
                        .regions
                        .iter()
                        .any(|region| region.region_id == *region_id && !region.enabled)
            }) {
                let coupling_id = &coupling.coupling_id;
                return Err(ApiError::conflict(format!(
                    "coupling '{coupling_id}' {field_name}.region_id '{region_id}' references disabled object_region"
                )));
            }
        }
        Ok(())
    };

    check_endpoint(&coupling.source, "source")?;
    check_endpoint(&coupling.target, "target")?;
    Ok(())
}

fn endpoint_references_region(
    endpoint: &fullmag_authoring::SceneCouplingEndpoint,
    object_id: &str,
    object_name: &str,
    region_id: &str,
) -> bool {
    match endpoint {
        fullmag_authoring::SceneCouplingEndpoint::Region {
            object,
            region_id: r_id,
        } => matches_deleted_object(object, object_id, object_name) && r_id == region_id,
        _ => false,
    }
}

fn endpoint_references_object(
    endpoint: &fullmag_authoring::SceneCouplingEndpoint,
    object_id: &str,
    object_name: &str,
) -> bool {
    match endpoint {
        fullmag_authoring::SceneCouplingEndpoint::Object { object }
        | fullmag_authoring::SceneCouplingEndpoint::Surface { object, .. }
        | fullmag_authoring::SceneCouplingEndpoint::Region { object, .. } => {
            matches_deleted_object(object, object_id, object_name)
        }
    }
}

fn matches_deleted_object(candidate: &str, object_id: &str, object_name: &str) -> bool {
    candidate == object_id || (!object_name.is_empty() && candidate == object_name)
}

fn field_target_matches(
    target: &fullmag_ir::FieldTargetIR,
    object_id: &str,
    object_name: &str,
    region_id: Option<&str>,
) -> bool {
    match (target, region_id) {
        (fullmag_ir::FieldTargetIR::Object { object_id: id }, None) => {
            matches_deleted_object(id, object_id, object_name)
        }
        (
            fullmag_ir::FieldTargetIR::Region {
                object_id: id,
                region_id: r_id,
            },
            None,
        ) => matches_deleted_object(id, object_id, object_name) || r_id == object_id,
        (
            fullmag_ir::FieldTargetIR::Region {
                object_id: id,
                region_id: r_id,
            },
            Some(target_region_id),
        ) => matches_deleted_object(id, object_id, object_name) && r_id == target_region_id,
        _ => false,
    }
}

fn monitor_target_matches(
    target: &fullmag_ir::MonitorTargetIR,
    object_id: &str,
    object_name: &str,
    region_id: Option<&str>,
) -> bool {
    match (target, region_id) {
        (fullmag_ir::MonitorTargetIR::Object { object_id: id }, None) => {
            matches_deleted_object(id, object_id, object_name)
        }
        (
            fullmag_ir::MonitorTargetIR::Region {
                object_id: id,
                region_id: _,
            },
            None,
        ) => matches_deleted_object(id, object_id, object_name),
        (
            fullmag_ir::MonitorTargetIR::Region {
                object_id: id,
                region_id: r_id,
            },
            Some(target_region_id),
        ) => matches_deleted_object(id, object_id, object_name) && r_id == target_region_id,
        _ => false,
    }
}

fn selection_scalar_matches(
    scalar: &fullmag_ir::SelectionScalarExprIR,
    object_id: &str,
    object_name: &str,
) -> bool {
    match scalar {
        fullmag_ir::SelectionScalarExprIR::Coordinate {
            frame: fullmag_ir::SelectionFrameIR::Object { object_id: id },
            ..
        } => matches_deleted_object(id, object_id, object_name),
        fullmag_ir::SelectionScalarExprIR::Abs { value } => {
            selection_scalar_matches(value, object_id, object_name)
        }
        _ => false,
    }
}

fn selection_expr_matches(
    expr: &fullmag_ir::SelectionExprIR,
    object_id: &str,
    object_name: &str,
    region_id: Option<&str>,
    removed_selection_ids: &std::collections::BTreeSet<String>,
) -> bool {
    match expr {
        fullmag_ir::SelectionExprIR::AllMagnetic {} => false,
        fullmag_ir::SelectionExprIR::InObject { object_id: id } => {
            region_id.is_none() && matches_deleted_object(id, object_id, object_name)
        }
        fullmag_ir::SelectionExprIR::InRegion {
            object_id: id,
            region_id: r_id,
        } => {
            matches_deleted_object(id, object_id, object_name)
                && region_id.map_or(true, |target_region| r_id == target_region)
        }
        fullmag_ir::SelectionExprIR::InsideGeometry {
            frame: fullmag_ir::SelectionFrameIR::Object { object_id: id },
            ..
        } => region_id.is_none() && matches_deleted_object(id, object_id, object_name),
        fullmag_ir::SelectionExprIR::InsideGeometry { .. } => false,
        fullmag_ir::SelectionExprIR::Compare { lhs, rhs, .. } => {
            region_id.is_none()
                && (selection_scalar_matches(lhs, object_id, object_name)
                    || selection_scalar_matches(rhs, object_id, object_name))
        }
        fullmag_ir::SelectionExprIR::Approx { value, target, .. } => {
            region_id.is_none()
                && (selection_scalar_matches(value, object_id, object_name)
                    || selection_scalar_matches(target, object_id, object_name))
        }
        fullmag_ir::SelectionExprIR::Between { value, .. } => {
            region_id.is_none() && selection_scalar_matches(value, object_id, object_name)
        }
        fullmag_ir::SelectionExprIR::And { expressions }
        | fullmag_ir::SelectionExprIR::Or { expressions }
        | fullmag_ir::SelectionExprIR::Xor { expressions } => expressions.iter().any(|child| {
            selection_expr_matches(child, object_id, object_name, region_id, removed_selection_ids)
        }),
        fullmag_ir::SelectionExprIR::Not { expression } => selection_expr_matches(
            expression,
            object_id,
            object_name,
            region_id,
            removed_selection_ids,
        ),
        fullmag_ir::SelectionExprIR::Ref { selection_id } => {
            removed_selection_ids.contains(selection_id)
        }
    }
}

fn scene_region_ref_matches(
    reference: &fullmag_authoring::SceneRegionRef,
    object_id: &str,
    object_name: &str,
    region_id: Option<&str>,
) -> bool {
    if !matches_deleted_object(&reference.object_id, object_id, object_name) {
        return false;
    }
    match region_id {
        None => true,
        Some(target_region) => reference.region_id.as_deref() == Some(target_region),
    }
}

fn scene_surface_ref_matches(
    surface: &fullmag_authoring::SceneSurfaceRef,
    object_id: &str,
    object_name: &str,
) -> bool {
    matches_deleted_object(&surface.object_id, object_id, object_name)
}

fn current_transport_matches(
    transport: &SceneCurrentTransport,
    object_id: &str,
    object_name: &str,
    region_id: Option<&str>,
) -> bool {
    let Some(known) = transport.known() else {
        return false;
    };
    if region_id.is_none()
        && known
            .solve_region
            .as_deref()
            .is_some_and(|region| matches_deleted_object(region, object_id, object_name))
    {
        return true;
    }
    if known
        .domain
        .iter()
        .any(|entry| scene_region_ref_matches(entry, object_id, object_name, region_id))
    {
        return true;
    }
    if known
        .materials
        .iter()
        .any(|entry| scene_region_ref_matches(&entry.region, object_id, object_name, region_id))
    {
        return true;
    }
    if region_id.is_none()
        && known.boundaries.iter().any(|boundary| {
            let surfaces = match boundary {
                fullmag_authoring::SceneChargeBoundary::EquipotentialCurrentTerminal {
                    surfaces,
                    ..
                }
                | fullmag_authoring::SceneChargeBoundary::VoltageElectrode { surfaces, .. }
                | fullmag_authoring::SceneChargeBoundary::NormalCurrentElectrode {
                    surfaces, ..
                }
                | fullmag_authoring::SceneChargeBoundary::Insulating { surfaces, .. } => surfaces,
            };
            surfaces
                .iter()
                .any(|surface| scene_surface_ref_matches(surface, object_id, object_name))
        })
    {
        return true;
    }
    if let Some(fullmag_authoring::SceneStructuredCurrentClosure::ClosedGeometry {
        source_cuts,
        ..
    }) = &known.structured_current_closure
    {
        if source_cuts
            .iter()
            .any(|cut| scene_region_ref_matches(&cut.region, object_id, object_name, region_id))
        {
            return true;
        }
    }
    false
}

fn spin_transport_matches(
    transport: &SceneSpinTransport,
    object_id: &str,
    object_name: &str,
    region_id: Option<&str>,
    removed_current_transports: &std::collections::BTreeSet<String>,
) -> bool {
    let Some(known) = transport.known() else {
        return false;
    };
    if removed_current_transports.contains(&known.current_source_id) {
        return true;
    }
    if known
        .domain
        .iter()
        .any(|entry| scene_region_ref_matches(entry, object_id, object_name, region_id))
    {
        return true;
    }
    if known
        .materials
        .iter()
        .any(|entry| scene_region_ref_matches(&entry.region, object_id, object_name, region_id))
    {
        return true;
    }
    if known.interfaces.iter().any(|interface| match interface {
        SceneSpinInterface::Transparent { side_a, side_b, .. } => {
            scene_region_ref_matches(side_a, object_id, object_name, region_id)
                || scene_region_ref_matches(side_b, object_id, object_name, region_id)
        }
        SceneSpinInterface::MixingConductance {
            normal_side,
            ferromagnet_side,
            normal_surface,
            ferromagnet_surface,
            ..
        } => {
            scene_region_ref_matches(normal_side, object_id, object_name, region_id)
                || scene_region_ref_matches(ferromagnet_side, object_id, object_name, region_id)
                || (region_id.is_none()
                    && (normal_surface.as_ref().is_some_and(|surface| {
                        scene_surface_ref_matches(surface, object_id, object_name)
                    }) || ferromagnet_surface.as_ref().is_some_and(|surface| {
                        scene_surface_ref_matches(surface, object_id, object_name)
                    })))
        }
    }) {
        return true;
    }
    if region_id.is_none()
        && known.boundaries.iter().any(|boundary| match boundary {
            fullmag_authoring::SceneSpinBoundary::HomogeneousSpinPotentialGradient {
                surfaces,
                ..
            }
            | fullmag_authoring::SceneSpinBoundary::SpinInsulating { surfaces, .. }
            | fullmag_authoring::SceneSpinBoundary::SpinSink { surfaces, .. }
            | fullmag_authoring::SceneSpinBoundary::SpecifiedSpinPotential { surfaces, .. }
            | fullmag_authoring::SceneSpinBoundary::SpecifiedSpinFlux { surfaces, .. } => surfaces
                .iter()
                .any(|surface| scene_surface_ref_matches(surface, object_id, object_name)),
            fullmag_authoring::SceneSpinBoundary::PeriodicSpin {
                minus_surface,
                plus_surface,
                ..
            } => {
                scene_surface_ref_matches(minus_surface, object_id, object_name)
                    || scene_surface_ref_matches(plus_surface, object_id, object_name)
            }
        })
    {
        return true;
    }
    false
}

fn spin_torque_matches(
    torque: &SceneSpinTorque,
    object_id: &str,
    object_name: &str,
    region_id: Option<&str>,
    removed_current_transports: &std::collections::BTreeSet<String>,
    removed_spin_transports: &std::collections::BTreeSet<String>,
) -> bool {
    let SceneSpinTorque::Known(known) = torque else {
        return false;
    };
    match known {
        fullmag_authoring::KnownSceneSpinTorque::Slonczewski {
            target,
            current_source,
            ..
        }
        | fullmag_authoring::KnownSceneSpinTorque::ZhangLi {
            target,
            current_source,
            ..
        } => {
            target
                .as_ref()
                .is_some_and(|t| scene_region_ref_matches(t, object_id, object_name, region_id))
                || current_source
                    .as_deref()
                    .is_some_and(|src| removed_current_transports.contains(src))
        }
        fullmag_authoring::KnownSceneSpinTorque::PrescribedSot { target, drive, .. } => {
            let drive_matches = match drive {
                fullmag_authoring::ScenePrescribedSotDrive::VectorCurrentSource {
                    current_source_id,
                    ..
                }
                | fullmag_authoring::ScenePrescribedSotDrive::LegacyCurrentSourceNorm {
                    current_source_id,
                } => removed_current_transports.contains(current_source_id),
                _ => false,
            };
            drive_matches
                || target
                    .as_ref()
                    .is_some_and(|t| scene_region_ref_matches(t, object_id, object_name, region_id))
        }
        fullmag_authoring::KnownSceneSpinTorque::DriftDiffusionSpinTorque {
            solve_id,
            target,
            ..
        } => {
            removed_spin_transports.contains(solve_id)
                || scene_region_ref_matches(target, object_id, object_name, region_id)
        }
    }
}

fn staged_drive_payload_matches(
    drive_value: Option<&Value>,
    object_id: &str,
    object_name: &str,
    region_id: Option<&str>,
) -> bool {
    let Some(drive_value) = drive_value else {
        return false;
    };
    if let Ok(mask_drive) = serde_json::from_value::<fullmag_ir::MaskFieldDriveIR>(drive_value.clone())
    {
        return field_target_matches(&mask_drive.target, object_id, object_name, region_id);
    }
    if let Ok(regional_drive) =
        serde_json::from_value::<fullmag_ir::RegionalFieldDriveIR>(drive_value.clone())
    {
        return field_target_matches(&regional_drive.target, object_id, object_name, region_id)
            || (region_id.is_none()
                && matches!(
                    &regional_drive.spatial_profile,
                    fullmag_ir::FieldSpatialProfileIR::GeometryMask { object_id: mask_obj, .. }
                        if matches_deleted_object(mask_obj, object_id, object_name)
                ));
    }
    if let Some(target) = drive_value.get("target") {
        if let Ok(parsed) = serde_json::from_value::<fullmag_ir::FieldTargetIR>(target.clone()) {
            return field_target_matches(&parsed, object_id, object_name, region_id);
        }
    }
    false
}

fn cleanup_pipeline_nodes_for_deleted_target(
    nodes: &mut Vec<fullmag_authoring::StudyPipelineNode>,
    object_id: &str,
    object_name: &str,
    region_id: Option<&str>,
    removed_antenna_stage_ids: &std::collections::BTreeSet<String>,
) {
    nodes.retain_mut(|node| match node {
        fullmag_authoring::StudyPipelineNode::Primitive(primitive) => {
            if matches!(
                primitive.stage_kind,
                fullmag_authoring::StudyPrimitiveStageKind::AddFieldDrive
                    | fullmag_authoring::StudyPrimitiveStageKind::AddMaskFieldDrive
            ) && staged_drive_payload_matches(
                primitive.payload.get("drive"),
                object_id,
                object_name,
                region_id,
            ) {
                return false;
            }
            if primitive.stage_kind
                == fullmag_authoring::StudyPrimitiveStageKind::AntennaFieldSolve
            {
                if primitive
                    .payload
                    .get("stage_id")
                    .and_then(Value::as_str)
                    .is_some_and(|stage_id| removed_antenna_stage_ids.contains(stage_id))
                    || primitive
                        .payload
                        .get("antenna_stage_id")
                        .and_then(Value::as_str)
                        .is_some_and(|stage_id| removed_antenna_stage_ids.contains(stage_id))
                {
                    return false;
                }
            }
            if region_id.is_none() {
                let binds_deleted_object = ["object_id", "object", "magnet_name"]
                    .iter()
                    .any(|key| {
                        primitive
                            .payload
                            .get(*key)
                            .and_then(Value::as_str)
                            .is_some_and(|value| {
                                matches_deleted_object(value, object_id, object_name)
                            })
                    });
                if binds_deleted_object {
                    return false;
                }
            }
            true
        }
        fullmag_authoring::StudyPipelineNode::Group(group) => {
            cleanup_pipeline_nodes_for_deleted_target(
                &mut group.children,
                object_id,
                object_name,
                region_id,
                removed_antenna_stage_ids,
            );
            true
        }
        fullmag_authoring::StudyPipelineNode::Macro(_) => true,
    });
}

fn cascade_cleanup_scene_references(
    scene: &mut SceneDocument,
    object_id: &str,
    object_name: &str,
    region_id: Option<&str>,
) {
    // 1. Couplings
    if let Some(target_region_id) = region_id {
        scene.couplings.retain(|coupling| {
            !coupling_references_region(coupling, object_id, object_name, target_region_id)
        });
    } else {
        scene
            .couplings
            .retain(|coupling| !coupling_references_object(coupling, object_id, object_name));
    }

    // 2. Regional & mask field drives
    scene.field_drives.drives.retain(|drive| {
        let target_hit = field_target_matches(&drive.target, object_id, object_name, region_id);
        let mask_hit = region_id.is_none()
            && matches!(
                &drive.spatial_profile,
                fullmag_ir::FieldSpatialProfileIR::GeometryMask { object_id: mask_obj, .. }
                    if matches_deleted_object(mask_obj, object_id, object_name)
            );
        !target_hit && !mask_hit
    });
    scene
        .field_drives
        .mask_drives
        .retain(|drive| !field_target_matches(&drive.target, object_id, object_name, region_id));

    // 3. Planar monitors
    scene
        .monitors
        .planar
        .retain(|monitor| !monitor_target_matches(&monitor.target, object_id, object_name, region_id));

    // 4. Selections & frozen spins (magnetization_constraints), with transitive Ref cleanup
    let mut removed_selection_ids = std::collections::BTreeSet::new();
    loop {
        let before = removed_selection_ids.len();
        for selection in &scene.selections {
            if !removed_selection_ids.contains(&selection.id)
                && selection_expr_matches(
                    &selection.expression,
                    object_id,
                    object_name,
                    region_id,
                    &removed_selection_ids,
                )
            {
                removed_selection_ids.insert(selection.id.clone());
            }
        }
        if removed_selection_ids.len() == before {
            break;
        }
    }
    scene
        .selections
        .retain(|selection| !removed_selection_ids.contains(&selection.id));
    scene.magnetization_constraints.retain(|constraint| {
        !selection_expr_matches(
            &constraint.frozen_spins().selector,
            object_id,
            object_name,
            region_id,
            &removed_selection_ids,
        )
    });

    // 5. Current transports -> spin transports -> spin torques & oersted fields
    let mut removed_current_transports = std::collections::BTreeSet::new();
    scene.current_transports.retain(|transport| {
        if current_transport_matches(transport, object_id, object_name, region_id) {
            if let Some(name) = transport.name() {
                removed_current_transports.insert(name.to_string());
            }
            false
        } else {
            true
        }
    });
    let mut removed_spin_transports = std::collections::BTreeSet::new();
    scene.spin_transports.retain(|transport| {
        if spin_transport_matches(
            transport,
            object_id,
            object_name,
            region_id,
            &removed_current_transports,
        ) {
            if let Some(id) = transport.id() {
                removed_spin_transports.insert(id.to_string());
            }
            false
        } else {
            true
        }
    });
    scene.spin_torques.retain(|torque| {
        !spin_torque_matches(
            torque,
            object_id,
            object_name,
            region_id,
            &removed_current_transports,
            &removed_spin_transports,
        )
    });
    scene.oersted_fields.retain(|field| {
        !matches!(
            field,
            SceneOerstedField::Known(fullmag_authoring::KnownSceneOerstedField::OerstedField {
                source,
                ..
            }) if removed_current_transports.contains(source)
        )
    });

    // 6. Antenna port modes -> field solve stages -> target projections -> solved drives / spectra
    let mut removed_port_mode_ids = std::collections::BTreeSet::new();
    scene.antenna_port_modes.retain(|port_mode| {
        let hit = (region_id.is_none()
            && matches_deleted_object(&port_mode.source_object_id, object_id, object_name))
            || removed_current_transports.contains(&port_mode.current_transport_id);
        if hit {
            removed_port_mode_ids.insert(port_mode.id.clone());
            false
        } else {
            true
        }
    });
    let mut removed_antenna_stage_ids = std::collections::BTreeSet::new();
    scene.antenna_field_solve_stages.retain_mut(|stage| {
        let hit = (region_id.is_none()
            && matches_deleted_object(&stage.source_object_id, object_id, object_name))
            || removed_current_transports.contains(&stage.current_transport_id)
            || stage
                .port_mode_ids
                .iter()
                .any(|port_id| removed_port_mode_ids.contains(port_id))
            || field_target_matches(
                &stage.field_sampling_domain,
                object_id,
                object_name,
                region_id,
            );
        if hit {
            removed_antenna_stage_ids.insert(stage.id.clone());
            return false;
        }
        let had_targets = !stage.target_refs.is_empty();
        stage
            .target_refs
            .retain(|target| !field_target_matches(target, object_id, object_name, region_id));
        if had_targets && stage.target_refs.is_empty() {
            removed_antenna_stage_ids.insert(stage.id.clone());
            false
        } else {
            true
        }
    });
    let mut removed_projection_ids = std::collections::BTreeSet::new();
    scene.antenna_target_projections.retain(|projection| {
        let hit = removed_antenna_stage_ids.contains(projection.solution.stage_id())
            || field_target_matches(&projection.target, object_id, object_name, region_id);
        if hit {
            removed_projection_ids.insert(projection.id.clone());
            false
        } else {
            true
        }
    });
    scene.solved_antenna_drives.retain(|drive| {
        !removed_projection_ids.contains(&drive.projection_ref)
            && !removed_port_mode_ids.contains(&drive.port_mode_id)
    });
    scene.antenna_spectrum_requests.retain(|request| {
        let stage_hit = removed_antenna_stage_ids.contains(request.solution_ref.stage_id());
        let port_hit = request
            .port_mode_id
            .as_deref()
            .is_some_and(|port_id| removed_port_mode_ids.contains(port_id));
        let target_hit = field_target_matches(&request.target, object_id, object_name, region_id);
        !stage_hit && !port_hit && !target_hit
    });

    // 7. Study stages & study pipeline bindings
    scene.study.stages.retain(|stage| {
        if matches!(
            stage.kind.as_str(),
            "add_field_drive" | "add_mask_field_drive"
        ) && staged_drive_payload_matches(
            stage.extra.get("drive"),
            object_id,
            object_name,
            region_id,
        ) {
            return false;
        }
        if stage.kind == "antenna_field_solve"
            && (stage
                .extra
                .get("stage_id")
                .and_then(Value::as_str)
                .is_some_and(|id| removed_antenna_stage_ids.contains(id))
                || stage
                    .extra
                    .get("antenna_stage_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| removed_antenna_stage_ids.contains(id)))
        {
            return false;
        }
        if region_id.is_none() {
            let binds_deleted_object = ["object_id", "object", "magnet_name"].iter().any(|key| {
                stage
                    .extra
                    .get(*key)
                    .and_then(Value::as_str)
                    .is_some_and(|value| matches_deleted_object(value, object_id, object_name))
            });
            if binds_deleted_object {
                return false;
            }
        }
        true
    });
    if let Some(pipeline) = scene.study.study_pipeline.as_mut() {
        cleanup_pipeline_nodes_for_deleted_target(
            &mut pipeline.nodes,
            object_id,
            object_name,
            region_id,
            &removed_antenna_stage_ids,
        );
    }
}

fn cascade_cleanup_deleted_object_references(
    scene: &mut SceneDocument,
    object_id: &str,
    object_name: &str,
) {
    let object_name = unambiguous_deleted_object_name(scene, object_id, object_name);
    cascade_cleanup_scene_references(scene, object_id, object_name, None);

    // Study per-object FDM grid (BKG-028)
    if let Some(fdm) = scene.study.fdm.as_mut() {
        fdm.per_object_grid
            .retain(|key, _| !matches_deleted_object(key, object_id, object_name));
    }

    // Study rotated interfacial DMI scope
    if let Some(ids) = scene.study.rotated_interfacial_dmi_object_ids.as_mut() {
        ids.retain(|id| !matches_deleted_object(id, object_id, object_name));
        if ids.is_empty() {
            scene.study.rotated_interfacial_dmi_object_ids = None;
        }
    }

    // Study mesh interfaces referencing the deleted object
    scene.study.mesh_interfaces.retain(|interface| {
        !matches_deleted_object(&interface.owner_a, object_id, object_name)
            && !matches_deleted_object(&interface.owner_b, object_id, object_name)
    });

    // Study initial state targeting the deleted object
    if scene
        .study
        .initial_state
        .as_ref()
        .and_then(|state| state.magnet_name.as_deref())
        .is_some_and(|name| matches_deleted_object(name, object_id, object_name))
    {
        scene.study.initial_state = None;
    }

    // Editor view/selection state referencing the deleted object
    if scene
        .editor
        .selected_object_id
        .as_deref()
        .is_some_and(|id| matches_deleted_object(id, object_id, object_name))
    {
        scene.editor.selected_object_id = None;
    }
    if scene
        .editor
        .selected_entity_id
        .as_deref()
        .is_some_and(|id| matches_deleted_object(id, object_id, object_name))
    {
        scene.editor.selected_entity_id = None;
    }
    if scene
        .editor
        .focused_entity_id
        .as_deref()
        .is_some_and(|id| matches_deleted_object(id, object_id, object_name))
    {
        scene.editor.focused_entity_id = None;
    }
    scene
        .editor
        .mesh_entity_view_state
        .retain(|key, _| !matches_deleted_object(key, object_id, object_name));
    for preset in &mut scene.editor.visualization_presets {
        preset
            .fem
            .mesh_entity_view_state
            .retain(|key, _| !matches_deleted_object(key, object_id, object_name));
    }
}

fn cascade_cleanup_deleted_region_references(
    scene: &mut SceneDocument,
    object_id: &str,
    object_name: &str,
    region_id: &str,
) {
    let object_name = unambiguous_deleted_object_name(scene, object_id, object_name);
    cascade_cleanup_scene_references(scene, object_id, object_name, Some(region_id));
}

fn unambiguous_deleted_object_name<'a>(
    scene: &SceneDocument,
    object_id: &str,
    object_name: &'a str,
) -> &'a str {
    if scene.objects.iter().any(|object| {
        object.id != object_id && (object.id == object_name || object.name == object_name)
    }) {
        ""
    } else {
        object_name
    }
}

const MAX_BOOLEAN_OPERANDS: usize = 256;

fn boolean_op_to_geometry_kind(op: &str) -> Result<&'static str, ApiError> {
    match op {
        "union" => Ok("Union"),
        "subtract" | "difference" => Ok("Difference"),
        "intersect" | "intersection" => Ok("Intersection"),
        "xor" => Ok("Xor"),
        other => Err(ApiError::bad_request(format!(
            "unsupported boolean operation '{other}'; expected union, subtract, intersect, or xor"
        ))),
    }
}

fn quat_normalize(q: [f64; 4]) -> Result<[f64; 4], ApiError> {
    if !q.iter().all(|v| v.is_finite()) {
        return Err(ApiError::bad_request(
            "rotation_quat must contain finite values",
        ));
    }
    let norm = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if !norm.is_finite() || norm <= 1e-12 {
        return Err(ApiError::bad_request("rotation_quat must have non-zero norm"));
    }
    Ok([q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm])
}

fn quat_conj(q: [f64; 4]) -> [f64; 4] {
    [-q[0], -q[1], -q[2], q[3]]
}

fn quat_mul(a: [f64; 4], b: [f64; 4]) -> [f64; 4] {
    [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ]
}

fn quat_rotate_vec3(q: [f64; 4], v: [f64; 3]) -> [f64; 3] {
    let [qx, qy, qz, qw] = q;
    let tx = 2.0 * (qy * v[2] - qz * v[1]);
    let ty = 2.0 * (qz * v[0] - qx * v[2]);
    let tz = 2.0 * (qx * v[1] - qy * v[0]);
    [
        v[0] + qw * tx + (qy * tz - qz * ty),
        v[1] + qw * ty + (qz * tx - qx * tz),
        v[2] + qw * tz + (qx * ty - qy * tx),
    ]
}

fn is_isotropic_scale(scale: [f64; 3]) -> bool {
    let s = scale[0];
    s.is_finite()
        && s > 0.0
        && (scale[1] - s).abs() <= 1e-12 * s.max(1.0)
        && (scale[2] - s).abs() <= 1e-12 * s.max(1.0)
}

/// Exact TRS decomposition of `M_target^{-1} * M_tool` when `target.scale` is isotropic.
fn relative_transform_isotropic(
    target: &Transform3D,
    tool: &Transform3D,
) -> Result<Transform3D, ApiError> {
    let s_a = target.scale[0];
    let q_a = quat_normalize(target.rotation_quat)?;
    let q_b = quat_normalize(tool.rotation_quat)?;
    let q_a_inv = quat_conj(q_a);
    let rel_rot = quat_normalize(quat_mul(q_a_inv, q_b))?;
    let rel_scale = [tool.scale[0] / s_a, tool.scale[1] / s_a, tool.scale[2] / s_a];
    let delta = [
        tool.pivot[0] + tool.translation[0] - target.pivot[0] - target.translation[0],
        tool.pivot[1] + tool.translation[1] - target.pivot[1] - target.translation[1],
        tool.pivot[2] + tool.translation[2] - target.pivot[2] - target.translation[2],
    ];
    let rotated = quat_rotate_vec3(q_a_inv, delta);
    let rel_translation = [
        rotated[0] / s_a + target.pivot[0] - tool.pivot[0],
        rotated[1] / s_a + target.pivot[1] - tool.pivot[1],
        rotated[2] / s_a + target.pivot[2] - tool.pivot[2],
    ];
    Ok(Transform3D {
        translation: rel_translation,
        rotation_quat: rel_rot,
        scale: rel_scale,
        pivot: tool.pivot,
    })
}

fn embed_geometry_transform(geometry: SceneGeometry, transform: &Transform3D) -> SceneGeometry {
    if transform.is_identity() {
        return geometry;
    }
    SceneGeometry {
        source_asset: None,
        geometry_kind: "Transform".to_string(),
        geometry_params: serde_json::json!({ "child": geometry, "transform": transform }),
        bounds_min: None,
        bounds_max: None,
    }
}

fn boolean_tool_geometry_in_target_frame(
    target: &Transform3D,
    tool: &SceneObject,
) -> Result<(SceneGeometry, Transform3D), ApiError> {
    if is_isotropic_scale(target.scale) {
        let relative = relative_transform_isotropic(target, &tool.transform)?;
        return Ok((tool.geometry.clone(), relative));
    }

    // An anisotropic inverse must undo rotation before scale. Keep those
    // operations separate so the target's object-space frame stays intact.
    let inverse_rotation = quat_conj(quat_normalize(target.rotation_quat)?);
    let undo_rigid = Transform3D {
        translation: quat_rotate_vec3(inverse_rotation, target.translation.map(|v| -v)),
        rotation_quat: inverse_rotation,
        pivot: target.pivot,
        ..Transform3D::default()
    };
    let undo_scale = Transform3D {
        scale: target.scale.map(f64::recip),
        pivot: target.pivot,
        ..Transform3D::default()
    };
    let tool_in_world = embed_geometry_transform(tool.geometry.clone(), &tool.transform);
    let geometry = embed_geometry_transform(tool_in_world, &undo_rigid);
    Ok((geometry, undo_scale))
}

/// Exact TRS composition `M_parent * M_child` when `parent.scale` is isotropic.
fn compose_transforms_isotropic(
    parent: &Transform3D,
    child: &Transform3D,
) -> Result<Transform3D, ApiError> {
    let s_p = parent.scale[0];
    let q_p = quat_normalize(parent.rotation_quat)?;
    let q_c = quat_normalize(child.rotation_quat)?;
    let comp_rot = quat_normalize(quat_mul(q_p, q_c))?;
    let comp_scale = [child.scale[0] * s_p, child.scale[1] * s_p, child.scale[2] * s_p];
    let shifted = [
        (child.pivot[0] + child.translation[0] - parent.pivot[0]) * s_p,
        (child.pivot[1] + child.translation[1] - parent.pivot[1]) * s_p,
        (child.pivot[2] + child.translation[2] - parent.pivot[2]) * s_p,
    ];
    let rotated = quat_rotate_vec3(q_p, shifted);
    let comp_translation = [
        rotated[0] + parent.pivot[0] + parent.translation[0] - child.pivot[0],
        rotated[1] + parent.pivot[1] + parent.translation[1] - child.pivot[1],
        rotated[2] + parent.pivot[2] + parent.translation[2] - child.pivot[2],
    ];
    Ok(Transform3D {
        translation: comp_translation,
        rotation_quat: comp_rot,
        scale: comp_scale,
        pivot: child.pivot,
    })
}

fn allocate_unique_object_id(scene: &SceneDocument, base_id: &str) -> String {
    let clean_base = base_id.trim();
    let seed = if clean_base.is_empty() {
        "object"
    } else {
        clean_base
    };
    let mut candidate = seed.to_string();
    let mut suffix = 2u64;
    while scene
        .objects
        .iter()
        .any(|entry| entry.id == candidate || entry.name == candidate)
    {
        candidate = format!("{seed}_{suffix}");
        suffix += 1;
    }
    candidate
}

fn allocate_unique_operand_id(
    existing: &[fullmag_authoring::SceneBooleanOperand],
    prefix: &str,
) -> String {
    allocate_unique_operand_id_excluding(existing, &std::collections::BTreeSet::new(), prefix)
}

fn allocate_unique_operand_id_excluding(
    existing: &[fullmag_authoring::SceneBooleanOperand],
    reserved: &std::collections::BTreeSet<String>,
    prefix: &str,
) -> String {
    let clean = prefix.trim();
    let base = if clean.is_empty() { "op" } else { clean };
    let mut suffix = 1u64;
    let mut candidate = format!("{base}:{suffix}");
    while reserved.contains(&candidate)
        || existing.iter().any(|entry| entry.operand_id == candidate)
    {
        suffix += 1;
        candidate = format!("{base}:{suffix}");
    }
    candidate
}

fn extract_boolean_operands(
    geometry: &SceneGeometry,
    fallback_base_label: &str,
) -> Result<Vec<fullmag_authoring::SceneBooleanOperand>, ApiError> {
    let params = &geometry.geometry_params;
    if let Some(raw_operands) = params
        .get("operands")
        .or_else(|| params.get("children"))
        .and_then(Value::as_array)
    {
        // Reserve every canonical ID before synthesizing IDs for legacy raw
        // geometry entries, so a mixed array cannot mint an ID used later.
        let reserved_operand_ids = raw_operands
            .iter()
            .filter_map(|raw| {
                serde_json::from_value::<fullmag_authoring::SceneBooleanOperand>(raw.clone()).ok()
            })
            .map(|operand| operand.operand_id)
            .collect::<std::collections::BTreeSet<_>>();
        let mut seen_operand_ids = std::collections::BTreeSet::new();
        let mut operands = Vec::with_capacity(raw_operands.len());
        for (index, raw) in raw_operands.iter().enumerate() {
            if let Ok(operand) =
                serde_json::from_value::<fullmag_authoring::SceneBooleanOperand>(raw.clone())
            {
                if operand.operand_id.trim().is_empty() {
                    return Err(ApiError::bad_request(format!(
                        "boolean operand at index {index} must have a nonempty operand_id"
                    )));
                }
                if !seen_operand_ids.insert(operand.operand_id.clone()) {
                    return Err(ApiError::bad_request(format!(
                        "duplicate boolean operand_id '{}'",
                        operand.operand_id
                    )));
                }
                operands.push(operand);
            } else {
                let child_geom: SceneGeometry =
                    serde_json::from_value(raw.clone()).map_err(|error| {
                        ApiError::bad_request(format!(
                            "invalid boolean operand at index {index}: {error}"
                        ))
                    })?;
                let operand_id = allocate_unique_operand_id_excluding(
                    &operands,
                    &reserved_operand_ids,
                    "op",
                );
                operands.push(fullmag_authoring::SceneBooleanOperand {
                    operand_id,
                    label: if index == 0 {
                        fallback_base_label.to_string()
                    } else {
                        format!("Tool {index}")
                    },
                    enabled: true,
                    geometry: child_geom,
                    transform: None,
                    source_object_id: None,
                });
            }
        }
        return Ok(operands);
    }

    // Legacy binary layout: { base, tool }, { a, b }, or { left, right }
    let left_raw = params
        .get("base")
        .or_else(|| params.get("a"))
        .or_else(|| params.get("left"));
    let right_raw = params
        .get("tool")
        .or_else(|| params.get("b"))
        .or_else(|| params.get("right"));
    if let (Some(left_raw), Some(right_raw)) = (left_raw, right_raw) {
        let left_geom: SceneGeometry = serde_json::from_value(left_raw.clone()).map_err(|e| {
            ApiError::bad_request(format!("invalid legacy boolean base geometry: {e}"))
        })?;
        let right_geom: SceneGeometry =
            serde_json::from_value(right_raw.clone()).map_err(|e| {
                ApiError::bad_request(format!("invalid legacy boolean tool geometry: {e}"))
            })?;
        return Ok(vec![
            fullmag_authoring::SceneBooleanOperand {
                operand_id: "op:1".to_string(),
                label: fallback_base_label.to_string(),
                enabled: true,
                geometry: left_geom,
                transform: None,
                source_object_id: None,
            },
            fullmag_authoring::SceneBooleanOperand {
                operand_id: "op:2".to_string(),
                label: "Tool 1".to_string(),
                enabled: true,
                geometry: right_geom,
                transform: None,
                source_object_id: None,
            },
        ]);
    }

    Err(ApiError::bad_request(
        "object geometry is not a boolean CSG node with operands",
    ))
}

fn promote_tool_object_to_region(
    target: &mut SceneObject,
    tool: &SceneObject,
) -> Result<(), ApiError> {
    let base_name = if tool.name.trim().is_empty() {
        tool.id.as_str()
    } else {
        tool.name.as_str()
    };
    let mut region_name = base_name.to_string();
    let mut suffix = 2u64;
    while target.regions.iter().any(|entry| entry.name == region_name) {
        region_name = format!("{base_name} {suffix}");
        suffix += 1;
    }
    let lowered = crate::router_v2::handlers::simulation::commands::scene_object_geometry_entry(
        tool,
        &region_name,
    )?;
    let region_id = allocate_object_region_id(target);
    let next_priority = target
        .regions
        .iter()
        .map(|entry| entry.priority)
        .max()
        .unwrap_or(0)
        + 1;
    target.regions.push(fullmag_authoring::SceneObjectRegion {
        region_id,
        owner_object: target.id.clone(),
        name: region_name,
        shape: fullmag_authoring::SceneRegionShape::Csg {
            expression: Box::new(lowered),
        },
        frame: fullmag_authoring::SceneRegionFrame::World,
        enabled: true,
        priority: next_priority,
        mesh_policy: None,
        material_overrides: Vec::new(),
        texture_override: None,
        material_transition: None,
        realization_policy: fullmag_authoring::SceneRegionRealizationPolicy::Conformal,
    });
    Ok(())
}

fn apply_boolean_combine_objects_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    op: &str,
    target_object_id: &str,
    tool_object_ids: &[String],
    keep_tools: bool,
    region_merge_policy: Option<&str>,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    if tool_object_ids.is_empty() {
        return Err(ApiError::bad_request(
            "boolean_combine_objects requires at least one tool_object_id",
        ));
    }
    if let Some(policy) = region_merge_policy {
        if !matches!(policy, "keep_target_only" | "promote_tools_to_regions") {
            return Err(ApiError::bad_request(format!(
                "unsupported region_merge_policy '{policy}'; expected keep_target_only or promote_tools_to_regions"
            )));
        }
    }

    let target_index = resolve_scene_object_index(&scene.objects, target_object_id)
        .map_err(|error| {
            if error.status == axum::http::StatusCode::NOT_FOUND {
                ApiError::not_found(format!("target object not found: {target_object_id}"))
            } else {
                error
            }
        })?;
    let target_snapshot = scene.objects[target_index].clone();

    let mut seen_tool_ids = std::collections::BTreeSet::new();
    let mut tool_snapshots = Vec::with_capacity(tool_object_ids.len());
    for raw_tool_id in tool_object_ids {
        let tool_index = resolve_scene_object_index(&scene.objects, raw_tool_id).map_err(|error| {
            if error.status == axum::http::StatusCode::NOT_FOUND {
                ApiError::not_found(format!("tool object not found: {raw_tool_id}"))
            } else {
                error
            }
        })?;
        let tool = scene.objects[tool_index].clone();
        if tool.id == target_snapshot.id {
            return Err(ApiError::bad_request(format!(
                "tool object '{}' cannot be the same as target object '{}'",
                tool.id, target_snapshot.id
            )));
        }
        if !seen_tool_ids.insert(tool.id.clone()) {
            return Err(ApiError::bad_request(format!(
                "duplicate tool object '{}' in boolean_combine_objects",
                tool.id
            )));
        }
        tool_snapshots.push(tool);
    }

    if op == "imprint_regions" {
        let target = &mut scene.objects[target_index];
        for tool in &tool_snapshots {
            promote_tool_object_to_region(target, tool)?;
        }
        mark_object_mesh_dirty(target);
        if !keep_tools {
            for tool in &tool_snapshots {
                scene.objects.retain(|entry| entry.id != tool.id);
                cascade_cleanup_deleted_object_references(scene, &tool.id, &tool.name);
            }
        }
        mark_all_object_meshes_dirty(scene);
        return Ok(());
    }

    let target_kind = boolean_op_to_geometry_kind(op)?;
    let mut operands = if target_snapshot.geometry.geometry_kind == target_kind {
        extract_boolean_operands(&target_snapshot.geometry, &target_snapshot.name)?
    } else {
        vec![fullmag_authoring::SceneBooleanOperand {
            operand_id: "op:1".to_string(),
            label: target_snapshot.name.clone(),
            enabled: true,
            geometry: target_snapshot.geometry.clone(),
            transform: None,
            source_object_id: Some(target_snapshot.id.clone()),
        }]
    };
    for tool in &tool_snapshots {
        let (geometry, transform) =
            boolean_tool_geometry_in_target_frame(&target_snapshot.transform, tool)?;
        let operand_id = allocate_unique_operand_id(&operands, "op");
        operands.push(fullmag_authoring::SceneBooleanOperand {
            operand_id,
            label: tool.name.clone(),
            enabled: true,
            geometry,
            transform: (!transform.is_identity()).then_some(transform),
            source_object_id: Some(tool.id.clone()),
        });
    }

    if operands.len() > MAX_BOOLEAN_OPERANDS {
        return Err(ApiError::bad_request(format!(
            "boolean_combine_objects exceeds maximum operand count ({MAX_BOOLEAN_OPERANDS})"
        )));
    }

    let operands_value = serde_json::to_value(&operands).map_err(|error| {
        ApiError::internal(format!("failed to serialize boolean operands: {error}"))
    })?;
    let promote_regions = region_merge_policy == Some("promote_tools_to_regions");

    {
        let target = &mut scene.objects[target_index];
        target.geometry = SceneGeometry {
            source_asset: None,
            geometry_kind: target_kind.to_string(),
            geometry_params: serde_json::json!({ "operands": operands_value }),
            bounds_min: None,
            bounds_max: None,
        };
        if promote_regions {
            for tool in &tool_snapshots {
                promote_tool_object_to_region(target, tool)?;
            }
        }
        mark_object_mesh_dirty(target);
    }

    if !keep_tools {
        for tool in &tool_snapshots {
            scene.objects.retain(|entry| entry.id != tool.id);
            cascade_cleanup_deleted_object_references(scene, &tool.id, &tool.name);
        }
    }
    mark_all_object_meshes_dirty(scene);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_update_boolean_operands_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    op: Option<&str>,
    reorder_operand_ids: Option<Vec<String>>,
    toggle_operand: Option<crate::schemas::authoring::BooleanOperandToggle>,
    remove_operand_id: Option<&str>,
    add_operand: Option<crate::schemas::authoring::BooleanOperandInput>,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let object = find_scene_object_mut(scene, object_id)?;
    let mut geometry_kind = match object.geometry.geometry_kind.as_str() {
        "Union" | "Difference" | "Intersection" | "Xor" => object.geometry.geometry_kind.clone(),
        "Csg" => {
            let legacy_op = object
                .geometry
                .geometry_params
                .get("op")
                .and_then(Value::as_str)
                .unwrap_or("subtract");
            boolean_op_to_geometry_kind(legacy_op)?.to_string()
        }
        other => {
            return Err(ApiError::bad_request(format!(
                "object '{}' geometry kind '{other}' is not a boolean CSG node",
                object.id
            )));
        }
    };
    if let Some(next_op) = op {
        geometry_kind = boolean_op_to_geometry_kind(next_op)?.to_string();
    }

    let mut operands = extract_boolean_operands(&object.geometry, &object.name)?;

    if let Some(order) = reorder_operand_ids {
        if order.len() != operands.len() {
            return Err(ApiError::bad_request(
                "reorder_operand_ids must contain every existing operand_id exactly once",
            ));
        }
        let mut reordered = Vec::with_capacity(operands.len());
        let mut seen = std::collections::BTreeSet::new();
        for id in order {
            if !seen.insert(id.clone()) {
                return Err(ApiError::bad_request(format!(
                    "duplicate operand_id '{id}' in reorder_operand_ids"
                )));
            }
            let found = operands
                .iter()
                .find(|entry| entry.operand_id == id)
                .cloned()
                .ok_or_else(|| {
                    ApiError::not_found(format!("boolean operand not found: {id}"))
                })?;
            reordered.push(found);
        }
        operands = reordered;
    }

    if let Some(toggle) = toggle_operand {
        let entry = operands
            .iter_mut()
            .find(|entry| entry.operand_id == toggle.operand_id)
            .ok_or_else(|| {
                ApiError::not_found(format!(
                    "boolean operand not found: {}",
                    toggle.operand_id
                ))
            })?;
        entry.enabled = toggle.enabled;
    }

    if let Some(remove_id) = remove_operand_id {
        let before = operands.len();
        operands.retain(|entry| entry.operand_id != remove_id);
        if operands.len() == before {
            return Err(ApiError::not_found(format!(
                "boolean operand not found: {remove_id}"
            )));
        }
        if operands.is_empty() {
            return Err(ApiError::bad_request(
                "cannot remove the last remaining boolean operand",
            ));
        }
    }

    if let Some(input) = add_operand {
        if operands.len() >= MAX_BOOLEAN_OPERANDS {
            return Err(ApiError::bad_request(format!(
                "boolean operand limit ({MAX_BOOLEAN_OPERANDS}) exceeded"
            )));
        }
        let geom: SceneGeometry = serde_json::from_value(input.geometry).map_err(|error| {
            ApiError::bad_request(format!("invalid add_operand.geometry payload: {error}"))
        })?;
        let transform: Option<Transform3D> = input
            .transform
            .map(|value| {
                let mut t = Transform3D::default();
                let patch: fullmag_authoring::Transform3DPatch = serde_json::from_value(value)
                    .map_err(|error| {
                        ApiError::bad_request(format!(
                            "invalid add_operand.transform payload: {error}"
                        ))
                    })?;
                t.apply_patch(patch).map_err(ApiError::bad_request)?;
                Ok::<Transform3D, ApiError>(t)
            })
            .transpose()?
            .filter(|t| !t.is_identity());
        let operand_id = allocate_unique_operand_id(&operands, "op");
        let label = if input.label.trim().is_empty() {
            operand_id.clone()
        } else {
            input.label.trim().to_string()
        };
        operands.push(fullmag_authoring::SceneBooleanOperand {
            operand_id,
            label,
            enabled: true,
            geometry: geom,
            transform,
            source_object_id: None,
        });
    }

    if !operands.iter().any(|entry| entry.enabled) {
        return Err(ApiError::bad_request(
            "boolean geometry must keep at least one enabled operand",
        ));
    }

    let operands_value = serde_json::to_value(&operands).map_err(|error| {
        ApiError::internal(format!("failed to serialize boolean operands: {error}"))
    })?;
    object.geometry = SceneGeometry {
        source_asset: None,
        geometry_kind,
        geometry_params: serde_json::json!({ "operands": operands_value }),
        bounds_min: None,
        bounds_max: None,
    };
    mark_object_mesh_dirty(object);
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn apply_separate_object_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    mode: &str,
    operand_id: Option<&str>,
    keep_in_boolean: bool,
    plane_origin_m: Option<[f64; 3]>,
    plane_normal: Option<[f64; 3]>,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let target_index = resolve_scene_object_index(&scene.objects, object_id)?;
    let source = scene.objects[target_index].clone();

    match mode {
        "extract_operand" => {
            let requested_operand_id = operand_id.ok_or_else(|| {
                ApiError::bad_request("separate_object(extract_operand) requires operand_id")
            })?;
            let mut operands = extract_boolean_operands(&source.geometry, &source.name)?;
            let op_pos = operands
                .iter()
                .position(|entry| entry.operand_id == requested_operand_id)
                .ok_or_else(|| {
                    ApiError::not_found(format!(
                        "boolean operand not found: {requested_operand_id}"
                    ))
                })?;
            if !keep_in_boolean && operands.len() <= 1 {
                return Err(ApiError::bad_request(
                    "cannot extract and remove the sole operand from a boolean object",
                ));
            }
            let extracted = if keep_in_boolean {
                operands[op_pos].clone()
            } else {
                operands.remove(op_pos)
            };
            if !keep_in_boolean && !operands.iter().any(|entry| entry.enabled) {
                return Err(ApiError::bad_request(
                    "removing operand would leave zero enabled operands on boolean object",
                ));
            }

            // Compute world geometry & transform for the extracted object
            let (extracted_geometry, extracted_transform) = match extracted.transform.as_ref() {
                None => (extracted.geometry.clone(), source.transform.clone()),
                Some(op_transform) if is_isotropic_scale(source.transform.scale) => {
                    let composed = compose_transforms_isotropic(&source.transform, op_transform)?;
                    (extracted.geometry.clone(), composed)
                }
                Some(op_transform) => {
                    // Preserve exact affine composition without shear loss when source has anisotropic scale
                    let wrapped = SceneGeometry {
                        source_asset: None,
                        geometry_kind: "Transform".to_string(),
                        geometry_params: serde_json::json!({
                            "child": extracted.geometry,
                            "transform": op_transform,
                        }),
                        bounds_min: None,
                        bounds_max: None,
                    };
                    (wrapped, source.transform.clone())
                }
            };

            let seed_id = extracted
                .source_object_id
                .as_deref()
                .filter(|id| !id.trim().is_empty())
                .unwrap_or(&source.id);
            let new_id = allocate_unique_object_id(scene, &format!("{seed_id}_extracted"));
            let new_name = if extracted.label.trim().is_empty() {
                format!("{} Extracted", source.name)
            } else {
                extracted.label.trim().to_string()
            };

            if !keep_in_boolean {
                let target = &mut scene.objects[target_index];
                if operands.len() == 1 {
                    let sole = operands.remove(0);
                    match sole.transform.as_ref() {
                        None => {
                            target.geometry = sole.geometry;
                        }
                        Some(sole_t) if is_isotropic_scale(target.transform.scale) => {
                            target.transform =
                                compose_transforms_isotropic(&target.transform, sole_t)?;
                            target.geometry = sole.geometry;
                        }
                        Some(sole_t) => {
                            target.geometry = SceneGeometry {
                                source_asset: None,
                                geometry_kind: "Transform".to_string(),
                                geometry_params: serde_json::json!({
                                    "child": sole.geometry,
                                    "transform": sole_t,
                                }),
                                bounds_min: None,
                                bounds_max: None,
                            };
                        }
                    }
                } else {
                    let operands_value = serde_json::to_value(&operands).map_err(|error| {
                        ApiError::internal(format!(
                            "failed to serialize boolean operands: {error}"
                        ))
                    })?;
                    target.geometry.geometry_params =
                        serde_json::json!({ "operands": operands_value });
                    target.geometry.bounds_min = None;
                    target.geometry.bounds_max = None;
                }
                mark_object_mesh_dirty(target);
            }

            let mut new_object = SceneObject {
                id: new_id,
                name: new_name,
                role: source.role.clone(),
                geometry: extracted_geometry,
                transform: extracted_transform,
                material_ref: source.material_ref.clone(),
                region_name: None,
                magnetization_ref: source.magnetization_ref.clone(),
                region_overrides: Default::default(),
                physics_stack: source.physics_stack.clone(),
                object_mesh: None,
                mesh_override: None,
                regions: Vec::new(),
                allocated_region_ids: Vec::new(),
                material_parameter_fields: Vec::new(),
                absorbing_boundary: None,
                notes: None,
                visible: source.visible,
                locked: false,
                tags: Vec::new(),
                visualization_hint: source.visualization_hint.clone(),
            };
            mark_object_mesh_dirty(&mut new_object);
            scene.objects.push(new_object);
            Ok(())
        }
        "split_by_plane" => {
            let origin = plane_origin_m.ok_or_else(|| {
                ApiError::bad_request("separate_object(split_by_plane) requires plane_origin_m")
            })?;
            let raw_normal = plane_normal.ok_or_else(|| {
                ApiError::bad_request("separate_object(split_by_plane) requires plane_normal")
            })?;
            if !origin.iter().all(|v| v.is_finite()) || !raw_normal.iter().all(|v| v.is_finite()) {
                return Err(ApiError::bad_request(
                    "split_by_plane plane_origin_m and plane_normal must contain finite values",
                ));
            }
            let norm = (raw_normal[0] * raw_normal[0]
                + raw_normal[1] * raw_normal[1]
                + raw_normal[2] * raw_normal[2])
                .sqrt();
            if !norm.is_finite() || norm <= 1e-12 {
                return Err(ApiError::bad_request(
                    "split_by_plane plane_normal must have non-zero norm (> 1e-12)",
                ));
            }
            let unit_world_normal = [
                raw_normal[0] / norm,
                raw_normal[1] / norm,
                raw_normal[2] / norm,
            ];
            // Transform the world-space cutting plane into the object's local frame so
            // SlicePlane cuts at the exact world plane even under translation, rotation,
            // pivot, or anisotropic scale:
            //   o_l = S^{-1} R^T (o_w - t - p) + p
            //   n_l = normalize(S R^T n_w)
            let q = quat_normalize(source.transform.rotation_quat)?;
            let q_inv = quat_conj(q);
            let scale = source.transform.scale;
            if scale.iter().any(|v| !v.is_finite() || *v <= 0.0) {
                return Err(ApiError::bad_request(
                    "split_by_plane requires finite positive scale on target object",
                ));
            }
            let pivot = source.transform.pivot;
            let trans = source.transform.translation;
            let shifted_origin = [
                origin[0] - trans[0] - pivot[0],
                origin[1] - trans[1] - pivot[1],
                origin[2] - trans[2] - pivot[2],
            ];
            let unrotated_origin = quat_rotate_vec3(q_inv, shifted_origin);
            let local_origin = [
                unrotated_origin[0] / scale[0] + pivot[0],
                unrotated_origin[1] / scale[1] + pivot[1],
                unrotated_origin[2] / scale[2] + pivot[2],
            ];
            let unrotated_normal = quat_rotate_vec3(q_inv, unit_world_normal);
            let scaled_normal = [
                unrotated_normal[0] * scale[0],
                unrotated_normal[1] * scale[1],
                unrotated_normal[2] * scale[2],
            ];
            let local_n_norm = (scaled_normal[0] * scaled_normal[0]
                + scaled_normal[1] * scaled_normal[1]
                + scaled_normal[2] * scaled_normal[2])
                .sqrt();
            if !local_n_norm.is_finite() || local_n_norm <= 1e-12 {
                return Err(ApiError::bad_request(
                    "split_by_plane local normal degenerated under object transform",
                ));
            }
            let local_unit_normal = [
                scaled_normal[0] / local_n_norm,
                scaled_normal[1] / local_n_norm,
                scaled_normal[2] / local_n_norm,
            ];
            let original_geometry = source.geometry.clone();
            let positive_half = SceneGeometry {
                source_asset: None,
                geometry_kind: "SlicePlane".to_string(),
                geometry_params: serde_json::json!({
                    "child": original_geometry,
                    "plane_origin_m": local_origin,
                    "plane_normal": local_unit_normal,
                    "keep_side": "positive",
                }),
                bounds_min: None,
                bounds_max: None,
            };
            let negative_half = SceneGeometry {
                source_asset: None,
                geometry_kind: "SlicePlane".to_string(),
                geometry_params: serde_json::json!({
                    "child": source.geometry.clone(),
                    "plane_origin_m": local_origin,
                    "plane_normal": local_unit_normal,
                    "keep_side": "negative",
                }),
                bounds_min: None,
                bounds_max: None,
            };

            let sibling_id = allocate_unique_object_id(scene, &format!("{}_split", source.id));
            scene.objects[target_index].geometry = positive_half;
            mark_object_mesh_dirty(&mut scene.objects[target_index]);

            let mut sibling = SceneObject {
                id: sibling_id,
                name: format!("{} (Split)", source.name),
                role: source.role.clone(),
                geometry: negative_half,
                transform: source.transform.clone(),
                material_ref: source.material_ref.clone(),
                region_name: None,
                magnetization_ref: source.magnetization_ref.clone(),
                region_overrides: Default::default(),
                physics_stack: source.physics_stack.clone(),
                object_mesh: source.object_mesh.clone(),
                mesh_override: source.mesh_override.clone(),
                regions: Vec::new(),
                allocated_region_ids: Vec::new(),
                material_parameter_fields: Vec::new(),
                absorbing_boundary: None,
                notes: None,
                visible: source.visible,
                locked: false,
                tags: Vec::new(),
                visualization_hint: source.visualization_hint.clone(),
            };
            mark_object_mesh_dirty(&mut sibling);
            scene.objects.push(sibling);
            mark_all_object_meshes_dirty(scene);
            Ok(())
        }
        other => Err(ApiError::bad_request(format!(
            "unsupported separate_object mode '{other}'; expected extract_operand or split_by_plane"
        ))),
    }
}

fn apply_duplicate_objects_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_ids: &[String],
    offset_m: Option<[f64; 3]>,
    copy_regions: bool,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    if object_ids.is_empty() {
        return Err(ApiError::bad_request(
            "duplicate_objects requires at least one object_id",
        ));
    }
    let offset = offset_m.unwrap_or([0.0, 0.0, 0.0]);
    if !offset.iter().all(|v| v.is_finite()) {
        return Err(ApiError::bad_request(
            "duplicate_objects offset_m must contain finite numbers",
        ));
    }

    // Resolve all targets first so invalid IDs reject atomically without partial mutation.
    let mut sources = Vec::with_capacity(object_ids.len());
    for raw_id in object_ids {
        let index = resolve_scene_object_index(&scene.objects, raw_id)?;
        sources.push(scene.objects[index].clone());
    }

    for source in sources {
        let new_id = allocate_unique_object_id(scene, &format!("{}_copy", source.id));
        let mut cloned = source.clone();
        cloned.id = new_id.clone();
        cloned.name = format!("{} Copy", source.name);
        cloned.region_name = None;
        cloned.region_overrides.clear();
        cloned.allocated_region_ids.clear();
        cloned.absorbing_boundary = None;
        cloned.transform.translation[0] += offset[0];
        cloned.transform.translation[1] += offset[1];
        cloned.transform.translation[2] += offset[2];

        if copy_regions {
            let original_regions = std::mem::take(&mut cloned.regions);
            let original_fields = std::mem::take(&mut cloned.material_parameter_fields);
            let mut region_id_map = std::collections::BTreeMap::<String, String>::new();
            for mut region in original_regions {
                let old_region_id = region.region_id.clone();
                let fresh_region_id = allocate_object_region_id(&mut cloned);
                region.region_id = fresh_region_id.clone();
                region.owner_object = new_id.clone();
                region_id_map.insert(old_region_id, fresh_region_id);
                cloned.regions.push(region);
            }
            for (field_idx, mut field) in original_fields.into_iter().enumerate() {
                field.assignment_id = format!("{new_id}_field_{}", field_idx + 1);
                field.owner_object = new_id.clone();
                field.region_id = field
                    .region_id
                    .and_then(|old_id| region_id_map.get(&old_id).cloned());
                cloned.material_parameter_fields.push(field);
            }
        } else {
            cloned.regions.clear();
            cloned.material_parameter_fields.clear();
        }

        mark_object_mesh_dirty(&mut cloned);
        scene.objects.push(cloned);
    }

    Ok(())
}

fn build_array_3d_geometry(
    existing: &SceneGeometry,
    ordered_axes: &[fullmag_authoring::SceneArrayAxisSpec; 3],
    merge_overlapping: bool,
) -> Result<SceneGeometry, ApiError> {
    let axes_value = serde_json::to_value(ordered_axes).map_err(|error| {
        ApiError::internal(format!("failed to serialize Array3D axes: {error}"))
    })?;
    let (child_value, child_transform_value) = if existing.geometry_kind == "Array3D" {
        if let Some(child) = existing.geometry_params.get("child") {
            (
                child.clone(),
                existing
                    .geometry_params
                    .get("child_transform")
                    .filter(|v| !v.is_null())
                    .cloned(),
            )
        } else {
            let child = serde_json::to_value(existing).map_err(|error| {
                ApiError::internal(format!("failed to serialize Array3D child: {error}"))
            })?;
            (child, None)
        }
    } else {
        let child = serde_json::to_value(existing).map_err(|error| {
            ApiError::internal(format!("failed to serialize Array3D child: {error}"))
        })?;
        (child, None)
    };
    let mut params = serde_json::Map::new();
    params.insert("child".to_string(), child_value);
    if let Some(ct) = child_transform_value {
        params.insert("child_transform".to_string(), ct);
    }
    params.insert("axes".to_string(), axes_value);
    params.insert(
        "merge_overlapping".to_string(),
        Value::Bool(merge_overlapping),
    );
    Ok(SceneGeometry {
        source_asset: None,
        geometry_kind: "Array3D".to_string(),
        geometry_params: Value::Object(params),
        bounds_min: None,
        bounds_max: None,
    })
}

#[allow(clippy::too_many_arguments)]
fn apply_array_3d_transaction(
    scene: &mut SceneDocument,
    base_revision: Option<u64>,
    object_id: &str,
    target_operand_id: Option<&str>,
    axes: &[fullmag_authoring::SceneArrayAxisSpec; 3],
    merge_overlapping: bool,
    realization: &str,
) -> Result<(), ApiError> {
    check_base_scene_revision(scene, base_revision)?;
    let (ordered_axes, total_instances) =
        fullmag_authoring::validate_and_order_array_axes(axes).map_err(ApiError::bad_request)?;

    let target_index = resolve_scene_object_index(&scene.objects, object_id)?;

    match realization {
        "modifier_in_object" => {
            if total_instances > fullmag_ir::MAX_ARRAY_INSTANCES_FDM {
                return Err(ApiError::bad_request(format!(
                    "apply_array_3d total instances ({total_instances}) exceeds MAX_ARRAY_INSTANCES_FDM ({})",
                    fullmag_ir::MAX_ARRAY_INSTANCES_FDM
                )));
            }
            let target = &mut scene.objects[target_index];
            if let Some(op_id) = target_operand_id {
                let geometry_kind = match target.geometry.geometry_kind.as_str() {
                    "Union" | "Difference" | "Intersection" | "Xor" => {
                        target.geometry.geometry_kind.clone()
                    }
                    "Csg" => {
                        let legacy_op = target
                            .geometry
                            .geometry_params
                            .get("op")
                            .and_then(Value::as_str)
                            .unwrap_or("subtract");
                        boolean_op_to_geometry_kind(legacy_op)?.to_string()
                    }
                    other => {
                        return Err(ApiError::bad_request(format!(
                            "object '{}' geometry kind '{other}' is not a boolean CSG node; cannot target operand '{op_id}'",
                            target.id
                        )));
                    }
                };
                let mut operands = extract_boolean_operands(&target.geometry, &target.name)?;
                let operand = operands
                    .iter_mut()
                    .find(|entry| entry.operand_id == op_id)
                    .ok_or_else(|| {
                        ApiError::not_found(format!("boolean operand not found: {op_id}"))
                    })?;
                operand.geometry =
                    build_array_3d_geometry(&operand.geometry, &ordered_axes, merge_overlapping)?;
                let operands_value = serde_json::to_value(&operands).map_err(|error| {
                    ApiError::internal(format!("failed to serialize boolean operands: {error}"))
                })?;
                target.geometry = SceneGeometry {
                    source_asset: None,
                    geometry_kind,
                    geometry_params: serde_json::json!({ "operands": operands_value }),
                    bounds_min: None,
                    bounds_max: None,
                };
            } else {
                target.geometry =
                    build_array_3d_geometry(&target.geometry, &ordered_axes, merge_overlapping)?;
            }
            mark_object_mesh_dirty(target);
            Ok(())
        }
        "expand_to_objects" => {
            if target_operand_id.is_some() {
                return Err(ApiError::bad_request(
                    "apply_array_3d(expand_to_objects) does not support target_operand_id; use modifier_in_object for boolean operands",
                ));
            }
            if total_instances > fullmag_ir::MAX_EXPANDED_SCENE_OBJECTS {
                return Err(ApiError::bad_request(format!(
                    "apply_array_3d(expand_to_objects) total instances ({total_instances}) exceeds MAX_EXPANDED_SCENE_OBJECTS ({})",
                    fullmag_ir::MAX_EXPANDED_SCENE_OBJECTS
                )));
            }
            let source = scene.objects[target_index].clone();
            let needs_bbox = ordered_axes.iter().any(|ax| {
                ax.effective_count() > 1
                    && ax.spacing_mode == fullmag_authoring::SceneArraySpacingMode::BoundingBoxGap
            });
            let child_extent = match fullmag_authoring::derive_scene_geometry_bounds(&source.geometry)
            {
                Some((cmin, cmax)) => [cmax[0] - cmin[0], cmax[1] - cmin[1], cmax[2] - cmin[2]],
                None if needs_bbox => {
                    return Err(ApiError::bad_request(
                        "apply_array_3d(expand_to_objects) with bounding_box_gap requires finite derivable child bounds",
                    ));
                }
                None => [0.0, 0.0, 0.0],
            };
            let mut step_vectors = [[0.0; 3]; 3];
            for a in 0..3 {
                let ax = &ordered_axes[a];
                let delta = match ax.spacing_mode {
                    fullmag_authoring::SceneArraySpacingMode::LatticeStep => ax.pitch_m,
                    fullmag_authoring::SceneArraySpacingMode::BoundingBoxGap => {
                        ax.relative_factor * child_extent[a] + ax.gap_m
                    }
                };
                let mut v = ax.step_translation_extra_m;
                v[a] += delta;
                step_vectors[a] = v;
            }
            let idx_x = ordered_axes[0].canonical_indices();
            let idx_y = ordered_axes[1].canonical_indices();
            let idx_z = ordered_axes[2].canonical_indices();
            let source_isotropic = is_isotropic_scale(source.transform.scale);

            // Compute all expanded instances before mutating the scene so errors reject atomically.
            let mut expanded: Vec<(usize, usize, usize, SceneGeometry, Transform3D)> =
                Vec::with_capacity(total_instances);
            for (ix, &kx) in idx_x.iter().enumerate() {
                for (iy, &ky) in idx_y.iter().enumerate() {
                    for (iz, &kz) in idx_z.iter().enumerate() {
                        let ks = [kx, ky, kz];
                        let mut trans = [0.0; 3];
                        let mut rot_deg = [0.0; 3];
                        let mut scale = [1.0; 3];
                        for a in 0..3 {
                            let k = ks[a];
                            if k == 0.0 {
                                continue;
                            }
                            for j in 0..3 {
                                trans[j] += k * step_vectors[a][j];
                                rot_deg[j] += k * ordered_axes[a].step_rotation_euler_deg[j];
                                let sf = ordered_axes[a].step_scale_factor[j];
                                if (sf - 1.0).abs() > 1e-15 {
                                    scale[j] *= sf.powf(k);
                                }
                            }
                        }
                        let inst_transform = Transform3D {
                            translation: trans,
                            rotation_quat: fullmag_authoring::euler_xyz_deg_to_quat(rot_deg),
                            scale,
                            pivot: [0.0, 0.0, 0.0],
                        };
                        let (inst_geom, inst_world_transform) = if inst_transform.is_identity() {
                            (source.geometry.clone(), source.transform.clone())
                        } else if source_isotropic {
                            (
                                source.geometry.clone(),
                                compose_transforms_isotropic(&source.transform, &inst_transform)?,
                            )
                        } else {
                            let wrapped = SceneGeometry {
                                source_asset: None,
                                geometry_kind: "Transform".to_string(),
                                geometry_params: serde_json::json!({
                                    "child": source.geometry,
                                    "transform": inst_transform,
                                }),
                                bounds_min: None,
                                bounds_max: None,
                            };
                            (wrapped, source.transform.clone())
                        };
                        expanded.push((ix, iy, iz, inst_geom, inst_world_transform));
                    }
                }
            }

            let mut iter = expanded.into_iter();
            if let Some((_ix, _iy, _iz, first_geom, first_transform)) = iter.next() {
                let target = &mut scene.objects[target_index];
                target.geometry = first_geom;
                target.transform = first_transform;
                mark_object_mesh_dirty(target);
            }
            for (ix, iy, iz, inst_geom, inst_transform) in iter {
                let new_id = allocate_unique_object_id(
                    scene,
                    &format!("{}_arr_{}_{}_{}", source.id, ix, iy, iz),
                );
                let mut sibling = SceneObject {
                    id: new_id,
                    name: format!("{} [{ix},{iy},{iz}]", source.name),
                    role: source.role.clone(),
                    geometry: inst_geom,
                    transform: inst_transform,
                    material_ref: source.material_ref.clone(),
                    region_name: None,
                    magnetization_ref: source.magnetization_ref.clone(),
                    region_overrides: Default::default(),
                    physics_stack: source.physics_stack.clone(),
                    object_mesh: source.object_mesh.clone(),
                    mesh_override: source.mesh_override.clone(),
                    regions: Vec::new(),
                    allocated_region_ids: Vec::new(),
                    material_parameter_fields: Vec::new(),
                    absorbing_boundary: None,
                    notes: None,
                    visible: source.visible,
                    locked: false,
                    tags: Vec::new(),
                    visualization_hint: source.visualization_hint.clone(),
                };
                mark_object_mesh_dirty(&mut sibling);
                scene.objects.push(sibling);
            }
            mark_all_object_meshes_dirty(scene);
            Ok(())
        }
        other => Err(ApiError::bad_request(format!(
            "unsupported apply_array_3d realization '{other}'; expected modifier_in_object or expand_to_objects"
        ))),
    }
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
        ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi => "rotated_interfacial_dmi",
        ScriptBuilderMagneticInteractionKind::BulkDmi => "bulk_dmi",
        ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy => "uniaxial_anisotropy",
        ScriptBuilderMagneticInteractionKind::CubicAnisotropy => "cubic_anisotropy",
    }
}

async fn current_region_realization_revisions_for_context(
    state: &Arc<AppState>,
    context: &crate::types::CurrentLiveRequestContext,
) -> Result<fullmag_authoring::RegionRealizationRevisions, ApiError> {
    let _transition = state.current_live_session_transition.lock().await;
    let session_epoch = state
        .current_live_session_epoch
        .load(std::sync::atomic::Ordering::Acquire);
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(snapshot, context, session_epoch)?;
    Ok(snapshot.region_realization_revisions)
}

fn build_material_resource(
    material: &fullmag_authoring::SceneMaterialAsset,
    scene_revision: u64,
    region_coefficients_revision: u64,
) -> MaterialResource {
    MaterialResource {
        scene_revision,
        region_coefficients_revision: Some(region_coefficients_revision),
        id: material.id.clone(),
        name: material.name.clone(),
        properties: MaterialPropertiesResource {
            ms: material.properties.ms,
            aex: material.properties.aex,
            alpha: material.properties.alpha,
            dind: material.properties.dind,
            dbulk: material.properties.dbulk,
        },
        references: material
            .references
            .iter()
            .map(|reference| MaterialReferenceResource {
                label: reference.label.clone(),
                url: reference.url.clone(),
                citation: reference.citation.clone(),
            })
            .collect(),
        source: material.source.clone(),
    }
}

fn build_magnetization_asset_resource(
    scene: &SceneDocument,
    asset: &MagnetizationAsset,
    region_initial_state_revision: u64,
) -> Result<MagnetizationAssetResource, ApiError> {
    let asset = serde_json::to_value(asset).map_err(|error| {
        ApiError::internal(format!("failed to serialize magnetization asset: {error}"))
    })?;
    let asset = asset.as_object().cloned().ok_or_else(|| {
        ApiError::internal("serialized magnetization asset was not a JSON object")
    })?;
    Ok(MagnetizationAssetResource {
        scene_revision: scene.revision,
        region_initial_state_revision: Some(region_initial_state_revision),
        asset: asset.into_iter().collect(),
    })
}

fn parse_interaction_kind(raw: &str) -> Result<ScriptBuilderMagneticInteractionKind, ApiError> {
    match raw {
        "exchange" => Ok(ScriptBuilderMagneticInteractionKind::Exchange),
        "demag" => Ok(ScriptBuilderMagneticInteractionKind::Demag),
        "interfacial_dmi" => Ok(ScriptBuilderMagneticInteractionKind::InterfacialDmi),
        "rotated_interfacial_dmi" => {
            Ok(ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi)
        }
        "bulk_dmi" => Ok(ScriptBuilderMagneticInteractionKind::BulkDmi),
        "uniaxial_anisotropy" => Ok(ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy),
        "cubic_anisotropy" => Ok(ScriptBuilderMagneticInteractionKind::CubicAnisotropy),
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
        ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi => "rotated_interfacial_dmi",
        ScriptBuilderMagneticInteractionKind::BulkDmi => "bulk_dmi",
        ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy => "uniaxial_anisotropy",
        ScriptBuilderMagneticInteractionKind::CubicAnisotropy => "cubic_anisotropy",
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
    scene_revision: u64,
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
        scene_revision,
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
        ScriptBuilderMagneticInteractionKind::InterfacialDmi => serde_json::json!({
            "dind": material_dind.unwrap_or(1e-3),
            "interface_normal": [0.0, 0.0, 1.0]
        }),
        ScriptBuilderMagneticInteractionKind::RotatedInterfacialDmi => Value::Object(
            [("d".to_string(), Value::from(3.0e-3))]
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
            "ku2": 0.0,
            "axis": [0.0, 0.0, 1.0]
        }),
        ScriptBuilderMagneticInteractionKind::CubicAnisotropy => serde_json::json!({
            "kc1": 0.0,
            "kc2": 0.0,
            "kc3": 0.0,
            "axis1": [1.0, 0.0, 0.0],
            "axis2": [0.0, 1.0, 0.0]
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

fn parse_unit_axis3_param(
    map: &serde_json::Map<String, Value>,
    key: &str,
    default: [f64; 3],
) -> Result<[f64; 3], ApiError> {
    let Some(value) = map.get(key) else {
        return Ok(default);
    };
    let Some(items) = value.as_array() else {
        return Err(ApiError::bad_request(format!(
            "{key} must be a 3-element numeric array"
        )));
    };
    if items.len() != 3 {
        return Err(ApiError::bad_request(format!(
            "{key} must contain exactly 3 numeric values"
        )));
    }
    let mut vec = [0.0; 3];
    for (idx, item) in items.iter().enumerate() {
        let Some(v) = item.as_f64() else {
            return Err(ApiError::bad_request(format!(
                "{key}[{idx}] must be a finite number"
            )));
        };
        if !v.is_finite() {
            return Err(ApiError::bad_request(format!("{key}[{idx}] must be finite")));
        }
        vec[idx] = v;
    }
    let norm = (vec[0] * vec[0] + vec[1] * vec[1] + vec[2] * vec[2]).sqrt();
    if norm <= 1e-12 {
        return Err(ApiError::bad_request(format!(
            "{key} must have a nonzero norm"
        )));
    }
    Ok([vec[0] / norm, vec[1] / norm, vec[2] / norm])
}

fn expect_object_params(
    value: Value,
    kind: ScriptBuilderMagneticInteractionKind,
) -> Result<serde_json::Map<String, Value>, ApiError> {
    let mut map = match value {
        Value::Object(map) => map,
        _ => {
            return Err(ApiError::bad_request(format!(
                "invalid params payload for interaction: {}",
                interaction_kind_str(kind)
            )))
        }
    };
    match kind {
        ScriptBuilderMagneticInteractionKind::InterfacialDmi => {
            let normal = parse_unit_axis3_param(&map, "interface_normal", [0.0, 0.0, 1.0])?;
            map.insert(
                "interface_normal".to_string(),
                Value::Array(normal.into_iter().map(Value::from).collect()),
            );
        }
        ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy => {
            if !map.contains_key("ku2") {
                map.insert("ku2".to_string(), Value::from(0.0));
            }
        }
        ScriptBuilderMagneticInteractionKind::CubicAnisotropy => {
            for key in ["kc1", "kc2", "kc3"] {
                let scalar = match map.get(key) {
                    Some(val) => {
                        let v = val.as_f64().ok_or_else(|| {
                            ApiError::bad_request(format!(
                                "cubic_anisotropy.{key} must be a finite number"
                            ))
                        })?;
                        if !v.is_finite() {
                            return Err(ApiError::bad_request(format!(
                                "cubic_anisotropy.{key} must be finite"
                            )));
                        }
                        v
                    }
                    None => 0.0,
                };
                map.insert(key.to_string(), Value::from(scalar));
            }
            let c1 = parse_unit_axis3_param(&map, "axis1", [1.0, 0.0, 0.0])?;
            let c2 = parse_unit_axis3_param(&map, "axis2", [0.0, 1.0, 0.0])?;
            let dot = c1[0] * c2[0] + c1[1] * c2[1] + c1[2] * c2[2];
            if dot.abs() >= 1e-6 {
                return Err(ApiError::bad_request(
                    "cubic_anisotropy axis1 and axis2 must be orthogonal (|c1·c2| / (||c1|| ||c2||) < 1e-6)",
                ));
            }
            map.insert(
                "axis1".to_string(),
                Value::Array(c1.into_iter().map(Value::from).collect()),
            );
            map.insert(
                "axis2".to_string(),
                Value::Array(c2.into_iter().map(Value::from).collect()),
            );
        }
        _ => {}
    }
    Ok(map)
}

#[cfg(test)]
mod boolean_frame_tests {
    use super::*;

    #[test]
    fn combine_keeps_anisotropic_target_frame_and_tool_world_position() {
        let half_sqrt = std::f64::consts::FRAC_1_SQRT_2;
        let mut scene: SceneDocument = serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "revision": 4,
            "objects": [
                {
                    "id": "target",
                    "name": "Target",
                    "material_ref": "magnetic",
                    "transform": {
                        "translation": [5e-9, 8e-9, 0.0],
                        "rotation_quat": [0.0, 0.0, half_sqrt, half_sqrt],
                        "scale": [2.0, 3.0, 1.0],
                        "pivot": [1e-9, 2e-9, 0.0],
                    },
                    "geometry": { "geometry_kind": "Sphere", "geometry_params": { "radius": 1e-9 } },
                },
                {
                    "id": "tool",
                    "name": "Tool",
                    "material_ref": "magnetic",
                    "transform": { "translation": [20e-9, 0.0, 0.0] },
                    "geometry": { "geometry_kind": "Sphere", "geometry_params": { "radius": 1e-9 } },
                },
            ]
        }))
        .unwrap();
        let target_frame = scene.objects[0].transform.clone();

        apply_boolean_combine_objects_transaction(
            &mut scene,
            Some(4),
            "union",
            "target",
            &["tool".to_string()],
            false,
            None,
        )
        .unwrap();

        assert_eq!(scene.objects[0].transform, target_frame);
        let geometry = crate::router_v2::handlers::simulation::commands::scene_object_geometry_entry(
            &scene.objects[0],
            "target",
        )
        .unwrap();
        let predicate = fullmag_plan::GeometryPredicate::from_region_shape(
            &fullmag_ir::RegionShapeIR::Csg {
                expression: Box::new(geometry),
            },
            fullmag_plan::AffineTransform3::identity(),
            fullmag_plan::BoundaryMembership::inclusive(),
        )
        .unwrap();
        assert!(predicate.contains([12e-9, 8e-9, 0.0]).unwrap());
        assert!(predicate.contains([20e-9, 0.0, 0.0]).unwrap());
        assert!(!predicate.contains([22e-9, 0.0, 0.0]).unwrap());
    }
}

#[cfg(test)]
mod regional_field_drive_tests {
    use super::*;
    use fullmag_ir::{
        DriveActivationIR, FieldDriveKindIR, FieldSpatialProfileIR, FieldTargetIR,
        FieldTimeOriginIR, RegionalFieldDriveIR, TimeDependenceIR,
    };

    fn scene() -> SceneDocument {
        serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "revision": 4
        }))
        .expect("minimal scene")
    }

    fn drive(id: &str) -> RegionalFieldDriveIR {
        RegionalFieldDriveIR {
            id: id.into(),
            name: format!("Drive {id}"),
            kind: FieldDriveKindIR::Regional,
            enabled: true,
            target: FieldTargetIR::Global {},
            amplitude_b_t: 1e-3,
            direction: [0.0, 1.0, 0.0],
            spatial_profile: FieldSpatialProfileIR::Uniform {},
            waveform: TimeDependenceIR::SincPulse {
                cutoff_hz: 20e9,
                t0: 50e-12,
                amplitude: 1.0,
            },
            time_origin: FieldTimeOriginIR::StageLocal,
            activation: DriveActivationIR::AllTimeEvolution {},
            migration: None,
        }
    }

    #[test]
    fn field_drive_crud_preserves_typed_scene_state() {
        let mut scene = scene();
        apply_create_field_drive_transaction(&mut scene, Some(4), drive("pulse")).expect("create");
        assert_eq!(scene.field_drives.drives[0].id, "pulse");

        let mut replacement = drive("pulse");
        replacement.amplitude_b_t = 2e-3;
        apply_replace_field_drive_transaction(&mut scene, Some(4), "pulse", replacement)
            .expect("replace");
        assert_eq!(scene.field_drives.drives[0].amplitude_b_t, 2e-3);

        apply_delete_field_drive_transaction(&mut scene, Some(4), "pulse").expect("delete");
        assert!(scene.field_drives.drives.is_empty());
    }

    #[test]
    fn field_drive_crud_rejects_revision_conflict_and_invalid_direction() {
        let mut scene = scene();
        let conflict = apply_create_field_drive_transaction(&mut scene, Some(3), drive("pulse"))
            .expect_err("stale revision must fail");
        assert_eq!(conflict.status, axum::http::StatusCode::CONFLICT);

        let mut invalid = drive("invalid");
        invalid.direction = [0.0, 2.0, 0.0];
        let error = apply_create_field_drive_transaction(&mut scene, Some(4), invalid)
            .expect_err("invalid direction must fail");
        assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
        assert!(scene.field_drives.drives.is_empty());
    }

    #[test]
    fn gaussian_plane_wave_profile_round_trips_through_resource_schema() {
        let mut source = drive("gaussian");
        source.spatial_profile = FieldSpatialProfileIR::GaussianPlaneWave {
            center_x_m: -1.0e-6,
            center_y_m: 0.0,
            carrier_origin_x_m: 0.0,
            sigma_x_m: 196.0e-9,
            sigma_y_m: 186.8507960633642e-9,
            wavelength_m: 196.0e-9,
            carrier_phase_rad: -std::f64::consts::FRAC_PI_2,
        };

        let resource = RegionalFieldDriveResource::from_ir(source.clone()).expect("resource");
        let round_tripped = resource.into_ir().expect("IR");
        assert_eq!(round_tripped.spatial_profile, source.spatial_profile);
    }
}

#[cfg(test)]
mod antenna_scene_roundtrip_tests {
    use super::*;

    #[test]
    fn merge_patch_preserves_all_five_antenna_composition_collections() {
        let scene: SceneDocument = serde_json::from_value(serde_json::json!({
            "version": "scene.v2",
            "revision": 12
        }))
        .expect("minimal scene");
        let patched = apply_scene_merge_patch(
            &scene,
            &serde_json::json!({
                "antenna_port_modes": [{
                    "schema_version": "antenna_port_mode.v2",
                    "id": "port_1",
                    "source_object_id": "antenna_1",
                    "current_transport_id": "transport_1",
                    "branches": [{
                        "id": "signal",
                        "inlet_terminal_ref": "signal_in",
                        "outlet_terminal_ref": "signal_out",
                        "signed_weight": 1.0
                    }, {
                        "id": "return",
                        "inlet_terminal_ref": "return_in",
                        "outlet_terminal_ref": "return_out",
                        "signed_weight": -1.0
                    }]
                }],
                "antenna_field_solve_stages": [{
                    "id": "solve_1",
                    "source_object_id": "antenna_1",
                    "current_transport_id": "transport_1",
                    "port_mode_ids": ["port_1"],
                    "conservative_current_view_ref": "transport_1:rt0",
                    "model": "quasistatic_conduction_biot_savart3d",
                    "oersted_realization": "direct_tetra_quadrature",
                    "conductor_mesh_policy": "authored_shared_domain",
                    "field_sampling_domain": {"kind": "global"},
                    "target_refs": [{"kind": "global"}],
                    "solver_policy": "production_default",
                    "outputs": [{"id": "basis", "quantity": "H_ant_basis"}]
                }],
                "antenna_target_projections": [{
                    "id": "projection_1",
                    "solution": {
                        "stage_id": "solve_1",
                        "output_id": "basis",
                        "asset_id": "asset_1",
                        "content_digest": "sha256:asset"
                    },
                    "target": {"kind": "global"},
                    "output_id": "projected"
                }],
                "solved_antenna_drives": [{
                    "id": "drive_1",
                    "name": "Drive 1",
                    "projection_ref": "projection_1",
                    "port_mode_id": "port_1",
                    "peak_current_a": 0.01,
                    "waveform": {"kind": "constant"},
                    "time_origin": "stage_local",
                    "activation": {"kind": "all_time_evolution"}
                }],
                "antenna_spectrum_requests": [{
                    "id": "spectrum_1",
                    "solution_ref": {
                        "stage_id": "solve_1",
                        "output_id": "basis",
                        "asset_id": "asset_1",
                        "content_digest": "sha256:asset"
                    },
                    "target": {"kind": "global"},
                    "transform": "spatial_fft",
                    "sampling_plane": {
                        "origin_m": [0.0, 0.0, 0.0],
                        "axis_u": [1.0, 0.0, 0.0],
                        "axis_v": [0.0, 1.0, 0.0],
                        "extent_u_m": 1.0,
                        "extent_v_m": 1.0,
                        "sample_count_u": 2,
                        "sample_count_v": 2,
                        "interpolation": "fem_element",
                        "outside_policy": "error"
                    },
                    "window": "rectangular",
                    "normalization": "integral_si",
                    "component": "x",
                    "output_id": "spectrum_out"
                }]
            }),
        )
        .expect("antenna merge patch must deserialize");

        assert_eq!(patched.antenna_port_modes[0].id, "port_1");
        assert_eq!(patched.antenna_field_solve_stages[0].id, "solve_1");
        assert_eq!(patched.antenna_target_projections[0].id, "projection_1");
        assert_eq!(patched.solved_antenna_drives[0].id, "drive_1");
        assert_eq!(patched.antenna_spectrum_requests[0].id, "spectrum_1");

        let serialized = serde_json::to_value(patched).expect("scene serialization");
        assert_eq!(serialized["antenna_port_modes"][0]["id"], "port_1");
        assert_eq!(serialized["antenna_field_solve_stages"][0]["id"], "solve_1");
        assert_eq!(serialized["antenna_target_projections"][0]["id"], "projection_1");
        assert_eq!(serialized["solved_antenna_drives"][0]["id"], "drive_1");
        assert_eq!(serialized["antenna_spectrum_requests"][0]["id"], "spectrum_1");
    }
}

#[cfg(test)]
#[path = "material_library_authoring_tests.rs"]
mod material_library_authoring_tests;

#[cfg(test)]
mod geometry_object_identity_tests {
    use super::*;

    fn geometry(size_x: f64) -> Value {
        serde_json::json!({
            "geometry_kind": "Box",
            "geometry_params": { "size_m": [size_x, 1.0, 1.0] }
        })
    }

    fn object(id: &str, name: &str, size_x: f64) -> SceneObject {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": name,
            "geometry": geometry(size_x),
            "material_ref": ""
        }))
        .expect("scene object")
    }

    fn scene(objects: Vec<SceneObject>) -> SceneDocument {
        let mut scene = SceneDocument::default();
        scene.revision = 7;
        scene.objects = objects;
        scene
    }

    #[test]
    fn geometry_patch_prefers_canonical_id_over_another_objects_name() {
        let mut scene = scene(vec![
            object("a", "b", 1.0),
            object("b", "target", 2.0),
        ]);

        apply_object_geometry_patch(
            &mut scene,
            "b",
            Some(7),
            geometry(4.0),
            None,
        )
        .expect("canonical ID selects object b");

        assert_eq!(scene.objects[0].geometry.geometry_params["size_m"][0], 1.0);
        assert_eq!(scene.objects[1].geometry.geometry_params["size_m"][0], 4.0);
    }

    #[test]
    fn deleting_by_canonical_id_preserves_survivor_refs_matching_removed_name() {
        let mut scene = scene(vec![
            object("a", "b", 1.0),
            object("b", "survivor", 2.0),
        ]);
        scene.editor.selected_object_id = Some("b".to_string());

        apply_delete_object_transaction(&mut scene, Some(7), "a")
            .expect("canonical ID deletes object a");

        assert_eq!(scene.objects.len(), 1);
        assert_eq!(scene.objects[0].id, "b");
        assert_eq!(scene.editor.selected_object_id.as_deref(), Some("b"));
    }

    #[test]
    fn deleting_region_does_not_remove_reference_to_survivor_named_as_owner() {
        let mut scene = scene(vec![
            object("owner", "survivor", 1.0),
            object("survivor", "other", 2.0),
        ]);
        scene.objects[0].regions.push(
            serde_json::from_value(serde_json::json!({
                "region_id": "r1",
                "owner_object": "owner",
                "name": "Owner region",
                "shape": { "kind": "box", "size": [1.0, 1.0, 1.0], "center": [0.0, 0.0, 0.0] }
            }))
            .expect("region"),
        );
        scene.couplings.push(
            serde_json::from_value(serde_json::json!({
                "coupling_id": "keep-survivor",
                "kind": "exchange",
                "source": { "kind": "region", "object": "survivor", "region_id": "r1" },
                "target": { "kind": "object", "object": "other" },
                "parameters": { "kind": "exchange", "mode": "harmonic_mean" }
            }))
            .expect("coupling"),
        );

        apply_delete_object_region_transaction(&mut scene, Some(7), "owner", "r1")
            .expect("delete owner region");

        assert_eq!(scene.couplings.len(), 1);
        assert_eq!(scene.couplings[0].coupling_id, "keep-survivor");
    }

    #[test]
    fn unique_legacy_name_fallback_is_preserved_but_ambiguous_names_conflict() {
        let objects = vec![
            object("a", "legacy-name", 1.0),
            object("b", "other", 2.0),
        ];
        assert_eq!(
            resolve_scene_object_index(&objects, "legacy-name").expect("unique alias"),
            0
        );

        let ambiguous = vec![
            object("a", "duplicate", 1.0),
            object("b", "duplicate", 2.0),
        ];
        let error = resolve_scene_object_index(&ambiguous, "duplicate")
            .expect_err("ambiguous legacy aliases must not pick by vector order");
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
    }
}

#[cfg(test)]
mod boolean_operand_identity_tests {
    use super::*;

    fn geometry(params: Value) -> SceneGeometry {
        SceneGeometry {
            source_asset: None,
            geometry_kind: "Union".to_string(),
            geometry_params: params,
            bounds_min: None,
            bounds_max: None,
        }
    }

    fn raw_box() -> Value {
        serde_json::json!({
            "geometry_kind": "Box",
            "geometry_params": { "size": [1.0, 1.0, 1.0] }
        })
    }

    fn operand(id: &str) -> Value {
        serde_json::json!({
            "operand_id": id,
            "label": id,
            "enabled": true,
            "geometry": raw_box()
        })
    }

    #[test]
    fn editable_operands_reject_empty_and_duplicate_canonical_ids() {
        for (entries, expected_message) in [
            (
                vec![operand(""), operand("op:2")],
                "nonempty operand_id",
            ),
            (
                vec![operand("op:1"), operand("op:1")],
                "duplicate boolean operand_id",
            ),
        ] {
            let geometry = geometry(serde_json::json!({ "operands": entries }));
            let error = extract_boolean_operands(&geometry, "Target")
                .expect_err("invalid canonical operand identities must fail edits");
            assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
            assert!(error.message.contains(expected_message));
        }
    }

    #[test]
    fn mixed_legacy_and_canonical_operands_get_collision_free_ids() {
        let geometry = geometry(serde_json::json!({
            "operands": [raw_box(), operand("op:1"), raw_box()]
        }));
        let operands = extract_boolean_operands(&geometry, "Target").expect("mixed legacy array");
        let ids: Vec<_> = operands.iter().map(|entry| entry.operand_id.as_str()).collect();
        assert_eq!(ids, vec!["op:2", "op:1", "op:3"]);
    }

    #[test]
    fn legacy_raw_geometry_operands_keep_synthesized_ids() {
        let geometry = geometry(serde_json::json!({
            "operands": [raw_box(), raw_box()]
        }));
        let operands = extract_boolean_operands(&geometry, "Target").expect("legacy array");
        let ids: Vec<_> = operands.iter().map(|entry| entry.operand_id.as_str()).collect();
        assert_eq!(ids, vec!["op:1", "op:2"]);
    }
}
