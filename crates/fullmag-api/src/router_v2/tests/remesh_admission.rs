use super::*;

async fn set_runtime_state(state: &Arc<AppState>, status: &str) {
    let mut current = state.current_live_state.write().await;
    let snapshot = current.as_mut().expect("live session");
    snapshot.session.status = status.into();
    snapshot.live_state = None;
    snapshot.stage_execution = None;
    crate::session::refresh_runtime_status(snapshot);
}

async fn submit(app: &axum::Router, kind: &str, key: Option<&str>) -> axum::response::Response {
    let mut request = Request::builder()
        .method("POST")
        .uri("/v2/sessions/current/simulation/commands")
        .header("content-type", "application/json");
    if let Some(key) = key {
        request = request.header("idempotency-key", key);
    }
    app.clone()
        .oneshot(
            request
                .body(Body::from(serde_json::json!({ "kind": kind }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn readiness(app: &axum::Router, kind: &str) -> serde_json::Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/simulation/commands")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    body_json(response).await["runtime_controls"]
        .as_array()
        .expect("readiness rows")
        .iter()
        .find(|row| row["kind"] == kind)
        .expect("command readiness")
        .clone()
}

fn tracked_command(kind: &str, status: CommandLifecycleState) -> TrackedCommandRecord {
    TrackedCommandRecord {
        command: serde_json::from_value(serde_json::json!({
            "seq": 1,
            "command_id": "existing-command",
            "kind": kind,
            "created_at_unix_ms": 1
        }))
        .expect("command fixture"),
        request_id: None,
        status,
        dispatched_at_unix_ms: None,
        completed_at_unix_ms: None,
        completion_status: None,
        error: None,
    }
}

#[tokio::test]
async fn remesh_readiness_and_admission_share_the_runtime_state_matrix_without_preconditions() {
    for status in [
        "bootstrapping",
        "materializing",
        "materializing_script",
        "waiting_for_compute",
        "awaiting_command",
        "running",
        "paused",
        "breaking",
        "closing",
        "closed",
        "completed",
        "failed",
        "cancelled",
        "unknown",
    ] {
        let state = test_app_state_with_live_session().await;
        set_runtime_state(&state, status).await;
        let app = build_v2_router().with_state(state.clone());
        let enabled = matches!(status, "awaiting_command" | "waiting_for_compute");
        let control = readiness(&app, "mesh_build").await;
        assert_eq!(control["enabled"], enabled, "readiness for {status}");
        let response = submit(&app, "mesh_build", None).await;
        assert_eq!(
            response.status(),
            if enabled {
                StatusCode::OK
            } else {
                StatusCode::CONFLICT
            },
            "admission for {status}"
        );
        assert_eq!(
            state.current_control_queue.lock().await.len(),
            usize::from(enabled)
        );
        if !enabled {
            assert!(control["reason"]
                .as_str()
                .is_some_and(|reason| !reason.is_empty()));
        }
    }
}

#[tokio::test]
async fn remesh_rejects_each_active_mesh_or_compute_lifecycle_state() {
    for kind in [
        "remesh",
        "fdm_grid_refresh",
        "run",
        "relax",
        "solve",
        "compute_fields",
        "compute_energies",
        "apply_frozen_spins",
    ] {
        for lifecycle in [
            CommandLifecycleState::Queued,
            CommandLifecycleState::Accepted,
            CommandLifecycleState::Dispatched,
            CommandLifecycleState::Running,
        ] {
            let state = test_app_state_with_live_session().await;
            set_runtime_state(&state, "awaiting_command").await;
            state
                .current_command_ledger
                .lock()
                .await
                .push_back(tracked_command(kind, lifecycle));
            let app = build_v2_router().with_state(state.clone());
            let control = readiness(&app, "mesh_build").await;
            assert_eq!(control["enabled"], false, "{kind} {lifecycle:?}");
            let response = submit(&app, "mesh_build", None).await;
            assert_eq!(
                response.status(),
                StatusCode::CONFLICT,
                "{kind} {lifecycle:?}"
            );
            assert!(state.current_control_queue.lock().await.is_empty());
            assert_eq!(state.current_command_ledger.lock().await.len(), 1);
        }
    }
}

#[tokio::test]
async fn remesh_accepts_after_mesh_or_compute_terminal_outcomes() {
    for kind in ["remesh", "solve"] {
        for lifecycle in [
            CommandLifecycleState::Completed,
            CommandLifecycleState::Failed,
            CommandLifecycleState::Rejected,
        ] {
            let state = test_app_state_with_live_session().await;
            set_runtime_state(&state, "waiting_for_compute").await;
            state
                .current_command_ledger
                .lock()
                .await
                .push_back(tracked_command(kind, lifecycle));
            let app = build_v2_router().with_state(state.clone());
            assert_eq!(readiness(&app, "mesh_build").await["enabled"], true);
            assert_eq!(
                submit(&app, "mesh_build", None).await.status(),
                StatusCode::OK
            );
        }
    }
}

#[tokio::test]
async fn remesh_rejection_preserves_paused_stage_and_resume() {
    let state = test_app_state_with_live_session().await;
    set_running_stage_execution(&state, 7).await;
    let before = {
        let mut current = state.current_live_state.write().await;
        let snapshot = current.as_mut().unwrap();
        snapshot.stage_execution.as_mut().unwrap().runtime_state = RuntimeLifecycleState::Paused;
        crate::session::refresh_runtime_status(snapshot);
        serde_json::to_value(snapshot).unwrap()
    };
    let app = build_v2_router().with_state(state.clone());
    let control = readiness(&app, "mesh_build").await;
    assert!(control["reason"]
        .as_str()
        .unwrap()
        .contains("Stop the paused stage"));
    assert_eq!(
        submit(&app, "mesh_build", None).await.status(),
        StatusCode::CONFLICT
    );
    let after =
        serde_json::to_value(state.current_live_state.read().await.as_ref().unwrap()).unwrap();
    assert_eq!(
        after, before,
        "a rejected remesh must preserve the paused snapshot"
    );
    assert_eq!(submit(&app, "resume", None).await.status(), StatusCode::OK);
    let queue = state.current_control_queue.lock().await;
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].kind, "resume");
}

#[tokio::test]
async fn remesh_queue_admission_is_atomic_for_concurrent_requests() {
    let state = test_app_state_with_live_session().await;
    set_runtime_state(&state, "awaiting_command").await;
    let app = build_v2_router().with_state(state.clone());
    let sequence = state.current_control_next_seq.lock().await;
    let (first, second, ()) = tokio::join!(
        submit(&app, "mesh_build", Some("mesh-a")),
        submit(&app, "mesh_build", Some("mesh-b")),
        async {
            tokio::task::yield_now().await;
            drop(sequence);
        }
    );
    let mut statuses = [first.status(), second.status()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    assert_eq!(state.current_control_queue.lock().await.len(), 1);
    assert_eq!(state.current_command_ledger.lock().await.len(), 1);
    assert_eq!(*state.current_control_next_seq.lock().await, 1);
}

#[tokio::test]
async fn remesh_concurrent_idempotent_retries_return_the_same_command() {
    let state = test_app_state_with_live_session().await;
    set_runtime_state(&state, "awaiting_command").await;
    let app = build_v2_router().with_state(state.clone());
    let sequence = state.current_control_next_seq.lock().await;
    let (first, second, ()) = tokio::join!(
        submit(&app, "mesh_build", Some("mesh-retry")),
        submit(&app, "mesh_build", Some("mesh-retry")),
        async {
            tokio::task::yield_now().await;
            drop(sequence);
        }
    );
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(second.status(), StatusCode::OK);
    assert_eq!(
        body_json(first).await["command_id"],
        body_json(second).await["command_id"]
    );
    assert_eq!(state.current_control_queue.lock().await.len(), 1);
    assert_eq!(state.current_command_ledger.lock().await.len(), 1);
}

#[tokio::test]
async fn remesh_in_progress_blocks_compute_admission_and_readiness() {
    let state = test_app_state_with_live_session().await;
    set_runtime_state(&state, "awaiting_command").await;
    let app = build_v2_router().with_state(state.clone());
    assert_eq!(
        submit(&app, "mesh_build", None).await.status(),
        StatusCode::OK
    );
    for kind in ["solve", "compute_fields", "compute_energies"] {
        assert_eq!(readiness(&app, kind).await["enabled"], false);
        assert_eq!(
            submit(&app, kind, None).await.status(),
            StatusCode::CONFLICT
        );
    }
    assert_eq!(state.current_control_queue.lock().await.len(), 1);
}

#[tokio::test]
async fn remesh_active_record_survives_command_history_pruning() {
    for appended_kind in ["save_vtk", "fdm_grid_refresh"] {
        let state = test_app_state_with_live_session().await;
        set_runtime_state(&state, "awaiting_command").await;
        if appended_kind == "fdm_grid_refresh" {
            let mut current = state.current_live_state.write().await;
            let snapshot = current.as_mut().expect("live session");
            let mut scene = sample_scene_document();
            scene.study.requested_backend = "fdm".into();
            snapshot.scene_document = Some(scene);
            snapshot.metadata = Some(serde_json::json!({
                "execution_plan": { "backend_plan": { "kind": "fdm" } }
            }));
        }
        {
            let mut ledger = state.current_command_ledger.lock().await;
            ledger.push_back(tracked_command("remesh", CommandLifecycleState::Dispatched));
            for _ in 1..256 {
                ledger.push_back(tracked_command(
                    "save_vtk",
                    CommandLifecycleState::Completed,
                ));
            }
        }
        let app = build_v2_router().with_state(state.clone());
        let expected_status = if appended_kind == "fdm_grid_refresh" {
            StatusCode::CONFLICT
        } else {
            StatusCode::OK
        };
        assert_eq!(
            submit(&app, appended_kind, None).await.status(),
            expected_status
        );
        {
            let ledger = state.current_command_ledger.lock().await;
            assert_eq!(ledger.len(), 256);
            assert_eq!(ledger[0].command.kind, "remesh");
            assert_eq!(ledger[0].status, CommandLifecycleState::Dispatched);
        }
        if appended_kind == "fdm_grid_refresh" {
            assert!(state.current_control_queue.lock().await.is_empty());
            continue;
        }
        assert_eq!(readiness(&app, "mesh_build").await["enabled"], false);
        assert_eq!(
            submit(&app, "mesh_build", None).await.status(),
            StatusCode::CONFLICT
        );
    }
}

#[tokio::test]
async fn remesh_admission_does_not_discard_active_commands_when_ledger_is_full() {
    let state = test_app_state_with_live_session().await;
    set_runtime_state(&state, "awaiting_command").await;
    {
        let mut ledger = state.current_command_ledger.lock().await;
        for _ in 0..256 {
            ledger.push_back(tracked_command("solve", CommandLifecycleState::Dispatched));
        }
    }
    let app = build_v2_router().with_state(state.clone());
    assert_eq!(
        submit(&app, "save_vtk", None).await.status(),
        StatusCode::CONFLICT
    );
    assert_eq!(state.current_command_ledger.lock().await.len(), 256);
    assert!(state.current_control_queue.lock().await.is_empty());
}

#[tokio::test]
async fn remesh_command_queue_exposes_client_intent_for_post_disconnect_reconciliation() {
    let state = test_app_state_with_live_session().await;
    set_runtime_state(&state, "awaiting_command").await;
    let app = build_v2_router().with_state(state.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "mesh_build",
                        "client_intent_id": "mesh-intent-reconcile"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let command_id = body_json(response).await["command_id"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        state.current_control_queue.lock().await[0]
            .client_intent_id
            .as_deref(),
        Some("mesh-intent-reconcile")
    );
    let response = app
        .oneshot(
            Request::builder()
                .uri("/v2/sessions/current/simulation/commands")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let queue = body_json(response).await;
    assert_eq!(queue["commands"][0]["command_id"], command_id);
    assert_eq!(
        queue["commands"][0]["client_intent_id"],
        "mesh-intent-reconcile"
    );
}

#[test]
fn remesh_command_status_openapi_declares_optional_client_intent_id() {
    let document = crate::openapi_v2::openapi_json();
    let schema = &document["components"]["schemas"]["CommandStatusResource"];
    assert_eq!(
        schema["properties"]["client_intent_id"]["type"],
        serde_json::json!(["string", "null"])
    );
    assert!(!schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .any(|field| field == "client_intent_id"));
}

#[tokio::test]
async fn remesh_snapshot_preserves_canonical_policies_and_overwrites_client_spoofing() {
    for inherit in [false, true] {
        let state = test_app_state_with_live_session().await;
        set_runtime_state(&state, "awaiting_command").await;
        let mut scene = sample_scene_document();
        let object_id = scene.objects[0].id.clone();
        scene.objects[0].object_mesh = None;
        scene.objects[0].mesh_override = if inherit {
            None
        } else {
            Some(fullmag_authoring::ScriptBuilderPerGeometryMeshState {
                mode: "custom".into(),
                maximum_element_size: Some("4e-9".into()),
                ..Default::default()
            })
        };
        scene.study.universe_mesh = None;
        scene.universe = if inherit {
            None
        } else {
            Some(fullmag_authoring::ScriptBuilderUniverseState {
                mode: "box".into(),
                size: Some([1.0, 2.0, 3.0]),
                center: None,
                padding: None,
                airbox_hmax: Some(9e-9),
                airbox_hmin: None,
                airbox_growth_rate: None,
                airbox_grading: None,
            })
        };
        scene.objects[0].regions = vec![serde_json::from_value(serde_json::json!({
            "region_id": "mesh-test-region",
            "owner_object": object_id,
            "name": "Local refinement",
            "shape": {"kind": "box", "size": [1e-9, 1e-9, 1e-9], "center": [0.0, 0.0, 0.0]},
            "mesh_policy": {"maximum_element_size": 1e-9}
        }))
        .unwrap()];
        let expected = serde_json::json!({
            "objects": { object_id.clone(): scene.objects[0].mesh_override },
            "universe": scene.universe,
            "shared_domain": scene.study.shared_domain_mesh,
            "regions": scene.objects[0].regions,
        });
        state
            .current_live_state
            .write()
            .await
            .as_mut()
            .unwrap()
            .scene_document = Some(scene);
        let app = build_v2_router().with_state(state.clone());
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v2/sessions/current/simulation/commands")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "kind": "mesh_build",
                            "mesh_options": { "canonical_policy_snapshot": {"forged": true} }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = body_json(response).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let queue = state.current_control_queue.lock().await;
        let snapshot = &queue[0].mesh_options.as_ref().unwrap()["canonical_policy_snapshot"];
        assert_eq!(
            queue[0].precondition.as_ref().unwrap().scene_revision,
            queue[0].mesh_options.as_ref().unwrap()["source_scene_revision"].as_u64()
        );
        assert_eq!(snapshot, &expected);
        assert_eq!(snapshot["objects"][&object_id].is_null(), inherit);
        assert_eq!(snapshot["universe"].is_null(), inherit);
    }
}

#[tokio::test]
async fn remesh_without_a_canonical_scene_drops_client_policy_snapshot() {
    let state = test_app_state_with_live_session().await;
    set_runtime_state(&state, "awaiting_command").await;
    let app = build_v2_router().with_state(state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/v2/sessions/current/simulation/commands")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "kind": "mesh_build",
                        "mesh_options": { "canonical_policy_snapshot": {"forged": true} }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let queue = state.current_control_queue.lock().await;
    assert!(queue[0]
        .mesh_options
        .as_ref()
        .unwrap()
        .get("canonical_policy_snapshot")
        .is_none());
}
