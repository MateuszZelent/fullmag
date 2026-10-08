//! Explicit inspection producer; the dedicated stage owns artifact publication.
use super::{require, revalidate_materialized_input, AntennaExternalLeadSolutionArtifact};
use crate::RunError;
use fullmag_ir::{RequestedTransportExecutionIR, ResolvedAntennaExternalLeadCurrentInputIR};
use std::sync::atomic::{AtomicBool, Ordering};

fn check_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), RunError> {
    require(
        !cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)),
        "inspection cancelled; native solve is non-preemptive and no artifact is published",
    )
}

/// One native modeled-domain bundle; cancellation is checked around the non-preemptive solve.
pub fn execute_antenna_external_lead_inspection(
    input: &ResolvedAntennaExternalLeadCurrentInputIR,
    requested_execution: &RequestedTransportExecutionIR,
    output_id: &str,
    cancelled: Option<&AtomicBool>,
) -> Result<AntennaExternalLeadSolutionArtifact, RunError> {
    check_cancelled(cancelled)?;
    revalidate_materialized_input(input, requested_execution, output_id)?;
    check_cancelled(cancelled)?;
    execute_revalidated(input, requested_execution, output_id, cancelled)
}

#[cfg(any(feature = "fem-native", feature = "fem-gpu"))]
fn execute_revalidated(
    input: &ResolvedAntennaExternalLeadCurrentInputIR,
    requested_execution: &RequestedTransportExecutionIR,
    output_id: &str,
    cancelled: Option<&AtomicBool>,
) -> Result<AntennaExternalLeadSolutionArtifact, RunError> {
    use crate::native_fem::accepted_external_lead::{
        solve_accepted_external_lead_field, with_materialized_external_lead_request,
    };
    let solved = with_materialized_external_lead_request(input, |request| {
        check_cancelled(cancelled)?;
        solve_accepted_external_lead_field(request)
    });
    check_cancelled(cancelled)?;
    let bundle = solved?;
    let artifact = super::build_bound_solution(input, requested_execution, output_id, bundle)?;
    // Also suppress handoff if cancellation arrived during derived payload verification.
    check_cancelled(cancelled)?;
    Ok(artifact)
}

#[cfg(not(any(feature = "fem-native", feature = "fem-gpu")))]
fn execute_revalidated(
    _input: &ResolvedAntennaExternalLeadCurrentInputIR,
    _requested_execution: &RequestedTransportExecutionIR,
    _output_id: &str,
    cancelled: Option<&AtomicBool>,
) -> Result<AntennaExternalLeadSolutionArtifact, RunError> {
    check_cancelled(cancelled)?;
    Err(RunError {
        message: "antenna external lead inspection unavailable: native FEM feature is required; no legacy or CPU solver fallback".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{BackendTarget, ExecutionDevice, ExecutionMode, ExecutionPrecision};

    #[test]
    fn preset_cancel_is_explicit_without_any_native_call() {
        let flag = AtomicBool::new(true);
        assert!(check_cancelled(Some(&flag))
            .unwrap_err()
            .message
            .contains("inspection cancelled"));
        flag.store(false, Ordering::Release);
        assert!(check_cancelled(Some(&flag)).is_ok());
        assert!(check_cancelled(None).is_ok());
    }

    #[test]
    fn inspection_execution_and_output_guards_refuse_fallback_and_unsafe_ids() {
        let mut requested = RequestedTransportExecutionIR {
            discretization: BackendTarget::Fem,
            device: ExecutionDevice::Cpu,
            precision: ExecutionPrecision::Double,
            execution_mode: ExecutionMode::Strict,
        };
        assert!(super::super::validate_execution(&requested).is_ok());
        requested.device = ExecutionDevice::Auto;
        assert!(super::super::validate_execution(&requested).is_ok());
        requested.device = ExecutionDevice::Gpu;
        assert!(super::super::validate_execution(&requested).is_err());
        requested.device = ExecutionDevice::Cpu;
        requested.precision = ExecutionPrecision::Single;
        assert!(super::super::validate_execution(&requested).is_err());
        requested.precision = ExecutionPrecision::Double;
        requested.execution_mode = ExecutionMode::Extended;
        assert!(super::super::validate_execution(&requested).is_err());
        requested.execution_mode = ExecutionMode::Strict;
        requested.discretization = BackendTarget::Fdm;
        assert!(super::super::validate_execution(&requested).is_err());
        assert!(!super::super::safe_output_id("../inspection"));
        assert!(!super::super::safe_output_id("CON"));
        assert!(super::super::safe_output_id("inspection-source"));
        let mut outputs = vec![fullmag_ir::AntennaNamedOutputIR {
            id: "inspection-source".into(),
            quantity: "H_ant_basis".into(),
        }];
        assert!(super::super::validate_stage_output(&outputs, "inspection-source").is_ok());
        assert!(super::super::validate_stage_output(&outputs, "undeclared").is_err());
        outputs[0].quantity = "H_ant".into();
        assert!(
            super::super::validate_stage_output(&outputs, "inspection-source")
                .unwrap_err()
                .message
                .contains("declared as H_ant_basis")
        );
        outputs[0].id = "../inspection".into();
        outputs[0].quantity = "H_ant_basis".into();
        assert!(super::super::validate_stage_output(&outputs, "../inspection").is_err());
    }
}
