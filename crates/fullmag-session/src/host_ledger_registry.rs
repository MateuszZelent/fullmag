//! Persistent binding from a physical host identity to its one shared ledger.
//!
//! Each local application stores this registry under its configured state
//! root. A different per-store ledger path for an already registered host is
//! rejected; recovery requires an operator to reconcile the existing ledger.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::durability::atomic_write;
use crate::host_resource_ledger::{
    canonical_ledger_root, HostResourceLedgerPolicy,
};
use crate::repository_path::{checked_path, read_bounded_regular_file, reject_link};
use crate::writer::{require_local_filesystem, Writer};

pub(crate) const HOST_LEDGER_ROOT_REGISTRY_DIRECTORY: &str = "host-ledger-roots";
pub(crate) const HOST_LEDGER_ROOT_REGISTRY_FILE: &str = "HOST_LEDGER_ROOTS.json";
const HOST_LEDGER_ROOT_REGISTRY_SCHEMA_V1: &str = "host_ledger_root_registry.v1";
const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
const MAX_HOSTS: usize = 4096;
const APPLICATION_STATE_ROOT_ENV: &str = "FULLMAG_STATE_ROOT";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostLedgerRootRegistry {
    schema_version: String,
    roots_by_host_id: BTreeMap<String, String>,
}

impl Default for HostLedgerRootRegistry {
    fn default() -> Self {
        Self {
            schema_version: HOST_LEDGER_ROOT_REGISTRY_SCHEMA_V1.into(),
            roots_by_host_id: BTreeMap::new(),
        }
    }
}

type RegistryWriterMap = Mutex<BTreeMap<PathBuf, Weak<Writer>>>;

static REGISTRY_WRITERS: OnceLock<RegistryWriterMap> = OnceLock::new();

/// Pin one canonical ledger path for a host in the shared application state.
/// The ledger directory itself is not created on a conflicting second path.
pub(crate) fn pin_host_ledger_root(
    application_state_root: &Path,
    ledger_root: &Path,
    policy: &HostResourceLedgerPolicy,
) -> Result<PathBuf> {
    policy.validate()?;
    let application_state_root = canonical_ledger_root(application_state_root, false)
        .context("validate shared application state for the host ledger registry")?;
    let registry_root_path = application_state_root.join(HOST_LEDGER_ROOT_REGISTRY_DIRECTORY);
    let registry_root = canonical_ledger_root(&registry_root_path, true)
        .context("prepare the shared host ledger root registry")?;
    let canonical_ledger_target = canonical_ledger_target(ledger_root)?;
    let canonical_ledger_text = canonical_ledger_target
        .to_str()
        .context("canonical host ledger root is not valid UTF-8")?
        .to_owned();

    let writer = registry_writer(&registry_root)?;
    let _lease = writer.acquire()?;
    let mut registry = read_registry(&registry_root)?;
    match registry.roots_by_host_id.get(&policy.host_id) {
        Some(existing) if existing == &canonical_ledger_text => {
            return Ok(canonical_ledger_target);
        }
        Some(_) => bail!(
            "host_id is already pinned to a different host ledger root; operator reconciliation is required"
        ),
        None => {}
    }
    if registry.roots_by_host_id.len() >= MAX_HOSTS {
        bail!("shared host ledger root registry reached its bounded host limit");
    }

    registry
        .roots_by_host_id
        .insert(policy.host_id.clone(), canonical_ledger_text);
    let bytes = serde_json::to_vec_pretty(&registry)?;
    if bytes.len() > MAX_REGISTRY_BYTES {
        bail!("shared host ledger root registry exceeds its byte budget");
    }
    let path = checked_path(&registry_root, HOST_LEDGER_ROOT_REGISTRY_FILE)?;
    atomic_write(&path, &bytes).context("publish shared host ledger root registry")?;
    Ok(canonical_ledger_target)
}

/// Verify a previously initialized binding without creating or migrating one.
pub(crate) fn require_pinned_host_ledger_root(
    application_state_root: &Path,
    ledger_root: &Path,
    policy: &HostResourceLedgerPolicy,
) -> Result<PathBuf> {
    policy.validate()?;
    let application_state_root = canonical_ledger_root(application_state_root, false)
        .context("validate shared application state for the host ledger registry")?;
    let registry_root_path = application_state_root.join(HOST_LEDGER_ROOT_REGISTRY_DIRECTORY);
    let registry_root = canonical_ledger_root(&registry_root_path, false)
        .context("host ledger root registry has not been initialized by the local operator")?;
    let canonical_ledger_target = canonical_ledger_target(ledger_root)?;
    let canonical_ledger_text = canonical_ledger_target
        .to_str()
        .context("canonical host ledger root is not valid UTF-8")?;

    let writer = registry_writer(&registry_root)?;
    let _lease = writer.acquire()?;
    let registry = read_registry(&registry_root)?;
    match registry.roots_by_host_id.get(&policy.host_id) {
        Some(existing) if existing == canonical_ledger_text => Ok(canonical_ledger_target),
        Some(_) => bail!(
            "host_id is pinned to a different host ledger root; operator reconciliation is required"
        ),
        None => bail!(
            "host_id has no shared host ledger root pin; explicit local operator initialization is required"
        ),
    }
}

/// Resolve the application state root passed from the local desktop launcher.
/// Host-bound operations fail closed when they are started outside that app.
pub(crate) fn application_state_root_from_environment() -> Result<PathBuf> {
    let value = std::env::var_os(APPLICATION_STATE_ROOT_ENV)
        .context("host ledger access requires the local application's FULLMAG_STATE_ROOT")?;
    let path = PathBuf::from(value);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        bail!("local application's state root must be absolute without parent traversal");
    }
    canonical_ledger_root(&path, false)
        .context("validate local application's state root for host ledger access")
}

fn canonical_ledger_target(root: &Path) -> Result<PathBuf> {
    if !root.is_absolute()
        || root
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || root.file_name().is_none()
    {
        bail!("host ledger root must be absolute, dedicated, and contain no parent traversal");
    }
    require_local_filesystem(root)?;
    reject_link(root)?;
    match fs::symlink_metadata(root) {
        Ok(_) => canonical_ledger_root(root, false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = root
                .parent()
                .context("host ledger root has no parent directory")?;
            reject_link(parent)?;
            if !fs::metadata(parent)?.is_dir() {
                bail!("host ledger root parent is not a directory");
            }
            Ok(fs::canonicalize(parent)?.join(
                root.file_name()
                    .context("host ledger root has no directory name")?,
            ))
        }
        Err(error) => Err(error).context("inspect configured host ledger root"),
    }
}

fn registry_writer(root: &Path) -> Result<Arc<Writer>> {
    let writers = REGISTRY_WRITERS.get_or_init(|| Mutex::new(BTreeMap::new()));
    let mut writers = writers
        .lock()
        .map_err(|_| anyhow::anyhow!("host ledger registry writer map is poisoned"))?;
    if let Some(writer) = writers.get(root).and_then(Weak::upgrade) {
        return Ok(writer);
    }
    let writer = Writer::new(root.to_path_buf());
    writers.insert(root.to_path_buf(), Arc::downgrade(&writer));
    Ok(writer)
}

fn read_registry(root: &Path) -> Result<HostLedgerRootRegistry> {
    let path = checked_path(root, HOST_LEDGER_ROOT_REGISTRY_FILE)?;
    match fs::symlink_metadata(&path) {
        Ok(_) => {
            let bytes = read_bounded_regular_file(
                root,
                HOST_LEDGER_ROOT_REGISTRY_FILE,
                MAX_REGISTRY_BYTES,
            )?;
            let registry: HostLedgerRootRegistry = serde_json::from_slice(&bytes)
                .context("decode shared host ledger root registry")?;
            if registry.schema_version != HOST_LEDGER_ROOT_REGISTRY_SCHEMA_V1
                || registry.roots_by_host_id.len() > MAX_HOSTS
            {
                bail!("shared host ledger root registry schema or entry count is invalid");
            }
            for (host_id, path) in &registry.roots_by_host_id {
                if host_id.is_empty()
                    || host_id.len() > 256
                    || host_id.chars().any(char::is_whitespace)
                {
                    bail!("shared host ledger root registry contains an invalid host identity");
                }
                let path = Path::new(path);
                if !path.is_absolute()
                    || path
                        .components()
                        .any(|component| matches!(component, Component::ParentDir))
                {
                    bail!("shared host ledger root registry contains an invalid path");
                }
            }
            Ok(registry)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(HostLedgerRootRegistry::default())
        }
        Err(error) => Err(error).context("inspect shared host ledger root registry"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_resource_ledger::{
        HostResourceLedger, HostResourceLedgerPolicy, HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1,
    };
    use crate::types::FmsResourceBudget;
    use std::collections::{BTreeMap, BTreeSet};

    fn policy(host_id: &str) -> HostResourceLedgerPolicy {
        HostResourceLedgerPolicy {
            schema_version: HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1.into(),
            host_id: host_id.into(),
            topology_sha256: "a".repeat(64),
            revision: 1,
            owner_epoch: 1,
            total_budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                storage_bytes: 0,
                gpu_memory_bytes: 0,
            },
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            allowed_cpu_ids: BTreeSet::new(),
        }
    }

    #[test]
    fn one_application_pins_one_ledger_root_per_physical_host() {
        let directory = tempfile::tempdir().unwrap();
        let state_root = directory.path().join("application-state");
        std::fs::create_dir(&state_root).unwrap();
        let first_root = directory.path().join("store-a/host-ledger");
        let second_root = directory.path().join("store-b/host-ledger");
        let conflicting_root = directory.path().join("store-c/host-ledger");
        std::fs::create_dir(first_root.parent().unwrap()).unwrap();
        std::fs::create_dir(second_root.parent().unwrap()).unwrap();
        std::fs::create_dir(conflicting_root.parent().unwrap()).unwrap();

        let host = policy("host:shared");
        assert!(HostResourceLedger::initialize_for_application(
            &state_root,
            &first_root,
            host.clone(),
        )
        .is_ok());
        assert!(HostResourceLedger::open_for_application(
            &state_root,
            &first_root,
            host.clone(),
        )
        .is_ok());
        assert!(HostResourceLedger::initialize_for_application(
            &state_root,
            &second_root,
            policy("host:other"),
        )
        .is_ok());

        let error = HostResourceLedger::initialize_for_application(
            &state_root,
            &conflicting_root,
            host,
        )
        .err()
        .expect("conflicting host-ledger initialization must fail");
        assert!(error.to_string().contains("operator reconciliation"));
        assert!(!conflicting_root.exists());

        let error = HostResourceLedger::open_for_application(
            &state_root,
            &conflicting_root,
            policy("host:shared"),
        )
        .err()
        .expect("conflicting host-ledger open must fail");
        assert!(error.to_string().contains("operator reconciliation"));
        assert!(!conflicting_root.exists());
    }

    #[test]
    fn opening_does_not_create_a_missing_host_ledger_root_pin() {
        let directory = tempfile::tempdir().unwrap();
        let state_root = directory.path().join("application-state");
        std::fs::create_dir(&state_root).unwrap();
        let ledger_root = directory.path().join("store/host-ledger");
        std::fs::create_dir(ledger_root.parent().unwrap()).unwrap();

        let error = HostResourceLedger::open_for_application(
            &state_root,
            &ledger_root,
            policy("host:shared"),
        )
        .err()
        .expect("opening without a host-ledger pin must fail");

        assert!(error.to_string().contains("not been initialized"));
        assert!(!state_root
            .join(HOST_LEDGER_ROOT_REGISTRY_DIRECTORY)
            .exists());
        assert!(!ledger_root.exists());
    }

    #[test]
    fn corrupt_host_ledger_root_registry_fails_closed_without_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let state_root = directory.path().join("application-state");
        std::fs::create_dir(&state_root).unwrap();
        let registry_root = state_root.join(HOST_LEDGER_ROOT_REGISTRY_DIRECTORY);
        std::fs::create_dir(&registry_root).unwrap();
        let registry_path = registry_root.join(HOST_LEDGER_ROOT_REGISTRY_FILE);
        std::fs::write(&registry_path, b"corrupt registry").unwrap();
        let before = std::fs::read(&registry_path).unwrap();
        let ledger_root = directory.path().join("store/host-ledger");
        std::fs::create_dir(ledger_root.parent().unwrap()).unwrap();

        assert!(pin_host_ledger_root(&state_root, &ledger_root, &policy("host:shared")).is_err());
        assert_eq!(std::fs::read(registry_path).unwrap(), before);
        assert!(!ledger_root.exists());
    }
}
