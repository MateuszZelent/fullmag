use fullmag_ir::{
    AntennaFieldSourceModelIR, BackendTarget, ChargePotentialGaugeIR, CurrentModuleIR,
    CurrentTransportModelIR, ExecutionPrecision, ProblemIR, ResolvedFdmGpuChargeTransportIR,
    TimeEnvelopeIR, TransportCouplingIR,
};

use crate::error::PlanError;
use crate::physics_graph::physics_module_execution_enabled;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ResolvedCurrentTransport {
    pub name: String,
    pub current_density: [f64; 3],
    pub solve_region: Option<String>,
    pub time_envelope: Option<TimeEnvelopeIR>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CurrentTransportExecutableLane {
    Fdm,
    Fem,
}

pub(crate) fn has_mqs_antenna_field_source(problem: &ProblemIR) -> bool {
    problem.current_modules.iter().any(|module| {
        matches!(
            module,
            CurrentModuleIR::AntennaFieldSource {
                model: AntennaFieldSourceModelIR::Mqs2p5dAz,
                ..
            }
        )
    })
}

pub(crate) fn resolve_current_transports(
    problem: &ProblemIR,
    lane: CurrentTransportExecutableLane,
) -> Result<Vec<ResolvedCurrentTransport>, PlanError> {
    let mut resolved = Vec::new();
    let mut reasons = Vec::new();

    for (index, module) in problem.current_modules.iter().enumerate() {
        if let CurrentModuleIR::CurrentTransport { name, .. } = module {
            match physics_module_execution_enabled(problem, "current_transport", name) {
                Ok(Some(false)) => continue,
                Ok(Some(true) | None) => {}
                Err(graph_reasons) => {
                    reasons.extend(graph_reasons);
                    continue;
                }
            }
        }
        match module {
            CurrentModuleIR::AntennaFieldSource { model, .. } => {
                if lane == CurrentTransportExecutableLane::Fdm
                    && *model == AntennaFieldSourceModelIR::Mqs2p5dAz
                {
                    reasons.push(format!(
                        "current_modules[{index}] antenna_field_source is not executable on the current FDM time-domain path"
                    ));
                }
            }
            CurrentModuleIR::CurrentTransport {
                name,
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density,
                solve_region,
                time_envelope,
                ..
            } => match current_density {
                Some(current_density) => resolved.push(ResolvedCurrentTransport {
                    name: name.clone(),
                    current_density: *current_density,
                    solve_region: solve_region.clone(),
                    time_envelope: time_envelope.clone(),
                }),
                None => reasons.push(format!(
                    "current_modules[{index}] current_transport prescribed_density requires current_density"
                )),
            },
            CurrentModuleIR::CurrentTransport {
                name,
                model:
                    CurrentTransportModelIR::OhmicPoisson
                    | CurrentTransportModelIR::MagnetoresistivePoisson,
                ..
            } => {
                if lane == CurrentTransportExecutableLane::Fem
                    && !problem
                        .spin_transport_modules
                        .iter()
                        .any(|module| module.current_source_id == *name)
                {
                    reasons.push(format!(
                        "current_modules[{index}] current_transport(ohmic_poisson) requires a bound FEM spin_transport module on the M1 lane"
                    ));
                }
                // M1 materializes the complete charge solve together with its
                // owning spin-transport plan. It deliberately does not
                // masquerade as a prescribed uniform-current source.
            }
        }
    }

    if reasons.is_empty() {
        Ok(resolved)
    } else {
        Err(PlanError { reasons })
    }
}

pub(crate) fn resolve_fdm_gpu_charge_transports(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
    context: &crate::spin_transport::FdmSpinTransportResolutionContext<'_>,
) -> Result<Vec<ResolvedFdmGpuChargeTransportIR>, PlanError> {
    let mut active_modules = Vec::new();
    let mut graph_reasons = Vec::new();
    for module in &problem.current_modules {
        let (kind, name) = match module {
            CurrentModuleIR::AntennaFieldSource { name, .. } => ("antenna_field_source", name),
            CurrentModuleIR::CurrentTransport { name, .. } => ("current_transport", name),
        };
        match physics_module_execution_enabled(problem, kind, name) {
            Ok(Some(false)) => {}
            Ok(Some(true) | None) => active_modules.push(module),
            Err(mut reasons) => graph_reasons.append(&mut reasons),
        }
    }
    if !graph_reasons.is_empty() {
        return Err(PlanError {
            reasons: graph_reasons,
        });
    }

    let has_ohmic = active_modules.iter().any(|module| {
        matches!(
            module,
            CurrentModuleIR::CurrentTransport {
                model: CurrentTransportModelIR::OhmicPoisson,
                ..
            }
        )
    });
    if !has_ohmic {
        return Ok(Vec::new());
    }

    let mut scope_reasons = Vec::new();
    if active_modules.len() != 1 {
        scope_reasons.push(format!(
            "exactly_one_active_current_module required, found {}",
            active_modules.len()
        ));
    }
    if problem.backend_policy.requested_backend != BackendTarget::Fdm
        || resolved_backend != BackendTarget::Fdm
    {
        scope_reasons.push(format!(
            "requested_backend={}",
            problem.backend_policy.requested_backend.as_str()
        ));
    }
    if !crate::util::runtime_requests_cuda(problem) {
        scope_reasons.push("requested_device=cpu_or_auto".into());
    }
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double {
        scope_reasons.push(format!(
            "requested_precision={:?}",
            problem.backend_policy.execution_precision
        ));
    }
    if problem.validation_profile.execution_mode != fullmag_ir::ExecutionMode::Strict {
        scope_reasons.push(format!(
            "execution_mode={:?}",
            problem.validation_profile.execution_mode
        ));
    }
    if problem
        .pbc
        .as_ref()
        .is_some_and(|pbc| pbc.has_any_periodic())
    {
        scope_reasons.push("periodic_charge_boundary=unsupported".into());
    }
    if !problem.spin_transport_modules.is_empty() || !problem.spin_torque_modules.is_empty() {
        scope_reasons.push("charge_only_requires_no_spin_transport_or_torque_modules".into());
    }
    if problem.energy_terms.iter().any(|term| {
        matches!(
            term,
            fullmag_ir::EnergyTermIR::OerstedField { .. }
                | fullmag_ir::EnergyTermIR::OerstedCylinder { .. }
        )
    }) {
        scope_reasons.push("oersted_coupling=unsupported".into());
    }

    let Some(CurrentModuleIR::CurrentTransport {
        name,
        model,
        coupling,
        time_envelope,
        definition,
        ..
    }) = active_modules.first().copied()
    else {
        scope_reasons.push("active_module=not_current_transport".into());
        return Err(fdm_gpu_charge_scope_error(scope_reasons));
    };
    if *model != CurrentTransportModelIR::OhmicPoisson {
        scope_reasons.push(format!("transport_model={model:?}"));
    }
    if *coupling != TransportCouplingIR::OneWay {
        scope_reasons.push(format!("transport_coupling={coupling:?}"));
    }
    if time_envelope.is_some() {
        scope_reasons.push("time_envelope=unsupported".into());
    }
    let Some(charge) = definition.as_ref() else {
        scope_reasons.push("complete_charge_definition=missing".into());
        return Err(fdm_gpu_charge_scope_error(scope_reasons));
    };
    if charge.conservative_current_view.is_some() || charge.structured_current_closure.is_some() {
        scope_reasons.push("current_closure_or_conservative_view=unsupported".into());
    }
    if charge.solver.engine != "cg"
        || charge.solver.operator_version != "fv_charge_harmonic_v1"
        || charge.solver.physical_residual_version != "charge_balance_integrated_l2.v1"
        || charge.solver.linear.absolute_tolerance != 0.0
    {
        scope_reasons.push(format!(
            "solver={}/{}/{}; absolute_tolerance={}",
            charge.solver.engine,
            charge.solver.operator_version,
            charge.solver.physical_residual_version,
            charge.solver.linear.absolute_tolerance
        ));
    }
    if !scope_reasons.is_empty() {
        return Err(fdm_gpu_charge_scope_error(scope_reasons));
    }

    let descriptor =
        crate::spin_transport::materialize_fdm_gpu_charge_descriptor(name, charge, context)
            .map_err(fdm_gpu_charge_scope_error)?;
    if descriptor.charge_active_cells.iter().any(|active| !*active) {
        return Err(fdm_gpu_charge_scope_error(vec![
            "charge_domain=not_full_rectangular_active_grid".into(),
        ]));
    }
    if !bounded_fdm_gpu_charge_has_single_numerically_connected_component(&descriptor, context) {
        return Err(fdm_gpu_charge_scope_error(vec![
            "charge_domain=not_single_numerically_connected_component".into(),
        ]));
    }
    if let Err(boundary_contract) = bounded_fdm_gpu_charge_boundary_profile(&descriptor, context) {
        return Err(fdm_gpu_charge_scope_error(vec![format!(
            "boundary_contract={boundary_contract}"
        )]));
    }
    Ok(vec![descriptor])
}

fn bounded_fdm_gpu_charge_has_single_numerically_connected_component(
    descriptor: &ResolvedFdmGpuChargeTransportIR,
    context: &crate::spin_transport::FdmSpinTransportResolutionContext<'_>,
) -> bool {
    let [nx_u32, ny_u32, nz_u32] = context.grid_cells;
    let nx = nx_u32 as usize;
    let ny = ny_u32 as usize;
    let nz = nz_u32 as usize;
    let Some(cell_count) = nx.checked_mul(ny).and_then(|count| count.checked_mul(nz)) else {
        return false;
    };
    if cell_count == 0 || descriptor.charge_conductivity_spm.len() != cell_count {
        return false;
    }
    let [hx, hy, hz] = context.cell_size_m;
    let face_area_m2 = [hy * hz, hx * hz, hx * hy];
    let spacing_m = [hx, hy, hz];
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let cell = x + nx * (y + ny * z);
                let neighbors = [
                    (x + 1 < nx, cell + 1, 0_usize),
                    (y + 1 < ny, cell + nx, 1_usize),
                    (z + 1 < nz, cell + nx * ny, 2_usize),
                ];
                for (present, neighbor, axis) in neighbors {
                    if !present {
                        continue;
                    }
                    let sigma_a = descriptor.charge_conductivity_spm[cell];
                    let sigma_b = descriptor.charge_conductivity_spm[neighbor];
                    let harmonic = 2.0 / (1.0 / sigma_a + 1.0 / sigma_b);
                    let conductance = harmonic * face_area_m2[axis] / spacing_m[axis];
                    if !conductance.is_finite() || conductance <= 0.0 {
                        return false;
                    }
                }
            }
        }
    }
    true
}

fn bounded_fdm_gpu_charge_boundary_profile(
    descriptor: &ResolvedFdmGpuChargeTransportIR,
    context: &crate::spin_transport::FdmSpinTransportResolutionContext<'_>,
) -> Result<(), &'static str> {
    use fullmag_ir::ResolvedChargeBoundaryConditionIR as Condition;

    let voltage = descriptor
        .charge_boundaries
        .iter()
        .filter(|boundary| matches!(boundary.condition, Condition::Voltage { .. }))
        .collect::<Vec<_>>();
    let current = descriptor
        .charge_boundaries
        .iter()
        .filter(|boundary| {
            matches!(
                boundary.condition,
                Condition::OutwardNormalCurrentDensity { .. }
            )
        })
        .collect::<Vec<_>>();
    let insulating = descriptor
        .charge_boundaries
        .iter()
        .filter(|boundary| matches!(boundary.condition, Condition::Insulating))
        .count();

    match descriptor.charge_gauge {
        ChargePotentialGaugeIR::DirichletReference => {
            if voltage.len() != 2 || !current.is_empty() || insulating != 4 {
                return Err("two_single_surface_voltage_electrodes_plus_insulating");
            }
            let Some((first_axis, first_side, _)) = boundary_face_geometry(voltage[0], context)
            else {
                return Err("voltage_electrode_geometry");
            };
            let Some((second_axis, second_side, _)) = boundary_face_geometry(voltage[1], context)
            else {
                return Err("voltage_electrode_geometry");
            };
            if voltage[0].source_id == voltage[1].source_id
                || first_axis != second_axis
                || first_side != -second_side
            {
                return Err("voltage_electrodes_must_be_on_opposite_faces_of_one_axis");
            }
            Ok(())
        }
        ChargePotentialGaugeIR::ZeroMean => {
            if !voltage.is_empty() || current.len() != 2 || insulating != 4 {
                return Err("two_opposite_balanced_current_density_electrodes_plus_insulating");
            }
            let Some((first_axis, first_side)) = current_boundary_geometry(current[0], context)
            else {
                return Err("current_density_electrode_geometry");
            };
            let Some((second_axis, second_side)) = current_boundary_geometry(current[1], context)
            else {
                return Err("current_density_electrode_geometry");
            };
            if first_axis != second_axis
                || first_side != -second_side
                || current[0].source_id == current[1].source_id
            {
                return Err("current_density_electrodes_must_be_on_opposite_faces_of_one_axis");
            }
            let Some((rhs_sum_a, rhs_l1_a)) =
                native_assembled_charge_rhs_balance(current.as_slice(), context)
            else {
                return Err("current_density_electrodes_must_have_finite_area_weighted_balance");
            };
            let compatibility_tolerance_a = 64.0 * f64::EPSILON * rhs_l1_a;
            if !compatibility_tolerance_a.is_finite()
                || (rhs_l1_a == 0.0 && rhs_sum_a != 0.0)
                || (rhs_l1_a != 0.0 && rhs_sum_a.abs() > compatibility_tolerance_a)
            {
                return Err("current_density_electrodes_must_have_finite_area_weighted_balance");
            }
            Ok(())
        }
    }
}

fn current_boundary_geometry(
    boundary: &fullmag_ir::ResolvedChargeBoundaryFaceIR,
    context: &crate::spin_transport::FdmSpinTransportResolutionContext<'_>,
) -> Option<(u8, i8)> {
    use fullmag_ir::ResolvedChargeBoundaryConditionIR as Condition;

    let (axis, side, _) = boundary_face_geometry(boundary, context)?;
    let Condition::OutwardNormalCurrentDensity { .. } = boundary.condition else {
        return None;
    };
    Some((axis, side))
}

fn native_assembled_charge_rhs_balance(
    current_boundaries: &[&fullmag_ir::ResolvedChargeBoundaryFaceIR],
    context: &crate::spin_transport::FdmSpinTransportResolutionContext<'_>,
) -> Option<(f64, f64)> {
    use fullmag_ir::{ResolvedChargeBoundaryConditionIR as Condition, StructuredBoundaryFaceIR};

    let [nx_u32, ny_u32, nz_u32] = context.grid_cells;
    let nx = usize::try_from(nx_u32).ok()?;
    let ny = usize::try_from(ny_u32).ok()?;
    let nz = usize::try_from(nz_u32).ok()?;
    let cell_count = nx.checked_mul(ny)?.checked_mul(nz)?;
    if cell_count == 0 || context.region_mask.len() != cell_count {
        return None;
    }
    let face_area_m2 = [
        context.cell_size_m[1] * context.cell_size_m[2],
        context.cell_size_m[0] * context.cell_size_m[2],
        context.cell_size_m[0] * context.cell_size_m[1],
    ];
    if face_area_m2
        .iter()
        .any(|area_m2| !area_m2.is_finite() || *area_m2 <= 0.0)
    {
        return None;
    }
    let mut rhs = vec![0.0; cell_count];
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let cell = x + nx * (y + ny * z);
                for axis in 0..3 {
                    for side in [-1_i8, 1_i8] {
                        let coordinate = match axis {
                            0 => x,
                            1 => y,
                            _ => z,
                        };
                        let extent = match axis {
                            0 => nx,
                            1 => ny,
                            _ => nz,
                        };
                        if (side < 0 && coordinate != 0) || (side > 0 && coordinate + 1 != extent) {
                            continue;
                        }
                        let face = match (axis, side) {
                            (0, -1) => StructuredBoundaryFaceIR::XMin,
                            (0, 1) => StructuredBoundaryFaceIR::XMax,
                            (1, -1) => StructuredBoundaryFaceIR::YMin,
                            (1, 1) => StructuredBoundaryFaceIR::YMax,
                            (2, -1) => StructuredBoundaryFaceIR::ZMin,
                            (2, 1) => StructuredBoundaryFaceIR::ZMax,
                            _ => unreachable!("loop only emits valid FDM exterior faces"),
                        };
                        let Some(boundary) = current_boundaries
                            .iter()
                            .find(|boundary| boundary.face == face)
                        else {
                            continue;
                        };
                        let Condition::OutwardNormalCurrentDensity {
                            current_density_apm2,
                        } = boundary.condition
                        else {
                            return None;
                        };
                        let term_a = face_area_m2[axis] * current_density_apm2;
                        if !term_a.is_finite() {
                            return None;
                        }
                        let source_a = rhs[cell] - term_a;
                        if !source_a.is_finite() {
                            return None;
                        }
                        rhs[cell] = source_a;
                    }
                }
            }
        }
    }
    let mut rhs_sum_a = 0.0;
    let mut rhs_l1_a = 0.0;
    for source_a in rhs {
        rhs_sum_a += source_a;
        rhs_l1_a += source_a.abs();
        if !rhs_sum_a.is_finite() || !rhs_l1_a.is_finite() {
            return None;
        }
    }
    Some((rhs_sum_a, rhs_l1_a))
}

fn boundary_face_geometry(
    boundary: &fullmag_ir::ResolvedChargeBoundaryFaceIR,
    context: &crate::spin_transport::FdmSpinTransportResolutionContext<'_>,
) -> Option<(u8, i8, f64)> {
    use fullmag_ir::StructuredBoundaryFaceIR;

    Some(match boundary.face {
        StructuredBoundaryFaceIR::XMin => (
            0,
            -1,
            f64::from(context.grid_cells[1])
                * f64::from(context.grid_cells[2])
                * context.cell_size_m[1]
                * context.cell_size_m[2],
        ),
        StructuredBoundaryFaceIR::XMax => (
            0,
            1,
            f64::from(context.grid_cells[1])
                * f64::from(context.grid_cells[2])
                * context.cell_size_m[1]
                * context.cell_size_m[2],
        ),
        StructuredBoundaryFaceIR::YMin => (
            1,
            -1,
            f64::from(context.grid_cells[0])
                * f64::from(context.grid_cells[2])
                * context.cell_size_m[0]
                * context.cell_size_m[2],
        ),
        StructuredBoundaryFaceIR::YMax => (
            1,
            1,
            f64::from(context.grid_cells[0])
                * f64::from(context.grid_cells[2])
                * context.cell_size_m[0]
                * context.cell_size_m[2],
        ),
        StructuredBoundaryFaceIR::ZMin => (
            2,
            -1,
            f64::from(context.grid_cells[0])
                * f64::from(context.grid_cells[1])
                * context.cell_size_m[0]
                * context.cell_size_m[1],
        ),
        StructuredBoundaryFaceIR::ZMax => (
            2,
            1,
            f64::from(context.grid_cells[0])
                * f64::from(context.grid_cells[1])
                * context.cell_size_m[0]
                * context.cell_size_m[1],
        ),
    })
}

fn fdm_gpu_charge_scope_error(reasons: Vec<String>) -> PlanError {
    PlanError {
        reasons: vec![format!(
            "fdm_gpu_charge_scope_rejected: {}; fallback=none",
            reasons.join("; ")
        )],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use fullmag_ir::{
        BackendPlanIR, BackendTarget, ChargeBoundaryIR, ChargePotentialGaugeIR,
        ChargeSolverPolicyIR, ChargeTransportDefinitionIR, ChargeTransportMaterialAssignmentIR,
        ChargeTransportMaterialIR, CurrentModuleIR, CurrentTransportModelIR, ExecutionDevice,
        ExecutionMode, ExecutionPrecision, LinearTransportSolverPolicyIR, RegionRefIR,
        ResolvedChargeBoundaryConditionIR, StructuredBoundaryFaceIR, SurfaceRefIR,
        TransportCouplingIR,
    };

    fn bounded_gpu_charge_problem() -> ProblemIR {
        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fdm;
        problem.backend_policy.execution_precision = ExecutionPrecision::Double;
        problem.validation_profile.execution_mode = ExecutionMode::Strict;
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".into(),
            serde_json::json!({"device": "cuda", "device_index": 0}),
        );
        let region = RegionRefIR {
            object_id: "strip".into(),
            region_id: None,
        };
        let surfaces = [
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
            solve_region: None,
            conductivity_s_per_m: None,
            coupling: TransportCouplingIR::OneWay,
            time_envelope: None,
            definition: Some(ChargeTransportDefinitionIR {
                domain: vec![region.clone()],
                materials: vec![ChargeTransportMaterialAssignmentIR {
                    region,
                    material: ChargeTransportMaterialIR {
                        sigma_spm: 4.0e6,
                        sigma_parallel_spm: None,
                        sigma_perpendicular_spm: None,
                        sigma_ahe_spm: None,
                    },
                }],
                boundaries: surfaces
                    .into_iter()
                    .map(|(surface_id, orientation)| {
                        let surface = SurfaceRefIR {
                            object_id: "strip".into(),
                            surface_id: surface_id.into(),
                            orientation,
                        };
                        if matches!(surface_id, "x_min" | "x_max") {
                            ChargeBoundaryIR::VoltageElectrode {
                                id: surface_id.into(),
                                surfaces: vec![surface],
                                potential_v: if surface_id == "x_max" { 0.1 } else { 0.0 },
                            }
                        } else {
                            ChargeBoundaryIR::Insulating {
                                id: surface_id.into(),
                                surfaces: vec![surface],
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
                conservative_current_view: None,
                structured_current_closure: None,
            }),
        }];
        problem
    }

    fn charge_definition_mut(problem: &mut ProblemIR) -> &mut ChargeTransportDefinitionIR {
        let CurrentModuleIR::CurrentTransport {
            definition: Some(definition),
            ..
        } = &mut problem.current_modules[0]
        else {
            panic!("bounded charge fixture");
        };
        definition
    }

    fn assert_gpu_charge_scope_rejected(problem: &ProblemIR, expected: &str) {
        let error = crate::plan(problem).expect_err("unsupported GPU charge scope must fail");
        assert!(
            error.reasons.iter().any(|reason| {
                reason.contains("fdm_gpu_charge_scope_rejected")
                    && reason.contains(expected)
                    && reason.contains("fallback=none")
            }),
            "expected {expected:?} in {:?}",
            error.reasons,
        );
    }

    fn one_cell_zero_mean_boundary_profile(x_max_density_apm2: f64) -> Result<(), &'static str> {
        let mut problem = bounded_gpu_charge_problem();
        let charge = charge_definition_mut(&mut problem);
        charge.gauge = ChargePotentialGaugeIR::ZeroMean;
        for boundary in &mut charge.boundaries {
            let ChargeBoundaryIR::VoltageElectrode { id, surfaces, .. } = boundary else {
                continue;
            };
            let outward_current_density_apm2 = if id == "x_min" {
                1.0
            } else {
                x_max_density_apm2
            };
            *boundary = ChargeBoundaryIR::NormalCurrentElectrode {
                id: std::mem::take(id),
                surfaces: std::mem::take(surfaces),
                outward_current_density_apm2,
            };
        }

        let owner_names = ["strip"];
        let region_mask = [0_u32];
        let magnetization = [[1.0, 0.0, 0.0]];
        let saturation_magnetization_apm = [800e3];
        let region_index_by_id = BTreeMap::from([("strip".to_string(), 0_u32)]);
        let context = crate::spin_transport::FdmSpinTransportResolutionContext {
            owner_names: &owner_names,
            grid_cells: [1, 1, 1],
            origin_m: [0.0; 3],
            cell_size_m: [1.0; 3],
            active_mask: None,
            region_mask: &region_mask,
            region_index_by_id: &region_index_by_id,
            initial_magnetization: &magnetization,
            saturation_magnetization_apm: &saturation_magnetization_apm,
            gamma0_m_per_a_s: 2.211e5,
        };
        let descriptor = crate::spin_transport::materialize_fdm_gpu_charge_descriptor(
            "charge",
            charge_definition_mut(&mut problem),
            &context,
        )
        .expect("one-cell public charge descriptor");
        bounded_fdm_gpu_charge_boundary_profile(&descriptor, &context)
    }

    fn two_cell_zero_mean_boundary_profile(conductivity_s_per_m: f64) -> Result<(), &'static str> {
        let mut problem = bounded_gpu_charge_problem();
        let charge = charge_definition_mut(&mut problem);
        charge.gauge = ChargePotentialGaugeIR::ZeroMean;
        charge.materials[0].material.sigma_spm = conductivity_s_per_m;
        for boundary in &mut charge.boundaries {
            let ChargeBoundaryIR::VoltageElectrode { id, surfaces, .. } = boundary else {
                continue;
            };
            let outward_current_density_apm2 = if id == "x_min" { 1.0 } else { -1.0 };
            *boundary = ChargeBoundaryIR::NormalCurrentElectrode {
                id: std::mem::take(id),
                surfaces: std::mem::take(surfaces),
                outward_current_density_apm2,
            };
        }

        let owner_names = ["strip"];
        let region_mask = [0_u32, 0_u32];
        let magnetization = [[1.0, 0.0, 0.0]; 2];
        let saturation_magnetization_apm = [800e3; 2];
        let region_index_by_id = BTreeMap::from([("strip".to_string(), 0_u32)]);
        let context = crate::spin_transport::FdmSpinTransportResolutionContext {
            owner_names: &owner_names,
            grid_cells: [2, 1, 1],
            origin_m: [0.0; 3],
            cell_size_m: [1.0; 3],
            active_mask: None,
            region_mask: &region_mask,
            region_index_by_id: &region_index_by_id,
            initial_magnetization: &magnetization,
            saturation_magnetization_apm: &saturation_magnetization_apm,
            gamma0_m_per_a_s: 2.211e5,
        };
        match resolve_fdm_gpu_charge_transports(&problem, BackendTarget::Fdm, &context) {
            Ok(_) => Ok(()),
            Err(error)
                if error.reasons.iter().any(|reason| {
                    reason.contains("charge_domain=not_single_numerically_connected_component")
                }) =>
            {
                Err("charge_domain=not_single_numerically_connected_component")
            }
            Err(error) => panic!("unexpected bounded public charge rejection: {error:?}"),
        }
    }

    #[test]
    fn bounded_public_fdm_gpu_zero_mean_rejects_one_cell_native_rhs_imbalance() {
        assert_eq!(
            one_cell_zero_mean_boundary_profile(-1.0 + 1.0e-15),
            Err("current_density_electrodes_must_have_finite_area_weighted_balance"),
        );
    }

    #[test]
    fn bounded_public_fdm_gpu_zero_mean_accepts_exactly_balanced_one_cell_rhs() {
        assert_eq!(one_cell_zero_mean_boundary_profile(-1.0), Ok(()));
    }

    #[test]
    fn bounded_public_fdm_gpu_zero_mean_rejects_underflowed_internal_conductance() {
        assert_eq!(
            two_cell_zero_mean_boundary_profile(5.0e-324),
            Err("charge_domain=not_single_numerically_connected_component"),
        );
    }

    #[test]
    fn bounded_public_fdm_gpu_zero_mean_accepts_positive_internal_conductance() {
        assert_eq!(two_cell_zero_mean_boundary_profile(4.0e6), Ok(()));
    }

    #[test]
    fn materializes_bounded_public_fdm_gpu_charge_plan() {
        let problem = bounded_gpu_charge_problem();
        let plan = crate::plan(&problem).expect("bounded FDM GPU charge plan");
        let BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
            panic!("expected FDM plan");
        };
        assert_eq!(fdm.fdm_gpu_charge_transports.len(), 1);
        let charge = &fdm.fdm_gpu_charge_transports[0];
        assert_eq!(charge.module_id, "charge");
        assert_eq!(charge.requested_execution.device, ExecutionDevice::Gpu);
        assert_eq!(charge.resolved_discretization, BackendTarget::Fdm);
        assert_eq!(charge.resolved_device, ExecutionDevice::Gpu);
        assert_eq!(charge.resolved_precision, ExecutionPrecision::Double);
        assert_eq!(charge.resolved_execution_mode, ExecutionMode::Strict);
        assert_eq!(charge.descriptor_revision, 1);
        assert_eq!(charge.source_revision, 1);
        assert_eq!(charge.validation_state, "source_contract_only");
        assert_eq!(charge.descriptor_sha256.len(), 71);
        assert!(charge.descriptor_sha256.starts_with("sha256:"));
        assert_eq!(charge.charge_active_cells.len(), 3000);
        assert!(charge.charge_active_cells.iter().all(|active| *active));
        assert!(charge
            .charge_conductivity_spm
            .iter()
            .all(|sigma| *sigma == 4.0e6));
        assert_eq!(charge.charge_boundaries.len(), 6);
        let faces = charge
            .charge_boundaries
            .iter()
            .map(|boundary| boundary.face)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            faces,
            [
                StructuredBoundaryFaceIR::XMin,
                StructuredBoundaryFaceIR::XMax,
                StructuredBoundaryFaceIR::YMin,
                StructuredBoundaryFaceIR::YMax,
                StructuredBoundaryFaceIR::ZMin,
                StructuredBoundaryFaceIR::ZMax,
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(
            charge
                .charge_boundaries
                .iter()
                .filter(|boundary| matches!(
                    boundary.condition,
                    ResolvedChargeBoundaryConditionIR::Voltage { .. }
                ))
                .count(),
            2
        );
        assert_eq!(
            charge
                .charge_boundaries
                .iter()
                .filter(|boundary| matches!(
                    boundary.condition,
                    ResolvedChargeBoundaryConditionIR::Insulating
                ))
                .count(),
            4
        );
    }

    #[test]
    fn bounded_public_fdm_gpu_charge_rejects_cpu_without_fallback() {
        let mut problem = bounded_gpu_charge_problem();
        problem
            .problem_meta
            .runtime_metadata
            .remove("runtime_selection");
        let error = crate::plan(&problem).expect_err("CPU request must fail closed");
        assert!(error.reasons.iter().any(|reason| {
            reason.contains("fdm_gpu_charge_scope_rejected")
                && reason.contains("requested_device=cpu_or_auto")
                && reason.contains("fallback=none")
        }));
    }

    #[test]
    fn bounded_public_fdm_gpu_charge_rejects_another_active_current_module() {
        let mut problem = bounded_gpu_charge_problem();
        problem
            .current_modules
            .push(CurrentModuleIR::CurrentTransport {
                name: "extra".into(),
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 1.0e10]),
                solve_region: None,
                conductivity_s_per_m: None,
                coupling: TransportCouplingIR::OneWay,
                time_envelope: None,
                definition: None,
            });
        let error = crate::plan(&problem).expect_err("mixed current graph must fail closed");
        assert!(error.reasons.iter().any(|reason| {
            reason.contains("fdm_gpu_charge_scope_rejected")
                && reason.contains("exactly_one_active_current_module")
                && reason.contains("fallback=none")
        }));
    }

    #[test]
    fn bounded_public_fdm_gpu_charge_rejects_every_unqualified_execution_axis() {
        let mut auto_backend = bounded_gpu_charge_problem();
        auto_backend.backend_policy.requested_backend = BackendTarget::Auto;
        assert_gpu_charge_scope_rejected(&auto_backend, "requested_backend=auto");

        let mut single = bounded_gpu_charge_problem();
        single.backend_policy.execution_precision = ExecutionPrecision::Single;
        assert_gpu_charge_scope_rejected(&single, "requested_precision=Single");

        let mut extended = bounded_gpu_charge_problem();
        extended.validation_profile.execution_mode = ExecutionMode::Extended;
        assert_gpu_charge_scope_rejected(&extended, "execution_mode=Extended");

        let mut automatic_solver = bounded_gpu_charge_problem();
        charge_definition_mut(&mut automatic_solver).solver.engine = "auto".into();
        assert_gpu_charge_scope_rejected(&automatic_solver, "solver=auto/");

        let mut nonzero_absolute_tolerance = bounded_gpu_charge_problem();
        charge_definition_mut(&mut nonzero_absolute_tolerance)
            .solver
            .linear
            .absolute_tolerance = 1.0e-20;
        assert_gpu_charge_scope_rejected(
            &nonzero_absolute_tolerance,
            "absolute_tolerance=0.00000000000000000001",
        );

        let mut reciprocal = bounded_gpu_charge_problem();
        let CurrentModuleIR::CurrentTransport { coupling, .. } = &mut reciprocal.current_modules[0]
        else {
            panic!("bounded charge fixture");
        };
        *coupling = TransportCouplingIR::Bidirectional;
        assert_gpu_charge_scope_rejected(&reciprocal, "transport_coupling=Bidirectional");
    }

    #[test]
    fn materializes_bounded_public_fdm_gpu_zero_mean_charge_plan() {
        let mut problem = bounded_gpu_charge_problem();
        let charge = charge_definition_mut(&mut problem);
        charge.gauge = ChargePotentialGaugeIR::ZeroMean;
        for boundary in &mut charge.boundaries {
            let ChargeBoundaryIR::VoltageElectrode { id, surfaces, .. } = boundary else {
                continue;
            };
            let outward_current_density_apm2 = if id == "x_min" { 2.0e13 } else { -2.0e13 };
            *boundary = ChargeBoundaryIR::NormalCurrentElectrode {
                id: std::mem::take(id),
                surfaces: std::mem::take(surfaces),
                outward_current_density_apm2,
            };
        }
        let plan = crate::plan(&problem).expect("bounded zero-mean FDM GPU charge plan");
        let BackendPlanIR::Fdm(fdm) = plan.backend_plan else {
            panic!("expected FDM plan");
        };
        assert_eq!(fdm.fdm_gpu_charge_transports.len(), 1);
        let charge = &fdm.fdm_gpu_charge_transports[0];
        assert_eq!(charge.charge_gauge, ChargePotentialGaugeIR::ZeroMean);
        assert_eq!(
            charge
                .charge_boundaries
                .iter()
                .filter(|boundary| matches!(
                    boundary.condition,
                    ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity { .. }
                ))
                .count(),
            2
        );
        assert_eq!(
            charge
                .charge_boundaries
                .iter()
                .filter(|boundary| matches!(
                    boundary.condition,
                    ResolvedChargeBoundaryConditionIR::Insulating
                ))
                .count(),
            4
        );
    }

    #[test]
    fn bounded_public_fdm_gpu_zero_mean_charge_rejects_invalid_electrode_profiles() {
        let mut same_sign = bounded_gpu_charge_problem();
        let charge = charge_definition_mut(&mut same_sign);
        charge.gauge = ChargePotentialGaugeIR::ZeroMean;
        for boundary in &mut charge.boundaries {
            let ChargeBoundaryIR::VoltageElectrode { id, surfaces, .. } = boundary else {
                continue;
            };
            *boundary = ChargeBoundaryIR::NormalCurrentElectrode {
                id: std::mem::take(id),
                surfaces: std::mem::take(surfaces),
                outward_current_density_apm2: 2.0e13,
            };
        }
        assert_gpu_charge_scope_rejected(&same_sign, "boundary_contract=");

        let mut different_axes = same_sign.clone();
        let charge = charge_definition_mut(&mut different_axes);
        let x_max = charge
            .boundaries
            .iter_mut()
            .find(|boundary| matches!(boundary, ChargeBoundaryIR::NormalCurrentElectrode { id, .. } if id == "x_max"))
            .expect("x-max current electrode");
        *x_max = ChargeBoundaryIR::Insulating {
            id: "x_max".into(),
            surfaces: vec![SurfaceRefIR {
                object_id: "strip".into(),
                surface_id: "x_max".into(),
                orientation: [1.0, 0.0, 0.0],
            }],
        };
        let y_max = charge
            .boundaries
            .iter_mut()
            .find(|boundary| matches!(boundary, ChargeBoundaryIR::Insulating { id, .. } if id == "y_max"))
            .expect("y-max insulating boundary");
        *y_max = ChargeBoundaryIR::NormalCurrentElectrode {
            id: "y_max".into(),
            surfaces: vec![SurfaceRefIR {
                object_id: "strip".into(),
                surface_id: "y_max".into(),
                orientation: [0.0, 1.0, 0.0],
            }],
            // The x-face has 10 x 3 cells and the y-face has 100 x 3 cells
            // in this intentionally non-cubic fixture.
            // Keep the integrated currents balanced so this isolates the
            // same-axis constraint.
            outward_current_density_apm2: -2.0e13 / 10.0,
        };
        assert_gpu_charge_scope_rejected(
            &different_axes,
            "boundary_contract=current_density_electrodes_must_be_on_opposite_faces_of_one_axis",
        );

        let mut mixed = same_sign.clone();
        let charge = charge_definition_mut(&mut mixed);
        let x_min = charge
            .boundaries
            .iter_mut()
            .find(|boundary| matches!(boundary, ChargeBoundaryIR::NormalCurrentElectrode { id, .. } if id == "x_min"))
            .expect("x-min current electrode");
        *x_min = ChargeBoundaryIR::VoltageElectrode {
            id: "x_min".into(),
            surfaces: vec![SurfaceRefIR {
                object_id: "strip".into(),
                surface_id: "x_min".into(),
                orientation: [-1.0, 0.0, 0.0],
            }],
            potential_v: 0.0,
        };
        let mixed_error = crate::plan(&mixed).expect_err("mixed boundary profile must fail");
        assert!(mixed_error
            .reasons
            .iter()
            .any(|reason| reason.contains("gauge=zero_mean conflicts with voltage electrodes")));

        let mut wrong_gauge = same_sign;
        charge_definition_mut(&mut wrong_gauge).gauge = ChargePotentialGaugeIR::DirichletReference;
        let wrong_gauge_error = crate::plan(&wrong_gauge).expect_err("gauge mismatch must fail");
        assert!(
            wrong_gauge_error.reasons.iter().any(|reason| {
                reason.contains("gauge=dirichlet_reference requires a voltage electrode")
            }),
            "unexpected gauge mismatch rejection: {:?}",
            wrong_gauge_error.reasons,
        );
    }

    #[test]
    fn bounded_public_fdm_gpu_zero_mean_charge_rejects_small_area_weighted_imbalance() {
        let mut problem = bounded_gpu_charge_problem();
        let charge = charge_definition_mut(&mut problem);
        charge.gauge = ChargePotentialGaugeIR::ZeroMean;
        for boundary in &mut charge.boundaries {
            let ChargeBoundaryIR::VoltageElectrode { id, surfaces, .. } = boundary else {
                continue;
            };
            let outward_current_density_apm2 = if id == "x_min" {
                2.0e13
            } else {
                // A 5e3 A/m2 density mismatch is 5e-13 A over this 1e-16 m2
                // terminal: the old hidden 1 A scale admitted it.
                -2.0e13 + 5.0e3
            };
            *boundary = ChargeBoundaryIR::NormalCurrentElectrode {
                id: std::mem::take(id),
                surfaces: std::mem::take(surfaces),
                outward_current_density_apm2,
            };
        }

        assert_gpu_charge_scope_rejected(
            &problem,
            "boundary_contract=current_density_electrodes_must_have_finite_area_weighted_balance",
        );
    }

    #[test]
    fn resolves_prescribed_density_for_fdm() {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .current_modules
            .push(CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: None,
                conductivity_s_per_m: None,
                coupling: fullmag_ir::TransportCouplingIR::OneWay,
                time_envelope: None,
                definition: None,
            });

        let resolved =
            resolve_current_transports(&problem, CurrentTransportExecutableLane::Fdm).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].name, "drive");
        assert_eq!(resolved[0].current_density, [0.0, 0.0, 5e10]);
        assert_eq!(resolved[0].solve_region, None);
    }

    #[test]
    fn inactive_graph_module_filters_nonzero_current_payload() {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .current_modules
            .push(CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: None,
                conductivity_s_per_m: None,
                coupling: fullmag_ir::TransportCouplingIR::OneWay,
                time_envelope: None,
                definition: None,
            });
        problem.physics_graph = Some(serde_json::json!({
            "schema_version": "physics_graph.v1",
            "scene_revision": 1,
            "modules": [{
                "id": "drive",
                "kind": "current_transport",
                "applies_to": [{"kind": "global"}],
                "solve_domain": [],
                "depends_on": [],
                "activation": "inactive"
            }],
            "edges": []
        }));

        let resolved = resolve_current_transports(&problem, CurrentTransportExecutableLane::Fdm)
            .expect("inactive graph payload is omitted");
        assert!(resolved.is_empty());
    }

    #[test]
    fn allows_prescribed_density_on_fem_lane() {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .current_modules
            .push(CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: None,
                conductivity_s_per_m: None,
                coupling: fullmag_ir::TransportCouplingIR::OneWay,
                time_envelope: None,
                definition: None,
            });

        let resolved =
            resolve_current_transports(&problem, CurrentTransportExecutableLane::Fem).unwrap();
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].name, "drive");
    }
}
