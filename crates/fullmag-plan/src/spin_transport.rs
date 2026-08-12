use std::collections::{BTreeMap, BTreeSet};

use fullmag_ir::{
    BackendTarget, ChargeBoundaryIR, ExecutionDevice, ExecutionPrecision,
    FdmCpuTransportRealizationIR, FemMeshPartIR, FemObjectSegmentIR, MeshIR, ProblemIR,
    ReactionLengthIR, RegionRefIR, RequestedTransportExecutionIR,
    ResolvedChargeBoundaryConditionIR, ResolvedChargeBoundaryFaceIR,
    ResolvedFdmCoupledSpinTransportIR, ResolvedFdmGpuChargeTransportIR, ResolvedFdmSpinTransportIR,
    ResolvedFdmStructuredCurrentClosureIR, ResolvedFdmStructuredCurrentSourceCutIR,
    ResolvedFdmTransientSpinTransportIR, ResolvedFemSpinTransportIR, ResolvedReciprocalMaterialIR,
    ResolvedSpecifiedCurrentFaceIR, ResolvedSpinBoundaryConditionIR, ResolvedSpinBoundaryFaceIR,
    ResolvedSpinInterfaceFaceIR, ResolvedSpinInterfaceLawIR, ResolvedSpinReactionLengthsIR,
    ResolvedSpinTransportPlanIR, SpinBoundaryIR, SpinInterfaceIR, SpinTorqueModuleIR,
    StructuredBoundaryFaceIR, StructuredInternalFaceIR,
};
#[cfg(test)]
use fullmag_ir::{ChargePotentialGaugeIR, TransportCouplingIR};
use sha2::{Digest, Sha256};

use crate::physics_graph::physics_module_execution_enabled;
use crate::surface_selectors::resolve_fem_surface_selector;
use crate::PlanError;

const FEM_STAGE_OERSTED_CALLBACK_POLICY: &str = "fem_stage_oersted_callback.v1";
const FEM_STAGE_TRANSPORT_CALLBACK_POLICY: &str = "fem_stage_transport_callback.v1";
const FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY: &str = "fem_stage_transport_oersted_callback.v1";

#[cfg(test)]
fn resolve_fem_stage_coupling(
    reciprocal: bool,
    oersted_source_bound: bool,
    conservative_current_view: Option<&fullmag_ir::ResolvedFemConservativeCurrentViewIR>,
) -> &'static str {
    resolve_fem_stage_coupling_for_stage(
        reciprocal,
        oersted_source_bound,
        conservative_current_view,
    )
}

fn resolve_fem_stage_coupling_for_stage(
    reciprocal: bool,
    oersted_source_bound: bool,
    conservative_current_view: Option<&fullmag_ir::ResolvedFemConservativeCurrentViewIR>,
) -> &'static str {
    let supported_current_view = conservative_current_view.is_some_and(|view| {
        matches!(
            view.closure,
            fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry { .. }
                | fullmag_ir::ConservativeCurrentClosureIR::ExternalLead { .. }
        )
    });
    if !reciprocal && oersted_source_bound && supported_current_view {
        FEM_STAGE_OERSTED_CALLBACK_POLICY
    } else {
        "none"
    }
}

pub(crate) struct FdmSpinTransportResolutionContext<'a> {
    pub owner_names: &'a [&'a str],
    pub object_masks_by_id: Option<&'a BTreeMap<String, Vec<bool>>>,
    pub region_masks_by_ref: Option<&'a BTreeMap<(String, String), Vec<bool>>>,
    pub grid_cells: [u32; 3],
    pub origin_m: [f64; 3],
    pub cell_size_m: [f64; 3],
    pub active_mask: Option<&'a [bool]>,
    pub region_mask: &'a [u32],
    pub region_index_by_id: &'a BTreeMap<String, u32>,
    pub initial_magnetization: &'a [[f64; 3]],
    pub saturation_magnetization_apm: &'a [f64],
    /// Positive `gamma_0 = mu_0 |gamma_e|` in m/(A s).
    pub gamma0_m_per_a_s: f64,
}

#[derive(Debug, Default)]
pub(crate) struct ActiveFdmTransportGraph {
    pub spin_module_ids: BTreeSet<String>,
    pub torque_module_ids: BTreeSet<String>,
    pub coupled_current_source_ids: BTreeSet<String>,
    pub has_active_torque_modules: bool,
}

pub(crate) fn resolve_active_fdm_transport_graph(
    problem: &ProblemIR,
) -> Result<ActiveFdmTransportGraph, PlanError> {
    let mut graph = ActiveFdmTransportGraph {
        has_active_torque_modules: crate::spin_torque::has_active_spin_torque_modules(problem)?,
        ..ActiveFdmTransportGraph::default()
    };
    let mut errors = Vec::new();

    for spin in &problem.spin_transport_modules {
        match physics_module_execution_enabled(problem, "spin_transport", &spin.id) {
            Ok(Some(false)) => continue,
            Ok(Some(true) | None) => {}
            Err(mut reasons) => {
                errors.append(&mut reasons);
                continue;
            }
        }
        let source = problem.current_modules.iter().find(|module| {
            matches!(
                module,
                fullmag_ir::CurrentModuleIR::CurrentTransport { name, .. }
                    if name == &spin.current_source_id
            )
        });
        let Some(_) = source else {
            errors.push(format!(
                "active spin transport '{}' references missing current source '{}'",
                spin.id, spin.current_source_id
            ));
            continue;
        };
        match physics_module_execution_enabled(
            problem,
            "current_transport",
            &spin.current_source_id,
        ) {
            Ok(Some(false)) => {
                errors.push(format!(
                    "active spin transport '{}' references inactive current source '{}'",
                    spin.id, spin.current_source_id
                ));
                continue;
            }
            Ok(Some(true) | None) => {}
            Err(mut reasons) => {
                errors.append(&mut reasons);
                continue;
            }
        }
        graph.spin_module_ids.insert(spin.id.clone());
        graph
            .coupled_current_source_ids
            .insert(spin.current_source_id.clone());
    }

    for torque in &problem.spin_torque_modules {
        let SpinTorqueModuleIR::DriftDiffusionSpinTorque { id, solve_id, .. } = torque else {
            continue;
        };
        match physics_module_execution_enabled(problem, "spin_torque", id) {
            Ok(Some(false)) => continue,
            Ok(Some(true) | None) => {}
            Err(mut reasons) => {
                errors.append(&mut reasons);
                continue;
            }
        }
        if !graph.spin_module_ids.contains(solve_id) {
            errors.push(format!(
                "active spin torque '{}' references inactive spin transport '{}'",
                id, solve_id
            ));
            continue;
        }
        graph.torque_module_ids.insert(id.clone());
    }

    if errors.is_empty() {
        Ok(graph)
    } else {
        Err(PlanError { reasons: errors })
    }
}

#[cfg(test)]
pub(crate) fn resolve_spin_transport(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
    context: &FdmSpinTransportResolutionContext<'_>,
) -> Result<Vec<ResolvedSpinTransportPlanIR>, PlanError> {
    let active_graph = resolve_active_fdm_transport_graph(problem)?;
    resolve_spin_transport_with_active_graph(problem, resolved_backend, context, &active_graph)
}

pub(crate) fn resolve_spin_transport_with_active_graph(
    problem: &ProblemIR,
    resolved_backend: BackendTarget,
    context: &FdmSpinTransportResolutionContext<'_>,
    active_graph: &ActiveFdmTransportGraph,
) -> Result<Vec<ResolvedSpinTransportPlanIR>, PlanError> {
    let mut plans = Vec::with_capacity(problem.spin_transport_modules.len());
    let mut errors = Vec::new();
    for module in &problem.spin_transport_modules {
        if !active_graph.spin_module_ids.contains(&module.id) {
            continue;
        }
        let transient = module.mode == fullmag_ir::SpinTransportModeIR::Transient;
        let native_m1 = module.solver.engine == "native_m1_v1";
        let requested = &module.requested_execution;
        let public_gpu_m1_candidate = requested.device == ExecutionDevice::Gpu
            || problem
                .problem_meta
                .runtime_metadata
                .get("runtime_selection")
                .and_then(|selection| selection.get("device"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|device| matches!(device, "gpu" | "cuda"));
        if !matches!(
            module.solver.engine.as_str(),
            "auto" | "gmres" | "native_m1_v1"
        ) {
            errors.push(format!(
                "spin transport '{}' requests unsupported solver engine '{}'",
                module.id, module.solver.engine
            ));
        }
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
        if !public_gpu_m1_candidate
            && !matches!(
                requested.device,
                ExecutionDevice::Cpu | ExecutionDevice::Auto
            )
        {
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
                    time_envelope,
                    definition,
                    ..
                } if name == &module.current_source_id => Some((
                    *model,
                    *coupling,
                    time_envelope.as_ref(),
                    definition.as_ref(),
                )),
                _ => None,
            });
        let Some((source_model, coupling, time_envelope, charge_definition)) = source else {
            errors.push(format!(
                "spin transport '{}' references missing current source '{}'",
                module.id, module.current_source_id
            ));
            continue;
        };
        let reciprocal = coupling == fullmag_ir::TransportCouplingIR::Bidirectional;
        if public_gpu_m1_candidate {
            let scope_reasons = bounded_public_fdm_gpu_m1_scope_reasons(
                problem,
                module,
                resolved_backend,
                source_model,
                coupling,
                charge_definition,
            );
            if !scope_reasons.is_empty() {
                let unavailable_scope = if transient {
                    "transient M3 reference execution supports CPU double only"
                } else {
                    "steady M1/M2 GPU transport cannot fall back silently"
                };
                errors.push(format!(
                    "fdm_gpu_m1_scope_rejected: module='{}'; {}; {}; fallback=none",
                    module.id,
                    unavailable_scope,
                    scope_reasons.join("; ")
                ));
                continue;
            }
        }
        if native_m1 {
            if transient || reciprocal {
                errors.push(format!(
                    "spin transport '{}' native_m1_v1 supports steady one-way M1 only; M2/M3 fallback is forbidden",
                    module.id
                ));
            }
            if !public_gpu_m1_candidate
                && (requested.discretization != BackendTarget::Fdm
                    || requested.device != ExecutionDevice::Cpu
                    || requested.precision != ExecutionPrecision::Double
                    || requested.execution_mode != fullmag_ir::ExecutionMode::Strict)
            {
                errors.push(format!(
                    "spin transport '{}' native_m1_v1 requires explicit FDM/CPU/double/strict execution",
                    module.id
                ));
            }
            if problem.validation_profile.execution_mode != fullmag_ir::ExecutionMode::Strict {
                errors.push(format!(
                    "spin transport '{}' native_m1_v1 enclosing execution mode must be strict",
                    module.id
                ));
            }
            if charge_definition.is_some_and(|charge| charge.solver.engine != "cg") {
                errors.push(format!(
                    "spin transport '{}' native_m1_v1 requires the charge solver engine 'cg'",
                    module.id
                ));
            }
            if module.boundaries.iter().any(|boundary| {
                matches!(
                    boundary,
                    SpinBoundaryIR::SpecifiedSpinFlux { .. } | SpinBoundaryIR::PeriodicSpin { .. }
                )
            }) {
                errors.push(format!(
                    "spin transport '{}' native_m1_v1 does not support specified spin flux or periodic spin boundaries",
                    module.id
                ));
            }
            if module.interfaces.iter().any(|interface| {
                matches!(
                    interface,
                    SpinInterfaceIR::MixingConductance {
                        spin_memory_loss: Some(_),
                        ..
                    }
                )
            }) {
                errors.push(format!(
                    "spin transport '{}' native_m1_v1 does not support SML and cannot degrade it to mixing or transparent",
                    module.id
                ));
            }
        }
        let requests_sml_reservoir = module.interfaces.iter().any(|interface| {
            matches!(
                interface,
                fullmag_ir::SpinInterfaceIR::MixingConductance {
                    spin_memory_loss: Some(_),
                    ..
                }
            )
        });
        if requests_sml_reservoir && !reciprocal {
            errors.push(format!(
                "spin transport '{}' requests sml_reservoir.fullmag.v2, which requires bidirectional M2 coupling",
                module.id
            ));
            continue;
        }
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
        let descriptor = materialize_fdm_descriptor(
            problem,
            module,
            charge_definition,
            context,
            time_envelope,
            active_graph,
        );
        let (fdm_cpu_double, fdm_gpu_double, fdm_cpu_double_reciprocal, fdm_cpu_double_transient) =
            match descriptor {
                Ok(descriptor) if public_gpu_m1_candidate => (None, Some(descriptor), None, None),
                Ok(_descriptor) if transient && reciprocal => {
                    errors.push(format!(
                    "spin transport '{}' transient reciprocal M3 is not available in the FDM CPU v1 realization; fallback is forbidden",
                    module.id
                ));
                    (None, None, None, None)
                }
                Ok(descriptor) if transient => {
                    match materialize_transient_descriptor(module, context, descriptor) {
                        Ok(transient) => (None, None, None, Some(transient)),
                        Err(mut reasons) => {
                            errors.append(&mut reasons);
                            (None, None, None, None)
                        }
                    }
                }
                Ok(descriptor) if reciprocal => {
                    match materialize_m2_descriptor(module, charge_definition, context, descriptor)
                    {
                        Ok(coupled) => (None, None, Some(coupled), None),
                        Err(mut reasons) => {
                            errors.append(&mut reasons);
                            (None, None, None, None)
                        }
                    }
                }
                Ok(descriptor) => (Some(descriptor), None, None, None),
                Err(mut reasons) => {
                    errors.append(&mut reasons);
                    (None, None, None, None)
                }
            };
        plans.push(ResolvedSpinTransportPlanIR {
            module_id: module.id.clone(),
            current_source_id: module.current_source_id.clone(),
            resolved_coupling: coupling,
            requested_execution: requested.clone(),
            resolved_discretization: BackendTarget::Fdm,
            resolved_device: if public_gpu_m1_candidate {
                ExecutionDevice::Gpu
            } else {
                ExecutionDevice::Cpu
            },
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
                let mut capabilities = vec![
                    "transport.charge.magnetoresistive".to_string(),
                    "transport.spin.steady_drift_diffusion".to_string(),
                    "transport.spin.direct_she".to_string(),
                    "transport.spin.inverse_she".to_string(),
                    "transport.spin.mixing_conductance".to_string(),
                    "transport.coupling.bidirectional".to_string(),
                ];
                if requests_sml_reservoir {
                    capabilities.push("transport.spin.memory_loss".to_string());
                }
                capabilities
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
            fdm_gpu_double,
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

fn bounded_public_fdm_gpu_m1_scope_reasons(
    problem: &ProblemIR,
    module: &fullmag_ir::SpinTransportModuleIR,
    resolved_backend: BackendTarget,
    source_model: fullmag_ir::CurrentTransportModelIR,
    coupling: fullmag_ir::TransportCouplingIR,
    charge_definition: Option<&fullmag_ir::ChargeTransportDefinitionIR>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    let requested = &module.requested_execution;
    if problem.backend_policy.requested_backend != BackendTarget::Fdm
        || resolved_backend != BackendTarget::Fdm
        || requested.discretization != BackendTarget::Fdm
    {
        reasons.push("execution.discretization=not_explicit_fdm".into());
    }
    if requested.device != ExecutionDevice::Gpu {
        reasons.push("execution.device=not_explicit_gpu".into());
    }
    if problem.backend_policy.execution_precision != ExecutionPrecision::Double
        || requested.precision != ExecutionPrecision::Double
    {
        reasons.push("execution.precision=not_double".into());
    }
    if problem.validation_profile.execution_mode != fullmag_ir::ExecutionMode::Strict
        || requested.execution_mode != fullmag_ir::ExecutionMode::Strict
    {
        reasons.push("execution.mode=not_strict".into());
    }

    let runtime_selection = problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(serde_json::Value::as_object);
    if runtime_selection
        .and_then(|selection| selection.get("backend"))
        .and_then(serde_json::Value::as_str)
        != Some("fdm")
    {
        reasons.push("runtime_selection.backend=not_explicit_fdm".into());
    }
    if !runtime_selection
        .and_then(|selection| selection.get("device"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|device| matches!(device, "gpu" | "cuda"))
    {
        reasons.push("runtime_selection.device=not_explicit_gpu".into());
    }
    if runtime_selection
        .and_then(|selection| selection.get("execution_precision"))
        .and_then(serde_json::Value::as_str)
        != Some("double")
    {
        reasons.push("runtime_selection.precision=not_double".into());
    }
    if runtime_selection
        .and_then(|selection| selection.get("execution_mode"))
        .and_then(serde_json::Value::as_str)
        != Some("strict")
    {
        reasons.push("runtime_selection.mode=not_strict".into());
    }
    if runtime_selection
        .and_then(|selection| selection.get("gpu_count"))
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        reasons.push("runtime_selection.gpu_count=not_one".into());
    }

    if module.mode != fullmag_ir::SpinTransportModeIR::Steady
        || coupling != fullmag_ir::TransportCouplingIR::OneWay
        || source_model != fullmag_ir::CurrentTransportModelIR::OhmicPoisson
    {
        reasons.push("physics=not_steady_one_way_m1".into());
    }
    if module.solver.engine != "native_m1_v1" {
        reasons.push("spin_solver=not_native_m1_v1".into());
    }
    if charge_definition.is_none_or(|charge| charge.solver.engine != "cg") {
        reasons.push("charge_solver=not_cg".into());
    }
    if module
        .interfaces
        .iter()
        .filter(|interface| matches!(interface, SpinInterfaceIR::MixingConductance { .. }))
        .count()
        != 1
    {
        reasons.push("mixing_interface=requires_exactly_one_family".into());
    }
    if problem
        .pbc
        .as_ref()
        .is_some_and(|periodicity| periodicity.has_any_periodic())
    {
        reasons.push("periodic_transport=unsupported".into());
    }
    if problem
        .temperature
        .is_some_and(|temperature| temperature > 0.0)
        || problem
            .energy_terms
            .iter()
            .any(|term| matches!(term, fullmag_ir::EnergyTermIR::ThermalNoise { .. }))
    {
        reasons.push("thermal_noise=unsupported".into());
    }
    if problem.energy_terms.iter().any(|term| {
        matches!(
            term,
            fullmag_ir::EnergyTermIR::OerstedCylinder { .. }
                | fullmag_ir::EnergyTermIR::OerstedField { .. }
        )
    }) {
        reasons.push("oersted_coupling=unsupported".into());
    }
    reasons
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
            .resolved_spin_capacitance_as_per_v_m3()
            .ok_or_else(|| {
                vec![format!(
                    "spin transport '{}' transient material is missing physical spin capacitance or density of states",
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
        time_envelope: base.time_envelope,
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
const FEM_M2_CONSTITUTIVE_VERSION: &str = "transport_constitutive.reciprocal.fullmag.v1";
const FEM_M2_OPERATOR_VERSION: &str = "fem_charge_spin_conforming_h1_p1.reciprocal_m2.v1";
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
            errors.push(format!("{prefix} requested GPU, but bounded FEM steady transport has no GPU realization and cannot fall back silently"));
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
        let source = problem
            .current_modules
            .iter()
            .find_map(|source| match source {
                fullmag_ir::CurrentModuleIR::CurrentTransport {
                    name,
                    model,
                    coupling,
                    time_envelope,
                    definition,
                    ..
                } if name == &module.current_source_id => Some((
                    *model,
                    *coupling,
                    time_envelope.as_ref(),
                    definition.as_ref(),
                )),
                _ => None,
            });
        let Some((model, coupling, time_envelope, Some(charge))) = source else {
            errors.push(format!(
                "{prefix} requires a complete CurrentTransportIR source '{}'",
                module.current_source_id
            ));
            continue;
        };
        let reciprocal = coupling == fullmag_ir::TransportCouplingIR::Bidirectional;
        let expected_model = if reciprocal {
            fullmag_ir::CurrentTransportModelIR::MagnetoresistivePoisson
        } else {
            fullmag_ir::CurrentTransportModelIR::OhmicPoisson
        };
        let expected_constitutive = if reciprocal {
            FEM_M2_CONSTITUTIVE_VERSION
        } else {
            FEM_CONSTITUTIVE_VERSION
        };
        let expected_operator = if reciprocal {
            FEM_M2_OPERATOR_VERSION
        } else {
            FEM_OPERATOR_VERSION
        };
        if model != expected_model {
            errors.push(format!(
                "{prefix} source '{}' model is inconsistent with bounded FEM steady transport coupling",
                module.current_source_id
            ));
            continue;
        }
        if module.constitutive_version != expected_constitutive
            || module.solver.operator_version != expected_operator
            || module.solver.physical_residual_version != FEM_RESIDUAL_VERSION
        {
            errors.push(format!(
                "{prefix} requests an unsupported constitutive/operator/residual version"
            ));
        }
        if reciprocal {
            if !matches!(charge.solver.engine.as_str(), "auto" | "block_gmres") {
                errors.push(format!(
                    "{prefix} M2 requires charge solver engine auto or block_gmres"
                ));
            }
            if module.solver.reciprocal_nonlinear.is_some() {
                errors.push(format!(
                    "{prefix} bounded FEM M2 is a single linear monolithic solve; reciprocal_nonlinear policy is not executable"
                ));
            }
        } else if !matches!(charge.solver.engine.as_str(), "auto" | "cg") {
            errors.push(format!("{prefix} requires charge solver engine auto or cg"));
        }
        if charge.solver.linear.absolute_tolerance != 0.0 {
            errors.push(format!(
                "{prefix} currently requires charge absolute_tolerance=0"
            ));
        }
        let charge_operator_ok = if reciprocal {
            charge.solver.operator_version == FEM_M2_OPERATOR_VERSION
                && charge.solver.physical_residual_version == FEM_RESIDUAL_VERSION
        } else {
            charge.solver.operator_version == FEM_CHARGE_OPERATOR_VERSION
                && charge.solver.physical_residual_version == FEM_CHARGE_RESIDUAL_VERSION
        };
        if !charge_operator_ok {
            errors.push(format!(
                "{prefix} requests an unsupported charge operator/residual version"
            ));
        }
        if charge.solver.linear != module.solver.linear {
            errors.push(format!(
                "{prefix} bounded FEM ABI requires identical charge and spin linear solver policies"
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
            reciprocal,
            time_envelope,
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
                capabilities: if reciprocal {
                    vec![
                        "transport.charge.magnetoresistive".into(),
                        "transport.spin.steady_drift_diffusion".into(),
                        "transport.spin.direct_she".into(),
                        "transport.spin.inverse_she".into(),
                        "transport.coupling.bidirectional".into(),
                    ]
                } else {
                    vec![
                        "transport.charge.ohmic".into(),
                        "transport.spin.steady_drift_diffusion".into(),
                        "transport.spin.direct_she".into(),
                        "transport.coupling.one_way".into(),
                    ]
                },
                inserted_default_boundaries: inserted_fem_default_boundaries(charge, module),
                fdm_cpu_double: None,
                fdm_gpu_double: None,
                fdm_cpu_double_reciprocal: None,
                fdm_cpu_double_transient: None,
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
    reciprocal: bool,
    time_envelope: Option<&fullmag_ir::TimeEnvelopeIR>,
) -> Result<ResolvedFemSpinTransportIR, Vec<String>> {
    let prefix = format!("FEM spin transport '{}'", module.id);
    let charge_domain = fem_domain_mask(
        &charge.domain,
        mesh.cell_count(),
        object_segments,
        "charge domain",
    )?;
    let spin_domain = fem_domain_mask(
        &module.domain,
        mesh.cell_count(),
        object_segments,
        "spin domain",
    )?;
    require_full_fem_domain(&charge_domain, "charge domain")?;
    require_full_fem_domain(&spin_domain, "spin domain")?;
    let conservative_current_view = validate_conservative_current_view(
        charge.conservative_current_view.as_ref(),
        &module.id,
        &module.current_source_id,
        mesh,
        reciprocal,
    )?;

    let mut conductivity = vec![f64::NAN; mesh.cell_count()];
    for assignment in &charge.materials {
        let mask = fem_domain_mask(
            std::slice::from_ref(&assignment.region),
            mesh.cell_count(),
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
        vec![None; mesh.cell_count()];
    for assignment in &module.materials {
        let mask = fem_domain_mask(
            std::slice::from_ref(&assignment.region),
            mesh.cell_count(),
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
        return Err(vec!["bounded FEM conforming-H1 transport currently requires one uniform spin material across the complete solve domain".into()]);
    }

    if reciprocal && !module.interfaces.is_empty() {
        return Err(vec![
            "bounded FEM M2 currently requires a single conforming domain without internal spin interfaces"
                .into(),
        ]);
    }
    let reciprocal_material = if reciprocal {
        let Some(first_charge) = charge.materials.first() else {
            return Err(vec![
                "bounded FEM M2 requires anisotropic charge material assignments".into(),
            ]);
        };
        let Some(sigma_parallel) = first_charge.material.sigma_parallel_spm else {
            return Err(vec![
                "bounded FEM M2 charge materials require sigma_parallel_Spm".into(),
            ]);
        };
        let Some(sigma_perpendicular) = first_charge.material.sigma_perpendicular_spm else {
            return Err(vec![
                "bounded FEM M2 charge materials require sigma_perpendicular_Spm".into(),
            ]);
        };
        let Some(sigma_ahe) = first_charge.material.sigma_ahe_spm else {
            return Err(vec![
                "bounded FEM M2 charge materials require sigma_AHE_Spm".into(),
            ]);
        };
        for assignment in &charge.materials {
            if assignment.material.sigma_parallel_spm != Some(sigma_parallel)
                || assignment.material.sigma_perpendicular_spm != Some(sigma_perpendicular)
                || assignment.material.sigma_ahe_spm != Some(sigma_ahe)
            {
                return Err(vec![
                    "bounded FEM M2 requires one uniform anisotropic charge tensor across the conforming domain"
                        .into(),
                ]);
            }
        }
        let minimum = sigma_parallel.min(sigma_perpendicular);
        if conductivity.iter().any(|sigma| {
            minimum * reference.sigma_s_spm - reference.polarization_p.powi(2) * sigma.powi(2)
                <= 0.0
        }) {
            return Err(vec![
                "bounded FEM M2 charge/spin material violates the positive Schur complement".into(),
            ]);
        }
        Some(fullmag_ir::ResolvedReciprocalMaterialIR {
            sigma_spm: first_charge.material.sigma_spm,
            sigma_spin_spm: reference.sigma_s_spm,
            sigma_parallel_spm: sigma_parallel,
            sigma_perpendicular_spm: sigma_perpendicular,
            sigma_ahe_spm: sigma_ahe,
            polarization_p: reference.polarization_p,
            theta_sh: reference.theta_sh,
        })
    } else {
        None
    };

    validate_charge_face_exact_boundary_ownership(charge, mesh, mesh_parts)?;
    validate_spin_face_exact_boundary_ownership(module, mesh, mesh_parts)?;
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
    let torque_target = problem
        .spin_torque_modules
        .iter()
        .find_map(|torque| match torque {
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
                    mesh.cell_count(),
                    object_segments,
                    "torque target",
                )?,
                formula_version: formula_version.clone(),
            })
        })
        .transpose()?;
    if torque_target.is_some() && !reciprocal {
        return Err(vec![format!(
            "{prefix} transport torque RHS currently requires reciprocal FEM M2 stage transport; one-way torque remains fail-closed"
        )]);
    }
    match charge.gauge {
        fullmag_ir::ChargePotentialGaugeIR::DirichletReference if charge_dirichlet.is_empty() => {
            return Err(vec![
                "boundary-reference gauge requires at least one voltage electrode".into(),
            ]);
        }
        fullmag_ir::ChargePotentialGaugeIR::ZeroMean if reciprocal => {
            return Err(vec![
                "bounded FEM M2 requires a Dirichlet voltage reference".into(),
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
    let oersted_source_bound = problem.energy_terms.iter().any(|term| {
        matches!(
            term,
            fullmag_ir::EnergyTermIR::OerstedField { source, .. }
                if source == &module.current_source_id
        )
    });
    if reciprocal && oersted_source_bound && conservative_current_view.is_some() {
        return Err(vec![format!(
            "{prefix} reciprocal FEM M2 Oersted with a closure-aware RT0/external-lead view requires a dedicated coupled closure realization; H1/P1 combined stage coupling refuses a mismatched current source"
        )]);
    }
    let stage_coupling = if reciprocal && oersted_source_bound {
        FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY
    } else if reciprocal && torque_target.is_some() {
        FEM_STAGE_TRANSPORT_CALLBACK_POLICY
    } else {
        resolve_fem_stage_coupling_for_stage(
            reciprocal,
            oersted_source_bound,
            conservative_current_view.as_ref(),
        )
    };
    if torque_target.is_some() && !reciprocal && stage_coupling != FEM_STAGE_OERSTED_CALLBACK_POLICY
    {
        return Err(vec![format!(
            "FEM spin transport '{}' stage coupling requires one-way Oersted with a validated conservative current view",
            module.id
        )]);
    }
    const MU0_H_PER_M: f64 = 1.256_637_061_435_917_3e-6;
    Ok(ResolvedFemSpinTransportIR {
        descriptor_schema: if reciprocal {
            "fullmag.fem.spin_transport_descriptor.m2.v1".into()
        } else {
            "fullmag.fem.spin_transport_descriptor.v1".into()
        },
        charge_definition: charge.clone(),
        time_envelope: time_envelope.cloned(),
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
        reciprocal_material,
        polarization_p: reference.polarization_p,
        theta_sh: reference.theta_sh,
        lambda_sf_m: reference.lambda_sf_m,
        lambda_j_m: reaction_value(&reference.lambda_j_m),
        lambda_phi_m: reaction_value(&reference.lambda_phi_m),
        saturation_magnetization_apm,
        gamma_e_rad_per_s_t: gamma0_m_per_a_s / MU0_H_PER_M,
        spin_solver: module.solver.clone(),
        resolved_charge_engine: if reciprocal {
            "gmres".into()
        } else {
            "cg".into()
        },
        resolved_spin_engine: "gmres".into(),
        interface_law: "transparent".into(),
        interface_realization: "transparent_conforming_h1".into(),
        stage_coupling: stage_coupling.into(),
        capability_status: "reference_executable".into(),
        implementation_state: "executable".into(),
        validation_state: "algebra_validated".into(),
        validation_scope: if reciprocal {
            "fem_cpu_double_conforming_h1_p1_reciprocal_m2".into()
        } else {
            "fem_cpu_double_conforming_h1_p1_transparent_m1".into()
        },
        oersted_source_bound,
        conservative_current_view,
    })
}

fn validate_conservative_current_view(
    view: Option<&fullmag_ir::ResolvedFemConservativeCurrentViewIR>,
    module_id: &str,
    current_source_id: &str,
    mesh: &MeshIR,
    reciprocal: bool,
) -> Result<Option<fullmag_ir::ResolvedFemConservativeCurrentViewIR>, Vec<String>> {
    let Some(view) = view else {
        return Ok(None);
    };
    let prefix = format!(
        "FEM spin transport '{}' conservative current view",
        module_id
    );
    if reciprocal {
        return Err(vec![format!(
            "{prefix} is only executable on the one-way Ohmic lane; reciprocal M2 must fail closed"
        )]);
    }
    if view.stable_vertex_ids.len() != mesh.nodes.len()
        || view.stable_vertex_ids.iter().any(|id| *id == 0)
        || view.stable_vertex_ids.iter().collect::<BTreeSet<_>>().len()
            != view.stable_vertex_ids.len()
    {
        return Err(vec![format!(
            "{prefix} stable_vertex_ids must be a non-empty, unique, positive identity for every FEM node"
        )]);
    }
    if view.identity.source_module_id != current_source_id {
        return Err(vec![format!(
            "{prefix} identity.source_module_id '{}' does not match current_source_id '{}'",
            view.identity.source_module_id, current_source_id
        )]);
    }
    if view.pins.required_source_state_revision != view.identity.source_state_revision
        || view.pins.required_source_field_digest != view.identity.source_field_digest
        || view.pins.required_mesh_revision != view.identity.mesh_revision
        || view.pins.required_topology_revision != view.identity.topology_revision
    {
        return Err(vec![format!(
            "{prefix} pins must exactly match the accepted source, mesh, and topology identities"
        )]);
    }
    for (label, value) in [
        (
            "source_state_revision",
            &view.identity.source_state_revision,
        ),
        ("source_field_digest", &view.identity.source_field_digest),
        ("conductivity_digest", &view.identity.conductivity_digest),
        ("mesh_revision", &view.identity.mesh_revision),
        ("topology_revision", &view.identity.topology_revision),
        ("geometry_digest", &view.identity.geometry_digest),
        ("envelope_revision", &view.identity.envelope_revision),
        ("envelope_digest", &view.identity.envelope_digest),
        (
            "required_source_state_revision",
            &view.pins.required_source_state_revision,
        ),
        (
            "required_source_field_digest",
            &view.pins.required_source_field_digest,
        ),
        ("required_mesh_revision", &view.pins.required_mesh_revision),
        (
            "required_topology_revision",
            &view.pins.required_topology_revision,
        ),
    ] {
        if value.trim().is_empty() {
            return Err(vec![format!("{prefix} {label} must not be empty")]);
        }
    }
    if !view.identity.evaluated_envelope_multiplier.is_finite()
        || !view.identity.evaluation_time_s.is_finite()
        || view.identity.stage_identity == 0
        || !view.algebraic_relative_tolerance.is_finite()
        || view.algebraic_relative_tolerance <= 0.0
        || !view.physical_relative_gate.is_finite()
        || view.physical_relative_gate <= 0.0
        || !view.physical_absolute_gate_a.is_finite()
        || view.physical_absolute_gate_a <= 0.0
    {
        return Err(vec![format!(
            "{prefix} identity, stage, or physical gates contain invalid values"
        )]);
    }
    if mesh.facets.types.len() != mesh.facets.roles.len()
        || mesh.facets.types.len() + 1 != mesh.facets.offsets.len()
    {
        return Err(vec![format!(
            "{prefix} mesh facet connectivity is malformed"
        )]);
    }
    let mesh_faces = mesh
        .facets
        .require_tri3()
        .map_err(|reason| vec![format!("{prefix} requires a Tri3 boundary mesh: {reason}")])?;
    let mut expected_faces = BTreeSet::new();
    for (ordinal, face) in mesh_faces.iter().enumerate() {
        if !matches!(
            mesh.facets.roles.get(ordinal),
            Some(fullmag_ir::FemFacetRoleIR::Exterior | fullmag_ir::FemFacetRoleIR::PeriodicSeam)
        ) {
            continue;
        }
        let mut stable = [0_u64; 3];
        for (slot, local) in face.iter().enumerate() {
            let index = *local as usize;
            stable[slot] = *view.stable_vertex_ids.get(index).ok_or_else(|| {
                vec![format!(
                    "{prefix} boundary facet {ordinal} references an unknown FEM node"
                )]
            })?;
        }
        stable.sort_unstable();
        if stable[0] == 0 || stable[0] == stable[1] || stable[1] == stable[2] {
            return Err(vec![format!(
                "{prefix} mesh boundary facet {ordinal} has non-canonical stable IDs"
            )]);
        }
        expected_faces.insert(stable);
    }
    if view.boundary_faces.len() != expected_faces.len() {
        return Err(vec![format!(
            "{prefix} must classify every exterior/periodic Tri3 facet exactly once (authored {}, mesh {})",
            view.boundary_faces.len(), expected_faces.len()
        )]);
    }
    let mut authored_faces = BTreeSet::new();
    let mut roles = BTreeMap::new();
    for face in &view.boundary_faces {
        let ids = face.face_vertex_ids;
        if ids[0] == 0 || ids[0] >= ids[1] || ids[1] >= ids[2] || !expected_faces.contains(&ids) {
            return Err(vec![format!(
                "{prefix} boundary face {:?} is not a canonical mesh boundary facet",
                ids
            )]);
        }
        if !authored_faces.insert(ids) {
            return Err(vec![format!(
                "{prefix} contains a duplicate boundary face {:?}",
                ids
            )]);
        }
        match face.role {
            fullmag_ir::ConservativeCurrentBoundaryRoleIR::InsulatingOuter => {
                if face.circuit_id.is_some() {
                    return Err(vec![format!(
                        "{prefix} insulating_outer face {:?} carries circuit_id",
                        ids
                    )]);
                }
            }
            fullmag_ir::ConservativeCurrentBoundaryRoleIR::SourceCut
            | fullmag_ir::ConservativeCurrentBoundaryRoleIR::ClosureInterface => {
                if face.circuit_id.as_deref().is_none_or(str::is_empty) {
                    return Err(vec![format!(
                        "{prefix} driven face {:?} requires circuit_id",
                        ids
                    )]);
                }
            }
        }
        roles.insert(ids, face.role);
    }
    if authored_faces != expected_faces {
        return Err(vec![format!(
            "{prefix} does not cover the complete mesh boundary"
        )]);
    }
    if let fullmag_ir::ConservativeCurrentClosureIR::ExternalLead {
        operator_version,
        revision,
        digest,
        drive_id,
        outer_electrode_potential_drop_v,
        lead_mesh,
        lead_conductivity_spm_per_element,
        lead_stable_vertex_ids,
        interface_pairs,
        minus_outer_electrode_face_vertex_ids,
        plus_outer_electrode_face_vertex_ids,
        lead_conductivity_digest,
    } = &view.closure
    {
        if operator_version != "fem_closed_current_extension.v1"
            || revision.trim().is_empty()
            || digest.trim().is_empty()
            || drive_id.trim().is_empty()
            || lead_conductivity_digest.trim().is_empty()
            || !outer_electrode_potential_drop_v.is_finite()
            || *outer_electrode_potential_drop_v == 0.0
        {
            return Err(vec![format!(
                "{prefix} external-lead identity or drive is incomplete"
            )]);
        }
        let lead_elements = lead_mesh
            .require_tet4_elements()
            .map_err(|reason| vec![format!("{prefix} lead mesh requires tet4 cells: {reason}")])?;
        let lead_faces = lead_mesh.require_tri3_boundary_faces().map_err(|reason| {
            vec![format!(
                "{prefix} lead mesh requires tri3 boundary faces: {reason}"
            )]
        })?;
        if lead_mesh.nodes.is_empty()
            || lead_stable_vertex_ids.len() != lead_mesh.nodes.len()
            || lead_stable_vertex_ids.iter().any(|id| *id == 0)
            || lead_stable_vertex_ids.iter().collect::<BTreeSet<_>>().len()
                != lead_stable_vertex_ids.len()
            || lead_conductivity_spm_per_element.len() != lead_elements.len()
            || lead_conductivity_spm_per_element
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
            || interface_pairs.is_empty()
            || minus_outer_electrode_face_vertex_ids.is_empty()
            || plus_outer_electrode_face_vertex_ids.is_empty()
        {
            return Err(vec![format!(
                "{prefix} external-lead mesh/identity is incomplete"
            )]);
        }
        let device_ids = view.stable_vertex_ids.iter().collect::<BTreeSet<_>>();
        if lead_stable_vertex_ids
            .iter()
            .any(|id| device_ids.contains(id))
        {
            return Err(vec![format!(
                "{prefix} device and external-lead stable vertex namespaces must be disjoint"
            )]);
        }
        let mut lead_boundary_keys = BTreeSet::new();
        for face in lead_faces {
            let mut stable = [0_u64; 3];
            for (slot, local) in face.iter().enumerate() {
                let index = *local as usize;
                let Some(id) = lead_stable_vertex_ids.get(index) else {
                    return Err(vec![format!(
                        "{prefix} lead boundary face references an unknown node"
                    )]);
                };
                stable[slot] = *id;
            }
            stable.sort_unstable();
            if stable[0] == 0 || stable[0] == stable[1] || stable[1] == stable[2] {
                return Err(vec![format!(
                    "{prefix} lead boundary face has non-canonical stable IDs"
                )]);
            }
            lead_boundary_keys.insert(stable);
        }
        let mut used_device = BTreeSet::new();
        let mut used_lead = BTreeSet::new();
        for (device_face, lead_face) in interface_pairs {
            if device_face[0] == 0
                || device_face[0] >= device_face[1]
                || device_face[1] >= device_face[2]
                || lead_face[0] == 0
                || lead_face[0] >= lead_face[1]
                || lead_face[1] >= lead_face[2]
                || roles.get(device_face)
                    != Some(&fullmag_ir::ConservativeCurrentBoundaryRoleIR::ClosureInterface)
                || !lead_boundary_keys.contains(lead_face)
                || !used_device.insert(*device_face)
                || !used_lead.insert(*lead_face)
            {
                return Err(vec![format!(
                    "{prefix} external-lead interface map is invalid or duplicated"
                )]);
            }
        }
        if roles
            .values()
            .any(|role| *role == fullmag_ir::ConservativeCurrentBoundaryRoleIR::ClosureInterface)
            && roles.iter().any(|(face, role)| {
                *role == fullmag_ir::ConservativeCurrentBoundaryRoleIR::ClosureInterface
                    && !used_device.contains(face)
            })
        {
            return Err(vec![format!(
                "{prefix} external-lead interface map does not cover every closure-interface face"
            )]);
        }
        let mut electrodes = BTreeSet::new();
        for face in minus_outer_electrode_face_vertex_ids
            .iter()
            .chain(plus_outer_electrode_face_vertex_ids.iter())
        {
            if face[0] == 0
                || face[0] >= face[1]
                || face[1] >= face[2]
                || !lead_boundary_keys.contains(face)
                || used_lead.contains(face)
                || !electrodes.insert(*face)
            {
                return Err(vec![format!(
                    "{prefix} external-lead outer electrode face map is invalid or duplicated"
                )]);
            }
        }
        return Ok(Some(view.clone()));
    }
    let fullmag_ir::ConservativeCurrentClosureIR::ClosedGeometry {
        operator_version,
        revision,
        digest,
        source_cuts,
    } = &view.closure
    else {
        return Err(vec![format!(
            "{prefix} external-lead closure is not yet executable in the public FEM planner"
        )]);
    };
    if operator_version.trim().is_empty()
        || revision.trim().is_empty()
        || digest.trim().is_empty()
        || source_cuts.is_empty()
    {
        return Err(vec![format!(
            "{prefix} closed_geometry identity/source_cuts are incomplete"
        )]);
    }
    let mut cut_ids = BTreeSet::new();
    for cut in source_cuts {
        if cut.id.trim().is_empty()
            || !cut.potential_drop_v.is_finite()
            || cut.translation_m.iter().all(|value| *value == 0.0)
            || cut.face_pairs.is_empty()
            || !cut_ids.insert(cut.id.as_str())
        {
            return Err(vec![format!(
                "{prefix} contains an invalid or duplicate source cut"
            )]);
        }
        for pair in &cut.face_pairs {
            if pair.minus_face_vertex_ids == pair.plus_face_vertex_ids {
                return Err(vec![format!(
                    "{prefix} source cut '{}' must pair distinct minus and plus faces",
                    cut.id
                )]);
            }
            for face in [pair.minus_face_vertex_ids, pair.plus_face_vertex_ids] {
                if face[0] == 0
                    || face[0] >= face[1]
                    || face[1] >= face[2]
                    || roles.get(&face)
                        != Some(&fullmag_ir::ConservativeCurrentBoundaryRoleIR::SourceCut)
                {
                    return Err(vec![format!(
                        "{prefix} source cut '{}' references a face that is not authored as source_cut",
                        cut.id
                    )]);
                }
            }
        }
    }
    Ok(Some(view.clone()))
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

fn validate_charge_face_exact_boundary_ownership(
    charge: &fullmag_ir::ChargeTransportDefinitionIR,
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
) -> Result<(), Vec<String>> {
    let assignments = charge
        .boundaries
        .iter()
        .map(|boundary| {
            let kind = match boundary {
                ChargeBoundaryIR::VoltageElectrode { .. } => "voltage",
                ChargeBoundaryIR::NormalCurrentElectrode { .. } => "normal_current",
                ChargeBoundaryIR::Insulating { .. } => "insulating",
            };
            (
                format!("{kind}:{}", boundary.id()),
                boundary.surfaces().iter().collect::<Vec<_>>(),
            )
        })
        .collect::<Vec<_>>();
    validate_face_exact_boundary_ownership("charge", mesh, mesh_parts, &assignments)
}

fn validate_spin_face_exact_boundary_ownership(
    module: &fullmag_ir::SpinTransportModuleIR,
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
) -> Result<(), Vec<String>> {
    let assignments = module
        .boundaries
        .iter()
        .map(|boundary| match boundary {
            SpinBoundaryIR::SpinSink { id, surfaces } => (
                format!("spin_sink:{id}"),
                surfaces.iter().collect::<Vec<_>>(),
            ),
            SpinBoundaryIR::SpecifiedSpinPotential { id, surfaces, .. } => (
                format!("specified_spin_potential:{id}"),
                surfaces.iter().collect::<Vec<_>>(),
            ),
            SpinBoundaryIR::SpinInsulating { id, surfaces } => (
                format!("spin_insulating:{id}"),
                surfaces.iter().collect::<Vec<_>>(),
            ),
            SpinBoundaryIR::SpecifiedSpinFlux { id, surfaces, .. } => (
                format!("specified_spin_flux:{id}"),
                surfaces.iter().collect::<Vec<_>>(),
            ),
            SpinBoundaryIR::PeriodicSpin {
                id,
                minus_surface,
                plus_surface,
                ..
            } => (
                format!("periodic_spin:{id}"),
                vec![minus_surface, plus_surface],
            ),
        })
        .collect::<Vec<_>>();
    validate_face_exact_boundary_ownership("spin", mesh, mesh_parts, &assignments)
}

fn validate_face_exact_boundary_ownership(
    family: &str,
    mesh: &MeshIR,
    mesh_parts: &[FemMeshPartIR],
    assignments: &[(String, Vec<&fullmag_ir::SurfaceRefIR>)],
) -> Result<(), Vec<String>> {
    external_fem_boundary_markers(mesh)?;
    if assignments.is_empty() {
        return Ok(());
    }

    let mut face_owners = vec![None::<&str>; mesh.facet_count()];
    for (owner, surfaces) in assignments {
        let mut selected_faces = BTreeSet::new();
        for surface in surfaces {
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
                    "FEM {family} face-exact assignment '{owner}' has no external boundary-face indices"
                )]);
            }
            selected_faces.extend(resolved.boundary_face_indices);
        }
        for face_index in selected_faces {
            let slot = face_owners.get_mut(face_index as usize).ok_or_else(|| {
                vec![format!(
                    "FEM {family} face-exact assignment '{owner}' references external face {face_index} outside the mesh"
                )]
            })?;
            if let Some(existing) = slot {
                if *existing != owner {
                    return Err(vec![format!(
                        "conflicting FEM {family} face-exact assignments '{existing}' and '{owner}' on external face {face_index}"
                    )]);
                }
            } else {
                *slot = Some(owner);
            }
        }
    }

    let mut marker_owners = BTreeMap::<u32, &str>::new();
    for (face_index, marker) in mesh.boundary_markers.iter().copied().enumerate() {
        let Some(owner) = face_owners[face_index] else {
            return Err(vec![format!(
                "FEM {family} face-exact ownership is incomplete: external face {face_index} with boundary attribute {marker} is unassigned"
            )]);
        };
        if let Some(existing) = marker_owners.insert(marker, owner) {
            if existing != owner {
                return Err(vec![format!(
                    "FEM {family} boundary attribute {marker} spans faces owned by different face-exact assignments '{existing}' and '{owner}'"
                )]);
            }
        }
    }
    Ok(())
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
                let mut markers = BTreeSet::new();
                for surface in surfaces {
                    markers.extend(surface_markers(surface, mesh, mesh_parts)?);
                }
                for marker in markers {
                    insert_scalar_bc(&mut values, marker, *potential_v, "voltage")?;
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
                let mut markers = BTreeSet::new();
                for surface in surfaces {
                    markers.extend(surface_markers(surface, mesh, mesh_parts)?);
                }
                for marker in markers {
                    insert_vector_bc(&mut values, marker, [0.0; 3], "spin potential")?;
                }
            }
            fullmag_ir::SpinBoundaryIR::SpecifiedSpinPotential {
                surfaces,
                spin_potential_v,
                ..
            } => {
                let mut markers = BTreeSet::new();
                for surface in surfaces {
                    markers.extend(surface_markers(surface, mesh, mesh_parts)?);
                }
                for marker in markers {
                    insert_vector_bc(&mut values, marker, *spin_potential_v, "spin potential")?;
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
    if mesh.boundary_markers.len() != mesh.facet_count() {
        return Err(vec![format!(
            "FEM boundary marker count {} does not match external boundary face count {}",
            mesh.boundary_markers.len(),
            mesh.facet_count()
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
    time_envelope: Option<&fullmag_ir::TimeEnvelopeIR>,
    active_graph: &ActiveFdmTransportGraph,
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
    let magnetic_active_mask = context
        .active_mask
        .map(<[bool]>::to_vec)
        .unwrap_or_else(|| vec![true; count]);
    let first_outside = |subset: &[bool], superset: &[bool]| {
        subset
            .iter()
            .zip(superset)
            .position(|(selected, covered)| *selected && !*covered)
    };
    if let Some(cell) = first_outside(&spin_active_cells, &charge_active_cells) {
        return Err(vec![format!(
            "spin transport '{}' domain must be a subset of the transport charge domain (cell {cell})",
            module.id
        )]);
    }
    if let Some(cell) = first_outside(&magnetic_active_mask, &charge_active_cells) {
        return Err(vec![format!(
            "magnetic domain must be a subset of the transport charge domain (cell {cell})"
        )]);
    }
    if let Some(cell) = first_outside(&magnetic_active_mask, &spin_active_cells) {
        return Err(vec![format!(
            "magnetic domain must be a subset of spin transport '{}' domain (cell {cell})",
            module.id
        )]);
    }

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

    let (charge_boundaries, specified_current_faces) = resolve_charge_boundaries(
        &charge.boundaries,
        &charge_active_cells,
        context,
        module.solver.engine == "native_m1_v1",
    )?;
    let structured_current_closure = materialize_structured_current_closure(
        problem,
        charge,
        &charge_active_cells,
        context,
    )?;
    let spin_boundaries =
        resolve_spin_boundaries(&module.boundaries, &spin_active_cells, context)?;
    let interfaces = resolve_interfaces(module, context)?;

    let mut matching_torques = Vec::new();
    for torque in &problem.spin_torque_modules {
        let candidate = match torque {
            SpinTorqueModuleIR::DriftDiffusionSpinTorque {
                id,
                solve_id,
                target,
                formula_version,
                ..
            } if solve_id == &module.id => Some((id, target, formula_version)),
            _ => None,
        };
        let Some((id, target, formula_version)) = candidate else {
            continue;
        };
        if active_graph.torque_module_ids.contains(id) {
            matching_torques.push((id, target, formula_version));
        }
    }
    if matching_torques.len() > 1 {
        return Err(vec![format!(
            "spin transport '{}' has more than one DriftDiffusionSpinTorque consumer",
            module.id
        )]);
    }
    let (torque_target_cells, torque_target_masks, torque_formula_version) = if let Some((
        torque_id,
        target,
        formula,
    )) =
        matching_torques.first()
    {
        let target_mask = resolve_region_mask(target, context, "transport torque target")?;
        if let Some(cell) = first_outside(&target_mask, &magnetic_active_mask) {
            return Err(vec![format!(
                "transport torque target '{}' must be a subset of the magnetic domain (cell {cell})",
                torque_id
            )]);
        }
        if let Some(cell) = first_outside(&target_mask, &spin_active_cells) {
            return Err(vec![format!(
                "transport torque target '{}' must be a subset of the spin transport domain (cell {cell})",
                torque_id
            )]);
        }
        if let Some(cell) = target_mask.iter().enumerate().find_map(|(cell, selected)| {
            (*selected
                && (!context.saturation_magnetization_apm[cell].is_finite()
                    || context.saturation_magnetization_apm[cell] <= 0.0))
                .then_some(cell)
        }) {
            return Err(vec![format!(
                "transport torque target '{}' requires finite positive saturation magnetization on cell {cell}",
                torque_id
            )]);
        }
        (
            target_mask.clone(),
            vec![fullmag_ir::ResolvedFdmTorqueTargetMaskIR {
                torque_module_id: (*torque_id).to_string(),
                target: (*target).clone(),
                active_mask: target_mask,
            }],
            Some((*formula).clone()),
        )
    } else {
        (vec![false; count], Vec::new(), None)
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
        realization: if module.solver.engine == "native_m1_v1" {
            FdmCpuTransportRealizationIR::NativeM1V1
        } else {
            FdmCpuTransportRealizationIR::RustReferenceV1
        },
        enclosing_execution_mode: problem.validation_profile.execution_mode,
        time_envelope: time_envelope.cloned(),
        transport_active_mask: charge_active_cells.clone(),
        magnetic_active_mask,
        charge_active_cells,
        charge_conductivity_spm,
        charge_boundaries,
        specified_current_faces,
        structured_current_closure,
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
        torque_target_masks,
        torque_target_cells,
        saturation_magnetization_apm: context.saturation_magnetization_apm.to_vec(),
        gamma_e_rad_per_s_t: context.gamma0_m_per_a_s / MU0_H_PER_M,
        spin_solver: module.solver.clone(),
        torque_formula_version,
        oersted_source_bound,
    })
}

pub(crate) fn materialize_fdm_gpu_charge_descriptor(
    module_id: &str,
    charge: &fullmag_ir::ChargeTransportDefinitionIR,
    context: &FdmSpinTransportResolutionContext<'_>,
) -> Result<ResolvedFdmGpuChargeTransportIR, Vec<String>> {
    let count = context.region_mask.len();
    if count == 0
        || context
            .active_mask
            .is_some_and(|active| active.len() != count)
    {
        return Err(vec![format!(
            "FDM GPU charge transport '{module_id}' planner context does not match the resolved FDM grid"
        )]);
    }

    let charge_active_cells = union_region_masks(&charge.domain, context, "charge domain")?;
    let mut charge_conductivity_spm = vec![0.0; count];
    let mut assigned = vec![false; count];
    for assignment in &charge.materials {
        assign_scalar_field(
            &assignment.region,
            assignment.material.sigma_spm,
            &charge_active_cells,
            context,
            &mut charge_conductivity_spm,
            &mut assigned,
            "charge material",
        )?;
    }
    require_complete_assignment(&charge_active_cells, &assigned, "charge material")?;

    let descriptor_schema = "fullmag.fdm.gpu_charge_transport_descriptor.v1".to_string();
    let descriptor_revision = 1_u64;
    let source_revision = 1_u64;
    let implementation_version = "fullmag_fdm_gpu_charge_abi_v1".to_string();
    let (charge_boundaries, _) =
        resolve_charge_boundaries(&charge.boundaries, &charge_active_cells, context, false)?;
    let descriptor_payload = serde_json::to_vec(&(
        descriptor_schema.as_str(),
        descriptor_revision,
        source_revision,
        implementation_version.as_str(),
        module_id,
        &charge_active_cells,
        &charge_conductivity_spm,
        &charge_boundaries,
        charge.gauge,
        &charge.solver,
        context.region_mask,
    ))
    .map_err(|error| vec![format!("failed to serialize FDM GPU charge descriptor: {error}")])?;
    let descriptor_sha256 = format!("sha256:{:x}", Sha256::digest(descriptor_payload));

    Ok(ResolvedFdmGpuChargeTransportIR {
        descriptor_schema,
        descriptor_revision,
        source_revision,
        implementation_version,
        validation_state: "source_contract_only".into(),
        descriptor_sha256,
        module_id: module_id.into(),
        requested_execution: RequestedTransportExecutionIR {
            discretization: BackendTarget::Fdm,
            device: ExecutionDevice::Gpu,
            precision: ExecutionPrecision::Double,
            execution_mode: fullmag_ir::ExecutionMode::Strict,
        },
        resolved_discretization: BackendTarget::Fdm,
        resolved_device: ExecutionDevice::Gpu,
        resolved_precision: ExecutionPrecision::Double,
        resolved_execution_mode: fullmag_ir::ExecutionMode::Strict,
        capabilities: vec![
            "transport.charge.ohmic".into(),
            "transport.charge.fdm_gpu_double".into(),
            "transport.coupling.one_way".into(),
        ],
        charge_active_cells,
        charge_conductivity_spm,
        charge_boundaries,
        charge_gauge: charge.gauge,
        charge_solver: charge.solver.clone(),
        region_ids: context.region_mask.to_vec(),
    })
}

fn materialize_structured_current_closure(
    problem: &ProblemIR,
    charge: &fullmag_ir::ChargeTransportDefinitionIR,
    charge_active_cells: &[bool],
    context: &FdmSpinTransportResolutionContext<'_>,
) -> Result<Option<ResolvedFdmStructuredCurrentClosureIR>, Vec<String>> {
    let Some(closure) = charge.structured_current_closure.as_ref() else {
        return Ok(None);
    };
    if problem.pbc.as_ref().is_some_and(|pbc| pbc.has_any_periodic()) {
        return Err(vec![
            "structured current closure v1 requires open boundary conditions on every FDM axis"
                .to_string(),
        ]);
    }
    let fullmag_ir::StructuredCurrentClosureIR::ClosedGeometry {
        schema_version,
        closure_id,
        source_cuts,
    } = closure;
    let component_labels = connected_component_labels(
        charge_active_cells,
        context.grid_cells,
        &BTreeSet::new(),
    );
    let mut resolved = Vec::with_capacity(source_cuts.len());
    let mut cuts_per_component = BTreeMap::<u32, usize>::new();
    let mut all_cut_faces = BTreeSet::new();

    for cut in source_cuts {
        let axis = match cut.plane.axis {
            fullmag_ir::StructuredCutAxisIR::X => 0,
            fullmag_ir::StructuredCutAxisIR::Y => 1,
            fullmag_ir::StructuredCutAxisIR::Z => 2,
        };
        let face_index = resolve_plane_face_index(
            cut.plane.offset_m,
            context.origin_m[axis],
            context.cell_size_m[axis],
            context.grid_cells[axis],
            &cut.source_cut_id,
        )?;
        let region_cells = resolve_region_mask(&cut.region, context, "structured source cut")?;
        let faces = internal_faces(context.grid_cells, axis as u8)
            .into_iter()
            .filter(|face| internal_face_plane_index(*face, context.grid_cells) == face_index)
            .filter(|face| {
                let negative = face.negative_cell as usize;
                let positive = face.positive_cell as usize;
                charge_active_cells[negative]
                    && charge_active_cells[positive]
                    && region_cells[negative]
                    && region_cells[positive]
            })
            .collect::<Vec<_>>();
        if faces.is_empty() {
            return Err(vec![format!(
                "structured source cut '{}' plane ∩ region selects zero internal active charge faces",
                cut.source_cut_id
            )]);
        }
        if structured_face_component_count(&faces, context.grid_cells) != 1 {
            return Err(vec![format!(
                "structured source cut '{}' plane ∩ region contains multiple disconnected cross-sections",
                cut.source_cut_id
            )]);
        }
        let component = component_labels[faces[0].negative_cell as usize];
        if component == u32::MAX
            || faces.iter().any(|face| {
                component_labels[face.negative_cell as usize] != component
                    || component_labels[face.positive_cell as usize] != component
            })
        {
            return Err(vec![format!(
                "structured source cut '{}' does not belong to exactly one active charge component",
                cut.source_cut_id
            )]);
        }
        *cuts_per_component.entry(component).or_default() += 1;
        all_cut_faces.extend(faces.iter().copied());
        let drive = cut.drive.impressed_potential_jump();
        resolved.push(ResolvedFdmStructuredCurrentSourceCutIR {
            source_cut_id: cut.source_cut_id.clone(),
            circuit_id: cut.circuit_id.clone(),
            drive_id: drive.drive_id.clone(),
            region: cut.region.clone(),
            axis: axis as u8,
            plane_face_index: face_index,
            normal_sign: match cut.plane.normal {
                fullmag_ir::StructuredCutNormalIR::PositiveAxis => 1,
                fullmag_ir::StructuredCutNormalIR::NegativeAxis => -1,
            },
            component_label: component,
            potential_jump_v: drive.potential_jump_v,
            faces,
        });
    }
    if let Some((component, count)) = cuts_per_component.iter().find(|(_, count)| **count != 1) {
        return Err(vec![format!(
            "active charge component {component} has {count} structured source cuts; v1 requires exactly one cut per driven component"
        )]);
    }

    let return_labels = connected_component_labels(
        charge_active_cells,
        context.grid_cells,
        &all_cut_faces,
    );
    for cut in &resolved {
        if cut.faces.iter().any(|face| {
            let negative = return_labels[face.negative_cell as usize];
            negative == u32::MAX || negative != return_labels[face.positive_cell as usize]
        }) {
            return Err(vec![format!(
                "structured source cut '{}' has no complete connected return path after removing the cut faces",
                cut.source_cut_id
            )]);
        }
    }

    let descriptor_sha256 = sha256_json(closure);
    let active_mask_sha256 = sha256_json(&charge_active_cells);
    let topology_sha256 = sha256_json(&(
        context.grid_cells,
        context.origin_m,
        context.cell_size_m,
        charge_active_cells,
        context.region_mask,
        &resolved,
    ));
    Ok(Some(ResolvedFdmStructuredCurrentClosureIR {
        schema_version: schema_version.clone(),
        closure_id: closure_id.clone(),
        descriptor_sha256,
        grid_shape: context.grid_cells,
        origin_m: context.origin_m,
        cell_size_m: context.cell_size_m,
        active_mask_sha256,
        topology_sha256,
        component_labels,
        source_cuts: resolved,
    }))
}

fn sha256_json(value: &impl serde::Serialize) -> String {
    let bytes = serde_json::to_vec(value).expect("structured current descriptor is serializable");
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn resolve_plane_face_index(
    offset_m: f64,
    origin_m: f64,
    spacing_m: f64,
    cell_count: u32,
    source_cut_id: &str,
) -> Result<u32, Vec<String>> {
    let coordinate = (offset_m - origin_m) / spacing_m;
    let rounded = coordinate.round();
    let tolerance = 64.0 * f64::EPSILON * coordinate.abs().max(1.0);
    if !coordinate.is_finite() || (coordinate - rounded).abs() > tolerance {
        return Err(vec![format!(
            "structured source cut '{source_cut_id}' offset_m={offset_m} is not aligned with the resolved FDM grid"
        )]);
    }
    if rounded < 1.0 || rounded >= f64::from(cell_count) {
        return Err(vec![format!(
            "structured source cut '{source_cut_id}' must resolve to an internal FDM face plane"
        )]);
    }
    Ok(rounded as u32)
}

fn internal_face_plane_index(face: StructuredInternalFaceIR, grid: [u32; 3]) -> u32 {
    let [x, y, z] = cell_coordinates(face.positive_cell as usize, grid);
    [x, y, z][face.axis as usize]
}

fn cell_coordinates(cell: usize, grid: [u32; 3]) -> [u32; 3] {
    let nx = grid[0] as usize;
    let ny = grid[1] as usize;
    let x = cell % nx;
    let yz = cell / nx;
    let y = yz % ny;
    let z = yz / ny;
    [x as u32, y as u32, z as u32]
}

fn connected_component_labels(
    active: &[bool],
    grid: [u32; 3],
    removed_faces: &BTreeSet<StructuredInternalFaceIR>,
) -> Vec<u32> {
    let mut labels = vec![u32::MAX; active.len()];
    let mut next_label = 0_u32;
    for seed in 0..active.len() {
        if !active[seed] || labels[seed] != u32::MAX {
            continue;
        }
        labels[seed] = next_label;
        let mut stack = vec![seed];
        while let Some(cell) = stack.pop() {
            for (neighbor, face) in cell_neighbors(cell, grid) {
                if active[neighbor]
                    && labels[neighbor] == u32::MAX
                    && !removed_faces.contains(&face)
                {
                    labels[neighbor] = next_label;
                    stack.push(neighbor);
                }
            }
        }
        next_label += 1;
    }
    labels
}

fn cell_neighbors(
    cell: usize,
    grid: [u32; 3],
) -> Vec<(usize, StructuredInternalFaceIR)> {
    let coordinates = cell_coordinates(cell, grid);
    let strides = [1_usize, grid[0] as usize, (grid[0] * grid[1]) as usize];
    let mut neighbors = Vec::with_capacity(6);
    for axis in 0..3 {
        if coordinates[axis] > 0 {
            let neighbor = cell - strides[axis];
            neighbors.push((neighbor, StructuredInternalFaceIR {
                axis: axis as u8,
                negative_cell: neighbor as u64,
                positive_cell: cell as u64,
            }));
        }
        if coordinates[axis] + 1 < grid[axis] {
            let neighbor = cell + strides[axis];
            neighbors.push((neighbor, StructuredInternalFaceIR {
                axis: axis as u8,
                negative_cell: cell as u64,
                positive_cell: neighbor as u64,
            }));
        }
    }
    neighbors
}

fn structured_face_component_count(
    faces: &[StructuredInternalFaceIR],
    grid: [u32; 3],
) -> usize {
    let face_set = faces.iter().copied().collect::<BTreeSet<_>>();
    let mut remaining = face_set.clone();
    let mut components = 0;
    while let Some(seed) = remaining.pop_first() {
        components += 1;
        let mut stack = vec![seed];
        while let Some(face) = stack.pop() {
            let coordinates = cell_coordinates(face.negative_cell as usize, grid);
            for transverse_axis in (0..3).filter(|axis| *axis != face.axis as usize) {
                for direction in [-1_i32, 1_i32] {
                    let coordinate = coordinates[transverse_axis] as i32 + direction;
                    if coordinate < 0 || coordinate >= grid[transverse_axis] as i32 {
                        continue;
                    }
                    let mut neighbor_coordinates = coordinates;
                    neighbor_coordinates[transverse_axis] = coordinate as u32;
                    let neighbor_cell = neighbor_coordinates[0] as usize
                        + grid[0] as usize
                            * (neighbor_coordinates[1] as usize
                                + grid[1] as usize * neighbor_coordinates[2] as usize);
                    let neighbor = StructuredInternalFaceIR {
                        axis: face.axis,
                        negative_cell: neighbor_cell as u64,
                        positive_cell: (neighbor_cell
                            + [1_usize, grid[0] as usize, (grid[0] * grid[1]) as usize]
                                [face.axis as usize]) as u64,
                    };
                    if face_set.contains(&neighbor) && remaining.remove(&neighbor) {
                        stack.push(neighbor);
                    }
                }
            }
        }
    }
    components
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

fn object_is_on_grid(context: &FdmSpinTransportResolutionContext<'_>, object_id: &str) -> bool {
    context
        .object_masks_by_id
        .is_some_and(|masks| masks.contains_key(object_id))
        || context.owner_names.contains(&object_id)
}

fn resolve_region_mask(
    region: &RegionRefIR,
    context: &FdmSpinTransportResolutionContext<'_>,
    label: &str,
) -> Result<Vec<bool>, Vec<String>> {
    if !object_is_on_grid(context, &region.object_id) {
        return Err(vec![format!(
            "{label} object_id '{}' is outside the resolved single-grid FDM object",
            region.object_id
        )]);
    }
    let selected_region_mask = match (region.region_id.as_deref(), context.region_masks_by_ref) {
        (Some(region_id), Some(masks)) => Some(
            masks
                .get(&(region.object_id.clone(), region_id.to_string()))
                .ok_or_else(|| {
                    vec![format!(
                        "{label} region '{}:{}' was not materialized on the FDM transport grid",
                        region.object_id, region_id
                    )]
                })?,
        ),
        _ => None,
    };
    let selected_region_id = match (region.region_id.as_deref(), context.region_masks_by_ref) {
        (Some(region_id), None) => {
            Some(*context.region_index_by_id.get(region_id).ok_or_else(|| {
                vec![format!(
                    "{label} region_id '{}' was not materialized in the FDM region mask",
                    region_id
                )]
            })?)
        }
        _ => None,
    };
    let object_mask = context
        .object_masks_by_id
        .and_then(|masks| masks.get(&region.object_id));
    let mask = context
        .region_mask
        .iter()
        .enumerate()
        .map(|(cell, numeric)| {
            object_mask.map_or_else(
                || is_grid_active(context, cell),
                |mask| mask.get(cell).copied().unwrap_or(false),
            ) && selected_region_mask.is_none_or(|mask| mask[cell])
                && selected_region_id.is_none_or(|id| *numeric == id)
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
        "x_min" | "x-" => (StructuredBoundaryFaceIR::XMin, [-1.0, 0.0, 0.0]),
        "x_max" | "x+" => (StructuredBoundaryFaceIR::XMax, [1.0, 0.0, 0.0]),
        "y_min" | "y-" => (StructuredBoundaryFaceIR::YMin, [0.0, -1.0, 0.0]),
        "y_max" | "y+" => (StructuredBoundaryFaceIR::YMax, [0.0, 1.0, 0.0]),
        "z_min" | "z-" => (StructuredBoundaryFaceIR::ZMin, [0.0, 0.0, -1.0]),
        "z_max" | "z+" => (StructuredBoundaryFaceIR::ZMax, [0.0, 0.0, 1.0]),
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

#[derive(Clone)]
struct ExternalBoundaryCell {
    axis: u8,
    face_index: u64,
    adjacent_cell: usize,
    outward_normal_sign: i8,
    area_m2: f64,
}

fn external_boundary_cells(
    face: StructuredBoundaryFaceIR,
    grid_cells: [u32; 3],
    cell_size_m: [f64; 3],
) -> Result<Vec<ExternalBoundaryCell>, Vec<String>> {
    let [nx, ny, nz] = grid_cells.map(|value| value as usize);
    let cell_count = nx
        .checked_mul(ny)
        .and_then(|value| value.checked_mul(nz))
        .ok_or_else(|| vec!["structured FDM boundary cell count overflows usize".into()])?;
    if cell_count == 0
        || cell_size_m
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(vec![
            "structured FDM boundary grid or cell-size contract is invalid".into(),
        ]);
    }
    let cell_index = |x: usize, y: usize, z: usize| x + nx * (y + ny * z);
    let (axis, outward_normal_sign, area_m2) = match face {
        StructuredBoundaryFaceIR::XMin | StructuredBoundaryFaceIR::XMax => (
            0,
            if face == StructuredBoundaryFaceIR::XMin {
                -1
            } else {
                1
            },
            cell_size_m[1] * cell_size_m[2],
        ),
        StructuredBoundaryFaceIR::YMin | StructuredBoundaryFaceIR::YMax => (
            1,
            if face == StructuredBoundaryFaceIR::YMin {
                -1
            } else {
                1
            },
            cell_size_m[0] * cell_size_m[2],
        ),
        StructuredBoundaryFaceIR::ZMin | StructuredBoundaryFaceIR::ZMax => (
            2,
            if face == StructuredBoundaryFaceIR::ZMin {
                -1
            } else {
                1
            },
            cell_size_m[0] * cell_size_m[1],
        ),
    };
    let mut cells = Vec::new();
    for z in 0..nz {
        for y in 0..ny {
            for x in 0..nx {
                let selected = match face {
                    StructuredBoundaryFaceIR::XMin => x == 0,
                    StructuredBoundaryFaceIR::XMax => x + 1 == nx,
                    StructuredBoundaryFaceIR::YMin => y == 0,
                    StructuredBoundaryFaceIR::YMax => y + 1 == ny,
                    StructuredBoundaryFaceIR::ZMin => z == 0,
                    StructuredBoundaryFaceIR::ZMax => z + 1 == nz,
                };
                if !selected {
                    continue;
                }
                let face_index = match face {
                    StructuredBoundaryFaceIR::XMin => (nx + 1) * (y + ny * z),
                    StructuredBoundaryFaceIR::XMax => nx + (nx + 1) * (y + ny * z),
                    StructuredBoundaryFaceIR::YMin => x + nx * ((ny + 1) * z),
                    StructuredBoundaryFaceIR::YMax => x + nx * (ny + (ny + 1) * z),
                    StructuredBoundaryFaceIR::ZMin => x + nx * y,
                    StructuredBoundaryFaceIR::ZMax => x + nx * (y + ny * nz),
                };
                cells.push(ExternalBoundaryCell {
                    axis,
                    face_index: face_index as u64,
                    adjacent_cell: cell_index(x, y, z),
                    outward_normal_sign,
                    area_m2,
                });
            }
        }
    }
    Ok(cells)
}

fn owned_active_boundary_cells(
    context: &FdmSpinTransportResolutionContext<'_>,
    object_id: &str,
    active_cells: &[bool],
    face: StructuredBoundaryFaceIR,
) -> Result<Vec<ExternalBoundaryCell>, Vec<String>> {
    if active_cells.len() != context.region_mask.len() {
        return Err(vec![
            "structured FDM boundary active mask does not match the resolved grid".into(),
        ]);
    }
    let object_mask = context
        .object_masks_by_id
        .and_then(|masks| masks.get(object_id));
    if object_mask.is_some_and(|mask| mask.len() != active_cells.len()) {
        return Err(vec![format!(
            "structured FDM object mask '{}' does not match the resolved grid",
            object_id
        )]);
    }
    Ok(
        external_boundary_cells(face, context.grid_cells, context.cell_size_m)?
            .into_iter()
            .filter(|cell| {
                active_cells[cell.adjacent_cell]
                    && object_mask.is_none_or(|mask| mask[cell.adjacent_cell])
            })
            .collect(),
    )
}

#[derive(Clone)]
struct ChargeSurfaceClaim {
    source_id: String,
    condition: ResolvedChargeBoundaryConditionIR,
    cells: Vec<ExternalBoundaryCell>,
}

fn charge_condition_is_neutral(condition: &ResolvedChargeBoundaryConditionIR) -> bool {
    match condition {
        ResolvedChargeBoundaryConditionIR::Voltage { potential_v } => *potential_v == 0.0,
        ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity {
            current_density_apm2,
        } => *current_density_apm2 == 0.0,
        ResolvedChargeBoundaryConditionIR::Insulating => true,
    }
}

fn resolve_charge_boundaries(
    boundaries: &[ChargeBoundaryIR],
    charge_active_cells: &[bool],
    context: &FdmSpinTransportResolutionContext<'_>,
    allow_partial_current_faces: bool,
) -> Result<
    (
        Vec<ResolvedChargeBoundaryFaceIR>,
        Vec<ResolvedSpecifiedCurrentFaceIR>,
    ),
    Vec<String>,
> {
    let mut claims = BTreeMap::<StructuredBoundaryFaceIR, Vec<ChargeSurfaceClaim>>::new();
    let mut exact_surfaces = BTreeMap::<(String, StructuredBoundaryFaceIR), String>::new();
    for boundary in boundaries {
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
            ChargeBoundaryIR::Insulating { .. } => ResolvedChargeBoundaryConditionIR::Insulating,
        };
        for surface in boundary.surfaces() {
            if !object_is_on_grid(context, &surface.object_id) {
                return Err(vec![format!(
                    "charge boundary '{}' references object '{}' outside the FDM transport grid",
                    boundary.id(),
                    surface.object_id
                )]);
            }
            let face = structured_boundary_face(surface)?;
            let exact_key = (surface.object_id.clone(), face);
            if let Some(existing) = exact_surfaces.get(&exact_key) {
                if existing == boundary.id() {
                    continue;
                }
                return Err(vec![format!(
                    "charge boundary surface '{}:{face:?}' is assigned by both '{}' and '{}'",
                    surface.object_id,
                    existing,
                    boundary.id()
                )]);
            }
            let cells = owned_active_boundary_cells(
                context,
                &surface.object_id,
                charge_active_cells,
                face,
            )?;
            if cells.is_empty() {
                if charge_condition_is_neutral(&condition) {
                    continue;
                }
                return Err(vec![format!(
                    "charge boundary '{}' resolves to no active owned FDM face cells for '{}:{:?}'",
                    boundary.id(),
                    surface.object_id,
                    face
                )]);
            }
            exact_surfaces.insert(exact_key, boundary.id().to_string());
            claims.entry(face).or_default().push(ChargeSurfaceClaim {
                source_id: boundary.id().to_string(),
                condition: condition.clone(),
                cells,
            });
        }
    }
    let mut resolved = Vec::with_capacity(6);
    let mut specified = Vec::new();
    for face in all_boundary_faces() {
        let external = external_boundary_cells(face, context.grid_cells, context.cell_size_m)?;
        let active = external
            .iter()
            .filter(|cell| charge_active_cells[cell.adjacent_cell])
            .collect::<Vec<_>>();
        if active.is_empty() {
            resolved.push(ResolvedChargeBoundaryFaceIR {
                source_id: "default:insulating".to_string(),
                face,
                condition: ResolvedChargeBoundaryConditionIR::Insulating,
            });
            continue;
        }
        let face_claims = claims.get(&face).map(Vec::as_slice).unwrap_or_default();
        let mut assigned = BTreeMap::<usize, usize>::new();
        for (claim_index, claim) in face_claims.iter().enumerate() {
            for cell in &claim.cells {
                if assigned.insert(cell.adjacent_cell, claim_index).is_some() {
                    return Err(vec![format!(
                        "charge boundary face {face:?} has overlapping object-owned cell assignments"
                    )]);
                }
            }
        }
        let Some(first_claim) = face_claims.first() else {
            return Err(vec![format!(
                "complete structured FDM charge contract does not assign {face:?}"
            )]);
        };
        let uniform = face_claims
            .iter()
            .all(|claim| claim.condition == first_claim.condition);
        let current_or_insulating = face_claims.iter().all(|claim| {
            matches!(
                claim.condition,
                ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity { .. }
                    | ResolvedChargeBoundaryConditionIR::Insulating
            )
        });
        let has_unassigned_active_cells = active
            .iter()
            .any(|cell| !assigned.contains_key(&cell.adjacent_cell));
        if has_unassigned_active_cells && !(allow_partial_current_faces && current_or_insulating) {
            return Err(vec![format!(
                "charge boundary '{}' is partially owned on structured face {face:?}, but this FDM realization cannot express the unassigned per-cell boundary condition",
                first_claim.source_id
            )]);
        }
        if !uniform && !(allow_partial_current_faces && current_or_insulating) {
            let source_id = face_claims
                .iter()
                .find(|claim| {
                    !matches!(
                        claim.condition,
                        ResolvedChargeBoundaryConditionIR::Insulating
                            | ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity {
                                current_density_apm2: 0.0
                            }
                    )
                })
                .unwrap_or(first_claim)
                .source_id
                .as_str();
            return Err(vec![format!(
                "charge boundary '{}' is partially owned on structured face {face:?}, but this FDM realization cannot express per-cell voltage/current boundary kinds",
                source_id
            )]);
        }
        for claim in face_claims {
            let ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity {
                current_density_apm2,
            } = claim.condition
            else {
                continue;
            };
            for cell in &claim.cells {
                specified.push(ResolvedSpecifiedCurrentFaceIR {
                    source_id: claim.source_id.clone(),
                    axis: cell.axis,
                    face_index: cell.face_index,
                    adjacent_cell: cell.adjacent_cell as u64,
                    outward_normal_sign: cell.outward_normal_sign,
                    area_m2: cell.area_m2,
                    outward_current_density_apm2: current_density_apm2,
                });
            }
        }
        resolved.push(ResolvedChargeBoundaryFaceIR {
            source_id: first_claim.source_id.clone(),
            face,
            condition: if uniform {
                first_claim.condition.clone()
            } else {
                ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity {
                    current_density_apm2: 0.0,
                }
            },
        });
    }
    Ok((resolved, specified))
}

#[cfg(test)]
fn resolve_specified_current_faces(
    boundaries: &[ResolvedChargeBoundaryFaceIR],
    charge_active_cells: &[bool],
    grid_cells: [u32; 3],
    cell_size_m: [f64; 3],
) -> Result<Vec<ResolvedSpecifiedCurrentFaceIR>, Vec<String>> {
    let [nx, ny, nz] = grid_cells.map(|value| value as usize);
    let cell_count = nx
        .checked_mul(ny)
        .and_then(|value| value.checked_mul(nz))
        .ok_or_else(|| vec!["structured FDM current boundary cell count overflows usize".into()])?;
    if cell_count != charge_active_cells.len()
        || cell_size_m
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
    {
        return Err(vec![
            "structured FDM current boundary grid or cell-size contract is invalid".into(),
        ]);
    }
    let cell_index = |x: usize, y: usize, z: usize| x + nx * (y + ny * z);
    let mut resolved = Vec::new();
    for boundary in boundaries {
        let ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity {
            current_density_apm2,
        } = boundary.condition
        else {
            continue;
        };
        let before = resolved.len();
        let (axis, normal_sign, area_m2) = match boundary.face {
            StructuredBoundaryFaceIR::XMin | StructuredBoundaryFaceIR::XMax => (
                0_u8,
                if boundary.face == StructuredBoundaryFaceIR::XMin {
                    -1
                } else {
                    1
                },
                cell_size_m[1] * cell_size_m[2],
            ),
            StructuredBoundaryFaceIR::YMin | StructuredBoundaryFaceIR::YMax => (
                1_u8,
                if boundary.face == StructuredBoundaryFaceIR::YMin {
                    -1
                } else {
                    1
                },
                cell_size_m[0] * cell_size_m[2],
            ),
            StructuredBoundaryFaceIR::ZMin | StructuredBoundaryFaceIR::ZMax => (
                2_u8,
                if boundary.face == StructuredBoundaryFaceIR::ZMin {
                    -1
                } else {
                    1
                },
                cell_size_m[0] * cell_size_m[1],
            ),
        };
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let selected = match boundary.face {
                        StructuredBoundaryFaceIR::XMin => x == 0,
                        StructuredBoundaryFaceIR::XMax => x + 1 == nx,
                        StructuredBoundaryFaceIR::YMin => y == 0,
                        StructuredBoundaryFaceIR::YMax => y + 1 == ny,
                        StructuredBoundaryFaceIR::ZMin => z == 0,
                        StructuredBoundaryFaceIR::ZMax => z + 1 == nz,
                    };
                    if !selected {
                        continue;
                    }
                    let adjacent_cell = cell_index(x, y, z);
                    let face_index = match boundary.face {
                        StructuredBoundaryFaceIR::XMin => (nx + 1) * (y + ny * z),
                        StructuredBoundaryFaceIR::XMax => nx + (nx + 1) * (y + ny * z),
                        StructuredBoundaryFaceIR::YMin => x + nx * ((ny + 1) * z),
                        StructuredBoundaryFaceIR::YMax => x + nx * (ny + (ny + 1) * z),
                        StructuredBoundaryFaceIR::ZMin => x + nx * y,
                        StructuredBoundaryFaceIR::ZMax => x + nx * (y + ny * nz),
                    };
                    if !charge_active_cells[adjacent_cell] {
                        if current_density_apm2 == 0.0 {
                            continue;
                        }
                        return Err(vec![format!(
                            "charge boundary '{}' selects external face index {} whose adjacent cell {} is inactive",
                            boundary.source_id, face_index, adjacent_cell
                        )]);
                    }
                    resolved.push(ResolvedSpecifiedCurrentFaceIR {
                        source_id: boundary.source_id.clone(),
                        axis,
                        face_index: face_index as u64,
                        adjacent_cell: adjacent_cell as u64,
                        outward_normal_sign: normal_sign,
                        area_m2,
                        outward_current_density_apm2: current_density_apm2,
                    });
                }
            }
        }
        if resolved.len() == before {
            return Err(vec![format!(
                "charge boundary '{}' resolves to no active external FDM faces",
                boundary.source_id
            )]);
        }
    }
    Ok(resolved)
}

#[derive(Clone)]
struct SpinSurfaceClaim {
    source_id: String,
    condition: ResolvedSpinBoundaryConditionIR,
    cells: Vec<ExternalBoundaryCell>,
}

fn spin_condition_is_neutral(condition: &ResolvedSpinBoundaryConditionIR) -> bool {
    match condition {
        ResolvedSpinBoundaryConditionIR::SpinInsulating => true,
        ResolvedSpinBoundaryConditionIR::SpecifiedPotential { value_v } => *value_v == [0.0; 3],
        ResolvedSpinBoundaryConditionIR::SpecifiedOutwardFlux { value_apm2 } => {
            *value_apm2 == [0.0; 3]
        }
        ResolvedSpinBoundaryConditionIR::SpinSink
        | ResolvedSpinBoundaryConditionIR::PeriodicSpin => false,
    }
}

fn resolve_spin_boundaries(
    boundaries: &[SpinBoundaryIR],
    spin_active_cells: &[bool],
    context: &FdmSpinTransportResolutionContext<'_>,
) -> Result<Vec<ResolvedSpinBoundaryFaceIR>, Vec<String>> {
    let mut claims = BTreeMap::<StructuredBoundaryFaceIR, Vec<SpinSurfaceClaim>>::new();
    let mut exact_surfaces = BTreeMap::<(String, StructuredBoundaryFaceIR), String>::new();
    for boundary in boundaries {
        let (id, surfaces, condition): (&str, Vec<_>, _) = match boundary {
            SpinBoundaryIR::SpinInsulating { id, surfaces } => (
                id,
                surfaces.iter().collect(),
                ResolvedSpinBoundaryConditionIR::SpinInsulating,
            ),
            SpinBoundaryIR::SpinSink { id, surfaces } => (
                id,
                surfaces.iter().collect(),
                ResolvedSpinBoundaryConditionIR::SpinSink,
            ),
            SpinBoundaryIR::SpecifiedSpinPotential {
                id,
                surfaces,
                spin_potential_v,
            } => (
                id,
                surfaces.iter().collect(),
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
                surfaces.iter().collect(),
                ResolvedSpinBoundaryConditionIR::SpecifiedOutwardFlux {
                    value_apm2: *normal_spin_flux_apm2,
                },
            ),
            SpinBoundaryIR::PeriodicSpin {
                id,
                minus_surface,
                plus_surface,
                ..
            } => (
                id,
                vec![minus_surface, plus_surface],
                ResolvedSpinBoundaryConditionIR::PeriodicSpin,
            ),
        };
        for surface in surfaces {
            if !object_is_on_grid(context, &surface.object_id) {
                return Err(vec![format!(
                    "spin boundary '{id}' references object '{}' outside the FDM grid",
                    surface.object_id
                )]);
            }
            let face = structured_boundary_face(surface)?;
            let exact_key = (surface.object_id.clone(), face);
            if let Some(existing) = exact_surfaces.get(&exact_key) {
                if existing == id {
                    continue;
                }
                return Err(vec![format!(
                    "spin boundary surface '{}:{face:?}' is assigned by both '{}' and '{}'",
                    surface.object_id, existing, id
                )]);
            }
            let cells =
                owned_active_boundary_cells(context, &surface.object_id, spin_active_cells, face)?;
            if cells.is_empty() {
                if spin_condition_is_neutral(&condition) {
                    continue;
                }
                return Err(vec![format!(
                    "spin boundary '{}' resolves to no active owned FDM face cells for '{}:{:?}'",
                    id, surface.object_id, face
                )]);
            }
            exact_surfaces.insert(exact_key, id.to_string());
            claims.entry(face).or_default().push(SpinSurfaceClaim {
                source_id: id.to_string(),
                condition: condition.clone(),
                cells,
            });
        }
    }

    if claims.is_empty() {
        return Ok(all_boundary_faces()
            .into_iter()
            .map(|face| ResolvedSpinBoundaryFaceIR {
                source_id: "default:spin_insulating".to_string(),
                face,
                condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
            })
            .collect());
    }

    let mut resolved = Vec::with_capacity(6);
    for face in all_boundary_faces() {
        let external = external_boundary_cells(face, context.grid_cells, context.cell_size_m)?;
        let active = external
            .iter()
            .filter(|cell| spin_active_cells[cell.adjacent_cell])
            .collect::<Vec<_>>();
        if active.is_empty() {
            resolved.push(ResolvedSpinBoundaryFaceIR {
                source_id: "default:spin_insulating".to_string(),
                face,
                condition: ResolvedSpinBoundaryConditionIR::SpinInsulating,
            });
            continue;
        }
        let face_claims = claims.get(&face).map(Vec::as_slice).unwrap_or_default();
        let mut assigned = BTreeMap::<usize, usize>::new();
        for (claim_index, claim) in face_claims.iter().enumerate() {
            for cell in &claim.cells {
                if assigned.insert(cell.adjacent_cell, claim_index).is_some() {
                    return Err(vec![format!(
                        "spin boundary face {face:?} has overlapping object-owned cell assignments"
                    )]);
                }
            }
        }
        if active
            .iter()
            .any(|cell| !assigned.contains_key(&cell.adjacent_cell))
        {
            return Err(vec![format!(
                "when any spin boundary is authored, structured FDM requires every active owned cell on {face:?} to be assigned explicitly"
            )]);
        }
        let Some(first_claim) = face_claims.first() else {
            return Err(vec![format!(
                "when any spin boundary is authored, structured FDM requires {face:?} to be assigned explicitly"
            )]);
        };
        if face_claims
            .iter()
            .any(|claim| claim.condition != first_claim.condition)
        {
            let source_id = face_claims
                .iter()
                .find(|claim| !spin_condition_is_neutral(&claim.condition))
                .unwrap_or(first_claim)
                .source_id
                .as_str();
            return Err(vec![format!(
                "spin boundary '{}' is partially owned on structured face {face:?}, but the FDM ABI cannot express per-cell spin boundary conditions",
                source_id
            )]);
        }
        resolved.push(ResolvedSpinBoundaryFaceIR {
            source_id: first_claim.source_id.clone(),
            face,
            condition: first_claim.condition.clone(),
        });
    }
    Ok(resolved)
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
                spin_memory_loss,
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
                    spin_memory_loss: spin_memory_loss.as_ref().map(|reservoir| {
                        fullmag_ir::SpinMemoryLossReservoirIR {
                            g_n_spm2: reservoir.g_n_spm2,
                            g_f_spm2: reservoir.g_f_spm2,
                            g_lattice_spm2: reservoir.g_lattice_spm2,
                            formula_version: reservoir.formula_version.clone(),
                        }
                    }),
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
            time_envelope: None,
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
                conservative_current_view: None,
                structured_current_closure: None,
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
                    density_of_states_per_spin_j_inv_m3: None,
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
            object_masks_by_id: None,
            region_masks_by_ref: None,
            grid_cells: [1, 1, 1],
            origin_m: [0.0, 0.0, 0.0],
            cell_size_m: [1.0, 1.0, 1.0],
            active_mask: None,
            region_mask,
            region_index_by_id: region_ids,
            initial_magnetization: magnetization,
            saturation_magnetization_apm: ms,
            gamma0_m_per_a_s: 2.211e5,
        }
    }

    fn structured_closure(
        region_id: &str,
        axis: StructuredCutAxisIR,
        offset_m: f64,
    ) -> StructuredCurrentClosureIR {
        StructuredCurrentClosureIR::ClosedGeometry {
            schema_version: "structured_current_closure.v1".into(),
            closure_id: "loop-1".into(),
            source_cuts: vec![StructuredCurrentSourceCutIR {
                source_cut_id: "cut-1".into(),
                circuit_id: "circuit-1".into(),
                region: RegionRefIR {
                    object_id: "strip".into(),
                    region_id: Some(region_id.into()),
                },
                plane: StructuredCutPlaneIR {
                    axis,
                    offset_m,
                    normal: StructuredCutNormalIR::PositiveAxis,
                },
                drive: StructuredCurrentDriveIR::ImpressedPotentialJump(
                    ImpressedPotentialJumpIR {
                        schema_version: "impressed_potential_jump.v1".into(),
                        drive_id: "drive-1".into(),
                        potential_jump_v: 0.05,
                    },
                ),
            }],
        }
    }

    fn set_structured_closure(problem: &mut ProblemIR, closure: StructuredCurrentClosureIR) {
        let CurrentModuleIR::CurrentTransport {
            definition: Some(definition),
            ..
        } = &mut problem.current_modules[0]
        else {
            panic!("charge definition fixture");
        };
        definition.structured_current_closure = Some(closure);
        definition.solver.operator_version = "fv_charge_harmonic_source_cut_v1".into();
    }

    fn charge_definition(problem: &ProblemIR) -> &ChargeTransportDefinitionIR {
        let CurrentModuleIR::CurrentTransport {
            definition: Some(definition),
            ..
        } = &problem.current_modules[0]
        else {
            panic!("charge definition fixture");
        };
        definition
    }

    #[test]
    fn materializes_region_limited_cut_and_proves_closed_return() {
        let mut problem = problem(ExecutionDevice::Cpu);
        set_structured_closure(
            &mut problem,
            structured_closure("source_arm", StructuredCutAxisIR::Y, 1.0),
        );
        let owners = ["strip"];
        let active = [true, true, true, true, false, true, true, true, true];
        let region_mask = [1, 2, 2, 1, 0, 2, 1, 2, 2];
        let magnetization = [[0.0, 0.0, 1.0]; 9];
        let ms = [8.0e5; 9];
        let region_ids = BTreeMap::from([("source_arm".into(), 1)]);
        let context = FdmSpinTransportResolutionContext {
            owner_names: &owners,
            object_masks_by_id: None,
            region_masks_by_ref: None,
            grid_cells: [3, 3, 1],
            origin_m: [0.0; 3],
            cell_size_m: [1.0; 3],
            active_mask: Some(&active),
            region_mask: &region_mask,
            region_index_by_id: &region_ids,
            initial_magnetization: &magnetization,
            saturation_magnetization_apm: &ms,
            gamma0_m_per_a_s: 2.211e5,
        };

        let resolved = materialize_structured_current_closure(
            &problem,
            charge_definition(&problem),
            &active,
            &context,
        )
        .expect("closed loop must materialize")
        .expect("closure descriptor");

        assert_eq!(resolved.source_cuts[0].plane_face_index, 1);
        assert_eq!(resolved.source_cuts[0].component_label, 0);
        assert_eq!(resolved.source_cuts[0].faces.len(), 1);
        assert_eq!(resolved.source_cuts[0].faces[0].negative_cell, 0);
        assert_eq!(resolved.source_cuts[0].faces[0].positive_cell, 3);
        assert!(resolved.descriptor_sha256.starts_with("sha256:"));
        assert!(resolved.topology_sha256.starts_with("sha256:"));
    }

    #[test]
    fn rejects_unknown_and_zero_face_source_cut_regions() {
        let owners = ["strip"];
        let active = [true, true, true, true, false, true, true, true, true];
        let region_mask = [3, 2, 2, 1, 0, 2, 1, 2, 2];
        let magnetization = [[0.0, 0.0, 1.0]; 9];
        let ms = [8.0e5; 9];

        for (region_id, ids, expected) in [
            ("unknown", BTreeMap::new(), "was not materialized"),
            (
                "zero_faces",
                BTreeMap::from([("zero_faces".into(), 3)]),
                "selects zero internal active charge faces",
            ),
        ] {
            let mut problem = problem(ExecutionDevice::Cpu);
            set_structured_closure(
                &mut problem,
                structured_closure(region_id, StructuredCutAxisIR::Y, 1.0),
            );
            let context = FdmSpinTransportResolutionContext {
                owner_names: &owners,
                object_masks_by_id: None,
                region_masks_by_ref: None,
                grid_cells: [3, 3, 1],
                origin_m: [0.0; 3],
                cell_size_m: [1.0; 3],
                active_mask: Some(&active),
                region_mask: &region_mask,
                region_index_by_id: &ids,
                initial_magnetization: &magnetization,
                saturation_magnetization_apm: &ms,
                gamma0_m_per_a_s: 2.211e5,
            };
            let errors = materialize_structured_current_closure(
                &problem,
                charge_definition(&problem),
                &active,
                &context,
            )
            .expect_err("invalid source region must fail");
            assert!(errors.iter().any(|error| error.contains(expected)), "{errors:?}");
        }
    }

    #[test]
    fn rejects_multi_arm_cross_section_and_open_return() {
        let owners = ["strip"];
        let region_ids = BTreeMap::from([("source_arm".into(), 1)]);

        let mut multi_arm_problem = problem(ExecutionDevice::Cpu);
        set_structured_closure(
            &mut multi_arm_problem,
            structured_closure("source_arm", StructuredCutAxisIR::Y, 1.0),
        );
        let multi_arm_active = [true; 9];
        let multi_arm_regions = [1, 2, 1, 1, 2, 1, 1, 2, 1];
        let multi_arm_m = [[0.0, 0.0, 1.0]; 9];
        let multi_arm_ms = [8.0e5; 9];
        let multi_arm_context = FdmSpinTransportResolutionContext {
            owner_names: &owners,
            object_masks_by_id: None,
            region_masks_by_ref: None,
            grid_cells: [3, 3, 1],
            origin_m: [0.0; 3],
            cell_size_m: [1.0; 3],
            active_mask: Some(&multi_arm_active),
            region_mask: &multi_arm_regions,
            region_index_by_id: &region_ids,
            initial_magnetization: &multi_arm_m,
            saturation_magnetization_apm: &multi_arm_ms,
            gamma0_m_per_a_s: 2.211e5,
        };
        let errors = materialize_structured_current_closure(
            &multi_arm_problem,
            charge_definition(&multi_arm_problem),
            &multi_arm_active,
            &multi_arm_context,
        )
        .expect_err("disconnected arms on one plane must fail");
        assert!(errors.iter().any(|error| error.contains("multiple disconnected")));

        let mut open_problem = problem(ExecutionDevice::Cpu);
        set_structured_closure(
            &mut open_problem,
            structured_closure("source_arm", StructuredCutAxisIR::X, 1.0),
        );
        let open_active = [true; 3];
        let open_regions = [1; 3];
        let open_m = [[0.0, 0.0, 1.0]; 3];
        let open_ms = [8.0e5; 3];
        let open_context = FdmSpinTransportResolutionContext {
            owner_names: &owners,
            object_masks_by_id: None,
            region_masks_by_ref: None,
            grid_cells: [3, 1, 1],
            origin_m: [0.0; 3],
            cell_size_m: [1.0; 3],
            active_mask: Some(&open_active),
            region_mask: &open_regions,
            region_index_by_id: &region_ids,
            initial_magnetization: &open_m,
            saturation_magnetization_apm: &open_ms,
            gamma0_m_per_a_s: 2.211e5,
        };
        let errors = materialize_structured_current_closure(
            &open_problem,
            charge_definition(&open_problem),
            &open_active,
            &open_context,
        )
        .expect_err("open conductor must have no return path");
        assert!(errors.iter().any(|error| error.contains("return path")));
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
    fn sml_reservoir_v2_lowers_to_the_fdm_m2_reference_descriptor() {
        let owners = ["strip"];
        let region_mask = [0, 1];
        let magnetization = [[0.0, 0.0, 1.0]; 2];
        let ms = [8.0e5; 2];
        let mut region_ids = BTreeMap::new();
        region_ids.insert("normal".into(), 0);
        region_ids.insert("ferro".into(), 1);
        let mut problem = reciprocal_problem(ExecutionDevice::Cpu);
        problem.spin_transport_modules[0].interfaces = vec![SpinInterfaceIR::MixingConductance {
            id: "sml".into(),
            normal_to_ferromagnet: [1.0, 0.0, 0.0],
            normal_side: RegionRefIR {
                object_id: "strip".into(),
                region_id: Some("normal".into()),
            },
            ferromagnet_side: RegionRefIR {
                object_id: "strip".into(),
                region_id: Some("ferro".into()),
            },
            g_up_spm2: 2.0,
            g_down_spm2: 3.0,
            g_r_spm2: 4.0,
            g_i_spm2: 0.0,
            g_sml_spm2: 0.0,
            spin_memory_loss: Some(fullmag_ir::SpinMemoryLossReservoirIR {
                g_n_spm2: 2.0,
                g_f_spm2: 3.0,
                g_lattice_spm2: 4.0,
                formula_version: "sml_reservoir.fullmag.v2".into(),
            }),
            absorption: "full".into(),
            formula_version: "magnetoelectronic.fullmag.v2".into(),
        }];

        let mut resolution_context =
            context(&owners, &region_mask, &magnetization, &ms, &region_ids);
        resolution_context.grid_cells = [2, 1, 1];
        let plans = resolve_spin_transport(&problem, BackendTarget::Fdm, &resolution_context)
            .expect("SML v2 should lower to the FDM M2 reference descriptor");
        let descriptor = plans[0]
            .fdm_cpu_double_reciprocal
            .as_ref()
            .expect("reciprocal descriptor");
        assert!(plans[0]
            .capabilities
            .contains(&"transport.spin.memory_loss".to_string()));
        assert!(matches!(
            descriptor.interfaces[0].law,
            fullmag_ir::ResolvedSpinInterfaceLawIR::MixingConductance {
                spin_memory_loss: Some(_),
                ..
            }
        ));
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
    fn reciprocal_m2_preserves_authored_current_time_envelope() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let mut problem = reciprocal_problem(ExecutionDevice::Cpu);
        let CurrentModuleIR::CurrentTransport { time_envelope, .. } =
            &mut problem.current_modules[0]
        else {
            unreachable!()
        };
        *time_envelope = Some(TimeEnvelopeIR::Constant { value: 2.0 });

        let plans = resolve_spin_transport(
            &problem,
            BackendTarget::Fdm,
            &context(&owners, &region_mask, &magnetization, &ms, &region_ids),
        )
        .expect("reciprocal M2 with a prescribed envelope should resolve");
        assert_eq!(
            plans[0]
                .fdm_cpu_double_reciprocal
                .as_ref()
                .and_then(|descriptor| descriptor.time_envelope.as_ref()),
            Some(&TimeEnvelopeIR::Constant { value: 2.0 })
        );
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
            Some("dos_isotropic_nonmagnetic.fullmag.v1".into());
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
            ["dos_isotropic_nonmagnetic.fullmag.v1"]
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
            "dos_isotropic_nonmagnetic.fullmag.v1"
        );
    }

    #[test]
    fn resolves_transient_dos_adapter_to_physical_spin_capacitance() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let mut problem = problem(ExecutionDevice::Cpu);
        let spin = &mut problem.spin_transport_modules[0];
        spin.mode = SpinTransportModeIR::Transient;
        spin.materials[0]
            .material
            .density_of_states_per_spin_j_inv_m3 =
            Some(2.0 / fullmag_ir::ELEMENTARY_CHARGE_C.powi(2));
        spin.materials[0].material.capacitance_formula_version =
            Some("dos_isotropic_nonmagnetic.fullmag.v1".into());
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
        .expect("DOS-only transient material should resolve");
        assert_eq!(
            plans[0]
                .fdm_cpu_double_transient
                .as_ref()
                .expect("transient descriptor")
                .spin_capacitance_as_per_v_m3,
            [2.0]
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
            Some("dos_isotropic_nonmagnetic.fullmag.v1".into());
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
                surfaces: vec![
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "left".into(),
                        orientation: [-1.0, 0.0, 0.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "front".into(),
                        orientation: [0.0, 1.0, 0.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "right".into(),
                        orientation: [1.0, 0.0, 0.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "top".into(),
                        orientation: [0.0, 0.0, 1.0],
                    },
                ],
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
        let mesh = MeshIR::from_legacy_tet4(
            "tet".into(),
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 1.0],
                [1.0, 1.0, 1.0],
                [0.0, 1.0, 1.0],
            ],
            vec![
                [0, 1, 2, 6],
                [0, 2, 3, 6],
                [0, 3, 7, 6],
                [0, 7, 4, 6],
                [0, 4, 5, 6],
                [0, 5, 1, 6],
            ],
            vec![7; 6],
            vec![
                [0, 3, 2],
                [0, 2, 1],
                [0, 1, 5],
                [0, 5, 4],
                [0, 4, 7],
                [0, 7, 3],
                [3, 7, 6],
                [3, 6, 2],
                [1, 2, 6],
                [1, 6, 5],
                [4, 5, 6],
                [4, 6, 7],
            ],
            vec![11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16],
            vec![],
            vec![],
            Default::default(),
        );
        let segment = FemObjectSegmentIR {
            object_id: "strip".into(),
            geometry_id: None,
            node_start: 0,
            node_count: 8,
            element_start: 0,
            element_count: 6,
            boundary_face_start: 0,
            boundary_face_count: 12,
        };
        let part = FemMeshPartIR {
            id: "strip".into(),
            label: "strip".into(),
            role: FemMeshPartRole::MagneticObject,
            object_id: Some("strip".into()),
            geometry_id: None,
            material_id: None,
            element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 6 },
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                start: 0,
                count: 12,
            },
            node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 8 },
            boundary_face_indices: (0..12).collect(),
            node_indices: (0..8).collect(),
            facet_global_ordinals: vec![],
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
            &[[0.0, 0.0, 1.0]; 8],
            8.0e5,
            2.211e5,
        )
        .expect("canonical FEM descriptor");
        let descriptor = plans[0]
            .fem_cpu_double
            .as_ref()
            .expect("executable FEM descriptor");
        assert_eq!(descriptor.charge_conductivity_spm_per_element, [4.0e6; 6]);
        assert_eq!(descriptor.charge_dirichlet, [(11, 0.0), (12, 0.1)]);
        assert_eq!(descriptor.charge_domain.element_mask, [true; 6]);
        assert_eq!(descriptor.spin_domain.element_mask, [true; 6]);
        assert_eq!(
            descriptor.charge_insulating_boundaries[0].boundary_attributes,
            [13, 14, 15, 16]
        );
        assert_eq!(
            descriptor.spin_insulating_boundaries[0].boundary_attributes,
            [11, 12, 13, 14, 15, 16]
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
    fn fem_ohmic_oersted_binds_the_solved_charge_field() {
        let mut problem = fem_problem();
        problem.energy_terms.push(EnergyTermIR::OerstedField {
            id: None,
            model: OerstedFieldModelIR::FromCurrentSolution,
            source: "charge".into(),
        });
        let (mesh, segments, parts) = fem_mesh_fixture();
        let plans = resolve_m1_fem_spin_transport(
            &problem,
            &mesh,
            &segments,
            &parts,
            &[[0.0, 0.0, 1.0]; 8],
            8.0e5,
            2.211e5,
        )
        .expect("bounded FEM Oersted source binding");
        let descriptor = plans[0]
            .fem_cpu_double
            .as_ref()
            .expect("executable FEM descriptor");
        assert!(descriptor.oersted_source_bound);
    }

    #[test]
    fn fem_reciprocal_oersted_resolves_combined_stage_callback() {
        let mut problem = fem_problem();
        let CurrentModuleIR::CurrentTransport {
            model,
            coupling,
            definition: Some(charge),
            solve_region,
            conductivity_s_per_m,
            ..
        } = &mut problem.current_modules[0]
        else {
            panic!("charge fixture");
        };
        *model = CurrentTransportModelIR::MagnetoresistivePoisson;
        *coupling = TransportCouplingIR::Bidirectional;
        *solve_region = None;
        *conductivity_s_per_m = None;
        charge.materials[0].material.sigma_parallel_spm = Some(4.4e6);
        charge.materials[0].material.sigma_perpendicular_spm = Some(4.0e6);
        charge.materials[0].material.sigma_ahe_spm = Some(0.2e6);
        charge.solver.engine = "block_gmres".into();
        charge.solver.operator_version = FEM_M2_OPERATOR_VERSION.into();
        charge.solver.physical_residual_version = FEM_RESIDUAL_VERSION.into();
        problem.spin_transport_modules[0].constitutive_version = FEM_M2_CONSTITUTIVE_VERSION.into();
        problem.spin_transport_modules[0].solver.operator_version = FEM_M2_OPERATOR_VERSION.into();
        problem.energy_terms.push(EnergyTermIR::OerstedField {
            id: Some("oersted:charge".into()),
            model: OerstedFieldModelIR::FromCurrentSolution,
            source: "charge".into(),
        });
        let (mesh, segments, parts) = fem_mesh_fixture();
        let plans = resolve_m1_fem_spin_transport(
            &problem,
            &mesh,
            &segments,
            &parts,
            &[[0.0, 0.0, 1.0]; 8],
            8.0e5,
            2.211e5,
        )
        .expect("FEM reciprocal Oersted should resolve through the combined stage callback");
        let descriptor = plans[0].fem_cpu_double.as_ref().expect("FEM M2 descriptor");
        assert_eq!(
            descriptor.stage_coupling,
            FEM_STAGE_TRANSPORT_OERSTED_CALLBACK_POLICY
        );
        assert!(descriptor.torque_target.is_none());
    }

    #[test]
    fn resolves_bounded_fem_m2_to_reciprocal_descriptor_without_fallback() {
        let (mesh, segments, parts) = fem_mesh_fixture();
        let mut problem = fem_problem();
        problem.backend_policy.requested_backend = BackendTarget::Fem;
        problem.spin_transport_modules[0]
            .requested_execution
            .discretization = BackendTarget::Fem;
        let CurrentModuleIR::CurrentTransport {
            model,
            coupling,
            definition: Some(charge),
            solve_region,
            conductivity_s_per_m,
            ..
        } = &mut problem.current_modules[0]
        else {
            panic!("charge fixture");
        };
        *model = CurrentTransportModelIR::MagnetoresistivePoisson;
        *coupling = TransportCouplingIR::Bidirectional;
        *solve_region = None;
        *conductivity_s_per_m = None;
        let material = &mut charge.materials[0].material;
        material.sigma_parallel_spm = Some(4.4e6);
        material.sigma_perpendicular_spm = Some(4.0e6);
        material.sigma_ahe_spm = Some(0.2e6);
        charge.solver.engine = "block_gmres".into();
        charge.solver.operator_version = FEM_M2_OPERATOR_VERSION.into();
        charge.solver.physical_residual_version = FEM_RESIDUAL_VERSION.into();
        problem.spin_transport_modules[0].constitutive_version = FEM_M2_CONSTITUTIVE_VERSION.into();
        problem.spin_transport_modules[0].solver.operator_version = FEM_M2_OPERATOR_VERSION.into();
        problem.spin_torque_modules.clear();
        problem
            .validate()
            .expect("bounded FEM M2 fixture should satisfy canonical IR validation");

        let plans = resolve_m1_fem_spin_transport(
            &problem,
            &mesh,
            &segments,
            &parts,
            &[[0.0, 0.0, 1.0]; 8],
            8.0e5,
            2.211e5,
        )
        .expect("bounded FEM M2 descriptor");
        let plan = &plans[0];
        assert_eq!(plan.resolved_coupling, TransportCouplingIR::Bidirectional);
        assert!(plan.fdm_cpu_double.is_none());
        let descriptor = plan
            .fem_cpu_double
            .as_ref()
            .expect("executable FEM M2 descriptor");
        let material = descriptor
            .reciprocal_material
            .as_ref()
            .expect("reciprocal material");
        assert_eq!(material.sigma_parallel_spm, 4.4e6);
        assert_eq!(material.sigma_perpendicular_spm, 4.0e6);
        assert_eq!(material.sigma_ahe_spm, 0.2e6);
        assert_eq!(
            descriptor.descriptor_schema,
            "fullmag.fem.spin_transport_descriptor.m2.v1"
        );
        assert_eq!(
            descriptor.validation_scope,
            "fem_cpu_double_conforming_h1_p1_reciprocal_m2"
        );
        assert!(plan
            .capabilities
            .contains(&"transport.spin.inverse_she".to_string()));
    }

    #[test]
    fn resolves_bounded_fem_m2_torque_to_stage_transport_callback() {
        let (mesh, segments, parts) = fem_mesh_fixture();
        let mut problem = fem_problem();
        problem.backend_policy.requested_backend = BackendTarget::Fem;
        problem.spin_transport_modules[0]
            .requested_execution
            .discretization = BackendTarget::Fem;
        let CurrentModuleIR::CurrentTransport {
            model,
            coupling,
            definition: Some(charge),
            solve_region,
            conductivity_s_per_m,
            ..
        } = &mut problem.current_modules[0]
        else {
            panic!("charge fixture");
        };
        *model = CurrentTransportModelIR::MagnetoresistivePoisson;
        *coupling = TransportCouplingIR::Bidirectional;
        *solve_region = None;
        *conductivity_s_per_m = None;
        let material = &mut charge.materials[0].material;
        material.sigma_parallel_spm = Some(4.4e6);
        material.sigma_perpendicular_spm = Some(4.0e6);
        material.sigma_ahe_spm = Some(0.2e6);
        charge.solver.engine = "block_gmres".into();
        charge.solver.operator_version = FEM_M2_OPERATOR_VERSION.into();
        charge.solver.physical_residual_version = FEM_RESIDUAL_VERSION.into();
        problem.spin_transport_modules[0].constitutive_version = FEM_M2_CONSTITUTIVE_VERSION.into();
        problem.spin_transport_modules[0].solver.operator_version = FEM_M2_OPERATOR_VERSION.into();
        problem
            .spin_torque_modules
            .push(SpinTorqueModuleIR::DriftDiffusionSpinTorque {
                schema_version: "drift_diffusion_spin_torque.v1".into(),
                id: "transport_torque".into(),
                solve_id: "spin".into(),
                target: RegionRefIR {
                    object_id: "strip".into(),
                    region_id: None,
                },
                formula_version: "transport_torque_angular_momentum.fullmag.v1".into(),
            });
        problem
            .validate()
            .expect("bounded FEM M2 torque fixture should satisfy canonical IR validation");

        let plans = resolve_m1_fem_spin_transport(
            &problem,
            &mesh,
            &segments,
            &parts,
            &[[0.0, 0.0, 1.0]; 8],
            8.0e5,
            2.211e5,
        )
        .expect("bounded FEM M2 torque descriptor");
        let descriptor = plans[0]
            .fem_cpu_double
            .as_ref()
            .expect("executable FEM M2 torque descriptor");
        assert_eq!(
            descriptor.stage_coupling,
            FEM_STAGE_TRANSPORT_CALLBACK_POLICY
        );
        assert!(descriptor.torque_target.is_some());
        assert_eq!(
            descriptor.validation_scope,
            "fem_cpu_double_conforming_h1_p1_reciprocal_m2"
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
                &[[0.0, 0.0, 1.0]; 8],
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
            .any(|reason| reason.contains("face-exact ownership is incomplete")));

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
            [11, 12, 13, 14, 15, 16]
        );
    }

    #[test]
    fn fem_boundary_marker_lowering_requires_face_exact_assignment_ownership() {
        let (mut mesh, segments, parts) = fem_mesh_fixture();
        mesh.boundary_markers = vec![11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16];
        let resolve = |problem: &ProblemIR| {
            resolve_m1_fem_spin_transport(
                problem,
                &mesh,
                &segments,
                &parts,
                &[[0.0, 0.0, 1.0]; 8],
                8.0e5,
                2.211e5,
            )
        };

        let mut partial_charge = fem_problem();
        let CurrentModuleIR::CurrentTransport {
            definition: Some(charge),
            ..
        } = &mut partial_charge.current_modules[0]
        else {
            panic!("charge fixture");
        };
        charge.boundaries.remove(1);
        let error = resolve(&partial_charge)
            .expect_err("one selected face must not silently expand to its shared marker");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("face-exact")));

        let mut legal_charge = fem_problem();
        let CurrentModuleIR::CurrentTransport {
            definition: Some(charge),
            ..
        } = &mut legal_charge.current_modules[0]
        else {
            panic!("charge fixture");
        };
        let back = charge.boundaries.remove(1).surfaces()[0].clone();
        let ChargeBoundaryIR::VoltageElectrode { surfaces, .. } = &mut charge.boundaries[0] else {
            panic!("voltage fixture");
        };
        surfaces.push(back);
        resolve(&legal_charge).expect("one assignment may own every face of a shared marker");

        let mut partial_spin = fem_problem();
        let CurrentModuleIR::CurrentTransport {
            definition: Some(charge),
            ..
        } = &mut partial_spin.current_modules[0]
        else {
            panic!("charge fixture");
        };
        charge.boundaries.clear();
        charge.gauge = ChargePotentialGaugeIR::ZeroMean;
        partial_spin.spin_transport_modules[0].boundaries = vec![
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
                surfaces: vec![
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "left".into(),
                        orientation: [-1.0, 0.0, 0.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "front".into(),
                        orientation: [0.0, 1.0, 0.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "right".into(),
                        orientation: [1.0, 0.0, 0.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "top".into(),
                        orientation: [0.0, 0.0, 1.0],
                    },
                ],
            },
        ];
        let error = resolve(&partial_spin)
            .expect_err("spin selector must not silently expand to an unselected shared face");
        assert!(error
            .reasons
            .iter()
            .any(|reason| reason.contains("face-exact")));

        let back = SurfaceRefIR {
            object_id: "strip".into(),
            surface_id: "back".into(),
            orientation: [0.0, -1.0, 0.0],
        };
        let SpinBoundaryIR::SpinSink { surfaces, .. } =
            &mut partial_spin.spin_transport_modules[0].boundaries[0]
        else {
            panic!("spin sink fixture");
        };
        surfaces.push(back);
        resolve(&partial_spin).expect("one spin assignment may own every face of a shared marker");
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
            &[[0.0, 0.0, 1.0]; 8],
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
            &[[0.0, 0.0, 1.0]; 8],
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
    fn fem_gpu_transport_request_fails_closed_without_cpu_rebinding() {
        let (mesh, segments, parts) = fem_mesh_fixture();
        let mut problem = fem_problem();
        problem.spin_transport_modules[0].requested_execution.device = ExecutionDevice::Gpu;
        let requested_device = problem.spin_transport_modules[0].requested_execution.device;

        let error = resolve_m1_fem_spin_transport(
            &problem,
            &mesh,
            &segments,
            &parts,
            &[[0.0, 0.0, 1.0]; 8],
            8.0e5,
            2.211e5,
        )
        .expect_err("unqualified FEM GPU transport must be rejected");

        assert_eq!(requested_device, ExecutionDevice::Gpu);
        assert!(error.reasons.iter().any(|reason| {
            reason.contains("requested GPU") && reason.contains("cannot fall back silently")
        }));
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
                &[[0.0, 0.0, 1.0]; 8],
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
            spin_memory_loss: None,
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
        assert_rejected(coupled, "requires reciprocal FEM M2 stage transport");

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
                surfaces: vec![
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "bottom".into(),
                        orientation: [0.0, 0.0, -1.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "back".into(),
                        orientation: [0.0, -1.0, 0.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "left".into(),
                        orientation: [-1.0, 0.0, 0.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "front".into(),
                        orientation: [0.0, 1.0, 0.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "right".into(),
                        orientation: [1.0, 0.0, 0.0],
                    },
                    SurfaceRefIR {
                        object_id: "strip".into(),
                        surface_id: "top".into(),
                        orientation: [0.0, 0.0, 1.0],
                    },
                ],
                normal_spin_flux_apm2: [1.0, 0.0, 0.0],
            });
        assert_rejected(spin_flux, "specified spin flux");
    }

    fn valid_rt0_view_for_planner() -> (MeshIR, ResolvedFemConservativeCurrentViewIR) {
        let mesh = MeshIR::from_legacy_tet4(
            "rt0".into(),
            vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            vec![[0, 1, 2, 3]],
            vec![1],
            vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
            vec![1, 1, 1, 1],
            vec![],
            vec![],
            std::collections::HashMap::new(),
        );
        let identity = ConservativeCurrentIdentityIR {
            source_module_id: "drive".into(),
            source_state_revision: "state-1".into(),
            source_field_digest: "field-1".into(),
            conductivity_digest: "sigma-1".into(),
            mesh_revision: "mesh-1".into(),
            topology_revision: "topology-1".into(),
            geometry_digest: "geometry-1".into(),
            envelope_revision: "envelope-1".into(),
            envelope_digest: "envelope-digest-1".into(),
            evaluated_envelope_multiplier: 1.0,
            evaluation_time_s: 0.0,
            stage_identity: 1,
        };
        let boundary_faces = vec![
            ConservativeCurrentBoundaryFaceIR {
                face_vertex_ids: [10, 20, 30],
                role: ConservativeCurrentBoundaryRoleIR::SourceCut,
                circuit_id: Some("cut".into()),
            },
            ConservativeCurrentBoundaryFaceIR {
                face_vertex_ids: [10, 20, 40],
                role: ConservativeCurrentBoundaryRoleIR::SourceCut,
                circuit_id: Some("cut".into()),
            },
            ConservativeCurrentBoundaryFaceIR {
                face_vertex_ids: [10, 30, 40],
                role: ConservativeCurrentBoundaryRoleIR::InsulatingOuter,
                circuit_id: None,
            },
            ConservativeCurrentBoundaryFaceIR {
                face_vertex_ids: [20, 30, 40],
                role: ConservativeCurrentBoundaryRoleIR::InsulatingOuter,
                circuit_id: None,
            },
        ];
        let view = ResolvedFemConservativeCurrentViewIR {
            stable_vertex_ids: vec![10, 20, 30, 40],
            boundary_faces,
            identity: identity.clone(),
            pins: ConservativeCurrentPinsIR {
                required_source_state_revision: identity.source_state_revision.clone(),
                required_source_field_digest: identity.source_field_digest.clone(),
                required_mesh_revision: identity.mesh_revision.clone(),
                required_topology_revision: identity.topology_revision.clone(),
            },
            closure: ConservativeCurrentClosureIR::ClosedGeometry {
                operator_version: "fem_closed_current_geometry.v1".into(),
                revision: "closure-1".into(),
                digest: "closure-digest-1".into(),
                source_cuts: vec![ConservativeCurrentSourceCutIR {
                    id: "cut".into(),
                    translation_m: [1.0, 0.0, 0.0],
                    potential_drop_v: 0.1,
                    face_pairs: vec![ConservativeCurrentSourceCutFacePairIR {
                        minus_face_vertex_ids: [10, 20, 30],
                        plus_face_vertex_ids: [10, 20, 40],
                    }],
                }],
            },
            algebraic_relative_tolerance: 1.0e-10,
            physical_relative_gate: 1.0e-8,
            physical_absolute_gate_a: 1.0e-12,
            reference_mpi_gather_broadcast: false,
        };
        (mesh, view)
    }

    #[test]
    fn planner_accepts_complete_closed_geometry_rt0_view() {
        let (mesh, view) = valid_rt0_view_for_planner();
        let resolved =
            validate_conservative_current_view(Some(&view), "spin", "drive", &mesh, false)
                .expect("valid RT0 view should lower");
        assert_eq!(resolved, Some(view));
    }

    #[test]
    fn closed_one_way_oersted_view_resolves_to_native_stage_callback() {
        let (mesh, view) = valid_rt0_view_for_planner();
        assert_eq!(
            resolve_fem_stage_coupling(false, true, Some(&view)),
            FEM_STAGE_OERSTED_CALLBACK_POLICY
        );
        assert_eq!(
            resolve_fem_stage_coupling(false, false, Some(&view)),
            "none"
        );
        assert_eq!(resolve_fem_stage_coupling(true, true, Some(&view)), "none");
        let mut external_lead = view;
        external_lead.closure = fullmag_ir::ConservativeCurrentClosureIR::ExternalLead {
            operator_version: "lead.v1".into(),
            revision: "lead-1".into(),
            digest: "lead-digest".into(),
            drive_id: "drive".into(),
            outer_electrode_potential_drop_v: 1.0,
            lead_mesh: mesh,
            lead_conductivity_spm_per_element: vec![],
            lead_stable_vertex_ids: vec![],
            interface_pairs: vec![],
            minus_outer_electrode_face_vertex_ids: vec![],
            plus_outer_electrode_face_vertex_ids: vec![],
            lead_conductivity_digest: "lead-sigma".into(),
        };
        assert_eq!(
            resolve_fem_stage_coupling(false, true, Some(&external_lead)),
            FEM_STAGE_OERSTED_CALLBACK_POLICY
        );
    }

    #[test]
    fn closed_one_way_oersted_stage_field_resolves_native_callback_policy() {
        let (_mesh, view) = valid_rt0_view_for_planner();
        assert_eq!(
            resolve_fem_stage_coupling_for_stage(false, true, Some(&view)),
            FEM_STAGE_OERSTED_CALLBACK_POLICY
        );
    }

    #[test]
    fn planner_rejects_duplicate_boundary_and_accepts_complete_external_lead_view() {
        let (mesh, mut view) = valid_rt0_view_for_planner();
        view.boundary_faces[1] = view.boundary_faces[0].clone();
        let duplicate =
            validate_conservative_current_view(Some(&view), "spin", "drive", &mesh, false)
                .expect_err("duplicate boundary must fail closed");
        assert!(duplicate.join(" ").contains("duplicate"));

        let (mesh, mut same_face_view) = valid_rt0_view_for_planner();
        if let ConservativeCurrentClosureIR::ClosedGeometry { source_cuts, .. } =
            &mut same_face_view.closure
        {
            source_cuts[0].face_pairs[0].plus_face_vertex_ids =
                source_cuts[0].face_pairs[0].minus_face_vertex_ids;
        }
        let same_face = validate_conservative_current_view(
            Some(&same_face_view),
            "spin",
            "drive",
            &mesh,
            false,
        )
        .expect_err("source cut must pair distinct faces");
        assert!(same_face.join(" ").contains("distinct"));

        let (mesh, mut valid_view) = valid_rt0_view_for_planner();
        valid_view.boundary_faces[0].role = ConservativeCurrentBoundaryRoleIR::ClosureInterface;
        valid_view.boundary_faces[0].circuit_id = Some("lead-iface".into());
        view = valid_view;
        view.closure = ConservativeCurrentClosureIR::ExternalLead {
            operator_version: "fem_closed_current_extension.v1".into(),
            revision: "lead-1".into(),
            digest: "lead-digest".into(),
            drive_id: "drive".into(),
            outer_electrode_potential_drop_v: 0.1,
            lead_mesh: mesh.clone(),
            lead_conductivity_spm_per_element: vec![1.0],
            lead_stable_vertex_ids: vec![110, 120, 130, 140],
            interface_pairs: vec![([10, 20, 30], [110, 120, 130])],
            minus_outer_electrode_face_vertex_ids: vec![[110, 120, 140]],
            plus_outer_electrode_face_vertex_ids: vec![[110, 130, 140]],
            lead_conductivity_digest: "lead-sigma".into(),
        };
        validate_conservative_current_view(Some(&view), "spin", "drive", &mesh, false)
            .expect("complete external lead must pass planner validation");
    }

    #[test]
    fn native_m1_v1_is_explicit_and_never_selected_from_auto() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let context = context(&owners, &region_mask, &magnetization, &ms, &region_ids);

        let automatic =
            resolve_spin_transport(&problem(ExecutionDevice::Cpu), BackendTarget::Fdm, &context)
                .expect("reference plan");
        assert_eq!(
            automatic[0].fdm_cpu_double.as_ref().unwrap().realization,
            FdmCpuTransportRealizationIR::RustReferenceV1
        );

        let mut native = problem(ExecutionDevice::Cpu);
        native.spin_transport_modules[0].solver.engine = "native_m1_v1".into();
        let resolved = resolve_spin_transport(&native, BackendTarget::Fdm, &context)
            .expect("explicit native M1 plan");
        assert_eq!(
            resolved[0].fdm_cpu_double.as_ref().unwrap().realization,
            FdmCpuTransportRealizationIR::NativeM1V1
        );
    }

    #[test]
    fn native_m1_v1_requires_enclosing_global_strict_mode() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let context = context(&owners, &region_mask, &magnetization, &ms, &region_ids);

        let mut extended = problem(ExecutionDevice::Cpu);
        extended.spin_transport_modules[0].solver.engine = "native_m1_v1".into();
        extended.validation_profile.execution_mode = ExecutionMode::Extended;
        let error = resolve_spin_transport(&extended, BackendTarget::Fdm, &context)
            .expect_err("global extended plus module strict must fail closed");
        let reason = error.reasons.join(" ");
        assert!(reason.contains("native_m1_v1"));
        assert!(reason.contains("enclosing execution mode must be strict"));
    }

    #[test]
    fn native_m1_v1_rejects_gpu_single_m2_and_m3_without_fallback() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let context = context(&owners, &region_mask, &magnetization, &ms, &region_ids);

        let mut gpu = problem(ExecutionDevice::Gpu);
        gpu.spin_transport_modules[0].solver.engine = "native_m1_v1".into();
        let gpu_error = resolve_spin_transport(&gpu, BackendTarget::Fdm, &context)
            .expect_err("native GPU must fail");
        let gpu_reasons = gpu_error.reasons.join(" ");
        assert!(
            gpu_reasons.contains("cannot fall back silently")
                || gpu_reasons.contains("explicit FDM/CPU/double/strict")
        );

        let mut reciprocal = reciprocal_problem(ExecutionDevice::Cpu);
        reciprocal.spin_transport_modules[0].solver.engine = "native_m1_v1".into();
        let m2_error = resolve_spin_transport(&reciprocal, BackendTarget::Fdm, &context)
            .expect_err("native M2 must fail");
        assert!(m2_error
            .reasons
            .join(" ")
            .contains("M2/M3 fallback is forbidden"));

        let mut single = problem(ExecutionDevice::Cpu);
        single.spin_transport_modules[0].solver.engine = "native_m1_v1".into();
        single.spin_transport_modules[0]
            .requested_execution
            .precision = ExecutionPrecision::Single;
        let single_error = resolve_spin_transport(&single, BackendTarget::Fdm, &context)
            .expect_err("native single precision must fail");
        assert!(single_error
            .reasons
            .join(" ")
            .contains("explicit FDM/CPU/double/strict"));

        let mut transient = problem(ExecutionDevice::Cpu);
        transient.spin_transport_modules[0].solver.engine = "native_m1_v1".into();
        transient.spin_transport_modules[0].mode = SpinTransportModeIR::Transient;
        let m3_error = resolve_spin_transport(&transient, BackendTarget::Fdm, &context)
            .expect_err("native M3 must fail");
        assert!(m3_error
            .reasons
            .join(" ")
            .contains("M2/M3 fallback is forbidden"));
    }

    #[test]
    fn native_m1_v1_rejects_sml_and_periodic_without_degradation() {
        let owners = ["strip"];
        let region_mask = [0];
        let magnetization = [[0.0, 0.0, 1.0]];
        let ms = [8.0e5];
        let region_ids = BTreeMap::new();
        let context = context(&owners, &region_mask, &magnetization, &ms, &region_ids);

        let mut sml = problem(ExecutionDevice::Cpu);
        sml.spin_transport_modules[0].solver.engine = "native_m1_v1".into();
        sml.spin_transport_modules[0].interfaces = vec![SpinInterfaceIR::MixingConductance {
            id: "sml".into(),
            normal_to_ferromagnet: [1.0, 0.0, 0.0],
            normal_side: RegionRefIR {
                object_id: "strip".into(),
                region_id: None,
            },
            ferromagnet_side: RegionRefIR {
                object_id: "strip".into(),
                region_id: None,
            },
            g_up_spm2: 2.0,
            g_down_spm2: 3.0,
            g_r_spm2: 4.0,
            g_i_spm2: 0.0,
            g_sml_spm2: 0.0,
            spin_memory_loss: Some(SpinMemoryLossReservoirIR {
                g_n_spm2: 2.0,
                g_f_spm2: 3.0,
                g_lattice_spm2: 4.0,
                formula_version: "sml_reservoir.fullmag.v2".into(),
            }),
            absorption: "full".into(),
            formula_version: "magnetoelectronic.fullmag.v2".into(),
        }];
        let sml_error = resolve_spin_transport(&sml, BackendTarget::Fdm, &context)
            .expect_err("native SML must fail");
        assert!(sml_error
            .reasons
            .join(" ")
            .contains("does not support SML and cannot degrade"));

        let mut periodic = problem(ExecutionDevice::Cpu);
        periodic.spin_transport_modules[0].solver.engine = "native_m1_v1".into();
        periodic.spin_transport_modules[0].boundaries = vec![SpinBoundaryIR::PeriodicSpin {
            id: "periodic-x".into(),
            minus_surface: SurfaceRefIR {
                object_id: "strip".into(),
                surface_id: "x_min".into(),
                orientation: [-1.0, 0.0, 0.0],
            },
            plus_surface: SurfaceRefIR {
                object_id: "strip".into(),
                surface_id: "x_max".into(),
                orientation: [1.0, 0.0, 0.0],
            },
            translation_m: [1.0, 0.0, 0.0],
        }];
        let periodic_error = resolve_spin_transport(&periodic, BackendTarget::Fdm, &context)
            .expect_err("native periodic spin boundary must fail");
        assert!(periodic_error
            .reasons
            .join(" ")
            .contains("does not support specified spin flux or periodic"));
    }

    #[test]
    fn specified_current_density_resolves_exact_external_faces_with_area_and_sign() {
        let boundaries = vec![ResolvedChargeBoundaryFaceIR {
            source_id: "drive-x-min".into(),
            face: StructuredBoundaryFaceIR::XMin,
            condition: ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity {
                current_density_apm2: -7.0,
            },
        }];
        let faces = resolve_specified_current_faces(
            &boundaries,
            &[true, true, true, true],
            [2, 2, 1],
            [2.0, 3.0, 5.0],
        )
        .expect("exact active x-min faces");
        assert_eq!(faces.len(), 2);
        assert_eq!(faces[0].axis, 0);
        assert_eq!(faces[0].face_index, 0);
        assert_eq!(faces[0].adjacent_cell, 0);
        assert_eq!(faces[1].face_index, 3);
        assert_eq!(faces[1].adjacent_cell, 2);
        assert_eq!(faces[0].outward_normal_sign, -1);
        assert_eq!(faces[0].area_m2, 15.0);
        assert_eq!(faces[0].outward_current_density_apm2, -7.0);

        let partial = resolve_specified_current_faces(
            &boundaries,
            &[true, true, false, true],
            [2, 2, 1],
            [2.0, 3.0, 5.0],
        )
        .expect_err("every selected external face must have an active adjacent cell");
        let reason = partial.join(" ");
        assert!(reason.contains("drive-x-min"));
        assert!(reason.contains("face index 3"));
        assert!(reason.contains("adjacent cell 2"));

        let empty =
            resolve_specified_current_faces(&boundaries, &[false; 4], [2, 2, 1], [2.0, 3.0, 5.0])
                .expect_err("empty current scope must fail closed at the first selected face");
        let reason = empty.join(" ");
        assert!(reason.contains("drive-x-min"));
        assert!(reason.contains("face index 0"));
        assert!(reason.contains("adjacent cell 0"));
    }
}
