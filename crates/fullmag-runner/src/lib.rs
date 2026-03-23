//! Reference FDM runner: executes a planned simulation via `fullmag-engine`.
//!
//! Phase 1 scope: runs `ReferenceFdmPlanIR` through the exchange-only CPU engine,
//! collects step stats, and writes artifact files.

use fullmag_engine::{
    CellSize, ExchangeLlgProblem, ExchangeLlgState, GridShape, LlgConfig, MaterialParameters,
    StepReport, TimeIntegrator, Vector3,
};
use fullmag_ir::{BackendPlanIR, FdmPlanIR, IntegratorChoice, OutputIR, ProblemIR};
use fullmag_plan::PlanError;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

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

    let result = run_reference_fdm(fdm, until_seconds, &plan.output_plan.outputs)?;

    // Write artifacts
    if let Err(e) = write_artifacts(output_dir, problem, &plan, &result) {
        return Err(RunError {
            message: format!("Failed to write artifacts: {}", e),
        });
    }

    Ok(result)
}

/// Execute a reference FDM plan without artifact writing.
pub fn run_reference_fdm(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<RunResult, RunError> {
    let grid = GridShape::new(
        plan.grid.cells[0] as usize,
        plan.grid.cells[1] as usize,
        plan.grid.cells[2] as usize,
    )
    .map_err(|e| RunError {
        message: format!("Grid: {}", e),
    })?;

    let cell_size =
        CellSize::new(plan.cell_size[0], plan.cell_size[1], plan.cell_size[2]).map_err(|e| {
            RunError {
                message: format!("CellSize: {}", e),
            }
        })?;

    // Find material parameters from the plan
    // In Phase 1, the plan carries material params inline (from planner)
    // For now we read from the IR — the planner should embed them.
    // Placeholder: use the plan's initial_magnetization length as a signal.
    // TODO: the planner should embed material params in the plan.
    // For now, accept external material params or look them up.

    // Extract from the plan — this is a Phase 1 shortcut.
    // The plan doesn't carry material params directly yet, but the ProblemIR does.
    // For the runner-level API, we need the material. Use default for now.
    let material = MaterialParameters::new(800e3, 13e-12, 0.5).map_err(|e| RunError {
        message: format!("Material: {}", e),
    })?;

    let integrator = match plan.integrator {
        IntegratorChoice::Heun => TimeIntegrator::Heun,
    };

    let dynamics = LlgConfig::new(fullmag_engine::DEFAULT_GYROMAGNETIC_RATIO, integrator)
        .map_err(|e| RunError {
            message: format!("LLG: {}", e),
        })?;

    let problem = ExchangeLlgProblem::new(grid, cell_size, material, dynamics);

    let mut state = ExchangeLlgState::new(grid, plan.initial_magnetization.clone()).map_err(
        |e| RunError {
            message: format!("State: {}", e),
        },
    )?;

    let dt = plan.fixed_timestep.unwrap_or(1e-13);
    let mut steps: Vec<StepStats> = Vec::new();
    let mut step_count: u64 = 0;

    // Determine field output schedule
    let field_every = outputs
        .iter()
        .filter_map(|o| match o {
            OutputIR::Field { every_seconds, .. } => Some(*every_seconds),
            _ => None,
        })
        .next();

    let scalar_every = outputs
        .iter()
        .filter_map(|o| match o {
            OutputIR::Scalar { every_seconds, .. } => Some(*every_seconds),
            _ => None,
        })
        .next()
        .unwrap_or(dt * 10.0);

    let mut next_scalar_time = 0.0;
    let _next_field_time = 0.0;
    let _ = field_every; // Used in Phase 1 artifact writing

    while state.time_seconds < until_seconds {
        let wall_start = Instant::now();
        let report: StepReport = problem.step(&mut state, dt).map_err(|e| RunError {
            message: format!("Step {}: {}", step_count, e),
        })?;
        let wall_elapsed = wall_start.elapsed().as_nanos() as u64;

        step_count += 1;

        // Record scalar at schedule
        if state.time_seconds >= next_scalar_time {
            steps.push(StepStats {
                step: step_count,
                time: report.time_seconds,
                dt,
                e_ex: report.exchange_energy_joules,
                max_dm_dt: report.max_rhs_amplitude,
                max_h_eff: report.max_effective_field_amplitude,
                wall_time_ns: wall_elapsed,
            });
            next_scalar_time += scalar_every;
        }
    }

    // Always record the final step
    if steps.is_empty()
        || steps
            .last()
            .map(|s| (s.time - state.time_seconds).abs() > dt * 0.1)
            .unwrap_or(true)
    {
        let final_energy = problem.exchange_energy_from_vectors(state.magnetization());
        steps.push(StepStats {
            step: step_count,
            time: state.time_seconds,
            dt,
            e_ex: final_energy,
            max_dm_dt: 0.0,
            max_h_eff: 0.0,
            wall_time_ns: 0,
        });
    }

    Ok(RunResult {
        status: RunStatus::Completed,
        steps,
        final_magnetization: state.magnetization().to_vec(),
    })
}

// ----- artifact writing -----

fn write_artifacts(
    output_dir: &Path,
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    result: &RunResult,
) -> std::io::Result<()> {
    fs::create_dir_all(output_dir)?;

    // metadata.json
    let metadata = serde_json::json!({
        "problem_name": problem.problem_meta.name,
        "ir_version": problem.ir_version,
        "source_hash": problem.problem_meta.source_hash,
        "common_plan": plan.common,
        "provenance": plan.provenance,
        "engine_version": env!("CARGO_PKG_VERSION"),
        "status": result.status,
        "total_steps": result.steps.len(),
    });
    let metadata_path = output_dir.join("metadata.json");
    let mut f = fs::File::create(&metadata_path)?;
    f.write_all(serde_json::to_string_pretty(&metadata).unwrap().as_bytes())?;

    // scalars.csv
    let csv_path = output_dir.join("scalars.csv");
    let mut f = fs::File::create(&csv_path)?;
    writeln!(f, "step,time,dt,E_ex,max_dm_dt,max_H_eff,wall_time_ns")?;
    for s in &result.steps {
        writeln!(
            f,
            "{},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e},{}",
            s.step, s.time, s.dt, s.e_ex, s.max_dm_dt, s.max_h_eff, s.wall_time_ns
        )?;
    }

    // m_final.json
    let m_final_path = output_dir.join("m_final.json");
    let m_final_json = serde_json::to_string(&result.final_magnetization).unwrap();
    fs::write(&m_final_path, m_final_json)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_plan() -> FdmPlanIR {
        use fullmag_ir::{ExchangeBoundaryCondition, GridDimensions};

        FdmPlanIR {
            grid: GridDimensions { cells: [4, 4, 1] },
            cell_size: [2e-9, 2e-9, 2e-9],
            region_mask: vec![0; 16],
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 16],
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
        // Uniform m gives zero exchange energy
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
        use fullmag_ir::{ExchangeBoundaryCondition, GridDimensions};

        let random_m0 = fullmag_plan::generate_random_unit_vectors(42, 16);

        let plan = FdmPlanIR {
            grid: GridDimensions { cells: [4, 4, 1] },
            cell_size: [2e-9, 2e-9, 2e-9],
            region_mask: vec![0; 16],
            initial_magnetization: random_m0,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-14),
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
}
