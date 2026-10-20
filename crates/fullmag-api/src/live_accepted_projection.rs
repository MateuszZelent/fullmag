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
    artifact_revision: u64,
    status: &'static str,
    latest_output_identity: Option<String>,
    live_observation_identity: Option<String>,
    live_observation_sequence: Option<u64>,
    live_magnetization_sequence: Option<u64>,
    stage_execution: crate::types::StageExecutionState,
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
    artifact_catalog_revision: u64,
    status: &'static str,
    command_id: Option<String>,
    latest_state: Option<VerifiedOutput>,
    latest_total_energy: Option<fullmag_application::StudyScalarArtifact>,
    latest_output_identity: Option<String>,
    live_observation: Option<(usize, crate::accepted_study_worker::AcceptedLiveObservation)>,
    live_observation_identity: Option<String>,
    live_observation_sequence: Option<u64>,
    live_magnetization_sequence: Option<u64>,
    stage_execution: crate::types::StageExecutionState,
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
        loop {
            interval.tick().await;
            match poll_once(&state, &mut cursor).await {
                Ok(()) => {}
                Err(error) => {
                    tracing::warn!(
                        code = ?error.code,
                        error = %error,
                        "accepted live read-model projection deferred"
                    );
                }
            }
        }
    });
}

async fn poll_once(
    state: &Arc<AppState>,
    cursor: &mut Option<ProjectionCursor>,
) -> Result<(), ApiError> {
    let Some(context) = capture_context(state).await? else {
        return Ok(());
    };
    let Some(store_root) = state.submit_store_root.clone() else {
        return Ok(());
    };
    let expected = context.clone();
    let previous_cursor = cursor.clone();
    let projection = tokio::task::spawn_blocking(move || {
        load_durable_projection(&store_root, &expected, previous_cursor.as_ref())
    })
    .await
    .map_err(|error| ApiError::internal(format!("accepted projection task failed: {error}")))??;
    let Some(projection) = projection else {
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
        latest_output_identity: projection.latest_output_identity.clone(),
        live_observation_identity: projection.live_observation_identity.clone(),
        live_observation_sequence: projection.live_observation_sequence,
        live_magnetization_sequence: projection.live_magnetization_sequence,
        stage_execution: projection.stage_execution.clone(),
    };
    if cursor.as_ref() == Some(&next_cursor) {
        return Ok(());
    }
    // The accepted task-preparation bridge expects its caller to own the
    // transition fence.  Publish a stage-specific pinned domain before the
    // output field is admitted, then apply the field under that same fence.
    let _transition = state.current_live_session_transition.lock().await;
    let stage_preparation = if let Some((_, observation)) = projection
        .live_observation
        .as_ref()
        .filter(|(_, observation)| observation.magnetization_values.is_some())
    {
        ensure_stage_preparation_for_step(
            state,
            &context,
            &observation.header.step_id,
            None,
        )
        .await
        .and_then(|prepared| {
            validate_live_magnetization_domain(observation, &prepared.execution_plan)?;
            Ok(())
        })
    } else {
        ensure_stage_preparation(state, &context, &projection).await
    };
    if let Err(error) = stage_preparation {
        if let Err(clear_error) = clear_stale_magnetization(state, &context).await {
            tracing::error!(
                error = %clear_error,
                "failed to clear stale accepted magnetization after domain admission failure"
            );
        }
        return Err(error);
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
    let Some(artifact_catalog) = store
        .read_artifact_catalog(&context.run_id)
        .map_err(|error| ApiError::internal(format!("read accepted artifact catalog: {error}")))?
    else {
        return Ok(None);
    };
    run_catalog
        .validate()
        .map_err(|error| ApiError::conflict(format!("accepted run catalog is invalid: {error}")))?;
    artifact_catalog.validate().map_err(|error| {
        ApiError::conflict(format!("accepted artifact catalog is invalid: {error}"))
    })?;
    if run_catalog.run_id != context.run_id || artifact_catalog.run_id != context.run_id {
        return Err(ApiError::conflict_with_code(
            "accepted_projection_run_identity_mismatch",
            "accepted catalog identity differs from the current live run",
        ));
    }

    let status = accepted_projection_status(&store, &context.run_id, &run_catalog.tasks)?;
    let durable_changed = !previous_cursor.is_some_and(|cursor| {
        cursor_matches_context(cursor, context)
            && cursor.run_revision == run_catalog.revision
            && cursor.artifact_revision == artifact_catalog.revision
            && cursor.status == status
    });
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
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        &store,
        &specification.run_id,
        &specification.snapshot.project_id,
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "accepted Study snapshot cannot be loaded for projection: {error:#}"
        ))
    })?;
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
    let active_task = run_catalog
        .tasks
        .iter()
        .filter(|task| {
            matches!(
                task.lifecycle,
                fullmag_session::FmsTaskLifecycle::Running
                    | fullmag_session::FmsTaskLifecycle::Stopping
            )
        })
        .filter_map(|task| task_order.get(&task.task_id).map(|order| (*order, task)))
        .max_by_key(|(order, _)| *order);
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
        load_verified_outputs(&store, &run_catalog, &artifact_catalog, &task_order)?
    } else {
        Vec::new()
    };
    let stage_terminal_details = if durable_changed {
        load_stage_terminal_details(&store, &context.run_id, &run_catalog.tasks)?
    } else {
        std::collections::BTreeMap::new()
    };
    let latest_state = verified
        .iter()
        .filter(|output| output.data_kind == "state")
        .max_by(|left, right| compare_magnetization_outputs(left, right))
        .cloned();
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
            previous_cursor
                .filter(|cursor| cursor_matches_context(cursor, context))
                .and_then(|cursor| cursor.latest_output_identity.clone())
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
                &stage_terminal_details,
                status,
            )?
        }
    } else {
        build_stage_execution(
            &accepted,
            &run_catalog.tasks,
            live_observation.as_ref(),
            &verified,
            &stage_terminal_details,
            status,
        )?
    };
    let command_id = intent
        .specification
        .pointer("/parameters/live_workspace/command_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    Ok(Some(DurableProjection {
        run_catalog_revision: run_catalog.revision,
        artifact_catalog_revision: artifact_catalog.revision,
        status,
        command_id,
        latest_state,
        latest_total_energy,
        latest_output_identity,
        live_observation,
        live_observation_identity,
        live_observation_sequence,
        live_magnetization_sequence,
        stage_execution,
    }))
}

fn build_stage_execution(
    accepted: &fullmag_runtime_control::AcceptedStudySnapshot,
    tasks: &[fullmag_session::FmsTaskCatalogEntry],
    live_observation: Option<&(usize, crate::accepted_study_worker::AcceptedLiveObservation)>,
    verified_outputs: &[VerifiedOutput],
    terminal_details: &std::collections::BTreeMap<String, Option<String>>,
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
        if let Some(detail) = task
            .and_then(|task| terminal_details.get(&task.task_id))
            .and_then(Option::as_ref)
        {
            record.state_transition_reason = Some(detail.clone());
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
            let stats = &observation.header.stats;
            if stats.time.is_finite()
                && stats.time >= 0.0
                && stats.dt.is_finite()
                && stats.dt >= 0.0
            {
                record.applied_step = Some(stats.step);
                record.applied_time_seconds = Some(stats.time);
                record.progress_label = Some("Solver update".to_owned());
                record.progress_detail = Some(format!(
                    "step {}; time {:.9e} s; dt {:.9e} s",
                    stats.step, stats.time, stats.dt
                ));
                record.last_progress_unix_ms = Some(observation.header.written_at_unix_ms);
            }
        }
        stages.push(record);
    }
    Ok(crate::session::accepted_stage_execution_state(
        stages,
        crate::session::accepted_runtime_lifecycle_state(status),
    ))
}

fn refresh_live_stage_progress(
    stage_execution: &mut crate::types::StageExecutionState,
    live_observation: Option<&(usize, crate::accepted_study_worker::AcceptedLiveObservation)>,
) {
    let Some((_, observation)) = live_observation else {
        return;
    };
    let Some(stage) = stage_execution.stages.iter_mut().find(|stage| {
        stage.stage_id.as_deref() == Some(observation.header.step_id.as_str())
    }) else {
        return;
    };
    let stats = &observation.header.stats;
    if stats.time.is_finite()
        && stats.time >= 0.0
        && stats.dt.is_finite()
        && stats.dt >= 0.0
    {
        stage.applied_step = Some(stats.step);
        stage.applied_time_seconds = Some(stats.time);
        stage.progress_label = Some("Solver update".to_owned());
        stage.progress_detail = Some(format!(
            "step {}; time {:.9e} s; dt {:.9e} s",
            stats.step, stats.time, stats.dt
        ));
        stage.last_progress_unix_ms = Some(observation.header.written_at_unix_ms);
    }
}

/// Read raw terminal details only from the exact task attempt journal. The
/// task catalog remains authoritative for lifecycle, and this path does not
/// infer a typed scientific stop criterion from a generic task outcome.
fn load_stage_terminal_details(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    tasks: &[fullmag_session::FmsTaskCatalogEntry],
) -> Result<
    std::collections::BTreeMap<String, Option<String>>,
    ApiError,
> {
    use fullmag_session::{FmsCoordinatorJournalDirection as Direction, FmsTaskLifecycle as Life};

    let terminal_tasks = tasks
        .iter()
        .filter(|task| {
            matches!(task.lifecycle, Life::Failed | Life::Cancelled | Life::Interrupted)
        })
        .collect::<Vec<_>>();
    if terminal_tasks.is_empty() {
        return Ok(std::collections::BTreeMap::new());
    }
    let journal = store
        .read_coordinator_journal(run_id)
        .map_err(|error| ApiError::conflict(format!("read accepted terminal journal: {error}")))?;
    let mut reasons = std::collections::BTreeMap::new();
    for task in terminal_tasks {
        let mut failure_detail = None;
        let mut stop_detail = None;
        if let (Some(attempt_id), Some(ownership_epoch)) =
            (task.attempt_id.as_deref(), task.ownership_epoch)
        {
            for entry in journal.iter().filter(|entry| {
                entry.task_id == task.task_id
                    && entry.attempt_id == attempt_id
                    && entry.ownership_epoch == ownership_epoch
            }) {
                let transition: fullmag_application::CoordinatorTransition =
                    serde_json::from_value(entry.payload.clone()).map_err(|error| {
                        ApiError::conflict(format!(
                            "accepted task coordinator transition is invalid: {error}"
                        ))
                    })?;
                let claim = &transition.checkpoint.claim;
                if claim.run_id.as_str() != run_id
                    || claim.task_id.as_str() != task.task_id
                    || claim.attempt_id.as_str() != attempt_id
                    || claim.ownership_epoch.value() != ownership_epoch
                {
                    return Err(ApiError::conflict(
                        "accepted terminal journal claim differs from its task attempt",
                    ));
                }
                match (entry.direction, &transition.message) {
                    (
                        Direction::Command,
                        fullmag_application::CoordinatorMessage::Command(envelope),
                    ) => {
                        if let fullmag_application::WorkerCommand::Stop { reason } =
                            &envelope.command
                        {
                            stop_detail = Some(reason.clone());
                        }
                    }
                    (
                        Direction::Event,
                        fullmag_application::CoordinatorMessage::Event(envelope),
                    ) => match &envelope.event {
                        fullmag_application::WorkerEvent::Failed { reason, .. }
                        | fullmag_application::WorkerEvent::Rejected { reason } => {
                            failure_detail = Some(reason.clone());
                        }
                        _ => {}
                    },
                    _ => {
                        return Err(ApiError::conflict(
                            "accepted terminal journal direction differs from its transition",
                        ));
                    }
                }
            }
        }
        let detail = match task.lifecycle {
            Life::Failed | Life::Interrupted => failure_detail,
            Life::Cancelled => stop_detail,
            _ => continue,
        };
        reasons.insert(task.task_id.clone(), detail);
    }
    Ok(reasons)
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
    execution_plan: fullmag_ir::ExecutionPlanIR,
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
) -> Result<(), ApiError> {
    let Some(output) = projection.latest_state.as_ref() else {
        return Ok(());
    };
    let fullmag_application::DecodedStudyArtifact::MagnetizationState(state_output) =
        &output.decoded
    else {
        return Ok(());
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
    )
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
            let metadata = snapshot.metadata.as_ref()?;
            let execution_plan = serde_json::from_value::<fullmag_ir::ExecutionPlanIR>(
                metadata.get("execution_plan")?.clone(),
            )
            .ok()?;
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
            crate::live_scene_preparation::publish_accepted_task_preparation_with_transition(
                state,
                &live_context,
                &context.run_id,
                step_id,
                "accepted_projection_stage_preparation",
            )
            .await?;
        PreparedProjectionDomain {
            preparation_id: published.read_model.preparation_id,
            execution_plan: published.read_model.execution_plan,
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
    let mut current = state.current_live_state.write().await;
    let snapshot = current
        .as_mut()
        .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
    ensure_projection_context(state, context, snapshot)?;
    if snapshot.latest_fields.get("m").is_none() {
        return Ok(());
    }
    let mut fields = snapshot.latest_fields.clone();
    fields.remove("m");
    let stale = fields.entries().filter(|(_, value)| {
        value.pointer("/provenance/source").and_then(Value::as_str) == Some("accepted_live_observation")
    }).map(|(id, _)| id.clone()).collect::<Vec<_>>();
    for id in stale { fields.remove(&id); }
    let sequence = snapshot
        .terminal_field_generations
        .get(&context.run_id)
        .copied()
        .unwrap_or_default()
        .saturating_add(1);
    crate::session::apply_current_live_field_frame(
        snapshot,
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
    )?;
    let cleared = snapshot.clone();
    drop(current);
    crate::router_v2::handlers::sessions::status::record_current_live_heartbeat(state).await;
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime_state =
        crate::current_live_realtime_state_from_snapshot(state, &cleared, display_revision).await;
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

    let previous_status = next.session.status.clone();
    let terminal = matches!(projection.status, "completed" | "failed" | "cancelled");
    let mut changed = false;
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
    let public_status = if projection.status == "waiting_for_solve" {
        "awaiting_command"
    } else {
        projection.status
    };
    if next.session.status != public_status {
        next.session.status = public_status.to_string();
        changed = true;
    }
    next.runtime_status = crate::session::build_runtime_status_view(public_status);
    if terminal && next.session.finished_at_unix_ms == 0 {
        next.session.finished_at_unix_ms = unix_time_millis_now();
        changed = true;
    }

    if crate::session::replace_current_live_stage_execution(
        &mut next,
        projection.stage_execution.clone(),
    ) {
        changed = true;
    }
    if let Some((_, observation)) = projection.live_observation.as_ref() {
        let stats = &observation.header.stats;
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
        let field_revision = next.field_revision;
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
        changed |= next.field_revision != field_revision;
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
            let field_revision = next.field_revision;
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
            changed |= next.field_revision != field_revision;
        }
    } else {
        if let Some(output) = projection.latest_state.as_ref() {
            if let fullmag_application::DecodedStudyArtifact::MagnetizationState(state_output) =
                &output.decoded
            {
                let frame = accepted_output_frame(&next, state_output.step, state_output.time_s)?;
                let mut fields = crate::types::LatestFields::default();
                fields.insert(
                    "m".to_string(),
                    json!({
                        "source_step": state_output.step,
                        "source_time_seconds": state_output.time_s,
                        "solver_dt": state_output.solver_dt_s,
                        "source_revision": projection.artifact_catalog_revision,
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
    if !changed && previous_status == projection.status {
        return Ok(());
    }
    next.state_version = next.state_version.saturating_add(1);

    if terminal {
        complete_bound_command(
            state,
            &next,
            projection.command_id.as_deref(),
            projection.status,
        )
        .await?;
    }
    {
        let mut current = state.current_live_state.write().await;
        *current = Some(next.clone());
    }
    if terminal && projection.latest_state.as_ref().is_some_and(|output| output.accepted_state_ref.is_some()) {
        match crate::accepted_field_materialization::adopt_terminal_bundle(state).await {
            Ok(()) => {
                if let Some(published) = state.current_live_state.read().await.as_ref() {
                    next = published.clone();
                }
            }
            Err(error) => tracing::warn!(code = ?error.code, error = %error,
                "accepted terminal observation bundle unavailable; final magnetization remains valid"),
        }
    }
    crate::router_v2::handlers::sessions::status::record_current_live_heartbeat(state).await;
    let display_revision = state.current_display_selection.read().await.revision;
    let realtime_state =
        crate::current_live_realtime_state_from_snapshot(state, &next, display_revision).await;
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
    status: &str,
) -> Result<(), ApiError> {
    let Some(command_id) = command_id else {
        return Ok(());
    };
    let completion = match status {
        "completed" => crate::types::CommandCompletionState::Completed,
        "cancelled" => crate::types::CommandCompletionState::Cancelled,
        "failed" => crate::types::CommandCompletionState::Failed,
        _ => return Ok(()),
    };
    let completed_at = unix_time_millis_now();
    crate::live_command_journal::mutate(state, snapshot, |records| {
        let mut changed = false;
        for record in records.iter_mut() {
            if record.command.command_id != command_id
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
            record.completion_status = Some(completion);
            record.error = (completion == crate::types::CommandCompletionState::Failed)
                .then(|| "accepted Study execution failed".to_string());
            changed = true;
        }
        Ok(((), changed))
    })
    .await
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
            artifact_revision: 1,
            status: "running",
            latest_output_identity: None,
            live_observation_identity: None,
            live_observation_sequence: None,
            live_magnetization_sequence: None,
            stage_execution: crate::session::accepted_stage_execution_state(
                Vec::new(),
                crate::types::RuntimeLifecycleState::Unknown,
            ),
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
