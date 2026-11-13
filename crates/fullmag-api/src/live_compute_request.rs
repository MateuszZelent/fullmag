//! Request identity for HTTP Compute on the durable accepted lane.

use std::sync::Arc;

use fullmag_session::{LiveComputeRequestReceipt, SessionStore};
use serde_json::json;

use crate::error::{ApiError, TerminalComputeRejection};
use crate::router_v2::middleware::session_scope::ExpectedSessionScope;
use crate::schemas::commands::{
    CommandExecutionBinding, CommandResponse, RuntimeCommandRunPrecondition,
    RuntimeCommandTarget, StructuredCommandRequest,
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
    current_run_pin: Option<Option<String>>,
    scene_revision_pin: Option<u64>,
    explicit_scope: Option<ExpectedSessionScope>,
}

#[derive(Debug)]
pub(crate) enum ComputeReplayOutcome {
    NotApplicable,
    Accepted(CommandResponse),
    CompletedMiss,
}

impl LiveComputeRequest {
    pub(crate) fn capture(
        context: &CurrentLiveRequestContext,
        request: &StructuredCommandRequest,
        header_key: Option<&str>,
        request_id: Option<String>,
    ) -> Result<Option<Self>, ApiError> {
        Self::capture_with_request_scope(context, request, header_key, request_id, None)
    }

    pub(crate) fn capture_with_request_scope(
        context: &CurrentLiveRequestContext,
        request: &StructuredCommandRequest,
        header_key: Option<&str>,
        request_id: Option<String>,
        explicit_scope: Option<ExpectedSessionScope>,
    ) -> Result<Option<Self>, ApiError> {
        let (command_kind, intent) = match request {
            StructuredCommandRequest::Run { intent, .. } => ("run", intent),
            StructuredCommandRequest::Relax { intent, .. } => ("relax", intent),
            StructuredCommandRequest::Solve { intent } => ("solve", intent),
            _ => return Ok(None),
        };
        let client_intent = intent.client_intent_id.as_deref().filter(|key| !key.is_empty());
        let precondition = intent.precondition.as_ref();
        let current_run_pin = precondition.and_then(|precondition| {
            precondition.current_run.as_ref().map(|run| match run {
                RuntimeCommandRunPrecondition::None => None,
                RuntimeCommandRunPrecondition::Run { run_id } => Some(run_id.clone()),
            })
        });
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
            current_run_pin,
            scene_revision_pin: precondition.and_then(|precondition| precondition.scene_revision),
            explicit_scope,
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
    ) -> Result<ComputeReplayOutcome, ApiError> {
        if self.legacy_intent_key.is_none() {
            return Ok(ComputeReplayOutcome::NotApplicable);
        }
        let current = crate::capture_current_live_read_context(state).await?;
        if current.session_id != expected.session_id
            || current.session_epoch != expected.session_epoch
            || current.request_scope_epoch != expected.request_scope_epoch
        {
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
            return Ok(ComputeReplayOutcome::NotApplicable);
        };
        let request = self.clone();
        tokio::task::spawn_blocking(move || {
            match std::fs::symlink_metadata(&root) {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(ComputeReplayOutcome::NotApplicable)
                }
                Err(error) => return Err(store_error(error)),
            }
            let store = SessionStore::open_existing(root).map_err(store_error)?;
            Ok(match request.replay(&store, &current)? {
                Some(response) => ComputeReplayOutcome::Accepted(response),
                None => ComputeReplayOutcome::CompletedMiss,
            })
        })
        .await
        .map_err(store_error)?
    }

    /// Reconcile a failed admission while the caller holds the session transition fence.
    /// A marker is attached only after a completed exact receipt scan and a fresh owner/basis check.
    pub(crate) async fn reconcile_error_under_transition(
        &self,
        state: &Arc<AppState>,
        expected: &CurrentLiveRequestContext,
        error: &mut ApiError,
    ) -> Result<Option<CommandResponse>, ApiError> {
        match self.replay_under_transition(state, expected).await? {
            ComputeReplayOutcome::Accepted(response) => return Ok(Some(response)),
            ComputeReplayOutcome::NotApplicable => return Ok(None),
            ComputeReplayOutcome::CompletedMiss => {}
        }

        let rejection = error.terminal_compute_rejection.clone();
        if self
            .terminal_rejection_still_applies(state, expected, rejection.as_ref())
            .await?
        {
            error.mark_intent_not_accepted();
        }
        Ok(None)
    }

    async fn terminal_rejection_still_applies(
        &self,
        state: &Arc<AppState>,
        expected: &CurrentLiveRequestContext,
        rejection: Option<&TerminalComputeRejection>,
    ) -> Result<bool, ApiError> {
        let Some(explicit_scope) = self.explicit_scope.as_ref() else {
            return Ok(false);
        };
        let current = crate::capture_current_live_read_context(state).await?;
        if current.session_id != expected.session_id
            || current.session_epoch != expected.session_epoch
            || current.request_scope_epoch != expected.request_scope_epoch
        {
            return Ok(false);
        }
        let snapshot = state.current_live_state.read().await;
        let Some(snapshot) = snapshot.as_ref() else {
            return Ok(false);
        };
        crate::ensure_current_live_request_context(
            snapshot,
            &current,
            state
                .current_live_session_epoch
                .load(std::sync::atomic::Ordering::Acquire),
        )?;
        // The handler validates this optional transport scope before spawning
        // the command task. Recheck the same canonical browser scope while the
        // transition fence is held; accepted receipt replay does not depend on it.
        if crate::ensure_current_live_request_scope_for_expected(
            snapshot,
            &current.request_scope_epoch,
            explicit_scope,
        )
        .is_err()
        {
            return Ok(false);
        }

        // An immutable older scene pin cannot admit after a canonical edit,
        // even when another guard (for example mesh or material validation)
        // reports the first error. Preserve that error's status and message.
        if self.scene_revision_pin.is_some_and(|pin| {
            snapshot.scene_document.as_ref().is_some_and(|scene| scene.revision > pin)
        }) {
            return Ok(true);
        }
        let Some(rejection) = rejection else {
            return Ok(false);
        };

        match rejection {
            TerminalComputeRejection::CurrentRunMismatch { expected, observed } => {
                let actual = snapshot.run.as_ref().map(|run| run.run_id.as_str());
                let expected_matches_request = match self.current_run_pin.as_ref() {
                    Some(None) => expected.is_none(),
                    Some(Some(run_id)) => expected.as_deref() == Some(run_id.as_str()),
                    None => false,
                };
                let observed_matches_snapshot = observed.as_deref() == actual;
                Ok(expected_matches_request
                    && observed_matches_snapshot
                    && expected != observed)
            }
            TerminalComputeRejection::MissingSolveMaterial {
                cause: _,
                scene_revision,
                scene_sha256,
            } => {
                if *scene_revision == u64::MAX || self.scene_revision_pin != Some(*scene_revision) {
                    return Ok(false);
                }
                let Some(scene) = snapshot.scene_document.as_ref() else {
                    return Ok(false);
                };
                if scene.revision != *scene_revision {
                    return Ok(false);
                }
                Ok(scene_document_sha256(scene).as_deref() == Some(scene_sha256.as_str()))
            }
            TerminalComputeRejection::StaleSceneRevision { expected, observed } => {
                if *expected >= *observed || self.scene_revision_pin != Some(*expected) {
                    return Ok(false);
                }
                let Some(scene) = snapshot.scene_document.as_ref() else {
                    return Ok(false);
                };
                // Scene commits saturate at u64::MAX, so strict ordering is
                // the only safe pin proof; a future/MAX pin never reaches here.
                Ok(scene.revision >= *observed && scene.revision > *expected)
            }
        }
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

pub(crate) fn scene_document_sha256(scene: &fullmag_authoring::SceneDocument) -> Option<String> {
    let value = serde_json::to_value(scene).ok()?;
    Some(fullmag_session::canonical_json_sha256(&value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::router_v2::handlers::simulation::commands::validate_authoring_gate_for_command_with_context;
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
        keyed_solve_request(
            client_intent_id,
            json!({
                "scene_revision": 12,
                "mesh_revision": 0,
                "current_run": {"kind": "run", "run_id": current_run}
            }),
        )
    }

    fn keyed_solve_request(
        client_intent_id: Option<&str>,
        precondition: serde_json::Value,
    ) -> serde_json::Value {
        let mut body = json!({
            "kind": "solve",
            "target": {"kind": "study"},
            "precondition": precondition
        });
        if let Some(client_intent_id) = client_intent_id {
            body["client_intent_id"] = json!(client_intent_id);
        }
        body
    }

    fn configure_connected_runtime_service(store_root: &std::path::Path) {
        use std::{
            io::{BufRead, BufReader, Write},
            net::TcpListener,
            time::{Duration, Instant},
        };

        use fullmag_session::runtime_service::{
            RuntimeServiceChild, RuntimeServiceConfig, RuntimeServiceOwnerDescriptor,
            RuntimeServiceState, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
            RUNTIME_SERVICE_OWNER_PROTOCOL, RUNTIME_SERVICE_OWNER_SCHEMA,
        };

        let store_root = std::fs::canonicalize(store_root)
            .expect("accepted-store fixture root should be canonical");
        let runtime_services = store_root.join("runtime-services");
        std::fs::create_dir_all(&runtime_services)
            .expect("runtime-service fixture directory should be created");
        let budget = fullmag_session::FmsResourceBudget {
            cpu_millis: 1_000,
            memory_bytes: 1_024,
            gpu_memory_bytes: 0,
            storage_bytes: 1_024,
        };
        let config = RuntimeServiceConfig {
            schema_version: "runtime_service_config.v1".into(),
            store_root: store_root.clone(),
            target_id: "desktop".into(),
            compute_pool_id: "compute".into(),
            preparation_pool_id: "preparation".into(),
            compute_resources: vec![fullmag_session::FmsSchedulerResourceOffer {
                resource_id: "compute.cpu".into(),
                kind: fullmag_session::FmsResourceKind::Cpu,
                budget: budget.clone(),
            }],
            preparation_resources: vec![fullmag_session::FmsPreparationResourceOffer {
                resource_id: "preparation.cpu".into(),
                budget,
            }],
            worker_timeout_seconds: 10,
            preparation_timeout_seconds: 10,
            heartbeat_interval_milliseconds: 100,
            startup_timeout_seconds: 10,
            drain_timeout_seconds: 10,
            host_execution: None,
        };
        config.validate().expect("runtime-service fixture config is valid");
        let config_path = std::path::PathBuf::from(
            std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG")
                .expect("isolated child must have its own runtime config path"),
        );
        std::fs::write(
            &config_path,
            serde_json::to_vec(&config).expect("runtime-service config serializes"),
        )
        .expect("runtime-service config fixture should be written");

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .expect("loopback runtime-service fixture should bind");
        listener
            .set_nonblocking(true)
            .expect("runtime-service fixture listener should be nonblocking");
        let address = listener
            .local_addr()
            .expect("runtime-service fixture address should be available");
        let identity = fullmag_build_info::identity();
        let now = chrono::Utc::now();
        let owner = RuntimeServiceOwnerDescriptor {
            schema_version: RUNTIME_SERVICE_OWNER_SCHEMA.into(),
            owner_token: uuid::Uuid::new_v4().to_string(),
            process_start_token: uuid::Uuid::new_v4().to_string(),
            pid: 1,
            host: "http-regression-fixture".into(),
            target_id: config.target_id.clone(),
            protocol: RUNTIME_SERVICE_OWNER_PROTOCOL.into(),
            state: RuntimeServiceState::Ready,
            acquired_at: now,
            heartbeat_at: now,
            compute_pool_generation: Some(1),
            preparation_pool_generation: Some(1),
            control_address: Some(address.to_string()),
            build_commit: Some(identity.git_commit.into()),
            build_snapshot: Some(identity.source_snapshot_sha256.into()),
            compute_pool_id: Some(config.compute_pool_id.clone()),
            preparation_pool_id: Some(config.preparation_pool_id.clone()),
            children: vec![
                RuntimeServiceChild {
                    role: "compute".into(),
                    pid: 2,
                    status: "running".into(),
                },
                RuntimeServiceChild {
                    role: "preparation".into(),
                    pid: 3,
                    status: "running".into(),
                },
            ],
        };
        fullmag_session::runtime_service::validate_descriptor(&owner)
            .expect("runtime-service owner fixture is valid");
        std::fs::write(
            store_root.join(RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH),
            serde_json::to_vec(&owner).expect("runtime-service owner serializes"),
        )
        .expect("runtime-service owner fixture should be written");

        let response_owner = owner.clone();
        let response_config = config.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let (stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => return,
                }
            };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
            let mut stream = BufReader::new(stream);
            let mut request = String::new();
            if stream.read_line(&mut request).is_err() {
                return;
            }
            let Ok(request) = serde_json::from_str::<serde_json::Value>(&request) else {
                return;
            };
            let Some(nonce) = request.get("nonce").and_then(serde_json::Value::as_str) else {
                return;
            };
            let response = serde_json::json!({
                "schema_version": "runtime_service_status.v1",
                "nonce": nonce,
                "owner": response_owner,
                "configuration": response_config,
            });
            let mut stream = stream.into_inner();
            let _ = stream.write_all(response.to_string().as_bytes());
            let _ = stream.write_all(b"\n");
        });

        // The parent passes this child's private config path via Command::env;
        // fixture cases never mutate process-global environment variables.
    }

    async fn compute_http_test_state(
        submit_store_root: Option<std::path::PathBuf>,
        missing_solve_material: bool,
        connected_runtime_service: bool,
    ) -> Arc<AppState> {
        let mut state = crate::router_v2::tests::test_app_state_with_live_session().await;
        let state_mut = Arc::get_mut(&mut state).expect("test AppState must be uniquely owned");
        state_mut.submit_store_root = submit_store_root;
        state_mut
            .current_live_session_epoch
            .store(8, std::sync::atomic::Ordering::Release);
        if connected_runtime_service {
            configure_connected_runtime_service(
                state_mut.submit_store_root
                    .as_deref()
                    .expect("connected runtime fixture requires an accepted-store root"),
            );
        }

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

    async fn expected_scope_for_context(
        state: &Arc<AppState>,
        context: &CurrentLiveRequestContext,
    ) -> ExpectedSessionScope {
        let current = state.current_live_state.read().await;
        let snapshot = current.as_ref().expect("live session fixture");
        ExpectedSessionScope {
            session_id: context.session_id.clone(),
            session_epoch: crate::router_v2::handlers::sessions::current_live_session_epoch(snapshot),
            request_scope_epoch: context.request_scope_epoch.clone(),
        }
    }

    fn session_scope_header(scope: &ExpectedSessionScope) -> String {
        let encode = crate::router_v2::middleware::session_scope::encode_uri_component;
        format!(
            "session={}&epoch={}&request_scope_epoch={}",
            encode(&scope.session_id),
            encode(&scope.session_epoch),
            encode(&scope.request_scope_epoch),
        )
    }

    async fn current_session_scope_header(state: &Arc<AppState>) -> String {
        let context = crate::capture_current_live_request_context(state)
            .await
            .expect("current live request context");
        session_scope_header(&expected_scope_for_context(state, &context).await)
    }

    async fn post_compute_http(
        state: Arc<AppState>,
        body: serde_json::Value,
        idempotency_key: Option<&str>,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        post_compute_http_with_scope(state, body, idempotency_key, None).await
    }

    async fn post_compute_http_with_scope(
        state: Arc<AppState>,
        body: serde_json::Value,
        idempotency_key: Option<&str>,
        session_scope: Option<&str>,
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
        if let Some(session_scope) = session_scope {
            request = request.header("x-fullmag-session-scope", session_scope);
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
        let state = compute_http_test_state(Some(unkeyed_store_root), false, true).await;
        let scope = current_session_scope_header(&state).await;
        let (status, body) = post_compute_http_with_scope(
            state,
            stale_compute_request(None, "previous-run"),
            None,
            Some(&scope),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["code"], "command_current_run_changed");
        assert!(body.get("intent_disposition").is_none());

        // Without a configured store, an apparent replay miss is not a
        // completed owner-scoped durable scan and must stay unresolved.
        let state = compute_http_test_state(None, false, false).await;
        let scope = current_session_scope_header(&state).await;
        let (status, body) = post_compute_http_with_scope(
            state,
            stale_compute_request(Some("compute-intent"), "previous-run"),
            Some("compute-intent"),
            Some(&scope),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["code"], "session_connectivity_degraded");
        assert!(body.get("intent_disposition").is_none());

        let absent_dir = tempfile::tempdir().unwrap();
        let absent_store_root = absent_dir.path().join("not-created");
        let state = compute_http_test_state(Some(absent_store_root), false, false).await;
        let request_context = crate::capture_current_live_request_context(&state)
            .await
            .unwrap();
        let request: StructuredCommandRequest = serde_json::from_value(
            stale_compute_request(Some("compute-intent"), "previous-run"),
        )
        .unwrap();
        let explicit_scope = expected_scope_for_context(&state, &request_context).await;
        let request = LiveComputeRequest::capture_with_request_scope(
            &request_context,
            &request,
            Some("compute-intent"),
            None,
            Some(explicit_scope),
        )
        .unwrap()
        .unwrap();
        let _transition = state.current_live_session_transition.lock().await;
        assert!(matches!(
            request
                .replay_under_transition(&state, &request_context)
                .await
                .unwrap(),
            ComputeReplayOutcome::NotApplicable
        ));

        let mut missing_store_rejection = ApiError::conflict_with_code(
            "command_current_run_changed",
            "The current run changed after the command was requested.",
        )
        .with_terminal_compute_rejection(TerminalComputeRejection::CurrentRunMismatch {
            expected: Some("previous-run".into()),
            observed: None,
        });
        assert!(request
            .reconcile_error_under_transition(&state, &request_context, &mut missing_store_rejection)
            .await
            .unwrap()
            .is_none());
        assert!(missing_store_rejection.intent_disposition.is_none());

        let owner_dir = tempfile::tempdir().unwrap();
        let owner_store_root = owner_dir.path().join("submit-store");
        SessionStore::open(&owner_store_root).unwrap();
        let mut state = compute_http_test_state(Some(owner_store_root), false, false).await;
        let request_context = crate::capture_current_live_request_context(&state)
            .await
            .unwrap();
        let request: StructuredCommandRequest = serde_json::from_value(
            stale_compute_request(Some("compute-intent"), "previous-run"),
        )
        .unwrap();
        let explicit_scope = expected_scope_for_context(&state, &request_context).await;
        let request = LiveComputeRequest::capture_with_request_scope(
            &request_context,
            &request,
            Some("compute-intent"),
            None,
            Some(explicit_scope),
        )
        .unwrap()
        .unwrap();
        let mut error = ApiError::conflict_with_code(
            "command_current_run_changed",
            "The current run changed after the command was requested.",
        )
        .with_terminal_compute_rejection(TerminalComputeRejection::CurrentRunMismatch {
            expected: Some("previous-run".into()),
            observed: None,
        });
        Arc::get_mut(&mut state)
            .unwrap()
            .request_scope_instance_id = "replacement-instance".into();
        let _transition = state.current_live_session_transition.lock().await;
        let error = request
            .reconcile_error_under_transition(&state, &request_context, &mut error)
            .await
            .unwrap_err();
        assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(error.message, "request_context_stale");
        assert!(error.code.is_none());
        assert!(error.intent_disposition.is_none());

        // A restore can preserve logical session identity and scene revision
        // while the API process incarnation changes. The old request scope must
        // not establish a negative proof; a new current scope may prove the same
        // restored material basis after its own complete receipt scan.
        let restore_dir = tempfile::tempdir().unwrap();
        let restore_store_root = restore_dir.path().join("submit-store");
        SessionStore::open(&restore_store_root).unwrap();
        let mut restored_state =
            compute_http_test_state(Some(restore_store_root), true, false).await;
        let old_context = crate::capture_current_live_request_context(&restored_state)
            .await
            .unwrap();
        let old_scope = expected_scope_for_context(&restored_state, &old_context).await;
        let material_request: StructuredCommandRequest = serde_json::from_value(
            keyed_solve_request(
                Some("compute-intent"),
                json!({
                    "scene_revision": 12,
                    "mesh_revision": 0,
                    "current_run": {"kind": "none"}
                }),
            ),
        )
        .unwrap();
        let old_request = LiveComputeRequest::capture_with_request_scope(
            &old_context,
            &material_request,
            Some("compute-intent"),
            None,
            Some(old_scope),
        )
        .unwrap()
        .unwrap();
        let mut old_rejection = validate_authoring_gate_for_command_with_context(
            &restored_state,
            &material_request,
            Some(&old_context),
        )
        .await
        .expect_err("the same restored scene still has a missing solve material");
        {
            let snapshot = restored_state.current_live_state.read().await;
            let snapshot = snapshot.as_ref().unwrap();
            assert_eq!(snapshot.session.session_id, old_context.session_id);
            assert_eq!(old_context.session_epoch, 8);
            assert_eq!(
                restored_state
                    .current_live_session_epoch
                    .load(std::sync::atomic::Ordering::Acquire),
                8
            );
            assert_eq!(snapshot.scene_document.as_ref().unwrap().revision, 12);
        }
        Arc::get_mut(&mut restored_state)
            .unwrap()
            .request_scope_instance_id = "restored-api-instance".into();
        let _transition = restored_state.current_live_session_transition.lock().await;
        let stale_scope_error = old_request
            .reconcile_error_under_transition(
                &restored_state,
                &old_context,
                &mut old_rejection,
            )
            .await
            .unwrap_err();
        assert_eq!(stale_scope_error.status, axum::http::StatusCode::CONFLICT);
        assert_eq!(stale_scope_error.message, "request_context_stale");
        assert!(stale_scope_error.code.is_none());
        assert!(old_rejection.intent_disposition.is_none());
        drop(_transition);

        let current_context = crate::capture_current_live_request_context(&restored_state)
            .await
            .unwrap();
        let current_scope = expected_scope_for_context(&restored_state, &current_context).await;
        let current_request = LiveComputeRequest::capture_with_request_scope(
            &current_context,
            &material_request,
            Some("compute-intent"),
            None,
            Some(current_scope),
        )
        .unwrap()
        .unwrap();
        let mut current_rejection = validate_authoring_gate_for_command_with_context(
            &restored_state,
            &material_request,
            Some(&current_context),
        )
        .await
        .expect_err("the current scope must retain the material rejection");
        let _transition = restored_state.current_live_session_transition.lock().await;
        assert!(current_request
            .reconcile_error_under_transition(
                &restored_state,
                &current_context,
                &mut current_rejection,
            )
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            current_rejection.intent_disposition,
            Some(crate::schemas::common::IntentDisposition::NotAccepted)
        );
        drop(_transition);

        // Reusing the same finite revision for a different restored scene
        // basis cannot inherit the missing-material proof.
        let basis_context = crate::capture_current_live_request_context(&restored_state)
            .await
            .unwrap();
        let basis_scope = expected_scope_for_context(&restored_state, &basis_context).await;
        let basis_request = LiveComputeRequest::capture_with_request_scope(
            &basis_context,
            &material_request,
            Some("compute-intent"),
            None,
            Some(basis_scope),
        )
        .unwrap()
        .unwrap();
        let mut basis_rejection = validate_authoring_gate_for_command_with_context(
            &restored_state,
            &material_request,
            Some(&basis_context),
        )
        .await
        .expect_err("the authored material is still missing before the basis changes");
        {
            let mut current = restored_state.current_live_state.write().await;
            current
                .as_mut()
                .unwrap()
                .scene_document
                .as_mut()
                .unwrap()
                .objects[0]
                .name
                .push('x');
        }
        let _transition = restored_state.current_live_session_transition.lock().await;
        assert!(
            basis_request
                .reconcile_error_under_transition(
                    &restored_state,
                    &basis_context,
                    &mut basis_rejection,
                )
                .await
                .unwrap()
                .is_none()
        );
        assert!(basis_rejection.intent_disposition.is_none());

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
        let state = compute_http_test_state(Some(conflict_store_root), false, false).await;
        let scope = current_session_scope_header(&state).await;
        let (status, body) = post_compute_http_with_scope(
            state,
            stale_compute_request(Some("compute-intent"), "previous-run"),
            Some("compute-intent"),
            Some(&scope),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["code"], "live_compute_idempotency_conflict");
        assert!(body.get("intent_disposition").is_none());

        // A matching scene and mesh basis plus `current_run: none` isolates
        // the authored-material rejection from stale-run evidence.
        let material_dir = tempfile::tempdir().unwrap();
        let material_store_root = material_dir.path().join("submit-store");
        SessionStore::open(&material_store_root).unwrap();
        let state = compute_http_test_state(Some(material_store_root), true, true).await;
        let scope = current_session_scope_header(&state).await;
        let (status, body) = post_compute_http_with_scope(
            state,
            keyed_solve_request(
                Some("compute-intent"),
                json!({
                    "scene_revision": 12,
                    "mesh_revision": 0,
                    "current_run": {"kind": "none"}
                }),
            ),
            Some("compute-intent"),
            Some(&scope),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "bad_request");
        let material_disposition = body
            .get("intent_disposition")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);

        let headerless_dir = tempfile::tempdir().unwrap();
        let headerless_store_root = headerless_dir.path().join("submit-store");
        SessionStore::open(&headerless_store_root).unwrap();
        let state = compute_http_test_state(Some(headerless_store_root), true, true).await;
        let (status, body) = post_compute_http(
            state,
            keyed_solve_request(
                Some("compute-intent"),
                json!({
                    "scene_revision": 12,
                    "mesh_revision": 0,
                    "current_run": {"kind": "none"}
                }),
            ),
            Some("compute-intent"),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "bad_request");
        assert!(body.get("intent_disposition").is_none());

        // Missing, future, and saturated scene pins cannot establish that an
        // authored repair will leave this immutable request stale.
        for precondition in [
            json!({"mesh_revision": 0, "current_run": {"kind": "none"}}),
            json!({"scene_revision": 13, "mesh_revision": 0, "current_run": {"kind": "none"}}),
            json!({"scene_revision": u64::MAX, "mesh_revision": 0, "current_run": {"kind": "none"}}),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store_root = directory.path().join("submit-store");
            SessionStore::open(&store_root).unwrap();
            let state = compute_http_test_state(Some(store_root), true, true).await;
            let scope = current_session_scope_header(&state).await;
            let (status, body) = post_compute_http_with_scope(
                state,
                keyed_solve_request(Some("compute-intent"), precondition),
                Some("compute-intent"),
                Some(&scope),
            )
            .await;
            assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
            assert_eq!(body["code"], "bad_request");
            assert!(body.get("intent_disposition").is_none());
        }

        // This request reaches the locked stale-run precondition after its
        // second exact replay. It has the same intended disposition while
        // preserving its established conflict status and code.
        let empty_dir = tempfile::tempdir().unwrap();
        let empty_store_root = empty_dir.path().join("submit-store");
        SessionStore::open(&empty_store_root).unwrap();
        let state = compute_http_test_state(Some(empty_store_root), false, true).await;
        let scope = current_session_scope_header(&state).await;
        let (status, body) = post_compute_http_with_scope(
            state,
            stale_compute_request(Some("compute-intent"), "previous-run"),
            Some("compute-intent"),
            Some(&scope),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["code"], "command_current_run_changed");
        let stale_run_disposition = body
            .get("intent_disposition")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned);

        // A retry pinned to a strictly older finite scene revision is terminal
        // after a user edit, even when the current run still matches. The exact
        // scope and completed durable miss are required before publishing proof.
        let stale_scene_dir = tempfile::tempdir().unwrap();
        let stale_scene_store_root = stale_scene_dir.path().join("submit-store");
        SessionStore::open(&stale_scene_store_root).unwrap();
        let state = compute_http_test_state(Some(stale_scene_store_root), false, true).await;
        let scope = current_session_scope_header(&state).await;
        let (status, body) = post_compute_http_with_scope(
            state,
            keyed_solve_request(
                Some("compute-intent"),
                json!({
                    "scene_revision": 11,
                    "mesh_revision": 0,
                    "current_run": {"kind": "none"}
                }),
            ),
            Some("compute-intent"),
            Some(&scope),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["code"], "conflict");
        assert!(body["message"]
            .as_str()
            .is_some_and(|message| message.contains("scene_revision precondition failed")));
        assert_eq!(body["intent_disposition"], "not_accepted");

        // Reconciliation is independent of which untyped admission error
        // reached the final fence. Only an older immutable scene pin proves
        // rejection; equal, future, and saturated pins do not.
        for (scene_pin, expected_disposition) in [
            (11, Some(crate::error::IntentDisposition::NotAccepted)),
            (12, None),
            (13, None),
            (u64::MAX, None),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store_root = directory.path().join("submit-store");
            SessionStore::open(&store_root).unwrap();
            let state = compute_http_test_state(Some(store_root), false, false).await;
            let context = crate::capture_current_live_request_context(&state).await.unwrap();
            let scope = expected_scope_for_context(&state, &context).await;
            let command: StructuredCommandRequest = serde_json::from_value(keyed_solve_request(
                Some("compute-intent"),
                json!({
                    "scene_revision": scene_pin,
                    "mesh_revision": 999,
                    "current_run": {"kind": "none"}
                }),
            )).unwrap();
            let request = LiveComputeRequest::capture_with_request_scope(
                &context, &command, Some("compute-intent"), None, Some(scope),
            ).unwrap().unwrap();
            let message = "mesh_revision precondition failed: expected 999, got 0";
            let mut error = ApiError::conflict(message);
            let _transition = state.current_live_session_transition.lock().await;
            assert!(request.reconcile_error_under_transition(&state, &context, &mut error)
                .await.unwrap().is_none());
            assert_eq!(error.intent_disposition, expected_disposition);
            assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
            assert_eq!(error.message, message);
            assert!(error.code.is_none());
            assert!(error.terminal_compute_rejection.is_none());
        }

        // The HTTP path binds frozen spins before validating mesh pins, so a
        // jointly stale scene/mesh request preserves that first scene error.
        // Missing material can precede binding and must not hide the proof.
        for (missing_material, mesh_revision, expected_status, expected_code) in [
            (false, 999, axum::http::StatusCode::CONFLICT, "conflict"),
            (true, 0, axum::http::StatusCode::BAD_REQUEST, "bad_request"),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store_root = directory.path().join("submit-store");
            SessionStore::open(&store_root).unwrap();
            let state = compute_http_test_state(Some(store_root), missing_material, true).await;
            let scope = current_session_scope_header(&state).await;
            let (status, body) = post_compute_http_with_scope(
                state,
                keyed_solve_request(
                    Some("compute-intent"),
                    json!({
                        "scene_revision": 11,
                        "mesh_revision": mesh_revision,
                        "current_run": {"kind": "none"}
                    }),
                ),
                Some("compute-intent"),
                Some(&scope),
            )
            .await;
            assert_eq!(status, expected_status);
            assert_eq!(body["code"], expected_code);
            assert_eq!(body["intent_disposition"], "not_accepted");
            if !missing_material {
                assert_eq!(body["message"],
                    "scene_revision precondition failed while binding frozen spins: expected 11, got 12");
            }
        }

        // Future and saturated pins mismatch too, but cannot establish that
        // later authoring will leave an immutable request stale.
        for scene_revision in [13, u64::MAX] {
            let directory = tempfile::tempdir().unwrap();
            let store_root = directory.path().join("submit-store");
            SessionStore::open(&store_root).unwrap();
            let state = compute_http_test_state(Some(store_root), false, true).await;
            let scope = current_session_scope_header(&state).await;
            let (status, body) = post_compute_http_with_scope(
                state,
                keyed_solve_request(
                    Some("compute-intent"),
                    json!({
                        "scene_revision": scene_revision,
                        "mesh_revision": 0,
                        "current_run": {"kind": "none"}
                    }),
                ),
                Some("compute-intent"),
                Some(&scope),
            )
            .await;
            assert_eq!(status, axum::http::StatusCode::CONFLICT);
            assert_eq!(body["code"], "conflict");
            assert!(body.get("intent_disposition").is_none());
        }

        // Revision and domain identity pins are not terminal by themselves:
        // mesh revisions can wrap and domain fingerprints can recur.
        let mesh_dir = tempfile::tempdir().unwrap();
        let mesh_store_root = mesh_dir.path().join("submit-store");
        SessionStore::open(&mesh_store_root).unwrap();
        let state = compute_http_test_state(Some(mesh_store_root), false, true).await;
        state.current_live_state.write().await.as_mut().unwrap().mesh_revision = u64::MAX;
        let (status, body) = post_compute_http(
            state,
            keyed_solve_request(
                Some("compute-intent"),
                json!({"mesh_revision": 0, "current_run": {"kind": "none"}}),
            ),
            Some("compute-intent"),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert!(body.get("intent_disposition").is_none());

        let domain_dir = tempfile::tempdir().unwrap();
        let domain_store_root = domain_dir.path().join("submit-store");
        SessionStore::open(&domain_store_root).unwrap();
        let state = compute_http_test_state(Some(domain_store_root), false, true).await;
        let scope = current_session_scope_header(&state).await;
        let (status, body) = post_compute_http_with_scope(
            state,
            keyed_solve_request(
                Some("compute-intent"),
                json!({"domain_generation_id": "non-matching-generation", "current_run": {"kind": "none"}}),
            ),
            Some("compute-intent"),
            Some(&scope),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert!(body.get("intent_disposition").is_none());

        // The fixture's no-key, no-root, and body-conflict controls preserve
        // their existing contracts. Only the exact terminal keyed paths carry
        // a disposition.
        assert_eq!(
            [material_disposition, stale_run_disposition],
            [Some("not_accepted".into()), Some("not_accepted".into())],
        );
    }

    #[test]
    fn keyed_stale_compute_http_error_has_only_a_linearized_not_accepted_disposition() {
        let child_test_name =
            "live_compute_request::tests::keyed_stale_compute_http_error_has_only_a_linearized_not_accepted_disposition_child";
        let config_dir = tempfile::tempdir().expect("isolated runtime config directory");
        let status = std::process::Command::new(
            std::env::current_exe().expect("test harness executable is available"),
        )
        .args(["--ignored", "--exact", child_test_name, "--nocapture"])
        .env(
            "FULLMAG_RUNTIME_SERVICE_CONFIG",
            config_dir.path().join("APPLICATION.json"),
        )
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
