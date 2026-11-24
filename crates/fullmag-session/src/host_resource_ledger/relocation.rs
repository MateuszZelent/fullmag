//! Read-only, native-fenced evidence for relocating one unchanged ledger.
//!
//! Copy orchestration owns Docker/group identity. This module owns ledger
//! semantics and keeps native writer/inventory fences live across that copy.

use super::*;

pub const LEDGER_RELOCATION_INSPECTION_SCHEMA: &str =
    "fullmag.group-ledger-relocation-inspection.v1";
const MAX_MANIFEST_ENTRIES: usize = MAX_LEDGER_RECORDS * 16;
const MAX_MANIFEST_DEPTH: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LedgerRelocationFile {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

/// No mount path, clock, or process identity enters the portable evidence.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LedgerRelocationInspection {
    pub schema_version: String,
    pub host_id: String,
    pub ledger_schema_version: String,
    pub policy: HostResourceLedgerPolicy,
    pub policy_sha256: String,
    pub runtime_generation_sha256: Option<String>,
    pub semantic_snapshot_sha256: String,
    pub manifest_sha256: String,
    pub manifest: Vec<LedgerRelocationFile>,
    pub directories: Vec<String>,
    pub reservation_count: usize,
}

/// Every acquisition is read-only and nonblocking. Drop releases native locks
/// without publishing owner metadata or changing the historical descriptor.
pub struct LedgerRelocationFence {
    ledger: HostResourceLedger,
    _writer: crate::writer::ReadTransaction,
    _inventory: Option<File>,
}

impl LedgerRelocationFence {
    pub fn open(root: &Path, expected_host_id: &str) -> Result<Self> {
        let root = canonical_ledger_root(root, false)?;
        let writer = crate::writer::ReadTransaction::acquire(&root)?;
        crate::writer::validate_existing_writer_admission(&root)?;
        // Discovery is not authority: open_read_only revalidates this candidate
        // policy against the marker, proofs, policy history, and runtime CAS.
        let bytes = read_bounded_regular_file(&root, HOST_RESOURCE_LEDGER_FILE, MAX_LEDGER_BYTES)?;
        let candidate: HostResourceLedgerDocument = serde_json::from_slice(&bytes)?;
        if candidate.policy.host_id != expected_host_id {
            bail!("ledger relocation differs from the explicitly pinned logical host");
        }
        let ledger = HostResourceLedger::open_read_only(&root, candidate.policy)?;
        let (_, lock_exists) = ledger.read_inventory_owner_state_locked()?;
        let inventory = if lock_exists {
            Some(acquire_inventory_read_fence(&root)?)
        } else {
            // The writer fence also prevents creation of a new inventory owner.
            None
        };
        let fence = Self {
            ledger,
            _writer: writer,
            _inventory: inventory,
        };
        fence.inspect()?;
        Ok(fence)
    }

    /// Revalidation under the original live locks detects drift before release.
    pub fn inspect(&self) -> Result<LedgerRelocationInspection> {
        let document = self.ledger.read_document_locked()?;
        if document
            .reservations
            .iter()
            .any(|row| row.state != HostResourceReservationState::Released)
        {
            bail!("ledger relocation requires every native reservation to be Released");
        }
        // Historical reservation generations remain reachable payloads even
        // when their rows no longer reserve capacity. Do not accept dangling CAS.
        for row in &document.reservations {
            if let Some(generation) = &row.runtime_generation_sha256 {
                let bytes = read_runtime_cas_bytes(
                    &self.ledger.root,
                    HOST_RUNTIME_READINESS_CAS_DIR,
                    generation,
                    MAX_HOST_RUNTIME_READINESS_BYTES,
                    "historical reservation readiness",
                )?;
                let readiness: HostRuntimeReadiness = serde_json::from_slice(&bytes)?;
                readiness.validate_persisted(document.policy_for_reservation(row)?)?;
            }
        }
        // Includes ordering sidecars for current and archived snapshot pointers.
        self.ledger.read_compute_node_snapshot_locked()?;
        for entry in &document.policy_history {
            let archive = read_policy_history_document(&self.ledger.root, entry)?;
            if let Some(digest) = archive
                .runtime_state
                .and_then(|state| state.snapshot_sha256)
            {
                let bytes = read_runtime_cas_bytes(
                    &self.ledger.root,
                    HOST_COMPUTE_NODE_SNAPSHOT_CAS_DIR,
                    &digest,
                    MAX_COMPUTE_NODE_SNAPSHOT_BYTES,
                    "historical compute-node snapshot",
                )?;
                let snapshot: ComputeNodeSnapshot = serde_json::from_slice(&bytes)?;
                self.ledger.read_sample_order_locked(&snapshot, &digest)?;
            }
        }
        let snapshot = HostResourceLedgerSnapshot {
            policy_history_sha256: document.policy_history_sha256()?,
            policy: document.policy.clone(),
            reservations: document.reservations.clone(),
            node_policy: document.node_policy.clone(),
        };
        let mut manifest = Vec::new();
        let mut directories = Vec::new();
        collect_manifest(&self.ledger.root, "", 0, &mut manifest, &mut directories)?;
        manifest.sort_by(|left, right| left.path.cmp(&right.path));
        directories.sort();
        let manifest_sha256 = crate::canonical_json_sha256(&serde_json::json!({
            "directories": &directories, "files": &manifest,
        }));
        Ok(LedgerRelocationInspection {
            schema_version: LEDGER_RELOCATION_INSPECTION_SCHEMA.into(),
            host_id: document.policy.host_id.clone(),
            ledger_schema_version: document.schema_version,
            policy_sha256: policy_sha256(&document.policy)?,
            policy: document.policy,
            runtime_generation_sha256: document.runtime_state.map(|state| state.readiness_sha256),
            semantic_snapshot_sha256: snapshot.stable_sha256()?,
            manifest_sha256,
            manifest,
            directories,
            reservation_count: snapshot.reservations.len(),
        })
    }

    pub fn preview(
        &self,
        expected: &LedgerRelocationInspection,
    ) -> Result<LedgerRelocationInspection> {
        if expected.schema_version != LEDGER_RELOCATION_INSPECTION_SCHEMA {
            bail!("unsupported ledger relocation inspection schema");
        }
        let actual = self.inspect()?;
        if &actual != expected {
            bail!(
                "ledger relocation target differs from the exact source manifest, policy, or semantic snapshot"
            );
        }
        Ok(actual)
    }
}

fn acquire_inventory_read_fence(root: &Path) -> Result<File> {
    let path = checked_path(root, HOST_INVENTORY_OWNER_LOCK_FILE)?;
    reject_link(&path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let mut file = options.open(&path)?;
    if !file.metadata()?.is_file() {
        bail!("ledger relocation inventory lock must be a regular file");
    }
    file.try_lock_shared()
        .context("ledger relocation requires no active inventory owner")?;
    let mut descriptor = Vec::new();
    (&mut file)
        .take(HOST_INVENTORY_OWNER_LOCK_DESCRIPTOR.len() as u64 + 1)
        .read_to_end(&mut descriptor)?;
    if descriptor != HOST_INVENTORY_OWNER_LOCK_DESCRIPTOR {
        bail!("ledger relocation inventory lock descriptor is corrupt");
    }
    Ok(file)
}

fn collect_manifest(
    root: &Path,
    relative: &str,
    depth: usize,
    files: &mut Vec<LedgerRelocationFile>,
    directories: &mut Vec<String>,
) -> Result<()> {
    if depth > MAX_MANIFEST_DEPTH {
        bail!("ledger relocation tree exceeds its bounded depth");
    }
    let directory = if relative.is_empty() {
        root.to_path_buf()
    } else {
        checked_path(root, relative)?
    };
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("ledger relocation path must be UTF-8"))?;
        if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\']) {
            bail!("ledger relocation path is not portable");
        }
        let path = if relative.is_empty() {
            name
        } else {
            format!("{relative}/{name}")
        };
        let absolute = checked_path(root, &path)?;
        reject_link(&absolute)?;
        let metadata = fs::symlink_metadata(&absolute)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.dev() != fs::metadata(root)?.dev()
                || (metadata.is_file() && metadata.nlink() != 1)
            {
                bail!("ledger relocation forbids mount crossings and hardlinked files");
            }
        }
        if files.len() + directories.len() >= MAX_MANIFEST_ENTRIES {
            bail!("ledger relocation tree exceeds its bounded entry count");
        }
        if metadata.is_dir() {
            directories.push(path.clone());
            collect_manifest(root, &path, depth + 1, files, directories)?;
        } else if metadata.is_file() {
            let bytes = read_bounded_regular_file(root, &path, MAX_LEDGER_BYTES)?;
            if bytes.len() as u64 != metadata.len() {
                bail!("ledger relocation file changed during manifest read");
            }
            files.push(LedgerRelocationFile {
                path,
                size_bytes: bytes.len() as u64,
                sha256: runtime_cas_digest(&bytes),
            });
        } else {
            bail!("ledger relocation permits only regular files and directories");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, HostResourceLedger) {
        let directory = tempfile::tempdir().unwrap();
        let policy = HostResourceLedgerPolicy {
            schema_version: HOST_RESOURCE_LEDGER_POLICY_SCHEMA_V1.into(),
            host_id: "host:relocation-regression".into(),
            topology_sha256: "a".repeat(64),
            revision: 1,
            owner_epoch: 1,
            total_budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 4096,
                gpu_memory_bytes: 0,
                storage_bytes: 4096,
            },
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            allowed_cpu_ids: BTreeSet::new(),
        };
        let ledger =
            HostResourceLedger::initialize(directory.path().join("ledger"), policy).unwrap();
        (directory, ledger)
    }

    #[test]
    fn inspection_is_byte_preserving_and_never_initializes_a_missing_root() {
        let (directory, ledger) = fixture();
        let missing = directory.path().join("missing");
        assert!(LedgerRelocationFence::open(&missing, &ledger.policy.host_id).is_err());
        assert!(!missing.exists());
        let fence = LedgerRelocationFence::open(&ledger.root, &ledger.policy.host_id).unwrap();
        let before = fence.inspect().unwrap();
        assert_eq!(before, fence.inspect().unwrap());
        assert!(
            before
                .manifest
                .iter()
                .any(|entry| entry.path == "WRITER.owner.json")
        );
        drop(fence);
        let after = LedgerRelocationFence::open(&ledger.root, &ledger.policy.host_id).unwrap();
        assert_eq!(before, after.inspect().unwrap());
        assert!(LedgerRelocationFence::open(&ledger.root, "host:foreign").is_err());
    }

    #[test]
    fn writer_and_inventory_locks_are_both_nonblocking_fences() {
        let (_directory, ledger) = fixture();
        let writer = ledger.writer.acquire().unwrap();
        assert!(LedgerRelocationFence::open(&ledger.root, &ledger.policy.host_id).is_err());
        drop(writer);
        let owner = ledger.try_acquire_inventory_owner().unwrap().unwrap();
        assert!(LedgerRelocationFence::open(&ledger.root, &ledger.policy.host_id).is_err());
        drop(owner);
        let fence = LedgerRelocationFence::open(&ledger.root, &ledger.policy.host_id).unwrap();
        assert!(ledger.writer.acquire().is_err());
        assert!(matches!(
            open_inventory_owner_lock(&ledger.root, false).unwrap(),
            InventoryOwnerLockAttempt::Busy
        ));
        drop(fence);
        assert!(ledger.try_acquire_inventory_owner().unwrap().is_some());
    }

    #[test]
    fn complete_manifest_detects_extra_files_empty_directories_and_same_size_drift() {
        let (_directory, ledger) = fixture();
        fs::create_dir(ledger.root.join("history")).unwrap();
        fs::write(ledger.root.join("extra.json"), b"old").unwrap();
        let fence = LedgerRelocationFence::open(&ledger.root, &ledger.policy.host_id).unwrap();
        let expected = fence.inspect().unwrap();
        assert_eq!(expected.directories, vec!["history"]);
        fs::write(ledger.root.join("extra.json"), b"new").unwrap();
        assert!(fence.preview(&expected).is_err());
        fs::write(ledger.root.join("extra.json"), b"old").unwrap();
        assert!(fence.preview(&expected).is_ok());
        fs::create_dir(ledger.root.join("unexpected")).unwrap();
        assert!(fence.preview(&expected).is_err());
    }

    #[test]
    fn corrupted_marker_is_rejected_without_repair() {
        let (_directory, ledger) = fixture();
        let marker = ledger.root.join(HOST_RESOURCE_LEDGER_MARKER_FILE);
        let corrupt = br#"{"schema_version":"host_resource_ledger.v1","policy_sha256":"bad"}"#;
        fs::write(&marker, corrupt).unwrap();
        assert!(LedgerRelocationFence::open(&ledger.root, &ledger.policy.host_id).is_err());
        assert_eq!(fs::read(marker).unwrap(), corrupt);
    }

    #[test]
    fn native_tentative_reservation_blocks_relocation() {
        let (_directory, ledger) = fixture();
        let node_policy_revision = ledger
            .read_observation_snapshot()
            .unwrap()
            .node_policy_status()
            .unwrap()
            .unwrap()
            .revision;
        let request = HostReservationRequest {
            identity: HostReservationIdentity {
                store_id: format!("sha256:{}", "b".repeat(64)),
                run_id: "run-1".into(),
                task_id: "task-1".into(),
                resource_id: "cpu".into(),
                owner: HostReservationOwner::Preparation {
                    preparation_attempt_id: "prepare-1".into(),
                },
                lease_token: "token-1".into(),
            },
            expected_host_id: ledger.policy.host_id.clone(),
            expected_policy_revision: ledger.policy.revision,
            expected_owner_epoch: ledger.policy.owner_epoch,
            runtime_generation_sha256: None,
            expected_compute_node_owner_id: None,
            expected_compute_node_owner_epoch: None,
            expected_topology_sha256: ledger.policy.topology_sha256.clone(),
            budget: FmsResourceBudget {
                cpu_millis: 1,
                memory_bytes: 1,
                gpu_memory_bytes: 0,
                storage_bytes: 0,
            },
            exclusive_gpu_uuids: BTreeSet::new(),
            gpu_vram_bytes_by_uuid: BTreeMap::new(),
            cpu_ids: BTreeSet::new(),
            expected_node_policy_revision: node_policy_revision,
            scheduling_priority: 0,
            parallelism: ComputeParallelismIR::default(),
        };
        ledger.reserve(&request).unwrap();
        assert!(LedgerRelocationFence::open(&ledger.root, &ledger.policy.host_id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn linked_evidence_is_rejected() {
        let (_directory, ledger) = fixture();
        fs::hard_link(
            ledger.root.join(HOST_RESOURCE_LEDGER_FILE),
            ledger.root.join("alias"),
        )
        .unwrap();
        assert!(LedgerRelocationFence::open(&ledger.root, &ledger.policy.host_id).is_err());
        fs::remove_file(ledger.root.join("alias")).unwrap();
        std::os::unix::fs::symlink(
            ledger.root.join(HOST_RESOURCE_LEDGER_FILE),
            ledger.root.join("alias"),
        )
        .unwrap();
        assert!(LedgerRelocationFence::open(&ledger.root, &ledger.policy.host_id).is_err());
    }
}
