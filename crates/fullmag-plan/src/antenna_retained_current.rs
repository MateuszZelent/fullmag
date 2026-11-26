//! Pure retained-current field intent; durable parent admission is a separate runtime boundary.
use fullmag_ir::{
    AntennaOerstedRealizationIR, AntennaRetainedCurrentFieldPlanIR, BackendTarget,
    ExecutionDevice, ExecutionMode, ExecutionPrecision, ProblemIR, RequestedTransportExecutionIR,
    StudyIR, ANTENNA_RETAINED_CURRENT_FIELD_PLAN_SCHEMA,
};
use crate::{antenna_field_solve::resolve_field_sampling, PlanError};

fn fail(reason: impl Into<String>) -> PlanError {
    PlanError { reasons: vec![reason.into()] }
}

/// Plan new sampling from an immutable locator, without loading or reconstructing its source.
/// A valid plan is not evidence of durable completion, CAS ownership or source qualification.
pub fn plan_retained_current_field_inspection(
    problem: &ProblemIR, stage_id: &str, port_mode_id: &str,
) -> Result<AntennaRetainedCurrentFieldPlanIR, PlanError> {
    problem.validate().map_err(|reasons| PlanError { reasons })?;
    match &problem.study {
        StudyIR::FieldOnly { .. } => {}
        StudyIR::AntennaFieldSolve { selection: Some(selection), sampling }
            if selection.stage_id == stage_id && selection.port_mode_id == port_mode_id => {
                let mut nonmagnetic_validation = problem.clone();
                nonmagnetic_validation.study = StudyIR::FieldOnly { sampling: sampling.clone() };
                nonmagnetic_validation.validate().map_err(|reasons| PlanError { reasons })?;
            }
        _ => return Err(fail("retained-current H-only requires FieldOnly or an exactly selected nonmagnetic AntennaFieldSolve")),
    }
    crate::execution_profile_guard::validate_bound_intent(problem).map_err(fail)?;
    if let Some(resources) = fullmag_ir::ComputeResourcesIR::from_problem(problem).map_err(fail)? {
        crate::compute_resources::validate_current_runtime_support(&resources)
            .map_err(|reasons| PlanError { reasons })?;
    }
    if problem.backend_policy.requested_backend != BackendTarget::Fem
        || problem.backend_policy.execution_precision != ExecutionPrecision::Double
        || problem.validation_profile.execution_mode != ExecutionMode::Strict
        || crate::util::runtime_device_request(problem) != Some("cpu") {
        return Err(fail("retained-current H-only requires explicit FEM CPU/strict/double; auto and GPU cannot fall back"));
    }
    let stage = problem.antenna_field_solve_stages.iter().find(|stage| stage.id == stage_id)
        .ok_or_else(|| fail(format!("retained-current field stage '{stage_id}' does not exist")))?;
    if stage.retained_current_source.is_none()
        || stage.retained_source_preparation.is_some()
        || stage.conservative_current_view_ref.is_some()
        || stage.port_mode_ids != [port_mode_id.to_owned()]
        || stage.oersted_realization != AntennaOerstedRealizationIR::AnalyticRt0Surface
        || stage.surface_field_policy.is_none()
        || stage.outputs.len() != 1 || stage.outputs[0].quantity != "H_ant_basis" {
        return Err(fail("retained-current H-only requires its typed source, exact single port/output and explicit analytic_rt0_surface policy"));
    }
    // This is solely the newly authored H carrier. Never rebuild the source mesh as proof of J.
    let field_sampling = resolve_field_sampling(problem, &stage.field_sampling_domain)?;
    Ok(AntennaRetainedCurrentFieldPlanIR {
        schema_version: ANTENNA_RETAINED_CURRENT_FIELD_PLAN_SCHEMA.into(),
        stage: stage.clone(), field_sampling,
        requested_execution: RequestedTransportExecutionIR {
            discretization: problem.backend_policy.requested_backend,
            device: ExecutionDevice::Cpu,
            precision: problem.backend_policy.execution_precision,
            execution_mode: problem.validation_profile.execution_mode,
        },
    })
}

#[cfg(test)]
mod tests;
