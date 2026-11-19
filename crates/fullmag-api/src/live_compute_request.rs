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
            if let Some(receipt) = receipt_from_intent(&intent)? {
                self.match_receipt(&intent, receipt, false, &mut response)?;
            } else if intent.idempotency_key == legacy_intent_key {
                return Err(ApiError::conflict_with_code(
                    "live_compute_legacy_idempotency_unverifiable",
                    "This Compute key was previously accepted without a request digest. Inspect the existing run.",
                ));
            }

            if let Some(release) = store.read_accepted_run_start_release(&intent.run_id).map_err(store_error)? {
                if let Some(receipt) = release.live_request {
                    self.match_receipt(&intent, receipt, true, &mut response)?;
                }
            }
        }
        Ok(response)
    }

    fn match_receipt(
        &self,
        intent: &fullmag_session::FmsRunIntent,
        receipt: LiveComputeRequestReceipt,
        released_study: bool,
        response: &mut Option<CommandResponse>,
    ) -> Result<(), ApiError> {
        receipt.validate().map_err(store_error)?;
        if receipt.key_sha256 != self.key_sha256 {
            return Ok(());
        }
        if receipt.request_sha256 != self.request_sha256 {
            return Err(ApiError::conflict_with_code(
                "live_compute_idempotency_conflict",
                "This Compute key has already been used for a different request in this session.",
            ));
        }
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
    let live = intent.specification.pointer("/parameters/live_workspace");
    let direct_command = live.and_then(|live| {
        let command = live.get("command")?;
        let kind = command.get("kind")?.as_str()?;
        let id = command.get("command_id")?.as_str()?;
        (matches!(kind, "solve" | "run" | "relax")
            && live.get("command_id").and_then(serde_json::Value::as_str) == Some(id))
            .then_some(command)
    });
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
        let Some(grant) = store.read_accepted_run_start_release(&intent.run_id).map_err(store_error)? else {
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
