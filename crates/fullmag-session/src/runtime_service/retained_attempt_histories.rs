//! V5-only, read-only qualification of explicitly pinned failed retry history.
//! No catalog, lease, inbox, checkpoint or retry decision is rewritten here.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::repository_path::{checked_path, read_bounded_regular_file, reject_link, validate_store_id};
use crate::store::SessionStore;
use crate::types::{FmsCoordinatorJournalEntry, FmsCoordinatorWatermark, FmsObservationState,
    FmsRetryAction, FmsRetryTrigger, FmsRunCatalog, FmsTaskCatalogEntry, FmsTaskLifecycle};
use super::retained_cancelled_runs::{self, ReadBudget};
use super::retained_terminal_runs::RetainedTerminalRunPin;

const MAX_FILES: usize = 32768;
const MAX_DIRECTORIES: usize = 4096;
const MAX_CLAIMS: usize = 128;
const MAX_FILE_BYTES: usize = 128 * 1024 * 1024;
const WALK_SECONDS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedAttemptPin {
    pub task_id: String,
    pub attempt_id: String,
    pub ownership_epoch: u64,
    pub resource_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedAttemptHistoryPin {
    pub run_id: String,
    pub run_evidence_sha256: String,
    pub attempts: Vec<RetainedAttemptPin>,
}

pub(super) fn validate_pins(pins: &[RetainedAttemptHistoryPin], terminal: &[RetainedTerminalRunPin]) -> Result<()> {
    if pins.is_empty() || pins.len() > MAX_CLAIMS { bail!("v5 requires a nonempty bounded history inventory"); }
    let terminal_ids = terminal.iter().map(|pin| pin.run_id.as_str()).collect::<BTreeSet<_>>();
    let mut runs = BTreeSet::new();
    let mut count = 0usize;
    for pin in pins {
        validate_store_id(&pin.run_id)?;
        retained_cancelled_runs::validate_sha256(&pin.run_evidence_sha256, "run_evidence_sha256")?;
        if !terminal_ids.contains(pin.run_id.as_str()) || !runs.insert(&pin.run_id) || pin.attempts.is_empty() {
            bail!("v5 history must uniquely name a terminal run and nonempty historical claims");
        }
        let mut claims = BTreeSet::new();
        let mut epochs = BTreeSet::new();
        for claim in &pin.attempts {
            for id in [&claim.task_id, &claim.attempt_id, &claim.resource_id] { validate_store_id(id)?; }
            count = count.checked_add(1).context("history claim count overflow")?;
            if count > MAX_CLAIMS || claim.ownership_epoch == 0
                || !claims.insert((&claim.task_id, &claim.attempt_id))
                || !epochs.insert((&claim.task_id, claim.ownership_epoch)) {
                bail!("v5 historical claim inventory is duplicate, invalid or unbounded");
            }
        }
    }
    Ok(())
}

/// Complete no-link store inventory. The mapping uses paths relative to each
/// run root, hashes raw bytes, and is serialized by the canonical JSON helper.
/// The traversal never truncates and checks its cooperative deadline per entry.
pub(super) fn validate_inventory(store: &SessionStore, pins: &[RetainedAttemptHistoryPin], budget: &mut ReadBudget) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(WALK_SECONDS);
    let mut stack = vec![store.root().to_path_buf()];
    let mut files = 0usize;
    let mut directories = 1usize;
    let mut evidence = pins.iter().map(|pin| (pin.run_id.clone(), BTreeMap::<String, String>::new())).collect::<BTreeMap<_, _>>();
    while let Some(directory) = stack.pop() {
        check_deadline(deadline)?;
        reject_link(&directory)?;
        if !fs::symlink_metadata(&directory)?.is_dir() { bail!("v5 store inventory directory changed kind"); }
        for entry in fs::read_dir(&directory)? {
            check_deadline(deadline)?;
            let entry = entry?;
            let path = entry.path();
            reject_link(&path)?;
            let metadata = fs::symlink_metadata(&path)?;
            if let Ok(run_relative) = path.strip_prefix(store.root().join("runs")) {
                let components = run_relative.components().collect::<Vec<_>>();
                if let Some(run) = components.first().and_then(|part| part.as_os_str().to_str()) {
                    if evidence.contains_key(run) && components.len() > 1 {
                        let tail = path.strip_prefix(store.root().join("runs").join(run))?.to_str().context("history namespace path is not UTF-8")?;
                        validate_namespace(tail, metadata.is_dir())?;
                    }
                }
            }
            if metadata.is_dir() {
                directories += 1;
                if directories > MAX_DIRECTORIES { bail!("v5 store directory inventory exceeds its limit"); }
                stack.push(path); continue;
            }
            if !metadata.is_file() { bail!("v5 store inventory contains a nonregular file"); }
            files += 1;
            if files > MAX_FILES { bail!("v5 store file inventory exceeds its limit"); }
            let relative = path.strip_prefix(store.root())?.to_str().context("v5 store path is not UTF-8")?;
            budget.observe_file(store.root(), relative, MAX_FILE_BYTES)?;
            let parts = Path::new(relative).components().collect::<Vec<_>>();
            if parts.len() >= 3 && parts[0].as_os_str() == "runs" {
                let run_id = parts[1].as_os_str().to_str().context("run id is not UTF-8")?;
                if let Some(records) = evidence.get_mut(run_id) {
                    let run_relative = path.strip_prefix(store.root().join("runs").join(run_id))?.to_str().context("run evidence path is not UTF-8")?.to_owned();
                    let raw = read_bounded_regular_file(store.root(), relative, MAX_FILE_BYTES)?;
                    records.insert(run_relative, crate::hex_sha256(&raw));
                }
            }
        }
    }
    check_deadline(deadline)?;
    for pin in pins {
        let records = evidence.get(&pin.run_id).context("history inventory lost run")?;
        if records.is_empty() || crate::canonical_json_sha256(&serde_json::to_value(records)?) != pin.run_evidence_sha256 {
            bail!("v5 retained run evidence inventory or raw bytes differ from their pin");
        }
    }
    Ok(())
}

// Closed shapes already produced by canonical run records and the local
// worker-attempt directory. Bundles are opaque evidence, never execution proof.
fn validate_namespace(relative: &str, directory: bool) -> Result<()> {
    let parts = relative.split('/').collect::<Vec<_>>();
    let json = |name: &str| name.strip_suffix(".json").is_some_and(|id| validate_store_id(id).is_ok());
    let valid = if parts.len() == 1 && !directory {
        matches!(parts[0], "run_intent.json" | "run_catalog.json" | "artifact_catalog.json" | "start_release.json" | "preparation_receipt.json")
    } else if matches!(parts[0], "task_preparation_receipts" | "task_prepared_observations" | "accepted_stage_preparation_receipts"
        | "worker_inbox" | "retry_decisions" | "preparation_retry_decisions" | "worker_process_exit_receipts"
        | "preparation_process_exit_receipts" | "preparation_process_launches" | "task_cancellation_intents") {
        (directory && parts.len() == 1) || (!directory && parts.len() == 2 && json(parts[1]))
    } else if matches!(parts[0], "resource_leases" | "preparation_resource_leases" | "task_admissions") {
        (directory && parts.len() <= 2 && parts.iter().skip(1).all(|id| validate_store_id(id).is_ok()))
            || (!directory && parts.len() == 3 && validate_store_id(parts[1]).is_ok() && json(parts[2]))
    } else if parts[0] == "coordinator_journal" {
        (directory && (parts.len() == 1 || (parts.len() == 2 && matches!(parts[1], "command" | "event"))))
            || (!directory && parts.len() == 3 && matches!(parts[1], "command" | "event") && json(parts[2]))
    } else if parts[0] == "worker-attempts" {
        let base = parts.iter().skip(1).take(2).all(|id| validate_store_id(id).is_ok());
        let epoch = parts.get(3).is_none_or(|value| value.strip_prefix("epoch-").and_then(|n| n.parse::<u64>().ok()).is_some_and(|n| n > 0));
        base && epoch && ((directory && parts.len() <= 4)
            || (!directory && parts.len() == 5 && (matches!(parts[4], "worker_execution_started.v1.json" | "worker_execution_completed.v1.json") || (parts[4].ends_with(".bundle") && validate_store_id(parts[4]).is_ok()))))
    } else { false };
    if !valid { bail!("v5 history contains an unknown or invalid run namespace: {relative}"); }
    Ok(())
}

fn check_deadline(deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline { bail!("v5 accepted-store inventory exceeded its time bound"); }
    Ok(())
}

/// Recover the task *view* from its actual immutable failed checkpoint and
/// the next admission's preserved prior watermark/genesis. Only an exact
/// canonical retry projection connects that history to the next claim.
pub(super) fn read_historical_tasks(
    store: &SessionStore,
    pin: &RetainedAttemptHistoryPin,
    catalog: &FmsRunCatalog,
    budget: &mut ReadBudget,
    refs: &mut BTreeSet<String>,
) -> Result<Vec<FmsTaskCatalogEntry>> {
    let run_id = &pin.run_id;
    let mut chains = BTreeMap::<String, Vec<&RetainedAttemptPin>>::new();
    for claim in &pin.attempts { chains.entry(claim.task_id.clone()).or_default().push(claim); }
    let decisions = store.list_retry_decisions(run_id)?;
    if decisions.len() != pin.attempts.len() { bail!("v5 retry decision inventory differs from historical claims"); }
    let mut tasks = Vec::new();
    for (task_id, chain) in &mut chains {
        chain.sort_by_key(|claim| claim.ownership_epoch);
        let current = catalog.tasks.iter().find(|task| &task.task_id == task_id).context("historical task is absent from current catalog")?;
        let current_epoch = current.ownership_epoch.context("historical task has no current claimed epoch")?;
        if chain[0].ownership_epoch != 1 || chain.last().context("empty claim chain")?.ownership_epoch.checked_add(1) != Some(current_epoch) {
            bail!("v5 historical claim epochs do not cover the chain to the current task");
        }
        for (index, claim) in chain.iter().enumerate() {
            if claim.ownership_epoch != index as u64 + 1 || current.attempt_id.as_deref() == Some(claim.attempt_id.as_str()) { bail!("v5 history has a claim gap or reuses current attempt"); }
            let next_attempt = chain.get(index + 1).map(|next| next.attempt_id.as_str()).or(current.attempt_id.as_deref()).context("next admission has no attempt")?;
            let admission = store.read_task_admission(run_id, task_id, &claim.attempt_id)?.context("historical claim has no admission")?;
            let next = store.read_task_admission(run_id, task_id, next_attempt)?.context("historical claim has no next admission")?;
            if admission.expected_catalog_revision >= next.expected_catalog_revision || next.expected_catalog_revision > catalog.revision
                || admission.lease.ownership_epoch != claim.ownership_epoch || admission.lease.resource_id != claim.resource_id
                || next.lease.ownership_epoch != claim.ownership_epoch + 1 {
                bail!("v5 admission revisions or historical claim fences are inconsistent");
            }
            for record in [&admission, &next] {
                if let Some(snapshot) = &record.resolved_inputs_snapshot { refs.extend(snapshot.object_refs()?); }
            }
            let final_event = historical_final_event(store, run_id, claim, budget)?;
            let checkpoint = final_event.payload.get("checkpoint").context("historical terminal event has no checkpoint")?;
            let worker_task = checkpoint.get("task").context("historical checkpoint has no task")?;
            let (commands, events) = final_event.checkpoint_watermarks()?;
            if worker_task.get("lifecycle").and_then(Value::as_str) != Some("failed")
                || worker_task.get("run_id").and_then(Value::as_str) != Some(run_id.as_str())
                || worker_task.get("task_id").and_then(Value::as_str) != Some(task_id.as_str())
                || worker_task.get("attempt_id").and_then(Value::as_str) != Some(claim.attempt_id.as_str())
                || worker_task.get("ownership_epoch").and_then(Value::as_u64) != Some(claim.ownership_epoch)
                || worker_task.get("claim") != checkpoint.get("claim")
                || worker_task.get("input_fingerprint").and_then(Value::as_str) != Some(current.input_fingerprint.as_str()) {
                bail!("historical failed checkpoint does not describe the pinned claim");
            }
            let mut task = next.queued_task.clone();
            if !task.artifact_ids.is_empty() || task.input_fingerprint != current.input_fingerprint { bail!("historical retry changed input identity or retained artifacts"); }
            task.lifecycle = FmsTaskLifecycle::Failed;
            task.readiness = serde_json::from_value(worker_task.get("readiness").cloned().context("historical checkpoint has no readiness")?)?;
            task.observation = Some(serde_json::from_value(worker_task.get("observation").cloned().context("historical checkpoint has no observation")?)?);
            task.attempt_id = Some(claim.attempt_id.clone());
            task.ownership_epoch = Some(claim.ownership_epoch);
            task.resource_id = Some(claim.resource_id.clone());
            task.coordinator_watermark = Some(FmsCoordinatorWatermark { command_sequence: commands, event_sequence: events });
            task.validate(run_id)?;
            let matching = decisions.iter().filter(|decision| decision.task_id == *task_id && decision.attempt_id == claim.attempt_id && decision.ownership_epoch == claim.ownership_epoch).collect::<Vec<_>>();
            if matching.len() != 1 { bail!("historical claim has no unique retry decision"); }
            let decision = matching[0];
            decision.validate_for_task(&task)?;
            if decision.run_id != *run_id || decision.trigger != FmsRetryTrigger::ExplicitOperatorRequest || decision.action != FmsRetryAction::Retry {
                bail!("v5 requires an explicit operator retry for each failed historical claim");
            }
            let mut queued = task.clone();
            queued.lifecycle = FmsTaskLifecycle::Queued;
            queued.observation = Some(FmsObservationState::Reconciling);
            queued.attempt_id = None;
            queued.resolved_input_fingerprint = None;
            queued.resource_id = None;
            if queued != next.queued_task { bail!("next admission is not the exact canonical retry projection of failed history"); }
            tasks.push(task);
        }
    }
    Ok(tasks)
}

fn historical_final_event(store: &SessionStore, run_id: &str, claim: &RetainedAttemptPin, budget: &mut ReadBudget) -> Result<FmsCoordinatorJournalEntry> {
    let relative = format!("runs/{run_id}/coordinator_journal/event");
    let directory = checked_path(store.root(), &relative)?;
    reject_link(&directory)?;
    let mut found = None;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| anyhow::anyhow!("historical journal name is not UTF-8"))?;
        let path = format!("{relative}/{name}");
        budget.observe_file(store.root(), &path, crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize)?;
        let raw = read_bounded_regular_file(store.root(), &path, crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize)?;
        let event: FmsCoordinatorJournalEntry = serde_json::from_slice(&raw)?;
        event.validate()?;
        if event.run_id == run_id && event.task_id == claim.task_id && event.attempt_id == claim.attempt_id
            && event.ownership_epoch == claim.ownership_epoch && event.terminal {
            if event.direction != crate::types::FmsCoordinatorJournalDirection::Event || found.replace(event).is_some() { bail!("historical attempt has an ambiguous terminal event"); }
        }
    }
    found.context("historical attempt has no actual terminal checkpoint")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin() -> RetainedAttemptHistoryPin {
        RetainedAttemptHistoryPin { run_id: "run-history".into(), run_evidence_sha256: "a".repeat(64),
            attempts: vec![RetainedAttemptPin { task_id: "task-history".into(), attempt_id: "attempt-old".into(), ownership_epoch: 1, resource_id: "compute-cpu".into() }] }
    }

    #[test]
    fn v5_inventory_pins_every_raw_file_and_refuses_symlinks_and_unknown_namespaces() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let run = store.root().join("runs/run-history");
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("run_intent.json"), b"first raw bytes").unwrap();
        let records = BTreeMap::from([("run_intent.json", crate::hex_sha256(b"first raw bytes"))]);
        let mut history = pin(); history.run_evidence_sha256 = crate::canonical_json_sha256(&serde_json::to_value(records).unwrap());
        validate_inventory(&store, &[history.clone()], &mut ReadBudget::for_attempt_history_v5()).unwrap();
        fs::write(run.join("run_intent.json"), b"changed bytes").unwrap();
        assert!(validate_inventory(&store, &[history.clone()], &mut ReadBudget::for_attempt_history_v5()).is_err());
        fs::write(run.join("run_intent.json"), b"first raw bytes").unwrap();
        fs::create_dir(run.join("unknown-work")).unwrap();
        assert!(validate_inventory(&store, &[history.clone()], &mut ReadBudget::for_attempt_history_v5()).is_err());
        fs::remove_dir(run.join("unknown-work")).unwrap();
        #[cfg(unix)] {
            std::os::unix::fs::symlink(run.join("run_intent.json"), run.join("artifact_catalog.json")).unwrap();
            assert!(validate_inventory(&store, &[history], &mut ReadBudget::for_attempt_history_v5()).is_err());
        }
    }

    #[test]
    fn v5_inventory_directory_limit_counts_empty_directories_and_root() {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let run = store.root().join("runs/run-history");
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("run_intent.json"), b"raw").unwrap();
        let records = BTreeMap::from([("run_intent.json", crate::hex_sha256(b"raw"))]);
        let mut history = pin(); history.run_evidence_sha256 = crate::canonical_json_sha256(&serde_json::to_value(records).unwrap());
        // SessionStore may create canonical directories itself; derive only the
        // fixture's starting count, then test the production exact boundary.
        fn count(path: &Path) -> usize { 1 + fs::read_dir(path).unwrap().map(|entry| entry.unwrap()).filter(|entry| entry.file_type().unwrap().is_dir()).map(|entry| count(&entry.path())).sum::<usize>() }
        let baseline = count(store.root());
        for index in baseline..MAX_DIRECTORIES { fs::create_dir(store.root().join(format!("empty-{index}"))).unwrap(); }
        validate_inventory(&store, &[history.clone()], &mut ReadBudget::for_attempt_history_v5()).unwrap();
        fs::create_dir(store.root().join("one-too-many")).unwrap();
        assert!(validate_inventory(&store, &[history], &mut ReadBudget::for_attempt_history_v5()).is_err());
    }

    #[test]
    fn v5_inventory_deadline_is_fail_closed() {
        assert!(check_deadline(Instant::now() - Duration::from_secs(1)).is_err());
    }
}
