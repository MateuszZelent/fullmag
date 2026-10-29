//! Read-only preflight for explicitly pinned runs whose task catalogs contain
//! only terminal work. The caller must hold the session-store writer
//! transaction through recovery. This validator never changes run evidence.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::repository_path::{
    checked_path, read_bounded_regular_file, reject_link, validate_store_id,
};
use crate::store::SessionStore;
use crate::types::{
    FmsArtifactCatalog, FmsArtifactStatus, FmsCoordinatorJournalDirection,
    FmsCoordinatorJournalEntry, FmsPreparationResourceLease, FmsResourceLease,
    FmsResourceLeaseState, FmsRunCatalog, FmsRunIntent, FmsTaskAdmissionRecord,
    FmsTaskCatalogEntry, FmsTaskLifecycle, FmsWorkerProcessExitReceipt,
};
use crate::FmsWorkerInboxRecord;

use super::retained_cancelled_runs::{self, ReadBudget, MAX_RETAINED_CANCELLED_TASKS};

const MAX_ADMISSION_BYTES: usize = 1024 * 1024;
const MAX_JOURNAL_BYTES: usize = crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize;

/// Exact raw-file pins for one retained terminal run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedTerminalRunPin {
    pub run_id: String,
    pub run_intent_sha256: String,
    pub run_catalog_sha256: String,
    /// Presence is pinned as well as content: when the artifact catalog is
    /// present this digest is required; when absent it must remain absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_catalog_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetainedTerminalRunsPreflight {
    pub run_count: usize,
    pub task_count: usize,
    pub inspected_file_count: usize,
    pub inspected_file_bytes: u64,
}

type ClaimKey = (String, String, u64, String);
type JournalKey = (String, String, String);
type InboxKey = (String, String);

fn claim_task<'a>(tasks: &'a BTreeMap<String, FmsTaskCatalogEntry>, task_id: &str, attempt_id: &str, epoch: u64, resource: Option<&str>) -> Result<&'a FmsTaskCatalogEntry> {
    tasks.values().find(|task| task.task_id == task_id
        && task.attempt_id.as_deref() == Some(attempt_id) && task.ownership_epoch == Some(epoch)
        && resource.is_none_or(|id| task.resource_id.as_deref() == Some(id)))
        .context("terminal-run v3 does not support historical compute attempts or an unlisted claim")
}


/// Validate the exact retained run inventory, terminal task state, released
/// leases, closed coordinator streams, inboxes, artifact catalog, and CAS
/// roots. V3 accepts only each task's current compute attempt; it does not
/// replay historical compute lease or task-admission chains. Preparation
/// leases are separate records keyed by `preparation_attempt_id` and are
/// validated independently. This function is deliberately read-only.
pub fn validate_retained_terminal_runs(
    store: &SessionStore,
    pins: &[RetainedTerminalRunPin],
) -> Result<RetainedTerminalRunsPreflight> {
    if pins.is_empty() || pins.len() > retained_cancelled_runs::MAX_RETAINED_CANCELLED_RUN_PINS {
        bail!("retained terminal-run pin count must be between 1 and 128");
    }
    let mut budget = ReadBudget::default();
    let actual = retained_cancelled_runs::list_run_inventory(store, &mut budget)?;
    let expected = pins
        .iter()
        .map(|pin| pin.run_id.clone())
        .collect::<BTreeSet<_>>();
    if actual.into_iter().collect::<BTreeSet<_>>() != expected {
        bail!("retained terminal-run pins do not exactly match the durable run inventory");
    }
    let mut refs = BTreeSet::new();
    let task_count = validate_terminal_runs_subset(store, pins, &mut budget, &mut refs)?;
    retained_cancelled_runs::validate_run_cas_pins(store, &refs, &mut budget)?;
    Ok(RetainedTerminalRunsPreflight {
        run_count: pins.len(),
        task_count,
        inspected_file_count: budget.inspected_file_count(),
        inspected_file_bytes: budget.inspected_file_bytes(),
    })
}

/// Internal subset only. V4 owns union inventory, budget and global CAS pins;
/// public v3 continues through its unchanged whole-inventory gate above.
pub(super) fn validate_terminal_runs_subset(
    store: &SessionStore,
    pins: &[RetainedTerminalRunPin],
    budget: &mut ReadBudget,
    referenced_object_refs: &mut BTreeSet<String>,
) -> Result<usize> {
    validate_terminal_runs_subset_with_histories(store, pins, budget, referenced_object_refs, &[])
}

pub(super) fn validate_terminal_runs_subset_with_histories(
    store: &SessionStore,
    pins: &[RetainedTerminalRunPin],
    budget: &mut ReadBudget,
    referenced_object_refs: &mut BTreeSet<String>,
    histories: &[super::retained_attempt_histories::RetainedAttemptHistoryPin],
) -> Result<usize> {
    if pins.len() > retained_cancelled_runs::MAX_RETAINED_CANCELLED_RUN_PINS {
        bail!("terminal subset pin count must not exceed 128");
    }

    let mut pins_by_run = BTreeMap::new();
    for pin in pins {
        validate_store_id(&pin.run_id)?;
        retained_cancelled_runs::validate_sha256(&pin.run_intent_sha256, "run_intent_sha256")?;
        retained_cancelled_runs::validate_sha256(&pin.run_catalog_sha256, "run_catalog_sha256")?;
        if let Some(digest) = pin.artifact_catalog_sha256.as_deref() {
            retained_cancelled_runs::validate_sha256(digest, "artifact_catalog_sha256")?;
        }
        if pins_by_run.insert(pin.run_id.clone(), pin).is_some() {
            bail!("retained terminal-run pins contain a duplicate run id");
        }
    }

    let run_ids = pins_by_run.keys().cloned().collect::<Vec<_>>();
    let mut task_count = 0usize;
    for run_id in run_ids {
        let pin = pins_by_run
            .get(&run_id)
            .context("retained terminal-run inventory lost its explicit pin")?;
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
        if crate::cas::hex_sha256(&intent_bytes) != pin.run_intent_sha256 {
            bail!("retained run `{run_id}` run-intent SHA-256 pin does not match");
        }
        let pinned_intent: FmsRunIntent =
            serde_json::from_slice(&intent_bytes).context("parsing pinned terminal run intent")?;
        pinned_intent.validate()?;
        let intent = store
            .read_run_intent(&run_id)?
            .context("pinned terminal run is missing its typed run intent")?;
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
        if crate::cas::hex_sha256(&catalog_bytes) != pin.run_catalog_sha256 {
            bail!("retained run `{run_id}` run-catalog SHA-256 pin does not match");
        }
        let pinned_catalog: FmsRunCatalog = serde_json::from_slice(&catalog_bytes)
            .context("parsing pinned terminal run catalog")?;
        pinned_catalog.validate()?;
        let catalog = store
            .read_run_catalog(&run_id)?
            .context("pinned terminal run is missing its typed run catalog")?;
        if catalog != pinned_catalog || catalog.run_id != run_id || intent.run_id != catalog.run_id
        {
            bail!("retained run catalog changed after its pinned bytes were read");
        }
        if catalog.tasks.is_empty() {
            bail!("retained run `{run_id}` has no terminal tasks to preserve");
        }
        task_count = task_count
            .checked_add(catalog.tasks.len())
            .context("retained terminal-run task count overflow")?;
        if task_count > MAX_RETAINED_CANCELLED_TASKS {
            bail!("retained terminal-run preflight exceeds its task limit");
        }

        let mut tasks = BTreeMap::<String, FmsTaskCatalogEntry>::new();
        for task in &catalog.tasks {
            if !matches!(
                task.lifecycle,
                FmsTaskLifecycle::Succeeded
                    | FmsTaskLifecycle::Failed
                    | FmsTaskLifecycle::Cancelled
            ) {
                bail!(
                    "retained run `{run_id}` task `{}` is not in an explicit terminal lifecycle",
                    task.task_id
                );
            }
            if task.attempt_id.is_some() != task.ownership_epoch.is_some() {
                bail!("retained terminal task has a partial attempt identity");
            }
            match task.attempt_id.as_deref() {
                Some(_) if task.resource_id.is_none() || task.coordinator_watermark.is_none() => {
                    bail!("claimed terminal task is missing resource or coordinator state")
                }
                None if task.lifecycle != FmsTaskLifecycle::Cancelled
                    || task.resource_id.is_some()
                    || task.resolved_input_fingerprint.is_some()
                    || task.coordinator_watermark.is_some()
                    || task.coordinator_genesis.is_some() =>
                {
                    bail!("only an unclaimed cancelled task may lack an attempt")
                }
                _ => {}
            }
            if tasks.insert(task.task_id.clone(), task.clone()).is_some() {
                bail!("retained terminal run contains a duplicate task id");
            }
        }

        let current_tasks = tasks.clone();
        if let Some(history) = histories.iter().find(|pin| pin.run_id == run_id) {
            let historical = super::retained_attempt_histories::read_historical_tasks(
                store, history, &catalog, budget, referenced_object_refs,
            )?;
            for task in historical {
                let key = format!("{}/{}", task.task_id, task.attempt_id.as_deref().context("historical claim has no attempt")?);
                if tasks.insert(key, task).is_some() { bail!("historical claim key is duplicated"); }
            }
        }
        let solver_leases = read_solver_leases(store, &run_id, &tasks, budget)?;
        read_preparation_leases(store, &run_id, &current_tasks, budget)?;
        validate_cancellation_intents(store, &run_id, &current_tasks, catalog.revision, budget)?;
        validate_task_admissions(
            store,
            &run_id,
            &tasks,
            catalog.revision,
            &solver_leases,
            referenced_object_refs,
            budget,
        )?;
        let journals = read_coordinator_journals(store, &run_id, &tasks, &solver_leases, budget)?;
        let inboxes = read_worker_inboxes(store, &run_id, &tasks, &solver_leases, budget)?;
        validate_terminal_streams(
            store,
            &run_id,
            &tasks,
            &journals,
            &inboxes,
            &solver_leases,
            budget,
        )?;
        if histories.iter().any(|pin| pin.run_id == run_id) {
            validate_history_worker_exits(store, &run_id, &tasks, &current_tasks, &solver_leases, budget)?;
        }
        validate_artifact_catalog(
            store,
            &run_id,
            pin,
            &current_tasks,
            &solver_leases,
            referenced_object_refs,
            budget,
        )?;
    }

    Ok(task_count)
}

fn read_solver_leases(
    store: &SessionStore,
    run_id: &str,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    budget: &mut ReadBudget,
) -> Result<BTreeMap<ClaimKey, FmsResourceLease>> {
    let relative = format!("runs/{run_id}/resource_leases");
    let Some(directory) = retained_cancelled_runs::optional_directory(store.root(), &relative)?
    else {
        return Ok(BTreeMap::new());
    };
    let mut leases = BTreeMap::new();
    for resource_entry in fs::read_dir(directory)? {
        let resource_entry = resource_entry?;
        budget.observe_entry()?;
        reject_link(&resource_entry.path())?;
        if !resource_entry.file_type()?.is_dir() {
            bail!("terminal-run solver-lease resource entry is not a directory");
        }
        let resource_id = resource_entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("terminal-run solver resource id is not UTF-8"))?;
        validate_store_id(&resource_id)?;
        for lease_entry in fs::read_dir(resource_entry.path())? {
            let lease_entry = lease_entry?;
            budget.observe_entry()?;
            reject_link(&lease_entry.path())?;
            if !lease_entry.file_type()?.is_file() {
                bail!("terminal-run solver-lease directory contains a non-file entry");
            }
            let name = lease_entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("terminal-run solver lease filename is not UTF-8"))?;
            let token = name
                .strip_suffix(".json")
                .context("terminal-run solver lease filename must end in .json")?;
            validate_store_id(token)?;
            let lease_relative = format!("{relative}/{resource_id}/{name}");
            budget.observe_file(
                store.root(),
                &lease_relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            )?;
            let lease = store
                .read_resource_lease(run_id, &resource_id, token)?
                .context("listed terminal-run solver lease disappeared during preflight")?;
            if lease.run_id != run_id
                || lease.resource_id != resource_id
                || lease.lease_token != token
            {
                bail!("terminal-run solver lease identity differs from its path");
            }
            if lease.state != FmsResourceLeaseState::Released {
                bail!("retained terminal run `{run_id}` has an active solver lease");
            }
            let task = claim_task(tasks, &lease.task_id, &lease.attempt_id, lease.ownership_epoch, Some(&lease.resource_id))?;
            let _ = task;
            let key = (
                lease.task_id.clone(),
                lease.attempt_id.clone(),
                lease.ownership_epoch,
                lease.resource_id.clone(),
            );
            if leases.insert(key, lease).is_some() {
                bail!("terminal-run solver lease inventory duplicates a task claim");
            }
        }
    }
    for task in tasks.values().filter(|task| task.attempt_id.is_some()) {
        let key = (
            task.task_id.clone(),
            task.attempt_id
                .clone()
                .context("claimed task lost its attempt id")?,
            task.ownership_epoch
                .context("claimed task lost its ownership epoch")?,
            task.resource_id
                .clone()
                .context("claimed task lost its resource id")?,
        );
        if !leases.contains_key(&key) {
            bail!("claimed terminal task is missing its released solver lease");
        }
    }
    Ok(leases)
}

fn validate_history_worker_exits(
    store: &SessionStore,
    run_id: &str,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    current: &BTreeMap<String, FmsTaskCatalogEntry>,
    leases: &BTreeMap<ClaimKey, FmsResourceLease>,
    budget: &mut ReadBudget,
) -> Result<()> {
    let relative = format!("runs/{run_id}/worker_process_exit_receipts");
    let directory = retained_cancelled_runs::optional_directory(store.root(), &relative)?.context("historical claims require worker exit receipts")?;
    let mut seen = BTreeSet::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        reject_link(&entry.path())?;
        let name = entry.file_name().into_string().map_err(|_| anyhow::anyhow!("worker exit name is not UTF-8"))?;
        let id = name.strip_suffix(".json").context("worker exit receipt must be JSON")?;
        validate_store_id(id)?;
        budget.observe_file(store.root(), &format!("{relative}/{name}"), MAX_JOURNAL_BYTES)?;
        let receipt = store.read_worker_process_exit_receipt(run_id, id)?.context("worker exit receipt disappeared")?;
        let task = claim_task(tasks, &receipt.task_id, &receipt.attempt_id, receipt.ownership_epoch, Some(&receipt.resource_id))?;
        receipt.validate_for_task(task)?;
        let key = (receipt.task_id.clone(), receipt.attempt_id.clone(), receipt.ownership_epoch, receipt.resource_id.clone());
        let lease = leases.get(&key).context("worker exit has no released claim lease")?;
        if receipt.run_id != run_id || receipt.resource_id != lease.resource_id || receipt.lease_token != lease.lease_token
            || receipt.lease_heartbeat_sequence != lease.heartbeat_sequence || !seen.insert(key) {
            bail!("worker exit history is ambiguous or differs from its released lease");
        }
    }
    for (id, task) in tasks {
        if current.contains_key(id) { continue; }
        let key = (task.task_id.clone(), task.attempt_id.clone().context("historical task has no attempt")?, task.ownership_epoch.context("historical task has no epoch")?, task.resource_id.clone().context("historical task has no resource")?);
        if !seen.contains(&key) { bail!("historical attempt has no exact worker exit"); }
        let receipt = read_matching_worker_exit_receipt(store, run_id, task, tasks, leases.get(&key).context("historical lease disappeared")?, budget)?;
        if receipt.status_success || !receipt.exit_code.is_some_and(|code| code != 0) || receipt.timed_out
            || receipt.process_start_token.as_deref().is_none_or(str::is_empty) {
            bail!("v5 historical failed attempt requires an observed nonzero worker exit");
        }
    }
    Ok(())
}

fn read_preparation_leases(
    store: &SessionStore,
    run_id: &str,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    budget: &mut ReadBudget,
) -> Result<()> {
    // Preparation leases use their own preparation_attempt_id namespace; the
    // one-compute-attempt v3 bound does not reject released preparation history.
    let relative = format!("runs/{run_id}/preparation_resource_leases");
    let Some(directory) = retained_cancelled_runs::optional_directory(store.root(), &relative)?
    else {
        return Ok(());
    };
    for resource_entry in fs::read_dir(directory)? {
        let resource_entry = resource_entry?;
        budget.observe_entry()?;
        reject_link(&resource_entry.path())?;
        if !resource_entry.file_type()?.is_dir() {
            bail!("terminal-run preparation-lease resource entry is not a directory");
        }
        let resource_id = resource_entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("terminal-run preparation resource id is not UTF-8"))?;
        validate_store_id(&resource_id)?;
        for lease_entry in fs::read_dir(resource_entry.path())? {
            let lease_entry = lease_entry?;
            budget.observe_entry()?;
            reject_link(&lease_entry.path())?;
            if !lease_entry.file_type()?.is_file() {
                bail!("terminal-run preparation-lease directory contains a non-file entry");
            }
            let name = lease_entry.file_name().into_string().map_err(|_| {
                anyhow::anyhow!("terminal-run preparation lease filename is not UTF-8")
            })?;
            let token = name
                .strip_suffix(".json")
                .context("terminal-run preparation lease filename must end in .json")?;
            validate_store_id(token)?;
            let lease_relative = format!("{relative}/{resource_id}/{name}");
            budget.observe_file(
                store.root(),
                &lease_relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            )?;
            let lease: FmsPreparationResourceLease = store
                .read_preparation_resource_lease(run_id, &resource_id, token)?
                .context("listed terminal-run preparation lease disappeared during preflight")?;
            if lease.run_id != run_id
                || lease.resource_id != resource_id
                || lease.lease_token != token
                || !tasks.contains_key(&lease.task_id)
            {
                bail!("terminal-run preparation lease identity differs from its task or path");
            }
            if lease.state != FmsResourceLeaseState::Released {
                bail!("retained terminal run `{run_id}` has an active preparation lease");
            }
        }
    }
    Ok(())
}

fn validate_cancellation_intents(
    store: &SessionStore,
    run_id: &str,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    catalog_revision: u64,
    budget: &mut ReadBudget,
) -> Result<()> {
    let relative = format!("runs/{run_id}/task_cancellation_intents");
    let mut found = BTreeSet::new();
    if let Some(directory) = retained_cancelled_runs::optional_directory(store.root(), &relative)? {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            budget.observe_entry()?;
            reject_link(&entry.path())?;
            if !entry.file_type()?.is_file() {
                bail!("terminal-run cancellation-intent namespace contains a non-file entry");
            }
            let name = entry.file_name().into_string().map_err(|_| {
                anyhow::anyhow!("terminal-run cancellation-intent filename is not UTF-8")
            })?;
            let task_id = name
                .strip_suffix(".json")
                .context("terminal-run cancellation-intent filename must end in .json")?;
            validate_store_id(task_id)?;
            let task = tasks
                .get(task_id)
                .context("terminal-run cancellation intent refers to an unlisted task")?;
            if task.lifecycle != FmsTaskLifecycle::Cancelled
                || task.attempt_id.is_some()
                || !found.insert(task_id.to_owned())
            {
                bail!("terminal-run cancellation intent is not an exact pre-claim cancellation");
            }
            let path = format!("{relative}/{name}");
            budget.observe_file(store.root(), &path, 256 * 1024)?;
            let intent = store
                .read_task_cancellation_intent(run_id, task_id)?
                .context("listed terminal-run cancellation intent disappeared")?;
            let mut expected_task = intent.task.clone();
            expected_task.lifecycle = FmsTaskLifecycle::Cancelled;
            if expected_task != *task {
                bail!("terminal cancelled task differs from its cancellation snapshot");
            }
            intent.validate_task_scope(store, task, catalog_revision)?;
        }
    }
    for task in tasks
        .values()
        .filter(|task| task.lifecycle == FmsTaskLifecycle::Cancelled && task.attempt_id.is_none())
    {
        if !found.contains(&task.task_id) {
            bail!("unclaimed cancelled task is missing its cancellation intent");
        }
    }
    Ok(())
}

fn validate_task_admissions(
    store: &SessionStore,
    run_id: &str,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    catalog_revision: u64,
    solver_leases: &BTreeMap<ClaimKey, FmsResourceLease>,
    referenced_object_refs: &mut BTreeSet<String>,
    budget: &mut ReadBudget,
) -> Result<()> {
    let relative = format!("runs/{run_id}/task_admissions");
    let Some(directory) = retained_cancelled_runs::optional_directory(store.root(), &relative)?
    else {
        if tasks.values().any(|task| task.attempt_id.is_some()) {
            bail!("claimed terminal task is missing its task-admission record");
        }
        return Ok(());
    };
    let mut admitted = BTreeSet::new();
    for task_entry in fs::read_dir(directory)? {
        let task_entry = task_entry?;
        budget.observe_entry()?;
        reject_link(&task_entry.path())?;
        if !task_entry.file_type()?.is_dir() {
            bail!("terminal-run task-admission entry is not a directory");
        }
        let task_id = task_entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("terminal-run task-admission task id is not UTF-8"))?;
        validate_store_id(&task_id)?;
        if !tasks.values().any(|task| task.task_id == task_id) { bail!("terminal-run admission refers to an unlisted task"); }
        let mut task_admissions = 0usize;
        for entry in fs::read_dir(task_entry.path())? {
            let entry = entry?;
            budget.observe_entry()?;
            reject_link(&entry.path())?;
            if !entry.file_type()?.is_file() {
                bail!("terminal-run task-admission directory contains a non-file entry");
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("terminal-run admission filename is not UTF-8"))?;
            let attempt_id = name
                .strip_suffix(".json")
                .context("terminal-run admission filename must end in .json")?;
            validate_store_id(attempt_id)?;
            let admission_relative = format!("{relative}/{task_id}/{name}");
            budget.observe_file(store.root(), &admission_relative, MAX_ADMISSION_BYTES)?;
            let admission: FmsTaskAdmissionRecord = store.read_task_admission(run_id, &task_id, attempt_id)?
                .context("listed terminal-run task admission disappeared")?;
            let task = claim_task(tasks, &task_id, attempt_id, admission.lease.ownership_epoch, Some(&admission.lease.resource_id))
                .context("terminal-run v3 does not support historical compute task admissions")?;
            let key = (task.task_id.clone(), attempt_id.to_owned(), admission.lease.ownership_epoch, admission.lease.resource_id.clone());
            let released = solver_leases.get(&key).context("terminal-run task admission has no matching released solver lease")?;
            if let Some(snapshot) = admission.resolved_inputs_snapshot.as_ref() {
                referenced_object_refs.extend(snapshot.object_refs()?);
            }
            if admission.lease.state != FmsResourceLeaseState::Active
                || !same_lease_identity(&admission.lease, released)
                || admission.task.task_id != task.task_id
                || admission.task.input_fingerprint != task.input_fingerprint
                || admission.task.attempt_id != task.attempt_id
                || admission.task.ownership_epoch != task.ownership_epoch
                || admission.task.resource_id != task.resource_id
                || admission.expected_catalog_revision > catalog_revision
            {
                bail!(
                    "terminal-run task-admission record does not match its released terminal claim"
                );
            }
            if !admitted.insert((task_id.clone(), attempt_id.to_owned())) {
                bail!("terminal-run task has duplicate admission records");
            }
            task_admissions += 1;
        }
        if task_admissions == 0 {
            bail!("terminal-run task-admission directory is empty");
        }
    }
    for task in tasks.values().filter(|task| task.attempt_id.is_some()) {
        if !admitted.contains(&(task.task_id.clone(), task.attempt_id.clone().context("claimed task has no attempt")?)) {
            bail!("claimed terminal task is missing its task-admission record");
        }
    }
    Ok(())
}

fn same_lease_identity(admission: &FmsResourceLease, released: &FmsResourceLease) -> bool {
    admission.schema_version == released.schema_version
        && admission.resource_id == released.resource_id
        && admission.kind == released.kind
        && admission.budget == released.budget
        && admission.run_id == released.run_id
        && admission.task_id == released.task_id
        && admission.attempt_id == released.attempt_id
        && admission.ownership_epoch == released.ownership_epoch
        && admission.lease_token == released.lease_token
        && admission.host_launch_binding == released.host_launch_binding
}

fn read_coordinator_journals(
    store: &SessionStore,
    run_id: &str,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    leases: &BTreeMap<ClaimKey, FmsResourceLease>,
    budget: &mut ReadBudget,
) -> Result<BTreeMap<JournalKey, Vec<FmsCoordinatorJournalEntry>>> {
    let relative = format!("runs/{run_id}/coordinator_journal");
    let Some(root) = retained_cancelled_runs::optional_directory(store.root(), &relative)? else {
        if tasks.values().any(|task| task.attempt_id.is_some()) {
            bail!("claimed terminal task is missing its coordinator journal");
        }
        return Ok(BTreeMap::new());
    };
    let mut journals = BTreeMap::<JournalKey, Vec<FmsCoordinatorJournalEntry>>::new();
    for stream_entry in fs::read_dir(root)? {
        let stream_entry = stream_entry?;
        budget.observe_entry()?;
        reject_link(&stream_entry.path())?;
        if !stream_entry.file_type()?.is_dir() {
            bail!("terminal-run coordinator journal root contains a non-directory entry");
        }
        let direction_name = stream_entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("terminal-run journal direction is not UTF-8"))?;
        let direction = match direction_name.as_str() {
            "command" => FmsCoordinatorJournalDirection::Command,
            "event" => FmsCoordinatorJournalDirection::Event,
            _ => bail!("terminal-run coordinator journal has an unknown stream"),
        };
        for entry in fs::read_dir(stream_entry.path())? {
            let entry = entry?;
            budget.observe_entry()?;
            reject_link(&entry.path())?;
            if !entry.file_type()?.is_file() {
                bail!("terminal-run coordinator journal stream contains a non-file entry");
            }
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| anyhow::anyhow!("terminal-run journal filename is not UTF-8"))?;
            let entry_id = name
                .strip_suffix(".json")
                .context("terminal-run journal filename must end in .json")?;
            validate_store_id(entry_id)?;
            let file_relative = format!("{relative}/{direction_name}/{name}");
            budget.observe_file(store.root(), &file_relative, MAX_JOURNAL_BYTES)?;
            let bytes = read_bounded_regular_file(store.root(), &file_relative, MAX_JOURNAL_BYTES)?;
            let journal: FmsCoordinatorJournalEntry = serde_json::from_slice(&bytes)
                .context("parse terminal-run coordinator journal entry")?;
            journal.validate()?;
            if journal.run_id != run_id
                || journal.direction != direction
                || journal.entry_id != entry_id
            {
                bail!("terminal-run coordinator journal path identity mismatch");
            }
            let task = claim_task(tasks, &journal.task_id, &journal.attempt_id, journal.ownership_epoch, None)?;
            journal.validate_for_task(task)?;
            let key = (
                journal.task_id.clone(),
                journal.attempt_id.clone(),
                journal.ownership_epoch,
                task.resource_id
                    .clone()
                    .context("journal task has no resource id")?,
            );
            let lease = leases
                .get(&key)
                .context("terminal-run journal has no matching released lease")?;
            if journal.lease_token != lease.lease_token {
                bail!("terminal-run journal lease token differs from released lease");
            }
            journals
                .entry((journal.task_id.clone(), journal.attempt_id.clone(), direction.as_str().to_owned()))
                .or_default()
                .push(journal);
        }
    }
    for stream in journals.values_mut() {
        stream.sort_by_key(|entry| entry.sequence);
        for (index, entry) in stream.iter().enumerate() {
            if entry.sequence != u64::try_from(index + 1)? {
                bail!("terminal-run coordinator journal stream has a gap or duplicate sequence");
            }
            if index > 0 && stream[index - 1].terminal {
                bail!("terminal-run coordinator journal contains an entry after terminal");
            }
        }
    }
    Ok(journals)
}

fn read_worker_inboxes(
    store: &SessionStore,
    run_id: &str,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    leases: &BTreeMap<ClaimKey, FmsResourceLease>,
    budget: &mut ReadBudget,
) -> Result<BTreeMap<InboxKey, FmsWorkerInboxRecord>> {
    let relative = format!("runs/{run_id}/worker_inbox");
    let Some(directory) = retained_cancelled_runs::optional_directory(store.root(), &relative)?
    else {
        return Ok(BTreeMap::new());
    };
    let mut inboxes = BTreeMap::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        budget.observe_entry()?;
        reject_link(&entry.path())?;
        if !entry.file_type()?.is_file() {
            bail!("terminal-run worker inbox contains a non-file entry");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("terminal-run worker inbox filename is not UTF-8"))?;
        let entry_id = name
            .strip_suffix(".json")
            .context("terminal-run worker inbox filename must end in .json")?;
        validate_store_id(entry_id)?;
        let file_relative = format!("{relative}/{name}");
        budget.observe_file(store.root(), &file_relative, MAX_JOURNAL_BYTES)?;
        let bytes = read_bounded_regular_file(store.root(), &file_relative, MAX_JOURNAL_BYTES)?;
        let inbox: FmsWorkerInboxRecord =
            serde_json::from_slice(&bytes).context("parse terminal-run worker inbox")?;
        inbox.validate()?;
        if inbox.relative_path()? != file_relative {
            bail!("terminal-run worker inbox path identity mismatch");
        }
        let claim = inbox
            .payload
            .get("claim")
            .and_then(Value::as_object)
            .context("terminal-run worker inbox has no claim object")?;
        let task_id = claim
            .get("task_id")
            .and_then(Value::as_str)
            .context("terminal-run worker inbox claim has no task id")?;
        let attempt_id = claim.get("attempt_id").and_then(Value::as_str).context("worker inbox has no attempt")?;
        let epoch = claim.get("ownership_epoch").and_then(Value::as_u64).context("worker inbox has no epoch")?;
        let task = claim_task(tasks, task_id, attempt_id, epoch, None)?;
        let resource_id = task
            .resource_id
            .as_deref()
            .context("terminal-run worker inbox task has no resource id")?;
        let lease = leases
            .get(&(
                task.task_id.clone(),
                attempt_id.to_owned(),
                epoch,
                resource_id.to_owned(),
            ))
            .context("terminal-run worker inbox has no matching released lease")?;
        if claim.get("run_id").and_then(Value::as_str) != Some(run_id)
            || claim.get("attempt_id").and_then(Value::as_str) != Some(attempt_id)
            || claim.get("ownership_epoch").and_then(Value::as_u64) != Some(epoch)
            || claim.get("lease_token").and_then(Value::as_str) != Some(lease.lease_token.as_str())
            || !inbox.payload.get("pending").is_some_and(Value::is_null)
        {
            bail!("terminal-run worker inbox has a pending or mismatched claim");
        }
        if inboxes.insert((task.task_id.clone(), attempt_id.to_owned()), inbox).is_some() {
            bail!("terminal-run task has duplicate worker inbox records");
        }
    }
    Ok(inboxes)
}

fn validate_terminal_streams(
    store: &SessionStore,
    run_id: &str,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    journals: &BTreeMap<JournalKey, Vec<FmsCoordinatorJournalEntry>>,
    inboxes: &BTreeMap<InboxKey, FmsWorkerInboxRecord>,
    leases: &BTreeMap<ClaimKey, FmsResourceLease>,
    budget: &mut ReadBudget,
) -> Result<()> {
    for task in tasks.values() {
        let Some(attempt_id) = task.attempt_id.as_deref() else {
            continue;
        };
        let command = journals
            .get(&(task.task_id.clone(), attempt_id.to_owned(), "command".to_owned()))
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let events = journals
            .get(&(task.task_id.clone(), attempt_id.to_owned(), "event".to_owned()))
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if events.is_empty() {
            bail!(
                "claimed terminal task `{}` has no terminal coordinator event",
                task.task_id
            );
        }
        let command_sequence = u64::try_from(command.len())?;
        let event_sequence = u64::try_from(events.len())?;
        let watermark = task
            .coordinator_watermark
            .context("claimed terminal task has no coordinator watermark")?;
        if watermark.command_sequence != command_sequence
            || watermark.event_sequence != event_sequence
        {
            bail!("terminal task coordinator watermark differs from durable journal streams");
        }
        for entry in command {
            let (checkpoint_command, checkpoint_event) = entry.checkpoint_watermarks()?;
            if checkpoint_command != entry.sequence || checkpoint_event > event_sequence {
                bail!("terminal-run command checkpoint does not match its stream");
            }
            validate_transition_payload(entry, task)?;
        }
        for (index, entry) in events.iter().enumerate() {
            let (checkpoint_command, checkpoint_event) = entry.checkpoint_watermarks()?;
            if checkpoint_event != entry.sequence || checkpoint_command > command_sequence {
                bail!("terminal-run event checkpoint does not match its stream");
            }
            let is_final_event = index + 1 == events.len();
            let event_kind = terminal_event_kind(entry)?;
            if task.lifecycle == FmsTaskLifecycle::Cancelled {
                let is_stopped = event_kind == "stopped";
                if entry.terminal || is_stopped != is_final_event {
                    bail!(
                        "cancelled coordinator stream must end in one nonterminal Stopped record"
                    );
                }
            } else {
                if event_kind == "stopped" {
                    bail!("Stopped coordinator event does not match a cancelled task");
                }
                if entry.terminal != is_final_event {
                    bail!("terminal-run event stream is not closed by exactly one final event");
                }
            }
            validate_transition_payload(entry, task)?;
        }
        let final_event = events.last().context("terminal event stream disappeared")?;
        let (final_command, final_event_sequence) = final_event.checkpoint_watermarks()?;
        if final_command != command_sequence || final_event_sequence != event_sequence {
            bail!("terminal coordinator event does not cover all durable commands");
        }
        if final_event.attempt_id != attempt_id
            || !terminal_event_matches_lifecycle(task.lifecycle, terminal_event_kind(final_event)?)
            || final_event
                .payload
                .pointer("/checkpoint/task/lifecycle")
                .and_then(Value::as_str)
                != Some(match task.lifecycle {
                    FmsTaskLifecycle::Succeeded => "succeeded",
                    FmsTaskLifecycle::Failed => "failed",
                    FmsTaskLifecycle::Cancelled => "cancelled",
                    _ => "nonterminal",
                })
        {
            bail!("terminal coordinator event does not match the task's terminal lifecycle");
        }
        match (command.is_empty(), inboxes.get(&(task.task_id.clone(), attempt_id.to_owned()))) {
            (true, None) => {}
            (false, Some(inbox)) => {
                let applied = inbox
                    .payload
                    .get("applied")
                    .and_then(Value::as_array)
                    .context("terminal-run worker inbox has no applied command list")?;
                if applied.len() > command.len() {
                    bail!("terminal-run worker inbox contains commands absent from its journal");
                }
                for (entry, applied) in command.iter().take(applied.len()).zip(applied) {
                    let envelope = entry
                        .payload
                        .get("message")
                        .and_then(|message| message.get("envelope"))
                        .context("terminal-run command transition has no envelope")?;
                    if applied != envelope {
                        bail!("terminal-run worker inbox does not preserve the exact pinned command envelope");
                    }
                }
                if applied.len() != command.len() {
                    validate_unapplied_heartbeat_suffix(
                        store,
                        run_id,
                        task,
                        command,
                        events,
                        inbox,
                        applied.len(),
                        &tasks,
                        leases,
                        budget,
                    )?;
                }
            }
            (_, None) => bail!("terminal-run command stream has no worker inbox receipt"),
            (true, Some(inbox)) => {
                let applied = inbox
                    .payload
                    .get("applied")
                    .and_then(Value::as_array)
                    .context("terminal-run worker inbox has no applied command list")?;
                if !applied.is_empty() {
                    bail!("terminal-run worker inbox contains commands absent from its journal");
                }
            }
        }
        if task.lifecycle == FmsTaskLifecycle::Cancelled {
            validate_claimed_cancelled_task(
                store,
                run_id,
                task,
                command,
                events,
                inboxes.get(&(task.task_id.clone(), attempt_id.to_owned())),
                &tasks,
                leases,
                budget,
            )?;
        }
        if command.iter().any(|entry| entry.attempt_id != attempt_id)
            || events.iter().any(|entry| entry.attempt_id != attempt_id)
        {
            bail!("terminal-run coordinator stream changed task attempt");
        }
    }
    for ((task_id, _, _), _) in journals {
        if !tasks.values().any(|task| &task.task_id == task_id) {
            bail!("terminal-run coordinator journal contains an unlisted task");
        }
    }
    Ok(())
}

/// The accepted-worker supervisor can journal one final Heartbeat after the
/// worker has stopped draining commands. It is safe only for a failed,
/// reaped worker: Heartbeat is a lease-liveness command, not a solver effect;
/// the process-exit receipt and released lease must bind the same claim, and
/// the terminal event must close over the coordinator's complete watermark.
/// This mirrors `classify_final_heartbeat_reconciliation` in
/// `fullmag-api/src/accepted_study_supervisor.rs` without admitting any other
/// unapplied command kind.
#[allow(clippy::too_many_arguments)]
fn validate_unapplied_heartbeat_suffix(
    store: &SessionStore,
    run_id: &str,
    task: &FmsTaskCatalogEntry,
    commands: &[FmsCoordinatorJournalEntry],
    events: &[FmsCoordinatorJournalEntry],
    inbox: &FmsWorkerInboxRecord,
    applied_count: usize,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    leases: &BTreeMap<ClaimKey, FmsResourceLease>,
    budget: &mut ReadBudget,
) -> Result<()> {
    if task.lifecycle != FmsTaskLifecycle::Failed || commands.len() != applied_count + 1 {
        bail!("terminal-run inbox has more than one unapplied command or a non-failed task");
    }
    if inbox
        .payload
        .get("pending")
        .is_some_and(|pending| !pending.is_null())
    {
        bail!("terminal-run worker inbox has an unresolved pending command");
    }

    let attempt_id = task
        .attempt_id
        .as_deref()
        .context("unapplied terminal heartbeat task has no attempt")?;
    let epoch = task
        .ownership_epoch
        .context("unapplied terminal heartbeat task has no ownership epoch")?;
    let resource_id = task
        .resource_id
        .as_deref()
        .context("unapplied terminal heartbeat task has no resource")?;
    let lease = leases
        .get(&(
            task.task_id.clone(),
            attempt_id.to_owned(),
            epoch,
            resource_id.to_owned(),
        ))
        .context("unapplied terminal heartbeat has no matching released lease")?;
    if lease.state != FmsResourceLeaseState::Released {
        bail!("unapplied terminal heartbeat still has an active lease");
    }

    let suffix = commands
        .last()
        .context("terminal coordinator command stream disappeared")?;
    let suffix_command = suffix
        .payload
        .pointer("/message/envelope/command")
        .context("terminal coordinator suffix has no command")?;
    if suffix_command.get("kind").and_then(Value::as_str) != Some("heartbeat") {
        bail!("terminal-run worker inbox has an unapplied non-heartbeat command");
    }
    let heartbeat_sequence = suffix_command
        .get("lease_heartbeat_sequence")
        .and_then(Value::as_u64)
        .context("unapplied terminal heartbeat has no lease sequence")?;
    let expected_heartbeat_sequence = lease
        .heartbeat_sequence
        .checked_add(1)
        .context("terminal heartbeat sequence exhausted")?;
    if heartbeat_sequence != expected_heartbeat_sequence
        || suffix
            .payload
            .pointer("/checkpoint/claim/lease/heartbeat_sequence")
            .and_then(Value::as_u64)
            != Some(heartbeat_sequence)
    {
        bail!("unapplied terminal heartbeat does not match the next released-lease sequence");
    }

    if validate_final_heartbeat_reconciliation(commands, events, lease.heartbeat_sequence)?
        != Some(expected_heartbeat_sequence)
    {
        bail!("terminal-run coordinator heartbeat history is ambiguous");
    }
    let final_event = events
        .last()
        .context("failed terminal run has no final coordinator event")?;
    if final_event
        .payload
        .pointer("/checkpoint/claim/lease/heartbeat_sequence")
        .and_then(Value::as_u64)
        != Some(expected_heartbeat_sequence)
    {
        bail!("final failed event does not retain the unapplied heartbeat claim");
    }

    let receipt = read_matching_worker_exit_receipt(store, run_id, task, tasks, lease, budget)?;
    if receipt.status_success || !receipt.exit_code.is_some_and(|code| code != 0) {
        bail!("unapplied terminal heartbeat requires a failed nonzero process-exit receipt");
    }
    Ok(())
}

pub(super) fn read_matching_worker_exit_receipt(
    store: &SessionStore,
    run_id: &str,
    task: &FmsTaskCatalogEntry,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    lease: &FmsResourceLease,
    budget: &mut ReadBudget,
) -> Result<FmsWorkerProcessExitReceipt> {
    let relative = format!("runs/{run_id}/worker_process_exit_receipts");
    let directory = retained_cancelled_runs::optional_directory(store.root(), &relative)?
        .context("claimed terminal task has no worker process-exit receipt directory")?;
    let current_attempt = task
        .attempt_id
        .as_deref()
        .context("claimed terminal process-exit task has no attempt")?;
    let mut matching = None;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        budget.observe_entry()?;
        reject_link(&entry.path())?;
        if !entry.file_type()?.is_file() {
            bail!("worker process-exit receipt namespace contains a non-file entry");
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("worker process-exit receipt filename is not UTF-8"))?;
        let receipt_id = name
            .strip_suffix(".json")
            .context("worker process-exit receipt filename must end in .json")?;
        validate_store_id(receipt_id)?;
        let file_relative = format!("{relative}/{name}");
        budget.observe_file(store.root(), &file_relative, MAX_JOURNAL_BYTES)?;
        let receipt = store
            .read_worker_process_exit_receipt(run_id, receipt_id)?
            .context("listed worker process-exit receipt disappeared during preflight")?;
        if receipt.run_id != run_id {
            bail!("worker process-exit receipt is stored under the wrong run");
        }
        if !tasks.values().any(|task| task.task_id == receipt.task_id) { bail!("worker process-exit receipt refers to an unlisted terminal task"); }
        let is_current_attempt =
            receipt.task_id == task.task_id && receipt.attempt_id == current_attempt;
        if is_current_attempt {
            receipt.validate_for_task(task)?;
            if matching.replace(receipt).is_some() {
                bail!("failed terminal attempt has ambiguous process-exit receipts");
            }
        }
    }
    let receipt = matching.context("claimed terminal task has no exact process-exit receipt")?;
    if receipt.resource_id != lease.resource_id
        || receipt.lease_token != lease.lease_token
        || receipt.lease_heartbeat_sequence != lease.heartbeat_sequence
    {
        bail!("worker process-exit receipt differs from the released terminal lease");
    }
    Ok(receipt)
}

fn terminal_event_matches_lifecycle(lifecycle: FmsTaskLifecycle, event_kind: &str) -> bool {
    match lifecycle {
        FmsTaskLifecycle::Succeeded => event_kind == "completed",
        FmsTaskLifecycle::Failed => matches!(event_kind, "failed" | "rejected"),
        FmsTaskLifecycle::Cancelled => event_kind == "stopped",
        _ => false,
    }
}

/// Same classification as `classify_final_heartbeat_reconciliation` in the
/// accepted-worker supervisor: older lease heartbeats need ACKs; at most one
/// exact next sequence may remain unacknowledged.
fn validate_final_heartbeat_reconciliation(
    commands: &[FmsCoordinatorJournalEntry],
    events: &[FmsCoordinatorJournalEntry],
    current_lease_sequence: u64,
) -> Result<Option<u64>> {
    let mut pending = Vec::new();
    for entry in commands {
        let envelope = entry
            .payload
            .pointer("/message/envelope")
            .context("terminal coordinator command has no envelope")?;
        if envelope.pointer("/command/kind").and_then(Value::as_str) != Some("heartbeat") {
            continue;
        }
        let sequence = envelope
            .pointer("/command/lease_heartbeat_sequence")
            .and_then(Value::as_u64)
            .context("terminal coordinator heartbeat has no lease sequence")?;
        let acknowledged = events.iter().any(|event| {
            event
                .payload
                .pointer("/message/envelope/event/kind")
                .and_then(Value::as_str)
                == Some("heartbeat_ack")
                && event
                    .payload
                    .pointer("/message/envelope/event/lease_heartbeat_sequence")
                    .and_then(Value::as_u64)
                    == Some(sequence)
        });
        if sequence <= current_lease_sequence {
            if !acknowledged {
                bail!("released lease advanced beyond an unacknowledged heartbeat");
            }
        } else {
            pending.push(sequence);
        }
    }
    if pending.is_empty() {
        return Ok(None);
    }
    let expected = current_lease_sequence
        .checked_add(1)
        .context("accepted worker heartbeat sequence exhausted")?;
    if pending.len() != 1
        || pending[0] != expected
        || events.iter().any(|event| {
            event
                .payload
                .pointer("/message/envelope/event/kind")
                .and_then(Value::as_str)
                == Some("heartbeat_ack")
                && event
                    .payload
                    .pointer("/message/envelope/event/lease_heartbeat_sequence")
                    .and_then(Value::as_u64)
                    == Some(expected)
        })
    {
        bail!("accepted worker exited with an ambiguous final heartbeat history");
    }
    Ok(Some(expected))
}

/// A claimed cancellation is recoverable only after the accepted worker
/// supervisor observed the applied Stop, reaped that exact process, published
/// the nonterminal-flagged Stopped coordinator event, and released its exact
/// lease. Pre-spawn cancellation has no process-exit receipt and remains
/// outside this v3 terminal recovery shape.
#[allow(clippy::too_many_arguments)]
fn validate_claimed_cancelled_task(
    store: &SessionStore,
    run_id: &str,
    task: &FmsTaskCatalogEntry,
    commands: &[FmsCoordinatorJournalEntry],
    events: &[FmsCoordinatorJournalEntry],
    inbox: Option<&FmsWorkerInboxRecord>,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    leases: &BTreeMap<ClaimKey, FmsResourceLease>,
    budget: &mut ReadBudget,
) -> Result<()> {
    let inbox = inbox.context("claimed cancelled task has no worker inbox receipt")?;
    let applied = inbox
        .payload
        .get("applied")
        .and_then(Value::as_array)
        .context("claimed cancelled task inbox has no applied command list")?;
    if commands.is_empty() || applied.len() != commands.len() {
        bail!("claimed cancelled task must have every coordinator command applied");
    }
    let mut stop_count = 0usize;
    for entry in commands {
        let command = entry
            .payload
            .pointer("/message/envelope/command")
            .context("claimed cancelled task command stream has an invalid entry")?;
        if command.get("kind").and_then(Value::as_str) == Some("stop") {
            stop_count += 1;
            if command
                .get("reason")
                .and_then(Value::as_str)
                .is_none_or(|reason| reason.trim().is_empty())
            {
                bail!("claimed cancelled task Stop command has no reason");
            }
        }
    }
    if stop_count != 1
        || commands
            .last()
            .and_then(|entry| entry.payload.pointer("/message/envelope/command/kind"))
            .and_then(Value::as_str)
            != Some("stop")
    {
        bail!("claimed cancelled task requires one final applied Stop command");
    }

    let attempt_id = task
        .attempt_id
        .as_deref()
        .context("claimed cancelled task has no attempt")?;
    let epoch = task
        .ownership_epoch
        .context("claimed cancelled task has no ownership epoch")?;
    let resource_id = task
        .resource_id
        .as_deref()
        .context("claimed cancelled task has no resource id")?;
    let lease = leases
        .get(&(
            task.task_id.clone(),
            attempt_id.to_owned(),
            epoch,
            resource_id.to_owned(),
        ))
        .context("claimed cancelled task has no matching released lease")?;
    if lease.state != FmsResourceLeaseState::Released {
        bail!("claimed cancelled task still has an active lease");
    }
    let receipt = read_matching_worker_exit_receipt(store, run_id, task, tasks, lease, budget)?;
    if !receipt.stop_requested {
        bail!("claimed cancelled task process-exit receipt did not observe Stop");
    }
    if validate_final_heartbeat_reconciliation(commands, events, lease.heartbeat_sequence)?
        .is_some()
        && receipt.status_success
    {
        bail!("successful cancelled worker exit has an unacknowledged heartbeat");
    }
    Ok(())
}

fn terminal_event_kind(entry: &FmsCoordinatorJournalEntry) -> Result<&str> {
    entry
        .payload
        .get("message")
        .and_then(|message| message.get("envelope"))
        .and_then(|envelope| envelope.get("event"))
        .and_then(|event| event.get("kind"))
        .and_then(Value::as_str)
        .context("terminal coordinator event has no typed worker event kind")
}

fn validate_transition_payload(
    entry: &FmsCoordinatorJournalEntry,
    task: &FmsTaskCatalogEntry,
) -> Result<()> {
    if entry.payload.get("schema_version").and_then(Value::as_str)
        != Some("coordinator_transition.v1")
    {
        bail!("terminal-run coordinator transition has an unsupported schema");
    }
    let checkpoint = entry
        .payload
        .get("checkpoint")
        .context("terminal-run coordinator transition has no checkpoint")?;
    let (command_sequence, event_sequence) = entry.checkpoint_watermarks()?;
    if checkpoint.get("schema_version").and_then(Value::as_str) != Some("coordinator_checkpoint.v1")
        || checkpoint.get("command_sequence").and_then(Value::as_u64) != Some(command_sequence)
        || checkpoint.get("event_sequence").and_then(Value::as_u64) != Some(event_sequence)
    {
        bail!("terminal-run transition checkpoint differs from its journal watermarks");
    }
    let expected_attempt = task
        .attempt_id
        .as_deref()
        .context("terminal-run transition task has no attempt")?;
    let expected_epoch = task
        .ownership_epoch
        .context("terminal-run transition task has no ownership epoch")?;
    let expected_resource = task
        .resource_id
        .as_deref()
        .context("terminal-run transition task has no resource")?;
    let checkpoint_claim = checkpoint
        .get("claim")
        .context("coordinator checkpoint has no claim")?;
    let envelope_claim = entry
        .payload
        .get("message")
        .and_then(|message| message.get("envelope"))
        .and_then(|envelope| envelope.get("claim"))
        .context("coordinator transition envelope has no claim")?;
    for claim in [checkpoint_claim, envelope_claim] {
        if claim.get("run_id").and_then(Value::as_str) != Some(entry.run_id.as_str())
            || claim.get("task_id").and_then(Value::as_str) != Some(task.task_id.as_str())
            || claim.get("attempt_id").and_then(Value::as_str) != Some(expected_attempt)
            || claim.get("ownership_epoch").and_then(Value::as_u64) != Some(expected_epoch)
        {
            bail!("terminal-run transition claim differs from its journal fence");
        }
    }
    if envelope_claim.get("lease_token").and_then(Value::as_str) != Some(entry.lease_token.as_str())
    {
        bail!("terminal-run coordinator message lease token differs from its journal fence");
    }
    let checkpoint_lease = checkpoint
        .get("claim")
        .and_then(|claim| claim.get("lease"))
        .context("terminal-run coordinator checkpoint has no lease")?;
    if checkpoint_lease.get("resource_id").and_then(Value::as_str) != Some(expected_resource)
        || checkpoint_lease.get("lease_token").and_then(Value::as_str)
            != Some(entry.lease_token.as_str())
    {
        bail!("terminal-run coordinator checkpoint lease differs from its durable lease");
    }
    let checkpoint_task = checkpoint
        .get("task")
        .context("terminal-run coordinator checkpoint has no task")?;
    if checkpoint_task.get("run_id").and_then(Value::as_str) != Some(entry.run_id.as_str())
        || checkpoint_task.get("task_id").and_then(Value::as_str) != Some(task.task_id.as_str())
        || checkpoint_task.get("attempt_id").and_then(Value::as_str) != Some(expected_attempt)
        || checkpoint_task
            .get("ownership_epoch")
            .and_then(Value::as_u64)
            != Some(expected_epoch)
    {
        bail!("terminal-run coordinator checkpoint task differs from its catalog pin");
    }
    let message = entry
        .payload
        .get("message")
        .context("terminal-run coordinator transition has no message")?;
    let expected_direction = entry.direction.as_str();
    let envelope = message
        .get("envelope")
        .context("terminal-run coordinator message has no envelope")?;
    let message_id = envelope
        .get("message_id")
        .and_then(Value::as_str)
        .context("terminal-run coordinator envelope has no message id")?;
    if message.get("direction").and_then(Value::as_str) != Some(expected_direction)
        || message_id != entry.entry_id
        || envelope.get("sequence").and_then(Value::as_u64) != Some(entry.sequence)
        || !matches!(
            envelope.get("schema_version").and_then(Value::as_str),
            Some(
                "worker_protocol.v1"
                    | "worker_protocol.v2"
                    | "worker_protocol.v3"
                    | "worker_protocol.v4"
            )
        )
    {
        bail!("terminal-run coordinator envelope differs from its journal path");
    }
    match entry.direction {
        FmsCoordinatorJournalDirection::Command => {
            if envelope.get("command").is_none() || envelope.get("event").is_some() {
                bail!("terminal-run command journal has a non-command envelope");
            }
            let kind = envelope
                .pointer("/command/kind")
                .and_then(Value::as_str)
                .context("terminal-run command has no kind")?;
            if !matches!(kind, "prepare" | "start" | "heartbeat" | "stop" | "release") {
                bail!("terminal-run command has an unknown kind");
            }
        }
        FmsCoordinatorJournalDirection::Event => {
            if envelope.get("event").is_none() || envelope.get("command").is_some() {
                bail!("terminal-run event journal has a non-event envelope");
            }
            let event = envelope
                .get("event")
                .context("terminal-run event has no payload")?;
            let kind = event
                .get("kind")
                .and_then(Value::as_str)
                .context("terminal-run event has no kind")?;
            let terminal_kind = match kind {
                "accepted" | "prepared" | "started" | "heartbeat_ack" | "progress"
                | "completing" | "stopped" => false,
                "completed" | "failed" | "rejected" => true,
                _ => bail!("terminal-run event has an unknown kind"),
            };
            if entry.terminal != terminal_kind {
                bail!("terminal-run event terminal flag differs from its event kind");
            }
            match kind {
                "heartbeat_ack"
                    if event
                        .get("lease_heartbeat_sequence")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        == 0 =>
                {
                    bail!("terminal-run heartbeat event has no positive lease sequence")
                }
                "progress"
                    if event
                        .get("source_step")
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                        == 0 =>
                {
                    bail!("terminal-run progress event has no positive source step")
                }
                "completed" if event.get("assessment").is_none() => {
                    bail!("terminal-run completed event has no assessment")
                }
                "failed"
                    if event
                        .get("reason")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty)
                        || event.get("retryable").and_then(Value::as_bool).is_none() =>
                {
                    bail!("terminal-run failed event is incomplete")
                }
                "rejected"
                    if event
                        .get("reason")
                        .and_then(Value::as_str)
                        .is_none_or(str::is_empty) =>
                {
                    bail!("terminal-run rejected event has no reason")
                }
                _ => {}
            }
        }
    }
    Ok(())
}

fn validate_artifact_catalog(
    store: &SessionStore,
    run_id: &str,
    pin: &RetainedTerminalRunPin,
    tasks: &BTreeMap<String, FmsTaskCatalogEntry>,
    solver_leases: &BTreeMap<ClaimKey, FmsResourceLease>,
    referenced_object_refs: &mut BTreeSet<String>,
    budget: &mut ReadBudget,
) -> Result<()> {
    let relative = format!("runs/{run_id}/artifact_catalog.json");
    let path = checked_path(store.root(), &relative)?;
    let bytes = match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            reject_link(&path)?;
            if !metadata.is_file() {
                bail!("terminal-run artifact catalog path is not a regular file");
            }
            budget.observe_file(
                store.root(),
                &relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            )?;
            Some(read_bounded_regular_file(
                store.root(),
                &relative,
                crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize,
            )?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error).context("checking terminal-run artifact catalog"),
    };
    let Some(bytes) = bytes else {
        if pin.artifact_catalog_sha256.is_some()
            || tasks.values().any(|task| !task.artifact_ids.is_empty())
        {
            bail!("terminal run is missing its pinned artifact catalog");
        }
        return Ok(());
    };
    let expected_sha = pin
        .artifact_catalog_sha256
        .as_deref()
        .context("terminal run has an unpinned artifact catalog")?;
    if crate::cas::hex_sha256(&bytes) != expected_sha {
        bail!("retained run `{run_id}` artifact-catalog SHA-256 pin does not match");
    }
    let pinned_catalog: FmsArtifactCatalog =
        serde_json::from_slice(&bytes).context("parse pinned terminal-run artifact catalog")?;
    pinned_catalog.validate()?;
    let catalog = store
        .read_artifact_catalog(run_id)?
        .context("pinned terminal run artifact catalog disappeared")?;
    if catalog != pinned_catalog || catalog.run_id != run_id {
        bail!("terminal-run artifact catalog changed after its pinned bytes were read");
    }

    let mut artifact_ids_by_task = BTreeMap::<String, BTreeSet<String>>::new();
    for entry in &catalog.entries {
        let task = tasks
            .get(&entry.task_id)
            .context("terminal-run artifact refers to an unlisted task")?;
        let attempt_id = task
            .attempt_id
            .as_deref()
            .context("terminal-run artifact belongs to an unclaimed task")?;
        let epoch = task
            .ownership_epoch
            .context("terminal-run artifact task has no ownership epoch")?;
        let resource_id = task
            .resource_id
            .as_deref()
            .context("terminal-run artifact task has no resource id")?;
        let lease = solver_leases
            .get(&(
                task.task_id.clone(),
                attempt_id.to_owned(),
                epoch,
                resource_id.to_owned(),
            ))
            .context("terminal-run artifact has no matching released task lease")?;
        if entry.attempt_id != attempt_id || entry.ownership_epoch != epoch {
            bail!("terminal-run artifact does not match the task's pinned attempt");
        }
        let _ = lease;
        match entry.status {
            FmsArtifactStatus::Published => {
                let object_ref = entry
                    .object_ref
                    .as_deref()
                    .context("published terminal-run artifact has no CAS object reference")?;
                if object_ref != entry.content_sha256 {
                    bail!("published terminal-run artifact digest differs from its CAS reference");
                }
                referenced_object_refs.insert(object_ref.to_owned());
            }
            FmsArtifactStatus::Unavailable | FmsArtifactStatus::Failed => {
                if entry.object_ref.is_some() {
                    bail!("unpublished terminal-run artifact unexpectedly references CAS content");
                }
            }
        }
        artifact_ids_by_task
            .entry(entry.task_id.clone())
            .or_default()
            .insert(entry.artifact_id.clone());
    }
    for (task_id, task) in tasks {
        let discovered = artifact_ids_by_task.remove(task_id).unwrap_or_default();
        let declared = task.artifact_ids.iter().cloned().collect::<BTreeSet<_>>();
        if declared.len() != task.artifact_ids.len() || declared != discovered {
            bail!("terminal-run task artifact references differ from its pinned catalog");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use std::path::Path;
    use tempfile::TempDir;

    use crate::types::{
        FmsCoordinatorWatermark, FmsObservationState, FmsPreparationResourceLease,
        FmsResourceBudget, FmsResourceKind, FmsRunCatalog, FmsTaskReadiness,
        FMS_COORDINATOR_JOURNAL_SCHEMA, FMS_PREPARATION_RESOURCE_LEASE_SCHEMA,
        FMS_RESOURCE_LEASE_SCHEMA, FMS_RUN_CATALOG_SCHEMA, FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA,
    };

    const RUN_ID: &str = "run-terminal";
    const TASK_ID: &str = "task-terminal";
    const ATTEMPT_ID: &str = "attempt-terminal";
    const RESOURCE_ID: &str = "resource-terminal";
    const LEASE_TOKEN: &str = "lease-terminal";

    struct Fixture {
        _directory: TempDir,
        store: SessionStore,
        pin: RetainedTerminalRunPin,
        catalog: FmsRunCatalog,
        lease: FmsResourceLease,
    }

    fn write_json(path: &Path, value: &impl Serialize) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
    }

    fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        fs::create_dir_all(store.root().join("objects/pins")).unwrap();
        let input_ref = store.cas().put(b"immutable accepted input").unwrap();
        let specification = serde_json::json!({
            "snapshot": { "definition_sha256": input_ref.clone() },
            "immutable_assets": []
        });
        let mut intent = FmsRunIntent::new(RUN_ID, "idempotency-terminal", specification);
        intent.definition_object_ref = Some(input_ref);
        intent.validate().unwrap();

        let now = Utc::now();
        let task = FmsTaskCatalogEntry {
            task_id: TASK_ID.into(),
            input_fingerprint: "a".repeat(64),
            lifecycle: FmsTaskLifecycle::Failed,
            readiness: FmsTaskReadiness::Ready,
            observation: Some(FmsObservationState::Disconnected),
            attempt_id: Some(ATTEMPT_ID.into()),
            ownership_epoch: Some(1),
            resolved_input_fingerprint: Some("b".repeat(64)),
            artifact_ids: Vec::new(),
            resource_id: Some(RESOURCE_ID.into()),
            coordinator_watermark: Some(FmsCoordinatorWatermark {
                command_sequence: 2,
                event_sequence: 3,
            }),
            coordinator_genesis: None,
        };
        let catalog = FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: RUN_ID.into(),
            revision: 3,
            updated_at: now,
            tasks: vec![task.clone()],
        };
        let lease = FmsResourceLease {
            schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: RESOURCE_ID.into(),
            kind: FmsResourceKind::Cpu,
            budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 1024,
            },
            run_id: RUN_ID.into(),
            task_id: TASK_ID.into(),
            attempt_id: ATTEMPT_ID.into(),
            ownership_epoch: 1,
            lease_token: LEASE_TOKEN.into(),
            state: FmsResourceLeaseState::Released,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: Some(now),
            host_launch_binding: None,
        };
        let intent_path = store.root().join(format!("runs/{RUN_ID}/run_intent.json"));
        write_json(&intent_path, &intent);
        let intent_sha = crate::cas::hex_sha256(&fs::read(&intent_path).unwrap());
        let catalog_path = store.root().join(format!("runs/{RUN_ID}/run_catalog.json"));
        write_json(&catalog_path, &catalog);
        let catalog_sha = crate::cas::hex_sha256(&fs::read(&catalog_path).unwrap());
        let lease_path = store.root().join(format!(
            "runs/{RUN_ID}/resource_leases/{RESOURCE_ID}/{LEASE_TOKEN}.json"
        ));
        write_json(&lease_path, &lease);
        write_admission(&store, &task, &lease, now);
        write_journal_streams(&store, now);
        write_inbox(&store, None);
        let pin = RetainedTerminalRunPin {
            run_id: RUN_ID.into(),
            run_intent_sha256: intent_sha,
            run_catalog_sha256: catalog_sha,
            artifact_catalog_sha256: None,
        };
        Fixture {
            _directory: directory,
            store,
            pin,
            catalog,
            lease,
        }
    }

    fn write_admission(
        store: &SessionStore,
        final_task: &FmsTaskCatalogEntry,
        released: &FmsResourceLease,
        now: chrono::DateTime<Utc>,
    ) {
        let mut queued_task = final_task.clone();
        queued_task.lifecycle = FmsTaskLifecycle::Queued;
        queued_task.observation = None;
        queued_task.attempt_id = None;
        queued_task.ownership_epoch = None;
        queued_task.resolved_input_fingerprint = None;
        queued_task.artifact_ids.clear();
        queued_task.resource_id = None;
        queued_task.coordinator_watermark = None;
        queued_task.coordinator_genesis = None;
        let mut admitted_task = queued_task.clone();
        admitted_task.lifecycle = FmsTaskLifecycle::Preparing;
        admitted_task.attempt_id = Some(ATTEMPT_ID.into());
        admitted_task.ownership_epoch = Some(1);
        admitted_task.resource_id = Some(RESOURCE_ID.into());
        let mut admission_lease = released.clone();
        admission_lease.state = FmsResourceLeaseState::Active;
        admission_lease.heartbeat_sequence = 0;
        admission_lease.released_at = None;
        admission_lease.heartbeat_at = now;
        let record = FmsTaskAdmissionRecord {
            schema_version: crate::types::FMS_TASK_ADMISSION_SCHEMA.into(),
            expected_catalog_revision: 1,
            queued_task,
            task: admitted_task,
            lease: admission_lease,
            resolved_inputs_snapshot: None,
        };
        record.validate().unwrap();
        write_json(
            &store.root().join(format!(
                "runs/{RUN_ID}/task_admissions/{TASK_ID}/{ATTEMPT_ID}.json"
            )),
            &record,
        );
    }

    fn journal(
        run_id: &str,
        task_id: &str,
        entry_id: &str,
        direction: FmsCoordinatorJournalDirection,
        sequence: u64,
        terminal: bool,
        command_sequence: u64,
        event_sequence: u64,
        status: &str,
        now: chrono::DateTime<Utc>,
    ) -> FmsCoordinatorJournalEntry {
        let identity = serde_json::json!({
            "run_id": run_id,
            "task_id": task_id,
            "attempt_id": ATTEMPT_ID,
            "ownership_epoch": 1,
            "lease_token": LEASE_TOKEN
        });
        let task_lifecycle = match status {
            "prepare" | "prepared" | "start" => "preparing",
            "started" | "heartbeat" | "heartbeat_ack" | "progress" => "running",
            "stop" => "stopping",
            "stopped" => "cancelled",
            "failed" | "rejected" => "failed",
            _ => "failed",
        };
        let lease_heartbeat_sequence = if status == "heartbeat"
            || status == "heartbeat_ack"
            || (status == "failed" && command_sequence >= 3)
        {
            1
        } else {
            0
        };
        let transition_message = if direction == FmsCoordinatorJournalDirection::Event {
            serde_json::json!({
                "event": if status == "failed" {
                    serde_json::json!({ "kind": "failed", "retryable": false, "reason": "test failure" })
                } else {
                    serde_json::json!({ "kind": status })
                }
            })
        } else {
            serde_json::json!({
                "command": if status == "heartbeat" {
                    serde_json::json!({ "kind": "heartbeat", "lease_heartbeat_sequence": 1 })
                } else if status == "stop" {
                    serde_json::json!({ "kind": "stop", "reason": "test cancellation" })
                } else {
                    serde_json::json!({ "kind": status })
                }
            })
        };
        let mut envelope = serde_json::json!({
            "schema_version": "worker_protocol.v1",
            "message_id": entry_id,
            "sequence": sequence,
            "claim": identity
        });
        envelope
            .as_object_mut()
            .unwrap()
            .extend(transition_message.as_object().unwrap().clone());
        let payload = serde_json::json!({
            "schema_version": "coordinator_transition.v1",
            "checkpoint": {
                "schema_version": "coordinator_checkpoint.v1",
                "task": {
                    "run_id": run_id,
                    "task_id": task_id,
                    "attempt_id": ATTEMPT_ID,
                    "ownership_epoch": 1,
                    "lifecycle": task_lifecycle
                },
                "claim": {
                    "run_id": run_id,
                    "task_id": task_id,
                    "attempt_id": ATTEMPT_ID,
                    "ownership_epoch": 1,
                    "lease": {
                        "resource_id": RESOURCE_ID,
                        "lease_token": LEASE_TOKEN,
                        "heartbeat_sequence": lease_heartbeat_sequence
                    }
                },
                "command_sequence": command_sequence,
                "event_sequence": event_sequence
            },
            "message": {
                "direction": direction.as_str(),
                "envelope": envelope
            }
        });
        FmsCoordinatorJournalEntry {
            schema_version: FMS_COORDINATOR_JOURNAL_SCHEMA.into(),
            entry_id: entry_id.into(),
            run_id: run_id.into(),
            task_id: task_id.into(),
            attempt_id: ATTEMPT_ID.into(),
            ownership_epoch: 1,
            lease_token: LEASE_TOKEN.into(),
            direction,
            sequence,
            terminal,
            payload_sha256: crate::canonical_json_sha256(&payload),
            payload,
            created_at: now,
        }
    }

    fn write_journal_streams(store: &SessionStore, now: chrono::DateTime<Utc>) {
        let entries = [
            journal(
                RUN_ID,
                TASK_ID,
                "command-one",
                FmsCoordinatorJournalDirection::Command,
                1,
                false,
                1,
                0,
                "prepare",
                now,
            ),
            journal(
                RUN_ID,
                TASK_ID,
                "command-two",
                FmsCoordinatorJournalDirection::Command,
                2,
                false,
                2,
                1,
                "start",
                now,
            ),
            journal(
                RUN_ID,
                TASK_ID,
                "event-one",
                FmsCoordinatorJournalDirection::Event,
                1,
                false,
                1,
                1,
                "prepared",
                now,
            ),
            journal(
                RUN_ID,
                TASK_ID,
                "event-two",
                FmsCoordinatorJournalDirection::Event,
                2,
                false,
                2,
                2,
                "started",
                now,
            ),
            journal(
                RUN_ID,
                TASK_ID,
                "event-three",
                FmsCoordinatorJournalDirection::Event,
                3,
                true,
                2,
                3,
                "failed",
                now,
            ),
        ];
        for entry in entries {
            write_json(
                &store.root().join(format!(
                    "runs/{RUN_ID}/coordinator_journal/{}/{}.json",
                    entry.direction.as_str(),
                    entry.entry_id
                )),
                &entry,
            );
        }
    }

    fn inbox_record(pending: Option<Value>) -> FmsWorkerInboxRecord {
        let claim = serde_json::json!({
            "run_id": RUN_ID,
            "task_id": TASK_ID,
            "attempt_id": ATTEMPT_ID,
            "ownership_epoch": 1,
            "lease_token": LEASE_TOKEN
        });
        let envelope = |sequence: u64, message_id: &str| {
            let command = match sequence {
                1 => serde_json::json!({ "kind": "prepare" }),
                2 => serde_json::json!({ "kind": "start" }),
                3 => serde_json::json!({ "kind": "heartbeat", "lease_heartbeat_sequence": 1 }),
                _ => serde_json::json!({ "kind": "execute" }),
            };
            serde_json::json!({
                "schema_version": "worker_protocol.v1",
                "sequence": sequence,
                "message_id": message_id,
                "claim": claim.clone(),
                "command": command
            })
        };
        let mut payload = serde_json::json!({
            "schema_version": "worker_inbox.v1",
            "claim": claim.clone(),
            "applied": [envelope(1, "command-one"), envelope(2, "command-two")],
            "pending": null
        });
        if let Some(pending) = pending {
            payload["pending"] = pending;
        }
        let record = FmsWorkerInboxRecord::new(payload).unwrap();
        record
    }

    fn write_inbox(store: &SessionStore, pending: Option<Value>) {
        let record = inbox_record(pending);
        let relative = record.relative_path().unwrap();
        write_json(&store.root().join(relative), &record);
    }

    fn refresh_catalog_pin(fixture: &mut Fixture) {
        let path = fixture
            .store
            .root()
            .join(format!("runs/{RUN_ID}/run_catalog.json"));
        write_json(&path, &fixture.catalog);
        fixture.pin.run_catalog_sha256 = crate::cas::hex_sha256(&fs::read(path).unwrap());
    }

    fn add_unapplied_heartbeat_suffix(fixture: &mut Fixture, kind: &str) {
        let now = Utc::now();
        let mut released_lease = fixture.lease.clone();
        released_lease.heartbeat_sequence = 0;
        write_json(
            &fixture.store.root().join(format!(
                "runs/{RUN_ID}/resource_leases/{RESOURCE_ID}/{LEASE_TOKEN}.json"
            )),
            &released_lease,
        );
        fixture.lease = released_lease;

        let suffix = journal(
            RUN_ID,
            TASK_ID,
            "command-three",
            FmsCoordinatorJournalDirection::Command,
            3,
            false,
            3,
            2,
            kind,
            now,
        );
        write_json(
            &fixture.store.root().join(format!(
                "runs/{RUN_ID}/coordinator_journal/command/{}.json",
                suffix.entry_id
            )),
            &suffix,
        );
        let final_event = journal(
            RUN_ID,
            TASK_ID,
            "event-three",
            FmsCoordinatorJournalDirection::Event,
            3,
            true,
            3,
            3,
            "failed",
            now,
        );
        write_json(
            &fixture.store.root().join(format!(
                "runs/{RUN_ID}/coordinator_journal/event/{}.json",
                final_event.entry_id
            )),
            &final_event,
        );

        fixture.catalog.tasks[0]
            .coordinator_watermark
            .as_mut()
            .unwrap()
            .command_sequence = 3;
        refresh_catalog_pin(fixture);
        let receipt = FmsWorkerProcessExitReceipt {
            schema_version: FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "process-exit-terminal".into(),
            run_id: RUN_ID.into(),
            task_id: TASK_ID.into(),
            attempt_id: ATTEMPT_ID.into(),
            ownership_epoch: 1,
            resource_id: RESOURCE_ID.into(),
            lease_token: LEASE_TOKEN.into(),
            lease_heartbeat_sequence: 0,
            process_id: 123,
            process_start_token: Some("test-process-start".into()),
            status_success: false,
            exit_code: Some(1),
            timed_out: false,
            stop_requested: false,
            failure_reason: Some("test worker failure".into()),
            observed_at: now,
        };
        write_json(
            &fixture.store.root().join(format!(
                "runs/{RUN_ID}/worker_process_exit_receipts/{}.json",
                receipt.receipt_id
            )),
            &receipt,
        );
    }

    fn add_claimed_cancellation(fixture: &mut Fixture) {
        let now = Utc::now();
        let stop = journal(
            RUN_ID,
            TASK_ID,
            "command-three",
            FmsCoordinatorJournalDirection::Command,
            3,
            false,
            3,
            2,
            "stop",
            now,
        );
        write_json(
            &fixture.store.root().join(format!(
                "runs/{RUN_ID}/coordinator_journal/command/{}.json",
                stop.entry_id
            )),
            &stop,
        );
        let stopped = journal(
            RUN_ID,
            TASK_ID,
            "event-three",
            FmsCoordinatorJournalDirection::Event,
            3,
            false,
            3,
            3,
            "stopped",
            now,
        );
        write_json(
            &fixture.store.root().join(format!(
                "runs/{RUN_ID}/coordinator_journal/event/{}.json",
                stopped.entry_id
            )),
            &stopped,
        );

        fixture.catalog.tasks[0].lifecycle = FmsTaskLifecycle::Cancelled;
        fixture.catalog.tasks[0].observation = Some(FmsObservationState::Stale);
        fixture.catalog.tasks[0]
            .coordinator_watermark
            .as_mut()
            .unwrap()
            .command_sequence = 3;
        refresh_catalog_pin(fixture);

        let mut payload = inbox_record(None).payload;
        let claim = payload["claim"].clone();
        payload["applied"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({
                "schema_version": "worker_protocol.v1",
                "sequence": 3,
                "message_id": "command-three",
                "claim": claim,
                "command": { "kind": "stop", "reason": "test cancellation" }
            }));
        let inbox = FmsWorkerInboxRecord::new(payload).unwrap();
        let inbox_relative = inbox.relative_path().unwrap();
        write_json(&fixture.store.root().join(inbox_relative), &inbox);

        let receipt = FmsWorkerProcessExitReceipt {
            schema_version: FMS_WORKER_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "process-exit-terminal".into(),
            run_id: RUN_ID.into(),
            task_id: TASK_ID.into(),
            attempt_id: ATTEMPT_ID.into(),
            ownership_epoch: 1,
            resource_id: RESOURCE_ID.into(),
            lease_token: LEASE_TOKEN.into(),
            lease_heartbeat_sequence: fixture.lease.heartbeat_sequence,
            process_id: 123,
            process_start_token: Some("test-process-start".into()),
            status_success: false,
            exit_code: Some(143),
            timed_out: false,
            stop_requested: true,
            failure_reason: Some("worker stopped by request".into()),
            observed_at: now,
        };
        write_json(
            &fixture.store.root().join(format!(
                "runs/{RUN_ID}/worker_process_exit_receipts/{}.json",
                receipt.receipt_id
            )),
            &receipt,
        );
    }

    fn validate(fixture: &Fixture) -> Result<RetainedTerminalRunsPreflight> {
        let _writer = fixture.store.write_transaction()?;
        validate_retained_terminal_runs(&fixture.store, std::slice::from_ref(&fixture.pin))
    }

    fn tree_snapshot(root: &Path) -> BTreeMap<String, Vec<u8>> {
        fn visit(root: &Path, current: &Path, result: &mut BTreeMap<String, Vec<u8>>) {
            for entry in fs::read_dir(current).unwrap() {
                let entry = entry.unwrap();
                let path = entry.path();
                let kind = entry.file_type().unwrap();
                assert!(!kind.is_symlink());
                if kind.is_dir() {
                    visit(root, &path, result);
                } else {
                    result.insert(
                        path.strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                        fs::read(path).unwrap(),
                    );
                }
            }
        }
        let mut result = BTreeMap::new();
        visit(root, root, &mut result);
        result
    }

    #[test]
    fn failed_terminal_run_with_released_claim_is_read_only_and_valid() {
        let fixture = fixture();
        let _writer = fixture.store.write_transaction().unwrap();
        let before = tree_snapshot(fixture.store.root());
        let preflight =
            validate_retained_terminal_runs(&fixture.store, std::slice::from_ref(&fixture.pin))
                .unwrap();
        let after = tree_snapshot(fixture.store.root());
        assert_eq!(preflight.run_count, 1);
        assert_eq!(preflight.task_count, 1);
        assert_eq!(before, after);
    }

    #[test]
    fn active_task_lifecycle_is_rejected() {
        let mut fixture = fixture();
        fixture.catalog.tasks[0].lifecycle = FmsTaskLifecycle::Running;
        refresh_catalog_pin(&mut fixture);
        assert!(validate(&fixture).is_err());
    }

    #[test]
    fn unlisted_task_journal_is_rejected() {
        let fixture = fixture();
        let unknown = journal(
            RUN_ID,
            "task-unknown",
            "unknown-event",
            FmsCoordinatorJournalDirection::Event,
            1,
            true,
            0,
            1,
            "failed",
            Utc::now(),
        );
        write_json(
            &fixture.store.root().join(format!(
                "runs/{RUN_ID}/coordinator_journal/event/{}.json",
                unknown.entry_id
            )),
            &unknown,
        );
        assert!(validate(&fixture).is_err());
    }

    #[test]
    fn pending_worker_inbox_command_is_rejected() {
        let fixture = fixture();
        let pending = serde_json::json!({
            "schema_version": "worker_protocol.v1",
            "sequence": 3,
            "message_id": "message-pending",
            "claim": {
                "run_id": RUN_ID,
                "task_id": TASK_ID,
                "attempt_id": ATTEMPT_ID,
                "ownership_epoch": 1,
                "lease_token": LEASE_TOKEN
            },
            "command": { "kind": "execute" }
        });
        write_inbox(&fixture.store, Some(pending));
        assert!(validate(&fixture).is_err());
    }

    #[test]
    fn failed_exit_may_close_one_unapplied_final_heartbeat_read_only() {
        let mut fixture = fixture();
        add_unapplied_heartbeat_suffix(&mut fixture, "heartbeat");
        let _writer = fixture.store.write_transaction().unwrap();
        let before = tree_snapshot(fixture.store.root());
        validate_retained_terminal_runs(&fixture.store, std::slice::from_ref(&fixture.pin))
            .unwrap();
        assert_eq!(before, tree_snapshot(fixture.store.root()));
    }

    #[test]
    fn claimed_cancelled_run_requires_applied_stop_and_reaped_worker() {
        let mut cancelled = fixture();
        add_claimed_cancellation(&mut cancelled);
        let _writer = cancelled.store.write_transaction().unwrap();
        let before = tree_snapshot(cancelled.store.root());
        validate_retained_terminal_runs(&cancelled.store, std::slice::from_ref(&cancelled.pin))
            .unwrap();
        assert_eq!(before, tree_snapshot(cancelled.store.root()));

        let mut missing_exit = fixture();
        add_claimed_cancellation(&mut missing_exit);
        fs::remove_file(missing_exit.store.root().join(format!(
            "runs/{RUN_ID}/worker_process_exit_receipts/process-exit-terminal.json"
        )))
        .unwrap();
        assert!(validate(&missing_exit).is_err());
    }

    #[test]
    fn unapplied_final_heartbeat_requires_exact_next_sequence() {
        let mut fixture = fixture();
        add_unapplied_heartbeat_suffix(&mut fixture, "heartbeat");
        let path = fixture.store.root().join(format!(
            "runs/{RUN_ID}/coordinator_journal/command/command-three.json"
        ));
        let mut entry: FmsCoordinatorJournalEntry =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        entry.payload["message"]["envelope"]["command"]["lease_heartbeat_sequence"] =
            serde_json::json!(2);
        entry.payload_sha256 = crate::canonical_json_sha256(&entry.payload);
        write_json(&path, &entry);
        assert!(validate(&fixture).is_err());
    }

    #[test]
    fn unapplied_final_heartbeat_requires_matching_failed_exit_receipt() {
        let mut missing = fixture();
        add_unapplied_heartbeat_suffix(&mut missing, "heartbeat");
        fs::remove_file(missing.store.root().join(format!(
            "runs/{RUN_ID}/worker_process_exit_receipts/process-exit-terminal.json"
        )))
        .unwrap();
        assert!(validate(&missing).is_err());

        let mut mismatched = fixture();
        add_unapplied_heartbeat_suffix(&mut mismatched, "heartbeat");
        let path = mismatched.store.root().join(format!(
            "runs/{RUN_ID}/worker_process_exit_receipts/process-exit-terminal.json"
        ));
        let mut receipt: FmsWorkerProcessExitReceipt =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        receipt.lease_heartbeat_sequence = 1;
        write_json(&path, &receipt);
        assert!(validate(&mismatched).is_err());
    }

    #[test]
    fn unapplied_nonheartbeat_suffix_is_rejected() {
        let mut fixture = fixture();
        add_unapplied_heartbeat_suffix(&mut fixture, "stop");
        assert!(validate(&fixture).is_err());
    }

    #[test]
    fn pending_inbox_still_rejects_final_heartbeat_suffix() {
        let mut fixture = fixture();
        add_unapplied_heartbeat_suffix(&mut fixture, "heartbeat");
        let pending = serde_json::json!({
            "schema_version": "worker_protocol.v1",
            "sequence": 3,
            "message_id": "command-three",
            "claim": {
                "run_id": RUN_ID,
                "task_id": TASK_ID,
                "attempt_id": ATTEMPT_ID,
                "ownership_epoch": 1,
                "lease_token": LEASE_TOKEN
            },
            "command": { "kind": "heartbeat", "lease_heartbeat_sequence": 1 }
        });
        write_inbox(&fixture.store, Some(pending));
        assert!(validate(&fixture).is_err());
    }

    #[test]
    fn active_solver_lease_is_rejected() {
        let fixture = fixture();
        let mut active = fixture.lease.clone();
        active.state = FmsResourceLeaseState::Active;
        active.released_at = None;
        write_json(
            &fixture.store.root().join(format!(
                "runs/{RUN_ID}/resource_leases/{RESOURCE_ID}/{LEASE_TOKEN}.json"
            )),
            &active,
        );
        assert!(validate(&fixture).is_err());
    }

    fn history_pin(fixture: &Fixture) -> super::super::retained_attempt_histories::RetainedAttemptHistoryPin {
        let root = fixture.store.root().join(format!("runs/{RUN_ID}"));
        let records = tree_snapshot(&root).into_iter().map(|(path, raw)| (path, crate::hex_sha256(&raw))).collect::<BTreeMap<_, _>>();
        super::super::retained_attempt_histories::RetainedAttemptHistoryPin {
            run_id: RUN_ID.into(),
            run_evidence_sha256: crate::canonical_json_sha256(&serde_json::to_value(records).unwrap()),
            attempts: vec![super::super::retained_attempt_histories::RetainedAttemptPin {
                task_id: TASK_ID.into(), attempt_id: ATTEMPT_ID.into(), ownership_epoch: 1, resource_id: RESOURCE_ID.into(),
            }],
        }
    }

    fn historical_retry_fixture(acked_heartbeats: u64) -> Fixture {
        let mut fixture = fixture();
        add_unapplied_heartbeat_suffix(&mut fixture, "heartbeat");
        let now = Utc::now();
        let run = fixture.store.root().join(format!("runs/{RUN_ID}"));
        let mut commands = Vec::new();
        for index in 0..acked_heartbeats {
            let sequence = index + 3;
            let heartbeat = index + 1;
            let mut command = journal(RUN_ID, TASK_ID, &format!("command-{sequence}"), FmsCoordinatorJournalDirection::Command, sequence, false, sequence, sequence - 1, "heartbeat", now);
            command.payload["message"]["envelope"]["command"]["lease_heartbeat_sequence"] = serde_json::json!(heartbeat);
            command.payload["checkpoint"]["claim"]["lease"]["heartbeat_sequence"] = serde_json::json!(heartbeat);
            command.payload_sha256 = crate::canonical_json_sha256(&command.payload);
            write_json(&run.join(format!("coordinator_journal/command/{}.json", command.entry_id)), &command);
            commands.push(command.payload["message"]["envelope"].clone());
            let mut ack = journal(RUN_ID, TASK_ID, &format!("event-{sequence}"), FmsCoordinatorJournalDirection::Event, sequence, false, sequence, sequence, "heartbeat_ack", now);
            ack.payload["message"]["envelope"]["event"]["lease_heartbeat_sequence"] = serde_json::json!(heartbeat);
            ack.payload["checkpoint"]["claim"]["lease"]["heartbeat_sequence"] = serde_json::json!(heartbeat);
            ack.payload_sha256 = crate::canonical_json_sha256(&ack.payload);
            write_json(&run.join(format!("coordinator_journal/event/{}.json", ack.entry_id)), &ack);
        }
        // Replace the original suffix/final records by the exact 2/3 or
        // 170/171 shape; this is the production reconciliation exception.
        if acked_heartbeats > 0 {
            fs::remove_file(run.join("coordinator_journal/command/command-three.json")).unwrap();
            fs::remove_file(run.join("coordinator_journal/event/event-three.json")).unwrap();
        }
        let sequence = acked_heartbeats + 3;
        let mut suffix = journal(RUN_ID, TASK_ID, "command-three", FmsCoordinatorJournalDirection::Command, sequence, false, sequence, sequence - 1, "heartbeat", now);
        suffix.payload["message"]["envelope"]["command"]["lease_heartbeat_sequence"] = serde_json::json!(acked_heartbeats + 1);
        suffix.payload["checkpoint"]["claim"]["lease"]["heartbeat_sequence"] = serde_json::json!(acked_heartbeats + 1);
        suffix.payload_sha256 = crate::canonical_json_sha256(&suffix.payload);
        write_json(&run.join("coordinator_journal/command/command-three.json"), &suffix);
        let mut terminal = journal(RUN_ID, TASK_ID, "event-three", FmsCoordinatorJournalDirection::Event, sequence, true, sequence, sequence, "failed", now);
        terminal.payload["checkpoint"]["claim"]["lease"]["heartbeat_sequence"] = serde_json::json!(acked_heartbeats + 1);
        terminal.payload["checkpoint"]["task"]["claim"] = terminal.payload["checkpoint"]["claim"].clone();
        terminal.payload["checkpoint"]["task"]["input_fingerprint"] = serde_json::json!(fixture.catalog.tasks[0].input_fingerprint);
        terminal.payload["checkpoint"]["task"]["readiness"] = serde_json::json!({"state":"ready"});
        terminal.payload["checkpoint"]["task"]["observation"] = serde_json::json!("disconnected");
        terminal.payload["checkpoint"]["task"]["assessment"] = serde_json::json!("invalid");
        terminal.payload_sha256 = crate::canonical_json_sha256(&terminal.payload);
        write_json(&run.join("coordinator_journal/event/event-three.json"), &terminal);
        fixture.lease.heartbeat_sequence = acked_heartbeats;
        write_json(&run.join(format!("resource_leases/{RESOURCE_ID}/{LEASE_TOKEN}.json")), &fixture.lease);
        let mut old_inbox = inbox_record(None).payload;
        old_inbox["applied"].as_array_mut().unwrap().extend(commands);
        let old_record = FmsWorkerInboxRecord::new(old_inbox).unwrap();
        write_json(&fixture.store.root().join(old_record.relative_path().unwrap()), &old_record);
        let exit_path = run.join("worker_process_exit_receipts/process-exit-terminal.json");
        let mut exit: FmsWorkerProcessExitReceipt = serde_json::from_slice(&fs::read(&exit_path).unwrap()).unwrap();
        exit.lease_heartbeat_sequence = acked_heartbeats;
        write_json(&exit_path, &exit);
        let mut failed = fixture.catalog.tasks[0].clone();
        failed.coordinator_watermark = Some(FmsCoordinatorWatermark { command_sequence: sequence, event_sequence: sequence });
        let retry = crate::types::FmsRetryDecision {
            schema_version: crate::types::FMS_RETRY_DECISION_SCHEMA.into(), decision_id: "operator-retry".into(),
            run_id: RUN_ID.into(), task_id: TASK_ID.into(), attempt_id: ATTEMPT_ID.into(), ownership_epoch: 1,
            trigger: crate::types::FmsRetryTrigger::ExplicitOperatorRequest, action: crate::types::FmsRetryAction::Retry,
            reason: "explicit local operator retry".into(), created_at: now,
        };
        write_json(&run.join("retry_decisions/operator-retry.json"), &retry);
        let mut queued = failed.clone();
        queued.lifecycle = FmsTaskLifecycle::Queued; queued.observation = Some(FmsObservationState::Reconciling);
        queued.attempt_id = None; queued.resource_id = None; queued.resolved_input_fingerprint = None;
        let mut next_task = queued.clone();
        next_task.lifecycle = FmsTaskLifecycle::Preparing; next_task.attempt_id = Some("attempt-next".into());
        next_task.ownership_epoch = Some(2); next_task.resource_id = Some(RESOURCE_ID.into());
        next_task.coordinator_watermark = None; next_task.coordinator_genesis = None;
        let mut next_lease = fixture.lease.clone();
        next_lease.attempt_id = "attempt-next".into(); next_lease.ownership_epoch = 2; next_lease.lease_token = "lease-next".into();
        next_lease.heartbeat_sequence = 0; next_lease.state = FmsResourceLeaseState::Active; next_lease.released_at = None;
        let next_admission = FmsTaskAdmissionRecord { schema_version: crate::types::FMS_TASK_ADMISSION_SCHEMA.into(),
            expected_catalog_revision: 4, queued_task: queued, task: next_task.clone(), lease: next_lease.clone(), resolved_inputs_snapshot: None };
        next_admission.validate().unwrap();
        write_json(&run.join(format!("task_admissions/{TASK_ID}/attempt-next.json")), &next_admission);
        next_lease.state = FmsResourceLeaseState::Released; next_lease.released_at = Some(now);
        write_json(&run.join(format!("resource_leases/{RESOURCE_ID}/lease-next.json")), &next_lease);
        let shapes = [ ("next-command-one", FmsCoordinatorJournalDirection::Command, 1, false, 1, 0, "prepare"),
            ("next-command-two", FmsCoordinatorJournalDirection::Command, 2, false, 2, 1, "start"),
            ("next-event-one", FmsCoordinatorJournalDirection::Event, 1, false, 1, 1, "prepared"),
            ("next-event-two", FmsCoordinatorJournalDirection::Event, 2, false, 2, 2, "started"),
            ("next-event-three", FmsCoordinatorJournalDirection::Event, 3, true, 2, 3, "completed") ];
        let mut next_commands = Vec::new();
        for (id, direction, sequence, terminal, command_sequence, event_sequence, kind) in shapes {
            let mut entry = journal(RUN_ID, TASK_ID, id, direction, sequence, terminal, command_sequence, event_sequence, kind, now);
            entry.attempt_id = "attempt-next".into(); entry.ownership_epoch = 2; entry.lease_token = "lease-next".into();
            for pointer in ["/checkpoint/task", "/checkpoint/claim", "/message/envelope/claim"] {
                let claim = entry.payload.pointer_mut(pointer).unwrap();
                claim["attempt_id"] = serde_json::json!("attempt-next"); claim["ownership_epoch"] = serde_json::json!(2);
            }
            entry.payload["checkpoint"]["claim"]["lease"]["lease_token"] = serde_json::json!("lease-next");
            entry.payload["message"]["envelope"]["claim"]["lease_token"] = serde_json::json!("lease-next");
            if kind == "completed" {
                entry.payload["message"]["envelope"]["event"]["assessment"] = serde_json::json!({});
                entry.payload["checkpoint"]["task"]["lifecycle"] = serde_json::json!("succeeded");
            }
            entry.payload_sha256 = crate::canonical_json_sha256(&entry.payload);
            if direction == FmsCoordinatorJournalDirection::Command { next_commands.push(entry.payload["message"]["envelope"].clone()); }
            write_json(&run.join(format!("coordinator_journal/{}/{}.json", direction.as_str(), id)), &entry);
        }
        let next_inbox = FmsWorkerInboxRecord::new(serde_json::json!({"schema_version":"worker_inbox.v1",
            "claim":{"run_id":RUN_ID,"task_id":TASK_ID,"attempt_id":"attempt-next","ownership_epoch":2,"lease_token":"lease-next"},
            "applied":next_commands,"pending":null})).unwrap();
        write_json(&fixture.store.root().join(next_inbox.relative_path().unwrap()), &next_inbox);
        next_task.lifecycle = FmsTaskLifecycle::Succeeded;
        next_task.coordinator_watermark = Some(FmsCoordinatorWatermark { command_sequence: 2, event_sequence: 3 });
        fixture.catalog.tasks = vec![next_task]; fixture.catalog.revision = 8;
        refresh_catalog_pin(&mut fixture);
        fixture
    }

    fn validate_history(fixture: &Fixture, pin: &super::super::retained_attempt_histories::RetainedAttemptHistoryPin) -> Result<()> {
        let _writer = fixture.store.write_transaction()?;
        validate_history_locked(fixture, pin)
    }

    fn validate_history_locked(fixture: &Fixture, pin: &super::super::retained_attempt_histories::RetainedAttemptHistoryPin) -> Result<()> {
        let mut budget = ReadBudget::for_attempt_history_v5();
        let mut refs = BTreeSet::new();
        super::super::retained_attempt_histories::validate_pins(std::slice::from_ref(pin), std::slice::from_ref(&fixture.pin))?;
        super::super::retained_attempt_histories::validate_inventory(&fixture.store, std::slice::from_ref(pin), &mut budget)?;
        validate_terminal_runs_subset_with_histories(&fixture.store, std::slice::from_ref(&fixture.pin), &mut budget, &mut refs, std::slice::from_ref(pin))?;
        retained_cancelled_runs::validate_run_cas_pins(&fixture.store, &refs, &mut budget)?;
        super::super::retained_attempt_histories::validate_inventory(&fixture.store, std::slice::from_ref(pin), &mut budget)
    }

    #[test]
    fn v5_retains_failed_retry_history_and_existing_final_heartbeat_exception_read_only() {
        for heartbeats in [0, 168] {
            let fixture = historical_retry_fixture(heartbeats);
            let pin = history_pin(&fixture);
            {
                // Lock acquisition/release writes ownership metadata. Compare
                // every byte while holding the same lock as production.
                let _writer = fixture.store.write_transaction().unwrap();
                let before = tree_snapshot(fixture.store.root());
                validate_history_locked(&fixture, &pin).unwrap();
                assert_eq!(before, tree_snapshot(fixture.store.root()));
            }
            assert!(validate(&fixture).is_err(), "v3 must continue refusing historical attempts");
        }
    }

    #[test]
    fn v5_rejects_changed_or_additional_run_evidence_even_if_not_a_control_record() {
        let fixture = historical_retry_fixture(0);
        let pin = history_pin(&fixture);
        fs::write(fixture.store.root().join(format!("runs/{RUN_ID}/unrecognized-extra.bin")), b"extra").unwrap();
        assert!(validate_history(&fixture, &pin).is_err());
        assert!(validate_history(&fixture, &history_pin(&fixture)).is_err(), "unknown namespace must remain refused even if explicitly hashed");
    }

    #[test]
    fn v5_rejects_invalid_historical_claim_evidence_even_when_raw_inventory_is_repinned() {
        for fault in ["missing-exit", "active-lease", "foreign-token", "pending", "missing-retry", "heartbeat-gap", "epoch-gap"] {
            let fixture = historical_retry_fixture(0);
            let run = fixture.store.root().join(format!("runs/{RUN_ID}"));
            match fault {
                "missing-exit" => fs::remove_file(run.join("worker_process_exit_receipts/process-exit-terminal.json")).unwrap(),
                "missing-retry" => fs::remove_file(run.join("retry_decisions/operator-retry.json")).unwrap(),
                "active-lease" | "foreign-token" => {
                    let path = run.join(format!("resource_leases/{RESOURCE_ID}/{LEASE_TOKEN}.json"));
                    let mut lease = fixture.lease.clone();
                    if fault == "active-lease" { lease.state = FmsResourceLeaseState::Active; lease.released_at = None; }
                    else { lease.lease_token = "foreign-token".into(); }
                    write_json(&path, &lease);
                }
                "pending" => {
                    let path = run.join("coordinator_journal/command/command-three.json");
                    let entry: FmsCoordinatorJournalEntry = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
                    // A valid pending envelope must reach the recovery gate;
                    // malformed protocol data would fail in fixture creation.
                    write_inbox(&fixture.store, Some(entry.payload["message"]["envelope"].clone()));
                }
                "heartbeat-gap" => {
                    let path = run.join("coordinator_journal/command/command-three.json");
                    let mut entry: FmsCoordinatorJournalEntry = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                    entry.payload["message"]["envelope"]["command"]["lease_heartbeat_sequence"] = serde_json::json!(2);
                    entry.payload_sha256 = crate::canonical_json_sha256(&entry.payload); write_json(&path, &entry);
                }
                "epoch-gap" => {
                    let mut pin = history_pin(&fixture); pin.attempts[0].ownership_epoch = 2;
                    assert!(validate_history(&fixture, &pin).is_err()); continue;
                }
                _ => unreachable!(),
            }
            assert!(validate_history(&fixture, &history_pin(&fixture)).is_err(), "fault {fault}");
        }
    }

    #[test]
    fn historical_compute_attempt_leases_and_admissions_are_outside_v3_scope() {
        let lease_fixture = fixture();
        let mut historical_lease = lease_fixture.lease.clone();
        historical_lease.attempt_id = "attempt-historical".into();
        historical_lease.ownership_epoch = 2;
        historical_lease.lease_token = "lease-historical".into();
        write_json(
            &lease_fixture.store.root().join(format!(
                "runs/{RUN_ID}/resource_leases/{RESOURCE_ID}/{}.json",
                historical_lease.lease_token
            )),
            &historical_lease,
        );
        let error = validate(&lease_fixture).unwrap_err();
        assert!(format!("{error:#}").contains("historical compute attempts"));

        let admission_fixture = fixture();
        let mut historical_admission = admission_fixture
            .store
            .read_task_admission(RUN_ID, TASK_ID, ATTEMPT_ID)
            .unwrap()
            .unwrap();
        historical_admission.queued_task.ownership_epoch = Some(1);
        historical_admission.task.attempt_id = Some("attempt-historical".into());
        historical_admission.task.ownership_epoch = Some(2);
        historical_admission.lease.attempt_id = "attempt-historical".into();
        historical_admission.lease.ownership_epoch = 2;
        historical_admission.lease.lease_token = "lease-historical".into();
        historical_admission.validate().unwrap();
        write_json(
            &admission_fixture.store.root().join(format!(
                "runs/{RUN_ID}/task_admissions/{TASK_ID}/attempt-historical.json"
            )),
            &historical_admission,
        );
        let error = validate(&admission_fixture).unwrap_err();
        assert!(format!("{error:#}").contains("historical compute task admissions"));
    }

    #[test]
    fn active_preparation_lease_is_rejected() {
        let fixture = fixture();
        let now = Utc::now();
        let lease = FmsPreparationResourceLease {
            schema_version: FMS_PREPARATION_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "preparation-resource".into(),
            budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 1024,
            },
            run_id: RUN_ID.into(),
            task_id: TASK_ID.into(),
            preparation_attempt_id: "preparation-attempt".into(),
            lease_token: "preparation-lease".into(),
            state: FmsResourceLeaseState::Active,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 0,
            released_at: None,
            host_launch_binding: None,
        };
        write_json(
            &fixture.store.root().join(format!(
                "runs/{RUN_ID}/preparation_resource_leases/{}/{}.json",
                lease.resource_id, lease.lease_token
            )),
            &lease,
        );
        assert!(validate(&fixture).is_err());
    }

    #[test]
    fn stale_pin_and_omitted_run_are_rejected() {
        let mut stale = fixture();
        stale.pin.run_intent_sha256 = "0".repeat(64);
        assert!(validate(&stale).is_err());

        let omitted = fixture();
        fs::create_dir_all(omitted.store.root().join("runs/run-unpinned")).unwrap();
        assert!(validate(&omitted).is_err());
    }

    #[test]
    fn missing_input_cas_object_is_rejected() {
        let fixture = fixture();
        let intent: FmsRunIntent = fixture.store.read_run_intent(RUN_ID).unwrap().unwrap();
        let object_ref = intent.definition_object_ref.unwrap();
        fs::remove_file(
            fixture
                .store
                .root()
                .join(format!("objects/sha256/{object_ref}")),
        )
        .unwrap();
        assert!(validate(&fixture).is_err());
    }

    #[test]
    fn published_artifact_without_cas_backing_is_rejected() {
        let mut fixture = fixture();
        let artifact_id = "artifact-terminal";
        fixture.catalog.tasks[0].artifact_ids = vec![artifact_id.into()];
        refresh_catalog_pin(&mut fixture);
        let missing_ref = "f".repeat(64);
        let artifact_catalog = FmsArtifactCatalog {
            schema_version: crate::types::FMS_ARTIFACT_CATALOG_SCHEMA.into(),
            run_id: RUN_ID.into(),
            revision: 1,
            updated_at: Utc::now(),
            entries: vec![crate::types::FmsArtifactCatalogEntry {
                artifact_id: artifact_id.into(),
                task_id: TASK_ID.into(),
                attempt_id: ATTEMPT_ID.into(),
                ownership_epoch: 1,
                logical_path: "results/output.json".into(),
                artifact_type: "result".into(),
                content_sha256: missing_ref.clone(),
                object_ref: Some(missing_ref),
                status: FmsArtifactStatus::Published,
                required: true,
                study_output: None,
            }],
        };
        let path = fixture
            .store
            .root()
            .join(format!("runs/{RUN_ID}/artifact_catalog.json"));
        write_json(&path, &artifact_catalog);
        fixture.pin.artifact_catalog_sha256 =
            Some(crate::cas::hex_sha256(&fs::read(path).unwrap()));
        assert!(validate(&fixture).is_err());
    }
}
