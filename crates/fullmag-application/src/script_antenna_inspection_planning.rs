//! Replan the exact typed inspection action, independently of authored node IDs.
use anyhow::{bail, Context, Result};
use fullmag_ir::{
    BackendPlanIR, ExecutionPlanIR, ProblemIR, RequestedTransportExecutionIR,
    ResolvedAntennaExternalLeadCurrentInputIR,
};

/// Resolve against the current immutable snapshot and reject stale action data.
/// This authorizes raw inspection only, never a reusable per-ampere field basis.
pub fn plan_script_antenna_inspection(
    problem: &ProblemIR,
    input: &ResolvedAntennaExternalLeadCurrentInputIR,
    requested: &RequestedTransportExecutionIR,
    output: &str,
) -> Result<ExecutionPlanIR> {
    let plan = fullmag_plan::plan_antenna_external_lead_inspection(
        problem,
        &input.stage.id,
        &input.port.id,
    )
    .context("re-resolving external-lead inspection before execution planning")?;
    match &plan.backend_plan {
        BackendPlanIR::AntennaExternalLeadInspection(resolved)
            if &resolved.input == input
                && &resolved.requested_execution == requested
                && resolved.output_id == output => Ok(plan),
        _ => bail!("external-lead inspection plan differs from the actual selected input, execution or output"),
    }
}

#[cfg(test)]
#[path = "script_antenna_inspection_planning_tests.rs"]
mod tests;
