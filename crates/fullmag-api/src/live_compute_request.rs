//! Request identity for HTTP Compute on the durable accepted lane.

use std::sync::Arc;

use fullmag_session::{LiveComputeRequestReceipt, SessionStore};
use serde_json::json;

use crate::error::ApiError;
use crate::schemas::commands::{
    CommandExecutionBinding, CommandResponse, RuntimeCommandTarget, StructuredCommandRequest,
};
use crate::types::{
    AppState, CommandLifecycleState, CurrentLiveRequestContext, SessionCommand, TrackedCommandRecord,
};

#[derive(Clone)]
pub(crate) struct LiveComputeRequest {
    key_sha256: String,
    request_sha256: String,
    legacy_intent_key: Option<String>,
    request_id: Option<String>,
    command_kind: &'static str,
    client_intent_id: Option<String>,
    requested_target: Option<serde_json::Value>,
}

impl LiveComputeRequest {
    pub(crate) fn capture(
        context: &CurrentLiveRequestContext,
        request: &StructuredCommandRequest,
        header_key: Option<&str>,
        request_id: Option<String>,
    ) -> Result<Option<Self>, ApiError> {
        let (command_kind, intent) = match request {
            StructuredCommandRequest::Run { intent, .. } => ("run", intent),
            StructuredCommandRequest::Relax { intent, .. } => ("relax", intent),
            StructuredCommandRequest::Solve { intent } => ("solve", intent),
            _ => return Ok(None),
        };
        let client_intent = intent.client_intent_id.as_deref().filter(|key| !key.is_empty());
        let key = header_key.or(client_intent);
        if header_key.is_some_and(|header_key| client_intent.is_some_and(|id| id != header_key)) {
            return Err(ApiError::bad_request(
                "Idempotency-Key must match client_intent_id for live Compute",
            ));
        }
        let request = serde_json::to_value(request)
            .map_err(|error| ApiError::bad_request(format!("cannot encode live Compute request: {error}")))?;
        let key_identity = match key {
            Some(key) => json!({
                "schema": "fullmag.live_compute_request.v1",
                "session_id": context.session_id,
                "session_epoch": context.session_epoch,
                "key": key,
            }),
            None => json!({
                "schema": "fullmag.live_compute_unkeyed_acceptance.v1",
                "server_nonce": uuid::Uuid::new_v4().to_string(),
            }),
        };
        Ok(Some(Self {
            key_sha256: fullmag_session::canonical_json_sha256(&key_identity),
            request_sha256: fullmag_session::canonical_json_sha256(&request),
            legacy_intent_key: key.map(|key| format!("live-http-{}", fullmag_session::hex_sha256(key.as_bytes()))),
            request_id,
            command_kind,
            client_intent_id: intent.client_intent_id.clone(),
            requested_target: Some(request.get("target").cloned().unwrap_or_else(|| {
                if command_kind == "solve" { json!({"kind": "study"}) } else { json!({"kind": "run"}) }
            })),
        }))
    }

    pub(crate) fn receipt(&self, command_id: String) -> LiveComputeRequestReceipt {
        LiveComputeRequestReceipt {
            key_sha256: self.key_sha256.clone(),
            request_sha256: self.request_sha256.clone(),
            command_id,
            request_id: self.request_id.clone(),
            command_kind: Some(self.command_kind.into()),
            client_intent_id: self.client_intent_id.clone(),
            requested_target: self.requested_target.clone(),
        }
    }

    pub(crate) async fn replay_under_transition(
        &self,
        state: &Arc<AppState>,
        expected: &CurrentLiveRequestContext,
    ) -> Result<Option<CommandResponse>, ApiError> {
        if self.legacy_intent_key.is_none() {
            return Ok(None);
        }
        let current = crate::capture_current_live_read_context(state).await?;
        if current.session_id != expected.session_id || current.session_epoch != expected.session_epoch {
            return Err(ApiError::conflict("request_context_stale"));
        }
        {
            let snapshot = state.current_live_state.read().await;
            let snapshot = snapshot
                .as_ref()
                .ok_or_else(|| ApiError::not_found("no active local live workspace"))?;
            crate::ensure_current_live_request_context(
                snapshot,
                &current,
                state
                    .current_live_session_epoch
                    .load(std::sync::atomic::Ordering::Acquire),
            )?;
            if let Some(error) =
                crate::live_accepted_execution::accepted_preparation_recovery_error(snapshot)
            {
                return Err(error);
            }
        }
        let Some(root) = state.submit_store_root.clone() else {
            return Ok(None);
        };
        let request = self.clone();
        tokio::task::spawn_blocking(move || {
            match std::fs::symlink_metadata(&root) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(store_error(error)),
            }
            let store = SessionStore::open_existing(root).map_err(store_error)?;
            request.replay(&store, &current)
        })
        .await
        .map_err(store_error)?
    }

    fn replay(
        &self,
        store: &SessionStore,
        owner: &CurrentLiveRequestContext,
    ) -> Result<Option<CommandResponse>, ApiError> {
        let Some(legacy_intent_key) = self.legacy_intent_key.as_deref() else {
            return Ok(None);
        };
        let mut response = None;
        for intent in store.list_run_intents().map_err(store_error)? {
            let Some(live) = intent.specification.pointer("/parameters/live_workspace") else {
                continue;
            };
            if live["session_id"].as_str() != Some(owner.session_id.as_str())
                || live["session_epoch"].as_u64() != Some(owner.session_epoch)
            {
                continue;
            }

            let manual_start = run_intent_requires_manual_start(&intent)?;
            let direct_receipt = receipt_from_intent(&intent)?;
            let direct_matches = direct_receipt
                .as_ref()
                .map(|receipt| self.receipt_matches_request(receipt))
                .transpose()?
                .unwrap_or(false);

            if manual_start && direct_receipt.is_some() {
                if direct_matches {
                    let permitted = store
                        .accepted_run_start_permitted(&intent.run_id)
                        .map_err(|error| publication_or_store_error(error, &intent.run_id))?;
                    if !permitted {
                        return Err(accepted_compute_release_required());
                    }
                    let release = store
                        .read_accepted_run_start_release(&intent.run_id)
                        .map_err(store_error)?
                        .ok_or_else(accepted_compute_release_required)?;
                    let Some(release_receipt) = release.live_request else {
                        return Err(accepted_compute_release_required());
                    };
                    if Some(&release_receipt) != direct_receipt.as_ref() {
                        return Err(store_error(
                            "manual live Compute receipt does not match its verified start release",
                        ));
                    }
                    self.match_receipt(
                        store,
                        &intent,
                        direct_receipt.expect("manual direct receipt was present"),
                        false,
                        &mut response,
                    )?;
                    continue;
                }

                let release = store
                    .read_accepted_run_start_release(&intent.run_id)
                    .map_err(store_error)?;
                if let Some(release_receipt) =
                    release.as_ref().and_then(|grant| grant.live_request.as_ref())
                {
                    if self.receipt_matches_request(release_receipt)? {
                        return Err(store_error(
                            "manual live Compute receipt does not match its verified start release",
                        ));
                    }
                }
                continue;
            }

            if direct_receipt.is_none() && intent.idempotency_key == legacy_intent_key {
                return Err(ApiError::conflict_with_code(
                    "live_compute_legacy_idempotency_unverifiable",
                    "This Compute key was previously accepted without a request digest. Inspect the existing run.",
                ));
            }

            if let Some(receipt) = direct_receipt {
                self.match_receipt(store, &intent, receipt, false, &mut response)?;
            }
            if let Some(release) = store
                .read_accepted_run_start_release(&intent.run_id)
                .map_err(store_error)?
            {
                if let Some(receipt) = release.live_request {
                    if manual_start {
                        if self.receipt_matches_request(&receipt)? {
                            let permitted = store
                                .accepted_run_start_permitted(&intent.run_id)
                                .map_err(|error| publication_or_store_error(error, &intent.run_id))?;
                            if !permitted {
                                return Err(accepted_compute_release_required());
                            }
                            self.match_receipt(store, &intent, receipt, true, &mut response)?;
                        }
                    } else {
                        self.match_receipt(store, &intent, receipt, true, &mut response)?;
                    }
                }
            }
        }
        Ok(response)
    }

    fn receipt_matches_request(
        &self,
        receipt: &LiveComputeRequestReceipt,
    ) -> Result<bool, ApiError> {
        receipt.validate().map_err(store_error)?;
        if receipt.key_sha256 != self.key_sha256 {
            return Ok(false);
        }
        if receipt.request_sha256 != self.request_sha256 {
            return Err(ApiError::conflict_with_code(
                "live_compute_idempotency_conflict",
                "This Compute key has already been used for a different request in this session.",
            ));
        }
        Ok(true)
    }

    fn match_receipt(
        &self,
        store: &SessionStore,
        intent: &fullmag_session::FmsRunIntent,
        receipt: LiveComputeRequestReceipt,
        released_study: bool,
        response: &mut Option<CommandResponse>,
    ) -> Result<(), ApiError> {
        if !self.receipt_matches_request(&receipt)? {
            return Ok(());
        }
        confirm_run_intent_publication(store, intent)?;
        if response.is_some() {
            return Err(ApiError::conflict_with_code(
                "live_compute_receipt_ambiguous",
                "Multiple durable acceptances match this Compute request.",
            ));
        }
        *response = Some(CommandResponse {
            accepted: true,
            execution_binding: Some(accepted_execution_binding(intent, released_study.then_some(&receipt))?),
            command_id: receipt.command_id,
            request_id: receipt.request_id,
            error: None,
        });
        Ok(())
    }
}

pub(crate) fn receipt_from_intent(
    intent: &fullmag_session::FmsRunIntent,
) -> Result<Option<LiveComputeRequestReceipt>, ApiError> {
    let Some(live) = intent.specification.pointer("/parameters/live_workspace") else {
        return Ok(None);
    };
    let Some(value) = live.get("request_receipt") else {
        return Ok(None);
    };
    let receipt: LiveComputeRequestReceipt = serde_json::from_value(value.clone()).map_err(store_error)?;
    receipt.validate().map_err(store_error)?;
    if live["command_id"].as_str() != Some(receipt.command_id.as_str())
        || intent.idempotency_key != format!("live-http-v2-{}", receipt.key_sha256)
        || receipt.requested_target.as_ref().is_some_and(|target| {
            live.pointer("/command/target") != Some(target)
        })
    {
        return Err(store_error("live Compute receipt does not match its RunIntent"));
    }
    Ok(Some(receipt))
}

fn accepted_execution_binding(
    intent: &fullmag_session::FmsRunIntent,
    release_receipt: Option<&LiveComputeRequestReceipt>,
) -> Result<CommandExecutionBinding, ApiError> {
    let (target, step_id) = if let Some(receipt) = release_receipt {
        (receipt.requested_target.as_ref(), None)
    } else {
        let live = intent.specification.pointer("/parameters/live_workspace")
            .ok_or_else(|| store_error("accepted Compute has no live workspace provenance"))?;
        let target = live.pointer("/command/target");
        let step_id = match live.get("step_id") {
            None | Some(serde_json::Value::Null) => None,
            Some(value) => Some(value.as_str().filter(|id| !id.trim().is_empty())
                .ok_or_else(|| store_error("accepted Compute has an invalid selected step"))?.to_owned()),
        };
        (target, step_id)
    };
    let requested_target = target.filter(|value| !value.is_null())
        .map(|value| serde_json::from_value::<RuntimeCommandTarget>(value.clone()).map_err(store_error))
        .transpose()?;
    if release_receipt.is_some() && !match requested_target.as_ref() {
        None | Some(RuntimeCommandTarget::Study | RuntimeCommandTarget::Run { run_id: None }) => true,
        Some(RuntimeCommandTarget::Run { run_id: Some(run_id) }) => run_id == &intent.run_id,
        _ => false,
    } {
        return Err(store_error("accepted release has an invalid requested target"));
    }
    Ok(CommandExecutionBinding {
        requested_target,
        run_id: intent.run_id.clone(),
        step_id,
    })
}

/// Read an accepted command for projection from its already validated owner.
/// An unreleased startup Study has no HTTP Compute command to recover.
pub(crate) fn accepted_command_readback(
    store: &SessionStore,
    intent: &fullmag_session::FmsRunIntent,
    run_status: &str,
) -> Result<Option<TrackedCommandRecord>, ApiError> {
    let direct_receipt = receipt_from_intent(intent)?;
    let manual_start = run_intent_requires_manual_start(intent)?;
    let live = intent.specification.pointer("/parameters/live_workspace");
    let direct_command = live.and_then(|live| {
        let command = live.get("command")?;
        let kind = command.get("kind")?.as_str()?;
        let id = command.get("command_id")?.as_str()?;
        (matches!(kind, "solve" | "run" | "relax")
            && live.get("command_id").and_then(serde_json::Value::as_str) == Some(id))
            .then_some(command)
    });
    let start_permitted = if manual_start {
        Some(
            store
                .accepted_run_start_permitted(&intent.run_id)
                .map_err(|error| publication_or_store_error(error, &intent.run_id))?,
        )
    } else {
        None
    };
    let release = if !manual_start || start_permitted == Some(true) || direct_command.is_none() {
        store
            .read_accepted_run_start_release(&intent.run_id)
            .map_err(store_error)?
    } else {
        None
    };
    if manual_start && direct_command.is_some() {
        if start_permitted != Some(true) {
            return Ok(None);
        }
        let Some(receipt) = direct_receipt.as_ref() else {
            return Ok(None);
        };
        let Some(release_receipt) = release.as_ref().and_then(|grant| grant.live_request.as_ref()) else {
            return Ok(None);
        };
        if release_receipt != receipt {
            return Err(store_error(
                "manual live Compute receipt does not match its verified start release",
            ));
        }
    }

    let (mut command, request_id, execution_binding) = if let Some(value) = direct_command {
        let command: SessionCommand = serde_json::from_value(value.clone()).map_err(store_error)?;
        if direct_receipt.as_ref().is_some_and(|receipt| {
            command.command_id != receipt.command_id
                || receipt.command_kind.as_deref().is_some_and(|kind| kind != command.kind.as_str())
                || receipt.client_intent_id.as_ref().is_some_and(|id| command.client_intent_id.as_ref() != Some(id))
        }) {
            return Err(store_error("live Compute command does not match its receipt"));
        }
        (command, direct_receipt.and_then(|receipt| receipt.request_id),
            accepted_execution_binding(intent, None)?)
    } else {
        if direct_receipt.is_some() {
            return Err(store_error("live Compute RunIntent has no command readback"));
        }
        let Some(grant) = release else {
            return Ok(None);
        };
        let Some(receipt) = grant.live_request else {
            return Ok(None);
        };
        let Some(kind) = receipt.command_kind.as_deref() else {
            return Ok(None);
        };
        let mut command = crate::router_v2::handlers::simulation::commands::new_session_command(
            receipt.command_id.clone(), kind, grant.released_at.timestamp_millis().max(0) as u128,
        );
        command.client_intent_id = receipt.client_intent_id.clone();
        let binding = accepted_execution_binding(intent, Some(&receipt))?;
        (command, receipt.request_id, binding)
    };
    command.execution_binding = Some(execution_binding);
    command.seq = 0;
    command.target = Some(RuntimeCommandTarget::Run { run_id: Some(intent.run_id.clone()) });
    let status = if run_status == "running" {
        CommandLifecycleState::Running
    } else {
        CommandLifecycleState::Accepted
    };
    Ok(Some(TrackedCommandRecord {
        command,
        request_id,
        status,
        dispatched_at_unix_ms: None,
        completed_at_unix_ms: None,
        completion_status: None,
        error: None,
    }))
}

/// Qualify a pre-binding journal record against its own immutable run.
pub(crate) async fn retained_command_binding(
    state: &AppState,
    owner: &CurrentLiveRequestContext,
    command: &SessionCommand,
) -> Result<Option<CommandExecutionBinding>, ApiError> {
    if let Some(binding) = command.execution_binding.as_ref() {
        return Ok(Some(binding.clone()));
    }
    let Some(RuntimeCommandTarget::Run { run_id: Some(run_id) }) = command.target.as_ref() else {
        return Ok(None);
    };
    let Some(root) = state.submit_store_root.clone() else {
        return Ok(None);
    };
    if !matches!(command.kind.as_str(), "solve" | "run" | "relax") {
        return Ok(None);
    }
    let (run_id, command_id, kind) = (run_id.clone(), command.command_id.clone(), command.kind.clone());
    let (session_id, session_epoch) = (owner.session_id.clone(), owner.session_epoch);
    tokio::task::spawn_blocking(move || {
        match std::fs::symlink_metadata(&root) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(store_error(error)),
        }
        let store = SessionStore::open_existing(root).map_err(store_error)?;
        let Some(intent) = store.read_run_intent(&run_id).map_err(store_error)? else {
            return Ok(None);
        };
        let Some(live) = intent.specification.pointer("/parameters/live_workspace") else {
            return Ok(None);
        };
        if live["session_id"].as_str() != Some(session_id.as_str())
            || live["session_epoch"].as_u64() != Some(session_epoch)
        {
            return Ok(None);
        }
        Ok(accepted_command_readback(&store, &intent, "waiting_for_compute")?
            .filter(|record| record.command.command_id == command_id && record.command.kind == kind)
            .and_then(|record| record.command.execution_binding))
    })
    .await
    .map_err(store_error)?
}

fn run_intent_requires_manual_start(
    intent: &fullmag_session::FmsRunIntent,
) -> Result<bool, ApiError> {
    let Some(parameters) = intent
        .specification
        .get("parameters")
        .and_then(serde_json::Value::as_object)
    else {
        return Ok(false);
    };
    let Some(policy) = parameters.get(fullmag_session::ACCEPTED_RUN_START_POLICY_KEY) else {
        return Ok(false);
    };
    fullmag_session::accepted_run_start_policy_is_manual(policy).map_err(store_error)
}

fn accepted_compute_release_required() -> ApiError {
    ApiError::conflict_with_code(
        "accepted_compute_release_required",
        "This Compute request was accepted but its manual start release is not present; inspect the existing run before retrying.",
    )
}

fn publication_or_store_error(error: anyhow::Error, run_id: &str) -> ApiError {
    if let Some(uncertain) = error.downcast_ref::<fullmag_session::PublicationUncertain>() {
        let (code, record) = match uncertain.destination().file_name().and_then(|name| name.to_str()) {
            Some("run_intent.json") => ("run_intent_durability_unconfirmed", "RunIntent"),
            Some("start_release.json") => ("start_release_durability_unconfirmed", "start release"),
            _ => ("accepted_publication_durability_unconfirmed", "accepted publication"),
        };
        ApiError::unprocessable_with_code(
            code,
            format!("run `{run_id}` has unconfirmed {record} durability; inspect the existing run before retrying"),
        )
    } else {
        store_error(error)
    }
}

fn confirm_run_intent_publication(
    store: &SessionStore,
    intent: &fullmag_session::FmsRunIntent,
) -> Result<(), ApiError> {
    store
        .confirm_run_intent_publication(intent)
        .map_err(|error| publication_or_store_error(error, &intent.run_id))
}

fn store_error(error: impl std::fmt::Display) -> ApiError {
    ApiError::internal(format!("reading durable live Compute receipt: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context(session_id: &str) -> CurrentLiveRequestContext {
        CurrentLiveRequestContext {
            session_id: session_id.into(),
            run_id: None,
            session_epoch: 8,
            request_scope_epoch: "before-restart".into(),
        }
    }

    fn request(stage: &str) -> StructuredCommandRequest {
        serde_json::from_value(json!({
            "kind": "relax",
            "target": {"kind": "stage_id", "stage_id": stage},
            "client_intent_id": "compute-intent",
            "precondition": {"scene_revision": 12}
        })).unwrap()
    }

    fn stale_compute_request(client_intent_id: Option<&str>, current_run: &str) -> serde_json::Value {
        let mut body = json!({
            "kind": "solve",
            "target": {"kind": "study"},
            "precondition": {
                "scene_revision": 12,
                "mesh_revision": 0,
                "current_run": {"kind": "run", "run_id": current_run}
            }
        });
        if let Some(client_intent_id) = client_intent_id {
            body["client_intent_id"] = json!(client_intent_id);
        }
        body
    }

    async fn compute_http_test_state(
        submit_store_root: Option<std::path::PathBuf>,
        missing_solve_material: bool,
    ) -> Arc<AppState> {
        let mut state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let state_mut = Arc::get_mut(&mut state).expect("test AppState must be uniquely owned");
        state_mut.submit_store_root = submit_store_root;
        state_mut
            .current_live_session_epoch
            .store(8, std::sync::atomic::Ordering::Release);

        let mut scene = crate::router_v2::handlers::sessions::create::create_empty_scene_document(
            &crate::schemas::sessions::CreateSessionRequest {
                name: "retry-disposition-test".into(),
                backend: "fdm".into(),
                device: "cpu".into(),
                precision: "double".into(),
                replace_current: false,
                output_storage: None,
            },
        )
        .expect("canonical empty scene fixture");
        scene.revision = 12;
        if missing_solve_material {
            scene.objects.push(
                serde_json::from_value(json!({
                    "id": "body",
                    "name": "Body",
                    "geometry": {
                        "geometry_kind": "Box",
                        "geometry_params": {"size": [1.0, 1.0, 1.0]}
                    },
                    "material_ref": "missing-material"
                }))
                .expect("scene object with unresolved material fixture"),
            );
        }

        let mut current = state.current_live_state.write().await;
        let snapshot = current.as_mut().expect("live session fixture");
        snapshot.session.session_id = "session-a".into();
        snapshot.scene_document = Some(scene);
        snapshot.run = None;
        snapshot.mesh_revision = 0;
        drop(current);
        state
    }

    async fn post_compute_http(
        state: Arc<AppState>,
        body: serde_json::Value,
        idempotency_key: Option<&str>,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        use axum::body::{to_bytes, Body};
        use axum::http::{header, Request};
        use tower::ServiceExt;

        let mut request = Request::builder()
            .method("POST")
            .uri("/v2/sessions/current/simulation/commands")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(idempotency_key) = idempotency_key {
            request = request.header("idempotency-key", idempotency_key);
        }
        let response = crate::router_v2::build_v2_router()
            .with_state(state)
            .oneshot(
                request
                    .body(Body::from(body.to_string()))
                    .expect("request fixture"),
            )
            .await
            .expect("HTTP command route should respond");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("HTTP error body should be readable");
        let body = serde_json::from_slice(&bytes).expect("HTTP error body should be JSON");
        (status, body)
    }

    fn manual_direct_intent(
        run_id: &str,
        receipt: &LiveComputeRequestReceipt,
    ) -> fullmag_session::FmsRunIntent {
        let target = receipt
            .requested_target
            .clone()
            .unwrap_or_else(|| json!({"kind": "study"}));
        let kind = receipt.command_kind.as_deref().unwrap_or("relax");
        fullmag_session::FmsRunIntent::new(
            run_id,
            format!("live-http-v2-{}", receipt.key_sha256),
            json!({
                "run_id": run_id,
                "parameters": {
                    (fullmag_session::ACCEPTED_RUN_START_POLICY_KEY): {
                        "schema_version": "accepted_run_start_policy.v1",
                        "mode": "manual"
                    },
                    "live_workspace": {
                        "session_id": "session-a",
                        "session_epoch": 8,
                        "command_id": receipt.command_id,
                        "request_receipt": receipt.clone(),
                        "step_id": "canonical-relax-a",
                        "command": {
                            "seq": 0,
                            "command_id": receipt.command_id,
                            "kind": kind,
                            "created_at_unix_ms": 123,
                            "client_intent_id": receipt.client_intent_id,
                            "target": target
                        }
                    }
                }
            }),
        )
    }

    #[tokio::test]
    #[ignore = "launched in a subprocess to isolate process-global runtime configuration"]
    async fn keyed_stale_compute_http_error_has_only_a_linearized_not_accepted_disposition_child() {
        // No key cannot prove a keyed durable miss, even when the stale-input
        // error itself is otherwise identical.
        let unkeyed_dir = tempfile::tempdir().unwrap();
        let unkeyed_store_root = unkeyed_dir.path().join("submit-store");
        SessionStore::open(&unkeyed_store_root).unwrap();
        let state = compute_http_test_state(Some(unkeyed_store_root), false).await;
        let (status, body) = post_compute_http(
            state,
            stale_compute_request(None, "previous-run"),
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["code"], "command_current_run_changed");
        assert!(body.get("intent_disposition").is_none());

        // Without a configured store, an apparent replay miss is not a
        // completed owner-scoped durable scan and must stay unresolved.
        let state = compute_http_test_state(None, false).await;
        let (status, body) = post_compute_http(
            state,
            stale_compute_request(Some("compute-intent"), "previous-run"),
            Some("compute-intent"),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["code"], "command_current_run_changed");
        assert!(body.get("intent_disposition").is_none());

        // A matching key used for another body is positive evidence of a
        // prior acceptance; it must not be collapsed into a no-acceptance
        // response.
        let conflict_dir = tempfile::tempdir().unwrap();
        let conflict_store_root = conflict_dir.path().join("submit-store");
        let owner = context("session-a");
        let changed_body = serde_json::from_value(stale_compute_request(
            Some("compute-intent"),
            "another-run",
        ))
        .unwrap();
        let changed_request = LiveComputeRequest::capture(
            &owner,
            &changed_body,
            Some("compute-intent"),
            Some("request-first".into()),
        )
        .unwrap()
        .unwrap();
        let receipt = changed_request.receipt("command-first".into());
        let intent = manual_direct_intent("run-first", &receipt);
        SessionStore::open(&conflict_store_root)
            .unwrap()
            .commit_run_intent(&intent)
            .unwrap();
        let state = compute_http_test_state(Some(conflict_store_root), false).await;
        let (status, body) = post_compute_http(
            state,
            stale_compute_request(Some("compute-intent"), "previous-run"),
            Some("compute-intent"),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["code"], "live_compute_idempotency_conflict");
        assert!(body.get("intent_disposition").is_none());

        // The material error is returned before the current implementation's
        // second replay. The future typed no-acceptance marker must retain the
        // old HTTP status/code after a successful keyed scan finds no receipt.
        let material_dir = tempfile::tempdir().unwrap();
        let material_store_root = material_dir.path().join("submit-store");
        SessionStore::open(&material_store_root).unwrap();
        let state = compute_http_test_state(Some(material_store_root), true).await;
        let (status, body) = post_compute_http(
            state,
            stale_compute_request(Some("compute-intent"), "previous-run"),
            Some("compute-intent"),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "bad_request");
        let material_disposition = body
            .get("intent_disposition")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);

        // This request reaches the locked stale-run precondition after its
        // second exact replay. It has the same intended disposition while
        // preserving its established conflict status and code.
        let empty_dir = tempfile::tempdir().unwrap();
        let empty_store_root = empty_dir.path().join("submit-store");
        SessionStore::open(&empty_store_root).unwrap();
        let state = compute_http_test_state(Some(empty_store_root), false).await;
        let (status, body) = post_compute_http(
            state,
            stale_compute_request(Some("compute-intent"), "previous-run"),
            Some("compute-intent"),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["code"], "command_current_run_changed");
        let stale_run_disposition = body
            .get("intent_disposition")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);

        // The current implementation's semantic RED is only these missing
        // machine dispositions; status, code, no-key/root, and body-conflict
        // contracts above already pass against today's production code.
        assert_eq!(
            [material_disposition, stale_run_disposition],
            [Some("not_accepted".into()), Some("not_accepted".into())],
        );
    }

    #[test]
    fn keyed_stale_compute_http_error_has_only_a_linearized_not_accepted_disposition() {
        let child_test_name =
            "live_compute_request::tests::keyed_stale_compute_http_error_has_only_a_linearized_not_accepted_disposition_child";
        let status = std::process::Command::new(
            std::env::current_exe().expect("test harness executable is available"),
        )
        .args(["--ignored", "--exact", child_test_name, "--nocapture"])
        .env("FULLMAG_RUNTIME_SERVICE_CONFIG", "test-runtime-service-config")
        .status()
        .expect("isolated HTTP regression child process should start");
        assert!(
            status.success(),
            "isolated HTTP regression child process failed with {status}"
        );
    }

    #[test]
    fn unkeyed_compute_records_a_private_acceptance_without_public_replay() {
        let owner = context("session-a");
        let request = serde_json::from_value(json!({"kind":"solve"})).unwrap();
        let first = LiveComputeRequest::capture(&owner, &request, None, None).unwrap().unwrap();
        let second = LiveComputeRequest::capture(&owner, &request, None, None).unwrap().unwrap();
        assert_ne!(first.key_sha256, second.key_sha256);
        assert_eq!(first.request_sha256, second.request_sha256);
        assert!(first.legacy_intent_key.is_none());
        let receipt = first.receipt("command-first".into());
        assert_eq!(receipt.requested_target, Some(json!({"kind":"study"})));
    }

    #[test]
    fn manual_direct_receipt_requires_verified_release_and_replays_one_exact_ack() {
        let owner = context("session-a");
        let submitted = request("relax-a");
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let first = LiveComputeRequest::capture(
            &owner,
            &submitted,
            Some("compute-intent"),
            Some("trace-first".into()),
        )
        .unwrap()
        .unwrap();
        let receipt = first.receipt("command-first".into());
        let intent = manual_direct_intent("run-manual-direct", &receipt);
        store.commit_run_intent(&intent).unwrap();
        drop(store);

        let store = SessionStore::open_existing(directory.path()).unwrap();
        let retry = LiveComputeRequest::capture(
            &owner,
            &submitted,
            Some("compute-intent"),
            Some("trace-retry".into()),
        )
        .unwrap()
        .unwrap();
        let held_error = retry.replay(&store, &owner).unwrap_err();
        assert_eq!(
            held_error.code.as_deref(),
            Some("accepted_compute_release_required")
        );
        assert!(accepted_command_readback(&store, &intent, "running")
            .unwrap()
            .is_none());

        store
            .release_accepted_run_start_for_live_request(
                &intent.run_id,
                &intent.payload_sha256,
                "start-manual-direct",
                &receipt,
            )
            .unwrap();
        drop(store);

        let store = SessionStore::open_existing(directory.path()).unwrap();
        let response = retry.replay(&store, &owner).unwrap().unwrap();
        assert!(response.accepted);
        assert_eq!(response.command_id, "command-first");
        assert_eq!(response.request_id.as_deref(), Some("trace-first"));
        let binding = response.execution_binding.as_ref().unwrap();
        assert_eq!(binding.run_id, "run-manual-direct");
        assert_eq!(
            binding.requested_target,
            Some(RuntimeCommandTarget::StageId {
                stage_id: "relax-a".into()
            })
        );
        assert_eq!(binding.step_id.as_deref(), Some("canonical-relax-a"));
        let record = accepted_command_readback(&store, &intent, "running")
            .unwrap()
            .unwrap();
        assert_eq!(record.command.execution_binding.as_ref(), Some(binding));

        let changed_body = LiveComputeRequest::capture(
            &owner,
            &request("relax-b"),
            Some("compute-intent"),
            None,
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            changed_body
                .replay(&store, &owner)
                .unwrap_err()
                .code
                .as_deref(),
            Some("live_compute_idempotency_conflict")
        );

        let duplicate = manual_direct_intent("run-manual-duplicate", &receipt);
        let duplicate_path = store
            .root()
            .join("runs")
            .join(&duplicate.run_id)
            .join("run_intent.json");
        std::fs::create_dir_all(duplicate_path.parent().unwrap()).unwrap();
        std::fs::write(
            &duplicate_path,
            serde_json::to_vec_pretty(&duplicate).unwrap(),
        )
        .unwrap();
        store
            .release_accepted_run_start_for_live_request(
                &duplicate.run_id,
                &duplicate.payload_sha256,
                "start-manual-duplicate",
                &receipt,
            )
            .unwrap();
        assert_eq!(
            retry.replay(&store, &owner).unwrap_err().code.as_deref(),
            Some("live_compute_receipt_ambiguous")
        );
    }

    #[test]
    fn compute_receipt_replays_both_durable_acceptance_paths_with_exact_scope_and_body() {
        let owner = context("session-a");
        for held in [false, true] {
            let submitted = |changed: bool| {
                if held {
                    serde_json::from_value(json!({
                        "kind": "solve", "target": {"kind": "study"},
                        "client_intent_id": "compute-intent",
                        "precondition": {"scene_revision": if changed { 13 } else { 12 }}
                    })).unwrap()
                } else {
                    request(if changed { "relax-b" } else { "relax-a" })
                }
            };
            let directory = tempfile::tempdir().unwrap();
            let store = SessionStore::open(directory.path()).unwrap();
            let first = LiveComputeRequest::capture(
                &owner, &submitted(false), Some("compute-intent"), Some("trace-first".into()),
            ).unwrap().unwrap();
            let receipt = first.receipt("command-first".into());
            let parameters = if held {
                json!({
                    (fullmag_session::ACCEPTED_RUN_START_POLICY_KEY): {
                        "schema_version": "accepted_run_start_policy.v1", "mode": "manual"
                    },
                    "live_workspace": {"session_id": "session-a", "session_epoch": 8}
                })
            } else {
                json!({"live_workspace": {
                    "session_id": "session-a", "session_epoch": 8,
                    "command_id": "command-first", "request_receipt": receipt,
                    "step_id": "canonical-relax-a",
                    "command": {
                        "seq": 0, "command_id": "command-first", "kind": "relax",
                        "created_at_unix_ms": 123, "client_intent_id": "compute-intent",
                        "target": {"kind": "stage_id", "stage_id": "relax-a"}
                    }
                }})
            };
            let intent = fullmag_session::FmsRunIntent::new(
                "run-first", format!("live-http-v2-{}", receipt.key_sha256),
                json!({"run_id": "run-first", "parameters": parameters}),
            );
            store.commit_run_intent(&intent).unwrap();
            if held {
                assert!(first.replay(&store, &owner).unwrap().is_none());
                assert!(accepted_command_readback(&store, &intent, "waiting_for_solve").unwrap().is_none());
                store.release_accepted_run_start_for_live_request(
                    "run-first", &intent.payload_sha256, "start-first", &receipt,
                ).unwrap();
            }
            drop(store);

            let store = SessionStore::open_existing(directory.path()).unwrap();
            let mut restored = owner.clone();
            restored.request_scope_epoch = "after-restart".into();
            restored.run_id = Some("another-current-run".into());
            let retry = LiveComputeRequest::capture(
                &restored, &submitted(false), Some("compute-intent"), Some("trace-retry".into()),
            ).unwrap().unwrap();
            let response = retry.replay(&store, &restored).unwrap().unwrap();
            assert!(response.accepted);
            assert_eq!(response.command_id, "command-first");
            assert_eq!(response.request_id.as_deref(), Some("trace-first"));
            let binding = response.execution_binding.as_ref().unwrap();
            assert_eq!(binding.run_id, "run-first");
            if held {
                assert_eq!(binding.requested_target, Some(RuntimeCommandTarget::Study));
                assert!(binding.step_id.is_none());
            } else {
                assert_eq!(binding.requested_target, Some(RuntimeCommandTarget::StageId { stage_id: "relax-a".into() }));
                assert_eq!(binding.step_id.as_deref(), Some("canonical-relax-a"));
            }
            let record = accepted_command_readback(&store, &intent, "running").unwrap().unwrap();
            assert_eq!(record.command.command_id, response.command_id);
            assert_eq!(record.command.kind, if held { "solve" } else { "relax" });
            assert_eq!(record.command.client_intent_id.as_deref(), Some("compute-intent"));
            assert_eq!(record.request_id, response.request_id);
            assert_eq!(record.command.execution_binding.as_ref(), Some(binding));
            assert_eq!(record.status, CommandLifecycleState::Running);
            assert!(matches!(record.command.target,
                Some(RuntimeCommandTarget::Run { run_id: Some(run_id) }) if run_id == "run-first"));

            let changed = LiveComputeRequest::capture(
                &restored, &submitted(true), Some("compute-intent"), None,
            ).unwrap().unwrap();
            assert_eq!(changed.replay(&store, &restored).unwrap_err().code.as_deref(),
                Some("live_compute_idempotency_conflict"));

            let foreign = context("session-b");
            let other = LiveComputeRequest::capture(
                &foreign, &submitted(false), Some("compute-intent"), None,
            ).unwrap().unwrap();
            assert!(other.replay(&store, &foreign).unwrap().is_none());
        }
    }
}
