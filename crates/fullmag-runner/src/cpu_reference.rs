//! CPU reference engine: executes FDM exchange-only LLG via `fullmag-engine`.
//!
//! This is the Phase 1 execution path and remains the calibration baseline
//! for GPU backends.

use fullmag_engine::{
    CellSize, ExchangeLlgProblem, ExchangeLlgState, GridShape, LlgConfig, MaterialParameters,
    TimeIntegrator, Vector3,
};
use fullmag_ir::{ExecutionPrecision, FdmPlanIR, IntegratorChoice, OutputIR};

use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
    OutputSchedule,
};
use crate::types::{
    ExecutedRun, ExecutionProvenance, FieldSnapshot, RunError, RunResult, RunStatus,
    StateObservables, StepStats, StepUpdate,
};

use std::time::Instant;

/// Execute an FDM plan on the CPU reference engine.
pub(crate) fn execute_reference_fdm(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }
    if plan.precision != ExecutionPrecision::Double {
        return Err(RunError {
            message: format!(
                "execution_precision='{}' is not executable in the CPU reference runner; use 'double'",
                match plan.precision {
                    ExecutionPrecision::Single => "single",
                    ExecutionPrecision::Double => "double",
                }
            ),
        });
    }

    let grid = GridShape::new(
        plan.grid.cells[0] as usize,
        plan.grid.cells[1] as usize,
        plan.grid.cells[2] as usize,
    )
    .map_err(|e| RunError {
        message: format!("Grid: {}", e),
    })?;

    let cell_size = CellSize::new(plan.cell_size[0], plan.cell_size[1], plan.cell_size[2])
        .map_err(|e| RunError {
            message: format!("CellSize: {}", e),
        })?;

    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .map_err(|e| RunError {
        message: format!("Material: {}", e),
    })?;

    let integrator = match plan.integrator {
        IntegratorChoice::Heun => TimeIntegrator::Heun,
    };

    let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, integrator).map_err(|e| RunError {
        message: format!("LLG: {}", e),
    })?;

    let problem = ExchangeLlgProblem::new(grid, cell_size, material, dynamics);

    let mut state =
        ExchangeLlgState::new(grid, plan.initial_magnetization.clone()).map_err(|e| RunError {
            message: format!("State: {}", e),
        })?;
    let initial_magnetization = state.magnetization().to_vec();

    let dt = plan.fixed_timestep.unwrap_or(1e-13);
    let mut steps: Vec<StepStats> = Vec::new();
    let mut field_snapshots: Vec<FieldSnapshot> = Vec::new();
    let mut step_count: u64 = 0;

    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    if default_scalar_trace {
        record_scalar_snapshot(&problem, &state, 0, 0.0, 0, &mut steps)?;
    } else {
        record_due_outputs(
            &problem,
            &state,
            0,
            0.0,
            0,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut field_snapshots,
        )?;
    }

    while state.time_seconds < until_seconds {
        let wall_start = Instant::now();
        problem.step(&mut state, dt).map_err(|e| RunError {
            message: format!("Step {}: {}", step_count, e),
        })?;
        let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
        step_count += 1;

        if !default_scalar_trace || !field_schedules.is_empty() {
            record_due_outputs(
                &problem,
                &state,
                step_count,
                dt,
                wall_elapsed,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut field_snapshots,
            )?;
        }
    }

    record_final_outputs(
        &problem,
        &state,
        step_count,
        dt,
        default_scalar_trace,
        &field_schedules,
        &mut steps,
        &mut field_snapshots,
    )?;

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps,
            final_magnetization: state.magnetization().to_vec(),
        },
        initial_magnetization,
        field_snapshots,
        provenance: ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            device_name: None,
            compute_capability: None,
            cuda_driver_version: None,
            cuda_runtime_version: None,
        },
    })
}

// ----- output capture (CPU-specific) -----

fn record_due_outputs(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    field_snapshots: &mut Vec<FieldSnapshot>,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(state.time_seconds, schedule.next_time));
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(state.time_seconds, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    if !scalar_due && due_field_names.is_empty() {
        return Ok(());
    }

    let observables = observe_state(problem, state)?;

    if scalar_due {
        steps.push(make_step_stats(
            step,
            state.time_seconds,
            solver_dt,
            wall_time_ns,
            &observables,
        ));
        advance_due_schedules(scalar_schedules, state.time_seconds);
    }

    if !due_field_names.is_empty() {
        for name in due_field_names {
            field_snapshots.push(FieldSnapshot {
                name: name.clone(),
                step,
                time: state.time_seconds,
                solver_dt,
                values: select_field_values(&observables, &name),
            });
        }
        advance_due_schedules(field_schedules, state.time_seconds);
    }

    Ok(())
}

fn record_scalar_snapshot(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    step: u64,
    solver_dt: f64,
    wall_time_ns: u64,
    steps: &mut Vec<StepStats>,
) -> Result<(), RunError> {
    let observables = observe_state(problem, state)?;
    steps.push(make_step_stats(
        step,
        state.time_seconds,
        solver_dt,
        wall_time_ns,
        &observables,
    ));
    Ok(())
}

fn record_final_outputs(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
    step: u64,
    solver_dt: f64,
    default_scalar_trace: bool,
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    field_snapshots: &mut Vec<FieldSnapshot>,
) -> Result<(), RunError> {
    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, state.time_seconds))
            .unwrap_or(true);

    let requested_field_names = field_schedules
        .iter()
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    let missing_field_names = requested_field_names
        .into_iter()
        .filter(|name| {
            field_snapshots
                .iter()
                .rev()
                .find(|snapshot| snapshot.name == *name)
                .map(|snapshot| !same_time(snapshot.time, state.time_seconds))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();

    if !need_scalar && missing_field_names.is_empty() {
        return Ok(());
    }

    let observables = observe_state(problem, state)?;

    if need_scalar {
        steps.push(make_step_stats(
            step,
            state.time_seconds,
            solver_dt,
            0,
            &observables,
        ));
    }

    for name in missing_field_names {
        field_snapshots.push(FieldSnapshot {
            name: name.clone(),
            step,
            time: state.time_seconds,
            solver_dt,
            values: select_field_values(&observables, &name),
        });
    }

    Ok(())
}

fn observe_state(
    problem: &ExchangeLlgProblem,
    state: &ExchangeLlgState,
) -> Result<StateObservables, RunError> {
    let exchange_field = problem.exchange_field(state).map_err(|e| RunError {
        message: format!("Exchange field: {}", e),
    })?;
    let rhs = problem.llg_rhs(state).map_err(|e| RunError {
        message: format!("LLG RHS: {}", e),
    })?;
    let exchange_energy = problem.exchange_energy(state).map_err(|e| RunError {
        message: format!("Exchange energy: {}", e),
    })?;

    Ok(StateObservables {
        magnetization: state.magnetization().to_vec(),
        exchange_field: exchange_field.clone(),
        exchange_energy,
        max_dm_dt: max_vector_norm(&rhs),
        max_h_eff: max_vector_norm(&exchange_field),
    })
}

fn make_step_stats(
    step: u64,
    time: f64,
    solver_dt: f64,
    wall_time_ns: u64,
    observables: &StateObservables,
) -> StepStats {
    StepStats {
        step,
        time,
        dt: solver_dt,
        e_ex: observables.exchange_energy,
        max_dm_dt: observables.max_dm_dt,
        max_h_eff: observables.max_h_eff,
        wall_time_ns,
    }
}

fn select_field_values(observables: &StateObservables, name: &str) -> Vec<[f64; 3]> {
    match name {
        "m" => observables.magnetization.clone(),
        "H_ex" => observables.exchange_field.clone(),
        other => panic!("unsupported field snapshot '{}'", other),
    }
}

fn max_vector_norm(values: &[Vector3]) -> f64 {
    values
        .iter()
        .map(|value| (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt())
        .fold(0.0, f64::max)
}

/// Execute FDM on CPU with a per-step callback for live WebSocket streaming.
///
/// This mirrors `execute_reference_fdm` but emits `StepUpdate` after each step.
/// Magnetization data is included every `field_every_n` steps.
pub(crate) fn execute_reference_fdm_with_callback(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    grid: [u32; 3],
    field_every_n: u64,
    on_step: &mut impl FnMut(StepUpdate),
) -> Result<ExecutedRun, RunError> {
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }
    if plan.precision != ExecutionPrecision::Double {
        return Err(RunError {
            message: "CPU reference runner supports only 'double' precision".to_string(),
        });
    }

    let grid_shape = GridShape::new(
        plan.grid.cells[0] as usize,
        plan.grid.cells[1] as usize,
        plan.grid.cells[2] as usize,
    )
    .map_err(|e| RunError {
        message: format!("Grid: {}", e),
    })?;

    let cell_size = CellSize::new(plan.cell_size[0], plan.cell_size[1], plan.cell_size[2])
        .map_err(|e| RunError {
            message: format!("CellSize: {}", e),
        })?;

    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .map_err(|e| RunError {
        message: format!("Material: {}", e),
    })?;

    let integrator = match plan.integrator {
        IntegratorChoice::Heun => TimeIntegrator::Heun,
    };

    let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, integrator).map_err(|e| RunError {
        message: format!("LLG: {}", e),
    })?;

    let problem = ExchangeLlgProblem::new(grid_shape, cell_size, material, dynamics);

    let mut state =
        ExchangeLlgState::new(grid_shape, plan.initial_magnetization.clone()).map_err(|e| {
            RunError {
                message: format!("State: {}", e),
            }
        })?;
    let initial_magnetization = state.magnetization().to_vec();

    let dt = plan.fixed_timestep.unwrap_or(1e-13);
    let mut steps: Vec<StepStats> = Vec::new();
    let mut field_snapshots: Vec<FieldSnapshot> = Vec::new();
    let mut step_count: u64 = 0;

    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    if default_scalar_trace {
        record_scalar_snapshot(&problem, &state, 0, 0.0, 0, &mut steps)?;
    } else {
        record_due_outputs(
            &problem,
            &state,
            0,
            0.0,
            0,
            &mut scalar_schedules,
            &mut field_schedules,
            &mut steps,
            &mut field_snapshots,
        )?;
    }

    while state.time_seconds < until_seconds {
        let wall_start = Instant::now();
        problem.step(&mut state, dt).map_err(|e| RunError {
            message: format!("Step {}: {}", step_count, e),
        })?;
        let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
        step_count += 1;

        if !default_scalar_trace || !field_schedules.is_empty() {
            record_due_outputs(
                &problem,
                &state,
                step_count,
                dt,
                wall_elapsed,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut field_snapshots,
            )?;
        }

        // Emit live update
        let observables = observe_state(&problem, &state)?;
        let include_field = field_every_n > 0 && step_count % field_every_n == 0;
        let magnetization = if include_field {
            Some(
                observables
                    .magnetization
                    .iter()
                    .flat_map(|v| v.iter().copied())
                    .collect(),
            )
        } else {
            None
        };
        on_step(StepUpdate {
            stats: make_step_stats(
                step_count,
                state.time_seconds,
                dt,
                wall_elapsed,
                &observables,
            ),
            grid,
            magnetization,
            finished: false,
        });
    }

    record_final_outputs(
        &problem,
        &state,
        step_count,
        dt,
        default_scalar_trace,
        &field_schedules,
        &mut steps,
        &mut field_snapshots,
    )?;

    Ok(ExecutedRun {
        result: RunResult {
            status: RunStatus::Completed,
            steps,
            final_magnetization: state.magnetization().to_vec(),
        },
        initial_magnetization,
        field_snapshots,
        provenance: ExecutionProvenance {
            execution_engine: "cpu_reference".to_string(),
            precision: "double".to_string(),
            device_name: None,
            compute_capability: None,
            cuda_driver_version: None,
            cuda_runtime_version: None,
        },
    })
}
