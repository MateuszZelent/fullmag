use super::*;
use crate::host_resource_ledger::{
    ClaimedWorkerInterruptionReceipt, ClaimedWorkerInterruptionRequest, publish_immutable_exact,
};
use sha2::{Digest, Sha256};

const LIMIT: usize = 1024 * 1024;

/// Paths are relative to the exact worker epoch directory. Every regular file,
/// including zero-byte staging files and partial CSV rows, is retained.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PreservedFile {
    bytes: u64,
    sha256: String,
}

fn inventory(
    directory: &Path,
    prefix: &str,
    files: &mut BTreeMap<String, PreservedFile>,
) -> Result<()> {
    reject_link(directory)?;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("private worker filename is not UTF-8"))?;
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let path = entry.path();
        reject_link(&path)?;
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_dir() {
            inventory(&path, &relative, files)?;
        } else if metadata.is_file() {
            let mut input = fs::File::open(&path)?;
            let mut digest = Sha256::new();
            let mut bytes = 0u64;
            let mut buffer = [0u8; 65536];
            loop {
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                digest.update(&buffer[..count]);
                bytes = bytes
                    .checked_add(count as u64)
                    .context("private file size exhausted")?;
            }
            if bytes != metadata.len() || input.metadata()?.len() != bytes {
                anyhow::bail!("private worker file changed during inventory");
            }
            files.insert(
                relative,
                PreservedFile {
                    bytes,
                    sha256: format!("{:x}", digest.finalize()),
                },
            );
            if files.len() > 100_000 {
                anyhow::bail!("private worker manifest exceeds file budget");
            }
        } else {
            anyhow::bail!("private worker manifest contains a special file");
        }
    }
    Ok(())
}

fn preserved_manifest(
    store: &SessionStore,
    request: &ClaimedWorkerInterruptionRequest,
) -> Result<serde_json::Value> {
    let id = &request.identity;
    let relative = format!(
        "runs/{}/worker-attempts/{}/{}/epoch-{}",
        id.run_id, id.task_id, id.attempt_id, id.ownership_epoch
    );
    let root = checked_path(store.root(), &relative)?;
    let mut files = BTreeMap::new();
    inventory(&root, "", &mut files)?;
    Ok(
        serde_json::json!({"schema_version": "claimed_worker_preserved_files.v1", "root_relative": relative, "files": files}),
    )
}

fn base(request: &ClaimedWorkerInterruptionRequest) -> String {
    format!(
        "runs/{}/claimed-worker-interruptions/{}",
        request.identity.run_id, request.request_id
    )
}

impl SessionStore {
    /// Caller holds the host->store writer section. Re-read protocol records
    /// here rather than trusting the API's earlier semantic preflight.
    pub(crate) fn validate_claimed_protocol_unlocked(
        &self,
        request: &ClaimedWorkerInterruptionRequest,
    ) -> Result<()> {
        let id = &request.identity;
        let entries = self.read_coordinator_journal_unlocked(&id.run_id)?;
        let mut commands = Vec::new();
        let mut events = Vec::new();
        for entry in entries.iter().filter(|entry| {
            entry.task_id == id.task_id
                && entry.attempt_id == id.attempt_id
                && entry.ownership_epoch == id.ownership_epoch
        }) {
            if entry.lease_token != id.lease_token {
                anyhow::bail!("interruption journal lease differs");
            }
            let message = &entry.payload["message"];
            let expected = match entry.direction {
                FmsCoordinatorJournalDirection::Command => "command",
                FmsCoordinatorJournalDirection::Event => "event",
            };
            if message["direction"] != expected || !message["envelope"].is_object() {
                anyhow::bail!("interruption journal envelope differs from direction");
            }
            match entry.direction {
                FmsCoordinatorJournalDirection::Command => {
                    commands.push(message["envelope"].clone())
                }
                FmsCoordinatorJournalDirection::Event => events.push(message["envelope"].clone()),
            }
        }
        if crate::canonical_json_sha256(&serde_json::json!({"commands":commands,"events":events}))
            != request.pins.journal_sha256
        {
            anyhow::bail!("claimed interruption journal changed after preflight");
        }
        let key = crate::canonical_json_sha256(&serde_json::json!([
            id.run_id,
            id.task_id,
            id.attempt_id,
            id.ownership_epoch
        ]));
        let relative = format!("runs/{}/worker_inbox/{key}.json", id.run_id);
        let raw = read_bounded_regular_file(self.root(), &relative, LIMIT)?;
        let record: crate::FmsWorkerInboxRecord = serde_json::from_slice(&raw)?;
        record.validate()?;
        if record.relative_path()? != relative
            || record.payload["claim"]["lease_token"] != id.lease_token
            || !record.payload["pending"].is_null()
            || crate::canonical_json_sha256(&record.payload) != request.pins.inbox_sha256
        {
            anyhow::bail!("claimed interruption inbox changed after preflight");
        }
        Ok(())
    }
    /// Caller holds the host writer and then the store writer. Publish the exact
    /// old catalog before quarantine, so every later crash can replay the same CAS.
    pub(crate) fn prepare_claimed_interruption_unlocked(
        &self,
        request: &ClaimedWorkerInterruptionRequest,
    ) -> Result<()> {
        let (bytes, manifest) = self.validate_claimed_interruption_prepare_unlocked(request)?;
        let before_path = format!("{}/catalog-before.json", base(request));
        let manifest_path = format!("{}/preserved-files.json", base(request));
        create_parent(self.root(), &manifest_path)?;
        publish_immutable_exact(self.root(), &manifest_path, &manifest, LIMIT)?;
        create_parent(self.root(), &before_path)?;
        publish_immutable_exact(self.root(), &before_path, &bytes, LIMIT)
    }

    pub(crate) fn validate_claimed_interruption_prepare_unlocked(
        &self,
        request: &ClaimedWorkerInterruptionRequest,
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        request.validate()?;
        self.validate_claimed_protocol_unlocked(request)?;
        let catalog = self
            .read_run_catalog(&request.identity.run_id)?
            .context("claimed interruption catalog missing")?;
        let bytes = read_bounded_regular_file(
            self.root(),
            &format!("runs/{}/run_catalog.json", request.identity.run_id),
            LIMIT,
        )?;
        if catalog.tasks.iter().any(|task| {
            task.task_id != request.identity.task_id
                && !matches!(
                    task.lifecycle,
                    FmsTaskLifecycle::Succeeded
                        | FmsTaskLifecycle::Failed
                        | FmsTaskLifecycle::Cancelled
                        | FmsTaskLifecycle::Interrupted
                )
        }) {
            anyhow::bail!("claimed interruption cannot leave another schedulable task in its run");
        }
        if format!("{:x}", Sha256::digest(&bytes)) != request.catalog_before_sha256
            || catalog.revision != request.catalog_revision
            || catalog
                .tasks
                .iter()
                .find(|task| task.task_id == request.identity.task_id)
                != Some(&request.expected_task)
        {
            anyhow::bail!("claimed interruption catalog CAS differs");
        }
        let started = format!(
            "runs/{}/worker-attempts/{}/{}/epoch-{}/{}",
            request.identity.run_id,
            request.identity.task_id,
            request.identity.attempt_id,
            request.identity.ownership_epoch,
            "worker_execution_started.v1.json"
        );
        let started_bytes = read_bounded_regular_file(self.root(), &started, LIMIT)?;
        if format!("{:x}", Sha256::digest(started_bytes)) != request.pins.execution_started_sha256 {
            anyhow::bail!("claimed interruption Started receipt differs");
        }
        self.reject_claimed_interruption_exit(request)?;
        let manifest = preserved_manifest(self, request)?;
        if crate::canonical_json_sha256(&manifest) != request.pins.preserved_files_manifest_sha256 {
            anyhow::bail!("claimed interruption private files differ from prepare pin");
        }
        Ok((bytes, serde_json::to_vec(&manifest)?))
    }

    pub(crate) fn reject_claimed_interruption_exit(
        &self,
        request: &ClaimedWorkerInterruptionRequest,
    ) -> Result<()> {
        if self
            .list_worker_process_exit_receipts(&request.identity.run_id)?
            .iter()
            .any(|exit| {
                exit.task_id == request.identity.task_id
                    && exit.attempt_id == request.identity.attempt_id
                    && exit.ownership_epoch == request.identity.ownership_epoch
            })
        {
            anyhow::bail!("claimed interruption cannot replace a real worker exit receipt");
        }
        Ok(())
    }

    /// Publish operational evidence before terminal catalog visibility. This
    /// never appends a coordinator event or publishes/renames worker artifacts.
    pub(crate) fn complete_claimed_interruption_unlocked(
        &self,
        receipt: &ClaimedWorkerInterruptionReceipt,
    ) -> Result<()> {
        let after = self.validate_claimed_interruption_complete_unlocked(receipt)?;
        let path = format!("{}/receipt.json", base(&receipt.request));
        create_parent(self.root(), &path)?;
        publish_immutable_exact(self.root(), &path, &serde_json::to_vec(receipt)?, LIMIT)?;
        self.commit_run_catalog_unlocked(&after)
    }

    pub(crate) fn validate_claimed_interruption_complete_unlocked(
        &self,
        receipt: &ClaimedWorkerInterruptionReceipt,
    ) -> Result<FmsRunCatalog> {
        receipt.validate()?;
        let request = &receipt.request;
        self.validate_claimed_protocol_unlocked(request)?;
        self.reject_claimed_interruption_exit(request)?;
        let manifest_bytes = read_bounded_regular_file(
            self.root(),
            &format!("{}/preserved-files.json", base(request)),
            LIMIT,
        )?;
        let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes)?;
        if crate::canonical_json_sha256(&manifest) != request.pins.preserved_files_manifest_sha256
            || preserved_manifest(self, request)? != manifest
        {
            anyhow::bail!("claimed interruption private files changed after prepare");
        }
        let before_bytes = read_bounded_regular_file(
            self.root(),
            &format!("{}/catalog-before.json", base(request)),
            LIMIT,
        )?;
        if format!("{:x}", Sha256::digest(&before_bytes)) != request.catalog_before_sha256 {
            anyhow::bail!("claimed interruption archived catalog differs");
        }
        let before: FmsRunCatalog = serde_json::from_slice(&before_bytes)?;
        before.validate()?;
        if before.revision != request.catalog_revision
            || before.run_id != request.identity.run_id
            || before
                .tasks
                .iter()
                .find(|task| task.task_id == request.identity.task_id)
                != Some(&request.expected_task)
        {
            anyhow::bail!("claimed interruption archived task differs");
        }
        let mut after = before.clone();
        let task = after
            .tasks
            .iter_mut()
            .find(|task| task.task_id == request.identity.task_id)
            .context("claimed interruption task missing")?;
        task.lifecycle = FmsTaskLifecycle::Interrupted;
        task.readiness = FmsTaskReadiness::Blocked {
            reason: crate::host_resource_ledger::CLAIMED_WORKER_INTERRUPTION_REASON.into(),
        };
        task.observation = Some(FmsObservationState::Disconnected);
        after.revision = after
            .revision
            .checked_add(1)
            .context("catalog revision exhausted")?;
        after.updated_at = chrono::DateTime::parse_from_rfc3339(
            &receipt.attestation.namespace.containers[0]
                .after
                .finished_at,
        )?
        .with_timezone(&chrono::Utc);
        after.validate()?;
        let current = self
            .read_run_catalog(&request.identity.run_id)?
            .context("catalog disappeared")?;
        if current != before && current != after {
            anyhow::bail!("claimed interruption catalog changed before terminal publication");
        }
        Ok(after)
    }

    pub fn read_claimed_worker_interruption(
        &self,
        run_id: &str,
        request_id: &str,
    ) -> Result<Option<ClaimedWorkerInterruptionReceipt>> {
        validate_store_id(run_id)?;
        let id = uuid::Uuid::parse_str(request_id)?;
        if id.is_nil() || id.hyphenated().to_string() != request_id {
            anyhow::bail!("interruption request UUID differs");
        }
        let relative =
            format!("runs/{run_id}/claimed-worker-interruptions/{request_id}/receipt.json");
        let Some(bytes) = read_optional_bounded_regular_file(
            self.root(),
            &relative,
            LIMIT,
            "claimed interruption",
        )?
        else {
            return Ok(None);
        };
        let receipt: ClaimedWorkerInterruptionReceipt = serde_json::from_slice(&bytes)?;
        receipt.validate()?;
        if receipt.request.identity.run_id != run_id || receipt.request.request_id != request_id {
            anyhow::bail!("claimed interruption receipt identity differs from path");
        }
        Ok(Some(receipt))
    }
}
