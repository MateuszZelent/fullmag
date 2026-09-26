//! One bounded scheduler pass for an accepted study run.
//!
//! The scheduler selects only dependency-ready tasks whose inputs can be
//! reconstructed from the immutable run and durable StepOutput catalogs. It
//! durably queues, claims, prepares, and starts one task. Process supervision
//! remains a separate boundary owned by `fullmag-api`.

use anyhow::{Context, Result, bail};
use fullmag_application::{
    CoordinatorError, DurableWorkerCoordinator, ExecutionError, ResourceLease, RunId, TaskClaim,
    WORKER_PROTOCOL_SCHEMA, WorkerCommandEnvelope, WorkerCoordinator, WorkerEvent,
    WorkerEventEnvelope,
};
use fullmag_authoring::StudyInputSource;
use fullmag_session::{FmsTaskLifecycle, FmsTaskReadiness, SessionStore};

use crate::claim::{ClaimedTaskResourceCompatibility, claimed_task_resource_compatibility};

#[derive(Clone, Debug)]
pub struct ScheduledAcceptedTask {
    pub claim: TaskClaim,
    pub step_id: String,
    pub admission: fullmag_session::TaskAdmissionCommitDisposition,
    pub prepare: WorkerCommandEnvelope,
    pub start: WorkerCommandEnvelope,
}

/// Select and durably dispatch one accepted task for the supplied resource.
///
/// Tasks are considered in immutable study order. A required StepOutput is
/// eligible only after its source task succeeds. Required authored, pinned, or
/// continuation inputs remain blocked because this scheduler has no external
/// resolver for them. A concurrent winner is rejected by durable admission
/// fencing; callers may run another pass from a fresh catalog.
pub fn schedule_next_ready_accepted_task(
    store: &SessionStore,
    run_id: &RunId,
    resource_offer: ResourceLease,
) -> Result<Option<ScheduledAcceptedTask>> {
    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("accepted scheduler requires an immutable run intent")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification.clone())
            .context("accepted scheduler run specification is not typed")?;
    if specification.run_id != *run_id {
        bail!("accepted scheduler run id differs from the immutable RunSpec");
    }
    let accepted =
        crate::load_accepted_study_snapshot(store, run_id, &specification.snapshot.project_id)?;

    for study_step in &accepted.study.steps {
        let execution_step = accepted
            .lowered
            .steps
            .iter()
            .find(|step| step.step_id == study_step.step_id)
            .with_context(|| {
                format!(
                    "accepted scheduler step `{}` has no lowered execution record",
                    study_step.step_id
                )
            })?;
        if !study_step.enabled
            || !execution_step.enabled
            || !matches!(
                &execution_step.status,
                fullmag_plan::StudyStepLoweringStatus::Planned
            )
        {
            continue;
        }

        let catalog = store
            .read_run_catalog(run_id.as_str())?
            .context("accepted scheduler requires a durable run catalog")?;
        let task_id =
            fullmag_session::task_id_for_study_step(run_id.as_str(), &study_step.step_id)?;
        let durable_task = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .with_context(|| {
                format!(
                    "accepted scheduler step `{}` has no durable task",
                    study_step.step_id
                )
            })?;
        let scheduler_owned_accepted = durable_task.lifecycle == FmsTaskLifecycle::Accepted
            && matches!(
                &durable_task.readiness,
                FmsTaskReadiness::Blocked { reason }
                    if reason == crate::ACCEPTED_TASK_AWAITING_DEPENDENCY_RESOLUTION
            )
            && durable_task.attempt_id.is_none()
            && durable_task.resource_id.is_none();
        let unclaimed_queue = durable_task.lifecycle == FmsTaskLifecycle::Queued
            && durable_task.readiness == FmsTaskReadiness::Ready
            && durable_task.attempt_id.is_none()
            && durable_task.resource_id.is_none();
        if !scheduler_owned_accepted && !unclaimed_queue {
            continue;
        }
        if !inputs_are_automatically_resolvable(run_id.as_str(), &study_step.inputs, &catalog)? {
            continue;
        }

        let queued = crate::queue_accepted_study_task(
            store,
            &specification.snapshot.project_id,
            run_id,
            &study_step.step_id,
            Default::default(),
        )?;
        let mut task = queued.task;
        let claim = task.claim(resource_offer.clone())?;
        if let ClaimedTaskResourceCompatibility::Incompatible(_) =
            claimed_task_resource_compatibility(store, &claim)?
        {
            continue;
        }
        let admission = crate::commit_claimed_task_admission(store, &task, &claim)?;
        let coordinator = WorkerCoordinator::new(task, claim.clone())?;
        let mut coordinator = DurableWorkerCoordinator::new(coordinator);
        let prepare = crate::publish_accepted_task_prepare(
            store,
            &accepted,
            &mut coordinator,
            &study_step.step_id,
            queued.resolved_inputs,
        )?;
        let mut worker_inbox = crate::DurableWorkerInbox::new(
            SessionStore::open_existing(store.root().to_path_buf())?,
            claim.clone(),
        );
        worker_inbox
            .receive(&prepare, |envelope| {
                crate::load_accepted_worker_step(
                    store,
                    &specification.snapshot.project_id,
                    envelope,
                )
                .map(|_| ())
                .map_err(|error| ExecutionError::Invalid(error.to_string()))
            })
            .map_err(|error| anyhow::anyhow!(error))?;
        let prepared_message_id = format!(
            "event-prepared-{}",
            fullmag_session::hex_sha256(
                format!(
                    "{}:{}:{}:prepared",
                    claim.run_id.as_str(),
                    claim.task_id.as_str(),
                    claim.attempt_id.as_str()
                )
                .as_bytes()
            )
        );
        coordinator
            .commit_event(
                WorkerEventEnvelope {
                    schema_version: WORKER_PROTOCOL_SCHEMA.into(),
                    message_id: prepared_message_id,
                    sequence: 1,
                    claim: claim.identity(),
                    event: WorkerEvent::Prepared,
                },
                |transition| {
                    crate::commit_transition(store, transition)
                        .map(|_| ())
                        .map_err(|error| CoordinatorError::Invalid(error.to_string()))
                },
            )
            .map_err(|error| anyhow::anyhow!(error))?;
        let start = crate::publish_accepted_task_start(store, &mut coordinator)?;
        const EXTERNAL_START_HANDOFF: &str =
            "accepted scheduler staged Start for external supervisor execution";
        let handoff = worker_inbox.receive(&start, |_| {
            Err(ExecutionError::Invalid(EXTERNAL_START_HANDOFF.into()))
        });
        match handoff {
            Err(ExecutionError::Invalid(reason)) if reason == EXTERNAL_START_HANDOFF => {}
            Err(error) => return Err(anyhow::anyhow!(error)),
            Ok(_) => bail!("accepted scheduler unexpectedly applied Start during handoff"),
        }
        if worker_inbox.checkpoint().pending.as_ref() != Some(&start) {
            bail!("accepted scheduler did not durably retain Start for supervisor execution");
        }
        return Ok(Some(ScheduledAcceptedTask {
            claim,
            step_id: study_step.step_id.clone(),
            admission,
            prepare,
            start,
        }));
    }
    Ok(None)
}

fn inputs_are_automatically_resolvable(
    run_id: &str,
    inputs: &[fullmag_authoring::StudyInputPort],
    catalog: &fullmag_session::FmsRunCatalog,
) -> Result<bool> {
    for input in inputs.iter().filter(|input| input.required) {
        let StudyInputSource::StepOutput { step_id, .. } = &input.source else {
            return Ok(false);
        };
        let dependency_task_id = fullmag_session::task_id_for_study_step(run_id, step_id)?;
        let dependency = catalog
            .tasks
            .iter()
            .find(|task| task.task_id == dependency_task_id)
            .with_context(|| {
                format!(
                    "accepted scheduler input `{}` depends on missing task `{dependency_task_id}`",
                    input.port_id
                )
            })?;
        if dependency.lifecycle != FmsTaskLifecycle::Succeeded {
            return Ok(false);
        }
    }
    Ok(true)
}
