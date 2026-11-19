//! Standalone accepted antenna inspection. No magnetic state or time integrator.

use anyhow::{bail, Context, Result};
use fullmag_application::PreparationBinding;
use fullmag_authoring::{StudyOutputPort, StudyPortDataKind};
use fullmag_ir::{
    BackendPlanIR, BackendTarget, ExecutionDevice, ExecutionMode, ExecutionPrecision,
};
use fullmag_runtime_control::{AcceptedStudySnapshot, AcceptedWorkerStep, StudyOutputPayload};
use fullmag_session::SessionStore;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) struct PreparedInspection {
    pub(crate) problem: fullmag_ir::ProblemIR,
    pub(crate) execution_plan: fullmag_ir::ExecutionPlanIR,
    pub(crate) output_ports: Vec<StudyOutputPort>,
    case_id: String,
}

pub(crate) enum InspectionOutcome {
    Completed(Vec<StudyOutputPayload>),
    Cancelled,
}

pub(crate) fn validate_declared_outputs(outputs: &[StudyOutputPort]) -> Result<()> {
    if outputs.len() != 1
        || outputs[0].port_id != fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID
        || outputs[0].data_kind != StudyPortDataKind::Artifact
    {
        bail!("antenna inspection requires exactly one inspection/Artifact output; magnetic outputs are forbidden");
    }
    Ok(())
}

fn validate_stage_kind(kind: &fullmag_authoring::StudyStepKind) -> Result<()> {
    if !matches!(
        kind,
        fullmag_authoring::StudyStepKind::Primitive {
            stage_kind: fullmag_authoring::StudyPrimitiveStageKind::AntennaFieldSolve,
        }
    ) {
        bail!("antenna inspection requires the explicit antenna_field_solve Study primitive");
    }
    Ok(())
}

fn validate_intent(
    request: &fullmag_application::RequestedExecution,
    intent: &fullmag_ir::RequestedTransportExecutionIR,
) -> Result<()> {
    if request.backend != "fem"
        || request.precision != "double"
        || request.mode != "strict"
        || intent.discretization != BackendTarget::Fem
        || intent.precision != ExecutionPrecision::Double
        || intent.execution_mode != ExecutionMode::Strict
        || match intent.device {
            ExecutionDevice::Cpu => request.device != "cpu",
            ExecutionDevice::Auto => request.device != "auto",
            ExecutionDevice::Gpu => true,
        }
    {
        bail!("accepted antenna inspection request differs from its immutable FEM CPU intent");
    }
    Ok(())
}

/// Validate immutable preparation and execution before the durable started boundary.
pub(crate) fn prepare(
    store: &SessionStore,
    accepted: &AcceptedStudySnapshot,
    step: &AcceptedWorkerStep,
    study_step: &fullmag_authoring::StudyStep,
    case_id: &str,
) -> Result<PreparedInspection> {
    validate_declared_outputs(&study_step.outputs)?;
    validate_stage_kind(&study_step.kind)?;
    fullmag_session::repository_path::validate_store_id(case_id)?;
    let request = &step.resolved_input.requested_execution;
    if request.backend != "fem"
        || !matches!(request.device.as_str(), "cpu" | "auto")
        || request.precision != "double"
        || request.mode != "strict"
        || step.claim.lease.kind != fullmag_application::ResourceKind::Cpu
        || step.claim.lease.budget.gpu_memory_bytes != 0
    {
        bail!("accepted antenna inspection requires fem/cpu-or-auto/double/strict and a CPU lease with zero GPU budget");
    }
    let execution_plan =
        crate::accepted_study_worker::materialize_resolved_study_inputs(store, step)?;
    let BackendPlanIR::AntennaExternalLeadInspection(inspection) = &execution_plan.backend_plan
    else {
        bail!("antenna inspection requires its dedicated execution plan");
    };
    let intent = &inspection.requested_execution;
    validate_intent(request, intent)?;
    if execution_plan.common.requested_backend != BackendTarget::Fem
        || execution_plan.common.resolved_backend != BackendTarget::Fem
        || execution_plan.common.execution_mode != ExecutionMode::Strict
        || step.problem.backend_policy.requested_backend != BackendTarget::Fem
        || step.problem.backend_policy.execution_precision != ExecutionPrecision::Double
        || step.problem.validation_profile.execution_mode != ExecutionMode::Strict
    {
        bail!("accepted antenna inspection request differs from its immutable FEM CPU intent");
    }
    if !step.study_inputs.is_empty()
        || !step.resolved_input.inputs.is_empty()
        || step.until_seconds.is_some()
    {
        bail!("antenna inspection has no magnetic or artifact input adapter");
    }
    crate::accepted_study_worker::validate_accepted_inspection_run_parameters(
        &accepted.run.specification,
        &step.step_id,
    )?;
    if !accepted.run.specification.seeds.is_empty()
        || !step.problem.problem_meta.seeds.is_empty()
    {
        bail!("antenna inspection has no RunSpec parameter or seed binding");
    }
    // Receipts are keyed by the durable task id, not the study step id.
    let preparation = accepted.read_task_preparation_receipt(store, step.claim.task_id.as_str())?;
    if PreparationBinding::from_receipt(&preparation)? != step.resolved_input.preparation
        || preparation.plan.requested_backend != BackendTarget::Fem
        || preparation.plan.resolved_backend != BackendTarget::Fem
    {
        bail!("antenna inspection preparation differs from accepted input");
    }
    let spaces = preparation
        .certificates
        .iter()
        .filter_map(|c| c.space.as_ref())
        .filter(|s| {
            s.fe_family.as_deref() == Some("H1")
                && s.fe_order == Some(1)
                && s.local_dof_count.is_some_and(|n| n > 0)
                && s.true_dof_count.is_some_and(|n| n > 0)
        })
        .count();
    if spaces != 1 {
        bail!("antenna inspection requires exactly one native H1/P1 preparation certificate");
    }
    if std::env::var("FULLMAG_FEM_EXECUTION").is_ok_and(|value| {
        let value = value.trim().to_ascii_lowercase();
        !value.is_empty() && value != "cpu"
    }) || ["FULLMAG_FEM_ALL_IN_GPU", "FULLMAG_FEM_REQUIRE_GPU"]
        .iter()
        .any(|key| {
            std::env::var(key).is_ok_and(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
        })
    {
        bail!("process environment cannot force GPU for accepted antenna inspection");
    }
    let canonical = fullmag_plan::plan_antenna_external_lead_inspection(
        &step.problem,
        &inspection.input.stage.id,
        &inspection.input.port.id,
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if canonical != execution_plan {
        bail!("antenna inspection plan differs from canonical authored derivation");
    }
    let runtime = fullmag_runner::resolve_session_runtime_for_plan_and_preview(
        &step.problem,
        &execution_plan,
        u64::MAX,
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if runtime.resolved_backend != "fem"
        || runtime.resolved_device != "cpu"
        || runtime.resolved_precision != "double"
        || runtime.resolved_engine_id.as_deref() != Some("fem_cpu_native")
        || runtime.resolved_fallback.is_some()
    {
        bail!("antenna inspection native preflight requires FEM CPU double without fallback");
    }
    Ok(PreparedInspection {
        problem: step.problem.clone(),
        execution_plan,
        output_ports: study_step.outputs.clone(),
        case_id: case_id.into(),
    })
}

fn cancelled(flag: Option<&AtomicBool>) -> bool {
    flag.is_some_and(|flag| flag.load(Ordering::Acquire))
}

/// Native solve is non-preemptive. Never hand off bytes after an observed Stop.
pub(crate) fn execute(
    prepared: &PreparedInspection,
    storage_budget: u64,
    interrupt: Option<&AtomicBool>,
) -> Result<InspectionOutcome> {
    if cancelled(interrupt) {
        return Ok(InspectionOutcome::Cancelled);
    }
    let BackendPlanIR::AntennaExternalLeadInspection(plan) = &prepared.execution_plan.backend_plan
    else {
        bail!("prepared antenna execution is not inspection");
    };
    let result = fullmag_runner::execute_antenna_external_lead_inspection(
        &plan.input,
        &plan.requested_execution,
        &plan.output_id,
        interrupt,
    );
    if cancelled(interrupt) {
        return Ok(InspectionOutcome::Cancelled);
    }
    let artifact = result.map_err(|e| anyhow::anyhow!(e.to_string()))?;
    // Bound allocation before framing copies the retained numerical payloads.
    let maximum = artifact.payloads.iter().try_fold(
        16u64 + u64::try_from(artifact.manifest_bytes.len())?,
        |size, payload| -> Result<u64> {
            size.checked_add(8)
                .and_then(|n| n.checked_add(payload.bytes.len() as u64))
                .context("antenna inspection package size overflow")
        },
    )?;
    if maximum > storage_budget {
        bail!("antenna inspection output exceeds accepted storage budget");
    }
    let bytes = fullmag_runner::encode_antenna_inspection_package(&artifact)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    validate_package(&bytes, &prepared.execution_plan)?;
    if cancelled(interrupt) {
        return Ok(InspectionOutcome::Cancelled);
    }
    Ok(InspectionOutcome::Completed(vec![StudyOutputPayload {
        port_id: fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID.into(),
        case_id: prepared.case_id.clone(),
        codec_id: fullmag_application::STUDY_ANTENNA_INSPECTION_CODEC_ID.into(),
        codec_version: fullmag_application::STUDY_ANTENNA_INSPECTION_CODEC_VERSION.into(),
        bytes,
    }]))
}

/// Recovery validates CAS-owned bytes against the same accepted request, without solve.
pub(crate) fn validate_package(
    bytes: &[u8],
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<fullmag_runner::AntennaExternalLeadSolutionRef> {
    let decoded = fullmag_application::decode_study_artifact_bytes(
        "artifact",
        fullmag_application::STUDY_ANTENNA_INSPECTION_CODEC_ID,
        fullmag_application::STUDY_ANTENNA_INSPECTION_CODEC_VERSION,
        bytes,
    )?;
    let fullmag_application::DecodedStudyArtifact::AntennaInspection(artifact) = decoded else {
        bail!("inspection codec returned a magnetic artifact");
    };
    let loaded = fullmag_runner::load_antenna_inspection_package_for_execution_plan(
        bytes,
        &artifact.reference,
        plan,
    )
    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if loaded.manifest.current_display.is_none() {
        bail!("accepted antenna inspection output must retain its V/J/H display payloads");
    }
    Ok(artifact.reference)
}

/// Export only plan-bound retained data, through the canonical antenna publisher.
/// This private staging copy does not publish the accepted Study output or bypass Stop.
pub(crate) fn stage_project_output(
    root: &std::path::Path,
    bytes: &[u8],
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<()> {
    let reference = validate_package(bytes, plan)?;
    fullmag_runner::publish_antenna_inspection_package_atomically(root, bytes, &reference, None)
        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepted_inspection_preserves_auto_and_rejects_wrong_request_and_stage() {
        let mut request = fullmag_application::RequestedExecution {
            backend: "fem".into(),
            device: "auto".into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: None,
        };
        let mut intent = fullmag_ir::RequestedTransportExecutionIR {
            discretization: BackendTarget::Fem,
            device: ExecutionDevice::Auto,
            precision: ExecutionPrecision::Double,
            execution_mode: ExecutionMode::Strict,
        };
        assert!(validate_intent(&request, &intent).is_ok());
        request.device = "cpu".into();
        assert!(validate_intent(&request, &intent).is_err());
        intent.device = ExecutionDevice::Cpu;
        assert!(validate_intent(&request, &intent).is_ok());
        intent.device = ExecutionDevice::Gpu;
        request.device = "gpu".into();
        assert!(validate_intent(&request, &intent).is_err());
        intent.device = ExecutionDevice::Cpu;
        request.device = "cpu".into();
        for (backend, precision, mode) in [
            ("fdm", "double", "strict"),
            ("auto", "double", "strict"),
            ("fem", "single", "strict"),
            ("fem", "double", "extended"),
        ] {
            request.backend = backend.into();
            request.precision = precision.into();
            request.mode = mode.into();
            assert!(validate_intent(&request, &intent).is_err());
        }
        assert!(
            validate_stage_kind(&fullmag_authoring::StudyStepKind::Primitive {
                stage_kind: fullmag_authoring::StudyPrimitiveStageKind::AntennaFieldSolve,
            })
            .is_ok()
        );
        assert!(
            validate_stage_kind(&fullmag_authoring::StudyStepKind::Primitive {
                stage_kind: fullmag_authoring::StudyPrimitiveStageKind::Run,
            })
            .is_err()
        );
        for root in [
            include_str!("main.rs"),
            include_str!("accepted_worker_main.rs"),
        ] {
            assert!(root.contains("mod accepted_antenna_inspection_worker;"));
        }
    }
    #[test]
    fn inspection_output_is_not_a_magnetic_output() {
        let source = include_str!("accepted_antenna_inspection_worker.rs");
        assert!(!source
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .contains("run_planned_problem"));
        assert!(source
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .contains("step.until_seconds.is_some()"));
        assert!(validate_declared_outputs(&[]).is_err());
        let port = StudyOutputPort {
            port_id: fullmag_authoring::ANTENNA_INSPECTION_OUTPUT_PORT_ID.into(),
            data_kind: StudyPortDataKind::Artifact,
        };
        assert!(validate_declared_outputs(&[port.clone()]).is_ok());
        assert!(validate_declared_outputs(&[port.clone(), port.clone()]).is_err());
        assert!(validate_declared_outputs(&[StudyOutputPort {
            data_kind: StudyPortDataKind::State,
            ..port.clone()
        }])
        .is_err());
        assert!(validate_declared_outputs(&[StudyOutputPort {
            port_id: "final_state".into(),
            ..port
        }])
        .is_err());
        assert!(cancelled(Some(&AtomicBool::new(true))));
    }
}
