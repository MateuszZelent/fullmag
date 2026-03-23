//! Reference FDM runner: executes a planned simulation via `fullmag-engine`.
//!
//! Module layout:
//! - `types`         — public and internal types
//! - `schedules`     — output scheduling logic
//! - `artifacts`     — metadata, CSV, field file writing
//! - `cpu_reference` — CPU reference execution path (calibration baseline)
//! - `dispatch`      — engine selection (CPU now, CUDA in Phase 2)

mod artifacts;
mod cpu_reference;
mod dispatch;
mod native_fdm;
mod schedules;
mod types;

// Public re-exports (unchanged API surface).
pub use types::{ExecutionProvenance, RunError, RunResult, RunStatus, StepStats};

use fullmag_ir::{BackendPlanIR, FdmPlanIR, OutputIR, ProblemIR};

use std::path::Path;

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

    let engine = dispatch::resolve_fdm_engine()?;
    let executed = dispatch::execute_fdm(engine, fdm, until_seconds, &plan.output_plan.outputs)?;

    if let Err(e) = artifacts::write_artifacts(output_dir, problem, &plan, &executed) {
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
    Ok(cpu_reference::execute_reference_fdm(plan, until_seconds, outputs)?.result)
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

        let executed = cpu_reference::execute_reference_fdm(&plan, 1e-12, &outputs)
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
