//! Private, fail-closed acquisition of an authoring workspace for a future
//! development restart command.
//!
//! This guard closes HTTP mutation admission before taking the current-session
//! transition lock. It captures only a stable canonical authoring document and
//! identity after checking the in-memory runtime, preparation, mesh, command
//! queue, and command ledger. It does not poll, reconcile, bootstrap, stop a
//! process, inspect the accepted-run store, or prove resident-service
//! quiescence. A caller must obtain a separate owner-authenticated drain proof
//! before any process handoff.

use std::time::{SystemTime, UNIX_EPOCH};

use fullmag_authoring::SceneDocument;
use fullmag_runner::RuntimeStatus;
use serde_json::Value;
use tokio::sync::MutexGuard;

use crate::{
    error::ApiError,
    router_v2::middleware::development_admission::DevelopmentFreeze,
    schemas::status::SessionConnectivity,
    types::{
        AppState, CommandCompletionState, CommandLifecycleState, SessionStateResponse,
        StageLifecycleState, TrackedCommandRecord,
    },
};

const CONNECTIVITY_DEGRADED_AFTER_MS: u64 = 15_000;
const LIVE_MESH_BUILD_PHASES: &[&str] = &[
    "queued",
    "materializing",
    "preparing_domain",
    "meshing",
    "postprocessing",
    "ready",
];
const FEM_MESH_STAGES: &[&str] = &[
    "import",
    "classify",
    "generate",
    "optimize",
    "quality",
    "validation",
    "readiness",
];
const GRID_MESH_STAGES: &[&str] = &["grid", "membership", "runtime", "readiness"];

/// Workspace data held behind both mutation admission and the transition lock.
/// The scene is the canonical authoring document, including editor state; it
/// is never reconstructed from the lossy script-builder adapter.
#[allow(dead_code)]
pub(crate) enum RestartableWorkspace {
    NoSession {
        api_instance_id: String,
        session_epoch: u64,
    },
    Session {
        identity: RestartableWorkspaceIdentity,
        scene_document: SceneDocument,
    },
}

#[allow(dead_code)]
pub(crate) struct RestartableWorkspaceIdentity {
    pub(crate) api_instance_id: String,
    pub(crate) session_id: String,
    pub(crate) run_id: Option<String>,
    pub(crate) scene_id: String,
    pub(crate) session_epoch: u64,
}

/// Owns the freeze and transition guards for the lifetime of the captured
/// workspace. Dropping it reopens mutation admission through `DevelopmentFreeze`.
#[allow(dead_code)]
pub(crate) struct WorkspaceRestartAcquisition<'a> {
    _freeze: DevelopmentFreeze,
    _transition: MutexGuard<'a, ()>,
    pub(crate) workspace: RestartableWorkspace,
}

impl<'a> WorkspaceRestartAcquisition<'a> {
    /// Arm closed-on-drop while retaining both the exclusive freeze and
    /// transition guards through durable completion.
    pub(crate) fn retain_closed_for_completion(mut self) -> Self {
        self._freeze.arm_closed_on_drop();
        self
    }

    /// Reopen mutation admission only after the durable completion boundary
    /// has been confirmed. Consuming this guard releases exclusivity first.
    pub(crate) fn reopen_after_confirmed_completion(mut self) {
        self._freeze.reopen_on_confirmed_completion();
        drop(self);
    }

    /// Only the private owner coordinator calls this before attempting durable
    /// acceptance. An uncertain publication must not reopen HTTP mutations.
    pub(crate) fn retain_closed_admission(self) -> MutexGuard<'a, ()> {
        self._freeze.keep_closed_until_shutdown();
        self._transition
    }
}

/// Acquire a stable workspace snapshot for the future restart coordinator.
///
/// The call order is part of the safety contract: admission is closed and
/// already-admitted mutations drain before the current-session transition is
/// locked. Every rejection drops both guards and reopens admission. This does
/// not establish that the resident child process or external worker pool has
/// stopped; callers must not treat a returned guard as that proof.
#[allow(dead_code)]
pub(crate) async fn acquire_workspace_for_restart(
    state: &AppState,
) -> Result<WorkspaceRestartAcquisition<'_>, ApiError> {
    let freeze = state.development_admission.begin_freeze().await?;
    let transition = state.current_live_session_transition.lock().await;
    let session_epoch = state
        .current_live_session_epoch
        .load(std::sync::atomic::Ordering::Acquire);

    let snapshot = state.current_live_state.read().await.clone();
    {
        let queue = state.current_control_queue.lock().await;
        if !queue.is_empty() {
            return Err(not_restartable(
                "the current workspace still has queued commands",
            ));
        }
    }
    {
        let ledger = state.current_command_ledger.lock().await;
        validate_command_ledger(ledger.iter())?;
    }

    let workspace = match snapshot.as_ref() {
        None => RestartableWorkspace::NoSession {
            api_instance_id: state.request_scope_instance_id.clone(),
            session_epoch,
        },
        Some(snapshot) => {
            let kind = validate_runtime_status(snapshot)?;
            validate_preparation(snapshot)?;
            validate_mesh_workspace(snapshot.mesh_workspace.as_ref())?;
            let scene_document = snapshot
                .scene_document
                .as_ref()
                .ok_or_else(|| not_restartable("the current workspace has no canonical scene"))?;
            let raw_scene_id = scene_document.scene.id.as_str();
            let scene_id = raw_scene_id.trim();
            if scene_id.is_empty() || scene_id != raw_scene_id {
                return Err(not_restartable(
                    "the current workspace scene has no stable model identity",
                ));
            }

            let trusted_restore =
                state
                    .development_restored_authoring
                    .get()
                    .is_some_and(|identity| {
                        identity.matches(
                            &state.request_scope_instance_id,
                            &snapshot.session.session_id,
                            scene_id,
                            session_epoch,
                        )
                    });
            let is_scratch = is_idle_scratch(snapshot, kind, scene_id, trusted_restore)?;
            let run_id = if is_scratch {
                None
            } else {
                Some(validate_terminal_run(snapshot, kind)?)
            };
            validate_connectivity(state, is_scratch).await?;

            RestartableWorkspace::Session {
                identity: RestartableWorkspaceIdentity {
                    api_instance_id: state.request_scope_instance_id.clone(),
                    session_id: snapshot.session.session_id.clone(),
                    run_id,
                    scene_id: scene_id.to_string(),
                    session_epoch,
                },
                scene_document: scene_document.clone(),
            }
        }
    };

    Ok(WorkspaceRestartAcquisition {
        _freeze: freeze,
        _transition: transition,
        workspace,
    })
}

fn not_restartable(message: impl Into<String>) -> ApiError {
    ApiError::conflict_with_code("development_restart_not_safe", message)
}

fn validate_runtime_status(snapshot: &SessionStateResponse) -> Result<RuntimeStatus, ApiError> {
    let effective_code = crate::session::effective_runtime_status_code(snapshot);
    let expected = RuntimeStatus::from_status_code(&effective_code);
    if expected == RuntimeStatus::Unknown
        || snapshot.runtime_status.code != effective_code
        || snapshot.runtime_status.kind != expected
        || snapshot.runtime_status.is_busy != expected.is_busy()
        || snapshot.runtime_status.can_accept_commands != expected.can_accept_commands()
        || snapshot
            .live_state
            .as_ref()
            .is_some_and(|live| live.status != effective_code)
    {
        return Err(not_restartable(
            "the current workspace runtime status is unknown or inconsistent",
        ));
    }
    Ok(expected)
}

fn is_idle_scratch(
    snapshot: &SessionStateResponse,
    runtime: RuntimeStatus,
    scene_id: &str,
    trusted_restore: bool,
) -> Result<bool, ApiError> {
    if snapshot.session.status != "awaiting_command" {
        return Ok(false);
    }

    let scene = snapshot
        .scene_document
        .as_ref()
        .expect("caller validated the scene document");
    let is_scratch = snapshot.run.is_none()
        && snapshot.session.finished_at_unix_ms == 0
        && snapshot.session.interactive_session_requested
        && snapshot.session.script_path.is_empty()
        && snapshot.stage_execution.is_none()
        && snapshot.live_state.is_none()
        && (scene.scene.source_of_truth == "ui" || trusted_restore)
        && (snapshot.session.session_id == scene_id || trusted_restore);
    if !is_scratch {
        return Ok(false);
    }
    if runtime != RuntimeStatus::AwaitingCommand
        || snapshot.runtime_status.is_busy
        || !snapshot.runtime_status.can_accept_commands
    {
        return Err(not_restartable(
            "the scratch workspace is not demonstrably idle",
        ));
    }
    Ok(true)
}

fn validate_terminal_run(
    snapshot: &SessionStateResponse,
    runtime: RuntimeStatus,
) -> Result<String, ApiError> {
    let terminal_status = match runtime {
        RuntimeStatus::Completed => "completed",
        RuntimeStatus::Failed => "failed",
        RuntimeStatus::Cancelled => "cancelled",
        _ => {
            return Err(not_restartable(
                "only an idle scratch workspace or terminal run can be captured",
            ));
        }
    };
    let run = snapshot
        .run
        .as_ref()
        .ok_or_else(|| not_restartable("a terminal runtime has no matching run manifest"))?;
    if snapshot.session.session_id.trim().is_empty()
        || snapshot.session.session_id.as_str() != snapshot.session.session_id.trim()
        || snapshot.session.run_id.trim().is_empty()
        || snapshot.session.run_id.as_str() != snapshot.session.run_id.trim()
        || snapshot.session.run_id != run.run_id
        || run.session_id != snapshot.session.session_id
        || run.status != terminal_status
        || snapshot.session.status != terminal_status
        || snapshot.session.finished_at_unix_ms == 0
        || snapshot.runtime_status.is_busy
        || snapshot.runtime_status.can_accept_commands
    {
        return Err(not_restartable(
            "the terminal run and current session identities or statuses do not agree",
        ));
    }

    if let Some(stage_execution) = snapshot.stage_execution.as_ref() {
        if stage_execution.runtime_state.as_str() != terminal_status
            || stage_execution.active_stage_index.is_some()
            || stage_execution.active_stage_kind.is_some()
            || stage_execution.stage_statuses.iter().any(|status| {
                matches!(
                    status,
                    StageLifecycleState::Running
                        | StageLifecycleState::Paused
                        | StageLifecycleState::Unknown
                )
            })
            || stage_execution.stages.iter().any(|stage| {
                matches!(
                    stage.status,
                    StageLifecycleState::Running
                        | StageLifecycleState::Paused
                        | StageLifecycleState::Unknown
                )
            })
        {
            return Err(not_restartable(
                "the terminal run still reports an active or unknown stage",
            ));
        }
    }
    Ok(run.run_id.clone())
}

fn validate_preparation(snapshot: &SessionStateResponse) -> Result<(), ApiError> {
    let Some(preparation) = snapshot.simulation_preparation.as_ref() else {
        return Ok(());
    };
    if preparation.active_stage_id.is_some() || preparation.completed_at_unix_ms.is_none() {
        return Err(not_restartable(
            "simulation preparation is still active or has no terminal timestamp",
        ));
    }
    match preparation.status.as_str() {
        "ready" => {
            if preparation.failure.is_some()
                || preparation
                    .stages
                    .iter()
                    .any(|stage| !matches!(stage.status.as_str(), "completed" | "skipped"))
            {
                return Err(not_restartable(
                    "ready simulation preparation has incomplete or unknown stages",
                ));
            }
        }
        "failed" => {
            if preparation.failure.is_none()
                || preparation.stages.iter().any(|stage| {
                    !matches!(
                        stage.status.as_str(),
                        "completed" | "failed" | "pending" | "skipped"
                    )
                })
            {
                return Err(not_restartable(
                    "failed simulation preparation has inconsistent or unknown stages",
                ));
            }
        }
        _ => {
            return Err(not_restartable(
                "simulation preparation has a nonterminal or unknown status",
            ));
        }
    }
    Ok(())
}

fn validate_mesh_workspace(mesh_workspace: Option<&Value>) -> Result<(), ApiError> {
    let Some(mesh_workspace) = mesh_workspace else {
        return Ok(());
    };
    let workspace = mesh_workspace
        .as_object()
        .ok_or_else(|| not_restartable("the mesh workspace lifecycle is malformed"))?;
    if workspace
        .get("active_build")
        .is_some_and(|active_build| !active_build.is_null())
    {
        return Err(not_restartable("a mesh build is still active"));
    }
    let failure_error = match workspace.get("last_build_error") {
        None | Some(Value::Null) => None,
        Some(Value::String(error)) if !error.trim().is_empty() => Some(error.as_str()),
        Some(_) => {
            return Err(not_restartable(
                "the mesh workspace has a malformed terminal error",
            ));
        }
    };
    let has_terminal_failure = terminal_mesh_failure(workspace, failure_error);
    if failure_error.is_some() && !has_terminal_failure {
        return Err(not_restartable(
            "the mesh workspace error has no matching terminal failure record",
        ));
    }
    let Some(pipeline) = workspace.get("mesh_pipeline_status") else {
        return Ok(());
    };
    if pipeline.is_null() {
        return Ok(());
    }
    if pipeline.as_str() == Some("failed") {
        return if has_terminal_failure {
            Ok(())
        } else {
            Err(not_restartable(
                "mesh failure status has no matching terminal failure record",
            ))
        };
    }
    let stages = pipeline
        .as_array()
        .ok_or_else(|| not_restartable("mesh pipeline status is malformed"))?;
    if stages.is_empty() {
        return Err(not_restartable("mesh pipeline status has no known stages"));
    }
    let mut stage_ids = Vec::with_capacity(stages.len());
    let mut stage_statuses = Vec::with_capacity(stages.len());
    for stage in stages {
        let object = stage
            .as_object()
            .ok_or_else(|| not_restartable("mesh pipeline stage is malformed"))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| not_restartable("mesh pipeline stage identity is unknown"))?;
        let status = object
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| not_restartable("mesh pipeline stage status is unknown"))?;
        if stage_ids.contains(&id) {
            return Err(not_restartable("mesh pipeline repeats a stage identity"));
        }
        stage_ids.push(id);
        stage_statuses.push(status);
    }

    if stage_ids
        .iter()
        .any(|id| LIVE_MESH_BUILD_PHASES.contains(id))
    {
        validate_live_mesh_build_pipeline(
            &stage_ids,
            &stage_statuses,
            workspace,
            has_terminal_failure,
        )?;
    } else if stage_ids.len() == FEM_MESH_STAGES.len()
        && stage_ids.iter().all(|id| FEM_MESH_STAGES.contains(id))
    {
        validate_fem_mesh_pipeline(&stage_ids, &stage_statuses, workspace)?;
    } else if stage_ids.len() == GRID_MESH_STAGES.len()
        && stage_ids.iter().all(|id| GRID_MESH_STAGES.contains(id))
    {
        validate_grid_mesh_pipeline(&stage_ids, &stage_statuses, workspace)?;
    } else {
        return Err(not_restartable(
            "mesh pipeline contains an incomplete or unknown stage set",
        ));
    }
    Ok(())
}

fn validate_live_mesh_build_pipeline(
    stage_ids: &[&str],
    stage_statuses: &[&str],
    workspace: &serde_json::Map<String, Value>,
    has_terminal_failure: bool,
) -> Result<(), ApiError> {
    if stage_ids.len() != LIVE_MESH_BUILD_PHASES.len()
        || LIVE_MESH_BUILD_PHASES
            .iter()
            .any(|phase| !stage_ids.contains(phase))
    {
        return Err(not_restartable(
            "live mesh build pipeline is incomplete or has unknown phases",
        ));
    }

    let status_for = |phase: &str| {
        stage_ids
            .iter()
            .position(|id| *id == phase)
            .and_then(|index| stage_statuses.get(index).copied())
    };
    if status_for("ready") == Some("active") {
        let completed_phases = LIVE_MESH_BUILD_PHASES[..LIVE_MESH_BUILD_PHASES.len() - 1]
            .iter()
            .all(|phase| status_for(phase) == Some("done"));
        if completed_phases
            && workspace.get("last_build_error").is_none_or(Value::is_null)
            && workspace
                .get("last_build_summary")
                .is_some_and(terminal_mesh_success_summary)
        {
            return Ok(());
        }
        return Err(not_restartable(
            "ready mesh phase is not backed by a successful terminal summary",
        ));
    }

    if !has_terminal_failure {
        return Err(not_restartable(
            "live mesh pipeline has no confirmed terminal success or failure",
        ));
    }
    let Some(warning_phase) = LIVE_MESH_BUILD_PHASES
        .iter()
        .find(|phase| status_for(phase) == Some("warning"))
    else {
        return Err(not_restartable(
            "terminal mesh failure has no failed phase marker",
        ));
    };
    let warning_index = LIVE_MESH_BUILD_PHASES
        .iter()
        .position(|phase| phase == warning_phase)
        .expect("warning phase came from the canonical phase list");
    for (index, phase) in LIVE_MESH_BUILD_PHASES.iter().enumerate() {
        let expected = if index < warning_index {
            "done"
        } else if index == warning_index {
            "warning"
        } else {
            "idle"
        };
        if status_for(phase) != Some(expected) {
            return Err(not_restartable(
                "terminal mesh failure has inconsistent phase statuses",
            ));
        }
    }
    Ok(())
}

fn validate_fem_mesh_pipeline(
    stage_ids: &[&str],
    stage_statuses: &[&str],
    workspace: &serde_json::Map<String, Value>,
) -> Result<(), ApiError> {
    let valid_status = |id: &str, status: &str| match id {
        "import" => status == "done",
        "classify" | "generate" | "quality" => matches!(status, "done" | "idle"),
        "optimize" => status == "idle",
        "validation" => matches!(status, "done" | "warning"),
        "readiness" => matches!(status, "done" | "warning" | "idle"),
        _ => false,
    };
    validate_static_mesh_pipeline(stage_ids, stage_statuses, workspace, valid_status)
}

fn validate_grid_mesh_pipeline(
    stage_ids: &[&str],
    stage_statuses: &[&str],
    workspace: &serde_json::Map<String, Value>,
) -> Result<(), ApiError> {
    // The current FDM producer renders terminal "failed" as runtime "active".
    // Accept that presentation only with its matching terminal cost status;
    // the enclosing acquisition independently validates the runtime lifecycle.
    let terminal_failure = workspace
        .get("mesh_cost_report")
        .and_then(|report| report.get("status"))
        .and_then(Value::as_str)
        == Some("failed");
    let valid_status = |id: &str, status: &str| match id {
        "grid" | "membership" | "readiness" => matches!(status, "done" | "warning"),
        "runtime" => status == "done" || (status == "active" && terminal_failure),
        _ => false,
    };
    validate_static_mesh_pipeline(stage_ids, stage_statuses, workspace, valid_status)
}

fn validate_static_mesh_pipeline(
    stage_ids: &[&str],
    stage_statuses: &[&str],
    workspace: &serde_json::Map<String, Value>,
    valid_status: impl Fn(&str, &str) -> bool,
) -> Result<(), ApiError> {
    if stage_ids
        .iter()
        .zip(stage_statuses)
        .any(|(id, status)| !valid_status(id, status))
    {
        return Err(not_restartable(
            "static mesh pipeline contains active, pending, or unknown work",
        ));
    }
    if !has_static_mesh_snapshot(workspace) {
        return Err(not_restartable(
            "static mesh pipeline has no matching mesh summary",
        ));
    }
    Ok(())
}

fn has_static_mesh_snapshot(workspace: &serde_json::Map<String, Value>) -> bool {
    let mesh_summary = workspace.get("mesh_summary").and_then(Value::as_object);
    let cost_report = workspace.get("mesh_cost_report").and_then(Value::as_object);
    let has_count = mesh_summary.is_some_and(|summary| {
        ["node_count", "total_cells"]
            .iter()
            .any(|key| summary.get(*key).and_then(Value::as_u64).is_some())
    });
    let has_cost_status = cost_report
        .and_then(|report| report.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|status| !status.trim().is_empty());
    has_count && has_cost_status
}

fn terminal_mesh_success_summary(summary: &Value) -> bool {
    if summary.get("kind").and_then(Value::as_str) != Some("mesh_build_summary") {
        return false;
    }
    let direct_counts = summary
        .get("n_nodes")
        .and_then(Value::as_u64)
        .is_some_and(|count| count > 0)
        && summary
            .get("n_elements")
            .and_then(Value::as_u64)
            .is_some_and(|count| count > 0);
    let nested_mesh = summary.get("mesh_summary").and_then(Value::as_object);
    let nested_counts = nested_mesh.is_some_and(|mesh| {
        mesh.get("node_count")
            .and_then(Value::as_u64)
            .is_some_and(|count| count > 0)
            || mesh
                .get("total_cells")
                .and_then(Value::as_u64)
                .is_some_and(|count| count > 0)
    });
    (direct_counts || nested_counts)
        && (summary.get("status").is_none()
            || summary.get("status").and_then(Value::as_str) == Some("completed"))
}

fn terminal_mesh_failure(workspace: &serde_json::Map<String, Value>, error: Option<&str>) -> bool {
    let Some(error) = error else {
        return false;
    };
    let summary_matches = workspace
        .get("last_build_summary")
        .and_then(Value::as_object)
        .is_some_and(|summary| {
            summary.get("kind").and_then(Value::as_str) == Some("mesh_build_failed")
                && ["error", "message"].iter().any(|key| {
                    summary
                        .get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|summary_error| summary_error == error)
                })
        });
    let attempt_matches = workspace
        .get("last_build_attempt")
        .and_then(Value::as_object)
        .is_some_and(|attempt| {
            attempt.get("kind").and_then(Value::as_str) == Some("mesh_build_failed")
                && matches!(
                    attempt.get("status").and_then(Value::as_str),
                    Some("failed" | "rejected")
                )
                && attempt
                    .get("completed_at_unix_ms")
                    .and_then(Value::as_u64)
                    .is_some_and(|timestamp| timestamp > 0)
                && attempt.get("error").and_then(Value::as_str) == Some(error)
        });
    summary_matches || attempt_matches
}

fn validate_command_ledger<'a>(
    ledger: impl IntoIterator<Item = &'a TrackedCommandRecord>,
) -> Result<(), ApiError> {
    for record in ledger {
        let completion_is_consistent = match (record.status, record.completion_status) {
            (
                CommandLifecycleState::Completed,
                Some(
                    CommandCompletionState::Succeeded
                    | CommandCompletionState::Completed
                    | CommandCompletionState::Cancelled,
                ),
            ) => true,
            (CommandLifecycleState::Rejected, Some(CommandCompletionState::Rejected)) => true,
            (CommandLifecycleState::Failed, Some(CommandCompletionState::Failed)) => true,
            _ => false,
        };
        if !completion_is_consistent
            || !record
                .completed_at_unix_ms
                .is_some_and(|completed_at| completed_at > 0)
        {
            return Err(not_restartable(
                "the command ledger contains an active or unresolved command outcome",
            ));
        }
    }
    Ok(())
}

async fn validate_connectivity(state: &AppState, is_scratch: bool) -> Result<(), ApiError> {
    let connectivity = *state.current_live_connectivity.read().await;
    if connectivity != SessionConnectivity::Connected {
        return Err(not_restartable(
            "the current workspace runner connectivity is degraded or disconnected",
        ));
    }
    if is_scratch {
        // A newly created scratch scene has no runner heartbeat by design.
        return Ok(());
    }

    let last_seen = state
        .current_live_last_seen_unix_ms
        .load(std::sync::atomic::Ordering::Acquire);
    let now = current_unix_ms();
    if last_seen == 0
        || last_seen > now
        || now.saturating_sub(last_seen) >= CONNECTIVITY_DEGRADED_AFTER_MS
    {
        return Err(not_restartable(
            "the current workspace runner heartbeat is stale or unknown",
        ));
    }
    Ok(())
}

fn current_unix_ms() -> u64 {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::{
        router_v2::{handlers::sessions::create::create_empty_scene_document, tests},
        schemas::sessions::CreateSessionRequest,
        types::{RunManifest, SessionCommand, TrackedCommandRecord},
    };

    fn new_scene() -> SceneDocument {
        create_empty_scene_document(&CreateSessionRequest {
            name: "restart guard fixture".to_string(),
            backend: "fdm".to_string(),
            device: "cpu".to_string(),
            precision: "double".to_string(),
            replace_current: false,
        })
        .expect("scene fixture should be valid")
    }

    async fn scratch_state() -> Arc<AppState> {
        let state = tests::test_app_state_with_live_session().await;
        let scene = new_scene();
        let session_id = scene.scene.id.clone();
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().expect("fixture session should exist");
            snapshot.session.session_id = session_id.clone();
            snapshot.session.run_id = format!("run-{session_id}");
            snapshot.session.status = "awaiting_command".to_string();
            snapshot.session.script_path.clear();
            snapshot.session.interactive_session_requested = true;
            snapshot.session.finished_at_unix_ms = 0;
            snapshot.run = None;
            snapshot.live_state = None;
            snapshot.stage_execution = None;
            snapshot.simulation_preparation = None;
            snapshot.mesh_workspace = None;
            snapshot.scene_document = Some(scene);
            snapshot.runtime_status = crate::session::build_runtime_status_view("awaiting_command");
        }
        *state.current_live_connectivity.write().await = SessionConnectivity::Connected;
        state
    }

    fn session_command() -> SessionCommand {
        serde_json::from_value(serde_json::json!({
            "seq": 1,
            "command_id": "command-1",
            "kind": "run",
            "created_at_unix_ms": 1_700_000_000_000_u128
        }))
        .expect("minimal command fixture should deserialize")
    }

    #[tokio::test]
    async fn restored_scratch_requires_trusted_identity_and_still_rejects_busy_runtime() {
        let state = scratch_state().await;
        let mut snapshot = state.current_live_state.read().await.clone().unwrap();
        snapshot.scene_document.as_mut().unwrap().scene.id = "stable-model".into();
        snapshot
            .scene_document
            .as_mut()
            .unwrap()
            .scene
            .source_of_truth = "python".into();
        assert!(!is_idle_scratch(
            &snapshot,
            RuntimeStatus::AwaitingCommand,
            "stable-model",
            false
        )
        .unwrap());
        assert!(is_idle_scratch(
            &snapshot,
            RuntimeStatus::AwaitingCommand,
            "stable-model",
            true
        )
        .unwrap());
        snapshot.runtime_status.is_busy = true;
        assert!(is_idle_scratch(
            &snapshot,
            RuntimeStatus::AwaitingCommand,
            "stable-model",
            true
        )
        .is_err());
        snapshot.runtime_status.is_busy = false;
        snapshot.session.script_path = "script.py".into();
        assert!(!is_idle_scratch(
            &snapshot,
            RuntimeStatus::AwaitingCommand,
            "stable-model",
            true
        )
        .unwrap());
    }

    fn tracked_command(
        status: CommandLifecycleState,
        completion_status: Option<CommandCompletionState>,
    ) -> TrackedCommandRecord {
        TrackedCommandRecord {
            command: session_command(),
            request_id: None,
            status,
            dispatched_at_unix_ms: Some(1_700_000_000_100),
            completed_at_unix_ms: completion_status.map(|_| 1_700_000_000_200),
            completion_status,
            error: None,
        }
    }

    #[tokio::test]
    async fn explicit_no_session_and_idle_scratch_are_captured_under_freeze() {
        let no_session = tests::test_app_state();
        let acquisition = acquire_workspace_for_restart(&no_session)
            .await
            .expect("empty workspace should have an explicit no-session result");
        assert!(matches!(
            acquisition.workspace,
            RestartableWorkspace::NoSession { .. }
        ));
        assert!(no_session.development_admission.admit().await.is_err());
        drop(acquisition);
        assert!(no_session.development_admission.admit().await.is_ok());

        let state = scratch_state().await;
        let expected_scene = state
            .current_live_state
            .read()
            .await
            .as_ref()
            .unwrap()
            .scene_document
            .clone()
            .unwrap();
        let acquisition = acquire_workspace_for_restart(&state)
            .await
            .expect("canonical idle scratch should be captured");
        let RestartableWorkspace::Session {
            identity,
            scene_document,
        } = &acquisition.workspace
        else {
            panic!("scratch should return a session workspace");
        };
        assert_eq!(identity.session_id, expected_scene.scene.id);
        assert_eq!(identity.scene_id, expected_scene.scene.id);
        assert_eq!(*scene_document, expected_scene);
        assert!(state.development_admission.admit().await.is_err());
        drop(acquisition);
        assert!(state.development_admission.admit().await.is_ok());
    }

    #[tokio::test]
    async fn terminal_run_keeps_model_and_editor_document_with_distinct_identity() {
        let state = scratch_state().await;
        let scene = {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().unwrap();
            let mut scene = snapshot.scene_document.take().unwrap();
            scene.scene.id = "model-identity-7".to_string();
            scene.editor.selected_entity_id = Some("entity-42".to_string());
            let session_id = snapshot.session.session_id.clone();
            snapshot.session.run_id = "run-7".to_string();
            snapshot.session.status = "completed".to_string();
            snapshot.session.finished_at_unix_ms = u128::from(current_unix_ms());
            snapshot.run = Some(RunManifest {
                run_id: "run-7".to_string(),
                session_id,
                status: "completed".to_string(),
                total_steps: 7,
                final_time: Some(1.0),
                final_e_ex: None,
                final_e_demag: None,
                final_e_ext: None,
                final_e_ani: None,
                final_e_dmi: None,
                final_e_rotated_dmi: None,
                final_e_total: None,
                artifact_dir: "".to_string(),
            });
            snapshot.runtime_status = crate::session::build_runtime_status_view("completed");
            snapshot.scene_document = Some(scene.clone());
            scene
        };

        let acquisition = acquire_workspace_for_restart(&state)
            .await
            .expect("matching terminal run should be captured");
        let RestartableWorkspace::Session {
            identity,
            scene_document,
        } = &acquisition.workspace
        else {
            panic!("terminal run should return a session workspace");
        };
        assert_eq!(identity.run_id.as_deref(), Some("run-7"));
        assert_eq!(identity.scene_id, "model-identity-7");
        assert_ne!(identity.scene_id, identity.session_id);
        assert_eq!(*scene_document, scene);
        assert_eq!(
            scene_document.editor.selected_entity_id.as_deref(),
            Some("entity-42")
        );
    }

    #[tokio::test]
    async fn active_runtime_queue_and_unresolved_ledger_fail_closed() {
        for runtime_status in ["running", "paused", "future-runtime-state"] {
            let state = scratch_state().await;
            {
                let mut current = state.current_live_state.write().await;
                let snapshot = current.as_mut().unwrap();
                snapshot.session.status = runtime_status.to_string();
                snapshot.runtime_status = crate::session::build_runtime_status_view(runtime_status);
            }
            assert!(acquire_workspace_for_restart(&state).await.is_err());
            assert!(state.development_admission.admit().await.is_ok());
        }

        let state = scratch_state().await;
        state
            .current_control_queue
            .lock()
            .await
            .push_back(session_command());
        assert!(acquire_workspace_for_restart(&state).await.is_err());

        let state = scratch_state().await;
        state
            .current_command_ledger
            .lock()
            .await
            .push_back(tracked_command(CommandLifecycleState::Dispatched, None));
        assert!(acquire_workspace_for_restart(&state).await.is_err());

        let state = scratch_state().await;
        state
            .current_command_ledger
            .lock()
            .await
            .push_back(tracked_command(
                CommandLifecycleState::Completed,
                Some(CommandCompletionState::Unknown),
            ));
        assert!(acquire_workspace_for_restart(&state).await.is_err());
    }

    #[tokio::test]
    async fn stale_connectivity_active_preparation_and_mesh_work_are_rejected() {
        let state = scratch_state().await;
        *state.current_live_connectivity.write().await = SessionConnectivity::Degraded;
        assert!(acquire_workspace_for_restart(&state).await.is_err());

        let state = scratch_state().await;
        state
            .current_live_last_seen_unix_ms
            .store(0, std::sync::atomic::Ordering::Release);
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().unwrap();
            snapshot.session.status = "completed".to_string();
            snapshot.session.run_id = "run-7".to_string();
            snapshot.session.finished_at_unix_ms = u128::from(current_unix_ms());
            snapshot.run = Some(RunManifest {
                run_id: "run-7".to_string(),
                session_id: snapshot.session.session_id.clone(),
                status: "completed".to_string(),
                total_steps: 0,
                final_time: None,
                final_e_ex: None,
                final_e_demag: None,
                final_e_ext: None,
                final_e_ani: None,
                final_e_dmi: None,
                final_e_rotated_dmi: None,
                final_e_total: None,
                artifact_dir: String::new(),
            });
            snapshot.runtime_status = crate::session::build_runtime_status_view("completed");
        }
        assert!(acquire_workspace_for_restart(&state).await.is_err());

        let state = scratch_state().await;
        {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().unwrap();
            snapshot.simulation_preparation = Some(crate::types::SimulationPreparationSnapshot {
                preparation_id: "prep-running".to_string(),
                revision: 1,
                status: "running".to_string(),
                active_stage_id: Some("meshing".to_string()),
                started_at_unix_ms: 1_700_000_000_000,
                completed_at_unix_ms: None,
                stages: Vec::new(),
                log_tail: Vec::new(),
                failure: None,
            });
        }
        assert!(acquire_workspace_for_restart(&state).await.is_err());

        let state = scratch_state().await;
        state
            .current_live_state
            .write()
            .await
            .as_mut()
            .unwrap()
            .mesh_workspace = Some(serde_json::json!({"active_build": {"status": "running"}}));
        assert!(acquire_workspace_for_restart(&state).await.is_err());

        let state = scratch_state().await;
        state
            .current_live_state
            .write()
            .await
            .as_mut()
            .unwrap()
            .mesh_workspace = Some(
            serde_json::json!({"mesh_pipeline_status": [{"id": "remesh", "status": "queued"}]}),
        );
        assert!(acquire_workspace_for_restart(&state).await.is_err());
    }

    #[test]
    fn mesh_pipeline_accepts_only_confirmed_terminal_builds_and_static_snapshots() {
        let live_success = serde_json::json!({
            "active_build": null,
            "last_build_error": null,
            "last_build_summary": {
                "kind": "mesh_build_summary",
                "n_nodes": 128,
                "n_elements": 64
            },
            "mesh_pipeline_status": [
                {"id": "queued", "status": "done"},
                {"id": "materializing", "status": "done"},
                {"id": "preparing_domain", "status": "done"},
                {"id": "meshing", "status": "done"},
                {"id": "postprocessing", "status": "done"},
                {"id": "ready", "status": "active"}
            ]
        });
        assert!(validate_mesh_workspace(Some(&live_success)).is_ok());

        let mut active_build = live_success.clone();
        active_build["active_build"] = serde_json::json!({"build_id": "mesh:active"});
        assert!(validate_mesh_workspace(Some(&active_build)).is_err());

        let mut active_phase = live_success.clone();
        active_phase["mesh_pipeline_status"][3]["status"] = serde_json::json!("active");
        active_phase["mesh_pipeline_status"][5]["status"] = serde_json::json!("idle");
        assert!(validate_mesh_workspace(Some(&active_phase)).is_err());

        let mut missing_summary_counts = live_success.clone();
        missing_summary_counts["last_build_summary"] = serde_json::json!({
            "kind": "mesh_build_summary"
        });
        assert!(validate_mesh_workspace(Some(&missing_summary_counts)).is_err());

        let terminal_failure = serde_json::json!({
            "active_build": null,
            "last_build_error": "mesher rejected candidate",
            "last_build_summary": {
                "kind": "mesh_build_failed",
                "error": "mesher rejected candidate"
            },
            "mesh_pipeline_status": [
                {"id": "queued", "status": "done"},
                {"id": "materializing", "status": "done"},
                {"id": "preparing_domain", "status": "done"},
                {"id": "meshing", "status": "warning"},
                {"id": "postprocessing", "status": "idle"},
                {"id": "ready", "status": "idle"}
            ]
        });
        assert!(validate_mesh_workspace(Some(&terminal_failure)).is_ok());

        let mut unconfirmed_warning = terminal_failure.clone();
        unconfirmed_warning["last_build_summary"] = serde_json::Value::Null;
        assert!(validate_mesh_workspace(Some(&unconfirmed_warning)).is_err());

        let mut queued_after_failure = terminal_failure.clone();
        queued_after_failure["mesh_pipeline_status"][4]["status"] = serde_json::json!("queued");
        assert!(validate_mesh_workspace(Some(&queued_after_failure)).is_err());

        let fem_snapshot = serde_json::json!({
            "mesh_summary": {"node_count": 512, "element_count": 384},
            "mesh_cost_report": {"node_count": 512, "status": "waiting_for_compute"},
            "mesh_pipeline_status": [
                {"id": "import", "status": "done"},
                {"id": "classify", "status": "idle"},
                {"id": "generate", "status": "done"},
                {"id": "optimize", "status": "idle"},
                {"id": "quality", "status": "idle"},
                {"id": "validation", "status": "warning"},
                {"id": "readiness", "status": "warning"}
            ]
        });
        assert!(validate_mesh_workspace(Some(&fem_snapshot)).is_ok());

        let grid_snapshot = serde_json::json!({
            "mesh_summary": {"total_cells": 0, "active_cells": 0},
            "mesh_cost_report": {"total_cells": 0, "status": "awaiting_command"},
            "mesh_pipeline_status": [
                {"id": "grid", "status": "warning"},
                {"id": "membership", "status": "warning"},
                {"id": "runtime", "status": "done"},
                {"id": "readiness", "status": "warning"}
            ]
        });
        assert!(validate_mesh_workspace(Some(&grid_snapshot)).is_ok());

        let mut unknown_stage = fem_snapshot.clone();
        unknown_stage["mesh_pipeline_status"][6]["id"] = serde_json::json!("future_stage");
        assert!(validate_mesh_workspace(Some(&unknown_stage)).is_err());
        let mut active_grid_runtime = grid_snapshot.clone();
        active_grid_runtime["mesh_pipeline_status"][2]["status"] = serde_json::json!("active");
        assert!(validate_mesh_workspace(Some(&active_grid_runtime)).is_err());
        let mut failed_grid_runtime = active_grid_runtime.clone();
        failed_grid_runtime["mesh_cost_report"]["status"] = serde_json::json!("failed");
        assert!(validate_mesh_workspace(Some(&failed_grid_runtime)).is_ok());
        failed_grid_runtime["active_build"] = serde_json::json!({"build_id": "new-build"});
        assert!(validate_mesh_workspace(Some(&failed_grid_runtime)).is_err());
    }

    #[test]
    fn scalar_mesh_failure_requires_a_matching_completed_attempt() {
        let failure = serde_json::json!({
            "active_build": null,
            "last_build_error": "candidate rejected",
            "last_build_attempt": {
                "kind": "mesh_build_failed",
                "status": "rejected",
                "error": "candidate rejected",
                "completed_at_unix_ms": 42
            },
            "mesh_pipeline_status": "failed"
        });
        assert!(validate_mesh_workspace(Some(&failure)).is_ok());

        let mut unresolved = failure.clone();
        unresolved["last_build_attempt"]["completed_at_unix_ms"] = serde_json::json!(0);
        assert!(validate_mesh_workspace(Some(&unresolved)).is_err());

        let mut mismatched = failure.clone();
        mismatched["last_build_attempt"]["error"] = serde_json::json!("different error");
        assert!(validate_mesh_workspace(Some(&mismatched)).is_err());
    }

    #[test]
    fn completed_ledger_entries_require_known_terminal_completion_and_timestamp() {
        assert!(validate_command_ledger(&[tracked_command(
            CommandLifecycleState::Completed,
            Some(CommandCompletionState::Succeeded)
        )])
        .is_ok());
        assert!(validate_command_ledger(&[tracked_command(
            CommandLifecycleState::Completed,
            None
        )])
        .is_err());
        assert!(validate_command_ledger(&[tracked_command(
            CommandLifecycleState::Failed,
            Some(CommandCompletionState::Unknown)
        )])
        .is_err());
        let mut missing_timestamp = tracked_command(
            CommandLifecycleState::Completed,
            Some(CommandCompletionState::Succeeded),
        );
        missing_timestamp.completed_at_unix_ms = Some(0);
        assert!(validate_command_ledger(&[missing_timestamp]).is_err());
    }
}
