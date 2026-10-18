//! One-shot native FEM preparation for an immutable accepted study task.

use anyhow::{bail, Context, Result};
use fullmag_application::{AcceptedPreparationReceipt, ClosedLoopPreparationReceipt, RunId, RunSpecification};
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

    if let Some(binding) = &preparation_lease.host_launch_binding {
        let token = std::env::var("FULLMAG_HOST_PREPARATION_LAUNCH_TOKEN")
            .context("host-bound FEM preparer requires its supervisor launch permit")?;
        let ledger = retry_preparation_store_writer_busy(|| {
            fullmag_session::host_resource_ledger::HostResourceLedger::open_for_current_application(
                &binding.ledger_root,
                binding.policy.clone(),
            )
        })
        .context("open host resource ledger for accepted FEM preparation")?;
        if binding.policy.requires_runtime_readiness() {
            let expected_generation = binding.require_runtime_generation_sha256()?;
            retry_preparation_store_writer_busy(|| {
                ledger.validate_runtime_generation(expected_generation)
            })
            .context("validate host runtime generation for accepted FEM preparation")?;
        }
        retry_preparation_store_writer_busy(|| {
            ledger.validate_preparation_launch(store, &preparation_lease, &token)
        })
        .context("validate host preparation launch for accepted FEM preparation")?;
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
    let entry = accepted.catalog.entries().iter().find(|entry| entry.step_id() == step.step_id)
        .context("native preparation has no captured ProblemIR")?;
    let (mesh, fe_order) = match (&step.kind, &execution_plan.backend_plan) {
        (fullmag_authoring::StudyStepKind::ClosedLoopInspection { stage_id, port_mode_id, output_id }, BackendPlanIR::AntennaFieldOnly(_)) => {
            let operation = fullmag_plan::validate_closed_loop_operation(entry.problem(), stage_id, port_mode_id, output_id)?;
            let fullmag_plan::AntennaFieldSolveExecutionPlan::ClosedLoopInspection { input, .. } = operation else { bail!("native preparation operation mismatch"); };
            (input.source_mesh, 1)
        }
        (_, plan) => {
            let (mesh, order) = accepted_preparation_mesh(plan)?;
            (mesh.clone(), order)
        }
    };

    if let Some(existing) = store.read_task_preparation_receipt(run_id.as_str(), task_id)? {
        let receipt = accepted
            .read_task_preparation(store, task_id)
            .context("validate replayed accepted FEM preparation receipt")?;
        return Ok(AcceptedFemPreparationResult {
            run_id: run_id.as_str().to_owned(),
            task_id: task_id.to_owned(),
            step_id: existing.step_id,
            preparation_id: receipt.preparation_id().to_owned(),
            plan_fingerprint: receipt.plan_fingerprint().to_owned(),
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

    let native = produce_native_fem_evidence(&mesh, fe_order)?;
    let preparation_id = format!("prep-{task_id}");
    let receipt = if matches!(step.kind, fullmag_authoring::StudyStepKind::ClosedLoopInspection { .. }) {
        AcceptedPreparationReceipt::ClosedLoop(ClosedLoopPreparationReceipt::ready(
            &specification, task_id, step, entry.problem(), native)?)
    } else {
        let solver = match &execution_plan.backend_plan {
            BackendPlanIR::Fem(_) => accepted.materialize_fem_preparation_receipt(
                preparation_id, &step.step_id, &native),
            BackendPlanIR::AntennaExternalLeadInspection(_) => accepted
                .materialize_antenna_external_lead_inspection_preparation_receipt(
                    preparation_id, &step.step_id, &native),
            _ => bail!("accepted FEM preparer requires a FEM or typed inspection plan"),
        }.with_context(|| format!("materialize accepted preparation for `{}`", step.step_id))?;
        AcceptedPreparationReceipt::Solver(solver)
    };
    let payload = receipt.payload().context("serialize accepted native preparation receipt")?;
    let durable = FmsTaskPreparationReceipt::new(
        run_id.as_str(),
        step.step_id.clone(),
        task.input_fingerprint.clone(),
        receipt.preparation_id().to_owned(),
        receipt.plan_fingerprint().to_owned(),
        payload,
    )?;
    let replayed = matches!(
        retry_preparation_store_writer_busy(|| {
            store.commit_task_preparation_receipt_with_preparation_lease(
                &durable,
                resource_id,
                preparation_attempt_id,
                lease_token,
            )
        })
        .context("publish accepted FEM preparation receipt")?,
        PreparationReceiptCommitDisposition::Replayed
    );
    let verified = accepted
        .read_task_preparation(store, task_id)
        .context("verify published accepted FEM preparation receipt")?;
    Ok(AcceptedFemPreparationResult {
        run_id: run_id.as_str().to_owned(),
        task_id: task_id.to_owned(),
        step_id: step.step_id.clone(),
        preparation_id: verified.preparation_id().to_owned(),
        plan_fingerprint: verified.plan_fingerprint().to_owned(),
        replayed,
    })
}

/// Select only the mesh consumed by the pinned workflow. Inspection uses the
/// conductor plus leads, never the original device or a magnetic target mesh.
fn accepted_preparation_mesh(plan: &BackendPlanIR) -> Result<(&fullmag_ir::MeshIR, u32)> {
    match plan {
        BackendPlanIR::Fem(fem) => Ok((&fem.mesh, fem.fe_order)),
        BackendPlanIR::AntennaExternalLeadInspection(antenna) => {
            Ok((&antenna.input.combined_mesh, 1))
        }
        _ => bail!("accepted FEM preparer requires a time-domain FEM or antenna inspection plan"),
    }
}

/// Retry only one idempotent store/host-writer operation. Native FEM evidence
/// must never be repeated merely because a shared writer is temporarily busy.
fn retry_preparation_store_writer_busy<T>(operation: impl FnMut() -> Result<T>) -> Result<T> {
    fullmag_runtime_control::retry_store_writer_busy(operation)
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

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Error;

    #[test]
    fn mesh_selection_preserves_magnetic_mesh_order_and_rejects_fdm() {
        let mut fem = fullmag_ir::FemPlanIR::default();
        fem.fe_order = 2;
        let plan = BackendPlanIR::Fem(fem);
        let (mesh, order) = accepted_preparation_mesh(&plan).unwrap();
        let BackendPlanIR::Fem(fem) = &plan else {
            panic!("test fixture must be FEM");
        };
        assert!(std::ptr::eq(mesh, &fem.mesh));
        // Selection must not silently coerce magnetic order; native H1
        // validation remains responsible for rejecting unsupported orders.
        assert_eq!(order, 2);
        let error = accepted_preparation_mesh(
            &BackendPlanIR::Fdm(fullmag_ir::FdmPlanIR::default()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("time-domain FEM or antenna inspection"));
    }

    #[test]
    fn preparation_writer_retry_retries_typed_busy_but_not_other_errors() {
        let mut typed_attempts = 0;
        let value = retry_preparation_store_writer_busy(|| {
            typed_attempts += 1;
            if typed_attempts == 1 {
                Err(Error::new(fullmag_session::StoreWriterBusy))
            } else {
                Ok("validated")
            }
        })
        .unwrap();
        assert_eq!(value, "validated");
        assert_eq!(typed_attempts, 2);

        let mut ordinary_attempts = 0;
        let error = retry_preparation_store_writer_busy(|| {
            ordinary_attempts += 1;
            Err::<(), _>(anyhow::anyhow!("invalid launch token"))
        })
        .unwrap_err();
        assert_eq!(ordinary_attempts, 1);
        assert!(error.to_string().contains("invalid launch token"));
    }
}
