//! Offline cold integrity gate: no admission, lease, journal or CAS mutation.
use anyhow::{bail, Context, Result};
use fullmag_application::{AcceptedPreparationReceipt, CoordinatorCheckpoint, ProjectId, RunId, TaskLifecycle, WorkerEvent};
use fullmag_session::{FmsTaskLifecycle, SessionStore};
use std::fs::File;
use std::io::Read;

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
    read_saved_inspection(store, project, run, task_id, attempt_id, epoch,
        expected_object, |evidence, _, _, _| Ok(evidence))
}

/// Same durable cold-read fence, returning verified field data without filesystem extraction.
pub fn load_saved_inspection(
    store: &SessionStore, project: &ProjectId, run: &RunId, task_id: &str,
    attempt_id: &str, epoch: u64, expected_object: &str,
) -> Result<(serde_json::Value, fullmag_runner::LoadedAntennaClosedLoopInspection)> {
    read_saved_inspection(store, project, run, task_id, attempt_id, epoch,
        expected_object, |evidence, bytes, maximum, step| {
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
            Ok((evidence, loaded))
        })
}

fn read_saved_inspection<T>(
    store: &SessionStore, project: &ProjectId, run: &RunId, task_id: &str,
    attempt_id: &str, epoch: u64, expected_object: &str,
    build: impl FnOnce(serde_json::Value, &[u8], usize, &fullmag_authoring::StudyStep) -> Result<T>,
) -> Result<T> {
    let lock_path = store.root().join("WRITER.lock");
    let metadata = std::fs::symlink_metadata(&lock_path)?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        bail!("inspection cold-load writer descriptor is not a regular file");
    }
    let descriptor = File::open(&lock_path)?;
    descriptor.try_lock_shared().context("inspection cold-load requires no active store writer")?;
    let mut lock_bytes = Vec::new();
    descriptor.try_clone()?.take(128).read_to_end(&mut lock_bytes)?;
    if lock_bytes != b"fullmag.writer.lock.v1\n" {
        bail!("inspection cold-load writer descriptor identity mismatch");
    }
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
    let recovered = crate::recover_coordinator_locked(store, &claim)?;
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
    crate::study::validate_study_task_completion(store, recovered.coordinator.claim())?;
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
    // Repeat the bounded CAS read against the explicitly supplied discovery pin.
    let bytes = store.cas().get_bounded(expected_object, crate::study_inspection::inspection_bundle_budget(&claim)? as u64)?
        .context("inspection pinned CAS object missing")?;
    let entry = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step.step_id).context("inspection ProblemIR missing")?;
    crate::study_inspection::validate_accepted_inspection_bytes(entry.problem(), step, &bytes, crate::study_inspection::inspection_bundle_budget(&claim)?)?;
    build(serde_json::json!({"schema":"fullmag.saved_inspection_integrity.v1","status":"pass",
        "project_id":project.as_str(),"run_id":run.as_str(),"task_id":task_id,"attempt_id":attempt_id,
        "ownership_epoch":epoch,"object_ref":expected_object,"byte_count":bytes.len(),
        "artifact_id":output.artifact_id,"preparation_id":preparation.preparation_id,
        "publication":"inspection_only","qualification":"not_verified","read_only":true}),
        &bytes, crate::study_inspection::inspection_bundle_budget(&claim)?, step)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_cold_descriptor_excludes_writer_without_changing_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("WRITER.lock");
        std::fs::write(&path, b"fullmag.writer.lock.v1\n").unwrap();
        let before = std::fs::read(&path).unwrap();
        let reader = File::open(&path).unwrap();
        reader.try_lock_shared().unwrap();
        let writer = std::fs::OpenOptions::new().read(true).write(true).open(&path).unwrap();
        assert!(writer.try_lock().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        drop(reader);
        writer.try_lock().unwrap();
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
}
