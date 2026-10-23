//! Completion edges gate execution without data ports or new producer leases.
use crate::study::AcceptedStudySnapshot;
use anyhow::{bail, Context, Result};
use fullmag_application::{
    CoordinatorCheckpoint, CoordinatorTransition, RunId, RunSpecification, TaskLifecycle,
    WorkerEvent,
};
use fullmag_authoring::StudyStep;
use fullmag_session::{FmsRunIntent, FmsTaskLifecycle, SessionStore};

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
        crate::study::validate_study_task_completion_for_snapshot(
            store,
            recovered.coordinator.claim(),
            accepted,
        )?;
    }
    Ok(ready)
}

/// Immutable accepted-study evidence prepared before a task admission writer
/// transaction. The intent is fenced again under the writer before this
/// snapshot is used for mutable dependency checks.
enum AcceptedStudyEvidence<'a> {
    Owned(AcceptedStudySnapshot),
    Borrowed(&'a AcceptedStudySnapshot),
}

impl AcceptedStudyEvidence<'_> {
    fn as_ref(&self) -> &AcceptedStudySnapshot {
        match self {
            Self::Owned(accepted) => accepted,
            Self::Borrowed(accepted) => accepted,
        }
    }
}

pub(crate) struct PreparedTaskDependencies<'a> {
    run_id: String,
    task_id: String,
    expected_intent: Option<FmsRunIntent>,
    accepted: Option<AcceptedStudyEvidence<'a>>,
    step_id: Option<String>,
}

impl PreparedTaskDependencies<'_> {
    pub(crate) fn accepted_study(&self) -> Option<&AcceptedStudySnapshot> {
        self.accepted.as_ref().map(AcceptedStudyEvidence::as_ref)
    }

    pub(crate) fn has_run_intent(&self) -> bool {
        self.expected_intent.is_some()
    }

    /// Caller holds the store writer through this identity fence and any
    /// subsequent admission effect.
    pub(crate) fn require_locked(&self, store: &SessionStore) -> Result<()> {
        let current_intent = store.read_run_intent(&self.run_id)?;
        if current_intent.as_ref() != self.expected_intent.as_ref() {
            bail!("accepted run intent changed during task admission preparation");
        }

        let Some(intent) = self.expected_intent.as_ref() else {
            return Ok(());
        };
        if intent.run_id != self.run_id {
            bail!("accepted run intent identity differs from the prepared run");
        }
        if intent.study_object_ref.is_none() {
            return Ok(());
        }

        let accepted = self
            .accepted
            .as_ref()
            .map(AcceptedStudyEvidence::as_ref)
            .context("prepared accepted study snapshot is missing")?;
        if &accepted.run.intent != intent
            || accepted.run.specification.run_id.as_str() != self.run_id
        {
            bail!("prepared accepted study identity differs from the fenced run intent");
        }
        let step_id = self
            .step_id
            .as_deref()
            .context("prepared accepted study step is missing")?;
        let step = accepted
            .study
            .steps
            .iter()
            .find(|step| step.step_id == step_id)
            .context("prepared accepted study step no longer exists")?;
        if fullmag_session::task_id_for_study_step(&self.run_id, step_id)? != self.task_id {
            bail!("prepared accepted study step differs from the task identity");
        }
        if !dependencies_ready_locked(store, accepted, step)? {
            bail!("accepted task is blocked until its completion dependencies succeed");
        }
        Ok(())
    }
}

/// Load and fully validate immutable accepted-study evidence before entering a
/// host/store writer transaction. The exact intent is re-read by
/// `PreparedTaskDependencies::require_locked` before its snapshot is used.
pub(crate) fn prepare_task_dependencies(
    store: &SessionStore,
    run_id: &RunId,
    task_id: &str,
) -> Result<PreparedTaskDependencies<'static>> {
    let expected_intent = store.read_run_intent(run_id.as_str())?;
    let mut accepted = None;
    let mut step_id = None;

    if let Some(intent) = expected_intent.as_ref() {
        if intent.run_id != run_id.as_str() {
            bail!("accepted run intent identity differs from the requested run");
        }
        if intent.study_object_ref.is_some() {
            let specification: RunSpecification = serde_json::from_value(
                intent.specification.clone(),
            )
            .context("accepted run intent specification is not typed")?;
            if specification.run_id != *run_id {
                bail!("accepted run specification identity differs from the requested run");
            }
            let snapshot = crate::study::load_accepted_study_snapshot(
                store,
                run_id,
                &specification.snapshot.project_id,
            )?;
            if &snapshot.run.intent != intent {
                bail!("accepted run intent changed while loading its study snapshot");
            }
            step_id = Some(accepted_step_id_for_task(&snapshot, run_id, task_id)?);
            accepted = Some(AcceptedStudyEvidence::Owned(snapshot));
        }
    }

    Ok(PreparedTaskDependencies {
        run_id: run_id.as_str().to_owned(),
        task_id: task_id.to_owned(),
        expected_intent,
        accepted,
        step_id,
    })
}

/// Prepare admission dependencies from the candidate snapshot without
/// reopening immutable CAS objects. The exact fresh intent is captured here
/// and compared again under the host/store writer before admission effects.
pub(crate) fn prepare_task_dependencies_from_snapshot<'a>(
    store: &SessionStore,
    run_id: &RunId,
    task_id: &str,
    accepted: &'a AcceptedStudySnapshot,
) -> Result<PreparedTaskDependencies<'a>> {
    let expected_intent = store
        .read_run_intent(run_id.as_str())?
        .context("accepted task admission requires its immutable run intent")?;
    if expected_intent != accepted.run.intent
        || expected_intent.run_id != run_id.as_str()
        || accepted.run.specification.run_id != *run_id
        || expected_intent.study_object_ref.is_none()
    {
        bail!("accepted task admission snapshot differs from the current run intent");
    }
    let step_id = accepted_step_id_for_task(accepted, run_id, task_id)?;
    Ok(PreparedTaskDependencies {
        run_id: run_id.as_str().to_owned(),
        task_id: task_id.to_owned(),
        expected_intent: Some(expected_intent),
        accepted: Some(AcceptedStudyEvidence::Borrowed(accepted)),
        step_id: Some(step_id),
    })
}

fn accepted_step_id_for_task(
    accepted: &AcceptedStudySnapshot,
    run_id: &RunId,
    task_id: &str,
) -> Result<String> {
    let mut matched_step_id: Option<String> = None;
    for step in &accepted.study.steps {
        if fullmag_session::task_id_for_study_step(run_id.as_str(), &step.step_id)? == task_id {
            if matched_step_id.is_some() {
                bail!("completion consumer identity is ambiguous");
            }
            matched_step_id = Some(step.step_id.clone());
        }
    }
    matched_step_id.context("completion consumer is not an accepted step")
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
