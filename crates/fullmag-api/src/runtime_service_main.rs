//! Native accepted-run service. UI is an attaching client, never its owner.
#[path = "compute_operator_env.rs"]
mod compute_operator_env;
use anyhow::{bail, Context, Result};
use fullmag_session::{
    compute_node_snapshot::Reported,
    host_resource_ledger::{
        HostInventoryOwner, HostInventoryOwnerDescriptor, HostResourceLedger,
        HostResourceLedgerPolicy, HostRuntimeReadiness,
        HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2,
    },
    repository_path::{checked_path, validate_store_id},
    runtime_service::{
        RuntimeServiceChild, RuntimeServiceConfig as ServiceConfig, RuntimeServiceOwner,
        RuntimeServiceState, RUNTIME_SERVICE_CONFIG_SCHEMA_V2,
    },
    runtime_service_host::{
        RuntimeServiceHostExecution, RuntimeServiceHostPlacement,
        RUNTIME_SERVICE_HOST_EXECUTION_SCHEMA_V1,
    },
    FmsPreparationResourceOffer, FmsPreparationResourcePool, FmsResourceBudget, FmsResourceKind,
    FmsSchedulerResourceOffer, FmsSchedulerResourcePool, SessionStore,
    FMS_PREPARATION_RESOURCE_POOL_SCHEMA, FMS_SCHEDULER_RESOURCE_POOL_SCHEMA,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    future::Future,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    pin::Pin,
    process::{Child, ChildStdin, Command, Stdio},
    sync::Arc,
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

async fn publish_compute_node_sample(
    ledger: Arc<HostResourceLedger>,
    inventory_owner: Option<Arc<HostInventoryOwner>>,
    expected_generation: Option<String>,
) -> Result<Option<Arc<HostInventoryOwner>>> {
    tokio::task::spawn_blocking(move || -> Result<Option<Arc<HostInventoryOwner>>> {
        if let Some(expected) = expected_generation.as_deref() {
            fullmag_runtime_control::retry_store_writer_busy(|| {
                ledger.validate_runtime_generation(expected)
            })?;
        }
        let inventory_owner = match inventory_owner {
            Some(owner) => Some(owner),
            None => {
                // StoreWriterBusy can occur only while entering the ledger
                // writer for this operation. Native owner-lock contention is
                // reported as Ok(None) and must not be turned into a retry.
                fullmag_runtime_control::retry_store_writer_busy(|| {
                    ledger.try_acquire_inventory_owner()
                })?
                .map(Arc::new)
            }
        };
        let Some(inventory_owner) = inventory_owner else {
            return Ok(None);
        };
        let previous = fullmag_runtime_control::retry_store_writer_busy(|| {
            ledger.read_compute_node_snapshot()
        })?;
        let snapshot = if ledger.policy().schema_version
            == fullmag_session::host_resource_ledger::HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2
        {
            let readiness = fullmag_runtime_control::retry_store_writer_busy(|| {
                ledger.read_runtime_readiness()
            })?;
            fullmag_runtime_control::compute_node_probe::validate_native_fem_gpu_readiness(
                &readiness,
            )?;
            fullmag_runtime_control::compute_node_probe::sample_compute_node_for_owner_with_readiness(
                &ledger,
                inventory_owner.descriptor(),
                previous.as_ref(),
                &readiness,
            )?
        } else {
            fullmag_runtime_control::compute_node_probe::sample_compute_node_for_owner(
                &ledger,
                inventory_owner.descriptor(),
                previous.as_ref(),
            )?
        };
        fullmag_runtime_control::retry_store_writer_busy(|| {
            ledger.publish_compute_node_snapshot_with_owner_for_generation(
                &inventory_owner,
                &snapshot,
                expected_generation.as_deref(),
            )
        })
        .with_context(|| {
            // Retain the observed identity when publication rejects a sample;
            // the rejected snapshot is deliberately never written to the CAS.
            let gpu_inventory = snapshot.gpus.known_value().map(|devices| {
                devices.iter().map(|gpu| serde_json::json!({
                    "uuid": gpu.uuid,
                    "pci_id": gpu.pci_id.known_value(),
                    "partition": gpu.partition.known_value(),
                    "topology": gpu.topology.known_value(),
                })).collect::<Vec<_>>()
            });
            format!(
                "compute-node sample rejected: observed_inventory={}, expected_inventory={}, cpu_topology_matches_previous={:?}, allowed_cpu_ids={:?}, cpu_quota={:?}, gpu_inventory={}",
                snapshot.inventory_sha256,
                ledger.policy().topology_sha256,
                previous.as_ref().map(|old| old.cpu.topology.known_value() == snapshot.cpu.topology.known_value()),
                snapshot.cpu.os_constraints.allowed_logical_cpu_ids.known_value(),
                snapshot.cpu.os_constraints.quota.known_value(),
                serde_json::json!(gpu_inventory),
            )
        })?;
        Ok(Some(inventory_owner))
    })
    .await
    .context("compute-node sampling worker failed")?
}

const MAX_CONSECUTIVE_SAMPLE_STORE_WRITER_BUSY: u32 = 5;
const HOST_ADMISSION_DEFERRAL_BUDGET: Duration = Duration::from_secs(60);

fn is_store_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
}

fn sample_store_writer_busy_within_budget(consecutive: &mut u32) -> bool {
    *consecutive = consecutive.saturating_add(1);
    *consecutive <= MAX_CONSECUTIVE_SAMPLE_STORE_WRITER_BUSY
}

fn host_admission_deferral_within_budget(deferred_at: &mut Option<Instant>, now: Instant) -> bool {
    let started_at = deferred_at.get_or_insert(now);
    now.duration_since(*started_at) < HOST_ADMISSION_DEFERRAL_BUDGET
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
    crate::compute_operator_env::remove_local_compute_operator_token(&mut command);
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
    configuration_path: &Path,
    bin: &Path,
    logs: &Path,
    role: &'static str,
    owner: &str,
) -> Result<SchedulerChild> {
    let max_concurrency = config.scheduler_concurrency(role)?;
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
            "--max-tasks",
            "0",
            "--max-idle-polls",
            "0",
        ])
        .arg("--max-concurrency")
        .arg(max_concurrency.to_string())
        .arg("--heartbeat-interval-milliseconds")
        .arg(config.heartbeat_interval_milliseconds.to_string());
    if config.host_execution.is_some() {
        command
            .arg("--host-service-config")
            .arg(configuration_path)
            .arg("--host-config-sha256")
            .arg(fullmag_session::canonical_json_sha256(
                &serde_json::to_value(config)?,
            ));
    }
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

enum RuntimeLoopEvent<T, U> {
    SampleCompleted { sample: T, control: U },
    ControlCompleted(U),
}

type ComputeNodeSampleFuture =
    Pin<Box<dyn Future<Output = Result<Option<Arc<HostInventoryOwner>>>> + Send>>;

/// Keep both operations pinned while one wins the race. In particular, a
/// control future may already own an accepted socket when the sample future
/// completes; dropping it would reset that status/drain request.
async fn select_sample_and_control<S, C>(
    mut sample: Pin<&mut S>,
    mut control: Pin<&mut C>,
) -> RuntimeLoopEvent<S::Output, C::Output>
where
    S: Future + ?Sized,
    C: Future + ?Sized,
{
    tokio::select! {
        sample_result = sample.as_mut() => {
            let control_result = control.as_mut().await;
            RuntimeLoopEvent::SampleCompleted {
                sample: sample_result,
                control: control_result,
            }
        }
        control_result = control.as_mut() => RuntimeLoopEvent::ControlCompleted(control_result),
    }
}

async fn select_pending_sample_with_control(
    sample: Pin<&mut (dyn Future<Output = Result<Option<Arc<HostInventoryOwner>>>> + Send)>,
    listener: &TcpListener,
    owner: &RuntimeServiceOwner,
    config: &ServiceConfig,
    store: &SessionStore,
) -> RuntimeLoopEvent<
    Result<Option<Arc<HostInventoryOwner>>>,
    Result<ControlObservation>,
> {
    // The control future is scoped to this helper. If sampling wins, the
    // generic selector joins it before returning, so this scope never drops
    // an accepted control socket. If control wins, it is already complete.
    let mut control = Box::pin(drain_requested(listener, owner, config, store));
    select_sample_and_control(sample, control.as_mut()).await
}

async fn join_compute_node_sample(
    sample: ComputeNodeSampleFuture,
) -> Result<Option<Arc<HostInventoryOwner>>> {
    // This is the only exit from the control-first branch. Keeping the join
    // explicit makes it impossible to detach the spawn_blocking publisher.
    sample.await
}

fn defer_control_result(
    result: Result<ControlObservation>,
    deferred_control: &mut Option<ControlObservation>,
    deferred_control_error: &mut Option<anyhow::Error>,
) {
    match result {
        Ok(ControlObservation::Continue) => {}
        Ok(observation @ ControlObservation::Drain(_)) => {
            *deferred_control = Some(observation);
        }
        Err(error) => *deferred_control_error = Some(error),
    }
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

#[derive(Debug, Serialize)]
struct DockerHostIdentity {
    host_id: String,
    node_id: String,
    runtime_owner_id: String,
    boot_id: String,
    inventory_sha256: String,
    capabilities_sha256: String,
    allowed_cpu_ids: BTreeSet<u32>,
    gpu_uuids: Vec<String>,
}

#[derive(Debug, Serialize)]
struct DockerHostProfile {
    schema_version: String,
    configuration: ServiceConfig,
    host_identity: DockerHostIdentity,
    readiness: HostRuntimeReadiness,
    runtime_generation_sha256: String,
}

struct DockerHostInitArgs {
    ledger_root: PathBuf,
    store_root: PathBuf,
    readiness_path: Option<PathBuf>,
    host_id: String,
}

fn explicit_absolute_path(value: OsString, field: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
        || path.file_name().is_none()
    {
        bail!("{field} must be an absolute path without parent traversal");
    }
    Ok(path)
}

fn parse_docker_host_init_args(
    mut args: impl Iterator<Item = OsString>,
) -> Result<DockerHostInitArgs> {
    let mut ledger_root = None;
    let mut store_root = None;
    let mut readiness_path = None;
    let mut host_id = None;
    while let Some(flag) = args.next() {
        let name = flag.to_str().context("initializer argument is not UTF-8")?;
        let value = args.next().with_context(|| format!("missing value for {name}"))?;
        match name {
            "--ledger-root" => ledger_root = Some(explicit_absolute_path(value, name)?),
            "--store-root" => store_root = Some(explicit_absolute_path(value, name)?),
            "--native-fem-gpu-readiness" => {
                readiness_path = Some(explicit_absolute_path(value, name)?)
            }
            "--host-id" => {
                let value = value.to_str().context("host ID is not UTF-8")?.to_owned();
                if host_id.replace(value).is_some() {
                    bail!("initializer received duplicate --host-id");
                }
            }
            _ => bail!("unsupported Docker host initializer argument `{name}`"),
        }
    }
    let host_id = host_id
        .or_else(|| std::env::var("FULLMAG_DOCKER_HOST_ID").ok())
        .unwrap_or_else(|| "docker-all-host".into());
    let readiness_path = readiness_path
        .or_else(|| std::env::var_os("FULLMAG_NATIVE_FEM_GPU_READINESS").map(PathBuf::from))
        .map(|path| explicit_absolute_path(path.into_os_string(), "native readiness"))
        .transpose()?;
    let args = DockerHostInitArgs {
        ledger_root: ledger_root.context("missing --ledger-root")?,
        store_root: store_root.context("missing --store-root")?,
        readiness_path,
        host_id,
    };
    if args.ledger_root == args.store_root
        || args.readiness_path.as_ref().is_some_and(|path| path == &args.ledger_root)
    {
        bail!("Docker host initializer paths must identify distinct namespaces");
    }
    Ok(args)
}

fn required_reported<'a, T>(value: &'a Reported<T>, label: &str) -> Result<&'a T> {
    match value {
        Reported::Available { value } => Ok(value),
        Reported::Unavailable { .. } => bail!("Docker host profile requires current {label}"),
    }
}

fn required_observation<'a, T>(value: &'a fullmag_session::compute_node_snapshot::Observation<T>, label: &str) -> Result<&'a T> {
    match value {
        fullmag_session::compute_node_snapshot::Observation::Available { value } => Ok(value),
        fullmag_session::compute_node_snapshot::Observation::Unavailable { .. } => {
            bail!("Docker host profile requires current {label}")
        }
    }
}

fn docker_host_cpu_placements(
    allowed_cpu_ids: &BTreeSet<u32>,
    total_cpu_millis: u64,
    compute_cpu_millis: u64,
    preparation_cpu_millis: u64,
) -> Result<(BTreeSet<u32>, BTreeSet<u32>)> {
    if allowed_cpu_ids.is_empty() {
        bail!(
            "Docker host profile requires explicit OS-allowed CPU IDs for pinned compute and preparation placements"
        );
    }
    if compute_cpu_millis == 0 || preparation_cpu_millis == 0 {
        bail!("Docker host pinned compute and preparation CPU offers must be positive");
    }
    let requested_cpu_millis = compute_cpu_millis
        .checked_add(preparation_cpu_millis)
        .context("Docker host CPU offer budgets overflowed")?;
    if requested_cpu_millis > total_cpu_millis {
        bail!(
            "Docker host CPU offers require {requested_cpu_millis} milli-CPUs but the bounded host capacity is {total_cpu_millis}"
        );
    }
    let compute_cpu_count = usize::try_from(compute_cpu_millis.div_ceil(1000))
        .context("Docker compute CPU placement count does not fit in usize")?;
    let preparation_cpu_count = usize::try_from(preparation_cpu_millis.div_ceil(1000))
        .context("Docker preparation CPU placement count does not fit in usize")?;
    let required_cpu_count = compute_cpu_count
        .checked_add(preparation_cpu_count)
        .context("Docker CPU placement count overflowed")?;
    if allowed_cpu_ids.len() < required_cpu_count {
        bail!(
            "Docker host profile requires {required_cpu_count} disjoint allowed CPU IDs for its pinned compute/preparation offers, observed {}",
            allowed_cpu_ids.len()
        );
    }
    let ordered_cpu_ids = allowed_cpu_ids.iter().copied().collect::<Vec<_>>();
    let compute_cpu_ids = ordered_cpu_ids[..compute_cpu_count]
        .iter()
        .copied()
        .collect();
    let preparation_cpu_ids = ordered_cpu_ids[compute_cpu_count..required_cpu_count]
        .iter()
        .copied()
        .collect();
    Ok((compute_cpu_ids, preparation_cpu_ids))
}

fn initialize_docker_host(args: impl Iterator<Item = OsString>) -> Result<()> {
    let args = parse_docker_host_init_args(args)?;
    let fixture_readiness = std::env::var("FULLMAG_DOCKER_HOST_READINESS_FIXTURE")
        .ok()
        .is_some_and(|value| value == "1");
    if args.readiness_path.is_some() && !fixture_readiness {
        bail!(
            "--native-fem-gpu-readiness is restricted to FULLMAG_DOCKER_HOST_READINESS_FIXTURE=1"
        );
    }
    let readiness = match (fixture_readiness, args.readiness_path.as_deref()) {
        (true, Some(path)) => {
            fullmag_runtime_control::compute_node_probe::load_native_fem_gpu_readiness(path)?
        }
        (true, None) => bail!(
            "FULLMAG_DOCKER_HOST_READINESS_FIXTURE=1 requires --native-fem-gpu-readiness"
        ),
        (false, None) => {
            fullmag_runtime_control::compute_node_probe::probe_native_fem_gpu_readiness()?
        }
        (false, Some(_)) => unreachable!("fixture readiness path was rejected above"),
    };
    let node_id = HostResourceLedger::node_id_for_host_id(&args.host_id);
    let runtime_owner_id = HostResourceLedger::owner_id_for_host_id(&args.host_id);
    let provisional_owner = HostInventoryOwnerDescriptor {
        host_owner_id: runtime_owner_id.clone(),
        host_owner_epoch: 1,
    };
    let provisional = fullmag_runtime_control::compute_node_probe::sample_compute_node_for_identity(
        node_id.clone(),
        runtime_owner_id.clone(),
        1,
        &provisional_owner,
        None,
        &readiness,
    )?;
    let allowed_cpu_ids = required_reported(
        &provisional.cpu.os_constraints.allowed_logical_cpu_ids,
        "OS-allowed CPU IDs",
    )?
    .clone();
    let cpu_millis = *required_observation(
        &provisional.cpu.effective_capacity_millis,
        "effective CPU capacity",
    )?;
    let memory_bytes = *required_observation(
        &provisional.memory.total_bytes,
        "total host memory",
    )?;
    if cpu_millis == 0 || memory_bytes == 0 {
        bail!("Docker host profile requires positive CPU and memory capacity");
    }
    let cpu_millis = cpu_millis.min(4000);
    let cpu_millis = if allowed_cpu_ids.is_empty() {
        cpu_millis
    } else {
        cpu_millis.min(
            u64::try_from(allowed_cpu_ids.len())
                .unwrap_or(u64::MAX)
                .saturating_mul(1000),
        )
    };
    let memory_bytes = memory_bytes.min(7 * 1024 * 1024 * 1024);
    if cpu_millis == 0 || memory_bytes == 0 {
        bail!("Docker host profile has no bounded CPU or memory capacity");
    }
    let devices = required_reported(&provisional.gpus, "NVIDIA GPU inventory")?;
    let mut gpu_vram_bytes_by_uuid = BTreeMap::new();
    for device in devices {
        let partition = required_reported(&device.partition, "GPU partition")?;
        if *partition != fullmag_session::compute_node_snapshot::GpuPartition::FullDevice {
            bail!("Docker host profile requires full physical GPU partitions");
        }
        let vram = *required_reported(&device.vram_bytes, "GPU VRAM")?;
        if vram == 0 {
            bail!("Docker host profile requires positive GPU VRAM");
        }
        if gpu_vram_bytes_by_uuid
            .insert(device.uuid.clone(), vram)
            .is_some()
        {
            bail!("Docker host profile received duplicate GPU UUIDs");
        }
    }
    if gpu_vram_bytes_by_uuid.len() != 1 {
        bail!("Docker host profile currently requires exactly one full physical NVIDIA GPU");
    }
    let storage_bytes = std::env::var("FULLMAG_DOCKER_STORAGE_BYTES")
        .ok()
        .map(|value| value.parse::<u64>().context("parse FULLMAG_DOCKER_STORAGE_BYTES"))
        .transpose()?
        .unwrap_or(7 * 1024 * 1024 * 1024);
    if storage_bytes == 0 {
        bail!("Docker host profile storage capacity must be positive");
    }
    let policy = HostResourceLedgerPolicy {
        schema_version: HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V2.into(),
        host_id: args.host_id.clone(),
        topology_sha256: provisional.inventory_sha256.clone(),
        revision: 1,
        owner_epoch: 1,
        total_budget: FmsResourceBudget {
            cpu_millis,
            memory_bytes,
            gpu_memory_bytes: 0,
            storage_bytes,
        },
        gpu_vram_bytes_by_uuid,
        allowed_cpu_ids,
    };
    policy.validate()?;
    let mut persisted_readiness = readiness.clone();
    let capabilities_sha256 = provisional.computed_capabilities_sha256()?;
    if persisted_readiness
        .inventory_sha256
        .as_ref()
        .is_some_and(|value| value != &provisional.inventory_sha256)
        || persisted_readiness
            .capabilities_sha256
            .as_ref()
            .is_some_and(|value| value != &capabilities_sha256)
    {
        bail!("native readiness digests differ from the current host probe");
    }
    persisted_readiness.inventory_sha256 = Some(provisional.inventory_sha256.clone());
    persisted_readiness.capabilities_sha256 = Some(capabilities_sha256.clone());
    let ledger = fullmag_runtime_control::retry_store_writer_busy(|| {
        HostResourceLedger::initialize_or_upgrade_with_readiness(
            &args.ledger_root,
            policy.clone(),
            persisted_readiness.clone(),
        )
    })?;
    let runtime_generation_sha256 = fullmag_runtime_control::retry_store_writer_busy(|| {
        ledger.read_runtime_generation_sha256()
    })?;
    let snapshot = if let Some(active_owner) = ledger.active_inventory_owner()? {
        let snapshot = ledger
            .read_compute_node_snapshot()?
            .context("active Docker host inventory owner has no published snapshot")?;
        if ledger.active_inventory_owner()?.as_ref() != Some(&active_owner) {
            bail!("Docker host inventory owner changed while reading its snapshot");
        }
        snapshot
    } else {
        let inventory_owner = ledger
            .try_acquire_inventory_owner()?
            .context("Docker host inventory owner became busy during initialization")?;
        let previous = fullmag_runtime_control::retry_store_writer_busy(|| {
            ledger.read_compute_node_snapshot()
        })?;
        let snapshot = fullmag_runtime_control::compute_node_probe::sample_compute_node_for_owner_with_readiness(
            &ledger,
            inventory_owner.descriptor(),
            previous.as_ref(),
            &persisted_readiness,
        )?;
        if snapshot.inventory_sha256 != policy.topology_sha256
            || snapshot.computed_capabilities_sha256()? != capabilities_sha256
        {
            bail!("current host probe changed while initializing the Docker ledger");
        }
        fullmag_runtime_control::retry_store_writer_busy(|| {
            ledger.publish_compute_node_snapshot_with_owner_for_generation(
                &inventory_owner,
                &snapshot,
                Some(&runtime_generation_sha256),
            )
        })?;
        snapshot
    };
    let cpu_offer_id = "docker-all.compute.cpu".to_owned();
    let prep_offer_id = "docker-all.preparation.cpu".to_owned();
    let offer_cpu_millis = cpu_millis.min(1000).max(1);
    let offer_memory = memory_bytes.min(1024 * 1024 * 1024).max(1);
    let cpu_offer_cpu_millis = cpu_millis
        .saturating_sub(offer_cpu_millis)
        .min(3000);
    if cpu_offer_cpu_millis == 0 {
        bail!(
            "Docker host profile requires positive bounded compute CPU capacity after its preparation allocation"
        );
    }
    let cpu_offer_memory = memory_bytes.min(6 * 1024 * 1024 * 1024).max(1);
    let (compute_cpu_ids, preparation_cpu_ids) = docker_host_cpu_placements(
        &policy.allowed_cpu_ids,
        cpu_millis,
        cpu_offer_cpu_millis,
        offer_cpu_millis,
    )?;
    let offer_budget = |gpu_memory_bytes| FmsResourceBudget {
        cpu_millis: offer_cpu_millis,
        memory_bytes: offer_memory,
        gpu_memory_bytes,
        storage_bytes,
    };
    let mut compute_resources = vec![FmsSchedulerResourceOffer {
        resource_id: cpu_offer_id.clone(),
        kind: FmsResourceKind::Cpu,
        budget: FmsResourceBudget {
            cpu_millis: cpu_offer_cpu_millis,
            memory_bytes: cpu_offer_memory,
            gpu_memory_bytes: 0,
            storage_bytes,
        },
    }];
    let mut compute_placements = BTreeMap::from([(
        cpu_offer_id,
        RuntimeServiceHostPlacement {
            cpu_ids: compute_cpu_ids.clone(),
            gpu_uuid: None,
        },
    )]);
    for (uuid, vram) in &policy.gpu_vram_bytes_by_uuid {
        let resource_id = format!("docker-all.compute.gpu-{}", uuid.trim_start_matches("GPU-"));
        validate_store_id(&resource_id)?;
        compute_resources.push(FmsSchedulerResourceOffer {
            resource_id: resource_id.clone(),
            kind: FmsResourceKind::Gpu,
            budget: offer_budget(*vram),
        });
        compute_placements.insert(
            resource_id,
            RuntimeServiceHostPlacement {
                cpu_ids: compute_cpu_ids.clone(),
                gpu_uuid: Some(uuid.clone()),
            },
        );
    }
    let preparation_resources = vec![FmsPreparationResourceOffer {
        resource_id: prep_offer_id.clone(),
        budget: offer_budget(0),
    }];
    let host_execution = RuntimeServiceHostExecution {
        schema_version: RUNTIME_SERVICE_HOST_EXECUTION_SCHEMA_V1.into(),
        ledger_root: args.ledger_root.clone(),
        runtime_generation_sha256: Some(runtime_generation_sha256.clone()),
        policy,
        compute_max_concurrency: 1,
        preparation_max_concurrency: 1,
        compute_placements,
        preparation_cpu_ids: BTreeMap::from([(prep_offer_id.clone(), preparation_cpu_ids)]),
    };
    let configuration = ServiceConfig {
        schema_version: RUNTIME_SERVICE_CONFIG_SCHEMA_V2.into(),
        store_root: args.store_root.clone(),
        target_id: "docker-all".into(),
        compute_pool_id: "docker-all.compute".into(),
        preparation_pool_id: "docker-all.preparation".into(),
        compute_resources,
        preparation_resources,
        worker_timeout_seconds: 31_536_000,
        preparation_timeout_seconds: 31_536_000,
        heartbeat_interval_milliseconds: 1000,
        startup_timeout_seconds: 60,
        drain_timeout_seconds: 60,
        host_execution: Some(host_execution),
    };
    configuration.validate()?;
    let gpu_uuids = snapshot
        .gpus
        .known_value()
        .context("published host snapshot has no GPU list")?
        .iter()
        .map(|device| device.uuid.clone())
        .collect::<Vec<_>>();
    let profile = DockerHostProfile {
        schema_version: "fullmag.docker-host-profile.v1".into(),
        configuration,
        host_identity: DockerHostIdentity {
            host_id: args.host_id,
            node_id,
            runtime_owner_id,
            boot_id: snapshot.boot_id,
            inventory_sha256: snapshot.inventory_sha256,
            capabilities_sha256,
            allowed_cpu_ids: snapshot
                .cpu
                .os_constraints
                .allowed_logical_cpu_ids
                .known_value()
                .cloned()
                .context("published host snapshot has no allowed CPU IDs")?,
            gpu_uuids,
        },
        readiness: persisted_readiness,
        runtime_generation_sha256,
    };
    let bytes = serde_json::to_vec(&profile)?;
    if bytes.len() > 256 * 1024 {
        bail!("Docker host profile exceeds its bounded output size");
    }
    println!("{}", String::from_utf8(bytes).context("Docker host profile is not UTF-8")?);
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("native runtime service failed: {error:#}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let mut args = std::env::args_os().skip(1);
    match args.next() {
        Some(value) if value == OsString::from("--initialize-docker-host") => {
            initialize_docker_host(args)
        }
        Some(value) if value == OsString::from("--config") => {
            let path = PathBuf::from(args.next().context("missing --config path")?);
            if !path.is_absolute() || args.next().is_some() {
                bail!("service requires exactly one absolute config path");
            }
            run_service(path)
        }
        _ => bail!("usage: fullmag-runtime-service --config <absolute-json-path> | --initialize-docker-host --ledger-root <absolute-path> --store-root <absolute-path> [--native-fem-gpu-readiness <absolute-json-path>] [--host-id <stable-id>]")
    }
}

fn run_service(path: PathBuf) -> Result<()> {
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
    let host_ledger = config
        .host_execution
        .as_ref()
        .map(|binding| {
            fullmag_runtime_control::retry_store_writer_busy(|| {
                HostResourceLedger::open(&binding.ledger_root, binding.policy.clone())
            })
            .context("open the configured host ledger for compute-node sampling")
            .map(Arc::new)
        })
        .transpose()?;
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
        let mut inventory_owner = None;
        let mut host_admission = None;
        let mut admission_unknown = false;
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
                    .push(spawn_scheduler(&config, &path, &bin, &logs, role, &token)?);
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
            if let Some(ledger) = host_ledger.as_ref() {
                host_admission = Some(
                    fullmag_runtime_control::host_runtime::HostRuntimeAdmission::open(&config)?
                        .context("host execution requires an initialized runtime admission context")?,
                );
                loop {
                    inventory_owner = publish_compute_node_sample(
                        Arc::clone(ledger),
                        inventory_owner.take(),
                        config.host_execution.as_ref().and_then(|binding| {
                            binding.runtime_generation_sha256.clone()
                        }),
                    )
                    .await
                    .context("initial compute-node sample is required before releasing host schedulers")?;
                    if host_admission
                        .as_ref()
                        .context("host admission context disappeared during startup")?
                        .has_current_compute_snapshot()?
                    {
                        break;
                    }
                    if Instant::now() >= startup_deadline {
                        bail!("no current host-owner sample became available before startup deadline");
                    }
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
            }
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
            let mut last_compute_node_sample = Instant::now();
            let mut pending_compute_node_sample: Option<ComputeNodeSampleFuture> = None;
            let mut consecutive_busy_samples = 0_u32;
            let mut admission_deferred_at = None;
            // A drain or control error observed while a sample is in flight
            // cannot make us leave the loop: doing so would drop the future
            // while its spawn_blocking worker continued to own the ledger.
            // Keep the observation until that one future has joined.
            let mut deferred_control = None;
            let mut deferred_control_error: Option<anyhow::Error> = None;
            loop {
                if pending_compute_node_sample.is_none() {
                    children.poll()?;
                    if last_compute_node_sample.elapsed() >= Duration::from_secs(5) {
                        if let Some(ledger) = host_ledger.as_ref() {
                            pending_compute_node_sample = Some(Box::pin(
                                publish_compute_node_sample(
                                    Arc::clone(ledger),
                                    inventory_owner.clone(),
                                    config.host_execution.as_ref().and_then(|binding| {
                                        binding.runtime_generation_sha256.clone()
                                    }),
                                ),
                            ));
                        } else {
                            last_compute_node_sample = Instant::now();
                        }
                    }
                }

                if pending_compute_node_sample.is_some() {
                    let event = select_pending_sample_with_control(
                        pending_compute_node_sample
                            .as_mut()
                            .expect("pending compute-node sample disappeared")
                            .as_mut(),
                        &listener,
                        &owner,
                        &config,
                        &store,
                    )
                    .await;
                    let sample_result = match event {
                        RuntimeLoopEvent::SampleCompleted {
                            sample,
                            control,
                        } => {
                            // The helper has joined the control future before
                            // returning, so an accepted status/drain socket is
                            // never cancelled when the sample wins the race.
                            pending_compute_node_sample = None;
                            defer_control_result(
                                control,
                                &mut deferred_control,
                                &mut deferred_control_error,
                            );
                            sample
                        }
                        RuntimeLoopEvent::ControlCompleted(control) => {
                            defer_control_result(
                                control,
                                &mut deferred_control,
                                &mut deferred_control_error,
                            );
                            if deferred_control.is_none() && deferred_control_error.is_none() {
                                continue;
                            }
                            // An authenticated drain or control error must
                            // wait for this exact sample to join before the
                            // outer loop can act on it.
                            join_compute_node_sample(
                                pending_compute_node_sample
                                    .take()
                                    .expect("pending compute-node sample disappeared"),
                            )
                            .await
                        }
                    };

                    match sample_result {
                        Ok(sample_owner) => {
                            consecutive_busy_samples = 0;
                            inventory_owner = sample_owner;
                        }
                        Err(error) => {
                            if is_store_writer_busy(&error)
                                && sample_store_writer_busy_within_budget(
                                    &mut consecutive_busy_samples,
                                )
                            {
                                tracing::warn!(
                                    error = ?error,
                                    consecutive_busy_samples,
                                    "compute-node sample deferred while the host ledger writer is busy"
                                );
                                last_compute_node_sample = Instant::now();
                                if let Some(control_error) = deferred_control_error.take() {
                                    return Err(control_error).context(
                                        "service control request failed while compute-node sampling was in flight",
                                    );
                                }
                                if let Some(ControlObservation::Drain(confirmation)) =
                                    deferred_control.take()
                                {
                                    drain_confirmation = confirmation;
                                    break;
                                }
                                continue;
                            }
                            admission_unknown = true;
                            owner.publish(
                                RuntimeServiceState::Unknown,
                                generations.map(|p| p.0),
                                generations.map(|p| p.1),
                                children
                                    .describe()
                                    .into_iter()
                                    .chain(unknown_publishers.iter().cloned())
                                    .collect(),
                            )?;
                            if let Some(control_error) = deferred_control_error.take() {
                                bail!("compute-node sample publication failed; host admission is unknown: {error:#}; deferred control request also failed: {control_error:#}");
                            }
                            bail!("compute-node sample publication failed; host admission is unknown: {error:#}");
                        }
                    }
                    last_compute_node_sample = Instant::now();
                    if let Some(control_error) = deferred_control_error.take() {
                        return Err(control_error).context(
                            "service control request failed while compute-node sampling was in flight",
                        );
                    }
                    if let Some(ControlObservation::Drain(confirmation)) = deferred_control.take()
                    {
                        drain_confirmation = confirmation;
                        break;
                    }
                    continue;
                }
                match drain_requested(&listener, &owner, &config, &store).await? {
                    ControlObservation::Continue => {}
                    ControlObservation::Drain(confirmation) => {
                        drain_confirmation = confirmation;
                        break;
                    }
                }
                if heartbeat.elapsed() >= Duration::from_secs(1) {
                    if let Some(admission) = host_admission.as_ref() {
                        match admission.compute_snapshot_admission_failure() {
                            Ok(None) => admission_deferred_at = None,
                            Ok(Some(reason)) => {
                                if !host_admission_deferral_within_budget(
                                    &mut admission_deferred_at,
                                    Instant::now(),
                                ) {
                                    admission_unknown = true;
                                    owner.publish(
                                        RuntimeServiceState::Unknown,
                                        generations.map(|p| p.0),
                                        generations.map(|p| p.1),
                                        children.describe(),
                                    )?;
                                    bail!(
                                        "host compute-node freshness or topology admission was lost: {reason}"
                                    );
                                }
                                // The ledger still refuses reservations. Continue
                                // pool validation and owner heartbeat so a live
                                // service is not mistaken for an expired owner.
                                tracing::debug!(%reason, "host compute-node admission deferred");
                            }
                            Err(error) if is_store_writer_busy(&error) => {
                                if !host_admission_deferral_within_budget(
                                    &mut admission_deferred_at,
                                    Instant::now(),
                                ) {
                                    admission_unknown = true;
                                    owner.publish(
                                        RuntimeServiceState::Unknown,
                                        generations.map(|p| p.0),
                                        generations.map(|p| p.1),
                                        children.describe(),
                                    )?;
                                    bail!("host compute-node admission observation failed: {error:#}");
                                }
                                tracing::warn!(error = ?error, "host admission observation deferred while the ledger writer is busy");
                            }
                            Err(error) => {
                                admission_unknown = true;
                                owner.publish(
                                    RuntimeServiceState::Unknown,
                                    generations.map(|p| p.0),
                                    generations.map(|p| p.1),
                                    children.describe(),
                                )?;
                                bail!("host compute-node admission observation failed: {error:#}");
                            }
                        }
                    }
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
            } else if admission_unknown
                || !generations_known
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
    fn docker_host_cpu_placements_are_sorted_disjoint_and_fail_closed() {
        let allowed_cpu_ids = std::collections::BTreeSet::from([13, 2, 8, 4]);
        let (compute_cpu_ids, preparation_cpu_ids) =
            docker_host_cpu_placements(&allowed_cpu_ids, 4000, 3000, 1000).unwrap();
        assert_eq!(compute_cpu_ids, std::collections::BTreeSet::from([2, 4, 8]));
        assert_eq!(preparation_cpu_ids, std::collections::BTreeSet::from([13]));
        assert!(compute_cpu_ids.is_disjoint(&preparation_cpu_ids));
        assert!(compute_cpu_ids
            .union(&preparation_cpu_ids)
            .all(|cpu_id| allowed_cpu_ids.contains(cpu_id)));

        let (non_integer_compute, non_integer_preparation) =
            docker_host_cpu_placements(&allowed_cpu_ids, 3500, 2500, 1000).unwrap();
        assert_eq!(non_integer_compute, compute_cpu_ids);
        assert_eq!(non_integer_preparation, preparation_cpu_ids);

        let two_cpu_ids = std::collections::BTreeSet::from([2, 13]);
        let (two_compute, two_preparation) =
            docker_host_cpu_placements(&two_cpu_ids, 2000, 1000, 1000).unwrap();
        assert_eq!(two_compute, std::collections::BTreeSet::from([2]));
        assert_eq!(two_preparation, std::collections::BTreeSet::from([13]));

        let three_cpu_ids = std::collections::BTreeSet::from([2, 4, 8]);
        let (three_compute, three_preparation) =
            docker_host_cpu_placements(&three_cpu_ids, 3000, 2000, 1000).unwrap();
        assert_eq!(three_compute, std::collections::BTreeSet::from([2, 4]));
        assert_eq!(three_preparation, std::collections::BTreeSet::from([8]));

        let undersized = std::collections::BTreeSet::from([2, 4, 8]);
        assert!(docker_host_cpu_placements(&undersized, 4000, 3000, 1000).is_err());
        let single_cpu = std::collections::BTreeSet::from([2]);
        assert!(docker_host_cpu_placements(&single_cpu, 2000, 1000, 1000).is_err());
        assert!(docker_host_cpu_placements(&single_cpu, 1000, 0, 1000).is_err());
        assert!(
            docker_host_cpu_placements(&std::collections::BTreeSet::new(), 4000, 3000, 1000,)
                .is_err()
        );
    }

    #[test]
    fn sample_writer_busy_budget_allows_five_cycles_only() {
        let mut consecutive = 0;
        for _ in 0..MAX_CONSECUTIVE_SAMPLE_STORE_WRITER_BUSY {
            assert!(sample_store_writer_busy_within_budget(&mut consecutive));
        }
        assert!(!sample_store_writer_busy_within_budget(&mut consecutive));
    }

    #[test]
    fn admission_deferral_uses_a_monotonic_sixty_second_budget() {
        let started = Instant::now();
        let mut deferred_at = None;
        assert!(host_admission_deferral_within_budget(
            &mut deferred_at,
            started,
        ));
        assert!(host_admission_deferral_within_budget(
            &mut deferred_at,
            started + HOST_ADMISSION_DEFERRAL_BUDGET - Duration::from_nanos(1),
        ));
        assert!(!host_admission_deferral_within_budget(
            &mut deferred_at,
            started + HOST_ADMISSION_DEFERRAL_BUDGET,
        ));
    }

    #[test]
    fn only_typed_store_writer_busy_is_classified_as_transient() {
        let busy = anyhow::Error::new(fullmag_session::StoreWriterBusy).context("wrapped");
        assert!(is_store_writer_busy(&busy));
        assert!(!is_store_writer_busy(&anyhow::anyhow!(
            "session store writer is busy"
        )));
    }

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

    #[derive(Clone, Copy)]
    enum PendingControlOutcome {
        Continue,
        Drain,
        Error,
    }

    struct PendingControl {
        gate: tokio::sync::oneshot::Receiver<()>,
        outcome: PendingControlOutcome,
        serviced: std::sync::Arc<tokio::sync::Notify>,
        completed: std::sync::Arc<std::sync::atomic::AtomicBool>,
        dropped_before_completion: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl Future for PendingControl {
        type Output = Result<ControlObservation>;

        fn poll(
            mut self: Pin<&mut Self>,
            context: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Self::Output> {
            self.serviced.notify_one();
            match Pin::new(&mut self.gate).poll(context) {
                std::task::Poll::Ready(Ok(())) => {
                    self.completed
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    match self.outcome {
                        PendingControlOutcome::Continue => {
                            std::task::Poll::Ready(Ok(ControlObservation::Continue))
                        }
                        PendingControlOutcome::Drain => {
                            std::task::Poll::Ready(Ok(ControlObservation::Drain(None)))
                        }
                        PendingControlOutcome::Error => std::task::Poll::Ready(Err(
                            anyhow::anyhow!("control request failed after acceptance"),
                        )),
                    }
                }
                std::task::Poll::Ready(Err(_)) => {
                    std::task::Poll::Ready(Err(anyhow::anyhow!("control gate closed")))
                }
                std::task::Poll::Pending => std::task::Poll::Pending,
            }
        }
    }

    impl Drop for PendingControl {
        fn drop(&mut self) {
            if !self.completed.load(std::sync::atomic::Ordering::SeqCst) {
                self.dropped_before_completion
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }

    #[tokio::test]
    async fn sampling_keeps_status_control_pinned_until_completion() {
        let (sample_sender, sample_receiver) = tokio::sync::oneshot::channel();
        let (control_sender, control_receiver) = tokio::sync::oneshot::channel();
        let serviced = std::sync::Arc::new(tokio::sync::Notify::new());
        let sample_completed = std::sync::Arc::new(tokio::sync::Notify::new());
        let completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let dropped_before_completion =
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let serviced_by_task = std::sync::Arc::clone(&serviced);
        let sample_completed_by_task = std::sync::Arc::clone(&sample_completed);
        let completed_by_task = std::sync::Arc::clone(&completed);
        let dropped_by_task = std::sync::Arc::clone(&dropped_before_completion);
        let serviced_wait = serviced.notified();
        let sample_completed_wait = sample_completed.notified();
        let task = tokio::spawn(async move {
            let mut sample = Box::pin(async move {
                sample_receiver
                    .await
                    .map_err(|_| anyhow::anyhow!("sample gate closed"))?;
                sample_completed_by_task.notify_one();
                Ok::<Option<Arc<HostInventoryOwner>>, anyhow::Error>(None)
            });
            let mut control = Box::pin(PendingControl {
                gate: control_receiver,
                outcome: PendingControlOutcome::Continue,
                serviced: serviced_by_task,
                completed: completed_by_task,
                dropped_before_completion: dropped_by_task,
            });
            select_sample_and_control(sample.as_mut(), control.as_mut()).await
        });

        tokio::time::timeout(Duration::from_secs(1), serviced_wait)
            .await
            .expect("control future was not polled while sampling was pending");
        assert!(!task.is_finished());
        sample_sender.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), sample_completed_wait)
            .await
            .expect("sample future did not complete");
        // The sample is complete, but the accepted control request is still
        // being serviced and must keep the join pending.
        assert!(!task.is_finished());
        assert!(!dropped_before_completion.load(std::sync::atomic::Ordering::SeqCst));
        control_sender.send(()).unwrap();
        match task.await.unwrap() {
            RuntimeLoopEvent::SampleCompleted {
                sample: Ok(None),
                control: Ok(ControlObservation::Continue),
            } => {}
            _ => panic!("sample/control completion order changed"),
        }
        assert!(completed.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!dropped_before_completion.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn control_first_drain_or_error_joins_the_pending_sample() {
        for outcome in [PendingControlOutcome::Drain, PendingControlOutcome::Error] {
            let (sample_sender, sample_receiver) = tokio::sync::oneshot::channel();
            let (control_sender, control_receiver) = tokio::sync::oneshot::channel();
            let completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let dropped_before_completion =
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mut sample: ComputeNodeSampleFuture = Box::pin(async move {
                sample_receiver
                    .await
                    .map_err(|_| anyhow::anyhow!("sample gate closed"))?;
                Ok::<Option<Arc<HostInventoryOwner>>, anyhow::Error>(None)
            });
            let mut control = Box::pin(PendingControl {
                gate: control_receiver,
                outcome,
                serviced: std::sync::Arc::new(tokio::sync::Notify::new()),
                completed: std::sync::Arc::clone(&completed),
                dropped_before_completion: std::sync::Arc::clone(&dropped_before_completion),
            });
            control_sender.send(()).unwrap();
            let event = select_sample_and_control(sample.as_mut(), control.as_mut()).await;
            match outcome {
                PendingControlOutcome::Drain => {
                    assert!(matches!(
                        event,
                        RuntimeLoopEvent::ControlCompleted(Ok(ControlObservation::Drain(None)))
                    ));
                }
                PendingControlOutcome::Error => {
                    assert!(matches!(event, RuntimeLoopEvent::ControlCompleted(Err(_))));
                }
                PendingControlOutcome::Continue => unreachable!(),
            }
            // This is the same join required by the production control-first
            // branch: authenticated drain and control errors cannot detach
            // the in-flight sample publisher.
            sample_sender.send(()).unwrap();
            assert!(join_compute_node_sample(sample).await.unwrap().is_none());
            assert!(completed.load(std::sync::atomic::Ordering::SeqCst));
            assert!(!dropped_before_completion.load(std::sync::atomic::Ordering::SeqCst));
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
            host_execution: None,
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
