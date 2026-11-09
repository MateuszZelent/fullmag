use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{oneshot, OwnedMutexGuard};

use super::{finish_owned, AcceptedLiveStudyExecution, FinalizedPublication};
use crate::error::ApiError;
use crate::router_v2::tests::test_app_state_with_live_session;
use crate::types::{AppState, RunManifest, SessionStateResponse};

const SYNTHETIC_RUN_ID: &str = "test-only-owned-finalizer-run";

fn accepted_test_identity(run_id: &str) -> AcceptedLiveStudyExecution {
    AcceptedLiveStudyExecution {
        run_id: run_id.to_owned(),
        step_ids: vec!["test-only-step".to_owned()],
        preparation_error: None,
    }
}

fn publish_synthetic_test_run(
    state: &Arc<AppState>,
    run_id: &str,
) -> Result<FinalizedPublication, ApiError> {
    // This synthetic identity tests finalizer ownership only; it is not a durable
    // RunIntent, CAS publication, or scientific execution.
    let mut current = state.current_live_state.blocking_write();
    let snapshot = current
        .as_mut()
        .ok_or_else(|| ApiError::not_found("test live snapshot disappeared"))?;
    let during_stage = snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("write_during_stage"))
        .cloned()
        .unwrap_or(Value::Null);
    snapshot.run = Some(RunManifest {
        run_id: run_id.to_owned(),
        session_id: snapshot.session.session_id.clone(),
        status: "accepted-test-only".to_owned(),
        total_steps: 1,
        final_time: None,
        final_e_ex: None,
        final_e_demag: None,
        final_e_ext: None,
        final_e_ani: None,
        final_e_dmi: None,
        final_e_rotated_dmi: None,
        final_e_total: None,
        artifact_dir: "test-only/no-cas".to_owned(),
    });
    snapshot.metadata = Some(
        json!({
            "write_during_stage": during_stage,
            "synthetic_accepted_run": run_id,
        })
        .into(),
    );
    Ok(FinalizedPublication { result: Ok(accepted_test_identity(run_id)), snapshot: None })
}

async fn owned_transition(state: &Arc<AppState>) -> OwnedMutexGuard<()> {
    Arc::clone(&state.current_live_session_transition)
        .lock_owned()
        .await
}

async fn wait_until_transition_is_free(state: &Arc<AppState>) {
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if let Ok(guard) = Arc::clone(&state.current_live_session_transition).try_lock_owned() {
                drop(guard);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owned finalizer should release the transition after it finishes");
}

async fn write_stage_metadata(state: &Arc<AppState>, value: &str) {
    let mut current =
        tokio::time::timeout(Duration::from_secs(1), state.current_live_state.write())
            .await
            .expect("current-live snapshot write should remain available during CAS staging");
    let snapshot = current
        .as_mut()
        .expect("test live snapshot should remain present");
    snapshot.metadata = Some(json!({ "write_during_stage": value }).into());
}

async fn assert_snapshot_read_is_available(state: &Arc<AppState>) {
    let current = tokio::time::timeout(Duration::from_secs(1), state.current_live_state.read())
        .await
        .expect("current-live snapshot read should remain available during CAS staging");
    assert!(current.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owned_finalizer_keeps_transition_without_holding_snapshot_lock_while_staging() {
    let state = test_app_state_with_live_session().await;
    let guard = owned_transition(&state).await;
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let operation_count = Arc::new(AtomicUsize::new(0));
    let operation_count_in_task = Arc::clone(&operation_count);
    let task_state = Arc::clone(&state);

    let caller = tokio::spawn(async move {
        let mut transition = Some(guard);
        let result = finish_owned(&task_state, &mut transition, move |state| {
            operation_count_in_task.fetch_add(1, Ordering::SeqCst);
            let _ = started_tx.send(());
            release_rx.recv().map_err(|error| {
                ApiError::internal(format!("test release channel closed: {error}"))
            })?;
            publish_synthetic_test_run(state, SYNTHETIC_RUN_ID)
        })
        .await;
        (result, transition)
    });

    tokio::time::timeout(Duration::from_secs(1), started_rx)
        .await
        .expect("blocking finalizer should start")
        .expect("started signal should be sent");
    assert_snapshot_read_is_available(&state).await;
    write_stage_metadata(&state, "written-while-stage-paused").await;
    assert!(state.current_live_session_transition.try_lock().is_err());
    assert_eq!(operation_count.load(Ordering::SeqCst), 1);

    release_tx
        .send(())
        .expect("finalizer should still be waiting");
    let (result, transition) = tokio::time::timeout(Duration::from_secs(1), caller)
        .await
        .expect("owned finalizer caller should finish after release")
        .expect("caller task should not panic");
    let accepted = result.expect("test finalizer should publish its synthetic identity");
    assert_eq!(accepted.run_id, SYNTHETIC_RUN_ID);
    assert_eq!(operation_count.load(Ordering::SeqCst), 1);
    assert!(
        transition.is_some(),
        "finish_owned should return its guard to the caller"
    );
    drop(transition);
    assert!(state.current_live_session_transition.try_lock().is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborting_waiter_does_not_cancel_owned_finalizer_or_release_transition_early() {
    let state = test_app_state_with_live_session().await;
    let guard = owned_transition(&state).await;
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let (published_tx, published_rx) = oneshot::channel();
    let (return_tx, return_rx) = mpsc::channel();
    let operation_count = Arc::new(AtomicUsize::new(0));
    let operation_count_in_task = Arc::clone(&operation_count);
    let task_state = Arc::clone(&state);

    let caller = tokio::spawn(async move {
        let mut transition = Some(guard);
        finish_owned(&task_state, &mut transition, move |state| {
            operation_count_in_task.fetch_add(1, Ordering::SeqCst);
            let _ = started_tx.send(());
            release_rx.recv().map_err(|error| {
                ApiError::internal(format!("test release channel closed: {error}"))
            })?;
            let publication = publish_synthetic_test_run(state, SYNTHETIC_RUN_ID);
            let _ = published_tx.send(());
            return_rx.recv().map_err(|error| {
                ApiError::internal(format!("test finalizer return channel closed: {error}"))
            })?;
            publication
        })
        .await
    });

    tokio::time::timeout(Duration::from_secs(1), started_rx)
        .await
        .expect("blocking finalizer should start")
        .expect("started signal should be sent");
    caller.abort();
    assert!(caller
        .await
        .expect_err("caller task should be aborted")
        .is_cancelled());
    assert!(state.current_live_session_transition.try_lock().is_err());
    assert_snapshot_read_is_available(&state).await;
    write_stage_metadata(&state, "written-after-waiter-abort").await;
    assert_eq!(operation_count.load(Ordering::SeqCst), 1);

    release_tx
        .send(())
        .expect("owned finalizer should survive caller abort");
    tokio::time::timeout(Duration::from_secs(1), published_rx)
        .await
        .expect("owned finalizer should publish after release")
        .expect("finalizer should signal publication");
    assert!(state.current_live_session_transition.try_lock().is_err());
    return_tx
        .send(())
        .expect("finalizer should be waiting to return from its owned operation");
    wait_until_transition_is_free(&state).await;
    assert_eq!(operation_count.load(Ordering::SeqCst), 1);

    let current = state.current_live_state.read().await;
    let snapshot = current
        .as_ref()
        .expect("test live snapshot should remain present");
    assert_eq!(
        snapshot.run.as_ref().map(|run| run.run_id.as_str()),
        Some(SYNTHETIC_RUN_ID)
    );
    let metadata = snapshot
        .metadata
        .as_ref()
        .expect("finalizer metadata should be published");
    assert_eq!(metadata["write_during_stage"], "written-after-waiter-abort");
    assert_eq!(metadata["synthetic_accepted_run"], SYNTHETIC_RUN_ID);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prepublication_error_restores_guard_but_keeps_it_until_caller_drops_it() {
    let state = test_app_state_with_live_session().await;
    let guard = owned_transition(&state).await;
    let mut transition = Some(guard);
    let before = {
        let current = state.current_live_state.read().await;
        serde_json::to_value(current.as_ref().expect("test live snapshot should exist"))
            .expect("snapshot should serialize")
    };

    let result = finish_owned(&state, &mut transition, |_state| {
        Err(ApiError::internal("injected prepublication test failure"))
    })
    .await;

    assert!(result.is_err());
    assert!(
        transition.is_some(),
        "the guard should be restored to the caller"
    );
    assert!(state.current_live_session_transition.try_lock().is_err());
    let after = {
        let current = state.current_live_state.read().await;
        serde_json::to_value(current.as_ref().expect("test live snapshot should remain"))
            .expect("snapshot should serialize")
    };
    assert_eq!(
        after, before,
        "prepublication error must leave the snapshot unchanged"
    );

    drop(transition.take());
    assert!(state.current_live_session_transition.try_lock().is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn snapshot_scene_validation_rejects_foreign_context_and_stale_scene() {
    let state = test_app_state_with_live_session().await;
    let scene = fullmag_authoring::SceneDocument::default();
    {
        let mut current = state.current_live_state.write().await;
        current
            .as_mut()
            .expect("test live snapshot should exist")
            .scene_document = Some(scene.clone());
    }
    let context = crate::capture_current_live_read_context(&state)
        .await
        .unwrap();
    let current = state.current_live_state.read().await;
    let snapshot = current.as_ref().expect("test live snapshot should exist");
    assert!(super::super::validate_live_snapshot_scene(
        snapshot,
        &context,
        context.session_epoch,
        &scene
    )
    .is_ok());

    let mut foreign_context = context.clone();
    foreign_context.session_id = "foreign-session".to_owned();
    assert!(super::super::validate_live_snapshot_scene(
        snapshot,
        &foreign_context,
        context.session_epoch,
        &scene
    )
    .is_err());

    let mut stale_scene = scene;
    stale_scene.revision += 1;
    assert!(super::super::validate_live_snapshot_scene(
        snapshot,
        &context,
        context.session_epoch,
        &stale_scene
    )
    .is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn captured_transport_scope_is_checked_in_a_blocking_finalizer() {
    let state = test_app_state_with_live_session().await;
    let snapshot = state
        .current_live_state
        .read()
        .await
        .as_ref()
        .unwrap()
        .clone();
    let context = crate::capture_current_live_read_context(&state)
        .await
        .unwrap();
    let expected = crate::router_v2::middleware::session_scope::ExpectedSessionScope {
        session_id: snapshot.session.session_id.clone(),
        session_epoch: crate::router_v2::handlers::sessions::current_live_session_epoch(&snapshot),
        request_scope_epoch: context.request_scope_epoch.clone(),
    };
    tokio::task::spawn_blocking(move || {
        assert!(
            crate::router_v2::middleware::session_scope::current_expected_session_scope().is_none()
        );
        crate::ensure_current_live_request_scope_for_expected(
            &snapshot,
            &context.request_scope_epoch,
            &expected,
        )
        .unwrap();
        let mut foreign_session = expected.clone();
        foreign_session.session_id = "foreign-session".into();
        let mut foreign_epoch = expected.clone();
        foreign_epoch.session_epoch = "foreign-epoch".into();
        let mut foreign_api = expected.clone();
        foreign_api.request_scope_epoch = "foreign-api:1".into();
        for stale in [foreign_session, foreign_epoch, foreign_api] {
            assert!(crate::ensure_current_live_request_scope_for_expected(
                &snapshot,
                &context.request_scope_epoch,
                &stale
            )
            .is_err());
        }
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cached_workspace_resources_remain_readable_during_a_mutation_transition() {
    use crate::router_v2::handlers::{model, simulation};
    use axum::extract::State;

    let state = test_app_state_with_live_session().await;
    let scene = fullmag_authoring::SceneDocument::default();
    state
        .current_live_state
        .write()
        .await
        .as_mut()
        .unwrap()
        .scene_document = Some(scene.clone());
    let _transition = owned_transition(&state).await;
    let readiness = tokio::time::timeout(
        Duration::from_secs(1),
        model::get_model_readiness(State(Arc::clone(&state))),
    )
    .await
    .expect("readiness must not wait behind CAS staging")
    .unwrap();
    assert_eq!(readiness.scene_revision, scene.revision);
    let monitors = tokio::time::timeout(
        Duration::from_secs(1),
        model::list_planar_monitors(State(Arc::clone(&state))),
    )
    .await
    .expect("cached planar monitors must not wait behind CAS staging")
    .unwrap();
    assert_eq!(monitors.scene_revision, scene.revision);
    let execution = tokio::time::timeout(
        Duration::from_secs(1),
        simulation::get_stage_execution(State(Arc::clone(&state))),
    )
    .await
    .expect("stage execution must not wait behind CAS staging")
    .unwrap();
    assert_eq!(execution.status(), axum::http::StatusCode::NO_CONTENT);
    let solver = tokio::time::timeout(
        Duration::from_secs(1),
        simulation::get_solver_status(State(Arc::clone(&state))),
    )
    .await
    .expect("solver status must not wait behind CAS staging")
    .unwrap();
    assert_eq!(solver.runtime_state, "awaiting_command");
    let energies = tokio::time::timeout(
        Duration::from_secs(1),
        simulation::get_solver_energies_current(State(Arc::clone(&state))),
    )
    .await
    .expect("current energies must not wait behind CAS staging")
    .unwrap();
    assert_eq!(energies.status(), axum::http::StatusCode::NO_CONTENT);
    let history = tokio::time::timeout(
        Duration::from_secs(1),
        simulation::get_solver_energies_history(
            State(Arc::clone(&state)),
            axum::extract::Query(simulation::EnergyHistoryQuery { limit: None }),
        ),
    )
    .await
    .expect("energy history must not wait behind CAS staging")
    .unwrap();
    assert_eq!(history.total_rows, 0);
    let run = tokio::time::timeout(
        Duration::from_secs(1),
        simulation::get_run_by_id(
            State(Arc::clone(&state)),
            axum::extract::Path("test-run".into()),
        ),
    )
    .await
    .expect("run lookup must not wait behind CAS staging")
    .unwrap_err();
    assert_eq!(run.status, axum::http::StatusCode::NOT_FOUND);
    let command = tokio::time::timeout(
        Duration::from_secs(1),
        simulation::get_command_detail(
            State(Arc::clone(&state)),
            axum::extract::Path("not-present".into()),
        ),
    )
    .await
    .expect("command detail must not wait behind CAS staging")
    .unwrap_err();
    assert_eq!(command.status, axum::http::StatusCode::NOT_FOUND);
    // The combined snapshot/ledger resource keeps its stronger publication fence.
    use std::future::Future;
    use std::task::Poll;
    let mut paired = Box::pin(simulation::get_command_status(State(Arc::clone(&state))));
    assert!(
        std::future::poll_fn(|cx| Poll::Ready(paired.as_mut().poll(cx)))
            .await
            .is_pending()
    );
    drop(paired);
    assert!(state.current_live_session_transition.try_lock().is_err());
}


#[tokio::test]
async fn unconfirmed_visible_intent_publishes_fenced_identity_and_blocks_compute() {
    // SessionStore fault-injection tests prove exact visible bytes and barriers.
    // This seam proves that the typed uncertainty cannot become a live ACK.
    let state = test_app_state_with_live_session().await;
    let context = crate::capture_current_live_read_context(&state).await.unwrap();
    let mut snapshot = state.current_live_state.read().await.as_ref().unwrap().clone();
    snapshot.metadata = Some(json!({"existing_metadata": 17}).into());
    let run_id = fullmag_application::RunId::parse("run-publication-unconfirmed").unwrap();
    let step_ids = vec!["stage-unconfirmed".to_owned()];
    let next = crate::router_v2::handlers::simulation::commands::prepare_accepted_live_study_snapshot(
        &snapshot, &context, context.session_epoch, run_id.as_str(), &step_ids,
        "waiting_for_compute", None,
    ).unwrap();
    let visible_id = run_id.clone();
    let outcome = super::commit_snapshot(
        &mut snapshot, next, run_id.as_str(), &step_ids,
        Box::new(move || Ok(crate::run_intent_persistence::PreparedRunIntentPublication::VisibleUnconfirmed { run_id: visible_id })),
    ).unwrap();
    assert!(matches!(outcome, super::SnapshotCommitOutcome::VisibleUnconfirmed { run_id: actual } if actual == run_id.as_str()));
    assert_eq!(snapshot.run.as_ref().unwrap().run_id, run_id.as_str());
    assert_eq!(snapshot.run.as_ref().unwrap().status, "waiting_for_compute");
    let metadata = snapshot.metadata.as_ref().unwrap();
    assert_eq!(metadata["existing_metadata"], 17);
    assert_eq!(metadata["accepted_publication"]["durability_status"], "unconfirmed");
    assert_eq!(metadata["accepted_publication"]["run_id"], run_id.as_str());
    assert!(metadata.get("accepted_preparation").is_none());
    let error = crate::live_accepted_execution::accepted_preparation_recovery_error(&snapshot).unwrap();
    assert_eq!(error.code.as_deref(), Some("run_intent_durability_unconfirmed"));
    assert!(!error.message.contains("is durable"));
}

#[tokio::test]
async fn hard_commit_failure_keeps_the_previous_live_snapshot() {
    let state = test_app_state_with_live_session().await;
    let context = crate::capture_current_live_read_context(&state).await.unwrap();
    let mut snapshot = state.current_live_state.read().await.as_ref().unwrap().clone();
    let before = serde_json::to_value(&snapshot).unwrap();
    let step_ids = vec!["stage-not-published".to_owned()];
    let next = crate::router_v2::handlers::simulation::commands::prepare_accepted_live_study_snapshot(
        &snapshot, &context, context.session_epoch, "run-not-published", &step_ids,
        "waiting_for_compute", None,
    ).unwrap();
    let error = super::commit_snapshot(
        &mut snapshot, next, "run-not-published", &step_ids,
        Box::new(|| anyhow::bail!("injected prepublication failure")),
    ).err().expect("hard failure must not produce a publication outcome");
    assert_eq!(error.code.as_deref(), Some("accepted_run_commit_failed"));
    assert_eq!(serde_json::to_value(&snapshot).unwrap(), before);
}
