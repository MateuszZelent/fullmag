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
    BackendPlanIR, ExecutionMode, ExecutionPlanIR, FdmFftPlanIR, FdmPlanIR, FemEigenPlanIR,
    FemMeshPartSelector, FemPlanIR, OutputIR, ProblemIR, RelaxationAlgorithmIR,
};
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::sync::{Mutex, OnceLock};

use crate::artifact_pipeline::ArtifactPipelineSender;
#[cfg(feature = "fem-gpu")]
use crate::artifact_pipeline::ArtifactRecorder;
use crate::fdm::cpu::reference as cpu_reference;
#[cfg(feature = "cuda")]
use crate::fdm::gpu::cuda::native::NativeFdmBackend;
use crate::fem::eigen_execution_resolution::{FemEigenExecutionLane, PlannedFemEigenExecution};
#[cfg(feature = "fem-gpu")]
use crate::fem::relax::scalars::ensure_fem_object_scalars;
use crate::fem_baseline;
use crate::fem_eigen;
use crate::native_fem;
#[cfg(feature = "fem-gpu")]
use crate::native_fem::{
    NativeFemBackend, NativeFemDataResidency, NativeFemGpuRkPlanInfo, NativeFemGpuStateInfo,
    StageOerstedProvider,
};
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::quantities::normalized_quantity_name;
use crate::quantities::{active_fdm_preview_quantities, active_fem_preview_quantities};
#[cfg(feature = "fem-gpu")]
use crate::relaxation::apply_energy_minimizer_provenance;
#[cfg(feature = "fem-gpu")]
use crate::relaxation::apply_fem_direct_minimizer_policy_provenance;
#[cfg(feature = "fem-gpu")]
use crate::relaxation::llg_overdamped_uses_pure_damping;
#[cfg(feature = "fem-gpu")]
use crate::relaxation::RelaxationEnergyPlateauWindow;
use crate::runtime_registry::RuntimeRegistry;
#[cfg(feature = "fem-gpu")]
use crate::schedules::{advance_due_schedules, collect_field_schedules, OutputSchedule};
pub(crate) use crate::solver_runtime::engine::{EngineResolution, FdmEngine};
use crate::solver_runtime::fem_crossover::resolve_auto_fem_plan_device;
#[cfg(feature = "fem-gpu")]
use crate::solver_runtime::selection::all_in_gpu_fem_required;
pub(crate) use crate::solver_runtime::selection::{
    all_in_gpu_fem_env_requested, effective_fem_device_request,
    effective_fem_device_request_for_plan, fem_gpu_execution_forced,
    reject_frozen_spins_cuda_execution, reject_frozen_spins_cuda_plan_execution,
    reject_frozen_spins_fem_execution, reject_frozen_spins_fem_plan_execution, resolve_fdm_engine,
    resolve_fdm_engine_for_plan_with_trail, resolve_fdm_engine_with_trail,
};
#[cfg(test)]
pub(crate) use crate::solvers::fdm::execute::execute_fdm;
pub(crate) use crate::solvers::fdm::execute::{execute_fdm_in_mode, execute_fdm_multilayer};
#[cfg(feature = "fem-gpu")]
use crate::types::FemPoissonDemagProvenance;
#[cfg(feature = "fem-gpu")]
use crate::types::FieldSnapshot;
use crate::types::{
    AuxiliaryArtifact, ExecutedRun, FemStageExecutionContext, LivePreviewRequest, LiveStepConsumer,
    ResolvedFallback, RunError,
};

#[cfg(test)]
#[derive(Debug, Clone)]
pub(crate) struct TestFemEigenDispatchObservation {
    pub(crate) entrypoint: &'static str,
    pub(crate) lane: FemEigenExecutionLane,
    pub(crate) native_target: Option<native_fem::NativeModalExecutionTarget>,
    pub(crate) resolution: fullmag_ir::FemEigenExecutionResolutionIR,
}

#[cfg(test)]
struct TestFemEigenExecutionSeam {
    expected_mesh_name: String,
    executed: Option<ExecutedRun>,
    observations: Vec<TestFemEigenDispatchObservation>,
}

#[cfg(test)]
static TEST_FEM_EIGEN_EXECUTION_SEAM: OnceLock<Mutex<Option<TestFemEigenExecutionSeam>>> =
    OnceLock::new();
#[cfg(test)]
static TEST_FEM_EIGEN_GENERIC_RESOLVER_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub(crate) struct TestFemEigenExecutionSeamGuard;

#[cfg(test)]
impl TestFemEigenExecutionSeamGuard {
    pub(crate) fn take_observations(&self) -> Vec<TestFemEigenDispatchObservation> {
        TEST_FEM_EIGEN_EXECUTION_SEAM
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("test FEM eigen execution seam mutex")
            .as_mut()
            .map(|seam| std::mem::take(&mut seam.observations))
            .unwrap_or_default()
    }

    pub(crate) fn generic_resolver_calls(&self) -> usize {
        TEST_FEM_EIGEN_GENERIC_RESOLVER_CALLS.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
impl Drop for TestFemEigenExecutionSeamGuard {
    fn drop(&mut self) {
        *TEST_FEM_EIGEN_EXECUTION_SEAM
            .get_or_init(|| Mutex::new(None))
            .lock()
            .expect("test FEM eigen execution seam mutex") = None;
    }
}

#[cfg(test)]
pub(crate) fn install_test_fem_eigen_execution_seam(
    expected_mesh_name: &str,
    executed: ExecutedRun,
) -> TestFemEigenExecutionSeamGuard {
    let mut seam = TEST_FEM_EIGEN_EXECUTION_SEAM
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("test FEM eigen execution seam mutex");
    assert!(
        seam.is_none(),
        "test FEM eigen execution seam already installed"
    );
    *seam = Some(TestFemEigenExecutionSeam {
        expected_mesh_name: expected_mesh_name.to_string(),
        executed: Some(executed),
        observations: Vec::new(),
    });
    TEST_FEM_EIGEN_GENERIC_RESOLVER_CALLS.store(0, std::sync::atomic::Ordering::SeqCst);
    TestFemEigenExecutionSeamGuard
}

#[cfg(test)]
fn take_test_fem_eigen_execution(
    entrypoint: &'static str,
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
) -> Option<ExecutedRun> {
    let mut seam = TEST_FEM_EIGEN_EXECUTION_SEAM
        .get_or_init(|| Mutex::new(None))
        .lock()
        .expect("test FEM eigen execution seam mutex");
    let seam = seam.as_mut()?;
    if seam.expected_mesh_name != plan.mesh.mesh_name {
        return None;
    }
    let executed = seam.executed.take()?;
    seam.observations.push(TestFemEigenDispatchObservation {
        entrypoint,
        lane: execution.lane(),
        native_target: execution.native_target(),
        resolution: execution
            .resolution()
            .expect("exact K0 test seam requires a planned resolution")
            .clone(),
    });
    Some(executed)
}

#[cfg(feature = "fem-gpu")]
use crate::types::{ExecutionProvenance, StepStats};
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
            && matches!(
                plan.demag_operator_mode.as_str(),
                "device_hypre_poisson" | "device_hypre_fem_bem"
            )
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

fn constrain_fdm_device_for_fft(
    requested_device: String,
    fft: Option<&FdmFftPlanIR>,
) -> Result<String, RunError> {
    let Some(fft) = fft else {
        return Ok(requested_device);
    };
    match (fft.requested_backend.as_str(), requested_device.as_str()) {
        ("auto", _) => Ok(requested_device),
        ("rustfft", "auto") => Ok("cpu".to_string()),
        ("rustfft", "cpu") => Ok(requested_device),
        ("rustfft", "gpu" | "cuda") => Err(RunError {
            message: "fdm.demag.fft_backend='rustfft' cannot execute on the requested GPU device"
                .to_string(),
        }),
        ("cufft", "auto") => Ok("gpu".to_string()),
        ("cufft", "gpu" | "cuda") => Ok("gpu".to_string()),
        ("cufft", "cpu") => Err(RunError {
            message: "fdm.demag.fft_backend='cufft' cannot execute on the requested CPU device"
                .to_string(),
        }),
        (other, _) => Err(RunError {
            message: format!(
                "fdm.demag.fft_backend='{other}' is not executable; supported runtime requests are auto, rustfft, and cufft"
            ),
        }),
    }
}

fn resolve_fdm_engine_with_registry(
    problem: &ProblemIR,
    registry: &RuntimeRegistry,
    _explicit_selection: bool,
    plan: Option<&FdmPlanIR>,
    fft: Option<&FdmFftPlanIR>,
) -> Result<DispatchEngineResolution, RunError> {
    apply_runtime_gpu_index(problem, "fdm");
    let requested_device =
        constrain_fdm_device_for_fft(requested_registry_device_for_fdm(problem), fft)?;
    let guard_requested_device =
        crate::solver_runtime::selection::public_fdm_gpu_charge_device_request(problem);
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

    if engine == FdmEngine::CudaFdm {
        reject_frozen_spins_cuda_execution(problem)?;
        if let Some(plan) = plan {
            reject_frozen_spins_cuda_plan_execution(plan)?;
        }
    }

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

    let guarded_resolution = EngineResolution {
        engine,
        fallback: fallback.clone(),
    };
    crate::solver_runtime::selection::require_public_fdm_gpu_charge_runtime_selection(
        plan.is_some_and(|plan| !plan.fdm_gpu_charge_transports.is_empty()),
        &guard_requested_device,
        &guarded_resolution,
    )?;

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
    reject_frozen_spins_fem_execution(problem)?;
    #[cfg(test)]
    if problem.problem_meta.name == "runner_exact_k0_execution_contract" {
        TEST_FEM_EIGEN_GENERIC_RESOLVER_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
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

pub(crate) fn resolve_planned_fem_eigen_execution<'a>(
    problem: &ProblemIR,
    plan: &'a ExecutionPlanIR,
    fem: &FemEigenPlanIR,
) -> Result<PlannedFemEigenExecution<'a>, RunError> {
    if let Some(execution) =
        crate::fem::eigen_execution_resolution::resolve_planned_fem_eigen_execution(plan, fem)?
    {
        return Ok(execution);
    }
    let lane = match resolve_fem_engine(problem)? {
        FemEngine::CpuNative => FemEigenExecutionLane::Cpu,
        FemEngine::NativeGpu => FemEigenExecutionLane::Gpu,
    };
    Ok(PlannedFemEigenExecution::legacy(lane))
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

fn planned_fem_eigen_dispatch_resolution(
    execution: PlannedFemEigenExecution<'_>,
    registry: Option<&RuntimeRegistry>,
) -> Result<DispatchEngineResolution, RunError> {
    let resolution = execution.resolution().ok_or_else(|| RunError {
        message: "planned_fem_eigen_resolution_missing_at_session_boundary".to_string(),
    })?;
    let (engine, device) = match execution.lane() {
        FemEigenExecutionLane::Cpu => (FemEngine::CpuNative, "cpu"),
        FemEigenExecutionLane::Gpu => (FemEngine::NativeGpu, "gpu"),
    };
    let precision = match resolution.resolved_precision {
        fullmag_ir::ExecutionPrecision::Double => "double",
        fullmag_ir::ExecutionPrecision::Single => "single",
    };
    let resolved_runtime = registry
        .map(|registry| {
            registry
                .resolve("fem", device, precision)
                .ok_or_else(|| RunError {
                    message: format!(
                        "planned_fem_eigen_runtime_unavailable: resolved_engine={} device={device} precision={precision}",
                        execution.engine_id()
                    ),
                })
        })
        .transpose()?;
    let fallback = resolution.fallback_reason.as_ref().map(|reason| {
        runtime_fallback(
            "auto",
            execution.engine_id(),
            reason,
            format!(
                "FEM eigen planner resolved auto execution to {} ({})",
                execution.engine_id(),
                resolution.selection_reason
            ),
        )
    });
    Ok(DispatchEngineResolution {
        engine: DispatchEngine::Fem(engine),
        fallback,
        runtime_family: resolved_runtime
            .as_ref()
            .map(|runtime| runtime.runtime_family.clone()),
        worker: resolved_runtime.map(|runtime| runtime.worker),
        resolved_backend: "fem".to_string(),
        resolved_device: device.to_string(),
        resolved_precision: precision.to_string(),
        fem_crossover_decision: None,
    })
}

pub(crate) fn resolve_with_registry(
    problem: &ProblemIR,
    registry: Option<&RuntimeRegistry>,
    explicit_selection: bool,
    preview_enabled: bool,
) -> Result<DispatchEngineResolution, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    resolve_with_registry_for_plan(
        problem,
        &plan,
        registry,
        explicit_selection,
        preview_enabled,
    )
}

/// Resolve the runtime against an already materialized execution plan.
///
/// Script-mode orchestration has already paid for planning and must not
/// rebuild a large FEM plan merely to populate live runtime metadata.
pub(crate) fn resolve_with_registry_for_plan(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    registry: Option<&RuntimeRegistry>,
    explicit_selection: bool,
    preview_enabled: bool,
) -> Result<DispatchEngineResolution, RunError> {
    match registry {
        Some(registry) => match &plan.backend_plan {
            BackendPlanIR::Fdm(fdm) => resolve_fdm_engine_with_registry(
                problem,
                registry,
                explicit_selection,
                Some(fdm),
                fdm.fft.as_ref(),
            ),
            BackendPlanIR::FdmMultilayer(multilayer) => resolve_fdm_engine_with_registry(
                problem,
                registry,
                explicit_selection,
                None,
                multilayer.fft.as_ref(),
            ),
            BackendPlanIR::Fem(fem) => resolve_fem_engine_with_registry(
                problem,
                registry,
                explicit_selection,
                Some(fem),
                preview_enabled,
            ),
            BackendPlanIR::FemEigen(fem) => {
                match crate::fem::eigen_execution_resolution::resolve_planned_fem_eigen_execution(
                    plan, fem,
                )? {
                    Some(execution) => {
                        planned_fem_eigen_dispatch_resolution(execution, Some(registry))
                    }
                    None => resolve_fem_engine_with_registry(
                        problem,
                        registry,
                        explicit_selection,
                        None,
                        false,
                    ),
                }
            }
            BackendPlanIR::FemFrequencyResponse(_) => {
                resolve_fem_engine_with_registry(problem, registry, explicit_selection, None, false)
            }
        },
        None => match &plan.backend_plan {
            BackendPlanIR::Fdm(fdm) => {
                let resolution = resolve_fdm_engine_for_plan_with_trail(problem, fdm)?;
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
            BackendPlanIR::FdmMultilayer(_) => {
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
            BackendPlanIR::FemEigen(fem) => {
                let execution = resolve_planned_fem_eigen_execution(problem, plan, fem)?;
                if execution.resolution().is_some() {
                    planned_fem_eigen_dispatch_resolution(execution, None)
                } else {
                    let engine = match execution.lane() {
                        FemEigenExecutionLane::Cpu => FemEngine::CpuNative,
                        FemEigenExecutionLane::Gpu => FemEngine::NativeGpu,
                    };
                    Ok(DispatchEngineResolution {
                        engine: DispatchEngine::Fem(engine),
                        fallback: None,
                        runtime_family: None,
                        worker: None,
                        resolved_backend: "fem".to_string(),
                        resolved_device: match execution.lane() {
                            FemEigenExecutionLane::Gpu => "gpu".to_string(),
                            FemEigenExecutionLane::Cpu => "cpu".to_string(),
                        },
                        resolved_precision: runtime_precision(problem).to_string(),
                        fem_crossover_decision: None,
                    })
                }
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
    reject_frozen_spins_fem_execution(problem)?;
    reject_frozen_spins_fem_plan_execution(plan)?;
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
    if backend == "fdm" {
        let gpu = registry.resolve(backend, "gpu", precision);
        let route = crate::fdm::gpu::cuda::route::resolve_fdm_gpu_availability_route(
            if requested_device == "gpu" {
                "cuda"
            } else {
                requested_device
            },
            gpu.is_some(),
        )
        .ok()?;
        return match route {
            crate::fdm::gpu::cuda::route::FdmGpuAvailabilityRoute::CpuRequested => registry
                .resolve(backend, "cpu", precision)
                .map(|resolved| RegistryRuntimeMatch {
                    runtime_family: resolved.runtime_family,
                    worker: resolved.worker,
                    device: "cpu".to_string(),
                    fallback: None,
                }),
            crate::fdm::gpu::cuda::route::FdmGpuAvailabilityRoute::Cuda => {
                gpu.map(|resolved| RegistryRuntimeMatch {
                    runtime_family: resolved.runtime_family,
                    worker: resolved.worker,
                    device: "gpu".to_string(),
                    fallback: None,
                })
            }
            crate::fdm::gpu::cuda::route::FdmGpuAvailabilityRoute::CpuAutoFallback { reason } => {
                registry.resolve(backend, "cpu", precision).map(|resolved| {
                    let (original_engine, fallback_engine) =
                        registry_gpu_to_cpu_fallback_engine_ids(backend);
                    RegistryRuntimeMatch {
                        runtime_family: resolved.runtime_family,
                        worker: resolved.worker,
                        device: "cpu".to_string(),
                        fallback: Some(runtime_fallback(
                            original_engine,
                            fallback_engine,
                            reason,
                            "preferred FDM GPU runtime is unavailable; using CPU runtime"
                                .to_string(),
                        )),
                    }
                })
            }
        };
    }
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
        None,
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
        None,
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
    physics_execution_context: Option<
        &crate::physics_graph_execution::PhysicsGraphExecutionContext,
    >,
    execution_mode: ExecutionMode,
) -> Result<ExecutedRun, RunError> {
    #[cfg(not(feature = "fem-gpu"))]
    let _ = physics_execution_context;
    let mut normalized_plan = normalized_fem_plan_for_runtime(plan)?;
    reject_frozen_spins_fem_plan_execution(&normalized_plan)?;
    reject_unsupported_steady_transport_component_outputs(&normalized_plan, outputs)?;
    #[cfg(feature = "fem-gpu")]
    let transport_artifact_writer = artifact_writer.clone();
    #[cfg(feature = "fem-gpu")]
    let stage_oersted_callback_requested =
        crate::native_fem::plan_requests_stage_oersted_callback(&normalized_plan);
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
    #[cfg(feature = "fem-gpu")]
    if let Some(field) = transport_bundle
        .as_ref()
        .and_then(|bundle| bundle.oersted_field_xyz.as_ref())
    {
        if stage_oersted_callback_requested {
            if normalized_plan.has_oersted_cylinder
                || normalized_plan
                    .oersted_field_xyz
                    .as_ref()
                    .is_some_and(|existing| !existing.is_empty())
            {
                return Err(RunError {
                    message: "FEM stage-coupled solved-current Oersted cannot be combined with a static or analytical Oersted field".into(),
                });
            }
            // The transport bundle remains an artifact/provenance source. The
            // native backend receives the stage-dependent field through the
            // callback installed immediately after backend creation.
        } else {
            if normalized_plan.has_oersted_cylinder {
                return Err(RunError {
                    message: "FEM solved-current Oersted cannot be combined with an analytical cylinder in the bounded runtime".into(),
                });
            }
            if let Some(existing) = normalized_plan.oersted_field_xyz.as_mut() {
                if existing.len() != field.len() {
                    return Err(RunError {
                        message: "FEM solved-current Oersted field length conflicts with the planned field".into(),
                    });
                }
                for (planned, solved) in existing.iter_mut().zip(field) {
                    *planned += *solved;
                }
            } else {
                normalized_plan.oersted_field_xyz = Some(field.clone());
            }
            if normalized_plan.oersted_realization.is_none() {
                return Err(RunError {
                    message: "FEM solved-current transport returned a field without a resolved Oersted realization".into(),
                });
            }
        }
    }
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
        if let Some(context) = physics_execution_context {
            context.observe_steady_transport(&mut executed.provenance);
        }
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
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    // Route Path k-sampling through the multi-k orchestrator, which calls
    // the single-k solver for each sample point and then performs branch
    // tracking and writes V2 artifacts.
    let mut executed = if let Some(executed) = {
        #[cfg(test)]
        {
            take_test_fem_eigen_execution("execute_fem_eigen", execution, plan)
        }
        #[cfg(not(test))]
        {
            None
        }
    } {
        executed
    } else if matches!(plan.k_sampling, Some(fullmag_ir::KSamplingIR::Path { .. })) {
        crate::fem::execute_fem_eigen_path(execution, plan, outputs)?
    } else if execution.resolution().is_some() {
        fem_eigen::execute_planned_fem_eigen(execution, plan, outputs)?
    } else {
        match execution.lane() {
            FemEigenExecutionLane::Cpu => fem_eigen::execute_cpu_fem_eigen(plan, outputs)?,
            FemEigenExecutionLane::Gpu => {
                // GPU-accelerated dense eigensolver (Etap A4) — TRANSITIONAL.
                // `execute_gpu_fem_eigen` uses cuSolverDN; returns error if GPU
                // is unavailable (no silent fallback to CPU).
                fem_eigen::execute_gpu_fem_eigen(plan, outputs, None)?
            }
        }
    };
    execution.bind_execution_provenance(&mut executed.provenance);
    Ok(executed)
}

pub(crate) fn execute_fem_eigen_with_progress(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut fem_eigen::FemEigenProgressCallback<'_>,
) -> Result<ExecutedRun, RunError> {
    let mut executed = if let Some(executed) = {
        #[cfg(test)]
        {
            take_test_fem_eigen_execution("execute_fem_eigen_with_progress", execution, plan)
        }
        #[cfg(not(test))]
        {
            None
        }
    } {
        executed
    } else if matches!(plan.k_sampling, Some(fullmag_ir::KSamplingIR::Path { .. })) {
        crate::fem::execute_fem_eigen_path(execution, plan, outputs)?
    } else if execution.resolution().is_some() {
        fem_eigen::execute_planned_fem_eigen_with_progress(execution, plan, outputs, progress)?
    } else {
        match execution.lane() {
            FemEigenExecutionLane::Cpu => {
                fem_eigen::execute_cpu_fem_eigen_with_progress(plan, outputs, progress)?
            }
            FemEigenExecutionLane::Gpu => {
                fem_eigen::execute_gpu_fem_eigen(plan, outputs, Some(progress))?
            }
        }
    };
    execution.bind_execution_provenance(&mut executed.provenance);
    Ok(executed)
}

pub(crate) fn execute_fem_eigen_with_progress_and_stage_handoff(
    execution: PlannedFemEigenExecution<'_>,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    progress: &mut fem_eigen::FemEigenProgressCallback<'_>,
    handoff: &fem_eigen::AcceptedFemRelaxStageHandoff,
) -> Result<ExecutedRun, RunError> {
    if matches!(plan.k_sampling, Some(fullmag_ir::KSamplingIR::Path { .. })) {
        return Err(RunError {
            message: "relax_stage_handoff_requires_single_k_target".to_string(),
        });
    }
    let mut executed = if let Some(executed) = {
        #[cfg(test)]
        {
            take_test_fem_eigen_execution(
                "execute_fem_eigen_with_progress_and_stage_handoff",
                execution,
                plan,
            )
        }
        #[cfg(not(test))]
        {
            None
        }
    } {
        executed
    } else if execution.resolution().is_some() {
        fem_eigen::execute_planned_fem_eigen_with_progress_and_stage_handoff(
            execution, plan, outputs, progress, handoff,
        )?
    } else {
        match execution.lane() {
            FemEigenExecutionLane::Cpu => {
                fem_eigen::execute_cpu_fem_eigen_with_progress_and_stage_handoff(
                    plan, outputs, progress, handoff,
                )?
            }
            FemEigenExecutionLane::Gpu => {
                fem_eigen::execute_gpu_fem_eigen_with_progress_and_stage_handoff(
                    plan,
                    outputs,
                    Some(progress),
                    handoff,
                )?
            }
        }
    };
    execution.bind_execution_provenance(&mut executed.provenance);
    Ok(executed)
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
fn validate_strict_native_fem_gpu_execution_mode(
    engine: FemEngine,
    execution_mode: ExecutionMode,
    native_execution_mode: &str,
) -> Result<(), RunError> {
    if execution_mode == ExecutionMode::Strict
        && engine == FemEngine::NativeGpu
        && native_execution_mode != "all_in_gpu_legacy_sparse"
    {
        return Err(RunError {
            message: format!(
                "strict native FEM GPU preflight rejected a non-device-resident plan \
                 (native_execution_mode={}, \
                 preflight_reason=fem_gpu_strict_preflight_device_residency_unmet)",
                native_execution_mode,
            ),
        });
    }
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn create_native_fem_backend_after_strict_gpu_mode_preflight<T>(
    engine: FemEngine,
    execution_mode: ExecutionMode,
    native_execution_mode: &str,
    create_backend: impl FnOnce() -> Result<T, RunError>,
) -> Result<T, RunError> {
    validate_strict_native_fem_gpu_execution_mode(engine, execution_mode, native_execution_mode)?;
    create_backend()
}

#[cfg(feature = "fem-gpu")]
fn validate_strict_native_fem_gpu_preflight(
    engine: FemEngine,
    execution_mode: ExecutionMode,
    native_execution_mode: &str,
    plan: &FemPlanIR,
    gpu_rk_plan: &NativeFemGpuRkPlanInfo,
) -> Result<(), RunError> {
    validate_strict_native_fem_gpu_execution_mode(engine, execution_mode, native_execution_mode)?;
    if execution_mode != ExecutionMode::Strict || engine != FemEngine::NativeGpu {
        return Ok(());
    }
    if native_fem_gpu_rk_plan_is_device_resident_for_plan(plan, gpu_rk_plan) {
        return Ok(());
    }

    Err(RunError {
        message: format!(
            "strict native FEM GPU preflight rejected a non-device-resident plan \
             (native_execution_mode={}, gpu_rk_exchange_only_enabled={}, \
             stage_exchange_device_resident={}, fem_exchange_operator_mode={}, \
             uses_gpu_poisson={}, fem_demag_operator_mode={}, hypre_execution_policy={}, \
             demag_residency={}, gpu_rk_block_reason={}, \
             preflight_reason=fem_gpu_strict_preflight_device_residency_unmet)",
            native_execution_mode,
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
    })
}

#[cfg(feature = "fem-gpu")]
fn strict_native_fem_gpu_stage_preflight(
    engine: FemEngine,
    execution_mode: ExecutionMode,
    native_execution_mode: &str,
    plan: &FemPlanIR,
    gpu_rk_plan: &NativeFemGpuRkPlanInfo,
    validate_native_plan: impl FnOnce() -> Result<(), RunError>,
) -> Result<(), RunError> {
    validate_strict_native_fem_gpu_preflight(
        engine,
        execution_mode,
        native_execution_mode,
        plan,
        gpu_rk_plan,
    )?;
    if execution_mode == ExecutionMode::Strict && engine == FemEngine::NativeGpu {
        validate_native_plan()?;
    }
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn begin_native_fem_stage_after_strict_gpu_preflight(
    preflight: Result<(), RunError>,
    begin_stage: impl FnOnce() -> Result<(), RunError>,
) -> Result<(), RunError> {
    preflight?;
    begin_stage()
}

#[cfg(feature = "fem-gpu")]
fn native_fem_gpu_rk_plan_is_strict_device_resident(gpu_rk_plan: &NativeFemGpuRkPlanInfo) -> bool {
    gpu_rk_plan.exchange_only_enabled
        && gpu_rk_plan.stage_exchange_device_resident
        && gpu_rk_plan.uses_gpu_poisson
        && matches!(
            gpu_rk_plan.demag_operator_mode.as_str(),
            "device_hypre_poisson" | "device_hypre_fem_bem"
        )
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
            && matches!(
                gpu_rk_plan.demag_operator_mode.as_str(),
                "device_hypre_poisson" | "device_hypre_fem_bem"
            )
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
    let stage_transport_callback_requested =
        crate::native_fem::plan_requests_stage_transport_callback(plan);
    let coupled_stage_provider = crate::native_fem::StageM2CoupledProvider::from_plan(plan)?;
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

    let native_execution_mode = native_fem_execution_mode(plan);
    let mut backend = create_native_fem_backend_after_strict_gpu_mode_preflight(
        engine,
        execution_mode,
        native_execution_mode,
        || NativeFemBackend::create_with_initial_effective_field(plan, needs_initial_snapshot),
    )?;
    if engine == FemEngine::NativeGpu {
        backend.set_gpu_execution_request(execution_mode == ExecutionMode::Strict)?;
    }
    let gpu_rk_plan_info = backend.gpu_rk_plan_info()?;
    if let Some(provider) =
        StageOerstedProvider::from_plan_with_coupled(plan, coupled_stage_provider.clone())?
    {
        if engine != FemEngine::CpuNative {
            return Err(RunError {
                message: "native FEM stage Oersted callback is qualified only on the CPU lane; refusing GPU fallback".into(),
            });
        }
        backend.install_stage_oersted_provider(Box::new(provider))?;
    }
    if let Some(provider) = crate::native_fem::StageTransportProvider::from_plan_with_coupled(
        plan,
        coupled_stage_provider,
    )? {
        if engine != FemEngine::CpuNative {
            return Err(RunError {
                message: "native FEM stage transport callback is qualified only on the CPU lane; refusing GPU fallback".into(),
            });
        }
        backend.install_stage_transport_provider(Box::new(provider))?;
    } else if stage_transport_callback_requested {
        return Err(RunError {
            message: "FEM stage transport callback was requested by the planner but no provider could be materialized".into(),
        });
    }
    let strict_gpu_preflight = strict_native_fem_gpu_stage_preflight(
        engine,
        execution_mode,
        native_execution_mode,
        plan,
        &gpu_rk_plan_info,
        || backend.validate_strict_gpu_rk_plan(),
    );
    begin_native_fem_stage_after_strict_gpu_preflight(strict_gpu_preflight, || {
        backend.begin_stage(plan.time_stage.start_time_s)
    })?;
    let device_info = backend.device_info()?;
    let gpu_state_info = backend.gpu_state_info()?;
    validate_native_fem_gpu_engine_runtime_contract(engine, &gpu_rk_plan_info)?;
    let execution_engine = native_fem_execution_engine(plan);
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
        executed_physics_kinds: if crate::fem::relax::algorithm::native_step_control(
            plan.relaxation.as_ref(),
        )
        .is_none()
            && plan.spin_torque_contract.is_some()
        {
            vec!["spin_torque".to_string()]
        } else {
            Vec::new()
        },
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
    apply_fem_direct_minimizer_policy_provenance(
        &mut provenance,
        plan.relaxation.as_ref(),
        execution_engine == "fem_native_gpu",
    );
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

    let requires_gpu_rk_execution_receipt = native_relaxation_step.is_none();
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
            fem_gpu_receipt_request: requires_gpu_rk_execution_receipt.then(|| {
                if execution_mode == ExecutionMode::Strict {
                    "strict_device".to_string()
                } else if native_execution_mode == "hybrid_legacy_sparse" {
                    "hybrid".to_string()
                } else {
                    "gpu".to_string()
                }
            }),
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

#[cfg(feature = "fem-gpu")]
pub(crate) fn flatten_vectors(values: &[[f64; 3]]) -> Vec<f64> {
    values
        .iter()
        .flat_map(|vector| vector.iter().copied())
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::fem::test_support::*;
    use crate::solvers::fdm::interactions::capabilities::unsupported_cpu_fdm_terms;

    use super::*;

    #[test]
    fn eigen_path_handoff_identity_binds_root_and_matching_sample_diagnostics() {
        let mut diagnostics = serde_json::json!({
            "solver_adapter": "k0_poisson_airbox_cpu_schur_slepc",
            "sample_solver_diagnostics": [
                {"sample_index": 0, "diagnostics": {"solver": "first"}},
                {"sample_index": 1, "diagnostics": {"solver": "second"}}
            ]
        });

        bind_eigen_path_handoff_diagnostics(
            &mut diagnostics,
            0,
            "sha256:handoff",
            "sha256:topology",
        );

        assert_eq!(
            diagnostics["relax_to_eigen_handoff_sha256"],
            "sha256:handoff"
        );
        assert_eq!(
            diagnostics["source_mesh_topology_sha256"],
            "sha256:topology"
        );
        assert_eq!(
            diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
                ["relax_to_eigen_handoff_sha256"],
            "sha256:handoff"
        );
        assert_eq!(
            diagnostics["sample_solver_diagnostics"][0]["diagnostics"]
                ["source_mesh_topology_sha256"],
            "sha256:topology"
        );
        assert!(diagnostics["sample_solver_diagnostics"][1]["diagnostics"]
            .get("relax_to_eigen_handoff_sha256")
            .is_none());
    }

    #[test]
    fn managed_component_participation_transport_round_trips_and_defaults_typed_unavailable() {
        let expected =
            crate::eigen::ModalParticipationObservable::unavailable_without_context("gpu");
        let value = serde_json::to_value(&expected).expect("observable must serialize");

        let parsed = eigen_path_component_participation_from_json(Some(&value), "gpu")
            .expect("managed observable must deserialize");
        assert_eq!(parsed, expected);

        let missing = eigen_path_component_participation_from_json(None, "cpu")
            .expect("missing managed context must remain a typed unavailable result");
        assert_eq!(
            missing.status,
            crate::eigen::ModalParticipationAvailability::Unavailable
        );
    }
    use crate::eigen::EigenSolverModel;
    use crate::types::AuxiliaryArtifact;
    use fullmag_ir::{
        AntennaIR, BackendTarget, ChargePotentialGaugeIR, ChargeSolverPolicyIR, CurrentModuleIR,
        CurrentTransportModelIR, DiscretizationHintsIR, ExecutionDevice, ExecutionMode,
        ExecutionPrecision, FdmHintsIR, FemHintsIR, FemMeshPartIR, FemMeshPartRole,
        FemMeshPartSelector, FemObjectSegmentIR, FemPlanIR, LinearTransportSolverPolicyIR, MeshIR,
        ProblemIR, RequestedTransportExecutionIR, ResolvedFdmGpuChargeTransportIR, RfDriveIR,
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

    #[test]
    fn fdm_fft_explicit_backend_constrains_auto_device_selection() {
        let rustfft = FdmFftPlanIR {
            requested_backend: "rustfft".to_string(),
        };
        let cufft = FdmFftPlanIR {
            requested_backend: "cufft".to_string(),
        };

        assert_eq!(
            constrain_fdm_device_for_fft("auto".to_string(), Some(&rustfft))
                .expect("RustFFT should select CPU"),
            "cpu"
        );
        assert_eq!(
            constrain_fdm_device_for_fft("auto".to_string(), Some(&cufft))
                .expect("cuFFT should select GPU"),
            "gpu"
        );
    }

    #[test]
    fn fdm_fft_explicit_backend_rejects_incompatible_runtime_device() {
        for (backend, device) in [("rustfft", "gpu"), ("cufft", "cpu")] {
            let fft = FdmFftPlanIR {
                requested_backend: backend.to_string(),
            };
            let error = constrain_fdm_device_for_fft(device.to_string(), Some(&fft))
                .expect_err("runtime device mismatch must fail closed");

            assert!(error
                .message
                .contains(&format!("fdm.demag.fft_backend='{backend}'")));
        }
    }

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

    fn legacy_fem_eigen_execution(engine: FemEngine) -> PlannedFemEigenExecution<'static> {
        PlannedFemEigenExecution::legacy(match engine {
            FemEngine::CpuNative => FemEigenExecutionLane::Cpu,
            FemEngine::NativeGpu => FemEigenExecutionLane::Gpu,
        })
    }

    fn public_gpu_m1_dispatch_plan() -> FdmPlanIR {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/standard_problems/transport/racetrack_m1_v1/fixture.v1.json"
        ))
        .expect("racetrack fixture must be valid JSON");
        let lowering = fixture
            .get("normalized_problem_ir_contract")
            .and_then(|value| value.get("expected_lowering"))
            .expect("racetrack fixture lowering");
        let mut problem: ProblemIR =
            serde_json::from_value(lowering.clone()).expect("fixture ProblemIR");
        problem.backend_policy.requested_backend = BackendTarget::Fdm;
        problem.backend_policy.execution_precision = ExecutionPrecision::Double;
        problem.validation_profile.execution_mode = ExecutionMode::Strict;
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".into(),
            serde_json::json!({
                "backend": "fdm",
                "device": "gpu",
                "gpu_count": 1,
                "device_index": 0,
                "cpu_threads": null,
                "execution_mode": "strict",
                "execution_precision": "double"
            }),
        );
        let module = &mut problem.spin_transport_modules[0];
        module.requested_execution.discretization = BackendTarget::Fdm;
        module.requested_execution.device = ExecutionDevice::Gpu;
        module.requested_execution.precision = ExecutionPrecision::Double;
        module.requested_execution.execution_mode = ExecutionMode::Strict;
        module.solver.engine = "native_m1_v1".into();
        match fullmag_plan::plan(&problem)
            .expect("public GPU M1 fixture must plan")
            .backend_plan
        {
            fullmag_ir::BackendPlanIR::Fdm(plan) => plan,
            other => panic!("expected FDM plan, got {other:?}"),
        }
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn public_gpu_m1_dispatch_executes_one_coupled_transport_llg_step() {
        let plan = public_gpu_m1_dispatch_plan();
        let expected_module_id = plan.spin_transport_plans[0].module_id.clone();
        let expected_current_source_id = plan.spin_transport_plans[0].current_source_id.clone();
        let executed = execute_fdm(FdmEngine::CudaFdm, &plan, 1.0e-13, &[], None, None)
            .expect("public GPU M1 plan must execute solved charge/spin torque in LLG");
        assert_eq!(executed.result.steps.len(), 1);
        assert_eq!(executed.result.steps[0].step, 1);
        assert_eq!(executed.provenance.execution_engine, "cuda_fdm");
        assert_eq!(executed.provenance.transport_modules.len(), 1);
        let transport = &executed.provenance.transport_modules[0];
        assert_eq!(transport.module_id, expected_module_id);
        assert_eq!(transport.current_source_id, expected_current_source_id);
        assert_eq!(transport.requested_discretization, "fdm");
        assert_eq!(transport.requested_device, "gpu");
        assert_eq!(transport.requested_precision, "double");
        assert_eq!(transport.requested_execution_mode, "strict");
        assert_eq!(transport.resolved_discretization, "fdm");
        assert_eq!(transport.resolved_device, "gpu");
        assert_eq!(transport.resolved_precision, "double");
        assert_eq!(transport.resolved_execution_mode, "strict");
        assert_eq!(transport.runtime_family, "fullmag_fdm_cuda_transport");
        assert_eq!(transport.runtime_id, "fdm_cuda_transport_m1_v1");
        assert_eq!(transport.engine_id, "native_m1_v1");
        assert_eq!(transport.stage_coupling, "one_way_stage_refresh");
        assert_eq!(transport.implementation_state, "executable");
    }

    #[test]
    fn public_gpu_m1_dispatch_rejects_non_cuda_and_missing_descriptor() {
        let plan = public_gpu_m1_dispatch_plan();
        let error = execute_fdm(FdmEngine::CpuReference, &plan, 0.0, &[], None, None)
            .expect_err("GPU M1 must reject hidden CPU fallback");
        assert!(error.message.contains("non-CUDA engine"));
        assert!(error.message.contains("hidden fallback is forbidden"));

        let mut malformed = plan;
        malformed.spin_transport_plans[0].fdm_gpu_double = None;
        let error = execute_fdm(FdmEngine::CudaFdm, &malformed, 0.0, &[], None, None)
            .expect_err("GPU intent without descriptor must fail closed");
        assert!(error
            .message
            .contains("exactly one fdm_gpu_double descriptor"));
        assert!(error.message.contains("partial execution are forbidden"));
    }

    #[test]
    fn k_path_remap_preserves_sample_scoped_v7_equilibrium_sidecars() {
        let artifacts = vec![
            AuxiliaryArtifact {
                relative_path: "eigen/metadata/equilibrium_artifact.v7.json".to_string(),
                bytes: br#"{"schema_version":"equilibrium_artifact.v7"}"#.to_vec(),
            },
            AuxiliaryArtifact {
                relative_path: "eigen/metadata/linearization_state.v6.json".to_string(),
                bytes: br#"{"schema_version":"LinearizationState.v6"}"#.to_vec(),
            },
        ];
        let remapped =
            remap_single_k_mode_artifacts(&artifacts, 3, &std::collections::BTreeSet::from([0]))
                .expect("state sidecars should remap");
        let paths = remapped
            .iter()
            .map(|artifact| artifact.relative_path.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                "eigen/metadata/sample_0003/equilibrium_artifact.v7.json",
                "eigen/metadata/sample_0003/linearization_state.v6.json",
            ]
        );
        assert_eq!(
            eigen_path_state_metadata_paths(&remapped, "equilibrium_artifact.v7.json"),
            vec!["eigen/metadata/sample_0003/equilibrium_artifact.v7.json"]
        );
    }

    #[test]
    fn k0_multi_sample_path_is_not_classified_as_dispersion() {
        let solver_model = EigenSolverModel::ReferenceScalarTangent;
        let result = crate::eigen::PathSolveResult {
            samples: (0..3)
                .map(|sample_index| crate::eigen::SingleKSolveResult {
                    sample: crate::eigen::KSampleDescriptor {
                        sample_index,
                        label: Some(format!("H{sample_index}")),
                        segment_index: None,
                        path_s: sample_index as f64,
                        t_in_segment: sample_index as f64 / 2.0,
                        k_vector: [0.0, 0.0, 0.0],
                    },
                    modes: Vec::new(),
                    relaxation_steps: 0,
                    solver_model,
                    solver_notes: Vec::new(),
                    solver_diagnostics: None,
                })
                .collect(),
            branches: Vec::new(),
            solver_model,
            notes: vec!["bias-field sweep".to_string()],
            include_demag: true,
            dispersion_validation: None,
            k0_kittel_validation: None,
            dispersion_analytic_reference: None,
            k0_kittel_periodic_airbox_demag: None,
        };

        assert_eq!(eigen_path_calculation_mode(&result), "free_modes");
    }

    #[test]
    fn cpu_fdm_capability_rejects_oersted_cylinder() {
        let mut plan = fullmag_ir::FdmPlanIR::default();
        plan.has_oersted_cylinder = true;

        assert_eq!(unsupported_cpu_fdm_terms(&plan, &[]), vec!["oersted"]);
    }

    #[test]
    fn cpu_fdm_capability_rejects_public_gpu_charge_transport() {
        let mut plan = fullmag_ir::FdmPlanIR::default();
        plan.fdm_gpu_charge_transports = vec![ResolvedFdmGpuChargeTransportIR {
            descriptor_schema: "fdm_gpu_charge_transport.v1".into(),
            descriptor_revision: 1,
            source_revision: 1,
            implementation_version: "fdm_gpu_charge_transport_v1".into(),
            validation_state: "semantic_only".into(),
            descriptor_sha256: "test".into(),
            module_id: "charge".into(),
            requested_execution: RequestedTransportExecutionIR {
                discretization: BackendTarget::Fdm,
                device: ExecutionDevice::Gpu,
                precision: ExecutionPrecision::Double,
                execution_mode: ExecutionMode::Strict,
            },
            resolved_discretization: BackendTarget::Fdm,
            resolved_device: ExecutionDevice::Gpu,
            resolved_precision: ExecutionPrecision::Double,
            resolved_execution_mode: ExecutionMode::Strict,
            capabilities: vec![],
            charge_active_cells: vec![],
            charge_conductivity_spm: vec![],
            charge_boundaries: vec![],
            charge_gauge: ChargePotentialGaugeIR::DirichletReference,
            charge_solver: ChargeSolverPolicyIR {
                engine: "cg".into(),
                linear: LinearTransportSolverPolicyIR {
                    relative_tolerance: 1.0e-10,
                    absolute_tolerance: 0.0,
                    max_iterations: 1000,
                },
                physical_residual_version: "charge_balance_integrated_l2.v1".into(),
                operator_version: "fv_charge_harmonic_v1".into(),
            },
            region_ids: vec![],
        }];

        assert_eq!(
            unsupported_cpu_fdm_terms(&plan, &[]),
            vec!["gpu_charge_transport"]
        );
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
        let source = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fdm/gpu/cuda/artifacts.rs"
        ))
        .expect("CUDA artifacts helper should be readable");

        assert!(
            source.contains("pub(crate) fn copy_cuda_field_snapshot("),
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
                .find(&format!("pub(crate) fn {function_name}("))
                .unwrap_or_else(|| panic!("{function_name} should exist"));
            let body_end = source[body_start + 1..]
                .find("\npub(crate) fn ")
                .map(|offset| body_start + 1 + offset)
                .unwrap_or(source.len());
            let body = &source[body_start..body_end];
            assert!(
                body.contains("copy_cuda_field_snapshot(backend, &name, cell_count)?"),
                "{function_name} should use the shared native CUDA field copy helper"
            );
        }
    }

    #[test]
    fn native_cuda_scalar_output_boundary_reduces_m_before_recording() {
        let artifacts = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fdm/gpu/cuda/artifacts.rs"
        ))
        .expect("CUDA artifacts helper should be readable");
        let execute = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fdm/gpu/cuda/execute.rs"
        ))
        .expect("CUDA execute module should be readable");

        let body_start = artifacts
            .find("pub(crate) fn record_cuda_due_outputs(")
            .expect("record_cuda_due_outputs should exist");
        let body_end = artifacts[body_start + 1..]
            .find("\npub(crate) fn record_cuda_final_outputs(")
            .map(|offset| body_start + 1 + offset)
            .expect("record_cuda_due_outputs body should be bounded");
        let body = &artifacts[body_start..body_end];
        assert!(
            body.contains("apply_average_m_to_step_stats"),
            "native CUDA scalar rows must publish averaged magnetization components"
        );

        let final_output_body = &artifacts[body_end..];
        assert!(
            final_output_body.contains("backend.apply_average_m_to_step_stats(&mut final_stats)?")
                && final_output_body.contains("artifacts.record_scalar(&final_stats)?"),
            "native CUDA final scalar rows must reduce M before recording"
        );

        let execution_start = execute
            .find("pub(crate) fn execute_cuda_fdm(")
            .expect("active CUDA execution body should be present");
        let execution = &execute[execution_start..];
        assert!(
            execution.contains("let heavy_payload_due = stats.step % heavy_payload_every == 0;")
                && execution.contains("if heavy_payload_due && !due_scalar_row")
                && execution.contains("let magnetization = if heavy_payload_due"),
            "native CUDA live rows carrying a full magnetization payload must use the averaged stats"
        );
        assert!(
            execution.contains("let final_magnetization = backend.copy_m(cell_count)?;")
                && execution.contains("record_cuda_final_outputs("),
            "native CUDA final publication must share the final magnetization snapshot"
        );
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn inactive_cuda_transport_drops_transport_field_schedules() {
        let outputs = vec![
            OutputIR::Field {
                name: "V_electric".into(),
                every_seconds: 1.0,
            },
            OutputIR::Field {
                name: "torque_stt".into(),
                every_seconds: 1.0,
            },
            OutputIR::Field {
                name: "m".into(),
                every_seconds: 1.0,
            },
        ];
        let (transport, magnetic) =
            partition_cuda_field_schedules(&outputs, false).expect("schedules should parse");
        assert!(transport.is_empty());
        assert_eq!(magnetic.len(), 1);
        assert_eq!(magnetic[0].name, "m");

        let (transport, magnetic) =
            partition_cuda_field_schedules(&outputs, true).expect("schedules should parse");
        assert_eq!(transport.len(), 2);
        assert_eq!(magnetic.len(), 1);
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
                && native_fem.contains("QuantityId::HDmi => Self::HDmi")
                && native_fem.contains("QuantityId::HDmiBulk => Self::HDmiBulk")
                && native_fem.contains("NativeFemPreviewObservable::HDmi => {")
                && native_fem.contains("FULLMAG_FEM_OBSERVABLE_H_DMI")
                && native_fem.contains("NativeFemPreviewObservable::HDmiBulk => {")
                && native_fem.contains("FULLMAG_FEM_OBSERVABLE_H_DMI_BULK"),
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
            time_envelope: None,
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
                projection_policy: None,
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
            frozen_spins: None,
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
            sot_current_density: None,
            sot_xi_dl: None,
            sot_xi_fl: None,
            sot_sigma: None,
            sot_thickness: None,
            sot_envelope: None,
            sot_drive: None,
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
            bias_field_samples: Vec::new(),
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
    fn strict_native_gpu_preflight_rejects_before_lifecycle_mutation() {
        #[derive(Default)]
        struct RecordingLifecycle {
            backend_creation: u8,
            native_plan_preflight: u8,
            begin_stage: u8,
            step: u8,
            receipt: u8,
            provenance: u8,
        }

        let mut plan = tiny_fem_plan();
        plan.mfem_device_string = Some("cuda".to_string());
        let mut incomplete = gpu_rk_ready_plan_for_log_test();
        incomplete.stage_exchange_device_resident = false;
        incomplete.reason = "stage H_ex is not device-resident".to_string();

        let mut rejected_lifecycle = RecordingLifecycle::default();
        let incomplete_preflight = strict_native_fem_gpu_stage_preflight(
            FemEngine::NativeGpu,
            ExecutionMode::Strict,
            "all_in_gpu_legacy_sparse",
            &plan,
            &incomplete,
            || {
                rejected_lifecycle.native_plan_preflight += 1;
                Ok(())
            },
        );
        let incomplete_err =
            begin_native_fem_stage_after_strict_gpu_preflight(incomplete_preflight, || {
                rejected_lifecycle.begin_stage += 1;
                rejected_lifecycle.step += 1;
                rejected_lifecycle.receipt += 1;
                rejected_lifecycle.provenance += 1;
                Ok(())
            })
            .expect_err("strict native GPU must reject an incomplete device-resident plan");
        assert!(incomplete_err
            .message
            .contains("preflight_reason=fem_gpu_strict_preflight_device_residency_unmet"));
        assert!(incomplete_err
            .message
            .contains("stage_exchange_device_resident=false"));
        assert_eq!(rejected_lifecycle.native_plan_preflight, 0);
        assert_eq!(rejected_lifecycle.begin_stage, 0);
        assert_eq!(rejected_lifecycle.step, 0);
        assert_eq!(rejected_lifecycle.receipt, 0);
        assert_eq!(rejected_lifecycle.provenance, 0);

        let mut hybrid_lifecycle = RecordingLifecycle::default();
        let hybrid_err = create_native_fem_backend_after_strict_gpu_mode_preflight(
            FemEngine::NativeGpu,
            ExecutionMode::Strict,
            "hybrid_legacy_sparse",
            || {
                hybrid_lifecycle.backend_creation += 1;
                hybrid_lifecycle.begin_stage += 1;
                hybrid_lifecycle.step += 1;
                hybrid_lifecycle.receipt += 1;
                hybrid_lifecycle.provenance += 1;
                Ok(())
            },
        )
        .expect_err("strict native GPU must reject a hybrid runtime plan");
        assert!(hybrid_err
            .message
            .contains("native_execution_mode=hybrid_legacy_sparse"));
        assert_eq!(hybrid_lifecycle.backend_creation, 0);
        assert_eq!(hybrid_lifecycle.begin_stage, 0);
        assert_eq!(hybrid_lifecycle.step, 0);
        assert_eq!(hybrid_lifecycle.receipt, 0);
        assert_eq!(hybrid_lifecycle.provenance, 0);

        assert!(validate_strict_native_fem_gpu_preflight(
            FemEngine::CpuNative,
            ExecutionMode::Strict,
            "cpu_native",
            &plan,
            &incomplete,
        )
        .is_ok());
        assert!(validate_strict_native_fem_gpu_preflight(
            FemEngine::NativeGpu,
            ExecutionMode::Hybrid,
            "hybrid_legacy_sparse",
            &plan,
            &incomplete,
        )
        .is_ok());

        let mut native_rejected_lifecycle = RecordingLifecycle::default();
        let native_plan_preflight = strict_native_fem_gpu_stage_preflight(
            FemEngine::NativeGpu,
            ExecutionMode::Strict,
            "all_in_gpu_legacy_sparse",
            &plan,
            &gpu_rk_ready_plan_for_log_test(),
            || {
                native_rejected_lifecycle.native_plan_preflight += 1;
                Err(RunError {
                    message: "GPU RK strict operator-mask preflight rejected device plan"
                        .to_string(),
                })
            },
        );
        let native_plan_err =
            begin_native_fem_stage_after_strict_gpu_preflight(native_plan_preflight, || {
                native_rejected_lifecycle.begin_stage += 1;
                native_rejected_lifecycle.step += 1;
                native_rejected_lifecycle.receipt += 1;
                native_rejected_lifecycle.provenance += 1;
                Ok(())
            })
            .expect_err("native strict operator-mask preflight must reject before stage lifecycle");
        assert!(native_plan_err
            .message
            .contains("GPU RK strict operator-mask preflight rejected device plan"));
        assert_eq!(native_rejected_lifecycle.native_plan_preflight, 1);
        assert_eq!(native_rejected_lifecycle.begin_stage, 0);
        assert_eq!(native_rejected_lifecycle.step, 0);
        assert_eq!(native_rejected_lifecycle.receipt, 0);
        assert_eq!(native_rejected_lifecycle.provenance, 0);

        let mut accepted_lifecycle = RecordingLifecycle::default();
        let mut exchange_only = gpu_rk_ready_plan_for_log_test();
        exchange_only.uses_gpu_poisson = false;
        exchange_only.demag_operator_mode = "none".to_string();
        exchange_only.hypre_execution_policy = "none".to_string();
        exchange_only.demag_residency = "none".to_string();
        let accepted_preflight = strict_native_fem_gpu_stage_preflight(
            FemEngine::NativeGpu,
            ExecutionMode::Strict,
            "all_in_gpu_legacy_sparse",
            &plan,
            &exchange_only,
            || {
                accepted_lifecycle.native_plan_preflight += 1;
                Ok(())
            },
        );
        assert!(
            begin_native_fem_stage_after_strict_gpu_preflight(accepted_preflight, || {
                accepted_lifecycle.begin_stage += 1;
                Ok(())
            },)
            .is_ok()
        );
        assert_eq!(accepted_lifecycle.native_plan_preflight, 1);
        assert_eq!(accepted_lifecycle.begin_stage, 1);
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
    fn all_in_gpu_request_accepts_device_fem_bem_demag() {
        let _guard = env_lock().lock().expect("env mutex");
        let mut rk_plan = gpu_rk_ready_plan_for_log_test();
        rk_plan.demag_operator_mode = "device_hypre_fem_bem".to_string();
        unsafe {
            std::env::set_var("FULLMAG_FEM_ALL_IN_GPU", "1");
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }

        let result = validate_all_in_gpu_fem_runtime_contract(
            "all_in_gpu_legacy_sparse",
            &rk_plan,
        );

        unsafe {
            std::env::remove_var("FULLMAG_FEM_ALL_IN_GPU");
        }
        result.expect("device-resident Fredkin-Koehler demag must satisfy ALL_IN_GPU");
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

        let err = execute_fem_eigen(legacy_fem_eigen_execution(FemEngine::NativeGpu), &plan, &[])
            .expect_err("GPU modal k-path dispersion must fail explicitly");

        assert!(err.message.contains("GPU modal dispersion"));
        assert!(err.message.contains("KSamplingIR::Path"));
        assert!(err.message.contains("unavailable"));
    }

    #[test]
    fn forced_gpu_k0_kittel_with_demag_fails_closed_without_native_producer() {
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
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e3,
            frequency_max_hz: 25.0e9,
        };
        plan.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(
            fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
        );
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 2,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: None,
        }];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 3.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("dipole".to_string()),
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

        let err = execute_fem_eigen(legacy_fem_eigen_execution(FemEngine::NativeGpu), &plan, &[])
            .expect_err(
                "GPU periodic-airbox K0 must fail closed while the native producer is absent",
            );
        assert!(err
            .message
            .starts_with(fem_eigen::SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON));
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
            legacy_fem_eigen_execution(FemEngine::NativeGpu),
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
        assert_eq!(
            eigen_path_public_mode_indices(&no_dispersion, 2),
            std::collections::BTreeSet::from([0, 1]),
        );

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
            std::collections::BTreeSet::from([0, 1, 2]),
        );
        assert_eq!(
            eigen_path_mode_artifact_indices(&explicit_mode_subset),
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
    fn k_path_gamma_frequency_window_rejects_uncertified_equilibrium_before_native_entrypoint() {
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
            legacy_fem_eigen_execution(FemEngine::CpuNative),
            &plan,
            &[OutputIR::EigenSpectrum {
                quantity: "frequency_hz".to_string(),
            }],
        )
        .expect_err("provided equilibrium without a certified handoff must fail closed");

        assert!(
            err.message.contains("uncertified_provided_equilibrium"),
            "{}",
            err.message
        );
        assert!(
            !err.message.contains("KSamplingIR::Path"),
            "the k-path must reach equilibrium validation without a stale path-routing error: {}",
            err.message
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
                    tangent_leakage_weighted_relative_l2: Some(0.0),
                    dominant_polarization: "linear".to_string(),
                    reduced_vector: None,
                    lifted_real: None,
                    lifted_imag: None,
                    amplitude: None,
                    phase: None,
                    node_mass_weights: Some(vec![2.0, 3.0]),
                    component_participation:
                        crate::eigen::ModalParticipationObservable::unavailable_without_context(
                            "cpu",
                        ),
                }],
                relaxation_steps: 0,
                solver_model: EigenSolverModel::ProductionCpuShiftInvert,
                solver_notes: vec!["production sample".to_string()],
                solver_diagnostics: Some(serde_json::json!({
                    "solver_adapter": "k0_poisson_airbox_cpu_schur_slepc",
                    "slepc": {
                        "converged_eigenpair_count": 7,
                        "accepted_mode_count": 2,
                        "outer_iterations": 19,
                    },
                })),
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
            FemEngine::CpuNative,
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
        assert_eq!(
            diagnostics["sample_solver_diagnostics"][0]["sample_index"],
            0
        );
        assert_eq!(
            diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["slepc"]
                ["converged_eigenpair_count"],
            7
        );
        assert_eq!(
            diagnostics["sample_solver_diagnostics"][0]["diagnostics"]["slepc"]
                ["accepted_mode_count"],
            2
        );
        assert_eq!(diagnostics["converged_eigenpair_count_total"], 7);
        assert_eq!(diagnostics["accepted_mode_count_total"], 2);
        assert!(
            diagnostics.get("subwindows").is_none(),
            "path diagnostics must not fabricate unexecuted subwindows when exact native sample diagnostics are available: {diagnostics}"
        );
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
            path_result.samples[0].solver_diagnostics.as_ref(),
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

        let mut nested_path_result = path_result.clone();
        nested_path_result.samples[0].solver_diagnostics = Some(serde_json::json!({
            "sample_solver_diagnostics": [{
                "sample_index": 0,
                "diagnostics": {
                    "physics_contract_version": "micromagnetics_frequency_domain_v5",
                    "operator_dictionary_version": "FrequencyOperatorDictionary.v1",
                    "implementation_state": "executable",
                    "validation_state": "unvalidated",
                    "validated_scope": "fem_k0_periodic_airbox_p1_double_gpu_device_krylov",
                    "assembly_kind": "mfem_weak_form_shared_domain",
                    "boundary_gauge": {
                        "gauge_policy": "none",
                        "outer_boundary_kind": "poisson_robin"
                    },
                    "spectral": {
                        "spectral_scalar_mode": "real_split",
                        "spectral_transform": "shift_invert"
                    },
                    "requested_execution": {
                        "solver_method": "shift_invert",
                        "preconditioner": "shifted_schur_device",
                        "magnetostatic_bc": "periodic_airbox_k0"
                    },
                    "resolved_execution": {
                        "device": "gpu",
                        "precision": "double",
                        "engine": "gpu_petsc_slepc_cuda",
                        "native_backend": "native_gpu",
                        "solver_library": "SLEPc/PETSc/hypre CUDA",
                        "implementation_id": "k0_poisson_airbox_gpu_petsc_slepc",
                        "operator_residency": "device",
                        "vector_residency": "device",
                        "krylov_residency": "device",
                        "preconditioner_residency": "device",
                        "status": "ok",
                        "fallback_used": false
                    }
                }
            }]
        }));
        let nested_manifest = build_eigen_path_frequency_domain_manifest(
            FemEngine::NativeGpu,
            &nested_path_result,
            &[],
            &plan,
        );
        assert_eq!(
            nested_manifest["requested_execution"]["solver_method"],
            "shift_invert"
        );
        assert_eq!(
            nested_manifest["requested_execution"]["preconditioner"],
            "shifted_schur_device"
        );
        assert_eq!(
            nested_manifest["requested_execution"]["magnetostatic_bc"],
            "periodic_airbox_k0"
        );
        assert_eq!(
            nested_manifest["resolved_execution"]["engine"],
            "gpu_petsc_slepc_cuda"
        );
        assert_eq!(
            nested_manifest["resolved_execution"]["implementation_id"],
            "k0_poisson_airbox_gpu_petsc_slepc"
        );
        assert_eq!(
            nested_manifest["resolved_execution"]["operator_residency"],
            "device"
        );
        assert_eq!(
            nested_manifest["physics_contract_version"],
            "micromagnetics_frequency_domain_v5"
        );
        assert_eq!(nested_manifest["validation_state"], "unvalidated");
        assert!(
            nested_manifest.get("validated_scope").is_none(),
            "unvalidated diagnostics must not publish a validated scope"
        );
        assert_eq!(
            nested_manifest["boundary_gauge"]["outer_boundary_kind"],
            "poisson_robin"
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
    fn gpu_modal_device_contract_rejects_host_projected_ritz_state() {
        let diagnostics = serde_json::json!({
            "gpu_device_resident_modal_eigensolver": true,
            "persistent_solver_context": true,
            "scalable_selected_spectrum": true,
            "host_ritz_extraction": true,
            "validation_only": false,
            "ritz_state_location": "host_small_projected",
            "spectral_pencil_kind": "real_frequency_rotated",
            "target_representation": "tau=omega_target",
        });

        assert!(
            !eigen_path_gpu_modal_device_contract(&diagnostics),
            "host-projected Ritz state must not satisfy the production device modal contract"
        );

        let mut device_resident = diagnostics;
        device_resident["host_ritz_extraction"] = serde_json::json!(false);
        assert!(eigen_path_gpu_modal_device_contract(&device_resident));

        let mut validation_only = device_resident;
        validation_only["validation_only"] = serde_json::json!(true);
        validation_only["production_implication"] = serde_json::json!(false);
        assert!(
            !eigen_path_gpu_modal_device_contract(&validation_only),
            "validation-only GPU diagnostics must not satisfy the production device modal contract"
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
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(
            fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
        );
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 2,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: None,
        }];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 3.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("dipole".to_string()),
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

        let diagnostics = eigen_path_solver_diagnostics(
            FemEngine::CpuNative,
            &plan,
            &path_result,
            &BTreeSet::new(),
        );

        assert_eq!(
            diagnostics["solver_adapter"],
            "multi_k_reference_modal_path"
        );
        assert_eq!(diagnostics["execution_lane"], "reference_cpu");
        assert_eq!(
            diagnostics["resolved_solver_family"],
            "reference_full_2x2_tangent"
        );
        assert_eq!(diagnostics["solver_model"], "reference_full_2x2_tangent");
        assert_eq!(diagnostics["solver_family"], "reference_full_2x2_tangent");
        assert_eq!(diagnostics["production_solver_available"], false);
        assert_eq!(
            diagnostics["production_cpu_rejection_reason"],
            "production_cpu_modal_periodic_airbox_k0_payload_missing"
        );
        assert_eq!(diagnostics["runtime_capability_status"], "unsupported");
        assert_eq!(
            diagnostics["runtime_capability_reason"],
            fem_eigen::SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON
        );
        assert!(diagnostics.get("demag_kind").is_none());
        assert_eq!(diagnostics["gauge_policy"], "mean_zero_augmented");
        assert_eq!(diagnostics["phi_dof_count"], 28);
        assert_eq!(diagnostics["augmented_phi_dof_count"], 45);
        assert_eq!(diagnostics["poisson_constraint_relative_residual"], 1.0e-12);
        assert_eq!(diagnostics["production_solver_available"], false);
        assert!(diagnostics
            .get("production_periodic_airbox_claim")
            .is_none());

        let mut plan_without_oracle = plan.clone();
        plan_without_oracle.k0_kittel_validation = None;
        let mut result_without_oracle = path_result.clone();
        result_without_oracle.k0_kittel_validation = None;
        result_without_oracle.k0_kittel_periodic_airbox_demag = None;
        let diagnostics_without_oracle = eigen_path_solver_diagnostics(
            FemEngine::CpuNative,
            &plan_without_oracle,
            &result_without_oracle,
            &BTreeSet::new(),
        );

        for key in [
            "status",
            "solver_model",
            "solver_family",
            "resolved_solver_family",
            "solver_adapter",
            "execution_lane",
            "production_solver_available",
            "production_periodic_airbox_claim",
        ] {
            assert_eq!(
                diagnostics_without_oracle[key], diagnostics[key],
                "oracle changed resolved solver diagnostic {key}"
            );
        }
    }

    #[test]
    fn k_path_first_single_k_plan_performs_requested_relaxation() {
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

        let point_plan = eigen_path_single_k_point_plan(&plan, &sample, false, None)
            .expect("ordinary k-path point plan should be valid");

        assert_eq!(
            point_plan.equilibrium,
            fullmag_ir::EquilibriumSourceIR::RelaxedInitialState
        );
        assert_eq!(
            point_plan.k_sampling,
            Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0]
            })
        );
    }

    #[test]
    fn k_path_rejects_provided_relaxed_equilibrium_without_handoff_binding() {
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
            sample_index: 1,
            label: Some("G".to_string()),
            segment_index: Some(0),
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: [0.0, 0.0, 0.0],
        };

        let error = eigen_path_single_k_point_plan(&plan, &sample, true, None)
            .expect_err("relaxed equilibrium reuse must require an immutable handoff binding");

        assert!(error.message.contains("missing_relax_to_eigen_handoff"));
    }

    #[test]
    fn zero_relaxation_steps_do_not_fabricate_stage_continuation() {
        let mut plan = tiny_fem_eigen_plan(None);
        plan.equilibrium = fullmag_ir::EquilibriumSourceIR::RelaxedInitialState;

        let source = eigen_path_equilibrium_source_json(&plan, 0);

        assert_eq!(
            source,
            serde_json::json!({"kind": "relaxed_initial_state"}),
            "stage_continuation requires a validated typed handoff, not steps == 0"
        );
    }

    #[test]
    fn k_path_rejects_same_node_count_with_different_topology_handoff() {
        let mut source_plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![fullmag_ir::KPointIR {
                label: Some("G".to_string()),
                k_vector: [0.0, 0.0, 0.0],
            }],
            samples_per_segment: Vec::new(),
            closed: false,
        }));
        source_plan.equilibrium = fullmag_ir::EquilibriumSourceIR::RelaxedInitialState;
        let handoff = fem_eigen::AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
            &source_plan,
            source_plan.equilibrium_magnetization.clone(),
            format!("sha256:{}", "a".repeat(64)),
            format!("sha256:{}", "b".repeat(64)),
        )
        .expect("source handoff should be valid");
        let mut target_plan = source_plan.clone();
        target_plan.mesh.set_tet4_cells(vec![[0, 2, 1, 3]]);
        assert_eq!(
            target_plan.mesh.nodes.len(),
            source_plan.mesh.nodes.len(),
            "fixture must preserve node count"
        );
        let sample = crate::eigen::KSampleDescriptor {
            sample_index: 1,
            label: Some("G".to_string()),
            segment_index: Some(0),
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: [0.0, 0.0, 0.0],
        };

        let error = eigen_path_single_k_point_plan(&target_plan, &sample, true, Some(&handoff))
            .expect_err("equal node count must not bypass full topology identity");

        assert!(error
            .message
            .contains("relax_to_eigen_mesh_identity_mismatch"));
    }

    #[test]
    fn k_path_accepts_same_mesh_handoff_and_uses_bound_equilibrium() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![fullmag_ir::KPointIR {
                label: Some("G".to_string()),
                k_vector: [0.0, 0.0, 0.0],
            }],
            samples_per_segment: Vec::new(),
            closed: false,
        }));
        plan.equilibrium = fullmag_ir::EquilibriumSourceIR::RelaxedInitialState;
        let accepted_m0 = vec![[0.0, 1.0, 0.0]; plan.mesh.nodes.len()];
        let handoff = fem_eigen::AcceptedFemEigenEquilibriumHandoff::from_accepted_linearization(
            &plan,
            accepted_m0.clone(),
            format!("sha256:{}", "a".repeat(64)),
            format!("sha256:{}", "b".repeat(64)),
        )
        .expect("same-mesh handoff should be valid");
        let sample = crate::eigen::KSampleDescriptor {
            sample_index: 1,
            label: Some("G".to_string()),
            segment_index: Some(0),
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: [0.0, 0.0, 0.0],
        };

        let point_plan = eigen_path_single_k_point_plan(&plan, &sample, true, Some(&handoff))
            .expect("same full topology handoff should pass");

        assert_eq!(
            point_plan.equilibrium,
            fullmag_ir::EquilibriumSourceIR::Provided
        );
        assert_eq!(point_plan.equilibrium_magnetization, accepted_m0);
    }

    #[test]
    fn k0_periodic_airbox_field_sweep_point_uses_declared_bias_and_relaxes_per_sample() {
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
        plan.equilibrium = fullmag_ir::EquilibriumSourceIR::RelaxedInitialState;
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e6,
            frequency_max_hz: 25.0e9,
        };
        plan.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(
            fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
        );
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 3.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("dipole".to_string()),
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.bias_field_samples = vec![
            fullmag_ir::FemEigenBiasFieldSamplePlanIR {
                sample_index: 0,
                field_a_per_m: [20_000.0, 0.0, 0.0],
                equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
                continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
                execution: fullmag_ir::FemEigenExecutionResolutionIR {
                    requested_device: fullmag_ir::ExecutionDevice::Cpu,
                    resolved_device: fullmag_ir::ExecutionDevice::Cpu,
                    requested_precision: fullmag_ir::ExecutionPrecision::Double,
                    resolved_precision: fullmag_ir::ExecutionPrecision::Double,
                    requested_engine: fullmag_ir::FemEigenEngineIR::Auto,
                    resolved_engine: fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
                    fallback_used: false,
                    fallback_reason: None,
                    selection_reason: "test.bias_field_sweep.cpu".to_string(),
                },
            },
            fullmag_ir::FemEigenBiasFieldSamplePlanIR {
                sample_index: 1,
                field_a_per_m: [80_000.0, 0.0, 0.0],
                equilibrium_policy: fullmag_ir::BiasFieldSweepEquilibriumPolicyIR::RelaxEach,
                continuation_seed: fullmag_ir::BiasFieldSweepContinuationSeedIR::InitialState,
                execution: fullmag_ir::FemEigenExecutionResolutionIR {
                    requested_device: fullmag_ir::ExecutionDevice::Cpu,
                    resolved_device: fullmag_ir::ExecutionDevice::Cpu,
                    requested_precision: fullmag_ir::ExecutionPrecision::Double,
                    resolved_precision: fullmag_ir::ExecutionPrecision::Double,
                    requested_engine: fullmag_ir::FemEigenEngineIR::Auto,
                    resolved_engine: fullmag_ir::FemEigenEngineIR::K0PoissonAirboxCpuSchurSlepc,
                    fallback_used: false,
                    fallback_reason: None,
                    selection_reason: "test.bias_field_sweep.cpu".to_string(),
                },
            },
        ];
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
            samples: vec![
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 0,
                    bias_field: [320_000.0, 0.0, 0.0],
                },
                fullmag_ir::FemEigenK0KittelValidationSampleIR {
                    sample_index: 1,
                    bias_field: [640_000.0, 0.0, 0.0],
                },
            ],
        });

        let sample = crate::eigen::KSampleDescriptor {
            sample_index: 1,
            label: Some("H80mT".to_string()),
            segment_index: Some(0),
            path_s: 1.0,
            t_in_segment: 1.0,
            k_vector: [0.0, 0.0, 0.0],
        };
        let point_plan = eigen_path_single_k_point_plan(&plan, &sample, false, None)
            .expect("physical K0 field-sweep point plan should be valid");

        assert_eq!(point_plan.external_field, Some([80_000.0, 0.0, 0.0]));
        assert_eq!(
            eigen_path_external_field(&plan, 0),
            Some([20_000.0, 0.0, 0.0])
        );
        assert_eq!(
            eigen_path_external_field(&plan, 1),
            Some([80_000.0, 0.0, 0.0])
        );
        assert_eq!(
            point_plan.equilibrium,
            fullmag_ir::EquilibriumSourceIR::RelaxedInitialState
        );
        assert!(point_plan.bias_field_samples.is_empty());
        assert!(point_plan.k0_kittel_validation.is_none());
    }

    #[test]
    fn kittel_oracle_without_bias_field_samples_fails_closed_for_physical_path() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![fullmag_ir::KPointIR {
                label: Some("G".to_string()),
                k_vector: [0.0, 0.0, 0.0],
            }],
            samples_per_segment: Vec::new(),
            closed: false,
        }));
        plan.external_field = Some([123.0, 0.0, 0.0]);
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
                bias_field: [640_000.0, 0.0, 0.0],
            }],
        });
        let sample = crate::eigen::KSampleDescriptor {
            sample_index: 0,
            label: Some("G".to_string()),
            segment_index: Some(0),
            path_s: 0.0,
            t_in_segment: 0.0,
            k_vector: [0.0, 0.0, 0.0],
        };

        let error = eigen_path_single_k_point_plan(&plan, &sample, false, None)
            .expect_err("Kittel metadata cannot substitute for a physical bias sweep");
        assert!(
            error.message.contains("bias_field_samples"),
            "{}",
            error.message
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
                    tangent_leakage_weighted_relative_l2: Some(0.0),
                    dominant_polarization: "linear".to_string(),
                    reduced_vector: Some(vec![
                        num_complex::Complex64::new(1.0, 0.0),
                        num_complex::Complex64::new(1.0, 0.0),
                    ]),
                    lifted_real: None,
                    lifted_imag: None,
                    amplitude: None,
                    phase: None,
                    node_mass_weights: None,
                    component_participation:
                        crate::eigen::ModalParticipationObservable::unavailable_without_context(
                            "cpu",
                        ),
                }],
                relaxation_steps: 0,
                solver_model: EigenSolverModel::ProductionCpuShiftInvert,
                solver_notes: vec!["production sample".to_string()],
                solver_diagnostics: None,
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
    fn k_path_single_k_plan_is_independent_of_kittel_oracle() {
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

        let sample = crate::eigen::KSampleDescriptor {
            sample_index: 1,
            label: Some("H1".to_string()),
            segment_index: Some(0),
            path_s: 1.0,
            t_in_segment: 0.5,
            k_vector: [0.0, 0.0, 0.0],
        };
        let with_oracle = eigen_path_single_k_point_plan(&plan, &sample, false, None)
            .expect("reference K0 point plan should be valid");

        let mut changed_oracle = plan.clone();
        changed_oracle
            .k0_kittel_validation
            .as_mut()
            .expect("test plan should carry an oracle")
            .samples[1]
            .bias_field = [160_000.0, 0.0, 0.0];
        let with_changed_oracle =
            eigen_path_single_k_point_plan(&changed_oracle, &sample, false, None)
                .expect("changed reference K0 point plan should be valid");

        let mut without_oracle = plan.clone();
        without_oracle.k0_kittel_validation = None;
        let without_oracle = eigen_path_single_k_point_plan(&without_oracle, &sample, false, None)
            .expect("point plan without reference oracle should be valid");

        assert_eq!(with_oracle, with_changed_oracle);
        assert_eq!(with_oracle, without_oracle);
        assert_eq!(with_oracle.external_field, Some([1.0, 2.0, 3.0]));
        assert_eq!(with_oracle.target, plan.target);
        assert_eq!(with_oracle.mesh_build_report, plan.mesh_build_report);
        assert!(with_oracle.k0_kittel_validation.is_none());
    }

    #[test]
    fn gpu_k0_periodic_airbox_lane_support_is_independent_of_kittel_oracle() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![fullmag_ir::KPointIR {
                label: Some("G".to_string()),
                k_vector: [0.0, 0.0, 0.0],
            }],
            samples_per_segment: Vec::new(),
            closed: false,
        }));
        plan.count = 1;
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.target = fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz: 1.0e3,
            frequency_max_hz: 25.0e9,
        };
        plan.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(
            fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
        );
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 2,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: None,
        }];
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 3.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("dipole".to_string()),
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });

        let without_oracle = gpu_modal_k0_kittel_path_supported(&plan);
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
            samples: vec![fullmag_ir::FemEigenK0KittelValidationSampleIR {
                sample_index: 0,
                bias_field: [20.0e-3 / crate::MU0, 0.0, 0.0],
            }],
        });
        let with_oracle = gpu_modal_k0_kittel_path_supported(&plan);

        assert!(
            !without_oracle,
            "GPU K0 periodic-airbox path routing must remain unsupported while native A_qq/certificate producers are absent"
        );
        assert_eq!(without_oracle, with_oracle);
    }

    #[test]
    fn periodic_airbox_k0_runtime_support_is_false_without_native_producer() {
        let mut plan = tiny_fem_eigen_plan(Some(fullmag_ir::KSamplingIR::Path {
            points: vec![fullmag_ir::KPointIR {
                label: Some("G".to_string()),
                k_vector: [0.0, 0.0, 0.0],
            }],
            samples_per_segment: Vec::new(),
            closed: false,
        }));
        plan.operator.kind = fullmag_ir::EigenOperatorIR::Full2x2;
        plan.operator.include_demag = true;
        plan.enable_demag = true;
        plan.damping_policy = fullmag_ir::EigenDampingPolicyIR::Ignore;
        plan.spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Legacy(
            fullmag_ir::SpinWaveBoundaryKindIR::Periodic,
        );
        plan.air_box_config = Some(fullmag_ir::AirBoxConfigIR {
            factor: 3.0,
            grading: 1.2,
            boundary_marker: 99,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("dipole".to_string()),
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("test".to_string()),
            boundary_marker_source: Some("test".to_string()),
        });
        plan.mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        plan.mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 1,
            marker_b: 2,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1.0e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: None,
        }];

        assert!(periodic_airbox_k0_physical_plan(&plan));
        assert!(!periodic_airbox_k0_runtime_supported(&plan));
        assert!(!gpu_modal_k0_kittel_path_supported(&plan));
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
            legacy_fem_eigen_execution(FemEngine::CpuNative),
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
            FemEngine::CpuNative,
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
            FemEngine::CpuNative,
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
            FemEngine::CpuNative,
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
            legacy_fem_eigen_execution(FemEngine::CpuNative),
            &plan,
            &[
                OutputIR::EigenSpectrum {
                    quantity: "frequency_hz".to_string(),
                },
                OutputIR::DispersionCurve {
                    name: "dispersion".to_string(),
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

        let mode_error = execute_fem_eigen(
            legacy_fem_eigen_execution(FemEngine::CpuNative),
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
        .expect_err("analytic reference mode fields must fail closed without mesh identity");
        assert!(mode_error
            .message
            .contains("mode field publication requires valid source mesh identity"));
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
                time_envelope: None,
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
        let mode_preflight = execute_native_source
            .find("create_native_fem_backend_after_strict_gpu_mode_preflight")
            .expect(
                "strict native GPU execution must preflight hybrid mode before backend creation",
            );
        let backend_creation = execute_native_source
            .find("NativeFemBackend::create_with_initial_effective_field")
            .expect("native FEM must create a backend after mode preflight");
        let strict_preflight = execute_native_source
            .find("begin_native_fem_stage_after_strict_gpu_preflight")
            .expect("strict native GPU execution must preflight device residency");
        let begin_stage = execute_native_source
            .find("backend.begin_stage")
            .expect("native FEM must begin a stage after preflight");
        let execution_engine = execute_native_source
            .find("let execution_engine")
            .expect("native FEM must materialize execution-engine provenance");
        let provenance = execute_native_source
            .find("let mut provenance")
            .expect("native FEM must materialize execution provenance");

        assert!(
            mode_preflight < backend_creation
                && strict_preflight < begin_stage
                && begin_stage < execution_engine
                && execution_engine < provenance,
            "a strict native GPU plan must fail before stage lifecycle or provenance is published"
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
                && source.contains("let action = (live.on_step)(StepUpdate {")
                && source.contains("coupled_checkpoint: None,"),
            "native FEM direct minimizer must publish live updates after accepted steps"
        );
    }

    #[test]
    fn fdm_cuda_completion_snapshots_use_exact_torque_metrics() {
        let execute = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fdm/gpu/cuda/execute.rs"
        ))
        .expect("read CUDA execute module");
        let execute_start = execute
            .find("pub(crate) fn execute_cuda_fdm(")
            .expect("active CUDA single-grid execution body");
        let execute_end = execute[execute_start..]
            .find("\n#[cfg(not(feature = \"cuda\"))]")
            .map(|offset| execute_start + offset)
            .unwrap_or(execute.len());
        let cuda_single = &execute[execute_start..execute_end];
        assert!(
            cuda_single.contains(
                "max_torque_apm: latest_stats.as_ref().map(|stats| stats.max_torque_Apm)"
            ) && !cuda_single.contains("max_torque_apm: None"),
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
            4,
            "all active CUDA multilayer lanes must publish exact final torque"
        );
        assert!(
            !multilayer.contains("max_torque_apm: None"),
            "CUDA multilayer completion must not publish unavailable torque"
        );
    }
}

#[cfg(all(test, feature = "fem-gpu"))]
pub(crate) use tests::tiny_fem_plan as test_tiny_fem_plan;
