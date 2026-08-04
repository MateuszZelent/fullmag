use super::{
    NativeFemSteadyTransportConstitutiveModel, NativeFemSteadyTransportExecution,
    NativeFemSteadyTransportGauge, NativeFemSteadyTransportInterface,
    NativeFemSteadyTransportRequest, CONSTITUTIVE_VERSION, M2_CONSTITUTIVE_VERSION,
    M2_OPERATOR_VERSION, OPERATOR_VERSION, PHYSICAL_RESIDUAL_VERSION,
};
use crate::types::{RunError, TransportExecutionProvenance};
use fullmag_ir::{CurrentModuleIR, FemPlanIR, ResolvedSpinTransportPlanIR};
use std::collections::BTreeSet;

pub(super) struct PreparedTransportPlan<'a> {
    pub resolved: &'a ResolvedSpinTransportPlanIR,
    pub request: NativeFemSteadyTransportRequest,
    pub provenance: TransportExecutionProvenance,
}

pub(super) fn preflight_transport_plans(
    plan: &FemPlanIR,
) -> Result<Vec<PreparedTransportPlan<'_>>, RunError> {
    if plan.spin_transport_plans.len() > 1 {
        return Err(RunError {
            message: "FEM M1 steady transport supports exactly one module because v2 field resource identity is quantity-scoped; refusing artifact overwrite".into(),
        });
    }
    if plan
        .mfem_device_string
        .as_deref()
        .is_some_and(|device| device != "cpu")
    {
        return Err(RunError {
            message: "FEM M1 steady transport resolved CPU but the enclosing plan requests a non-CPU MFEM device; refusing hidden fallback before provenance".into(),
        });
    }
    let mut module_ids = BTreeSet::new();
    let mut source_ids = BTreeSet::new();
    let mut prepared = Vec::with_capacity(plan.spin_transport_plans.len());
    for resolved in &plan.spin_transport_plans {
        if !module_ids.insert(resolved.module_id.as_str()) {
            return Err(RunError {
                message: format!(
                    "duplicate FEM spin transport module id '{}' fails whole-plan preflight",
                    resolved.module_id
                ),
            });
        }
        if !source_ids.insert(resolved.current_source_id.as_str()) {
            return Err(RunError {
                message: format!(
                    "FEM spin transport current source '{}' is bound more than once",
                    resolved.current_source_id
                ),
            });
        }
        validate_bound_current_source_modules(&plan.current_modules, resolved)?;
        let request = materialize_native_fem_steady_transport_request(
            &plan.mesh,
            &plan.initial_magnetization,
            resolved,
        )?;
        super::preflight(&request)?;
        let provenance = super::provenance::transport_provenance(resolved)?;
        prepared.push(PreparedTransportPlan {
            resolved,
            request,
            provenance,
        });
    }
    Ok(prepared)
}

pub(super) fn validate_bound_current_source_modules(
    current_modules: &[CurrentModuleIR],
    resolved: &ResolvedSpinTransportPlanIR,
) -> Result<(), RunError> {
    let matches = current_modules
        .iter()
        .filter_map(|source| match source {
            CurrentModuleIR::CurrentTransport {
                name,
                model,
                current_density,
                solve_region,
                conductivity_s_per_m,
                coupling,
                definition,
            } if name == &resolved.current_source_id => Some((
                model,
                current_density,
                solve_region,
                conductivity_s_per_m,
                coupling,
                definition,
            )),
            _ => None,
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(RunError {
            message: format!(
                "FEM spin transport '{}' requires exactly one canonical current source '{}', found {}",
                resolved.module_id,
                resolved.current_source_id,
                matches.len()
            ),
        });
    }
    let (model, current_density, solve_region, conductivity, coupling, definition) = matches[0];
    let descriptor = resolved.fem_cpu_double.as_ref().ok_or_else(|| RunError {
        message: format!(
            "FEM spin transport '{}' lacks fem_cpu_double descriptor",
            resolved.module_id
        ),
    })?;
    let reciprocal = resolved.resolved_coupling == fullmag_ir::TransportCouplingIR::Bidirectional;
    let expected_model = if reciprocal {
        fullmag_ir::CurrentTransportModelIR::MagnetoresistivePoisson
    } else {
        fullmag_ir::CurrentTransportModelIR::OhmicPoisson
    };
    if *model != expected_model
        || *coupling != resolved.resolved_coupling
        || current_density.is_some()
        || solve_region.is_some()
        || conductivity.is_some()
        || definition.as_ref() != Some(&descriptor.charge_definition)
    {
        return Err(RunError {
            message: format!(
                "FEM spin transport '{}' canonical current source '{}' contradicts its resolved descriptor",
                resolved.module_id, resolved.current_source_id
            ),
        });
    }
    Ok(())
}

pub(super) fn materialize_native_fem_steady_transport_request(
    mesh: &fullmag_ir::MeshIR,
    initial_magnetization: &[[f64; 3]],
    resolved: &ResolvedSpinTransportPlanIR,
) -> Result<NativeFemSteadyTransportRequest, RunError> {
    let descriptor = resolved.fem_cpu_double.as_ref().ok_or_else(|| RunError {
        message: format!(
            "FEM spin transport '{}' lacks fem_cpu_double descriptor",
            resolved.module_id
        ),
    })?;
    if resolved_fem_descriptor_contradiction(mesh, resolved, descriptor) {
        return Err(RunError {
            message: format!(
                "FEM spin transport '{}' has an unsupported or contradictory resolved descriptor",
                resolved.module_id
            ),
        });
    }
    let reciprocal = resolved.resolved_coupling == fullmag_ir::TransportCouplingIR::Bidirectional;
    let (constitutive_model, constitutive_version, operator_version) = if reciprocal {
        (
            NativeFemSteadyTransportConstitutiveModel::ReciprocalM2,
            M2_CONSTITUTIVE_VERSION,
            M2_OPERATOR_VERSION,
        )
    } else {
        (
            NativeFemSteadyTransportConstitutiveModel::OneWay,
            CONSTITUTIVE_VERSION,
            OPERATOR_VERSION,
        )
    };
    let reciprocal_material = descriptor.reciprocal_material.as_ref();
    Ok(NativeFemSteadyTransportRequest {
        mesh: mesh.clone(),
        execution: NativeFemSteadyTransportExecution::CpuDouble,
        interface: NativeFemSteadyTransportInterface::TransparentConformingH1,
        gauge: match descriptor.charge_gauge {
            fullmag_ir::ChargePotentialGaugeIR::DirichletReference => {
                NativeFemSteadyTransportGauge::BoundaryReference
            }
            fullmag_ir::ChargePotentialGaugeIR::ZeroMean => {
                NativeFemSteadyTransportGauge::ZeroMeanPotential
            }
        },
        constitutive_model,
        constitutive_version: constitutive_version.to_string(),
        operator_version: operator_version.to_string(),
        physical_residual_version: resolved.physical_residual_version.clone(),
        charge_conductivity_spm_per_element: descriptor.charge_conductivity_spm_per_element.clone(),
        magnetization: initial_magnetization.to_vec(),
        sigma_s_spm: descriptor.sigma_s_spm,
        sigma_parallel_spm: reciprocal_material.map(|material| material.sigma_parallel_spm),
        sigma_perpendicular_spm:
            reciprocal_material.map(|material| material.sigma_perpendicular_spm),
        sigma_ahe_spm: reciprocal_material.map(|material| material.sigma_ahe_spm),
        polarization_p: descriptor.polarization_p,
        theta_sh: descriptor.theta_sh,
        lambda_sf_m: descriptor.lambda_sf_m,
        lambda_j_m: descriptor.lambda_j_m,
        lambda_phi_m: descriptor.lambda_phi_m,
        gamma_e_per_ts: descriptor.gamma_e_rad_per_s_t,
        saturation_magnetization_apm: descriptor.saturation_magnetization_apm,
        relative_tolerance: descriptor.charge_solver.linear.relative_tolerance,
        absolute_tolerance: descriptor.charge_solver.linear.absolute_tolerance,
        maximum_iterations: descriptor.charge_solver.linear.max_iterations,
        charge_dirichlet: descriptor.charge_dirichlet.clone(),
        spin_dirichlet: descriptor.spin_dirichlet.clone(),
    })
}

fn resolved_fem_descriptor_contradiction(
    mesh: &fullmag_ir::MeshIR,
    resolved: &ResolvedSpinTransportPlanIR,
    descriptor: &fullmag_ir::ResolvedFemSpinTransportIR,
) -> bool {
    let reciprocal = resolved.resolved_coupling == fullmag_ir::TransportCouplingIR::Bidirectional;
    let expected_capabilities = if reciprocal {
        BTreeSet::from([
            "transport.charge.magnetoresistive",
            "transport.spin.steady_drift_diffusion",
            "transport.spin.direct_she",
            "transport.spin.inverse_she",
            "transport.coupling.bidirectional",
        ])
    } else {
        BTreeSet::from([
            "transport.charge.ohmic",
            "transport.spin.steady_drift_diffusion",
            "transport.spin.direct_she",
            "transport.coupling.one_way",
        ])
    };
    let expected_constitutive = if reciprocal {
        M2_CONSTITUTIVE_VERSION
    } else {
        CONSTITUTIVE_VERSION
    };
    let expected_operator = if reciprocal {
        M2_OPERATOR_VERSION
    } else {
        OPERATOR_VERSION
    };
    let expected_charge_operator = if reciprocal {
        M2_OPERATOR_VERSION
    } else {
        "fem_charge_conforming_h1_p1.transparent.v1"
    };
    let expected_schema = if reciprocal {
        "fullmag.fem.spin_transport_descriptor.m2.v1"
    } else {
        "fullmag.fem.spin_transport_descriptor.v1"
    };
    let expected_charge_engine = if reciprocal { "gmres" } else { "cg" };
    let expected_charge_solver_engine = if reciprocal {
        matches!(descriptor.charge_solver.engine.as_str(), "auto" | "block_gmres")
    } else {
        matches!(descriptor.charge_solver.engine.as_str(), "auto" | "cg")
    };
    let reciprocal_material_valid = match (reciprocal, descriptor.reciprocal_material.as_ref()) {
        (false, None) => true,
        (true, Some(material)) => {
            material.sigma_spm.is_finite()
                && material.sigma_spm > 0.0
                && material.sigma_spin_spm == descriptor.sigma_s_spm
                && material.polarization_p == descriptor.polarization_p
                && material.theta_sh == descriptor.theta_sh
                && material.sigma_parallel_spm.is_finite()
                && material.sigma_parallel_spm > 0.0
                && material.sigma_perpendicular_spm.is_finite()
                && material.sigma_perpendicular_spm > 0.0
                && material.sigma_ahe_spm.is_finite()
                && material.sigma_parallel_spm.min(material.sigma_perpendicular_spm)
                    * material.sigma_spin_spm
                    - material.polarization_p.powi(2) * material.sigma_spm.powi(2)
                    > 0.0
        }
        _ => false,
    };
    let capabilities = resolved
        .capabilities
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    resolved.fdm_cpu_double.is_some()
        || resolved.fdm_cpu_double_reciprocal.is_some()
        || resolved.requested_execution.execution_mode != fullmag_ir::ExecutionMode::Strict
        || !matches!(
            resolved.requested_execution.discretization,
            fullmag_ir::BackendTarget::Fem | fullmag_ir::BackendTarget::Auto
        )
        || !matches!(
            resolved.requested_execution.device,
            fullmag_ir::ExecutionDevice::Cpu | fullmag_ir::ExecutionDevice::Auto
        )
        || resolved.requested_execution.precision != fullmag_ir::ExecutionPrecision::Double
        || resolved.resolved_discretization != fullmag_ir::BackendTarget::Fem
        || resolved.resolved_device != fullmag_ir::ExecutionDevice::Cpu
        || resolved.resolved_precision != fullmag_ir::ExecutionPrecision::Double
        || resolved.constitutive_version != expected_constitutive
        || resolved.operator_version != expected_operator
        || resolved.physical_residual_version != PHYSICAL_RESIDUAL_VERSION
        || descriptor.descriptor_schema != expected_schema
        || descriptor.charge_definition.gauge != descriptor.charge_gauge
        || descriptor.charge_definition.solver != descriptor.charge_solver
        || descriptor.charge_definition.domain != descriptor.charge_domain.regions
        || descriptor.charge_conductivity_spm_per_element.len() != mesh.cell_count()
        || descriptor.charge_domain.element_mask.len() != mesh.cell_count()
        || descriptor.spin_domain.element_mask.len() != mesh.cell_count()
        || descriptor
            .charge_domain
            .element_mask
            .iter()
            .any(|selected| !selected)
        || descriptor
            .spin_domain
            .element_mask
            .iter()
            .any(|selected| !selected)
        || descriptor.torque_target.as_ref().is_some_and(|target| {
            target.element_mask.len() != mesh.cell_count()
                || !target.element_mask.iter().any(|selected| *selected)
        })
        || transport_boundary_attributes(descriptor)
            .any(|attribute| attribute == 0 || !mesh.boundary_markers.contains(&attribute))
        || descriptor.charge_solver.operator_version != expected_charge_operator
        || descriptor.charge_solver.physical_residual_version
            != if reciprocal {
                PHYSICAL_RESIDUAL_VERSION
            } else {
                "charge_balance_integrated_l2.v1"
            }
        || descriptor.spin_solver.operator_version != resolved.operator_version
        || descriptor.spin_solver.physical_residual_version != resolved.physical_residual_version
        || descriptor.charge_solver.linear != descriptor.spin_solver.linear
        || descriptor.charge_solver.linear.absolute_tolerance != 0.0
        || !expected_charge_solver_engine
        || !matches!(descriptor.spin_solver.engine.as_str(), "auto" | "gmres")
        || descriptor.resolved_charge_engine != expected_charge_engine
        || descriptor.resolved_spin_engine != "gmres"
        || descriptor.interface_law != "transparent"
        || descriptor
            .interfaces
            .iter()
            .any(|interface| interface.law != "transparent" || reciprocal)
        || descriptor.interface_realization != "transparent_conforming_h1"
        || descriptor.stage_coupling != "none"
        || descriptor.capability_status != "reference_executable"
        || descriptor.implementation_state != "executable"
        || descriptor.validation_state != "algebra_validated"
        || descriptor.validation_scope
            != if reciprocal {
                "fem_cpu_double_conforming_h1_p1_reciprocal_m2"
            } else {
                "fem_cpu_double_conforming_h1_p1_transparent_m1"
            }
        || (reciprocal && descriptor.spin_solver.reciprocal_nonlinear.is_some())
        || !reciprocal_material_valid
        || capabilities != expected_capabilities
}

fn transport_boundary_attributes(
    descriptor: &fullmag_ir::ResolvedFemSpinTransportIR,
) -> impl Iterator<Item = u32> + '_ {
    descriptor
        .charge_insulating_boundaries
        .iter()
        .chain(&descriptor.spin_insulating_boundaries)
        .flat_map(|set| set.boundary_attributes.iter().copied())
        .chain(
            descriptor
                .charge_dirichlet
                .iter()
                .map(|(attribute, _)| *attribute),
        )
        .chain(
            descriptor
                .spin_dirichlet
                .iter()
                .map(|(attribute, _)| *attribute),
        )
}
