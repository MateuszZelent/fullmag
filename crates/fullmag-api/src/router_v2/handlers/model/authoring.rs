//! Authoring resource endpoints.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde_json::Value;

use crate::error::ApiError;
use crate::router_v2::handlers::data::field_resolution::flatten_json_field_values;
use crate::schemas::authoring::{
    AuthoringTransactionRequest, AuthoringTransactionResponse, CouplingCreateRequest,
    CouplingDeleteRequest, CouplingEndpointResolutionResource, CouplingListResource,
    CouplingPatchRequest, CouplingResource, CurrentTransportCommitResource,
    CurrentTransportListResource, CurrentTransportMutationRequest, FieldDriveCreateRequest,
    FieldDriveDeleteRequest, FieldDriveListResource, FieldDriveReplaceRequest,
    GeometryRealizationRequest, MagnetizationAssetPatchRequest, MagnetizationAssetResource,
    MaterialParameterFieldListResource, MaterialParameterFieldResource, MaterialPatchRequest,
    MaterialPropertiesResource, MaterialReferenceResource, MaterialResource, NullableF64PatchValue,
    NullableStringPatchValue, NullableU32PatchValue, ObjectCreateRequest,
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
    TransportExecutionCapability, TransportExecutionLane, TransportSemanticValidation,
    TransportValidationCandidate, TransportValidationIssue, TransportValidationRequest,
    TransportValidationResponse, UniverseFitRequest, UniversePatchRequest, UniverseResource,
};
use crate::types::{
    AppState, LatestFields, ScriptSourceResponse, ScriptSyncRequest, ScriptSyncResponse,
};
use fullmag_authoring::{
    geometry_capabilities, realize_geometry_scene, validate_geometry_scene, CurrentTransportModel,
    GeometryBackendTarget, GeometryCapabilitiesResource, GeometryDiagnostic,
    GeometryDiagnosticsResource, GeometryRealizationSnapshot, GeometryRegionCandidate,
    GeometryValidationResource, MagnetizationAsset, SceneCurrentTransport, SceneDocument,
    SceneGeometry, SceneMaterialAsset, SceneMaterialReference, SceneObject, SceneOerstedField,
    SceneRegionOverride, SceneSpinInterface, SceneSpinTorque, SceneSpinTransport,
    SceneTransportCoupling, ScriptBuilderMagneticInteractionEntry,
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    Ok(Json(SpinTransportListResource {
        scene_revision: scene.revision,
        items: scene.spin_transports,
    }))
}

#[utoipa::path(get, path = "/v2/sessions/current/model/spin-interfaces", responses((status = 200, body = SpinInterfaceListResource)), tag = "model")]
pub async fn get_spin_interfaces(
    State(state): State<Arc<AppState>>,
) -> Result<Json<SpinInterfaceListResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
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

fn requested_lane(resource: &SceneSpinTransport) -> Option<TransportExecutionLane> {
    let request = &resource.known()?.requested_execution;
    let value = serde_json::to_value(request).ok()?;
    Some(TransportExecutionLane {
        discretization: value.get("discretization")?.as_str()?.to_string(),
        device: value.get("device")?.as_str()?.to_string(),
        precision: value.get("precision")?.as_str()?.to_string(),
        execution_mode: value.get("execution_mode")?.as_str()?.to_string(),
    })
}

fn candidate_capability(candidate: &TransportValidationCandidate) -> TransportExecutionCapability {
    let (status, allowed, reason, requested) = match candidate {
        TransportValidationCandidate::CurrentTransport { resource, .. } => {
            let Some(value) = resource.known() else {
                return TransportExecutionCapability {
                    status: "unsupported".to_string(),
                    qualification: "unsupported".to_string(),
                    authoring_allowed: false,
                    reason: Some("Unknown current transport variants are read-only.".to_string()),
                    requested_lane: None,
                    resolved_lane: None,
                };
            };
            if value.model == CurrentTransportModel::PrescribedDensity
                && value.coupling == SceneTransportCoupling::Bidirectional
            {
                return TransportExecutionCapability {
                    status: "unsupported".to_string(),
                    qualification: "unsupported".to_string(),
                    authoring_allowed: false,
                    reason: Some(
                        "M2 bidirectional coupling is unsupported for prescribed_density transport."
                            .to_string(),
                    ),
                    requested_lane: None,
                    resolved_lane: None,
                };
            }
            let reciprocal = value.coupling == SceneTransportCoupling::Bidirectional
                || value.model == CurrentTransportModel::MagnetoresistivePoisson;
            if reciprocal {
                ("semantic_only", true, Some("M2 reciprocal authoring is available; executable qualification remains workload-scoped.".to_string()), None)
            } else {
                ("semantic_only", true, Some("M1 authoring is available; executable qualification remains workload-scoped.".to_string()), None)
            }
        }
        TransportValidationCandidate::SpinTransport { resource, .. } => {
            let requested = requested_lane(resource);
            let Some(known) = resource.known() else {
                return TransportExecutionCapability {
                    status: "unsupported".to_string(),
                    qualification: "unsupported".to_string(),
                    authoring_allowed: false,
                    reason: Some("Unknown spin transport variants are read-only.".to_string()),
                    requested_lane: requested,
                    resolved_lane: None,
                };
            };
            let reciprocal = known.constitutive_version != "transport_constitutive.one_way.fullmag.v1";
            let lane_blocked = requested.as_ref().is_some_and(|lane| {
                lane.device == "gpu"
                    || lane.precision == "single"
            });
            let transient = serde_json::to_value(known.mode).ok().and_then(|v| v.as_str().map(str::to_string)).as_deref() == Some("transient");
            if reciprocal {
                ("semantic_only", true, Some("M2 reciprocal authoring is available; executable qualification remains workload-scoped.".to_string()), requested)
            } else if transient {
                ("unsupported", false, Some("Transient spin transport is an M3 authoring capability.".to_string()), requested)
            } else if lane_blocked {
                ("unsupported", false, Some("M1 authoring is limited to CPU/auto, double precision, and strict or extended execution.".to_string()), requested)
            } else {
                ("semantic_only", true, Some("M1 steady one-way authoring is available; the execution lane is resolved only by planning.".to_string()), requested)
            }
        }
        TransportValidationCandidate::SpinInterface { resource, .. } => {
            let known = serde_json::from_value::<SceneSpinInterface>(resource.clone()).is_ok();
            if known {
                ("semantic_only", true, Some("Interface authoring is available; execution qualification remains workload-scoped.".to_string()), None)
            } else {
                ("unsupported", false, Some("Unknown spin interface variants are read-only.".to_string()), None)
            }
        }
        TransportValidationCandidate::SpinTorque { resource, .. } => match resource {
            SceneSpinTorque::Known(_) => (
                "source_visible",
                true,
                Some("Typed torque authoring is available; execution qualification is variant-specific.".to_string()),
                None,
            ),
            SceneSpinTorque::Unsupported(_) => (
                "unsupported",
                false,
                Some("Unknown spin torque variants are read-only.".to_string()),
                None,
            ),
        },
        TransportValidationCandidate::OerstedField { resource, .. } => match resource {
            SceneOerstedField::Known(_) => (
                "source_visible",
                true,
                Some("Typed Oersted authoring is available; execution qualification is realization-specific.".to_string()),
                None,
            ),
            SceneOerstedField::Unsupported(_) => (
                "unsupported",
                false,
                Some("Unknown Oersted field variants are read-only.".to_string()),
                None,
            ),
        },
    };
    TransportExecutionCapability {
        status: status.to_string(),
        qualification: status.to_string(),
        authoring_allowed: allowed,
        reason,
        requested_lane: requested,
        resolved_lane: None,
    }
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

fn ensure_candidate_authorable(
    scene: &SceneDocument,
    candidate: TransportValidationCandidate,
) -> Result<(), ApiError> {
    let capability = candidate_capability(&candidate);
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
    let mut clone = scene.clone();
    apply_validation_candidate(&mut clone, candidate).map_err(ApiError::bad_request)?;
    fullmag_authoring::validate_scene_document(&clone)
        .map_err(|error| ApiError::bad_request(error.message))?;
    Ok(())
}

fn ensure_resulting_scene_authorable(
    scene: &SceneDocument,
    removed: &TransportValidationCandidate,
) -> Result<(), ApiError> {
    let capability = candidate_capability(removed);
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    require_spin_base_revision(&scene, req.base_revision)?;
    let mut execution = candidate_capability(&req.candidate);
    let apply_error = apply_validation_candidate(&mut scene, req.candidate).err();
    let validation_error = apply_error.or_else(|| {
        fullmag_authoring::validate_scene_document(&scene)
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
    execution.authoring_allowed &= semantic.valid;
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let revisions = current_region_realization_revisions(&state).await;
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let realization = realize_geometry_scene(&scene, GeometryBackendTarget::from_scene(&scene));
    let revisions = current_region_realization_revisions(&state).await;
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let revisions = current_region_realization_revisions(&state).await;
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let guard = state.current_live_state.read().await;
    let latest_fields = guard.as_ref().map(|snapshot| &snapshot.latest_fields);
    let region_coefficients_revision = guard
        .as_ref()
        .map(|snapshot| snapshot.region_realization_revisions.coefficients)
        .unwrap_or_default();
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let (execution_plan, fem_mesh) = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|snapshot| {
            let execution_plan = snapshot
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.get("execution_plan"))
                .and_then(|value| {
                    serde_json::from_value::<fullmag_ir::ExecutionPlanIR>(value.clone()).ok()
                });
            (execution_plan, snapshot.fem_mesh.clone())
        })
        .unwrap_or((None, None));
    Ok(Json(CouplingListResource {
        scene_revision: scene.revision,
        couplings: authored_coupling_resources(&scene, execution_plan.as_ref(), fem_mesh.as_ref()),
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_create_field_drive_transaction(
        &mut scene,
        req.base_revision,
        req.drive
            .into_ir()
            .map_err(|error| ApiError::bad_request(format!("invalid field drive: {error}")))?,
    )?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_replace_field_drive_transaction(
        &mut scene,
        req.base_revision,
        &drive_id,
        req.drive
            .into_ir()
            .map_err(|error| ApiError::bad_request(format!("invalid field drive: {error}")))?,
    )?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_delete_field_drive_transaction(&mut scene, req.base_revision, &drive_id)?;
    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    authoring_transaction_response("delete_field_drive", committed)
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
    let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_create_coupling_transaction(&mut current_scene, req.base_revision, req.coupling)?;
    let committed = crate::commit_current_live_scene_document(&state, current_scene).await?;
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
    let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_patch_coupling_transaction(
        &mut current_scene,
        req.base_revision,
        &coupling_id,
        req.patch,
    )?;
    let committed = crate::commit_current_live_scene_document(&state, current_scene).await?;
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
    let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
    apply_delete_coupling_transaction(&mut current_scene, req.base_revision, &coupling_id)?;
    let committed = crate::commit_current_live_scene_document(&state, current_scene).await?;
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
    };
    let frame = match &field.value {
        fullmag_authoring::SceneMaterialParameterField::Linear { frame, .. } => Some(
            serde_json::to_value(frame)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string(),
        ),
        fullmag_authoring::SceneMaterialParameterField::Radial { frame, .. } => Some(
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
                raw_val = Some(val);
                break;
            }
        }

        if let Some(raw_val) = raw_val {
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
    let region_coefficients_revision = current_region_realization_revisions(&state)
        .await
        .coefficients;
    Ok(Json(build_material_resource(
        material,
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
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let material = scene
        .materials
        .iter_mut()
        .find(|entry| entry.id == material_id)
        .ok_or_else(|| ApiError::not_found(format!("material not found: {material_id}")))?;

    apply_material_patch_to_asset(material, req)?;

    sync_interfacial_dmi_for_material(&mut scene, &material_id);
    sync_bulk_dmi_for_material(&mut scene, &material_id);

    let committed = crate::commit_current_live_scene_document(&state, scene).await?;
    let material = committed
        .materials
        .iter()
        .find(|entry| entry.id == material_id)
        .ok_or_else(|| ApiError::internal(format!("committed material missing: {material_id}")))?;
    let region_coefficients_revision = current_region_realization_revisions(&state)
        .await
        .coefficients;
    Ok(Json(build_material_resource(
        material,
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
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    let asset = scene
        .magnetization_assets
        .iter()
        .find(|entry| entry.id == asset_id)
        .ok_or_else(|| ApiError::not_found(format!("magnetization asset not found: {asset_id}")))?;
    let initial_state_revision = current_region_realization_revisions(&state)
        .await
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
    let initial_state_revision = current_region_realization_revisions(&state)
        .await
        .initial_state;
    build_magnetization_asset_resource(&committed, asset, initial_state_revision).map(Json)
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
        AuthoringTransactionRequest::CreateMaterial {
            base_revision,
            material_id,
            name,
            properties,
            references,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_create_material_transaction(
                &mut current_scene,
                base_revision,
                material_id,
                name,
                properties,
                references,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("create_material", committed)
        }
        AuthoringTransactionRequest::PatchMaterial {
            base_revision,
            material_id,
            patch,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_patch_material_transaction(
                &mut current_scene,
                base_revision,
                &material_id,
                patch,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("patch_material", committed)
        }
        AuthoringTransactionRequest::DeleteMaterial {
            base_revision,
            material_id,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_delete_material_transaction(&mut current_scene, base_revision, &material_id)?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("delete_material", committed)
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
        AuthoringTransactionRequest::PatchObjectMaterialFields {
            base_revision,
            object_id,
            fields,
        } => {
            let mut current_scene = crate::get_or_load_current_live_scene_document(&state).await?;
            apply_patch_object_material_fields_transaction(
                &mut current_scene,
                base_revision,
                &object_id,
                fields,
            )?;
            let committed =
                crate::commit_current_live_scene_document(&state, current_scene).await?;
            ("patch_object_material_fields", committed)
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

fn authoring_transaction_response(
    transaction_kind: &str,
    committed: SceneDocument,
) -> Result<Json<AuthoringTransactionResponse>, ApiError> {
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
        role: "magnet".to_string(),
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
    scene.materials.push(SceneMaterialAsset {
        id: material_id.to_string(),
        name: name.to_string(),
        properties: fullmag_authoring::ScriptBuilderMaterialState {
            ms: properties.ms,
            aex: properties.aex,
            alpha: properties.alpha,
            dind: properties.dind,
            dbulk: properties.dbulk,
        },
        references: material_references_from_resources(references)?,
    });
    Ok(())
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
    apply_material_patch_to_asset(material, patch)?;
    sync_interfacial_dmi_for_material(scene, material_id);
    sync_bulk_dmi_for_material(scene, material_id);
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
        material.references = material_references_from_resources(references)?;
    }
    Ok(())
}

fn material_references_from_resources(
    references: Vec<MaterialReferenceResource>,
) -> Result<Vec<SceneMaterialReference>, ApiError> {
    references
        .into_iter()
        .map(|reference| {
            let label = trimmed_optional(reference.label);
            let url = trimmed_optional(reference.url);
            if let Some(url) = &url {
                if !(url.starts_with("https://") || url.starts_with("http://")) {
                    return Err(ApiError::bad_request(
                        "material reference url must start with http:// or https://",
                    ));
                }
            }
            Ok(SceneMaterialReference {
                label,
                url,
                citation: trimmed_optional(reference.citation),
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
    let removed_object = scene
        .objects
        .iter()
        .find(|object| object.id == object_id || object.name == object_id)
        .cloned()
        .ok_or_else(|| ApiError::not_found(format!("object not found: {object_id}")))?;
    scene
        .objects
        .retain(|object| object.id != removed_object.id);
    scene.couplings.retain(|coupling| {
        !coupling_references_object(coupling, &removed_object.id, &removed_object.name)
    });
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

    if patch.enabled == Some(false) {
        ensure_region_has_no_active_couplings(scene, object_id, region_id)?;
    }
    let object = find_scene_object_mut(scene, object_id)?;
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
    mark_object_mesh_dirty(object);
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
    {
        let object = find_scene_object_mut(scene, object_id)?;
        let before = object.regions.len();
        object.regions.retain(|entry| entry.region_id != region_id);
        if object.regions.len() == before {
            return Err(ApiError::not_found(format!(
                "object region not found: {region_id}"
            )));
        }
        object
            .material_parameter_fields
            .retain(|field| field.region_id.as_deref() != Some(region_id));
        mark_object_mesh_dirty(object);
    }
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
    if let Some(boundary_value) = req.absorbing_boundary {
        object.absorbing_boundary = boundary_value
            .map(|value| {
                serde_json::from_value(value).map_err(|error| {
                    ApiError::bad_request(format!("invalid absorbing boundary payload: {error}"))
                })
            })
            .transpose()?;
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
    region_id: &str,
) -> bool {
    endpoint_references_region(&coupling.source, object_id, region_id)
        || endpoint_references_region(&coupling.target, object_id, region_id)
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
    region_id: &str,
) -> Result<(), ApiError> {
    if let Some(coupling) = scene
        .couplings
        .iter()
        .filter(|coupling| coupling.enabled)
        .find(|coupling| coupling_references_region(coupling, object_id, region_id))
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
    region_id: &str,
) -> bool {
    match endpoint {
        fullmag_authoring::SceneCouplingEndpoint::Region {
            object,
            region_id: r_id,
        } => object == object_id && r_id == region_id,
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
            object == object_id || object == object_name
        }
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
        ScriptBuilderMagneticInteractionKind::BulkDmi => "bulk_dmi",
        ScriptBuilderMagneticInteractionKind::UniaxialAnisotropy => "uniaxial_anisotropy",
    }
}

async fn current_region_realization_revisions(
    state: &Arc<AppState>,
) -> fullmag_authoring::RegionRealizationRevisions {
    state
        .current_live_state
        .read()
        .await
        .as_ref()
        .map(|snapshot| snapshot.region_realization_revisions)
        .unwrap_or_default()
}

fn build_material_resource(
    material: &fullmag_authoring::SceneMaterialAsset,
    region_coefficients_revision: u64,
) -> MaterialResource {
    MaterialResource {
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
