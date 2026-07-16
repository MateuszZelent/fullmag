use std::collections::{BTreeMap, BTreeSet};

use fullmag_ir::{
    BackendTarget, ChargeBoundaryIR, ExecutionDevice, ExecutionPrecision, ProblemIR,
    ReactionLengthIR, RegionRefIR, ResolvedChargeBoundaryConditionIR, ResolvedChargeBoundaryFaceIR,
    ResolvedFdmCoupledSpinTransportIR, ResolvedFdmSpinTransportIR,
    ResolvedFdmTransientSpinTransportIR, ResolvedReciprocalMaterialIR,
    ResolvedSpinBoundaryConditionIR, ResolvedSpinBoundaryFaceIR, ResolvedSpinInterfaceFaceIR,
    ResolvedSpinInterfaceLawIR, ResolvedSpinReactionLengthsIR, ResolvedSpinTransportPlanIR,
    SpinBoundaryIR, SpinInterfaceIR, SpinTorqueModuleIR, StructuredBoundaryFaceIR,
    StructuredInternalFaceIR,
};
#[cfg(test)]
use fullmag_ir::{ChargePotentialGaugeIR, TransportCouplingIR};

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
}
