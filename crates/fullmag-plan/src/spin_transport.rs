use fullmag_ir::{
    BackendTarget, ExecutionDevice, ExecutionPrecision, ProblemIR, ResolvedSpinTransportPlanIR,
    TransportCouplingIR,
};

use crate::PlanError;

pub(crate) fn resolve_m1_spin_transport(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
) -> Result<Vec<ResolvedSpinTransportPlanIR>, PlanError> {
    let mut plans = Vec::with_capacity(problem.spin_transport_modules.len());
    let mut errors = Vec::new();
    for module in &problem.spin_transport_modules {
        let requested = &module.requested_execution;
        if !matches!(
            requested.discretization,
            BackendTarget::Fdm | BackendTarget::Auto
        ) || resolved_backend != BackendTarget::Fdm
        {
            errors.push(format!("spin transport '{}' is unsupported on FEM; M1 currently supports FDM CPU double only", module.id));
        }
        if !matches!(
            requested.device,
            ExecutionDevice::Cpu | ExecutionDevice::Auto
        ) {
            errors.push(format!("spin transport '{}' requested GPU, but M1 GPU transport is unavailable and cannot fall back silently", module.id));
        }
        if requested.precision != ExecutionPrecision::Double {
            errors.push(format!(
                "spin transport '{}' requested single precision, but M1 supports double only",
                module.id
            ));
        }
        if problem.backend_policy.execution_precision != ExecutionPrecision::Double {
            errors.push(format!(
                "spin transport '{}' requires the enclosing execution precision to be double",
                module.id
            ));
        }
        let coupling = problem
            .current_modules
            .iter()
            .find_map(|source| match source {
                fullmag_ir::CurrentModuleIR::CurrentTransport { name, coupling, .. }
                    if name == &module.current_source_id =>
                {
                    Some(*coupling)
                }
                _ => None,
            })
            .unwrap_or(TransportCouplingIR::OneWay);
        plans.push(ResolvedSpinTransportPlanIR {
            module_id: module.id.clone(),
            current_source_id: module.current_source_id.clone(),
            resolved_coupling: coupling,
            requested_execution: requested.clone(),
            resolved_discretization: BackendTarget::Fdm,
            resolved_device: ExecutionDevice::Cpu,
            resolved_precision: ExecutionPrecision::Double,
            constitutive_version: module.constitutive_version.clone(),
            operator_version: module.solver.operator_version.clone(),
            physical_residual_version: module.solver.physical_residual_version.clone(),
            capabilities: vec![
                "transport.charge.ohmic".to_string(),
                "transport.spin.steady_drift_diffusion".to_string(),
                "transport.spin.direct_she".to_string(),
                "transport.coupling.one_way".to_string(),
            ],
            inserted_default_boundaries: if module.boundaries.is_empty()
                && module.solver.default_external_boundary == "spin_insulating"
            {
                vec!["all_unassigned_external_surfaces".to_string()]
            } else {
                Vec::new()
            },
        });
    }
    if errors.is_empty() {
        Ok(plans)
    } else {
        Err(PlanError { reasons: errors })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::*;

    fn problem(device: ExecutionDevice) -> ProblemIR {
        let mut problem = ProblemIR::bootstrap_example();
        problem.current_modules = vec![CurrentModuleIR::CurrentTransport {
            name: "charge".into(),
            model: CurrentTransportModelIR::OhmicPoisson,
            current_density: None,
            solve_region: Some("strip".into()),
            conductivity_s_per_m: Some(4.0e6),
            coupling: TransportCouplingIR::OneWay,
        }];
        problem.spin_transport_modules = vec![SpinTransportModuleIR {
            schema_version: "spin_transport.v1".into(),
            id: "spin".into(),
            current_source_id: "charge".into(),
            mode: SpinTransportModeIR::Steady,
            domain: vec![RegionRefIR {
                object_id: "strip".into(),
                region_id: None,
            }],
            materials: vec![SpinTransportMaterialAssignmentIR {
                region: RegionRefIR {
                    object_id: "strip".into(),
                    region_id: None,
                },
                material: SpinTransportMaterialIR {
                    sigma_s_spm: 5.0e6,
                    polarization_p: 0.4,
                    theta_sh: 0.1,
                    lambda_sf_m: 5.0e-9,
                    lambda_j_m: ReactionLengthIR::Enabled(1.0e-9),
                    lambda_phi_m: ReactionLengthIR::Disabled(DisabledReactionIR::Disabled),
                },
            }],
            interfaces: vec![],
            boundaries: vec![],
            solver: SpinSolverPolicyIR {
                engine: "auto".into(),
                linear: LinearTransportSolverPolicyIR {
                    relative_tolerance: 1.0e-8,
                    absolute_tolerance: 0.0,
                    max_iterations: 500,
                },
                physical_residual_version: "transport_balance_integrated_l2.v1".into(),
                operator_version: "fv_spin_upwind_v1".into(),
                default_external_boundary: "spin_insulating".into(),
            },
            requested_execution: RequestedTransportExecutionIR {
                discretization: BackendTarget::Fdm,
                device,
                precision: ExecutionPrecision::Double,
                execution_mode: ExecutionMode::Strict,
            },
            constitutive_version: "transport_constitutive.one_way.fullmag.v1".into(),
        }];
        problem
    }

    #[test]
    fn resolves_only_fdm_cpu_double_and_preserves_requested_intent() {
        let plans = resolve_m1_spin_transport(&problem(ExecutionDevice::Cpu), BackendTarget::Fdm)
            .expect("M1 CPU plan");
        assert_eq!(plans[0].requested_execution.device, ExecutionDevice::Cpu);
        assert_eq!(plans[0].resolved_device, ExecutionDevice::Cpu);
        assert_eq!(plans[0].resolved_coupling, TransportCouplingIR::OneWay);
        assert!(plans[0]
            .capabilities
            .contains(&"transport.spin.direct_she".to_string()));
        assert_eq!(
            plans[0].inserted_default_boundaries,
            ["all_unassigned_external_surfaces"]
        );
    }

    #[test]
    fn forced_gpu_fails_closed() {
        let error = resolve_m1_spin_transport(&problem(ExecutionDevice::Gpu), BackendTarget::Fdm)
            .expect_err("GPU must not silently fall back");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("cannot fall back silently")));
    }
}
