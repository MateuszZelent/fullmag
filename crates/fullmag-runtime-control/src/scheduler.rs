//! One bounded scheduler pass for an accepted study run.
//!
//! The scheduler selects only dependency-ready tasks whose inputs can be
//! reconstructed from the immutable run and durable StepOutput catalogs. It
//! durably queues, claims, prepares, and starts one task. Process supervision
//! remains a separate boundary owned by `fullmag-api`.

use anyhow::{bail, Context, Result};
use fullmag_application::{
    CoordinatorError, CoordinatorMessage, DurableWorkerCoordinator, ExecutionError,
    RequestedExecution, ResourceKind, ResourceLease, RunId, TaskClaim, WorkerCommandEnvelope,
    WorkerCoordinator, WorkerEvent, WorkerEventEnvelope, WORKER_PROTOCOL_SCHEMA,
};
use fullmag_authoring::StudyInputSource;
use fullmag_session::{FmsTaskLifecycle, FmsTaskReadiness, SessionStore};

use crate::claim::{claimed_task_resource_compatibility, ClaimedTaskResourceCompatibility};

#[derive(Clone, Debug)]
pub struct ScheduledAcceptedTask {
    pub claim: TaskClaim,
    pub step_id: String,
    pub admission: fullmag_session::TaskAdmissionCommitDisposition,
    pub prepare: WorkerCommandEnvelope,
    pub start: WorkerCommandEnvelope,
}

/// Report whether an accepted run has at least one task the scheduler can
/// queue without mutating durable state.
pub fn accepted_run_has_scheduler_ready_task(store: &SessionStore, run_id: &RunId) -> Result<bool> {
    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("accepted scheduler requires an immutable run intent")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification.clone())
            .context("accepted scheduler run specification is not typed")?;
    if specification.run_id != *run_id {
        bail!("accepted scheduler run id differs from the immutable RunSpec");
    }
    let Some(catalog) = store.read_run_catalog(run_id.as_str())? else {
        return Ok(false);
    };
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
        if scheduler_owned_accepted
            && store
                .read_task_preparation_receipt(run_id.as_str(), task_id.as_str())?
                .is_none()
        {
            continue;
        }
        if inputs_are_automatically_resolvable(run_id.as_str(), &study_step.inputs, &catalog)? {
            return Ok(true);
        }
    }
    Ok(false)
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
    schedule_next_ready_accepted_task_with_admission(
        store,
        run_id,
        resource_offer,
        |task, claim| crate::commit_claimed_task_admission(store, task, claim),
    )
}

/// Dispatch through the shared host owner before preparing commands or handing
/// Start to a supervisor. Allocation must use the configured physical topology,
/// not infer GPU identity or CPU placement from an arbitrary resource label.
/// Placement and the pinned policy stay unchanged for retries of one claim;
/// conflicting replays are rejected by the ledger and never authorize spawn.
pub fn schedule_next_ready_accepted_task_with_host(
    store: &SessionStore,
    run_id: &RunId,
    resource_offer: ResourceLease,
    ledger: &fullmag_session::host_resource_ledger::HostResourceLedger,
    placement: &crate::host_allocation::HostTaskPlacement,
) -> Result<Option<ScheduledAcceptedTask>> {
    schedule_next_ready_accepted_task_with_admission(
        store,
        run_id,
        resource_offer,
        |task, claim| {
            let request = crate::host_allocation::host_request_for_task_claim(
                store, ledger, claim, placement,
            )?;
            crate::commit_claimed_task_admission_with_host(store, task, claim, ledger, &request)
        },
    )
}

fn schedule_next_ready_accepted_task_with_admission(
    store: &SessionStore,
    run_id: &RunId,
    resource_offer: ResourceLease,
    admit: impl Fn(
        &fullmag_application::TaskRecord,
        &TaskClaim,
    ) -> Result<fullmag_session::TaskAdmissionCommitDisposition>,
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

        let catalog_entry = accepted
            .catalog
            .entries()
            .iter()
            .find(|entry| entry.step_id() == study_step.step_id)
            .with_context(|| {
                format!(
                    "accepted scheduler step `{}` has no immutable ProblemIR",
                    study_step.step_id
                )
            })?;
        let task_request = specification
            .requested_execution
            .for_problem(catalog_entry.problem())
            .map_err(|error| {
                anyhow::anyhow!(
                    "accepted scheduler step `{}` execution request is invalid: {error}",
                    study_step.step_id
                )
            })?;
        if !resource_offer_satisfies_requested_minimum(&task_request, &resource_offer) {
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
        if scheduler_owned_accepted
            && store
                .read_task_preparation_receipt(run_id.as_str(), task_id.as_str())?
                .is_none()
        {
            continue;
        }
        if !inputs_are_automatically_resolvable(run_id.as_str(), &study_step.inputs, &catalog)? {
            continue;
        }

        let queued = retry_store_writer_busy(|| {
            crate::queue_accepted_study_task(
                store,
                &specification.snapshot.project_id,
                run_id,
                &study_step.step_id,
                Default::default(),
            )
        })
        .context("durably queueing accepted study task")?;
        let mut task = queued.task;
        let claim = task.claim(resource_offer.clone())?;
        if let ClaimedTaskResourceCompatibility::Incompatible(_) =
            claimed_task_resource_compatibility(store, &claim)?
        {
            continue;
        }
        let admission = retry_store_writer_busy(|| admit(&task, &claim))
            .context("durably admitting accepted task claim")?;
        let coordinator = WorkerCoordinator::new(task, claim.clone())?;
        let mut coordinator = DurableWorkerCoordinator::new(coordinator);
        let prepare = crate::publish_accepted_task_prepare(
            store,
            &accepted,
            &mut coordinator,
            &study_step.step_id,
            queued.resolved_inputs,
        )?;
        let inbox_store =
            retry_store_writer_busy(|| SessionStore::open_existing(store.root().to_path_buf()))
                .context("open accepted scheduler worker inbox store")?;
        let mut worker_inbox = crate::DurableWorkerInbox::new(inbox_store, claim.clone());
        worker_inbox
            .receive(&prepare, |envelope| {
                retry_store_writer_busy(|| {
                    crate::load_accepted_worker_step(
                        store,
                        &specification.snapshot.project_id,
                        envelope,
                    )
                })
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
        commit_prepared_event_with_retry(
            store,
            &mut coordinator,
            WorkerEventEnvelope {
                schema_version: WORKER_PROTOCOL_SCHEMA.into(),
                message_id: prepared_message_id,
                sequence: 1,
                claim: claim.identity(),
                event: WorkerEvent::Prepared,
            },
        )?;
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

fn resource_offer_satisfies_requested_minimum(
    requested: &RequestedExecution,
    offer: &ResourceLease,
) -> bool {
    let device_matches = match requested.device.as_str() {
        "cpu" => offer.kind == ResourceKind::Cpu,
        "gpu" => offer.kind == ResourceKind::Gpu,
        "auto" => matches!(offer.kind, ResourceKind::Cpu | ResourceKind::Gpu),
        _ => false,
    };
    let budget_matches = requested.minimum_resources.as_ref().is_none_or(|required| {
        offer.budget.cpu_millis >= required.cpu_millis
            && offer.budget.memory_bytes >= required.memory_bytes
            && offer.budget.gpu_memory_bytes >= required.gpu_memory_bytes
            && offer.budget.storage_bytes >= required.storage_bytes
    });
    device_matches && budget_matches
}

fn retry_store_writer_busy<T>(mut action: impl FnMut() -> Result<T>) -> Result<T> {
    crate::retry_store_writer_busy(&mut action)
}

fn commit_prepared_event_with_retry(
    store: &SessionStore,
    coordinator: &mut DurableWorkerCoordinator,
    event: WorkerEventEnvelope,
) -> Result<()> {
    let expected = event.clone();
    let mut publication_error = None;
    let result = coordinator.commit_event(event, |transition| {
        crate::commit_transition(store, transition)
            .map(|_| ())
            .map_err(|error| {
                publication_error = Some(error);
                CoordinatorError::Invalid("durable Prepared publication failed".into())
            })
    });
    match (result, publication_error) {
        (Ok(_), None) => Ok(()),
        (_, Some(error)) if is_store_writer_busy(&error) => {
            retry_pending_event_publication(store, coordinator, &expected)
        }
        (_, Some(error)) => Err(error).context("publishing accepted task Prepared event"),
        (Err(error), None) => {
            Err(anyhow::Error::new(error)).context("committing accepted task Prepared event")
        }
    }
}

fn retry_pending_event_publication(
    store: &SessionStore,
    coordinator: &mut DurableWorkerCoordinator,
    expected: &WorkerEventEnvelope,
) -> Result<()> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let mut publication_error = None;
        let result = coordinator.retry_publication(|transition| {
            crate::commit_transition(store, transition)
                .map(|_| ())
                .map_err(|error| {
                    publication_error = Some(error);
                    CoordinatorError::Invalid("durable Prepared publication retry failed".into())
                })
        });
        match (result, publication_error) {
            (Ok(CoordinatorMessage::Event(envelope)), None) if envelope == *expected => {
                return Ok(());
            }
            (Ok(CoordinatorMessage::Event(_)), None) => {
                bail!("retried Prepared event differs from the retained publication");
            }
            (Ok(CoordinatorMessage::Command(_)), None) => {
                bail!("retried coordinator publication is not an event");
            }
            (_, Some(error))
                if is_store_writer_busy(&error) && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            (_, Some(error)) => {
                return Err(error).context("publishing accepted task Prepared event");
            }
            (Err(error), None) => {
                return Err(anyhow::Error::new(error))
                    .context("publishing accepted task Prepared event");
            }
        }
    }
}

fn is_store_writer_busy(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<fullmag_session::StoreWriterBusy>())
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

#[cfg(test)]
mod resource_requirement_tests {
    use super::resource_offer_satisfies_requested_minimum;
    use fullmag_application::{
        RequestedExecution, RequestedResourceBudget, ResourceBudget, ResourceKind,
    };

    fn request(device: &str, minimum_resources: RequestedResourceBudget) -> RequestedExecution {
        RequestedExecution {
            backend: "auto".into(),
            device: device.into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: Some(minimum_resources),
        }
    }

    fn offer(
        kind: ResourceKind,
        cpu_millis: u64,
        memory_bytes: u64,
        gpu_memory_bytes: u64,
        storage_bytes: u64,
    ) -> fullmag_application::ResourceLease {
        fullmag_application::ResourceLease::new(
            "resource-test",
            kind,
            ResourceBudget {
                cpu_millis,
                memory_bytes,
                gpu_memory_bytes,
                storage_bytes,
            },
        )
        .unwrap()
    }

    #[test]
    fn cpu_offer_must_meet_every_requested_minimum() {
        let requested = request(
            "cpu",
            RequestedResourceBudget {
                cpu_millis: 500,
                memory_bytes: 2_000,
                gpu_memory_bytes: 0,
                storage_bytes: 4_000,
            },
        );
        assert!(resource_offer_satisfies_requested_minimum(
            &requested,
            &offer(ResourceKind::Cpu, 500, 2_000, 0, 4_000),
        ));
        for insufficient in [
            offer(ResourceKind::Cpu, 499, 2_000, 0, 4_000),
            offer(ResourceKind::Cpu, 500, 1_999, 0, 4_000),
            offer(ResourceKind::Cpu, 500, 2_000, 0, 3_999),
        ] {
            assert!(!resource_offer_satisfies_requested_minimum(
                &requested,
                &insufficient,
            ));
        }
    }

    #[test]
    fn gpu_minimum_rejects_cpu_and_insufficient_vram() {
        let requested = request(
            "gpu",
            RequestedResourceBudget {
                cpu_millis: 500,
                memory_bytes: 2_000,
                gpu_memory_bytes: 8_000,
                storage_bytes: 4_000,
            },
        );
        assert!(!resource_offer_satisfies_requested_minimum(
            &requested,
            &offer(ResourceKind::Cpu, 500, 2_000, 0, 4_000),
        ));
        assert!(!resource_offer_satisfies_requested_minimum(
            &requested,
            &offer(ResourceKind::Gpu, 500, 2_000, 7_999, 4_000),
        ));
        assert!(resource_offer_satisfies_requested_minimum(
            &requested,
            &offer(ResourceKind::Gpu, 500, 2_000, 8_000, 4_000),
        ));
    }

    #[test]
    fn mixed_auto_study_requests_apply_global_vram_only_to_gpu_steps() {
        let run_request = request(
            "auto",
            RequestedResourceBudget {
                cpu_millis: 500,
                memory_bytes: 2_000,
                gpu_memory_bytes: 8_000,
                storage_bytes: 4_000,
            },
        );
        let problem_with_device = |device: &str| {
            let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
            problem.problem_meta.runtime_metadata.insert(
                "runtime_selection".into(),
                serde_json::json!({"device": device}),
            );
            problem
        };
        let gpu_problem = problem_with_device("gpu");
        let cpu_problem = problem_with_device("cpu");
        let gpu_request = run_request.for_problem(&gpu_problem).unwrap();
        let cpu_request = run_request.for_problem(&cpu_problem).unwrap();

        assert!(resource_offer_satisfies_requested_minimum(
            &gpu_request,
            &offer(ResourceKind::Gpu, 500, 2_000, 8_000, 4_000),
        ));
        assert!(!resource_offer_satisfies_requested_minimum(
            &gpu_request,
            &offer(ResourceKind::Gpu, 500, 2_000, 7_999, 4_000),
        ));
        assert!(!resource_offer_satisfies_requested_minimum(
            &gpu_request,
            &offer(ResourceKind::Cpu, 500, 2_000, 0, 4_000),
        ));
        assert_eq!(
            cpu_request
                .minimum_resources
                .as_ref()
                .unwrap()
                .gpu_memory_bytes,
            0
        );
        assert!(resource_offer_satisfies_requested_minimum(
            &cpu_request,
            &offer(ResourceKind::Cpu, 500, 2_000, 0, 4_000),
        ));
    }
}
