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
use serde::{Deserialize, Serialize};
use serde_json::Value;

const OWNER_SCHEMA: &str = "fullmag.development-api-owner.v1";
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
const BACKEND_ENV_KEYS: [&str; 4] = [
    "FULLMAG_DEVELOPMENT_BACKEND_GENERATION",
    "FULLMAG_DEVELOPMENT_BACKEND_STATUS_FILE",
    "FULLMAG_DEVELOPMENT_BACKEND_SOURCE",
    "FULLMAG_DEVELOPMENT_BACKEND_VERSION",
];

/// The launcher's validated authority for one managed native development API.
/// This type deliberately does not implement `Debug` because it holds a token.
pub(crate) struct OwnerLaunch {
    storage_root: PathBuf,
    worktree: String,
    generation: String,
    source: String,
    version: String,
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

        Ok(Some(Self {
            storage_root,
            worktree,
            generation: generation.clone(),
            source: source.clone(),
            version: version.clone(),
            owner_token: uuid::Uuid::new_v4().simple().to_string(),
        }))
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

        let build = fullmag_build_info::identity();
        if !lower_hex(build.git_commit, 40)
            || !lower_hex(build.source_snapshot_sha256, 64)
            || record.build_commit != build.git_commit
            || record.build_snapshot != build.source_snapshot_sha256
        {
            bail!("development API owner record build identity does not match the launcher");
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
            control_address: address,
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
    control_address: SocketAddrV4,
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
        let (workspace_state, session_id, session_epoch) = match &response.workspace {
            WorkspaceResponse::NoSession { session_epoch } => ("no_session", None, *session_epoch),
            WorkspaceResponse::Session { identity, .. } => (
                "session",
                Some(identity.session_id.clone()),
                identity.session_epoch,
            ),
        };
        let workspace = serde_json::to_value(&response.workspace)
            .context("unable to materialize development authoring snapshot")?;
        std::str::from_utf8(&response_bytes)
            .context("development API acquisition response is not UTF-8")?;

        Ok(AuthoringAcquisition {
            stream: Some(stream),
            owner_token: self.owner_token.clone(),
            api_instance_id: self.api_instance_id.clone(),
            nonce: nonce.to_owned(),
            workspace,
            acquisition_bytes: response_bytes,
            workspace_state,
            session_id,
            session_epoch,
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
    stream: Option<TcpStream>,
    owner_token: String,
    api_instance_id: String,
    nonce: String,
    workspace: Value,
    acquisition_bytes: Vec<u8>,
    workspace_state: &'static str,
    session_id: Option<String>,
    session_epoch: u64,
    storage_root: PathBuf,
    worktree: String,
    generation: String,
    source: String,
    version: String,
}

impl AuthoringAcquisition {
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
        let result = self.stage_handoff_inner(repo_root, candidate_bundle_root, frontend_payload);
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
    ) -> Result<StagedAuthoringHandoff> {
        if self.stream.is_none() {
            bail!("development API acquisition connection is unavailable");
        }

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
            schema: STAGE_REQUEST_SCHEMA,
            acquisition_json: &acquisition_json,
            source_identity: StageSourceIdentity {
                api_instance_id: &self.api_instance_id,
                generation_id: &self.generation,
                source_build_id: &self.version,
                source_sha256: &self.source,
            },
            candidate_bundle_root,
            frontend_payload,
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
        })
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
}

#[derive(Serialize)]
struct StageRequest<'a> {
    schema: &'static str,
    acquisition_json: &'a str,
    source_identity: StageSourceIdentity<'a>,
    candidate_bundle_root: &'a str,
    frontend_payload: &'a Value,
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
        .env_remove("FULLMAG_DEVELOPMENT_OWNER_TOKEN");
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
struct ControlRequest<'a> {
    schema: &'static str,
    owner_token: &'a str,
    api_instance_id: &'a str,
    nonce: &'a str,
    command: ControlCommand,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ControlCommand {
    Acquire,
    Confirm,
    Abort,
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
