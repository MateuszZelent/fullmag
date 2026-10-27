//! Private terminal-workspace retirement for the next script in one backend.
//!
//! This route is deliberately narrower than accepted-run recovery. It consumes
//! no RunIntent, never calls Solve, never releases a host resource, and never
//! resets the native start gate. It only archives the current authoring
//! projection after the exact run/catalog/lease/host-release authorities agree,
//! then clears the process-local current-workspace pointer.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
};

use anyhow::{bail, Context, Result};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    error::ApiError,
    session::effective_runtime_status_code,
    types::{AppState, SessionStateResponse, StageLifecycleState},
};

const REQUEST_SCHEMA: &str = "fullmag.live-workspace-retirement-request.v1";
const PROOF_SCHEMA: &str = "fullmag.live-workspace-retirement-proof.v2";
const RESPONSE_SCHEMA: &str = "fullmag.live-workspace-retirement-response.v1";
const CONTEXT_SCHEMA: &str = "fullmag.live-workspace-retirement-context.v1";
pub(crate) const RETIREMENT_ENDPOINT: &str = "/v1/internal/live/current/retire";
const ARCHIVE_ROOT: &str = "retirements";
const MANIFEST_PATH: &str = "project/retirement-manifest.json";
const MAX_MANIFEST_BYTES: usize = 512 * 1024;
const MAX_DOCUMENT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_DOCUMENT_BYTES: usize = 32 * 1024 * 1024;
/// Outcome of a Docker startup workspace whose script was rejected before any
/// RunIntent was accepted. Its evidence is exact run-store absence.
const UNADMITTED_OUTCOME: &str = "startup_failed";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LiveRetirementRequest {
    pub schema: String,
    pub operation_id: String,
    pub session_id: String,
    pub run_id: String,
    pub request_scope_epoch: String,
    #[serde(default)]
    pub predecessor: Option<RetirementPredecessor>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RetirementPredecessor {
    pub proof_sha256: String,
    pub request_scope_epoch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct DocumentPin {
    pub object_ref: String,
    pub sha256: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ReleasedHostReservationPin {
    pub identity: fullmag_session::host_resource_ledger::HostReservationIdentity,
    pub request_sha256: String,
    pub release_proof_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LiveRetirementProof {
    schema: String,
    state: String,
    operation_id: String,
    session_id: String,
    run_id: String,
    request_scope_epoch: String,
    session_epoch: u64,
    scene_revision: u64,
    state_version: u64,
    accepted_proof_sha256: Option<String>,
    terminal_outcome: String,
    terminal_catalog_revision: u64,
    ui_state_scope: String,
    script_available: bool,
    artifact_catalog_sha256: String,
    documents: BTreeMap<String, DocumentPin>,
    terminal_evidence_sha256: String,
    host_released_reservations: Vec<ReleasedHostReservationPin>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TerminalRetirementEvidence {
    terminal_outcome: String,
    terminal_catalog_revision: u64,
    terminal_evidence_sha256: String,
    host_released_reservations: Vec<ReleasedHostReservationPin>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CurrentRetirementFence {
    session_id: String,
    run_id: String,
    scene_revision: u64,
    state_version: u64,
    session_epoch: u64,
    artifact_catalog_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LiveRetirementResponse {
    pub schema: String,
    pub state: String,
    pub operation_id: String,
    pub session_id: String,
    pub run_id: String,
    /// The immutable scope of the API incarnation that created the archive.
    pub request_scope_epoch: String,
    /// The scope of the API incarnation that authenticated this response.
    pub api_request_scope_epoch: String,
    pub session_epoch: u64,
    pub scene_revision: u64,
    pub state_version: u64,
    pub terminal_outcome: String,
    pub archive_manifest_path: String,
    pub archive_sha256: String,
    pub terminal_evidence_sha256: String,
    pub ui_state_scope: String,
    pub script_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LiveRetirementContextResponse {
    pub schema: String,
    pub api_instance_id: String,
    pub request_scope_epoch: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
}

/// Read the current API incarnation and exact workspace identity before the
/// host wrapper constructs a retirement POST. This is authenticated and has
/// no mutation or archive side effect; an empty workspace is represented by
/// two null identity fields rather than a guessed epoch or synthetic run.
pub(crate) async fn retirement_context(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<LiveRetirementContextResponse>, ApiError> {
    if !crate::router_v2::middleware::compute_operator_auth::is_authorized(
        &headers,
        state.local_compute_operator_token.as_deref(),
    ) {
        return Err(ApiError::with_status_and_code(
            StatusCode::FORBIDDEN,
            "local_compute_operator_required",
            "a local compute operator is required for workspace retirement",
        ));
    }
    let api_instance_id = state.request_scope_instance_id.clone();
    if api_instance_id.trim().is_empty() {
        return Err(ApiError::internal("the API request scope instance is unavailable"));
    }
    let request_scope_epoch = current_request_scope(&state);
    let current = state.current_live_state.read().await.clone();
    let (session_id, run_id) = match current {
        Some(current) => {
            let session_id = current.session.session_id.clone();
            let run_id = current.session.run_id.clone();
            if session_id.trim().is_empty() || run_id.trim().is_empty() {
                return Err(ApiError::conflict_with_code(
                    "live_retirement_current_mismatch",
                    "current workspace has incomplete session/run identity",
                ));
            }
            (Some(session_id), Some(run_id))
        }
        None => (None, None),
    };
    Ok(Json(LiveRetirementContextResponse {
        schema: CONTEXT_SCHEMA.to_string(),
        api_instance_id,
        request_scope_epoch,
        session_id,
        run_id,
    }))
}

impl LiveRetirementRequest {
    fn validate(&self) -> Result<()> {
        if self.schema != REQUEST_SCHEMA {
            bail!("unsupported live-workspace retirement schema");
        }
        for (value, field) in [
            (&self.operation_id, "operation_id"),
            (&self.session_id, "session_id"),
            (&self.run_id, "run_id"),
        ] {
            fullmag_session::repository_path::validate_store_id(value)
                .with_context(|| format!("invalid retirement {field}"))?;
        }
        validate_scope(&self.request_scope_epoch, "request_scope_epoch")?;
        if let Some(predecessor) = &self.predecessor {
            validate_digest(&predecessor.proof_sha256, "predecessor proof")?;
            validate_scope(&predecessor.request_scope_epoch, "predecessor request scope")?;
        }
        Ok(())
    }
}

/// Retire one exact terminal current workspace. The host wrapper must hold its
/// control-volume operation lock while calling this route, but the API never
/// trusts that lock as a resource proof: it re-reads the native store, exact
/// local leases, and host ledger itself.
pub(crate) async fn retire_current_live(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<LiveRetirementRequest>,
) -> Result<Json<LiveRetirementResponse>, ApiError> {
    if !crate::router_v2::middleware::compute_operator_auth::is_authorized(
        &headers,
        state.local_compute_operator_token.as_deref(),
    ) {
        return Err(ApiError::with_status_and_code(
            StatusCode::FORBIDDEN,
            "local_compute_operator_required",
            "a local compute operator is required for workspace retirement",
        ));
    }
    request
        .validate()
        .map_err(|error| ApiError::bad_request(format!("invalid workspace retirement: {error}")))?;

    // Close HTTP mutation admission before taking the transition guard. The
    // returned guard remains held through authoring capture, archive CAS, and
    // pointer retirement; this prevents queued/admitted commands from being
    // lost by the final process-local reset.
    let mut acquisition = Some(
        crate::router_v2::handlers::platform::development_restart::acquire_workspace_for_live_retirement(
            &state,
        )
        .await
        .map_err(map_workspace_acquisition_error)?,
    );
    let current_scope = current_request_scope(&state);
    let archive_root = retirement_store_root(&state)?;
    let existing = match read_existing_archive(&archive_root, &request.operation_id) {
        Ok(existing) => existing,
        Err(error) => {
            return Err(ApiError::conflict_with_code(
                "live_retirement_outcome_unknown",
                format!("cannot inspect retirement archive: {error:#}"),
            ));
        }
    };

    let current = state.current_live_state.read().await.clone();
    let Some(current) = current else {
        let Some((proof, bytes)) = existing else {
            return Err(ApiError::conflict_with_code(
                "live_retirement_current_missing",
                "the current workspace is empty and no matching retirement archive exists",
            ));
        };
        validate_archive_replay(&proof, &bytes, &request, &current_scope).map_err(|error| {
            ApiError::conflict_with_code("live_retirement_predecessor_required", error.to_string())
        })?;
        let store = open_retirement_store(&state)?;
        let unadmitted = proof.terminal_outcome == UNADMITTED_OUTCOME;
        with_retirement_evidence(&store, &request.run_id, unadmitted, None, |evidence| {
            validate_evidence_for_proof(&proof, &evidence)?;
            Ok(())
        })
        .map_err(|error| {
            ApiError::conflict_with_code(
                "live_retirement_terminal_evidence_unknown",
                format!("fresh replay evidence is unavailable: {error:#}"),
            )
        })?;
        acquisition
            .take()
            .expect("retirement acquisition must remain held")
            .reopen_after_confirmed_completion();
        return Ok(Json(response_for_proof(
            &proof,
            &bytes,
            "replayed",
            &request.request_scope_epoch,
        )));
    };

    validate_current_request(&state, &current, &request, &current_scope).map_err(|error| {
        ApiError::conflict_with_code("live_retirement_current_mismatch", error.to_string())
    })?;

    let accepted_proof_sha256 = state
        .accepted_run_reattach_identity
        .read()
        .await
        .as_ref()
        .map(|identity| identity.proof_sha256.clone());
    let terminal_outcome = terminal_snapshot_outcome(&current).map_err(|error| {
        ApiError::conflict_with_code("live_retirement_runtime_not_terminal", error.to_string())
    })?;
    let unadmitted = terminal_outcome == UNADMITTED_OUTCOME;
    let current_fence = current_retirement_fence(&state, &current);

    // A publication may have succeeded immediately before a process failure.
    // Validate that immutable archive against the still-current owner, then
    // finish the pointer transition without touching native run state again.
    let store = open_retirement_store(&state)?;

    if let Some((proof, bytes)) = existing {
        validate_proof_for_current(
            &proof,
            &bytes,
            &request,
            &current,
            &current_scope,
            accepted_proof_sha256.as_deref(),
        )
        .map_err(|error| ApiError::conflict_with_code("live_retirement_proof_mismatch", error.to_string()))?;
        let realtime = crate::current_live_realtime_state_from_snapshot(
            &state,
            &current,
            current.display_selection.revision,
        )
        .await;
        let replay_result = with_retirement_evidence(
            &store,
            &request.run_id,
            unadmitted,
            Some(&proof.terminal_outcome),
            |evidence| {
                validate_evidence_for_proof(&proof, &evidence)?;
                clear_current_workspace_pointer(&state, &current_fence)
            },
        );
        if let Err(error) = replay_result {
            return Err(ApiError::conflict_with_code(
                "live_retirement_current_changed",
                format!("current workspace changed or durable evidence drifted before replay: {error}"),
            ));
        }
        if let Err(error) = finish_current_workspace_clear(&state, &realtime).await {
            return Err(error);
        }
        acquisition
            .take()
            .expect("retirement acquisition must remain held")
            .reopen_after_confirmed_completion();
        return Ok(Json(response_for_proof(
            &proof,
            &bytes,
            "replayed",
            &request.request_scope_epoch,
        )));
    }

    let initial_evidence = with_retirement_evidence(
        &store,
        &request.run_id,
        unadmitted,
        Some(terminal_outcome),
        Ok,
    )
    .map_err(|error| {
        ApiError::conflict_with_code(
            "live_retirement_terminal_evidence_unknown",
            format!("terminal evidence is unavailable: {error:#}"),
        )
    })?;

    let captured = crate::session_persistence::capture_live_retirement_documents(&state, &current)
        .await
        .map_err(|error| {
            tracing::warn!(operation_id = %request.operation_id, error = %error,
                "live workspace retirement authoring capture failed");
            // No archive or current-pointer publication has happened here.
            // Preserve the workspace and report a definite refusal, rather
            // than quarantining a launcher operation as an unknown commit.
            ApiError::conflict_with_code(
                "live_retirement_capture_failed",
                format!("Workspace capture failed before archive publication; the current workspace is retained: {}",
                    error.message.chars().take(1024).collect::<String>()),
            )
        })?;
    let proof = LiveRetirementProof {
        schema: PROOF_SCHEMA.to_string(),
        state: "retired".to_string(),
        operation_id: request.operation_id.clone(),
        session_id: request.session_id.clone(),
        run_id: request.run_id.clone(),
        request_scope_epoch: request.request_scope_epoch.clone(),
        session_epoch: state.current_live_session_epoch.load(Ordering::Acquire),
        scene_revision: current.scene_document.as_ref().map(|scene| scene.revision).unwrap_or(0),
        state_version: current.state_version,
        artifact_catalog_sha256: artifact_catalog_sha256(&current),
        accepted_proof_sha256,
        terminal_outcome: terminal_outcome.to_string(),
        terminal_catalog_revision: initial_evidence.terminal_catalog_revision,
        ui_state_scope: captured.ui_state_scope.to_string(),
        script_available: captured.script_available,
        documents: BTreeMap::new(),
        terminal_evidence_sha256: initial_evidence.terminal_evidence_sha256.clone(),
        host_released_reservations: initial_evidence.host_released_reservations.clone(),
    };
    let (proof, bytes) = match publish_archive(&archive_root, proof, captured.documents) {
        Ok(published) => published,
        Err(error) => {
            return Err(ApiError::conflict_with_code(
                "live_retirement_publication_unknown",
                error.to_string(),
            ));
        }
    };

    let realtime = crate::current_live_realtime_state_from_snapshot(
        &state,
        &current,
        current.display_selection.revision,
    )
    .await;
    let final_result = with_retirement_evidence(
        &store,
        &request.run_id,
        unadmitted,
        Some(&proof.terminal_outcome),
        |final_evidence| {
            if final_evidence != initial_evidence {
                bail!("terminal evidence changed after archive publication");
            }
            clear_current_workspace_pointer(&state, &current_fence)
        },
    );
    if let Err(error) = final_result {
        return Err(ApiError::conflict_with_code(
            "live_retirement_current_changed_after_publication",
            format!("retirement archive is durable but current workspace changed: {error}"),
        ));
    }
    if let Err(error) = finish_current_workspace_clear(&state, &realtime).await {
        return Err(error);
    }
    acquisition
        .take()
        .expect("retirement acquisition must remain held")
        .reopen_after_confirmed_completion();
    Ok(Json(response_for_proof(
        &proof,
        &bytes,
        "retired",
        &request.request_scope_epoch,
    )))
}

fn current_request_scope(state: &AppState) -> String {
    format!(
        "{}:{}",
        state.request_scope_instance_id,
        state.current_live_session_epoch.load(Ordering::Acquire)
    )
}

fn map_workspace_acquisition_error(error: ApiError) -> ApiError {
    if error.code.as_deref() == Some("development_restart_not_safe") {
        tracing::warn!(reason = %error, "live workspace retirement preflight refused");
        return ApiError::conflict_with_code(
            "live_retirement_busy",
            "the current workspace is not safely quiescent for retirement",
        );
    }
    error
}

fn current_retirement_fence(state: &AppState, current: &SessionStateResponse) -> CurrentRetirementFence {
    CurrentRetirementFence {
        session_id: current.session.session_id.clone(),
        run_id: current.session.run_id.clone(),
        scene_revision: current.scene_document.as_ref().map(|scene| scene.revision).unwrap_or(0),
        state_version: current.state_version,
        session_epoch: state.current_live_session_epoch.load(Ordering::Acquire),
        artifact_catalog_sha256: artifact_catalog_sha256(current),
    }
}

fn artifact_catalog_sha256(current: &SessionStateResponse) -> String {
    let artifacts = serde_json::to_value(&current.artifacts)
        .expect("artifact entries must be serializable");
    fullmag_session::canonical_json_sha256(&artifacts)
}

fn validate_current_request(
    state: &AppState,
    current: &SessionStateResponse,
    request: &LiveRetirementRequest,
    current_scope: &str,
) -> Result<()> {
    if request.request_scope_epoch != current_scope {
        bail!("request scope belongs to another API incarnation or epoch");
    }
    // An unadmitted startup failure has no run manifest; the session's
    // placeholder run identity is the only one to fence.
    let unadmitted = is_unadmitted_startup_failure(current)?;
    if current.session.session_id != request.session_id
        || current.session.run_id != request.run_id
        || (!unadmitted
            && (current.run.as_ref().map(|run| run.run_id.as_str())
                != Some(request.run_id.as_str())
                || current.run.as_ref().map(|run| run.session_id.as_str())
                    != Some(request.session_id.as_str())))
    {
        bail!("session/run identity differs from the current workspace");
    }
    if state.current_live_session_epoch.load(Ordering::Acquire) == 0 {
        bail!("current workspace has no allocated session epoch");
    }
    Ok(())
}

fn is_unadmitted_startup_failure(current: &SessionStateResponse) -> Result<bool> {
    crate::router_v2::handlers::platform::development_restart::is_unadmitted_startup_failure(current)
        .map_err(|error| anyhow::anyhow!(error.message))
}

fn terminal_snapshot_outcome(current: &SessionStateResponse) -> Result<&'static str> {
    if is_unadmitted_startup_failure(current)? {
        return Ok(UNADMITTED_OUTCOME);
    }
    let outcome = match current.runtime_status.kind {
        fullmag_runner::RuntimeStatus::Completed => "completed",
        fullmag_runner::RuntimeStatus::Failed => "failed",
        fullmag_runner::RuntimeStatus::Cancelled => "cancelled",
        _ => bail!("current runtime is not terminal"),
    };
    let run = current.run.as_ref().context("terminal workspace has no run")?;
    if current.session.status != outcome
        || run.status != outcome
        || effective_runtime_status_code(current) != outcome
        || current.runtime_status.is_busy
        || current.runtime_status.can_accept_commands
    {
        bail!("session, run, and runtime do not agree on one terminal outcome");
    }
    if let Some(stage) = current.stage_execution.as_ref() {
        if stage.active_stage_index.is_some()
            || stage.active_stage_kind.is_some()
            || stage.stage_statuses.iter().any(|status| {
                matches!(status, StageLifecycleState::Running | StageLifecycleState::Paused | StageLifecycleState::Unknown)
            })
            || stage.stages.iter().any(|item| {
                matches!(item.status, StageLifecycleState::Running | StageLifecycleState::Paused | StageLifecycleState::Unknown)
            })
        {
            bail!("terminal workspace still contains an active or unknown stage");
        }
    }
    Ok(outcome)
}

fn terminal_catalog_outcome(catalog: &fullmag_session::FmsRunCatalog) -> Result<&'static str> {
    catalog.validate()?;
    if catalog.tasks.is_empty()
        || catalog.tasks.iter().any(|task| {
            !matches!(
                task.lifecycle,
                fullmag_session::FmsTaskLifecycle::Succeeded
                    | fullmag_session::FmsTaskLifecycle::Failed
                    | fullmag_session::FmsTaskLifecycle::Cancelled
                    | fullmag_session::FmsTaskLifecycle::Interrupted
            )
        })
    {
        bail!("run catalog is not terminal");
    }
    if catalog.tasks.iter().any(|task| task.lifecycle == fullmag_session::FmsTaskLifecycle::Failed) {
        Ok("failed")
    } else if catalog.tasks.iter().any(|task| task.lifecycle == fullmag_session::FmsTaskLifecycle::Interrupted) {
        Ok("interrupted")
    } else if catalog.tasks.iter().any(|task| task.lifecycle == fullmag_session::FmsTaskLifecycle::Cancelled) {
        Ok("cancelled")
    } else {
        Ok("completed")
    }
}

fn normalize_terminal_outcome(outcome: &str) -> &str {
    if outcome == "interrupted" { "failed" } else { outcome }
}

fn open_retirement_store(state: &AppState) -> Result<fullmag_session::SessionStore, ApiError> {
    let root = retirement_store_root(state)?;
    fullmag_session::SessionStore::open_existing(root).map_err(|error| {
        ApiError::conflict_with_code(
            "live_retirement_terminal_evidence_unknown",
            format!("cannot open the accepted run store: {error:#}"),
        )
    })
}

/// Execute one short host-before-store read section. The callback must remain
/// synchronous: archive serialization and CAS publication happen after both
/// native writer guards have been released. The host fence is run-scoped, so
/// another store or run may continue to hold a reservation.
fn with_terminal_evidence_fence<T>(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    operation: impl FnOnce(
        &fullmag_session::host_resource_ledger::HostResourceLedgerSnapshot,
        &str,
    ) -> Result<T>,
) -> Result<T> {
    open_retirement_ledger(store)?.with_terminal_run_evidence_fence(
        store,
        run_id,
        |snapshot, evidence_sha256| operation(snapshot, evidence_sha256),
    )
}

/// Read retirement evidence for one run under its host-before-store fence.
/// An unadmitted startup failure proves exact run absence instead of a
/// terminal catalog; the callback sees the same evidence shape either way.
fn with_retirement_evidence<T>(
    store: &fullmag_session::SessionStore,
    run_id: &str,
    unadmitted: bool,
    expected_outcome: Option<&str>,
    operation: impl FnOnce(TerminalRetirementEvidence) -> Result<T>,
) -> Result<T> {
    if unadmitted {
        return open_retirement_ledger(store)?.with_unadmitted_run_absence_fence(
            store,
            run_id,
            |evidence_sha256| {
                operation(TerminalRetirementEvidence {
                    terminal_outcome: UNADMITTED_OUTCOME.to_string(),
                    terminal_catalog_revision: 0,
                    terminal_evidence_sha256: evidence_sha256.to_string(),
                    host_released_reservations: Vec::new(),
                })
            },
        );
    }
    with_terminal_evidence_fence(store, run_id, |snapshot, evidence_sha256| {
        operation(collect_terminal_evidence(
            store,
            snapshot,
            evidence_sha256,
            run_id,
            expected_outcome,
        )?)
    })
}

fn open_retirement_ledger(
    store: &fullmag_session::SessionStore,
) -> Result<fullmag_session::host_resource_ledger::HostResourceLedger> {
    let config_path = std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG")
        .map(PathBuf::from)
        .unwrap_or_else(|| store.root().join("runtime-services/APPLICATION.json"));
    let config = fullmag_session::runtime_service::RuntimeServiceConfig::read(&config_path)
        .context("read runtime service configuration")?;
    if config.store_root != store.root() {
        bail!("runtime service configuration belongs to another session store");
    }
    let binding = config.host_execution.context("runtime service has no host binding")?;
    fullmag_session::host_resource_ledger::HostResourceLedger::open_for_current_application(
        &binding.ledger_root,
        binding.policy,
    )
}

fn collect_terminal_evidence(
    store: &fullmag_session::SessionStore,
    snapshot: &fullmag_session::host_resource_ledger::HostResourceLedgerSnapshot,
    terminal_evidence_sha256: &str,
    run_id: &str,
    expected_outcome: Option<&str>,
) -> Result<TerminalRetirementEvidence> {
    let catalog = store
        .read_run_catalog(run_id)?
        .context("terminal evidence requires a durable run catalog")?;
    let catalog_outcome = normalize_terminal_outcome(terminal_catalog_outcome(&catalog)?);
    if let Some(expected) = expected_outcome {
        if catalog_outcome != normalize_terminal_outcome(expected) {
            bail!("durable run catalog outcome differs from the current terminal projection");
        }
    }
    let expected_store_id =
        fullmag_session::host_resource_ledger::HostResourceLedger::store_id(store.root())?;
    let host_released_reservations = collect_released_host_reservations(
        &snapshot.reservations,
        &expected_store_id,
        run_id,
    )?;
    Ok(TerminalRetirementEvidence {
        terminal_outcome: catalog_outcome.to_string(),
        terminal_catalog_revision: catalog.revision,
        terminal_evidence_sha256: terminal_evidence_sha256.to_string(),
        host_released_reservations,
    })
}

fn validate_evidence_for_proof(
    proof: &LiveRetirementProof,
    evidence: &TerminalRetirementEvidence,
) -> Result<()> {
    if normalize_terminal_outcome(&proof.terminal_outcome)
        != normalize_terminal_outcome(&evidence.terminal_outcome)
        || proof.terminal_catalog_revision != evidence.terminal_catalog_revision
        || proof.terminal_evidence_sha256 != evidence.terminal_evidence_sha256
        || proof.host_released_reservations != evidence.host_released_reservations
    {
        bail!("retirement proof does not match fresh terminal evidence");
    }
    Ok(())
}

fn collect_released_host_reservations(
    reservations: &[fullmag_session::host_resource_ledger::HostResourceReservation],
    expected_store_id: &str,
    run_id: &str,
) -> Result<Vec<ReleasedHostReservationPin>> {
    let mut released = Vec::new();
    for reservation in reservations.iter().filter(|row| {
        row.identity.store_id == expected_store_id && row.identity.run_id == run_id
    }) {
        if reservation.state
            != fullmag_session::host_resource_ledger::HostResourceReservationState::Released
        {
            bail!("exact run still owns a nonreleased host reservation");
        }
        let release_proof_sha256 = reservation
            .release_proof_sha256
            .clone()
            .context("released reservation has no release proof")?;
        validate_digest(&release_proof_sha256, "host release proof")?;
        validate_digest(&reservation.request_sha256, "host request proof")?;
        released.push(ReleasedHostReservationPin {
            identity: reservation.identity.clone(),
            request_sha256: reservation.request_sha256.clone(),
            release_proof_sha256,
        });
    }
    released.sort_by(|left, right| left.identity.cmp(&right.identity));
    Ok(released)
}

fn document_pins_for_archive(
    documents: &BTreeMap<String, Vec<u8>>,
) -> Result<BTreeMap<String, DocumentPin>> {
    let mut pins = BTreeMap::new();
    let mut total_bytes = 0usize;
    for (name, bytes) in documents {
        validate_document_name(name)?;
        if bytes.len() > MAX_DOCUMENT_BYTES {
            bail!("retirement document `{name}` exceeds its byte bound");
        }
        total_bytes = total_bytes
            .checked_add(bytes.len())
            .context("retirement document byte count overflowed")?;
        if total_bytes > MAX_TOTAL_DOCUMENT_BYTES {
            bail!("retirement documents exceed their aggregate byte bound");
        }
        let sha256 = fullmag_session::hex_sha256(bytes);
        pins.insert(
            name.clone(),
            DocumentPin {
                object_ref: sha256.clone(),
                sha256,
                byte_length: bytes.len() as u64,
            },
        );
    }
    Ok(pins)
}

fn publish_archive(
    archive_root: &Path,
    mut proof: LiveRetirementProof,
    documents: BTreeMap<String, Vec<u8>>,
) -> Result<(LiveRetirementProof, Vec<u8>)> {
    ensure_archive_root(archive_root)?;
    let expected_pins = document_pins_for_archive(&documents)?;
    let archive_directory =
        fullmag_session::repository_path::checked_path(archive_root, ARCHIVE_ROOT)?;
    let destination = fullmag_session::repository_path::checked_path(
        &archive_directory,
        &proof.operation_id,
    )?;
    if let Some((existing, bytes)) = read_archive_at(archive_root, &proof.operation_id)? {
        validate_same_proof_identity(&existing, &proof)?;
        if existing.documents != expected_pins {
            bail!("retirement operation already has conflicting archived documents");
        }
        return Ok((existing, bytes));
    }
    let staging = fullmag_session::repository_path::checked_path(
        &archive_directory,
        &format!(".{}.staging", proof.operation_id),
    )?;
    if fs::symlink_metadata(&staging).is_ok() {
        bail!("retirement staging directory already exists; publication outcome is unknown");
    }
    fs::create_dir(&staging)?;
    let staged = fullmag_session::SessionStore::open(&staging)?;
    let mut pins = BTreeMap::new();
    for (name, bytes) in &documents {
        let object_ref = staged.store_blob(bytes)?;
        let sha256 = fullmag_session::hex_sha256(bytes);
        pins.insert(name.clone(), DocumentPin { object_ref, sha256, byte_length: bytes.len() as u64 });
        staged.write_document(&format!("project/{name}"), bytes)?;
    }
    proof.documents = pins;
    let manifest = serde_json::to_vec_pretty(&proof)?;
    if manifest.len() > MAX_MANIFEST_BYTES { bail!("retirement manifest exceeds its byte bound"); }
    staged.store_blob(&manifest)?;
    staged.write_document(MANIFEST_PATH, &manifest)?;
    drop(staged);
    fullmag_session::publish_directory(&staging, &destination)
        .context("publish immutable retirement archive")?;
    let (_, published) = read_archive_at(archive_root, &proof.operation_id)?
        .context("published retirement manifest is missing")?;
    Ok((proof, published))
}

fn ensure_archive_root(root: &Path) -> Result<()> {
    if !root.is_absolute() { bail!("retirement store root must be absolute"); }
    let root_metadata = fs::symlink_metadata(root)?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        bail!("retirement store root is not a regular directory");
    }
    let path = fullmag_session::repository_path::checked_path(root, ARCHIVE_ROOT)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => bail!("retirement archive root is not a regular directory"),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => { fs::create_dir(&path)?; }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn read_existing_archive(root: &Path, operation_id: &str) -> Result<Option<(LiveRetirementProof, Vec<u8>)>> {
    ensure_archive_root(root)?;
    read_archive_at(root, operation_id)
}

fn read_archive_at(root: &Path, operation_id: &str) -> Result<Option<(LiveRetirementProof, Vec<u8>)>> {
    let destination = fullmag_session::repository_path::checked_path(root, &format!("{ARCHIVE_ROOT}/{operation_id}"))?;
    match fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => bail!("retirement archive is not a regular directory"),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(&destination, MANIFEST_PATH, MAX_MANIFEST_BYTES)?;
    let proof: LiveRetirementProof = serde_json::from_slice(&bytes).context("decode retirement manifest")?;
    validate_proof_shape(&proof, operation_id)?;
    let mut total_bytes = 0usize;
    for (name, pin) in &proof.documents {
        validate_document_name(name)?;
        let document = fullmag_session::repository_path::read_bounded_regular_file(&destination, &format!("project/{name}"), MAX_DOCUMENT_BYTES)?;
        total_bytes = total_bytes
            .checked_add(document.len())
            .context("retirement document byte count overflowed")?;
        if total_bytes > MAX_TOTAL_DOCUMENT_BYTES {
            bail!("retirement documents exceed their aggregate byte bound");
        }
        if document.len() as u64 != pin.byte_length || fullmag_session::hex_sha256(&document) != pin.sha256 || pin.object_ref != pin.sha256 {
            bail!("retirement document `{name}` differs from its immutable pin");
        }
    }
    Ok(Some((proof, bytes)))
}

fn validate_archive_replay(
    proof: &LiveRetirementProof,
    bytes: &[u8],
    request: &LiveRetirementRequest,
    current_scope: &str,
) -> Result<()> {
    validate_proof_shape(proof, &request.operation_id)?;
    if proof.operation_id != request.operation_id
        || proof.session_id != request.session_id
        || proof.run_id != request.run_id
    {
        bail!("retirement archive identity differs from request");
    }
    if request.request_scope_epoch != current_scope {
        bail!("retirement replay request does not belong to the current API scope");
    }
    if proof.request_scope_epoch != current_scope {
        let predecessor = request.predecessor.as_ref().context("cross-restart replay requires an explicit predecessor proof")?;
        if predecessor.proof_sha256 != fullmag_session::hex_sha256(bytes)
            || predecessor.request_scope_epoch != proof.request_scope_epoch
        {
            bail!("predecessor proof does not authenticate the prior API incarnation");
        }
    } else if request.predecessor.is_some() {
        bail!("same-incarnation retirement replay must not carry a predecessor");
    }
    Ok(())
}

fn validate_proof_for_current(
    proof: &LiveRetirementProof,
    archive_bytes: &[u8],
    request: &LiveRetirementRequest,
    current: &SessionStateResponse,
    current_scope: &str,
    accepted_proof_sha256: Option<&str>,
) -> Result<()> {
    validate_proof_shape(proof, &request.operation_id)?;
    if proof.operation_id != request.operation_id
        || proof.session_id != request.session_id
        || proof.run_id != request.run_id
        || proof.session_epoch != request_scope_epoch_number(current_scope)?
        || proof.scene_revision != current.scene_document.as_ref().map(|scene| scene.revision).unwrap_or(0)
        || proof.state_version != current.state_version
        || proof.artifact_catalog_sha256 != artifact_catalog_sha256(current)
        || proof.accepted_proof_sha256.as_deref() != accepted_proof_sha256
        || normalize_terminal_outcome(&proof.terminal_outcome)
            != normalize_terminal_outcome(terminal_snapshot_outcome(current)?)
    {
        bail!("retirement archive does not match the current owner");
    }
    if proof.request_scope_epoch == current_scope {
        if request.predecessor.is_some() {
            bail!("same-incarnation retirement replay must not carry a predecessor");
        }
    } else {
        let predecessor = request
            .predecessor
            .as_ref()
            .context("cross-restart replay requires an explicit predecessor proof")?;
        if predecessor.proof_sha256 != fullmag_session::hex_sha256(archive_bytes)
            || predecessor.request_scope_epoch != proof.request_scope_epoch
        {
            bail!("predecessor proof does not authenticate the prior API incarnation");
        }
    }
    Ok(())
}

fn validate_same_proof_identity(left: &LiveRetirementProof, right: &LiveRetirementProof) -> Result<()> {
    if left.schema != right.schema
        || left.state != right.state
        || left.operation_id != right.operation_id
        || left.session_id != right.session_id
        || left.run_id != right.run_id
        || left.request_scope_epoch != right.request_scope_epoch
        || left.session_epoch != right.session_epoch
        || left.scene_revision != right.scene_revision
        || left.state_version != right.state_version
        || left.accepted_proof_sha256 != right.accepted_proof_sha256
        || normalize_terminal_outcome(&left.terminal_outcome)
            != normalize_terminal_outcome(&right.terminal_outcome)
        || left.terminal_catalog_revision != right.terminal_catalog_revision
        || left.ui_state_scope != right.ui_state_scope
        || left.script_available != right.script_available
        || left.artifact_catalog_sha256 != right.artifact_catalog_sha256
        || left.terminal_evidence_sha256 != right.terminal_evidence_sha256
        || left.host_released_reservations != right.host_released_reservations
    {
        bail!("retirement operation already has a conflicting archive");
    }
    if !left.documents.is_empty() && !right.documents.is_empty() && left.documents != right.documents {
        bail!("retirement operation already has conflicting archived documents");
    }
    Ok(())
}

fn validate_proof_shape(proof: &LiveRetirementProof, operation_id: &str) -> Result<()> {
    if proof.schema != PROOF_SCHEMA || proof.state != "retired" || proof.operation_id != operation_id {
        bail!("retirement manifest schema/state/path is invalid");
    }
    fullmag_session::repository_path::validate_store_id(operation_id)?;
    fullmag_session::repository_path::validate_store_id(&proof.session_id)?;
    fullmag_session::repository_path::validate_store_id(&proof.run_id)?;
    validate_scope(&proof.request_scope_epoch, "proof request scope")?;
    if proof.session_epoch == 0 { bail!("retirement proof session epoch is zero"); }
    if proof.terminal_outcome == UNADMITTED_OUTCOME {
        if proof.terminal_catalog_revision != 0 || !proof.host_released_reservations.is_empty() {
            bail!("unadmitted retirement proof carries run catalog or host evidence");
        }
    } else if proof.terminal_catalog_revision == 0 {
        bail!("retirement proof has no terminal catalog revision");
    }
    if !matches!(
        proof.terminal_outcome.as_str(),
        "completed" | "failed" | "cancelled" | UNADMITTED_OUTCOME
    ) {
        bail!("retirement proof terminal outcome is unsupported");
    }
    for digest in [proof.terminal_evidence_sha256.as_str()] {
        validate_digest(digest, "retirement proof digest")?;
    }
    validate_digest(
        &proof.artifact_catalog_sha256,
        "retirement artifact catalog digest",
    )?;
    if let Some(digest) = proof.accepted_proof_sha256.as_deref() { validate_digest(digest, "accepted proof")?; }
    if proof.ui_state_scope != "backend_typed_workspace" { bail!("retirement proof UI scope is unsupported"); }
    if proof.documents.get("ui_state.json").is_none() { bail!("retirement proof has no typed UI state"); }
    if proof.documents.get("workspace_metadata.json").is_none() {
        bail!("retirement proof has no workspace metadata");
    }
    if proof.script_available != proof.documents.contains_key("main.py") {
        bail!("retirement proof script flag differs from its document set");
    }
    for (name, pin) in &proof.documents {
        validate_document_name(name)?;
        validate_digest(&pin.object_ref, "retirement object ref")?;
        validate_digest(&pin.sha256, "retirement document digest")?;
        if pin.object_ref != pin.sha256 { bail!("retirement object ref is not content addressed"); }
    }
    for reservation in &proof.host_released_reservations {
        validate_digest(&reservation.request_sha256, "host request digest")?;
        validate_digest(&reservation.release_proof_sha256, "host release proof digest")?;
    }
    Ok(())
}

fn response_for_proof(
    proof: &LiveRetirementProof,
    bytes: &[u8],
    state: &str,
    api_request_scope_epoch: &str,
) -> LiveRetirementResponse {
    LiveRetirementResponse {
        schema: RESPONSE_SCHEMA.to_string(),
        state: state.to_string(),
        operation_id: proof.operation_id.clone(),
        session_id: proof.session_id.clone(),
        run_id: proof.run_id.clone(),
        request_scope_epoch: proof.request_scope_epoch.clone(),
        api_request_scope_epoch: api_request_scope_epoch.to_string(),
        session_epoch: proof.session_epoch,
        scene_revision: proof.scene_revision,
        state_version: proof.state_version,
        terminal_outcome: proof.terminal_outcome.clone(),
        archive_manifest_path: format!("{ARCHIVE_ROOT}/{}/{}", proof.operation_id, MANIFEST_PATH),
        archive_sha256: fullmag_session::hex_sha256(bytes),
        terminal_evidence_sha256: proof.terminal_evidence_sha256.clone(),
        ui_state_scope: proof.ui_state_scope.clone(),
        script_available: proof.script_available,
    }
}

fn clear_current_workspace_pointer(
    state: &AppState,
    expected: &CurrentRetirementFence,
) -> Result<()> {
    let mut current = state
        .current_live_state
        .try_write()
        .map_err(|_| anyhow::anyhow!("current live state is busy during retirement"))?;
    let mut reattach = state
        .accepted_run_reattach_identity
        .try_write()
        .map_err(|_| anyhow::anyhow!("accepted-run reattach identity is busy during retirement"))?;
    let observed = current
        .as_ref()
        .context("current workspace disappeared before retirement pointer clear")?;
    if &current_retirement_fence(state, observed) != expected {
        bail!("current workspace identity changed before retirement pointer clear");
    }
    *current = None;
    *reattach = None;
    Ok(())
}

async fn finish_current_workspace_clear(
    state: &AppState,
    realtime: &crate::CurrentLiveRealtimeState,
) -> Result<(), ApiError> {
    crate::reset_current_live_session_resources(state).await;
    crate::publish_current_live_realtime_batch_changed(state, realtime, false, 0).await
}

fn retirement_store_root(state: &AppState) -> Result<PathBuf, ApiError> {
    state.submit_store_root.clone().ok_or_else(|| {
        ApiError::conflict_with_code(
            "live_retirement_terminal_evidence_unknown",
            "the configured accepted run store is unavailable",
        )
    })
}

fn validate_document_name(name: &str) -> Result<()> {
    if !matches!(name, "scene_document.json" | "script_builder.json" | "ui_state.json" | "workspace_metadata.json" | "main.py") {
        bail!("unsupported retirement document name `{name}`");
    }
    Ok(())
}

fn validate_scope(value: &str, field: &str) -> Result<()> {
    if value.is_empty() || value.len() > 512 || value.bytes().any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control()) || !value.contains(':') {
        bail!("{field} is not a bounded API request scope");
    }
    Ok(())
}

fn request_scope_epoch_number(scope: &str) -> Result<u64> {
    scope.rsplit_once(':').context("request scope has no epoch")?.1.parse().context("request scope epoch is not numeric")
}

fn validate_digest(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        bail!("{field} must be a lowercase SHA-256 digest");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retirement_request_is_explicit_and_bounded() {
        let request = LiveRetirementRequest {
            schema: REQUEST_SCHEMA.to_string(),
            operation_id: "0123456789abcdef0123456789abcdef".to_string(),
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            request_scope_epoch: "api-instance:4".to_string(),
            predecessor: None,
        };
        request.validate().unwrap();
    }

    #[tokio::test]
    async fn retirement_uses_accepted_submit_store_when_live_journal_differs() {
        let mut state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let accepted = std::path::PathBuf::from("accepted-store");
        let journal = std::path::PathBuf::from("live-command-journal");
        let state_mut = Arc::get_mut(&mut state).expect("test state has one owner");
        state_mut.submit_store_root = Some(accepted.clone());
        state_mut.current_command_journal_store_root = Some(journal);
        assert_eq!(retirement_store_root(&state).unwrap(), accepted);
    }

    #[test]
    fn empty_ui_document_is_not_a_valid_retirement_manifest() {
        let proof = serde_json::from_value::<LiveRetirementProof>(serde_json::json!({
            "schema": PROOF_SCHEMA, "state": "retired", "operation_id": "op",
            "session_id": "session", "run_id": "run", "request_scope_epoch": "api:1",
            "session_epoch": 1, "scene_revision": 0, "state_version": 1,
            "artifact_catalog_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "accepted_proof_sha256": null, "terminal_outcome": "completed",
            "terminal_catalog_revision": 1, "ui_state_scope": "backend_typed_workspace",
            "script_available": false, "documents": {},
            "terminal_evidence_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
            "host_released_reservations": []
        }));
        assert!(proof.is_ok());
        assert!(validate_proof_shape(&proof.unwrap(), "op").is_err());
    }


    fn digest(byte: u8) -> String {
        fullmag_session::hex_sha256(&[byte])
    }

    fn valid_proof(scope: &str, operation_id: &str) -> LiveRetirementProof {
        let document_digest = fullmag_session::hex_sha256(b"{}");
        let documents = BTreeMap::from([
            (
                "ui_state.json".to_string(),
                DocumentPin {
                    object_ref: document_digest.clone(),
                    sha256: document_digest.clone(),
                    byte_length: 2,
                },
            ),
            (
                "workspace_metadata.json".to_string(),
                DocumentPin {
                    object_ref: document_digest.clone(),
                    sha256: document_digest,
                    byte_length: 2,
                },
            ),
        ]);
        LiveRetirementProof {
            schema: PROOF_SCHEMA.to_string(),
            state: "retired".to_string(),
            operation_id: operation_id.to_string(),
            session_id: "session".to_string(),
            run_id: "run".to_string(),
            request_scope_epoch: scope.to_string(),
            session_epoch: 4,
            scene_revision: 0,
            state_version: 12,
            artifact_catalog_sha256: fullmag_session::canonical_json_sha256(&serde_json::json!([])),
            accepted_proof_sha256: None,
            terminal_outcome: "completed".to_string(),
            terminal_catalog_revision: 1,
            ui_state_scope: "backend_typed_workspace".to_string(),
            script_available: false,
            documents,
            terminal_evidence_sha256: digest(b'h'),
            host_released_reservations: Vec::new(),
        }
    }

    fn request(scope: &str, predecessor: Option<RetirementPredecessor>) -> LiveRetirementRequest {
        LiveRetirementRequest {
            schema: REQUEST_SCHEMA.to_string(),
            operation_id: "op".to_string(),
            session_id: "session".to_string(),
            run_id: "run".to_string(),
            request_scope_epoch: scope.to_string(),
            predecessor,
        }
    }

    #[test]
    fn archive_publication_is_content_addressed_and_detects_document_drift() {
        let directory = tempfile::tempdir().unwrap();
        let documents = BTreeMap::from([
            ("ui_state.json".to_string(), b"{}".to_vec()),
            ("workspace_metadata.json".to_string(), b"{}".to_vec()),
        ]);
        let (published, manifest) =
            publish_archive(directory.path(), valid_proof("api:4", "op"), documents).unwrap();
        assert_eq!(published.documents.len(), 2);
        let reread = read_archive_at(directory.path(), "op")
            .unwrap()
            .expect("published retirement archive");
        assert_eq!(reread.1, manifest);
        std::fs::write(
            directory.path().join("retirements/op/project/ui_state.json"),
            b"tampered",
        )
        .unwrap();
        assert!(read_archive_at(directory.path(), "op").is_err());
    }

    #[test]
    fn cross_incarnation_replay_requires_the_exact_predecessor_manifest() {
        let proof = valid_proof("old-api:4", "op");
        let archive_bytes = b"immutable-manifest";
        let missing = request("new-api:4", None);
        assert!(validate_archive_replay(&proof, archive_bytes, &missing, "new-api:4").is_err());
        let wrong = request(
            "new-api:4",
            Some(RetirementPredecessor {
                proof_sha256: digest(b'w'),
                request_scope_epoch: "old-api:4".to_string(),
            }),
        );
        assert!(validate_archive_replay(&proof, archive_bytes, &wrong, "new-api:4").is_err());
        let exact = request(
            "new-api:4",
            Some(RetirementPredecessor {
                proof_sha256: fullmag_session::hex_sha256(archive_bytes),
                request_scope_epoch: "old-api:4".to_string(),
            }),
        );
        validate_archive_replay(&proof, archive_bytes, &exact, "new-api:4").unwrap();
        let stale = request(
            "stale-api:4",
            Some(RetirementPredecessor {
                proof_sha256: fullmag_session::hex_sha256(archive_bytes),
                request_scope_epoch: "old-api:4".to_string(),
            }),
        );
        assert!(validate_archive_replay(&proof, archive_bytes, &stale, "new-api:4").is_err());
    }

    fn terminal_current_for_test() -> crate::types::SessionStateResponse {
        let request: crate::types::CurrentLiveSnapshotRequest = serde_json::from_value(
            serde_json::json!({"session_id": "session", "session_status": "completed"}),
        )
        .unwrap();
        let mut current = crate::session::default_current_live_state(&request);
        current.session.run_id = "run".to_string();
        current.run = Some(crate::types::RunManifest {
            run_id: "run".to_string(),
            session_id: "session".to_string(),
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
        current.state_version = 12;
        current
    }

    #[test]
    fn response_separates_immutable_archive_scope_from_current_api_scope() {
        let proof = valid_proof("old-api:4", "op");
        let response = response_for_proof(&proof, b"manifest", "replayed", "new-api:9");
        assert_eq!(response.request_scope_epoch, "old-api:4");
        assert_eq!(response.api_request_scope_epoch, "new-api:9");
    }

    #[test]
    fn restart_guard_rejection_maps_to_a_stable_private_retirement_error() {
        let mapped = map_workspace_acquisition_error(ApiError::conflict_with_code(
            "development_restart_not_safe",
            "host path must not escape into the retirement response",
        ));
        assert_eq!(mapped.code.as_deref(), Some("live_retirement_busy"));
        assert_eq!(
            mapped.message,
            "the current workspace is not safely quiescent for retirement"
        );
    }

    #[test]
    fn revision_drift_is_rejected_before_current_pointer_clear() {
        let current = terminal_current_for_test();
        let proof = valid_proof("api:4", "op");
        let request = request("api:4", None);
        validate_proof_for_current(&proof, b"manifest", &request, &current, "api:4", None)
            .unwrap();
        let mut changed = current.clone();
        changed.state_version += 1;
        assert!(validate_proof_for_current(
            &proof,
            b"manifest",
            &request,
            &changed,
            "api:4",
            None,
        )
        .is_err());
    }

    #[test]
    fn artifact_catalog_drift_is_rejected_even_without_state_version_drift() {
        let current = terminal_current_for_test();
        let proof = valid_proof("api:4", "op");
        let request = request("api:4", None);
        let mut changed = current.clone();
        changed.artifacts.push(crate::types::ArtifactEntry {
            path: "fields/m.bin".to_string(),
            kind: "field".to_string(),
            region_owned_provenance: None,
        });
        assert!(validate_proof_for_current(
            &proof,
            b"manifest",
            &request,
            &changed,
            "api:4",
            None,
        )
        .is_err());
    }

    #[test]
    fn terminal_catalog_authority_does_not_require_display_finished_timestamp() {
        let mut current = terminal_current_for_test();
        current.session.finished_at_unix_ms = 0;
        assert_eq!(terminal_snapshot_outcome(&current).unwrap(), "completed");
    }

    #[test]
    fn fresh_terminal_evidence_mismatch_blocks_pointer_clear() {
        let proof = valid_proof("api:4", "op");
        let evidence = TerminalRetirementEvidence {
            terminal_outcome: "completed".to_string(),
            terminal_catalog_revision: 1,
            terminal_evidence_sha256: digest(b'h'),
            host_released_reservations: Vec::new(),
        };
        validate_evidence_for_proof(&proof, &evidence).unwrap();
        let mut changed = evidence.clone();
        changed.terminal_evidence_sha256 = digest(b'c');
        assert!(validate_evidence_for_proof(&proof, &changed).is_err());
    }

    fn lease(state: fullmag_session::FmsResourceLeaseState) -> fullmag_session::FmsResourceLease {
        let now = chrono::Utc::now();
        fullmag_session::FmsResourceLease {
            schema_version: fullmag_session::types::FMS_RESOURCE_LEASE_SCHEMA.to_string(),
            resource_id: "cpu".to_string(),
            kind: fullmag_session::FmsResourceKind::Cpu,
            budget: fullmag_session::FmsResourceBudget {
                cpu_millis: 1,
                memory_bytes: 0,
                gpu_memory_bytes: 0,
                storage_bytes: 0,
            },
            run_id: "run".to_string(),
            task_id: "task".to_string(),
            attempt_id: "attempt".to_string(),
            ownership_epoch: 1,
            lease_token: "lease".to_string(),
            state,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 1,
            released_at: None,
            host_launch_binding: None,
        }
    }

    fn write_solver_lease(store: &fullmag_session::SessionStore, value: &fullmag_session::FmsResourceLease) {
        let path = store.root().join("runs/run/resource_leases/cpu/lease.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    #[test]
    fn canonical_local_release_reader_preserves_active_and_released_history() {
        let directory = tempfile::tempdir().unwrap();
        let store = fullmag_session::SessionStore::open(directory.path()).unwrap();
        let active = lease(fullmag_session::FmsResourceLeaseState::Active);
        write_solver_lease(&store, &active);
        let listed = store
            .read_resource_lease("run", "cpu", "lease")
            .unwrap()
            .expect("durable resource lease");
        assert_eq!(listed.state, fullmag_session::FmsResourceLeaseState::Active);
        let mut released = lease(fullmag_session::FmsResourceLeaseState::Released);
        released.released_at = Some(chrono::Utc::now());
        write_solver_lease(&store, &released);
        let listed = store
            .read_resource_lease("run", "cpu", "lease")
            .unwrap()
            .expect("durable resource lease");
        assert_eq!(listed.state, fullmag_session::FmsResourceLeaseState::Released);
    }

    // Terminal-evidence admission and lease-history cases are covered by the
    // fullmag-session store tests through the locked canonical reader.
    fn host_reservation(
        store_id: &str,
        state: fullmag_session::host_resource_ledger::HostResourceReservationState,
    ) -> fullmag_session::host_resource_ledger::HostResourceReservation {
        fullmag_session::host_resource_ledger::HostResourceReservation {
            identity: fullmag_session::host_resource_ledger::HostReservationIdentity {
                store_id: store_id.to_string(),
                run_id: "run".to_string(),
                task_id: "task".to_string(),
                resource_id: "cpu".to_string(),
                owner: fullmag_session::host_resource_ledger::HostReservationOwner::Solver {
                    attempt_id: "attempt".to_string(),
                    ownership_epoch: 1,
                },
                lease_token: "lease".to_string(),
            },
            request_sha256: digest(b'r'),
            host_id: "host".to_string(),
            policy_revision: 1,
            host_owner_epoch: 1,
            runtime_generation_sha256: None,
            compute_node_owner_id: None,
            compute_node_owner_epoch: None,
            topology_sha256: digest(b't'),
            budget: fullmag_session::FmsResourceBudget {
                cpu_millis: 1,
                memory_bytes: 0,
                gpu_memory_bytes: 0,
                storage_bytes: 0,
            },
            exclusive_gpu_uuids: Default::default(),
            gpu_vram_bytes_by_uuid: Default::default(),
            cpu_ids: Default::default(),
            release_proof_sha256: (state
                == fullmag_session::host_resource_ledger::HostResourceReservationState::Released)
                .then(|| digest(b'p')),
            state,
            worker_launch_gate: None,
            preparation_launch_gate: None,
            preparation_launch_owner: None,
            node_policy_revision: 0,
            scheduling_priority: 0,
            parallelism: Default::default(),
        }
    }

    #[test]
    fn released_host_gate_rejects_active_or_foreign_reservations() {
        let active = host_reservation(
            "store-a",
            fullmag_session::host_resource_ledger::HostResourceReservationState::Committed,
        );
        assert!(collect_released_host_reservations(&[active], "store-a", "run").is_err());
        let released = host_reservation(
            "store-a",
            fullmag_session::host_resource_ledger::HostResourceReservationState::Released,
        );
        assert_eq!(
            collect_released_host_reservations(&[released], "store-a", "run")
                .unwrap()
                .len(),
            1
        );
        let foreign = host_reservation(
            "store-b",
            fullmag_session::host_resource_ledger::HostResourceReservationState::Released,
        );
        assert!(collect_released_host_reservations(&[foreign], "store-a", "run")
            .unwrap()
            .is_empty());
    }
}
