//! Explicit input-asset H-only intent. This module performs no source preparation or store reads.
use crate::PlanError;
use fullmag_ir::{AntennaRetainedPreparationFieldPlanIR, BackendTarget, ExecutionDevice,
    ExecutionMode, ExecutionPrecision, ProblemIR, RequestedTransportExecutionIR, StudyIR};
fn fail(reason: impl Into<String>) -> PlanError { PlanError { reasons: vec![reason.into()] } }

pub fn plan_retained_preparation_field_inspection(
    problem: &ProblemIR, stage_id: &str, port_mode_id: &str,
) -> Result<AntennaRetainedPreparationFieldPlanIR, PlanError> {
    problem.validate().map_err(|reasons| PlanError { reasons })?;
    match &problem.study {
        StudyIR::FieldOnly { .. } => {},
        StudyIR::AntennaFieldSolve { selection: Some(selection), sampling }
            if selection.stage_id == stage_id && selection.port_mode_id == port_mode_id => {
                let mut nonmagnetic_validation = problem.clone();
                nonmagnetic_validation.study = StudyIR::FieldOnly { sampling: sampling.clone() };
                nonmagnetic_validation.validate().map_err(|reasons| PlanError { reasons })?;
            },
        _ => return Err(fail("retained preparation requires an exactly selected static H-only study")),
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
        return Err(fail("retained preparation requires explicit FEM CPU strict double without fallback"));
    }
    let stage = problem.antenna_field_solve_stages.iter().find(|stage| stage.id == stage_id)
        .ok_or_else(|| fail("retained preparation stage is absent"))?;
    let preparation_asset = stage.retained_source_preparation.as_ref()
        .ok_or_else(|| fail("retained preparation stage has no explicit input asset"))?;
    if stage.retained_current_source.is_none() || stage.conservative_current_view_ref.is_some()
        || stage.port_mode_ids != [port_mode_id.to_owned()]
        || stage.oersted_realization != fullmag_ir::AntennaOerstedRealizationIR::AnalyticRt0Surface
        || stage.surface_field_policy.is_none() || stage.outputs.len() != 1
        || stage.outputs[0].quantity != "H_ant_basis" {
        return Err(fail("retained preparation requires its exact historical source, surface policy and one H-only output"));
    }
    let source = problem.current_modules.iter().find_map(|module| match module {
        fullmag_ir::CurrentModuleIR::CurrentTransport { name, definition: Some(definition), .. }
            if name == &stage.current_transport_id => match &definition.conservative_current_source {
                Some(fullmag_ir::ConservativeCurrentSourceIR::RetainedPreparationAsset(source)) => Some(source),
                _ => None,
            },
        _ => None,
    }).ok_or_else(|| fail("retained preparation has no matching typed source declaration"))?;
    let assets = problem.geometry_assets.as_ref().ok_or_else(|| fail("frozen source mesh assets are absent"))?;
    let meshes = assets.fem_mesh_assets.iter().filter(|asset| asset.geometry_name == source.geometry_id).collect::<Vec<_>>();
    if meshes.len() != 1 || meshes[0].mesh_source.is_some() {
        return Err(fail("retained preparation requires one explicit inline frozen conductor mesh"));
    }
    let mesh = meshes[0].mesh.as_ref().ok_or_else(|| fail("frozen conductor mesh is absent"))?;
    mesh.cells.require_tet4().map_err(fail)?;
    if mesh.nodes.len() != source.historical_prepared_source.stable_vertex_ids.len()
        || mesh.mixed_topology_fingerprint_v3().map_err(fail)? != source.historical_prepared_source.mesh_digest {
        return Err(fail("frozen conductor carrier differs from the historical source declaration"));
    }
    let field_sampling = crate::antenna_field_solve::resolve_field_sampling(problem, &stage.field_sampling_domain)?;
    Ok(AntennaRetainedPreparationFieldPlanIR {
        schema_version: fullmag_ir::ANTENNA_RETAINED_PREPARATION_FIELD_PLAN_SCHEMA.into(),
        stage: stage.clone(), field_sampling,
        requested_execution: RequestedTransportExecutionIR { discretization: BackendTarget::Fem,
            device: ExecutionDevice::Cpu, precision: ExecutionPrecision::Double, execution_mode: ExecutionMode::Strict },
        preparation_asset: preparation_asset.clone(),
    })
}

#[cfg(test)]
mod tests;
