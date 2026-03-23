//! Reference FDM runner: executes a planned simulation via `fullmag-engine`.
//!
//! Phase 1 scope: runs `FdmPlanIR` through the exchange-only CPU engine,
//! collects scheduled observables, and writes artifact files.

use fullmag_engine::{
    CellSize, ExchangeLlgProblem, ExchangeLlgState, GridShape, LlgConfig, MaterialParameters,
    TimeIntegrator, Vector3,
};
use fullmag_ir::{
    BackendPlanIR, ExecutionPrecision, FdmPlanIR, IntegratorChoice, OutputIR, ProblemIR,
};
use fullmag_plan::PlanError;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

const OUTPUT_TIME_TOLERANCE: f64 = 1e-18;

// ----- public types -----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub status: RunStatus,
    pub steps: Vec<StepStats>,
    pub final_magnetization: Vec<[f64; 3]>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepStats {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub e_ex: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    pub wall_time_ns: u64,
}

#[derive(Debug)]
pub struct RunError {
    pub message: String,
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RunError: {}", self.message)
    }
}

impl std::error::Error for RunError {}

impl From<PlanError> for RunError {
    fn from(e: PlanError) -> Self {
        RunError {
            message: format!("Planning failed:\n{}", e),
        }
    }
}

// ----- internal execution types -----

#[derive(Debug, Clone)]
struct ExecutedRun {
    result: RunResult,
    initial_magnetization: Vec<[f64; 3]>,
    field_snapshots: Vec<FieldSnapshot>,
}

#[derive(Debug, Clone)]
struct FieldSnapshot {
    name: String,
    step: u64,
    time: f64,
    solver_dt: f64,
    values: Vec<[f64; 3]>,
}

#[derive(Debug, Clone)]
struct OutputSchedule {
    name: String,
    every_seconds: f64,
    next_time: f64,
}

#[derive(Debug, Clone)]
struct StateObservables {
    magnetization: Vec<[f64; 3]>,
    exchange_field: Vec<[f64; 3]>,
    exchange_energy: f64,
    max_dm_dt: f64,
    max_h_eff: f64,
}

// ----- public API -----

/// Plan and run a problem, writing artifacts to `output_dir`.
///
/// This is the top-level entry point: ProblemIR → plan → execute → artifacts.
pub fn run_problem(
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
) -> Result<RunResult, RunError> {
    let plan = fullmag_plan::plan(problem)?;

    let fdm = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => fdm,
        _ => {
            return Err(RunError {
                message: "Phase 1 runner only supports FDM backend plan".to_string(),
            })
        }
    };

    let executed = execute_reference_fdm(fdm, until_seconds, &plan.output_plan.outputs)?;

    if let Err(e) = write_artifacts(output_dir, problem, &plan, &executed) {
        return Err(RunError {
            message: format!("Failed to write artifacts: {}", e),
        });
    }

    Ok(executed.result)
}

/// Execute a reference FDM plan without artifact writing.
pub fn run_reference_fdm(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<RunResult, RunError> {
    Ok(execute_reference_fdm(plan, until_seconds, outputs)?.result)
}

fn execute_reference_fdm(
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
    })
}

// ----- output capture -----

fn collect_scalar_schedules(outputs: &[OutputIR]) -> Result<Vec<OutputSchedule>, RunError> {
    let mut schedules = Vec::new();
    for output in outputs {
        if let OutputIR::Scalar {
            name,
            every_seconds,
        } = output
        {
            if !matches!(name.as_str(), "E_ex" | "time" | "step" | "solver_dt") {
                return Err(RunError {
                    message: format!("scalar output '{}' is not executable in Phase 1", name),
                });
            }
            schedules.push(OutputSchedule {
                name: name.clone(),
                every_seconds: *every_seconds,
                next_time: 0.0,
            });
        }
    }
    Ok(schedules)
}

fn collect_field_schedules(outputs: &[OutputIR]) -> Result<Vec<OutputSchedule>, RunError> {
    let mut schedules = Vec::new();
    for output in outputs {
        if let OutputIR::Field {
            name,
            every_seconds,
        } = output
        {
            if !matches!(name.as_str(), "m" | "H_ex") {
                return Err(RunError {
                    message: format!("field output '{}' is not executable in Phase 1", name),
                });
            }
            schedules.push(OutputSchedule {
                name: name.clone(),
                every_seconds: *every_seconds,
                next_time: 0.0,
            });
        }
    }
    Ok(schedules)
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

fn is_due(current_time: f64, next_time: f64) -> bool {
    current_time + OUTPUT_TIME_TOLERANCE >= next_time
}

fn same_time(lhs: f64, rhs: f64) -> bool {
    (lhs - rhs).abs() <= OUTPUT_TIME_TOLERANCE
}

fn advance_due_schedules(schedules: &mut [OutputSchedule], current_time: f64) {
    for schedule in schedules {
        while is_due(current_time, schedule.next_time) {
            schedule.next_time += schedule.every_seconds;
        }
    }
}

// ----- artifact writing -----

fn write_artifacts(
    output_dir: &Path,
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    executed: &ExecutedRun,
) -> std::io::Result<()> {
    fs::create_dir_all(output_dir)?;

    let metadata = serde_json::json!({
        "problem_name": problem.problem_meta.name,
        "ir_version": problem.ir_version,
        "source_hash": problem.problem_meta.source_hash,
        "problem_meta": problem.problem_meta,
        "execution_plan": plan,
        "engine_version": env!("CARGO_PKG_VERSION"),
        "status": executed.result.status,
        "scalar_rows": executed.result.steps.len(),
        "field_snapshots": executed.field_snapshots.len(),
    });
    let metadata_path = output_dir.join("metadata.json");
    let mut metadata_file = fs::File::create(&metadata_path)?;
    metadata_file.write_all(serde_json::to_string_pretty(&metadata).unwrap().as_bytes())?;

    let csv_path = output_dir.join("scalars.csv");
    let mut csv_file = fs::File::create(&csv_path)?;
    writeln!(csv_file, "step,time,solver_dt,E_ex")?;
    for step in &executed.result.steps {
        writeln!(
            csv_file,
            "{},{:.15e},{:.15e},{:.15e}",
            step.step, step.time, step.dt, step.e_ex
        )?;
    }

    write_field_file(
        &output_dir.join("m_initial.json"),
        problem,
        plan,
        "m",
        0,
        0.0,
        0.0,
        &executed.initial_magnetization,
    )?;

    let final_stats = executed.result.steps.last().cloned().unwrap_or(StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        wall_time_ns: 0,
    });
    write_field_file(
        &output_dir.join("m_final.json"),
        problem,
        plan,
        "m",
        final_stats.step,
        final_stats.time,
        final_stats.dt,
        &executed.result.final_magnetization,
    )?;

    let fields_dir = output_dir.join("fields");
    for snapshot in &executed.field_snapshots {
        let observable_dir = fields_dir.join(&snapshot.name);
        fs::create_dir_all(&observable_dir)?;
        let snapshot_path = observable_dir.join(format!("step_{:06}.json", snapshot.step));
        write_field_file(
            &snapshot_path,
            problem,
            plan,
            &snapshot.name,
            snapshot.step,
            snapshot.time,
            snapshot.solver_dt,
            &snapshot.values,
        )?;
    }

    Ok(())
}

fn write_field_file(
    path: &Path,
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    observable: &str,
    step: u64,
    time: f64,
    solver_dt: f64,
    values: &[[f64; 3]],
) -> std::io::Result<()> {
    let field_json = serde_json::json!({
        "observable": observable,
        "unit": field_unit(observable),
        "step": step,
        "time": time,
        "solver_dt": solver_dt,
        "layout": field_layout(plan),
        "provenance": {
            "problem_name": problem.problem_meta.name,
            "ir_version": problem.ir_version,
            "source_hash": problem.problem_meta.source_hash,
            "execution_mode": plan.common.execution_mode,
        },
        "values": values,
    });
    fs::write(path, serde_json::to_string_pretty(&field_json).unwrap())
}

fn field_layout(plan: &fullmag_ir::ExecutionPlanIR) -> serde_json::Value {
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => serde_json::json!({
            "backend": "fdm",
            "grid_cells": fdm.grid.cells,
            "cell_size": fdm.cell_size,
        }),
        BackendPlanIR::Fem(fem) => serde_json::json!({
            "backend": "fem",
            "mesh_name": fem.mesh_name,
        }),
    }
}

fn field_unit(observable: &str) -> &'static str {
    match observable {
        "m" => "dimensionless",
        "H_ex" => "A/m",
        other => panic!("unsupported observable '{}'", other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{ExchangeBoundaryCondition, FdmMaterialIR, GridDimensions};

    fn make_test_plan() -> FdmPlanIR {
        FdmPlanIR {
            grid: GridDimensions { cells: [4, 4, 1] },
            cell_size: [2e-9, 2e-9, 2e-9],
            region_mask: vec![0; 16],
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 16],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
            },
            gyromagnetic_ratio: 2.211e5,
            precision: fullmag_ir::ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-14),
        }
    }

    #[test]
    fn uniform_relaxation_produces_stable_energy() {
        let plan = make_test_plan();
        let result = run_reference_fdm(&plan, 1e-12, &[]).expect("run should succeed");

        assert_eq!(result.status, RunStatus::Completed);
        assert!(!result.steps.is_empty());
        for step in &result.steps {
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

        let result = run_reference_fdm(&plan, 5e-12, &[]).expect("run should succeed");

        assert_eq!(result.status, RunStatus::Completed);
        let first_energy = result.steps.first().unwrap().e_ex;
        let last_energy = result.steps.last().unwrap().e_ex;
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
            run_reference_fdm(&base_plan, 1e-14, &[]).expect("base run should succeed");
        let stronger_result = run_reference_fdm(&stronger_exchange_plan, 1e-14, &[])
            .expect("scaled run should succeed");

        let base_initial = base_result.steps.first().unwrap().e_ex;
        let stronger_initial = stronger_result.steps.first().unwrap().e_ex;
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
            OutputIR::Scalar {
                name: "E_ex".to_string(),
                every_seconds: 100e-12,
            },
        ];

        let executed = execute_reference_fdm(&plan, 1e-12, &outputs)
            .expect("scheduled field run should succeed");

        let m_snapshots = executed
            .field_snapshots
            .iter()
            .filter(|snapshot| snapshot.name == "m")
            .collect::<Vec<_>>();
        let h_ex_snapshots = executed
            .field_snapshots
            .iter()
            .filter(|snapshot| snapshot.name == "H_ex")
            .collect::<Vec<_>>();

        assert_eq!(
            m_snapshots.len(),
            2,
            "m should have initial and final snapshots"
        );
        assert_eq!(
            h_ex_snapshots.len(),
            2,
            "H_ex should have initial and final snapshots"
        );
        assert_eq!(m_snapshots[0].step, 0);
        assert!(m_snapshots[1].step > 0);
    }
}
