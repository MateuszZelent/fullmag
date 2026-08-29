use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, State};
use axum::Json;
use fullmag_ir::{
    ConstraintActivationIR, EmptySelectionPolicyIR, FrozenReferencePolicyIR, FrozenSpinsIR,
    InactiveSelectionPolicyIR, MagnetizationConstraintIR, SelectionDefinitionIR, SelectionExprIR,
    SelectionMembershipPolicyIR,
};
use fullmag_plan::{
    compile_fdm_frozen_spins, compile_fem_frozen_spins, AffineTransform3, BoundaryMembership,
    FdmFrozenSpinsDomain, FemIncidentElement, FemTrueDofDomain, FrozenSpinsCompileRequest,
    FrozenSpinsStateSnapshot, GeometryPredicate, ResolvedFrozenSpinsReference,
    SelectionDofMembership,
};
use sha2::{Digest, Sha256};

use crate::error::{ApiDiagnostic, ApiError};
use crate::router_v2::handlers::data::resolved_spatial_field::{
    resolve_current_spatial_field, EntityMapping, FdmCellMembership, SpatialFieldCarrier,
};
use crate::router_v2::handlers::sessions::status::fdm_grid_fingerprint;
use crate::schemas::{
    FrozenSpinsCollectionResource, FrozenSpinsDefinitionResource, FrozenSpinsDeleteRequest,
    FrozenSpinsMutationRequest, FrozenSpinsPreviewActivationRequest,
    FrozenSpinsPreviewActivationResponse, FrozenSpinsPreviewRequest, FrozenSpinsPreviewResponse,
    FrozenSpinsRequestedIntent, FrozenSpinsResolvedPlanSummary, FrozenSpinsWarning,
};
use crate::session::FrozenSpinsPreviewRecord;
use crate::types::AppState;

const PREVIEW_SCHEMA_VERSION: &str = "frozen_spins_preview.v1";
const PREVIEW_CONSTRAINT_ID: &str = "__authoritative_preview__";

fn json_request<T>(request: Result<Json<T>, JsonRejection>) -> Result<T, ApiError> {
    request.map(|Json(value)| value).map_err(|rejection| {
        ApiError::unprocessable(format!("invalid_request_body: {}", rejection.body_text()))
    })
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/frozen-spins",
    responses((status = 200, body = FrozenSpinsCollectionResource)),
    tag = "model"
)]
pub async fn list_frozen_spins(
    State(state): State<Arc<AppState>>,
) -> Result<Json<FrozenSpinsCollectionResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    Ok(Json(collection_resource(&scene)))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/frozen-spins",
    request_body = FrozenSpinsMutationRequest,
    responses(
        (status = 200, body = FrozenSpinsDefinitionResource),
        (status = 409, description = "Revision or identity conflict", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Typed selector validation error", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "model"
)]
pub async fn create_frozen_spins(
    State(state): State<Arc<AppState>>,
    request: Result<Json<FrozenSpinsMutationRequest>, JsonRejection>,
) -> Result<Json<FrozenSpinsDefinitionResource>, ApiError> {
    let request = json_request(request)?;
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    check_revision(scene.revision, request.expected_revision)?;
    if scene
        .magnetization_constraints
        .iter()
        .any(|constraint| constraint.frozen_spins().id == request.definition.id)
    {
        return Err(ApiError::conflict(format!(
            "duplicate_frozen_spins_id: {}",
            request.definition.id
        )));
    }
    let definition_id = request.definition.id.clone();
    scene
        .magnetization_constraints
        .push(MagnetizationConstraintIR::FrozenSpins(request.definition));
    let committed = crate::commit_current_live_scene_document(&state, scene)
        .await
        .map_err(map_authoring_error)?;
    definition_resource(&committed, &definition_id).map(Json)
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/frozen-spins/{constraint_id}",
    params(("constraint_id" = String, Path)),
    responses(
        (status = 200, body = FrozenSpinsDefinitionResource),
        (status = 404, description = "Definition missing", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "model"
)]
pub async fn get_frozen_spins(
    State(state): State<Arc<AppState>>,
    Path(constraint_id): Path<String>,
) -> Result<Json<FrozenSpinsDefinitionResource>, ApiError> {
    let scene = crate::get_or_load_current_live_scene_document(&state).await?;
    definition_resource(&scene, &constraint_id).map(Json)
}

#[utoipa::path(
    patch,
    path = "/v2/sessions/current/model/frozen-spins/{constraint_id}",
    params(("constraint_id" = String, Path)),
    request_body = FrozenSpinsMutationRequest,
    responses(
        (status = 200, body = FrozenSpinsDefinitionResource),
        (status = 404, description = "Definition missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Revision or identity conflict", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Typed selector validation error", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "model"
)]
pub async fn patch_frozen_spins(
    State(state): State<Arc<AppState>>,
    Path(constraint_id): Path<String>,
    request: Result<Json<FrozenSpinsMutationRequest>, JsonRejection>,
) -> Result<Json<FrozenSpinsDefinitionResource>, ApiError> {
    let request = json_request(request)?;
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    check_revision(scene.revision, request.expected_revision)?;
    if request.definition.id != constraint_id {
        return Err(ApiError::conflict(
            "frozen_spins_id_mismatch: path identity and definition id differ",
        ));
    }
    let slot = scene
        .magnetization_constraints
        .iter_mut()
        .find(|constraint| constraint.frozen_spins().id == constraint_id)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "frozen spins definition not found: {constraint_id}"
            ))
        })?;
    *slot = MagnetizationConstraintIR::FrozenSpins(request.definition);
    let committed = crate::commit_current_live_scene_document(&state, scene)
        .await
        .map_err(map_authoring_error)?;
    definition_resource(&committed, &constraint_id).map(Json)
}

#[utoipa::path(
    delete,
    path = "/v2/sessions/current/model/frozen-spins/{constraint_id}",
    params(("constraint_id" = String, Path)),
    request_body = FrozenSpinsDeleteRequest,
    responses(
        (status = 200, body = FrozenSpinsCollectionResource),
        (status = 404, description = "Definition missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Revision conflict", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Invalid request body", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "model"
)]
pub async fn delete_frozen_spins(
    State(state): State<Arc<AppState>>,
    Path(constraint_id): Path<String>,
    request: Result<Json<FrozenSpinsDeleteRequest>, JsonRejection>,
) -> Result<Json<FrozenSpinsCollectionResource>, ApiError> {
    let request = json_request(request)?;
    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    check_revision(scene.revision, request.expected_revision)?;
    let before = scene.magnetization_constraints.len();
    scene
        .magnetization_constraints
        .retain(|constraint| constraint.frozen_spins().id != constraint_id);
    if scene.magnetization_constraints.len() == before {
        return Err(ApiError::not_found(format!(
            "frozen spins definition not found: {constraint_id}"
        )));
    }
    let committed = crate::commit_current_live_scene_document(&state, scene)
        .await
        .map_err(map_authoring_error)?;
    Ok(Json(collection_resource(&committed)))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/frozen-spins/previews",
    request_body = FrozenSpinsPreviewRequest,
    responses(
        (status = 200, body = FrozenSpinsPreviewResponse),
        (status = 409, description = "Stale source-state or topology revision", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Typed selector validation error", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "model"
)]
pub async fn create_frozen_spins_preview(
    State(state): State<Arc<AppState>>,
    request: Result<Json<FrozenSpinsPreviewRequest>, JsonRejection>,
) -> Result<Json<FrozenSpinsPreviewResponse>, ApiError> {
    let request = json_request(request)?;
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("current scene document is unavailable"))?;
    check_revision(scene.revision, request.expected_revision)?;
    validate_target(scene, &request.target_object_id)?;
    validate_preview_stage(scene, request.stage_id.as_deref())?;

    let actual_source_revision = snapshot
        .field_quantity_revisions
        .get("m")
        .copied()
        .filter(|revision| *revision > 0)
        .ok_or_else(|| {
            ApiError::conflict(
                "selection_stale_revision: current magnetization has no authoritative source-state revision",
            )
        })?;
    if request.expected_source_state_revision != actual_source_revision {
        return Err(ApiError::conflict(format!(
            "selection_stale_revision: expected source-state revision {}, current {}",
            request.expected_source_state_revision, actual_source_revision
        )));
    }
    let known_entities = selection_context(scene);
    reject_selector_target_mismatch(
        &request.selector,
        &request.target_object_id,
        &scene.selections,
    )?;
    let requested_root_id = collision_free_selection_id(&scene.selections, "requested");
    let mut requested_definitions = scene.selections.clone();
    requested_definitions.push(SelectionDefinitionIR::new(
        requested_root_id.clone(),
        request.selector.clone(),
    ));
    fullmag_ir::validate_selection_definitions_with_context(
        &requested_definitions,
        fullmag_ir::SelectionLimits::default(),
        &known_entities,
    )
    .map_err(map_selection_messages)?;
    let selector_sha256 =
        fullmag_ir::canonical_selection_sha256(&requested_root_id, &requested_definitions)
            .map_err(|message| ApiError::unprocessable(format!("selection_invalid: {message}")))?;

    let effective_selector = SelectionExprIR::And {
        expressions: vec![
            SelectionExprIR::InObject {
                object_id: request.target_object_id.clone(),
            },
            request.selector.clone(),
        ],
    };
    let effective_root_id = collision_free_selection_id(&scene.selections, "effective");
    let mut effective_definitions = scene.selections.clone();
    effective_definitions.push(SelectionDefinitionIR::new(
        effective_root_id.clone(),
        effective_selector.clone(),
    ));
    let effective_selector_sha256 =
        fullmag_ir::canonical_selection_sha256(&effective_root_id, &effective_definitions)
            .map_err(|message| ApiError::unprocessable(format!("selection_invalid: {message}")))?;

    let field = resolve_current_spatial_field(snapshot, "m", 3)?.ok_or_else(|| {
        ApiError::conflict("selection_stale_revision: current magnetization is unavailable")
    })?;
    let magnetization = field
        .values
        .chunks_exact(3)
        .map(|value| [value[0], value[1], value[2]])
        .collect::<Vec<_>>();
    let fem_topology = matches!(&field.carrier, SpatialFieldCarrier::FemNodes { .. });
    let actual_topology = match &field.carrier {
        SpatialFieldCarrier::FdmCells { .. } => fdm_grid_fingerprint(snapshot)
            .ok_or_else(|| {
                ApiError::conflict(
                    "selection_topology_mismatch: current FDM domain has no canonical grid fingerprint",
                )
            })?
            .to_string(),
        SpatialFieldCarrier::FemNodes {
            topology_fingerprint,
            ..
        } => topology_fingerprint.clone(),
        SpatialFieldCarrier::FemElements { .. } => {
            return Err(ApiError::unprocessable(
                "selection_variant_unsupported: FEM frozen-spins preview requires a nodal P1 magnetization carrier",
            ));
        }
        _ => {
            return Err(ApiError::unprocessable(
                "selection_variant_unsupported: frozen-spins preview carrier is unsupported",
            ));
        }
    };
    if request.expected_topology_fingerprint != actual_topology {
        return Err(ApiError::conflict(format!(
            "selection_topology_mismatch: expected topology '{}', current '{}'",
            request.expected_topology_fingerprint, actual_topology
        )));
    }

    let constraint = FrozenSpinsIR {
        schema_version: fullmag_ir::FROZEN_SPINS_SCHEMA_VERSION.to_string(),
        id: PREVIEW_CONSTRAINT_ID.to_string(),
        name: "Authoritative frozen-spins preview".to_string(),
        enabled: true,
        selector: effective_selector.clone(),
        reference: FrozenReferencePolicyIR::CaptureCurrentAtActivation {},
        membership: if fullmag_ir::selection_is_state_dependent(
            &effective_selector,
            &scene.selections,
        ) {
            SelectionMembershipPolicyIR::SnapshotAtActivation {}
        } else {
            SelectionMembershipPolicyIR::Static {}
        },
        activation: ConstraintActivationIR::AllStages {},
        empty_selection: EmptySelectionPolicyIR::Error,
        inactive_selection: InactiveSelectionPolicyIR::WarnAndIntersect,
    };
    let reference = ResolvedFrozenSpinsReference {
        constraint_id: PREVIEW_CONSTRAINT_ID,
        values: &magnetization,
        source_state_revision: Some(actual_source_revision),
        topology_fingerprint: &actual_topology,
    };
    let transforms = object_transforms(scene);
    let compile_request = FrozenSpinsCompileRequest {
        constraints: std::slice::from_ref(&constraint),
        selections: &scene.selections,
        activation_stage_id: request.stage_id.as_deref(),
        object_transforms: &transforms,
        known_entities: &known_entities,
        state_snapshot: Some(FrozenSpinsStateSnapshot {
            magnetization: &magnetization,
            revision: actual_source_revision,
        }),
        resolved_references: std::slice::from_ref(&reference),
        expected_source_state_revision: Some(actual_source_revision),
        expected_grid_or_mesh_fingerprint: &actual_topology,
    };
    let resolved = match &field.carrier {
        SpatialFieldCarrier::FdmCells { .. } => {
            let sole_magnetic_object = (scene
                .objects
                .iter()
                .filter(|object| object.role == "magnet")
                .count()
                == 1)
                .then_some(request.target_object_id.as_str());
            let (counts, origin_m, cell_m, active_mask, memberships) =
                fdm_preview_domain(&field.carrier, magnetization.len(), sole_magnetic_object)?;
            compile_fdm_frozen_spins(
                &FdmFrozenSpinsDomain {
                    origin_m,
                    counts,
                    cell_m,
                    active_mask: &active_mask,
                    memberships: &memberships,
                    grid_fingerprint: &actual_topology,
                },
                &compile_request,
            )
            .map_err(map_selection_error)?
        }
        SpatialFieldCarrier::FemNodes {
            topology, mapping, ..
        } => {
            let (points_m, incident_elements) =
                fem_preview_domain(scene, topology, mapping, magnetization.len())?;
            compile_fem_frozen_spins(
                &FemTrueDofDomain {
                    fe_order: 1,
                    true_dof_points_m: &points_m,
                    incident_elements: &incident_elements,
                    mesh_fingerprint: &actual_topology,
                },
                &compile_request,
            )
            .map_err(map_selection_error)?
        }
        _ => unreachable!("carrier was validated above"),
    };
    let mask_hash = canonical_sha256(&resolved.mask_sha256);
    let preview_identity = serde_json::to_vec(&serde_json::json!({
        "session_id": snapshot.session.session_id,
        "scene_revision": scene.revision,
        "source_state_revision": actual_source_revision,
        "topology_fingerprint": actual_topology,
        "target_object_id": request.target_object_id,
        "stage_id": request.stage_id,
        "requested_selector_sha256": canonical_sha256(&selector_sha256),
        "effective_selector_sha256": canonical_sha256(&effective_selector_sha256),
        "mask_sha256": mask_hash,
    }))
    .map_err(|error| ApiError::internal(format!("failed to encode preview identity: {error}")))?;
    let preview_id = format!("fsp-{}", sha256_hex(&preview_identity));
    let activation_candidate_token = format!(
        "fsact-{}",
        sha256_hex(
            &[
                b"fullmag.frozen-spins.activation-candidate.v1\0".as_slice(),
                preview_identity.as_slice(),
            ]
            .concat(),
        )
    );
    let response = FrozenSpinsPreviewResponse {
        schema_version: PREVIEW_SCHEMA_VERSION.to_string(),
        preview_id: preview_id.clone(),
        activation_candidate_token,
        revision: scene.revision,
        current: true,
        frozen_dof_count: resolved.frozen_dof_count,
        free_dof_count: resolved.free_dof_count,
        fraction: if resolved.active_dof_count == 0 {
            0.0
        } else {
            resolved.frozen_dof_count as f64 / resolved.active_dof_count as f64
        },
        bounds_m: resolved.certificate.bounds_m,
        mask_sha256: mask_hash,
        warnings: resolved
            .certificate
            .warnings
            .iter()
            .map(|warning| typed_warning(warning))
            .collect(),
        mask_resource: format!(
            "/v2/sessions/current/data/frozen-spins/resolved-masks/{preview_id}"
        ),
        requested: FrozenSpinsRequestedIntent {
            target_object_id: request.target_object_id,
            stage_id: request.stage_id,
            selector_sha256: canonical_sha256(&selector_sha256),
        },
        resolved: FrozenSpinsResolvedPlanSummary {
            schema_version: resolved.schema_version.clone(),
            evaluator_id: resolved.certificate.evaluator_id.clone(),
            constraint_ids: resolved.constraint_ids.clone(),
            topology_fingerprint: resolved.grid_or_mesh_fingerprint.clone(),
            effective_selector_sha256: canonical_sha256(&effective_selector_sha256),
            source_state_revision: resolved.source_state_revision,
            resolved_reference_sha256: canonical_sha256(
                &resolved.certificate.resolved_reference_sha256,
            ),
            all_active_dofs_frozen: resolved.all_active_dofs_frozen,
            qualification: "UNQUALIFIED".to_string(),
        },
    };
    let record = FrozenSpinsPreviewRecord {
        session_id: snapshot.session.session_id.clone(),
        scene_revision: scene.revision,
        source_state_revision: actual_source_revision,
        fem_topology,
        topology_fingerprint: actual_topology,
        requested_selector: request.selector,
        response: response.clone(),
        frozen_mask: resolved.frozen_mask,
    };
    drop(guard);
    insert_current_preview_record(&state, preview_id, record).await?;
    Ok(Json(response))
}

#[utoipa::path(
    get,
    path = "/v2/sessions/current/model/frozen-spins/previews/{preview_id}",
    params(("preview_id" = String, Path)),
    responses(
        (status = 200, body = FrozenSpinsPreviewResponse),
        (status = 404, description = "Preview missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Preview source-state or topology is stale", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "model"
)]
pub async fn get_frozen_spins_preview(
    State(state): State<Arc<AppState>>,
    Path(preview_id): Path<String>,
) -> Result<Json<FrozenSpinsPreviewResponse>, ApiError> {
    let record = current_preview_record(&state, &preview_id)
        .await?
        .ok_or_else(|| {
            ApiError::not_found(format!("frozen spins preview not found: {preview_id}"))
        })?;
    Ok(Json(record.response))
}

#[utoipa::path(
    post,
    path = "/v2/sessions/current/model/frozen-spins/previews/{preview_id}/activate",
    params(("preview_id" = String, Path)),
    request_body = FrozenSpinsPreviewActivationRequest,
    responses(
        (status = 200, body = FrozenSpinsPreviewActivationResponse),
        (status = 404, description = "Preview or definition missing", body = crate::schemas::common::ApiErrorResponse),
        (status = 409, description = "Stale, consumed, or mismatched activation candidate", body = crate::schemas::common::ApiErrorResponse),
        (status = 422, description = "Definition is incompatible with the preview", body = crate::schemas::common::ApiErrorResponse)
    ),
    tag = "model"
)]
pub async fn activate_frozen_spins_preview(
    State(state): State<Arc<AppState>>,
    Path(preview_id): Path<String>,
    request: Result<Json<FrozenSpinsPreviewActivationRequest>, JsonRejection>,
) -> Result<Json<FrozenSpinsPreviewActivationResponse>, ApiError> {
    let request = json_request(request)?;
    let _transition = state.current_live_session_transition.lock().await;
    let record = match current_preview_record(&state, &preview_id).await? {
        Some(record) => record,
        None => {
            if state
                .frozen_spins_previews
                .read()
                .await
                .activation_token_was_consumed(&preview_id, &request.activation_candidate_token)
            {
                return Err(ApiError::conflict(
                    "stale_activation_candidate: activation candidate was already consumed",
                ));
            }
            return Err(ApiError::not_found(format!(
                "frozen spins preview not found: {preview_id}"
            )));
        }
    };
    if request.activation_candidate_token != record.response.activation_candidate_token {
        return Err(ApiError::conflict(
            "stale_activation_candidate: activation token does not match the current preview",
        ));
    }
    if request.expected_revision != record.scene_revision {
        return Err(ApiError::conflict(format!(
            "selection_stale_revision: activation expected scene revision {}, preview was computed at {}",
            request.expected_revision, record.scene_revision
        )));
    }

    let mut scene = crate::get_or_load_current_live_scene_document(&state).await?;
    check_revision(scene.revision, request.expected_revision)?;
    validate_activation_definition(&scene, &record, &request.definition)?;
    let definition_id = request.definition.id.clone();
    let slot = scene
        .magnetization_constraints
        .iter_mut()
        .find(|constraint| constraint.frozen_spins().id == definition_id)
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "frozen spins definition not found: {definition_id}"
            ))
        })?;
    *slot = MagnetizationConstraintIR::FrozenSpins(request.definition);
    let committed = crate::commit_current_live_scene_document(&state, scene)
        .await
        .map_err(map_authoring_error)?;
    let definition = committed
        .magnetization_constraints
        .iter()
        .map(MagnetizationConstraintIR::frozen_spins)
        .find(|definition| definition.id == definition_id)
        .cloned()
        .ok_or_else(|| ApiError::internal("activated frozen-spins definition disappeared"))?;

    let consumed = state
        .frozen_spins_previews
        .write()
        .await
        .consume(&preview_id, &record.response.activation_candidate_token)
        .is_some();
    if !consumed {
        return Err(ApiError::conflict(
            "stale_activation_candidate: activation candidate was already consumed",
        ));
    }
    Ok(Json(FrozenSpinsPreviewActivationResponse {
        schema_version: "frozen_spins_activation.v1".to_string(),
        preview_id,
        activation_candidate_token_consumed: true,
        source_state_revision: record.source_state_revision,
        topology_fingerprint: record.topology_fingerprint,
        mask_sha256: record.response.mask_sha256,
        mask_resource: record.response.mask_resource,
        revision: committed.revision,
        definition,
    }))
}

pub(crate) async fn insert_current_preview_record(
    state: &Arc<AppState>,
    preview_id: String,
    record: FrozenSpinsPreviewRecord,
) -> Result<(), ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    if snapshot.session.session_id != record.session_id {
        return Err(ApiError::conflict(
            "selection_stale_revision: preview was computed for a superseded session",
        ));
    }
    let mut previews = state.frozen_spins_previews.write().await;
    previews.retain_session(&snapshot.session.session_id);
    previews.insert(preview_id, record);
    Ok(())
}

fn validate_activation_definition(
    scene: &fullmag_authoring::SceneDocument,
    record: &FrozenSpinsPreviewRecord,
    definition: &FrozenSpinsIR,
) -> Result<(), ApiError> {
    if !definition.enabled {
        return Err(ApiError::unprocessable(
            "activation_candidate_mismatch: a disabled Frozen Spins definition cannot consume an activation candidate",
        ));
    }
    if !matches!(
        definition.reference,
        FrozenReferencePolicyIR::CaptureCurrentAtActivation {}
    ) {
        return Err(ApiError::unprocessable(
            "activation_candidate_mismatch: preview reference was captured from current magnetization but the definition uses another reference policy",
        ));
    }
    reject_selector_target_mismatch(
        &definition.selector,
        &record.response.requested.target_object_id,
        &scene.selections,
    )?;
    if definition.selector != record.requested_selector {
        return Err(ApiError::conflict(
            "activation_candidate_mismatch: definition selector differs from the previewed selector",
        ));
    }
    if let Some(stage_id) = record.response.requested.stage_id.as_deref() {
        let active = match &definition.activation {
            ConstraintActivationIR::AllStages {} => true,
            ConstraintActivationIR::StageIds { stage_ids } => {
                stage_ids.iter().any(|candidate| candidate == stage_id)
            }
        };
        if !active {
            return Err(ApiError::conflict(format!(
                "activation_candidate_mismatch: definition is not active for preview stage '{stage_id}'"
            )));
        }
    }
    Ok(())
}

pub(crate) async fn current_preview_record(
    state: &Arc<AppState>,
    preview_id: &str,
) -> Result<Option<FrozenSpinsPreviewRecord>, ApiError> {
    let guard = state.current_live_state.read().await;
    let snapshot = guard
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    let record = {
        let mut previews = state.frozen_spins_previews.write().await;
        previews.retain_session(&snapshot.session.session_id);
        previews.get(preview_id).cloned()
    };
    let Some(record) = record else {
        return Ok(None);
    };
    ensure_preview_current(snapshot, &record)?;
    Ok(Some(record))
}

fn ensure_preview_current(
    snapshot: &crate::types::SessionStateResponse,
    record: &FrozenSpinsPreviewRecord,
) -> Result<(), ApiError> {
    if snapshot.session.session_id != record.session_id {
        return Err(ApiError::conflict(
            "selection_stale_revision: preview belongs to another session",
        ));
    }
    let current_scene_revision = snapshot.scene_document.as_ref().map(|scene| scene.revision);
    let current_source_revision = snapshot.field_quantity_revisions.get("m").copied();
    if current_scene_revision != Some(record.scene_revision)
        || current_source_revision != Some(record.source_state_revision)
    {
        return Err(ApiError::conflict(
            "selection_stale_revision: preview source state is no longer current",
        ));
    }
    let topology_matches = if record.fem_topology {
        snapshot
            .fem_mesh
            .as_ref()
            .map(fullmag_runner::fem_mesh_topology_fingerprint)
            .as_deref()
            == Some(record.topology_fingerprint.as_str())
    } else {
        fdm_grid_fingerprint(snapshot) == Some(record.topology_fingerprint.as_str())
    };
    if !topology_matches {
        return Err(ApiError::conflict(
            "selection_topology_mismatch: preview topology is no longer current",
        ));
    }
    Ok(())
}

fn fem_preview_domain(
    scene: &fullmag_authoring::SceneDocument,
    mesh: &fullmag_runner::FemMeshPayload,
    mapping: &EntityMapping,
    point_count: usize,
) -> Result<(Vec<[f64; 3]>, Vec<Vec<FemIncidentElement>>), ApiError> {
    let global_nodes = match mapping {
        EntityMapping::Identity { entity_count } => {
            if *entity_count != point_count || *entity_count != mesh.nodes.len() {
                return Err(ApiError::conflict(
                    "selection_domain_size_mismatch: FEM identity mapping disagrees with magnetization and mesh node counts",
                ));
            }
            (0..point_count)
                .map(|index| u32::try_from(index))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| {
                    ApiError::conflict(
                        "selection_domain_size_mismatch: FEM node index exceeds u32 carrier range",
                    )
                })?
        }
        EntityMapping::ExplicitLocalToGlobal(indices) => {
            if indices.len() != point_count
                || indices
                    .iter()
                    .any(|index| *index as usize >= mesh.nodes.len())
                || indices.iter().copied().collect::<BTreeSet<_>>().len() != indices.len()
            {
                return Err(ApiError::conflict(
                    "selection_domain_size_mismatch: FEM local-to-global mapping is not a unique in-bounds mapping for magnetization",
                ));
            }
            indices.clone()
        }
    };
    let points_m = global_nodes
        .iter()
        .map(|index| mesh.nodes[*index as usize])
        .collect::<Vec<_>>();
    let local_by_global = global_nodes
        .iter()
        .copied()
        .enumerate()
        .map(|(local, global)| (global, local))
        .collect::<BTreeMap<_, _>>();

    let object_transforms = object_transforms(scene);
    let mut region_predicates = Vec::new();
    for object in scene
        .objects
        .iter()
        .filter(|object| object.role == "magnet")
    {
        for region in object.regions.iter().filter(|region| region.enabled) {
            let region_ir: fullmag_ir::ObjectRegionIR = region.clone().into();
            let transform = match region.frame {
                fullmag_authoring::SceneRegionFrame::Object => object_transforms
                    .get(&object.id)
                    .cloned()
                    .unwrap_or_else(AffineTransform3::identity),
                fullmag_authoring::SceneRegionFrame::World => AffineTransform3::identity(),
            };
            let predicate = GeometryPredicate::from_object_region(
                &region_ir,
                transform,
                BoundaryMembership::inclusive(),
            )
            .map_err(map_selection_error)?;
            region_predicates.push((object.id.clone(), region.region_id.clone(), predicate));
        }
    }

    if mesh.object_segments.is_empty() {
        return Err(ApiError::unprocessable(
            "selection_variant_unsupported: FEM preview topology has no authoritative object segments",
        ));
    }
    let mut incident_elements = vec![Vec::new(); point_count];
    for cell in mesh.cells.iter() {
        let covering_segments = mesh
            .object_segments
            .iter()
            .filter(|segment| {
                let start = segment.element_start as usize;
                let end = start.saturating_add(segment.element_count as usize);
                (start..end).contains(&cell.ordinal)
            })
            .collect::<Vec<_>>();
        if covering_segments.len() != 1 {
            return Err(ApiError::conflict(format!(
                "selection_topology_mismatch: FEM element {} belongs to {} object segments; exactly one is required",
                cell.ordinal,
                covering_segments.len()
            )));
        }
        let segment = covering_segments[0];
        let owner = if segment.object_id == "__air__" {
            None
        } else {
            Some(resolve_fem_segment_owner(scene, segment)?)
        };
        for global_node in cell.nodes {
            let Some(local_node) = local_by_global.get(global_node).copied() else {
                continue;
            };
            let incident = if let Some(owner) = owner.as_ref() {
                let point = points_m[local_node];
                let region_ids = region_predicates
                    .iter()
                    .filter(|(candidate, _, _)| candidate == owner)
                    .filter_map(
                        |(_, region_id, predicate)| match predicate.contains(point) {
                            Ok(true) => Some(Ok(region_id.clone())),
                            Ok(false) => None,
                            Err(error) => Some(Err(map_selection_error(error))),
                        },
                    )
                    .collect::<Result<Vec<_>, ApiError>>()?;
                FemIncidentElement {
                    magnetic: true,
                    object_id: Some(owner.clone()),
                    region_ids,
                }
            } else {
                FemIncidentElement::air()
            };
            incident_elements[local_node].push(incident);
        }
    }
    if let Some(local_node) = incident_elements.iter().position(Vec::is_empty) {
        return Err(ApiError::conflict(format!(
            "selection_topology_mismatch: FEM magnetization local node {local_node} has no incident mesh element"
        )));
    }
    Ok((points_m, incident_elements))
}

fn resolve_fem_segment_owner(
    scene: &fullmag_authoring::SceneDocument,
    segment: &fullmag_runner::FemMeshObjectSegment,
) -> Result<String, ApiError> {
    let matches = scene
        .objects
        .iter()
        .filter(|object| object.role == "magnet")
        .filter(|object| {
            object_ids_match(&segment.object_id, &object.id)
                || segment
                    .geometry_id
                    .as_deref()
                    .map(|geometry_id| object_ids_match(geometry_id, &object.id))
                    .unwrap_or(false)
        })
        .map(|object| object.id.clone())
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [owner] => Ok(owner.clone()),
        [] => Err(ApiError::conflict(format!(
            "selection_unknown_object: FEM segment '{}' has no matching magnetic scene object",
            segment.object_id
        ))),
        _ => Err(ApiError::conflict(format!(
            "selection_ambiguous_object: FEM segment '{}' matches multiple magnetic scene objects",
            segment.object_id
        ))),
    }
}

fn object_ids_match(left: &str, right: &str) -> bool {
    fn normalized(value: &str) -> &str {
        let value = value.strip_prefix("object:").unwrap_or(value);
        value
            .strip_suffix("_geom")
            .or_else(|| value.strip_suffix("_geometry"))
            .or_else(|| value.strip_suffix("-geometry"))
            .unwrap_or(value)
    }
    normalized(left) == normalized(right)
}

fn fdm_preview_domain(
    carrier: &SpatialFieldCarrier<'_>,
    point_count: usize,
    sole_magnetic_object_id: Option<&str>,
) -> Result<
    (
        [u32; 3],
        [f64; 3],
        [f64; 3],
        Vec<bool>,
        Vec<SelectionDofMembership>,
    ),
    ApiError,
> {
    let SpatialFieldCarrier::FdmCells {
        cells,
        origin_m,
        cell_size_m,
        membership,
        ..
    } = carrier
    else {
        return Err(ApiError::unprocessable(
            "selection_variant_unsupported: authoritative FEM true-DOF preview carrier is unavailable",
        ));
    };
    let origin_m = origin_m.ok_or_else(|| {
        ApiError::conflict("selection_topology_mismatch: FDM origin is unavailable")
    })?;
    let cell_m = cell_size_m.ok_or_else(|| {
        ApiError::conflict("selection_topology_mismatch: FDM cell size is unavailable")
    })?;
    let expected_count = cells
        .iter()
        .try_fold(1usize, |value, count| value.checked_mul(*count as usize))
        .ok_or_else(|| ApiError::conflict("selection_domain_size_mismatch: FDM grid overflows"))?;
    if expected_count != point_count {
        return Err(ApiError::conflict(format!(
            "selection_domain_size_mismatch: FDM grid contains {expected_count} cells but magnetization has {point_count} samples"
        )));
    }
    let (active_mask, memberships) = match membership {
        Some(membership) => memberships_from_fdm(membership, point_count)?,
        None => {
            let object_id = sole_magnetic_object_id.ok_or_else(|| {
                ApiError::conflict(
                    "selection_membership_unavailable: multi-object FDM preview requires authoritative object membership",
                )
            })?;
            (
                vec![true; point_count],
                (0..point_count)
                    .map(|_| SelectionDofMembership {
                        object_ids: vec![object_id.to_string()],
                        ..SelectionDofMembership::default()
                    })
                    .collect(),
            )
        }
    };
    Ok((*cells, origin_m, cell_m, active_mask, memberships))
}

fn memberships_from_fdm(
    membership: &FdmCellMembership,
    point_count: usize,
) -> Result<(Vec<bool>, Vec<SelectionDofMembership>), ApiError> {
    if membership.cell_membership.len() != point_count {
        return Err(ApiError::conflict(
            "selection_domain_size_mismatch: FDM membership length differs from magnetization",
        ));
    }
    let sole_object = (membership.object_ids.len() == 1).then(|| membership.object_ids[0].clone());
    let legend = membership
        .region_legend
        .iter()
        .map(|entry| {
            (
                entry.numeric_id,
                (entry.object_id.clone(), entry.region_id.clone()),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut active_mask = Vec::with_capacity(point_count);
    let mut resolved = Vec::with_capacity(point_count);
    for numeric_id in &membership.cell_membership {
        let active = *numeric_id != u32::MAX;
        active_mask.push(active);
        let mut item = SelectionDofMembership::default();
        if active {
            if let Some((object_id, region_id)) = legend.get(numeric_id) {
                item.object_ids.push(object_id.clone());
                item.region_ids.push((object_id.clone(), region_id.clone()));
            } else if *numeric_id == 0 {
                if let Some(object_id) = sole_object.as_ref() {
                    item.object_ids.push(object_id.clone());
                }
            } else {
                return Err(ApiError::conflict(format!(
                    "selection_unknown_region: realized FDM membership uses unknown numeric id {numeric_id}"
                )));
            }
        }
        resolved.push(item);
    }
    Ok((active_mask, resolved))
}

fn collection_resource(scene: &fullmag_authoring::SceneDocument) -> FrozenSpinsCollectionResource {
    let definitions = scene
        .magnetization_constraints
        .iter()
        .map(|constraint| constraint.frozen_spins().clone())
        .collect::<Vec<_>>();
    FrozenSpinsCollectionResource {
        revision: scene.revision,
        count: definitions.len(),
        definitions,
    }
}

fn definition_resource(
    scene: &fullmag_authoring::SceneDocument,
    constraint_id: &str,
) -> Result<FrozenSpinsDefinitionResource, ApiError> {
    let definition = scene
        .magnetization_constraints
        .iter()
        .map(MagnetizationConstraintIR::frozen_spins)
        .find(|definition| definition.id == constraint_id)
        .cloned()
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "frozen spins definition not found: {constraint_id}"
            ))
        })?;
    Ok(FrozenSpinsDefinitionResource {
        revision: scene.revision,
        definition,
    })
}

fn check_revision(current: u64, expected: u64) -> Result<(), ApiError> {
    if current == expected {
        Ok(())
    } else {
        Err(ApiError::conflict(format!(
            "selection_stale_revision: expected scene revision {expected}, current {current}"
        )))
    }
}

fn validate_target(
    scene: &fullmag_authoring::SceneDocument,
    target_object_id: &str,
) -> Result<(), ApiError> {
    if scene
        .objects
        .iter()
        .any(|object| object.id == target_object_id && object.role == "magnet")
    {
        Ok(())
    } else {
        Err(ApiError::unprocessable(format!(
            "selection_unknown_object: target object '{target_object_id}' does not exist as a magnetic object"
        )))
    }
}

fn validate_preview_stage(
    scene: &fullmag_authoring::SceneDocument,
    stage_id: Option<&str>,
) -> Result<(), ApiError> {
    let Some(stage_id) = stage_id else {
        return Ok(());
    };
    let mut known = std::collections::BTreeSet::new();
    if let Some(pipeline) = &scene.study.study_pipeline {
        collect_pipeline_stage_ids(&pipeline.nodes, &mut known);
    }
    if known.contains(stage_id) {
        Ok(())
    } else {
        Err(ApiError::unprocessable(format!(
            "selection_unknown_stage: preview stage '{stage_id}' does not exist"
        )))
    }
}

fn collect_pipeline_stage_ids(
    nodes: &[fullmag_authoring::StudyPipelineNode],
    ids: &mut std::collections::BTreeSet<String>,
) {
    for node in nodes {
        match node {
            fullmag_authoring::StudyPipelineNode::Primitive(node) => {
                ids.insert(node.id.clone());
            }
            fullmag_authoring::StudyPipelineNode::Macro(node) => {
                ids.insert(node.id.clone());
            }
            fullmag_authoring::StudyPipelineNode::Group(node) => {
                ids.insert(node.id.clone());
                collect_pipeline_stage_ids(&node.children, ids);
            }
        }
    }
}

fn collision_free_selection_id(definitions: &[SelectionDefinitionIR], purpose: &str) -> String {
    let mut index = 0_u64;
    loop {
        let candidate = format!("__frozen_spins_preview_{purpose}_{index}");
        if definitions
            .iter()
            .all(|definition| definition.id != candidate)
        {
            return candidate;
        }
        index = index.saturating_add(1);
    }
}

fn reject_selector_target_mismatch(
    selector: &SelectionExprIR,
    target_object_id: &str,
    definitions: &[SelectionDefinitionIR],
) -> Result<(), ApiError> {
    let by_id = definitions
        .iter()
        .map(|definition| (definition.id.as_str(), &definition.expression))
        .collect::<BTreeMap<_, _>>();
    if selector_mentions_other_object(selector, target_object_id, &by_id, &mut Vec::new()) {
        Err(ApiError::unprocessable(format!(
            "selection_target_mismatch: selector explicitly targets an object other than '{target_object_id}'"
        )))
    } else {
        Ok(())
    }
}

fn selector_mentions_other_object<'a>(
    selector: &'a SelectionExprIR,
    target_object_id: &str,
    definitions: &BTreeMap<&'a str, &'a SelectionExprIR>,
    visiting: &mut Vec<&'a str>,
) -> bool {
    match selector {
        SelectionExprIR::InObject { object_id } | SelectionExprIR::InRegion { object_id, .. } => {
            object_id != target_object_id
        }
        SelectionExprIR::InsideGeometry { frame, .. } => matches!(
            frame,
            fullmag_ir::SelectionFrameIR::Object { object_id }
                if object_id != target_object_id
        ),
        SelectionExprIR::And { expressions }
        | SelectionExprIR::Or { expressions }
        | SelectionExprIR::Xor { expressions } => expressions.iter().any(|expression| {
            selector_mentions_other_object(expression, target_object_id, definitions, visiting)
        }),
        SelectionExprIR::Ref { selection_id } => {
            if visiting.contains(&selection_id.as_str()) {
                return false;
            }
            visiting.push(selection_id);
            let mismatched = definitions
                .get(selection_id.as_str())
                .is_some_and(|expression| {
                    selector_mentions_other_object(
                        expression,
                        target_object_id,
                        definitions,
                        visiting,
                    )
                });
            visiting.pop();
            mismatched
        }
        SelectionExprIR::Not { expression } => {
            selector_mentions_other_object(expression, target_object_id, definitions, visiting)
        }
        SelectionExprIR::AllMagnetic {}
        | SelectionExprIR::Compare { .. }
        | SelectionExprIR::Approx { .. }
        | SelectionExprIR::Between { .. } => false,
    }
}

fn selection_context(
    scene: &fullmag_authoring::SceneDocument,
) -> fullmag_ir::SelectionValidationContext {
    fullmag_ir::SelectionValidationContext::new(
        scene.objects.iter().map(|object| object.id.clone()),
        scene.objects.iter().flat_map(|object| {
            object
                .regions
                .iter()
                .map(move |region| (object.id.clone(), region.region_id.clone()))
        }),
    )
}

fn object_transforms(
    scene: &fullmag_authoring::SceneDocument,
) -> BTreeMap<String, AffineTransform3> {
    scene
        .objects
        .iter()
        .map(|object| {
            (
                object.id.clone(),
                AffineTransform3 {
                    translation_m: object.transform.translation,
                    rotation_xyzw: object.transform.rotation_quat,
                    scale: object.transform.scale,
                    pivot_m: object.transform.pivot,
                },
            )
        })
        .collect()
}

fn map_selection_error(error: fullmag_plan::SelectionError) -> ApiError {
    let message = error.to_string();
    match error.code() {
        "selection_stale_revision" | "selection_topology_mismatch" => ApiError::conflict(message),
        _ => ApiError::unprocessable(message),
    }
}

fn map_selection_messages(errors: Vec<String>) -> ApiError {
    const MAX_DIAGNOSTICS: usize = 32;
    let diagnostics = errors
        .into_iter()
        .take(MAX_DIAGNOSTICS)
        .map(|error| {
            let (code, message) = error
                .split_once(':')
                .map(|(code, message)| (code.trim(), message.trim()))
                .unwrap_or(("selection_invalid", error.as_str()));
            ApiDiagnostic {
                code: code.to_string(),
                message: message.to_string(),
            }
        })
        .collect::<Vec<_>>();
    let primary = diagnostics.first().cloned().unwrap_or(ApiDiagnostic {
        code: "selection_invalid".to_string(),
        message: "selection validation failed".to_string(),
    });
    ApiError::unprocessable_with_diagnostics(
        format!("{}: {}", primary.code, primary.message),
        diagnostics,
    )
}

fn map_authoring_error(error: ApiError) -> ApiError {
    if error.status == axum::http::StatusCode::BAD_REQUEST
        && (error.message.starts_with("selection_") || error.message.starts_with("frozen_"))
    {
        ApiError::unprocessable(error.message)
    } else {
        error
    }
}

fn typed_warning(message: &str) -> FrozenSpinsWarning {
    let (code, detail) = message
        .split_once(':')
        .map(|(code, detail)| (code.trim(), detail.trim()))
        .unwrap_or(("selection_warning", message));
    FrozenSpinsWarning {
        code: code.to_string(),
        message: detail.to_string(),
    }
}

fn canonical_sha256(value: &str) -> String {
    if value.starts_with("sha256:") {
        value.to_string()
    } else {
        format!("sha256:{value}")
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
