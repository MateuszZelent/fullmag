use std::collections::BTreeMap;
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
    compile_fdm_frozen_spins, AffineTransform3, FdmFrozenSpinsDomain, FrozenSpinsCompileRequest,
    FrozenSpinsStateSnapshot, ResolvedFrozenSpinsReference, SelectionDofMembership,
};
use sha2::{Digest, Sha256};

use crate::error::{ApiDiagnostic, ApiError};
use crate::router_v2::handlers::data::resolved_spatial_field::{
    resolve_current_spatial_field, FdmCellMembership, SpatialFieldCarrier,
};
use crate::router_v2::handlers::sessions::status::fdm_grid_fingerprint;
use crate::schemas::{
    FrozenSpinsCollectionResource, FrozenSpinsDefinitionResource, FrozenSpinsDeleteRequest,
    FrozenSpinsMutationRequest, FrozenSpinsPreviewRequest, FrozenSpinsPreviewResponse,
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
    let sole_magnetic_object = (scene
        .objects
        .iter()
        .filter(|object| object.role == "magnet")
        .count()
        == 1)
        .then_some(request.target_object_id.as_str());
    let (counts, origin_m, cell_m, active_mask, memberships) =
        fdm_preview_domain(&field.carrier, magnetization.len(), sole_magnetic_object)?;
    let actual_topology = fdm_grid_fingerprint(snapshot).ok_or_else(|| {
        ApiError::conflict(
            "selection_topology_mismatch: current FDM domain has no canonical grid fingerprint",
        )
    })?;
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
        topology_fingerprint: actual_topology,
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
        expected_grid_or_mesh_fingerprint: actual_topology,
    };
    let domain = FdmFrozenSpinsDomain {
        origin_m,
        counts,
        cell_m,
        active_mask: &active_mask,
        memberships: &memberships,
        grid_fingerprint: actual_topology,
    };
    let resolved =
        compile_fdm_frozen_spins(&domain, &compile_request).map_err(map_selection_error)?;
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
    let response = FrozenSpinsPreviewResponse {
        schema_version: PREVIEW_SCHEMA_VERSION.to_string(),
        preview_id: preview_id.clone(),
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
        topology_fingerprint: actual_topology.to_string(),
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
    if fdm_grid_fingerprint(snapshot) != Some(record.topology_fingerprint.as_str()) {
        return Err(ApiError::conflict(
            "selection_topology_mismatch: preview topology is no longer current",
        ));
    }
    Ok(())
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
