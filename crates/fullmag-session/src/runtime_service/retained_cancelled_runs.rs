//! Read-only preflight for explicitly pinned, retained runs whose tasks were
//! already cancelled before any task claim was created, along with the CAS
//! pins that directly root those run intents' immutable inputs.
//!
//! The caller must hold `SessionStore::write_transaction()` before calling
//! this function and keep it held through any subsequent recovery operation.
//! This function does not acquire the writer itself so the caller controls the
//! full recovery transaction boundary. It validates evidence only; it never
//! changes the run catalog, cancellation intents, leases, or runtime owner.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::cas::hex_sha256;
use crate::repository_path::{
    checked_path, read_bounded_regular_file, reject_link, validate_store_id,
};
use crate::store::SessionStore;
use crate::types::{
    FmsResourceLeaseState, FmsRunCatalog, FmsRunIntent, FmsTaskCatalogEntry, FmsTaskLifecycle,
};

pub const MAX_RETAINED_CANCELLED_RUN_PINS: usize = 128;
pub const MAX_RETAINED_CANCELLED_TASKS: usize = 4096;

const MAX_OBSERVED_ENTRIES: usize = 32_768;
const MAX_OBSERVED_FILES: usize = 16_384;
const MAX_OBSERVED_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_MANUAL_HELD_V4_AGGREGATE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_CAS_PIN_BYTES: usize = 4096;
const MAX_TASK_CANCELLATION_INTENT_BYTES: usize = 256 * 1024;
const MAX_TASK_ADMISSION_RECORD_BYTES: usize = 1024 * 1024;

/// Exact raw-file pins for one retained run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedCancelledRunPin {
    pub run_id: String,
    pub run_intent_sha256: String,
    pub run_catalog_sha256: String,
}

/// Bounded counts observed by a successful read-only preflight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetainedCancelledRunsPreflight {
    pub run_count: usize,
    pub task_count: usize,
    pub inspected_file_count: usize,
    pub inspected_file_bytes: u64,
}

pub(super) struct ReadBudget {
    entries: usize,
    files: BTreeSet<String>,
    file_bytes: u64,
    aggregate_limit: u64,
}

impl Default for ReadBudget {
    fn default() -> Self {
        Self {
            entries: 0,
            files: BTreeSet::new(),
            file_bytes: 0,
            aggregate_limit: MAX_OBSERVED_FILE_BYTES,
        }
    }
}

impl ReadBudget {
    /// Native v4 only: operator JSON cannot select this budget. Per-object
    /// reads remain bounded by the unchanged 128 MiB CAS limit below.
    pub(super) fn for_manual_held_v4() -> Self {
        Self {
            aggregate_limit: MAX_MANUAL_HELD_V4_AGGREGATE_BYTES,
            ..Self::default()
        }
    }

    pub(super) fn inspected_file_count(&self) -> usize {
        self.files.len()
    }

    pub(super) fn inspected_file_bytes(&self) -> u64 {
        self.file_bytes
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CasPinRecord {
    schema: String,
    object_ref: String,
}

impl ReadBudget {
    pub(super) fn observe_entry(&mut self) -> Result<()> {
        self.entries = self
            .entries
            .checked_add(1)
            .context("retained-run entry count overflow")?;
        if self.entries > MAX_OBSERVED_ENTRIES {
            bail!("retained-run preflight exceeds its entry limit");
        }
        Ok(())
    }

    pub(super) fn observe_file(
        &mut self,
        root: &Path,
        relative: &str,
        maximum: usize,
    ) -> Result<()> {
        if !self.files.insert(relative.to_owned()) {
            return Ok(());
        }
        if self.files.len() > MAX_OBSERVED_FILES {
            bail!("retained-run preflight exceeds its file limit");
        }
        let path = checked_path(root, relative)?;
        reject_link(&path)?;
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("checking retained-run file {relative}"))?;
        if !metadata.is_file() || metadata.len() > maximum as u64 {
            bail!("retained-run file {relative} is not regular or exceeds its byte limit");
        }
        self.file_bytes = self
            .file_bytes
            .checked_add(metadata.len())
            .context("retained-run byte count overflow")?;
        if self.file_bytes > self.aggregate_limit {
            bail!("retained-run preflight exceeds its aggregate byte limit");
        }
        Ok(())
    }
}

/// Validate explicit pins for every run in the store and prove that every
/// catalog task is durably cancelled without a remaining claim or active
/// solver/preparation lease. CAS pin records must be a subset of the immutable
/// object references in those run intents, and all referenced objects must
/// remain present and hash-valid. The function is read-only.
pub fn validate_retained_cancelled_runs(
    store: &SessionStore,
    pins: &[RetainedCancelledRunPin],
) -> Result<RetainedCancelledRunsPreflight> {
    if pins.is_empty() || pins.len() > MAX_RETAINED_CANCELLED_RUN_PINS {
        bail!("retained-run pin count must be between 1 and {MAX_RETAINED_CANCELLED_RUN_PINS}");
    }

    let mut pins_by_run = BTreeMap::new();
    for pin in pins {
        validate_store_id(&pin.run_id)?;
        validate_sha256(&pin.run_intent_sha256, "run_intent_sha256")?;
        validate_sha256(&pin.run_catalog_sha256, "run_catalog_sha256")?;
        if pins_by_run
            .insert(pin.run_id.clone(), pin.clone())
            .is_some()
        {
            bail!("retained-run pins contain a duplicate run id");
        }
    }

    let mut budget = ReadBudget::default();
    let run_ids = list_run_inventory(store, &mut budget)?;
    let pinned_run_ids = pins_by_run.keys().cloned().collect::<BTreeSet<_>>();
    if run_ids.iter().cloned().collect::<BTreeSet<_>>() != pinned_run_ids {
        bail!("retained-run pins do not exactly match the durable run inventory");
    }

    let mut task_count = 0usize;
    let mut referenced_object_refs = BTreeSet::new();
    for run_id in run_ids {
        let pin = pins_by_run
            .get(&run_id)
            .context("retained-run inventory lost its explicit pin")?;
        let intent_path = format!("runs/{run_id}/run_intent.json");
        let catalog_path = format!("runs/{run_id}/run_catalog.json");

        budget.observe_entry()?;
        budget.observe_file(
            store.root(),
            &intent_path,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
        )?;
        let intent_bytes = read_bounded_regular_file(
            store.root(),
            &intent_path,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
        )?;
        if hex_sha256(&intent_bytes) != pin.run_intent_sha256 {
            bail!("retained run `{run_id}` run-intent SHA-256 pin does not match");
        }
        let pinned_intent: FmsRunIntent =
            serde_json::from_slice(&intent_bytes).context("parsing pinned retained run intent")?;
        pinned_intent.validate()?;
        let intent = store
            .read_run_intent(&run_id)?
            .context("pinned retained run is missing its typed run intent")?;
        if intent != pinned_intent || intent.run_id != run_id {
            bail!("retained run intent changed after its pinned bytes were read");
        }
        referenced_object_refs.extend(
            intent
                .definition_object_ref
                .iter()
                .chain(intent.study_object_ref.iter())
                .chain(intent.study_catalog_object_ref.iter())
                .cloned(),
        );
        referenced_object_refs.extend(intent.asset_object_refs.values().cloned());

        budget.observe_entry()?;
        budget.observe_file(
            store.root(),
            &catalog_path,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
        )?;
        let catalog_bytes = read_bounded_regular_file(
            store.root(),
            &catalog_path,
            crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
        )?;
        if hex_sha256(&catalog_bytes) != pin.run_catalog_sha256 {
            bail!("retained run `{run_id}` run-catalog SHA-256 pin does not match");
        }
        let pinned_catalog: FmsRunCatalog = serde_json::from_slice(&catalog_bytes)
            .context("parsing pinned retained run catalog")?;
        pinned_catalog.validate()?;
        let catalog: FmsRunCatalog = store
            .read_run_catalog(&run_id)?
            .context("pinned retained run is missing its typed run catalog")?;
        if catalog != pinned_catalog || catalog.run_id != run_id || intent.run_id != catalog.run_id
        {
            bail!("retained run catalog changed after its pinned bytes were read");
        }
        if catalog.tasks.is_empty() {
            bail!("retained run `{run_id}` has no cancelled tasks to preserve");
        }
        task_count = task_count
            .checked_add(catalog.tasks.len())
            .context("retained-run task count overflow")?;
        if task_count > MAX_RETAINED_CANCELLED_TASKS {
            bail!("retained-run preflight exceeds its task limit");
        }

        let mut tasks = BTreeMap::<String, &FmsTaskCatalogEntry>::new();
        for task in &catalog.tasks {
            if task.lifecycle != FmsTaskLifecycle::Cancelled
                || task.attempt_id.is_some()
                || task.resource_id.is_some()
                || task.resolved_input_fingerprint.is_some()
                || task.coordinator_genesis.is_some()
                || task.coordinator_watermark.is_some()
            {
                bail!(
                    "retained run `{run_id}` task `{}` is not cancelled and unclaimed",
                    task.task_id
                );
            }
            if tasks.insert(task.task_id.clone(), task).is_some() {
                bail!("retained run `{run_id}` contains a duplicate task id");
            }
        }

        let cancellations = read_cancellation_intents(store, &run_id, &tasks, &mut budget)?;
        for (task_id, task) in &tasks {
            let cancellation = cancellations
                .get(task_id)
                .context("cancelled task is missing its durable cancellation intent")?;
            let mut expected_task = cancellation.task.clone();
            expected_task.lifecycle = FmsTaskLifecycle::Cancelled;
            if **task != expected_task {
                bail!(
                    "retained run `{run_id}` task `{task_id}` drifted from its cancellation snapshot"
                );
            }
            cancellation.validate_task_scope(store, task, catalog.revision)?;
        }

        reject_matching_task_admissions(store, &run_id, &tasks, &cancellations, &mut budget)?;
        reject_active_leases(store, &run_id, &mut budget)?;
    }

    validate_run_cas_pins(store, &referenced_object_refs, &mut budget)?;

    Ok(RetainedCancelledRunsPreflight {
        run_count: pins.len(),
        task_count,
        inspected_file_count: budget.files.len(),
        inspected_file_bytes: budget.file_bytes,
    })
}

/// Require every durable CAS pin to be rooted by one of the explicitly
/// retained run intents. Run-intent validation above proves these references
/// match the accepted definition, study, catalog, and immutable asset records.
/// This check is read-only and intentionally never releases pins.
pub(super) fn validate_run_cas_pins(
    store: &SessionStore,
    referenced_object_refs: &BTreeSet<String>,
    budget: &mut ReadBudget,
) -> Result<()> {
    let pins_directory = required_directory(store.root(), "objects/pins")?;
    let mut discovered = BTreeSet::new();
    for entry in fs::read_dir(pins_directory)? {
        let entry = entry?;
        budget.observe_entry()?;
        reject_link(&entry.path())?;
        if !entry.file_type()?.is_file() {
            bail!("CAS pin namespace contains a non-file entry");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("CAS pin filename is not UTF-8"))?;
        let object_ref = name
            .strip_suffix(".json")
            .context("CAS pin filename must end in .json")?;
        validate_sha256(object_ref, "CAS pin object_ref")?;
        let relative = format!("objects/pins/{name}");
        budget.observe_file(store.root(), &relative, MAX_CAS_PIN_BYTES)?;
        let bytes = read_bounded_regular_file(store.root(), &relative, MAX_CAS_PIN_BYTES)?;
        let pin: CasPinRecord =
            serde_json::from_slice(&bytes).context("parse retained-run CAS pin record")?;
        if pin.schema != "fullmag.cas-pin.v1" || pin.object_ref != object_ref {
            bail!("CAS pin record differs from its schema or filename");
        }
        if !discovered.insert(object_ref.to_owned()) {
            bail!("CAS pin namespace contains a duplicate object reference");
        }
    }
    if !discovered.is_subset(referenced_object_refs) {
        bail!("CAS pin namespace contains an object not referenced by a retained run intent");
    }

    for object_ref in referenced_object_refs {
        let relative = format!("objects/sha256/{object_ref}");
        budget.observe_file(
            store.root(),
            &relative,
            usize::try_from(MAX_OBSERVED_FILE_BYTES)?,
        )?;
        let bytes = read_bounded_regular_file(
            store.root(),
            &relative,
            usize::try_from(MAX_OBSERVED_FILE_BYTES)?,
        )
        .with_context(|| format!("read retained run CAS object {object_ref}"))?;
        if hex_sha256(&bytes) != *object_ref {
            bail!("retained run CAS object {object_ref} does not match its SHA-256");
        }
    }
    Ok(())
}

pub(super) fn list_run_inventory(
    store: &SessionStore,
    budget: &mut ReadBudget,
) -> Result<Vec<String>> {
    let root = checked_path(store.root(), "runs")?;
    let metadata = fs::symlink_metadata(&root).context("retained-run inventory is missing")?;
    reject_link(&root)?;
    if !metadata.is_dir() {
        bail!("retained-run inventory is not a directory");
    }

    let mut run_ids = BTreeSet::new();
    for entry in fs::read_dir(&root)? {
        let entry = entry?;
        budget.observe_entry()?;
        reject_link(&entry.path())?;
        if !entry.file_type()?.is_dir() {
            bail!("retained-run inventory contains a non-directory entry");
        }
        let run_id = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("retained-run inventory has a non-UTF8 id"))?;
        validate_store_id(&run_id)?;
        if !run_ids.insert(run_id) {
            bail!("retained-run inventory contains a duplicate id");
        }
        if run_ids.len() > MAX_RETAINED_CANCELLED_RUN_PINS {
            bail!("retained-run inventory exceeds its run limit");
        }
    }
    if run_ids.is_empty() {
        bail!("retained-run inventory is empty");
    }
    Ok(run_ids.into_iter().collect())
}

fn read_cancellation_intents(
    store: &SessionStore,
    run_id: &str,
    tasks: &BTreeMap<String, &FmsTaskCatalogEntry>,
    budget: &mut ReadBudget,
) -> Result<BTreeMap<String, crate::task_cancellation::FmsTaskCancellationIntent>> {
    let relative = format!("runs/{run_id}/task_cancellation_intents");
    let directory = required_directory(store.root(), &relative)?;
    let mut discovered = BTreeSet::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        budget.observe_entry()?;
        reject_link(&entry.path())?;
        if !entry.file_type()?.is_file() {
            bail!("retained cancellation-intent namespace contains a non-file entry");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("cancellation-intent filename is not UTF-8"))?;
        let task_id = name
            .strip_suffix(".json")
            .context("cancellation-intent filename must end in .json")?;
        validate_store_id(task_id)?;
        if !tasks.keys().any(|candidate| candidate.as_str() == task_id)
            || !discovered.insert(task_id.to_owned())
        {
            bail!("retained cancellation-intent inventory has an unlisted or duplicate task");
        }
        budget.observe_file(
            store.root(),
            &format!("{relative}/{name}"),
            MAX_TASK_CANCELLATION_INTENT_BYTES,
        )?;
    }
    if discovered.len() != tasks.len() {
        bail!("retained cancellation-intent inventory is incomplete");
    }

    let mut cancellations = BTreeMap::new();
    for task_id in tasks.keys() {
        let cancellation = store
            .read_task_cancellation_intent(run_id, task_id)?
            .context("retained cancelled task is missing its cancellation intent")?;
        cancellations.insert(task_id.clone(), cancellation);
    }
    Ok(cancellations)
}

fn reject_matching_task_admissions(
    store: &SessionStore,
    run_id: &str,
    tasks: &BTreeMap<String, &FmsTaskCatalogEntry>,
    cancellations: &BTreeMap<String, crate::task_cancellation::FmsTaskCancellationIntent>,
    budget: &mut ReadBudget,
) -> Result<()> {
    let relative = format!("runs/{run_id}/task_admissions");
    let Some(directory) = optional_directory(store.root(), &relative)? else {
        return Ok(());
    };
    for task_entry in fs::read_dir(directory)? {
        let task_entry = task_entry?;
        budget.observe_entry()?;
        reject_link(&task_entry.path())?;
        if !task_entry.file_type()?.is_dir() {
            bail!("task-admission namespace contains a non-directory entry");
        }
        let task_id = task_entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("task-admission task id is not UTF-8"))?;
        validate_store_id(&task_id)?;
        if !tasks.contains_key(&task_id) {
            bail!("task-admission namespace contains an unlisted task");
        }
        let task_relative = format!("{relative}/{task_id}");
        for admission_entry in fs::read_dir(task_entry.path())? {
            let admission_entry = admission_entry?;
            budget.observe_entry()?;
            reject_link(&admission_entry.path())?;
            if !admission_entry.file_type()?.is_file() {
                bail!("task-admission task directory contains a non-file entry");
            }
            let name = admission_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("task-admission filename is not UTF-8"))?;
            let attempt_id = name
                .strip_suffix(".json")
                .context("task-admission filename must end in .json")?;
            validate_store_id(attempt_id)?;
            let admission_relative = format!("{task_relative}/{name}");
            budget.observe_file(
                store.root(),
                &admission_relative,
                MAX_TASK_ADMISSION_RECORD_BYTES,
            )?;
            let admission = store
                .read_task_admission(run_id, &task_id, attempt_id)?
                .context("listed task admission disappeared during preflight")?;
            let cancellation = cancellations
                .get(&task_id)
                .context("task admission has no matching cancellation scope")?;
            if admission.queued_task == cancellation.task {
                bail!("retained cancelled task `{task_id}` still has a matching admission record");
            }
        }
    }
    Ok(())
}

fn reject_active_leases(store: &SessionStore, run_id: &str, budget: &mut ReadBudget) -> Result<()> {
    scan_solver_leases(store, run_id, budget)?;
    scan_preparation_leases(store, run_id, budget)
}

fn scan_solver_leases(store: &SessionStore, run_id: &str, budget: &mut ReadBudget) -> Result<()> {
    let relative = format!("runs/{run_id}/resource_leases");
    let Some(directory) = optional_directory(store.root(), &relative)? else {
        return Ok(());
    };
    for resource_entry in fs::read_dir(directory)? {
        let resource_entry = resource_entry?;
        budget.observe_entry()?;
        reject_link(&resource_entry.path())?;
        if !resource_entry.file_type()?.is_dir() {
            bail!("solver-lease resource entry is not a directory");
        }
        let resource_id = resource_entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("solver-lease resource id is not UTF-8"))?;
        validate_store_id(&resource_id)?;
        for lease_entry in fs::read_dir(resource_entry.path())? {
            let lease_entry = lease_entry?;
            budget.observe_entry()?;
            reject_link(&lease_entry.path())?;
            if !lease_entry.file_type()?.is_file() {
                bail!("solver-lease resource directory contains a non-file entry");
            }
            let name = lease_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("solver-lease filename is not UTF-8"))?;
            let token = name
                .strip_suffix(".json")
                .context("solver-lease filename must end in .json")?;
            validate_store_id(token)?;
            let lease_relative = format!("{relative}/{resource_id}/{name}");
            budget.observe_file(
                store.root(),
                &lease_relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            )?;
            let lease = store
                .read_resource_lease(run_id, &resource_id, token)?
                .context("listed solver lease disappeared during preflight")?;
            if lease.state == FmsResourceLeaseState::Active {
                bail!("retained run `{run_id}` has an active solver lease");
            }
        }
    }
    Ok(())
}

fn scan_preparation_leases(
    store: &SessionStore,
    run_id: &str,
    budget: &mut ReadBudget,
) -> Result<()> {
    let relative = format!("runs/{run_id}/preparation_resource_leases");
    let Some(directory) = optional_directory(store.root(), &relative)? else {
        return Ok(());
    };
    for resource_entry in fs::read_dir(directory)? {
        let resource_entry = resource_entry?;
        budget.observe_entry()?;
        reject_link(&resource_entry.path())?;
        if !resource_entry.file_type()?.is_dir() {
            bail!("preparation-lease resource entry is not a directory");
        }
        let resource_id = resource_entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("preparation-lease resource id is not UTF-8"))?;
        validate_store_id(&resource_id)?;
        for lease_entry in fs::read_dir(resource_entry.path())? {
            let lease_entry = lease_entry?;
            budget.observe_entry()?;
            reject_link(&lease_entry.path())?;
            if !lease_entry.file_type()?.is_file() {
                bail!("preparation-lease resource directory contains a non-file entry");
            }
            let name = lease_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("preparation-lease filename is not UTF-8"))?;
            let token = name
                .strip_suffix(".json")
                .context("preparation-lease filename must end in .json")?;
            validate_store_id(token)?;
            let lease_relative = format!("{relative}/{resource_id}/{name}");
            budget.observe_file(
                store.root(),
                &lease_relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            )?;
            let lease = store
                .read_preparation_resource_lease(run_id, &resource_id, token)?
                .context("listed preparation lease disappeared during preflight")?;
            lease.validate()?;
            if lease.state == FmsResourceLeaseState::Active {
                bail!("retained run `{run_id}` has an active preparation lease");
            }
        }
    }
    Ok(())
}

pub(super) fn required_directory(root: &Path, relative: &str) -> Result<PathBuf> {
    optional_directory(root, relative)?
        .with_context(|| format!("missing required directory {relative}"))
}

pub(super) fn optional_directory(root: &Path, relative: &str) -> Result<Option<PathBuf>> {
    let path = checked_path(root, relative)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            reject_link(&path)?;
            if !metadata.is_dir() {
                bail!("retained-run path {relative} is not a directory");
            }
            Ok(Some(path))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("checking retained-run path {relative}")),
    }
}

pub(super) fn validate_sha256(value: &str, field: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        bail!("retained-run pin `{field}` must be lowercase SHA-256");
    }
    Ok(())
}

#[cfg(test)]
mod scoped_budget_tests {
    use super::*;

    fn sparse(root: &Path, relative: &str, length: u64) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::File::create(path).unwrap().set_len(length).unwrap();
    }

    #[test]
    fn manual_held_v4_accepts_observed_aggregate_using_synthetic_sparse_metadata() {
        let directory = tempfile::tempdir().unwrap();
        // Synthetic three-object fixture reproduces the preserved store
        // aggregate; each object fits the unchanged 128 MiB object cap.
        for index in 0..3 {
            sparse(directory.path(), &format!("object-{index}"), 115_969_632);
        }
        let mut legacy = ReadBudget::default();
        legacy
            .observe_file(
                directory.path(),
                "object-0",
                MAX_OBSERVED_FILE_BYTES as usize,
            )
            .unwrap();
        assert!(legacy
            .observe_file(
                directory.path(),
                "object-1",
                MAX_OBSERVED_FILE_BYTES as usize
            )
            .is_err());
        let mut v4 = ReadBudget::for_manual_held_v4();
        for index in 0..3 {
            v4.observe_file(
                directory.path(),
                &format!("object-{index}"),
                MAX_OBSERVED_FILE_BYTES as usize,
            )
            .unwrap();
        }
        assert_eq!(v4.inspected_file_bytes(), 347_908_896);
        v4.observe_file(
            directory.path(),
            "object-0",
            MAX_OBSERVED_FILE_BYTES as usize,
        )
        .unwrap();
        assert_eq!(
            v4.inspected_file_bytes(),
            347_908_896,
            "shared subset budget must deduplicate the global CAS reread"
        );
    }

    #[test]
    fn manual_held_v4_aggregate_is_fixed_one_gib_and_individual_objects_remain_bounded() {
        let directory = tempfile::tempdir().unwrap();
        let mut v4 = ReadBudget::for_manual_held_v4();
        for index in 0..8 {
            let name = format!("chunk-{index}");
            sparse(directory.path(), &name, MAX_OBSERVED_FILE_BYTES);
            v4.observe_file(directory.path(), &name, MAX_OBSERVED_FILE_BYTES as usize)
                .unwrap();
        }
        assert_eq!(v4.inspected_file_bytes(), 1024 * 1024 * 1024);
        sparse(directory.path(), "over-aggregate", 1);
        assert!(v4
            .observe_file(
                directory.path(),
                "over-aggregate",
                MAX_OBSERVED_FILE_BYTES as usize
            )
            .is_err());
        sparse(directory.path(), "over-object", MAX_OBSERVED_FILE_BYTES + 1);
        assert!(ReadBudget::for_manual_held_v4()
            .observe_file(
                directory.path(),
                "over-object",
                MAX_OBSERVED_FILE_BYTES as usize
            )
            .is_err());
        assert!(ReadBudget::default()
            .observe_file(
                directory.path(),
                "over-object",
                MAX_OBSERVED_FILE_BYTES as usize
            )
            .is_err());
    }
}
