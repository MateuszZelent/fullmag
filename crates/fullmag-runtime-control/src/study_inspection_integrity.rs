//! Offline cold integrity gate: no admission, lease, journal or CAS mutation.
use anyhow::{bail, Context, Result};
use fullmag_application::{AcceptedPreparationReceipt, CoordinatorCheckpoint, ProjectId, RunId, TaskLifecycle, WorkerEvent};
use fullmag_session::{FmsTaskLifecycle, ReadTransaction, SessionStore};

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
        expected_object, false, |evidence, _| Ok(evidence))
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
        expected_object, true, |evidence, loaded| {
            Ok((evidence, loaded.context("verified completion did not retain its inspection reader")?))
        })
}

/// Retry only acquisition, before any catalog, journal or payload has been read.
/// Preserve the native error chain so the facade can still report store contention.
fn acquire_inspection_read_transaction(store: &SessionStore, wait: std::time::Duration) -> Result<ReadTransaction> {
    use std::hash::{Hash, Hasher};
    use std::time::{Duration, Instant};

    let deadline = Instant::now() + wait;
    let mut attempt = 0_u64;
    loop {
        match store.read_transaction() {
            Ok(transaction) => return Ok(transaction),
            Err(error) if error.chain().any(|cause| matches!(
                cause.downcast_ref::<std::fs::TryLockError>(), Some(std::fs::TryLockError::WouldBlock)
            )) && Instant::now() < deadline => {
                // Match the existing store-writer backoff without changing its error classification.
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                std::process::id().hash(&mut hasher);
                std::thread::current().id().hash(&mut hasher);
                attempt.hash(&mut hasher);
                attempt = attempt.saturating_add(1);
                let delay = Duration::from_millis(5 + hasher.finish() % 36);
                std::thread::sleep(delay.min(deadline.saturating_duration_since(Instant::now())));
                if Instant::now() >= deadline { return Err(error); }
            }
            Err(error) => return Err(error),
        }
    }
}

fn read_saved_inspection<T>(
    store: &SessionStore, transaction: &ReadTransaction, project: &ProjectId, run: &RunId, task_id: &str,
    attempt_id: &str, epoch: u64, expected_object: &str,
    retain_inspection: bool,
    build: impl FnOnce(serde_json::Value, Option<fullmag_runner::LoadedAntennaClosedLoopInspection>) -> Result<T>,
) -> Result<T> {
    let catalog = store.read_run_catalog(run.as_str())?.context("inspection run catalog missing")?;
    let task = catalog.tasks.iter().find(|task| task.task_id == task_id).context("inspection task missing")?;
    if task.lifecycle != FmsTaskLifecycle::Succeeded { bail!("inspection task is not succeeded"); }
    exact_attempt(task.attempt_id.as_deref(), task.ownership_epoch, attempt_id, epoch)?;
    let accepted = crate::load_accepted_study_snapshot(store, run, project)?;
    let step = accepted.study.steps.iter().find(|step| {
        fullmag_session::task_id_for_study_step(run.as_str(), &step.step_id).ok().as_deref() == Some(task_id)
    }).context("inspection task is not an accepted step")?;
    if !step.enabled || !matches!(&step.kind, fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. }) {
        bail!("cold-load requires an enabled typed closed-loop inspection");
    }
    let lowered = accepted.lowered.steps.iter().find(|record| record.step_id == step.step_id).context("inspection lowered step missing")?;
    if task.input_fingerprint != fullmag_application::study_task_input_fingerprint(&accepted.run.specification, lowered)? {
        bail!("inspection task fingerprint differs from accepted execution");
    }
    let preparation = accepted.read_task_preparation(store, task_id)?;
    let AcceptedPreparationReceipt::ClosedLoop(preparation) = preparation else { bail!("inspection preparation kind mismatch"); };
    if preparation.preparation_id != format!("prep-{task_id}") { bail!("inspection canonical preparation identity mismatch"); }
    let genesis = task.coordinator_genesis.as_ref().context("inspection successful attempt has no durable genesis")?;
    let checkpoint: CoordinatorCheckpoint = serde_json::from_value(genesis.checkpoint.clone())?;
    let claim = checkpoint.claim;
    if claim.run_id != *run || claim.task_id.as_str() != task_id { bail!("inspection genesis belongs to another run/task"); }
    exact_attempt(Some(claim.attempt_id.as_str()), Some(claim.ownership_epoch.value()), attempt_id, epoch)?;
    // The shared lock replaces only the writer acquisition. This existing replay
    // validates the same causal transitions and current catalog without repairs.
    let recovered = crate::recover_coordinator_with_journal(store, &claim, ||
        store.read_coordinator_journal_readonly(run.as_str(), transaction))?;
    if recovered.coordinator.task().lifecycle != TaskLifecycle::Succeeded
        || !recovered.events.iter().any(|event| matches!(&event.event, WorkerEvent::Completed { .. })) {
        bail!("inspection cold-load requires exact durable successful Completed");
    }
    // Bound the immutable manifest before the legacy shared validator reads it.
    // The same native read lock prevents any writer replacing the catalog/CAS.
    let manifest_catalog = store.read_artifact_catalog(run.as_str())?.context("inspection artifacts missing")?;
    let manifests = manifest_catalog.entries.iter().filter(|entry| entry.task_id == task_id
        && entry.attempt_id == attempt_id && entry.ownership_epoch == epoch
        && entry.artifact_type == "study_output_manifest").collect::<Vec<_>>();
    if manifests.len() != 1 { bail!("inspection has no unique typed completion manifest"); }
    store.cas().get_bounded(manifests[0].object_ref.as_deref().context("inspection manifest CAS missing")?, 4 * 1024 * 1024)?
        .context("inspection typed completion manifest missing")?;
    let completion = crate::study::read_study_task_completion_for_snapshot(
        store, recovered.coordinator.claim(), &accepted, retain_inspection)?;
    let artifacts = store.read_artifact_catalog(run.as_str())?.context("inspection artifacts missing")?;
    let outputs = artifacts.entries.iter().filter(|artifact| artifact.task_id == task_id
        && artifact.attempt_id == attempt_id && artifact.ownership_epoch == epoch
        && artifact.artifact_type == "artifact" && artifact.study_output.is_some()).collect::<Vec<_>>();
    if outputs.len() != 1 { bail!("inspection requires one published typed artifact"); }
    let output = outputs[0];
    if output.status != fullmag_session::FmsArtifactStatus::Published
        || output.object_ref.as_deref() != Some(expected_object) || output.content_sha256 != expected_object {
        bail!("inspection public CAS object differs from durable output");
    }
    // Completion already read and re-hashed this exact output under the same
    // shared transaction. Reuse its fully verified immutable reader in this read
    // only; every subsequent request repeats all durable and CAS fences.
    let (byte_count, loaded) = completion.into_inspection(expected_object)?;
    build(serde_json::json!({"schema":"fullmag.saved_inspection_integrity.v1","status":"pass",
        "project_id":project.as_str(),"run_id":run.as_str(),"task_id":task_id,"attempt_id":attempt_id,
        "ownership_epoch":epoch,"object_ref":expected_object,"byte_count":byte_count,
        "artifact_id":output.artifact_id,"preparation_id":preparation.preparation_id,
        "publication":"inspection_only","qualification":"not_verified","read_only":true}),
        loaded)
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
    use fullmag_session::accepted_provenance::{AcceptedProvenanceManifest,
        AcceptedProvenanceRecordKind as Kind, MAX_ACCEPTED_PROVENANCE_RECORD_BYTES};
    use fullmag_session::repository_path::read_bounded_regular_file;
    let session = store.current_session()?.context("imported session manifest absent")?;
    let reference = session.accepted_provenance_ref.context("imported accepted evidence reference absent")?;
    if session.format != fullmag_session::FMS_SESSION_FORMAT_V2
        || reference.accepted_run_id != run.as_str() || reference.closure_sha256 != expected_closure {
        bail!("imported evidence binding differs from the observation");
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
        let bytes = read_bounded_regular_file(store.root(), &format!("imports/{}", record.archive_path),
            MAX_ACCEPTED_PROVENANCE_RECORD_BYTES)?;
        records.insert(record.archive_path.clone(), bytes);
    }
    manifest.validate_detached_records_with_cas(&records, |object| {
        store.cas().get_bounded(object, fullmag_session::MAX_TERMINAL_CATALOG_METADATA_BYTES)
    })?;
    for object in &manifest.cas_objects {
        if store.cas().verified_length(&object.object_ref)? != Some(object.byte_count) {
            bail!("imported accepted CAS length/digest differs");
        }
    }
    let mut intent = None;
    let mut catalog = None;
    let mut artifacts = None;
    let mut preparations = std::collections::BTreeMap::new();
    for record in &manifest.records {
        let bytes = &records[&record.archive_path];
        match record.kind {
            Kind::RunIntent => intent = Some(serde_json::from_slice::<fullmag_session::FmsRunIntent>(bytes)?),
            Kind::RunCatalog => catalog = Some(serde_json::from_slice(bytes)?),
            Kind::ArtifactCatalog => artifacts = Some(serde_json::from_slice(bytes)?),
            Kind::TaskPreparationReceipt => {
                let receipt: fullmag_session::FmsTaskPreparationReceipt = serde_json::from_slice(bytes)?;
                preparations.insert(receipt.task_id.clone(), receipt);
            },
            _ => {},
        }
    }
    let intent = intent.context("imported RunIntent absent")?;
    if intent.study_object_ref.is_none() { return Ok(None); }
    let specification: fullmag_application::RunSpecification = serde_json::from_value(intent.specification.clone())?;
    let run_snapshot = crate::load_accepted_run_snapshot_from_intent(store.cas(), intent, run, &specification.snapshot.project_id)?;
    let accepted = crate::load_accepted_study_snapshot_from_run(store.cas(), run_snapshot)?;
    Ok(Some(ImportedStudyEvidence { accepted, catalog: catalog.context("imported run catalog absent")?, artifacts, preparations }))
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
            let transaction = acquire_inspection_read_transaction(&store, Duration::from_secs(2)).unwrap();
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
        let error = acquire_inspection_read_transaction(&store, wait).err().unwrap();
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
        let error = acquire_inspection_read_transaction(&store, Duration::from_secs(5)).err().unwrap();
        assert!(error.to_string().contains("corrupt session read lock descriptor"));
        assert!(start.elapsed() < Duration::from_secs(1), "non-contention errors must bypass the five-second wait");
        assert_eq!(std::fs::read(store.root().join("WRITER.owner.json")).unwrap(), owner);
    }

}
