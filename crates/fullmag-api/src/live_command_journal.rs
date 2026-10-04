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
    let store = fullmag_session::SessionStore::open(store_root).map_err(|error| {
        ApiError::internal(format!("opening live command journal store: {error}"))
    })?;
    let expected_identity = identity(snapshot);
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
    if document.identity != expected_identity {
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
            records.push_back(TrackedCommandRecord {
                command: command(2, "command-terminal"),
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
        let restarted_snapshot = restarted
            .current_live_state
            .read()
            .await
            .as_ref()
            .cloned()
            .expect("fixture should have a live snapshot");
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

        let _ = std::fs::remove_dir_all(store_root);
    }
}
