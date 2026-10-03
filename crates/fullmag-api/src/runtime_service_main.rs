//! Native accepted-run service. UI is an attaching client, never its owner.
use anyhow::{bail, Context, Result};
use fullmag_session::{
    repository_path::{checked_path, validate_store_id},
    runtime_service::{
        RuntimeServiceChild, RuntimeServiceConfig as ServiceConfig, RuntimeServiceOwner,
        RuntimeServiceState,
    },
    FmsPreparationResourceOffer, FmsPreparationResourcePool, FmsSchedulerResourceOffer,
    FmsSchedulerResourcePool, SessionStore, FMS_PREPARATION_RESOURCE_POOL_SCHEMA,
    FMS_SCHEDULER_RESOURCE_POOL_SCHEMA,
};
use serde::Deserialize;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

struct SchedulerChild {
    role: &'static str,
    child: Child,
    input: Option<ChildStdin>,
    stdout: PathBuf,
    released: bool,
    status: Option<std::process::ExitStatus>,
    observation_unknown: bool,
}

impl SchedulerChild {
    fn request_drain(&mut self) -> Result<()> {
        if let Some(mut input) = self.input.take() {
            // Before release, EOF rejects startup without opening the store.
            if self.released {
                input.write_all(&[1]).context("send scheduler drain")?;
            }
        }
        Ok(())
    }
    fn release(&mut self) -> Result<()> {
        self.input
            .as_mut()
            .context("scheduler startup writer missing")?
            .write_all(&[1])?;
        self.released = true;
        Ok(())
    }
    fn event(&self, event: &str, owner: &str, pool: Option<(&str, u64)>) -> Result<bool> {
        let log_root = self
            .stdout
            .parent()
            .context("scheduler log has no parent")?;
        let name = self
            .stdout
            .file_name()
            .and_then(|n| n.to_str())
            .context("scheduler log name is not UTF-8")?;
        let mut file = File::open(checked_path(log_root, name)?)?;
        let len = file.metadata()?.len();
        if event == "drained" {
            file.seek(SeekFrom::Start(len.saturating_sub(65536)))?;
        }
        let mut bytes = Vec::new();
        file.take(65536).read_to_end(&mut bytes)?;
        let identity = fullmag_build_info::identity();
        for line in bytes.split(|b| *b == b'\n') {
            let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
                continue;
            };
            if value["schema_version"] != "scheduler_owner_event.v1" || value["event"] != event {
                continue;
            }
            if value["role"] != self.role
                || value["pid"].as_u64() != Some(u64::from(self.child.id()))
                || value["protocol"] != "stdin-v1"
                || value["owner_token"] != owner
                || value["git_commit"] != identity.git_commit
                || value["source_snapshot_sha256"] != identity.source_snapshot_sha256
            {
                bail!("scheduler {} event identity/version mismatch", self.role);
            }
            if let Some((pool_id, generation)) = pool {
                if value["pool_id"] != pool_id || value["generation"].as_u64() != Some(generation) {
                    bail!("scheduler {} pool generation mismatch", self.role);
                }
            }
            return Ok(true);
        }
        Ok(false)
    }
}

#[derive(Default)]
struct Schedulers(Vec<SchedulerChild>);
impl Schedulers {
    fn describe(&self) -> Vec<RuntimeServiceChild> {
        self.0
            .iter()
            .map(|c| RuntimeServiceChild {
                role: c.role.into(),
                pid: c.child.id(),
                status: match c.status {
                    Some(s) if s.success() => "exited_success",
                    Some(_) => "exited_failure",
                    None if c.observation_unknown => "unknown",
                    None => "running",
                }
                .into(),
            })
            .collect()
    }
    fn poll(&mut self) -> Result<()> {
        for child in &mut self.0 {
            if child.status.is_none() {
                match child.child.try_wait() {
                    Ok(status) => {
                        child.status = status;
                        child.observation_unknown = false;
                    }
                    Err(error) => {
                        child.observation_unknown = true;
                        return Err(error).context("observe scheduler process");
                    }
                }
            }
            if child.status.is_some() {
                bail!("scheduler {} exited unexpectedly", child.role);
            }
        }
        Ok(())
    }
    fn finish(&mut self, owner: &str, timeout: Duration) -> Result<()> {
        let mut errors = Vec::new();
        // Close both admissions before waiting for either process.
        for child in &mut self.0 {
            if let Err(e) = child.request_drain() {
                errors.push(format!("{}: {e:#}", child.role));
            }
        }
        let deadline = Instant::now() + timeout;
        let mut unobservable = std::collections::BTreeSet::new();
        loop {
            let mut pending = false;
            for child in &mut self.0 {
                if child.status.is_none() && !unobservable.contains(child.role) {
                    match child.child.try_wait() {
                        Ok(Some(status)) => {
                            child.status = Some(status);
                            child.observation_unknown = false;
                        }
                        Ok(None) => {
                            pending = true;
                            child.observation_unknown = false;
                        }
                        Err(error) => {
                            errors.push(format!("{} observation: {error}", child.role));
                            child.observation_unknown = true;
                            unobservable.insert(child.role);
                        }
                    }
                }
            }
            if !pending {
                break;
            }
            if Instant::now() >= deadline {
                errors.push("scheduler drain deadline exceeded; process outcome unknown".into());
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        for child in &mut self.0 {
            if child.released {
                if !child.status.is_some_and(|s| s.success()) {
                    errors.push(format!("{} did not exit successfully", child.role));
                }
                match child.event("drained", owner, None) {
                    Ok(true) => {}
                    Ok(false) => errors.push(format!("{} missing drained receipt", child.role)),
                    Err(e) => errors.push(format!("{} terminal receipt: {e:#}", child.role)),
                }
            }
        }
        if !errors.is_empty() {
            bail!("runtime scheduler drain failed: {}", errors.join("; "));
        }
        Ok(())
    }
}
impl Drop for Schedulers {
    fn drop(&mut self) {
        // Explicit bounded finish records outcomes; destruction only closes admission.
        for child in &mut self.0 {
            let _ = child.request_drain();
        }
    }
}

fn executable(root: &Path, name: &str) -> Result<PathBuf> {
    let name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    let path = checked_path(root, &name)?;
    if !path.is_file() {
        bail!("packaged executable missing: {}", path.display());
    }
    Ok(path)
}

fn logged_command(bin: &Path, logs: &Path, role: &str) -> Result<(Command, PathBuf)> {
    let stdout = checked_path(logs, &format!("{role}.stdout.jsonl"))?;
    let stderr = checked_path(logs, &format!("{role}.stderr.log"))?;
    let out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stdout)?;
    let err = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&stderr)?;
    let mut command = Command::new(bin);
    command.stdout(Stdio::from(out)).stderr(Stdio::from(err));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // No console is required: schedulers use private owner pipes.
        command.creation_flags(0x08000000);
    }
    Ok((command, stdout))
}

fn publish_pools(
    config: &ServiceConfig,
    store: &SessionStore,
    bin: &Path,
    logs: &Path,
    unknown_publishers: &mut Vec<RuntimeServiceChild>,
    deadline: Instant,
) -> Result<(u64, u64)> {
    let compute_prior = store
        .read_scheduler_resource_pool(&config.compute_pool_id)?
        .map_or(0, |p| p.generation);
    let prep_prior = store
        .read_preparation_resource_pool(&config.preparation_pool_id)?
        .map_or(0, |p| p.generation);
    for (role, name, pool_id, generation, offers) in [
        (
            "compute-publisher",
            "fullmag-api-resource-pool",
            &config.compute_pool_id,
            compute_prior,
            config
                .compute_resources
                .iter()
                .map(serde_json::to_string)
                .collect::<std::result::Result<Vec<_>, _>>()?,
        ),
        (
            "preparation-publisher",
            "fullmag-api-preparation-resource-pool",
            &config.preparation_pool_id,
            prep_prior,
            config
                .preparation_resources
                .iter()
                .map(serde_json::to_string)
                .collect::<std::result::Result<Vec<_>, _>>()?,
        ),
    ] {
        if Instant::now() >= deadline {
            bail!("global native service startup deadline exceeded before publisher spawn");
        }
        let (mut command, _) = logged_command(&executable(bin, name)?, logs, role)?;
        command
            .stdin(Stdio::null())
            .arg("--store-root")
            .arg(&config.store_root)
            .arg("--pool-id")
            .arg(pool_id)
            .arg("--expected-generation")
            .arg(generation.to_string());
        for offer in offers {
            command.arg("--resource-offer").arg(offer);
        }
        let identity = fullmag_build_info::identity();
        command
            .env("FULLMAG_RUNTIME_SERVICE_SOURCE_COMMIT", identity.git_commit)
            .env(
                "FULLMAG_RUNTIME_SERVICE_SOURCE_SNAPSHOT",
                identity.source_snapshot_sha256,
            );
        let mut process = command.spawn().context("start resource publisher")?;
        loop {
            match process.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) => bail!("{role} failed; logs retained"),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                observation => {
                    unknown_publishers.push(RuntimeServiceChild {
                        role: role.into(),
                        pid: process.id(),
                        status: if observation.is_err() {
                            "unknown"
                        } else {
                            "running"
                        }
                        .into(),
                    });
                    bail!("{role} publication outcome unknown: {observation:?}");
                }
            }
        }
    }
    let compute = store
        .read_scheduler_resource_pool(&config.compute_pool_id)?
        .context("published compute pool missing")?;
    let prep = store
        .read_preparation_resource_pool(&config.preparation_pool_id)?
        .context("published preparation pool missing")?;
    if compute.generation
        != compute_prior
            .checked_add(1)
            .context("compute generation overflow")?
        || prep.generation
            != prep_prior
                .checked_add(1)
                .context("preparation generation overflow")?
        || compute.resources != config.compute_resources
        || prep.resources != config.preparation_resources
    {
        bail!("resource publication does not match service configuration");
    }
    Ok((compute.generation, prep.generation))
}

fn spawn_scheduler(
    config: &ServiceConfig,
    bin: &Path,
    logs: &Path,
    role: &'static str,
    owner: &str,
) -> Result<SchedulerChild> {
    let (name, pool) = if role == "compute" {
        ("fullmag-api-accepted-scheduler", &config.compute_pool_id)
    } else {
        (
            "fullmag-api-accepted-fem-preparation-scheduler",
            &config.preparation_pool_id,
        )
    };
    let (mut command, stdout) = logged_command(&executable(bin, name)?, logs, role)?;
    command
        .stdin(Stdio::piped())
        .env("FULLMAG_RUNTIME_SERVICE_OWNER", owner)
        .arg("--store-root")
        .arg(&config.store_root)
        .arg("--pool-id")
        .arg(pool)
        .args([
            "--resident",
            "true",
            "--owner-control",
            "stdin-v1",
            "--startup-gate",
            "stdin-v1",
            "--max-concurrency",
            "1",
            "--max-tasks",
            "0",
            "--max-idle-polls",
            "0",
        ])
        .arg("--heartbeat-interval-milliseconds")
        .arg(config.heartbeat_interval_milliseconds.to_string());
    if role == "compute" {
        command
            .args(["--discover-runs", "true", "--discover-resources", "true"])
            .arg("--worker-timeout-seconds")
            .arg(config.worker_timeout_seconds.to_string())
            .arg("--worker-executable")
            .arg(executable(bin, "fullmag-api-accepted-worker")?);
    } else {
        command
            .arg("--process-timeout-seconds")
            .arg(config.preparation_timeout_seconds.to_string())
            .arg("--preparer-executable")
            .arg(executable(bin, "fullmag-api-accepted-fem-preparer")?);
    }
    let identity = fullmag_build_info::identity();
    command
        .env("FULLMAG_RUNTIME_SERVICE_SOURCE_COMMIT", identity.git_commit)
        .env(
            "FULLMAG_RUNTIME_SERVICE_SOURCE_SNAPSHOT",
            identity.source_snapshot_sha256,
        );
    let mut child = command.spawn().context("spawn resident scheduler")?;
    let input = child.stdin.take();
    Ok(SchedulerChild {
        role,
        child,
        input,
        stdout,
        released: false,
        status: None,
        observation_unknown: false,
    })
}

async fn await_event(
    children: &mut Schedulers,
    event: &str,
    owner: &str,
    config: &ServiceConfig,
    generations: (u64, u64),
    deadline: Instant,
) -> Result<()> {
    loop {
        if Instant::now() >= deadline {
            bail!("global scheduler startup deadline exceeded before {event}");
        }
        children.poll()?;
        let mut ready = true;
        for child in &children.0 {
            let pool = if event == "ready" {
                Some(if child.role == "compute" {
                    (config.compute_pool_id.as_str(), generations.0)
                } else {
                    (config.preparation_pool_id.as_str(), generations.1)
                })
            } else {
                None
            };
            ready &= child.event(event, owner, pool)?;
        }
        if ready {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!("scheduler {event} handshake timed out; outcome is not ready");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlRequest {
    schema_version: String,
    owner_token: String,
    command: String,
    #[serde(default)]
    nonce: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum ControlCommand {
    Drain,
    ConfirmedDrain { nonce: String },
    IdleConfirmedDrain { nonce: String },
    Status { nonce: String },
}

struct DrainConfirmation {
    stream: tokio::net::TcpStream,
    nonce: String,
    idle_fence: Option<fullmag_session::store::DevelopmentAdmissionFence>,
}

enum ControlObservation {
    Continue,
    Drain(Option<DrainConfirmation>),
}

fn control_command(bytes: &[u8], owner: &str) -> Option<ControlCommand> {
    let request = serde_json::from_slice::<ControlRequest>(bytes).ok()?;
    if request.schema_version != "runtime_service_control.v1" || request.owner_token != owner {
        return None;
    }
    match request.command.as_str() {
        "drain" if request.nonce.is_none() => Some(ControlCommand::Drain),
        "status" | "drain_confirmed" | "drain_idle_confirmed" => {
            let nonce = request.nonce?;
            if nonce.is_empty()
                || nonce.len() > 128
                || !nonce
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return None;
            }
            Some(if request.command == "status" {
                ControlCommand::Status { nonce }
            } else if request.command == "drain_idle_confirmed" {
                ControlCommand::IdleConfirmedDrain { nonce }
            } else {
                ControlCommand::ConfirmedDrain { nonce }
            })
        }
        _ => None,
    }
}

#[cfg(test)]
fn valid_drain_request(bytes: &[u8], owner: &str) -> bool {
    control_command(bytes, owner) == Some(ControlCommand::Drain)
}

async fn drain_requested(
    listener: &TcpListener,
    owner: &RuntimeServiceOwner,
    config: &ServiceConfig,
    store: &SessionStore,
) -> Result<ControlObservation> {
    let (mut stream, peer) =
        match tokio::time::timeout(Duration::from_millis(250), listener.accept()).await {
            Ok(result) => result.context("accept service control request")?,
            Err(_) => return Ok(ControlObservation::Continue),
        };
    if !peer.ip().is_loopback() {
        return Ok(ControlObservation::Continue);
    }
    let parsed = tokio::time::timeout(Duration::from_secs(1), async {
        let mut bytes = Vec::new();
        loop {
            let byte = stream.read_u8().await?;
            if byte == b'\n' {
                break;
            }
            if bytes.len() >= 4096 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "control request exceeds budget",
                ));
            }
            bytes.push(byte);
        }
        Ok::<_, std::io::Error>(bytes)
    })
    .await;
    let command = match parsed {
        Ok(Ok(bytes)) => control_command(&bytes, owner.owner_token()),
        _ => None,
    };
    if let Some(ControlCommand::IdleConfirmedDrain { nonce }) = &command {
        // Acquisition checks all accepted work and leases and publishes its
        // durable admission fence under one writer transaction. The writer is
        // released before waiting for scheduler exit/checkpoint publication.
        match fullmag_runtime_control::retry_store_writer_busy(|| {
            store.acquire_development_idle_fence(owner.owner_token(), nonce)
        }) {
            Ok(fence) => {
                return Ok(ControlObservation::Drain(Some(DrainConfirmation {
                    stream,
                    nonce: nonce.clone(),
                    idle_fence: Some(fence),
                })))
            }
            Err(_) => {
                let response = b"{\"status\":\"rejected\",\"reason\":\"idle_not_proven\"}\n";
                let _ =
                    tokio::time::timeout(Duration::from_secs(1), stream.write_all(response)).await;
                return Ok(ControlObservation::Continue);
            }
        }
    }
    if let Some(ControlCommand::ConfirmedDrain { nonce }) = command {
        // Keep the authenticated connection until terminal child receipts and
        // pool observations have been durably published. Admission ACK alone
        // must never authorize replacing a runtime.
        return Ok(ControlObservation::Drain(Some(DrainConfirmation {
            stream,
            nonce,
            idle_fence: None,
        })));
    }
    let drain = command == Some(ControlCommand::Drain);
    let response = match command {
        Some(ControlCommand::Drain) => serde_json::json!({"status": "draining"}),
        Some(ControlCommand::Status { nonce }) => serde_json::json!({
            "schema_version": "runtime_service_status.v1",
            "nonce": nonce,
            "owner": owner.descriptor(),
            "configuration": config,
        }),
        Some(ControlCommand::ConfirmedDrain { .. }) => unreachable!(),
        Some(ControlCommand::IdleConfirmedDrain { .. }) => unreachable!(),
        None => serde_json::json!({"status": "rejected"}),
    };
    let mut response = serde_json::to_vec(&response)?;
    response.push(b'\n');
    // A disconnected client must not undo an already authenticated drain.
    let _ = tokio::time::timeout(Duration::from_secs(1), stream.write_all(&response)).await;
    Ok(if drain {
        ControlObservation::Drain(None)
    } else {
        ControlObservation::Continue
    })
}

fn pools_match(
    config: &ServiceConfig,
    expected: Option<(u64, u64)>,
    compute: Option<&FmsSchedulerResourcePool>,
    prep: Option<&FmsPreparationResourcePool>,
) -> bool {
    expected.is_some_and(|expected| {
        compute.is_some_and(|p| {
            p.pool_id == config.compute_pool_id
                && p.generation == expected.0
                && p.resources == config.compute_resources
        }) && prep.is_some_and(|p| {
            p.pool_id == config.preparation_pool_id
                && p.generation == expected.1
                && p.resources == config.preparation_resources
        })
    })
}

fn main() {
    if let Err(error) = run() {
        eprintln!("native runtime service failed: {error:#}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--config")) {
        bail!("usage: fullmag-runtime-service --config <absolute-json-path>");
    }
    let path = PathBuf::from(args.next().context("missing --config path")?);
    if !path.is_absolute() || args.next().is_some() {
        bail!("service requires exactly one absolute config path");
    }
    let config = ServiceConfig::read(&path)?;
    let startup_deadline = Instant::now() + Duration::from_secs(config.startup_timeout_seconds);
    let store = fullmag_runtime_control::retry_store_writer_busy(|| {
        SessionStore::open_existing(&config.store_root)
    })?;
    let identity = fullmag_build_info::identity();
    if identity.git_commit.len() != 40
        || !identity.git_commit.bytes().all(|b| b.is_ascii_hexdigit())
        || identity.source_snapshot_sha256.len() != 64
        || !identity
            .source_snapshot_sha256
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        bail!("runtime service requires a source-pinned build identity");
    }
    let bin = std::env::current_exe()?
        .parent()
        .context("service executable has no parent")?
        .to_path_buf();
    for name in [
        "fullmag-api-resource-pool",
        "fullmag-api-preparation-resource-pool",
        "fullmag-api-accepted-scheduler",
        "fullmag-api-accepted-fem-preparation-scheduler",
        "fullmag-api-accepted-worker",
        "fullmag-api-accepted-fem-preparer",
    ] {
        executable(&bin, name)?;
    }
    let mut owner = RuntimeServiceOwner::acquire(&store, &config.target_id)?;
    owner.set_execution_identity(
        identity.git_commit,
        identity.source_snapshot_sha256,
        &config.compute_pool_id,
        &config.preparation_pool_id,
    )?;
    let token = owner.owner_token().to_owned();
    let logs = checked_path(store.root(), &format!("runtime-services/{token}"))?;
    std::fs::create_dir(&logs)?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        owner.set_control_address(Some(listener.local_addr()?.to_string()))?;
        let mut children = Schedulers::default();
        let mut generations = None;
        let mut unknown_publishers = Vec::new();
        let mut drain_confirmation = None;
        let work: Result<()> = async {
            let pools = publish_pools(
                &config,
                &store,
                &bin,
                &logs,
                &mut unknown_publishers,
                startup_deadline,
            )?;
            generations = Some(pools);
            for role in ["compute", "preparation"] {
                children
                    .0
                    .push(spawn_scheduler(&config, &bin, &logs, role, &token)?);
            }
            await_event(
                &mut children,
                "boot",
                &token,
                &config,
                pools,
                startup_deadline,
            )
            .await?;
            for child in &mut children.0 {
                child.release()?;
            }
            await_event(
                &mut children,
                "ready",
                &token,
                &config,
                pools,
                startup_deadline,
            )
            .await?;
            owner.publish(
                RuntimeServiceState::Ready,
                Some(pools.0),
                Some(pools.1),
                children.describe(),
            )?;
            let mut heartbeat = Instant::now();
            loop {
                children.poll()?;
                match drain_requested(&listener, &owner, &config, &store).await? {
                    ControlObservation::Continue => {}
                    ControlObservation::Drain(confirmation) => {
                        drain_confirmation = confirmation;
                        break;
                    }
                }
                if heartbeat.elapsed() >= Duration::from_secs(1) {
                    let compute = store
                        .read_scheduler_resource_pool(&config.compute_pool_id)?
                        .context("service compute pool disappeared")?;
                    let prep = store
                        .read_preparation_resource_pool(&config.preparation_pool_id)?
                        .context("service preparation pool disappeared")?;
                    if compute.generation != pools.0
                        || prep.generation != pools.1
                        || compute.resources != config.compute_resources
                        || prep.resources != config.preparation_resources
                    {
                        bail!("service-owned resource pool changed outside its configuration");
                    }
                    owner.publish(
                        RuntimeServiceState::Ready,
                        Some(pools.0),
                        Some(pools.1),
                        children.describe(),
                    )?;
                    heartbeat = Instant::now();
                }
            }
            Ok(())
        }
        .await;
        let compute_observation = store.read_scheduler_resource_pool(&config.compute_pool_id);
        let prep_observation = store.read_preparation_resource_pool(&config.preparation_pool_id);
        let compute = compute_observation
            .ok()
            .flatten()
            .map(|p| p.generation)
            .or(generations.map(|p| p.0));
        let preparation = prep_observation
            .ok()
            .flatten()
            .map(|p| p.generation)
            .or(generations.map(|p| p.1));
        let publish_draining = owner.publish(
            RuntimeServiceState::Draining,
            compute,
            preparation,
            children.describe(),
        );
        let finish = children.finish(&token, Duration::from_secs(config.drain_timeout_seconds));
        // Fence both pool observations and terminal publication against their
        // existing writer/CAS updates; a pair of loose reads is not a snapshot.
        let _terminal_transaction =
            match fullmag_runtime_control::retry_store_writer_busy(|| store.write_transaction()) {
                Ok(transaction) => transaction,
                Err(error) => {
                    owner.publish(
                        RuntimeServiceState::Unknown,
                        compute,
                        preparation,
                        children
                            .describe()
                            .into_iter()
                            .chain(unknown_publishers.iter().cloned())
                            .collect(),
                    )?;
                    return Err(error).context("acquire terminal runtime pool observation fence");
                }
            };

        let compute_observation = store.read_scheduler_resource_pool(&config.compute_pool_id);
        let prep_observation = store.read_preparation_resource_pool(&config.preparation_pool_id);
        let generations_known = compute_observation.is_ok() && prep_observation.is_ok();
        let pools_intact = pools_match(
            &config,
            generations,
            compute_observation.as_ref().ok().and_then(|p| p.as_ref()),
            prep_observation.as_ref().ok().and_then(|p| p.as_ref()),
        );
        let compute = compute_observation
            .ok()
            .flatten()
            .map(|p| p.generation)
            .or(generations.map(|p| p.0));
        let preparation = prep_observation
            .ok()
            .flatten()
            .map(|p| p.generation)
            .or(generations.map(|p| p.1));

        let clean = work.is_ok()
            && publish_draining.is_ok()
            && finish.is_ok()
            && generations_known
            && pools_intact
            && unknown_publishers.is_empty();
        owner.publish(
            if clean {
                RuntimeServiceState::Drained
            } else if !generations_known
                || !unknown_publishers.is_empty()
                || children.0.iter().any(|c| c.status.is_none())
            {
                RuntimeServiceState::Unknown
            } else {
                RuntimeServiceState::Failed
            },
            compute,
            preparation,
            children
                .describe()
                .into_iter()
                .chain(unknown_publishers)
                .collect(),
        )?;
        if let Some(mut confirmation) = drain_confirmation {
            let schema = if confirmation.idle_fence.is_some() {
                "runtime_service_idle_drain.v1"
            } else {
                "runtime_service_drain.v1"
            };
            let mut value = serde_json::json!({
                "schema_version": schema,
                "nonce": confirmation.nonce,
                "owner": owner.descriptor(),
                "configuration": config,
            });
            if let Some(fence) = confirmation.idle_fence {
                value["admission_fence"] = serde_json::to_value(fence)?;
            }
            let mut response = serde_json::to_vec(&value)?;
            response.push(b'\n');
            // Disconnect cannot undo the already authenticated drain. The
            // caller must reconcile an unknown outcome; it cannot infer idle.
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                confirmation.stream.write_all(&response),
            )
            .await;
        }
        work?;
        publish_draining?;
        finish?;
        if !generations_known {
            bail!("terminal service pool observation unknown");
        }
        if !pools_intact {
            bail!("terminal service pool identity/generation/membership mismatch");
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drain_is_owner_scoped_and_versioned() {
        let request = br#"{"schema_version":"runtime_service_control.v1","owner_token":"owner-a","command":"drain"}"#;
        assert!(valid_drain_request(request, "owner-a"));
        assert!(!valid_drain_request(request, "owner-b"));
        assert!(!valid_drain_request(br#"{"schema_version":"runtime_service_control.v2","owner_token":"owner-a","command":"drain"}"#, "owner-a"));
        assert!(!valid_drain_request(br#"{"schema_version":"runtime_service_control.v1","owner_token":"owner-a","command":"stop"}"#, "owner-a"));
        assert!(!valid_drain_request(br#"{"schema_version":"runtime_service_control.v1","owner_token":"owner-a","command":"drain","extra":true}"#, "owner-a"));
    }
    #[test]
    fn status_requires_owner_version_and_bounded_challenge() {
        let request = br#"{"schema_version":"runtime_service_control.v1","owner_token":"owner-a","command":"status","nonce":"fresh-123"}"#;
        assert_eq!(
            control_command(request, "owner-a"),
            Some(ControlCommand::Status {
                nonce: "fresh-123".into()
            })
        );
        assert_eq!(control_command(request, "owner-b"), None);
        for nonce in ["", "invalid space", &"a".repeat(129)] {
            let request = serde_json::json!({"schema_version":"runtime_service_control.v1", "owner_token":"owner-a", "command":"status", "nonce":nonce});
            assert_eq!(
                control_command(&serde_json::to_vec(&request).unwrap(), "owner-a"),
                None
            );
        }
        assert_eq!(control_command(br#"{"schema_version":"runtime_service_control.v1","owner_token":"owner-a","command":"status"}"#, "owner-a"), None);
    }
    #[test]
    fn confirmed_drain_requires_owner_and_fresh_bounded_challenge() {
        let request = br#"{"schema_version":"runtime_service_control.v1","owner_token":"owner-a","command":"drain_confirmed","nonce":"fresh-123"}"#;
        assert_eq!(
            control_command(request, "owner-a"),
            Some(ControlCommand::ConfirmedDrain {
                nonce: "fresh-123".into()
            })
        );
        assert_eq!(control_command(request, "owner-b"), None);
        for nonce in [None, Some(""), Some("invalid space")] {
            let request = serde_json::json!({"schema_version":"runtime_service_control.v1","owner_token":"owner-a","command":"drain_confirmed","nonce":nonce});
            assert_eq!(
                control_command(&serde_json::to_vec(&request).unwrap(), "owner-a"),
                None
            );
        }
    }
    #[test]
    #[cfg(any(windows, target_os = "linux"))]
    fn child_ignoring_drain_remains_unknown_after_deadline() {
        let root =
            std::env::temp_dir().join(format!("fullmag-service-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let stdout = root.join("fixture.stdout");
        let output = File::create(&stdout).unwrap();
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("powershell.exe");
            command.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 5",
            ]);
            command
        };
        #[cfg(target_os = "linux")]
        let mut command = {
            let mut command = Command::new("/bin/sleep");
            command.arg("5");
            command
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::from(output))
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take();
        let mut children = Schedulers(vec![SchedulerChild {
            role: "compute",
            child,
            input,
            stdout,
            released: true,
            status: None,
            observation_unknown: false,
        }]);
        let start = Instant::now();
        let result = children.finish("fixture", Duration::from_millis(50));
        let elapsed = start.elapsed();
        let unknown = children.0[0].status.is_none();
        // This exact fixture owns no scientific task/lease. Clean up only it.
        let _ = children.0[0].child.kill();
        children.0[0].status = children.0[0].child.wait().ok();
        drop(children);
        std::fs::remove_dir_all(&root).unwrap();
        assert!(result.is_err());
        assert!(unknown);
        assert!(elapsed < Duration::from_secs(2));
    }

    fn config() -> ServiceConfig {
        let budget = fullmag_session::FmsResourceBudget {
            cpu_millis: 1000,
            memory_bytes: 1024,
            storage_bytes: 1024,
            gpu_memory_bytes: 0,
        };
        ServiceConfig {
            schema_version: "runtime_service_config.v1".into(),
            store_root: std::env::temp_dir(),
            target_id: "native-local".into(),
            compute_pool_id: "compute".into(),
            preparation_pool_id: "prep".into(),
            compute_resources: vec![FmsSchedulerResourceOffer {
                resource_id: "compute.cpu".into(),
                kind: fullmag_session::FmsResourceKind::Cpu,
                budget: budget.clone(),
            }],
            preparation_resources: vec![FmsPreparationResourceOffer {
                resource_id: "prep.cpu".into(),
                budget,
            }],
            worker_timeout_seconds: 10,
            preparation_timeout_seconds: 10,
            heartbeat_interval_milliseconds: 100,
            startup_timeout_seconds: 10,
            drain_timeout_seconds: 10,
        }
    }
    #[test]
    fn terminal_pool_fence_rejects_missing_generation_and_membership_changes() {
        let config = config();
        let mut compute = FmsSchedulerResourcePool {
            schema_version: FMS_SCHEDULER_RESOURCE_POOL_SCHEMA.into(),
            pool_id: config.compute_pool_id.clone(),
            generation: 1,
            resources: config.compute_resources.clone(),
        };
        let prep = FmsPreparationResourcePool {
            schema_version: FMS_PREPARATION_RESOURCE_POOL_SCHEMA.into(),
            pool_id: config.preparation_pool_id.clone(),
            generation: 1,
            resources: config.preparation_resources.clone(),
        };
        assert!(pools_match(
            &config,
            Some((1, 1)),
            Some(&compute),
            Some(&prep)
        ));
        assert!(!pools_match(&config, Some((1, 1)), Some(&compute), None));
        compute.generation = 2;
        assert!(!pools_match(
            &config,
            Some((1, 1)),
            Some(&compute),
            Some(&prep)
        ));
        compute.generation = 1;
        compute.resources[0].budget.memory_bytes += 1;
        assert!(!pools_match(
            &config,
            Some((1, 1)),
            Some(&compute),
            Some(&prep)
        ));
    }

    #[test]
    fn service_rejects_colliding_resource_identity_and_unbounded_startup() {
        let mut config = config();
        assert!(config.validate().is_ok());
        config.preparation_resources[0].resource_id =
            config.compute_resources[0].resource_id.clone();
        assert!(config.validate().is_err());
        config.preparation_resources[0].resource_id = "prep.cpu".into();
        config.startup_timeout_seconds = 301;
        assert!(config.validate().is_err());
        config.startup_timeout_seconds = 10;
        config.compute_resources[0].kind = fullmag_session::FmsResourceKind::Storage;
        assert!(config.validate().is_err());
    }
}
