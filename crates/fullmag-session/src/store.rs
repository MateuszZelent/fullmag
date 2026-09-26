//! Internal `SessionStore` — directory-based persistence layer.
//!
//! Layout under `.fullmag/local-live/session-store/`:
//! ```text
//! session-store/
//! ├── CURRENT          // path to the latest session manifest (atomic pointer)
//! ├── WRITER.lock      // stable native lock descriptor
//! ├── WRITER.owner.json // atomic owner metadata
//! ├── manifests/       // session manifest JSON files
//! ├── runs/            // per-run intent/catalog/admissions/leases/manifests
//! ├── objects/         // CAS blob store
//! │   └── sha256/
//! ├── temp/            // in-flight writes
//! └── recovery/        // crash recovery snapshots
//! ```

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};

use crate::cas::CasStore;
use crate::durability::{atomic_write, confirm_publication, sync_directory};
use crate::repository_path::{checked_path, create_parent, reject_link, validate_store_id};
use crate::types::*;
use crate::writer::{WriteTransaction, Writer};

/// The internal session store backed by a directory tree and a CAS.
pub struct SessionStore {
    root: PathBuf,
    cas: CasStore,
    writer: Arc<Writer>,
    explicit_lease: Mutex<Option<WriteTransaction>>,
}

impl SessionStore {
    /// Open or initialize a `SessionStore` at the given root directory.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        reject_link(&root)?;
        crate::writer::require_local_filesystem(&root)?;
        fs::create_dir_all(&root)?;
        let root = fs::canonicalize(root)?;
        let writer = Writer::new(root.clone());
        let mut initialized = true;
        for sub in [
            "manifests",
            "runs",
            "recovery",
            "temp",
            "objects/sha256",
            "objects/pins",
        ] {
            initialized &= checked_path(&root, sub)?.is_dir();
        }
        if !initialized {
            let _lease = writer.acquire()?;
            for sub in ["manifests", "runs", "recovery", "temp", "objects"] {
                fs::create_dir_all(checked_path(&root, sub)?)?;
            }
            let _ = CasStore::with_writer(checked_path(&root, "objects")?, writer.clone())?;
            sync_directory(&root)?;
        }
        let cas = CasStore::existing(checked_path(&root, "objects")?, writer.clone())?;
        Ok(Self {
            root,
            cas,
            writer,
            explicit_lease: Mutex::new(None),
        })
    }

    /// Open without creating repository directories or files. Mutations still
    /// require the same writer lease; useful for inspection and GC previews.
    pub fn open_existing(root: impl Into<PathBuf>) -> Result<Self> {
        let root = root.into();
        reject_link(&root)?;
        let root = fs::canonicalize(root)?;
        let writer = Writer::new(root.clone());
        let cas = CasStore::existing(checked_path(&root, "objects")?, writer.clone())?;
        Ok(Self {
            root,
            cas,
            writer,
            explicit_lease: Mutex::new(None),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn cas(&self) -> &CasStore {
        &self.cas
    }

    /// Bind a multi-file operation to one native writer lease.
    pub fn write_transaction(&self) -> Result<WriteTransaction> {
        self.writer.acquire()
    }

    // ── Sessions ───────────────────────────────────────────────────────

    /// Persist a session manifest and update the `CURRENT` pointer.
    pub fn commit_session(&self, manifest: &FmsSessionManifest) -> Result<()> {
        validate_store_id(&manifest.session_id)?;
        if manifest.format != "fullmag.session.v1" {
            anyhow::bail!("unsupported session schema");
        }
        let _lease = self.write_transaction()?;
        validate_session_references(&self.root, manifest)?;
        let json = serde_json::to_vec_pretty(manifest)?;
        // Immutable generation: a crash cannot update a manifest behind the
        // old CURRENT pointer before the new generation is committed.
        let generation = format!("generation-{}", uuid::Uuid::new_v4());
        let path = create_parent(&self.root, &format!("manifests/{generation}.json"))?;
        atomic_write(&path, &json)?;
        // Atomically update CURRENT to point to this session.
        let current_path = checked_path(&self.root, "CURRENT")?;
        atomic_write(&current_path, generation.as_bytes())?;
        Ok(())
    }

    /// Read the currently active session manifest, if any.
    pub fn current_session(&self) -> Result<Option<FmsSessionManifest>> {
        let current_path = checked_path(&self.root, "CURRENT")?;
        if !current_path.exists() {
            return Ok(None);
        }
        let session_id = fs::read_to_string(&current_path)?.trim().to_string();
        validate_store_id(&session_id)?;
        let manifest_path = checked_path(&self.root, &format!("manifests/{session_id}.json"))?;
        if !manifest_path.exists() {
            anyhow::bail!("CURRENT points to a missing manifest");
        }
        let data = fs::read(&manifest_path)?;
        let manifest: FmsSessionManifest = serde_json::from_slice(&data)
            .with_context(|| format!("parsing session manifest {}", manifest_path.display()))?;
        validate_store_id(&manifest.session_id)?;
        if manifest.format != "fullmag.session.v1"
            || (!session_id.starts_with("generation-") && session_id != manifest.session_id)
        {
            anyhow::bail!("CURRENT manifest identity or schema mismatch");
        }
        Ok(Some(manifest))
    }

    // ── Runs ───────────────────────────────────────────────────────────

    /// Publish an accepted Submit intent before acknowledging the request.
    ///
    /// The record is a single atomic JSON publication boundary.  Repeating
    /// the same idempotency key and payload returns `Replayed`; reusing the
    /// key for another payload fails closed.  The application/coordinator
    /// remains responsible for creating the run manifest and scheduling work.
    pub fn commit_run_intent(&self, intent: &FmsRunIntent) -> Result<RunIntentCommitDisposition> {
        intent.validate()?;
        let _lease = self.write_transaction()?;
        if let Some(object_ref) = intent.definition_object_ref.as_deref() {
            self.cas
                .get(object_ref)?
                .with_context(|| format!("run definition object `{object_ref}` is missing"))?;
        }
        if let Some(object_ref) = intent.study_object_ref.as_deref() {
            self.cas
                .get(object_ref)?
                .with_context(|| format!("run study object `{object_ref}` is missing"))?;
        }
        if let Some(object_ref) = intent.study_catalog_object_ref.as_deref() {
            self.cas
                .get(object_ref)?
                .with_context(|| format!("run study catalog object `{object_ref}` is missing"))?;
        }
        for object_ref in intent.asset_object_refs.values() {
            self.cas
                .get(object_ref)?
                .with_context(|| format!("run asset object `{object_ref}` is missing"))?;
        }
        if let Some(existing) = self.find_run_intent_unlocked(&intent.idempotency_key)? {
            if existing.payload_sha256 == intent.payload_sha256
                && existing.specification == intent.specification
                && existing.definition_object_ref == intent.definition_object_ref
                && existing.study_object_ref == intent.study_object_ref
                && existing.study_catalog_object_ref == intent.study_catalog_object_ref
                && existing.asset_object_refs == intent.asset_object_refs
            {
                return Ok(RunIntentCommitDisposition::Replayed {
                    run_id: existing.run_id,
                });
            }
            anyhow::bail!(
                "idempotency key `{}` was already accepted for another payload",
                intent.idempotency_key
            );
        }

        let path = create_parent(
            &self.root,
            &format!("runs/{}/run_intent.json", intent.run_id),
        )?;
        if path.exists() {
            anyhow::bail!("run intent path already exists for run `{}`", intent.run_id);
        }
        let json = serde_json::to_vec_pretty(intent)?;
        atomic_write(&path, &json)?;
        Ok(RunIntentCommitDisposition::Accepted)
    }

    /// Read the durable accepted intent for one run, if present.
    pub fn read_run_intent(&self, run_id: &str) -> Result<Option<FmsRunIntent>> {
        validate_store_id(run_id)?;
        let path = checked_path(&self.root, &format!("runs/{run_id}/run_intent.json"))?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let intent: FmsRunIntent = serde_json::from_slice(&data)?;
        intent.validate()?;
        if intent.run_id != run_id {
            anyhow::bail!("run intent identity does not match its path");
        }
        Ok(Some(intent))
    }

    /// Find an accepted intent by idempotency key after a process restart.
    pub fn find_run_intent(&self, idempotency_key: &str) -> Result<Option<FmsRunIntent>> {
        validate_store_id(idempotency_key)?;
        self.find_run_intent_unlocked(idempotency_key)
    }

    /// Enumerate accepted intents from the durable store without reading a
    /// mutable current-session pointer. Malformed or linked entries fail closed.
    pub fn list_run_intents(&self) -> Result<Vec<FmsRunIntent>> {
        let runs = checked_path(&self.root, "runs")?;
        if !runs.exists() {
            return Ok(Vec::new());
        }
        let mut intents = Vec::new();
        for entry in fs::read_dir(&runs)? {
            let entry = entry?;
            reject_link(&entry.path())?;
            if !entry.file_type()?.is_dir() {
                anyhow::bail!("unsupported runs entry `{}`", entry.path().display());
            }
            let run_id = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 run identifier"))?;
            validate_store_id(&run_id)?;
            let path = checked_path(&self.root, &format!("runs/{run_id}/run_intent.json"))?;
            if !path.exists() {
                continue;
            }
            let data = fs::read(&path)?;
            let intent: FmsRunIntent = serde_json::from_slice(&data)
                .with_context(|| format!("parsing run intent {}", path.display()))?;
            intent.validate()?;
            if intent.run_id != run_id {
                anyhow::bail!("run intent identity does not match its path");
            }
            intents.push(intent);
        }
        intents.sort_by(|left, right| {
            right
                .accepted_at
                .cmp(&left.accepted_at)
                .then_with(|| right.run_id.cmp(&left.run_id))
        });
        Ok(intents)
    }

    fn find_run_intent_unlocked(&self, idempotency_key: &str) -> Result<Option<FmsRunIntent>> {
        let mut found = None;
        for intent in self.list_run_intents()? {
            if intent.idempotency_key == idempotency_key {
                if found.is_some() {
                    anyhow::bail!("duplicate durable idempotency key `{idempotency_key}`");
                }
                found = Some(intent);
            }
        }
        Ok(found)
    }

    /// Publish a monotonic task catalog snapshot for one run.
    ///
    /// Equal revisions are idempotent only when the complete payload is equal;
    /// an older or conflicting writer is rejected before it can replace the
    /// accepted catalog.
    pub fn commit_run_catalog(&self, catalog: &FmsRunCatalog) -> Result<()> {
        catalog.validate()?;
        let _lease = self.write_transaction()?;
        self.commit_run_catalog_unlocked(catalog)
    }

    fn commit_run_catalog_unlocked(&self, catalog: &FmsRunCatalog) -> Result<()> {
        self.commit_run_catalog_unlocked_with_genesis(catalog, false)
    }

    fn commit_run_catalog_unlocked_with_genesis(
        &self,
        catalog: &FmsRunCatalog,
        allow_genesis_publication: bool,
    ) -> Result<()> {
        let path = checked_path(
            &self.root,
            &format!("runs/{}/run_catalog.json", catalog.run_id),
        )?;
        if path.exists() {
            let data = fs::read(&path)?;
            let existing: FmsRunCatalog = serde_json::from_slice(&data)
                .with_context(|| format!("parsing run catalog {}", path.display()))?;
            existing.validate()?;
            if existing.run_id != catalog.run_id {
                anyhow::bail!("run catalog identity does not match its path");
            }
            Self::validate_coordinator_watermark_progress(&existing, catalog)?;
            if !allow_genesis_publication {
                for task in &catalog.tasks {
                    if task.coordinator_genesis.is_some()
                        && existing
                            .tasks
                            .iter()
                            .find(|prior| prior.task_id == task.task_id)
                            .and_then(|prior| prior.coordinator_genesis.as_ref())
                            != task.coordinator_genesis.as_ref()
                    {
                        anyhow::bail!(
                            "coordinator genesis must be published through the fenced store boundary"
                        );
                    }
                }
            }
            if existing.revision > catalog.revision {
                anyhow::bail!(
                    "stale run catalog revision {}; current revision is {}",
                    catalog.revision,
                    existing.revision
                );
            }
            if existing.revision == catalog.revision {
                if existing == *catalog {
                    return Ok(());
                }
                anyhow::bail!(
                    "run catalog revision {} conflicts with the durable payload",
                    catalog.revision
                );
            }
        } else if !allow_genesis_publication
            && catalog
                .tasks
                .iter()
                .any(|task| task.coordinator_genesis.is_some())
        {
            anyhow::bail!(
                "coordinator genesis must be published through the fenced store boundary"
            );
        }
        let path = create_parent(
            &self.root,
            &format!("runs/{}/run_catalog.json", catalog.run_id),
        )?;
        let json = serde_json::to_vec_pretty(catalog)?;
        atomic_write(&path, &json)?;
        Ok(())
    }

    fn validate_coordinator_watermark_progress(
        existing: &FmsRunCatalog,
        next: &FmsRunCatalog,
    ) -> Result<()> {
        for prior in &existing.tasks {
            let Some(current) = next.tasks.iter().find(|task| task.task_id == prior.task_id) else {
                if prior.coordinator_watermark.is_some() || prior.coordinator_genesis.is_some() {
                    anyhow::bail!(
                        "cannot remove task `{}` while its coordinator watermark is retained",
                        prior.task_id
                    );
                }
                continue;
            };
            if prior.ownership_epoch == current.ownership_epoch
                && prior.coordinator_genesis.is_some()
                && current.coordinator_genesis != prior.coordinator_genesis
            {
                anyhow::bail!(
                    "task `{}` coordinator genesis is immutable within an ownership epoch",
                    prior.task_id
                );
            }
            let Some(prior_watermark) = prior.coordinator_watermark else {
                continue;
            };

            if prior.ownership_epoch == current.ownership_epoch {
                let clears_attempt = prior.attempt_id.is_some() && current.attempt_id.is_none();
                if prior.attempt_id != current.attempt_id && !clears_attempt {
                    anyhow::bail!(
                        "cannot replace task `{}` attempt without advancing its ownership epoch",
                        prior.task_id
                    );
                }
                let current_watermark = current.coordinator_watermark.context(format!(
                    "cannot remove task `{}` coordinator watermark within the same ownership epoch",
                    prior.task_id
                ))?;
                if current_watermark.command_sequence < prior_watermark.command_sequence
                    || current_watermark.event_sequence < prior_watermark.event_sequence
                {
                    anyhow::bail!(
                        "task `{}` coordinator watermark cannot move backwards",
                        prior.task_id
                    );
                }
            } else {
                let prior_epoch = prior
                    .ownership_epoch
                    .context("coordinator watermark has no prior ownership epoch")?;
                let current_epoch = current.ownership_epoch.context(format!(
                    "cannot clear task `{}` ownership epoch while its coordinator watermark is retained",
                    prior.task_id
                ))?;
                if current_epoch <= prior_epoch {
                    anyhow::bail!(
                        "task `{}` coordinator watermark can reset only after ownership epoch advances",
                        prior.task_id
                    );
                }
            }
        }
        Ok(())
    }

    /// Read the durable task catalog for one run, if present.
    pub fn read_run_catalog(&self, run_id: &str) -> Result<Option<FmsRunCatalog>> {
        validate_store_id(run_id)?;
        let path = checked_path(&self.root, &format!("runs/{run_id}/run_catalog.json"))?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let catalog: FmsRunCatalog = serde_json::from_slice(&data)?;
        catalog.validate()?;
        if catalog.run_id != run_id {
            anyhow::bail!("run catalog identity does not match its path");
        }
        Ok(Some(catalog))
    }

    /// Publish the immutable preparation receipt that belongs to one run.
    ///
    /// A receipt cannot be published before the durable run catalog exists.
    /// Replaying the exact payload is idempotent; replacing an accepted plan
    /// or certificate set is rejected even when the writer uses a later
    /// process generation.
    pub fn commit_preparation_receipt(
        &self,
        receipt: &FmsPreparationReceipt,
    ) -> Result<PreparationReceiptCommitDisposition> {
        receipt.validate()?;
        let _lease = self.write_transaction()?;
        self.read_run_catalog(&receipt.run_id)?
            .context("preparation receipt requires a durable run catalog")?;
        let path = checked_path(
            &self.root,
            &format!("runs/{}/preparation_receipt.json", receipt.run_id),
        )?;
        if path.exists() {
            let data = fs::read(&path)?;
            let existing: FmsPreparationReceipt = serde_json::from_slice(&data)
                .with_context(|| format!("parsing preparation receipt {}", path.display()))?;
            existing.validate()?;
            if existing.run_id != receipt.run_id {
                anyhow::bail!("preparation receipt identity does not match its path");
            }
            if existing.same_immutable_payload(receipt) {
                return Ok(PreparationReceiptCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "preparation receipt for run `{}` is immutable and cannot be replaced",
                receipt.run_id
            );
        }
        let path = create_parent(
            &self.root,
            &format!("runs/{}/preparation_receipt.json", receipt.run_id),
        )?;
        let json = serde_json::to_vec_pretty(receipt)?;
        atomic_write(&path, &json)?;
        Ok(PreparationReceiptCommitDisposition::Accepted)
    }

    /// Read the immutable preparation receipt for one run, if published.
    pub fn read_preparation_receipt(&self, run_id: &str) -> Result<Option<FmsPreparationReceipt>> {
        validate_store_id(run_id)?;
        let path = checked_path(
            &self.root,
            &format!("runs/{run_id}/preparation_receipt.json"),
        )?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let receipt: FmsPreparationReceipt = serde_json::from_slice(&data)
            .with_context(|| format!("parsing preparation receipt {}", path.display()))?;
        receipt.validate()?;
        if receipt.run_id != run_id {
            anyhow::bail!("preparation receipt identity does not match its path");
        }
        Ok(Some(receipt))
    }

    /// Publish one immutable accepted-run preparation receipt for a catalog task.
    /// Replays of the same payload are idempotent; a task input or receipt
    /// replacement is rejected. This does not change task readiness.
    pub fn commit_task_preparation_receipt(
        &self,
        receipt: &FmsTaskPreparationReceipt,
    ) -> Result<PreparationReceiptCommitDisposition> {
        receipt.validate()?;
        let relative = receipt.relative_path()?;
        let _lease = self.write_transaction()?;
        let catalog = self
            .read_run_catalog(&receipt.run_id)?
            .context("task preparation receipt requires a durable run catalog")?;
        receipt.validate_for_catalog(&catalog)?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == receipt.task_id)
            .context("task preparation receipt task is missing from the run catalog")?;
        let intent = self
            .read_run_intent(&receipt.run_id)?
            .context("task preparation receipt requires an accepted run intent")?;
        receipt.validate_for_run_intent(&intent)?;
        let path = checked_path(&self.root, &relative)?;
        if path.exists() {
            let data = fs::read(&path)?;
            let existing: FmsTaskPreparationReceipt = serde_json::from_slice(&data)
                .with_context(|| format!("parsing task preparation receipt {}", path.display()))?;
            existing.validate_for_catalog(&catalog)?;
            existing.validate_for_run_intent(&intent)?;
            if existing.relative_path()? != relative {
                anyhow::bail!("task preparation receipt identity does not match its path");
            }
            if existing.same_immutable_payload(receipt) {
                return Ok(PreparationReceiptCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "task preparation receipt for task `{}` is immutable and cannot be replaced",
                receipt.task_id
            );
        }
        if task.lifecycle != FmsTaskLifecycle::Accepted
            || !matches!(&task.readiness, FmsTaskReadiness::Blocked { .. })
        {
            anyhow::bail!(
                "a new task preparation receipt requires an accepted, blocked task `{}`",
                receipt.task_id
            );
        }
        let path = create_parent(&self.root, &relative)?;
        let json = serde_json::to_vec_pretty(receipt)?;
        atomic_write(&path, &json)?;
        Ok(PreparationReceiptCommitDisposition::Accepted)
    }

    /// Read and validate one immutable accepted-run task receipt.
    pub fn read_task_preparation_receipt(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<Option<FmsTaskPreparationReceipt>> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        let relative = format!("runs/{run_id}/task_preparation_receipts/{task_id}.json");
        let path = checked_path(&self.root, &relative)?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let receipt: FmsTaskPreparationReceipt = serde_json::from_slice(&data)
            .with_context(|| format!("parsing task preparation receipt {}", path.display()))?;
        if receipt.relative_path()? != relative {
            anyhow::bail!("task preparation receipt identity does not match its path");
        }
        let catalog = self
            .read_run_catalog(run_id)?
            .context("task preparation receipt requires a durable run catalog")?;
        receipt.validate_for_catalog(&catalog)?;
        let intent = self
            .read_run_intent(run_id)?
            .context("task preparation receipt requires an accepted run intent")?;
        receipt.validate_for_run_intent(&intent)?;
        if receipt.task_id != task_id {
            anyhow::bail!("task preparation receipt task_id does not match its path");
        }
        Ok(Some(receipt))
    }

    /// Persist one fenced retry decision in the coordinator journal.
    ///
    /// The record is immutable and idempotent by `decision_id`.  Applying the
    /// decision to a new task snapshot remains a separate coordinator step;
    /// this boundary guarantees that the observed attempt and ownership epoch
    /// survive a process restart before a retry is admitted.
    pub fn commit_retry_decision(
        &self,
        decision: &FmsRetryDecision,
    ) -> Result<RetryDecisionCommitDisposition> {
        decision.validate()?;
        let _lease = self.write_transaction()?;
        let mut catalog = self
            .read_run_catalog(&decision.run_id)?
            .context("retry decision requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == decision.task_id)
            .context("retry decision task is missing from the run catalog")?;
        decision.validate_for_task(task)?;

        let path = checked_path(
            &self.root,
            &format!(
                "runs/{}/retry_decisions/{}.json",
                decision.run_id, decision.decision_id
            ),
        )?;
        if path.exists() {
            let data = fs::read(&path)
                .with_context(|| format!("reading retry decision {}", path.display()))?;
            let existing: FmsRetryDecision = serde_json::from_slice(&data)
                .with_context(|| format!("parsing retry decision {}", path.display()))?;
            existing.validate()?;
            if existing.run_id != decision.run_id || existing.decision_id != decision.decision_id {
                anyhow::bail!("retry decision identity does not match its path");
            }
            if existing == *decision {
                return Ok(RetryDecisionCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "retry decision `{}` conflicts with the durable payload",
                decision.decision_id
            );
        }
        let path = create_parent(
            &self.root,
            &format!(
                "runs/{}/retry_decisions/{}.json",
                decision.run_id, decision.decision_id
            ),
        )?;
        atomic_write(&path, &serde_json::to_vec_pretty(decision)?)?;
        Ok(RetryDecisionCommitDisposition::Accepted)
    }

    /// Apply a previously recorded retry decision to the durable task catalog.
    ///
    /// The decision is written before the catalog transition.  If the process
    /// dies between those two atomic publications, replaying this method finds
    /// the immutable decision and completes the transition.  A retry keeps the
    /// previous ownership epoch as a monotonic fence, clears the old attempt
    /// and resource binding, and returns the task to `Queued`; it never marks a
    /// live lease as released implicitly.
    pub fn apply_retry_decision(
        &self,
        decision: &FmsRetryDecision,
    ) -> Result<RetryDecisionApplyDisposition> {
        decision.validate()?;
        let _lease = self.write_transaction()?;
        let mut catalog = self
            .read_run_catalog(&decision.run_id)?
            .context("retry decision requires a durable run catalog")?;
        let task_index = catalog
            .tasks
            .iter()
            .position(|task| task.task_id == decision.task_id)
            .context("retry decision task is missing from the run catalog")?;

        let decision_path = checked_path(
            &self.root,
            &format!(
                "runs/{}/retry_decisions/{}.json",
                decision.run_id, decision.decision_id
            ),
        )?;
        let decision_was_replayed = if decision_path.exists() {
            let data = fs::read(&decision_path)
                .with_context(|| format!("reading retry decision {}", decision_path.display()))?;
            let existing: FmsRetryDecision = serde_json::from_slice(&data)
                .with_context(|| format!("parsing retry decision {}", decision_path.display()))?;
            existing.validate()?;
            if existing.run_id != decision.run_id || existing.decision_id != decision.decision_id {
                anyhow::bail!("retry decision identity does not match its path");
            }
            if existing != *decision {
                anyhow::bail!(
                    "retry decision `{}` conflicts with the durable payload",
                    decision.decision_id
                );
            }
            true
        } else {
            decision.validate_for_task(&catalog.tasks[task_index])?;
            let path = create_parent(
                &self.root,
                &format!(
                    "runs/{}/retry_decisions/{}.json",
                    decision.run_id, decision.decision_id
                ),
            )?;
            atomic_write(&path, &serde_json::to_vec_pretty(decision)?)?;
            false
        };

        let task = &mut catalog.tasks[task_index];
        let claim_matches = task.attempt_id.as_deref() == Some(decision.attempt_id.as_str())
            && task.ownership_epoch == Some(decision.ownership_epoch);
        if !claim_matches {
            if decision_was_replayed {
                return Ok(RetryDecisionApplyDisposition::Replayed);
            }
            anyhow::bail!("retry decision ownership fence does not match the run catalog");
        }

        let changed = match decision.action {
            FmsRetryAction::Retry => {
                if !matches!(
                    task.lifecycle,
                    FmsTaskLifecycle::Failed | FmsTaskLifecycle::Interrupted
                ) {
                    anyhow::bail!("retry action requires a failed or interrupted task");
                }
                if let Some(resource_id) = task.resource_id.as_deref() {
                    if self
                        .find_active_resource_lease_unlocked(resource_id)?
                        .is_some()
                    {
                        anyhow::bail!(
                            "retry requires an explicit release for resource `{resource_id}`"
                        );
                    }
                }
                task.lifecycle = FmsTaskLifecycle::Queued;
                task.observation = Some(FmsObservationState::Reconciling);
                task.attempt_id = None;
                task.resolved_input_fingerprint = None;
                task.resource_id = None;
                true
            }
            FmsRetryAction::DoNotRetry => false,
            FmsRetryAction::AwaitReconciliation => {
                let next = Some(FmsObservationState::Reconciling);
                let changed = task.observation != next;
                task.observation = next;
                changed
            }
        };

        if changed {
            catalog.revision = catalog
                .revision
                .checked_add(1)
                .context("run catalog revision exhausted")?;
            catalog.updated_at = chrono::Utc::now();
            catalog.validate()?;
            self.commit_run_catalog_unlocked(&catalog)?;
            Ok(RetryDecisionApplyDisposition::Applied)
        } else if decision_was_replayed {
            Ok(RetryDecisionApplyDisposition::Replayed)
        } else {
            Ok(RetryDecisionApplyDisposition::Applied)
        }
    }

    /// Read one immutable retry decision from the coordinator journal.
    pub fn read_retry_decision(
        &self,
        run_id: &str,
        decision_id: &str,
    ) -> Result<Option<FmsRetryDecision>> {
        validate_store_id(run_id)?;
        validate_store_id(decision_id)?;
        let path = checked_path(
            &self.root,
            &format!("runs/{run_id}/retry_decisions/{decision_id}.json"),
        )?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let decision: FmsRetryDecision = serde_json::from_slice(&data)?;
        decision.validate()?;
        if decision.run_id != run_id || decision.decision_id != decision_id {
            anyhow::bail!("retry decision identity does not match its path");
        }
        Ok(Some(decision))
    }

    /// List immutable retry decisions for one run in stable identity order.
    pub fn list_retry_decisions(&self, run_id: &str) -> Result<Vec<FmsRetryDecision>> {
        validate_store_id(run_id)?;
        let directory = checked_path(&self.root, &format!("runs/{run_id}/retry_decisions"))?;
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut decisions = Vec::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let metadata = entry.file_type()?;
            if metadata.is_symlink() || !metadata.is_file() {
                anyhow::bail!("unsafe retry decision entry `{}`", entry.path().display());
            }
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let decision_id = file_name
                .strip_suffix(".json")
                .context("retry decision entry must be JSON")?;
            validate_store_id(decision_id)?;
            decisions.push(
                self.read_retry_decision(run_id, decision_id)?
                    .context("listed retry decision disappeared during read")?,
            );
        }
        decisions.sort_by(|left, right| left.decision_id.cmp(&right.decision_id));
        Ok(decisions)
    }

    /// Persist the verified initial coordinator checkpoint before a new claim
    /// is allowed to publish worker commands.
    pub fn commit_coordinator_genesis(
        &self,
        run_id: &str,
        task_id: &str,
        genesis: &FmsCoordinatorGenesis,
    ) -> Result<CoordinatorGenesisCommitDisposition> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        let _lease = self.write_transaction()?;
        let mut catalog = self
            .read_run_catalog(run_id)?
            .context("coordinator genesis requires a durable run catalog")?;
        let task_index = catalog
            .tasks
            .iter()
            .position(|task| task.task_id == task_id)
            .context("coordinator genesis task is missing from the run catalog")?;
        let task = &catalog.tasks[task_index];
        genesis.validate_for_task(run_id, task)?;
        if task.attempt_id.as_deref() != Some(genesis.attempt_id.as_str()) {
            anyhow::bail!("coordinator genesis requires the current admitted task attempt");
        }
        if !matches!(task.readiness, FmsTaskReadiness::Ready)
            || !matches!(
                task.lifecycle,
                FmsTaskLifecycle::Preparing
                    | FmsTaskLifecycle::Running
                    | FmsTaskLifecycle::Stopping
            )
        {
            anyhow::bail!("coordinator genesis requires an admitted active task");
        }
        let resource_id = task
            .resource_id
            .as_deref()
            .context("coordinator genesis task has no assigned resource")?;
        let lease = self
            .read_resource_lease(run_id, resource_id, &genesis.lease_token)?
            .context("coordinator genesis active resource lease is missing")?;
        if lease.state != FmsResourceLeaseState::Active
            || lease.task_id != task_id
            || lease.attempt_id != genesis.attempt_id
            || lease.ownership_epoch != genesis.ownership_epoch
            || lease.heartbeat_sequence != genesis.lease_heartbeat_sequence
        {
            anyhow::bail!("coordinator genesis active resource lease fence rejected");
        }
        if let Some(existing) = &task.coordinator_genesis {
            if existing == genesis {
                return Ok(CoordinatorGenesisCommitDisposition::Replayed);
            }
            anyhow::bail!("coordinator genesis is immutable within one ownership epoch");
        }
        if task.coordinator_watermark.is_some_and(|watermark| {
            watermark.command_sequence != 0 || watermark.event_sequence != 0
        }) {
            anyhow::bail!("coordinator genesis cannot be added after journal progress");
        }
        if self.read_coordinator_journal(run_id)?.iter().any(|entry| {
            entry.task_id == task_id
                && entry.attempt_id == genesis.attempt_id
                && entry.ownership_epoch == genesis.ownership_epoch
        }) {
            anyhow::bail!("coordinator genesis cannot be added after journal publication");
        }
        catalog.tasks[task_index].coordinator_watermark = Some(FmsCoordinatorWatermark::default());
        catalog.tasks[task_index].coordinator_genesis = Some(genesis.clone());
        catalog.revision = catalog
            .revision
            .checked_add(1)
            .context("run catalog revision exhausted")?;
        catalog.updated_at = chrono::Utc::now();
        self.commit_run_catalog_unlocked_with_genesis(&catalog, true)?;
        Ok(CoordinatorGenesisCommitDisposition::Accepted)
    }

    /// Append one claim-fenced command or event to the durable coordinator
    /// journal.  Each direction has a strictly contiguous sequence; replaying
    /// the same entry is idempotent while a conflicting or skipped sequence is
    /// rejected before publication.
    pub fn commit_coordinator_journal_entry(
        &self,
        entry: &FmsCoordinatorJournalEntry,
    ) -> Result<CoordinatorJournalCommitDisposition> {
        entry.validate()?;
        let _lease = self.write_transaction()?;
        let catalog = self
            .read_run_catalog(&entry.run_id)?
            .context("coordinator journal entry requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == entry.task_id)
            .context("coordinator journal task is missing from the run catalog")?;
        entry.validate_for_task(task)?;

        let path = self.coordinator_journal_path(entry)?;
        if path.exists() {
            let data = fs::read(&path)
                .with_context(|| format!("reading coordinator journal {}", path.display()))?;
            let existing: FmsCoordinatorJournalEntry = serde_json::from_slice(&data)
                .with_context(|| format!("parsing coordinator journal {}", path.display()))?;
            existing.validate()?;
            if existing.run_id != entry.run_id
                || existing.direction != entry.direction
                || existing.entry_id != entry.entry_id
            {
                anyhow::bail!("coordinator journal identity does not match its path");
            }
            if existing == *entry {
                confirm_publication(&path)?;
                return Ok(CoordinatorJournalCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "coordinator journal entry `{}` conflicts with the durable payload",
                entry.entry_id
            );
        }

        let resource_id = task
            .resource_id
            .as_deref()
            .context("coordinator journal task has no assigned resource")?;
        let active_lease = self
            .read_resource_lease(&entry.run_id, resource_id, &entry.lease_token)?
            .context("active resource lease is missing")?;
        self.require_active_resource_lease(
            &entry.run_id,
            &entry.task_id,
            &entry.attempt_id,
            entry.ownership_epoch,
            resource_id,
            &entry.lease_token,
            active_lease.heartbeat_sequence,
        )?;

        let stream_root = checked_path(
            &self.root,
            &format!(
                "runs/{}/coordinator_journal/{}",
                entry.run_id,
                entry.direction.as_str()
            ),
        )?;
        let mut last_sequence = 0_u64;
        let mut terminal = false;
        if stream_root.exists() {
            if !stream_root.is_dir() {
                anyhow::bail!("coordinator journal stream is not a directory");
            }
            for journal_entry in fs::read_dir(&stream_root)? {
                let journal_entry = journal_entry?;
                reject_link(&journal_entry.path())?;
                if !journal_entry.file_type()?.is_file() {
                    anyhow::bail!("coordinator journal entry is not a file");
                }
                let file_name = journal_entry.file_name().to_string_lossy().into_owned();
                let Some(existing_id) = file_name.strip_suffix(".json") else {
                    anyhow::bail!("coordinator journal entry must be JSON");
                };
                validate_store_id(existing_id)?;
                let data = fs::read(journal_entry.path())?;
                let existing: FmsCoordinatorJournalEntry = serde_json::from_slice(&data)?;
                existing.validate()?;
                if existing.run_id != entry.run_id
                    || existing.direction != entry.direction
                    || existing.entry_id != existing_id
                {
                    anyhow::bail!("coordinator journal path identity mismatch");
                }
                // Sequence and terminal fences belong to one task attempt,
                // not all tasks and historical attempts in the run directory.
                if existing.task_id != entry.task_id
                    || existing.attempt_id != entry.attempt_id
                    || existing.ownership_epoch != entry.ownership_epoch
                {
                    continue;
                }
                if existing.lease_token != entry.lease_token {
                    anyhow::bail!(
                        "coordinator journal lease token changed within one task attempt"
                    );
                }
                if existing.sequence == entry.sequence {
                    anyhow::bail!(
                        "coordinator journal sequence {} conflicts with an existing entry",
                        entry.sequence
                    );
                }
                last_sequence = last_sequence.max(existing.sequence);
                terminal |= existing.terminal;
            }
        }
        if terminal {
            anyhow::bail!("coordinator journal stream is already terminal");
        }
        let expected = last_sequence
            .checked_add(1)
            .context("coordinator journal sequence exhausted")?;
        if entry.sequence != expected {
            anyhow::bail!(
                "coordinator journal sequence must advance contiguously (expected {}, received {})",
                expected,
                entry.sequence
            );
        }
        let relative = format!(
            "runs/{}/coordinator_journal/{}/{}.json",
            entry.run_id,
            entry.direction.as_str(),
            entry.entry_id
        );
        atomic_write(
            &create_parent(&self.root, &relative)?,
            &serde_json::to_vec_pretty(entry)?,
        )?;
        Ok(CoordinatorJournalCommitDisposition::Accepted)
    }

    /// Read one durable coordinator journal entry by its stream identity.
    pub fn read_coordinator_journal_entry(
        &self,
        run_id: &str,
        direction: FmsCoordinatorJournalDirection,
        entry_id: &str,
    ) -> Result<Option<FmsCoordinatorJournalEntry>> {
        validate_store_id(run_id)?;
        validate_store_id(entry_id)?;
        let path = checked_path(
            &self.root,
            &format!(
                "runs/{run_id}/coordinator_journal/{}/{entry_id}.json",
                direction.as_str()
            ),
        )?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let entry: FmsCoordinatorJournalEntry = serde_json::from_slice(&data)?;
        entry.validate()?;
        if entry.run_id != run_id || entry.direction != direction || entry.entry_id != entry_id {
            anyhow::bail!("coordinator journal identity does not match its path");
        }
        Ok(Some(entry))
    }

    /// Read a consistent, validated journal snapshot for recovery. Ordering is
    /// per direction and claim, not a causal order between commands and events.
    /// Historical attempts are retained; callers must reconcile the live claim
    /// before sending anything to a worker.
    pub fn read_coordinator_journal(
        &self,
        run_id: &str,
    ) -> Result<Vec<FmsCoordinatorJournalEntry>> {
        validate_store_id(run_id)?;
        let _lease = self.write_transaction()?;
        self.read_run_catalog(run_id)?
            .context("coordinator journal snapshot requires a durable run catalog")?;
        let mut entries = Vec::new();
        for direction in [
            FmsCoordinatorJournalDirection::Command,
            FmsCoordinatorJournalDirection::Event,
        ] {
            let root = checked_path(
                &self.root,
                &format!("runs/{run_id}/coordinator_journal/{}", direction.as_str()),
            )?;
            if !root.exists() {
                continue;
            }
            for file in fs::read_dir(root)? {
                let file = file?;
                reject_link(&file.path())?;
                if !file.file_type()?.is_file() {
                    anyhow::bail!("coordinator journal entry is not a file");
                }
                let name = file.file_name();
                let id = name
                    .to_str()
                    .and_then(|name| name.strip_suffix(".json"))
                    .context("coordinator journal entry must be UTF-8 JSON")?;
                let entry = self
                    .read_coordinator_journal_entry(run_id, direction, id)?
                    .context("coordinator journal entry disappeared during snapshot")?;
                entries.push(entry);
            }
        }
        entries.sort_by(|a, b| {
            (
                a.direction.as_str(),
                &a.task_id,
                &a.attempt_id,
                a.ownership_epoch,
                a.sequence,
            )
                .cmp(&(
                    b.direction.as_str(),
                    &b.task_id,
                    &b.attempt_id,
                    b.ownership_epoch,
                    b.sequence,
                ))
        });
        let mut previous: Option<&FmsCoordinatorJournalEntry> = None;
        for entry in &entries {
            let same_stream = previous.filter(|prior| {
                prior.direction == entry.direction
                    && prior.task_id == entry.task_id
                    && prior.attempt_id == entry.attempt_id
                    && prior.ownership_epoch == entry.ownership_epoch
            });
            let expected = if let Some(prior) = same_stream {
                if prior.terminal {
                    anyhow::bail!("coordinator journal contains an entry after terminal");
                }
                if prior.lease_token != entry.lease_token {
                    anyhow::bail!(
                        "coordinator journal lease token changed within one task attempt"
                    );
                }
                prior
                    .sequence
                    .checked_add(1)
                    .context("coordinator journal sequence exhausted")?
            } else {
                1
            };
            if entry.sequence != expected {
                anyhow::bail!("coordinator journal snapshot has a gap or duplicate sequence");
            }
            previous = Some(entry);
        }
        Ok(entries)
    }

    fn coordinator_journal_path(&self, entry: &FmsCoordinatorJournalEntry) -> Result<PathBuf> {
        Ok(checked_path(
            &self.root,
            &format!(
                "runs/{}/coordinator_journal/{}/{}.json",
                entry.run_id,
                entry.direction.as_str(),
                entry.entry_id
            ),
        )?)
    }

    /// Mark non-terminal task observations as reconciling after a coordinator
    /// restart.  Lifecycle and ownership are preserved; this method never
    /// invents a retry or a new attempt.
    pub fn reconcile_run_catalog(&self, run_id: &str) -> Result<Option<FmsRunCatalog>> {
        // Reconciliation is a read-modify-publish transaction. Acquire before
        // reading so a concurrent writer cannot make this snapshot stale.
        let _lease = self.write_transaction()?;
        let Some(mut catalog) = self.read_run_catalog(run_id)? else {
            return Ok(None);
        };
        let mut changed = false;
        for task in &mut catalog.tasks {
            if matches!(
                task.lifecycle,
                FmsTaskLifecycle::Succeeded
                    | FmsTaskLifecycle::Failed
                    | FmsTaskLifecycle::Cancelled
                    | FmsTaskLifecycle::Interrupted
            ) {
                continue;
            }
            if task.observation != Some(FmsObservationState::Reconciling) {
                task.observation = Some(FmsObservationState::Reconciling);
                changed = true;
            }
        }
        if !changed {
            return Ok(Some(catalog));
        }
        catalog.revision = catalog
            .revision
            .checked_add(1)
            .context("run catalog revision exhausted")?;
        catalog.updated_at = chrono::Utc::now();
        catalog.validate()?;
        self.commit_run_catalog_unlocked(&catalog)?;
        Ok(Some(catalog))
    }

    /// Publish an immutable artifact catalog snapshot after ownership fencing.
    ///
    /// New entries must match the current task attempt/epoch in the durable
    /// run catalog. Existing immutable entries remain in the append-only
    /// catalog across retries; a newer revision may only append entries.
    pub(crate) fn commit_artifact_catalog(&self, catalog: &FmsArtifactCatalog) -> Result<()> {
        catalog.validate()?;
        let _lease = self.write_transaction()?;
        self.commit_artifact_catalog_unlocked(catalog, false)
    }

    fn commit_artifact_catalog_unlocked(
        &self,
        catalog: &FmsArtifactCatalog,
        allow_active_study_outputs: bool,
    ) -> Result<()> {
        catalog.validate()?;
        let run_catalog = self
            .read_run_catalog(&catalog.run_id)?
            .context("artifact publication requires a durable run catalog")?;
        let owners = run_catalog
            .tasks
            .iter()
            .filter_map(|task| {
                Some((
                    task.task_id.as_str(),
                    (
                        task.attempt_id.as_deref()?,
                        task.ownership_epoch?,
                        task.lifecycle,
                    ),
                ))
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let path = checked_path(
            &self.root,
            &format!("runs/{}/artifact_catalog.json", catalog.run_id),
        )?;
        let existing = if path.exists() {
            let data = fs::read(&path)?;
            let existing: FmsArtifactCatalog = serde_json::from_slice(&data)
                .with_context(|| format!("parsing artifact catalog {}", path.display()))?;
            existing.validate()?;
            if existing.run_id != catalog.run_id {
                anyhow::bail!("artifact catalog identity does not match its path");
            }
            Some(existing)
        } else {
            None
        };
        for entry in &catalog.entries {
            let previous = existing.as_ref().and_then(|existing| {
                existing
                    .entries
                    .iter()
                    .find(|previous| previous.artifact_id == entry.artifact_id)
            });
            if let Some(previous) = previous {
                if previous != entry {
                    anyhow::bail!(
                        "artifact `{}` cannot be replaced after publication",
                        entry.artifact_id
                    );
                }
            } else {
                let Some((attempt_id, ownership_epoch, lifecycle)) =
                    owners.get(entry.task_id.as_str())
                else {
                    anyhow::bail!(
                        "artifact `{}` references a task without a current ownership claim",
                        entry.artifact_id
                    );
                };
                if *attempt_id != entry.attempt_id || *ownership_epoch != entry.ownership_epoch {
                    anyhow::bail!(
                        "artifact `{}` ownership fence does not match task `{}`",
                        entry.artifact_id,
                        entry.task_id
                    );
                }
                if entry.study_output.is_some()
                    && *lifecycle != FmsTaskLifecycle::Succeeded
                    && !(allow_active_study_outputs
                        && matches!(
                            lifecycle,
                            FmsTaskLifecycle::Preparing
                                | FmsTaskLifecycle::Running
                                | FmsTaskLifecycle::Stopping
                        ))
                {
                    anyhow::bail!(
                        "study output artifact `{}` requires a succeeded task or an active lease on an active task",
                        entry.artifact_id
                    );
                }
            }
            if matches!(entry.status, FmsArtifactStatus::Published) {
                let Some(object_ref) = entry.object_ref.as_deref() else {
                    anyhow::bail!(
                        "published artifact `{}` requires a CAS object reference",
                        entry.artifact_id
                    );
                };
                let object_path =
                    checked_path(&self.root, &format!("objects/sha256/{object_ref}"))?;
                if !object_path.is_file() {
                    anyhow::bail!(
                        "published artifact `{}` references missing object `{object_ref}`",
                        entry.artifact_id
                    );
                }
                let actual = crate::cas::hex_sha256(&fs::read(object_path)?);
                if actual != object_ref {
                    anyhow::bail!("artifact CAS object digest mismatch for `{object_ref}`");
                }
            }
        }

        if let Some(existing) = existing {
            if existing.revision > catalog.revision {
                anyhow::bail!(
                    "stale artifact catalog revision {}; current revision is {}",
                    catalog.revision,
                    existing.revision
                );
            }
            for previous in &existing.entries {
                let Some(next) = catalog
                    .entries
                    .iter()
                    .find(|entry| entry.artifact_id == previous.artifact_id)
                else {
                    anyhow::bail!(
                        "artifact `{}` cannot be removed from an immutable catalog",
                        previous.artifact_id
                    );
                };
                if next != previous {
                    anyhow::bail!(
                        "artifact `{}` cannot be replaced after publication",
                        previous.artifact_id
                    );
                }
            }
            if existing.revision == catalog.revision {
                if existing == *catalog {
                    return Ok(());
                }
                anyhow::bail!(
                    "artifact catalog revision {} conflicts with the durable payload",
                    catalog.revision
                );
            }
        }
        let path = create_parent(
            &self.root,
            &format!("runs/{}/artifact_catalog.json", catalog.run_id),
        )?;
        let json = serde_json::to_vec_pretty(catalog)?;
        atomic_write(&path, &json)?;
        Ok(())
    }

    /// Atomically append artifact entries while the exact publishing lease is
    /// still active. This fences publication against retry and lease release,
    /// including a release racing the final catalog write.
    pub fn append_artifact_catalog_entries_for_lease(
        &self,
        lease: &FmsResourceLease,
        entries: &[FmsArtifactCatalogEntry],
    ) -> Result<FmsArtifactCatalog> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("artifact publication requires an active resource lease");
        }
        if entries.is_empty() {
            anyhow::bail!("artifact catalog append requires at least one entry");
        }
        let _writer_lease = self.write_transaction()?;
        let lease_path = self.resource_lease_path(lease)?;
        let lease_bytes = fs::read(&lease_path)
            .with_context(|| format!("reading resource lease {}", lease_path.display()))?;
        let current_lease: FmsResourceLease = serde_json::from_slice(&lease_bytes)
            .with_context(|| format!("parsing resource lease {}", lease_path.display()))?;
        current_lease.validate()?;
        if current_lease.state != FmsResourceLeaseState::Active
            || !current_lease.identity_matches(lease)
            || current_lease.kind != lease.kind
            || current_lease.budget != lease.budget
            || current_lease.heartbeat_sequence < lease.heartbeat_sequence
        {
            anyhow::bail!("artifact publication lease fence rejected");
        }

        let mut run_catalog = self
            .read_run_catalog(&lease.run_id)?
            .context("artifact publication requires a durable run catalog")?;
        let task_index = run_catalog
            .tasks
            .iter()
            .position(|task| task.task_id == lease.task_id)
            .context("artifact publication task is missing from the run catalog")?;
        let task = &run_catalog.tasks[task_index];
        if task.attempt_id.as_deref() != Some(lease.attempt_id.as_str())
            || task.ownership_epoch != Some(lease.ownership_epoch)
            || task.resource_id.as_deref() != Some(lease.resource_id.as_str())
        {
            anyhow::bail!("artifact publication lease does not match the current task owner");
        }
        let task_lifecycle = task.lifecycle;

        let existing = self.read_artifact_catalog(&lease.run_id)?;
        let manifest_already_published = existing.as_ref().is_some_and(|catalog| {
            catalog.entries.iter().any(|entry| {
                entry.task_id == lease.task_id
                    && entry.attempt_id == lease.attempt_id
                    && entry.ownership_epoch == lease.ownership_epoch
                    && entry.artifact_type == "study_output_manifest"
            })
        });
        if manifest_already_published {
            let existing = existing
                .as_ref()
                .context("published output manifest has no artifact catalog")?;
            for entry in entries {
                let is_output_or_manifest =
                    entry.study_output.is_some() || entry.artifact_type == "study_output_manifest";
                let exact_existing_entry = existing
                    .entries
                    .iter()
                    .any(|previous| previous.artifact_id == entry.artifact_id && previous == entry);
                if is_output_or_manifest && !exact_existing_entry {
                    anyhow::bail!(
                        "study output manifest is the immutable allow-list for attempt `{}`",
                        lease.attempt_id
                    );
                }
            }
        }
        let mut catalog = existing.clone().unwrap_or_else(|| FmsArtifactCatalog {
            schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
            run_id: lease.run_id.clone(),
            revision: 1,
            updated_at: chrono::Utc::now(),
            entries: Vec::new(),
        });
        let mut changed = false;
        for entry in entries {
            if entry.task_id != lease.task_id
                || entry.attempt_id != lease.attempt_id
                || entry.ownership_epoch != lease.ownership_epoch
            {
                anyhow::bail!(
                    "artifact `{}` ownership does not match the publishing lease",
                    entry.artifact_id
                );
            }
            if let Some(previous) = catalog
                .entries
                .iter()
                .find(|previous| previous.artifact_id == entry.artifact_id)
            {
                if previous != entry {
                    anyhow::bail!(
                        "artifact `{}` cannot be replaced after publication",
                        entry.artifact_id
                    );
                }
                continue;
            }
            catalog.entries.push(entry.clone());
            changed = true;
        }
        if changed
            && !matches!(
                task_lifecycle,
                FmsTaskLifecycle::Preparing
                    | FmsTaskLifecycle::Running
                    | FmsTaskLifecycle::Stopping
            )
        {
            anyhow::bail!("new study outputs must be published before task completion");
        }
        if changed {
            if existing.is_some() {
                catalog.revision = catalog
                    .revision
                    .checked_add(1)
                    .context("artifact catalog revision exhausted")?;
            }
            catalog.updated_at = chrono::Utc::now();
            self.commit_artifact_catalog_unlocked(&catalog, true)?;
        }

        // The artifact catalog is canonical; task.artifact_ids is a query
        // projection used by run APIs. Repair it on exact replays as well, so
        // a crash between the two durable writes does not strand an output.
        let mut projection_changed = false;
        for artifact_id in catalog
            .entries
            .iter()
            .filter(|entry| entry.task_id == lease.task_id)
            .map(|entry| &entry.artifact_id)
        {
            let task = &mut run_catalog.tasks[task_index];
            if !task.artifact_ids.contains(artifact_id) {
                task.artifact_ids.push(artifact_id.clone());
                projection_changed = true;
            }
        }
        if projection_changed {
            run_catalog.revision = run_catalog
                .revision
                .checked_add(1)
                .context("run catalog revision exhausted while projecting study outputs")?;
            run_catalog.updated_at = chrono::Utc::now();
            self.commit_run_catalog_unlocked(&run_catalog)?;
        }
        Ok(catalog)
    }

    /// Read the durable artifact catalog for one run, if present.
    pub fn read_artifact_catalog(&self, run_id: &str) -> Result<Option<FmsArtifactCatalog>> {
        validate_store_id(run_id)?;
        let path = checked_path(&self.root, &format!("runs/{run_id}/artifact_catalog.json"))?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let catalog: FmsArtifactCatalog = serde_json::from_slice(&data)?;
        catalog.validate()?;
        if catalog.run_id != run_id {
            anyhow::bail!("artifact catalog identity does not match its path");
        }
        Ok(Some(catalog))
    }

    /// Admit one queued task using a durable intent before publishing its
    /// preparing catalog projection and resource lease. Replaying the same
    /// lease finishes an interrupted admission; a new token cannot replace it.
    pub fn commit_task_admission(
        &self,
        lease: &FmsResourceLease,
    ) -> Result<TaskAdmissionCommitDisposition> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active || lease.heartbeat_sequence != 0 {
            anyhow::bail!("task admission requires a fresh active resource lease");
        }
        let _writer_lease = self.write_transaction()?;
        let record_path = self.task_admission_path(
            &lease.run_id,
            &lease.task_id,
            &lease.attempt_id,
        )?;
        if record_path.exists() {
            let record: FmsTaskAdmissionRecord = serde_json::from_slice(&fs::read(&record_path)?)
                .context("parsing durable task admission")?;
            record.validate()?;
            if !record.lease.identity_matches(lease)
                || record.lease.kind != lease.kind
                || record.lease.budget != lease.budget
                || record.lease.state != lease.state
                || record.lease.heartbeat_sequence != lease.heartbeat_sequence
            {
                anyhow::bail!("task admission attempt conflicts with its durable lease");
            }
            return self.apply_task_admission_record_unlocked(&record);
        }

        let catalog = self
            .read_run_catalog(&lease.run_id)?
            .context("task admission requires a durable run catalog")?;
        let task_index = catalog
            .tasks
            .iter()
            .position(|task| task.task_id == lease.task_id)
            .context("task admission target is missing from the run catalog")?;
        let queued_task = catalog.tasks[task_index].clone();
        if queued_task.lifecycle != FmsTaskLifecycle::Queued
            || queued_task.readiness != FmsTaskReadiness::Ready
            || queued_task.attempt_id.is_some()
            || queued_task.resource_id.is_some()
        {
            anyhow::bail!("task admission requires a ready, unclaimed queued task");
        }
        let expected_epoch = queued_task
            .ownership_epoch
            .map_or(Some(1), |epoch| epoch.checked_add(1))
            .context("task ownership epoch exhausted")?;
        if lease.ownership_epoch != expected_epoch {
            anyhow::bail!("task admission lease has a stale or skipped ownership epoch");
        }
        if self
            .find_active_resource_lease_unlocked(&lease.resource_id)?
            .is_some()
        {
            anyhow::bail!("task admission resource already has an active lease");
        }

        let mut task = queued_task.clone();
        task.lifecycle = FmsTaskLifecycle::Preparing;
        task.readiness = FmsTaskReadiness::Ready;
        task.attempt_id = Some(lease.attempt_id.clone());
        task.ownership_epoch = Some(lease.ownership_epoch);
        task.resource_id = Some(lease.resource_id.clone());
        task.resolved_input_fingerprint = None;
        task.coordinator_watermark = None;
        task.coordinator_genesis = None;
        let record = FmsTaskAdmissionRecord {
            schema_version: FMS_TASK_ADMISSION_SCHEMA.into(),
            expected_catalog_revision: catalog.revision,
            queued_task,
            task,
            lease: lease.clone(),
        };
        record.validate()?;

        if record_path.exists() {
            anyhow::bail!("task admission record path already exists");
        }
        let record_path = create_parent(
            &self.root,
            &format!(
                "runs/{}/task_admissions/{}/{}.json",
                lease.run_id, lease.task_id, lease.attempt_id
            ),
        )?;
        atomic_write(&record_path, &serde_json::to_vec_pretty(&record)?)?;
        self.apply_task_admission_record_unlocked(&record)
    }

    /// Replay admission intents before scheduling after a process restart.
    /// Superseded records remain immutable history and never reclaim a lease.
    pub fn reconcile_task_admissions(
        &self,
        run_id: &str,
    ) -> Result<Vec<TaskAdmissionCommitDisposition>> {
        validate_store_id(run_id)?;
        let _writer_lease = self.write_transaction()?;
        let root = checked_path(&self.root, &format!("runs/{run_id}/task_admissions"))?;
        if !root.exists() {
            return Ok(Vec::new());
        }
        reject_link(&root)?;
        let mut records = Vec::new();
        for task_dir in fs::read_dir(&root)? {
            let task_dir = task_dir?;
            reject_link(&task_dir.path())?;
            if !task_dir.file_type()?.is_dir() {
                anyhow::bail!("task admission entry is not a directory");
            }
            let task_id = task_dir
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 task admission identity"))?;
            validate_store_id(&task_id)?;
            for entry in fs::read_dir(task_dir.path())? {
                let entry = entry?;
                let entry_path = entry.path();
                reject_link(&entry_path)?;
                if !entry.file_type()?.is_file() {
                    anyhow::bail!("task admission record is not a regular file");
                }
                let path_attempt_id = entry_path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .context("task admission record has no UTF-8 attempt name")?;
                validate_store_id(path_attempt_id)?;
                if entry_path.extension().and_then(|value| value.to_str()) != Some("json") {
                    anyhow::bail!("task admission record must use the .json extension");
                }
                let record: FmsTaskAdmissionRecord = serde_json::from_slice(&fs::read(&entry_path)?)
                    .with_context(|| format!("parsing task admission {}", entry_path.display()))?;
                record.validate()?;
                if record.lease.run_id != run_id
                    || record.task.task_id != task_id
                    || record.lease.attempt_id != path_attempt_id
                {
                    anyhow::bail!("task admission identity does not match its path");
                }
                records.push(record);
            }
        }
        records.sort_by(|left, right| {
            (left.lease.ownership_epoch, &left.task.task_id, &left.lease.attempt_id).cmp(&(
                right.lease.ownership_epoch,
                &right.task.task_id,
                &right.lease.attempt_id,
            ))
        });
        records
            .iter()
            .map(|record| self.apply_task_admission_record_unlocked(record))
            .collect()
    }

    fn apply_task_admission_record_unlocked(
        &self,
        record: &FmsTaskAdmissionRecord,
    ) -> Result<TaskAdmissionCommitDisposition> {
        record.validate()?;
        let mut catalog = self
            .read_run_catalog(&record.lease.run_id)?
            .context("task admission run catalog is missing")?;
        let task_index = catalog
            .tasks
            .iter()
            .position(|task| task.task_id == record.task.task_id)
            .context("task admission target is missing from the run catalog")?;
        let current = &catalog.tasks[task_index];
        let current_epoch = current.ownership_epoch.unwrap_or(0);
        if current_epoch > record.lease.ownership_epoch {
            return Ok(TaskAdmissionCommitDisposition::Superseded);
        }
        let current_claim_matches = current.attempt_id.as_deref()
            == Some(record.lease.attempt_id.as_str())
            && current.ownership_epoch == Some(record.lease.ownership_epoch)
            && current.resource_id.as_deref() == Some(record.lease.resource_id.as_str());

        if current_claim_matches {
            if matches!(
                current.lifecycle,
                FmsTaskLifecycle::Succeeded
                    | FmsTaskLifecycle::Failed
                    | FmsTaskLifecycle::Cancelled
                    | FmsTaskLifecycle::Interrupted
            ) {
                return Ok(TaskAdmissionCommitDisposition::Replayed);
            }
            if !matches!(
                current.lifecycle,
                FmsTaskLifecycle::Preparing
                    | FmsTaskLifecycle::Running
                    | FmsTaskLifecycle::Stopping
            ) || current.readiness != FmsTaskReadiness::Ready
                || catalog.revision <= record.expected_catalog_revision
            {
                anyhow::bail!("durable task admission projection is inconsistent");
            }
            self.ensure_admission_lease_unlocked(record)?;
            return Ok(TaskAdmissionCommitDisposition::Replayed);
        }

        if current.attempt_id.is_some() {
            anyhow::bail!("task admission conflicts with another current attempt");
        }
        if catalog.revision < record.expected_catalog_revision
            || current != &record.queued_task
        {
            anyhow::bail!("task admission source changed before replay");
        }
        if self
            .find_active_resource_lease_unlocked(&record.lease.resource_id)?
            .is_some()
        {
            anyhow::bail!("task admission resource is held by another active lease");
        }

        catalog.tasks[task_index] = record.task.clone();
        catalog.revision = catalog
            .revision
            .checked_add(1)
            .context("run catalog revision exhausted during task admission")?;
        catalog.updated_at = chrono::Utc::now();
        catalog.validate()?;
        self.commit_run_catalog_unlocked(&catalog)?;
        self.ensure_admission_lease_unlocked(record)?;
        Ok(TaskAdmissionCommitDisposition::Admitted)
    }

    fn ensure_admission_lease_unlocked(&self, record: &FmsTaskAdmissionRecord) -> Result<()> {
        let lease_path = self.resource_lease_path(&record.lease)?;
        if lease_path.exists() {
            let existing = self
                .read_resource_lease(
                    &record.lease.run_id,
                    &record.lease.resource_id,
                    &record.lease.lease_token,
                )?
                .context("task admission lease disappeared while being read")?;
            if existing != record.lease || existing.state != FmsResourceLeaseState::Active {
                anyhow::bail!("task admission cannot reactivate a conflicting lease record");
            }
            return Ok(());
        }
        self.commit_resource_lease(&record.lease)?;
        Ok(())
    }

    /// Atomically acquire one durable lease for a physical resource.
    ///
    /// The writer lock serializes coordinators on this store.  An active lease
    /// is never reclaimed from heartbeat age alone; only an explicit release
    /// can make the resource available again.
    pub fn commit_resource_lease(
        &self,
        lease: &FmsResourceLease,
    ) -> Result<ResourceLeaseCommitDisposition> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("resource lease acquisition requires active state");
        }
        let _writer_lease = self.write_transaction()?;
        self.validate_resource_lease_owner_unlocked(lease)?;
        if let Some(existing) = self.find_active_resource_lease_unlocked(&lease.resource_id)? {
            if existing.identity_matches(lease)
                && existing.kind == lease.kind
                && existing.budget == lease.budget
            {
                return Ok(ResourceLeaseCommitDisposition::Replayed);
            }
            anyhow::bail!(
                "resource `{}` already has an active durable lease",
                lease.resource_id
            );
        }
        let path = self.resource_lease_path(lease)?;
        if path.exists() {
            anyhow::bail!(
                "resource lease token path already exists for `{}`",
                lease.lease_token
            );
        }
        let json = serde_json::to_vec_pretty(lease)?;
        atomic_write(
            &create_parent(
                &self.root,
                &format!(
                    "runs/{}/resource_leases/{}/{}.json",
                    lease.run_id, lease.resource_id, lease.lease_token
                ),
            )?,
            &json,
        )?;
        Ok(ResourceLeaseCommitDisposition::Acquired)
    }

    /// Read the active lease for a task whose ownership is already recorded in
    /// the run catalog. The catalog binding and lease are checked while the
    /// store writer is held; absent or unclaimed tasks return `None`.
    pub fn read_active_resource_lease_for_task(
        &self,
        run_id: &str,
        task_id: &str,
    ) -> Result<Option<FmsResourceLease>> {
        validate_store_id(run_id)?;
        validate_store_id(task_id)?;
        let _writer_lease = self.write_transaction()?;
        let Some(catalog) = self.read_run_catalog(run_id)? else {
            return Ok(None);
        };
        let Some(task) = catalog.tasks.iter().find(|task| task.task_id == task_id) else {
            anyhow::bail!("task is missing from the durable run catalog");
        };
        if !matches!(task.readiness, FmsTaskReadiness::Ready)
            || !matches!(
                task.lifecycle,
                FmsTaskLifecycle::Preparing
                    | FmsTaskLifecycle::Running
                    | FmsTaskLifecycle::Stopping
            )
        {
            return Ok(None);
        }
        let (Some(attempt_id), Some(ownership_epoch), Some(resource_id)) = (
            task.attempt_id.as_deref(),
            task.ownership_epoch,
            task.resource_id.as_deref(),
        ) else {
            return Ok(None);
        };
        let Some(lease) = self.find_active_resource_lease_unlocked(resource_id)? else {
            return Ok(None);
        };
        if lease.run_id != run_id
            || lease.task_id != task_id
            || lease.attempt_id != attempt_id
            || lease.ownership_epoch != ownership_epoch
        {
            anyhow::bail!("active resource lease does not match the durable task claim");
        }
        Ok(Some(lease))
    }

    /// Require the exact active resource lease for a worker publication.
    pub fn require_active_resource_lease(
        &self,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        ownership_epoch: u64,
        resource_id: &str,
        lease_token: &str,
        heartbeat_sequence: u64,
    ) -> Result<FmsResourceLease> {
        let _writer_lease = self.write_transaction()?;
        let lease = self
            .read_resource_lease(run_id, resource_id, lease_token)?
            .context("active resource lease is missing")?;
        if lease.state != FmsResourceLeaseState::Active
            || lease.task_id != task_id
            || lease.attempt_id != attempt_id
            || lease.ownership_epoch != ownership_epoch
            || lease.heartbeat_sequence != heartbeat_sequence
        {
            anyhow::bail!("active resource lease ownership fence rejected");
        }
        Ok(lease)
    }

    /// Read a lease by its durable identity.
    pub fn read_resource_lease(
        &self,
        run_id: &str,
        resource_id: &str,
        lease_token: &str,
    ) -> Result<Option<FmsResourceLease>> {
        validate_store_id(run_id)?;
        validate_store_id(resource_id)?;
        validate_store_id(lease_token)?;
        let path = checked_path(
            &self.root,
            &format!("runs/{run_id}/resource_leases/{resource_id}/{lease_token}.json"),
        )?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let lease: FmsResourceLease = serde_json::from_slice(&data)
            .with_context(|| format!("parsing resource lease {}", path.display()))?;
        lease.validate()?;
        if lease.run_id != run_id
            || lease.resource_id != resource_id
            || lease.lease_token != lease_token
        {
            anyhow::bail!("resource lease identity does not match its path");
        }
        Ok(Some(lease))
    }

    /// Advance the heartbeat of the exact active lease.  Sequence numbers are
    /// monotonic and stale worker heartbeats are rejected.
    pub fn heartbeat_resource_lease(&self, lease: &FmsResourceLease) -> Result<()> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("resource lease heartbeat requires active state");
        }
        let _writer_lease = self.write_transaction()?;
        self.validate_resource_lease_owner_unlocked(lease)?;
        let path = self.resource_lease_path(lease)?;
        let data = fs::read(&path)
            .with_context(|| format!("reading resource lease {}", path.display()))?;
        let current: FmsResourceLease = serde_json::from_slice(&data)?;
        current.validate()?;
        if !current.identity_matches(lease)
            || current.kind != lease.kind
            || current.budget != lease.budget
        {
            anyhow::bail!("resource lease heartbeat ownership fence rejected");
        }
        if current.state != FmsResourceLeaseState::Active {
            anyhow::bail!("resource lease is already released");
        }
        if lease.heartbeat_sequence == current.heartbeat_sequence {
            if lease == &current {
                return Ok(());
            }
            anyhow::bail!("resource lease heartbeat sequence conflicts with durable payload");
        }
        if lease.heartbeat_sequence != current.heartbeat_sequence.saturating_add(1) {
            anyhow::bail!(
                "resource lease heartbeat sequence must advance by one (current {}, received {})",
                current.heartbeat_sequence,
                lease.heartbeat_sequence
            );
        }
        let json = serde_json::to_vec_pretty(lease)?;
        atomic_write(&path, &json)?;
        Ok(())
    }

    /// Explicitly release an active lease.  A stale claim cannot release a
    /// newer heartbeat or ownership epoch.
    pub fn release_resource_lease(&self, lease: &FmsResourceLease) -> Result<()> {
        lease.validate()?;
        if lease.state != FmsResourceLeaseState::Active {
            anyhow::bail!("resource lease release requires the active lease identity");
        }
        let _writer_lease = self.write_transaction()?;
        let path = self.resource_lease_path(lease)?;
        let data = fs::read(&path)
            .with_context(|| format!("reading resource lease {}", path.display()))?;
        let mut current: FmsResourceLease = serde_json::from_slice(&data)?;
        current.validate()?;
        if !current.identity_matches(lease)
            || current.kind != lease.kind
            || current.budget != lease.budget
        {
            anyhow::bail!("resource lease release ownership fence rejected");
        }
        if current.state == FmsResourceLeaseState::Released {
            return Ok(());
        }
        if current.heartbeat_sequence != lease.heartbeat_sequence {
            anyhow::bail!("stale resource lease cannot release a newer heartbeat");
        }
        current.state = FmsResourceLeaseState::Released;
        current.released_at = Some(chrono::Utc::now());
        current.validate()?;
        atomic_write(&path, &serde_json::to_vec_pretty(&current)?)?;
        Ok(())
    }

    fn resource_lease_path(&self, lease: &FmsResourceLease) -> Result<PathBuf> {
        Ok(checked_path(
            &self.root,
            &format!(
                "runs/{}/resource_leases/{}/{}.json",
                lease.run_id, lease.resource_id, lease.lease_token
            ),
        )?)
    }

    fn task_admission_path(
        &self,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
    ) -> Result<PathBuf> {
        for value in [run_id, task_id, attempt_id] {
            validate_store_id(value)?;
        }
        Ok(checked_path(
            &self.root,
            &format!("runs/{run_id}/task_admissions/{task_id}/{attempt_id}.json"),
        )?)
    }

    fn validate_resource_lease_owner_unlocked(&self, lease: &FmsResourceLease) -> Result<()> {
        let catalog = self
            .read_run_catalog(&lease.run_id)?
            .context("resource lease requires a durable run catalog")?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == lease.task_id)
            .context("resource lease task is missing from the run catalog")?;
        if task.attempt_id.as_deref() != Some(lease.attempt_id.as_str())
            || task.ownership_epoch != Some(lease.ownership_epoch)
        {
            anyhow::bail!("resource lease ownership does not match the run catalog");
        }
        if matches!(
            task.lifecycle,
            FmsTaskLifecycle::Succeeded
                | FmsTaskLifecycle::Failed
                | FmsTaskLifecycle::Cancelled
                | FmsTaskLifecycle::Interrupted
        ) {
            anyhow::bail!("terminal task cannot acquire or renew a resource lease");
        }
        Ok(())
    }

    fn find_active_resource_lease_unlocked(
        &self,
        resource_id: &str,
    ) -> Result<Option<FmsResourceLease>> {
        let runs = checked_path(&self.root, "runs")?;
        if !runs.exists() {
            return Ok(None);
        }
        let mut active = None;
        for run_entry in fs::read_dir(&runs)? {
            let run_entry = run_entry?;
            reject_link(&run_entry.path())?;
            if !run_entry.file_type()?.is_dir() {
                anyhow::bail!("unsupported runs entry `{}`", run_entry.path().display());
            }
            let run_id = run_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("non-UTF8 run identifier"))?;
            validate_store_id(&run_id)?;
            let resource_root = run_entry.path().join("resource_leases");
            if !resource_root.exists() {
                continue;
            }
            if !resource_root.is_dir() {
                anyhow::bail!("resource_leases path is not a directory");
            }
            let resource_dir = resource_root.join(resource_id);
            if !resource_dir.exists() {
                continue;
            }
            reject_link(&resource_dir)?;
            if !resource_dir.is_dir() {
                anyhow::bail!("resource lease identity path is not a directory");
            }
            for lease_entry in fs::read_dir(&resource_dir)? {
                let lease_entry = lease_entry?;
                reject_link(&lease_entry.path())?;
                if !lease_entry.file_type()?.is_file() {
                    anyhow::bail!("resource lease entry is not a file");
                }
                let data = fs::read(lease_entry.path())?;
                let lease: FmsResourceLease = serde_json::from_slice(&data)?;
                lease.validate()?;
                if lease.run_id != run_id || lease.resource_id != resource_id {
                    anyhow::bail!("resource lease path identity mismatch");
                }
                if lease.state == FmsResourceLeaseState::Active {
                    if active.is_some() {
                        anyhow::bail!(
                            "multiple active durable leases found for resource `{resource_id}`"
                        );
                    }
                    active = Some(lease);
                }
            }
        }
        Ok(active)
    }

    /// Create a run directory and persist a run manifest.
    pub fn commit_run(&self, manifest: &FmsRunManifest) -> Result<()> {
        validate_store_id(&manifest.run_id)?;
        let _lease = self.write_transaction()?;
        for reference in [
            &manifest.plan_ref,
            &manifest.live_state_ref,
            &manifest.latest_checkpoint_ref,
            &manifest.artifact_index_ref,
        ]
        .into_iter()
        .flatten()
        {
            if !reference.starts_with(&format!("runs/{}/", manifest.run_id)) {
                anyhow::bail!("run reference must belong to its run");
            }
            if !checked_path(&self.root, reference)?.is_file() {
                anyhow::bail!("run reference is missing: {reference}");
            }
        }
        if let Some(reference) = &manifest.latest_checkpoint_ref {
            let prefix = format!("runs/{}/checkpoints/", manifest.run_id);
            let id = reference
                .strip_prefix(&prefix)
                .and_then(|rest| rest.strip_suffix("/checkpoint.json"))
                .context("invalid latest checkpoint reference")?;
            self.read_checkpoint(&manifest.run_id, id)?
                .context("latest checkpoint is missing")?;
        }
        let relative = format!("runs/{}/run_manifest.json", manifest.run_id);
        let path = create_parent(&self.root, &relative)?;
        for child in ["checkpoints", "artifacts"] {
            fs::create_dir_all(checked_path(
                &self.root,
                &format!("runs/{}/{child}", manifest.run_id),
            )?)?;
        }
        let json = serde_json::to_vec_pretty(manifest)?;
        atomic_write(&path, &json)?;
        Ok(())
    }

    /// Read a run manifest.
    pub fn read_run(&self, run_id: &str) -> Result<Option<FmsRunManifest>> {
        validate_store_id(run_id)?;
        let path = checked_path(&self.root, &format!("runs/{run_id}/run_manifest.json"))?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let manifest: FmsRunManifest = serde_json::from_slice(&data)?;
        if manifest.run_id != run_id {
            anyhow::bail!("run manifest identity does not match its path");
        }
        Ok(Some(manifest))
    }

    // ── Checkpoints ────────────────────────────────────────────────────

    /// Persist a checkpoint manifest and its common state.
    pub fn commit_checkpoint(
        &self,
        checkpoint: &FmsCheckpoint,
        common_state: &CommonSolverState,
    ) -> Result<()> {
        validate_store_id(&checkpoint.run_id)?;
        validate_store_id(&checkpoint.checkpoint_id)?;
        let prefix = format!(
            "runs/{}/checkpoints/{}",
            checkpoint.run_id, checkpoint.checkpoint_id
        );
        if checkpoint.common_state_ref != format!("{prefix}/common_state.json") {
            anyhow::bail!("checkpoint common state must be owned by the checkpoint");
        }
        if checkpoint.step != common_state.step
            || checkpoint.time_s != common_state.time_s
            || checkpoint.dt != common_state.dt
        {
            anyhow::bail!("checkpoint/common-state identity mismatch");
        }
        let _lease = self.write_transaction()?;
        let path = create_parent(&self.root, &format!("{prefix}/checkpoint.json"))?;
        if path.exists() {
            anyhow::bail!("checkpoint is immutable; capture a new checkpoint ID");
        }
        // The state and all referenced payloads precede the commit marker.
        let state_json = serde_json::to_vec_pretty(common_state)?;
        atomic_write(
            &checked_path(&self.root, &checkpoint.common_state_ref)?,
            &state_json,
        )?;
        crate::reachability::walk_checkpoint(&self.root, checkpoint)?.require_complete()?;
        let cp_json = serde_json::to_vec_pretty(checkpoint)?;
        atomic_write(&path, &cp_json)?;
        Ok(())
    }

    /// Read the latest checkpoint for a run.
    pub fn latest_checkpoint(&self, run_id: &str) -> Result<Option<FmsCheckpoint>> {
        let checkpoints = self.list_checkpoints(run_id)?;
        Ok(checkpoints.into_iter().last())
    }

    /// Read committed checkpoints ordered by step and capture time.
    pub fn list_checkpoints(&self, run_id: &str) -> Result<Vec<FmsCheckpoint>> {
        validate_store_id(run_id)?;
        let cp_base = checked_path(&self.root, &format!("runs/{run_id}/checkpoints"))?;
        if !cp_base.exists() {
            return Ok(Vec::new());
        }
        let mut candidates = fs::read_dir(&cp_base)?.collect::<std::io::Result<Vec<_>>>()?;
        candidates.sort_by_key(|e| e.file_name());

        let mut checkpoints = Vec::new();
        for candidate in candidates {
            let id = candidate
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("invalid checkpoint directory"))?;
            if let Some(checkpoint) = self.read_checkpoint(run_id, &id)? {
                checkpoints.push(checkpoint);
            }
        }
        checkpoints.sort_by(|a, b| {
            a.step
                .cmp(&b.step)
                .then(a.created_at.cmp(&b.created_at))
                .then(a.checkpoint_id.cmp(&b.checkpoint_id))
        });
        Ok(checkpoints)
    }

    /// Read one checkpoint for a run.
    pub fn read_checkpoint(
        &self,
        run_id: &str,
        checkpoint_id: &str,
    ) -> Result<Option<FmsCheckpoint>> {
        validate_store_id(run_id)?;
        validate_store_id(checkpoint_id)?;
        let prefix = format!("runs/{run_id}/checkpoints/{checkpoint_id}");
        let path = checked_path(&self.root, &format!("{prefix}/checkpoint.json"))?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read(&path)?;
        let checkpoint: FmsCheckpoint = serde_json::from_slice(&data)?;
        if checkpoint.run_id != run_id
            || checkpoint.checkpoint_id != checkpoint_id
            || checkpoint.common_state_ref != format!("{prefix}/common_state.json")
        {
            anyhow::bail!("checkpoint path/content identity mismatch");
        }
        let state_bytes = self
            .read_document(&checkpoint.common_state_ref)?
            .context("checkpoint common state is missing")?;
        let state: CommonSolverState = serde_json::from_slice(&state_bytes)?;
        if state.step != checkpoint.step
            || state.time_s != checkpoint.time_s
            || state.dt != checkpoint.dt
        {
            anyhow::bail!("checkpoint/common-state identity mismatch");
        }
        crate::reachability::walk_checkpoint(&self.root, &checkpoint)?.require_complete()?;
        Ok(Some(checkpoint))
    }

    // ── Tensor storage ─────────────────────────────────────────────────

    /// Store a magnetization vector `Vec<[f64; 3]>` and return the CAS hash.
    pub fn store_magnetization(&self, m: &[[f64; 3]]) -> Result<String> {
        let bytes = magnetization_to_bytes(m);
        self.cas.put(&bytes)
    }

    /// Load magnetization from CAS by hash.
    pub fn load_magnetization(&self, hash: &str) -> Result<Option<Vec<[f64; 3]>>> {
        match self.cas.get(hash)? {
            Some(bytes) => {
                if bytes.len() % 24 != 0 {
                    anyhow::bail!("truncated f64 magnetization payload");
                }
                Ok(Some(magnetization_from_bytes(&bytes)))
            }
            None => Ok(None),
        }
    }

    /// Store arbitrary bytes in CAS.
    pub fn store_blob(&self, data: &[u8]) -> Result<String> {
        self.cas.put(data)
    }

    // ── JSON documents ─────────────────────────────────────────────────

    /// Write a project document. Control records use validated dedicated writers.
    pub fn write_document(&self, relative_path: &str, data: &[u8]) -> Result<()> {
        if !relative_path.starts_with("project/") {
            anyhow::bail!("public document writes must stay within project/");
        }
        self.write_import_document(relative_path, data)
    }

    /// Internal import adapter; only call after validating the complete archive.
    pub(crate) fn write_import_document(&self, relative_path: &str, data: &[u8]) -> Result<()> {
        validate_document_namespace(relative_path)?;
        let _lease = self.write_transaction()?;
        let components: Vec<_> = relative_path.split('/').collect();
        if components.len() >= 5 && components[0] == "runs" && components[2] == "checkpoints" {
            validate_store_id(components[1])?;
            validate_store_id(components[3])?;
            let marker = format!(
                "runs/{}/checkpoints/{}/checkpoint.json",
                components[1], components[3]
            );
            if checked_path(&self.root, &marker)?.exists() {
                anyhow::bail!("committed checkpoint documents are immutable");
            }
        }
        let path = create_parent(&self.root, relative_path)?;
        atomic_write(&path, data)
    }

    pub(crate) fn write_checkpoint_payload(
        &self,
        checkpoint: &FmsCheckpoint,
        name: &str,
        data: &[u8],
    ) -> Result<()> {
        validate_store_id(&checkpoint.run_id)?;
        validate_store_id(&checkpoint.checkpoint_id)?;
        if !matches!(
            name,
            "backend_state.json" | "integrator_state.json" | "rng_state.json"
        ) {
            anyhow::bail!("unsupported checkpoint payload document");
        }
        self.write_import_document(
            &format!(
                "runs/{}/checkpoints/{}/{name}",
                checkpoint.run_id, checkpoint.checkpoint_id
            ),
            data,
        )
    }

    /// Read a JSON document relative to the store root.
    pub fn read_document(&self, relative_path: &str) -> Result<Option<Vec<u8>>> {
        let path = checked_path(&self.root, relative_path)?;
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(fs::read(&path)?))
    }

    /// Snapshot portable project files, preserving scripts, UI, assets and unknown documents.
    pub fn project_documents(&self) -> Result<std::collections::HashMap<String, Vec<u8>>> {
        let _lease = self.write_transaction()?;
        fn visit(
            store: &SessionStore,
            relative: &str,
            output: &mut std::collections::HashMap<String, Vec<u8>>,
        ) -> Result<()> {
            let path = checked_path(store.root(), relative)?;
            if !path.exists() {
                return Ok(());
            }
            if path.is_dir() {
                for entry in fs::read_dir(path)? {
                    let name = entry?
                        .file_name()
                        .into_string()
                        .map_err(|_| anyhow::anyhow!("non-UTF8 project path"))?;
                    visit(store, &format!("{relative}/{name}"), output)?;
                }
            } else if path.is_file() {
                output.insert(relative.to_owned(), fs::read(path)?);
            } else {
                anyhow::bail!("unsupported project document");
            }
            Ok(())
        }
        let mut output = std::collections::HashMap::new();
        visit(self, "project", &mut output)?;
        Ok(output)
    }

    // ── Recovery ───────────────────────────────────────────────────────

    /// Write a crash-recovery snapshot.
    pub fn write_recovery(&self, session: &FmsSessionManifest) -> Result<()> {
        validate_store_id(&session.session_id)?;
        if session.format != "fullmag.session.v1" {
            anyhow::bail!("unsupported recovery schema");
        }
        let _lease = self.write_transaction()?;
        let data = serde_json::to_vec_pretty(session)?;
        let path = create_parent(&self.root, &format!("recovery/{}.json", session.session_id))?;
        atomic_write(&path, &data)
    }

    /// List available recovery snapshots.
    pub fn list_recovery(&self) -> Result<Vec<FmsSessionManifest>> {
        let dir = checked_path(&self.root, "recovery")?;
        let mut result = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                if entry.path().extension().and_then(|e| e.to_str()) == Some("json") {
                    reject_link(&entry.path())?;
                    let data = fs::read(entry.path())?;
                    let manifest: FmsSessionManifest = serde_json::from_slice(&data)?;
                    validate_store_id(&manifest.session_id)?;
                    if manifest.format != "fullmag.session.v1" {
                        anyhow::bail!("unknown recovery schema");
                    }
                    result.push(manifest);
                }
            }
        }
        result.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
        Ok(result)
    }

    /// Read only the recovery snapshot owned by the requested session.
    pub fn read_session_recovery(&self, session_id: &str) -> Result<Option<FmsSessionManifest>> {
        validate_store_id(session_id)?;
        let path = checked_path(&self.root, &format!("recovery/{session_id}.json"))?;
        let data = match fs::read(&path) {
            Ok(data) => data,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let manifest: FmsSessionManifest = serde_json::from_slice(&data)?;
        if manifest.session_id != session_id || manifest.format != "fullmag.session.v1" {
            anyhow::bail!("recovery snapshot identity or schema mismatch");
        }
        Ok(Some(manifest))
    }

    /// Remove one validated snapshot under the writer lease; return the actual count.
    pub fn clear_session_recovery(&self, session_id: &str) -> Result<usize> {
        let _lease = self.write_transaction()?;
        if self.read_session_recovery(session_id)?.is_none() {
            return Ok(0);
        }
        let path = checked_path(&self.root, &format!("recovery/{session_id}.json"))?;
        fs::remove_file(&path)?;
        sync_directory(path.parent().expect("recovery snapshot has a parent"))?;
        Ok(1)
    }

    /// Clear recovery snapshots.
    pub fn clear_recovery(&self) -> Result<()> {
        let _lease = self.write_transaction()?;
        let dir = checked_path(&self.root, "recovery")?;
        if dir.exists() {
            for entry in fs::read_dir(&dir)? {
                let entry = entry?;
                reject_link(&entry.path())?;
                fs::remove_file(entry.path())?;
            }
        }
        sync_directory(&dir)
    }

    // ── File lock ──────────────────────────────────────────────────────

    /// Attempt to acquire the workspace lock.
    pub fn try_lock(&self, session_id: &str) -> Result<bool> {
        validate_store_id(session_id)?;
        let mut slot = self
            .explicit_lease
            .lock()
            .map_err(|_| anyhow::anyhow!("lease mutex poisoned"))?;
        if slot.is_some() {
            return Ok(false);
        }
        match self.write_transaction() {
            Ok(lease) => {
                *slot = Some(lease);
                Ok(true)
            }
            Err(error) if error.to_string().contains("writer is busy") => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Release the workspace lock.
    pub fn unlock(&self) -> Result<()> {
        let mut slot = self
            .explicit_lease
            .lock()
            .map_err(|_| anyhow::anyhow!("lease mutex poisoned"))?;
        let lease = slot
            .take()
            .context("this store does not own an explicit writer lease")?;
        drop(lease);
        Ok(())
    }

    // ── GC ─────────────────────────────────────────────────────────────

    /// Collect object hashes referenced by all known checkpoints.
    pub fn collect_live_refs(&self) -> Result<HashSet<String>> {
        let _lease = self.write_transaction()?;
        let report = crate::reachability::walk_store_root(
            &self.root,
            crate::reachability::ReachabilityMode::Gc,
        )?;
        if !report.complete {
            anyhow::bail!("incomplete reference graph; GC blocked");
        }
        let mut refs = report.object_refs;
        refs.extend(self.cas.pinned_refs()?);
        Ok(refs)
    }

    /// Compatibility entry point: preview only, never an implicit apply.
    pub fn gc(&self) -> Result<usize> {
        Ok(self.gc_preview()?.candidates.len())
    }

    /// Produce a reviewable preview without deleting objects.
    pub fn gc_preview(&self) -> Result<GcPlan> {
        let _lease = self.write_transaction()?;
        let live = self.collect_live_refs()?;
        let mut candidates = Vec::new();
        for hash in self.cas.list()? {
            if !live.contains(&hash) {
                self.cas.get(&hash)?.context("CAS candidate disappeared")?;
                candidates.push(hash);
            }
        }
        candidates.sort();
        Ok(GcPlan {
            schema: "fullmag.gc-plan.v1".into(),
            root: self.root.clone(),
            generation: repository_generation(&self.root)?,
            candidates,
        })
    }

    /// Re-mark under the same exclusive lease immediately before any sweep.
    pub fn gc_apply(&self, scope: &Path, plan: &GcPlan) -> Result<usize> {
        let _lease = self.write_transaction()?;
        if fs::canonicalize(scope)? != self.root
            || plan.root != self.root
            || plan.schema != "fullmag.gc-plan.v1"
        {
            anyhow::bail!("GC scope does not match the reviewed plan");
        }
        let fresh = self.gc_preview()?;
        if &fresh != plan {
            anyhow::bail!("GC generation changed; produce and review a new preview");
        }
        for hash in &fresh.candidates {
            self.cas.remove_verified(hash)?;
        }
        Ok(fresh.candidates.len())
    }

    /// Retire pins backed by immutable checkpoint roots. Mutable recovery/run
    /// records alone cannot retire another in-flight ingest's hash pin.
    pub fn release_published_pins(&self) -> Result<()> {
        let _lease = self.write_transaction()?;
        let graph = crate::reachability::walk_store_root(
            &self.root,
            crate::reachability::ReachabilityMode::Gc,
        )?;
        if !graph.complete {
            anyhow::bail!("incomplete reference graph; retain pins");
        }
        let mut permanent = HashSet::new();
        for reference in &graph.file_refs {
            if !reference.ends_with("/checkpoint.json") {
                continue;
            }
            let parts: Vec<_> = reference.split('/').collect();
            if parts.len() != 5 || parts[0] != "runs" || parts[2] != "checkpoints" {
                continue;
            }
            let checkpoint = self
                .read_checkpoint(parts[1], parts[3])?
                .context("checkpoint disappeared under lease")?;
            permanent
                .extend(crate::reachability::walk_checkpoint(&self.root, &checkpoint)?.object_refs);
        }
        self.cas.release_referenced_pins(&permanent)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct GcPlan {
    pub schema: String,
    pub root: PathBuf,
    pub generation: String,
    pub candidates: Vec<String>,
}

fn repository_generation(root: &Path) -> Result<String> {
    fn visit(root: &Path, path: &Path, entries: &mut Vec<(String, String)>) -> Result<()> {
        reject_link(path)?;
        let mut children = fs::read_dir(path)?.collect::<std::io::Result<Vec<_>>>()?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            let relative = path
                .strip_prefix(root)?
                .to_str()
                .context("non-UTF8 repository path")?
                .replace('\\', "/");
            if matches!(relative.as_str(), "WRITER.lock" | "WRITER.owner.json") {
                continue;
            }
            reject_link(&path)?;
            if child.file_type()?.is_dir() {
                visit(root, &path, entries)?;
            } else if child.file_type()?.is_file() {
                entries.push((relative, crate::cas::hex_sha256(&fs::read(path)?)));
            } else {
                anyhow::bail!("unsupported repository entry");
            }
        }
        Ok(())
    }
    let mut entries = Vec::new();
    visit(root, root, &mut entries)?;
    Ok(crate::cas::hex_sha256(&serde_json::to_vec(&entries)?))
}

fn validate_session_references(root: &Path, manifest: &FmsSessionManifest) -> Result<()> {
    if manifest.workspace_ref != "manifest/workspace.json"
        || manifest.export_profile_ref != "manifest/export_profile.json"
    {
        anyhow::bail!("unsupported session workspace or export profile reference");
    }
    let mut seen = HashSet::new();
    for reference in &manifest.run_refs {
        let id = reference
            .strip_prefix("runs/")
            .and_then(|rest| rest.strip_suffix("/run_manifest.json"))
            .context("invalid session run reference")?;
        validate_store_id(id)?;
        if !seen.insert(id) {
            anyhow::bail!("duplicate session run reference");
        }
        let path = checked_path(root, reference)?;
        let run: FmsRunManifest =
            serde_json::from_slice(&fs::read(path).context("session references a missing run")?)?;
        if run.run_id != id {
            anyhow::bail!("session run reference identity mismatch");
        }
    }
    Ok(())
}

fn validate_document_namespace(relative: &str) -> Result<()> {
    crate::repository_path::validate_relative_path(relative)?;
    if !matches!(
        relative.split('/').next(),
        Some("project" | "manifest" | "runs" | "recovery")
    ) {
        anyhow::bail!("document writer cannot modify repository control files or CAS");
    }
    Ok(())
}

// ── Helpers ────────────────────────────────────────────────────────────

/// Serialize magnetization to little-endian f64 bytes.
fn magnetization_to_bytes(m: &[[f64; 3]]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(m.len() * 3 * 8);
    for cell in m {
        for component in cell {
            buf.extend_from_slice(&component.to_le_bytes());
        }
    }
    buf
}

/// Deserialize magnetization from little-endian f64 bytes.
fn magnetization_from_bytes(data: &[u8]) -> Vec<[f64; 3]> {
    let n = data.len() / 24; // 3 components * 8 bytes each
    let mut m = Vec::with_capacity(n);
    for i in 0..n {
        let off = i * 24;
        let mx = f64::from_le_bytes(data[off..off + 8].try_into().unwrap());
        let my = f64::from_le_bytes(data[off + 8..off + 16].try_into().unwrap());
        let mz = f64::from_le_bytes(data[off + 16..off + 24].try_into().unwrap());
        m.push([mx, my, mz]);
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_resource_lease(
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        epoch: u64,
        resource_id: &str,
        token: &str,
        now: chrono::DateTime<chrono::Utc>,
    ) -> FmsResourceLease {
        FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: resource_id.into(),
            kind: if resource_id.starts_with("gpu") {
                FmsResourceKind::Gpu
            } else {
                FmsResourceKind::Cpu
            },
            budget: FmsResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1,
                gpu_memory_bytes: if resource_id.starts_with("gpu") { 1 } else { 0 },
                storage_bytes: 1,
            },
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            ownership_epoch: epoch,
            lease_token: token.into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
        }
    }

    #[test]
    fn reconcile_requires_writer_lease_even_when_catalog_needs_no_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("store");
        let store = SessionStore::open(&root).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-reconcile-lock".into(),
                revision: 1,
                updated_at: now,
                tasks: Vec::new(),
            })
            .unwrap();

        let competing_store = SessionStore::open(&root).unwrap();
        let _lease = store.write_transaction().unwrap();

        let error = competing_store
            .reconcile_run_catalog("run-reconcile-lock")
            .unwrap_err();
        assert!(error.to_string().contains("writer is busy"));
    }

    #[test]
    fn durable_run_intent_replays_original_run_and_rejects_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let first = FmsRunIntent::new(
            "run-1",
            "submit-1",
            serde_json::json!({"run_id": "run-1", "snapshot": "sha-1"}),
        );
        assert_eq!(
            store.commit_run_intent(&first).unwrap(),
            RunIntentCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_run_intent(&first).unwrap(),
            RunIntentCommitDisposition::Replayed {
                run_id: "run-1".into()
            }
        );
        assert_eq!(
            store.find_run_intent("submit-1").unwrap(),
            Some(first.clone())
        );
        assert_eq!(store.list_run_intents().unwrap(), vec![first]);

        let changed = FmsRunIntent::new(
            "run-2",
            "submit-1",
            serde_json::json!({"run_id": "run-2", "snapshot": "sha-2"}),
        );
        assert!(store.commit_run_intent(&changed).is_err());
        assert!(store.read_run_intent("run-2").unwrap().is_none());

        let mismatched =
            FmsRunIntent::new("run-3", "submit-3", serde_json::json!({"run_id": "run-4"}));
        assert!(store.commit_run_intent(&mismatched).is_err());
        assert!(store.read_run_intent("run-3").unwrap().is_none());

        let mut missing_definition = FmsRunIntent::new(
            "run-5",
            "submit-5",
            serde_json::json!({
                "run_id": "run-5",
                "snapshot": {"definition_sha256": "b".repeat(64)}
            }),
        );
        missing_definition.definition_object_ref = Some("b".repeat(64));
        assert!(store.commit_run_intent(&missing_definition).is_err());
        assert!(store.read_run_intent("run-5").unwrap().is_none());

        let mut missing_study = FmsRunIntent::new(
            "run-6",
            "submit-6",
            serde_json::json!({
                "run_id": "run-6",
                "study": {"plan_sha256": "c".repeat(64)}
            }),
        );
        missing_study.study_object_ref = Some("c".repeat(64));
        assert!(store.commit_run_intent(&missing_study).is_err());
        assert!(store.read_run_intent("run-6").unwrap().is_none());

        let mut missing_asset = FmsRunIntent::new(
            "run-7",
            "submit-7",
            serde_json::json!({
                "run_id": "run-7",
                "immutable_assets": [{"asset_id": "asset-1", "content_sha256": "d".repeat(64)}]
            }),
        );
        missing_asset
            .asset_object_refs
            .insert("asset-1".into(), "d".repeat(64));
        assert!(store.commit_run_intent(&missing_asset).is_err());
        assert!(store.read_run_intent("run-7").unwrap().is_none());
    }

    #[test]
    fn interrupted_checkpoint_never_publishes_a_marker() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let cp = FmsCheckpoint::new("run-1", 1, 0.0, 1e-12);
        let state = CommonSolverState {
            step: 1,
            time_s: 0.0,
            dt: 1e-12,
            energies: SolverEnergies::default(),
            magnetization_ref: None,
        };
        crate::durability::fail_publication_after(1);
        assert!(store.commit_checkpoint(&cp, &state).is_err());
        assert!(store.read_document(&cp.common_state_ref).unwrap().is_some());
        assert!(store.latest_checkpoint("run-1").unwrap().is_none());
        store.commit_checkpoint(&cp, &state).unwrap();
        assert_eq!(store.latest_checkpoint("run-1").unwrap().unwrap().step, 1);
    }

    #[test]
    fn interrupted_session_pointer_preserves_previous_generation() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("store")).unwrap();
        let first = FmsSessionManifest::new("one", "first", SaveProfile::Compact);
        store.commit_session(&first).unwrap();
        crate::durability::fail_publication_after(1);
        let second = FmsSessionManifest::new("two", "candidate", SaveProfile::Compact);
        assert!(store.commit_session(&second).is_err());
        assert_eq!(store.current_session().unwrap().unwrap().session_id, "one");
    }

    #[test]
    fn magnetization_round_trip() {
        let m = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let bytes = magnetization_to_bytes(&m);
        let m2 = magnetization_from_bytes(&bytes);
        assert_eq!(m, m2);
    }

    #[test]
    fn session_store_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();

        // No current session initially.
        assert!(store.current_session().unwrap().is_none());

        // Create and commit a session.
        let manifest = FmsSessionManifest::new("test-001", "Test Session", SaveProfile::Compact);
        store.commit_session(&manifest).unwrap();

        let loaded = store.current_session().unwrap().unwrap();
        assert_eq!(loaded.session_id, "test-001");
        assert_eq!(loaded.profile, SaveProfile::Compact);
    }

    #[test]
    fn preparation_receipt_is_bound_to_run_and_immutable() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-preparation";
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: Vec::new(),
            })
            .unwrap();

        let plan_fingerprint = format!("sha256:{}", "a".repeat(64));
        let payload = serde_json::json!({
            "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
            "preparation_id": "prep-1",
            "plan_fingerprint": plan_fingerprint,
            "certificates": []
        });
        let receipt = FmsPreparationReceipt::new(
            "prep-1",
            run_id,
            format!("sha256:{}", "a".repeat(64)),
            payload,
        );
        assert_eq!(
            store.commit_preparation_receipt(&receipt).unwrap(),
            PreparationReceiptCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_preparation_receipt(&receipt).unwrap(),
            PreparationReceiptCommitDisposition::Replayed
        );
        let replay_with_new_publication_timestamp = FmsPreparationReceipt::new(
            "prep-1",
            run_id,
            format!("sha256:{}", "a".repeat(64)),
            serde_json::json!({
                "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
                "preparation_id": "prep-1",
                "plan_fingerprint": format!("sha256:{}", "a".repeat(64)),
                "certificates": []
            }),
        );
        assert_eq!(
            store
                .commit_preparation_receipt(&replay_with_new_publication_timestamp)
                .unwrap(),
            PreparationReceiptCommitDisposition::Replayed
        );
        assert_eq!(
            store.read_preparation_receipt(run_id).unwrap().unwrap(),
            receipt
        );

        let replacement = FmsPreparationReceipt::new(
            "prep-1",
            run_id,
            format!("sha256:{}", "a".repeat(64)),
            serde_json::json!({
                "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
                "preparation_id": "prep-1",
                "plan_fingerprint": format!("sha256:{}", "a".repeat(64)),
                "certificates": ["different"]
            }),
        );
        let error = store.commit_preparation_receipt(&replacement).unwrap_err();
        assert!(error.to_string().contains("immutable"));
    }

    #[test]
    fn task_preparation_receipt_is_scoped_immutable_and_replayable() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-task-preparation";
        let step_id = "step:relax";
        let task_id = task_id_for_study_step(run_id, step_id).unwrap();
        let intent = FmsRunIntent::new(
            run_id,
            "submit-task-preparation",
            serde_json::json!({"run_id": run_id, "snapshot": "accepted"}),
        );
        let specification_fingerprint =
            format!("sha256:{}", canonical_json_sha256(&intent.specification));
        store.commit_run_intent(&intent).unwrap();
        let input_fingerprint = "b".repeat(64);
        let plan_fingerprint = format!("sha256:{}", "a".repeat(64));
        let problem_fingerprint = format!("sha256:{}", "c".repeat(64));
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: chrono::Utc::now(),
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: task_id.clone(),
                    input_fingerprint: input_fingerprint.clone(),
                    lifecycle: FmsTaskLifecycle::Accepted,
                    readiness: FmsTaskReadiness::Blocked {
                        reason: "awaiting dependencies".into(),
                    },
                    observation: None,
                    attempt_id: None,
                    ownership_epoch: None,
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();

        let payload = accepted_task_preparation_payload(
            run_id,
            step_id,
            &format!("prep-{task_id}"),
            &plan_fingerprint,
            &problem_fingerprint,
            &specification_fingerprint,
        );
        let receipt = FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            input_fingerprint.clone(),
            format!("prep-{task_id}"),
            plan_fingerprint.clone(),
            payload,
        )
        .unwrap();
        assert_eq!(
            store.commit_task_preparation_receipt(&receipt).unwrap(),
            PreparationReceiptCommitDisposition::Accepted
        );
        let replay = FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            input_fingerprint.clone(),
            format!("prep-{task_id}"),
            plan_fingerprint.clone(),
            accepted_task_preparation_payload(
                run_id,
                step_id,
                &format!("prep-{task_id}"),
                &plan_fingerprint,
                &problem_fingerprint,
                &specification_fingerprint,
            ),
        )
        .unwrap();
        assert_eq!(
            store.commit_task_preparation_receipt(&replay).unwrap(),
            PreparationReceiptCommitDisposition::Replayed
        );
        assert_eq!(
            store
                .read_task_preparation_receipt(run_id, &task_id)
                .unwrap()
                .unwrap(),
            receipt
        );

        let mut replacement_payload = accepted_task_preparation_payload(
            run_id,
            step_id,
            &format!("prep-{task_id}"),
            &plan_fingerprint,
            &problem_fingerprint,
            &specification_fingerprint,
        );
        replacement_payload["certificates"] = serde_json::json!(["different"]);
        let replacement = FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            input_fingerprint.clone(),
            format!("prep-{task_id}"),
            plan_fingerprint.clone(),
            replacement_payload,
        )
        .unwrap();
        assert!(store
            .commit_task_preparation_receipt(&replacement)
            .unwrap_err()
            .to_string()
            .contains("immutable"));

        let replacement_payload = serde_json::json!({
            "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
            "preparation_id": format!("prep-{task_id}"),
            "plan_fingerprint": plan_fingerprint,
            "plan": {
                "schema_version": "preparation_plan.v2",
                "problem_fingerprint": problem_fingerprint,
                "source": {
                    "kind": "accepted_run_step",
                    "run_id": run_id,
                    "specification_fingerprint": specification_fingerprint,
                    "step_id": step_id
                }
            },
            "accepted_run_source": {
                "schema_version": "accepted_run_preparation_source.v1",
                "run_id": run_id,
                "specification_fingerprint": specification_fingerprint,
                "step_id": step_id,
                "problem_fingerprint": "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
            },
            "certificates": []
        });
        assert!(FmsTaskPreparationReceipt::new(
            run_id,
            step_id,
            input_fingerprint,
            format!("prep-{task_id}"),
            receipt.plan_fingerprint.clone(),
            replacement_payload,
        )
        .is_err());
    }

    fn accepted_task_preparation_payload(
        run_id: &str,
        step_id: &str,
        preparation_id: &str,
        plan_fingerprint: &str,
        problem_fingerprint: &str,
        specification_fingerprint: &str,
    ) -> serde_json::Value {
        serde_json::json!({
            "schema_version": FMS_PREPARATION_RECEIPT_SCHEMA,
            "preparation_id": preparation_id,
            "plan_fingerprint": plan_fingerprint,
            "plan": {
                "schema_version": "preparation_plan.v2",
                "problem_fingerprint": problem_fingerprint,
                "source": {
                    "kind": "accepted_run_step",
                    "run_id": run_id,
                    "specification_fingerprint": specification_fingerprint,
                    "step_id": step_id
                }
            },
            "accepted_run_source": {
                "schema_version": "accepted_run_preparation_source.v1",
                "run_id": run_id,
                "specification_fingerprint": specification_fingerprint,
                "step_id": step_id,
                "problem_fingerprint": problem_fingerprint
            },
            "certificates": []
        })
    }

    #[test]
    fn checkpoint_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();

        let run = FmsRunManifest {
            run_id: "run-001".into(),
            status: RunStatus::Running,
            study_kind: "time_evolution".into(),
            backend: "cpu".into(),
            precision: "f64".into(),
            started_at: chrono::Utc::now(),
            finished_at: None,
            total_steps: 0,
            total_time_s: 0.0,
            plan_ref: None,
            live_state_ref: None,
            latest_checkpoint_ref: None,
            artifact_index_ref: None,
        };
        store.commit_run(&run).unwrap();

        // Store magnetization and create checkpoint.
        let m = vec![[1.0, 0.0, 0.0]; 100];
        let m_hash = store.store_magnetization(&m).unwrap();

        let cp = FmsCheckpoint::new("run-001", 42, 1e-9, 1e-13);
        let state = CommonSolverState {
            step: 42,
            time_s: 1e-9,
            dt: 1e-13,
            energies: SolverEnergies::default(),
            magnetization_ref: Some(m_hash.clone()),
        };
        store.commit_checkpoint(&cp, &state).unwrap();

        let latest = store.latest_checkpoint("run-001").unwrap().unwrap();
        assert_eq!(latest.step, 42);

        // Load magnetization back.
        let loaded_m = store.load_magnetization(&m_hash).unwrap().unwrap();
        assert_eq!(loaded_m.len(), 100);
        assert_eq!(loaded_m[0], [1.0, 0.0, 0.0]);
    }

    #[test]
    fn durable_resource_lease_is_fenced_and_explicitly_released() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-lease".into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: "task-lease".into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Running,
                    readiness: FmsTaskReadiness::Ready,
                    observation: Some(FmsObservationState::Live),
                    attempt_id: Some("attempt-lease".into()),
                    ownership_epoch: Some(1),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: Some("gpu-0".into()),
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();

        let lease = FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "gpu-0".into(),
            kind: FmsResourceKind::Gpu,
            budget: FmsResourceBudget {
                cpu_millis: 100,
                memory_bytes: 1,
                gpu_memory_bytes: 1,
                storage_bytes: 1,
            },
            run_id: "run-lease".into(),
            task_id: "task-lease".into(),
            attempt_id: "attempt-lease".into(),
            ownership_epoch: 1,
            lease_token: "lease-one".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
        };
        assert_eq!(
            store.commit_resource_lease(&lease).unwrap(),
            ResourceLeaseCommitDisposition::Acquired
        );
        assert_eq!(
            store.commit_resource_lease(&lease).unwrap(),
            ResourceLeaseCommitDisposition::Replayed
        );

        let mut heartbeat = lease.clone();
        heartbeat.heartbeat_sequence = 1;
        heartbeat.heartbeat_at = chrono::Utc::now();
        store.heartbeat_resource_lease(&heartbeat).unwrap();
        assert!(store.heartbeat_resource_lease(&lease).is_err());

        store.release_resource_lease(&heartbeat).unwrap();
        let mut next = lease;
        next.lease_token = "lease-two".into();
        next.acquired_at = chrono::Utc::now();
        next.heartbeat_at = next.acquired_at;
        assert_eq!(
            store.commit_resource_lease(&next).unwrap(),
            ResourceLeaseCommitDisposition::Acquired
        );
    }

    #[test]
    fn durable_retry_decision_is_fenced_and_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-retry".into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: "task-retry".into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Failed,
                    readiness: FmsTaskReadiness::Ready,
                    observation: Some(FmsObservationState::Reconciling),
                    attempt_id: Some("attempt-retry".into()),
                    ownership_epoch: Some(3),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let decision = FmsRetryDecision {
            schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
            decision_id: "decision-retry".into(),
            run_id: "run-retry".into(),
            task_id: "task-retry".into(),
            attempt_id: "attempt-retry".into(),
            ownership_epoch: 3,
            trigger: FmsRetryTrigger::WorkerDisconnected,
            action: FmsRetryAction::Retry,
            reason: "worker disconnected after reconciliation".into(),
            created_at: now,
        };
        assert_eq!(
            store.commit_retry_decision(&decision).unwrap(),
            RetryDecisionCommitDisposition::Accepted
        );
        assert_eq!(
            store.commit_retry_decision(&decision).unwrap(),
            RetryDecisionCommitDisposition::Replayed
        );
        let loaded = store
            .read_retry_decision("run-retry", "decision-retry")
            .unwrap()
            .unwrap();
        assert_eq!(loaded, decision);
        assert_eq!(
            store.list_retry_decisions("run-retry").unwrap(),
            vec![decision.clone()]
        );
        let mut stale = decision.clone();
        stale.decision_id = "decision-stale".into();
        stale.ownership_epoch = 2;
        assert!(store.commit_retry_decision(&stale).is_err());
    }

    #[test]
    fn artifact_catalog_retains_prior_attempts_and_rejects_late_study_output() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-artifact-retry";
        let step_id = "relax";
        let task_id = task_id_for_study_step(run_id, step_id).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: task_id.clone(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Failed,
                    readiness: FmsTaskReadiness::Ready,
                    observation: Some(FmsObservationState::Reconciling),
                    attempt_id: Some("attempt-one".into()),
                    ownership_epoch: Some(1),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();

        let old_bytes = b"failed-attempt diagnostic";
        let old_object = store.cas().put(old_bytes).unwrap();
        let old_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-old-log".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: format!("outputs/{task_id}/attempt-one/worker.log"),
            artifact_type: "log".into(),
            content_sha256: old_object.clone(),
            object_ref: Some(old_object),
            status: FmsArtifactStatus::Published,
            required: false,
            study_output: None,
        };
        store
            .commit_artifact_catalog(&FmsArtifactCatalog {
                schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 1,
                updated_at: now,
                entries: vec![old_entry.clone()],
            })
            .unwrap();

        let premature_output = FmsArtifactCatalogEntry {
            artifact_id: "artifact-premature-output".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: format!("outputs/{task_id}/attempt-one/state/default.bin"),
            artifact_type: "state".into(),
            content_sha256: old_entry.content_sha256.clone(),
            object_ref: old_entry.object_ref.clone(),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "final_state".into(),
                case_id: "default".into(),
            }),
        };
        assert!(store
            .commit_artifact_catalog(&FmsArtifactCatalog {
                schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
                run_id: run_id.into(),
                revision: 2,
                updated_at: chrono::Utc::now(),
                entries: vec![old_entry.clone(), premature_output],
            })
            .is_err());

        let retry = FmsRetryDecision {
            schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
            decision_id: "decision-artifact-retry".into(),
            run_id: run_id.into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            trigger: FmsRetryTrigger::WorkerDisconnected,
            action: FmsRetryAction::Retry,
            reason: "worker disconnected after reconciliation".into(),
            created_at: chrono::Utc::now(),
        };
        assert_eq!(
            store.apply_retry_decision(&retry).unwrap(),
            RetryDecisionApplyDisposition::Applied
        );
        let mut run_catalog = store.read_run_catalog(run_id).unwrap().unwrap();
        run_catalog.tasks[0].attempt_id = Some("attempt-two".into());
        run_catalog.tasks[0].ownership_epoch = Some(2);
        run_catalog.tasks[0].lifecycle = FmsTaskLifecycle::Succeeded;
        run_catalog.revision += 1;
        run_catalog.updated_at = chrono::Utc::now();
        store.commit_run_catalog(&run_catalog).unwrap();

        let output_bytes = b"successful final state";
        let output_object = store.cas().put(output_bytes).unwrap();
        let output_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-final-state-attempt-two".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-two".into(),
            ownership_epoch: 2,
            logical_path: format!("outputs/{task_id}/attempt-two/state/default.bin"),
            artifact_type: "state".into(),
            content_sha256: output_object.clone(),
            object_ref: Some(output_object),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "final_state".into(),
                case_id: "default".into(),
            }),
        };
        let complete_catalog = FmsArtifactCatalog {
            schema_version: FMS_ARTIFACT_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 2,
            updated_at: chrono::Utc::now(),
            entries: vec![old_entry.clone(), output_entry.clone()],
        };
        store.commit_artifact_catalog(&complete_catalog).unwrap();
        assert_eq!(
            store
                .read_artifact_catalog(run_id)
                .unwrap()
                .unwrap()
                .entries,
            vec![old_entry.clone(), output_entry]
        );

        let stale_bytes = b"late stale output";
        let stale_object = store.cas().put(stale_bytes).unwrap();
        let stale_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-late-output".into(),
            task_id,
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: "outputs/late/stale.bin".into(),
            artifact_type: "state".into(),
            content_sha256: stale_object.clone(),
            object_ref: Some(stale_object),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "stale_state".into(),
                case_id: "late".into(),
            }),
        };
        let mut stale_catalog = complete_catalog;
        stale_catalog.revision += 1;
        stale_catalog.updated_at = chrono::Utc::now();
        stale_catalog.entries.push(stale_entry);
        assert!(store.commit_artifact_catalog(&stale_catalog).is_err());
        let persisted = store.read_artifact_catalog(run_id).unwrap().unwrap();
        assert_eq!(persisted.revision, 2);
        assert_eq!(persisted.entries.len(), 2);
    }

    #[test]
    fn claimed_artifact_append_is_idempotent_and_rejects_released_lease() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let run_id = "run-claimed-artifact";
        let step_id = "relax";
        let task_id = task_id_for_study_step(run_id, step_id).unwrap();
        let now = chrono::Utc::now();
        let mut run_catalog = FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: run_id.into(),
            revision: 1,
            updated_at: now,
            tasks: vec![FmsTaskCatalogEntry {
                task_id: task_id.clone(),
                input_fingerprint: "a".repeat(64),
                lifecycle: FmsTaskLifecycle::Running,
                readiness: FmsTaskReadiness::Ready,
                observation: Some(FmsObservationState::Live),
                attempt_id: Some("attempt-one".into()),
                ownership_epoch: Some(1),
                resolved_input_fingerprint: None,
                artifact_ids: Vec::new(),
                resource_id: Some("cpu-artifact".into()),
                coordinator_watermark: None,
                coordinator_genesis: None,
            }],
        };
        store.commit_run_catalog(&run_catalog).unwrap();
        let lease = FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-artifact".into(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget {
                cpu_millis: 1_000,
                memory_bytes: 0,
                gpu_memory_bytes: 0,
                storage_bytes: 0,
            },
            run_id: run_id.into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            lease_token: "lease-artifact-output".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
        };
        store.commit_resource_lease(&lease).unwrap();
        let mut heartbeat_lease = lease.clone();
        heartbeat_lease.heartbeat_sequence = 1;
        heartbeat_lease.heartbeat_at = chrono::Utc::now();
        store.heartbeat_resource_lease(&heartbeat_lease).unwrap();

        let bytes = b"final state from the successful attempt";
        let object_ref = store.cas().put(bytes).unwrap();
        let entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-claimed-output".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: format!("outputs/{task_id}/attempt-one/final_state/default.bin"),
            artifact_type: "state".into(),
            content_sha256: object_ref.clone(),
            object_ref: Some(object_ref),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "final_state".into(),
                case_id: "default".into(),
            }),
        };
        let published = store
            .append_artifact_catalog_entries_for_lease(&lease, std::slice::from_ref(&entry))
            .unwrap();
        assert_eq!(published.revision, 1);
        assert_eq!(published.entries, vec![entry.clone()]);
        let projected_task = store
            .read_run_catalog(run_id)
            .unwrap()
            .unwrap()
            .tasks
            .remove(0);
        assert_eq!(projected_task.artifact_ids, vec![entry.artifact_id.clone()]);

        let manifest = FmsStudyOutputManifest {
            schema_version: FMS_STUDY_OUTPUT_MANIFEST_SCHEMA.into(),
            run_id: run_id.into(),
            task_id: task_id.clone(),
            step_id: step_id.into(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            outputs: vec![FmsStudyOutputManifestEntry {
                port_id: "final_state".into(),
                case_id: "default".into(),
                data_kind: "state".into(),
                codec_id: "fullmag-test-opaque".into(),
                codec_version: "v1".into(),
                artifact_id: entry.artifact_id.clone(),
                object_ref: entry.object_ref.clone().unwrap(),
                content_sha256: entry.content_sha256.clone(),
            }],
        };
        let manifest_ref = store
            .cas()
            .put(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        let manifest_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-output-manifest".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: format!("outputs/{task_id}/attempt-one/study-output-manifest.v1.json"),
            artifact_type: "study_output_manifest".into(),
            content_sha256: manifest_ref.clone(),
            object_ref: Some(manifest_ref),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: None,
        };
        let published = store
            .append_artifact_catalog_entries_for_lease(
                &lease,
                std::slice::from_ref(&manifest_entry),
            )
            .unwrap();
        assert_eq!(
            published.entries,
            vec![entry.clone(), manifest_entry.clone()]
        );

        let late_bytes = b"late output after manifest publication";
        let late_object = store.cas().put(late_bytes).unwrap();
        let late_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-after-manifest".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: "outputs/late/after-manifest.bin".into(),
            artifact_type: "state".into(),
            content_sha256: late_object.clone(),
            object_ref: Some(late_object),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "late_state".into(),
                case_id: "late".into(),
            }),
        };
        assert!(store
            .append_artifact_catalog_entries_for_lease(&lease, &[late_entry])
            .is_err());

        let mut projection_gap = store.read_run_catalog(run_id).unwrap().unwrap();
        projection_gap.tasks[0].artifact_ids.clear();
        projection_gap.revision += 1;
        projection_gap.updated_at = chrono::Utc::now();
        store.commit_run_catalog(&projection_gap).unwrap();
        assert_eq!(
            store
                .append_artifact_catalog_entries_for_lease(&lease, std::slice::from_ref(&entry))
                .unwrap(),
            published
        );
        let mut run_catalog = store.read_run_catalog(run_id).unwrap().unwrap();
        assert_eq!(
            run_catalog.tasks[0].artifact_ids,
            vec![
                entry.artifact_id.clone(),
                manifest_entry.artifact_id.clone()
            ]
        );

        run_catalog.revision += 1;
        run_catalog.updated_at = chrono::Utc::now();
        run_catalog.tasks[0].lifecycle = FmsTaskLifecycle::Succeeded;
        store.commit_run_catalog(&run_catalog).unwrap();
        assert_eq!(
            store
                .append_artifact_catalog_entries_for_lease(&lease, std::slice::from_ref(&entry))
                .unwrap(),
            published
        );

        let late_bytes = b"late output after task completion";
        let late_object = store.cas().put(late_bytes).unwrap();
        let late_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-late-after-completion".into(),
            task_id: task_id.clone(),
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: "outputs/late/after-completion.bin".into(),
            artifact_type: "state".into(),
            content_sha256: late_object.clone(),
            object_ref: Some(late_object),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "late_state".into(),
                case_id: "late".into(),
            }),
        };
        assert!(store
            .append_artifact_catalog_entries_for_lease(&lease, &[late_entry])
            .is_err());

        store.release_resource_lease(&heartbeat_lease).unwrap();
        let late_bytes = b"late output after lease release";
        let late_object = store.cas().put(late_bytes).unwrap();
        let late_entry = FmsArtifactCatalogEntry {
            artifact_id: "artifact-late-after-release".into(),
            task_id,
            attempt_id: "attempt-one".into(),
            ownership_epoch: 1,
            logical_path: "outputs/late/after-release.bin".into(),
            artifact_type: "state".into(),
            content_sha256: late_object.clone(),
            object_ref: Some(late_object),
            status: FmsArtifactStatus::Published,
            required: true,
            study_output: Some(FmsStudyArtifactOutput {
                step_id: step_id.into(),
                port_id: "late_state".into(),
                case_id: "late".into(),
            }),
        };
        assert!(store
            .append_artifact_catalog_entries_for_lease(&lease, &[late_entry])
            .is_err());
        assert_eq!(
            store.read_artifact_catalog(run_id).unwrap(),
            Some(published)
        );
    }

    #[test]
    fn applying_retry_decision_updates_catalog_and_replays_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-apply-retry".into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: "task-apply-retry".into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Failed,
                    readiness: FmsTaskReadiness::Ready,
                    observation: Some(FmsObservationState::Reconciling),
                    attempt_id: Some("attempt-apply-retry".into()),
                    ownership_epoch: Some(3),
                    resolved_input_fingerprint: Some("b".repeat(64)),
                    artifact_ids: Vec::new(),
                    resource_id: None,
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let decision = FmsRetryDecision {
            schema_version: FMS_RETRY_DECISION_SCHEMA.into(),
            decision_id: "decision-apply-retry".into(),
            run_id: "run-apply-retry".into(),
            task_id: "task-apply-retry".into(),
            attempt_id: "attempt-apply-retry".into(),
            ownership_epoch: 3,
            trigger: FmsRetryTrigger::WorkerDisconnected,
            action: FmsRetryAction::Retry,
            reason: "worker disconnected after reconciliation".into(),
            created_at: now,
        };

        assert_eq!(
            store.apply_retry_decision(&decision).unwrap(),
            RetryDecisionApplyDisposition::Applied
        );
        let catalog = store.read_run_catalog("run-apply-retry").unwrap().unwrap();
        let task = &catalog.tasks[0];
        assert_eq!(task.lifecycle, FmsTaskLifecycle::Queued);
        assert_eq!(task.attempt_id, None);
        assert_eq!(task.ownership_epoch, Some(3));
        assert_eq!(task.resolved_input_fingerprint, None);
        assert_eq!(task.resource_id, None);
        assert_eq!(
            store.apply_retry_decision(&decision).unwrap(),
            RetryDecisionApplyDisposition::Replayed
        );
    }

    #[test]
    fn coordinator_journal_is_contiguous_idempotent_and_terminal_fenced() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::open(dir.path().join("session-store")).unwrap();
        let now = chrono::Utc::now();
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-journal".into(),
                revision: 1,
                updated_at: now,
                tasks: vec![FmsTaskCatalogEntry {
                    task_id: "task-journal".into(),
                    input_fingerprint: "a".repeat(64),
                    lifecycle: FmsTaskLifecycle::Running,
                    readiness: FmsTaskReadiness::Ready,
                    observation: Some(FmsObservationState::Live),
                    attempt_id: Some("attempt-journal".into()),
                    ownership_epoch: Some(1),
                    resolved_input_fingerprint: None,
                    artifact_ids: Vec::new(),
                    resource_id: Some("gpu-journal".into()),
                    coordinator_watermark: None,
                    coordinator_genesis: None,
                }],
            })
            .unwrap();
        let journal_lease = test_resource_lease(
            "run-journal",
            "task-journal",
            "attempt-journal",
            1,
            "gpu-journal",
            "lease-journal",
            now,
        );
        store.commit_resource_lease(&journal_lease).unwrap();
        let payload = serde_json::json!({"status": "started"});
        let entry = FmsCoordinatorJournalEntry {
            schema_version: FMS_COORDINATOR_JOURNAL_SCHEMA.into(),
            entry_id: "event-one".into(),
            run_id: "run-journal".into(),
            task_id: "task-journal".into(),
            attempt_id: "attempt-journal".into(),
            ownership_epoch: 1,
            lease_token: "lease-journal".into(),
            direction: FmsCoordinatorJournalDirection::Event,
            sequence: 1,
            terminal: false,
            payload_sha256: canonical_json_sha256(&payload),
            payload,
            created_at: now,
        };
        let entry_path = store.coordinator_journal_path(&entry).unwrap();
        crate::durability::fail_directory_barrier_for(&entry_path);
        let uncertain = store.commit_coordinator_journal_entry(&entry).unwrap_err();
        assert!(uncertain.is::<crate::PublicationUncertain>());
        assert_eq!(
            store
                .read_coordinator_journal_entry(
                    "run-journal",
                    FmsCoordinatorJournalDirection::Event,
                    "event-one"
                )
                .unwrap(),
            Some(entry.clone())
        );
        // A visible matching payload cannot bypass a failed confirmation barrier.
        crate::durability::fail_directory_barrier_for(&entry_path);
        let uncertain = store.commit_coordinator_journal_entry(&entry).unwrap_err();
        assert!(uncertain.is::<crate::PublicationUncertain>());
        assert_eq!(
            store.commit_coordinator_journal_entry(&entry).unwrap(),
            CoordinatorJournalCommitDisposition::Replayed
        );

        let terminal_payload = serde_json::json!({"status": "failed"});
        let terminal = FmsCoordinatorJournalEntry {
            entry_id: "event-two".into(),
            sequence: 2,
            terminal: true,
            payload_sha256: canonical_json_sha256(&terminal_payload),
            payload: terminal_payload,
            ..entry.clone()
        };
        store.commit_coordinator_journal_entry(&terminal).unwrap();

        let after_terminal_payload = serde_json::json!({"status": "late"});
        let after_terminal = FmsCoordinatorJournalEntry {
            entry_id: "event-three".into(),
            sequence: 3,
            payload_sha256: canonical_json_sha256(&after_terminal_payload),
            payload: after_terminal_payload,
            terminal: false,
            ..entry
        };
        assert!(store
            .commit_coordinator_journal_entry(&after_terminal)
            .is_err());
        assert_eq!(
            store
                .read_coordinator_journal_entry(
                    "run-journal",
                    FmsCoordinatorJournalDirection::Event,
                    "event-two"
                )
                .unwrap()
                .unwrap(),
            terminal
        );

        let mut catalog = store.read_run_catalog("run-journal").unwrap().unwrap();
        let mut other_task = catalog.tasks[0].clone();
        other_task.task_id = "task-other".into();
        other_task.attempt_id = Some("attempt-other".into());
        other_task.resource_id = Some("gpu-other".into());
        catalog.tasks.push(other_task);
        catalog.revision += 1;
        store.commit_run_catalog(&catalog).unwrap();
        let other_lease = test_resource_lease(
            "run-journal",
            "task-other",
            "attempt-other",
            1,
            "gpu-other",
            "lease-other",
            now,
        );
        store.commit_resource_lease(&other_lease).unwrap();
        let other = FmsCoordinatorJournalEntry {
            entry_id: "event-other-one".into(),
            task_id: "task-other".into(),
            attempt_id: "attempt-other".into(),
            lease_token: "lease-other".into(),
            sequence: 1,
            ..after_terminal.clone()
        };
        store.commit_coordinator_journal_entry(&other).unwrap();

        store.release_resource_lease(&journal_lease).unwrap();
        catalog.tasks[0].attempt_id = Some("attempt-retry".into());
        catalog.tasks[0].ownership_epoch = Some(2);
        catalog.revision += 1;
        store.commit_run_catalog(&catalog).unwrap();
        let retry_lease = test_resource_lease(
            "run-journal",
            "task-journal",
            "attempt-retry",
            2,
            "gpu-journal",
            "lease-retry",
            chrono::Utc::now(),
        );
        store.commit_resource_lease(&retry_lease).unwrap();
        let retried = FmsCoordinatorJournalEntry {
            entry_id: "event-retry-one".into(),
            attempt_id: "attempt-retry".into(),
            ownership_epoch: 2,
            lease_token: "lease-retry".into(),
            sequence: 1,
            ..after_terminal.clone()
        };
        store.commit_coordinator_journal_entry(&retried).unwrap();
        assert!(store
            .commit_coordinator_journal_entry(&after_terminal)
            .is_err());
        store.release_resource_lease(&retry_lease).unwrap();
        assert_eq!(
            store.commit_coordinator_journal_entry(&retried).unwrap(),
            CoordinatorJournalCommitDisposition::Replayed
        );
        let after_release_payload = serde_json::json!({"status": "late-after-release"});
        let after_release = FmsCoordinatorJournalEntry {
            entry_id: "event-retry-after-release".into(),
            sequence: 2,
            payload_sha256: canonical_json_sha256(&after_release_payload),
            payload: after_release_payload,
            ..retried.clone()
        };
        assert!(store
            .commit_coordinator_journal_entry(&after_release)
            .is_err());
        let changed_lease = FmsCoordinatorJournalEntry {
            entry_id: "event-retry-wrong-lease".into(),
            lease_token: "lease-forged".into(),
            sequence: 2,
            ..retried.clone()
        };
        assert!(store
            .commit_coordinator_journal_entry(&changed_lease)
            .is_err());
        let other_next = FmsCoordinatorJournalEntry {
            entry_id: "event-other-two".into(),
            sequence: 2,
            ..other
        };
        store.commit_coordinator_journal_entry(&other_next).unwrap();
        let reopened = SessionStore::open(dir.path().join("session-store")).unwrap();
        let snapshot = reopened.read_coordinator_journal("run-journal").unwrap();
        assert_eq!(snapshot.len(), 5);
        assert!(snapshot.contains(&terminal));
        assert!(snapshot.contains(&retried));
        assert!(snapshot.contains(&other_next));
        crate::reachability::walk_store_root(
            &store.root,
            crate::reachability::ReachabilityMode::Gc,
        )
        .unwrap();
        crate::reachability::validate_journal_streams(&snapshot).unwrap();
        let mut bad_stream = snapshot.clone();
        bad_stream.push(other_next.clone());
        assert!(crate::reachability::validate_journal_streams(&bad_stream).is_err());
        let mut changed_token = snapshot.clone();
        changed_token
            .iter_mut()
            .find(|entry| entry.entry_id == other_next.entry_id)
            .unwrap()
            .lease_token = "unexpected-token".into();
        assert!(crate::reachability::validate_journal_streams(&changed_token).is_err());
        let writer = store.write_transaction().unwrap();
        assert!(reopened.read_coordinator_journal("run-journal").is_err());
        drop(writer);
        assert_eq!(
            reopened.read_coordinator_journal("run-journal").unwrap(),
            snapshot
        );

        // A missing prefix must never be interpreted as a recoverable stream.
        fs::remove_file(
            store
                .root
                .join("runs/run-journal/coordinator_journal/event/event-one.json"),
        )
        .unwrap();
        assert!(reopened.read_coordinator_journal("run-journal").is_err());
    }
}

#[cfg(test)]
mod admission_tests {
    use super::*;
    use chrono::Utc;

    fn queued_task(task_id: &str) -> FmsTaskCatalogEntry {
        FmsTaskCatalogEntry {
            task_id: task_id.into(),
            input_fingerprint: "a".repeat(64),
            lifecycle: FmsTaskLifecycle::Queued,
            readiness: FmsTaskReadiness::Ready,
            observation: None,
            attempt_id: None,
            ownership_epoch: None,
            resolved_input_fingerprint: None,
            artifact_ids: Vec::new(),
            resource_id: None,
            coordinator_watermark: None,
            coordinator_genesis: None,
        }
    }

    fn lease(task_id: &str, attempt_id: &str, token: &str) -> FmsResourceLease {
        let now = Utc::now();
        FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "cpu-0".into(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 1024,
            },
            run_id: "run-admission".into(),
            task_id: task_id.into(),
            attempt_id: attempt_id.into(),
            ownership_epoch: 1,
            lease_token: token.into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
        }
    }

    fn seed_catalog(store: &SessionStore, tasks: Vec<FmsTaskCatalogEntry>) {
        store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: "run-admission".into(),
                revision: 1,
                updated_at: Utc::now(),
                tasks,
            })
            .unwrap();
    }

    #[test]
    fn task_admission_replays_and_repairs_a_missing_lease_without_new_attempt() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        seed_catalog(&store, vec![queued_task("task-admission-a")]);
        let claim_lease = lease("task-admission-a", "attempt-admission-a", "lease-admission-a");

        assert_eq!(
            store.commit_task_admission(&claim_lease).unwrap(),
            TaskAdmissionCommitDisposition::Admitted
        );
        let mut replay_lease = claim_lease.clone();
        replay_lease.acquired_at += chrono::Duration::seconds(1);
        replay_lease.heartbeat_at += chrono::Duration::seconds(1);
        assert_eq!(
            store.commit_task_admission(&replay_lease).unwrap(),
            TaskAdmissionCommitDisposition::Replayed
        );
        let catalog = store.read_run_catalog("run-admission").unwrap().unwrap();
        assert_eq!(catalog.revision, 2);
        assert_eq!(catalog.tasks[0].lifecycle, FmsTaskLifecycle::Preparing);
        assert_eq!(catalog.tasks[0].attempt_id.as_deref(), Some("attempt-admission-a"));
        assert_eq!(
            store
                .read_active_resource_lease_for_task("run-admission", "task-admission-a")
                .unwrap(),
            Some(claim_lease.clone())
        );

        let lease_path = store.resource_lease_path(&claim_lease).unwrap();
        let canonical_temp_root = fs::canonicalize(temp.path()).unwrap();
        assert!(lease_path.starts_with(&canonical_temp_root));
        fs::remove_file(lease_path).unwrap();
        assert_eq!(
            store
                .reconcile_task_admissions("run-admission")
                .unwrap(),
            vec![TaskAdmissionCommitDisposition::Replayed]
        );
        assert_eq!(
            store
                .read_active_resource_lease_for_task("run-admission", "task-admission-a")
                .unwrap(),
            Some(claim_lease)
        );
        assert_eq!(
            store
                .read_run_catalog("run-admission")
                .unwrap()
                .unwrap()
                .revision,
            2
        );
    }

    #[test]
    fn task_admission_recovery_finishes_a_persisted_intent_before_projection() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        seed_catalog(&store, vec![queued_task("task-admission-a")]);
        let mut catalog = store
            .read_run_catalog("run-admission")
            .unwrap()
            .unwrap();
        let queued = catalog.tasks.remove(0);
        let claim_lease = lease("task-admission-a", "attempt-admission-a", "lease-admission-a");
        let mut admitted = queued.clone();
        admitted.lifecycle = FmsTaskLifecycle::Preparing;
        admitted.readiness = FmsTaskReadiness::Ready;
        admitted.attempt_id = Some(claim_lease.attempt_id.clone());
        admitted.ownership_epoch = Some(claim_lease.ownership_epoch);
        admitted.resource_id = Some(claim_lease.resource_id.clone());
        let record = FmsTaskAdmissionRecord {
            schema_version: FMS_TASK_ADMISSION_SCHEMA.into(),
            expected_catalog_revision: 1,
            queued_task: queued,
            task: admitted,
            lease: claim_lease.clone(),
        };
        record.validate().unwrap();
        let path = create_parent(
            &store.root,
            "runs/run-admission/task_admissions/task-admission-a/attempt-admission-a.json",
        )
        .unwrap();
        atomic_write(&path, &serde_json::to_vec_pretty(&record).unwrap()).unwrap();

        assert_eq!(
            store
                .reconcile_task_admissions("run-admission")
                .unwrap(),
            vec![TaskAdmissionCommitDisposition::Admitted]
        );
        let catalog = store.read_run_catalog("run-admission").unwrap().unwrap();
        assert_eq!(catalog.revision, 2);
        assert_eq!(catalog.tasks[0].attempt_id.as_deref(), Some("attempt-admission-a"));
        assert_eq!(
            store
                .read_active_resource_lease_for_task("run-admission", "task-admission-a")
                .unwrap(),
            Some(claim_lease)
        );
        crate::reachability::walk_store_root(
            &store.root,
            crate::reachability::ReachabilityMode::Gc,
        )
        .unwrap();
    }

    #[test]
    fn task_admission_rejects_a_busy_resource_before_claiming_another_task() {
        let temp = tempfile::tempdir().unwrap();
        let store = SessionStore::open(temp.path().join("session-store")).unwrap();
        seed_catalog(
            &store,
            vec![queued_task("task-admission-a"), queued_task("task-admission-b")],
        );
        store
            .commit_task_admission(&lease(
                "task-admission-a",
                "attempt-admission-a",
                "lease-admission-a",
            ))
            .unwrap();

        let error = store
            .commit_task_admission(&lease(
                "task-admission-b",
                "attempt-admission-b",
                "lease-admission-b",
            ))
            .unwrap_err();
        assert!(error.to_string().contains("active lease"));
        let catalog = store.read_run_catalog("run-admission").unwrap().unwrap();
        let second = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == "task-admission-b")
            .unwrap();
        assert_eq!(second.lifecycle, FmsTaskLifecycle::Queued);
        assert!(second.attempt_id.is_none());
        assert!(!store
            .task_admission_path("run-admission", "task-admission-b", "attempt-admission-b")
            .unwrap()
            .exists());
    }
}
