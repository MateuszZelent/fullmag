//! Private owner-authenticated client for a managed native development API.
//!
//! The held acquisition owns the private control connection. Dropping it
//! disconnects and releases the API's restart guard.

use std::{
    env, fs,
    io::{Read, Write},
    net::{Shutdown, SocketAddr, SocketAddrV4, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use fullmag_session::runtime_service::{RuntimeServiceConfig, RuntimeServiceOwnerDescriptor};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const OWNER_SCHEMA: &str = "fullmag.development-api-owner.v1";
const CANDIDATE_OWNER_REQUEST_SCHEMA: &str = "fullmag.development-candidate-owner-request.v1";
const ACQUISITION_SCHEMA: &str = "fullmag.development-authoring-acquisition.v1";
const CONFIRM_SCHEMA: &str = "fullmag.development-api-confirm.v1";
const ABORT_SCHEMA: &str = "fullmag.development-api-abort.v1";
const CONTROL_SCHEMA: &str = "fullmag.development-api-control.v1";
const MAX_OWNER_RECORD_BYTES: usize = 8 * 1024;
const MAX_REQUEST_BYTES: usize = 4 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const OWNER_PUBLICATION_TIMEOUT: Duration = Duration::from_secs(2);
const CONTROL_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const CONTROL_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
// The API may spend five seconds acquiring its workspace, then up to two
// seconds writing its bounded response.
const ACQUISITION_RESPONSE_TIMEOUT: Duration = Duration::from_secs(7);
const CONFIRM_RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);
const ABORT_RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);
const STAGE_HELPER_TIMEOUT: Duration = Duration::from_secs(20);
const NATIVE_DEV_PROFILE: &str = "windows-native-fdm-cpu-dev";
const NATIVE_RELEASE_PROFILE: &str = "windows-native-fdm-cpu";
const STAGE_REQUEST_SCHEMA: &str = "fullmag.development-acquisition-stage-request.v1";
const STAGE_ACK_SCHEMA: &str = "fullmag.development-acquisition-handoff.v1";
const MAX_STAGE_REQUEST_BYTES: usize = 128 * 1024 * 1024;
const MAX_STAGE_OUTPUT_BYTES: usize = 16 * 1024;
const MAX_CANDIDATE_OWNER_REQUEST_BYTES: usize = 16 * 1024;
const BACKEND_ENV_KEYS: [&str; 4] = [
    "FULLMAG_DEVELOPMENT_BACKEND_GENERATION",
    "FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE",
    "FULLMAG_DEVELOPMENT_BACKEND_SOURCE",
    "FULLMAG_DEVELOPMENT_BACKEND_VERSION",
];

/// The launcher's validated authority for one managed native development API.
/// This type deliberately does not implement `Debug` because it holds a token.
pub(crate) struct OwnerLaunch {
    service_configured: bool,
    storage_root: PathBuf,
    worktree: String,
    generation: String,
    source: String,
    version: String,
    expected_build_commit: String,
    expected_build_snapshot: String,
    owner_token: String,
}

impl OwnerLaunch {
    /// Create owner credentials only for the managed Windows native dev
    /// launcher. Script-driven workspaces and other launch modes need no owner.
    pub(crate) fn from_environment(dev_mode: bool, has_script: bool) -> Result<Option<Self>> {
        if !cfg!(windows) || !dev_mode || has_script {
            return Ok(None);
        }

        let active = env::var_os("FULLMAG_NATIVE_RUNTIME_ACTIVE");
        let profile = env::var_os("FULLMAG_STORAGE_PROFILE");
        let active_claims_native = active.as_deref() == Some(std::ffi::OsStr::new("1"));
        let profile_claims_native =
            profile.as_deref() == Some(std::ffi::OsStr::new(NATIVE_DEV_PROFILE));
        if profile.as_deref() == Some(std::ffi::OsStr::new(NATIVE_RELEASE_PROFILE)) {
            return Ok(None);
        }
        if !profile_claims_native {
            if active_claims_native && profile.is_none() {
                bail!("incomplete development API owner configuration");
            }
            return Ok(None);
        }
        if !active_claims_native {
            bail!("invalid development API owner configuration");
        }

        let mut backend_values = Vec::with_capacity(BACKEND_ENV_KEYS.len());
        for key in BACKEND_ENV_KEYS {
            let value = env::var_os(key)
                .ok_or_else(|| anyhow::anyhow!("incomplete development API owner configuration"))?
                .into_string()
                .map_err(|_| anyhow::anyhow!("invalid development API owner configuration"))?;
            backend_values.push(value);
        }
        let [generation, status_file, source, version] = backend_values.as_slice() else {
            bail!("invalid development API owner configuration");
        };

        let storage_root = required_environment_path("FULLMAG_PROJECT_STORAGE_ROOT")?;
        let worktree = required_environment_value("FULLMAG_WORKTREE_ID")?;
        let storage_root = validate_launch_configuration(
            generation,
            status_file,
            source,
            version,
            storage_root,
            &worktree,
        )?;
        let build = fullmag_build_info::identity();

        Ok(Some(Self {
            service_configured: env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG").is_some(),
            storage_root,
            worktree,
            generation: generation.clone(),
            source: source.clone(),
            version: version.clone(),
            expected_build_commit: build.git_commit.to_owned(),
            expected_build_snapshot: build.source_snapshot_sha256.to_owned(),
            owner_token: uuid::Uuid::new_v4().simple().to_string(),
        }))
    }

    /// Create owner credentials for the isolated native completion probe.
    /// Ordinary launch paths continue to use a freshly generated token.
    pub(crate) fn from_probe_environment() -> Result<Self> {
        if env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE").as_deref() != Ok("1") {
            bail!("development API probe is not enabled");
        }
        let mut launch = Self::from_environment(true, false)?
            .context("managed native development API probe is unavailable")?;
        let token = required_environment_value("FULLMAG_DEVELOPMENT_OWNER_PROBE_TOKEN")?;
        if !lower_hex(&token, 32) {
            bail!("invalid development API probe token");
        }
        launch.owner_token = token;
        Ok(launch)
    }

    /// Create a fresh owner identity for a bundle validated by the managed
    /// candidate helper. The bundle's compiled identity is kept separate from
    /// the current launcher identity used by ordinary owner confirmation.
    pub(crate) fn for_candidate(
        &self,
        repo_root: &Path,
        candidate_bundle_id: &str,
        candidate_manifest_sha256: &str,
    ) -> Result<(Self, u32)> {
        if self.service_configured {
            bail!("candidate owner confirmation requires a cold development API");
        }
        if !lower_hex(candidate_bundle_id, 32) || !lower_hex(candidate_manifest_sha256, 64) {
            bail!("candidate owner pins are invalid");
        }

        let repo_root = validated_directory_root(repo_root, "candidate owner repository")?;
        let helper = checked_regular_file(
            &repo_root,
            "scripts/windows/validate_candidate_owner.py",
            "candidate owner validation helper",
        )?;
        let candidate_relative = format!(
            "runtimes/{}/native-bundles/{candidate_bundle_id}",
            self.worktree
        );
        let candidate_bundle_root =
            fullmag_session::repository_path::checked_path(&self.storage_root, &candidate_relative)
                .context("invalid candidate bundle root")?;
        validate_absolute_path_chain_no_reparse(&candidate_bundle_root, "candidate bundle root")?;
        validated_directory_root(&candidate_bundle_root, "candidate bundle root")?;
        let candidate_bundle_root = candidate_bundle_root
            .to_str()
            .context("candidate bundle root is not valid UTF-8")?;
        let storage_root = self
            .storage_root
            .to_str()
            .context("managed storage root is not valid UTF-8")?;

        let python_relative = format!(
            "builds/{}/windows-native-fdm-cpu-dev/python/fullmag/Scripts/python.exe",
            self.worktree
        );
        let python =
            fullmag_session::repository_path::checked_path(&self.storage_root, &python_relative)
                .context("invalid managed development Python path")?;
        if !python.is_absolute() {
            bail!("managed development Python path must be absolute");
        }
        let configured_python = env::var_os("FULLMAG_PYTHON")
            .map(PathBuf::from)
            .context("managed development Python is not configured")?;
        validate_absolute_path_chain_no_reparse(
            &configured_python,
            "configured managed development Python",
        )?;
        validate_regular_file_no_reparse(
            &configured_python,
            "configured managed development Python",
        )?;
        let canonical_python =
            fs::canonicalize(&python).context("unable to resolve managed development Python")?;
        let canonical_configured_python = fs::canonicalize(&configured_python)
            .context("unable to resolve configured managed development Python")?;
        if canonical_configured_python != canonical_python {
            bail!("FULLMAG_PYTHON does not identify the managed development Python");
        }
        validate_regular_file_no_reparse(&python, "managed development Python")?;

        let request = CandidateOwnerRequest {
            schema: CANDIDATE_OWNER_REQUEST_SCHEMA,
            storage_root,
            worktree_id: &self.worktree,
            candidate_bundle_root,
            candidate_manifest_sha256,
        };
        let request_bytes = serde_json::to_vec(&request)
            .context("unable to encode candidate owner validation request")?;
        if request_bytes.len() > MAX_CANDIDATE_OWNER_REQUEST_BYTES {
            bail!("candidate owner validation request exceeds its limit");
        }
        let (ack_bytes, helper_pid, exit_status) =
            run_stage_helper(&python, &helper, &repo_root, request_bytes)?;
        if !exit_status.success() {
            bail!("candidate owner validation helper failed");
        }
        let acknowledgement: CandidateOwnerAcknowledgement = serde_json::from_slice(&ack_bytes)
            .context("invalid candidate owner validation acknowledgement")?;
        if acknowledgement.schema != "fullmag.development-candidate-owner-ack.v1"
            || acknowledgement.worktree_id != self.worktree
            || acknowledgement.candidate_bundle_id != candidate_bundle_id
            || acknowledgement.candidate_manifest_sha256 != candidate_manifest_sha256
            || !lower_hex(&acknowledgement.git_commit, 40)
            || !lower_hex(&acknowledgement.source_snapshot_sha256, 64)
            || !lower_hex(&acknowledgement.backend_source_sha256, 64)
            || acknowledgement.product_version.is_empty()
            || acknowledgement.product_version.len() > 128
            || !acknowledgement
                .product_version
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
        {
            bail!("candidate owner validation acknowledgement does not match the request");
        }
        let acknowledged_storage = PathBuf::from(&acknowledgement.storage_root);
        validate_absolute_path_chain_no_reparse(
            &acknowledged_storage,
            "candidate owner storage root acknowledgement",
        )?;
        if fs::canonicalize(&acknowledged_storage)? != fs::canonicalize(&self.storage_root)? {
            bail!("candidate owner validation storage root differs from managed storage");
        }

        Ok((
            Self {
                service_configured: false,
                storage_root: self.storage_root.clone(),
                worktree: self.worktree.clone(),
                generation: self.generation.clone(),
                source: acknowledgement.backend_source_sha256,
                version: acknowledgement.product_version,
                expected_build_commit: acknowledgement.git_commit,
                expected_build_snapshot: acknowledgement.source_snapshot_sha256,
                owner_token: uuid::Uuid::new_v4().simple().to_string(),
            },
            helper_pid,
        ))
    }

    /// Probe-only candidate owner factory. The helper validation remains the
    /// same as production; only the token is replaced for the isolated fixture.
    pub(crate) fn from_probe_environment_for_candidate(
        repo_root: &Path,
        candidate_bundle_id: &str,
        candidate_manifest_sha256: &str,
    ) -> Result<(Self, u32)> {
        if env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE").as_deref() != Ok("1") {
            bail!("development API probe is not enabled");
        }
        let base = Self::from_environment(true, false)?
            .context("managed native development API probe is unavailable")?;
        let (mut launch, helper_pid) =
            base.for_candidate(repo_root, candidate_bundle_id, candidate_manifest_sha256)?;
        let token = required_environment_value("FULLMAG_DEVELOPMENT_OWNER_PROBE_TOKEN")?;
        if !lower_hex(&token, 32) {
            bail!("invalid development API probe token");
        }
        launch.owner_token = token;
        Ok((launch, helper_pid))
    }

    /// Return the secret for explicit injection into the owned API child only.
    pub(crate) fn token(&self) -> &str {
        &self.owner_token
    }

    /// Confirm the record published by the exact child and HTTP listener.
    /// Missing records are retried briefly because the API binds HTTP before
    /// publishing its private control listener; every other error is final.
    pub(crate) fn confirm(
        &self,
        child_pid: u32,
        api_port: u16,
        api_instance_id: &str,
    ) -> Result<OwnedDevelopmentApi> {
        if child_pid == 0 || api_port == 0 || !canonical_uuid(api_instance_id) {
            bail!("invalid development API owner confirmation identity");
        }

        let relative = format!(
            "runtimes/{}/development-api-owner-{api_instance_id}.json",
            self.worktree
        );
        fullmag_session::repository_path::validate_relative_path(&relative)
            .context("invalid development API owner record path")?;
        let deadline = Instant::now() + OWNER_PUBLICATION_TIMEOUT;
        let bytes = loop {
            let path =
                fullmag_session::repository_path::checked_path(&self.storage_root, &relative)
                    .context("invalid development API owner record path")?;
            match fs::symlink_metadata(&path) {
                Ok(_) => {
                    break fullmag_session::repository_path::read_bounded_regular_file(
                        &self.storage_root,
                        &relative,
                        MAX_OWNER_RECORD_BYTES,
                    )
                    .context("unable to read development API owner record")?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        bail!("development API owner record was not published in time");
                    }
                    thread::sleep(remaining.min(Duration::from_millis(25)));
                }
                Err(_) => bail!("unable to inspect development API owner record"),
            }
        };

        let record: OwnerRecord =
            serde_json::from_slice(&bytes).context("invalid development API owner record")?;
        if record.schema != OWNER_SCHEMA
            || record.api_instance_id != api_instance_id
            || record.pid != child_pid
            || record.api_port != api_port
            || record.owner_token_sha256 != fullmag_session::hex_sha256(self.owner_token.as_bytes())
        {
            bail!("development API owner record does not match the launched child");
        }

        if !lower_hex(&self.expected_build_commit, 40)
            || !lower_hex(&self.expected_build_snapshot, 64)
            || record.build_commit != self.expected_build_commit
            || record.build_snapshot != self.expected_build_snapshot
        {
            bail!("development API owner record does not match the expected API build identity");
        }

        let address: SocketAddr = record
            .control_address
            .parse()
            .context("invalid development API owner control address")?;
        let SocketAddr::V4(address) = address else {
            bail!("development API owner control address must be IPv4");
        };
        if !address.ip().is_loopback() || address.port() == 0 {
            bail!("development API owner control address is not a valid loopback endpoint");
        }

        Ok(OwnedDevelopmentApi {
            service_configured: self.service_configured,
            control_address: address,
            api_port,
            api_instance_id: record.api_instance_id,
            storage_root: self.storage_root.clone(),
            worktree: self.worktree.clone(),
            generation: self.generation.clone(),
            source: self.source.clone(),
            version: self.version.clone(),
            owner_token: self.owner_token.clone(),
        })
    }
}

/// A confirmed owner endpoint. It carries credentials privately and has no
/// public HTTP-control or process-management operations.
pub(crate) struct OwnedDevelopmentApi {
    service_configured: bool,
    control_address: SocketAddrV4,
    api_port: u16,
    api_instance_id: String,
    storage_root: PathBuf,
    worktree: String,
    generation: String,
    source: String,
    version: String,
    owner_token: String,
}

impl OwnedDevelopmentApi {
    /// Acquire the API's stable authoring snapshot over its private loopback
    /// channel. The returned value retains the connection until abort or drop.
    pub(crate) fn acquire(&self, nonce: &str) -> Result<AuthoringAcquisition> {
        if !canonical_uuid(nonce) {
            bail!("invalid development API acquisition nonce");
        }
        let mut stream = TcpStream::connect_timeout(
            &SocketAddr::V4(self.control_address),
            CONTROL_CONNECT_TIMEOUT,
        )
        .context("unable to connect to development API owner control")?;
        stream
            .set_nodelay(true)
            .context("unable to configure development API owner connection")?;

        let request = encode_control_request(
            &self.owner_token,
            &self.api_instance_id,
            nonce,
            ControlCommand::Acquire,
        )?;
        write_all_until(
            &mut stream,
            &request,
            CONTROL_REQUEST_TIMEOUT,
            "development API control request",
        )?;
        let response_bytes = read_line_until(
            &mut stream,
            ACQUISITION_RESPONSE_TIMEOUT,
            MAX_RESPONSE_BYTES,
            "development API acquisition response",
        )?;
        let response: AcquisitionResponse = serde_json::from_slice(&response_bytes)
            .context("invalid development API acquisition response")?;
        validate_acquisition_response(&response, nonce, &self.api_instance_id)?;
        let (workspace_state, session_id, session_epoch, scene_document_sha256) =
            match &response.workspace {
                WorkspaceResponse::NoSession { session_epoch } => (
                    "no_session",
                    None,
                    *session_epoch,
                    fullmag_session::canonical_json_sha256(&Value::Null),
                ),
                WorkspaceResponse::Session {
                    identity,
                    scene_sha256,
                    ..
                } => (
                    "session",
                    Some(identity.session_id.clone()),
                    identity.session_epoch,
                    scene_sha256.clone(),
                ),
            };
        let workspace = serde_json::to_value(&response.workspace)
            .context("unable to materialize development authoring snapshot")?;
        std::str::from_utf8(&response_bytes)
            .context("development API acquisition response is not UTF-8")?;

        Ok(AuthoringAcquisition {
            service_configured: self.service_configured,
            stream: Some(stream),
            commit_attempted: false,
            completion_attempted: false,
            owner_token: self.owner_token.clone(),
            api_port: self.api_port,
            api_instance_id: self.api_instance_id.clone(),
            nonce: nonce.to_owned(),
            workspace,
            acquisition_bytes: response_bytes,
            workspace_state,
            session_id,
            session_epoch,
            scene_document_sha256,
            storage_root: self.storage_root.clone(),
            worktree: self.worktree.clone(),
            generation: self.generation.clone(),
            source: self.source.clone(),
            version: self.version.clone(),
        })
    }
}

/// Owns both the captured snapshot and the private connection that holds the
/// API guard. Dropping this value disconnects and releases the guard.
pub(crate) struct AuthoringAcquisition {
    service_configured: bool,
    stream: Option<TcpStream>,
    commit_attempted: bool,
    completion_attempted: bool,
    owner_token: String,
    api_port: u16,
    api_instance_id: String,
    nonce: String,
    workspace: Value,
    acquisition_bytes: Vec<u8>,
    workspace_state: &'static str,
    session_id: Option<String>,
    session_epoch: u64,
    scene_document_sha256: String,
    storage_root: PathBuf,
    worktree: String,
    generation: String,
    source: String,
    version: String,
}

impl AuthoringAcquisition {
    /// Hidden native verifier only: submit a deliberately invalid commit to
    /// exercise API validation, rather than the launcher's earlier preflight.
    pub(crate) fn probe_rejected_cold_commit(
        mut self,
        staged: &StagedAuthoringHandoff,
        case: &str,
    ) -> Result<()> {
        if env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE").as_deref() != Ok("1")
            || staged.source_nonce != self.nonce
            || staged.source_api_instance_id != self.api_instance_id
        {
            bail!("invalid cold commit probe context");
        }
        let ack: StageAcknowledgement = serde_json::from_value(staged.acknowledgement.clone())?;
        let candidate_id = staged
            .candidate_bundle_root
            .file_name()
            .and_then(|value| value.to_str())
            .context("invalid probe candidate identity")?;
        let mut handoff = serde_json::json!({"handoff_id":ack.handoff.handoff_id,
            "snapshot_sha256":ack.handoff.snapshot_sha256,"target_build_id":ack.binding.target_build_id,
            "candidate_bundle_id":candidate_id,"candidate_manifest_sha256":staged.candidate_manifest_sha256});
        match case {
            "missing_fence" => {}
            "snapshot" => handoff["snapshot_sha256"] = Value::String("0".repeat(64)),
            "target" => handoff["target_build_id"] = Value::String("0".repeat(64)),
            "candidate" => handoff["candidate_bundle_id"] = Value::String("0".repeat(32)),
            "candidate_manifest" => {
                handoff["candidate_manifest_sha256"] = Value::String("0".repeat(64))
            }
            "handoff" => handoff["handoff_id"] = Value::String(uuid::Uuid::new_v4().to_string()),
            _ => bail!("unsupported cold commit probe case"),
        }
        let mut request = serde_json::to_vec(&serde_json::json!({
            "schema":CONTROL_SCHEMA,"owner_token":self.owner_token,"api_instance_id":self.api_instance_id,
            "nonce":self.nonce,"command":"commit_cold","handoff":handoff,
        }))?;
        if request.len() >= MAX_REQUEST_BYTES {
            bail!("cold commit probe exceeds limit");
        }
        request.push(b'\n');
        let mut stream = self
            .stream
            .take()
            .context("cold commit probe connection is unavailable")?;
        write_all_until(
            &mut stream,
            &request,
            CONTROL_REQUEST_TIMEOUT,
            "cold commit rejection probe",
        )?;
        let bytes = read_line_until(
            &mut stream,
            Duration::from_secs(20),
            MAX_REQUEST_BYTES,
            "cold commit rejection",
        )?;
        let result: Value = serde_json::from_slice(&bytes)?;
        if result
            != serde_json::json!({"schema":CONTROL_SCHEMA,"status":"rejected","reason":"development_owner_request_rejected"})
        {
            bail!("invalid cold commit was not rejected by the API");
        }
        Ok(())
    }

    /// One-shot private commit. A lost response is an unknown outcome; the
    /// borrowed durable idle proof is never released or retried by this method.
    pub(crate) fn commit_cold_handoff(
        &mut self,
        repo_root: &Path,
        staged: &StagedAuthoringHandoff,
        proof: &fullmag_runtime_control::development_cold_idle::ColdIdleProof,
    ) -> Result<CommittedColdHandoff> {
        match self.submit_cold_handoff_commit(repo_root, staged, proof, false) {
            Ok(ColdCommitSubmission::Acknowledged(committed)) => Ok(committed),
            Ok(ColdCommitSubmission::AcknowledgementDiscarded { .. }) => {
                self.invalidate_control_stream();
                bail!("production cold commit unexpectedly discarded its acknowledgement")
            }
            Err(error) => {
                self.invalidate_control_stream();
                Err(error)
            }
        }
    }

    /// Complete a committed cold handoff after the caller has waited for the
    /// exact old API process to exit. Errors leave the outcome unknown and the
    /// private connection closed; this request is never retried or aborted.
    pub(crate) fn complete_cold_handoff(
        &mut self,
        commit: &fullmag_session::store::DevelopmentHandoffCommit,
        commit_sha256: &str,
        candidate_bundle_id: &str,
        candidate_manifest_sha256: &str,
    ) -> Result<Value> {
        if self.completion_attempted {
            bail!("development API completion is already one-shot");
        }
        self.completion_attempted = true;
        let result = self.submit_cold_handoff_completion(
            commit,
            commit_sha256,
            candidate_bundle_id,
            candidate_manifest_sha256,
        );
        if result.is_err() {
            self.invalidate_control_stream();
        }
        result
    }

    fn submit_cold_handoff_completion(
        &mut self,
        commit: &fullmag_session::store::DevelopmentHandoffCommit,
        commit_sha256: &str,
        candidate_bundle_id: &str,
        candidate_manifest_sha256: &str,
    ) -> Result<Value> {
        if self.service_configured {
            bail!("cold handoff completion is unavailable with a configured runtime service");
        }
        commit
            .validate()
            .context("invalid committed development handoff")?;
        if !canonical_uuid(&self.api_instance_id)
            || !canonical_uuid(&self.nonce)
            || commit.api_instance_id == self.api_instance_id
        {
            bail!("development handoff completion API identities are invalid");
        }
        if !lower_hex(commit_sha256, 64)
            || !lower_hex(candidate_bundle_id, 32)
            || !lower_hex(candidate_manifest_sha256, 64)
        {
            bail!("development handoff completion pins are invalid");
        }
        if !lower_hex(&self.scene_document_sha256, 64) {
            bail!("replacement authoring scene digest is invalid");
        }
        match (self.workspace_state, self.session_id.as_deref()) {
            ("session", Some(session_id)) => {
                fullmag_session::repository_path::validate_store_id(session_id)
                    .context("replacement session identity is invalid")?;
                if self.session_epoch != 1 {
                    bail!("replacement session epoch is invalid");
                }
            }
            ("no_session", None) if self.session_epoch == 0 => {}
            _ => bail!("replacement authoring workspace identity is invalid"),
        }

        let request = CompletionControlRequest {
            schema: CONTROL_SCHEMA,
            owner_token: &self.owner_token,
            api_instance_id: &self.api_instance_id,
            nonce: &self.nonce,
            command: ControlCommand::CompleteCold,
            completion: ColdCompletionRequest {
                handoff_id: &commit.handoff_id,
                snapshot_sha256: &commit.snapshot_sha256,
                target_build_id: &commit.target_build_id,
                candidate_bundle_id,
                candidate_manifest_sha256,
                commit_sha256,
            },
        };
        let mut bytes = serde_json::to_vec(&request)
            .context("unable to encode development API completion request")?;
        if bytes.len() >= MAX_REQUEST_BYTES {
            bail!("development API completion request exceeds its limit");
        }
        bytes.push(b'\n');
        let mut stream = self
            .stream
            .take()
            .context("development API acquisition connection is unavailable")?;
        write_all_until(
            &mut stream,
            &bytes,
            CONTROL_REQUEST_TIMEOUT,
            "development API completion request",
        )
        .context("development API completion outcome is unknown after request transmission")?;
        let response_bytes = read_line_until(
            &mut stream,
            Duration::from_secs(30),
            MAX_REQUEST_BYTES,
            "development API completion outcome is unknown; do not retry",
        )
        .context("development API completion outcome is unknown")?;
        let acknowledgement: ColdCompletionAcknowledgement = serde_json::from_slice(
            &response_bytes,
        )
        .context("development API completion outcome is unknown: invalid acknowledgement")?;
        if acknowledgement.schema != "fullmag.development-api-completion.v1"
            || acknowledgement.nonce != self.nonce
            || acknowledgement.api_instance_id != self.api_instance_id
            || acknowledgement.old_api_instance_id != commit.api_instance_id
            || acknowledgement.handoff_id != commit.handoff_id
            || acknowledgement.snapshot_sha256 != commit.snapshot_sha256
            || acknowledgement.target_build_id != commit.target_build_id
            || acknowledgement.accepted_store_binding != commit.accepted_store_binding
            || acknowledgement.session_id != self.session_id
            || acknowledgement.session_epoch != self.session_epoch
            || acknowledgement.scene_document_sha256 != self.scene_document_sha256
            || !acknowledgement.admission_reopened
        {
            bail!("development API completion outcome is unknown: acknowledgement mismatch");
        }
        let _ = stream.shutdown(Shutdown::Both);
        serde_json::to_value(acknowledgement)
            .context("development API completion acknowledgement could not be returned")
    }

    /// Probe-only transport mode for exercising a real committed request whose
    /// acknowledgement is deliberately discarded. The durable store record,
    /// not a retry, resolves the outcome after the exact API process exits.
    pub(crate) fn commit_cold_handoff_lost_ack_probe(
        &mut self,
        repo_root: &Path,
        staged: &StagedAuthoringHandoff,
        proof: &fullmag_runtime_control::development_cold_idle::ColdIdleProof,
    ) -> Result<LostAckColdCommit> {
        if env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE").as_deref() != Ok("1")
            || env::var("FULLMAG_DEVELOPMENT_OWNER_PROBE_LOST_ACK").as_deref() != Ok("1")
        {
            bail!("lost-ack cold commit requires the managed owner probe")
        }
        match self.submit_cold_handoff_commit(repo_root, staged, proof, true) {
            Ok(ColdCommitSubmission::AcknowledgementDiscarded {
                readback_helper_pid,
            }) => Ok(LostAckColdCommit {
                readback_helper_pid,
            }),
            Ok(ColdCommitSubmission::Acknowledged(_)) => {
                self.invalidate_control_stream();
                bail!("lost-ack cold commit unexpectedly observed an acknowledgement")
            }
            Err(error) => {
                self.invalidate_control_stream();
                Err(error)
            }
        }
    }

    fn submit_cold_handoff_commit(
        &mut self,
        repo_root: &Path,
        staged: &StagedAuthoringHandoff,
        proof: &fullmag_runtime_control::development_cold_idle::ColdIdleProof,
        discard_acknowledgement: bool,
    ) -> Result<ColdCommitSubmission> {
        if self.commit_attempted {
            bail!("development API acquisition commit is already one-shot")
        }
        self.commit_attempted = true;
        if self.service_configured
            || proof.admission_fence.owner_token != self.owner_token
            || proof.admission_fence.nonce != self.nonce
        {
            bail!("cold commit proof does not belong to this acquisition");
        }
        proof.verify_for_api(self.api_port, &self.api_instance_id)?;
        let checked = self.revalidate_staged_handoff(repo_root, staged)?;
        let expected_binding = proof.verify_for_api(self.api_port, &self.api_instance_id)?;
        let ack: StageAcknowledgement = serde_json::from_value(checked.acknowledgement.clone())?;
        let candidate_id = checked
            .candidate_bundle_root
            .file_name()
            .and_then(|name| name.to_str())
            .context("candidate bundle identity is missing")?;
        if !lower_hex(candidate_id, 32) {
            bail!("candidate bundle identity is invalid");
        }
        let request = serde_json::json!({
            "schema":CONTROL_SCHEMA,"owner_token":self.owner_token,
            "api_instance_id":self.api_instance_id,"nonce":self.nonce,"command":"commit_cold",
            "handoff":{
                "handoff_id":ack.handoff.handoff_id,"snapshot_sha256":ack.handoff.snapshot_sha256,
                "target_build_id":ack.binding.target_build_id,"candidate_bundle_id":candidate_id,
                "candidate_manifest_sha256":checked.candidate_manifest_sha256,
            },
        });
        let mut bytes = serde_json::to_vec(&request)?;
        if bytes.len() >= MAX_REQUEST_BYTES {
            bail!("cold commit request exceeds its limit");
        }
        bytes.push(b'\n');
        let mut stream = self
            .stream
            .take()
            .context("development API acquisition is unavailable")?;
        write_all_until(
            &mut stream,
            &bytes,
            CONTROL_REQUEST_TIMEOUT,
            "development API commit request",
        )?;
        if discard_acknowledgement {
            stream
                .shutdown(Shutdown::Both)
                .context("unable to close the lost-ack commit connection")?;
            return Ok(ColdCommitSubmission::AcknowledgementDiscarded {
                readback_helper_pid: checked.helper_pid,
            });
        }
        let response = read_line_until(
            &mut stream,
            Duration::from_secs(20),
            MAX_REQUEST_BYTES,
            "development API commit acknowledgement; outcome must be reconciled on error",
        )?;
        let committed: CommitResponse = serde_json::from_slice(&response)
            .context("development commit outcome is unknown: invalid acknowledgement")?;
        if committed.schema != "fullmag.development-api-commit.v1"
            || committed.nonce != self.nonce
            || committed.api_instance_id != self.api_instance_id
            || committed.handoff_id != ack.handoff.handoff_id
            || committed.snapshot_sha256 != ack.handoff.snapshot_sha256
            || committed.target_build_id != ack.binding.target_build_id
            || committed.accepted_store_binding != expected_binding
        {
            bail!("development commit outcome is unknown: acknowledgement mismatch");
        }
        let _ = stream.shutdown(Shutdown::Both);
        Ok(ColdCommitSubmission::Acknowledged(CommittedColdHandoff {
            acknowledgement: serde_json::to_value(committed)?,
            readback_helper_pid: checked.helper_pid,
        }))
    }

    /// Reconcile one-shot acceptance only after the exact owned API child has
    /// exited successfully. This never releases the durable fence.
    pub(crate) fn reconcile_committed_handoff_after_exit(
        &self,
        terminal: &ExitStatus,
        store_root: &Path,
        staged: &StagedAuthoringHandoff,
        proof: &fullmag_runtime_control::development_cold_idle::ColdIdleProof,
        acknowledgement: Option<&Value>,
    ) -> Result<fullmag_session::store::DevelopmentHandoffCommit> {
        if !terminal.success() {
            bail!("owned development API did not exit successfully")
        }
        if !self.commit_attempted || self.stream.is_some() {
            bail!("cold handoff reconciliation requires the consumed acquisition")
        }
        if staged.source_nonce != self.nonce
            || staged.source_api_instance_id != self.api_instance_id
        {
            bail!("staged handoff does not belong to this API acquisition")
        }
        if proof.admission_fence.owner_token != self.owner_token
            || proof.admission_fence.nonce != self.nonce
        {
            bail!("durable idle fence does not belong to this API acquisition")
        }
        proof.verify_current()?;
        let staged_ack: StageAcknowledgement =
            serde_json::from_value(staged.acknowledgement.clone())?;
        validate_stage_acknowledgement(&staged_ack, self)?;
        let store = fullmag_session::SessionStore::open_existing(store_root.to_path_buf())?;
        let accepted = store
            .read_development_handoff_commit()?
            .context("committed handoff record is absent after API exit")?;
        let accepted_binding = fullmag_runtime_control::accepted_store::store_binding(store_root)
            .context("accepted-store binding is invalid after API exit")?;
        if accepted.api_instance_id != self.api_instance_id
            || accepted.acquisition_nonce != self.nonce
            || accepted.handoff_id != staged_ack.handoff.handoff_id
            || accepted.snapshot_sha256 != staged_ack.handoff.snapshot_sha256
            || accepted.target_build_id != staged_ack.binding.target_build_id
            || accepted.accepted_store_binding != accepted_binding
            || accepted.fence != proof.admission_fence
            || store.read_development_idle_fence()?.as_ref() != Some(&proof.admission_fence)
        {
            bail!("durable handoff acceptance does not match the staged acquisition")
        }
        if let Some(bytes) = acknowledgement {
            let response: CommitResponse = serde_json::from_value(bytes.clone())
                .context("observed commit acknowledgement is invalid")?;
            if response.schema != "fullmag.development-api-commit.v1"
                || response.nonce != self.nonce
                || response.api_instance_id != self.api_instance_id
                || response.handoff_id != accepted.handoff_id
                || response.snapshot_sha256 != accepted.snapshot_sha256
                || response.target_build_id != accepted.target_build_id
                || response.accepted_store_binding != accepted.accepted_store_binding
            {
                bail!("observed commit acknowledgement differs from durable acceptance")
            }
        }
        self.verify_staged_receipt_after_exit(&staged_ack)?;
        proof.verify_current()?;
        Ok(accepted)
    }

    fn verify_staged_receipt_after_exit(&self, staged: &StageAcknowledgement) -> Result<()> {
        let handoff_id = &staged.handoff.handoff_id;
        if !canonical_uuid(handoff_id) {
            bail!("staged handoff identity is invalid")
        }
        let snapshot_path = format!(
            "runtimes/{}/development-handoffs/{handoff_id}/snapshot.json",
            self.worktree
        );
        let receipt_path = format!(
            "runtimes/{}/development-handoffs/{handoff_id}/receipt.json",
            self.worktree
        );
        let snapshot_bytes = fullmag_session::repository_path::read_bounded_regular_file(
            &self.storage_root,
            &snapshot_path,
            MAX_RESPONSE_BYTES,
        )?;
        if fullmag_session::hex_sha256(&snapshot_bytes) != staged.handoff.snapshot_sha256 {
            bail!("staged handoff snapshot changed after API exit")
        }
        let snapshot: Value = serde_json::from_slice(&snapshot_bytes)
            .context("staged handoff snapshot is invalid after API exit")?;
        let expected_binding = serde_json::to_value(&staged.binding)?;
        let observed_binding = snapshot
            .get("binding")
            .context("staged handoff snapshot binding is missing")?;
        if snapshot.get("snapshot_id").and_then(Value::as_str) != Some(handoff_id)
            || observed_binding != &expected_binding
        {
            bail!("staged handoff snapshot pin changed after API exit")
        }
        let binding_sha256 = fullmag_session::canonical_json_sha256(observed_binding);
        let receipt_bytes = fullmag_session::repository_path::read_bounded_regular_file(
            &self.storage_root,
            &receipt_path,
            16 * 1024,
        )?;
        let receipt: HandoffReceipt = serde_json::from_slice(&receipt_bytes)
            .context("staged handoff receipt is invalid after API exit")?;
        if receipt.schema != "fullmag.development-authoring-handoff-receipt.v1"
            || receipt.snapshot_id != *handoff_id
            || receipt.snapshot_sha256 != staged.handoff.snapshot_sha256
            || receipt.binding_sha256 != binding_sha256
            || receipt.state != "staged"
            || !receipt.recorded_at.ends_with('Z')
        {
            bail!("staged handoff receipt changed after API exit")
        }
        let mut receipt_value = serde_json::to_value(&receipt)?;
        let receipt_object = receipt_value
            .as_object_mut()
            .context("staged handoff receipt must be an object")?;
        receipt_object.remove("receipt_sha256");
        if fullmag_session::canonical_json_sha256(&receipt_value) != receipt.receipt_sha256 {
            bail!("staged handoff receipt digest is invalid after API exit")
        }
        Ok(())
    }

    pub(crate) fn workspace(&self) -> &Value {
        &self.workspace
    }

    /// Stage the acquired authoring snapshot without releasing its owner guard.
    /// The helper only receives the validated acquisition and scoped UI payload;
    /// owner credentials stay in this process and the same connection is
    /// confirmed only after a fully validated staging acknowledgement.
    pub(crate) fn stage_handoff(
        &mut self,
        repo_root: &Path,
        candidate_bundle_root: &Path,
        frontend_payload: &Value,
    ) -> Result<StagedAuthoringHandoff> {
        let result =
            self.stage_handoff_inner(repo_root, candidate_bundle_root, frontend_payload, None);
        if result.is_err() {
            self.invalidate_control_stream();
        }
        result
    }

    fn stage_handoff_inner(
        &mut self,
        repo_root: &Path,
        candidate_bundle_root: &Path,
        frontend_payload: &Value,
        staged_acknowledgement: Option<&Value>,
    ) -> Result<StagedAuthoringHandoff> {
        if self.stream.is_none() {
            bail!("development API acquisition connection is unavailable");
        }

        let candidate_manifest_sha256 = self.candidate_manifest_digest(candidate_bundle_root)?;

        let repo_root = validated_directory_root(repo_root, "development handoff repository")?;
        let helper = checked_regular_file(
            &repo_root,
            "scripts/windows/stage_acquisition_handoff.py",
            "development acquisition handoff helper",
        )?;
        let python_relative = format!(
            "builds/{}/windows-native-fdm-cpu-dev/python/fullmag/Scripts/python.exe",
            self.worktree
        );
        let python =
            fullmag_session::repository_path::checked_path(&self.storage_root, &python_relative)
                .context("invalid managed development Python path")?;
        if !python.is_absolute() {
            bail!("managed development Python path must be absolute");
        }
        let configured_python = env::var_os("FULLMAG_PYTHON")
            .map(PathBuf::from)
            .context("managed development Python is not configured")?;
        validate_absolute_path_chain_no_reparse(
            &configured_python,
            "configured managed development Python",
        )?;
        validate_regular_file_no_reparse(
            &configured_python,
            "configured managed development Python",
        )?;
        let canonical_python =
            fs::canonicalize(&python).context("unable to resolve managed development Python")?;
        let canonical_configured_python = fs::canonicalize(&configured_python)
            .context("unable to resolve configured managed development Python")?;
        if canonical_configured_python != canonical_python {
            bail!("FULLMAG_PYTHON does not identify the managed development Python");
        }
        validate_regular_file_no_reparse(&python, "managed development Python")?;

        if !candidate_bundle_root.is_absolute() {
            bail!("development candidate bundle path must be absolute");
        }
        let candidate_bundle_root = candidate_bundle_root
            .to_str()
            .context("development candidate bundle path is not valid UTF-8")?;
        let acquisition_json = std::str::from_utf8(&self.acquisition_bytes)
            .context("development API acquisition response is not UTF-8")?;
        let request = StageRequest {
            schema: if staged_acknowledgement.is_some() {
                "fullmag.development-acquisition-commit-check-request.v1"
            } else {
                STAGE_REQUEST_SCHEMA
            },
            acquisition_json: &acquisition_json,
            source_identity: StageSourceIdentity {
                api_instance_id: &self.api_instance_id,
                generation_id: &self.generation,
                source_build_id: &self.version,
                source_sha256: &self.source,
            },
            candidate_bundle_root,
            frontend_payload,
            staged_acknowledgement,
        };
        let request_bytes = serde_json::to_vec(&request)
            .context("unable to encode development acquisition staging request")?;
        if request_bytes.len() > MAX_STAGE_REQUEST_BYTES {
            bail!("development acquisition staging request exceeds its limit");
        }

        let (ack_bytes, helper_pid, exit_status) =
            run_stage_helper(&python, &helper, &repo_root, request_bytes)?;
        if !exit_status.success() {
            bail!("development acquisition handoff helper failed");
        }
        if self.candidate_manifest_digest(Path::new(candidate_bundle_root))?
            != candidate_manifest_sha256
        {
            bail!("sealed candidate manifest changed during handoff validation");
        }
        let acknowledgement: StageAcknowledgement = serde_json::from_slice(&ack_bytes)
            .context("invalid development acquisition handoff acknowledgement")?;
        validate_stage_acknowledgement(&acknowledgement, self).context(
            "development acquisition handoff acknowledgement does not match the acquisition",
        )?;

        self.confirm_held()
            .context("development API acquisition could not be confirmed after staging")?;

        Ok(StagedAuthoringHandoff {
            acknowledgement: serde_json::to_value(acknowledgement)
                .context("unable to materialize development handoff acknowledgement")?,
            helper_pid,
            source_nonce: self.nonce.clone(),
            source_api_instance_id: self.api_instance_id.clone(),
            candidate_bundle_root: PathBuf::from(candidate_bundle_root),
            frontend_payload: frontend_payload.clone(),
            candidate_manifest_sha256,
        })
    }

    fn candidate_manifest_digest(&self, candidate: &Path) -> Result<String> {
        let identity = candidate
            .file_name()
            .and_then(|value| value.to_str())
            .context("candidate bundle identity is missing")?;
        if !candidate.is_absolute() || !lower_hex(identity, 32) {
            bail!("candidate bundle identity is invalid");
        }
        let relative = format!("runtimes/{}/native-bundles/{identity}", self.worktree);
        let expected =
            fullmag_session::repository_path::checked_path(&self.storage_root, &relative)?;
        validate_absolute_path_chain_no_reparse(candidate, "candidate bundle")?;
        validated_directory_root(candidate, "candidate bundle")?;
        validated_directory_root(&expected, "owned candidate bundle")?;
        if fs::canonicalize(candidate)? != fs::canonicalize(&expected)? {
            bail!("candidate bundle belongs to another namespace");
        }
        let bytes = fullmag_session::repository_path::read_bounded_regular_file(
            &self.storage_root,
            &format!("{relative}/manifest.json"),
            256 * 1024,
        )?;
        Ok(fullmag_session::hex_sha256(&bytes))
    }

    /// Re-read the pending capsule and sealed candidate immediately before
    /// commit preparation. This never grants shutdown or releases an idle fence.
    pub(crate) fn revalidate_staged_handoff(
        &mut self,
        repo_root: &Path,
        staged: &StagedAuthoringHandoff,
    ) -> Result<StagedAuthoringHandoff> {
        let result = (|| {
            if staged.source_nonce != self.nonce
                || staged.source_api_instance_id != self.api_instance_id
            {
                bail!("staged handoff does not belong to this API acquisition");
            }
            self.confirm_held()?;
            if self.candidate_manifest_digest(&staged.candidate_bundle_root)?
                != staged.candidate_manifest_sha256
            {
                bail!("sealed candidate manifest changed after staging");
            }
            let checked = self.stage_handoff_inner(
                repo_root,
                &staged.candidate_bundle_root,
                &staged.frontend_payload,
                Some(&staged.acknowledgement),
            )?;
            if checked.candidate_manifest_sha256 != staged.candidate_manifest_sha256 {
                bail!("sealed candidate manifest changed during precommit readback");
            }
            Ok(checked)
        })();
        if result.is_err() {
            self.invalidate_control_stream();
        }
        result
    }

    /// Fence globally accepted work and drain the pinned resident service only
    /// after the staged handoff remains bound to this live API acquisition.
    pub(crate) fn drain_global_idle(
        &mut self,
        staged: &StagedAuthoringHandoff,
        expected: &RuntimeServiceOwnerDescriptor,
        config: &RuntimeServiceConfig,
        timeout_seconds: u64,
    ) -> Result<fullmag_runtime_control::runtime_service_client::IdleDrainProof> {
        let result = self.drain_global_idle_inner(staged, expected, config, timeout_seconds);
        if result.is_err() {
            self.invalidate_control_stream();
        }
        result
    }

    fn drain_global_idle_inner(
        &mut self,
        staged: &StagedAuthoringHandoff,
        expected: &RuntimeServiceOwnerDescriptor,
        config: &RuntimeServiceConfig,
        timeout_seconds: u64,
    ) -> Result<fullmag_runtime_control::runtime_service_client::IdleDrainProof> {
        if self.stream.is_none() {
            bail!("development API acquisition connection is unavailable");
        }
        if staged.source_nonce != self.nonce
            || staged.source_api_instance_id != self.api_instance_id
        {
            bail!("staged handoff does not belong to this API acquisition");
        }

        self.confirm_held()
            .context("development API acquisition could not be confirmed before idle drain")?;
        let proof = fullmag_runtime_control::runtime_service_client::drain_idle_for_api(
            self.api_port,
            &self.api_instance_id,
            expected,
            config,
            timeout_seconds,
        )?;
        self.confirm_held()
            .context("development API acquisition could not be confirmed after idle drain")?;
        Ok(proof)
    }

    /// Reserve an existing accepted store without a configured resident service.
    /// Unknown outcomes close this acquisition and retain any durable fence.
    pub(crate) fn acquire_cold_idle(
        &mut self,
        staged: &StagedAuthoringHandoff,
        store_root: &Path,
    ) -> Result<fullmag_runtime_control::development_cold_idle::ColdIdleProof> {
        let result = (|| {
            if self.stream.is_none() {
                bail!("development API acquisition connection is unavailable");
            }
            if staged.source_nonce != self.nonce
                || staged.source_api_instance_id != self.api_instance_id
            {
                bail!("staged handoff does not belong to this API acquisition");
            }
            if self.service_configured {
                bail!("configured runtime service cannot use the cold idle handoff");
            }
            self.confirm_held()
                .context("development API acquisition could not be confirmed before cold idle")?;
            let proof = fullmag_runtime_control::development_cold_idle::cold_idle_for_api(
                self.api_port,
                &self.api_instance_id,
                store_root,
                &self.owner_token,
                &self.nonce,
            )?;
            self.confirm_held()
                .context("development API acquisition could not be confirmed after cold idle")?;
            proof.verify_current()?;
            Ok(proof)
        })();
        if result.is_err() {
            self.invalidate_control_stream();
        }
        result
    }

    fn invalidate_control_stream(&mut self) {
        if let Some(stream) = self.stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    /// Confirm that the API still holds this acquisition without extending
    /// its absolute lifetime. Any uncertain exchange permanently closes it.
    pub(crate) fn confirm_held(&mut self) -> Result<()> {
        let mut stream = self
            .stream
            .take()
            .context("development API acquisition connection is unavailable")?;
        let result = (|| {
            let request = encode_control_request(
                &self.owner_token,
                &self.api_instance_id,
                &self.nonce,
                ControlCommand::Confirm,
            )?;
            write_all_until(
                &mut stream,
                &request,
                CONTROL_REQUEST_TIMEOUT,
                "development API confirmation request",
            )?;
            let response_bytes = read_line_until(
                &mut stream,
                CONFIRM_RESPONSE_TIMEOUT,
                MAX_REQUEST_BYTES,
                "development API confirmation acknowledgement",
            )?;
            let acknowledgement: ConfirmResponse = serde_json::from_slice(&response_bytes)
                .context("invalid development API confirmation acknowledgement")?;
            if acknowledgement.schema != CONFIRM_SCHEMA
                || acknowledgement.nonce != self.nonce
                || acknowledgement.api_instance_id != self.api_instance_id
            {
                bail!("development API confirmation acknowledgement does not match the request");
            }
            Ok(())
        })();
        if result.is_ok() {
            self.stream = Some(stream);
        } else {
            let _ = stream.shutdown(Shutdown::Both);
        }
        result
    }

    /// Explicitly release the API guard and verify its acknowledgement.
    pub(crate) fn abort(mut self) -> Result<()> {
        let request = encode_control_request(
            &self.owner_token,
            &self.api_instance_id,
            &self.nonce,
            ControlCommand::Abort,
        )?;
        let mut stream = self
            .stream
            .take()
            .context("development API acquisition connection is unavailable")?;
        write_all_until(
            &mut stream,
            &request,
            CONTROL_REQUEST_TIMEOUT,
            "development API abort request",
        )?;
        let response_bytes = read_line_until(
            &mut stream,
            ABORT_RESPONSE_TIMEOUT,
            MAX_REQUEST_BYTES,
            "development API abort acknowledgement",
        )?;
        let acknowledgement: AbortResponse = serde_json::from_slice(&response_bytes)
            .context("invalid development API abort acknowledgement")?;
        if acknowledgement.schema != ABORT_SCHEMA
            || acknowledgement.nonce != self.nonce
            || acknowledgement.api_instance_id != self.api_instance_id
        {
            bail!("development API abort acknowledgement does not match the request");
        }
        let _ = stream.shutdown(Shutdown::Both);
        Ok(())
    }
}

pub(crate) struct StagedAuthoringHandoff {
    pub(crate) acknowledgement: Value,
    pub(crate) helper_pid: u32,
    source_nonce: String,
    source_api_instance_id: String,
    candidate_bundle_root: PathBuf,
    frontend_payload: Value,
    candidate_manifest_sha256: String,
}

pub(crate) struct CommittedColdHandoff {
    pub(crate) acknowledgement: Value,
    pub(crate) readback_helper_pid: u32,
}

pub(crate) struct LostAckColdCommit {
    pub(crate) readback_helper_pid: u32,
}

enum ColdCommitSubmission {
    Acknowledged(CommittedColdHandoff),
    AcknowledgementDiscarded { readback_helper_pid: u32 },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CommitResponse {
    schema: String,
    nonce: String,
    api_instance_id: String,
    handoff_id: String,
    snapshot_sha256: String,
    target_build_id: String,
    accepted_store_binding: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ColdCompletionAcknowledgement {
    schema: String,
    nonce: String,
    api_instance_id: String,
    old_api_instance_id: String,
    handoff_id: String,
    snapshot_sha256: String,
    target_build_id: String,
    accepted_store_binding: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    session_id: Option<String>,
    session_epoch: u64,
    scene_document_sha256: String,
    admission_reopened: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct HandoffReceipt {
    schema: String,
    snapshot_id: String,
    snapshot_sha256: String,
    binding_sha256: String,
    state: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    detail: Option<String>,
    recorded_at: String,
    receipt_sha256: String,
}

#[derive(Serialize)]
struct StageRequest<'a> {
    schema: &'static str,
    acquisition_json: &'a str,
    source_identity: StageSourceIdentity<'a>,
    candidate_bundle_root: &'a str,
    frontend_payload: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    staged_acknowledgement: Option<&'a Value>,
}

#[derive(Serialize)]
struct StageSourceIdentity<'a> {
    api_instance_id: &'a str,
    generation_id: &'a str,
    source_build_id: &'a str,
    source_sha256: &'a str,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StageAcknowledgement {
    schema: String,
    acquisition_nonce: String,
    workspace_state: String,
    binding: StageBinding,
    handoff: StageHandoffReference,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StageBinding {
    api_instance_id: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    session_id: Option<String>,
    session_epoch: u64,
    generation_id: String,
    source_build_id: String,
    target_build_id: String,
    source_sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StageHandoffReference {
    handoff_id: String,
    snapshot_sha256: String,
    state: String,
}

enum StageHelperEvent {
    InputWritten(bool),
    OutputRead(std::result::Result<Vec<u8>, ()>),
}

fn validate_stage_acknowledgement(
    acknowledgement: &StageAcknowledgement,
    acquisition: &AuthoringAcquisition,
) -> Result<()> {
    let binding = &acknowledgement.binding;
    if acknowledgement.schema != STAGE_ACK_SCHEMA
        || acknowledgement.acquisition_nonce != acquisition.nonce
        || acknowledgement.workspace_state != acquisition.workspace_state
        || binding.api_instance_id != acquisition.api_instance_id
        || binding.session_id != acquisition.session_id
        || binding.session_epoch != acquisition.session_epoch
        || binding.generation_id != acquisition.generation
        || binding.source_build_id != acquisition.version
        || binding.source_sha256 != acquisition.source
        || !lower_hex(&binding.target_build_id, 64)
    {
        bail!("development acquisition staging acknowledgement binding is inconsistent");
    }
    if !canonical_uuid(&acknowledgement.handoff.handoff_id)
        || !lower_hex(&acknowledgement.handoff.snapshot_sha256, 64)
        || acknowledgement.handoff.state != "staged"
    {
        bail!("development acquisition staging acknowledgement is invalid");
    }
    Ok(())
}

fn validated_directory_root(path: &Path, operation: &str) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("{operation} path must be absolute");
    }
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("unable to inspect {operation}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        bail!("{operation} must be a regular trusted directory");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            bail!("{operation} must not be a reparse point");
        }
    }
    Ok(path.to_path_buf())
}

fn checked_regular_file(root: &Path, relative: &str, operation: &str) -> Result<PathBuf> {
    let path = fullmag_session::repository_path::checked_path(root, relative)
        .with_context(|| format!("invalid {operation} path"))?;
    if !path.is_absolute() {
        bail!("{operation} path must be absolute");
    }
    validate_regular_file_no_reparse(&path, operation)?;
    Ok(path)
}

fn validate_regular_file_no_reparse(path: &Path, operation: &str) -> Result<()> {
    let metadata =
        fs::symlink_metadata(path).with_context(|| format!("unable to inspect {operation}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        bail!("{operation} must be a regular file");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            bail!("{operation} must not be a reparse point");
        }
    }
    Ok(())
}

fn validate_absolute_path_chain_no_reparse(path: &Path, operation: &str) -> Result<()> {
    use std::path::Component;

    if !path.is_absolute() {
        bail!("{operation} path must be absolute");
    }
    let components: Vec<_> = path.components().collect();
    let normal_count = components
        .iter()
        .filter(|component| matches!(component, Component::Normal(_)))
        .count();
    if normal_count == 0 {
        bail!("{operation} path does not identify a file");
    }

    let mut current = PathBuf::new();
    let mut normal_index = 0;
    for component in components {
        match component {
            Component::Prefix(prefix) => current.push(prefix.as_os_str()),
            Component::RootDir => {
                current.push(component.as_os_str());
                validate_path_component_no_reparse(&current, true, operation)?;
            }
            Component::CurDir | Component::ParentDir => {
                bail!("{operation} path contains a traversal component");
            }
            Component::Normal(name) => {
                current.push(name);
                normal_index += 1;
                validate_path_component_no_reparse(
                    &current,
                    normal_index < normal_count,
                    operation,
                )?;
            }
        }
    }
    Ok(())
}

fn validate_path_component_no_reparse(path: &Path, directory: bool, operation: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("unable to inspect {operation} path component"))?;
    if metadata.file_type().is_symlink() {
        bail!("{operation} path contains a symbolic link");
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            bail!("{operation} path contains a reparse point");
        }
    }
    if directory && !metadata.is_dir() {
        bail!("{operation} path parent is not a directory");
    }
    Ok(())
}

fn run_stage_helper(
    python: &Path,
    helper: &Path,
    repo_root: &Path,
    request: Vec<u8>,
) -> Result<(Vec<u8>, u32, ExitStatus)> {
    let deadline = Instant::now() + STAGE_HELPER_TIMEOUT;
    let mut command = Command::new(python);
    command
        .arg("-B")
        .arg(helper)
        .arg("--repo-root")
        .arg(repo_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_remove("FULLMAG_DEVELOPMENT_OWNER_TOKEN")
        .env_remove("FULLMAG_DEVELOPMENT_OWNER_PROBE_TOKEN");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .context("unable to start managed development acquisition helper")?;
    let helper_pid = child.id();
    if helper_pid == 0 {
        let _ = kill_and_wait(&mut child);
        bail!("development acquisition helper has an invalid process identity");
    }
    let Some(stdin) = child.stdin.take() else {
        let _ = kill_and_wait(&mut child);
        bail!("development acquisition helper stdin is unavailable");
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = kill_and_wait(&mut child);
        bail!("development acquisition helper stdout is unavailable");
    };

    let (sender, receiver) = mpsc::channel();
    let input_sender = sender.clone();
    let writer = match thread::Builder::new()
        .name("development-handoff-stdin".to_owned())
        .spawn(move || {
            let mut stdin = stdin;
            let written = stdin.write_all(&request).is_ok();
            let _ = input_sender.send(StageHelperEvent::InputWritten(written));
        }) {
        Ok(writer) => writer,
        Err(_) => {
            kill_and_wait(&mut child)?;
            bail!("unable to start development acquisition helper input transport");
        }
    };

    let output_sender = sender.clone();
    let reader = match thread::Builder::new()
        .name("development-handoff-stdout".to_owned())
        .spawn(move || {
            let output = read_bounded_helper_output(stdout);
            let _ = output_sender.send(StageHelperEvent::OutputRead(output));
        }) {
        Ok(reader) => reader,
        Err(_) => {
            kill_and_wait(&mut child)?;
            writer.join().map_err(|_| {
                anyhow::anyhow!("development acquisition helper input transport panicked")
            })?;
            bail!("unable to start development acquisition helper output transport");
        }
    };
    drop(sender);

    let mut input_complete = None;
    let mut output = None;
    let mut failure = None;
    let mut observed_exit = None;
    loop {
        while let Ok(event) = receiver.try_recv() {
            if let Err(error) = record_stage_helper_event(event, &mut input_complete, &mut output) {
                failure = Some(error);
                break;
            }
        }
        if failure.is_some() {
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                observed_exit = Some(status);
                break;
            }
            Ok(None) => {}
            Err(_) => {
                failure = Some("unable to observe development acquisition helper");
                break;
            }
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            failure = Some("development acquisition helper timed out");
            break;
        }
        match receiver.recv_timeout(remaining.min(Duration::from_millis(20))) {
            Ok(event) => {
                if let Err(error) =
                    record_stage_helper_event(event, &mut input_complete, &mut output)
                {
                    failure = Some(error);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                if input_complete != Some(true) || output.is_none() {
                    failure = Some("development acquisition helper transports closed unexpectedly");
                } else {
                    thread::sleep(remaining.min(Duration::from_millis(10)));
                }
            }
        }
    }

    if failure.is_some() {
        let _ = child.kill();
    }
    // `try_wait` observes natural completion; otherwise this waits for the
    // exact helper after timeout or an I/O error before either thread is joined.
    let exit_status = child
        .wait()
        .context("unable to wait for development acquisition helper")?;
    let writer_join = writer.join();
    let reader_join = reader.join();
    if writer_join.is_err() || reader_join.is_err() {
        bail!("development acquisition helper transport panicked");
    }
    while let Ok(event) = receiver.try_recv() {
        if let Err(error) = record_stage_helper_event(event, &mut input_complete, &mut output) {
            failure = Some(error);
        }
    }
    if let Some(error) = failure {
        bail!("{error}");
    }
    if observed_exit.is_none() && !exit_status.success() {
        bail!("development acquisition handoff helper failed");
    }
    if input_complete != Some(true) {
        bail!("development acquisition helper did not receive the complete request");
    }
    let output = output.context("development acquisition helper returned no acknowledgement")?;
    Ok((output, helper_pid, exit_status))
}

fn read_bounded_helper_output(stdout: impl Read) -> std::result::Result<Vec<u8>, ()> {
    let mut output = Vec::new();
    stdout
        .take((MAX_STAGE_OUTPUT_BYTES + 1) as u64)
        .read_to_end(&mut output)
        .map_err(|_| ())?;
    if output.len() > MAX_STAGE_OUTPUT_BYTES {
        return Err(());
    }
    Ok(output)
}

fn record_stage_helper_event(
    event: StageHelperEvent,
    input_complete: &mut Option<bool>,
    output: &mut Option<Vec<u8>>,
) -> std::result::Result<(), &'static str> {
    match event {
        StageHelperEvent::InputWritten(written) => {
            if input_complete.replace(written).is_some() {
                return Err("development acquisition helper input completed more than once");
            }
            if !written {
                return Err("unable to send the complete development acquisition request");
            }
        }
        StageHelperEvent::OutputRead(Ok(bytes)) => {
            if output.replace(bytes).is_some() {
                return Err("development acquisition helper output completed more than once");
            }
        }
        StageHelperEvent::OutputRead(Err(())) => {
            return Err("development acquisition helper output failed or exceeded its limit");
        }
    }
    Ok(())
}

fn kill_and_wait(child: &mut Child) -> Result<ExitStatus> {
    match child.try_wait() {
        Ok(Some(_)) => {}
        Ok(None) | Err(_) => {
            let _ = child.kill();
        }
    }
    child
        .wait()
        .context("unable to wait for development acquisition helper")
}

impl Drop for AuthoringAcquisition {
    fn drop(&mut self) {
        if let Some(stream) = self.stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OwnerRecord {
    schema: String,
    api_instance_id: String,
    pid: u32,
    api_port: u16,
    control_address: String,
    owner_token_sha256: String,
    build_commit: String,
    build_snapshot: String,
}

#[derive(Serialize)]
struct CandidateOwnerRequest<'a> {
    schema: &'static str,
    storage_root: &'a str,
    worktree_id: &'a str,
    candidate_bundle_root: &'a str,
    candidate_manifest_sha256: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CandidateOwnerAcknowledgement {
    schema: String,
    storage_root: String,
    worktree_id: String,
    candidate_bundle_id: String,
    candidate_manifest_sha256: String,
    git_commit: String,
    source_snapshot_sha256: String,
    backend_source_sha256: String,
    product_version: String,
}

#[derive(Serialize)]
struct ControlRequest<'a> {
    schema: &'static str,
    owner_token: &'a str,
    api_instance_id: &'a str,
    nonce: &'a str,
    command: ControlCommand,
}

#[derive(Serialize)]
struct CompletionControlRequest<'a> {
    schema: &'static str,
    owner_token: &'a str,
    api_instance_id: &'a str,
    nonce: &'a str,
    command: ControlCommand,
    completion: ColdCompletionRequest<'a>,
}

#[derive(Serialize)]
struct ColdCompletionRequest<'a> {
    handoff_id: &'a str,
    snapshot_sha256: &'a str,
    target_build_id: &'a str,
    candidate_bundle_id: &'a str,
    candidate_manifest_sha256: &'a str,
    commit_sha256: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ControlCommand {
    Acquire,
    Confirm,
    Abort,
    CompleteCold,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AcquisitionResponse {
    schema: String,
    nonce: String,
    api_instance_id: String,
    workspace: WorkspaceResponse,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum WorkspaceResponse {
    NoSession {
        session_epoch: u64,
    },
    Session {
        identity: WorkspaceIdentity,
        scene_sha256: String,
        scene_document: Value,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WorkspaceIdentity {
    api_instance_id: String,
    session_id: String,
    #[serde(deserialize_with = "deserialize_present_option")]
    run_id: Option<String>,
    scene_id: String,
    session_epoch: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AbortResponse {
    schema: String,
    nonce: String,
    api_instance_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmResponse {
    schema: String,
    nonce: String,
    api_instance_id: String,
}

fn deserialize_present_option<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

fn validate_acquisition_response(
    response: &AcquisitionResponse,
    nonce: &str,
    api_instance_id: &str,
) -> Result<()> {
    if response.schema != ACQUISITION_SCHEMA
        || response.nonce != nonce
        || response.api_instance_id != api_instance_id
    {
        bail!("development API acquisition response does not match the request");
    }

    match &response.workspace {
        WorkspaceResponse::NoSession { .. } => {}
        WorkspaceResponse::Session {
            identity,
            scene_sha256,
            scene_document,
        } => {
            if identity.api_instance_id != api_instance_id
                || !canonical_uuid(&identity.api_instance_id)
                || identity.session_id.trim().is_empty()
                || identity.session_id.trim() != identity.session_id
                || identity.scene_id.trim().is_empty()
                || identity.scene_id.trim() != identity.scene_id
                || identity
                    .run_id
                    .as_deref()
                    .is_some_and(|run_id| run_id.trim().is_empty() || run_id.trim() != run_id)
            {
                bail!("development API authoring identity is inconsistent");
            }
            if fullmag_session::canonical_json_sha256(scene_document) != *scene_sha256 {
                bail!("development API authoring scene digest is invalid");
            }
            let scene_id = scene_document
                .get("scene")
                .and_then(|scene| scene.get("id"))
                .and_then(Value::as_str)
                .context("development API authoring scene identity is missing")?;
            if scene_id != identity.scene_id {
                bail!("development API authoring scene identity is inconsistent");
            }
        }
    }
    Ok(())
}

fn encode_control_request(
    owner_token: &str,
    api_instance_id: &str,
    nonce: &str,
    command: ControlCommand,
) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(&ControlRequest {
        schema: CONTROL_SCHEMA,
        owner_token,
        api_instance_id,
        nonce,
        command,
    })
    .context("unable to encode development API control request")?;
    if bytes.len() >= MAX_REQUEST_BYTES {
        bail!("development API control request exceeds its limit");
    }
    bytes.push(b'\n');
    Ok(bytes)
}

fn write_all_until(
    stream: &mut TcpStream,
    bytes: &[u8],
    budget: Duration,
    operation: &str,
) -> Result<()> {
    let deadline = Instant::now() + budget;
    let mut written = 0;
    while written < bytes.len() {
        let remaining = remaining_until(deadline, operation)?;
        stream
            .set_write_timeout(Some(remaining))
            .with_context(|| format!("unable to set {operation} deadline"))?;
        match stream.write(&bytes[written..]) {
            Ok(0) => bail!("{operation} failed because the connection closed"),
            Ok(count) => written += count,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) && Instant::now() < deadline =>
            {
                continue;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                bail!("{operation} timed out");
            }
            Err(_) => bail!("{operation} failed"),
        }
    }
    Ok(())
}

fn read_line_until(
    stream: &mut TcpStream,
    budget: Duration,
    maximum: usize,
    operation: &str,
) -> Result<Vec<u8>> {
    const CHUNK_BYTES: usize = 8 * 1024;
    let deadline = Instant::now() + budget;
    let mut line = Vec::new();
    let mut chunk = [0_u8; CHUNK_BYTES];
    loop {
        let capacity = maximum.saturating_sub(line.len()).saturating_add(1);
        if capacity == 0 {
            bail!("{operation} exceeds its limit");
        }
        let read_capacity = capacity.min(chunk.len());
        let remaining = remaining_until(deadline, operation)?;
        stream
            .set_read_timeout(Some(remaining))
            .with_context(|| format!("unable to set {operation} deadline"))?;
        let count = match stream.read(&mut chunk[..read_capacity]) {
            Ok(0) => bail!("{operation} connection closed before its delimiter"),
            Ok(count) => count,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) && Instant::now() < deadline =>
            {
                continue;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                bail!("{operation} timed out");
            }
            Err(_) => bail!("{operation} failed"),
        };

        if let Some(delimiter) = chunk[..count].iter().position(|byte| *byte == b'\n') {
            if line.len() + delimiter > maximum || chunk[delimiter + 1..count].len() != 0 {
                bail!("{operation} has an invalid frame boundary");
            }
            if line.contains(&b'\r') || chunk[..delimiter].contains(&b'\r') {
                bail!("{operation} contains an invalid frame delimiter");
            }
            line.extend_from_slice(&chunk[..delimiter]);
            return Ok(line);
        }

        if line.len() + count > maximum {
            bail!("{operation} exceeds its limit");
        }
        line.extend_from_slice(&chunk[..count]);
    }
}

fn remaining_until(deadline: Instant, operation: &str) -> Result<Duration> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        bail!("{operation} timed out");
    }
    Ok(remaining)
}

fn validate_launch_configuration(
    generation: &str,
    status_file: &str,
    source: &str,
    version: &str,
    configured_root: PathBuf,
    worktree: &str,
) -> Result<PathBuf> {
    if !lower_hex(generation, 32)
        || !lower_hex(source, 64)
        || version.is_empty()
        || version.len() > 128
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
        || worktree.is_empty()
        || worktree.len() > 80
    {
        bail!("invalid development API owner configuration");
    }
    fullmag_session::repository_path::validate_store_id(worktree)
        .context("invalid development API owner worktree")?;

    let storage_root =
        fullmag_runtime_control::accepted_store::writable_product_state_path(&configured_root)
            .context("invalid development API owner storage")?;
    let status_file = PathBuf::from(status_file);
    if !status_file.is_absolute() {
        bail!("invalid development API owner status path");
    }
    let parent = status_file
        .parent()
        .and_then(fullmag_runtime_control::accepted_store::writable_product_state_path)
        .context("invalid development API owner status path")?;
    let expected_parent = storage_root.join("builds").join(worktree);
    let profile = parent
        .strip_prefix(expected_parent)
        .context("invalid development API owner status path")?;
    if profile.components().count() != 1
        || status_file.file_name().and_then(|value| value.to_str())
            != Some("backend-watch-status.json")
    {
        bail!("invalid development API owner status path");
    }
    let relative = parent
        .join("backend-watch-status.json")
        .strip_prefix(&storage_root)
        .map(PathBuf::from)
        .context("invalid development API owner status path")?;
    let relative = relative
        .to_str()
        .context("invalid development API owner status path")?
        .replace('\\', "/");
    fullmag_session::repository_path::validate_relative_path(&relative)
        .context("invalid development API owner status path")?;
    Ok(storage_root)
}

fn required_environment_path(name: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(required_environment_value(name)?))
}

fn required_environment_value(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("missing or invalid {name}"))
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| !id.is_nil() && id.to_string() == value)
}
