//! Keep immutable CAS staging outside the live snapshot write lock. The owned
//! transition stays with the finalizer even if its HTTP waiter disappears.

use std::sync::Arc;

use super::{AcceptedLiveStudyExecution, PreparedLiveAcceptedStudy};
use crate::error::ApiError;
use crate::types::{AppState, CurrentLiveRequestContext, SessionStateResponse};

type TransitionSlot = Option<tokio::sync::OwnedMutexGuard<()>>;

struct FinalizedPublication {
    result: Result<AcceptedLiveStudyExecution, ApiError>,
    snapshot: Option<SessionStateResponse>,
}

enum SnapshotCommitOutcome {
    Confirmed(AcceptedLiveStudyExecution),
    VisibleUnconfirmed { run_id: String },
}

fn commit_snapshot(
    snapshot: &mut SessionStateResponse,
    mut next: SessionStateResponse,
    run_id: &str,
    step_ids: &[String],
    commit: crate::run_intent_persistence::PreparedRunIntentFinalCommit<'_>,
) -> Result<SnapshotCommitOutcome, ApiError> {
    use crate::run_intent_persistence::PreparedRunIntentPublication;
    let outcome = match commit().map_err(super::accepted_run_commit_error)? {
        PreparedRunIntentPublication::Confirmed(_) => {
            SnapshotCommitOutcome::Confirmed(AcceptedLiveStudyExecution {
                run_id: run_id.to_owned(),
                step_ids: step_ids.to_vec(),
                preparation_error: None,
            })
        }
        PreparedRunIntentPublication::VisibleUnconfirmed { run_id } => {
            next.metadata = Some(super::unconfirmed_run_intent_metadata(
                &next, run_id.as_str(), step_ids,
            ).into());
            SnapshotCommitOutcome::VisibleUnconfirmed { run_id: run_id.as_str().to_owned() }
        }
    };
    // Both outcomes have exact visible bytes under the writer lease. Neither
    // may leave that identity hidden behind the predecessor's live snapshot.
    // All fallible validation happened before commit; uncertainty stays held.
    *snapshot = next;
    Ok(outcome)
}

pub(super) enum SnapshotPublication {
    Study,
    Compute {
        domain: Option<String>,
        prepared_state: Option<crate::live_stage_initial_state::PreparedStateCapture>,
    },
}

pub(super) async fn commit_prepared(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    prepared: PreparedLiveAcceptedStudy,
    publication: SnapshotPublication,
    transition: &mut TransitionSlot,
) -> Result<AcceptedLiveStudyExecution, ApiError> {
    let context = context.clone();
    let expected_scope =
        crate::router_v2::middleware::session_scope::current_expected_session_scope();
    finish_owned(state, transition, move |state| {
        stage_and_publish(state, &context, &prepared, publication, expected_scope)
    })
    .await
}

async fn finish_owned<F>(
    state: &Arc<AppState>,
    transition: &mut TransitionSlot,
    operation: F,
) -> Result<AcceptedLiveStudyExecution, ApiError>
where
    F: FnOnce(
            &Arc<AppState>,
        )
            -> Result<FinalizedPublication, ApiError>
        + Send
        + 'static,
{
    let guard = transition
        .take()
        .ok_or_else(|| ApiError::internal("live publication has no transition owner"))?;
    let state = Arc::clone(state);
    let (result, guard) = tokio::spawn(async move {
        let blocking_state = Arc::clone(&state);
        let (result, guard) =
            tokio::task::spawn_blocking(move || (operation(&blocking_state), guard))
                .await
                .map_err(|error| {
                    ApiError::internal(format!(
                        "live acceptance blocking finalizer failed: {error}"
                    ))
                })?;
        let result = match result {
            Ok(publication) => {
                let FinalizedPublication { result, snapshot } = publication;
                if let Some(snapshot) = snapshot {
                    let display_revision = state.current_display_selection.read().await.revision;
                    let realtime = crate::current_live_realtime_state_from_snapshot(
                        &state,
                        &snapshot,
                        display_revision,
                    )
                    .await;
                    if let Err(error) = crate::publish_current_live_realtime_batch_changed(
                        &state, &realtime, false, 0,
                    )
                    .await
                    {
                        tracing::warn!(error = %error,
                            "accepted run remains committed after realtime publication failure");
                    }
                }
                result
            }
            Err(error) => Err(error),
        };
        Ok::<_, ApiError>((result, guard))
    })
    .await
    .map_err(|error| {
        ApiError::internal(format!("owned live acceptance finalizer failed: {error}"))
    })??;
    *transition = Some(guard);
    result
}

fn stage_and_publish(
    state: &Arc<AppState>,
    context: &CurrentLiveRequestContext,
    prepared: &PreparedLiveAcceptedStudy,
    publication: SnapshotPublication,
    expected_scope: Option<crate::router_v2::middleware::session_scope::ExpectedSessionScope>,
) -> Result<FinalizedPublication, ApiError> {
    if !crate::run_intent_persistence::prepared_run_intent_is_manual(&prepared.validated_commit)
        .map_err(super::accepted_run_commit_error)?
    {
        return Err(ApiError::unprocessable_with_code(
            "live_publication_requires_manual_gate",
            "staged live publication requires an immutable manual start gate",
        ));
    }
    let store = super::open_prepared_live_store(prepared)?;
    let publication = crate::run_intent_persistence::with_staged_prepared_run_intent(
        &store, &prepared.validated_commit, prepared.backlog_limit, |commit| {
            // Return API conflicts as the callback value; store errors retain
            // their separate, typed acceptance boundary.
            Ok((|| {
                let mut current = state.current_live_state.blocking_write();
                let snapshot = current.as_mut().ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
                let epoch = state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire);
                if let Some(expected_scope) = expected_scope.as_ref() {
                    crate::ensure_current_live_request_scope_for_expected(
                        snapshot, &context.request_scope_epoch, expected_scope,
                    )?;
                }
                super::validate_live_snapshot_scene(snapshot, context, epoch, &prepared.scene)?;
                let next = match publication {
                    SnapshotPublication::Study => {
                        crate::router_v2::handlers::simulation::commands::prepare_accepted_live_study_snapshot(
                            snapshot, context, epoch, &prepared.run_id, &prepared.step_ids,
                            "waiting_for_compute", None,
                        )?
                    }
                    SnapshotPublication::Compute { domain, prepared_state } => {
                        crate::router_v2::handlers::simulation::commands::validate_command_domain_precondition(
                            snapshot, domain.as_deref(),
                        )?;
                        if let Some(fence) = prepared_state { fence.validate(snapshot)?; }
                        crate::router_v2::handlers::simulation::commands::prepare_accepted_live_compute_snapshot(
                            snapshot, context, epoch, &prepared.run_id, &prepared.step_ids,
                        )?
                    }
                };
                commit_snapshot(snapshot, next, &prepared.run_id, &prepared.step_ids, commit)
            })())
        },
    ).map_err(super::accepted_run_commit_error)??;
    let mut accepted = match publication {
        SnapshotCommitOutcome::Confirmed(accepted) => accepted,
        SnapshotCommitOutcome::VisibleUnconfirmed { run_id } => {
            // Catalogs and start release require confirmed durability. Publish
            // the recovery state through the same owned realtime finalizer.
            let current = state.current_live_state.blocking_read();
            let rebound = CurrentLiveRequestContext { run_id: Some(run_id.clone()), ..context.clone() };
            let epoch = state.current_live_session_epoch.load(std::sync::atomic::Ordering::Acquire);
            let snapshot = current.as_ref().filter(|snapshot| {
                crate::ensure_current_live_request_context(snapshot, &rebound, epoch).is_ok()
            }).cloned();
            return Ok(FinalizedPublication {
                result: Err(super::unconfirmed_run_intent_error(&run_id)), snapshot,
            });
        }
    };
    // Derived catalogs can be slow or fail. The run is already visible, and
    // the transition owner prevents another mutation from overtaking it.
    accepted.preparation_error = super::materialize_prepared_live_catalog(&store, prepared);
    let mut current = state.current_live_state.blocking_write();
    let rebound = CurrentLiveRequestContext {
        run_id: Some(accepted.run_id.clone()),
        ..context.clone()
    };
    let epoch = state
        .current_live_session_epoch
        .load(std::sync::atomic::Ordering::Acquire);
    let Some(snapshot) = current.as_mut().filter(|snapshot| {
        crate::ensure_current_live_request_context(snapshot, &rebound, epoch).is_ok()
    }) else {
        tracing::error!(run_id = %accepted.run_id, "accepted live publication lost its fenced owner; preserving durable identity");
        return Ok(FinalizedPublication { result: Ok(accepted), snapshot: None });
    };
    if let Some(error) = accepted.preparation_error.as_ref() {
        snapshot.metadata = Some(
            super::accepted_preparation_failure_metadata(
                snapshot,
                &accepted.run_id,
                &accepted.step_ids,
                error,
            )
            .into(),
        );
    }
    Ok(FinalizedPublication { result: Ok(accepted), snapshot: Some(snapshot.clone()) })
}

#[cfg(test)]
#[path = "publication_tests.rs"]
mod tests;
