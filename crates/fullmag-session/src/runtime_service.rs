//! Durable ownership for one local runtime service per session store.
//!
//! The native file lock is authoritative.  The JSON descriptor is an
//! observable record of the last published state; it never replaces the
//! kernel lock and it is never used for PID- or age-based takeover.

use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use uuid::Uuid;

use crate::repository_path::{
    checked_path, create_parent, reject_link, validate_relative_path, validate_store_id,
};
use crate::runtime_service_host::RuntimeServiceHostExecution;
use crate::runtime_service_startup::RuntimeServiceStartupGuard;
use crate::store::SessionStore;
use crate::{
    FmsPreparationResourceOffer, FmsPreparationResourcePool, FmsSchedulerResourceOffer,
    FmsSchedulerResourcePool, FMS_PREPARATION_RESOURCE_POOL_SCHEMA,
    FMS_SCHEDULER_RESOURCE_POOL_SCHEMA,
};

pub const RUNTIME_SERVICE_OWNER_SCHEMA: &str = "runtime_service_owner.v1";
pub const RUNTIME_SERVICE_CONFIG_SCHEMA_V1: &str = "runtime_service_config.v1";
pub const RUNTIME_SERVICE_CONFIG_SCHEMA_V2: &str = "runtime_service_config.v2";
pub const RUNTIME_SERVICE_OWNER_PROTOCOL: &str = "stdin-v1";
pub const RUNTIME_SERVICE_OWNER_LOCK_PATH: &str = "runtime-services/OWNER.lock";
pub const RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH: &str = "runtime-services/OWNER.json";
pub const RUNTIME_SERVICE_RECOVERY_REQUEST_SCHEMA: &str = "runtime_service_recovery_request.v1";
pub const RUNTIME_SERVICE_RECOVERY_SCHEMA: &str = "runtime_service_recovery.v1";

const LOCK_DESCRIPTOR: &[u8] = b"fullmag.runtime-service-owner.lock.v1\n";
const MAX_DESCRIPTOR_BYTES: usize = 256 * 1024;
const MAX_CHILDREN: usize = 32;
const MAX_HOST_BYTES: usize = 255;
const MAX_STATUS_BYTES: usize = 128;
const MAX_CONTROL_ADDRESS_BYTES: usize = 128;
const RUNTIME_SERVICE_COMPUTE_ROLE: &str = "compute";
const RUNTIME_SERVICE_PREPARATION_ROLE: &str = "preparation";
const MAX_RECOVERY_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RECOVERY_RECEIPT_BYTES: usize = 256 * 1024;
const MAX_RECOVERY_LOG_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECOVERY_ARCHIVED_FILES: usize = 32;
const RECOVERY_MANDATORY_ARCHIVED_FILES: usize = 12;
const RECOVERY_ARCHIVED_CONFIGURATION_KEY: &str = "configuration.json";

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

/// A scheduler checkpoint may be absent when the scheduler drained before
/// publishing its first completed-worker checkpoint. This is an attested
/// state, never a synthetic file or digest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeServiceRecoveryAbsentSourceReason {
    SchedulerCheckpointNotPublished,
}

/// Operator authorization for recovering one specific runtime owner whose
/// outcome is still unknown.  The request is intentionally a complete typed
/// snapshot of the old owner; a PID, timestamp, or age is never sufficient.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeServiceRecoveryRequest {
    pub schema_version: String,
    pub request_id: String,
    pub config_sha256: String,
    pub owner_sha256: String,
    pub launch_sha256: String,
    pub expected_owner: RuntimeServiceOwnerDescriptor,
}

impl RuntimeServiceRecoveryRequest {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != RUNTIME_SERVICE_RECOVERY_REQUEST_SCHEMA {
            bail!("unsupported runtime service recovery request schema");
        }
        validate_canonical_uuid(&self.request_id, "runtime service recovery request id")?;
        validate_lower_hex(&self.config_sha256, "runtime service recovery config SHA-256", 64)?;
        validate_lower_hex(&self.owner_sha256, "runtime service recovery owner SHA-256", 64)?;
        validate_lower_hex(&self.launch_sha256, "runtime service recovery launch SHA-256", 64)?;
        validate_descriptor(&self.expected_owner)?;
        validate_canonical_uuid(
            &self.expected_owner.owner_token,
            "runtime service recovery owner token",
        )?;
        validate_canonical_uuid(
            &self.expected_owner.process_start_token,
            "runtime service recovery process-start token",
        )?;
        if self.expected_owner.state != RuntimeServiceState::Unknown {
            bail!("runtime service recovery requires an unknown expected owner");
        }
        Ok(())
    }
}

/// Durable result of a controlled recovery.  `status=prepared` is an
/// intermediate crash-recovery marker; successful public completion is always
/// `status=recovered` and `outcome=failed` because an Unknown owner cannot be
/// retroactively proven Drained.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeServiceRecoveryReceipt {
    pub schema_version: String,
    pub request_id: String,
    pub request_sha256: String,
    pub status: String,
    pub outcome: String,
    pub target_id: String,
    pub config_sha256: String,
    pub owner_sha256_before: String,
    pub owner_state_after: String,
    pub owner_sha256_after: String,
    pub archived_evidence_path: String,
    pub archived_evidence_sha256: String,
    pub archived_files: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub archived_absent_sources: BTreeMap<String, RuntimeServiceRecoveryAbsentSourceReason>,
    pub historical_build_commit: String,
    pub historical_build_snapshot: String,
    pub executor_build_commit: String,
    pub executor_build_snapshot: String,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

impl RuntimeServiceRecoveryReceipt {
    fn validate(&self) -> Result<()> {
        if self.schema_version != RUNTIME_SERVICE_RECOVERY_SCHEMA {
            bail!("unsupported runtime service recovery receipt schema");
        }
        validate_canonical_uuid(&self.request_id, "runtime service recovery receipt id")?;
        validate_lower_hex(&self.request_sha256, "runtime service recovery request SHA-256", 64)?;
        validate_lower_hex(&self.config_sha256, "runtime service recovery config SHA-256", 64)?;
        validate_lower_hex(
            &self.owner_sha256_before,
            "runtime service recovery owner SHA-256",
            64,
        )?;
        if self.owner_state_after != "failed" {
            bail!("runtime service recovery owner state must be failed");
        }
        validate_lower_hex(
            &self.owner_sha256_after,
            "runtime service recovery result SHA-256",
            64,
        )?;
        validate_lower_hex(
            &self.archived_evidence_sha256,
            "runtime service recovery archive SHA-256",
            64,
        )?;
        validate_lower_hex(
            &self.historical_build_commit,
            "runtime service historical build commit",
            40,
        )?;
        validate_lower_hex(
            &self.historical_build_snapshot,
            "runtime service historical build snapshot",
            64,
        )?;
        validate_lower_hex(
            &self.executor_build_commit,
            "runtime service recovery executor build commit",
            40,
        )?;
        validate_lower_hex(
            &self.executor_build_snapshot,
            "runtime service recovery executor build snapshot",
            64,
        )?;
        let archive_path = Path::new(&self.archived_evidence_path);
        if !archive_path.is_absolute()
            || archive_path
                .components()
                .any(|component| matches!(component, std::path::Component::ParentDir))
            || self.archived_evidence_path.chars().any(char::is_control)
        {
            bail!("runtime service recovery archive path must be absolute and bounded");
        }
        if !matches!(self.status.as_str(), "prepared" | "recovered") {
            bail!("runtime service recovery receipt has unsupported status");
        }
        if self.outcome != "failed" {
            bail!("runtime service recovery outcome must be failed");
        }
        if (self.status == "recovered") != self.completed_at.is_some() {
            bail!("runtime service recovery receipt completion timestamp mismatch");
        }
        if self.archived_files.len() + self.archived_absent_sources.len()
            < RECOVERY_MANDATORY_ARCHIVED_FILES
            || self.archived_files.len() + self.archived_absent_sources.len()
                > MAX_RECOVERY_ARCHIVED_FILES
        {
            bail!("runtime service recovery archive evidence has an incomplete inventory");
        }
        if self
            .archived_files
            .keys()
            .any(|source| self.archived_absent_sources.contains_key(source))
        {
            bail!("runtime recovery archive source is both present and absent");
        }
        for source in self.archived_absent_sources.keys() {
            validate_recovery_absent_source_path(source)?;
        }
        if !self
            .archived_files
            .contains_key(RECOVERY_ARCHIVED_CONFIGURATION_KEY)
        {
            bail!("runtime service recovery archive is missing raw configuration bytes");
        }
        for (relative, digest) in &self.archived_files {
            validate_recovery_archived_source_path(relative)?;
            validate_lower_hex(digest, "runtime service archived file SHA-256", 64)?;
        }
        Ok(())
    }
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
        store
            .assert_development_admission_open()
            .context("runtime service startup refused while development admission is closed")?;

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

fn open_existing_owner_lock(path: &Path) -> Result<File> {
    reject_link(path)?;
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .with_context(|| format!("opening existing runtime service owner lock {}", path.display()))?;
    match file.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            bail!("runtime service owner is already active")
        }
        Err(TryLockError::Error(error)) => {
            return Err(error).context("acquiring native runtime service owner lock")
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
    Ok(file)
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

fn validate_lower_hex(value: &str, field: &str, length: usize) -> Result<()> {
    if value.len() != length
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        bail!("{field} must be a lowercase {length}-character hexadecimal hash");
    }
    Ok(())
}

fn validate_canonical_uuid(value: &str, field: &str) -> Result<()> {
    let uuid = Uuid::parse_str(value).with_context(|| format!("{field} is not a UUID"))?;
    if uuid.is_nil() || uuid.to_string() != value {
        bail!("{field} must be a canonical nonzero UUID");
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_execution: Option<RuntimeServiceHostExecution>,
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

    /// Pin an explicitly supplied v2 host configuration and initialize its
    /// admission ledger on a store that has never started this service.
    ///
    /// The startup gate excludes direct owner publication. The launch gate is
    /// reacquired after the application writer is released and held through
    /// ledger initialization so no launcher can publish a launch record in
    /// between. A ledger failure leaves the exact application configuration
    /// pinned for a safe retry.
    pub fn initialize_host_application(store: &SessionStore, candidate: &Self) -> Result<Self> {
        candidate.validate()?;
        if candidate.schema_version != RUNTIME_SERVICE_CONFIG_SCHEMA_V2
            || candidate.host_execution.is_none()
        {
            bail!("host application initialization requires a v2 host execution binding");
        }
        candidate.require_application_binding(store, &candidate.target_id)?;

        let _startup_guard = RuntimeServiceStartupGuard::try_acquire(store.root())?
            .context("runtime service startup gate is busy")?;
        store
            .assert_development_admission_open()
            .context("host initialization refused while development admission is closed")?;
        Self::require_no_existing_owner_records(store)?;

        let persisted =
            Self::for_application(store, &candidate.target_id, || Ok(candidate.clone()))?;
        if &persisted != candidate {
            bail!(
                "persisted application configuration differs from the requested host configuration"
            );
        }

        // for_application has dropped its store writer before we acquire the
        // host ledger writer. Recheck while holding the launch gate because a
        // launcher may have completed after for_application released it.
        let _launch_guard = Self::acquire_host_application_ledger_guard(store)?;
        let host_execution = persisted
            .host_execution
            .as_ref()
            .context("persisted host application has no host execution binding")?;
        crate::host_resource_ledger::HostResourceLedger::initialize(
            &host_execution.ledger_root,
            host_execution.policy.clone(),
        )?;
        Ok(persisted)
    }

    /// Recover exactly one pinned `Unknown` owner after proving that the
    /// session and host stores are empty and quiescent.  This operation is
    /// explicit and operator-authorized; `ensure` never calls it implicitly.
    ///
    /// `request_sha256` is the SHA-256 of the exact request file bytes.  It is
    /// used as the durable idempotency key, so a changed request with the same
    /// request id cannot replay an earlier recovery.
    pub fn recover_unknown_empty(
        store: &SessionStore,
        candidate: &Self,
        configuration_bytes: &[u8],
        request: &RuntimeServiceRecoveryRequest,
        request_sha256: &str,
        recovery_build_commit: &str,
        recovery_build_snapshot: &str,
    ) -> Result<RuntimeServiceRecoveryReceipt> {
        candidate.validate()?;
        request.validate()?;
        if configuration_bytes.len() > MAX_RECOVERY_REQUEST_BYTES {
            bail!("runtime service recovery configuration exceeds its byte budget");
        }
        if crate::hex_sha256(configuration_bytes) != request.config_sha256 {
            bail!("runtime service recovery configuration bytes differ from the request pin");
        }
        let raw_candidate: Self = serde_json::from_slice(configuration_bytes)
            .context("parse raw runtime service recovery configuration")?;
        raw_candidate.validate()?;
        if raw_candidate != *candidate {
            bail!("raw runtime service recovery configuration differs from its typed value");
        }
        validate_lower_hex(request_sha256, "runtime service recovery request SHA-256", 64)?;
        validate_lower_hex(
            recovery_build_commit,
            "runtime service recovery build commit",
            40,
        )?;
        validate_lower_hex(
            recovery_build_snapshot,
            "runtime service recovery build snapshot",
            64,
        )?;
        candidate.require_application_binding(store, &request.expected_owner.target_id)?;
        if request.expected_owner.target_id != candidate.target_id {
            bail!("runtime service recovery target differs from application configuration");
        }
        // The CLI verifies the SHA-256 of the exact configuration bytes before
        // entering this locked core.  The native core must carry that raw
        // digest through the recovery receipt; canonicalizing the parsed JSON
        // here would silently accept a different on-disk configuration
        // representation than the operator authorized.
        let config_sha256 = request.config_sha256.clone();
        let host_execution = candidate
            .host_execution
            .as_ref()
            .context("runtime service recovery requires a host execution binding")?;

        let recovery_relative = format!(
            "runtime-services/recovery/{request_sha256}/receipt.json"
        );
        let recovery_path = checked_path(store.root(), &recovery_relative)?;
        if let Some(receipt_bytes) = read_optional_stable_regular_path(
            &recovery_path,
            MAX_RECOVERY_RECEIPT_BYTES,
            "runtime service recovery receipt",
        )? {
            let receipt: RuntimeServiceRecoveryReceipt = serde_json::from_slice(&receipt_bytes)
                .context("parse runtime service recovery receipt")?;
            receipt.validate()?;
            validate_receipt_for_request(
                &receipt,
                request,
                request_sha256,
                &config_sha256,
            )?;
            // A completed receipt is not sufficient by itself for replay:
            // the current owner, launch record, and empty-store proof are
            // rechecked under the same native guards below.  This prevents a
            // stale request from being reported as successful after a later
            // owner generation replaced the recovered one.
        }

        // Recovery is only valid for a store that already has the stable
        // guard inodes and old launch/owner evidence.  In particular, this
        // operation never creates a missing lock as a substitute for proof.
        for relative in [
            RUNTIME_SERVICE_OWNER_LOCK_PATH,
            RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
            "runtime-services/LAUNCH.lock",
            "runtime-services/LAUNCH.json",
            "runtime-services/STARTUP-GATE.lock",
        ] {
            require_existing_regular_path(store.root(), relative)?;
        }

        let _startup_guard = RuntimeServiceStartupGuard::try_acquire(store.root())?
            .context("runtime service startup gate is busy during controlled recovery")?;
        let _launch_guard = RuntimeServiceLaunchGuard::try_acquire(store.root())?
            .context("runtime service launch gate is busy during controlled recovery")?;
        let owner_lock_path = checked_path(store.root(), RUNTIME_SERVICE_OWNER_LOCK_PATH)?;
        let owner_lock = open_existing_owner_lock(&owner_lock_path)?;

        let ledger = crate::host_resource_ledger::HostResourceLedger::open(
            &host_execution.ledger_root,
            host_execution.policy.clone(),
        )?;

        let result = ledger.with_runtime_recovery_quiescence(|_| {
            let _store_writer = store.write_transaction()?;
            recover_unknown_empty_locked(
                store,
                candidate,
                configuration_bytes,
                request,
                request_sha256,
                &config_sha256,
                recovery_build_commit,
                recovery_build_snapshot,
                &recovery_relative,
                &owner_lock,
            )
        })?;
        drop(owner_lock);
        Ok(result)
    }

    fn acquire_host_application_ledger_guard(
        store: &SessionStore,
    ) -> Result<RuntimeServiceLaunchGuard> {
        let launch_guard = RuntimeServiceLaunchGuard::try_acquire(store.root())?.context(
            "application runtime launch guard is busy before host ledger initialization",
        )?;
        Self::require_no_existing_owner_records(store)?;
        Ok(launch_guard)
    }

    fn require_no_existing_owner_records(store: &SessionStore) -> Result<()> {
        for record in [
            RUNTIME_SERVICE_OWNER_LOCK_PATH,
            RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
            "runtime-services/LAUNCH.json",
        ] {
            let path = checked_path(store.root(), record)?;
            match std::fs::symlink_metadata(path) {
                Ok(_) => bail!("runtime service already has an owner or launch record; conservative recovery is required"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error).context("observe runtime service owner record"),
            }
        }
        Ok(())
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
        match self.schema_version.as_str() {
            RUNTIME_SERVICE_CONFIG_SCHEMA_V1 if self.host_execution.is_none() => {}
            RUNTIME_SERVICE_CONFIG_SCHEMA_V1 => {
                bail!("runtime service configuration v1 cannot bind host execution")
            }
            RUNTIME_SERVICE_CONFIG_SCHEMA_V2 => {
                if self.host_execution.is_none() {
                    bail!("runtime service configuration v2 requires a host execution binding");
                }
            }
            _ => bail!("unsupported runtime service configuration"),
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
        if let Some(host_execution) = &self.host_execution {
            host_execution.validate(&self.compute_resources, &self.preparation_resources)?;
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

    /// Resolve a scheduler concurrency cap from the explicitly versioned
    /// configuration. Legacy v1 configurations retain their one-worker cap.
    pub fn scheduler_concurrency(&self, role: &str) -> Result<usize> {
        let compute_role = match role {
            RUNTIME_SERVICE_COMPUTE_ROLE => true,
            RUNTIME_SERVICE_PREPARATION_ROLE => false,
            _ => bail!("unknown runtime service scheduler role `{role}`"),
        };
        self.validate()?;
        match self.schema_version.as_str() {
            RUNTIME_SERVICE_CONFIG_SCHEMA_V1 => Ok(1),
            RUNTIME_SERVICE_CONFIG_SCHEMA_V2 => {
                let host_execution = self
                    .host_execution
                    .as_ref()
                    .context("runtime service v2 host execution binding is missing")?;
                Ok(if compute_role {
                    host_execution.compute_max_concurrency
                } else {
                    host_execution.preparation_max_concurrency
                })
            }
            _ => bail!("unsupported runtime service configuration"),
        }
    }
}

fn require_existing_regular_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = checked_path(root, relative)?;
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("required runtime recovery evidence is missing: {relative}"))?;
    reject_link(&path)?;
    if !metadata.is_file() {
        bail!("runtime recovery evidence is not a regular file: {relative}");
    }
    Ok(path)
}

fn read_stable_regular_path(path: &Path, maximum: usize, context: &str) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("{context} is missing: {}", path.display()))?;
    reject_link(path)?;
    if !metadata.is_file() {
        bail!("{context} is not a regular file: {}", path.display());
    }
    let parent = path.parent().context("bounded file has no parent")?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .context("bounded file name is not UTF-8")?;
    let first = crate::repository_path::read_bounded_regular_file(parent, name, maximum)
        .with_context(|| format!("read {context}"))?;
    let second = crate::repository_path::read_bounded_regular_file(parent, name, maximum)
        .with_context(|| format!("re-read {context}"))?;
    if first != second {
        bail!("{context} changed during recovery admission");
    }
    Ok(first)
}

fn read_optional_stable_regular_path(
    path: &Path,
    maximum: usize,
    context: &str,
) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            reject_link(path)?;
            if !metadata.is_file() {
                bail!("{context} is not a regular file: {}", path.display());
            }
            Ok(Some(read_stable_regular_path(path, maximum, context)?))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("observe {context}")),
    }
}

fn require_empty_store_namespace(store: &SessionStore, relative: &str) -> Result<()> {
    let path = checked_path(store.root(), relative)?;
    let metadata = fs::symlink_metadata(&path)
        .with_context(|| format!("runtime recovery namespace is missing: {relative}"))?;
    reject_link(&path)?;
    if !metadata.is_dir() {
        bail!("runtime recovery namespace is not a directory: {relative}");
    }
    let mut entries = fs::read_dir(&path)?;
    if let Some(entry) = entries.next() {
        let entry = entry?;
        bail!(
            "runtime recovery requires an empty namespace; found {} in {relative}",
            entry.file_name().to_string_lossy()
        );
    }
    Ok(())
}

fn require_empty_batch_namespace(store: &SessionStore) -> Result<()> {
    let path = checked_path(store.root(), "batches")?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("observe batch namespace during recovery"),
        Ok(metadata) => {
            reject_link(&path)?;
            if !metadata.is_dir() {
                bail!("runtime recovery batch namespace is not a directory");
            }
        }
    }
    if !store.list_batch_intents()?.is_empty() {
        bail!("runtime recovery requires no durable batch intents");
    }
    Ok(())
}

fn require_empty_runtime_store(store: &SessionStore, config: &RuntimeServiceConfig) -> Result<()> {
    for relative in [
        "runs",
        "manifests",
        "live_command_journals",
        "recovery",
        "temp",
        "objects/pins",
    ] {
        require_empty_store_namespace(store, relative)?;
    }
    if !store.list_run_intents()?.is_empty() {
        bail!("runtime recovery requires no durable run intents");
    }
    require_empty_batch_namespace(store)?;

    let scheduler_root = checked_path(store.root(), "scheduler_pools")?;
    reject_link(&scheduler_root)?;
    let expected_names = [
        format!("{}.resources.json", config.compute_pool_id),
        format!("{}.preparation-resources.json", config.preparation_pool_id),
        format!("{}.json", config.compute_pool_id),
        format!("{}.preparation.json", config.preparation_pool_id),
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    for entry in fs::read_dir(&scheduler_root)? {
        let entry = entry?;
        reject_link(&entry.path())?;
        if !entry.file_type()?.is_file() {
            bail!("scheduler pool namespace contains a non-file entry");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("scheduler pool entry is not UTF-8"))?;
        if !expected_names.contains(&name) {
            bail!("scheduler pool namespace contains an unexpected entry {name}");
        }
    }

    let compute = store
        .read_scheduler_resource_pool(&config.compute_pool_id)?
        .context("runtime recovery compute resource pool is missing")?;
    let preparation = store
        .read_preparation_resource_pool(&config.preparation_pool_id)?
        .context("runtime recovery preparation resource pool is missing")?;
    if compute.resources != config.compute_resources
        || preparation.resources != config.preparation_resources
    {
        bail!("scheduler resource pools differ from the pinned application configuration");
    }
    if let Some(checkpoint) = store.read_scheduler_pool_checkpoint(&config.compute_pool_id)? {
        if !checkpoint.run_ids.is_empty() || checkpoint.next_run_id.is_some() {
            bail!("compute scheduler checkpoint still references work");
        }
    }
    if let Some(checkpoint) =
        store.read_preparation_scheduler_pool_checkpoint(&config.preparation_pool_id)?
    {
        if !checkpoint.run_ids.is_empty() || checkpoint.next_run_id.is_some() {
            bail!("preparation scheduler checkpoint still references work");
        }
    }
    Ok(())
}

fn expected_child<'a>(
    owner: &'a RuntimeServiceOwnerDescriptor,
    role: &str,
) -> Result<&'a RuntimeServiceChild> {
    let children = owner
        .children
        .iter()
        .filter(|child| child.role == role)
        .collect::<Vec<_>>();
    if children.len() != 1 {
        bail!("runtime recovery requires exactly one child role {role}");
    }
    let child = children[0];
    if child.status != "exited_success" {
        bail!("runtime recovery requires the child role {role} to have exited successfully");
    }
    Ok(child)
}

fn require_scheduler_drained_event(
    bytes: &[u8],
    role: &str,
    child: &RuntimeServiceChild,
    owner: &RuntimeServiceOwnerDescriptor,
    pool_id: &str,
    generation: u64,
) -> Result<()> {
    let expected_commit = owner
        .build_commit
        .as_deref()
        .context("unknown runtime owner is missing its historical build commit")?;
    let expected_snapshot = owner
        .build_snapshot
        .as_deref()
        .context("unknown runtime owner is missing its historical build snapshot")?;
    let mut found = false;
    for line in bytes.split(|byte| *byte == b'\n') {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        if value["schema_version"] != "scheduler_owner_event.v1"
            || value["event"] != "drained"
        {
            continue;
        }
        let pool_identity_matches = match (
            value["pool_id"].as_str(),
            value["generation"].as_u64(),
        ) {
            // The current scheduler owner-control producer emits null pool
            // fields for its terminal drain event.  The durable owner
            // descriptor and resource-pool records above still pin both
            // scheduler identities; accept the producer's versioned shape
            // while validating optional future pool fields when present.
            (None, None) => true,
            (Some(event_pool), Some(event_generation)) => {
                event_pool == pool_id && event_generation == generation
            }
            _ => false,
        };
        if value["role"] != role
            || value["pid"].as_u64() != Some(u64::from(child.pid))
            || value["protocol"] != RUNTIME_SERVICE_OWNER_PROTOCOL
            || value["owner_token"] != owner.owner_token
            || value["git_commit"] != expected_commit
            || value["source_snapshot_sha256"] != expected_snapshot
            || !pool_identity_matches
        {
            bail!("runtime recovery scheduler role {role} drained evidence identity mismatch");
        }
        found = true;
    }
    if !found {
        bail!("runtime recovery scheduler role {role} has no drained evidence");
    }
    Ok(())
}

fn recovery_log_sources(owner: &RuntimeServiceOwnerDescriptor) -> BTreeSet<String> {
    let log_relative = format!("runtime-services/{}", owner.owner_token);
    [
        "compute.stdout.jsonl",
        "compute.stderr.log",
        "preparation.stdout.jsonl",
        "preparation.stderr.log",
        "compute-publisher.stdout.jsonl",
        "compute-publisher.stderr.log",
        "preparation-publisher.stdout.jsonl",
        "preparation-publisher.stderr.log",
    ]
    .into_iter()
    .map(|name| format!("{log_relative}/{name}"))
    .collect()
}

fn recovery_mandatory_log_sources(owner: &RuntimeServiceOwnerDescriptor) -> BTreeSet<String> {
    let log_relative = format!("runtime-services/{}", owner.owner_token);
    [
        "compute.stdout.jsonl",
        "preparation.stdout.jsonl",
    ]
    .into_iter()
    .map(|name| format!("{log_relative}/{name}"))
    .collect()
}

fn observe_recovery_log_sources(
    store: &SessionStore,
    owner: &RuntimeServiceOwnerDescriptor,
) -> Result<BTreeSet<String>> {
    let log_relative = format!("runtime-services/{}", owner.owner_token);
    let log_root = checked_path(store.root(), &log_relative)?;
    let metadata = fs::symlink_metadata(&log_root)
        .context("runtime recovery scheduler log directory is missing")?;
    reject_link(&log_root)?;
    if !metadata.is_dir() {
        bail!("runtime recovery scheduler log namespace is not a directory");
    }
    let allowed_logs = recovery_log_sources(owner);
    let mandatory_logs = recovery_mandatory_log_sources(owner);
    let mut observed_logs = BTreeSet::new();
    for entry in fs::read_dir(&log_root)? {
        let entry = entry?;
        reject_link(&entry.path())?;
        if !entry.file_type()?.is_file() {
            bail!("runtime scheduler evidence contains a non-file entry");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("runtime scheduler evidence file is not UTF-8"))?;
        let source = format!("{log_relative}/{name}");
        if !allowed_logs.contains(&source) || !observed_logs.insert(source.clone()) {
            bail!("runtime scheduler evidence contains an unexpected entry {name}");
        }
    }
    if !observed_logs.is_superset(&mandatory_logs) {
        bail!("runtime scheduler evidence is missing a mandatory journal");
    }
    Ok(observed_logs)
}

fn recovery_mandatory_sources(owner: &RuntimeServiceOwnerDescriptor) -> Result<BTreeSet<String>> {
    let compute_pool_id = owner
        .compute_pool_id
        .as_deref()
        .context("runtime recovery owner is missing its compute pool id")?;
    let preparation_pool_id = owner
        .preparation_pool_id
        .as_deref()
        .context("runtime recovery owner is missing its preparation pool id")?;
    let mut sources = BTreeSet::new();
    for source in [
        RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH.to_owned(),
        RUNTIME_SERVICE_OWNER_LOCK_PATH.to_owned(),
        "runtime-services/LAUNCH.json".to_owned(),
        "runtime-services/LAUNCH.lock".to_owned(),
        "runtime-services/STARTUP-GATE.lock".to_owned(),
        format!(
            "runtime-services/{}/compute.stdout.jsonl",
            owner.owner_token
        ),
        format!(
            "runtime-services/{}/preparation.stdout.jsonl",
            owner.owner_token
        ),
        format!("scheduler_pools/{compute_pool_id}.resources.json"),
        format!("scheduler_pools/{preparation_pool_id}.preparation-resources.json"),
        RECOVERY_ARCHIVED_CONFIGURATION_KEY.to_owned(),
    ] {
        if !sources.insert(source.clone()) {
            bail!("runtime recovery mandatory archive source is duplicated: {source}");
        }
    }
    sources.extend(recovery_checkpoint_sources(owner)?);
    Ok(sources)
}

fn validate_recovery_absent_source_path(source: &str) -> Result<()> {
    validate_relative_path(source)?;
    let name = source
        .strip_prefix("scheduler_pools/")
        .context("runtime recovery absent source is not a scheduler checkpoint")?;
    if name.is_empty()
        || name.ends_with(".resources.json")
        || name.ends_with(".preparation-resources.json")
    {
        bail!("runtime recovery absent source is not a checkpoint path: {source}");
    }
    let pool_id = name
        .strip_suffix(".preparation.json")
        .or_else(|| name.strip_suffix(".json"))
        .filter(|value| !value.is_empty())
        .context("runtime recovery absent source is not a checkpoint path")?;
    validate_store_id(pool_id)
}

fn validate_recovery_archived_source_path(source: &str) -> Result<()> {
    validate_relative_path(source)?;
    if source == RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH
        || source == RUNTIME_SERVICE_OWNER_LOCK_PATH
        || source == "runtime-services/LAUNCH.json"
        || source == "runtime-services/LAUNCH.lock"
        || source == "runtime-services/STARTUP-GATE.lock"
        || source == RECOVERY_ARCHIVED_CONFIGURATION_KEY
    {
        return Ok(());
    }
    if let Some(rest) = source.strip_prefix("runtime-services/") {
        let mut components = rest.split('/');
        let owner_token = components
            .next()
            .context("runtime recovery archived log is missing its owner token")?;
        let name = components
            .next()
            .context("runtime recovery archived log is missing its file name")?;
        if components.next().is_some() {
            bail!("runtime recovery archived log has unexpected path components: {source}");
        }
        validate_store_id(owner_token)?;
        if matches!(
            name,
            "compute.stdout.jsonl"
                | "compute.stderr.log"
                | "preparation.stdout.jsonl"
                | "preparation.stderr.log"
                | "compute-publisher.stdout.jsonl"
                | "compute-publisher.stderr.log"
                | "preparation-publisher.stdout.jsonl"
                | "preparation-publisher.stderr.log"
        ) {
            return Ok(());
        }
        bail!("runtime recovery archived log is not on the producer allowlist: {source}");
    }
    if let Some(name) = source.strip_prefix("scheduler_pools/") {
        let pool_id = name
            .strip_suffix(".preparation-resources.json")
            .or_else(|| name.strip_suffix(".resources.json"))
            .or_else(|| name.strip_suffix(".preparation.json"))
            .or_else(|| name.strip_suffix(".json"))
            .filter(|value| !value.is_empty())
            .context("runtime recovery scheduler source is not a recognized file")?;
        validate_store_id(pool_id)?;
        return Ok(());
    }
    bail!("runtime recovery archived source is not on the allowlist: {source}");
}

fn recovery_checkpoint_sources(owner: &RuntimeServiceOwnerDescriptor) -> Result<BTreeSet<String>> {
    let compute_pool_id = owner
        .compute_pool_id
        .as_deref()
        .context("runtime recovery owner is missing its compute pool id")?;
    let preparation_pool_id = owner
        .preparation_pool_id
        .as_deref()
        .context("runtime recovery owner is missing its preparation pool id")?;
    let sources = [
        format!("scheduler_pools/{compute_pool_id}.json"),
        format!("scheduler_pools/{preparation_pool_id}.preparation.json"),
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    for source in &sources {
        validate_recovery_absent_source_path(source)?;
    }
    Ok(sources)
}

fn scheduler_checkpoint_sequence(bytes: &[u8], role: &str, pool_id: &str) -> Result<u64> {
    let mut sequence = None;
    for line in bytes.split(|byte| *byte == b'\n') {
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("pool_checkpoint_sequence").is_none()
            || value.get("pool_id").and_then(serde_json::Value::as_str) != Some(pool_id)
        {
            continue;
        }
        if value.get("status").and_then(serde_json::Value::as_str) != Some("drained")
            || value
                .get("shutdown_requested")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
        {
            bail!("runtime recovery scheduler {role} summary is not a terminal drain");
        }
        let current = value
            .get("pool_checkpoint_sequence")
            .and_then(serde_json::Value::as_u64)
            .context("runtime recovery scheduler summary has no checkpoint sequence")?;
        if current == 0
            && (value
                .get("scheduled_count")
                .and_then(serde_json::Value::as_u64)
                != Some(0)
                || value
                    .get("executed")
                    .and_then(serde_json::Value::as_array)
                    .map_or(true, |executed| !executed.is_empty()))
        {
            bail!(
                "runtime recovery scheduler {role} zero-checkpoint summary reports completed work"
            );
        }
        if sequence.replace(current).is_some() {
            bail!("runtime recovery scheduler {role} emitted duplicate summaries");
        }
    }
    sequence.with_context(|| {
        format!(
            "runtime recovery scheduler {role} emitted no terminal checkpoint summary"
        )
    })
}

fn observe_recovery_checkpoint_absences(
    store: &SessionStore,
    owner: &RuntimeServiceOwnerDescriptor,
) -> Result<BTreeMap<String, RuntimeServiceRecoveryAbsentSourceReason>> {
    let compute_pool_id = owner
        .compute_pool_id
        .as_deref()
        .context("runtime recovery owner is missing its compute pool id")?;
    let preparation_pool_id = owner
        .preparation_pool_id
        .as_deref()
        .context("runtime recovery owner is missing its preparation pool id")?;
    let observations = [
        (
            RUNTIME_SERVICE_COMPUTE_ROLE,
            compute_pool_id,
            format!("scheduler_pools/{compute_pool_id}.json"),
        ),
        (
            RUNTIME_SERVICE_PREPARATION_ROLE,
            preparation_pool_id,
            format!("scheduler_pools/{preparation_pool_id}.preparation.json"),
        ),
    ];
    let mut absent = BTreeMap::new();
    for (role, pool_id, checkpoint_relative) in observations {
        let log_relative = format!(
            "runtime-services/{}/{}.stdout.jsonl",
            owner.owner_token, role
        );
        let log = read_stable_regular_path(
            &checked_path(store.root(), &log_relative)?,
            MAX_RECOVERY_LOG_BYTES,
            "runtime recovery scheduler summary",
        )?;
        let sequence = scheduler_checkpoint_sequence(&log, role, pool_id)?;
        let checkpoint = checked_path(store.root(), &checkpoint_relative)?;
        match fs::symlink_metadata(&checkpoint) {
            Ok(metadata) => {
                reject_link(&checkpoint)?;
                if !metadata.is_file() {
                    bail!("runtime recovery scheduler checkpoint is not a regular file");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if sequence != 0 {
                    bail!(
                        "runtime recovery scheduler {role} omitted checkpoint sequence {sequence}"
                    );
                }
                absent.insert(
                    checkpoint_relative,
                    RuntimeServiceRecoveryAbsentSourceReason::SchedulerCheckpointNotPublished,
                );
            }
            Err(error) => return Err(error).context("observe runtime recovery checkpoint"),
        }
    }
    Ok(absent)
}

fn archive_exact_file(
    root: &Path,
    archive_relative: &str,
    source_relative: &str,
    maximum: usize,
    archived: &mut BTreeMap<String, String>,
) -> Result<Vec<u8>> {
    validate_relative_path(source_relative)?;
    let source = checked_path(root, source_relative)?;
    let bytes = read_stable_regular_path(&source, maximum, source_relative)?;
    let digest = crate::hex_sha256(&bytes);
    let name = source
        .file_name()
        .and_then(|value| value.to_str())
        .context("runtime recovery source file name is not UTF-8")?;
    validate_store_id(name)?;
    let destination_relative = format!("{archive_relative}/{name}");
    let destination_path = checked_path(root, &destination_relative)?;
    let destination = if destination_path.exists() {
        destination_path
    } else {
        create_parent(root, &destination_relative)?
    };
    if destination.exists() {
        let existing = read_stable_regular_path(
            &destination,
            maximum,
            "runtime recovery archive evidence",
        )?;
        if existing != bytes {
            bail!("runtime recovery archive evidence changed for {source_relative}");
        }
    } else {
        crate::durability::atomic_write_owner(&destination, &bytes)?;
    }
    if archived
        .insert(source_relative.to_owned(), digest.clone())
        .is_some()
    {
        bail!("runtime recovery archive source was duplicated");
    }
    Ok(bytes)
}

fn archive_exact_bytes(
    root: &Path,
    archive_relative: &str,
    archive_name: &str,
    source_key: &str,
    bytes: &[u8],
    maximum: usize,
    archived: &mut BTreeMap<String, String>,
) -> Result<()> {
    validate_relative_path(source_key)?;
    validate_store_id(archive_name)?;
    if bytes.len() > maximum {
        bail!("runtime recovery archive source exceeds its byte budget");
    }
    let digest = crate::hex_sha256(bytes);
    let destination_relative = format!("{archive_relative}/{archive_name}");
    let destination_path = checked_path(root, &destination_relative)?;
    let destination = if destination_path.exists() {
        destination_path
    } else {
        create_parent(root, &destination_relative)?
    };
    if destination.exists() {
        let existing = read_stable_regular_path(
            &destination,
            maximum,
            "runtime recovery archive evidence",
        )?;
        if existing != bytes {
            bail!("runtime recovery archive evidence changed for {source_key}");
        }
    } else {
        crate::durability::atomic_write_owner(&destination, bytes)?;
    }
    if archived.insert(source_key.to_owned(), digest).is_some() {
        bail!("runtime recovery archive source was duplicated");
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RecoveryApplicationBinding {
    ExternalOnly { raw_sha256: String },
    Persisted { raw_sha256: String },
}

fn validate_recovery_application_configuration(
    store: &SessionStore,
    candidate: &RuntimeServiceConfig,
    external_config_sha256: &str,
) -> Result<RecoveryApplicationBinding> {
    let application_path = checked_path(store.root(), "runtime-services/APPLICATION.json")?;
    match fs::symlink_metadata(&application_path) {
        Ok(_) => {
            let application_bytes = read_stable_regular_path(
                &application_path,
                MAX_RECOVERY_REQUEST_BYTES,
                "persisted runtime service application configuration",
            )?;
            let persisted: RuntimeServiceConfig = serde_json::from_slice(&application_bytes)
                .context("parse persisted runtime service application configuration")?;
            persisted.validate()?;
            persisted.require_application_binding(store, &candidate.target_id)?;
            if persisted != *candidate {
                bail!("persisted application configuration differs from recovery request");
            }
            Ok(RecoveryApplicationBinding::Persisted {
                raw_sha256: crate::hex_sha256(&application_bytes),
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(RecoveryApplicationBinding::ExternalOnly {
                raw_sha256: external_config_sha256.into(),
            })
        }
        Err(error) => Err(error)
            .context("observe persisted runtime service application configuration"),
    }
}

fn application_binding_manifest_value(
    binding: &RecoveryApplicationBinding,
) -> serde_json::Value {
    match binding {
        RecoveryApplicationBinding::ExternalOnly { raw_sha256 } => serde_json::json!({
            "mode": "external_only",
            "raw_sha256": raw_sha256,
        }),
        RecoveryApplicationBinding::Persisted { raw_sha256 } => serde_json::json!({
            "mode": "persisted",
            "raw_sha256": raw_sha256,
        }),
    }
}

fn archive_runtime_evidence(
    store: &SessionStore,
    owner: &RuntimeServiceOwnerDescriptor,
    request_sha256: &str,
    config_sha256: &str,
    configuration_bytes: &[u8],
    application_binding: &RecoveryApplicationBinding,
) -> Result<(
    String,
    String,
    BTreeMap<String, String>,
    BTreeMap<String, RuntimeServiceRecoveryAbsentSourceReason>,
)> {
    let archive_relative = format!("runtime-services/recovery/{request_sha256}/archive");
    let mandatory_sources = recovery_mandatory_sources(owner)?;
    if crate::hex_sha256(configuration_bytes) != config_sha256 {
        bail!("runtime recovery raw configuration bytes differ from the request pin");
    }
    let observed_logs = observe_recovery_log_sources(store, owner)?;
    let absent_sources = observe_recovery_checkpoint_absences(store, owner)?;
    let mut archive_sources = mandatory_sources.clone();
    for source in absent_sources.keys() {
        if !archive_sources.remove(source) {
            bail!("runtime recovery absent source is not mandatory: {source}");
        }
    }
    archive_sources.extend(observed_logs);
    let mut archived = BTreeMap::new();
    for source in &archive_sources {
        if source == RECOVERY_ARCHIVED_CONFIGURATION_KEY {
            continue;
        }
        archive_exact_file(
            store.root(),
            &archive_relative,
            source,
            if source.ends_with(".jsonl") || source.ends_with(".log") {
                MAX_RECOVERY_LOG_BYTES
            } else {
                MAX_RECOVERY_REQUEST_BYTES
            },
            &mut archived,
        )?;
    }
    archive_exact_bytes(
        store.root(),
        &archive_relative,
        RECOVERY_ARCHIVED_CONFIGURATION_KEY,
        RECOVERY_ARCHIVED_CONFIGURATION_KEY,
        configuration_bytes,
        MAX_RECOVERY_REQUEST_BYTES,
        &mut archived,
    )?;
    if archived.len() != archive_sources.len()
        || archived.len() + absent_sources.len() < mandatory_sources.len()
        || archived.len() + absent_sources.len() > MAX_RECOVERY_ARCHIVED_FILES
    {
        bail!("runtime recovery evidence has an incomplete inventory");
    }
    let manifest_relative = format!("{archive_relative}/manifest.json");
    let manifest_path = create_parent(store.root(), &manifest_relative)?;
    let manifest_value = serde_json::json!({
        "schema_version": "runtime_service_recovery_archive.v1",
        "request_sha256": request_sha256,
        "config_sha256": config_sha256,
        "application_binding": application_binding_manifest_value(application_binding),
        "files": archived.clone(),
        "absent_sources": absent_sources.clone(),
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest_value)?;
    if manifest_bytes.len() > MAX_RECOVERY_RECEIPT_BYTES {
        bail!("runtime recovery archive manifest exceeds its byte budget");
    }
    let published_manifest = match read_optional_stable_regular_path(
        &manifest_path,
        MAX_RECOVERY_RECEIPT_BYTES,
        "runtime recovery archive manifest",
    )? {
        Some(existing) if existing != manifest_bytes => {
            bail!("runtime recovery archive manifest changed during recovery")
        }
        Some(existing) => existing,
        None => {
            crate::durability::atomic_write_owner(&manifest_path, &manifest_bytes)?;
            manifest_bytes
        }
    };
    let archive_path = manifest_path
        .to_str()
        .context("runtime recovery archive path is not UTF-8")?
        .to_owned();
    Ok((
        archive_path,
        crate::hex_sha256(&published_manifest),
        archived,
        absent_sources,
    ))
}

fn validate_receipt_for_request(
    receipt: &RuntimeServiceRecoveryReceipt,
    request: &RuntimeServiceRecoveryRequest,
    request_sha256: &str,
    config_sha256: &str,
) -> Result<()> {
    if receipt.request_id != request.request_id
        || receipt.request_sha256 != request_sha256
        || receipt.config_sha256 != config_sha256
        || receipt.target_id != request.expected_owner.target_id
    {
        bail!("runtime recovery receipt does not match the pinned request");
    }
    if receipt.historical_build_commit
        != request
            .expected_owner
            .build_commit
            .as_deref()
            .context("recovery request is missing historical build commit")?
        || receipt.historical_build_snapshot
            != request
                .expected_owner
                .build_snapshot
                .as_deref()
                .context("recovery request is missing historical build snapshot")?
    {
        bail!("runtime recovery receipt historical build identity mismatch");
    }
    Ok(())
}

fn verify_archived_application_binding(
    store: &SessionStore,
    receipt: &RuntimeServiceRecoveryReceipt,
    manifest: &serde_json::Value,
) -> Result<()> {
    let application_path = checked_path(store.root(), "runtime-services/APPLICATION.json")?;
    let Some(binding) = manifest.get("application_binding") else {
        // Archives written before the binding metadata existed retain the old
        // strict rule: an application configuration must already be present.
        require_existing_regular_path(store.root(), "runtime-services/APPLICATION.json")?;
        return Ok(());
    };
    let object = binding
        .as_object()
        .context("runtime recovery application binding is not an object")?;
    if object.len() != 2 {
        bail!("runtime recovery application binding contains unknown fields");
    }
    let mode = object
        .get("mode")
        .and_then(serde_json::Value::as_str)
        .context("runtime recovery application binding mode is missing")?;
    let raw_sha256 = object
        .get("raw_sha256")
        .and_then(serde_json::Value::as_str)
        .context("runtime recovery application binding raw SHA-256 is missing")?;
    validate_lower_hex(
        raw_sha256,
        "runtime recovery application binding raw SHA-256",
        64,
    )?;
    match mode {
        "external_only" => {
            if raw_sha256 != receipt.config_sha256.as_str() {
                bail!("external-only application binding is not pinned to the recovery configuration");
            }
            match fs::symlink_metadata(&application_path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Ok(_) => bail!(
                    "external-only recovery requires APPLICATION.json to remain absent"
                ),
                Err(error) => Err(error)
                    .context("observe external-only application configuration"),
            }
        }
        "persisted" => {
            let application_bytes = read_stable_regular_path(
                &application_path,
                MAX_RECOVERY_REQUEST_BYTES,
                "persisted runtime service application configuration",
            )?;
            if crate::hex_sha256(&application_bytes) != raw_sha256 {
                bail!("persisted application configuration digest differs from the archive binding");
            }
            Ok(())
        }
        _ => bail!("unsupported runtime recovery application binding mode"),
    }
}

fn verify_archived_evidence(
    store: &SessionStore,
    receipt: &RuntimeServiceRecoveryReceipt,
) -> Result<()> {
    let manifest_path = recovery_archive_manifest_path(store, receipt)?;
    let manifest_bytes = read_stable_regular_path(
        &manifest_path,
        MAX_RECOVERY_RECEIPT_BYTES,
        "runtime recovery archive manifest",
    )?;
    if crate::hex_sha256(&manifest_bytes) != receipt.archived_evidence_sha256 {
        bail!("runtime recovery archive manifest digest differs from the receipt");
    }
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)
        .context("parse runtime recovery archive manifest")?;
    let manifest_absent_sources = manifest
        .get("absent_sources")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    if manifest["schema_version"] != "runtime_service_recovery_archive.v1"
        || manifest["request_sha256"] != receipt.request_sha256
        || manifest["config_sha256"] != receipt.config_sha256
        || manifest["files"]
            != serde_json::to_value(&receipt.archived_files)
                .context("serialize runtime recovery archive inventory")?
        || manifest_absent_sources
            != serde_json::to_value(&receipt.archived_absent_sources)
                .context("serialize runtime recovery absent-source inventory")?
    {
        bail!("runtime recovery archive manifest does not match the receipt");
    }
    verify_archived_application_binding(store, receipt, &manifest)?;
    let owner_path = checked_path(store.root(), RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH)?;
    let current_owner_bytes = read_stable_regular_path(
        &owner_path,
        MAX_RECOVERY_REQUEST_BYTES,
        "runtime recovery owner descriptor",
    )?;
    let current_owner: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&current_owner_bytes)
        .context("parse runtime recovery owner descriptor for archive inventory")?;
    validate_descriptor(&current_owner)?;
    let mandatory_sources = recovery_mandatory_sources(&current_owner)?;
    let mut allowed_sources = mandatory_sources.clone();
    allowed_sources.extend(recovery_log_sources(&current_owner));
    let archived_sources = receipt
        .archived_files
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let absent_sources = receipt
        .archived_absent_sources
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    let checkpoint_sources = recovery_checkpoint_sources(&current_owner)?;
    let coverage = archived_sources
        .union(&absent_sources)
        .cloned()
        .collect::<BTreeSet<_>>();
    if !absent_sources.is_subset(&checkpoint_sources)
        || !archived_sources.is_disjoint(&absent_sources)
        || !archived_sources.is_subset(&allowed_sources)
        || !coverage.is_superset(&mandatory_sources)
        || !coverage.is_subset(&allowed_sources)
    {
        bail!("runtime recovery archive inventory is missing or contains unexpected evidence");
    }
    let observed_logs = observe_recovery_log_sources(store, &current_owner)?;
    let observed_absent_sources = observe_recovery_checkpoint_absences(store, &current_owner)?
        .keys()
        .cloned()
        .collect::<BTreeSet<_>>();
    if observed_absent_sources != absent_sources {
        bail!("runtime recovery absent checkpoint inventory differs from the live namespace");
    }
    let expected_sources = mandatory_sources
        .union(&observed_logs)
        .cloned()
        .collect::<BTreeSet<_>>();
    if coverage != expected_sources {
        bail!("runtime recovery archive inventory is incomplete or contains unexpected evidence");
    }
    let log_prefix = format!("runtime-services/{}/", current_owner.owner_token);
    let archived_logs = archived_sources
        .iter()
        .filter(|source| source.starts_with(&log_prefix))
        .cloned()
        .collect::<BTreeSet<_>>();
    if observed_logs != archived_logs {
        bail!("runtime recovery archive scheduler evidence inventory differs from the live namespace");
    }
    if receipt.archived_files.get(RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH)
        .map(String::as_str)
        != Some(receipt.owner_sha256_before.as_str())
    {
        bail!("runtime recovery archive does not pin the pre-recovery owner descriptor");
    }
    let archive_root = manifest_path
        .parent()
        .context("runtime recovery archive manifest has no parent")?;
    for (source_relative, expected_digest) in &receipt.archived_files {
        if source_relative == RECOVERY_ARCHIVED_CONFIGURATION_KEY {
            if expected_digest != &receipt.config_sha256 {
                bail!("runtime recovery raw configuration archive digest is not pinned");
            }
            let archive = checked_path(archive_root, RECOVERY_ARCHIVED_CONFIGURATION_KEY)?;
            let archive_bytes = read_stable_regular_path(
                &archive,
                MAX_RECOVERY_REQUEST_BYTES,
                "runtime recovery raw configuration archive",
            )?;
            if crate::hex_sha256(&archive_bytes) != *expected_digest {
                bail!("runtime recovery raw configuration archive digest changed");
            }
            continue;
        }
        let source = checked_path(store.root(), source_relative)?;
        let maximum =
            if source_relative.ends_with(".jsonl") || source_relative.ends_with(".log") {
                MAX_RECOVERY_LOG_BYTES
            } else {
                MAX_RECOVERY_REQUEST_BYTES
            };
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .context("runtime recovery evidence file name is not UTF-8")?;
        let archive = checked_path(archive_root, name)?;
        let archive_bytes =
            read_stable_regular_path(&archive, maximum, "runtime recovery archive")?;
        if crate::hex_sha256(&archive_bytes) != *expected_digest {
            bail!("runtime recovery archive digest changed for {source_relative}");
        }
        let source_bytes = read_stable_regular_path(&source, maximum, source_relative)?;
        if source_relative == RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH {
            let current_digest = crate::hex_sha256(&source_bytes);
            if current_digest != receipt.owner_sha256_before
                && current_digest != receipt.owner_sha256_after
            {
                bail!("runtime recovery owner descriptor changed outside the pinned transition");
            }
        } else if archive_bytes != source_bytes {
            bail!("runtime recovery archive evidence does not match {source_relative}");
        }
    }
    Ok(())
}

fn recovery_archive_manifest_path(
    store: &SessionStore,
    receipt: &RuntimeServiceRecoveryReceipt,
) -> Result<PathBuf> {
    let path = Path::new(&receipt.archived_evidence_path);
    let root = fs::canonicalize(store.root())?;
    let relative = path
        .strip_prefix(&root)
        .context("runtime recovery archive is outside the session store")?;
    let relative = relative
        .to_str()
        .context("runtime recovery archive path is not UTF-8")?;
    let checked = checked_path(store.root(), relative)?;
    if checked != path {
        bail!("runtime recovery archive path is not canonical");
    }
    Ok(checked)
}

fn recover_unknown_empty_locked(
    store: &SessionStore,
    candidate: &RuntimeServiceConfig,
    configuration_bytes: &[u8],
    request: &RuntimeServiceRecoveryRequest,
    request_sha256: &str,
    config_sha256: &str,
    recovery_build_commit: &str,
    recovery_build_snapshot: &str,
    recovery_relative: &str,
    owner_lock: &File,
) -> Result<RuntimeServiceRecoveryReceipt> {
    owner_lock
        .metadata()
        .context("runtime service owner lock disappeared during recovery")?;
    require_empty_runtime_store(store, candidate)?;

    let owner_path = checked_path(store.root(), RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH)?;
    let launch_path = checked_path(store.root(), "runtime-services/LAUNCH.json")?;
    let owner_bytes = read_stable_regular_path(
        &owner_path,
        MAX_RECOVERY_REQUEST_BYTES,
        "runtime service owner descriptor",
    )?;
    let owner_sha256 = crate::hex_sha256(&owner_bytes);
    let current_owner: RuntimeServiceOwnerDescriptor = serde_json::from_slice(&owner_bytes)
        .context("parse runtime service owner descriptor during recovery")?;
    validate_descriptor(&current_owner)?;
    let launch_bytes = read_stable_regular_path(
        &launch_path,
        MAX_RECOVERY_REQUEST_BYTES,
        "runtime service launch record",
    )?;
    if crate::hex_sha256(&launch_bytes) != request.launch_sha256 {
        bail!("runtime service launch record differs from the pinned launch SHA-256");
    }
    let launch: RuntimeServiceLaunchRecord =
        serde_json::from_slice(&launch_bytes).context("parse runtime service launch record")?;
    validate_canonical_uuid(&launch.launch_id, "runtime service launch id")?;
    if launch.schema_version != "runtime_service_launch.v1"
        || !matches!(launch.state.as_str(), "spawned" | "ready")
        || launch.pid != Some(request.expected_owner.pid)
    {
        bail!("runtime service launch record is new or uncertain; recovery refused");
    }

    let expected = &request.expected_owner;
    validate_canonical_uuid(&expected.owner_token, "runtime service owner token")?;
    validate_canonical_uuid(
        &expected.process_start_token,
        "runtime service process-start token",
    )?;
    if expected.build_commit.is_none()
        || expected.build_snapshot.is_none()
        || expected.compute_pool_id.is_none()
        || expected.preparation_pool_id.is_none()
        || expected.compute_pool_generation.is_none()
        || expected.preparation_pool_generation.is_none()
    {
        bail!("unknown runtime owner lacks historical build or scheduler identity");
    }
    if current_owner != *expected && current_owner.state != RuntimeServiceState::Failed {
        bail!("runtime service owner differs from the pinned unknown owner");
    }
    if owner_sha256 != request.owner_sha256 && current_owner.state != RuntimeServiceState::Failed {
        bail!("runtime service owner descriptor differs from the pinned owner SHA-256");
    }
    let compute_child = expected_child(expected, RUNTIME_SERVICE_COMPUTE_ROLE)?;
    let preparation_child = expected_child(expected, RUNTIME_SERVICE_PREPARATION_ROLE)?;
    if expected.children.len() != 2 {
        bail!("runtime recovery requires exactly compute and preparation children");
    }
    let compute_pool_id = expected
        .compute_pool_id
        .as_deref()
        .context("missing historical compute pool id")?;
    let preparation_pool_id = expected
        .preparation_pool_id
        .as_deref()
        .context("missing historical preparation pool id")?;
    let compute_generation = expected
        .compute_pool_generation
        .context("missing historical compute pool generation")?;
    let preparation_generation = expected
        .preparation_pool_generation
        .context("missing historical preparation pool generation")?;
    if compute_pool_id != candidate.compute_pool_id
        || preparation_pool_id != candidate.preparation_pool_id
    {
        bail!("runtime owner scheduler pools differ from the application configuration");
    }
    let compute_pool = store
        .read_scheduler_resource_pool(compute_pool_id)?
        .context("runtime recovery compute resource pool disappeared")?;
    let preparation_pool = store
        .read_preparation_resource_pool(preparation_pool_id)?
        .context("runtime recovery preparation resource pool disappeared")?;
    if compute_pool.generation != compute_generation
        || preparation_pool.generation != preparation_generation
    {
        bail!("runtime owner scheduler generations differ from the durable pools");
    }

    let compute_log_relative = format!(
        "runtime-services/{}/compute.stdout.jsonl",
        expected.owner_token
    );
    let preparation_log_relative = format!(
        "runtime-services/{}/preparation.stdout.jsonl",
        expected.owner_token
    );
    let compute_log = read_stable_regular_path(
        &checked_path(store.root(), &compute_log_relative)?,
        MAX_RECOVERY_LOG_BYTES,
        "compute scheduler drained log",
    )?;
    let preparation_log = read_stable_regular_path(
        &checked_path(store.root(), &preparation_log_relative)?,
        MAX_RECOVERY_LOG_BYTES,
        "preparation scheduler drained log",
    )?;
    require_scheduler_drained_event(
        &compute_log,
        RUNTIME_SERVICE_COMPUTE_ROLE,
        compute_child,
        expected,
        compute_pool_id,
        compute_generation,
    )?;
    require_scheduler_drained_event(
        &preparation_log,
        RUNTIME_SERVICE_PREPARATION_ROLE,
        preparation_child,
        expected,
        preparation_pool_id,
        preparation_generation,
    )?;

    let recovery_bytes = read_optional_stable_regular_path(
        &checked_path(store.root(), recovery_relative)?,
        MAX_RECOVERY_RECEIPT_BYTES,
        "runtime service recovery receipt",
    )?;
    let prepared = recovery_bytes
        .as_deref()
        .map(serde_json::from_slice::<RuntimeServiceRecoveryReceipt>)
        .transpose()
        .context("parse prepared runtime service recovery receipt")?;
    // This observation is performed under all recovery guards and the store
    // writer, before any new archive or prepared intent mutation.
    let application_binding =
        validate_recovery_application_configuration(store, candidate, config_sha256)?;
    if let Some(receipt) = &prepared {
        receipt.validate()?;
        validate_receipt_for_request(receipt, request, request_sha256, config_sha256)?;
        verify_archived_evidence(store, receipt)?;
        if receipt.owner_sha256_before != request.owner_sha256 {
            bail!("prepared runtime recovery receipt has a different owner pin");
        }
    }
    if current_owner.state == RuntimeServiceState::Failed && prepared.is_none() {
        bail!("failed runtime owner has no prepared recovery receipt");
    }

    let (
        archived_evidence_path,
        archived_evidence_sha256,
        archived_files,
        archived_absent_sources,
    ) = match prepared.as_ref() {
        Some(receipt) => (
            receipt.archived_evidence_path.clone(),
            receipt.archived_evidence_sha256.clone(),
            receipt.archived_files.clone(),
            receipt.archived_absent_sources.clone(),
        ),
        None => archive_runtime_evidence(
            store,
            expected,
            request_sha256,
            config_sha256,
            configuration_bytes,
            &application_binding,
        )?,
    };
    let historical_build_commit = expected
        .build_commit
        .clone()
        .context("missing historical runtime service build commit")?;
    let historical_build_snapshot = expected
        .build_snapshot
        .clone()
        .context("missing historical runtime service build snapshot")?;
    let recovery_created_at = prepared
        .as_ref()
        .map(|receipt| receipt.created_at.clone())
        .unwrap_or_else(Utc::now);
    let mut failed = expected.clone();
    failed.state = RuntimeServiceState::Failed;
    failed.heartbeat_at = recovery_created_at;
    failed.control_address = None;
    validate_descriptor(&failed)?;
    let failed_bytes = serde_json::to_vec_pretty(&failed)?;
    let after_owner_sha256 = crate::hex_sha256(&failed_bytes);
    let was_prepared = prepared.is_some();
    let mut receipt = prepared.unwrap_or(RuntimeServiceRecoveryReceipt {
        schema_version: RUNTIME_SERVICE_RECOVERY_SCHEMA.into(),
        request_id: request.request_id.clone(),
        request_sha256: request_sha256.into(),
        status: "prepared".into(),
        outcome: "failed".into(),
        target_id: expected.target_id.clone(),
        config_sha256: config_sha256.into(),
        owner_sha256_before: request.owner_sha256.clone(),
        owner_state_after: "failed".into(),
        owner_sha256_after: after_owner_sha256.clone(),
        archived_evidence_path,
        archived_evidence_sha256,
        archived_files,
        archived_absent_sources,
        historical_build_commit,
        historical_build_snapshot,
        executor_build_commit: recovery_build_commit.into(),
        executor_build_snapshot: recovery_build_snapshot.into(),
        created_at: recovery_created_at,
        completed_at: None,
    });
    receipt.validate()?;
    if receipt.owner_sha256_after != after_owner_sha256 {
        bail!("prepared runtime recovery result differs from the pinned transition");
    }
    if receipt.executor_build_commit != recovery_build_commit
        || receipt.executor_build_snapshot != recovery_build_snapshot
    {
        bail!("prepared runtime recovery executor identity differs from this binary");
    }
    verify_archived_evidence(store, &receipt)?;
    let receipt_path = checked_path(store.root(), recovery_relative)?;
    let receipt_bytes = serde_json::to_vec_pretty(&receipt)?;
    if receipt_bytes.len() > MAX_RECOVERY_RECEIPT_BYTES {
        bail!("runtime recovery receipt exceeds its byte budget");
    }
    if !was_prepared {
        create_parent(store.root(), recovery_relative)?;
        crate::durability::atomic_write_owner(&receipt_path, &receipt_bytes)?;
    }

    if current_owner.state == RuntimeServiceState::Failed {
        if !was_prepared || owner_sha256 != receipt.owner_sha256_after {
            bail!("failed runtime owner exists without a matching prepared recovery receipt");
        }
        if receipt.status == "recovered" {
            return Ok(receipt);
        }
        receipt.status = "recovered".into();
        receipt.completed_at = Some(Utc::now());
        receipt.validate()?;
        let completed_bytes = serde_json::to_vec_pretty(&receipt)?;
        crate::durability::atomic_write_owner(&receipt_path, &completed_bytes)?;
        return Ok(receipt);
    }

    let owner_before_publish = read_stable_regular_path(
        &owner_path,
        MAX_RECOVERY_REQUEST_BYTES,
        "runtime service owner descriptor before recovery publication",
    )?;
    if crate::hex_sha256(&owner_before_publish) != request.owner_sha256
        || owner_before_publish != owner_bytes
    {
        bail!("runtime service owner changed before recovery publication");
    }
    let launch_before_publish = read_stable_regular_path(
        &launch_path,
        MAX_RECOVERY_REQUEST_BYTES,
        "runtime service launch record before recovery publication",
    )?;
    if crate::hex_sha256(&launch_before_publish) != request.launch_sha256
        || launch_before_publish != launch_bytes
    {
        bail!("runtime service launch record changed before recovery publication");
    }
    if current_owner.state != RuntimeServiceState::Unknown {
        bail!("runtime recovery owner is no longer unknown before publication");
    }
    persist_descriptor(&owner_path, &failed)?;
    let published = read_stable_regular_path(
        &owner_path,
        MAX_RECOVERY_REQUEST_BYTES,
        "runtime service failed owner descriptor",
    )?;
    if crate::hex_sha256(&published) != after_owner_sha256 || published != failed_bytes {
        bail!("runtime service failed owner publication could not be verified");
    }
    receipt.status = "recovered".into();
    receipt.completed_at = Some(Utc::now());
    receipt.validate()?;
    let completed_bytes = serde_json::to_vec_pretty(&receipt)?;
    if completed_bytes.len() > MAX_RECOVERY_RECEIPT_BYTES {
        bail!("completed runtime recovery receipt exceeds its byte budget");
    }
    crate::durability::atomic_write_owner(&receipt_path, &completed_bytes)?;
    Ok(receipt)
}

#[cfg(test)]
mod recovery_contract_tests {
    use super::*;

    fn request() -> RuntimeServiceRecoveryRequest {
        RuntimeServiceRecoveryRequest {
            schema_version: RUNTIME_SERVICE_RECOVERY_REQUEST_SCHEMA.into(),
            request_id: "00000000-0000-4000-8000-000000000001".into(),
            config_sha256: "a".repeat(64),
            owner_sha256: "b".repeat(64),
            launch_sha256: "c".repeat(64),
            expected_owner: RuntimeServiceOwnerDescriptor {
                schema_version: RUNTIME_SERVICE_OWNER_SCHEMA.into(),
                owner_token: "00000000-0000-4000-8000-000000000002".into(),
                process_start_token: "00000000-0000-4000-8000-000000000003".into(),
                pid: 1,
                host: "host".into(),
                target_id: "target".into(),
                protocol: RUNTIME_SERVICE_OWNER_PROTOCOL.into(),
                state: RuntimeServiceState::Unknown,
                acquired_at: Utc::now(),
                heartbeat_at: Utc::now(),
                compute_pool_generation: None,
                preparation_pool_generation: None,
                control_address: None,
                build_commit: None,
                build_snapshot: None,
                compute_pool_id: None,
                preparation_pool_id: None,
                children: Vec::new(),
            },
        }
    }

    #[test]
    fn recovery_request_requires_canonical_lowercase_pins() {
        let mut request_with_bad_pin = request();
        assert!(request_with_bad_pin.validate().is_ok());
        request_with_bad_pin.config_sha256 = "A".repeat(64);
        assert!(request_with_bad_pin.validate().is_err());
        let mut uppercase_request = request();
        uppercase_request.request_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_uppercase();
        assert!(uppercase_request.validate().is_err());
    }

    #[test]
    fn recovery_rejects_nonempty_batch_namespace() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let batch_directory = store.root().join("batches").join("batch-001");
        std::fs::create_dir_all(&batch_directory).unwrap();
        std::fs::write(batch_directory.join("batch_intent.json"), b"{}\n").unwrap();

        assert!(require_empty_batch_namespace(&store).is_err());
    }

    #[test]
    fn recovery_log_allowlist_covers_all_runtime_service_producers() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let owner = request().expected_owner;
        let log_root = store
            .root()
            .join("runtime-services")
            .join(&owner.owner_token);
        std::fs::create_dir_all(&log_root).unwrap();
        for name in [
            "compute.stdout.jsonl",
            "compute.stderr.log",
            "preparation.stdout.jsonl",
            "preparation.stderr.log",
            "compute-publisher.stdout.jsonl",
            "compute-publisher.stderr.log",
            "preparation-publisher.stdout.jsonl",
            "preparation-publisher.stderr.log",
        ] {
            std::fs::write(log_root.join(name), b"evidence\n").unwrap();
        }
        let observed = observe_recovery_log_sources(&store, &owner).unwrap();
        assert_eq!(observed, recovery_log_sources(&owner));
        std::fs::write(log_root.join("publisher-other.log"), b"unexpected\n").unwrap();
        assert!(observe_recovery_log_sources(&store, &owner).is_err());
    }

    #[test]
    fn recovery_checkpoint_absence_requires_terminal_zero_summary() {
        let drained_without_checkpoint = br#"{"status":"drained","shutdown_requested":true,"pool_id":"compute","pool_checkpoint_sequence":0,"scheduled_count":0,"executed":[]}"#;
        assert_eq!(
            scheduler_checkpoint_sequence(drained_without_checkpoint, "compute", "compute")
                .unwrap(),
            0
        );
        let drained_after_work = br#"{"status":"drained","shutdown_requested":true,"pool_id":"compute","pool_checkpoint_sequence":1,"scheduled_count":1,"executed":[{}]}"#;
        assert_eq!(
            scheduler_checkpoint_sequence(drained_after_work, "compute", "compute").unwrap(),
            1
        );
        let idle = br#"{"status":"idle","shutdown_requested":false,"pool_id":"compute","pool_checkpoint_sequence":0,"scheduled_count":0,"executed":[]}"#;
        assert!(scheduler_checkpoint_sequence(idle, "compute", "compute").is_err());
    }

    #[test]
    fn recovery_archive_allows_only_the_pinned_owner_transition() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let request_sha256 = "d".repeat(64);
        let mut owner = request().expected_owner;
        owner.build_commit = Some("a".repeat(40));
        owner.build_snapshot = Some("b".repeat(64));
        owner.compute_pool_generation = Some(1);
        owner.preparation_pool_generation = Some(1);
        owner.compute_pool_id = Some("compute".into());
        owner.preparation_pool_id = Some("preparation".into());
        owner.children = vec![
            RuntimeServiceChild {
                role: "compute".into(),
                pid: 11,
                status: "exited_success".into(),
            },
            RuntimeServiceChild {
                role: "preparation".into(),
                pid: 12,
                status: "exited_success".into(),
            },
        ];
        validate_descriptor(&owner).unwrap();
        let owner_before = serde_json::to_vec_pretty(&owner).unwrap();
        let mut failed = owner.clone();
        failed.state = RuntimeServiceState::Failed;
        failed.heartbeat_at = Utc::now();
        let owner_after = serde_json::to_vec_pretty(&failed).unwrap();
        validate_descriptor(&failed).unwrap();
        let owner_relative = RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH;
        let owner_path = store.root().join(owner_relative);
        std::fs::create_dir_all(owner_path.parent().unwrap()).unwrap();
        std::fs::write(&owner_path, &owner_before).unwrap();

        let archive_root = store
            .root()
            .join("runtime-services")
            .join("recovery")
            .join(&request_sha256)
            .join("archive");
        std::fs::create_dir_all(&archive_root).unwrap();
        let mut archived_files = BTreeMap::new();
        archived_files.insert(owner_relative.to_owned(), crate::hex_sha256(&owner_before));
        std::fs::write(archive_root.join("OWNER.json"), &owner_before).unwrap();
        let mut evidence_sources = recovery_mandatory_sources(&owner).unwrap();
        let optional_sources = recovery_log_sources(&owner)
            .difference(&evidence_sources)
            .cloned()
            .collect::<Vec<_>>();
        evidence_sources.extend(optional_sources);
        for source in evidence_sources {
            if source == owner_relative || source == RECOVERY_ARCHIVED_CONFIGURATION_KEY {
                continue;
            }
            let source_path = store.root().join(&source);
            std::fs::create_dir_all(source_path.parent().unwrap()).unwrap();
            let bytes = if source == "runtime-services/00000000-0000-4000-8000-000000000002/compute.stdout.jsonl" {
                br#"{"status":"drained","shutdown_requested":true,"pool_id":"compute","pool_checkpoint_sequence":0,"scheduled_count":0,"executed":[]}"#.to_vec()
            } else if source == "runtime-services/00000000-0000-4000-8000-000000000002/preparation.stdout.jsonl" {
                br#"{"status":"drained","shutdown_requested":true,"pool_id":"preparation","pool_checkpoint_sequence":0,"scheduled_count":0,"executed":[]}"#.to_vec()
            } else {
                source.as_bytes().to_vec()
            };
            std::fs::write(&source_path, &bytes).unwrap();
            let archive_name = Path::new(&source).file_name().unwrap();
            std::fs::write(archive_root.join(archive_name), &bytes).unwrap();
            let source_digest = crate::hex_sha256(&bytes);
            archived_files.insert(source, source_digest);
        }
        let configuration_bytes = br#"{"schema_version":"runtime_service_config.v2"}"#;
        std::fs::write(
            archive_root.join(RECOVERY_ARCHIVED_CONFIGURATION_KEY),
            configuration_bytes,
        )
        .unwrap();
        archived_files.insert(
            RECOVERY_ARCHIVED_CONFIGURATION_KEY.into(),
            crate::hex_sha256(configuration_bytes),
        );
        let manifest_bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": "runtime_service_recovery_archive.v1",
            "request_sha256": request_sha256.clone(),
            "config_sha256": crate::hex_sha256(configuration_bytes),
            "application_binding": {
                "mode": "external_only",
                "raw_sha256": crate::hex_sha256(configuration_bytes),
            },
            "files": archived_files.clone(),
        }))
        .unwrap();
        let manifest_path = archive_root.join("manifest.json");
        std::fs::write(&manifest_path, &manifest_bytes).unwrap();
        let receipt = RuntimeServiceRecoveryReceipt {
            schema_version: RUNTIME_SERVICE_RECOVERY_SCHEMA.into(),
            request_id: "00000000-0000-4000-8000-000000000010".into(),
            request_sha256: "d".repeat(64),
            status: "recovered".into(),
            outcome: "failed".into(),
            target_id: "target".into(),
            config_sha256: crate::hex_sha256(configuration_bytes),
            owner_sha256_before: crate::hex_sha256(&owner_before),
            owner_state_after: "failed".into(),
            owner_sha256_after: crate::hex_sha256(&owner_after),
            archived_evidence_path: manifest_path.to_str().unwrap().into(),
            archived_evidence_sha256: crate::hex_sha256(&manifest_bytes),
            archived_files: archived_files.clone(),
            archived_absent_sources: BTreeMap::new(),
            historical_build_commit: "a".repeat(40),
            historical_build_snapshot: "b".repeat(64),
            executor_build_commit: "c".repeat(40),
            executor_build_snapshot: "f".repeat(64),
            created_at: Utc::now(),
            completed_at: Some(Utc::now()),
        };
        receipt.validate().unwrap();
        verify_archived_evidence(&store, &receipt).unwrap();

        let application_path =
            create_parent(store.root(), "runtime-services/APPLICATION.json").unwrap();
        std::fs::write(&application_path, b"foreign application").unwrap();
        assert!(verify_archived_evidence(&store, &receipt).is_err());
        std::fs::remove_file(&application_path).unwrap();

        let legacy_manifest_bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": "runtime_service_recovery_archive.v1",
            "request_sha256": request_sha256.clone(),
            "config_sha256": crate::hex_sha256(configuration_bytes),
            "files": archived_files.clone(),
        }))
        .unwrap();
        std::fs::write(&manifest_path, &legacy_manifest_bytes).unwrap();
        let mut legacy_receipt = receipt.clone();
        legacy_receipt.archived_evidence_sha256 = crate::hex_sha256(&legacy_manifest_bytes);
        assert!(verify_archived_evidence(&store, &legacy_receipt).is_err());
        std::fs::write(&manifest_path, &manifest_bytes).unwrap();

        std::fs::write(&owner_path, &owner_after).unwrap();
        verify_archived_evidence(&store, &receipt).unwrap();

        let mut missing = receipt.clone();
        missing
            .archived_files
            .remove(RECOVERY_ARCHIVED_CONFIGURATION_KEY);
        assert!(missing.validate().is_err());
        let mut extra = receipt.clone();
        extra.archived_files.insert("extra.json".into(), "1".repeat(64));
        assert!(extra.validate().is_err());

        std::fs::write(&owner_path, b"unrelated-owner").unwrap();
        assert!(verify_archived_evidence(&store, &receipt).is_err());
    }
}

#[cfg(test)]
mod application_configuration_tests {
    use super::*;
    use crate::host_resource_ledger::{HostResourceLedger, HostResourceLedgerPolicy};
    use crate::runtime_service_host::{
        RuntimeServiceHostExecution, RuntimeServiceHostPlacement,
        RUNTIME_SERVICE_HOST_EXECUTION_SCHEMA_V1,
    };
    use crate::{FmsResourceBudget, FmsResourceKind};
    use std::collections::BTreeSet;

    const GPU_A: &str = "GPU-00000000-0000-4000-8000-000000000001";

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
            host_execution: None,
        }
    }

    fn host_execution(config: &RuntimeServiceConfig) -> RuntimeServiceHostExecution {
        RuntimeServiceHostExecution {
            schema_version: RUNTIME_SERVICE_HOST_EXECUTION_SCHEMA_V1.into(),
            ledger_root: config.store_root.join("shared-host-ledger"),
            policy: HostResourceLedgerPolicy {
                schema_version: crate::host_resource_ledger::HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1
                    .into(),
                host_id: "host:test-local".into(),
                topology_sha256: "a".repeat(64),
                revision: 4,
                owner_epoch: 9,
                total_budget: FmsResourceBudget {
                    cpu_millis: 4000,
                    memory_bytes: 8192,
                    gpu_memory_bytes: 0,
                    storage_bytes: 8192,
                },
                gpu_vram_bytes_by_uuid: [(GPU_A.into(), 4096)].into_iter().collect(),
                allowed_cpu_ids: [0, 1, 2, 3].into_iter().collect(),
            },
            runtime_generation_sha256: None,
            compute_max_concurrency: 2,
            preparation_max_concurrency: 1,
            compute_placements: config
                .compute_resources
                .iter()
                .map(|offer| {
                    (
                        offer.resource_id.clone(),
                        RuntimeServiceHostPlacement {
                            cpu_ids: [0].into_iter().collect(),
                            gpu_uuid: None,
                        },
                    )
                })
                .collect(),
            preparation_cpu_ids: config
                .preparation_resources
                .iter()
                .map(|offer| (offer.resource_id.clone(), [1].into_iter().collect()))
                .collect(),
        }
    }

    fn v2_config(store: &SessionStore) -> RuntimeServiceConfig {
        let mut config = config(store);
        config.schema_version = RUNTIME_SERVICE_CONFIG_SCHEMA_V2.into();
        config.host_execution = Some(host_execution(&config));
        config
    }

    fn gpu_v2_config(store: &SessionStore) -> RuntimeServiceConfig {
        let mut config = config(store);
        config.compute_resources[0].kind = FmsResourceKind::Gpu;
        config.compute_resources[0].budget.gpu_memory_bytes = 2048;
        config.schema_version = RUNTIME_SERVICE_CONFIG_SCHEMA_V2.into();
        let mut host_execution = host_execution(&config);
        host_execution
            .compute_placements
            .get_mut("compute.cpu")
            .unwrap()
            .gpu_uuid = Some(GPU_A.into());
        config.host_execution = Some(host_execution);
        config
    }

    #[test]
    fn v1_serialization_remains_byte_identical_and_keeps_one_worker_caps() {
        #[derive(serde::Serialize)]
        struct LegacyRuntimeServiceConfig<'a> {
            schema_version: &'a str,
            store_root: &'a PathBuf,
            target_id: &'a str,
            compute_pool_id: &'a str,
            preparation_pool_id: &'a str,
            compute_resources: &'a Vec<FmsSchedulerResourceOffer>,
            preparation_resources: &'a Vec<FmsPreparationResourceOffer>,
            worker_timeout_seconds: u64,
            preparation_timeout_seconds: u64,
            heartbeat_interval_milliseconds: u64,
            startup_timeout_seconds: u64,
            drain_timeout_seconds: u64,
        }

        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let config = config(&store);
        let legacy = LegacyRuntimeServiceConfig {
            schema_version: &config.schema_version,
            store_root: &config.store_root,
            target_id: &config.target_id,
            compute_pool_id: &config.compute_pool_id,
            preparation_pool_id: &config.preparation_pool_id,
            compute_resources: &config.compute_resources,
            preparation_resources: &config.preparation_resources,
            worker_timeout_seconds: config.worker_timeout_seconds,
            preparation_timeout_seconds: config.preparation_timeout_seconds,
            heartbeat_interval_milliseconds: config.heartbeat_interval_milliseconds,
            startup_timeout_seconds: config.startup_timeout_seconds,
            drain_timeout_seconds: config.drain_timeout_seconds,
        };
        assert_eq!(
            serde_json::to_vec(&config).unwrap(),
            serde_json::to_vec(&legacy).unwrap()
        );
        assert!(config.validate().is_ok());
        assert_eq!(config.scheduler_concurrency("compute").unwrap(), 1);
        assert_eq!(config.scheduler_concurrency("preparation").unwrap(), 1);
        assert!(config.scheduler_concurrency("unknown").is_err());
    }

    #[test]
    fn v1_rejects_host_binding_and_unknown_config_schemas() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let mut legacy = config(&store);
        legacy.host_execution = Some(host_execution(&legacy));
        assert!(legacy.validate().is_err());

        legacy.schema_version = "runtime_service_config.v3".into();
        legacy.host_execution = None;
        assert!(legacy.validate().is_err());
    }

    #[test]
    fn v2_requires_explicit_host_binding_and_uses_pinned_concurrency_caps() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let mut missing = config(&store);
        missing.schema_version = RUNTIME_SERVICE_CONFIG_SCHEMA_V2.into();
        assert!(missing.validate().is_err());

        let config = v2_config(&store);
        assert!(config.validate().is_ok());
        assert_eq!(config.scheduler_concurrency("compute").unwrap(), 2);
        assert_eq!(config.scheduler_concurrency("preparation").unwrap(), 1);
        assert!(config.scheduler_concurrency("meshing").is_err());
    }

    #[test]
    fn v2_requires_exact_bounded_placements_and_valid_policy_fences() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let valid = v2_config(&store);
        assert!(valid.validate().is_ok());
        let encoded = serde_json::to_vec(&valid).unwrap();
        let decoded: RuntimeServiceConfig = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, valid);
        let mut changed_policy_revision = valid.clone();
        changed_policy_revision
            .host_execution
            .as_mut()
            .unwrap()
            .policy
            .revision += 1;
        assert_ne!(
            encoded,
            serde_json::to_vec(&changed_policy_revision).unwrap()
        );

        let mut missing_placement = valid.clone();
        missing_placement
            .host_execution
            .as_mut()
            .unwrap()
            .compute_placements
            .clear();
        assert!(missing_placement.validate().is_err());

        let mut extra_placement = valid.clone();
        extra_placement
            .host_execution
            .as_mut()
            .unwrap()
            .compute_placements
            .insert(
                "not-an-offer".into(),
                RuntimeServiceHostPlacement {
                    cpu_ids: BTreeSet::new(),
                    gpu_uuid: None,
                },
            );
        assert!(extra_placement.validate().is_err());

        let mut missing_preparation = valid.clone();
        missing_preparation
            .host_execution
            .as_mut()
            .unwrap()
            .preparation_cpu_ids
            .clear();
        assert!(missing_preparation.validate().is_err());

        let mut invalid_revision = valid.clone();
        invalid_revision
            .host_execution
            .as_mut()
            .unwrap()
            .policy
            .revision = 0;
        assert!(invalid_revision.validate().is_err());

        let mut invalid_owner_epoch = valid.clone();
        invalid_owner_epoch
            .host_execution
            .as_mut()
            .unwrap()
            .policy
            .owner_epoch = 0;
        assert!(invalid_owner_epoch.validate().is_err());

        let mut unknown_host_schema = valid.clone();
        unknown_host_schema
            .host_execution
            .as_mut()
            .unwrap()
            .schema_version = "runtime_service_host_execution.v2".into();
        assert!(unknown_host_schema.validate().is_err());

        let mut unknown_host_field = serde_json::to_value(&valid).unwrap();
        unknown_host_field["host_execution"]["unrecognized"] = true.into();
        assert!(serde_json::from_value::<RuntimeServiceConfig>(unknown_host_field).is_err());

        let mut over_limit = valid.clone();
        over_limit
            .host_execution
            .as_mut()
            .unwrap()
            .compute_max_concurrency = 33;
        assert!(over_limit.validate().is_err());
        let mut zero_concurrency = valid.clone();
        zero_concurrency
            .host_execution
            .as_mut()
            .unwrap()
            .preparation_max_concurrency = 0;
        assert!(zero_concurrency.validate().is_err());

        let mut oversized_map = valid.clone();
        let placements = &mut oversized_map
            .host_execution
            .as_mut()
            .unwrap()
            .compute_placements;
        placements.clear();
        for index in 0..=4096 {
            placements.insert(
                format!("extra-{index}"),
                RuntimeServiceHostPlacement {
                    cpu_ids: BTreeSet::new(),
                    gpu_uuid: None,
                },
            );
        }
        assert!(oversized_map.validate().is_err());

        let mut parent_traversal = valid;
        parent_traversal
            .host_execution
            .as_mut()
            .unwrap()
            .ledger_root = PathBuf::from("/tmp/../outside");
        assert!(parent_traversal.validate().is_err());
    }

    #[test]
    fn v2_cpu_gpu_and_preparation_placements_enforce_resource_kind_and_capacity() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let mut cpu_gpu_claim = v2_config(&store);
        cpu_gpu_claim
            .host_execution
            .as_mut()
            .unwrap()
            .compute_placements
            .get_mut("compute.cpu")
            .unwrap()
            .gpu_uuid = Some(GPU_A.into());
        assert!(cpu_gpu_claim.validate().is_err());

        let mut pinned_overclaim = v2_config(&store);
        pinned_overclaim.compute_resources[0].budget.cpu_millis = 1001;
        assert!(pinned_overclaim.validate().is_err());
        let mut unknown_cpu = v2_config(&store);
        unknown_cpu
            .host_execution
            .as_mut()
            .unwrap()
            .compute_placements
            .get_mut("compute.cpu")
            .unwrap()
            .cpu_ids = [9].into_iter().collect();
        assert!(unknown_cpu.validate().is_err());

        let mut gpu_without_uuid = gpu_v2_config(&store);
        gpu_without_uuid
            .host_execution
            .as_mut()
            .unwrap()
            .compute_placements
            .get_mut("compute.cpu")
            .unwrap()
            .gpu_uuid = None;
        assert!(gpu_without_uuid.validate().is_err());

        let mut unknown_gpu_uuid = gpu_v2_config(&store);
        unknown_gpu_uuid
            .host_execution
            .as_mut()
            .unwrap()
            .compute_placements
            .get_mut("compute.cpu")
            .unwrap()
            .gpu_uuid = Some("GPU-00000000-0000-4000-8000-000000000002".into());
        assert!(unknown_gpu_uuid.validate().is_err());

        let mut gpu_overclaim = gpu_v2_config(&store);
        gpu_overclaim.compute_resources[0].budget.gpu_memory_bytes = 4097;
        assert!(gpu_overclaim.validate().is_err());

        let mut pinned_preparation_overclaim = v2_config(&store);
        pinned_preparation_overclaim.preparation_resources[0]
            .budget
            .cpu_millis = 1001;
        assert!(pinned_preparation_overclaim.validate().is_err());

        let mut prep_gpu_claim = v2_config(&store);
        prep_gpu_claim.preparation_resources[0]
            .budget
            .gpu_memory_bytes = 1;
        assert!(prep_gpu_claim.validate().is_err());

        let mut aggregate_overclaim = v2_config(&store);
        aggregate_overclaim
            .host_execution
            .as_mut()
            .unwrap()
            .policy
            .total_budget
            .memory_bytes = 1000;
        assert!(aggregate_overclaim.validate().is_err());
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
        let saved_path = store.root().join("runtime-services/APPLICATION.json");
        let saved_bytes = std::fs::read(&saved_path).unwrap();
        let next = RuntimeServiceConfig::for_application(&store, "desktop", || {
            panic!("saved configuration must not resample volatile capacity")
        })
        .unwrap();
        assert_eq!(first, next);
        assert_eq!(std::fs::read(saved_path).unwrap(), saved_bytes);
        assert!(RuntimeServiceConfig::for_application(&store, "other", || {
            panic!("wrong target must not initialize another configuration")
        })
        .is_err());
    }

    #[test]
    fn host_application_initializes_a_missing_ledger_and_repeats_exactly() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let candidate = v2_config(&store);
        let ledger_root = candidate
            .host_execution
            .as_ref()
            .unwrap()
            .ledger_root
            .clone();
        assert!(!ledger_root.exists());

        let first = RuntimeServiceConfig::initialize_host_application(&store, &candidate).unwrap();
        let application_path = store.root().join("runtime-services/APPLICATION.json");
        let application_bytes = std::fs::read(&application_path).unwrap();
        let marker_path = ledger_root.join("HOST_RESOURCE_LEDGER.init.json");
        let document_path = ledger_root.join("HOST_RESOURCE_LEDGER.json");
        let marker_bytes = std::fs::read(&marker_path).unwrap();
        let document_bytes = std::fs::read(&document_path).unwrap();
        assert_eq!(first, candidate);
        assert!(HostResourceLedger::open(
            &ledger_root,
            candidate.host_execution.as_ref().unwrap().policy.clone(),
        )
        .is_ok());

        let repeated =
            RuntimeServiceConfig::initialize_host_application(&store, &candidate).unwrap();
        assert_eq!(repeated, candidate);
        assert_eq!(std::fs::read(application_path).unwrap(), application_bytes);
        assert_eq!(std::fs::read(marker_path).unwrap(), marker_bytes);
        assert_eq!(std::fs::read(document_path).unwrap(), document_bytes);
    }

    #[test]
    fn changed_host_candidate_is_rejected_before_ledger_creation_or_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let candidate = v2_config(&store);
        RuntimeServiceConfig::for_application(&store, &candidate.target_id, || {
            Ok(candidate.clone())
        })
        .unwrap();
        let ledger_root = candidate
            .host_execution
            .as_ref()
            .unwrap()
            .ledger_root
            .clone();
        let application_path = store.root().join("runtime-services/APPLICATION.json");
        let application_bytes = std::fs::read(&application_path).unwrap();

        let mut changed = candidate.clone();
        changed.host_execution.as_mut().unwrap().policy.revision += 1;
        assert!(RuntimeServiceConfig::initialize_host_application(&store, &changed).is_err());
        assert!(!ledger_root.exists());
        assert_eq!(std::fs::read(&application_path).unwrap(), application_bytes);

        RuntimeServiceConfig::initialize_host_application(&store, &candidate).unwrap();
        let marker_path = ledger_root.join("HOST_RESOURCE_LEDGER.init.json");
        let document_path = ledger_root.join("HOST_RESOURCE_LEDGER.json");
        let marker_bytes = std::fs::read(&marker_path).unwrap();
        let document_bytes = std::fs::read(&document_path).unwrap();
        assert!(RuntimeServiceConfig::initialize_host_application(&store, &changed).is_err());
        assert_eq!(std::fs::read(marker_path).unwrap(), marker_bytes);
        assert_eq!(std::fs::read(document_path).unwrap(), document_bytes);
    }

    #[test]
    fn host_application_rejects_v1_candidates_and_existing_v1_configurations() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let legacy = config(&store);
        assert!(RuntimeServiceConfig::initialize_host_application(&store, &legacy).is_err());
        assert!(!store
            .root()
            .join("runtime-services/APPLICATION.json")
            .exists());

        RuntimeServiceConfig::for_application(&store, &legacy.target_id, || Ok(legacy.clone()))
            .unwrap();
        let application_path = store.root().join("runtime-services/APPLICATION.json");
        let application_bytes = std::fs::read(&application_path).unwrap();
        let candidate = v2_config(&store);
        assert!(RuntimeServiceConfig::initialize_host_application(&store, &candidate).is_err());
        assert_eq!(std::fs::read(application_path).unwrap(), application_bytes);
        assert!(!candidate
            .host_execution
            .as_ref()
            .unwrap()
            .ledger_root
            .exists());
    }

    #[test]
    fn partial_host_ledger_stays_pinned_and_is_never_rebuilt() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let candidate = v2_config(&store);
        let ledger_root = candidate
            .host_execution
            .as_ref()
            .unwrap()
            .ledger_root
            .clone();
        std::fs::create_dir_all(&ledger_root).unwrap();
        let marker_path = ledger_root.join("HOST_RESOURCE_LEDGER.init.json");
        std::fs::write(&marker_path, b"existing partial marker").unwrap();

        assert!(RuntimeServiceConfig::initialize_host_application(&store, &candidate).is_err());
        let application_path = store.root().join("runtime-services/APPLICATION.json");
        assert_eq!(
            RuntimeServiceConfig::read(&application_path).unwrap(),
            candidate
        );
        assert_eq!(
            std::fs::read(&marker_path).unwrap(),
            b"existing partial marker"
        );
        assert!(!ledger_root.join("HOST_RESOURCE_LEDGER.json").exists());
        assert!(RuntimeServiceConfig::initialize_host_application(&store, &candidate).is_err());
        assert_eq!(
            std::fs::read(&marker_path).unwrap(),
            b"existing partial marker"
        );
        assert!(!ledger_root.join("HOST_RESOURCE_LEDGER.json").exists());
    }

    #[test]
    fn host_application_refuses_existing_owner_and_launch_records() {
        for record in [
            RUNTIME_SERVICE_OWNER_LOCK_PATH,
            RUNTIME_SERVICE_OWNER_DESCRIPTOR_PATH,
            "runtime-services/LAUNCH.json",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store = SessionStore::open(directory.path()).unwrap();
            let candidate = v2_config(&store);
            let record_path = create_parent(store.root(), record).unwrap();
            std::fs::write(&record_path, b"preserve owner evidence").unwrap();

            assert!(RuntimeServiceConfig::initialize_host_application(&store, &candidate).is_err());
            assert_eq!(
                std::fs::read(record_path).unwrap(),
                b"preserve owner evidence"
            );
            assert!(!store
                .root()
                .join("runtime-services/APPLICATION.json")
                .exists());
            assert!(!candidate
                .host_execution
                .as_ref()
                .unwrap()
                .ledger_root
                .exists());
        }
    }

    #[test]
    fn host_application_refuses_a_development_idle_fence() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let candidate = v2_config(&store);
        let fence = store
            .acquire_development_idle_fence("owner-init", "nonce-init")
            .unwrap();
        assert!(RuntimeServiceConfig::initialize_host_application(&store, &candidate).is_err());
        assert_eq!(store.read_development_idle_fence().unwrap(), Some(fence));
        assert!(!store
            .root()
            .join("runtime-services/APPLICATION.json")
            .exists());
        assert!(!candidate
            .host_execution
            .as_ref()
            .unwrap()
            .ledger_root
            .exists());
    }

    #[test]
    fn launch_record_created_after_application_pin_blocks_ledger_initialization() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let candidate = v2_config(&store);
        RuntimeServiceConfig::for_application(&store, &candidate.target_id, || {
            Ok(candidate.clone())
        })
        .unwrap();
        let launch_id = Uuid::new_v4().to_string();
        {
            let launch = RuntimeServiceLaunchGuard::try_acquire(store.root())
                .unwrap()
                .unwrap();
            launch.publish(&launch_id, "starting", None).unwrap();
        }

        assert!(RuntimeServiceConfig::acquire_host_application_ledger_guard(&store).is_err());
        assert!(!candidate
            .host_execution
            .as_ref()
            .unwrap()
            .ledger_root
            .exists());
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
    fn recovery_rejects_mismatched_or_corrupt_persisted_application() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let candidate = v2_config(&store);
        let application_path =
            create_parent(store.root(), "runtime-services/APPLICATION.json").unwrap();

        let mut mismatch = candidate.clone();
        mismatch
            .host_execution
            .as_mut()
            .unwrap()
            .policy
            .revision += 1;
        std::fs::write(&application_path, serde_json::to_vec(&mismatch).unwrap()).unwrap();
        assert!(validate_recovery_application_configuration(
            &store,
            &candidate,
            &"a".repeat(64),
        )
        .is_err());

        std::fs::write(&application_path, b"not-json").unwrap();
        assert!(validate_recovery_application_configuration(
            &store,
            &candidate,
            &"a".repeat(64),
        )
        .is_err());
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn recovery_rejects_persisted_application_symlink() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let candidate = v2_config(&store);
        let target = directory.path().join("foreign-application.json");
        std::fs::write(&target, serde_json::to_vec(&candidate).unwrap()).unwrap();
        let application_path =
            create_parent(store.root(), "runtime-services/APPLICATION.json").unwrap();

        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &application_path).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&target, &application_path).unwrap();

        assert!(validate_recovery_application_configuration(
            &store,
            &candidate,
            &"a".repeat(64),
        )
        .is_err());
    }

    #[test]
    fn recovery_application_binding_distinguishes_external_and_persisted_sources() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let candidate = v2_config(&store);
        let external_sha256 = "a".repeat(64);
        let external = validate_recovery_application_configuration(
            &store,
            &candidate,
            &external_sha256,
        )
        .unwrap();
        assert_eq!(
            external,
            RecoveryApplicationBinding::ExternalOnly {
                raw_sha256: external_sha256.clone()
            }
        );
        assert_eq!(
            application_binding_manifest_value(&external)["mode"],
            "external_only"
        );
        assert_eq!(
            application_binding_manifest_value(&external)["raw_sha256"],
            external_sha256
        );

        let application_path =
            create_parent(store.root(), "runtime-services/APPLICATION.json").unwrap();
        let application_bytes = serde_json::to_vec(&candidate).unwrap();
        std::fs::write(&application_path, &application_bytes).unwrap();
        let persisted =
            validate_recovery_application_configuration(&store, &candidate, &external_sha256)
                .unwrap();
        assert_eq!(
            persisted,
            RecoveryApplicationBinding::Persisted {
                raw_sha256: crate::hex_sha256(&application_bytes)
            }
        );
        assert_eq!(
            application_binding_manifest_value(&persisted)["mode"],
            "persisted"
        );
        assert_eq!(
            application_binding_manifest_value(&persisted)["raw_sha256"],
            crate::hex_sha256(&application_bytes)
        );
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
