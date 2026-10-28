//! Project durable accepted Study output into the one current live workspace.
//!
//! Accepted workers own RunIntent, task leases, CAS publication, and the
//! immutable artifact catalogs.  This module is only a bounded read-model
//! projector for the Docker API-only lane: it never claims a task, starts a
//! solver, allocates a device, or writes a durable catalog.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use crate::error::ApiError;
use crate::types::{
    AppState, CurrentLiveFieldFrameRequest, CurrentLiveFieldGeneration, SessionStateResponse,
};
use fullmag_authoring::SceneExecutionInputIdentity;

const POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Ceiling for retrying one unchanged deferral. Each retry reloads the run's
/// durable outputs, which on a multi-million-cell grid kept a core busy and
/// the API's memory high for as long as the deferral lasted.
const MAX_DEFERRAL_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
struct ProjectionContext {
    session_id: String,
    run_id: String,
    session_epoch: u64,
    scene_revision: u64,
    execution_input: Option<SceneExecutionInputIdentity>,
    api_instance_id: String,
    allow_api_instance_rebind: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProjectionPublicationFence {
    session_id: String,
    session_status: String,
    run_id: String,
    run_status: String,
    scene_revision: u64,
    state_version: u64,
    scalar_revision: u64,
    solver_profile_revision: u64,
    mesh_revision: u64,
    mesh_build_revision: u64,
    field_catalog_revision: u64,
    field_samples_revision: u64,
    field_quantity_revisions: std::collections::BTreeMap<String, u64>,
    stage_execution_revision: u64,
    simulation_preparation_revision: u64,
    preparation_id: Option<String>,
    accepted_run_id: Option<String>,
    accepted_step_id: Option<String>,
}

impl ProjectionPublicationFence {
    pub(crate) fn capture(snapshot: &SessionStateResponse) -> Result<Self, ApiError> {
        let run = snapshot.run.as_ref().ok_or_else(|| {
            ApiError::conflict_with_code(
                "accepted_projection_current_run_changed",
                "current live run disappeared during accepted projection",
            )
        })?;
        let scene_revision = snapshot
            .scene_document
            .as_ref()
            .map(|scene| scene.revision)
            .ok_or_else(|| {
                ApiError::conflict_with_code(
                    "accepted_projection_current_session_changed",
                    "current live scene disappeared during accepted projection",
                )
            })?;
        Ok(Self {
            session_id: snapshot.session.session_id.clone(),
            session_status: snapshot.session.status.clone(),
            run_id: run.run_id.clone(),
            run_status: run.status.clone(),
            scene_revision,
            state_version: snapshot.state_version,
            scalar_revision: snapshot.scalar_revision,
            solver_profile_revision: snapshot.solver_profile.revision,
            mesh_revision: snapshot.mesh_revision,
            mesh_build_revision: snapshot.mesh_build_revision,
            field_catalog_revision: snapshot.field_catalog_revision,
            field_samples_revision: snapshot.field_samples_revision,
            field_quantity_revisions: snapshot.field_quantity_revisions.clone(),
            stage_execution_revision: snapshot.stage_execution_revision,
            simulation_preparation_revision: snapshot.simulation_preparation_revision,
            preparation_id: snapshot
                .simulation_preparation
                .as_ref()
                .map(|preparation| preparation.preparation_id.clone()),
            accepted_run_id: snapshot
                .mesh_workspace
                .as_ref()
                .and_then(|workspace| workspace.get("accepted_run_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            accepted_step_id: snapshot
                .mesh_workspace
                .as_ref()
                .and_then(|workspace| workspace.get("accepted_step_id"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct StageJournalDetails {
    reason: Option<String>,
    started_at_unix_ms: Option<u64>,
    completed_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CachedStageJournalDetails {
    run_id: String,
    input_fingerprint: String,
    attempt_id: Option<String>,
    ownership_epoch: Option<u64>,
    lifecycle: fullmag_session::FmsTaskLifecycle,
    details: StageJournalDetails,
}

impl CachedStageJournalDetails {
    fn matches(&self, run_id: &str, task: &fullmag_session::FmsTaskCatalogEntry) -> bool {
        self.run_id == run_id
            && self.input_fingerprint == task.input_fingerprint
            && self.attempt_id == task.attempt_id
            && self.ownership_epoch == task.ownership_epoch
            && self.lifecycle == task.lifecycle
    }
}

type StageJournalDetailsCache = std::collections::BTreeMap<String, CachedStageJournalDetails>;

#[derive(Debug, Clone, PartialEq)]
struct ProjectionCursor {
    api_instance_id: String,
    session_id: String,
    session_epoch: u64,
    scene_revision: u64,
    /// Computational input digest; when present it binds the cursor instead of
    /// the raw scene revision, so metadata-only edits keep the cursor.
    execution_input_sha256: Option<String>,
    run_id: String,
    run_revision: u64,
    artifact_revision: Option<u64>,
    status: &'static str,
    solver_profile_identity: Option<String>,
    latest_output_identity: Option<String>,
    live_observation_identity: Option<String>,
    live_observation_sequence: Option<u64>,
    live_magnetization_sequence: Option<u64>,
    stage_execution: crate::types::StageExecutionState,
    stage_journal_details: StageJournalDetailsCache,
}

#[derive(Debug, Clone)]
struct VerifiedOutput {
    task_order: usize,
    step_id: String,
    object_ref: String,
    data_kind: String,
    accepted_state_ref: Option<fullmag_quantities::AcceptedStateRef>,
    decoded: fullmag_application::DecodedStudyArtifact,
}

#[derive(Debug, Clone)]
struct DurableProjection {
    run_catalog_revision: u64,
    artifact_catalog_revision: Option<u64>,
    terminal_without_outputs: bool,
    status: &'static str,
    accepted_runtime_capabilities: Option<fullmag_runner::BackendCapabilities>,
    accepted_runtime_mode: Option<fullmag_ir::ExecutionMode>,
    accepted_runtime_problem: Option<fullmag_ir::ProblemIR>,
    command_id: Option<String>,
    preclaim_cancellations: Vec<(String, String)>,
    /// The run executes one interactive command (not a startup script).
    interactive_command: bool,
    /// Runtime capabilities of the finished step, including the resolved
    /// quantity registry that admits its published fields for reading.
    resolved_capabilities: Option<fullmag_runner::BackendCapabilities>,
    latest_state: Option<VerifiedOutput>,
    latest_total_energy: Option<fullmag_application::StudyScalarArtifact>,
    latest_output_identity: Option<String>,
    live_observation: Option<(usize, crate::accepted_study_worker::AcceptedLiveObservation)>,
    live_observation_identity: Option<String>,
    live_observation_sequence: Option<u64>,
    live_magnetization_sequence: Option<u64>,
    solver_profile: Option<crate::schemas::diagnostics::SolverProfileResource>,
    stage_execution: crate::types::StageExecutionState,
    stage_journal_details: StageJournalDetailsCache,
}

/// Start the read-only accepted-output projector for the Docker API-only
/// runtime.  The task remains idle for the native/legacy API lane and exits
/// only with the process; current-session fencing makes a stale poll harmless.
pub(crate) fn spawn(state: Arc<AppState>) {
    if !crate::live_accepted_execution::docker_api_only_runtime() {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut cursor: Option<ProjectionCursor> = None;
        let mut study_cache: Option<Arc<fullmag_runtime_control::AcceptedStudySnapshot>> = None;
        // The poll repeats every interval; report each distinct deferral once.
        let mut last_deferral: Option<String> = None;
        let mut repeated_deferrals: u32 = 0;
        loop {
            interval.tick().await;
            match poll_once(&state, &mut cursor, &mut study_cache).await {
                Ok(()) => {
                    last_deferral = None;
                    repeated_deferrals = 0;
                    // This poller is the Docker runtime's publication path. A
                    // finished run publishes nothing more, yet the path stays
                    // live; without this the session turned `disconnected`
                    // 45 s after a run and rejected every further command.
                    crate::router_v2::handlers::sessions::status::record_current_live_heartbeat(
                        &state,
                    )
                    .await;
                }
                Err(error) => {
                    let detail = error.to_string();
                    if last_deferral.as_deref() != Some(detail.as_str()) {
                        tracing::warn!(
                            code = ?error.code,
                            error = %error,
                            "accepted live read-model projection deferred"
                        );
                        last_deferral = Some(detail);
                        repeated_deferrals = 0;
                    } else {
                        // Back off an unchanged deferral; a new run, session
                        // or error still retries on the next interval.
                        repeated_deferrals = repeated_deferrals.saturating_add(1);
                        let backoff = POLL_INTERVAL
                            .saturating_mul(1_u32 << repeated_deferrals.min(6))
                            .min(MAX_DEFERRAL_BACKOFF);
                        tokio::time::sleep(backoff).await;
                    }
                }
            }
        }
    });
}

async fn poll_once(
    state: &Arc<AppState>,
    cursor: &mut Option<ProjectionCursor>,
    study_cache: &mut Option<Arc<fullmag_runtime_control::AcceptedStudySnapshot>>,
) -> Result<(), ApiError> {
    let Some(context) = capture_context(state).await? else {
        return Ok(());
    };
    // A terminal run whose final state is already projected has nothing left
    // to publish. Editing the model after it (the normal live workflow between
    // commands) changes the input identity and must not retry it forever.
    if cursor.as_ref().is_some_and(|previous| {
        previous.run_id == context.run_id
            && previous.session_id == context.session_id
            && previous.session_epoch == context.session_epoch
            && matches!(previous.status, "completed" | "failed" | "cancelled")
    }) {
        // Release the projected run's Study; a next run has its own intent.
        *study_cache = None;
        return Ok(());
    }
    let Some(store_root) = state.submit_store_root.clone() else {
        return Ok(());
    };
    let expected = context.clone();
    let previous_cursor = cursor.clone();
    let mut cached_study = study_cache.take();
    let (projection, cached_study) = tokio::task::spawn_blocking(move || {
        let projection = load_durable_projection(
            &store_root,
            &expected,
            previous_cursor.as_ref(),
            &mut cached_study,
        );
        (projection, cached_study)
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted projection task failed: {error}")))?;
    *study_cache = cached_study;
    let projection = projection?;
    let Some(mut projection) = projection else {
        return Ok(());
    };
    let next_cursor = ProjectionCursor {
        api_instance_id: context.api_instance_id.clone(),
        session_id: context.session_id.clone(),
        session_epoch: context.session_epoch,
        scene_revision: context.scene_revision,
        execution_input_sha256: context
            .execution_input
            .as_ref()
            .map(|identity| identity.sha256.clone()),
        run_id: context.run_id.clone(),
        run_revision: projection.run_catalog_revision,
        artifact_revision: projection.artifact_catalog_revision,
        status: projection.status,
        solver_profile_identity: projection.solver_profile.as_ref().map(profile_content_identity).transpose()?,
        latest_output_identity: projection.latest_output_identity.clone(),
        live_observation_identity: projection.live_observation_identity.clone(),
        live_observation_sequence: projection.live_observation_sequence,
        live_magnetization_sequence: projection.live_magnetization_sequence,
        stage_execution: projection.stage_execution.clone(),
        stage_journal_details: projection.stage_journal_details.clone(),
    };
    if cursor.as_ref() == Some(&next_cursor) {
        return Ok(());
    }
    // Publish a stage-specific pinned domain before admitting the output.
    // Preparation performs catalog/plan validation outside the transition
    // fence and uses its own exact final CAS.
    let mut running_capabilities = None;
    let stage_preparation = if projection.terminal_without_outputs {
        // A terminal catalog without outputs still carries authoritative
        // lifecycle state. Do not require preparation/materialization or clear
        // existing live fields before publishing that terminal state.
        Ok(None)
    } else if let Some((_, observation)) = projection
        .live_observation
        .as_ref()
        .filter(|(_, observation)| observation.magnetization_values.is_some())
    {
        ensure_stage_preparation_for_step(state, &context, &observation.header.step_id, None)
            .await
        .and_then(|prepared| {
            validate_live_magnetization_domain(observation, &prepared.execution_plan)?;
            if !matches!(projection.status, "completed" | "failed" | "cancelled") {
                running_capabilities = projection
                    .accepted_runtime_problem
                    .as_ref()
                    .and_then(|problem| {
                        running_runtime_capabilities(
                            problem,
                            &prepared.execution_plan,
                            &observation.header.realization,
                        )
                    })
                    .map(|capabilities| (capabilities, prepared.execution_plan.common.execution_mode));
            }
            Ok(None)
        })
    } else {
        ensure_stage_preparation(state, &context, &projection).await
    };
    let prepared_state_domain = match stage_preparation {
        Ok(prepared) => prepared,
        Err(error) => {
            if error.code.as_deref() != Some("accepted_preparation_current_state_changed") {
                if let Err(clear_error) = clear_stale_magnetization(state, &context).await {
                    tracing::error!(
                        error = %clear_error,
                        "failed to clear stale accepted magnetization after domain admission failure"
                    );
                }
            }
            return Err(error);
        }
    };
    // A running stage whose latest observation carries only scalars (a FEM
    // worker between field snapshots) executes the same accepted plan; its
    // fields must stay requestable, so derive the capabilities from it too.
    if running_capabilities.is_none()
        && !matches!(projection.status, "completed" | "failed" | "cancelled")
    {
        if let Some((_, observation)) = projection.live_observation.as_ref() {
            if let Ok(prepared) = ensure_stage_preparation_for_step(
                state,
                &context,
                &observation.header.step_id,
                None,
            )
            .await
            {
                running_capabilities = projection
                    .accepted_runtime_problem
                    .as_ref()
                    .and_then(|problem| {
                        running_runtime_capabilities(
                            problem,
                            &prepared.execution_plan,
                            &observation.header.realization,
                        )
                    })
                    .map(|capabilities| {
                        (capabilities, prepared.execution_plan.common.execution_mode)
                    });
            }
        }
    }
    if let Some((capabilities, mode)) = running_capabilities {
        projection.accepted_runtime_capabilities = Some(capabilities);
        projection.accepted_runtime_mode = Some(mode);
    }
    if matches!(projection.status, "completed" | "failed" | "cancelled") {
        if let Some(output) = projection.latest_state.as_ref() {
            if let fullmag_application::DecodedStudyArtifact::MagnetizationState(state_output) =
                &output.decoded
            {
                let prepared = if let Some(prepared) = prepared_state_domain {
                    prepared
                } else {
                    let prepared = ensure_stage_preparation_for_step(
                        state,
                        &context,
                        &output.step_id,
                        output.accepted_state_ref.as_ref(),
                    )
                    .await?;
                    validate_accepted_state_domain(
                        state_output,
                        &prepared.execution_plan,
                        &prepared.plan_fingerprint,
                        context.run_id.as_str(),
                        output.step_id.as_str(),
                        output.accepted_state_ref.as_ref(),
                    )?;
                    prepared
                };
                projection.accepted_runtime_capabilities = projection
                    .accepted_runtime_problem
                    .as_ref()
                    .and_then(|problem| {
                        accepted_runtime_capabilities_for_state(
                            problem,
                            &prepared.execution_plan,
                            &prepared.plan_fingerprint,
                            context.run_id.as_str(),
                            output,
                        )
                    });
                if projection.accepted_runtime_capabilities.is_some() {
                    projection.accepted_runtime_mode = Some(prepared.execution_plan.common.execution_mode);
                }
            }
        }
    }
    apply_projection(state, &context, projection).await?;
    *cursor = Some(next_cursor);
    Ok(())
}

async fn capture_context(state: &AppState) -> Result<Option<ProjectionContext>, ApiError> {
    let (session_id, run_id, scene_revision, execution_input) = {
        let current = state.current_live_state.read().await;
        let Some(snapshot) = current.as_ref() else {
            return Ok(None);
        };
        if snapshot.runtime_status.code == "imported_read_only" {
            return Ok(None);
        }
        let Some(run) = snapshot.run.as_ref() else {
            return Ok(None);
        };
        let Some(scene) = snapshot.scene_document.as_ref() else {
            return Ok(None);
        };
        if run.run_id.trim().is_empty() || snapshot.session.session_id.trim().is_empty() {
            return Ok(None);
        }
        (
            snapshot.session.session_id.clone(),
            run.run_id.clone(),
            scene.revision,
            crate::live_execution_binding::input_identity(scene)?,
        )
    };
    let reattach = state.accepted_run_reattach_identity.read().await;
    let session_epoch = state
        .current_live_session_epoch
        .load(std::sync::atomic::Ordering::Acquire);
    let allow_api_instance_rebind = reattach.as_ref().is_some_and(|identity| {
        identity.matches(&run_id, &session_id, session_epoch, scene_revision)
    });
    Ok(Some(ProjectionContext {
        session_id,
        run_id,
        session_epoch,
        scene_revision,
        execution_input: Some(execution_input),
        api_instance_id: state.request_scope_instance_id.clone(),
        allow_api_instance_rebind,
    }))
}

fn load_durable_projection(
    store_root: &std::path::Path,
    context: &ProjectionContext,
    previous_cursor: Option<&ProjectionCursor>,
    study_cache: &mut Option<Arc<fullmag_runtime_control::AcceptedStudySnapshot>>,
) -> Result<Option<DurableProjection>, ApiError> {
    let store = fullmag_session::SessionStore::open_existing(store_root).map_err(|error| {
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_projection_store_unavailable",
            format!("failed to open accepted projection store: {error}"),
        )
    })?;
    let Some(intent) = store
        .read_run_intent(&context.run_id)
        .map_err(|error| ApiError::internal(format!("read accepted RunIntent: {error}")))?
    else {
        return Ok(None);
    };
    intent
        .validate()
        .map_err(|error| ApiError::conflict(format!("accepted RunIntent is invalid: {error}")))?;
    validate_live_intent(context, &intent.specification)?;

    let Some(run_catalog) = store
        .read_run_catalog(&context.run_id)
        .map_err(|error| ApiError::internal(format!("read accepted run catalog: {error}")))?
    else {
        return Ok(None);
    };
    run_catalog
        .validate()
        .map_err(|error| ApiError::conflict(format!("accepted run catalog is invalid: {error}")))?;
    if run_catalog.run_id != context.run_id {
        return Err(ApiError::conflict_with_code(
            "accepted_projection_run_identity_mismatch",
            "accepted run catalog identity differs from the current live run",
        ));
    }

    let catalog_lifecycle_status = catalog_status(&run_catalog.tasks);
    let artifact_catalog = store
        .read_artifact_catalog(&context.run_id)
        .map_err(|error| ApiError::internal(format!("read accepted artifact catalog: {error}")))?;
    if artifact_catalog.is_none()
        && previous_cursor.is_some_and(|cursor| {
            cursor_matches_context(cursor, context) && cursor.artifact_revision.is_some()
        })
    {
        return Err(ApiError::conflict_with_code(
            "accepted_projection_artifact_catalog_disappeared",
            "a previously observed accepted artifact catalog is now missing",
        ));
    }
    let terminal_without_outputs = artifact_catalog.is_none()
        && matches!(catalog_lifecycle_status, "failed" | "cancelled")
        && terminal_catalog_without_outputs(&run_catalog.tasks);
    let terminal_status = matches!(
        catalog_lifecycle_status,
        "completed" | "failed" | "cancelled"
    );
    if artifact_catalog.is_none() && terminal_status && !terminal_without_outputs {
        return Err(ApiError::conflict_with_code(
            "accepted_projection_artifact_catalog_required",
            "terminal accepted run has outputs or task state that requires an artifact catalog",
        ));
    }
    // Accepted work has no artifacts yet. Project its durable lifecycle and
    // live sidecars without waiting for the first output; otherwise the UI
    // remains at its initial state throughout preparation/solver startup.
    let outputless_nonterminal_catalog = artifact_catalog.is_none()
        && !terminal_status
        && !run_catalog.tasks.is_empty()
        && run_catalog.tasks.iter().all(|task| {
            matches!(
                task.lifecycle,
                fullmag_session::FmsTaskLifecycle::Accepted
                    | fullmag_session::FmsTaskLifecycle::Queued
                    | fullmag_session::FmsTaskLifecycle::Preparing
                    | fullmag_session::FmsTaskLifecycle::Running
                    | fullmag_session::FmsTaskLifecycle::Stopping
            ) && task.artifact_ids.is_empty()
        });
    if artifact_catalog.is_none()
        && !terminal_without_outputs
        && !outputless_nonterminal_catalog
    {
        return Ok(None);
    }
    if let Some(artifact_catalog) = artifact_catalog.as_ref() {
        artifact_catalog.validate().map_err(|error| {
            ApiError::conflict(format!("accepted artifact catalog is invalid: {error}"))
        })?;
        if artifact_catalog.run_id != context.run_id {
            return Err(ApiError::conflict_with_code(
                "accepted_projection_run_identity_mismatch",
                "accepted artifact catalog identity differs from the current live run",
            ));
        }
    }
    // The start gate only remaps waiting_for_compute. When this is a valid
    // terminal no-output run, the RunCatalog lifecycle is the exact status.
    let status = if terminal_without_outputs {
        catalog_lifecycle_status
    } else {
        accepted_projection_status(&store, &context.run_id, &run_catalog.tasks)?
    };
    let artifact_catalog_revision = artifact_catalog
        .as_ref()
        .map(|artifact_catalog| artifact_catalog.revision);
    let durable_unchanged = previous_cursor.is_some_and(|cursor| {
        cursor_matches_context(cursor, context)
            && cursor.run_revision == run_catalog.revision
            && cursor.artifact_revision == artifact_catalog_revision
            && cursor.status == status
    });
    let has_active_task = run_catalog.tasks.iter().any(|task| {
        matches!(
            task.lifecycle,
            fullmag_session::FmsTaskLifecycle::Running
                | fullmag_session::FmsTaskLifecycle::Stopping
        )
    });
    let previous_live_observation_is_empty = previous_cursor.is_some_and(|cursor| {
        cursor_matches_context(cursor, context)
            && cursor.live_observation_identity.is_none()
            && cursor.live_observation_sequence.is_none()
            && cursor.live_magnetization_sequence.is_none()
    });
    if durable_unchanged && !has_active_task && previous_live_observation_is_empty {
        // RunIntent, catalog identities, lifecycle, start gate, and current
        // session binding were freshly checked above. With no active attempt
        // there can be no new live sidecar sequence, so avoid reloading and
        // re-lowering the immutable accepted Study on an unchanged poll.
        return Ok(None);
    }
    let durable_changed = !durable_unchanged;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification.clone()).map_err(|error| {
            ApiError::conflict(format!(
                "accepted RunIntent specification is not typed: {error}"
            ))
        })?;
    if specification.run_id.as_str() != context.run_id {
        return Err(ApiError::conflict_with_code(
            "accepted_projection_specification_run_mismatch",
            "accepted RunIntent specification differs from the current live run",
        ));
    }
    let accepted = cached_accepted_study_snapshot(&store, &intent, &specification, study_cache)?;
    let task_order = accepted
        .lowered
        .steps
        .iter()
        .enumerate()
        .map(|(order, step)| {
            fullmag_session::task_id_for_study_step(&context.run_id, &step.step_id)
                .map(|task_id| (task_id, order))
                .map_err(|error| {
                    ApiError::conflict(format!(
                        "accepted Study step identity cannot be projected: {error}"
                    ))
                })
        })
        .collect::<Result<std::collections::BTreeMap<_, _>, _>>()?;
    if artifact_catalog.is_none() && preclaim_cancelled_without_artifacts(&store, &run_catalog)? {
        let planned_count = accepted.lowered.steps.iter()
            .filter(|step| matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned))
            .count();
        if run_catalog.tasks.len() != planned_count {
            return Err(ApiError::conflict("cancelled run catalog does not cover every planned Study step"));
        }
        for task in &run_catalog.tasks {
            let order = task_order.get(&task.task_id).ok_or_else(|| {
                ApiError::conflict("cancelled task is not present in the canonical Study execution order")
            })?;
            let step = &accepted.lowered.steps[*order];
            let fingerprint = fullmag_application::study_task_input_fingerprint(&specification, step)
                .map_err(|error| ApiError::conflict(format!("cancelled Study input is invalid: {error}")))?;
            if !matches!(step.status, fullmag_plan::StudyStepLoweringStatus::Planned)
                || task.input_fingerprint != fingerprint
            {
                return Err(ApiError::conflict("cancelled task input differs from its canonical Study step"));
            }
        }
    }
    let active_task = run_catalog
        .tasks
        .iter()
        .filter(|task| {
            matches!(
                task.lifecycle,
                fullmag_session::FmsTaskLifecycle::Running
                    | fullmag_session::FmsTaskLifecycle::Stopping
            ) || (matches!(task.lifecycle,
                    fullmag_session::FmsTaskLifecycle::Succeeded
                    | fullmag_session::FmsTaskLifecycle::Failed
                    | fullmag_session::FmsTaskLifecycle::Interrupted
                    | fullmag_session::FmsTaskLifecycle::Cancelled)
                && task_order.get(&task.task_id).is_some_and(|order| matches!(
                    accepted.lowered.steps[*order].kind,
                    fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. })))
        })
        .filter_map(|task| task_order.get(&task.task_id).map(|order| (*order, task)))
        .max_by_key(|(order, task)| observation_priority(task.lifecycle, *order));
    let mut live_observation_identity = None;
    let mut live_observation_sequence = None;
    let mut live_magnetization_sequence = None;
    let live_observation = if let Some((order, task)) = active_task {
        let step_id = accepted.lowered.steps.iter().find_map(|step| {
            let task_id = fullmag_session::task_id_for_study_step(&context.run_id, &step.step_id)
                .ok()?;
            (task_id == task.task_id).then(|| step.step_id.clone())
        });
        if let (Some(step_id), Some(attempt_id), Some(ownership_epoch)) =
            (step_id, task.attempt_id.as_deref(), task.ownership_epoch)
        {
            let identity = format!("{}:{attempt_id}:{ownership_epoch}", task.task_id);
            let known_magnetization_sequence = previous_cursor
                .filter(|cursor| {
                    cursor_matches_context(cursor, context)
                        && cursor.live_observation_identity.as_deref() == Some(identity.as_str())
                })
                .and_then(|cursor| cursor.live_magnetization_sequence);
            let observation_result = (|| {
            let observation = crate::accepted_study_worker::read_accepted_live_observation(
                store_root,
                &context.run_id,
                &task.task_id,
                &step_id,
                attempt_id,
                ownership_epoch,
                known_magnetization_sequence,
            )
            .map_err(|error| {
                ApiError::conflict(format!("read accepted live observation: {error:#}"))
            })?;
            if previous_cursor.filter(|cursor| cursor_matches_context(cursor, context)
                && cursor.live_observation_identity.as_deref() == Some(identity.as_str()))
                .and_then(|cursor| cursor.live_observation_sequence)
                .zip(observation.as_ref().map(|value| value.header.sequence))
                .is_some_and(|(previous, next)| next < previous)
            {
                return Err(ApiError::conflict("accepted live observation sequence regressed"));
            }
            if let Some((cursor, next)) = previous_cursor
                .filter(|cursor| cursor_matches_context(cursor, context)
                    && cursor.live_observation_identity.as_deref() == Some(identity.as_str()))
                .zip(observation.as_ref())
            {
                if let Some(previous) = cursor.stage_execution.stages.iter()
                    .find(|stage| stage.stage_id.as_deref() == Some(step_id.as_str()))
                    .and_then(|stage| stage.antenna_progress.as_ref())
                {
                    let Some(progress) = next.header.operation_progress.as_ref() else {
                        return Err(ApiError::conflict("antenna observation changed its payload kind"));
                    };
                    if !crate::accepted_study_worker::accepted_antenna_progress::follows(previous, progress)
                        || (cursor.live_observation_sequence == Some(next.header.sequence) && previous != progress)
                    {
                        return Err(ApiError::conflict("antenna observation progress regressed or changed without a revision"));
                    }
                }
            }
            if observation.as_ref().is_some_and(|observation| {
                let is_antenna = matches!(accepted.lowered.steps[order].kind,
                    fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. });
                is_antenna != observation.header.operation_progress.is_some()
            }) {
                return Err(ApiError::conflict("accepted live observation kind differs from its study step"));
            }
                Ok(observation)
            })();
            let observation = observation_diagnostic_result(
                observation_priority(task.lifecycle, order).0, observation_result)?;
            live_observation_identity = Some(identity);
            live_observation_sequence = observation
                .as_ref()
                .map(|observation| observation.header.sequence);
            live_magnetization_sequence = observation.as_ref().and_then(|observation| {
                observation
                    .header
                    .magnetization
                    .as_ref()
                    .and_then(|reference| {
                        (observation.magnetization_values.is_some()
                            || known_magnetization_sequence == Some(reference.sequence))
                        .then_some(reference.sequence)
                    })
                    .or(known_magnetization_sequence)
            });
            observation.map(|observation| (order, observation))
        } else {
            None
        }
    } else {
        None
    };
    let live_changed = previous_cursor.is_none_or(|cursor| {
        !cursor_matches_context(cursor, context)
            || cursor.live_observation_identity != live_observation_identity
            || cursor.live_observation_sequence != live_observation_sequence
            || cursor.live_magnetization_sequence != live_magnetization_sequence
    });
    if !durable_changed && !live_changed {
        // Keep the bounded sidecar header fresh, but do not decode CAS outputs
        // or rebuild the read model until a durable or live sequence changes.
        return Ok(None);
    }
    let verified = if durable_changed {
        if let Some(artifact_catalog) = artifact_catalog.as_ref() {
            load_verified_outputs(&store, &run_catalog, artifact_catalog, &task_order)?
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };
    let previous_stage_details = previous_cursor
        .filter(|cursor| cursor_matches_context(cursor, context))
        .map(|cursor| &cursor.stage_journal_details);
    // Heartbeats change catalog revisions, not attempt lifecycle. Reuse their
    // immutable journal details; sidecar-only updates never read the journal.
    let stage_journal_details = if durable_changed {
        load_stage_journal_details(&store, &run_catalog, previous_stage_details)?
    } else {
        previous_stage_details.cloned().unwrap_or_default()
    };
    let latest_state = verified
        .iter()
        .filter(|output| output.data_kind == "state")
        .max_by(|left, right| compare_magnetization_outputs(left, right))
        .cloned();
    let accepted_runtime_problem = if matches!(status, "completed" | "failed" | "cancelled") {
        latest_state.as_ref().and_then(|output| {
            accepted
                .catalog
                .entries()
                .iter()
                .find(|entry| entry.step_id() == output.step_id)
                .map(|entry| entry.problem().clone())
        })
    } else {
        // A running stage publishes its planned capabilities from the same
        // accepted problem the worker executes (see `running_runtime_capabilities`).
        live_observation.as_ref().and_then(|(_, observation)| {
            accepted
                .catalog
                .entries()
                .iter()
                .find(|entry| entry.step_id() == observation.header.step_id)
                .map(|entry| entry.problem().clone())
        })
    };
    let latest_total_energy = verified
        .iter()
        .filter_map(|output| match &output.decoded {
            fullmag_application::DecodedStudyArtifact::Scalar(scalar)
                if scalar.quantity_id == "E_total" =>
            {
                Some(output)
            }
            _ => None,
        })
        .max_by(|left, right| compare_scalar_outputs(left, right))
        .and_then(|output| match &output.decoded {
            fullmag_application::DecodedStudyArtifact::Scalar(scalar) => Some(scalar.clone()),
            _ => None,
        });
    let latest_output_identity = latest_state
        .as_ref()
        .map(|output| output.object_ref.clone())
        .or_else(|| latest_total_energy.as_ref().map(scalar_identity))
        .or_else(|| {
            artifact_catalog.as_ref().and_then(|_| {
                previous_cursor
                    .filter(|cursor| cursor_matches_context(cursor, context))
                    .and_then(|cursor| cursor.latest_output_identity.clone())
            })
        });
    let stage_execution = if !durable_changed {
        if let Some(cursor) = previous_cursor.filter(|cursor| cursor_matches_context(cursor, context)) {
            let mut stage_execution = cursor.stage_execution.clone();
            refresh_live_stage_progress(&mut stage_execution, live_observation.as_ref());
            stage_execution
        } else {
            build_stage_execution(
                &accepted,
                &run_catalog.tasks,
                live_observation.as_ref(),
                &verified,
                &stage_journal_details,
                status,
            )?
        }
    } else {
        build_stage_execution(
            &accepted,
            &run_catalog.tasks,
            live_observation.as_ref(),
            &verified,
            &stage_journal_details,
            status,
        )?
    };
    let command_id = intent
        .specification
        .pointer("/parameters/live_workspace/command_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let mut preclaim_cancellations = Vec::new();
    if status == "cancelled" && preclaim_cancelled_without_artifacts(&store, &run_catalog)? {
        for task in &run_catalog.tasks {
            let cancellation = store.read_task_cancellation_intent(&context.run_id, &task.task_id)
                .map_err(|error| ApiError::conflict(format!("read command cancellation proof: {error}")))?
                .ok_or_else(|| ApiError::conflict("command cancellation proof disappeared"))?;
            cancellation.validate_task_scope(&store, task, run_catalog.revision)
                .map_err(|error| ApiError::conflict(format!("invalid command cancellation proof: {error}")))?;
            preclaim_cancellations.push((task.task_id.clone(), cancellation.cancellation_id));
        }
    }
    let interactive_command = intent
        .specification
        .pointer("/parameters/live_workspace/command/kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind != "startup_script");
    // Provider truth belongs to the resolved plan, not to the run lifecycle.
    // A prepared session waiting for Compute installs it too, so the catalog
    // offers every active quantity instead of only the prepared m. A running
    // stage is left to the worker-lane check on the live observation. Before
    // a terminal state only a plan that provides m is installed: modal and
    // frequency studies provide no magnetization, and the prepared m must
    // stay readable there. A run's plan is immutable, so it is re-resolved
    // only when durable state changes, never on each live observation.
    let terminal_status = matches!(status, "completed" | "failed" | "cancelled");
    let resolved_capabilities = if durable_changed && (terminal_status || active_task.is_none()) {
        accepted_step_capabilities(&accepted, &intent.specification).filter(|capabilities| {
            terminal_status
                || capabilities
                    .resolved_quantity_registry
                    .as_ref()
                    .is_some_and(|registry| registry.field_quantities.iter().any(|id| id == "m"))
        })
    } else {
        None
    };
    let solver_profile = if intent.specification.pointer("/parameters/solver_profile").is_some() {
        let profile_specification: fullmag_application::RunSpecification = serde_json::from_value(intent.specification.clone())
            .map_err(|error| ApiError::conflict(format!("invalid accepted profile RunSpec: {error}")))?;
        crate::accepted_solver_profile::load_projection(&store, &profile_specification, &run_catalog.tasks)
            .and_then(|profile| profile.map(|profile| {
                let mut resource: crate::schemas::diagnostics::SolverProfileResource =
                    serde_json::from_value(serde_json::to_value(profile)?)?;
                for sample in &mut resource.operation_samples {
                    sample.execution_config = Some(resource.config.clone());
                }
                Ok::<_, anyhow::Error>(resource)
            }).transpose())
            .map_err(|error| ApiError::conflict(format!("invalid accepted operation diagnostics: {error:#}")))?
    } else { None };
    Ok(Some(DurableProjection {
        solver_profile,
        run_catalog_revision: run_catalog.revision,
        artifact_catalog_revision,
        terminal_without_outputs,
        status,
        accepted_runtime_capabilities: None,
        accepted_runtime_mode: None,
        accepted_runtime_problem,
        command_id,
        preclaim_cancellations,
        interactive_command,
        resolved_capabilities,
        latest_state,
        latest_total_energy,
        latest_output_identity,
        live_observation,
        live_observation_identity,
        live_observation_sequence,
        live_magnetization_sequence,
        stage_execution,
        stage_journal_details,
    }))
}

fn preclaim_cancelled_without_artifacts(
    store: &fullmag_session::SessionStore,
    catalog: &fullmag_session::FmsRunCatalog,
) -> Result<bool, ApiError> {
    if catalog.tasks.is_empty() || catalog.tasks.iter().any(|task| {
        task.lifecycle != fullmag_session::FmsTaskLifecycle::Cancelled
            || task.attempt_id.is_some()
            || task.ownership_epoch.is_some()
            || task.resource_id.is_some()
            || task.resolved_input_fingerprint.is_some()
            || task.observation.is_some()
            || !task.artifact_ids.is_empty()
            || task.coordinator_watermark.is_some()
            || task.coordinator_genesis.is_some()
    }) {
        return Ok(false);
    }
    for task in &catalog.tasks {
        let Some(intent) = store.read_task_cancellation_intent(&catalog.run_id, &task.task_id)
            .map_err(|error| ApiError::conflict(format!("read pre-claim cancellation intent: {error}")))?
        else {
            return Ok(false);
        };
        intent.validate_task_scope(store, task, catalog.revision).map_err(|error| {
            ApiError::conflict(format!("pre-claim cancellation scope is invalid: {error}"))
        })?;
    }
    Ok(true)
}

/// The accepted Study is a pure function of the immutable RunIntent and the
/// content-addressed objects it names. Loading it reads, re-hashes, decodes
/// and lowers the whole per-step ProblemIR catalog (tens of MB for a large
/// grid or mesh), so a running task reuses the snapshot validated for the
/// identical intent instead of rebuilding it on every poll.
fn cached_accepted_study_snapshot(
    store: &fullmag_session::SessionStore,
    intent: &fullmag_session::FmsRunIntent,
    specification: &fullmag_application::RunSpecification,
    cache: &mut Option<Arc<fullmag_runtime_control::AcceptedStudySnapshot>>,
) -> Result<Arc<fullmag_runtime_control::AcceptedStudySnapshot>, ApiError> {
    if let Some(cached) = cache.as_ref().filter(|cached| cached.run.intent == *intent) {
        return Ok(Arc::clone(cached));
    }
    let snapshot = fullmag_runtime_control::load_accepted_study_snapshot(
        store,
        &specification.run_id,
        &specification.snapshot.project_id,
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "accepted Study snapshot cannot be loaded for projection: {error:#}"
        ))
    })?;
    let snapshot = Arc::new(snapshot);
    *cache = Some(Arc::clone(&snapshot));
    Ok(snapshot)
}

/// Rebuild plan-scoped provider capabilities only after the accepted state has
/// been checked against the durable prepared stage. The actual worker engine
/// and precision must agree with the runner's resolution of that immutable
/// plan; requested intent alone never selects or promotes a provider.
/// Capabilities of a running stage, resolved from the accepted immutable plan
/// the worker executes. Without them every live field is unrequestable until
/// the run ends and the viewport has nothing to colour. The worker's live
/// observation names its realization lane; any other lane (a fallback)
/// publishes nothing. Terminal projection re-derives them from the accepted
/// state's provenance, or clears them.
fn running_runtime_capabilities(
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    realization: &str,
) -> Option<fullmag_runner::BackendCapabilities> {
    if !matches!(
        &plan.backend_plan,
        fullmag_ir::BackendPlanIR::Fdm(_)
            | fullmag_ir::BackendPlanIR::FdmMultilayer(_)
            | fullmag_ir::BackendPlanIR::Fem(_)
    ) {
        return None;
    }
    let capabilities =
        fullmag_runner::resolve_planned_runtime_capabilities(problem, plan).ok()?;
    let registry = capabilities.resolved_quantity_registry.as_ref()?;
    if registry.source != fullmag_runner::QuantityProviderRegistrySource::ResolvedPlan {
        return None;
    }
    (planned_realization_lane(capabilities.engine_id)? == realization).then_some(capabilities)
}

fn planned_realization_lane(engine: fullmag_runner::RuntimeEngineId) -> Option<&'static str> {
    match engine {
        fullmag_runner::RuntimeEngineId::FdmCpuReference => Some("fdm_cpu"),
        fullmag_runner::RuntimeEngineId::FdmCuda => Some("fdm_gpu"),
        fullmag_runner::RuntimeEngineId::FemCpuNative => Some("fem_cpu"),
        fullmag_runner::RuntimeEngineId::FemNativeGpu => Some("fem_gpu"),
        _ => None,
    }
}

fn accepted_runtime_capabilities_for_state(
    problem: &fullmag_ir::ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    plan_fingerprint: &str,
    run_id: &str,
    output: &VerifiedOutput,
) -> Option<fullmag_runner::BackendCapabilities> {
    let accepted_state_ref = output.accepted_state_ref.as_ref()?;
    if accepted_state_ref.id.run_id != run_id
        || accepted_state_ref.id.stage_id.as_deref() != Some(output.step_id.as_str())
        || accepted_state_ref.id.domain_digest != plan_fingerprint
    {
        return None;
    }
    let fullmag_application::DecodedStudyArtifact::MagnetizationState(state) = &output.decoded
    else {
        return None;
    };
    if state
        .provenance
        .get("resolved_fallback")
        .is_some_and(|fallback| !fallback.is_null())
        || state
            .provenance
            .get("lossy_fallback_used")
            .and_then(Value::as_bool)
            == Some(true)
    {
        return None;
    }
    if !matches!(
        &plan.backend_plan,
        fullmag_ir::BackendPlanIR::Fdm(_)
            | fullmag_ir::BackendPlanIR::FdmMultilayer(_)
            | fullmag_ir::BackendPlanIR::Fem(_)
    ) {
        return None;
    }
    let capabilities =
        fullmag_runner::resolve_planned_runtime_capabilities(problem, plan).ok()?;
    let registry = capabilities.resolved_quantity_registry.as_ref()?;
    let provenance_precision = state.provenance.get("precision").and_then(Value::as_str)?;
    if registry.source != fullmag_runner::QuantityProviderRegistrySource::ResolvedPlan
        || registry.precision != provenance_precision
        || accepted_state_ref.id.accepted_step != state.step
        || fullmag_runner::validate_accepted_state_execution_provenance(
            &plan.backend_plan,
            capabilities.engine_id,
            &state.provenance,
        )
        .is_err()
    {
        return None;
    }
    Some(capabilities)
}

/// Build a terminal read model from evidence already pinned by the caller's
/// native fence. This function acquires no locks and publishes no effects.
pub(crate) fn build_terminal_observation_stage_execution(
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    catalog: &fullmag_session::FmsRunCatalog,
    journal: &[fullmag_session::FmsCoordinatorJournalEntry],
    status: &'static str,
) -> Result<crate::types::StageExecutionState, ApiError> {
    if catalog.run_id != accepted.run.specification.run_id.as_str()
        || !matches!(status, "failed" | "completed" | "cancelled" | "interrupted")
        || catalog.tasks.is_empty()
        || catalog.tasks.iter().any(|task| !matches!(task.lifecycle,
            fullmag_session::FmsTaskLifecycle::Succeeded
                | fullmag_session::FmsTaskLifecycle::Failed
                | fullmag_session::FmsTaskLifecycle::Cancelled
                | fullmag_session::FmsTaskLifecycle::Interrupted))
    {
        return Err(ApiError::conflict("terminal stage observation requires its exact terminal catalog"));
    }
    let mut details = StageJournalDetailsCache::new();
    for task in &catalog.tasks {
        details.insert(task.task_id.clone(), CachedStageJournalDetails {
            run_id: catalog.run_id.clone(),
            input_fingerprint: task.input_fingerprint.clone(),
            attempt_id: task.attempt_id.clone(),
            ownership_epoch: task.ownership_epoch,
            lifecycle: task.lifecycle,
            details: stage_journal_details_for_task(&catalog.run_id, task, journal)?,
        });
    }
    build_stage_execution(accepted, &catalog.tasks, None, &[], &details, status)
}

fn build_stage_execution(
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    tasks: &[fullmag_session::FmsTaskCatalogEntry],
    live_observation: Option<&(usize, crate::accepted_study_worker::AcceptedLiveObservation)>,
    verified_outputs: &[VerifiedOutput],
    journal_details: &StageJournalDetailsCache,
    status: &'static str,
) -> Result<crate::types::StageExecutionState, ApiError> {
    let tasks_by_id = tasks
        .iter()
        .map(|task| (task.task_id.as_str(), task))
        .collect::<std::collections::BTreeMap<_, _>>();
    let mut stages = Vec::with_capacity(accepted.lowered.steps.len());
    for step in &accepted.lowered.steps {
        let task_id = fullmag_session::task_id_for_study_step(accepted.run.specification.run_id.as_str(), &step.step_id)
            .map_err(|error| ApiError::conflict(format!("accepted stage identity is invalid: {error}")))?;
        let task = tasks_by_id.get(task_id.as_str()).copied();
        let lifecycle = task.map(|task| task.lifecycle);
        let stage_status = match lifecycle {
            Some(fullmag_session::FmsTaskLifecycle::Running | fullmag_session::FmsTaskLifecycle::Stopping) => {
                crate::types::StageLifecycleState::Running
            }
            Some(fullmag_session::FmsTaskLifecycle::Succeeded) => crate::types::StageLifecycleState::Completed,
            Some(fullmag_session::FmsTaskLifecycle::Failed | fullmag_session::FmsTaskLifecycle::Interrupted) => {
                crate::types::StageLifecycleState::Failed
            }
            Some(fullmag_session::FmsTaskLifecycle::Cancelled) => crate::types::StageLifecycleState::Cancelled,
            Some(fullmag_session::FmsTaskLifecycle::Accepted | fullmag_session::FmsTaskLifecycle::Queued | fullmag_session::FmsTaskLifecycle::Preparing) | None => {
                crate::types::StageLifecycleState::Pending
            }
        };
        let mut record = crate::session::accepted_stage_record(
            &step.step_id,
            None,
            stage_status,
        );
        record.antenna_solve_stage_id = match &step.kind {
            fullmag_authoring::StudyStepKind::ClosedLoopInspection { stage_id, .. } => {
                Some(stage_id.clone())
            }
            fullmag_authoring::StudyStepKind::Primitive {
                stage_kind: fullmag_authoring::StudyPrimitiveStageKind::AntennaFieldSolve,
            } => step.execution_plan.as_ref().and_then(|plan| match &plan.backend_plan {
                fullmag_ir::BackendPlanIR::AntennaFieldOnly(antenna) => Some(antenna.stage_id.clone()),
                fullmag_ir::BackendPlanIR::AntennaExternalLeadInspection(antenna) => {
                    Some(antenna.input.stage.id.clone())
                }
                _ => None,
            }),
            _ => None,
        };
        if let Some(cached) = task.and_then(|task| journal_details.get(&task.task_id)
            .filter(|cached| cached.matches(accepted.run.specification.run_id.as_str(), task)))
        {
            record.state_transition_reason = cached.details.reason.clone();
            record.started_at_unix_ms = cached.details.started_at_unix_ms;
            record.completed_at_unix_ms = cached.details.completed_at_unix_ms;
        }
        if let Some(output) = verified_outputs
            .iter()
            .filter(|output| output.step_id == step.step_id && output.data_kind == "state")
            .max_by(|left, right| compare_magnetization_outputs(left, right))
        {
            if let fullmag_application::DecodedStudyArtifact::MagnetizationState(state) = &output.decoded {
                record.completed_step = Some(state.step);
                record.applied_step = Some(state.step);
                if state.time_s.is_finite() && state.time_s >= 0.0 {
                    record.applied_time_seconds = Some(state.time_s);
                }
            }
        }
        if let Some((_, observation)) = live_observation.filter(|(_, observation)| {
            observation.header.step_id == step.step_id
        }) {
            apply_observation_stage_progress(&mut record, observation);
        }
        stages.push(record);
    }
    Ok(crate::session::accepted_stage_execution_state(
        stages,
        crate::session::accepted_runtime_lifecycle_state(status),
    ))
}

fn observation_priority(lifecycle: fullmag_session::FmsTaskLifecycle, order: usize) -> (bool, usize) {
    (matches!(lifecycle, fullmag_session::FmsTaskLifecycle::Running
        | fullmag_session::FmsTaskLifecycle::Stopping), order)
}

fn observation_diagnostic_result(
    active: bool,
    result: Result<Option<crate::accepted_study_worker::AcceptedLiveObservation>, ApiError>,
) -> Result<Option<crate::accepted_study_worker::AcceptedLiveObservation>, ApiError> {
    // A terminal diagnostic cannot veto the authoritative durable outcome.
    if active { result } else { Ok(result.unwrap_or(None)) }
}

fn refresh_live_stage_progress(
    stage_execution: &mut crate::types::StageExecutionState,
    live_observation: Option<&(usize, crate::accepted_study_worker::AcceptedLiveObservation)>,
) {
    let Some((_, observation)) = live_observation else {
        for stage in &mut stage_execution.stages {
            if stage.antenna_progress.take().is_some() {
                stage.progress_percent = None;
                stage.progress_label = None;
                stage.progress_detail = None;
                stage.last_progress_unix_ms = None;
            }
        }
        return;
    };
    let Some(stage) = stage_execution.stages.iter_mut().find(|stage| {
        stage.stage_id.as_deref() == Some(observation.header.step_id.as_str())
    }) else {
        return;
    };
    apply_observation_stage_progress(stage, observation);
}

fn apply_observation_stage_progress(
    stage: &mut crate::types::StageExecutionRecord,
    observation: &crate::accepted_study_worker::AcceptedLiveObservation,
) {
    if let Some(progress) = observation.header.operation_progress {
        stage.antenna_progress = Some(progress);
        stage.applied_step = None;
        stage.applied_time_seconds = None;
        // This percentage describes field targets only, never durable completion.
        stage.progress_percent = (matches!(progress.phase,
            fullmag_runner::AntennaOperationPhase::EvaluatingField
            | fullmag_runner::AntennaOperationPhase::ValidatingResult
            | fullmag_runner::AntennaOperationPhase::PublishingResult))
            .then_some(100.0 * progress.completed_targets as f64 / progress.total_targets as f64);
        stage.progress_label = Some(progress.phase.as_str().into());
        stage.progress_detail = Some(format!("field targets {}/{}; source cells {}; elapsed {:.1} s",
            progress.completed_targets, progress.total_targets, progress.source_cells, progress.elapsed_seconds));
        stage.last_progress_unix_ms = Some(observation.header.written_at_unix_ms);
    } else if let Some(stats) = observation.header.stats.as_ref() {
        if stats.time.is_finite() && stats.time >= 0.0
            && stats.dt.is_finite() && stats.dt >= 0.0 {
            stage.antenna_progress = None;
            stage.applied_step = Some(stats.step);
            stage.applied_time_seconds = Some(stats.time);
            stage.progress_label = Some("Solver update".to_owned());
            stage.progress_detail = Some(format!("step {}; time {:.9e} s; dt {:.9e} s",
                stats.step, stats.time, stats.dt));
            stage.last_progress_unix_ms = Some(observation.header.written_at_unix_ms);
        }
    }
}

/// Reuse details only for the same task input, attempt and lifecycle. Durable
/// entries are immutable; heartbeat revisions must not trigger a full replay.
fn load_stage_journal_details(
    store: &fullmag_session::SessionStore,
    catalog: &fullmag_session::FmsRunCatalog,
    previous: Option<&StageJournalDetailsCache>,
) -> Result<StageJournalDetailsCache, ApiError> {
    use fullmag_session::FmsTaskLifecycle as Life;

    let mut details = StageJournalDetailsCache::new();
    let mut missing = Vec::new();
    for task in &catalog.tasks {
        if let Some(cached) = previous
            .and_then(|cache| cache.get(&task.task_id))
            .filter(|cached| cached.matches(&catalog.run_id, task))
        {
            details.insert(task.task_id.clone(), cached.clone());
            continue;
        }
        details.insert(
            task.task_id.clone(),
            CachedStageJournalDetails {
                run_id: catalog.run_id.clone(),
                input_fingerprint: task.input_fingerprint.clone(),
                attempt_id: task.attempt_id.clone(),
                ownership_epoch: task.ownership_epoch,
                lifecycle: task.lifecycle,
                details: StageJournalDetails::default(),
            },
        );
        if task.attempt_id.is_some()
            && task.ownership_epoch.is_some()
            && matches!(
                task.lifecycle,
                Life::Running
                    | Life::Stopping
                    | Life::Succeeded
                    | Life::Failed
                    | Life::Cancelled
                    | Life::Interrupted
            )
        {
            missing.push(task);
        }
    }
    if missing.is_empty() {
        return Ok(details);
    }

    // This is a real shared native fence, not an unlocked snapshot or writer
    // takeover. A busy store defers the existing projector poll with its cursor intact.
    let transaction = store.read_transaction().map_err(|error| {
        ApiError::conflict(format!("read accepted stage journal fence: {error}"))
    })?;
    if store
        .read_run_catalog(&catalog.run_id)
        .map_err(|error| ApiError::conflict(format!("read accepted stage catalog: {error}")))?
        .as_ref()
        != Some(catalog)
    {
        return Err(ApiError::conflict(
            "accepted stage catalog changed before journal capture",
        ));
    }
    let journal = store
        .read_coordinator_journal_readonly(&catalog.run_id, &transaction)
        .map_err(|error| ApiError::conflict(format!("read accepted stage journal: {error}")))?;
    for task in missing {
        details
            .get_mut(&task.task_id)
            .expect("current task cache entry")
            .details = stage_journal_details_for_task(&catalog.run_id, task, &journal)?;
    }
    Ok(details)
}

/// UTC timestamps describe durable worker stage events, not native-call or CPU time.
fn stage_journal_details_for_task(
    run_id: &str,
    task: &fullmag_session::FmsTaskCatalogEntry,
    journal: &[fullmag_session::FmsCoordinatorJournalEntry],
) -> Result<StageJournalDetails, ApiError> {
    use fullmag_application::{
        CoordinatorMessage as Message, TaskLifecycle as TaskLife, WorkerCommand, WorkerEvent,
    };
    use fullmag_session::{FmsCoordinatorJournalDirection as Direction, FmsTaskLifecycle as Life};

    let mut details = StageJournalDetails::default();
    let (Some(attempt_id), Some(epoch)) = (task.attempt_id.as_deref(), task.ownership_epoch) else {
        return Ok(details);
    };
    let mut failure_reason = None;
    let mut stop_reason = None;
    let mut saw_started = false;
    for entry in journal.iter().filter(|entry| {
        entry.task_id == task.task_id
            && entry.attempt_id == attempt_id
            && entry.ownership_epoch == epoch
    }) {
        entry.validate_for_task(task).map_err(|error| {
            ApiError::conflict(format!("invalid accepted stage journal entry: {error}"))
        })?;
        let transition: fullmag_application::CoordinatorTransition =
            serde_json::from_value(entry.payload.clone()).map_err(|error| {
                ApiError::conflict(format!(
                    "accepted task coordinator transition is invalid: {error}"
                ))
            })?;
        let checkpoint = &transition.checkpoint;
        let claim = &checkpoint.claim;
        if entry.run_id != run_id
            || claim.run_id.as_str() != run_id
            || claim.task_id.as_str() != task.task_id
            || claim.attempt_id.as_str() != attempt_id
            || claim.ownership_epoch.value() != epoch
            || entry.lease_token != claim.lease.lease_token.as_str()
            || transition.schema_version != fullmag_application::COORDINATOR_TRANSITION_SCHEMA
            || checkpoint.schema_version != fullmag_application::COORDINATOR_CHECKPOINT_SCHEMA
            || checkpoint.task.run_id != claim.run_id
            || checkpoint.task.task_id != claim.task_id
            || checkpoint.task.attempt_id.as_ref() != Some(&claim.attempt_id)
            || checkpoint.task.ownership_epoch != Some(claim.ownership_epoch)
            || checkpoint.task.input_fingerprint != task.input_fingerprint
        {
            return Err(ApiError::conflict(
                "accepted stage journal claim differs from its task attempt",
            ));
        }
        checkpoint.task.fence(claim).map_err(|error| {
            ApiError::conflict(format!(
                "accepted stage checkpoint claim is invalid: {error}"
            ))
        })?;
        let timestamp = u64::try_from(entry.created_at.timestamp_millis())
            .ok()
            .filter(|value| *value > 0);
        match (entry.direction, &transition.message) {
            (Direction::Command, Message::Command(envelope)) => {
                envelope
                    .validate_for_claim(&claim.identity())
                    .map_err(|error| {
                        ApiError::conflict(format!(
                            "accepted stage command claim is invalid: {error}"
                        ))
                    })?;
                if entry.entry_id != envelope.message_id
                    || entry.sequence != envelope.sequence
                    || checkpoint.command_sequence != envelope.sequence
                    || entry.terminal
                {
                    return Err(ApiError::conflict(
                        "accepted stage command identity differs from journal",
                    ));
                }
                if let WorkerCommand::Stop { reason } = &envelope.command {
                    stop_reason = Some(reason.clone());
                }
            }
            (Direction::Event, Message::Event(envelope)) => {
                envelope
                    .validate_for_claim(&claim.identity())
                    .map_err(|error| {
                        ApiError::conflict(format!(
                            "accepted stage event claim is invalid: {error}"
                        ))
                    })?;
                if entry.entry_id != envelope.message_id
                    || entry.sequence != envelope.sequence
                    || checkpoint.event_sequence != envelope.sequence
                    || entry.terminal
                        != matches!(
                            &envelope.event,
                            WorkerEvent::Completed { .. }
                                | WorkerEvent::Failed { .. }
                                | WorkerEvent::Rejected { .. }
                        )
                {
                    return Err(ApiError::conflict(
                        "accepted stage event identity differs from journal",
                    ));
                }
                let expected_terminal = match &envelope.event {
                    WorkerEvent::Started => {
                        if saw_started || checkpoint.task.lifecycle != TaskLife::Running {
                            return Err(ApiError::conflict(
                                "accepted stage has inconsistent Started evidence",
                            ));
                        }
                        saw_started = true;
                        details.started_at_unix_ms = timestamp;
                        None
                    }
                    WorkerEvent::Completed { .. } => Some((Life::Succeeded, TaskLife::Succeeded)),
                    WorkerEvent::Stopped => Some((Life::Cancelled, TaskLife::Cancelled)),
                    WorkerEvent::Failed { reason, .. } | WorkerEvent::Rejected { reason } => {
                        failure_reason = Some(reason.clone());
                        Some((Life::Failed, TaskLife::Failed))
                    }
                    _ => None,
                };
                if let Some((lifecycle, checkpoint_lifecycle)) = expected_terminal {
                    if checkpoint.task.lifecycle != checkpoint_lifecycle {
                        return Err(ApiError::conflict(
                            "accepted terminal event differs from its checkpoint",
                        ));
                    }
                    // Interrupted has no worker event of its own. Keep its historical
                    // failure reason without inventing a process termination timestamp.
                    if task.lifecycle == Life::Interrupted && lifecycle == Life::Failed {
                        continue;
                    }
                    if task.lifecycle != lifecycle {
                        return Err(ApiError::conflict(
                            "accepted terminal event differs from task lifecycle",
                        ));
                    }
                    details.completed_at_unix_ms = timestamp;
                }
            }
            _ => {
                return Err(ApiError::conflict(
                    "accepted stage journal direction differs from its transition",
                ))
            }
        }
    }
    details.reason = match task.lifecycle {
        Life::Failed | Life::Interrupted => failure_reason,
        Life::Cancelled => stop_reason,
        _ => None,
    };
    if details
        .started_at_unix_ms
        .zip(details.completed_at_unix_ms)
        .is_some_and(|(start, end)| end < start)
    {
        details.completed_at_unix_ms = None;
    }
    Ok(details)
}

fn cursor_matches_context(cursor: &ProjectionCursor, context: &ProjectionContext) -> bool {
    cursor.api_instance_id == context.api_instance_id
        && cursor.session_id == context.session_id
        && cursor.session_epoch == context.session_epoch
        && match (
            cursor.execution_input_sha256.as_deref(),
            context.execution_input.as_ref(),
        ) {
            (Some(cursor_input), Some(identity)) => cursor_input == identity.sha256,
            _ => cursor.scene_revision == context.scene_revision,
        }
        && cursor.run_id == context.run_id
}

fn compare_magnetization_outputs(
    left: &VerifiedOutput,
    right: &VerifiedOutput,
) -> std::cmp::Ordering {
    let fullmag_application::DecodedStudyArtifact::MagnetizationState(state) = &left.decoded else {
        return std::cmp::Ordering::Less;
    };
    let fullmag_application::DecodedStudyArtifact::MagnetizationState(right_state) = &right.decoded
    else {
        return std::cmp::Ordering::Greater;
    };
    left.task_order
        .cmp(&right.task_order)
        .then_with(|| state.step.cmp(&right_state.step))
        .then_with(|| state.time_s.total_cmp(&right_state.time_s))
        .then_with(|| left.object_ref.cmp(&right.object_ref))
}

fn compare_scalar_outputs(left: &VerifiedOutput, right: &VerifiedOutput) -> std::cmp::Ordering {
    let fullmag_application::DecodedStudyArtifact::Scalar(left_scalar) = &left.decoded else {
        return std::cmp::Ordering::Less;
    };
    let fullmag_application::DecodedStudyArtifact::Scalar(right_scalar) = &right.decoded else {
        return std::cmp::Ordering::Greater;
    };
    left.task_order
        .cmp(&right.task_order)
        .then_with(|| left_scalar.step.cmp(&right_scalar.step))
        .then_with(|| left_scalar.time_s.total_cmp(&right_scalar.time_s))
        .then_with(|| scalar_identity(left_scalar).cmp(&scalar_identity(right_scalar)))
}

fn scalar_identity(scalar: &fullmag_application::StudyScalarArtifact) -> String {
    format!(
        "scalar:{}:{}:{}",
        scalar.step,
        scalar.time_s.to_bits(),
        scalar.value_si.to_bits()
    )
}

fn validate_live_intent(
    context: &ProjectionContext,
    specification: &Value,
) -> Result<(), ApiError> {
    let live = specification
        .pointer("/parameters/live_workspace")
        .and_then(Value::as_object)
        .ok_or_else(|| ApiError::conflict("accepted RunIntent has no live workspace binding"))?;
    if (!context.allow_api_instance_rebind
        && live.get("api_instance_id").and_then(Value::as_str)
            != Some(context.api_instance_id.as_str()))
        || live.get("session_id").and_then(Value::as_str) != Some(context.session_id.as_str())
        || live.get("session_epoch").and_then(Value::as_u64) != Some(context.session_epoch)
    {
        return Err(ApiError::conflict_with_code(
            "accepted_projection_live_binding_mismatch",
            "accepted RunIntent is not bound to the current API instance, session and epoch",
        ));
    }
    if let Some(identity) = context.execution_input.as_ref() {
        crate::live_execution_binding::validate_input_binding(
            specification,
            identity,
            context.scene_revision,
        )?;
    } else if live.get("scene_revision").and_then(Value::as_u64) != Some(context.scene_revision) {
        return Err(ApiError::conflict_with_code(
            "accepted_projection_live_binding_mismatch",
            "historical accepted RunIntent requires its exact scene revision",
        ));
    }
    Ok(())
}

/// Runtime capabilities of the accepted step the RunIntent targets. The
/// in-process runner publishes these with its fields; without them an
/// accepted run keeps the scratch authoring capabilities, whose registry is
/// not a resolved plan, so the quantity catalog and field routes refuse every
/// field except the prepared m.
fn accepted_step_capabilities(
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    specification: &Value,
) -> Option<fullmag_runner::BackendCapabilities> {
    let step_id = specification
        .pointer("/parameters/live_workspace/step_id")
        .and_then(Value::as_str);
    let entry = accepted
        .catalog
        .entries()
        .iter()
        .find(|entry| step_id.is_none_or(|step_id| entry.step_id() == step_id))?;
    match fullmag_runner::resolve_runtime_capabilities(entry.problem()) {
        Ok(capabilities) => Some(capabilities),
        Err(error) => {
            tracing::warn!(error = %error, "accepted step runtime capabilities are unavailable");
            None
        }
    }
}

/// The session's public status for a projected run. A run that executed one
/// interactive command (a live `run`/`relax`/... from the Control Room or a
/// `fm.connect()` script) ends that command, not the session: the session
/// returns to `awaiting_command` so the next command, which continues from
/// this run's final state, is admitted. A startup-script run ends the session.
fn session_status_after_projection(run_status: &'static str, interactive_command: bool) -> &'static str {
    match run_status {
        "waiting_for_solve" => "awaiting_command",
        "completed" | "failed" | "cancelled" if interactive_command => "awaiting_command",
        status => status,
    }
}

fn catalog_status(tasks: &[fullmag_session::FmsTaskCatalogEntry]) -> &'static str {
    if tasks.is_empty() {
        return "waiting_for_compute";
    }
    if tasks.iter().any(|task| {
        matches!(
            task.lifecycle,
            fullmag_session::FmsTaskLifecycle::Failed
                | fullmag_session::FmsTaskLifecycle::Interrupted
        )
    }) {
        return "failed";
    }
    if tasks
        .iter()
        .any(|task| task.lifecycle == fullmag_session::FmsTaskLifecycle::Cancelled)
    {
        return "cancelled";
    }
    if tasks
        .iter()
        .any(|task| task.lifecycle == fullmag_session::FmsTaskLifecycle::Stopping)
    {
        return "stopping";
    }
    if tasks
        .iter()
        .all(|task| task.lifecycle == fullmag_session::FmsTaskLifecycle::Succeeded)
    {
        return "completed";
    }
    if tasks
        .iter()
        .any(|task| task.lifecycle == fullmag_session::FmsTaskLifecycle::Running)
    {
        return "running";
    }
    "waiting_for_compute"
}

fn terminal_catalog_without_outputs(tasks: &[fullmag_session::FmsTaskCatalogEntry]) -> bool {
    !tasks.is_empty()
        && tasks.iter().all(|task| {
            matches!(
                task.lifecycle,
                fullmag_session::FmsTaskLifecycle::Failed
                    | fullmag_session::FmsTaskLifecycle::Interrupted
                    | fullmag_session::FmsTaskLifecycle::Cancelled
            ) && task.artifact_ids.is_empty()
        })
}

fn accepted_projection_status(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    tasks: &[fullmag_session::FmsTaskCatalogEntry],
) -> Result<&'static str, ApiError> {
    let catalog_status = catalog_status(tasks);
    let start_permitted = store
        .accepted_run_start_permitted(run_id)
        .map_err(|error| {
            ApiError::conflict(format!(
                "accepted run start gate cannot be read for projection: {error}"
            ))
        })?;
    Ok(projected_status_for_gate(catalog_status, start_permitted))
}

fn projected_status_for_gate(catalog_status: &'static str, start_permitted: bool) -> &'static str {
    if catalog_status == "waiting_for_compute" && !start_permitted {
        // A manual startup run has a durable whole-Study catalog before the
        // interactive Compute command. Keep the run-level gate visible so the
        // next command releases this exact run instead of creating a second
        // accepted RunIntent.
        return "waiting_for_solve";
    }
    catalog_status
}

fn load_verified_outputs(
    store: &fullmag_session::SessionStore,
    run_catalog: &fullmag_session::FmsRunCatalog,
    artifact_catalog: &fullmag_session::FmsArtifactCatalog,
    task_order: &std::collections::BTreeMap<String, usize>,
) -> Result<Vec<VerifiedOutput>, ApiError> {
    let mut outputs = Vec::new();
    for task in &run_catalog.tasks {
        if task.lifecycle != fullmag_session::FmsTaskLifecycle::Succeeded {
            continue;
        }
        let (Some(attempt_id), Some(ownership_epoch)) =
            (task.attempt_id.as_deref(), task.ownership_epoch)
        else {
            return Err(ApiError::conflict(
                "succeeded accepted task has no attempt/ownership identity",
            ));
        };
        let task_order = task_order.get(&task.task_id).copied().ok_or_else(|| {
            ApiError::conflict(
                "accepted task is not present in the canonical Study execution order",
            )
        })?;
        let mut manifests = artifact_catalog.entries.iter().filter(|entry| {
            entry.artifact_type == "study_output_manifest"
                && entry.task_id == task.task_id
                && entry.attempt_id == attempt_id
                && entry.ownership_epoch == ownership_epoch
                && entry.status == fullmag_session::FmsArtifactStatus::Published
                && task.artifact_ids.contains(&entry.artifact_id)
        });
        let Some(manifest_entry) = manifests.next() else {
            return Err(ApiError::conflict(
                "succeeded accepted task has no published output manifest",
            ));
        };
        if manifests.next().is_some() {
            return Err(ApiError::conflict(
                "accepted task has multiple published output manifests",
            ));
        }
        let manifest_ref = manifest_entry
            .object_ref
            .as_deref()
            .filter(|object_ref| *object_ref == manifest_entry.content_sha256)
            .ok_or_else(|| ApiError::conflict("accepted output manifest digest is not pinned"))?;
        let manifest_bytes = store
            .cas()
            .get(manifest_ref)
            .map_err(|error| ApiError::internal(format!("read accepted output manifest: {error}")))?
            .ok_or_else(|| ApiError::conflict("accepted output manifest is missing from CAS"))?;
        let manifest: fullmag_session::FmsStudyOutputManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|error| {
                ApiError::conflict(format!("accepted output manifest is invalid: {error}"))
            })?;
        manifest.validate().map_err(|error| {
            ApiError::conflict(format!(
                "accepted output manifest failed validation: {error}"
            ))
        })?;
        if manifest.run_id != run_catalog.run_id
            || manifest.task_id != task.task_id
            || manifest.attempt_id != attempt_id
            || manifest.ownership_epoch != ownership_epoch
        {
            return Err(ApiError::conflict(
                "accepted output manifest ownership identity mismatch",
            ));
        }
        let step_id = manifest.step_id.clone();
        let accepted_state_ref = manifest.accepted_state_ref.clone();
        for output in manifest.outputs {
            let artifact = artifact_catalog
                .entries
                .iter()
                .find(|entry| {
                    entry.artifact_id == output.artifact_id
                        && entry.task_id == task.task_id
                        && entry.attempt_id == attempt_id
                        && entry.ownership_epoch == ownership_epoch
                        && entry.status == fullmag_session::FmsArtifactStatus::Published
                        && entry.object_ref.as_deref() == Some(output.object_ref.as_str())
                        && entry.content_sha256 == output.content_sha256
                        && entry.study_output.as_ref().is_some_and(|study_output| {
                            study_output.step_id == manifest.step_id
                                && study_output.port_id == output.port_id
                                && study_output.case_id == output.case_id
                        })
                })
                .ok_or_else(|| {
                    ApiError::conflict("accepted output is not pinned by the artifact catalog")
                })?;
            let object_ref = artifact
                .object_ref
                .clone()
                .ok_or_else(|| ApiError::conflict("accepted output has no CAS reference"))?;
            let bytes = store
                .cas()
                .get(&object_ref)
                .map_err(|error| ApiError::internal(format!("read accepted output CAS: {error}")))?
                .ok_or_else(|| ApiError::conflict("accepted output CAS object is missing"))?;
            let decoded = fullmag_application::decode_study_artifact(
                &fullmag_application::ResolvedStudyArtifact {
                    artifact_id: output.artifact_id.clone(),
                    object_ref: object_ref.clone(),
                    data_kind: output.data_kind.clone(),
                    codec_id: output.codec_id.clone(),
                    codec_version: output.codec_version.clone(),
                },
                &bytes,
            )
            .map_err(|error| {
                ApiError::conflict(format!("accepted output decode failed: {error}"))
            })?;
            outputs.push(VerifiedOutput {
                task_order,
                step_id: step_id.clone(),
                object_ref,
                data_kind: output.data_kind,
                accepted_state_ref: accepted_state_ref.clone(),
                decoded,
            });
        }
    }
    Ok(outputs)
}

#[derive(Debug, Clone)]
struct PreparedProjectionDomain {
    preparation_id: String,
    execution_plan: Arc<fullmag_ir::ExecutionPlanIR>,
    plan_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FemProjectionDomainIdentity {
    backend: &'static str,
    fe_order: u32,
    node_count: usize,
    topology_fingerprint: String,
}

/// Ensure that the state output is preceded by the exact preparation receipt
/// for its accepted Study step.  The existing preparation bridge owns receipt,
/// plan, native mesh, and current-session publication; this projector only
/// selects the step and verifies the decoded output against that pinned plan.
async fn ensure_stage_preparation(
    state: &Arc<AppState>,
    context: &ProjectionContext,
    projection: &DurableProjection,
) -> Result<Option<PreparedProjectionDomain>, ApiError> {
    let Some(output) = projection.latest_state.as_ref() else {
        return Ok(None);
    };
    let fullmag_application::DecodedStudyArtifact::MagnetizationState(state_output) =
        &output.decoded
    else {
        return Ok(None);
    };
    let prepared = ensure_stage_preparation_for_step(
        state,
        context,
        &output.step_id,
        output.accepted_state_ref.as_ref(),
    )
    .await?;
    validate_accepted_state_domain(
        state_output,
        &prepared.execution_plan,
        &prepared.plan_fingerprint,
        context.run_id.as_str(),
        output.step_id.as_str(),
        output.accepted_state_ref.as_ref(),
    )?;
    Ok(Some(prepared))
}

async fn ensure_stage_preparation_for_step(
    state: &Arc<AppState>,
    context: &ProjectionContext,
    step_id: &str,
    accepted_state_ref: Option<&fullmag_quantities::AcceptedStateRef>,
) -> Result<PreparedProjectionDomain, ApiError> {
    let existing = {
        let current = state.current_live_state.read().await;
        current.as_ref().and_then(|snapshot| {
            let workspace = snapshot.mesh_workspace.as_ref()?;
            if workspace.get("accepted_run_id").and_then(Value::as_str)
                != Some(context.run_id.as_str())
                || workspace.get("accepted_step_id").and_then(Value::as_str)
                    != Some(step_id)
            {
                return None;
            }
            let preparation_id = workspace.get("preparation_id").and_then(Value::as_str)?;
            let plan_fingerprint = workspace.get("plan_fingerprint").and_then(Value::as_str)?;
            if !accepted_state_ref_matches_plan(accepted_state_ref, context.run_id.as_str(), step_id, plan_fingerprint) {
                return None;
            }
            let execution_plan = snapshot.metadata.as_ref()?.execution_plan()?;
            Some(PreparedProjectionDomain {
                preparation_id: preparation_id.to_owned(),
                execution_plan,
                plan_fingerprint: plan_fingerprint.to_owned(),
            })
        })
    };

    let prepared = if let Some(existing) = existing {
        reread_durable_stage_preparation(state, context, step_id, &existing).await?;
        existing
    } else {
        let live_context = crate::types::CurrentLiveRequestContext {
            session_id: context.session_id.clone(),
            run_id: Some(context.run_id.clone()),
            session_epoch: context.session_epoch,
            request_scope_epoch: format!("{}:{}", context.api_instance_id, context.session_epoch),
        };
        let published =
            crate::live_scene_preparation::publish_accepted_task_preparation(
                state,
                &live_context,
                &context.run_id,
                step_id,
                "accepted_projection_stage_preparation",
            )
            .await?;
        PreparedProjectionDomain {
            preparation_id: published.read_model.preparation_id,
            execution_plan: Arc::new(published.read_model.execution_plan),
            plan_fingerprint: published.read_model.plan_fingerprint,
        }
    };
    Ok(prepared)
}

/// Re-read the durable stage and its exact task receipt before trusting an
/// in-memory mesh workspace. A matching JSON snapshot is only a cache; it
/// cannot authorize output after deletion, corruption, or stage substitution.
async fn reread_durable_stage_preparation(
    state: &Arc<AppState>,
    context: &ProjectionContext,
    step_id: &str,
    domain: &PreparedProjectionDomain,
) -> Result<(), ApiError> {
    let store_root = state.submit_store_root.clone().ok_or_else(|| {
        ApiError::with_status_and_code(
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "accepted_projection_store_unavailable",
            "accepted projection requires the configured durable run store",
        )
    })?;
    let run_id = context.run_id.clone();
    let step_id = step_id.to_owned();
    let expected_preparation_id = domain.preparation_id.clone();
    let expected_plan_fingerprint = domain.plan_fingerprint.clone();
    tokio::task::spawn_blocking(move || {
        let store = fullmag_session::SessionStore::open_existing(&store_root).map_err(|error| {
            ApiError::with_status_and_code(
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                "accepted_projection_store_unavailable",
                format!("failed to open accepted projection store: {error}"),
            )
        })?;
        let stage = store
            .read_accepted_stage_preparation_receipt(&run_id, &step_id)
            .map_err(|error| {
                ApiError::conflict_with_code(
                    "accepted_projection_stage_receipt_invalid",
                    format!("accepted stage preparation receipt read failed: {error}"),
                )
            })?;
        let Some(stage) = stage else {
            return Err(ApiError::conflict_with_code(
                "accepted_projection_stage_receipt_missing",
                "accepted projection has no durable stage preparation receipt",
            ));
        };
        let task_id = fullmag_session::task_id_for_study_step(&run_id, &step_id)
            .map_err(|error| {
                ApiError::conflict(format!("accepted projection step identity is invalid: {error}"))
            })?;
        let task = store
            .read_task_preparation_receipt(&run_id, &task_id)
            .map_err(|error| {
                ApiError::conflict_with_code(
                    "accepted_projection_task_receipt_invalid",
                    format!("accepted task preparation receipt read failed: {error}"),
                )
            })?;
        let Some(task) = task else {
            return Err(ApiError::conflict_with_code(
                "accepted_projection_task_receipt_missing",
                "accepted projection has no durable task preparation receipt",
            ));
        };
        let expected_stage =
            fullmag_session::FmsAcceptedStagePreparationReceipt::from_task_receipt(&task)
                .map_err(|error| {
                    ApiError::conflict_with_code(
                        "accepted_projection_stage_receipt_invalid",
                        format!("accepted task preparation receipt is invalid: {error}"),
                    )
                })?;
        if !stage_receipt_matches_projection(
            Some(&stage),
            Some(&expected_stage),
            &run_id,
            &step_id,
            &expected_preparation_id,
            &expected_plan_fingerprint,
        ) {
            return Err(ApiError::conflict_with_code(
                "accepted_projection_stage_receipt_mismatch",
                "durable accepted stage does not match the live projection domain",
            ));
        }
        Ok(())
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted projection receipt task failed: {error}")))?
}

fn stage_receipt_matches_projection(
    stage: Option<&fullmag_session::FmsAcceptedStagePreparationReceipt>,
    task_stage: Option<&fullmag_session::FmsAcceptedStagePreparationReceipt>,
    run_id: &str,
    step_id: &str,
    preparation_id: &str,
    plan_fingerprint: &str,
) -> bool {
    let Some(stage) = stage else {
        return false;
    };
    let Some(task_stage) = task_stage else {
        return false;
    };
    stage.same_immutable_payload(task_stage)
        && stage.run_id == run_id
        && stage.step_id == step_id
        && stage.preparation_id == preparation_id
        && stage.plan_fingerprint == plan_fingerprint
}

fn accepted_state_ref_matches_plan(
    accepted_state_ref: Option<&fullmag_quantities::AcceptedStateRef>,
    run_id: &str,
    step_id: &str,
    plan_fingerprint: &str,
) -> bool {
    let Some(reference) = accepted_state_ref else {
        return true;
    };
    reference.id.run_id == run_id
        && reference.id.stage_id.as_deref() == Some(step_id)
        && reference.id.domain_digest == plan_fingerprint
}

fn validate_live_magnetization_domain(
    observation: &crate::accepted_study_worker::AcceptedLiveObservation,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<(), ApiError> {
    let reference = observation
        .header
        .magnetization
        .as_ref()
        .ok_or_else(|| domain_mismatch("accepted live field has no payload reference"))?;
    let values = observation
        .magnetization_values
        .as_ref()
        .ok_or_else(|| domain_mismatch("accepted live field payload was not read"))?;
    let (expected_backend, expected_sample_count) = match &execution_plan.backend_plan {
        fullmag_ir::BackendPlanIR::Fdm(plan)
            if matches!(observation.header.realization.as_str(), "fdm_cpu" | "fdm_gpu")
                && reference.fem_local_node_map.is_none() =>
        {
            ("fdm", plan.initial_magnetization.len())
        }
        fullmag_ir::BackendPlanIR::FdmMultilayer(plan)
            if matches!(observation.header.realization.as_str(), "fdm_cpu" | "fdm_gpu")
                && reference.fem_local_node_map.is_none() =>
        {
            let mut expected_offset = 0usize;
            for layer in &plan.layers {
                expected_offset = expected_offset
                    .checked_add(layer.initial_magnetization.len())
                    .ok_or_else(|| domain_mismatch("pinned FDM multilayer sample count overflows"))?;
            }
            ("fdm_multilayer", expected_offset)
        }
        fullmag_ir::BackendPlanIR::Fem(plan)
            if plan.fe_order == 1
                && matches!(observation.header.realization.as_str(), "fem_cpu" | "fem_gpu") =>
        {
            let map = reference
                .fem_local_node_map
                .as_ref()
                .ok_or_else(|| domain_mismatch("accepted live FEM field has no native node-map identity"))?;
            let node_count = plan.mesh.nodes.len();
            if map.mesh_generation_id.is_empty()
                || map.node_count != node_count
                || !fullmag_quantities::is_canonical_sha256(&map.local_node_index_map_sha256)
            {
                return Err(domain_mismatch(
                    "accepted live FEM node-map identity does not match the pinned P1 node domain",
                ));
            }
            ("fem", node_count)
        }
        _ => {
            return Err(domain_mismatch(
                "accepted live field requires an explicitly mapped FDM or native FEM CPU/GPU lane",
            ));
        }
    };
    let expected_layout = fullmag_runner::study_magnetization_layout_for_plan(execution_plan)
        .map_err(|error| {
            domain_mismatch(format!(
                "pinned live {expected_backend} layout is unavailable: {}",
                error.message
            ))
        })?;
    let expected_fingerprint =
        fullmag_application::study_state_layout_sha256(&expected_layout).map_err(|error| {
            domain_mismatch(format!("pinned live FDM fingerprint is unavailable: {error}"))
        })?;
    if reference.layout != expected_layout
        || reference.space_fingerprint != expected_fingerprint
        || usize::try_from(reference.sample_count).ok() != Some(expected_sample_count)
        || values.len() != expected_sample_count
        || !reference.source_time_s.is_finite()
        || reference.source_time_s < 0.0
        || !reference.solver_dt_s.is_finite()
        || reference.solver_dt_s < 0.0
    {
        return Err(domain_mismatch(
            "accepted live field does not exactly match the pinned native layout and source clock",
        ));
    }
    Ok(())
}

fn validate_accepted_state_domain(
    state: &fullmag_application::MagnetizationStateArtifact,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
    plan_fingerprint: &str,
    run_id: &str,
    step_id: &str,
    accepted_state_ref: Option<&fullmag_quantities::AcceptedStateRef>,
) -> Result<(), ApiError> {
    if !accepted_state_ref_matches_plan(accepted_state_ref, run_id, step_id, plan_fingerprint) {
        return Err(domain_mismatch(
            "accepted state identity does not match the pinned run, stage, and preparation receipt",
        ));
    }

    let backend = state
        .layout
        .get("backend")
        .and_then(Value::as_str)
        .ok_or_else(|| domain_mismatch("accepted state layout has no backend identity"))?;
    match (&execution_plan.backend_plan, backend) {
        (fullmag_ir::BackendPlanIR::Fdm(_), "fdm")
        | (fullmag_ir::BackendPlanIR::FdmMultilayer(_), "fdm_multilayer") => {
            validate_exact_study_layout(&state.layout, execution_plan)?;
        }
        (fullmag_ir::BackendPlanIR::Fem(plan), "fem") => {
            validate_fem_domain(
                &state.layout,
                &FemProjectionDomainIdentity {
                    backend: "fem",
                    fe_order: plan.fe_order,
                    node_count: plan.mesh.nodes.len(),
                    topology_fingerprint: plan.mesh.topology_fingerprint_v6(),
                },
            )?;
        }
        (fullmag_ir::BackendPlanIR::FemEigen(plan), "fem_eigen") => {
            validate_fem_domain(
                &state.layout,
                &FemProjectionDomainIdentity {
                    backend: "fem_eigen",
                    fe_order: plan.fe_order,
                    node_count: plan.mesh.nodes.len(),
                    topology_fingerprint: plan.mesh.topology_fingerprint_v6(),
                },
            )?;
        }
        (fullmag_ir::BackendPlanIR::FemFrequencyResponse(plan), "fem_frequency_response") => {
            validate_fem_domain(
                &state.layout,
                &FemProjectionDomainIdentity {
                    backend: "fem_frequency_response",
                    fe_order: plan.fe_order,
                    node_count: plan.mesh.nodes.len(),
                    topology_fingerprint: plan.mesh.topology_fingerprint_v6(),
                },
            )?;
        }
        (fullmag_ir::BackendPlanIR::AntennaExternalLeadInspection(_), _) => {
            return Err(domain_mismatch(
                "magnetization output cannot use an antenna-only preparation domain",
            ));
        }
        (expected, actual) => {
            return Err(domain_mismatch(format!(
                "accepted state backend `{actual}` does not match pinned plan `{expected:?}`",
            )));
        }
    }
    Ok(())
}

fn validate_exact_study_layout(
    layout: &Value,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<(), ApiError> {
    let expected =
        fullmag_runner::study_magnetization_layout_for_plan(execution_plan).map_err(|error| {
            domain_mismatch(format!(
                "pinned study layout is unavailable: {}",
                error.message
            ))
        })?;
    if layout != &expected {
        return Err(domain_mismatch(
            "accepted state layout does not exactly match the pinned study domain",
        ));
    }
    Ok(())
}

fn validate_fem_domain(
    layout: &Value,
    expected: &FemProjectionDomainIdentity,
) -> Result<(), ApiError> {
    let actual_nodes = layout
        .get("n_nodes")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok());
    let actual_order = layout.get("fe_order").and_then(Value::as_u64);
    if layout.get("backend").and_then(Value::as_str) != Some(expected.backend)
        || actual_order != Some(u64::from(expected.fe_order))
        || actual_nodes != Some(expected.node_count)
        || layout.get("topology_fingerprint").and_then(Value::as_str)
            != Some(expected.topology_fingerprint.as_str())
    {
        return Err(domain_mismatch(format!(
            "accepted FEM field does not match pinned {} topology",
            expected.backend
        )));
    }
    Ok(())
}

fn domain_mismatch(message: impl Into<String>) -> ApiError {
    ApiError::conflict_with_code("accepted_projection_domain_mismatch", message)
}

async fn clear_stale_magnetization(
    state: &Arc<AppState>,
    context: &ProjectionContext,
) -> Result<(), ApiError> {
    let transition = state.current_live_session_transition.lock().await;
    // Build the cleared candidate from a read-side clone; the write lock is
    // held only for the fenced swap so health/status readers do not queue
    // behind the frame application on large domains.
    let mut next = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    ensure_projection_context(state, context, &next)?;
    if next.latest_fields.get("m").is_none() {
        return Ok(());
    }
    let publication_fence = ProjectionPublicationFence::capture(&next)?;
    let mut fields = next.latest_fields.clone();
    fields.remove("m");
    let stale = fields.entries().filter(|(_, value)| {
        value.pointer("/provenance/source").and_then(Value::as_str) == Some("accepted_live_observation")
    }).map(|(id, _)| id.clone()).collect::<Vec<_>>();
    for id in stale { fields.remove(&id); }
    let sequence = next
        .terminal_field_generations
        .get(&context.run_id)
        .copied()
        .unwrap_or_default()
        .saturating_add(1);
    crate::session::apply_current_live_field_frame_to_candidate(
        &mut next,
        CurrentLiveFieldFrameRequest {
            session_id: context.session_id.clone(),
            latest_fields: Some(fields),
            replace_latest_fields: true,
            field_generation: Some(CurrentLiveFieldGeneration {
                run_id: context.run_id.clone(),
                sequence,
            }),
            preview_fields: None,
            clear_preview_cache: true,
        },
        None,
    )?;
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime_state =
        crate::current_live_realtime_state_from_snapshot(state, &next, display_revision).await;
    let previous = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        ensure_projection_context(state, context, snapshot)?;
        if ProjectionPublicationFence::capture(snapshot)? != publication_fence {
            return Err(ApiError::conflict_with_code(
                "accepted_projection_current_state_changed",
                "current live resources changed while stale magnetization was being cleared",
            ));
        }
        std::mem::replace(&mut *current, Some(next))
    };
    drop(transition);
    if let Some(previous) = previous {
        let _ = tokio::task::spawn_blocking(move || drop(previous));
    }
    crate::router_v2::handlers::sessions::status::record_current_live_heartbeat(state).await;
    crate::publish_current_live_realtime_batch_changed(state, &realtime_state, true, 100).await
}

fn ensure_projection_context(
    state: &AppState,
    context: &ProjectionContext,
    snapshot: &SessionStateResponse,
) -> Result<(), ApiError> {
    if snapshot.session.session_id != context.session_id
        || snapshot.run.as_ref().map(|run| run.run_id.as_str()) != Some(context.run_id.as_str())
        || snapshot.scene_document.as_ref().map(|scene| scene.revision)
            != Some(context.scene_revision)
        || state
            .current_live_session_epoch
            .load(std::sync::atomic::Ordering::Acquire)
            != context.session_epoch
    {
        return Err(ApiError::conflict_with_code(
            "accepted_projection_current_session_changed",
            "current live session changed while accepted output was being projected",
        ));
    }
    Ok(())
}

fn profile_content_identity(profile: &crate::schemas::diagnostics::SolverProfileResource) -> Result<String, ApiError> {
    let mut value = serde_json::to_value(profile)
        .map_err(|error| ApiError::internal(format!("serialize operation diagnostics identity: {error}")))?;
    value.as_object_mut().ok_or_else(|| ApiError::internal("solver profile resource must be an object"))?
        .remove("revision");
    Ok(fullmag_session::canonical_json_sha256(&value))
}

fn replace_operation_profile(
    current: &mut crate::schemas::diagnostics::SolverProfileResource,
    mut candidate: crate::schemas::diagnostics::SolverProfileResource,
) -> Result<bool, ApiError> {
    if profile_content_identity(&candidate)? == profile_content_identity(current)? { return Ok(false); }
    candidate.revision = current.revision.wrapping_add(1);
    *current = candidate;
    Ok(true)
}

async fn apply_projection(
    state: &Arc<AppState>,
    context: &ProjectionContext,
    projection: DurableProjection,
) -> Result<(), ApiError> {
    let mut next = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    ensure_projection_context(state, context, &next)?;
    let publication_fence = ProjectionPublicationFence::capture(&next)?;
    let display_revision = state.current_display_selection.read().await.revision;

    let profile_changed = if let Some(profile) = projection.solver_profile.as_ref() {
        // The recovered journal, rather than a default startup frame, owns a
        // later explicit next-admission config (including Disable).
        let configured = state.current_command_ledger.lock().await.iter().rev()
            .find(|record| record.command.kind == "set_solver_profile"
                && record.status == crate::types::CommandLifecycleState::Completed)
            .and_then(|record| record.command.profile.clone());
        let config = match configured {
            Some(value) => serde_json::from_value(value)
                .map_err(|error| ApiError::conflict(format!("invalid recovered solver profile configuration: {error}")))?,
            None => profile.config.clone(),
        };
        let mut candidate = profile.clone();
        candidate.config = config;
        candidate.state = if candidate.config.enabled { "enabled" } else { "disabled" }.into();
        if !candidate.config.enabled { candidate.operation_samples.clear(); }
        replace_operation_profile(&mut next.solver_profile, candidate)?
    } else if !next.solver_profile.operation_samples.is_empty() {
        next.solver_profile.operation_samples.clear();
        next.solver_profile.revision = next.solver_profile.revision.wrapping_add(1);
        true
    } else { false };
    let previous_status = next.session.status.clone();
    let terminal = matches!(projection.status, "completed" | "failed" | "cancelled");
    let mut changed = profile_changed;
    if let Some(run) = next.run.as_mut() {
        if run.status != projection.status {
            run.status = projection.status.to_string();
            changed = true;
        }
        if let Some(scalar) = projection.latest_total_energy.as_ref() {
            if scalar.time_s.is_finite() && scalar.time_s >= 0.0 {
                if run.final_time != Some(scalar.time_s) {
                    run.final_time = Some(scalar.time_s);
                    changed = true;
                }
                if run.final_e_total != Some(scalar.value_si) {
                    run.final_e_total = Some(scalar.value_si);
                    changed = true;
                }
            }
        }
        if let Some(fullmag_application::DecodedStudyArtifact::MagnetizationState(state_output)) =
            projection
                .latest_state
                .as_ref()
                .map(|output| &output.decoded)
        {
            if state_output.time_s.is_finite()
                && state_output.time_s >= 0.0
                && run.final_time != Some(state_output.time_s)
            {
                // The observation timestamp is a real value from the pinned
                // accepted state artifact. It is useful even for studies that
                // do not publish an E_total scalar output.
                run.final_time = Some(state_output.time_s);
                changed = true;
            }
        }
    }
    let public_status =
        session_status_after_projection(projection.status, projection.interactive_command);
    if next.session.status != public_status {
        next.session.status = public_status.to_string();
        changed = true;
    }
    next.runtime_status = crate::session::build_runtime_status_view(public_status);
    if let Some(capabilities) = projection.resolved_capabilities.as_ref() {
        let unchanged = next.capabilities.as_ref().is_some_and(|current| {
            serde_json::to_value(current).ok() == serde_json::to_value(capabilities).ok()
        });
        if !unchanged {
            next.capabilities = Some(capabilities.clone());
            changed = true;
        }
    }
    if let Some(live) = next.live_state.as_mut() {
        if live.status != public_status {
            live.status = public_status.to_string();
            changed = true;
        }
    }
    if terminal && !projection.interactive_command && next.session.finished_at_unix_ms == 0 {
        next.session.finished_at_unix_ms = unix_time_millis_now();
        changed = true;
    }

    if crate::session::replace_current_live_stage_execution(
        &mut next,
        projection.stage_execution.clone(),
    ) {
        changed = true;
    }
    if let Some(capabilities) = projection
        .accepted_runtime_capabilities
        .as_ref()
        .filter(|capabilities| {
            capabilities
                .resolved_quantity_registry
                .as_ref()
                .is_some_and(|registry| {
                    registry.source == fullmag_runner::QuantityProviderRegistrySource::ResolvedPlan
                })
        })
    {
        if let Some(registry) = capabilities.resolved_quantity_registry.as_ref() {
            let same_plan_registry = next.capabilities.as_ref().is_some_and(|current| {
                current.engine_id == capabilities.engine_id
                    && current.resolved_quantity_registry.as_ref() == Some(registry)
            });
            if !same_plan_registry {
                next.capabilities = Some(capabilities.clone());
                changed = true;
            }
            let resolved_lane = match capabilities.engine_id {
                fullmag_runner::RuntimeEngineId::FdmCpuReference => Some(("fdm", "cpu")),
                fullmag_runner::RuntimeEngineId::FdmCuda => Some(("fdm", "gpu")),
                fullmag_runner::RuntimeEngineId::FemCpuNative => Some(("fem", "cpu")),
                fullmag_runner::RuntimeEngineId::FemNativeGpu => Some(("fem", "gpu")),
                _ => None,
            };
            if let Some((resolved_backend, resolved_device)) = resolved_lane {
                if next.session.resolved_backend.as_deref() != Some(resolved_backend) {
                    next.session.resolved_backend = Some(resolved_backend.to_owned());
                    changed = true;
                }
                if next.session.resolved_device.as_deref() != Some(resolved_device) {
                    next.session.resolved_device = Some(resolved_device.to_owned());
                    changed = true;
                }
                if next.session.resolved_engine_id.as_deref()
                    != Some(capabilities.engine_id.as_str())
                {
                    next.session.resolved_engine_id =
                        Some(capabilities.engine_id.as_str().to_owned());
                    changed = true;
                }
                if next.session.resolved_precision.as_deref() != Some(registry.precision.as_str()) {
                    next.session.resolved_precision = Some(registry.precision.clone());
                    changed = true;
                }
                // Complete the identity from the same verified immutable plan,
                // never from requested intent. A partial identity is correctly
                // rejected by the public capability snapshot and hides fields.
                if let Some(mode) = projection.accepted_runtime_mode {
                    let mode = match mode {
                        fullmag_ir::ExecutionMode::Strict => "strict",
                        fullmag_ir::ExecutionMode::Extended => "extended",
                        fullmag_ir::ExecutionMode::Hybrid => "hybrid",
                    };
                    if next.session.resolved_mode.as_deref() != Some(mode) {
                        next.session.resolved_mode = Some(mode.to_owned());
                        changed = true;
                    }
                }
            }
        }
    } else if terminal && projection.latest_state.is_some() {
        let stale_resolved_plan = next
            .capabilities
            .as_ref()
            .and_then(|current| {
                current
                    .resolved_quantity_registry
                    .as_ref()
                    .filter(|registry| {
                        registry.source
                            == fullmag_runner::QuantityProviderRegistrySource::ResolvedPlan
                    })
                    .map(|_| current.engine_id)
            });
        if let Some(engine_id) = stale_resolved_plan {
            next.capabilities = None;
            changed = true;
            if next.session.resolved_engine_id.as_deref() == Some(engine_id.as_str()) {
                next.session.resolved_backend = None;
                next.session.resolved_device = None;
                next.session.resolved_engine_id = None;
                next.session.resolved_precision = None;
                next.session.resolved_mode = None;
                changed = true;
            }
        }
    }
    if let Some(stats) = projection.live_observation.as_ref()
        .and_then(|(_, observation)| observation.header.stats.as_ref()) {
        if stats.kind.is_physical_observation() {
            let row = crate::types::ScalarRow {
                kind: stats.kind.clone(),
                solver_progress: stats.solver_progress.clone(),
                observation_frame: None,
                step: stats.step,
                time: stats.time,
                solver_dt: stats.dt,
                error_estimate: stats.error_estimate,
                max_error: stats.max_error,
                dt_suggested: stats.dt_suggested,
                rejected_attempts: stats.rejected_attempts,
                pseudo_time_s: stats.pseudo_time_s,
                active_runtime_s: None,
                mx: stats.mx,
                my: stats.my,
                mz: stats.mz,
                e_ex: stats.e_ex,
                e_demag: stats.e_demag,
                e_ext: stats.e_ext,
                e_ani: stats.e_ani,
                e_dmi: stats.e_dmi,
                e_rotated_dmi: Some(stats.e_rotated_dmi),
                e_total: stats.e_total,
                max_dm_dt: stats.max_dm_dt,
                max_h_eff: stats.max_h_eff,
                max_h_demag: stats.max_h_demag,
                max_torque_Apm: stats.max_torque_Apm,
                max_torque_T: stats.max_torque_T,
                per_object_scalars: Default::default(),
                table_expressions: Vec::new(),
            };
            if row.is_physical_observation() {
                let scalar_revision = next.scalar_revision;
                crate::session::apply_current_live_scalar_frame(
                    &mut next,
                    crate::types::CurrentLiveScalarFrameRequest {
                        session_id: context.session_id.clone(),
                        latest_scalar_row: Some(row),
                    },
                )?;
                changed |= next.scalar_revision != scalar_revision;
            }
        }
    }

    let live_stage_is_newer = projection.live_observation.as_ref().is_some_and(
        |(live_order, _)| {
            projection
                .latest_state
                .as_ref()
                .is_none_or(|state_output| *live_order >= state_output.task_order)
        },
    );
    let live_field = projection.live_observation.as_ref().and_then(|(order, observation)| {
        (live_stage_is_newer && projection.latest_state.as_ref().is_none_or(|state| *order >= state.task_order))
            .then_some(observation)
            .filter(|observation| observation.magnetization_values.is_some())
    });
    if let Some(observation) = live_field {
        let reference = observation
            .header
            .magnetization
            .as_ref()
            .ok_or_else(|| domain_mismatch("accepted live field has no payload reference"))?;
        let values = observation
            .magnetization_values
            .as_ref()
            .ok_or_else(|| domain_mismatch("accepted live field payload was not read"))?;
        let frame = accepted_output_frame(&next, reference.source_step, reference.source_time_s)?;
        let mut fields = crate::types::LatestFields::default();
        fields.insert(
            "m".to_string(),
            json!({
                "source_step": reference.source_step,
                "source_time_seconds": reference.source_time_s,
                "solver_dt": reference.solver_dt_s,
                "source_revision": reference.sequence,
                "carrier_fingerprint": reference.space_fingerprint,
                "values": values,
                "layout": reference.layout,
                "provenance": {
                    "source": "accepted_live_observation",
                    "run_id": observation.header.run_id,
                    "task_id": observation.header.task_id,
                    "step_id": observation.header.step_id,
                    "attempt_id": observation.header.attempt_id,
                    "ownership_epoch": observation.header.ownership_epoch,
                    "realization": observation.header.realization,
                    "fem_local_node_map": reference.fem_local_node_map,
                    "observation_identity": format!(
                        "{}:{}:{}",
                        observation.header.task_id,
                        observation.header.attempt_id,
                        observation.header.ownership_epoch
                    ),
                    "sequence": reference.sequence,
                    "written_at_unix_ms": observation.header.written_at_unix_ms,
                },
                "observation_frame": frame,
            }),
        );
        let provenance = fields.get("m").and_then(|field| field.get("provenance"))
            .cloned().ok_or_else(|| domain_mismatch("accepted live provenance missing"))?;
        for field in &observation.fields {
            if field.quantity_id == "m" || field.layout != reference.layout {
                return Err(domain_mismatch("accepted live quantity carrier differs from magnetization"));
            }
            fields.insert(field.quantity_id.clone(), json!({
                "values": field.values, "n_comp": field.n_comp,
                "layout": field.layout, "carrier_id": field.carrier_id,
                "spatial_kind": field.spatial_kind,
                "carrier_fingerprint": reference.space_fingerprint,
                "source_step": reference.source_step, "source_time_seconds": reference.source_time_s,
                "solver_dt": reference.solver_dt_s, "source_revision": reference.sequence,
                "observation_frame": frame, "provenance": provenance,
            }));
        }
        let field_revision = crate::router_v2::handlers::sessions::status::field_revision(&next);
        let generation = next
            .terminal_field_generations
            .get(&context.run_id)
            .copied()
            .unwrap_or_default()
            .saturating_add(1);
        crate::session::apply_current_live_accepted_field_frame(
            &mut next,
            CurrentLiveFieldFrameRequest {
                session_id: context.session_id.clone(),
                latest_fields: Some(fields),
                replace_latest_fields: false,
                field_generation: Some(CurrentLiveFieldGeneration {
                    run_id: context.run_id.clone(),
                    sequence: generation,
                }),
                preview_fields: None,
                clear_preview_cache: false,
            },
            frame,
        )?;
        changed |= crate::router_v2::handlers::sessions::status::field_revision(&next) != field_revision;
    } else if live_stage_is_newer {
        let active_identity = projection.live_observation_identity.as_deref();
        let displayed_identity = next
            .latest_fields
            .get("m")
            .and_then(|field| field.pointer("/provenance/observation_identity"))
            .and_then(Value::as_str);
        let expected_sequence = projection
            .live_observation
            .as_ref()
            .and_then(|(_, observation)| observation.header.magnetization.as_ref())
            .map(|reference| reference.sequence);
        let displayed_sequence = next
            .latest_fields
            .get("m")
            .and_then(|field| field.pointer("/provenance/sequence"))
            .and_then(Value::as_u64);
        let stale_field = active_identity.is_some_and(|identity| {
            displayed_identity != Some(identity)
                || expected_sequence.is_some_and(|sequence| {
                    displayed_sequence != Some(sequence)
                })
        });
        if stale_field && next.latest_fields.get("m").is_some() {
            let mut fields = next.latest_fields.clone();
            fields.remove("m");
            let stale = fields.entries().filter(|(_, value)| {
                value.pointer("/provenance/source").and_then(Value::as_str) == Some("accepted_live_observation")
            }).map(|(id, _)| id.clone()).collect::<Vec<_>>();
            for id in stale { fields.remove(&id); }
            let field_revision = crate::router_v2::handlers::sessions::status::field_revision(&next);
            let generation = next
                .terminal_field_generations
                .get(&context.run_id)
                .copied()
                .unwrap_or_default()
                .saturating_add(1);
            crate::session::apply_current_live_field_frame(
                &mut next,
                CurrentLiveFieldFrameRequest {
                    session_id: context.session_id.clone(),
                    latest_fields: Some(fields),
                    replace_latest_fields: true,
                    field_generation: Some(CurrentLiveFieldGeneration {
                        run_id: context.run_id.clone(),
                        sequence: generation,
                    }),
                    preview_fields: None,
                    clear_preview_cache: true,
                },
            )?;
            changed |= crate::router_v2::handlers::sessions::status::field_revision(&next) != field_revision;
        }
    } else {
        if let Some(output) = projection.latest_state.as_ref() {
            if let fullmag_application::DecodedStudyArtifact::MagnetizationState(state_output) =
                &output.decoded
            {
                let artifact_revision = projection.artifact_catalog_revision.ok_or_else(|| {
                    ApiError::conflict(
                        "accepted output cannot be projected without an artifact catalog revision",
                    )
                })?;
                let frame = accepted_output_frame(&next, state_output.step, state_output.time_s)?;
                let mut fields = crate::types::LatestFields::default();
                fields.insert(
                    "m".to_string(),
                    json!({
                        "source_step": state_output.step,
                        "source_time_seconds": state_output.time_s,
                        "solver_dt": state_output.solver_dt_s,
                        "source_revision": artifact_revision,
                        "carrier_fingerprint": state_output.space_fingerprint.clone(),
                        "accepted_state_ref": output.accepted_state_ref,
                        "state_object_ref": output.object_ref,
                        "values": state_output.values.clone(),
                        "layout": state_output.layout.clone(),
                        "provenance": state_output.provenance.clone(),
                        "observation_frame": frame,
                    }),
                );
                let final_generation = next.terminal_field_generations.get(&context.run_id)
                    .copied().unwrap_or_default().saturating_add(1);
                crate::session::apply_current_live_accepted_field_frame(
                    &mut next,
                    CurrentLiveFieldFrameRequest {
                        session_id: context.session_id.clone(),
                        latest_fields: Some(fields),
                        // Final m supersedes every intermediate field. The
                        // verified CAS bundle is adopted below as one source;
                        // no earlier live H may remain falsely current.
                        replace_latest_fields: true,
                        field_generation: Some(CurrentLiveFieldGeneration {
                            run_id: context.run_id.clone(),
                            sequence: final_generation,
                        }),
                        preview_fields: None,
                        clear_preview_cache: true,
                    },
                    frame,
                )?;
                changed = true;
            }
        }
    }
    if !changed && previous_status == public_status && !terminal {
        return Ok(());
    }
    next.state_version = next.state_version.saturating_add(1);
    let published_fence = ProjectionPublicationFence::capture(&next)?;
    let mut realtime_state =
        crate::current_live_realtime_state_from_snapshot(state, &next, display_revision).await;

    // Artifact decoding, field/frame construction, and the candidate state
    // clone above are deliberately outside the transition fence.  Serialize
    // only the final identity/revision CAS, terminal command completion, and
    // state pointer swap.
    let transition = state.current_live_session_transition.lock().await;
    let current_display_revision = state.current_display_selection.read().await.revision;
    if current_display_revision != display_revision {
        return Err(ApiError::conflict_with_code(
            "accepted_projection_current_state_changed",
            "display selection changed while accepted output was being projected",
        ));
    }
    {
        let current = state.current_live_state.read().await;
        let snapshot = current
            .as_ref()
            .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
        ensure_projection_context(state, context, snapshot)?;
        if ProjectionPublicationFence::capture(snapshot)? != publication_fence {
            return Err(ApiError::conflict_with_code(
                "accepted_projection_current_state_changed",
                "current live resources changed while accepted output was being projected",
            ));
        }
    }
    // A run that failed or was cancelled before publishing outputs still ends
    // its bound command; otherwise its client would wait forever.
    if terminal {
        complete_bound_command(
            state,
            &next,
            projection.command_id.as_deref(),
            &projection.preclaim_cancellations,
            projection.status,
        )
        .await?;
    }
    // Terminal command reconciliation is idempotent even when the snapshot
    // was already projected; do not publish an unchanged snapshot again.
    if !changed && previous_status == public_status {
        drop(transition);
        return Ok(());
    }
    let previous = {
        let mut current = state.current_live_state.write().await;
        std::mem::replace(&mut *current, Some(next))
    };
    drop(transition);
    if let Some(previous) = previous {
        let _ = tokio::task::spawn_blocking(move || drop(previous));
    }
    if terminal && projection.latest_state.as_ref().is_some_and(|output| output.accepted_state_ref.is_some()) {
        // Terminal CAS adoption has its own documented transition-fence
        // requirement. Reacquire only around its exact final-state check and
        // adoption, never around the preceding artifact/field construction.
        let terminal_transition = state.current_live_session_transition.lock().await;
        {
            let current = state.current_live_state.read().await;
            let snapshot = current
                .as_ref()
                .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
            ensure_projection_context(state, context, snapshot)?;
            if ProjectionPublicationFence::capture(snapshot)? != published_fence {
                return Err(ApiError::conflict_with_code(
                    "accepted_projection_current_state_changed",
                    "current live state changed before terminal observation adoption",
                ));
            }
        }
        let adoption = crate::accepted_field_materialization::adopt_terminal_bundle(state).await;
        drop(terminal_transition);
        match adoption {
            Ok(()) => {
                let published = state.current_live_state.read().await.as_ref().cloned();
                if let Some(published) = published {
                    let display_revision = state.current_display_selection.read().await.revision;
                    realtime_state = crate::current_live_realtime_state_from_snapshot(
                        state,
                        &published,
                        display_revision,
                    )
                    .await;
                }
            }
            Err(error) => tracing::warn!(code = ?error.code, error = %error,
                "accepted terminal observation bundle unavailable; final magnetization remains valid"),
        }
    }
    crate::router_v2::handlers::sessions::status::record_current_live_heartbeat(state).await;
    crate::publish_current_live_realtime_batch_changed(state, &realtime_state, true, 100).await
}

fn accepted_output_frame(
    snapshot: &SessionStateResponse,
    source_step: u64,
    source_time_seconds: f64,
) -> Result<crate::schemas::common::AcceptedObservationFrameRef, ApiError> {
    if !source_time_seconds.is_finite() || source_time_seconds < 0.0 {
        return Err(ApiError::conflict(
            "accepted output has invalid observation time",
        ));
    }
    Ok(crate::session::accepted_observation_frame_ref(
        snapshot,
        source_step,
        Some(source_time_seconds),
    ))
}

async fn complete_bound_command(
    state: &AppState,
    snapshot: &SessionStateResponse,
    command_id: Option<&str>,
    preclaim_cancellations: &[(String, String)],
    status: &str,
) -> Result<(), ApiError> {
    let run_id = snapshot.run.as_ref().map(|run| run.run_id.as_str());
    let completion = match status {
        "completed" => crate::types::CommandCompletionState::Completed,
        "cancelled" => crate::types::CommandCompletionState::Cancelled,
        "failed" => crate::types::CommandCompletionState::Failed,
        _ => return Ok(()),
    };
    let failure_message = (completion == crate::types::CommandCompletionState::Failed)
        .then(|| accepted_command_failure_message(snapshot));
    let completed_at = unix_time_millis_now();
    crate::live_command_journal::mutate(state, snapshot, |records| {
        let mut changed = false;
        for record in records.iter_mut() {
            let bound_execution = command_id.is_some_and(|id| record.command.command_id == id)
                || (record.command.kind == "mesh_build"
                    && command_id.is_some_and(|id| id == format!("live-preparation-{}", record.command.command_id)));
            let bound_stop = status == "cancelled" && record.command.kind == "stop"
                && !preclaim_cancellations.is_empty()
                && preclaim_cancellations.iter().all(|(task_id, cancellation_id)| {
                    *cancellation_id == format!("cancel-live-{}", fullmag_session::hex_sha256(
                        format!("{}\0{}\0{}", record.command.command_id, snapshot.session.run_id, task_id).as_bytes(),
                    ))
                });
            // Releasing a held startup Study does not rewrite its immutable
            // RunIntent command_id. Complete the exact run-bound Solve too,
            // otherwise its Accepted ledger entry blocks future commands.
            let targets_this_run = matches!(
                record.command.target.as_ref(),
                Some(crate::schemas::commands::RuntimeCommandTarget::Run {
                    run_id: Some(target_run_id),
                }) if Some(target_run_id.as_str()) == run_id
            );
            let releases_this_run = targets_this_run && matches!(
                record.command.kind.as_str(), "solve" | "run" | "relax" | "resume"
            );
            // A durable cancellation confirms that the run-bound Stop action
            // succeeded, including a Study cancelled before its first solve.
            let stops_this_run = targets_this_run
                && record.command.kind == "stop"
                && status == "cancelled";
            if (!bound_execution && !bound_stop && !releases_this_run && !stops_this_run)
                || matches!(
                    record.status,
                    crate::types::CommandLifecycleState::Completed
                        | crate::types::CommandLifecycleState::Failed
                        | crate::types::CommandLifecycleState::Rejected
                )
            {
                continue;
            }
            record.status = match completion {
                crate::types::CommandCompletionState::Failed => {
                    crate::types::CommandLifecycleState::Failed
                }
                _ => crate::types::CommandLifecycleState::Completed,
            };
            record.completed_at_unix_ms = Some(completed_at);
            record.completion_status = Some(if stops_this_run {
                crate::types::CommandCompletionState::Completed
            } else {
                completion
            });
            record.error = failure_message.clone();
            changed = true;
        }
        Ok(((), changed))
    })
    .await
}

fn accepted_command_failure_message(snapshot: &SessionStateResponse) -> String {
    let failed_stage = snapshot.stage_execution.as_ref().and_then(|execution| {
        execution.stages.iter().enumerate().find(|(_, stage)| {
            stage.status == crate::types::StageLifecycleState::Failed
        })
    });
    let detail = failed_stage.map(|(index, stage)| {
        let stage_id = stage.stage_id.as_deref().filter(|id| !id.trim().is_empty())
            .map(|id| id.chars().take(128).collect::<String>())
            .unwrap_or_else(|| format!("stage {}", index + 1));
        let cause = stage.state_transition_reason.as_deref()
            .filter(|reason| !reason.trim().is_empty())
            .unwrap_or("no failure detail was published");
        let cause = cause.split_whitespace().collect::<Vec<_>>().join(" ");
        format!("Stage {stage_id} failed: {}", cause.chars().take(768).collect::<String>())
    }).unwrap_or_else(|| "Accepted Study execution failed; no stage detail was published".into());
    format!("{detail}. Inspect diagnostics and correct the cause before starting another run.")
}

fn unix_time_millis_now() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(lifecycle: fullmag_session::FmsTaskLifecycle) -> fullmag_session::FmsTaskCatalogEntry {
        fullmag_session::FmsTaskCatalogEntry {
            task_id: "task".into(),
            input_fingerprint: "a".repeat(64),
            lifecycle,
            readiness: Default::default(),
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
    fn finished_interactive_commands_return_the_session_to_awaiting_command() {
        for status in ["completed", "failed", "cancelled"] {
            assert_eq!(session_status_after_projection(status, true), "awaiting_command");
            assert_eq!(session_status_after_projection(status, false), status);
        }
        assert_eq!(session_status_after_projection("running", true), "running");
        assert_eq!(session_status_after_projection("waiting_for_solve", false), "awaiting_command");
    }

    #[test]
    fn catalog_status_is_fail_closed_for_failed_or_cancelled_tasks() {
        assert_eq!(
            catalog_status(&[task(fullmag_session::FmsTaskLifecycle::Running)]),
            "running"
        );
        assert_eq!(
            catalog_status(&[task(fullmag_session::FmsTaskLifecycle::Cancelled)]),
            "cancelled"
        );
        assert_eq!(
            catalog_status(&[task(fullmag_session::FmsTaskLifecycle::Failed)]),
            "failed"
        );
        assert_eq!(
            catalog_status(&[task(fullmag_session::FmsTaskLifecycle::Succeeded)]),
            "completed"
        );
    }

    fn preclaim_cancelled_fixture() -> (
        tempfile::TempDir,
        fullmag_session::SessionStore,
        ProjectionContext,
        fullmag_session::FmsRunCatalog,
    ) {
        use fullmag_application::{ProjectEnvelope, ProjectId, ProjectSnapshot, RequestedExecution,
            RequestedResourceBudget, RunId, RunIntent, RunSpecification, StudyId, StudyReference};
        use fullmag_authoring::{PrimitiveStageNode, StudyDiscretizationReference,
            StudyExecutionProfileReference, StudyModelReference, StudyPipelineDocument,
            StudyPipelineNode, StudyPipelineNodeSource, StudyPlan, StudyPlanMigrationDefaults,
            StudyPrimitiveStageKind, StudySolverConfigReference};
        use fullmag_plan::{StudyProblemCatalog, StudyProblemCatalogEntry};

        let directory = tempfile::tempdir().unwrap();
        let store = fullmag_session::SessionStore::open(directory.path().join("store")).unwrap();
        let definition = ProjectEnvelope::blank(ProjectId::parse("project-cancel").unwrap(), "Cancel").unwrap();
        let study = StudyPlan::from_pipeline("study-cancel", 1, &StudyPipelineDocument {
            version: "study_pipeline.v2".into(),
            nodes: ["step:run", "step:run-2"].into_iter().map(|id|
                StudyPipelineNode::Primitive(PrimitiveStageNode {
                    id: id.into(), label: "Run".into(), enabled: true, notes: None,
                    source: Some(StudyPipelineNodeSource::UiAuthored),
                    stage_kind: StudyPrimitiveStageKind::Run,
                    payload: [("until_seconds".into(), json!("1e-9"))].into_iter().collect(),
                })).collect(),
        }, &StudyPlanMigrationDefaults {
            model: StudyModelReference { model_id: "model:one".into(), version: "v1".into() },
            solver_config: StudySolverConfigReference { preset_id: "solver:default".into(), version: "v1".into() },
            discretization: StudyDiscretizationReference { recipe_id: "mesh:default".into(), version: "v1".into() },
            execution_profile: StudyExecutionProfileReference { profile_id: "exec:auto".into(), version: "v1".into() },
        }).unwrap();
        let problem_catalog = StudyProblemCatalog::from_entries(&study, study.steps.iter().map(|step|
            StudyProblemCatalogEntry::from_step(step, fullmag_ir::ProblemIR::bootstrap_example()),
        ).collect()).unwrap();
        let context = ProjectionContext {
            session_id: "session-cancel".into(), run_id: "run-cancel".into(), session_epoch: 4,
            scene_revision: 9, execution_input: None, api_instance_id: "api-cancel".into(),
            allow_api_instance_rebind: false,
        };
        let mut specification = RunSpecification::new(
            ProjectSnapshot::from_envelope(&definition).unwrap(),
            StudyReference {
                study_id: StudyId::parse("study-cancel").unwrap(), plan_version: study.schema_version.clone(),
                plan_sha256: study.canonical_sha256().unwrap(),
            }, fullmag_session::canonical_json_sha256(&serde_json::to_value(&problem_catalog).unwrap()),
            json!({"live_workspace": {"api_instance_id": context.api_instance_id, "session_id": context.session_id,
                "session_epoch": context.session_epoch, "scene_revision": context.scene_revision,
                "command_id": "live-preparation-mesh-command"}}),
            RequestedExecution { backend: "fdm".into(), device: "cpu".into(), precision: "double".into(),
                mode: "strict".into(), minimum_resources: Some(RequestedResourceBudget {
                    cpu_millis: 100, memory_bytes: 1, gpu_memory_bytes: 0, storage_bytes: 1,
                }) },
        );
        specification.run_id = RunId::parse(context.run_id.clone()).unwrap();
        crate::run_intent_persistence::commit_validated_run_intent(&store,
            &RunIntent::new("submit-cancel", specification), &definition, &study, &problem_catalog,
            &std::collections::BTreeMap::new()).unwrap();
        let catalog = crate::run_intent_persistence::materialize_accepted_run_catalog(
            &store, &context.run_id, &ProjectId::parse("project-cancel").unwrap()).unwrap();
        let application_root = directory.path().join("application-state");
        std::fs::create_dir(&application_root).unwrap();
        let ledger = fullmag_session::host_resource_ledger::HostResourceLedger::initialize_for_application(&application_root,
            directory.path().join("host-ledger"), fullmag_session::host_resource_ledger::HostResourceLedgerPolicy {
                schema_version: fullmag_session::host_resource_ledger::HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1.into(),
                host_id: "host-cancel".into(), topology_sha256: "a".repeat(64), revision: 1, owner_epoch: 1,
                total_budget: fullmag_session::FmsResourceBudget {
                    cpu_millis: 1000, memory_bytes: 1024, gpu_memory_bytes: 0, storage_bytes: 1024,
                }, gpu_vram_bytes_by_uuid: Default::default(), allowed_cpu_ids: Default::default(),
            }).unwrap();
        for task in &catalog.tasks {
            let revision = store.read_run_catalog(&context.run_id).unwrap().unwrap().revision;
            let cancellation_id = format!("cancel-live-{}", fullmag_session::hex_sha256(
                format!("stop-command\0{}\0{}", context.run_id, task.task_id).as_bytes(),
            ));
            store.request_task_cancellation_intent(&context.run_id, &task.task_id,
                &cancellation_id, revision, "operator cancelled before claim").unwrap();
            assert!(ledger.project_unclaimed_task_cancellation(&store, &context.run_id, &task.task_id).unwrap());
        }
        let catalog = store.read_run_catalog(&context.run_id).unwrap().unwrap();
        assert_eq!(catalog.revision, 5);
        (directory, store, context, catalog)
    }

    #[test]
    fn accepted_antenna_linkage_keeps_closed_loop_authored_and_runtime_ids_separate() {
        let (_directory, store, context, mut catalog) = preclaim_cancelled_fixture();
        let mut accepted = fullmag_runtime_control::load_accepted_study_snapshot(&store,
            &fullmag_application::RunId::parse(context.run_id).unwrap(),
            &fullmag_application::ProjectId::parse("project-cancel").unwrap()).unwrap();
        let step = &mut accepted.lowered.steps[0];
        let runtime_id = step.step_id.clone();
        step.kind = fullmag_authoring::StudyStepKind::ClosedLoopInspection {
            stage_id: "inspect_loop".into(), port_mode_id: "loop_port".into(), output_id: "loop_output".into(),
        };
        // Closed-loop linkage comes from its typed operation, without assuming
        // the runtime ID, label or a magnetic backend plan is the authored ID.
        step.execution_plan = None;
        for task in &mut catalog.tasks { task.lifecycle = fullmag_session::FmsTaskLifecycle::Succeeded; }
        let projected = build_stage_execution(&accepted, &catalog.tasks, None, &[],
            &std::collections::BTreeMap::new(), "completed").unwrap();
        assert_eq!(projected.stages[0].stage_id.as_deref(), Some(runtime_id.as_str()));
        assert_eq!(projected.stages[0].antenna_solve_stage_id.as_deref(), Some("inspect_loop"));
        assert_eq!(projected.stages[0].status, crate::types::StageLifecycleState::Completed);
        assert!(projected.stages[0].artifact_refs.is_empty());
        assert!(projected.stages[1].antenna_solve_stage_id.is_none());
    }

    #[test]
    fn accepted_antenna_linkage_requires_primitive_kind_and_selected_typed_plan() {
        let (_directory, store, context, catalog) = preclaim_cancelled_fixture();
        let mut accepted = fullmag_runtime_control::load_accepted_study_snapshot(&store,
            &fullmag_application::RunId::parse(context.run_id).unwrap(),
            &fullmag_application::ProjectId::parse("project-cancel").unwrap()).unwrap();
        let step = &mut accepted.lowered.steps[0];
        step.kind = fullmag_authoring::StudyStepKind::Primitive {
            stage_kind: fullmag_authoring::StudyPrimitiveStageKind::AntennaFieldSolve,
        };
        let before = build_stage_execution(&accepted, &catalog.tasks, None, &[],
            &std::collections::BTreeMap::new(), "cancelled").unwrap();
        assert!(before.stages[0].antenna_solve_stage_id.is_none());
        accepted.lowered.steps[0].execution_plan.as_mut().unwrap().backend_plan =
            fullmag_ir::BackendPlanIR::AntennaFieldOnly(fullmag_ir::AntennaFieldOnlyPlanIR {
                schema_version: "antenna_field_only_plan.v1".into(), stage_id: "authored-inspection".into(),
                port_mode_id: "port".into(), source_object_id: "antenna".into(),
                source_mesh: fullmag_ir::MeshIR::default(), source_object_segments: Vec::new(), source_mesh_parts: Vec::new(),
                field_sampling: fullmag_ir::AntennaFieldSamplingPlanIR {
                    domain: fullmag_ir::FieldTargetIR::Global {}, carrier_kind: "fem_domain_mesh_asset".into(),
                    location: "node".into(), topology_digest: "a".repeat(64), positions_xyz_m: Vec::new(),
                    cells: fullmag_ir::FemConnectivityIR::empty(),
                },
            });
        let projected = build_stage_execution(&accepted, &catalog.tasks, None, &[],
            &std::collections::BTreeMap::new(), "cancelled").unwrap();
        assert_eq!(projected.stages[0].antenna_solve_stage_id.as_deref(), Some("authored-inspection"));
        accepted.lowered.steps[0].kind = fullmag_authoring::StudyStepKind::Primitive {
            stage_kind: fullmag_authoring::StudyPrimitiveStageKind::Run,
        };
        let unrelated = build_stage_execution(&accepted, &catalog.tasks, None, &[],
            &std::collections::BTreeMap::new(), "cancelled").unwrap();
        assert!(unrelated.stages[0].antenna_solve_stage_id.is_none());
    }

    #[test]
    fn accepted_stage_records_copy_only_current_attempt_journal_times() {
        let (_directory, store, context, mut catalog) = preclaim_cancelled_fixture();
        let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
            &store,
            &fullmag_application::RunId::parse(context.run_id).unwrap(),
            &fullmag_application::ProjectId::parse("project-cancel").unwrap(),
        )
        .unwrap();
        let task = &mut catalog.tasks[0];
        task.lifecycle = fullmag_session::FmsTaskLifecycle::Succeeded;
        task.attempt_id = Some("attempt-timing".into());
        task.ownership_epoch = Some(1);
        let cached = CachedStageJournalDetails {
            run_id: catalog.run_id.clone(),
            input_fingerprint: task.input_fingerprint.clone(),
            attempt_id: task.attempt_id.clone(),
            ownership_epoch: task.ownership_epoch,
            lifecycle: task.lifecycle,
            details: StageJournalDetails {
                reason: None,
                started_at_unix_ms: Some(2000),
                completed_at_unix_ms: Some(4000),
            },
        };
        let mut cache = [(task.task_id.clone(), cached)]
            .into_iter()
            .collect::<StageJournalDetailsCache>();
        let projected =
            build_stage_execution(&accepted, &catalog.tasks, None, &[], &cache, "completed")
                .unwrap();
        assert_eq!(projected.stages[0].started_at_unix_ms, Some(2000));
        assert_eq!(projected.stages[0].completed_at_unix_ms, Some(4000));
        assert!(projected.stages[1].started_at_unix_ms.is_none());
        cache.values_mut().next().unwrap().attempt_id = Some("old-attempt".into());
        let stale =
            build_stage_execution(&accepted, &catalog.tasks, None, &[], &cache, "completed")
                .unwrap();
        assert!(stale.stages[0].started_at_unix_ms.is_none());
        assert!(stale.stages[0].completed_at_unix_ms.is_none());
    }

    // Focused parser fixtures; production reads also validate the complete
    // journal stream and capture its exact catalog under a native shared fence.
    fn timing_task(
        lifecycle: fullmag_session::FmsTaskLifecycle,
    ) -> (
        fullmag_application::TaskRecord,
        fullmag_session::FmsTaskCatalogEntry,
    ) {
        use fullmag_application::{ResourceBudget, ResourceKind, ResourceLease, RunId, TaskRecord};
        let mut application =
            TaskRecord::new(RunId::parse("run-timing").unwrap(), "a".repeat(64)).unwrap();
        application.queue().unwrap();
        let claim = application
            .claim(
                ResourceLease::new(
                    "cpu-timing",
                    ResourceKind::Cpu,
                    ResourceBudget {
                        cpu_millis: 1000,
                        memory_bytes: 1024,
                        gpu_memory_bytes: 0,
                        storage_bytes: 1024,
                    },
                )
                .unwrap(),
            )
            .unwrap();
        application.begin_running(&claim).unwrap();
        let mut catalog = task(lifecycle);
        catalog.task_id = application.task_id.as_str().into();
        catalog.attempt_id = Some(claim.attempt_id.as_str().into());
        catalog.ownership_epoch = Some(claim.ownership_epoch.value());
        (application, catalog)
    }

    fn timing_event(
        application: &fullmag_application::TaskRecord,
        event: fullmag_application::WorkerEvent,
        sequence: u64,
        timestamp_ms: i64,
    ) -> fullmag_session::FmsCoordinatorJournalEntry {
        use chrono::TimeZone;
        use fullmag_application::{
            CoordinatorCheckpoint, CoordinatorMessage, CoordinatorTransition, TaskLifecycle,
            WorkerEvent, WorkerEventEnvelope,
        };
        let claim = application.claim.as_ref().unwrap().clone();
        let mut task = application.clone();
        task.lifecycle = match &event {
            WorkerEvent::Completed { .. } => TaskLifecycle::Succeeded,
            WorkerEvent::Failed { .. } | WorkerEvent::Rejected { .. } => TaskLifecycle::Failed,
            WorkerEvent::Stopped => TaskLifecycle::Cancelled,
            _ => TaskLifecycle::Running,
        };
        let terminal = matches!(
            &event,
            WorkerEvent::Completed { .. }
                | WorkerEvent::Failed { .. }
                | WorkerEvent::Rejected { .. }
        );
        let message_id = format!("event-{sequence}");
        let transition = CoordinatorTransition {
            schema_version: fullmag_application::COORDINATOR_TRANSITION_SCHEMA.into(),
            checkpoint: CoordinatorCheckpoint {
                schema_version: fullmag_application::COORDINATOR_CHECKPOINT_SCHEMA.into(),
                task,
                claim: claim.clone(),
                command_sequence: 2,
                event_sequence: sequence,
            },
            message: CoordinatorMessage::Event(WorkerEventEnvelope {
                schema_version: fullmag_application::WORKER_PROTOCOL_SCHEMA.into(),
                message_id: message_id.clone(),
                sequence,
                claim: claim.identity(),
                event,
            }),
        };
        let payload = serde_json::to_value(transition).unwrap();
        fullmag_session::FmsCoordinatorJournalEntry {
            schema_version: fullmag_session::FMS_COORDINATOR_JOURNAL_SCHEMA.into(),
            entry_id: message_id,
            run_id: claim.run_id.as_str().into(),
            task_id: claim.task_id.as_str().into(),
            attempt_id: claim.attempt_id.as_str().into(),
            ownership_epoch: claim.ownership_epoch.value(),
            lease_token: claim.lease.lease_token.as_str().into(),
            direction: fullmag_session::FmsCoordinatorJournalDirection::Event,
            sequence,
            terminal,
            payload_sha256: fullmag_session::canonical_json_sha256(&payload),
            payload,
            created_at: chrono::Utc
                .timestamp_millis_opt(timestamp_ms)
                .single()
                .unwrap(),
        }
    }

    fn timing_command(
        application: &fullmag_application::TaskRecord,
        command: fullmag_application::WorkerCommand,
    ) -> fullmag_session::FmsCoordinatorJournalEntry {
        let mut entry = timing_event(
            application,
            fullmag_application::WorkerEvent::Started,
            2,
            1000,
        );
        let claim = application.claim.as_ref().unwrap();
        entry.direction = fullmag_session::FmsCoordinatorJournalDirection::Command;
        entry.entry_id = "command-2".into();
        entry.payload["checkpoint"]["task"]["lifecycle"] = serde_json::to_value(match &command {
            fullmag_application::WorkerCommand::Start => {
                fullmag_application::TaskLifecycle::Preparing
            }
            fullmag_application::WorkerCommand::Stop { .. } => {
                fullmag_application::TaskLifecycle::Stopping
            }
            _ => application.lifecycle,
        })
        .unwrap();
        entry.payload["message"] =
            serde_json::to_value(fullmag_application::CoordinatorMessage::Command(
                fullmag_application::WorkerCommandEnvelope {
                    schema_version: fullmag_application::WORKER_PROTOCOL_SCHEMA.into(),
                    message_id: entry.entry_id.clone(),
                    sequence: 2,
                    claim: claim.identity(),
                    command,
                },
            ))
            .unwrap();
        entry.payload_sha256 = fullmag_session::canonical_json_sha256(&entry.payload);
        entry
    }

    #[test]
    fn accepted_stage_times_use_started_event_and_matching_terminal_not_start_command() {
        use fullmag_application::{ScientificAssessment, WorkerCommand, WorkerEvent};
        let (application, mut task) = timing_task(fullmag_session::FmsTaskLifecycle::Running);
        let command = timing_command(&application, WorkerCommand::Start);
        let pending =
            stage_journal_details_for_task("run-timing", &task, &[command.clone()]).unwrap();
        assert_eq!(pending.started_at_unix_ms, None);
        let started = timing_event(&application, WorkerEvent::Started, 2, 2000);
        let running = stage_journal_details_for_task(
            "run-timing",
            &task,
            &[command.clone(), started.clone()],
        )
        .unwrap();
        assert_eq!(running.started_at_unix_ms, Some(2000));
        assert_eq!(running.completed_at_unix_ms, None);
        task.lifecycle = fullmag_session::FmsTaskLifecycle::Succeeded;
        let completed = timing_event(
            &application,
            WorkerEvent::Completed {
                assessment: ScientificAssessment::Unassessed,
            },
            3,
            4000,
        );
        let journal = [command, started, completed];
        let done = stage_journal_details_for_task("run-timing", &task, &journal).unwrap();
        assert_eq!(
            (done.started_at_unix_ms, done.completed_at_unix_ms),
            (Some(2000), Some(4000))
        );
        // A fresh reader of the same durable entries reconstructs the same times.
        assert_eq!(
            done,
            stage_journal_details_for_task("run-timing", &task, &journal).unwrap()
        );
    }

    #[test]
    fn accepted_stage_times_preserve_failure_and_stop_reasons_without_inventing_start() {
        use fullmag_application::{WorkerCommand, WorkerEvent};
        let (application, mut task) = timing_task(fullmag_session::FmsTaskLifecycle::Failed);
        let failure = timing_event(
            &application,
            WorkerEvent::Failed {
                retryable: false,
                reason: "native failure".into(),
            },
            3,
            4000,
        );
        let failed =
            stage_journal_details_for_task("run-timing", &task, &[failure.clone()]).unwrap();
        assert_eq!(failed.reason.as_deref(), Some("native failure"));
        assert_eq!(
            (failed.started_at_unix_ms, failed.completed_at_unix_ms),
            (None, Some(4000))
        );
        task.lifecycle = fullmag_session::FmsTaskLifecycle::Interrupted;
        let interrupted = stage_journal_details_for_task("run-timing", &task, &[failure]).unwrap();
        assert_eq!(interrupted.reason.as_deref(), Some("native failure"));
        assert_eq!(interrupted.completed_at_unix_ms, None);
        task.lifecycle = fullmag_session::FmsTaskLifecycle::Cancelled;
        let stop = timing_command(
            &application,
            WorkerCommand::Stop {
                reason: "operator stop".into(),
            },
        );
        let stopped = timing_event(&application, WorkerEvent::Stopped, 3, 5000);
        let cancelled =
            stage_journal_details_for_task("run-timing", &task, &[stop, stopped]).unwrap();
        assert_eq!(cancelled.reason.as_deref(), Some("operator stop"));
        assert_eq!(
            (cancelled.started_at_unix_ms, cancelled.completed_at_unix_ms),
            (None, Some(5000))
        );
    }

    #[test]
    fn accepted_stage_times_reject_crossed_envelope_checkpoint_and_journal_fences() {
        let (application, task) = timing_task(fullmag_session::FmsTaskLifecycle::Running);
        let entry = timing_event(
            &application,
            fullmag_application::WorkerEvent::Started,
            2,
            2000,
        );
        for (pointer, value) in [
            ("/checkpoint/claim/run_id", json!("foreign-run")),
            ("/checkpoint/task/attempt_id", json!("foreign-attempt")),
            (
                "/message/envelope/claim/attempt_id",
                json!("foreign-attempt"),
            ),
            ("/message/envelope/claim/ownership_epoch", json!(2)),
            (
                "/message/envelope/claim/lease_token",
                json!("foreign-lease"),
            ),
            ("/message/envelope/message_id", json!("foreign-message")),
            ("/message/envelope/sequence", json!(3)),
        ] {
            let mut corrupt = entry.clone();
            *corrupt.payload.pointer_mut(pointer).unwrap() = value;
            corrupt.payload_sha256 = fullmag_session::canonical_json_sha256(&corrupt.payload);
            assert!(
                stage_journal_details_for_task("run-timing", &task, &[corrupt]).is_err(),
                "{pointer}"
            );
        }
        let mut foreign_run = entry.clone();
        foreign_run.run_id = "foreign-run".into();
        assert!(stage_journal_details_for_task("run-timing", &task, &[foreign_run]).is_err());
        let mut foreign_lease = entry.clone();
        foreign_lease.lease_token = "foreign-lease".into();
        assert!(stage_journal_details_for_task("run-timing", &task, &[foreign_lease]).is_err());
        let mut crossed = entry;
        crossed.direction = fullmag_session::FmsCoordinatorJournalDirection::Command;
        assert!(stage_journal_details_for_task("run-timing", &task, &[crossed]).is_err());
    }

    #[test]
    fn accepted_stage_times_ignore_old_attempts_and_reject_wrong_terminal_lifecycle() {
        use fullmag_application::{ScientificAssessment, WorkerEvent};
        let (application, task) = timing_task(fullmag_session::FmsTaskLifecycle::Running);
        let mut old = timing_event(&application, WorkerEvent::Started, 2, 1000);
        old.attempt_id = "old-attempt".into();
        let details = stage_journal_details_for_task("run-timing", &task, &[old]).unwrap();
        assert_eq!(details, StageJournalDetails::default());
        let completed = timing_event(
            &application,
            WorkerEvent::Completed {
                assessment: ScientificAssessment::Unassessed,
            },
            3,
            4000,
        );
        assert!(stage_journal_details_for_task("run-timing", &task, &[completed]).is_err());
        let started = timing_event(&application, WorkerEvent::Started, 2, 2000);
        assert!(
            stage_journal_details_for_task("run-timing", &task, &[started.clone(), started])
                .is_err()
        );
    }

    #[test]
    fn accepted_stage_times_omit_invalid_utc_and_backwards_completion() {
        use fullmag_application::{ScientificAssessment, WorkerEvent};
        let (application, task) = timing_task(fullmag_session::FmsTaskLifecycle::Succeeded);
        for start in [0, -1] {
            let details = stage_journal_details_for_task(
                "run-timing",
                &task,
                &[timing_event(&application, WorkerEvent::Started, 2, start)],
            )
            .unwrap();
            assert_eq!(details.started_at_unix_ms, None);
        }
        let details = stage_journal_details_for_task(
            "run-timing",
            &task,
            &[
                timing_event(&application, WorkerEvent::Started, 2, 4000),
                timing_event(
                    &application,
                    WorkerEvent::Completed {
                        assessment: ScientificAssessment::Unassessed,
                    },
                    3,
                    2000,
                ),
            ],
        )
        .unwrap();
        assert_eq!(
            (details.started_at_unix_ms, details.completed_at_unix_ms),
            (Some(4000), None)
        );
    }

    #[test]
    fn accepted_stage_journal_cache_reuses_heartbeat_but_invalidates_exact_identity() {
        let (_directory, store, _context, mut catalog) = preclaim_cancelled_fixture();
        let task = &mut catalog.tasks[0];
        task.lifecycle = fullmag_session::FmsTaskLifecycle::Running;
        task.attempt_id = Some("attempt-timing".into());
        task.ownership_epoch = Some(1);
        let cached = CachedStageJournalDetails {
            run_id: catalog.run_id.clone(),
            input_fingerprint: task.input_fingerprint.clone(),
            attempt_id: task.attempt_id.clone(),
            ownership_epoch: task.ownership_epoch,
            lifecycle: task.lifecycle,
            details: StageJournalDetails {
                started_at_unix_ms: Some(2000),
                ..Default::default()
            },
        };
        let previous = [(task.task_id.clone(), cached)]
            .into_iter()
            .collect::<StageJournalDetailsCache>();
        catalog.revision += 100; // A heartbeat revision alone must not reacquire any store fence.
        let _writer = store.write_transaction().unwrap();
        let reused = load_stage_journal_details(&store, &catalog, Some(&previous)).unwrap();
        assert_eq!(
            reused[&catalog.tasks[0].task_id].details.started_at_unix_ms,
            Some(2000)
        );
        assert!(load_stage_journal_details(&store, &catalog, None).is_err());
        for key in ["run", "fingerprint", "attempt", "epoch", "lifecycle"] {
            let mut changed = catalog.clone();
            match key {
                "run" => changed.run_id = "different-run".into(),
                "fingerprint" => changed.tasks[0].input_fingerprint = "b".repeat(64),
                "attempt" => changed.tasks[0].attempt_id = Some("next-attempt".into()),
                "epoch" => changed.tasks[0].ownership_epoch = Some(2),
                _ => changed.tasks[0].lifecycle = fullmag_session::FmsTaskLifecycle::Succeeded,
            }
            assert!(
                load_stage_journal_details(&store, &changed, Some(&previous)).is_err(),
                "{key}"
            );
        }
    }

    #[test]
    fn preclaim_cancellation_projects_terminal_metadata_without_creating_artifacts() {
        let (_directory, store, context, catalog) = preclaim_cancelled_fixture();
        assert!(preclaim_cancelled_without_artifacts(&store, &catalog).unwrap());
        assert!(store.read_artifact_catalog(&context.run_id).unwrap().is_none());
        let before = std::fs::read(store.root().join(format!("runs/{}/run_catalog.json", context.run_id))).unwrap();
        let projection = load_durable_projection(store.root(), &context, None, &mut None).unwrap().unwrap();
        assert_eq!(projection.status, "cancelled");
        assert_eq!(projection.command_id.as_deref(), Some("live-preparation-mesh-command"));
        assert_eq!(projection.artifact_catalog_revision, None);
        assert!(projection.latest_state.is_none());
        assert!(projection.latest_total_energy.is_none());
        assert!(projection.latest_output_identity.is_none());
        assert!(projection.live_observation.is_none());
        assert!(projection.stage_execution.stages.iter().all(|stage|
            stage.status == crate::types::StageLifecycleState::Cancelled));
        assert!(store.read_artifact_catalog(&context.run_id).unwrap().is_none());
        assert_eq!(before, std::fs::read(store.root().join(format!("runs/{}/run_catalog.json", context.run_id))).unwrap());
    }

    #[tokio::test]
    async fn preclaim_cancellation_completes_live_session_and_bound_mesh_command() {
        let (directory, store, context, _catalog) = preclaim_cancelled_fixture();
        let projection = load_durable_projection(store.root(), &context, None, &mut None).unwrap().unwrap();
        let mut state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let journal_root = directory.path().join("live-journal");
        Arc::get_mut(&mut state).unwrap().current_command_journal_store_root = Some(journal_root.clone());
        state.current_live_session_epoch.store(context.session_epoch, std::sync::atomic::Ordering::Release);
        let mut scene = crate::router_v2::handlers::sessions::create::create_empty_scene_document(
            &serde_json::from_value(json!({"name":"Cancel", "backend":"fdm", "device":"cpu", "precision":"double"})).unwrap(),
        ).unwrap();
        scene.revision = context.scene_revision;
        scene.scene.id = context.session_id.clone();
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().unwrap();
            snapshot.session.session_id = context.session_id.clone();
            snapshot.session.run_id = context.run_id.clone();
            snapshot.session.status = "waiting_for_compute".into();
            snapshot.scene_document = Some(scene);
            snapshot.run = Some(serde_json::from_value(json!({
                "run_id":context.run_id, "session_id":context.session_id, "status":"waiting_for_compute",
                "total_steps":2, "artifact_dir":""
            })).unwrap());
        }
        state.current_command_ledger.lock().await.push_back(serde_json::from_value(json!({
            "command":{"seq":1,"command_id":"mesh-command","kind":"mesh_build","created_at_unix_ms":1},
            "status":"accepted"
        })).unwrap());
        for (seq, id, kind) in [
            (2, "stop-command", "stop"),
            (3, "unrelated-mesh", "mesh_build"),
            (4, "unrelated-stop", "stop"),
            (5, "live-preparation-mesh-command-extra", "mesh_build"),
        ] {
            state.current_command_ledger.lock().await.push_back(serde_json::from_value(json!({
                "command":{"seq":seq,"command_id":id,"kind":kind,"created_at_unix_ms":1},
                "status":"accepted"
            })).unwrap());
        }
        let _transition = state.current_live_session_transition.lock().await;
        apply_projection(&state, &context, projection).await.unwrap();
        let current = state.current_live_state.read().await;
        let snapshot = current.as_ref().unwrap();
        assert_eq!(snapshot.session.status, "cancelled");
        assert_eq!(snapshot.run.as_ref().unwrap().status, "cancelled");
        assert!(snapshot.session.finished_at_unix_ms > 0);
        let ledger = state.current_command_ledger.lock().await;
        assert_eq!(ledger[0].status, crate::types::CommandLifecycleState::Completed);
        assert_eq!(ledger[0].completion_status, Some(crate::types::CommandCompletionState::Cancelled));
        assert_eq!(ledger[1].completion_status, Some(crate::types::CommandCompletionState::Cancelled));
        assert!(ledger.iter().skip(2).all(|record|
            record.status == crate::types::CommandLifecycleState::Accepted));
        let journal = fullmag_session::SessionStore::open_existing(journal_root).unwrap()
            .read_live_command_journal(&context.session_id).unwrap().unwrap();
        let journal: Value = serde_json::from_slice(&journal).unwrap();
        assert_eq!(journal["records"][0]["completion_status"], "cancelled");
        assert!(store.read_artifact_catalog(&context.run_id).unwrap().is_none());
    }

    #[tokio::test]
    async fn failed_run_without_outputs_completes_only_its_bound_command() {
        let (directory, store, context, mut catalog) = preclaim_cancelled_fixture();
        for task in &mut catalog.tasks {
            task.lifecycle = fullmag_session::FmsTaskLifecycle::Failed;
        }
        std::fs::write(store.root().join(format!("runs/{}/run_catalog.json", context.run_id)),
            serde_json::to_vec(&catalog).unwrap()).unwrap();
        let mut state = crate::router_v2::tests::test_app_state_with_live_session().await;
        Arc::get_mut(&mut state).unwrap().current_command_journal_store_root =
            Some(directory.path().join("live-journal"));
        state.current_live_session_epoch.store(context.session_epoch, std::sync::atomic::Ordering::Release);
        let mut scene = crate::router_v2::handlers::sessions::create::create_empty_scene_document(
            &serde_json::from_value(json!({"name":"Failure", "backend":"fdm", "device":"cpu", "precision":"double"})).unwrap(),
        ).unwrap();
        scene.revision = context.scene_revision;
        scene.scene.id = context.session_id.clone();
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().unwrap();
            snapshot.session.session_id = context.session_id.clone();
            snapshot.session.run_id = context.run_id.clone();
            snapshot.session.status = "running".into();
            snapshot.scene_document = Some(scene);
            snapshot.run = Some(serde_json::from_value(json!({
                "run_id":context.run_id, "session_id":context.session_id, "status":"running",
                "total_steps":2, "artifact_dir":""
            })).unwrap());
        }
        for (seq, id, kind) in [
            (1, "live-preparation-mesh-command", "solve"),
            (2, "unrelated-solve", "solve"),
            (3, "stop-command", "stop"),
        ] {
            state.current_command_ledger.lock().await.push_back(serde_json::from_value(json!({
                "command":{"seq":seq,"command_id":id,"kind":kind,"created_at_unix_ms":1},
                "status":"running"
            })).unwrap());
        }
        let _transition = state.current_live_session_transition.lock().await;
        let projection = load_durable_projection(store.root(), &context, None, &mut None).unwrap().unwrap();
        assert_eq!(projection.status, "failed");
        assert!(projection.terminal_without_outputs);
        assert!(projection.preclaim_cancellations.is_empty());
        assert!(projection.stage_execution.stages.iter().all(|stage|
            stage.status == crate::types::StageLifecycleState::Failed));
        apply_projection(&state, &context, projection).await.unwrap();
        let completed_at = {
            let ledger = state.current_command_ledger.lock().await;
            assert_eq!(ledger[0].status, crate::types::CommandLifecycleState::Failed);
            assert_eq!(ledger[0].completion_status, Some(crate::types::CommandCompletionState::Failed));
            assert_eq!(ledger[0].error.as_deref(), Some("accepted Study execution failed"));
            assert!(ledger.iter().skip(1).all(|record|
                record.status == crate::types::CommandLifecycleState::Running));
            ledger[0].completed_at_unix_ms.unwrap()
        };
        assert!(completed_at > 0);
        let projection = load_durable_projection(store.root(), &context, None, &mut None).unwrap().unwrap();
        apply_projection(&state, &context, projection).await.unwrap();
        assert_eq!(state.current_command_ledger.lock().await[0].completed_at_unix_ms, Some(completed_at));
        let current = state.current_live_state.read().await;
        let snapshot = current.as_ref().unwrap();
        assert_eq!(snapshot.session.status, "failed");
        assert_eq!(snapshot.run.as_ref().unwrap().status, "failed");
        assert!(snapshot.session.finished_at_unix_ms > 0);
        assert!(store.read_artifact_catalog(&context.run_id).unwrap().is_none());
    }

    #[tokio::test]
    async fn stop_completion_requires_every_task_proof_for_the_current_run() {
        let state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let snapshot = state.current_live_state.read().await.as_ref().unwrap().clone();
        state.current_command_ledger.lock().await.push_back(serde_json::from_value(json!({
            "command":{"seq":1,"command_id":"stop-command","kind":"stop","created_at_unix_ms":1},
            "status":"accepted"
        })).unwrap());
        let proof = |run_id: &str, task_id: &str| (task_id.to_owned(), format!("cancel-live-{}",
            fullmag_session::hex_sha256(format!("stop-command\0{run_id}\0{task_id}").as_bytes())));
        for proofs in [
            Vec::new(),
            vec![proof("other-run", "task-a")],
            vec![proof(&snapshot.session.run_id, "task-a"), proof("other-run", "task-b")],
        ] {
            complete_bound_command(&state, &snapshot, Some("live-preparation-mesh-command"),
                &proofs, "cancelled").await.unwrap();
            assert_eq!(state.current_command_ledger.lock().await[0].status,
                crate::types::CommandLifecycleState::Accepted);
        }
        complete_bound_command(&state, &snapshot, Some("live-preparation-mesh-command"),
            &[proof(&snapshot.session.run_id, "task-a")], "cancelled").await.unwrap();
        assert_eq!(state.current_command_ledger.lock().await[0].completion_status,
            Some(crate::types::CommandCompletionState::Cancelled));
    }

    #[test]
    fn preclaim_cancellation_rejects_an_incomplete_study_task_catalog() {
        let (_directory, store, context, mut catalog) = preclaim_cancelled_fixture();
        assert_eq!(catalog.tasks.len(), 2);
        catalog.tasks.pop();
        std::fs::write(store.root().join(format!("runs/{}/run_catalog.json", context.run_id)),
            serde_json::to_vec(&catalog).unwrap()).unwrap();
        assert!(load_durable_projection(store.root(), &context, None, &mut None).is_err());
        assert!(store.read_artifact_catalog(&context.run_id).unwrap().is_none());
    }

    #[test]
    fn missing_artifacts_exception_refuses_every_non_cancelled_or_mixed_catalog() {
        use fullmag_session::FmsTaskLifecycle::*;
        let (_directory, store, _context, catalog) = preclaim_cancelled_fixture();
        for lifecycle in [Accepted, Queued, Preparing, Running, Stopping, Succeeded, Failed, Interrupted] {
            let mut changed = catalog.clone();
            changed.tasks[0].lifecycle = lifecycle;
            assert!(!preclaim_cancelled_without_artifacts(&store, &changed).unwrap());
            changed.tasks.push(catalog.tasks[0].clone());
            assert!(!preclaim_cancelled_without_artifacts(&store, &changed).unwrap());
        }
        let mut empty = catalog.clone();
        empty.tasks.clear();
        assert!(!preclaim_cancelled_without_artifacts(&store, &empty).unwrap());
    }

    #[test]
    fn missing_artifacts_exception_refuses_claimed_state_and_unknown_cancellation_scope() {
        let (_directory, store, context, catalog) = preclaim_cancelled_fixture();
        let mut claimed = catalog.clone();
        claimed.tasks[0].attempt_id = Some("attempt".into());
        claimed.tasks[0].ownership_epoch = Some(1);
        claimed.tasks[0].resource_id = Some("cpu".into());
        assert!(!preclaim_cancelled_without_artifacts(&store, &claimed).unwrap());
        for field in ["ownership_epoch", "resolved_input_fingerprint", "artifact_ids", "coordinator_watermark"] {
            let mut changed = catalog.clone();
            match field {
                "ownership_epoch" => changed.tasks[0].ownership_epoch = Some(1),
                "resolved_input_fingerprint" => changed.tasks[0].resolved_input_fingerprint = Some("b".repeat(64)),
                "artifact_ids" => changed.tasks[0].artifact_ids.push("artifact".into()),
                _ => changed.tasks[0].coordinator_watermark = Some(Default::default()),
            }
            assert!(!preclaim_cancelled_without_artifacts(&store, &changed).unwrap());
        }
        let mut replaced = catalog.clone();
        replaced.tasks[0].input_fingerprint = "b".repeat(64);
        assert!(preclaim_cancelled_without_artifacts(&store, &replaced).is_err());
        std::fs::remove_file(store.root().join(format!("runs/{}/task_cancellation_intents/{}.json",
            context.run_id, catalog.tasks[0].task_id))).unwrap();
        let projection = load_durable_projection(store.root(), &context, None, &mut None).unwrap().unwrap();
        assert!(projection.terminal_without_outputs);
        assert!(projection.preclaim_cancellations.is_empty());
    }

    #[test]
    fn preclaim_cancellation_without_artifacts_keeps_live_binding_fences() {
        let (_directory, store, context, _catalog) = preclaim_cancelled_fixture();
        for field in ["api_instance_id", "session_id", "session_epoch", "scene_revision", "run_id"] {
            let mut stale = context.clone();
            match field {
                "api_instance_id" => stale.api_instance_id = "other-api".into(),
                "session_id" => stale.session_id = "other-session".into(),
                "session_epoch" => stale.session_epoch += 1,
                "scene_revision" => stale.scene_revision += 1,
                _ => stale.run_id = "other-run".into(),
            }
            assert!(!matches!(load_durable_projection(store.root(), &stale, None, &mut None), Ok(Some(_))));
        }
    }

    #[test]
    fn preclaim_exception_does_not_accept_an_invalid_existing_artifact_catalog() {
        let (_directory, store, context, _catalog) = preclaim_cancelled_fixture();
        let path = store.root().join(format!("runs/{}/artifact_catalog.json", context.run_id));
        for (run_id, revision) in [(context.run_id.as_str(), 0), ("other-run", 1)] {
            let catalog = fullmag_session::FmsArtifactCatalog {
                schema_version: fullmag_session::FMS_ARTIFACT_CATALOG_SCHEMA.into(), run_id: run_id.into(),
                revision, updated_at: chrono::Utc::now(), entries: Vec::new(),
            };
            std::fs::write(&path, serde_json::to_vec(&catalog).unwrap()).unwrap();
            assert!(load_durable_projection(store.root(), &context, None, &mut None).is_err());
        }
    }

    #[test]
    fn fdm_output_frame_uses_the_existing_field_admission_revision() {
        let request: crate::types::CurrentLiveSnapshotRequest = serde_json::from_value(json!({
            "session_id": "accepted-fdm-frame",
            "metadata": {"artifact_layout": {"backend": "fdm", "grid_cells": [2, 1, 1]}},
        }))
        .unwrap();
        let mut snapshot = crate::session::default_current_live_state(&request);
        snapshot.mesh_revision = 7;
        let frame = accepted_output_frame(&snapshot, 3, 1e-12).unwrap();
        assert_eq!(frame.topology_revision, "7");
        let mut fields = crate::types::LatestFields::default();
        fields.insert(
            "m".into(),
            json!({
                "values": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                "layout": {"backend": "fdm", "grid_cells": [2, 1, 1]},
                "source_step": 3,
                "source_time_seconds": 1e-12,
                "observation_frame": frame,
            }),
        );
        crate::session::apply_current_live_accepted_field_frame(
            &mut snapshot,
            CurrentLiveFieldFrameRequest {
                session_id: "accepted-fdm-frame".into(),
                latest_fields: Some(fields),
                replace_latest_fields: false,
                field_generation: None,
                preview_fields: None,
                clear_preview_cache: false,
            },
            frame,
        )
        .expect("the producer frame must pass the existing FDM field-source admission");
        assert_eq!(
            snapshot.latest_fields.get("m").unwrap()["values"][1],
            json!([0.0, 1.0, 0.0])
        );
        assert!(snapshot.scalar_rows.is_empty());
    }

    #[test]
    fn manual_startup_poll_preserves_wait_gate_until_compute_release() {
        assert_eq!(
            projected_status_for_gate("waiting_for_compute", false),
            "waiting_for_solve"
        );
        assert_eq!(
            projected_status_for_gate("waiting_for_compute", true),
            "waiting_for_compute"
        );
        assert_eq!(projected_status_for_gate("running", false), "running");
    }

    #[test]
    fn canonical_study_order_wins_over_reused_solver_step_numbers() {
        fn state_output(
            task_order: usize,
            object_ref: &str,
            step: u64,
            time_s: f64,
        ) -> VerifiedOutput {
            VerifiedOutput {
                task_order,
                step_id: "step".into(),
                object_ref: object_ref.into(),
                data_kind: "state".into(),
                accepted_state_ref: None,
                decoded: fullmag_application::DecodedStudyArtifact::MagnetizationState(
                    fullmag_application::MagnetizationStateArtifact {
                        step,
                        time_s,
                        solver_dt_s: 0.1,
                        space_fingerprint: "layout".into(),
                        layout: json!({"grid_cells": [1, 1, 1]}),
                        provenance: json!({"source": "accepted"}),
                        values: vec![[0.0, 0.0, 1.0]],
                        native_state_snapshot: None,
                        native_node_map: None,
                    },
                ),
            }
        }

        let outputs = [
            state_output(0, "first", 99, 99.0),
            state_output(1, "second", 1, 0.1),
        ];
        let latest = outputs
            .iter()
            .max_by(|left, right| compare_magnetization_outputs(left, right))
            .expect("one accepted state output");
        assert_eq!(latest.object_ref, "second");
    }

    #[test]
    fn live_binding_rejects_stale_session_epoch_or_scene_revision() {
        let context = ProjectionContext {
            api_instance_id: "api".into(),
            session_id: "session".into(),
            session_epoch: 4,
            scene_revision: 9,
            execution_input: None,
            run_id: "run".into(),
            allow_api_instance_rebind: false,
        };
        let specification = json!({
            "parameters": {
                "live_workspace": {
                    "api_instance_id": "api",
                    "session_id": "session",
                    "session_epoch": 4,
                    "scene_revision": 9
                }
            }
        });
        assert!(validate_live_intent(&context, &specification).is_ok());
        let mut stale = specification.clone();
        stale["parameters"]["live_workspace"]["scene_revision"] = json!(10);
        assert!(validate_live_intent(&context, &stale).is_err());
    }

    #[test]
    fn running_capabilities_require_the_worker_realization_of_the_planned_engine() {
        use fullmag_runner::RuntimeEngineId;
        assert_eq!(planned_realization_lane(RuntimeEngineId::FdmCpuReference), Some("fdm_cpu"));
        assert_eq!(planned_realization_lane(RuntimeEngineId::FdmCuda), Some("fdm_gpu"));
        assert_eq!(planned_realization_lane(RuntimeEngineId::FemCpuNative), Some("fem_cpu"));
        assert_eq!(planned_realization_lane(RuntimeEngineId::FemNativeGpu), Some("fem_gpu"));
        // Eigen and frequency-response engines never stream live LLG fields.
        assert_eq!(planned_realization_lane(RuntimeEngineId::FemEigenCpuBaseline), None);
    }

    #[test]
    fn live_binding_rebinds_api_instance_only_for_process_local_reattach() {
        let mut context = ProjectionContext {
            api_instance_id: "new-api".into(),
            session_id: "session".into(),
            session_epoch: 1,
            scene_revision: 4,
        execution_input: None,
            run_id: "run".into(),
            allow_api_instance_rebind: true,
        };
        let specification = json!({
            "parameters": {
                "live_workspace": {
                    "api_instance_id": "old-api",
                    "session_id": "session",
                    "session_epoch": 1,
                    "scene_revision": 4
                }
            }
        });
        assert!(validate_live_intent(&context, &specification).is_ok());
        context.allow_api_instance_rebind = false;
        assert!(validate_live_intent(&context, &specification).is_err());
    }

    #[test]
    fn projection_cursor_cannot_skip_a_new_live_run_with_reused_revisions() {
        let context = ProjectionContext {
            api_instance_id: "instance".into(),
            session_id: "session-b".into(),
            session_epoch: 2,
            scene_revision: 7,
            execution_input: None,
            run_id: "run-b".into(),
            allow_api_instance_rebind: false,
        };
        let previous = ProjectionCursor {
            api_instance_id: "instance".into(),
            session_id: "session-a".into(),
            session_epoch: 1,
            scene_revision: 7,
            execution_input_sha256: None,
            run_id: "run-a".into(),
            run_revision: 1,
            artifact_revision: Some(1),
            status: "running",
            solver_profile_identity: None,
            latest_output_identity: None,
            live_observation_identity: None,
            live_observation_sequence: None,
            live_magnetization_sequence: None,
            stage_execution: crate::session::accepted_stage_execution_state(
                Vec::new(),
                crate::types::RuntimeLifecycleState::Unknown,
            ),
            stage_journal_details: StageJournalDetailsCache::new(),
        };
        assert!(!cursor_matches_context(&previous, &context));
    }

    #[test]
    fn fem_domain_rejects_same_node_count_with_different_topology() {
        let topology = format!("sha256:{}", "a".repeat(64));
        let expected = FemProjectionDomainIdentity {
            backend: "fem",
            fe_order: 1,
            node_count: 3,
            topology_fingerprint: topology.clone(),
        };
        let matching = json!({
            "backend": "fem",
            "fe_order": 1,
            "n_nodes": 3,
            "topology_fingerprint": topology,
        });
        assert!(validate_fem_domain(&matching, &expected).is_ok());

        let mut different_topology = matching;
        different_topology["topology_fingerprint"] = json!(format!("sha256:{}", "b".repeat(64)));
        assert!(validate_fem_domain(&different_topology, &expected).is_err());
    }

    #[test]
    fn accepted_projection_requires_durable_stage_for_a_cached_domain() {
        let stage = fullmag_session::FmsAcceptedStagePreparationReceipt {
            schema_version: fullmag_session::FMS_ACCEPTED_STAGE_PREPARATION_RECEIPT_SCHEMA.into(),
            run_id: "run-a".into(),
            step_id: "stage-a".into(),
            task_id: "task-a".into(),
            input_fingerprint: "input-a".into(),
            preparation_id: "prep-a".into(),
            plan_fingerprint: "plan-a".into(),
            task_receipt_payload_sha256: "payload-a".into(),
        };
        assert!(!stage_receipt_matches_projection(
            None,
            Some(&stage),
            "run-a",
            "stage-a",
            "prep-a",
            "plan-a",
        ));
        assert!(stage_receipt_matches_projection(
            Some(&stage),
            Some(&stage),
            "run-a",
            "stage-a",
            "prep-a",
            "plan-a",
        ));
        let mut next_stage = stage.clone();
        next_stage.preparation_id = "prep-b".into();
        assert!(!stage_receipt_matches_projection(
            Some(&next_stage),
            Some(&stage),
            "run-a",
            "stage-a",
            "prep-a",
            "plan-a",
        ));
    }

    #[test]
    fn accepted_state_reference_must_match_run_stage_and_preparation_domain() {
        let domain = format!("sha256:{}", "d".repeat(64));
        let reference = fullmag_quantities::AcceptedStateRef {
            id: fullmag_quantities::AcceptedStateId {
                run_id: "run-1".into(),
                stage_id: Some("stage-2".into()),
                accepted_step: 1,
                clock_digest: format!("sha256:{}", "a".repeat(64)),
                state_digest: format!("sha256:{}", "b".repeat(64)),
                domain_digest: domain.clone(),
                plan_digest: format!("sha256:{}", "c".repeat(64)),
            },
            generation: fullmag_quantities::AcceptedStateGeneration {
                runtime_epoch: 1,
                accepted_revision: 1,
            },
        };
        assert!(accepted_state_ref_matches_plan(
            Some(&reference),
            "run-1",
            "stage-2",
            domain.as_str(),
        ));
        assert!(!accepted_state_ref_matches_plan(
            Some(&reference),
            "run-1",
            "stage-1",
            "sha256:domain",
        ));
        assert!(!accepted_state_ref_matches_plan(
            Some(&reference),
            "run-1",
            "stage-2",
            "sha256:other",
        ));
    }
}

#[cfg(test)]
mod operation_profile_projection_tests {
    use super::{profile_content_identity, replace_operation_profile};
    use crate::schemas::diagnostics::SolverProfileResource;

    #[test]
    fn identical_profile_does_not_advance_revision() {
        let mut current = SolverProfileResource::default();
        current.revision = 17;
        let mut repeated = current.clone();
        repeated.revision = 1;
        assert_eq!(profile_content_identity(&current).unwrap(), profile_content_identity(&repeated).unwrap());
        assert!(!replace_operation_profile(&mut current, repeated).unwrap());
        assert_eq!(current.revision, 17);
        let mut changed = current.clone();
        changed.config.max_samples += 1;
        assert!(replace_operation_profile(&mut current, changed.clone()).unwrap());
        assert_eq!(current.revision, 18);
        assert!(!replace_operation_profile(&mut current, changed).unwrap());
        assert_eq!(current.revision, 18);
    }

    #[test]
    fn execution_config_survives_next_admission_overlay() {
        let mut profile = SolverProfileResource::default();
        let execution = profile.config.clone();
        let sample = serde_json::json!({"execution_config": execution,
            "sequence": 0, "operation_id": "antenna.closed_loop.inspect", "outcome": "completed",
            "total_wall_time_ns": 100, "native_operator_wall_ns": 80, "phases": [], "accounting_issue": false});
        // This test exercises the resource merge only; the receipt reader
        // independently validates all nine numerical timing phases.
        profile.operation_samples.push(serde_json::from_value(sample).unwrap());
        profile.config.max_samples += 1;
        assert_ne!(serde_json::to_value(&profile.config).unwrap(),
            serde_json::to_value(profile.operation_samples[0].execution_config.as_ref().unwrap()).unwrap());
        let execution = serde_json::to_value(&profile.operation_samples[0].execution_config).unwrap();
        let mut current = SolverProfileResource::default();
        assert!(replace_operation_profile(&mut current, profile).unwrap());
        assert_eq!(execution, serde_json::to_value(&current.operation_samples[0].execution_config).unwrap());
    }
}


#[cfg(test)]
mod antenna_operation_progress_projection_tests {
    #[test]
    fn completed_field_sampling_is_not_a_durable_completed_stage_or_llg_step() {
        let mut stage = crate::session::accepted_stage_record(
            "antenna-step", None, crate::types::StageLifecycleState::Failed);
        stage.applied_step = Some(99);
        stage.applied_time_seconds = Some(1.0);
        let progress = fullmag_runner::AntennaOperationProgress {
            phase: fullmag_runner::AntennaOperationPhase::PublishingResult,
            completed_targets: 1145, total_targets: 1145, source_cells: 1856,
            elapsed_seconds: 7985.0,
        };
        let observation = crate::accepted_study_worker::AcceptedLiveObservation {
            header: crate::accepted_study_worker::AcceptedLiveObservationHeader {
                schema_version: crate::accepted_study_worker::ACCEPTED_LIVE_OBSERVATION_SCHEMA.into(),
                run_id: "run".into(), task_id: "task".into(), step_id: "antenna-step".into(),
                attempt_id: "attempt".into(), ownership_epoch: 1, realization: "fem_cpu".into(),
                sequence: 5, written_at_unix_ms: 1000, stats: None,
                operation_progress: Some(progress), magnetization: None,
            },
            magnetization_values: None, fields: Vec::new(),
        };
        super::apply_observation_stage_progress(&mut stage, &observation);
        assert_eq!(stage.status, crate::types::StageLifecycleState::Failed);
        assert_eq!(stage.progress_percent, Some(100.0));
        assert_eq!(stage.applied_step, None);
        assert_eq!(stage.applied_time_seconds, None);
        assert_eq!(stage.completed_step, None);
        assert_eq!(stage.antenna_progress, Some(progress));
        let published = crate::schemas::runtime::AntennaOperationProgressResource::from(&progress);
        assert_eq!(published.phase, "publishing_result");
    }
    #[test]
    fn running_task_wins_over_a_later_terminal_antenna_diagnostic() {
        use fullmag_session::FmsTaskLifecycle as Life;
        let tasks = [(0, Life::Running), (1, Life::Succeeded)];
        let chosen = tasks.into_iter().max_by_key(|(order, life)| super::observation_priority(*life, *order)).unwrap();
        assert_eq!(chosen.0, 0);
        assert_eq!(super::observation_priority(Life::Stopping, 0), (true, 0));
        assert_eq!(super::observation_priority(Life::Failed, 1), (false, 1));
    }

    #[test]
    fn invalid_terminal_diagnostic_cannot_block_outcome_or_keep_stale_progress() {
        use crate::types::StageLifecycleState as Stage;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runs/run-a/worker-attempts/task-a/attempt-a/epoch-1");
        std::fs::create_dir_all(&path).unwrap();
        let foreign_header = serde_json::json!({
            "schema_version": crate::accepted_study_worker::ACCEPTED_LIVE_OBSERVATION_SCHEMA,
            "run_id": "run-a", "task_id": "task-a", "step_id": "step-a",
            "attempt_id": "foreign-attempt", "ownership_epoch": 1,
            "realization": "fem_cpu", "sequence": 2, "written_at_unix_ms": 100,
            "operation_progress": { "phase": "publishing_result", "completed_targets": 20,
                "total_targets": 20, "source_cells": 1856, "elapsed_seconds": 20.0 }
        });
        for bytes in [b"{".to_vec(), serde_json::to_vec(&foreign_header).unwrap()] {
            std::fs::write(path.join(crate::accepted_study_worker::ACCEPTED_LIVE_OBSERVATION_FILE), bytes).unwrap();
            let read = || crate::accepted_study_worker::read_accepted_live_observation(
                root.path(), "run-a", "task-a", "step-a", "attempt-a", 1, None)
                .map_err(|error| super::ApiError::conflict(format!("{error:#}")));
            assert!(super::observation_diagnostic_result(true, read()).is_err());
            for status in [Stage::Failed, Stage::Completed] {
                let observation = super::observation_diagnostic_result(false, read()).unwrap();
                assert!(observation.is_none());
                let mut stage = crate::session::accepted_stage_record("step-a", None, status);
                stage.antenna_progress = Some(fullmag_runner::AntennaOperationProgress {
                    phase: fullmag_runner::AntennaOperationPhase::EvaluatingField,
                    completed_targets: 4, total_targets: 20, source_cells: 1856, elapsed_seconds: 10.0,
                });
                stage.progress_percent = Some(20.0);
                let mut stages = crate::session::accepted_stage_execution_state(
                    vec![stage], crate::types::RuntimeLifecycleState::Failed);
                super::refresh_live_stage_progress(&mut stages, None);
                assert_eq!(stages.stages[0].status, status);
                assert_eq!(stages.stages[0].antenna_progress, None);
                assert_eq!(stages.stages[0].progress_percent, None);
            }
        }
        // A sequence/phase validation failure is also diagnostic-only after termination.
        assert!(super::observation_diagnostic_result(false,
            Err(super::ApiError::conflict("observation sequence regressed"))).unwrap().is_none());
    }

}
