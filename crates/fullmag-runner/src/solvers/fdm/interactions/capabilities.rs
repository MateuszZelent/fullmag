//! FDM interaction capability rejection rules.

use fullmag_ir::{FdmPlanIR, OutputIR};

pub(crate) fn unsupported_cpu_fdm_terms(
    plan: &FdmPlanIR,
    outputs: &[OutputIR],
) -> Vec<&'static str> {
    let mut unsupported = Vec::new();
    if plan.has_oersted_cylinder {
        unsupported.push("oersted");
    }
    if !plan.fdm_gpu_charge_transports.is_empty() {
        unsupported.push("gpu_charge_transport");
    }
    if plan.boundary_geometry.is_some() || plan.boundary_correction.is_some() {
        unsupported.push("boundary_correction");
    }
    // Fields available in CPU FDM snapshots: m, H_ex, H_demag, H_ext, H_ani, H_dmi, H_eff.
    // H_ant is not exposed as a separate observable by the reference engine.
    if outputs.iter().any(|output| match output {
        OutputIR::Field { name, .. }
        | OutputIR::FieldResolvedAuto { name, .. }
        | OutputIR::Scalar { name, .. }
        | OutputIR::ScalarResolvedAuto { name, .. } => {
            matches!(
                name.as_str(),
                "H_mel" | "u" | "u_dot" | "eps" | "sigma" | "E_mel" | "E_el" | "E_kin_el"
            )
        }
        OutputIR::Snapshot { field, .. } => {
            matches!(
                field.as_str(),
                "H_mel" | "u" | "u_dot" | "eps" | "sigma" | "H_ant"
            )
        }
        _ => false,
    }) {
        unsupported.push("unsupported_outputs");
    }
    unsupported.sort_unstable();
    unsupported.dedup();
    unsupported
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        BackendTarget, ChargePotentialGaugeIR, ChargeSolverPolicyIR, ExecutionDevice,
        ExecutionMode, ExecutionPrecision, LinearTransportSolverPolicyIR,
        RequestedTransportExecutionIR, ResolvedFdmGpuChargeTransportIR,
    };

    #[test]
    fn public_gpu_charge_plan_is_an_unsupported_cpu_fdm_term() {
        let mut plan = FdmPlanIR::default();
        plan.fdm_gpu_charge_transports = vec![ResolvedFdmGpuChargeTransportIR {
            descriptor_schema: "fdm_gpu_charge_transport.v1".into(),
            descriptor_revision: 1,
            source_revision: 1,
            implementation_version: "fdm_gpu_charge_transport_v1".into(),
            validation_state: "semantic_only".into(),
            descriptor_sha256: "test".into(),
            module_id: "charge".into(),
            requested_execution: RequestedTransportExecutionIR {
                discretization: BackendTarget::Fdm,
                device: ExecutionDevice::Gpu,
                precision: ExecutionPrecision::Double,
                execution_mode: ExecutionMode::Strict,
            },
            resolved_discretization: BackendTarget::Fdm,
            resolved_device: ExecutionDevice::Gpu,
            resolved_precision: ExecutionPrecision::Double,
            resolved_execution_mode: ExecutionMode::Strict,
            capabilities: vec![],
            charge_active_cells: vec![],
            charge_conductivity_spm: vec![],
            charge_boundaries: vec![],
            charge_gauge: ChargePotentialGaugeIR::DirichletReference,
            charge_solver: ChargeSolverPolicyIR {
                engine: "cg".into(),
                linear: LinearTransportSolverPolicyIR {
                    relative_tolerance: 1.0e-10,
                    absolute_tolerance: 0.0,
                    max_iterations: 1000,
                },
                physical_residual_version: "charge_balance_integrated_l2.v1".into(),
                operator_version: "fv_charge_harmonic_v1".into(),
            },
            region_ids: vec![],
        }];

        assert_eq!(
            unsupported_cpu_fdm_terms(&plan, &[]),
            vec!["gpu_charge_transport"]
        );
    }
}
