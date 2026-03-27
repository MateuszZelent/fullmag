//! Reference FDM runner: executes a planned simulation via `fullmag-engine`.
//!
//! Module layout:
//! - `types`         — public and internal types
//! - `schedules`     — output scheduling logic
//! - `artifacts`     — metadata, CSV, field file writing
//! - `cpu_reference` — CPU reference execution path (calibration baseline)
//! - `dispatch`      — engine selection (CPU now, CUDA in Phase 2)

mod artifacts;
pub mod artifact_pipeline;
mod cpu_reference;
mod dispatch;
mod fem_reference;
#[cfg(feature = "cuda")]
mod multilayer_cuda;
mod multilayer_reference;
mod native_fdm;
mod native_fem;
mod preview;
mod relaxation;
mod schedules;
mod types;

// Public re-exports (unchanged API surface).
pub use types::{
    ExecutionProvenance, FemMeshPayload, LivePreviewField, LivePreviewRequest, RunError, RunResult,
    RunStatus, RuntimeEngineInfo, StepAction, StepStats, StepUpdate,
};

use fullmag_ir::{BackendPlanIR, FdmMultilayerPlanIR, FdmPlanIR, OutputIR, ProblemIR};
use serde_json::Value;

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

    let cpu_threads = configured_cpu_threads(problem);
    let executed = with_cpu_parallelism(cpu_threads, || match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm(engine, fdm, until_seconds, &plan.output_plan.outputs)
        }
        BackendPlanIR::FdmMultilayer(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm_multilayer(engine, fdm, until_seconds, &plan.output_plan.outputs)
        }
        BackendPlanIR::Fem(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            dispatch::execute_fem(engine, fem, until_seconds, &plan.output_plan.outputs)
        }
    })?;

    if let Err(e) = artifacts::write_artifacts(output_dir, problem, &plan, &executed) {
        return Err(RunError {
            message: format!("Failed to write artifacts: {}", e),
        });
    }

    Ok(executed.result)
}

/// Run a problem with a per-step callback for live streaming.
///
/// The callback receives a `StepUpdate` after each simulation step and returns
/// `StepAction::Continue` to keep running or `StepAction::Stop` to cancel.
/// Magnetization data is included every `field_every_n` steps (default: 10).
pub fn run_problem_with_callback(
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let plan = fullmag_plan::plan(problem)?;

    let cpu_threads = configured_cpu_threads(problem);
    let executed = with_cpu_parallelism(cpu_threads, || match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let grid = fdm.grid.cells;
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm_with_callback(
                engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                grid,
                field_every_n,
                &mut on_step,
            )
        }
        BackendPlanIR::FdmMultilayer(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm_multilayer_with_callback(
                engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                &mut on_step,
            )
        }
        BackendPlanIR::Fem(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            dispatch::execute_fem_with_callback(
                engine,
                fem,
                until_seconds,
                &plan.output_plan.outputs,
                field_every_n,
                &mut on_step,
            )
        }
    })?;

    if let Err(e) = artifacts::write_artifacts(output_dir, problem, &plan, &executed) {
        return Err(RunError {
            message: format!("Failed to write artifacts: {}", e),
        });
    }

    // Emit final update with finished flag
    let final_stats = executed.result.steps.last().cloned().unwrap_or(StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
        ..StepStats::default()
    });
    let final_m: Vec<f64> = executed
        .result
        .final_magnetization
        .iter()
        .flat_map(|v| v.iter().copied())
        .collect();
    let final_grid = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
        BackendPlanIR::FdmMultilayer(fdm) => [
            fdm.common_cells[0],
            fdm.common_cells[1],
            fdm.common_cells[2],
        ],
        BackendPlanIR::Fem(_) => [0, 0, 0],
    };
    on_step(StepUpdate {
        stats: final_stats,
        grid: final_grid,
        fem_mesh: match &plan.backend_plan {
            BackendPlanIR::Fem(fem) => Some(FemMeshPayload {
                nodes: fem.mesh.nodes.clone(),
                elements: fem.mesh.elements.clone(),
                boundary_faces: fem.mesh.boundary_faces.clone(),
            }),
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
        },
        magnetization: match &plan.backend_plan {
            BackendPlanIR::Fdm(_) => Some(final_m),
            BackendPlanIR::FdmMultilayer(_) | BackendPlanIR::Fem(_) => None,
        },
        preview_field: None,
        finished: true,
    });

    Ok(executed.result)
}

/// Run a problem with a live-preview request provider.
///
/// The runner samples only the currently requested quantity instead of
/// streaming every available field.
pub fn run_problem_with_live_preview(
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    preview_request: &(dyn Fn() -> LivePreviewRequest + Send + Sync),
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let plan = fullmag_plan::plan(problem)?;

    let cpu_threads = configured_cpu_threads(problem);
    let executed = with_cpu_parallelism(cpu_threads, || match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let grid = fdm.grid.cells;
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm_with_live_preview(
                engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                grid,
                field_every_n,
                preview_request,
                &mut on_step,
            )
        }
        BackendPlanIR::FdmMultilayer(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm_multilayer_with_callback(
                engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                &mut on_step,
            )
        }
        BackendPlanIR::Fem(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            dispatch::execute_fem_with_live_preview(
                engine,
                fem,
                until_seconds,
                &plan.output_plan.outputs,
                field_every_n,
                preview_request,
                &mut on_step,
            )
        }
    })?;

    if let Err(e) = artifacts::write_artifacts(output_dir, problem, &plan, &executed) {
        return Err(RunError {
            message: format!("Failed to write artifacts: {}", e),
        });
    }

    let final_stats = executed.result.steps.last().cloned().unwrap_or(StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
        ..StepStats::default()
    });
    let final_grid = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
        BackendPlanIR::FdmMultilayer(fdm) => [
            fdm.common_cells[0],
            fdm.common_cells[1],
            fdm.common_cells[2],
        ],
        BackendPlanIR::Fem(_) => [0, 0, 0],
    };
    on_step(StepUpdate {
        stats: final_stats,
        grid: final_grid,
        fem_mesh: match &plan.backend_plan {
            BackendPlanIR::Fem(fem) => Some(FemMeshPayload {
                nodes: fem.mesh.nodes.clone(),
                elements: fem.mesh.elements.clone(),
                boundary_faces: fem.mesh.boundary_faces.clone(),
            }),
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
        },
        magnetization: None,
        preview_field: None,
        finished: true,
    });

    Ok(executed.result)
}

pub fn resolve_runtime_engine(problem: &ProblemIR) -> Result<RuntimeEngineInfo, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    match &plan.backend_plan {
        BackendPlanIR::Fdm(_) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            let (engine_id, engine_label, accelerator) = match engine {
                dispatch::FdmEngine::CpuReference => ("fdm_cpu_reference", "CPU FDM", "cpu"),
                dispatch::FdmEngine::CudaFdm => ("fdm_cuda", "CUDA FDM", "cuda"),
            };
            Ok(RuntimeEngineInfo {
                backend_family: "fdm".to_string(),
                engine_id: engine_id.to_string(),
                engine_label: engine_label.to_string(),
                accelerator: accelerator.to_string(),
            })
        }
        BackendPlanIR::FdmMultilayer(_) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            let (engine_id, engine_label, accelerator) = match engine {
                dispatch::FdmEngine::CpuReference => {
                    ("fdm_multilayer_cpu_reference", "CPU FDM Multilayer", "cpu")
                }
                dispatch::FdmEngine::CudaFdm => {
                    ("fdm_multilayer_cuda", "CUDA FDM Multilayer", "cuda")
                }
            };
            Ok(RuntimeEngineInfo {
                backend_family: "fdm_multilayer".to_string(),
                engine_id: engine_id.to_string(),
                engine_label: engine_label.to_string(),
                accelerator: accelerator.to_string(),
            })
        }
        BackendPlanIR::Fem(_) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            let (engine_id, engine_label, accelerator) = match engine {
                dispatch::FemEngine::CpuReference => ("fem_cpu_reference", "CPU FEM", "cpu"),
                dispatch::FemEngine::NativeGpu => ("fem_native_gpu", "Native FEM GPU", "gpu"),
            };
            Ok(RuntimeEngineInfo {
                backend_family: "fem".to_string(),
                engine_id: engine_id.to_string(),
                engine_label: engine_label.to_string(),
                accelerator: accelerator.to_string(),
            })
        }
    }
}

fn configured_cpu_threads(problem: &ProblemIR) -> usize {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
        .and_then(|selection| selection.get("cpu_threads"))
        .and_then(Value::as_u64)
        .map(|threads| threads as usize)
        .unwrap_or_else(default_cpu_threads)
}

fn default_cpu_threads() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| parallelism.get().saturating_sub(1).max(1))
        .unwrap_or(1)
}

fn with_cpu_parallelism<T>(
    cpu_threads: usize,
    f: impl FnOnce() -> Result<T, RunError> + Send,
) -> Result<T, RunError>
where
    T: Send,
{
    use std::sync::Mutex;
    static CACHED_POOL: Mutex<Option<(usize, rayon::ThreadPool)>> = Mutex::new(None);

    let mut guard = CACHED_POOL.lock().unwrap();
    let pool = match guard.as_ref() {
        Some((cached_threads, _)) if *cached_threads == cpu_threads => {
            // Reuse existing pool with matching thread count
            let (_, pool) = guard.as_ref().unwrap();
            return pool.install(f);
        }
        _ => {
            // Build a new pool (first call or thread count changed)
            let pool = rayon::ThreadPoolBuilder::new()
                .num_threads(cpu_threads)
                .build()
                .map_err(|error| RunError {
                    message: format!("failed to configure CPU thread pool: {error}"),
                })?;
            *guard = Some((cpu_threads, pool));
            let (_, pool) = guard.as_ref().unwrap();
            pool.install(f)
        }
    };
    pool
}

/// Execute a reference FDM plan without artifact writing.
pub fn run_reference_fdm(
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<RunResult, RunError> {
    Ok(cpu_reference::execute_reference_fdm(plan, until_seconds, outputs)?.result)
}

pub fn run_reference_multilayer_fdm(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<RunResult, RunError> {
    Ok(
        multilayer_reference::execute_reference_fdm_multilayer(plan, until_seconds, outputs)?
            .result,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FdmGridAssetIR, FdmMaterialIR,
        GeometryAssetsIR, GeometryEntryIR, GridDimensions, IntegratorChoice,
    };
    use serde_json::json;

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
            relaxation: None,
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
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
    fn default_cpu_threads_uses_max_minus_one_with_floor_one() {
        let expected = std::thread::available_parallelism()
            .map(|parallelism| parallelism.get().saturating_sub(1).max(1))
            .unwrap_or(1);
        assert_eq!(default_cpu_threads(), expected);
    }

    #[test]
    fn configured_cpu_threads_prefers_runtime_override() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            json!({
                "cpu_threads": 7,
            }),
        );
        assert_eq!(configured_cpu_threads(&problem), 7);
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn imported_geometry_fdm_cuda_matches_cpu_reference_when_cuda_is_available() {
        if !native_fdm::is_cuda_available() {
            eprintln!(
                "skipping imported-geometry CUDA parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.geometry.entries = vec![GeometryEntryIR::ImportedGeometry {
            name: "mesh".to_string(),
            source: "examples/nanoflower.stl".to_string(),
            format: "stl".to_string(),
            scale: fullmag_ir::ImportedGeometryScaleIR::Uniform(1.0),
        }];
        problem.regions[0].geometry = "mesh".to_string();
        problem.geometry_assets = Some(GeometryAssetsIR {
            fdm_grid_assets: vec![FdmGridAssetIR {
                geometry_name: "mesh".to_string(),
                cells: [4, 2, 1],
                cell_size: [2e-9, 2e-9, 2e-9],
                origin: [-4e-9, -2e-9, -1e-9],
                active_mask: vec![true, true, true, true, false, false, false, false],
            }],
            fem_mesh_assets: vec![],
        });
        problem.energy_terms = vec![
            fullmag_ir::EnergyTermIR::Exchange,
            fullmag_ir::EnergyTermIR::Demag { realization: None },
        ];
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            json!({
                "backend": "fdm",
                "device": "cuda",
                "gpu_count": 1,
                "execution_mode": "strict",
                "execution_precision": "double",
            }),
        );

        let plan = fullmag_plan::plan(&problem).expect("plan imported geometry");
        let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
            panic!("expected FDM plan");
        };

        let cpu = dispatch::execute_fdm(
            dispatch::FdmEngine::CpuReference,
            fdm,
            2e-13,
            &plan.output_plan.outputs,
        )
        .expect("cpu run");
        let cuda = dispatch::execute_fdm(
            dispatch::FdmEngine::CudaFdm,
            fdm,
            2e-13,
            &plan.output_plan.outputs,
        )
        .expect("cuda run");

        let cpu_final = cpu.result.steps.last().expect("cpu final step");
        let cuda_final = cuda.result.steps.last().expect("cuda final step");

        let e_total_rel = (cuda_final.e_total - cpu_final.e_total).abs() / cpu_final.e_total.abs();
        let e_demag_rel =
            (cuda_final.e_demag - cpu_final.e_demag).abs() / cpu_final.e_demag.abs().max(1e-30);
        let max_h_eff_rel =
            (cuda_final.max_h_eff - cpu_final.max_h_eff).abs() / cpu_final.max_h_eff.abs();

        assert!(
            e_total_rel < 1e-3,
            "imported geometry total energy drift too large: cpu={} cuda={} rel={}",
            cpu_final.e_total,
            cuda_final.e_total,
            e_total_rel
        );
        assert!(
            e_demag_rel < 1e-3,
            "imported geometry demag energy drift too large: cpu={} cuda={} rel={}",
            cpu_final.e_demag,
            cuda_final.e_demag,
            e_demag_rel
        );
        assert!(
            max_h_eff_rel < 1e-3,
            "imported geometry max|H_eff| drift too large: cpu={} cuda={} rel={}",
            cpu_final.max_h_eff,
            cuda_final.max_h_eff,
            max_h_eff_rel
        );

        assert_eq!(
            cpu.result.final_magnetization.len(),
            cuda.result.final_magnetization.len(),
            "final magnetization length mismatch"
        );
        for (index, (cpu_m, cuda_m)) in cpu
            .result
            .final_magnetization
            .iter()
            .zip(cuda.result.final_magnetization.iter())
            .enumerate()
        {
            let err = ((cpu_m[0] - cuda_m[0]).abs())
                .max((cpu_m[1] - cuda_m[1]).abs())
                .max((cpu_m[2] - cuda_m[2]).abs());
            assert!(
                err < 5e-4,
                "final magnetization drift too large at cell {index}: cpu={:?} cuda={:?}",
                cpu_m,
                cuda_m
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
