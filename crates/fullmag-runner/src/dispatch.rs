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
    BackendPlanIR, FdmMultilayerPlanIR, FdmPlanIR, FemEigenPlanIR, FemMeshPartSelector, FemPlanIR,
    OutputIR, ProblemIR,
};
use serde_json::Value;
use std::collections::{BTreeSet, HashSet};
use std::sync::{Mutex, OnceLock};

use crate::artifact_pipeline::ArtifactPipelineSender;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::artifact_pipeline::ArtifactRecorder;
use crate::cpu_reference;
use crate::fem_eigen;
#[cfg(feature = "fem-gpu")]
use crate::interactive_runtime::cached_preview_quantities_for;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::interactive_runtime::{display_is_global_scalar, display_refresh_due};
#[cfg(feature = "cuda")]
use crate::multilayer_cuda;
use crate::multilayer_reference;
use crate::native_fdm;
#[cfg(feature = "cuda")]
use crate::native_fdm::NativeFdmBackend;
use crate::native_fem;
#[cfg(feature = "fem-gpu")]
use crate::native_fem::NativeFemBackend;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::quantities::normalized_quantity_name;
use crate::quantities::{active_fdm_preview_quantities, active_fem_preview_quantities};
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::relaxation::llg_overdamped_uses_pure_damping;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::relaxation::relaxation_converged;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::relaxation::relaxation_stop_criteria_satisfied;
use crate::runtime_registry::RuntimeRegistry;
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::scalar_metrics::single_object_scalars;
#[cfg(feature = "fem-gpu")]
use crate::scalar_metrics::weighted_object_scalars;
#[cfg(feature = "cuda")]
use crate::scalar_metrics::{
    apply_average_m_to_step_stats, scalar_outputs_request_average_m, scalar_row_due,
};
#[cfg(feature = "cuda")]
use crate::schedules::{
    advance_due_schedules, collect_field_schedules, collect_scalar_schedules, is_due, same_time,
    OutputSchedule,
};
#[cfg(all(feature = "fem-gpu", not(feature = "cuda")))]
use crate::schedules::{collect_field_schedules, collect_scalar_schedules};
use crate::types::{
    ExecutedRun, LivePreviewRequest, LiveStepConsumer, ResolvedFallback, RunError, StepAction,
    StepUpdate,
};
#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
use crate::types::{ExecutionProvenance, FieldSnapshot, RunResult, RunStatus, StepStats};
#[cfg(feature = "fem-gpu")]
use fullmag_engine::fem::FemBackendId;

/// Which execution engine to use for FDM.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FdmEngine {
    /// CPU reference engine (fullmag-engine).
    CpuReference,
    /// Native CUDA FDM backend.
    CudaFdm,
}

/// Which public FEM runtime lane to use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FemEngine {
    /// Sole maintained CPU FEM backend (MFEM/libCEED/hypre on host CPU).
    CpuNative,
    /// Native GPU FEM backend (MFEM stack on CUDA device).
    NativeGpu,
}

#[derive(Debug, Clone)]
pub(crate) struct EngineResolution<E> {
    pub engine: E,
    pub fallback: Option<ResolvedFallback>,
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

#[cfg(feature = "fem-gpu")]
fn ensure_fem_object_scalars(stats: &mut StepStats, plan: &FemPlanIR) {
    if !stats.per_object_scalars.is_empty() {
        return;
    }
    if plan.object_segments.is_empty() {
        stats.per_object_scalars = single_object_scalars("free", stats);
        return;
    }
    let mut weights: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for segment in &plan.object_segments {
        let weight = f64::from(segment.node_count.max(1));
        *weights.entry(segment.object_id.clone()).or_insert(0.0) += weight;
    }
    let weighted = weighted_object_scalars(stats, &weights.into_iter().collect::<Vec<_>>());
    stats.per_object_scalars = if weighted.is_empty() {
        single_object_scalars("free", stats)
    } else {
        weighted
    };
}

fn runtime_warn_once(message: &str) {
    runtime_log_once("warning", message);
}

fn runtime_info_once(message: &str) {
    runtime_log_once("info", message);
}

fn has_antenna_field_source(problem: &ProblemIR) -> bool {
    problem.current_modules.iter().any(|module| {
        matches!(
            module,
            fullmag_ir::CurrentModuleIR::AntennaFieldSource { .. }
        )
    })
}

fn unsupported_cpu_fdm_terms(plan: &FdmPlanIR, outputs: &[OutputIR]) -> Vec<&'static str> {
    let mut unsupported = Vec::new();
    if plan.has_oersted_cylinder {
        unsupported.push("oersted");
    }
    if plan.boundary_geometry.is_some() || plan.boundary_correction.is_some() {
        unsupported.push("boundary_correction");
    }
    // Fields available in CPU FDM snapshots: m, H_ex, H_demag, H_ext, H_eff.
    // H_ani, H_dmi, H_ant are not exposed as separate observables by the reference engine.
    if outputs.iter().any(|output| match output {
        OutputIR::Field { name, .. } | OutputIR::Scalar { name, .. } => {
            matches!(
                name.as_str(),
                "H_mel" | "u" | "u_dot" | "eps" | "sigma" | "E_mel" | "E_el" | "E_kin_el"
            )
        }
        OutputIR::Snapshot { field, .. } => {
            matches!(
                field.as_str(),
                "H_mel" | "u" | "u_dot" | "eps" | "sigma" | "H_ani" | "H_dmi" | "H_ant"
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
    if markers.is_empty() {
        return Ok(Vec::new());
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
    Ok(normalized)
}

/// Resolve which FDM engine to use based on environment and availability.
pub(crate) fn resolve_fdm_engine_with_trail(
    problem: &ProblemIR,
) -> Result<EngineResolution<FdmEngine>, RunError> {
    apply_runtime_gpu_index(problem, "fdm");
    let ir_policy = runtime_fdm_policy(problem);
    let (policy, env_override) = match std::env::var("FULLMAG_FDM_EXECUTION") {
        Ok(env_val) => {
            if env_val != ir_policy {
                let message = format!(
                    "FULLMAG_FDM_EXECUTION={} overrides script runtime_selection.device={}",
                    env_val, ir_policy
                );
                runtime_warn_once(&message);
            }
            (env_val, true)
        }
        Err(_) => (ir_policy.to_string(), false),
    };

    let resolution = match policy.as_str() {
        "cpu" => Ok(EngineResolution {
            engine: FdmEngine::CpuReference,
            fallback: None,
        }),
        "cuda" => {
            if native_fdm::is_cuda_available() {
                Ok(EngineResolution {
                    engine: FdmEngine::CudaFdm,
                    fallback: None,
                })
            } else if env_override {
                Err(RunError {
                    message: "FULLMAG_FDM_EXECUTION=cuda but CUDA backend is not available"
                        .to_string(),
                })
            } else {
                let message = "script requested CUDA FDM execution, but the CUDA backend is not available — falling back to CPU".to_string();
                runtime_warn_once(&message);
                Ok(EngineResolution {
                    engine: FdmEngine::CpuReference,
                    fallback: Some(runtime_fallback(
                        fdm_engine_id(FdmEngine::CudaFdm),
                        fdm_engine_id(FdmEngine::CpuReference),
                        "fdm_cuda_unavailable",
                        message,
                    )),
                })
            }
        }
        "auto" | _ => {
            if native_fdm::is_cuda_available() {
                Ok(EngineResolution {
                    engine: FdmEngine::CudaFdm,
                    fallback: None,
                })
            } else {
                Ok(EngineResolution {
                    engine: FdmEngine::CpuReference,
                    fallback: runtime_device(problem)
                        .filter(|device| matches!(*device, "gpu" | "cuda"))
                        .map(|_| {
                            runtime_fallback(
                                fdm_engine_id(FdmEngine::CudaFdm),
                                fdm_engine_id(FdmEngine::CpuReference),
                                "fdm_cuda_unavailable",
                                "preferred CUDA FDM runtime is unavailable; using CPU reference engine".to_string(),
                            )
                        }),
                })
            }
        }
    }?;

    Ok(resolution)
}

pub(crate) fn resolve_fdm_engine(problem: &ProblemIR) -> Result<FdmEngine, RunError> {
    resolve_fdm_engine_with_trail(problem).map(|resolution| resolution.engine)
}

fn resolve_fdm_engine_with_registry(
    problem: &ProblemIR,
    registry: &RuntimeRegistry,
    _explicit_selection: bool,
) -> Result<DispatchEngineResolution, RunError> {
    apply_runtime_gpu_index(problem, "fdm");
    let requested_device = requested_registry_device_for_fdm(problem);
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

    let engine = match resolved.device.as_str() {
        "gpu" => FdmEngine::CudaFdm,
        _ => FdmEngine::CpuReference,
    };
    let fallback = resolved.fallback;

    Ok(DispatchEngineResolution {
        engine: DispatchEngine::Fdm(engine),
        fallback,
        runtime_family: Some(resolved.runtime_family),
        worker: Some(resolved.worker),
        resolved_backend: "fdm".to_string(),
        resolved_device: resolved.device,
        resolved_precision: requested_precision,
    })
}

/// Resolve which FEM engine to use based on environment and availability.
pub(crate) fn resolve_fem_engine_with_trail(
    problem: &ProblemIR,
) -> Result<EngineResolution<FemEngine>, RunError> {
    apply_runtime_gpu_index(problem, "fem");
    let ir_policy = runtime_fem_policy(problem);
    let fe_order = runtime_fem_order(problem);
    let (policy, env_override) = match std::env::var("FULLMAG_FEM_EXECUTION") {
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
        Err(_) => (ir_policy.to_string(), false),
    };

    if has_antenna_field_source(problem) {
        if policy == "gpu" {
            return Err(RunError {
                message:
                    "FEM GPU execution was requested, but native FEM GPU currently does not support antenna_field_source current_modules (fallback_reason=current_modules_force_cpu)"
                        .to_string(),
            });
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

    let availability = native_fem::gpu_availability();

    match policy.as_str() {
        "cpu" => Ok(EngineResolution {
            engine: FemEngine::CpuNative,
            fallback: None,
        }),
        "gpu" => {
            if !availability.available {
                if env_override {
                    Err(RunError {
                        message: format!(
                            "FULLMAG_FEM_EXECUTION=gpu but the native FEM GPU backend is not available: {}",
                            availability.reason
                        ),
                    })
                } else {
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
            } else if fe_order != 1 {
                if env_override {
                    Err(RunError {
                        message: format!(
                            "FULLMAG_FEM_EXECUTION=gpu requested native FEM GPU execution, \
                             but the current native backend supports fe_order=1 only \
                             (requested order={}, fallback_reason=fem_gpu_fe_order_unsupported)",
                            fe_order
                        ),
                    })
                } else {
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
            if availability.available && fe_order == 1 {
                Ok(EngineResolution {
                    engine: FemEngine::NativeGpu,
                    fallback: None,
                })
            } else {
                if availability.available && fe_order != 1 {
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
                } else if !availability.available {
                    let message = format!(
                        "native FEM GPU backend is not available — using MFEM/libCEED/hypre CPU FEM engine (fallback_reason=native_fem_gpu_unavailable; reason={})",
                        availability.reason
                    );
                    runtime_info_once(&message);
                    Ok(EngineResolution {
                        engine: FemEngine::CpuNative,
                        fallback: runtime_device(problem)
                            .filter(|device| matches!(*device, "gpu" | "cuda"))
                            .map(|_| {
                                runtime_fallback(
                                    fem_engine_id(FemEngine::NativeGpu),
                                    fem_engine_id(FemEngine::CpuNative),
                                    "native_fem_gpu_unavailable",
                                    message,
                                )
                            }),
                    })
                } else {
                    Ok(EngineResolution {
                        engine: FemEngine::CpuNative,
                        fallback: None,
                    })
                }
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
    explicit_selection: bool,
    plan: Option<&FemPlanIR>,
) -> Result<DispatchEngineResolution, RunError> {
    apply_runtime_gpu_index(problem, "fem");
    let requested_device = requested_registry_device_for_fem(problem);
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
        if has_antenna_field_source(problem) {
            if explicit_selection {
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
            return Ok(DispatchEngineResolution {
                engine: DispatchEngine::Fem(FemEngine::CpuNative),
                fallback,
                runtime_family: Some(cpu_resolved.runtime_family),
                worker: Some(cpu_resolved.worker),
                resolved_backend: "fem".to_string(),
                resolved_device: "cpu".to_string(),
                resolved_precision: requested_precision,
            });
        }

        let fe_order = runtime_fem_order(problem);
        if fe_order != 1 {
            if explicit_selection {
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
            return Ok(DispatchEngineResolution {
                engine: DispatchEngine::Fem(FemEngine::CpuNative),
                fallback,
                runtime_family: Some(cpu_resolved.runtime_family),
                worker: Some(cpu_resolved.worker),
                resolved_backend: "fem".to_string(),
                resolved_device: "cpu".to_string(),
                resolved_precision: requested_precision,
            });
        }

        if let Some(fem_plan) = plan {
            if let Some(min_nodes) = should_fallback_to_cpu_for_small_fem_gpu(fem_plan) {
                if explicit_selection {
                    return Err(RunError {
                        message: format!(
                            "native FEM GPU execution was requested, but plan has {} nodes below FULLMAG_FEM_GPU_MIN_NODES={} (fallback_reason=fem_gpu_small_mesh_policy)",
                            fem_plan.mesh.nodes.len(),
                            min_nodes
                        ),
                    });
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
                let message = format!(
                    "FEM plan has {} nodes, below FULLMAG_FEM_GPU_MIN_NODES={} — falling back to MFEM/libCEED/hypre CPU FEM engine",
                    fem_plan.mesh.nodes.len(),
                    min_nodes
                );
                fallback = Some(runtime_fallback(
                    fem_engine_id(FemEngine::NativeGpu),
                    fem_engine_id(FemEngine::CpuNative),
                    "fem_gpu_small_mesh_policy",
                    message,
                ));
                return Ok(DispatchEngineResolution {
                    engine: DispatchEngine::Fem(FemEngine::CpuNative),
                    fallback,
                    runtime_family: Some(cpu_resolved.runtime_family),
                    worker: Some(cpu_resolved.worker),
                    resolved_backend: "fem".to_string(),
                    resolved_device: "cpu".to_string(),
                    resolved_precision: requested_precision,
                });
            }
        }
    }

    Ok(DispatchEngineResolution {
        engine: DispatchEngine::Fem(engine),
        fallback,
        runtime_family: Some(resolved.runtime_family),
        worker: Some(resolved.worker),
        resolved_backend: "fem".to_string(),
        resolved_device: resolved.device,
        resolved_precision: requested_precision,
    })
}

pub(crate) fn resolve_with_registry(
    problem: &ProblemIR,
    registry: Option<&RuntimeRegistry>,
    explicit_selection: bool,
) -> Result<DispatchEngineResolution, RunError> {
    let plan = fullmag_plan::plan(problem)?;
    match registry {
        Some(registry) => match &plan.backend_plan {
            BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => {
                resolve_fdm_engine_with_registry(problem, registry, explicit_selection)
            }
            BackendPlanIR::Fem(fem) => {
                resolve_fem_engine_with_registry(problem, registry, explicit_selection, Some(fem))
            }
            BackendPlanIR::FemEigen(_) => {
                resolve_fem_engine_with_registry(problem, registry, explicit_selection, None)
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
                })
            }
            BackendPlanIR::Fem(fem) => {
                let resolution = resolve_fem_engine_for_plan_with_trail(problem, fem)?;
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
                })
            }
        },
    }
}

pub(crate) fn resolve_fem_engine_for_plan_with_trail(
    problem: &ProblemIR,
    plan: &FemPlanIR,
) -> Result<EngineResolution<FemEngine>, RunError> {
    if !cfg!(feature = "fem-gpu") {
        return Err(RunError {
            message:
                "time-domain FEM execution requires the MFEM/libCEED runtime stack, but this launcher \
                 was built without the 'fem-gpu' feature. Use the managed FEM runtime or rebuild \
                 the launcher with MFEM/libCEED/hypre CPU or MFEM/libCEED/CUDA support."
                    .to_string(),
        });
    }
    let mut resolution = resolve_fem_engine_with_trail(problem)?;
    if resolution.engine == FemEngine::NativeGpu {
        if let Some(min_nodes) = should_fallback_to_cpu_for_small_fem_gpu(plan) {
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
    }
    Ok(resolution)
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
    match engine {
        FemEngine::CpuNative => {
            let cpu_plan = fem_plan_for_cpu_native(plan);
            snapshot_native_fem_preview(&cpu_plan, request)
        }
        FemEngine::NativeGpu => snapshot_native_fem_preview(plan, request),
    }
}

pub(crate) fn snapshot_fem_vector_fields(
    engine: FemEngine,
    plan: &FemPlanIR,
    quantities: &[&str],
    request: &LivePreviewRequest,
) -> Result<Vec<crate::LivePreviewField>, RunError> {
    let quantities = active_fem_preview_quantities(engine, plan, quantities);
    match engine {
        FemEngine::CpuNative => {
            let cpu_plan = fem_plan_for_cpu_native(plan);
            snapshot_native_fem_vector_fields(&cpu_plan, &quantities, request)
        }
        FemEngine::NativeGpu => snapshot_native_fem_vector_fields(plan, &quantities, request),
    }
}

fn fem_plan_for_cpu_native(plan: &FemPlanIR) -> FemPlanIR {
    let mut cpu_plan = plan.clone();
    if cpu_plan.mfem_device_string.is_none() {
        cpu_plan.mfem_device_string = Some("cpu".to_string());
    }
    cpu_plan
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

fn runtime_device(problem: &ProblemIR) -> Option<&str> {
    runtime_selection(problem)
        .and_then(|selection| selection.get("device"))
        .and_then(Value::as_str)
}

fn runtime_precision(problem: &ProblemIR) -> &str {
    runtime_selection(problem)
        .and_then(|selection| selection.get("precision"))
        .and_then(Value::as_str)
        .unwrap_or(match problem.backend_policy.execution_precision {
            fullmag_ir::ExecutionPrecision::Single => "single",
            fullmag_ir::ExecutionPrecision::Double => "double",
        })
}

fn requested_registry_device_for_fdm(problem: &ProblemIR) -> String {
    match std::env::var("FULLMAG_FDM_EXECUTION").ok().as_deref() {
        Some("cpu") => "cpu".to_string(),
        Some("cuda") => "gpu".to_string(),
        Some("auto") | None => runtime_device(problem)
            .unwrap_or("auto")
            .replace("cuda", "gpu"),
        Some(other) => other.replace("cuda", "gpu"),
    }
}

fn requested_registry_device_for_fem(problem: &ProblemIR) -> String {
    match std::env::var("FULLMAG_FEM_EXECUTION").ok().as_deref() {
        Some("cpu") => "cpu".to_string(),
        Some("gpu") | Some("cuda") => "gpu".to_string(),
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

    registry.resolve(backend, "cpu", precision).map(|resolved| RegistryRuntimeMatch {
        runtime_family: resolved.runtime_family,
        worker: resolved.worker,
        device: "cpu".to_string(),
        fallback: Some(runtime_fallback(
            &format!("{backend}_gpu"),
            &format!("{backend}_cpu"),
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

fn runtime_fdm_policy(problem: &ProblemIR) -> &'static str {
    match runtime_device(problem) {
        Some("cpu") => "cpu",
        Some("cuda") | Some("gpu") => "cuda",
        _ => "auto",
    }
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

fn fem_gpu_execution_forced() -> bool {
    matches!(
        std::env::var("FULLMAG_FEM_EXECUTION").ok().as_deref(),
        Some("gpu")
    )
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
    let node_count = plan.mesh.nodes.len();
    (node_count < min_nodes).then_some(min_nodes)
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
    match engine {
        FdmEngine::CpuReference => cpu_reference::execute_reference_fdm(
            plan,
            until_seconds,
            outputs,
            live,
            artifact_writer,
        ),
        FdmEngine::CudaFdm => execute_cuda_fdm(plan, until_seconds, outputs, live, artifact_writer),
    }
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
    let normalized_plan = normalized_fem_plan_for_runtime(plan)?;
    match engine {
        FemEngine::CpuNative => {
            let cpu_plan = fem_plan_for_cpu_native(&normalized_plan);
            execute_native_fem(&cpu_plan, until_seconds, outputs, live, artifact_writer)
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
                    until_seconds,
                    outputs,
                    live,
                    artifact_writer,
                );
            }
            execute_native_fem(
                &normalized_plan,
                until_seconds,
                outputs,
                live,
                artifact_writer,
            )
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

/// Multi-k orchestrator path: iterate over samples in a `KSamplingIR::Path`,
/// solve each point with the existing single-k solver, track branches, and
/// produce V2 path/branch/mode artifacts alongside legacy-compatible ones.
fn execute_fem_eigen_path(
    engine: FemEngine,
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> Result<ExecutedRun, RunError> {
    use crate::eigen::{
        run_path_or_single, EigenSolverModel, KSampleDescriptor, SingleKModeResult,
        SingleKSolveResult, SingleKSolver,
    };
    use crate::types::AuxiliaryArtifact;

    struct KSolverAdapter {
        engine: FemEngine,
    }

    impl SingleKSolver for KSolverAdapter {
        fn solve_single_k(
            &self,
            plan: &FemEigenPlanIR,
            outputs: &[OutputIR],
            sample: &KSampleDescriptor,
        ) -> Result<SingleKSolveResult, crate::types::RunError> {
            // Override plan's k_sampling to a single-k point for this sample
            let mut point_plan = plan.clone();
            point_plan.k_sampling = Some(fullmag_ir::KSamplingIR::Single {
                k_vector: sample.k_vector,
            });

            let executed = match self.engine {
                FemEngine::CpuNative => {
                    fem_eigen::execute_baseline_fem_eigen(&point_plan, outputs)?
                }
                FemEngine::NativeGpu => fem_eigen::execute_gpu_fem_eigen(&point_plan, outputs)?,
            };

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
                    max_amplitude: mode_json["max_amplitude"].as_f64().unwrap_or(0.0),
                    dominant_polarization: mode_json["dominant_polarization"]
                        .as_str()
                        .unwrap_or("unknown")
                        .to_string(),
                    // Mode field data is stored per-sample in artifacts;
                    // we don't carry heavy vectors through the orchestrator.
                    reduced_vector: None,
                    lifted_real: None,
                    lifted_imag: None,
                    amplitude: None,
                    phase: None,
                });
            }

            Ok(SingleKSolveResult {
                sample: sample.clone(),
                modes,
                relaxation_steps,
                solver_model: EigenSolverModel::ReferenceScalarTangent,
                solver_notes: vec![solver_kind],
            })
        }
    }

    let adapter = KSolverAdapter { engine };
    let path_result = run_path_or_single(
        &adapter,
        plan,
        outputs,
        None, // we collect artifacts manually below
        plan.mode_tracking.as_ref(),
    )?;

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
                "modes": s.modes.iter().map(|m| serde_json::json!({
                    "raw_mode_index": m.raw_mode_index,
                    "branch_id": m.branch_id,
                    "frequency_real_hz": m.frequency_real_hz,
                    "frequency_imag_hz": m.frequency_imag_hz,
                    "angular_frequency_rad_per_s": m.angular_frequency_rad_per_s,
                    "eigenvalue_real": m.eigenvalue_real,
                    "eigenvalue_imag": m.eigenvalue_imag,
                    "norm": m.norm,
                    "max_amplitude": m.max_amplitude,
                    "dominant_polarization": m.dominant_polarization,
                    "k_vector": s.sample.k_vector,
                })).collect::<Vec<_>>(),
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
        .flat_map(|branch| branch.points.iter().filter_map(|point| point.overlap_prev))
        .collect::<Vec<_>>();
    let min_overlap = overlap_values
        .iter()
        .copied()
        .reduce(|lhs, rhs| lhs.min(rhs));
    let gap_count = path_result
        .branches
        .iter()
        .map(|branch| v2_samples.len().saturating_sub(branch.points.len()))
        .sum::<usize>();
    let diagnostics_v2 = serde_json::json!({
        "schema_version": "eigen_diagnostics.v2",
        "dispersion": {
            "sample_count": path_result.samples.len(),
            "mode_count_requested": plan.count,
            "branch_count": path_result.branches.len(),
            "min_overlap": min_overlap,
            "gap_count": gap_count,
            "ambiguous_assignment_count": 0,
        },
    });
    let spectrum_v2 = serde_json::json!({
        "schema_version": "eigen_spectrum.v2",
        "solver_id": path_result.solver_model.as_str(),
        "phase_convention": phase_convention,
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
        .map(|b| {
            serde_json::json!({
                "branch_id": b.branch_id,
                "label": b.label,
                "points": b.points.iter().map(|p| serde_json::json!({
                    "sample_index": p.sample_index,
                    "raw_mode_index": p.raw_mode_index,
                    "frequency_real_hz": p.frequency_real_hz,
                    "frequency_imag_hz": p.frequency_imag_hz,
                    "tracking_confidence": p.tracking_confidence,
                    "overlap_prev": p.overlap_prev,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let branches_v2 = serde_json::json!({
        "schema_version": "eigen_branches.v2",
        "tracking_method": tracking_method,
        "overlap_floor": tracking_cfg.overlap_floor,
        "frequency_window_hz": tracking_cfg.frequency_window_hz,
        "branches": v2_branches.clone(),
        "diagnostics": {
            "min_overlap": min_overlap,
            "median_overlap": null,
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
            .map(|m| {
                serde_json::json!({
                    "index": m.raw_mode_index,
                    "frequency_hz": m.frequency_real_hz,
                    "frequency_real_hz": m.frequency_real_hz,
                    "frequency_imag_hz": m.frequency_imag_hz,
                    "angular_frequency_rad_per_s": m.angular_frequency_rad_per_s,
                    "eigenvalue_real": m.eigenvalue_real,
                    "eigenvalue_imag": m.eigenvalue_imag,
                    "norm": m.norm,
                    "max_amplitude": m.max_amplitude,
                    "dominant_polarization": m.dominant_polarization,
                    "k_vector": first_sample.sample.k_vector,
                })
            })
            .collect();

        let legacy_spectrum = serde_json::json!({
            "study_kind": "eigenmodes",
            "solver_backend": "cpu_baseline_fem_eigen",
            "solver_kind": path_result.solver_model.as_str(),
            "mesh_name": plan.mesh_name,
            "mode_count": modes_summary.len(),
            "normalization": format!("{:?}", plan.normalization).to_lowercase(),
            "damping_policy": format!("{:?}", plan.damping_policy).to_lowercase(),
            "k_sampling": plan.k_sampling,
            "relaxation_steps": first_sample.relaxation_steps,
            "modes": modes_summary,
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/spectrum.json".to_string(),
            bytes: serde_json::to_vec_pretty(&legacy_spectrum).unwrap_or_default(),
        });

        // Legacy dispersion CSV with all samples × modes
        let mut csv_lines =
            vec!["mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s".to_string()];
        for sample_result in &path_result.samples {
            let k = sample_result.sample.k_vector;
            for mode in &sample_result.modes {
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
            "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score"
                .to_string(),
        ];
        for sample_result in &path_result.samples {
            let k = sample_result.sample.k_vector;
            let label = sample_result.sample.label.clone().unwrap_or_default();
            for mode in &sample_result.modes {
                let overlap_score = mode
                    .branch_id
                    .and_then(|branch_id| {
                        path_result
                            .branches
                            .iter()
                            .find(|branch| branch.branch_id == branch_id)
                            .and_then(|branch| {
                                branch.points.iter().find(|point| {
                                    point.sample_index == sample_result.sample.sample_index
                                        && point.raw_mode_index == mode.raw_mode_index
                                })
                            })
                            .and_then(|point| point.overlap_prev)
                    })
                    .map(|value| value.to_string())
                    .unwrap_or_default();
                dispersion_v2_lines.push(format!(
                    "{},{},{},{},{},{},{},{},{},{},{},{},{}",
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
                    "",
                    "",
                    overlap_score,
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

    Ok(ExecutedRun {
        result: crate::types::RunResult {
            status: crate::types::RunStatus::Completed,
            steps: vec![],
            final_magnetization: plan.equilibrium_magnetization.clone(),
            completion: Some(crate::relaxation::infer_stage_completion(
                crate::types::RunStatus::Completed,
                None,
                &[],
                0.0,
                0.0,
                false,
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

    let mut backend = NativeFdmBackend::create(plan)?;
    let device_info = backend.device_info()?;
    let cell_count = (plan.grid.cells[0] as usize)
        * (plan.grid.cells[1] as usize)
        * (plan.grid.cells[2] as usize);
    let initial_magnetization = backend.copy_m(cell_count)?;
    let dt = crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
        .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);

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
    let mut previous_total_energy: Option<f64> = None;
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;
    let mut current_stats = backend.snapshot_step_stats(plan.grid.cells)?;
    ensure_single_object_scalars(&mut current_stats, "free");

    let direct_minimization_relax = plan.relaxation.as_ref().filter(|control| {
        matches!(
            control.algorithm,
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
                | fullmag_ir::RelaxationAlgorithmIR::NonlinearCg
        )
    });

    if let Some(control) = direct_minimization_relax {
        latest_stats = Some(current_stats.clone());
        let mut m = backend.copy_m(cell_count)?;
        let mut h_eff = backend.copy_h_eff(cell_count)?;
        let mut g = tangent_gradient_from_field(&m, &h_eff);
        let mut energy = current_stats.e_total;
        let mut p: Vec<[f64; 3]> = g.iter().map(|gi| scale_vec3(*gi, -1.0)).collect();

        let mut lambda: f64 = 1e-6;
        let lambda_min: f64 = 1e-15;
        let lambda_max: f64 = 1e-3;
        let c_armijo: f64 = 1e-4;
        let max_backtrack: u32 = 20;
        let mut use_bb1 = true;
        let mut reset_consecutive: u64 = 0;
        let mut direct_step: u64 = 0;

        while direct_step < control.stop.max_steps.unwrap_or(u64::MAX) {
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
                        stats: current_stats.clone(),
                        grid: live.grid,
                        fem_mesh: None,
                        magnetization: Some(flatten_vectors(&m)),
                        preview_field,
                        cached_preview_fields: None,
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
            if cancelled {
                break;
            }

            let max_torque = max_torque_from_field(&m, &h_eff);
            if relaxation_stop_criteria_satisfied(control, None, max_torque) {
                break;
            }
            let g_norm_sq = global_dot_vec3(&g, &g);
            if g_norm_sq < 1e-30 {
                break;
            }

            let mut trial_lambda = lambda;
            let mut backtracks = 0u32;
            let mut m_trial = m.clone();
            let trial_stats = match control.algorithm {
                fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb => {
                    let trial_stats = loop {
                        for i in 0..m.len() {
                            m_trial[i] =
                                normalized_vec3(sub_vec3(m[i], scale_vec3(g[i], trial_lambda)));
                        }
                        backend.upload_magnetization(&m_trial)?;
                        backend.refresh_observables()?;
                        let mut stats = backend.snapshot_step_stats(plan.grid.cells)?;
                        ensure_single_object_scalars(&mut stats, "free");
                        let e_trial = stats.e_total;
                        if e_trial <= energy - c_armijo * trial_lambda * g_norm_sq
                            || backtracks >= max_backtrack
                        {
                            break stats;
                        }
                        trial_lambda *= 0.5;
                        backtracks += 1;
                    };

                    let h_eff_new = backend.copy_h_eff(cell_count)?;
                    let g_new = tangent_gradient_from_field(&m_trial, &h_eff_new);

                    let scale_factor = 1e-6;
                    let s: Vec<[f64; 3]> = (0..m.len())
                        .map(|i| scale_vec3(sub_vec3(m_trial[i], m[i]), scale_factor))
                        .collect();
                    let y: Vec<[f64; 3]> = (0..m.len())
                        .map(|i| scale_vec3(sub_vec3(g_new[i], g[i]), scale_factor))
                        .collect();
                    let s_dot_s = global_dot_vec3(&s, &s);
                    let s_dot_y = global_dot_vec3(&s, &y);
                    let y_dot_y = global_dot_vec3(&y, &y);

                    let bb_ok;
                    if use_bb1 {
                        if s_dot_y > 1e-30 {
                            lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
                            bb_ok = true;
                        } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
                            lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                            bb_ok = true;
                        } else {
                            bb_ok = false;
                        }
                    } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
                        lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                        bb_ok = true;
                    } else if s_dot_y > 1e-30 {
                        lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
                        bb_ok = true;
                    } else {
                        bb_ok = false;
                    }
                    if bb_ok {
                        reset_consecutive = 0;
                    } else {
                        reset_consecutive += 1;
                        lambda = (reset_consecutive as f64 * lambda_min).min(lambda_max);
                    }
                    use_bb1 = !use_bb1;

                    h_eff = h_eff_new;
                    g = g_new;
                    trial_stats
                }
                fullmag_ir::RelaxationAlgorithmIR::NonlinearCg => {
                    let mut p_dot_g = global_dot_vec3(&p, &g);
                    if p_dot_g >= 0.0 {
                        p = g.iter().map(|gi| scale_vec3(*gi, -1.0)).collect();
                        p_dot_g = global_dot_vec3(&p, &g);
                    }
                    let p_norm = global_dot_vec3(&p, &p).sqrt();
                    trial_lambda = if p_norm > 0.0 {
                        (1e-6_f64).min(1.0 / p_norm)
                    } else {
                        1e-6
                    };
                    let max_backtrack_ncg = 30u32;

                    let trial_stats = loop {
                        for i in 0..m.len() {
                            m_trial[i] =
                                normalized_vec3(add_vec3(m[i], scale_vec3(p[i], trial_lambda)));
                        }
                        backend.upload_magnetization(&m_trial)?;
                        backend.refresh_observables()?;
                        let mut stats = backend.snapshot_step_stats(plan.grid.cells)?;
                        ensure_single_object_scalars(&mut stats, "free");
                        let e_trial = stats.e_total;
                        if e_trial <= energy + c_armijo * trial_lambda * p_dot_g
                            || backtracks >= max_backtrack_ncg
                        {
                            break stats;
                        }
                        trial_lambda *= 0.5;
                        backtracks += 1;
                    };

                    let h_eff_new = backend.copy_h_eff(cell_count)?;
                    let g_new = tangent_gradient_from_field(&m_trial, &h_eff_new);
                    let g_old_transported = project_tangent(&m_trial, &g);
                    let y_pr: Vec<[f64; 3]> = (0..m.len())
                        .map(|i| sub_vec3(g_new[i], g_old_transported[i]))
                        .collect();
                    let mut beta = if g_norm_sq > 1e-30 {
                        (global_dot_vec3(&g_new, &y_pr) / g_norm_sq).max(0.0)
                    } else {
                        0.0
                    };
                    let restart_interval = 50u64;
                    if (direct_step + 1) % restart_interval == 0 {
                        beta = 0.0;
                    }
                    let p_transported = project_tangent(&m_trial, &p);
                    let mut p_new: Vec<[f64; 3]> = (0..m.len())
                        .map(|i| {
                            add_vec3(
                                scale_vec3(g_new[i], -1.0),
                                scale_vec3(p_transported[i], beta),
                            )
                        })
                        .collect();
                    if global_dot_vec3(&p_new, &g_new) >= 0.0 {
                        p_new = g_new.iter().map(|gi| scale_vec3(*gi, -1.0)).collect();
                    }

                    p = p_new;
                    h_eff = h_eff_new;
                    g = g_new;
                    lambda = trial_lambda;
                    trial_stats
                }
                _ => break,
            };

            let prev_energy = energy;
            m = m_trial;
            energy = trial_stats.e_total;
            direct_step += 1;

            let mut accepted_stats = trial_stats.clone();
            accepted_stats.step = direct_step;
            accepted_stats.time = 0.0;
            accepted_stats.dt = trial_lambda;
            let torque_apm = max_torque_from_field(&m, &h_eff);
            accepted_stats.max_dm_dt = 0.0;
            accepted_stats.max_torque_Apm = torque_apm;
            accepted_stats.max_torque_T = torque_apm * crate::MU0;
            accepted_stats.max_h_eff = h_eff
                .iter()
                .map(|h| (h[0] * h[0] + h[1] * h[1] + h[2] * h[2]).sqrt())
                .fold(0.0, f64::max);
            ensure_single_object_scalars(&mut accepted_stats, "free");

            artifacts.record_scalar(&accepted_stats)?;
            steps.push(accepted_stats.clone());
            latest_stats = Some(accepted_stats.clone());
            current_stats = accepted_stats;

            let energy_delta = (prev_energy - energy).abs();
            if relaxation_stop_criteria_satisfied(control, Some(energy_delta), torque_apm) {
                break;
            }
        }
    } else {
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
                        stats: current_stats.clone(),
                        grid: live.grid,
                        fem_mesh: None,
                        magnetization: None,
                        preview_field,
                        cached_preview_fields: None,
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

            let dt_step = dt.min(until_seconds - current_time);
            let interrupt_requested = live
                .as_ref()
                .and_then(|consumer| consumer.interrupt_requested);
            let Some(mut stats) = backend.step_interruptible(dt_step, interrupt_requested)? else {
                continue;
            };
            ensure_single_object_scalars(&mut stats, "free");
            current_time = stats.time;
            latest_stats = Some(stats.clone());
            current_stats = stats.clone();
            let due_scalar_row = scalar_row_due(&scalar_schedules, stats.time);
            let average_requested = scalar_outputs_request_average_m(&scalar_schedules);
            let mut sampled_stats = stats.clone();
            let mut magnetization_cache: Option<Vec<[f64; 3]>> = None;
            if due_scalar_row && average_requested {
                if magnetization_cache.is_none() {
                    magnetization_cache = Some(backend.copy_m(cell_count)?);
                }
                apply_average_m_to_step_stats(
                    &mut sampled_stats,
                    magnetization_cache
                        .as_deref()
                        .expect("magnetization cache initialized"),
                );
            }
            if let Some(live) = live.as_mut() {
                let heavy_payload_every = live.field_every_n.max(1);
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
                let magnetization = if stats.step % heavy_payload_every == 0 {
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
                    stats: sampled_stats.clone(),
                    grid: live.grid,
                    fem_mesh: None,
                    magnetization,
                    preview_field,
                    cached_preview_fields: None,
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
                &mut scalar_schedules,
                &mut field_schedules,
                &mut steps,
                &mut artifacts,
            )?;
            let stop_for_relaxation = plan.relaxation.as_ref().is_some_and(|control| {
                stats.step >= control.stop.max_steps.unwrap_or(u64::MAX)
                    || relaxation_converged(
                        control,
                        &stats,
                        previous_total_energy,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
                    )
            });
            previous_total_energy = Some(stats.e_total);
            if stop_for_relaxation {
                break;
            }
        }
    }

    record_cuda_final_outputs(
        &backend,
        cell_count,
        latest_stats,
        default_scalar_trace,
        &scalar_schedules,
        &field_schedules,
        &mut steps,
        &mut artifacts,
    )?;

    let final_magnetization = backend.copy_m(cell_count)?;
    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    let status = if cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = crate::relaxation::infer_stage_completion(
        status,
        plan.relaxation.as_ref(),
        &steps,
        plan.gyromagnetic_ratio,
        plan.material.damping,
        llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
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
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

/// Build cached preview fields for all non-active FEM quantities.
///
/// This mirrors the cached-preview logic in `CudaInteractiveFdmPreviewRuntime`
/// so that switching display-quantity in the frontend finds data in the cache
/// immediately.
#[cfg(feature = "fem-gpu")]
fn build_fem_cached_preview_fields(
    backend: &NativeFemBackend,
    display_selection: &crate::DisplaySelectionState,
    plan: &FemPlanIR,
    node_count: usize,
) -> Option<Vec<crate::LivePreviewField>> {
    let quantities = active_fem_preview_quantities(
        FemEngine::NativeGpu,
        plan,
        &cached_preview_quantities_for(display_selection),
    );
    if quantities.is_empty() {
        return None;
    }
    let base_request = display_selection.preview_request();
    let mut cached = Vec::new();
    for quantity in quantities {
        let mut req = base_request.clone();
        req.quantity = quantity.to_string();
        match backend.copy_live_preview_field(&req, node_count) {
            Ok(field) => cached.push(field),
            Err(_) => { /* quantity not computed yet — skip */ }
        }
    }
    if cached.is_empty() {
        None
    } else {
        Some(cached)
    }
}

#[cfg(feature = "fem-gpu")]
fn native_fem_execution_engine(plan: &FemPlanIR) -> &'static str {
    if plan.mfem_device_string.as_deref() == Some("cpu") {
        FemBackendId::CpuNative.provenance_name()
    } else {
        FemBackendId::GpuNative.provenance_name()
    }
}

#[cfg(feature = "fem-gpu")]
fn execute_native_fem(
    plan: &FemPlanIR,
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

    let mut backend = NativeFemBackend::create(plan)?;
    let device_info = backend.device_info()?;
    let execution_engine = native_fem_execution_engine(plan);
    let demag_policy = plan.demag_solver_policy.clone().unwrap_or_default();
    runtime_info_once(&format!(
        "native FEM backend active: engine={} device='{}' cc={} driver={} runtime={} mfem_device={} demag_solver={} preconditioner={}",
        execution_engine,
        device_info.name,
        device_info.compute_capability,
        device_info.driver_version,
        device_info.runtime_version,
        plan.mfem_device_string.as_deref().unwrap_or("cuda"),
        demag_policy.solver,
        demag_policy.preconditioner,
    ));
    let node_count = plan.mesh.nodes.len();
    let initial_magnetization = backend.copy_m(node_count)?;
    let mut dt =
        crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
            .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
    let dt_is_fixed = plan.fixed_timestep.is_some();

    let mut steps = Vec::new();
    // FEM-013 fix: serialize resolved demag realization and integrator in provenance.
    let resolved_demag = plan
        .demag_realization
        .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
    let provenance = ExecutionProvenance {
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
        fft_backend: if plan.enable_demag {
            Some("cuFFT".to_string())
        } else {
            None
        },
        device_name: Some(device_info.name.clone()),
        compute_capability: Some(device_info.compute_capability.clone()),
        cuda_driver_version: Some(device_info.driver_version),
        cuda_runtime_version: Some(device_info.runtime_version),
        requested_integrator: Some(format!("{:?}", plan.integrator)),
        resolved_integrator: Some(format!("{:?}", plan.integrator)),
        requested_demag_realization: plan
            .demag_realization
            .map(|r| r.provenance_name().to_string()),
        resolved_demag_realization: if plan.enable_demag {
            Some(resolved_demag.provenance_name().to_string())
        } else {
            None
        },
        dt_policy: if plan.adaptive_timestep.is_some() {
            Some("adaptive".to_string())
        } else if plan.fixed_timestep.is_some() {
            Some("user".to_string())
        } else {
            Some("fallback".to_string())
        },
        mfem_device: plan.mfem_device_string.clone(),
        demag_refresh_interval_s: plan
            .field_refresh
            .as_ref()
            .and_then(|policy| policy.demag_interval_s),
        requested_cpu_threads: None,
        resolved_cpu_threads: None,
        requested_fem_omp_threads: None,
        effective_fem_omp_threads: None,
        ..Default::default()
    };
    let mut artifacts = if let Some(writer) = artifact_writer {
        ArtifactRecorder::streaming(provenance.clone(), writer)
    } else {
        ArtifactRecorder::in_memory(provenance.clone())
    };
    let scalar_schedules = collect_scalar_schedules(outputs)?;
    let mut field_schedules = collect_field_schedules(outputs)?;
    let default_scalar_trace = scalar_schedules.is_empty();

    let mut latest_stats: Option<StepStats> = None;
    let mut current_time = 0.0;
    let mut previous_total_energy: Option<f64> = None;
    let mut backend_completion: Option<fullmag_ir::StageCompletionIR> = None;
    let mut last_preview_revision: Option<u64> = None;
    let mut cancelled = false;
    let mut current_stats = backend.snapshot_step_stats(node_count)?;
    ensure_fem_object_scalars(&mut current_stats, plan);

    let direct_minimization_relax = plan.relaxation.as_ref().filter(|control| {
        matches!(
            control.algorithm,
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
                | fullmag_ir::RelaxationAlgorithmIR::NonlinearCg
        )
    });

    if let Some(control) = direct_minimization_relax {
        let mut m = backend.copy_m(node_count)?;
        let mut h_eff = backend.copy_h_eff(node_count)?;
        let mut g = tangent_gradient_from_field(&m, &h_eff);
        let mut energy = current_stats.e_total;
        let mut p: Vec<[f64; 3]> = g.iter().map(|gi| scale_vec3(*gi, -1.0)).collect();

        let mut lambda: f64 = 1e-6;
        let lambda_min: f64 = 1e-15;
        let lambda_max: f64 = 1e-3;
        let c_armijo: f64 = 1e-4;
        let max_backtrack: u32 = 20;
        let mut use_bb1 = true;
        let mut reset_consecutive: u64 = 0;
        let mut direct_step: u64 = 0;

        while direct_step < control.stop.max_steps.unwrap_or(u64::MAX) {
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
                        Some(backend.copy_live_preview_field(&request, node_count)?)
                    } else {
                        None
                    };
                    let cached_preview_fields = if preview_due {
                        build_fem_cached_preview_fields(
                            &backend,
                            &display_selection,
                            plan,
                            node_count,
                        )
                    } else {
                        None
                    };
                    if current_stats.step <= 2 || preview_due {
                        eprintln!(
                            "[fullmag-runner] native-fem bootstrap live update step={} every_n={} preview_due={} preview_quantity={} preview_field={} cached_preview_fields={} global_scalar={} mag_len={}",
                            current_stats.step,
                            u64::from(display_selection.selection.every_n.max(1)),
                            preview_due,
                            display_selection.selection.quantity.as_str(),
                            preview_field.is_some(),
                            cached_preview_fields
                                .as_ref()
                                .map(|fields| fields.len())
                                .unwrap_or(0),
                            preview_targets_global_scalar,
                            node_count.saturating_mul(3),
                        );
                    }
                    let action = (live.on_step)(StepUpdate {
                        stats: current_stats.clone(),
                        grid: live.grid,
                        fem_mesh: Some(crate::types::FemMeshPayload::from(plan)),
                        magnetization: Some(flatten_vectors(&m)),
                        preview_field,
                        cached_preview_fields,
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

            let max_torque = max_torque_from_field(&m, &h_eff);
            if control
                .stop
                .torque_tolerance_apm
                .is_some_and(|threshold| max_torque <= threshold)
            {
                break;
            }
            let g_norm_sq = global_dot_vec3(&g, &g);
            if g_norm_sq < 1e-30 {
                break;
            }

            let mut trial_lambda = lambda;
            let mut backtracks = 0u32;
            let mut m_trial = m.clone();
            let trial_stats = match control.algorithm {
                fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb => {
                    let trial_stats = loop {
                        for i in 0..m.len() {
                            m_trial[i] =
                                normalized_vec3(sub_vec3(m[i], scale_vec3(g[i], trial_lambda)));
                        }
                        backend.upload_magnetization(&m_trial)?;
                        let mut stats = backend.snapshot_step_stats(node_count)?;
                        ensure_fem_object_scalars(&mut stats, plan);
                        let e_trial = stats.e_total;
                        if e_trial <= energy - c_armijo * trial_lambda * g_norm_sq
                            || backtracks >= max_backtrack
                        {
                            break stats;
                        }
                        trial_lambda *= 0.5;
                        backtracks += 1;
                    };

                    let h_eff_new = backend.copy_h_eff(node_count)?;
                    let g_new = tangent_gradient_from_field(&m_trial, &h_eff_new);

                    let scale_factor = 1e-6;
                    let s: Vec<[f64; 3]> = (0..m.len())
                        .map(|i| scale_vec3(sub_vec3(m_trial[i], m[i]), scale_factor))
                        .collect();
                    let y: Vec<[f64; 3]> = (0..m.len())
                        .map(|i| scale_vec3(sub_vec3(g_new[i], g[i]), scale_factor))
                        .collect();
                    let s_dot_s = global_dot_vec3(&s, &s);
                    let s_dot_y = global_dot_vec3(&s, &y);
                    let y_dot_y = global_dot_vec3(&y, &y);

                    let bb_ok;
                    if use_bb1 {
                        if s_dot_y > 1e-30 {
                            lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
                            bb_ok = true;
                        } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
                            lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                            bb_ok = true;
                        } else {
                            bb_ok = false;
                        }
                    } else if s_dot_y * y_dot_y > 0.0 && y_dot_y.abs() > 1e-30 {
                        lambda = (s_dot_y / y_dot_y).clamp(lambda_min, lambda_max);
                        bb_ok = true;
                    } else if s_dot_y > 1e-30 {
                        lambda = (s_dot_s / s_dot_y).clamp(lambda_min, lambda_max);
                        bb_ok = true;
                    } else {
                        bb_ok = false;
                    }
                    if bb_ok {
                        reset_consecutive = 0;
                    } else {
                        reset_consecutive += 1;
                        lambda = (reset_consecutive as f64 * lambda_min).min(lambda_max);
                    }
                    use_bb1 = !use_bb1;

                    h_eff = h_eff_new;
                    g = g_new;
                    trial_stats
                }
                fullmag_ir::RelaxationAlgorithmIR::NonlinearCg => {
                    let mut p_dot_g = global_dot_vec3(&p, &g);
                    if p_dot_g >= 0.0 {
                        p = g.iter().map(|gi| scale_vec3(*gi, -1.0)).collect();
                        p_dot_g = global_dot_vec3(&p, &g);
                    }
                    let p_norm = global_dot_vec3(&p, &p).sqrt();
                    trial_lambda = if p_norm > 0.0 {
                        (1e-6_f64).min(1.0 / p_norm)
                    } else {
                        1e-6
                    };
                    let max_backtrack_ncg = 30u32;

                    let trial_stats = loop {
                        for i in 0..m.len() {
                            m_trial[i] =
                                normalized_vec3(add_vec3(m[i], scale_vec3(p[i], trial_lambda)));
                        }
                        backend.upload_magnetization(&m_trial)?;
                        let mut stats = backend.snapshot_step_stats(node_count)?;
                        ensure_fem_object_scalars(&mut stats, plan);
                        let e_trial = stats.e_total;
                        if e_trial <= energy + c_armijo * trial_lambda * p_dot_g
                            || backtracks >= max_backtrack_ncg
                        {
                            break stats;
                        }
                        trial_lambda *= 0.5;
                        backtracks += 1;
                    };

                    let h_eff_new = backend.copy_h_eff(node_count)?;
                    let g_new = tangent_gradient_from_field(&m_trial, &h_eff_new);
                    let g_old_transported = project_tangent(&m_trial, &g);
                    let y_pr: Vec<[f64; 3]> = (0..m.len())
                        .map(|i| sub_vec3(g_new[i], g_old_transported[i]))
                        .collect();
                    let mut beta = if g_norm_sq > 1e-30 {
                        (global_dot_vec3(&g_new, &y_pr) / g_norm_sq).max(0.0)
                    } else {
                        0.0
                    };
                    let restart_interval = 50u64;
                    if (direct_step + 1) % restart_interval == 0 {
                        beta = 0.0;
                    }
                    let p_transported = project_tangent(&m_trial, &p);
                    let mut p_new: Vec<[f64; 3]> = (0..m.len())
                        .map(|i| {
                            add_vec3(
                                scale_vec3(g_new[i], -1.0),
                                scale_vec3(p_transported[i], beta),
                            )
                        })
                        .collect();
                    if global_dot_vec3(&p_new, &g_new) >= 0.0 {
                        p_new = g_new.iter().map(|gi| scale_vec3(*gi, -1.0)).collect();
                    }

                    p = p_new;
                    h_eff = h_eff_new;
                    g = g_new;
                    lambda = trial_lambda;
                    trial_stats
                }
                _ => break,
            };

            let prev_energy = energy;
            m = m_trial;
            energy = trial_stats.e_total;
            direct_step += 1;

            let mut accepted_stats = trial_stats.clone();
            accepted_stats.step = direct_step;
            accepted_stats.time = 0.0;
            accepted_stats.dt = trial_lambda;
            let torque_apm = max_torque_from_field(&m, &h_eff);
            accepted_stats.max_dm_dt = 0.0; // direct minimization has no dm/dt
            accepted_stats.max_torque_Apm = torque_apm;
            accepted_stats.max_torque_T = torque_apm * crate::MU0;
            accepted_stats.max_h_eff = h_eff
                .iter()
                .map(|h| (h[0] * h[0] + h[1] * h[1] + h[2] * h[2]).sqrt())
                .fold(0.0, f64::max);
            ensure_fem_object_scalars(&mut accepted_stats, plan);

            artifacts.record_scalar(&accepted_stats)?;
            steps.push(accepted_stats.clone());
            latest_stats = Some(accepted_stats.clone());
            current_stats = accepted_stats;

            if cancelled {
                break;
            }

            let energy_delta = (prev_energy - energy).abs();
            let torque = max_torque_from_field(&m, &h_eff);
            if relaxation_stop_criteria_satisfied(control, Some(energy_delta), torque) {
                break;
            }
        }
    } else {
        let until_label = if until_seconds.is_finite() {
            format!("{until_seconds:.4e}")
        } else {
            "unbounded".to_string()
        };
        eprintln!(
            "[fullmag-runner] native-fem LLG loop: until={} dt_initial={:.4e} \
             max_steps={} torque_tol={:.4e} adaptive={}",
            until_label,
            dt,
            plan.relaxation
                .as_ref()
                .and_then(|c| c.stop.max_steps)
                .unwrap_or(0),
            plan.relaxation
                .as_ref()
                .and_then(|c| c.stop.torque_tolerance_apm)
                .unwrap_or(0.0),
            !dt_is_fixed,
        );
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
                        Some(backend.copy_live_preview_field(&request, node_count)?)
                    } else {
                        None
                    };
                    let cached_preview_fields = if preview_due {
                        build_fem_cached_preview_fields(
                            &backend,
                            &display_selection,
                            plan,
                            node_count,
                        )
                    } else {
                        None
                    };
                    let action = (live.on_step)(StepUpdate {
                        stats: current_stats.clone(),
                        grid: live.grid,
                        fem_mesh: (current_stats.step == 0)
                            .then_some(crate::types::FemMeshPayload::from(plan)),
                        magnetization: Some(flatten_vectors(&backend.copy_m(node_count)?)),
                        preview_field,
                        cached_preview_fields,
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

            let dt_step = dt.min(until_seconds - current_time);
            let interrupt_requested = live
                .as_ref()
                .and_then(|consumer| consumer.interrupt_requested);
            let Some(mut stats) = backend.step_interruptible(dt_step, interrupt_requested)? else {
                continue;
            };
            ensure_fem_object_scalars(&mut stats, plan);
            current_time = stats.time;
            // Feed back the suggested next dt so the adaptive stepper can grow/shrink
            // across outer loop iterations (mirrors fem_reference.rs behaviour).
            if !dt_is_fixed {
                if let Some(s) = stats.dt_suggested {
                    dt = s;
                } else if stats.dt > 0.0 {
                    dt = stats.dt;
                }
            }
            latest_stats = Some(stats.clone());
            current_stats = stats.clone();
            if let Some(live) = live.as_mut() {
                let heavy_payload_every = live.field_every_n.max(1);
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
                let magnetization = if stats.step % heavy_payload_every == 0 {
                    Some(flatten_vectors(&backend.copy_m(node_count)?))
                } else {
                    None
                };
                let preview_field = if preview_due && !preview_targets_global_scalar {
                    let selection = display_selection.as_ref().expect("checked preview_due");
                    let request = selection.preview_request();
                    Some(backend.copy_live_preview_field(&request, node_count)?)
                } else {
                    None
                };
                let cached_preview_fields = if preview_due {
                    display_selection.as_ref().and_then(|sel| {
                        build_fem_cached_preview_fields(&backend, sel, plan, node_count)
                    })
                } else {
                    None
                };
                if stats.step <= 2 || preview_due {
                    eprintln!(
                        "[fullmag-runner] native-fem live update step={} every_n={} preview_due={} preview_quantity={} preview_field={} cached_preview_fields={} global_scalar={} mag_len={}",
                        stats.step,
                        display_selection
                            .as_ref()
                            .map(|selection| u64::from(selection.selection.every_n.max(1)))
                            .unwrap_or(0),
                        preview_due,
                        display_selection
                            .as_ref()
                            .map(|selection| selection.selection.quantity.as_str())
                            .unwrap_or("-"),
                        preview_field.is_some(),
                        cached_preview_fields
                            .as_ref()
                            .map(|fields| fields.len())
                            .unwrap_or(0),
                        preview_targets_global_scalar,
                        magnetization
                            .as_ref()
                            .map(|values| values.len())
                            .unwrap_or(0),
                    );
                }
                let action = (live.on_step)(StepUpdate {
                    stats: stats.clone(),
                    grid: live.grid,
                    fem_mesh: Some(crate::types::FemMeshPayload::from(plan)),
                    magnetization,
                    preview_field,
                    cached_preview_fields,
                    scalar_row_due: preview_due && preview_targets_global_scalar,
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
            if default_scalar_trace || scalar_schedules.is_empty() {
                artifacts.record_scalar(&stats)?;
                steps.push(stats);
            } else {
                artifacts.record_scalar(&stats)?;
                steps.push(stats);
            }
            let latest = steps.last().expect("just pushed stats");
            let stop_for_relaxation = if let Some(control) = plan.relaxation.as_ref() {
                if let Some(completion) = backend.stage_completion()? {
                    backend_completion = Some(completion);
                    true
                } else {
                    let max_steps_hit = latest.step >= control.stop.max_steps.unwrap_or(u64::MAX);
                    let converged = relaxation_converged(
                        control,
                        latest,
                        previous_total_energy,
                        plan.gyromagnetic_ratio,
                        plan.material.damping,
                        false,
                    );
                    if max_steps_hit || converged {
                        eprintln!(
                            "[fullmag-runner] native-fem relaxation stop at step {}: \
                             max_steps_hit={max_steps_hit} (step={} >= max_steps={}), \
                             converged={converged} \
                             (max_torque_T={:.4e} torque_tol={} energy_tol={})",
                            latest.step,
                            latest.step,
                            control
                                .stop
                                .max_steps
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "none".to_string()),
                            latest.max_torque_T,
                            control
                                .stop
                                .torque_tolerance_apm
                                .map(|value| format!("{value:.4e}"))
                                .unwrap_or_else(|| "none".to_string()),
                            control
                                .stop
                                .energy_tolerance_j
                                .map(|value| format!("{value:.4e}"))
                                .unwrap_or_else(|| "none".to_string()),
                        );
                    }
                    max_steps_hit || converged
                }
            } else {
                false
            };
            previous_total_energy = Some(latest.e_total);
            if stop_for_relaxation {
                break;
            }
        }
        if !cancelled {
            let until_label = if until_seconds.is_finite() {
                format!("{until_seconds:.4e}")
            } else {
                "unbounded".to_string()
            };
            eprintln!(
                "[fullmag-runner] native-fem loop exited: time={:.4e} until={} (time_limit_reached={})",
                current_time,
                until_label,
                current_time >= until_seconds,
            );
        }
    }

    let mut final_stats = latest_stats.unwrap_or(StepStats {
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
    ensure_fem_object_scalars(&mut final_stats, plan);

    for schedule in &mut field_schedules {
        let values = match schedule.name.as_str() {
            "m" => backend.copy_m(node_count)?,
            "H_ex" => backend.copy_h_ex(node_count)?,
            "H_demag" => backend.copy_h_demag(node_count)?,
            "H_ext" => backend.copy_h_ext(node_count)?,
            "H_eff" => backend.copy_h_eff(node_count)?,
            other => {
                return Err(RunError {
                    message: format!("unsupported native FEM field snapshot '{}'", other),
                })
            }
        };
        artifacts.record_field_snapshot(FieldSnapshot {
            name: schedule.name.clone(),
            step: final_stats.step,
            time: final_stats.time,
            solver_dt: final_stats.dt,
            values,
        })?;
    }

    let final_magnetization = backend.copy_m(node_count)?;
    let (field_snapshots, field_snapshot_count, provenance) = artifacts.finish();
    let status = if cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let completion = if let Some(mut completion) = backend_completion {
        completion.status = match status {
            RunStatus::Completed => "completed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Paused => "paused",
            RunStatus::Failed => "failed",
        }
        .to_string();
        completion
    } else {
        crate::relaxation::infer_stage_completion(
            status,
            plan.relaxation.as_ref(),
            &steps,
            plan.gyromagnetic_ratio,
            plan.material.damping,
            llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
        )
    };

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
        auxiliary_artifacts: Vec::new(),
        provenance,
    })
}

#[cfg(not(feature = "fem-gpu"))]
fn execute_native_fem(
    _plan: &FemPlanIR,
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
fn flatten_vectors(values: &[[f64; 3]]) -> Vec<f64> {
    values
        .iter()
        .flat_map(|vector| vector.iter().copied())
        .collect()
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn dot_vec3(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn add_vec3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn sub_vec3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn scale_vec3(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn normalized_vec3(v: [f64; 3]) -> [f64; 3] {
    let n2 = dot_vec3(v, v);
    if n2 <= 0.0 {
        [0.0, 0.0, 0.0]
    } else {
        let inv = 1.0 / n2.sqrt();
        [v[0] * inv, v[1] * inv, v[2] * inv]
    }
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn tangent_gradient_from_field(magnetization: &[[f64; 3]], h_eff: &[[f64; 3]]) -> Vec<[f64; 3]> {
    magnetization
        .iter()
        .zip(h_eff.iter())
        .map(|(m, h)| {
            let projected = sub_vec3(*h, scale_vec3(*m, dot_vec3(*m, *h)));
            scale_vec3(projected, -1.0)
        })
        .collect()
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn global_dot_vec3(a: &[[f64; 3]], b: &[[f64; 3]]) -> f64 {
    a.iter()
        .zip(b.iter())
        .map(|(ai, bi)| dot_vec3(*ai, *bi))
        .sum()
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn project_tangent(m: &[[f64; 3]], v: &[[f64; 3]]) -> Vec<[f64; 3]> {
    m.iter()
        .zip(v.iter())
        .map(|(mi, vi)| sub_vec3(*vi, scale_vec3(*mi, dot_vec3(*mi, *vi))))
        .collect()
}

#[cfg(any(feature = "cuda", feature = "fem-gpu"))]
fn max_torque_from_field(magnetization: &[[f64; 3]], h_eff: &[[f64; 3]]) -> f64 {
    magnetization
        .iter()
        .zip(h_eff.iter())
        .map(|(m, h)| {
            let cross = [
                m[1] * h[2] - m[2] * h[1],
                m[2] * h[0] - m[0] * h[2],
                m[0] * h[1] - m[1] * h[0],
            ];
            (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt()
        })
        .fold(0.0, f64::max)
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
            let values = match name.as_str() {
                "m" => backend.copy_m(cell_count)?,
                "H_ex" => backend.copy_h_ex(cell_count)?,
                "H_demag" => backend.copy_h_demag(cell_count)?,
                "H_ext" => backend.copy_h_ext(cell_count)?,
                "H_eff" => backend.copy_h_eff(cell_count)?,
                other => {
                    return Err(RunError {
                        message: format!("unsupported CUDA field snapshot '{}'", other),
                    })
                }
            };
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: 0,
                time: 0.0,
                solver_dt: 0.0,
                values,
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
    scalar_schedules: &mut [OutputSchedule],
    field_schedules: &mut [OutputSchedule],
    steps: &mut Vec<StepStats>,
    artifacts: &mut ArtifactRecorder,
) -> Result<(), RunError> {
    let scalar_due = scalar_schedules
        .iter()
        .any(|schedule| is_due(stats.time, schedule.next_time));
    if scalar_due {
        artifacts.record_scalar(stats)?;
        steps.push(stats.clone());
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
            let values = match name.as_str() {
                "m" => backend.copy_m(cell_count)?,
                "H_ex" => backend.copy_h_ex(cell_count)?,
                "H_demag" => backend.copy_h_demag(cell_count)?,
                "H_ext" => backend.copy_h_ext(cell_count)?,
                "H_eff" => backend.copy_h_eff(cell_count)?,
                other => {
                    return Err(RunError {
                        message: format!("unsupported CUDA field snapshot '{}'", other),
                    })
                }
            };
            artifacts.record_field_snapshot(FieldSnapshot {
                name: name.clone(),
                step: stats.step,
                time: stats.time,
                solver_dt: stats.dt,
                values,
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

    let need_scalar = default_scalar_trace
        || steps
            .last()
            .map(|stats| !same_time(stats.time, latest_stats.time))
            .unwrap_or(true);
    if need_scalar {
        let mut final_stats = latest_stats.clone();
        if scalar_outputs_request_average_m(scalar_schedules) {
            let magnetization = backend.copy_m(cell_count)?;
            apply_average_m_to_step_stats(&mut final_stats, &magnetization);
        }
        artifacts.record_scalar(&final_stats)?;
        steps.push(final_stats);
    }

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
            let values = match name.as_str() {
                "m" => backend.copy_m(cell_count)?,
                "H_ex" => backend.copy_h_ex(cell_count)?,
                "H_demag" => backend.copy_h_demag(cell_count)?,
                "H_ext" => backend.copy_h_ext(cell_count)?,
                "H_eff" => backend.copy_h_eff(cell_count)?,
                other => {
                    return Err(RunError {
                        message: format!("unsupported CUDA field snapshot '{}'", other),
                    })
                }
            };
            artifacts.record_field_snapshot(FieldSnapshot {
                name,
                step: latest_stats.step,
                time: latest_stats.time,
                solver_dt: latest_stats.dt,
                values,
            })?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        AntennaIR, BackendTarget, CurrentModuleIR, CurrentTransportModelIR, DiscretizationHintsIR,
        FdmHintsIR, FemHintsIR, FemMeshPartIR, FemMeshPartRole, FemMeshPartSelector,
        FemObjectSegmentIR, FemPlanIR, MeshIR, ProblemIR, RfDriveIR,
    };
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
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

    fn tiny_fem_plan() -> FemPlanIR {
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
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
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
            },
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            current_modules: Vec::new(),
            gyromagnetic_ratio: 2.211e5,
            precision: fullmag_ir::ExecutionPrecision::Double,
            exchange_bc: fullmag_ir::ExchangeBoundaryCondition::Neumann,
            integrator: fullmag_ir::IntegratorChoice::Heun,
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
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            dmi_interface_normal: None,
            use_consistent_mass: None,
        }
    }

    #[test]
    fn forced_fem_gpu_without_backend_surfaces_reason() {
        let _guard = env_lock().lock().expect("env mutex");
        let problem = fem_policy_problem();
        unsafe {
            std::env::set_var("FULLMAG_FEM_EXECUTION", "gpu");
            std::env::remove_var("FULLMAG_FEM_GPU_INDEX");
            std::env::remove_var("FULLMAG_CUDA_DEVICE_INDEX");
        }
        let result = resolve_fem_engine(&problem);
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        let err = result.expect_err("missing fem-gpu backend should be surfaced");
        assert!(err
            .message
            .contains("native FEM GPU backend is not available"));
        assert!(err.message.contains("reason") || err.message.contains("without"));
    }

    #[test]
    fn requested_fem_gpu_without_backend_records_fallback_trail() {
        let _guard = env_lock().lock().expect("env mutex");
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
            std::env::remove_var("FULLMAG_FEM_GPU_INDEX");
            std::env::remove_var("FULLMAG_CUDA_DEVICE_INDEX");
        }
        let resolution = resolve_fem_engine_with_trail(&fem_policy_problem())
            .expect("resolution should succeed");
        assert_eq!(resolution.engine, FemEngine::CpuNative);
        let fallback = resolution.fallback.expect("fallback should be present");
        assert!(fallback.occurred);
        assert_eq!(fallback.original_engine, "fem_native_gpu");
        assert_eq!(fallback.fallback_engine, "fem_cpu_native");
        assert_eq!(fallback.reason, "native_fem_gpu_unavailable");
    }

    #[cfg(not(feature = "fem-gpu"))]
    #[test]
    fn time_domain_fem_without_mfem_backend_fails_early() {
        let err = resolve_fem_engine_for_plan_with_trail(&fem_policy_problem(), &tiny_fem_plan())
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
    fn forced_fem_gpu_rejects_current_modules() {
        let _guard = env_lock().lock().expect("env mutex");
        let mut problem = fem_policy_problem();
        problem
            .current_modules
            .push(CurrentModuleIR::AntennaFieldSource {
                name: "src".to_string(),
                solver: "fdtd".to_string(),
                antenna: AntennaIR::Microstrip {
                    width: 1.0,
                    thickness: 1.0,
                    height_above_magnet: 1.0,
                    preview_length: 1.0,
                    center_x: 0.0,
                    center_y: 0.0,
                    current_distribution: "uniform".to_string(),
                },
                drive: RfDriveIR {
                    current_a: 1.0,
                    waveform: None,
                },
                air_box_factor: 2.0,
            });
        unsafe {
            std::env::set_var("FULLMAG_FEM_EXECUTION", "gpu");
        }
        let result = resolve_fem_engine(&problem);
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        let err = result.expect_err("current modules must reject forced GPU");
        assert!(err.message.contains("current_modules_force_cpu"));
    }

    #[test]
    fn prescribed_current_transport_does_not_force_cpu_fallback() {
        let _guard = env_lock().lock().expect("env mutex");
        let mut problem = fem_policy_problem();
        problem
            .current_modules
            .push(CurrentModuleIR::CurrentTransport {
                name: "drive".to_string(),
                model: CurrentTransportModelIR::PrescribedDensity,
                current_density: Some([0.0, 0.0, 5e10]),
                solve_region: Some("free".to_string()),
                conductivity_s_per_m: None,
            });

        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        let resolution =
            resolve_fem_engine_with_trail(&problem).expect("prescribed transport should resolve");
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
        assert_eq!(
            should_fallback_to_cpu_for_small_fem_gpu(&tiny_fem_plan()),
            None
        );

        unsafe {
            std::env::set_var("FULLMAG_FEM_GPU_MIN_NODES", "10");
        }
        assert_eq!(
            should_fallback_to_cpu_for_small_fem_gpu(&tiny_fem_plan()),
            Some(10)
        );

        unsafe {
            std::env::remove_var("FULLMAG_FEM_GPU_MIN_NODES");
        }
    }

    #[test]
    fn normalized_runtime_markers_fallback_to_object_segments_when_region_materials_missing() {
        let mut plan = tiny_fem_plan();
        plan.mesh.elements = vec![[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]];
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
        plan.mesh.elements = vec![[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]];
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
        plan.mesh.elements = vec![[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]];
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
                surface_faces: Vec::new(),
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
                surface_faces: Vec::new(),
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
                surface_faces: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
        ];

        let normalized =
            normalized_runtime_element_markers(&plan).expect("mesh_parts should disambiguate");
        assert_eq!(normalized, vec![1, 1, 0]);
    }
}
