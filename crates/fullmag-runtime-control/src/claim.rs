//! Recover a current typed task claim from its durable catalog and lease.
use anyhow::{Context, Result, bail};
use fullmag_application::{
    AttemptId, LeaseToken, OwnershipEpoch, ResourceBudget, ResourceKind, ResourceLease, RunId,
    TaskClaim, TaskId, TaskLifecycle, TaskRecord,
};
use fullmag_ir::ExecutionDevice;
use fullmag_session::{
    FMS_RESOURCE_LEASE_SCHEMA, FmsResourceBudget, FmsResourceKind, FmsResourceLease,
    FmsResourceLeaseState, FmsTaskLifecycle, FmsTaskReadiness, SessionStore,
};

/// Durably admit a claimed application task before publishing its worker
/// coordinator or process. Replaying the same claim repairs an interrupted
/// catalog/lease projection without creating a new attempt.
pub fn commit_claimed_task_admission(
    store: &SessionStore,
    task: &TaskRecord,
    claim: &TaskClaim,
) -> Result<fullmag_session::TaskAdmissionCommitDisposition> {
    task.fence(claim)
        .context("application task does not own the supplied claim")?;
    if task.run_id != claim.run_id
        || task.task_id != claim.task_id
        || task.lifecycle != TaskLifecycle::Preparing
        || task.attempt_id.as_ref() != Some(&claim.attempt_id)
        || task.ownership_epoch != Some(claim.ownership_epoch)
        || claim.lease.heartbeat_sequence != 0
    {
        bail!("task admission requires the exact fresh preparing claim");
    }

    let catalog = store
        .read_run_catalog(claim.run_id.as_str())?
        .context("task admission requires a durable run catalog")?;
    let durable_task = catalog
        .tasks
        .iter()
        .find(|entry| entry.task_id == claim.task_id.as_str())
        .context("task admission target is missing from the durable run catalog")?;
    if durable_task.input_fingerprint != task.input_fingerprint
        || !matches!(durable_task.readiness, FmsTaskReadiness::Ready)
    {
        bail!("application task differs from the durable ready task");
    }
    validate_claimed_task_resource(store, claim)?;
    let is_unclaimed_queue = durable_task.lifecycle == FmsTaskLifecycle::Queued
        && durable_task.attempt_id.is_none()
        && durable_task.ownership_epoch.is_none()
        && durable_task.resource_id.is_none();
    let is_exact_replay = durable_task.lifecycle == FmsTaskLifecycle::Preparing
        && durable_task.attempt_id.as_deref() == Some(claim.attempt_id.as_str())
        && durable_task.ownership_epoch == Some(claim.ownership_epoch.value())
        && durable_task.resource_id.as_deref() == Some(claim.lease.resource_id.as_str());
    if !is_unclaimed_queue && !is_exact_replay {
        bail!("durable task is neither queued nor owned by this admission claim");
    }

    let kind = match claim.lease.kind {
        ResourceKind::Cpu => FmsResourceKind::Cpu,
        ResourceKind::Gpu => FmsResourceKind::Gpu,
        ResourceKind::Storage => FmsResourceKind::Storage,
        ResourceKind::Meshing => FmsResourceKind::Meshing,
    };
    let now = chrono::Utc::now();
    let lease = FmsResourceLease {
        schema_version: FMS_RESOURCE_LEASE_SCHEMA.into(),
        resource_id: claim.lease.resource_id.clone(),
        kind,
        budget: FmsResourceBudget {
            cpu_millis: claim.lease.budget.cpu_millis,
            memory_bytes: claim.lease.budget.memory_bytes,
            gpu_memory_bytes: claim.lease.budget.gpu_memory_bytes,
            storage_bytes: claim.lease.budget.storage_bytes,
        },
        run_id: claim.run_id.as_str().into(),
        task_id: claim.task_id.as_str().into(),
        attempt_id: claim.attempt_id.as_str().into(),
        ownership_epoch: claim.ownership_epoch.value(),
        lease_token: claim.lease.lease_token.as_str().into(),
        state: FmsResourceLeaseState::Active,
        acquired_at: now,
        heartbeat_at: now,
        heartbeat_sequence: claim.lease.heartbeat_sequence,
        released_at: None,
    };
    let disposition = store.commit_task_admission(&lease)?;
    let persisted_claim = load_current_task_claim(store, &claim.run_id, claim.task_id.as_str())?;
    if persisted_claim != *claim {
        bail!("durable admission recovered a claim different from the application claim");
    }
    Ok(disposition)
}

/// Confirm the claimed resource realizes both the immutable RunSpec device
/// request and any concrete FEM eigen device already resolved by the planner.
/// The durable lease records the selected device for `auto`; explicit requests
/// can never cross CPU/GPU lanes at admission.
fn validate_claimed_task_resource(store: &SessionStore, claim: &TaskClaim) -> Result<()> {
    let intent = store
        .read_run_intent(claim.run_id.as_str())?
        .context("accepted task admission requires its immutable run intent")?;
    let specification: fullmag_application::RunSpecification =
        serde_json::from_value(intent.specification.clone())
            .context("accepted task run intent specification is not typed")?;
    if specification.run_id != claim.run_id {
        bail!("accepted task claim run differs from the immutable RunSpec");
    }
    let accepted = crate::load_accepted_study_snapshot(
        store,
        &claim.run_id,
        &specification.snapshot.project_id,
    )?;
    let mut matching_step = None;
    for step in &accepted.study.steps {
        if fullmag_session::task_id_for_study_step(claim.run_id.as_str(), &step.step_id)?
            == claim.task_id.as_str()
        {
            if matching_step.is_some() {
                bail!("accepted task claim identifies multiple study steps");
            }
            matching_step = Some(step);
        }
    }
    let study_step = matching_step.context("accepted task claim identifies no study step")?;
    let execution_step = accepted
        .lowered
        .steps
        .iter()
        .find(|step| step.step_id == study_step.step_id)
        .context("accepted task claim has no lowered execution step")?;
    if !study_step.enabled
        || !execution_step.enabled
        || !matches!(
            &execution_step.status,
            fullmag_plan::StudyStepLoweringStatus::Planned
        )
    {
        bail!("accepted task claim targets a disabled or unplanned study step");
    }
    let planned_device = execution_step
        .execution_plan
        .as_ref()
        .and_then(|plan| plan.provenance.fem_eigen_execution_resolution.as_ref())
        .map(|resolution| resolution.resolved_device);
    validate_solver_resource_device(
        &specification.requested_execution.device,
        &claim.lease.kind,
        planned_device,
    )
}

fn validate_solver_resource_device(
    requested_device: &str,
    resource_kind: &ResourceKind,
    planned_device: Option<ExecutionDevice>,
) -> Result<()> {
    let (offered_device, offered_name) = match resource_kind {
        ResourceKind::Cpu => (ExecutionDevice::Cpu, "cpu"),
        ResourceKind::Gpu => (ExecutionDevice::Gpu, "gpu"),
        ResourceKind::Storage | ResourceKind::Meshing => {
            bail!("study solver task requires a CPU or GPU resource lease")
        }
    };
    if requested_device != "auto" && requested_device != offered_name {
        bail!(
            "claimed {offered_name} resource does not match explicit RunSpec device `{requested_device}`"
        );
    }
    if let Some(planned_device) = planned_device {
        if planned_device == ExecutionDevice::Auto {
            bail!("accepted execution plan did not resolve its FEM eigen device");
        }
        if planned_device != offered_device {
            bail!(
                "claimed {offered_name} resource does not match the planner-resolved FEM eigen device `{planned_device:?}`"
            );
        }
    }
    Ok(())
}

/// Reconstruct the current claim only when the run catalog and its active
/// resource lease agree on task, attempt, epoch, resource, and readiness.
/// This is a read-only recovery boundary; it does not create or renew a lease.
pub fn load_current_task_claim(
    store: &SessionStore,
    run_id: &RunId,
    task_id: &str,
) -> Result<TaskClaim> {
    let catalog = store
        .read_run_catalog(run_id.as_str())?
        .context("task claim recovery requires a durable run catalog")?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("task claim recovery task is missing from the durable run catalog")?;
    if !matches!(&task.readiness, FmsTaskReadiness::Ready)
        || !matches!(
            task.lifecycle,
            FmsTaskLifecycle::Preparing | FmsTaskLifecycle::Running | FmsTaskLifecycle::Stopping
        )
    {
        bail!("task is not ready under an active durable claim");
    }
    let attempt_id = task
        .attempt_id
        .as_deref()
        .context("claimed task has no durable attempt id")?;
    let ownership_epoch = task
        .ownership_epoch
        .context("claimed task has no durable ownership epoch")?;
    let resource_id = task
        .resource_id
        .as_deref()
        .context("claimed task has no durable resource assignment")?;
    let durable_lease = store
        .read_active_resource_lease_for_task(run_id.as_str(), task_id)?
        .context("claimed task has no active durable resource lease")?;
    if durable_lease.run_id != run_id.as_str()
        || durable_lease.task_id != task_id
        || durable_lease.attempt_id != attempt_id
        || durable_lease.ownership_epoch != ownership_epoch
        || durable_lease.resource_id != resource_id
    {
        bail!("durable resource lease differs from the task claim in the run catalog");
    }

    let kind = match durable_lease.kind {
        FmsResourceKind::Cpu => ResourceKind::Cpu,
        FmsResourceKind::Gpu => ResourceKind::Gpu,
        FmsResourceKind::Storage => ResourceKind::Storage,
        FmsResourceKind::Meshing => ResourceKind::Meshing,
    };
    let claim = TaskClaim {
        run_id: run_id.clone(),
        task_id: TaskId::parse(task_id).context("invalid durable task id")?,
        attempt_id: AttemptId::parse(attempt_id).context("invalid durable attempt id")?,
        ownership_epoch: OwnershipEpoch::new(ownership_epoch)
            .context("invalid durable ownership epoch")?,
        lease: ResourceLease {
            resource_id: durable_lease.resource_id.clone(),
            kind,
            budget: ResourceBudget {
                cpu_millis: durable_lease.budget.cpu_millis,
                memory_bytes: durable_lease.budget.memory_bytes,
                gpu_memory_bytes: durable_lease.budget.gpu_memory_bytes,
                storage_bytes: durable_lease.budget.storage_bytes,
            },
            lease_token: LeaseToken::parse(durable_lease.lease_token.clone())
                .context("invalid durable lease token")?,
            heartbeat_sequence: durable_lease.heartbeat_sequence,
        },
    };
    store.require_active_resource_lease(
        run_id.as_str(),
        task_id,
        claim.attempt_id.as_str(),
        claim.ownership_epoch.value(),
        claim.lease.resource_id.as_str(),
        claim.lease.lease_token.as_str(),
        claim.lease.heartbeat_sequence,
    )?;
    Ok(claim)
}
