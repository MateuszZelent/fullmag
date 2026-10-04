//! Native service discovery and authenticated terminal lifecycle observation.
//! Failed observation never starts a service or proves a safe workspace restart.
use anyhow::{bail, Context, Result};
use fullmag_session::{
    repository_path::checked_path,
    runtime_service::{
        validate_descriptor, RuntimeServiceConfig, RuntimeServiceLaunchGuard,
        RuntimeServiceOwnerDescriptor, RuntimeServiceState, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
    },
};
use serde::Deserialize;
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::Path,
    time::{Duration, Instant},
};

const MAX_RESPONSE: usize = 256 * 1024;

fn read_api_document(port: u16) -> Result<(serde_json::Value, String)> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, remaining(deadline)?)?;
    stream.set_write_timeout(Some(remaining(deadline)?))?;
    stream.write_all(
        b"GET /v2/platform/openapi.json HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
    )?;
    let mut response = Vec::new();
    loop {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        let mut bytes = [0u8; 8192];
        let count = stream.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        response.extend_from_slice(&bytes[..count]);
        if response.len() > 4 * 1024 * 1024 {
            bail!("API identity response exceeds budget");
        }
    }
    let response = std::str::from_utf8(&response)?;
    let (headers, body) = response
        .split_once("\r\n\r\n")
        .context("API identity response missing headers")?;
    if !(headers.starts_with("HTTP/1.1 200 ") || headers.starts_with("HTTP/1.0 200 "))
        || !headers.lines().any(|line| {
            line.trim()
                .eq_ignore_ascii_case("x-api-contract-version: 1.0.0")
        })
    {
        bail!("API contract version mismatch before service attach");
    }
    let document: serde_json::Value = serde_json::from_str(body)?;
    let instance = require_api_instance_header(headers)?;
    Ok((document, instance))
}

fn require_api_instance_header(headers: &str) -> Result<String> {
    let values: Vec<_> = headers
        .lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("x-fullmag-api-instance")
                .then(|| value.trim())
        })
        .collect();
    let [value] = values.as_slice() else {
        bail!("API instance identity missing or ambiguous");
    };
    let parsed = uuid::Uuid::parse_str(value).context("invalid API instance identity")?;
    if parsed.is_nil() || parsed.to_string() != *value {
        bail!("API instance identity must be a canonical nonzero UUID");
    }
    Ok((*value).to_owned())
}

pub(crate) fn verify_api_identity(port: u16) -> Result<String> {
    let (document, instance) = read_api_document(port)?;
    let local = fullmag_build_info::identity();
    require_api_identity(&document, local.git_commit, local.source_snapshot_sha256)?;
    Ok(instance)
}

pub(crate) fn verify_api_store(port: u16, expected: &Path) -> Result<String> {
    let (document, instance) = read_api_document(port)?;
    let local = fullmag_build_info::identity();
    require_api_identity(&document, local.git_commit, local.source_snapshot_sha256)?;
    require_api_store_binding(&document, expected)?;
    Ok(instance)
}

fn require_api_store_binding(document: &serde_json::Value, expected: &Path) -> Result<()> {
    let binding = crate::accepted_store::store_binding(expected)
        .context("cannot resolve canonical accepted-store binding")?;
    let remote = &document["x-fullmag-runtime-store-binding"];
    if remote["schema_version"].as_str() != Some("runtime_store_binding.v1")
        || remote["kind"].as_str() != Some("accepted_runs")
        || remote["binding"].as_str() != Some(binding.as_str())
    {
        bail!("API accepted-store binding mismatch; native service attach refused");
    }
    Ok(())
}

fn require_api_identity(document: &serde_json::Value, commit: &str, snapshot: &str) -> Result<()> {
    if commit.len() != 40
        || !commit.bytes().all(|b| b.is_ascii_hexdigit())
        || snapshot.len() != 64
        || !snapshot.bytes().all(|b| b.is_ascii_hexdigit())
        || document["x-fullmag-build-identity"]["git_commit"].as_str() != Some(commit)
        || document["x-fullmag-build-identity"]["source_snapshot_sha256"].as_str() != Some(snapshot)
        || !document["paths"]
            .as_object()
            .is_some_and(|paths| paths.contains_key("/v2/sessions/current/model/scene"))
    {
        bail!("API source/contract mismatch before native service attach");
    }
    Ok(())
}

/// API process pin and optional service owner observed during application startup.
pub struct ApplicationRuntimeBinding {
    pub api_instance_id: String,
    pub owner: Option<RuntimeServiceOwnerDescriptor>,
}

/// Verified startup input. Preparation does not start or replace any process.
pub struct PreparedApplicationService {
    pub api_instance_id: String,
    pub config: RuntimeServiceConfig,
}

/// Initialize persisted resource offers for an installed native Windows package.
/// This boundary is separate from ensure so authoring launchers can report
/// unavailable computation without treating it as an invalid API instance.
pub fn prepare_packaged_application_service(
    repo_root: &Path,
    state_root: &Path,
    api_port: u16,
) -> Result<PreparedApplicationService> {
    let executable = std::env::current_exe().context("resolve application executable")?;
    require_packaged_installation(&executable, repo_root)?;
    let expected = crate::accepted_store::configured_submit_store_root(repo_root, state_root)
        .context("canonical accepted run storage is not configured; initialization refused")?;
    let api_instance_id = verify_api_store(api_port, &expected)?;
    let config = prepare_application_config(
        &expected,
        std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG"),
    )?;
    if verify_api_store(api_port, &expected)? != api_instance_id {
        bail!("API instance changed during resource initialization; service start refused");
    }
    Ok(PreparedApplicationService {
        api_instance_id,
        config,
    })
}

fn require_packaged_installation(executable: &Path, repo_root: &Path) -> Result<()> {
    let package = crate::python_runtime::packaged_windows_root(executable)
        .context("default resource initialization requires an installed native Windows package")?;
    if std::fs::canonicalize(&package)? != std::fs::canonicalize(repo_root)? {
        bail!("application package differs from API installation; initialization refused");
    }
    Ok(())
}

pub(crate) fn prepare_application_config(
    expected: &Path,
    explicit_path: Option<std::ffi::OsString>,
) -> Result<RuntimeServiceConfig> {
    // An explicit operator configuration always takes precedence over sampling.
    let config = match explicit_path {
        Some(path) => {
            let config = RuntimeServiceConfig::read(&std::path::PathBuf::from(path))?;
            require_application_store(&config.store_root, expected)?;
            crate::retry_store_writer_busy(|| {
                fullmag_session::SessionStore::open(expected.to_path_buf())
            })?;
            config
        }
        None => {
            let store = crate::retry_store_writer_busy(|| {
                fullmag_session::SessionStore::open(expected.to_path_buf())
            })?;
            crate::retry_store_writer_busy(|| {
                RuntimeServiceConfig::for_application(
                    &store,
                    crate::local_resources::APPLICATION_TARGET_ID,
                    || {
                        let capacity =
                            crate::local_resources::LocalCpuCapacity::observe(store.root())?;
                        crate::local_resources::application_service_config(store.root(), capacity)
                    },
                )
            })?
        }
    };
    Ok(config)
}

/// Initialize the canonical accepted store and ensure its explicitly configured service.
/// An absent configuration still verifies the API without inventing resource offers.
pub fn ensure_for_application(
    repo_root: &Path,
    state_root: &Path,
    api_port: u16,
) -> Result<ApplicationRuntimeBinding> {
    let Some(config_path) = std::env::var_os("FULLMAG_RUNTIME_SERVICE_CONFIG") else {
        let (document, api_instance_id) = read_api_document(api_port)?;
        let local = fullmag_build_info::identity();
        require_api_identity(&document, local.git_commit, local.source_snapshot_sha256)?;
        return Ok(ApplicationRuntimeBinding {
            api_instance_id,
            owner: None,
        });
    };
    let expected = crate::accepted_store::configured_submit_store_root(repo_root, state_root)
        .context("canonical accepted run storage is not configured; service start refused")?;
    let api_instance = verify_api_store(api_port, &expected)?;
    let config = prepare_application_config(&expected, Some(config_path))?;
    let owner = ensure_config(config)?;
    // Service startup may be long; recheck the API immediately before returning.
    if verify_api_store(api_port, &expected)? != api_instance {
        bail!("API instance changed during native service startup; attach refused");
    }
    Ok(ApplicationRuntimeBinding {
        api_instance_id: api_instance,
        owner: Some(owner),
    })
}

fn require_application_store(configured_root: &Path, expected: &Path) -> Result<()> {
    let configured = crate::accepted_store::writable_product_state_path(configured_root)
        .context("native service store path has unsupported links or layout")?;
    if configured.as_path() != expected {
        bail!("native service store differs from API accepted run store; start refused");
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusResponse {
    schema_version: String,
    nonce: String,
    owner: RuntimeServiceOwnerDescriptor,
    #[serde(default)]
    configuration: Option<RuntimeServiceConfig>,
}

fn require_ready(
    owner: &RuntimeServiceOwnerDescriptor,
    target: &str,
    commit: &str,
    snapshot: &str,
) -> Result<()> {
    validate_descriptor(owner)?;
    if owner.target_id != target
        || owner.build_commit.as_deref() != Some(commit)
        || owner.build_snapshot.as_deref() != Some(snapshot)
    {
        bail!("native service target/build mismatch; attach refused");
    }
    if owner.state != RuntimeServiceState::Ready {
        bail!("native service is not ready; recovery or lifecycle observation required");
    }
    Ok(())
}

fn validate_response(
    bytes: &[u8],
    nonce: &str,
    expected: &RuntimeServiceOwnerDescriptor,
    target: &str,
    commit: &str,
    snapshot: &str,
    config: Option<&RuntimeServiceConfig>,
) -> Result<RuntimeServiceOwnerDescriptor> {
    let response: StatusResponse =
        serde_json::from_slice(bytes).context("decode native service status")?;
    if response.schema_version != "runtime_service_status.v1" || response.nonce != nonce {
        bail!("native service status version/challenge mismatch");
    }
    require_ready(&response.owner, target, commit, snapshot)?;
    if let Some(config) = config {
        if response.configuration.as_ref() != Some(config) {
            bail!("native service configuration mismatch; attach refused");
        }
    }
    let observed = &response.owner;
    if observed.owner_token != expected.owner_token
        || observed.process_start_token != expected.process_start_token
        || observed.pid != expected.pid
        || observed.host != expected.host
        || observed.control_address != expected.control_address
        || observed.compute_pool_id != expected.compute_pool_id
        || observed.preparation_pool_id != expected.preparation_pool_id
        || observed.compute_pool_generation != expected.compute_pool_generation
        || observed.preparation_pool_generation != expected.preparation_pool_generation
    {
        bail!("native service owner/pool identity changed during discovery");
    }
    Ok(response.owner)
}

fn remaining(deadline: Instant) -> Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .context("native service discovery timed out; outcome unknown, restart refused")
}

pub fn probe(
    store_root: &Path,
    target: &str,
    timeout_seconds: u64,
) -> Result<RuntimeServiceOwnerDescriptor> {
    if !(1..=30).contains(&timeout_seconds) {
        bail!("native service discovery timeout must be 1..30 seconds");
    }
    probe_with_config(
        store_root,
        target,
        Duration::from_secs(timeout_seconds),
        None,
    )
}

pub(crate) fn probe_with_config(
    store_root: &Path,
    target: &str,
    timeout: Duration,
    config: Option<&RuntimeServiceConfig>,
) -> Result<RuntimeServiceOwnerDescriptor> {
    if !store_root.is_absolute()
        || !store_root.is_dir()
        || store_root
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        bail!("native service discovery requires an absolute existing store directory");
    }
    let bytes = fullmag_session::repository_path::read_bounded_regular_file(
        store_root,
        RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
        MAX_RESPONSE,
    )
    .context("read native service descriptor; no automatic start")?;
    let expected: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&bytes)?;
    let identity = fullmag_build_info::identity();
    require_ready(
        &expected,
        target,
        identity.git_commit,
        identity.source_snapshot_sha256,
    )?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let response = exchange_control(&expected, "status", &nonce, timeout)?;
    validate_response(
        &response,
        &nonce,
        &expected,
        target,
        identity.git_commit,
        identity.source_snapshot_sha256,
        config,
    )
}

fn exchange_control(
    expected: &RuntimeServiceOwnerDescriptor,
    command: &str,
    nonce: &str,
    timeout: Duration,
) -> Result<Vec<u8>> {
    let address: SocketAddr = expected
        .control_address
        .as_deref()
        .context("native service has no control address")?
        .parse()?;
    // Do not resolve DNS or connect to a descriptor-selected remote address.
    if !address.is_ipv4() || !address.ip().is_loopback() || address.port() == 0 {
        bail!("native service discovery requires nonzero IPv4 loopback address");
    }
    let deadline = Instant::now() + timeout;
    let mut stream = TcpStream::connect_timeout(&address, remaining(deadline)?)
        .context("native service unreachable; outcome unknown, restart refused")?;
    let mut request = serde_json::to_vec(&serde_json::json!({
        "schema_version":"runtime_service_control.v1", "owner_token":expected.owner_token,
        "command":command, "nonce":nonce,
    }))?;
    request.push(b'\n');
    // Recompute the common deadline after every partial write/read.
    let mut written = 0;
    while written < request.len() {
        stream.set_write_timeout(Some(remaining(deadline)?))?;
        let count = stream.write(&request[written..])?;
        if count == 0 {
            bail!("native service discovery write closed");
        }
        written += count;
    }
    let mut response = Vec::new();
    loop {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        let mut buffer = [0u8; 1024];
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            bail!("native service closed before status frame; outcome unknown");
        }
        if let Some(end) = buffer[..count].iter().position(|byte| *byte == b'\n') {
            if end + 1 != count {
                bail!("native service status has trailing frame data");
            }
            response.extend_from_slice(&buffer[..end]);
            if response.len() > MAX_RESPONSE {
                bail!("native service response exceeds budget");
            }
            break;
        }
        response.extend_from_slice(&buffer[..count]);
        if response.len() > MAX_RESPONSE {
            bail!("native service response exceeds budget");
        }
    }
    Ok(response)
}

/// Request a terminal drain from exactly the already observed service owner.
///
/// The caller must first close workspace mutation admission and verify that
/// authoritative compute/preparation/task state permits lifecycle handoff.
/// This receipt proves the named owner's drain, not scene persistence, absence
/// of newly accepted work, release of its process lock, or restart completion.
/// A timeout/disconnect is an unknown outcome and must never trigger a retry
/// or be treated as permission to replace a runtime.
pub fn drain_confirmed(
    expected: &RuntimeServiceOwnerDescriptor,
    config: &RuntimeServiceConfig,
    timeout_seconds: u64,
) -> Result<RuntimeServiceOwnerDescriptor> {
    let (response, nonce) =
        request_pinned_drain(expected, config, timeout_seconds, "drain_confirmed")?;
    validate_drain_response(&response, &nonce, expected, config)
}

/// Terminal service proof together with the still-closed durable admission fence.
/// This does not prove API shutdown, scene restoration, or completed restart.
pub struct IdleDrainProof {
    pub owner: RuntimeServiceOwnerDescriptor,
    pub admission_fence: fullmag_session::store::DevelopmentAdmissionFence,
}

/// Drain only the service whose accepted store is bound to the pinned API.
/// The caller must hold API mutation admission and its authoring acquisition.
/// This never starts a service or interprets an unavailable store as idle.
/// Any failure after draining deliberately retains the durable fence; neither
/// reconnection nor API loss authorizes an automatic release or another drain.
pub fn drain_idle_for_api(
    api_port: u16,
    api_instance_id: &str,
    expected: &RuntimeServiceOwnerDescriptor,
    config: &RuntimeServiceConfig,
    timeout_seconds: u64,
) -> Result<IdleDrainProof> {
    let parsed = uuid::Uuid::parse_str(api_instance_id)
        .context("invalid API pin before global idle drain")?;
    if api_port == 0 || parsed.is_nil() || parsed.to_string() != api_instance_id {
        bail!("invalid API identity before global idle drain");
    }
    if !(1..=30).contains(&timeout_seconds) {
        bail!("native service drain timeout must be 1..30 seconds");
    }
    let require_binding = || -> Result<()> {
        let (document, observed) = read_api_document(api_port)?;
        let build = fullmag_build_info::identity();
        require_api_identity(&document, build.git_commit, build.source_snapshot_sha256)?;
        require_api_store_binding(&document, &config.store_root)?;
        if observed != api_instance_id {
            bail!("API instance changed before global idle handoff");
        }
        Ok(())
    };
    require_binding()?;
    let proof = drain_idle_confirmed(expected, config, timeout_seconds)?;
    require_binding()?;
    Ok(proof)
}

/// Fence new durable work only after a global idle check, then drain the pinned
/// service. An uncertain outcome retains the marker and requires reconciliation.
pub fn drain_idle_confirmed(
    expected: &RuntimeServiceOwnerDescriptor,
    config: &RuntimeServiceConfig,
    timeout_seconds: u64,
) -> Result<IdleDrainProof> {
    let (bytes, nonce) =
        request_pinned_drain(expected, config, timeout_seconds, "drain_idle_confirmed")?;
    let response: IdleDrainResponse =
        serde_json::from_slice(&bytes).context("decode idle terminal service drain")?;
    if response.schema_version != "runtime_service_idle_drain.v1"
        || response.admission_fence.owner_token != expected.owner_token
        || response.admission_fence.nonce != nonce
    {
        bail!("idle service drain challenge/fence mismatch; restart refused");
    }
    // Reuse the complete terminal owner/configuration validation; only the
    // private response schema differs from the ordinary drain protocol.
    let terminal = serde_json::to_vec(&serde_json::json!({
        "schema_version": "runtime_service_drain.v1",
        "nonce": response.nonce,
        "owner": response.owner,
        "configuration": response.configuration,
    }))?;
    let owner = validate_drain_response(&terminal, &nonce, expected, config)?;
    let store = fullmag_session::SessionStore::open_existing(config.store_root.clone())?;
    if store.read_development_idle_fence()?.as_ref() != Some(&response.admission_fence) {
        bail!("durable admission fence differs from terminal drain proof; restart refused");
    }
    Ok(IdleDrainProof {
        owner,
        admission_fence: response.admission_fence,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IdleDrainResponse {
    schema_version: String,
    nonce: String,
    owner: RuntimeServiceOwnerDescriptor,
    configuration: RuntimeServiceConfig,
    admission_fence: fullmag_session::store::DevelopmentAdmissionFence,
}

fn request_pinned_drain(
    expected: &RuntimeServiceOwnerDescriptor,
    config: &RuntimeServiceConfig,
    timeout_seconds: u64,
    command: &str,
) -> Result<(Vec<u8>, String)> {
    if !(1..=30).contains(&timeout_seconds) {
        bail!("native service drain timeout must be 1..30 seconds");
    }
    let identity = fullmag_build_info::identity();
    require_ready(
        expected,
        &config.target_id,
        identity.git_commit,
        identity.source_snapshot_sha256,
    )?;
    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    // Prove the complete configuration and freshly pinned owner before sending
    // a mutating control frame. A stale expected descriptor is not authority.
    let observed = probe_with_config(
        &config.store_root,
        &config.target_id,
        remaining(deadline)?,
        Some(config),
    )?;
    if observed.owner_token != expected.owner_token
        || observed.process_start_token != expected.process_start_token
        || observed.pid != expected.pid
        || observed.host != expected.host
        || observed.control_address != expected.control_address
        || observed.compute_pool_generation != expected.compute_pool_generation
        || observed.preparation_pool_generation != expected.preparation_pool_generation
        || !same_service_children(&observed, expected)
    {
        bail!("native service owner changed before drain; no lifecycle request sent");
    }
    let nonce = uuid::Uuid::new_v4().to_string();
    let response = exchange_control(expected, command, &nonce, remaining(deadline)?)?;
    Ok((response, nonce))
}

fn validate_drain_response(
    bytes: &[u8],
    nonce: &str,
    expected: &RuntimeServiceOwnerDescriptor,
    config: &RuntimeServiceConfig,
) -> Result<RuntimeServiceOwnerDescriptor> {
    let response: StatusResponse =
        serde_json::from_slice(bytes).context("decode terminal service drain")?;
    let owner = &response.owner;
    validate_descriptor(owner)?;
    if response.schema_version != "runtime_service_drain.v1"
        || response.nonce != nonce
        || response.configuration.as_ref() != Some(config)
        || owner.state != RuntimeServiceState::Drained
        || owner.owner_token != expected.owner_token
        || owner.process_start_token != expected.process_start_token
        || owner.pid != expected.pid
        || owner.host != expected.host
        || owner.target_id != expected.target_id
        || owner.control_address != expected.control_address
        || owner.build_commit != expected.build_commit
        || owner.build_snapshot != expected.build_snapshot
        || owner.compute_pool_id != expected.compute_pool_id
        || owner.preparation_pool_id != expected.preparation_pool_id
        || owner.compute_pool_generation != expected.compute_pool_generation
        || owner.preparation_pool_generation != expected.preparation_pool_generation
        || !same_service_children(owner, expected)
        || owner.children.len() != 2
        || !["compute", "preparation"].iter().all(|role| {
            owner
                .children
                .iter()
                .filter(|child| child.role == *role && child.status == "exited_success")
                .count()
                == 1
        })
    {
        bail!(
            "terminal native service drain not proven; lifecycle outcome requires reconciliation"
        );
    }
    Ok(response.owner)
}

fn same_service_children(
    a: &RuntimeServiceOwnerDescriptor,
    b: &RuntimeServiceOwnerDescriptor,
) -> bool {
    a.children.len() == 2
        && b.children.len() == 2
        && a.children.iter().all(|child| {
            b.children
                .iter()
                .any(|other| child.role == other.role && child.pid == other.pid)
        })
}

/// Attach to a compatible service or launch one once. Unknown outcomes are retained.
pub fn ensure(config_path: &Path) -> Result<RuntimeServiceOwnerDescriptor> {
    ensure_config(RuntimeServiceConfig::read(config_path)?)
}

fn ensure_config(config: RuntimeServiceConfig) -> Result<RuntimeServiceOwnerDescriptor> {
    ensure_config_cancellable(config, &std::sync::atomic::AtomicBool::new(false), &|| {
        Ok(())
    })
}

/// Cancellation ends this launcher's observation, never a persistent service.
/// The callback revalidates the application's API pin before recording a launch.
pub(crate) fn ensure_config_cancellable(
    config: RuntimeServiceConfig,
    cancelled: &std::sync::atomic::AtomicBool,
    before_launch: &dyn Fn() -> Result<()>,
) -> Result<RuntimeServiceOwnerDescriptor> {
    use std::process::{Command, Stdio};
    require_attach_active(cancelled)?;
    if !config.store_root.is_dir() {
        bail!("native service requires an existing initialized session store");
    }
    let gate_deadline = Instant::now() + Duration::from_secs(config.startup_timeout_seconds + 10);
    let gate = loop {
        require_attach_active(cancelled)?;
        if let Some(gate) = RuntimeServiceLaunchGuard::try_acquire(&config.store_root)? {
            break gate;
        }
        std::thread::sleep(remaining(gate_deadline)?.min(Duration::from_millis(100)));
    };
    require_attach_active(cancelled)?;
    let mut terminal_owner = false;
    let descriptor_path = checked_path(&config.store_root, RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH)?;
    match std::fs::symlink_metadata(&descriptor_path) {
        Ok(_) => {
            let bytes = fullmag_session::repository_path::read_bounded_regular_file(
                &config.store_root,
                RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
                MAX_RESPONSE,
            )?;
            let owner: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&bytes)?;
            validate_descriptor(&owner)?;
            if !matches!(
                owner.state,
                RuntimeServiceState::Drained | RuntimeServiceState::Failed
            ) {
                return probe_with_config(
                    &config.store_root,
                    &config.target_id,
                    Duration::from_secs(3),
                    Some(&config),
                );
            }
            terminal_owner = true;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("observe owner before start; no automatic retry"),
    }
    let executable = std::env::current_exe()?.with_file_name(format!(
        "fullmag-runtime-service{}",
        std::env::consts::EXE_SUFFIX
    ));
    let parent = executable
        .parent()
        .context("native service executable parent missing")?;
    let executable = checked_path(
        parent,
        executable
            .file_name()
            .unwrap()
            .to_str()
            .context("native service executable name invalid")?,
    )?;
    if !executable.is_file() {
        bail!("native service binary missing; no alternate runtime fallback");
    }
    let log_id = uuid::Uuid::new_v4().to_string();
    let launcher_paths = gate.prepare_launcher_paths(&log_id)?;
    let pinned_path = launcher_paths.configuration;
    let mut pinned = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pinned_path)?;
    pinned.write_all(&serde_json::to_vec(&config)?)?;
    pinned.sync_all()?;
    drop(pinned);
    let output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(launcher_paths.stdout)?;
    let errors = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(launcher_paths.stderr)?;
    let mut command = Command::new(executable);
    command
        .arg("--config")
        .arg(&pinned_path)
        .stdin(Stdio::null())
        .stdout(output)
        .stderr(errors);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW; no console lifetime.
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    // Log/setup failures before this point do not create an uncertain launch intent.
    require_attach_active(cancelled)?;
    before_launch()?;
    require_attach_active(cancelled)?;
    gate.begin(&log_id, terminal_owner)?;
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            gate.publish(&log_id, "failed", None)?;
            return Err(error).context("start native runtime service");
        }
    };
    gate.publish(&log_id, "spawned", Some(child.id())).with_context(|| {
        format!("native service PID {} spawned but launch publication failed; outcome unknown, no kill or retry", child.id())
    })?;
    let deadline = Instant::now() + Duration::from_secs(config.startup_timeout_seconds + 10);
    loop {
        // Keep a spawned intent intact if the authoring window closes. The
        // service owns accepted work independently of this observer's thread.
        require_attach_active(cancelled)?;
        if let Some(status) = child
            .try_wait()
            .context("observe native service startup; outcome unknown")?
        {
            gate.publish(&log_id, "failed", Some(child.id()))?;
            bail!(
                "native service exited during startup ({status}); inspect launcher logs {log_id}"
            );
        }
        let budget = remaining(deadline).with_context(|| {
            format!(
                "native service PID {} startup unknown; retained without kill or restart",
                child.id()
            )
        })?;
        if let Ok(owner) = probe_with_config(
            &config.store_root,
            &config.target_id,
            budget.min(Duration::from_secs(3)),
            Some(&config),
        ) {
            if owner.pid != child.id() {
                bail!("service startup owner PID mismatch; no takeover");
            }
            // Dropping Child closes its handle; it does not kill the service.
            gate.publish(&log_id, "ready", Some(child.id())).with_context(|| {
                format!("native service PID {} observed ready but launch publication failed; outcome unknown, no kill or retry", child.id())
            })?;
            return Ok(owner);
        }
        std::thread::sleep(remaining(deadline)?.min(Duration::from_millis(100)));
    }
}

fn require_attach_active(cancelled: &std::sync::atomic::AtomicBool) -> Result<()> {
    if cancelled.load(std::sync::atomic::Ordering::Acquire) {
        bail!("native service attach observation cancelled; no service stop requested");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn cancelled_attach_never_reaches_launch_or_creates_a_store() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("not-created");
        let config = crate::local_resources::application_service_config(
            &root,
            crate::local_resources::LocalCpuCapacity {
                cpu_millis: 8000,
                memory_available_bytes: 1024 * 1024 * 1024,
                storage_available_bytes: 4 * 1024 * 1024 * 1024,
            },
        )
        .unwrap();
        let reached_launch = AtomicBool::new(false);
        let result = super::ensure_config_cancellable(config, &AtomicBool::new(true), &|| {
            reached_launch.store(true, Ordering::Release);
            Ok(())
        });
        assert!(result.is_err());
        assert!(!reached_launch.load(Ordering::Acquire));
        assert!(!root.exists());
    }

    #[test]
    fn attach_cancellation_is_observed_without_requesting_service_drain() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let cancelled = AtomicBool::new(false);
        assert!(super::require_attach_active(&cancelled).is_ok());
        cancelled.store(true, Ordering::Release);
        let error = super::require_attach_active(&cancelled).unwrap_err();
        assert!(error.to_string().contains("no service stop requested"));
    }

    #[test]
    fn default_preparation_reuses_the_persisted_resource_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let store = fullmag_session::SessionStore::open(directory.path().join("accepted")).unwrap();
        let capacity = crate::local_resources::LocalCpuCapacity {
            cpu_millis: 8000,
            memory_available_bytes: 1024 * 1024 * 1024,
            storage_available_bytes: 4 * 1024 * 1024 * 1024,
        };
        let expected = RuntimeServiceConfig::for_application(
            &store,
            crate::local_resources::APPLICATION_TARGET_ID,
            || crate::local_resources::application_service_config(store.root(), capacity),
        )
        .unwrap();
        assert_eq!(
            prepare_application_config(store.root(), None).unwrap(),
            expected
        );
    }

    #[test]
    fn malformed_explicit_configuration_does_not_sample_or_create_store() {
        let directory = tempfile::tempdir().unwrap();
        let store = directory.path().join("accepted");
        let config = directory.path().join("invalid.json");
        std::fs::write(&config, b"invalid").unwrap();
        assert!(prepare_application_config(&store, Some(config.into_os_string())).is_err());
        assert!(!store.exists());
    }

    #[test]
    fn source_checkout_cannot_initialize_packaged_defaults() {
        let directory = tempfile::tempdir().unwrap();
        assert!(require_packaged_installation(
            &directory.path().join("target/debug/fullmag.exe"),
            directory.path(),
        )
        .is_err());
        assert!(!directory.path().join("target").exists());
    }

    #[test]
    fn api_instance_header_requires_one_canonical_nonzero_uuid() {
        let id = "12345678-1234-4234-8234-123456789abc";
        let valid = format!("HTTP/1.1 200 OK\r\nX-Fullmag-Api-Instance: {id}");
        assert_eq!(super::require_api_instance_header(&valid).unwrap(), id);
        for invalid in [
            "HTTP/1.1 200 OK".to_owned(),
            format!("{valid}\r\nx-fullmag-api-instance: {id}"),
            "x-fullmag-api-instance: 00000000-0000-0000-0000-000000000000".to_owned(),
            format!("x-fullmag-api-instance: {}", id.to_uppercase()),
            "x-fullmag-api-instance: invalid".to_owned(),
        ] {
            assert!(super::require_api_instance_header(&invalid).is_err());
        }
    }

    use super::*;

    #[test]
    fn same_build_api_with_another_store_is_not_attachable() {
        let directory = tempfile::tempdir().unwrap();
        let expected = directory.path().join("accepted-store");
        let foreign = directory.path().join("other-store");
        let document = |root: &Path| {
            serde_json::json!({"x-fullmag-runtime-store-binding": {
                "schema_version":"runtime_store_binding.v1","kind":"accepted_runs",
                "binding":crate::accepted_store::store_binding(root),
            }})
        };
        assert!(require_api_store_binding(&document(&expected), &expected).is_ok());
        assert!(require_api_store_binding(&document(&foreign), &expected).is_err());
        assert!(require_api_store_binding(&serde_json::json!({}), &expected).is_err());
        let before = crate::accepted_store::store_binding(&expected);
        std::fs::create_dir(&expected).unwrap();
        assert_eq!(before, crate::accepted_store::store_binding(&expected));
    }

    #[test]
    fn api_health_or_same_commit_without_snapshot_cannot_bind_service() {
        let commit = "a".repeat(40);
        let snapshot = "b".repeat(64);
        let mut document = serde_json::json!({"x-fullmag-build-identity": {
            "git_commit":commit,"source_snapshot_sha256":snapshot},
            "paths":{"/v2/sessions/current/model/scene":{}}});
        assert!(require_api_identity(&document, &commit, &snapshot).is_ok());
        document["x-fullmag-build-identity"]["source_snapshot_sha256"] = "c".repeat(64).into();
        assert!(require_api_identity(&document, &commit, &snapshot).is_err());
        assert!(
            require_api_identity(&serde_json::json!({"status":"ok"}), &commit, &snapshot).is_err()
        );
        assert!(require_api_identity(&document, &commit, "unknown").is_err());
    }

    #[test]
    fn application_attach_rejects_current_workspace_store_before_initialization() {
        let directory = tempfile::tempdir().unwrap();
        let accepted = directory.path().join("runs/session-store");
        let current = directory.path().join("local-live/session-store");
        let expected = crate::accepted_store::writable_product_state_path(&accepted).unwrap();
        assert!(require_application_store(&accepted, &expected).is_ok());
        assert!(require_application_store(&current, &expected).is_err());
        assert!(!accepted.exists());
        assert!(!current.exists());
    }

    fn owner() -> RuntimeServiceOwnerDescriptor {
        serde_json::from_value(serde_json::json!({
            "schema_version":"runtime_service_owner.v1",
            "owner_token":uuid::Uuid::new_v4(),
            "process_start_token":uuid::Uuid::new_v4(),
            "pid":42,"host":"test-host","target_id":"desktop",
            "protocol":"stdin-v1","state":"ready",
            "acquired_at":"2026-10-03T00:00:00Z","heartbeat_at":"2026-10-03T00:00:00Z",
            "control_address":"127.0.0.1:12345",
            "build_commit":"a".repeat(40),"build_snapshot":"b".repeat(64),
            "compute_pool_id":"compute","preparation_pool_id":"prep",
            "compute_pool_generation":1,"preparation_pool_generation":2,
            "children":[{"role":"compute","pid":43,"status":"running"},
                {"role":"preparation","pid":44,"status":"running"}],
        }))
        .unwrap()
    }

    #[test]
    fn discovery_accepts_only_matching_live_identity() {
        let expected = owner();
        let response = |observed: &RuntimeServiceOwnerDescriptor, nonce: &str| {
            serde_json::to_vec(
                &serde_json::json!({"schema_version":"runtime_service_status.v1",
                "nonce":nonce,"owner":observed}),
            )
            .unwrap()
        };
        let commit = "a".repeat(40);
        let snapshot = "b".repeat(64);
        assert!(validate_response(
            &response(&expected, "fresh"),
            "fresh",
            &expected,
            "desktop",
            &commit,
            &snapshot,
            None
        )
        .is_ok());
        assert!(validate_response(
            &response(&expected, "stale"),
            "fresh",
            &expected,
            "desktop",
            &commit,
            &snapshot,
            None
        )
        .is_err());
        for field in ["owner", "start", "pool", "build", "state"] {
            let mut changed = expected.clone();
            match field {
                "owner" => changed.owner_token = uuid::Uuid::new_v4().to_string(),
                "start" => changed.process_start_token = uuid::Uuid::new_v4().to_string(),
                "pool" => changed.compute_pool_generation = Some(3),
                "build" => changed.build_commit = Some("c".repeat(40)),
                "state" => changed.state = RuntimeServiceState::Draining,
                _ => unreachable!(),
            }
            assert!(
                validate_response(
                    &response(&changed, "fresh"),
                    "fresh",
                    &expected,
                    "desktop",
                    &commit,
                    &snapshot,
                    None
                )
                .is_err(),
                "{field}"
            );
        }
    }

    #[test]
    fn expired_deadline_is_unknown_and_never_restarted() {
        assert!(remaining(Instant::now() - Duration::from_secs(1)).is_err());
    }

    fn configuration_fixture() -> RuntimeServiceConfig {
        let budget = fullmag_session::FmsResourceBudget {
            cpu_millis: 1000,
            memory_bytes: 1024,
            storage_bytes: 1024,
            gpu_memory_bytes: 0,
        };
        let config = RuntimeServiceConfig {
            schema_version: "runtime_service_config.v1".into(),
            store_root: std::env::temp_dir(),
            target_id: "desktop".into(),
            compute_pool_id: "compute".into(),
            preparation_pool_id: "prep".into(),
            compute_resources: vec![fullmag_session::FmsSchedulerResourceOffer {
                resource_id: "compute.cpu".into(),
                kind: fullmag_session::FmsResourceKind::Cpu,
                budget: budget.clone(),
            }],
            preparation_resources: vec![fullmag_session::FmsPreparationResourceOffer {
                resource_id: "prep.cpu".into(),
                budget,
            }],
            worker_timeout_seconds: 10,
            preparation_timeout_seconds: 10,
            heartbeat_interval_milliseconds: 100,
            startup_timeout_seconds: 10,
            drain_timeout_seconds: 10,
        };
        config.validate().unwrap();
        config
    }

    #[test]
    fn attach_requires_exact_service_configuration() {
        let expected = owner();
        let config = configuration_fixture();
        let mut response = serde_json::json!({"schema_version":"runtime_service_status.v1",
            "nonce":"fresh","owner":expected});
        let check = |response: &serde_json::Value| {
            validate_response(
                &serde_json::to_vec(response).unwrap(),
                "fresh",
                &expected,
                "desktop",
                &"a".repeat(40),
                &"b".repeat(64),
                Some(&config),
            )
        };
        assert!(check(&response).is_err());
        response["configuration"] = serde_json::to_value(&config).unwrap();
        assert!(check(&response).is_ok());
        response["configuration"]["compute_resources"][0]["budget"]["memory_bytes"] = 2048.into();
        assert!(check(&response).is_err());
    }

    #[test]
    fn confirmed_drain_requires_exact_owner_and_terminal_children() {
        let expected = owner();
        let config = configuration_fixture();
        let mut drained = expected.clone();
        drained.state = RuntimeServiceState::Drained;
        for child in &mut drained.children {
            child.status = "exited_success".into();
        }
        let baseline = serde_json::json!({"schema_version":"runtime_service_drain.v1",
            "nonce":"fresh","owner":drained,"configuration":config});
        let check = |value: &serde_json::Value| {
            validate_drain_response(
                &serde_json::to_vec(value).unwrap(),
                "fresh",
                &expected,
                &config,
            )
        };
        assert!(check(&baseline).is_ok());
        for (pointer, value) in [
            (
                "/schema_version",
                serde_json::json!("runtime_service_status.v1"),
            ),
            ("/nonce", serde_json::json!("stale")),
            ("/owner/state", serde_json::json!("draining")),
            ("/owner/state", serde_json::json!("unknown")),
            (
                "/owner/process_start_token",
                serde_json::json!(uuid::Uuid::new_v4()),
            ),
            ("/owner/compute_pool_generation", serde_json::json!(3)),
            ("/owner/build_snapshot", serde_json::json!("c".repeat(64))),
            ("/owner/children/0/pid", serde_json::json!(99)),
            ("/owner/children/0/status", serde_json::json!("running")),
            (
                "/owner/children/0/status",
                serde_json::json!("exited_failure"),
            ),
            ("/owner/children", serde_json::json!([])),
            (
                "/configuration/drain_timeout_seconds",
                serde_json::json!(20),
            ),
        ] {
            let mut changed = baseline.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            assert!(check(&changed).is_err(), "accepted {pointer}");
        }
        assert!(
            validate_drain_response(br#"{"status":"draining"}"#, "fresh", &expected, &config)
                .is_err()
        );
    }
}
