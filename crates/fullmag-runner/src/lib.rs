//! Reference FDM runner: executes a planned simulation via `fullmag-engine`.
//!
//! Module layout:
//! - `types`         — public and internal types
//! - `schedules`     — output scheduling logic
//! - `artifacts`     — metadata, CSV, field file writing
//! - `cpu_reference` — CPU reference execution path (calibration baseline)
//! - `dispatch`      — engine selection (CPU now, CUDA in Phase 2)

/// Vacuum permeability μ₀ in T·m/A.
pub const MU0: f64 = 4.0 * std::f64::consts::PI * 1e-7;

mod antenna_fields;
pub mod artifact_pipeline;
mod artifacts;
pub mod capabilities;
mod cpu_reference;
mod dispatch;
pub mod eigen;
mod fem_eigen;
mod fem_reference;
pub mod interactive;
mod interactive_runtime;
#[cfg(feature = "cuda")]
mod multilayer_cuda;
mod multilayer_reference;
mod native_fdm;
mod native_fem;
mod preview;
pub mod quantities;
mod relaxation;
pub mod runtime_registry;
mod scalar_metrics;
mod schedules;
mod types;

// ── Shared runner defaults (FEM-040) ─────────────────────────────────────
/// Default maximum timestep for adaptive stepping when the user provides none.
const DEFAULT_ADAPTIVE_DT_MAX: f64 = 1e-10;
/// Default initial timestep seed when adaptive stepping is enabled but no
/// meaningful `dt_initial` was provided.
pub(crate) const DEFAULT_ADAPTIVE_DT_INITIAL: f64 = 1e-13;

pub(crate) fn resolve_initial_timestep(
    fixed_timestep: Option<f64>,
    adaptive_timestep: Option<&fullmag_ir::AdaptiveTimeStepIR>,
) -> Option<f64> {
    fixed_timestep.or_else(|| {
        adaptive_timestep.map(|adaptive| {
            adaptive
                .dt_initial
                .filter(|dt_initial| (*dt_initial - adaptive.dt_min).abs() > f64::EPSILON)
                .unwrap_or(DEFAULT_ADAPTIVE_DT_INITIAL)
        })
    })
}

// Public re-exports (unchanged API surface).
pub use capabilities::{BackendCapabilities, RuntimeEngineId};
pub use interactive::backend::BackendGeometry;
pub use interactive::checkpoints::RunOutcome;
pub use interactive::commands::{
    parse_session_command, LiveControlCommand, RuntimeControlOutcome, SequenceStage,
};
pub use interactive::display::{
    DisplayKind, DisplayPayload, DisplaySelection, DisplaySelectionState,
};
pub use interactive::events::{
    CommandAckEvent, CommandCompletedEvent, CommandRejectedEvent, DisplayUpdatedEvent,
    MeshCommandTargetEvent, RuntimeEventEnvelope, RuntimeStatus, RuntimeStatusChangedEvent,
    StepDeltaEvent,
};
pub use interactive::runtime::InteractiveRuntime;
pub use interactive_runtime::{InteractiveFdmPreviewRuntime, InteractiveFemPreviewRuntime};
pub use runtime_registry::{
    EngineAvailabilityStatus, HostCapabilityMatrix, HostEngineEntry, RuntimeManifest,
    RuntimeRegistry,
};
pub use types::{
    ExecutionProvenance, FemEigenRunResult, FemMeshObjectSegment, FemMeshPartPayload,
    FemMeshPayload, LivePreviewField, LivePreviewRequest, LiveVectorFieldSnapshot,
    ResolvedFallback, RunError, RunResult, RunStatus, RuntimeEngineInfo, StepAction, StepStats,
    StepUpdate,
};

use crate::capabilities::{capabilities_for_fdm_engine, capabilities_for_fem_engine};
use fullmag_ir::{BackendPlanIR, FdmMultilayerPlanIR, FdmPlanIR, OutputIR, ProblemIR};
use interactive::InteractiveBackend;
use serde_json::Value;

use std::path::Path;

#[derive(Debug, Clone)]
pub struct ResolvedSessionRuntime {
    pub resolved_backend: String,
    pub resolved_device: String,
    pub resolved_precision: String,
    pub resolved_mode: String,
    pub resolved_runtime_family: Option<String>,
    pub resolved_engine_id: Option<String>,
    pub resolved_worker: Option<String>,
    pub resolved_fallback: Option<ResolvedFallback>,
}

fn explicit_selection_from_problem(problem: &ProblemIR) -> bool {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
        .and_then(|selection| selection.get("explicit_selection"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[cfg(test)]
mod initial_timestep_tests {
    use super::resolve_initial_timestep;

    #[test]
    fn resolve_initial_timestep_prefers_fixed_value() {
        let adaptive = fullmag_ir::AdaptiveTimeStepIR {
            atol: 1e-6,
            rtol: 1e-3,
            dt_initial: Some(5e-14),
            dt_min: 1e-15,
            dt_max: None,
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: None,
            norm_tolerance: None,
        };
        assert_eq!(
            resolve_initial_timestep(Some(2e-13), Some(&adaptive)),
            Some(2e-13)
        );
    }

    #[test]
    fn resolve_initial_timestep_uses_adaptive_seed_when_meaningful() {
        let adaptive = fullmag_ir::AdaptiveTimeStepIR {
            atol: 1e-6,
            rtol: 1e-3,
            dt_initial: Some(5e-14),
            dt_min: 1e-15,
            dt_max: None,
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: None,
            norm_tolerance: None,
        };
        assert_eq!(resolve_initial_timestep(None, Some(&adaptive)), Some(5e-14));
    }

    #[test]
    fn resolve_initial_timestep_falls_back_when_seed_matches_dt_min() {
        let adaptive = fullmag_ir::AdaptiveTimeStepIR {
            atol: 1e-6,
            rtol: 1e-3,
            dt_initial: Some(1e-15),
            dt_min: 1e-15,
            dt_max: None,
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: None,
            norm_tolerance: None,
        };
        assert_eq!(resolve_initial_timestep(None, Some(&adaptive)), Some(1e-13));
    }

    #[test]
    fn resolve_initial_timestep_falls_back_when_seed_missing() {
        let adaptive = fullmag_ir::AdaptiveTimeStepIR {
            atol: 1e-6,
            rtol: 1e-3,
            dt_initial: None,
            dt_min: 1e-15,
            dt_max: None,
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: None,
            norm_tolerance: None,
        };
        assert_eq!(resolve_initial_timestep(None, Some(&adaptive)), Some(1e-13));
    }
}

pub fn is_native_fdm_cuda_available() -> bool {
    native_fdm::is_cuda_available()
}

pub fn is_native_fem_gpu_available() -> bool {
    native_fem::is_gpu_available()
}

/// Plan and run a problem, writing artifacts to `output_dir`.
///
/// This is the top-level entry point: ProblemIR → plan → execute → artifacts.
pub fn run_problem(
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
) -> Result<RunResult, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start(
        output_dir.to_path_buf(),
        artifacts::build_field_context(problem, &plan),
        artifact_pipeline::DEFAULT_ARTIFACT_PIPELINE_CAPACITY,
    )?;
    let artifact_writer = Some(artifact_pipeline.sender());

    let cpu_threads = configured_cpu_threads(problem);
    let executed_result = with_cpu_parallelism(cpu_threads, || match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm(
                engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                None,
                artifact_writer.clone(),
            )
        }
        BackendPlanIR::FdmMultilayer(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm_multilayer(
                engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                None,
                artifact_writer.clone(),
            )
        }
        BackendPlanIR::Fem(fem) => {
            let engine = dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem)?.engine;
            dispatch::execute_fem(
                engine,
                fem,
                until_seconds,
                &plan.output_plan.outputs,
                None,
                artifact_writer.clone(),
            )
        }
        BackendPlanIR::FemEigen(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            dispatch::execute_fem_eigen(engine, fem, &plan.output_plan.outputs)
        }
    });
    let pipeline_summary = artifact_pipeline.finish();
    let executed = match executed_result {
        Ok(executed) => executed,
        Err(error) => {
            if let Err(writer_error) = pipeline_summary {
                return Err(RunError {
                    message: format!(
                        "{}\nartifact pipeline shutdown also failed: {}",
                        error.message, writer_error.message
                    ),
                });
            }
            return Err(error);
        }
    };
    let pipeline_summary = pipeline_summary?;

    if let Err(e) = artifacts::write_artifacts(
        output_dir,
        problem,
        &plan,
        &executed,
        Some(&pipeline_summary),
    ) {
        return Err(RunError {
            message: format!("Failed to write artifacts: {}", e),
        });
    }

    Ok(executed.result)
}

pub fn fem_observables_for_magnetization(
    plan: &fullmag_ir::FemPlanIR,
    magnetization: &[[f64; 3]],
) -> Result<fullmag_engine::EffectiveFieldObservables, RunError> {
    fem_reference::fem_observables_for_magnetization(plan, magnetization)
}

/// Run a problem with a per-step callback for live streaming.
///
/// The callback receives a `StepUpdate` after each simulation step and returns
/// `StepAction::Continue` to keep running or `StepAction::Stop` to cancel.
/// Heavy live payloads such as magnetization snapshots are included every
/// `field_every_n` steps.
pub fn run_problem_with_callback(
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start(
        output_dir.to_path_buf(),
        artifacts::build_field_context(problem, &plan),
        artifact_pipeline::DEFAULT_ARTIFACT_PIPELINE_CAPACITY,
    )?;
    let artifact_writer = Some(artifact_pipeline.sender());

    let cpu_threads = configured_cpu_threads(problem);
    let executed_result = with_cpu_parallelism(cpu_threads, || match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let grid = fdm.grid.cells;
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm(
                engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                Some(types::LiveStepConsumer {
                    grid,
                    field_every_n,
                    display_selection: None,
                    interrupt_requested: None,
                    on_step: &mut on_step,
                }),
                artifact_writer.clone(),
            )
        }
        BackendPlanIR::FdmMultilayer(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm_multilayer(
                engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                Some((
                    &fdm.common_cells,
                    &mut on_step as &mut dyn FnMut(StepUpdate) -> StepAction,
                )),
                artifact_writer.clone(),
            )
        }
        BackendPlanIR::Fem(fem) => {
            let engine = dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem)?.engine;
            dispatch::execute_fem(
                engine,
                fem,
                until_seconds,
                &plan.output_plan.outputs,
                Some(types::LiveStepConsumer {
                    grid: [0, 0, 0],
                    field_every_n,
                    display_selection: None,
                    interrupt_requested: None,
                    on_step: &mut on_step,
                }),
                artifact_writer.clone(),
            )
        }
        BackendPlanIR::FemEigen(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            dispatch::execute_fem_eigen(engine, fem, &plan.output_plan.outputs)
        }
    });
    let pipeline_summary = artifact_pipeline.finish();
    let executed = match executed_result {
        Ok(executed) => executed,
        Err(error) => {
            if let Err(writer_error) = pipeline_summary {
                return Err(RunError {
                    message: format!(
                        "{}\nartifact pipeline shutdown also failed: {}",
                        error.message, writer_error.message
                    ),
                });
            }
            return Err(error);
        }
    };
    let pipeline_summary = pipeline_summary?;

    if let Err(e) = artifacts::write_artifacts(
        output_dir,
        problem,
        &plan,
        &executed,
        Some(&pipeline_summary),
    ) {
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
        e_ani: 0.0,
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
        BackendPlanIR::Fem(_) | BackendPlanIR::FemEigen(_) => [0, 0, 0],
    };
    on_step(StepUpdate {
        stats: final_stats,
        grid: final_grid,
        fem_mesh: match &plan.backend_plan {
            BackendPlanIR::Fem(fem) => Some(FemMeshPayload::from(fem)),
            BackendPlanIR::FemEigen(eigen) => Some(FemMeshPayload::from(eigen)),
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
        },
        magnetization: match &plan.backend_plan {
            BackendPlanIR::Fdm(_) => Some(final_m),
            BackendPlanIR::FdmMultilayer(_)
            | BackendPlanIR::Fem(_)
            | BackendPlanIR::FemEigen(_) => None,
        },
        preview_field: None,
        cached_preview_fields: None,
        scalar_row_due: true,
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
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    run_problem_with_live_preview_interruptible(
        problem,
        until_seconds,
        output_dir,
        field_every_n,
        display_selection,
        None,
        &mut on_step,
    )
}

pub fn run_problem_with_live_preview_interruptible(
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start(
        output_dir.to_path_buf(),
        artifacts::build_field_context(problem, &plan),
        artifact_pipeline::DEFAULT_ARTIFACT_PIPELINE_CAPACITY,
    )?;
    let artifact_writer = Some(artifact_pipeline.sender());

    let cpu_threads = configured_cpu_threads(problem);
    let executed_result = with_cpu_parallelism(cpu_threads, || match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let grid = fdm.grid.cells;
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm(
                engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                Some(types::LiveStepConsumer {
                    grid,
                    field_every_n,
                    display_selection: Some(display_selection),
                    interrupt_requested,
                    on_step: &mut on_step,
                }),
                artifact_writer.clone(),
            )
        }
        BackendPlanIR::FdmMultilayer(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::execute_fdm_multilayer(
                engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                Some((
                    &fdm.common_cells,
                    &mut on_step as &mut dyn FnMut(StepUpdate) -> StepAction,
                )),
                artifact_writer.clone(),
            )
        }
        BackendPlanIR::Fem(fem) => {
            let resolution = dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem)?;
            eprintln!(
                "[fullmag-runner] live FEM engine: resolved_engine_id={} fallback={:?}",
                dispatch::fem_engine_label(resolution.engine),
                resolution.fallback.as_ref().map(|f| &f.reason),
            );
            dispatch::execute_fem(
                resolution.engine,
                fem,
                until_seconds,
                &plan.output_plan.outputs,
                Some(types::LiveStepConsumer {
                    grid: [0, 0, 0],
                    field_every_n,
                    display_selection: Some(display_selection),
                    interrupt_requested,
                    on_step: &mut on_step,
                }),
                artifact_writer.clone(),
            )
        }
        BackendPlanIR::FemEigen(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            dispatch::execute_fem_eigen(engine, fem, &plan.output_plan.outputs)
        }
    });
    let pipeline_summary = artifact_pipeline.finish();
    let executed = match executed_result {
        Ok(executed) => executed,
        Err(error) => {
            if let Err(writer_error) = pipeline_summary {
                return Err(RunError {
                    message: format!(
                        "{}\nartifact pipeline shutdown also failed: {}",
                        error.message, writer_error.message
                    ),
                });
            }
            return Err(error);
        }
    };
    let pipeline_summary = pipeline_summary?;

    if let Err(e) = artifacts::write_artifacts(
        output_dir,
        problem,
        &plan,
        &executed,
        Some(&pipeline_summary),
    ) {
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
        e_ani: 0.0,
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
        BackendPlanIR::Fem(_) | BackendPlanIR::FemEigen(_) => [0, 0, 0],
    };
    on_step(StepUpdate {
        stats: final_stats,
        grid: final_grid,
        fem_mesh: match &plan.backend_plan {
            BackendPlanIR::Fem(fem) => Some(FemMeshPayload::from(fem)),
            BackendPlanIR::FemEigen(eigen) => Some(FemMeshPayload::from(eigen)),
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => None,
        },
        magnetization: None,
        preview_field: None,
        cached_preview_fields: None,
        scalar_row_due: true,
        finished: true,
    });

    Ok(executed.result)
}

/// Run an FDM problem using a persistent interactive runtime for low-latency
/// live preview and interactive follow-up commands.
pub fn run_problem_with_interactive_fdm_runtime_live_preview(
    runtime: &mut InteractiveFdmPreviewRuntime,
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    run_problem_with_interactive_fdm_runtime_live_preview_interruptible(
        runtime,
        problem,
        until_seconds,
        output_dir,
        field_every_n,
        display_selection,
        None,
        &mut on_step,
    )
}

pub fn run_problem_with_interactive_fdm_runtime_live_preview_interruptible(
    runtime: &mut InteractiveFdmPreviewRuntime,
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
        return Err(RunError {
            message:
                "interactive FDM runtime execute path requires a single-layer FDM execution plan"
                    .to_string(),
        });
    };

    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start(
        output_dir.to_path_buf(),
        artifacts::build_field_context(problem, &plan),
        artifact_pipeline::DEFAULT_ARTIFACT_PIPELINE_CAPACITY,
    )?;
    let artifact_writer = Some(artifact_pipeline.sender());

    let executed_result = runtime.execute_with_live_preview_streaming(
        fdm,
        until_seconds,
        &plan.output_plan.outputs,
        fdm.grid.cells,
        field_every_n,
        display_selection,
        interrupt_requested,
        artifact_writer,
        &mut on_step,
    );
    let pipeline_summary = artifact_pipeline.finish();
    let executed = match executed_result {
        Ok(executed) => executed,
        Err(error) => {
            if let Err(writer_error) = pipeline_summary {
                return Err(RunError {
                    message: format!(
                        "{}\nartifact pipeline shutdown also failed: {}",
                        error.message, writer_error.message
                    ),
                });
            }
            return Err(error);
        }
    };
    let pipeline_summary = pipeline_summary?;

    if let Err(error) = artifacts::write_artifacts(
        output_dir,
        problem,
        &plan,
        &executed,
        Some(&pipeline_summary),
    ) {
        return Err(RunError {
            message: format!("Failed to write artifacts: {}", error),
        });
    }

    let final_stats = executed.result.steps.last().cloned().unwrap_or(StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_ani: 0.0,
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
        .flat_map(|vector| vector.iter().copied())
        .collect();
    on_step(StepUpdate {
        stats: final_stats,
        grid: fdm.grid.cells,
        fem_mesh: None,
        magnetization: Some(final_m),
        preview_field: None,
        cached_preview_fields: None,
        scalar_row_due: true,
        finished: true,
    });

    Ok(executed.result)
}

/// Run a FEM problem using a persistent interactive runtime for low-latency
/// live preview and interactive follow-up commands.
pub fn run_problem_with_interactive_fem_runtime_live_preview(
    runtime: &mut InteractiveFemPreviewRuntime,
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    run_problem_with_interactive_fem_runtime_live_preview_interruptible(
        runtime,
        problem,
        until_seconds,
        output_dir,
        field_every_n,
        display_selection,
        None,
        &mut on_step,
    )
}

pub fn run_problem_with_interactive_fem_runtime_live_preview_interruptible(
    runtime: &mut InteractiveFemPreviewRuntime,
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
        return Err(RunError {
            message: "interactive FEM runtime execute path requires a FEM execution plan"
                .to_string(),
        });
    };

    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start(
        output_dir.to_path_buf(),
        artifacts::build_field_context(problem, &plan),
        artifact_pipeline::DEFAULT_ARTIFACT_PIPELINE_CAPACITY,
    )?;
    let artifact_writer = Some(artifact_pipeline.sender());

    let executed_result = runtime.execute_with_live_preview_streaming(
        fem,
        until_seconds,
        &plan.output_plan.outputs,
        field_every_n,
        artifact_writer,
        display_selection,
        interrupt_requested,
        &mut on_step,
    );
    let pipeline_summary = artifact_pipeline.finish();
    let executed = match executed_result {
        Ok(executed) => executed,
        Err(error) => {
            if let Err(writer_error) = pipeline_summary {
                return Err(RunError {
                    message: format!(
                        "{}\nartifact pipeline shutdown also failed: {}",
                        error.message, writer_error.message
                    ),
                });
            }
            return Err(error);
        }
    };
    let pipeline_summary = pipeline_summary?;

    if let Err(error) = artifacts::write_artifacts(
        output_dir,
        problem,
        &plan,
        &executed,
        Some(&pipeline_summary),
    ) {
        return Err(RunError {
            message: format!("Failed to write artifacts: {}", error),
        });
    }

    let final_stats = executed.result.steps.last().cloned().unwrap_or(StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_ani: 0.0,
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
        ..StepStats::default()
    });
    on_step(StepUpdate {
        stats: final_stats,
        grid: [0, 0, 0],
        fem_mesh: Some(FemMeshPayload::from(fem)),
        magnetization: Some(
            executed
                .result
                .final_magnetization
                .iter()
                .flat_map(|vector| vector.iter().copied())
                .collect(),
        ),
        preview_field: None,
        cached_preview_fields: None,
        scalar_row_due: true,
        finished: true,
    });

    Ok(executed.result)
}

// ---------------------------------------------------------------------------
// Unified InteractiveRuntime API (new)
// ---------------------------------------------------------------------------

/// Create a unified `InteractiveRuntime` for the given problem.
///
/// Automatically selects FDM or FEM backend based on the execution plan.
/// If `continuation_magnetization` is provided, it is uploaded into the backend.
pub fn create_interactive_runtime(
    problem: &ProblemIR,
    continuation_magnetization: Option<&[[f64; 3]]>,
) -> Result<InteractiveRuntime, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    let backend: Box<dyn InteractiveBackend> = match &plan.backend_plan {
        BackendPlanIR::Fdm(_) => Box::new(InteractiveFdmPreviewRuntime::create(problem)?),
        BackendPlanIR::Fem(_) => Box::new(InteractiveFemPreviewRuntime::create(problem)?),
        _ => {
            return Err(RunError {
                message: "interactive runtime requires FDM or FEM execution plan".to_string(),
            });
        }
    };
    let mut runtime = InteractiveRuntime::new(backend);
    if let Some(magnetization) = continuation_magnetization {
        runtime.upload_magnetization(magnetization)?;
    }
    Ok(runtime)
}

/// Run a problem using a unified `InteractiveRuntime` with live preview.
///
/// This replaces the separate `run_problem_with_interactive_fdm_runtime_live_preview`
/// and `run_problem_with_interactive_fem_runtime_live_preview` functions.
pub fn run_problem_with_interactive_runtime_live_preview(
    runtime: &mut InteractiveRuntime,
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    run_problem_with_interactive_runtime_live_preview_interruptible(
        runtime,
        problem,
        until_seconds,
        output_dir,
        field_every_n,
        display_selection,
        None,
        on_step,
    )
}

pub fn run_problem_with_interactive_runtime_live_preview_interruptible(
    runtime: &mut InteractiveRuntime,
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    runtime.execute_streaming(
        problem,
        until_seconds,
        output_dir,
        field_every_n,
        display_selection,
        interrupt_requested,
        on_step,
    )
}

pub fn snapshot_problem_preview(
    problem: &ProblemIR,
    request: &LivePreviewRequest,
) -> Result<LivePreviewField, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::snapshot_fdm_preview(engine, fdm, request)
        }
        BackendPlanIR::FdmMultilayer(_) => Err(RunError {
            message:
                "interactive preview snapshot is not supported for FDM multilayer backends yet"
                    .to_string(),
        }),
        BackendPlanIR::Fem(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            dispatch::snapshot_fem_preview(engine, fem, request)
        }
        BackendPlanIR::FemEigen(_) => Err(RunError {
            message: "interactive preview snapshot is not supported for FEM eigenmode plans"
                .to_string(),
        }),
    }
}

pub fn snapshot_problem_vector_fields(
    problem: &ProblemIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<LivePreviewField>, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let engine = dispatch::resolve_fdm_engine(problem)?;
            dispatch::snapshot_fdm_vector_fields(engine, fdm, quantities, request)
        }
        BackendPlanIR::FdmMultilayer(_) => Err(RunError {
            message:
                "interactive vector-field cache is not supported for FDM multilayer backends yet"
                    .to_string(),
        }),
        BackendPlanIR::Fem(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            dispatch::snapshot_fem_vector_fields(engine, fem, quantities, request)
        }
        BackendPlanIR::FemEigen(_) => Err(RunError {
            message: "interactive vector-field snapshots are not supported for FEM eigenmode plans"
                .to_string(),
        }),
    }
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
            let engine = dispatch::resolve_fem_engine_with_trail(problem)?.engine;
            let (engine_id, engine_label, accelerator) = match engine {
                dispatch::FemEngine::CpuReference => ("fem_cpu_reference", "CPU FEM", "cpu"),
                dispatch::FemEngine::NativeGpu => ("fem_native_gpu", "GPU FEM", "gpu"),
            };
            Ok(RuntimeEngineInfo {
                backend_family: "fem".to_string(),
                engine_id: engine_id.to_string(),
                engine_label: engine_label.to_string(),
                accelerator: accelerator.to_string(),
            })
        }
        BackendPlanIR::FemEigen(_) => {
            let engine = dispatch::resolve_fem_engine_with_trail(problem)?.engine;
            let (engine_id, engine_label, accelerator) = match engine {
                dispatch::FemEngine::CpuReference => {
                    ("fem_eigen_cpu_reference", "CPU FEM Eigen", "cpu")
                }
                dispatch::FemEngine::NativeGpu => ("fem_eigen_native_gpu", "GPU FEM Eigen", "gpu"),
            };
            Ok(RuntimeEngineInfo {
                backend_family: "fem_eigen".to_string(),
                engine_id: engine_id.to_string(),
                engine_label: engine_label.to_string(),
                accelerator: accelerator.to_string(),
            })
        }
    }
}

pub fn resolve_runtime_capabilities(problem: &ProblemIR) -> Result<BackendCapabilities, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    match &plan.backend_plan {
        BackendPlanIR::Fdm(_) => Ok(capabilities_for_fdm_engine(
            dispatch::resolve_fdm_engine_with_trail(problem)?.engine,
        )),
        BackendPlanIR::Fem(fem) => Ok(capabilities_for_fem_engine(
            dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem)?.engine,
        )),
        BackendPlanIR::FdmMultilayer(_) => Ok(capabilities_for_fdm_engine(
            dispatch::resolve_fdm_engine_with_trail(problem)?.engine,
        )),
        BackendPlanIR::FemEigen(_) => Ok(capabilities_for_fem_engine(
            dispatch::resolve_fem_engine_with_trail(problem)?.engine,
        )),
    }
}

pub fn resolve_session_runtime(problem: &ProblemIR) -> Result<ResolvedSessionRuntime, RunError> {
    resolve_session_runtime_with_registry(problem, None)
}

pub fn resolve_session_runtime_with_registry(
    problem: &ProblemIR,
    registry: Option<&RuntimeRegistry>,
) -> Result<ResolvedSessionRuntime, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    let requested_mode = match problem.validation_profile.execution_mode {
        fullmag_ir::ExecutionMode::Strict => "strict".to_string(),
        fullmag_ir::ExecutionMode::Extended => "extended".to_string(),
        fullmag_ir::ExecutionMode::Hybrid => "hybrid".to_string(),
    };
    let dispatch_resolution = dispatch::resolve_with_registry(
        problem,
        registry,
        explicit_selection_from_problem(problem),
    )?;

    match (&plan.backend_plan, dispatch_resolution.engine) {
        (BackendPlanIR::Fdm(_), dispatch::DispatchEngine::Fdm(engine)) => {
            let (default_family, engine_id, default_worker) = match engine {
                dispatch::FdmEngine::CpuReference => (
                    "cpu-reference",
                    "fdm_cpu_reference",
                    "../../bin/fullmag-bin",
                ),
                dispatch::FdmEngine::CudaFdm => {
                    ("fdm-cuda", "fdm_cuda", "bin/fullmag-fdm-cuda-bin")
                }
            };
            Ok(ResolvedSessionRuntime {
                resolved_backend: dispatch_resolution.resolved_backend,
                resolved_device: dispatch_resolution.resolved_device,
                resolved_precision: dispatch_resolution.resolved_precision,
                resolved_mode: requested_mode,
                resolved_runtime_family: Some(
                    dispatch_resolution
                        .runtime_family
                        .unwrap_or_else(|| default_family.to_string()),
                ),
                resolved_engine_id: Some(engine_id.to_string()),
                resolved_worker: Some(
                    dispatch_resolution
                        .worker
                        .unwrap_or_else(|| default_worker.to_string()),
                ),
                resolved_fallback: dispatch_resolution.fallback,
            })
        }
        (BackendPlanIR::FdmMultilayer(_), dispatch::DispatchEngine::Fdm(engine)) => {
            let (default_family, engine_id, default_worker) = match engine {
                dispatch::FdmEngine::CpuReference => (
                    "cpu-reference",
                    "fdm_multilayer_cpu_reference",
                    "../../bin/fullmag-bin",
                ),
                dispatch::FdmEngine::CudaFdm => (
                    "fdm-cuda",
                    "fdm_multilayer_cuda",
                    "bin/fullmag-fdm-cuda-bin",
                ),
            };
            Ok(ResolvedSessionRuntime {
                resolved_backend: dispatch_resolution.resolved_backend,
                resolved_device: dispatch_resolution.resolved_device,
                resolved_precision: dispatch_resolution.resolved_precision,
                resolved_mode: requested_mode,
                resolved_runtime_family: Some(
                    dispatch_resolution
                        .runtime_family
                        .unwrap_or_else(|| default_family.to_string()),
                ),
                resolved_engine_id: Some(engine_id.to_string()),
                resolved_worker: Some(
                    dispatch_resolution
                        .worker
                        .unwrap_or_else(|| default_worker.to_string()),
                ),
                resolved_fallback: dispatch_resolution.fallback,
            })
        }
        (BackendPlanIR::Fem(_), dispatch::DispatchEngine::Fem(engine))
        | (BackendPlanIR::FemEigen(_), dispatch::DispatchEngine::Fem(engine)) => {
            let (default_family, engine_id, default_worker) = match engine {
                dispatch::FemEngine::CpuReference => (
                    "cpu-reference",
                    "fem_cpu_reference",
                    "../../bin/fullmag-bin",
                ),
                dispatch::FemEngine::NativeGpu => {
                    ("fem-gpu", "fem_native_gpu", "bin/fullmag-fem-gpu-bin")
                }
            };
            Ok(ResolvedSessionRuntime {
                resolved_backend: dispatch_resolution.resolved_backend,
                resolved_device: dispatch_resolution.resolved_device,
                resolved_precision: dispatch_resolution.resolved_precision,
                resolved_mode: requested_mode,
                resolved_runtime_family: Some(
                    dispatch_resolution
                        .runtime_family
                        .unwrap_or_else(|| default_family.to_string()),
                ),
                resolved_engine_id: Some(engine_id.to_string()),
                resolved_worker: Some(
                    dispatch_resolution
                        .worker
                        .unwrap_or_else(|| default_worker.to_string()),
                ),
                resolved_fallback: dispatch_resolution.fallback,
            })
        }
        _ => Err(RunError {
            message:
                "runtime registry resolved an engine family incompatible with the planned backend"
                    .to_string(),
        }),
    }
}

fn configured_cpu_threads(problem: &ProblemIR) -> usize {
    // 1. Explicit per-problem setting from runtime_metadata
    let from_problem = problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
        .and_then(|selection| selection.get("cpu_threads"))
        .and_then(Value::as_u64)
        .map(|threads| threads as usize);
    if let Some(threads) = from_problem {
        return threads;
    }
    // 2. Environment variable override
    if let Some(threads) = env_cpu_threads() {
        return threads;
    }
    // 3. Default: all available cores
    default_cpu_threads()
}

/// Read thread count from `FULLMAG_CPU_THREADS` (or `RAYON_NUM_THREADS` as fallback).
fn env_cpu_threads() -> Option<usize> {
    std::env::var("FULLMAG_CPU_THREADS")
        .ok()
        .or_else(|| std::env::var("RAYON_NUM_THREADS").ok())
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|&threads| threads >= 1)
}

fn default_cpu_threads() -> usize {
    std::thread::available_parallelism()
        .map(|parallelism| parallelism.get())
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
    Ok(cpu_reference::execute_reference_fdm(plan, until_seconds, outputs, None, None)?.result)
}

pub fn run_reference_multilayer_fdm(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<RunResult, RunError> {
    Ok(multilayer_reference::execute_reference_fdm_multilayer(
        plan,
        until_seconds,
        outputs,
        None,
        None,
    )?
    .result)
}

/// Run a FEM eigenmode analysis on the CPU reference engine.
///
/// Returns a [`types::FemEigenRunResult`] with the solver status and all artifact
/// files (spectrum JSON, mode JSONs) produced during the solve.
pub fn run_reference_fem_eigen(
    plan: &fullmag_ir::FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<types::FemEigenRunResult, RunError> {
    let executed = fem_eigen::execute_reference_fem_eigen(plan, outputs)?;
    Ok(types::FemEigenRunResult {
        status: executed.result.status,
        artifacts: executed
            .auxiliary_artifacts
            .into_iter()
            .map(|a| (a.relative_path, a.bytes))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, GridDimensions,
        IntegratorChoice, MeshIR,
    };
    #[cfg(feature = "cuda")]
    use fullmag_ir::{FdmGridAssetIR, GeometryAssetsIR, GeometryEntryIR};
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

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
                ..Default::default()
            },
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-14),
            adaptive_timestep: None,
            relaxation: None,
            boundary_correction: None,
            boundary_geometry: None,
            inter_region_exchange: vec![],
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            temperature: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            ..Default::default()
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
    fn default_cpu_threads_uses_all_available() {
        let expected = std::thread::available_parallelism()
            .map(|parallelism| parallelism.get())
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
            fem_domain_mesh_asset: None,
        });
        problem.energy_terms = vec![
            fullmag_ir::EnergyTermIR::Exchange,
            fullmag_ir::EnergyTermIR::Demag {
                realization: fullmag_ir::RequestedFemDemagIR::Auto,
            },
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
    fn run_problem_streams_artifacts_and_preserves_layout() {
        let problem = fullmag_ir::ProblemIR::bootstrap_example();
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-artifacts-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = run_problem(&problem, 2e-13, &output_dir).expect("run_problem should succeed");
        assert_eq!(result.status, RunStatus::Completed);
        assert!(output_dir.join("scalars.csv").is_file());
        assert!(output_dir.join("m_initial.json").is_file());
        assert!(output_dir.join("m_final.json").is_file());
        assert!(output_dir.join("fields/m/step_000000.json").is_file());
        assert!(output_dir.join("fields/H_ex/step_000000.json").is_file());

        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json"))
                .expect("metadata.json should be readable"),
        )
        .expect("metadata should parse");
        assert_eq!(metadata["field_snapshots"].as_u64(), Some(4));
        assert_eq!(metadata["scalar_rows"].as_u64(), Some(2));

        fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
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

        let executed = cpu_reference::execute_reference_fdm(&plan, 1e-12, &outputs, None, None)
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

    #[test]
    fn mesh_preview_active_mask_marks_only_non_air_nodes_for_m() {
        let mesh = MeshIR {
            mesh_name: "shared".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [2.0, 0.0, 0.0],
                [2.0, 1.0, 0.0],
                [2.0, 0.0, 1.0],
                [3.0, 0.0, 0.0],
            ],
            elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
            element_markers: vec![1, 0],
            boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
            boundary_markers: vec![1, 99],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: std::collections::HashMap::new(),
        };

        let magnetization_mask = crate::preview::mesh_quantity_active_mask("m", &mesh)
            .expect("magnetization preview should expose a mask for FEM mesh previews");
        let demag_mask = crate::preview::mesh_quantity_active_mask("H_demag", &mesh);

        assert_eq!(
            magnetization_mask,
            vec![true, true, true, true, false, false, false, false]
        );
        assert!(demag_mask.is_none());
    }
}
