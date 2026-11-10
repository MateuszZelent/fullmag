use std::collections::{HashSet, VecDeque};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::ApiError;
use crate::types::{
    AppState, CommandCompletionState, CommandLifecycleState, SessionStateResponse,
    TrackedCommandRecord,
};

const LIVE_COMMAND_JOURNAL_SCHEMA: &str = "fullmag.live_command_journal.v1";
const MAX_LIVE_COMMAND_RECORDS: usize = 256;
const RESTART_FAILURE: &str = "api_restarted_before_terminal_command_ack";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct LiveCommandJournalIdentity {
    session_id: String,
    run_id: String,
    started_at_unix_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LiveCommandJournalDocument {
    schema_version: String,
    identity: LiveCommandJournalIdentity,
    revision: u64,
    records: Vec<TrackedCommandRecord>,
}

fn identity(snapshot: &SessionStateResponse) -> LiveCommandJournalIdentity {
    LiveCommandJournalIdentity {
        session_id: snapshot.session.session_id.clone(),
        run_id: snapshot.session.run_id.clone(),
        started_at_unix_ms: snapshot.session.started_at_unix_ms,
    }
}

fn validate_document(document: &LiveCommandJournalDocument) -> Result<(), ApiError> {
    if document.schema_version != LIVE_COMMAND_JOURNAL_SCHEMA {
        return Err(ApiError::internal(format!(
            "unsupported live command journal schema `{}`",
            document.schema_version
        )));
    }
    if document.revision == 0 {
        return Err(ApiError::internal(
            "live command journal revision must be greater than zero",
        ));
    }
    if document.records.len() > MAX_LIVE_COMMAND_RECORDS {
        return Err(ApiError::internal(
            "live command journal exceeds its bounded record capacity",
        ));
    }

    let mut previous_sequence = 0;
    let mut command_ids = HashSet::with_capacity(document.records.len());
    for record in &document.records {
        if record.command.seq == 0 || record.command.seq <= previous_sequence {
            return Err(ApiError::internal(
                "live command journal sequences must be positive and strictly increasing",
            ));
        }
        previous_sequence = record.command.seq;
        if let Some(binding) = &record.command.execution_binding {
            use crate::schemas::commands::RuntimeCommandTarget;
            if binding.run_id.trim().is_empty()
                || binding.step_id.as_deref().is_some_and(|id| id.trim().is_empty())
                || !matches!(&record.command.target,
                    Some(RuntimeCommandTarget::Run { run_id: Some(run_id) }) if run_id == &binding.run_id)
            {
                return Err(ApiError::internal("live command journal has an invalid execution binding"));
            }
        }
        if record.command.command_id.trim().is_empty()
            || !command_ids.insert(record.command.command_id.as_str())
        {
            return Err(ApiError::internal(
                "live command journal command ids must be non-empty and unique",
            ));
        }
    }
    Ok(())
}

fn persist_candidate(
    state: &AppState,
    snapshot: &SessionStateResponse,
    records: &VecDeque<TrackedCommandRecord>,
) -> Result<u64, ApiError> {
    let revision = state
        .current_command_journal_revision
        .load(Ordering::Acquire)
        .checked_add(1)
        .ok_or_else(|| ApiError::internal("live command journal revision exhausted"))?;
    let document = LiveCommandJournalDocument {
        schema_version: LIVE_COMMAND_JOURNAL_SCHEMA.to_string(),
        identity: identity(snapshot),
        revision,
        records: records.iter().cloned().collect(),
    };
    validate_document(&document)?;
    if let Some(store_root) = state.current_command_journal_store_root.as_ref() {
        let bytes = serde_json::to_vec_pretty(&document).map_err(|error| {
            ApiError::internal(format!("serializing live command journal: {error}"))
        })?;
        let store = fullmag_session::SessionStore::open(store_root).map_err(|error| {
            ApiError::internal(format!("opening live command journal store: {error}"))
        })?;
        store
            .commit_live_command_journal(&document.identity.session_id, &bytes)
            .map_err(|error| {
                ApiError::internal(format!("publishing live command journal: {error}"))
            })?;
    }
    state
        .current_command_journal_revision
        .store(revision, Ordering::Release);
    Ok(revision)
}

/// Apply one command-ledger transition and publish the complete bounded
/// snapshot before making it visible in memory. Callers use the returned
/// boolean to skip publication when reconciliation made no change.
pub(crate) async fn mutate<R>(
    state: &AppState,
    snapshot: &SessionStateResponse,
    update: impl FnOnce(&mut VecDeque<TrackedCommandRecord>) -> Result<(R, bool), ApiError>,
) -> Result<R, ApiError> {
    let mut current = state.current_command_ledger.lock().await;
    let mut candidate = current.clone();
    let (result, changed) = update(&mut candidate)?;
    if changed {
        persist_candidate(state, snapshot, &candidate)?;
        *current = candidate;
    }
    Ok(result)
}

/// Rebuild the journal projection for an already accepted Compute. The
/// caller holds the session transition and has validated the immutable owner.
pub(crate) async fn recover_accepted_compute(
    state: &AppState,
    snapshot: &SessionStateResponse,
    accepted: TrackedCommandRecord,
) -> Result<(), ApiError> {
    let mut sequence = state.current_control_next_seq.lock().await;
    let assigned = mutate(state, snapshot, |records| {
        merge_recovered_compute(records, &snapshot.session.run_id, accepted, *sequence)
    }).await?;
    if let Some(seq) = assigned {
        *sequence = seq;
    }
    Ok(())
}

/// Restore a verified terminal Compute into the process-local read model.
/// The terminal observation authority does not write the durable API journal.
pub(crate) async fn project_terminal_compute(
    state: &AppState,
    snapshot: &SessionStateResponse,
    mut accepted: TrackedCommandRecord,
    outcome: &str,
) -> Result<(), ApiError> {
    (accepted.status, accepted.completion_status) = match outcome {
        "completed" => (CommandLifecycleState::Completed, Some(CommandCompletionState::Completed)),
        "failed" => (CommandLifecycleState::Failed, Some(CommandCompletionState::Failed)),
        _ => return Err(ApiError::conflict("unsupported terminal Compute outcome")),
    };
    let mut sequence = state.current_control_next_seq.lock().await;
    let mut ledger = state.current_command_ledger.lock().await;
    let mut candidate = ledger.clone();
    let (assigned, changed) =
        merge_recovered_compute(&mut candidate, &snapshot.session.run_id, accepted, *sequence)?;
    if changed {
        let revision = state.current_command_journal_revision.load(Ordering::Acquire)
            .checked_add(1).ok_or_else(|| ApiError::internal("live command journal revision exhausted"))?;
        *ledger = candidate;
        state.current_command_journal_revision.store(revision, Ordering::Release);
    }
    if let Some(seq) = assigned {
        *sequence = seq;
    }
    Ok(())
}

fn merge_recovered_compute(
    records: &mut VecDeque<TrackedCommandRecord>,
    run_id: &str,
    mut accepted: TrackedCommandRecord,
    sequence: u64,
) -> Result<(Option<u64>, bool), ApiError> {
    use crate::schemas::commands::RuntimeCommandTarget;
    if !matches!(&accepted.command.target,
        Some(RuntimeCommandTarget::Run { run_id: Some(target_run) }) if target_run.as_str() == run_id)
    {
        return Err(ApiError::conflict("recovered Compute belongs to a different current run"));
    }
    if let Some(existing) = records.iter_mut().find(|record| {
        record.command.command_id == accepted.command.command_id
    }) {
        if existing.command.kind != accepted.command.kind
            || existing.command.client_intent_id != accepted.command.client_intent_id
            || !matches!(&existing.command.target,
                Some(RuntimeCommandTarget::Run { run_id: Some(existing_run) }) if existing_run.as_str() == run_id)
        {
            return Err(ApiError::conflict("recovered Compute differs from its existing journal entry"));
        }
        let mut changed = false;
        if let Some(binding) = accepted.command.execution_binding.as_ref() {
            if let Some(previous) = existing.command.execution_binding.as_ref() {
                if previous != binding {
                    return Err(ApiError::conflict("recovered Compute differs from its journal execution binding"));
                }
            } else {
                existing.command.execution_binding = Some(binding.clone());
                changed = true;
            }
        }
        let unresolved = matches!(existing.status, CommandLifecycleState::Accepted
            | CommandLifecycleState::Queued | CommandLifecycleState::Dispatched | CommandLifecycleState::Running);
        if existing.error.as_deref() == Some(RESTART_FAILURE)
            || (accepted.completion_status.is_some() && unresolved)
        {
            existing.status = accepted.status;
            existing.completed_at_unix_ms = accepted.completed_at_unix_ms;
            existing.completion_status = accepted.completion_status;
            existing.error = accepted.error;
            return Ok((None, true));
        }
        return Ok((None, changed));
    }

    let last = records.back().map(|record| record.command.seq).unwrap_or(0);
    let seq = sequence.max(last).checked_add(1)
        .ok_or_else(|| ApiError::internal("current command sequence exhausted"))?;
    crate::router_v2::handlers::simulation::commands::reserve_command_ledger_entry(records)?;
    accepted.command.seq = seq;
    records.push_back(accepted);
    Ok((Some(seq), true))
}

async fn clear_recovered_projection(state: &AppState) {
    state.current_command_ledger.lock().await.clear();
    *state.current_control_next_seq.lock().await = 0;
    state
        .current_command_journal_revision
        .store(0, Ordering::Release);
}

/// Recover the exact journal for the first accepted frame of a live session.
/// The caller must first reconcile these records with that frame and then call
/// `fail_unacknowledged_after_restart` for any outcome that remains unknown.
pub(crate) async fn recover(
    state: &AppState,
    snapshot: &SessionStateResponse,
) -> Result<(), ApiError> {
    let Some(store_root) = state.current_command_journal_store_root.as_ref() else {
        clear_recovered_projection(state).await;
        return Ok(());
    };
    let expected_identity = identity(snapshot);
    fullmag_session::repository_path::validate_store_id(&expected_identity.session_id)
        .map_err(|error| ApiError::internal(format!("invalid live command journal identity: {error}")))?;
    // An authoring-only store can exist without a CAS or a command journal.
    let journal_root = store_root.join("live_command_journals").join(&expected_identity.session_id);
    match std::fs::symlink_metadata(journal_root) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            clear_recovered_projection(state).await;
            return Ok(());
        }
        Err(error) => return Err(ApiError::internal(format!("inspecting live command journal store: {error}"))),
    }
    let store = fullmag_session::SessionStore::open_existing(store_root).map_err(|error| {
        ApiError::internal(format!("opening live command journal store: {error}"))
    })?;
    let Some(bytes) = store
        .read_live_command_journal(&expected_identity.session_id)
        .map_err(|error| ApiError::internal(format!("reading live command journal: {error}")))?
    else {
        clear_recovered_projection(state).await;
        return Ok(());
    };
    let document: LiveCommandJournalDocument = serde_json::from_slice(&bytes)
        .map_err(|error| ApiError::internal(format!("parsing live command journal: {error}")))?;
    validate_document(&document)?;
    // This journal follows the logical session. Its last writer may have
    // been fenced to the previous active run during an accepted transition.
    if document.identity.session_id != expected_identity.session_id
        || document.identity.started_at_unix_ms != expected_identity.started_at_unix_ms
    {
        clear_recovered_projection(state).await;
        return Ok(());
    }

    state
        .current_command_journal_revision
        .store(document.revision, Ordering::Release);
    let recovered = VecDeque::from(document.records);
    let next_sequence = recovered
        .back()
        .map(|record| record.command.seq)
        .unwrap_or(0);
    *state.current_command_ledger.lock().await = recovered;
    *state.current_control_next_seq.lock().await = next_sequence;
    Ok(())
}

/// Fail only the records that remain active after the first post-restart frame
/// has been reconciled. They are retained for Operations/Problems but are not
/// re-enqueued because their external effect may already have happened.
pub(crate) async fn fail_unacknowledged_after_restart(
    state: &AppState,
    snapshot: &SessionStateResponse,
) -> Result<usize, ApiError> {
    let completed_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    mutate(state, snapshot, |records| {
        let mut interrupted = 0;
        for record in records {
            if matches!(
                record.status,
                CommandLifecycleState::Queued
                    | CommandLifecycleState::Accepted
                    | CommandLifecycleState::Dispatched
                    | CommandLifecycleState::Running
            ) {
                record.status = CommandLifecycleState::Failed;
                record.completed_at_unix_ms = Some(completed_at_unix_ms);
                record.completion_status = Some(CommandCompletionState::Failed);
                record.error = Some(RESTART_FAILURE.to_string());
                interrupted += 1;
            }
        }
        Ok((interrupted, interrupted > 0))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::router_v2::tests::test_app_state_with_live_session;
    use crate::types::SessionCommand;

    fn command(sequence: u64, command_id: &str) -> SessionCommand {
        serde_json::from_value(serde_json::json!({
            "seq": sequence,
            "command_id": command_id,
            "kind": "compute_fields",
            "created_at_unix_ms": 1_700_000_000_000_u128
        }))
        .expect("minimal command fixture should deserialize")
    }

    #[tokio::test]
    async fn durable_compute_restores_one_record_and_repairs_only_restart_failure() {
        let state = test_app_state_with_live_session().await;
        let snapshot = state.current_live_state.read().await.as_ref().unwrap().clone();
        let mut submitted = command(0, "compute-receipt");
        submitted.kind = "solve".into();
        submitted.client_intent_id = Some("compute-intent".into());
        submitted.target = Some(crate::schemas::commands::RuntimeCommandTarget::Run {
            run_id: Some(snapshot.session.run_id.clone()),
        });
        let receipt = TrackedCommandRecord {
            command: submitted,
            request_id: Some("trace-first".into()),
            status: CommandLifecycleState::Accepted,
            dispatched_at_unix_ms: None,
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        };
        recover_accepted_compute(&state, &snapshot, receipt.clone()).await.unwrap();
        recover_accepted_compute(&state, &snapshot, receipt.clone()).await.unwrap();
        {
            let ledger = state.current_command_ledger.lock().await;
            assert_eq!(ledger.len(), 1);
            assert_eq!(ledger[0].command.seq, 1);
            assert_eq!(ledger[0].command.client_intent_id.as_deref(), Some("compute-intent"));
        }
        fail_unacknowledged_after_restart(&state, &snapshot).await.unwrap();
        recover_accepted_compute(&state, &snapshot, receipt.clone()).await.unwrap();
        {
            let mut ledger = state.current_command_ledger.lock().await;
            assert_eq!(ledger[0].status, CommandLifecycleState::Accepted);
            assert!(ledger[0].error.is_none());
            ledger[0].status = CommandLifecycleState::Failed;
            ledger[0].error = Some("worker failure".into());
        }
        recover_accepted_compute(&state, &snapshot, receipt).await.unwrap();
        let ledger = state.current_command_ledger.lock().await;
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger[0].error.as_deref(), Some("worker failure"));
    }

    #[tokio::test]
    async fn terminal_observation_projects_missing_compute_without_writing_a_journal() {
        let root = std::env::temp_dir().join(format!(
            "fullmag-terminal-command-observation-{}", uuid::Uuid::new_v4().simple(),
        ));
        let mut state = test_app_state_with_live_session().await;
        Arc::get_mut(&mut state).unwrap().current_command_journal_store_root = Some(root.clone());
        let snapshot = state.current_live_state.read().await.as_ref().unwrap().clone();
        recover(&state, &snapshot).await.unwrap();

        let mut submitted = command(0, "observed-compute");
        submitted.kind = "relax".into();
        submitted.client_intent_id = Some("observed-intent".into());
        submitted.target = Some(crate::schemas::commands::RuntimeCommandTarget::Run {
            run_id: Some(snapshot.session.run_id.clone()),
        });
        let receipt = TrackedCommandRecord {
            command: submitted,
            request_id: Some("original-http-request".into()),
            status: CommandLifecycleState::Accepted,
            dispatched_at_unix_ms: None,
            completed_at_unix_ms: None,
            completion_status: None,
            error: None,
        };
        project_terminal_compute(&state, &snapshot, receipt.clone(), "completed").await.unwrap();
        project_terminal_compute(&state, &snapshot, receipt, "completed").await.unwrap();

        let ledger = state.current_command_ledger.lock().await;
        assert_eq!(ledger.len(), 1);
        assert_eq!(ledger[0].command.seq, 1);
        assert_eq!(ledger[0].command.client_intent_id.as_deref(), Some("observed-intent"));
        assert_eq!(ledger[0].status, CommandLifecycleState::Completed);
        assert_eq!(ledger[0].completion_status, Some(CommandCompletionState::Completed));
        assert!(!root.exists());
    }

    #[tokio::test]
    async fn recovery_preserves_terminal_history_and_fails_unknown_active_outcomes() {
        let store_root = std::env::temp_dir().join(format!(
            "fullmag-live-command-journal-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let mut original = test_app_state_with_live_session().await;
        Arc::get_mut(&mut original)
            .expect("fixture should be uniquely owned")
            .current_command_journal_store_root = Some(store_root.clone());
        let snapshot = original
            .current_live_state
            .read()
            .await
            .as_ref()
            .cloned()
            .expect("fixture should have a live snapshot");
        mutate(&original, &snapshot, |records| {
            records.push_back(TrackedCommandRecord {
                command: command(1, "command-active"),
                request_id: Some("request-active".into()),
                status: CommandLifecycleState::Dispatched,
                dispatched_at_unix_ms: Some(1_700_000_000_100),
                completed_at_unix_ms: None,
                completion_status: None,
                error: None,
            });
            let mut terminal = command(2, "command-terminal");
            terminal.kind = "relax".into();
            terminal.target = Some(crate::schemas::commands::RuntimeCommandTarget::Run {
                run_id: Some(snapshot.session.run_id.clone()),
            });
            terminal.execution_binding = Some(crate::schemas::commands::CommandExecutionBinding {
                requested_target: Some(crate::schemas::commands::RuntimeCommandTarget::StageId {
                    stage_id: "relax-b".into(),
                }),
                run_id: snapshot.session.run_id.clone(),
                step_id: Some("relax-b".into()),
            });
            records.push_back(TrackedCommandRecord {
                command: terminal,
                request_id: Some("request-terminal".into()),
                status: CommandLifecycleState::Completed,
                dispatched_at_unix_ms: Some(1_700_000_000_200),
                completed_at_unix_ms: Some(1_700_000_000_300),
                completion_status: Some(CommandCompletionState::Succeeded),
                error: None,
            });
            Ok(((), true))
        })
        .await
        .expect("initial journal publication should succeed");

        let mut restarted = test_app_state_with_live_session().await;
        Arc::get_mut(&mut restarted)
            .expect("fixture should be uniquely owned")
            .current_command_journal_store_root = Some(store_root.clone());
        let mut restarted_snapshot = snapshot.clone();
        restarted_snapshot.session.run_id = "next-active-run".into();
        recover(&restarted, &restarted_snapshot)
            .await
            .expect("journal recovery should succeed");
        assert_eq!(
            fail_unacknowledged_after_restart(&restarted, &restarted_snapshot)
                .await
                .expect("unknown active outcomes should be finalized"),
            1
        );

        let records = restarted.current_command_ledger.lock().await;
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].status, CommandLifecycleState::Failed);
        assert_eq!(records[0].error.as_deref(), Some(RESTART_FAILURE));
        assert_eq!(
            records[0].completion_status,
            Some(CommandCompletionState::Failed)
        );
        assert_eq!(records[1].status, CommandLifecycleState::Completed);
        let binding = records[1].command.execution_binding.as_ref().unwrap();
        assert_eq!(binding.run_id, snapshot.session.run_id);
        assert_eq!(binding.step_id.as_deref(), Some("relax-b"));
        assert_eq!(
            records[1].completion_status,
            Some(CommandCompletionState::Succeeded)
        );
        drop(records);
        assert_eq!(*restarted.current_control_next_seq.lock().await, 2);
        assert_eq!(
            restarted
                .current_command_journal_revision
                .load(Ordering::Acquire),
            2
        );

        let mut different_session = restarted_snapshot;
        different_session.session.started_at_unix_ms += 1;
        recover(&restarted, &different_session).await.unwrap();
        assert!(restarted.current_command_ledger.lock().await.is_empty());

        let _ = std::fs::remove_dir_all(store_root);
    }
}
