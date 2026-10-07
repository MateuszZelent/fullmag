use anyhow::{anyhow, Result};
use fullmag_ir::{ExecutionPlanIR, ProblemIR};

use crate::live_workspace::LocalLiveWorkspace;

/// Load and project immutable antenna assets before a consumer is published.
/// This reuses the execution boundary; it never runs a conductor solve.
pub(crate) fn materialize_antenna_consumer_plan(
    problem: &ProblemIR,
    plan: &mut ExecutionPlanIR,
    workspace: &LocalLiveWorkspace,
) -> Result<()> {
    if !crate::orchestrator::prepare_solved_antenna_drive_activation(problem, plan)? {
        return Ok(());
    }
    let artifact_dir = workspace.current_artifact_dir()?;
    crate::orchestrator::attach_solved_antenna_drive_bases(problem, plan, &artifact_dir)?;
    Ok(())
}

/// Plan this exact observation problem without changing activation or clocks.
pub(crate) fn plan_antenna_observation(
    problem: &ProblemIR,
    workspace: &LocalLiveWorkspace,
) -> Result<ExecutionPlanIR> {
    let mut plan = fullmag_plan::plan(problem).map_err(|error| anyhow!(error.to_string()))?;
    materialize_antenna_consumer_plan(problem, &mut plan, workspace)?;
    Ok(plan)
}
