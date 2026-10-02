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
use crate::store::SessionStore;

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
