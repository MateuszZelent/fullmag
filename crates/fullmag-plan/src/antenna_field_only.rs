//! Static antenna session planning without magnetic placeholders.
use fullmag_ir::{AntennaFieldOnlyPlanIR, BackendPlanIR, BackendTarget, CommonPlanMeta,
    ExecutionPlanIR, OutputPlanIR, ProblemIR, ProvenancePlanIR, StudyIR};
use crate::{plan_antenna_field_solve_execution, AntennaFieldSolveExecutionPlan, PlanError};

pub fn plan_antenna_field_only_carrier(
    problem: &ProblemIR, stage_id: &str, port_mode_id: &str,
) -> Result<ExecutionPlanIR, PlanError> {
    if !matches!(problem.study, StudyIR::FieldOnly { .. }) {
        return Err(PlanError { reasons: vec!["field-only carrier requires StudyIR::FieldOnly".into()] });
    }
    crate::execution_profile_guard::validate_bound_intent(problem)
        .map_err(|reason| PlanError { reasons: vec![reason] })?;
    if let Some(resources) = fullmag_ir::ComputeResourcesIR::from_problem(problem)
        .map_err(|reason| PlanError { reasons: vec![reason] })?
    {
        crate::compute_resources::validate_current_runtime_support(&resources)
            .map_err(|reasons| PlanError { reasons })?;
    }
    let (source_mesh, source_object_segments, field_sampling, source_object_id) =
        match plan_antenna_field_solve_execution(problem, stage_id, port_mode_id)? {
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
