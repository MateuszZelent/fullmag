//! Completion edges gate execution without data ports or new producer leases.
use crate::study::AcceptedStudySnapshot;
use anyhow::{bail, Context, Result};
use fullmag_application::{
    CoordinatorCheckpoint, CoordinatorTransition, RunId, RunSpecification, TaskLifecycle,
    WorkerEvent,
};
use fullmag_authoring::StudyStep;
use fullmag_session::{FmsTaskLifecycle, SessionStore};

pub(crate) fn dependencies_ready(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    step: &StudyStep,
) -> Result<bool> {
    let _writer = store.write_transaction()?;
    dependencies_ready_locked(store, accepted, step)
}

/// Caller holds this store handle's writer through validation and effect.
pub(crate) fn dependencies_ready_locked(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    step: &StudyStep,
) -> Result<bool> {
    let lowered = accepted
        .lowered
        .steps
        .iter()
        .find(|record| record.step_id == step.step_id)
        .context("completion consumer has no lowered record")?;
    if lowered.completion_dependencies != step.completion_dependencies {
        bail!("completion dependencies differ from the accepted lowered plan");
    }
    if step.completion_dependencies.is_empty() {
        return Ok(true);
    }
    let run_id = &accepted.run.specification.run_id;
    let catalog = store
        .read_run_catalog(run_id.as_str())?
        .context("completion dependency requires a durable run catalog")?;
    let mut ready = true;
    for dependency_id in &step.completion_dependencies {
        let source = accepted
            .study
            .steps
            .iter()
            .find(|record| record.step_id == *dependency_id)
            .context("completion dependency is not in the accepted plan")?;
        if !source.enabled {
            bail!("completion dependency is disabled");
        }
        let task_id = fullmag_session::task_id_for_study_step(run_id.as_str(), dependency_id)?;
        let task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .context("completion dependency task is missing")?;
        if task.lifecycle != FmsTaskLifecycle::Succeeded {
            ready = false;
            continue;
        }
        let source_lowered = accepted
            .lowered
            .steps
            .iter()
            .find(|record| record.step_id == *dependency_id)
            .context("completion producer has no lowered record")?;
        if task.input_fingerprint
            != fullmag_application::study_task_input_fingerprint(
                &accepted.run.specification,
                source_lowered,
            )?
        {
            bail!("completion producer fingerprint differs from the accepted plan");
        }
        let attempt = task
            .attempt_id
            .as_deref()
            .context("succeeded completion producer has no attempt")?;
        let epoch = task
            .ownership_epoch
            .context("succeeded completion producer has no epoch")?;
        // The exact historical checkpoint is valid after releasing its lease.
        let checkpoint: CoordinatorCheckpoint = if let Some(genesis) = &task.coordinator_genesis {
            serde_json::from_value(genesis.checkpoint.clone())?
        } else {
            let entry = store
                .read_coordinator_journal(run_id.as_str())?
                .into_iter()
                .find(|entry| {
                    entry.task_id == task_id
                        && entry.attempt_id == attempt
                        && entry.ownership_epoch == epoch
                })
                .context("succeeded completion producer has no durable journal")?;
            let transition: CoordinatorTransition = serde_json::from_value(entry.payload)?;
            transition.checkpoint
        };
        let claim = checkpoint.claim;
        if claim.run_id != *run_id
            || claim.task_id.as_str() != task_id
            || claim.attempt_id.as_str() != attempt
            || claim.ownership_epoch.value() != epoch
        {
            bail!("completion producer checkpoint has a stale identity");
        }
        let recovered = crate::recover_coordinator_locked(store, &claim)?;
        if recovered.coordinator.task().lifecycle != TaskLifecycle::Succeeded
            || !recovered
                .events
                .iter()
                .any(|event| matches!(&event.event, WorkerEvent::Completed { .. }))
        {
            bail!("completion producer lacks an exact durable successful Completed event");
        }
        crate::study::validate_study_task_completion(store, recovered.coordinator.claim())?;
    }
    Ok(ready)
}

/// Admission and command replay use the exact accepted plan. Historical
/// non-study streams preserve their previous completion contract.
pub(crate) fn require_task_dependencies_locked(
    store: &SessionStore,
    run_id: &RunId,
    task_id: &str,
) -> Result<()> {
    let Some(intent) = store.read_run_intent(run_id.as_str())? else {
        return Ok(());
    };
    if intent.study_object_ref.is_none() {
        return Ok(());
    }
    let specification: RunSpecification = serde_json::from_value(intent.specification)?;
    let accepted = crate::study::load_accepted_study_snapshot(
        store,
        run_id,
        &specification.snapshot.project_id,
    )?;
    let mut matched = None;
    for step in &accepted.study.steps {
        if fullmag_session::task_id_for_study_step(run_id.as_str(), &step.step_id)? == task_id {
            if matched.is_some() {
                bail!("completion consumer identity is ambiguous");
            }
            matched = Some(step);
        }
    }
    let step = matched.context("completion consumer is not an accepted step")?;
    if !dependencies_ready_locked(store, &accepted, step)? {
        bail!("accepted task is blocked until its completion dependencies succeed");
    }
    Ok(())
}

#[cfg(test)]
#[path = "study_completion_tests.rs"]
mod tests;
