//! Reference FDM runner: executes a planned simulation via `fullmag-engine`.
//!
//! Module layout:
//! - `types`         — public and internal types
//! - `schedules`     — output scheduling logic
//! - `artifacts`     — metadata, CSV, field file writing
//! - `fdm/cpu`       — CPU reference execution path (calibration baseline)
//! - `fdm/gpu/cuda`  — native CUDA execution path
//! - `fem/`          — FEM engine selection, relaxation orchestration, integrators
//! - `dispatch`      — engine selection (CPU now, CUDA in Phase 2)

/// Vacuum permeability μ₀ in T·m/A.
pub const MU0: f64 = 4.0 * std::f64::consts::PI * 1e-7;

mod antenna_fields;
pub mod artifact_pipeline;
mod artifacts;
pub mod capabilities;
mod derived_fields;
mod dispatch;
pub mod eigen;
mod fdm;
#[allow(dead_code)]
pub(crate) mod fem;
#[path = "fem_reference.rs"]
mod fem_baseline;
mod fem_eigen;
pub mod interactive;
mod interactive_runtime;
mod native_fem;
mod preview;
pub mod quantities;
mod relaxation;
pub mod runtime_registry;
mod scalar_metrics;
mod schedules;
mod solver_profile;
pub mod table_autosave;
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
    DisplayFieldComponent, DisplayKind, DisplayPayload, DisplaySelection, DisplaySelectionState,
    DisplayViewMode,
};
pub use interactive::events::{
    CommandAckEvent, CommandCompletedEvent, CommandRejectedEvent, MeshCommandTargetEvent,
    RuntimeEventEnvelope, RuntimeStatus, RuntimeStatusChangedEvent, StepDeltaEvent,
};
pub use interactive::runtime::InteractiveRuntime;
pub use interactive_runtime::{InteractiveFdmPreviewRuntime, InteractiveFemPreviewRuntime};
pub use runtime_registry::{
    EngineAvailabilityStatus, HostCapabilityMatrix, HostEngineEntry, RuntimeManifest,
    RuntimeRegistry,
};
pub use solver_profile::{
    SolverProfileAggregates, SolverProfileConfig, SolverProfilePhaseSample, SolverProfileSnapshot,
    SolverProfileState, SolverProfileStepSample, SolverProfileThreading,
};
pub use types::{
    ExecutionProvenance, FemEigenRunResult, FemMeshObjectSegment, FemMeshPartPayload,
    FemMeshPayload, LivePreviewField, LivePreviewRequest, LiveVectorFieldSnapshot,
    ResolvedFallback, RunError, RunResult, RunStatus, RuntimeEngineInfo, StepAction, StepStats,
    StepUpdate,
};

use crate::capabilities::{
    capabilities_for_fdm_engine, capabilities_for_fem_eigen_engine, capabilities_for_fem_engine,
};
use crate::fdm::cpu::multilayer_reference;
use crate::fdm::cpu::reference as cpu_reference;
use crate::fdm::gpu::cuda::native as native_fdm;
use fullmag_ir::{BackendPlanIR, FdmMultilayerPlanIR, FdmPlanIR, OutputIR, ProblemIR};
use interactive::InteractiveBackend;
use serde_json::Value;

use std::path::Path;

#[derive(Debug, Clone)]
pub struct ResolvedSessionRuntime {
    pub requested_cpu_threads: Option<usize>,
    pub resolved_cpu_threads: usize,
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
    use super::{
        is_native_fem_cpu_available, is_native_fem_time_domain_available, resolve_initial_timestep,
    };

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

    #[test]
    fn cpu_availability_drives_native_fem_time_domain_probe() {
        assert_eq!(
            is_native_fem_time_domain_available(),
            is_native_fem_cpu_available()
        );
    }
}

pub fn is_native_fdm_cuda_available() -> bool {
    native_fdm::is_cuda_available()
}

pub fn is_native_fem_gpu_available() -> bool {
    native_fem::is_gpu_available()
}

#[derive(Debug, Clone)]
pub struct NativeFemGpuStatus {
    pub available: bool,
    pub visible_cuda_device_count: i32,
    pub requested_gpu_index: i32,
    pub resolved_gpu_index: i32,
    pub memory_free_bytes: u64,
    pub memory_total_bytes: u64,
    pub reason_gpu: String,
}

pub fn native_fem_gpu_status() -> NativeFemGpuStatus {
    let availability = native_fem::native_availability();
    NativeFemGpuStatus {
        available: availability.native_fem_gpu_available,
        visible_cuda_device_count: availability.visible_cuda_device_count,
        requested_gpu_index: availability.requested_gpu_index,
        resolved_gpu_index: availability.resolved_gpu_index,
        memory_free_bytes: availability.memory_free_bytes,
        memory_total_bytes: availability.memory_total_bytes,
        reason_gpu: availability.reason_gpu,
    }
}

pub fn is_native_fem_cpu_available() -> bool {
    native_fem::is_cpu_available()
}

pub fn is_native_fem_time_domain_available() -> bool {
    native_fem::is_cpu_available()
}

fn fem_engine_kind(engine: dispatch::FemEngine) -> fem::engine::FemEngineKind {
    match engine {
        dispatch::FemEngine::CpuNative => fem::engine::FemEngineKind::CpuNative,
        dispatch::FemEngine::NativeGpu => fem::engine::FemEngineKind::NativeGpu,
    }
}

fn attach_resolved_fallback_to_executed_run(
    executed: &mut types::ExecutedRun,
    fallback: Option<ResolvedFallback>,
) {
    if executed.provenance.resolved_fallback.is_none() {
        executed.provenance.resolved_fallback = fallback;
    }
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
    run_planned_problem(problem, &plan, until_seconds, output_dir)
}

/// Run a problem with an already materialized execution plan.
///
/// Interactive frontends use this to preserve the materialize -> wait ->
/// compute contract: once the mesh and initial state have been planned, the
/// compute click should execute that snapshot instead of re-sampling initial
/// textures by planning the same `ProblemIR` again.
pub fn run_planned_problem(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    until_seconds: f64,
    output_dir: &Path,
) -> Result<RunResult, RunError> {
    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start(
        output_dir.to_path_buf(),
        artifacts::build_field_context(problem, plan),
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
            let resolution = dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem)?;
            let mut executed = if fem.relaxation.is_some() {
                fem::relax::execute_fem_relax(
                    fem_engine_kind(resolution.engine),
                    fem,
                    until_seconds,
                    &plan.output_plan.outputs,
                    None,
                    artifact_writer.clone(),
                )
            } else {
                dispatch::execute_fem(
                    resolution.engine,
                    fem,
                    until_seconds,
                    &plan.output_plan.outputs,
                    None,
                    artifact_writer.clone(),
                )
            }?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            Ok(executed)
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
        plan,
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
    fem_baseline::fem_observables_for_magnetization(plan, magnetization)
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
    run_planned_problem_with_callback(
        problem,
        &plan,
        until_seconds,
        output_dir,
        field_every_n,
        &mut on_step,
    )
}

/// Run a problem with an already materialized execution plan and live callback.
pub fn run_planned_problem_with_callback(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start(
        output_dir.to_path_buf(),
        artifacts::build_field_context(problem, plan),
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
                    initial_snapshot: false,
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
            let resolution = dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem)?;
            let live = Some(types::LiveStepConsumer {
                grid: [0, 0, 0],
                field_every_n,
                initial_snapshot: false,
                display_selection: None,
                interrupt_requested: None,
                on_step: &mut on_step,
            });
            let mut executed = if fem.relaxation.is_some() {
                fem::relax::execute_fem_relax(
                    fem_engine_kind(resolution.engine),
                    fem,
                    until_seconds,
                    &plan.output_plan.outputs,
                    live,
                    artifact_writer.clone(),
                )
            } else {
                dispatch::execute_fem(
                    resolution.engine,
                    fem,
                    until_seconds,
                    &plan.output_plan.outputs,
                    live,
                    artifact_writer.clone(),
                )
            }?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            Ok(executed)
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
        plan,
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
        magnetization: Some(final_m),
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
    on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    run_problem_with_live_preview_interruptible_with_initial_snapshot(
        problem,
        until_seconds,
        output_dir,
        field_every_n,
        display_selection,
        interrupt_requested,
        true,
        on_step,
    )
}

pub fn run_problem_with_live_preview_interruptible_with_initial_snapshot(
    problem: &ProblemIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    run_planned_problem_with_live_preview_interruptible_with_initial_snapshot(
        problem,
        &plan,
        until_seconds,
        output_dir,
        field_every_n,
        display_selection,
        interrupt_requested,
        initial_snapshot,
        &mut on_step,
    )
}

/// Run a problem with an already materialized execution plan and live-preview
/// callback.
pub fn run_planned_problem_with_live_preview_interruptible_with_initial_snapshot(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start(
        output_dir.to_path_buf(),
        artifacts::build_field_context(problem, plan),
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
                    initial_snapshot,
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
            let live = Some(types::LiveStepConsumer {
                grid: [0, 0, 0],
                field_every_n,
                initial_snapshot,
                display_selection: Some(display_selection),
                interrupt_requested,
                on_step: &mut on_step,
            });
            let mut executed = if fem.relaxation.is_some() {
                fem::relax::execute_fem_relax(
                    fem_engine_kind(resolution.engine),
                    fem,
                    until_seconds,
                    &plan.output_plan.outputs,
                    live,
                    artifact_writer.clone(),
                )
            } else {
                dispatch::execute_fem(
                    resolution.engine,
                    fem,
                    until_seconds,
                    &plan.output_plan.outputs,
                    live,
                    artifact_writer.clone(),
                )
            }?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            Ok(executed)
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
        plan,
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
    create_planned_interactive_runtime(problem, &plan, continuation_magnetization)
}

/// Create a unified `InteractiveRuntime` from an already materialized plan.
pub fn create_planned_interactive_runtime(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    continuation_magnetization: Option<&[[f64; 3]]>,
) -> Result<InteractiveRuntime, RunError> {
    let backend: Box<dyn InteractiveBackend> = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => Box::new(InteractiveFdmPreviewRuntime::create_from_plan(
            problem, fdm,
        )?),
        BackendPlanIR::Fem(fem) => Box::new(InteractiveFemPreviewRuntime::create_from_plan(
            problem, fem,
        )?),
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

pub fn run_planned_problem_with_interactive_runtime_live_preview_interruptible(
    runtime: &mut InteractiveRuntime,
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    runtime.execute_planned_streaming(
        problem,
        plan,
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
    resolve_planned_runtime_engine(problem, &plan)
}

pub fn resolve_planned_runtime_engine(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<RuntimeEngineInfo, RunError> {
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
            let (engine_id, engine_label, accelerator) = fem_runtime_engine_info(engine);
            Ok(RuntimeEngineInfo {
                backend_family: "fem".to_string(),
                engine_id: engine_id.to_string(),
                engine_label: engine_label.to_string(),
                accelerator: accelerator.to_string(),
            })
        }
        BackendPlanIR::FemEigen(_) => {
            let engine = dispatch::resolve_fem_engine_with_trail(problem)?.engine;
            let (engine_id, engine_label, accelerator) = fem_eigen_runtime_engine_info(engine);
            Ok(RuntimeEngineInfo {
                backend_family: "fem_eigen".to_string(),
                engine_id: engine_id.to_string(),
                engine_label: engine_label.to_string(),
                accelerator: accelerator.to_string(),
            })
        }
    }
}

fn fem_runtime_engine_info(
    engine: dispatch::FemEngine,
) -> (&'static str, &'static str, &'static str) {
    match engine {
        dispatch::FemEngine::CpuNative => (
            dispatch::fem_engine_id(engine),
            "CPU FEM (MFEM/libCEED/hypre)",
            "cpu",
        ),
        dispatch::FemEngine::NativeGpu => (dispatch::fem_engine_id(engine), "GPU FEM", "gpu"),
    }
}

fn fem_eigen_runtime_engine_info(
    engine: dispatch::FemEngine,
) -> (&'static str, &'static str, &'static str) {
    match engine {
        dispatch::FemEngine::CpuNative => (
            dispatch::fem_eigen_engine_id(engine),
            "CPU FEM Eigen Baseline",
            "cpu",
        ),
        dispatch::FemEngine::NativeGpu => (
            dispatch::fem_eigen_engine_id(engine),
            "GPU FEM Eigen",
            "gpu",
        ),
    }
}

fn fem_session_runtime_defaults(
    engine: dispatch::FemEngine,
) -> (&'static str, &'static str, &'static str) {
    match engine {
        dispatch::FemEngine::CpuNative => {
            ("fem-cpu-native", "fem_cpu_native", "../../bin/fullmag-bin")
        }
        dispatch::FemEngine::NativeGpu => ("fem-gpu", "fem_native_gpu", "bin/fullmag-fem-gpu-bin"),
    }
}

fn fem_eigen_session_runtime_defaults(
    engine: dispatch::FemEngine,
) -> (&'static str, &'static str, &'static str) {
    match engine {
        dispatch::FemEngine::CpuNative => (
            "fem-eigen-cpu-baseline",
            "fem_eigen_cpu_baseline",
            "../../bin/fullmag-bin",
        ),
        dispatch::FemEngine::NativeGpu => (
            "fem-eigen-gpu",
            "fem_eigen_native_gpu",
            "bin/fullmag-fem-gpu-bin",
        ),
    }
}

pub fn resolve_runtime_capabilities(problem: &ProblemIR) -> Result<BackendCapabilities, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    resolve_planned_runtime_capabilities(problem, &plan)
}

pub fn resolve_planned_runtime_capabilities(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<BackendCapabilities, RunError> {
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
        BackendPlanIR::FemEigen(_) => Ok(capabilities_for_fem_eigen_engine(
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
    let resolved_cpu_threads = configured_cpu_threads(problem);
    let requested_cpu_threads = requested_cpu_threads(problem).map(|threads| threads as usize);
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
                requested_cpu_threads,
                resolved_cpu_threads,
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
                requested_cpu_threads,
                resolved_cpu_threads,
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
        (BackendPlanIR::Fem(_), dispatch::DispatchEngine::Fem(engine)) => {
            let (default_family, engine_id, default_worker) = fem_session_runtime_defaults(engine);
            Ok(ResolvedSessionRuntime {
                requested_cpu_threads,
                resolved_cpu_threads,
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
        (BackendPlanIR::FemEigen(_), dispatch::DispatchEngine::Fem(engine)) => {
            let (default_family, engine_id, default_worker) =
                fem_eigen_session_runtime_defaults(engine);
            Ok(ResolvedSessionRuntime {
                requested_cpu_threads,
                resolved_cpu_threads,
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

pub(crate) fn requested_cpu_threads(problem: &ProblemIR) -> Option<u32> {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
        .and_then(|selection| selection.get("cpu_threads"))
        .and_then(Value::as_u64)
        .and_then(|threads| u32::try_from(threads).ok())
}

pub(crate) fn configured_cpu_threads(problem: &ProblemIR) -> usize {
    // 1. Explicit per-problem setting from runtime_metadata
    if let Some(threads) = requested_cpu_threads(problem).map(|threads| threads as usize) {
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

/// Run a FEM eigenmode analysis on the CPU FEM baseline engine.
///
/// Returns a [`types::FemEigenRunResult`] with the solver status and all artifact
/// files produced during the solve. Path k-sampling is routed through the
/// public CPU path orchestrator so callers receive the same V2 dispersion
/// artifacts as the main dispatcher.
pub fn run_reference_fem_eigen(
    plan: &fullmag_ir::FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<types::FemEigenRunResult, RunError> {
    let executed = dispatch::execute_fem_eigen(dispatch::FemEngine::CpuNative, plan, outputs)?;
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
        CurrentModuleIR, CurrentTransportModelIR, ExchangeBoundaryCondition, ExecutionPrecision,
        FdmMaterialIR, GridDimensions, IntegratorChoice, MeshIR,
    };
    #[cfg(feature = "cuda")]
    use fullmag_ir::{FdmGridAssetIR, GeometryAssetsIR, GeometryEntryIR};
    use serde_json::json;
    use std::fs;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn fem_relaxation_entrypoints_route_through_fem_relax_module() {
        let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("read lib.rs");
        let route_count = source.matches("fem::relax::execute_fem_relax(").count();
        assert!(
            route_count >= 3,
            "run entrypoints should route FEM relaxation through fem::relax::execute_fem_relax, found {route_count}"
        );
    }

    #[test]
    fn capability_matrix_records_native_fem_relaxation_realization() {
        let matrix = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/specs/capability-matrix-v0.md"
        ))
        .expect("read capability matrix");

        let row = |feature: &str| -> &str {
            matrix
                .lines()
                .find(|line| line.starts_with(&format!("| `{feature}`")))
                .unwrap_or_else(|| panic!("missing capability matrix row for {feature}"))
        };

        let pgbb = row("Relaxation(projected_gradient_bb)");
        assert!(pgbb.contains("fem_cpu_native"), "{pgbb}");
        assert!(pgbb.contains("fem_native_gpu"), "{pgbb}");
        assert!(pgbb.contains("fullmag_fem_backend_relax_step"), "{pgbb}");
        assert!(pgbb.contains("native CUDA"), "{pgbb}");
        assert!(pgbb.contains("transfer-audit"), "{pgbb}");
        assert!(
            !pgbb.contains("fem_gpu_relaxation_algorithm_cpu_only"),
            "{pgbb}"
        );
        assert!(!pgbb.contains("GPU forced unsupported"), "{pgbb}");
        assert!(
            !pgbb.contains("bootstrap") && !pgbb.contains("semantic-only"),
            "{pgbb}"
        );

        let ncg = row("Relaxation(nonlinear_cg)");
        assert!(ncg.contains("fem_cpu_native"), "{ncg}");
        assert!(ncg.contains("fem_native_gpu"), "{ncg}");
        assert!(ncg.contains("fullmag_fem_backend_relax_step"), "{ncg}");
        assert!(ncg.contains("HyprePCG/BoomerAMG"), "{ncg}");
        assert!(
            !ncg.contains("fem_gpu_relaxation_algorithm_cpu_only"),
            "{ncg}"
        );
        assert!(!ncg.contains("GPU forced unsupported"), "{ncg}");
        assert!(
            !ncg.contains("bootstrap") && !ncg.contains("semantic-only"),
            "{ncg}"
        );

        let tpi = row("Relaxation(tangent_plane_implicit)");
        assert!(tpi.contains("fem_cpu_native"), "{tpi}");
        assert!(tpi.contains("native CPU/MFEM implementation path"), "{tpi}");
        assert!(tpi.contains("demag fresh-solve linear response"), "{tpi}");
        assert!(
            tpi.contains("**under-development** (native FEM CPU/MFEM and FEM GPU/libCEED)"),
            "{tpi}"
        );
        assert!(
            tpi.contains("fem_gpu_relaxation_algorithm_cpu_only"),
            "{tpi}"
        );
        assert!(
            !tpi.contains("execution deferred") && !tpi.contains("planned | planned"),
            "{tpi}"
        );
        assert!(
            !tpi.contains("**public-executable** (native FEM CPU/MFEM)"),
            "{tpi}"
        );
    }

    #[test]
    fn fem_relaxation_vector_math_is_owned_by_relax_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("fn tangent_gradient_from_field("),
            "dispatch.rs must not own FEM direct-minimizer tangent-gradient math"
        );
        assert!(
            !dispatch.contains("fn project_tangent("),
            "dispatch.rs must not own FEM direct-minimizer tangent projection"
        );
        assert!(
            !dispatch.contains("fn max_torque_from_field("),
            "dispatch.rs must not own FEM direct-minimizer torque math"
        );
        assert!(
            !dispatch.contains("use crate::fem::relax::vector_math"),
            "dispatch.rs must not route shared FDM/FEM direct-minimizer math through the FEM module"
        );

        let vector_math = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/vector_math.rs"
        ))
        .expect("read relaxation/vector_math.rs");
        for symbol in [
            "pub(crate) fn tangent_gradient_from_field(",
            "pub(crate) fn project_tangent(",
            "pub(crate) fn max_torque_from_field(",
        ] {
            assert!(
                vector_math.contains(symbol),
                "relaxation/vector_math.rs must own {symbol}"
            );
        }
    }

    #[test]
    fn relaxation_top_level_is_facade_for_focused_modules() {
        let top_level =
            fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/relaxation.rs"))
                .expect("read relaxation.rs");
        assert!(
            top_level.contains("pub(crate) mod convergence;"),
            "relaxation.rs should expose convergence/stop criteria through a focused module"
        );
        assert!(
            top_level.contains("pub(crate) mod provenance;"),
            "relaxation.rs should expose energy-minimizer provenance through a focused module"
        );
        assert!(
            !top_level.contains("pub(crate) fn execute_projected_gradient_bb("),
            "relaxation.rs must not own projected-gradient BB implementation"
        );
        assert!(
            !top_level.contains("pub(crate) fn execute_nonlinear_cg("),
            "relaxation.rs must not own nonlinear-CG implementation"
        );
        assert!(
            !top_level.contains("pub(crate) fn apply_energy_minimizer_provenance("),
            "relaxation.rs must not own energy-minimizer provenance mapping"
        );

        for path in [
            "/src/relaxation/convergence.rs",
            "/src/relaxation/provenance.rs",
            "/src/relaxation/direct_minimizer.rs",
        ] {
            let full_path = format!("{}{}", env!("CARGO_MANIFEST_DIR"), path);
            assert!(
                std::path::Path::new(&full_path).exists(),
                "{path} must exist as a focused relaxation module"
            );
        }
    }

    #[test]
    fn direct_minimizer_algorithm_policy_is_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("let direct_minimization_relax = plan.relaxation.as_ref().filter"),
            "dispatch.rs must not own direct-minimizer algorithm classification"
        );
        assert!(
            !dispatch.contains("let lambda_min: f64 = 1e-15;"),
            "dispatch.rs must not own shared direct-minimizer step-size constants"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        for symbol in [
            "pub(crate) fn direct_minimizer_control(",
            "pub(crate) fn initial_search_direction(",
            "pub(crate) const DEFAULT_STEP_SIZE",
            "pub(crate) const MIN_STEP_SIZE",
            "pub(crate) const MAX_STEP_SIZE",
        ] {
            assert!(
                module.contains(symbol),
                "relaxation/direct_minimizer.rs must own {symbol}"
            );
        }
    }

    #[test]
    fn direct_minimizer_state_update_math_is_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("let scale_factor = 1e-6;"),
            "dispatch.rs must not own Barzilai-Borwein direct-minimizer scaling policy"
        );
        assert!(
            !dispatch.contains("NONLINEAR_CG_RESTART_INTERVAL"),
            "dispatch.rs must not own nonlinear-CG restart policy"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        for symbol in [
            "pub(crate) fn projected_gradient_step_size_update(",
            "pub(crate) fn nonlinear_cg_initial_step_size(",
            "pub(crate) fn nonlinear_cg_next_direction(",
        ] {
            assert!(
                module.contains(symbol),
                "relaxation/direct_minimizer.rs must own {symbol}"
            );
        }
    }

    #[test]
    fn direct_minimizer_step_metrics_are_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("accepted_stats.max_dm_dt = 0.0"),
            "dispatch.rs must not stamp direct-minimizer dm/dt metrics in backend branches"
        );
        assert!(
            !dispatch.contains("accepted_stats.max_h_eff = h_eff"),
            "dispatch.rs must not duplicate direct-minimizer effective-field metrics"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        assert!(
            module.contains("pub(crate) fn apply_direct_minimizer_step_metrics("),
            "relaxation/direct_minimizer.rs must own direct-minimizer StepStats metric stamping"
        );
    }

    #[test]
    fn direct_minimizer_trial_projection_is_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("normalized_vec3(sub_vec3("),
            "dispatch.rs must not own projected-gradient trial magnetization projection"
        );
        assert!(
            !dispatch.contains("normalized_vec3(add_vec3("),
            "dispatch.rs must not own nonlinear-CG trial magnetization projection"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        for symbol in [
            "pub(crate) fn projected_gradient_trial_magnetization(",
            "pub(crate) fn nonlinear_cg_trial_magnetization(",
        ] {
            assert!(
                module.contains(symbol),
                "relaxation/direct_minimizer.rs must own {symbol}"
            );
        }
    }

    #[test]
    fn direct_minimizer_armijo_policy_is_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("energy - ARMIJO_COEFFICIENT"),
            "dispatch.rs must not own projected-gradient Armijo acceptance policy"
        );
        assert!(
            !dispatch.contains("energy + ARMIJO_COEFFICIENT"),
            "dispatch.rs must not own nonlinear-CG Armijo acceptance policy"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        for symbol in [
            "pub(crate) fn projected_gradient_armijo_accepts(",
            "pub(crate) fn nonlinear_cg_armijo_accepts(",
        ] {
            assert!(
                module.contains(symbol),
                "relaxation/direct_minimizer.rs must own {symbol}"
            );
        }
    }

    #[test]
    fn direct_minimizer_backtracking_policy_is_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("trial_lambda *= 0.5"),
            "dispatch.rs must not own direct-minimizer backtrack step-size reduction"
        );
        assert!(
            !dispatch.contains("PROJECTED_GRADIENT_MAX_BACKTRACK"),
            "dispatch.rs must not own projected-gradient max-backtrack policy"
        );
        assert!(
            !dispatch.contains("NONLINEAR_CG_MAX_BACKTRACK"),
            "dispatch.rs must not own nonlinear-CG max-backtrack policy"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        for symbol in [
            "pub(crate) fn backtracked_step_size(",
            "pub(crate) fn direct_minimizer_backtrack_exhausted(",
        ] {
            assert!(
                module.contains(symbol),
                "relaxation/direct_minimizer.rs must own {symbol}"
            );
        }
    }

    #[test]
    fn direct_minimizer_nonlinear_cg_descent_reset_is_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("p_dot_g >= 0.0"),
            "dispatch.rs must not own nonlinear-CG descent-direction reset policy"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        assert!(
            module.contains("pub(crate) fn nonlinear_cg_descent_direction_dot("),
            "relaxation/direct_minimizer.rs must own nonlinear-CG descent-direction reset policy"
        );
    }

    #[test]
    fn direct_minimizer_gradient_degeneracy_is_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("g_norm_sq < 1e-30"),
            "dispatch.rs must not own direct-minimizer gradient-degeneracy policy"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        for symbol in [
            "pub(crate) fn direct_minimizer_gradient_norm_sq(",
            "pub(crate) fn direct_minimizer_gradient_degenerate(",
        ] {
            assert!(
                module.contains(symbol),
                "relaxation/direct_minimizer.rs must own {symbol}"
            );
        }
    }

    #[test]
    fn direct_minimizer_step_budget_is_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("direct_step < control.stop.max_steps.unwrap_or(u64::MAX)"),
            "dispatch.rs must not own direct-minimizer step-budget fallback policy"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        assert!(
            module.contains("pub(crate) fn direct_minimizer_step_budget("),
            "relaxation/direct_minimizer.rs must own direct-minimizer step-budget fallback policy"
        );
    }

    #[test]
    fn direct_minimizer_line_search_is_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("let (trial_stats, m_trial) = loop"),
            "dispatch.rs must not own direct-minimizer trial line-search loops"
        );
        assert!(
            !dispatch.contains("backtracked_step_size(trial_lambda)"),
            "dispatch.rs must not own direct-minimizer trial backtracking updates"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        for symbol in [
            "pub(crate) fn projected_gradient_line_search<",
            "pub(crate) fn nonlinear_cg_line_search<",
        ] {
            assert!(
                module.contains(symbol),
                "relaxation/direct_minimizer.rs must own {symbol}"
            );
        }
        assert!(
            module.contains("Result<Option<DirectMinimizerAcceptedTrial<T>>, E>")
                && module.contains("return Ok(None);"),
            "direct-minimizer line search must reject exhausted Armijo searches instead of returning an accepted trial"
        );
    }

    #[test]
    fn direct_minimizer_reference_rejects_exhausted_armijo_searches() {
        let reference = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer_reference.rs"
        ))
        .expect("read relaxation/direct_minimizer_reference.rs");

        assert!(
            !reference.contains("|| backtracks >= max_backtrack"),
            "FDM CPU/reference direct minimizers must not accept the last trial after exhausted Armijo backtracking"
        );
        assert!(
            reference.matches("accepted_energy = Some").count() >= 2
                && reference.matches("accepted_trial = Some").count() >= 2
                && reference.matches("let Some(").count() >= 4,
            "FDM CPU/reference direct minimizers must explicitly break without updating state when line search fails"
        );
    }

    #[test]
    fn direct_minimizer_iteration_state_is_owned_by_relaxation_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("let mut p = initial_search_direction(&g);"),
            "dispatch.rs must not own direct-minimizer initial search-direction state"
        );
        assert!(
            !dispatch.contains("let mut use_bb1 = true;"),
            "dispatch.rs must not own projected-gradient BB toggle initialization"
        );
        assert!(
            !dispatch.contains("let mut reset_consecutive: u64 = 0;"),
            "dispatch.rs must not own projected-gradient reset counter initialization"
        );
        assert!(
            !dispatch.contains("let mut direct_step: u64 = 0;"),
            "dispatch.rs must not own direct-minimizer accepted-step initialization"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/relaxation/direct_minimizer.rs"
        ))
        .expect("read relaxation/direct_minimizer.rs");
        assert!(
            module.contains("pub(crate) struct DirectMinimizerState"),
            "relaxation/direct_minimizer.rs must own direct-minimizer iteration state"
        );
        assert!(
            module.contains("impl DirectMinimizerState"),
            "DirectMinimizerState must own its initialization behavior"
        );
    }

    #[test]
    fn fem_direct_minimizer_loop_is_owned_by_fem_relax_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch
                .contains("DirectMinimizerState::new(\n            backend.copy_m(node_count)?"),
            "dispatch.rs must not own the native FEM direct-minimizer execution loop"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/direct_minimizer.rs"
        ))
        .expect("read fem/relax/direct_minimizer.rs");
        assert!(
            module.contains("pub(crate) fn execute_direct_minimizer"),
            "fem/relax/direct_minimizer.rs must own FEM direct-minimizer execution"
        );
    }

    #[test]
    fn fem_llg_loop_is_owned_by_fem_relax_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("[fullmag-runner] native-fem LLG loop:"),
            "dispatch.rs must not own the native FEM LLG time-stepping loop"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/llg_overdamped.rs"
        ))
        .expect("read fem/relax/llg_overdamped.rs");
        assert!(
            module.contains("pub(crate) fn execute_llg_overdamped"),
            "fem/relax/llg_overdamped.rs must own FEM LLG time-stepping execution"
        );
    }

    #[test]
    fn fem_relaxation_module_support_table_matches_native_algorithm_lanes() {
        let module =
            fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/fem/relax/mod.rs"))
                .expect("read fem/relax/mod.rs");

        assert!(
            module.contains("| `ProjectedGradientBb`   | ✓        | ✓          | native MFEM/CUDA relaxation ABI"),
            "fem/relax/mod.rs must document PG-BB as executable on CPU/MFEM and native CUDA"
        );
        assert!(
            module.contains("| `NonlinearCg`           | ✓        | ✓          | native MFEM/CUDA relaxation ABI"),
            "fem/relax/mod.rs must document NCG as executable on CPU/MFEM and native CUDA"
        );
        assert!(
            module.contains("| `TangentPlaneImplicit`  | dev      | dev        | under development; not production-qualified |"),
            "fem/relax/mod.rs must document TPI as under development, not production-qualified"
        );
    }

    #[test]
    fn fem_relaxation_finalization_is_owned_by_fem_relax_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("Flush a final cached-preview update"),
            "dispatch.rs must not own native FEM relaxation final cached-preview flushing"
        );
        assert!(
            !dispatch.contains("let completion = if let Some(mut completion) = backend_completion"),
            "dispatch.rs must not own native FEM relaxation completion inference"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/finalize.rs"
        ))
        .expect("read fem/relax/finalize.rs");
        assert!(
            module.contains("pub(crate) fn finalize_native_fem_relaxation"),
            "fem/relax/finalize.rs must own native FEM relaxation finalization"
        );
    }

    #[test]
    fn fem_cached_preview_helpers_are_owned_by_fem_relax_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("pub(crate) fn build_fem_cached_preview_fields"),
            "dispatch.rs must not own native FEM relaxation cached-preview helpers"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/preview.rs"
        ))
        .expect("read fem/relax/preview.rs");
        assert!(
            module.contains("pub(crate) fn build_fem_cached_preview_fields"),
            "fem/relax/preview.rs must own native FEM relaxation cached-preview helpers"
        );
    }

    #[test]
    fn fem_field_snapshot_helpers_are_owned_by_fem_relax_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("pub(crate) fn copy_native_fem_field_snapshot"),
            "dispatch.rs must not own native FEM relaxation field snapshot helpers"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/snapshots.rs"
        ))
        .expect("read fem/relax/snapshots.rs");
        assert!(
            module.contains("pub(crate) fn copy_native_fem_field_snapshot"),
            "fem/relax/snapshots.rs must own native FEM relaxation field snapshot helpers"
        );
    }

    #[test]
    fn fem_object_scalar_helpers_are_owned_by_fem_relax_module() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("pub(crate) fn ensure_fem_object_scalars"),
            "dispatch.rs must not own native FEM relaxation object-scalar helpers"
        );

        let module = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/scalars.rs"
        ))
        .expect("read fem/relax/scalars.rs");
        assert!(
            module.contains("pub(crate) fn ensure_fem_object_scalars"),
            "fem/relax/scalars.rs must own native FEM relaxation object-scalar helpers"
        );
    }

    #[test]
    fn native_fem_c_abi_calls_stay_behind_native_fem_wrapper() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        assert!(
            !dispatch.contains("fullmag_fem_sys"),
            "dispatch.rs must not import the native FEM sys crate directly"
        );
        assert!(
            !dispatch.contains("ffi::fullmag_fem_"),
            "dispatch.rs must not call native FEM C ABI symbols directly"
        );
        assert!(
            !dispatch.contains("fullmag_fem_"),
            "dispatch.rs must not own native FEM C ABI symbol routing"
        );

        let native_fem =
            fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/native_fem.rs"))
                .expect("read native_fem.rs");
        assert!(
            native_fem.contains("mod availability;"),
            "native_fem.rs must declare the native FEM availability owner module"
        );
        assert!(
            native_fem.contains("mod eigen;"),
            "native_fem.rs must declare the native FEM eigen ABI owner module"
        );
        assert!(
            native_fem.contains("mod plan;"),
            "native_fem.rs must declare the native FEM plan-policy owner module"
        );
        assert!(
            native_fem.contains("mod runtime_info;"),
            "native_fem.rs must declare the native FEM runtime-info owner module"
        );
        assert!(
            native_fem.contains("pub(crate) use availability::"),
            "native_fem.rs must re-export native FEM availability helpers without re-owning them"
        );
        assert!(
            native_fem.contains("pub(crate) use plan::"),
            "native_fem.rs must re-export native FEM plan helpers without re-owning them"
        );
        assert!(
            !native_fem.contains("../../../native/backends/fem"),
            "native_fem.rs tests must not use the previous native/backends/fem path after relocation"
        );
        assert!(
            native_fem.contains("../../../backends/fem/"),
            "native_fem.rs tests must inspect the current backends/fem source tree"
        );
        let native_fem_production = native_fem
            .split("#[cfg(all(test, feature = \"fem-gpu\"))]")
            .next()
            .expect("native_fem production section");
        for symbol in [
            "fn has_slonczewski_stt(",
            "fn has_zhang_li_stt(",
            "fn native_fem_gpu_demag_mode(",
            "fn native_fem_plan_requests_gpu_mfem_device(",
            "fn native_fem_mfem_device_string_requests_gpu(",
            "enum NativeFemDataResidency",
            "struct DeviceInfo",
            "struct NativeFemGpuStateInfo",
            "struct NativeFemGpuRkPlanInfo",
            "struct GpuEigenResult",
            "fn gpu_eigen_dense_solve(",
            "ffi::fullmag_fem_eigen_dense",
            "StageStopReason",
            "StageCompletionIR {",
        ] {
            assert!(
                !native_fem_production.contains(symbol),
                "native_fem.rs must not re-own native FEM plan-policy helper {symbol}"
            );
        }
        for symbol in [
            "use fullmag_fem_sys as ffi;",
            "pub(crate) struct NativeFemBackend",
            "pub fn create(plan: &fullmag_ir::FemPlanIR)",
            "pub fn step(&mut self, dt: f64)",
            "ffi::fullmag_fem_backend_create",
            "ffi::fullmag_fem_backend_step",
        ] {
            assert!(
                native_fem.contains(symbol),
                "native_fem.rs must own native FEM ABI wrapper symbol {symbol}"
            );
        }

        let availability = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/native_fem/availability.rs"
        ))
        .expect("read native_fem/availability.rs");
        for symbol in [
            "pub(crate) struct GpuAvailability",
            "pub(crate) fn native_availability(",
            "pub(crate) fn is_gpu_available(",
            "pub(crate) fn is_cpu_available(",
            "ffi::fullmag_fem_get_availability_info",
        ] {
            assert!(
                availability.contains(symbol),
                "native_fem/availability.rs must own native FEM availability symbol {symbol}"
            );
        }

        let eigen = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/native_fem/eigen.rs"
        ))
        .expect("read native_fem/eigen.rs");
        for symbol in [
            "pub(crate) struct GpuEigenResult",
            "pub(crate) fn gpu_eigen_dense_solve(",
            "ffi::fullmag_fem_eigen_dense_desc",
            "ffi::fullmag_fem_eigen_dense",
        ] {
            assert!(
                eigen.contains(symbol),
                "native_fem/eigen.rs must own native FEM eigen ABI symbol {symbol}"
            );
        }

        let plan = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/native_fem/plan.rs"
        ))
        .expect("read native_fem/plan.rs");
        for symbol in [
            "pub(super) fn has_slonczewski_stt(",
            "pub(super) fn has_zhang_li_stt(",
            "pub(super) fn native_fem_precession_enabled(",
            "pub(super) fn single_precision_rejection(",
            "pub(super) fn native_fem_gpu_demag_mode(",
            "pub(crate) fn native_fem_plan_requests_gpu_mfem_device(",
            "pub(crate) fn native_fem_mfem_device_string_requests_gpu(",
        ] {
            assert!(
                plan.contains(symbol),
                "native_fem/plan.rs must own native FEM plan-policy symbol {symbol}"
            );
        }

        let runtime_info = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/native_fem/runtime_info.rs"
        ))
        .expect("read native_fem/runtime_info.rs");
        for symbol in [
            "pub(crate) struct DeviceInfo",
            "ffi::fullmag_fem_device_info",
            "pub(crate) enum NativeFemDataResidency",
            "pub(crate) struct NativeFemGpuStateInfo",
            "pub(crate) struct NativeFemGpuRkPlanInfo",
            "ffi::fullmag_fem_gpu_state_info",
            "ffi::fullmag_fem_gpu_rk_plan_info",
            "pub(crate) fn stage_completion_from_ffi(",
            "ffi::fullmag_fem_stage_completion",
            "StageStopReason",
        ] {
            assert!(
                runtime_info.contains(symbol),
                "native_fem/runtime_info.rs must own native FEM runtime-info symbol {symbol}"
            );
        }
    }

    #[test]
    fn shared_relaxation_helpers_live_under_relaxation_module_directory() {
        let manifest_dir = env!("CARGO_MANIFEST_DIR");
        let root_direct_minimizer =
            std::path::Path::new(manifest_dir).join("src/relaxation_direct_minimizer.rs");
        let root_vector_math =
            std::path::Path::new(manifest_dir).join("src/relaxation_vector_math.rs");
        assert!(
            !root_direct_minimizer.exists(),
            "shared direct-minimizer policy must live under src/relaxation/"
        );
        assert!(
            !root_vector_math.exists(),
            "shared relaxation vector math must live under src/relaxation/"
        );
        assert!(
            std::path::Path::new(manifest_dir)
                .join("src/relaxation/direct_minimizer.rs")
                .exists(),
            "src/relaxation/direct_minimizer.rs must own shared direct-minimizer policy"
        );
        assert!(
            std::path::Path::new(manifest_dir)
                .join("src/relaxation/vector_math.rs")
                .exists(),
            "src/relaxation/vector_math.rs must own shared relaxation vector math"
        );

        let lib = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("read lib.rs");
        assert!(
            !lib.lines()
                .any(|line| line.trim() == "mod relaxation_direct_minimizer;"),
            "lib.rs must not expose shared direct-minimizer through a root alias"
        );
        assert!(
            !lib.lines()
                .any(|line| line.trim() == "mod relaxation_vector_math;"),
            "lib.rs must not expose shared vector math through a root alias"
        );

        let relaxation =
            fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/relaxation.rs"))
                .expect("read relaxation.rs");
        assert!(
            relaxation.contains("pub(crate) mod direct_minimizer;"),
            "relaxation.rs must expose shared direct-minimizer policy"
        );
        assert!(
            relaxation.contains("pub(crate) mod vector_math;"),
            "relaxation.rs must expose shared vector math"
        );
    }

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
            stt_thickness: None,
            stt_fixed_layer_position: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
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

    fn fem_session_runtime_problem() -> fullmag_ir::ProblemIR {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: Vec::new(),
            fem_mesh_assets: Vec::new(),
            fem_domain_mesh_asset: Some(fullmag_ir::FemDomainMeshAssetIR {
                mesh_source: None,
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "strip".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                        [-2.0, -2.0, -2.0],
                        [2.0, -2.0, -2.0],
                        [-2.0, 2.0, -2.0],
                        [-2.0, -2.0, 2.0],
                    ],
                    elements: vec![[0, 1, 2, 3], [4, 5, 6, 7]],
                    element_markers: vec![1, 0],
                    boundary_faces: vec![[0, 1, 2], [4, 5, 6]],
                    boundary_markers: vec![1, 99],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
                region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "strip".to_string(),
                    marker: 1,
                }],
                build_report: None,
            }),
        });
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            json!({
                "device": "auto",
                "precision": "double",
            }),
        );
        problem
    }

    fn fem_cpu_runtime_registry(prefix: &str) -> (std::path::PathBuf, RuntimeRegistry) {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time before unix epoch")
            .as_nanos();
        let temp = std::env::temp_dir().join(format!("{prefix}-{unique}"));
        let cpu_pack = temp.join("runtimes").join("fem-cpu");
        fs::create_dir_all(cpu_pack.join("bin")).expect("create fem cpu runtime");
        fs::write(cpu_pack.join("bin").join("fullmag-fem-cpu-bin"), b"stub")
            .expect("write fem cpu worker");
        fs::write(
            cpu_pack.join("manifest.json"),
            r#"{
                "family": "fem-cpu",
                "version": "0.1.0",
                "worker": "bin/fullmag-fem-cpu-bin",
                "engines": [
                    {
                        "backend": "fem",
                        "device": "cpu",
                        "precision": "double"
                    }
                ]
            }"#,
        )
        .expect("write fem cpu manifest");
        let registry = RuntimeRegistry::discover(&temp.join("runtimes"));
        (temp, registry)
    }

    #[test]
    fn session_runtime_registry_rejects_env_forced_fem_gpu_without_gpu_runtime() {
        let _env_guard = ENV_LOCK.lock().expect("lock env mutex");
        let problem = fem_session_runtime_problem();
        let (temp, registry) =
            fem_cpu_runtime_registry("fullmag-session-runtime-env-forced-fem-gpu");

        unsafe {
            std::env::set_var("FULLMAG_FEM_EXECUTION", "gpu");
        }
        let result = resolve_session_runtime_with_registry(&problem, Some(&registry));
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        fs::remove_dir_all(&temp).expect("remove temp runtime tree");

        let err = result.expect_err("forced FEM GPU must not silently fall back to CPU registry");
        assert!(
            err.message
                .contains("no advertised FEM runtime matches device=gpu"),
            "{}",
            err.message
        );
    }

    #[test]
    fn session_runtime_registry_uses_native_fem_engine_ids_for_auto_gpu_fallback() {
        let _env_guard = ENV_LOCK.lock().expect("lock env mutex");
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        let problem = fem_session_runtime_problem();
        let (temp, registry) =
            fem_cpu_runtime_registry("fullmag-session-runtime-auto-fem-fallback");

        let runtime = resolve_session_runtime_with_registry(&problem, Some(&registry))
            .expect("auto FEM registry should resolve CPU fallback");
        fs::remove_dir_all(&temp).expect("remove temp runtime tree");

        assert_eq!(
            runtime.resolved_engine_id.as_deref(),
            Some("fem_cpu_native")
        );
        let fallback = runtime
            .resolved_fallback
            .expect("auto GPU miss should remain visible");
        assert_eq!(fallback.original_engine, "fem_native_gpu");
        assert_eq!(fallback.fallback_engine, "fem_cpu_native");
        assert_eq!(fallback.reason, "native_fem_gpu_unavailable");
    }

    #[test]
    fn resolved_fallback_is_attached_to_execution_provenance_before_artifacts() {
        let fallback = ResolvedFallback {
            occurred: true,
            original_engine: "fem_native_gpu".to_string(),
            fallback_engine: "fem_cpu_native".to_string(),
            reason: "native_fem_gpu_unavailable".to_string(),
            message: "native FEM GPU unavailable in test".to_string(),
        };
        let mut executed = types::ExecutedRun {
            result: RunResult {
                status: RunStatus::Completed,
                steps: Vec::new(),
                final_magnetization: Vec::new(),
                completion: None,
            },
            initial_magnetization: Vec::new(),
            field_snapshots: Vec::new(),
            field_snapshot_count: 0,
            auxiliary_artifacts: Vec::new(),
            provenance: ExecutionProvenance {
                execution_engine: "fem_cpu_native".to_string(),
                precision: "double".to_string(),
                ..ExecutionProvenance::default()
            },
        };

        attach_resolved_fallback_to_executed_run(&mut executed, Some(fallback.clone()));

        assert_eq!(executed.provenance.resolved_fallback, Some(fallback));
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
            None,
            None,
        )
        .expect("cpu run");
        let cuda = dispatch::execute_fdm(
            dispatch::FdmEngine::CudaFdm,
            fdm,
            2e-13,
            &plan.output_plan.outputs,
            None,
            None,
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
    fn run_problem_writes_prescribed_current_transport_artifact() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem
            .current_modules
            .push(CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: None,
                conductivity_s_per_m: None,
            });
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-current-transport-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = run_problem(&problem, 2e-13, &output_dir).expect("run_problem should succeed");
        assert_eq!(result.status, RunStatus::Completed);

        let artifact: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("current_transport/drive.json"))
                .expect("current transport artifact should be readable"),
        )
        .expect("current transport artifact should parse");
        assert_eq!(artifact["kind"], "current_transport");
        assert_eq!(artifact["model"], "prescribed_density");
        assert_eq!(artifact["unit"], "A/m^2");

        let values = artifact["values"]
            .as_array()
            .expect("values should be an array");
        let total_cell_count = artifact["layout"]["total_cell_count"]
            .as_u64()
            .expect("layout should report total_cell_count")
            as usize;
        assert_eq!(values.len(), total_cell_count);
        assert_eq!(values[0], serde_json::json!([0.0, 0.0, 5e10]));

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

    #[test]
    fn fem_runtime_and_eigen_engine_ids_stay_distinct() {
        assert_eq!(
            fem_runtime_engine_info(dispatch::FemEngine::CpuNative),
            ("fem_cpu_native", "CPU FEM (MFEM/libCEED/hypre)", "cpu")
        );
        assert_eq!(
            fem_eigen_runtime_engine_info(dispatch::FemEngine::CpuNative),
            ("fem_eigen_cpu_baseline", "CPU FEM Eigen Baseline", "cpu")
        );
        assert_eq!(
            fem_session_runtime_defaults(dispatch::FemEngine::CpuNative),
            ("fem-cpu-native", "fem_cpu_native", "../../bin/fullmag-bin")
        );
        assert_eq!(
            fem_eigen_session_runtime_defaults(dispatch::FemEngine::CpuNative),
            (
                "fem-eigen-cpu-baseline",
                "fem_eigen_cpu_baseline",
                "../../bin/fullmag-bin",
            )
        );
    }
}
