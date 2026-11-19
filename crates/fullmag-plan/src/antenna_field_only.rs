//! Static antenna session planning without magnetic placeholders.
use fullmag_ir::{AntennaFieldOnlyPlanIR, BackendPlanIR, BackendTarget, CommonPlanMeta,
    ExecutionPlanIR, OutputPlanIR, ProblemIR, ProvenancePlanIR, StudyIR};
use crate::{plan_antenna_field_solve_execution, AntennaFieldSolveExecutionPlan, PlanError};

pub fn plan_antenna_field_only_carrier(
    problem: &ProblemIR, stage_id: &str, port_mode_id: &str,
) -> Result<ExecutionPlanIR, PlanError> {
    let typed_closed_loop = match &problem.study {
        StudyIR::FieldOnly { .. } => false,
        StudyIR::AntennaFieldSolve { selection: Some(selection), sampling }
            if selection.stage_id == stage_id && selection.port_mode_id == port_mode_id => {
                // Reuse the canonical nonmagnetic-state validator without changing
                // the typed selection retained in the planned input and identity.
                let mut nonmagnetic_validation = problem.clone();
                nonmagnetic_validation.study = StudyIR::FieldOnly { sampling: sampling.clone() };
                nonmagnetic_validation.validate().map_err(|reasons| PlanError { reasons })?;
                true
            }
        _ => return Err(PlanError { reasons: vec![
            "field-only carrier requires FieldOnly or an exactly selected nonmagnetic AntennaFieldSolve".into()
        ] }),
    };
    crate::execution_profile_guard::validate_bound_intent(problem)
        .map_err(|reason| PlanError { reasons: vec![reason] })?;
    if let Some(resources) = fullmag_ir::ComputeResourcesIR::from_problem(problem)
        .map_err(|reason| PlanError { reasons: vec![reason] })?
    {
        crate::compute_resources::validate_current_runtime_support(&resources)
            .map_err(|reasons| PlanError { reasons })?;
    }
    let operation = plan_antenna_field_solve_execution(problem, stage_id, port_mode_id)?;
    if typed_closed_loop && !matches!(&operation, AntennaFieldSolveExecutionPlan::ClosedLoopInspection { .. }) {
        return Err(PlanError { reasons: vec!["typed field-only carrier requires a closed-loop inspection source".into()] });
    }
    let (source_mesh, source_object_segments, field_sampling, source_object_id) =
        match operation {
            AntennaFieldSolveExecutionPlan::ExternalLeadInspection { input, .. } => (
                input.original_device_mesh, input.device_object_segments, input.field_sampling,
                input.stage.source_object_id,
            ),
            AntennaFieldSolveExecutionPlan::ClosedLoopInspection {input,..} => (
                input.source_mesh, input.source_object_segments, input.field_sampling, input.stage.source_object_id,
            ),
            AntennaFieldSolveExecutionPlan::FieldBasis(plan) => (
                plan.conductor.mesh, plan.conductor.object_segments, plan.field_sampling,
                plan.source_object_id,
            ),
        };
    Ok(ExecutionPlanIR {
        common: CommonPlanMeta { ir_version: problem.ir_version.clone(),
            requested_backend: problem.backend_policy.requested_backend,
            resolved_backend: BackendTarget::Fem,
            execution_mode: problem.validation_profile.execution_mode,
            material_field_plans: vec![],
        },
        backend_plan: BackendPlanIR::AntennaFieldOnly(AntennaFieldOnlyPlanIR {
            schema_version: "antenna_field_only_plan.v1".into(),
            stage_id: stage_id.into(), port_mode_id: port_mode_id.into(), source_object_id,
            source_mesh_parts: crate::mesh::build_conductor_mesh_parts_from_segments(&source_mesh, &source_object_segments),
            source_mesh, source_object_segments, field_sampling,
        }),
        output_plan: OutputPlanIR { outputs: vec![] },
        provenance: ProvenancePlanIR {
            notes: vec!["antenna_field_only_carrier:no_magnetic_dofs:no_llg_execution".into()],
            integrator_resolution: None, physics_graph: None, fem_eigen_execution_resolution: None,
        },
    })
}
