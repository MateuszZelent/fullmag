use std::collections::BTreeMap;

use fullmag_engine::fdm::cpu::transport::{
    biot_savart_midpoint_field, ChargeBoundaryCondition, ChargeBoundaryConditions, ChargeSolution,
    ChargeSolverConfig, CoupledChargeSpinBoundaryConditions, CoupledChargeSpinMaterialFields,
    CoupledChargeSpinProblem, CoupledChargeSpinSolverConfig, CoupledChargeSpinWarmStart,
    CoupledTransportOuterErrorBudget, OrientedSpinInterface, PotentialGauge,
    ReciprocalConstitutiveMaterial, SpinBoundaryCondition, SpinBoundaryConditions,
    SpinDriftDiffusionProblem, SpinFluxOperator, SpinInterfaceLaw, SpinMaterialFields,
    SpinReactionLengths, SpinSolverConfig, SpinTorqueTargets, StructuredChargeProblem,
    StructuredSpinFace, TransientSpinIntegrator, TransientSpinMaterial, TransientSpinSolverConfig,
    TransientSpinState,
};
use fullmag_engine::fdm::TransportStageErrorBudget;
use fullmag_engine::{CellSize, GridShape};
use fullmag_ir::{
    ChargePotentialGaugeIR, FdmPlanIR, ResolvedChargeBoundaryConditionIR,
    ResolvedFdmCoupledSpinTransportIR, ResolvedFdmSpinTransportIR,
    ResolvedFdmTransientSpinTransportIR, ResolvedSpinBoundaryConditionIR,
    ResolvedSpinInterfaceLawIR, StructuredBoundaryFaceIR,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nonlinear_iterations: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coupled_linear_iterations: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preconditioner_applications: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scaled_charge_residual: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_charge_current_update: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relative_spin_potential_update: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport_outer_error_ratio: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charge_balance_relative: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spin_balance_relative: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warm_start_used: Option<bool>,
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
    pub state_revision: u64,
    pub operator_revision: u64,
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
    attempt_checkpoint: Option<(u64, u64)>,
    transient_states: BTreeMap<String, TransientSpinState>,
    transient_attempt_origin: Option<BTreeMap<String, TransientSpinState>>,
    transient_candidates: BTreeMap<String, TransientSpinState>,
    accepted_steps: u64,
    rejected_steps: u64,
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
        let mut transient_states = BTreeMap::new();
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
            if let Some(descriptor) = resolved.fdm_cpu_double_transient.as_ref() {
                validate_transient_descriptor(descriptor, grid.cell_count(), &resolved.module_id)?;
                transient_states.insert(
                    resolved.module_id.clone(),
                    TransientSpinState {
                        spin_potential_v: vec![[0.0; 3]; grid.cell_count()],
                        previous_spin_potential_v: None,
                        time_s: 0.0,
                        previous_dt_s: None,
                        state_revision: 0,
                    },
                );
                continue;
            }
            match (
                resolved.fdm_cpu_double.as_ref(),
                resolved.fdm_cpu_double_reciprocal.as_ref(),
            ) {
                (Some(descriptor), None) => {
                    validate_descriptor(descriptor, grid.cell_count(), &resolved.module_id)?
                }
                (None, Some(descriptor)) => {
                    validate_coupled_descriptor(descriptor, grid.cell_count(), &resolved.module_id)?
                }
                _ => {
                    return Err(run_error(format!(
                        "spin transport '{}' must carry exactly one FDM CPU-double descriptor",
                        resolved.module_id
                    )))
                }
            }
        }
        Ok(Some(Self {
            grid,
            cell_size,
            plans: plan.spin_transport_plans.clone(),
            next_revision: 1,
            refresh_count: 0,
            accepted: None,
            attempt_checkpoint: None,
            transient_states,
            transient_attempt_origin: None,
            transient_candidates: BTreeMap::new(),
            accepted_steps: 0,
            rejected_steps: 0,
        }))
    }

    pub(crate) fn begin_attempt(&mut self) -> Result<(), RunError> {
        if self.attempt_checkpoint.is_some() {
            return Err(run_error("spin transport step attempt is already active"));
        }
        self.attempt_checkpoint = Some((self.next_revision, self.refresh_count));
        self.transient_attempt_origin = Some(self.transient_states.clone());
        self.transient_candidates.clear();
        Ok(())
    }

    pub(crate) fn has_transient(&self) -> bool {
        self.plans
            .iter()
            .any(|resolved| resolved.fdm_cpu_double_transient.is_some())
    }

    #[cfg(test)]
    pub(crate) fn evaluate_stage(
        &mut self,
        magnetization: &[[f64; 3]],
        stage_time_s: f64,
    ) -> Result<FdmSpinTransportEvaluation, RunError> {
        self.evaluate_stage_with_lte(magnetization, stage_time_s, None, None)
    }

    pub(crate) fn evaluate_stage_with_lte(
        &mut self,
        magnetization: &[[f64; 3]],
        stage_time_s: f64,
        stage_error_budget: Option<TransportStageErrorBudget>,
        previous_stage: Option<&FdmSpinTransportEvaluation>,
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
            let module = if let Some(descriptor) = resolved.fdm_cpu_double_transient.as_ref() {
                let origin = self
                    .transient_attempt_origin
                    .as_ref()
                    .and_then(|states| states.get(&resolved.module_id))
                    .ok_or_else(|| {
                        run_error("transient stage evaluation requires an active transaction")
                    })?;
                let (snapshot, candidate) = solve_transient_module(
                    self.grid,
                    self.cell_size,
                    resolved,
                    descriptor,
                    magnetization,
                    origin,
                    stage_time_s,
                )?;
                self.transient_candidates
                    .insert(resolved.module_id.clone(), candidate);
                snapshot
            } else if let Some(descriptor) = resolved.fdm_cpu_double.as_ref() {
                solve_module(
                    self.grid,
                    self.cell_size,
                    resolved,
                    descriptor,
                    magnetization,
                )?
            } else {
                let descriptor = resolved
                    .fdm_cpu_double_reciprocal
                    .as_ref()
                    .expect("exactly one descriptor was validated during workflow construction");
                let accepted = self.accepted.as_ref().and_then(|evaluation| {
                    evaluation
                        .modules
                        .iter()
                        .find(|module| module.module_id == resolved.module_id)
                });
                let previous_module = previous_stage.and_then(|evaluation| {
                    evaluation
                        .modules
                        .iter()
                        .find(|module| module.module_id == resolved.module_id)
                });
                solve_coupled_module(
                    self.grid,
                    self.cell_size,
                    resolved,
                    descriptor,
                    magnetization,
                    accepted,
                    stage_error_budget,
                    previous_module,
                )?
            };
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
        for (module_id, state) in std::mem::take(&mut self.transient_candidates) {
            self.transient_states.insert(module_id, state);
        }
        self.transient_attempt_origin = None;
        self.attempt_checkpoint = None;
        self.accepted_steps = self.accepted_steps.saturating_add(1);
        Ok(())
    }

    /// Discard uncommitted stage evaluations. Accepted state is immutable
    /// until a newer evaluation is explicitly committed.
    pub(crate) fn rollback(&mut self) {
        if let Some((next_revision, refresh_count)) = self.attempt_checkpoint.take() {
            self.next_revision = next_revision;
            self.refresh_count = refresh_count;
        }
        self.transient_attempt_origin = None;
        self.transient_candidates.clear();
    }

    pub(crate) fn accepted(&self) -> Option<&FdmSpinTransportEvaluation> {
        self.accepted.as_ref()
    }

    pub(crate) fn accepted_steps(&self) -> u64 {
        self.accepted_steps
    }

    pub(crate) fn rejected_steps(&self) -> u64 {
        self.rejected_steps
    }

    pub(crate) fn set_step_counters(&mut self, accepted_steps: u64, rejected_steps: u64) {
        self.accepted_steps = accepted_steps;
        self.rejected_steps = rejected_steps;
    }

    pub(crate) fn normalized_transient_difference(
        &self,
        other: &Self,
        atol: f64,
        rtol: f64,
    ) -> Result<f64, RunError> {
        let left = self
            .accepted
            .as_ref()
            .ok_or_else(|| run_error("full transient trial has no accepted state"))?;
        let right = other
            .accepted
            .as_ref()
            .ok_or_else(|| run_error("half-step transient trial has no accepted state"))?;
        let mut sum = 0.0;
        let mut count = 0usize;
        for left_module in &left.modules {
            let right_module = right
                .modules
                .iter()
                .find(|module| module.module_id == left_module.module_id)
                .ok_or_else(|| run_error("transient trial module identity mismatch"))?;
            for (full, half) in left_module
                .spin_potential_volts
                .iter()
                .flatten()
                .zip(right_module.spin_potential_volts.iter().flatten())
            {
                let scale = atol + rtol * full.abs().max(half.abs());
                sum += (((half - full) / 3.0) / scale).powi(2);
                count += 1;
            }
        }
        Ok((sum / count.max(1) as f64).sqrt())
    }
}

fn validate_transient_descriptor(
    descriptor: &ResolvedFdmTransientSpinTransportIR,
    count: usize,
    module_id: &str,
) -> Result<(), RunError> {
    if descriptor.descriptor_schema != "fullmag.fdm.transient_spin_transport_descriptor.v1"
        || descriptor.transient_formula_version != "transient_spin_balance.fullmag.v1"
        || descriptor.integrator != fullmag_ir::CoupledSpinIntegratorIR::CoupledImexArk2
        || descriptor.integrator_version != "coupled_imex_ark2.v1"
    {
        return Err(run_error(format!(
            "spin transport '{module_id}' carries an incompatible transient formula/integrator descriptor"
        )));
    }
    validate_descriptor(&descriptor.steady_operator, count, module_id)?;
    if descriptor.spin_capacitance_as_per_v_m3.len() != count
        || descriptor.capacitance_formula_versions.len() != count
    {
        return Err(run_error(format!(
            "spin transport '{module_id}' transient capacitance fields do not match the FDM grid"
        )));
    }
    for cell in 0..count {
        if descriptor.steady_operator.spin_active_cells[cell]
            && (!descriptor.spin_capacitance_as_per_v_m3[cell].is_finite()
                || descriptor.spin_capacitance_as_per_v_m3[cell] <= 0.0
                || descriptor.capacitance_formula_versions[cell]
                    .trim()
                    .is_empty())
        {
            return Err(run_error(format!(
                "spin transport '{module_id}' transient capacitance/formula is invalid at active cell {cell}"
            )));
        }
    }
    Ok(())
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

fn validate_coupled_descriptor(
    descriptor: &ResolvedFdmCoupledSpinTransportIR,
    count: usize,
    module_id: &str,
) -> Result<(), RunError> {
    if descriptor.descriptor_schema != "fullmag.fdm.coupled_spin_transport_descriptor.v1" {
        return Err(run_error(format!(
            "spin transport '{module_id}' uses incompatible coupled descriptor schema '{}'",
            descriptor.descriptor_schema
        )));
    }
    let lengths = [
        descriptor.active_cells.len(),
        descriptor.reciprocal_materials.len(),
        descriptor.reactions.len(),
        descriptor.region_ids.len(),
        descriptor.torque_target_cells.len(),
        descriptor.saturation_magnetization_apm.len(),
    ];
    if lengths.iter().any(|length| *length != count)
        || descriptor.charge_boundaries.len() != 6
        || descriptor.spin_boundaries.len() != 6
    {
        return Err(run_error(format!(
            "spin transport '{module_id}' coupled descriptor does not match the FDM grid"
        )));
    }
    if descriptor.constitutive_version != "transport_constitutive.reciprocal.fullmag.v1"
        || descriptor.operator_version != "fdm_coupled_charge_spin_fv_block_gmres.v1"
        || descriptor.physical_residual_version != "transport_balance_integrated_l2.v1"
    {
        return Err(run_error(format!(
            "spin transport '{module_id}' coupled descriptor carries unsupported formula versions"
        )));
    }
    Ok(())
}

fn solve_coupled_module(
    grid: GridShape,
    cell_size: CellSize,
    resolved: &fullmag_ir::ResolvedSpinTransportPlanIR,
    descriptor: &ResolvedFdmCoupledSpinTransportIR,
    magnetization: &[[f64; 3]],
    accepted: Option<&FdmSpinTransportModuleSnapshot>,
    stage_error_budget: Option<TransportStageErrorBudget>,
    previous_stage: Option<&FdmSpinTransportModuleSnapshot>,
) -> Result<FdmSpinTransportModuleSnapshot, RunError> {
    let state_revision = state_revision(magnetization);
    let operator_revision = descriptor_revision(descriptor)?;
    let materials = CoupledChargeSpinMaterialFields {
        reciprocal: descriptor
            .reciprocal_materials
            .iter()
            .map(|material| ReciprocalConstitutiveMaterial {
                sigma_s_per_m: material.sigma_spm,
                sigma_spin_s_per_m: material.sigma_spin_spm,
                sigma_parallel_s_per_m: material.sigma_parallel_spm,
                sigma_perpendicular_s_per_m: material.sigma_perpendicular_spm,
                sigma_ahe_s_per_m: material.sigma_ahe_spm,
                polarization: material.polarization_p,
                spin_hall_angle: material.theta_sh,
            })
            .collect(),
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
    let mut problem = CoupledChargeSpinProblem::new(
        grid,
        cell_size,
        materials,
        Some(descriptor.active_cells.clone()),
        CoupledChargeSpinBoundaryConditions {
            charge: charge_boundary_conditions(&descriptor.charge_boundaries)?,
            spin: spin_boundary_conditions(&descriptor.spin_boundaries)?,
        },
    )
    .map_err(engine_error("coupled charge-spin materialization"))?
    .with_revisions(state_revision, operator_revision);
    if descriptor.torque_target_cells.iter().any(|target| *target) {
        problem = problem
            .with_torque_targets(SpinTorqueTargets {
                target_cells: descriptor.torque_target_cells.clone(),
                saturation_magnetization_a_per_m: descriptor.saturation_magnetization_apm.clone(),
                gamma_e_rad_per_s_t: descriptor.gamma_e_rad_per_s_t,
            })
            .map_err(engine_error("coupled charge-spin torque targets"))?;
    }
    if !descriptor.interfaces.is_empty() {
        let interfaces = materialize_interfaces(&descriptor.interfaces, magnetization)?;
        problem = problem
            .with_interfaces(descriptor.region_ids.clone(), interfaces)
            .map_err(engine_error("coupled charge-spin interfaces"))?;
    }
    let warm_start = accepted
        .filter(|snapshot| {
            snapshot.state_revision == state_revision
                && snapshot.operator_revision == operator_revision
        })
        .map(|snapshot| CoupledChargeSpinWarmStart {
            state_revision,
            operator_revision,
            potential_volts: snapshot.potential_volts.clone(),
            spin_potential_volts: snapshot.spin_potential_volts.clone(),
        });
    let config = CoupledChargeSpinSolverConfig {
        relative_tolerance: descriptor.linear_solver.relative_tolerance,
        absolute_tolerance: descriptor.linear_solver.absolute_tolerance,
        max_linear_iterations: descriptor.linear_solver.max_iterations as usize,
        gmres_restart: descriptor.nonlinear_solver.gmres_restart as usize,
        max_picard_iterations: descriptor.nonlinear_solver.max_picard_iterations as usize,
        relative_update_tolerance: descriptor.nonlinear_solver.relative_update_tolerance,
    };
    let solution = match stage_error_budget {
        Some(budget) => {
            let previous = previous_stage.ok_or_else(|| {
                run_error("corrected M2 stage requires the preceding transport-stage torque")
            })?;
            problem.solve_with_outer_error_budget(
                config,
                warm_start.as_ref(),
                &CoupledTransportOuterErrorBudget {
                    dt_s: budget.dt_s,
                    embedded_lte_m: budget.embedded_lte_m,
                    eta_transport: descriptor.nonlinear_solver.eta_transport,
                    previous_transport_torque_per_s: previous.transport_torque_per_s.clone(),
                },
            )
        }
        None => problem.solve(config, warm_start.as_ref()),
    }
    .map_err(engine_error("coupled charge-spin solve"))?;
    let tensors = solution
        .cell_spin_current_density_a_per_m2
        .iter()
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
    let interface_fluxes = solution
        .interface_observations
        .iter()
        .map(|observation| interface_snapshot(observation, &descriptor.interfaces))
        .collect();
    let oersted_field_apm = descriptor
        .oersted_source_bound
        .then(|| {
            biot_savart_midpoint_field(
                grid,
                cell_size,
                &descriptor.active_cells,
                &solution.cell_charge_current_density_a_per_m2,
            )
            .map_err(engine_error("coupled midpoint Oersted solve"))
        })
        .transpose()?;
    Ok(FdmSpinTransportModuleSnapshot {
        module_id: resolved.module_id.clone(),
        current_source_id: resolved.current_source_id.clone(),
        potential_volts: solution.potential_volts,
        current_density_apm2: solution.cell_charge_current_density_a_per_m2,
        spin_potential_volts: solution.spin_potential_volts,
        spin_current_tensor_apm2: tensors,
        interface_fluxes,
        transport_torque_per_s: solution.transport_gilbert_torque_per_s,
        oersted_field_apm,
        telemetry: FdmSpinTransportTelemetry {
            charge_iterations: 0,
            charge_residual_l2: solution.telemetry.scaled_charge_residual,
            charge_net_boundary_current_a: 0.0,
            charge_max_abs_divergence_a_per_m3: 0.0,
            spin_iterations: solution.telemetry.linear_iterations,
            spin_initial_residual_l2: solution
                .telemetry
                .nonlinear_history
                .first()
                .map_or(0.0, |iteration| iteration.scaled_spin_residual),
            spin_final_residual_l2: solution.telemetry.scaled_spin_residual,
            spin_scaled_residual: solution.telemetry.scaled_spin_residual,
            spin_relative_balance_closure: solution.telemetry.spin_balance_relative,
            convergence_reason: solution.telemetry.convergence_reason.to_string(),
            preconditioner: solution.telemetry.preconditioner.to_string(),
            nonlinear_iterations: Some(solution.telemetry.picard_iterations),
            coupled_linear_iterations: Some(solution.telemetry.linear_iterations),
            preconditioner_applications: Some(solution.telemetry.preconditioner_applications),
            scaled_charge_residual: Some(solution.telemetry.scaled_charge_residual),
            relative_charge_current_update: Some(solution.telemetry.relative_charge_current_update),
            relative_spin_potential_update: Some(solution.telemetry.relative_spin_potential_update),
            transport_outer_error_ratio: solution.telemetry.transport_outer_error_ratio,
            charge_balance_relative: Some(solution.telemetry.charge_balance_relative),
            spin_balance_relative: Some(solution.telemetry.spin_balance_relative),
            warm_start_used: Some(solution.telemetry.warm_start_used),
        },
        constitutive_version: descriptor.constitutive_version.clone(),
        charge_operator_version: descriptor.operator_version.clone(),
        spin_operator_version: descriptor.operator_version.clone(),
        torque_formula_version: descriptor.torque_formula_version.clone(),
        state_revision,
        operator_revision,
    })
}

fn materialize_interfaces(
    interfaces: &[fullmag_ir::ResolvedSpinInterfaceFaceIR],
    magnetization: &[[f64; 3]],
) -> Result<Vec<OrientedSpinInterface>, RunError> {
    interfaces
        .iter()
        .map(|interface| {
            let to_cell = interface.to_cell as usize;
            let law = match &interface.law {
                ResolvedSpinInterfaceLawIR::Transparent => {
                    return Err(run_error(
                        "transparent M2 interfaces must be rejected by the planner",
                    ));
                }
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
                    magnetization: *magnetization.get(to_cell).ok_or_else(|| {
                        run_error("coupled interface target cell is outside the FDM grid")
                    })?,
                },
            };
            Ok(OrientedSpinInterface {
                face: StructuredSpinFace {
                    axis: interface.face.axis as usize,
                    negative_cell: interface.face.negative_cell as usize,
                    positive_cell: interface.face.positive_cell as usize,
                },
                from_cell: interface.from_cell as usize,
                to_cell,
                law,
            })
        })
        .collect()
}

fn interface_snapshot(
    observation: &fullmag_engine::fdm::cpu::transport::SpinInterfaceFluxObservation,
    interfaces: &[fullmag_ir::ResolvedSpinInterfaceFaceIR],
) -> FdmSpinInterfaceFluxSnapshot {
    let source_id = interfaces
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
}

fn descriptor_revision(descriptor: &ResolvedFdmCoupledSpinTransportIR) -> Result<u64, RunError> {
    let bytes = serde_json::to_vec(descriptor)
        .map_err(|error| run_error(format!("cannot fingerprint M2 descriptor: {error}")))?;
    Ok(fnv1a(bytes.iter().copied()))
}

fn state_revision(magnetization: &[[f64; 3]]) -> u64 {
    fn bytes(values: &[[f64; 3]]) -> impl Iterator<Item = u8> + '_ {
        values
            .iter()
            .flatten()
            .flat_map(|value| value.to_bits().to_le_bytes())
    }
    fnv1a(bytes(magnetization))
}

fn fnv1a(bytes: impl IntoIterator<Item = u8>) -> u64 {
    bytes.into_iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn solve_module(
    grid: GridShape,
    cell_size: CellSize,
    resolved: &fullmag_ir::ResolvedSpinTransportPlanIR,
    descriptor: &ResolvedFdmSpinTransportIR,
    magnetization: &[[f64; 3]],
) -> Result<FdmSpinTransportModuleSnapshot, RunError> {
    let (charge_solution, current_density_apm2, spin_problem) =
        materialize_one_way_problem(grid, cell_size, descriptor, magnetization)?;
    solve_one_way_snapshot(
        grid,
        cell_size,
        resolved,
        descriptor,
        charge_solution,
        current_density_apm2,
        spin_problem,
        state_revision(magnetization),
    )
}

fn solve_transient_module(
    grid: GridShape,
    cell_size: CellSize,
    resolved: &fullmag_ir::ResolvedSpinTransportPlanIR,
    descriptor: &ResolvedFdmTransientSpinTransportIR,
    magnetization: &[[f64; 3]],
    origin: &TransientSpinState,
    stage_time_s: f64,
) -> Result<(FdmSpinTransportModuleSnapshot, TransientSpinState), RunError> {
    let steady = &descriptor.steady_operator;
    let (charge_solution, current_density_apm2, spin_problem) =
        materialize_one_way_problem(grid, cell_size, steady, magnetization)?;
    let capacitance_formula_version = format!(
        "per_cell:{}",
        descriptor.capacitance_formula_versions.join("|")
    );
    let integrator = TransientSpinIntegrator::new(
        &spin_problem,
        TransientSpinMaterial {
            spin_capacitance_as_per_v_m3: descriptor.spin_capacitance_as_per_v_m3.clone(),
            capacitance_formula_version,
        },
        TransientSpinSolverConfig {
            relative_tolerance: steady.spin_solver.linear.relative_tolerance,
            absolute_linear_residual_a_per_m3: steady.spin_solver.linear.absolute_tolerance,
            absolute_error_tolerance_v: steady.spin_solver.linear.absolute_tolerance,
            max_iterations: steady.spin_solver.linear.max_iterations as usize,
            restart: 40,
        },
    )
    .map_err(engine_error("transient spin integrator materialization"))?;
    let elapsed = stage_time_s - origin.time_s;
    if elapsed < 0.0 || !elapsed.is_finite() {
        return Err(run_error(
            "transient spin stage time precedes the committed transaction state",
        ));
    }
    let (candidate, iterations) = if elapsed == 0.0 {
        (origin.clone(), 0)
    } else {
        let attempt = integrator
            .try_fixed_step(origin, elapsed)
            .map_err(engine_error("transient ARS stage solve"))?;
        (
            attempt
                .candidate
                .ok_or_else(|| run_error("fixed transient ARS stage returned no candidate"))?,
            attempt.telemetry.linear_iterations,
        )
    };
    let observation = spin_problem
        .observe_transient_state(&candidate.spin_potential_v)
        .map_err(engine_error("transient accepted-state observation"))?;
    let tensors = observation
        .cell_spin_current_tensor_apm2
        .iter()
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
    let interface_fluxes = observation
        .spin_current_density
        .interface_observations
        .iter()
        .map(|observation| interface_snapshot(observation, &steady.interfaces))
        .collect();
    let oersted_field_apm = steady
        .oersted_source_bound
        .then(|| {
            biot_savart_midpoint_field(
                grid,
                cell_size,
                &steady.charge_active_cells,
                &current_density_apm2,
            )
            .map_err(engine_error("transient midpoint Oersted solve"))
        })
        .transpose()?;
    let residual_l2 = observation
        .residual_a_per_m3
        .iter()
        .flatten()
        .map(|value| value * value)
        .sum::<f64>()
        .sqrt();
    let balance_scale = observation.balance.normalization_current_a;
    let spin_relative_balance_closure = if balance_scale == 0.0 {
        observation
            .balance
            .closure_a
            .iter()
            .map(|value| value * value)
            .sum::<f64>()
            .sqrt()
    } else {
        observation
            .balance
            .closure_a
            .iter()
            .map(|value| value * value)
            .sum::<f64>()
            .sqrt()
            / balance_scale
    };
    let snapshot = FdmSpinTransportModuleSnapshot {
        module_id: resolved.module_id.clone(),
        current_source_id: resolved.current_source_id.clone(),
        potential_volts: charge_solution.potential_volts,
        current_density_apm2,
        spin_potential_volts: candidate.spin_potential_v.clone(),
        spin_current_tensor_apm2: tensors,
        interface_fluxes,
        transport_torque_per_s: observation.transport_gilbert_torque_per_s,
        oersted_field_apm,
        telemetry: FdmSpinTransportTelemetry {
            charge_iterations: charge_solution.iterations,
            charge_residual_l2: charge_solution.residual_l2,
            charge_net_boundary_current_a: charge_solution.balance.net_boundary_current_a,
            charge_max_abs_divergence_a_per_m3: charge_solution.balance.max_abs_divergence_a_per_m3,
            spin_iterations: iterations,
            spin_initial_residual_l2: residual_l2,
            spin_final_residual_l2: residual_l2,
            spin_scaled_residual: residual_l2,
            spin_relative_balance_closure,
            convergence_reason: "transient_ars_stage_accepted".into(),
            preconditioner: "none".into(),
            nonlinear_iterations: None,
            coupled_linear_iterations: None,
            preconditioner_applications: None,
            scaled_charge_residual: None,
            relative_charge_current_update: None,
            relative_spin_potential_update: None,
            transport_outer_error_ratio: None,
            charge_balance_relative: None,
            spin_balance_relative: None,
            warm_start_used: None,
        },
        constitutive_version: resolved.constitutive_version.clone(),
        charge_operator_version: steady.charge_solver.operator_version.clone(),
        spin_operator_version: steady.spin_solver.operator_version.clone(),
        torque_formula_version: steady.torque_formula_version.clone(),
        state_revision: candidate.state_revision,
        operator_revision: 0,
    };
    Ok((snapshot, candidate))
}

fn materialize_one_way_problem(
    grid: GridShape,
    cell_size: CellSize,
    descriptor: &ResolvedFdmSpinTransportIR,
    magnetization: &[[f64; 3]],
) -> Result<(ChargeSolution, Vec<[f64; 3]>, SpinDriftDiffusionProblem), RunError> {
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
    Ok((charge_solution, current_density_apm2, spin_problem))
}

fn solve_one_way_snapshot(
    grid: GridShape,
    cell_size: CellSize,
    resolved: &fullmag_ir::ResolvedSpinTransportPlanIR,
    descriptor: &ResolvedFdmSpinTransportIR,
    charge_solution: ChargeSolution,
    current_density_apm2: Vec<[f64; 3]>,
    spin_problem: SpinDriftDiffusionProblem,
    state_revision_value: u64,
) -> Result<FdmSpinTransportModuleSnapshot, RunError> {
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
            nonlinear_iterations: None,
            coupled_linear_iterations: None,
            preconditioner_applications: None,
            scaled_charge_residual: None,
            relative_charge_current_update: None,
            relative_spin_potential_update: None,
            transport_outer_error_ratio: None,
            charge_balance_relative: None,
            spin_balance_relative: None,
            warm_start_used: None,
        },
        constitutive_version: resolved.constitutive_version.clone(),
        charge_operator_version: descriptor.charge_solver.operator_version.clone(),
        spin_operator_version: descriptor.spin_solver.operator_version.clone(),
        torque_formula_version: descriptor.torque_formula_version.clone(),
        state_revision: state_revision_value,
        operator_revision: 0,
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
                reciprocal_nonlinear: None,
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
                fdm_cpu_double_reciprocal: None,
                fdm_cpu_double_transient: None,
            }],
            ..FdmPlanIR::default()
        }
    }

    fn reciprocal_plan() -> FdmPlanIR {
        let mut plan = plan();
        let resolved = &mut plan.spin_transport_plans[0];
        let one_way = resolved
            .fdm_cpu_double
            .take()
            .expect("one-way descriptor fixture");
        let count = one_way.charge_active_cells.len();
        resolved.resolved_coupling = TransportCouplingIR::Bidirectional;
        resolved.constitutive_version = "transport_constitutive.reciprocal.fullmag.v1".into();
        resolved.operator_version = "fdm_coupled_charge_spin_fv_block_gmres.v1".into();
        resolved.capabilities = vec![
            "transport.charge.magnetoresistive".into(),
            "transport.spin.inverse_she".into(),
            "transport.coupling.bidirectional".into(),
        ];
        resolved.fdm_cpu_double_reciprocal = Some(ResolvedFdmCoupledSpinTransportIR {
            descriptor_schema: "fullmag.fdm.coupled_spin_transport_descriptor.v1".into(),
            active_cells: one_way.charge_active_cells,
            reciprocal_materials: (0..count)
                .map(|_| ResolvedReciprocalMaterialIR {
                    sigma_spm: 2.0,
                    sigma_spin_spm: 4.0,
                    sigma_parallel_spm: 2.0,
                    sigma_perpendicular_spm: 2.0,
                    sigma_ahe_spm: 0.0,
                    polarization_p: 0.0,
                    theta_sh: 0.0,
                })
                .collect(),
            reactions: one_way.reactions,
            region_ids: one_way.region_ids,
            charge_boundaries: one_way.charge_boundaries,
            spin_boundaries: one_way.spin_boundaries,
            interfaces: vec![],
            torque_target_cells: vec![true; count],
            saturation_magnetization_apm: one_way.saturation_magnetization_apm,
            gamma_e_rad_per_s_t: one_way.gamma_e_rad_per_s_t,
            linear_solver: LinearTransportSolverPolicyIR {
                relative_tolerance: 1e-10,
                absolute_tolerance: 1e-14,
                max_iterations: 1000,
            },
            nonlinear_solver: ReciprocalNonlinearSolverPolicyIR {
                gmres_restart: 40,
                max_picard_iterations: 4,
                relative_update_tolerance: 1e-9,
                eta_transport: 0.25,
            },
            operator_version: "fdm_coupled_charge_spin_fv_block_gmres.v1".into(),
            physical_residual_version: "transport_balance_integrated_l2.v1".into(),
            constitutive_version: "transport_constitutive.reciprocal.fullmag.v1".into(),
            torque_formula_version: Some("drift_diffusion_absorbed_flux.v1".into()),
            oersted_source_bound: false,
        });
        plan
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
    fn reciprocal_bar_uses_exact_revision_warm_start_and_corrected_stage_lte_gate() {
        let plan = reciprocal_plan();
        let mut workflow = FdmSpinTransportWorkflow::from_plan(&plan)
            .expect("reciprocal workflow construction")
            .expect("spin workflow");
        let accepted = workflow
            .evaluate_stage(&plan.initial_magnetization, 0.0)
            .expect("initial reciprocal solve");
        workflow
            .commit(accepted)
            .expect("commit initial reciprocal state");

        let predictor = workflow
            .evaluate_stage(&plan.initial_magnetization, 1e-12)
            .expect("predictor reciprocal solve");
        assert_eq!(
            predictor.modules[0].telemetry.warm_start_used,
            Some(true),
            "exact state/operator revision should reuse the accepted coupled state"
        );
        let corrected = workflow
            .evaluate_stage_with_lte(
                &plan.initial_magnetization,
                1e-12,
                Some(TransportStageErrorBudget {
                    dt_s: 1e-12,
                    embedded_lte_m: 1.0,
                }),
                Some(&predictor),
            )
            .expect("corrected reciprocal solve should satisfy its LTE budget");
        let module = &corrected.modules[0];
        assert_eq!(
            module.constitutive_version,
            "transport_constitutive.reciprocal.fullmag.v1"
        );
        assert!(module.telemetry.nonlinear_iterations.is_some());
        assert_eq!(module.telemetry.transport_outer_error_ratio, Some(0.0));
    }

    #[test]
    fn reciprocal_descriptor_fails_closed_when_paired_with_one_way_descriptor() {
        let mut plan = reciprocal_plan();
        // Explicitly materialize the illegal dual-descriptor shape from the
        // canonical one-way fixture.
        let one_way_plan = self::plan();
        let one_way = one_way_plan.spin_transport_plans[0]
            .fdm_cpu_double
            .clone()
            .expect("one-way descriptor fixture");
        plan.spin_transport_plans[0].fdm_cpu_double = Some(one_way);
        let error = FdmSpinTransportWorkflow::from_plan(&plan)
            .expect_err("dual descriptors must fail closed");
        assert!(error.message.contains("exactly one"));
    }

    #[test]
    fn rejected_transport_attempt_restores_revision_and_refresh_counters() {
        let plan = reciprocal_plan();
        let mut workflow = FdmSpinTransportWorkflow::from_plan(&plan)
            .expect("workflow construction")
            .expect("spin workflow");
        let accepted = workflow
            .evaluate_stage(&plan.initial_magnetization, 0.0)
            .expect("accepted solve");
        workflow.commit(accepted).expect("initial commit");
        workflow.begin_attempt().expect("begin attempt");
        let discarded = workflow
            .evaluate_stage(&plan.initial_magnetization, 1e-12)
            .expect("discarded stage");
        assert_eq!(discarded.revision, 2);
        workflow.rollback();
        let retried = workflow
            .evaluate_stage(&plan.initial_magnetization, 1e-12)
            .expect("retried stage");
        assert_eq!(retried.revision, 2);
        assert_eq!(retried.refresh_count, 2);
        assert_eq!(workflow.accepted().unwrap().revision, 1);
    }

    #[test]
    fn reference_runner_executes_fixed_coupled_ars_and_publishes_only_accepted_transient_state() {
        let mut plan = plan();
        let resolved = &mut plan.spin_transport_plans[0];
        let mut steady_operator = resolved.fdm_cpu_double.take().unwrap();
        let count = steady_operator.spin_active_cells.len();
        steady_operator.theta_sh.fill(0.2);
        resolved.capabilities = vec!["transport.spin.transient_drift_diffusion".into()];
        resolved.fdm_cpu_double_transient = Some(ResolvedFdmTransientSpinTransportIR {
            descriptor_schema: "fullmag.fdm.transient_spin_transport_descriptor.v1".into(),
            steady_operator,
            spin_capacitance_as_per_v_m3: vec![2.0; count],
            capacitance_formula_versions: vec!["dos_constant.fullmag.v1".into(); count],
            transient_formula_version: "transient_spin_balance.fullmag.v1".into(),
            integrator: CoupledSpinIntegratorIR::CoupledImexArk2,
            integrator_version: "coupled_imex_ark2.v1".into(),
        });
        plan.integrator = None;
        plan.fixed_timestep = Some(1.0e-3);
        plan.gyromagnetic_ratio = 2.211e5;
        plan.material = FdmMaterialIR {
            name: "Py".into(),
            saturation_magnetisation: 8.0e5,
            exchange_stiffness: 13.0e-12,
            damping: 0.02,
            ..Default::default()
        };
        plan.enable_exchange = false;
        plan.enable_demag = false;

        let executed =
            super::super::reference::execute_reference_fdm(&plan, 1.0e-3, &[], None, None)
                .expect("fixed coupled ARS run");
        assert_eq!(executed.result.status, crate::types::RunStatus::Completed);
        let artifact = executed
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "transport/spin_transport_accepted.json")
            .expect("accepted transient artifact");
        let document: serde_json::Value = serde_json::from_slice(&artifact.bytes).unwrap();
        assert_eq!(document["schema"], "fullmag.fdm.spin_transport.accepted.v1");
        assert_eq!(document["integrator_version"], "coupled_imex_ark2.v1");
        assert_eq!(
            document["integrator_implementation_revision"],
            "imex_ars_232_step_doubling.fullmag.v1"
        );
        let module = &document["evaluation"]["modules"][0];
        assert_eq!(module["potential_volts"].as_array().unwrap().len(), count);
        assert_eq!(
            module["current_density_apm2"].as_array().unwrap().len(),
            count
        );
        assert_eq!(
            module["spin_potential_volts"].as_array().unwrap().len(),
            count
        );
        assert_eq!(
            module["spin_current_tensor_apm2"].as_array().unwrap().len(),
            count
        );
        let interior_mu = module["spin_potential_volts"][1][0].as_f64().unwrap();
        assert!(
            interior_mu > 0.0 && interior_mu < 0.1,
            "one short transient step must not publish the steady 1/3 V profile: {interior_mu}"
        );
        assert!(module["current_density_apm2"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|value| value.as_array().unwrap())
            .any(|value| value.as_f64().unwrap().abs() > 0.0));
        assert!(module["spin_current_tensor_apm2"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|value| value.as_array().unwrap())
            .any(|value| value.as_f64().unwrap().abs() > 0.0));

        let replay = super::super::reference::execute_reference_fdm(&plan, 1.0e-3, &[], None, None)
            .expect("deterministic fixed coupled ARS replay");
        let replay_artifact = replay
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "transport/spin_transport_accepted.json")
            .expect("replayed accepted transient artifact");
        assert_eq!(artifact.bytes, replay_artifact.bytes);
        assert!(executed
            .auxiliary_artifacts
            .iter()
            .chain(&replay.auxiliary_artifacts)
            .all(|artifact| !artifact.relative_path.contains("rejected")));
    }

    #[test]
    fn reference_runner_adaptive_coupled_ars_uses_full_vs_two_half_and_counts_rejection() {
        let mut plan = plan();
        let resolved = &mut plan.spin_transport_plans[0];
        let steady_operator = resolved.fdm_cpu_double.take().unwrap();
        let count = steady_operator.spin_active_cells.len();
        resolved.capabilities = vec!["transport.spin.transient_drift_diffusion".into()];
        resolved.fdm_cpu_double_transient = Some(ResolvedFdmTransientSpinTransportIR {
            descriptor_schema: "fullmag.fdm.transient_spin_transport_descriptor.v1".into(),
            steady_operator,
            spin_capacitance_as_per_v_m3: vec![2.0; count],
            capacitance_formula_versions: vec!["dos_constant.fullmag.v1".into(); count],
            transient_formula_version: "transient_spin_balance.fullmag.v1".into(),
            integrator: CoupledSpinIntegratorIR::CoupledImexArk2,
            integrator_version: "coupled_imex_ark2.v1".into(),
        });
        plan.integrator = None;
        plan.fixed_timestep = None;
        plan.adaptive_timestep = Some(AdaptiveTimeStepIR {
            atol: 1.0e-14,
            rtol: 1.0e-14,
            dt_initial: Some(1.0e-3),
            dt_min: 1.0e-8,
            dt_max: Some(1.0e-3),
            safety: 0.8,
            growth_limit: 2.0,
            shrink_limit: 0.1,
            max_spin_rotation: None,
            norm_tolerance: None,
        });
        plan.gyromagnetic_ratio = 2.211e5;
        plan.material = FdmMaterialIR {
            name: "Py".into(),
            saturation_magnetisation: 8.0e5,
            exchange_stiffness: 13.0e-12,
            damping: 0.02,
            ..Default::default()
        };
        plan.enable_exchange = false;
        plan.enable_demag = false;

        let executed =
            super::super::reference::execute_reference_fdm(&plan, 1.0e-3, &[], None, None)
                .expect("adaptive coupled ARS run");
        let artifact = executed
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "transport/spin_transport_accepted.json")
            .unwrap();
        let document: serde_json::Value = serde_json::from_slice(&artifact.bytes).unwrap();
        assert_eq!(document["timestep_mode"], "adaptive");
        assert!(document["accepted_steps"].as_u64().unwrap() >= 1);
        assert!(
            document["rejected_steps"].as_u64().unwrap() >= 1,
            "strict LTE tolerance must exercise rollback before acceptance"
        );
        assert!((executed.result.steps.last().unwrap().time - 1.0e-3).abs() < 1.0e-12);
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

    #[test]
    fn reference_runner_executes_reciprocal_m2_through_corrected_stage_lte_gate() {
        let mut plan = reciprocal_plan();
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
                .expect("reciprocal coupled reference run");
        assert_eq!(executed.result.status, crate::types::RunStatus::Completed);
        let artifact = executed
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "transport/spin_transport_accepted.json")
            .expect("accepted reciprocal transport artifact");
        let document: serde_json::Value =
            serde_json::from_slice(&artifact.bytes).expect("transport artifact JSON");
        assert_eq!(document["evaluation"]["refresh_count"], 3);
        assert_eq!(
            document["evaluation"]["modules"][0]["constitutive_version"],
            "transport_constitutive.reciprocal.fullmag.v1"
        );
        assert_eq!(
            document["evaluation"]["modules"][0]["telemetry"]["transport_outer_error_ratio"],
            0.0
        );
    }
}
