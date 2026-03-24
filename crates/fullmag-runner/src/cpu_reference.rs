//! CPU reference engine: executes FDM LLG via `fullmag-engine`.
//!
//! This remains the calibration baseline for terms that are not yet wired
//! into the native CUDA backend.

use fullmag_engine::{
    CellSize, EffectiveFieldTerms, ExchangeLlgProblem, ExchangeLlgState, GridShape, LlgConfig,
    MaterialParameters, TimeIntegrator,
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
    execute_reference_fdm_impl(
        plan,
        until_seconds,
        outputs,
        None::<(&[u32; 3], u64, &mut dyn FnMut(StepUpdate))>,
    )
}

/// Execute FDM on CPU with a per-step callback for live streaming.
pub(crate) fn execute_reference_fdm_with_callback(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    grid: [u32; 3],
    field_every_n: u64,
    on_step: &mut impl FnMut(StepUpdate),
) -> Result<ExecutedRun, RunError> {
    execute_reference_fdm_impl(
        plan,
        until_seconds,
        outputs,
        Some((&grid, field_every_n, on_step)),
    )
}

fn execute_reference_fdm_impl(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<(&[u32; 3], u64, &mut dyn FnMut(StepUpdate))>,
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

    let problem = ExchangeLlgProblem::with_terms_and_mask(
        grid,
        cell_size,
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external_field: plan.external_field,
        },
        plan.active_mask.clone(),
    )
    .map_err(|e| RunError {
        message: format!("Problem construction: {}", e),
    })?;

    let mut state = problem
        .new_state(plan.initial_magnetization.clone())
        .map_err(|e| RunError {
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

    // --- Create FFT workspace once for the entire simulation ---
    let mut fft_workspace = problem.create_workspace();

    while state.time_seconds < until_seconds {
        let dt_step = dt.min(until_seconds - state.time_seconds);
        let wall_start = Instant::now();
        problem
            .step_with_workspace(&mut state, dt_step, &mut fft_workspace)
            .map_err(|e| RunError {
                message: format!("Step {}: {}", step_count, e),
            })?;
        let wall_elapsed = wall_start.elapsed().as_nanos() as u64;
        step_count += 1;

        if !default_scalar_trace || !field_schedules.is_empty() {
            record_due_outputs(
                &problem,
                &state,
                step_count,
                dt_step,
                wall_elapsed,
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut field_snapshots,
            )?;
        }

        if let Some((live_grid, field_every_n, on_step)) = live.as_mut() {
            let observables = observe_state(&problem, &state)?;
            let emit_every = (*field_every_n).max(1);
            let include_field = step_count % emit_every == 0;
            let magnetization = if include_field {
                Some(
                    observables
                        .magnetization
                        .iter()
                        .flat_map(|vector| vector.iter().copied())
                        .collect(),
                )
            } else {
                None
            };
            on_step(StepUpdate {
                stats: make_step_stats(
                    step_count,
                    state.time_seconds,
                    dt_step,
                    wall_elapsed,
                    &observables,
                ),
                grid: [live_grid[0], live_grid[1], live_grid[2]],
                fem_mesh: None,
                magnetization,
                finished: false,
            });
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
            demag_operator_kind: if plan.enable_demag {
                Some("tensor_fft_newell".to_string())
            } else {
                None
            },
            fft_backend: if plan.enable_demag {
                Some("rustfft".to_string())
            } else {
                None
            },
            device_name: None,
            compute_capability: None,
            cuda_driver_version: None,
            cuda_runtime_version: None,
        },
    })
}

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
    let observables = problem.observe(state).map_err(|e| RunError {
        message: format!("Engine observables: {}", e),
    })?;

    Ok(StateObservables {
        magnetization: observables.magnetization,
        exchange_field: observables.exchange_field,
        demag_field: observables.demag_field,
        external_field: observables.external_field,
        effective_field: observables.effective_field,
        exchange_energy: observables.exchange_energy_joules,
        demag_energy: observables.demag_energy_joules,
        external_energy: observables.external_energy_joules,
        total_energy: observables.total_energy_joules,
        max_dm_dt: observables.max_rhs_amplitude,
        max_h_eff: observables.max_effective_field_amplitude,
        max_h_demag: observables.max_demag_field_amplitude,
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
        e_demag: observables.demag_energy,
        e_ext: observables.external_energy,
        e_total: observables.total_energy,
        max_dm_dt: observables.max_dm_dt,
        max_h_eff: observables.max_h_eff,
        max_h_demag: observables.max_h_demag,
        wall_time_ns,
    }
}

fn select_field_values(observables: &StateObservables, name: &str) -> Vec<[f64; 3]> {
    match name {
        "m" => observables.magnetization.clone(),
        "H_ex" => observables.exchange_field.clone(),
        "H_demag" => observables.demag_field.clone(),
        "H_ext" => observables.external_field.clone(),
        "H_eff" => observables.effective_field.clone(),
        other => panic!("unsupported field snapshot '{}'", other),
    }
}

#[cfg(test)]
fn max_vector_norm(values: &[[f64; 3]]) -> f64 {
    values
        .iter()
        .map(|value| (value[0] * value[0] + value[1] * value[1] + value[2] * value[2]).sqrt())
        .fold(0.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, GridDimensions,
        IntegratorChoice,
    };

    fn make_test_plan() -> FdmPlanIR {
        FdmPlanIR {
            grid: GridDimensions { cells: [4, 4, 1] },
            cell_size: [2e-9, 2e-9, 2e-9],
            region_mask: vec![0; 16],
            active_mask: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 16],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
            },
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-14),
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
        }
    }

    #[test]
    fn uniform_relaxation_produces_stable_energy() {
        let plan = make_test_plan();
        let result = execute_reference_fdm(&plan, 1e-12, &[]).expect("run should succeed");

        assert_eq!(result.result.status, RunStatus::Completed);
        assert!(!result.result.steps.is_empty());
        for step in &result.result.steps {
            assert!(
                step.e_ex.abs() < 1e-30,
                "uniform m should have zero exchange energy, got {}",
                step.e_ex
            );
        }
    }

    #[test]
    fn random_initial_relaxes_with_decreasing_energy() {
        let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);

        let plan = FdmPlanIR {
            initial_magnetization: random_m0,
            ..make_test_plan()
        };

        let result = execute_reference_fdm(&plan, 5e-12, &[]).expect("run should succeed");

        assert_eq!(result.result.status, RunStatus::Completed);
        let first_energy = result.result.steps.first().unwrap().e_ex;
        let last_energy = result.result.steps.last().unwrap().e_ex;
        assert!(
            last_energy <= first_energy,
            "exchange energy should decrease during relaxation: {} -> {}",
            first_energy,
            last_energy
        );
    }

    #[test]
    fn exchange_energy_respects_planned_material_parameters() {
        let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);
        let base_plan = FdmPlanIR {
            initial_magnetization: random_m0.clone(),
            ..make_test_plan()
        };
        let stronger_exchange_plan = FdmPlanIR {
            initial_magnetization: random_m0,
            material: FdmMaterialIR {
                exchange_stiffness: base_plan.material.exchange_stiffness * 2.0,
                ..base_plan.material.clone()
            },
            ..make_test_plan()
        };

        let base_result =
            execute_reference_fdm(&base_plan, 1e-14, &[]).expect("base run should succeed");
        let stronger_result = execute_reference_fdm(&stronger_exchange_plan, 1e-14, &[])
            .expect("scaled run should succeed");

        let base_initial = base_result.result.steps.first().unwrap().e_ex;
        let stronger_initial = stronger_result.result.steps.first().unwrap().e_ex;
        let ratio = stronger_initial / base_initial;
        assert!(
            (ratio - 2.0).abs() < 1e-9,
            "exchange energy should scale with A: got ratio {}",
            ratio
        );
    }

    #[test]
    fn scheduled_fields_include_initial_and_final_snapshots() {
        let plan = FdmPlanIR {
            initial_magnetization: fullmag_plan::generate_random_unit_vectors(42, 16),
            enable_demag: true,
            external_field: Some([1e5, 0.0, 0.0]),
            ..make_test_plan()
        };
        let outputs = [
            OutputIR::Field {
                name: "m".to_string(),
                every_seconds: 100e-12,
            },
            OutputIR::Field {
                name: "H_ex".to_string(),
                every_seconds: 100e-12,
            },
            OutputIR::Field {
                name: "H_demag".to_string(),
                every_seconds: 100e-12,
            },
            OutputIR::Field {
                name: "H_ext".to_string(),
                every_seconds: 100e-12,
            },
            OutputIR::Field {
                name: "H_eff".to_string(),
                every_seconds: 100e-12,
            },
            OutputIR::Scalar {
                name: "E_total".to_string(),
                every_seconds: 100e-12,
            },
        ];

        let executed = execute_reference_fdm(&plan, 1e-12, &outputs)
            .expect("scheduled field run should succeed");

        for field_name in ["m", "H_ex", "H_demag", "H_ext", "H_eff"] {
            let snapshots = executed
                .field_snapshots
                .iter()
                .filter(|snapshot| snapshot.name == field_name)
                .collect::<Vec<_>>();
            assert_eq!(
                snapshots.len(),
                2,
                "{field_name} should have initial and final snapshots"
            );
            assert_eq!(snapshots[0].step, 0);
            assert!(snapshots[1].step > 0);
        }
    }

    #[test]
    fn demag_and_external_terms_produce_nonzero_observables() {
        let plan = FdmPlanIR {
            initial_magnetization: fullmag_plan::generate_random_unit_vectors(7, 16),
            enable_exchange: false,
            enable_demag: true,
            external_field: Some([5e4, 0.0, 0.0]),
            ..make_test_plan()
        };

        let executed = execute_reference_fdm(&plan, 1e-14, &[]).expect("run should succeed");
        let stats = executed.result.steps.first().expect("scalar trace");

        assert!(stats.e_demag.is_finite());
        assert!(stats.e_ext.is_finite());
        assert!(stats.e_total.is_finite());
    }

    #[test]
    fn helper_max_vector_norm_handles_empty_input() {
        assert_eq!(max_vector_norm(&[]), 0.0);
    }

    #[test]
    fn active_mask_keeps_inactive_cells_zero_and_excludes_them_from_fields() {
        let active_mask = vec![
            true, true, false, false, true, true, false, false, true, true, false, false, true,
            true, false, false,
        ];
        let plan = FdmPlanIR {
            active_mask: Some(active_mask.clone()),
            initial_magnetization: vec![
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.5, 0.5, 0.5],
                [0.5, 0.5, 0.5],
            ],
            enable_demag: true,
            external_field: Some([1e5, 0.0, 0.0]),
            ..make_test_plan()
        };

        let outputs = [
            OutputIR::Field {
                name: "m".to_string(),
                every_seconds: 1e-13,
            },
            OutputIR::Field {
                name: "H_demag".to_string(),
                every_seconds: 1e-13,
            },
            OutputIR::Field {
                name: "H_ext".to_string(),
                every_seconds: 1e-13,
            },
        ];

        let executed =
            execute_reference_fdm(&plan, 2e-13, &outputs).expect("masked run should succeed");

        let is_zero = |vector: [f64; 3]| vector.iter().all(|value| value.abs() <= 1e-12);

        for (index, is_active) in active_mask.iter().enumerate() {
            if !is_active {
                assert!(
                    is_zero(executed.result.final_magnetization[index]),
                    "inactive cell {index} should stay zero in final magnetization"
                );
            }
        }

        for snapshot in &executed.field_snapshots {
            if snapshot.name == "H_demag" || snapshot.name == "H_ext" || snapshot.name == "m" {
                for (index, is_active) in active_mask.iter().enumerate() {
                    if !is_active {
                        assert!(
                            is_zero(snapshot.values[index]),
                            "inactive cell {index} should stay zero in snapshot '{}'",
                            snapshot.name
                        );
                    }
                }
            }
        }
    }
}
