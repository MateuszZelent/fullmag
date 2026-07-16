use fullmag_engine::fdm::cpu::transport::{
    biot_savart_midpoint_field, ChargeBoundaryCondition, ChargeBoundaryConditions,
    ChargeSolverConfig, OrientedSpinInterface, PotentialGauge, SpinBoundaryCondition,
    SpinBoundaryConditions, SpinDriftDiffusionProblem, SpinFluxOperator, SpinInterfaceLaw,
    SpinMaterialFields, SpinReactionLengths, SpinSolverConfig, SpinTorqueTargets,
    StructuredChargeProblem, StructuredSpinFace,
};
use fullmag_engine::{CellSize, GridShape};
use fullmag_ir::{
    ChargePotentialGaugeIR, FdmPlanIR, ResolvedChargeBoundaryConditionIR,
    ResolvedFdmSpinTransportIR, ResolvedSpinBoundaryConditionIR, ResolvedSpinInterfaceLawIR,
    StructuredBoundaryFaceIR,
};
use serde::Serialize;

use crate::types::RunError;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct FdmSpinTransportTelemetry {
    pub charge_iterations: usize,
    pub charge_residual_l2: f64,
    pub charge_net_boundary_current_a: f64,
    pub charge_max_abs_divergence_a_per_m3: f64,
    pub spin_iterations: usize,
    pub spin_initial_residual_l2: f64,
    pub spin_final_residual_l2: f64,
    pub spin_scaled_residual: f64,
    pub spin_relative_balance_closure: f64,
    pub convergence_reason: String,
    pub preconditioner: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct FdmSpinInterfaceFluxSnapshot {
    pub source_id: String,
    pub incoming_longitudinal_apm2: [f64; 3],
    pub backflow_longitudinal_apm2: [f64; 3],
    pub absorbed_transverse_apm2: [f64; 3],
    pub spin_memory_loss_apm2: [f64; 3],
    pub from_side_outgoing_apm2: [f64; 3],
    pub to_side_transmitted_apm2: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct FdmSpinTransportModuleSnapshot {
    pub module_id: String,
    pub current_source_id: String,
    pub potential_volts: Vec<f64>,
    pub current_density_apm2: Vec<[f64; 3]>,
    pub spin_potential_volts: Vec<[f64; 3]>,
    /// Row-major `Q_ia`, flow axis first and spin axis second.
    pub spin_current_tensor_apm2: Vec<[f64; 9]>,
    pub interface_fluxes: Vec<FdmSpinInterfaceFluxSnapshot>,
    pub transport_torque_per_s: Vec<[f64; 3]>,
    pub oersted_field_apm: Option<Vec<[f64; 3]>>,
    pub telemetry: FdmSpinTransportTelemetry,
    pub constitutive_version: String,
    pub charge_operator_version: String,
    pub spin_operator_version: String,
    pub torque_formula_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub(crate) struct FdmSpinTransportEvaluation {
    pub revision: u64,
    pub evaluated_time_s: f64,
    pub refresh_count: u64,
    pub modules: Vec<FdmSpinTransportModuleSnapshot>,
    pub combined_transport_torque_per_s: Vec<[f64; 3]>,
    pub combined_oersted_field_apm: Option<Vec<[f64; 3]>>,
}

#[derive(Debug, Clone)]
pub(crate) struct FdmSpinTransportWorkflow {
    grid: GridShape,
    cell_size: CellSize,
    plans: Vec<fullmag_ir::ResolvedSpinTransportPlanIR>,
    next_revision: u64,
    refresh_count: u64,
    accepted: Option<FdmSpinTransportEvaluation>,
}

impl FdmSpinTransportWorkflow {
    pub(crate) fn from_plan(plan: &FdmPlanIR) -> Result<Option<Self>, RunError> {
        if plan.spin_transport_plans.is_empty() {
            return Ok(None);
        }
        if plan.precision != fullmag_ir::ExecutionPrecision::Double {
            return Err(run_error(
                "spin transport runtime supports FDM CPU double only; precision fallback is forbidden",
            ));
        }
        let grid = GridShape::new(
            plan.grid.cells[0] as usize,
            plan.grid.cells[1] as usize,
            plan.grid.cells[2] as usize,
        )
        .map_err(engine_error("spin transport grid"))?;
        let cell_size = CellSize::new(plan.cell_size[0], plan.cell_size[1], plan.cell_size[2])
            .map_err(engine_error("spin transport cell size"))?;
        for resolved in &plan.spin_transport_plans {
            if resolved.resolved_discretization != fullmag_ir::BackendTarget::Fdm
                || resolved.resolved_device != fullmag_ir::ExecutionDevice::Cpu
                || resolved.resolved_precision != fullmag_ir::ExecutionPrecision::Double
            {
                return Err(run_error(format!(
                    "spin transport '{}' resolved to an unsupported lane; runtime fallback is forbidden",
                    resolved.module_id
                )));
            }
            let descriptor = resolved.fdm_cpu_double.as_ref().ok_or_else(|| {
                run_error(format!(
                    "spin transport '{}' has no materialized FDM CPU-double descriptor",
                    resolved.module_id
                ))
            })?;
            validate_descriptor(descriptor, grid.cell_count(), &resolved.module_id)?;
        }
        Ok(Some(Self {
            grid,
            cell_size,
            plans: plan.spin_transport_plans.clone(),
            next_revision: 1,
            refresh_count: 0,
            accepted: None,
        }))
    }

    pub(crate) fn evaluate_stage(
        &mut self,
        magnetization: &[[f64; 3]],
        stage_time_s: f64,
    ) -> Result<FdmSpinTransportEvaluation, RunError> {
        if magnetization.len() != self.grid.cell_count()
            || magnetization
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
        {
            return Err(run_error(
                "spin transport stage magnetization must be finite and match the FDM grid",
            ));
        }
        if !stage_time_s.is_finite() || stage_time_s < 0.0 {
            return Err(run_error(
                "spin transport stage time must be finite and non-negative",
            ));
        }
        let mut modules = Vec::with_capacity(self.plans.len());
        let mut combined_torque = vec![[0.0; 3]; self.grid.cell_count()];
        let mut combined_oersted: Option<Vec<[f64; 3]>> = None;
        for resolved in &self.plans {
            let descriptor = resolved
                .fdm_cpu_double
                .as_ref()
                .expect("descriptor was validated during workflow construction");
            let module = solve_module(
                self.grid,
                self.cell_size,
                resolved,
                descriptor,
                magnetization,
            )?;
            add_vector_field(&mut combined_torque, &module.transport_torque_per_s);
            if let Some(field) = &module.oersted_field_apm {
                let aggregate =
                    combined_oersted.get_or_insert_with(|| vec![[0.0; 3]; self.grid.cell_count()]);
                add_vector_field(aggregate, field);
            }
            modules.push(module);
        }
        let evaluation = FdmSpinTransportEvaluation {
            revision: self.next_revision,
            evaluated_time_s: stage_time_s,
            refresh_count: self.refresh_count + 1,
            modules,
            combined_transport_torque_per_s: combined_torque,
            combined_oersted_field_apm: combined_oersted,
        };
        self.next_revision = self.next_revision.saturating_add(1);
        self.refresh_count = self.refresh_count.saturating_add(1);
        Ok(evaluation)
    }

    pub(crate) fn commit(
        &mut self,
        evaluation: FdmSpinTransportEvaluation,
    ) -> Result<(), RunError> {
        if evaluation.revision == 0 || evaluation.revision >= self.next_revision {
            return Err(run_error(
                "cannot commit a spin transport evaluation that was not produced by this workflow",
            ));
        }
        if self
            .accepted
            .as_ref()
            .is_some_and(|accepted| accepted.revision >= evaluation.revision)
        {
            return Err(run_error(
                "spin transport accepted revisions must be strictly increasing",
            ));
        }
        self.accepted = Some(evaluation);
        Ok(())
    }

    /// Discard uncommitted stage evaluations. Accepted state is immutable
    /// until a newer evaluation is explicitly committed.
    pub(crate) fn rollback(&mut self) {}

    pub(crate) fn accepted(&self) -> Option<&FdmSpinTransportEvaluation> {
        self.accepted.as_ref()
    }
}

fn validate_descriptor(
    descriptor: &ResolvedFdmSpinTransportIR,
    count: usize,
    module_id: &str,
) -> Result<(), RunError> {
    if descriptor.descriptor_schema != "fullmag.fdm.spin_transport_descriptor.v1" {
        return Err(run_error(format!(
            "spin transport '{module_id}' uses incompatible descriptor schema '{}'",
            descriptor.descriptor_schema
        )));
    }
    let lengths = [
        descriptor.charge_active_cells.len(),
        descriptor.charge_conductivity_spm.len(),
        descriptor.spin_active_cells.len(),
        descriptor.spin_conductivity_spm.len(),
        descriptor.polarization_p.len(),
        descriptor.theta_sh.len(),
        descriptor.reactions.len(),
        descriptor.region_ids.len(),
        descriptor.torque_target_cells.len(),
        descriptor.saturation_magnetization_apm.len(),
    ];
    if lengths.iter().any(|length| *length != count) {
        return Err(run_error(format!(
            "spin transport '{module_id}' descriptor fields do not match the FDM grid"
        )));
    }
    if descriptor.charge_boundaries.len() != 6 || descriptor.spin_boundaries.len() != 6 {
        return Err(run_error(format!(
            "spin transport '{module_id}' descriptor must resolve all six charge and spin boundary faces"
        )));
    }
    Ok(())
}

fn solve_module(
    grid: GridShape,
    cell_size: CellSize,
    resolved: &fullmag_ir::ResolvedSpinTransportPlanIR,
    descriptor: &ResolvedFdmSpinTransportIR,
    magnetization: &[[f64; 3]],
) -> Result<FdmSpinTransportModuleSnapshot, RunError> {
    let charge_boundary = charge_boundary_conditions(&descriptor.charge_boundaries)?;
    let charge_problem = StructuredChargeProblem::new(
        grid,
        cell_size,
        descriptor.charge_conductivity_spm.clone(),
        Some(descriptor.charge_active_cells.clone()),
        charge_boundary,
    )
    .map_err(engine_error("charge problem materialization"))?;
    let charge_solution = charge_problem
        .solve(ChargeSolverConfig {
            relative_tolerance: descriptor.charge_solver.linear.relative_tolerance,
            absolute_tolerance: descriptor.charge_solver.linear.absolute_tolerance,
            max_iterations: descriptor.charge_solver.linear.max_iterations as usize,
            gauge: match descriptor.charge_gauge {
                ChargePotentialGaugeIR::DirichletReference => None,
                ChargePotentialGaugeIR::ZeroMean => Some(PotentialGauge::ZeroMean),
            },
        })
        .map_err(engine_error("charge solve"))?;
    let current_density_apm2 = charge_problem
        .cell_centered_current_density(&charge_solution.current_density)
        .map_err(engine_error("charge current reconstruction"))?;

    let materials = SpinMaterialFields {
        spin_conductivity_s_per_m: descriptor.spin_conductivity_spm.clone(),
        polarization: descriptor.polarization_p.clone(),
        spin_hall_angle: descriptor.theta_sh.clone(),
        magnetization: magnetization.to_vec(),
        reactions: descriptor
            .reactions
            .iter()
            .map(|reaction| SpinReactionLengths {
                spin_flip_m: reaction.spin_flip_m,
                exchange_m: reaction.exchange_m,
                dephasing_m: reaction.dephasing_m,
            })
            .collect(),
    };
    let mut spin_problem = SpinDriftDiffusionProblem::new(
        charge_problem.clone(),
        charge_solution.potential_volts.clone(),
        materials,
        Some(descriptor.spin_active_cells.clone()),
        spin_boundary_conditions(&descriptor.spin_boundaries)?,
    )
    .map_err(engine_error("spin problem materialization"))?
    .with_flux_operator(match descriptor.spin_solver.operator_version.as_str() {
        "fv_spin_upwind_v1" => SpinFluxOperator::FvSpinUpwindV1,
        "fv_spin_central_reference_v1" => SpinFluxOperator::FvSpinCentralReferenceV1,
        other => {
            return Err(run_error(format!(
                "unsupported spin operator version '{other}' reached runtime"
            )))
        }
    });
    if descriptor.torque_target_cells.iter().any(|target| *target) {
        spin_problem = spin_problem
            .with_torque_targets(SpinTorqueTargets {
                target_cells: descriptor.torque_target_cells.clone(),
                saturation_magnetization_a_per_m: descriptor.saturation_magnetization_apm.clone(),
                gamma_e_rad_per_s_t: descriptor.gamma_e_rad_per_s_t,
            })
            .map_err(engine_error("spin torque targets"))?;
    }
    if !descriptor.interfaces.is_empty() {
        let interfaces = descriptor
            .interfaces
            .iter()
            .map(|interface| {
                let face = StructuredSpinFace {
                    axis: interface.face.axis as usize,
                    negative_cell: interface.face.negative_cell as usize,
                    positive_cell: interface.face.positive_cell as usize,
                };
                let law = match &interface.law {
                    ResolvedSpinInterfaceLawIR::Transparent => SpinInterfaceLaw::Transparent,
                    ResolvedSpinInterfaceLawIR::MixingConductance {
                        g_up_spm2,
                        g_down_spm2,
                        g_r_spm2,
                        g_i_spm2,
                        g_sml_spm2,
                        ..
                    } => SpinInterfaceLaw::MixingConductance {
                        g_up_s_per_m2: *g_up_spm2,
                        g_down_s_per_m2: *g_down_spm2,
                        g_r_s_per_m2: *g_r_spm2,
                        g_i_s_per_m2: *g_i_spm2,
                        g_sml_s_per_m2: *g_sml_spm2,
                        magnetization: magnetization[interface.to_cell as usize],
                    },
                };
                OrientedSpinInterface {
                    face,
                    from_cell: interface.from_cell as usize,
                    to_cell: interface.to_cell as usize,
                    law,
                }
            })
            .collect();
        spin_problem = spin_problem
            .with_interfaces(descriptor.region_ids.clone(), interfaces)
            .map_err(engine_error("spin interfaces"))?;
    }
    if !matches!(descriptor.spin_solver.engine.as_str(), "auto" | "gmres") {
        return Err(run_error(format!(
            "unsupported spin solver engine '{}' reached runtime",
            descriptor.spin_solver.engine
        )));
    }
    let spin_solution = spin_problem
        .solve(SpinSolverConfig {
            relative_tolerance: descriptor.spin_solver.linear.relative_tolerance,
            absolute_tolerance: descriptor.spin_solver.linear.absolute_tolerance,
            max_iterations: descriptor.spin_solver.linear.max_iterations as usize,
            restart: 40,
        })
        .map_err(engine_error("steady spin solve"))?;
    let tensors = spin_problem
        .cell_centered_spin_current_tensor(&spin_solution.spin_current_density)
        .map_err(engine_error("spin-current tensor reconstruction"))?
        .into_iter()
        .map(|tensor| {
            [
                tensor[0][0],
                tensor[0][1],
                tensor[0][2],
                tensor[1][0],
                tensor[1][1],
                tensor[1][2],
                tensor[2][0],
                tensor[2][1],
                tensor[2][2],
            ]
        })
        .collect();
    let interface_fluxes = spin_solution
        .spin_current_density
        .interface_observations
        .iter()
        .map(|observation| {
            let source_id = descriptor
                .interfaces
                .iter()
                .find(|interface| {
                    interface.face.axis as usize == observation.face.axis
                        && interface.face.negative_cell as usize == observation.face.negative_cell
                        && interface.face.positive_cell as usize == observation.face.positive_cell
                })
                .map(|interface| interface.source_id.clone())
                .unwrap_or_else(|| "unresolved-interface".to_string());
            FdmSpinInterfaceFluxSnapshot {
                source_id,
                incoming_longitudinal_apm2: observation.incoming_longitudinal_a_per_m2,
                backflow_longitudinal_apm2: observation.backflow_longitudinal_a_per_m2,
                absorbed_transverse_apm2: observation.absorbed_transverse_a_per_m2,
                spin_memory_loss_apm2: observation.spin_memory_loss_a_per_m2,
                from_side_outgoing_apm2: observation.from_side_outgoing_a_per_m2,
                to_side_transmitted_apm2: observation.to_side_transmitted_a_per_m2,
            }
        })
        .collect();
    let oersted_field_apm = descriptor
        .oersted_source_bound
        .then(|| {
            biot_savart_midpoint_field(
                grid,
                cell_size,
                &descriptor.charge_active_cells,
                &current_density_apm2,
            )
            .map_err(engine_error("direct midpoint Oersted solve"))
        })
        .transpose()?;
    Ok(FdmSpinTransportModuleSnapshot {
        module_id: resolved.module_id.clone(),
        current_source_id: resolved.current_source_id.clone(),
        potential_volts: charge_solution.potential_volts,
        current_density_apm2,
        spin_potential_volts: spin_solution.spin_potential_volts,
        spin_current_tensor_apm2: tensors,
        interface_fluxes,
        transport_torque_per_s: spin_solution.transport_gilbert_torque_per_s,
        oersted_field_apm,
        telemetry: FdmSpinTransportTelemetry {
            charge_iterations: charge_solution.iterations,
            charge_residual_l2: charge_solution.residual_l2,
            charge_net_boundary_current_a: charge_solution.balance.net_boundary_current_a,
            charge_max_abs_divergence_a_per_m3: charge_solution.balance.max_abs_divergence_a_per_m3,
            spin_iterations: spin_solution.iterations,
            spin_initial_residual_l2: spin_solution.telemetry.initial_residual_l2,
            spin_final_residual_l2: spin_solution.telemetry.final_residual_l2,
            spin_scaled_residual: spin_solution.telemetry.scaled_residual,
            spin_relative_balance_closure: spin_solution.telemetry.relative_balance_closure,
            convergence_reason: spin_solution.telemetry.convergence_reason.to_string(),
            preconditioner: spin_solution.telemetry.preconditioner.to_string(),
        },
        constitutive_version: resolved.constitutive_version.clone(),
        charge_operator_version: descriptor.charge_solver.operator_version.clone(),
        spin_operator_version: descriptor.spin_solver.operator_version.clone(),
        torque_formula_version: descriptor.torque_formula_version.clone(),
    })
}

fn charge_boundary_conditions(
    boundaries: &[fullmag_ir::ResolvedChargeBoundaryFaceIR],
) -> Result<ChargeBoundaryConditions, RunError> {
    let mut result = ChargeBoundaryConditions::default();
    for boundary in boundaries {
        let condition = match boundary.condition {
            ResolvedChargeBoundaryConditionIR::Voltage { potential_v } => {
                ChargeBoundaryCondition::Voltage(potential_v)
            }
            ResolvedChargeBoundaryConditionIR::OutwardNormalCurrentDensity {
                current_density_apm2,
            } => ChargeBoundaryCondition::SpecifiedOutwardCurrentDensity(current_density_apm2),
            ResolvedChargeBoundaryConditionIR::Insulating => ChargeBoundaryCondition::Insulating,
        };
        set_charge_face(&mut result, boundary.face, condition);
    }
    Ok(result)
}

fn set_charge_face(
    boundary: &mut ChargeBoundaryConditions,
    face: StructuredBoundaryFaceIR,
    condition: ChargeBoundaryCondition,
) {
    match face {
        StructuredBoundaryFaceIR::XMin => boundary.x_min = condition,
        StructuredBoundaryFaceIR::XMax => boundary.x_max = condition,
        StructuredBoundaryFaceIR::YMin => boundary.y_min = condition,
        StructuredBoundaryFaceIR::YMax => boundary.y_max = condition,
        StructuredBoundaryFaceIR::ZMin => boundary.z_min = condition,
        StructuredBoundaryFaceIR::ZMax => boundary.z_max = condition,
    }
}

fn spin_boundary_conditions(
    boundaries: &[fullmag_ir::ResolvedSpinBoundaryFaceIR],
) -> Result<SpinBoundaryConditions, RunError> {
    let mut result = SpinBoundaryConditions::default();
    for boundary in boundaries {
        let condition = match boundary.condition {
            ResolvedSpinBoundaryConditionIR::SpinInsulating => {
                SpinBoundaryCondition::SpinInsulating
            }
            ResolvedSpinBoundaryConditionIR::SpinSink => SpinBoundaryCondition::SpinSink,
            ResolvedSpinBoundaryConditionIR::SpecifiedPotential { value_v } => {
                SpinBoundaryCondition::SpecifiedPotential(value_v)
            }
            ResolvedSpinBoundaryConditionIR::SpecifiedOutwardFlux { value_apm2 } => {
                SpinBoundaryCondition::SpecifiedFlux(value_apm2)
            }
            ResolvedSpinBoundaryConditionIR::PeriodicSpin => SpinBoundaryCondition::PeriodicSpin,
        };
        match boundary.face {
            StructuredBoundaryFaceIR::XMin => result.x_min = condition,
            StructuredBoundaryFaceIR::XMax => result.x_max = condition,
            StructuredBoundaryFaceIR::YMin => result.y_min = condition,
            StructuredBoundaryFaceIR::YMax => result.y_max = condition,
            StructuredBoundaryFaceIR::ZMin => result.z_min = condition,
            StructuredBoundaryFaceIR::ZMax => result.z_max = condition,
        }
    }
    Ok(result)
}

fn add_vector_field(target: &mut [[f64; 3]], values: &[[f64; 3]]) {
    for (target, value) in target.iter_mut().zip(values) {
        for component in 0..3 {
            target[component] += value[component];
        }
    }
}

fn run_error(message: impl Into<String>) -> RunError {
    RunError {
        message: message.into(),
    }
}

fn engine_error(context: &'static str) -> impl FnOnce(fullmag_engine::EngineError) -> RunError {
    move |error| run_error(format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::*;

    fn boundary_face(
        face: StructuredBoundaryFaceIR,
        condition: ResolvedChargeBoundaryConditionIR,
    ) -> ResolvedChargeBoundaryFaceIR {
        ResolvedChargeBoundaryFaceIR {
            source_id: format!("{face:?}"),
            face,
            condition,
        }
    }

    fn spin_boundary_face(
        face: StructuredBoundaryFaceIR,
        condition: ResolvedSpinBoundaryConditionIR,
    ) -> ResolvedSpinBoundaryFaceIR {
        ResolvedSpinBoundaryFaceIR {
            source_id: format!("{face:?}"),
            face,
            condition,
        }
    }

    fn plan() -> FdmPlanIR {
        let cells = 4;
        let descriptor = ResolvedFdmSpinTransportIR {
            descriptor_schema: "fullmag.fdm.spin_transport_descriptor.v1".into(),
            charge_active_cells: vec![true; cells],
            charge_conductivity_spm: vec![2.0; cells],
            charge_boundaries: vec![
                boundary_face(
                    StructuredBoundaryFaceIR::XMin,
                    ResolvedChargeBoundaryConditionIR::Voltage { potential_v: 0.0 },
                ),
                boundary_face(
                    StructuredBoundaryFaceIR::XMax,
                    ResolvedChargeBoundaryConditionIR::Voltage { potential_v: 1.0 },
                ),
                boundary_face(
                    StructuredBoundaryFaceIR::YMin,
                    ResolvedChargeBoundaryConditionIR::Insulating,
                ),
                boundary_face(
                    StructuredBoundaryFaceIR::YMax,
                    ResolvedChargeBoundaryConditionIR::Insulating,
                ),
                boundary_face(
                    StructuredBoundaryFaceIR::ZMin,
                    ResolvedChargeBoundaryConditionIR::Insulating,
                ),
                boundary_face(
                    StructuredBoundaryFaceIR::ZMax,
                    ResolvedChargeBoundaryConditionIR::Insulating,
                ),
            ],
            charge_gauge: ChargePotentialGaugeIR::DirichletReference,
            charge_solver: ChargeSolverPolicyIR {
                engine: "cg".into(),
                linear: LinearTransportSolverPolicyIR {
                    relative_tolerance: 1e-12,
                    absolute_tolerance: 1e-14,
                    max_iterations: 1000,
                },
                physical_residual_version: "charge_balance_integrated_l2.v1".into(),
                operator_version: "fv_charge_harmonic_v1".into(),
            },
            spin_active_cells: vec![true; cells],
            spin_conductivity_spm: vec![4.0; cells],
            polarization_p: vec![0.0; cells],
            theta_sh: vec![0.0; cells],
            reactions: vec![
                ResolvedSpinReactionLengthsIR {
                    spin_flip_m: None,
                    exchange_m: None,
                    dephasing_m: None
                };
                cells
            ],
            region_ids: vec![0; cells],
            spin_boundaries: vec![
                spin_boundary_face(
                    StructuredBoundaryFaceIR::XMin,
                    ResolvedSpinBoundaryConditionIR::SpecifiedPotential {
                        value_v: [0.0, 0.0, 0.0],
                    },
                ),
                spin_boundary_face(
                    StructuredBoundaryFaceIR::XMax,
                    ResolvedSpinBoundaryConditionIR::SpecifiedPotential {
                        value_v: [1.0, 0.0, 0.0],
                    },
                ),
                spin_boundary_face(
                    StructuredBoundaryFaceIR::YMin,
                    ResolvedSpinBoundaryConditionIR::SpinInsulating,
                ),
                spin_boundary_face(
                    StructuredBoundaryFaceIR::YMax,
                    ResolvedSpinBoundaryConditionIR::SpinInsulating,
                ),
                spin_boundary_face(
                    StructuredBoundaryFaceIR::ZMin,
                    ResolvedSpinBoundaryConditionIR::SpinInsulating,
                ),
                spin_boundary_face(
                    StructuredBoundaryFaceIR::ZMax,
                    ResolvedSpinBoundaryConditionIR::SpinInsulating,
                ),
            ],
            interfaces: vec![],
            torque_target_cells: vec![false; cells],
            saturation_magnetization_apm: vec![8e5; cells],
            gamma_e_rad_per_s_t: 1.760_859e11,
            spin_solver: SpinSolverPolicyIR {
                engine: "gmres".into(),
                linear: LinearTransportSolverPolicyIR {
                    relative_tolerance: 1e-10,
                    absolute_tolerance: 1e-14,
                    max_iterations: 1000,
                },
                physical_residual_version: "transport_balance_integrated_l2.v1".into(),
                operator_version: "fv_spin_upwind_v1".into(),
                default_external_boundary: "spin_insulating".into(),
            },
            torque_formula_version: None,
            oersted_source_bound: false,
        };
        FdmPlanIR {
            grid: GridDimensions {
                cells: [cells as u32, 1, 1],
            },
            cell_size: [1.0, 1.0, 1.0],
            active_mask: Some(vec![true; cells]),
            initial_magnetization: vec![[0.0, 0.0, 1.0]; cells],
            spin_transport_plans: vec![ResolvedSpinTransportPlanIR {
                module_id: "spin".into(),
                current_source_id: "charge".into(),
                resolved_coupling: TransportCouplingIR::OneWay,
                requested_execution: RequestedTransportExecutionIR {
                    discretization: BackendTarget::Fdm,
                    device: ExecutionDevice::Cpu,
                    precision: ExecutionPrecision::Double,
                    execution_mode: ExecutionMode::Strict,
                },
                resolved_discretization: BackendTarget::Fdm,
                resolved_device: ExecutionDevice::Cpu,
                resolved_precision: ExecutionPrecision::Double,
                constitutive_version: "transport_constitutive.one_way.fullmag.v1".into(),
                operator_version: "fv_spin_upwind_v1".into(),
                physical_residual_version: "transport_balance_integrated_l2.v1".into(),
                capabilities: vec!["transport.spin.steady_drift_diffusion".into()],
                inserted_default_boundaries: vec![],
                fdm_cpu_double: Some(descriptor),
            }],
            ..FdmPlanIR::default()
        }
    }

    #[test]
    fn analytical_one_way_bar_materializes_charge_and_spin_quantities() {
        let plan = plan();
        let mut workflow = FdmSpinTransportWorkflow::from_plan(&plan)
            .expect("workflow construction")
            .expect("spin workflow");
        let evaluation = workflow
            .evaluate_stage(&plan.initial_magnetization, 2.5e-12)
            .expect("stage solve");
        assert_eq!(evaluation.revision, 1);
        assert_eq!(evaluation.evaluated_time_s, 2.5e-12);
        let module = &evaluation.modules[0];
        for (cell, potential) in module.potential_volts.iter().enumerate() {
            assert!((*potential - (cell as f64 + 0.5) / 4.0).abs() < 1e-10);
        }
        for current in &module.current_density_apm2 {
            assert!((current[0] + 0.5).abs() < 1e-10);
        }
        for (cell, spin) in module.spin_potential_volts.iter().enumerate() {
            assert!((spin[0] - (cell as f64 + 0.5) / 4.0).abs() < 1e-8);
        }
        assert_eq!(module.spin_current_tensor_apm2.len(), 4);
        assert!(module
            .transport_torque_per_s
            .iter()
            .all(|value| *value == [0.0; 3]));
        workflow.commit(evaluation.clone()).expect("commit");
        assert_eq!(workflow.accepted().unwrap().revision, 1);
        workflow.rollback();
        assert_eq!(workflow.accepted().unwrap().revision, 1);
    }

    #[test]
    fn reference_runner_commits_three_stage_transport_and_persists_artifact() {
        let mut plan = plan();
        plan.fixed_timestep = Some(1e-15);
        plan.integrator = Some(IntegratorChoice::Heun);
        plan.gyromagnetic_ratio = 2.211e5;
        plan.material = FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 8e5,
            exchange_stiffness: 13e-12,
            damping: 0.02,
            ..Default::default()
        };
        plan.enable_exchange = false;
        plan.enable_demag = false;

        let executed =
            super::super::reference::execute_reference_fdm(&plan, 1e-15, &[], None, None)
                .expect("coupled reference run");

        assert_eq!(executed.result.status, crate::types::RunStatus::Completed);
        let artifact = executed
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "transport/spin_transport_accepted.json")
            .expect("accepted transport artifact");
        let document: serde_json::Value =
            serde_json::from_slice(&artifact.bytes).expect("transport artifact JSON");
        assert_eq!(document["schema"], "fullmag.fdm.spin_transport.accepted.v1");
        assert_eq!(document["evaluation"]["revision"], 3);
        assert_eq!(document["evaluation"]["refresh_count"], 3);
        assert_eq!(
            document["evaluation"]["modules"][0]["spin_current_tensor_apm2"]
                .as_array()
                .expect("spin-current tensor array")
                .len(),
            4
        );
    }
}
