use std::collections::BTreeMap;

use fullmag_engine::fdm::cpu::transport::{
    biot_savart_midpoint_field, ChargeBoundaryCondition, ChargeBoundaryConditions, ChargeSolution,
    ChargeSolverConfig, CoupledChargeSpinBoundaryConditions, CoupledChargeSpinMaterialFields,
    CoupledChargeSpinProblem, CoupledChargeSpinSolverConfig, CoupledChargeSpinWarmStart,
    CoupledTransportOuterErrorBudget, OrientedSpinInterface, PotentialGauge,
    ReciprocalConstitutiveMaterial, SpinBoundaryCondition, SpinBoundaryConditions,
    SpinDriftDiffusionProblem, SpinFluxOperator, SpinInterfaceLaw, SpinMaterialFields,
    SpinReactionLengths, SpinSolverConfig, SpinTorqueTargets, StructuredChargeProblem,
    StructuredSpinFace, TransientErrorControllerState, TransientSpinIntegrator,
    TransientSpinMaterial, TransientSpinSolverConfig, TransientSpinState,
};
use fullmag_engine::fdm::TransportStageErrorBudget;
use fullmag_engine::{CellSize, CoupledImexArk2Stage, GridShape};
use fullmag_ir::{
    ChargePotentialGaugeIR, FdmPlanIR, ResolvedChargeBoundaryConditionIR,
    ResolvedFdmCoupledSpinTransportIR, ResolvedFdmSpinTransportIR,
    ResolvedFdmTransientSpinTransportIR, ResolvedSpinBoundaryConditionIR,
    ResolvedSpinInterfaceLawIR, StructuredBoundaryFaceIR,
};
use serde::{Deserialize, Serialize};

use crate::types::RunError;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FdmSpinInterfaceFluxSnapshot {
    pub source_id: String,
    pub incoming_longitudinal_apm2: [f64; 3],
    pub backflow_longitudinal_apm2: [f64; 3],
    pub absorbed_transverse_apm2: [f64; 3],
    pub spin_memory_loss_apm2: [f64; 3],
    pub from_side_outgoing_apm2: [f64; 3],
    pub to_side_transmitted_apm2: [f64; 3],
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FdmSpinTransportEvaluation {
    pub revision: u64,
    pub evaluated_time_s: f64,
    pub refresh_count: u64,
    pub modules: Vec<FdmSpinTransportModuleSnapshot>,
    pub combined_transport_torque_per_s: Vec<[f64; 3]>,
    pub combined_oersted_field_apm: Option<Vec<[f64; 3]>>,
}

#[derive(Debug, Clone, PartialEq)]
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
    transient_stage_one_residuals: BTreeMap<String, Vec<[f64; 3]>>,
    accepted_steps: u64,
    rejected_steps: u64,
    error_controller: TransientErrorControllerState,
    checkpoint_identity: FdmCoupledCheckpointIdentity,
    charge_nonlinear_history: BTreeMap<String, Vec<f64>>,
    telemetry_cursor: u64,
    #[cfg(test)]
    coupled_failure_injection: Option<CoupledFailureInjection>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FdmCoupledCheckpointIdentity {
    pub requested_discretization: String,
    pub requested_device: String,
    pub requested_precision: String,
    pub requested_execution_mode: String,
    pub resolved_discretization: String,
    pub resolved_device: String,
    pub resolved_precision: String,
    pub resolved_execution_mode: String,
    pub scene_revision: u64,
    pub plan_revision: u64,
    pub mesh_revision: u64,
    pub material_revision: u64,
    pub current_operator_revision: u64,
    pub spin_operator_revision: u64,
    pub oersted_operator_revision: u64,
    pub charge_cache_identity: String,
    pub spin_cache_identity: String,
    pub oersted_cache_identity: String,
    pub source_identity: String,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CoupledFailureInjection {
    ChargeSolve,
    SpinSolve,
    FinalObservation,
    WorkflowCommit,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct FdmCoupledCheckpoint {
    pub schema: String,
    pub problem_ir_abi: String,
    pub scalar_layout: String,
    pub vector_layout: String,
    pub endianness: String,
    pub formula_version: String,
    pub integrator_version: String,
    pub integrator_implementation_revision: String,
    pub identity: FdmCoupledCheckpointIdentity,
    pub magnetization: Vec<[f64; 3]>,
    pub previous_magnetization: Vec<[f64; 3]>,
    pub time_s: f64,
    pub previous_dt_s: f64,
    pub accepted: FdmSpinTransportEvaluation,
    pub transient_states: BTreeMap<String, TransientSpinState>,
    pub next_revision: u64,
    pub refresh_count: u64,
    pub accepted_steps: u64,
    pub rejected_steps: u64,
    pub error_controller: TransientErrorControllerState,
    pub charge_nonlinear_history: BTreeMap<String, Vec<f64>>,
    pub telemetry_cursor: u64,
    pub thermal_rng_algorithm: String,
    pub thermal_seed: u64,
    pub thermal_counter: u64,
}

pub(crate) fn validate_coupled_m3_checkpoint_value(
    value: &serde_json::Value,
    vector_count: usize,
) -> Result<(), RunError> {
    let checkpoint: FdmCoupledCheckpoint = serde_json::from_value(value.clone())
        .map_err(|error| run_error(format!("invalid coupled M3 checkpoint payload: {error}")))?;
    validate_complete_coupled_checkpoint(&checkpoint, vector_count)
}

pub(crate) fn compare_coupled_m3_checkpoint_module_identity_values(
    actual: &serde_json::Value,
    expected: &serde_json::Value,
) -> Result<(), RunError> {
    let actual: FdmCoupledCheckpoint = serde_json::from_value(actual.clone())
        .map_err(|error| run_error(format!("invalid coupled M3 checkpoint payload: {error}")))?;
    let expected: FdmCoupledCheckpoint = serde_json::from_value(expected.clone())
        .map_err(|error| run_error(format!("invalid coupled M3 checkpoint payload: {error}")))?;
    let expected = expected
        .accepted
        .modules
        .iter()
        .map(CheckpointModuleContract::from_snapshot)
        .collect::<Vec<_>>();
    compare_checkpoint_module_contracts(&actual.accepted.modules, &expected)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CheckpointModuleContract {
    module_id: String,
    current_source_id: String,
    constitutive_version: String,
    charge_operator_version: String,
    spin_operator_version: String,
    torque_formula_version: Option<String>,
    operator_revision: u64,
}

impl CheckpointModuleContract {
    fn from_snapshot(module: &FdmSpinTransportModuleSnapshot) -> Self {
        Self {
            module_id: module.module_id.clone(),
            current_source_id: module.current_source_id.clone(),
            constitutive_version: module.constitutive_version.clone(),
            charge_operator_version: module.charge_operator_version.clone(),
            spin_operator_version: module.spin_operator_version.clone(),
            torque_formula_version: module.torque_formula_version.clone(),
            operator_revision: module.operator_revision,
        }
    }
}

fn compare_checkpoint_module_contracts(
    actual: &[FdmSpinTransportModuleSnapshot],
    expected: &[CheckpointModuleContract],
) -> Result<(), RunError> {
    if actual.len() != expected.len() {
        return Err(run_error(
            "coupled checkpoint module identity set/count mismatch",
        ));
    }
    let actual_by_id = actual
        .iter()
        .map(|module| (module.module_id.as_str(), module))
        .collect::<BTreeMap<_, _>>();
    let expected_by_id = expected
        .iter()
        .map(|module| (module.module_id.as_str(), module))
        .collect::<BTreeMap<_, _>>();
    if actual_by_id.len() != actual.len()
        || expected_by_id.len() != expected.len()
        || actual_by_id.keys().ne(expected_by_id.keys())
    {
        return Err(run_error(
            "coupled checkpoint module identity set/count mismatch",
        ));
    }
    for (module_id, actual) in actual_by_id {
        let expected = expected_by_id[module_id];
        if actual.current_source_id != expected.current_source_id
            || actual.constitutive_version != expected.constitutive_version
            || actual.charge_operator_version != expected.charge_operator_version
            || actual.spin_operator_version != expected.spin_operator_version
            || actual.torque_formula_version != expected.torque_formula_version
            || actual.operator_revision != expected.operator_revision
        {
            return Err(run_error(
                "coupled checkpoint accepted module identity mismatch",
            ));
        }
    }
    Ok(())
}

fn validate_complete_coupled_checkpoint(
    checkpoint: &FdmCoupledCheckpoint,
    vector_count: usize,
) -> Result<(), RunError> {
    let valid_vectors = |values: &[[f64; 3]]| {
        values.len() == vector_count && values.iter().flatten().all(|value| value.is_finite())
    };
    let required_identity_strings = [
        checkpoint.identity.requested_discretization.as_str(),
        checkpoint.identity.requested_device.as_str(),
        checkpoint.identity.requested_precision.as_str(),
        checkpoint.identity.requested_execution_mode.as_str(),
        checkpoint.identity.resolved_discretization.as_str(),
        checkpoint.identity.resolved_device.as_str(),
        checkpoint.identity.resolved_precision.as_str(),
        checkpoint.identity.resolved_execution_mode.as_str(),
        checkpoint.identity.charge_cache_identity.as_str(),
        checkpoint.identity.spin_cache_identity.as_str(),
        checkpoint.identity.oersted_cache_identity.as_str(),
        checkpoint.identity.source_identity.as_str(),
    ];
    if vector_count == 0
        || checkpoint.schema != "fullmag.fdm.coupled_m3_checkpoint.v1"
        || checkpoint.problem_ir_abi != "fullmag.problem_ir.v1"
        || checkpoint.scalar_layout != "f64"
        || checkpoint.vector_layout != "aos_xyz"
        || checkpoint.endianness != "little"
        || checkpoint.formula_version != "transient_spin_balance.fullmag.v1"
        || checkpoint.integrator_version != "coupled_imex_ark2.v1"
        || checkpoint.integrator_implementation_revision != "imex_ars_232_step_doubling.fullmag.v1"
        || checkpoint.thermal_rng_algorithm != "counter_hash_box_muller.fullmag.v1"
        || required_identity_strings
            .iter()
            .any(|value| value.trim().is_empty())
        || !valid_vectors(&checkpoint.magnetization)
        || !valid_vectors(&checkpoint.previous_magnetization)
        || !checkpoint.time_s.is_finite()
        || checkpoint.time_s < 0.0
        || !checkpoint.previous_dt_s.is_finite()
        || checkpoint.previous_dt_s <= 0.0
        || checkpoint.transient_states.is_empty()
        || checkpoint.accepted.modules.is_empty()
        || checkpoint.accepted.revision == 0
        || checkpoint.accepted.revision != checkpoint.accepted.refresh_count
        || checkpoint.accepted.revision.checked_add(1) != Some(checkpoint.next_revision)
        || checkpoint.refresh_count != checkpoint.accepted.refresh_count
        || checkpoint.accepted_steps == 0
        || checkpoint.telemetry_cursor < checkpoint.accepted_steps
        || checkpoint.thermal_counter != checkpoint.accepted_steps
        || !checkpoint.accepted.evaluated_time_s.is_finite()
        || checkpoint.accepted.evaluated_time_s != checkpoint.time_s
        || !valid_vectors(&checkpoint.accepted.combined_transport_torque_per_s)
        || checkpoint
            .accepted
            .combined_oersted_field_apm
            .as_deref()
            .is_some_and(|values| !valid_vectors(values))
        || !checkpoint.error_controller.next_dt_s.is_finite()
        || checkpoint.error_controller.next_dt_s <= 0.0
        || !checkpoint
            .error_controller
            .last_normalized_error
            .is_finite()
        || checkpoint.error_controller.last_normalized_error < 0.0
    {
        return Err(run_error(
            "coupled checkpoint contract/state/controller is invalid",
        ));
    }

    let transient_keys = checkpoint.transient_states.keys().collect::<Vec<_>>();
    let history_keys = checkpoint
        .charge_nonlinear_history
        .keys()
        .collect::<Vec<_>>();
    let mut module_keys = checkpoint
        .accepted
        .modules
        .iter()
        .map(|module| &module.module_id)
        .collect::<Vec<_>>();
    module_keys.sort();
    if transient_keys != history_keys || transient_keys != module_keys {
        return Err(run_error(
            "coupled checkpoint module/history keys are inconsistent",
        ));
    }
    for state in checkpoint.transient_states.values() {
        if !valid_vectors(&state.spin_potential_v)
            || state
                .previous_spin_potential_v
                .as_deref()
                .is_none_or(|values| !valid_vectors(values))
            || state.time_s != checkpoint.time_s
            || state
                .previous_dt_s
                .is_none_or(|dt| !dt.is_finite() || dt <= 0.0)
            || state.state_revision == 0
        {
            return Err(run_error(
                "coupled checkpoint transient history shape is invalid",
            ));
        }
    }
    for module in &checkpoint.accepted.modules {
        let state = &checkpoint.transient_states[&module.module_id];
        if module.current_source_id.trim().is_empty()
            || module.potential_volts.len() != vector_count
            || module
                .potential_volts
                .iter()
                .any(|value| !value.is_finite())
            || !valid_vectors(&module.current_density_apm2)
            || !valid_vectors(&module.spin_potential_volts)
            || module.spin_current_tensor_apm2.len() != vector_count
            || module
                .spin_current_tensor_apm2
                .iter()
                .flatten()
                .any(|value| !value.is_finite())
            || !valid_vectors(&module.transport_torque_per_s)
            || module
                .oersted_field_apm
                .as_deref()
                .is_some_and(|values| !valid_vectors(values))
            || module.constitutive_version.trim().is_empty()
            || module.charge_operator_version.trim().is_empty()
            || module.spin_operator_version.trim().is_empty()
            || module
                .torque_formula_version
                .as_deref()
                .is_some_and(|value| value.trim().is_empty())
            || module.state_revision != state.state_revision
            || module.spin_potential_volts != state.spin_potential_v
            || !valid_module_telemetry(&module.telemetry)
            || module.interface_fluxes.iter().any(|flux| {
                flux.source_id.trim().is_empty()
                    || flux_values(flux).any(|value| !value.is_finite())
            })
        {
            return Err(run_error(
                "coupled checkpoint accepted module shape is invalid",
            ));
        }
    }
    if checkpoint
        .charge_nonlinear_history
        .values()
        .flatten()
        .any(|value| !value.is_finite())
    {
        return Err(run_error("coupled checkpoint nonlinear history is invalid"));
    }
    let mut combined_torque = vec![[0.0; 3]; vector_count];
    let mut combined_oersted = None;
    for module in &checkpoint.accepted.modules {
        add_vector_field(&mut combined_torque, &module.transport_torque_per_s);
        if let Some(field) = &module.oersted_field_apm {
            let aggregate =
                combined_oersted.get_or_insert_with(|| vec![[0.0; 3]; vector_count]);
            add_vector_field(aggregate, field);
        }
    }
    if combined_torque != checkpoint.accepted.combined_transport_torque_per_s
        || combined_oersted != checkpoint.accepted.combined_oersted_field_apm
    {
        return Err(run_error(
            "coupled checkpoint aggregate transport fields are inconsistent",
        ));
    }
    Ok(())
}

fn flux_values(flux: &FdmSpinInterfaceFluxSnapshot) -> impl Iterator<Item = f64> + '_ {
    flux.incoming_longitudinal_apm2
        .iter()
        .chain(&flux.backflow_longitudinal_apm2)
        .chain(&flux.absorbed_transverse_apm2)
        .chain(&flux.spin_memory_loss_apm2)
        .chain(&flux.from_side_outgoing_apm2)
        .chain(&flux.to_side_transmitted_apm2)
        .copied()
}

fn valid_module_telemetry(telemetry: &FdmSpinTransportTelemetry) -> bool {
    let required = [
        telemetry.charge_residual_l2,
        telemetry.charge_net_boundary_current_a,
        telemetry.charge_max_abs_divergence_a_per_m3,
        telemetry.spin_initial_residual_l2,
        telemetry.spin_final_residual_l2,
        telemetry.spin_scaled_residual,
        telemetry.spin_relative_balance_closure,
    ];
    let optional = [
        telemetry.scaled_charge_residual,
        telemetry.relative_charge_current_update,
        telemetry.relative_spin_potential_update,
        telemetry.transport_outer_error_ratio,
        telemetry.charge_balance_relative,
        telemetry.spin_balance_relative,
    ];
    !telemetry.convergence_reason.trim().is_empty()
        && !telemetry.preconditioner.trim().is_empty()
        && required.iter().all(|value| value.is_finite())
        && optional.iter().flatten().all(|value| value.is_finite())
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
        let mut charge_nonlinear_history = BTreeMap::new();
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
                charge_nonlinear_history.insert(resolved.module_id.clone(), Vec::new());
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
        let next_dt_s = plan
            .adaptive_timestep
            .as_ref()
            .and_then(|adaptive| adaptive.dt_initial)
            .or(plan.fixed_timestep)
            .unwrap_or(1.0e-15);
        let checkpoint_identity = checkpoint_identity(plan)?;
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
            transient_stage_one_residuals: BTreeMap::new(),
            accepted_steps: 0,
            rejected_steps: 0,
            error_controller: TransientErrorControllerState {
                next_dt_s,
                last_normalized_error: 0.0,
            },
            checkpoint_identity,
            charge_nonlinear_history,
            telemetry_cursor: 0,
            #[cfg(test)]
            coupled_failure_injection: None,
        }))
    }

    pub(crate) fn begin_attempt(&mut self) -> Result<(), RunError> {
        if self.attempt_checkpoint.is_some() {
            return Err(run_error("spin transport step attempt is already active"));
        }
        self.attempt_checkpoint = Some((self.next_revision, self.refresh_count));
        self.transient_attempt_origin = Some(self.transient_states.clone());
        self.transient_candidates.clear();
        self.transient_stage_one_residuals.clear();
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
        self.evaluate_stage_internal(
            magnetization,
            stage_time_s,
            stage_error_budget,
            previous_stage,
            None,
        )
    }

    pub(crate) fn evaluate_coupled_ars_stage(
        &mut self,
        magnetization: &[[f64; 3]],
        stage_time_s: f64,
        dt_s: f64,
        stage: CoupledImexArk2Stage,
        previous_stage: Option<&FdmSpinTransportEvaluation>,
    ) -> Result<FdmSpinTransportEvaluation, RunError> {
        self.evaluate_stage_internal(
            magnetization,
            stage_time_s,
            None,
            previous_stage,
            Some((stage, dt_s)),
        )
    }

    fn evaluate_stage_internal(
        &mut self,
        magnetization: &[[f64; 3]],
        stage_time_s: f64,
        stage_error_budget: Option<TransportStageErrorBudget>,
        previous_stage: Option<&FdmSpinTransportEvaluation>,
        coupled_stage: Option<(CoupledImexArk2Stage, f64)>,
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
                let (stage, dt_s) = coupled_stage.ok_or_else(|| {
                    run_error("transient spin requires a canonical coupled ARS stage identity")
                })?;
                let stage_one_residual = self
                    .transient_stage_one_residuals
                    .get(&resolved.module_id)
                    .cloned();
                let prior_candidate = self.transient_candidates.get(&resolved.module_id).cloned();
                let (snapshot, candidate) = solve_transient_module(
                    self.grid,
                    self.cell_size,
                    resolved,
                    descriptor,
                    magnetization,
                    origin,
                    stage_time_s,
                    dt_s,
                    stage,
                    stage_one_residual.as_deref(),
                    prior_candidate.as_ref(),
                    #[cfg(test)]
                    self.coupled_failure_injection,
                    #[cfg(not(test))]
                    None,
                )?;
                if let Some(residual) = candidate.stage_one_residual {
                    self.transient_stage_one_residuals
                        .insert(resolved.module_id.clone(), residual);
                }
                self.transient_candidates
                    .insert(resolved.module_id.clone(), candidate.state);
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
        #[cfg(test)]
        if self.coupled_failure_injection == Some(CoupledFailureInjection::WorkflowCommit) {
            return Err(run_error("injected coupled workflow commit failure"));
        }
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
        self.transient_stage_one_residuals.clear();
        self.attempt_checkpoint = None;
        self.accepted_steps = self.accepted_steps.saturating_add(1);
        self.telemetry_cursor = self.telemetry_cursor.saturating_add(1);
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
        self.transient_stage_one_residuals.clear();
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

    pub(crate) fn set_error_controller(&mut self, next_dt_s: f64, normalized_error: f64) {
        self.error_controller = TransientErrorControllerState {
            next_dt_s,
            last_normalized_error: normalized_error,
        };
    }

    pub(crate) fn canonicalize_fixed_step_time(
        &mut self,
        time_s: f64,
        previous_dt_s: f64,
    ) -> Result<(), RunError> {
        if !time_s.is_finite()
            || time_s < 0.0
            || !previous_dt_s.is_finite()
            || previous_dt_s <= 0.0
            || self.attempt_checkpoint.is_some()
            || self.transient_attempt_origin.is_some()
            || !self.transient_candidates.is_empty()
        {
            return Err(run_error(
                "cannot canonicalize an invalid or uncommitted coupled fixed-step state",
            ));
        }
        let accepted = self
            .accepted
            .as_mut()
            .ok_or_else(|| run_error("cannot canonicalize missing accepted transport state"))?;
        accepted.evaluated_time_s = time_s;
        for state in self.transient_states.values_mut() {
            state.time_s = time_s;
            state.previous_dt_s = Some(previous_dt_s);
        }
        Ok(())
    }

    pub(crate) fn coupled_checkpoint(
        &self,
        magnetization: &[[f64; 3]],
        previous_magnetization: &[[f64; 3]],
        previous_dt_s: f64,
        thermal_seed: u64,
        thermal_counter: u64,
    ) -> Result<FdmCoupledCheckpoint, RunError> {
        let accepted = self
            .accepted
            .clone()
            .ok_or_else(|| run_error("coupled checkpoint requires accepted transport state"))?;
        if magnetization.len() != self.grid.cell_count()
            || previous_magnetization.len() != self.grid.cell_count()
            || !previous_dt_s.is_finite()
            || previous_dt_s <= 0.0
        {
            return Err(run_error(
                "coupled checkpoint magnetization/history shape is invalid",
            ));
        }
        Ok(FdmCoupledCheckpoint {
            schema: "fullmag.fdm.coupled_m3_checkpoint.v1".into(),
            problem_ir_abi: "fullmag.problem_ir.v1".into(),
            scalar_layout: "f64".into(),
            vector_layout: "aos_xyz".into(),
            endianness: "little".into(),
            formula_version: "transient_spin_balance.fullmag.v1".into(),
            integrator_version: "coupled_imex_ark2.v1".into(),
            integrator_implementation_revision: "imex_ars_232_step_doubling.fullmag.v1".into(),
            identity: self.checkpoint_identity.clone(),
            magnetization: magnetization.to_vec(),
            previous_magnetization: previous_magnetization.to_vec(),
            time_s: accepted.evaluated_time_s,
            previous_dt_s,
            accepted,
            transient_states: self.transient_states.clone(),
            next_revision: self.next_revision,
            refresh_count: self.refresh_count,
            accepted_steps: self.accepted_steps,
            rejected_steps: self.rejected_steps,
            error_controller: self.error_controller,
            charge_nonlinear_history: self.charge_nonlinear_history.clone(),
            telemetry_cursor: self.telemetry_cursor,
            thermal_rng_algorithm: "counter_hash_box_muller.fullmag.v1".into(),
            thermal_seed,
            thermal_counter,
        })
    }

    pub(crate) fn restore_coupled_checkpoint(
        &mut self,
        checkpoint: FdmCoupledCheckpoint,
    ) -> Result<FdmCoupledCheckpoint, RunError> {
        compare_checkpoint_identity(&checkpoint.identity, &self.checkpoint_identity)?;
        let count = self.grid.cell_count();
        validate_complete_coupled_checkpoint(&checkpoint, count)?;
        let expected_modules = self
            .plans
            .iter()
            .map(checkpoint_module_contract_from_plan)
            .collect::<Result<Vec<_>, _>>()?;
        compare_checkpoint_module_contracts(&checkpoint.accepted.modules, &expected_modules)?;
        if checkpoint
            .transient_states
            .keys()
            .ne(self.transient_states.keys())
            || checkpoint
                .charge_nonlinear_history
                .keys()
                .ne(self.charge_nonlinear_history.keys())
        {
            return Err(run_error(
                "coupled checkpoint state/history identity is invalid",
            ));
        }
        self.accepted = Some(checkpoint.accepted.clone());
        self.transient_states = checkpoint.transient_states.clone();
        self.next_revision = checkpoint.next_revision;
        self.refresh_count = checkpoint.refresh_count;
        self.accepted_steps = checkpoint.accepted_steps;
        self.rejected_steps = checkpoint.rejected_steps;
        self.error_controller = checkpoint.error_controller;
        self.charge_nonlinear_history = checkpoint.charge_nonlinear_history.clone();
        self.telemetry_cursor = checkpoint.telemetry_cursor;
        self.attempt_checkpoint = None;
        self.transient_attempt_origin = None;
        self.transient_candidates.clear();
        self.transient_stage_one_residuals.clear();
        Ok(checkpoint)
    }

    #[cfg(test)]
    pub(crate) fn inject_coupled_failure(&mut self, failure: CoupledFailureInjection) {
        self.coupled_failure_injection = Some(failure);
    }

    pub(crate) fn normalized_coupled_difference(
        &self,
        other: &Self,
        left_magnetization: &[[f64; 3]],
        right_magnetization: &[[f64; 3]],
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
        let mut max_error = 0.0_f64;
        if left_magnetization.len() != right_magnetization.len() {
            return Err(run_error("coupled trial magnetization shape mismatch"));
        }
        max_error = max_error.max(normalized_observable_difference(
            "magnetization",
            &left_magnetization
                .iter()
                .flatten()
                .copied()
                .collect::<Vec<_>>(),
            &right_magnetization
                .iter()
                .flatten()
                .copied()
                .collect::<Vec<_>>(),
            1.0,
            atol,
            rtol,
        )?);
        if left.modules.len() != right.modules.len() {
            return Err(run_error("coupled trial module count mismatch"));
        }
        for left_module in &left.modules {
            let right_module = right
                .modules
                .iter()
                .find(|module| module.module_id == left_module.module_id)
                .ok_or_else(|| run_error("transient trial module identity mismatch"))?;
            if left_module.current_source_id != right_module.current_source_id
                || left_module.constitutive_version != right_module.constitutive_version
                || left_module.charge_operator_version != right_module.charge_operator_version
                || left_module.spin_operator_version != right_module.spin_operator_version
                || left_module.torque_formula_version != right_module.torque_formula_version
                || left_module.operator_revision != right_module.operator_revision
            {
                return Err(run_error(
                    "coupled trial operator/source/cache identity mismatch",
                ));
            }
            macro_rules! compare_family {
                ($left:expr, $right:expr, $label:literal, $unit_floor:expr) => {{
                    let left_values: Vec<f64> = $left;
                    let right_values: Vec<f64> = $right;
                    max_error = max_error.max(normalized_observable_difference(
                        $label,
                        &left_values,
                        &right_values,
                        $unit_floor,
                        atol,
                        rtol,
                    )?);
                }};
            }
            compare_family!(
                left_module.potential_volts.clone(),
                right_module.potential_volts.clone(),
                "charge potential V",
                1.0e-15
            );
            compare_family!(
                left_module
                    .current_density_apm2
                    .iter()
                    .flatten()
                    .copied()
                    .collect(),
                right_module
                    .current_density_apm2
                    .iter()
                    .flatten()
                    .copied()
                    .collect(),
                "charge current A_per_m2",
                1.0e-12
            );
            compare_family!(
                left_module
                    .spin_potential_volts
                    .iter()
                    .flatten()
                    .copied()
                    .collect(),
                right_module
                    .spin_potential_volts
                    .iter()
                    .flatten()
                    .copied()
                    .collect(),
                "spin potential V",
                1.0e-15
            );
            compare_family!(
                left_module
                    .spin_current_tensor_apm2
                    .iter()
                    .flatten()
                    .copied()
                    .collect(),
                right_module
                    .spin_current_tensor_apm2
                    .iter()
                    .flatten()
                    .copied()
                    .collect(),
                "spin current tensor A_per_m2",
                1.0e-12
            );
            compare_family!(
                left_module
                    .transport_torque_per_s
                    .iter()
                    .flatten()
                    .copied()
                    .collect(),
                right_module
                    .transport_torque_per_s
                    .iter()
                    .flatten()
                    .copied()
                    .collect(),
                "transport torque per_s",
                1.0e-12
            );
            match (
                &left_module.oersted_field_apm,
                &right_module.oersted_field_apm,
            ) {
                (Some(left), Some(right)) => compare_family!(
                    left.iter().flatten().copied().collect(),
                    right.iter().flatten().copied().collect(),
                    "Oersted field A_per_m",
                    1.0e-12
                ),
                (None, None) => {}
                _ => return Err(run_error("coupled trial Oersted cache presence mismatch")),
            }
            if left_module.interface_fluxes.len() != right_module.interface_fluxes.len() {
                return Err(run_error("coupled trial interface flux shape mismatch"));
            }
            for (left_flux, right_flux) in left_module
                .interface_fluxes
                .iter()
                .zip(&right_module.interface_fluxes)
            {
                if left_flux.source_id != right_flux.source_id {
                    return Err(run_error(
                        "coupled trial interface source identity mismatch",
                    ));
                }
                compare_family!(
                    left_flux
                        .incoming_longitudinal_apm2
                        .into_iter()
                        .chain(left_flux.backflow_longitudinal_apm2)
                        .chain(left_flux.absorbed_transverse_apm2)
                        .chain(left_flux.spin_memory_loss_apm2)
                        .chain(left_flux.from_side_outgoing_apm2)
                        .chain(left_flux.to_side_transmitted_apm2)
                        .collect(),
                    right_flux
                        .incoming_longitudinal_apm2
                        .into_iter()
                        .chain(right_flux.backflow_longitudinal_apm2)
                        .chain(right_flux.absorbed_transverse_apm2)
                        .chain(right_flux.spin_memory_loss_apm2)
                        .chain(right_flux.from_side_outgoing_apm2)
                        .chain(right_flux.to_side_transmitted_apm2)
                        .collect(),
                    "interface flux A_per_m2",
                    1.0e-12
                );
            }
        }
        if self
            .transient_states
            .keys()
            .ne(other.transient_states.keys())
        {
            return Err(run_error(
                "coupled trial transient history identity mismatch",
            ));
        }
        for module_id in self.transient_states.keys() {
            let full = &self.transient_states[module_id];
            let half = &other.transient_states[module_id];
            if full.spin_potential_v.len() != half.spin_potential_v.len()
                || full.previous_spin_potential_v.is_some()
                    != half.previous_spin_potential_v.is_some()
                || (full.time_s - half.time_s).abs() > f64::EPSILON * full.time_s.abs().max(1.0)
                || full.previous_dt_s.is_none()
                || half.previous_dt_s.is_none()
            {
                return Err(run_error(
                    "coupled trial transient history/controller consistency mismatch",
                ));
            }
            let full_dt = full.previous_dt_s.expect("presence checked");
            let half_dt = half.previous_dt_s.expect("presence checked");
            if (full_dt - 2.0 * half_dt).abs() > 64.0 * f64::EPSILON * full_dt.abs().max(1.0)
                || half.state_revision != full.state_revision.saturating_add(1)
                || full
                    .previous_spin_potential_v
                    .as_ref()
                    .is_some_and(|values| values.iter().flatten().any(|value| !value.is_finite()))
                || half
                    .previous_spin_potential_v
                    .as_ref()
                    .is_some_and(|values| values.iter().flatten().any(|value| !value.is_finite()))
            {
                return Err(run_error(
                    "coupled trial transient history timestep/revision consistency mismatch",
                ));
            }
        }
        if other.accepted_steps != self.accepted_steps.saturating_add(1)
            || other.rejected_steps != self.rejected_steps
            || other.refresh_count != self.refresh_count.saturating_add(4)
            || other.next_revision != self.next_revision.saturating_add(4)
            || other.error_controller != self.error_controller
            || other.telemetry_cursor != self.telemetry_cursor.saturating_add(1)
            || other.charge_nonlinear_history != self.charge_nonlinear_history
        {
            return Err(run_error(
                "coupled trial counters/controller/warm-start consistency mismatch",
            ));
        }
        Ok(max_error)
    }
}

fn checkpoint_module_contract_from_plan(
    resolved: &fullmag_ir::ResolvedSpinTransportPlanIR,
) -> Result<CheckpointModuleContract, RunError> {
    let (charge_operator_version, spin_operator_version, torque_formula_version, operator_revision) =
        if let Some(transient) = &resolved.fdm_cpu_double_transient {
            let steady = &transient.steady_operator;
            (
                steady.charge_solver.operator_version.clone(),
                steady.spin_solver.operator_version.clone(),
                steady.torque_formula_version.clone(),
                0,
            )
        } else if let Some(steady) = &resolved.fdm_cpu_double {
            (
                steady.charge_solver.operator_version.clone(),
                steady.spin_solver.operator_version.clone(),
                steady.torque_formula_version.clone(),
                0,
            )
        } else if let Some(reciprocal) = &resolved.fdm_cpu_double_reciprocal {
            (
                reciprocal.operator_version.clone(),
                reciprocal.operator_version.clone(),
                reciprocal.torque_formula_version.clone(),
                descriptor_revision(reciprocal)?,
            )
        } else {
            return Err(run_error(format!(
                "spin transport '{}' has no executable checkpoint module contract",
                resolved.module_id
            )));
        };
    Ok(CheckpointModuleContract {
        module_id: resolved.module_id.clone(),
        current_source_id: resolved.current_source_id.clone(),
        constitutive_version: resolved.constitutive_version.clone(),
        charge_operator_version,
        spin_operator_version,
        torque_formula_version,
        operator_revision,
    })
}

fn normalized_observable_difference(
    label: &str,
    full: &[f64],
    half: &[f64],
    unit_floor: f64,
    atol: f64,
    rtol: f64,
) -> Result<f64, RunError> {
    if full.len() != half.len() {
        return Err(run_error(format!("coupled trial {label} shape mismatch")));
    }
    if !unit_floor.is_finite() || unit_floor <= 0.0 {
        return Err(run_error(format!(
            "coupled trial {label} unit scale is invalid"
        )));
    }
    let rms_scale = (full
        .iter()
        .chain(half)
        .map(|value| value * value)
        .sum::<f64>()
        / (full.len() + half.len()).max(1) as f64)
        .sqrt()
        .max(unit_floor);
    let sum = full
        .iter()
        .zip(half)
        .map(|(full, half)| {
            let scale = atol * rms_scale + rtol * full.abs().max(half.abs());
            (((half - full) / 3.0) / scale).powi(2)
        })
        .sum::<f64>();
    Ok((sum / full.len().max(1) as f64).sqrt())
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

fn checkpoint_identity(plan: &FdmPlanIR) -> Result<FdmCoupledCheckpointIdentity, RunError> {
    let transient = plan
        .spin_transport_plans
        .iter()
        .find(|resolved| resolved.fdm_cpu_double_transient.is_some())
        .ok_or_else(|| run_error("coupled checkpoint identity requires a transient descriptor"))?;
    let descriptor = transient
        .fdm_cpu_double_transient
        .as_ref()
        .expect("presence checked");
    let requested = &transient.requested_execution;
    let scene_revision = fingerprint_value(
        "scene",
        &serde_json::json!({
            "origin_m": plan.origin_m,
            "grid": plan.grid,
            "cell_size": plan.cell_size,
            "region_mask": plan.region_mask,
            "active_mask": plan.active_mask,
            "initial_magnetization": plan.initial_magnetization,
        }),
    )?;
    let plan_revision = fingerprint_value("plan", plan)?;
    let mesh_revision = fingerprint_value(
        "mesh",
        &serde_json::json!({
            "origin_m": plan.origin_m,
            "grid": plan.grid,
            "cell_size": plan.cell_size,
            "region_mask": plan.region_mask,
            "active_mask": plan.active_mask,
        }),
    )?;
    let material_revision = fingerprint_value(
        "material",
        &serde_json::json!({
            "magnetic": plan.material,
            "spin_capacitance": descriptor.spin_capacitance_as_per_v_m3,
            "capacitance_formula": descriptor.capacitance_formula_versions,
            "transport_material": descriptor.steady_operator,
        }),
    )?;
    let current_operator_revision = fingerprint_value(
        "current_operator",
        &serde_json::json!({
            "active": descriptor.steady_operator.charge_active_cells,
            "conductivity": descriptor.steady_operator.charge_conductivity_spm,
            "boundaries": descriptor.steady_operator.charge_boundaries,
            "gauge": descriptor.steady_operator.charge_gauge,
            "solver": descriptor.steady_operator.charge_solver,
        }),
    )?;
    let spin_operator_revision = fingerprint_value("spin_operator", descriptor)?;
    let oersted_operator_revision = fingerprint_value(
        "oersted_operator",
        &serde_json::json!({
            "bound": descriptor.steady_operator.oersted_source_bound,
            "charge_active": descriptor.steady_operator.charge_active_cells,
            "cell_size": plan.cell_size,
        }),
    )?;
    let source_revision = fingerprint_value(
        "source",
        &serde_json::json!({
            "module_id": transient.module_id,
            "current_source_id": transient.current_source_id,
            "charge_boundaries": descriptor.steady_operator.charge_boundaries,
        }),
    )?;
    Ok(FdmCoupledCheckpointIdentity {
        requested_discretization: format!("{:?}", requested.discretization).to_lowercase(),
        requested_device: format!("{:?}", requested.device).to_lowercase(),
        requested_precision: format!("{:?}", requested.precision).to_lowercase(),
        requested_execution_mode: format!("{:?}", requested.execution_mode).to_lowercase(),
        resolved_discretization: format!("{:?}", transient.resolved_discretization).to_lowercase(),
        resolved_device: format!("{:?}", transient.resolved_device).to_lowercase(),
        resolved_precision: format!("{:?}", transient.resolved_precision).to_lowercase(),
        resolved_execution_mode: "strict".into(),
        scene_revision,
        plan_revision,
        mesh_revision,
        material_revision,
        current_operator_revision,
        spin_operator_revision,
        oersted_operator_revision,
        charge_cache_identity: format!("charge-cache:{current_operator_revision:016x}"),
        spin_cache_identity: format!("spin-cache:{spin_operator_revision:016x}"),
        oersted_cache_identity: format!("oersted-cache:{oersted_operator_revision:016x}"),
        source_identity: format!("source:{source_revision:016x}"),
    })
}

fn fingerprint_value(label: &str, value: &impl Serialize) -> Result<u64, RunError> {
    let mut bytes = label.as_bytes().to_vec();
    bytes.extend(serde_json::to_vec(value).map_err(|error| {
        run_error(format!(
            "cannot fingerprint coupled checkpoint {label}: {error}"
        ))
    })?);
    Ok(fnv1a(bytes))
}

fn compare_checkpoint_identity(
    actual: &FdmCoupledCheckpointIdentity,
    expected: &FdmCoupledCheckpointIdentity,
) -> Result<(), RunError> {
    macro_rules! compare {
        ($field:ident, $label:literal) => {
            if actual.$field != expected.$field {
                return Err(run_error(concat!(
                    "coupled checkpoint ",
                    $label,
                    " mismatch"
                )));
            }
        };
    }
    compare!(requested_discretization, "requested discretization");
    compare!(requested_device, "requested device");
    compare!(requested_precision, "requested precision");
    compare!(requested_execution_mode, "requested execution mode");
    compare!(resolved_discretization, "resolved discretization");
    compare!(resolved_device, "resolved device");
    compare!(resolved_precision, "resolved precision");
    compare!(resolved_execution_mode, "resolved execution mode");
    compare!(scene_revision, "scene revision");
    compare!(plan_revision, "plan revision");
    compare!(mesh_revision, "mesh revision");
    compare!(material_revision, "material revision");
    compare!(current_operator_revision, "current operator revision");
    compare!(spin_operator_revision, "spin operator revision");
    compare!(oersted_operator_revision, "Oersted operator revision");
    compare!(charge_cache_identity, "charge cache identity");
    compare!(spin_cache_identity, "spin cache identity");
    compare!(oersted_cache_identity, "Oersted cache identity");
    compare!(source_identity, "source identity");
    Ok(())
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

struct TransientStageCandidate {
    state: TransientSpinState,
    stage_one_residual: Option<Vec<[f64; 3]>>,
}

fn solve_transient_module(
    grid: GridShape,
    cell_size: CellSize,
    resolved: &fullmag_ir::ResolvedSpinTransportPlanIR,
    descriptor: &ResolvedFdmTransientSpinTransportIR,
    magnetization: &[[f64; 3]],
    origin: &TransientSpinState,
    stage_time_s: f64,
    dt_s: f64,
    stage: CoupledImexArk2Stage,
    stage_one_residual: Option<&[[f64; 3]]>,
    prior_candidate: Option<&TransientSpinState>,
    failure_injection: Option<CoupledFailureInjection>,
) -> Result<(FdmSpinTransportModuleSnapshot, TransientStageCandidate), RunError> {
    let steady = &descriptor.steady_operator;
    let (charge_solution, current_density_apm2, spin_problem) =
        materialize_one_way_problem(grid, cell_size, steady, magnetization)?;
    if failure_injection == Some(CoupledFailureInjection::ChargeSolve)
        && stage == CoupledImexArk2Stage::ImplicitStageOne
    {
        return Err(run_error("injected coupled charge solve failure"));
    }
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
    if stage_time_s < origin.time_s || !stage_time_s.is_finite() {
        return Err(run_error(
            "transient spin stage time precedes the committed transaction state",
        ));
    }
    let (candidate, residual, iterations) = match stage {
        CoupledImexArk2Stage::ExplicitOrigin => (origin.clone(), None, 0),
        CoupledImexArk2Stage::ImplicitStageOne => {
            let (spin_potential_v, residual, iterations) = integrator
                .ars232_implicit_stage_one(&origin.spin_potential_v, dt_s)
                .map_err(engine_error("transient ARS implicit stage one"))?;
            let mut candidate = origin.clone();
            candidate.spin_potential_v = spin_potential_v;
            (candidate, Some(residual), iterations)
        }
        CoupledImexArk2Stage::ImplicitStageTwo => {
            let residual = stage_one_residual
                .ok_or_else(|| run_error("transient ARS stage two requires stage-one residual"))?;
            let (spin_potential_v, iterations) = integrator
                .ars232_implicit_stage_two(&origin.spin_potential_v, residual, dt_s)
                .map_err(engine_error("transient ARS implicit stage two"))?;
            let mut candidate = origin.clone();
            candidate.spin_potential_v = spin_potential_v;
            (candidate, None, iterations)
        }
        CoupledImexArk2Stage::AcceptedObservation => {
            let stage_two = prior_candidate.ok_or_else(|| {
                run_error("transient accepted observation requires ARS stage two")
            })?;
            let candidate = integrator
                .complete_fixed_step_state(origin, stage_two.spin_potential_v.clone(), dt_s)
                .map_err(engine_error("transient ARS accepted-state completion"))?;
            (candidate, None, 0)
        }
    };
    if failure_injection == Some(CoupledFailureInjection::SpinSolve)
        && stage == CoupledImexArk2Stage::ImplicitStageTwo
    {
        return Err(run_error("injected coupled spin solve failure"));
    }
    let observation = spin_problem
        .observe_transient_state(&candidate.spin_potential_v)
        .map_err(engine_error("transient accepted-state observation"))?;
    if failure_injection == Some(CoupledFailureInjection::FinalObservation)
        && stage == CoupledImexArk2Stage::AcceptedObservation
    {
        return Err(run_error("injected coupled final observation failure"));
    }
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
    Ok((
        snapshot,
        TransientStageCandidate {
            state: candidate,
            stage_one_residual: residual,
        },
    ))
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

    fn fixed_transient_plan(dt_s: f64) -> FdmPlanIR {
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
        plan.fixed_timestep = Some(dt_s);
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
        plan
    }

    fn accepted_coupled_vector(executed: &crate::types::ExecutedRun) -> Vec<f64> {
        let artifact = executed
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "transport/spin_transport_accepted.json")
            .expect("accepted coupled state artifact");
        let document: serde_json::Value = serde_json::from_slice(&artifact.bytes).unwrap();
        let module = &document["evaluation"]["modules"][0];
        let mut values: Vec<f64> = executed
            .result
            .final_magnetization
            .iter()
            .flatten()
            .copied()
            .collect();
        for key in [
            "potential_volts",
            "current_density_apm2",
            "spin_potential_volts",
            "spin_current_tensor_apm2",
            "transport_torque_per_s",
        ] {
            fn append(value: &serde_json::Value, values: &mut Vec<f64>) {
                if let Some(number) = value.as_f64() {
                    values.push(number);
                } else if let Some(items) = value.as_array() {
                    for item in items {
                        append(item, values);
                    }
                }
            }
            append(&module[key], &mut values);
        }
        values
    }

    #[test]
    fn coupled_ars232_has_second_order_temporal_convergence_for_complete_state() {
        let until_s = 1.0e-3;
        let run = |dt_s| {
            let executed = super::super::reference::execute_reference_fdm(
                &fixed_transient_plan(dt_s),
                until_s,
                &[],
                None,
                None,
            )
            .expect("coupled temporal-order run");
            accepted_coupled_vector(&executed)
        };
        let coarse = run(2.5e-4);
        let fine = run(1.25e-4);
        let reference = run(1.5625e-5);
        let error = |values: &[f64]| {
            values
                .iter()
                .zip(&reference)
                .map(|(value, reference)| (value - reference).powi(2))
                .sum::<f64>()
                .sqrt()
        };
        let ratio = error(&coarse) / error(&fine);
        assert!(
            ratio > 3.2,
            "complete coupled state must converge at second order; ratio={ratio:.6}"
        );
    }

    #[test]
    fn coupled_trial_failures_rollback_llg_transport_and_thermal_state() {
        let mut plan = fixed_transient_plan(1.0e-3);
        plan.temperature = Some(300.0);
        let (problem, initial_state) =
            super::super::reference::build_snapshot_problem_and_state(&plan).unwrap();
        let pristine_problem = problem.clone();
        let initial_workflow = FdmSpinTransportWorkflow::from_plan(&plan).unwrap().unwrap();
        for failure in [
            CoupledFailureInjection::ChargeSolve,
            CoupledFailureInjection::SpinSolve,
            CoupledFailureInjection::FinalObservation,
            CoupledFailureInjection::WorkflowCommit,
        ] {
            let mut state = initial_state.clone();
            let mut workflow = initial_workflow.clone();
            workflow.inject_coupled_failure(failure);
            let expected_workflow = workflow.clone();
            let thermal_before = problem.thermal_step();
            let mut fft_workspace = problem.create_workspace();
            let mut integrator_bufs = problem.create_integrator_buffers();
            let error = super::super::reference::execute_coupled_ars_trial(
                &problem,
                &mut state,
                &mut workflow,
                1.0e-3,
                &mut fft_workspace,
                &mut integrator_bufs,
            )
            .expect_err("injected coupled failure must reject the whole transaction");
            assert!(error.message.contains("injected coupled"));
            assert_eq!(state, initial_state, "LLG state changed after {failure:?}");
            assert_eq!(
                workflow, expected_workflow,
                "transport state changed after {failure:?}"
            );
            assert_eq!(
                problem.thermal_step(),
                thermal_before,
                "thermal RNG counter changed after {failure:?}"
            );
        }
        let mut after_failure_state = initial_state.clone();
        let mut after_failure_workflow = initial_workflow.clone();
        let mut after_failure_workspace = problem.create_workspace();
        let mut after_failure_buffers = problem.create_integrator_buffers();
        super::super::reference::execute_coupled_ars_trial(
            &problem,
            &mut after_failure_state,
            &mut after_failure_workflow,
            1.0e-3,
            &mut after_failure_workspace,
            &mut after_failure_buffers,
        )
        .unwrap();
        let mut pristine_state = initial_state;
        let mut pristine_workflow = initial_workflow;
        let mut pristine_workspace = pristine_problem.create_workspace();
        let mut pristine_buffers = pristine_problem.create_integrator_buffers();
        super::super::reference::execute_coupled_ars_trial(
            &pristine_problem,
            &mut pristine_state,
            &mut pristine_workflow,
            1.0e-3,
            &mut pristine_workspace,
            &mut pristine_buffers,
        )
        .unwrap();
        assert_eq!(after_failure_state, pristine_state);
        assert_eq!(
            after_failure_workflow.accepted(),
            pristine_workflow.accepted()
        );
    }

    #[test]
    fn adaptive_norm_detects_each_dimensional_observable_family() {
        let families: [(&str, f64, f64); 7] = [
            ("m", 1.0, 0.25),
            ("V", 1.0e-15, 2.0e-3),
            ("J", 1.0e-12, 4.0e10),
            ("mu", 1.0e-15, 8.0e-4),
            ("Q", 1.0e-12, 7.0e9),
            ("torque", 1.0e-12, 3.0e8),
            ("H", 1.0e-12, 6.0e5),
        ];
        for (label, floor, magnitude) in families {
            let baseline = [magnitude, -0.5 * magnitude, 0.25 * magnitude];
            let mut perturbed = baseline;
            perturbed[1] += magnitude.abs().max(floor) * 1.0e-3;
            let error = normalized_observable_difference(
                label, &baseline, &perturbed, floor, 1.0e-6, 1.0e-4,
            )
            .unwrap();
            assert!(error > 0.0, "{label} perturbation was ignored");

            let conversion = 1.0e3;
            let converted_baseline = baseline.map(|value| value * conversion);
            let converted_perturbed = perturbed.map(|value| value * conversion);
            let converted_error = normalized_observable_difference(
                label,
                &converted_baseline,
                &converted_perturbed,
                floor * conversion,
                1.0e-6,
                1.0e-4,
            )
            .unwrap();
            assert!((converted_error - error).abs() <= 1.0e-12 * error.max(1.0));
        }
    }

    #[test]
    fn coupled_checkpoint_resume_matches_uninterrupted_artifact_and_thermal_sequence() {
        let mut plan = fixed_transient_plan(1.0e-4);
        plan.temperature = Some(300.0);
        let (problem, mut state) =
            super::super::reference::build_snapshot_problem_and_state(&plan).unwrap();
        let initial_magnetization = state.magnetization().to_vec();
        let mut workflow = FdmSpinTransportWorkflow::from_plan(&plan).unwrap().unwrap();
        let mut workspace = problem.create_workspace();
        let mut buffers = problem.create_integrator_buffers();
        super::super::reference::execute_coupled_ars_trial(
            &problem,
            &mut state,
            &mut workflow,
            1.0e-4,
            &mut workspace,
            &mut buffers,
        )
        .unwrap();
        problem.commit_coupled_imex_ark2_step();
        let checkpoint = workflow
            .coupled_checkpoint(
                state.magnetization(),
                &initial_magnetization,
                1.0e-4,
                problem.thermal_seed,
                problem.thermal_step(),
            )
            .unwrap();
        let persisted = serde_json::to_vec(&checkpoint).unwrap();

        super::super::reference::execute_coupled_ars_trial(
            &problem,
            &mut state,
            &mut workflow,
            1.0e-4,
            &mut workspace,
            &mut buffers,
        )
        .unwrap();
        problem.commit_coupled_imex_ark2_step();
        let uninterrupted_m = state.magnetization().to_vec();
        let uninterrupted_artifact = serde_json::to_vec(workflow.accepted().unwrap()).unwrap();
        let uninterrupted_thermal_counter = problem.thermal_step();

        let checkpoint: FdmCoupledCheckpoint = serde_json::from_slice(&persisted).unwrap();
        let (restored_problem, mut restored_state) =
            super::super::reference::build_snapshot_problem_and_state(&plan).unwrap();
        restored_state
            .restore_exact_checkpoint(checkpoint.magnetization.clone(), checkpoint.time_s)
            .unwrap();
        restored_problem.restore_thermal_step(checkpoint.thermal_counter);
        assert_eq!(restored_problem.thermal_seed, checkpoint.thermal_seed);
        let mut restored_workflow = FdmSpinTransportWorkflow::from_plan(&plan).unwrap().unwrap();
        restored_workflow
            .restore_coupled_checkpoint(checkpoint)
            .unwrap();
        let mut restored_workspace = restored_problem.create_workspace();
        let mut restored_buffers = restored_problem.create_integrator_buffers();
        super::super::reference::execute_coupled_ars_trial(
            &restored_problem,
            &mut restored_state,
            &mut restored_workflow,
            1.0e-4,
            &mut restored_workspace,
            &mut restored_buffers,
        )
        .unwrap();
        restored_problem.commit_coupled_imex_ark2_step();

        for (restored, uninterrupted) in restored_state
            .magnetization()
            .iter()
            .flatten()
            .zip(uninterrupted_m.iter().flatten())
        {
            assert!((restored - uninterrupted).abs() <= 1.0e-24);
        }
        fn assert_json_close(left: &serde_json::Value, right: &serde_json::Value) {
            match (left, right) {
                (serde_json::Value::Number(left), serde_json::Value::Number(right)) => {
                    let left = left.as_f64().unwrap();
                    let right = right.as_f64().unwrap();
                    assert!((left - right).abs() <= 1.0e-12 * left.abs().max(right.abs()).max(1.0));
                }
                (serde_json::Value::Array(left), serde_json::Value::Array(right)) => {
                    assert_eq!(left.len(), right.len());
                    for (left, right) in left.iter().zip(right) {
                        assert_json_close(left, right);
                    }
                }
                (serde_json::Value::Object(left), serde_json::Value::Object(right)) => {
                    assert_eq!(
                        left.keys().collect::<Vec<_>>(),
                        right.keys().collect::<Vec<_>>()
                    );
                    for (key, left) in left {
                        assert_json_close(left, &right[key]);
                    }
                }
                _ => assert_eq!(left, right),
            }
        }
        assert_json_close(
            &serde_json::to_value(restored_workflow.accepted().unwrap()).unwrap(),
            &serde_json::from_slice(&uninterrupted_artifact).unwrap(),
        );
        assert_eq!(
            restored_problem.thermal_step(),
            uninterrupted_thermal_counter
        );
    }

    #[test]
    fn coupled_checkpoint_restore_rejects_incomplete_state_without_mutating_workflow() {
        let plan = fixed_transient_plan(1.0e-4);
        let (problem, mut state) =
            super::super::reference::build_snapshot_problem_and_state(&plan).unwrap();
        let previous_magnetization = state.magnetization().to_vec();
        let mut workflow = FdmSpinTransportWorkflow::from_plan(&plan).unwrap().unwrap();
        let mut workspace = problem.create_workspace();
        let mut buffers = problem.create_integrator_buffers();
        super::super::reference::execute_coupled_ars_trial(
            &problem,
            &mut state,
            &mut workflow,
            1.0e-4,
            &mut workspace,
            &mut buffers,
        )
        .unwrap();
        problem.commit_coupled_imex_ark2_step();
        let checkpoint = workflow
            .coupled_checkpoint(
                state.magnetization(),
                &previous_magnetization,
                1.0e-4,
                problem.thermal_seed,
                problem.thermal_step(),
            )
            .unwrap();

        for label in [
            "V",
            "J",
            "mu",
            "Q",
            "torque",
            "H",
            "previous spin history",
        ] {
            let mut raw = serde_json::to_value(&checkpoint).unwrap();
            if label == "H" {
                raw["accepted"]["modules"][0]["oersted_field_apm"] = serde_json::json!([]);
            } else {
                let (object, key) = match label {
                    "V" => (&mut raw["accepted"]["modules"][0], "potential_volts"),
                    "J" => (&mut raw["accepted"]["modules"][0], "current_density_apm2"),
                    "mu" => (&mut raw["accepted"]["modules"][0], "spin_potential_volts"),
                    "Q" => (&mut raw["accepted"]["modules"][0], "spin_current_tensor_apm2"),
                    "torque" => (
                        &mut raw["accepted"]["modules"][0],
                        "transport_torque_per_s",
                    ),
                    "previous spin history" => (
                        &mut raw["transient_states"]["spin"],
                        "previous_spin_potential_v",
                    ),
                    _ => unreachable!(),
                };
                object.as_object_mut().unwrap().remove(key);
            }
            super::super::reference::execute_reference_fdm_with_coupled_checkpoint(
                &plan,
                2.0e-4,
                &[],
                None,
                None,
                Some(raw),
            )
            .expect_err(label);
        }

        type Mutation = Box<dyn Fn(&mut FdmCoupledCheckpoint)>;
        let mutations: Vec<(&str, Mutation)> = vec![
            ("V shape", Box::new(|value| value.accepted.modules[0].potential_volts.clear())),
            ("J finite", Box::new(|value| value.accepted.modules[0].current_density_apm2[0][0] = f64::NAN)),
            ("mu shape", Box::new(|value| value.accepted.modules[0].spin_potential_volts.clear())),
            ("Q finite", Box::new(|value| value.accepted.modules[0].spin_current_tensor_apm2[0][0] = f64::INFINITY)),
            ("torque shape", Box::new(|value| value.accepted.modules[0].transport_torque_per_s.clear())),
            ("H shape", Box::new(|value| value.accepted.modules[0].oersted_field_apm = Some(Vec::new()))),
            ("previous spin history", Box::new(|value| value.transient_states.get_mut("spin").unwrap().previous_spin_potential_v = None)),
            ("module keys", Box::new(|value| value.accepted.modules[0].module_id = "other".into())),
            ("module revision", Box::new(|value| value.accepted.modules[0].state_revision += 1)),
            (
                "accepted revision",
                Box::new(|value| value.accepted.revision += 1),
            ),
            (
                "next revision gap",
                Box::new(|value| value.next_revision += 1),
            ),
            (
                "revision overflow",
                Box::new(|value| {
                    value.accepted.revision = u64::MAX;
                    value.accepted.refresh_count = u64::MAX;
                    value.refresh_count = u64::MAX;
                }),
            ),
            (
                "accepted refresh",
                Box::new(|value| value.accepted.refresh_count += 1),
            ),
            (
                "accepted spin state",
                Box::new(|value| {
                    value.accepted.modules[0].spin_potential_volts[0][0] += 1.0
                }),
            ),
            (
                "operator revision",
                Box::new(|value| value.accepted.modules[0].operator_revision += 1),
            ),
            (
                "combined torque",
                Box::new(|value| {
                    value.accepted.combined_transport_torque_per_s[0][0] += 1.0
                }),
            ),
            (
                "combined Oersted presence",
                Box::new(|value| {
                    value.accepted.combined_oersted_field_apm =
                        Some(vec![[0.0; 3]; value.magnetization.len()])
                }),
            ),
            (
                "empty torque formula",
                Box::new(|value| {
                    value.accepted.modules[0].torque_formula_version = Some("   ".into())
                }),
            ),
            ("telemetry finite", Box::new(|value| value.accepted.modules[0].telemetry.charge_residual_l2 = f64::NAN)),
            ("telemetry cursor", Box::new(|value| value.telemetry_cursor = 0)),
            ("thermal counter", Box::new(|value| value.thermal_counter += 1)),
        ];
        for (label, mutate) in mutations {
            let pristine = workflow.clone();
            let mut malformed = checkpoint.clone();
            mutate(&mut malformed);
            workflow
                .restore_coupled_checkpoint(malformed)
                .expect_err(label);
            assert_eq!(workflow, pristine, "restore mutated workflow for {label}");
        }
    }

    #[test]
    fn coupled_checkpoint_rejects_each_public_identity_mismatch() {
        let plan = fixed_transient_plan(1.0e-4);
        let workflow = FdmSpinTransportWorkflow::from_plan(&plan).unwrap().unwrap();
        let expected = workflow.checkpoint_identity.clone();
        let mut mismatches = Vec::new();
        macro_rules! mismatch {
            ($label:literal, $field:ident, $value:expr) => {{
                let mut changed = expected.clone();
                changed.$field = $value;
                mismatches.push(($label, changed));
            }};
        }
        mismatch!(
            "requested discretization",
            requested_discretization,
            "fem".into()
        );
        mismatch!("requested device", requested_device, "gpu".into());
        mismatch!("requested precision", requested_precision, "single".into());
        mismatch!(
            "requested execution mode",
            requested_execution_mode,
            "extended".into()
        );
        mismatch!(
            "resolved discretization",
            resolved_discretization,
            "fem".into()
        );
        mismatch!("resolved device", resolved_device, "gpu".into());
        mismatch!("resolved precision", resolved_precision, "single".into());
        mismatch!(
            "resolved execution mode",
            resolved_execution_mode,
            "extended".into()
        );
        mismatch!(
            "scene revision",
            scene_revision,
            expected.scene_revision ^ 1
        );
        mismatch!("plan revision", plan_revision, expected.plan_revision ^ 1);
        mismatch!("mesh revision", mesh_revision, expected.mesh_revision ^ 1);
        mismatch!(
            "material revision",
            material_revision,
            expected.material_revision ^ 1
        );
        mismatch!(
            "current operator revision",
            current_operator_revision,
            expected.current_operator_revision ^ 1
        );
        mismatch!(
            "spin operator revision",
            spin_operator_revision,
            expected.spin_operator_revision ^ 1
        );
        mismatch!(
            "Oersted operator revision",
            oersted_operator_revision,
            expected.oersted_operator_revision ^ 1
        );
        mismatch!(
            "charge cache identity",
            charge_cache_identity,
            "other-charge".into()
        );
        mismatch!(
            "spin cache identity",
            spin_cache_identity,
            "other-spin".into()
        );
        mismatch!(
            "Oersted cache identity",
            oersted_cache_identity,
            "other-oersted".into()
        );
        mismatch!("source identity", source_identity, "other-source".into());

        for (label, identity) in mismatches {
            let error = compare_checkpoint_identity(&identity, &expected)
                .expect_err("every public checkpoint identity mismatch must fail");
            assert!(error.message.contains(label), "{label}: {}", error.message);
        }
    }

    #[test]
    fn public_reference_resume_matches_uninterrupted_runner_artifact() {
        let mut plan = fixed_transient_plan(1.0e-4);
        plan.temperature = Some(300.0);
        let display = || crate::DisplaySelectionState::default();
        let mut captured = None;
        let first = super::super::reference::execute_reference_fdm(
            &plan,
            2.0e-4,
            &[],
            Some(crate::types::LiveStepConsumer {
                grid: plan.grid.cells,
                field_every_n: 1,
                initial_snapshot: false,
                display_selection: Some(&display),
                interrupt_requested: None,
                on_step: &mut |update| {
                    if let Some(checkpoint) = update.coupled_checkpoint {
                        captured = Some(checkpoint);
                        crate::StepAction::Pause
                    } else {
                        crate::StepAction::Continue
                    }
                },
            }),
            None,
        )
        .unwrap();
        assert_eq!(first.result.status, crate::RunStatus::Paused);
        let checkpoint = captured.expect("live session must publish the coupled backend state");

        let uninterrupted =
            super::super::reference::execute_reference_fdm(&plan, 2.0e-4, &[], None, None).unwrap();
        let resumed = super::super::reference::execute_reference_fdm_with_coupled_checkpoint(
            &plan,
            2.0e-4,
            &[],
            None,
            None,
            Some(checkpoint),
        )
        .unwrap();
        assert_eq!(
            resumed.result.final_magnetization,
            uninterrupted.result.final_magnetization
        );
        let accepted_artifact = |run: &crate::types::ExecutedRun| {
            run.auxiliary_artifacts
                .iter()
                .find(|artifact| artifact.relative_path == "transport/spin_transport_accepted.json")
                .map(|artifact| artifact.bytes.clone())
                .expect("accepted transport artifact")
        };
        assert_eq!(
            accepted_artifact(&resumed),
            accepted_artifact(&uninterrupted)
        );
        assert_eq!(
            serde_json::to_value(resumed.result.steps.last()).unwrap(),
            serde_json::to_value(uninterrupted.result.steps.last()).unwrap()
        );
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
