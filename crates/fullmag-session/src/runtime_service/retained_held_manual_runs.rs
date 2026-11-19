//! Read-only validation of a bounded subset of explicitly held manual runs.
//!
//! This is not an inventory admission gate. The v4 caller must separately
//! prove that disjoint terminal + held subsets exactly cover the store, check
//! combined CAS pins and scheduler references, and hold all native recovery
//! locks through the final CAS and owner transition. Nothing here releases a
//! start gate, reconciles preparation, or changes a catalog.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::repository_path::{
    checked_path, read_bounded_regular_file, reject_link, validate_store_id,
};
use crate::store::SessionStore;
use crate::types::{
    FmsAcceptedStagePreparationReceipt, FmsPreparationProcessExitReceipt,
    FmsPreparationProcessLaunch, FmsPreparationReceipt, FmsPreparationResourceLease,
    FmsResourceLeaseState, FmsRunCatalog, FmsRunIntent, FmsTaskCatalogEntry, FmsTaskLifecycle,
    FmsTaskPreparationReceipt, FmsTaskPreparedObservation, FmsTaskPreparedObservationOutcome,
    FmsTaskReadiness,
};

use super::retained_cancelled_runs::{self, ReadBudget};

const MAX_DOCUMENT_BYTES: usize = crate::archive_document::MAX_CONTROL_DOCUMENT_BYTES as usize;
const MAX_CAS_BYTES: usize = 128 * 1024 * 1024;
const MAX_TREE_DEPTH: usize = 8;

/// An explicit absence expectation, never an optional/default grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TypedExpectedAbsent {
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RetainedHeldManualRunPin {
    pub run_id: String,
    pub run_intent_sha256: String,
    pub run_catalog_sha256: String,
    pub start_release: TypedExpectedAbsent,
}

/// Subset facts only. Global inventory and global CAS-pin legality remain the
/// caller's responsibility, including references belonging to terminal runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HeldManualRunsSubsetPreflight {
    pub(crate) run_count: usize,
    pub(crate) task_count: usize,
    pub(crate) inspected_file_count: usize,
    pub(crate) inspected_file_bytes: u64,
    pub(crate) referenced_object_refs: BTreeSet<String>,
    pub(crate) evidence_sha256_by_relative_path: BTreeMap<String, String>,
}

type PreparationKey = (String, String, String, String);

fn require_absent(root: &Path, relative: &str) -> Result<()> {
    let path = checked_path(root, relative)?;
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("inspect held-manual absence {relative}")),
        Ok(_) => bail!("held-manual recovery requires physical absence of {relative}"),
    }
}

fn file_digest(store: &SessionStore, relative: &str, budget: &mut ReadBudget) -> Result<String> {
    budget.observe_file(store.root(), relative, MAX_DOCUMENT_BYTES)?;
    let first = read_bounded_regular_file(store.root(), relative, MAX_DOCUMENT_BYTES)?;
    let second = read_bounded_regular_file(store.root(), relative, MAX_DOCUMENT_BYTES)?;
    if first != second {
        bail!("held-manual evidence changed during bounded read: {relative}");
    }
    Ok(crate::cas::hex_sha256(&first))
}

fn read_record<T: serde::de::DeserializeOwned>(
    store: &SessionStore,
    relative: &str,
    digests: &BTreeMap<String, String>,
) -> Result<T> {
    let raw = read_bounded_regular_file(store.root(), relative, MAX_DOCUMENT_BYTES)?;
    if digests.get(relative) != Some(&crate::cas::hex_sha256(&raw)) {
        bail!("held-manual record drifted from its observed bytes: {relative}");
    }
    serde_json::from_slice(&raw).with_context(|| format!("parse held-manual record {relative}"))
}

fn observe_tree(
    store: &SessionStore,
    relative: &str,
    depth: usize,
    budget: &mut ReadBudget,
    digests: &mut BTreeMap<String, String>,
) -> Result<()> {
    if depth > MAX_TREE_DEPTH {
        bail!("held-manual run inventory exceeds its depth bound");
    }
    let directory = checked_path(store.root(), relative)?;
    reject_link(&directory)?;
    if !fs::symlink_metadata(&directory)?.is_dir() {
        bail!("held-manual inventory root is not a directory");
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        budget.observe_entry()?;
        reject_link(&entry.path())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("held-manual inventory name is not UTF-8"))?;
        let child = format!("{relative}/{name}");
        let kind = entry.file_type()?;
        if kind.is_dir() {
            observe_tree(store, &child, depth + 1, budget, digests)?;
        } else if kind.is_file() {
            digests.insert(child.clone(), file_digest(store, &child, budget)?);
        } else {
            bail!("held-manual inventory contains a non-file/non-directory");
        }
    }
    Ok(())
}

fn preparation_key(task: &str, attempt: &str, resource: &str, token: &str) -> PreparationKey {
    (task.into(), attempt.into(), resource.into(), token.into())
}

fn validate_preparation(
    store: &SessionStore,
    run_id: &str,
    intent: &FmsRunIntent,
    catalog: &FmsRunCatalog,
    digests: &BTreeMap<String, String>,
    refs: &mut BTreeSet<String>,
) -> Result<()> {
    let prefix = format!("runs/{run_id}/");
    let mut leases = BTreeMap::<PreparationKey, FmsPreparationResourceLease>::new();
    let mut launches = BTreeMap::<PreparationKey, FmsPreparationProcessLaunch>::new();
    let mut exits = BTreeMap::<PreparationKey, FmsPreparationProcessExitReceipt>::new();
    let mut receipts = BTreeMap::<String, FmsTaskPreparationReceipt>::new();
    let mut stages = Vec::<FmsAcceptedStagePreparationReceipt>::new();
    let mut observations = Vec::<FmsTaskPreparedObservation>::new();
    let mut run_receipt = None::<FmsPreparationReceipt>;
    for relative in digests
        .keys()
        .filter(|relative| relative.starts_with(&prefix))
    {
        let suffix = relative
            .strip_prefix(&prefix)
            .context("held-manual inventory prefix disappeared")?;
        let parts = suffix.split('/').collect::<Vec<_>>();
        match parts.as_slice() {
            ["run_intent.json"] | ["run_catalog.json"] => {}
            ["preparation_receipt.json"] => {
                let receipt: FmsPreparationReceipt = read_record(store, relative, digests)?;
                receipt.validate()?;
                if receipt.run_id != run_id
                    || store.read_preparation_receipt(run_id)?.as_ref() != Some(&receipt)
                {
                    bail!(
                        "held-manual run preparation receipt differs from its path or typed read"
                    );
                }
                run_receipt = Some(receipt);
            }
            ["preparation_resource_leases", resource, filename] => {
                let token = filename
                    .strip_suffix(".json")
                    .context("held-manual preparation lease is not JSON")?;
                let lease: FmsPreparationResourceLease = read_record(store, relative, digests)?;
                lease.validate()?;
                if lease.run_id != run_id
                    || lease.resource_id != *resource
                    || lease.lease_token != token
                    || !catalog
                        .tasks
                        .iter()
                        .any(|task| task.task_id == lease.task_id)
                    || lease.state != FmsResourceLeaseState::Released
                    || store
                        .read_preparation_resource_lease(run_id, resource, token)?
                        .as_ref()
                        != Some(&lease)
                {
                    bail!(
                        "held-manual preparation lease is active, stale or outside its task/path"
                    );
                }
                let key = preparation_key(
                    &lease.task_id,
                    &lease.preparation_attempt_id,
                    &lease.resource_id,
                    &lease.lease_token,
                );
                if leases.insert(key, lease).is_some() {
                    bail!("duplicate held-manual preparation lease");
                }
            }
            ["preparation_process_launches", _] => {
                let launch: FmsPreparationProcessLaunch = read_record(store, relative, digests)?;
                launch.validate()?;
                if launch.run_id != run_id || launch.relative_path()? != *relative {
                    bail!("held-manual preparation launch path differs");
                }
                let key = preparation_key(
                    &launch.task_id,
                    &launch.preparation_attempt_id,
                    &launch.resource_id,
                    &launch.lease_token,
                );
                if launches.insert(key, launch).is_some() {
                    bail!("ambiguous held-manual preparation launches");
                }
            }
            ["preparation_process_exit_receipts", _] => {
                let exit: FmsPreparationProcessExitReceipt = read_record(store, relative, digests)?;
                exit.validate()?;
                if exit.run_id != run_id
                    || exit.relative_path()? != *relative
                    || !exit.status_success
                    || exit.exit_code != Some(0)
                    || exit.timed_out
                    || exit.failure_reason.is_some()
                {
                    bail!(
                        "held-manual preparation has no exact successful terminal exit-zero proof"
                    );
                }
                let key = preparation_key(
                    &exit.task_id,
                    &exit.preparation_attempt_id,
                    &exit.resource_id,
                    &exit.lease_token,
                );
                if exits.insert(key, exit).is_some() {
                    bail!("ambiguous held-manual preparation exit receipts");
                }
            }
            ["task_preparation_receipts", _] => {
                let receipt: FmsTaskPreparationReceipt = read_record(store, relative, digests)?;
                receipt.validate_for_catalog(catalog)?;
                receipt.validate_for_run_intent(intent)?;
                if receipt.relative_path()? != *relative
                    || store
                        .read_task_preparation_receipt(run_id, &receipt.task_id)?
                        .as_ref()
                        != Some(&receipt)
                {
                    bail!("held-manual task preparation receipt changed its input fence");
                }
                if receipts.insert(receipt.task_id.clone(), receipt).is_some() {
                    bail!("duplicate held-manual task receipt");
                }
            }
            ["accepted_stage_preparation_receipts", _] => {
                let stage: FmsAcceptedStagePreparationReceipt =
                    read_record(store, relative, digests)?;
                stage.validate()?;
                if stage.run_id != run_id
                    || stage.relative_path()? != *relative
                    || store
                        .read_accepted_stage_preparation_receipt(run_id, &stage.step_id)?
                        .as_ref()
                        != Some(&stage)
                {
                    bail!("held-manual stage pointer differs from its input-fenced receipt");
                }
                stages.push(stage);
            }
            ["task_prepared_observations", _] => {
                let observation: FmsTaskPreparedObservation =
                    read_record(store, relative, digests)?;
                observation.validate()?;
                if observation.run_id != run_id
                    || observation.relative_path()? != *relative
                    || store
                        .read_task_prepared_observation(run_id, &observation.task_id)?
                        .as_ref()
                        != Some(&observation)
                {
                    bail!("held-manual preparation observation differs from its path");
                }
                observations.push(observation);
            }
            _ => bail!(
                "held-manual recovery rejects compute/cancellation/unknown evidence: {relative}"
            ),
        }
    }
    if leases.len() != launches.len() || leases.len() != exits.len() {
        bail!("held-manual preparation lease/launch/exit inventory is incomplete");
    }
    for (key, lease) in &leases {
        let launch = launches
            .get(key)
            .context("released held-manual preparation lease has no exact launch")?;
        let exit = exits
            .get(key)
            .context("released held-manual preparation lease has no terminal process exit")?;
        if launch.lease_heartbeat_sequence > exit.lease_heartbeat_sequence
            || exit.lease_heartbeat_sequence != lease.heartbeat_sequence
            || launch.created_at > exit.observed_at
            || lease
                .released_at
                .is_none_or(|released| released < exit.observed_at)
            || !receipts.contains_key(&lease.task_id)
        {
            bail!("held-manual preparation terminal/input fence is incomplete or inconsistent");
        }
    }
    for task_id in receipts.keys() {
        if !leases.values().any(|lease| &lease.task_id == task_id) {
            bail!(
                "held-manual preparation receipt has no released lease and successful process exit"
            );
        }
    }
    if let Some(receipt) = run_receipt {
        if !receipts.values().any(|task| {
            task.preparation_id == receipt.preparation_id
                && task.plan_fingerprint == receipt.plan_fingerprint
                && task.payload_sha256 == receipt.payload_sha256
        }) {
            bail!("held-manual live preparation anchor lacks an input-fenced task receipt");
        }
    }
    for stage in stages {
        if !receipts
            .get(&stage.task_id)
            .is_some_and(|receipt| stage.matches_task_receipt(receipt))
        {
            bail!("held-manual stage anchor has no matching task receipt");
        }
    }
    for observation in observations {
        let receipt = receipts
            .get(&observation.task_id)
            .context("held-manual prepared observation has no task receipt")?;
        if observation.preparation_id != receipt.preparation_id
            || observation.plan_fingerprint != receipt.plan_fingerprint
        {
            bail!("held-manual prepared observation differs from the task input fence");
        }
        if let FmsTaskPreparedObservationOutcome::Published {
            bundle_object_ref,
            object_refs,
        } = observation.outcome
        {
            refs.insert(bundle_object_ref);
            refs.extend(object_refs);
        }
    }
    Ok(())
}

/// Validate only the named subset; zero pins are legal here. The caller must
/// check the nonempty v4 held list and combined exact inventory independently.
pub(crate) fn validate_held_manual_runs_subset(
    store: &SessionStore,
    pins: &[RetainedHeldManualRunPin],
) -> Result<HeldManualRunsSubsetPreflight> {
    validate_held_manual_runs_subset_with_budget(store, pins, &mut ReadBudget::default())
}

/// V4 shares this budget with terminal evidence and the global CAS gate.
pub(super) fn validate_held_manual_runs_subset_with_budget(
    store: &SessionStore,
    pins: &[RetainedHeldManualRunPin],
    budget: &mut ReadBudget,
) -> Result<HeldManualRunsSubsetPreflight> {
    if pins.len() > retained_cancelled_runs::MAX_RETAINED_CANCELLED_RUN_PINS {
        bail!("held-manual subset exceeds its run limit");
    }
    let mut seen = BTreeSet::new();
    let mut refs = BTreeSet::new();
    let mut evidence = BTreeMap::new();
    let mut task_count = 0usize;
    for pin in pins {
        validate_store_id(&pin.run_id)?;
        retained_cancelled_runs::validate_sha256(&pin.run_intent_sha256, "run_intent_sha256")?;
        retained_cancelled_runs::validate_sha256(&pin.run_catalog_sha256, "run_catalog_sha256")?;
        if !seen.insert(pin.run_id.clone()) {
            bail!("duplicate held-manual subset run pin");
        }
        let prefix = format!("runs/{}", pin.run_id);
        require_absent(store.root(), &format!("{prefix}/start_release.json"))?;
        observe_tree(store, &prefix, 0, budget, &mut evidence)?;
        let intent_path = format!("{prefix}/run_intent.json");
        let catalog_path = format!("{prefix}/run_catalog.json");
        if evidence.get(&intent_path) != Some(&pin.run_intent_sha256)
            || evidence.get(&catalog_path) != Some(&pin.run_catalog_sha256)
        {
            bail!("held-manual raw run-intent/catalog SHA-256 pin mismatch");
        }
        let intent: FmsRunIntent = read_record(store, &intent_path, &evidence)?;
        let catalog: FmsRunCatalog = read_record(store, &catalog_path, &evidence)?;
        intent.validate()?;
        catalog.validate()?;
        if intent.run_id != pin.run_id
            || catalog.run_id != pin.run_id
            || store.read_run_intent(&pin.run_id)?.as_ref() != Some(&intent)
            || store.read_run_catalog(&pin.run_id)?.as_ref() != Some(&catalog)
        {
            bail!("held-manual typed run intent/catalog differs from pinned originals");
        }
        if store.accepted_run_start_permitted(&pin.run_id)? {
            bail!(
                "held-manual recovery requires the existing typed manual start gate to remain held"
            );
        }
        if catalog.tasks.is_empty() {
            bail!("held-manual catalog contains no accepted tasks");
        }
        task_count = task_count
            .checked_add(catalog.tasks.len())
            .context("held-manual task count overflow")?;
        if task_count > retained_cancelled_runs::MAX_RETAINED_CANCELLED_TASKS {
            bail!("held-manual subset exceeds its task limit");
        }
        for task in &catalog.tasks {
            validate_held_task(task)?;
        }
        refs.extend(
            intent
                .definition_object_ref
                .iter()
                .chain(intent.study_object_ref.iter())
                .chain(intent.study_catalog_object_ref.iter())
                .cloned(),
        );
        refs.extend(intent.asset_object_refs.values().cloned());
        validate_preparation(store, &pin.run_id, &intent, &catalog, &evidence, &mut refs)?;
        require_absent(store.root(), &format!("{prefix}/start_release.json"))?;
    }
    for object_ref in &refs {
        retained_cancelled_runs::validate_sha256(object_ref, "held-manual CAS object reference")?;
        let relative = format!("objects/sha256/{object_ref}");
        budget.observe_file(store.root(), &relative, MAX_CAS_BYTES)?;
        let object_path = checked_path(store.root(), &relative)?;
        reject_link(&object_path)?;
        store
            .cas()
            .get_bounded(object_ref, MAX_CAS_BYTES as u64)?
            .context("held-manual immutable CAS input is absent")?;
        let pin_relative = format!("objects/pins/{object_ref}.json");
        let pin_path = checked_path(store.root(), &pin_relative)?;
        match fs::symlink_metadata(&pin_path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("inspect held-manual CAS pin"),
            Ok(_) => {
                let digest = file_digest(store, &pin_relative, budget)?;
                evidence.insert(pin_relative.clone(), digest);
                let pin: AcceptedCasPin = read_record(store, &pin_relative, &evidence)?;
                if pin.schema != "fullmag.cas-pin.v1" || pin.object_ref != *object_ref {
                    bail!("held-manual CAS pin differs from its immutable input");
                }
            }
        }
    }
    for (relative, expected) in &evidence {
        if file_digest(store, relative, budget)? != *expected {
            bail!("held-manual evidence changed before final subset CAS: {relative}");
        }
    }
    // Repeat physical release absence and the typed gate after all preparation
    // and CAS reads. The caller keeps its locks beyond this read-only return.
    for pin in pins {
        let prefix = format!("runs/{}/", pin.run_id);
        let originals = evidence
            .iter()
            .filter(|(path, _)| path.starts_with(&prefix))
            .map(|(path, digest)| (path.clone(), digest.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut current = BTreeMap::new();
        observe_tree(store, prefix.trim_end_matches('/'), 0, budget, &mut current)?;
        if current != originals {
            bail!("held-manual run evidence inventory changed before final subset CAS");
        }
        require_absent(
            store.root(),
            &format!("runs/{}/start_release.json", pin.run_id),
        )?;
        if store.accepted_run_start_permitted(&pin.run_id)? {
            bail!("held-manual start gate changed during subset preflight");
        }
    }
    Ok(HeldManualRunsSubsetPreflight {
        run_count: pins.len(),
        task_count,
        inspected_file_count: budget.inspected_file_count(),
        inspected_file_bytes: budget.inspected_file_bytes(),
        referenced_object_refs: refs,
        evidence_sha256_by_relative_path: evidence,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AcceptedCasPin {
    schema: String,
    object_ref: String,
}

fn validate_held_task(task: &FmsTaskCatalogEntry) -> Result<()> {
    if task.lifecycle != FmsTaskLifecycle::Accepted
        || !matches!(&task.readiness, FmsTaskReadiness::Blocked { .. })
        || task.attempt_id.is_some()
        || task.resource_id.is_some()
        || task.ownership_epoch.is_some()
        || task.resolved_input_fingerprint.is_some()
        || task.coordinator_genesis.is_some()
        || task.coordinator_watermark.is_some()
        || task.observation.is_some()
        || !task.artifact_ids.is_empty()
    {
        bail!("held-manual task must remain accepted/blocked without compute claim or outputs");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        canonical_json_sha256, task_id_for_study_step, FmsResourceBudget,
        FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA, FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA,
        FMS_PREPARATION_RESOURCE_LEASE_SCHEMA, FMS_RUN_CATALOG_SCHEMA,
    };
    use chrono::Utc;
    use serde_json::json;

    const RUN: &str = "run-manual-held";
    const STEP: &str = "preview";

    struct Fixture {
        _directory: tempfile::TempDir,
        store: SessionStore,
        pin: RetainedHeldManualRunPin,
        input: String,
    }

    fn write_json(root: &Path, relative: &str, value: &impl Serialize) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
    }

    fn refresh(fixture: &mut Fixture) {
        fixture.pin.run_intent_sha256 = crate::cas::hex_sha256(
            &fs::read(
                fixture
                    .store
                    .root()
                    .join(format!("runs/{RUN}/run_intent.json")),
            )
            .unwrap(),
        );
        fixture.pin.run_catalog_sha256 = crate::cas::hex_sha256(
            &fs::read(
                fixture
                    .store
                    .root()
                    .join(format!("runs/{RUN}/run_catalog.json")),
            )
            .unwrap(),
        );
    }

    fn fixture() -> Fixture {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path().join("store")).unwrap();
        let input = store.cas().put(b"immutable manual accepted input").unwrap();
        let mut intent = FmsRunIntent::new(
            RUN,
            "manual-held-intent",
            json!({
                "run_id": RUN, "snapshot": {"definition_sha256": input}, "immutable_assets": [],
                "parameters": {"fullmag.accepted_run_start": {"schema_version":"accepted_run_start_policy.v1", "mode":"manual"}}
            }),
        );
        intent.definition_object_ref = Some(input.clone());
        intent.validate().unwrap();
        let task = FmsTaskCatalogEntry {
            task_id: task_id_for_study_step(RUN, STEP).unwrap(),
            input_fingerprint: "a".repeat(64),
            lifecycle: FmsTaskLifecycle::Accepted,
            readiness: FmsTaskReadiness::Blocked {
                reason: "awaiting preparation".into(),
            },
            observation: None,
            attempt_id: None,
            ownership_epoch: None,
            resolved_input_fingerprint: None,
            artifact_ids: Vec::new(),
            resource_id: None,
            coordinator_watermark: None,
            coordinator_genesis: None,
        };
        let catalog = FmsRunCatalog {
            schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: RUN.into(),
            revision: 1,
            updated_at: Utc::now(),
            tasks: vec![task],
        };
        write_json(
            store.root(),
            &format!("runs/{RUN}/run_intent.json"),
            &intent,
        );
        write_json(
            store.root(),
            &format!("runs/{RUN}/run_catalog.json"),
            &catalog,
        );
        let pin = RetainedHeldManualRunPin {
            run_id: RUN.into(),
            run_intent_sha256: String::new(),
            run_catalog_sha256: String::new(),
            start_release: TypedExpectedAbsent::Absent,
        };
        let mut fixture = Fixture {
            _directory: directory,
            store,
            pin,
            input,
        };
        refresh(&mut fixture);
        fixture
    }

    fn validate(fixture: &Fixture) -> Result<HeldManualRunsSubsetPreflight> {
        let _writer = fixture.store.write_transaction()?;
        validate_held_manual_runs_subset(&fixture.store, std::slice::from_ref(&fixture.pin))
    }

    fn add_successful_preparation(fixture: &Fixture) {
        let intent = fixture.store.read_run_intent(RUN).unwrap().unwrap();
        let catalog = fixture.store.read_run_catalog(RUN).unwrap().unwrap();
        let task = &catalog.tasks[0];
        let preparation_id = format!("prep-{}", task.task_id);
        let plan = format!("sha256:{}", "b".repeat(64));
        let problem = format!("sha256:{}", "c".repeat(64));
        let specification = format!("sha256:{}", canonical_json_sha256(&intent.specification));
        let payload = json!({"schema_version":"preparation_receipt.v1", "preparation_id":preparation_id,
            "plan_fingerprint":plan, "plan":{"schema_version":"preparation_plan.v2", "problem_fingerprint":problem,
                "source":{"kind":"accepted_run_step", "run_id":RUN, "step_id":STEP, "specification_fingerprint":specification}},
            "accepted_run_source":{"schema_version":"accepted_run_preparation_source.v1", "run_id":RUN,
                "step_id":STEP, "specification_fingerprint":specification, "problem_fingerprint":problem}});
        let receipt = FmsTaskPreparationReceipt::new(
            RUN,
            STEP,
            task.input_fingerprint.clone(),
            preparation_id.clone(),
            plan.clone(),
            payload.clone(),
        )
        .unwrap();
        receipt.validate_for_run_intent(&intent).unwrap();
        write_json(
            fixture.store.root(),
            &receipt.relative_path().unwrap(),
            &receipt,
        );
        let run_receipt = FmsPreparationReceipt::new(preparation_id, RUN, plan, payload);
        write_json(
            fixture.store.root(),
            &format!("runs/{RUN}/preparation_receipt.json"),
            &run_receipt,
        );
        let stage = FmsAcceptedStagePreparationReceipt::from_task_receipt(&receipt).unwrap();
        write_json(
            fixture.store.root(),
            &stage.relative_path().unwrap(),
            &stage,
        );
        let now = Utc::now();
        let lease = FmsPreparationResourceLease {
            schema_version: FMS_PREPARATION_RESOURCE_LEASE_SCHEMA.into(),
            resource_id: "preparer".into(),
            budget: FmsResourceBudget {
                cpu_millis: 1000,
                memory_bytes: 1024,
                gpu_memory_bytes: 0,
                storage_bytes: 1024,
            },
            run_id: RUN.into(),
            task_id: task.task_id.clone(),
            preparation_attempt_id: "preparation-attempt".into(),
            lease_token: "preparation-token".into(),
            state: FmsResourceLeaseState::Released,
            acquired_at: now,
            heartbeat_at: now,
            heartbeat_sequence: 1,
            released_at: Some(now),
            host_launch_binding: None,
        };
        write_json(
            fixture.store.root(),
            &format!("runs/{RUN}/preparation_resource_leases/preparer/preparation-token.json"),
            &lease,
        );
        let launch = FmsPreparationProcessLaunch {
            schema_version: FMS_PREPARATION_PROCESS_LAUNCH_SCHEMA.into(),
            launch_id: "launch-1".into(),
            run_id: RUN.into(),
            task_id: task.task_id.clone(),
            preparation_attempt_id: lease.preparation_attempt_id.clone(),
            resource_id: lease.resource_id.clone(),
            lease_token: lease.lease_token.clone(),
            lease_heartbeat_sequence: 0,
            supervisor_process_id: 100,
            supervisor_start_token: Some("supervisor-start".into()),
            created_at: now,
        };
        write_json(
            fixture.store.root(),
            &launch.relative_path().unwrap(),
            &launch,
        );
        let exit = FmsPreparationProcessExitReceipt {
            schema_version: FMS_PREPARATION_PROCESS_EXIT_RECEIPT_SCHEMA.into(),
            receipt_id: "exit-1".into(),
            run_id: RUN.into(),
            task_id: task.task_id.clone(),
            preparation_attempt_id: lease.preparation_attempt_id,
            resource_id: lease.resource_id,
            lease_token: lease.lease_token,
            lease_heartbeat_sequence: 1,
            process_id: 101,
            process_start_token: Some("preparer-start".into()),
            status_success: true,
            exit_code: Some(0),
            timed_out: false,
            failure_reason: None,
            observed_at: now,
        };
        write_json(fixture.store.root(), &exit.relative_path().unwrap(), &exit);
    }

    #[test]
    fn explicit_absent_is_required_and_pin_shape_is_frozen() {
        let value = json!({"run_id":RUN,"run_intent_sha256":"a".repeat(64),"run_catalog_sha256":"b".repeat(64),"start_release":"absent"});
        assert!(serde_json::from_value::<RetainedHeldManualRunPin>(value.clone()).is_ok());
        for replacement in [json!(null), json!("present"), json!(true)] {
            let mut invalid = value.clone();
            invalid["start_release"] = replacement;
            assert!(serde_json::from_value::<RetainedHeldManualRunPin>(invalid).is_err());
        }
        let mut absent = value.clone();
        absent.as_object_mut().unwrap().remove("start_release");
        assert!(serde_json::from_value::<RetainedHeldManualRunPin>(absent).is_err());
        let mut extra = value;
        extra["unexpected"] = json!(true);
        assert!(serde_json::from_value::<RetainedHeldManualRunPin>(extra).is_err());
    }

    #[test]
    fn manual_subset_does_not_claim_global_inventory_and_never_publishes_release() {
        let fixture = fixture();
        fs::create_dir_all(fixture.store.root().join("runs/other-terminal-run")).unwrap();
        let before = fs::read(
            fixture
                .store
                .root()
                .join(format!("runs/{RUN}/run_catalog.json")),
        )
        .unwrap();
        let facts = validate(&fixture).unwrap();
        assert_eq!(facts.run_count, 1);
        assert_eq!(facts.task_count, 1);
        assert!(facts.referenced_object_refs.contains(&fixture.input));
        assert!(!fixture
            .store
            .root()
            .join(format!("runs/{RUN}/start_release.json"))
            .exists());
        assert_eq!(
            before,
            fs::read(
                fixture
                    .store
                    .root()
                    .join(format!("runs/{RUN}/run_catalog.json"))
            )
            .unwrap()
        );
        let _writer = fixture.store.write_transaction().unwrap();
        assert_eq!(
            validate_held_manual_runs_subset(&fixture.store, &[])
                .unwrap()
                .run_count,
            0
        );
    }

    #[test]
    fn automatic_malformed_and_released_runs_are_rejected() {
        for mode in [
            json!("automatic"),
            json!("unknown"),
            json!({"unexpected":true}),
        ] {
            let mut fixture = fixture();
            let mut intent = fixture.store.read_run_intent(RUN).unwrap().unwrap();
            intent.specification["parameters"]["fullmag.accepted_run_start"]["mode"] = mode;
            intent.payload_sha256 = canonical_json_sha256(&intent.specification);
            write_json(
                fixture.store.root(),
                &format!("runs/{RUN}/run_intent.json"),
                &intent,
            );
            refresh(&mut fixture);
            assert!(validate(&fixture).is_err());
        }
        let fixture = fixture();
        write_json(
            fixture.store.root(),
            &format!("runs/{RUN}/start_release.json"),
            &json!({"malformed":"still physically present"}),
        );
        assert!(validate(&fixture).is_err());
    }

    #[test]
    fn queued_ready_claimed_and_output_task_states_are_rejected() {
        for mutation in 0..6 {
            let mut fixture = fixture();
            let mut catalog = fixture.store.read_run_catalog(RUN).unwrap().unwrap();
            let task = &mut catalog.tasks[0];
            match mutation {
                0 => task.lifecycle = FmsTaskLifecycle::Queued,
                1 => task.readiness = FmsTaskReadiness::Ready,
                2 => {
                    task.attempt_id = Some("attempt".into());
                    task.ownership_epoch = Some(1);
                }
                3 => task.resource_id = Some("resource".into()),
                4 => task.resolved_input_fingerprint = Some("d".repeat(64)),
                _ => task.artifact_ids.push("artifact".into()),
            }
            write_json(
                fixture.store.root(),
                &format!("runs/{RUN}/run_catalog.json"),
                &catalog,
            );
            refresh(&mut fixture);
            assert!(validate(&fixture).is_err());
        }
    }

    #[test]
    fn compute_cancellation_and_unknown_evidence_cannot_hide_under_manual_policy() {
        for namespace in [
            "task_cancellation_intents",
            "resource_leases",
            "task_admissions",
            "coordinator_journal",
            "worker_inbox",
            "worker_process_exit_receipts",
            "unknown_pending",
        ] {
            let fixture = fixture();
            write_json(
                fixture.store.root(),
                &format!("runs/{RUN}/{namespace}/record.json"),
                &json!({}),
            );
            assert!(validate(&fixture).is_err());
        }
    }

    #[test]
    fn stale_raw_and_corrupt_accepted_input_cas_are_rejected() {
        let fixture = fixture();
        let path = fixture
            .store
            .root()
            .join(format!("runs/{RUN}/run_intent.json"));
        let mut bytes = fs::read(&path).unwrap();
        bytes.push(b' ');
        fs::write(path, bytes).unwrap();
        assert!(validate(&fixture).is_err());
        let fixture = self::fixture();
        fs::write(
            fixture
                .store
                .root()
                .join(format!("objects/sha256/{}", fixture.input)),
            b"changed input",
        )
        .unwrap();
        assert!(validate(&fixture).is_err());
    }

    #[test]
    fn released_preparation_with_successful_exit_zero_and_input_fence_is_read_only() {
        let fixture = fixture();
        add_successful_preparation(&fixture);
        let receipt = fixture
            .store
            .root()
            .join(format!("runs/{RUN}/preparation_receipt.json"));
        let before = fs::read(&receipt).unwrap();
        assert_eq!(validate(&fixture).unwrap().task_count, 1);
        assert_eq!(fs::read(receipt).unwrap(), before);
    }

    #[test]
    fn active_missing_exit_or_input_fence_drift_blocks_held_preparation() {
        for mutation in 0..4 {
            let fixture = fixture();
            add_successful_preparation(&fixture);
            match mutation {
                0 => {
                    let relative = format!(
                        "runs/{RUN}/preparation_resource_leases/preparer/preparation-token.json"
                    );
                    let mut lease: FmsPreparationResourceLease = serde_json::from_slice(
                        &fs::read(fixture.store.root().join(&relative)).unwrap(),
                    )
                    .unwrap();
                    lease.state = FmsResourceLeaseState::Active;
                    lease.released_at = None;
                    write_json(fixture.store.root(), &relative, &lease);
                }
                1 => {
                    fs::remove_file(fixture.store.root().join(format!(
                        "runs/{RUN}/preparation_process_exit_receipts/exit-1.json"
                    )))
                    .unwrap();
                }
                2 => {
                    let relative =
                        format!("runs/{RUN}/preparation_process_exit_receipts/exit-1.json");
                    let mut exit: FmsPreparationProcessExitReceipt = serde_json::from_slice(
                        &fs::read(fixture.store.root().join(&relative)).unwrap(),
                    )
                    .unwrap();
                    exit.status_success = false;
                    exit.exit_code = Some(1);
                    exit.failure_reason = Some("failed".into());
                    write_json(fixture.store.root(), &relative, &exit);
                }
                _ => {
                    let task = task_id_for_study_step(RUN, STEP).unwrap();
                    let relative = format!("runs/{RUN}/task_preparation_receipts/{task}.json");
                    let mut receipt: FmsTaskPreparationReceipt = serde_json::from_slice(
                        &fs::read(fixture.store.root().join(&relative)).unwrap(),
                    )
                    .unwrap();
                    receipt.input_fingerprint = "e".repeat(64);
                    write_json(fixture.store.root(), &relative, &receipt);
                }
            }
            assert!(validate(&fixture).is_err());
        }
    }

    #[test]
    fn manual_held_union_includes_terminal_cas_without_weakening_v3_inventory() {
        let fixture = fixture();
        let terminal_run = "run-already-cancelled";
        let input = fixture
            .store
            .cas()
            .put(b"separate immutable terminal input")
            .unwrap();
        let mut intent = FmsRunIntent::new(
            terminal_run,
            "terminal-intent",
            json!({
                "run_id":terminal_run,"snapshot":{"definition_sha256":input},"immutable_assets":[]
            }),
        );
        intent.definition_object_ref = Some(input);
        fixture.store.commit_run_intent(&intent).unwrap();
        let mut task = fixture.store.read_run_catalog(RUN).unwrap().unwrap().tasks[0].clone();
        task.task_id = "terminal-task".into();
        fixture
            .store
            .commit_run_catalog(&FmsRunCatalog {
                schema_version: FMS_RUN_CATALOG_SCHEMA.into(),
                run_id: terminal_run.into(),
                revision: 1,
                updated_at: Utc::now(),
                tasks: vec![task.clone()],
            })
            .unwrap();
        // This synthetic fixture supplies an already cancelled terminal run;
        // recovery itself never calls the cancellation API or changes status.
        fixture
            .store
            .request_task_cancellation_intent(
                terminal_run,
                &task.task_id,
                "fixture-cancelled",
                1,
                "terminal fixture",
            )
            .unwrap();
        let mut terminal_catalog = fixture
            .store
            .read_run_catalog(terminal_run)
            .unwrap()
            .unwrap();
        terminal_catalog.tasks[0].lifecycle = FmsTaskLifecycle::Cancelled;
        terminal_catalog.revision += 1;
        terminal_catalog.updated_at = Utc::now();
        fixture.store.commit_run_catalog(&terminal_catalog).unwrap();
        let pin = super::super::retained_terminal_runs::RetainedTerminalRunPin {
            run_id: terminal_run.into(),
            run_intent_sha256: crate::cas::hex_sha256(
                &fs::read(
                    fixture
                        .store
                        .root()
                        .join(format!("runs/{terminal_run}/run_intent.json")),
                )
                .unwrap(),
            ),
            run_catalog_sha256: crate::cas::hex_sha256(
                &fs::read(
                    fixture
                        .store
                        .root()
                        .join(format!("runs/{terminal_run}/run_catalog.json")),
                )
                .unwrap(),
            ),
            artifact_catalog_sha256: None,
        };
        let held_catalog = fixture
            .store
            .root()
            .join(format!("runs/{RUN}/run_catalog.json"));
        let terminal_catalog = fixture
            .store
            .root()
            .join(format!("runs/{terminal_run}/run_catalog.json"));
        let before_held = fs::read(&held_catalog).unwrap();
        let before_terminal = fs::read(&terminal_catalog).unwrap();
        let _writer = fixture.store.write_transaction().unwrap();
        assert!(
            super::super::retained_terminal_runs::validate_retained_terminal_runs(
                &fixture.store,
                std::slice::from_ref(&pin)
            )
            .is_err()
        );
        let ids = super::super::validate_manual_held_union(
            &fixture.store,
            std::slice::from_ref(&pin),
            std::slice::from_ref(&fixture.pin),
        )
        .unwrap();
        assert_eq!(ids.len(), 2);
        assert_eq!(fs::read(&held_catalog).unwrap(), before_held);
        assert_eq!(fs::read(&terminal_catalog).unwrap(), before_terminal);
        assert!(!fixture.store.accepted_run_start_permitted(RUN).unwrap());
        assert!(super::super::validate_manual_held_union(
            &fixture.store,
            &[],
            std::slice::from_ref(&fixture.pin)
        )
        .is_err());
    }

    #[test]
    fn manual_held_union_rejects_global_cas_pins_outside_both_subsets() {
        let fixture = fixture();
        fixture
            .store
            .cas()
            .put(b"unrelated pinned pending work")
            .unwrap();
        let _writer = fixture.store.write_transaction().unwrap();
        assert!(super::super::validate_manual_held_union(
            &fixture.store,
            &[],
            std::slice::from_ref(&fixture.pin)
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn dangling_release_symlink_and_preparation_symlink_are_not_absence() {
        use std::os::unix::fs::symlink;
        let fixture = fixture();
        symlink(
            "missing",
            fixture
                .store
                .root()
                .join(format!("runs/{RUN}/start_release.json")),
        )
        .unwrap();
        assert!(validate(&fixture).is_err());
        let fixture = self::fixture();
        symlink(
            "missing",
            fixture
                .store
                .root()
                .join(format!("runs/{RUN}/preparation_receipt.json")),
        )
        .unwrap();
        assert!(validate(&fixture).is_err());
    }
}
