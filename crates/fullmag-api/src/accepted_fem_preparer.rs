//! One-shot native FEM preparation for an immutable accepted study task.

use anyhow::{bail, Context, Result};
use fullmag_application::{RunId, RunSpecification};
use fullmag_ir::{BackendPlanIR, BackendTarget};
use fullmag_plan::StudyStepLoweringStatus;
use fullmag_session::{
    FmsResourceLeaseState, FmsTaskLifecycle, FmsTaskPreparationReceipt, FmsTaskReadiness,
    PreparationReceiptCommitDisposition, SessionStore,
};

#[derive(Debug)]
pub(crate) struct AcceptedFemPreparationResult {
    pub(crate) run_id: String,
    pub(crate) task_id: String,
    pub(crate) step_id: String,
    pub(crate) preparation_id: String,
    pub(crate) plan_fingerprint: String,
    pub(crate) replayed: bool,
}

/// Build native FEM mesh/space evidence for one accepted task and publish its
/// immutable preparation receipt. Existing receipts are validated against the
/// accepted snapshot and returned without repeating native work.
pub(crate) fn prepare_accepted_fem_task(
    store: &SessionStore,
    run_id: &str,
    task_id: &str,
    resource_id: &str,
    preparation_attempt_id: &str,
    lease_token: &str,
) -> Result<AcceptedFemPreparationResult> {
    fullmag_session::repository_path::validate_store_id(run_id)
        .context("accepted FEM preparer run id is invalid")?;
    fullmag_session::repository_path::validate_store_id(task_id)
        .context("accepted FEM preparer task id is invalid")?;
    fullmag_session::repository_path::validate_store_id(resource_id)
        .context("accepted FEM preparer resource id is invalid")?;
    fullmag_session::repository_path::validate_store_id(preparation_attempt_id)
        .context("accepted FEM preparer attempt id is invalid")?;
    fullmag_session::repository_path::validate_store_id(lease_token)
        .context("accepted FEM preparer lease token is invalid")?;
    let run_id =
        RunId::parse(run_id.to_owned()).map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let intent = store
        .read_run_intent(run_id.as_str())?
        .context("accepted FEM preparer run intent is missing")?;
    let specification: RunSpecification = serde_json::from_value(intent.specification.clone())
        .context("accepted FEM preparer RunSpec is invalid")?;
    if specification.run_id != run_id {
        bail!("accepted FEM preparer RunSpec belongs to another run");
    }
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        store,
        &run_id,
        &specification.snapshot.project_id,
    )
    .context("load immutable accepted study for FEM preparation")?;
    let catalog = store
        .read_run_catalog(run_id.as_str())?
        .context("accepted FEM preparation requires a durable run catalog")?;
    let task = catalog
        .tasks
        .iter()
        .find(|task| task.task_id == task_id)
        .context("accepted FEM preparation task is missing from the run catalog")?;
    let preparation_lease = store
        .read_preparation_resource_lease(run_id.as_str(), resource_id, lease_token)?
        .context("accepted FEM preparation resource lease is missing")?;
    if preparation_lease.task_id != task_id
        || preparation_lease.preparation_attempt_id != preparation_attempt_id
    {
        bail!("accepted FEM preparation lease belongs to another task attempt");
    }

    let step = accepted
        .lowered
        .steps
        .iter()
        .find(|step| {
            fullmag_session::task_id_for_study_step(run_id.as_str(), &step.step_id)
                .is_ok_and(|candidate| candidate == task_id)
        })
        .context("accepted FEM preparation task has no immutable study step")?;
    if !matches!(&step.status, StudyStepLoweringStatus::Planned) {
        bail!("accepted FEM preparation study step is not planned");
    }
    let execution_plan = step
        .execution_plan
        .as_ref()
        .context("accepted FEM preparation step has no execution plan")?;
    if execution_plan.common.resolved_backend != BackendTarget::Fem {
        bail!("accepted FEM preparer requires a task resolved to the FEM backend");
    }
    let BackendPlanIR::Fem(fem_plan) = &execution_plan.backend_plan else {
        bail!("accepted FEM preparer currently requires a time-domain FEM plan");
    };

    if let Some(existing) = store.read_task_preparation_receipt(run_id.as_str(), task_id)? {
        let receipt = accepted
            .read_task_preparation_receipt(store, task_id)
            .context("validate replayed accepted FEM preparation receipt")?;
        if receipt.plan.resolved_backend != BackendTarget::Fem {
            bail!("existing task preparation receipt is not a FEM receipt");
        }
        return Ok(AcceptedFemPreparationResult {
            run_id: run_id.as_str().to_owned(),
            task_id: task_id.to_owned(),
            step_id: existing.step_id,
            preparation_id: receipt.preparation_id,
            plan_fingerprint: receipt.plan_fingerprint,
            replayed: true,
        });
    }

    if task.lifecycle != FmsTaskLifecycle::Accepted
        || !matches!(
            &task.readiness,
            FmsTaskReadiness::Blocked { reason }
                if reason == fullmag_session::FMS_TASK_AWAITING_PREPARATION_REASON
        )
        || task.attempt_id.is_some()
        || task.resource_id.is_some()
    {
        bail!("new accepted FEM preparation requires an unclaimed accepted task");
    }
    if preparation_lease.state != FmsResourceLeaseState::Active {
        bail!("new accepted FEM preparation requires an active resource lease");
    }

    let native = produce_native_fem_evidence(&fem_plan.mesh, fem_plan.fe_order)?;
    let preparation_id = format!("prep-{task_id}");
    let receipt = accepted
        .materialize_fem_preparation_receipt(preparation_id, &step.step_id, &native)
        .with_context(|| {
            format!(
                "materialize accepted FEM preparation for `{}`",
                step.step_id
            )
        })?;
    let payload =
        serde_json::to_value(&receipt).context("serialize accepted FEM preparation receipt")?;
    let durable = FmsTaskPreparationReceipt::new(
        run_id.as_str(),
        step.step_id.clone(),
        task.input_fingerprint.clone(),
        receipt.preparation_id.clone(),
        receipt.plan_fingerprint.clone(),
        payload,
    )?;
    let replayed = matches!(
        store.commit_task_preparation_receipt_with_preparation_lease(
            &durable,
            resource_id,
            preparation_attempt_id,
            lease_token,
        )?,
        PreparationReceiptCommitDisposition::Replayed
    );
    let verified = accepted
        .read_task_preparation_receipt(store, task_id)
        .context("verify published accepted FEM preparation receipt")?;
    Ok(AcceptedFemPreparationResult {
        run_id: run_id.as_str().to_owned(),
        task_id: task_id.to_owned(),
        step_id: step.step_id.clone(),
        preparation_id: verified.preparation_id,
        plan_fingerprint: verified.plan_fingerprint,
        replayed,
    })
}

#[cfg(feature = "fem-native")]
fn produce_native_fem_evidence(
    mesh: &fullmag_ir::MeshIR,
    fe_order: u32,
) -> Result<fullmag_plan::NativeFemMeshSpaceEvidence> {
    fullmag_runner::prepare_fem_mesh_space(mesh, fe_order)
        .map_err(anyhow::Error::msg)
        .context("build native FEM mesh and finite-element space evidence")
}

#[cfg(not(feature = "fem-native"))]
fn produce_native_fem_evidence(
    _mesh: &fullmag_ir::MeshIR,
    _fe_order: u32,
) -> Result<fullmag_plan::NativeFemMeshSpaceEvidence> {
    bail!("accepted FEM preparation requires the fem-native feature")
}
