//! Server-side orchestration for lowering an immutable live scene into a
//! validated preparation receipt.
//!
//! Session identity, revision checks, transition fencing, and receipt
//! publication remain in the live API handler. This module owns only the
//! blocking SceneDocument -> ProblemIR -> PreparationReceipt work. Durable
//! publication remains the caller's responsibility.

use anyhow::Context;
use fullmag_application::{
    AcceptedRunPreparationSource, PreparationBinding, PreparationReceipt, RequestedExecution,
};
use fullmag_authoring::SceneDocument;
use fullmag_plan::PreparationPlanSource;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use crate::error::ApiError;
use crate::types::{
    AppState, CurrentLivePreparationMaterializationRequest, CurrentLiveRequestContext,
    CurrentLiveSnapshotRequest, SessionStateResponse, SimulationPreparationLogEntrySnapshot,
    SimulationPreparationSnapshot, SimulationPreparationStageSnapshot,
};

pub(crate) struct LiveScenePreparationInput {
    pub repo_root: PathBuf,
    pub workspace_root: PathBuf,
    pub scene_document: SceneDocument,
    pub preparation_id: String,
    pub scene_revision: u64,
    pub requested_execution: RequestedExecution,
    pub display_projection: Value,
}

/// The one pre-solve read model shared by live FDM and FEM adapters.
///
/// `execution_plan` is the same immutable plan used to build the receipt.  It
/// therefore carries the resolved FDM grid or FEM mesh and the initial field
/// values without starting a solver or re-reading mutable session state.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct LiveScenePreparationReadModel {
    pub schema_version: &'static str,
    pub preparation_id: String,
    pub scene_revision: u64,
    pub plan_fingerprint: String,
    pub requested_execution: RequestedExecution,
    pub execution_plan: fullmag_ir::ExecutionPlanIR,
}

pub(crate) const LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA: &str =
    "fullmag.live_scene_preparation_read_model.v1";

const CANONICAL_PREPARATION_STAGE_IDS: [&str; 9] = [
    "runtime_startup",
    "script_materialization",
    "validation",
    "planning",
    "domain_preparation",
    "meshing",
    "mesh_postprocessing",
    "solver_initialization",
    "ready",
];

fn canonical_completed_preparation_stages(
    ready_at_unix_ms: u64,
    detail: &str,
) -> Vec<SimulationPreparationStageSnapshot> {
    const SOLVER_INITIALIZATION_DETAIL: &str =
        "Native solver initialization is deferred until Compute; no solver was invoked during preparation";
    const READY_DETAIL: &str = "Authored model preparation is ready; Compute has not run";

    CANONICAL_PREPARATION_STAGE_IDS
        .into_iter()
        .map(|id| {
            let is_ready = id == "ready";
            let is_solver_initialization = id == "solver_initialization";
            let stage_detail = if is_solver_initialization {
                SOLVER_INITIALIZATION_DETAIL
            } else if is_ready {
                READY_DETAIL
            } else {
                detail
            };
            SimulationPreparationStageSnapshot {
                id: id.into(),
                label: id.replace('_', " "),
                detail: stage_detail.into(),
                status: if is_solver_initialization {
                    "skipped"
                } else {
                    "completed"
                }
                .into(),
                started_at_unix_ms: is_ready.then_some(ready_at_unix_ms),
                completed_at_unix_ms: is_ready.then_some(ready_at_unix_ms),
                duration_ms: is_ready.then_some(0),
                clock_adjustment: None,
                progress_percent: (!is_solver_initialization).then_some(100),
                progress_label: if is_ready {
                    Some("ready".into())
                } else if is_solver_initialization {
                    Some("awaiting Compute".into())
                } else {
                    None
                },
            }
        })
        .collect()
}

fn canonical_ready_preparation_log(
    timestamp_unix_ms: u64,
    message: &str,
) -> SimulationPreparationLogEntrySnapshot {
    SimulationPreparationLogEntrySnapshot {
        timestamp_unix_ms,
        level: "info".into(),
        stage_id: "ready".into(),
        message: message.into(),
    }
}

/// Build the native-layer carrier for a prepared multilayer magnetization.
///
/// The runner owns the canonical field layout.  The values are flattened in
/// that layout's layer order, while every native grid and offset stays in the
/// layout so consumers never interpret independent layers as one common grid.
fn prepared_multilayer_initial_state(
    execution_plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<(Vec<[f64; 3]>, Value), ApiError> {
    let fullmag_ir::BackendPlanIR::FdmMultilayer(plan) = &execution_plan.backend_plan else {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_multilayer_layout_invalid",
            "prepared initial state is not an FDM multilayer plan",
        ));
    };
    if plan.layers.is_empty() {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_multilayer_layout_invalid",
            "prepared multilayer plan has no native layers",
        ));
    }

    let layout = fullmag_runner::study_magnetization_layout_for_plan(execution_plan).map_err(
        |error| {
            ApiError::conflict_with_code(
                "accepted_preparation_multilayer_layout_invalid",
                format!("prepared multilayer field layout is invalid: {}", error.message),
            )
        },
    )?;
    let mut values = Vec::new();
    for layer in &plan.layers {
        let native_cell_count = layer
            .native_grid
            .iter()
            .try_fold(1usize, |count, axis| {
                (*axis > 0)
                    .then_some(count.checked_mul(usize::try_from(*axis).ok()?))
                    .flatten()
            })
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_preparation_multilayer_layout_invalid",
                    format!(
                        "prepared multilayer layer '{}' has an invalid native grid",
                        layer.layer_id
                    ),
                )
            })?;
        if layer.initial_magnetization.len() != native_cell_count {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_multilayer_layout_invalid",
                format!(
                    "prepared multilayer layer '{}' initial magnetization length does not match its native grid",
                    layer.layer_id
                ),
            ));
        }
        if layer
            .initial_magnetization
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
        {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_multilayer_layout_invalid",
                format!(
                    "prepared multilayer layer '{}' has non-finite initial magnetization",
                    layer.layer_id
                ),
            ));
        }
        values.extend(layer.initial_magnetization.iter().copied());
    }
    Ok((values, layout))
}

fn prepared_fem_mesh(
    execution_plan: &fullmag_ir::ExecutionPlanIR,
) -> Option<fullmag_runner::FemMeshPayload> {
    match &execution_plan.backend_plan {
        fullmag_ir::BackendPlanIR::Fem(plan) => Some(fullmag_runner::FemMeshPayload::from(plan)),
        fullmag_ir::BackendPlanIR::FemEigen(plan) => {
            Some(fullmag_runner::FemMeshPayload::from(plan))
        }
        fullmag_ir::BackendPlanIR::FemFrequencyResponse(plan) => {
            Some(fullmag_runner::FemMeshPayload::from(plan))
        }
        fullmag_ir::BackendPlanIR::AntennaFieldOnly(_)
        | fullmag_ir::BackendPlanIR::Fdm(_)
        | fullmag_ir::BackendPlanIR::FdmMultilayer(_)
        | fullmag_ir::BackendPlanIR::AntennaExternalLeadInspection(_) => None,
    }
}

/// Project the pinned preparation plan through the existing live metadata and
/// mesh consumers. The mesh workspace envelope alone is diagnostic state: the
/// binary topology resources require the solver-domain FemMeshPayload.
fn prepared_domain_publication(
    snapshot: &SessionStateResponse,
    read_model: &LiveScenePreparationReadModel,
) -> Result<(Value, Option<fullmag_runner::FemMeshPayload>), ApiError> {
    let mut metadata = match snapshot.metadata.as_ref() {
        None => serde_json::Map::new(),
        Some(Value::Object(metadata)) => metadata.clone(),
        Some(_) => return Err(ApiError::conflict("live metadata must be an object")),
    };
    let execution_plan_metadata = serde_json::to_value(&read_model.execution_plan).map_err(
        |error| ApiError::internal(format!("failed to encode prepared execution plan: {error}")),
    )?;
    metadata.insert("execution_plan".into(), execution_plan_metadata);
    if matches!(
        &read_model.execution_plan.backend_plan,
        fullmag_ir::BackendPlanIR::FdmMultilayer(_)
    ) {
        let (_, layout) = prepared_multilayer_initial_state(&read_model.execution_plan)?;
        // A previous multilayer run may have a valid-looking layout with
        // different native grids. The pinned plan is the current authority;
        // retaining that older layout would misroute native-layer offsets.
        metadata.insert("artifact_layout".into(), layout);
    }
    let metadata = Value::Object(metadata);
    // Keep the typed pinned plan as the authority for the binary topology.
    // The metadata JSON is a transport projection and must not replace the
    // already validated typed plan.
    let fem_mesh = prepared_fem_mesh(&read_model.execution_plan);
    if matches!(
        &read_model.execution_plan.backend_plan,
        fullmag_ir::BackendPlanIR::Fem(_)
            | fullmag_ir::BackendPlanIR::FemEigen(_)
            | fullmag_ir::BackendPlanIR::FemFrequencyResponse(_)
    ) && fem_mesh.as_ref().is_none_or(|mesh| mesh.cells.is_empty())
    {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_mesh_missing",
            "prepared FEM plan has no materialized solver-domain topology",
        ));
    }
    Ok((metadata, fem_mesh))
}

/// Publish the actual planned initial state as an input carrier, without a
/// scalar row, solver event, or synthetic computed result. Its space/time
/// identity is anchored to the prepared domain and the pinned stage origin.
fn publish_prepared_initial_state(
    snapshot: &mut SessionStateResponse,
    read_model: &LiveScenePreparationReadModel,
) -> Result<(), ApiError> {
    let (values, start_time_s, layout): (Vec<[f64; 3]>, f64, Value) =
        match &read_model.execution_plan.backend_plan {
            fullmag_ir::BackendPlanIR::Fdm(plan) => (
                plan.initial_magnetization.clone(),
                plan.time_stage.start_time_s,
                serde_json::json!({"backend": "fdm", "grid_cells": plan.grid.cells}),
            ),
            fullmag_ir::BackendPlanIR::FdmMultilayer(_) => {
                let (values, layout) = prepared_multilayer_initial_state(&read_model.execution_plan)?;
                (values, 0.0, layout)
            }
            fullmag_ir::BackendPlanIR::Fem(plan) => (
                plan.initial_magnetization.clone(),
                plan.time_stage.start_time_s,
                serde_json::json!({"backend": "fem", "location": "node", "node_count": plan.mesh.nodes.len()}),
            ),
            _ => return Ok(()),
        };
    if values.is_empty()
        || values.iter().flatten().any(|value| !value.is_finite())
        || !start_time_s.is_finite()
        || start_time_s < 0.0
    {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_initial_state_invalid",
            "prepared plan has no finite initial magnetization at a valid stage origin",
        ));
    }
    let frame = crate::session::accepted_observation_frame_ref(
        snapshot,
        0,
        Some(start_time_s),
    );
    let mut fields = crate::types::LatestFields::default();
    fields.insert(
        "m".into(),
        serde_json::json!({
            "values": values,
            "layout": layout,
            "source_step": 0,
            "source_time_seconds": start_time_s,
            "source_revision": read_model.scene_revision,
            "provenance": {
                "source_kind": "prepared_initial_state",
                "preparation_id": read_model.preparation_id,
                "plan_fingerprint": read_model.plan_fingerprint,
            },
            "observation_frame": frame,
        }),
    );
    let session_id = snapshot.session.session_id.clone();
    crate::session::apply_current_live_accepted_field_frame(
        snapshot,
        crate::types::CurrentLiveFieldFrameRequest {
            session_id,
            latest_fields: Some(fields),
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
        },
        frame,
    )
}

const ACCEPTED_LIVE_PREPARATION_WAIT_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(1800);
const ACCEPTED_LIVE_PREPARATION_POLL_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(250);

/// Receipt, execution binding and read model produced as one preparation
/// transaction.  The model is intentionally separate from solver execution.
#[derive(Debug)]
pub(crate) struct LiveScenePreparationMaterialization {
    pub receipt: PreparationReceipt,
    pub binding: PreparationBinding,
    pub read_model: LiveScenePreparationReadModel,
}

pub(crate) struct PublishedLiveScenePreparation {
    pub disposition: &'static str,
    pub preparation_id: String,
    pub run_id: String,
    pub plan_fingerprint: String,
    pub receipt_sha256: String,
    pub read_model: LiveScenePreparationReadModel,
}

/// Own the active-Live preparation use case from immutable scene capture
/// through durable publication. The route adapter supplies only the request;
/// session and run identity are captured from the current server snapshot.
pub(crate) async fn materialize_current_live_preparation(
    state: &Arc<AppState>,
    request: CurrentLivePreparationMaterializationRequest,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let context = crate::capture_current_live_request_context(state).await?;
    if context.session_id != request.session_id {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_session_mismatch",
        ));
    }

    let (scene_document, expected_run_id) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            &context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        ensure_current_preparation_id(snapshot, &request.preparation_id)?;
        let scene_document = snapshot.scene_document.clone().ok_or_else(|| {
            ApiError::not_found("no scene document available for current workspace")
        })?;
        let run_id = snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.clone())
            .unwrap_or_else(|| snapshot.session.run_id.clone());
        (scene_document, run_id)
    };
    if scene_document.revision != request.scene_revision {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_scene_revision_mismatch",
        ));
    }

    let expected_preparation_id = request.preparation_id.clone();
    let scene_revision = request.scene_revision;
    let materialized = materialize_live_scene_preparation_model(LiveScenePreparationInput {
        repo_root: state.repo_root.clone(),
        workspace_root: state.current_workspace_root.clone(),
        scene_document,
        preparation_id: request.preparation_id,
        scene_revision,
        requested_execution: request.requested_execution,
        display_projection: request.display_projection,
    })
    .await?;
    let LiveScenePreparationMaterialization {
        receipt,
        binding,
        read_model,
    } = materialized;
    let preparation_id = receipt.preparation_id.clone();
    let plan_fingerprint = receipt.plan_fingerprint.clone();
    let run_id = expected_run_id.clone();
    let disposition = commit_live_preparation_receipt_for_context(
        state,
        &context,
        receipt,
        Some(scene_revision),
        Some(&expected_preparation_id),
        Some(&expected_run_id),
    )
    .await?;
    let disposition = match disposition {
        fullmag_session::PreparationReceiptCommitDisposition::Accepted => "accepted",
        fullmag_session::PreparationReceiptCommitDisposition::Replayed => "replayed",
    };
    Ok(PublishedLiveScenePreparation {
        disposition,
        preparation_id,
        run_id,
        plan_fingerprint,
        receipt_sha256: binding.receipt_sha256,
        read_model,
    })
}

/// Prepare a Docker live scene directly from a command while the caller owns
/// the current-live transition fence. This is the mesh/preparation branch of
/// the command dispatcher: it commits the canonical receipt and publishes the
/// same mesh/preparation read model consumed by the existing viewport. It does
/// not create a RunIntent, queue a solver, or wake the legacy scratch worker.
pub(crate) async fn prepare_current_live_scene_with_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    command_id: &str,
    command_kind: &str,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let (
        scene_document,
        run_id,
        requested_execution,
        display_projection,
        preparation_revision,
        existing_preparation,
    ) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        let scene_document = snapshot
            .scene_document
            .clone()
            .ok_or_else(|| ApiError::not_found("no scene document available for preparation"))?;
        let requested_execution = RequestedExecution {
            backend: scene_document.study.requested_backend.clone(),
            device: scene_document.study.requested_device.clone(),
            precision: scene_document.study.requested_precision.clone(),
            mode: scene_document.study.requested_mode.clone(),
            minimum_resources: None,
        };
        requested_execution
            .validate()
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
        let display_projection =
            serde_json::to_value(&snapshot.display_selection).map_err(|error| {
                ApiError::internal(format!("failed to encode display projection: {error}"))
            })?;
        let run_id = snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.clone())
            .unwrap_or_else(|| snapshot.session.run_id.clone());
        let preparation_revision = snapshot.simulation_preparation_revision.saturating_add(1);
        let existing_preparation = snapshot.simulation_preparation.as_ref().map(|preparation| {
            (
                preparation.preparation_id.clone(),
                preparation.started_at_unix_ms,
            )
        });
        (
            scene_document,
            run_id,
            requested_execution,
            display_projection,
            preparation_revision,
            existing_preparation,
        )
    };

    let preparation_id = format!(
        "live-prep-{}",
        fullmag_session::hex_sha256(
            format!(
                "{}\0{}\0{}\0{}\0{}",
                state.request_scope_instance_id,
                context.session_id,
                context.session_epoch,
                scene_document.revision,
                command_id,
            )
            .as_bytes(),
        )
    );
    let preparation_started_at_unix_ms = existing_preparation
        .filter(|(existing_id, _)| existing_id == &preparation_id)
        .map(|(_, started_at)| started_at)
        .unwrap_or_else(|| {
            u64::try_from(crate::session::unix_time_millis_now()).unwrap_or(u64::MAX)
        });
    let materialized = materialize_live_scene_preparation_model(LiveScenePreparationInput {
        repo_root: state.repo_root.clone(),
        workspace_root: state.current_workspace_root.clone(),
        scene_document: scene_document.clone(),
        preparation_id: preparation_id.clone(),
        scene_revision: scene_document.revision,
        requested_execution: requested_execution.clone(),
        display_projection,
    })
    .await?;

    let disposition = commit_live_preparation_receipt_for_context_under_transition(
        state,
        context,
        materialized.receipt,
        Some(scene_document.revision),
        None,
        Some(&run_id),
    )
    .await?;
    let disposition = match disposition {
        fullmag_session::PreparationReceiptCommitDisposition::Accepted => "accepted",
        fullmag_session::PreparationReceiptCommitDisposition::Replayed => "replayed",
    };
    let plan_fingerprint = materialized.read_model.plan_fingerprint.clone();
    let read_model = materialized.read_model;
    let receipt_sha256 = materialized.binding.receipt_sha256;
    let now = u64::try_from(crate::session::unix_time_millis_now()).unwrap_or(u64::MAX);
    let execution_plan = serde_json::to_value(&read_model.execution_plan).map_err(|error| {
        ApiError::internal(format!(
            "failed to encode live preparation execution plan: {error}"
        ))
    })?;
    let mesh_workspace = serde_json::json!({
        "schema_version": LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
        "preparation_id": &read_model.preparation_id,
        "source_scene_revision": read_model.scene_revision,
        "plan_fingerprint": &read_model.plan_fingerprint,
        "status": "completed",
        "active_build": null,
        "last_build_error": null,
        "execution_plan": execution_plan,
        "mesh_pipeline_status": [{
            "id": command_kind,
            "status": "completed",
            "detail": "canonical live scene preparation ready",
        }],
    });
    let preparation = SimulationPreparationSnapshot {
        preparation_id: preparation_id.clone(),
        revision: preparation_revision,
        status: "ready".into(),
        active_stage_id: None,
        started_at_unix_ms: preparation_started_at_unix_ms,
        completed_at_unix_ms: Some(now),
        stages: canonical_completed_preparation_stages(
            now,
            "canonical live preparation receipt committed",
        ),
        log_tail: vec![canonical_ready_preparation_log(
            now,
            "canonical live authored model preparation ready; Compute has not run",
        )],
        failure: None,
    };
    {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_mut()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        let (metadata, fem_mesh) = prepared_domain_publication(snapshot, &read_model)?;
        let session_status = preparation_session_status(snapshot);
        let mut prepared_snapshot = snapshot.clone();
        crate::session::apply_current_live_snapshot(
            &mut prepared_snapshot,
            CurrentLiveSnapshotRequest {
                session_id: context.session_id.clone(),
                session: None,
                session_status,
                metadata: Some(metadata),
                mesh_workspace: Some(mesh_workspace),
                stage_execution: None,
                simulation_preparation: Some(preparation),
                run: None,
                live_state: None,
                frozen_spins_runtime_status: None,
                coupled_checkpoint: None,
                latest_scalar_row: None,
                latest_fields: None,
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
                engine_log: None,
                solver_profile: None,
                fem_mesh,
            },
        )?;
        publish_prepared_initial_state(&mut prepared_snapshot, &read_model)?;
        *snapshot = prepared_snapshot;
    }
    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        let display_revision = state.current_display_selection.read().await.revision;
        let realtime_state =
            crate::current_live_realtime_state_from_snapshot(state, &snapshot, display_revision)
                .await;
        crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0)
            .await?;
    }
    Ok(PublishedLiveScenePreparation {
        disposition,
        preparation_id,
        run_id,
        plan_fingerprint,
        receipt_sha256,
        read_model,
    })
}

/// Wait for the dependency-ready accepted Study frontier and publish its
/// immutable preparation receipt into the existing live read model.
///
/// The accepted run may contain many authored stages, but only the first
/// topological frontier can be shown before Compute: later stages can require
/// StepOutput values that do not exist yet. This helper therefore preserves
/// the complete Study in durable storage while publishing exactly one
/// model/mesh preparation for the current live view. FEM receipts arrive from
/// the admitted native preparation scheduler; FDM receipts are materialized by
/// the accepted RunIntent catalog path. No queue, claim, lease, or solver is
/// created here. Callers must release the current-session transition before
/// awaiting this helper; each publication attempt acquires and revalidates
/// that fence independently, allowing Stop and session replacement to proceed.
pub(crate) async fn publish_accepted_frontier_preparation(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    command_kind: &str,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let run_id = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.clone())
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_preparation_current_run_missing",
                    "accepted preparation requires the current durable live run",
                )
            })?
    };
    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_preparation_store_unavailable",
            "accepted preparation requires the configured durable run store",
        ));
    };
    let run_id_for_worker = run_id.clone();
    let command_kind_for_worker = command_kind.to_owned();
    let (run_id, step_id) = tokio::task::spawn_blocking(move || {
        let store = fullmag_session::SessionStore::open_existing(&store_root).map_err(|error| {
            ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_store_unavailable",
                format!("failed to open accepted preparation store: {error}"),
            )
        })?;
        let typed_run_id = fullmag_application::RunId::parse(run_id_for_worker.clone())
            .map_err(|error| ApiError::bad_request(format!("accepted run id is invalid: {error}")))?;
        let intent = store
            .read_run_intent(typed_run_id.as_str())
            .map_err(|error| {
                ApiError::conflict(format!(
                    "accepted preparation RunIntent read failed: {error}"
                ))
            })?
            .context("accepted preparation RunIntent is missing")
            .map_err(|error| ApiError::conflict(error.to_string()))?;
        let project_id = crate::live_accepted_execution::accepted_project_id_from_intent(
            &intent,
            &typed_run_id,
        )
        .map_err(|error| {
            ApiError::conflict_with_code(
                "accepted_preparation_snapshot_invalid",
                format!("accepted preparation RunIntent is not typed: {error:#}"),
            )
        })?;
        let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
            &store,
            &typed_run_id,
            &project_id,
        )
        .map_err(|error| {
            ApiError::conflict_with_code(
                "accepted_preparation_snapshot_invalid",
                format!("accepted preparation snapshot validation failed: {error:#}"),
            )
        })?;
        let step_id = if command_kind_for_worker == "accepted_run_reattach" {
            let anchor = store
                .read_preparation_receipt(typed_run_id.as_str())
                .map_err(|error| {
                    ApiError::conflict(format!(
                        "accepted preparation anchor read failed: {error}"
                    ))
                })?
                .context("accepted preparation anchor is missing")
                .map_err(|error| ApiError::conflict(error.to_string()))?;
            anchor
                .validate()
                .map_err(|error| ApiError::conflict(format!("accepted preparation anchor is invalid: {error}")))?;
            let application: fullmag_application::PreparationReceipt =
                serde_json::from_value(anchor.payload.clone()).map_err(|error| {
                    ApiError::conflict(format!(
                        "accepted preparation anchor is not an application receipt: {error}"
                    ))
                })?;
            application.validate().map_err(|error| {
                ApiError::conflict(format!("accepted preparation anchor is invalid: {error}"))
            })?;
            let source = application
                .accepted_run_source
                .as_ref()
                .ok_or_else(|| {
                    ApiError::conflict(
                        "accepted preparation anchor has no accepted-run source",
                    )
                })?;
            if source.run_id != typed_run_id {
                return Err(ApiError::conflict(
                    "accepted preparation anchor source run differs from current run",
                ));
            }
            let step = accepted
                .lowered
                .steps
                .iter()
                .find(|step| step.step_id == source.step_id)
                .ok_or_else(|| {
                    ApiError::conflict(
                        "accepted preparation anchor references an unknown study step",
                    )
                })?;
            if !matches!(
                step.status,
                fullmag_plan::StudyStepLoweringStatus::Planned
            ) {
                return Err(ApiError::conflict(
                    "accepted preparation anchor references a non-planned study step",
                ));
            }
            let ready = fullmag_runtime_control::accepted_run_step_is_scheduler_ready(
                &store,
                &typed_run_id,
                &source.step_id,
            )
            .map_err(|error| {
                ApiError::conflict(format!(
                    "accepted preparation anchor readiness validation failed: {error}"
                ))
            })?;
            if !ready {
                return Err(ApiError::conflict(
                    "accepted preparation anchor is not scheduler-ready",
                ));
            }
            source.step_id.clone()
        } else {
            let mut selected = None;
            for step in accepted
                .lowered
                .steps
                .iter()
                .filter(|step| {
                    matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned)
                })
            {
                if fullmag_runtime_control::accepted_run_step_is_scheduler_ready(
                    &store,
                    &typed_run_id,
                    &step.step_id,
                )
                .map_err(|error| {
                    ApiError::conflict(format!(
                        "accepted preparation readiness validation failed: {error}"
                    ))
                })? {
                    selected = Some(step.step_id.clone());
                    break;
                }
            }
            selected.ok_or_else(|| {
                ApiError::unprocessable_with_code(
                    "accepted_preparation_frontier_missing",
                    "accepted Study has no dependency-ready preparation frontier",
                )
            })?
        };
        Ok::<_, ApiError>((run_id_for_worker, step_id))
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted preparation frontier task failed: {error}")))??;

    let deadline = std::time::Instant::now() + ACCEPTED_LIVE_PREPARATION_WAIT_TIMEOUT;
    loop {
        // Only one bounded receipt read/publication owns the transition.
        // Native preparation may take minutes; Stop and session replacement
        // must remain available between attempts, fenced by the same context.
        let publication = {
            let _transition = state.current_live_session_transition.lock().await;
            publish_accepted_task_preparation_with_transition(
                state,
                context,
                &run_id,
                &step_id,
                command_kind,
            )
            .await
        };
        match publication {
            Ok(published) => return Ok(published),
            Err(error) if error.code.as_deref() == Some("accepted_preparation_pending") => {
                if std::time::Instant::now() >= deadline {
                    return Err(ApiError::with_status_and_code(
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "accepted_preparation_timeout",
                        format!(
                            "accepted preparation frontier did not reach a durable receipt within {} seconds",
                            ACCEPTED_LIVE_PREPARATION_WAIT_TIMEOUT.as_secs()
                        ),
                    ));
                }
                tokio::time::sleep(ACCEPTED_LIVE_PREPARATION_POLL_INTERVAL).await;
            }
            Err(error) => return Err(error),
        }
    }
}

/// Session status published with a preparation receipt. Preparation of a new
/// stage frontier may be published while the accepted run is executing; it
/// must not flip that session back to `awaiting_command` (the projector would
/// only restore `running` on its next tick, causing status/control flicker).
/// Before execution the established `awaiting_command` publication remains.
fn preparation_session_status(snapshot: &SessionStateResponse) -> Option<String> {
    let executing = |status: &str| {
        matches!(
            status,
            "running" | "paused" | "breaking" | "queued" | "dispatched" | "claimed"
        )
    };
    if executing(&snapshot.session.status)
        || snapshot
            .run
            .as_ref()
            .is_some_and(|run| executing(&run.status))
    {
        None
    } else {
        Some("awaiting_command".into())
    }
}

pub(crate) fn ensure_preparation_run_is_active(snapshot: &SessionStateResponse) -> Result<(), ApiError> {
    let stopped = |status: &str| {
        matches!(
            status,
            "stopping" | "stopped" | "cancelled" | "failed" | "completed" | "closed"
        )
    };
    if stopped(&snapshot.session.status)
        || snapshot
            .run
            .as_ref()
            .is_some_and(|run| stopped(&run.status))
    {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_run_stopped",
            "accepted preparation cannot publish after Stop or terminal completion",
        ));
    }
    Ok(())
}

/// Publish preparation that was produced by the accepted task lane.
///
/// The accepted FEM preparer is the only component allowed to create native
/// mesh/space evidence.  Consequently the live API cannot re-materialize a
/// FEM receipt from the current scene after a RunIntent is accepted.  This
/// bridge reads the immutable task receipt and the pinned execution plan,
/// validates both through `AcceptedStudySnapshot`, and only then binds the
/// receipt to the current-live read model.  FDM uses the same path when its
/// accepted preparation receipt is already available, keeping the two lanes
/// on one publication contract.
/// Callers own the transition fence and validate the accepted snapshot before
/// entering this bridge. An absent receipt returns pending before repeating
/// that expensive validation; an existing receipt is always fully validated.
pub(crate) async fn publish_accepted_task_preparation_with_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    run_id: &str,
    step_id: &str,
    command_kind: &str,
) -> Result<PublishedLiveScenePreparation, ApiError> {
    let (
        scene_revision,
        display_projection,
        preparation_revision,
        existing_preparation,
    ) = {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        crate::ensure_current_live_request_context(
            snapshot,
            context,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        ensure_preparation_run_is_active(snapshot)?;
        let active_run_id = snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.as_str())
            .unwrap_or(snapshot.session.run_id.as_str());
        if active_run_id != run_id {
            return Err(ApiError::conflict(
                "accepted_preparation_current_run_mismatch",
            ));
        }
        let scene_revision = snapshot
            .scene_document
            .as_ref()
            .map(|scene| scene.revision)
            .ok_or_else(|| ApiError::not_found("no scene document available for preparation"))?;
        let display_projection =
            serde_json::to_value(&snapshot.display_selection).map_err(|error| {
                ApiError::internal(format!("failed to encode display projection: {error}"))
            })?;
        let existing_preparation = snapshot.simulation_preparation.as_ref().map(|preparation| {
            (
                preparation.preparation_id.clone(),
                preparation.started_at_unix_ms,
            )
        });
        (
            scene_revision,
            display_projection,
            snapshot.simulation_preparation_revision.saturating_add(1),
            existing_preparation,
        )
    };

    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_preparation_store_unavailable",
            "accepted preparation requires the configured durable run store",
        ));
    };
    let run_id_for_worker = run_id.to_owned();
    let step_id_for_worker = step_id.to_owned();
    let observed_preparation_started_at_unix_ms =
        u64::try_from(crate::session::unix_time_millis_now()).unwrap_or(u64::MAX);
    let materialized = tokio::task::spawn_blocking(move || {
        let store = fullmag_session::SessionStore::open_existing(&store_root).map_err(|error| {
            ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_store_unavailable",
                format!("failed to open accepted preparation store: {error}"),
            )
        })?;
        let typed_run_id = fullmag_application::RunId::parse(run_id_for_worker.clone())
            .map_err(|error| ApiError::bad_request(format!("accepted run id is invalid: {error}")))?;
        let intent = store
            .read_run_intent(typed_run_id.as_str())
            .map_err(|error| {
                ApiError::conflict(format!("accepted preparation RunIntent read failed: {error}"))
            })?
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_preparation_run_missing",
                    "accepted preparation has no durable RunIntent",
                )
            })?;
        let specification: fullmag_application::RunSpecification =
            serde_json::from_value(intent.specification.clone()).map_err(|error| {
                ApiError::conflict(format!(
                    "accepted preparation RunSpec is not typed: {error}"
                ))
            })?;
        if specification.run_id != typed_run_id {
            return Err(ApiError::conflict(
                "accepted preparation RunSpec run identity mismatch",
            ));
        }
        let task_id = fullmag_session::task_id_for_study_step(
            typed_run_id.as_str(),
            &step_id_for_worker,
        )
        .map_err(|error| ApiError::bad_request(format!("accepted step id is invalid: {error}")))?;
        // `None` is the only pending state. Once an envelope exists, every
        // decode, CAS, plan, certificate, and accepted-run binding error is a
        // durable integrity failure and must surface immediately; mapping it
        // to pending would hide tampering or invalid native evidence behind a
        // thirty-minute wait while the manual Compute gate remains closed.
        if store
            .read_task_preparation_receipt(typed_run_id.as_str(), &task_id)
            .map_err(|error| {
                ApiError::conflict_with_code(
                    "accepted_preparation_receipt_invalid",
                    format!("accepted task preparation receipt read failed: {error:#}"),
                )
            })?
            .is_none()
        {
            return Err(ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_pending",
                format!(
                    "accepted task preparation receipt is not ready for `{step_id_for_worker}`"
                ),
            ));
        }
        // Pending polls hold the live transition fence. Do not repeatedly
        // reconstruct a large inline FEM plan while there is no receipt to
        // publish. Existing envelopes still require the complete immutable
        // snapshot, plan, and native evidence validation below.
        let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
            &store,
            &typed_run_id,
            &specification.snapshot.project_id,
        )
        .map_err(|error| {
            ApiError::conflict(format!(
                "accepted preparation snapshot validation failed: {error:#}"
            ))
        })?;
        let execution_plan = accepted
            .lowered
            .steps
            .iter()
            .find(|step| step.step_id == step_id_for_worker)
            .and_then(|step| step.execution_plan.clone())
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_preparation_plan_missing",
                    "accepted preparation step has no canonical execution plan",
                )
            })?;
        let receipt = accepted
            .read_task_preparation_receipt(&store, &task_id)
            .map_err(|error| {
                ApiError::conflict_with_code(
                    "accepted_preparation_receipt_invalid",
                    format!(
                        "accepted task preparation receipt is invalid for `{step_id_for_worker}`: {error:#}"
                    ),
                )
            })?;
        Ok::<_, ApiError>((receipt, execution_plan, specification.requested_execution))
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted preparation task failed: {error}")))??;

    let (receipt, execution_plan, requested_execution) = materialized;
    let preparation_id = receipt.preparation_id.clone();
    let preparation_started_at_unix_ms = existing_preparation
        .filter(|(existing_id, _)| existing_id == &preparation_id)
        .map(|(_, started_at)| started_at)
        .unwrap_or(observed_preparation_started_at_unix_ms);
    let plan_fingerprint = receipt.plan_fingerprint.clone();
    let binding = PreparationBinding::from_receipt(&receipt).map_err(|error| {
        ApiError::conflict(format!("accepted preparation binding is invalid: {error}"))
    })?;
    let read_model = LiveScenePreparationReadModel {
        schema_version: LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
        preparation_id: preparation_id.clone(),
        scene_revision,
        plan_fingerprint: plan_fingerprint.clone(),
        requested_execution,
        execution_plan,
    };

    let disposition = commit_live_preparation_receipt_for_context_under_transition(
        state,
        context,
        receipt,
        Some(scene_revision),
        None,
        Some(run_id),
    )
    .await?;
    let disposition = match disposition {
        fullmag_session::PreparationReceiptCommitDisposition::Accepted => "accepted",
        fullmag_session::PreparationReceiptCommitDisposition::Replayed => "replayed",
    };
    let now = u64::try_from(crate::session::unix_time_millis_now()).unwrap_or(u64::MAX);
    let execution_plan_value =
        serde_json::to_value(&read_model.execution_plan).map_err(|error| {
            ApiError::internal(format!("failed to encode accepted execution plan: {error}"))
        })?;
    let mesh_workspace = serde_json::json!({
        "schema_version": LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
        "preparation_id": &read_model.preparation_id,
        "source_scene_revision": read_model.scene_revision,
        "plan_fingerprint": &read_model.plan_fingerprint,
        "status": "completed",
        "active_build": null,
        "last_build_error": null,
        "execution_plan": execution_plan_value,
        "display_projection": display_projection,
        "accepted_run_id": run_id,
        "accepted_step_id": step_id,
        "mesh_pipeline_status": [{
            "id": command_kind,
            "status": "completed",
            "detail": "accepted task preparation receipt ready",
        }],
    });
    let preparation = SimulationPreparationSnapshot {
        preparation_id: preparation_id.clone(),
        revision: preparation_revision,
        status: "ready".into(),
        active_stage_id: None,
        started_at_unix_ms: preparation_started_at_unix_ms,
        completed_at_unix_ms: Some(now),
        stages: canonical_completed_preparation_stages(
            now,
            "accepted task preparation receipt committed",
        ),
        log_tail: vec![canonical_ready_preparation_log(
            now,
            "accepted task authored model preparation ready; Compute has not run",
        )],
        failure: None,
    };
    let mut current = state.current_live_state.write().await;
    let snapshot = current
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(
        snapshot,
        context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
    )?;
    let active_run_id = snapshot
        .run
        .as_ref()
        .map(|run| run.run_id.as_str())
        .unwrap_or(snapshot.session.run_id.as_str());
    if active_run_id != run_id {
        return Err(ApiError::conflict(
            "accepted_preparation_current_run_changed",
        ));
    }
    ensure_preparation_run_is_active(snapshot)?;
    let (metadata, fem_mesh) = prepared_domain_publication(snapshot, &read_model)?;
    let session_status = preparation_session_status(snapshot);
    let mut prepared_snapshot = snapshot.clone();
    crate::session::apply_current_live_snapshot(
        &mut prepared_snapshot,
        CurrentLiveSnapshotRequest {
            session_id: context.session_id.clone(),
            session: None,
            session_status,
            metadata: Some(metadata),
            mesh_workspace: Some(mesh_workspace),
            stage_execution: None,
            simulation_preparation: Some(preparation),
            run: None,
            live_state: None,
            frozen_spins_runtime_status: None,
            coupled_checkpoint: None,
            latest_scalar_row: None,
            latest_fields: None,
            replace_latest_fields: false,
            field_generation: None,
            preview_fields: None,
            clear_preview_cache: false,
            engine_log: None,
            solver_profile: None,
            fem_mesh,
        },
    )?;
    publish_prepared_initial_state(&mut prepared_snapshot, &read_model)?;
    *snapshot = prepared_snapshot;
    drop(current);
    crate::validate_current_live_request_context(state, context).await?;
    if let Some(snapshot) = state.current_live_state.read().await.as_ref().cloned() {
        let display_revision = state.current_display_selection.read().await.revision;
        let realtime_state =
            crate::current_live_realtime_state_from_snapshot(state, &snapshot, display_revision)
                .await;
        crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0)
            .await?;
    }
    Ok(PublishedLiveScenePreparation {
        disposition,
        preparation_id,
        run_id: run_id.to_owned(),
        plan_fingerprint,
        receipt_sha256: binding.receipt_sha256,
        read_model,
    })
}

pub(crate) async fn commit_live_preparation_receipt_for_context(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    receipt: PreparationReceipt,
    expected_scene_revision: Option<u64>,
    expected_preparation_id: Option<&str>,
    expected_run_id: Option<&str>,
) -> Result<fullmag_session::PreparationReceiptCommitDisposition, ApiError> {
    let _session_transition = state.current_live_session_transition.lock().await;
    commit_live_preparation_receipt_for_context_under_transition(
        state,
        context,
        receipt,
        expected_scene_revision,
        expected_preparation_id,
        expected_run_id,
    )
    .await
}

/// Commit a preparation receipt while the caller already owns the current-live
/// transition fence. Mesh/prepare commands use this form so durable receipt,
/// read-model publication, and command journaling share one session boundary.
pub(crate) async fn commit_live_preparation_receipt_for_context_under_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    receipt: PreparationReceipt,
    expected_scene_revision: Option<u64>,
    expected_preparation_id: Option<&str>,
    expected_run_id: Option<&str>,
) -> Result<fullmag_session::PreparationReceiptCommitDisposition, ApiError> {
    let session_epoch = state
        .current_live_session_epoch
        .load(std::sync::atomic::Ordering::Acquire);
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    crate::ensure_current_live_request_context(snapshot, context, session_epoch)?;
    if expected_scene_revision.is_some_and(|expected| {
        snapshot.scene_document.as_ref().map(|scene| scene.revision) != Some(expected)
    }) {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_scene_revision_mismatch",
        ));
    }
    if let Some(expected_preparation_id) = expected_preparation_id {
        ensure_current_preparation_id(snapshot, expected_preparation_id)?;
    }
    let current_run_id = snapshot
        .run
        .as_ref()
        .map(|run| run.run_id.clone())
        .unwrap_or_else(|| snapshot.session.run_id.clone());
    let current_preparation_id = snapshot
        .simulation_preparation
        .as_ref()
        .map(|preparation| preparation.preparation_id.clone());
    let snapshot_accepted_run_id = snapshot
        .mesh_workspace
        .as_ref()
        .and_then(|workspace| workspace.get("accepted_run_id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    if expected_run_id.is_some_and(|expected| expected != current_run_id.as_str()) {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_run_id_mismatch",
        ));
    }
    receipt
        .validate()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    let preparation_id_differs = current_preparation_id
        .as_deref()
        .is_some_and(|preparation_id| preparation_id != receipt.preparation_id.as_str());
    drop(current);

    if let Some(source) = receipt.accepted_run_source.as_ref() {
        validate_live_accepted_run_source(state, &current_run_id, &receipt, source)?;
    } else if preparation_id_differs {
        return Err(ApiError::conflict(
            "current_live_preparation_receipt_id_mismatch",
        ));
    }

    let accepted_source_step = receipt
        .accepted_run_source
        .as_ref()
        .map(|source| source.step_id.clone());
    let payload = serde_json::to_value(&receipt).map_err(|error| {
        ApiError::internal(format!("failed to encode preparation receipt: {error}"))
    })?;
    let durable_receipt = fullmag_session::FmsPreparationReceipt::new(
        receipt.preparation_id.clone(),
        current_run_id,
        receipt.plan_fingerprint.clone(),
        payload,
    );
    // The live workspace anchor and accepted task/stage receipts have
    // different durable owners. Keep the roots explicit: legacy live
    // preparations use the current-live journal store, while an accepted run
    // keeps its catalog, RunIntent, anchor, task, and stage provenance in the
    // accepted store.
    let live_store = crate::session_persistence::open_store(state)?;
    let accepted_store = if accepted_source_step.is_some() {
        let store_root = state.submit_store_root.as_ref().ok_or_else(|| {
            ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_store_unavailable",
                "accepted preparation provenance requires the configured durable run store",
            )
        })?;
        Some(fullmag_session::SessionStore::open_existing(store_root).map_err(|error| {
            ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_store_unavailable",
                format!("failed to open the configured accepted run store: {error}"),
            )
        })?)
    } else {
        None
    };
    let previous_live_receipt = state.current_live_preparation_receipt.read().await.clone();
    let previous_durable_receipt = match accepted_store.as_ref() {
        Some(accepted_store) => {
            read_durable_preparation_anchor(accepted_store, &durable_receipt.run_id)?
        }
        None => read_durable_preparation_anchor(&live_store, &durable_receipt.run_id)?,
    };
    let disposition = if let Some(step_id) = accepted_source_step.as_deref() {
        let accepted_store = accepted_store.as_ref().ok_or_else(|| {
            ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_preparation_store_unavailable",
                "accepted preparation provenance store was not opened",
            )
        })?;
        let task_id = fullmag_session::task_id_for_study_step(&durable_receipt.run_id, step_id)
            .map_err(|error| ApiError::bad_request(format!("accepted preparation step is invalid: {error}")))?;
        let task_receipt = accepted_store
            .read_task_preparation_receipt(&durable_receipt.run_id, &task_id)
            .map_err(|error| {
                ApiError::conflict(format!("accepted task preparation receipt read failed: {error}"))
            })?
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_preparation_task_receipt_missing",
                    "accepted preparation source has no immutable task preparation receipt",
                )
            })?;
        let stage_receipt = fullmag_session::FmsAcceptedStagePreparationReceipt::from_task_receipt(
            &task_receipt,
        )
        .map_err(|error| {
            ApiError::conflict(format!("accepted stage preparation receipt is invalid: {error}"))
        })?;
        if stage_receipt.preparation_id != durable_receipt.preparation_id
            || stage_receipt.plan_fingerprint != durable_receipt.plan_fingerprint
        {
            return Err(ApiError::conflict_with_code(
                "accepted_preparation_stage_receipt_mismatch",
                "accepted stage receipt differs from the immutable task preparation receipt",
            ));
        }

        let stale_accepted_replacement = match previous_live_receipt.as_ref() {
            Some(previous) if previous.run_id != durable_receipt.run_id => {
                prove_stale_accepted_replacement(
                    &live_store,
                    accepted_store,
                    previous,
                    current_preparation_id.as_deref(),
                    snapshot_accepted_run_id.as_deref(),
                )?
            }
            _ => false,
        };
        let previous_stage_id = previous_live_receipt
            .as_ref()
            .and_then(|previous| accepted_stage_step_for_run(previous, &durable_receipt.run_id));
        let same_run_previous_stage_is_durable = if let Some(step_id) = previous_stage_id {
            accepted_store
                .read_accepted_stage_preparation_receipt(&durable_receipt.run_id, &step_id)
                .map(|receipt| receipt.is_some())
                .map_err(|error| ApiError::conflict(error.to_string()))?
        } else if let Some(preparation_id) = current_preparation_id.as_deref() {
            accepted_store
                .find_accepted_stage_preparation_receipt_by_preparation_id(
                    &durable_receipt.run_id,
                    preparation_id,
                )
                .map(|receipt| receipt.is_some())
                .map_err(|error| ApiError::conflict(error.to_string()))?
        } else {
            false
        };
        if preparation_id_differs
            && !stale_accepted_replacement
            && !same_run_previous_stage_is_durable
        {
            return Err(ApiError::conflict(
                "current_live_preparation_receipt_id_mismatch",
            ));
        }

        let stage_disposition = fullmag_runtime_control::retry_store_writer_busy(|| {
            accepted_store.commit_accepted_stage_preparation_receipt(&stage_receipt)
        })
        .map_err(|error| ApiError::conflict(error.to_string()))?;
        match previous_durable_receipt.as_ref() {
            None => fullmag_runtime_control::retry_store_writer_busy(|| {
                accepted_store.commit_preparation_receipt(&durable_receipt)
            })
            .map_err(|error| ApiError::conflict(error.to_string()))?,
            Some(existing) if existing.same_immutable_payload(&durable_receipt) => {
                fullmag_session::PreparationReceiptCommitDisposition::Replayed
            }
            Some(_) => stage_disposition,
        }
    } else {
        live_store
            .commit_preparation_receipt(&durable_receipt)
            .map_err(|error| ApiError::conflict(error.to_string()))?
    };
    *state.current_live_preparation_receipt.write().await = Some(durable_receipt);
    Ok(disposition)
}

/// Accepted-run provenance is allowed on the live sync boundary only when it
/// is fenced to the current run and the durable accepted store.  A structural
/// receipt field alone is not an admission or a source identity.
fn validate_live_accepted_run_source(
    state: &AppState,
    current_run_id: &str,
    receipt: &PreparationReceipt,
    source: &AcceptedRunPreparationSource,
) -> Result<(), ApiError> {
    validate_accepted_source_plan_identity(current_run_id, receipt.plan.source.as_ref(), source)?;

    let store_root = state.submit_store_root.as_ref().ok_or_else(|| {
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_preparation_store_unavailable",
            "accepted preparation provenance requires the configured durable run store",
        )
    })?;
    let store = fullmag_session::SessionStore::open_existing(store_root).map_err(|error| {
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_preparation_store_unavailable",
            format!("failed to open the configured accepted run store: {error}"),
        )
    })?;
    let intent = store
        .read_run_intent(current_run_id)
        .map_err(|error| {
            ApiError::conflict(format!("accepted run provenance read failed: {error}"))
        })?
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "accepted_preparation_run_missing",
                "accepted preparation source has no durable run intent",
            )
        })?;
    let expected_specification_fingerprint = format!("sha256:{}", intent.payload_sha256);
    if source.specification_fingerprint != expected_specification_fingerprint {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_specification_mismatch",
            "accepted preparation source differs from the durable run specification",
        ));
    }

    let catalog = store
        .read_run_catalog(current_run_id)
        .map_err(|error| ApiError::conflict(format!("accepted run catalog read failed: {error}")))?
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "accepted_preparation_catalog_missing",
                "accepted preparation source has no durable run catalog",
            )
        })?;
    let task_id = fullmag_session::task_id_for_study_step(current_run_id, &source.step_id)
        .map_err(|error| {
            ApiError::bad_request(format!("accepted preparation step is invalid: {error}"))
        })?;
    if !catalog.tasks.iter().any(|task| task.task_id == task_id) {
        return Err(ApiError::conflict_with_code(
            "accepted_preparation_step_missing",
            "accepted preparation source step is absent from the durable run catalog",
        ));
    }
    let durable = store
        .read_task_preparation_receipt(current_run_id, &task_id)
        .map_err(|error| {
            ApiError::conflict(format!(
                "accepted task preparation receipt read failed: {error}"
            ))
        })?
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "accepted_preparation_task_receipt_missing",
                "accepted preparation source has no immutable task preparation receipt",
            )
        })?;
    let expected_payload = serde_json::to_value(receipt).map_err(|error| {
        ApiError::internal(format!(
            "accepted preparation receipt serialization failed: {error}"
        ))
    })?;
    validate_accepted_receipt_payload_identity(&expected_payload, &durable.payload)?;
    Ok(())
}

fn validate_accepted_source_plan_identity(
    current_run_id: &str,
    plan_source: Option<&PreparationPlanSource>,
    source: &AcceptedRunPreparationSource,
) -> Result<(), ApiError> {
    if source.run_id.as_str() != current_run_id {
        return Err(ApiError::conflict_with_code(
            "live_preparation_accepted_source_run_mismatch",
            "accepted preparation source does not belong to the current live run",
        ));
    }
    match plan_source {
        Some(PreparationPlanSource::AcceptedRunStep {
            run_id,
            specification_fingerprint,
            step_id,
        }) if run_id == source.run_id.as_str()
            && specification_fingerprint == &source.specification_fingerprint
            && step_id == &source.step_id =>
        {
            Ok(())
        }
        _ => Err(ApiError::bad_request(
            "live_preparation_accepted_source_plan_mismatch",
        )),
    }
}

fn validate_accepted_receipt_payload_identity(
    expected_payload: &Value,
    durable_payload: &Value,
) -> Result<(), ApiError> {
    if expected_payload == durable_payload {
        Ok(())
    } else {
        Err(ApiError::conflict_with_code(
            "accepted_preparation_task_receipt_mismatch",
            "accepted preparation receipt differs from the immutable task receipt",
        ))
    }
}

fn stale_replacement_snapshot_matches(
    previous: &fullmag_session::FmsPreparationReceipt,
    current_preparation_id: Option<&str>,
    snapshot_accepted_run_id: Option<&str>,
) -> bool {
    current_preparation_id == Some(previous.preparation_id.as_str())
        && snapshot_accepted_run_id.is_none_or(|run_id| run_id == previous.run_id)
}

fn stale_replacement_durable_evidence_matches(
    previous_run_id: &str,
    anchor_run_id: &str,
    anchor_matches_previous: bool,
    accepted_source_run_id: Option<&str>,
    task_matches_previous: bool,
    stage_matches_previous: bool,
) -> bool {
    if anchor_run_id != previous_run_id {
        return false;
    }
    match accepted_source_run_id {
        None => anchor_matches_previous,
        Some(source_run_id) => {
            source_run_id == previous_run_id
                && task_matches_previous
                && stage_matches_previous
        }
    }
}

/// Prove that a preparation from a previous run may replace the current
/// in-memory live receipt. A run-id difference alone is not sufficient: the
/// current snapshot must still point at the previous preparation, and the
/// previous run's immutable anchor, task receipt, and stage pointer must all
/// reproduce the in-memory payload. The run-level anchor remains the first
/// immutable preparation for the run, so an accepted later-stage receipt is
/// proven by its task/stage records instead of being compared to that anchor.
fn prove_stale_accepted_replacement(
    live_store: &fullmag_session::SessionStore,
    accepted_store: &fullmag_session::SessionStore,
    previous: &fullmag_session::FmsPreparationReceipt,
    current_preparation_id: Option<&str>,
    snapshot_accepted_run_id: Option<&str>,
) -> Result<bool, ApiError> {
    if !stale_replacement_snapshot_matches(
        previous,
        current_preparation_id,
        snapshot_accepted_run_id,
    ) {
        return Ok(false);
    }

    let Ok(application) =
        serde_json::from_value::<PreparationReceipt>(previous.payload.clone())
    else {
        return Ok(false);
    };
    if application.validate().is_err() {
        return Ok(false);
    }
    let anchor_store = if application.accepted_run_source.is_some() {
        accepted_store
    } else {
        live_store
    };
    let Some(anchor) = read_durable_preparation_anchor(anchor_store, &previous.run_id)?
    else {
        return Ok(false);
    };
    let Some(source) = application.accepted_run_source.as_ref() else {
        return Ok(stale_replacement_durable_evidence_matches(
            &previous.run_id,
            &anchor.run_id,
            anchor.same_immutable_payload(previous),
            None,
            false,
            false,
        ));
    };
    let Ok(task_id) =
        fullmag_session::task_id_for_study_step(&previous.run_id, &source.step_id)
    else {
        return Ok(false);
    };
    let task_receipt = accepted_store
        .read_task_preparation_receipt(&previous.run_id, &task_id)
        .map_err(|error| {
            ApiError::conflict(format!(
                "previous accepted task preparation receipt read failed: {error}"
            ))
        })?;
    let Some(task_receipt) = task_receipt else {
        return Ok(false);
    };
    let task_matches_previous = task_receipt.payload == previous.payload;
    let stage_receipt = accepted_store
        .read_accepted_stage_preparation_receipt(&previous.run_id, &source.step_id)
        .map_err(|error| {
            ApiError::conflict(format!(
                "previous accepted stage preparation receipt read failed: {error}"
            ))
        })?;
    let Some(stage_receipt) = stage_receipt else {
        return Ok(false);
    };
    let stage_matches_previous = stage_receipt.preparation_id == previous.preparation_id
        && stage_receipt.plan_fingerprint == previous.plan_fingerprint
        && stage_receipt.matches_task_receipt(&task_receipt);
    Ok(stale_replacement_durable_evidence_matches(
        &previous.run_id,
        &anchor.run_id,
        anchor.same_immutable_payload(previous),
        Some(source.run_id.as_str()),
        task_matches_previous,
        stage_matches_previous,
    ))
}

fn read_durable_preparation_anchor(
    store: &fullmag_session::SessionStore,
    run_id: &str,
) -> Result<Option<fullmag_session::FmsPreparationReceipt>, ApiError> {
    fullmag_session::repository_path::validate_store_id(run_id)
        .map_err(|error| ApiError::conflict(format!("previous accepted run id is invalid: {error}")))?;
    let relative = format!("runs/{run_id}/preparation_receipt.json");
    let path = store.root().join(&relative);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => {
            return Err(ApiError::conflict(
                "previous accepted preparation anchor is not a regular file",
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(ApiError::conflict(format!(
                "checking previous accepted preparation anchor failed: {error}"
            )));
        }
    }
    let data = fullmag_session::repository_path::read_bounded_regular_file(
        store.root(),
        &relative,
        16 * 1024 * 1024,
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "previous accepted preparation anchor read failed: {error}"
        ))
    })?;
    let anchor: fullmag_session::FmsPreparationReceipt =
        serde_json::from_slice(&data).map_err(|error| {
            ApiError::conflict(format!(
                "previous accepted preparation anchor is invalid: {error}"
            ))
        })?;
    anchor.validate().map_err(|error| {
        ApiError::conflict(format!(
            "previous accepted preparation anchor validation failed: {error}"
        ))
    })?;
    if anchor.run_id != run_id {
        return Err(ApiError::conflict(
            "previous accepted preparation anchor identity does not match its path",
        ));
    }
    Ok(Some(anchor))
}

/// Recover the accepted stage selected by an earlier in-memory receipt.
/// Only an accepted-run payload for the same run is eligible; malformed or
/// legacy receipts return `None` and therefore cannot authorize a replacement.
fn accepted_stage_step_for_run(
    receipt: &fullmag_session::FmsPreparationReceipt,
    run_id: &str,
) -> Option<String> {
    if receipt.run_id != run_id {
        return None;
    }
    let application: PreparationReceipt = serde_json::from_value(receipt.payload.clone()).ok()?;
    application.validate().ok()?;
    let source = application.accepted_run_source?;
    (source.run_id.as_str() == run_id).then_some(source.step_id)
}

fn validate_live_read_model_binding(
    model_preparation_id: &str,
    model_scene_revision: u64,
    model_plan_fingerprint: &str,
    receipt_preparation_id: &str,
    receipt_scene_revision: Option<u64>,
    receipt_plan_fingerprint: &str,
) -> Result<(), ApiError> {
    if model_preparation_id != receipt_preparation_id {
        return Err(ApiError::internal(
            "live preparation read model and receipt preparation IDs disagree",
        ));
    }
    if receipt_scene_revision != Some(model_scene_revision) {
        return Err(ApiError::internal(
            "live preparation read model and receipt scene revisions disagree",
        ));
    }
    if model_plan_fingerprint != receipt_plan_fingerprint {
        return Err(ApiError::internal(
            "live preparation read model and receipt plan fingerprints disagree",
        ));
    }
    Ok(())
}

fn ensure_current_preparation_id(
    snapshot: &SessionStateResponse,
    expected_preparation_id: &str,
) -> Result<(), ApiError> {
    let active_preparation_id = snapshot
        .simulation_preparation
        .as_ref()
        .map(|preparation| preparation.preparation_id.as_str());
    if active_preparation_id != Some(expected_preparation_id) {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_id_mismatch",
        ));
    }
    Ok(())
}

/// Materialize a live preparation and its read model without native FEM work.
/// FDM is self-contained; FEM callers must use the evidence-bearing variant
/// after the existing accepted preparation admission has been established.
pub(crate) async fn materialize_live_scene_preparation_model(
    input: LiveScenePreparationInput,
) -> Result<LiveScenePreparationMaterialization, ApiError> {
    materialize_live_scene_preparation_model_with_fem_evidence(input, None).await
}

/// Materialize a live preparation from native FEM evidence produced by the
/// admitted FEM preparation lane. This function validates the evidence
/// against the canonical plan but never invokes a solver or allocates a host
/// resource itself.
pub(crate) async fn materialize_live_scene_preparation_model_with_fem_evidence(
    input: LiveScenePreparationInput,
    native_fem_evidence: Option<fullmag_plan::NativeFemMeshSpaceEvidence>,
) -> Result<LiveScenePreparationMaterialization, ApiError> {
    tokio::task::spawn_blocking(move || {
        let problem = if input.requested_execution.backend == "fem" {
            // The legacy live lowerer intentionally admits only FDM/auto. FEM
            // uses the same authored SceneDocument capture and declared
            // execution binder, then enters this adapter with native evidence
            // supplied by the already-admitted FEM lane.
            let authored = crate::script::scene_document_to_authored_problem_ir(
                &input.repo_root,
                &input.workspace_root,
                &input.scene_document,
                &input.requested_execution,
            )?;
            let bound = fullmag_application::bind_declared_execution(&authored, vec![]).map_err(
                |error| {
                    ApiError::bad_request(format!(
                        "declared execution profile could not be bound: {error}"
                    ))
                },
            )?;
            bound.validate().map_err(|errors| {
                ApiError::internal(format!(
                    "canonical SceneDocument lowering produced invalid ProblemIR: {}",
                    errors.join("; ")
                ))
            })?;
            bound
        } else {
            crate::script::scene_document_to_problem_ir(
                &input.repo_root,
                &input.workspace_root,
                &input.scene_document,
                &input.requested_execution,
            )?
        };
        let execution_plan = fullmag_plan::plan(&problem).map_err(|error| {
            ApiError::unprocessable(format!("live preparation planning rejected: {error}"))
        })?;
        validate_requested_device_binding(&problem, &input.requested_execution)?;

        let receipt = match execution_plan.common.resolved_backend {
            fullmag_ir::BackendTarget::Fem => {
                let fullmag_ir::BackendPlanIR::Fem(fem_plan) = &execution_plan.backend_plan else {
                    return Err(ApiError::unprocessable(
                        "native FEM preparation currently requires a time-domain FEM plan",
                    ));
                };
                let native = native_fem_evidence.as_ref().ok_or_else(|| {
                    ApiError::with_status_and_code(
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "fem_preparation_admission_required",
                        "native FEM preparation requires an admitted preparation lane",
                    )
                })?;
                if native.fe_order != fem_plan.fe_order {
                    return Err(ApiError::unprocessable(
                        "native FEM preparation evidence has a different finite-element order",
                    ));
                }
                fullmag_application::materialize_fem_preparation_from_problem(
                    input.preparation_id.clone(),
                    input.scene_revision,
                    &problem,
                    &input.display_projection,
                    native,
                )
                .map_err(|error| {
                    ApiError::unprocessable(format!(
                        "preparation materialization rejected: {error}"
                    ))
                })?
            }
            fullmag_ir::BackendTarget::Fdm => {
                if native_fem_evidence.is_some() {
                    return Err(ApiError::bad_request(
                        "native FEM evidence cannot be attached to an FDM preparation",
                    ));
                }
                fullmag_application::materialize_fdm_preparation_from_problem(
                    input.preparation_id.clone(),
                    input.scene_revision,
                    &problem,
                    &input.display_projection,
                )
                .map_err(|error| {
                    ApiError::unprocessable(format!(
                        "preparation materialization rejected: {error}"
                    ))
                })?
            }
            other => {
                return Err(ApiError::unprocessable(format!(
                    "live preparation does not support resolved backend '{}'",
                    other.as_str()
                )));
            }
        };

        receipt.validate().map_err(|error| {
            ApiError::internal(format!("materialized preparation is invalid: {error}"))
        })?;
        if receipt.plan.requested_backend != execution_plan.common.requested_backend
            || receipt.plan.resolved_backend != execution_plan.common.resolved_backend
        {
            return Err(ApiError::internal(
                "preparation receipt and canonical execution plan disagree on backend identity",
            ));
        }
        let problem_fingerprint = format!(
            "sha256:{}",
            fullmag_session::canonical_json_sha256(&serde_json::to_value(&problem).map_err(
                |error| {
                    ApiError::internal(format!("problem fingerprint serialization failed: {error}"))
                },
            )?),
        );
        if receipt.plan.problem_fingerprint != problem_fingerprint {
            return Err(ApiError::internal(
                "preparation receipt and canonical ProblemIR fingerprint disagree",
            ));
        }
        let binding = PreparationBinding::from_receipt(&receipt).map_err(|error| {
            ApiError::internal(format!("materialized preparation binding failed: {error}"))
        })?;
        let read_model = LiveScenePreparationReadModel {
            schema_version: LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
            preparation_id: receipt.preparation_id.clone(),
            scene_revision: input.scene_revision,
            plan_fingerprint: receipt.plan_fingerprint.clone(),
            requested_execution: input.requested_execution,
            execution_plan,
        };
        validate_live_read_model_binding(
            &read_model.preparation_id,
            read_model.scene_revision,
            &read_model.plan_fingerprint,
            &receipt.preparation_id,
            receipt.plan.scene_revision,
            &receipt.plan_fingerprint,
        )?;
        Ok(LiveScenePreparationMaterialization {
            receipt,
            binding,
            read_model,
        })
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!("preparation materialization task failed: {error}"))
    })?
}

/// Legacy callers need only the durable receipt. Keep them on the same
/// canonical adapter so they cannot create a second planning/materialization
/// route.
pub(crate) async fn materialize_live_scene_preparation(
    input: LiveScenePreparationInput,
) -> Result<PreparationReceipt, ApiError> {
    Ok(materialize_live_scene_preparation_model(input)
        .await?
        .receipt)
}

fn validate_requested_device_binding(
    problem: &fullmag_ir::ProblemIR,
    requested: &RequestedExecution,
) -> Result<(), ApiError> {
    let effective = problem
        .problem_meta
        .runtime_metadata
        .get("runtime_device_override")
        .or_else(|| {
            problem
                .problem_meta
                .runtime_metadata
                .get("runtime_selection")
        })
        .and_then(Value::as_object)
        .and_then(|selection| selection.get("device"))
        .and_then(Value::as_str)
        .map(normalize_runtime_device);
    validate_requested_device_value(requested.device.as_str(), effective)
}

fn normalize_runtime_device(device: &str) -> &str {
    if device.eq_ignore_ascii_case("cuda") || device.starts_with("cuda:") {
        "gpu"
    } else {
        device
    }
}

fn validate_requested_device_value(
    requested_device: &str,
    effective_device: Option<&str>,
) -> Result<(), ApiError> {
    match requested_device {
        "gpu" if effective_device != Some("gpu") => Err(ApiError::unprocessable(
            "forced GPU preparation did not retain the GPU runtime selection; fallback=none",
        )),
        "cpu" if effective_device.is_some_and(|device| device != "cpu") => {
            Err(ApiError::unprocessable(
                "forced CPU preparation differs from the canonical runtime selection",
            ))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_application::{
        ProjectId, ProjectSnapshot, RequestedExecution, RequestedResourceBudget, RunId,
        RunSpecification, StudyId, StudyReference,
    };
    use fullmag_ir::BackendTarget;
    use fullmag_plan::{
        PreparationCertificate, PreparationMarkerCertificate, PreparationPlan,
        PreparationProducer, PreparationProducerKind, PreparationQualityCertificate,
        PreparationSpaceCertificate,
    };
    use serde_json::json;

    fn digest(character: char) -> String {
        format!("sha256:{}", character.to_string().repeat(64))
    }

    #[test]
    fn completed_preparation_uses_canonical_stages_and_ready_log_stage() {
        let now = 1_700_000_000_123;
        let stages = canonical_completed_preparation_stages(now, "receipt committed");
        assert_eq!(
            stages
                .iter()
                .map(|stage| stage.id.as_str())
                .collect::<Vec<_>>(),
            CANONICAL_PREPARATION_STAGE_IDS,
        );
        let solver_initialization = stages
            .iter()
            .find(|stage| stage.id == "solver_initialization")
            .expect("canonical solver initialization stage");
        assert_eq!(solver_initialization.status, "skipped");
        assert_eq!(
            solver_initialization.detail,
            "Native solver initialization is deferred until Compute; no solver was invoked during preparation"
        );
        assert_eq!(solver_initialization.progress_percent, None);
        assert_eq!(
            solver_initialization.progress_label.as_deref(),
            Some("awaiting Compute")
        );
        assert!(solver_initialization.started_at_unix_ms.is_none());
        assert!(solver_initialization.completed_at_unix_ms.is_none());
        assert!(solver_initialization.duration_ms.is_none());

        assert!(stages.iter().filter(|stage| stage.id != "solver_initialization").all(
            |stage| stage.status == "completed" && stage.progress_percent == Some(100)
        ));
        assert!(stages.iter().filter(|stage| {
            stage.id != "solver_initialization" && stage.id != "ready"
        }).all(|stage| {
            stage.started_at_unix_ms.is_none()
                && stage.completed_at_unix_ms.is_none()
                && stage.duration_ms.is_none()
        }));
        let ready = stages.last().expect("canonical ready stage");
        assert_eq!(ready.started_at_unix_ms, Some(now));
        assert_eq!(ready.completed_at_unix_ms, Some(now));
        assert_eq!(ready.duration_ms, Some(0));
        assert_eq!(ready.status, "completed");
        assert_eq!(ready.detail, "Authored model preparation is ready; Compute has not run");
        assert_eq!(ready.progress_label.as_deref(), Some("ready"));

        let log = canonical_ready_preparation_log(now, "preparation completed");
        assert_eq!(log.stage_id, "ready");
        assert_eq!(log.timestamp_unix_ms, now);
    }

    fn accepted_source(
        run_id: &str,
        specification_character: char,
        problem_character: char,
        step_id: &str,
    ) -> AcceptedRunPreparationSource {
        AcceptedRunPreparationSource {
            schema_version: fullmag_application::ACCEPTED_RUN_PREPARATION_SOURCE_SCHEMA.into(),
            run_id: fullmag_application::RunId::parse(run_id).unwrap(),
            specification_fingerprint: digest(specification_character),
            step_id: step_id.into(),
            problem_fingerprint: digest(problem_character),
        }
    }

    fn accepted_test_specification(run_id: &str) -> RunSpecification {
        let mut specification = RunSpecification::new(
            ProjectSnapshot {
                project_id: ProjectId::parse("project-cross-store").unwrap(),
                definition_revision: 1,
                definition_sha256: "a".repeat(64),
            },
            StudyReference {
                study_id: StudyId::parse("study-cross-store").unwrap(),
                plan_version: "study_plan.v1".into(),
                plan_sha256: "b".repeat(64),
            },
            "c".repeat(64),
            json!({"temperature": 300}),
            RequestedExecution {
                backend: "fdm".into(),
                device: "cpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: Some(RequestedResourceBudget {
                    cpu_millis: 100,
                    memory_bytes: 1,
                    gpu_memory_bytes: 0,
                    storage_bytes: 1,
                }),
            },
        );
        specification.run_id = RunId::parse(run_id).unwrap();
        specification
    }

    fn accepted_test_receipt(
        specification: &RunSpecification,
        step_id: &str,
        preparation_id: &str,
    ) -> PreparationReceipt {
        let fingerprint = |hex: char| format!("sha256:{}", hex.to_string().repeat(64));
        let producer = |kind: PreparationProducerKind, output: char| {
            PreparationProducer::new(
                kind,
                format!("fullmag.{}", kind.as_str()),
                format!("{}.producer.v1", kind.as_str()),
                "test",
                fingerprint('a'),
                fingerprint(output),
            )
            .unwrap()
        };
        let specification_fingerprint = format!("sha256:{}", specification.fingerprint().unwrap());
        let source = fullmag_plan::PreparationPlanSource::accepted_run_step(
            specification.run_id.as_str(),
            specification_fingerprint,
            step_id,
        )
        .unwrap();
        let plan = PreparationPlan::new_for_accepted_run(
            fingerprint('b'),
            source,
            BackendTarget::Auto,
            BackendTarget::Fdm,
            producer(PreparationProducerKind::Geometry, '1'),
            producer(PreparationProducerKind::Display, '2'),
            producer(PreparationProducerKind::Grid, '3'),
            producer(PreparationProducerKind::Mesh, '4'),
            producer(PreparationProducerKind::Space, '5'),
        )
        .unwrap();
        let marker_map = fingerprint('c');
        let certificates = vec![
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.geometry.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.display.clone(),
                quality: None,
                marker_map: None,
                cell_count: None,
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.grid.clone(),
                quality: None,
                marker_map: None,
                cell_count: Some(4),
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.mesh.clone(),
                quality: Some(PreparationQualityCertificate {
                    cell_count: 4,
                    invalid_cell_count: 0,
                    min_quality: Some(0.2),
                    max_aspect_ratio: Some(3.0),
                    jacobian: None,
                    quality_fingerprint: fingerprint('d'),
                    mesh_source: None,
                }),
                marker_map: Some(PreparationMarkerCertificate {
                    marker_map_fingerprint: marker_map.clone(),
                    marker_ids: vec![1],
                }),
                cell_count: Some(4),
                space: None,
            },
            PreparationCertificate {
                schema_version: fullmag_plan::PREPARATION_CERTIFICATE_SCHEMA.into(),
                producer: plan.space.clone(),
                quality: None,
                marker_map: Some(PreparationMarkerCertificate {
                    marker_map_fingerprint: marker_map.clone(),
                    marker_ids: vec![1],
                }),
                cell_count: None,
                space: Some(PreparationSpaceCertificate {
                    mesh_fingerprint: plan.mesh.output_fingerprint.clone(),
                    marker_map_fingerprint: Some(marker_map),
                    dof_count: 8,
                    space_fingerprint: plan.space.output_fingerprint.clone(),
                    fe_family: None,
                    fe_order: None,
                    local_dof_count: None,
                    true_dof_count: None,
                }),
            },
        ];
        PreparationReceipt::ready_for_accepted_run(
            preparation_id,
            plan,
            certificates,
            Vec::new(),
            specification,
            step_id,
        )
        .unwrap()
    }

    #[test]
    fn accepted_source_identity_accepts_exact_binding_and_rejects_stale_or_mismatched_input() {
        let source = accepted_source("run-accepted", 'a', 'b', "step-a");
        let plan_source = PreparationPlanSource::AcceptedRunStep {
            run_id: "run-accepted".into(),
            specification_fingerprint: digest('a'),
            step_id: "step-a".into(),
        };
        assert!(validate_accepted_source_plan_identity(
            "run-accepted",
            Some(&plan_source),
            &source,
        )
        .is_ok());

        let stale =
            validate_accepted_source_plan_identity("run-replaced", Some(&plan_source), &source)
                .expect_err("a source from the previous run must be fenced");
        assert_eq!(
            stale.code.as_deref(),
            Some("live_preparation_accepted_source_run_mismatch")
        );

        let mismatched_plan = PreparationPlanSource::AcceptedRunStep {
            run_id: "run-accepted".into(),
            specification_fingerprint: digest('c'),
            step_id: "step-a".into(),
        };
        let mismatch =
            validate_accepted_source_plan_identity("run-accepted", Some(&mismatched_plan), &source)
                .expect_err("a source rebound to another specification must be rejected");
        assert_eq!(
            mismatch.message,
            "live_preparation_accepted_source_plan_mismatch"
        );
    }

    #[test]
    fn accepted_stage_lookup_uses_typed_run_identity() {
        let run_id = "run-recovery";
        let specification = accepted_test_specification(run_id);
        let application = accepted_test_receipt(&specification, "step-a", "prep-recovery");
        let receipt = fullmag_session::FmsPreparationReceipt::new(
            "prep-recovery",
            run_id,
            application.plan_fingerprint.clone(),
            serde_json::to_value(application).unwrap(),
        );
        assert_eq!(
            accepted_stage_step_for_run(&receipt, run_id),
            Some("step-a".to_owned()),
        );
        assert_eq!(accepted_stage_step_for_run(&receipt, "run-other"), None);
    }

    #[test]
    fn stale_accepted_replacement_requires_previous_preparation_identity() {
        let previous = fullmag_session::FmsPreparationReceipt::new(
            "prep-previous",
            "run-previous",
            digest('a'),
            json!({
                "schema_version": fullmag_session::FMS_PREPARATION_RECEIPT_SCHEMA,
                "preparation_id": "prep-previous",
                "plan_fingerprint": digest('a'),
            }),
        );
        assert!(stale_replacement_snapshot_matches(
            &previous,
            Some("prep-previous"),
            Some("run-previous"),
        ));
        assert!(stale_replacement_snapshot_matches(
            &previous,
            Some("prep-previous"),
            None,
        ));
        assert!(!stale_replacement_snapshot_matches(
            &previous,
            Some("prep-next"),
            Some("run-previous"),
        ));
        assert!(!stale_replacement_snapshot_matches(
            &previous,
            Some("prep-previous"),
            Some("run-next"),
        ));
        assert!(!stale_replacement_snapshot_matches(&previous, None, None));
    }

    #[test]
    fn stale_accepted_replacement_accepts_stage_receipt_beyond_run_anchor() {
        // The accepted store keeps the first immutable anchor (stage A), while
        // the accepted store keeps the selected later stage (stage B).
        assert!(stale_replacement_durable_evidence_matches(
            "run-previous",
            "run-previous",
            false,
            Some("run-previous"),
            true,
            true,
        ));

        // A legacy MeshBuild has no accepted source and is eligible only when
        // its payload is exactly the live run anchor.
        assert!(stale_replacement_durable_evidence_matches(
            "run-legacy",
            "run-legacy",
            true,
            None,
            false,
            false,
        ));

        assert!(!stale_replacement_durable_evidence_matches(
            "run-previous",
            "run-current",
            false,
            Some("run-previous"),
            true,
            true,
        ));
        assert!(!stale_replacement_durable_evidence_matches(
            "run-previous",
            "run-previous",
            false,
            Some("run-current"),
            true,
            true,
        ));
        assert!(!stale_replacement_durable_evidence_matches(
            "run-previous",
            "run-previous",
            false,
            Some("run-previous"),
            false,
            true,
        ));
    }

    #[tokio::test]
    async fn accepted_commit_uses_submit_store_for_anchor_and_stage_with_distinct_live_store() {
        let temporary = tempfile::tempdir().unwrap();
        let accepted_root = temporary.path().join("accepted-store");
        let live_root = temporary.path().join("live-store");
        let run_id = "test-run";
        let step_id = "step-a";
        let next_step_id = "step-b";
        let specification = accepted_test_specification(run_id);
        let task_id = fullmag_session::task_id_for_study_step(run_id, step_id).unwrap();
        let next_task_id =
            fullmag_session::task_id_for_study_step(run_id, next_step_id).unwrap();
        let preparation_id = format!("prep-{task_id}");
        let next_preparation_id = format!("prep-{next_task_id}");
        let receipt = accepted_test_receipt(&specification, step_id, &preparation_id);
        let next_receipt =
            accepted_test_receipt(&specification, next_step_id, &next_preparation_id);
        let payload = serde_json::to_value(&receipt).unwrap();
        let next_payload = serde_json::to_value(&next_receipt).unwrap();
        let accepted_store = fullmag_session::SessionStore::open(&accepted_root).unwrap();
        let intent = fullmag_session::FmsRunIntent::new(
            run_id,
            "intent-cross-store",
            serde_json::to_value(&specification).unwrap(),
        );
        accepted_store.commit_run_intent(&intent).unwrap();
        accepted_store
            .commit_run_catalog(&fullmag_session::FmsRunCatalog {
                schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![fullmag_session::FmsTaskCatalogEntry {
                    task_id: task_id.clone(),
                    input_fingerprint: "d".repeat(64),
                    lifecycle: fullmag_session::FmsTaskLifecycle::Accepted,
                    readiness: fullmag_session::FmsTaskReadiness::Blocked {
                        reason: "awaiting preparation".into(),
                    },
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                },
                fullmag_session::FmsTaskCatalogEntry {
                    task_id: next_task_id.clone(),
                    input_fingerprint: "e".repeat(64),
                    lifecycle: fullmag_session::FmsTaskLifecycle::Accepted,
                    readiness: fullmag_session::FmsTaskReadiness::Blocked {
                        reason: "awaiting preparation".into(),
                    },
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        accepted_store
            .commit_task_preparation_receipt(
                &fullmag_session::FmsTaskPreparationReceipt::new(
                    run_id,
                    step_id,
                    "d".repeat(64),
                    preparation_id.clone(),
                    receipt.plan_fingerprint.clone(),
                    payload,
                )
                .unwrap(),
            )
            .unwrap();
        accepted_store
            .commit_task_preparation_receipt(
                &fullmag_session::FmsTaskPreparationReceipt::new(
                    run_id,
                    next_step_id,
                    "e".repeat(64),
                    next_preparation_id.clone(),
                    next_receipt.plan_fingerprint.clone(),
                    next_payload,
                )
                .unwrap(),
            )
            .unwrap();

        let mut state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let state_mut = std::sync::Arc::get_mut(&mut state).unwrap();
        state_mut.submit_store_root = Some(accepted_root.clone());
        state_mut.current_command_journal_store_root = Some(live_root.clone());
        let context = crate::capture_current_live_request_context(&state)
            .await
            .unwrap();
        let contention_store =
            fullmag_session::SessionStore::open_existing(&accepted_root).unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (go_tx, go_rx) = std::sync::mpsc::channel();
        let contention_thread = std::thread::spawn(move || {
            let Ok(lease) = contention_store.write_transaction() else {
                let _ = ready_tx.send(false);
                return;
            };
            if ready_tx.send(true).is_err() {
                drop(lease);
                return;
            }
            if go_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .is_ok()
            {
                // Start the bounded hold only after the main thread has
                // witnessed the native conflict and is about to call the API.
                std::thread::sleep(std::time::Duration::from_millis(250));
            }
            drop(lease);
        });
        let ready = ready_rx.recv_timeout(std::time::Duration::from_secs(5));
        let probe_error = match (
            &ready,
            fullmag_session::SessionStore::open_existing(&accepted_root),
        ) {
            (Ok(true), Ok(probe)) => match probe.write_transaction() {
                Ok(lease) => {
                    drop(lease);
                    None
                }
                Err(error) => Some(error),
            },
            (_, Err(error)) => Some(error),
            _ => None,
        };
        let native_busy = probe_error.as_ref().is_some_and(|error| {
            error
                .chain()
                .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
                && format!("{error:#}").contains("conflict=native descriptor")
        });
        let _transition = state.current_live_session_transition.lock().await;
        let go_sent = go_tx.send(()).is_ok();
        let disposition = if native_busy && go_sent {
            commit_live_preparation_receipt_for_context_under_transition(
                &state,
                &context,
                receipt.clone(),
                None,
                None,
                Some(run_id),
            )
            .await
        } else {
            Err(ApiError::conflict(
                "test setup did not establish native writer contention",
            ))
        };
        let contention_join = contention_thread.join();
        assert!(
            matches!(ready, Ok(true)),
            "contention thread did not acquire the native writer: {ready:?}"
        );
        assert!(
            native_busy,
            "test setup must observe native StoreWriterBusy before accepted commit: {probe_error:?}"
        );
        assert!(
            go_sent,
            "contention thread was not ready to start its bounded hold"
        );
        assert!(
            contention_join.is_ok(),
            "contention thread must finish bounded cleanup"
        );
        let disposition = disposition.unwrap();
        assert_eq!(
            disposition,
            fullmag_session::PreparationReceiptCommitDisposition::Accepted
        );
        let accepted_anchor = accepted_store
            .read_preparation_receipt(run_id)
            .unwrap()
            .expect("accepted run anchor must be in the accepted store");
        assert_eq!(accepted_anchor.preparation_id, preparation_id);
        let stage = accepted_store
            .read_accepted_stage_preparation_receipt(run_id, step_id)
            .unwrap()
            .expect("accepted stage pointer must be in the accepted store");
        assert_eq!(stage.preparation_id, preparation_id);
        let live_store = fullmag_session::SessionStore::open(&live_root).unwrap();
        assert!(
            live_store.read_preparation_receipt(run_id).unwrap().is_none(),
            "live journal store must not receive an accepted run anchor"
        );
        assert!(
            live_store.read_run_catalog(run_id).unwrap().is_none(),
            "live journal store must not receive an accepted run catalog"
        );

        drop(_transition);
        let _transition = state.current_live_session_transition.lock().await;
        let replay = commit_live_preparation_receipt_for_context_under_transition(
            &state, &context, receipt.clone(), None, None, Some(run_id),
        )
        .await
        .unwrap();
        assert_eq!(
            replay,
            fullmag_session::PreparationReceiptCommitDisposition::Replayed
        );

        drop(_transition);
        let _transition = state.current_live_session_transition.lock().await;
        let next_stage = commit_live_preparation_receipt_for_context_under_transition(
            &state,
            &context,
            next_receipt.clone(),
            None,
            None,
            Some(run_id),
        )
        .await
        .unwrap();
        assert_eq!(
            next_stage,
            fullmag_session::PreparationReceiptCommitDisposition::Accepted
        );
        assert_eq!(
            accepted_store
                .read_preparation_receipt(run_id)
                .unwrap()
                .unwrap()
                .preparation_id,
            preparation_id
        );
        assert!(accepted_store
            .read_accepted_stage_preparation_receipt(run_id, next_step_id)
            .unwrap()
            .is_some());

        drop(_transition);
        let _transition = state.current_live_session_transition.lock().await;
        let next_replay = commit_live_preparation_receipt_for_context_under_transition(
            &state,
            &context,
            next_receipt.clone(),
            None,
            None,
            Some(run_id),
        )
        .await
        .unwrap();
        assert_eq!(
            next_replay,
            fullmag_session::PreparationReceiptCommitDisposition::Replayed
        );

        let next_stage_receipt = accepted_store
            .read_accepted_stage_preparation_receipt(run_id, next_step_id)
            .unwrap()
            .unwrap();
        let stage_path = accepted_root.join(next_stage_receipt.relative_path().unwrap());
        std::fs::remove_file(stage_path).unwrap();
        *state.current_live_preparation_receipt.write().await = None;
        drop(_transition);
        let _transition = state.current_live_session_transition.lock().await;
        let recovered = commit_live_preparation_receipt_for_context_under_transition(
            &state,
            &context,
            next_receipt,
            None,
            None,
            Some(run_id),
        )
        .await
        .unwrap();
        assert_eq!(
            recovered,
            fullmag_session::PreparationReceiptCommitDisposition::Accepted
        );
        assert!(
            accepted_store
                .read_accepted_stage_preparation_receipt(run_id, next_step_id)
                .unwrap()
                .is_some(),
            "missing stage pointer must be rebuilt from the immutable task receipt"
        );
    }

    #[test]
    fn accepted_receipt_requires_exact_immutable_task_payload() {
        let expected = json!({
            "preparation_id": "prep-step-a",
            "plan_fingerprint": digest('d'),
            "accepted_run_source": {"step_id": "step-a"},
        });
        assert!(validate_accepted_receipt_payload_identity(&expected, &expected).is_ok());

        let mut changed = expected.clone();
        changed["plan_fingerprint"] = json!(digest('e'));
        let error = validate_accepted_receipt_payload_identity(&changed, &expected)
            .expect_err("a changed accepted receipt payload must not be rebound");
        assert_eq!(
            error.code.as_deref(),
            Some("accepted_preparation_task_receipt_mismatch")
        );
    }

    #[test]
    fn read_model_binding_requires_the_same_preparation_revision_and_plan() {
        let plan_fingerprint = digest('f');
        assert!(validate_live_read_model_binding(
            "prep-step-a",
            7,
            &plan_fingerprint,
            "prep-step-a",
            Some(7),
            &plan_fingerprint,
        )
        .is_ok());

        let error = validate_live_read_model_binding(
            "prep-step-a",
            8,
            &plan_fingerprint,
            "prep-step-a",
            Some(7),
            &plan_fingerprint,
        )
        .expect_err("a stale scene revision must not expose a read model");
        assert!(error.message.contains("scene revisions disagree"));
    }

    fn prepared_fem_read_model(with_topology: bool) -> LiveScenePreparationReadModel {
        let mut fem = fullmag_ir::FemPlanIR::default();
        fem.mesh_name = "prepared-tetra".into();
        fem.fe_order = 1;
        if with_topology {
            fem.mesh.nodes = vec![
                [0.0, 0.0, 0.0],
                [1e-9, 0.0, 0.0],
                [0.0, 1e-9, 0.0],
                [0.0, 0.0, 1e-9],
            ];
            fem.mesh.cells = fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]);
            fem.mesh.element_markers = vec![1];
            fem.initial_magnetization = vec![[1.0, 0.0, 0.0]; 4];
        }
        LiveScenePreparationReadModel {
            schema_version: LIVE_SCENE_PREPARATION_READ_MODEL_SCHEMA,
            preparation_id: "prep-domain".into(),
            scene_revision: 7,
            plan_fingerprint: digest('a'),
            requested_execution: RequestedExecution {
                backend: "fem".into(),
                device: "gpu".into(),
                precision: "double".into(),
                mode: "strict".into(),
                minimum_resources: None,
            },
            execution_plan: fullmag_ir::ExecutionPlanIR {
                common: fullmag_ir::CommonPlanMeta {
                    ir_version: "test".into(),
                    requested_backend: fullmag_ir::BackendTarget::Fem,
                    resolved_backend: fullmag_ir::BackendTarget::Fem,
                    execution_mode: fullmag_ir::ExecutionMode::Strict,
                    material_field_plans: Vec::new(),
                },
                backend_plan: fullmag_ir::BackendPlanIR::Fem(fem),
                output_plan: fullmag_ir::OutputPlanIR {
                    outputs: Vec::new(),
                },
                provenance: fullmag_ir::ProvenancePlanIR {
                    notes: Vec::new(),
                    integrator_resolution: None,
                    fem_eigen_execution_resolution: None,
                    physics_graph: None,
                },
            },
        }
    }

    fn prepared_multilayer_read_model() -> LiveScenePreparationReadModel {
        let layer = |layer_id: &str,
                     object_id: &str,
                     magnet_name: &str,
                     native_grid: [u32; 3],
                     native_origin: [f64; 3],
                     initial_magnetization: Vec<[f64; 3]>| {
            fullmag_ir::FdmLayerPlanIR {
                magnet_name: magnet_name.into(),
                layer_id: layer_id.into(),
                object_id: object_id.into(),
                native_grid,
                native_cell_size: [1.0, 1.0, 1.0],
                native_origin,
                native_active_mask: None,
                native_region_mask: None,
                native_region_legend: None,
                initial_magnetization,
                material: fullmag_ir::FdmMaterialIR::default(),
                convolution_grid: [2, 1, 2],
                convolution_cell_size: [1.0, 1.0, 1.0],
                convolution_origin: [0.0, 0.0, 0.0],
                transfer_kind: "identity".into(),
            }
        };
        let multilayer = fullmag_ir::FdmMultilayerPlanIR {
            mode: "two_d_stack".into(),
            common_cells: [2, 1, 2],
            requested_common_cell_size: None,
            grid_certificate: None,
            layers: vec![
                layer(
                    "layer:top",
                    "object:top",
                    "top",
                    [2, 1, 1],
                    [0.0, 0.0, 0.0],
                    vec![[1.0, 0.0, 0.0], [2.0, 0.0, 0.0]],
                ),
                layer(
                    "layer:bottom",
                    "object:bottom",
                    "bottom",
                    [1, 1, 2],
                    [0.0, 0.0, 2.0],
                    vec![[3.0, 0.0, 0.0], [4.0, 0.0, 0.0]],
                ),
            ],
            frozen_spins: None,
            enable_exchange: false,
            enable_demag: true,
            fft: None,
            external_field: None,
            interfacial_dmi: None,
            rotated_interfacial_dmi: None,
            bulk_dmi: None,
            gyromagnetic_ratio: 1.0,
            precision: fullmag_ir::ExecutionPrecision::Double,
            precision_policy: fullmag_ir::FdmPrecisionPolicyIR::default(),
            exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
            periodicity: None,
            resolved_periodic_images: None,
            integrator: fullmag_ir::IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            field_refresh: None,
            relaxation: None,
            planner_summary: fullmag_ir::FdmMultilayerSummaryIR {
                requested_strategy: "multilayer_convolution".into(),
                selected_strategy: "multilayer_convolution".into(),
                requested_mode: "two_d_stack".into(),
                resolved_mode: "two_d_stack".into(),
                eligibility: "eligible".into(),
                estimated_pair_kernels: 1,
                estimated_unique_kernels: 1,
                estimated_kernel_bytes: 0,
                warnings: Vec::new(),
            },
        };
        let mut model = prepared_fem_read_model(true);
        model.requested_execution.backend = "fdm".into();
        model.execution_plan.common.requested_backend = fullmag_ir::BackendTarget::Fdm;
        model.execution_plan.common.resolved_backend = fullmag_ir::BackendTarget::Fdm;
        model.execution_plan.backend_plan = fullmag_ir::BackendPlanIR::FdmMultilayer(multilayer);
        model
    }

    #[test]
    fn prepared_multilayer_initial_state_preserves_native_layer_offsets() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "prepared-multilayer-session",
        }))
        .unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        snapshot.metadata = Some(json!({
            "artifact_layout": {
                "backend": "fdm_multilayer",
                "stale_marker": "previous-run",
                "layers": [{"layer_id": "layer:top", "value_offset": 999, "value_count": 999}]
            }
        }));
        let model = prepared_multilayer_read_model();
        let (metadata, mesh) = prepared_domain_publication(&snapshot, &model).unwrap();
        assert!(mesh.is_none());
        assert_eq!(metadata["artifact_layout"]["backend"], "fdm_multilayer");
        assert!(metadata["artifact_layout"].get("stale_marker").is_none());
        assert_eq!(metadata["artifact_layout"]["layers"][0]["value_offset"], 0);
        assert_eq!(metadata["artifact_layout"]["layers"][0]["value_count"], 2);
        assert_eq!(metadata["artifact_layout"]["layers"][1]["value_offset"], 2);
        assert_eq!(metadata["artifact_layout"]["layers"][1]["value_count"], 2);

        let mut publication: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "prepared-multilayer-session",
        }))
        .unwrap();
        publication.metadata = Some(metadata);
        crate::session::apply_current_live_snapshot(&mut snapshot, publication).unwrap();
        publish_prepared_initial_state(&mut snapshot, &model).unwrap();

        let field = snapshot.latest_fields.get("m").expect("initial m field");
        assert_eq!(
            field["values"],
            json!([
                [1.0, 0.0, 0.0],
                [2.0, 0.0, 0.0],
                [3.0, 0.0, 0.0],
                [4.0, 0.0, 0.0]
            ])
        );
        assert_eq!(field["layout"]["backend"], "fdm_multilayer");
        assert!(field["layout"].get("grid_cells").is_none());
        assert_eq!(field["layout"]["layers"][0]["native_grid"], json!([2, 1, 1]));
        assert_eq!(field["layout"]["layers"][1]["native_grid"], json!([1, 1, 2]));
        assert_eq!(field["layout"]["layers"][1]["value_offset"], 2);
        assert_eq!(field["source_time_seconds"], 0.0);
        assert!(snapshot.scalar_rows.is_empty());
    }

    #[test]
    fn prepared_fem_domain_is_visible_to_existing_binary_and_material_resources_before_solve() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "prepared-domain-session",
            "metadata": {"docker_startup": {"request_id": "startup-domain"}},
        }))
        .unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        snapshot.metadata = request.metadata.clone();
        let model = prepared_fem_read_model(true);
        assert_eq!(
            match &model.execution_plan.backend_plan {
                fullmag_ir::BackendPlanIR::Fem(plan) => plan.mesh.cells.len(),
                _ => 0,
            },
            1,
            "the pinned typed FEM plan must carry solver topology before publication"
        );
        let (metadata, mesh) = prepared_domain_publication(&snapshot, &model).unwrap();
        assert_eq!(metadata["docker_startup"]["request_id"], "startup-domain");
        let mesh = mesh.expect("prepared FEM topology must be published before Compute");
        assert_eq!(mesh.nodes.len(), 4);
        assert_eq!(mesh.cells.len(), 1);
        let generation = mesh.generation_id.clone().unwrap();
        let mut publication: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "prepared-domain-session",
        }))
        .unwrap();
        publication.metadata = Some(metadata);
        publication.fem_mesh = Some(mesh);
        crate::session::apply_current_live_snapshot(&mut snapshot, publication).unwrap();
        publish_prepared_initial_state(&mut snapshot, &model).unwrap();
        assert_eq!(
            snapshot.latest_fields.get("m").unwrap()["values"],
            json!(vec![[1.0, 0.0, 0.0]; 4])
        );
        assert_eq!(
            snapshot.latest_fields.get("m").unwrap()["provenance"]["source_kind"],
            "prepared_initial_state"
        );
        assert_eq!(
            crate::router_v2::handlers::sessions::status::domain_generation_id(&snapshot),
            generation,
        );
        assert!(
            crate::router_v2::handlers::sessions::status::domain_generation_revision(&snapshot) > 0
        );
        assert!(!crate::field_store::serialize_fem_mesh_topology_binary_v2(
            snapshot.fem_mesh.as_ref().unwrap()
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            snapshot.latest_fields.get("mat_ms").unwrap()["values"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert!(
            snapshot.scalar_rows.is_empty(),
            "preparation must not fabricate solver observations"
        );
        assert!(snapshot.live_state.is_none());
    }

    #[test]
    fn preparation_poll_rejects_stop_without_changing_session_identity() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "stop-during-preparation",
        }))
        .unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        assert!(ensure_preparation_run_is_active(&snapshot).is_ok());
        snapshot.session.status = "stopping".into();
        snapshot.run = Some(crate::types::RunManifest {
            run_id: "stop-during-preparation-run".into(),
            session_id: snapshot.session.session_id.clone(),
            status: "stopping".into(),
            total_steps: 1,
            final_time: None,
            final_e_ex: None,
            final_e_demag: None,
            final_e_ext: None,
            final_e_ani: None,
            final_e_dmi: None,
            final_e_rotated_dmi: None,
            final_e_total: None,
            artifact_dir: ".".into(),
        });
        let error = ensure_preparation_run_is_active(&snapshot)
            .expect_err("Stop must fence a later preparation poll for the same session");
        assert_eq!(
            error.code.as_deref(),
            Some("accepted_preparation_run_stopped")
        );
        assert_eq!(snapshot.session.status, "stopping");
        assert_eq!(
            snapshot.run.as_ref().map(|run| run.status.as_str()),
            Some("stopping")
        );
    }

    #[test]
    fn multilayer_metadata_clears_the_previous_fem_solver_domain() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "switch-to-multilayer",
        })).unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        let (_, mesh) = prepared_domain_publication(&snapshot, &prepared_fem_read_model(true)).unwrap();
        snapshot.fem_mesh = mesh;
        assert!(snapshot.fem_mesh.is_some());
        crate::session::apply_current_live_metadata(&mut snapshot, json!({
            "execution_plan": {"backend_plan": {"kind": "fdm_multilayer"}},
        }));
        assert!(snapshot.fem_mesh.is_none(), "a new FDM multilayer plan must not retain stale FEM topology");
    }

    #[test]
    fn prepared_fem_domain_rejects_an_unmaterialized_plan() {
        let request: CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "empty-domain-session",
        }))
        .unwrap();
        let snapshot = crate::session::default_current_live_state(&request);
        let error = prepared_domain_publication(&snapshot, &prepared_fem_read_model(false))
            .expect_err("a FEM preparation cannot report ready without solver topology");
        assert_eq!(
            error.code.as_deref(),
            Some("accepted_preparation_mesh_missing")
        );
    }

    #[test]
    fn forced_device_guard_preserves_profile_and_rejects_fallback() {
        let requested = RequestedExecution {
            backend: "fem".into(),
            device: "gpu".into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: None,
        };
        let before = requested.clone();
        let fallback = validate_requested_device_value(requested.device.as_str(), None)
            .expect_err("forced GPU cannot accept an unresolved runtime device");
        assert!(fallback.message.contains("fallback=none"));
        assert_eq!(
            requested, before,
            "the guard must not rewrite request intent"
        );

        assert!(validate_requested_device_value(requested.device.as_str(), Some("gpu")).is_ok());
        assert!(
            validate_requested_device_value("gpu", Some(normalize_runtime_device("cuda:0")))
                .is_ok()
        );
        assert!(validate_requested_device_value("cpu", Some("gpu")).is_err());
    }
}
