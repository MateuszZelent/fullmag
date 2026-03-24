//! CPU reference FEM runner: executes narrow FEM LLG via `fullmag-engine::fem`.
//!
//! Current executable slice:
//! - precomputed `MeshIR`
//! - `Exchange`, optional bootstrap `Demag`, and optional `Zeeman`
//! - `LLG(heun)`
//! - `double` precision

use fullmag_engine::fem::{FemLlgProblem, FemLlgState, MeshTopology};
use fullmag_engine::{EffectiveFieldTerms, LlgConfig, MaterialParameters, TimeIntegrator};
use fullmag_ir::{ExecutionPrecision, FemPlanIR, IntegratorChoice, OutputIR};

use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
    OutputSchedule,
};
use crate::types::{
    ExecutedRun, ExecutionProvenance, FieldSnapshot, RunError, RunResult, RunStatus,
    StateObservables, StepStats, StepUpdate,
};

use std::time::Instant;

pub(crate) fn execute_reference_fem(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    execute_reference_fem_impl(
        plan,
        until_seconds,
        outputs,
        None::<([u32; 3], u64, &mut dyn FnMut(StepUpdate))>,
    )
}

pub(crate) fn execute_reference_fem_with_callback(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    field_every_n: u64,
    on_step: &mut impl FnMut(StepUpdate),
) -> Result<ExecutedRun, RunError> {
    execute_reference_fem_impl(
        plan,
        until_seconds,
        outputs,
        Some(([0, 0, 0], field_every_n, on_step)),
    )
}

fn execute_reference_fem_impl(
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<([u32; 3], u64, &mut dyn FnMut(StepUpdate))>,
) -> Result<ExecutedRun, RunError> {
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }
    if plan.precision != ExecutionPrecision::Double {
        return Err(RunError {
            message: "execution_precision='single' is not executable in the FEM CPU reference runner; use 'double'".to_string(),
        });
    }

    let topology = MeshTopology::from_ir(&plan.mesh).map_err(|e| RunError {
        message: format!("MeshTopology: {}", e),
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

    let problem = FemLlgProblem::with_terms(
        topology,
        material,
        dynamics,
        EffectiveFieldTerms {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external_field: plan.external_field,
        },
    );
    let mut state = problem
        .new_state(plan.initial_magnetization.clone())
        .map_err(|e| RunError {
            message: format!("State: {}", e),
        })?;
    let initial_magnetization = state.magnetization().to_vec();

    let dt = plan.fixed_timestep.unwrap_or(1e-13);
    let mut steps = Vec::new();
    let mut field_snapshots = Vec::new();
    let mut step_count = 0u64;
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
        let dt_step = dt.min(until_seconds - state.time_seconds);
        let wall_start = Instant::now();
        problem.step(&mut state, dt_step).map_err(|e| RunError {
            message: format!("FEM step {}: {}", step_count, e),
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

        if let Some((grid, field_every_n, on_step)) = live.as_mut() {
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
                stats: make_step_stats(step_count, state.time_seconds, dt_step, wall_elapsed, &observables),
                grid: *grid,
                fem_mesh: Some(crate::types::FemMeshPayload {
                    nodes: plan.mesh.nodes.clone(),
                    elements: plan.mesh.elements.clone(),
                    boundary_faces: plan.mesh.boundary_faces.clone(),
                }),
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
            execution_engine: "cpu_reference_fem".to_string(),
            precision: "double".to_string(),
            demag_operator_kind: if plan.enable_demag {
                Some("fem_scalar_potential_robin".to_string())
            } else {
                None
            },
            fft_backend: None,
            device_name: None,
            compute_capability: None,
            cuda_driver_version: None,
            cuda_runtime_version: None,
        },
    })
}

fn record_due_outputs(
    problem: &FemLlgProblem,
    state: &FemLlgState,
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
    problem: &FemLlgProblem,
    state: &FemLlgState,
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
    problem: &FemLlgProblem,
    state: &FemLlgState,
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
    problem: &FemLlgProblem,
    state: &FemLlgState,
) -> Result<StateObservables, RunError> {
    let observables = problem.observe(state).map_err(|e| RunError {
        message: format!("FEM engine observables: {}", e),
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
        other => panic!("unsupported FEM field snapshot '{}'", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FemPlanIR, IntegratorChoice, MaterialIR,
        MeshIR,
    };

    fn make_test_plan(enable_demag: bool) -> FemPlanIR {
        FemPlanIR {
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
            mesh: MeshIR {
                mesh_name: "unit_tet".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
            },
            fe_order: 1,
            hmax: 1.0,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
            },
            enable_exchange: true,
            enable_demag,
            external_field: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
        }
    }

    #[test]
    fn uniform_fem_relaxation_produces_near_zero_exchange_energy() {
        let plan = make_test_plan(false);
        let result = execute_reference_fem(&plan, 1e-12, &[]).expect("FEM run should succeed");
        assert_eq!(result.result.status, RunStatus::Completed);
        assert!(!result.result.steps.is_empty());
        for step in &result.result.steps {
            assert!(
                step.e_ex.abs() < 1e-24,
                "uniform FEM state should have near-zero exchange energy"
            );
        }
    }

    #[test]
    fn demag_outputs_are_nonzero_when_enabled() {
        let plan = make_test_plan(true);
        let result = execute_reference_fem(&plan, 1e-12, &[]).expect("FEM demag run should succeed");
        assert_eq!(result.result.status, RunStatus::Completed);
        let last = result.result.steps.last().expect("at least one step");
        assert!(last.e_demag >= 0.0);
        assert!(last.max_h_demag > 0.0);
    }

    #[test]
    fn fem_callback_emits_live_updates() {
        let plan = make_test_plan(true);
        let mut seen = 0usize;
        let result = execute_reference_fem_with_callback(&plan, 5e-13, &[], 2, &mut |update| {
            seen += 1;
            assert_eq!(update.grid, [0, 0, 0]);
        })
        .expect("callback FEM run should succeed");

        assert_eq!(result.result.status, RunStatus::Completed);
        assert!(seen > 0, "expected at least one live FEM callback update");
    }
}
