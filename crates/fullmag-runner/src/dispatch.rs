//! Engine dispatch: selects between CPU reference and native backends.
//!
//! Reads `FULLMAG_FDM_EXECUTION` env var:
//! - `auto` (default): use CUDA if compiled and available, else CPU
//! - `cpu`: force CPU reference
//! - `cuda`: force CUDA, fail if unavailable
//!
//! Reads `FULLMAG_FEM_EXECUTION` env var:
//! - `auto` (default): use native FEM GPU when available, else MFEM/libCEED/hypre CPU FEM
//! - `cpu`: force MFEM/libCEED/hypre CPU FEM
//! - `gpu`: force native FEM GPU, fail if unavailable

use fullmag_ir::{
    BackendPlanIR, ExecutionMode, FdmMultilayerPlanIR, FdmPlanIR, FemEigenPlanIR,
    FemMeshPartSelector, FemPlanIR, OutputIR, ProblemIR, RelaxationAlgorithmIR,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashSet};
use std::sync::{Mutex, OnceLock};

use crate::artifact_pipeline::ArtifactPipelineSender;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::artifact_pipeline::ArtifactRecorder;
use crate::fdm::cpu::multilayer_reference;
use crate::fdm::cpu::reference as cpu_reference;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::multilayer as multilayer_cuda;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::native::NativeFdmBackend;
#[cfg(feature = "fem-gpu")]
use crate::fem::relax::scalars::ensure_fem_object_scalars;
use crate::fem_baseline;
use crate::fem_eigen;
#[cfg(feature = "cuda")]
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
use crate::native_fem;
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{
    NativeFemBackend, NativeFemDataResidency, NativeFemGpuRkPlanInfo, NativeFemGpuStateInfo,
};
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::quantities::normalized_quantity_name;
use crate::quantities::{active_fdm_preview_quantities, active_fem_preview_quantities};
#[cfg(feature = "fem-gpu")]
use crate::relaxation::apply_energy_minimizer_provenance;
#[cfg(feature = "cuda")]
use crate::relaxation::direct_minimizer::direct_minimizer_control;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::relaxation::llg_overdamped_uses_pure_damping;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::relaxation::RelaxationEnergyPlateauWindow;
#[cfg(feature = "cuda")]
use crate::relaxation::RelaxationTorqueConfirmation;
use crate::runtime_registry::RuntimeRegistry;
#[cfg(feature = "cuda")]
use crate::scalar_metrics::single_object_scalars;
#[cfg(feature = "cuda")]
use crate::scalar_metrics::{apply_average_m_to_step_stats_with_active_mask, scalar_row_due};
#[cfg(feature = "cuda")]
use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
    OutputSchedule,
};
#[cfg(all(feature = "fem-gpu", not(feature = "cuda")))]
use crate::schedules::{advance_due_schedules, collect_field_schedules, OutputSchedule};
pub(crate) use crate::solver_runtime::engine::{EngineResolution, FdmEngine};
use crate::solver_runtime::fem_crossover::resolve_auto_fem_plan_device;
#[cfg(feature = "fem-gpu")]
use crate::solver_runtime::selection::all_in_gpu_fem_required;
pub(crate) use crate::solver_runtime::selection::{
    all_in_gpu_fem_env_requested, effective_fem_device_request,
    effective_fem_device_request_for_plan, fem_gpu_execution_forced, resolve_fdm_engine,
    resolve_fdm_engine_with_trail,
};
#[cfg(feature = "fem-gpu")]
use crate::types::FemPoissonDemagProvenance;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::types::FieldSnapshot;
use crate::types::{
    AuxiliaryArtifact, ExecutedRun, FemStageExecutionContext, LivePreviewRequest, LiveStepConsumer,
    ResolvedFallback, RunError, StepAction, StepUpdate,
};
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::types::{ExecutionProvenance, StepStats};
#[cfg(feature = "cuda")]
use crate::types::{RunResult, RunStatus};
#[cfg(feature = "fem-gpu")]
use fullmag_engine::fem::FemBackendId;

/// Which public FEM runtime lane to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FemEngine {
    /// Sole maintained CPU FEM backend (MFEM/libCEED/hypre on host CPU).
    CpuNative,
    /// Native GPU FEM backend (MFEM stack on CUDA device).
    NativeGpu,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DispatchEngine {
    Fdm(FdmEngine),
    Fem(FemEngine),
}

#[derive(Debug, Clone)]
pub(crate) struct DispatchEngineResolution {
    pub engine: DispatchEngine,
    pub fallback: Option<ResolvedFallback>,
    pub runtime_family: Option<String>,
    pub worker: Option<String>,
    pub resolved_backend: String,
    pub resolved_device: String,
    pub resolved_precision: String,
    pub fem_crossover_decision: Option<crate::types::FemCrossoverDecision>,
}

#[derive(Debug, Clone)]
pub(crate) struct FemPlanEngineResolution {
    pub engine: FemEngine,
    pub fallback: Option<ResolvedFallback>,
    pub fem_crossover_decision: Option<crate::types::FemCrossoverDecision>,
}

fn fdm_engine_id(engine: FdmEngine) -> &'static str {
    match engine {
        FdmEngine::CpuReference => "fdm_cpu_reference",
        FdmEngine::CudaFdm => "fdm_cuda",
    }
}

pub(crate) fn fem_engine_id(engine: FemEngine) -> &'static str {
    match engine {
        FemEngine::CpuNative => "fem_cpu_native",
        FemEngine::NativeGpu => "fem_native_gpu",
    }
}

pub(crate) fn fem_eigen_engine_id(engine: FemEngine) -> &'static str {
    match engine {
        FemEngine::CpuNative => "fem_eigen_cpu_baseline",
        FemEngine::NativeGpu => "fem_eigen_native_gpu",
    }
}

/// Human-readable engine label for diagnostics/logging.
pub(crate) fn fem_engine_label(engine: FemEngine) -> &'static str {
    fem_engine_id(engine)
}

fn runtime_fallback(
    original_engine: &str,
    fallback_engine: &str,
    reason: &str,
    message: String,
) -> ResolvedFallback {
    ResolvedFallback {
        occurred: true,
        original_engine: original_engine.to_string(),
        fallback_engine: fallback_engine.to_string(),
        reason: reason.to_string(),
        message,
    }
}

fn runtime_log_once(level: &str, message: &str) {
    static EMITTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let key = format!("{level}:{message}");
    let emitted = EMITTED.get_or_init(|| Mutex::new(HashSet::new()));
    match emitted.lock() {
        Ok(mut guard) => {
            if guard.insert(key) {
                eprintln!("{level}: {message}");
            }
        }
        // If the lock is poisoned, keep logging instead of muting diagnostics.
        Err(_) => eprintln!("{level}: {message}"),
    }
}

#[cfg(feature = "cuda")]
fn ensure_single_object_scalars(stats: &mut StepStats, object_id: &str) {
    if stats.per_object_scalars.is_empty() {
        stats.per_object_scalars = single_object_scalars(object_id, stats);
    }
}

fn runtime_warn_once(message: &str) {
    runtime_log_once("warning", message);
}

fn runtime_info_once(message: &str) {
    runtime_log_once("info", message);
}

#[cfg(feature = "fem-gpu")]
fn native_fem_gpu_ready_log_message(
    gpu_state: &NativeFemGpuStateInfo,
    device_info: &native_fem::DeviceInfo,
    gpu_rk_plan: Option<&NativeFemGpuRkPlanInfo>,
) -> (&'static str, String) {
    if !gpu_state.allocated {
        return (
            "warning",
            format!(
                "native FEM GPU state is not allocated; data residency={}",
                gpu_state.source_of_truth.as_str()
            ),
        );
    }

    let device_gb = gpu_state.device_bytes as f64 / 1e9;
    let reduction_mb = gpu_state.reduction_workspace_bytes as f64 / 1e6;
    let vram_free_gb = device_info.memory_free_bytes as f64 / 1e9;
    let vram_total_gb = device_info.memory_total_bytes as f64 / 1e9;
    let device_stage_ready = gpu_rk_plan.is_some_and(|plan| {
        plan.exchange_only_enabled
            && plan.stage_exchange_device_resident
            && plan.uses_gpu_poisson
            && plan.demag_operator_mode == "device_hypre_poisson"
            && plan.hypre_execution_policy == "device"
            && plan.demag_residency == "device"
    });
    if gpu_state.source_of_truth != NativeFemDataResidency::DeviceSourceOfTruth
        && !device_stage_ready
    {
        return (
            "warning",
            format!(
                "native FEM GPU buffers allocated, but data residency is {}: nodes={} dof={} stages={} device_buffers={:.3} GB reduction_workspace={:.1} MB vram_free={:.3} GB vram_total={:.3} GB",
                gpu_state.source_of_truth.as_str(),
                gpu_state.node_count,
                gpu_state.dof_len,
                gpu_state.stage_count,
                device_gb,
                reduction_mb,
                vram_free_gb,
                vram_total_gb
            ),
        );
    }

    (
        "info",
        format!(
            "native FEM GPU ready: mesh, material fields, magnetization, and demag data are loaded on the CUDA device; nodes={} dof={} stages={} device_buffers={:.3} GB reduction_workspace={:.1} MB vram_free={:.3} GB vram_total={:.3} GB initial_residency={}",
            gpu_state.node_count,
            gpu_state.dof_len,
            gpu_state.stage_count,
            device_gb,
            reduction_mb,
            vram_free_gb,
            vram_total_gb,
            gpu_state.source_of_truth.as_str()
        ),
    )
}

fn has_any_antenna_field_source(problem: &ProblemIR) -> bool {
    problem.current_modules.iter().any(|module| {
        matches!(
            module,
            fullmag_ir::CurrentModuleIR::AntennaFieldSource { .. }
        )
    })
}

fn has_prescribed_zeeman_mask_antenna(problem: &ProblemIR) -> bool {
    problem.current_modules.iter().any(|module| {
        matches!(
            module,
            fullmag_ir::CurrentModuleIR::AntennaFieldSource {
                model: fullmag_ir::AntennaFieldSourceModelIR::PrescribedZeemanMask,
                ..
            }
        )
    })
}

fn unsupported_cpu_fdm_terms(plan: &FdmPlanIR, outputs: &[OutputIR]) -> Vec<&'static str> {
    let mut unsupported = Vec::new();
    if plan.boundary_geometry.is_some() || plan.boundary_correction.is_some() {
        unsupported.push("boundary_correction");
    }
    // Fields available in CPU FDM snapshots: m, H_ex, H_demag, H_ext, H_ani, H_dmi, H_eff.
    // H_ant is not exposed as a separate observable by the reference engine.
    if outputs.iter().any(|output| match output {
        OutputIR::Field { name, .. }
        | OutputIR::FieldResolvedAuto { name, .. }
        | OutputIR::Scalar { name, .. }
        | OutputIR::ScalarResolvedAuto { name, .. } => {
            matches!(
                name.as_str(),
                "H_mel" | "u" | "u_dot" | "eps" | "sigma" | "E_mel" | "E_el" | "E_kin_el"
            )
        }
        OutputIR::Snapshot { field, .. } => {
            matches!(
                field.as_str(),
                "H_mel" | "u" | "u_dot" | "eps" | "sigma" | "H_ant"
            )
        }
        _ => false,
    }) {
        unsupported.push("unsupported_outputs");
    }
    unsupported.sort_unstable();
    unsupported.dedup();
    unsupported
}

fn magnetic_markers_from_object_segments(plan: &FemPlanIR) -> BTreeSet<u32> {
    if plan.mesh.element_markers.is_empty() {
        return BTreeSet::new();
    }
    let mut markers = BTreeSet::new();
    for segment in &plan.object_segments {
        if segment.element_count == 0 {
            continue;
        }
        let start = segment.element_start as usize;
        let end = start
            .saturating_add(segment.element_count as usize)
            .min(plan.mesh.element_markers.len());
        if start >= end {
            continue;
        }
        for marker in &plan.mesh.element_markers[start..end] {
            if *marker != 0 {
                markers.insert(*marker);
            }
        }
    }
    markers
}

fn markers_from_element_selector(
    selector: &FemMeshPartSelector,
    mesh_element_markers: &[u32],
) -> BTreeSet<u32> {
    match selector {
        FemMeshPartSelector::ElementMarkerSet { markers } => markers
            .iter()
            .copied()
            .filter(|marker| *marker != 0)
            .collect(),
        FemMeshPartSelector::ElementRange { start, count } => {
            let start = *start as usize;
            let end = start
                .saturating_add(*count as usize)
                .min(mesh_element_markers.len());
            if start >= end {
                return BTreeSet::new();
            }
            mesh_element_markers[start..end]
                .iter()
                .copied()
                .filter(|marker| *marker != 0)
                .collect()
        }
        _ => BTreeSet::new(),
    }
}

fn magnetic_markers_from_mesh_parts(plan: &FemPlanIR) -> BTreeSet<u32> {
    if plan.mesh.element_markers.is_empty() {
        return BTreeSet::new();
    }
    let mut markers = BTreeSet::new();
    for part in &plan.mesh_parts {
        if part.role != fullmag_ir::FemMeshPartRole::MagneticObject {
            continue;
        }
        markers.extend(markers_from_element_selector(
            &part.element_selector,
            &plan.mesh.element_markers,
        ));
    }
    markers
}

fn normalized_runtime_element_markers(plan: &FemPlanIR) -> Result<Vec<u32>, RunError> {
    let markers = &plan.mesh.element_markers;
    if markers.len() != plan.mesh.cell_count() {
        return Err(RunError {
            message: format!(
                "invalid FEM plan: element marker count {} differs from element count {}",
                markers.len(),
                plan.mesh.cell_count()
            ),
        });
    }

    let distinct_nonzero = markers
        .iter()
        .copied()
        .filter(|marker| *marker != 0)
        .collect::<BTreeSet<_>>();
    let has_air = markers.contains(&0);

    if !plan.region_materials.is_empty() {
        let magnetic_markers = plan
            .region_materials
            .iter()
            .map(|region| region.element_marker)
            .collect::<BTreeSet<_>>();
        if magnetic_markers.contains(&0) {
            return Err(RunError {
                message: "invalid FEM plan: region_materials must not use element_marker=0 for magnetic regions"
                    .to_string(),
            });
        }
        let unknown_nonzero = distinct_nonzero
            .difference(&magnetic_markers)
            .copied()
            .collect::<Vec<_>>();
        if !unknown_nonzero.is_empty() {
            return Err(RunError {
                message: format!(
                    "ambiguous FEM magnetic region contract: mesh contains non-zero element markers {:?} \
                     that are not declared in region_materials. Refusing to guess which regions are magnetic.",
                    unknown_nonzero
                ),
            });
        }
        return Ok(markers
            .iter()
            .map(|marker| u32::from(magnetic_markers.contains(marker)))
            .collect());
    }

    if distinct_nonzero.len() > 1 {
        let mut inferred_magnetic_markers = magnetic_markers_from_object_segments(plan);
        inferred_magnetic_markers.extend(magnetic_markers_from_mesh_parts(plan));
        if !inferred_magnetic_markers.is_empty() {
            let unknown_nonzero = distinct_nonzero
                .difference(&inferred_magnetic_markers)
                .copied()
                .collect::<Vec<_>>();
            if unknown_nonzero.is_empty() {
                return Ok(markers
                    .iter()
                    .map(|marker| u32::from(inferred_magnetic_markers.contains(marker)))
                    .collect());
            }
            return Err(RunError {
                message: format!(
                    "ambiguous FEM magnetic region contract: mesh contains non-zero element markers {:?} \
                     that are not covered by object_segments/mesh_parts-inferred magnetic markers {:?}. \
                     Refusing to guess which regions are magnetic.",
                    unknown_nonzero, inferred_magnetic_markers
                ),
            });
        }
        return Err(RunError {
            message: format!(
                "ambiguous FEM magnetic region contract: mesh uses multiple non-zero element markers {:?} \
                 without region_materials. Refusing to guess which regions are magnetic.",
                distinct_nonzero
            ),
        });
    }

    if has_air && !distinct_nonzero.is_empty() {
        Ok(markers
            .iter()
            .map(|marker| u32::from(*marker != 0))
            .collect())
    } else {
        Ok(vec![1; markers.len()])
    }
}

fn normalized_fem_plan_for_runtime(plan: &FemPlanIR) -> Result<FemPlanIR, RunError> {
    let normalized_markers = normalized_runtime_element_markers(plan)?;
    let mut normalized = plan.clone();
    normalized.mesh.element_markers = normalized_markers;
    validate_runtime_initial_magnetization(&normalized)?;
    Ok(normalized)
}

fn validate_runtime_initial_magnetization(plan: &FemPlanIR) -> Result<(), RunError> {
    let node_count = plan.mesh.nodes.len();
    if plan.mesh.element_markers.len() != plan.mesh.cell_count() {
        return Err(RunError {
            message: format!(
                "invalid FEM plan: element marker count {} does not match element count {}",
                plan.mesh.element_markers.len(),
                plan.mesh.cell_count()
            ),
        });
    }
    if plan.initial_magnetization.len() != node_count {
        return Err(RunError {
            message: format!(
                "invalid FEM plan: initial_magnetization has {} vectors but mesh has {} nodes",
                plan.initial_magnetization.len(),
                node_count
            ),
        });
    }

    let mut active_nodes = vec![plan.mesh.element_markers.is_empty(); node_count];
    for cell in plan.mesh.cells.iter() {
        let element_index = cell.ordinal;
        let marker = plan.mesh.element_markers[element_index];
        if marker == 0 {
            continue;
        }
        for node in cell.nodes {
            let node = *node as usize;
            if node >= node_count {
                return Err(RunError {
                    message: format!(
                        "invalid FEM plan: element {} references node {} outside mesh node count {}",
                        cell.global_ordinal, node, node_count
                    ),
                });
            }
            active_nodes[node] = true;
        }
    }

    for (node, (active, value)) in active_nodes
        .iter()
        .zip(plan.initial_magnetization.iter())
        .enumerate()
    {
        if !*active {
            continue;
        }
        let norm2 = value[0] * value[0] + value[1] * value[1] + value[2] * value[2];
        if !(norm2 > 0.0) || !norm2.is_finite() {
            return Err(RunError {
                message: format!(
                    "invalid FEM plan: active magnetic node {} has zero or invalid initial magnetization {:?}",
                    node, value
                ),
            });
        }
    }
    Ok(())
}

fn resolve_fdm_engine_with_registry(
    problem: &ProblemIR,
    registry: &RuntimeRegistry,
    _explicit_selection: bool,
) -> Result<DispatchEngineResolution, RunError> {
    apply_runtime_gpu_index(problem, "fdm");
    let requested_device = requested_registry_device_for_fdm(problem);
    let forced_device = requested_device != "auto";
    let requested_precision = runtime_precision(problem).to_string();
    let resolved = resolve_registry_runtime_for_backend(
        registry,
        "fdm",
        &requested_device,
        &requested_precision,
    )
    .ok_or_else(|| RunError {
        message: format!(
            "no advertised FDM runtime matches device={} precision={}",
            requested_device, requested_precision
        ),
    })?;

    let mut engine = match resolved.device.as_str() {
        "gpu" => FdmEngine::CudaFdm,
        _ => FdmEngine::CpuReference,
    };
    let mut fallback = resolved.fallback;
    let mut runtime_family = resolved.runtime_family;
    let mut worker = resolved.worker;
    let mut resolved_device = resolved.device;

    if engine == FdmEngine::CudaFdm && has_prescribed_zeeman_mask_antenna(problem) {
        if forced_device {
            return Err(RunError {
                message: "FDM CUDA execution was requested, but CUDA FDM currently does not support prescribed_zeeman_mask antenna sources (fallback_reason=antenna_zeeman_mask_force_cpu)".to_string(),
            });
        }
        let cpu_resolved =
            resolve_registry_runtime_for_backend(registry, "fdm", "cpu", &requested_precision)
                .ok_or_else(|| RunError {
                    message:
                        "FDM CUDA runtime cannot fall back because no CPU FDM runtime is advertised"
                            .to_string(),
                })?;
        let message = "FDM engine falling back to CPU reference — CUDA FDM currently does not support prescribed_zeeman_mask antenna sources (fallback_reason=antenna_zeeman_mask_force_cpu)".to_string();
        runtime_warn_once(&message);
        fallback = Some(runtime_fallback(
            fdm_engine_id(FdmEngine::CudaFdm),
            fdm_engine_id(FdmEngine::CpuReference),
            "antenna_zeeman_mask_force_cpu",
            message,
        ));
        engine = FdmEngine::CpuReference;
        runtime_family = cpu_resolved.runtime_family;
        worker = cpu_resolved.worker;
        resolved_device = cpu_resolved.device;
    }

    Ok(DispatchEngineResolution {
        engine: DispatchEngine::Fdm(engine),
        fallback,
        runtime_family: Some(runtime_family),
        worker: Some(worker),
        resolved_backend: "fdm".to_string(),
        resolved_device,
        resolved_precision: requested_precision,
        fem_crossover_decision: None,
    })
}

/// Resolve which FEM engine to use based on environment and availability.
pub(crate) fn resolve_fem_engine_with_trail(
    problem: &ProblemIR,
) -> Result<EngineResolution<FemEngine>, RunError> {
    let requested_device = effective_fem_device_request(problem);
    resolve_fem_engine_with_effective_request(problem, &requested_device)
}

fn resolve_fem_engine_with_effective_request(
    problem: &ProblemIR,
    policy: &str,
) -> Result<EngineResolution<FemEngine>, RunError> {
    apply_runtime_gpu_index(problem, "fem");
    let fe_order = runtime_fem_order(problem);
    let (policy, env_override) = effective_fem_execution_policy(problem, policy);

    let availability = native_fem::native_availability();
    resolve_fem_engine_with_availability(problem, &policy, env_override, fe_order, &availability)
}

fn effective_fem_execution_policy(problem: &ProblemIR, requested_policy: &str) -> (String, bool) {
    let ir_policy = runtime_fem_policy(problem);
    let strict_gpu = strict_fem_gpu_requested(problem);
    match std::env::var("FULLMAG_FEM_EXECUTION") {
        Ok(env_val) if strict_gpu && !fem_policy_requires_gpu(&env_val) => {
            runtime_warn_once(&format!(
                "ignoring FULLMAG_FEM_EXECUTION={} because ProblemIR requests device=gpu in strict execution mode",
                env_val
            ));
            ("gpu".to_string(), false)
        }
        Ok(env_val) => {
            if env_val != ir_policy {
                let message = format!(
                    "FULLMAG_FEM_EXECUTION={} overrides script runtime_selection.device={}",
                    env_val, ir_policy
                );
                runtime_warn_once(&message);
            }
            (env_val, true)
        }
        Err(_) if all_in_gpu_fem_env_requested() => ("all_in_gpu".to_string(), true),
        // `requested_policy` is already the canonical effective request. In
        // the plan-aware path it includes a managed launcher override and,
        // for a certified mixed-topology plan, the device bound to the plan.
        // Falling back to the raw ProblemIR policy here silently discarded
        // that request and could select the GPU lane for a CPU-bound stage.
        Err(_) => (requested_policy.to_string(), false),
    }
}

fn strict_fem_gpu_requested(problem: &ProblemIR) -> bool {
    problem.validation_profile.execution_mode == fullmag_ir::ExecutionMode::Strict
        && runtime_device(problem).is_some_and(|device| matches!(device, "gpu" | "cuda"))
}

fn native_fem_cpu_unavailable_error(
    availability: &native_fem::GpuAvailability,
    context: &str,
) -> RunError {
    RunError {
        message: format!(
            "native FEM CPU backend is not available for {}: {}",
            context, availability.reason
        ),
    }
}

const FEM_GPU_RELAXATION_CPU_ONLY_FALLBACK_REASON: &str = "fem_gpu_relaxation_algorithm_cpu_only";
const FEM_GPU_RK_PLAN_INELIGIBLE_FALLBACK_REASON: &str = "fem_gpu_rk_plan_ineligible";

fn fem_gpu_cpu_only_relaxation_algorithm(plan: &FemPlanIR) -> Option<RelaxationAlgorithmIR> {
    let algorithm = plan.relaxation.as_ref()?.algorithm;
    crate::fem::relax::algorithm::requires_cpu_mfem_relaxation_lane(algorithm).then_some(algorithm)
}

fn fem_gpu_relaxation_cpu_only_fallback_message(algorithm: RelaxationAlgorithmIR) -> String {
    format!(
        "FEM relaxation algorithm `{}` is implemented for the CPU/MFEM lane; \
         falling back to MFEM/libCEED/hypre CPU FEM because the full GPU/libCEED \
         device-resident tangent-plane solve is under development \
         (fallback_reason={})",
        crate::fem::relax::algorithm::algorithm_provenance_name(algorithm),
        FEM_GPU_RELAXATION_CPU_ONLY_FALLBACK_REASON
    )
}

fn fem_gpu_relaxation_cpu_only_error(algorithm: RelaxationAlgorithmIR) -> RunError {
    RunError {
        message: format!(
            "native FEM GPU execution was requested, but FEM relaxation algorithm `{}` \
             is implemented for the CPU/MFEM lane; the full GPU/libCEED \
             device-resident tangent-plane solve is under development \
             (fallback_reason={})",
            crate::fem::relax::algorithm::algorithm_provenance_name(algorithm),
            FEM_GPU_RELAXATION_CPU_ONLY_FALLBACK_REASON
        ),
    }
}

fn fem_gpu_rk_plan_ineligible_message(plan: &FemPlanIR) -> Option<String> {
    crate::fem::engine::gpu_rk_plan_preflight_block_reason(plan).map(|reason| {
        format!(
            "native FEM GPU explicit RK plan is ineligible: {reason} \
             (fallback_reason={FEM_GPU_RK_PLAN_INELIGIBLE_FALLBACK_REASON})"
        )
    })
}

fn fem_gpu_rk_plan_ineligible_error(message: String) -> RunError {
    RunError {
        message: format!("native FEM GPU execution was requested, but {message}"),
    }
}

fn fem_plan_gpu_request_is_forced(requested_device: &str) -> bool {
    matches!(requested_device, "gpu" | "all_in_gpu")
}

fn fem_gpu_min_nodes_threshold() -> Option<usize> {
    match std::env::var("FULLMAG_FEM_GPU_MIN_NODES") {
        Ok(raw) => match raw.trim().parse::<usize>() {
            Ok(0) => None,
            Ok(value) => Some(value),
            Err(_) => None,
        },
        Err(_) => None,
    }
}

fn should_fallback_to_cpu_for_small_fem_gpu(plan: &FemPlanIR) -> Option<usize> {
    if fem_gpu_execution_forced() {
        return None;
    }
    let min_nodes = fem_gpu_min_nodes_threshold()?;
    (plan.mesh.nodes.len() < min_nodes).then_some(min_nodes)
}

fn apply_fem_gpu_plan_constraints(
    plan: &FemPlanIR,
    mut resolution: EngineResolution<FemEngine>,
    forced_gpu: bool,
    mut fem_crossover_decision: Option<crate::types::FemCrossoverDecision>,
) -> Result<FemPlanEngineResolution, RunError> {
    if resolution.engine == FemEngine::NativeGpu {
        if let Some(algorithm) = fem_gpu_cpu_only_relaxation_algorithm(plan) {
            if forced_gpu {
                return Err(fem_gpu_relaxation_cpu_only_error(algorithm));
            }
            let message = fem_gpu_relaxation_cpu_only_fallback_message(algorithm);
            runtime_warn_once(&message);
            resolution.engine = FemEngine::CpuNative;
            resolution.fallback = Some(runtime_fallback(
                fem_engine_id(FemEngine::NativeGpu),
                fem_engine_id(FemEngine::CpuNative),
                FEM_GPU_RELAXATION_CPU_ONLY_FALLBACK_REASON,
                message,
            ));
        } else if let Some(decision) = fem_crossover_decision.as_ref() {
            if decision.resolved == "cpu" {
                let message = format!(
                    "FEM auto-device policy resolved {} nodes to CPU ({})",
                    plan.mesh.nodes.len(),
                    decision.reason
                );
                resolution.engine = FemEngine::CpuNative;
                resolution.fallback = Some(runtime_fallback(
                    fem_engine_id(FemEngine::NativeGpu),
                    fem_engine_id(FemEngine::CpuNative),
                    &decision.reason,
                    message,
                ));
            }
        }
    }

    if resolution.engine == FemEngine::NativeGpu {
        if let Some(message) = fem_gpu_rk_plan_ineligible_message(plan) {
            if forced_gpu {
                return Err(fem_gpu_rk_plan_ineligible_error(message));
            }
            runtime_warn_once(&message);
            resolution.engine = FemEngine::CpuNative;
            resolution.fallback = Some(runtime_fallback(
                fem_engine_id(FemEngine::NativeGpu),
                fem_engine_id(FemEngine::CpuNative),
                FEM_GPU_RK_PLAN_INELIGIBLE_FALLBACK_REASON,
                message,
            ));
            return Ok(FemPlanEngineResolution {
                engine: resolution.engine,
                fallback: resolution.fallback,
                fem_crossover_decision,
            });
        }
    }

    if let Some(min_nodes) = should_fallback_to_cpu_for_small_fem_gpu(plan) {
        if forced_gpu {
            return Err(RunError {
                message: format!(
                    "native FEM GPU execution was requested, but plan has {} nodes below FULLMAG_FEM_GPU_MIN_NODES={} (fallback_reason=fem_gpu_small_mesh_policy)",
                    plan.mesh.nodes.len(),
                    min_nodes
                ),
            });
        }
        let message = format!(
            "FEM plan has {} nodes, below FULLMAG_FEM_GPU_MIN_NODES={} — falling back to MFEM/libCEED/hypre CPU FEM engine",
            plan.mesh.nodes.len(),
            min_nodes
        );
        resolution.engine = FemEngine::CpuNative;
        resolution.fallback = Some(runtime_fallback(
            fem_engine_id(FemEngine::NativeGpu),
            fem_engine_id(FemEngine::CpuNative),
            "fem_gpu_small_mesh_policy",
            message,
        ));
    }

    Ok(FemPlanEngineResolution {
        engine: resolution.engine,
        fallback: resolution.fallback,
        fem_crossover_decision,
    })
}

fn reconcile_pinned_fem_crossover_decision(
    mut decision: Option<crate::types::FemCrossoverDecision>,
    resolved_device: &str,
    fallback: Option<&ResolvedFallback>,
) -> Option<crate::types::FemCrossoverDecision> {
    if let Some(decision) = decision.as_mut() {
        decision.resolved = resolved_device.to_string();
        if let Some(fallback) = fallback {
            decision.reason = fallback.reason.clone();
        }
    }
    decision
}

fn resolve_fem_engine_with_availability(
    problem: &ProblemIR,
    policy: &str,
    env_override: bool,
    fe_order: u32,
    availability: &native_fem::GpuAvailability,
) -> Result<EngineResolution<FemEngine>, RunError> {
    let strict_gpu = strict_fem_gpu_requested(problem);
    let policy = if strict_gpu { "gpu" } else { policy };
    let forced_gpu = env_override || strict_gpu;
    if has_any_antenna_field_source(problem) {
        if fem_policy_requires_gpu(policy) {
            return Err(RunError {
                message:
                    "FEM GPU execution was requested, but native FEM GPU currently does not support antenna_field_source current_modules (fallback_reason=current_modules_force_cpu)"
                        .to_string(),
            });
        }
        if !availability.native_fem_cpu_available {
            return Err(native_fem_cpu_unavailable_error(
                availability,
                "current_modules_force_cpu fallback",
            ));
        }
        let message = "FEM engine falling back to MFEM/libCEED/hypre CPU FEM — native FEM GPU does not support antenna_field_source current_modules (fallback_reason=current_modules_force_cpu)".to_string();
        runtime_warn_once(&message);
        return Ok(EngineResolution {
            engine: FemEngine::CpuNative,
            fallback: Some(runtime_fallback(
                fem_engine_id(FemEngine::NativeGpu),
                fem_engine_id(FemEngine::CpuNative),
                "current_modules_force_cpu",
                message,
            )),
        });
    }

    match policy {
        "cpu" => {
            if !availability.native_fem_cpu_available {
                return Err(native_fem_cpu_unavailable_error(
                    availability,
                    "requested FEM CPU execution",
                ));
            }
            Ok(EngineResolution {
                engine: FemEngine::CpuNative,
                fallback: None,
            })
        }
        "gpu" | "all_in_gpu" => {
            if !availability.native_fem_gpu_available {
                if forced_gpu {
                    Err(RunError {
                        message: format!(
                            "{} requested FEM GPU execution, but the native FEM GPU backend is not available: {}",
                            if strict_gpu { "strict ProblemIR" } else { "FULLMAG_FEM_EXECUTION=gpu" },
                            availability.reason,
                        ),
                    })
                } else {
                    if !availability.native_fem_cpu_available {
                        return Err(native_fem_cpu_unavailable_error(
                            availability,
                            "non-forced FEM GPU fallback",
                        ));
                    }
                    let message = format!(
                        "script requested FEM GPU execution, but the native FEM GPU backend is not available: {} — falling back to MFEM/libCEED/hypre CPU FEM engine",
                        availability.reason
                    );
                    runtime_warn_once(&message);
                    Ok(EngineResolution {
                        engine: FemEngine::CpuNative,
                        fallback: Some(runtime_fallback(
                            fem_engine_id(FemEngine::NativeGpu),
                            fem_engine_id(FemEngine::CpuNative),
                            "native_fem_gpu_unavailable",
                            message,
                        )),
                    })
                }
            } else if !availability.native_fem_gpu_full_demag_available
                && fem_policy_requires_gpu(policy)
            {
                Err(RunError {
                    message: format!(
                        "FEM GPU execution was requested, but strict full-in-GPU demag is unavailable: {} (fallback_reason=native_fem_gpu_full_demag_unavailable)",
                        availability.reason_gpu
                    ),
                })
            } else if fe_order != 1 {
                if forced_gpu {
                    Err(RunError {
                        message: format!(
                            "forced FEM GPU execution requested native FEM GPU execution, \
                             but the current native backend supports fe_order=1 only \
                             (requested order={}, fallback_reason=fem_gpu_fe_order_unsupported)",
                            fe_order
                        ),
                    })
                } else {
                    if !availability.native_fem_cpu_available {
                        return Err(native_fem_cpu_unavailable_error(
                            availability,
                            "FEM GPU fe_order fallback",
                        ));
                    }
                    let message = format!(
                        "native FEM GPU backend currently supports fe_order=1 only; falling back to MFEM/libCEED/hypre CPU FEM for requested fe_order={} (fallback_reason=fem_gpu_fe_order_unsupported)",
                        fe_order
                    );
                    runtime_warn_once(&message);
                    Ok(EngineResolution {
                        engine: FemEngine::CpuNative,
                        fallback: Some(runtime_fallback(
                            fem_engine_id(FemEngine::NativeGpu),
                            fem_engine_id(FemEngine::CpuNative),
                            "fem_gpu_fe_order_unsupported",
                            message,
                        )),
                    })
                }
            } else {
                Ok(EngineResolution {
                    engine: FemEngine::NativeGpu,
                    fallback: None,
                })
            }
        }
        "auto" | _ => {
            if availability.native_fem_gpu_available && fe_order == 1 {
                Ok(EngineResolution {
                    engine: FemEngine::NativeGpu,
                    fallback: None,
                })
            } else if availability.native_fem_gpu_available && fe_order != 1 {
                if !availability.native_fem_cpu_available {
                    return Err(native_fem_cpu_unavailable_error(
                        availability,
                        "FEM auto fe_order fallback",
                    ));
                }
                let message = format!(
                    "native FEM GPU backend currently supports fe_order=1 only; falling back to MFEM/libCEED/hypre CPU FEM for requested fe_order={} (fallback_reason=fem_gpu_fe_order_unsupported)",
                    fe_order
                );
                runtime_warn_once(&message);
                Ok(EngineResolution {
                    engine: FemEngine::CpuNative,
                    fallback: Some(runtime_fallback(
                        fem_engine_id(FemEngine::NativeGpu),
                        fem_engine_id(FemEngine::CpuNative),
                        "fem_gpu_fe_order_unsupported",
                        message,
                    )),
                })
            } else {
                if !availability.native_fem_cpu_available {
                    return Err(native_fem_cpu_unavailable_error(
                        availability,
                        "FEM auto execution",
                    ));
                }
                let message = format!(
                    "native FEM GPU backend is not available — using MFEM/libCEED/hypre CPU FEM engine (fallback_reason=native_fem_gpu_unavailable; reason={})",
                    availability.reason
                );
                runtime_info_once(&message);
                Ok(EngineResolution {
                    engine: FemEngine::CpuNative,
                    fallback: Some(runtime_fallback(
                        fem_engine_id(FemEngine::NativeGpu),
                        fem_engine_id(FemEngine::CpuNative),
                        "native_fem_gpu_unavailable",
                        message,
                    )),
                })
            }
        }
    }
}

pub(crate) fn resolve_fem_engine(problem: &ProblemIR) -> Result<FemEngine, RunError> {
    resolve_fem_engine_with_trail(problem).map(|resolution| resolution.engine)
}

fn resolve_fem_engine_with_registry(
    problem: &ProblemIR,
    registry: &RuntimeRegistry,
    _explicit_selection: bool,
    plan: Option<&FemPlanIR>,
    preview_enabled: bool,
) -> Result<DispatchEngineResolution, RunError> {
    apply_runtime_gpu_index(problem, "fem");
    let requested_device = if strict_fem_gpu_requested(problem) {
        "gpu".to_string()
    } else {
        plan.map_or_else(
            || effective_fem_device_request(problem),
            |plan| effective_fem_device_request_for_plan(problem, plan),
        )
    };
    let forced_device = requested_device != "auto";
    let fem_crossover_decision = plan
        .filter(|_| !forced_device)
        .map(|plan| resolve_auto_fem_plan_device(plan, preview_enabled));
    let requested_precision = runtime_precision(problem).to_string();
    let resolved = resolve_registry_runtime_for_backend(
        registry,
        "fem",
        &requested_device,
        &requested_precision,
    )
    .ok_or_else(|| RunError {
        message: format!(
            "no advertised FEM runtime matches device={} precision={}",
            requested_device, requested_precision
        ),
    })?;

    let engine = match resolved.device.as_str() {
        "gpu" => FemEngine::NativeGpu,
        _ => FemEngine::CpuNative,
    };
    let mut fallback = resolved.fallback;

    if engine == FemEngine::NativeGpu {
        if has_any_antenna_field_source(problem) {
            if forced_device {
                return Err(RunError {
                    message:
                        "FEM GPU execution was requested, but native FEM GPU currently does not support antenna_field_source current_modules (fallback_reason=current_modules_force_cpu)"
                            .to_string(),
                });
            }
            let cpu_resolved =
                resolve_registry_runtime_for_backend(registry, "fem", "cpu", &requested_precision)
                    .ok_or_else(|| {
                        RunError {
                message: "FEM GPU runtime cannot fall back because no CPU FEM runtime is advertised"
                    .to_string(),
            }
                    })?;
            let message = "FEM engine falling back to MFEM/libCEED/hypre CPU FEM — native FEM GPU does not support antenna_field_source current_modules (fallback_reason=current_modules_force_cpu)".to_string();
            fallback = Some(runtime_fallback(
                fem_engine_id(FemEngine::NativeGpu),
                fem_engine_id(FemEngine::CpuNative),
                "current_modules_force_cpu",
                message,
            ));
            let fem_crossover_decision = reconcile_pinned_fem_crossover_decision(
                fem_crossover_decision,
                "cpu",
                fallback.as_ref(),
            );
            return Ok(DispatchEngineResolution {
                engine: DispatchEngine::Fem(FemEngine::CpuNative),
                fallback,
                runtime_family: Some(cpu_resolved.runtime_family),
                worker: Some(cpu_resolved.worker),
                resolved_backend: "fem".to_string(),
                resolved_device: "cpu".to_string(),
                resolved_precision: requested_precision,
                fem_crossover_decision,
            });
        }

        let fe_order = runtime_fem_order(problem);
        if fe_order != 1 {
            if forced_device {
                return Err(RunError {
                    message: format!(
                        "native FEM GPU execution was requested, but the current native backend supports fe_order=1 only (requested order={}, fallback_reason=fem_gpu_fe_order_unsupported)",
                        fe_order
                    ),
                });
            }
            let cpu_resolved =
                resolve_registry_runtime_for_backend(registry, "fem", "cpu", &requested_precision)
                    .ok_or_else(|| {
                        RunError {
                message: "FEM GPU runtime cannot fall back because no CPU FEM runtime is advertised"
                    .to_string(),
            }
                    })?;
            let message = format!(
                "native FEM GPU backend currently supports fe_order=1 only; falling back to MFEM/libCEED/hypre CPU FEM for requested fe_order={} (fallback_reason=fem_gpu_fe_order_unsupported)",
                fe_order
            );
            fallback = Some(runtime_fallback(
                fem_engine_id(FemEngine::NativeGpu),
                fem_engine_id(FemEngine::CpuNative),
                "fem_gpu_fe_order_unsupported",
                message,
            ));
            let fem_crossover_decision = reconcile_pinned_fem_crossover_decision(
                fem_crossover_decision,
                "cpu",
                fallback.as_ref(),
            );
            return Ok(DispatchEngineResolution {
                engine: DispatchEngine::Fem(FemEngine::CpuNative),
                fallback,
                runtime_family: Some(cpu_resolved.runtime_family),
                worker: Some(cpu_resolved.worker),
                resolved_backend: "fem".to_string(),
                resolved_device: "cpu".to_string(),
                resolved_precision: requested_precision,
                fem_crossover_decision,
            });
        }

        if let Some(fem_plan) = plan {
            if let Some(algorithm) = fem_gpu_cpu_only_relaxation_algorithm(fem_plan) {
                if forced_device {
                    return Err(fem_gpu_relaxation_cpu_only_error(algorithm));
                }
                let cpu_resolved = resolve_registry_runtime_for_backend(
                    registry,
                    "fem",
                    "cpu",
                    &requested_precision,
                )
                .ok_or_else(|| RunError {
                    message:
                        "FEM GPU runtime cannot fall back because no CPU FEM runtime is advertised"
                            .to_string(),
                })?;
                let message = fem_gpu_relaxation_cpu_only_fallback_message(algorithm);
                fallback = Some(runtime_fallback(
                    fem_engine_id(FemEngine::NativeGpu),
                    fem_engine_id(FemEngine::CpuNative),
                    FEM_GPU_RELAXATION_CPU_ONLY_FALLBACK_REASON,
                    message,
                ));
                let fem_crossover_decision = reconcile_pinned_fem_crossover_decision(
                    fem_crossover_decision,
                    "cpu",
                    fallback.as_ref(),
                );
                return Ok(DispatchEngineResolution {
                    engine: DispatchEngine::Fem(FemEngine::CpuNative),
                    fallback,
                    runtime_family: Some(cpu_resolved.runtime_family),
                    worker: Some(cpu_resolved.worker),
                    resolved_backend: "fem".to_string(),
                    resolved_device: "cpu".to_string(),
                    resolved_precision: requested_precision,
                    fem_crossover_decision,
                });
            }
        }

        if let Some(fem_plan) = plan {
            if !forced_device {
                let decision = fem_crossover_decision
                    .as_ref()
                    .expect("auto FEM plan must produce a crossover decision");
                if decision.resolved == "cpu" {
                    let cpu_resolved = resolve_registry_runtime_for_backend(
                        registry,
                        "fem",
                        "cpu",
                        &requested_precision,
                    )
                    .ok_or_else(|| {
                        RunError {
                    message:
                        "FEM GPU runtime cannot fall back because no CPU FEM runtime is advertised"
                            .to_string(),
                }
                    })?;
                    let message = format!(
                        "FEM auto-device policy resolved {} nodes to CPU ({})",
                        fem_plan.mesh.nodes.len(),
                        decision.reason
                    );
                    fallback = Some(runtime_fallback(
                        fem_engine_id(FemEngine::NativeGpu),
                        fem_engine_id(FemEngine::CpuNative),
                        &decision.reason,
                        message,
                    ));
                    let fem_crossover_decision = reconcile_pinned_fem_crossover_decision(
                        fem_crossover_decision,
                        "cpu",
                        fallback.as_ref(),
                    );
                    return Ok(DispatchEngineResolution {
                        engine: DispatchEngine::Fem(FemEngine::CpuNative),
                        fallback,
                        runtime_family: Some(cpu_resolved.runtime_family),
                        worker: Some(cpu_resolved.worker),
                        resolved_backend: "fem".to_string(),
                        resolved_device: "cpu".to_string(),
                        resolved_precision: requested_precision,
                        fem_crossover_decision,
                    });
                }
            }
        }
    }

    let fem_crossover_decision = reconcile_pinned_fem_crossover_decision(
        fem_crossover_decision,
        &resolved.device,
        fallback.as_ref(),
    );
    Ok(DispatchEngineResolution {
        engine: DispatchEngine::Fem(engine),
        fallback,
        runtime_family: Some(resolved.runtime_family),
        worker: Some(resolved.worker),
        resolved_backend: "fem".to_string(),
        resolved_device: resolved.device,
        resolved_precision: requested_precision,
        fem_crossover_decision,
    })
}

pub(crate) fn resolve_with_registry(
    problem: &ProblemIR,
    registry: Option<&RuntimeRegistry>,
    explicit_selection: bool,
    preview_enabled: bool,
) -> Result<DispatchEngineResolution, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    match registry {
        Some(registry) => match &plan.backend_plan {
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => {
                resolve_fdm_engine_with_registry(problem, registry, explicit_selection)
            }
            BackendPlanIR::Fem(fem) => resolve_fem_engine_with_registry(
                problem,
                registry,
                explicit_selection,
                Some(fem),
                preview_enabled,
            ),
            BackendPlanIR::FemEigen(_) => {
                resolve_fem_engine_with_registry(problem, registry, explicit_selection, None, false)
            }
            BackendPlanIR::FemFrequencyResponse(_) => {
                resolve_fem_engine_with_registry(problem, registry, explicit_selection, None, false)
            }
        },
        None => match &plan.backend_plan {
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => {
                let resolution = resolve_fdm_engine_with_trail(problem)?;
                Ok(DispatchEngineResolution {
                    engine: DispatchEngine::Fdm(resolution.engine),
                    fallback: resolution.fallback,
                    runtime_family: None,
                    worker: None,
                    resolved_backend: "fdm".to_string(),
                    resolved_device: match resolution.engine {
                        FdmEngine::CudaFdm => "gpu".to_string(),
                        FdmEngine::CpuReference => "cpu".to_string(),
                    },
                    resolved_precision: runtime_precision(problem).to_string(),
                    fem_crossover_decision: None,
                })
            }
            BackendPlanIR::Fem(fem) => {
                let resolution =
                    resolve_fem_engine_for_plan_with_trail(problem, fem, preview_enabled)?;
                Ok(DispatchEngineResolution {
                    engine: DispatchEngine::Fem(resolution.engine),
                    fallback: resolution.fallback,
                    runtime_family: None,
                    worker: None,
                    resolved_backend: "fem".to_string(),
                    resolved_device: match resolution.engine {
                        FemEngine::NativeGpu => "gpu".to_string(),
                        FemEngine::CpuNative => "cpu".to_string(),
                    },
                    resolved_precision: runtime_precision(problem).to_string(),
                    fem_crossover_decision: resolution.fem_crossover_decision,
                })
            }
            BackendPlanIR::FemEigen(_) => {
                let resolution = resolve_fem_engine_with_trail(problem)?;
                Ok(DispatchEngineResolution {
                    engine: DispatchEngine::Fem(resolution.engine),
                    fallback: resolution.fallback,
                    runtime_family: None,
                    worker: None,
                    resolved_backend: "fem".to_string(),
                    resolved_device: match resolution.engine {
                        FemEngine::NativeGpu => "gpu".to_string(),
                        FemEngine::CpuNative => "cpu".to_string(),
                    },
                    resolved_precision: runtime_precision(problem).to_string(),
                    fem_crossover_decision: None,
                })
            }
            BackendPlanIR::FemFrequencyResponse(_) => {
                let resolution = resolve_fem_engine_with_trail(problem)?;
                Ok(DispatchEngineResolution {
                    engine: DispatchEngine::Fem(resolution.engine),
                    fallback: resolution.fallback,
                    runtime_family: None,
                    worker: None,
                    resolved_backend: "fem".to_string(),
                    resolved_device: match resolution.engine {
                        FemEngine::NativeGpu => "gpu".to_string(),
                        FemEngine::CpuNative => "cpu".to_string(),
                    },
                    resolved_precision: runtime_precision(problem).to_string(),
                    fem_crossover_decision: None,
                })
            }
        },
    }
}

pub(crate) fn resolve_fem_engine_for_plan_with_trail(
    problem: &ProblemIR,
    plan: &FemPlanIR,
    preview_enabled: bool,
) -> Result<FemPlanEngineResolution, RunError> {
    if !native_fem::is_cpu_available() {
        return Err(RunError {
            message:
                "time-domain FEM execution requires the MFEM/libCEED runtime stack, but this launcher \
                 does not report native FEM CPU availability. Use the managed FEM runtime or rebuild \
                 the launcher with MFEM/libCEED/hypre CPU support."
                    .to_string(),
        });
    }
    if !plan.spin_transport_plans.is_empty() {
        if fem_gpu_execution_forced() || strict_fem_gpu_requested(problem) {
            return Err(RunError {
                message: "FEM steady spin transport is qualified only for CPU-double; an explicit GPU execution request cannot fall back before provenance".to_string(),
            });
        }
        return Ok(FemPlanEngineResolution {
            engine: FemEngine::CpuNative,
            fallback: None,
            fem_crossover_decision: None,
        });
    }
    let requested_device = effective_fem_device_request_for_plan(problem, plan);
    let fem_crossover_decision =
        (requested_device == "auto").then(|| resolve_auto_fem_plan_device(plan, preview_enabled));
    apply_fem_gpu_plan_constraints(
        plan,
        resolve_fem_engine_with_effective_request(problem, &requested_device)?,
        fem_plan_gpu_request_is_forced(&requested_device),
        fem_crossover_decision,
    )
}

pub(crate) fn snapshot_fdm_preview(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    request: &LivePreviewRequest,
) -> Result<crate::LivePreviewField, RunError> {
    let requested = [request.quantity.as_str()];
    if active_fdm_preview_quantities(engine, plan, &requested).is_empty() {
        return Err(RunError {
            message: format!(
                "preview quantity '{}' is not active for the current FDM problem",
                request.quantity
            ),
        });
    }
    match engine {
        FdmEngine::CpuReference => cpu_reference::snapshot_preview(plan, request),
        FdmEngine::CudaFdm => snapshot_native_fdm_preview(plan, request),
    }
}

pub(crate) fn snapshot_fdm_vector_fields(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    let quantities = active_fdm_preview_quantities(engine, plan, quantities);
    match engine {
        FdmEngine::CpuReference => {
            cpu_reference::snapshot_vector_fields(plan, &quantities, request)
        }
        FdmEngine::CudaFdm => snapshot_native_fdm_vector_fields(plan, &quantities, request),
    }
}

pub(crate) fn snapshot_fem_preview(
    engine: FemEngine,
    plan: &FemPlanIR,
    request: &LivePreviewRequest,
) -> Result<crate::LivePreviewField, RunError> {
    let requested = [request.quantity.as_str()];
    if active_fem_preview_quantities(engine, plan, &requested).is_empty() {
        return Err(RunError {
            message: format!(
                "preview quantity '{}' is not active for the current FEM problem",
                request.quantity
            ),
        });
    }
    if !fem_static_periodic_decision(plan).is_native() {
        return fem_baseline::snapshot_preview(plan, request);
    }
    match engine {
        FemEngine::CpuNative => {
            let cpu_plan = fem_plan_for_cpu_native(plan);
            snapshot_native_fem_preview(&cpu_plan, request)
        }
        FemEngine::NativeGpu => {
            let gpu_plan = fem_plan_for_native_gpu(plan);
            snapshot_native_fem_preview(&gpu_plan, request)
        }
    }
}

pub(crate) fn snapshot_fem_vector_fields(
    engine: FemEngine,
    plan: &FemPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    let quantities = active_fem_preview_quantities(engine, plan, quantities);
    if !fem_static_periodic_decision(plan).is_native() {
        return fem_baseline::snapshot_vector_fields(plan, &quantities, request);
    }
    match engine {
        FemEngine::CpuNative => {
            let cpu_plan = fem_plan_for_cpu_native(plan);
            snapshot_native_fem_vector_fields(&cpu_plan, &quantities, request)
        }
        FemEngine::NativeGpu => {
            let gpu_plan = fem_plan_for_native_gpu(plan);
            snapshot_native_fem_vector_fields(&gpu_plan, &quantities, request)
        }
    }
}

fn fem_plan_for_cpu_native(plan: &FemPlanIR) -> FemPlanIR {
    let mut cpu_plan = plan.clone();
    if cpu_plan.mfem_device_string.is_none() {
        cpu_plan.mfem_device_string = Some("cpu".to_string());
    }
    cpu_plan
}

fn fem_plan_for_native_gpu(plan: &FemPlanIR) -> FemPlanIR {
    let mut gpu_plan = plan.clone();
    if gpu_plan.mfem_device_string.is_none() {
        let mfem_device = std::env::var("FULLMAG_FEM_MFEM_DEVICE")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| crate::native_fem::native_fem_mfem_device_string_requests_gpu(value))
            .unwrap_or_else(|| "cuda".to_string());
        gpu_plan.mfem_device_string = Some(mfem_device);
    }
    gpu_plan
}

/// Which execution lane to use for FEM static/time-domain PBC.
///
/// Ordered from most capable to least capable. The dispatcher picks the
/// highest lane that is fully supported by the available runtime and by the
/// terms present in the plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FemStaticPbcLane {
    /// No periodic node pairs — native path unconditionally.
    None,
    /// Exchange + uniform Zeeman only. Native FEM PBC is fully supported.
    NativeExchangeOnly,
    /// Exchange + local uniaxial/cubic anisotropy (no demag, no DMI).
    /// Native FEM PBC is supported after PR-2 guards are in place.
    NativeAnisotropy,
    /// Exchange + demag (no DMI) via algebraic P^T A P reduction in the
    /// MFEM/hypre Poisson solver.  Requires FULLMAG_HAS_MFEM_STACK.
    /// May also include local anisotropy alongside demag.
    NativeDemagPoisson,
    /// DMI is present — uses P^T operator class projection in the
    /// Rust CPU reference solver (PR-5A).  Demag may also be present here.
    /// Native DMI PBC (PR-5B) will promote this to NativeDemagPoisson once
    /// the native guard is lifted.
    ///
    /// Note: after PR-5B this variant is no longer reached for DMI-only cases.
    /// It remains available as a fallback and for future operator types that
    /// require full algebraic reduction.
    #[allow(dead_code)]
    ReferenceReduction,
    /// Terms that cannot be handled by any available periodic path
    /// (magnetoelastic, thermal, STT, Oersted, …).
    Unsupported,
}

/// Result of the FEM static PBC capability decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FemStaticPbcDecision {
    pub lane: FemStaticPbcLane,
    /// Human-readable explanation for the chosen lane (especially for
    /// fallbacks and unsupported cases).
    pub reason: Option<String>,
    /// Interactions that could not be accommodated by the native path.
    pub unsupported_interactions: Vec<String>,
}

impl FemStaticPbcDecision {
    fn native(lane: FemStaticPbcLane) -> Self {
        Self {
            lane,
            reason: None,
            unsupported_interactions: Vec::new(),
        }
    }

    #[allow(dead_code)]
    fn reference_reduction(reason: impl Into<String>) -> Self {
        Self {
            lane: FemStaticPbcLane::ReferenceReduction,
            reason: Some(reason.into()),
            unsupported_interactions: Vec::new(),
        }
    }

    fn unsupported(reason: impl Into<String>, interactions: Vec<String>) -> Self {
        Self {
            lane: FemStaticPbcLane::Unsupported,
            reason: Some(reason.into()),
            unsupported_interactions: interactions,
        }
    }

    /// Returns `true` if the native FEM backend can execute this plan
    /// without any fallback to the Rust reference solver.
    pub fn is_native(&self) -> bool {
        matches!(
            self.lane,
            FemStaticPbcLane::None
                | FemStaticPbcLane::NativeExchangeOnly
                | FemStaticPbcLane::NativeAnisotropy
                | FemStaticPbcLane::NativeDemagPoisson
        )
    }
}

/// Decide which execution lane to use for a FEM plan that may carry
/// static/time-domain periodic node pairs.
///
/// This function encodes the capability matrix for FEM static PBC:
///
/// | Terms present                        | Lane                     |
/// |--------------------------------------|--------------------------|
/// | no periodic pairs                    | None (native)            |
/// | exchange + Zeeman only               | NativeExchangeOnly       |
/// | exchange + local anisotropy          | NativeAnisotropy         |
/// | exchange + DMI (no demag)            | NativeAnisotropy         |
/// | exchange + demag (no DMI)            | NativeDemagPoisson       |
/// | exchange + demag + anisotropy        | NativeDemagPoisson       |
/// | exchange + demag + DMI               | NativeDemagPoisson       |
/// | thermal / STT / Oersted / MEL        | Unsupported              |
fn fem_static_periodic_decision(plan: &FemPlanIR) -> FemStaticPbcDecision {
    if plan.mesh.periodic_node_pairs.is_empty() {
        return FemStaticPbcDecision::native(FemStaticPbcLane::None);
    }

    // Hard unsupported: terms that have no periodic path at all.
    let mut unsupported = Vec::new();
    if plan.temperature.unwrap_or(0.0) > 0.0 {
        unsupported.push("thermal_noise".to_string());
    }
    if plan.current_density.is_some() || plan.stt_spin_polarization.is_some() {
        unsupported.push("stt".to_string());
    }
    if plan.has_oersted_cylinder
        || plan
            .oersted_field_xyz
            .as_ref()
            .map_or(false, |v| !v.is_empty())
    {
        unsupported.push("oersted".to_string());
    }
    if plan.magnetoelastic.is_some() {
        unsupported.push("magnetoelastic".to_string());
    }
    if !unsupported.is_empty() {
        return FemStaticPbcDecision::unsupported(
            format!(
                "FEM static/time-domain PBC does not support: {}. \
                 These terms require non-periodic boundary conditions or \
                 non-local operators that have no algebraic periodic reduction.",
                unsupported.join(", ")
            ),
            unsupported,
        );
    }

    // Terms that require Rust reference algebraic reduction (P^T A P).
    let has_demag = plan.enable_demag;
    let has_dmi = plan.interfacial_dmi.is_some()
        || plan.bulk_dmi.is_some()
        || plan.dind_field.as_ref().map_or(false, |v| !v.is_empty())
        || plan.dbulk_field.as_ref().map_or(false, |v| !v.is_empty());

    // DMI: native backend now supports PBC via class-projected volume operator (PR-5B).
    // DMI + demag: uses native Poisson demag (PR-4) + class projection for DMI.
    // DMI without demag: uses native exchange+DMI path with anisotropy lane.
    if has_dmi && has_demag {
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeDemagPoisson);
    }
    if has_dmi {
        // No demag; route via NativeAnisotropy (native backend, handles DMI projection).
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeAnisotropy);
    }

    // Demag without DMI: native MFEM/hypre P^T A P Poisson path (PR-4).
    if has_demag {
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeDemagPoisson);
    }

    // Local anisotropy: native backend supports this after PR-2.
    let has_anisotropy = plan.material.uniaxial_anisotropy.is_some()
        || plan.material.uniaxial_anisotropy_k2.is_some()
        || plan.material.cubic_anisotropy_kc1.is_some()
        || plan.material.cubic_anisotropy_kc2.is_some()
        || plan.material.cubic_anisotropy_kc3.is_some()
        || plan
            .material
            .ku_field
            .as_ref()
            .map_or(false, |v| !v.is_empty())
        || plan
            .material
            .ku2_field
            .as_ref()
            .map_or(false, |v| !v.is_empty())
        || plan
            .material
            .kc1_field
            .as_ref()
            .map_or(false, |v| !v.is_empty())
        || plan
            .material
            .kc2_field
            .as_ref()
            .map_or(false, |v| !v.is_empty())
        || plan
            .material
            .kc3_field
            .as_ref()
            .map_or(false, |v| !v.is_empty());

    if has_anisotropy {
        // Native FEM supports local anisotropy PBC.
        // The native guard in context.cpp validates per-class field consistency.
        return FemStaticPbcDecision::native(FemStaticPbcLane::NativeAnisotropy);
    }

    // Exchange + Zeeman only: fully supported by native.
    FemStaticPbcDecision::native(FemStaticPbcLane::NativeExchangeOnly)
}

/// Legacy helper used at call sites that only need a binary "can the native
/// backend handle this?" answer.
#[allow(dead_code)]
fn fem_static_periodic_native_exchange_supported(plan: &FemPlanIR) -> bool {
    fem_static_periodic_decision(plan).is_native()
}

#[cfg(feature = "cuda")]
fn snapshot_native_fdm_preview(
    plan: &FdmPlanIR,
    request: &LivePreviewRequest,
) -> Result<crate::LivePreviewField, RunError> {
    let backend = NativeFdmBackend::create(plan)?;
    backend.copy_live_preview_field(request, plan.grid.cells, plan.active_mask.as_deref())
}

#[cfg(feature = "cuda")]
fn snapshot_native_fdm_vector_fields(
    plan: &FdmPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    let backend = NativeFdmBackend::create(plan)?;
    let mut cached = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for quantity in quantities
        .iter()
        .filter_map(|quantity| normalized_quantity_name(quantity).ok())
    {
        if !seen.insert(quantity) {
            continue;
        }
        let mut preview_request = request.clone();
        preview_request.quantity = quantity.to_string();
        cached.push(backend.copy_live_preview_field(
            &preview_request,
            plan.grid.cells,
            plan.active_mask.as_deref(),
        )?);
    }

    Ok(cached)
}

#[cfg(not(feature = "cuda"))]
fn snapshot_native_fdm_preview(
    _plan: &FdmPlanIR,
    _request: &LivePreviewRequest,
) -> Result<crate::LivePreviewField, RunError> {
    Err(RunError {
        message: "CUDA FDM preview snapshot requested but fullmag-runner was built without the 'cuda' feature".to_string(),
    })
}

#[cfg(not(feature = "cuda"))]
fn snapshot_native_fdm_vector_fields(
    _plan: &FdmPlanIR,
    _quantities: &[&str],
    _request: &LivePreviewRequest,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    Err(RunError {
        message: "CUDA FDM vector-field cache requested but fullmag-runner was built without the 'cuda' feature".to_string(),
    })
}

#[cfg(feature = "fem-gpu")]
fn snapshot_native_fem_preview(
    plan: &FemPlanIR,
    request: &LivePreviewRequest,
) -> Result<crate::LivePreviewField, RunError> {
    let mut backend = NativeFemBackend::create(plan)?;
    // Compute effective fields (exchange, demag, H_eff, …) so that
    // copy_live_preview_field finds populated vectors for every observable.
    let node_count = plan.mesh.nodes.len();
    let _ = backend.snapshot_step_stats(node_count)?;
    backend.copy_live_preview_field(request, node_count)
}

#[cfg(feature = "fem-gpu")]
fn snapshot_native_fem_vector_fields(
    plan: &FemPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    let mut backend = NativeFemBackend::create(plan)?;
    // Compute effective fields so that non-magnetization observables are available.
    let node_count = plan.mesh.nodes.len();
    let _ = backend.snapshot_step_stats(node_count)?;
    let mut cached = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for quantity in quantities
        .iter()
        .filter_map(|quantity| normalized_quantity_name(quantity).ok())
    {
        if !seen.insert(quantity) {
            continue;
        }
        let mut preview_request = request.clone();
        preview_request.quantity = quantity.to_string();
        cached.push(backend.copy_live_preview_field(&preview_request, plan.mesh.nodes.len())?);
    }

    Ok(cached)
}

#[cfg(not(feature = "fem-gpu"))]
fn snapshot_native_fem_preview(
    _plan: &FemPlanIR,
    _request: &LivePreviewRequest,
) -> Result<crate::LivePreviewField, RunError> {
    Err(RunError {
        message: "native FEM preview snapshot requested but fullmag-runner was built without the 'fem-gpu' feature".to_string(),
    })
}

#[cfg(not(feature = "fem-gpu"))]
fn snapshot_native_fem_vector_fields(
    _plan: &FemPlanIR,
    _quantities: &[&str],
    _request: &LivePreviewRequest,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    Err(RunError {
        message:
            "native FEM vector-field cache requested but fullmag-runner was built without the 'fem-gpu' feature"
                .to_string(),
    })
}

fn runtime_selection(problem: &ProblemIR) -> Option<&serde_json::Map<String, Value>> {
    problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
        .and_then(Value::as_object)
}

pub(crate) fn runtime_device(problem: &ProblemIR) -> Option<&str> {
    runtime_selection(problem)
        .and_then(|selection| selection.get("device"))
        .and_then(Value::as_str)
}

pub(crate) fn runtime_precision(problem: &ProblemIR) -> &str {
    runtime_selection(problem)
        .and_then(|selection| selection.get("precision"))
        .and_then(Value::as_str)
        .unwrap_or(match problem.backend_policy.execution_precision {
            fullmag_ir::ExecutionPrecision::Single => "single",
            fullmag_ir::ExecutionPrecision::Double => "double",
        })
}

pub(crate) fn requested_registry_device_for_fdm(problem: &ProblemIR) -> String {
    match std::env::var("FULLMAG_FDM_EXECUTION").ok().as_deref() {
        Some("cpu") => "cpu".to_string(),
        Some("cuda") => "gpu".to_string(),
        Some("auto") | None => runtime_device(problem)
            .unwrap_or("auto")
            .replace("cuda", "gpu"),
        Some(other) => other.replace("cuda", "gpu"),
    }
}

pub(crate) fn requested_registry_device_for_fem(problem: &ProblemIR) -> String {
    if strict_fem_gpu_requested(problem) {
        return "gpu".to_string();
    }
    if all_in_gpu_fem_env_requested() {
        return "gpu".to_string();
    }
    match std::env::var("FULLMAG_FEM_EXECUTION").ok().as_deref() {
        Some("cpu") => "cpu".to_string(),
        Some("gpu") | Some("cuda") | Some("all_in_gpu") => "gpu".to_string(),
        Some("auto") | None => runtime_device(problem)
            .unwrap_or("auto")
            .replace("cuda", "gpu"),
        Some(other) => other.replace("cuda", "gpu"),
    }
}

struct RegistryRuntimeMatch {
    runtime_family: String,
    worker: String,
    device: String,
    fallback: Option<ResolvedFallback>,
}

fn registry_gpu_to_cpu_fallback_engine_ids(backend: &str) -> (&'static str, &'static str) {
    match backend {
        "fdm" => (
            fdm_engine_id(FdmEngine::CudaFdm),
            fdm_engine_id(FdmEngine::CpuReference),
        ),
        "fem" => (
            fem_engine_id(FemEngine::NativeGpu),
            fem_engine_id(FemEngine::CpuNative),
        ),
        _ => ("unknown_gpu", "unknown_cpu"),
    }
}

fn resolve_registry_runtime_for_backend(
    registry: &RuntimeRegistry,
    backend: &str,
    requested_device: &str,
    precision: &str,
) -> Option<RegistryRuntimeMatch> {
    if requested_device != "auto" {
        let resolved = registry.resolve(backend, requested_device, precision)?;
        return Some(RegistryRuntimeMatch {
            runtime_family: resolved.runtime_family,
            worker: resolved.worker,
            device: requested_device.to_string(),
            fallback: None,
        });
    }

    if let Some(resolved) = registry.resolve(backend, "gpu", precision) {
        return Some(RegistryRuntimeMatch {
            runtime_family: resolved.runtime_family,
            worker: resolved.worker,
            device: "gpu".to_string(),
            fallback: None,
        });
    }

    let (original_engine, fallback_engine) = registry_gpu_to_cpu_fallback_engine_ids(backend);
    registry.resolve(backend, "cpu", precision).map(|resolved| RegistryRuntimeMatch {
        runtime_family: resolved.runtime_family,
        worker: resolved.worker,
        device: "cpu".to_string(),
        fallback: Some(runtime_fallback(
            original_engine,
            fallback_engine,
            match backend {
                "fdm" => "fdm_cuda_unavailable",
                "fem" => "native_fem_gpu_unavailable",
                _ => "runtime_unavailable",
            },
            format!(
                "preferred {backend} GPU runtime is unavailable in the runtime registry; using CPU runtime"
            ),
        )),
    })
}

fn runtime_device_index(problem: &ProblemIR) -> Option<u32> {
    runtime_selection(problem)
        .and_then(|selection| selection.get("device_index"))
        .and_then(Value::as_u64)
        .map(|index| index as u32)
}

fn runtime_fem_policy(problem: &ProblemIR) -> &'static str {
    match runtime_device(problem) {
        Some("cpu") => "cpu",
        Some("cuda") | Some("gpu") => "gpu",
        _ => "auto",
    }
}

fn runtime_fem_order(problem: &ProblemIR) -> u32 {
    problem
        .backend_policy
        .discretization_hints
        .as_ref()
        .and_then(|hints| hints.fem.as_ref())
        .map(|hints| hints.order)
        .unwrap_or(1)
}

fn fem_policy_requires_gpu(policy: &str) -> bool {
    matches!(policy, "gpu" | "all_in_gpu")
}

fn apply_runtime_gpu_index(problem: &ProblemIR, backend: &str) {
    let Some(index) = runtime_device_index(problem) else {
        return;
    };
    let specific_env = match backend {
        "fdm" => "FULLMAG_FDM_GPU_INDEX",
        "fem" => "FULLMAG_FEM_GPU_INDEX",
        _ => return,
    };
    if std::env::var_os(specific_env).is_none() {
        std::env::set_var(specific_env, index.to_string());
    }
    if std::env::var_os("FULLMAG_CUDA_DEVICE_INDEX").is_none() {
        std::env::set_var("FULLMAG_CUDA_DEVICE_INDEX", index.to_string());
    }
}

/// Execute an FDM plan using the selected engine.
pub(crate) fn execute_fdm<'a>(
    engine: FdmEngine,
    plan: &FdmPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'a>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    if matches!(engine, FdmEngine::CpuReference) {
        let unsupported = unsupported_cpu_fdm_terms(plan, outputs);
        if !unsupported.is_empty() {
            return Err(RunError {
                message: format!(
                    "CPU reference FDM engine cannot execute this plan faithfully; unsupported terms: [{}]",
                    unsupported.join(", ")
                ),
            });
        }
    }
    let mut executed = match engine {
        FdmEngine::CpuReference => cpu_reference::execute_reference_fdm(
            plan,
            until_seconds,
            outputs,
            live,
            artifact_writer,
        ),
        FdmEngine::CudaFdm => execute_cuda_fdm(plan, until_seconds, outputs, live, artifact_writer),
    }?;
    if let Some(artifact) = crate::regional_field_drive_artifacts::regional_field_drive_artifact(
        &plan.field_drives,
        &plan.time_stage,
        until_seconds,
        outputs,
        &executed.provenance,
    )? {
        executed.auxiliary_artifacts.push(artifact);
    }
    Ok(executed)
}

/// Execute a multilayer FDM plan using the selected engine.
pub(crate) fn execute_fdm_multilayer<'a>(
    engine: FdmEngine,
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<(&'a [u32; 3], &'a mut dyn FnMut(StepUpdate) -> StepAction)>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    match engine {
        FdmEngine::CpuReference => multilayer_reference::execute_reference_fdm_multilayer(
            plan,
            until_seconds,
            outputs,
            live,
            artifact_writer,
        ),
        FdmEngine::CudaFdm => {
            #[cfg(feature = "cuda")]
            {
                return multilayer_cuda::execute_cuda_fdm_multilayer_with_live(
                    plan,
                    until_seconds,
                    outputs,
                    live,
                    artifact_writer,
                );
            }
            #[cfg(not(feature = "cuda"))]
            {
                return Err(RunError {
                    message:
                        "FULLMAG_FDM_EXECUTION=cuda requested for multilayer FDM, but fullmag-runner was built without the cuda feature"
                            .to_string(),
                });
            }
        }
    }
}

/// Execute a FEM plan using the selected engine.
pub(crate) fn execute_fem<'a>(
    engine: FemEngine,
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'a>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    execute_fem_in_mode(
        engine,
        plan,
        until_seconds,
        outputs,
        live,
        artifact_writer,
        ExecutionMode::Strict,
    )
}

pub(crate) fn execute_fem_in_mode<'a>(
    engine: FemEngine,
    plan: &FemPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'a>>,
    artifact_writer: Option<ArtifactPipelineSender>,
    execution_mode: ExecutionMode,
) -> Result<ExecutedRun, RunError> {
    let stage_context = FemStageExecutionContext::from_fem_plan(plan);
    execute_fem_with_context_in_mode(
        engine,
        plan,
        &stage_context,
        until_seconds,
        outputs,
        live,
        artifact_writer,
        execution_mode,
    )
}

pub(crate) fn execute_fem_with_context<'a>(
    engine: FemEngine,
    plan: &FemPlanIR,
    stage_context: &FemStageExecutionContext,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'a>>,
    artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    execute_fem_with_context_in_mode(
        engine,
        plan,
        stage_context,
        until_seconds,
        outputs,
        live,
        artifact_writer,
        ExecutionMode::Strict,
    )
}

pub(crate) fn execute_fem_with_context_in_mode<'a>(
    engine: FemEngine,
    plan: &FemPlanIR,
    stage_context: &FemStageExecutionContext,
    until_seconds: f64,
    outputs: &[OutputIR],
    live: Option<LiveStepConsumer<'a>>,
    artifact_writer: Option<ArtifactPipelineSender>,
    execution_mode: ExecutionMode,
) -> Result<ExecutedRun, RunError> {
    let normalized_plan = normalized_fem_plan_for_runtime(plan)?;
    reject_unsupported_steady_transport_component_outputs(&normalized_plan, outputs)?;
    #[cfg(feature = "fem-gpu")]
    let transport_artifact_writer = artifact_writer.clone();
    #[cfg(feature = "fem-gpu")]
    let transport_bundle = if normalized_plan.spin_transport_plans.is_empty() {
        None
    } else {
        if engine != FemEngine::CpuNative {
            return Err(RunError {
                message: "FEM M1 steady spin transport resolved CPU-double, but runtime selected GPU; refusing hidden fallback before provenance".to_string(),
            });
        }
        crate::native_fem::execute_native_fem_steady_transport_plans(&normalized_plan)?
    };
    #[cfg(not(feature = "fem-gpu"))]
    if !normalized_plan.spin_transport_plans.is_empty() {
        return Err(RunError {
            message: "FEM steady spin transport requires a runner built with the managed native FEM feature".to_string(),
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
                    pbc_decision
                        .reason
                        .as_deref()
                        .unwrap_or("operator reduction required")
                ),
            );
            let mut executed = fem_baseline::execute_reference_fem_with_context(
                &normalized_plan,
                stage_context,
                until_seconds,
                outputs,
                live,
                artifact_writer,
            )?;
            if let Some(artifact) =
                crate::regional_field_drive_artifacts::regional_field_drive_artifact(
                    &normalized_plan.field_drives,
                    &normalized_plan.time_stage,
                    until_seconds,
                    outputs,
                    &executed.provenance,
                )?
            {
                executed.auxiliary_artifacts.push(artifact);
            }
            return Ok(executed);
        }
        FemStaticPbcLane::None
        | FemStaticPbcLane::NativeExchangeOnly
        | FemStaticPbcLane::NativeAnisotropy
        | FemStaticPbcLane::NativeDemagPoisson => {
            // Fall through to native execution below.
        }
    }
    #[cfg(feature = "fem-gpu")]
    let dynamic_outputs = outputs
        .iter()
        .filter(|output| !steady_transport_output(output))
        .cloned()
        .collect::<Vec<_>>();
    #[cfg(feature = "fem-gpu")]
    let runtime_outputs = if normalized_plan.spin_transport_plans.is_empty() {
        outputs
    } else {
        dynamic_outputs.as_slice()
    };
    #[cfg(not(feature = "fem-gpu"))]
    let runtime_outputs = outputs;
    let executed = match engine {
        FemEngine::CpuNative => {
            let cpu_plan = fem_plan_for_cpu_native(&normalized_plan);
            execute_native_fem(
                FemEngine::CpuNative,
                &cpu_plan,
                stage_context,
                until_seconds,
                runtime_outputs,
                live,
                artifact_writer,
                execution_mode,
            )
        }
        FemEngine::NativeGpu => {
            let gpu_plan = fem_plan_for_native_gpu(&normalized_plan);
            execute_native_fem(
                FemEngine::NativeGpu,
                &gpu_plan,
                stage_context,
                until_seconds,
                runtime_outputs,
                live,
                artifact_writer,
                execution_mode,
            )
        }
    }?;
    #[cfg(feature = "fem-gpu")]
    let mut executed = executed;
    #[cfg(feature = "fem-gpu")]
    if let Some(mut bundle) = transport_bundle {
        let mut next_revision = executed
            .field_snapshots
            .iter()
            .map(|snapshot| snapshot.revision)
            .max()
            .unwrap_or(0)
            .max(executed.field_snapshot_count as u64);
        for snapshot in &mut bundle.field_snapshots {
            next_revision = next_revision.saturating_add(1);
            snapshot.revision = next_revision;
        }
        executed
            .provenance
            .transport_modules
            .append(&mut bundle.provenance);
        if let Some(writer) = transport_artifact_writer {
            let mut recorder = ArtifactRecorder::streaming(executed.provenance.clone(), writer);
            for snapshot in bundle.field_snapshots {
                recorder.record_field_snapshot(snapshot)?;
            }
            let (_, recorded_count, _) = recorder.finish();
            executed.field_snapshot_count =
                executed.field_snapshot_count.saturating_add(recorded_count);
        } else {
            executed.field_snapshot_count = executed
                .field_snapshot_count
                .saturating_add(bundle.field_snapshots.len());
            executed.field_snapshots.extend(bundle.field_snapshots);
        }
        executed.auxiliary_artifacts.extend(bundle.artifacts);
    }
    Ok(executed)
}

#[cfg(feature = "fem-gpu")]
fn steady_transport_output(output: &OutputIR) -> bool {
    let quantity = match output {
        OutputIR::Field { name, .. } => name.as_str(),
        OutputIR::Snapshot { field, .. } => field.as_str(),
        OutputIR::SaveQuantity { quantity_id, .. } => quantity_id.as_str(),
        _ => return false,
    };
    matches!(
        quantity,
        "V_electric" | "J_charge" | "spin_potential" | "spin_current_tensor" | "torque_stt"
    )
}

fn reject_unsupported_steady_transport_component_outputs(
    plan: &FemPlanIR,
    outputs: &[OutputIR],
) -> Result<(), RunError> {
    if plan.spin_transport_plans.is_empty() {
        return Ok(());
    }
    for output in outputs {
        let (quantity, unsupported_qualifier) = match output {
            OutputIR::Field { name, .. } => (name.as_str(), None),
            OutputIR::Snapshot {
                field,
                component,
                layer,
                ..
            } => (
                field.as_str(),
                (component != "3D" || layer.is_some())
                    .then_some("snapshot component/layer selector"),
            ),
            OutputIR::SaveQuantity {
                quantity_id,
                reduction,
                component,
                ..
            } => (
                quantity_id.as_str(),
                (reduction.is_some() || component.is_some())
                    .then_some("save-quantity reduction/component selector"),
            ),
            _ => continue,
        };
        let base = quantity.split_once('.').map_or(quantity, |(base, _)| base);
        if !matches!(
            base,
            "V_electric" | "J_charge" | "spin_potential" | "spin_current_tensor" | "torque_stt"
        ) {
            continue;
        }
        if quantity != base || unsupported_qualifier.is_some() {
            let qualifier = unsupported_qualifier.unwrap_or("dotted component selector");
            return Err(RunError {
                message: format!(
                    "FEM steady spin transport schedule '{quantity}' uses unsupported {qualifier}; request the unqualified canonical base quantity '{base}'"
                ),
            });
        }
    }
    Ok(())
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
        FemEngine::CpuNative => fem_eigen::execute_cpu_fem_eigen(plan, outputs),
        FemEngine::NativeGpu => {
            // GPU-accelerated dense eigensolver (Etap A4) — TRANSITIONAL.
            // `execute_gpu_fem_eigen` uses cuSolverDN; returns error if GPU
            // is unavailable (no silent fallback to CPU).
            fem_eigen::execute_gpu_fem_eigen(plan, outputs)
        }
    }
}

pub(crate) fn execute_fem_eigen_with_progress(
    engine: FemEngine,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut fem_eigen::FemEigenProgressCallback<'_>,
) -> Result<ExecutedRun, RunError> {
    if matches!(plan.k_sampling, Some(fullmag_ir::KSamplingIR::Path { .. })) {
        return execute_fem_eigen_path(engine, plan, outputs);
    }

    match engine {
        FemEngine::CpuNative => {
            fem_eigen::execute_cpu_fem_eigen_with_progress(plan, outputs, progress)
        }
        FemEngine::NativeGpu => fem_eigen::execute_gpu_fem_eigen(plan, outputs),
    }
}

/// Multi-k orchestrator path: iterate over samples in a `KSamplingIR::Path`,
/// solve each point with the existing single-k solver, track branches, and
/// produce V2 path/branch/mode artifacts alongside legacy-compatible ones.
fn execute_fem_eigen_path(
    engine: FemEngine,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    if engine == FemEngine::NativeGpu && !gpu_modal_k0_kittel_path_supported(plan) {
        return Err(gpu_modal_dispersion_path_unavailable_error(plan));
    }
    if !de_bv_low_k_analytic_reference_enabled(plan)
        && !k0_kittel_synthetic_demag_factor_enabled(plan)
    {
        fem_eigen::reject_unsupported_floquet_dynamic_demag(
            &plan.spin_wave_bc,
            plan.operator.include_demag,
        )?;
    }

    use crate::eigen::{
        run_path_or_single, KSampleDescriptor, SingleKModeResult, SingleKSolveResult, SingleKSolver,
    };
    use crate::types::AuxiliaryArtifact;
    use std::cell::RefCell;

    struct KSolverAdapter {
        engine: FemEngine,
        mode_artifacts: RefCell<Vec<AuxiliaryArtifact>>,
        published_mode_indices: BTreeSet<u32>,
        periodic_airbox_k0_metrics:
            RefCell<Option<crate::eigen::K0KittelPeriodicAirboxDemagMetrics>>,
    }

    impl SingleKSolver for KSolverAdapter {
        fn solve_single_k(
            &self,
            plan: &FemEigenPlanIR,
            outputs: &[OutputIR],
            sample: &KSampleDescriptor,
        ) -> Result<SingleKSolveResult, crate::types::RunError> {
            if de_bv_low_k_analytic_reference_enabled(plan) {
                return solve_de_bv_low_k_analytic_reference_single_k(plan, sample);
            }
            if k0_kittel_synthetic_demag_factor_enabled(plan) {
                return solve_k0_kittel_synthetic_demag_factor_single_k(plan, sample);
            }

            let point_plan = eigen_path_single_k_point_plan(plan, sample);

            let executed = match self.engine {
                FemEngine::CpuNative => fem_eigen::execute_cpu_fem_eigen(&point_plan, outputs)?,
                FemEngine::NativeGpu => fem_eigen::execute_gpu_fem_eigen(&point_plan, outputs)?,
            };
            if let Some(metrics) = eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts(
                &point_plan,
                &executed.auxiliary_artifacts,
            )? {
                eigen_path_merge_periodic_airbox_k0_metrics(
                    &mut self.periodic_airbox_k0_metrics.borrow_mut(),
                    metrics,
                )?;
            }
            self.mode_artifacts
                .borrow_mut()
                .extend(remap_single_k_mode_artifacts(
                    &executed.auxiliary_artifacts,
                    sample.sample_index,
                    &self.published_mode_indices,
                )?);

            // Parse the spectrum artifact to extract mode results
            let spectrum_bytes = executed
                .auxiliary_artifacts
                .iter()
                .find(|a| a.relative_path == "eigen/spectrum.json")
                .map(|a| &a.bytes)
                .ok_or_else(|| crate::types::RunError {
                    message: "single-k solver did not produce eigen/spectrum.json".to_string(),
                })?;
            let spectrum: serde_json::Value =
                serde_json::from_slice(spectrum_bytes).map_err(|e| crate::types::RunError {
                    message: format!("failed to parse spectrum.json: {e}"),
                })?;
            let relaxation_steps = spectrum["relaxation_steps"].as_u64().unwrap_or(0);
            let solver_kind = spectrum["solver_kind"]
                .as_str()
                .unwrap_or("unknown")
                .to_string();

            let modes_array =
                spectrum["modes"]
                    .as_array()
                    .ok_or_else(|| crate::types::RunError {
                        message: "spectrum.json has no modes array".to_string(),
                    })?;
            let node_mass_weights =
                eigen_path_node_mass_weights_from_json(&spectrum["node_mass_weights"]);

            let mut modes = Vec::with_capacity(modes_array.len());
            for mode_json in modes_array {
                modes.push(SingleKModeResult {
                    raw_mode_index: mode_json["index"].as_u64().unwrap_or(0) as usize,
                    branch_id: None,
                    frequency_real_hz: mode_json["frequency_real_hz"].as_f64().unwrap_or(0.0),
                    frequency_imag_hz: mode_json["frequency_imag_hz"].as_f64().unwrap_or(0.0),
                    angular_frequency_rad_per_s: mode_json["angular_frequency_rad_per_s"]
                        .as_f64()
                        .unwrap_or(0.0),
                    eigenvalue_real: mode_json["eigenvalue_real"].as_f64().unwrap_or(0.0),
                    eigenvalue_imag: mode_json["eigenvalue_imag"].as_f64().unwrap_or(0.0),
                    norm: mode_json["norm"].as_f64().unwrap_or(0.0),
                    mass_norm: mode_json["mass_norm"].as_f64(),
                    max_amplitude: mode_json["max_amplitude"].as_f64().unwrap_or(0.0),
                    residual_norm: mode_json["residual_norm"].as_f64(),
                    residual_linf: mode_json["residual_linf"].as_f64(),
                    tangent_leakage_mean_abs: mode_json["tangent_leakage_mean_abs"].as_f64(),
                    tangent_leakage_max_abs: mode_json["tangent_leakage_max_abs"].as_f64(),
                    dominant_polarization: mode_json["dominant_polarization"]
                        .as_str()
                        .unwrap_or("unknown")
                        .to_string(),
                    reduced_vector: eigen_path_mode_tracking_vector(
                        &executed.auxiliary_artifacts,
                        mode_json["index"].as_u64().unwrap_or(0) as usize,
                    ),
                    lifted_real: None,
                    lifted_imag: None,
                    amplitude: None,
                    phase: None,
                    node_mass_weights: node_mass_weights.clone(),
                });
            }

            Ok(SingleKSolveResult {
                sample: sample.clone(),
                modes,
                relaxation_steps,
                solver_model: eigen_path_single_k_solver_model(
                    &point_plan,
                    &executed.auxiliary_artifacts,
                ),
                solver_notes: vec![solver_kind],
            })
        }
    }

    let tracking_outputs = eigen_path_tracking_outputs(outputs, plan.count);
    let published_mode_indices = eigen_path_public_mode_indices(outputs, plan.count);
    let wants_dispersion = eigen_path_wants_dispersion(outputs);
    let adapter = KSolverAdapter {
        engine,
        mode_artifacts: RefCell::new(Vec::new()),
        published_mode_indices: published_mode_indices.clone(),
        periodic_airbox_k0_metrics: RefCell::new(None),
    };
    let mut path_result = run_path_or_single(
        &adapter,
        plan,
        &tracking_outputs,
        None, // we collect artifacts manually below
        plan.mode_tracking.as_ref(),
    )?;
    path_result.k0_kittel_periodic_airbox_demag = adapter.periodic_airbox_k0_metrics.into_inner();
    let mut mode_artifacts = adapter.mode_artifacts.into_inner();
    deduplicate_auxiliary_artifacts_by_path(&mut mode_artifacts);
    if mode_artifacts.is_empty()
        && (de_bv_low_k_analytic_reference_enabled(plan)
            || k0_kittel_synthetic_demag_factor_enabled(plan))
    {
        mode_artifacts = eigen_path_mode_artifacts_from_result(&path_result)?;
    }

    // Build the ExecutedRun with both V2 and legacy-compatible artifacts
    let mut auxiliary_artifacts = Vec::new();

    // V2 path artifact (eigen/path.json)
    let v2_samples: Vec<serde_json::Value> = path_result
        .samples
        .iter()
        .map(|s| {
            serde_json::json!({
                "sample_index": s.sample.sample_index,
                "label": s.sample.label,
                "k_vector": s.sample.k_vector,
                "path_s": s.sample.path_s,
                "segment_index": s.sample.segment_index,
                "t_in_segment": s.sample.t_in_segment,
                "modes": s
                    .modes
                    .iter()
                    .filter(|m| published_mode_indices.contains(&(m.raw_mode_index as u32)))
                    .map(|m| {
                        eigen_path_mode_json(plan, &s.sample, m, path_result.solver_model)
                    })
                    .collect::<Vec<_>>(),
            })
        })
        .collect();
    let path_json = serde_json::json!({
        "schema_version": "2",
        "solver_model": path_result.solver_model.as_str(),
        "sample_count": v2_samples.len(),
        "samples": v2_samples.clone(),
    });
    let tracking_cfg = plan.mode_tracking.clone().unwrap_or_default();
    let tracking_method = serde_json::to_value(tracking_cfg.method)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "overlap_hungarian".to_string());
    let phase_convention = serde_json::to_value(plan.spin_wave_bc.phase_convention())
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "exp_minus_i_k_dot_delta_r".to_string());
    let overlap_values = path_result
        .branches
        .iter()
        .flat_map(|branch| {
            branch
                .points
                .iter()
                .filter(|point| published_mode_indices.contains(&(point.raw_mode_index as u32)))
                .filter_map(|point| point.overlap_prev)
        })
        .collect::<Vec<_>>();
    let min_overlap = overlap_values
        .iter()
        .copied()
        .reduce(|lhs, rhs| lhs.min(rhs));
    let median_overlap = median_f64(&overlap_values);
    let (tracking_score_source, modal_overlap_available) =
        eigen_path_tracking_score_summary(&path_result);
    let modal_overlap_unavailable_reason = if modal_overlap_available {
        serde_json::Value::Null
    } else {
        serde_json::json!("mode_vectors_not_carried_by_multi_k_orchestrator")
    };
    let gap_count = path_result
        .branches
        .iter()
        .map(|branch| v2_samples.len().saturating_sub(branch.points.len()))
        .sum::<usize>();
    let public_mode_count = eigen_path_public_mode_count(&path_result, &published_mode_indices);
    let diagnostics_v2 = serde_json::json!({
        "schema_version": "eigen_diagnostics.v2",
        "dispersion": {
            "sample_count": path_result.samples.len(),
            "mode_count_requested": plan.count,
            "branch_count": path_result.branches.len(),
            "min_overlap": min_overlap,
            "median_overlap": median_overlap,
            "tracking_score_source": tracking_score_source,
            "modal_overlap_available": modal_overlap_available,
            "modal_overlap_unavailable_reason": modal_overlap_unavailable_reason,
            "gap_count": gap_count,
            "ambiguous_assignment_count": 0,
        },
    });
    let spectrum_v2 = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_id": path_result.solver_model.as_str(),
        "phase_convention": phase_convention,
        "sample_count": v2_samples.len(),
        "mode_count": public_mode_count,
        "samples": v2_samples.clone(),
        "diagnostics_summary": diagnostics_v2["dispersion"].clone(),
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/spectrum.v2.json".to_string(),
        bytes: serde_json::to_vec_pretty(&spectrum_v2).unwrap_or_default(),
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/path.json".to_string(),
        bytes: serde_json::to_vec_pretty(&path_json).unwrap_or_default(),
    });

    // V2 branches artifact (eigen/branches.json)
    let v2_branches: Vec<serde_json::Value> = path_result
        .branches
        .iter()
        .filter_map(|b| {
            let points = b
                .points
                .iter()
                .enumerate()
                .filter(|(_, p)| published_mode_indices.contains(&(p.raw_mode_index as u32)))
                .map(|(point_index, p)| {
                    let mode = eigen_path_mode_for_branch_point(&path_result, p);
                    let point_modal_overlap_available =
                        eigen_path_branch_point_modal_overlap_available(&path_result, b, point_index);
                    serde_json::json!({
                        "sample_index": p.sample_index,
                        "raw_mode_index": p.raw_mode_index,
                        "frequency_hz": p.frequency_real_hz,
                        "frequency_real_hz": p.frequency_real_hz,
                        "frequency_imag_hz": p.frequency_imag_hz,
                        "angular_frequency_rad_per_s": mode
                            .map(|mode| mode.angular_frequency_rad_per_s)
                            .unwrap_or(p.frequency_real_hz * std::f64::consts::TAU),
                        "tracking_confidence": p.tracking_confidence,
                        "overlap_prev": p.overlap_prev,
                        "tracking_score_source": eigen_path_branch_point_tracking_score_source(
                            &path_result,
                            b,
                            point_index,
                        ),
                        "modal_overlap_available": point_modal_overlap_available,
                        "residual_norm": mode.and_then(|mode| mode.residual_norm),
                        "residual_linf": mode.and_then(|mode| mode.residual_linf),
                        "tangent_leakage_mean_abs": mode.and_then(|mode| mode.tangent_leakage_mean_abs),
                        "tangent_leakage_max_abs": mode.and_then(|mode| mode.tangent_leakage_max_abs),
                        "mode_field_id": eigen_path_mode_field_id(
                            p.sample_index,
                            p.raw_mode_index,
                        ),
                        "mode_field_resource_key": eigen_path_mode_field_resource_key(
                            p.sample_index,
                            p.raw_mode_index,
                        ),
                    })
                })
                .collect::<Vec<_>>();
            if points.is_empty() {
                return None;
            }
            Some(serde_json::json!({
                "branch_id": b.branch_id,
                "label": b.label,
                "points": points,
            }))
        })
        .collect();
    let branches_v2 = serde_json::json!({
        "schema_version": "eigen_branches.v2",
        "tracking_method": tracking_method,
        "tracking_score_source": tracking_score_source,
        "modal_overlap_available": modal_overlap_available,
        "overlap_floor": tracking_cfg.overlap_floor,
        "frequency_window_hz": tracking_cfg.frequency_window_hz,
        "branches": v2_branches.clone(),
        "diagnostics": {
            "min_overlap": min_overlap,
            "median_overlap": median_overlap,
            "tracking_score_source": tracking_score_source,
            "modal_overlap_available": modal_overlap_available,
            "modal_overlap_unavailable_reason": modal_overlap_unavailable_reason,
            "gap_count": gap_count,
            "ambiguous_assignment_count": 0,
        },
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/branches.v2.json".to_string(),
        bytes: serde_json::to_vec_pretty(&branches_v2).unwrap_or_default(),
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/diagnostics.v2.json".to_string(),
        bytes: serde_json::to_vec_pretty(&diagnostics_v2).unwrap_or_default(),
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "eigen/branches.json".to_string(),
        bytes: serde_json::to_vec_pretty(&serde_json::json!({
            "schema_version": "2",
            "solver_model": path_result.solver_model.as_str(),
            "branches": v2_branches,
        }))
        .unwrap_or_default(),
    });

    // Legacy-compatible spectrum.json from the first sample
    if let Some(first_sample) = path_result.samples.first() {
        let modes_summary: Vec<serde_json::Value> = first_sample
            .modes
            .iter()
            .filter(|m| published_mode_indices.contains(&(m.raw_mode_index as u32)))
            .map(|m| eigen_path_mode_json(plan, &first_sample.sample, m, path_result.solver_model))
            .collect();
        let solver_diagnostics =
            eigen_path_solver_diagnostics(plan, &path_result, &published_mode_indices);

        let legacy_spectrum = serde_json::json!({
            "study_kind": "eigenmodes",
            "solver_backend": "cpu_baseline_fem_eigen",
            "solver_kind": path_result.solver_model.as_str(),
            "mesh_name": plan.mesh_name,
            "mode_count": modes_summary.len(),
            "normalization": format!("{:?}", plan.normalization).to_lowercase(),
            "damping_policy": format!("{:?}", plan.damping_policy).to_lowercase(),
            "spin_wave_bc": format!("{:?}", plan.spin_wave_bc.kind()).to_lowercase(),
            "equilibrium_source": eigen_path_equilibrium_source_json(plan, first_sample.relaxation_steps),
            "included_terms": {
                "exchange": plan.enable_exchange,
                "demag": plan.operator.include_demag,
                "zeeman": plan.external_field.is_some(),
                "interfacial_dmi": plan.interfacial_dmi.is_some(),
                "bulk_dmi": plan.bulk_dmi.is_some(),
                "surface_anisotropy": plan.spin_wave_bc.surface_anisotropy_ks().is_some(),
            },
            "operator": {
                "kind": format!("{:?}", plan.operator.kind).to_lowercase(),
                "include_demag": plan.operator.include_demag,
            },
            "solver_diagnostics": solver_diagnostics,
            "k_sampling": plan.k_sampling,
            "relaxation_steps": first_sample.relaxation_steps,
            "modes": modes_summary,
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/spectrum.json".to_string(),
            bytes: serde_json::to_vec_pretty(&legacy_spectrum).unwrap_or_default(),
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/metadata/eigen_summary.json".to_string(),
            bytes: serde_json::to_vec_pretty(&legacy_spectrum).unwrap_or_default(),
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/diagnostics/solver.v1.json".to_string(),
            bytes: serde_json::to_vec_pretty(&solver_diagnostics).unwrap_or_default(),
        });

        if wants_dispersion {
            // Legacy dispersion CSV with all samples × modes
            let mut csv_lines =
                vec!["mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s".to_string()];
            for sample_result in &path_result.samples {
                let k = sample_result.sample.k_vector;
                for mode in &sample_result.modes {
                    if !published_mode_indices.contains(&(mode.raw_mode_index as u32)) {
                        continue;
                    }
                    csv_lines.push(format!(
                        "{},{},{},{},{},{}",
                        mode.raw_mode_index,
                        k[0],
                        k[1],
                        k[2],
                        mode.frequency_real_hz,
                        mode.angular_frequency_rad_per_s,
                    ));
                }
            }
            auxiliary_artifacts.push(AuxiliaryArtifact {
                relative_path: "eigen/dispersion/branch_table.csv".to_string(),
                bytes: csv_lines.join("\n").into_bytes(),
            });

            let mut dispersion_v2_lines = vec![
            "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,analytic_frequency_hz,relative_error,validation_geometry,line_width_hz,residual_norm,overlap_score,tracking_score_source,mode_field_id,mode_field_resource_key"
                .to_string(),
        ];
            for sample_result in &path_result.samples {
                let k = sample_result.sample.k_vector;
                let label = sample_result.sample.label.clone().unwrap_or_default();
                for mode in &sample_result.modes {
                    if !published_mode_indices.contains(&(mode.raw_mode_index as u32)) {
                        continue;
                    }
                    let branch_point = eigen_path_branch_point_for_mode(
                        &path_result,
                        sample_result.sample.sample_index,
                        mode.raw_mode_index,
                    );
                    let overlap_score = branch_point
                        .as_ref()
                        .and_then(|(_, _, point)| point.overlap_prev)
                        .map(|value| value.to_string())
                        .unwrap_or_default();
                    let tracking_score_source = branch_point
                        .as_ref()
                        .map(|(branch, point_index, _)| {
                            eigen_path_branch_point_tracking_score_source(
                                &path_result,
                                branch,
                                *point_index,
                            )
                        })
                        .unwrap_or_default();
                    let line_width_hz =
                        eigen_path_line_width_hz(mode.frequency_imag_hz).unwrap_or_default();
                    let validation_columns =
                        eigen_path_de_bv_analytic_csv_columns(plan, &sample_result.sample, mode);
                    dispersion_v2_lines.push(format!(
                        "{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{}",
                        sample_result.sample.sample_index,
                        sample_result.sample.path_s,
                        k[0],
                        k[1],
                        k[2],
                        label,
                        mode.raw_mode_index,
                        mode.branch_id
                            .map(|branch_id| branch_id.to_string())
                            .unwrap_or_default(),
                        mode.frequency_real_hz,
                        mode.angular_frequency_rad_per_s,
                        validation_columns.analytic_frequency_hz,
                        validation_columns.relative_error,
                        validation_columns.geometry,
                        line_width_hz,
                        mode.residual_norm
                            .map(|value| format!("{value:.16e}"))
                            .unwrap_or_default(),
                        overlap_score,
                        tracking_score_source,
                        eigen_path_mode_field_id(
                            sample_result.sample.sample_index,
                            mode.raw_mode_index,
                        ),
                        eigen_path_mode_field_resource_key(
                            sample_result.sample.sample_index,
                            mode.raw_mode_index,
                        ),
                    ));
                }
            }
            auxiliary_artifacts.push(AuxiliaryArtifact {
                relative_path: "eigen/dispersion.csv".to_string(),
                bytes: dispersion_v2_lines.join("\n").into_bytes(),
            });

            // Legacy dispersion path metadata
            auxiliary_artifacts.push(AuxiliaryArtifact {
                relative_path: "eigen/dispersion/path.json".to_string(),
                bytes: serde_json::to_vec_pretty(&serde_json::json!({
                    "sampling": plan.k_sampling,
                }))
                .unwrap_or_default(),
            });
        }
    }
    append_eigen_path_k0_kittel_validation_artifacts(&mut auxiliary_artifacts, &path_result)?;
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "frequency_domain/manifest.v1.json".to_string(),
        bytes: serde_json::to_vec_pretty(&build_eigen_path_frequency_domain_manifest(
            engine,
            &path_result,
            &mode_artifacts,
            plan,
        ))
        .map_err(|error| RunError {
            message: format!("failed to serialize k-path frequency-domain manifest: {error}"),
        })?,
    });
    auxiliary_artifacts.extend(mode_artifacts);

    Ok(ExecutedRun {
        result: crate::types::RunResult {
            status: crate::types::RunStatus::Completed,
            steps: vec![],
            final_magnetization: plan.equilibrium_magnetization.clone(),
            completion: Some(crate::relaxation::resolve_stage_completion(
                crate::types::RunStatus::Completed,
                None,
                crate::relaxation::RelaxationCompletionMetrics::default(),
            )),
        },
        initial_magnetization: plan.equilibrium_magnetization.clone(),
        field_snapshots: Vec::new(),
        field_snapshot_count: 0,
        auxiliary_artifacts,
        provenance: crate::ExecutionProvenance {
            execution_engine: format!("multi_k_orchestrator/{}", path_result.solver_model.as_str()),
            precision: "double".to_string(),
            ..Default::default()
        },
    })
}

fn gpu_modal_dispersion_path_unavailable_error(plan: &FemEigenPlanIR) -> RunError {
    if plan.operator.include_demag || plan.enable_demag {
        return RunError {
            message: "GPU modal K0/Kittel with demag is unavailable until Poisson-airbox GPU parity/runtime gates pass; CPU fallback is disabled for forced GPU modal demag.".to_string(),
        };
    }
    RunError {
        message: "GPU modal dispersion with KSamplingIR::Path is unavailable until a native modal GPU eigensolver and Floquet operator exist; request FEM CPU/reference modal dispersion or a single-k GPU modal solve".to_string(),
    }
}

fn gpu_modal_k0_kittel_path_supported(plan: &FemEigenPlanIR) -> bool {
    if plan.k0_kittel_validation.is_none()
        || !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        || plan.operator.include_demag
        || plan.enable_demag
        || !matches!(
            plan.damping_policy,
            fullmag_ir::EigenDampingPolicyIR::Ignore
        )
    {
        return false;
    }
    let Some(fullmag_ir::KSamplingIR::Path { points, .. }) = plan.k_sampling.as_ref() else {
        return false;
    };
    !points.is_empty()
        && points.iter().all(|point| {
            point
                .k_vector
                .iter()
                .all(|component| component.is_finite() && component.abs() <= 1.0e-12)
        })
}

fn eigen_path_single_k_point_plan(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
) -> FemEigenPlanIR {
    let mut point_plan = plan.clone();
    point_plan.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
        k_vector: sample.k_vector,
    });
    if matches!(
        point_plan.equilibrium,
        fullmag_ir::EquilibriumSourceIR::RelaxedInitialState
    ) {
        point_plan.equilibrium = fullmag_ir::EquilibriumSourceIR::Provided;
    }
    if let Some(external_field) = eigen_path_k0_kittel_sample_external_field(plan, sample) {
        point_plan.external_field = Some(external_field);
    }
    point_plan
}

fn de_bv_low_k_analytic_reference_enabled(plan: &FemEigenPlanIR) -> bool {
    plan.operator.include_demag
        && matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
        && plan
            .dispersion_validation
            .as_ref()
            .is_some_and(|validation| {
                validation.kind == "thin_film_de_bv_low_k"
                    && validation.analytic_model == "kalinikos_slab_n0"
            })
}

fn k0_kittel_synthetic_demag_factor_enabled(plan: &FemEigenPlanIR) -> bool {
    plan.operator.include_demag
        && plan.enable_demag
        && matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
        && plan
            .k0_kittel_validation
            .as_ref()
            .is_some_and(|validation| {
                validation.kind == "k0_kittel_field_sweep"
                    && validation.case_id.as_deref() == Some("K0-3")
                    && validation.demag_kind.as_deref() == Some("synthetic_demag_factor")
                    && validation.model == "thin_film_in_plane"
            })
}

fn solve_k0_kittel_synthetic_demag_factor_single_k(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
) -> Result<crate::eigen::SingleKSolveResult, RunError> {
    if vector_norm(sample.k_vector) > 1.0e-9 {
        return Err(RunError {
            message: "K0-3 synthetic demag-factor validation requires k=0 samples".to_string(),
        });
    }
    let validation = plan.k0_kittel_validation.as_ref().ok_or_else(|| RunError {
        message: "K0-3 synthetic demag-factor validation requires k0_kittel_validation".to_string(),
    })?;
    let declared_sample = validation
        .samples
        .iter()
        .find(|candidate| candidate.sample_index as usize == sample.sample_index)
        .ok_or_else(|| RunError {
            message: format!(
                "K0-3 synthetic demag-factor validation missing field sample {}",
                sample.sample_index
            ),
        })?;
    let h0_a_per_m = vector_norm(declared_sample.bias_field);
    if !(h0_a_per_m.is_finite() && h0_a_per_m > 0.0) {
        return Err(RunError {
            message: "K0-3 synthetic demag-factor validation requires a positive bias field"
                .to_string(),
        });
    }
    let effective_magnetisation = validation
        .material
        .effective_magnetisation
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| RunError {
            message: "K0-3 synthetic demag-factor validation requires positive M_eff".to_string(),
        })?;
    let frequency_hz = plan.gyromagnetic_ratio
        * (h0_a_per_m * (h0_a_per_m + effective_magnetisation)).sqrt()
        / std::f64::consts::TAU;
    let omega = std::f64::consts::TAU * frequency_hz;
    Ok(crate::eigen::SingleKSolveResult {
        sample: sample.clone(),
        modes: vec![crate::eigen::SingleKModeResult {
            raw_mode_index: 0,
            branch_id: None,
            frequency_real_hz: frequency_hz,
            frequency_imag_hz: 0.0,
            angular_frequency_rad_per_s: omega,
            eigenvalue_real: 0.0,
            eigenvalue_imag: omega,
            norm: 1.0,
            mass_norm: Some(1.0),
            max_amplitude: 1.0,
            residual_norm: Some(0.0),
            residual_linf: Some(0.0),
            tangent_leakage_mean_abs: Some(0.0),
            tangent_leakage_max_abs: Some(0.0),
            dominant_polarization: "synthetic_demag_factor".to_string(),
            reduced_vector: Some(vec![num_complex::Complex64::new(1.0, 0.0)]),
            lifted_real: Some(vec![[0.0, 1.0, 0.0]]),
            lifted_imag: Some(vec![[0.0, 0.0, 1.0]]),
            amplitude: Some(vec![1.0]),
            phase: Some(vec![0.0]),
            node_mass_weights: None,
        }],
        relaxation_steps: 0,
        solver_model: crate::eigen::EigenSolverModel::ReferenceK0KittelSyntheticDemagFactor,
        solver_notes: vec![
            "k0_3a_synthetic_demag_factor".to_string(),
            "production_periodic_airbox_claim=false".to_string(),
        ],
    })
}

fn solve_de_bv_low_k_analytic_reference_single_k(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
) -> Result<crate::eigen::SingleKSolveResult, RunError> {
    let validation = plan
        .dispersion_validation
        .as_ref()
        .ok_or_else(|| RunError {
            message: "DE/BV analytic reference solver requires dispersion_validation".to_string(),
        })?;
    let k_norm = vector_norm(sample.k_vector);
    if k_norm > validation.max_k_rad_per_m * (1.0 + 1.0e-12) {
        return Err(RunError {
            message: format!(
                "DE/BV analytic reference sample exceeds low-k range: {} > {}",
                k_norm, validation.max_k_rad_per_m
            ),
        });
    }
    let geometry = de_bv_geometry_for_k(sample.k_vector, validation)?;
    let frequency_hz = kalinikos_slab_n0_frequency_hz(
        k_norm,
        geometry,
        vector_norm(plan.external_field.unwrap_or([0.0, 0.0, 0.0])),
        validation.film_thickness_m,
        plan.material.exchange_stiffness,
        plan.material.saturation_magnetisation,
        plan.gyromagnetic_ratio,
    )?;
    if frequency_hz < validation.frequency_window_hz.min
        || frequency_hz > validation.frequency_window_hz.max
    {
        return Err(RunError {
            message: format!(
                "DE/BV analytic reference frequency is outside validation window: {} Hz",
                frequency_hz
            ),
        });
    }
    let omega = std::f64::consts::TAU * frequency_hz;
    Ok(crate::eigen::SingleKSolveResult {
        sample: sample.clone(),
        modes: vec![crate::eigen::SingleKModeResult {
            raw_mode_index: 0,
            branch_id: None,
            frequency_real_hz: frequency_hz,
            frequency_imag_hz: 0.0,
            angular_frequency_rad_per_s: omega,
            eigenvalue_real: omega / plan.gyromagnetic_ratio,
            eigenvalue_imag: 0.0,
            norm: 1.0,
            mass_norm: Some(1.0),
            max_amplitude: 1.0,
            residual_norm: Some(0.0),
            residual_linf: Some(0.0),
            tangent_leakage_mean_abs: Some(0.0),
            tangent_leakage_max_abs: Some(0.0),
            dominant_polarization: geometry.to_string(),
            reduced_vector: Some(vec![num_complex::Complex64::new(1.0, 0.0)]),
            lifted_real: Some(vec![[0.0, 1.0, 0.0]]),
            lifted_imag: Some(vec![[0.0, 0.0, 1.0]]),
            amplitude: Some(vec![1.0]),
            phase: Some(vec![0.0]),
            node_mass_weights: None,
        }],
        relaxation_steps: 0,
        solver_model: crate::eigen::EigenSolverModel::ReferenceThinFilmDeBvKalinikosN0,
        solver_notes: vec![
            "reference_thin_film_de_bv_kalinikos_n0".to_string(),
            format!("geometry={geometry}"),
        ],
    })
}

fn kalinikos_slab_n0_frequency_hz(
    k_norm: f64,
    geometry: &str,
    bias_field_a_per_m: f64,
    film_thickness_m: f64,
    exchange_stiffness_j_per_m: f64,
    saturation_magnetisation_a_per_m: f64,
    gamma0_rad_s_per_a_m: f64,
) -> Result<f64, RunError> {
    if !(bias_field_a_per_m.is_finite() && bias_field_a_per_m > 0.0) {
        return Err(RunError {
            message: "DE/BV analytic reference requires a nonzero finite bias field".to_string(),
        });
    }
    let exchange_field = 2.0 * exchange_stiffness_j_per_m * k_norm * k_norm
        / (crate::MU0 * saturation_magnetisation_a_per_m);
    let p_factor = if k_norm == 0.0 {
        0.0
    } else {
        let kd = k_norm * film_thickness_m;
        1.0 - (1.0 - (-kd).exp()) / kd
    };
    let common = bias_field_a_per_m + exchange_field;
    let (factor_a, factor_b) = match geometry {
        "damon_eshbach" => (
            common + saturation_magnetisation_a_per_m * (1.0 - p_factor),
            common + saturation_magnetisation_a_per_m * p_factor,
        ),
        "backward_volume" => (
            common,
            common + saturation_magnetisation_a_per_m * (1.0 - p_factor),
        ),
        _ => {
            return Err(RunError {
                message: format!("unsupported DE/BV analytic geometry: {geometry}"),
            })
        }
    };
    if !(factor_a.is_finite() && factor_a > 0.0 && factor_b.is_finite() && factor_b > 0.0) {
        return Err(RunError {
            message: "DE/BV analytic reference factors must be finite and positive".to_string(),
        });
    }
    Ok(gamma0_rad_s_per_a_m * (factor_a * factor_b).sqrt() / std::f64::consts::TAU)
}

fn de_bv_geometry_for_k(
    k_vector: [f64; 3],
    validation: &fullmag_ir::FemEigenDispersionValidationIR,
) -> Result<&'static str, RunError> {
    let k_norm = vector_norm(k_vector);
    if k_norm == 0.0 {
        return Ok("backward_volume");
    }
    let k = unit_vector(k_vector).ok_or_else(|| RunError {
        message: "DE/BV analytic reference requires finite nonzero k".to_string(),
    })?;
    let m0 = unit_vector(validation.equilibrium_magnetization).ok_or_else(|| RunError {
        message: "DE/BV analytic reference requires finite nonzero equilibrium magnetization"
            .to_string(),
    })?;
    let normal = unit_vector(validation.film_normal).ok_or_else(|| RunError {
        message: "DE/BV analytic reference requires finite nonzero film normal".to_string(),
    })?;
    if vector_dot(k, normal).abs() > 1.0e-6 {
        return Err(RunError {
            message: "DE/BV analytic reference requires in-plane k vectors".to_string(),
        });
    }
    let projection = vector_dot(k, m0).abs();
    if (projection - 1.0).abs() <= 1.0e-6 {
        Ok("backward_volume")
    } else if projection <= 1.0e-6 {
        Ok("damon_eshbach")
    } else {
        Err(RunError {
            message: "DE/BV analytic reference supports only k parallel or perpendicular to equilibrium magnetization".to_string(),
        })
    }
}

fn unit_vector(value: [f64; 3]) -> Option<[f64; 3]> {
    let norm = vector_norm(value);
    (norm.is_finite() && norm > 0.0).then_some([value[0] / norm, value[1] / norm, value[2] / norm])
}

fn vector_norm(value: [f64; 3]) -> f64 {
    vector_dot(value, value).sqrt()
}

fn vector_dot(lhs: [f64; 3], rhs: [f64; 3]) -> f64 {
    lhs[0] * rhs[0] + lhs[1] * rhs[1] + lhs[2] * rhs[2]
}

fn eigen_path_mode_artifacts_from_result(
    path_result: &crate::eigen::PathSolveResult,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let temp_dir = std::env::temp_dir().join(format!(
        "fullmag-eigen-path-mode-artifacts-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&temp_dir).map_err(|error| RunError {
        message: format!("failed to create temporary eigen mode artifact directory: {error}"),
    })?;
    let write_result = crate::eigen::artifacts::write_mode_bundle(&temp_dir, path_result);
    let collect_result = write_result
        .map_err(|error| RunError {
            message: format!("failed to write analytic eigen mode bundle: {error}"),
        })
        .and_then(|_| collect_auxiliary_artifacts_from_dir(&temp_dir, &temp_dir));
    let _ = std::fs::remove_dir_all(&temp_dir);
    collect_result
}

fn collect_auxiliary_artifacts_from_dir(
    root: &std::path::Path,
    dir: &std::path::Path,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let mut artifacts = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|error| RunError {
        message: format!("failed to read temporary eigen mode artifact directory: {error}"),
    })? {
        let entry = entry.map_err(|error| RunError {
            message: format!("failed to read temporary eigen mode artifact entry: {error}"),
        })?;
        let path = entry.path();
        if path.is_dir() {
            artifacts.extend(collect_auxiliary_artifacts_from_dir(root, &path)?);
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .map_err(|error| RunError {
                message: format!("failed to relativize temporary eigen mode artifact: {error}"),
            })?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = std::fs::read(&path).map_err(|error| RunError {
            message: format!(
                "failed to read temporary eigen mode artifact {relative_path}: {error}"
            ),
        })?;
        artifacts.push(AuxiliaryArtifact {
            relative_path,
            bytes,
        });
    }
    Ok(artifacts)
}

fn eigen_path_mode_for_branch_point<'a>(
    path_result: &'a crate::eigen::PathSolveResult,
    point: &crate::eigen::TrackedBranchPoint,
) -> Option<&'a crate::eigen::SingleKModeResult> {
    path_result
        .samples
        .iter()
        .find(|sample| sample.sample.sample_index == point.sample_index)
        .and_then(|sample| {
            sample
                .modes
                .iter()
                .find(|mode| mode.raw_mode_index == point.raw_mode_index)
        })
}

fn median_f64(values: &[f64]) -> Option<f64> {
    let mut finite = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if finite.is_empty() {
        return None;
    }
    finite.sort_by(|lhs, rhs| lhs.total_cmp(rhs));
    let mid = finite.len() / 2;
    if finite.len() % 2 == 0 {
        Some((finite[mid - 1] + finite[mid]) / 2.0)
    } else {
        Some(finite[mid])
    }
}

fn eigen_path_requested_mode_indices(outputs: &[OutputIR]) -> BTreeSet<u32> {
    outputs
        .iter()
        .filter_map(|output| match output {
            OutputIR::EigenMode { indices, .. } => Some(indices),
            _ => None,
        })
        .flat_map(|indices| indices.iter().copied())
        .collect()
}

fn eigen_path_wants_dispersion(outputs: &[OutputIR]) -> bool {
    outputs
        .iter()
        .any(|output| matches!(output, OutputIR::DispersionCurve { .. }))
}

fn eigen_path_public_mode_indices(outputs: &[OutputIR], mode_count: u32) -> BTreeSet<u32> {
    let requested_modes = eigen_path_requested_mode_indices(outputs);
    if !requested_modes.is_empty() || !eigen_path_wants_dispersion(outputs) {
        return requested_modes;
    }
    (0..mode_count).collect()
}

fn eigen_path_single_k_solver_model(
    plan: &FemEigenPlanIR,
    artifacts: &[crate::types::AuxiliaryArtifact],
) -> crate::eigen::EigenSolverModel {
    for artifact in artifacts {
        if artifact.relative_path != "eigen/metadata/eigen_summary.json" {
            continue;
        }
        let Ok(summary) = serde_json::from_slice::<serde_json::Value>(&artifact.bytes) else {
            continue;
        };
        let diagnostics = summary.get("solver_diagnostics");
        let production_solver_available = diagnostics
            .and_then(|value| value.get("production_solver_available"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let execution_lane = diagnostics
            .and_then(|value| value.get("execution_lane"))
            .and_then(|value| value.as_str());
        let solver_model = diagnostics
            .and_then(|value| value.get("solver_model"))
            .or_else(|| summary.get("solver_kind"))
            .and_then(|value| value.as_str());
        let spectral_transform = diagnostics
            .and_then(|value| value.get("spectral_transform"))
            .and_then(|value| value.as_str());
        if production_solver_available
            && execution_lane == Some("production_cpu")
            && solver_model == Some("slepc_multi_shift_invert_production_cpu_dense")
            && spectral_transform == Some("shift_invert")
        {
            if matches!(
                plan.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            ) && !eigen_path_single_k_has_bloch_floquet_contract(diagnostics)
            {
                return crate::eigen::EigenSolverModel::ReferenceFull2x2Tangent;
            }
            return crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
        }
        if production_solver_available
            && execution_lane == Some("production_gpu")
            && solver_model == Some("gpu_dense_k0_macrospin_modal_eigen")
        {
            return crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin;
        }
    }

    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        crate::eigen::EigenSolverModel::ReferenceFull2x2Tangent
    } else {
        crate::eigen::EigenSolverModel::ReferenceScalarTangent
    }
}

fn eigen_path_single_k_has_bloch_floquet_contract(diagnostics: Option<&serde_json::Value>) -> bool {
    diagnostics
        .and_then(|value| value.get("operator_diagnostics"))
        .and_then(|value| value.get("payload_kind"))
        .and_then(|value| value.as_str())
        == Some("bloch_floquet_tangent_operator")
        && diagnostics
            .and_then(|value| value.get("modal_periodic_pair_contract_available"))
            .and_then(|value| value.as_bool())
            == Some(true)
        && diagnostics
            .and_then(|value| value.get("floquet_periodic_pair_count"))
            .and_then(|value| value.as_u64())
            .is_some_and(|count| count > 0)
        && diagnostics
            .and_then(|value| value.get("operator_diagnostics"))
            .and_then(|value| value.get("demag_payload_kind"))
            .is_none()
        && !eigen_path_operator_diagnostics_has_gated_terms(diagnostics)
}

fn eigen_path_operator_diagnostics_has_gated_terms(
    diagnostics: Option<&serde_json::Value>,
) -> bool {
    diagnostics
        .and_then(|value| value.get("operator_diagnostics"))
        .and_then(|value| value.get("operator_terms_included"))
        .and_then(|value| value.as_array())
        .is_some_and(|terms| {
            terms.iter().any(|term| {
                matches!(
                    term.as_str(),
                    Some(
                        "demag"
                            | "dynamic_demag"
                            | "periodic_poisson"
                            | "floquet_airbox"
                            | "dmi"
                            | "interfacial_dmi"
                            | "bulk_dmi"
                            | "magnetoelastic"
                    )
                )
            })
        })
}

fn eigen_path_tracking_outputs(outputs: &[OutputIR], mode_count: u32) -> Vec<OutputIR> {
    let mut tracking_outputs = outputs.to_vec();
    if !tracking_outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }))
    {
        tracking_outputs.push(OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        });
    }

    let requested_modes = eigen_path_requested_mode_indices(outputs);
    let missing_tracking_modes = (0..mode_count)
        .filter(|index| !requested_modes.contains(index))
        .collect::<Vec<_>>();
    if !missing_tracking_modes.is_empty() {
        tracking_outputs.push(OutputIR::EigenMode {
            field: "mode".to_string(),
            indices: missing_tracking_modes,
        });
    }
    tracking_outputs
}

fn eigen_path_mode_tracking_vector(
    artifacts: &[crate::types::AuxiliaryArtifact],
    raw_mode_index: usize,
) -> Option<Vec<num_complex::Complex64>> {
    let legacy_path = format!("eigen/modes/mode_{raw_mode_index:04}.json");
    let mode = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == legacy_path)
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())?;
    let real = eigen_path_mode_vector_entries(&mode, "real");
    let imag = eigen_path_mode_vector_entries(&mode, "imag");
    let sample_count = real.len().max(imag.len());
    if sample_count == 0 {
        return None;
    }

    let mut vector = Vec::with_capacity(sample_count * 3);
    for index in 0..sample_count {
        let real_sample = real.get(index).copied().unwrap_or([0.0, 0.0, 0.0]);
        let imag_sample = imag.get(index).copied().unwrap_or([0.0, 0.0, 0.0]);
        for component in 0..3 {
            vector.push(num_complex::Complex64::new(
                real_sample[component],
                imag_sample[component],
            ));
        }
    }
    Some(vector)
}

fn eigen_path_mode_vector_entries(value: &serde_json::Value, field: &str) -> Vec<[f64; 3]> {
    value
        .get(field)
        .and_then(|field_value| field_value.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let components = entry.as_array()?;
                    Some([
                        components
                            .first()
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        components
                            .get(1)
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        components
                            .get(2)
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                    ])
                })
                .collect()
        })
        .unwrap_or_default()
}

fn eigen_path_branch_point_for_mode<'a>(
    path_result: &'a crate::eigen::PathSolveResult,
    sample_index: usize,
    raw_mode_index: usize,
) -> Option<(
    &'a crate::eigen::TrackedBranch,
    usize,
    &'a crate::eigen::TrackedBranchPoint,
)> {
    path_result.branches.iter().find_map(|branch| {
        branch
            .points
            .iter()
            .enumerate()
            .find(|(_, point)| {
                point.sample_index == sample_index && point.raw_mode_index == raw_mode_index
            })
            .map(|(point_index, point)| (branch, point_index, point))
    })
}

fn eigen_path_branch_point_modal_overlap_available(
    path_result: &crate::eigen::PathSolveResult,
    branch: &crate::eigen::TrackedBranch,
    point_index: usize,
) -> bool {
    if point_index == 0 {
        return false;
    }
    let Some(previous_point) = branch.points.get(point_index - 1) else {
        return false;
    };
    let Some(current_point) = branch.points.get(point_index) else {
        return false;
    };
    let previous_vector = eigen_path_mode_for_branch_point(path_result, previous_point)
        .and_then(|mode| mode.reduced_vector.as_ref());
    let current_vector = eigen_path_mode_for_branch_point(path_result, current_point)
        .and_then(|mode| mode.reduced_vector.as_ref());
    match (previous_vector, current_vector) {
        (Some(previous), Some(current)) => !previous.is_empty() && previous.len() == current.len(),
        _ => false,
    }
}

fn eigen_path_branch_point_tracking_score_source(
    path_result: &crate::eigen::PathSolveResult,
    branch: &crate::eigen::TrackedBranch,
    point_index: usize,
) -> &'static str {
    let Some(point) = branch.points.get(point_index) else {
        return "unknown";
    };
    if point.overlap_prev.is_none() {
        return "seed";
    }
    if eigen_path_branch_point_modal_overlap_available(path_result, branch, point_index) {
        "modal_overlap_weighted_score"
    } else {
        "frequency_score_fallback"
    }
}

fn eigen_path_tracking_score_summary(
    path_result: &crate::eigen::PathSolveResult,
) -> (&'static str, bool) {
    let mut saw_modal_overlap = false;
    let mut saw_frequency_fallback = false;
    for branch in &path_result.branches {
        for point_index in 0..branch.points.len() {
            match eigen_path_branch_point_tracking_score_source(path_result, branch, point_index) {
                "modal_overlap_weighted_score" => saw_modal_overlap = true,
                "frequency_score_fallback" => saw_frequency_fallback = true,
                _ => {}
            }
        }
    }
    let source = match (saw_modal_overlap, saw_frequency_fallback) {
        (true, true) => "mixed_modal_overlap_and_frequency_fallback",
        (true, false) => "modal_overlap_weighted_score",
        (false, true) => "frequency_score_fallback",
        (false, false) => "seed_only",
    };
    (source, saw_modal_overlap)
}

fn eigen_path_mode_field_id(sample_index: usize, raw_mode_index: usize) -> String {
    format!("analysis:eigen:sample-{sample_index:04}:mode-{raw_mode_index:04}")
}

fn eigen_path_mode_field_resource_key(sample_index: usize, raw_mode_index: usize) -> String {
    format!(
        "/v2/sessions/current/data/fields/{}/samples/vector?view=phase_rotated_real&phase_rad=0",
        eigen_path_mode_field_id(sample_index, raw_mode_index)
    )
}

fn eigen_path_line_width_hz(frequency_imag_hz: f64) -> Option<String> {
    if !frequency_imag_hz.is_finite() || frequency_imag_hz <= 0.0 {
        return None;
    }
    Some(format!("{:.16e}", 2.0 * frequency_imag_hz))
}

struct EigenPathDeBvAnalyticCsvColumns {
    analytic_frequency_hz: String,
    relative_error: String,
    geometry: String,
}

fn eigen_path_de_bv_analytic_csv_columns(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
    mode: &crate::eigen::SingleKModeResult,
) -> EigenPathDeBvAnalyticCsvColumns {
    let Some(validation) = plan.dispersion_validation.as_ref() else {
        return EigenPathDeBvAnalyticCsvColumns {
            analytic_frequency_hz: String::new(),
            relative_error: String::new(),
            geometry: String::new(),
        };
    };
    if validation.kind != "thin_film_de_bv_low_k"
        || validation.analytic_model != "kalinikos_slab_n0"
    {
        return EigenPathDeBvAnalyticCsvColumns {
            analytic_frequency_hz: String::new(),
            relative_error: String::new(),
            geometry: String::new(),
        };
    }

    let geometry = de_bv_validation_geometry_for_sample(validation, sample.sample_index)
        .or_else(|| de_bv_geometry_for_k(sample.k_vector, validation).ok())
        .unwrap_or(mode.dominant_polarization.as_str());
    let analytic_frequency_hz = kalinikos_slab_n0_frequency_hz(
        vector_norm(sample.k_vector),
        geometry,
        vector_norm(plan.external_field.unwrap_or([0.0, 0.0, 0.0])),
        validation.film_thickness_m,
        plan.material.exchange_stiffness,
        plan.material.saturation_magnetisation,
        plan.gyromagnetic_ratio,
    )
    .ok();
    let relative_error = analytic_frequency_hz
        .map(|analytic| (mode.frequency_real_hz - analytic).abs() / analytic.abs().max(1.0));
    EigenPathDeBvAnalyticCsvColumns {
        analytic_frequency_hz: analytic_frequency_hz
            .map(|value| format!("{value:.16e}"))
            .unwrap_or_default(),
        relative_error: relative_error
            .map(|value| format!("{value:.16e}"))
            .unwrap_or_default(),
        geometry: geometry.to_string(),
    }
}

fn de_bv_validation_geometry_for_sample(
    validation: &fullmag_ir::FemEigenDispersionValidationIR,
    sample_index: usize,
) -> Option<&str> {
    let sample_index = u32::try_from(sample_index).ok()?;
    validation.scenarios.iter().find_map(|scenario| {
        if !scenario.sample_indices.contains(&sample_index) {
            return None;
        }
        match scenario.geometry.as_str() {
            "de" | "damon_eshbach" | "damon-eshbach" => Some("damon_eshbach"),
            "bv" | "backward_volume" | "backward-volume" => Some("backward_volume"),
            _ => None,
        }
    })
}

fn eigen_path_mode_json(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
    mode: &crate::eigen::SingleKModeResult,
    solver_model: crate::eigen::EigenSolverModel,
) -> serde_json::Value {
    let residual_absolute_l2 = finite_or_default(mode.residual_norm, 0.0);
    let residual_linf = finite_or_default(mode.residual_linf, residual_absolute_l2);
    let tangent_leakage_mean_abs = finite_or_default(mode.tangent_leakage_mean_abs, 0.0);
    let tangent_leakage_max_abs =
        finite_or_default(mode.tangent_leakage_max_abs, tangent_leakage_mean_abs)
            .max(tangent_leakage_mean_abs);
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let gamma_rad_s_t = gamma0_rad_s_per_a_m / crate::MU0;
    let mass_norm = finite_or_default(
        mode.mass_norm,
        if mode.norm.is_finite() && mode.norm > 0.0 {
            mode.norm
        } else {
            1.0
        },
    );
    let production_shift_invert =
        solver_model == crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
    let production_gyrotropic = production_shift_invert
        || solver_model == crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin;

    let mut value = serde_json::json!({
        "index": mode.raw_mode_index,
        "raw_mode_index": mode.raw_mode_index,
        "branch_id": mode.branch_id,
        "frequency_hz": mode.frequency_real_hz,
        "frequency_real_hz": mode.frequency_real_hz,
        "frequency_imag_hz": mode.frequency_imag_hz,
        "angular_frequency_rad_per_s": mode.angular_frequency_rad_per_s,
        "omega_rad_s": mode.angular_frequency_rad_per_s,
        "eigenvalue_real": mode.eigenvalue_real,
        "eigenvalue_imag": mode.eigenvalue_imag,
        "phasor_convention": if production_gyrotropic { "exp_i_omega_t" } else { "not_applicable_real_reference" },
        "eigenvalue_mapping": if production_gyrotropic { "lambda_eq_i_omega" } else { "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m" },
        "norm": mode.norm,
        "max_amplitude": mode.max_amplitude,
        "residual_norm": residual_absolute_l2,
        "residual_absolute_l2": residual_absolute_l2,
        "residual_relative_l2": residual_absolute_l2,
        "residual_linf": residual_linf,
        "mass_norm": mass_norm,
        "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
        "tangent_leakage_max_abs": tangent_leakage_max_abs,
        "gamma_rad_s_T": gamma_rad_s_t,
        "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
        "mu0_T_m_per_A": crate::MU0,
        "dominant_polarization": mode.dominant_polarization,
        "k_vector": sample.k_vector,
        "mode_field_id": eigen_path_mode_field_id(
            sample.sample_index,
            mode.raw_mode_index,
        ),
        "mode_field_resource_key": eigen_path_mode_field_resource_key(
            sample.sample_index,
            mode.raw_mode_index,
        ),
    });
    if let Some(weights) = mode.node_mass_weights.as_ref() {
        value["node_mass_weights"] = serde_json::json!(weights);
    }
    value
}

fn eigen_path_node_mass_weights_from_json(value: &serde_json::Value) -> Option<Vec<f64>> {
    let array = value.as_array()?;
    if array.is_empty() {
        return None;
    }
    let mut weights = Vec::with_capacity(array.len());
    for item in array {
        let weight = item.as_f64()?;
        if !(weight.is_finite() && weight > 0.0) {
            return None;
        }
        weights.push(weight);
    }
    Some(weights)
}

fn eigen_path_public_mode_count(
    result: &crate::eigen::PathSolveResult,
    published_mode_indices: &BTreeSet<u32>,
) -> usize {
    result
        .samples
        .iter()
        .map(|sample| {
            sample
                .modes
                .iter()
                .filter(|mode| published_mode_indices.contains(&(mode.raw_mode_index as u32)))
                .count()
        })
        .max()
        .unwrap_or(0)
}

fn eigen_path_floquet_periodic_pair_count(plan: &FemEigenPlanIR) -> u64 {
    if !matches!(
        plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) {
        return 0;
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    if requested_pair_ids.is_empty() {
        return 0;
    }
    plan.mesh
        .periodic_boundary_pairs
        .iter()
        .filter(|boundary_pair| {
            requested_pair_ids
                .iter()
                .any(|requested| *requested == boundary_pair.pair_id)
                && boundary_pair.translation.is_some()
                && plan
                    .mesh
                    .periodic_node_pairs
                    .iter()
                    .any(|node_pair| node_pair.pair_id == boundary_pair.pair_id)
        })
        .count() as u64
}

fn eigen_path_floquet_periodic_mesh_certificate(
    plan: &FemEigenPlanIR,
) -> Option<serde_json::Value> {
    if !matches!(
        plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) {
        return None;
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    if requested_pair_ids.is_empty() {
        return None;
    }
    let mut node_pairs: Vec<_> = plan
        .mesh
        .periodic_node_pairs
        .iter()
        .filter(|node_pair| {
            requested_pair_ids
                .iter()
                .any(|requested| *requested == node_pair.pair_id)
        })
        .collect();
    if node_pairs.is_empty() {
        return None;
    }
    node_pairs.sort_by(|left, right| {
        left.pair_id
            .cmp(&right.pair_id)
            .then(left.node_a.cmp(&right.node_a))
            .then(left.node_b.cmp(&right.node_b))
    });

    let mut canonical_payload =
        String::from("periodic_mesh_certificate_pair_map.v1\nschema=periodic_mesh_certificate.v5\nrole=magnetic\n");
    for node_pair in &node_pairs {
        canonical_payload.push_str(&format!(
            "pair_id_len={};pair_id={};node_a={};node_b={}\n",
            node_pair.pair_id.len(),
            node_pair.pair_id,
            node_pair.node_a,
            node_pair.node_b
        ));
    }
    let digest = Sha256::digest(canonical_payload.as_bytes());
    Some(serde_json::json!({
        "schema_version": "periodic_mesh_certificate.v5",
        "certificate_status": "accepted",
        "magnetic_pair_count": node_pairs.len(),
        "magnetic_pair_map_sha256": format!("sha256:{digest:x}"),
        "pair_map_hash_canonicalization": "periodic_mesh_certificate_pair_map.v1_schema_role_pair_id_len_sorted_nodes",
    }))
}

fn eigen_path_solver_diagnostics(
    plan: &FemEigenPlanIR,
    result: &crate::eigen::PathSolveResult,
    published_mode_indices: &BTreeSet<u32>,
) -> serde_json::Value {
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let public_mode_count = eigen_path_public_mode_count(result, published_mode_indices);
    let requested_production_shift_invert =
        result.solver_model == crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
    let native_cpu_modal_window_rejection_reason =
        fem_eigen::native_cpu_modal_window_rejection_reason(plan);
    let production_shift_invert =
        requested_production_shift_invert && native_cpu_modal_window_rejection_reason.is_none();
    let production_gpu_k0_kittel =
        result.solver_model == crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin;
    let production_periodic_airbox_k0 = result.k0_kittel_periodic_airbox_demag.is_some()
        && plan
            .k0_kittel_validation
            .as_ref()
            .is_some_and(|validation| {
                validation.case_id.as_deref() == Some("K0-3")
                    && validation.demag_kind.as_deref() == Some("periodic_airbox_k0")
            });
    let production_modal_solver =
        production_shift_invert || production_gpu_k0_kittel || production_periodic_airbox_k0;
    let mut diagnostics = serde_json::json!({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "status": "ready",
        "complete": true,
        "solver_model": if production_periodic_airbox_k0 { "k0_poisson_airbox_cpu_full_coupled_slepc" } else { result.solver_model.as_str() },
        "solver_family": if production_periodic_airbox_k0 { "k0_poisson_airbox_full_coupled" } else { result.solver_model.as_str() },
        "resolved_solver_family": if production_periodic_airbox_k0 { "k0_poisson_airbox_full_coupled" } else if production_shift_invert { "shift_invert" } else if production_gpu_k0_kittel { "gpu_dense_k0_macrospin" } else { result.solver_model.as_str() },
        "spectral_transform": if production_periodic_airbox_k0 { "shift_invert" } else if production_shift_invert { "shift_invert" } else if production_gpu_k0_kittel { "dense_generalized" } else { "none" },
        "solver_adapter": if production_periodic_airbox_k0 { "k0_poisson_airbox_cpu_full_coupled_slepc" } else if production_shift_invert { "slepc_modal_eigen" } else if production_gpu_k0_kittel { "cusolverdn_dense_k0_macrospin_modal" } else { "multi_k_reference_modal_path" },
        "solver_notes": result.notes,
        "execution_lane": if production_periodic_airbox_k0 { "production_cpu" } else if production_shift_invert { "production_cpu" } else if production_gpu_k0_kittel { "production_gpu" } else { "reference_cpu" },
        "algebraic_form": if production_periodic_airbox_k0 { "full_coupled_poisson_airbox_augmented_gauge" } else if production_shift_invert { "gyrotropic_generalized" } else if production_gpu_k0_kittel { "k0_macrospin_field_generalized_to_gyrotropic_modal" } else { "reference_effective_field_generalized" },
        "matrix_equation": if production_periodic_airbox_k0 { "A_full x = lambda B_full x; Poisson airbox eliminated through Schur diagnostics" } else if production_shift_invert { "A q = lambda B q" } else if production_gpu_k0_kittel { "K u = lambda_field M u; lambda_modal = i gamma0 lambda_field" } else { "K u = lambda M u" },
        "phasor_convention": if production_periodic_airbox_k0 { "exp_plus_i_omega_t" } else if production_shift_invert || production_gpu_k0_kittel { "exp_i_omega_t" } else { "not_applicable_real_reference" },
        "eigenvalue_mapping": if production_periodic_airbox_k0 { "lambda_imag_positive_frequency" } else if production_shift_invert || production_gpu_k0_kittel { "lambda_eq_i_omega" } else { "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m" },
        "frequency_mapping": if production_modal_solver { "frequency_hz = imag(lambda)/(2*pi)" } else { "frequency_hz = omega_rad_s / (2*pi)" },
        "production_gyrotropic_mapping": production_modal_solver,
        "production_solver_available": production_modal_solver,
        "dense_reference_oracle": false,
        "sample_count": result.samples.len(),
        "mode_count": public_mode_count,
        "requested_mode_count": plan.count,
        "normalization": format!("{:?}", plan.normalization).to_lowercase(),
        "residual_definition": "residual_absolute_l2 is the solver-reported modal residual norm; residual_relative_l2 currently follows the reference residual until the production modal backend emits a separate relative norm",
        "tangent_leakage_definition": "abs(m0 dot delta_m) over reconstructed real and imaginary mode vectors",
        "constants": {
            "gamma_rad_s_T": gamma0_rad_s_per_a_m / crate::MU0,
            "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
            "mu0_T_m_per_A": crate::MU0,
        },
    });
    let transport_diagnostics = fem_eigen::modal_tangent_transport_diagnostics(plan);
    if let (Some(object), Some(transport)) = (
        diagnostics.as_object_mut(),
        transport_diagnostics.as_object(),
    ) {
        for (key, value) in transport {
            object.insert(key.clone(), value.clone());
        }
    }
    if let Some(object) = diagnostics.as_object_mut() {
        if !production_modal_solver {
            if let Some(reason) = native_cpu_modal_window_rejection_reason {
                object.insert(
                    "production_cpu_rejection_reason".to_string(),
                    serde_json::json!(reason),
                );
                object.insert(
                    "production_cpu_rejection_scope".to_string(),
                    serde_json::json!(fem_eigen::native_cpu_modal_window_rejection_scope(reason)),
                );
                fem_eigen::insert_native_cpu_modal_window_rejection_contract(object, reason);
            }
        }
        let floquet_pair_count = eigen_path_floquet_periodic_pair_count(plan);
        if floquet_pair_count > 0
            && matches!(
                plan.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            )
            && !plan.operator.include_demag
        {
            object.insert(
                "modal_periodic_pair_contract_available".to_string(),
                serde_json::json!(true),
            );
            object.insert(
                "floquet_periodic_pair_count".to_string(),
                serde_json::json!(floquet_pair_count),
            );
            if let Some(certificate) = eigen_path_floquet_periodic_mesh_certificate(plan) {
                object.insert("periodic_mesh_certificate".to_string(), certificate);
            }
            object.insert(
                "operator_diagnostics".to_string(),
                serde_json::json!({
                    "schema_version": "frequency_domain_operator_diagnostics.v1",
                    "payload_kind": "bloch_floquet_tangent_operator",
                }),
            );
        }
    }
    if let (Some(object), Some(metrics)) = (
        diagnostics.as_object_mut(),
        result.k0_kittel_periodic_airbox_demag.as_ref(),
    ) {
        object.insert(
            "demag_kind".to_string(),
            serde_json::json!("periodic_airbox_k0"),
        );
        object.insert(
            "gauge_policy".to_string(),
            serde_json::json!("mean_zero_augmented"),
        );
        object.insert(
            "phi_dof_count".to_string(),
            serde_json::json!(metrics.phi_dof_count),
        );
        object.insert(
            "augmented_phi_dof_count".to_string(),
            serde_json::json!(metrics.augmented_phi_dof_count),
        );
        object.insert(
            "poisson_constraint_relative_residual".to_string(),
            serde_json::json!(metrics.poisson_constraint_relative_residual),
        );
        object.insert(
            "relative_reference_frequency_error".to_string(),
            serde_json::json!(metrics.relative_kittel_frequency_error),
        );
        object.insert(
            "magnetic_pair_count".to_string(),
            serde_json::json!(metrics.magnetic_pair_count),
        );
        object.insert(
            "airbox_pair_count".to_string(),
            serde_json::json!(metrics.airbox_pair_count),
        );
        object.insert(
            "production_periodic_airbox_claim".to_string(),
            serde_json::json!(true),
        );
    }
    if let fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz,
        frequency_max_hz,
    } = plan.target
    {
        let window_width = frequency_max_hz - frequency_min_hz;
        let relative_width = if frequency_min_hz > 0.0 {
            window_width / frequency_min_hz
        } else {
            0.0
        };
        let subwindow_count = (relative_width / 0.35).ceil().max(1.0).min(16.0) as usize;
        let guard_fraction = 0.25;
        let mut resolved_min_hz = frequency_min_hz;
        let mut resolved_max_hz = frequency_max_hz;
        let subwindows = (0..subwindow_count)
            .map(|index| {
                let sub_min =
                    frequency_min_hz + index as f64 * window_width / subwindow_count as f64;
                let sub_max =
                    frequency_min_hz + (index + 1) as f64 * window_width / subwindow_count as f64;
                let sub_width = sub_max - sub_min;
                let search_min = (sub_min - guard_fraction * sub_width).max(0.0);
                let search_max = sub_max + guard_fraction * sub_width;
                let shift_frequency_hz = 0.5 * (sub_min + sub_max);
                resolved_min_hz = resolved_min_hz.min(search_min);
                resolved_max_hz = resolved_max_hz.max(search_max);
                serde_json::json!({
                    "index": index,
                    "requested_hz": [sub_min, sub_max],
                    "search_hz": [search_min, search_max],
                    "shift_hz": shift_frequency_hz,
                    "shift_frequency_hz": shift_frequency_hz,
                    "shift_omega_rad_s": std::f64::consts::TAU * shift_frequency_hz,
                    "outer_iterations": 0,
                    "linear_iterations_total": 0,
                    "candidate_modes": public_mode_count,
                    "accepted_modes": public_mode_count,
                    "residual_max": 0.0,
                    "stop_reason": "window_exhausted",
                })
            })
            .collect::<Vec<_>>();
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "requested_window_hz".to_string(),
                serde_json::json!([frequency_min_hz, frequency_max_hz]),
            );
            object.insert(
                "resolved_search_window_hz".to_string(),
                serde_json::json!([resolved_min_hz, resolved_max_hz]),
            );
            object.insert(
                "window_completeness".to_string(),
                serde_json::json!({
                    "policy": "best_effort",
                    "status": "not_certified",
                    "certification_method": "none",
                    "estimated_modes_in_window": public_mode_count,
                    "certified_modes_in_window": 0,
                    "additional_modes_may_exist": true,
                }),
            );
            object.insert("subwindows".to_string(), serde_json::json!(subwindows));
            if !production_shift_invert {
                object.insert(
                    "frequency_window_solver_policy".to_string(),
                    serde_json::json!("reference_k_path_window_filter_not_shift_invert_or_feast"),
                );
            }
        }
    }
    diagnostics
}

fn eigen_path_equilibrium_source_json(
    plan: &FemEigenPlanIR,
    relaxation_steps: u64,
) -> serde_json::Value {
    match &plan.equilibrium {
        fullmag_ir::EquilibriumSourceIR::RelaxedInitialState if relaxation_steps == 0 => {
            serde_json::json!({
                "kind": "relaxed_initial_state",
                "handoff": "stage_continuation",
            })
        }
        fullmag_ir::EquilibriumSourceIR::RelaxedInitialState => {
            serde_json::json!({ "kind": "relaxed_initial_state" })
        }
        fullmag_ir::EquilibriumSourceIR::Provided => serde_json::json!("provided"),
        fullmag_ir::EquilibriumSourceIR::Artifact { path } => {
            serde_json::json!({ "kind": "artifact", "path": path })
        }
    }
}

fn finite_or_default(value: Option<f64>, default: f64) -> f64 {
    value.filter(|value| value.is_finite()).unwrap_or(default)
}

fn remap_single_k_mode_artifacts(
    artifacts: &[crate::types::AuxiliaryArtifact],
    sample_index: usize,
    published_mode_indices: &BTreeSet<u32>,
) -> Result<Vec<crate::types::AuxiliaryArtifact>, RunError> {
    let mut remapped = Vec::new();
    for artifact in artifacts {
        let Some(relative_path) = remap_single_k_mode_artifact_path(
            &artifact.relative_path,
            sample_index,
            published_mode_indices,
        ) else {
            continue;
        };
        let bytes = if single_k_mode_artifact_is_json(&relative_path) {
            remap_single_k_mode_json_bytes(&artifact.bytes, sample_index)?
        } else {
            artifact.bytes.clone()
        };
        remapped.push(crate::types::AuxiliaryArtifact {
            relative_path,
            bytes,
        });
    }
    Ok(remapped)
}

fn remap_single_k_mode_artifact_path(
    relative_path: &str,
    sample_index: usize,
    published_mode_indices: &BTreeSet<u32>,
) -> Option<String> {
    if published_mode_indices.is_empty() {
        return None;
    }
    let sample_path = format!("sample_{sample_index:04}");
    if relative_path == "eigen/mode_fields.zarr/.zgroup"
        || relative_path == "eigen/mode_fields.zarr/.zattrs"
    {
        return Some(relative_path.to_string());
    }
    if relative_path.starts_with("eigen/modes/sample_0000/")
        || relative_path.starts_with("eigen/mode_fields/sample_0000/")
        || relative_path.starts_with("eigen/mode_fields.zarr/sample_0000/")
    {
        let raw_mode_index = single_k_mode_artifact_raw_mode_index(relative_path)?;
        if !published_mode_indices.contains(&(raw_mode_index as u32)) {
            return None;
        }
        return Some(relative_path.replace("sample_0000", &sample_path));
    }
    None
}

fn single_k_mode_artifact_raw_mode_index(relative_path: &str) -> Option<usize> {
    let mode_marker = "/mode_";
    let start = relative_path.rfind(mode_marker)? + mode_marker.len();
    let suffix = &relative_path[start..];
    let digits = suffix
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

fn single_k_mode_artifact_is_json(relative_path: &str) -> bool {
    relative_path.ends_with(".json")
        || relative_path.ends_with(".zgroup")
        || relative_path.ends_with(".zattrs")
        || relative_path.ends_with(".zarray")
}

fn remap_single_k_mode_json_bytes(bytes: &[u8], sample_index: usize) -> Result<Vec<u8>, RunError> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| RunError {
        message: format!("failed to parse single-k mode artifact for k-path remap: {error}"),
    })?;
    remap_single_k_mode_json_value(&mut value, sample_index);
    serde_json::to_vec_pretty(&value).map_err(|error| RunError {
        message: format!("failed to serialize k-path mode artifact: {error}"),
    })
}

fn remap_single_k_mode_json_value(value: &mut serde_json::Value, sample_index: usize) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                if key == "sample_index" && child.as_u64() == Some(0) {
                    *child = serde_json::json!(sample_index);
                } else {
                    remap_single_k_mode_json_value(child, sample_index);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                remap_single_k_mode_json_value(item, sample_index);
            }
        }
        serde_json::Value::String(text) => {
            let sample_path = format!("sample_{sample_index:04}");
            let sample_id = format!("sample-{sample_index:04}");
            let sample_meta = format!("/eigen/mode-field/{sample_index}/");
            *text = text
                .replace("sample_0000", &sample_path)
                .replace("sample-0000", &sample_id)
                .replace("/eigen/mode-field/0/", &sample_meta);
        }
        _ => {}
    }
}

fn deduplicate_auxiliary_artifacts_by_path(artifacts: &mut Vec<crate::types::AuxiliaryArtifact>) {
    let mut seen = HashSet::new();
    artifacts.retain(|artifact| seen.insert(artifact.relative_path.clone()));
}

fn build_eigen_path_frequency_domain_manifest(
    engine: FemEngine,
    result: &crate::eigen::PathSolveResult,
    mode_artifacts: &[crate::types::AuxiliaryArtifact],
    plan: &FemEigenPlanIR,
) -> serde_json::Value {
    let mode_metadata_paths = eigen_path_mode_metadata_paths(mode_artifacts);
    let mode_field_resources = mode_metadata_paths
        .iter()
        .filter_map(|path| parse_eigen_path_mode_metadata_path(path))
        .map(|(sample_index, raw_mode_index)| {
            format!(
                "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{raw_mode_index}/meta"
            )
        })
        .collect::<Vec<_>>();
    let sample_count = result.samples.len();
    let calculation_mode = eigen_path_calculation_mode(result);
    let (tracking_score_source, modal_overlap_available) =
        eigen_path_tracking_score_summary(result);
    let modal_overlap_unavailable_reason = if modal_overlap_available {
        serde_json::Value::Null
    } else {
        serde_json::json!("mode_vectors_not_carried_by_multi_k_orchestrator")
    };
    let mode_zarr_available = mode_artifacts
        .iter()
        .any(|artifact| artifact.relative_path == "eigen/mode_fields.zarr/.zgroup");
    let mode_field_storage_format = if mode_zarr_available {
        "zarr"
    } else {
        "binary_compatibility_exports"
    };
    let mode_field_zarr_store_path = if mode_zarr_available {
        serde_json::json!("eigen/mode_fields.zarr")
    } else {
        serde_json::Value::Null
    };
    let device = match engine {
        FemEngine::CpuNative => "cpu",
        FemEngine::NativeGpu => "gpu",
    };
    let requested_production_shift_invert =
        result.solver_model == crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
    let native_cpu_modal_window_rejection_reason =
        fem_eigen::native_cpu_modal_window_rejection_reason(plan);
    let production_shift_invert =
        requested_production_shift_invert && native_cpu_modal_window_rejection_reason.is_none();
    let production_gpu_k0_kittel =
        result.solver_model == crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin;
    let mut manifest = serde_json::json!({
        "schema_version": "frequency_domain_manifest.v1",
        "analysis_family": "magnetic_frequency_domain",
        "study_product": "modal_eigen",
        "revision": format!(
            "eigen:{}:{}:{}",
            result.solver_model.as_str(),
            sample_count,
            mode_metadata_paths.len()
        ),
        "session_id": "current",
        "run_id": "current",
        "stage_id": "eigenmodes",
        "stage_kind": "eigenmodes",
        "created_at": eigen_path_created_at_label(),
        "requested_execution": {
            "calculation_mode": calculation_mode,
            "backend": "fem",
            "device": device,
            "precision": "double",
            "execution_mode": "extended",
            "ui_mode": "auto",
            "operator": "linearized_llg",
            "solver_family": "modal_eigen",
            "solve_equation": if production_shift_invert || production_gpu_k0_kittel { "A q = lambda B q; lambda = i omega" } else { "K u = lambda M u; omega_rad_s = gamma0 * max(lambda, 0)" },
            "include_demag": plan.operator.include_demag,
            "damping_policy": format!("{:?}", plan.damping_policy).to_lowercase(),
            "equilibrium_source": format!("{:?}", plan.equilibrium).to_lowercase(),
            "k_sampling": if sample_count > 1 { "path" } else { "single" },
            "outputs": ["spectrum", "branches", "dispersion", "mode_fields"],
        },
        "resolved_execution": {
            "backend": "fem",
            "device": device,
            "precision": "double",
            "engine": format!("multi_k_orchestrator/{}", result.solver_model.as_str()),
            "native_backend": if production_shift_invert { "native_cpu" } else if production_gpu_k0_kittel { "native_gpu" } else if engine == FemEngine::NativeGpu { "native_gpu" } else { "runner_validation" },
            "reference_or_production": if production_shift_invert || production_gpu_k0_kittel { "production" } else if engine == FemEngine::NativeGpu { "development" } else { "reference" },
            "container_image": null,
            "build_features": [],
            "demag_realization": if plan.operator.include_demag { "requested" } else { "none" },
            "solver_library": if production_shift_invert { "slepc" } else if production_gpu_k0_kittel { "cusolverdn" } else { "nalgebra" },
            "solver_algorithm": result.solver_model.as_str(),
            "solve_kind": "modal_eigen",
            "device_residency": if production_gpu_k0_kittel { "gpu_device_resident" } else if engine == FemEngine::NativeGpu { "gpu_requested" } else { "host" },
        },
        "physics": {
            "analysis_family": "magnetic_frequency_domain",
            "llg_gamma0_si": null,
            "llg_alpha": null,
            "phase_convention": if production_shift_invert || production_gpu_k0_kittel { "exp_i_omega_t" } else { "exp_minus_i_omega_t" },
            "frequency_units": "Hz",
            "field_units": "dimensionless_delta_m",
            "normalization": format!("{:?}", plan.normalization).to_lowercase(),
            "spin_wave_bc": format!("{:?}", plan.spin_wave_bc.kind()).to_lowercase(),
            "periodic_or_floquet": if calculation_mode == "dispersion_modal" { "bloch_or_path_sampling" } else { "none" },
            "equilibrium_residual_summary": null,
            "response_map_axes": [],
        },
        "artifacts": {
            "solver_diagnostics_path": "eigen/diagnostics/solver.v1.json",
            "spectrum_v2_path": "eigen/spectrum.v2.json",
            "branches_v2_path": "eigen/branches.v2.json",
            "dispersion_csv_path": "eigen/dispersion.csv",
            "eigen_diagnostics_v2_path": "eigen/diagnostics.v2.json",
            "response_sweep_v1_path": null,
            "response_sweep_v2_path": null,
            "response_map_v1_path": null,
            "response_map_v2_path": null,
            "response_diagnostics_v1_path": null,
            "response_progress_v1_path": null,
            "response_cancel_requested_v1_path": null,
            "mode_field_zarr_store_path": mode_field_zarr_store_path,
            "mode_field_storage_format": mode_field_storage_format,
            "mode_metadata_paths": mode_metadata_paths,
            "frequency_point_paths": [],
        },
        "resources": {
            "spectrum_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
            "branches_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2",
            "dispersion_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/dispersion",
            "diagnostics_resource_key": null,
            "eigen_diagnostics_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
            "response_sweep_resource_key": null,
            "response_map_resource_key": null,
            "response_progress_resource_key": null,
            "response_cancel_requested_resource_key": null,
            "response_diagnostics_resource_key": null,
            "mode_field_resources": mode_field_resources,
            "response_field_resources": [],
        },
        "validation": {
            "dispersion_validation": result.dispersion_validation.as_ref(),
            "k0_kittel_validation": result.k0_kittel_validation.as_ref(),
            "dispersion_frequency_source": eigen_path_dispersion_frequency_source(result),
            "dispersion_reference_model": eigen_path_dispersion_reference_model(result),
            "dynamic_demag_operator_source": eigen_path_dynamic_demag_operator_source(result),
        },
        "diagnostics": {
            "status": "ready",
            "complete": true,
            "requested_frequency_point_count": sample_count,
            "completed_frequency_point_count": sample_count,
            "written_frequency_point_artifacts": 0,
            "tracking_score_source": tracking_score_source,
            "modal_overlap_available": modal_overlap_available,
            "modal_overlap_unavailable_reason": modal_overlap_unavailable_reason,
            "interrupted": false,
        },
        "capabilities": {
            "driven_response_artifact_available": false,
            "modal_artifact_available": true,
            "production_native_solver_available": production_shift_invert || production_gpu_k0_kittel,
            "validation_artifact": !(production_shift_invert || production_gpu_k0_kittel) && engine == FemEngine::CpuNative,
            "dispersion": eigen_path_dispersion_capabilities(production_shift_invert, production_gpu_k0_kittel),
        },
    });
    if !production_shift_invert {
        if let (Some(reason), Some(diagnostics)) = (
            native_cpu_modal_window_rejection_reason,
            manifest
                .get_mut("diagnostics")
                .and_then(serde_json::Value::as_object_mut),
        ) {
            diagnostics.insert(
                "production_cpu_rejection_reason".to_string(),
                serde_json::json!(reason),
            );
            diagnostics.insert(
                "production_cpu_rejection_scope".to_string(),
                serde_json::json!(fem_eigen::native_cpu_modal_window_rejection_scope(reason)),
            );
            fem_eigen::insert_native_cpu_modal_window_rejection_contract(diagnostics, reason);
        }
    } else if let Some(diagnostics) = manifest
        .get_mut("diagnostics")
        .and_then(serde_json::Value::as_object_mut)
    {
        if let Some(certificate) = eigen_path_floquet_periodic_mesh_certificate(plan) {
            diagnostics.insert("periodic_mesh_certificate".to_string(), certificate);
        }
    }
    manifest
}

fn eigen_path_k0_kittel_sample_external_field(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
) -> Option<[f64; 3]> {
    plan.k0_kittel_validation
        .as_ref()?
        .samples
        .iter()
        .find(|validation_sample| validation_sample.sample_index as usize == sample.sample_index)
        .map(|validation_sample| validation_sample.bias_field)
}

fn eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts(
    plan: &FemEigenPlanIR,
    artifacts: &[AuxiliaryArtifact],
) -> Result<Option<crate::eigen::K0KittelPeriodicAirboxDemagMetrics>, RunError> {
    let Some(input) = eigen_path_periodic_airbox_k0_metrics_input_from_plan(plan)? else {
        return Ok(None);
    };
    let diagnostics = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/diagnostics/solver.v1.json")
        .ok_or_else(|| RunError {
            message: "K0-3 periodic_airbox_k0 validation requires native solver diagnostics"
                .to_string(),
        })?;
    let raw = std::str::from_utf8(&diagnostics.bytes).map_err(|error| RunError {
        message: format!("native solver diagnostics are not valid UTF-8: {error}"),
    })?;
    fem_eigen::native_poisson_airbox_k0_metrics_from_result_json(raw, input).map(Some)
}

fn eigen_path_merge_periodic_airbox_k0_metrics(
    slot: &mut Option<crate::eigen::K0KittelPeriodicAirboxDemagMetrics>,
    metrics: crate::eigen::K0KittelPeriodicAirboxDemagMetrics,
) -> Result<(), RunError> {
    let Some(existing) = slot.as_mut() else {
        *slot = Some(metrics);
        return Ok(());
    };
    if existing.phi_dof_count != metrics.phi_dof_count
        || existing.augmented_phi_dof_count != metrics.augmented_phi_dof_count
        || existing.magnetic_pair_count != metrics.magnetic_pair_count
        || existing.airbox_pair_count != metrics.airbox_pair_count
    {
        return Err(RunError {
            message: "K0-3 periodic_airbox_k0 sweep produced inconsistent Poisson-airbox DOF or pair counts".to_string(),
        });
    }
    if relative_difference(existing.mesh_resolution_m, metrics.mesh_resolution_m) > 1.0e-12
        || relative_difference(existing.airbox_size_m, metrics.airbox_size_m) > 1.0e-12
        || relative_difference(
            existing.effective_magnetisation_a_per_m,
            metrics.effective_magnetisation_a_per_m,
        ) > 1.0e-12
    {
        return Err(RunError {
            message: "K0-3 periodic_airbox_k0 sweep produced inconsistent mesh, airbox, or effective magnetisation metrics".to_string(),
        });
    }
    existing.poisson_constraint_relative_residual = existing
        .poisson_constraint_relative_residual
        .max(metrics.poisson_constraint_relative_residual);
    existing.relative_kittel_frequency_error = existing
        .relative_kittel_frequency_error
        .max(metrics.relative_kittel_frequency_error);
    Ok(())
}

fn relative_difference(lhs: f64, rhs: f64) -> f64 {
    (lhs - rhs).abs() / lhs.abs().max(rhs.abs()).max(f64::MIN_POSITIVE)
}

fn eigen_path_periodic_airbox_k0_metrics_input_from_plan(
    plan: &FemEigenPlanIR,
) -> Result<Option<fem_eigen::NativePoissonAirboxK0MetricsInput>, RunError> {
    let Some(validation) = plan.k0_kittel_validation.as_ref() else {
        return Ok(None);
    };
    if validation.case_id.as_deref() != Some("K0-3")
        || validation.demag_kind.as_deref() != Some("periodic_airbox_k0")
    {
        return Ok(None);
    }
    let effective_magnetisation = validation
        .material
        .effective_magnetisation
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| RunError {
            message: "K0-3 periodic_airbox_k0 validation requires positive effective_magnetisation"
                .to_string(),
        })?;
    let airbox_size_m = eigen_path_airbox_size_m(plan)?;
    let (magnetic_pair_count, airbox_pair_count) =
        eigen_path_periodic_domain_node_pair_counts(&plan.mesh);
    Ok(Some(fem_eigen::NativePoissonAirboxK0MetricsInput {
        mesh_resolution_m: plan.hmax,
        airbox_size_m,
        magnetic_pair_count,
        airbox_pair_count,
        effective_magnetisation_a_per_m: effective_magnetisation,
    }))
}

fn eigen_path_airbox_size_m(plan: &FemEigenPlanIR) -> Result<f64, RunError> {
    let factor = plan
        .air_box_config
        .as_ref()
        .map(|config| config.factor)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| RunError {
            message: "K0-3 periodic_airbox_k0 validation requires positive air_box_config.factor"
                .to_string(),
        })?;
    let mut min_corner = [f64::INFINITY; 3];
    let mut max_corner = [f64::NEG_INFINITY; 3];
    for node in &plan.mesh.nodes {
        for axis in 0..3 {
            min_corner[axis] = min_corner[axis].min(node[axis]);
            max_corner[axis] = max_corner[axis].max(node[axis]);
        }
    }
    let max_extent = (0..3)
        .map(|axis| max_corner[axis] - min_corner[axis])
        .filter(|extent| extent.is_finite() && *extent > 0.0)
        .fold(0.0_f64, f64::max);
    if !(max_extent.is_finite() && max_extent > 0.0) {
        return Err(RunError {
            message: "K0-3 periodic_airbox_k0 validation requires positive mesh extent".to_string(),
        });
    }
    Ok(max_extent * factor)
}

fn eigen_path_periodic_domain_node_pair_counts(mesh: &fullmag_ir::MeshIR) -> (u64, u64) {
    let mut magnetic_nodes = BTreeSet::new();
    let mut airbox_nodes = BTreeSet::new();
    for cell in mesh.cells.iter() {
        let marker = mesh.element_markers.get(cell.ordinal).copied().unwrap_or(1);
        let target = if marker == 0 {
            &mut airbox_nodes
        } else {
            &mut magnetic_nodes
        };
        target.extend(cell.nodes.iter().copied());
    }
    let mut magnetic_count = 0_u64;
    let mut airbox_count = 0_u64;
    for pair in &mesh.periodic_node_pairs {
        let a_magnetic = magnetic_nodes.contains(&pair.node_a);
        let b_magnetic = magnetic_nodes.contains(&pair.node_b);
        let a_airbox = airbox_nodes.contains(&pair.node_a);
        let b_airbox = airbox_nodes.contains(&pair.node_b);
        if a_magnetic && b_magnetic {
            magnetic_count += 1;
        } else if !a_magnetic && !b_magnetic && (a_airbox || b_airbox) {
            airbox_count += 1;
        }
    }
    (magnetic_count, airbox_count)
}

fn append_eigen_path_k0_kittel_validation_artifacts(
    auxiliary_artifacts: &mut Vec<AuxiliaryArtifact>,
    result: &crate::eigen::PathSolveResult,
) -> Result<(), RunError> {
    let artifacts = crate::eigen::artifacts::k0_kittel_validation_auxiliary_artifacts(result)
        .map_err(|error| RunError {
            message: format!("failed to build k0 Kittel validation artifacts: {error}"),
        })?;
    auxiliary_artifacts.extend(artifacts);
    Ok(())
}

fn eigen_path_dispersion_frequency_source(
    result: &crate::eigen::PathSolveResult,
) -> serde_json::Value {
    if result.dispersion_validation.is_none() {
        return serde_json::Value::Null;
    }
    if result.solver_model == crate::eigen::EigenSolverModel::ReferenceThinFilmDeBvKalinikosN0 {
        serde_json::json!("analytic_reference_model")
    } else {
        serde_json::json!("numeric_modal_solver_with_analytic_comparison")
    }
}

fn eigen_path_dispersion_reference_model(
    result: &crate::eigen::PathSolveResult,
) -> serde_json::Value {
    if result.dispersion_validation.is_none() {
        return serde_json::Value::Null;
    }
    if result.solver_model == crate::eigen::EigenSolverModel::ReferenceThinFilmDeBvKalinikosN0 {
        serde_json::json!("kalinikos_slab_n0")
    } else {
        serde_json::Value::Null
    }
}

fn eigen_path_dynamic_demag_operator_source(
    result: &crate::eigen::PathSolveResult,
) -> serde_json::Value {
    if result.dispersion_validation.is_none() {
        return serde_json::Value::Null;
    }
    if result.solver_model == crate::eigen::EigenSolverModel::ReferenceThinFilmDeBvKalinikosN0 {
        serde_json::json!("analytic_thin_film_de_bv_reference_not_fem_demag_k")
    } else {
        serde_json::json!("numeric_modal_solver")
    }
}

fn eigen_path_capability(status: &str, reason: &str) -> serde_json::Value {
    serde_json::json!({
        "status": status,
        "reason": reason,
    })
}

fn eigen_path_dispersion_capabilities(
    production_shift_invert: bool,
    production_gpu_k0_kittel: bool,
) -> serde_json::Value {
    let reference_reason =
        "reference/MVP FEM modal k-path dispersion emits spectrum, branches, dispersion.csv, and mode-field artifacts on the CPU reference lane";
    let production_cpu_reason = if production_shift_invert {
        "managed native CPU selected-spectrum no-demag Full2x2 Floquet k-path dispersion is executable for the labelled Bloch/Floquet tangent payload slice; dynamic demag-k, broader sparse/matrix-free validation, and production GPU remain gated"
    } else {
        "native CPU selected-spectrum modal k-path is not the resolved lane for this artifact; production evidence must come from the managed selected-spectrum gate"
    };
    let production_gpu_reason = if production_gpu_k0_kittel {
        "managed native GPU K0 no-demag macrospin/Kittel modal slice is executable through cuSolverDN dense generalized solve; nonzero-k Floquet, demag-k, and broad sparse/matrix-free GPU modal eigensolve remain gated"
    } else {
        "native modal GPU dispersion is unavailable until a real modal GPU eigensolver and matching Floquet operator exist; driven-response GPU Floquet smoke must not be reused as modal dispersion"
    };
    serde_json::json!({
        "reference_cpu": eigen_path_capability("reference_executable", reference_reason),
        "production_cpu": eigen_path_capability(
            if production_shift_invert { "partial_production_executable" } else { "unsupported" },
            production_cpu_reason,
        ),
        "production_cpu_gamma_k_path": eigen_path_capability(
            "partial_production_executable",
            "managed production CPU selected-spectrum adapter is validated for gamma-equivalent k-path samples; this is a provenance bridge and not nonzero-k Bloch/Floquet dispersion",
        ),
        "production_gpu": eigen_path_capability(
            if production_gpu_k0_kittel { "partial_production_executable" } else { "unsupported" },
            production_gpu_reason,
        ),
        "k_path": eigen_path_capability("reference_executable", "runner FEM eigen path emits dispersion.csv"),
        "branch_tracking": eigen_path_capability("reference_executable", "runner FEM eigen path emits branches.v2 artifacts"),
    })
}

fn eigen_path_mode_metadata_paths(
    mode_artifacts: &[crate::types::AuxiliaryArtifact],
) -> Vec<String> {
    let mut paths = mode_artifacts
        .iter()
        .filter_map(|artifact| {
            parse_eigen_path_mode_metadata_path(&artifact.relative_path)
                .map(|_| artifact.relative_path.clone())
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn parse_eigen_path_mode_metadata_path(relative_path: &str) -> Option<(usize, usize)> {
    let rest = relative_path.strip_prefix("eigen/modes/")?;
    let (sample_part, mode_part) = rest.split_once('/')?;
    let sample_index = sample_part.strip_prefix("sample_")?.parse().ok()?;
    let raw_mode_index = mode_part
        .strip_prefix("mode_")?
        .strip_suffix(".json")?
        .parse()
        .ok()?;
    Some((sample_index, raw_mode_index))
}

fn eigen_path_calculation_mode(result: &crate::eigen::PathSolveResult) -> &'static str {
    if result.samples.len() > 1
        || result.samples.iter().any(|sample| {
            sample.sample.path_s != 0.0
                || sample
                    .sample
                    .k_vector
                    .iter()
                    .any(|component| *component != 0.0)
        })
    {
        "dispersion_modal"
    } else {
        "free_modes"
    }
}

fn eigen_path_created_at_label() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| format!("unix:{}", duration.as_secs()))
        .unwrap_or_else(|_| "unix:0".to_string())
}

#[cfg(feature = "cuda")]
fn execute_cuda_fdm(
    plan: &FdmPlanIR,
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

    let mut backend = NativeFdmBackend::create(plan)?;
    let device_info = backend.device_info()?;
    let cell_count = (plan.grid.cells[0] as usize)
        * (plan.grid.cells[1] as usize)
        * (plan.grid.cells[2] as usize);
    let initial_magnetization = backend.copy_m(cell_count)?;
    let timestep_policy = if direct_minimizer_control(plan.relaxation.as_ref()).is_some() {
        None
    } else {
        Some(crate::resolve_timestep_policy(
            plan.integrator,
            plan.fixed_timestep,
            plan.adaptive_timestep.as_ref(),
            crate::types::TimestepExecutionLane::fdm_cuda(plan.precision),
        )?)
    };
    let mut steps = Vec::new();
    let provenance = ExecutionProvenance {
        execution_engine: "cuda_fdm".to_string(),
        precision: match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
            fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
        },
        demag_operator_kind: if plan.enable_demag {
            Some("tensor_fft_newell".to_string())
        } else {
            None
        },
        fft_backend: if plan.enable_demag {
            Some("cuFFT".to_string())
        } else {
            None
        },
        device_name: Some(device_info.name.clone()),
        compute_capability: Some(device_info.compute_capability.clone()),
        cuda_driver_version: Some(device_info.driver_version),
        cuda_runtime_version: Some(device_info.runtime_version),
        timestep_policy,
        ..Default::default()
    };
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    let mut scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();
    capture_initial_cuda_fields(&backend, cell_count, &mut field_schedules, &mut artifacts)?;

    let mut latest_stats: Option<StepStats> = None;
    let mut current_time = 0.0;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let mut torque_confirmation = RelaxationTorqueConfirmation::default();
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;
    let mut numerical_stagnation = false;
    let mut current_stats = backend.snapshot_step_stats(plan.grid.cells)?;
    ensure_single_object_scalars(&mut current_stats, "free");

    if let Some(direct_minimizer) = direct_minimizer_control(plan.relaxation.as_ref()) {
        let outcome = crate::fdm::gpu::cuda::direct_minimizer::execute_direct_minimizer(
            &mut backend,
            plan,
            cell_count,
            direct_minimizer,
            current_stats,
            live.as_mut(),
            &mut artifacts,
            &mut steps,
            &mut energy_plateau,
            last_preview_revision,
        )?;
        latest_stats = outcome.latest_stats;
        cancelled = outcome.cancelled;
        numerical_stagnation = outcome.numerical_stagnation;
    } else {
        let mut dt = provenance
            .timestep_policy
            .as_ref()
            .expect("LLG execution requires a resolved timestep policy")
            .initial_dt();
        while current_time < until_seconds {
            if let Some(live) = live.as_mut() {
                if let Some(display_selection) = live.display_selection.map(|get| get()) {
                    let preview_due = display_refresh_due(
                        last_preview_revision,
                        &display_selection,
                        current_stats.step,
                    );
                    let preview_targets_global_scalar =
                        display_is_global_scalar(&display_selection);
                    let preview_field = if preview_due && !preview_targets_global_scalar {
                        let request = display_selection.preview_request();
                        Some(backend.copy_live_preview_field(
                            &request,
                            plan.grid.cells,
                            plan.active_mask.as_deref(),
                        )?)
                    } else {
                        None
                    };
                    let action = (live.on_step)(StepUpdate {
                        coupled_checkpoint: None,
                        stats: current_stats.clone(),
                        grid: live.grid,
                        fem_mesh_generation_id: None,
                        magnetization: None,
                        preview_field,
                        cached_preview_fields: None,
                        hysteresis_field_m_t: None,
                        hysteresis_point_index: None,
                        hysteresis_settle_step_index: None,
                        hysteresis_settle_step_kind: None,
                        hysteresis_settle_step_method: None,
                        scalar_row_due: preview_due && preview_targets_global_scalar,
                        finished: false,
                    });
                    if preview_due {
                        last_preview_revision = Some(display_selection.revision);
                    }
                    if action == StepAction::Stop {
                        cancelled = true;
                        break;
                    }
                }
            }

            let proposed_dt = dt.min(until_seconds - current_time);
            let dt_step = crate::time_events::cap_timestep_to_next_event(
                current_time,
                proposed_dt,
                &time_events.times_s,
                crate::schedules::OUTPUT_TIME_TOLERANCE,
            );
            let interrupt_requested = live
                .as_ref()
                .and_then(|consumer| consumer.interrupt_requested);
            let Some(mut stats) = backend.step_interruptible(dt_step, interrupt_requested)? else {
                continue;
            };
            ensure_single_object_scalars(&mut stats, "free");
            // Keep accepted-step controller telemetry independent of the
            // user-visible scalar cadence.  MuMax-compatible runs often have
            // no scalar schedule, but qualification still requires every
            // accepted step and its retry records.
            artifacts.record_solver_step(&stats);
            current_time = stats.time;
            dt = crate::fdm::next_fdm_attempt_dt(
                plan.adaptive_timestep.is_some(),
                dt,
                stats.dt_suggested,
            );
            latest_stats = Some(stats.clone());
            current_stats = stats.clone();
            let due_scalar_row = scalar_row_due(&scalar_schedules, stats.time);
            let mut sampled_stats = stats.clone();
            let mut magnetization_cache: Option<Vec<[f64; 3]>> = None;
            if due_scalar_row {
                if magnetization_cache.is_none() {
                    magnetization_cache = Some(backend.copy_m(cell_count)?);
                }
                apply_average_m_to_step_stats_with_active_mask(
                    &mut sampled_stats,
                    magnetization_cache
                        .as_deref()
                        .expect("magnetization cache initialized"),
                    plan.active_mask.as_deref(),
                );
            }
            if let Some(live) = live.as_mut() {
                let heavy_payload_every = live.field_every_n.max(1);
                let heavy_payload_due = stats.step % heavy_payload_every == 0;
                if heavy_payload_due && !due_scalar_row {
                    if magnetization_cache.is_none() {
                        magnetization_cache = Some(backend.copy_m(cell_count)?);
                    }
                    apply_average_m_to_step_stats_with_active_mask(
                        &mut sampled_stats,
                        magnetization_cache
                            .as_deref()
                            .expect("magnetization cache initialized"),
                        plan.active_mask.as_deref(),
                    );
                }
                let display_selection = live.display_selection.map(|get| get());
                let preview_due = display_selection
                    .as_ref()
                    .map(|selection| {
                        display_refresh_due(last_preview_revision, selection, stats.step)
                    })
                    .unwrap_or(false);
                let preview_targets_global_scalar = display_selection
                    .as_ref()
                    .is_some_and(display_is_global_scalar);
                if preview_due && preview_targets_global_scalar && !due_scalar_row {
                    if magnetization_cache.is_none() {
                        magnetization_cache = Some(backend.copy_m(cell_count)?);
                    }
                    apply_average_m_to_step_stats_with_active_mask(
                        &mut sampled_stats,
                        magnetization_cache
                            .as_deref()
                            .expect("magnetization cache initialized"),
                        plan.active_mask.as_deref(),
                    );
                }
                let magnetization = if heavy_payload_due {
                    if magnetization_cache.is_none() {
                        magnetization_cache = Some(backend.copy_m(cell_count)?);
                    }
                    Some(flatten_vectors(
                        magnetization_cache
                            .as_deref()
                            .expect("magnetization cache initialized"),
                    ))
                } else {
                    None
                };
                let preview_field = if preview_due && !preview_targets_global_scalar {
                    let selection = display_selection.as_ref().expect("checked preview_due");
                    let request = selection.preview_request();
                    Some(backend.copy_live_preview_field(
                        &request,
                        plan.grid.cells,
                        plan.active_mask.as_deref(),
                    )?)
                } else {
                    None
                };
                let action = (live.on_step)(StepUpdate {
                    coupled_checkpoint: None,
                    stats: sampled_stats.clone(),
                    grid: live.grid,
                    fem_mesh_generation_id: None,
                    magnetization,
                    preview_field,
                    cached_preview_fields: None,
                    hysteresis_field_m_t: None,
                    hysteresis_point_index: None,
                    hysteresis_settle_step_index: None,
                    hysteresis_settle_step_kind: None,
                    hysteresis_settle_step_method: None,
                    scalar_row_due: due_scalar_row
                        || (preview_due && preview_targets_global_scalar),
                    finished: false,
                });
                if preview_due {
                    last_preview_revision = Some(
                        display_selection
                            .as_ref()
                            .expect("checked preview_due")
                            .revision,
                    );
                }
                if action == StepAction::Stop {
                    cancelled = true;
                }
            }
            if cancelled {
                break;
            }
            record_cuda_due_outputs(
                &backend,
                cell_count,
                &sampled_stats,
                magnetization_cache.as_deref(),
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
            let energy_plateau_range = energy_plateau.record(stats.e_total);
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || torque_confirmation.observe_stats(
                        control,
                        &stats,
                        energy_plateau_range,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
                    )
            });
            if stop_for_relaxation {
                break;
            }
        }
    }

    let completion_steps = latest_stats.as_ref().map_or(0, |stats| stats.step);
    let completion_time_s = latest_stats.as_ref().map(|stats| stats.time);
    let completion_max_torque_apm = latest_stats.as_ref().map(|stats| stats.max_torque_Apm);
    let final_magnetization = backend.copy_m(cell_count)?;
    record_cuda_final_outputs(
        &backend,
        cell_count,
        &final_magnetization,
        latest_stats,
        default_scalar_trace,
        &scalar_schedules,
        &field_schedules,
        &mut steps,
        &mut artifacts,
    )?;

    let diagnostic_trace = artifacts.take_solver_steps();
    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    let mut auxiliary_artifacts = Vec::new();
    if let Some(trace) = crate::artifacts::solver_diagnostic_trace_artifact(diagnostic_trace) {
        auxiliary_artifacts.push(trace);
    }
    let status = if cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = crate::relaxation::resolve_stage_completion(
        status,
        plan.relaxation.as_ref(),
        crate::relaxation::RelaxationCompletionMetrics {
            max_torque_apm: completion_max_torque_apm,
            torque_confirmed: torque_confirmation.confirmed(),
            accepted_energy_plateau_range_j: energy_plateau.range(),
            steps: completion_steps,
            relaxation_time_s: completion_time_s,
            numerical_stagnation,
        },
    );

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps,
            final_magnetization,
            completion: Some(completion),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts,
        provenance,
    })
}

#[cfg(feature = "fem-gpu")]
fn native_fem_execution_engine(plan: &FemPlanIR) -> &'static str {
    if crate::native_fem::native_fem_plan_requests_gpu_mfem_device(plan) {
        FemBackendId::GpuNative.provenance_name()
    } else {
        FemBackendId::CpuNative.provenance_name()
    }
}

#[cfg(feature = "fem-gpu")]
fn native_fem_execution_mode(plan: &FemPlanIR) -> &'static str {
    if !crate::native_fem::native_fem_plan_requests_gpu_mfem_device(plan) {
        "cpu_native"
    } else if std::env::var("FULLMAG_FEM_GPU_DEMAG_MODE")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "hybrid_cpu_poisson" | "hybrid" | "compat"
            )
        })
    {
        "hybrid_legacy_sparse"
    } else {
        "all_in_gpu_legacy_sparse"
    }
}

#[cfg(feature = "fem-gpu")]
fn native_fem_llg_mode(plan: &FemPlanIR) -> &'static str {
    if llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()) {
        "pure_damping"
    } else {
        "precessional"
    }
}

#[cfg(feature = "fem-gpu")]
fn validate_all_in_gpu_fem_runtime_contract(
    execution_mode: &str,
    gpu_rk_plan: &NativeFemGpuRkPlanInfo,
) -> Result<(), RunError> {
    if !all_in_gpu_fem_required() {
        return Ok(());
    }
    if execution_mode != "all_in_gpu_legacy_sparse"
        || !native_fem_gpu_rk_plan_is_strict_device_resident(gpu_rk_plan)
    {
        return Err(RunError {
            message: format!(
                "ALL_IN_GPU FEM was requested, but native FEM runtime is not all-in GPU \
                 (execution_mode={}, gpu_rk_exchange_only_enabled={}, \
                 stage_exchange_device_resident={}, fem_exchange_operator_mode={}, \
                 uses_gpu_poisson={}, fem_demag_operator_mode={}, hypre_execution_policy={}, \
                 demag_residency={}, \
                 gpu_rk_block_reason={}, fallback_reason=all_in_gpu_contract_unmet)",
                execution_mode,
                gpu_rk_plan.exchange_only_enabled,
                gpu_rk_plan.stage_exchange_device_resident,
                gpu_rk_plan.exchange_operator_mode,
                gpu_rk_plan.uses_gpu_poisson,
                gpu_rk_plan.demag_operator_mode,
                gpu_rk_plan.hypre_execution_policy,
                gpu_rk_plan.demag_residency,
                if gpu_rk_plan.reason.is_empty() {
                    "none"
                } else {
                    gpu_rk_plan.reason.as_str()
                }
            ),
        });
    }
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn validate_native_fem_gpu_engine_runtime_contract(
    engine: FemEngine,
    gpu_rk_plan: &NativeFemGpuRkPlanInfo,
) -> Result<(), RunError> {
    if engine == FemEngine::NativeGpu && !gpu_rk_plan.exchange_only_enabled {
        return Err(RunError {
            message: format!(
                "native FEM GPU execution was selected, but the native GPU RK plan is disabled: {} (fallback_reason=gpu_rk_plan_disabled)",
                if gpu_rk_plan.reason.is_empty() {
                    "unspecified prerequisite failure"
                } else {
                    gpu_rk_plan.reason.as_str()
                }
            ),
        });
    }
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn native_fem_gpu_rk_plan_is_strict_device_resident(gpu_rk_plan: &NativeFemGpuRkPlanInfo) -> bool {
    gpu_rk_plan.exchange_only_enabled
        && gpu_rk_plan.stage_exchange_device_resident
        && gpu_rk_plan.uses_gpu_poisson
        && gpu_rk_plan.demag_operator_mode == "device_hypre_poisson"
        && gpu_rk_plan.hypre_execution_policy == "device"
        && gpu_rk_plan.demag_residency == "device"
        && matches!(
            gpu_rk_plan.exchange_operator_mode.as_str(),
            "legacy_sparse_gpu" | "partial_assembly_gpu"
        )
}

#[cfg(feature = "fem-gpu")]
fn native_fem_gpu_rk_plan_is_device_resident_for_plan(
    plan: &FemPlanIR,
    gpu_rk_plan: &NativeFemGpuRkPlanInfo,
) -> bool {
    let exchange_device_resident = gpu_rk_plan.exchange_only_enabled
        && gpu_rk_plan.stage_exchange_device_resident
        && matches!(
            gpu_rk_plan.exchange_operator_mode.as_str(),
            "legacy_sparse_gpu" | "partial_assembly_gpu"
        );
    let demag_device_resident = !plan.enable_demag
        || (gpu_rk_plan.uses_gpu_poisson
            && gpu_rk_plan.demag_operator_mode == "device_hypre_poisson"
            && gpu_rk_plan.hypre_execution_policy == "device"
            && gpu_rk_plan.demag_residency == "device");

    exchange_device_resident && demag_device_resident
}

#[cfg(feature = "fem-gpu")]
fn native_fem_relaxation_allows_compute_sync(plan: &FemPlanIR) -> bool {
    matches!(
        plan.relaxation.as_ref().map(|control| control.algorithm),
        Some(
            RelaxationAlgorithmIR::LlgOverdamped
                | RelaxationAlgorithmIR::ProjectedGradientBb
                | RelaxationAlgorithmIR::NonlinearCg
        )
    )
}

#[cfg(feature = "fem-gpu")]
fn native_fem_hot_loop_sync_allowed_for_plan(plan: &FemPlanIR, stats: &StepStats) -> bool {
    let classified_sync = stats
        .hot_loop_exchange_host_sync_count
        .saturating_add(stats.hot_loop_compute_host_sync_count)
        .saturating_add(stats.hot_loop_control_scalar_host_sync_count);
    if stats.hot_loop_host_sync_count > classified_sync {
        return false;
    }
    if stats.hot_loop_exchange_host_sync_count > 0 {
        return false;
    }
    stats.hot_loop_compute_host_sync_count == 0 || native_fem_relaxation_allows_compute_sync(plan)
}

#[cfg(feature = "fem-gpu")]
fn native_fem_data_residency(
    plan: &FemPlanIR,
    stats: Option<&StepStats>,
    gpu_state: Option<&NativeFemGpuStateInfo>,
) -> &'static str {
    if stats
        .map(|entry| !native_fem_hot_loop_sync_allowed_for_plan(plan, entry))
        .unwrap_or(false)
    {
        return NativeFemDataResidency::HostSourceOfTruth.as_str();
    }
    gpu_state
        .map(|state| state.source_of_truth.as_str())
        .unwrap_or(NativeFemDataResidency::HostSourceOfTruth.as_str())
}

#[cfg(feature = "fem-gpu")]
fn native_fem_uses_cuda_kernels(plan: &FemPlanIR) -> bool {
    crate::native_fem::native_fem_plan_requests_gpu_mfem_device(plan)
}

#[cfg(feature = "fem-gpu")]
fn native_fem_uses_gpu_poisson(plan: &FemPlanIR) -> bool {
    crate::native_fem::native_fem_plan_requests_gpu_mfem_device(plan) && plan.enable_demag
}

#[cfg(feature = "fem-gpu")]
fn native_fem_gpu_qualification_status(
    plan: &FemPlanIR,
    stats: Option<&StepStats>,
    gpu_rk_plan: Option<&NativeFemGpuRkPlanInfo>,
) -> &'static str {
    if !crate::native_fem::native_fem_plan_requests_gpu_mfem_device(plan) {
        return "unsupported";
    }
    let Some(rk_plan) = gpu_rk_plan else {
        return if native_fem_uses_cuda_kernels(plan) {
            "source_visible"
        } else {
            "unsupported"
        };
    };
    let hot_loop_clean = stats
        .map(|entry| native_fem_hot_loop_sync_allowed_for_plan(plan, entry))
        .unwrap_or(true);
    if native_fem_execution_mode(plan) == "all_in_gpu_legacy_sparse"
        && native_fem_gpu_rk_plan_is_device_resident_for_plan(plan, rk_plan)
        && hot_loop_clean
    {
        "production_executable"
    } else {
        "source_visible"
    }
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn apply_native_fem_runtime_contract(
    provenance: &mut ExecutionProvenance,
    plan: &FemPlanIR,
    stats: Option<&StepStats>,
    gpu_state: Option<&NativeFemGpuStateInfo>,
    gpu_rk_plan: Option<&NativeFemGpuRkPlanInfo>,
) {
    provenance.fem_execution_mode = Some(native_fem_execution_mode(plan).to_string());
    provenance.fem_gpu_qualification_status =
        Some(native_fem_gpu_qualification_status(plan, stats, gpu_rk_plan).to_string());
    provenance.llg_mode = Some(native_fem_llg_mode(plan).to_string());
    provenance.fem_data_residency =
        Some(native_fem_data_residency(plan, stats, gpu_state).to_string());
    provenance.uses_cuda_kernels = Some(
        gpu_rk_plan
            .map(|plan| plan.uses_cuda_kernels)
            .unwrap_or_else(|| native_fem_uses_cuda_kernels(plan)),
    );
    provenance.uses_gpu_poisson = Some(
        gpu_rk_plan
            .map(|plan| plan.uses_gpu_poisson)
            .unwrap_or_else(|| native_fem_uses_gpu_poisson(plan)),
    );
    provenance.hot_loop_host_sync_count = stats.map(|entry| entry.hot_loop_host_sync_count);
    if let Some(entry) = stats {
        provenance.hot_loop_exchange_h2d_bytes = Some(entry.hot_loop_exchange_h2d_bytes);
        provenance.hot_loop_exchange_d2h_bytes = Some(entry.hot_loop_exchange_d2h_bytes);
        provenance.hot_loop_exchange_host_sync_count =
            Some(entry.hot_loop_exchange_host_sync_count);
        provenance.hot_loop_compute_h2d_bytes = Some(entry.hot_loop_compute_h2d_bytes);
        provenance.hot_loop_compute_d2h_bytes = Some(entry.hot_loop_compute_d2h_bytes);
        provenance.hot_loop_compute_host_sync_count = Some(entry.hot_loop_compute_host_sync_count);
        provenance.hot_loop_control_scalar_d2h_bytes =
            Some(entry.hot_loop_control_scalar_d2h_bytes);
        provenance.hot_loop_control_scalar_host_sync_count =
            Some(entry.hot_loop_control_scalar_host_sync_count);
    }
    if let Some(state) = gpu_state {
        provenance.fem_gpu_state_allocated = Some(state.allocated);
        provenance.fem_gpu_state_node_count = Some(state.node_count);
        provenance.fem_gpu_state_dof_len = Some(state.dof_len);
        provenance.fem_gpu_state_stage_count = Some(state.stage_count);
        provenance.fem_gpu_state_device_bytes = Some(state.device_bytes);
        provenance.fem_gpu_state_reduction_workspace_bytes = Some(state.reduction_workspace_bytes);
    }
    if let Some(rk_plan) = gpu_rk_plan {
        provenance.fem_gpu_rk_exchange_only_enabled = Some(rk_plan.exchange_only_enabled);
        provenance.fem_gpu_rk_stage_count = Some(rk_plan.stage_count);
        provenance.fem_gpu_rk_uses_cuda_kernels = Some(rk_plan.uses_cuda_kernels);
        provenance.fem_gpu_rk_allows_exchange_host_sync = Some(rk_plan.allows_exchange_host_sync);
        provenance.fem_gpu_rk_stage_exchange_device_resident =
            Some(rk_plan.stage_exchange_device_resident);
        provenance.fem_exchange_operator_mode = Some(rk_plan.exchange_operator_mode.clone());
        provenance.fem_demag_operator_mode = Some(rk_plan.demag_operator_mode.clone());
        provenance.hypre_execution_policy = Some(rk_plan.hypre_execution_policy.clone());
        provenance.demag_residency = Some(rk_plan.demag_residency.clone());
        provenance.fem_gpu_rk_block_reason =
            (!rk_plan.reason.is_empty()).then(|| rk_plan.reason.clone());
    }
}

#[cfg(feature = "fem-gpu")]
fn native_fem_requires_initial_snapshot(
    live_present: bool,
    direct_minimization: bool,
    scheduled_fields_present: bool,
) -> bool {
    live_present || direct_minimization || scheduled_fields_present
}

#[cfg(feature = "fem-gpu")]
fn record_native_fem_initial_field_snapshots(
    backend: &mut NativeFemBackend,
    artifacts: &mut ArtifactRecorder,
    field_schedules: &mut [OutputSchedule],
    node_count: usize,
    current_stats: &StepStats,
) -> Result<(), RunError> {
    if current_stats.step != 0 {
        return Ok(());
    }

    let mut names = artifacts.due_accepted_step_fields(current_stats.step, false);
    names.extend(field_schedules.iter().map(|schedule| schedule.name.clone()));
    names.sort();
    names.dedup();
    for name in names {
        if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(
                &name,
                current_stats.step,
                current_stats.time,
                current_stats.dt,
            )?;
            artifacts.record_native_fem_field_snapshot(snapshot)?;
        } else {
            let values = crate::fem::relax::snapshots::copy_native_fem_field_snapshot(
                backend, &name, node_count,
            )?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name,
                step: current_stats.step,
                time: current_stats.time,
                solver_dt: current_stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (current_stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
    }
    advance_due_schedules(field_schedules, current_stats.time);

    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn execute_native_fem(
    engine: FemEngine,
    plan: &FemPlanIR,
    stage_context: &FemStageExecutionContext,
    until_seconds: f64,
    outputs: &[OutputIR],
    mut live: Option<LiveStepConsumer<'_>>,
    artifact_writer: Option<ArtifactPipelineSender>,
    execution_mode: ExecutionMode,
) -> Result<ExecutedRun, RunError> {
    let fem_mesh_generation_id = stage_context.generation_id();
    if until_seconds <= 0.0 {
        return Err(RunError {
            message: "until_seconds must be positive".to_string(),
        });
    }
    let native_relaxation_step =
        crate::fem::relax::algorithm::native_step_control(plan.relaxation.as_ref());
    let time_events = crate::time_events::build_native_fem_stage_event_schedule(
        &plan.field_drives,
        0.0,
        until_seconds,
        outputs,
        crate::schedules::OUTPUT_TIME_TOLERANCE,
        native_relaxation_step.is_none(),
    );
    let mut field_schedules = collect_field_schedules(outputs)?;
    let needs_initial_snapshot = native_fem_requires_initial_snapshot(
        live.as_ref()
            .is_some_and(|consumer| consumer.initial_snapshot),
        native_relaxation_step.is_some(),
        !field_schedules.is_empty(),
    );

    let mut backend =
        NativeFemBackend::create_with_initial_effective_field(plan, needs_initial_snapshot)?;
    backend.begin_stage(plan.time_stage.start_time_s)?;
    let device_info = backend.device_info()?;
    let gpu_state_info = backend.gpu_state_info()?;
    let gpu_rk_plan_info = backend.gpu_rk_plan_info()?;
    validate_native_fem_gpu_engine_runtime_contract(engine, &gpu_rk_plan_info)?;
    let execution_engine = native_fem_execution_engine(plan);
    let native_execution_mode = native_fem_execution_mode(plan);
    validate_all_in_gpu_fem_runtime_contract(native_execution_mode, &gpu_rk_plan_info)?;
    let demag_policy = crate::native_fem::resolved_native_fem_demag_solver_policy(plan);
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
    let timestep_policy =
        if crate::fem::relax::algorithm::native_step_control(plan.relaxation.as_ref()).is_some() {
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
    crate::fem::relax::llg_overdamped::fill_provenance(&mut provenance, plan);
    if native_relaxation_step.is_some() {
        provenance.energy_minimizer_realization = plan.relaxation.as_ref().and_then(|control| {
            crate::relaxation::native_direct_minimizer_realization(
                control.algorithm,
                provenance.execution_engine == "fem_native_gpu",
            )
            .map(str::to_string)
        });
    } else if crate::fem::relax::llg_overdamped::uses_pure_damping(plan) {
        provenance.energy_minimizer_realization =
            Some(crate::relaxation::NATIVE_LLG_TIME_INTEGRATOR_REALIZATION.into());
    }
    apply_native_fem_runtime_contract(
        &mut provenance,
        plan,
        initial_stats,
        Some(&gpu_state_info),
        Some(&gpu_rk_plan_info),
    );
    if execution_mode == ExecutionMode::Strict && execution_engine == "fem_native_gpu" {
        let build_info = native_fem::strict_gpu_runtime_build_info()?;
        provenance.mfem_version = Some(build_info.mfem_version);
        provenance.hypre_version = Some(build_info.hypre_version);
    }
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    if native_relaxation_step.is_some() && current_stats.step == 0 {
        artifacts.record_scalar(&current_stats)?;
    }
    if needs_initial_snapshot && current_stats.step == 0 {
        record_native_fem_initial_field_snapshots(
            &mut backend,
            &mut artifacts,
            &mut field_schedules,
            node_count,
            &current_stats,
        )?;
    }

    let latest_stats: Option<StepStats>;
    let terminal_stats: Option<StepStats>;
    let mut energy_plateau = RelaxationEnergyPlateauWindow::default();
    let backend_completion: Option<fullmag_ir::StageCompletionIR>;
    let last_preview_revision: Option<u64> = None;
    let cancelled: bool;
    let paused: bool;
    let preview_handoff: crate::fem::relax::preview::FemPreviewHandoff;

    if let Some(native_step_control) = native_relaxation_step {
        let outcome = crate::fem::relax::direct_minimizer::execute_direct_minimizer(
            &mut backend,
            engine,
            plan,
            &fem_mesh_generation_id,
            node_count,
            native_step_control,
            current_stats,
            live.as_mut(),
            &mut artifacts,
            &mut steps,
            last_preview_revision,
        )?;
        latest_stats = outcome.latest_stats;
        terminal_stats = outcome.terminal_stats;
        backend_completion = outcome.backend_completion;
        cancelled = outcome.cancelled;
        paused = outcome.paused;
        preview_handoff = outcome.preview_handoff;
    } else {
        let dt = provenance
            .timestep_policy
            .as_ref()
            .expect("LLG execution requires a resolved timestep policy")
            .initial_dt();
        let outcome = crate::fem::relax::llg_overdamped::execute_llg_overdamped(
            &mut backend,
            engine,
            plan,
            &fem_mesh_generation_id,
            plan.time_stage.start_time_s + until_seconds,
            &time_events
                .as_ref()
                .expect("physical-time FEM relaxation requires an event schedule")
                .times_s,
            node_count,
            dt,
            dt_is_fixed,
            current_stats,
            live.as_mut(),
            &mut artifacts,
            &mut steps,
            &mut energy_plateau,
            &mut field_schedules,
            last_preview_revision,
        )?;
        latest_stats = outcome.latest_stats;
        terminal_stats = None;
        backend_completion = outcome.backend_completion;
        cancelled = outcome.cancelled;
        paused = outcome.paused;
        preview_handoff = outcome.preview_handoff;
    }

    crate::fem::relax::finalize::finalize_native_fem_relaxation(
        &mut backend,
        engine,
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
            terminal_stats,
            backend_completion,
            cancelled,
            paused,
            preview_handoff,
        },
    )
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn fem_poisson_demag_provenance(
    plan: &FemPlanIR,
    stats: Option<&StepStats>,
) -> Option<FemPoissonDemagProvenance> {
    if !plan.enable_demag {
        return None;
    }

    let resolved_demag = plan
        .demag_realization
        .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
    let boundary_condition = match resolved_demag {
        fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => "dirichlet",
        fullmag_ir::ResolvedFemDemagIR::PoissonRobin => "robin",
        fullmag_ir::ResolvedFemDemagIR::FredkinKoehler => "fredkin_koehler_fem_bem",
        _ => return None,
    };
    let policy = crate::native_fem::resolved_native_fem_demag_solver_policy(plan);
    let resolved_diagnostics = stats.filter(|entry| {
        entry.demag_potential_order > 0 && entry.demag_potential_true_dof_count > 0
    });

    Some(FemPoissonDemagProvenance {
        linear_solver: policy.solver,
        preconditioner: policy.preconditioner,
        rtol: policy.rtol,
        max_iterations: policy.max_iterations,
        actual_iterations: stats.map(|entry| entry.poisson_iterations),
        final_residual: stats.and_then(|entry| {
            entry
                .poisson_final_residual
                .is_finite()
                .then_some(entry.poisson_final_residual)
        }),
        boundary_condition: boundary_condition.to_string(),
        robin_beta: plan
            .air_box_config
            .as_ref()
            .and_then(|config| config.robin_beta_factor),
        potential_order: resolved_diagnostics.map(|entry| entry.demag_potential_order),
        potential_true_dof_count: resolved_diagnostics
            .map(|entry| entry.demag_potential_true_dof_count),
        variational_energy_joules: resolved_diagnostics.and_then(|entry| {
            entry
                .demag_variational_energy_joules
                .is_finite()
                .then_some(entry.demag_variational_energy_joules)
        }),
        recovered_field_energy_joules: resolved_diagnostics.and_then(|entry| {
            entry
                .demag_recovered_field_energy_joules
                .is_finite()
                .then_some(entry.demag_recovered_field_energy_joules)
        }),
    })
}

#[cfg(not(feature = "fem-gpu"))]
fn execute_native_fem(
    _engine: FemEngine,
    _plan: &FemPlanIR,
    _stage_context: &FemStageExecutionContext,
    _until_seconds: f64,
    _outputs: &[OutputIR],
    _live: Option<LiveStepConsumer<'_>>,
    _artifact_writer: Option<ArtifactPipelineSender>,
    _execution_mode: ExecutionMode,
) -> Result<ExecutedRun, RunError> {
    Err(RunError {
        message:
            "native FEM backend requested but fullmag-runner was built without the 'fem-gpu' feature"
                .to_string(),
    })
}

#[cfg(not(feature = "cuda"))]
fn execute_cuda_fdm(
    _plan: &FdmPlanIR,
    _until_seconds: f64,
    _outputs: &[OutputIR],
    _live: Option<LiveStepConsumer<'_>>,
    _artifact_writer: Option<ArtifactPipelineSender>,
) -> Result<ExecutedRun, RunError> {
    Err(RunError {
        message:
            "CUDA FDM backend requested but fullmag-runner was built without the 'cuda' feature"
                .to_string(),
    })
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
pub(crate) fn flatten_vectors(values: &[[f64; 3]]) -> Vec<f64> {
    values
        .iter()
        .flat_map(|vector| vector.iter().copied())
        .collect()
}

#[cfg(feature = "cuda")]
fn capture_initial_cuda_fields(
    backend: &NativeFdmBackend,
    cell_count: usize,
    field_schedules: &mut [OutputSchedule],
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(0.0, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();

    for name in due_field_names {
        if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(&name, 0, 0.0, 0.0)?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: 0,
                time: 0.0,
                solver_dt: 0.0,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (0 as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
    }
    advance_due_schedules(field_schedules, 0.0);
    Ok(())
}

#[cfg(feature = "cuda")]
fn record_cuda_due_outputs(
    backend: &NativeFdmBackend,
    cell_count: usize,
    stats: &StepStats,
    magnetization: Option<&[[f64; 3]]>,
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(stats.time, schedule.next_time));
    if scalar_due {
        let mut sampled_stats = stats.clone();
        if let Some(magnetization) = magnetization {
            backend.apply_average_m_to_step_stats_from_values(&mut sampled_stats, magnetization);
        } else {
            backend.apply_average_m_to_step_stats(&mut sampled_stats)?;
        }
        artifacts.record_scalar(&sampled_stats)?;
        steps.push(sampled_stats);
        advance_due_schedules(scalar_schedules, stats.time);
    }

    let due_field_names = field_schedules
        .iter()
        .filter(|schedule| is_due(stats.time, schedule.next_time))
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    for name in due_field_names {
        if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(&name, stats.step, stats.time, stats.dt)?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: stats.step,
                time: stats.time,
                solver_dt: stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
    }
    advance_due_schedules(field_schedules, stats.time);
    Ok(())
}

#[cfg(feature = "cuda")]
fn record_cuda_final_outputs(
    backend: &NativeFdmBackend,
    cell_count: usize,
    final_magnetization: &[[f64; 3]],
    latest_stats: Option<StepStats>,
    default_scalar_trace: bool,
    scalar_schedules: &[OutputSchedule],
    field_schedules: &[OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let Some(latest_stats) = latest_stats else {
        return Ok(());
    };

    let has_current_scalar = steps
        .last()
        .map(|stats| stats.step == latest_stats.step && same_time(stats.time, latest_stats.time))
        .unwrap_or(false);
    let need_scalar = !has_current_scalar
        && (default_scalar_trace
            || steps
                .last()
                .map(|stats| !same_time(stats.time, latest_stats.time))
                .unwrap_or(true));
    if need_scalar {
        let mut final_stats = latest_stats.clone();
        backend.apply_average_m_to_step_stats_from_values(&mut final_stats, final_magnetization);
        artifacts.record_scalar(&final_stats)?;
        steps.push(final_stats);
    }
    let _ = scalar_schedules;

    let requested_field_names = field_schedules
        .iter()
        .filter(|schedule| {
            schedule
                .last_sampled_time
                .map(|time| !same_time(time, latest_stats.time))
                .unwrap_or(true)
        })
        .map(|schedule| schedule.name.clone())
        .collect::<Vec<_>>();
    let missing_field_names = requested_field_names;

    for name in missing_field_names {
        if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(
                &name,
                latest_stats.step,
                latest_stats.time,
                latest_stats.dt,
            )?;
            artifacts.record_native_field_snapshot(snapshot)?;
        } else {
            let values = copy_cuda_field_snapshot(backend, &name, cell_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name,
                step: latest_stats.step,
                time: latest_stats.time,
                solver_dt: latest_stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (latest_stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
    }

    Ok(())
}

#[cfg(feature = "cuda")]
fn copy_cuda_field_snapshot(
    backend: &NativeFdmBackend,
    name: &str,
    cell_count: usize,
) -> Result<Vec<[f64; 3]>, RunError> {
    let quantity = normalized_quantity_name(name).map_err(|_| RunError {
        message: format!("unsupported CUDA field snapshot '{}'", name),
    })?;
    match quantity {
        "m" => backend.copy_m(cell_count),
        "H_ex" => backend.copy_h_ex(cell_count),
        "H_demag" => backend.copy_h_demag(cell_count),
        "H_ext" => backend.copy_h_ext(cell_count),
        "H_oe" => backend.copy_h_oe(cell_count),
        "H_ani" => backend.copy_h_ani(cell_count),
        "H_eff" => backend.copy_h_eff(cell_count),
        other => Err(RunError {
            message: format!("unsupported CUDA field snapshot '{}'", other),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eigen::EigenSolverModel;
    use crate::types::AuxiliaryArtifact;
    use fullmag_ir::{
        AntennaIR, BackendTarget, CurrentModuleIR, CurrentTransportModelIR, DiscretizationHintsIR,
        FdmHintsIR, FemHintsIR, FemMeshPartIR, FemMeshPartRole, FemMeshPartSelector,
        FemObjectSegmentIR, FemPlanIR, MeshIR, ProblemIR, RfDriveIR,
    };
    #[cfg(feature = "fem-gpu")]
    use fullmag_ir::{RelaxStopIR, RelaxationAlgorithmIR, RelaxationControlIR};
    use serde_json::Value;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new() -> Self {
            let unique = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "fullmag-dispatch-tests-{}-{}-{}",
                std::process::id(),
                nanos,
                unique
            ));
            fs::create_dir_all(&path).expect("create temp dispatch test dir");
            Self { path }
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn cpu_fdm_capability_accepts_oersted_cylinder() {
        let mut plan = fullmag_ir::FdmPlanIR::default();
        plan.has_oersted_cylinder = true;

        assert!(unsupported_cpu_fdm_terms(&plan, &[]).is_empty());
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn fem_plan_for_native_gpu_ignores_cpu_mfem_device_env() {
        let _guard = env_lock().lock().expect("env mutex");
        unsafe {
            std::env::set_var("FULLMAG_FEM_MFEM_DEVICE", "ceed-cpu");
        }

        let gpu_plan = fem_plan_for_native_gpu(&tiny_fem_plan());

        unsafe {
            std::env::remove_var("FULLMAG_FEM_MFEM_DEVICE");
        }
        assert_eq!(gpu_plan.mfem_device_string.as_deref(), Some("cuda"));
    }

    #[test]
    fn native_cuda_field_outputs_use_shared_local_field_copy_helper() {
        let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("dispatch.rs should be readable");

        assert!(
            source.contains("fn copy_cuda_field_snapshot("),
            "native CUDA field outputs should share one copy helper"
        );
        assert!(
            source.contains("\"H_oe\" => backend.copy_h_oe(cell_count)")
                && source.contains("\"H_ani\" => backend.copy_h_ani(cell_count)"),
            "native CUDA field output helper must expose H_oe and H_ani local fields"
        );

        for function_name in [
            "capture_initial_cuda_fields",
            "record_cuda_due_outputs",
            "record_cuda_final_outputs",
        ] {
            let body_start = source
                .find(&format!("fn {function_name}("))
                .unwrap_or_else(|| panic!("{function_name} should exist"));
            let body = &source[body_start..];
            assert!(
                body.contains("copy_cuda_field_snapshot(backend, &name, cell_count)?"),
                "{function_name} should use the shared native CUDA field copy helper"
            );
        }
    }

    #[test]
    fn native_cuda_scalar_output_boundary_reduces_m_before_recording() {
        let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("dispatch.rs should be readable");
        let body_start = source
            .find("fn record_cuda_due_outputs(")
            .expect("record_cuda_due_outputs should exist");
        let body = &source[body_start..];
        let body = body
            .split("fn record_cuda_final_outputs(")
            .next()
            .expect("record_cuda_due_outputs body should be bounded");
        assert!(
            body.contains("apply_average_m_to_step_stats"),
            "native CUDA scalar rows must publish averaged magnetization components"
        );

        let final_output_body = source
            .split("fn record_cuda_final_outputs(")
            .nth(1)
            .expect("record_cuda_final_outputs should exist");
        assert!(
            final_output_body.contains("final_magnetization")
                && final_output_body.contains("apply_average_m_to_step_stats_from_values"),
            "native CUDA final scalar rows must reduce the same magnetization snapshot used by m_final"
        );

        let execution = source
            .split("#[cfg(feature = \"cuda\")]\nfn execute_cuda_fdm(")
            .nth(1)
            .and_then(|body| body.split("#[cfg(feature = \"fem-gpu\")]\n").next())
            .expect("active CUDA execution body should be present");
        assert!(
            execution.contains("let heavy_payload_due = stats.step % heavy_payload_every == 0;")
                && execution.contains("if heavy_payload_due && !due_scalar_row")
                && execution.contains("let magnetization = if heavy_payload_due"),
            "native CUDA live rows carrying a full magnetization payload must use the averaged stats"
        );
        assert!(
            execution.contains("let final_magnetization = backend.copy_m(cell_count)?;")
                && execution.contains("&final_magnetization,\n        latest_stats"),
            "native CUDA final scalar publication must share the final m snapshot"
        );
    }

    #[test]
    fn native_fem_field_outputs_expose_dmi_snapshot_quantities() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("dispatch.rs should be readable");
        let snapshots = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/snapshots.rs"
        ))
        .expect("fem/relax/snapshots.rs should be readable");
        let finalize = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/finalize.rs"
        ))
        .expect("fem/relax/finalize.rs should be readable");
        let native_fem =
            fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/native_fem.rs"))
                .expect("native_fem.rs should be readable");
        let helper_signature = ["pub(crate) fn ", "copy_native_fem_field_snapshot"].concat();

        assert!(
            !dispatch.contains(&helper_signature),
            "dispatch.rs must not own native FEM relaxation field snapshot copying"
        );
        assert!(
            snapshots.contains(&helper_signature),
            "native FEM relaxation field outputs should share one copy helper"
        );
        assert!(
            snapshots.contains("begin_field_snapshot(quantity, 0, 0.0, 0.0)?")
                && native_fem.contains(
                    &[
                        "QuantityId::HDmi => ffi::",
                        "fullmag_",
                        "fem_observable::",
                        "FULLMAG_FEM_OBSERVABLE_H_DMI",
                    ]
                    .concat()
                )
                && native_fem.contains(
                    &[
                        "QuantityId::HDmiBulk => ffi::",
                        "fullmag_",
                        "fem_observable::",
                        "FULLMAG_FEM_OBSERVABLE_H_DMI_BULK",
                    ]
                    .concat()
                ),
            "native FEM field output helper must expose interfacial and bulk DMI fields"
        );
        assert!(
            finalize
                .contains("copy_native_fem_field_snapshot(backend, &schedule.name, node_count)?"),
            "native FEM final field snapshots should use the shared field copy helper"
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn steady_transport_outputs_are_satisfied_by_the_steady_publisher() {
        for output in [
            OutputIR::Field {
                name: "V_electric".into(),
                every_seconds: 1.0,
            },
            OutputIR::Snapshot {
                field: "J_charge".into(),
                component: "3D".into(),
                every_seconds: 1.0,
                layer: None,
            },
            OutputIR::SaveQuantity {
                quantity_id: "spin_current_tensor".into(),
                every_seconds: 1.0,
                reduction: None,
                component: None,
            },
        ] {
            assert!(steady_transport_output(&output));
        }
        assert!(!steady_transport_output(&OutputIR::Field {
            name: "m".into(),
            every_seconds: 1.0,
        }));
        assert!(!steady_transport_output(&OutputIR::Field {
            name: "J_charge.x".into(),
            every_seconds: 1.0,
        }));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn steady_transport_component_schedule_is_rejected_before_execution() {
        let mut plan = tiny_fem_plan();
        plan.spin_transport_plans = vec![crate::native_fem::test_resolved_steady_transport_plan()];
        for output in [
            OutputIR::Field {
                name: "J_charge.x".into(),
                every_seconds: 1.0,
            },
            OutputIR::Snapshot {
                field: "J_charge".into(),
                component: "x".into(),
                every_seconds: 1.0,
                layer: None,
            },
            OutputIR::Snapshot {
                field: "J_charge".into(),
                component: "3D".into(),
                every_seconds: 1.0,
                layer: Some("layer-0".into()),
            },
            OutputIR::SaveQuantity {
                quantity_id: "J_charge".into(),
                every_seconds: 1.0,
                reduction: Some("average".into()),
                component: None,
            },
            OutputIR::SaveQuantity {
                quantity_id: "J_charge".into(),
                every_seconds: 1.0,
                reduction: None,
                component: Some("x".into()),
            },
        ] {
            let error = reject_unsupported_steady_transport_component_outputs(
                &plan,
                std::slice::from_ref(&output),
            )
            .expect_err("qualified transport schedules must fail closed");
            assert!(error.message.contains("J_charge"), "{}", error.message);
        }
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn non_streaming_fem_dispatch_retains_scheduled_transport_fields() {
        if !crate::native_fem::is_cpu_available() {
            eprintln!("skipping non-streaming FEM transport test: CPU MFEM stack unavailable");
            return;
        }
        let mut plan = tiny_fem_plan();
        let resolved = crate::native_fem::test_resolved_steady_transport_plan();
        let descriptor = resolved.fem_cpu_double.as_ref().expect("FEM descriptor");
        plan.current_modules = vec![fullmag_ir::CurrentModuleIR::CurrentTransport {
            name: resolved.current_source_id.clone(),
            model: fullmag_ir::CurrentTransportModelIR::OhmicPoisson,
            current_density: None,
            solve_region: None,
            conductivity_s_per_m: None,
            coupling: fullmag_ir::TransportCouplingIR::OneWay,
            definition: Some(descriptor.charge_definition.clone()),
        }];
        plan.spin_transport_plans = vec![resolved];
        let outputs = vec![
            OutputIR::Field {
                name: "V_electric".into(),
                every_seconds: 1.0,
            },
            OutputIR::Field {
                name: "spin_current_tensor".into(),
                every_seconds: 1.0,
            },
        ];

        let executed = execute_fem(FemEngine::CpuNative, &plan, 1.0e-13, &outputs, None, None)
            .expect("steady publisher should satisfy transport schedules");
        assert_eq!(executed.field_snapshot_count, 5);
        assert_eq!(executed.provenance.transport_modules.len(), 1);
        assert_eq!(
            executed
                .field_snapshots
                .iter()
                .map(|snapshot| snapshot.name.as_str())
                .collect::<Vec<_>>(),
            [
                "V_electric",
                "J_charge",
                "spin_potential",
                "spin_current_tensor",
                "torque_stt",
            ]
        );
    }

    fn fem_policy_problem() -> ProblemIR {
        let mut problem = ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = BackendTarget::Fem;
        problem.backend_policy.discretization_hints = Some(DiscretizationHintsIR {
            fdm: Some(FdmHintsIR {
                cell: [2e-9, 2e-9, 2e-9],
                default_cell: None,
                per_magnet: None,
                demag: None,
                boundary_correction: None,
                boundary_phi_floor: None,
                boundary_delta_min: None,
            }),
            fem: Some(FemHintsIR {
                order: 1,
                hmax: 2e-9,
                mesh: None,
                demag_solver_policy: None,
            }),
            hybrid: None,
        });
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            Value::Object(
                [("device".to_string(), Value::String("gpu".to_string()))]
                    .into_iter()
                    .collect(),
            ),
        );
        problem
    }

    pub(crate) fn tiny_fem_plan() -> FemPlanIR {
        FemPlanIR {
            mesh_name: "unit_tet".to_string(),
            mesh_source: None,
            mesh: MeshIR {
                mesh_name: "unit_tet".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                    [0, 1, 2],
                    [0, 3, 1],
                    [0, 2, 3],
                    [1, 3, 2],
                ]),
                boundary_markers: vec![1, 1, 1, 1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 0.4,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: fullmag_ir::MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.02,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
                uniaxial_anisotropy_k2: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            antenna_zeeman_masks: Vec::new(),
            field_drives: Vec::new(),
            field_drive_geometry_masks: Vec::new(),
            time_stage: Default::default(),
            current_modules: Vec::new(),
            spin_transport_plans: Vec::new(),
            gyromagnetic_ratio: 2.211e5,
            precision: fullmag_ir::ExecutionPrecision::Double,
            exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
            integrator: Some(fullmag_ir::IntegratorChoice::Heun),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
            temperature: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            spin_torque_contract: None,
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
            magnetoelastic: None,
            mechanics: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            dmi_interface_normal: None,
            use_consistent_mass: None,
        }
    }

    fn stt_only_fem_plan() -> FemPlanIR {
        let mut plan = tiny_fem_plan();
        plan.enable_exchange = false;
        plan.current_density = Some([1.0e11, 0.0, 0.0]);
        plan.stt_beta = Some(0.1);
        plan
    }

    fn canonical_stt_fem_plan(formula_version: &str) -> FemPlanIR {
        let mut plan = tiny_fem_plan();
        plan.enable_exchange = true;
        plan.current_density = Some([1.0e11, 0.0, 0.0]);
        plan.stt_degree = Some(0.4);
        plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: formula_version.to_string(),
            operator_version: (formula_version == "zhang_li.fullmag.v1")
                .then(|| "zl_central_reference_v1".to_string()),
            realization_version: (formula_version == "slonczewski.fullmag.v2")
                .then(|| "slonczewski_thin_layer_homogenized.v1".to_string()),
            target: Some(fullmag_ir::RegionRefIR {
                object_id: "free".to_string(),
                region_id: None,
            }),
            stack_normal: (formula_version == "slonczewski.fullmag.v2").then_some([0.0, 0.0, 1.0]),
            lande_g: (formula_version == "zhang_li.fullmag.v1").then_some(2.0),
            active_node_mask: Some(vec![true; 4]),
            active_element_mask: Some(vec![true]),
        });
        plan
    }

    fn oersted_only_fem_plan() -> FemPlanIR {
        let mut plan = tiny_fem_plan();
        plan.enable_exchange = false;
        let mut field = vec![0.0; plan.mesh.nodes.len() * 3];
        for value in field.iter_mut().skip(1).step_by(3) {
            *value = 1.0e3;
        }
        plan.oersted_field_xyz = Some(field);
        plan
    }

    fn tiny_fem_eigen_plan(k_sampling: Option<fullmag_ir::KSamplingIR>) -> FemEigenPlanIR {
        let plan = tiny_fem_plan();
        FemEigenPlanIR {
            mesh_build_report: None,
            mesh_name: plan.mesh_name,
            mesh_source: plan.mesh_source,
            mesh: plan.mesh,
            object_segments: plan.object_segments,
            mesh_parts: plan.mesh_parts,
            domain_mesh_mode: plan.domain_mesh_mode,
            domain_frame: plan.domain_frame,
            fe_order: plan.fe_order,
            hmax: plan.hmax,
            equilibrium_magnetization: plan.initial_magnetization,
            material: plan.material,
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            count: 1,
            target: fullmag_ir::EigenTargetIR::Lowest,
            equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
            k_sampling,
            normalization: fullmag_ir::EigenNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Ignore,
            enable_exchange: true,
            enable_demag: false,
            interfacial_dmi: None,
            dmi_interface_normal: None,
            bulk_dmi: None,
            external_field: None,
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
            precision: plan.precision,
            exchange_bc: plan.exchange_bc,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            demag_realization: None,
            air_box_config: None,
            mode_tracking: None,
            dispersion_validation: None,
            k0_kittel_validation: None,
        }
    }

    #[test]
    fn execute_fem_dmi_pbc_routes_to_native_after_pr5b() {
        // DMI + PBC now routes to NativeAnisotropy (no demag) after PR-5B.
        // Anisotropy alone is native since PR-2; demag alone is native since PR-4;
        // DMI alone is native since PR-5B.
        let mut plan = tiny_fem_plan();
        plan.initial_magnetization[1] = [0.0, 1.0, 0.0];
        plan.interfacial_dmi = Some(1e-4); // DMI is now native via class projection
        plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_periodic".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 1,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }];
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_periodic".to_string(),
            node_a: 0,
            node_b: 1,
        }];

        // DMI (no demag) routes to NativeAnisotropy, which IS native.
        assert!(fem_static_periodic_native_exchange_supported(&plan));

        // Verify the decision lane is NativeAnisotropy.
        let plan_ir = plan.clone();
        let decision = fem_static_periodic_decision(&plan_ir);
        assert_eq!(decision.lane, FemStaticPbcLane::NativeAnisotropy);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn fem_poisson_demag_provenance_records_policy_and_solve_stats() {
        let mut plan = tiny_fem_plan();
        plan.enable_demag = true;
        plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        plan.demag_solver_policy = Some(fullmag_ir::FemLinearSolverPolicy {
            solver: "GMRES".to_string(),
            preconditioner: "Jacobi".to_string(),
            rtol: 1e-6,
            max_iterations: 77,
            ..Default::default()
        });
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 4.0,
            grading: 1.4,
            boundary_marker: 99,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("user".to_string()),
            robin_beta_factor: Some(2.5),
            shape: Some("bbox".to_string()),
            factor_source: Some("user".to_string()),
            boundary_marker_source: Some("mesh_marker_99".to_string()),
        });
        let stats = StepStats {
            poisson_iterations: 13,
            poisson_final_residual: 4.0e-9,
            demag_potential_order: 2,
            demag_potential_true_dof_count: 321,
            demag_variational_energy_joules: 1.25e-18,
            demag_recovered_field_energy_joules: 1.24e-18,
            ..StepStats::default()
        };

        let provenance = fem_poisson_demag_provenance(&plan, Some(&stats))
            .expect("poisson demag provenance should be present");

        assert_eq!(provenance.linear_solver, "GMRES");
        assert_eq!(provenance.preconditioner, "Jacobi");
        assert_eq!(provenance.rtol, 1e-6);
        assert_eq!(provenance.max_iterations, 77);
        assert_eq!(provenance.actual_iterations, Some(13));
        assert_eq!(provenance.final_residual, Some(4.0e-9));
        assert_eq!(provenance.boundary_condition, "robin");
        assert_eq!(provenance.robin_beta, Some(2.5));
        assert_eq!(provenance.potential_order, Some(2));
        assert_eq!(provenance.potential_true_dof_count, Some(321));
        assert_eq!(provenance.variational_energy_joules, Some(1.25e-18));
        assert_eq!(provenance.recovered_field_energy_joules, Some(1.24e-18));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn fem_poisson_demag_provenance_preserves_periodic_p1_and_nonpositive_energies() {
        let mut plan = tiny_fem_plan();
        plan.enable_demag = true;
        plan.fe_order = 2;
        plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_periodic".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        let stats = StepStats {
            demag_potential_order: 1,
            demag_potential_true_dof_count: 77,
            demag_variational_energy_joules: 0.0,
            demag_recovered_field_energy_joules: -2.5e-19,
            ..StepStats::default()
        };

        let provenance = fem_poisson_demag_provenance(&plan, Some(&stats))
            .expect("periodic Poisson demag provenance should be present");

        assert_eq!(provenance.potential_order, Some(1));
        assert_eq!(provenance.potential_true_dof_count, Some(77));
        assert_eq!(provenance.variational_energy_joules, Some(0.0));
        assert_eq!(provenance.recovered_field_energy_joules, Some(-2.5e-19));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn fem_poisson_demag_provenance_omits_unavailable_zero_diagnostics() {
        let mut plan = tiny_fem_plan();
        plan.enable_demag = true;
        plan.fe_order = 2;
        plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet);
        let stats = StepStats {
            demag_potential_order: 0,
            demag_potential_true_dof_count: 0,
            demag_variational_energy_joules: 1.0,
            demag_recovered_field_energy_joules: -1.0,
            ..StepStats::default()
        };

        let provenance = fem_poisson_demag_provenance(&plan, Some(&stats))
            .expect("Dirichlet Poisson demag provenance should be present");

        assert_eq!(provenance.potential_order, None);
        assert_eq!(provenance.potential_true_dof_count, None);
        assert_eq!(provenance.variational_energy_joules, None);
        assert_eq!(provenance.recovered_field_energy_joules, None);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn fem_poisson_demag_provenance_omits_nonfinite_energies() {
        let mut plan = tiny_fem_plan();
        plan.enable_demag = true;
        plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        let stats = StepStats {
            demag_potential_order: 2,
            demag_potential_true_dof_count: 321,
            demag_variational_energy_joules: f64::NAN,
            demag_recovered_field_energy_joules: f64::NEG_INFINITY,
            ..StepStats::default()
        };

        let provenance = fem_poisson_demag_provenance(&plan, Some(&stats))
            .expect("Poisson demag provenance should be present");

        assert_eq!(provenance.potential_order, Some(2));
        assert_eq!(provenance.potential_true_dof_count, Some(321));
        assert_eq!(provenance.variational_energy_joules, None);
        assert_eq!(provenance.recovered_field_energy_joules, None);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn fem_poisson_demag_provenance_records_resolved_gpu_default_policy() {
        let mut plan = tiny_fem_plan();
        plan.enable_demag = true;
        plan.mfem_device_string = Some("cuda".to_string());
        plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);

        let provenance = fem_poisson_demag_provenance(&plan, None)
            .expect("poisson demag provenance should be present");

        assert_eq!(provenance.linear_solver, "CG");
        assert_eq!(provenance.preconditioner, "JACOBI");
        assert_eq!(provenance.rtol, 1e-8);
        assert_eq!(provenance.max_iterations, 500);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn fem_fredkin_koehler_demag_provenance_records_method_and_solve_stats() {
        let mut plan = tiny_fem_plan();
        plan.enable_demag = true;
        plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::FredkinKoehler);
        plan.air_box_config = None;
        let stats = StepStats {
            poisson_iterations: 21,
            poisson_final_residual: 7.0e-8,
            ..StepStats::default()
        };

        let provenance = fem_poisson_demag_provenance(&plan, Some(&stats))
            .expect("Fredkin-Koehler demag provenance should be present");

        assert_eq!(provenance.boundary_condition, "fredkin_koehler_fem_bem");
        assert_eq!(provenance.actual_iterations, Some(21));
        assert_eq!(provenance.final_residual, Some(7.0e-8));
        assert_eq!(provenance.robin_beta, None);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_initial_snapshot_is_lazy_for_headless_time_domain() {
        assert!(!native_fem_requires_initial_snapshot(false, false, false));
        assert!(native_fem_requires_initial_snapshot(true, false, false));
        assert!(native_fem_requires_initial_snapshot(false, true, false));
        assert!(native_fem_requires_initial_snapshot(false, false, true));
    }

    #[test]
    fn native_fem_direct_minimizer_records_initial_field_snapshots_before_relaxation() {
        let source = include_str!("dispatch.rs");
        let helper = "record_native_fem_initial_field_snapshots";
        let helper_pos = source
            .find(helper)
            .expect("native FEM dispatch must define an initial field snapshot helper");
        let execute_pos = source
            .find("fn execute_native_fem(")
            .expect("native FEM execute function must exist");
        let branch_pos = source
            .find("if let Some(native_step_control) = native_relaxation_step")
            .expect("native FEM execute must branch into relaxation loops");
        let execute_body = &source[execute_pos..branch_pos];

        assert!(
            helper_pos < execute_pos,
            "helper should be defined before execute_native_fem"
        );
        assert!(
            execute_body.contains(helper),
            "native FEM must record requested step-0 field snapshots before any relaxation loop"
        );
        assert!(
            execute_body.contains("current_stats.step == 0"),
            "initial native FEM field snapshots must be tied to the computed step-0 stats"
        );
        let scalar_pos = execute_body
            .find("artifacts.record_scalar(&current_stats)?;")
            .expect("native FEM direct minimization must record the existing step-0 stats");
        let snapshot_pos = execute_body
            .rfind(helper)
            .expect("native FEM direct minimization must record step-0 fields");
        assert!(
            execute_body[..scalar_pos].contains("native_relaxation_step.is_some()")
                && scalar_pos < snapshot_pos,
            "step-0 scalar evidence must be direct-minimizer-only and precede field snapshots"
        );
        let helper_body = &source[helper_pos..execute_pos];
        assert!(
            helper_body.contains("field_schedules: &mut [OutputSchedule]"),
            "initial native FEM field snapshots must mutate their schedules"
        );
        assert!(
            helper_body.contains("advance_due_schedules(field_schedules, current_stats.time)"),
            "a successful step-0 snapshot must advance the schedule before the first accepted step"
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_runtime_contract_uses_gpu_state_info() {
        let plan = tiny_fem_plan();
        let stats = StepStats {
            hot_loop_host_sync_count: 0,
            ..StepStats::default()
        };
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 8,
            dof_len: 24,
            stage_count: 4,
            device_bytes: 32768,
            reduction_workspace_bytes: 512,
            source_of_truth: NativeFemDataResidency::DeviceSourceOfTruth,
        };
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(
            &mut provenance,
            &plan,
            Some(&stats),
            Some(&gpu_state),
            None,
        );

        assert_eq!(
            provenance.fem_data_residency.as_deref(),
            Some("device_source_of_truth")
        );
        assert_eq!(provenance.fem_gpu_state_allocated, Some(true));
        assert_eq!(provenance.fem_gpu_state_node_count, Some(8));
        assert_eq!(provenance.fem_gpu_state_dof_len, Some(24));
        assert_eq!(provenance.fem_gpu_state_stage_count, Some(4));
        assert_eq!(provenance.fem_gpu_state_device_bytes, Some(32768));
        assert_eq!(
            provenance.fem_gpu_state_reduction_workspace_bytes,
            Some(512)
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_runtime_contract_records_llg_mode() {
        let mut plan = tiny_fem_plan();
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: None,
                max_relaxation_time_s: None,
            },
        });
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(&mut provenance, &plan, None, None, None);

        assert_eq!(provenance.llg_mode.as_deref(), Some("pure_damping"));

        plan.relaxation = None;
        apply_native_fem_runtime_contract(&mut provenance, &plan, None, None, None);

        assert_eq!(provenance.llg_mode.as_deref(), Some("precessional"));
    }

    #[cfg(feature = "fem-gpu")]
    fn gpu_device_info_for_log_test() -> native_fem::DeviceInfo {
        native_fem::DeviceInfo {
            name: "NVIDIA test GPU".to_string(),
            compute_capability: "8.9".to_string(),
            driver_version: 13010,
            runtime_version: 12060,
            memory_free_bytes: 8_000_000_000,
            memory_total_bytes: 12_000_000_000,
        }
    }

    #[cfg(feature = "fem-gpu")]
    fn gpu_rk_ready_plan_for_log_test() -> NativeFemGpuRkPlanInfo {
        NativeFemGpuRkPlanInfo {
            exchange_only_enabled: true,
            stage_count: 2,
            uses_cuda_kernels: true,
            allows_exchange_host_sync: false,
            stage_exchange_device_resident: true,
            uses_gpu_poisson: true,
            exchange_operator_mode: "legacy_sparse_gpu".to_string(),
            demag_operator_mode: "device_hypre_poisson".to_string(),
            hypre_execution_policy: "device".to_string(),
            demag_residency: "device".to_string(),
            reason: String::new(),
        }
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_gpu_ready_log_confirms_device_residency() {
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 16_502,
            dof_len: 49_506,
            stage_count: 7,
            device_bytes: 275_000_000,
            reduction_workspace_bytes: 2_000_000,
            source_of_truth: NativeFemDataResidency::DeviceSourceOfTruth,
        };
        let device_info = gpu_device_info_for_log_test();
        let rk_plan = gpu_rk_ready_plan_for_log_test();

        let (level, message) =
            native_fem_gpu_ready_log_message(&gpu_state, &device_info, Some(&rk_plan));

        assert_eq!(level, "info");
        assert_eq!(
            message,
            "native FEM GPU ready: mesh, material fields, magnetization, and demag data are loaded on the CUDA device; nodes=16502 dof=49506 stages=7 device_buffers=0.275 GB reduction_workspace=2.0 MB vram_free=8.000 GB vram_total=12.000 GB initial_residency=device_source_of_truth"
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_gpu_ready_log_confirms_device_demag_when_initial_source_is_host() {
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 171,
            dof_len: 513,
            stage_count: 2,
            device_bytes: 1_000_000,
            reduction_workspace_bytes: 0,
            source_of_truth: NativeFemDataResidency::HostSourceOfTruth,
        };
        let device_info = gpu_device_info_for_log_test();
        let rk_plan = gpu_rk_ready_plan_for_log_test();

        let (level, message) =
            native_fem_gpu_ready_log_message(&gpu_state, &device_info, Some(&rk_plan));

        assert_eq!(level, "info");
        assert!(message.contains("demag data are loaded on the CUDA device"));
        assert!(message.contains("initial_residency=host_source_of_truth"));
        assert!(message.contains("vram_free=8.000 GB vram_total=12.000 GB"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_gpu_ready_log_warns_when_data_is_not_device_truth() {
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 8,
            dof_len: 24,
            stage_count: 4,
            device_bytes: 32_768,
            reduction_workspace_bytes: 512,
            source_of_truth: NativeFemDataResidency::Mixed,
        };
        let device_info = gpu_device_info_for_log_test();

        let (level, message) = native_fem_gpu_ready_log_message(&gpu_state, &device_info, None);

        assert_eq!(level, "warning");
        assert!(message.contains("data residency is mixed"));
        assert!(message.contains("vram_free=8.000 GB vram_total=12.000 GB"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_runtime_contract_does_not_publish_device_residency_with_hot_loop_sync() {
        let mut plan = tiny_fem_plan();
        plan.mfem_device_string = Some("cuda".to_string());
        let stats = StepStats {
            hot_loop_host_sync_count: 3,
            ..StepStats::default()
        };
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 8,
            dof_len: 24,
            stage_count: 4,
            device_bytes: 32768,
            reduction_workspace_bytes: 512,
            source_of_truth: NativeFemDataResidency::DeviceSourceOfTruth,
        };
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(
            &mut provenance,
            &plan,
            Some(&stats),
            Some(&gpu_state),
            None,
        );

        assert_eq!(
            provenance.fem_data_residency.as_deref(),
            Some("host_source_of_truth")
        );
        assert_eq!(provenance.hot_loop_host_sync_count, Some(3));
        assert_eq!(provenance.fem_gpu_state_allocated, Some(true));
        assert_eq!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("source_visible")
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_runtime_contract_marks_strict_device_gpu_as_executable_not_validated() {
        let mut plan = tiny_fem_plan();
        plan.mfem_device_string = Some("cuda".to_string());
        let stats = StepStats {
            hot_loop_host_sync_count: 0,
            ..StepStats::default()
        };
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 8,
            dof_len: 24,
            stage_count: 4,
            device_bytes: 32768,
            reduction_workspace_bytes: 512,
            source_of_truth: NativeFemDataResidency::DeviceSourceOfTruth,
        };
        let rk_plan = gpu_rk_ready_plan_for_log_test();
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(
            &mut provenance,
            &plan,
            Some(&stats),
            Some(&gpu_state),
            Some(&rk_plan),
        );

        assert_eq!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("production_executable")
        );
        assert_ne!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("validated")
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_runtime_contract_allows_pgbb_scalar_readbacks_without_losing_device_residency() {
        let mut plan = tiny_fem_plan();
        plan.mfem_device_string = Some("cuda".to_string());
        plan.enable_demag = false;
        plan.relaxation = Some(relaxation_control(
            RelaxationAlgorithmIR::ProjectedGradientBb,
        ));
        let stats = StepStats {
            hot_loop_host_sync_count: 2,
            hot_loop_compute_host_sync_count: 0,
            hot_loop_control_scalar_host_sync_count: 2,
            hot_loop_exchange_host_sync_count: 0,
            ..StepStats::default()
        };
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 8,
            dof_len: 24,
            stage_count: 4,
            device_bytes: 32768,
            reduction_workspace_bytes: 512,
            source_of_truth: NativeFemDataResidency::DeviceSourceOfTruth,
        };
        let rk_plan = gpu_rk_ready_plan_for_log_test();
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(
            &mut provenance,
            &plan,
            Some(&stats),
            Some(&gpu_state),
            Some(&rk_plan),
        );

        assert_eq!(
            provenance.fem_data_residency.as_deref(),
            Some("device_source_of_truth")
        );
        assert_eq!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("production_executable")
        );
        assert_eq!(provenance.hot_loop_host_sync_count, Some(2));
        assert_eq!(provenance.hot_loop_compute_host_sync_count, Some(0));
        assert_eq!(provenance.hot_loop_control_scalar_host_sync_count, Some(2));
        assert_eq!(provenance.hot_loop_exchange_host_sync_count, Some(0));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_runtime_contract_allows_ncg_scalar_readbacks_without_losing_device_residency() {
        let mut plan = tiny_fem_plan();
        plan.mfem_device_string = Some("cuda".to_string());
        plan.enable_demag = false;
        plan.relaxation = Some(relaxation_control(RelaxationAlgorithmIR::NonlinearCg));
        let stats = StepStats {
            hot_loop_host_sync_count: 3,
            hot_loop_compute_host_sync_count: 0,
            hot_loop_control_scalar_host_sync_count: 3,
            hot_loop_exchange_host_sync_count: 0,
            ..StepStats::default()
        };
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 8,
            dof_len: 24,
            stage_count: 4,
            device_bytes: 32768,
            reduction_workspace_bytes: 512,
            source_of_truth: NativeFemDataResidency::DeviceSourceOfTruth,
        };
        let rk_plan = gpu_rk_ready_plan_for_log_test();
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(
            &mut provenance,
            &plan,
            Some(&stats),
            Some(&gpu_state),
            Some(&rk_plan),
        );

        assert_eq!(
            provenance.fem_data_residency.as_deref(),
            Some("device_source_of_truth")
        );
        assert_eq!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("production_executable")
        );
        assert_eq!(provenance.hot_loop_host_sync_count, Some(3));
        assert_eq!(provenance.hot_loop_compute_host_sync_count, Some(0));
        assert_eq!(provenance.hot_loop_control_scalar_host_sync_count, Some(3));
        assert_eq!(provenance.hot_loop_exchange_host_sync_count, Some(0));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_runtime_contract_allows_llg_scalar_readbacks_without_losing_device_residency() {
        let mut plan = tiny_fem_plan();
        plan.mfem_device_string = Some("cuda".to_string());
        plan.enable_demag = false;
        plan.relaxation = Some(relaxation_control(RelaxationAlgorithmIR::LlgOverdamped));
        let stats = StepStats {
            hot_loop_host_sync_count: 4,
            hot_loop_compute_host_sync_count: 4,
            hot_loop_exchange_host_sync_count: 0,
            ..StepStats::default()
        };
        let gpu_state = NativeFemGpuStateInfo {
            allocated: true,
            node_count: 8,
            dof_len: 24,
            stage_count: 4,
            device_bytes: 32768,
            reduction_workspace_bytes: 512,
            source_of_truth: NativeFemDataResidency::DeviceSourceOfTruth,
        };
        let rk_plan = gpu_rk_ready_plan_for_log_test();
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(
            &mut provenance,
            &plan,
            Some(&stats),
            Some(&gpu_state),
            Some(&rk_plan),
        );

        assert_eq!(
            provenance.fem_data_residency.as_deref(),
            Some("device_source_of_truth")
        );
        assert_eq!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("production_executable")
        );
        assert_eq!(provenance.hot_loop_host_sync_count, Some(4));
        assert_eq!(provenance.hot_loop_compute_host_sync_count, Some(4));
        assert_eq!(provenance.hot_loop_exchange_host_sync_count, Some(0));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_runtime_contract_records_gpu_rk_plan_info() {
        let mut plan = tiny_fem_plan();
        plan.mfem_device_string = Some("cuda".to_string());
        let rk_plan = NativeFemGpuRkPlanInfo {
            exchange_only_enabled: false,
            stage_count: 2,
            uses_cuda_kernels: false,
            allows_exchange_host_sync: false,
            stage_exchange_device_resident: false,
            uses_gpu_poisson: false,
            exchange_operator_mode: "unsupported".to_string(),
            demag_operator_mode: "unsupported".to_string(),
            hypre_execution_policy: "unavailable".to_string(),
            demag_residency: "unavailable".to_string(),
            reason: "GPU RK device-resident path requires CUDA runtime support".to_string(),
        };
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(&mut provenance, &plan, None, None, Some(&rk_plan));

        assert_eq!(provenance.fem_gpu_rk_exchange_only_enabled, Some(false));
        assert_eq!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("source_visible")
        );
        assert_eq!(provenance.fem_gpu_rk_stage_count, Some(2));
        assert_eq!(provenance.fem_gpu_rk_uses_cuda_kernels, Some(false));
        assert_eq!(provenance.fem_gpu_rk_allows_exchange_host_sync, Some(false));
        assert_eq!(
            provenance.fem_gpu_rk_stage_exchange_device_resident,
            Some(false)
        );
        assert_eq!(
            provenance.fem_exchange_operator_mode.as_deref(),
            Some("unsupported")
        );
        assert_eq!(
            provenance.fem_demag_operator_mode.as_deref(),
            Some("unsupported")
        );
        assert_eq!(
            provenance.hypre_execution_policy.as_deref(),
            Some("unavailable")
        );
        assert_eq!(provenance.demag_residency.as_deref(), Some("unavailable"));
        assert_eq!(
            provenance.fem_gpu_rk_block_reason.as_deref(),
            Some("GPU RK device-resident path requires CUDA runtime support")
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn gpu_engine_rejects_stt_only_disabled_gpu_rk_plan() {
        let rk_plan = NativeFemGpuRkPlanInfo {
            exchange_only_enabled: false,
            stage_count: 2,
            uses_cuda_kernels: false,
            allows_exchange_host_sync: false,
            stage_exchange_device_resident: false,
            uses_gpu_poisson: false,
            exchange_operator_mode: "unsupported".to_string(),
            demag_operator_mode: "none".to_string(),
            hypre_execution_policy: "none".to_string(),
            demag_residency: "none".to_string(),
            reason: "GPU RK device-resident path requires enable_exchange=true".to_string(),
        };

        let err = validate_native_fem_gpu_engine_runtime_contract(FemEngine::NativeGpu, &rk_plan)
            .expect_err("STT-only GPU plan must not execute through host RK");

        assert!(err.message.contains("gpu_rk_plan_disabled"));
        assert!(err.message.contains("enable_exchange=true"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn gpu_engine_rejects_oersted_only_disabled_gpu_rk_plan() {
        let rk_plan = NativeFemGpuRkPlanInfo {
            exchange_only_enabled: false,
            stage_count: 4,
            uses_cuda_kernels: false,
            allows_exchange_host_sync: false,
            stage_exchange_device_resident: false,
            uses_gpu_poisson: false,
            exchange_operator_mode: "unsupported".to_string(),
            demag_operator_mode: "none".to_string(),
            hypre_execution_policy: "none".to_string(),
            demag_residency: "none".to_string(),
            reason: "GPU RK device-resident path requires enable_exchange=true".to_string(),
        };

        let err = validate_native_fem_gpu_engine_runtime_contract(FemEngine::NativeGpu, &rk_plan)
            .expect_err("Oersted-only GPU plan must not execute through host RK");

        assert!(err.message.contains("gpu_rk_plan_disabled"));
        assert!(err.message.contains("enable_exchange=true"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_runtime_contract_treats_cpu_mfem_variants_as_unsupported() {
        let mut plan = tiny_fem_plan();
        plan.enable_demag = true;
        plan.mfem_device_string = Some("ceed-cpu".to_string());
        let mut provenance = ExecutionProvenance::default();

        apply_native_fem_runtime_contract(&mut provenance, &plan, None, None, None);

        assert_eq!(provenance.fem_execution_mode.as_deref(), Some("cpu_native"));
        assert_eq!(
            provenance.fem_gpu_qualification_status.as_deref(),
            Some("unsupported")
        );
        assert_eq!(provenance.uses_cuda_kernels, Some(false));
        assert_eq!(provenance.uses_gpu_poisson, Some(false));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn all_in_gpu_request_rejects_hybrid_native_fem_runtime_contract() {
        let _guard = env_lock().lock().expect("env mutex");
        unsafe {
            std::env::set_var("FULLMAG_FEM_ALL_IN_GPU", "1");
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        let rk_plan = NativeFemGpuRkPlanInfo {
            exchange_only_enabled: false,
            stage_count: 2,
            uses_cuda_kernels: true,
            allows_exchange_host_sync: true,
            stage_exchange_device_resident: false,
            uses_gpu_poisson: false,
            exchange_operator_mode: "unsupported".to_string(),
            demag_operator_mode: "hybrid_cpu_poisson".to_string(),
            hypre_execution_policy: "host".to_string(),
            demag_residency: "host_device_roundtrip".to_string(),
            reason: "stage H_ex is not device-resident".to_string(),
        };

        let err = validate_all_in_gpu_fem_runtime_contract("hybrid_legacy_sparse", &rk_plan)
            .expect_err("ALL_IN_GPU must reject hybrid native FEM runtime");

        unsafe {
            std::env::remove_var("FULLMAG_FEM_ALL_IN_GPU");
        }
        assert!(err.message.contains("all_in_gpu_contract_unmet"));
        assert!(err.message.contains("stage_exchange_device_resident=false"));
        assert!(err
            .message
            .contains("gpu_rk_block_reason=stage H_ex is not device-resident"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn all_in_gpu_request_rejects_unsupported_exchange_operator_mode() {
        let _guard = env_lock().lock().expect("env mutex");
        unsafe {
            std::env::set_var("FULLMAG_FEM_ALL_IN_GPU", "1");
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        let rk_plan = NativeFemGpuRkPlanInfo {
            exchange_only_enabled: true,
            stage_count: 2,
            uses_cuda_kernels: true,
            allows_exchange_host_sync: false,
            stage_exchange_device_resident: true,
            uses_gpu_poisson: true,
            exchange_operator_mode: "unsupported".to_string(),
            demag_operator_mode: "device_hypre_poisson".to_string(),
            hypre_execution_policy: "device".to_string(),
            demag_residency: "device".to_string(),
            reason: String::new(),
        };

        let err = validate_all_in_gpu_fem_runtime_contract("all_in_gpu_legacy_sparse", &rk_plan)
            .expect_err("ALL_IN_GPU must reject unsupported exchange operator mode");

        unsafe {
            std::env::remove_var("FULLMAG_FEM_ALL_IN_GPU");
        }
        assert!(err.message.contains("all_in_gpu_contract_unmet"));
        assert!(err
            .message
            .contains("fem_exchange_operator_mode=unsupported"));
        assert!(err.message.contains("gpu_rk_block_reason=none"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn all_in_gpu_request_rejects_missing_device_poisson() {
        let _guard = env_lock().lock().expect("env mutex");
        unsafe {
            std::env::set_var("FULLMAG_FEM_ALL_IN_GPU", "1");
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        let rk_plan = NativeFemGpuRkPlanInfo {
            exchange_only_enabled: true,
            stage_count: 2,
            uses_cuda_kernels: true,
            allows_exchange_host_sync: false,
            stage_exchange_device_resident: true,
            uses_gpu_poisson: false,
            exchange_operator_mode: "legacy_sparse_gpu".to_string(),
            demag_operator_mode: "hybrid_cpu_poisson".to_string(),
            hypre_execution_policy: "host".to_string(),
            demag_residency: "host_device_roundtrip".to_string(),
            reason: String::new(),
        };

        let err = validate_all_in_gpu_fem_runtime_contract("all_in_gpu_legacy_sparse", &rk_plan)
            .expect_err("ALL_IN_GPU must reject non-device Poisson demag");

        unsafe {
            std::env::remove_var("FULLMAG_FEM_ALL_IN_GPU");
        }
        assert!(err.message.contains("uses_gpu_poisson=false"));
        assert!(err
            .message
            .contains("fem_demag_operator_mode=hybrid_cpu_poisson"));
        assert!(err.message.contains("hypre_execution_policy=host"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn all_in_gpu_execution_value_forces_gpu_policy() {
        let _guard = env_lock().lock().expect("env mutex");
        let problem = fem_policy_problem();
        unsafe {
            std::env::set_var("FULLMAG_FEM_EXECUTION", "all_in_gpu");
            std::env::set_var("FULLMAG_FEM_GPU_INDEX", "99999");
            std::env::remove_var("FULLMAG_CUDA_DEVICE_INDEX");
        }
        let result = resolve_fem_engine(&problem);
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
            std::env::remove_var("FULLMAG_FEM_GPU_INDEX");
        }
        let err = result.expect_err("all_in_gpu should force native GPU availability");
        assert!(err
            .message
            .contains("native FEM GPU backend is not available"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn all_in_gpu_env_flag_forces_gpu_policy_without_execution_override() {
        let _guard = env_lock().lock().expect("env mutex");
        let problem = fem_policy_problem();
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
            std::env::set_var("FULLMAG_FEM_ALL_IN_GPU", "1");
            std::env::set_var("FULLMAG_FEM_GPU_INDEX", "99999");
            std::env::remove_var("FULLMAG_CUDA_DEVICE_INDEX");
        }
        let result = resolve_fem_engine(&problem);
        unsafe {
            std::env::remove_var("FULLMAG_FEM_ALL_IN_GPU");
            std::env::remove_var("FULLMAG_FEM_GPU_INDEX");
        }
        let err = result.expect_err("FULLMAG_FEM_ALL_IN_GPU should force native GPU availability");
        assert!(err
            .message
            .contains("native FEM GPU backend is not available"));
    }

    #[test]
    fn all_in_gpu_env_flag_forces_gpu_registry_resolution_without_execution_override() {
        let _guard = env_lock().lock().expect("env mutex");
        let mut problem = fem_policy_problem();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            Value::Object(
                [
                    ("device".to_string(), Value::String("cpu".to_string())),
                    ("precision".to_string(), Value::String("double".to_string())),
                ]
                .into_iter()
                .collect(),
            ),
        );

        let temp = TempDirGuard::new();
        let cpu_pack = temp.path.join("runtimes").join("fem-cpu");
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
        let registry = RuntimeRegistry::discover(&temp.path.join("runtimes"));

        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
            std::env::set_var("FULLMAG_FEM_ALL_IN_GPU", "1");
        }
        let fem_plan = tiny_fem_plan();
        let result =
            resolve_fem_engine_with_registry(&problem, &registry, false, Some(&fem_plan), false);
        unsafe {
            std::env::remove_var("FULLMAG_FEM_ALL_IN_GPU");
        }

        let err = result.expect_err("FULLMAG_FEM_ALL_IN_GPU must not resolve CPU via registry");
        assert!(
            err.message
                .contains("no advertised FEM runtime matches device=gpu"),
            "{}",
            err.message
        );
    }

    #[test]
    fn forced_fem_gpu_without_backend_surfaces_reason() {
        let problem = fem_policy_problem();
        let result = resolve_fem_engine_with_availability(
            &problem,
            "gpu",
            true,
            1,
            &native_fem_availability_for_test(
                true,
                false,
                "native FEM GPU backend is unavailable without fem-gpu in this test",
            ),
        );
        let err = result.expect_err("missing fem-gpu backend should be surfaced");
        assert!(err
            .message
            .contains("native FEM GPU backend is not available"));
        assert!(err.message.contains("reason") || err.message.contains("without"));
    }

    #[test]
    fn strict_problem_gpu_request_cannot_be_overridden_to_cpu() {
        let mut problem = fem_policy_problem();
        problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

        let resolution = resolve_fem_engine_with_availability(
            &problem,
            "cpu",
            true,
            1,
            &native_fem_availability_for_test(
                true,
                true,
                "native FEM CPU and GPU backends are available",
            ),
        )
        .expect("strict requested GPU must remain on GPU independent of env override");

        assert_eq!(resolution.engine, FemEngine::NativeGpu);
        assert!(resolution.fallback.is_none());
    }

    #[test]
    fn strict_problem_gpu_request_cannot_be_overridden_in_runtime_registry_lookup() {
        let _guard = env_lock().lock().expect("env mutex");
        let mut problem = fem_policy_problem();
        problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;
        unsafe {
            std::env::set_var("FULLMAG_FEM_EXECUTION", "cpu");
        }

        let requested = requested_registry_device_for_fem(&problem);

        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        assert_eq!(requested, "gpu");
    }

    #[test]
    fn strict_problem_gpu_request_rejects_cpu_only_runtime_registry() {
        let _guard = env_lock().lock().expect("env mutex");
        let mut problem = fem_policy_problem();
        problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;
        let temp = TempDirGuard::new();
        let cpu_pack = temp.path.join("runtimes").join("fem-cpu");
        fs::create_dir_all(cpu_pack.join("bin")).expect("create fem cpu runtime");
        fs::write(cpu_pack.join("bin").join("fullmag-fem-cpu-bin"), b"stub")
            .expect("write fem cpu worker");
        fs::write(
            cpu_pack.join("manifest.json"),
            r#"{
                "family": "fem-cpu",
                "version": "0.1.0",
                "worker": "bin/fullmag-fem-cpu-bin",
                "engines": [{"backend":"fem","device":"cpu","precision":"double"}]
            }"#,
        )
        .expect("write fem cpu manifest");
        let registry = RuntimeRegistry::discover(&temp.path.join("runtimes"));
        unsafe {
            std::env::set_var("FULLMAG_FEM_EXECUTION", "cpu");
        }

        let result = resolve_fem_engine_with_registry(
            &problem,
            &registry,
            false,
            Some(&tiny_fem_plan()),
            false,
        );

        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        let err = result.expect_err("strict GPU must reject a CPU-only registry");
        assert!(err
            .message
            .contains("no advertised FEM runtime matches device=gpu"));
    }

    #[test]
    fn strict_problem_gpu_request_fails_when_gpu_is_unavailable() {
        let mut problem = fem_policy_problem();
        problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Strict;

        let err = resolve_fem_engine_with_availability(
            &problem,
            "gpu",
            false,
            1,
            &native_fem_availability_for_test(
                true,
                false,
                "native FEM GPU backend is unavailable in this test",
            ),
        )
        .expect_err("strict requested GPU must fail closed instead of selecting CPU");

        assert!(err
            .message
            .contains("native FEM GPU backend is not available"));
        assert!(err.message.contains("strict"));
    }

    #[test]
    fn requested_fem_gpu_without_backend_records_fallback_trail() {
        let mut problem = fem_policy_problem();
        problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
        let resolution = resolve_fem_engine_with_availability(
            &problem,
            "auto",
            false,
            1,
            &native_fem_availability_for_test(
                true,
                false,
                "native FEM GPU backend is unavailable in this test",
            ),
        )
        .expect("auto should use the available CPU lane");
        assert_eq!(resolution.engine, FemEngine::CpuNative);
        let fallback = resolution.fallback.expect("fallback should be present");
        assert!(fallback.occurred);
        assert_eq!(fallback.original_engine, "fem_native_gpu");
        assert_eq!(fallback.fallback_engine, "fem_cpu_native");
        assert_eq!(fallback.reason, "native_fem_gpu_unavailable");
    }

    fn native_fem_availability_for_test(
        cpu: bool,
        gpu: bool,
        reason: &str,
    ) -> native_fem::GpuAvailability {
        native_fem::GpuAvailability {
            available: cpu || gpu,
            available_any: cpu || gpu,
            available_cpu: cpu,
            available_gpu: gpu,
            built_with_mfem_stack: cpu || gpu,
            built_with_cuda_runtime: gpu,
            built_with_ceed: false,
            native_fem_cpu_available: cpu,
            native_fem_gpu_available: gpu,
            native_fem_gpu_full_demag_available: gpu,
            mfem_cuda_available: gpu,
            hypre_gpu_available: gpu,
            libceed_used_hot_path: false,
            visible_cuda_device_count: if gpu { 1 } else { 0 },
            requested_gpu_index: -1,
            resolved_gpu_index: if gpu { 0 } else { -1 },
            memory_free_bytes: if gpu { 8_000_000_000 } else { 0 },
            memory_total_bytes: if gpu { 12_000_000_000 } else { 0 },
            reason: reason.to_string(),
            reason_cpu: if cpu {
                "native FEM CPU backend is available".to_string()
            } else {
                reason.to_string()
            },
            reason_gpu: if gpu {
                "native FEM GPU backend is available".to_string()
            } else {
                reason.to_string()
            },
        }
    }

    #[test]
    fn planned_mixed_gpu_engine_uses_bound_device_after_environment_changes_to_cpu() {
        let _guard = env_lock().lock().expect("env mutex");
        let problem = fem_policy_problem();
        let mut plan = tiny_fem_plan();
        plan.mesh_build_report = Some(
            serde_json::from_value(serde_json::json!({
                "build_mode": "shared_domain",
                "mixed_topology_provenance": {
                    "requested_topology": "mixed_p1",
                    "resolved_topology": "mixed_p1",
                    "accepted_certificate_fingerprint": "sha256:bound",
                    "requested_device": "gpu",
                    "precision": "double",
                    "capability_status": "implemented"
                }
            }))
            .expect("minimal mixed topology build report must deserialize"),
        );

        unsafe {
            std::env::set_var("FULLMAG_FEM_EXECUTION", "cpu");
        }
        let requested_device = effective_fem_device_request_for_plan(&problem, &plan);
        let resolution = resolve_fem_engine_with_availability(
            &problem,
            &requested_device,
            false,
            1,
            &native_fem_availability_for_test(true, true, "test CPU/GPU availability"),
        );
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }

        assert_eq!(requested_device, "gpu");
        assert_eq!(
            resolution
                .expect("bound GPU plan must resolve with an available GPU lane")
                .engine,
            FemEngine::NativeGpu,
        );
    }

    #[test]
    fn managed_cpu_request_is_not_replaced_by_script_auto_without_environment_override() {
        let _guard = env_lock().lock().expect("env mutex");
        let mut problem = fem_policy_problem();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            serde_json::json!({"device": "auto"}),
        );
        problem.problem_meta.runtime_metadata.insert(
            "runtime_device_override".to_string(),
            serde_json::json!({"device": "cpu", "source": "managed_launcher"}),
        );
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
            std::env::remove_var("FULLMAG_FEM_ALL_IN_GPU");
        }

        let requested = effective_fem_device_request(&problem);
        let (policy, env_override) = effective_fem_execution_policy(&problem, &requested);

        assert_eq!(requested, "cpu");
        assert_eq!(policy, "cpu");
        assert!(!env_override);
    }

    #[test]
    fn cpu_availability_policy_uses_cpu_probe_without_gpu() {
        let mut problem = fem_policy_problem();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            Value::Object(
                [("device".to_string(), Value::String("cpu".to_string()))]
                    .into_iter()
                    .collect(),
            ),
        );
        let resolution = resolve_fem_engine_with_availability(
            &problem,
            "cpu",
            false,
            1,
            &native_fem_availability_for_test(
                true,
                false,
                "native FEM CPU backend is available; GPU backend is unavailable",
            ),
        )
        .expect("CPU FEM should resolve when CPU is available without GPU");

        assert_eq!(resolution.engine, FemEngine::CpuNative);
        assert!(resolution.fallback.is_none());
    }

    #[test]
    fn cpu_availability_gpu_fallback_requires_cpu_probe() {
        let mut problem = fem_policy_problem();
        problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
        let err = resolve_fem_engine_with_availability(
            &problem,
            "gpu",
            false,
            1,
            &native_fem_availability_for_test(
                false,
                false,
                "native FEM runtime stack is unavailable",
            ),
        )
        .expect_err("explicit GPU must fail without a GPU runtime");

        assert!(err.message.contains("GPU"));
        assert!(err.message.contains("not available"));
    }

    #[test]
    fn cpu_availability_auto_without_any_native_runtime_fails() {
        let mut problem = fem_policy_problem();
        problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
        let err = resolve_fem_engine_with_availability(
            &problem,
            "auto",
            false,
            1,
            &native_fem_availability_for_test(
                false,
                false,
                "native FEM runtime stack is unavailable",
            ),
        )
        .expect_err("auto must fail when neither native FEM lane is available");

        assert!(err
            .message
            .contains("native FEM CPU backend is not available"));
    }

    #[cfg(not(feature = "fem-gpu"))]
    #[test]
    fn time_domain_fem_without_mfem_backend_fails_early() {
        let err =
            resolve_fem_engine_for_plan_with_trail(&fem_policy_problem(), &tiny_fem_plan(), false)
                .expect_err("time-domain FEM should fail before execution without MFEM support");
        assert!(err.message.contains("MFEM/libCEED runtime stack"));
        assert!(err.message.contains("managed FEM runtime") || err.message.contains("fem-gpu"));
    }

    #[test]
    fn fem_time_domain_and_eigen_ids_are_explicit() {
        assert_eq!(fem_engine_id(FemEngine::CpuNative), "fem_cpu_native");
        assert_eq!(fem_engine_id(FemEngine::NativeGpu), "fem_native_gpu");
        assert_eq!(
            fem_eigen_engine_id(FemEngine::CpuNative),
            "fem_eigen_cpu_baseline"
        );
        assert_eq!(
            fem_eigen_engine_id(FemEngine::NativeGpu),
            "fem_eigen_native_gpu"
        );
    }

    #[test]
    fn forced_gpu_modal_dispersion_path_fails_before_gpu_backend() {
        let plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0e6, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        }));

        let err = execute_fem_eigen(FemEngine::NativeGpu, &plan, &[])
            .expect_err("GPU modal k-path dispersion must fail explicitly");

        assert!(err.message.contains("GPU modal dispersion"));
        assert!(err.message.contains("KSamplingIR::Path"));
        assert!(err.message.contains("unavailable"));
    }

    #[test]
    fn forced_gpu_k0_kittel_with_demag_fails_without_cpu_fallback() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("H20mT".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("H100mT".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        }));
        plan.count = 1;
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.02,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 0,
                    bias_field: [20e-3 / fullmag_engine::MU0, 0.0, 0.0],
                },
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 1,
                    bias_field: [100e-3 / fullmag_engine::MU0, 0.0, 0.0],
                },
            ],
        });

        let err = execute_fem_eigen(FemEngine::NativeGpu, &plan, &[])
            .expect_err("GPU K0 Kittel with demag must remain gated");

        assert!(err.message.contains("GPU modal"));
        assert!(err.message.contains("demag"));
        assert!(err.message.contains("CPU fallback"));
        assert!(err.message.contains("disabled"));
    }

    #[test]
    fn forced_gpu_k0_kittel_path_reaches_single_k_gpu_solver() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("H20mT".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("H100mT".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }));
        plan.count = 1;
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = false;
        plan.enable_demag = false;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: None,
            demag_kind: None,
            model: "macrospin_larmor".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: None,
            },
            samples: vec![
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 0,
                    bias_field: [20e-3 / fullmag_engine::MU0, 0.0, 0.0],
                },
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 1,
                    bias_field: [50e-3 / fullmag_engine::MU0, 0.0, 0.0],
                },
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 2,
                    bias_field: [100e-3 / fullmag_engine::MU0, 0.0, 0.0],
                },
            ],
        });

        let result = execute_fem_eigen(
            FemEngine::NativeGpu,
            &plan,
            &[OutputIR::DispersionCurve {
                name: "dispersion".to_string(),
            }],
        );

        if let Err(err) = result {
            assert!(
                !err.message.contains("KSamplingIR::Path"),
                "K0 Kittel GPU path must reach the single-k GPU solver, got: {}",
                err.message
            );
        }
    }

    #[test]
    fn k_path_public_mode_indices_follow_requested_dispersion_outputs() {
        let no_dispersion = vec![OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        }];
        assert!(eigen_path_public_mode_indices(&no_dispersion, 2).is_empty());

        let dispersion_only = vec![OutputIR::DispersionCurve {
            name: "dispersion".to_string(),
        }];
        assert_eq!(
            eigen_path_public_mode_indices(&dispersion_only, 2),
            std::collections::BTreeSet::from([0, 1]),
        );

        let explicit_mode_subset = vec![
            OutputIR::DispersionCurve {
                name: "dispersion".to_string(),
            },
            OutputIR::EigenMode {
                field: "mode".to_string(),
                indices: vec![1],
            },
        ];
        assert_eq!(
            eigen_path_public_mode_indices(&explicit_mode_subset, 3),
            std::collections::BTreeSet::from([1]),
        );
    }

    #[test]
    fn k_path_dispersion_linewidth_maps_positive_imaginary_frequency_to_fwhm() {
        assert_eq!(
            eigen_path_line_width_hz(2.5e6).as_deref(),
            Some("5.0000000000000000e6")
        );
        assert_eq!(eigen_path_line_width_hz(0.0), None);
        assert_eq!(eigen_path_line_width_hz(-1.0), None);
        assert_eq!(eigen_path_line_width_hz(f64::NAN), None);
    }

    #[cfg(not(feature = "fem-gpu"))]
    #[test]
    fn k_path_gamma_frequency_window_uses_native_modal_entrypoint_without_feature() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("G2".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 1.0e13,
        };
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;

        let err = execute_fem_eigen(
            FemEngine::CpuNative,
            &plan,
            &[OutputIR::EigenSpectrum {
                quantity: "frequency_hz".to_string(),
            }],
        )
        .expect_err("eligible gamma k-path sample must route through native modal entrypoint");

        assert!(
            err.message
                .contains("native FEM modal eigen solve requires the fem-gpu feature"),
            "{}",
            err.message,
        );
    }

    #[test]
    fn k_path_single_sample_model_preserves_production_shift_invert_provenance() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [0.0, 0.0, 0.0],
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: "eigen/metadata/eigen_summary.json".to_string(),
            bytes: br#"{
                "solver_kind": "slepc_multi_shift_invert_production_cpu_dense",
                "solver_diagnostics": {
                    "execution_lane": "production_cpu",
                    "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
                    "spectral_transform": "shift_invert",
                    "production_solver_available": true
                }
            }"#
            .to_vec(),
        }];

        let model = eigen_path_single_k_solver_model(&plan, &artifacts);

        assert_eq!(
            model,
            EigenSolverModel::ProductionCpuShiftInvert,
            "k-path aggregation must preserve production per-sample provenance"
        );
    }

    #[test]
    fn k_path_single_sample_model_requires_bloch_payload_for_floquet_production() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: "eigen/metadata/eigen_summary.json".to_string(),
            bytes: br#"{
                "solver_kind": "slepc_multi_shift_invert_production_cpu_dense",
                "solver_diagnostics": {
                    "execution_lane": "production_cpu",
                    "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
                    "spectral_transform": "shift_invert",
                    "production_solver_available": true
                }
            }"#
            .to_vec(),
        }];

        let model = eigen_path_single_k_solver_model(&plan, &artifacts);

        assert_eq!(
            model,
            EigenSolverModel::ReferenceFull2x2Tangent,
            "Floquet production classification requires a labelled Bloch/Floquet operator payload"
        );
    }

    #[test]
    fn k_path_single_sample_model_accepts_bloch_payload_for_floquet_production() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: "eigen/metadata/eigen_summary.json".to_string(),
            bytes: br#"{
                "solver_kind": "slepc_multi_shift_invert_production_cpu_dense",
                "solver_diagnostics": {
                    "execution_lane": "production_cpu",
                    "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
                    "spectral_transform": "shift_invert",
                    "production_solver_available": true,
                    "modal_periodic_pair_contract_available": true,
                    "floquet_periodic_pair_count": 1,
                    "operator_diagnostics": {
                        "payload_kind": "bloch_floquet_tangent_operator"
                    }
                }
            }"#
            .to_vec(),
        }];

        let model = eigen_path_single_k_solver_model(&plan, &artifacts);

        assert_eq!(
            model,
            EigenSolverModel::ProductionCpuShiftInvert,
            "labelled Bloch/Floquet operator payload should preserve production k-path provenance"
        );
    }

    #[test]
    fn k_path_single_sample_model_requires_periodic_pair_contract_for_floquet_production() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: "eigen/metadata/eigen_summary.json".to_string(),
            bytes: br#"{
                "solver_kind": "slepc_multi_shift_invert_production_cpu_dense",
                "solver_diagnostics": {
                    "execution_lane": "production_cpu",
                    "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
                    "spectral_transform": "shift_invert",
                    "production_solver_available": true,
                    "operator_diagnostics": {
                        "payload_kind": "bloch_floquet_tangent_operator"
                    }
                }
            }"#
            .to_vec(),
        }];

        let model = eigen_path_single_k_solver_model(&plan, &artifacts);

        assert_eq!(
            model,
            EigenSolverModel::ReferenceFull2x2Tangent,
            "Floquet production classification requires periodic-pair contract diagnostics"
        );
    }

    #[test]
    fn k_path_single_sample_model_rejects_demag_payload_for_no_demag_floquet_production() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = false;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: "eigen/metadata/eigen_summary.json".to_string(),
            bytes: br#"{
                "solver_kind": "slepc_multi_shift_invert_production_cpu_dense",
                "solver_diagnostics": {
                    "execution_lane": "production_cpu",
                    "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
                    "spectral_transform": "shift_invert",
                    "production_solver_available": true,
                    "modal_periodic_pair_contract_available": true,
                    "floquet_periodic_pair_count": 1,
                    "operator_diagnostics": {
                        "payload_kind": "bloch_floquet_tangent_operator",
                        "demag_payload_kind": "dynamic_demag_k_operator"
                    }
                }
            }"#
            .to_vec(),
        }];

        let model = eigen_path_single_k_solver_model(&plan, &artifacts);

        assert_eq!(
            model,
            EigenSolverModel::ReferenceFull2x2Tangent,
            "current no-demag Floquet production classification must not accept dynamic demag-k payload claims"
        );
    }

    #[test]
    fn k_path_single_sample_model_rejects_gated_operator_terms_for_no_demag_floquet_production() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Single {
            k_vector: [1.0e6, 0.0, 0.0],
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = false;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: "eigen/metadata/eigen_summary.json".to_string(),
            bytes: br#"{
                "solver_kind": "slepc_multi_shift_invert_production_cpu_dense",
                "solver_diagnostics": {
                    "execution_lane": "production_cpu",
                    "solver_model": "slepc_multi_shift_invert_production_cpu_dense",
                    "spectral_transform": "shift_invert",
                    "production_solver_available": true,
                    "modal_periodic_pair_contract_available": true,
                    "floquet_periodic_pair_count": 1,
                    "operator_diagnostics": {
                        "payload_kind": "bloch_floquet_tangent_operator",
                        "operator_terms_included": ["exchange", "dynamic_demag"]
                    }
                }
            }"#
            .to_vec(),
        }];

        let model = eigen_path_single_k_solver_model(&plan, &artifacts);

        assert_eq!(
            model,
            EigenSolverModel::ReferenceFull2x2Tangent,
            "current no-demag Floquet production classification must not accept gated operator terms"
        );
    }

    #[test]
    fn k_path_solver_diagnostics_preserve_production_shift_invert_provenance() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0e6, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        }));
        plan.count = 1;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 1.0e13,
        };
        let path_result = crate::eigen::PathSolveResult {
            samples: vec![crate::eigen::SingleKSolveResult {
                sample: crate::eigen::KSampleDescriptor {
                    sample_index: 0,
                    label: Some("G".to_string()),
                    segment_index: Some(0),
                    path_s: 0.0,
                    t_in_segment: 0.0,
                    k_vector: [0.0, 0.0, 0.0],
                },
                modes: vec![crate::eigen::SingleKModeResult {
                    raw_mode_index: 0,
                    branch_id: None,
                    frequency_real_hz: 1.0e9,
                    frequency_imag_hz: 0.0,
                    angular_frequency_rad_per_s: std::f64::consts::TAU * 1.0e9,
                    eigenvalue_real: 0.0,
                    eigenvalue_imag: std::f64::consts::TAU * 1.0e9,
                    norm: 1.0,
                    mass_norm: Some(1.0),
                    max_amplitude: 1.0,
                    residual_norm: Some(1.0e-9),
                    residual_linf: Some(1.0e-10),
                    tangent_leakage_mean_abs: Some(0.0),
                    tangent_leakage_max_abs: Some(0.0),
                    dominant_polarization: "linear".to_string(),
                    reduced_vector: None,
                    lifted_real: None,
                    lifted_imag: None,
                    amplitude: None,
                    phase: None,
                    node_mass_weights: Some(vec![2.0, 3.0]),
                }],
                relaxation_steps: 0,
                solver_model: EigenSolverModel::ProductionCpuShiftInvert,
                solver_notes: vec!["production sample".to_string()],
            }],
            branches: Vec::new(),
            solver_model: EigenSolverModel::ProductionCpuShiftInvert,
            notes: vec!["production k-path".to_string()],
            include_demag: plan.operator.include_demag,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };

        let diagnostics = eigen_path_solver_diagnostics(
            &plan,
            &path_result,
            &std::collections::BTreeSet::from([0]),
        );

        assert_eq!(
            diagnostics["solver_model"],
            "slepc_multi_shift_invert_production_cpu_dense"
        );
        assert_eq!(diagnostics["resolved_solver_family"], "shift_invert");
        assert_eq!(diagnostics["spectral_transform"], "shift_invert");
        assert_eq!(diagnostics["solver_adapter"], "slepc_modal_eigen");
        assert_eq!(diagnostics["execution_lane"], "production_cpu");
        assert_eq!(diagnostics["phasor_convention"], "exp_i_omega_t");
        assert_eq!(diagnostics["production_solver_available"], true);
        assert_eq!(diagnostics["dense_reference_oracle"], false);
        assert!(diagnostics.get("frequency_window_solver_policy").is_none());
        assert!(
            diagnostics.get("production_cpu_rejection_reason").is_none(),
            "{}",
            diagnostics
        );
        assert!(
            diagnostics.get("required_operator_contract").is_none(),
            "{}",
            diagnostics
        );

        let production_mode = eigen_path_mode_json(
            &plan,
            &path_result.samples[0].sample,
            &path_result.samples[0].modes[0],
            path_result.solver_model,
        );
        assert_eq!(production_mode["phasor_convention"], "exp_i_omega_t");
        assert_eq!(production_mode["eigenvalue_mapping"], "lambda_eq_i_omega");
        assert_eq!(
            production_mode["node_mass_weights"],
            serde_json::json!([2.0, 3.0])
        );

        let manifest = build_eigen_path_frequency_domain_manifest(
            FemEngine::CpuNative,
            &path_result,
            &[],
            &plan,
        );
        assert_eq!(manifest["physics"]["phase_convention"], "exp_i_omega_t");
        assert_eq!(
            manifest["resolved_execution"]["reference_or_production"],
            "production"
        );
        assert_eq!(
            manifest["resolved_execution"]["native_backend"],
            "native_cpu"
        );
        assert_eq!(manifest["resolved_execution"]["solver_library"], "slepc");
        assert_eq!(
            manifest["requested_execution"]["solve_equation"],
            "A q = lambda B q; lambda = i omega"
        );
        assert_eq!(
            manifest["capabilities"]["production_native_solver_available"],
            true
        );
        assert_eq!(manifest["capabilities"]["validation_artifact"], false);
        assert_eq!(
            manifest["capabilities"]["dispersion"]["reference_cpu"]["status"],
            "reference_executable"
        );
        assert_eq!(
            manifest["capabilities"]["dispersion"]["production_cpu"]["status"],
            "partial_production_executable"
        );
        assert_eq!(
            manifest["capabilities"]["dispersion"]["production_cpu_gamma_k_path"]["status"],
            "partial_production_executable"
        );
        assert_eq!(
            manifest["capabilities"]["dispersion"]["production_gpu"]["status"],
            "unsupported"
        );
        assert!(
            manifest["capabilities"]["dispersion"]["production_gpu"]["reason"]
                .as_str()
                .is_some_and(|reason| reason.contains("modal GPU"))
        );
    }

    #[test]
    fn k_path_manifest_downgrades_rejected_floquet_demag_shift_invert_claim() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0e6, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 1.0e13,
        };
        let path_result = crate::eigen::PathSolveResult {
            samples: Vec::new(),
            branches: Vec::new(),
            solver_model: EigenSolverModel::ProductionCpuShiftInvert,
            notes: vec!["stale production sample".to_string()],
            include_demag: true,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };

        let manifest = build_eigen_path_frequency_domain_manifest(
            FemEngine::CpuNative,
            &path_result,
            &[],
            &plan,
        );

        assert_eq!(
            manifest["resolved_execution"]["reference_or_production"],
            "reference"
        );
        assert_eq!(
            manifest["resolved_execution"]["native_backend"],
            "runner_validation"
        );
        assert_eq!(
            manifest["capabilities"]["production_native_solver_available"],
            false
        );
        assert_eq!(manifest["requested_execution"]["include_demag"], true);
        assert_eq!(
            manifest["diagnostics"]["production_cpu_rejection_reason"],
            "production_cpu_modal_dynamic_demag_k_operator_missing"
        );
        assert_eq!(
            manifest["diagnostics"]["production_cpu_rejection_scope"],
            "selected_spectrum_nonzero_k_floquet_modal_dynamic_demag"
        );
        assert_eq!(
            manifest["diagnostics"]["required_operator_contract"],
            "bloch_floquet_tangent_operator_with_dynamic_demag_k"
        );
        assert_eq!(
            manifest["diagnostics"]["required_operator_payload_kind"],
            "bloch_floquet_tangent_operator"
        );
        assert_eq!(
            manifest["diagnostics"]["required_demag_payload_kind"],
            "dynamic_demag_k_operator"
        );
        assert_eq!(
            manifest["diagnostics"]["dynamic_demag_operator_source"],
            "missing_numeric_fem_demag_k"
        );
        assert_eq!(
            manifest["diagnostics"]["modal_periodic_pair_contract_available"],
            false
        );
    }

    #[test]
    fn k_path_manifest_names_reference_floquet_demag_rejection_contract() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0e6, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 1.0e13,
        };
        let path_result = crate::eigen::PathSolveResult {
            samples: Vec::new(),
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceFull2x2Tangent,
            notes: vec!["reference fallback".to_string()],
            include_demag: true,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };

        let manifest = build_eigen_path_frequency_domain_manifest(
            FemEngine::CpuNative,
            &path_result,
            &[],
            &plan,
        );

        assert_eq!(
            manifest["resolved_execution"]["reference_or_production"],
            "reference"
        );
        assert_eq!(
            manifest["diagnostics"]["production_cpu_rejection_reason"],
            "production_cpu_modal_dynamic_demag_k_operator_missing"
        );
        assert_eq!(
            manifest["diagnostics"]["production_cpu_rejection_scope"],
            "selected_spectrum_nonzero_k_floquet_modal_dynamic_demag"
        );
        assert_eq!(
            manifest["diagnostics"]["required_operator_contract"],
            "bloch_floquet_tangent_operator_with_dynamic_demag_k"
        );
        assert_eq!(
            manifest["diagnostics"]["required_operator_payload_kind"],
            "bloch_floquet_tangent_operator"
        );
        assert_eq!(
            manifest["diagnostics"]["required_demag_payload_kind"],
            "dynamic_demag_k_operator"
        );
        assert_eq!(
            manifest["diagnostics"]["dynamic_demag_operator_source"],
            "missing_numeric_fem_demag_k"
        );
        assert_eq!(
            manifest["diagnostics"]["modal_periodic_pair_contract_available"],
            false
        );
    }

    #[test]
    fn k_path_solver_diagnostics_preserve_periodic_airbox_k0_adapter() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![fullmag_ir::KPointIR {
                label: Some("G".to_string()),
                k_vector: [0.0, 0.0, 0.0],
            }],
            samples_per_segment: Vec::new(),
            closed: false,
        }));
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });
        let path_result = crate::eigen::PathSolveResult {
            samples: Vec::new(),
            branches: Vec::new(),
            solver_model: EigenSolverModel::ReferenceFull2x2Tangent,
            notes: vec!["periodic-airbox k0 path".to_string()],
            include_demag: true,
            dispersion_validation: None,
            k0_kittel_validation: plan.k0_kittel_validation.clone(),
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: Some(
                crate::eigen::K0KittelPeriodicAirboxDemagMetrics {
                    mesh_resolution_m: 5.0e-9,
                    airbox_size_m: 2.5e-7,
                    phi_dof_count: 28,
                    augmented_phi_dof_count: 45,
                    poisson_constraint_relative_residual: 1.0e-12,
                    magnetic_pair_count: 8,
                    airbox_pair_count: 14,
                    effective_magnetisation_a_per_m: 800_000.0,
                    relative_kittel_frequency_error: 2.0e-3,
                },
            ),
        };

        let diagnostics = eigen_path_solver_diagnostics(&plan, &path_result, &BTreeSet::new());

        assert_eq!(
            diagnostics["solver_adapter"],
            "k0_poisson_airbox_cpu_full_coupled_slepc"
        );
        assert_eq!(diagnostics["execution_lane"], "production_cpu");
        assert_eq!(
            diagnostics["resolved_solver_family"],
            "k0_poisson_airbox_full_coupled"
        );
        assert_eq!(
            diagnostics["solver_model"],
            "k0_poisson_airbox_cpu_full_coupled_slepc"
        );
        assert_eq!(
            diagnostics["solver_family"],
            "k0_poisson_airbox_full_coupled"
        );
        assert_eq!(diagnostics["demag_kind"], "periodic_airbox_k0");
        assert_eq!(diagnostics["gauge_policy"], "mean_zero_augmented");
        assert_eq!(diagnostics["phi_dof_count"], 28);
        assert_eq!(diagnostics["augmented_phi_dof_count"], 45);
        assert_eq!(diagnostics["poisson_constraint_relative_residual"], 1.0e-12);
        assert_eq!(diagnostics["production_solver_available"], true);
        assert_eq!(diagnostics["production_periodic_airbox_claim"], true);
        assert!(
            diagnostics.get("production_cpu_rejection_reason").is_none(),
            "{}",
            diagnostics
        );
    }

    #[test]
    fn k_path_single_k_plan_uses_relaxed_handoff_without_repeating_relaxation() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![fullmag_ir::KPointIR {
                label: Some("G".to_string()),
                k_vector: [0.0, 0.0, 0.0],
            }],
            samples_per_segment: Vec::new(),
            closed: false,
        }));
        plan.equilibrium = fullmag_ir::EquilibriumSourceIR::RelaxedInitialState;
        let sample = crate::eigen::KSampleDescriptor {
            sample_index: 0,
            label: Some("G".to_string()),
            segment_index: Some(0),
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: [0.0, 0.0, 0.0],
        };

        let point_plan = eigen_path_single_k_point_plan(&plan, &sample);

        assert_eq!(
            point_plan.equilibrium,
            fullmag_ir::EquilibriumSourceIR::Provided
        );
        assert_eq!(
            point_plan.k_sampling,
            Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0]
            })
        );
    }

    #[test]
    fn eigen_path_node_mass_weights_from_json_requires_positive_finite_array() {
        let weights = eigen_path_node_mass_weights_from_json(&serde_json::json!([1.0, 2.5, 4.0]))
            .expect("finite positive weights should parse");

        assert_eq!(weights, vec![1.0, 2.5, 4.0]);
        assert!(eigen_path_node_mass_weights_from_json(&serde_json::json!([1.0, 0.0])).is_none());
        assert!(eigen_path_node_mass_weights_from_json(&serde_json::json!([1.0, "bad"])).is_none());
    }

    #[test]
    fn k_path_manifest_and_auxiliary_artifacts_carry_k0_kittel_validation() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("G2".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }));
        plan.count = 1;
        plan.operator.include_demag = false;

        let fields_a_per_m = [40_000.0, 80_000.0, 120_000.0];
        let mut samples = Vec::new();
        let mut branch_points = Vec::new();
        for (sample_index, field_a_per_m) in fields_a_per_m.iter().copied().enumerate() {
            let frequency_hz = 2.211e5 * field_a_per_m / std::f64::consts::TAU;
            samples.push(crate::eigen::SingleKSolveResult {
                sample: crate::eigen::KSampleDescriptor {
                    sample_index,
                    label: Some(format!("H{sample_index}")),
                    segment_index: Some(0),
                    path_s: sample_index as f64,
                    t_in_segment: sample_index as f64 / (fields_a_per_m.len() - 1) as f64,
                    k_vector: [0.0, 0.0, 0.0],
                },
                modes: vec![crate::eigen::SingleKModeResult {
                    raw_mode_index: 0,
                    branch_id: Some(0),
                    frequency_real_hz: frequency_hz,
                    frequency_imag_hz: 0.0,
                    angular_frequency_rad_per_s: std::f64::consts::TAU * frequency_hz,
                    eigenvalue_real: 0.0,
                    eigenvalue_imag: std::f64::consts::TAU * frequency_hz,
                    norm: 1.0,
                    mass_norm: Some(1.0),
                    max_amplitude: 1.0,
                    residual_norm: Some(1.0e-9),
                    residual_linf: Some(1.0e-10),
                    tangent_leakage_mean_abs: Some(0.0),
                    tangent_leakage_max_abs: Some(0.0),
                    dominant_polarization: "linear".to_string(),
                    reduced_vector: None,
                    lifted_real: None,
                    lifted_imag: None,
                    amplitude: None,
                    phase: None,
                    node_mass_weights: None,
                }],
                relaxation_steps: 0,
                solver_model: EigenSolverModel::ProductionCpuShiftInvert,
                solver_notes: vec!["production sample".to_string()],
            });
            branch_points.push(crate::eigen::TrackedBranchPoint {
                sample_index,
                raw_mode_index: 0,
                frequency_real_hz: frequency_hz,
                frequency_imag_hz: 0.0,
                tracking_confidence: 1.0,
                overlap_prev: (sample_index > 0).then_some(1.0),
            });
        }

        let path_result = crate::eigen::PathSolveResult {
            samples,
            branches: vec![crate::eigen::TrackedBranch {
                branch_id: 0,
                label: Some("k0_kittel_uniform_branch".to_string()),
                points: branch_points,
            }],
            solver_model: EigenSolverModel::ProductionCpuShiftInvert,
            notes: vec!["k0 Kittel field sweep".to_string()],
            include_demag: false,
            dispersion_validation: None,
            k0_kittel_validation: Some(fullmag_ir::FemEigenK0KittelValidationIR {
                kind: "k0_kittel_field_sweep".to_string(),
                case_id: None,
                demag_kind: None,
                model: "macrospin_larmor".to_string(),
                field_units: "A_per_m".to_string(),
                relative_tolerance: 0.05,
                material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                    effective_magnetisation: None,
                },
                samples: fields_a_per_m
                    .iter()
                    .copied()
                    .enumerate()
                    .map(|(sample_index, field_a_per_m)| {
                        fullmag_ir::FemEigenK0KittelValidationSampleIR {
                            sample_index: sample_index as u32,
                            bias_field: [field_a_per_m, 0.0, 0.0],
                        }
                    })
                    .collect(),
            }),
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };

        let manifest = build_eigen_path_frequency_domain_manifest(
            FemEngine::CpuNative,
            &path_result,
            &[],
            &plan,
        );
        assert_eq!(
            manifest["validation"]["k0_kittel_validation"]["kind"],
            "k0_kittel_field_sweep"
        );

        let mut auxiliary_artifacts = Vec::new();
        append_eigen_path_k0_kittel_validation_artifacts(&mut auxiliary_artifacts, &path_result)
            .expect("k0 Kittel validation artifacts should be buildable");
        assert!(auxiliary_artifacts
            .iter()
            .any(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/summary.v1.json"));
        assert!(auxiliary_artifacts
            .iter()
            .any(|artifact| artifact.relative_path == "validation/kittel_k0_pbc/points.v1.csv"));
    }

    #[test]
    fn k_path_k0_kittel_sample_external_field_uses_declared_bias_field() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("G2".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }));
        plan.external_field = Some([1.0, 2.0, 3.0]);
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: None,
            demag_kind: None,
            model: "macrospin_larmor".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: None,
            },
            samples: vec![
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 0,
                    bias_field: [40_000.0, 0.0, 0.0],
                },
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 1,
                    bias_field: [80_000.0, 0.0, 0.0],
                },
            ],
        });

        let declared_sample = crate::eigen::KSampleDescriptor {
            sample_index: 1,
            label: Some("H1".to_string()),
            segment_index: Some(0),
            path_s: 1.0,
            t_in_segment: 0.5,
            k_vector: [0.0, 0.0, 0.0],
        };
        assert_eq!(
            eigen_path_k0_kittel_sample_external_field(&plan, &declared_sample),
            Some([80_000.0, 0.0, 0.0])
        );

        let ordinary_sample = crate::eigen::KSampleDescriptor {
            sample_index: 3,
            label: Some("outside-validation".to_string()),
            segment_index: Some(0),
            path_s: 3.0,
            t_in_segment: 1.0,
            k_vector: [0.0, 0.0, 0.0],
        };
        assert_eq!(
            eigen_path_k0_kittel_sample_external_field(&plan, &ordinary_sample),
            None
        );
    }

    #[test]
    fn k_path_periodic_airbox_k0_metrics_require_real_native_solver_artifact() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![fullmag_ir::KPointIR {
                label: Some("H20mT".to_string()),
                k_vector: [0.0, 0.0, 0.0],
            }],
            samples_per_segment: Vec::new(),
            closed: false,
        }));
        plan.hmax = 5.0e-9;
        plan.mesh.nodes = vec![
            [0.0, 0.0, 0.0],
            [10.0e-9, 0.0, 0.0],
            [0.0, 10.0e-9, 0.0],
            [0.0, 0.0, 10.0e-9],
            [0.0, 0.0, 20.0e-9],
            [10.0e-9, 0.0, 20.0e-9],
            [0.0, 10.0e-9, 20.0e-9],
            [0.0, 0.0, 30.0e-9],
        ];
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [4, 5, 6, 7]]);
        plan.mesh.element_markers = vec![1, 0];
        plan.mesh.periodic_node_pairs = vec![
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x".to_string(),
                node_a: 0,
                node_b: 1,
            },
            fullmag_ir::MeshPeriodicNodePairIR {
                pair_id: "x".to_string(),
                node_a: 4,
                node_b: 5,
            },
        ];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 2.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("dirichlet".to_string()),
            robin_beta_mode: None,
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("periodic_airbox_k0".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.05,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });
        let artifacts = vec![AuxiliaryArtifact {
            relative_path: "eigen/diagnostics/solver.v1.json".to_string(),
            bytes: serde_json::to_vec(&serde_json::json!({
                "schema_version": "frequency_domain_modal_result.v1",
                "study_product": "modal_eigen",
                "solver_adapter": "k0_poisson_airbox_cpu_full_coupled_slepc",
                "demag_kind": "periodic_airbox_k0",
                "phi_dof_count": 8,
                "augmented_phi_dof_count": 9,
                "poisson_constraint_relative_residual": 1.0e-12,
                "relative_reference_frequency_error": 2.0e-3,
            }))
            .expect("diagnostics should serialize"),
        }];

        let metrics =
            eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts(&plan, &artifacts)
                .expect("real PA-E2 diagnostics should parse")
                .expect("periodic-airbox metrics should be present");

        assert_eq!(metrics.phi_dof_count, 8);
        assert_eq!(metrics.augmented_phi_dof_count, 9);
        assert_eq!(metrics.magnetic_pair_count, 1);
        assert_eq!(metrics.airbox_pair_count, 1);
        assert_eq!(metrics.mesh_resolution_m, 5.0e-9);
        assert_eq!(metrics.effective_magnetisation_a_per_m, 800_000.0);
        assert_eq!(metrics.poisson_constraint_relative_residual, 1.0e-12);
        assert_eq!(metrics.relative_kittel_frequency_error, 2.0e-3);
    }

    #[test]
    fn k0_kittel_synthetic_demag_factor_single_k_matches_thin_film_formula() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("G2".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }));
        let field_a_per_m = 40_000.0;
        let effective_magnetisation = 800_000.0;
        plan.enable_demag = true;
        plan.operator.include_demag = true;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("synthetic_demag_factor".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.02,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(effective_magnetisation),
            },
            samples: vec![
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 0,
                    bias_field: [field_a_per_m, 0.0, 0.0],
                },
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 1,
                    bias_field: [80_000.0, 0.0, 0.0],
                },
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 2,
                    bias_field: [120_000.0, 0.0, 0.0],
                },
            ],
        });
        let sample = crate::eigen::KSampleDescriptor {
            sample_index: 0,
            label: Some("H0".to_string()),
            segment_index: Some(0),
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: [0.0, 0.0, 0.0],
        };

        assert!(k0_kittel_synthetic_demag_factor_enabled(&plan));
        let solved = solve_k0_kittel_synthetic_demag_factor_single_k(&plan, &sample)
            .expect("K0-3a synthetic demag factor should solve");
        let expected = plan.gyromagnetic_ratio
            * (field_a_per_m * (field_a_per_m + effective_magnetisation)).sqrt()
            / std::f64::consts::TAU;

        assert_eq!(
            solved.solver_model,
            EigenSolverModel::ReferenceK0KittelSyntheticDemagFactor
        );
        assert!((solved.modes[0].frequency_real_hz - expected).abs() <= 1.0e-9);
        assert_eq!(
            solved.modes[0].dominant_polarization,
            "synthetic_demag_factor"
        );
    }

    #[test]
    fn k0_kittel_synthetic_demag_factor_path_bypasses_floquet_dynamic_demag_gate() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("H40kApm".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("H120kApm".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![2],
            closed: false,
        }));
        plan.count = 1;
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e8,
            frequency_max_hz: 25.0e9,
        };
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.k0_kittel_validation = Some(fullmag_ir::FemEigenK0KittelValidationIR {
            kind: "k0_kittel_field_sweep".to_string(),
            case_id: Some("K0-3".to_string()),
            demag_kind: Some("synthetic_demag_factor".to_string()),
            model: "thin_film_in_plane".to_string(),
            field_units: "A_per_m".to_string(),
            relative_tolerance: 0.02,
            material: fullmag_ir::FemEigenK0KittelValidationMaterialIR {
                effective_magnetisation: Some(800_000.0),
            },
            samples: vec![
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 0,
                    bias_field: [40_000.0, 0.0, 0.0],
                },
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 1,
                    bias_field: [80_000.0, 0.0, 0.0],
                },
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 2,
                    bias_field: [120_000.0, 0.0, 0.0],
                },
            ],
        });

        let run = execute_fem_eigen(
            FemEngine::CpuNative,
            &plan,
            &[OutputIR::EigenSpectrum {
                quantity: "frequency_hz".to_string(),
            }],
        )
        .expect("K0-3a synthetic demag factor path should bypass Floquet dynamic-demag guard");

        assert!(run
            .auxiliary_artifacts
            .iter()
            .any(|artifact| artifact.relative_path == "eigen/spectrum.v2.json"));
    }

    #[test]
    fn k_path_solver_diagnostics_name_nonzero_k_production_cpu_rejection() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0e6, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        }));
        plan.count = 1;
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 1.0e13,
        };
        let path_result = crate::eigen::PathSolveResult {
            samples: Vec::new(),
            branches: Vec::new(),
            solver_model: EigenSolverModel::ProductionCpuShiftInvert,
            notes: vec!["slepc_multi_shift_invert_production_cpu_dense".to_string()],
            include_demag: plan.operator.include_demag,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };

        let diagnostics = eigen_path_solver_diagnostics(
            &plan,
            &path_result,
            &std::collections::BTreeSet::from([0]),
        );

        assert_eq!(
            diagnostics["production_cpu_rejection_reason"],
            "production_cpu_modal_nonzero_k_floquet_operator_missing"
        );
        assert_eq!(
            diagnostics["production_cpu_rejection_scope"],
            "selected_spectrum_nonzero_k_floquet_modal"
        );
        assert_eq!(
            diagnostics["required_operator_contract"],
            "bloch_floquet_tangent_operator_with_periodic_pairs"
        );
        assert_eq!(
            diagnostics["required_operator_payload_kind"],
            "bloch_floquet_tangent_operator"
        );
        assert_eq!(diagnostics["modal_periodic_pair_contract_available"], false);
    }

    #[test]
    fn k_path_solver_diagnostics_name_dynamic_demag_k_production_cpu_rejection() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0e6, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        }));
        plan.count = 1;
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 1.0e13,
        };
        let path_result = crate::eigen::PathSolveResult {
            samples: Vec::new(),
            branches: Vec::new(),
            solver_model: EigenSolverModel::ProductionCpuShiftInvert,
            notes: vec!["slepc_multi_shift_invert_production_cpu_dense".to_string()],
            include_demag: plan.operator.include_demag,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };

        let diagnostics = eigen_path_solver_diagnostics(
            &plan,
            &path_result,
            &std::collections::BTreeSet::from([0]),
        );

        assert_eq!(
            diagnostics["production_cpu_rejection_reason"],
            "production_cpu_modal_dynamic_demag_k_operator_missing"
        );
        assert_eq!(
            diagnostics["production_cpu_rejection_scope"],
            "selected_spectrum_nonzero_k_floquet_modal_dynamic_demag"
        );
        assert_eq!(
            diagnostics["required_operator_contract"],
            "bloch_floquet_tangent_operator_with_dynamic_demag_k"
        );
        assert_eq!(
            diagnostics["required_operator_payload_kind"],
            "bloch_floquet_tangent_operator"
        );
        assert_eq!(
            diagnostics["required_demag_payload_kind"],
            "dynamic_demag_k_operator"
        );
        assert_eq!(
            diagnostics["dynamic_demag_operator_source"],
            "missing_numeric_fem_demag_k"
        );
        assert_eq!(diagnostics["modal_periodic_pair_contract_available"], false);
    }

    #[test]
    fn k_path_solver_diagnostics_accept_nonzero_floquet_pair_payload_contract() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("X".to_string()),
                    k_vector: [1.0e6, 0.0, 0.0],
                },
            ],
            samples_per_segment: vec![1],
            closed: false,
        }));
        plan.count = 1;
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = false;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: Some("x_faces".to_string()),
                pair_ids: Vec::new(),
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 10,
            marker_b: 11,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }];
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0,
            frequency_max_hz: 1.0e13,
        };
        let path_result = crate::eigen::PathSolveResult {
            samples: Vec::new(),
            branches: Vec::new(),
            solver_model: EigenSolverModel::ProductionCpuShiftInvert,
            notes: vec!["slepc_multi_shift_invert_production_cpu_dense".to_string()],
            include_demag: plan.operator.include_demag,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };

        let diagnostics = eigen_path_solver_diagnostics(
            &plan,
            &path_result,
            &std::collections::BTreeSet::from([0]),
        );

        assert!(
            diagnostics.get("production_cpu_rejection_reason").is_none(),
            "{}",
            diagnostics
        );
        assert!(
            diagnostics.get("required_operator_contract").is_none(),
            "{}",
            diagnostics
        );
        assert_eq!(diagnostics["production_solver_available"], true);
        assert_eq!(
            diagnostics["operator_diagnostics"]["payload_kind"],
            "bloch_floquet_tangent_operator"
        );
        assert_eq!(diagnostics["modal_periodic_pair_contract_available"], true);
        assert_eq!(diagnostics["floquet_periodic_pair_count"], 1);
        assert_eq!(
            diagnostics["periodic_mesh_certificate"]["schema_version"],
            "periodic_mesh_certificate.v5"
        );
        assert_eq!(
            diagnostics["periodic_mesh_certificate"]["certificate_status"],
            "accepted"
        );
        assert_eq!(
            diagnostics["periodic_mesh_certificate"]["magnetic_pair_count"],
            1
        );
        assert!(
            diagnostics["periodic_mesh_certificate"]["magnetic_pair_map_sha256"]
                .as_str()
                .is_some_and(|value| {
                    value.starts_with("sha256:") && value.len() == "sha256:".len() + 64
                }),
            "{}",
            diagnostics
        );

        let manifest = build_eigen_path_frequency_domain_manifest(
            FemEngine::CpuNative,
            &path_result,
            &[],
            &plan,
        );
        assert_eq!(
            manifest["resolved_execution"]["reference_or_production"],
            "production"
        );
        assert_eq!(
            manifest["diagnostics"]["periodic_mesh_certificate"],
            diagnostics["periodic_mesh_certificate"]
        );
    }

    #[test]
    fn de_bv_low_k_dispersion_validation_uses_analytic_reference_solver() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("BV".to_string()),
                    k_vector: [3.0e6, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("G".to_string()),
                    k_vector: [0.0, 0.0, 0.0],
                },
                fullmag_ir::KPointIR {
                    label: Some("DE".to_string()),
                    k_vector: [0.0, 3.0e6, 0.0],
                },
            ],
            samples_per_segment: vec![2, 1, 2],
            closed: false,
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.external_field = Some([40_000.0, 0.0, 0.0]);
        plan.material.exchange_stiffness = 3.5e-12;
        plan.material.saturation_magnetisation = 140e3;
        plan.gyromagnetic_ratio = 2.211e5;
        plan.spin_wave_bc =
            fullmag_ir::SpinWaveBoundaryConditionIR::Config(fullmag_ir::SpinWaveBoundaryConfigIR {
                kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                boundary_pair_id: None,
                pair_ids: vec!["x_faces".to_string(), "y_faces".to_string()],
                phase_convention: fullmag_ir::PhaseConventionIR::default(),
                surface_anisotropy_ks: None,
                surface_anisotropy_axis: None,
            });
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e6,
            frequency_max_hz: 5.0e9,
        };
        plan.dispersion_validation = Some(fullmag_ir::FemEigenDispersionValidationIR {
            kind: "thin_film_de_bv_low_k".to_string(),
            analytic_model: "kalinikos_slab_n0".to_string(),
            film_thickness_m: 20e-9,
            equilibrium_magnetization: [1.0, 0.0, 0.0],
            film_normal: [0.0, 0.0, 1.0],
            frequency_window_hz: fullmag_ir::FemEigenDispersionValidationWindowIR {
                min: 0.0,
                max: 5.0e9,
            },
            max_k_rad_per_m: 3.0e6,
            max_relative_error: 0.10,
            scenarios: vec![
                fullmag_ir::FemEigenDispersionValidationScenarioIR {
                    geometry: "backward_volume".to_string(),
                    branch_id: "branch_0".to_string(),
                    sample_indices: vec![0, 1, 2],
                },
                fullmag_ir::FemEigenDispersionValidationScenarioIR {
                    geometry: "damon_eshbach".to_string(),
                    branch_id: "branch_0".to_string(),
                    sample_indices: vec![3, 4, 5],
                },
            ],
        });

        let run = execute_fem_eigen(
            FemEngine::CpuNative,
            &plan,
            &[
                OutputIR::EigenSpectrum {
                    quantity: "frequency_hz".to_string(),
                },
                OutputIR::DispersionCurve {
                    name: "dispersion".to_string(),
                },
                OutputIR::EigenMode {
                    field: "mode".to_string(),
                    indices: vec![0],
                },
            ],
        )
        .expect("DE/BV low-k validation target should use the analytic reference solver");

        let spectrum = run
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "eigen/spectrum.v2.json")
            .expect("analytic reference solver must publish spectrum.v2");
        let spectrum_json: serde_json::Value =
            serde_json::from_slice(&spectrum.bytes).expect("spectrum.v2 must be JSON");
        assert_eq!(
            spectrum_json["solver_id"],
            "reference_thin_film_de_bv_kalinikos_n0"
        );
        assert_eq!(spectrum_json["sample_count"], 6);
        let manifest = run
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == "frequency_domain/manifest.v1.json")
            .expect("analytic reference solver must publish frequency-domain manifest");
        let manifest_json: serde_json::Value =
            serde_json::from_slice(&manifest.bytes).expect("manifest must be JSON");
        assert_eq!(
            manifest_json["validation"]["dispersion_validation"]["kind"],
            "thin_film_de_bv_low_k"
        );
        assert_eq!(
            manifest_json["validation"]["dispersion_frequency_source"],
            "analytic_reference_model"
        );
        assert_eq!(
            manifest_json["validation"]["dispersion_reference_model"],
            "kalinikos_slab_n0"
        );
        assert_eq!(
            manifest_json["validation"]["dynamic_demag_operator_source"],
            "analytic_thin_film_de_bv_reference_not_fem_demag_k"
        );
        assert_eq!(manifest_json["requested_execution"]["include_demag"], true);
        assert_eq!(manifest_json["capabilities"]["validation_artifact"], true);
    }

    #[test]
    fn forced_fem_gpu_rejects_current_modules() {
        let mut problem = fem_policy_problem();
        problem
            .current_modules
            .push(CurrentModuleIR::AntennaFieldSource {
                name: "src".to_string(),
                model: fullmag_ir::AntennaFieldSourceModelIR::Mqs2p5dAz,
                solver: Some("fdtd".to_string()),
                antenna: Some(AntennaIR::Microstrip {
                    width: 1.0,
                    thickness: 1.0,
                    height_above_magnet: 1.0,
                    preview_length: 1.0,
                    center_x: 0.0,
                    center_y: 0.0,
                    current_distribution: "uniform".to_string(),
                }),
                drive: Some(RfDriveIR {
                    current_a: 1.0,
                    waveform: None,
                }),
                air_box_factor: Some(2.0),
                object: None,
                field: None,
                spatial_profile: None,
                waveform: None,
            });
        let result = resolve_fem_engine_with_availability(
            &problem,
            "gpu",
            true,
            1,
            &native_fem_availability_for_test(
                true,
                false,
                "native FEM GPU backend is unavailable in this test",
            ),
        );
        let err = result.expect_err("current modules must reject forced GPU");
        assert!(err.message.contains("current_modules_force_cpu"));
    }

    #[test]
    fn prescribed_current_transport_does_not_force_cpu_fallback() {
        let mut problem = fem_policy_problem();
        problem.validation_profile.execution_mode = fullmag_ir::ExecutionMode::Extended;
        problem
            .current_modules
            .push(CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: Some("free".to_string()),
                conductivity_s_per_m: None,
                coupling: fullmag_ir::TransportCouplingIR::OneWay,
                definition: None,
            });

        let resolution = resolve_fem_engine_with_availability(
            &problem,
            "gpu",
            false,
            1,
            &native_fem_availability_for_test(true, true, "native FEM GPU backend is available"),
        )
        .expect("prescribed transport should remain on GPU");
        assert_eq!(resolution.engine, FemEngine::NativeGpu);
        assert_ne!(
            resolution
                .fallback
                .as_ref()
                .map(|fallback| fallback.reason.as_str()),
            Some("current_modules_force_cpu")
        );
    }

    #[test]
    fn fem_small_mesh_policy_is_opt_in() {
        let _guard = env_lock().lock().expect("env mutex");
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
            std::env::remove_var("FULLMAG_FEM_GPU_MIN_NODES");
        }
        let features =
            crate::solver_runtime::fem_crossover::features_from_plan(&tiny_fem_plan(), false);
        assert!(
            crate::solver_runtime::fem_crossover::debug_min_nodes_decision(&features).is_none()
        );

        unsafe {
            std::env::set_var("FULLMAG_FEM_GPU_MIN_NODES", "10");
        }
        assert_eq!(
            crate::solver_runtime::fem_crossover::debug_min_nodes_decision(&features)
                .map(|decision| decision.resolved),
            Some("cpu".to_string())
        );

        unsafe {
            std::env::remove_var("FULLMAG_FEM_GPU_MIN_NODES");
        }
    }

    #[test]
    fn strict_fem_gpu_rejects_small_mesh_policy_instead_of_falling_back() {
        let _guard = env_lock().lock().expect("env mutex");
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
            std::env::set_var("FULLMAG_FEM_GPU_MIN_NODES", "10");
        }

        let result = apply_fem_gpu_plan_constraints(
            &tiny_fem_plan(),
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            true,
            None,
        );

        unsafe {
            std::env::remove_var("FULLMAG_FEM_GPU_MIN_NODES");
        }
        let err = result.expect_err("strict GPU must fail closed for small-mesh policy");
        assert!(err.message.contains("fem_gpu_small_mesh_policy"));
        assert!(err.message.contains("requested"));
    }

    #[test]
    fn extended_fem_gpu_small_mesh_fallback_is_provenanced() {
        let _guard = env_lock().lock().expect("env mutex");
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
            std::env::set_var("FULLMAG_FEM_GPU_MIN_NODES", "10");
        }

        let resolution = apply_fem_gpu_plan_constraints(
            &tiny_fem_plan(),
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            false,
            None,
        )
        .expect("extended GPU may explicitly resolve to CPU for small mesh");

        unsafe {
            std::env::remove_var("FULLMAG_FEM_GPU_MIN_NODES");
        }
        assert_eq!(resolution.engine, FemEngine::CpuNative);
        let fallback = resolution.fallback.expect("fallback provenance");
        assert_eq!(fallback.reason, "fem_gpu_small_mesh_policy");
        assert_eq!(fallback.original_engine, "fem_native_gpu");
        assert_eq!(fallback.fallback_engine, "fem_cpu_native");
    }

    #[test]
    fn auto_fem_stt_only_plan_falls_back_to_cpu_with_gpu_rk_reason() {
        let resolution = apply_fem_gpu_plan_constraints(
            &stt_only_fem_plan(),
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            false,
            None,
        )
        .expect("auto FEM must resolve a GPU-RK-ineligible STT-only plan to CPU");

        assert_eq!(resolution.engine, FemEngine::CpuNative);
        let fallback = resolution.fallback.expect("auto fallback provenance");
        assert_eq!(fallback.reason, "fem_gpu_rk_plan_ineligible");
        assert!(fallback.message.contains("enable_exchange=true"));
    }

    #[test]
    fn auto_fem_canonical_slonczewski_v2_remains_gpu_eligible() {
        let resolution = apply_fem_gpu_plan_constraints(
            &canonical_stt_fem_plan("slonczewski.fullmag.v2"),
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            false,
            None,
        )
        .expect("canonical Slonczewski v2 should reach native GPU runtime prerequisites");

        assert_eq!(resolution.engine, FemEngine::NativeGpu);
        assert!(resolution.fallback.is_none());
    }

    #[test]
    fn auto_fem_canonical_zhang_li_remains_gpu_eligible() {
        let resolution = apply_fem_gpu_plan_constraints(
            &canonical_stt_fem_plan("zhang_li.fullmag.v1"),
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            false,
            None,
        )
        .expect("auto FEM must keep canonical Zhang-Li on the native GPU lane");

        assert_eq!(resolution.engine, FemEngine::NativeGpu);
        assert!(resolution.fallback.is_none());
    }

    #[test]
    fn explicit_cpu_fem_plan_is_not_classified_as_forced_gpu() {
        assert!(!fem_plan_gpu_request_is_forced("cpu"));
        assert!(!fem_plan_gpu_request_is_forced("auto"));
        assert!(fem_plan_gpu_request_is_forced("gpu"));
        assert!(fem_plan_gpu_request_is_forced("all_in_gpu"));
    }

    #[test]
    fn explicit_cpu_zhang_li_plan_reaches_cpu_preflight() {
        let resolution = apply_fem_gpu_plan_constraints(
            &canonical_stt_fem_plan("zhang_li.fullmag.v1"),
            EngineResolution {
                engine: FemEngine::CpuNative,
                fallback: None,
            },
            fem_plan_gpu_request_is_forced("cpu"),
            None,
        )
        .expect("CPU Zhang-Li plan must not enter the strict GPU preflight");

        assert_eq!(resolution.engine, FemEngine::CpuNative);
        assert!(resolution.fallback.is_none());
    }

    #[test]
    fn auto_fem_oersted_only_plan_falls_back_to_cpu_with_gpu_rk_reason() {
        let resolution = apply_fem_gpu_plan_constraints(
            &oersted_only_fem_plan(),
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            false,
            None,
        )
        .expect("auto FEM must resolve a GPU-RK-ineligible Oersted-only plan to CPU");

        assert_eq!(resolution.engine, FemEngine::CpuNative);
        let fallback = resolution.fallback.expect("auto fallback provenance");
        assert_eq!(fallback.reason, "fem_gpu_rk_plan_ineligible");
        assert!(fallback.message.contains("enable_exchange=true"));
    }

    #[test]
    fn strict_fem_stt_only_gpu_plan_fails_closed_before_execution() {
        let err = apply_fem_gpu_plan_constraints(
            &stt_only_fem_plan(),
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            true,
            None,
        )
        .expect_err("strict GPU must reject a GPU-RK-ineligible STT-only plan");

        assert!(err.message.contains("fem_gpu_rk_plan_ineligible"));
        assert!(err.message.contains("enable_exchange=true"));
    }

    #[test]
    fn strict_fem_canonical_slonczewski_v2_reaches_native_runtime_validation() {
        let resolution = apply_fem_gpu_plan_constraints(
            &canonical_stt_fem_plan("slonczewski.fullmag.v2"),
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            true,
            None,
        )
        .expect("strict canonical Slonczewski v2 should reach native runtime validation");
        assert_eq!(resolution.engine, FemEngine::NativeGpu);
    }

    #[test]
    fn strict_fem_canonical_zhang_li_reaches_native_runtime_validation() {
        let resolution = apply_fem_gpu_plan_constraints(
            &canonical_stt_fem_plan("zhang_li.fullmag.v1"),
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            true,
            None,
        )
        .expect("strict canonical Zhang-Li GPU should reach native runtime validation");

        assert_eq!(resolution.engine, FemEngine::NativeGpu);
        assert!(resolution.fallback.is_none());
    }

    #[test]
    fn strict_fem_oersted_only_gpu_plan_fails_closed_before_execution() {
        let err = apply_fem_gpu_plan_constraints(
            &oersted_only_fem_plan(),
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            true,
            None,
        )
        .expect_err("strict GPU must reject a GPU-RK-ineligible Oersted-only plan");

        assert!(err.message.contains("fem_gpu_rk_plan_ineligible"));
        assert!(err.message.contains("enable_exchange=true"));
    }

    #[test]
    fn fem_execution_does_not_repeat_post_selection_cpu_fallback() {
        let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("dispatch.rs should be readable");
        let start = source
            .find("pub(crate) fn execute_fem")
            .expect("execute_fem should exist");
        let end = source[start..]
            .find("pub(crate) fn execute_fem_eigen")
            .map(|offset| start + offset)
            .expect("execute_fem_eigen should follow execute_fem");
        let execute_fem_source = &source[start..end];

        assert!(
            !execute_fem_source.contains("should_fallback_to_cpu_for_small_fem_gpu"),
            "engine selection must be the sole owner of GPU-to-CPU small-mesh fallback"
        );
        assert!(
            !execute_fem_source.contains("FemEngine::CpuNative,\n                    &cpu_plan"),
            "the NativeGpu execution branch must never invoke the CPU engine"
        );
    }

    #[test]
    fn native_gpu_plan_validation_precedes_execution_provenance_publication() {
        let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("dispatch.rs should be readable");
        let start = source
            .find("fn execute_native_fem(")
            .expect("execute_native_fem should exist");
        let end = source[start..]
            .find("fn execute_fem_with_registry")
            .map(|offset| start + offset)
            .expect("execute_fem_with_registry should follow execute_native_fem");
        let execute_native_source = &source[start..end];
        let validation = execute_native_source
            .find("validate_native_fem_gpu_engine_runtime_contract")
            .expect("native FEM must validate the selected GPU execution contract");
        let execution_engine = execute_native_source
            .find("let execution_engine")
            .expect("native FEM must materialize execution-engine provenance");
        let provenance = execute_native_source
            .find("let mut provenance")
            .expect("native FEM must materialize execution provenance");

        assert!(
            validation < execution_engine && execution_engine < provenance,
            "a disabled native GPU plan must fail before GPU execution or provenance is published"
        );
    }

    #[cfg(feature = "fem-gpu")]
    fn relaxation_control(algorithm: RelaxationAlgorithmIR) -> RelaxationControlIR {
        RelaxationControlIR {
            algorithm,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(3),
                max_relaxation_time_s: None,
            },
        }
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn fem_gpu_auto_falls_back_to_cpu_for_cpu_mfem_relaxation_algorithm() {
        let mut plan = tiny_fem_plan();
        plan.relaxation = Some(relaxation_control(
            RelaxationAlgorithmIR::TangentPlaneImplicit,
        ));

        let resolution = apply_fem_gpu_plan_constraints(
            &plan,
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            false,
            None,
        )
        .expect("auto GPU should fall back to CPU/MFEM for CPU-only relaxation");

        assert_eq!(resolution.engine, FemEngine::CpuNative);
        let fallback = resolution.fallback.expect("fallback should be recorded");
        assert!(fallback.occurred);
        assert_eq!(fallback.original_engine, "fem_native_gpu");
        assert_eq!(fallback.fallback_engine, "fem_cpu_native");
        assert_eq!(fallback.reason, FEM_GPU_RELAXATION_CPU_ONLY_FALLBACK_REASON);
        assert!(fallback.message.contains("tangent_plane_implicit"));
        assert!(fallback.message.contains("CPU/MFEM"));
        assert!(fallback.message.contains("GPU/libCEED"));
        assert!(fallback.message.contains("tangent-plane solve"));
        assert!(
            !fallback
                .message
                .contains("device-resident relaxation is under development"),
            "{}",
            fallback.message
        );
        assert!(fallback.message.contains("under development"));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_direct_minimizer_execute_fem_forwards_backend_completion() {
        if !crate::native_fem::is_cpu_available() {
            eprintln!(
                "skipping native FEM direct-minimizer execute_fem completion test: CPU MFEM stack unavailable"
            );
            return;
        }

        let mut plan = tiny_fem_plan();
        plan.external_field = Some([0.0, 0.0, 2.0e5]);
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(1),
                max_relaxation_time_s: None,
            },
        });

        let executed = execute_fem(FemEngine::CpuNative, &plan, 1.0e-12, &[], None, None)
            .expect("native FEM direct-minimizer execute_fem completion");
        let completion = executed
            .result
            .completion
            .expect("execute_fem must surface native direct-minimizer completion");

        assert_eq!(
            completion.reason,
            Some(fullmag_ir::StageStopReason::MaxSteps)
        );
        assert_eq!(completion.metric_name.as_deref(), Some("steps"));
        assert_eq!(completion.metric_value, Some(1.0));
        assert_eq!(completion.threshold, Some(1.0));
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_direct_minimizer_execute_fem_forwards_gradient_completion() {
        if !crate::native_fem::is_cpu_available() {
            eprintln!(
                "skipping native FEM direct-minimizer execute_fem gradient completion test: CPU MFEM stack unavailable"
            );
            return;
        }

        let mut plan = tiny_fem_plan();
        plan.external_field = None;
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(5),
                max_relaxation_time_s: None,
            },
        });

        let executed = execute_fem(FemEngine::CpuNative, &plan, 1.0e-12, &[], None, None)
            .expect("native FEM direct-minimizer execute_fem gradient completion");
        let completion = executed
            .result
            .completion
            .expect("execute_fem must surface native gradient completion");

        assert_eq!(
            completion.reason,
            Some(fullmag_ir::StageStopReason::Gradient)
        );
        assert_eq!(
            completion.metric_name.as_deref(),
            Some("tangent_gradient_norm_sq")
        );
        assert!(
            completion.metric_value.unwrap_or(f64::INFINITY)
                <= completion.threshold.unwrap_or(f64::NEG_INFINITY),
            "{completion:?}"
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn native_fem_direct_minimizer_execute_fem_forwards_initial_torque_completion() {
        if !crate::native_fem::is_cpu_available() {
            eprintln!(
                "skipping native FEM direct-minimizer execute_fem initial torque completion test: CPU MFEM stack unavailable"
            );
            return;
        }

        let mut plan = tiny_fem_plan();
        plan.external_field = Some([0.0, 0.0, 2.0e5]);
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(1.0e30),
                energy_tolerance_j: None,
                max_steps: Some(5),
                max_relaxation_time_s: None,
            },
        });

        let executed = execute_fem(FemEngine::CpuNative, &plan, 1.0e-12, &[], None, None)
            .expect("native FEM direct-minimizer execute_fem initial torque completion");
        let completion = executed
            .result
            .completion
            .expect("execute_fem must surface native initial torque completion");

        assert_eq!(completion.reason, Some(fullmag_ir::StageStopReason::Torque));
        assert_eq!(completion.metric_name.as_deref(), Some("max_torque_apm"));
        assert!(
            completion.metric_value.unwrap_or(f64::INFINITY)
                <= completion.threshold.unwrap_or(f64::NEG_INFINITY),
            "{completion:?}"
        );
        assert_eq!(
            executed.result.steps.last().map(|stats| stats.step),
            Some(0),
            "initial torque completion must surface the native zero-step snapshot"
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn forced_fem_gpu_rejects_cpu_mfem_relaxation_algorithm() {
        let mut plan = tiny_fem_plan();
        plan.relaxation = Some(relaxation_control(
            RelaxationAlgorithmIR::TangentPlaneImplicit,
        ));

        let err = apply_fem_gpu_plan_constraints(
            &plan,
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            true,
            None,
        )
        .expect_err("forced GPU must not silently fall back for CPU-only relaxation");

        assert!(
            err.message.contains("tangent_plane_implicit"),
            "{}",
            err.message
        );
        assert!(
            err.message
                .contains(FEM_GPU_RELAXATION_CPU_ONLY_FALLBACK_REASON),
            "{}",
            err.message
        );
        assert!(err.message.contains("GPU/libCEED"), "{}", err.message);
        assert!(
            err.message.contains("tangent-plane solve"),
            "{}",
            err.message
        );
        assert!(
            !err.message
                .contains("device-resident relaxation is under development"),
            "{}",
            err.message
        );
        assert!(err.message.contains("under development"), "{}", err.message);
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn llg_overdamped_relaxation_keeps_native_gpu_resolution() {
        let mut plan = tiny_fem_plan();
        plan.relaxation = Some(relaxation_control(RelaxationAlgorithmIR::LlgOverdamped));

        let resolution = apply_fem_gpu_plan_constraints(
            &plan,
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            false,
            None,
        )
        .expect("LLG overdamped is supported on native FEM GPU");

        assert_eq!(resolution.engine, FemEngine::NativeGpu);
        assert!(resolution.fallback.is_none());
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn projected_gradient_bb_relaxation_keeps_native_gpu_resolution() {
        let mut plan = tiny_fem_plan();
        plan.relaxation = Some(relaxation_control(
            RelaxationAlgorithmIR::ProjectedGradientBb,
        ));

        let resolution = apply_fem_gpu_plan_constraints(
            &plan,
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            false,
            None,
        )
        .expect("projected-gradient BB is supported on native FEM GPU");

        assert_eq!(resolution.engine, FemEngine::NativeGpu);
        assert!(resolution.fallback.is_none());
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn nonlinear_cg_relaxation_keeps_native_gpu_resolution() {
        let mut plan = tiny_fem_plan();
        plan.relaxation = Some(relaxation_control(RelaxationAlgorithmIR::NonlinearCg));

        let resolution = apply_fem_gpu_plan_constraints(
            &plan,
            EngineResolution {
                engine: FemEngine::NativeGpu,
                fallback: None,
            },
            false,
            None,
        )
        .expect("nonlinear-CG is supported on native FEM GPU");

        assert_eq!(resolution.engine, FemEngine::NativeGpu);
        assert!(resolution.fallback.is_none());
    }

    #[test]
    fn normalized_runtime_markers_reject_short_and_long_marker_vectors() {
        for markers in [vec![], vec![1, 1]] {
            let mut plan = tiny_fem_plan();
            plan.mesh.element_markers = markers;

            let error = normalized_runtime_element_markers(&plan)
                .expect_err("marker count mismatch must fail before runtime normalization");
            assert!(
                error.message.contains("element marker count"),
                "{}",
                error.message
            );
        }
    }

    #[test]
    fn initial_magnetization_validation_rejects_marker_count_mismatch_without_defaulting() {
        for markers in [vec![], vec![1, 1]] {
            let mut plan = tiny_fem_plan();
            plan.mesh.element_markers = markers;

            let error = validate_runtime_initial_magnetization(&plan)
                .expect_err("marker count mismatch must not be defaulted during validation");
            assert!(
                error.message.contains("element marker count"),
                "{}",
                error.message
            );
        }
    }

    #[test]
    fn normalized_runtime_markers_fallback_to_object_segments_when_region_materials_missing() {
        let mut plan = tiny_fem_plan();
        plan.mesh
            .set_tet4_cells(vec![[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]]);
        plan.mesh.element_markers = vec![1, 2, 0];
        plan.object_segments = vec![
            FemObjectSegmentIR {
                object_id: "nanoflower_0".to_string(),
                geometry_id: Some("nanoflower_0_geom".to_string()),
                node_start: 0,
                node_count: 4,
                element_start: 0,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 0,
            },
            FemObjectSegmentIR {
                object_id: "nanoflower_1".to_string(),
                geometry_id: Some("nanoflower_1_geom".to_string()),
                node_start: 0,
                node_count: 4,
                element_start: 1,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 0,
            },
            FemObjectSegmentIR {
                object_id: "__air__".to_string(),
                geometry_id: None,
                node_start: 0,
                node_count: 4,
                element_start: 2,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 0,
            },
        ];

        let normalized = normalized_runtime_element_markers(&plan)
            .expect("segments should disambiguate markers");
        assert_eq!(normalized, vec![1, 1, 0]);
    }

    #[test]
    fn normalized_runtime_markers_reject_incomplete_object_segment_inference() {
        let mut plan = tiny_fem_plan();
        plan.mesh
            .set_tet4_cells(vec![[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]]);
        plan.mesh.element_markers = vec![1, 2, 0];
        plan.object_segments = vec![FemObjectSegmentIR {
            object_id: "nanoflower_0".to_string(),
            geometry_id: Some("nanoflower_0_geom".to_string()),
            node_start: 0,
            node_count: 4,
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 0,
        }];

        let error = normalized_runtime_element_markers(&plan)
            .expect_err("missing marker 2 in object_segments should fail");
        assert!(error
            .message
            .contains("object_segments/mesh_parts-inferred magnetic markers"));
    }

    #[test]
    fn normalized_runtime_markers_fallback_to_mesh_parts_when_segments_missing() {
        let mut plan = tiny_fem_plan();
        plan.mesh
            .set_tet4_cells(vec![[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]]);
        plan.mesh.element_markers = vec![1, 2, 0];
        plan.object_segments.clear();
        plan.mesh_parts = vec![
            FemMeshPartIR {
                id: "part:nanoflower_0".to_string(),
                label: "nanoflower_0".to_string(),
                role: FemMeshPartRole::MagneticObject,
                object_id: Some("nanoflower_0".to_string()),
                geometry_id: Some("nanoflower_0_geom".to_string()),
                material_id: None,
                element_selector: FemMeshPartSelector::ElementMarkerSet { markers: vec![1] },
                boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                    start: 0,
                    count: 0,
                },
                node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 0 },
                boundary_face_indices: Vec::new(),
                node_indices: Vec::new(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
            FemMeshPartIR {
                id: "part:nanoflower_1".to_string(),
                label: "nanoflower_1".to_string(),
                role: FemMeshPartRole::MagneticObject,
                object_id: Some("nanoflower_1".to_string()),
                geometry_id: Some("nanoflower_1_geom".to_string()),
                material_id: None,
                element_selector: FemMeshPartSelector::ElementMarkerSet { markers: vec![2] },
                boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                    start: 0,
                    count: 0,
                },
                node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 0 },
                boundary_face_indices: Vec::new(),
                node_indices: Vec::new(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
            FemMeshPartIR {
                id: "part:air".to_string(),
                label: "air".to_string(),
                role: FemMeshPartRole::Air,
                object_id: None,
                geometry_id: None,
                material_id: None,
                element_selector: FemMeshPartSelector::ElementMarkerSet { markers: vec![0] },
                boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                    start: 0,
                    count: 0,
                },
                node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 0 },
                boundary_face_indices: Vec::new(),
                node_indices: Vec::new(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
        ];

        let normalized =
            normalized_runtime_element_markers(&plan).expect("mesh_parts should disambiguate");
        assert_eq!(normalized, vec![1, 1, 0]);
    }

    #[test]
    fn normalized_fem_plan_rejects_missing_airbox_markers() {
        let mut plan = tiny_fem_plan();
        plan.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir;
        plan.mesh.nodes.push([2.0, 0.0, 0.0]);
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [1, 2, 3, 4]]);
        plan.mesh.element_markers.clear();
        plan.object_segments.clear();
        plan.mesh_parts = vec![
            FemMeshPartIR {
                id: "part:magnet".to_string(),
                label: "magnet".to_string(),
                role: FemMeshPartRole::MagneticObject,
                object_id: Some("magnet".to_string()),
                geometry_id: Some("magnet_geom".to_string()),
                material_id: None,
                element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 1 },
                boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                    start: 0,
                    count: 0,
                },
                node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 4 },
                boundary_face_indices: Vec::new(),
                node_indices: Vec::new(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
            FemMeshPartIR {
                id: "part:air".to_string(),
                label: "Airbox".to_string(),
                role: FemMeshPartRole::Air,
                object_id: None,
                geometry_id: None,
                material_id: None,
                element_selector: FemMeshPartSelector::ElementRange { start: 1, count: 1 },
                boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                    start: 0,
                    count: 0,
                },
                node_selector: FemMeshPartSelector::NodeRange { start: 1, count: 4 },
                boundary_face_indices: Vec::new(),
                node_indices: Vec::new(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
        ];
        plan.initial_magnetization = vec![
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ];

        let error = normalized_fem_plan_for_runtime(&plan)
            .expect_err("shared-domain meshes must carry one marker per element");
        assert!(
            error.message.contains("element marker count"),
            "{}",
            error.message
        );
    }

    #[test]
    fn normalized_fem_plan_rejects_zero_initial_on_active_magnetic_node() {
        let mut plan = tiny_fem_plan();
        plan.mesh.nodes.push([2.0, 0.0, 0.0]);
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [1, 2, 3, 4]]);
        plan.mesh.element_markers = vec![1, 0];
        plan.initial_magnetization = vec![
            [1.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, 0.0],
        ];

        let error = normalized_fem_plan_for_runtime(&plan)
            .expect_err("active magnetic node 1 has zero magnetization");
        assert!(
            error
                .message
                .contains("active magnetic node 1 has zero or invalid initial magnetization"),
            "{}",
            error.message
        );

        plan.initial_magnetization[1] = [1.0, 0.0, 0.0];
        normalized_fem_plan_for_runtime(&plan)
            .expect("zero magnetization on air-only node 4 should be accepted");
    }

    #[test]
    fn native_fem_direct_minimizer_publishes_accepted_step_live_updates() {
        let source = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/direct_minimizer.rs"
        ))
        .expect("read direct_minimizer.rs");

        assert!(
            source.contains("artifacts.record_scalar(&accepted_stats)?;")
                && source.contains(
                    "let magnetization = if current_stats.step % heavy_payload_every == 0"
                )
                && source.contains("stats: live_stats,")
                && source.contains("magnetization,")
                && source.contains("let action = (live.on_step)(StepUpdate {
            coupled_checkpoint: None,"),
            "native FEM direct minimizer must publish live updates after accepted steps"
        );
    }

    #[test]
    fn fdm_cuda_completion_snapshots_use_exact_torque_metrics() {
        let dispatch = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/dispatch.rs"))
            .expect("read dispatch.rs");
        let cuda_single = dispatch
            .split("#[cfg(feature = \"cuda\")]\nfn execute_cuda_fdm(")
            .nth(1)
            .and_then(|source| source.split("#[cfg(feature = \"fem-gpu\")]").next())
            .expect("active CUDA single-grid execution body");
        assert!(
            cuda_single.contains("max_torque_apm: completion_max_torque_apm")
                && !cuda_single.contains("max_torque_apm: None"),
            "CUDA single-grid completion must use the latest exact native torque"
        );

        let multilayer = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fdm/gpu/cuda/multilayer.rs"
        ))
        .expect("read CUDA multilayer implementation");
        assert_eq!(
            multilayer
                .matches("max_torque_apm: Some(final_stats.max_torque_Apm)")
                .count(),
            3,
            "all three active CUDA multilayer lanes must publish exact final torque"
        );
        assert!(
            !multilayer.contains("max_torque_apm: None"),
            "CUDA multilayer completion must not publish unavailable torque"
        );
    }
}

#[cfg(all(test, feature = "fem-gpu"))]
pub(crate) use tests::tiny_fem_plan as test_tiny_fem_plan;
