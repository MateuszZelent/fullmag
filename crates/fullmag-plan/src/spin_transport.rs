use std::collections::{BTreeMap, BTreeSet};

use fullmag_ir::{
    BackendTarget, ChargeBoundaryIR, ExecutionDevice, ExecutionPrecision, FemMeshPartIR,
    FemObjectSegmentIR, MeshIR, ProblemIR, ReactionLengthIR, RegionRefIR,
    ResolvedChargeBoundaryConditionIR, ResolvedChargeBoundaryFaceIR,
    ResolvedFdmCoupledSpinTransportIR, ResolvedFdmSpinTransportIR, ResolvedFemSpinTransportIR,
    ResolvedFdmTransientSpinTransportIR, ResolvedReciprocalMaterialIR,
    ResolvedSpinBoundaryConditionIR, ResolvedSpinBoundaryFaceIR, ResolvedSpinInterfaceFaceIR,
    ResolvedSpinInterfaceLawIR, ResolvedSpinReactionLengthsIR, ResolvedSpinTransportPlanIR,
    SpinBoundaryIR, SpinInterfaceIR, SpinTorqueModuleIR, StructuredBoundaryFaceIR,
    StructuredInternalFaceIR,
};
#[cfg(test)]
use fullmag_ir::{ChargePotentialGaugeIR, TransportCouplingIR};

use crate::surface_selectors::resolve_fem_surface_selector;
use crate::PlanError;

pub(crate) struct FdmSpinTransportResolutionContext<'a> {
    pub owner_names: &'a [&'a str],
    pub grid_cells: [u32; 3],
    pub active_mask: Option<&'a [bool]>,
    pub region_mask: &'a [u32],
    pub region_index_by_id: &'a BTreeMap<String, u32>,
    pub initial_magnetization: &'a [[f64; 3]],
    pub saturation_magnetization_apm: &'a [f64],
    /// Positive `gamma_0 = mu_0 |gamma_e|` in m/(A s).
    pub gamma0_m_per_a_s: f64,
}

pub(crate) fn resolve_spin_transport(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
    context: &FdmSpinTransportResolutionContext<'_>,
) -> Result<Vec<ResolvedSpinTransportPlanIR>, PlanError> {
    let mut plans = Vec::with_capacity(problem.spin_transport_modules.len());
    let mut errors = Vec::new();
    for module in &problem.spin_transport_modules {
        let transient = module.mode == fullmag_ir::SpinTransportModeIR::Transient;
        let requested = &module.requested_execution;
        if transient
            && (problem.validation_profile.execution_mode != fullmag_ir::ExecutionMode::Strict
                || requested.execution_mode != fullmag_ir::ExecutionMode::Strict)
        {
            errors.push(format!(
                "spin transport '{}' transient reference execution requires strict execution mode",
                module.id
            ));
        }
        if !matches!(
            requested.discretization,
            BackendTarget::Fdm | BackendTarget::Auto
        ) || resolved_backend != BackendTarget::Fdm
        {
            errors.push(if transient {
                format!(
                    "spin transport '{}' transient M3 reference execution supports FDM CPU double only",
                    module.id
                )
            } else {
                format!(
                    "spin transport '{}' is unsupported on FEM; steady M1/M2 currently supports FDM CPU double only",
                    module.id
                )
            });
        }
        if !matches!(
            requested.device,
            ExecutionDevice::Cpu | ExecutionDevice::Auto
        ) {
            errors.push(if transient {
                format!(
                    "spin transport '{}' requested GPU, but transient M3 reference execution supports CPU double only and cannot fall back silently",
                    module.id
                )
            } else {
                format!(
                    "spin transport '{}' requested GPU, but steady M1/M2 GPU transport is unavailable and cannot fall back silently",
                    module.id
                )
            });
        }
        if requested.precision != ExecutionPrecision::Double {
            errors.push(if transient {
                format!(
                    "spin transport '{}' requested single precision, but transient M3 reference execution supports double only",
                    module.id
                )
            } else {
                format!(
                    "spin transport '{}' requested single precision, but steady M1/M2 supports double only",
                    module.id
                )
            });
        }
        if problem.backend_policy.execution_precision != ExecutionPrecision::Double {
            errors.push(format!(
                "spin transport '{}' requires the enclosing execution precision to be double",
                module.id
            ));
        }
        let source = problem
            .current_modules
            .iter()
            .find_map(|source| match source {
                fullmag_ir::CurrentModuleIR::CurrentTransport {
                    name,
                    model,
                    coupling,
                    definition,
                    ..
                } if name == &module.current_source_id => {
                    Some((*model, *coupling, definition.as_ref()))
                }
                _ => None,
            });
        let Some((source_model, coupling, charge_definition)) = source else {
            errors.push(format!(
                "spin transport '{}' references missing current source '{}'",
                module.id, module.current_source_id
            ));
            continue;
        };
        let reciprocal = coupling == fullmag_ir::TransportCouplingIR::Bidirectional;
        let expected_model = if reciprocal {
            fullmag_ir::CurrentTransportModelIR::MagnetoresistivePoisson
        } else {
            fullmag_ir::CurrentTransportModelIR::OhmicPoisson
        };
        if source_model != expected_model {
            errors.push(format!(
                "spin transport '{}' current_source_id '{}' model is inconsistent with its coupling",
                module.id, module.current_source_id
            ));
            continue;
        }
        let Some(charge_definition) = charge_definition else {
            errors.push(format!(
                "spin transport '{}' current source lacks the complete charge contract",
                module.id
            ));
            continue;
        };
        let descriptor = materialize_fdm_descriptor(problem, module, charge_definition, context);
        let (fdm_cpu_double, fdm_cpu_double_reciprocal, fdm_cpu_double_transient) = match descriptor
        {
            Ok(_descriptor) if transient && reciprocal => {
                errors.push(format!(
                    "spin transport '{}' transient reciprocal M3 is not available in the FDM CPU v1 realization; fallback is forbidden",
                    module.id
                ));
                (None, None, None)
            }
            Ok(descriptor) if transient => {
                match materialize_transient_descriptor(module, context, descriptor) {
                    Ok(transient) => (None, None, Some(transient)),
                    Err(mut reasons) => {
                        errors.append(&mut reasons);
                        (None, None, None)
                    }
                }
            }
            Ok(descriptor) if reciprocal => {
                match materialize_m2_descriptor(module, charge_definition, context, descriptor) {
                    Ok(coupled) => (None, Some(coupled), None),
                    Err(mut reasons) => {
                        errors.append(&mut reasons);
                        (None, None, None)
                    }
                }
            }
            Ok(descriptor) => (Some(descriptor), None, None),
            Err(mut reasons) => {
                errors.append(&mut reasons);
                (None, None, None)
            }
        };
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
            capabilities: if transient {
                vec![
                    "transport.charge.ohmic".to_string(),
                    "transport.spin.transient_drift_diffusion".to_string(),
                    "transport.spin.direct_she".to_string(),
                    "transport.coupling.one_way".to_string(),
                ]
            } else if reciprocal {
                vec![
                    "transport.charge.magnetoresistive".to_string(),
                    "transport.spin.steady_drift_diffusion".to_string(),
                    "transport.spin.direct_she".to_string(),
                    "transport.spin.inverse_she".to_string(),
                    "transport.spin.mixing_conductance".to_string(),
                    "transport.coupling.bidirectional".to_string(),
                ]
            } else {
                vec![
                    "transport.charge.ohmic".to_string(),
                    "transport.spin.steady_drift_diffusion".to_string(),
                    "transport.spin.direct_she".to_string(),
                    "transport.coupling.one_way".to_string(),
                ]
            },
            inserted_default_boundaries: if module.boundaries.is_empty()
                && module.solver.default_external_boundary == "spin_insulating"
            {
                vec!["all_unassigned_external_surfaces".to_string()]
            } else {
                Vec::new()
            },
            fdm_cpu_double,
            fdm_cpu_double_reciprocal,
            fdm_cpu_double_transient,
            fem_cpu_double: None,
        });
    }
    if errors.is_empty() {
        Ok(plans)
    } else {
        Err(PlanError { reasons: errors })
    }
}

fn materialize_transient_descriptor(
    module: &fullmag_ir::SpinTransportModuleIR,
    context: &FdmSpinTransportResolutionContext<'_>,
    steady_operator: ResolvedFdmSpinTransportIR,
) -> Result<ResolvedFdmTransientSpinTransportIR, Vec<String>> {
    let count = steady_operator.spin_active_cells.len();
    let mut capacitance = vec![0.0; count];
    let mut formula_versions = vec![String::new(); count];
    let mut assigned = vec![false; count];
    for assignment in &module.materials {
        let value = assignment
            .material
            .spin_capacitance_as_per_v_m3
            .ok_or_else(|| {
                vec![format!(
                    "spin transport '{}' transient material is missing physical spin capacitance",
                    module.id
                )]
            })?;
        let formula_version = assignment
            .material
            .capacitance_formula_version
            .as_deref()
            .filter(|version| !version.trim().is_empty())
            .ok_or_else(|| {
                vec![format!(
                    "spin transport '{}' transient material is missing capacitance formula version",
                    module.id
                )]
            })?;
        let mask = resolve_region_mask(&assignment.region, context, "transient spin material")?;
        for cell in 0..count {
            if mask[cell] && steady_operator.spin_active_cells[cell] {
                if assigned[cell] {
                    return Err(vec![format!(
                        "spin transport '{}' has overlapping transient capacitance assignments at cell {cell}",
                        module.id
                    )]);
                }
                assigned[cell] = true;
                capacitance[cell] = value;
                formula_versions[cell] = formula_version.to_string();
            }
        }
    }
    require_complete_assignment(
        &steady_operator.spin_active_cells,
        &assigned,
        "transient spin capacitance",
    )?;
    Ok(ResolvedFdmTransientSpinTransportIR {
        descriptor_schema: "fullmag.fdm.transient_spin_transport_descriptor.v1".to_string(),
        steady_operator,
        spin_capacitance_as_per_v_m3: capacitance,
        capacitance_formula_versions: formula_versions,
        transient_formula_version: "transient_spin_balance.fullmag.v1".to_string(),
        integrator: fullmag_ir::CoupledSpinIntegratorIR::CoupledImexArk2,
        integrator_version: "coupled_imex_ark2.v1".to_string(),
    })
}

fn materialize_m2_descriptor(
    module: &fullmag_ir::SpinTransportModuleIR,
    charge: &fullmag_ir::ChargeTransportDefinitionIR,
    context: &FdmSpinTransportResolutionContext<'_>,
    base: ResolvedFdmSpinTransportIR,
) -> Result<ResolvedFdmCoupledSpinTransportIR, Vec<String>> {
    if base.charge_active_cells != base.spin_active_cells {
        return Err(vec![format!(
            "spin transport '{}' M2 requires identical charge and spin domains",
            module.id
        )]);
    }
    if charge.gauge != fullmag_ir::ChargePotentialGaugeIR::DirichletReference {
        return Err(vec![format!(
            "spin transport '{}' M2 CPU v1 requires a Dirichlet voltage reference",
            module.id
        )]);
    }
    if base.spin_boundaries.iter().any(|boundary| {
        matches!(
            boundary.condition,
            ResolvedSpinBoundaryConditionIR::PeriodicSpin
        )
    }) {
        return Err(vec![format!(
            "spin transport '{}' M2 CPU v1 does not support periodic spin boundaries",
            module.id
        )]);
    }
    if base
        .interfaces
        .iter()
        .any(|interface| matches!(interface.law, ResolvedSpinInterfaceLawIR::Transparent))
    {
        return Err(vec![format!(
            "spin transport '{}' M2 CPU v1 requires explicit mixing-conductance laws at cross-material interfaces",
            module.id
        )]);
    }
    let nonlinear_solver = module.solver.reciprocal_nonlinear.clone().ok_or_else(|| {
        vec![format!(
            "spin transport '{}' M2 requires reciprocal_nonlinear solver policy",
            module.id
        )]
    })?;
    let count = base.charge_active_cells.len();
    let mut sigma_parallel = vec![0.0; count];
    let mut sigma_perpendicular = vec![0.0; count];
    let mut sigma_ahe = vec![0.0; count];
    let mut assigned = vec![false; count];
    for assignment in &charge.materials {
        let parallel = assignment.material.sigma_parallel_spm.ok_or_else(|| {
            vec![format!(
                "spin transport '{}' M2 charge material requires sigma_parallel_Spm",
                module.id
            )]
        })?;
        let perpendicular = assignment.material.sigma_perpendicular_spm.ok_or_else(|| {
            vec![format!(
                "spin transport '{}' M2 charge material requires sigma_perpendicular_Spm",
                module.id
            )]
        })?;
        let ahe = assignment.material.sigma_ahe_spm.ok_or_else(|| {
            vec![format!(
                "spin transport '{}' M2 charge material requires sigma_AHE_Spm",
                module.id
            )]
        })?;
        let mask = resolve_region_mask(&assignment.region, context, "M2 charge material")?;
        for cell in 0..count {
            if mask[cell] && base.charge_active_cells[cell] {
                if assigned[cell] {
                    return Err(vec![format!(
                        "M2 charge material assignments overlap at cell {cell}"
                    )]);
                }
                assigned[cell] = true;
                sigma_parallel[cell] = parallel;
                sigma_perpendicular[cell] = perpendicular;
                sigma_ahe[cell] = ahe;
            }
        }
    }
    require_complete_assignment(&base.charge_active_cells, &assigned, "M2 charge material")?;
    let reciprocal_materials = (0..count)
        .map(|cell| ResolvedReciprocalMaterialIR {
            sigma_spm: base.charge_conductivity_spm[cell],
            sigma_spin_spm: base.spin_conductivity_spm[cell],
            sigma_parallel_spm: sigma_parallel[cell],
            sigma_perpendicular_spm: sigma_perpendicular[cell],
            sigma_ahe_spm: sigma_ahe[cell],
            polarization_p: base.polarization_p[cell],
            theta_sh: base.theta_sh[cell],
        })
        .collect();
    Ok(ResolvedFdmCoupledSpinTransportIR {
        descriptor_schema: "fullmag.fdm.coupled_spin_transport_descriptor.v1".to_string(),
        active_cells: base.charge_active_cells,
        reciprocal_materials,
        reactions: base.reactions,
        region_ids: base.region_ids,
        charge_boundaries: base.charge_boundaries,
        spin_boundaries: base.spin_boundaries,
        interfaces: base.interfaces,
        torque_target_cells: base.torque_target_cells,
        saturation_magnetization_apm: base.saturation_magnetization_apm,
        gamma_e_rad_per_s_t: base.gamma_e_rad_per_s_t,
        linear_solver: module.solver.linear.clone(),
        nonlinear_solver,
        operator_version: module.solver.operator_version.clone(),
        physical_residual_version: module.solver.physical_residual_version.clone(),
        constitutive_version: module.constitutive_version.clone(),
        torque_formula_version: base.torque_formula_version,
        oersted_source_bound: base.oersted_source_bound,
    })
}

const FEM_CONSTITUTIVE_VERSION: &str = "transport_constitutive.one_way.fullmag.v1";
const FEM_OPERATOR_VERSION: &str = "fem_charge_spin_conforming_h1_p1.transparent.v1";
const FEM_RESIDUAL_VERSION: &str = "transport_balance_integrated_l2.v1";
const FEM_CHARGE_OPERATOR_VERSION: &str = "fem_charge_conforming_h1_p1.transparent.v1";
const FEM_CHARGE_RESIDUAL_VERSION: &str = "charge_balance_integrated_l2.v1";

pub(crate) fn resolve_m1_fem_spin_transport(
    problem: &ProblemIR,
    mesh: &MeshIR,
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
    initial_magnetization: &[[f64; 3]],
    saturation_magnetization_apm: f64,
    gamma0_m_per_a_s: f64,
) -> Result<Vec<ResolvedSpinTransportPlanIR>, PlanError> {
    let mut plans = Vec::with_capacity(problem.spin_transport_modules.len());
    let mut errors = Vec::new();
    for module in &problem.spin_transport_modules {
        let prefix = format!("FEM spin transport '{}'", module.id);
        let requested = &module.requested_execution;
        if !matches!(
            requested.discretization,
            BackendTarget::Fem | BackendTarget::Auto
        ) {
            errors.push(format!("{prefix} requested a non-FEM discretization"));
        }
        if !matches!(
            requested.device,
            ExecutionDevice::Cpu | ExecutionDevice::Auto
        ) {
            errors.push(format!("{prefix} requested GPU, but M1 FEM transport has no GPU realization and cannot fall back silently"));
        }
        if requested.precision != ExecutionPrecision::Double
            || problem.backend_policy.execution_precision != ExecutionPrecision::Double
        {
            errors.push(format!(
                "{prefix} requires requested and enclosing double precision"
            ));
        }
        if requested.execution_mode != fullmag_ir::ExecutionMode::Strict {
            errors.push(format!("{prefix} requires execution_mode=strict"));
        }
        if module.mode != fullmag_ir::SpinTransportModeIR::Steady {
            errors.push(format!("{prefix} supports steady mode only"));
        }
        if module.constitutive_version != FEM_CONSTITUTIVE_VERSION
            || module.solver.operator_version != FEM_OPERATOR_VERSION
            || module.solver.physical_residual_version != FEM_RESIDUAL_VERSION
        {
            errors.push(format!(
                "{prefix} requests an unsupported constitutive/operator/residual version"
            ));
        }
        if !matches!(module.solver.engine.as_str(), "auto" | "gmres") {
            errors.push(format!(
                "{prefix} requires spin solver engine auto or gmres"
            ));
        }
        if module.solver.linear.absolute_tolerance != 0.0 {
            errors.push(format!(
                "{prefix} currently requires spin absolute_tolerance=0"
            ));
        }
        if module
            .interfaces
            .iter()
            .any(|interface| matches!(interface, SpinInterfaceIR::MixingConductance { .. }))
        {
            errors.push(format!(
                "{prefix} mixing/SML requires the unavailable broken-H1 mortar realization"
            ));
        }
        if problem.spin_torque_modules.iter().any(|torque| {
            matches!(torque,
            SpinTorqueModuleIR::DriftDiffusionSpinTorque { solve_id, .. } if solve_id == &module.id)
        }) {
            errors.push(format!("{prefix} stage coupling into LLG is not yet implemented and fails before provenance"));
        }
        if problem.energy_terms.iter().any(|term| matches!(term,
            fullmag_ir::EnergyTermIR::OerstedField { source, .. } if source == &module.current_source_id))
        {
            errors.push(format!("{prefix} Oersted stage coupling from solved current is not yet implemented"));
        }

        let source = problem
            .current_modules
            .iter()
            .find_map(|source| match source {
                fullmag_ir::CurrentModuleIR::CurrentTransport {
                    name,
                    model,
                    coupling,
                    definition,
                    ..
                } if name == &module.current_source_id => {
                    Some((*model, *coupling, definition.as_ref()))
                }
                _ => None,
            });
        let Some((model, coupling, Some(charge))) = source else {
            errors.push(format!(
                "{prefix} requires a complete CurrentTransportIR source '{}'",
                module.current_source_id
            ));
            continue;
        };
        if model != fullmag_ir::CurrentTransportModelIR::OhmicPoisson {
            errors.push(format!(
                "{prefix} source '{}' must use ohmic_poisson",
                module.current_source_id
            ));
            continue;
        }
        if coupling != fullmag_ir::TransportCouplingIR::OneWay {
            errors.push(format!("{prefix} supports one_way coupling only"));
        }
        if !matches!(charge.solver.engine.as_str(), "auto" | "cg") {
            errors.push(format!("{prefix} requires charge solver engine auto or cg"));
        }
        if charge.solver.linear.absolute_tolerance != 0.0 {
            errors.push(format!(
                "{prefix} currently requires charge absolute_tolerance=0"
            ));
        }
        if charge.solver.operator_version != FEM_CHARGE_OPERATOR_VERSION
            || charge.solver.physical_residual_version != FEM_CHARGE_RESIDUAL_VERSION
        {
            errors.push(format!(
                "{prefix} requests an unsupported charge operator/residual version"
            ));
        }
        if charge.solver.linear != module.solver.linear {
            errors.push(format!(
                "{prefix} v1 ABI requires identical charge and spin linear solver policies"
            ));
        }
        if initial_magnetization.len() != mesh.nodes.len() {
            errors.push(format!(
                "{prefix} magnetization length does not match FEM nodes"
            ));
        }

        let descriptor = materialize_fem_descriptor(
            problem,
            module,
            charge,
            mesh,
            object_segments,
            mesh_parts,
            saturation_magnetization_apm,
            gamma0_m_per_a_s,
        );
        match descriptor {
            Ok(descriptor) => plans.push(ResolvedSpinTransportPlanIR {
                module_id: module.id.clone(),
                current_source_id: module.current_source_id.clone(),
                resolved_coupling: coupling,
                requested_execution: requested.clone(),
                resolved_discretization: BackendTarget::Fem,
                resolved_device: ExecutionDevice::Cpu,
                resolved_precision: ExecutionPrecision::Double,
                constitutive_version: module.constitutive_version.clone(),
                operator_version: module.solver.operator_version.clone(),
                physical_residual_version: module.solver.physical_residual_version.clone(),
                capabilities: vec![
                    "transport.charge.ohmic".into(),
                    "transport.spin.steady_drift_diffusion".into(),
                    "transport.spin.direct_she".into(),
                    "transport.coupling.one_way".into(),
                ],
                inserted_default_boundaries: inserted_fem_default_boundaries(charge, module),
                fdm_cpu_double: None,
                fdm_cpu_double_reciprocal: None,
                fem_cpu_double: Some(descriptor),
            }),
            Err(mut reasons) => errors.append(&mut reasons),
        }
    }
    if errors.is_empty() {
        Ok(plans)
    } else {
        Err(PlanError { reasons: errors })
    }
}

fn materialize_fem_descriptor(
    problem: &ProblemIR,
    module: &fullmag_ir::SpinTransportModuleIR,
    charge: &fullmag_ir::ChargeTransportDefinitionIR,
    mesh: &MeshIR,
    object_segments: &[FemObjectSegmentIR],
    mesh_parts: &[FemMeshPartIR],
    saturation_magnetization_apm: f64,
    gamma0_m_per_a_s: f64,
) -> Result<ResolvedFemSpinTransportIR, Vec<String>> {
    let charge_domain = fem_domain_mask(
        &charge.domain,
        mesh.elements.len(),
        object_segments,
        "charge domain",
    )?;
    let spin_domain = fem_domain_mask(
        &module.domain,
        mesh.elements.len(),
        object_segments,
        "spin domain",
    )?;
    require_full_fem_domain(&charge_domain, "charge domain")?;
    require_full_fem_domain(&spin_domain, "spin domain")?;

    let mut conductivity = vec![f64::NAN; mesh.elements.len()];
    for assignment in &charge.materials {
        let mask = fem_domain_mask(
            std::slice::from_ref(&assignment.region),
            mesh.elements.len(),
            object_segments,
            "charge material",
        )?;
        for (index, selected) in mask.into_iter().enumerate() {
            if selected {
                if conductivity[index].is_finite() {
                    return Err(vec![format!(
                        "charge material assignments overlap at FEM element {index}"
                    )]);
                }
                conductivity[index] = assignment.material.sigma_spm;
            }
        }
    }
    if conductivity
        .iter()
        .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(vec![
            "charge material assignments must cover every FEM element with finite sigma>0".into(),
        ]);
    }

    let mut spin_by_element: Vec<Option<&fullmag_ir::SpinTransportMaterialIR>> =
        vec![None; mesh.elements.len()];
    for assignment in &module.materials {
        let mask = fem_domain_mask(
            std::slice::from_ref(&assignment.region),
            mesh.elements.len(),
            object_segments,
            "spin material",
        )?;
        for (index, selected) in mask.into_iter().enumerate() {
            if selected {
                if spin_by_element[index].is_some() {
                    return Err(vec![format!(
                        "spin material assignments overlap at FEM element {index}"
                    )]);
                }
                spin_by_element[index] = Some(&assignment.material);
            }
        }
    }
    let Some(reference) = spin_by_element.first().and_then(|material| *material) else {
        return Err(vec![
            "spin material assignments must cover every FEM element".into(),
        ]);
    };
    if spin_by_element
        .iter()
        .any(|material| material.is_none_or(|material| material != reference))
    {
        return Err(vec!["FEM conforming-H1 M1 currently requires one uniform spin material across the complete solve domain".into()]);
    }

    let charge_dirichlet = resolve_charge_dirichlet(charge, mesh, mesh_parts)?;
    let spin_dirichlet = resolve_spin_dirichlet(module, mesh, mesh_parts)?;
    let charge_insulating_boundaries =
        resolve_charge_insulating_boundaries(charge, mesh, mesh_parts)?;
    let spin_insulating_boundaries = resolve_spin_insulating_boundaries(module, mesh, mesh_parts)?;
    validate_fem_boundary_partition(
        "charge",
        mesh,
        charge_dirichlet
            .iter()
            .map(|(marker, _)| ("dirichlet", *marker))
            .chain(charge_insulating_boundaries.iter().flat_map(|boundary| {
                boundary
                    .boundary_attributes
                    .iter()
                    .map(move |marker| (boundary.id.as_str(), *marker))
            })),
    )?;
    validate_fem_boundary_partition(
        "spin",
        mesh,
        spin_dirichlet
            .iter()
            .map(|(marker, _)| ("dirichlet", *marker))
            .chain(spin_insulating_boundaries.iter().flat_map(|boundary| {
                boundary
                    .boundary_attributes
                    .iter()
                    .map(move |marker| (boundary.id.as_str(), *marker))
            })),
    )?;
    let interfaces = module
        .interfaces
        .iter()
        .filter_map(|interface| match interface {
            SpinInterfaceIR::Transparent {
                id,
                side_a,
                side_b,
                normal_a_to_b,
            } => Some(fullmag_ir::ResolvedFemTransportInterfaceIR {
                id: id.clone(),
                side_a: side_a.clone(),
                side_b: side_b.clone(),
                normal_a_to_b: *normal_a_to_b,
                law: "transparent".into(),
            }),
            SpinInterfaceIR::MixingConductance { .. } => None,
        })
        .collect();
    let torque_target = problem.spin_torque_modules.iter().find_map(|torque| match torque {
        SpinTorqueModuleIR::DriftDiffusionSpinTorque {
            id,
            solve_id,
            target,
            formula_version,
            ..
        } if solve_id == &module.id => Some((id, target, formula_version)),
        _ => None,
    });
    let torque_target = torque_target
        .map(|(id, target, formula_version)| -> Result<_, Vec<String>> {
            Ok(fullmag_ir::ResolvedFemTorqueTargetIR {
                torque_module_id: id.clone(),
                target: target.clone(),
                element_mask: fem_domain_mask(
                    std::slice::from_ref(target),
                    mesh.elements.len(),
                    object_segments,
                    "torque target",
                )?,
                formula_version: formula_version.clone(),
            })
        })
        .transpose()?;
    match charge.gauge {
        fullmag_ir::ChargePotentialGaugeIR::DirichletReference if charge_dirichlet.is_empty() => {
            return Err(vec![
                "boundary-reference gauge requires at least one voltage electrode".into(),
            ]);
        }
        fullmag_ir::ChargePotentialGaugeIR::ZeroMean if !charge_dirichlet.is_empty() => {
            return Err(vec![
                "zero-mean gauge conflicts with voltage electrodes".into()
            ]);
        }
        _ => {}
    }
    if module.boundaries.is_empty() && module.solver.default_external_boundary != "spin_insulating"
    {
        return Err(vec![
            "empty FEM spin boundaries require explicit default_external_boundary=spin_insulating"
                .into(),
        ]);
    }
    const MU0_H_PER_M: f64 = 1.256_637_061_435_917_3e-6;
    Ok(ResolvedFemSpinTransportIR {
        descriptor_schema: "fullmag.fem.spin_transport_descriptor.v1".into(),
        charge_definition: charge.clone(),
        charge_domain: fullmag_ir::ResolvedFemTransportDomainIR {
            regions: charge.domain.clone(),
            element_mask: charge_domain,
        },
        spin_domain: fullmag_ir::ResolvedFemTransportDomainIR {
            regions: module.domain.clone(),
            element_mask: spin_domain,
        },
        charge_insulating_boundaries,
        spin_insulating_boundaries,
        interfaces,
        torque_target,
        charge_conductivity_spm_per_element: conductivity,
        charge_gauge: charge.gauge,
        charge_solver: charge.solver.clone(),
        charge_dirichlet,
        spin_dirichlet,
        sigma_s_spm: reference.sigma_s_spm,
        polarization_p: reference.polarization_p,
        theta_sh: reference.theta_sh,
        lambda_sf_m: reference.lambda_sf_m,
        lambda_j_m: reaction_value(&reference.lambda_j_m),
        lambda_phi_m: reaction_value(&reference.lambda_phi_m),
        saturation_magnetization_apm,
        gamma_e_rad_per_s_t: gamma0_m_per_a_s / MU0_H_PER_M,
        spin_solver: module.solver.clone(),
        resolved_charge_engine: "cg".into(),
        resolved_spin_engine: "gmres".into(),
        interface_law: "transparent".into(),
        interface_realization: "transparent_conforming_h1".into(),
        stage_coupling: "none".into(),
        capability_status: "reference_executable".into(),
        implementation_state: "executable".into(),
        validation_state: "algebra_validated".into(),
        validation_scope: "fem_cpu_double_conforming_h1_p1_transparent_m1".into(),
    })
}

fn fem_domain_mask(
    regions: &[RegionRefIR],
    element_count: usize,
    segments: &[FemObjectSegmentIR],
    label: &str,
) -> Result<Vec<bool>, Vec<String>> {
    let mut mask = vec![false; element_count];
    for region in regions {
        if let Some(region_id) = region.region_id.as_deref() {
            return Err(vec![format!(
                "{label} region_id '{region_id}' has no exact FEM subregion realization"
            )]);
        }
        let matching = segments
            .iter()
            .filter(|segment| {
                segment.object_id == region.object_id
                    || segment.geometry_id.as_deref() == Some(region.object_id.as_str())
            })
            .collect::<Vec<_>>();
        if matching.is_empty() {
            return Err(vec![format!(
                "{label} object '{}' is absent from the resolved FEM mesh",
                region.object_id
            )]);
        }
        for segment in matching {
            let start = segment.element_start as usize;
            let end = start.saturating_add(segment.element_count as usize);
            if end > element_count {
                return Err(vec![format!(
                    "{label} object '{}' element range exceeds the FEM mesh",
                    region.object_id
                )]);
            }
            mask[start..end].fill(true);
        }
    }
    Ok(mask)
}

fn require_full_fem_domain(mask: &[bool], label: &str) -> Result<(), Vec<String>> {
    if mask.iter().all(|selected| *selected) && !mask.is_empty() {
        Ok(())
    } else {
        Err(vec![format!("FEM conforming-H1 M1 requires {label} to cover the complete resolved mesh; submesh restriction is not implemented")])
    }
}

fn surface_markers(
    surface: &fullmag_ir::SurfaceRefIR,
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
) -> Result<Vec<u32>, Vec<String>> {
    let resolved = resolve_fem_surface_selector(
        mesh,
        mesh_parts,
        &surface.object_id,
        &surface.surface_id,
        None,
    )
    .map_err(|reason| vec![reason])?;
    if resolved.boundary_face_indices.is_empty() {
        return Err(vec![format!(
            "surface '{}:{}' has no boundary-face indices and cannot map to MFEM attributes",
            surface.object_id, surface.surface_id
        )]);
    }
    let mut markers = BTreeSet::new();
    for index in resolved.boundary_face_indices {
        let marker = mesh
            .boundary_markers
            .get(index as usize)
            .copied()
            .ok_or_else(|| {
                vec![format!(
                    "surface '{}:{}' references boundary face {index} without a marker",
                    surface.object_id, surface.surface_id
                )]
            })?;
        if marker == 0 {
            return Err(vec![format!(
                "surface '{}:{}' resolves MFEM boundary attribute 0",
                surface.object_id, surface.surface_id
            )]);
        }
        markers.insert(marker);
    }
    Ok(markers.into_iter().collect())
}

fn insert_scalar_bc(
    map: &mut BTreeMap<u32, f64>,
    marker: u32,
    value: f64,
    label: &str,
) -> Result<(), Vec<String>> {
    if map.insert(marker, value).is_some() {
        return Err(vec![format!(
            "conflicting {label} assignments on MFEM boundary attribute {marker}"
        )]);
    }
    Ok(())
}

fn insert_vector_bc(
    map: &mut BTreeMap<u32, [f64; 3]>,
    marker: u32,
    value: [f64; 3],
    label: &str,
) -> Result<(), Vec<String>> {
    if map.insert(marker, value).is_some() {
        return Err(vec![format!(
            "conflicting {label} assignments on MFEM boundary attribute {marker}"
        )]);
    }
    Ok(())
}

fn resolve_charge_dirichlet(
    charge: &fullmag_ir::ChargeTransportDefinitionIR,
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
) -> Result<Vec<(u32, f64)>, Vec<String>> {
    let mut values = BTreeMap::new();
    for boundary in &charge.boundaries {
        match boundary {
            ChargeBoundaryIR::VoltageElectrode {
                surfaces,
                potential_v,
                ..
            } => {
                for surface in surfaces {
                    for marker in surface_markers(surface, mesh, mesh_parts)? {
                        insert_scalar_bc(&mut values, marker, *potential_v, "voltage")?;
                    }
                }
            }
            ChargeBoundaryIR::Insulating { surfaces, .. } => {
                for surface in surfaces {
                    let _ = surface_markers(surface, mesh, mesh_parts)?;
                }
            }
            ChargeBoundaryIR::NormalCurrentElectrode { .. } => {
                return Err(vec![
                    "normal-current electrodes are unsupported by FEM M1 C ABI".into(),
                ]);
            }
        }
    }
    Ok(values.into_iter().collect())
}

fn resolve_charge_insulating_boundaries(
    charge: &fullmag_ir::ChargeTransportDefinitionIR,
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
) -> Result<Vec<fullmag_ir::ResolvedFemBoundaryMarkerSetIR>, Vec<String>> {
    if charge.boundaries.is_empty() {
        return Ok(vec![fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
            id: "default:charge_insulating".into(),
            boundary_attributes: external_fem_boundary_markers(mesh)?.into_iter().collect(),
        }]);
    }
    charge
        .boundaries
        .iter()
        .filter_map(|boundary| match boundary {
            ChargeBoundaryIR::Insulating { id, surfaces } => Some((id, surfaces)),
            _ => None,
        })
        .map(|(id, surfaces)| {
            let mut markers = BTreeSet::new();
            for surface in surfaces {
                markers.extend(surface_markers(surface, mesh, mesh_parts)?);
            }
            Ok(fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
                id: id.clone(),
                boundary_attributes: markers.into_iter().collect(),
            })
        })
        .collect()
}

fn resolve_spin_dirichlet(
    module: &fullmag_ir::SpinTransportModuleIR,
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
) -> Result<Vec<(u32, [f64; 3])>, Vec<String>> {
    let mut values = BTreeMap::new();
    for boundary in &module.boundaries {
        match boundary {
            fullmag_ir::SpinBoundaryIR::SpinSink { surfaces, .. } => {
                for surface in surfaces {
                    for marker in surface_markers(surface, mesh, mesh_parts)? {
                        insert_vector_bc(&mut values, marker, [0.0; 3], "spin potential")?;
                    }
                }
            }
            fullmag_ir::SpinBoundaryIR::SpecifiedSpinPotential {
                surfaces,
                spin_potential_v,
                ..
            } => {
                for surface in surfaces {
                    for marker in surface_markers(surface, mesh, mesh_parts)? {
                        insert_vector_bc(&mut values, marker, *spin_potential_v, "spin potential")?;
                    }
                }
            }
            fullmag_ir::SpinBoundaryIR::SpinInsulating { surfaces, .. } => {
                for surface in surfaces {
                    let _ = surface_markers(surface, mesh, mesh_parts)?;
                }
            }
            fullmag_ir::SpinBoundaryIR::SpecifiedSpinFlux { .. } => {
                return Err(vec![
                    "specified spin flux is unsupported by FEM M1 C ABI".into()
                ]);
            }
            fullmag_ir::SpinBoundaryIR::PeriodicSpin { .. } => {
                return Err(vec![
                    "periodic spin boundaries are unsupported by FEM conforming-H1 M1".into(),
                ]);
            }
        }
    }
    Ok(values.into_iter().collect())
}

fn resolve_spin_insulating_boundaries(
    module: &fullmag_ir::SpinTransportModuleIR,
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
) -> Result<Vec<fullmag_ir::ResolvedFemBoundaryMarkerSetIR>, Vec<String>> {
    if module.boundaries.is_empty() {
        return Ok(vec![fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
            id: "default:spin_insulating".into(),
            boundary_attributes: external_fem_boundary_markers(mesh)?.into_iter().collect(),
        }]);
    }
    module
        .boundaries
        .iter()
        .filter_map(|boundary| match boundary {
            fullmag_ir::SpinBoundaryIR::SpinInsulating { id, surfaces } => Some((id, surfaces)),
            _ => None,
        })
        .map(|(id, surfaces)| {
            let mut markers = BTreeSet::new();
            for surface in surfaces {
                markers.extend(surface_markers(surface, mesh, mesh_parts)?);
            }
            Ok(fullmag_ir::ResolvedFemBoundaryMarkerSetIR {
                id: id.clone(),
                boundary_attributes: markers.into_iter().collect(),
            })
        })
        .collect()
}

fn inserted_fem_default_boundaries(
    charge: &fullmag_ir::ChargeTransportDefinitionIR,
    module: &fullmag_ir::SpinTransportModuleIR,
) -> Vec<String> {
    let mut defaults = Vec::new();
    if charge.boundaries.is_empty() {
        defaults.push("charge:all_external_surfaces=insulating".into());
    }
    if module.boundaries.is_empty() {
        defaults.push("spin:all_external_surfaces=spin_insulating".into());
    }
    defaults
}

fn external_fem_boundary_markers(mesh: &MeshIR) -> Result<BTreeSet<u32>, Vec<String>> {
    if mesh.boundary_markers.len() != mesh.boundary_faces.len() {
        return Err(vec![format!(
            "FEM boundary marker count {} does not match external boundary face count {}",
            mesh.boundary_markers.len(),
            mesh.boundary_faces.len()
        )]);
    }
    let markers = mesh
        .boundary_markers
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    if markers.is_empty() || markers.contains(&0) {
        return Err(vec![
            "FEM external boundary faces require non-zero MFEM boundary attributes".into(),
        ]);
    }
    Ok(markers)
}

fn validate_fem_boundary_partition<'a>(
    family: &str,
    mesh: &MeshIR,
    assignments: impl Iterator<Item = (&'a str, u32)>,
) -> Result<(), Vec<String>> {
    let external = external_fem_boundary_markers(mesh)?;
    let mut owners = BTreeMap::<u32, &str>::new();
    for (owner, marker) in assignments {
        if !external.contains(&marker) {
            return Err(vec![format!(
                "FEM {family} boundary '{owner}' references non-external boundary attribute {marker}"
            )]);
        }
        if let Some(existing) = owners.insert(marker, owner) {
            return Err(vec![format!(
                "conflicting FEM {family} boundary assignments '{existing}' and '{owner}' on boundary attribute {marker}"
            )]);
        }
    }
    let covered = owners.keys().copied().collect::<BTreeSet<_>>();
    let missing = external.difference(&covered).copied().collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(vec![format!(
            "FEM {family} boundary assignments do not cover external boundary attributes {missing:?}"
        )]);
    }
    Ok(())
}

fn materialize_fdm_descriptor(
    problem: &ProblemIR,
    module: &fullmag_ir::SpinTransportModuleIR,
    charge: &fullmag_ir::ChargeTransportDefinitionIR,
    context: &FdmSpinTransportResolutionContext<'_>,
) -> Result<ResolvedFdmSpinTransportIR, Vec<String>> {
    let count = context.region_mask.len();
    if count == 0
        || context.initial_magnetization.len() != count
        || context.saturation_magnetization_apm.len() != count
        || context
            .active_mask
            .is_some_and(|active| active.len() != count)
    {
        return Err(vec![format!(
            "spin transport '{}' planner context does not match the resolved FDM grid",
            module.id
        )]);
    }
    let charge_active_cells = union_region_masks(&charge.domain, context, "charge domain")?;
    let spin_active_cells = union_region_masks(&module.domain, context, "spin domain")?;

    let mut charge_conductivity_spm = vec![0.0; count];
    let mut charge_assigned = vec![false; count];
    for assignment in &charge.materials {
        assign_scalar_field(
            &assignment.region,
            assignment.material.sigma_spm,
            &charge_active_cells,
            context,
            &mut charge_conductivity_spm,
            &mut charge_assigned,
            "charge material",
        )?;
    }
    require_complete_assignment(&charge_active_cells, &charge_assigned, "charge material")?;

    let mut spin_conductivity_spm = vec![0.0; count];
    let mut polarization_p = vec![0.0; count];
    let mut theta_sh = vec![0.0; count];
    let mut reactions = vec![
        ResolvedSpinReactionLengthsIR {
            spin_flip_m: None,
            exchange_m: None,
            dephasing_m: None,
        };
        count
    ];
    let mut spin_assigned = vec![false; count];
    for assignment in &module.materials {
        let mask = resolve_region_mask(&assignment.region, context, "spin material")?;
        for cell in 0..count {
            if mask[cell] && spin_active_cells[cell] {
                if spin_assigned[cell] {
                    return Err(vec![format!(
                        "spin transport '{}' has overlapping spin material assignments at cell {}",
                        module.id, cell
                    )]);
                }
                spin_assigned[cell] = true;
                spin_conductivity_spm[cell] = assignment.material.sigma_s_spm;
                polarization_p[cell] = assignment.material.polarization_p;
                theta_sh[cell] = assignment.material.theta_sh;
                reactions[cell] = ResolvedSpinReactionLengthsIR {
                    spin_flip_m: Some(assignment.material.lambda_sf_m),
                    exchange_m: reaction_value(&assignment.material.lambda_j_m),
                    dephasing_m: reaction_value(&assignment.material.lambda_phi_m),
                };
            }
        }
    }
    require_complete_assignment(&spin_active_cells, &spin_assigned, "spin material")?;

    let charge_boundaries = resolve_charge_boundaries(&charge.boundaries, context)?;
    let (spin_boundaries, inserted_default_spin_boundaries) =
        resolve_spin_boundaries(&module.boundaries, context)?;
    let interfaces = resolve_interfaces(module, context)?;

    let matching_torques = problem
        .spin_torque_modules
        .iter()
        .filter_map(|torque| match torque {
            SpinTorqueModuleIR::DriftDiffusionSpinTorque {
                solve_id,
                target,
                formula_version,
                ..
            } if solve_id == &module.id => Some((target, formula_version)),
            _ => None,
        })
        .collect::<Vec<_>>();
    if matching_torques.len() > 1 {
        return Err(vec![format!(
            "spin transport '{}' has more than one DriftDiffusionSpinTorque consumer",
            module.id
        )]);
    }
    let (torque_target_cells, torque_formula_version) =
        if let Some((target, formula)) = matching_torques.first() {
            (
                resolve_region_mask(target, context, "transport torque target")?,
                Some((*formula).clone()),
            )
        } else {
            (vec![false; count], None)
        };
    let has_magnetic_sink = reactions
        .iter()
        .any(|reaction| reaction.exchange_m.is_some() || reaction.dephasing_m.is_some())
        || module
            .interfaces
            .iter()
            .any(|interface| matches!(interface, SpinInterfaceIR::MixingConductance { .. }));
    if has_magnetic_sink && torque_formula_version.is_none() {
        return Err(vec![format!(
            "spin transport '{}' has magnetic spin sinks but no DriftDiffusionSpinTorque target",
            module.id
        )]);
    }
    if inserted_default_spin_boundaries && !module.boundaries.is_empty() {
        return Err(vec![format!(
            "spin transport '{}' may insert default insulating boundaries only when no spin boundary is authored",
            module.id
        )]);
    }
    const MU0_H_PER_M: f64 = 1.256_637_061_435_917_3e-6;
    let oersted_source_bound = problem.energy_terms.iter().any(|term| {
        matches!(
            term,
            fullmag_ir::EnergyTermIR::OerstedField { source, .. }
                if source == &module.current_source_id
        )
    });
    Ok(ResolvedFdmSpinTransportIR {
        descriptor_schema: "fullmag.fdm.spin_transport_descriptor.v1".to_string(),
        charge_active_cells,
        charge_conductivity_spm,
        charge_boundaries,
        charge_gauge: charge.gauge,
        charge_solver: charge.solver.clone(),
        spin_active_cells,
        spin_conductivity_spm,
        polarization_p,
        theta_sh,
        reactions,
        region_ids: context.region_mask.to_vec(),
        spin_boundaries,
        interfaces,
        torque_target_cells,
        saturation_magnetization_apm: context.saturation_magnetization_apm.to_vec(),
        gamma_e_rad_per_s_t: context.gamma0_m_per_a_s / MU0_H_PER_M,
        spin_solver: module.solver.clone(),
        torque_formula_version,
        oersted_source_bound,
    })
}

fn reaction_value(value: &ReactionLengthIR) -> Option<f64> {
    match value {
        ReactionLengthIR::Enabled(value) => Some(*value),
        ReactionLengthIR::Disabled(_) => None,
    }
}

fn is_grid_active(context: &FdmSpinTransportResolutionContext<'_>, cell: usize) -> bool {
    context.active_mask.is_none_or(|mask| mask[cell])
}

fn resolve_region_mask(
    region: &RegionRefIR,
    context: &FdmSpinTransportResolutionContext<'_>,
    label: &str,
) -> Result<Vec<bool>, Vec<String>> {
    if !context.owner_names.contains(&region.object_id.as_str()) {
        return Err(vec![format!(
            "{label} object_id '{}' is outside the resolved single-grid FDM object",
            region.object_id
        )]);
    }
    let selected = match region.region_id.as_deref() {
        Some(region_id) => Some(*context.region_index_by_id.get(region_id).ok_or_else(|| {
            vec![format!(
                "{label} region_id '{}' was not materialized in the FDM region mask",
                region_id
            )]
        })?),
        None => None,
    };
    let mask = context
        .region_mask
        .iter()
        .enumerate()
        .map(|(cell, numeric)| {
            is_grid_active(context, cell) && selected.is_none_or(|id| *numeric == id)
        })
        .collect::<Vec<_>>();
    if !mask.iter().any(|active| *active) {
        return Err(vec![format!("{label} selects no active FDM cells")]);
    }
    Ok(mask)
}

fn union_region_masks(
    regions: &[RegionRefIR],
    context: &FdmSpinTransportResolutionContext<'_>,
    label: &str,
) -> Result<Vec<bool>, Vec<String>> {
    let mut union = vec![false; context.region_mask.len()];
    for region in regions {
        let mask = resolve_region_mask(region, context, label)?;
        for (target, selected) in union.iter_mut().zip(mask) {
            *target |= selected;
        }
    }
    if !union.iter().any(|active| *active) {
        return Err(vec![format!("{label} selects no active FDM cells")]);
    }
    Ok(union)
}

fn assign_scalar_field(
    region: &RegionRefIR,
    value: f64,
    domain: &[bool],
    context: &FdmSpinTransportResolutionContext<'_>,
    field: &mut [f64],
    assigned: &mut [bool],
    label: &str,
) -> Result<(), Vec<String>> {
    let mask = resolve_region_mask(region, context, label)?;
    for cell in 0..field.len() {
        if mask[cell] && domain[cell] {
            if assigned[cell] {
                return Err(vec![format!("{label} assignments overlap at cell {cell}")]);
            }
            assigned[cell] = true;
            field[cell] = value;
        }
    }
    Ok(())
}

fn require_complete_assignment(
    domain: &[bool],
    assigned: &[bool],
    label: &str,
) -> Result<(), Vec<String>> {
    if let Some(cell) = domain
        .iter()
        .zip(assigned)
        .position(|(active, assigned)| *active && !*assigned)
    {
        return Err(vec![format!(
            "{label} is missing for active domain cell {cell}"
        )]);
    }
    Ok(())
}

fn structured_boundary_face(
    surface: &fullmag_ir::SurfaceRefIR,
) -> Result<StructuredBoundaryFaceIR, Vec<String>> {
    let expected = match surface.surface_id.as_str() {
        "x_min" => (StructuredBoundaryFaceIR::XMin, [-1.0, 0.0, 0.0]),
        "x_max" => (StructuredBoundaryFaceIR::XMax, [1.0, 0.0, 0.0]),
        "y_min" => (StructuredBoundaryFaceIR::YMin, [0.0, -1.0, 0.0]),
        "y_max" => (StructuredBoundaryFaceIR::YMax, [0.0, 1.0, 0.0]),
        "z_min" => (StructuredBoundaryFaceIR::ZMin, [0.0, 0.0, -1.0]),
        "z_max" => (StructuredBoundaryFaceIR::ZMax, [0.0, 0.0, 1.0]),
        other => return Err(vec![format!(
            "structured FDM surface_id '{other}' is unsupported; use x_min/x_max/y_min/y_max/z_min/z_max"
        )]),
    };
    if surface
        .orientation
        .iter()
        .zip(expected.1)
        .any(|(actual, expected)| (*actual - expected).abs() > 1.0e-10)
    {
        return Err(vec![format!(
            "surface '{}:{}' orientation disagrees with its canonical outward normal",
            surface.object_id, surface.surface_id
        )]);
    }
    Ok(expected.0)
}

fn resolve_charge_boundaries(
    boundaries: &[ChargeBoundaryIR],
    context: &FdmSpinTransportResolutionContext<'_>,
) -> Result<Vec<ResolvedChargeBoundaryFaceIR>, Vec<String>> {
    let mut resolved = Vec::new();
    let mut faces = BTreeSet::new();
    for boundary in boundaries {
        for surface in boundary.surfaces() {
            if !context.owner_names.contains(&surface.object_id.as_str()) {
                return Err(vec![format!(
                    "charge boundary '{}' references object '{}' outside the FDM transport grid",
                    boundary.id(),
                    surface.object_id
                )]);
            }
            let face = structured_boundary_face(surface)?;
            if !faces.insert(face) {
                return Err(vec![format!(
                    "charge boundary face {face:?} is assigned more than once"
                )]);
            }
            let condition = match boundary {
                ChargeBoundaryIR::VoltageElectrode { potential_v, .. } => {
                    ResolvedChargeBoundaryConditionIR::Voltage {
                        potential_v: *potential_v,
                    }
                }
                ChargeBoundaryIR::NormalCurrentElectrode {
                    outward_current_density_apm2,
                    ..
                } => ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity {
                    current_density_apm2: *outward_current_density_apm2,
                },
                ChargeBoundaryIR::Insulating { .. } => {
                    ResolvedChargeBoundaryConditionIR::Insulating
                }
            };
            resolved.push(ResolvedChargeBoundaryFaceIR {
                source_id: boundary.id().to_string(),
                face,
                condition,
            });
        }
    }
    if faces.len() != 6 {
        return Err(vec![
            "complete structured FDM charge contract must assign each of x_min/x_max/y_min/y_max/z_min/z_max exactly once"
                .to_string(),
        ]);
    }
    Ok(resolved)
}

fn resolve_spin_boundaries(
    boundaries: &[SpinBoundaryIR],
    context: &FdmSpinTransportResolutionContext<'_>,
) -> Result<(Vec<ResolvedSpinBoundaryFaceIR>, bool), Vec<String>> {
    if boundaries.is_empty() {
        return Ok((
            all_boundary_faces()
                .into_iter()
                .map(|face| ResolvedSpinBoundaryFaceIR {
                    source_id: "default:spin_insulating".to_string(),
                    face,
                    condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
                })
                .collect(),
            true,
        ));
    }
    let mut resolved = Vec::new();
    let mut faces = BTreeSet::new();
    for boundary in boundaries {
        match boundary {
            SpinBoundaryIR::PeriodicSpin {
                id,
                minus_surface,
                plus_surface,
                ..
            } => {
                for surface in [minus_surface, plus_surface] {
                    if !context.owner_names.contains(&surface.object_id.as_str()) {
                        return Err(vec![format!(
                            "spin boundary '{id}' references an object outside the FDM grid"
                        )]);
                    }
                    let face = structured_boundary_face(surface)?;
                    if !faces.insert(face) {
                        return Err(vec![format!(
                            "spin boundary face {face:?} is assigned more than once"
                        )]);
                    }
                    resolved.push(ResolvedSpinBoundaryFaceIR {
                        source_id: id.clone(),
                        face,
                        condition: ResolvedSpinBoundaryConditionIR::PeriodicSpin,
                    });
                }
            }
            _ => {
                let (id, surfaces, condition) = match boundary {
                    SpinBoundaryIR::SpinInsulating { id, surfaces } => (
                        id,
                        surfaces,
                        ResolvedSpinBoundaryConditionIR::SpinInsulating,
                    ),
                    SpinBoundaryIR::SpinSink { id, surfaces } => {
                        (id, surfaces, ResolvedSpinBoundaryConditionIR::SpinSink)
                    }
                    SpinBoundaryIR::SpecifiedSpinPotential {
                        id,
                        surfaces,
                        spin_potential_v,
                    } => (
                        id,
                        surfaces,
                        ResolvedSpinBoundaryConditionIR::SpecifiedPotential {
                            value_v: *spin_potential_v,
                        },
                    ),
                    SpinBoundaryIR::SpecifiedSpinFlux {
                        id,
                        surfaces,
                        normal_spin_flux_apm2,
                    } => (
                        id,
                        surfaces,
                        ResolvedSpinBoundaryConditionIR::SpecifiedOutwardFlux {
                            value_apm2: *normal_spin_flux_apm2,
                        },
                    ),
                    SpinBoundaryIR::PeriodicSpin { .. } => unreachable!(),
                };
                for surface in surfaces {
                    if !context.owner_names.contains(&surface.object_id.as_str()) {
                        return Err(vec![format!(
                            "spin boundary '{id}' references an object outside the FDM grid"
                        )]);
                    }
                    let face = structured_boundary_face(surface)?;
                    if !faces.insert(face) {
                        return Err(vec![format!(
                            "spin boundary face {face:?} is assigned more than once"
                        )]);
                    }
                    resolved.push(ResolvedSpinBoundaryFaceIR {
                        source_id: id.clone(),
                        face,
                        condition: condition.clone(),
                    });
                }
            }
        }
    }
    if faces.len() != 6 {
        return Err(vec![
            "when any spin boundary is authored, structured FDM requires all six external faces to be assigned explicitly"
                .to_string(),
        ]);
    }
    Ok((resolved, false))
}

fn all_boundary_faces() -> [StructuredBoundaryFaceIR; 6] {
    [
        StructuredBoundaryFaceIR::XMin,
        StructuredBoundaryFaceIR::XMax,
        StructuredBoundaryFaceIR::YMin,
        StructuredBoundaryFaceIR::YMax,
        StructuredBoundaryFaceIR::ZMin,
        StructuredBoundaryFaceIR::ZMax,
    ]
}

fn resolve_interfaces(
    module: &fullmag_ir::SpinTransportModuleIR,
    context: &FdmSpinTransportResolutionContext<'_>,
) -> Result<Vec<ResolvedSpinInterfaceFaceIR>, Vec<String>> {
    let mut resolved = Vec::new();
    let mut claimed = BTreeSet::new();
    for interface in &module.interfaces {
        let (id, from_ref, to_ref, normal, law) = match interface {
            SpinInterfaceIR::Transparent {
                id,
                side_a,
                side_b,
                normal_a_to_b,
            } => (
                id,
                side_a,
                side_b,
                *normal_a_to_b,
                ResolvedSpinInterfaceLawIR::Transparent,
            ),
            SpinInterfaceIR::MixingConductance {
                id,
                normal_to_ferromagnet,
                normal_side,
                ferromagnet_side,
                g_up_spm2,
                g_down_spm2,
                g_r_spm2,
                g_i_spm2,
                g_sml_spm2,
                formula_version,
                ..
            } => (
                id,
                normal_side,
                ferromagnet_side,
                *normal_to_ferromagnet,
                ResolvedSpinInterfaceLawIR::MixingConductance {
                    g_up_spm2: *g_up_spm2,
                    g_down_spm2: *g_down_spm2,
                    g_r_spm2: *g_r_spm2,
                    g_i_spm2: *g_i_spm2,
                    g_sml_spm2: *g_sml_spm2,
                    formula_version: formula_version.clone(),
                },
            ),
        };
        let from_mask = resolve_region_mask(from_ref, context, "spin interface from-side")?;
        let to_mask = resolve_region_mask(to_ref, context, "spin interface to-side")?;
        let (axis, sign) = axis_and_sign(normal)?;
        for face in internal_faces(context.grid_cells, axis) {
            let negative = face.negative_cell as usize;
            let positive = face.positive_cell as usize;
            let (from_cell, to_cell) = if sign > 0 && from_mask[negative] && to_mask[positive] {
                (negative, positive)
            } else if sign < 0 && from_mask[positive] && to_mask[negative] {
                (positive, negative)
            } else {
                continue;
            };
            if !claimed.insert(face) {
                return Err(vec![format!(
                    "spin interface face {face:?} is claimed more than once"
                )]);
            }
            resolved.push(ResolvedSpinInterfaceFaceIR {
                source_id: id.clone(),
                face,
                from_cell: from_cell as u64,
                to_cell: to_cell as u64,
                law: law.clone(),
            });
        }
        if !resolved.iter().any(|entry| entry.source_id == *id) {
            return Err(vec![format!(
                "spin interface '{id}' did not resolve to any structured face"
            )]);
        }
    }
    Ok(resolved)
}

fn axis_and_sign(normal: [f64; 3]) -> Result<(u8, i8), Vec<String>> {
    for axis in 0..3 {
        if (normal[axis].abs() - 1.0).abs() <= 1.0e-10
            && (0..3)
                .filter(|other| *other != axis)
                .all(|other| normal[other].abs() <= 1.0e-10)
        {
            return Ok((axis as u8, if normal[axis] > 0.0 { 1 } else { -1 }));
        }
    }
    Err(vec![
        "structured FDM spin interfaces require an axis-aligned unit normal".to_string(),
    ])
}

fn internal_faces(grid: [u32; 3], axis: u8) -> Vec<StructuredInternalFaceIR> {
    let [nx, ny, nz] = grid.map(|value| value as usize);
    let index = |x: usize, y: usize, z: usize| x + nx * (y + ny * z);
    let mut faces = Vec::new();
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let neighbor = match axis {
                    0 if x + 1 < nx => Some((x + 1, y, z)),
                    1 if y + 1 < ny => Some((x, y + 1, z)),
                    2 if z + 1 < nz => Some((x, y, z + 1)),
                    _ => None,
                };
                if let Some((px, py, pz)) = neighbor {
                    faces.push(StructuredInternalFaceIR {
                        axis,
                        negative_cell: index(x, y, z) as u64,
                        positive_cell: index(px, py, pz) as u64,
                    });
                }
            }
        }
    }
    faces
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::*;

    fn problem(device: ExecutionDevice) -> ProblemIR {
        let mut problem = ProblemIR::bootstrap_example();
        let region = RegionRefIR {
            object_id: "strip".into(),
            region_id: None,
        };
        let charge_surfaces = [
            ("x_min", [-1.0, 0.0, 0.0]),
            ("x_max", [1.0, 0.0, 0.0]),
            ("y_min", [0.0, -1.0, 0.0]),
            ("y_max", [0.0, 1.0, 0.0]),
            ("z_min", [0.0, 0.0, -1.0]),
            ("z_max", [0.0, 0.0, 1.0]),
        ];
        problem.current_modules = vec![CurrentModuleIR::CurrentTransport {
            name: "charge".into(),
            model: CurrentTransportModelIR::OhmicPoisson,
            current_density: None,
            solve_region: Some("strip".into()),
            conductivity_s_per_m: Some(4.0e6),
            coupling: TransportCouplingIR::OneWay,
            definition: Some(ChargeTransportDefinitionIR {
                domain: vec![region.clone()],
                materials: vec![ChargeTransportMaterialAssignmentIR {
                    region: region.clone(),
                    material: ChargeTransportMaterialIR {
                        sigma_spm: 4.0e6,
                        sigma_parallel_spm: None,
                        sigma_perpendicular_spm: None,
                        sigma_ahe_spm: None,
                    },
                }],
                boundaries: charge_surfaces
                    .into_iter()
                    .map(|(surface_id, orientation)| {
                        if surface_id == "x_min" || surface_id == "x_max" {
                            ChargeBoundaryIR::VoltageElectrode {
                                id: surface_id.into(),
                                surfaces: vec![SurfaceRefIR {
                                    object_id: "strip".into(),
                                    surface_id: surface_id.into(),
                                    orientation,
                                }],
                                potential_v: if surface_id == "x_max" { 0.1 } else { 0.0 },
                            }
                        } else {
                            ChargeBoundaryIR::Insulating {
                                id: surface_id.into(),
                                surfaces: vec![SurfaceRefIR {
                                    object_id: "strip".into(),
                                    surface_id: surface_id.into(),
                                    orientation,
                                }],
                            }
                        }
                    })
                    .collect(),
                gauge: ChargePotentialGaugeIR::DirichletReference,
                solver: ChargeSolverPolicyIR {
                    engine: "cg".into(),
                    linear: LinearTransportSolverPolicyIR {
                        relative_tolerance: 1.0e-10,
                        absolute_tolerance: 0.0,
                        max_iterations: 1000,
                    },
                    physical_residual_version: "charge_balance_integrated_l2.v1".into(),
                    operator_version: "fv_charge_harmonic_v1".into(),
                },
            }),
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
                    spin_capacitance_as_per_v_m3: None,
                    capacitance_formula_version: None,
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
                reciprocal_nonlinear: None,
            },
            requested_execution: RequestedTransportExecutionIR {
                discretization: BackendTarget::Fdm,
                device,
                precision: ExecutionPrecision::Double,
                execution_mode: ExecutionMode::Strict,
            },
            constitutive_version: "transport_constitutive.one_way.fullmag.v1".into(),
        }];
        problem.spin_torque_modules = vec![SpinTorqueModuleIR::DriftDiffusionSpinTorque {
            schema_version: "drift_diffusion_spin_torque.v1".into(),
            id: "transport_torque".into(),
            solve_id: "spin".into(),
            target: region,
            formula_version: "transport_torque_angular_momentum.fullmag.v1".into(),
        }];
        problem
    }

    fn reciprocal_problem(device: ExecutionDevice) -> ProblemIR {
        let mut problem = problem(device);
        let CurrentModuleIR::CurrentTransport {
            model,
            coupling,
            definition,
            solve_region,
            conductivity_s_per_m,
            ..
        } = &mut problem.current_modules[0]
        else {
            unreachable!()
        };
        *model = CurrentTransportModelIR::MagnetoresistivePoisson;
        *coupling = TransportCouplingIR::Bidirectional;
        *solve_region = None;
        *conductivity_s_per_m = None;
        let material = &mut definition.as_mut().expect("charge definition").materials[0].material;
        material.sigma_parallel_spm = Some(4.4e6);
        material.sigma_perpendicular_spm = Some(4.0e6);
        material.sigma_ahe_spm = Some(0.2e6);
        let charge_solver = &mut definition.as_mut().unwrap().solver;
        charge_solver.engine = "block_gmres".into();
        charge_solver.operator_version = "fdm_coupled_charge_spin_fv_block_gmres.v1".into();
        charge_solver.physical_residual_version = "transport_balance_integrated_l2.v1".into();
        let spin = &mut problem.spin_transport_modules[0];
        spin.constitutive_version = "transport_constitutive.reciprocal.fullmag.v1".into();
        spin.solver.operator_version = "fdm_coupled_charge_spin_fv_block_gmres.v1".into();
        spin.solver.reciprocal_nonlinear = Some(ReciprocalNonlinearSolverPolicyIR {
            gmres_restart: 40,
            max_picard_iterations: 4,
            relative_update_tolerance: 1e-9,
            eta_transport: 0.25,
        });
        problem
    }

    fn context<'a>(
        owner_names: &'a [&'a str],
        region_mask: &'a [u32],
        magnetization: &'a [[f64; 3]],
        ms: &'a [f64],
        region_ids: &'a BTreeMap<String, u32>,
    ) -> FdmSpinTransportResolutionContext<'a> {
        FdmSpinTransportResolutionContext {
            owner_names,
            grid_cells: [1, 1, 1],
            active_mask: None,
            region_mask,
            region_index_by_id: region_ids,
            initial_magnetization: magnetization,
            saturation_magnetization_apm: ms,
            gamma0_m_per_a_s: 2.211e5,
        }
    }

    #[test]
    fn resolves_only_fdm_cpu_double_and_preserves_requested_intent() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let context = context(&owners, &region_mask, &magnetization, &ms, &region_ids);
        let plans =
            resolve_spin_transport(&problem(ExecutionDevice::Cpu), BackendTarget::Fdm, &context)
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
        assert!(
            plans[0].fdm_cpu_double.is_some(),
            "planner must materialize the executable FDM descriptor"
        );
    }

    #[test]
    fn resolves_bidirectional_m2_to_separate_reciprocal_descriptor() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let problem = reciprocal_problem(ExecutionDevice::Cpu);
        problem
            .validate()
            .expect("authored M2 problem should satisfy canonical IR validation");
        let plans = resolve_spin_transport(
            &problem,
            BackendTarget::Fdm,
            &context(&owners, &region_mask, &magnetization, &ms, &region_ids),
        )
        .expect("M2 should resolve on FDM CPU double");

        let plan = &plans[0];
        assert_eq!(plan.resolved_coupling, TransportCouplingIR::Bidirectional);
        assert!(plan.fdm_cpu_double.is_none());
        let descriptor = plan
            .fdm_cpu_double_reciprocal
            .as_ref()
            .expect("separate reciprocal descriptor");
        assert_eq!(descriptor.reciprocal_materials[0].sigma_parallel_spm, 4.4e6);
        assert_eq!(descriptor.reciprocal_materials[0].sigma_ahe_spm, 0.2e6);
        assert!(plan
            .capabilities
            .iter()
            .any(|capability| capability == "transport.spin.inverse_she"));
    }

    #[test]
    fn rejects_m2_missing_anisotropic_charge_tensor_without_fallback() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let mut problem = reciprocal_problem(ExecutionDevice::Cpu);
        let CurrentModuleIR::CurrentTransport { definition, .. } = &mut problem.current_modules[0]
        else {
            unreachable!()
        };
        definition.as_mut().unwrap().materials[0]
            .material
            .sigma_parallel_spm = None;
        let error = resolve_spin_transport(
            &problem,
            BackendTarget::Fdm,
            &context(&owners, &region_mask, &magnetization, &ms, &region_ids),
        )
        .expect_err("incomplete reciprocal material must fail closed");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("sigma_parallel")));
    }

    #[test]
    fn forced_gpu_fails_closed() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let context = context(&owners, &region_mask, &magnetization, &ms, &region_ids);
        let error =
            resolve_spin_transport(&problem(ExecutionDevice::Gpu), BackendTarget::Fdm, &context)
                .expect_err("GPU must not silently fall back");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("cannot fall back silently")));
    }

    #[test]
    fn resolves_transient_fdm_cpu_double_with_physical_capacitance_and_versions() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let mut problem = problem(ExecutionDevice::Cpu);
        let spin = &mut problem.spin_transport_modules[0];
        spin.mode = SpinTransportModeIR::Transient;
        spin.materials[0].material.spin_capacitance_as_per_v_m3 = Some(2.5);
        spin.materials[0].material.capacitance_formula_version =
            Some("dos_constant.fullmag.v1".into());
        let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut problem.study else {
            unreachable!()
        };
        let fullmag_ir::DynamicsIR::Llg { integrator, .. } = dynamics;
        *integrator = "coupled_imex_ark2".into();

        let plans = resolve_spin_transport(
            &problem,
            BackendTarget::Fdm,
            &context(&owners, &region_mask, &magnetization, &ms, &region_ids),
        )
        .expect("M3 should resolve on FDM CPU double");
        let descriptor = plans[0]
            .fdm_cpu_double_transient
            .as_ref()
            .expect("dedicated transient descriptor");
        assert_eq!(descriptor.spin_capacitance_as_per_v_m3, [2.5]);
        assert_eq!(
            descriptor.capacitance_formula_versions,
            ["dos_constant.fullmag.v1"]
        );
        assert_eq!(descriptor.integrator_version, "coupled_imex_ark2.v1");
        assert_eq!(
            descriptor.integrator,
            fullmag_ir::CoupledSpinIntegratorIR::CoupledImexArk2
        );
        assert!(plans[0]
            .capabilities
            .contains(&"transport.spin.transient_drift_diffusion".to_string()));
        let provenance = serde_json::to_value(&plans[0]).expect("resolved plan provenance");
        assert_eq!(
            provenance["fdm_cpu_double_transient"]["spin_capacitance_As_per_V_m3"][0],
            2.5
        );
        assert_eq!(
            provenance["fdm_cpu_double_transient"]["capacitance_formula_versions"][0],
            "dos_constant.fullmag.v1"
        );
    }

    #[test]
    fn transient_reference_execution_rejects_non_strict_mode() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let mut problem = problem(ExecutionDevice::Cpu);
        problem.validation_profile.execution_mode = ExecutionMode::Extended;
        let spin = &mut problem.spin_transport_modules[0];
        spin.mode = SpinTransportModeIR::Transient;
        spin.requested_execution.execution_mode = ExecutionMode::Extended;
        spin.requested_execution.device = ExecutionDevice::Gpu;
        spin.materials[0].material.spin_capacitance_as_per_v_m3 = Some(2.5);
        spin.materials[0].material.capacitance_formula_version =
            Some("dos_constant.fullmag.v1".into());
        let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut problem.study else {
            unreachable!()
        };
        let fullmag_ir::DynamicsIR::Llg { integrator, .. } = dynamics;
        *integrator = "coupled_imex_ark2".into();

        let error = resolve_spin_transport(
            &problem,
            BackendTarget::Fdm,
            &context(&owners, &region_mask, &magnetization, &ms, &region_ids),
        )
        .expect_err("M3 reference execution must remain strict-only");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("strict execution mode")));
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("transient M3 reference execution supports CPU double")));
        assert!(error
            .reasons
            .iter()
            .all(|reason| !reason.contains("steady M1/M2")));
    }

    fn fem_problem() -> ProblemIR {
        let mut problem = problem(ExecutionDevice::Cpu);
        let CurrentModuleIR::CurrentTransport {
            definition: Some(charge),
            ..
        } = &mut problem.current_modules[0]
        else {
            panic!("charge fixture");
        };
        charge.boundaries = vec![
            ChargeBoundaryIR::VoltageElectrode {
                id: "ground".into(),
                surfaces: vec![SurfaceRefIR {
                    object_id: "strip".into(),
                    surface_id: "bottom".into(),
                    orientation: [0.0, 0.0, -1.0],
                }],
                potential_v: 0.0,
            },
            ChargeBoundaryIR::VoltageElectrode {
                id: "drive".into(),
                surfaces: vec![SurfaceRefIR {
                    object_id: "strip".into(),
                    surface_id: "back".into(),
                    orientation: [0.0, -1.0, 0.0],
                }],
                potential_v: 0.1,
            },
            ChargeBoundaryIR::Insulating {
                id: "natural-zero-flux".into(),
                surfaces: vec![SurfaceRefIR {
                    object_id: "strip".into(),
                    surface_id: "left".into(),
                    orientation: [-1.0, 0.0, 0.0],
                }],
            },
        ];
        charge.solver.operator_version = "fem_charge_conforming_h1_p1.transparent.v1".into();
        charge.solver.linear = problem.spin_transport_modules[0].solver.linear.clone();
        problem.spin_transport_modules[0]
            .requested_execution
            .discretization = BackendTarget::Fem;
        problem.spin_transport_modules[0].solver.operator_version =
            "fem_charge_spin_conforming_h1_p1.transparent.v1".into();
        problem.spin_transport_modules[0].materials[0]
            .material
            .lambda_j_m = ReactionLengthIR::Disabled(DisabledReactionIR::Disabled);
        problem.spin_torque_modules.clear();
        problem
    }

    fn fem_mesh_fixture() -> (MeshIR, Vec<FemObjectSegmentIR>, Vec<FemMeshPartIR>) {
        let mesh = MeshIR {
            mesh_name: "tet".into(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![7],
            boundary_faces: vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
            boundary_markers: vec![11, 12, 13, 13],
            periodic_boundary_pairs: vec![],
            periodic_node_pairs: vec![],
            per_domain_quality: Default::default(),
        };
        let segment = FemObjectSegmentIR {
            object_id: "strip".into(),
            geometry_id: None,
            node_start: 0,
            node_count: 4,
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 4,
        };
        let part = FemMeshPartIR {
            id: "strip".into(),
            label: "strip".into(),
            role: FemMeshPartRole::MagneticObject,
            object_id: Some("strip".into()),
            geometry_id: None,
            material_id: None,
            element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 1 },
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 0, count: 4 },
            node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 4 },
            boundary_face_indices: vec![0, 1, 2, 3],
            node_indices: vec![0, 1, 2, 3],
            surface_faces: vec![],
            bounds_min: Some([0.0, 0.0, 0.0]),
            bounds_max: Some([1.0, 1.0, 1.0]),
            parent_id: None,
        };
        (mesh, vec![segment], vec![part])
    }

    #[test]
    fn resolves_canonical_fem_descriptor_without_hidden_defaults() {
        let problem = fem_problem();
        let (mesh, segments, parts) = fem_mesh_fixture();
        let plans = resolve_m1_fem_spin_transport(
            &problem,
            &mesh,
            &segments,
            &parts,
            &[[0.0, 0.0, 1.0]; 4],
            8.0e5,
            2.211e5,
        )
        .expect("canonical FEM descriptor");
        let descriptor = plans[0]
            .fem_cpu_double
            .as_ref()
            .expect("executable FEM descriptor");
        assert_eq!(descriptor.charge_conductivity_spm_per_element, [4.0e6]);
        assert_eq!(descriptor.charge_dirichlet, [(11, 0.0), (12, 0.1)]);
        assert_eq!(descriptor.charge_domain.element_mask, [true]);
        assert_eq!(descriptor.spin_domain.element_mask, [true]);
        assert_eq!(
            descriptor.charge_insulating_boundaries[0].boundary_attributes,
            [13]
        );
        assert_eq!(
            descriptor.spin_insulating_boundaries[0].boundary_attributes,
            [11, 12, 13]
        );
        assert_eq!(
            plans[0].requested_execution.discretization,
            BackendTarget::Fem
        );
        assert_eq!(plans[0].resolved_discretization, BackendTarget::Fem);
        assert_eq!(plans[0].resolved_device, ExecutionDevice::Cpu);
        assert_eq!(
            plans[0].capabilities,
            [
                "transport.charge.ohmic",
                "transport.spin.steady_drift_diffusion",
                "transport.spin.direct_she",
                "transport.coupling.one_way",
            ]
        );
        assert_eq!(descriptor.capability_status, "reference_executable");
        assert_eq!(descriptor.implementation_state, "executable");
        assert_eq!(descriptor.validation_state, "algebra_validated");
        assert_eq!(
            descriptor.validation_scope,
            "fem_cpu_double_conforming_h1_p1_transparent_m1"
        );
        assert_eq!(
            plans[0].inserted_default_boundaries,
            ["spin:all_external_surfaces=spin_insulating"]
        );
    }

    #[test]
    fn fem_boundary_partitions_require_coverage_and_reject_conflicts() {
        let (mesh, segments, parts) = fem_mesh_fixture();
        let resolve = |problem: &ProblemIR| {
            resolve_m1_fem_spin_transport(
                problem,
                &mesh,
                &segments,
                &parts,
                &[[0.0, 0.0, 1.0]; 4],
                8.0e5,
                2.211e5,
            )
        };

        let mut incomplete = fem_problem();
        let CurrentModuleIR::CurrentTransport {
            definition: Some(charge),
            ..
        } = &mut incomplete.current_modules[0]
        else {
            panic!("charge fixture");
        };
        charge.boundaries.pop();
        let error = resolve(&incomplete).expect_err("incomplete charge coverage must fail");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("do not cover")));

        let mut charge_conflict = fem_problem();
        let CurrentModuleIR::CurrentTransport {
            definition: Some(charge),
            ..
        } = &mut charge_conflict.current_modules[0]
        else {
            panic!("charge fixture");
        };
        charge.boundaries.push(ChargeBoundaryIR::Insulating {
            id: "conflict".into(),
            surfaces: vec![SurfaceRefIR {
                object_id: "strip".into(),
                surface_id: "bottom".into(),
                orientation: [0.0, 0.0, -1.0],
            }],
        });
        let error = resolve(&charge_conflict).expect_err("charge conflict must fail");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("conflicting FEM charge")));

        let mut spin_conflict = fem_problem();
        spin_conflict.spin_transport_modules[0].boundaries = vec![
            SpinBoundaryIR::SpinSink {
                id: "sink".into(),
                surfaces: vec![SurfaceRefIR {
                    object_id: "strip".into(),
                    surface_id: "bottom".into(),
                    orientation: [0.0, 0.0, -1.0],
                }],
            },
            SpinBoundaryIR::SpinInsulating {
                id: "insulating".into(),
                surfaces: vec![SurfaceRefIR {
                    object_id: "strip".into(),
                    surface_id: "bottom".into(),
                    orientation: [0.0, 0.0, -1.0],
                }],
            },
        ];
        let error = resolve(&spin_conflict).expect_err("spin conflict must fail");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("conflicting FEM spin")));

        let mut defaults = fem_problem();
        let CurrentModuleIR::CurrentTransport {
            definition: Some(charge),
            ..
        } = &mut defaults.current_modules[0]
        else {
            panic!("charge fixture");
        };
        charge.boundaries.clear();
        charge.gauge = ChargePotentialGaugeIR::ZeroMean;
        let plans = resolve(&defaults).expect("natural defaults should be explicit and complete");
        assert_eq!(
            plans[0].inserted_default_boundaries,
            [
                "charge:all_external_surfaces=insulating",
                "spin:all_external_surfaces=spin_insulating",
            ]
        );
        assert_eq!(
            plans[0]
                .fem_cpu_double
                .as_ref()
                .unwrap()
                .charge_insulating_boundaries[0]
                .boundary_attributes,
            [11, 12, 13]
        );
    }

    #[test]
    fn fem_v1_rejects_incompatible_charge_and_spin_linear_policies() {
        let (mesh, segments, parts) = fem_mesh_fixture();
        let mut problem = fem_problem();
        let CurrentModuleIR::CurrentTransport {
            definition: Some(charge),
            ..
        } = &mut problem.current_modules[0]
        else {
            panic!("charge fixture");
        };
        charge.solver.linear.relative_tolerance = 1.0e-7;

        let error = resolve_m1_fem_spin_transport(
            &problem,
            &mesh,
            &segments,
            &parts,
            &[[0.0, 0.0, 1.0]; 4],
            8.0e5,
            2.211e5,
        )
        .expect_err("the v1 ABI has one linear policy and must not synthesize one");

        assert!(error
            .reasons
            .iter()
            .any(|reason| { reason.contains("identical charge and spin linear solver policies") }));
    }

    #[test]
    fn fem_v1_requires_strict_execution_mode() {
        let (mesh, segments, parts) = fem_mesh_fixture();
        let mut problem = fem_problem();
        problem.spin_transport_modules[0]
            .requested_execution
            .execution_mode = ExecutionMode::Extended;

        let error = resolve_m1_fem_spin_transport(
            &problem,
            &mesh,
            &segments,
            &parts,
            &[[0.0, 0.0, 1.0]; 4],
            8.0e5,
            2.211e5,
        )
        .expect_err("FEM M1 v1 is strict-only");

        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("execution_mode=strict")));
    }

    #[test]
    fn fem_mapping_rejects_gpu_mixing_and_unimplemented_stage_coupling() {
        let (mesh, segments, parts) = fem_mesh_fixture();
        let assert_rejected = |problem: ProblemIR, needle: &str| {
            let error = resolve_m1_fem_spin_transport(
                &problem,
                &mesh,
                &segments,
                &parts,
                &[[0.0, 0.0, 1.0]; 4],
                8.0e5,
                2.211e5,
            )
            .expect_err("unsupported FEM lane must fail closed");
            assert!(
                error.reasons.iter().any(|reason| reason.contains(needle)),
                "{error:?}"
            );
        };

        let mut gpu = fem_problem();
        gpu.spin_transport_modules[0].requested_execution.device = ExecutionDevice::Gpu;
        assert_rejected(gpu, "GPU");

        let mut mixing = fem_problem();
        mixing.spin_transport_modules[0].interfaces = vec![SpinInterfaceIR::MixingConductance {
            id: "mix".into(),
            normal_to_ferromagnet: [1.0, 0.0, 0.0],
            normal_side: RegionRefIR {
                object_id: "strip".into(),
                region_id: None,
            },
            ferromagnet_side: RegionRefIR {
                object_id: "strip".into(),
                region_id: None,
            },
            g_up_spm2: 1.0,
            g_down_spm2: 1.0,
            g_r_spm2: 1.0,
            g_i_spm2: 0.0,
            g_sml_spm2: 0.0,
            absorption: "full".into(),
            formula_version: "mixing.v1".into(),
        }];
        assert_rejected(mixing, "broken-H1");

        let mut coupled = fem_problem();
        coupled
            .spin_torque_modules
            .push(SpinTorqueModuleIR::DriftDiffusionSpinTorque {
                schema_version: "drift_diffusion_spin_torque.v1".into(),
                id: "torque".into(),
                solve_id: "spin".into(),
                target: RegionRefIR {
                    object_id: "strip".into(),
                    region_id: None,
                },
                formula_version: "transport_torque_angular_momentum.fullmag.v1".into(),
            });
        assert_rejected(coupled, "stage coupling");

        let mut transient = fem_problem();
        transient.spin_transport_modules[0].mode = SpinTransportModeIR::Transient;
        assert_rejected(transient, "steady mode only");

        let mut normal_current = fem_problem();
        let CurrentModuleIR::CurrentTransport {
            definition: Some(charge),
            ..
        } = &mut normal_current.current_modules[0]
        else {
            panic!("charge fixture");
        };
        charge
            .boundaries
            .push(ChargeBoundaryIR::NormalCurrentElectrode {
                id: "current".into(),
                surfaces: vec![],
                outward_current_density_apm2: 1.0,
            });
        assert_rejected(normal_current, "normal-current electrodes");

        let mut spin_flux = fem_problem();
        spin_flux.spin_transport_modules[0]
            .boundaries
            .push(SpinBoundaryIR::SpecifiedSpinFlux {
                id: "spin_flux".into(),
                surfaces: vec![],
                normal_spin_flux_apm2: [1.0, 0.0, 0.0],
            });
        assert_rejected(spin_flux, "specified spin flux");
    }
}
