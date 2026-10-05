//! Private, owner-authenticated acquisition transport for development launches.
//! A disconnected or cancelled connection releases acquisition through RAII.

use std::{
    net::Ipv4Addr,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::oneshot,
    task::JoinHandle,
    time::timeout,
};

use crate::{
    router_v2::handlers::platform::{
        development_backend::{DevelopmentBackendConfig, DevelopmentBackendObservation},
        development_restart::{acquire_workspace_for_restart, RestartableWorkspace},
    },
    development_consumer_readiness::CandidateReadiness,
    types::AppState,
};

const CONTROL_SCHEMA: &str = "fullmag.development-api-control.v1";
const CONFIRM_SCHEMA: &str = "fullmag.development-api-confirm.v1";
const MAX_REQUEST_BYTES: usize = 4096;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const MAX_CONSUMER_RESPONSE_BYTES: usize = 2048;
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const ACQUISITION_TIMEOUT: Duration = Duration::from_secs(5);
const HOLD_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) struct PreparedOwnerControl {
    state: Arc<AppState>,
    listener: TcpListener,
    owner_token: String,
    storage_root: PathBuf,
    relative_ready: String,
    worktree_id: String,
    generation_id: String,
    runtime_service_config_absent: bool,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
}

/// Validate and bind before the HTTP listener is opened. Ordinary launches
/// without an owner token do not create a listener or filesystem record.
pub(crate) fn prepare(
    state: Arc<AppState>,
    shutdown: oneshot::Sender<()>,
) -> Result<Option<PreparedOwnerControl>> {
    let Some(token) = std::env::var_os("FULLMAG_DEVELOPMENT_OWNER_TOKEN") else {
        return Ok(None);
    };
    let owner_token = token
        .into_string()
        .map_err(|_| anyhow::anyhow!("invalid development owner configuration"))?;
    if owner_token.len() != 32
        || !owner_token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("invalid development owner configuration");
    }
    let DevelopmentBackendConfig::Managed {
        storage_root,
        worktree,
        generation,
        ..
    } = &state.development_backend
    else {
        bail!("development owner requires managed development configuration");
    };
    let root = fullmag_runtime_control::accepted_store::writable_product_state_path(storage_root)
        .filter(|root| root == storage_root)
        .context("invalid development owner storage")?;
    fullmag_session::repository_path::validate_store_id(worktree)?;
    if !canonical_uuid(&state.request_scope_instance_id) {
        bail!("invalid development API identity");
    }
    let relative_ready = format!(
        "runtimes/{worktree}/development-api-owner-{}.json",
        state.request_scope_instance_id
    );
    let ready = fullmag_session::repository_path::checked_path(&root, &relative_ready)?;
    if ready.try_exists()? {
        bail!("development API owner record already exists");
    }
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let worktree_id = worktree.clone();
    let generation_id = generation.clone();
    Ok(Some(PreparedOwnerControl {
        state,
        listener: TcpListener::from_std(listener)?,
        owner_token,
        storage_root: root,
        relative_ready,
        worktree_id,
        generation_id,
        runtime_service_config_absent: std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG").is_none(),
        shutdown: Mutex::new(Some(shutdown)),
    }))
}

impl PreparedOwnerControl {
    /// Publish only after the caller has successfully bound its HTTP listener.
    pub(crate) fn start(self, api_port: u16) -> Result<JoinHandle<()>> {
        if api_port == 0 {
            bail!("invalid development API port");
        }
        if fullmag_runtime_control::accepted_store::writable_product_state_path(&self.storage_root)
            .as_ref()
            != Some(&self.storage_root)
        {
            bail!("invalid development owner storage");
        }
        let build = fullmag_build_info::identity();
        let ready = json!({
            "schema": "fullmag.development-api-owner.v1",
            "api_instance_id": self.state.request_scope_instance_id,
            "pid": std::process::id(),
            "api_port": api_port,
            "control_address": self.listener.local_addr()?.to_string(),
            "owner_token_sha256": format!("{:x}", Sha256::digest(self.owner_token.as_bytes())),
            "build_commit": build.git_commit,
            "build_snapshot": build.source_snapshot_sha256,
        });
        fullmag_session::publish_managed_owner_record(
            &self.storage_root,
            &self.relative_ready,
            &serde_json::to_vec(&ready)?,
        )?;
        Ok(tokio::spawn(async move {
            loop {
                let Ok((mut stream, peer)) = self.listener.accept().await else {
                    break;
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                // Serial handling bounds outstanding acquisitions and ensures
                // aborting this task also drops every held workspace guard.
                let _ = timeout(HOLD_TIMEOUT, self.handle(&mut stream)).await;
            }
        }))
    }

    async fn handle(&self, stream: &mut TcpStream) -> Result<()> {
        let request = match read_request(stream, READ_TIMEOUT).await {
            Ok(request) if self.authenticated(&request) => request,
            _ => return reject(stream).await,
        };
        match request.command {
            Command::ConsumerStatus => return self.consumer_status(stream, request).await,
            Command::ConsumerReadiness => return self.consumer_readiness(stream, request).await,
            Command::Acquire => {}
            Command::Confirm
            | Command::Abort
            | Command::CommitCold
            | Command::CompleteCold => return reject(stream).await,
        }
        if request.handoff.is_some()
            || request.completion.is_some()
            || has_readiness_value(&request)
        {
            return reject(stream).await;
        }

        let started = Instant::now();
        let acquisition = match timeout(
            ACQUISITION_TIMEOUT,
            acquire_workspace_for_restart(&self.state),
        )
        .await
        {
            Ok(Ok(acquisition)) => acquisition,
            _ => return reject(stream).await,
        };
        let workspace = match &acquisition.workspace {
            RestartableWorkspace::NoSession { session_epoch, .. } => json!({
                "state": "no_session", "session_epoch": session_epoch,
            }),
            RestartableWorkspace::Session {
                identity,
                scene_document,
            } => {
                let scene = serde_json::to_value(scene_document)?;
                json!({
                    "state": "session",
                    "identity": {
                        "api_instance_id": identity.api_instance_id,
                        "session_id": identity.session_id,
                        "run_id": identity.run_id,
                        "scene_id": identity.scene_id,
                        "session_epoch": identity.session_epoch,
                    },
                    "scene_sha256": fullmag_session::canonical_json_sha256(&scene),
                    "scene_document": scene,
                })
            }
        };
        let response = json!({
            "schema": "fullmag.development-authoring-acquisition.v1",
            "nonce": request.nonce,
            "api_instance_id": self.state.request_scope_instance_id,
            "workspace": workspace,
        });
        let response = match encode_response(&response) {
            Ok(response) => response,
            Err(_) => {
                drop(acquisition);
                return reject(stream).await;
            }
        };
        write_bytes(stream, &response).await?;
        loop {
            let control = match read_request(stream, HOLD_TIMEOUT).await {
                Ok(control)
                    if self.authenticated(&control)
                        && control.nonce == request.nonce
                        && !has_readiness_value(&control) =>
                {
                    control
                }
                _ => {
                    drop(acquisition);
                    return reject(stream).await;
                }
            };
            match control.command {
                Command::Confirm => {
                    if control.handoff.is_some() || control.completion.is_some() {
                        drop(acquisition);
                        return reject(stream).await;
                    }
                    write_response(
                        stream,
                        &json!({
                            "schema": CONFIRM_SCHEMA,
                            "nonce": control.nonce,
                            "api_instance_id": self.state.request_scope_instance_id,
                        }),
                    )
                    .await?;
                }
                Command::Abort => {
                    if control.handoff.is_some() || control.completion.is_some() {
                        drop(acquisition);
                        return reject(stream).await;
                    }
                    drop(acquisition);
                    return write_response(
                        stream,
                        &json!({
                            "schema": "fullmag.development-api-abort.v1",
                            "nonce": control.nonce,
                            "api_instance_id": self.state.request_scope_instance_id,
                        }),
                    )
                    .await;
                }
                Command::Acquire => {
                    drop(acquisition);
                    return reject(stream).await;
                }
                Command::ConsumerStatus | Command::ConsumerReadiness => {
                    drop(acquisition);
                    return reject(stream).await;
                }
                Command::CommitCold => {
                    if control.completion.is_some() {
                        drop(acquisition);
                        return reject(stream).await;
                    }
                    let Some(handoff) = control.handoff else {
                        drop(acquisition);
                        return reject(stream).await;
                    };
                    let validated =
                        match crate::development_handoff_validation::validate_cold_commit(
                            &self.state,
                            &acquisition.workspace,
                            &control.nonce,
                            &self.owner_token,
                            &handoff,
                            started + HOLD_TIMEOUT,
                        ) {
                            Ok(validated) => validated,
                            Err(_) => {
                                drop(acquisition);
                                return reject(stream).await;
                            }
                        };
                    if started.elapsed() >= HOLD_TIMEOUT {
                        drop(acquisition);
                        return reject(stream).await;
                    }
                    // Close permanently before entering publication, and retain
                    // transition ownership across it. Errors, panic or task
                    // cancellation must not reopen an uncertain old workspace.
                    let _committed_transition = acquisition.retain_closed_admission();
                    let accepted = validated.store.accept_development_handoff(
                        &validated.fence,
                        &self.state.request_scope_instance_id,
                        &handoff.handoff_id,
                        &handoff.snapshot_sha256,
                        &handoff.target_build_id,
                        &validated.accepted_store_binding,
                    );
                    let Ok(record) = accepted else {
                        return reject(stream).await;
                    };
                    // Cancellation or a lost ACK must still signal shutdown once
                    // acceptance succeeded; it must never reopen the old workspace.
                    let _shutdown = ShutdownAfterCommit(&self.shutdown);
                    return write_response(stream, &json!({
                        "schema":"fullmag.development-api-commit.v1",
                        "nonce":control.nonce, "api_instance_id":self.state.request_scope_instance_id,
                        "handoff_id":record.handoff_id,"snapshot_sha256":record.snapshot_sha256,
                        "target_build_id":record.target_build_id,
                        "accepted_store_binding":record.accepted_store_binding,
                    })).await;
                }
                Command::CompleteCold => {
                    if control.handoff.is_some() {
                        drop(acquisition);
                        return reject(stream).await;
                    }
                    let Some(completion) = control.completion else {
                        drop(acquisition);
                        return reject(stream).await;
                    };
                    let validated =
                        match crate::development_handoff_validation::validate_cold_completion(
                            &self.state,
                            &acquisition.workspace,
                            &completion,
                            started + HOLD_TIMEOUT,
                        ) {
                            Ok(validated) => validated,
                            Err(_) => {
                                drop(acquisition);
                                return reject(stream).await;
                            }
                        };
                    if started.elapsed() >= HOLD_TIMEOUT {
                        drop(acquisition);
                        return reject(stream).await;
                    }

                    // Once armed, every error or cancellation preserves closed
                    // admission. Both workspace guards remain held until the
                    // store confirms completion or this request exits.
                    let acquisition = acquisition.retain_closed_for_completion();
                    let authorization =
                        match validated.store.prepare_development_handoff_completion(
                            &validated.commit,
                            &validated.replacement,
                        ) {
                            Ok(authorization) => authorization,
                            Err(_) => return reject(stream).await,
                        };
                    if started.elapsed() >= HOLD_TIMEOUT {
                        return reject(stream).await;
                    }
                    if validated
                        .store
                        .finish_development_handoff_completion(&authorization)
                        .is_err()
                    {
                        return reject(stream).await;
                    }

                    let response = json!({
                        "schema": "fullmag.development-api-completion.v1",
                        "nonce": control.nonce,
                        "api_instance_id": authorization.replacement.api_instance_id,
                        "old_api_instance_id": authorization.commit.api_instance_id,
                        "handoff_id": authorization.commit.handoff_id,
                        "snapshot_sha256": authorization.commit.snapshot_sha256,
                        "target_build_id": authorization.commit.target_build_id,
                        "accepted_store_binding": authorization.commit.accepted_store_binding,
                        "session_id": authorization.replacement.session_id,
                        "session_epoch": authorization.replacement.session_epoch,
                        "scene_document_sha256": authorization.replacement.scene_document_sha256,
                        "admission_reopened": true,
                    });
                    acquisition.reopen_after_confirmed_completion();
                    return write_response(stream, &response).await;
                }
            }
        }
    }

    async fn consumer_status(
        &self,
        stream: &mut TcpStream,
        request: ControlRequest,
    ) -> Result<()> {
        if request.handoff.is_some()
            || request.completion.is_some()
            || has_readiness_value(&request)
        {
            return reject(stream).await;
        }
        let observation = self.observe_backend().await.ok();
        let eligible = observation
            .as_ref()
            .and_then(|observation| self.eligible_candidate(observation));
        let valid_lease = match observation.as_ref() {
            Some(observation) => {
                self.state.development_consumer_readiness.is_ready(
                    observation,
                    &self.state.request_scope_instance_id,
                )
            }
            None => {
                self.state.development_consumer_readiness.revoke();
                false
            }
        };
        let confirmed = eligible.is_some() && valid_lease;
        self.write_consumer_status(stream, &request.nonce, eligible, confirmed)
            .await
    }

    async fn consumer_readiness(
        &self,
        stream: &mut TcpStream,
        request: ControlRequest,
    ) -> Result<()> {
        if request.handoff.is_some() || request.completion.is_some() {
            return reject(stream).await;
        }
        let Some(readiness) = request.readiness else {
            return reject(stream).await;
        };
        match readiness {
            None => {
                // Authorization is checked before this method; revoke remains available when
                // the watcher or the restart transport is not currently eligible.
                if !self.state.development_consumer_readiness.revoke() {
                    return reject(stream).await;
                }
                let observation = self.observe_backend().await.ok();
                let eligible = observation
                    .as_ref()
                    .and_then(|observation| self.eligible_candidate(observation));
                self.write_consumer_status(stream, &request.nonce, eligible, false)
                    .await
            }
            Some(readiness) => {
                let Some(observation) = self.observe_backend().await.ok() else {
                    return reject(stream).await;
                };
                if self.eligible_candidate(&observation).is_none()
                    || !self.state.development_consumer_readiness.renew(
                        &readiness,
                        &observation,
                        &self.state.request_scope_instance_id,
                    )
                {
                    return reject(stream).await;
                }
                let eligible = self.eligible_candidate(&observation);
                let confirmed = eligible.is_some()
                    && self.state.development_consumer_readiness.is_ready(
                        &observation,
                        &self.state.request_scope_instance_id,
                    );
                if !confirmed {
                    return reject(stream).await;
                }
                self.write_consumer_status(stream, &request.nonce, eligible, true)
                    .await
            }
        }
    }

    async fn observe_backend(&self) -> Result<DevelopmentBackendObservation> {
        let config = self.state.development_backend.clone();
        tokio::task::spawn_blocking(move || config.observe_for_consumer(unix_time_ms()))
            .await
            .context("development consumer observation task failed")
    }

    fn eligible_candidate(
        &self,
        observation: &DevelopmentBackendObservation,
    ) -> Option<EligibleCandidate> {
        if !self.runtime_service_config_absent
            || !self.state.development_restart_transport.is_configured()
            || observation.generation_id.as_deref() != Some(self.generation_id.as_str())
            || observation.worktree_id.as_deref() != Some(self.worktree_id.as_str())
        {
            return None;
        }
        let resource = &observation.resource;
        if !resource.configured
            || resource.state
                != crate::schemas::development_backend::DevelopmentBackendState::Ready
        {
            return None;
        }
        let (Some(current), Some(ready)) = (&resource.current_build, &resource.ready_build) else {
            return None;
        };
        if current.source_sha256 == ready.source_sha256 {
            return None;
        }
        Some(EligibleCandidate {
            ready_build_id: ready.id.clone(),
            ready_source_sha256: ready.source_sha256.clone(),
        })
    }

    async fn write_consumer_status(
        &self,
        stream: &mut TcpStream,
        nonce: &str,
        candidate: Option<EligibleCandidate>,
        readiness_confirmed: bool,
    ) -> Result<()> {
        let response = ConsumerReadinessResponse {
            schema: "fullmag.development-consumer-readiness.v1",
            nonce,
            api_instance_id: &self.state.request_scope_instance_id,
            worktree_id: Some(&self.worktree_id),
            generation_id: Some(&self.generation_id),
            ready_build_id: candidate.as_ref().map(|candidate| candidate.ready_build_id.as_str()),
            ready_source_sha256: candidate
                .as_ref()
                .map(|candidate| candidate.ready_source_sha256.as_str()),
            readiness_confirmed,
        };
        let mut bytes = serde_json::to_vec(&response)?;
        if bytes.len() >= MAX_CONSUMER_RESPONSE_BYTES {
            return reject(stream).await;
        }
        bytes.push(b'\n');
        write_bytes(stream, &bytes).await
    }

    fn authenticated(&self, request: &ControlRequest) -> bool {
        request.schema == CONTROL_SCHEMA
            && token_matches(&request.owner_token, &self.owner_token)
            && request.api_instance_id == self.state.request_scope_instance_id
            && canonical_uuid(&request.nonce)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlRequest {
    schema: String,
    owner_token: String,
    api_instance_id: String,
    nonce: String,
    command: Command,
    #[serde(default)]
    handoff: Option<crate::development_handoff_validation::ColdCommitRequest>,
    #[serde(default)]
    completion: Option<crate::development_handoff_validation::ColdCompletionRequest>,
    #[serde(default, deserialize_with = "deserialize_readiness")]
    readiness: Option<Option<CandidateReadiness>>,
}

#[derive(Serialize)]
struct ConsumerReadinessResponse<'a> {
    schema: &'static str,
    nonce: &'a str,
    api_instance_id: &'a str,
    worktree_id: Option<&'a str>,
    generation_id: Option<&'a str>,
    ready_build_id: Option<&'a str>,
    ready_source_sha256: Option<&'a str>,
    readiness_confirmed: bool,
}

#[derive(Debug)]
struct EligibleCandidate {
    ready_build_id: String,
    ready_source_sha256: String,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Command {
    Acquire,
    Confirm,
    Abort,
    CommitCold,
    CompleteCold,
    ConsumerStatus,
    ConsumerReadiness,
}

struct ShutdownAfterCommit<'a>(&'a Mutex<Option<oneshot::Sender<()>>>);

impl Drop for ShutdownAfterCommit<'_> {
    fn drop(&mut self) {
        let mut shutdown = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(sender) = shutdown.take() {
            let _ = sender.send(());
        }
    }
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}

fn has_readiness_value(request: &ControlRequest) -> bool {
    request
        .readiness
        .as_ref()
        .is_some_and(Option::is_some)
}

fn deserialize_readiness<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<Option<CandidateReadiness>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<CandidateReadiness>::deserialize(deserializer).map(Some)
}

fn unix_time_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn token_matches(candidate: &str, expected: &str) -> bool {
    candidate.len() == expected.len()
        && candidate
            .bytes()
            .zip(expected.bytes())
            .fold(0, |difference, (left, right)| difference | (left ^ right))
            == 0
}

async fn read_request(stream: &mut TcpStream, budget: Duration) -> Result<ControlRequest> {
    timeout(budget, async {
        let mut line = Vec::with_capacity(512);
        loop {
            let byte = stream.read_u8().await?;
            if byte == b'\n' {
                break;
            }
            if line.len() >= MAX_REQUEST_BYTES {
                bail!("request exceeds limit");
            }
            line.push(byte);
        }
        Ok(serde_json::from_slice(&line)?)
    })
    .await
    .context("request timeout")?
}

async fn write_response(stream: &mut TcpStream, value: &Value) -> Result<()> {
    write_bytes(stream, &encode_response(value)?).await
}

fn encode_response(value: &Value) -> Result<Vec<u8>> {
    struct BoundedResponse(Vec<u8>);
    impl std::io::Write for BoundedResponse {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if bytes.len() >= MAX_RESPONSE_BYTES.saturating_sub(self.0.len()) {
                return Err(std::io::Error::other("response exceeds limit"));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut output = BoundedResponse(Vec::new());
    serde_json::to_writer(&mut output, value)?;
    output.0.push(b'\n');
    Ok(output.0)
}

async fn write_bytes(stream: &mut TcpStream, bytes: &[u8]) -> Result<()> {
    timeout(READ_TIMEOUT, stream.write_all(bytes))
        .await
        .context("response timeout")??;
    Ok(())
}

async fn reject(stream: &mut TcpStream) -> Result<()> {
    write_response(
        stream,
        &json!({
            "schema": "fullmag.development-api-control.v1",
            "status": "rejected",
            "reason": "development_owner_request_rejected",
        }),
    )
    .await
}
