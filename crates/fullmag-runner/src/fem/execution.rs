//! FEM execution routing between CPU native and native GPU backends.

use fullmag_ir::{FemEigenPlanIR, FemPlanIR, OutputIR};

use crate::artifact_pipeline::ArtifactPipelineSender;
#[cfg(feature = "fem-gpu")]
use crate::artifact_pipeline::ArtifactRecorder;
use crate::fem::eigen_path::execute_fem_eigen_path;
use crate::fem::pbc::{
    fem_static_periodic_decision, validate_periodic_region_material_certificate,
    FemStaticPbcLane,
};
use crate::fem::plan::normalized_fem_plan_for_runtime;
use crate::fem::preview::{fem_plan_for_cpu_native, fem_plan_for_native_gpu};
#[cfg(feature = "fem-gpu")]
use crate::fem::relax::scalars::ensure_fem_object_scalars;
#[cfg(feature = "fem-gpu")]
use crate::fem::runtime_contract::{
    apply_native_fem_runtime_contract, fem_poisson_demag_provenance, native_fem_execution_engine,
    native_fem_execution_mode, native_fem_gpu_ready_log_message, native_fem_llg_mode,
    validate_all_in_gpu_fem_runtime_contract,
};
use crate::fem_baseline;
use crate::fem_eigen;
#[cfg(feature = "fem-gpu")]
use crate::native_fem::NativeFemBackend;
#[cfg(feature = "fem-gpu")]
use crate::relaxation::apply_energy_minimizer_provenance;
#[cfg(feature = "fem-gpu")]
use crate::relaxation::RelaxationEnergyPlateauWindow;
#[cfg(feature = "fem-gpu")]
use crate::relaxation_direct_minimizer::direct_minimizer_control;
#[cfg(feature = "fem-gpu")]
use crate::schedules::collect_field_schedules;
#[cfg(feature = "fem-gpu")]
use crate::solver_runtime::diagnostics::runtime_info_once;
use crate::solver_runtime::diagnostics::runtime_log_once;
use crate::solver_runtime::engine::FemEngine;
use crate::solver_runtime::selection::should_fallback_to_cpu_for_small_fem_gpu;
use crate::types::{ExecutedRun, LiveStepConsumer, RunError};
#[cfg(feature = "fem-gpu")]
use crate::types::{ExecutionProvenance, StepStats};

/// Execute a FEM plan using the selected engine.
pub(crate) fn execute_fem<'a>(
    engine: FemEngine,
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'a>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    let fem_mesh_generation_id = Some(crate::types::fem_plan_mesh_generation_id(plan));
    let normalized_plan = normalized_fem_plan_for_runtime(plan)?;
    if let Err(reason) = validate_periodic_region_material_certificate(&normalized_plan) {
        return Err(RunError {
            message: format!(
                "FEM periodic region/material certificate rejected before native allocation: {reason}"
            ),
        });
    }
    let pbc_decision = fem_static_periodic_decision(&normalized_plan);
    match pbc_decision.lane {
        FemStaticPbcLane::Unsupported => {
            return Err(RunError {
                message: format!(
                    "FEM static/time-domain PBC cannot be executed: {}. \
                     Unsupported interactions: {}.",
                    pbc_decision.reason.as_deref().unwrap_or("unknown"),
                    pbc_decision.unsupported_interactions.join(", ")
                ),
            });
        }
        FemStaticPbcLane::ReferenceReduction => {
            runtime_log_once(
                "info",
                &format!(
                    "FEM static periodic constraints are executed by the Rust FEM reference path: {}",
                    pbc_decision.reason.as_deref().unwrap_or("operator reduction required")
                ),
            );
            return fem_baseline::execute_reference_fem(
                &normalized_plan,
                until_seconds,
                outputs,
                live,
                artifact_writer,
            );
        }
        FemStaticPbcLane::None
        | FemStaticPbcLane::NativeExchangeOnly
        | FemStaticPbcLane::NativeAnisotropy
        | FemStaticPbcLane::NativeDemagPoisson => {
            // Fall through to native execution below.
        }
    }
    match engine {
        FemEngine::CpuNative => {
            let cpu_plan = fem_plan_for_cpu_native(&normalized_plan);
            execute_native_fem(&cpu_plan, &fem_mesh_generation_id, until_seconds, outputs, live, artifact_writer)
        }
        FemEngine::NativeGpu => {
            if let Some(min_nodes) = should_fallback_to_cpu_for_small_fem_gpu(&normalized_plan) {
                eprintln!(
                    "warning: FEM plan has {} nodes, below FULLMAG_FEM_GPU_MIN_NODES={} — \
                     falling back to MFEM/libCEED/hypre CPU FEM engine \
                     (fallback_reason=fem_gpu_small_mesh_policy; \
                     set FULLMAG_FEM_EXECUTION=gpu to force GPU or \
                     FULLMAG_FEM_GPU_MIN_NODES=0 to disable this policy)",
                    normalized_plan.mesh.nodes.len(),
                    min_nodes
                );
                let cpu_plan = fem_plan_for_cpu_native(&normalized_plan);
                return execute_native_fem(
                    &cpu_plan,
                    &fem_mesh_generation_id,
                    until_seconds,
                    outputs,
                    live,
                    artifact_writer,
                );
            }
            let gpu_plan = fem_plan_for_native_gpu(&normalized_plan);
            execute_native_fem(&gpu_plan, &fem_mesh_generation_id, until_seconds, outputs, live, artifact_writer)
        }
    }
}

pub(crate) fn execute_fem_eigen(
    engine: FemEngine,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    // Route Path k-sampling through the multi-k orchestrator, which calls
    // the single-k solver for each sample point and then performs branch
    // tracking and writes V2 artifacts.
    if matches!(plan.k_sampling, Some(fullmag_ir::KSamplingIR::Path { .. })) {
        return execute_fem_eigen_path(engine, plan, outputs);
    }

    match engine {
        FemEngine::CpuNative => fem_eigen::execute_baseline_fem_eigen(plan, outputs),
        FemEngine::NativeGpu => {
            // GPU-accelerated dense eigensolver (Etap A4) — TRANSITIONAL.
            // `execute_gpu_fem_eigen` uses cuSolverDN; returns error if GPU
            // is unavailable (no silent fallback to CPU).
            fem_eigen::execute_gpu_fem_eigen(plan, outputs)
        }
    }
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn native_fem_requires_initial_snapshot(
    live_present: bool,
    direct_minimization: bool,
) -> bool {
    live_present || direct_minimization
}

#[cfg(feature = "fem-gpu")]
fn execute_native_fem(
    plan: &FemPlanIR,
    fem_mesh_generation_id: &Option<String>,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<LiveStepConsumer<'_>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }
    let time_events = crate::time_events::build_resolved_stage_event_schedule(
        &plan.field_drives,
        plan.time_stage.start_time_s,
        plan.time_stage.start_time_s + until_seconds,
        outputs,
        crate::schedules::OUTPUT_TIME_TOLERANCE,
    );

    let direct_minimization_relax = direct_minimizer_control(plan.relaxation.as_ref());
    let needs_initial_snapshot = native_fem_requires_initial_snapshot(
        live.as_ref()
            .is_some_and(|consumer| consumer.initial_snapshot),
        direct_minimization_relax.is_some(),
    );

    let mut backend =
        NativeFemBackend::create_with_initial_effective_field(plan, needs_initial_snapshot)?;
    let device_info = backend.device_info()?;
    let gpu_state_info = backend.gpu_state_info()?;
    let gpu_rk_plan_info = backend.gpu_rk_plan_info()?;
    let execution_engine = native_fem_execution_engine(plan);
    let execution_mode = native_fem_execution_mode(plan);
    validate_all_in_gpu_fem_runtime_contract(execution_mode, &gpu_rk_plan_info)?;
    let demag_policy = plan.demag_solver_policy.clone().unwrap_or_default();
    runtime_info_once(&format!(
        "native FEM backend active: engine={} device='{}' cc={} driver={} runtime={} mfem_device={} assembly_mode=legacy_sparse llg_mode={} demag_solver={} preconditioner={} demag_mode={} hypre_gpu_policy={} demag_residency={}",
        execution_engine,
        device_info.name,
        device_info.compute_capability,
        device_info.driver_version,
        device_info.runtime_version,
        plan.mfem_device_string.as_deref().unwrap_or("cpu"),
        native_fem_llg_mode(plan),
        demag_policy.solver,
        demag_policy.preconditioner,
        gpu_rk_plan_info.demag_operator_mode,
        gpu_rk_plan_info.hypre_execution_policy,
        gpu_rk_plan_info.demag_residency,
    ));
    if crate::native_fem::native_fem_plan_requests_gpu_mfem_device(plan) {
        let (level, message) = native_fem_gpu_ready_log_message(
            &gpu_state_info,
            &device_info,
            Some(&gpu_rk_plan_info),
        );
        runtime_log_once(level, &message);
    }
    let node_count = plan.mesh.nodes.len();
    let initial_magnetization = backend.copy_m(node_count)?;
    let timestep_policy = if crate::fem::relax::algorithm::native_step_control(
        plan.relaxation.as_ref(),
    )
    .is_some()
    {
        None
    } else {
        Some(crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            if crate::native_fem::native_fem_plan_requests_gpu_mfem_device(plan) {
                crate::types::TimestepExecutionLane::fem_gpu(plan.precision)
            } else {
                crate::types::TimestepExecutionLane::fem_cpu(plan.precision)
            },
        )?)
    };
    let dt_is_fixed = plan.fixed_timestep.is_some();
    let mut steps = Vec::new();
    let current_stats = if needs_initial_snapshot {
        let mut stats = backend.snapshot_step_stats(node_count)?;
        ensure_fem_object_scalars(&mut stats, plan);
        stats
    } else {
        StepStats::default()
    };
    let initial_stats = needs_initial_snapshot.then_some(&current_stats);
    // FEM-013 fix: serialize resolved demag realization and integrator in provenance.
    let resolved_demag = plan
        .demag_realization
        .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
    let mut provenance = ExecutionProvenance {
        execution_engine: execution_engine.to_string(),
        precision: match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
            fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
        },
        demag_operator_kind: if plan.enable_demag {
            Some(resolved_demag.provenance_name().to_string())
        } else {
            None
        },
        fft_backend: None,
        device_name: Some(device_info.name.clone()),
        compute_capability: Some(device_info.compute_capability.clone()),
        cuda_driver_version: Some(device_info.driver_version),
        cuda_runtime_version: Some(device_info.runtime_version),
        requested_integrator: plan.integrator.map(|integrator| format!("{integrator:?}")),
        resolved_integrator: plan.integrator.map(|integrator| format!("{integrator:?}")),
        requested_demag_realization: plan
            .demag_realization
            .map(|r| r.provenance_name().to_string()),
        resolved_demag_realization: if plan.enable_demag {
            Some(resolved_demag.provenance_name().to_string())
        } else {
            None
        },
        timestep_policy,
        dt_policy: None,
        mfem_device: plan.mfem_device_string.clone(),
        demag_refresh_interval_s: plan
            .field_refresh
            .as_ref()
            .and_then(|policy| policy.demag_interval_s),
        fem_assembly_mode: Some("legacy_sparse".to_string()),
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: initial_stats.and_then(|stats| {
            (stats.requested_fem_omp_threads > 0).then_some(stats.requested_fem_omp_threads as u32)
        }),
        effective_fem_omp_threads: initial_stats.and_then(|stats| {
            (stats.effective_fem_omp_threads > 0).then_some(stats.effective_fem_omp_threads as u32)
        }),
        fem_poisson_demag: fem_poisson_demag_provenance(plan, initial_stats),
        ..Default::default()
    };
    apply_energy_minimizer_provenance(&mut provenance, plan.relaxation.as_ref());
    apply_native_fem_runtime_contract(
        &mut provenance,
        plan,
        initial_stats,
        Some(&gpu_state_info),
        Some(&gpu_rk_plan_info),
    );
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    let field_schedules = collect_field_schedules(outputs)?;

    let latest_stats: Option<StepStats>;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let backend_completion: Option<fullmag_ir::StageCompletionIR>;
    let last_preview_revision: Option<u64> = None;
    let cancelled: bool;
    let paused: bool;

    if let Some(direct_minimizer) = direct_minimization_relax {
        let outcome = crate::fem::relax::direct_minimizer::execute_direct_minimizer(
            &mut backend,
            plan,
            &fem_mesh_generation_id,
            node_count,
            direct_minimizer,
            current_stats,
            live.as_mut(),
            &mut artifacts,
            &mut steps,
            &mut energy_plateau,
            last_preview_revision,
        )?;
        latest_stats = outcome.latest_stats;
        backend_completion = None;
        cancelled = outcome.cancelled;
        paused = outcome.paused;
    } else {
        let dt = provenance
            .timestep_policy
            .as_ref()
            .expect("LLG execution requires a resolved timestep policy")
            .initial_dt();
        let outcome = crate::fem::relax::llg_overdamped::execute_llg_overdamped(
            &mut backend,
            plan,
            &fem_mesh_generation_id,
            plan.time_stage.start_time_s + until_seconds,
            &time_events.times_s,
            node_count,
            dt,
            dt_is_fixed,
            current_stats,
            live.as_mut(),
            &mut artifacts,
            &mut steps,
            &mut energy_plateau,
            last_preview_revision,
        )?;
        latest_stats = outcome.latest_stats;
        backend_completion = outcome.backend_completion;
        cancelled = outcome.cancelled;
        paused = outcome.paused;
    }

    crate::fem::relax::finalize::finalize_native_fem_relaxation(
        &mut backend,
        plan,
        &fem_mesh_generation_id,
        node_count,
        initial_magnetization,
        field_schedules,
        live.as_mut(),
        artifacts,
        steps,
        crate::fem::relax::finalize::NativeFemRelaxationFinalization {
            latest_stats,
            backend_completion,
            cancelled,
            paused,
        },
    )
}

#[cfg(not(feature = "fem-gpu"))]
fn execute_native_fem(
    _plan: &FemPlanIR,
    _fem_mesh_generation_id: &Option<String>,
    _until_seconds: f64,
    _outputs: &[OutputIR],
    _live: Option<LiveStepConsumer<'_>>,
    _artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    Err(RunError {
        message:
            "native FEM backend requested but fullmag-runner was built without the 'fem-gpu' feature"
                .to_string(),
    })
}
