//! Dedicated inspection planning, without synthetic magnetization or dynamics.
use anyhow::{bail, Context, Result};
use fullmag_ir::{
    ExecutionPlanIR, ProblemIR, RequestedTransportExecutionIR,
    ResolvedAntennaExternalLeadCurrentInputIR, ResolvedAntennaClosedLoopCurrentInputIR, StudyIR,
};
use fullmag_plan::{plan_antenna_field_solve_execution, AntennaFieldSolveExecutionPlan};

pub(crate) fn plan_carrier(
    problem: &ProblemIR,
    input: &ResolvedAntennaExternalLeadCurrentInputIR,
    requested: &RequestedTransportExecutionIR,
    output: &str,
) -> Result<ExecutionPlanIR> {
    fullmag_application::plan_script_antenna_inspection(problem, input, requested, output)
}

pub(crate) fn plan_closed_loop_carrier(
    problem: &ProblemIR,
    input: &ResolvedAntennaClosedLoopCurrentInputIR,
    requested: &RequestedTransportExecutionIR,
    output: &str,
) -> Result<ExecutionPlanIR> {
    // Resolve the actual authored source before selecting a static read carrier.
    match plan_antenna_field_solve_execution(problem, &input.stage.id, &input.port.id)
        .context("re-resolving closed-loop inspection before carrier planning")?
    {
        AntennaFieldSolveExecutionPlan::ClosedLoopInspection {
            input: resolved,
            requested_execution,
            output_id,
        } if &resolved == input && &requested_execution == requested && output_id == output => {}
        _ => bail!("closed-loop inspection carrier differs from the actual selected input, execution or output"),
    }
    let mut carrier = problem.clone();
    carrier.study = StudyIR::FieldOnly { sampling: problem.study.sampling().clone() };
    let mut plan = fullmag_plan::plan_antenna_field_only_carrier(&carrier, &input.stage.id, &input.port.id)
        .context("planning closed-loop inspection without magnetic state")?;
    plan.provenance.notes.push("antenna_closed_loop_inspection_carrier_only:no_llg_execution".into());
    plan.provenance.notes.push("inspection carrier has no solver realization; dedicated source realization is FEM CPU/double, requested execution remains separate".into());
    Ok(plan)
}

#[cfg(test)]
mod tests {
    #[test]
    fn inspection_session_planning_has_no_magnetic_scaffold() {
        let source = include_str!("carrier.rs");
        let implementation = source.split("#[cfg(test)]").next().unwrap();
        assert!(!implementation.contains("initial_magnetization"));
        assert!(!implementation.contains("StudyIR::TimeEvolution"));
        assert!(!implementation.contains("EnergyTermIR::Zeeman"));
        assert!(implementation.contains("fullmag_application::plan_script_antenna_inspection(problem, input, requested, output)"));
    }
}
