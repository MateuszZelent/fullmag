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
    let accepted_study_load_started = std::time::Instant::now();
    let accepted = fullmag_runtime_control::load_accepted_study_snapshot(
        store,
        &run_id,
        &specification.snapshot.project_id,
    )
    .context("load immutable accepted study for FEM preparation")?;
    eprintln!(
        "accepted-fem-preparer: phase=load_accepted_study_snapshot elapsed_ms={:.3}",
        accepted_study_load_started.elapsed().as_secs_f64() * 1_000.0
    );
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

    let replay_validation_started = std::time::Instant::now();
    if let Some(existing) = store.read_task_preparation_receipt(run_id.as_str(), task_id)? {
        let receipt = accepted
            .read_task_preparation(store, task_id)
            .context("validate replayed accepted FEM preparation receipt")?;
        eprintln!(
            "accepted-fem-preparer: phase=replay_validation result=hit elapsed_ms={:.3}",
            replay_validation_started.elapsed().as_secs_f64() * 1_000.0
        );
        return Ok(AcceptedFemPreparationResult {
            run_id: run_id.as_str().to_owned(),
            task_id: task_id.to_owned(),
            step_id: existing.step_id,
            preparation_id: receipt.preparation_id().to_owned(),
            plan_fingerprint: receipt.plan_fingerprint().to_owned(),
            replayed: true,
        });
    }
    eprintln!(
        "accepted-fem-preparer: phase=replay_validation result=miss elapsed_ms={:.3}",
        replay_validation_started.elapsed().as_secs_f64() * 1_000.0
    );

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

    let native_preparation_started = std::time::Instant::now();
    let native = produce_native_fem_evidence(&mesh, fe_order)?;
    eprintln!(
        "accepted-fem-preparer: phase=native_prepare_fem_mesh_space elapsed_ms={:.3}",
        native_preparation_started.elapsed().as_secs_f64() * 1_000.0
    );
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
    if matches!(receipt, AcceptedPreparationReceipt::Solver(_))
        && matches!(execution_plan.backend_plan, BackendPlanIR::Fem(_))
    {
        let target = PreparedObservationTarget {
            run_id: run_id.as_str(),
            step_id: &step.step_id,
            preparation_id: receipt.preparation_id(),
            plan_fingerprint: receipt.plan_fingerprint(),
            requested_device: &specification.requested_execution.device,
            resource_id,
            preparation_attempt_id,
            lease_token,
            memory_bytes: preparation_lease.budget.memory_bytes,
        };
        if let Err(error) =
            publish_prepared_observation(store, entry.problem(), execution_plan, &target)
        {
            // Observation never changes the preparation outcome; the fields
            // simply remain available only after a run.
            eprintln!("accepted FEM preparer: prepared-state observation not published: {error:#}");
        }
    }
    let payload = receipt.payload().context("serialize accepted native preparation receipt")?;
    let durable = FmsTaskPreparationReceipt::new(
        run_id.as_str(),
        step.step_id.clone(),
        task.input_fingerprint.clone(),
        receipt.preparation_id().to_owned(),
        receipt.plan_fingerprint().to_owned(),
        payload,
    )?;
    let receipt_commit_started = std::time::Instant::now();
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
    eprintln!(
        "accepted-fem-preparer: phase=receipt_commit elapsed_ms={:.3} replayed={replayed}",
        receipt_commit_started.elapsed().as_secs_f64() * 1_000.0
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

/// Upper bound for the field values of one prepared-state observation.
const MAX_PREPARED_OBSERVATION_BYTES: u64 = 1 << 30;
const MAX_UNAVAILABLE_REASON_CHARS: usize = 1024;

struct PreparedObservationTarget<'a> {
    run_id: &'a str,
    step_id: &'a str,
    preparation_id: &'a str,
    plan_fingerprint: &'a str,
    requested_device: &'a str,
    resource_id: &'a str,
    preparation_attempt_id: &'a str,
    lease_token: &'a str,
    memory_bytes: u64,
}

/// Evaluate the prepared initial state's fields on the FEM CPU lane under this
/// preparation lease and publish an immutable observation record (ADR 0071
/// v1). An evaluator failure or exhausted budget is recorded as unavailable;
/// only a store failure returns an error.
fn publish_prepared_observation(
    store: &SessionStore,
    problem: &fullmag_ir::ProblemIR,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
    target: &PreparedObservationTarget<'_>,
) -> Result<()> {
    let BackendPlanIR::Fem(fem) = &execution_plan.backend_plan else {
        return Ok(());
    };
    let Some(requested_lane) =
        crate::prepared_observation_bundle::fem_lane_label(target.requested_device)
    else {
        return Ok(());
    };
    let values = &fem.initial_magnetization;
    let flattened = values.iter().flatten().copied().collect::<Vec<_>>();
    let identity = fullmag_runner::PreparedStateIdentity {
        run_id: target.run_id.to_owned(),
        task_id: fullmag_session::task_id_for_study_step(target.run_id, target.step_id)?,
        step_id: target.step_id.to_owned(),
        preparation_id: target.preparation_id.to_owned(),
        plan_fingerprint: target.plan_fingerprint.to_owned(),
        magnetization_values_sha256: fullmag_runner::live_preview_values_sha256(&flattened),
    };
    let byte_budget = (target.memory_bytes / 4).min(MAX_PREPARED_OBSERVATION_BYTES);
    let outcome = match evaluate_prepared_fem_fields(problem, execution_plan, &identity, values, byte_budget) {
        Ok(batch) => store_prepared_bundle(store, batch, requested_lane)?,
        Err(reason) => fullmag_session::FmsTaskPreparedObservationOutcome::Unavailable {
            reason: reason.chars().take(MAX_UNAVAILABLE_REASON_CHARS).collect(),
        },
    };
    let record = fullmag_session::FmsTaskPreparedObservation::new(
        target.run_id,
        target.step_id,
        target.preparation_id,
        target.plan_fingerprint,
        identity.magnetization_values_sha256.clone(),
        "fem_cpu",
        requested_lane,
        outcome,
    )?;
    retry_preparation_store_writer_busy(|| {
        store.commit_task_prepared_observation_with_preparation_lease(
            &record,
            target.resource_id,
            target.preparation_attempt_id,
            target.lease_token,
        )
    })
    .context("publish prepared-state observation record")?;
    Ok(())
}

/// Observation-only evaluation on the CPU lane. A GPU task is evaluated on
/// the CPU here and the record names both lanes; the solver lane is unchanged.
fn evaluate_prepared_fem_fields(
    problem: &fullmag_ir::ProblemIR,
    execution_plan: &fullmag_ir::ExecutionPlanIR,
    identity: &fullmag_runner::PreparedStateIdentity,
    values: &[[f64; 3]],
    byte_budget: u64,
) -> std::result::Result<fullmag_runner::PreparedMaterializationBatch, String> {
    let lane = fullmag_runner::AcceptedMaterializationLane::FemCpu;
    let active = fullmag_runner::accepted_observation_quantity_ids(execution_plan, lane)?;
    let components = active
        .iter()
        .filter(|id| **id != "m")
        .filter_map(|id| fullmag_quantities::quantity_spec(id))
        .map(|spec| u64::from(spec.n_comp))
        .sum::<u64>();
    let estimated = components
        .saturating_mul(values.len() as u64)
        .saturating_mul(std::mem::size_of::<f64>() as u64);
    if estimated > byte_budget {
        return Err(format!(
            "prepared observation needs {estimated} bytes, above the preparation budget of {byte_budget} bytes"
        ));
    }
    let mut cpu_plan = execution_plan.clone();
    if let BackendPlanIR::Fem(plan) = &mut cpu_plan.backend_plan {
        plan.mfem_device_string = Some("cpu".into());
    }
    // The evaluator installs m into its own plan copy and requires the exact
    // canonical state-space layout of that plan.
    let layout = fullmag_runner::study_magnetization_layout_for_plan(&cpu_plan)
        .map_err(|error| error.to_string())?;
    let request = fullmag_runner::PreparedMaterializationRequest {
        plan: &cpu_plan,
        problem,
        identity,
        lane,
        values,
        layout: &layout,
        requested_quantity_ids: &[],
    };
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        fullmag_runner::materialize_prepared_observables(&request)
    }))
    .map_err(|_| "prepared-state evaluator panicked".to_string())?
}

/// Write every field as immutable F64LE CAS chunks plus one bundle object.
fn store_prepared_bundle(
    store: &SessionStore,
    batch: fullmag_runner::PreparedMaterializationBatch,
    requested_lane: &str,
) -> Result<fullmag_session::FmsTaskPreparedObservationOutcome> {
    use crate::prepared_observation_bundle::{
        PreparedObservationBundle, PreparedObservationField, PREPARED_FIELD_BINARY_SCHEMA,
        PREPARED_FIELD_CHUNK_VALUES, PREPARED_OBSERVATION_BUNDLE_SCHEMA,
    };
    let mut object_refs = Vec::new();
    let mut fields = Vec::new();
    for field in batch.fields {
        // The prepared magnetization is already published by the API.
        if field.quantity_id == "m" || field.role == "airbox" {
            continue;
        }
        let max_read_bytes = (field.values.len() as u64).saturating_mul(8);
        let mut chunks = Vec::new();
        for (ordinal, values) in field.values.chunks(PREPARED_FIELD_CHUNK_VALUES).enumerate() {
            let mut bytes = Vec::with_capacity(values.len() * 8);
            for value in values {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            let object_ref = retry_preparation_store_writer_busy(|| store.cas().put(&bytes))
                .context("store prepared field chunk")?;
            if !object_refs.contains(&object_ref) {
                object_refs.push(object_ref.clone());
            }
            chunks.push(serde_json::json!({
                "object_ref": object_ref,
                "value_offset": ordinal * PREPARED_FIELD_CHUNK_VALUES,
                "value_count": values.len(),
            }));
        }
        fields.push(PreparedObservationField {
            binary: serde_json::json!({
                "schema_version": PREPARED_FIELD_BINARY_SCHEMA,
                "value_count": field.values.len(),
                "values_sha256": fullmag_runner::live_preview_values_sha256(&field.values),
                "max_read_bytes": max_read_bytes,
                "chunks": chunks,
            }),
            quantity_id: field.quantity_id,
            carrier_id: field.carrier_id,
            role: field.role,
            n_comp: field.n_comp,
            layout: field.layout,
            spatial_kind: field.spatial_kind,
        });
    }
    if fields.is_empty() {
        return Ok(fullmag_session::FmsTaskPreparedObservationOutcome::Unavailable {
            reason: "prepared-state evaluator produced no derived fields".into(),
        });
    }
    let bundle = PreparedObservationBundle {
        schema_version: PREPARED_OBSERVATION_BUNDLE_SCHEMA.into(),
        identity: batch.identity,
        clock: batch.clock,
        evaluation_lane: "fem_cpu".into(),
        requested_lane: requested_lane.into(),
        evaluator_build_identity: batch.evaluator_build_identity,
        fields,
        unavailable_scopes: batch.unavailable_scopes,
        energies: batch.energies,
    };
    let bundle_bytes = serde_json::to_vec(&bundle)?;
    let bundle_object_ref = retry_preparation_store_writer_busy(|| store.cas().put(&bundle_bytes))
        .context("store prepared observation bundle")?;
    if !object_refs.contains(&bundle_object_ref) {
        object_refs.push(bundle_object_ref.clone());
    }
    Ok(fullmag_session::FmsTaskPreparedObservationOutcome::Published {
        bundle_object_ref,
        object_refs,
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
