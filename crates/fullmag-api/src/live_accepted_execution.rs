//! Adapter from the sessionless live workspace command surface to the durable
//! accepted-run pipeline.
//!
//! The live command journal remains a read model for this adapter.  Durable
//! execution is created through the same typed StudyPlan, profile catalogue,
//! RunIntent/CAS, preparation and accepted-task boundaries as the persistent
//! submit routes.  This module never starts a solver and never allocates a
//! host resource.

use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::schemas::commands::RuntimeCommandTarget;
use crate::types::{AppState, CurrentLiveRequestContext, SessionCommand};

#[derive(Debug, Clone)]
pub(crate) struct AcceptedLiveExecution {
    pub run_id: String,
    pub step_id: String,
}

/// Durable identity returned when a startup script submits its complete
/// authored Study.  The caller owns the current-live read model publication;
/// this adapter only returns the immutable accepted run and its planned steps.
#[derive(Debug, Clone)]
pub(crate) struct AcceptedLiveStudyExecution {
    pub run_id: String,
    pub step_ids: Vec<String>,
    /// A durable RunIntent was accepted, but derived preparation needs
    /// operator recovery. The accepted identity remains visible; callers must
    /// not retry the solver or publish a second run.
    pub preparation_error: Option<AcceptedLiveStudyPreparationError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AcceptedLiveStudyPreparationError {
    pub code: String,
    pub message: String,
}

/// Return the immutable project identity captured by one accepted RunIntent.
///
/// Live API process identity is intentionally absent here: a restart gets a
/// new `request_scope_instance_id`, while the accepted definition and every
/// later catalog/preparation operation remain bound to this snapshot.
pub(crate) fn accepted_project_id_from_intent(
    intent: &fullmag_session::FmsRunIntent,
    run_id: &fullmag_application::RunId,
) -> anyhow::Result<fullmag_application::ProjectId> {
    intent.validate()?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification.clone())?;
    if intent.run_id != run_id.as_str() || specification.run_id != *run_id {
        anyhow::bail!("accepted RunIntent identity differs from the requested run");
    }
    Ok(specification.snapshot.project_id)
}

/// Immutable result of the expensive accepted-study preparation phase.
///
/// This value contains no durable RunIntent publication. Python/Gmsh may have
/// created bounded workspace mesh/cache/staging artifacts, but those artifacts
/// are not an accepted execution and the value can be discarded when the HTTP
/// future is cancelled or the current live session changes. The caller must revalidate
/// its live context under `current_live_session_transition` before passing it
/// to `commit_prepared_live_accepted`.
pub(crate) struct PreparedLiveAcceptedStudy {
    store_root: PathBuf,
    backlog_limit: NonZeroUsize,
    scene: fullmag_authoring::SceneDocument,
    pub(crate) run_id: String,
    project_id: fullmag_application::ProjectId,
    validated_commit: crate::run_intent_persistence::PreparedRunIntentCommit<'static>,
    pub(crate) step_ids: Vec<String>,
    migrated_profile_to_publish: Option<fullmag_ir::ExecutionProfileIR>,
}

#[derive(Debug, Clone)]
pub(crate) struct AcceptedLiveControlExecution {
    pub run_id: String,
    pub affected_task_ids: Vec<String>,
}

#[derive(Debug, Clone)]
enum LiveAcceptedSubmission {
    Command {
        command: SessionCommand,
        request_idempotency_key: Option<String>,
        /// The session's latest live run (a hint for state continuation, ADR 0068 F5).
        previous_run_id: Option<String>,
    },
    Startup {
        request_id: String,
        source_sha256: String,
        auto_run: bool,
        source_path: Option<PathBuf>,
    },
}

/// Route a v2 live compute command into the durable accepted-run pipeline.
///
/// `Ok(None)` preserves the native legacy CPU-v1 queue when this API is not
/// paired with the Docker runtime service. Docker API-only always enters the
/// accepted path; a missing profile is migrated through the pure application
/// helper and published below before any RunIntent is committed.
pub(crate) async fn submit_live_command(
    state: &Arc<AppState>,
    command: &SessionCommand,
    context: &CurrentLiveRequestContext,
    request_idempotency_key: Option<String>,
) -> Result<Option<AcceptedLiveExecution>, ApiError> {
    let scene_missing = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .is_some_and(|snapshot| snapshot.scene_document.is_none());
    if scene_missing {
        crate::get_or_load_current_live_scene_document_for_context(state, context).await?;
    }
    let _transition = state.current_live_session_transition.lock().await;
    submit_live_command_with_transition(state, command, context, request_idempotency_key).await
}

/// Submit while the caller already owns the live transition fence. The
/// command handler uses this form so durable RunIntent publication and the
/// accepted command-journal record share one atomic session transition.
pub(crate) async fn submit_live_command_with_transition(
    state: &Arc<AppState>,
    command: &SessionCommand,
    context: &CurrentLiveRequestContext,
    request_idempotency_key: Option<String>,
) -> Result<Option<AcceptedLiveExecution>, ApiError> {
    let (scene, source_script_path, previous_run_id) = {
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
        if let Some(error) = accepted_preparation_recovery_error(snapshot) {
            return Err(error);
        }
        let source_script_path = (!snapshot.session.script_path.is_empty())
            .then(|| PathBuf::from(snapshot.session.script_path.clone()));
        let previous_run_id = snapshot.run.as_ref().map(|run| run.run_id.clone());
        (snapshot.scene_document.clone(), source_script_path, previous_run_id)
    };

    let scene = match scene {
        Some(scene) => scene,
        None => {
            return Err(ApiError::not_found(
                "no scene document available for current workspace",
            ));
        }
    };

    // A startup script with wait_for_solve already owns one immutable whole
    // Study RunIntent. The first interactive Run/Relax command releases that
    // accepted run; it must not create a second run or silently discard later
    // authored stages.
    if matches!(command.kind.as_str(), "run" | "relax" | "solve" | "resume") {
        // `waiting_for_compute` is also the read-model status used by an
        // accepted run whose manual start gate is still held. Check the
        // durable gate before preparing anything new; otherwise the same
        // authored Study can receive a second RunIntent while its first run
        // is merely waiting for Compute. In Docker API-only runtime this one
        // decision covers both `waiting_for_compute` and `waiting_for_solve`,
        // so the `waiting_for_solve` fallback below cannot release a gate
        // whose preparation is still pending.
        if docker_api_only_runtime() {
            match current_live_waiting_for_compute_gate(state, context).await? {
                Some(ExistingAcceptedRunGate::Held(_run_id)) => {
                    crate::router_v2::handlers::simulation::commands::validate_accepted_command_admission(
                        state, context, command,
                    )
                    .await?;
                    return release_accepted_live_study_with_transition(
                        state,
                        context,
                        &command.command_id,
                    )
                    .await;
                }
                Some(ExistingAcceptedRunGate::Pending(run_id)) => {
                    return Err(ApiError::with_status_and_code(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "accepted_preparation_pending",
                        format!(
                            "accepted run `{run_id}` preparation is not ready; Compute remains held"
                        ),
                    ));
                }
                Some(ExistingAcceptedRunGate::Released(run_id)) => {
                    return Err(ApiError::conflict_with_code(
                        "accepted_run_already_active",
                        format!(
                            "accepted live run `{run_id}` has already released its compute gate"
                        ),
                    ));
                }
                None => {}
            }
        }
        if current_live_run_waits_for_solve(state).await? {
            crate::router_v2::handlers::simulation::commands::validate_accepted_command_admission(
                state, context, command,
            )
            .await?;
            return release_waiting_live_study_with_transition(state, context, &command.command_id).await;
        }
    }

    // The caller holds the same transition fence used by scene/session
    // replacement across the durable publication. The initial context
    // capture protects the read, while this recheck prevents a replacement
    // or scene commit from landing between that read and RunIntent/CAS.
    {
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
        if snapshot
            .scene_document
            .as_ref()
            .is_some_and(|current_scene| current_scene.revision != scene.revision)
        {
            return Err(ApiError::conflict(
                "accepted_execution_scene_revision_changed",
            ));
        }
    }

    let has_published_profile = scene.study.execution_profile.is_some();
    if !has_published_profile && !docker_api_only_runtime() {
        // Native fullmag-api keeps the pre-existing live consumer for every
        // legacy intent, including an authored GPU request.  The accepted-v2
        // adapter is a Docker API-only bridge; it must not turn the absence of
        // a published profile into a new native routing policy.
        return Ok(None);
    }

    if !matches!(command.kind.as_str(), "run" | "relax" | "solve") {
        return Err(ApiError::unprocessable_with_code(
            "accepted_execution_command_unsupported",
            format!(
                "durable accepted live execution currently supports Run, Solve, and LLG Relax; command `{}` is outside the bounded scope",
                command.kind
            ),
        ));
    }

    // This is intentionally before any RunIntent/CAS write. The transition
    // fence held above keeps the journal preconditions and capacity stable
    // through the durable accepted publication.
    crate::router_v2::handlers::simulation::commands::validate_accepted_command_admission(
        state, context, command,
    )
    .await?;

    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "accepted_execution_store_unavailable",
            "durable accepted live execution storage is not configured",
        ));
    };

    let repo_root = state.repo_root.clone();
    let workspace_root = state.current_workspace_root.clone();
    let api_instance_id = state.request_scope_instance_id.clone();
    let backlog_limit = state.submit_backlog_limit;
    let captured_context = context.clone();
    let command = command.clone();

    let solver_profile = next_solver_profile_admission_config(state, context).await?;
    let prepared = tokio::task::spawn_blocking(move || {
        prepare_live_accepted(
            &repo_root,
            &workspace_root,
            None,
            &store_root,
            backlog_limit,
            &api_instance_id,
            &captured_context,
            &scene,
            source_script_path,
            LiveAcceptedSubmission::Command {
                command,
                request_idempotency_key,
                previous_run_id,
            },
            None,
            solver_profile,
        )
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!("accepted live execution preparation task failed: {error}"))
    })??;

    // The durable identity carries the captured API/session/epoch/scene and
    // command fence. Recheck the mutable current pointer before the caller
    // commits RunIntent/CAS so a replaced workspace cannot publish a detached
    // accepted run after an HTTP cancellation.
    validate_live_scene_for_context(state, context, &prepared.scene).await?;
    let accepted = commit_prepared_live_accepted(&prepared)?;
    if let Some(preparation_error) = accepted.preparation_error.as_ref() {
        publish_accepted_live_study_with_preparation_failure_under_transition(
            state,
            context,
            &accepted.run_id,
            &accepted.step_ids,
            "waiting_for_compute",
            preparation_error,
        )
        .await?;
        return Err(ApiError::unprocessable_with_code(
            "accepted_run_recovery_required",
            format!(
                "accepted run `{}` is durable but preparation is incomplete; no solve or retry was started: {}: {}",
                accepted.run_id, preparation_error.code, preparation_error.message
            ),
        ));
    }

    let step_id = accepted
        .step_ids
        .first()
        .cloned()
        .ok_or_else(|| ApiError::internal("accepted live command has no materialized step"))?;
    Ok(Some(AcceptedLiveExecution {
        run_id: accepted.run_id,
        step_id,
    }))
}

fn accepted_preparation_recovery_error(
    snapshot: &crate::types::SessionStateResponse,
) -> Option<ApiError> {
    let startup = snapshot.metadata.as_ref().and_then(|metadata| {
        metadata
            .pointer("/docker_startup")
            .filter(|record| {
                record
                    .get("preparation_status")
                    .and_then(serde_json::Value::as_str)
                    == Some("failed")
            })
            .or_else(|| metadata.pointer("/accepted_preparation"))
    })?;
    if startup
        .get("preparation_status")
        .and_then(serde_json::Value::as_str)
        != Some("failed")
    {
        return None;
    }
    let run_id = snapshot
        .run
        .as_ref()
        .map(|run| run.run_id.as_str())
        .unwrap_or(snapshot.session.run_id.as_str());
    let code = startup
        .get("preparation_error_code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("accepted_run_recovery_required");
    let message = startup
        .get("preparation_error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("accepted run preparation requires operator recovery");
    Some(ApiError::unprocessable_with_code(
        "accepted_run_recovery_required",
        format!(
            "accepted run `{run_id}` remains bound but requires recovery before another compute: {code}: {message}"
        ),
    ))
}

async fn current_live_run_waits_for_solve(state: &Arc<AppState>) -> Result<bool, ApiError> {
    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    Ok(snapshot
        .run
        .as_ref()
        .is_some_and(|run| run.status == "waiting_for_solve"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExistingAcceptedRunGate {
    Held(String),
    Pending(String),
    Released(String),
}

pub(crate) fn accepted_frontier_preparation_is_ready(
    preparation: Option<&crate::types::SimulationPreparationSnapshot>,
    mesh_workspace: Option<&serde_json::Value>,
    run_id: &str,
) -> bool {
    let Some(preparation) = preparation else {
        return false;
    };
    if preparation.status != "ready" || preparation.failure.is_some() {
        return false;
    }
    let Some(mesh_workspace) = mesh_workspace.and_then(serde_json::Value::as_object) else {
        return false;
    };
    if mesh_workspace.get("status").and_then(serde_json::Value::as_str) != Some("completed")
        || mesh_workspace
            .get("accepted_run_id")
            .and_then(serde_json::Value::as_str)
            != Some(run_id)
        || mesh_workspace
            .get("accepted_step_id")
            .and_then(serde_json::Value::as_str)
            .is_none_or(str::is_empty)
    {
        return false;
    }
    let Some(mesh_preparation_id) = mesh_workspace
        .get("preparation_id")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    if mesh_preparation_id != preparation.preparation_id {
        return false;
    }
    let Some(plan_fingerprint) = mesh_workspace
        .get("plan_fingerprint")
        .and_then(serde_json::Value::as_str)
    else {
        return false;
    };
    let Some(plan_fingerprint_hex) = plan_fingerprint.strip_prefix("sha256:") else {
        return false;
    };
    plan_fingerprint_hex.len() == 64
        && plan_fingerprint_hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Resolve the durable start gate for the existing accepted run before a new
/// command can prepare another Study. The live read model uses
/// `waiting_for_compute` both for a held manual gate and for an already
/// released run, and the accepted projector republishes a held gate as
/// `waiting_for_solve`, so status alone is not an admission decision. Both
/// statuses resolve here, and a held gate is released only after the accepted
/// frontier preparation is ready (`Pending` otherwise).
async fn current_live_waiting_for_compute_gate(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
) -> Result<Option<ExistingAcceptedRunGate>, ApiError> {
    let (run_id, preparation_ready) = {
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
        let Some(run) = snapshot.run.as_ref() else {
            return Ok(None);
        };
        // The accepted projector reports a held durable gate as
        // `waiting_for_solve`, while startup publishes `waiting_for_compute`.
        // Both are the same held gate and get one decision, always including
        // the accepted-frontier preparation readiness check.
        if !matches!(run.status.as_str(), "waiting_for_compute" | "waiting_for_solve") {
            return Ok(None);
        }
        let run_id = run.run_id.clone();
        let preparation_ready = accepted_frontier_preparation_is_ready(
            snapshot.simulation_preparation.as_ref(),
            snapshot.mesh_workspace.as_deref(),
            &run_id,
        );
        (run_id, preparation_ready)
    };
    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "accepted_execution_store_unavailable",
            "cannot resolve the existing accepted run start gate without durable execution storage",
        ));
    };
    let gate_run_id = run_id.clone();
    let gate_released = tokio::task::spawn_blocking(move || {
        let store = open_submit_store(&store_root)?;
        store
            .accepted_run_start_permitted(&gate_run_id)
            .map_err(|error| {
                ApiError::conflict_with_code(
                    "accepted_run_start_gate_unavailable",
                    format!("existing accepted run start gate cannot be read: {error:#}"),
                )
            })
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!("accepted run start gate lookup task failed: {error}"))
    })??;
    Ok(Some(if gate_released {
        ExistingAcceptedRunGate::Released(run_id)
    } else if preparation_ready {
        ExistingAcceptedRunGate::Held(run_id)
    } else {
        ExistingAcceptedRunGate::Pending(run_id)
    }))
}

/// Release the existing accepted Study after an interactive Solve command.
/// The runtime-control scheduler owns the dependency-ready frontier after the
/// immutable start gate is released.  This adapter does not eagerly queue FDM
/// stages or bypass the native FEM preparation/admission lane.
pub(crate) async fn release_waiting_live_study_with_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    request_id: &str,
) -> Result<Option<AcceptedLiveExecution>, ApiError> {
    if !current_live_run_waits_for_solve(state).await? {
        return Ok(None);
    }
    release_accepted_live_study_with_transition(state, context, request_id).await
}

/// Release an accepted whole-study run after its preparation receipts are
/// visible. Startup activation uses this for non-interactive scripts: the run
/// is first committed with the immutable manual gate, model/mesh publication
/// waits for the admitted preparation lane, and only then is Compute released.
pub(crate) async fn release_accepted_live_study_with_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    request_id: &str,
) -> Result<Option<AcceptedLiveExecution>, ApiError> {
    let (run_id, scene_revision, execution_input) = {
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
        let Some(run) = snapshot.run.as_ref() else {
            return Ok(None);
        };
        let scene = snapshot.scene_document.as_ref()
            .ok_or_else(|| ApiError::conflict("accepted run has no authored scene"))?;
        (run.run_id.clone(), scene.revision, crate::live_execution_binding::input_identity(scene)?)
    };
    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "accepted_execution_store_unavailable",
            "durable accepted live execution storage is not configured",
        ));
    };
    let typed_run_id = fullmag_application::RunId::parse(run_id.clone())
        .map_err(|error| ApiError::internal(format!("live run identity is invalid: {error}")))?;
    // The public startup/command request id is retained in the live request,
    // provenance and idempotency records, but it is not necessarily a portable
    // repository component (`:` and reserved Windows names are valid at that
    // public boundary). The accepted-start gate stores its request id as a
    // repository component, so pass a deterministic private binding scoped to
    // this exact run and public request instead of changing the public contract.
    let release_request_id = accepted_start_release_request_id(&run_id, request_id);
    let released_steps = tokio::task::spawn_blocking(move || {
        let store = open_submit_store(&store_root)?;
        let intent = store
            .read_run_intent(typed_run_id.as_str())
            .map_err(|error| {
                ApiError::conflict_with_code(
                    "accepted_run_start_release_unavailable",
                    format!("accepted startup run intent cannot be released: {error:#}"),
                )
            })?
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_run_start_release_unavailable",
                    "accepted startup run has no durable RunIntent",
                )
            })?;
        let project_id = crate::live_accepted_execution::accepted_project_id_from_intent(
            &intent,
            &typed_run_id,
        )
        .map_err(|error| {
            ApiError::conflict_with_code(
                "accepted_run_snapshot_unavailable",
                format!("accepted startup RunIntent is not typed: {error:#}"),
            )
        })?;
        intent.validate().map_err(|error| {
            ApiError::conflict(format!("accepted release intent is invalid: {error}"))
        })?;
        crate::live_execution_binding::validate_input_binding(
            &intent.specification,
            &execution_input,
            scene_revision,
        )?;
        let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
            &store,
            &typed_run_id,
            &project_id,
        )
        .map_err(|error| {
            ApiError::conflict_with_code(
                "accepted_run_snapshot_unavailable",
                format!("accepted startup run cannot be released: {error:#}"),
            )
        })?;
        // Validate the immutable RunIntent/catalog/Study snapshot before
        // opening the start gate. A malformed accepted run must remain held
        // for recovery instead of becoming runnable and only then surfacing
        // an API error.
        retry_accepted_start_writer_operation(|| {
            store.release_accepted_run_start(
                typed_run_id.as_str(),
                &intent.payload_sha256,
                &release_request_id,
            )
        })
            .map_err(|error| {
                ApiError::conflict_with_code(
                    "accepted_run_start_release_conflict",
                    format!("accepted startup run release conflicted: {error:#}"),
                )
            })?;
        // Releasing the immutable start gate is the only control-plane
        // mutation here. The runtime-control scheduler owns the ready frontier
        // and will queue only the first dependency-resolvable step, then
        // advance later Study steps from durable outputs. Eagerly queueing
        // every FDM step makes a multi-stage Study fail on unresolved
        // StepOutput inputs and can expose later work after only a partial
        // release.
        let released = accepted
            .lowered
            .steps
            .iter()
            .filter(|step| matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
            .map(|step| step.step_id.clone())
            .collect::<Vec<_>>();
        if released.is_empty() {
            return Err(ApiError::conflict_with_code(
                "accepted_execution_plan_invalid",
                "accepted startup run has no planned executable steps",
            ));
        }
        Ok::<_, ApiError>(released)
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted startup release task failed: {error}")))??;
    crate::validate_current_live_request_context(state, context).await?;
    Ok(Some(AcceptedLiveExecution {
        run_id,
        step_id: released_steps
            .first()
            .cloned()
            .ok_or_else(|| ApiError::internal("accepted startup release lost its first step"))?,
    }))
}

/// Submit the complete authored startup Study through the same durable
/// accepted pipeline as interactive commands. The caller must hold
/// `current_live_session_transition` and must already publish the immutable
/// SceneDocument into the current workspace. This keeps source activation and
/// accepted identity under one session/epoch/revision fence without creating a
/// second solver or queue path.
pub(crate) async fn submit_live_study_with_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    scene: fullmag_authoring::SceneDocument,
    request_id: String,
    source_sha256: String,
    auto_run: bool,
) -> Result<AcceptedLiveStudyExecution, ApiError> {
    submit_live_study_with_transition_with_asset_root(
        state,
        context,
        scene,
        request_id,
        source_sha256,
        auto_run,
        None,
    )
    .await
}

/// Startup variant that keeps the writable workspace root separate from the
/// trusted immutable source parent used for relative imported assets.
pub(crate) async fn submit_live_study_with_transition_with_asset_root(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    scene: fullmag_authoring::SceneDocument,
    request_id: String,
    source_sha256: String,
    auto_run: bool,
    asset_root: Option<PathBuf>,
) -> Result<AcceptedLiveStudyExecution, ApiError> {
    let source_script_path = {
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
        (!snapshot.session.script_path.is_empty())
            .then(|| PathBuf::from(snapshot.session.script_path.clone()))
    };
    let prepared = prepare_live_study_with_source_paths(
        state,
        context,
        scene,
        request_id,
        source_sha256,
        auto_run,
        asset_root,
        source_script_path,
        None,
        None,
    )
    .await?;
    // The existing command path already owns the transition fence. The
    // preparation above writes no accepted durable state; its bounded mesh/cache
    // artifacts are not a RunIntent. Revalidate before the synchronous commit.
    validate_live_scene_for_context(state, context, &prepared.scene).await?;
    commit_prepared_live_accepted(&prepared)
}

/// Prepare a startup or live Study without publishing a durable RunIntent.
///
/// The caller may run this without the live transition fence.  It must invoke
/// `validate_live_scene_for_context` and then commit the returned value while
/// holding that fence.  This is the boundary that keeps Python/Gmsh and other
/// preparation work out of the status/read-model critical section.
pub(crate) async fn prepare_live_study_with_asset_root(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    scene: fullmag_authoring::SceneDocument,
    request_id: String,
    source_sha256: String,
    auto_run: bool,
    asset_root: Option<PathBuf>,
    source_script_path: Option<PathBuf>,
) -> Result<PreparedLiveAcceptedStudy, ApiError> {
    prepare_live_study_with_source_paths(
        state,
        context,
        scene,
        request_id,
        source_sha256,
        auto_run,
        asset_root,
        source_script_path.clone(),
        source_script_path,
        None,
    )
    .await
}

pub(crate) async fn prepare_live_study_with_asset_root_and_progress(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    scene: fullmag_authoring::SceneDocument,
    request_id: String,
    source_sha256: String,
    auto_run: bool,
    asset_root: Option<PathBuf>,
    source_script_path: Option<PathBuf>,
    progress_sender: tokio::sync::mpsc::Sender<crate::script::PythonHelperProgress>,
) -> Result<PreparedLiveAcceptedStudy, ApiError> {
    prepare_live_study_with_source_paths(
        state,
        context,
        scene,
        request_id,
        source_sha256,
        auto_run,
        asset_root,
        source_script_path.clone(),
        source_script_path,
        Some(progress_sender),
    )
    .await
}

async fn prepare_live_study_with_source_paths(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    scene: fullmag_authoring::SceneDocument,
    request_id: String,
    source_sha256: String,
    auto_run: bool,
    asset_root: Option<PathBuf>,
    source_script_path: Option<PathBuf>,
    source_path: Option<PathBuf>,
    progress_sender: Option<tokio::sync::mpsc::Sender<crate::script::PythonHelperProgress>>,
) -> Result<PreparedLiveAcceptedStudy, ApiError> {
    validate_live_scene_for_context(state, context, &scene).await?;
    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "accepted_execution_store_unavailable",
            "durable accepted live execution storage is not configured",
        ));
    };
    let repo_root = state.repo_root.clone();
    let workspace_root = state.current_workspace_root.clone();
    let api_instance_id = state.request_scope_instance_id.clone();
    let backlog_limit = state.submit_backlog_limit;
    let captured_context = context.clone();
    let solver_profile = next_solver_profile_admission_config(state, context).await?;
    let prepared = tokio::task::spawn_blocking(move || {
        prepare_live_accepted(
            &repo_root,
            &workspace_root,
            asset_root.as_deref(),
            &store_root,
            backlog_limit,
            &api_instance_id,
            &captured_context,
            &scene,
            source_script_path,
            LiveAcceptedSubmission::Startup {
                request_id,
                source_sha256,
                auto_run,
                source_path,
            },
            progress_sender,
            solver_profile,
        )
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted startup execution task failed: {error}")))??;
    Ok(prepared)
}

/// Check the immutable scene captured before preparation against the current
/// live session.  This is intentionally a separate guard so startup can run
/// it again after reacquiring the transition fence immediately before commit.
pub(crate) async fn validate_live_scene_for_context(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    scene: &fullmag_authoring::SceneDocument,
) -> Result<(), ApiError> {
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
    let current_scene = snapshot
        .scene_document
        .as_ref()
        .ok_or_else(|| ApiError::not_found("no scene document available for startup"))?;
    let current_value = serde_json::to_value(current_scene).map_err(|error| {
        ApiError::internal(format!("failed to encode current live scene guard: {error}"))
    })?;
    let expected_value = serde_json::to_value(scene).map_err(|error| {
        ApiError::internal(format!("failed to encode prepared live scene guard: {error}"))
    })?;
    validate_scene_revision_and_content(
        current_scene.revision,
        scene.revision,
        &current_value,
        &expected_value,
    )
}

fn validate_scene_revision_and_content(
    current_revision: u64,
    expected_revision: u64,
    current: &serde_json::Value,
    expected: &serde_json::Value,
) -> Result<(), ApiError> {
    if current_revision != expected_revision || current != expected {
        return Err(ApiError::conflict(
            "startup_scene_revision_or_content_changed",
        ));
    }
    Ok(())
}


/// Ensure that a Docker-only preparation command has one durable accepted
/// Study to read from. Legacy live sessions can reach MeshBuild before an
/// interactive Compute command; that first preparation command therefore
/// creates the same manual-gated whole-Study RunIntent used by startup.
///
/// The returned context is rebound to the accepted run when this function had
/// to create it. The caller must already hold the current-live transition
/// fence and must use the returned context for every subsequent read or
/// publication.
pub(crate) async fn ensure_live_accepted_study_with_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    command_id: &str,
) -> Result<CurrentLiveRequestContext, ApiError> {
    let (scene, current_run_id) = {
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
        if let Some(error) = accepted_preparation_recovery_error(snapshot) {
            return Err(error);
        }
        let scene = snapshot
            .scene_document
            .clone()
            .ok_or_else(|| ApiError::not_found("no scene document available for preparation"))?;
        let current_run_id = snapshot
            .run
            .as_ref()
            .map(|run| run.run_id.clone())
            .unwrap_or_else(|| snapshot.session.run_id.clone());
        (scene, current_run_id)
    };
    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "accepted_execution_store_unavailable",
            "durable accepted live execution storage is not configured",
        ));
    };
    let run_id_for_lookup = current_run_id.clone();
    let existing_accepted = tokio::task::spawn_blocking(move || {
        let store = open_submit_store(&store_root)?;
        let Some(intent) = store.read_run_intent(&run_id_for_lookup).map_err(|error| {
            ApiError::conflict_with_code(
                "accepted_execution_run_lookup_failed",
                format!("accepted live run lookup failed: {error:#}"),
            )
        })? else {
            return Ok::<_, ApiError>(false);
        };
        if intent.run_id != run_id_for_lookup {
            return Err(ApiError::conflict_with_code(
                "accepted_execution_run_identity_conflict",
                "durable live RunIntent identity differs from the current run",
            ));
        }
        let typed_run_id = fullmag_application::RunId::parse(run_id_for_lookup.clone())
            .map_err(|error| ApiError::conflict(format!("durable live run id is invalid: {error}")))?;
        let project_id = crate::live_accepted_execution::accepted_project_id_from_intent(
            &intent,
            &typed_run_id,
        )
        .map_err(|error| {
            ApiError::conflict_with_code(
                "accepted_execution_run_invalid",
                format!("accepted live RunIntent is not typed: {error:#}"),
            )
        })?;
        fullmag_runtime_control::load_accepted_study_snapshot(&store, &typed_run_id, &project_id)
            .map_err(|error| {
                ApiError::conflict_with_code(
                    "accepted_execution_run_invalid",
                    format!("durable live accepted Study is invalid: {error:#}"),
                )
            })?;
        Ok(true)
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted live run lookup failed: {error}")))??;
    if existing_accepted {
        return Ok(context.clone());
    }

    let scene_value = serde_json::to_value(&scene)
        .map_err(|error| ApiError::internal(format!("failed to encode live scene: {error}")))?;
    let source_sha256 = fullmag_session::canonical_json_sha256(&scene_value);
    let accepted = submit_live_study_with_transition(
        state,
        context,
        scene,
        format!("live-preparation-{command_id}"),
        source_sha256,
        false,
    )
    .await?;
    if let Some(preparation_error) = accepted.preparation_error.as_ref() {
        publish_accepted_live_study_with_preparation_failure_under_transition(
            state,
            context,
            &accepted.run_id,
            &accepted.step_ids,
            "waiting_for_compute",
            preparation_error,
        )
        .await?;
        return Err(ApiError::unprocessable_with_code(
            "accepted_run_recovery_required",
            format!(
                "accepted run `{}` is durable but preparation is incomplete; no solve or retry was started: {}: {}",
                accepted.run_id, preparation_error.code, preparation_error.message
            ),
        ));
    }
    crate::router_v2::handlers::simulation::commands::publish_accepted_live_study_under_transition(
        state,
        context,
        &accepted.run_id,
        &accepted.step_ids,
        "waiting_for_compute",
    )
    .await?;
    let accepted_context = CurrentLiveRequestContext {
        session_id: context.session_id.clone(),
        run_id: Some(accepted.run_id),
        session_epoch: context.session_epoch,
        request_scope_epoch: context.request_scope_epoch.clone(),
    };
    crate::validate_current_live_request_context(state, &accepted_context).await?;
    Ok(accepted_context)
}

async fn publish_accepted_live_study_with_preparation_failure_under_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    run_id: &str,
    step_ids: &[String],
    status: &str,
    preparation_error: &AcceptedLiveStudyPreparationError,
) -> Result<(), ApiError> {
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
    let mut metadata = snapshot
        .metadata
        .take()
        .map(crate::shared_json::SharedJson::into_value)
        .unwrap_or_else(|| json!({}));
    if !metadata.is_object() {
        metadata = json!({"previous_metadata": metadata});
    }
    let metadata_object = metadata
        .as_object_mut()
        .expect("accepted preparation metadata must be an object");
    metadata_object.insert(
        "accepted_preparation".to_string(),
        json!({
            "status": "failed",
            "run_id": run_id,
            "step_ids": step_ids,
            "preparation_status": "failed",
            "preparation_error_code": preparation_error.code.clone(),
            "preparation_error": preparation_error.message.clone(),
        }),
    );
    crate::router_v2::handlers::simulation::commands::apply_accepted_live_study_snapshot(
        snapshot,
        context,
        state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire),
        run_id,
        step_ids,
        status,
        Some(metadata),
    )?;
    let realtime_snapshot = snapshot.clone();
    drop(current);
    // The accepted run and its recovery marker are already bound atomically
    // before this first publication await. A realtime failure therefore
    // cannot expose an accepted run that is still retryable.
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime_state =
        crate::current_live_realtime_state_from_snapshot(state, &realtime_snapshot, display_revision)
            .await;
    crate::publish_current_live_realtime_batch_changed(state, &realtime_state, false, 0).await?;
    Ok(())
}

/// Persist a Docker live Stop against the exact accepted run. Running or
/// preparing tasks use the durable worker Stop command; accepted/queued tasks
/// use the session cancellation-intent record. No command is put on the
/// legacy in-memory queue.
///
/// `requested_run_id` (from `target: {"kind": "run", "run_id"}`) stops that
/// run instead of the session's latest one; it must be a live run of the same
/// session and epoch.
pub(crate) async fn submit_live_stop_with_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    command_id: &str,
    reason: &str,
    requested_run_id: Option<&str>,
) -> Result<AcceptedLiveControlExecution, ApiError> {
    let current_run_id = {
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
            .ok_or_else(|| ApiError::conflict_with_code(
                "accepted_control_run_missing",
                "Docker Stop requires a durable accepted live run",
            ))
    };
    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "accepted_execution_store_unavailable",
            "durable accepted live execution storage is not configured",
        ));
    };
    let run_id = match requested_run_id {
        Some(requested) => requested.to_string(),
        None => current_run_id?,
    };
    let targeted = requested_run_id.is_some();
    let session_id = context.session_id.clone();
    let session_epoch = context.session_epoch;
    let run_id_for_worker = run_id.clone();
    let command_id = command_id.to_string();
    let reason = reason.trim().to_string();
    if reason.is_empty() {
        return Err(ApiError::bad_request("accepted Stop reason must not be empty"));
    }
    let affected_task_ids = tokio::task::spawn_blocking(move || {
        let store = open_submit_store(&store_root)?;
        if targeted {
            ensure_live_run_belongs_to_session(&store, &run_id_for_worker, &session_id, session_epoch)?;
        }
        let catalog = store
            .read_run_catalog(&run_id_for_worker)
            .map_err(|error| {
                ApiError::conflict_with_code(
                    "accepted_control_catalog_unavailable",
                    format!("accepted live Stop catalog read failed: {error:#}"),
                )
            })?
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_control_catalog_unavailable",
                    "accepted live Stop has no durable run catalog",
                )
            })?;
        request_accepted_stop_for_catalog(
            &store,
            &run_id_for_worker,
            &command_id,
            &reason,
            catalog,
        )
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted live Stop task failed: {error}")))??;
    crate::validate_current_live_request_context(state, context).await?;
    Ok(AcceptedLiveControlExecution {
        run_id,
        affected_task_ids,
    })
}

fn ensure_live_run_belongs_to_session(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    session_id: &str,
    session_epoch: u64,
) -> Result<(), ApiError> {
    let intent = store
        .read_run_intent(run_id)
        .map_err(|error| {
            ApiError::conflict_with_code(
                "accepted_control_catalog_unavailable",
                format!("accepted live Stop intent read failed: {error:#}"),
            )
        })?
        .ok_or_else(|| ApiError::not_found(format!("accepted live run `{run_id}` does not exist")))?;
    let live = intent.specification.pointer("/parameters/live_workspace");
    let same_session = live
        .and_then(|live| live.get("session_id"))
        .and_then(serde_json::Value::as_str)
        == Some(session_id)
        && live
            .and_then(|live| live.get("session_epoch"))
            .and_then(serde_json::Value::as_u64)
            == Some(session_epoch);
    if !same_session {
        return Err(ApiError::conflict_with_code(
            "accepted_control_run_foreign",
            format!("accepted live run `{run_id}` does not belong to the current session"),
        ));
    }
    Ok(())
}

fn request_accepted_stop_for_catalog(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    command_id: &str,
    reason: &str,
    catalog: fullmag_session::FmsRunCatalog,
) -> Result<Vec<String>, ApiError> {
    let mut catalog_revision = catalog.revision;
    let mut affected = Vec::new();
    for task in catalog.tasks {
        let cancellation_id = format!(
            "cancel-live-{}",
            fullmag_session::hex_sha256(
                format!("{}\0{}\0{}", command_id, run_id, task.task_id).as_bytes(),
            )
        );
        let cancellation_expected_revision = match task.lifecycle {
            fullmag_session::FmsTaskLifecycle::Preparing
            | fullmag_session::FmsTaskLifecycle::Running => None,
            _ => store
                .read_task_cancellation_intent(run_id, &task.task_id)
                .map_err(|error| {
                    ApiError::conflict_with_code(
                        "accepted_control_stop_conflict",
                        format!(
                            "accepted live Stop could not read cancellation intent for `{}`: {error:#}",
                            task.task_id
                        ),
                    )
                })?
                .map(|intent| intent.expected_catalog_revision),
        };
        match task.lifecycle {
            fullmag_session::FmsTaskLifecycle::Preparing
            | fullmag_session::FmsTaskLifecycle::Running => {
                let typed_run_id = fullmag_application::RunId::parse(run_id.to_owned())
                    .map_err(|error| ApiError::internal(format!("invalid live run id: {error}")))?;
                let stopped = fullmag_runtime_control::request_accepted_task_stop(
                    store,
                    &typed_run_id,
                    &task.task_id,
                    reason,
                )
                .map_err(|error| {
                    ApiError::conflict_with_code(
                        "accepted_control_stop_conflict",
                        format!("accepted live Stop could not stop task `{}`: {error:#}", task.task_id),
                    )
                })?;
                catalog_revision = stopped.catalog_revision;
                affected.push(task.task_id);
            }
            fullmag_session::FmsTaskLifecycle::Accepted
            | fullmag_session::FmsTaskLifecycle::Queued => {
                // Replays must use the immutable intent's original
                // pre-bump revision. New tasks use the current storage
                // revision carried forward from the preceding task commit.
                // Passing the catalog head to an existing intent would turn a
                // valid Stop retry into an IntentConflict.
                let expected_catalog_revision =
                    cancellation_expected_revision.unwrap_or(catalog_revision);
                let (_, _, next_catalog_revision) = store
                    .request_task_cancellation_intent(
                        run_id,
                        &task.task_id,
                        &cancellation_id,
                        expected_catalog_revision,
                        reason,
                    )
                    .map_err(|error| {
                        ApiError::conflict_with_code(
                            "accepted_control_stop_conflict",
                            format!("accepted live Stop could not cancel task `{}`: {error:#}", task.task_id),
                        )
                    })?;
                catalog_revision = next_catalog_revision;
                affected.push(task.task_id);
            }
            fullmag_session::FmsTaskLifecycle::Stopping
            | fullmag_session::FmsTaskLifecycle::Succeeded
            | fullmag_session::FmsTaskLifecycle::Failed
            | fullmag_session::FmsTaskLifecycle::Cancelled
            | fullmag_session::FmsTaskLifecycle::Interrupted => {
                // A retry can observe the worker's terminal projection after
                // the immutable pre-claim intent was already committed.  In
                // that case replay the intent by its original revision so a
                // successful two-stage Stop remains idempotent after worker
                // lifecycle projection.
                if let Some(expected_catalog_revision) = cancellation_expected_revision {
                    let (_, _, next_catalog_revision) = store
                        .request_task_cancellation_intent(
                            run_id,
                            &task.task_id,
                            &cancellation_id,
                            expected_catalog_revision,
                            reason,
                        )
                        .map_err(|error| {
                            ApiError::conflict_with_code(
                                "accepted_control_stop_conflict",
                                format!(
                                    "accepted live Stop could not replay cancellation for `{}`: {error:#}",
                                    task.task_id
                                ),
                            )
                        })?;
                    catalog_revision = next_catalog_revision;
                    affected.push(task.task_id);
                }
            }
        }
    }
    if affected.is_empty() {
        return Err(ApiError::conflict_with_code(
            "accepted_control_stop_conflict",
            "accepted live Stop found no cancellable task",
        ));
    }
    Ok(affected)
}

/// Compatibility wrapper for existing live-command callers.  Those callers
/// already own the transition fence, so the preparation and the synchronous
/// commit retain their previous ordering without exposing a second pipeline.
#[allow(dead_code)]
fn materialize_live_accepted(
    repo_root: &Path,
    workspace_root: &Path,
    asset_root: Option<&Path>,
    store_root: &Path,
    backlog_limit: NonZeroUsize,
    api_instance_id: &str,
    context: &CurrentLiveRequestContext,
    scene: &fullmag_authoring::SceneDocument,
    source_script_path: Option<PathBuf>,
    submission: LiveAcceptedSubmission,
) -> Result<AcceptedLiveStudyExecution, ApiError> {
    let prepared = prepare_live_accepted(
        repo_root,
        workspace_root,
        asset_root,
        store_root,
        backlog_limit,
        api_instance_id,
        context,
        scene,
        source_script_path,
        submission,
        None,
        None,
    )?;
    commit_prepared_live_accepted(&prepared)
}

/// Apply the Docker output binding only to the lowered execution inputs for an
/// admitted source script.  The authored SceneDocument and the Python export
/// remain unchanged; ordinary UI/managed sources outside the Docker source
/// prefix retain their existing output policy.
fn apply_docker_output_storage_binding(
    inputs: &mut [fullmag_application::StudyStepExecutionInput],
    scene: &fullmag_authoring::SceneDocument,
    source_script_path: Option<&Path>,
) -> Result<(), ApiError> {
    let Some(source_script_path) = source_script_path else {
        return Ok(());
    };
    if source_script_path
        .strip_prefix(Path::new(crate::docker_startup::CONTAINER_SOURCE_ROOT))
        .is_err()
    {
        return Ok(());
    }

    let binding = crate::docker_startup::bind_docker_output_storage_for_source(
        scene,
        source_script_path,
    )?;
    apply_resolved_docker_output_storage_binding(inputs, &binding, source_script_path)
}

fn apply_resolved_docker_output_storage_binding(
    inputs: &mut [fullmag_application::StudyStepExecutionInput],
    binding: &Value,
    source_script_path: &Path,
) -> Result<(), ApiError> {
    let output_storage = binding
        .get("output_storage")
        .cloned()
        .ok_or_else(|| ApiError::internal("Docker output binding has no resolved OutputStorage"))?;
    let source_dir = binding
        .get("source_dir")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::internal("Docker output binding has no resolved source directory"))?
        .to_string();
    let source_stem = source_script_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("Docker startup source path has no valid script stem"))?
        .to_string();

    for input in inputs {
        let runtime_metadata = &mut input.problem.problem_meta.runtime_metadata;
        runtime_metadata.insert("output_storage".to_string(), output_storage.clone());
        runtime_metadata.insert(
            "output_storage_source_dir".to_string(),
            Value::String(source_dir.clone()),
        );
        runtime_metadata.insert(
            "output_storage_source_stem".to_string(),
            Value::String(source_stem.clone()),
        );

        if let Some(model_builder) = runtime_metadata
            .get_mut("model_builder")
            .and_then(Value::as_object_mut)
        {
            if let Some(builder_runtime) = model_builder
                .get_mut("problem")
                .and_then(Value::as_object_mut)
                .and_then(|problem| problem.get_mut("runtime"))
                .and_then(Value::as_object_mut)
            {
                builder_runtime.insert(
                    "output_storage".to_string(),
                    output_storage.clone(),
                );
                builder_runtime.insert(
                    "output_storage_source_dir".to_string(),
                    Value::String(source_dir.clone()),
                );
                builder_runtime.insert(
                    "output_storage_source_stem".to_string(),
                    Value::String(source_stem.clone()),
                );
            }
        }
    }
    Ok(())
}

/// Expensive preparation with no accepted durable-state publication. It may
/// materialize bounded geometry/cache/staging assets in the workspace and reads
/// immutable profile data; RunIntent/CAS and run catalog publication happen in
/// `commit_prepared_live_accepted`.
fn prepare_live_accepted(
    repo_root: &Path,
    workspace_root: &Path,
    asset_root: Option<&Path>,
    store_root: &Path,
    backlog_limit: NonZeroUsize,
    api_instance_id: &str,
    context: &CurrentLiveRequestContext,
    scene: &fullmag_authoring::SceneDocument,
    source_script_path: Option<PathBuf>,
    submission: LiveAcceptedSubmission,
    progress_sender: Option<tokio::sync::mpsc::Sender<crate::script::PythonHelperProgress>>,
    solver_profile: Option<fullmag_runner::SolverProfileConfig>,
) -> Result<PreparedLiveAcceptedStudy, ApiError> {
    let queue_tasks = match &submission {
        LiveAcceptedSubmission::Command { .. } => true,
        LiveAcceptedSubmission::Startup { auto_run, .. } => *auto_run,
    };
    let requested_execution = fullmag_application::RequestedExecution {
        backend: scene.study.requested_backend.clone(),
        device: scene.study.requested_device.clone(),
        precision: scene.study.requested_precision.clone(),
        mode: scene.study.requested_mode.clone(),
        minimum_resources: None,
    };
    requested_execution
        .validate()
        .map_err(|error| ApiError::bad_request(error.to_string()))?;

    // Keep the current workspace immutable. Docker legacy scenes receive an
    // effective clone containing the canonical default profile; the authored
    // layer is added only after the selected StudyPlan step is known, so typed
    // resources cannot be borrowed from a different stage.
    let mut effective_scene = scene.clone();
    let needs_legacy_profile_migration = effective_scene.study.execution_profile.is_none();
    if needs_legacy_profile_migration {
        if !docker_api_only_runtime() {
            return Err(ApiError::unprocessable_with_code(
                "accepted_execution_profile_missing",
                "accepted live execution requires a published execution profile",
            ));
        }
        let profile = fullmag_application::legacy_live_execution_profile();
        effective_scene.study.execution_profile = Some(profile);
    }
    let profile = effective_scene
        .study
        .execution_profile
        .clone()
        .ok_or_else(|| {
            ApiError::unprocessable_with_code(
                "accepted_execution_profile_missing",
                "accepted live execution requires a published execution profile",
            )
        })?;

    let (command_id, request_idempotency_key, command_value, startup_source_sha256) =
        match &submission {
            LiveAcceptedSubmission::Command {
                command,
                request_idempotency_key,
                ..
            } => (
                command.command_id.clone(),
                request_idempotency_key.clone(),
                serde_json::to_value(command).map_err(|error| {
                    ApiError::internal(format!("failed to encode live command: {error}"))
                })?,
                None,
            ),
            LiveAcceptedSubmission::Startup {
                request_id,
                source_sha256,
                auto_run: _,
                source_path: _,
            } => (
                request_id.clone(),
                Some(request_id.clone()),
                json!({
                    "kind": "startup_script",
                    "request_id": request_id,
                    "source_sha256": source_sha256,
                }),
                Some(source_sha256.clone()),
            ),
        };
    let identity = format!(
        "{}\0{}\0{}\0{}\0{}\0{}",
        api_instance_id,
        context.session_id,
        context.session_epoch,
        effective_scene.revision,
        command_id,
        request_idempotency_key.as_deref().unwrap_or_default()
    );
    let identity_digest = fullmag_session::hex_sha256(identity.as_bytes());
    let project_digest = fullmag_session::hex_sha256(
        format!("{}\0{}", api_instance_id, context.session_id).as_bytes(),
    );
    let study_id = format!("live-study-{identity_digest}");
    let run_id = format!("run-live-{identity_digest}");
    let project_id = fullmag_application::ProjectId::parse(format!(
        "project-live-{project_digest}"
    ))
    .map_err(|error| ApiError::internal(format!("live project identity is invalid: {error}")))?;

    let store = open_submit_store(store_root)?;

    let defaults = fullmag_authoring::StudyPlanMigrationDefaults {
        model: fullmag_authoring::StudyModelReference {
            model_id: format!("model:live-{project_digest}"),
            version: "1".into(),
        },
        solver_config: fullmag_authoring::StudySolverConfigReference {
            preset_id: "solver:live-workspace".into(),
            version: "1".into(),
        },
        discretization: fullmag_authoring::StudyDiscretizationReference {
            recipe_id: "mesh:live-workspace".into(),
            version: "1".into(),
        },
        execution_profile: fullmag_authoring::StudyExecutionProfileReference {
            profile_id: profile.profile_id.clone(),
            version: profile.version.clone(),
        },
    };
    let mut study = fullmag_authoring::scene_document_to_study_plan(
        &effective_scene,
        study_id,
        effective_scene.revision,
        &defaults,
    )
    .map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_study_plan_invalid",
            format!("canonical SceneDocument study projection failed: {error}"),
        )
    })?;

    let mut selected_step_index = None;
    let selected_step_id = match &submission {
        LiveAcceptedSubmission::Command { command, .. } => {
            if command.kind == "solve" {
                None
            } else {
                let step_index = select_live_step(&study, command)?;
                let selected_step_id = study.steps[step_index].step_id.clone();
                for (index, step) in study.steps.iter_mut().enumerate() {
                    step.enabled = index == step_index;
                }
                if let Some(until_seconds) = command.until_seconds {
                    study.steps[step_index].until_seconds = Some(until_seconds);
                }
                // Publish the final m so the next live command can continue from it.
                crate::live_accepted_continuation::declare_final_state_output(
                    &mut study.steps[step_index],
                );
                selected_step_index = Some(step_index);
                Some(selected_step_id)
            }
        }
        LiveAcceptedSubmission::Startup { .. } => None,
    };
    apply_live_accepted_observation_output_defaults(&mut study);
    study.validate_for_execution().map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_study_plan_invalid",
            format!("authored live study is not executable: {error}"),
        )
    })?;

    let closed_loop = has_closed_loop_inspection_pipeline(scene);
    // Keep this guard in the preparation scope until the final
    // capture.verify_unchanged() and immutable source-asset copy below.
    // The authored scene remains the original full-content transition fence.
    let generated_scene_source = if closed_loop && !matches!(
        &submission, LiveAcceptedSubmission::Startup { source_path: Some(_), .. }
    ) {
        Some(crate::script::render_accepted_scene_source_bounded(
            repo_root, workspace_root, scene,
        )?)
    } else {
        None
    };
    let mut closed_capture = if closed_loop {
        let source_path = match (&submission, &generated_scene_source) {
            (LiveAcceptedSubmission::Startup { source_path: Some(path), .. }, None) => path,
            (_, Some(generated)) => &generated.path,
            _ => return Err(ApiError::internal("closed-loop source preparation lost its owner")),
        };
        let capture = crate::script::capture_startup_script_scene(repo_root, workspace_root, source_path)?;
        let entry = capture.manifest["entry_relative_path"].as_str().ok_or_else(|| ApiError::unprocessable("captured source entry missing"))?;
        let source = capture.files.get(entry).ok_or_else(|| ApiError::unprocessable("captured source entry bytes missing"))?;
        let captured_source_sha256 = fullmag_session::hex_sha256(source);
        let mut captured_scene: fullmag_authoring::SceneDocument = serde_json::from_value(capture.scene.clone()
            .ok_or_else(|| ApiError::unprocessable("captured source scene missing"))?)
            .map_err(|error| ApiError::unprocessable(format!("captured scene invalid: {error}")))?;
        fullmag_authoring::normalize_scene_document_magnetization_assets(&mut captured_scene);
        if let Some(generated) = generated_scene_source.as_ref() {
            if captured_source_sha256 != generated.source_sha256 || source.len() != generated.byte_count {
                return Err(ApiError::conflict_with_code(
                    "accepted_ui_source_changed", "generated Python source differs from its immutable capture",
                ));
            }
            // The legacy live preparation wrapper passes a SceneDocument
            // fingerprint here. It is not the SHA of generated Python bytes.
            if let LiveAcceptedSubmission::Startup { source_path: None, source_sha256, .. } = &submission {
                if source_sha256 != &generated.scene_sha256 {
                    return Err(ApiError::conflict_with_code(
                        "accepted_ui_scene_changed", "UI source fingerprint differs from the captured scene",
                    ));
                }
            }
            validate_generated_scene_round_trip(scene, &captured_scene)?;
        } else {
            let LiveAcceptedSubmission::Startup { source_path: Some(_), source_sha256, .. } = &submission else {
                return Err(ApiError::internal("authored startup capture lost its source identity"));
            };
            if captured_source_sha256 != *source_sha256 {
                return Err(ApiError::conflict_with_code("accepted_script_source_changed", "startup source differs from immutable capture"));
            }
            if &captured_scene != scene {
                return Err(ApiError::conflict_with_code("accepted_script_scene_changed",
                    "captured script does not reproduce the immutable startup scene"));
            }
        }
        // Capture authoring without geometry; bind the profile before preparing a source.
        let config = crate::script::scene_document_to_authored_script_config_with_asset_root(
            repo_root, workspace_root, asset_root, &effective_scene, &requested_execution)?;
        capture.verify_unchanged().map_err(|error| ApiError::conflict_with_code(
            "accepted_script_source_changed", format!("source changed during scene preparation: {error:#}")))?;
        Some((capture, config))
    } else { None };
    let mut inputs = if let Some((_, config)) = &closed_capture {
        vec![fullmag_application::StudyStepExecutionInput {
            step_id: study.steps.iter().find(|step| step.enabled).ok_or_else(|| ApiError::unprocessable("closed-loop study has no enabled step"))?.step_id.clone(),
            problem: config.ir.clone(), layers: effective_scene.study.execution_layers.clone(),
        }]
    } else {
        crate::script::scene_document_to_study_execution_inputs_with_asset_root_and_progress(
        repo_root,
        workspace_root,
        asset_root,
        &effective_scene,
        &requested_execution,
        &study,
        progress_sender.as_ref(),
        )?
    };
    let report_progress = |label: &str, message: &str| {
        if let Some(sender) = progress_sender.as_ref() {
            let _ = sender.try_send(crate::script::PythonHelperProgress {
                label: label.to_owned(),
                message: message.to_owned(),
            });
        }
    };
    report_progress(
        "Validating materialized Study inputs",
        "Python/Gmsh preparation finished. Validating the materialized Study inputs and resolving execution plans; no solver has started.",
    );
    apply_docker_output_storage_binding(
        &mut inputs,
        &effective_scene,
        source_script_path.as_deref(),
    )?;
    let migrated_profile = if needs_legacy_profile_migration {
        // Migrate every authored Study step independently.  A whole startup
        // script may carry stage-specific typed ComputeResourcesIR; borrowing
        // the first step's layer for all later steps would silently change
        // that authored intent.  The canonical default profile is shared,
        // while each step keeps its own explicit migration layer.
        let mut profile = None;
        for input in &mut inputs {
            let migration = fullmag_application::migrate_legacy_live_execution(
                &input.problem,
                &requested_execution,
                fullmag_ir::ExecutionOriginKindIR::Study,
                format!("live.scene.study.legacy_execution.{}", input.step_id),
            )
            .map_err(|error| {
                ApiError::unprocessable_with_code("legacy_live_execution_migration_failed", error)
            })?;
            if profile.is_none() {
                profile = Some(migration.profile);
            }
            input.layers = vec![migration.layer];
        }
        Some(profile.ok_or_else(|| {
            ApiError::unprocessable_with_code(
                "accepted_execution_stage_missing",
                "legacy live execution migration has no authored source for the StudyPlan",
            )
        })?)
    } else {
        None
    };

    let profile_catalog = store
        .read_execution_profile_catalog()
        .map_err(|error| profile_catalog_error(error.to_string()))?;
    let (published_profile, migrated_profile_to_publish) =
        if let Some(migrated_profile) = migrated_profile.as_ref() {
            if profile_catalog.entries.iter().any(|entry| {
                entry.profile.profile_id == migrated_profile.profile_id
                    && entry.profile.version == migrated_profile.version
            }) {
                let entry = exact_catalog_profile(&profile_catalog, migrated_profile)?;
                (entry.profile, None)
            } else {
                // Legacy profile publication is deferred until the bounded
                // commit phase.  Preparation must not mutate the accepted
                // store while the transition fence is absent.
                (migrated_profile.clone(), Some(migrated_profile.clone()))
            }
        } else {
            (exact_catalog_profile(&profile_catalog, &profile)?.profile, None)
        };
    let published_profile_sha256 = published_profile
        .canonical_sha256()
        .map_err(|error| profile_catalog_error(error.to_string()))?;
    let published_profile_entry_sha256 = profile_catalog
        .entries
        .iter()
        .find(|entry| {
            entry.profile.profile_id == published_profile.profile_id
                && entry.profile.version == published_profile.version
        })
        .map(|entry| entry.profile_sha256.as_str());
    if let Some(entry_sha256) = published_profile_entry_sha256 {
        if entry_sha256 != published_profile_sha256.as_str() {
            return Err(ApiError::conflict_with_code(
                "execution_profile_hash_conflict",
                format!(
                    "published execution profile `{}/{}` has a catalogue hash that does not match its canonical content",
                    published_profile.profile_id, published_profile.version
                ),
            ));
        }
    }

    let profile_lookup = |profile_id: &str, version: &str| {
        if profile_id == published_profile.profile_id && version == published_profile.version {
            Ok(published_profile.clone())
        } else {
            Err(format!(
                "execution profile `{profile_id}/{version}` is not the pinned live profile"
            ))
        }
    };
    // A continued command pins its initial state, which changes the StudyPlan
    // digest the catalog is bound to; keep the inputs to rebuild it.
    let rebind_inputs: Option<Vec<fullmag_application::StudyStepExecutionInput>> =
        selected_step_index.map(|_| {
            inputs
                .iter()
                .map(|input| fullmag_application::StudyStepExecutionInput {
                    step_id: input.step_id.clone(),
                    problem: input.problem.clone(),
                    layers: input.layers.clone(),
                })
                .collect()
        });
    let mut script_assets = None;
    let mut catalog = if let Some((capture, config)) = closed_capture.take() {
        let layers = inputs.first().ok_or_else(|| ApiError::unprocessable("closed-loop migration input missing"))?.layers.clone();
        let bound = fullmag_application::materialize_captured_study_input(
            "script-base", config.ir, &defaults.execution_profile, layers.clone(),
            |id, version| if id == published_profile.profile_id && version == published_profile.version {
                Ok(published_profile.clone())
            } else { Err("closed-loop execution profile differs from pinned live profile".into()) },
        ).map_err(ApiError::unprocessable)?;
        // Projection validates typed resource intent even before host admission.
        let mut preparation_constraints = requested_execution.clone();
        preparation_constraints.minimum_resources = Some(minimum_resource_budget(
            &bound.problem, &requested_execution.device,
            bound.execution.requested.device == fullmag_ir::ExecutionDevice::Gpu,
        )?);
        let prepared_request = preparation_constraints.for_problem(&bound.problem)
            .map_err(|error| ApiError::unprocessable(error.to_string()))?;
        let config = crate::script::scene_document_to_bound_prepared_script_config_with_asset_root(
            repo_root, workspace_root, asset_root, &effective_scene, &prepared_request, &bound.problem)?;
        let compiled = fullmag_application::compile_accepted_closed_loop_pipeline(
            config, study.study_id.clone(), effective_scene.revision, defaults.execution_profile.clone(), layers,
            capture.manifest.clone(),
            |id, version| if id == published_profile.profile_id && version == published_profile.version {
                Ok(published_profile.clone())
            } else { Err("closed-loop execution profile differs from pinned live profile".into()) },
            fullmag_ir::configure_project_autosave_policy,
        ).map_err(|error| ApiError::unprocessable_with_code("accepted_script_compilation_failed",
            format!("canonical closed-loop compilation failed: {error:#}")))?;
        study = compiled.study;
        script_assets = Some((capture, compiled.source_bytes, compiled.source_reference));
        compiled.catalog
    } else {
        fullmag_application::materialize_study_execution(
        &study,
        inputs,
        |profile_id, version| {
            if profile_id == published_profile.profile_id && version == published_profile.version {
                Ok(published_profile.clone())
            } else {
                Err(format!(
                    "execution profile `{profile_id}/{version}` is not the pinned live profile"
                ))
            }
        },
    )
    .map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_execution_materialization_failed",
            format!("StudyPlan execution materialization failed: {error}"),
        )
        })?

    };
    let entries = catalog.entries();
    let requested_gpu = requested_execution.device.eq_ignore_ascii_case("gpu");
    let mut run_budget = None;
    for entry in entries {
        let profile_requests_gpu = entry
            .execution_materialization()
            .is_some_and(|materialization| {
                materialization.requested.device == fullmag_ir::ExecutionDevice::Gpu
            });
        if requested_gpu != profile_requests_gpu
            && !requested_execution.device.eq_ignore_ascii_case("auto")
        {
            return Err(ApiError::conflict_with_code(
                "execution_profile_device_conflict",
                format!(
                    "requested device `{}` does not match the published execution profile materialization for study step `{}`",
                    requested_execution.device,
                    entry.step_id()
                ),
            ));
        }
        let gpu_requested = requested_gpu || profile_requests_gpu;
        if gpu_requested && !bounded_gpu_scope(entry.problem()) {
            return Err(ApiError::unprocessable_with_code(
                "accepted_gpu_scope_unsupported",
                format!(
                    "accepted GPU execution for study step `{}` is limited to TimeEvolution, LLG-overdamped Relaxation, and explicit FEM ProjectedGradientBb",
                    entry.step_id()
                ),
            ));
        }
        let budget = minimum_resource_budget(
            entry.problem(),
            &requested_execution.device,
            profile_requests_gpu,
        )?;
        run_budget = Some(match run_budget {
            Some(existing) => max_resource_budget(existing, budget),
            None => budget,
        });
    }

    let mut requested_execution = requested_execution;
    requested_execution.minimum_resources = run_budget;

    // Validate every lowered step before publishing RunIntent/CAS. A whole
    // startup Study must never leave an accepted durable run behind a later
    // unsupported backend or missing execution plan.
    let lowered = fullmag_plan::lower_study_plan_with_catalog(&study, &catalog).map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_execution_plan_invalid",
            format!("canonical accepted study lowering failed: {error}"),
        )
    })?;
    let mut step_ids = Vec::new();
    for execution_step in &lowered.steps {
        if !matches!(execution_step.status, fullmag_plan::StudyStepLoweringStatus::Planned) {
            continue;
        }
        let execution_plan = execution_step.execution_plan.as_ref().ok_or_else(|| {
            ApiError::unprocessable_with_code(
                "accepted_execution_plan_invalid",
                format!("accepted study step `{}` has no execution plan", execution_step.step_id),
            )
        })?;
        match execution_plan.common.resolved_backend {
            fullmag_ir::BackendTarget::Fdm | fullmag_ir::BackendTarget::Fem => {}
            backend => {
                return Err(ApiError::unprocessable_with_code(
                    "accepted_backend_unsupported",
                    format!("accepted live execution resolved unsupported backend {backend:?}"),
                ));
            }
        }
        step_ids.push(execution_step.step_id.clone());
    }
    if step_ids.is_empty() {
        return Err(ApiError::unprocessable_with_code(
            "accepted_execution_plan_invalid",
            "accepted study has no planned executable steps",
        ));
    }

    // Continuation (ADR 0068 F5): start from the previous live command's final
    // m when the accepted plan has exactly the same magnetization layout.
    let initial_state = match (&submission, selected_step_index) {
        (LiveAcceptedSubmission::Command { previous_run_id, .. }, Some(step_index)) => {
            let step_id = study.steps[step_index].step_id.clone();
            let plan = lowered
                .steps
                .iter()
                .find(|step| step.step_id == step_id)
                .and_then(|step| step.execution_plan.as_ref());
            let decision = match plan {
                Some(plan) => crate::live_accepted_continuation::decide_initial_state(
                    &store,
                    previous_run_id.as_deref(),
                    &context.session_id,
                    context.session_epoch,
                    plan,
                ),
                None => crate::live_accepted_continuation::InitialStateDecision::Authored {
                    reason: "selected step has no execution plan".into(),
                },
            };
            if let crate::live_accepted_continuation::InitialStateDecision::Continuation(source) =
                &decision
            {
                crate::live_accepted_continuation::declare_pinned_initial_state(
                    &mut study.steps[step_index],
                    source,
                );
                study.validate_for_execution().map_err(|error| {
                    ApiError::unprocessable_with_code(
                        "accepted_study_plan_invalid",
                        format!("continued live study is not executable: {error}"),
                    )
                })?;
                let inputs = rebind_inputs.expect("selected live step keeps its inputs");
                catalog = fullmag_application::materialize_study_execution(
                    &study,
                    inputs,
                    profile_lookup,
                )
                .map_err(|error| {
                    ApiError::unprocessable_with_code(
                        "accepted_execution_materialization_failed",
                        format!("continued StudyPlan materialization failed: {error}"),
                    )
                })?;
            }
            Some(decision.provenance())
        }
        _ => None,
    };

    // Keep the authored document identical to the execution_input pin. The
    // derived legacy profile belongs to the accepted Study, not the editable
    // scene restored after a restart.
    let scene_value = serde_json::to_value(scene).map_err(|error| {
        ApiError::internal(format!("failed to serialize accepted SceneDocument: {error}"))
    })?;
    let mut definition = fullmag_application::ProjectEnvelope::blank(
        project_id.clone(),
        "Live Workspace",
    )
    .map_err(|error| ApiError::internal(format!("failed to create live project envelope: {error}")))?;
    definition.definition.revision = effective_scene.revision;
    definition
        .replace_scene(
            fullmag_application::RawJsonEnvelope::from_value(scene_value)
                .map_err(|error| ApiError::internal(error.to_string()))?,
        )
        .map_err(|error| ApiError::internal(error.to_string()))?;
    definition.definition.revision = effective_scene.revision;
    definition
        .rewrite_known_fields()
        .map_err(|error| ApiError::internal(error.to_string()))?;
    definition
        .validate_for_save()
        .map_err(|error| ApiError::unprocessable_with_code("accepted_project_invalid", error.to_string()))?;

    let mut asset_paths = BTreeMap::new();
    if let Some((capture, source_bytes, source_reference)) = script_assets {
        capture.verify_unchanged().map_err(|error| ApiError::conflict_with_code(
            "accepted_script_source_changed", format!("source changed before accepted capture: {error:#}")))?;
        for (relative, bytes) in capture.files {
            let asset_id = format!("script-file-{}", fullmag_application::study_artifact_content_sha256(relative.as_bytes()));
            let path = format!("project/assets/accepted-script/files/{relative}");
            if definition.assets.iter().any(|asset| asset.path() == path) {
                return Err(ApiError::conflict("captured script asset path collision"));
            }
            definition.assets.push(fullmag_application::OpaqueAsset::new(&path, bytes, None)
                .map_err(|error| ApiError::unprocessable(error.to_string()))?);
            asset_paths.insert(asset_id, path);
        }
        if fullmag_application::study_artifact_content_sha256(&source_bytes) != source_reference.content_sha256 {
            return Err(ApiError::conflict("compiled script source reference differs from payload"));
        }
        let path = "project/assets/accepted-script/pipeline-source.json";
        definition.assets.push(fullmag_application::OpaqueAsset::new(path, source_bytes, None)
            .map_err(|error| ApiError::unprocessable(error.to_string()))?);
        asset_paths.insert(source_reference.asset_id, path.to_owned());
        definition.validate_for_save().map_err(|error| ApiError::unprocessable(error.to_string()))?;
    }

    let execution_input = crate::live_execution_binding::input_identity(scene)?;
    let mut parameters = json!({
        "live_workspace": {
            "api_instance_id": api_instance_id,
            "session_id": &context.session_id,
            "session_epoch": context.session_epoch,
            "scene_revision": effective_scene.revision,
            "execution_input": execution_input,
            "command_id": &command_id,
            "request_idempotency_key": &request_idempotency_key,
            "step_id": selected_step_id,
            "command": &command_value,
            "startup_source_sha256": &startup_source_sha256,
        }
    });
    if let Some(config) = solver_profile {
        parameters.as_object_mut().expect("RunSpec parameters object").insert(
            crate::accepted_solver_profile::PARAMETER.into(),
            crate::accepted_solver_profile::parameter(config)
                .map_err(|error| ApiError::unprocessable(error.to_string()))?);
    }
    if let Some(initial_state) = initial_state {
        parameters["live_workspace"]
            .as_object_mut()
            .expect("live_workspace parameters object")
            .insert("initial_state_source".to_string(), initial_state);
    }
    if !queue_tasks {
        parameters
            .as_object_mut()
            .expect("live RunSpec parameters object")
            .insert(
                fullmag_session::ACCEPTED_RUN_START_POLICY_KEY.to_string(),
                json!({
                    "schema_version": "accepted_run_start_policy.v1",
                    "mode": "manual",
                }),
            );
    }
    crate::accepted_solver_profile::validate_study_profile(&parameters, &study)
        .map_err(|error| ApiError::unprocessable_with_code("accepted_solver_profile_unsupported", error.to_string()))?;
    let intent_id = request_idempotency_key
        .as_deref()
        .map(|key| format!("live-http-{}", fullmag_session::hex_sha256(key.as_bytes())))
        .unwrap_or_else(|| format!("live-command-{identity_digest}"));
    let authored = fullmag_application::RunIntentAuthoring {
        run_id: fullmag_application::RunId::parse(run_id.clone())
            .map_err(|error| ApiError::internal(format!("live run identity is invalid: {error}")))?,
        idempotency_key: intent_id,
        parameters,
        seeds: BTreeMap::new(),
        dependencies: Vec::new(),
        scheduling_priority: 0,
        requested_execution,
    };
    report_progress(
        "Materializing the accepted run definition",
        "Execution plans are resolved. Materializing the accepted run definition from the validated model and Study.",
    );
    let intent = fullmag_application::materialize_run_intent(
        &definition,
        &study,
        &catalog,
        authored,
        &asset_paths,
    )
    .map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_run_intent_invalid",
            format!("typed live RunIntent materialization failed: {error:#}"),
        )
    })?;
    let mut asset_payloads = BTreeMap::new();
    for (asset_id, path) in &asset_paths {
        let asset = definition.assets.iter().find(|asset| asset.path() == path)
            .ok_or_else(|| ApiError::internal(format!("prepared immutable asset `{asset_id}` is missing")))?;
        asset_payloads.insert(asset_id.clone(), asset.bytes().to_vec());
    }
    report_progress(
        "Validating and encoding durable inputs",
        "Validating and encoding immutable run inputs before publication. Native domain preparation and Compute have not started.",
    );
    let validated_commit = crate::run_intent_persistence::prepare_owned_run_intent_commit(
        intent,
        &definition,
        &study,
        &catalog,
        asset_payloads,
    )
    .map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_run_commit_failed",
            format!("durable accepted RunIntent precommit validation failed: {error:#}"),
        )
    })?;
    Ok(PreparedLiveAcceptedStudy {
        store_root: store_root.to_path_buf(),
        backlog_limit,
        scene: scene.clone(),
        run_id,
        project_id,
        validated_commit,
        step_ids,
        migrated_profile_to_publish,
    })
}

/// Commit one already prepared accepted Study.  This function is deliberately
/// synchronous: callers invoke it only after acquiring the live transition
/// fence, so cancellation cannot abandon a `spawn_blocking` future while its
/// closure continues writing RunIntent/CAS in the background.
pub(crate) fn commit_prepared_live_accepted(
    prepared: &PreparedLiveAcceptedStudy,
) -> Result<AcceptedLiveStudyExecution, ApiError> {
    let store = open_submit_store(&prepared.store_root)?;
    if let Some(profile) = prepared.migrated_profile_to_publish.as_ref() {
        let profile_catalog = store
            .read_execution_profile_catalog()
            .map_err(|error| profile_catalog_error(error.to_string()))?;
        let published = ensure_migrated_profile_published(&store, &profile_catalog, profile)?;
        let expected_sha256 = profile
            .canonical_sha256()
            .map_err(|error| profile_catalog_error(error.to_string()))?;
        if published.profile != *profile || published.profile_sha256 != expected_sha256 {
            return Err(ApiError::conflict_with_code(
                "execution_profile_hash_conflict",
                "legacy execution profile publication did not preserve the prepared profile",
            ));
        }
    }
    // A successful return is the typed commit boundary: the opaque payload
    // was fully validated during preparation, and this helper writes its
    // pinned CAS bytes and RunIntent under one lease. Do not add a fallible
    // post-commit validation here; after acceptance any error path must
    // preserve the accepted identity for recovery.
    let _committed = crate::run_intent_persistence::commit_prepared_run_intent_with_backlog_limit(
        &store,
        &prepared.validated_commit,
        prepared.backlog_limit,
    )
    .map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_run_commit_failed",
            format!("durable accepted RunIntent commit failed: {error:#}"),
        )
    })?;
    let preparation_error = match crate::run_intent_persistence::materialize_accepted_run_catalog(
        &store,
        &prepared.run_id,
        &prepared.project_id,
    ) {
        Ok(_) => None,
        Err(error) => {
            let message = format!(
                "durable accepted run catalog materialization failed: {}",
                bounded_recovery_error(format!("{error:#}")),
            );
            tracing::error!(
                run_id = %prepared.run_id,
                error = %message,
                "accepted RunIntent survived derived preparation failure; keeping identity for recovery"
            );
            Some(AcceptedLiveStudyPreparationError {
                code: "accepted_run_catalog_failed".to_string(),
                message,
            })
        }
    };

    Ok(AcceptedLiveStudyExecution {
        run_id: prepared.run_id.clone(),
        step_ids: prepared.step_ids.clone(),
        preparation_error,
    })
}

const MAX_RECOVERY_ERROR_CHARS: usize = 1024;
const ACCEPTED_START_RELEASE_ID_DOMAIN: &str = "fullmag.accepted_run_start_release.v1";

/// Derive the private repository-safe request identity used by the durable
/// accepted-start gate. The public request id remains in the startup/command
/// provenance; this digest only binds the one release record to its run and
/// request without imposing repository-name rules on the public API.
fn accepted_start_release_request_id(run_id: &str, public_request_id: &str) -> String {
    let identity = format!("{ACCEPTED_START_RELEASE_ID_DOMAIN}\0{run_id}\0{public_request_id}");
    format!(
        "accepted-start-{}",
        fullmag_session::hex_sha256(identity.as_bytes())
    )
}

fn bounded_recovery_error(message: String) -> String {
    let mut bounded = message.chars().take(MAX_RECOVERY_ERROR_CHARS).collect::<String>();
    if message.chars().count() > MAX_RECOVERY_ERROR_CHARS {
        bounded.push_str("...");
    }
    bounded
}

fn select_live_step(
    study: &fullmag_authoring::StudyPlan,
    command: &SessionCommand,
) -> Result<usize, ApiError> {
    let expected_kind = if command.kind == "run" {
        fullmag_authoring::StudyPrimitiveStageKind::Run
    } else {
        fullmag_authoring::StudyPrimitiveStageKind::Relax
    };
    let candidates = study
        .steps
        .iter()
        .enumerate()
        .filter(|(_, step)| {
            step.enabled
                && matches!(
                    &step.kind,
                    fullmag_authoring::StudyStepKind::Primitive { stage_kind }
                        if *stage_kind == expected_kind
                )
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();

    let requested_index = match command.target.as_ref() {
        Some(RuntimeCommandTarget::StageIndex { stage_index }) => Some(*stage_index as usize),
        Some(RuntimeCommandTarget::StageId { stage_id })
        | Some(RuntimeCommandTarget::CurrentStage {
            stage_id: Some(stage_id),
        }) => study.steps.iter().position(|step| step.step_id == *stage_id),
        _ => None,
    };
    if let Some(index) = requested_index {
        if candidates.contains(&index) {
            return Ok(index);
        }
        return Err(ApiError::unprocessable_with_code(
            "accepted_study_step_unsupported",
            "the requested live stage is not an enabled Run/Relax StudyPlan step",
        ));
    }
    if candidates.len() == 1 {
        return Ok(candidates[0]);
    }
    if candidates.is_empty() {
        return Err(ApiError::unprocessable_with_code(
            "accepted_study_step_unsupported",
            "the live StudyPlan has no enabled Run/Relax step for this command",
        ));
    }
    Err(ApiError::unprocessable_with_code(
        "accepted_study_step_ambiguous",
        "a live Run/Relax command must target exactly one enabled StudyPlan step",
    ))
}

/// Supply the accepted-live observation outputs required by the shared FDM/FEM
/// Run/Relax workers when an enabled primitive has no authored outputs. The
/// public authoring projection remains unchanged; explicit outputs and other
/// primitive, macro, group, or unsupported steps retain their authored shape.
fn apply_live_accepted_observation_output_defaults(study: &mut fullmag_authoring::StudyPlan) {
    for step in &mut study.steps {
        if !step.enabled || !step.outputs.is_empty() {
            continue;
        }
        let needs_observation_outputs = match &step.kind {
            fullmag_authoring::StudyStepKind::Primitive { stage_kind } => matches!(
                *stage_kind,
                fullmag_authoring::StudyPrimitiveStageKind::Run
                    | fullmag_authoring::StudyPrimitiveStageKind::Relax
            ),
            _ => false,
        };
        if needs_observation_outputs {
            step.outputs = vec![
                fullmag_authoring::StudyOutputPort {
                    port_id: "final_state".to_owned(),
                    data_kind: fullmag_authoring::StudyPortDataKind::State,
                },
                fullmag_authoring::StudyOutputPort {
                    port_id: "total_energy".to_owned(),
                    data_kind: fullmag_authoring::StudyPortDataKind::Scalar,
                },
            ];
        }
    }
}

fn bounded_gpu_scope(problem: &fullmag_ir::ProblemIR) -> bool {
    match &problem.study {
        fullmag_ir::StudyIR::TimeEvolution { .. }
        | fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
            ..
        } => true,
        fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            ..
        } => bounded_gpu_relaxation_algorithm(
            problem.backend_policy.requested_backend,
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
        ),
        _ => false,
    }
}

/// Accepted GPU direct-minimizer scope is deliberately narrower than the
/// runner support matrix: the first durable Workspace extension is the
/// explicit FEM native CUDA PG-BB lane.  FDM PG-BB and other direct minimizers
/// stay fail-closed until their own accepted receipt contract exists.
fn bounded_gpu_relaxation_algorithm(
    backend: fullmag_ir::BackendTarget,
    algorithm: fullmag_ir::RelaxationAlgorithmIR,
) -> bool {
    backend == fullmag_ir::BackendTarget::Fem
        && matches!(
            algorithm,
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
        )
}

fn minimum_resource_budget(
    problem: &fullmag_ir::ProblemIR,
    requested_device: &str,
    profile_requests_gpu: bool,
) -> Result<fullmag_application::RequestedResourceBudget, ApiError> {
    let resources = fullmag_ir::ComputeResourcesIR::from_problem(problem)
        .map_err(|error| ApiError::unprocessable(format!("invalid compute resources: {error}")))?;
    let cpu_threads = resources
        .as_ref()
        .map(|resources| match resources.parallelism {
            fullmag_ir::ComputeParallelismIR::SingleProcess => {
                resources.cpu.threads.count().map(u64::from).unwrap_or(1)
            }
            fullmag_ir::ComputeParallelismIR::Distributed {
                ranks,
                threads_per_rank,
                ..
            } => u64::from(ranks)
                .checked_mul(u64::from(threads_per_rank))
                .unwrap_or(1),
        })
        .unwrap_or(1);
    let cpu_millis = cpu_threads.checked_mul(1_000).ok_or_else(|| {
        ApiError::unprocessable("compute resources exceed the accepted CPU budget range")
    })?;
    let memory_bytes = resources
        .as_ref()
        .and_then(|resources| resources.ram.reservation_bytes)
        .unwrap_or(1);
    let storage_bytes = resources
        .as_ref()
        .and_then(|resources| resources.scratch.reservation_bytes)
        .unwrap_or(1);
    let authored_gpu_memory = resources
        .as_ref()
        .and_then(|resources| resources.gpu.as_ref())
        .and_then(|gpu| gpu.vram_per_device_bytes)
        .unwrap_or(0);
    let gpu_memory_bytes = authored_gpu_memory.max(
        (requested_device == "gpu" || profile_requests_gpu)
            .then_some(1)
            .unwrap_or(0),
    );
    Ok(fullmag_application::RequestedResourceBudget {
        cpu_millis,
        memory_bytes,
        gpu_memory_bytes,
        storage_bytes,
    })
}

fn max_resource_budget(
    left: fullmag_application::RequestedResourceBudget,
    right: fullmag_application::RequestedResourceBudget,
) -> fullmag_application::RequestedResourceBudget {
    fullmag_application::RequestedResourceBudget {
        cpu_millis: left.cpu_millis.max(right.cpu_millis),
        memory_bytes: left.memory_bytes.max(right.memory_bytes),
        gpu_memory_bytes: left.gpu_memory_bytes.max(right.gpu_memory_bytes),
        storage_bytes: left.storage_bytes.max(right.storage_bytes),
    }
}

pub(crate) fn docker_api_only_runtime() -> bool {
    std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG")
        .is_some_and(|value| !value.is_empty())
}

fn open_submit_store(
    store_root: &Path,
) -> Result<fullmag_session::SessionStore, ApiError> {
    let store = match std::fs::symlink_metadata(store_root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fullmag_session::SessionStore::open(store_root)
        }
        Ok(_) => fullmag_session::SessionStore::open_existing(store_root),
        Err(error) => {
            return Err(ApiError::with_status_and_code(
                StatusCode::SERVICE_UNAVAILABLE,
                "accepted_execution_store_unavailable",
                format!("failed to inspect durable accepted execution store: {error}"),
            ));
        }
    };
    store.map_err(|error| {
        ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "accepted_execution_store_unavailable",
            format!("failed to open durable accepted execution store: {error}"),
        )
    })
}

/// Release is an idempotent durable gate operation: the first successful
/// publication is retained and later calls replay its original grant.  Retry
/// only the typed native writer collision around this exact operation; no
/// RunIntent, preparation, or solver work is repeated here.
fn retry_accepted_start_writer_operation<T>(
    operation: impl FnMut() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    fullmag_runtime_control::retry_store_writer_busy(operation)
}

fn exact_catalog_profile(
    catalog: &fullmag_session::execution_profiles::ExecutionProfileCatalog,
    reference: &fullmag_ir::ExecutionProfileIR,
) -> Result<fullmag_session::execution_profiles::ExecutionProfileCatalogEntry, ApiError> {
    let expected_sha256 = reference.canonical_sha256()
        .map_err(|error| profile_catalog_error(error.to_string()))?;
    let entry = catalog
        .entries
        .iter()
        .find(|entry| {
            entry.profile.profile_id == reference.profile_id
                && entry.profile.version == reference.version
        })
        .cloned()
        .ok_or_else(|| {
            ApiError::conflict_with_code(
                "execution_profile_reference_conflict",
                format!(
                    "published execution profile `{}/{}` is not present in the immutable catalogue",
                    reference.profile_id, reference.version
                ),
            )
        })?;
    if entry.profile_sha256 != expected_sha256 || entry.profile != *reference {
        return Err(ApiError::conflict_with_code(
            "execution_profile_hash_conflict",
            "authored live execution profile differs from its immutable catalogue entry",
        ));
    }
    Ok(entry)
}

fn ensure_migrated_profile_published(
    store: &fullmag_session::SessionStore,
    catalog: &fullmag_session::execution_profiles::ExecutionProfileCatalog,
    profile: &fullmag_ir::ExecutionProfileIR,
) -> Result<fullmag_session::execution_profiles::ExecutionProfileCatalogEntry, ApiError> {
    let expected_sha256 = profile
        .canonical_sha256()
        .map_err(|error| profile_catalog_error(error.to_string()))?;
    if let Some(existing) = catalog.entries.iter().find(|entry| {
        entry.profile.profile_id == profile.profile_id && entry.profile.version == profile.version
    }) {
        if existing.profile_sha256 == expected_sha256 && existing.profile == *profile {
            return Ok(existing.clone());
        }
        return Err(ApiError::conflict_with_code(
            "execution_profile_hash_conflict",
            format!(
                "canonical legacy profile `{}/{}` conflicts with the published catalogue hash",
                profile.profile_id, profile.version
            ),
        ));
    }

    const LEGACY_LIVE_PROFILE_INTENT: &str = "live-legacy-execution-default";
    // The scheduler and workers share the store writer. Hold one (re-entrant)
    // writer lease for read-check-publish so a busy writer is retried instead
    // of failing the command, and the catalogue revision cannot move between
    // the lookup and the publication.
    let _publication_lease =
        fullmag_runtime_control::retry_store_writer_busy(|| store.write_transaction())
            .map_err(|error| profile_catalog_error(format!("{error:#}")))?;
    let catalog = store
        .read_execution_profile_catalog()
        .map_err(|error| profile_catalog_error(error.to_string()))?;
    if let Some(existing) = catalog.entries.iter().find(|entry| {
        entry.profile.profile_id == profile.profile_id && entry.profile.version == profile.version
    }) {
        if existing.profile_sha256 == expected_sha256 && existing.profile == *profile {
            return Ok(existing.clone());
        }
        return Err(ApiError::conflict_with_code(
            "execution_profile_hash_conflict",
            format!(
                "canonical legacy profile `{}/{}` conflicts with the published catalogue hash",
                profile.profile_id, profile.version
            ),
        ));
    }
    let publication = store.publish_execution_profile(
        catalog.revision,
        LEGACY_LIVE_PROFILE_INTENT,
        profile.clone(),
    );
    let refreshed = store
        .read_execution_profile_catalog()
        .map_err(|error| profile_catalog_error(error.to_string()))?;
    let entry = refreshed.entries.iter().find(|entry| {
        entry.profile.profile_id == profile.profile_id && entry.profile.version == profile.version
    });
    match (publication, entry) {
        (_, Some(entry))
            if entry.profile_sha256 == expected_sha256 && entry.profile == *profile =>
        {
            Ok(entry.clone())
        }
        (Err(error), _) => Err(ApiError::conflict_with_code(
            "execution_profile_publication_conflict",
            format!("canonical legacy execution profile publication raced: {error}"),
        )),
        (Ok(_), _) => Err(ApiError::conflict_with_code(
            "execution_profile_hash_conflict",
            "canonical legacy execution profile publication did not produce the expected immutable catalogue entry",
        )),
    }
}

fn profile_catalog_error(message: String) -> ApiError {
    ApiError::conflict_with_code(
        "execution_profile_catalog_invalid",
        format!("published execution profile catalogue cannot be used: {message}"),
    )
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        accepted_frontier_preparation_is_ready, apply_docker_output_storage_binding,
        apply_live_accepted_observation_output_defaults,
        apply_resolved_docker_output_storage_binding, bounded_gpu_relaxation_algorithm,
        bounded_recovery_error,
        request_accepted_stop_for_catalog, validate_scene_revision_and_content,
        AcceptedLiveStudyExecution, AcceptedLiveStudyPreparationError, MAX_RECOVERY_ERROR_CHARS,
    };

    fn ui_source_scene() -> fullmag_authoring::SceneDocument {
        serde_json::from_value(serde_json::json!({
            "version": "scene.v2", "revision": 23,
            "scene": {"name": "generated_source_contract"},
            "objects": [{
                "id": "waveguide", "name": "waveguide", "role": "magnet",
                "geometry": {"geometry_kind": "Box",
                    "geometry_params": {"size": [100e-9, 40e-9, 10e-9]}},
                "material_ref": "permalloy", "magnetization_ref": "uniform"
            }],
            "materials": [{"id": "permalloy", "name": "Permalloy",
                "properties": {"Ms": 800e3, "Aex": 13e-12, "alpha": 0.02}}],
            "magnetization_assets": [{"id": "uniform", "name": "Uniform",
                "kind": "preset_texture", "preset_kind": "uniform",
                "preset_params": {"direction": [1.0, 0.0, 0.0]}, "preset_version": 1}],
            "study": {"backend": "fdm", "requested_backend": "fdm",
                "requested_device": "cpu", "requested_precision": "double",
                "fdm": {"default_cell": [10e-9, 10e-9, 10e-9]}}
        })).unwrap()
    }

    #[test]
    fn generated_source_projection_keeps_revision_out_of_physics_without_weakening_commit_fence() {
        let authored = ui_source_scene();
        let mut captured = authored.clone();
        captured.revision = 1;
        super::validate_generated_scene_round_trip(&authored, &captured).unwrap();
        let error = validate_scene_revision_and_content(
            authored.revision, captured.revision,
            &serde_json::to_value(&authored).unwrap(), &serde_json::to_value(&captured).unwrap(),
        ).unwrap_err();
        assert_eq!(error.message, "startup_scene_revision_or_content_changed");
    }

    #[test]
    fn generated_source_projection_rejects_changed_physics_and_immutable_object_identity() {
        let authored = ui_source_scene();
        let mut changed = serde_json::to_value(&authored).unwrap();
        changed["materials"][0]["properties"]["Ms"] = serde_json::json!(700e3);
        let changed = serde_json::from_value(changed).unwrap();
        assert!(super::validate_generated_scene_round_trip(&authored, &changed).is_err());
        let mut changed = authored.clone();
        changed.objects[0].id = "foreign-object".into();
        assert!(super::validate_generated_scene_round_trip(&authored, &changed).is_err());
    }

    fn live_step(
        step_id: &str,
        enabled: bool,
        kind: fullmag_authoring::StudyStepKind,
        outputs: Vec<fullmag_authoring::StudyOutputPort>,
    ) -> fullmag_authoring::StudyStep {
        fullmag_authoring::StudyStep {
            step_id: step_id.to_owned(),
            label: step_id.to_owned(),
            enabled,
            notes: None,
            source: None,
            kind,
            model: fullmag_authoring::StudyModelReference {
                model_id: "model:test".into(),
                version: "1".into(),
            },
            solver_config: fullmag_authoring::StudySolverConfigReference {
                preset_id: "solver:test".into(),
                version: "1".into(),
            },
            discretization: fullmag_authoring::StudyDiscretizationReference {
                recipe_id: "mesh:test".into(),
                version: "1".into(),
            },
            execution_profile: fullmag_authoring::StudyExecutionProfileReference {
                profile_id: "profile:test".into(),
                version: "1".into(),
            },
            until_seconds: None,
            inputs: Vec::new(),
            completion_dependencies: Vec::new(),
            outputs,
            acceptance: fullmag_authoring::StudyAcceptancePolicy::Any,
            acquisition: fullmag_authoring::StudyAcquisitionPolicy::Exclusive,
            legacy_payload: None,
        }
    }

    fn default_observation_outputs() -> Vec<fullmag_authoring::StudyOutputPort> {
        vec![
            fullmag_authoring::StudyOutputPort {
                port_id: "final_state".into(),
                data_kind: fullmag_authoring::StudyPortDataKind::State,
            },
            fullmag_authoring::StudyOutputPort {
                port_id: "total_energy".into(),
                data_kind: fullmag_authoring::StudyPortDataKind::Scalar,
            },
        ]
    }

    #[test]
    fn live_accepted_observation_defaults_are_limited_to_enabled_empty_run_relax_steps() {
        use fullmag_authoring::{StudyPrimitiveStageKind as Stage, StudyStepKind as Kind};

        let explicit = vec![
            fullmag_authoring::StudyOutputPort {
                port_id: "authored-state".into(),
                data_kind: fullmag_authoring::StudyPortDataKind::State,
            },
            fullmag_authoring::StudyOutputPort {
                port_id: "authored-table".into(),
                data_kind: fullmag_authoring::StudyPortDataKind::Table,
            },
        ];
        let antenna = vec![fullmag_authoring::StudyOutputPort {
            port_id: "inspection".into(),
            data_kind: fullmag_authoring::StudyPortDataKind::Artifact,
        }];
        let mut study = fullmag_authoring::StudyPlan {
            schema_version: "study_plan.v2".into(),
            study_id: "study:test".into(),
            revision: 1,
            source_pipeline_version: None,
            steps: vec![
                live_step(
                    "run",
                    true,
                    Kind::Primitive {
                        stage_kind: Stage::Run,
                    },
                    Vec::new(),
                ),
                live_step(
                    "relax",
                    true,
                    Kind::Primitive {
                        stage_kind: Stage::Relax,
                    },
                    Vec::new(),
                ),
                live_step(
                    "disabled-run",
                    false,
                    Kind::Primitive {
                        stage_kind: Stage::Run,
                    },
                    Vec::new(),
                ),
                live_step(
                    "explicit-run",
                    true,
                    Kind::Primitive {
                        stage_kind: Stage::Run,
                    },
                    explicit.clone(),
                ),
                live_step(
                    "eigenmodes",
                    true,
                    Kind::Primitive {
                        stage_kind: Stage::Eigenmodes,
                    },
                    Vec::new(),
                ),
                live_step(
                    "antenna",
                    true,
                    Kind::Primitive {
                        stage_kind: Stage::AntennaFieldSolve,
                    },
                    antenna.clone(),
                ),
                live_step(
                    "empty-antenna",
                    true,
                    Kind::Primitive {
                        stage_kind: Stage::AntennaFieldSolve,
                    },
                    Vec::new(),
                ),
                live_step(
                    "macro",
                    true,
                    Kind::Macro {
                        macro_kind: fullmag_authoring::StudyMacroStageKind::RelaxRun,
                    },
                    Vec::new(),
                ),
                live_step(
                    "group",
                    true,
                    Kind::Group {
                        child_step_ids: Vec::new(),
                    },
                    Vec::new(),
                ),
                live_step(
                    "unsupported",
                    true,
                    Kind::Unsupported {
                        unsupported_kind: "future_step".into(),
                        payload: serde_json::json!({}),
                    },
                    Vec::new(),
                ),
            ],
        };

        apply_live_accepted_observation_output_defaults(&mut study);

        assert_eq!(study.steps[0].outputs, default_observation_outputs());
        assert_eq!(study.steps[1].outputs, default_observation_outputs());
        assert!(study.steps[2].outputs.is_empty());
        assert_eq!(study.steps[3].outputs, explicit);
        assert!(study.steps[4].outputs.is_empty());
        assert_eq!(study.steps[5].outputs, antenna);
        assert!(study.steps[6].outputs.is_empty());
        assert!(study.steps[7].outputs.is_empty());
        assert!(study.steps[8].outputs.is_empty());
        assert!(study.steps[9].outputs.is_empty());
    }

    #[test]
    fn startup_commit_guard_rejects_changed_scene_revision() {
        let scene = serde_json::json!({"scene": "same"});
        let error = validate_scene_revision_and_content(8, 9, &scene, &scene).unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(error.message, "startup_scene_revision_or_content_changed");
    }

    #[test]
    fn startup_commit_guard_rejects_changed_scene_content_at_same_revision() {
        let current = serde_json::json!({"scene": "old"});
        let prepared = serde_json::json!({"scene": "new"});
        let error = validate_scene_revision_and_content(9, 9, &current, &prepared).unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(error.message, "startup_scene_revision_or_content_changed");
    }

    #[test]
    fn docker_output_binding_skips_managed_ui_source_outside_container_prefix() {
        let mut inputs = Vec::new();
        let scene = fullmag_authoring::SceneDocument::default();
        apply_docker_output_storage_binding(
            &mut inputs,
            &scene,
            Some(Path::new("/workspace/ui/scene.py")),
        )
        .expect("managed UI sources must retain their existing output policy");
    }

    #[test]
    fn docker_output_binding_applies_resolved_policy_to_each_study_step() {
        let output_storage = fullmag_ir::OutputStorageIR {
            output_dir: Some("/opt/fullmag/script-output/authored_filename.zarr".into()),
            temp_dir: Some("/opt/fullmag/script-output/.fullmag-tmp".into()),
            ..Default::default()
        };
        let binding = serde_json::json!({
            "source_dir": "/opt/fullmag/script-output",
            "output_storage": serde_json::to_value(output_storage).unwrap(),
        });
        let mut inputs = vec![
            fullmag_application::StudyStepExecutionInput {
                step_id: "step-a".into(),
                problem: fullmag_ir::ProblemIR::bootstrap_example(),
                layers: Vec::new(),
            },
            fullmag_application::StudyStepExecutionInput {
                step_id: "step-b".into(),
                problem: fullmag_ir::ProblemIR::bootstrap_example(),
                layers: Vec::new(),
            },
        ];
        inputs[0].problem.problem_meta.runtime_metadata.insert(
            "model_builder".into(),
            serde_json::json!({"problem": {"runtime": {}}}),
        );

        apply_resolved_docker_output_storage_binding(
            &mut inputs,
            &binding,
            Path::new("/opt/fullmag/source/examples/authored_filename.py"),
        )
        .expect("resolved Docker output policy should bind to every study step");

        for input in &inputs {
            let metadata = &input.problem.problem_meta.runtime_metadata;
            assert_eq!(
                metadata["output_storage"]["output_dir"],
                "/opt/fullmag/script-output/authored_filename.zarr"
            );
            assert_eq!(
                metadata["output_storage"]["temp_dir"],
                "/opt/fullmag/script-output/.fullmag-tmp"
            );
            assert_eq!(
                metadata["output_storage_source_dir"],
                "/opt/fullmag/script-output"
            );
            assert_eq!(metadata["output_storage_source_stem"], "authored_filename");
        }
        assert_eq!(
            inputs[0].problem.problem_meta.runtime_metadata["model_builder"]["problem"]
                ["runtime"]["output_storage"]["output_dir"],
            "/opt/fullmag/script-output/authored_filename.zarr"
        );
    }

    #[test]
    fn accepted_gpu_scope_allows_only_explicit_fem_projected_gradient_bb() {
        use fullmag_ir::{BackendTarget, RelaxationAlgorithmIR};

        assert!(bounded_gpu_relaxation_algorithm(
            BackendTarget::Fem,
            RelaxationAlgorithmIR::ProjectedGradientBb
        ));
        assert!(!bounded_gpu_relaxation_algorithm(
            BackendTarget::Fdm,
            RelaxationAlgorithmIR::ProjectedGradientBb
        ));
        assert!(!bounded_gpu_relaxation_algorithm(
            BackendTarget::Fem,
            RelaxationAlgorithmIR::NonlinearCg
        ));
        assert!(!bounded_gpu_relaxation_algorithm(
            BackendTarget::Fem,
            RelaxationAlgorithmIR::TangentPlaneImplicit
        ));
    }

    fn queued_task(task_id: &str) -> fullmag_session::FmsTaskCatalogEntry {
        fullmag_session::FmsTaskCatalogEntry {
            task_id: task_id.into(),
            input_fingerprint: "a".repeat(64),
            lifecycle: fullmag_session::FmsTaskLifecycle::Queued,
            readiness: fullmag_session::FmsTaskReadiness::Ready,
            observation: None,
            attempt_id: None,
            ownership_epoch: None,
            resolved_input_fingerprint: None,
            artifact_ids: Vec::new(),
            resource_id: None,
            coordinator_watermark: None,
            coordinator_genesis: None,
        }
    }

    #[test]
    fn accepted_start_release_binding_is_portable_scoped_and_gate_usable() {
        let run_id = "run-held-portable";
        let public_request_ids = ["run:gpu", "CON", "request.", "request.with.dots"];
        assert!(fullmag_session::repository_path::validate_store_id("run:gpu").is_err());
        assert!(fullmag_session::repository_path::validate_store_id("CON").is_err());
        assert!(fullmag_session::repository_path::validate_store_id("request.").is_err());
        assert!(fullmag_session::repository_path::validate_store_id("request.with.dots").is_ok());
        let bindings = public_request_ids
            .iter()
            .map(|public_request_id| {
                let binding = super::accepted_start_release_request_id(run_id, public_request_id);
                fullmag_session::repository_path::validate_store_id(&binding)
                    .expect("private gate binding must be a portable store id");
                assert_ne!(binding, *public_request_id);
                binding
            })
            .collect::<Vec<_>>();
        assert_ne!(bindings[0], bindings[1]);
        assert_ne!(bindings[1], bindings[2]);
        assert_ne!(bindings[2], bindings[3]);
        assert_eq!(
            bindings[0],
            super::accepted_start_release_request_id(run_id, public_request_ids[0])
        );
        assert_ne!(
            bindings[0],
            super::accepted_start_release_request_id("run-other", public_request_ids[0])
        );

        let directory = tempfile::tempdir().expect("temporary accepted store");
        let store = fullmag_session::SessionStore::open(directory.path()).expect("accepted store");
        let intent = fullmag_session::FmsRunIntent::new(
            run_id,
            "intent-held-portable",
            serde_json::json!({
                "run_id": run_id,
                "parameters": {
                    (fullmag_session::ACCEPTED_RUN_START_POLICY_KEY): {
                        "schema_version": "accepted_run_start_policy.v1",
                        "mode": "manual"
                    }
                }
            }),
        );
        store.commit_run_intent(&intent).expect("accepted intent");
        assert!(!store
            .accepted_run_start_permitted(run_id)
            .expect("held gate read"));
        let release = store
            .release_accepted_run_start(run_id, &intent.payload_sha256, &bindings[0])
            .expect("portable binding releases the accepted gate");
        assert_eq!(release.request_id, bindings[0]);
        let replay = store
            .release_accepted_run_start(run_id, &intent.payload_sha256, &bindings[2])
            .expect("replayed portable binding");
        assert_eq!(replay, release);
        assert!(store
            .accepted_run_start_permitted(run_id)
            .expect("gate read"));
    }

    #[test]
    fn accepted_start_release_retries_real_native_writer_contention() {
        let directory = tempfile::tempdir().expect("temporary accepted store");
        let store_root = directory.path().join("store");
        let store = fullmag_session::SessionStore::open(&store_root).expect("accepted store");
        let run_id = "run-held-retry";
        let intent = fullmag_session::FmsRunIntent::new(
            run_id,
            "intent-held-retry",
            serde_json::json!({
                "run_id": run_id,
                "parameters": {
                    (fullmag_session::ACCEPTED_RUN_START_POLICY_KEY): {
                        "schema_version": "accepted_run_start_policy.v1",
                        "mode": "manual"
                    }
                }
            }),
        );
        store.commit_run_intent(&intent).expect("accepted intent");

        // Separate SessionStore handles do not share the in-process Writer;
        // this therefore exercises the same native WRITER.lock conflict that
        // the API sees when a runtime-control process is publishing.
        let holder_store = fullmag_session::SessionStore::open_existing(&store_root)
            .expect("holder store");
        let probe_store = fullmag_session::SessionStore::open_existing(&store_root)
            .expect("probe store");
        let mut held = Some(holder_store.write_transaction().expect("held writer"));
        let mut first_attempt = true;
        let release = super::retry_accepted_start_writer_operation(|| {
            let result = probe_store.release_accepted_run_start(
                run_id,
                &intent.payload_sha256,
                "compute-retry",
            );
            if first_attempt {
                first_attempt = false;
                let native_busy = result.as_ref().err().is_some_and(|error| {
                    error
                        .chain()
                        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
                });
                assert!(native_busy, "first release must observe native writer contention");
                drop(held.take());
            }
            result
        })
        .expect("bounded retry must release the accepted gate after the writer drops");

        assert!(!first_attempt, "the test must exercise the initial busy attempt");
        assert_eq!(release.run_id, run_id);
        assert!(probe_store
            .accepted_run_start_permitted(run_id)
            .expect("released gate read"));
    }

    #[test]
    fn accepted_recovery_preserves_identity_and_bounds_detail() {
        let original = "x".repeat(MAX_RECOVERY_ERROR_CHARS + 32);
        let bounded = bounded_recovery_error(original);
        assert_eq!(bounded.chars().count(), MAX_RECOVERY_ERROR_CHARS + 3);
        assert!(bounded.ends_with("..."));

        let accepted = AcceptedLiveStudyExecution {
            run_id: "run-accepted-recovery".to_string(),
            step_ids: vec!["step-0".to_string(), "step-1".to_string()],
            preparation_error: Some(AcceptedLiveStudyPreparationError {
                code: "accepted_run_catalog_failed".to_string(),
                message: bounded,
            }),
        };
        assert_eq!(accepted.run_id, "run-accepted-recovery");
        assert_eq!(accepted.step_ids, ["step-0", "step-1"]);
        assert_eq!(
            accepted.preparation_error.as_ref().map(|error| error.code.as_str()),
            Some("accepted_run_catalog_failed")
        );
    }

    #[test]
    fn held_compute_gate_requires_current_run_bound_ready_frontier() {
        let preparation: crate::types::SimulationPreparationSnapshot =
            serde_json::from_value(serde_json::json!({
                "preparation_id": "prep-1",
                "revision": 1,
                "status": "ready",
                "active_stage_id": null,
                "started_at_unix_ms": 1,
                "completed_at_unix_ms": 2,
                "stages": [{
                    "id": "startup",
                    "label": "Prepare model and mesh",
                    "detail": "accepted task preparation receipt committed",
                    "status": "completed",
                    "started_at_unix_ms": 1,
                    "completed_at_unix_ms": 2,
                    "duration_ms": 1,
                    "clock_adjustment": null,
                    "progress_percent": 100,
                    "progress_label": "ready"
                }],
                "log_tail": [],
                "failure": null
            }))
            .expect("preparation fixture");
        let workspace = serde_json::json!({
            "status": "completed",
            "accepted_run_id": "run-1",
            "accepted_step_id": "step-1",
            "preparation_id": "prep-1",
            "plan_fingerprint": format!("sha256:{}", "a".repeat(64))
        });
        assert!(accepted_frontier_preparation_is_ready(
            Some(&preparation),
            Some(&workspace),
            "run-1"
        ));

        let mut wrong_run = workspace.clone();
        wrong_run["accepted_run_id"] = serde_json::json!("run-2");
        assert!(!accepted_frontier_preparation_is_ready(
            Some(&preparation),
            Some(&wrong_run),
            "run-1"
        ));

        let mut pending = preparation.clone();
        pending.status = "running".into();
        assert!(!accepted_frontier_preparation_is_ready(
            Some(&pending),
            Some(&workspace),
            "run-1"
        ));

        let mut mismatched_preparation = workspace.clone();
        mismatched_preparation["preparation_id"] = serde_json::json!("prep-other");
        assert!(!accepted_frontier_preparation_is_ready(
            Some(&preparation),
            Some(&mismatched_preparation),
            "run-1"
        ));

        let mut invalid_fingerprint = workspace;
        invalid_fingerprint["plan_fingerprint"] = serde_json::json!("a".repeat(64));
        assert!(!accepted_frontier_preparation_is_ready(
            Some(&preparation),
            Some(&invalid_fingerprint),
            "run-1"
        ));
    }

    #[test]
    fn authored_profile_requires_exact_published_content_not_only_reference() {
        use fullmag_session::execution_profiles::{ExecutionProfileCatalog, ExecutionProfileCatalogEntry};
        let profile = fullmag_application::legacy_live_execution_profile();
        let entry = ExecutionProfileCatalogEntry {
            profile_sha256: profile.canonical_sha256().unwrap(),
            profile: profile.clone(),
            client_intent_id: "publish-profile".into(),
            published_at: "2026-10-15T00:00:00Z".into(),
            revision: 1,
        };
        let catalog = ExecutionProfileCatalog {
            revision: 1,
            entries: vec![entry.clone()],
            ..ExecutionProfileCatalog::default()
        };
        assert_eq!(super::exact_catalog_profile(&catalog, &profile).unwrap(), entry);
        let mut changed = profile;
        changed.description = "different authored profile at the same version".into();
        let error = super::exact_catalog_profile(&catalog, &changed).unwrap_err();
        assert_eq!(error.code.as_deref(), Some("execution_profile_hash_conflict"));
    }

    #[test]
    fn stop_advances_catalog_revision_between_two_queued_study_stages() {
        let directory = tempfile::tempdir().expect("temporary accepted store");
        let store = fullmag_session::SessionStore::open(directory.path().join("store"))
            .expect("accepted store");
        let run_id = "run-stop-two-stages";
        store
            .commit_run_catalog(&fullmag_session::FmsRunCatalog {
                schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![queued_task("task-stop-first"), queued_task("task-stop-second")],
            })
            .expect("two-stage catalog");

        let affected = request_accepted_stop_for_catalog(
            &store,
            run_id,
            "command-stop-two-stages",
            "operator requested cancellation",
            store
                .read_run_catalog(run_id)
                .expect("catalog read")
                .expect("catalog exists"),
        )
        .expect("stop should record both immutable intents");

        assert_eq!(
            affected,
            vec!["task-stop-first".to_string(), "task-stop-second".to_string()]
        );
        assert_eq!(
            store
                .read_task_cancellation_intent(run_id, "task-stop-first")
                .expect("first intent read")
                .expect("first intent")
                .expected_catalog_revision,
            1
        );
        assert_eq!(
            store
                .read_task_cancellation_intent(run_id, "task-stop-second")
                .expect("second intent read")
                .expect("second intent")
                .expected_catalog_revision,
            2
        );
        assert_eq!(
            store
                .read_run_catalog(run_id)
                .expect("catalog reread")
                .expect("catalog exists")
                .revision,
            3
        );

        let replayed = request_accepted_stop_for_catalog(
            &store,
            run_id,
            "command-stop-two-stages",
            "operator requested cancellation",
            store
                .read_run_catalog(run_id)
                .expect("catalog replay read")
                .expect("catalog exists for replay"),
        )
        .expect("same Stop must replay immutable intents");
        assert_eq!(replayed, affected);
        assert_eq!(
            store
                .read_run_catalog(run_id)
                .expect("catalog replay reread")
                .expect("catalog exists after replay")
                .revision,
            3
        );
    }
}

/// Compare the existing canonical public export projection. Scene revision,
/// editor state and Results authoring remain protected by the full scene fence;
/// they are not regenerated physical script semantics.
fn validate_generated_scene_round_trip(
    authored: &fullmag_authoring::SceneDocument,
    captured: &fullmag_authoring::SceneDocument,
) -> Result<(), ApiError> {
    let mut authored = authored.clone();
    let mut captured = captured.clone();
    fullmag_authoring::normalize_scene_document_magnetization_assets(&mut authored);
    fullmag_authoring::normalize_scene_document_magnetization_assets(&mut captured);
    let project = |scene: &fullmag_authoring::SceneDocument| {
        fullmag_authoring::scene_document_to_script_builder_overrides(scene)
            .map_err(|error| ApiError::unprocessable_with_code(
                "accepted_ui_scene_projection_invalid", error.message,
            ))
    };
    if !script_projection_values_equal(&project(&authored)?, &project(&captured)?) {
        return Err(ApiError::conflict_with_code(
            "accepted_ui_scene_round_trip_changed",
            "canonical Python capture does not reproduce the UI scene export projection",
        ));
    }
    Ok(())
}


/// Compare JSON script semantics without conflating a number's value with its
/// integer/float spelling. Source and artifact byte hashes remain exact.
fn script_projection_values_equal(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    use serde_json::Value;
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            if left == right {
                return true;
            }
            let (integer, floating) = if left.is_f64() && !right.is_f64() {
                (right, left)
            } else if right.is_f64() && !left.is_f64() {
                (left, right)
            } else {
                return false;
            };
            let integer = integer.as_i64().map(i128::from)
                .or_else(|| integer.as_u64().map(i128::from));
            let Some(integer) = integer else { return false; };
            let Some(floating) = floating.as_f64() else { return false; };
            // The exclusive upper bound is 2^64, not a saturating u64 cast.
            // Compare the exact integer represented by the float; converting
            // both operands to f64 would merge distinct integers above 2^53.
            floating.fract() == 0.0
                && (i64::MIN as f64..u64::MAX as f64).contains(&floating)
                && floating as i128 == integer
        }
        (Value::Array(left), Value::Array(right)) => left.len() == right.len()
            && left.iter().zip(right).all(|(left, right)| script_projection_values_equal(left, right)),
        (Value::Object(left), Value::Object(right)) => left.len() == right.len()
            && left.iter().all(|(key, value)| right.get(key)
                .is_some_and(|other| script_projection_values_equal(value, other))),
        _ => left == right,
    }
}

#[cfg(test)]
mod script_projection_comparison_tests {
    use super::script_projection_values_equal;
    use serde_json::{json, Value};

    #[test]
    fn browser_integer_spelling_preserves_nested_python_geometry_values() {
        let browser = json!({"geometry_params": {"conductivity_s_per_m": 58000000,
            "stations": [{"s": 0}, {"s": 1}], "transform": [[1, 0], [0, 1]]}});
        let python = json!({"geometry_params": {"conductivity_s_per_m": 58000000.0,
            "stations": [{"s": 0.0}, {"s": 1.0}], "transform": [[1.0, 0.0], [0.0, 1.0]]}});
        assert_ne!(browser, python);
        assert!(script_projection_values_equal(&browser, &python));
        assert!(script_projection_values_equal(&python, &browser));
    }

    #[test]
    fn changed_values_types_structure_and_array_order_remain_rejected() {
        for (left, right) in [
            (json!(58000000), json!(58000001.0)),
            (json!(0), json!(0.25)),
            (json!(1), json!(true)),
            (json!(1), json!("1")),
            (json!({"a": null}), json!({})),
            (json!([0, 1]), json!([1.0, 0.0])),
            (json!([0]), json!([0.0, 0.0])),
        ] {
            assert!(!script_projection_values_equal(&left, &right));
            assert!(!script_projection_values_equal(&right, &left));
        }
    }

    #[test]
    fn integer_float_comparison_is_lossless_at_f64_and_integer_boundaries() {
        for (integer, floating, equal) in [
            (json!(9007199254740992u64), json!(9007199254740992.0), true),
            (json!(9007199254740993u64), json!(9007199254740992.0), false),
            (json!(i64::MIN), json!(-9223372036854775808.0), true),
            (json!(i64::MAX), json!(9223372036854775808.0), false),
            (json!(u64::MAX), json!(18446744073709551616.0), false),
            (json!(u64::MAX - 2047), json!(18446744073709549568.0), true),
            (json!(0), json!(-0.0), true),
        ] {
            assert_eq!(script_projection_values_equal(&integer, &floating), equal);
            assert_eq!(script_projection_values_equal(&floating, &integer), equal);
        }
        let small: Value = serde_json::from_str("1e-300").unwrap();
        assert!(!script_projection_values_equal(&json!(0), &small));
    }
}

fn has_closed_loop_inspection_pipeline(scene: &fullmag_authoring::SceneDocument) -> bool {
    fn enabled_closed_antenna(scene: &fullmag_authoring::SceneDocument,
        nodes: &[fullmag_authoring::StudyPipelineNode]) -> bool {
        nodes.iter().any(|node| match node {
            fullmag_authoring::StudyPipelineNode::Primitive(node) if node.enabled
                && node.stage_kind == fullmag_authoring::StudyPrimitiveStageKind::AntennaFieldSolve => {
                node.payload.get("stage_id").and_then(serde_json::Value::as_str).is_some_and(|id|
                    scene.antenna_field_solve_stages.iter().find(|stage| stage.id == id).is_some_and(|stage|
                        scene.current_transports.iter().any(|module| module.known().is_some_and(|module|
                            module.name == stage.current_transport_id
                                && matches!(&module.structured_current_closure,
                                    Some(fullmag_authoring::SceneStructuredCurrentClosure::ClosedGeometry { schema_version, .. })
                                        if schema_version == "structured_current_closure.v2")))))
            }
            fullmag_authoring::StudyPipelineNode::Group(node) => node.enabled && enabled_closed_antenna(scene, &node.children),
            _ => false,
        })
    }
    scene.study.study_pipeline.as_ref().is_some_and(|pipeline| enabled_closed_antenna(scene, &pipeline.nodes))
}

async fn next_solver_profile_admission_config(state: &Arc<crate::types::AppState>,
    context: &crate::types::CurrentLiveRequestContext,
) -> Result<Option<fullmag_runner::SolverProfileConfig>, crate::error::ApiError> {
    let fallback_config = {
        let guard = state.current_live_state.read().await;
        let snapshot = guard.as_ref().ok_or_else(|| crate::error::ApiError::not_found("no current workspace"))?;
        crate::ensure_current_live_request_context(snapshot, context,
            state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire))?;
        snapshot.solver_profile.config.clone()
    };
    // The journal is recovered only for this exact session identity. Read its
    // last completed configuration so a crash after the durable ACK cannot
    // silently lose the requested next-admission diagnostics.
    let configured = {
        let ledger = state.current_command_ledger.lock().await;
        ledger.iter().rev().find(|record| record.command.kind == "set_solver_profile"
            && record.status == crate::types::CommandLifecycleState::Completed)
            .and_then(|record| record.command.profile.clone())
    };
    // No live-state lock is held while awaiting the ledger. Refuse a session
    // replacement that happened while waiting rather than borrowing its config.
    crate::validate_current_live_request_context(state, context).await?;
    let value = if let Some(value) = configured {
        value
    } else {
        if !fallback_config.enabled { return Ok(None); }
        serde_json::to_value(&fallback_config)
            .map_err(|error| crate::error::ApiError::internal(error.to_string()))?
    };
    let configuration: fullmag_runner::SolverProfileConfig = serde_json::from_value(value)
        .map_err(|error| crate::error::ApiError::internal(error.to_string()))?;
    if !configuration.enabled { return Ok(None); }
    let value = crate::accepted_solver_profile::parameter(configuration).map_err(|error| crate::error::ApiError::unprocessable(error.to_string()))?;
    let mut parameters = serde_json::Map::new();
    parameters.insert(crate::accepted_solver_profile::PARAMETER.into(), value);
    crate::accepted_solver_profile::config(&serde_json::Value::Object(parameters)).map_err(|error| crate::error::ApiError::unprocessable(error.to_string()))
}
