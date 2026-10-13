//! Dedicated inspection planning, without synthetic magnetization or dynamics.
use anyhow::Result;
use fullmag_ir::{
    ExecutionPlanIR, ProblemIR, RequestedTransportExecutionIR,
    ResolvedAntennaExternalLeadCurrentInputIR,
};

pub(crate) fn plan_carrier(
    problem: &ProblemIR,
    input: &ResolvedAntennaExternalLeadCurrentInputIR,
    requested: &RequestedTransportExecutionIR,
    output: &str,
) -> Result<ExecutionPlanIR> {
    fullmag_application::plan_script_antenna_inspection(problem, input, requested, output)
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
