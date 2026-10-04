//! Private, owner-authenticated acquisition transport for development launches.
//! A disconnected or cancelled connection releases acquisition through RAII.

use std::{net::Ipv4Addr, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
    time::timeout,
};

use crate::{
    router_v2::handlers::platform::{
        development_backend::DevelopmentBackendConfig,
        development_restart::{acquire_workspace_for_restart, RestartableWorkspace},
    },
    types::AppState,
};

const CONTROL_SCHEMA: &str = "fullmag.development-api-control.v1";
const CONFIRM_SCHEMA: &str = "fullmag.development-api-confirm.v1";
const MAX_REQUEST_BYTES: usize = 4096;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const ACQUISITION_TIMEOUT: Duration = Duration::from_secs(5);
const HOLD_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) struct PreparedOwnerControl {
    state: Arc<AppState>,
    listener: TcpListener,
    owner_token: String,
    storage_root: PathBuf,
    relative_ready: String,
}

/// Validate and bind before the HTTP listener is opened. Ordinary launches
/// without an owner token do not create a listener or filesystem record.
pub(crate) fn prepare(state: Arc<AppState>) -> Result<Option<PreparedOwnerControl>> {
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
    Ok(Some(PreparedOwnerControl {
        state,
        listener: TcpListener::from_std(listener)?,
        owner_token,
        storage_root: root,
        relative_ready,
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
            Ok(request) if self.authenticated(&request) && request.command == Command::Acquire => {
                request
            }
            _ => return reject(stream).await,
        };
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
                Ok(control) if self.authenticated(&control) && control.nonce == request.nonce => {
                    control
                }
                _ => {
                    drop(acquisition);
                    return reject(stream).await;
                }
            };
            match control.command {
                Command::Confirm => {
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
            }
        }
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
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Command {
    Acquire,
    Confirm,
    Abort,
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
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
