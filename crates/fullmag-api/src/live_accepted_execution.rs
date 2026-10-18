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
use serde_json::json;

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
    },
    Startup {
        request_id: String,
        source_sha256: String,
        auto_run: bool,
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
    let scene = {
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
        snapshot.scene_document.clone()
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
    if matches!(command.kind.as_str(), "run" | "relax" | "solve" | "resume")
        && current_live_run_waits_for_solve(state).await?
    {
        crate::router_v2::handlers::simulation::commands::validate_accepted_command_admission(
            state, context, command,
        )
        .await?;
        return release_waiting_live_study_with_transition(state, context, &command.command_id).await;
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

    let accepted = tokio::task::spawn_blocking(move || {
        materialize_live_accepted(
            &repo_root,
            &workspace_root,
            None,
            &store_root,
            backlog_limit,
            &api_instance_id,
            &captured_context,
            &scene,
            LiveAcceptedSubmission::Command {
                command,
                request_idempotency_key,
            },
        )
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted live execution task failed: {error}")))??;

    // The durable identity carries the captured API/session/epoch/scene and
    // command fence. Recheck the mutable current pointer before the caller
    // publishes the command journal/read model so a replaced workspace cannot
    // expose this accepted run as its own live execution.
    crate::validate_current_live_request_context(state, context).await?;

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
        let Some(run) = snapshot.run.as_ref() else {
            return Ok(None);
        };
        run.run_id.clone()
    };
    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "accepted_execution_store_unavailable",
            "durable accepted live execution storage is not configured",
        ));
    };
    let project_id = fullmag_application::ProjectId::parse(format!(
        "project-live-{}",
        fullmag_session::hex_sha256(
            format!("{}\0{}", state.request_scope_instance_id, context.session_id).as_bytes()
        )
    ))
    .map_err(|error| ApiError::internal(format!("live project identity is invalid: {error}")))?;
    let typed_run_id = fullmag_application::RunId::parse(run_id.clone())
        .map_err(|error| ApiError::internal(format!("live run identity is invalid: {error}")))?;
    let release_request_id = request_id.to_string();
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
        store
            .release_accepted_run_start(
                typed_run_id.as_str(),
                &intent.payload_sha256,
                &release_request_id,
            )
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
        let current_scene = snapshot
            .scene_document
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no scene document available for startup"))?;
        if current_scene.revision != scene.revision
            || serde_json::to_value(current_scene).ok() != serde_json::to_value(&scene).ok()
        {
            return Err(ApiError::conflict(
                "startup_scene_revision_or_content_changed",
            ));
        }
    }
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
    let accepted = tokio::task::spawn_blocking(move || {
        materialize_live_accepted(
            &repo_root,
            &workspace_root,
            asset_root.as_deref(),
            &store_root,
            backlog_limit,
            &api_instance_id,
            &captured_context,
            &scene,
            LiveAcceptedSubmission::Startup {
                request_id,
                source_sha256,
                auto_run,
            },
        )
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted startup execution task failed: {error}")))??;
    crate::validate_current_live_request_context(state, context).await?;
    Ok(accepted)
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
    let project_id = fullmag_application::ProjectId::parse(format!(
        "project-live-{}",
        fullmag_session::hex_sha256(
            format!("{}\0{}", state.request_scope_instance_id, context.session_id).as_bytes(),
        )
    ))
    .map_err(|error| ApiError::internal(format!("live project identity is invalid: {error}")))?;
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

/// Persist a Docker live Stop against the exact accepted run. Running or
/// preparing tasks use the durable worker Stop command; accepted/queued tasks
/// use the session cancellation-intent record. No command is put on the
/// legacy in-memory queue.
pub(crate) async fn submit_live_stop_with_transition(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    command_id: &str,
    reason: &str,
) -> Result<AcceptedLiveControlExecution, ApiError> {
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
            .ok_or_else(|| ApiError::conflict_with_code(
                "accepted_control_run_missing",
                "Docker Stop requires a durable accepted live run",
            ))?
    };
    let Some(store_root) = state.submit_store_root.clone() else {
        return Err(ApiError::with_status_and_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "accepted_execution_store_unavailable",
            "durable accepted live execution storage is not configured",
        ));
    };
    let run_id_for_worker = run_id.clone();
    let command_id = command_id.to_string();
    let reason = reason.trim().to_string();
    if reason.is_empty() {
        return Err(ApiError::bad_request("accepted Stop reason must not be empty"));
    }
    let affected_task_ids = tokio::task::spawn_blocking(move || {
        let store = open_submit_store(&store_root)?;
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

fn materialize_live_accepted(
    repo_root: &Path,
    workspace_root: &Path,
    asset_root: Option<&Path>,
    store_root: &Path,
    backlog_limit: NonZeroUsize,
    api_instance_id: &str,
    context: &CurrentLiveRequestContext,
    scene: &fullmag_authoring::SceneDocument,
    submission: LiveAcceptedSubmission,
) -> Result<AcceptedLiveStudyExecution, ApiError> {
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
                Some(selected_step_id)
            }
        }
        LiveAcceptedSubmission::Startup { .. } => None,
    };
    study.validate_for_execution().map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_study_plan_invalid",
            format!("authored live study is not executable: {error}"),
        )
    })?;

    let mut inputs = crate::script::scene_document_to_study_execution_inputs_with_asset_root(
        repo_root,
        workspace_root,
        asset_root,
        &effective_scene,
        &requested_execution,
        &study,
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
    let published_profile_entry = if let Some(migrated_profile) = migrated_profile.as_ref() {
        ensure_migrated_profile_published(&store, &profile_catalog, migrated_profile)?
    } else {
        exact_catalog_profile(&profile_catalog, &profile)?
    };
    let published_profile = published_profile_entry.profile.clone();
    let published_profile_sha256 = published_profile
        .canonical_sha256()
        .map_err(|error| profile_catalog_error(error.to_string()))?;
    if published_profile_entry.profile_sha256 != published_profile_sha256 {
        return Err(ApiError::conflict_with_code(
            "execution_profile_hash_conflict",
            format!(
                "published execution profile `{}/{}` has a catalogue hash that does not match its canonical content",
                published_profile.profile_id, published_profile.version
            ),
        ));
    }

    let catalog = fullmag_application::materialize_study_execution(
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
    })?;

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

    let scene_value = serde_json::to_value(&effective_scene).map_err(|error| {
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

    let mut parameters = json!({
        "live_workspace": {
            "api_instance_id": api_instance_id,
            "session_id": &context.session_id,
            "session_epoch": context.session_epoch,
            "scene_revision": effective_scene.revision,
            "command_id": &command_id,
            "request_idempotency_key": &request_idempotency_key,
            "step_id": selected_step_id,
            "command": &command_value,
            "startup_source_sha256": &startup_source_sha256,
        }
    });
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
    let intent = fullmag_application::materialize_run_intent(
        &definition,
        &study,
        &catalog,
        authored,
        &BTreeMap::new(),
    )
    .map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_run_intent_invalid",
            format!("typed live RunIntent materialization failed: {error:#}"),
        )
    })?;
    crate::run_intent_persistence::commit_validated_run_intent_with_backlog_limit(
        &store,
        &intent,
        &definition,
        &study,
        &catalog,
        &BTreeMap::new(),
        backlog_limit,
    )
    .map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_run_commit_failed",
            format!("durable accepted RunIntent commit failed: {error:#}"),
        )
    })?;

    crate::run_intent_persistence::materialize_accepted_run_catalog(
        &store,
        &run_id,
        &project_id,
    )
    .map_err(|error| {
        ApiError::unprocessable_with_code(
            "accepted_run_catalog_failed",
            format!("durable accepted run catalog materialization failed: {error:#}"),
        )
    })?;

    Ok(AcceptedLiveStudyExecution {
        run_id,
        step_ids,
    })
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
    use super::{bounded_gpu_relaxation_algorithm, request_accepted_stop_for_catalog};

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
