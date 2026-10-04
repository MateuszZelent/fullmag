//! Durable ownership for one local runtime service per session store.
//!
//! The native file lock is authoritative.  The JSON descriptor is an
//! observable record of the last published state; it never replaces the
//! kernel lock and it is never used for PID- or age-based takeover.

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use uuid::Uuid;

use crate::repository_path::{checked_path, create_parent, validate_store_id};
use crate::runtime_service_startup::RuntimeServiceStartupGuard;
use crate::store::SessionStore;
use crate::{
    FmsPreparationResourceOffer, FmsPreparationResourcePool, FmsSchedulerResourceOffer,
    FmsSchedulerResourcePool, FMS_PREPARATION_RESOURCE_POOL_SCHEMA,
    FMS_SCHEDULER_RESOURCE_POOL_SCHEMA,
};

pub const RUNTIME_SERVICE_OWNER_SCHEMA: &str = "runtime_service_owner.v1";
pub const RUNTIME_SERVICE_OWNER_PROTOCOL: &str = "stdin-v1";
pub const RUNTIME_SERVICE_OWNER_LOCK_PATH: &str = "runtime-services/OWNER.lock";
pub const RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH: &str = "runtime-services/OWNER.json";

const LOCK_DESCRIPTOR: &[u8] = b"fullmag.runtime-service-owner.lock.v1\n";
const MAX_DESCRIPTOR_BYTES: usize = 256 * 1024;
const MAX_CHILDREN: usize = 32;
const MAX_HOST_BYTES: usize = 255;
const MAX_STATUS_BYTES: usize = 128;
const MAX_CONTROL_ADDRESS_BYTES: usize = 128;
const RUNTIME_SERVICE_COMPUTE_ROLE: &str = "compute";
const RUNTIME_SERVICE_PREPARATION_ROLE: &str = "preparation";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeServiceState {
    Starting,
    Ready,
    Draining,
    Drained,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeServiceChild {
    pub role: String,
    pub pid: u32,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeServiceOwnerDescriptor {
    pub schema_version: String,
    pub owner_token: String,
    pub process_start_token: String,
    pub pid: u32,
    pub host: String,
    pub target_id: String,
    pub protocol: String,
    pub state: RuntimeServiceState,
    pub acquired_at: DateTime<Utc>,
    pub heartbeat_at: DateTime<Utc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compute_pool_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_pool_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_snapshot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compute_pool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preparation_pool_id: Option<String>,
    pub children: Vec<RuntimeServiceChild>,
}

/// The native lock and the last durable owner descriptor.
///
/// Dropping this value releases only the native file lock.  It deliberately
/// does not publish `drained`, `failed`, or any other synthetic terminal state.
pub struct RuntimeServiceOwner {
    _lock: File,
    descriptor_path: PathBuf,
    descriptor: RuntimeServiceOwnerDescriptor,
}

impl RuntimeServiceOwner {
    /// Acquire the single service owner for the complete session store.
    ///
    /// A previous `starting`, `ready`, `draining`, or `unknown` descriptor is
    /// never taken over automatically, even when its native lock is currently
    /// free.  Controlled recovery is intentionally a later operation.
    pub fn acquire(store: &SessionStore, target_id: &str) -> Result<Self> {
        validate_store_id(target_id).context("runtime service target id")?;
        crate::writer::require_local_filesystem(store.root())?;
        let Some(_startup_guard) = RuntimeServiceStartupGuard::try_acquire(store.root())? else {
            bail!("runtime service startup is reserved by another operation");
        };
        if store.read_development_idle_fence()?.is_some() {
            bail!("runtime service startup refused while development admission is fenced");
        }

        let lock_path = create_parent(store.root(), RUNTIME_SERVICE_OWNER_LOCK_PATH)?;
        let descriptor_path = checked_path(store.root(), RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH)?;
        let (lock, created_lock) = open_owner_lock(&lock_path)?;
        let previous = read_descriptor(&descriptor_path)?;

        if created_lock && previous.is_some() {
            bail!(
                "runtime service descriptor exists without its stable owner lock; controlled recovery required"
            );
        }
        if !created_lock && previous.is_none() {
            bail!(
                "runtime service owner lock exists without a descriptor; controlled recovery required"
            );
        }
        if let Some(previous) = previous {
            validate_descriptor(&previous)?;
            if !matches!(
                previous.state,
                RuntimeServiceState::Drained | RuntimeServiceState::Failed
            ) {
                bail!(
                    "previous runtime service owner is `{}`; controlled recovery is required before takeover",
                    state_name(previous.state)
                );
            }
        }

        let now = Utc::now();
        let descriptor = RuntimeServiceOwnerDescriptor {
            schema_version: RUNTIME_SERVICE_OWNER_SCHEMA.into(),
            owner_token: Uuid::new_v4().to_string(),
            process_start_token: process_start_token(),
            pid: std::process::id(),
            host: host_identity()?,
            target_id: target_id.into(),
            protocol: RUNTIME_SERVICE_OWNER_PROTOCOL.into(),
            state: RuntimeServiceState::Starting,
            acquired_at: now,
            heartbeat_at: now,
            compute_pool_generation: None,
            preparation_pool_generation: None,
            control_address: None,
            build_commit: None,
            build_snapshot: None,
            compute_pool_id: None,
            preparation_pool_id: None,
            children: Vec::new(),
        };
        validate_descriptor(&descriptor)?;
        persist_descriptor(&descriptor_path, &descriptor)?;

        Ok(Self {
            _lock: lock,
            descriptor_path,
            descriptor,
        })
    }

    /// Publish the current service lifecycle and child observation.
    pub fn publish(
        &mut self,
        state: RuntimeServiceState,
        compute_pool_generation: Option<u64>,
        preparation_pool_generation: Option<u64>,
        children: Vec<RuntimeServiceChild>,
    ) -> Result<()> {
        self.publish_with_control_address(
            state,
            compute_pool_generation,
            preparation_pool_generation,
            children,
            self.descriptor.control_address.clone(),
        )
    }

    /// Publish lifecycle state and the loopback control endpoint together.
    pub fn publish_with_control_address(
        &mut self,
        state: RuntimeServiceState,
        compute_pool_generation: Option<u64>,
        preparation_pool_generation: Option<u64>,
        children: Vec<RuntimeServiceChild>,
        control_address: Option<String>,
    ) -> Result<()> {
        let mut descriptor = self.descriptor.clone();
        descriptor.state = state;
        descriptor.heartbeat_at = Utc::now();
        descriptor.compute_pool_generation = compute_pool_generation;
        descriptor.preparation_pool_generation = preparation_pool_generation;
        descriptor.children = children;
        descriptor.control_address = control_address;
        validate_descriptor(&descriptor)?;
        persist_descriptor(&self.descriptor_path, &descriptor)?;
        self.descriptor = descriptor;
        Ok(())
    }

    /// Update only the loopback control endpoint while retaining all state.
    pub fn set_control_address(&mut self, control_address: Option<String>) -> Result<()> {
        self.publish_with_control_address(
            self.descriptor.state,
            self.descriptor.compute_pool_generation,
            self.descriptor.preparation_pool_generation,
            self.descriptor.children.clone(),
            control_address,
        )
    }

    /// Pin the source identity used by the resident service and its children.
    ///
    /// A commit hash is the full 40-character Git object id and the source
    /// snapshot is the full 64-character SHA-256 digest.  The pair is stored
    /// together so an attach client cannot observe a half-pinned identity.
    pub fn set_build_identity(&mut self, build_commit: &str, build_snapshot: &str) -> Result<()> {
        validate_full_hash(build_commit, "runtime service build commit", 40)?;
        validate_full_hash(build_snapshot, "runtime service build snapshot", 64)?;
        let mut descriptor = self.descriptor.clone();
        descriptor.build_commit = Some(build_commit.to_owned());
        descriptor.build_snapshot = Some(build_snapshot.to_owned());
        validate_descriptor(&descriptor)?;
        persist_descriptor(&self.descriptor_path, &descriptor)?;
        self.descriptor = descriptor;
        Ok(())
    }

    /// Pin the build and scheduler pool identities used by a ready service.
    pub fn set_execution_identity(
        &mut self,
        build_commit: &str,
        build_snapshot: &str,
        compute_pool_id: &str,
        preparation_pool_id: &str,
    ) -> Result<()> {
        validate_full_hash(build_commit, "runtime service build commit", 40)?;
        validate_full_hash(build_snapshot, "runtime service build snapshot", 64)?;
        validate_store_id(compute_pool_id).context("runtime service compute pool id")?;
        validate_store_id(preparation_pool_id).context("runtime service preparation pool id")?;
        if compute_pool_id == preparation_pool_id {
            bail!("runtime service compute and preparation pool ids must be distinct");
        }
        let mut descriptor = self.descriptor.clone();
        descriptor.build_commit = Some(build_commit.to_owned());
        descriptor.build_snapshot = Some(build_snapshot.to_owned());
        descriptor.compute_pool_id = Some(compute_pool_id.to_owned());
        descriptor.preparation_pool_id = Some(preparation_pool_id.to_owned());
        validate_descriptor(&descriptor)?;
        persist_descriptor(&self.descriptor_path, &descriptor)?;
        self.descriptor = descriptor;
        Ok(())
    }

    pub fn descriptor(&self) -> &RuntimeServiceOwnerDescriptor {
        &self.descriptor
    }

    pub fn owner_token(&self) -> &str {
        &self.descriptor.owner_token
    }
}

impl Drop for RuntimeServiceOwner {
    fn drop(&mut self) {
        // `_lock` releases the kernel lock.  The descriptor remains the last
        // observed state; dropping an owner is never a synthetic drain.
    }
}

fn open_owner_lock(path: &Path) -> Result<(File, bool)> {
    let (mut file, created) = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(file) => (file, true),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .with_context(|| {
                    format!("opening runtime service owner lock {}", path.display())
                })?,
            false,
        ),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("creating runtime service owner lock {}", path.display()))
        }
    };

    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            return Err(anyhow::anyhow!("runtime service owner is already active"))
        }
        Err(TryLockError::Error(error)) => {
            return Err(error).context("acquiring native runtime service owner lock")
        }
    }

    if created {
        file.seek(SeekFrom::Start(0))?;
        file.write_all(LOCK_DESCRIPTOR)?;
        file.sync_all()?;
        if let Some(parent) = path.parent() {
            crate::durability::sync_directory(parent)?;
        }
    }

    let descriptor = read_bounded_from_file(
        &mut file,
        LOCK_DESCRIPTOR.len(),
        "runtime service owner lock descriptor",
    )?;
    if descriptor != LOCK_DESCRIPTOR {
        bail!(
            "runtime service owner lock descriptor is missing or corrupt; controlled recovery required"
        );
    }
    Ok((file, created))
}

fn read_descriptor(path: &Path) -> Result<Option<RuntimeServiceOwnerDescriptor>> {
    let parent = path
        .parent()
        .context("runtime service descriptor has no parent")?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .context("runtime service descriptor name is not UTF-8")?;
    let checked = checked_path(parent, name)?;
    let path = checked.as_path();
    let Some(bytes) = read_bounded_path(path, "runtime service owner descriptor")? else {
        return Ok(None);
    };
    if bytes.is_empty() {
        bail!("empty runtime service owner descriptor; controlled recovery required");
    }
    let descriptor =
        serde_json::from_slice(&bytes).context("parsing runtime service owner descriptor")?;
    Ok(Some(descriptor))
}

fn persist_descriptor(path: &Path, descriptor: &RuntimeServiceOwnerDescriptor) -> Result<()> {
    let data = serde_json::to_vec_pretty(descriptor)
        .context("serialize runtime service owner descriptor")?;
    crate::durability::atomic_write_owner(path, &data)
}

fn read_bounded_path(path: &Path, context: &str) -> Result<Option<Vec<u8>>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("{context}: {}", path.display())),
    };
    Ok(Some(read_bounded_from_file(
        &mut file,
        MAX_DESCRIPTOR_BYTES,
        context,
    )?))
}

fn read_bounded_from_file(file: &mut File, maximum: usize, context: &str) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.take((maximum as u64).saturating_add(1))
        .read_to_end(&mut bytes)
        .with_context(|| format!("read {context}"))?;
    if bytes.len() > maximum {
        bail!("{context} exceeds the bounded {} byte limit", maximum);
    }
    Ok(bytes)
}

/// Validate a received owner record without opening or writing a session store.
pub fn validate_descriptor(descriptor: &RuntimeServiceOwnerDescriptor) -> Result<()> {
    if descriptor.schema_version != RUNTIME_SERVICE_OWNER_SCHEMA {
        bail!(
            "unsupported runtime service owner schema `{}`",
            descriptor.schema_version
        );
    }
    if descriptor.protocol != RUNTIME_SERVICE_OWNER_PROTOCOL {
        bail!(
            "unsupported runtime service owner protocol `{}`",
            descriptor.protocol
        );
    }
    Uuid::parse_str(&descriptor.owner_token).context("runtime service owner token is not UUID")?;
    Uuid::parse_str(&descriptor.process_start_token)
        .context("runtime service process start token is not UUID")?;
    if descriptor.pid == 0 {
        bail!("runtime service owner pid must be positive");
    }
    validate_text(
        &descriptor.host,
        "runtime service owner host",
        MAX_HOST_BYTES,
    )?;
    validate_store_id(&descriptor.target_id).context("runtime service target id")?;
    for (generation, name) in [
        (
            descriptor.compute_pool_generation,
            "compute pool generation",
        ),
        (
            descriptor.preparation_pool_generation,
            "preparation pool generation",
        ),
    ] {
        if generation == Some(0) {
            bail!("{name} must be positive when present");
        }
    }
    validate_build_identity(descriptor)?;
    validate_pool_identity(descriptor)?;
    validate_control_address(descriptor.control_address.as_deref())?;
    if descriptor.children.len() > MAX_CHILDREN {
        bail!("runtime service owner has too many child descriptors");
    }
    let mut roles = BTreeSet::new();
    let mut pids = BTreeSet::new();
    for child in &descriptor.children {
        validate_store_id(&child.role).context("runtime service child role")?;
        validate_text(
            &child.status,
            "runtime service child status",
            MAX_STATUS_BYTES,
        )?;
        if !matches!(
            child.status.as_str(),
            "running" | "unknown" | "exited_success" | "exited_failure"
        ) {
            bail!(
                "runtime service child `{}` has unsupported status `{}`",
                child.role,
                child.status
            );
        }
        if child.pid == 0 {
            bail!("runtime service child pid must be positive");
        }
        if !roles.insert(child.role.as_str()) {
            bail!("runtime service child role `{}` is duplicated", child.role);
        }
        if !pids.insert(child.pid) {
            bail!("runtime service child pid {} is duplicated", child.pid);
        }
    }
    match descriptor.state {
        RuntimeServiceState::Ready => {
            if descriptor
                .children
                .iter()
                .any(|child| child.status != "running")
            {
                bail!("ready runtime service requires running children");
            }
            if descriptor.compute_pool_generation.unwrap_or(0) == 0
                || descriptor.preparation_pool_generation.unwrap_or(0) == 0
            {
                bail!(
                    "ready runtime service requires positive compute and preparation generations"
                );
            }
            if descriptor.control_address.is_none() {
                bail!("ready runtime service requires a loopback control address");
            }
            if descriptor.build_commit.is_none() || descriptor.build_snapshot.is_none() {
                bail!("ready runtime service requires a pinned build identity");
            }
            if descriptor.compute_pool_id.is_none() || descriptor.preparation_pool_id.is_none() {
                bail!("ready runtime service requires pinned compute and preparation pool ids");
            }
            if roles.len() != 2
                || !roles.contains(RUNTIME_SERVICE_COMPUTE_ROLE)
                || !roles.contains(RUNTIME_SERVICE_PREPARATION_ROLE)
            {
                bail!("ready runtime service requires distinct compute and preparation children");
            }
        }
        RuntimeServiceState::Drained | RuntimeServiceState::Failed => {
            if descriptor.state == RuntimeServiceState::Drained
                && descriptor
                    .children
                    .iter()
                    .any(|child| child.status != "exited_success")
            {
                bail!("drained runtime service requires successful child exits");
            }
            if descriptor
                .children
                .iter()
                .any(|child| !matches!(child.status.as_str(), "exited_success" | "exited_failure"))
            {
                bail!("terminal runtime service state requires every child to have an exit status");
            }
        }
        RuntimeServiceState::Starting
        | RuntimeServiceState::Draining
        | RuntimeServiceState::Unknown => {}
    }
    Ok(())
}

fn validate_build_identity(descriptor: &RuntimeServiceOwnerDescriptor) -> Result<()> {
    match (&descriptor.build_commit, &descriptor.build_snapshot) {
        (None, None) => Ok(()),
        (Some(commit), Some(snapshot)) => {
            validate_full_hash(commit, "runtime service build commit", 40)?;
            validate_full_hash(snapshot, "runtime service build snapshot", 64)
        }
        _ => bail!("runtime service build identity must contain commit and snapshot together"),
    }
}

fn validate_pool_identity(descriptor: &RuntimeServiceOwnerDescriptor) -> Result<()> {
    match (&descriptor.compute_pool_id, &descriptor.preparation_pool_id) {
        (None, None) => Ok(()),
        (Some(compute), Some(preparation)) => {
            validate_store_id(compute).context("runtime service compute pool id")?;
            validate_store_id(preparation).context("runtime service preparation pool id")?;
            if compute == preparation {
                bail!("runtime service compute and preparation pool ids must be distinct");
            }
            Ok(())
        }
        _ => bail!("runtime service pool identity must contain both pool ids together"),
    }
}

fn validate_full_hash(value: &str, field: &str, length: usize) -> Result<()> {
    if value.len() != length || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("{field} must be a full {length}-character hexadecimal hash");
    }
    Ok(())
}

fn validate_text(value: &str, field: &str, maximum: usize) -> Result<()> {
    if value.is_empty() || value.len() > maximum || value.chars().any(char::is_control) {
        bail!("{field} is empty, too long, or contains control characters");
    }
    Ok(())
}

fn validate_control_address(address: Option<&str>) -> Result<()> {
    let Some(address) = address else {
        return Ok(());
    };
    validate_text(
        address,
        "runtime service control address",
        MAX_CONTROL_ADDRESS_BYTES,
    )?;
    let parsed: SocketAddr = address
        .parse()
        .context("runtime service control address must be a socket address")?;
    if !parsed.ip().is_loopback() || parsed.port() == 0 {
        bail!("runtime service control address must be a nonzero loopback address");
    }
    Ok(())
}

fn state_name(state: RuntimeServiceState) -> &'static str {
    match state {
        RuntimeServiceState::Starting => "starting",
        RuntimeServiceState::Ready => "ready",
        RuntimeServiceState::Draining => "draining",
        RuntimeServiceState::Drained => "drained",
        RuntimeServiceState::Failed => "failed",
        RuntimeServiceState::Unknown => "unknown",
    }
}

fn process_start_token() -> String {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| Uuid::new_v4().to_string()).clone()
}

fn host_identity() -> Result<String> {
    for name in ["COMPUTERNAME", "HOSTNAME", "HOST"] {
        if let Ok(value) = std::env::var(name) {
            if !value.is_empty() {
                return Ok(value);
            }
        }
    }
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0 {
            let end = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());
            return String::from_utf8(buffer[..end].to_vec()).context("hostname is not UTF-8");
        }
    }
    bail!("cannot establish runtime service host identity")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> SessionStore {
        let directory = tempdir().unwrap();
        let root = directory.keep();
        SessionStore::open(root).unwrap()
    }

    #[test]
    fn owner_publishes_control_endpoint_and_terminal_state() {
        let store = store();
        let mut owner = RuntimeServiceOwner::acquire(&store, "desktop-local").unwrap();
        assert_eq!(owner.descriptor().state, RuntimeServiceState::Starting);
        owner
            .publish_with_control_address(
                RuntimeServiceState::Drained,
                Some(3),
                Some(4),
                vec![RuntimeServiceChild {
                    role: "accepted-scheduler".into(),
                    status: "exited_success".into(),
                    pid: 17,
                }],
                Some("127.0.0.1:43123".into()),
            )
            .unwrap();
        let descriptor: RuntimeServiceOwnerDescriptor = serde_json::from_slice(
            &std::fs::read(store.root().join(RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH)).unwrap(),
        )
        .unwrap();
        assert_eq!(descriptor.state, RuntimeServiceState::Drained);
        assert_eq!(
            descriptor.control_address.as_deref(),
            Some("127.0.0.1:43123")
        );
    }

    #[test]
    fn nonterminal_descriptor_cannot_be_taken_over_after_native_unlock() {
        let directory = tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        {
            let mut owner = RuntimeServiceOwner::acquire(&store, "desktop-local").unwrap();
            owner
                .publish(RuntimeServiceState::Draining, None, None, Vec::new())
                .unwrap();
        }
        let reopened = SessionStore::open_existing(store.root()).unwrap();
        assert!(RuntimeServiceOwner::acquire(&reopened, "desktop-local").is_err());
    }

    #[test]
    fn active_native_lock_blocks_a_second_owner() {
        let directory = tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let _owner = RuntimeServiceOwner::acquire(&store, "desktop-local").unwrap();
        let reopened = SessionStore::open_existing(store.root()).unwrap();
        assert!(RuntimeServiceOwner::acquire(&reopened, "other-target").is_err());
    }

    #[test]
    fn ready_requires_identity_endpoint_generations_and_both_roles() {
        let store = store();
        let owner = RuntimeServiceOwner::acquire(&store, "desktop-local").unwrap();
        let mut descriptor = owner.descriptor().clone();
        descriptor.state = RuntimeServiceState::Ready;
        descriptor.children = vec![RuntimeServiceChild {
            role: RUNTIME_SERVICE_COMPUTE_ROLE.into(),
            pid: 17,
            status: "running".into(),
        }];
        assert!(validate_descriptor(&descriptor).is_err());

        descriptor.preparation_pool_generation = Some(2);
        descriptor.compute_pool_generation = Some(1);
        descriptor.control_address = Some("127.0.0.1:43123".into());
        descriptor.build_commit = Some("a".repeat(40));
        descriptor.build_snapshot = Some("b".repeat(64));
        assert!(validate_descriptor(&descriptor).is_err());
        descriptor.compute_pool_id = Some("compute".into());
        descriptor.preparation_pool_id = Some("preparation".into());

        descriptor.children.push(RuntimeServiceChild {
            role: RUNTIME_SERVICE_PREPARATION_ROLE.into(),
            pid: 18,
            status: "running".into(),
        });
        assert!(validate_descriptor(&descriptor).is_ok());
        descriptor.children[0].status = "exited_success".into();
        assert!(validate_descriptor(&descriptor).is_err());
    }

    #[test]
    fn child_identity_and_terminal_statuses_are_fail_closed() {
        let store = store();
        let owner = RuntimeServiceOwner::acquire(&store, "desktop-local").unwrap();
        let mut descriptor = owner.descriptor().clone();
        descriptor.children = vec![
            RuntimeServiceChild {
                role: RUNTIME_SERVICE_COMPUTE_ROLE.into(),
                pid: 17,
                status: "running".into(),
            },
            RuntimeServiceChild {
                role: RUNTIME_SERVICE_COMPUTE_ROLE.into(),
                pid: 17,
                status: "running".into(),
            },
        ];
        assert!(validate_descriptor(&descriptor).is_err());

        descriptor.children[1].role = RUNTIME_SERVICE_PREPARATION_ROLE.into();
        descriptor.children[1].pid = 18;
        descriptor.children[1].status = "unexpected".into();
        assert!(validate_descriptor(&descriptor).is_err());

        descriptor.children[1].status = "running".into();
        descriptor.state = RuntimeServiceState::Failed;
        assert!(validate_descriptor(&descriptor).is_err());
        descriptor.children[0].status = "exited_failure".into();
        descriptor.children[1].status = "exited_success".into();
        assert!(validate_descriptor(&descriptor).is_ok());
        descriptor.state = RuntimeServiceState::Drained;
        assert!(validate_descriptor(&descriptor).is_err());
        descriptor.children[0].status = "exited_success".into();
        assert!(validate_descriptor(&descriptor).is_ok());
    }

    #[test]
    fn build_identity_setter_requires_full_hashes() {
        let store = store();
        let mut owner = RuntimeServiceOwner::acquire(&store, "desktop-local").unwrap();
        let commit = "a".repeat(40);
        let snapshot = "b".repeat(64);
        assert!(owner.set_build_identity("short", &snapshot).is_err());
        assert!(owner.set_build_identity(&commit, &snapshot).is_ok());
        assert_eq!(
            owner.descriptor().build_commit.as_deref(),
            Some(commit.as_str())
        );
        assert_eq!(
            owner.descriptor().build_snapshot.as_deref(),
            Some(snapshot.as_str())
        );
    }

    #[test]
    fn execution_identity_pins_distinct_pool_ids() {
        let store = store();
        let mut owner = RuntimeServiceOwner::acquire(&store, "desktop-local").unwrap();
        let commit = "a".repeat(40);
        let snapshot = "b".repeat(64);
        assert!(owner
            .set_execution_identity(&commit, &snapshot, "compute", "compute",)
            .is_err());
        owner
            .set_execution_identity(&commit, &snapshot, "compute", "preparation")
            .unwrap();
        assert_eq!(
            owner.descriptor().compute_pool_id.as_deref(),
            Some("compute")
        );
        assert_eq!(
            owner.descriptor().preparation_pool_id.as_deref(),
            Some("preparation")
        );
    }
    #[test]
    fn service_operational_namespace_does_not_block_scientific_gc_preview() {
        let store = store();
        let owner = RuntimeServiceOwner::acquire(&store, "native-local").unwrap();
        let _plan = store.gc_preview().unwrap();
        assert!(store.root().join(RUNTIME_SERVICE_OWNER_LOCK_PATH).is_file());
        assert_eq!(owner.descriptor().state, RuntimeServiceState::Starting);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeServiceConfig {
    pub schema_version: String,
    pub store_root: PathBuf,
    pub target_id: String,
    pub compute_pool_id: String,
    pub preparation_pool_id: String,
    pub compute_resources: Vec<FmsSchedulerResourceOffer>,
    pub preparation_resources: Vec<FmsPreparationResourceOffer>,
    pub worker_timeout_seconds: u64,
    pub preparation_timeout_seconds: u64,
    pub heartbeat_interval_milliseconds: u64,
    pub startup_timeout_seconds: u64,
    pub drain_timeout_seconds: u64,
}

/// Serializes local launch decisions independently of the long-lived service lock.
pub struct RuntimeServiceLaunchGuard {
    _lock: File,
    record_path: PathBuf,
}

/// Validated paths owned by one launcher attempt under the launch guard.
pub struct RuntimeServiceLauncherPaths {
    pub configuration: PathBuf,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
}

impl RuntimeServiceLaunchGuard {
    /// Prepare only the launcher namespace while this attempt holds the guard.
    /// Files remain absent until the caller creates each one exclusively.
    pub fn prepare_launcher_paths(&self, launcher_id: &str) -> Result<RuntimeServiceLauncherPaths> {
        let id = Uuid::parse_str(launcher_id)?;
        if id.to_string() != launcher_id {
            bail!("launcher identifier must be a canonical UUID");
        }
        let root = self
            .record_path
            .parent()
            .and_then(Path::parent)
            .context("launch store root missing")?;
        crate::writer::require_local_filesystem(root)?;
        let configuration = create_parent(
            root,
            &format!("runtime-services/launchers/{launcher_id}.config.json"),
        )?;
        let stdout = checked_path(
            root,
            &format!("runtime-services/launchers/{launcher_id}.stdout.log"),
        )?;
        let stderr = checked_path(
            root,
            &format!("runtime-services/launchers/{launcher_id}.stderr.log"),
        )?;
        Ok(RuntimeServiceLauncherPaths {
            configuration,
            stdout,
            stderr,
        })
    }

    pub fn try_acquire(root: &Path) -> Result<Option<Self>> {
        crate::writer::require_local_filesystem(root)?;
        let path = match create_parent(root, "runtime-services/LAUNCH.lock") {
            Ok(path) => path,
            Err(error)
                if error.chain().any(|e| {
                    e.downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::AlreadyExists)
                }) =>
            {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        match lock.try_lock() {
            Ok(()) => Ok(Some(Self {
                _lock: lock,
                record_path: checked_path(root, "runtime-services/LAUNCH.json")?,
            })),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(error)) => Err(error.into()),
        }
    }

    /// A previous uncertain launch without a terminal owner is never retried.
    pub fn begin(&self, launch_id: &str, terminal_owner: bool) -> Result<()> {
        let path = self.checked_record_path()?;
        if let Some(bytes) = read_bounded_path(&path, "runtime launch record")? {
            let record: RuntimeServiceLaunchRecord = serde_json::from_slice(&bytes)?;
            if record.schema_version != "runtime_service_launch.v1"
                || !matches!(
                    record.state.as_str(),
                    "starting" | "spawned" | "ready" | "failed"
                )
            {
                bail!("invalid runtime launch record; controlled recovery required");
            }
            Uuid::parse_str(&record.launch_id)?;
            if record.pid == Some(0)
                || (matches!(record.state.as_str(), "spawned" | "ready") && record.pid.is_none())
            {
                bail!("invalid runtime launch PID observation");
            }
            if !terminal_owner && record.state != "failed" {
                bail!("previous runtime launch outcome unknown; controlled recovery required");
            }
        }
        self.publish(launch_id, "starting", None)
    }

    pub fn publish(&self, launch_id: &str, state: &str, pid: Option<u32>) -> Result<()> {
        Uuid::parse_str(launch_id)?;
        if !matches!(state, "starting" | "spawned" | "ready" | "failed") {
            bail!("invalid launch phase");
        }
        let record = RuntimeServiceLaunchRecord {
            schema_version: "runtime_service_launch.v1".into(),
            launch_id: launch_id.into(),
            state: state.into(),
            pid,
        };
        crate::durability::atomic_write_owner(
            &self.checked_record_path()?,
            &serde_json::to_vec(&record)?,
        )
    }

    fn checked_record_path(&self) -> Result<PathBuf> {
        checked_path(
            self.record_path
                .parent()
                .context("launch record parent missing")?,
            "LAUNCH.json",
        )
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeServiceLaunchRecord {
    schema_version: String,
    launch_id: String,
    state: String,
    pid: Option<u32>,
}

#[cfg(test)]
mod launch_tests {
    use super::*;

    #[test]
    fn launcher_paths_are_guard_owned_and_do_not_create_files() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let guard = RuntimeServiceLaunchGuard::try_acquire(store.root())
            .unwrap()
            .unwrap();
        let id = Uuid::new_v4().to_string();
        let paths = guard.prepare_launcher_paths(&id).unwrap();
        assert!(store.root().join("runtime-services/launchers").is_dir());
        for path in [&paths.configuration, &paths.stdout, &paths.stderr] {
            assert_eq!(
                path.parent(),
                Some(store.root().join("runtime-services/launchers").as_path())
            );
            assert!(!path.exists());
        }
        assert!(RuntimeServiceLaunchGuard::try_acquire(store.root())
            .unwrap()
            .is_none());
        assert_eq!(
            paths.configuration.file_name().unwrap().to_str().unwrap(),
            format!("{id}.config.json")
        );
    }

    #[test]
    fn invalid_launcher_id_is_refused_before_namespace_creation() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let guard = RuntimeServiceLaunchGuard::try_acquire(store.root())
            .unwrap()
            .unwrap();
        for id in [
            "../escape",
            "/absolute",
            "not-a-uuid",
            "AAAAAAAA-AAAA-4AAA-AAAA-AAAAAAAAAAAA",
        ] {
            assert!(guard.prepare_launcher_paths(id).is_err());
            assert!(!store.root().join("runtime-services/launchers").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn launcher_namespace_symlink_is_refused() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let outside = directory.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        let guard = RuntimeServiceLaunchGuard::try_acquire(store.root())
            .unwrap()
            .unwrap();
        std::os::unix::fs::symlink(&outside, store.root().join("runtime-services/launchers"))
            .unwrap();
        assert!(guard
            .prepare_launcher_paths(&Uuid::new_v4().to_string())
            .is_err());
        assert_eq!(std::fs::read_dir(outside).unwrap().count(), 0);
    }

    #[test]
    fn launch_lock_serializes_and_unknown_attempt_survives_guard_drop() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let first = RuntimeServiceLaunchGuard::try_acquire(store.root())
            .unwrap()
            .unwrap();
        assert!(RuntimeServiceLaunchGuard::try_acquire(store.root())
            .unwrap()
            .is_none());
        let first_id = Uuid::new_v4().to_string();
        first.begin(&first_id, false).unwrap();
        first.publish(&first_id, "spawned", Some(123)).unwrap();
        drop(first);
        let second = RuntimeServiceLaunchGuard::try_acquire(store.root())
            .unwrap()
            .unwrap();
        let next_id = Uuid::new_v4().to_string();
        assert!(second.begin(&next_id, false).is_err());
        second.publish(&first_id, "failed", Some(123)).unwrap();
        second.begin(&next_id, false).unwrap();
    }
}

impl RuntimeServiceConfig {
    /// Load the stable application configuration or initialize it once.
    /// The factory observes capacity only on first initialization, under the
    /// store writer lease. Corrupt or orphaned state never authorizes replacement.
    pub fn for_application(
        store: &SessionStore,
        target_id: &str,
        initialize: impl FnOnce() -> Result<Self>,
    ) -> Result<Self> {
        validate_store_id(target_id)?;
        // Use the same lock order as service startup: launch gate, then writer.
        let _launch = RuntimeServiceLaunchGuard::try_acquire(store.root())?
            .context("application runtime configuration launch guard is busy")?;
        let _writer = store.write_transaction()?;
        let path = checked_path(store.root(), "runtime-services/APPLICATION.json")?;
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                let config = Self::read(&path)?;
                config.require_application_binding(store, target_id)?;
                return Ok(config);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("observe application runtime configuration"),
        }
        for record in [
            RUNTIME_SERVICE_OWNER_LOCK_PATH,
            RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
            "runtime-services/LAUNCH.json",
        ] {
            let record = checked_path(store.root(), record)?;
            match std::fs::symlink_metadata(record) {
                Ok(_) => bail!("runtime service already has an owner or launch record without application configuration; explicit configuration or recovery required"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error).context("observe existing runtime service before configuration"),
            }
        }
        let config = initialize()?;
        config.validate()?;
        config.require_application_binding(store, target_id)?;
        let bytes = serde_json::to_vec(&config)?;
        if bytes.len() > 65536 {
            bail!("service config exceeds budget");
        }
        let path = create_parent(store.root(), "runtime-services/APPLICATION.json")?;
        crate::durability::atomic_write_owner(&path, &bytes)?;
        Ok(config)
    }

    fn require_application_binding(&self, store: &SessionStore, target_id: &str) -> Result<()> {
        if self.store_root != store.root() || self.target_id != target_id {
            bail!("application service configuration belongs to another store or target");
        }
        Ok(())
    }

    /// Read a bounded configuration through the same path guard as the store.
    pub fn read(path: &Path) -> Result<Self> {
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            bail!("runtime service config path must be absolute without parent traversal");
        }
        let parent = path.parent().context("config parent missing")?;
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .context("config name is not UTF-8")?;
        let bytes = crate::repository_path::read_bounded_regular_file(parent, name, 65536)?;
        let config: Self = serde_json::from_slice(&bytes)?;
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != "runtime_service_config.v1" {
            bail!("unsupported runtime service configuration");
        }
        if !self.store_root.is_absolute()
            || self
                .store_root
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
        {
            bail!("runtime service store root must be absolute without parent traversal");
        }
        for id in [
            &self.target_id,
            &self.compute_pool_id,
            &self.preparation_pool_id,
        ] {
            validate_store_id(id)?;
        }
        if self.compute_pool_id == self.preparation_pool_id {
            bail!("compute and preparation pools must have distinct identities");
        }
        if self.compute_resources.is_empty() || self.preparation_resources.is_empty() {
            bail!("service requires nonempty compute and preparation resource offers");
        }
        FmsSchedulerResourcePool {
            schema_version: FMS_SCHEDULER_RESOURCE_POOL_SCHEMA.into(),
            pool_id: self.compute_pool_id.clone(),
            generation: 1,
            resources: self.compute_resources.clone(),
        }
        .validate()?;
        FmsPreparationResourcePool {
            schema_version: FMS_PREPARATION_RESOURCE_POOL_SCHEMA.into(),
            pool_id: self.preparation_pool_id.clone(),
            generation: 1,
            resources: self.preparation_resources.clone(),
        }
        .validate()?;
        if self.compute_resources.iter().any(|r| {
            !matches!(
                r.kind,
                crate::FmsResourceKind::Cpu | crate::FmsResourceKind::Gpu
            )
        }) {
            bail!("service compute offers support only CPU/GPU");
        }
        let compute_ids = self
            .compute_resources
            .iter()
            .map(|r| &r.resource_id)
            .collect::<std::collections::BTreeSet<_>>();
        if self
            .preparation_resources
            .iter()
            .any(|r| compute_ids.contains(&r.resource_id))
        {
            bail!("compute and preparation resource IDs must be disjoint");
        }
        if [
            self.worker_timeout_seconds,
            self.preparation_timeout_seconds,
            self.heartbeat_interval_milliseconds,
            self.startup_timeout_seconds,
            self.drain_timeout_seconds,
        ]
        .contains(&0)
            || self.startup_timeout_seconds > 300
            || [
                self.worker_timeout_seconds,
                self.preparation_timeout_seconds,
                self.drain_timeout_seconds,
            ]
            .iter()
            .any(|v| *v > 31_536_000)
            || self.heartbeat_interval_milliseconds > 3_600_000
        {
            bail!("service timeouts must be positive; startup timeout must not exceed 300 seconds");
        }
        Ok(())
    }
}

#[cfg(test)]
mod application_configuration_tests {
    use super::*;
    use crate::{FmsResourceBudget, FmsResourceKind};

    fn config(store: &SessionStore) -> RuntimeServiceConfig {
        let budget = FmsResourceBudget {
            cpu_millis: 1000,
            memory_bytes: 1024,
            gpu_memory_bytes: 0,
            storage_bytes: 1024,
        };
        RuntimeServiceConfig {
            schema_version: "runtime_service_config.v1".into(),
            store_root: store.root().to_path_buf(),
            target_id: "desktop".into(),
            compute_pool_id: "compute".into(),
            preparation_pool_id: "preparation".into(),
            compute_resources: vec![FmsSchedulerResourceOffer {
                resource_id: "compute.cpu".into(),
                kind: FmsResourceKind::Cpu,
                budget: budget.clone(),
            }],
            preparation_resources: vec![FmsPreparationResourceOffer {
                resource_id: "preparation.cpu".into(),
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
    fn concurrent_launch_gate_refuses_configuration_without_calling_factory() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let _launch = RuntimeServiceLaunchGuard::try_acquire(store.root())
            .unwrap()
            .unwrap();
        assert!(
            RuntimeServiceConfig::for_application(&store, "desktop", || {
                panic!("another launch must finish before configuration initialization")
            })
            .is_err()
        );
        assert!(!store
            .root()
            .join("runtime-services/APPLICATION.json")
            .exists());
    }

    #[test]
    fn application_reuses_saved_budgets_without_observing_capacity_again() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let first = RuntimeServiceConfig::for_application(&store, "desktop", || Ok(config(&store)))
            .unwrap();
        let next = RuntimeServiceConfig::for_application(&store, "desktop", || {
            panic!("saved configuration must not resample volatile capacity")
        })
        .unwrap();
        assert_eq!(first, next);
        assert!(RuntimeServiceConfig::for_application(&store, "other", || {
            panic!("wrong target must not initialize another configuration")
        })
        .is_err());
    }

    #[test]
    fn corrupt_configuration_is_preserved_and_never_regenerated() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let path = create_parent(store.root(), "runtime-services/APPLICATION.json").unwrap();
        std::fs::write(&path, b"corrupt").unwrap();
        assert!(
            RuntimeServiceConfig::for_application(&store, "desktop", || {
                panic!("corrupt configuration must not authorize reinitialization")
            })
            .is_err()
        );
        assert_eq!(std::fs::read(path).unwrap(), b"corrupt");
    }

    #[test]
    fn orphaned_service_records_do_not_authorize_default_configuration() {
        for name in [
            RUNTIME_SERVICE_OWNER_LOCK_PATH,
            RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
            "runtime-services/LAUNCH.json",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store = SessionStore::open(directory.path()).unwrap();
            std::fs::write(create_parent(store.root(), name).unwrap(), b"unknown").unwrap();
            assert!(
                RuntimeServiceConfig::for_application(&store, "desktop", || {
                    panic!("existing service records require explicit configuration or recovery")
                })
                .is_err()
            );
            assert!(!store
                .root()
                .join("runtime-services/APPLICATION.json")
                .exists());
        }
    }

    #[test]
    fn wrong_store_candidate_is_rejected_before_publication() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let mut candidate = config(&store);
        candidate.store_root = store.root().join("another-store");
        assert!(
            RuntimeServiceConfig::for_application(&store, "desktop", || Ok(candidate)).is_err()
        );
        assert!(!store
            .root()
            .join("runtime-services/APPLICATION.json")
            .exists());
    }
}
