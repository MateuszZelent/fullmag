//! Offline cold integrity gate: no admission, lease, journal or CAS mutation.
use anyhow::{bail, Context, Result};
use fullmag_application::{AcceptedPreparationReceipt, CoordinatorCheckpoint, ProjectId, RunId, TaskLifecycle, WorkerEvent};
use fullmag_session::{FmsTaskLifecycle, ReadTransaction, SessionStore};
#[path = "study_imported_retained_current_field.rs"]
mod retained_import;
pub use retained_import::{load_imported_retained_current_field_inspection, load_imported_study_evidence_for_inspection};


fn exact_attempt(actual_attempt: Option<&str>, actual_epoch: Option<u64>, attempt: &str, epoch: u64) -> Result<()> {
    if epoch == 0 || actual_attempt != Some(attempt) || actual_epoch != Some(epoch) {
        bail!("inspection cold-load expected attempt/epoch is not current");
    }
    Ok(())
}

/// Caller owns a quiescent existing store; the native shared descriptor lock
/// excludes writers for this entire read. It never creates a lock/owner file.
pub fn verify_saved_inspection(
    store: &SessionStore, project: &ProjectId, run: &RunId, task_id: &str,
    attempt_id: &str, epoch: u64, expected_object: &str,
) -> Result<serde_json::Value> {
    let transaction = store.read_transaction()
        .context("inspection cold-load requires a valid shared store snapshot")?;
    read_saved_inspection(store, &transaction, project, run, task_id, attempt_id, epoch,
        expected_object, None, crate::study_inspection::validate_accepted_inspection_bytes,
        |evidence, (), _| Ok(evidence))
}

/// Same durable cold-read fence, returning verified field data without filesystem extraction.
pub fn load_saved_inspection(
    store: &SessionStore, project: &ProjectId, run: &RunId, task_id: &str,
    attempt_id: &str, epoch: u64, expected_object: &str,
) -> Result<(serde_json::Value, fullmag_runner::LoadedAntennaClosedLoopInspection)> {
    // HTTP callers already run in the admitted blocking reader lane. Keep
    // synchronous export verification above immediate; never sleep its Tokio thread.
    let transaction = acquire_inspection_read_transaction(store, std::time::Duration::from_secs(5))
        .context("inspection cold-load requires a valid shared store snapshot")?;
    read_saved_inspection(store, &transaction, project, run, task_id, attempt_id, epoch,
        expected_object, None, crate::study_inspection::load_accepted_inspection_bytes,
        |evidence, loaded, _| Ok((evidence, loaded)))
}

pub(crate) fn acquire_inspection_read_transaction(
    store: &SessionStore, wait: std::time::Duration,
) -> Result<ReadTransaction> {
    crate::acquire_store_read_transaction(store, wait)
}

pub(crate) struct SavedInspectionReadContext<'a> {
    pub accepted: &'a crate::AcceptedStudySnapshot,
    pub task: &'a fullmag_session::FmsTaskCatalogEntry,
    pub preparation: &'a AcceptedPreparationReceipt,
    pub artifact: &'a fullmag_session::FmsArtifactCatalogEntry,
    pub step: &'a fullmag_authoring::StudyStep,
    pub output_manifest: &'a fullmag_session::FmsArtifactCatalogEntry,
    pub output_manifest_byte_count: usize,
    pub package_byte_count: usize,
}

/// The publication lane retains its existing exclusive transaction; it must not
/// request a shared descriptor lock while already owning that writer.
#[derive(Clone, Copy)]
pub(crate) enum SavedInspectionFence<'a> {
    Shared(&'a ReadTransaction),
    Exclusive(&'a fullmag_session::WriteTransaction),
    #[cfg(unix)]
    Deferred(&'a DeferredSourceInspectionRead),
}
impl<'a> From<&'a ReadTransaction> for SavedInspectionFence<'a> {
    fn from(transaction: &'a ReadTransaction) -> Self { Self::Shared(transaction) }
}
impl<'a> From<&'a fullmag_session::WriteTransaction> for SavedInspectionFence<'a> {
    fn from(transaction: &'a fullmag_session::WriteTransaction) -> Self { Self::Exclusive(transaction) }
}

impl SavedInspectionFence<'_> {
    pub(crate) fn require_captured_source_records(
        self, records: &[fullmag_session::accepted_provenance::AcceptedProvenanceRecord],
    ) -> Result<()> {
        // Non-Unix callers retain the original full-duration native SH fence.
        #[cfg(not(unix))]
        { let _ = records; if matches!(self, Self::Shared(_)) { return Ok(()); }
            bail!("source capture requires its shared fence"); }
        #[cfg(unix)]
        {
        let Self::Deferred(captured) = self else { bail!("source capture requires its private deferred fence"); };
        let expected_count = captured.records.keys().filter(|path| !path.contains("/coordinator_journal/")).count();
        if records.len() != expected_count || records.iter().any(|record| {
            captured.records.get(&record.source_path).is_none_or(|pin|
                pin.byte_count != record.byte_count || pin.content_sha256 != record.content_sha256)
        }) {
            bail!("source provenance differs from captured authority records");
        }
        Ok(())
        }
    }
}


// Only source-preparation readers use this optimistic, private read token. Every
// mutable authority record is fenced before and after the existing validators;
// none of their physical, causal, typed-closure or CAS checks are substituted.
#[cfg(unix)]
pub(crate) struct DeferredSourceInspectionRead {
    root: std::path::PathBuf,
    run: String,
    records: std::collections::BTreeMap<String, SourceInspectionRecordPin>,
    journal: Vec<fullmag_session::FmsCoordinatorJournalEntry>,
}

#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
struct SourceInspectionRecordPin {
    byte_count: u64,
    content_sha256: String,
    modified: std::time::SystemTime,
    // Atomic replacement and in-place rewrite/restore must both invalidate a
    // capture, including an ABA restoring the original bytes on Linux/WSL.
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

#[cfg(unix)]
fn source_inspection_record_pin(store: &SessionStore, relative: &str, maximum: u64) -> Result<SourceInspectionRecordPin> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let path = fullmag_session::repository_path::checked_path(store.root(), relative)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > maximum {
        bail!("source inspection control record exceeds its existing metadata budget or is not a regular file");
    }
    let mut file = file.take(maximum.checked_add(1).context("source inspection metadata limit overflow")?);
    let mut hash = Sha256::new();
    let mut count = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let length = file.read(&mut buffer)?;
        if length == 0 { break; }
        count = count.checked_add(length as u64).context("source inspection control size overflow")?;
        if count > maximum { bail!("source inspection control record exceeds its existing metadata budget"); }
        hash.update(&buffer[..length]);
    }
    if count != metadata.len() { bail!("source inspection control record changed length"); }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino(), metadata.ctime(), metadata.ctime_nsec())
    };
    Ok(SourceInspectionRecordPin {
        byte_count: count, content_sha256: format!("{:x}", hash.finalize()), modified: metadata.modified()?,
        #[cfg(unix)] identity,
    })
}

#[cfg(unix)]
#[derive(Default)]
struct SourceInspectionReadBudget { bytes: u64, records: usize }

#[cfg(unix)]
impl SourceInspectionReadBudget {
    fn pin(&mut self, store: &SessionStore, relative: &str) -> Result<SourceInspectionRecordPin> {
        use fullmag_session::accepted_provenance::{MAX_ACCEPTED_PROVENANCE_RECORDS, MAX_ACCEPTED_PROVENANCE_RECORD_BYTES};
        if self.records >= MAX_ACCEPTED_PROVENANCE_RECORDS {
            bail!("source inspection control record count exceeds its existing capture budget");
        }
        let remaining = fullmag_antenna_artifacts::retained_current::MAX_RECORD_BYTES_TOTAL
            .checked_sub(self.bytes).context("source inspection control bytes exceed existing capture budget")?;
        let pin = source_inspection_record_pin(store, relative, remaining.min(MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64))?;
        self.records += 1;
        self.bytes = self.bytes.checked_add(pin.byte_count).context("source inspection capture size overflow")?;
        Ok(pin)
    }
}

#[cfg(unix)]
fn source_inspection_records(store: &SessionStore, run: &str)
    -> Result<std::collections::BTreeMap<String, SourceInspectionRecordPin>> {
    use fullmag_session::repository_path::checked_path;
    let mut records = std::collections::BTreeMap::new();
    let mut budget = SourceInspectionReadBudget::default();
    for name in ["run_intent.json", "run_catalog.json", "artifact_catalog.json"] {
        let relative = format!("runs/{run}/{name}");
        if checked_path(store.root(), &relative)?.exists() {
            let pin = budget.pin(store, &relative)?;
            records.insert(relative, pin);
        }
    }
    let mut directories = ["task_preparation_receipts", "accepted_stage_preparation_receipts",
        "coordinator_journal/command", "coordinator_journal/event"].into_iter()
        .map(|name| format!("runs/{run}/{name}")).collect::<Vec<_>>();
    let solutions = checked_path(store.root(), "solutions")?;
    if solutions.exists() {
        for directory in std::fs::read_dir(solutions)? {
            let directory = directory?;
            if !directory.file_type()?.is_dir() { bail!("source inspection solution entry is not a directory"); }
            let name = directory.file_name().into_string().map_err(|_| anyhow::anyhow!("solution directory is not UTF-8"))?;
            let relative = format!("solutions/{name}/manifest.json");
            // The canonical provenance planner also reads nonmatching current
            // manifests to select this run. Charge those reads, but never pin
            // unrelated solution histories or reject their later revisions.
            let pin = budget.pin(store, &relative)?;
            let bytes = fullmag_session::repository_path::read_bounded_regular_file(store.root(), &relative,
                usize::try_from(pin.byte_count)?)?;
            let solution: fullmag_quantities::SolutionSet = serde_json::from_slice(&bytes)?;
            if solution.run_id == run {
                records.insert(relative, pin);
                directories.push(format!("solutions/{name}/revisions"));
            }
        }
    }
    for relative in directories {
        let directory = checked_path(store.root(), &relative)?;
        if !directory.exists() { continue; }
        for file in std::fs::read_dir(directory)? {
            let file = file?;
            if !file.file_type()?.is_file() { bail!("source inspection control entry is not a regular file"); }
            let name = file.file_name().into_string().map_err(|_| anyhow::anyhow!("control record name is not UTF-8"))?;
            let path = format!("{relative}/{name}");
            let pin = budget.pin(store, &path)?;
            records.insert(path, pin);
        }
    }
    Ok(records)
}

#[cfg(unix)]
impl DeferredSourceInspectionRead {
    fn capture(store: &SessionStore, run: &str, transaction: &ReadTransaction) -> Result<Self> {
        fullmag_session::repository_path::validate_store_id(run)?;
        let records = source_inspection_records(store, run)?;
        // Bound all journal control bytes before its existing canonical parser.
        let journal = store.read_coordinator_journal_readonly(run, transaction)?;
        Ok(Self { root: store.root().to_owned(), run: run.into(), records, journal })
    }

    fn require_locked(&self, store: &SessionStore, _transaction: &ReadTransaction) -> Result<()> {
        if store.root() != self.root.as_path() || source_inspection_records(store, &self.run)? != self.records {
            bail!("source inspection authority changed during deferred validation");
        }
        Ok(())
    }
}

/// Capture/recheck are native SH reads. The caller's expensive existing source
/// and provenance verification runs between them, allowing lease writers to run.
pub(crate) fn with_deferred_source_inspection<T>(
    store: &SessionStore, run: &str,
    read: impl FnOnce(SavedInspectionFence<'_>) -> Result<(T, Vec<fullmag_session::accepted_provenance::AcceptedProvenanceCasObject>)>,
) -> Result<T> {
    #[cfg(not(unix))]
    {
        let _ = run;
        let transaction = acquire_inspection_read_transaction(store, std::time::Duration::from_secs(5))?;
        let (result, _) = read(SavedInspectionFence::Shared(&transaction))?;
        return Ok(result);
    }
    #[cfg(unix)]
    {
    let transaction = acquire_inspection_read_transaction(store, std::time::Duration::from_secs(5))?;
    let captured = DeferredSourceInspectionRead::capture(store, run, &transaction)?;
    drop(transaction);
    let (result, objects) = read(SavedInspectionFence::Deferred(&captured))?;
    let transaction = acquire_inspection_read_transaction(store, std::time::Duration::from_secs(5))?;
    captured.require_locked(store, &transaction)?;
    for object in objects {
        if store.cas().verified_length(&object.object_ref)? != Some(object.byte_count) {
            bail!("source inspection CAS dependency changed during deferred validation");
        }
    }
    drop(transaction);
    Ok(result)
    }
}

pub(crate) fn read_saved_inspection<'a, R, T>(
    store: &SessionStore, transaction: impl Into<SavedInspectionFence<'a>>, project: &ProjectId, run: &RunId, task_id: &str,
    attempt_id: &str, epoch: u64, expected_object: &str,
    expected_artifact: Option<&str>,
    mut decode_inspection: impl FnMut(&fullmag_ir::ProblemIR, &fullmag_authoring::StudyStep, &[u8], usize) -> Result<R>,
    build: impl FnOnce(serde_json::Value, R, SavedInspectionReadContext<'_>) -> Result<T>,
) -> Result<T> {
    read_saved_inspection_inner(store, transaction, project, run, task_id, attempt_id, epoch, expected_object, expected_artifact, SavedInspectionContract::ClosedLoop, |_, _, problem, step, bytes, maximum|
        decode_inspection(problem, step, bytes, maximum), build)
}

pub(crate) fn read_saved_retained_field_inspection<'a, R, T>(
    store: &SessionStore, transaction: impl Into<SavedInspectionFence<'a>>, project: &ProjectId, run: &RunId, task_id: &str,
    attempt_id: &str, epoch: u64, expected_object: &str,
    expected_artifact: Option<&str>,
    decode_inspection: impl FnMut(&crate::AcceptedStudySnapshot, &fullmag_application::TaskClaim, &fullmag_ir::ProblemIR, &fullmag_authoring::StudyStep, &[u8], usize) -> Result<R>,
    build: impl FnOnce(serde_json::Value, R, SavedInspectionReadContext<'_>) -> Result<T>,
) -> Result<T> {
    read_saved_inspection_inner(store, transaction, project, run, task_id, attempt_id, epoch, expected_object, expected_artifact, SavedInspectionContract::RetainedField, decode_inspection, build)
}

#[derive(Clone, Copy)]
enum SavedInspectionContract { ClosedLoop, RetainedField }

pub(crate) fn read_saved_inspection_inner<'a, R, T>(
    store: &SessionStore, transaction: impl Into<SavedInspectionFence<'a>>, project: &ProjectId, run: &RunId, task_id: &str,
    attempt_id: &str, epoch: u64, expected_object: &str,
    expected_artifact: Option<&str>, contract: SavedInspectionContract,
    mut decode_inspection: impl FnMut(&crate::AcceptedStudySnapshot, &fullmag_application::TaskClaim, &fullmag_ir::ProblemIR, &fullmag_authoring::StudyStep, &[u8], usize) -> Result<R>,
    build: impl FnOnce(serde_json::Value, R, SavedInspectionReadContext<'_>) -> Result<T>,
) -> Result<T> {
    let transaction = transaction.into();
    #[cfg(unix)]
    if let SavedInspectionFence::Deferred(captured) = transaction {
        if captured.root.as_path() != store.root() || captured.run != run.as_str() {
            bail!("deferred source inspection belongs to another store/run");
        }
    }
    let catalog = store.read_run_catalog(run.as_str())?.context("inspection run catalog missing")?;
    let task = catalog.tasks.iter().find(|task| task.task_id == task_id).context("inspection task missing")?;
    if task.lifecycle != FmsTaskLifecycle::Succeeded { bail!("inspection task is not succeeded"); }
    exact_attempt(task.attempt_id.as_deref(), task.ownership_epoch, attempt_id, epoch)?;
    let accepted = crate::load_accepted_study_snapshot(store, run, project)?;
    let step = accepted.study.steps.iter().find(|step| {
        fullmag_session::task_id_for_study_step(run.as_str(), &step.step_id).ok().as_deref() == Some(task_id)
    }).context("inspection task is not an accepted step")?;
    let matching_kind = match contract {
        SavedInspectionContract::ClosedLoop => matches!(&step.kind, fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. }),
        SavedInspectionContract::RetainedField => matches!(&step.kind, fullmag_authoring::StudyStepKind::RetainedCurrentFieldInspection { .. }),
    };
    if !step.enabled || !matching_kind { bail!("cold-load requires its exact enabled typed inspection contract"); }
    let lowered = accepted.lowered.steps.iter().find(|record| record.step_id == step.step_id).context("inspection lowered step missing")?;
    if task.input_fingerprint != fullmag_application::study_task_input_fingerprint(&accepted.run.specification, lowered)? {
        bail!("inspection task fingerprint differs from accepted execution");
    }
    let preparation = accepted.read_task_preparation(store, task_id)?;
    if !matches!((contract, &preparation),
        (SavedInspectionContract::ClosedLoop, AcceptedPreparationReceipt::ClosedLoop(_))
        | (SavedInspectionContract::RetainedField, AcceptedPreparationReceipt::RetainedCurrent(_))
        | (SavedInspectionContract::RetainedField, AcceptedPreparationReceipt::RetainedAssetField(_))) {
        bail!("inspection preparation kind mismatch");
    }
    if preparation.preparation_id() != format!("prep-{task_id}") { bail!("inspection canonical preparation identity mismatch"); }
    let genesis = task.coordinator_genesis.as_ref().context("inspection successful attempt has no durable genesis")?;
    let checkpoint: CoordinatorCheckpoint = serde_json::from_value(genesis.checkpoint.clone())?;
    let claim = checkpoint.claim;
    if claim.run_id != *run || claim.task_id.as_str() != task_id { bail!("inspection genesis belongs to another run/task"); }
    exact_attempt(Some(claim.attempt_id.as_str()), Some(claim.ownership_epoch.value()), attempt_id, epoch)?;
    // All fences use the same causal replay without repairs. Deferred readers
    // supply the captured journal and recheck current authority before return.
    let recovered = crate::recover_coordinator_with_journal(store, &claim, || match transaction {
        SavedInspectionFence::Shared(transaction) =>
            store.read_coordinator_journal_readonly(run.as_str(), transaction),
        SavedInspectionFence::Exclusive(_transaction) =>
            store.read_coordinator_journal(run.as_str()),
        #[cfg(unix)]
        SavedInspectionFence::Deferred(captured) => Ok(captured.journal.clone()),
    })?;
    if recovered.coordinator.task().lifecycle != TaskLifecycle::Succeeded
        || !recovered.events.iter().any(|event| matches!(&event.event, WorkerEvent::Completed { .. })) {
        bail!("inspection cold-load requires exact durable successful Completed");
    }
    // Bound the immutable manifest before the canonical validator reads it.
    // Deferred readers recheck the selected catalog and CAS under their final SH.
    let manifest_catalog = store.read_artifact_catalog(run.as_str())?.context("inspection artifacts missing")?;
    let manifests = manifest_catalog.entries.iter().filter(|entry| entry.task_id == task_id
        && entry.attempt_id == attempt_id && entry.ownership_epoch == epoch
        && entry.artifact_type == "study_output_manifest").collect::<Vec<_>>();
    if manifests.len() != 1 { bail!("inspection has no unique typed completion manifest"); }
    let output_manifest_bytes = store.cas().get_bounded(manifests[0].object_ref.as_deref().context("inspection manifest CAS missing")?, 4 * 1024 * 1024)?
        .context("inspection typed completion manifest missing")?;
    let artifacts = store.read_artifact_catalog(run.as_str())?.context("inspection artifacts missing")?;
    let outputs = artifacts.entries.iter().filter(|artifact| artifact.task_id == task_id
        && artifact.attempt_id == attempt_id && artifact.ownership_epoch == epoch
        && artifact.artifact_type == "artifact" && artifact.study_output.is_some()).collect::<Vec<_>>();
    if outputs.len() != 1 { bail!("inspection requires one published typed artifact"); }
    let output = outputs[0];
    if expected_artifact.is_some_and(|artifact_id| output.artifact_id != artifact_id) {
        bail!("inspection public artifact ID differs from durable output");
    }
    if output.status != fullmag_session::FmsArtifactStatus::Published
        || output.object_ref.as_deref() != Some(expected_object) || output.content_sha256 != expected_object {
        bail!("inspection public CAS object differs from durable output");
    }
    // Completion re-hashes this exact output under the same shared transaction.
    // Release its immutable reader only after every completion fence succeeds;
    // every subsequent request repeats all durable and CAS fences.
    let completion = crate::study::read_study_task_completion_with_inspection(
        store, recovered.coordinator.claim(), &accepted, |problem, step, bytes, maximum|
            decode_inspection(&accepted, recovered.coordinator.claim(), problem, step, bytes, maximum))?;
    let (byte_count, loaded) = completion.into_inspection(expected_object)?;
    build(serde_json::json!({"schema":"fullmag.saved_inspection_integrity.v1","status":"pass",
        "project_id":project.as_str(),"run_id":run.as_str(),"task_id":task_id,"attempt_id":attempt_id,
        "ownership_epoch":epoch,"object_ref":expected_object,"byte_count":byte_count,
        "artifact_id":output.artifact_id,"preparation_id":preparation.preparation_id(),
        "publication":"inspection_only","qualification":"not_verified","read_only":true}),
        loaded, SavedInspectionReadContext { accepted: &accepted, task, preparation: &preparation, artifact: output,
            step, output_manifest: manifests[0],
            output_manifest_byte_count: output_manifest_bytes.len(), package_byte_count: byte_count })
}

fn decode_inspection(bytes: &[u8], maximum: usize, step: &fullmag_authoring::StudyStep)
    -> Result<fullmag_runner::LoadedAntennaClosedLoopInspection> {
    let fullmag_authoring::StudyStepKind::ClosedLoopInspection {
        stage_id, port_mode_id, output_id,
    } = &step.kind else { bail!("verified inspection lost its typed operation"); };
    let bundle = fullmag_application::decode_antenna_inspection_bundle(bytes, maximum)?;
    let manifest: serde_json::Value = serde_json::from_slice(&bundle.manifest_bytes)?;
    let digest = manifest["content_digest"].as_str().context("verified inspection content digest absent")?;
    let artifacts = bundle.payloads.into_iter().map(|(relative_path, bytes)|
        fullmag_runner::AuxiliaryArtifact { relative_path, bytes }).collect();
    let loaded = fullmag_runner::load_antenna_closed_loop_inspection_bytes(
        &bundle.manifest_bytes, artifacts, stage_id, output_id, port_mode_id, digest, maximum)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(loaded)
}

/// Portable evidence stays detached from the accepted execution store. No
/// claims, leases or coordinator journals are reconstructed from an archive.
pub struct ImportedStudyEvidence {
    pub accepted: crate::AcceptedStudySnapshot,
    pub catalog: fullmag_session::FmsRunCatalog,
    pub artifacts: Option<fullmag_session::FmsArtifactCatalog>,
    preparations: std::collections::BTreeMap<String, fullmag_session::FmsTaskPreparationReceipt>,
}

pub fn load_imported_study_evidence(
    store: &SessionStore, run: &RunId, expected_closure: &str,
) -> Result<Option<ImportedStudyEvidence>> {
    load_imported_study_evidence_with_allocation_guard(store, run, expected_closure, None)
}

/// A defensive allocation observer is used only by the new imported H-only reader.
/// The legacy public reader retains its existing budgets and validation behavior.
fn load_imported_study_evidence_with_allocation_guard(
    store: &SessionStore, run: &RunId, expected_closure: &str,
    before_allocation: Option<&mut dyn FnMut(u64) -> Result<()>>,
) -> Result<Option<ImportedStudyEvidence>> {
    let guarded = before_allocation.is_some();
    let allocation = std::cell::RefCell::new(before_allocation);
    let charge = |bytes: u64| -> Result<()> {
        if let Some(observer) = allocation.borrow_mut().as_mut() { observer(bytes)?; }
        Ok(())
    };
    use fullmag_session::accepted_provenance::{AcceptedProvenanceManifest,
        MAX_ACCEPTED_PROVENANCE_RECORD_BYTES};
    use fullmag_session::repository_path::read_bounded_regular_file;
    if guarded {
        let current = fullmag_session::repository_path::checked_path(store.root(), "CURRENT")?;
        if current.exists() {
            charge(std::fs::symlink_metadata(&current)?.len())?;
            let bytes = read_bounded_regular_file(store.root(), "CURRENT", MAX_ACCEPTED_PROVENANCE_RECORD_BYTES)?;
            let id = std::str::from_utf8(&bytes)?.trim();
            fullmag_session::repository_path::validate_store_id(id)?;
            let path = fullmag_session::repository_path::checked_path(store.root(), &format!("manifests/{id}.json"))?;
            charge(std::fs::symlink_metadata(path)?.len())?;
        }
    }
    let session = store.current_session()?.context("imported session manifest absent")?;
    let reference = session.accepted_provenance_ref.context("imported accepted evidence reference absent")?;
    if session.format != fullmag_session::FMS_SESSION_FORMAT_V2
        || reference.accepted_run_id != run.as_str() || reference.closure_sha256 != expected_closure {
        bail!("imported evidence binding differs from the observation");
    }
    if guarded {
        let path = fullmag_session::repository_path::checked_path(
            store.root(), "imports/accepted_provenance/manifest.json",
        )?;
        charge(std::fs::symlink_metadata(path)?.len())?;
    }
    let manifest_bytes = read_bounded_regular_file(store.root(),
        "imports/accepted_provenance/manifest.json", MAX_ACCEPTED_PROVENANCE_RECORD_BYTES)?;
    let manifest: AcceptedProvenanceManifest = serde_json::from_slice(&manifest_bytes)?;
    manifest.validate()?;
    if manifest.accepted_run_id != run.as_str() || manifest.closure_sha256 != expected_closure {
        bail!("imported accepted closure changed");
    }
    if session.session_id != manifest.captured_live_session_id {
        bail!("imported session manifest differs from captured observation");
    }
    let mut records = std::collections::BTreeMap::new();
    let mut total = 0usize;
    for record in &manifest.records {
        total = total.checked_add(usize::try_from(record.byte_count)?).context("imported metadata size overflow")?;
        if total > 64 * 1024 * 1024 { bail!("imported accepted metadata exceeds 64 MiB"); }
        if guarded {
            let path = fullmag_session::repository_path::checked_path(store.root(), &format!("imports/{}", record.archive_path))?;
            if std::fs::symlink_metadata(path)?.len() != record.byte_count {
                bail!("imported record physical size differs from accepted byte count");
            }
        }
        charge(record.byte_count)?;
        let bytes = read_bounded_regular_file(store.root(), &format!("imports/{}", record.archive_path),
            MAX_ACCEPTED_PROVENANCE_RECORD_BYTES)?;
        records.insert(record.archive_path.clone(), bytes);
    }
    manifest.validate_detached_records_with_cas_and_ranges(&records, |object| {
        if guarded {
            let length = store.cas().verified_length(object)?.context("imported metadata CAS absent")?;
            charge(length)?;
        }
        store.cas().get_bounded(object, fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES)
    }, |object, offset, length| {
        charge(length)?;
        store.cas().get_verified_range(object, offset, length, MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64)
    })?;
    for object in &manifest.cas_objects {
        if store.cas().verified_length(&object.object_ref)? != Some(object.byte_count) {
            bail!("imported accepted CAS length/digest differs");
        }
    }
    if guarded {
        load_detached_study_evidence_from_records(store, run, &manifest.records, &records, Some(&mut |bytes| charge(bytes)))
    } else {
        load_detached_study_evidence_from_records(store, run, &manifest.records, &records, None)
    }
}

/// Build canonical immutable inputs only after the caller's typed detached closure gate.
/// This never installs the records into the accepted store or constructs a claim.
fn load_detached_study_evidence_from_records(
    store: &SessionStore, run: &RunId,
    record_entries: &[fullmag_session::accepted_provenance::AcceptedProvenanceRecord],
    records: &std::collections::BTreeMap<String, Vec<u8>>,
    mut before_model_allocation: Option<&mut dyn FnMut(u64) -> Result<()>>,
) -> Result<Option<ImportedStudyEvidence>> {
    let mut intent = None;
    let mut catalog = None;
    let mut artifacts = None;
    let mut preparations = std::collections::BTreeMap::new();
    for record in record_entries {
        let bytes = &records[&record.archive_path];
        match record.kind {
            fullmag_session::accepted_provenance::AcceptedProvenanceRecordKind::RunIntent => intent = Some(serde_json::from_slice::<fullmag_session::FmsRunIntent>(bytes)?),
            fullmag_session::accepted_provenance::AcceptedProvenanceRecordKind::RunCatalog => catalog = Some(serde_json::from_slice(bytes)?),
            fullmag_session::accepted_provenance::AcceptedProvenanceRecordKind::ArtifactCatalog => artifacts = Some(serde_json::from_slice(bytes)?),
            fullmag_session::accepted_provenance::AcceptedProvenanceRecordKind::TaskPreparationReceipt => {
                let receipt: fullmag_session::FmsTaskPreparationReceipt = serde_json::from_slice(bytes)?;
                preparations.insert(receipt.task_id.clone(), receipt);
            },
            _ => {},
        }
    }
    let intent = intent.context("imported RunIntent absent")?;
    if intent.study_object_ref.is_none() { return Ok(None); }
    let specification: fullmag_application::RunSpecification = serde_json::from_value(intent.specification.clone())?;
    if let Some(observer) = before_model_allocation.as_mut() {
        for object in [intent.definition_object_ref.as_deref(), intent.study_object_ref.as_deref(),
            intent.study_catalog_object_ref.as_deref()].into_iter().flatten() {
            let length = store.cas().verified_length(object)?.context("imported model CAS absent")?;
            observer(length)?;
        }
        // Canonical v4 loading also decodes its compiled-source asset and captured
        // source/runtime files. Reserve every immutable asset before entering that
        // loader, including repeated hashes under distinct IDs (separate reads).
        // Assets only stream-verified by the canonical loader are conservatively
        // reserved too; no content bytes or alternate source parser are needed here.
        reserve_imported_immutable_asset_reads(store, &specification.immutable_assets,
            &intent.asset_object_refs, &mut **observer)?;
    }
    let run_snapshot = crate::load_accepted_run_snapshot_from_intent(store.cas(), intent, run, &specification.snapshot.project_id)?;
    let accepted = crate::load_accepted_study_snapshot_from_run(store.cas(), run_snapshot)?;
    Ok(Some(ImportedStudyEvidence { accepted, catalog: catalog.context("imported run catalog absent")?, artifacts, preparations }))
}

fn reserve_imported_immutable_asset_reads(
    store: &SessionStore, assets: &[fullmag_application::ImmutableAssetReference],
    references: &std::collections::BTreeMap<String, String>,
    before_allocation: &mut dyn FnMut(u64) -> Result<()>,
) -> Result<()> {
    if references.len() != assets.len() {
        bail!("imported model asset references differ from immutable RunSpec");
    }
    for asset in assets {
        let object = references.get(&asset.asset_id).context("imported model immutable asset reference absent")?;
        if object != &asset.content_sha256 { bail!("imported model immutable asset differs from RunSpec"); }
        let length = store.cas().verified_length(object)?.context("imported model asset CAS absent")?;
        before_allocation(length)?;
    }
    Ok(())
}

/// Verify the archive-owned result against portable preparation and immutable
/// inputs. This grants visualization only, never execution or LLG capability.
pub fn load_imported_inspection(
    store: &SessionStore, run: &RunId, expected_closure: &str, task_id: &str,
    attempt: &str, epoch: u64, expected_object: &str,
) -> Result<(serde_json::Value, fullmag_runner::LoadedAntennaClosedLoopInspection)> {
    let _transaction = store.read_transaction()?;
    let evidence = load_imported_study_evidence(store, run, expected_closure)?.context("imported run has no Study")?;
    let accepted = &evidence.accepted;
    let step = accepted.study.steps.iter().find(|step|
        fullmag_session::task_id_for_study_step(run.as_str(), &step.step_id).ok().as_deref() == Some(task_id))
        .context("imported inspection is not an accepted step")?;
    if matches!(step.kind, fullmag_authoring::StudyStepKind::RetainedCurrentFieldInspection { .. }) {
        bail!("retained-current H-only child requires its own portable parent closure; closed-loop import is forbidden");
    }
    if !step.enabled || !matches!(step.kind, fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. }) {
        bail!("imported inspection requires an enabled typed closed-loop operation");
    }
    let task = evidence.catalog.tasks.iter().find(|task| task.task_id == task_id).context("imported task absent")?;
    if task.lifecycle != FmsTaskLifecycle::Succeeded { bail!("imported inspection is not succeeded"); }
    exact_attempt(task.attempt_id.as_deref(), task.ownership_epoch, attempt, epoch)?;
    let lowered = accepted.lowered.steps.iter().find(|entry| entry.step_id == step.step_id).context("imported lowered step absent")?;
    if task.input_fingerprint != fullmag_application::study_task_input_fingerprint(&accepted.run.specification, lowered)? {
        bail!("imported inspection fingerprint differs from accepted inputs");
    }
    let preparation = evidence.preparations.get(task_id).context("imported preparation absent")?;
    accepted.bind_closed_inspection_preparation(preparation, task_id)?;
    let artifacts = evidence.artifacts.as_ref().context("imported artifact catalog absent")?;
    let matches = |entry: &&fullmag_session::FmsArtifactCatalogEntry| entry.task_id == task_id
        && entry.attempt_id == attempt && entry.ownership_epoch == epoch;
    let manifests = artifacts.entries.iter().filter(matches).filter(|entry| entry.artifact_type == "study_output_manifest").collect::<Vec<_>>();
    if manifests.len() != 1 { bail!("imported completion manifest is absent or ambiguous"); }
    let manifest_entry = manifests[0];
    let manifest_ref = manifest_entry.object_ref.as_deref().context("imported completion CAS absent")?;
    if manifest_entry.status != fullmag_session::FmsArtifactStatus::Published
        || manifest_entry.content_sha256 != manifest_ref || !task.artifact_ids.contains(&manifest_entry.artifact_id) {
        bail!("imported completion manifest is not exactly published");
    }
    let bytes = store.cas().get_bounded(manifest_ref, fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES)?
        .context("imported completion manifest bytes absent")?;
    let manifest: fullmag_session::FmsStudyOutputManifest = serde_json::from_slice(&bytes)?;
    manifest.validate()?;
    if manifest.run_id != run.as_str() || manifest.task_id != task_id || manifest.step_id != step.step_id
        || manifest.attempt_id != attempt || manifest.ownership_epoch != epoch || manifest.outputs.len() != 1
        || manifest.accepted_state_ref.is_some() || manifest.observation_source.is_some() || step.outputs.len() != 1 {
        bail!("imported completion identity or operation differs");
    }
    let output = &manifest.outputs[0];
    if output.port_id != step.outputs[0].port_id || output.case_id != "default" || output.data_kind != "artifact"
        || output.codec_id != fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_ID
        || output.codec_version != fullmag_application::ANTENNA_INSPECTION_BUNDLE_CODEC_VERSION
        || output.object_ref != expected_object {
        bail!("imported inspection output differs from accepted port/codec/CAS");
    }
    let outputs = artifacts.entries.iter().filter(matches).filter(|entry| entry.artifact_id == output.artifact_id).collect::<Vec<_>>();
    if outputs.len() != 1 { bail!("imported output is absent or ambiguous"); }
    let artifact = outputs[0];
    let expected_identity = fullmag_session::FmsStudyArtifactOutput {
        step_id: step.step_id.clone(), port_id: output.port_id.clone(), case_id: output.case_id.clone() };
    if artifact.status != fullmag_session::FmsArtifactStatus::Published || artifact.artifact_type != "artifact"
        || artifact.object_ref.as_deref() != Some(expected_object) || artifact.content_sha256 != expected_object
        || artifact.study_output.as_ref() != Some(&expected_identity) || !task.artifact_ids.contains(&artifact.artifact_id) {
        bail!("imported inspection artifact differs from its completion");
    }
    let maximum = fullmag_application::ANTENNA_INSPECTION_BUNDLE_MAX_BYTES;
    let bytes = store.cas().get_bounded(expected_object, maximum as u64)?.context("imported inspection CAS absent")?;
    let problem = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step.step_id)
        .context("imported ProblemIR absent")?.problem();
    crate::study_inspection::validate_accepted_inspection_bytes(problem, step, &bytes, maximum)?;
    let loaded = decode_inspection(&bytes, maximum, step)?;
    Ok((serde_json::json!({"artifact_id":artifact.artifact_id,"read_only":true,
        "publication":"inspection_only","qualification":"not_verified","closure_sha256":expected_closure}), loaded))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn deferred_source_store() -> (tempfile::TempDir, SessionStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        store.commit_run_catalog(&fullmag_session::FmsRunCatalog {
            schema_version: fullmag_session::FMS_RUN_CATALOG_SCHEMA.into(),
            run_id: "run-parent".into(), revision: 1, updated_at: chrono::Utc::now(), tasks: vec![],
        }).unwrap();
        (directory, store)
    }

    #[cfg(unix)]
    #[test]
    fn deferred_source_bounds_control_io_before_hashing_or_parsing_journal() {
        use fullmag_session::accepted_provenance::{MAX_ACCEPTED_PROVENANCE_RECORDS, MAX_ACCEPTED_PROVENANCE_RECORD_BYTES};
        let (_directory, store) = deferred_source_store();
        let relative = "runs/run-parent/coordinator_journal/command/oversized.json";
        let path = store.root().join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::File::create(path).unwrap().set_len(MAX_ACCEPTED_PROVENANCE_RECORD_BYTES as u64 + 1).unwrap();
        let error = with_deferred_source_inspection(&store, "run-parent", |_| -> Result<((), Vec<_>)> {
            panic!("oversized journal must fail before canonical decode or physical validation");
        }).unwrap_err();
        assert!(error.to_string().contains("existing metadata budget"));
        let mut full = SourceInspectionReadBudget { bytes: 0, records: MAX_ACCEPTED_PROVENANCE_RECORDS };
        assert!(full.pin(&store, "absent.json").unwrap_err().to_string().contains("record count"));
        let mut exhausted = SourceInspectionReadBudget {
            bytes: fullmag_antenna_artifacts::retained_current::MAX_RECORD_BYTES_TOTAL, records: 1,
        };
        assert!(exhausted.pin(&store, "runs/run-parent/run_catalog.json").unwrap_err()
            .to_string().contains("existing metadata budget"));
    }

    #[cfg(unix)]
    #[test]
    fn deferred_source_validation_longer_than_heartbeat_deadline_allows_native_writers() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};
        let (_directory, store) = deferred_source_store();
        let root = store.root().to_owned();
        let value = with_deferred_source_inspection(&store, "run-parent", |fence| {
            assert!(matches!(fence, SavedInspectionFence::Deferred(_)));
            let (stop_tx, stop_rx) = mpsc::channel();
            let writer = std::thread::spawn(move || {
                let store = SessionStore::open_existing(root).unwrap();
                let mut heartbeats = 0;
                loop {
                    {
                        let _writer = store.write_transaction().expect("physical validation must release SH before a heartbeat writer");
                        // Heartbeats and unrelated runs do not change parent authority.
                        let directory = store.root().join("runs/run-other");
                        std::fs::create_dir_all(&directory).unwrap();
                        std::fs::write(directory.join("heartbeat.json"), heartbeats.to_string()).unwrap();
                    }
                    heartbeats += 1;
                    match stop_rx.recv_timeout(Duration::from_millis(100)) {
                        Ok(()) => return heartbeats,
                        Err(mpsc::RecvTimeoutError::Timeout) => {},
                        Err(error) => panic!("heartbeat test channel failed: {error}"),
                    }
                }
            });
            let start = Instant::now();
            std::thread::sleep(Duration::from_millis(5200));
            stop_tx.send(()).unwrap();
            let heartbeats = writer.join().unwrap();
            assert!(start.elapsed() > Duration::from_secs(5));
            assert!(heartbeats >= 2, "writers must keep making progress during a >5s verifier");
            Ok(("verified", vec![]))
        }).unwrap();
        assert_eq!(value, "verified");
    }

    #[cfg(unix)]
    #[test]
    fn deferred_source_provenance_must_match_the_initial_control_inventory() {
        let (_directory, store) = deferred_source_store();
        with_deferred_source_inspection(&store, "run-parent", |fence| {
            let bytes = std::fs::read(store.root().join("runs/run-parent/run_catalog.json"))?;
            let record = fullmag_session::accepted_provenance::AcceptedProvenanceRecord {
                kind: fullmag_session::accepted_provenance::AcceptedProvenanceRecordKind::RunCatalog,
                source_path: "runs/run-parent/run_catalog.json".into(), archive_path: "catalog.json".into(),
                content_sha256: fullmag_session::hex_sha256(&bytes), byte_count: bytes.len() as u64,
            };
            fence.require_captured_source_records(std::slice::from_ref(&record))?;
            assert!(fence.require_captured_source_records(&[]).is_err());
            let mut transient = record.clone();
            transient.source_path = "solutions/transient/manifest.json".into();
            assert!(fence.require_captured_source_records(&[transient]).is_err());
            let mut changed = record;
            changed.content_sha256 = "a".repeat(64);
            assert!(fence.require_captured_source_records(&[changed]).is_err());
            Ok(((), vec![]))
        }).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn deferred_source_rejects_changed_authority_before_returning_verified_value() {
        let (_directory, store) = deferred_source_store();
        let error = with_deferred_source_inspection(&store, "run-parent", |_| {
            let _writer = store.write_transaction()?;
            let mut catalog = store.read_run_catalog("run-parent")?.unwrap();
            catalog.revision += 1;
            // Deliberately write the test fixture under the native writer; no
            // application command is being introduced by the deferred reader.
            std::fs::write(store.root().join("runs/run-parent/run_catalog.json"), serde_json::to_vec(&catalog)?)?;
            Ok(("must not escape", vec![]))
        }).unwrap_err();
        assert!(error.to_string().contains("authority changed"));
    }

    #[cfg(unix)]
    #[test]
    fn deferred_source_rejects_atomic_aba_replacement_even_when_control_bytes_match() {
        let (_directory, store) = deferred_source_store();
        let error = with_deferred_source_inspection(&store, "run-parent", |_| {
            let _writer = store.write_transaction()?;
            let path = store.root().join("runs/run-parent/run_catalog.json");
            let bytes = std::fs::read(&path)?;
            let replacement = path.with_extension("replacement");
            std::fs::write(&replacement, &bytes)?;
            std::fs::rename(replacement, path)?;
            Ok(((), vec![]))
        }).unwrap_err();
        assert!(error.to_string().contains("authority changed"));
    }

    #[cfg(unix)]
    #[test]
    fn deferred_source_rejects_new_journal_record_and_missing_or_wrong_length_cas() {
        let (_directory, store) = deferred_source_store();
        let error = with_deferred_source_inspection(&store, "run-parent", |_| {
            let _writer = store.write_transaction()?;
            let directory = store.root().join("runs/run-parent/coordinator_journal/event");
            std::fs::create_dir_all(&directory)?;
            std::fs::write(directory.join("new.json"), b"{}")?;
            Ok(((), vec![]))
        }).unwrap_err();
        assert!(error.to_string().contains("authority changed"));
        // A fresh fixture keeps each refusal independent of the corrupt journal.
        let (_directory, store) = deferred_source_store();
        for (object_ref, byte_count) in [("a".repeat(64), 1), (store.cas().put(b"retained").unwrap(), 9)] {
            let error = with_deferred_source_inspection(&store, "run-parent", |_| {
                Ok(((), vec![fullmag_session::accepted_provenance::AcceptedProvenanceCasObject { object_ref, byte_count }]))
            }).unwrap_err();
            assert!(error.to_string().contains("CAS dependency changed"));
        }
    }

    #[test]
    fn current_attempt_and_epoch_are_both_required() {
        assert!(exact_attempt(Some("a"), Some(2), "a", 2).is_ok());
        assert!(exact_attempt(Some("old"), Some(2), "a", 2).is_err());
        assert!(exact_attempt(Some("a"), Some(1), "a", 2).is_err());
        assert!(exact_attempt(None, Some(2), "a", 2).is_err());
        assert!(exact_attempt(Some("a"), None, "a", 2).is_err());
        assert!(exact_attempt(Some("a"), Some(0), "a", 0).is_err());
    }

    #[test]
    fn snapshot_acquisition_waits_for_writer_release_without_owner_writes() {
        use std::sync::mpsc;
        use std::time::Duration;
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let writer = store.write_transaction().unwrap();
        let writer_owner = std::fs::read(store.root().join("WRITER.owner.json")).unwrap();
        let writer_identity: serde_json::Value = serde_json::from_slice(&writer_owner).unwrap();
        let root = store.root().to_path_buf();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let store = SessionStore::open_existing(root).unwrap();
            ready_tx.send(()).unwrap();
            let transaction = crate::acquire_store_read_transaction(&store, Duration::from_secs(2)).unwrap();
            let owner = std::fs::read(store.root().join("WRITER.owner.json")).unwrap();
            result_tx.send(owner.clone()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(std::fs::read(store.root().join("WRITER.owner.json")).unwrap(), owner);
            drop(transaction);
        });
        ready_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let pending = result_rx.recv_timeout(Duration::from_millis(50));
        assert_eq!(std::fs::read(store.root().join("WRITER.owner.json")).unwrap(), writer_owner);
        drop(writer);
        assert!(matches!(pending, Err(mpsc::RecvTimeoutError::Timeout)), "reader must wait while writer owns the native fence");
        let owner = result_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let reader_identity: serde_json::Value = serde_json::from_slice(&owner).unwrap();
        assert_eq!(reader_identity["token"], writer_identity["token"], "reader must not establish a new writer identity");
        assert_eq!(reader_identity["released"], true);
        assert_eq!(std::fs::read(store.root().join("WRITER.owner.json")).unwrap(), owner);
        let second_reader = store.read_transaction().expect("a second shared reader must coexist");
        let descriptor = std::fs::OpenOptions::new().read(true).write(true).open(store.root().join("WRITER.lock")).unwrap();
        assert!(matches!(descriptor.try_lock(), Err(std::fs::TryLockError::WouldBlock)), "shared reader must still exclude native writers");
        release_tx.send(()).unwrap();
        reader.join().unwrap();
        drop(second_reader);
    }

    #[test]
    fn snapshot_deadline_preserves_busy_error_and_owner() {
        use std::time::Duration;
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        let _writer = store.write_transaction().unwrap();
        let owner = std::fs::read(store.root().join("WRITER.owner.json")).unwrap();
        let wait = Duration::from_millis(20);
        let start = std::time::Instant::now();
        let error = crate::acquire_store_read_transaction(&store, wait).err().unwrap();
        assert!(start.elapsed() >= wait, "persistent contention must wait through the acquisition deadline");
        assert!(start.elapsed() < Duration::from_secs(2), "the short test deadline must not become the five-second production wait");
        assert!(error.chain().any(|cause| matches!(cause.downcast_ref::<std::fs::TryLockError>(), Some(std::fs::TryLockError::WouldBlock))));
        assert_eq!(std::fs::read(store.root().join("WRITER.owner.json")).unwrap(), owner);
    }

    #[test]
    fn corrupt_read_descriptor_is_not_retried() {
        use std::time::{Duration, Instant};
        let directory = tempfile::tempdir().unwrap();
        let store = SessionStore::open(directory.path()).unwrap();
        std::fs::write(store.root().join("WRITER.lock"), b"invalid").unwrap();
        let owner = std::fs::read(store.root().join("WRITER.owner.json")).unwrap();
        let start = Instant::now();
        let error = crate::acquire_store_read_transaction(&store, Duration::from_secs(5)).err().unwrap();
        assert!(error.to_string().contains("corrupt session read lock descriptor"));
        assert!(start.elapsed() < Duration::from_secs(1), "non-contention errors must bypass the five-second wait");
        assert_eq!(std::fs::read(store.root().join("WRITER.owner.json")).unwrap(), owner);
    }

}
