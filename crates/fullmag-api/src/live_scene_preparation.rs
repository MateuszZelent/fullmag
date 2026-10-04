//! Server-side orchestration for lowering an immutable live scene into a
//! validated preparation receipt.
//!
//! Session identity, revision checks, transition fencing, and receipt
//! publication remain in the live API handler. This module owns only the
//! blocking SceneDocument -> ProblemIR -> PreparationReceipt work. Durable
//! publication remains the caller's responsibility.

use fullmag_application::{PreparationBinding, PreparationReceipt, RequestedExecution};
use fullmag_authoring::SceneDocument;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;

use crate::error::ApiError;
use crate::types::{
    AppState, CurrentLivePreparationMaterializationRequest, CurrentLiveRequestContext,
    SessionStateResponse,
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

pub(crate) struct PublishedLiveScenePreparation {
    pub disposition: &'static str,
    pub preparation_id: String,
    pub run_id: String,
    pub plan_fingerprint: String,
    pub receipt_sha256: String,
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
    let receipt = materialize_live_scene_preparation(LiveScenePreparationInput {
        repo_root: state.repo_root.clone(),
        workspace_root: state.current_workspace_root.clone(),
        scene_document,
        preparation_id: request.preparation_id,
        scene_revision,
        requested_execution: request.requested_execution,
        display_projection: request.display_projection,
    })
    .await?;

    let binding = PreparationBinding::from_receipt(&receipt).map_err(|error| {
        ApiError::internal(format!("materialized preparation binding failed: {error}"))
    })?;
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
    if expected_run_id.is_some_and(|expected| expected != current_run_id.as_str()) {
        return Err(ApiError::conflict(
            "current_live_preparation_materialization_run_id_mismatch",
        ));
    }
    if receipt.accepted_run_source.is_some() {
        return Err(ApiError::bad_request(
            "live_preparation_receipt_cannot_carry_accepted_run_source",
        ));
    }
    receipt
        .validate()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;
    if let Some(preparation) = snapshot.simulation_preparation.as_ref() {
        if preparation.preparation_id != receipt.preparation_id {
            return Err(ApiError::conflict(
                "current_live_preparation_receipt_id_mismatch",
            ));
        }
    }
    drop(current);

    let payload = serde_json::to_value(&receipt).map_err(|error| {
        ApiError::internal(format!("failed to encode preparation receipt: {error}"))
    })?;
    let receipt = fullmag_session::FmsPreparationReceipt::new(
        receipt.preparation_id.clone(),
        current_run_id,
        receipt.plan_fingerprint.clone(),
        payload,
    );
    let store = crate::session_persistence::open_store(state)?;
    let disposition = store
        .commit_preparation_receipt(&receipt)
        .map_err(|error| ApiError::conflict(error.to_string()))?;
    *state.current_live_preparation_receipt.write().await = Some(receipt);
    Ok(disposition)
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

pub(crate) async fn materialize_live_scene_preparation(
    input: LiveScenePreparationInput,
) -> Result<PreparationReceipt, ApiError> {
    tokio::task::spawn_blocking(move || {
        let problem = crate::script::scene_document_to_problem_ir(
            &input.repo_root,
            &input.workspace_root,
            &input.scene_document,
            &input.requested_execution,
        )?;
        let execution_plan = fullmag_plan::plan(&problem).map_err(|error| {
            ApiError::unprocessable(format!("live preparation planning rejected: {error}"))
        })?;
        if execution_plan.common.resolved_backend == fullmag_ir::BackendTarget::Fem {
            let fullmag_ir::BackendPlanIR::Fem(fem_plan) = &execution_plan.backend_plan else {
                return Err(ApiError::unprocessable(
                    "native FEM preparation currently requires a time-domain FEM plan",
                ));
            };
            #[cfg(feature = "fem-native")]
            {
                let native_evidence = fullmag_runner::prepare_fem_mesh_space(
                    &fem_plan.mesh,
                    fem_plan.fe_order,
                )
                .map_err(|error| {
                    ApiError::unprocessable(format!("native FEM preparation rejected: {error}"))
                })?;
                return fullmag_application::materialize_fem_preparation_from_problem(
                    input.preparation_id,
                    input.scene_revision,
                    &problem,
                    &input.display_projection,
                    &native_evidence,
                )
                .map_err(|error| {
                    ApiError::unprocessable(format!("preparation materialization rejected: {error}"))
                });
            }
            #[cfg(not(feature = "fem-native"))]
            {
                let _ = fem_plan;
                return Err(ApiError::unprocessable(
                    "native FEM preparation is unavailable because this API was built without fem-native",
                ));
            }
        }
        if execution_plan.common.resolved_backend == fullmag_ir::BackendTarget::Fdm {
            return fullmag_application::materialize_fdm_preparation_from_problem(
                input.preparation_id,
                input.scene_revision,
                &problem,
                &input.display_projection,
            )
            .map_err(|error| {
                ApiError::unprocessable(format!("preparation materialization rejected: {error}"))
            });
        }
        Err(ApiError::unprocessable(format!(
            "live preparation does not support resolved backend '{}'",
            execution_plan.common.resolved_backend.as_str()
        )))
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!("preparation materialization task failed: {error}"))
    })?
}
