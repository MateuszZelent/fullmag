#![recursion_limit = "256"]

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
#[cfg(feature = "stage-autosave-hdf5")]
pub mod autosave_hdf5;
pub mod autosave_storage;
pub mod autosave_txt;
pub mod autosave_zarr;
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
mod frequency_response;
pub mod hysteresis;
pub mod interactive;
mod interactive_runtime;
mod native_fem;
mod preview;
pub mod quantities;
mod regional_field_drive_artifacts;
mod relaxation;
pub mod runtime_registry;
mod scalar_metrics;
mod schedules;
mod solver_profile;
mod solver_runtime;
pub mod spin_wave_response;
pub mod spin_wave_sampling;
pub mod table_autosave;
mod timestep_qualification;
mod time_dependence;
mod time_events;
mod types;

use types::TimestepExecutionLane;

// ── Shared runner defaults (FEM-040) ─────────────────────────────────────
#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
pub(crate) const NON_LLG_RELAXATION_ABI_DT_PLACEHOLDER: f64 = 1e-13;

/// Default initial timestep seed when adaptive stepping has no meaningful seed.
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

pub(crate) fn resolve_timestep_policy(
    integrator: Option<fullmag_ir::IntegratorChoice>,
    fixed_timestep: Option<f64>,
    adaptive_timestep: Option<&fullmag_ir::AdaptiveTimeStepIR>,
    execution_lane: TimestepExecutionLane,
) -> Result<TimestepPolicyProvenance, RunError> {
    use fullmag_ir::IntegratorChoice;

    let integrator = integrator.ok_or_else(|| RunError {
        message: "timestep policy requires an explicit integrator".to_string(),
    })?;
    match (fixed_timestep, adaptive_timestep) {
        (Some(_), Some(_)) | (None, None) => Err(RunError {
            message: "timestep policy requires exactly one of fixed_timestep or adaptive_timestep"
                .to_string(),
        }),
        (Some(timestep_s), None) => {
            if !timestep_s.is_finite() || timestep_s <= 0.0 {
                return Err(RunError {
                    message: "fixed_timestep must be finite and positive".to_string(),
                });
            }
            Ok(TimestepPolicyProvenance {
                requested: RequestedTimestepPolicy::Fixed {
                    integrator,
                    timestep_s,
                },
                resolved: ResolvedTimestepPolicy::Fixed {
                    integrator,
                    timestep_s,
                },
                execution_identity: resolve_timestep_execution_identity(
                    execution_lane,
                    integrator,
                    false,
                    None,
                    None,
                )?,
                relaxation_controller: None,
            })
        }
        (None, Some(adaptive)) => {
            let estimator_order = match integrator {
                IntegratorChoice::Rk23 => 2,
                IntegratorChoice::Rk45 => 4,
                _ => {
                    return Err(RunError {
                        message: format!(
                            "adaptive timestep requires rk23 or rk45, got {integrator:?}"
                        ),
                    });
                }
            };
            let dt_max_s = adaptive.dt_max.ok_or_else(|| RunError {
                message: "adaptive timestep requires explicit dt_max".to_string(),
            })?;
            if !adaptive.dt_min.is_finite()
                || adaptive.dt_min <= 0.0
                || !dt_max_s.is_finite()
                || dt_max_s < adaptive.dt_min
            {
                return Err(RunError {
                    message: "adaptive timestep requires 0 < dt_min <= dt_max".to_string(),
                });
            }
            if !adaptive.atol.is_finite()
                || adaptive.atol < 0.0
                || !adaptive.rtol.is_finite()
                || adaptive.rtol < 0.0
                || (adaptive.atol == 0.0 && adaptive.rtol == 0.0)
            {
                return Err(RunError {
                    message: "adaptive tolerances must be finite, non-negative, and not both zero"
                        .to_string(),
                });
            }
            if matches!(
                adaptive.tolerance_mode,
                fullmag_ir::AdaptiveToleranceModeIR::MaxError
            ) && (adaptive.atol <= 0.0 || adaptive.rtol != 0.0)
            {
                return Err(RunError {
                    message: "max_error tolerance mode requires atol > 0 and rtol == 0".to_string(),
                });
            }
            if !adaptive.safety.is_finite()
                || adaptive.safety <= 0.0
                || adaptive.safety > 1.0
                || !adaptive.growth_limit.is_finite()
                || adaptive.growth_limit <= 1.0
                || !adaptive.shrink_limit.is_finite()
                || adaptive.shrink_limit <= 0.0
                || adaptive.shrink_limit >= 1.0
            {
                return Err(RunError {
                    message: "adaptive controller requires 0 < safety <= 1, growth_limit > 1, and 0 < shrink_limit < 1"
                        .to_string(),
                });
            }
            if adaptive
                .max_spin_rotation
                .is_some_and(|value| !value.is_finite() || value <= 0.0)
                || adaptive
                    .norm_tolerance
                    .is_some_and(|value| !value.is_finite() || value <= 0.0)
            {
                return Err(RunError {
                    message: "adaptive guards must be finite and positive".to_string(),
                });
            }
            let (dt_initial_s, dt_initial_reason) = match adaptive.dt_initial {
                Some(value) => (value, InitialTimestepReason::Explicit),
                None => (adaptive.dt_min, InitialTimestepReason::DtMinDefault),
            };
            if !dt_initial_s.is_finite()
                || dt_initial_s < adaptive.dt_min
                || dt_initial_s > dt_max_s
            {
                return Err(RunError {
                    message: "adaptive dt_initial must satisfy dt_min <= dt_initial <= dt_max"
                        .to_string(),
                });
            }
            Ok(TimestepPolicyProvenance {
                requested: RequestedTimestepPolicy::Adaptive {
                    integrator,
                    tolerance_mode: adaptive.tolerance_mode,
                    atol: adaptive.atol,
                    rtol: adaptive.rtol,
                    dt_initial_s: adaptive.dt_initial,
                    dt_min_s: adaptive.dt_min,
                    dt_max_s,
                    safety: adaptive.safety,
                    growth_limit: adaptive.growth_limit,
                    shrink_limit: adaptive.shrink_limit,
                    max_spin_rotation: adaptive.max_spin_rotation,
                    norm_tolerance: adaptive.norm_tolerance,
                },
                resolved: ResolvedTimestepPolicy::Adaptive {
                    integrator,
                    estimator_order,
                    tolerance_mode: adaptive.tolerance_mode,
                    atol: adaptive.atol,
                    rtol: adaptive.rtol,
                    dt_initial_s,
                    dt_initial_reason,
                    dt_min_s: adaptive.dt_min,
                    dt_max_s,
                    safety: adaptive.safety,
                    growth_limit: adaptive.growth_limit,
                    shrink_limit: adaptive.shrink_limit,
                    max_spin_rotation: adaptive.max_spin_rotation,
                    norm_tolerance: adaptive.norm_tolerance,
                },
                execution_identity: resolve_timestep_execution_identity(
                    execution_lane,
                    integrator,
                    true,
                    None,
                    None,
                )?,
                relaxation_controller: None,
            })
        }
    }
}

fn resolve_timestep_execution_identity(
    lane: TimestepExecutionLane,
    integrator: fullmag_ir::IntegratorChoice,
    adaptive: bool,
    qualification_artifact_sha256: Option<&str>,
    runtime_source_inputs_sha256: Option<&str>,
) -> Result<TimestepExecutionIdentity, RunError> {
    use fullmag_ir::ExecutionPrecision::{Double, Single};
    use LlgTimestepQualificationId::*;
    use TimestepBackend::{Fdm, Fem};
    use TimestepDevice::{Cpu, Cuda, Gpu};

    let qualification_id = match (adaptive, lane.backend, lane.device, lane.precision) {
        (false, Fdm, Cpu, Double) => ExplicitFixedFdmCpuDouble,
        (false, Fdm, Cuda, Double) => ExplicitFixedFdmCudaDouble,
        (false, Fdm, Cuda, Single) => ExplicitFixedFdmCudaSingle,
        (false, Fem, Cpu, Double) => ExplicitFixedFemCpuDouble,
        (false, Fem, Gpu, Double) => ExplicitFixedFemGpuDouble,
        (true, Fdm, Cpu, Double) => ExplicitAdaptiveFdmCpuDouble,
        (true, Fem, Cpu, Double) => ExplicitAdaptiveFemCpuDouble,
        (true, Fem, Gpu, Double) => ExplicitAdaptiveFemGpuDouble,
        _ => {
            return Err(RunError {
                message: format!(
                    "no executable LLG timestep capability row for adaptive={adaptive}, backend={:?}, device={:?}, precision={:?}",
                    lane.backend, lane.device, lane.precision
                ),
            });
        }
    };

    let lookup = TimestepExecutionIdentityKey {
        capability_id: LlgTimestepCapabilityId::LlgTdPolicyV1,
        qualification_id,
        backend: lane.backend,
        device: lane.device,
        precision: lane.precision,
        integrator,
        timestep_policy: if adaptive {
            TimestepPolicyKind::Adaptive
        } else {
            TimestepPolicyKind::Fixed
        },
        qualification_artifact_sha256: qualification_artifact_sha256.map(str::to_string),
    };
    let resolution = timestep_qualification::qualification_resolution_for(
        &lookup,
        runtime_source_inputs_sha256.unwrap_or_default(),
    );
    Ok(TimestepExecutionIdentity {
        capability_id: lookup.capability_id,
        qualification_id: lookup.qualification_id,
        backend: lookup.backend,
        device: lookup.device,
        precision: lookup.precision,
        integrator: lookup.integrator,
        timestep_policy: lookup.timestep_policy,
        validation_state: resolution.state,
        qualification_registry_version:
            timestep_qualification::QUALIFICATION_REGISTRY_VERSION.to_string(),
        qualification_artifact_sha256: resolution.artifact_sha256,
        runtime_source_inputs_sha256: resolution.runtime_source_inputs_sha256,
        validated_scope: resolution.validated_scope,
        qualification_validated_at: resolution.validated_at,
        qualification_validator_schema: resolution.validator_schema,
    })
}

/// Build the fail-closed LLG qualification identity exposed to runtime/API
/// diagnostics. This never promotes from the engine name: without an exact
/// artifact and managed-runtime source binding the registry resolver returns
/// `Unvalidated`.
pub fn timestep_qualification_for_plan(
    plan: &fullmag_ir::ExecutionPlanIR,
    resolved_device: &str,
) -> Option<TimestepExecutionIdentity> {
    timestep_qualification_for_plan_with_binding(plan, resolved_device, None, None)
}

/// Resolve the fail-closed LLG qualification identity with an exact managed
/// qualification artifact and runtime source binding. The binding is kept out
/// of the hot timestep loop; callers provide it once when constructing the
/// execution provenance.
pub fn timestep_qualification_for_plan_with_binding(
    plan: &fullmag_ir::ExecutionPlanIR,
    resolved_device: &str,
    qualification_artifact_sha256: Option<&str>,
    runtime_source_inputs_sha256: Option<&str>,
) -> Option<TimestepExecutionIdentity> {
    let (lane, integrator, fixed, adaptive) = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let device = match resolved_device {
                "cpu" => TimestepDevice::Cpu,
                "cuda" | "gpu" => TimestepDevice::Cuda,
                _ => return None,
            };
            (
                TimestepExecutionLane {
                    backend: TimestepBackend::Fdm,
                    device,
                    precision: fdm.precision,
                },
                fdm.integrator?,
                fdm.fixed_timestep.is_some(),
                fdm.adaptive_timestep.is_some(),
            )
        }
        BackendPlanIR::Fem(fem) => {
            let device = match resolved_device {
                "cpu" => TimestepDevice::Cpu,
                "cuda" | "gpu" => TimestepDevice::Gpu,
                _ => return None,
            };
            (
                TimestepExecutionLane {
                    backend: TimestepBackend::Fem,
                    device,
                    precision: fem.precision,
                },
                fem.integrator?,
                fem.fixed_timestep.is_some(),
                fem.adaptive_timestep.is_some(),
            )
        }
        _ => return None,
    };
    if fixed == adaptive {
        return None;
    }
    resolve_timestep_execution_identity(
        lane,
        integrator,
        adaptive,
        qualification_artifact_sha256,
        runtime_source_inputs_sha256,
    )
    .ok()
}

/// Validate the complete public coupled-M3 checkpoint envelope before any
/// runner or session state is restored.
pub fn validate_coupled_m3_checkpoint_value(
    value: &serde_json::Value,
    vector_count: usize,
) -> Result<(), RunError> {
    fdm::cpu::spin_transport::validate_coupled_m3_checkpoint_value(value, vector_count)
}

/// Require exact bidirectional equality of coupled-M3 accepted module IDs and
/// their runtime identity contracts.
pub fn compare_coupled_m3_checkpoint_module_identity_values(
    actual: &serde_json::Value,
    expected: &serde_json::Value,
) -> Result<(), RunError> {
    fdm::cpu::spin_transport::compare_coupled_m3_checkpoint_module_identity_values(
        actual, expected,
    )
}

// Public re-exports (unchanged API surface).
pub use capabilities::{
    BackendCapabilities, FeatureCapability, FeatureCapabilityStatus, RuntimeEngineId,
    MIXED_P1_FEATURE_CAPABILITY_IDS, MIXED_P1_MESH_FEATURE_CAPABILITY_IDS,
};
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
    current_thread_cpu_time_ns, elapsed_current_thread_cpu_ns, LivePublisherDiagnostics,
    RateMetric, SolverProfileAggregates, SolverProfileConfig, SolverProfileOverheadDiagnostics,
    SolverProfilePhaseSample, SolverProfileSnapshot, SolverProfileState, SolverProfileStepSample,
    SolverProfileThreading, SolverProfileTimingSemantic, SolverProfileTimingSemanticKind,
    SolverRateDiagnostics,
};
pub use timestep_qualification::{
    validation_state_for, TimestepExecutionIdentityKey, TimestepPolicyKind,
    QUALIFICATION_REGISTRY_VERSION,
};
pub use types::{
    fem_eigen_mesh_generation_id, fem_frequency_response_mesh_generation_id,
    fem_mesh_topology_fingerprint, fem_plan_mesh_generation_id, live_preview_values_sha256,
    ExecutionProvenance, FemCrossoverDecision, FemEigenRunResult, FemMeshObjectSegment,
    FemMeshPartPayload, FemMeshPayload, InitialTimestepReason, LegacyDtPolicy,
    LiveFieldMaterializationState, LiveFieldMaterializationStatus, LivePreviewField,
    LivePreviewRequest, LiveVectorFieldSnapshot, LlgTimestepCapabilityId,
    LlgTimestepQualificationId, RequestedTimestepPolicy, ResolvedFallback, ResolvedTimestepPolicy,
    RunError, RunResult, RunStatus, RuntimeEngineInfo, SolverAttemptRecord, StageFemMeshAsset,
    StageFemMeshIdentity, StepAction, StepStats, StepUpdate, TimestepBackend, TimestepDevice,
    TimestepExecutionIdentity, TimestepPolicyProvenance, TimestepValidationState,
};

use crate::capabilities::{
    capabilities_for_fdm_engine, capabilities_for_fem_eigen_engine, capabilities_for_fem_engine,
    capabilities_for_fem_frequency_response_validation_engine,
};
use crate::fdm::cpu::multilayer_reference;
use crate::fdm::cpu::reference as cpu_reference;
use crate::fdm::gpu::cuda::native as native_fdm;
use crate::native_fem::{
    native_frequency_domain_availability, FrequencyDomainAvailabilityRequest,
    FrequencyDomainPhaseConvention, FrequencyDomainStudyKind,
};
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
    pub fem_crossover_decision: Option<FemCrossoverDecision>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainAvailabilitySummary {
    pub status: String,
    pub study_kind: String,
    pub driven_response_available: bool,
    pub modal_solver_available: bool,
    pub static_periodic_response_available: bool,
    pub floquet_modal_available: bool,
    pub floquet_response_available: bool,
    pub dynamic_demag_k_available: bool,
    pub gpu_available: bool,
    pub reason: String,
    pub diagnostics_json: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainCapabilityEntry {
    pub status: String,
    pub reason: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainModalCapabilities {
    pub reference_cpu: FrequencyDomainCapabilityEntry,
    pub production_cpu: FrequencyDomainCapabilityEntry,
    pub production_gpu: FrequencyDomainCapabilityEntry,
    pub k_path: FrequencyDomainCapabilityEntry,
    pub mode_tracking: FrequencyDomainCapabilityEntry,
    pub mode_field_payload: FrequencyDomainCapabilityEntry,
    pub linewidths: FrequencyDomainCapabilityEntry,
    pub absorption_from_modes: FrequencyDomainCapabilityEntry,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainBoundaryCapabilities {
    pub static_periodic: FrequencyDomainCapabilityEntry,
    pub floquet_modal: FrequencyDomainCapabilityEntry,
    pub floquet_response: FrequencyDomainCapabilityEntry,
    pub periodic_pair_diagnostics: FrequencyDomainCapabilityEntry,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainDemagCapabilities {
    pub static_periodic_pbc: FrequencyDomainCapabilityEntry,
    pub floquet_dynamic_k: FrequencyDomainCapabilityEntry,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainDispersionCapabilities {
    pub reference_cpu: FrequencyDomainCapabilityEntry,
    pub production_cpu: FrequencyDomainCapabilityEntry,
    pub production_cpu_gamma_k_path: FrequencyDomainCapabilityEntry,
    pub production_gpu: FrequencyDomainCapabilityEntry,
    pub k_path: FrequencyDomainCapabilityEntry,
    pub branch_tracking: FrequencyDomainCapabilityEntry,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainValidationCapabilities {
    pub fmr_k0: FrequencyDomainCapabilityEntry,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainResponseCapabilities {
    pub magnetic_cpu: FrequencyDomainCapabilityEntry,
    pub magnetic_gpu: FrequencyDomainCapabilityEntry,
    pub frequency_sweep: FrequencyDomainCapabilityEntry,
    pub mode_projected: FrequencyDomainCapabilityEntry,
    pub magnetoelastic_quasistatic: FrequencyDomainCapabilityEntry,
    pub magnetoelastic_elastodynamic: FrequencyDomainCapabilityEntry,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainVisualizationCapabilities {
    pub modal_spectrum_chart: FrequencyDomainCapabilityEntry,
    pub modal_dispersion_chart: FrequencyDomainCapabilityEntry,
    pub mode_table: FrequencyDomainCapabilityEntry,
    pub mode_3d_overlay: FrequencyDomainCapabilityEntry,
    pub response_sweep_chart: FrequencyDomainCapabilityEntry,
    pub response_field_3d_overlay: FrequencyDomainCapabilityEntry,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainCapabilitySnapshot {
    pub schema_version: String,
    pub modal: FrequencyDomainModalCapabilities,
    pub boundary: FrequencyDomainBoundaryCapabilities,
    pub demag: FrequencyDomainDemagCapabilities,
    pub dispersion: FrequencyDomainDispersionCapabilities,
    pub validation: FrequencyDomainValidationCapabilities,
    pub response: FrequencyDomainResponseCapabilities,
    pub visualization: FrequencyDomainVisualizationCapabilities,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FrequencyDomainManifest {
    pub schema_version: String,
    pub existing_frequency_response_namespace_preserved: bool,
    pub family_namespace: String,
    pub eigen_namespace: String,
    pub response: FrequencyDomainAvailabilitySummary,
    pub eigenmodes: FrequencyDomainAvailabilitySummary,
    pub floquet_nonzero_k_response_supported: bool,
    pub floquet_nonzero_k_demag_supported: bool,
    pub capabilities: FrequencyDomainCapabilitySnapshot,
}

pub fn frequency_domain_manifest_v1() -> FrequencyDomainManifest {
    let response = native_frequency_domain_availability(FrequencyDomainAvailabilityRequest {
        study_kind: FrequencyDomainStudyKind::FrequencyResponse,
        requires_driven_solver: true,
        requires_modal_solver: false,
        requires_static_periodic_boundary: false,
        requires_floquet_boundary: false,
        requires_nonzero_k_dynamic_demag: false,
        requires_gpu: false,
        strict_device: false,
        floquet_k_vector_rad_per_m: None,
        phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
    });
    let eigenmodes = native_frequency_domain_availability(FrequencyDomainAvailabilityRequest {
        study_kind: FrequencyDomainStudyKind::Eigenmodes,
        requires_driven_solver: false,
        requires_modal_solver: true,
        requires_static_periodic_boundary: false,
        requires_floquet_boundary: true,
        requires_nonzero_k_dynamic_demag: true,
        requires_gpu: false,
        strict_device: false,
        floquet_k_vector_rad_per_m: Some([1.0, 0.0, 0.0]),
        phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
    });

    FrequencyDomainManifest {
        schema_version: "frequency_domain_manifest.v1".to_string(),
        existing_frequency_response_namespace_preserved: true,
        family_namespace: "frequencyDomain".to_string(),
        eigen_namespace: "eigen".to_string(),
        floquet_nonzero_k_response_supported: response.floquet_response_available,
        floquet_nonzero_k_demag_supported: response.dynamic_demag_k_available
            || eigenmodes.dynamic_demag_k_available,
        response: response.into(),
        eigenmodes: eigenmodes.into(),
        capabilities: frequency_domain_capability_snapshot_v1(),
    }
}

fn capability(status: &str, reason: &str) -> FrequencyDomainCapabilityEntry {
    FrequencyDomainCapabilityEntry {
        status: status.to_string(),
        reason: reason.to_string(),
    }
}

fn frequency_domain_gpu_response_availability_v1() -> crate::native_fem::FrequencyDomainAvailability
{
    native_frequency_domain_availability(FrequencyDomainAvailabilityRequest {
        study_kind: FrequencyDomainStudyKind::FrequencyResponse,
        requires_driven_solver: true,
        requires_modal_solver: false,
        requires_static_periodic_boundary: false,
        requires_floquet_boundary: false,
        requires_nonzero_k_dynamic_demag: false,
        requires_gpu: true,
        strict_device: true,
        floquet_k_vector_rad_per_m: None,
        phase_convention: FrequencyDomainPhaseConvention::ExpIOmegaT,
    })
}

fn magnetic_gpu_capability_from_availability(
    availability: &crate::native_fem::FrequencyDomainAvailability,
) -> FrequencyDomainCapabilityEntry {
    if availability.status == "ok"
        && availability.driven_response_available
        && availability.gpu_available
    {
        return capability(
            "partial_production_executable",
            "native_fem_mfem_frequency_domain_gpu executes gamma/free and k=0 static-periodic driven-response slices with provider-backed dynamic demag and supported P1 DMI; nonzero-k Floquet dynamic demag remains gated",
        );
    }
    capability(
        "unsupported",
        if availability.reason.is_empty() {
            "not implemented in the current production frequency-domain backend"
        } else {
            availability.reason.as_str()
        },
    )
}

fn frequency_domain_capability_snapshot_v1() -> FrequencyDomainCapabilitySnapshot {
    let unsupported = "not implemented in the current production frequency-domain backend";
    let dynamic_demag_k = "nonzero-k Floquet demag requires a phase-aware dynamic demag-k operator";
    let gpu_response = frequency_domain_gpu_response_availability_v1();
    FrequencyDomainCapabilitySnapshot {
        schema_version: "frequency_domain_capabilities.v1".to_string(),
        modal: FrequencyDomainModalCapabilities {
            reference_cpu: capability(
                "reference_executable",
                "runner FEM eigen reference path emits modal artifacts",
            ),
            production_cpu: capability("unsupported", unsupported),
            production_gpu: capability("unsupported", unsupported),
            k_path: capability(
                "reference_executable",
                "runner FEM eigen reference path emits k-path dispersion artifacts",
            ),
            mode_tracking: capability(
                "reference_executable",
                "runner FEM eigen reference path emits branch tracking artifacts",
            ),
            mode_field_payload: capability(
                "reference_executable",
                "mode metadata and binary mode-field payloads are artifact-backed",
            ),
            linewidths: capability(
                "reference_executable",
                "modal artifacts preserve imaginary-frequency linewidth metadata",
            ),
            absorption_from_modes: capability("unsupported", unsupported),
        },
        boundary: FrequencyDomainBoundaryCapabilities {
            static_periodic: capability(
                "partial_production_executable",
                "k=0 static-periodic driven response is production-enforced on the native FEM response lanes when mesh.periodic_node_pairs metadata is present; nonzero-k no-demag Floquet response is a separate phase-projected slice and Floquet dynamic demag-k remains unsupported",
            ),
            floquet_modal: capability(
                "semantic_only",
                "Floquet modal semantics exist, but production operator enforcement is not available",
            ),
            floquet_response: capability(
                "partial_production_executable",
                "driven nonzero-k Floquet response is executable for the no-demag phase-projected tangent slice; dynamic demag-k remains gated",
            ),
            periodic_pair_diagnostics: capability(
                "reference_executable",
                "mesh periodic-pair diagnostics are exposed as session resources",
            ),
        },
        demag: FrequencyDomainDemagCapabilities {
            static_periodic_pbc: capability(
                "semantic_only",
                "static FEM demag PBC semantics are documented but not promoted for frequency-domain production solves",
            ),
            floquet_dynamic_k: capability("unsupported", dynamic_demag_k),
        },
        dispersion: FrequencyDomainDispersionCapabilities {
            reference_cpu: capability(
                "reference_executable",
                "reference/MVP FEM modal k-path dispersion emits spectrum, branches, dispersion.csv, and mode-field artifacts on the CPU reference lane",
            ),
            production_cpu: capability(
                "partial_production_executable",
                "managed native CPU selected-spectrum no-demag Full2x2 Floquet k-path dispersion is executable for the labelled Bloch/Floquet tangent payload slice; dynamic demag-k, broader sparse/matrix-free validation, and production GPU remain gated",
            ),
            production_cpu_gamma_k_path: capability(
                "partial_production_executable",
                "managed production CPU selected-spectrum adapter is validated for gamma-equivalent k-path samples; this is a provenance bridge and not nonzero-k Bloch/Floquet dispersion",
            ),
            production_gpu: capability(
                "unsupported",
                "native modal GPU dispersion is unavailable until a real modal GPU eigensolver and matching Floquet operator exist; driven-response GPU Floquet smoke must not be reused as modal dispersion",
            ),
            k_path: capability(
                "reference_executable",
                "runner FEM eigen reference path emits dispersion.csv",
            ),
            branch_tracking: capability(
                "reference_executable",
                "runner FEM eigen reference path emits branches.v2 artifacts",
            ),
        },
        validation: FrequencyDomainValidationCapabilities {
            fmr_k0: capability(
                "source_visible",
                "validation artifacts and tests are being assembled; no production FMR gate is complete",
            ),
        },
        response: FrequencyDomainResponseCapabilities {
            magnetic_cpu: capability(
                "partial_production_executable",
                "native FEM production CPU response executes gamma/free-boundary, provider-backed dynamic demag, k=0 static-periodic, and no-demag nonzero-k Floquet tangent slices for supported exchange/Zeeman/uniaxial-anisotropy/interfacial-DMI/bulk-DMI/damping payloads; dynamic demag-k and missing periodic mesh-pair metadata are rejected before dense validation fallback",
            ),
            magnetic_gpu: magnetic_gpu_capability_from_availability(&gpu_response),
            frequency_sweep: capability(
                "partial_production_executable",
                "production CPU, production GPU, and dense validation lanes emit per-frequency artifacts and progress for supported response slices",
            ),
            mode_projected: capability("unsupported", unsupported),
            magnetoelastic_quasistatic: capability("unsupported", unsupported),
            magnetoelastic_elastodynamic: capability("unsupported", unsupported),
        },
        visualization: FrequencyDomainVisualizationCapabilities {
            modal_spectrum_chart: capability(
                "reference_executable",
                "artifact-backed spectrum chart resources are exposed",
            ),
            modal_dispersion_chart: capability(
                "reference_executable",
                "artifact-backed dispersion chart resources are exposed",
            ),
            mode_table: capability(
                "reference_executable",
                "artifact-backed modal table resources are exposed",
            ),
            mode_3d_overlay: capability(
                "reference_executable",
                "artifact-backed mode-field payloads can be projected in 3D",
            ),
            response_sweep_chart: capability(
                "reference_executable",
                "artifact-backed response sweep chart resources are exposed",
            ),
            response_field_3d_overlay: capability(
                "reference_executable",
                "artifact-backed response field payloads can be projected in 3D",
            ),
        },
    }
}

impl From<crate::native_fem::FrequencyDomainAvailability> for FrequencyDomainAvailabilitySummary {
    fn from(value: crate::native_fem::FrequencyDomainAvailability) -> Self {
        Self {
            status: value.status,
            study_kind: value.study_kind,
            driven_response_available: value.driven_response_available,
            modal_solver_available: value.modal_solver_available,
            static_periodic_response_available: value.static_periodic_response_available,
            floquet_modal_available: value.floquet_modal_available,
            floquet_response_available: value.floquet_response_available,
            dynamic_demag_k_available: value.dynamic_demag_k_available,
            gpu_available: value.gpu_available,
            reason: value.reason,
            diagnostics_json: value.diagnostics_json,
        }
    }
}

#[cfg(test)]
mod frequency_domain_manifest_tests {
    use super::{
        frequency_domain_manifest_v1, magnetic_gpu_capability_from_availability,
        native_fem::FrequencyDomainSweepProgress,
    };
    use crate::native_fem::FrequencyDomainAvailability;
    use serde_json::Value;

    fn assert_progress_json_checkpoint(
        progress: &FrequencyDomainSweepProgress,
        state: &str,
        status: Option<&str>,
        complete: Option<bool>,
    ) {
        let progress_json: Value = serde_json::from_str(&progress.progress_json)
            .expect("progress_json should be valid JSON");
        assert_eq!(
            progress_json["schema_version"],
            "frequency_domain_sweep_progress.v1"
        );
        assert_eq!(progress_json["state"], state);
        assert_eq!(
            progress_json["total_frequency_points"],
            progress.total_frequency_points
        );
        assert_eq!(
            progress_json["completed_frequency_points"],
            progress.completed_frequency_points
        );
        assert_eq!(
            progress_json["written_frequency_point_artifacts"],
            progress.written_frequency_point_artifacts
        );
        assert_eq!(
            progress_json["current_frequency_hz"],
            progress.current_frequency_hz
        );
        assert_eq!(
            progress_json["partial_artifacts_available"],
            progress.partial_artifacts_available
        );
        assert_eq!(
            progress_json["latest_artifact_manifest_path"],
            progress.latest_artifact_manifest_path
        );
        if let Some(expected_status) = status {
            assert_eq!(progress_json["status"], expected_status);
        }
        if let Some(expected_complete) = complete {
            assert_eq!(progress_json["complete"], expected_complete);
        }
    }

    #[test]
    fn frequency_domain_manifest_preserves_response_and_eigen_namespaces() {
        let manifest = frequency_domain_manifest_v1();

        assert_eq!(manifest.schema_version, "frequency_domain_manifest.v1");
        assert!(manifest.existing_frequency_response_namespace_preserved);
        assert_eq!(manifest.family_namespace, "frequencyDomain");
        assert_eq!(manifest.eigen_namespace, "eigen");
        assert_eq!(manifest.response.study_kind, "frequency_response");
        assert_eq!(manifest.eigenmodes.study_kind, "eigenmodes");
        assert_eq!(
            manifest.response.driven_response_available,
            manifest.response.status == "ok"
        );
        assert!(!manifest.floquet_nonzero_k_response_supported);
        assert!(!manifest.eigenmodes.modal_solver_available);
        assert!(!manifest.floquet_nonzero_k_demag_supported);
        assert_eq!(
            manifest.capabilities.response.magnetic_cpu.status,
            "partial_production_executable"
        );
        assert!(manifest
            .capabilities
            .response
            .magnetic_cpu
            .reason
            .contains("bulk-DMI"));
        assert!(
            matches!(
                manifest.capabilities.response.magnetic_gpu.status.as_str(),
                "unsupported" | "partial_production_executable"
            ),
            "magnetic GPU capability must be derived from native frequency-domain availability"
        );
        assert_eq!(
            manifest.capabilities.demag.floquet_dynamic_k.status,
            "unsupported"
        );
        assert_eq!(
            manifest.capabilities.dispersion.reference_cpu.status,
            "reference_executable"
        );
        assert_eq!(
            manifest.capabilities.dispersion.production_cpu.status,
            "partial_production_executable"
        );
        assert_eq!(
            manifest
                .capabilities
                .dispersion
                .production_cpu_gamma_k_path
                .status,
            "partial_production_executable"
        );
        assert!(manifest
            .capabilities
            .dispersion
            .production_cpu_gamma_k_path
            .reason
            .contains("gamma-equivalent"));
        assert!(manifest
            .capabilities
            .dispersion
            .production_cpu
            .reason
            .contains("Bloch/Floquet tangent payload"));
        assert_eq!(
            manifest.capabilities.dispersion.production_gpu.status,
            "unsupported"
        );
        assert!(manifest
            .capabilities
            .dispersion
            .production_gpu
            .reason
            .contains("modal GPU"));
        assert_eq!(
            manifest.capabilities.visualization.mode_3d_overlay.status,
            "reference_executable"
        );
    }

    #[test]
    fn magnetic_gpu_capability_reflects_strict_gpu_no_demag_availability() {
        let capability = magnetic_gpu_capability_from_availability(&FrequencyDomainAvailability {
            status: "ok".to_string(),
            study_kind: "frequency_response".to_string(),
            driven_response_available: true,
            modal_solver_available: false,
            static_periodic_response_available: false,
            floquet_modal_available: false,
            floquet_response_available: false,
            dynamic_demag_k_available: false,
            gpu_available: true,
            reason: String::new(),
            diagnostics_json: "{\"execution_lane\":\"native_fem_mfem_frequency_domain_gpu\"}"
                .to_string(),
        });

        assert_eq!(capability.status, "partial_production_executable");
        assert!(capability
            .reason
            .contains("native_fem_mfem_frequency_domain_gpu"));

        let unavailable = magnetic_gpu_capability_from_availability(&FrequencyDomainAvailability {
            status: "unavailable".to_string(),
            study_kind: "frequency_response".to_string(),
            driven_response_available: false,
            modal_solver_available: false,
            static_periodic_response_available: false,
            floquet_modal_available: false,
            floquet_response_available: false,
            dynamic_demag_k_available: false,
            gpu_available: false,
            reason: "built without fem-gpu".to_string(),
            diagnostics_json: "{}".to_string(),
        });

        assert_eq!(unavailable.status, "unsupported");
        assert!(unavailable.reason.contains("built without fem-gpu"));
    }

    #[test]
    fn frequency_domain_sweep_progress_tracks_partial_artifact_contract() {
        let progress = FrequencyDomainSweepProgress::not_started(11);

        assert_eq!(progress.total_frequency_points, 11);
        assert_eq!(progress.completed_frequency_points, 0);
        assert_eq!(progress.written_frequency_point_artifacts, 0);
        assert_eq!(progress.current_frequency_hz, 0.0);
        assert!(!progress.partial_artifacts_available);
        assert!(progress.latest_artifact_manifest_path.is_empty());
        assert_progress_json_checkpoint(&progress, "not_started", None, None);
    }

    #[test]
    fn frequency_domain_sweep_progress_tracks_interrupted_partial_contract() {
        let progress = FrequencyDomainSweepProgress::interrupted(
            11,
            3,
            3,
            4.2e9,
            "frequency_domain/manifest.v1.json",
        );

        assert_eq!(progress.total_frequency_points, 11);
        assert_eq!(progress.completed_frequency_points, 3);
        assert_eq!(progress.written_frequency_point_artifacts, 3);
        assert_eq!(progress.current_frequency_hz, 4.2e9);
        assert!(progress.partial_artifacts_available);
        assert_eq!(
            progress.latest_artifact_manifest_path,
            "frequency_domain/manifest.v1.json"
        );
        assert_progress_json_checkpoint(&progress, "interrupted", Some("interrupted"), Some(false));
    }

    #[test]
    fn frequency_domain_sweep_progress_tracks_cancel_requested_contract() {
        let progress = FrequencyDomainSweepProgress::cancelling(
            11,
            3,
            3,
            4.2e9,
            "frequency_domain/manifest.v1.json",
        );

        assert_eq!(progress.total_frequency_points, 11);
        assert_eq!(progress.completed_frequency_points, 3);
        assert_eq!(progress.written_frequency_point_artifacts, 3);
        assert_eq!(progress.current_frequency_hz, 4.2e9);
        assert!(progress.partial_artifacts_available);
        assert_eq!(
            progress.latest_artifact_manifest_path,
            "frequency_domain/manifest.v1.json"
        );
        assert_progress_json_checkpoint(
            &progress,
            "cancel_requested",
            Some("cancel_requested"),
            Some(false),
        );
    }

    #[test]
    fn frequency_domain_sweep_progress_tracks_completed_artifact_contract() {
        let progress = FrequencyDomainSweepProgress::completed(
            11,
            11,
            11,
            5.5e9,
            "response/artifact_manifest.json",
        );

        assert_eq!(progress.total_frequency_points, 11);
        assert_eq!(progress.completed_frequency_points, 11);
        assert_eq!(progress.written_frequency_point_artifacts, 11);
        assert_eq!(progress.current_frequency_hz, 5.5e9);
        assert!(progress.partial_artifacts_available);
        assert_eq!(
            progress.latest_artifact_manifest_path,
            "response/artifact_manifest.json"
        );
        assert_progress_json_checkpoint(&progress, "completed", Some("ready"), Some(true));
    }
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
        is_native_fem_cpu_available, is_native_fem_time_domain_available, resolve_timestep_policy,
        InitialTimestepReason, LlgTimestepQualificationId, RequestedTimestepPolicy,
        ResolvedTimestepPolicy, TimestepExecutionLane, TimestepValidationState,
    };

    fn adaptive(dt_initial: Option<f64>) -> fullmag_ir::AdaptiveTimeStepIR {
        fullmag_ir::AdaptiveTimeStepIR {
            tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::Advanced,
            atol: 1e-6,
            rtol: 1e-3,
            dt_initial,
            dt_min: 1e-15,
            dt_max: Some(1e-12),
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: None,
            norm_tolerance: None,
        }
    }

    #[test]
    fn fixed_and_adaptive_together_fail_closed() {
        let error = resolve_timestep_policy(
            Some(fullmag_ir::IntegratorChoice::Rk45),
            Some(2e-13),
            Some(&adaptive(Some(5e-14))),
            TimestepExecutionLane::fdm_cpu(),
        )
        .expect_err("exactly-one policy must reject both");
        assert!(error.message.contains("exactly one"));
    }

    #[test]
    fn explicit_initial_equal_to_min_remains_explicit() {
        let policy = resolve_timestep_policy(
            Some(fullmag_ir::IntegratorChoice::Rk45),
            None,
            Some(&adaptive(Some(1e-15))),
            TimestepExecutionLane::fdm_cpu(),
        )
        .unwrap();
        assert!(matches!(
            policy.requested,
            RequestedTimestepPolicy::Adaptive {
                dt_initial_s: Some(1e-15),
                ..
            }
        ));
        assert!(matches!(
            policy.resolved,
            ResolvedTimestepPolicy::Adaptive {
                dt_initial_s: 1e-15,
                dt_initial_reason: InitialTimestepReason::Explicit,
                estimator_order: 4,
                ..
            }
        ));
    }

    #[test]
    fn missing_initial_resolves_exactly_to_dt_min() {
        let policy = resolve_timestep_policy(
            Some(fullmag_ir::IntegratorChoice::Rk23),
            None,
            Some(&adaptive(None)),
            TimestepExecutionLane::fdm_cpu(),
        )
        .unwrap();
        assert!(matches!(
            policy.requested,
            RequestedTimestepPolicy::Adaptive {
                dt_initial_s: None,
                ..
            }
        ));
        assert!(matches!(
            policy.resolved,
            ResolvedTimestepPolicy::Adaptive {
                dt_initial_s: 1e-15,
                dt_initial_reason: InitialTimestepReason::DtMinDefault,
                estimator_order: 2,
                ..
            }
        ));
    }

    #[test]
    fn adaptive_missing_dt_max_fails_closed() {
        let mut config = adaptive(None);
        config.dt_max = None;
        let error = resolve_timestep_policy(
            Some(fullmag_ir::IntegratorChoice::Rk45),
            None,
            Some(&config),
            TimestepExecutionLane::fdm_cpu(),
        )
        .unwrap_err();
        assert!(error.message.contains("dt_max"));
    }

    #[test]
    fn adaptive_policy_rejects_invalid_controller_values() {
        let invalid_configs: Vec<(&str, Box<dyn Fn(&mut fullmag_ir::AdaptiveTimeStepIR)>)> = vec![
            ("negative atol", Box::new(|config| config.atol = -1.0)),
            ("non-finite rtol", Box::new(|config| config.rtol = f64::NAN)),
            (
                "both tolerances zero",
                Box::new(|config| {
                    config.atol = 0.0;
                    config.rtol = 0.0;
                }),
            ),
            ("safety above one", Box::new(|config| config.safety = 1.1)),
            (
                "growth not above one",
                Box::new(|config| config.growth_limit = 1.0),
            ),
            (
                "shrink not below one",
                Box::new(|config| config.shrink_limit = 1.0),
            ),
            (
                "invalid rotation guard",
                Box::new(|config| config.max_spin_rotation = Some(0.0)),
            ),
            (
                "invalid norm guard",
                Box::new(|config| config.norm_tolerance = Some(f64::INFINITY)),
            ),
        ];

        for (case, mutate) in invalid_configs {
            let mut config = adaptive(None);
            mutate(&mut config);
            assert!(
                resolve_timestep_policy(
                    Some(fullmag_ir::IntegratorChoice::Rk45),
                    None,
                    Some(&config),
                    TimestepExecutionLane::fdm_cpu(),
                )
                .is_err(),
                "{case} must fail closed"
            );
        }
    }

    #[test]
    fn max_error_policy_accepts_zero_rtol() {
        let mut config = adaptive(None);
        config.tolerance_mode = fullmag_ir::AdaptiveToleranceModeIR::MaxError;
        config.atol = 1e-6;
        config.rtol = 0.0;
        resolve_timestep_policy(
            Some(fullmag_ir::IntegratorChoice::Rk45),
            None,
            Some(&config),
            TimestepExecutionLane::fdm_cpu(),
        )
        .expect("max_error uses atol and permits rtol=0");
    }

    #[test]
    fn max_error_policy_rejects_nonzero_rtol() {
        let mut config = adaptive(None);
        config.tolerance_mode = fullmag_ir::AdaptiveToleranceModeIR::MaxError;
        config.atol = 1e-6;
        config.rtol = 1e-3;
        let error = resolve_timestep_policy(
            Some(fullmag_ir::IntegratorChoice::Rk45),
            None,
            Some(&config),
            TimestepExecutionLane::fdm_cpu(),
        )
        .unwrap_err();
        assert!(error.message.contains("rtol == 0"));
    }

    #[test]
    fn timestep_execution_identity_roundtrips_for_all_explicit_runtime_lanes() {
        let cases = [
            (
                TimestepExecutionLane::fdm_cpu(),
                LlgTimestepQualificationId::ExplicitFixedFdmCpuDouble,
            ),
            (
                TimestepExecutionLane::fdm_cuda(fullmag_ir::ExecutionPrecision::Double),
                LlgTimestepQualificationId::ExplicitFixedFdmCudaDouble,
            ),
            (
                TimestepExecutionLane::fem_cpu(fullmag_ir::ExecutionPrecision::Double),
                LlgTimestepQualificationId::ExplicitFixedFemCpuDouble,
            ),
            (
                TimestepExecutionLane::fem_gpu(fullmag_ir::ExecutionPrecision::Double),
                LlgTimestepQualificationId::ExplicitFixedFemGpuDouble,
            ),
        ];

        for (lane, expected_qualification) in cases {
            let policy = resolve_timestep_policy(
                Some(fullmag_ir::IntegratorChoice::Rk45),
                Some(1e-15),
                None,
                lane,
            )
            .expect("fixed timestep lane must resolve");
            let roundtrip: super::TimestepPolicyProvenance =
                serde_json::from_value(serde_json::to_value(&policy).unwrap()).unwrap();
            assert_eq!(roundtrip, policy);
            assert_eq!(
                roundtrip.execution_identity.qualification_id,
                expected_qualification
            );
            assert_eq!(roundtrip.execution_identity.backend, lane.backend);
            assert_eq!(roundtrip.execution_identity.device, lane.device);
            assert_eq!(roundtrip.execution_identity.precision, lane.precision);
            assert_eq!(
                roundtrip.execution_identity.integrator,
                fullmag_ir::IntegratorChoice::Rk45
            );
            assert_eq!(
                roundtrip.execution_identity.timestep_policy,
                super::TimestepPolicyKind::Fixed
            );
            assert_eq!(
                roundtrip.execution_identity.qualification_registry_version,
                "fullmag.llg_timestep_qualification_registry.v1"
            );
            assert_eq!(
                roundtrip.execution_identity.validation_state,
                TimestepValidationState::Unvalidated
            );
            assert!(roundtrip
                .execution_identity
                .qualification_artifact_sha256
                .is_none());
        }
    }

    #[test]
    fn adaptive_fdm_cuda_identity_fails_closed_until_controller_abi_is_complete() {
        let error = resolve_timestep_policy(
            Some(fullmag_ir::IntegratorChoice::Rk45),
            None,
            Some(&adaptive(None)),
            TimestepExecutionLane::fdm_cuda(fullmag_ir::ExecutionPrecision::Double),
        )
        .expect_err("adaptive CUDA must not acquire executable provenance");
        assert!(error
            .message
            .contains("no executable LLG timestep capability row"));
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

pub(crate) fn attach_resolved_fallback_to_executed_run(
    executed: &mut types::ExecutedRun,
    fallback: Option<ResolvedFallback>,
) {
    if executed.provenance.resolved_fallback.is_none() {
        executed.provenance.resolved_fallback = fallback;
    }
}

pub(crate) fn attach_fem_crossover_decision_to_executed_run(
    executed: &mut crate::types::ExecutedRun,
    decision: Option<FemCrossoverDecision>,
) {
    if executed.provenance.fem_crossover_decision.is_none() {
        executed.provenance.fem_crossover_decision = decision;
    }
}

/// Copy the canonical planner resolution into the execution artifact contract.
/// The runner's concrete engine remains authoritative for device and fallback
/// facts; the plan remains authoritative for what the author requested before
/// `auto` was resolved.
pub(crate) fn attach_plan_integrator_resolution(
    executed: &mut types::ExecutedRun,
    plan: &fullmag_ir::ExecutionPlanIR,
) {
    attach_plan_integrator_resolution_to_provenance(&mut executed.provenance, plan);
}

pub(crate) fn attach_plan_integrator_resolution_to_provenance(
    provenance: &mut ExecutionProvenance,
    plan: &fullmag_ir::ExecutionPlanIR,
) {
    let Some(resolution) = plan.provenance.integrator_resolution.as_ref() else {
        return;
    };
    provenance.requested_integrator = resolution
        .requested_integrator
        .map(|integrator| integrator.as_str().to_string());
    provenance.resolved_integrator = resolution
        .resolved_integrator
        .map(integrator_choice_name)
        .map(str::to_string);
}

pub(crate) fn integrator_choice_name(integrator: fullmag_ir::IntegratorChoice) -> &'static str {
    match integrator {
        fullmag_ir::IntegratorChoice::Heun => "heun",
        fullmag_ir::IntegratorChoice::Rk4 => "rk4",
        fullmag_ir::IntegratorChoice::Rk23 => "rk23",
        fullmag_ir::IntegratorChoice::Rk45 => "rk45",
        fullmag_ir::IntegratorChoice::Abm3 => "abm3",
    }
}

fn require_supported_fem_topology(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<(), RunError> {
    let (mesh, build_report, precision, study_kind, relaxation_plan) = match &plan.backend_plan {
        BackendPlanIR::Fem(fem) => (
            &fem.mesh,
            fem.mesh_build_report.as_ref(),
            fem.precision,
            "fem",
            Some(fem),
        ),
        BackendPlanIR::FemEigen(fem) => (
            &fem.mesh,
            fem.mesh_build_report.as_ref(),
            fem.precision,
            "fem_eigen",
            None,
        ),
        BackendPlanIR::FemFrequencyResponse(fem) => (
            &fem.mesh,
            fem.mesh_build_report.as_ref(),
            fem.precision,
            "fem_frequency_response",
            None,
        ),
        BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_) => return Ok(()),
    };
    let mut cell_families = mesh.cells.types.clone();
    cell_families.sort_unstable();
    cell_families.dedup();
    let mut facet_families = mesh.facets.types.clone();
    facet_families.sort_unstable();
    facet_families.dedup();
    let tetrahedral = !cell_families.is_empty()
        && cell_families
            .iter()
            .all(|family| *family == fullmag_ir::FemCellTypeIR::Tet4)
        && facet_families
            .iter()
            .all(|family| *family == fullmag_ir::FemFacetTypeIR::Tri3);
    let has_mixed_metadata = build_report.is_some_and(|report| {
        report.mixed_layer_topology_certificate.is_some()
            || report.mixed_topology_provenance.is_some()
    });
    if tetrahedral {
        return if has_mixed_metadata {
            Err(RunError {
                message: "fem_mixed_p1_runtime_metadata_without_mixed_topology: mixed certificate/provenance cannot be attached to a tetrahedral plan".to_string(),
            })
        } else {
            Ok(())
        };
    }

    let qualified_family = cell_families.len() == 3
        && cell_families.contains(&fullmag_ir::FemCellTypeIR::Tet4)
        && cell_families.contains(&fullmag_ir::FemCellTypeIR::Prism6)
        && cell_families.contains(&fullmag_ir::FemCellTypeIR::Pyramid5)
        && facet_families.iter().all(|family| {
            matches!(
                family,
                fullmag_ir::FemFacetTypeIR::Tri3 | fullmag_ir::FemFacetTypeIR::Quad4
            )
        })
        && facet_families.contains(&fullmag_ir::FemFacetTypeIR::Quad4);
    if !qualified_family {
        return Err(RunError {
            message: format!(
                "fem_typed_topology_unsupported_before_backend: cells={cell_families:?}; facets={facet_families:?}; study={study_kind}; fallback=none"
            ),
        });
    }

    let report = build_report.ok_or_else(|| RunError {
        message: "fem_mixed_p1_runtime_certificate_required: shared-domain build report is missing; fallback=none".to_string(),
    })?;
    if !report
        .fallbacks_triggered
        .as_ref()
        .is_some_and(Vec::is_empty)
        || report.degraded
    {
        return Err(RunError {
            message: format!(
                "fem_mixed_p1_runtime_build_report_rejected: fallbacks_triggered={:?}; degraded={}; required=fallbacks_triggered[]+degraded_false; fallback=none",
                report.fallbacks_triggered, report.degraded
            ),
        });
    }
    let certificate = report
        .mixed_layer_topology_certificate
        .as_ref()
        .ok_or_else(|| RunError {
            message: "fem_mixed_p1_runtime_certificate_required: accepted topology certificate is missing; fallback=none".to_string(),
        })?;
    let fingerprint = mesh
        .mixed_topology_fingerprint_for_version(&certificate.topology_fingerprint_version)
        .map_err(|error| RunError {
            message: format!("fem_mixed_p1_runtime_certificate_rejected: {error}; fallback=none"),
        })?;
    if certificate.topology_fingerprint != fingerprint {
        return Err(RunError {
            message: format!(
                "fem_mixed_p1_runtime_certificate_stale: certificate={} mesh={fingerprint}; fallback=none",
                certificate.topology_fingerprint
            ),
        });
    }
    fullmag_ir::validate_mixed_layer_topology_certificate_against_mesh(certificate, mesh).map_err(
        |reasons| RunError {
            message: format!(
                "fem_mixed_p1_runtime_certificate_rejected: {}; fallback=none",
                reasons.join("; ")
            ),
        },
    )?;
    let provenance = report
        .mixed_topology_provenance
        .as_ref()
        .ok_or_else(|| RunError {
            message: "fem_mixed_p1_runtime_provenance_required: accepted certificate identity is not bound to the plan; fallback=none".to_string(),
        })?;
    if provenance.accepted_certificate_fingerprint != fingerprint
        || provenance.precision != precision
        || precision != problem.backend_policy.execution_precision
        || provenance.requested_topology != fullmag_ir::FemMeshTopologyFamilyIR::MixedP1
        || provenance.resolved_topology != fullmag_ir::FemMeshTopologyFamilyIR::MixedP1
    {
        return Err(RunError {
            message: "fem_mixed_p1_runtime_provenance_stale: plan provenance does not match the exact mesh fingerprint/topology/precision; fallback=none".to_string(),
        });
    }
    let requested_device = match provenance.requested_device {
        fullmag_ir::ExecutionDevice::Cpu => "cpu".to_string(),
        fullmag_ir::ExecutionDevice::Gpu => "gpu".to_string(),
        fullmag_ir::ExecutionDevice::Auto => "auto".to_string(),
    };
    let metadata_device =
        crate::solver_runtime::selection::effective_fem_device_request_from_metadata(problem);
    let expected_device = match metadata_device.as_str() {
        "cpu" => fullmag_ir::ExecutionDevice::Cpu,
        "gpu" | "cuda" => fullmag_ir::ExecutionDevice::Gpu,
        _ => fullmag_ir::ExecutionDevice::Auto,
    };
    if provenance.requested_device != expected_device {
        return Err(RunError {
            message: "fem_mixed_p1_runtime_provenance_stale: authored/managed device metadata does not match plan-bound effective device; fallback=none".to_string(),
        });
    }
    if provenance.capability_status != fullmag_ir::FemMixedTopologyCapabilityStatusIR::Implemented {
        return Err(RunError {
            message: "fem_mixed_p1_runtime_provenance_stale: capability status must be implemented until managed public runtime proof exists; fallback=none".to_string(),
        });
    }
    let supported_relaxation = relaxation_plan.is_some_and(|fem| {
        fem.fe_order == 1
            && fem.precision == fullmag_ir::ExecutionPrecision::Double
            && fem.enable_exchange
            && fem.enable_demag
            && matches!(
                fem.demag_realization,
                Some(
                    fullmag_ir::ResolvedFemDemagIR::PoissonRobin
                        | fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet
                )
            )
            && fem.relaxation.as_ref().is_some_and(|relaxation| {
                matches!(
                    relaxation.algorithm,
                    fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
                        | fullmag_ir::RelaxationAlgorithmIR::NonlinearCg
                        | fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped
                )
            })
            && fem.interfacial_dmi.is_none()
            && fem.bulk_dmi.is_none()
            && fem.current_modules.is_empty()
            && fem.field_drives.is_empty()
            && fem.temperature.is_none()
            && fem.magnetoelastic.is_none()
            && fem.mechanics.is_none()
    });
    let mut exchange_count = 0usize;
    let mut demag_count = 0usize;
    let mut energy_supported = true;
    for term in &problem.energy_terms {
        match term {
            fullmag_ir::EnergyTermIR::Exchange => exchange_count += 1,
            fullmag_ir::EnergyTermIR::Demag { realization }
                if matches!(
                    realization,
                    fullmag_ir::RequestedFemDemagIR::PoissonRobin
                        | fullmag_ir::RequestedFemDemagIR::PoissonDirichlet
                ) =>
            {
                demag_count += 1
            }
            fullmag_ir::EnergyTermIR::Zeeman { .. } => {}
            _ => energy_supported = false,
        }
    }
    let material_supported = problem.materials.len() == 1
        && problem.materials.iter().all(|material| {
            material.uniaxial_anisotropy.is_none()
                && material.uniaxial_anisotropy_k2.is_none()
                && material.anisotropy_axis.is_none()
                && material.cubic_anisotropy_kc1.is_none()
                && material.cubic_anisotropy_kc2.is_none()
                && material.cubic_anisotropy_kc3.is_none()
                && material.cubic_anisotropy_axis1.is_none()
                && material.cubic_anisotropy_axis2.is_none()
                && material.ms_field.is_none()
                && material.a_field.is_none()
                && material.alpha_field.is_none()
                && material.ku_field.is_none()
                && material.ku2_field.is_none()
                && material.kc1_field.is_none()
                && material.kc2_field.is_none()
                && material.kc3_field.is_none()
                && material.interfacial_dmi.is_none()
                && material.bulk_dmi.is_none()
                && material.dind_field.is_none()
                && material.dbulk_field.is_none()
        });
    let problem_scope = problem.backend_policy.requested_backend == fullmag_ir::BackendTarget::Fem
        && problem.backend_policy.execution_precision == fullmag_ir::ExecutionPrecision::Double
        && problem.validation_profile.execution_mode == fullmag_ir::ExecutionMode::Strict
        && matches!(requested_device.as_str(), "cpu" | "gpu")
        && problem.geometry.entries.len() == 1
        && matches!(
            problem.geometry.entries[0],
            fullmag_ir::GeometryEntryIR::Box { .. }
        )
        && problem.regions.len() == 1
        && material_supported
        && problem.magnets.len() == 1
        && problem.object_regions.is_empty()
        && problem.material_parameter_fields.is_empty()
        && problem.couplings.is_empty()
        && problem.current_modules.is_empty()
        && problem.field_drives.is_empty()
        && problem.spin_torque_modules.is_empty()
        && problem.current_density.is_none()
        && problem.stt_degree.is_none()
        && problem.stt_beta.is_none()
        && problem.stt_spin_polarization.is_none()
        && problem.stt_lambda.is_none()
        && problem.stt_epsilon_prime.is_none()
        && problem.stt_thickness.is_none()
        && problem.stt_fixed_layer_position.is_none()
        && problem.temperature.is_none()
        && problem.elastic_materials.is_empty()
        && problem.elastic_bodies.is_empty()
        && problem.magnetostriction_laws.is_empty()
        && problem.mechanical_bcs.is_empty()
        && problem.mechanical_loads.is_empty()
        && problem.pbc.is_none()
        && exchange_count == 1
        && demag_count == 1
        && energy_supported
        && (1..=3).contains(&certificate.requested_layer_count)
        && certificate.realized_layer_count == certificate.requested_layer_count
        && certificate.magnetic_plane_coordinates_m.len()
            == certificate.requested_layer_count as usize + 1
        && certificate.fallbacks_triggered.is_empty()
        && matches!(
            problem.study,
            fullmag_ir::StudyIR::Relaxation {
                algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb
                    | fullmag_ir::RelaxationAlgorithmIR::NonlinearCg
                    | fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped,
                ..
            }
        );
    if !supported_relaxation || !problem_scope {
        return Err(RunError {
            message: format!(
                "fem_mixed_p1_runtime_scope_rejected: study={study_kind}; requested_device={requested_device}; precision={precision:?}; required=explicit_cpu_or_gpu+strict+double+P1+exchange+poisson_robin_or_dirichlet+PG_BB_or_NCG_or_LLG_overdamped; fallback=none"
            ),
        });
    }
    Ok(())
}

fn require_tetrahedral_fem_plan_mesh(
    mesh: &fullmag_ir::MeshIR,
    build_report: Option<&fullmag_ir::FemSharedDomainBuildReportIR>,
    study_kind: &str,
) -> Result<(), RunError> {
    let tetrahedral = !mesh.cells.types.is_empty()
        && mesh
            .cells
            .types
            .iter()
            .all(|family| *family == fullmag_ir::FemCellTypeIR::Tet4)
        && mesh
            .facets
            .types
            .iter()
            .all(|family| *family == fullmag_ir::FemFacetTypeIR::Tri3);
    let has_mixed_metadata = build_report.is_some_and(|report| {
        report.mixed_layer_topology_certificate.is_some()
            || report.mixed_topology_provenance.is_some()
    });
    if tetrahedral && !has_mixed_metadata {
        return Ok(());
    }
    Err(RunError {
        message: format!(
            "fem_typed_topology_unsupported_before_backend: study={study_kind}; supported_topology=tet4/tri3; fallback=none"
        ),
    })
}

pub(crate) fn require_resolved_runtime_sampling(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<(), RunError> {
    require_supported_fem_topology(problem, plan)?;
    schedules::require_resolved_periodic_outputs(&plan.output_plan.outputs)
        .map_err(|message| RunError { message })?;
    if let Some(table) = problem.study.sampling().table_autosave.as_ref() {
        table_autosave::TableAutosaveConfig::from_ir(table)
            .map_err(|message| RunError { message })?;
    }
    validate_sampling_resolution_provenance(problem, plan)?;
    Ok(())
}

fn validate_sampling_resolution_provenance(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<(), RunError> {
    let table = problem.study.sampling().table_autosave.as_ref();
    let automatic_table_period = table.and_then(|table| {
        table
            .requests_auto_sinc_cutoff()
            .then_some(table.resolved_sample_period_s)
            .flatten()
    });
    let automatic_outputs: Vec<(f64, &fullmag_ir::SamplingPeriodPolicyIR)> = problem
        .study
        .sampling()
        .outputs
        .iter()
        .chain(plan.output_plan.outputs.iter())
        .filter_map(|output| match output {
            OutputIR::FieldResolvedAuto {
                every_seconds,
                requested_policy,
                ..
            }
            | OutputIR::ScalarResolvedAuto {
                every_seconds,
                requested_policy,
                ..
            } => Some((*every_seconds, requested_policy)),
            _ => None,
        })
        .collect();
    let metadata = problem
        .problem_meta
        .runtime_metadata
        .get("sampling_resolution");
    if (automatic_table_period.is_some() || !automatic_outputs.is_empty()) && metadata.is_none() {
        return Err(RunError {
            message: "resolved automatic table or output sampling requires runtime_metadata.sampling_resolution provenance".into(),
        });
    }
    let Some(metadata) = metadata else {
        return Ok(());
    };
    let resolution: fullmag_plan::SamplingResolutionIR = serde_json::from_value(metadata.clone())
        .map_err(|error| RunError {
        message: format!("runtime_metadata.sampling_resolution is malformed: {error}"),
    })?;
    if resolution.schema_version != fullmag_plan::SAMPLING_RESOLUTION_SCHEMA_VERSION {
        return Err(RunError {
            message: format!(
                "sampling_resolution.schema_version must be '{}'",
                fullmag_plan::SAMPLING_RESOLUTION_SCHEMA_VERSION
            ),
        });
    }
    let finite_positive = [
        ("sample_period_s", resolution.sample_period_s),
        ("maximum_cutoff_hz", resolution.maximum_cutoff_hz),
        ("nyquist_guard_factor", resolution.nyquist_guard_factor),
        ("target_nyquist_hz", resolution.target_nyquist_hz),
        ("sampling_frequency_hz", resolution.sampling_frequency_hz),
    ];
    for (field, value) in finite_positive {
        if !value.is_finite() || value <= 0.0 {
            return Err(RunError {
                message: format!("sampling_resolution.{field} must be finite and positive"),
            });
        }
    }
    let fullmag_ir::SamplingPeriodPolicyIR::AutoSincCutoff {
        nyquist_guard_factor: requested_guard_factor,
    } = resolution.requested_policy;
    if requested_guard_factor != fullmag_ir::AUTO_SINC_NYQUIST_GUARD_FACTOR {
        return Err(RunError {
            message:
                "sampling_resolution.requested_policy.nyquist_guard_factor must be exactly 1.3"
                    .into(),
        });
    }
    if resolution.nyquist_guard_factor != fullmag_ir::AUTO_SINC_NYQUIST_GUARD_FACTOR {
        return Err(RunError {
            message: "sampling_resolution.nyquist_guard_factor must be exactly 1.3".into(),
        });
    }
    if resolution.target_nyquist_hz
        != fullmag_ir::AUTO_SINC_NYQUIST_GUARD_FACTOR * resolution.maximum_cutoff_hz
    {
        return Err(RunError {
            message: "sampling_resolution.target_nyquist_hz must equal 1.3 * maximum_cutoff_hz"
                .into(),
        });
    }
    if resolution.sampling_frequency_hz != 2.0 * resolution.target_nyquist_hz {
        return Err(RunError {
            message: "sampling_resolution.sampling_frequency_hz must equal 2 * target_nyquist_hz"
                .into(),
        });
    }
    if resolution.sample_period_s != 1.0 / resolution.sampling_frequency_hz {
        return Err(RunError {
            message: "sampling_resolution.sample_period_s must equal 1 / sampling_frequency_hz"
                .into(),
        });
    }
    if automatic_table_period.is_some_and(|period| period != resolution.sample_period_s) {
        return Err(RunError {
            message: "sampling_resolution.sample_period_s must match table_autosave.resolved_sample_period_s".into(),
        });
    }
    if automatic_outputs
        .iter()
        .any(|(period, _)| *period != resolution.sample_period_s)
    {
        return Err(RunError {
            message: "sampling_resolution.sample_period_s must match every resolved automatic output cadence".into(),
        });
    }
    if automatic_outputs
        .iter()
        .any(|(_, policy)| *policy != &resolution.requested_policy)
    {
        return Err(RunError {
            message: "resolved automatic output requested_policy must match sampling_resolution.requested_policy".into(),
        });
    }
    let active_stage_id = problem
        .problem_meta
        .runtime_metadata
        .get("active_stage_id")
        .and_then(serde_json::Value::as_str)
        .filter(|stage_id| !stage_id.trim().is_empty());
    if active_stage_id != Some(resolution.target_stage_id.as_str()) {
        return Err(RunError {
            message:
                "sampling_resolution.target_stage_id must match runtime_metadata.active_stage_id"
                    .into(),
        });
    }
    let mut expected_source_drive_ids = Vec::new();
    let mut expected_maximum_cutoff_hz: Option<f64> = None;
    for drive in problem.field_drives.iter().filter(|drive| {
        drive.enabled
            && match &drive.activation {
                fullmag_ir::DriveActivationIR::AllTimeEvolution {} => {
                    matches!(problem.study, fullmag_ir::StudyIR::TimeEvolution { .. })
                }
                fullmag_ir::DriveActivationIR::StageIds { stage_ids } => stage_ids
                    .iter()
                    .any(|stage_id| stage_id == &resolution.target_stage_id),
            }
    }) {
        let fullmag_ir::TimeDependenceIR::SincPulse { cutoff_hz, .. } = drive.waveform else {
            continue;
        };
        if !cutoff_hz.is_finite() || cutoff_hz <= 0.0 {
            return Err(RunError {
                message: format!(
                    "active sinc drive '{}' requires a finite positive cutoff_hz",
                    drive.id
                ),
            });
        }
        expected_source_drive_ids.push(drive.id.clone());
        expected_maximum_cutoff_hz = Some(
            expected_maximum_cutoff_hz
                .map(|maximum| maximum.max(cutoff_hz))
                .unwrap_or(cutoff_hz),
        );
    }
    let Some(expected_maximum_cutoff_hz) = expected_maximum_cutoff_hz else {
        return Err(RunError {
            message: "sampling_resolution requires at least one enabled active sinc source drive"
                .into(),
        });
    };
    if resolution.source_drive_ids != expected_source_drive_ids {
        return Err(RunError {
            message: "sampling_resolution.source_drive_ids must exactly match the enabled active sinc drives for target_stage_id".into(),
        });
    }
    if resolution.maximum_cutoff_hz != expected_maximum_cutoff_hz {
        return Err(RunError {
            message: "sampling_resolution.maximum_cutoff_hz must equal the maximum cutoff of its enabled active sinc source drives".into(),
        });
    }
    Ok(())
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
    require_resolved_runtime_sampling(problem, plan)?;
    if let fullmag_ir::StudyIR::Hysteresis { .. } = &problem.study {
        return hysteresis::run_planned_hysteresis(problem, plan, until_seconds, output_dir, None);
    }
    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start_for_problem(
        problem,
        output_dir.to_path_buf(),
        artifacts::build_field_context(problem, plan),
        artifact_pipeline::DEFAULT_ARTIFACT_PIPELINE_CAPACITY,
    )?;
    let artifact_writer = Some(artifact_pipeline.sender());

    let cpu_threads = configured_cpu_threads(problem);
    let executed_result = with_cpu_parallelism(cpu_threads, || match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let resolution = dispatch::resolve_fdm_engine_with_trail(problem)?;
            let mut executed = dispatch::execute_fdm(
                resolution.engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                None,
                artifact_writer.clone(),
            )?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            Ok(executed)
        }
        BackendPlanIR::FdmMultilayer(fdm) => {
            let resolution = dispatch::resolve_fdm_engine_with_trail(problem)?;
            let mut executed = dispatch::execute_fdm_multilayer(
                resolution.engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                None,
                artifact_writer.clone(),
            )?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            Ok(executed)
        }
        BackendPlanIR::Fem(fem) => {
            let resolution = dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem, false)?;
            let crossover_decision = resolution.fem_crossover_decision.clone();
            let mut executed = if fem.relaxation.is_some() {
                fem::relax::execute_fem_relax_in_mode(
                    fem_engine_kind(resolution.engine),
                    fem,
                    until_seconds,
                    &plan.output_plan.outputs,
                    None,
                    artifact_writer.clone(),
                    plan.common.execution_mode,
                )
            } else {
                dispatch::execute_fem_in_mode(
                    resolution.engine,
                    fem,
                    until_seconds,
                    &plan.output_plan.outputs,
                    None,
                    artifact_writer.clone(),
                    plan.common.execution_mode,
                )
            }?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            attach_fem_crossover_decision_to_executed_run(&mut executed, crossover_decision);
            Ok(executed)
        }
        BackendPlanIR::FemEigen(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            dispatch::execute_fem_eigen(engine, fem, &plan.output_plan.outputs)
        }
        BackendPlanIR::FemFrequencyResponse(response) => {
            let stage_context =
                types::FemStageExecutionContext::from_backend_plan(&plan.backend_plan)
                    .expect("FEM stage context");
            frequency_response::execute_fem_frequency_response_validation_with_context(
                response,
                &stage_context,
                output_dir,
                None,
                None,
            )
        }
    });
    let pipeline_summary = artifact_pipeline.finish();
    let mut executed = match executed_result {
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
    attach_plan_integrator_resolution(&mut executed, plan);
    spin_wave_response::append_requested_spin_wave_artifacts(problem, plan, &mut executed)?;
    executed
        .auxiliary_artifacts
        .extend(spin_wave_sampling::requested_finite_k_artifacts(
            problem, plan, output_dir,
        )?);

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

/// Run a problem while providing the canonical stage id for hysteresis artifacts.
///
/// Existing callers can use `run_planned_problem`; scripted stage orchestrators
/// use this variant so persisted hysteresis snapshot refs can be scoped to the
/// owning stage.
pub fn run_planned_problem_with_hysteresis_stage_id(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    until_seconds: f64,
    output_dir: &Path,
    hysteresis_stage_id: Option<&str>,
) -> Result<RunResult, RunError> {
    require_resolved_runtime_sampling(problem, plan)?;
    if let fullmag_ir::StudyIR::Hysteresis { .. } = &problem.study {
        return hysteresis::run_planned_hysteresis(
            problem,
            plan,
            until_seconds,
            output_dir,
            hysteresis_stage_id,
        );
    }
    run_planned_problem(problem, plan, until_seconds, output_dir)
}

pub fn fem_observables_for_magnetization(
    plan: &fullmag_ir::FemPlanIR,
    magnetization: &[[f64; 3]],
) -> Result<fullmag_engine::EffectiveFieldObservables, RunError> {
    require_tetrahedral_fem_plan_mesh(&plan.mesh, plan.mesh_build_report.as_ref(), "fem")?;
    fem_baseline::fem_observables_for_magnetization(plan, magnetization)
}

fn fem_eigen_progress_update(
    progress: fem_eigen::FemEigenProgress,
    fem_mesh_generation_id: Option<String>,
) -> StepUpdate {
    let mut progress_scalars = std::collections::HashMap::new();
    progress_scalars.insert("phase_code".to_string(), f64::from(progress.phase_index));
    progress_scalars.insert("phase_count".to_string(), f64::from(progress.phase_count));
    progress_scalars.insert("percent".to_string(), progress.percent);
    progress_scalars.insert("active_nodes".to_string(), progress.active_nodes as f64);
    progress_scalars.insert("effective_dof".to_string(), progress.effective_dof as f64);
    progress_scalars.insert(
        "requested_modes".to_string(),
        progress.requested_modes as f64,
    );
    progress_scalars.insert(
        "candidate_modes".to_string(),
        progress.candidate_modes as f64,
    );
    progress_scalars.insert("computed_modes".to_string(), progress.computed_modes as f64);
    if let Some(iteration) = progress.iteration {
        progress_scalars.insert("iteration".to_string(), f64::from(iteration));
    }
    if let Some(max_iterations) = progress.max_iterations {
        progress_scalars.insert("max_iterations".to_string(), f64::from(max_iterations));
    }
    if let Some(residual) = progress.residual {
        progress_scalars.insert("residual".to_string(), residual);
    }
    progress_scalars.insert(
        "phase_materializing_equilibrium".to_string(),
        (progress.phase == "materializing_equilibrium") as u8 as f64,
    );
    progress_scalars.insert(
        "phase_assembling_operator".to_string(),
        (progress.phase == "assembling_operator") as u8 as f64,
    );
    progress_scalars.insert(
        "phase_solving_dense".to_string(),
        (progress.phase == "solving_dense") as u8 as f64,
    );
    progress_scalars.insert(
        "phase_solving_sparse_lobpcg".to_string(),
        (progress.phase == "solving_sparse_lobpcg") as u8 as f64,
    );
    progress_scalars.insert(
        "phase_writing_artifacts".to_string(),
        (progress.phase == "writing_artifacts") as u8 as f64,
    );
    progress_scalars.insert(
        "phase_completed".to_string(),
        (progress.phase == "completed") as u8 as f64,
    );
    progress_scalars.insert(
        "solver_cpu_sparse_lobpcg".to_string(),
        (progress.solver_kind == "cpu_sparse_lobpcg") as u8 as f64,
    );
    progress_scalars.insert(
        "warning_dense_o_n3".to_string(),
        (progress.warning == Some("dense_o_n3_eigensolve_without_iteration_progress")) as u8 as f64,
    );

    let mut per_object_scalars = std::collections::HashMap::new();
    per_object_scalars.insert("fem_eigen_progress".to_string(), progress_scalars);

    StepUpdate {
        coupled_checkpoint: None,
        stats: StepStats {
            step: progress
                .iteration
                .map(u64::from)
                .unwrap_or(u64::from(progress.phase_index)),
            max_h_eff: progress.residual.unwrap_or(0.0),
            per_object_scalars,
            ..StepStats::default()
        },
        grid: [0, 0, 0],
        fem_mesh_generation_id,
        magnetization: None,
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
        scalar_row_due: false,
        finished: progress.phase == "completed",
    }
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
    on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let stage_asset = StageFemMeshAsset::build_from_backend_plan(&plan.backend_plan);
    run_planned_problem_with_callback_and_fem_mesh_identity(
        problem,
        plan,
        stage_asset.as_ref().map(|asset| &asset.identity),
        until_seconds,
        output_dir,
        field_every_n,
        on_step,
    )
}

pub fn run_planned_problem_with_callback_and_fem_mesh_identity(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    fem_mesh_identity: Option<&StageFemMeshIdentity>,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    require_resolved_runtime_sampling(problem, plan)?;
    if let fullmag_ir::StudyIR::Hysteresis { .. } = &problem.study {
        return hysteresis::run_planned_hysteresis_with_callback(
            problem,
            plan,
            until_seconds,
            output_dir,
            field_every_n,
            None,
            fem_mesh_identity,
            &mut on_step,
        );
    }
    let fem_stage_context = fem_mesh_identity
        .cloned()
        .map(types::FemStageExecutionContext::from_mesh_identity);
    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start_for_problem(
        problem,
        output_dir.to_path_buf(),
        artifacts::build_field_context(problem, plan),
        artifact_pipeline::DEFAULT_ARTIFACT_PIPELINE_CAPACITY,
    )?;
    let artifact_writer = Some(artifact_pipeline.sender());

    let cpu_threads = configured_cpu_threads(problem);
    let executed_result = with_cpu_parallelism(cpu_threads, || match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let grid = fdm.grid.cells;
            let resolution = dispatch::resolve_fdm_engine_with_trail(problem)?;
            let mut executed = dispatch::execute_fdm(
                resolution.engine,
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
            )?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            Ok(executed)
        }
        BackendPlanIR::FdmMultilayer(fdm) => {
            let resolution = dispatch::resolve_fdm_engine_with_trail(problem)?;
            let mut executed = dispatch::execute_fdm_multilayer(
                resolution.engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                Some((
                    &fdm.common_cells,
                    &mut on_step as &mut dyn FnMut(StepUpdate) -> StepAction,
                )),
                artifact_writer.clone(),
            )?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            Ok(executed)
        }
        BackendPlanIR::Fem(fem) => {
            let resolution = dispatch::resolve_fem_engine_for_plan_with_trail(
                problem,
                fem,
                field_every_n != u64::MAX,
            )?;
            let crossover_decision = resolution.fem_crossover_decision.clone();
            let live = Some(types::LiveStepConsumer {
                grid: [0, 0, 0],
                field_every_n,
                initial_snapshot: false,
                display_selection: None,
                interrupt_requested: None,
                on_step: &mut on_step,
            });
            let mut executed = if fem.relaxation.is_some() {
                fem::relax::execute_fem_relax_with_context_in_mode(
                    fem_engine_kind(resolution.engine),
                    fem,
                    fem_stage_context.as_ref().expect("FEM stage context"),
                    until_seconds,
                    &plan.output_plan.outputs,
                    live,
                    artifact_writer.clone(),
                    plan.common.execution_mode,
                )
            } else {
                dispatch::execute_fem_with_context_in_mode(
                    resolution.engine,
                    fem,
                    fem_stage_context.as_ref().expect("FEM stage context"),
                    until_seconds,
                    &plan.output_plan.outputs,
                    live,
                    artifact_writer.clone(),
                    plan.common.execution_mode,
                )
            }?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            attach_fem_crossover_decision_to_executed_run(&mut executed, crossover_decision);
            Ok(executed)
        }
        BackendPlanIR::FemEigen(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            let mut progress_callback = |progress| {
                on_step(fem_eigen_progress_update(
                    progress,
                    fem_stage_context
                        .as_ref()
                        .and_then(|context| context.generation_id()),
                ))
            };
            dispatch::execute_fem_eigen_with_progress(
                engine,
                fem,
                &plan.output_plan.outputs,
                &mut progress_callback,
            )
        }
        BackendPlanIR::FemFrequencyResponse(response) => {
            frequency_response::execute_fem_frequency_response_validation_with_context(
                response,
                fem_stage_context.as_ref().expect("FEM stage context"),
                output_dir,
                None,
                Some(&mut on_step as &mut dyn FnMut(StepUpdate) -> StepAction),
            )
        }
    });
    let pipeline_summary = artifact_pipeline.finish();
    let mut executed = match executed_result {
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
    attach_plan_integrator_resolution(&mut executed, plan);
    spin_wave_response::append_requested_spin_wave_artifacts(problem, plan, &mut executed)?;
    executed
        .auxiliary_artifacts
        .extend(spin_wave_sampling::requested_finite_k_artifacts(
            problem, plan, output_dir,
        )?);

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
    let final_m = match &plan.backend_plan {
        BackendPlanIR::Fem(_) => None,
        _ => Some(
            executed
                .result
                .final_magnetization
                .iter()
                .flat_map(|v| v.iter().copied())
                .collect(),
        ),
    };
    let final_grid = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => [fdm.grid.cells[0], fdm.grid.cells[1], fdm.grid.cells[2]],
        BackendPlanIR::FdmMultilayer(fdm) => [
            fdm.common_cells[0],
            fdm.common_cells[1],
            fdm.common_cells[2],
        ],
        BackendPlanIR::Fem(_)
        | BackendPlanIR::FemEigen(_)
        | BackendPlanIR::FemFrequencyResponse(_) => [0, 0, 0],
    };
    on_step(StepUpdate {
        coupled_checkpoint: None,
        stats: final_stats,
        grid: final_grid,
        fem_mesh_generation_id: fem_stage_context
            .as_ref()
            .and_then(|context| context.generation_id()),
        magnetization: final_m,
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
        scalar_row_due: true,
        finished: true,
    });

    Ok(executed.result)
}

/// Run a problem with a live callback and scoped hysteresis artifact refs.
pub fn run_planned_problem_with_callback_and_hysteresis_stage_id(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    hysteresis_stage_id: Option<&str>,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    require_resolved_runtime_sampling(problem, plan)?;
    if let fullmag_ir::StudyIR::Hysteresis { .. } = &problem.study {
        return hysteresis::run_planned_hysteresis_with_callback(
            problem,
            plan,
            until_seconds,
            output_dir,
            field_every_n,
            hysteresis_stage_id,
            None,
            &mut on_step,
        );
    }
    run_planned_problem_with_callback(
        problem,
        plan,
        until_seconds,
        output_dir,
        field_every_n,
        on_step,
    )
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
    on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let stage_asset = StageFemMeshAsset::build_from_backend_plan(&plan.backend_plan);
    run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_fem_mesh_identity(
        problem,
        plan,
        stage_asset.as_ref().map(|asset| &asset.identity),
        until_seconds,
        output_dir,
        field_every_n,
        display_selection,
        interrupt_requested,
        initial_snapshot,
        on_step,
    )
}

pub fn run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_fem_mesh_identity(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    fem_mesh_identity: Option<&StageFemMeshIdentity>,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_fem_mesh_identity_and_autosave_root(
        problem,
        plan,
        fem_mesh_identity,
        until_seconds,
        output_dir,
        output_dir,
        field_every_n,
        display_selection,
        interrupt_requested,
        initial_snapshot,
        on_step,
    )
}

pub fn run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_fem_mesh_identity_and_autosave_root(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    fem_mesh_identity: Option<&StageFemMeshIdentity>,
    until_seconds: f64,
    output_dir: &Path,
    autosave_root: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    require_resolved_runtime_sampling(problem, plan)?;
    if let fullmag_ir::StudyIR::Hysteresis { .. } = &problem.study {
        return hysteresis::run_planned_hysteresis_with_live_preview(
            problem,
            plan,
            fem_mesh_identity,
            until_seconds,
            output_dir,
            field_every_n,
            display_selection,
            interrupt_requested,
            initial_snapshot,
            None,
            &mut on_step,
        );
    }
    let fem_stage_context = fem_mesh_identity
        .cloned()
        .map(types::FemStageExecutionContext::from_mesh_identity);
    let mut artifact_pipeline =
        artifact_pipeline::ArtifactPipeline::start_for_problem_with_autosave_root(
            problem,
            output_dir.to_path_buf(),
            autosave_root.to_path_buf(),
            artifacts::build_field_context(problem, plan),
            artifact_pipeline::DEFAULT_ARTIFACT_PIPELINE_CAPACITY,
        )?;
    let artifact_writer = Some(artifact_pipeline.sender());

    let cpu_threads = configured_cpu_threads(problem);
    let live_display_selection = (field_every_n != u64::MAX).then_some(display_selection);
    let executed_result = with_cpu_parallelism(cpu_threads, || match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => {
            let grid = fdm.grid.cells;
            let resolution = dispatch::resolve_fdm_engine_with_trail(problem)?;
            let mut executed = dispatch::execute_fdm(
                resolution.engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                Some(types::LiveStepConsumer {
                    grid,
                    field_every_n,
                    initial_snapshot,
                    display_selection: live_display_selection,
                    interrupt_requested,
                    on_step: &mut on_step,
                }),
                artifact_writer.clone(),
            )?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            Ok(executed)
        }
        BackendPlanIR::FdmMultilayer(fdm) => {
            let resolution = dispatch::resolve_fdm_engine_with_trail(problem)?;
            let mut executed = dispatch::execute_fdm_multilayer(
                resolution.engine,
                fdm,
                until_seconds,
                &plan.output_plan.outputs,
                Some((
                    &fdm.common_cells,
                    &mut on_step as &mut dyn FnMut(StepUpdate) -> StepAction,
                )),
                artifact_writer.clone(),
            )?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            Ok(executed)
        }
        BackendPlanIR::Fem(fem) => {
            let resolution = dispatch::resolve_fem_engine_for_plan_with_trail(
                problem,
                fem,
                field_every_n != u64::MAX,
            )?;
            let crossover_decision = resolution.fem_crossover_decision.clone();
            eprintln!(
                "[fullmag-runner] live FEM engine: resolved_engine_id={} fallback={:?}",
                dispatch::fem_engine_label(resolution.engine),
                resolution.fallback.as_ref().map(|f| &f.reason),
            );
            let live = Some(types::LiveStepConsumer {
                grid: [0, 0, 0],
                field_every_n,
                initial_snapshot,
                display_selection: live_display_selection,
                interrupt_requested,
                on_step: &mut on_step,
            });
            let mut executed = if fem.relaxation.is_some() {
                fem::relax::execute_fem_relax_with_context_in_mode(
                    fem_engine_kind(resolution.engine),
                    fem,
                    fem_stage_context.as_ref().expect("FEM stage context"),
                    until_seconds,
                    &plan.output_plan.outputs,
                    live,
                    artifact_writer.clone(),
                    plan.common.execution_mode,
                )
            } else {
                dispatch::execute_fem_with_context_in_mode(
                    resolution.engine,
                    fem,
                    fem_stage_context.as_ref().expect("FEM stage context"),
                    until_seconds,
                    &plan.output_plan.outputs,
                    live,
                    artifact_writer.clone(),
                    plan.common.execution_mode,
                )
            }?;
            attach_resolved_fallback_to_executed_run(&mut executed, resolution.fallback);
            attach_fem_crossover_decision_to_executed_run(&mut executed, crossover_decision);
            Ok(executed)
        }
        BackendPlanIR::FemEigen(fem) => {
            let engine = dispatch::resolve_fem_engine(problem)?;
            let mut progress_callback = |progress| {
                on_step(fem_eigen_progress_update(
                    progress,
                    fem_stage_context
                        .as_ref()
                        .and_then(|context| context.generation_id()),
                ))
            };
            dispatch::execute_fem_eigen_with_progress(
                engine,
                fem,
                &plan.output_plan.outputs,
                &mut progress_callback,
            )
        }
        BackendPlanIR::FemFrequencyResponse(response) => {
            frequency_response::execute_fem_frequency_response_validation_with_context(
                response,
                fem_stage_context.as_ref().expect("FEM stage context"),
                output_dir,
                interrupt_requested,
                Some(&mut on_step as &mut dyn FnMut(StepUpdate) -> StepAction),
            )
        }
    });
    let pipeline_summary = artifact_pipeline.finish();
    let mut executed = match executed_result {
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
    attach_plan_integrator_resolution(&mut executed, plan);
    spin_wave_response::append_requested_spin_wave_artifacts(problem, plan, &mut executed)?;
    executed
        .auxiliary_artifacts
        .extend(spin_wave_sampling::requested_finite_k_artifacts(
            problem, plan, output_dir,
        )?);

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
        BackendPlanIR::Fem(_)
        | BackendPlanIR::FemEigen(_)
        | BackendPlanIR::FemFrequencyResponse(_) => [0, 0, 0],
    };
    on_step(StepUpdate {
        coupled_checkpoint: None,
        stats: final_stats,
        grid: final_grid,
        fem_mesh_generation_id: fem_stage_context
            .as_ref()
            .and_then(|context| context.generation_id()),
        magnetization: None,
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
        scalar_row_due: true,
        finished: true,
    });

    Ok(executed.result)
}

/// Run a problem with live preview and scoped hysteresis artifact refs.
pub fn run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_hysteresis_stage_id(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    hysteresis_stage_id: Option<&str>,
    on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    let stage_asset = StageFemMeshAsset::build_from_backend_plan(&plan.backend_plan);
    run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_hysteresis_stage_id_and_fem_mesh_identity(
        problem,
        plan,
        stage_asset.as_ref().map(|asset| &asset.identity),
        until_seconds,
        output_dir,
        field_every_n,
        display_selection,
        interrupt_requested,
        initial_snapshot,
        hysteresis_stage_id,
        on_step,
    )
}

pub fn run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_hysteresis_stage_id_and_fem_mesh_identity(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    fem_mesh_identity: Option<&StageFemMeshIdentity>,
    until_seconds: f64,
    output_dir: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    hysteresis_stage_id: Option<&str>,
    on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_hysteresis_stage_id_and_fem_mesh_identity_and_autosave_root(
        problem,
        plan,
        fem_mesh_identity,
        until_seconds,
        output_dir,
        output_dir,
        field_every_n,
        display_selection,
        interrupt_requested,
        initial_snapshot,
        hysteresis_stage_id,
        on_step,
    )
}

pub fn run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_hysteresis_stage_id_and_fem_mesh_identity_and_autosave_root(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    fem_mesh_identity: Option<&StageFemMeshIdentity>,
    until_seconds: f64,
    output_dir: &Path,
    autosave_root: &Path,
    field_every_n: u64,
    display_selection: &(dyn Fn() -> DisplaySelectionState + Send + Sync),
    interrupt_requested: Option<&std::sync::atomic::AtomicBool>,
    initial_snapshot: bool,
    hysteresis_stage_id: Option<&str>,
    mut on_step: impl FnMut(StepUpdate) -> StepAction + Send,
) -> Result<RunResult, RunError> {
    require_resolved_runtime_sampling(problem, plan)?;
    if let fullmag_ir::StudyIR::Hysteresis { .. } = &problem.study {
        return hysteresis::run_planned_hysteresis_with_live_preview(
            problem,
            plan,
            fem_mesh_identity,
            until_seconds,
            output_dir,
            field_every_n,
            display_selection,
            interrupt_requested,
            initial_snapshot,
            hysteresis_stage_id,
            &mut on_step,
        );
    }
    run_planned_problem_with_live_preview_interruptible_with_initial_snapshot_and_fem_mesh_identity_and_autosave_root(
        problem,
        plan,
        fem_mesh_identity,
        until_seconds,
        output_dir,
        autosave_root,
        field_every_n,
        display_selection,
        interrupt_requested,
        initial_snapshot,
        on_step,
    )
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

    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start_for_problem(
        problem,
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
    let mut executed = match executed_result {
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
    attach_plan_integrator_resolution(&mut executed, &plan);

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
        coupled_checkpoint: None,
        stats: final_stats,
        grid: fdm.grid.cells,
        fem_mesh_generation_id: None,
        magnetization: Some(final_m),
        preview_field: None,
        cached_preview_fields: None,
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
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
    let fem_mesh_generation_id = runtime.stage_context().generation_id();

    let mut artifact_pipeline = artifact_pipeline::ArtifactPipeline::start_for_problem(
        problem,
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
    let mut executed = match executed_result {
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
    attach_plan_integrator_resolution(&mut executed, &plan);

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
        coupled_checkpoint: None,
        stats: final_stats,
        grid: [0, 0, 0],
        fem_mesh_generation_id,
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
        hysteresis_field_m_t: None,
        hysteresis_point_index: None,
        hysteresis_settle_step_index: None,
        hysteresis_settle_step_kind: None,
        hysteresis_settle_step_method: None,
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
    create_planned_interactive_runtime_with_stage_fem_mesh_asset(
        problem,
        plan,
        None,
        continuation_magnetization,
    )
}

/// Create a unified interactive runtime while reusing the stage-owned FEM mesh asset.
pub fn create_planned_interactive_runtime_with_stage_fem_mesh_asset(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    stage_fem_mesh_asset: Option<&StageFemMeshAsset>,
    continuation_magnetization: Option<&[[f64; 3]]>,
) -> Result<InteractiveRuntime, RunError> {
    create_planned_interactive_runtime_with_stage_fem_mesh_asset_and_preview_cadence(
        problem,
        plan,
        stage_fem_mesh_asset,
        u64::MAX,
        continuation_magnetization,
    )
}

/// Create a persistent runtime with the actual live-preview cadence known by the caller.
pub fn create_planned_interactive_runtime_with_stage_fem_mesh_asset_and_preview_cadence(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
    stage_fem_mesh_asset: Option<&StageFemMeshAsset>,
    field_every_n: u64,
    continuation_magnetization: Option<&[[f64; 3]]>,
) -> Result<InteractiveRuntime, RunError> {
    require_supported_fem_topology(problem, plan)?;
    let backend: Box<dyn InteractiveBackend> = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => Box::new(InteractiveFdmPreviewRuntime::create_from_plan(
            problem, fdm,
        )?),
        BackendPlanIR::Fem(fem) => Box::new(InteractiveFemPreviewRuntime::create_from_plan(
            problem,
            fem,
            stage_fem_mesh_asset,
            field_every_n != u64::MAX,
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
    require_resolved_runtime_sampling(problem, plan)?;
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
        BackendPlanIR::FemFrequencyResponse(_) => Err(RunError {
            message:
                "interactive preview snapshot is not supported for FEM frequency-response plans"
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
        BackendPlanIR::FemFrequencyResponse(_) => Err(RunError {
            message:
                "interactive vector-field snapshots are not supported for FEM frequency-response plans"
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
    require_supported_fem_topology(problem, plan)?;
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
        BackendPlanIR::Fem(fem) => {
            let engine =
                dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem, false)?.engine;
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
        BackendPlanIR::FemFrequencyResponse(_) => {
            let (engine_id, engine_label, accelerator) =
                fem_frequency_response_runtime_engine_info();
            Ok(RuntimeEngineInfo {
                backend_family: "fem_frequency_response".to_string(),
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

fn fem_frequency_response_session_runtime_defaults(
    engine: dispatch::FemEngine,
) -> (&'static str, &'static str, &'static str) {
    match engine {
        #[cfg(feature = "fem-gpu")]
        dispatch::FemEngine::CpuNative => (
            "fem-frequency-response-production-cpu",
            "fem_frequency_response_production_cpu",
            "bin/fullmag-fem-gpu-bin",
        ),
        #[cfg(not(feature = "fem-gpu"))]
        dispatch::FemEngine::CpuNative => (
            "fem-frequency-response-validation",
            "fem_frequency_response_dense_validation",
            "../../bin/fullmag-bin",
        ),
        #[cfg(feature = "fem-gpu")]
        dispatch::FemEngine::NativeGpu => (
            "fem-frequency-response-production-cpu",
            "fem_frequency_response_production_cpu",
            "bin/fullmag-fem-gpu-bin",
        ),
        #[cfg(not(feature = "fem-gpu"))]
        dispatch::FemEngine::NativeGpu => (
            "fem-frequency-response-validation",
            "fem_frequency_response_dense_validation",
            "../../bin/fullmag-bin",
        ),
    }
}

fn fem_frequency_response_runtime_engine_info() -> (&'static str, &'static str, &'static str) {
    #[cfg(feature = "fem-gpu")]
    {
        (
            "fem_frequency_response_production_cpu",
            "FEM Frequency Response Production CPU",
            "cpu",
        )
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        (
            "fem_frequency_response_dense_validation",
            "FEM Frequency Response Dense Validation",
            "cpu",
        )
    }
}

pub fn resolve_planned_runtime_capabilities(
    problem: &ProblemIR,
    plan: &fullmag_ir::ExecutionPlanIR,
) -> Result<BackendCapabilities, RunError> {
    require_supported_fem_topology(problem, plan)?;
    match &plan.backend_plan {
        BackendPlanIR::Fdm(_) => Ok(capabilities_for_fdm_engine(
            dispatch::resolve_fdm_engine_with_trail(problem)?.engine,
            capabilities::FdmCapabilityProfile::SingleGrid,
        )),
        BackendPlanIR::Fem(fem) => Ok(capabilities_for_fem_engine(
            dispatch::resolve_fem_engine_for_plan_with_trail(problem, fem, false)?.engine,
        )),
        BackendPlanIR::FdmMultilayer(_) => Ok(capabilities_for_fdm_engine(
            dispatch::resolve_fdm_engine_with_trail(problem)?.engine,
            capabilities::FdmCapabilityProfile::Multilayer,
        )),
        BackendPlanIR::FemEigen(_) => Ok(capabilities_for_fem_eigen_engine(
            dispatch::resolve_fem_engine_with_trail(problem)?.engine,
        )),
        BackendPlanIR::FemFrequencyResponse(_) => {
            Ok(capabilities_for_fem_frequency_response_validation_engine(
                dispatch::FemEngine::CpuNative,
            ))
        }
    }
}

pub fn resolve_session_runtime(problem: &ProblemIR) -> Result<ResolvedSessionRuntime, RunError> {
    resolve_session_runtime_with_registry_and_preview(problem, None, false)
}

pub fn resolve_session_runtime_for_preview(
    problem: &ProblemIR,
    field_every_n: u64,
) -> Result<ResolvedSessionRuntime, RunError> {
    resolve_session_runtime_with_registry_and_preview(problem, None, field_every_n != u64::MAX)
}

pub fn resolve_session_runtime_with_registry(
    problem: &ProblemIR,
    registry: Option<&RuntimeRegistry>,
) -> Result<ResolvedSessionRuntime, RunError> {
    resolve_session_runtime_with_registry_and_preview(problem, registry, false)
}

pub fn resolve_session_runtime_with_registry_and_preview(
    problem: &ProblemIR,
    registry: Option<&RuntimeRegistry>,
    preview_enabled: bool,
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
        preview_enabled,
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
                fem_crossover_decision: None,
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
                fem_crossover_decision: None,
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
                fem_crossover_decision: dispatch_resolution.fem_crossover_decision,
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
                fem_crossover_decision: None,
            })
        }
        (BackendPlanIR::FemFrequencyResponse(_), dispatch::DispatchEngine::Fem(engine)) => {
            let (default_family, engine_id, default_worker) =
                fem_frequency_response_session_runtime_defaults(engine);
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
                fem_crossover_decision: None,
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

/// Resume the CPU-double coupled M3 reference runtime from the exact backend
/// state captured in a session checkpoint.
pub fn resume_reference_fdm_from_coupled_checkpoint(
    plan: &FdmPlanIR,
    checkpoint: serde_json::Value,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<RunResult, RunError> {
    Ok(
        cpu_reference::execute_reference_fdm_with_coupled_checkpoint(
            plan,
            until_seconds,
            outputs,
            None,
            None,
            Some(checkpoint),
        )?
        .result,
    )
}

/// Resume the CPU-double coupled M3 reference runtime and return the public
/// qualification evidence emitted by the accepted backend execution.
#[derive(serde::Serialize)]
pub struct CoupledM3ResumeEvidence {
    status: RunStatus,
    total_steps: usize,
    final_time: Option<f64>,
    final_magnetization: Vec<[f64; 3]>,
    accepted_transport: Box<serde_json::value::RawValue>,
    coupled_checkpoint: Box<serde_json::value::RawValue>,
}

pub fn resume_reference_fdm_from_coupled_checkpoint_evidence(
    plan: &FdmPlanIR,
    checkpoint: serde_json::Value,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<CoupledM3ResumeEvidence, RunError> {
    let executed = cpu_reference::execute_reference_fdm_with_coupled_checkpoint(
        plan,
        until_seconds,
        outputs,
        None,
        None,
        Some(checkpoint),
    )?;
    let artifact = |path: &str| -> Result<Box<serde_json::value::RawValue>, RunError> {
        let bytes = &executed
            .auxiliary_artifacts
            .iter()
            .find(|artifact| artifact.relative_path == path)
            .ok_or_else(|| RunError {
                message: format!("resumed coupled M3 execution did not emit {path}"),
            })?
            .bytes;
        let raw = String::from_utf8(bytes.clone()).map_err(|error| RunError {
            message: format!("reading resumed coupled M3 artifact {path}: {error}"),
        })?;
        serde_json::value::RawValue::from_string(raw).map_err(|error| RunError {
            message: format!("validating resumed coupled M3 artifact {path}: {error}"),
        })
    };
    Ok(CoupledM3ResumeEvidence {
        status: executed.result.status,
        total_steps: executed.result.steps.len(),
        final_time: executed.result.steps.last().map(|step| step.time),
        final_magnetization: executed.result.final_magnetization,
        accepted_transport: artifact("transport/spin_transport_accepted.json")?,
        coupled_checkpoint: artifact("transport/coupled_checkpoint.json")?,
    })
}

pub fn run_reference_multilayer_fdm(
    plan: &FdmMultilayerPlanIR,
    until_seconds: f64,
    outputs: &[OutputIR],
) -> Result<RunResult, RunError> {
    fdm::reject_adaptive_multilayer_plan(plan)?;
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
    require_tetrahedral_fem_plan_mesh(
        &plan.mesh,
        plan.mesh_build_report.as_ref(),
        "fem_eigen_reference",
    )?;
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
    #[cfg(not(feature = "fem-gpu"))]
    use std::sync::atomic::AtomicBool;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn fdm_auto_integrator_provenance_round_trips_for_cpu_and_cuda_execution_records() {
        let mut problem = ProblemIR::bootstrap_example();
        let fullmag_ir::StudyIR::TimeEvolution { dynamics, .. } = &mut problem.study else {
            panic!("bootstrap problem must be a time-evolution study");
        };
        let fullmag_ir::DynamicsIR::Llg { integrator, .. } = dynamics;
        *integrator = "auto".to_string();
        let plan = fullmag_plan::plan(&problem).expect("auto integrator should plan");

        for engine in ["cpu_reference", "cuda_fdm"] {
            let mut provenance = ExecutionProvenance {
                execution_engine: engine.to_string(),
                precision: "double".to_string(),
                ..Default::default()
            };
            attach_plan_integrator_resolution_to_provenance(&mut provenance, &plan);
            let round_trip: ExecutionProvenance = serde_json::from_str(
                &serde_json::to_string(&provenance).expect("provenance serializes"),
            )
            .expect("provenance deserializes");
            assert_eq!(round_trip.requested_integrator.as_deref(), Some("auto"));
            assert_eq!(round_trip.resolved_integrator.as_deref(), Some("rk45"));
        }
    }

    fn resolved_auto_sampling_problem() -> (ProblemIR, fullmag_ir::ExecutionPlanIR) {
        let mut problem = ProblemIR::bootstrap_example();
        problem
            .problem_meta
            .runtime_metadata
            .insert("active_stage_id".into(), json!("excite"));
        problem.problem_meta.runtime_metadata.insert(
            "study_pipeline".into(),
            json!({
                "version": "study_pipeline.v1",
                "nodes": [{"id": "excite", "enabled": true}]
            }),
        );
        let sample_period_s = 1.0 / 13.0e9;
        problem.study.sampling_mut().table_autosave = Some(fullmag_ir::TableAutosaveIR {
            kind: "table_autosave".into(),
            table_id: "default".into(),
            sample_period_s: None,
            sample_period_policy: Some(fullmag_ir::SamplingPeriodPolicyIR::AutoSincCutoff {
                nyquist_guard_factor: fullmag_ir::AUTO_SINC_NYQUIST_GUARD_FACTOR,
            }),
            resolved_sample_period_s: Some(sample_period_s),
            every_steps: None,
            quantities: vec!["t".into(), "my".into()],
            expressions: Vec::new(),
        });
        problem.study.sampling_mut().outputs = vec![OutputIR::FieldResolvedAuto {
            name: "m".into(),
            every_seconds: sample_period_s,
            requested_policy: fullmag_ir::SamplingPeriodPolicyIR::AutoSincCutoff {
                nyquist_guard_factor: fullmag_ir::AUTO_SINC_NYQUIST_GUARD_FACTOR,
            },
        }];
        problem.field_drives = vec![fullmag_ir::RegionalFieldDriveIR {
            id: "k0-sinc-antenna".into(),
            name: "K0 sinc antenna".into(),
            kind: fullmag_ir::FieldDriveKindIR::Regional,
            enabled: true,
            target: fullmag_ir::FieldTargetIR::Global {},
            amplitude_b_t: 1.0e-3,
            direction: [0.0, 1.0, 0.0],
            spatial_profile: fullmag_ir::FieldSpatialProfileIR::Uniform {},
            waveform: fullmag_ir::TimeDependenceIR::SincPulse {
                cutoff_hz: 5.0e9,
                t0: 50.0e-12,
                amplitude: 1.0,
            },
            time_origin: fullmag_ir::FieldTimeOriginIR::StageLocal,
            activation: fullmag_ir::DriveActivationIR::StageIds {
                stage_ids: vec!["excite".into()],
            },
            migration: None,
        }];
        let resolution = fullmag_plan::SamplingResolutionIR {
            schema_version: fullmag_plan::SAMPLING_RESOLUTION_SCHEMA_VERSION.to_string(),
            requested_policy: fullmag_ir::SamplingPeriodPolicyIR::AutoSincCutoff {
                nyquist_guard_factor: fullmag_ir::AUTO_SINC_NYQUIST_GUARD_FACTOR,
            },
            sample_period_s,
            maximum_cutoff_hz: 5.0e9,
            nyquist_guard_factor: fullmag_ir::AUTO_SINC_NYQUIST_GUARD_FACTOR,
            target_nyquist_hz: 6.5e9,
            sampling_frequency_hz: 13.0e9,
            source_drive_ids: vec!["k0-sinc-antenna".into()],
            target_stage_id: "excite".into(),
        };
        problem.problem_meta.runtime_metadata.insert(
            "sampling_resolution".into(),
            serde_json::to_value(resolution).expect("resolution should serialize"),
        );
        let plan = fullmag_plan::plan(&problem).expect("resolved automatic sampling should plan");
        (problem, plan)
    }

    #[test]
    fn runtime_sampling_accepts_canonical_resolution_and_explicit_legacy() {
        let (problem, plan) = resolved_auto_sampling_problem();
        require_resolved_runtime_sampling(&problem, &plan)
            .expect("canonical automatic resolution should dispatch");

        let explicit = ProblemIR::bootstrap_example();
        let explicit_plan =
            fullmag_plan::plan(&explicit).expect("explicit legacy problem should plan");
        require_resolved_runtime_sampling(&explicit, &explicit_plan)
            .expect("explicit legacy sampling should not require automatic provenance");
    }

    #[test]
    fn runtime_sampling_rejects_missing_or_invalid_automatic_provenance() {
        let (problem, plan) = resolved_auto_sampling_problem();

        let mut missing = problem.clone();
        missing
            .problem_meta
            .runtime_metadata
            .remove("sampling_resolution");
        assert!(require_resolved_runtime_sampling(&missing, &plan)
            .expect_err("resolved automatic table without provenance must fail")
            .message
            .contains("sampling_resolution"));

        let invalid_cases = [
            ("schema_version", json!("sampling_resolution.v0")),
            ("sample_period_s", json!(1.0e-12)),
            ("maximum_cutoff_hz", json!(0.0)),
            ("nyquist_guard_factor", json!(1.2)),
            ("target_nyquist_hz", json!(6.4e9)),
            ("sampling_frequency_hz", json!(12.0e9)),
            ("source_drive_ids", json!([])),
            ("target_stage_id", json!("other")),
        ];
        for (field, invalid_value) in invalid_cases {
            let mut invalid = problem.clone();
            invalid
                .problem_meta
                .runtime_metadata
                .get_mut("sampling_resolution")
                .and_then(serde_json::Value::as_object_mut)
                .expect("resolution metadata should be an object")
                .insert(field.to_string(), invalid_value);
            let error = require_resolved_runtime_sampling(&invalid, &plan)
                .expect_err("malformed automatic sampling provenance must fail");
            assert!(
                error.message.contains(field),
                "expected {field} in validation error, got {}",
                error.message
            );
        }
    }

    #[test]
    fn runtime_sampling_rejects_output_only_auto_without_provenance_or_with_wrong_cadence() {
        let (mut problem, plan) = resolved_auto_sampling_problem();
        problem.study.sampling_mut().table_autosave = None;
        problem
            .problem_meta
            .runtime_metadata
            .remove("sampling_resolution");
        let error = require_resolved_runtime_sampling(&problem, &plan)
            .expect_err("output-only resolved auto must retain provenance");
        assert!(error.message.contains("sampling_resolution"));

        let (mut problem, mut plan_with_wrong_cadence) = resolved_auto_sampling_problem();
        problem.study.sampling_mut().table_autosave = None;
        let OutputIR::FieldResolvedAuto { every_seconds, .. } =
            &mut plan_with_wrong_cadence.output_plan.outputs[0]
        else {
            panic!("planner must preserve the resolved-auto marker");
        };
        *every_seconds *= 2.0;
        let error = require_resolved_runtime_sampling(&problem, &plan_with_wrong_cadence)
            .expect_err("every resolved-auto output cadence must match provenance");
        assert!(error.message.contains("output cadence"));
    }

    #[test]
    fn runtime_sampling_rejects_forged_missing_extra_and_stale_sinc_sources() {
        for source_ids in [
            Vec::<String>::new(),
            vec!["forged".into()],
            vec!["k0-sinc-antenna".into(), "extra".into()],
        ] {
            let (mut problem, plan) = resolved_auto_sampling_problem();
            problem
                .problem_meta
                .runtime_metadata
                .get_mut("sampling_resolution")
                .and_then(serde_json::Value::as_object_mut)
                .expect("sampling resolution metadata")
                .insert("source_drive_ids".into(), json!(source_ids));
            let error = require_resolved_runtime_sampling(&problem, &plan)
                .expect_err("source IDs must exactly match active sinc drives");
            assert!(error.message.contains("source_drive_ids"));
        }

        let (mut stale, plan) = resolved_auto_sampling_problem();
        let fullmag_ir::TimeDependenceIR::SincPulse { cutoff_hz, .. } =
            &mut stale.field_drives[0].waveform
        else {
            panic!("fixture drive must be sinc");
        };
        *cutoff_hz = 4.0e9;
        let error = require_resolved_runtime_sampling(&stale, &plan)
            .expect_err("stale cutoff provenance must be rejected");
        assert!(error.message.contains("maximum_cutoff_hz"));

        let (mut inactive, plan) = resolved_auto_sampling_problem();
        inactive.field_drives[0].enabled = false;
        let error = require_resolved_runtime_sampling(&inactive, &plan)
            .expect_err("a disabled provenance source must be rejected");
        assert!(error.message.contains("active sinc source"));
    }

    #[test]
    fn every_public_planned_execution_path_calls_the_runtime_sampling_guard() {
        let lib_source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("read lib.rs");
        assert_eq!(
            lib_source
                .split("#[cfg(test)]\nmod tests")
                .next()
                .expect("lib.rs should contain production code")
                .matches("require_resolved_runtime_sampling(problem, plan)?;")
                .count(),
            7,
            "all seven public planned runner entry points must fail closed before dispatch"
        );
        let interactive_source = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/interactive/runtime.rs"
        ))
        .expect("read interactive runtime");
        assert!(
            interactive_source
                .contains("crate::require_resolved_runtime_sampling(problem, plan)?;"),
            "direct InteractiveRuntime::execute_planned_streaming calls must fail closed"
        );
    }

    fn fem_frequency_response_validation_problem(
        frequencies_hz: Vec<f64>,
    ) -> fullmag_ir::ProblemIR {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        problem.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
            fdm: None,
            fem: Some(fullmag_ir::FemHintsIR {
                order: 1,
                hmax: 2e-9,
                mesh: Some("meshes/unit_tet.msh".to_string()),
                demag_solver_policy: None,
            }),
            hybrid: None,
        });
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: Vec::new(),
            fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
                geometry_name: "strip".to_string(),
                mesh_source: Some("meshes/unit_tet.msh".to_string()),
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "strip".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                    ],
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            }],
            fem_domain_mesh_asset: None,
        });
        problem.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
        problem.study = fullmag_ir::StudyIR::FrequencyResponse {
            dynamics: problem.study.dynamics().clone(),
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            normalization: fullmag_ir::FrequencyResponseNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Include,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
            excitation: fullmag_ir::FrequencyExcitationIR {
                field_au_per_m: [0.0, 0.0, 1.0],
                phase_rad: 0.0,
            },
            frequencies_hz: fullmag_ir::FrequencySweepIR {
                values_hz: frequencies_hz,
            },
            solver_policy: None,
            sampling: fullmag_ir::SamplingIR {
                table_autosave: None,
                stage_autosave: None,
                outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                    observable: fullmag_ir::FrequencyResponseOutputIR::SusceptibilityTensor,
                }],
            },
        };
        problem
    }

    fn topology_guard_frequency_plan_mut(
        plan: &mut fullmag_ir::ExecutionPlanIR,
    ) -> &mut fullmag_ir::FemFrequencyResponsePlanIR {
        let BackendPlanIR::FemFrequencyResponse(fem) = &mut plan.backend_plan else {
            panic!("topology guard fixture must produce a FEM frequency-response plan");
        };
        fem
    }

    fn certified_mixed_topology_guard_fixture(
    ) -> (fullmag_ir::ProblemIR, fullmag_ir::ExecutionPlanIR) {
        let mut problem = fem_frequency_response_validation_problem(vec![1.0e9]);
        problem
            .problem_meta
            .runtime_metadata
            .insert("runtime_selection".to_string(), json!({"device": "cpu"}));
        let mut plan = fullmag_plan::plan(&problem)
            .expect("tetrahedral FEM frequency-response fixture should plan");
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_python_golden.json"
        ))
        .expect("mixed topology golden fixture should be valid JSON");
        let mesh: fullmag_ir::MeshIR = serde_json::from_value(golden["mesh"].clone())
            .expect("mixed topology golden mesh should deserialize");
        let certificate: fullmag_ir::MixedLayerTopologyCertificateV1IR =
            serde_json::from_value(golden["certificate"].clone())
                .expect("mixed topology golden certificate should deserialize");
        let fingerprint = mesh.topology_fingerprint_v6();
        assert_eq!(certificate.topology_fingerprint, fingerprint);
        fullmag_ir::validate_mixed_layer_topology_certificate_against_mesh(&certificate, &mesh)
            .expect("mixed topology golden certificate should bind to its mesh");

        let fem = topology_guard_frequency_plan_mut(&mut plan);
        let mut report: fullmag_ir::FemSharedDomainBuildReportIR = serde_json::from_value(json!({
            "build_mode": "shared_domain",
            "fallbacks_triggered": [],
            "degraded": false,
            "mixed_layer_topology_certificate": certificate,
        }))
        .expect("minimal shared-domain report should deserialize");
        report.mixed_topology_provenance = Some(fullmag_ir::FemMixedTopologyProvenanceIR {
            requested_topology: fullmag_ir::FemMeshTopologyFamilyIR::MixedP1,
            resolved_topology: fullmag_ir::FemMeshTopologyFamilyIR::MixedP1,
            accepted_certificate_fingerprint: fingerprint,
            requested_device: fullmag_ir::ExecutionDevice::Cpu,
            precision: fem.precision,
            capability_status: fullmag_ir::FemMixedTopologyCapabilityStatusIR::Implemented,
        });
        fem.mesh = mesh;
        fem.mesh_build_report = Some(report);
        (problem, plan)
    }

    fn certified_mixed_relaxation_guard_fixture_for_layers_and_device(
        layer_count: u32,
        requested_device: fullmag_ir::ExecutionDevice,
    ) -> (fullmag_ir::ProblemIR, fullmag_ir::ExecutionPlanIR) {
        let device = match requested_device {
            fullmag_ir::ExecutionDevice::Cpu => "cpu",
            fullmag_ir::ExecutionDevice::Gpu => "gpu",
            _ => panic!("mixed runtime fixture requires explicit CPU or GPU"),
        };
        let mut problem = fem_session_runtime_problem();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            json!({"device": device, "precision": "double"}),
        );
        let mut plan =
            fullmag_plan::plan(&problem).expect("tetrahedral FEM runtime fixture should plan");
        problem.energy_terms = vec![
            fullmag_ir::EnergyTermIR::Exchange,
            fullmag_ir::EnergyTermIR::Demag {
                realization: fullmag_ir::RequestedFemDemagIR::PoissonRobin,
            },
        ];
        problem.study = fullmag_ir::StudyIR::Relaxation {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            dynamics: None,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1.0e-4),
                energy_tolerance_j: None,
                max_steps: Some(16),
                max_relaxation_time_s: None,
            },
            sampling: problem.study.sampling().clone(),
        };
        let golden: serde_json::Value = serde_json::from_str(match layer_count {
            1 => include_str!(
                "../../fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_python_golden.json"
            ),
            2 => include_str!(
                "../../fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_layers_2_python_golden.json"
            ),
            3 => include_str!(
                "../../fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_layers_3_python_golden.json"
            ),
            4 => include_str!(
                "../../fullmag-ir/tests/fixtures/mixed_layer_topology_certificate_v1_layers_4_python_golden.json"
            ),
            _ => panic!("mixed runtime fixture exists only for layer counts 1 through 4"),
        })
        .expect("mixed topology golden fixture should be valid JSON");
        let mesh: fullmag_ir::MeshIR = serde_json::from_value(golden["mesh"].clone())
            .expect("mixed topology golden mesh should deserialize");
        let certificate: fullmag_ir::MixedLayerTopologyCertificateV1IR =
            serde_json::from_value(golden["certificate"].clone())
                .expect("mixed topology golden certificate should deserialize");
        let fingerprint = mesh
            .mixed_topology_fingerprint_for_version(&certificate.topology_fingerprint_version)
            .expect("mixed topology fingerprint version must be supported");
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            panic!("relaxation topology guard fixture must produce a FEM plan");
        };
        fem.enable_demag = true;
        fem.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin);
        fem.relaxation = Some(fullmag_ir::RelaxationControlIR {
            algorithm: fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: fullmag_ir::RelaxStopIR {
                torque_tolerance_apm: Some(1.0e-4),
                energy_tolerance_j: None,
                max_steps: Some(16),
                max_relaxation_time_s: None,
            },
        });
        fem.mfem_device_string = Some(device.to_string());
        fem.mesh = mesh;
        fem.initial_magnetization = vec![[1.0, 0.0, 0.0]; fem.mesh.nodes.len()];
        let mut report: fullmag_ir::FemSharedDomainBuildReportIR = serde_json::from_value(json!({
            "build_mode": "shared_domain",
            "fallbacks_triggered": [],
            "degraded": false,
            "mixed_layer_topology_certificate": certificate,
        }))
        .expect("minimal shared-domain report should deserialize");
        report.mixed_topology_provenance = Some(fullmag_ir::FemMixedTopologyProvenanceIR {
            requested_topology: fullmag_ir::FemMeshTopologyFamilyIR::MixedP1,
            resolved_topology: fullmag_ir::FemMeshTopologyFamilyIR::MixedP1,
            accepted_certificate_fingerprint: fingerprint,
            requested_device,
            precision: fem.precision,
            capability_status: fullmag_ir::FemMixedTopologyCapabilityStatusIR::Implemented,
        });
        fem.mesh_build_report = Some(report);
        (problem, plan)
    }

    fn certified_mixed_cpu_relaxation_guard_fixture_for_layers(
        layer_count: u32,
    ) -> (fullmag_ir::ProblemIR, fullmag_ir::ExecutionPlanIR) {
        certified_mixed_relaxation_guard_fixture_for_layers_and_device(
            layer_count,
            fullmag_ir::ExecutionDevice::Cpu,
        )
    }

    fn certified_mixed_cpu_relaxation_guard_fixture(
    ) -> (fullmag_ir::ProblemIR, fullmag_ir::ExecutionPlanIR) {
        certified_mixed_cpu_relaxation_guard_fixture_for_layers(1)
    }

    fn topology_guard_error(
        problem: &fullmag_ir::ProblemIR,
        plan: &fullmag_ir::ExecutionPlanIR,
    ) -> String {
        require_supported_fem_topology(problem, plan)
            .expect_err("fixture must be rejected before FEM backend startup")
            .message
    }

    #[test]
    fn fem_topology_guard_rejects_mixed_metadata_on_tetrahedral_plan() {
        let (problem, mixed_plan) = certified_mixed_topology_guard_fixture();
        let mixed_report = match &mixed_plan.backend_plan {
            BackendPlanIR::FemFrequencyResponse(fem) => fem
                .mesh_build_report
                .clone()
                .expect("mixed fixture should carry a build report"),
            _ => unreachable!(),
        };
        let mut tetrahedral_plan = fullmag_plan::plan(&problem)
            .expect("tetrahedral FEM frequency-response fixture should plan");
        topology_guard_frequency_plan_mut(&mut tetrahedral_plan).mesh_build_report =
            Some(mixed_report);

        assert_eq!(
            topology_guard_error(&problem, &tetrahedral_plan),
            "fem_mixed_p1_runtime_metadata_without_mixed_topology: mixed certificate/provenance cannot be attached to a tetrahedral plan"
        );
    }

    #[test]
    fn fem_topology_guard_requires_report_certificate_and_provenance() {
        let (problem, mut missing_report) = certified_mixed_topology_guard_fixture();
        topology_guard_frequency_plan_mut(&mut missing_report).mesh_build_report = None;
        assert_eq!(
            topology_guard_error(&problem, &missing_report),
            "fem_mixed_p1_runtime_certificate_required: shared-domain build report is missing; fallback=none"
        );

        let (_, mut missing_certificate) = certified_mixed_topology_guard_fixture();
        topology_guard_frequency_plan_mut(&mut missing_certificate)
            .mesh_build_report
            .as_mut()
            .expect("mixed fixture should carry a build report")
            .mixed_layer_topology_certificate = None;
        assert_eq!(
            topology_guard_error(&problem, &missing_certificate),
            "fem_mixed_p1_runtime_certificate_required: accepted topology certificate is missing; fallback=none"
        );

        let (_, mut missing_provenance) = certified_mixed_topology_guard_fixture();
        topology_guard_frequency_plan_mut(&mut missing_provenance)
            .mesh_build_report
            .as_mut()
            .expect("mixed fixture should carry a build report")
            .mixed_topology_provenance = None;
        assert_eq!(
            topology_guard_error(&problem, &missing_provenance),
            "fem_mixed_p1_runtime_provenance_required: accepted certificate identity is not bound to the plan; fallback=none"
        );
    }

    #[test]
    fn fem_topology_guard_rejects_valid_certificate_when_build_report_is_degraded() {
        for case in ["report_fallback", "degraded"] {
            let (problem, mut plan) = certified_mixed_cpu_relaxation_guard_fixture();
            let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
                unreachable!()
            };
            let report = fem
                .mesh_build_report
                .as_mut()
                .expect("mixed fixture must carry a build report");
            match case {
                "report_fallback" => {
                    report.fallbacks_triggered =
                        Some(vec!["mesh_size_field_simplified".to_string()]);
                }
                "degraded" => report.degraded = true,
                _ => unreachable!(),
            }
            let certificate = report
                .mixed_layer_topology_certificate
                .as_ref()
                .expect("mixed fixture must retain a valid certificate");
            fullmag_ir::validate_mixed_layer_topology_certificate_against_mesh(
                certificate,
                &fem.mesh,
            )
            .expect("the regression must isolate enclosing build-report state");

            let error = require_supported_fem_topology(&problem, &plan)
                .expect_err("runner must reject a degraded mixed build report");
            assert!(
                error
                    .message
                    .contains("fem_mixed_p1_runtime_build_report_rejected"),
                "case={case}: {}",
                error.message
            );
        }
    }

    #[test]
    fn fem_topology_guard_rejects_stale_certificate_and_provenance_bindings() {
        let (problem, mut stale_certificate) = certified_mixed_topology_guard_fixture();
        topology_guard_frequency_plan_mut(&mut stale_certificate)
            .mesh_build_report
            .as_mut()
            .expect("mixed fixture should carry a build report")
            .mixed_layer_topology_certificate
            .as_mut()
            .expect("mixed fixture should carry a certificate")
            .topology_fingerprint = "0".repeat(64);
        let certificate_error = topology_guard_error(&problem, &stale_certificate);
        assert!(
            certificate_error.starts_with(
                "fem_mixed_p1_runtime_certificate_stale: certificate=0000000000000000000000000000000000000000000000000000000000000000 mesh="
            ),
            "{certificate_error}"
        );
        assert!(certificate_error.ends_with("; fallback=none"));

        let (_, mut stale_fingerprint) = certified_mixed_topology_guard_fixture();
        topology_guard_frequency_plan_mut(&mut stale_fingerprint)
            .mesh_build_report
            .as_mut()
            .expect("mixed fixture should carry a build report")
            .mixed_topology_provenance
            .as_mut()
            .expect("mixed fixture should carry provenance")
            .accepted_certificate_fingerprint = "0".repeat(64);
        assert_eq!(
            topology_guard_error(&problem, &stale_fingerprint),
            "fem_mixed_p1_runtime_provenance_stale: plan provenance does not match the exact mesh fingerprint/topology/precision; fallback=none"
        );

        let (_, mut stale_precision) = certified_mixed_topology_guard_fixture();
        topology_guard_frequency_plan_mut(&mut stale_precision)
            .mesh_build_report
            .as_mut()
            .expect("mixed fixture should carry a build report")
            .mixed_topology_provenance
            .as_mut()
            .expect("mixed fixture should carry provenance")
            .precision = fullmag_ir::ExecutionPrecision::Single;
        assert_eq!(
            topology_guard_error(&problem, &stale_precision),
            "fem_mixed_p1_runtime_provenance_stale: plan provenance does not match the exact mesh fingerprint/topology/precision; fallback=none"
        );

        let (_, mut stale_device) = certified_mixed_topology_guard_fixture();
        topology_guard_frequency_plan_mut(&mut stale_device)
            .mesh_build_report
            .as_mut()
            .expect("mixed fixture should carry a build report")
            .mixed_topology_provenance
            .as_mut()
            .expect("mixed fixture should carry provenance")
            .requested_device = fullmag_ir::ExecutionDevice::Gpu;
        assert_eq!(
            topology_guard_error(&problem, &stale_device),
            "fem_mixed_p1_runtime_provenance_stale: authored/managed device metadata does not match plan-bound effective device; fallback=none"
        );

        for status in [
            fullmag_ir::FemMixedTopologyCapabilityStatusIR::Unsupported,
            fullmag_ir::FemMixedTopologyCapabilityStatusIR::SourceVisible,
            fullmag_ir::FemMixedTopologyCapabilityStatusIR::ProductionExecutable,
            fullmag_ir::FemMixedTopologyCapabilityStatusIR::Validated,
        ] {
            let (_, mut promoted) = certified_mixed_topology_guard_fixture();
            topology_guard_frequency_plan_mut(&mut promoted)
                .mesh_build_report
                .as_mut()
                .expect("mixed fixture should carry a build report")
                .mixed_topology_provenance
                .as_mut()
                .expect("mixed fixture should carry provenance")
                .capability_status = status;
            assert_eq!(
                topology_guard_error(&problem, &promoted),
                "fem_mixed_p1_runtime_provenance_stale: capability status must be implemented until managed public runtime proof exists; fallback=none"
            );
        }
    }

    #[test]
    fn fem_topology_guard_rejects_hex8_as_unsupported_typed_topology() {
        let (problem, mut plan) = certified_mixed_topology_guard_fixture();
        topology_guard_frequency_plan_mut(&mut plan)
            .mesh
            .cells
            .types = vec![fullmag_ir::FemCellTypeIR::Hex8];

        assert_eq!(
            topology_guard_error(&problem, &plan),
            "fem_typed_topology_unsupported_before_backend: cells=[Hex8]; facets=[Tri3, Quad4]; study=fem_frequency_response; fallback=none"
        );
    }

    #[test]
    fn fem_topology_guard_rejects_empty_typed_topology() {
        let (problem, mut plan) = certified_mixed_topology_guard_fixture();
        let fem = topology_guard_frequency_plan_mut(&mut plan);
        fem.mesh.cells.types.clear();
        fem.mesh.facets.types.clear();

        let error = topology_guard_error(&problem, &plan);
        assert!(
            error.starts_with("fem_typed_topology_unsupported_before_backend:"),
            "{error}"
        );
    }

    #[test]
    fn fem_topology_guard_fully_bound_mixed_frequency_plan_reaches_scope_rejection() {
        let (problem, plan) = certified_mixed_topology_guard_fixture();

        let expected = "fem_mixed_p1_runtime_scope_rejected: study=fem_frequency_response; requested_device=cpu; precision=Double; required=explicit_cpu_or_gpu+strict+double+P1+exchange+poisson_robin_or_dirichlet+PG_BB_or_NCG_or_LLG_overdamped; fallback=none";
        assert_eq!(topology_guard_error(&problem, &plan), expected);
        assert_eq!(
            resolve_planned_runtime_engine(&problem, &plan)
                .expect_err("engine resolution must reject mixed topology")
                .message,
            expected
        );
        assert_eq!(
            resolve_planned_runtime_capabilities(&problem, &plan)
                .expect_err("capability resolution must reject mixed topology")
                .message,
            expected
        );
        assert_eq!(
            create_planned_interactive_runtime(&problem, &plan, None)
                .err()
                .expect("interactive startup must reject mixed topology")
                .message,
            expected
        );

        let mut stale_problem = problem.clone();
        stale_problem.backend_policy.execution_precision = fullmag_ir::ExecutionPrecision::Single;
        assert_eq!(
            topology_guard_error(&stale_problem, &plan),
            "fem_mixed_p1_runtime_provenance_stale: plan provenance does not match the exact mesh fingerprint/topology/precision; fallback=none"
        );
    }

    #[test]
    fn fem_topology_guard_accepts_bound_cpu_and_gpu_exact_layer_matrix() {
        for requested_device in [
            fullmag_ir::ExecutionDevice::Cpu,
            fullmag_ir::ExecutionDevice::Gpu,
        ] {
            for layer_count in [1, 2, 3] {
                let (problem, plan) =
                    certified_mixed_relaxation_guard_fixture_for_layers_and_device(
                        layer_count,
                        requested_device,
                    );
                let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
                    panic!("mixed relaxation fixture must produce a FEM plan");
                };
                let certificate = fem
                    .mesh_build_report
                    .as_ref()
                    .and_then(|report| report.mixed_layer_topology_certificate.as_ref())
                    .expect("multi-layer runtime fixture must carry a certificate");
                assert_eq!(certificate.requested_layer_count, layer_count);
                assert_eq!(certificate.realized_layer_count, layer_count);
                assert_eq!(
                    fem.mesh
                        .cells
                        .types
                        .iter()
                        .filter(|family| **family == fullmag_ir::FemCellTypeIR::Prism6)
                        .count(),
                    2 * layer_count as usize,
                    "fixture must exercise genuinely stacked magnetic prisms",
                );
                require_supported_fem_topology(&problem, &plan).unwrap_or_else(|error| {
                    panic!(
                        "bound {requested_device:?} exact layer {layer_count} mixed P1 relaxation must cross the guard: {error:?}"
                    )
                });
            }
        }
    }

    #[test]
    fn fem_topology_guard_rejects_correctly_bound_exact_four_layer_cpu_and_gpu() {
        for requested_device in [
            fullmag_ir::ExecutionDevice::Cpu,
            fullmag_ir::ExecutionDevice::Gpu,
        ] {
            let (problem, plan) =
                certified_mixed_relaxation_guard_fixture_for_layers_and_device(4, requested_device);
            let BackendPlanIR::Fem(fem) = &plan.backend_plan else {
                panic!("mixed relaxation fixture must produce a FEM plan");
            };
            let certificate = fem
                .mesh_build_report
                .as_ref()
                .and_then(|report| report.mixed_layer_topology_certificate.as_ref())
                .expect("L=4 rejection fixture must carry a certificate");
            fullmag_ir::validate_mixed_layer_topology_certificate_against_mesh(
                certificate,
                &fem.mesh,
            )
            .expect("L=4 rejection fixture must be correctly certificate-bound");
            let expected = topology_guard_error(&problem, &plan);
            assert!(expected.contains("fem_mixed_p1_runtime_scope_rejected"));
            assert!(expected.contains("fallback=none"));
            assert_eq!(
                resolve_planned_runtime_engine(&problem, &plan)
                    .expect_err("L=4 must reject before backend engine resolution")
                    .message,
                expected,
            );
        }
    }

    #[test]
    fn fem_topology_guard_accepts_only_bound_cpu_double_relaxation_scope() {
        let (problem, plan) = certified_mixed_cpu_relaxation_guard_fixture();
        require_supported_fem_topology(&problem, &plan)
            .expect("bound CPU-double mixed P1 relaxation must cross the runner guard");

        let mut v3_plan = plan.clone();
        let BackendPlanIR::Fem(v3_fem) = &mut v3_plan.backend_plan else {
            unreachable!()
        };
        let v3_fingerprint = v3_fem.mesh.mixed_topology_fingerprint_v3().unwrap();
        let v3_report = v3_fem
            .mesh_build_report
            .as_mut()
            .expect("mixed fixture must carry a build report");
        let v3_certificate = v3_report
            .mixed_layer_topology_certificate
            .as_mut()
            .expect("mixed fixture must carry a certificate");
        v3_certificate.topology_fingerprint_version = "v3".to_string();
        v3_certificate.topology_fingerprint = v3_fingerprint.clone();
        v3_report
            .mixed_topology_provenance
            .as_mut()
            .expect("mixed fixture must carry provenance")
            .accepted_certificate_fingerprint = v3_fingerprint;
        require_supported_fem_topology(&problem, &v3_plan)
            .expect("bound v3 CPU-double mixed P1 relaxation must cross the runner guard");

        for case in [
            "gpu",
            "single",
            "extended",
            "time_evolution",
            "unsupported_status",
        ] {
            let mut rejected_problem = problem.clone();
            let mut rejected_plan = plan.clone();
            match case {
                "gpu" => {
                    rejected_problem.problem_meta.runtime_metadata.insert(
                        "runtime_selection".to_string(),
                        json!({"device": "gpu", "precision": "double"}),
                    );
                }
                "single" => {
                    rejected_problem.backend_policy.execution_precision =
                        fullmag_ir::ExecutionPrecision::Single;
                }
                "extended" => {
                    rejected_problem.validation_profile.execution_mode =
                        fullmag_ir::ExecutionMode::Extended;
                }
                "time_evolution" => {
                    rejected_problem.study = fullmag_ir::ProblemIR::bootstrap_example().study;
                }
                "unsupported_status" => {
                    let BackendPlanIR::Fem(fem) = &mut rejected_plan.backend_plan else {
                        unreachable!()
                    };
                    fem.mesh_build_report
                        .as_mut()
                        .and_then(|report| report.mixed_topology_provenance.as_mut())
                        .expect("fixture carries mixed provenance")
                        .capability_status =
                        fullmag_ir::FemMixedTopologyCapabilityStatusIR::Unsupported;
                }
                _ => unreachable!(),
            }
            let error = require_supported_fem_topology(&rejected_problem, &rejected_plan)
                .expect_err("runner must fail closed outside the qualified mixed P1 tuple");
            assert!(
                error
                    .message
                    .contains("fem_mixed_p1_runtime_scope_rejected")
                    || error
                        .message
                        .contains("fem_mixed_p1_runtime_provenance_stale"),
                "case={case}: {}",
                error.message
            );
            assert!(
                error.message.contains("fallback=none"),
                "case={case}: {}",
                error.message
            );
        }
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn certified_mixed_cpu_planned_runtime_resolves_native_engine() {
        let _env_guard = ENV_LOCK.lock().expect("lock FEM execution environment");
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        let (problem, plan) = certified_mixed_cpu_relaxation_guard_fixture();

        let engine = resolve_planned_runtime_engine(&problem, &plan)
            .expect("certified mixed-P1 CPU plan should resolve a runtime engine");

        assert_eq!(engine.backend_family, "fem");
        assert_eq!(engine.engine_id, "fem_cpu_native");
        assert_eq!(engine.accelerator, "cpu");
    }

    #[test]
    fn fem_topology_guard_accepts_bound_gpu_double_relaxation_scope() {
        let (mut problem, mut plan) = certified_mixed_cpu_relaxation_guard_fixture();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            json!({"device": "gpu", "precision": "double"}),
        );
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            unreachable!()
        };
        fem.mesh_build_report
            .as_mut()
            .and_then(|report| report.mixed_topology_provenance.as_mut())
            .expect("mixed fixture carries provenance")
            .requested_device = fullmag_ir::ExecutionDevice::Gpu;

        require_supported_fem_topology(&problem, &plan)
            .expect("bound GPU-double mixed P1 relaxation must cross the startup guard");
    }

    #[test]
    fn fem_topology_guard_keeps_bound_gpu_when_environment_changes_to_cpu_after_planning() {
        let _env_guard = ENV_LOCK.lock().expect("lock FEM execution environment");
        let (mut problem, mut plan) = certified_mixed_cpu_relaxation_guard_fixture();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            json!({"device": "gpu", "precision": "double"}),
        );
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            unreachable!()
        };
        fem.mesh_build_report
            .as_mut()
            .and_then(|report| report.mixed_topology_provenance.as_mut())
            .expect("mixed fixture carries provenance")
            .requested_device = fullmag_ir::ExecutionDevice::Gpu;

        unsafe {
            std::env::set_var("FULLMAG_FEM_EXECUTION", "cpu");
        }
        let result = require_supported_fem_topology(&problem, &plan);
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }

        result.expect(
            "a live environment change must not redirect or invalidate a GPU-bound execution plan",
        );
    }

    #[test]
    fn fem_topology_guard_rejects_gpu_mixed_p1_with_unsupported_physics() {
        let (mut problem, mut plan) = certified_mixed_cpu_relaxation_guard_fixture();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            json!({"device": "gpu", "precision": "double"}),
        );
        problem
            .energy_terms
            .push(fullmag_ir::EnergyTermIR::BulkDmi { d: 1.0 });
        let BackendPlanIR::Fem(fem) = &mut plan.backend_plan else {
            unreachable!()
        };
        fem.mesh_build_report
            .as_mut()
            .and_then(|report| report.mixed_topology_provenance.as_mut())
            .expect("mixed fixture carries provenance")
            .requested_device = fullmag_ir::ExecutionDevice::Gpu;

        let error = require_supported_fem_topology(&problem, &plan)
            .expect_err("unsupported GPU physics must reject before backend allocation");
        assert!(error
            .message
            .contains("fem_mixed_p1_runtime_scope_rejected"));
        assert!(error.message.contains("requested_device=gpu"));
        assert!(error.message.contains("fallback=none"));
    }

    #[test]
    fn fem_topology_guard_rejects_managed_override_changed_after_planning() {
        let (mut problem, plan) = certified_mixed_cpu_relaxation_guard_fixture();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".to_string(),
            json!({"device": "auto", "precision": "double"}),
        );
        problem.problem_meta.runtime_metadata.insert(
            "runtime_device_override".to_string(),
            json!({"device": "cpu", "source": "managed_launcher"}),
        );

        require_supported_fem_topology(&problem, &plan)
            .expect("effective managed CPU request must cross the mixed topology guard");

        problem.problem_meta.runtime_metadata.insert(
            "runtime_device_override".to_string(),
            json!({"device": "gpu", "source": "managed_launcher"}),
        );
        let error = require_supported_fem_topology(&problem, &plan)
            .expect_err("changing a managed override after planning must reject as stale");
        assert_eq!(
            error.message,
            "fem_mixed_p1_runtime_provenance_stale: authored/managed device metadata does not match plan-bound effective device; fallback=none"
        );
    }

    #[test]
    fn fem_topology_guard_allows_tetrahedral_plan_at_capability_boundary() {
        let problem = fem_frequency_response_validation_problem(vec![1.0e9]);
        let mut plan = fullmag_plan::plan(&problem)
            .expect("tetrahedral FEM frequency-response fixture should plan");

        require_supported_fem_topology(&problem, &plan)
            .expect("tetrahedral plan must remain compatible");
        resolve_planned_runtime_capabilities(&problem, &plan)
            .expect("tetrahedral plan must cross the capability boundary");

        let fem = topology_guard_frequency_plan_mut(&mut plan);
        fem.mesh.facets = fullmag_ir::FemFacetConnectivityIR::empty();
        require_supported_fem_topology(&problem, &plan)
            .expect("legacy tetrahedral plan without explicit facets must remain compatible");
    }

    #[cfg(not(feature = "fem-gpu"))]
    fn assert_frequency_response_rejects_without_dense_artifacts(
        problem: &fullmag_ir::ProblemIR,
        plan: &fullmag_ir::ExecutionPlanIR,
        output_dir_slug: &str,
        expected_reason: &str,
    ) {
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-{output_dir_slug}-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let err = run_planned_problem(problem, plan, 0.0, &output_dir)
            .expect_err("unsupported frequency response must not fall back to dense validation");

        assert!(err.message.contains(expected_reason), "{}", err.message);
        assert!(
            err.message
                .contains("Dense validation fallback is disabled"),
            "{}",
            err.message
        );
        assert!(
            !output_dir
                .join("response/magnetic_response_sweep.v1.json")
                .exists(),
            "unsupported response must not write dense validation sweep artifacts"
        );
        let _ = fs::remove_dir_all(&output_dir);
    }

    #[test]
    fn fem_relaxation_entrypoints_route_through_fem_relax_module() {
        let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("read lib.rs");
        let route_count = source.matches("fem::relax::execute_fem_relax_in_mode(").count()
            + source
                .matches("fem::relax::execute_fem_relax_with_context_in_mode(")
                .count();
        assert!(
            route_count >= 3,
            "run entrypoints should route FEM relaxation through fem::relax::execute_fem_relax, found {route_count}"
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    fn public_fem_dispatch_streams_transport_quantity_artifacts() {
        let _guard = ENV_LOCK.lock().expect("environment mutex");
        unsafe {
            std::env::set_var("FULLMAG_FEM_EXECUTION", "cpu");
        }
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        let mut fem = dispatch::test_tiny_fem_plan();
        let resolved = native_fem::test_resolved_steady_transport_plan();
        let descriptor = resolved.fem_cpu_double.as_ref().expect("FEM descriptor");
        fem.current_modules = vec![fullmag_ir::CurrentModuleIR::CurrentTransport {
            name: resolved.current_source_id.clone(),
            model: fullmag_ir::CurrentTransportModelIR::OhmicPoisson,
            current_density: None,
            solve_region: None,
            conductivity_s_per_m: None,
            coupling: fullmag_ir::TransportCouplingIR::OneWay,
            definition: Some(descriptor.charge_definition.clone()),
        }];
        fem.spin_transport_plans = vec![resolved];
        let plan = fullmag_ir::ExecutionPlanIR {
            common: fullmag_ir::CommonPlanMeta {
                ir_version: problem.ir_version.clone(),
                requested_backend: fullmag_ir::BackendTarget::Fem,
                resolved_backend: fullmag_ir::BackendTarget::Fem,
                execution_mode: fullmag_ir::ExecutionMode::Strict,
                material_field_plans: Vec::new(),
            },
            backend_plan: fullmag_ir::BackendPlanIR::Fem(fem),
            output_plan: fullmag_ir::OutputPlanIR {
                outputs: vec![
                    fullmag_ir::OutputIR::Field {
                        name: "V_electric".into(),
                        every_seconds: 1.0,
                    },
                    fullmag_ir::OutputIR::Field {
                        name: "J_charge".into(),
                        every_seconds: 1.0,
                    },
                    fullmag_ir::OutputIR::Field {
                        name: "spin_current_tensor".into(),
                        every_seconds: 1.0,
                    },
                ],
            },
            provenance: fullmag_ir::ProvenancePlanIR { notes: Vec::new() },
        };
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-public-fem-transport-{}-{unique}",
            std::process::id()
        ));

        let result = run_planned_problem(&problem, &plan, 1.0e-13, &output_dir)
            .expect("public FEM dispatch should persist transport fields");
        unsafe {
            std::env::remove_var("FULLMAG_FEM_EXECUTION");
        }
        assert_eq!(result.status, RunStatus::Completed);
        for (quantity, components, unit) in [
            ("V_electric", 1, "V"),
            ("J_charge", 3, "A/m^2"),
            ("spin_potential", 3, "V"),
            ("spin_current_tensor", 9, "A/m^2"),
            ("torque_stt", 3, "1/s"),
        ] {
            let payload: serde_json::Value = serde_json::from_slice(
                &fs::read(
                    output_dir
                        .join("fields")
                        .join(quantity)
                        .join("step_000000.json"),
                )
                .unwrap_or_else(|error| panic!("missing {quantity} artifact: {error}")),
            )
            .expect("transport artifact JSON");
            assert_eq!(payload["component_count"], components, "{quantity}");
            assert_eq!(payload["unit"], unit, "{quantity}");
        }
        fs::remove_dir_all(output_dir).expect("remove public transport artifact fixture");
    }

    #[test]
    fn interactive_runtime_hysteresis_entrypoint_routes_through_hysteresis_runner() {
        let source = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/interactive/runtime.rs"
        ))
        .expect("read interactive runtime");
        assert!(
            source.contains("StudyIR::Hysteresis")
                && source.contains("run_planned_hysteresis_with_live_preview"),
            "unified InteractiveRuntime must route hysteresis through the hysteresis runner so per-point fields and settle algorithms are injected"
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
        assert!(pgbb.contains("native FEM CPU/MFEM/CUDA"), "{pgbb}");
        assert!(pgbb.contains("mu0 Ms V"), "{pgbb}");
        assert!(pgbb.contains("m/A"), "{pgbb}");
        assert!(pgbb.contains("owns no RK"), "{pgbb}");
        assert!(!pgbb.contains("fullmag_fem_backend_relax_step"), "{pgbb}");
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
        assert!(ncg.contains("native FEM CPU/MFEM/CUDA"), "{ncg}");
        assert!(ncg.contains("same physical energy metric"), "{ncg}");
        assert!(ncg.contains("m/A"), "{ncg}");
        assert!(ncg.contains("owns no RK"), "{ncg}");
        assert!(!ncg.contains("fullmag_fem_backend_relax_step"), "{ncg}");
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
        assert!(tpi.contains("CPU/MFEM development-only"), "{tpi}");
        assert!(
            tpi.contains("**under-development** (native FEM CPU/MFEM only)"),
            "{tpi}"
        );
        assert!(tpi.contains("Strict mode rejects TPI"), "{tpi}");
        assert!(tpi.contains("Forced GPU rejects"), "{tpi}");
        assert!(tpi.contains("no hidden GPU-to-CPU fallback"), "{tpi}");
        assert!(!tpi.contains("FEM GPU/libCEED"), "{tpi}");
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
    fn fem_live_preview_hot_path_has_no_debug_logging() {
        for path in [
            "/src/fem/relax/direct_minimizer.rs",
            "/src/fem/relax/llg_overdamped.rs",
        ] {
            let source = fs::read_to_string(format!("{}{}", env!("CARGO_MANIFEST_DIR"), path))
                .expect("read FEM relaxation source");
            assert!(
                !source.contains("native-fem live update"),
                "{path} must not print per-preview live-update diagnostics in the solver hot path"
            );
        }
    }

    #[test]
    fn fem_relaxation_preview_copy_is_centralized() {
        for path in [
            "/src/fem/relax/direct_minimizer.rs",
            "/src/fem/relax/llg_overdamped.rs",
        ] {
            let source = fs::read_to_string(format!("{}{}", env!("CARGO_MANIFEST_DIR"), path))
                .expect("read FEM relaxation source");
            assert!(
                !source.contains(".copy_live_preview_field("),
                "{path} must use fem/relax/preview.rs as the only active-preview backend boundary"
            );
        }

        let preview = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/preview.rs"
        ))
        .expect("read fem/relax/preview.rs");
        assert!(
            preview.contains("pub(crate) fn build_fem_live_preview_field("),
            "fem/relax/preview.rs must own the native FEM live-preview boundary"
        );
        assert!(
            preview.contains("backend.copy_live_preview_field(request, node_count)"),
            "FEM live preview helper must route through the shared preview boundary"
        );
        assert!(
            preview.contains("backend.begin_live_preview_snapshot(&request)")
                || preview.contains("backend.begin_live_preview_snapshot(&deferred.request)"),
            "FEM cached vector preview must still use the native snapshot boundary"
        );
    }

    #[test]
    fn fem_relaxation_magnetization_payloads_use_snapshot_boundary() {
        for path in [
            "/src/fem/relax/direct_minimizer.rs",
            "/src/fem/relax/llg_overdamped.rs",
            "/src/fem/relax/finalize.rs",
        ] {
            let source = fs::read_to_string(format!("{}{}", env!("CARGO_MANIFEST_DIR"), path))
                .expect("read FEM relaxation source");
            assert!(
                !source.contains("backend.copy_m("),
                "{path} must not use direct synchronous magnetization copies for heavy payloads"
            );
        }
    }

    #[test]
    fn fem_streaming_field_snapshots_are_writer_owned() {
        let finalize = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/finalize.rs"
        ))
        .expect("read fem/relax/finalize.rs");
        assert!(
            finalize.contains("if artifacts.is_streaming()"),
            "native FEM finalization must branch streaming field snapshots away from in-memory materialization"
        );
        assert!(
            finalize.contains(".record_native_fem_field_snapshot(snapshot)?"),
            "streaming native FEM field snapshots must enqueue pending snapshot handles to the writer"
        );
        assert!(
            finalize
                .contains("copy_native_fem_field_snapshot(backend, &schedule.name, node_count)?"),
            "in-memory native FEM field snapshots must keep the materialized fallback"
        );
    }

    #[test]
    fn native_fem_preview_snapshot_wrapper_uses_abi_begin_wait_destroy() {
        let source = include_str!("native_fem.rs");
        assert!(
            source.contains("pub fn begin_live_preview_snapshot("),
            "NativeFemBackend must expose a preview snapshot wrapper"
        );
        assert!(
            source.contains("fullmag_fem_backend_begin_preview_snapshot"),
            "preview snapshots must use the native FEM begin-preview ABI"
        );
        assert!(
            source.contains("fullmag_fem_preview_snapshot_wait"),
            "preview snapshots must use the native FEM wait ABI"
        );
        assert!(
            source.contains("fullmag_fem_preview_snapshot_destroy"),
            "preview snapshots must destroy native FEM snapshot handles"
        );
    }

    #[test]
    fn fem_live_preview_uses_nonblocking_last_good_handoff() {
        for path in [
            "/src/fem/relax/direct_minimizer.rs",
            "/src/fem/relax/llg_overdamped.rs",
        ] {
            let source = fs::read_to_string(format!("{}{}", env!("CARGO_MANIFEST_DIR"), path))
                .expect("read FEM relaxation source");
            assert!(
                source.contains("FemPreviewHandoff::default()"),
                "{path} must keep live preview snapshot state across solver steps"
            );
            assert!(
                source.contains("preview_handoff.poll_active()?"),
                "{path} must poll completed preview snapshots without blocking"
            );
            assert!(
                source.contains("preview_handoff.request_preview("),
                "{path} must request live preview through the handoff boundary"
            );
            assert!(
                !source.contains("build_fem_live_preview_field(backend"),
                "{path} must not synchronously wait for active live preview snapshots"
            );
        }

        let preview = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/preview.rs"
        ))
        .expect("read fem/relax/preview.rs");
        assert!(
            preview.contains("struct FemPreviewHandoff"),
            "fem/relax/preview.rs must own live preview handoff state"
        );
        assert!(
            preview.contains("try_take_completed"),
            "live preview handoff must poll the bounded worker without blocking"
        );
        assert!(
            preview.contains("last_good") || preview.contains("active_ready"),
            "live preview handoff must retain the last completed preview"
        );
    }

    #[test]
    fn fem_preview_materialization_stays_outside_callback_deadline() {
        let preview = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/preview.rs"
        ))
        .expect("read fem/relax/preview.rs");
        let hot_path = preview
            .split("/// Build the active FEM preview field.")
            .next()
            .expect("preview hot-path section");

        assert!(
            preview.contains("struct PendingFemPreviewState"),
            "FEM live and cache previews must share one bounded materialization state"
        );
        assert!(
            preview.contains("preview_superseded_count"),
            "busy preview requests must be counted explicitly"
        );
        assert!(
            !hot_path.contains("backend.copy_live_preview_field(request, node_count)?"),
            "energy-density previews must not synchronously copy fields on the solver callback"
        );
        assert!(
            !preview.contains("pending: Vec<(LivePreviewRequest, NativeFemPreviewSnapshot)>"),
            "cached previews must not accumulate an unbounded set of native snapshots"
        );
        assert!(
            preview.contains("PreviewDestination::Active => self.active_ready = Some(result.field)")
                && preview.contains("PreviewDestination::Cache => self.cached_ready.push(result.field)"),
            "completed preview payloads must be moved from the worker result into the bounded solver-side handoff"
        );
        let removed_callback_clone = ["let mut last_good_field = field.", "clone();"].concat();
        let removed_reader = ["result.", "last_good_field"].concat();
        assert!(
            !preview.contains(&removed_callback_clone) && !preview.contains(&removed_reader),
            "the callback contract must not regress to a duplicated last-good clone/reader handoff"
        );
    }

    #[test]
    fn preview_disabled_live_runner_does_not_pass_display_selection() {
        for path in ["/src/lib.rs", "/src/hysteresis.rs"] {
            let source = fs::read_to_string(format!("{}{}", env!("CARGO_MANIFEST_DIR"), path))
                .expect("read runner source");
            assert!(
                source.contains(
                    "let live_display_selection = (field_every_n != u64::MAX).then_some(display_selection);"
                ),
                "{path} must translate preview-disabled cadence into no display-selection callbacks"
            );
            assert!(
                source.contains("display_selection: live_display_selection"),
                "{path} must wire the gated display-selection option into LiveStepConsumer"
            );
        }
    }

    #[test]
    fn native_fem_field_snapshot_wrapper_uses_abi_begin_wait_destroy() {
        let source = include_str!("native_fem.rs");
        assert!(
            source.contains("pub fn begin_field_snapshot("),
            "NativeFemBackend must expose a field snapshot wrapper"
        );
        assert!(
            source.contains("fullmag_fem_backend_begin_field_snapshot"),
            "field snapshots must use the native FEM begin-field ABI"
        );
        assert!(
            source.contains("fullmag_fem_field_snapshot_wait"),
            "field snapshots must use the native FEM wait ABI"
        );
        assert!(
            source.contains("fullmag_fem_field_snapshot_destroy"),
            "field snapshots must destroy native FEM snapshot handles"
        );
    }

    #[test]
    fn fem_live_magnetization_uses_bounded_deferred_snapshot_handoff() {
        for path in [
            "/src/fem/relax/direct_minimizer.rs",
            "/src/fem/relax/llg_overdamped.rs",
        ] {
            let source = fs::read_to_string(format!("{}{}", env!("CARGO_MANIFEST_DIR"), path))
                .expect("read FEM relaxation source");
            assert!(
                source.contains("FemPreviewHandoff::default()"),
                "{path} must keep the bounded snapshot frame state across solver steps"
            );
            assert!(
                source.contains("preview_handoff.request_magnetization"),
                "{path} must stage magnetization capture through the shared handoff boundary"
            );
            assert!(
                source.contains("preview_handoff.poll_magnetization"),
                "{path} must poll completed magnetization payloads without blocking"
            );
            assert!(
                source.contains("preview_handoff.flush_schedule_fence()"),
                "{path} must fence native enqueue before the next solver mutation"
            );
            assert!(
                !source.contains(
                    "begin_field_snapshot(\"m\", 0, 0.0, 0.0)?\n        .into_vector_field()?"
                ),
                "{path} must not synchronously wait for live magnetization snapshots"
            );
        }

        let preview = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/preview.rs"
        ))
        .expect("read fem/relax/preview.rs");
        assert!(
            preview.contains("struct DeferredFemSnapshotFrame"),
            "fem/relax/preview.rs must own one bounded deferred snapshot frame"
        );
        assert!(
            preview.contains("schedule_tx.send(())")
                || preview.contains("try_send_worker_output(&frame.schedule_tx, ())"),
            "snapshot worker must acknowledge native enqueue before materialization"
        );
        assert!(
            preview.contains("fn flush_schedule(&mut self) -> u64"),
            "solver must expose the exact-step pre-mutation schedule fence"
        );
    }

    #[test]
    fn native_fem_snapshot_abi_stages_gpu_payloads_async() {
        let source = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../backends/fem/src/api.cpp"
        ))
        .expect("read native FEM api.cpp");
        let pool = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../backends/fem/gpu/cuda/transfer/snapshot_pool.cpp"
        ))
        .expect("read native FEM snapshot_pool.cpp");
        assert!(
            pool.contains("cudaHostAlloc(&slot.host_aos"),
            "native FEM GPU snapshot pool must preallocate pinned host storage"
        );
        assert!(
            source.contains("cudaMemcpyAsync(\n        snapshot.staging.x"),
            "native FEM GPU snapshots must stage x component device-to-device asynchronously"
        );
        assert!(
            source.contains("cudaMemcpy2DAsync("),
            "native FEM GPU snapshots must copy staged device data to AoS host payload asynchronously"
        );
        assert!(
            source.contains(
                "cudaEventSynchronize(reinterpret_cast<cudaEvent_t>(snapshot->done_event))"
            ),
            "native FEM GPU snapshot wait must synchronize on the scheduled done event"
        );
        assert!(
            source.contains("destroy_snapshot_payload(*payload)"),
            "native FEM snapshot destroy must release CUDA staging resources"
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
        assert!(
            module.contains("pub(crate) fn finalize_terminal_cache")
                && module.contains("quantity_ids.push(display_selection.selection.quantity.as_str())"),
            "fem/relax/preview.rs must own bounded asynchronous terminal cache flushing that includes the active vector field"
        );
        assert!(
            module.contains("field_materialization_quantity_ids()"),
            "FEM cached preview refresh must materialize spatial scalar fields such as eden_total"
        );
        assert!(
            !module.contains("&cached_preview_quantities_for(display_selection)"),
            "FEM cached preview refresh must not use the vector-only preview cache quantity list"
        );
        let interactive_display = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/interactive_runtime/display_preview.rs"
        ))
        .expect("read interactive_runtime/display_preview.rs");
        assert!(
            interactive_display.contains("field_materialization_quantity_ids()"),
            "interactive FEM mesh preview cache must materialize spatial scalar fields such as eden_total"
        );
        assert!(
            module.contains("struct FemPreviewHandoff")
                && module.contains("request_cached_previews(")
                && module.contains("try_take_completed"),
            "fem/relax/preview.rs must own nonblocking cached-preview handoff state"
        );
        for path in [
            "/src/fem/relax/direct_minimizer.rs",
            "/src/fem/relax/llg_overdamped.rs",
        ] {
            let source = fs::read_to_string(format!("{}{}", env!("CARGO_MANIFEST_DIR"), path))
                .expect("read FEM relaxation source");
            assert!(
                source.contains("engine: FemEngine")
                    && !source.contains("FemEngine::CpuNative,"),
                "{path} must use the resolved FEM engine for cached-preview quantities, not hard-code CPU"
            );
            assert!(
                source.contains("FemPreviewHandoff::default()"),
                "{path} must keep one shared preview materializer across solver steps"
            );
            assert!(
                source.contains("preview_handoff.request_cached_previews(")
                    && source.contains("preview_handoff.poll_cached("),
                "{path} must use cached-preview handoff readiness instead of synchronous waits"
            );
            assert!(
                !source.contains("build_fem_cached_preview_fields("),
                "{path} must not synchronously warm cached preview fields in the hot loop"
            );
        }
        let finalize = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/fem/relax/finalize.rs"
        ))
        .expect("read FEM relaxation finalization source");
        assert!(
            finalize.contains("engine: FemEngine") && !finalize.contains("FemEngine::CpuNative,"),
            "FEM relaxation finalization must use the resolved engine for cached-preview flushes"
        );
        assert!(
            finalize.contains("preview_handoff.finalize_pending_until(")
                && finalize.contains("preview_handoff.finalize_terminal_cache(")
                && !finalize.contains("build_fem_final_cached_preview_fields(")
                && !finalize.contains("build_fem_cached_preview_fields("),
            "FEM relaxation finalization must drain and publish active/inactive fields through the bounded asynchronous handoff"
        );
        assert!(
            finalize.contains("if pending_preview_completed {")
                && finalize.contains("preview_handoff.take_terminal_publication("),
            "an expired terminal drain must publish explicit errors without retrying backend scheduling"
        );
        assert!(
            module.contains("self.finish_terminal_publication(fields, magnetization,")
                && finalize.contains("*last_step = live_stats.clone();"),
            "terminal FEM payloads, materialization states, and provenance must survive the later finished=true update"
        );
        let runner = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("read runner lib.rs");
        assert!(
            runner.contains("BackendPlanIR::Fem(_) => None,"),
            "the generic finished=true update must not mask asynchronous FEM terminal magnetization with a synchronous final-m copy"
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
        assert!(
            module.contains(".begin_field_snapshot(quantity, 0, 0.0, 0.0)?")
                && module.contains(".into_vector_field()?"),
            "native FEM relaxation field snapshots must use the native snapshot boundary"
        );
        assert!(
            !module.contains("backend.copy_m(")
                && !module.contains("backend.copy_h_ex(")
                && !module.contains("backend.copy_h_demag(")
                && !module.contains("backend.copy_h_eff("),
            "native FEM relaxation field snapshots must not return to synchronous copy helpers"
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
    fn interactive_fem_gpu_runtime_normalizes_native_gpu_plan() {
        let interactive_runtime = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/interactive_runtime.rs"
        ))
        .expect("read interactive_runtime.rs");

        assert!(
            interactive_runtime.contains("fn fem_plan_for_native_gpu(plan: &FemPlanIR)"),
            "interactive FEM runtime must own native GPU plan normalization"
        );
        assert!(
            interactive_runtime.contains("FemEngine::NativeGpu => fem_plan_for_native_gpu(plan)"),
            "interactive FEM GPU runtime must resolve mfem_device_string before backend creation"
        );
        assert!(
            !interactive_runtime.contains("FemEngine::NativeGpu => plan.clone()"),
            "interactive FEM GPU runtime must not create native backends from unresolved GPU plans"
        );
        assert!(
            interactive_runtime
                .contains("normalize_fem_plan_signature(&fem_plan_for_native_gpu(plan))"),
            "interactive FEM GPU runtime plan matching must use the same normalized GPU plan"
        );
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
            integrator: Some(IntegratorChoice::Heun),
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
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![
                        [0, 1, 2, 3],
                        [4, 5, 6, 7],
                    ]),
                    element_markers: vec![1, 0],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                        [0, 1, 2],
                        [4, 5, 6],
                    ]),
                    boundary_markers: vec![1, 99],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
                region_markers: vec![fullmag_ir::FemDomainRegionMarkerIR {
                    geometry_name: "strip".to_string(),
                    marker: 1,
                }],
                object_region_markers: Vec::new(),
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
        assert!(output_dir.join("fields/m/step_000002.json").is_file());
        assert!(output_dir.join("fields/H_ex/step_000000.json").is_file());
        assert!(output_dir.join("fields/H_ex/step_000002.json").is_file());

        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json"))
                .expect("metadata.json should be readable"),
        )
        .expect("metadata should parse");
        assert_eq!(metadata["field_snapshots"].as_u64(), Some(4));
        assert_eq!(metadata["scalar_rows"].as_u64(), Some(2));

        fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
    }

    #[cfg(not(feature = "cuda"))]
    #[test]
    fn auto_fdm_batch_run_persists_unavailable_cuda_fallback() {
        let _guard = ENV_LOCK.lock().expect("lock FDM execution environment");
        unsafe {
            std::env::remove_var("FULLMAG_FDM_EXECUTION");
        }
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem
            .problem_meta
            .runtime_metadata
            .insert("runtime_selection".to_string(), json!({"device": "auto"}));
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-auto-fdm-fallback-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = run_problem(&problem, 2e-13, &output_dir)
            .expect("auto FDM should execute on the CPU when CUDA is unavailable");
        assert_eq!(result.status, RunStatus::Completed);

        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json"))
                .expect("metadata.json should be readable"),
        )
        .expect("metadata should parse");
        let fallback = &metadata["execution_provenance"]["resolved_fallback"];
        assert_eq!(fallback["original_engine"], "fdm_cuda");
        assert_eq!(fallback["fallback_engine"], "fdm_cpu_reference");
        assert_eq!(fallback["reason"], "fdm_cuda_unavailable");

        fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
    }

    #[cfg(not(feature = "cuda"))]
    #[test]
    fn auto_fdm_live_run_persists_unavailable_cuda_fallback() {
        let _guard = ENV_LOCK.lock().expect("lock FDM execution environment");
        unsafe {
            std::env::remove_var("FULLMAG_FDM_EXECUTION");
        }
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem
            .problem_meta
            .runtime_metadata
            .insert("runtime_selection".to_string(), json!({"device": "auto"}));
        let plan = fullmag_plan::plan(&problem).expect("auto FDM should plan");
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-auto-fdm-live-fallback-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result =
            run_planned_problem_with_callback(&problem, &plan, 2e-13, &output_dir, 1, |_| {
                StepAction::Continue
            })
            .expect("live auto FDM should execute on the CPU when CUDA is unavailable");
        assert_eq!(result.status, RunStatus::Completed);

        let metadata: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("metadata.json"))
                .expect("metadata.json should be readable"),
        )
        .expect("metadata should parse");
        let fallback = &metadata["execution_provenance"]["resolved_fallback"];
        assert_eq!(fallback["original_engine"], "fdm_cuda");
        assert_eq!(fallback["fallback_engine"], "fdm_cpu_reference");
        assert_eq!(fallback["reason"], "fdm_cuda_unavailable");

        fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
    }

    #[cfg(not(feature = "fem-gpu"))]
    #[test]
    fn fem_frequency_response_plan_runs_dense_validation_and_writes_response_bundle() {
        let mut problem = fullmag_ir::ProblemIR::bootstrap_example();
        problem.backend_policy.requested_backend = fullmag_ir::BackendTarget::Fem;
        problem.backend_policy.discretization_hints = Some(fullmag_ir::DiscretizationHintsIR {
            fdm: None,
            fem: Some(fullmag_ir::FemHintsIR {
                order: 1,
                hmax: 2e-9,
                mesh: Some("meshes/unit_tet.msh".to_string()),
                demag_solver_policy: None,
            }),
            hybrid: None,
        });
        problem.geometry_assets = Some(fullmag_ir::GeometryAssetsIR {
            fdm_grid_assets: Vec::new(),
            fem_mesh_assets: vec![fullmag_ir::FemMeshAssetIR {
                geometry_name: "strip".to_string(),
                mesh_source: Some("meshes/unit_tet.msh".to_string()),
                mesh: Some(fullmag_ir::MeshIR {
                    mesh_name: "strip".to_string(),
                    nodes: vec![
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                    ],
                    cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                    element_markers: vec![1],
                    facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                    boundary_markers: vec![1],
                    periodic_boundary_pairs: Vec::new(),
                    periodic_node_pairs: Vec::new(),
                    per_domain_quality: std::collections::HashMap::new(),
                }),
            }],
            fem_domain_mesh_asset: None,
        });
        problem.energy_terms = vec![fullmag_ir::EnergyTermIR::Exchange];
        problem.study = fullmag_ir::StudyIR::FrequencyResponse {
            dynamics: problem.study.dynamics().clone(),
            operator: fullmag_ir::EigenOperatorConfigIR {
                kind: fullmag_ir::EigenOperatorIR::LinearizedLlg,
                include_demag: false,
            },
            equilibrium: fullmag_ir::EquilibriumSourceIR::Provided,
            k_sampling: Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            }),
            normalization: fullmag_ir::FrequencyResponseNormalizationIR::UnitL2,
            damping_policy: fullmag_ir::EigenDampingPolicyIR::Include,
            spin_wave_bc: fullmag_ir::SpinWaveBoundaryConditionIR::default(),
            magnetostatic_bc: fullmag_ir::MagnetostaticBoundaryConditionIR::default(),
            excitation: fullmag_ir::FrequencyExcitationIR {
                field_au_per_m: [0.0, 0.0, 1.0],
                phase_rad: 0.0,
            },
            frequencies_hz: fullmag_ir::FrequencySweepIR {
                values_hz: vec![1.0e9, 2.0e9],
            },
            solver_policy: None,
            sampling: fullmag_ir::SamplingIR {
                table_autosave: None,
                stage_autosave: None,
                outputs: vec![fullmag_ir::OutputIR::FrequencyResponseOutput {
                    observable: fullmag_ir::FrequencyResponseOutputIR::SusceptibilityTensor,
                }],
            },
        };
        let plan = fullmag_plan::plan(&problem).expect("frequency response should plan");
        assert!(matches!(
            plan.backend_plan,
            fullmag_ir::BackendPlanIR::FemFrequencyResponse(_)
        ));
        let runtime = resolve_planned_runtime_engine(&problem, &plan)
            .expect("frequency response validation runtime should resolve");
        assert_eq!(runtime.backend_family, "fem_frequency_response");
        assert_eq!(runtime.engine_id, "fem_frequency_response_dense_validation");
        let capabilities = resolve_planned_runtime_capabilities(&problem, &plan)
            .expect("frequency response validation capabilities should resolve");
        assert_eq!(
            capabilities.engine_id.as_str(),
            "fem_frequency_response_dense_validation"
        );
        assert!(!capabilities.supports_frequency_response);
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = run_planned_problem(&problem, &plan, 0.0, &output_dir)
            .expect("frequency response validation runner should write artifacts");

        assert_eq!(result.status, RunStatus::Completed);
        let sweep_path = output_dir.join("response/magnetic_response_sweep.v1.json");
        let manifest_path = output_dir.join("response/artifact_manifest.json");
        let diagnostics_path = output_dir.join("response/diagnostics/solver.v1.json");
        let family_manifest_path = output_dir.join("frequency_domain/manifest.v1.json");
        assert!(sweep_path.is_file());
        assert!(manifest_path.is_file());
        assert!(diagnostics_path.is_file());
        assert!(family_manifest_path.is_file());
        assert!(output_dir
            .join("response/frequency_points/frequency_0001.json")
            .is_file());
        assert!(output_dir
            .join("response/field_payloads/frequency_0001/vector.bin")
            .is_file());
        let sweep: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(sweep_path).expect("response sweep should be readable"),
        )
        .expect("response sweep should parse");
        assert_eq!(sweep["schema_version"], "magnetic_response_sweep.v1");
        assert_eq!(
            sweep["backend_engine_id"],
            "runner.dense_block_real_validation"
        );
        assert_eq!(sweep["point_count"], 2);
        assert_eq!(sweep["points"][0]["frequency_hz"], 1.0e9);
        let diagnostics: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(diagnostics_path).expect("response diagnostics should be readable"),
        )
        .expect("response diagnostics should parse");
        assert_eq!(
            diagnostics["schema_version"],
            "frequency_domain_response_diagnostics.v1"
        );
        assert_eq!(diagnostics["status"], "completed");
        assert_eq!(diagnostics["complete"], true);
        assert_eq!(diagnostics["completed_frequency_point_count"], 2);
        let family_manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(family_manifest_path)
                .expect("frequency-domain manifest should be readable"),
        )
        .expect("frequency-domain manifest should parse");
        assert_eq!(
            family_manifest["schema_version"],
            "frequency_domain_manifest.v1"
        );
        assert_eq!(
            family_manifest["analysis_family"],
            "magnetic_frequency_domain"
        );
        assert_eq!(family_manifest["study_product"], "driven_response");
        assert_eq!(family_manifest["stage_kind"], "frequency_response");
        assert_eq!(family_manifest["diagnostics"]["complete"], true);
        assert_eq!(
            family_manifest["artifacts"]["solver_diagnostics_path"],
            "response/diagnostics/solver.v1.json"
        );
        assert_eq!(
            family_manifest["artifacts"]["response_diagnostics_v1_path"],
            "response/diagnostics/solver.v1.json"
        );
        assert_eq!(
            family_manifest["resources"]["response_sweep_resource_key"],
            "/v2/sessions/current/analysis/frequency-domain/response/magnetic-sweep"
        );

        fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
    }

    #[cfg(not(feature = "fem-gpu"))]
    #[test]
    fn fem_frequency_response_planned_callback_reports_dense_validation_progress() {
        let problem = fem_frequency_response_validation_problem(vec![1.0e9, 2.0e9]);
        let plan = fullmag_plan::plan(&problem).expect("frequency response should plan");
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-live-progress-{}-{}",
            std::process::id(),
            unique_suffix
        ));
        let mut seen_updates = Vec::new();

        let result =
            run_planned_problem_with_callback(&problem, &plan, 0.0, &output_dir, 1, |update| {
                seen_updates.push((update.stats.step, update.finished));
                StepAction::Continue
            })
            .expect("frequency response validation runner should stream progress");

        assert_eq!(result.status, RunStatus::Completed);
        assert_eq!(seen_updates, vec![(1, false), (2, false), (2, true)]);
        fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
    }

    #[cfg(not(feature = "fem-gpu"))]
    #[test]
    fn fem_frequency_response_dmi_rejects_dense_validation_fallback() {
        let mut problem = fem_frequency_response_validation_problem(vec![1.0e9]);
        problem.energy_terms = vec![
            fullmag_ir::EnergyTermIR::Exchange,
            fullmag_ir::EnergyTermIR::BulkDmi { d: 2.5e-3 },
        ];
        let plan = fullmag_plan::plan(&problem).expect("frequency response with DMI should plan");
        assert_frequency_response_rejects_without_dense_artifacts(
            &problem,
            &plan,
            "dmi-reject",
            "requires the native FEM production CPU solver",
        );
    }

    #[test]
    fn fem_frequency_response_nonzero_k_rejects_dense_validation_fallback() {
        let mut problem = fem_frequency_response_validation_problem(vec![1.0e9]);
        if let fullmag_ir::StudyIR::FrequencyResponse { k_sampling, .. } = &mut problem.study {
            *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [1.0e6, 0.0, 0.0],
            });
        }
        let error = fullmag_plan::plan(&problem)
            .expect_err("nonzero-k frequency response should reject during planning");
        assert!(
            error
                .reasons
                .iter()
                .any(|reason| reason.contains("nonzero-k Floquet/Bloch")),
            "expected nonzero-k Floquet/Bloch rejection, got {error:?}"
        );
    }

    #[test]
    fn fem_frequency_response_nonzero_k_floquet_rejects_dense_validation_fallback() {
        let mut problem = fem_frequency_response_validation_problem(vec![1.0e9]);
        let mesh = problem
            .geometry_assets
            .as_mut()
            .expect("fixture should carry FEM geometry assets")
            .fem_mesh_assets
            .first_mut()
            .expect("fixture should carry one FEM mesh asset")
            .mesh
            .as_mut()
            .expect("fixture should carry inline FEM mesh");
        mesh.periodic_boundary_pairs = vec![fullmag_ir::MeshPeriodicBoundaryPairIR {
            pair_id: "x_faces".to_string(),
            source_marker: None,
            destination_marker: None,
            marker_a: 10,
            marker_b: 11,
            translation: None,
            tolerance: None,
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }];
        mesh.periodic_node_pairs = vec![fullmag_ir::MeshPeriodicNodePairIR {
            pair_id: "x_faces".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        if let fullmag_ir::StudyIR::FrequencyResponse {
            k_sampling,
            spin_wave_bc,
            ..
        } = &mut problem.study
        {
            *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [1.0e6, 0.0, 0.0],
            });
            *spin_wave_bc = fullmag_ir::SpinWaveBoundaryConditionIR::Config(
                fullmag_ir::SpinWaveBoundaryConfigIR {
                    kind: fullmag_ir::SpinWaveBoundaryKindIR::Floquet,
                    boundary_pair_id: Some("x_faces".to_string()),
                    pair_ids: Vec::new(),
                    phase_convention: fullmag_ir::PhaseConventionIR::default(),
                    surface_anisotropy_ks: None,
                    surface_anisotropy_axis: None,
                },
            );
        }
        let error = fullmag_plan::plan(&problem)
            .expect_err("Floquet frequency response should reject during planning");
        assert!(
            error
                .reasons
                .iter()
                .any(|reason| reason.contains("nonzero-k Floquet/Bloch")),
            "expected Floquet/Bloch rejection, got {error:?}"
        );
    }

    #[test]
    fn fem_frequency_response_native_production_cpu_unavailable_is_not_dense_fallback() {
        let source = fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/frequency_response.rs"
        ))
        .expect("frequency_response.rs should be readable");

        assert!(
            !source.contains("NativeFrequencyDomainStatus::Unavailable => Ok(None)"),
            "native production CPU unavailable must surface as an error, not dense validation fallback"
        );
        assert!(
            !source.contains("let Ok(native_result) = native_result else"),
            "native production CPU invocation errors must surface as errors, not dense validation fallback"
        );
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    #[ignore = "requires native FEM library with production CPU frequency-domain support"]
    fn fem_frequency_response_exchange_zeeman_runs_native_production_cpu() {
        let mut problem = fem_frequency_response_validation_problem(vec![0.15915494309189535]);
        const MU0: f64 = 4.0 * std::f64::consts::PI * 1.0e-7;
        problem.energy_terms = vec![
            fullmag_ir::EnergyTermIR::Exchange,
            fullmag_ir::EnergyTermIR::Zeeman {
                b: [0.0, 0.0, 2.0 * MU0],
            },
        ];
        if let fullmag_ir::StudyIR::FrequencyResponse {
            excitation,
            k_sampling,
            ..
        } = &mut problem.study
        {
            excitation.field_au_per_m = [1.0, 0.0, 0.0];
            *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            });
        }
        let plan =
            fullmag_plan::plan(&problem).expect("exchange+Zeeman frequency response should plan");
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-production-cpu-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = run_planned_problem(&problem, &plan, 0.0, &output_dir)
            .expect("exchange+Zeeman frequency response should run through native production CPU");

        assert_eq!(result.status, RunStatus::Completed);
        let family_manifest_path = output_dir.join("frequency_domain/manifest.v1.json");
        let sweep_v2_path = output_dir.join("response/magnetic_response_sweep.v2.json");
        let field_payload_path =
            output_dir.join("response/field_payloads/frequency_0000/vector.bin");
        assert!(family_manifest_path.is_file());
        assert!(sweep_v2_path.is_file());
        assert!(field_payload_path.is_file());
        let family_manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(family_manifest_path)
                .expect("production CPU frequency-domain manifest should be readable"),
        )
        .expect("production CPU frequency-domain manifest should parse");
        assert_eq!(
            family_manifest["resolved_execution"]["engine"],
            "native_fem_mfem_frequency_domain_cpu"
        );
        assert_eq!(
            family_manifest["resolved_execution"]["reference_or_production"],
            "production"
        );
        assert_eq!(
            family_manifest["resolved_execution"]["solver_model"],
            "matrix_free_gmres"
        );
        assert_eq!(
            family_manifest["capabilities"]["production_native_solver_available"],
            true
        );
        assert_eq!(
            family_manifest["capabilities"]["validation_artifact"],
            false
        );

        fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    #[ignore = "requires native FEM library with production CPU frequency-domain DMI support"]
    fn fem_frequency_response_bulk_dmi_runs_native_production_cpu() {
        let mut problem = fem_frequency_response_validation_problem(vec![0.15915494309189535]);
        problem.energy_terms = vec![
            fullmag_ir::EnergyTermIR::Exchange,
            fullmag_ir::EnergyTermIR::BulkDmi { d: 2.5e-3 },
        ];
        if let fullmag_ir::StudyIR::FrequencyResponse {
            excitation,
            k_sampling,
            ..
        } = &mut problem.study
        {
            excitation.field_au_per_m = [1.0, 0.5, 0.0];
            *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            });
        }
        let plan =
            fullmag_plan::plan(&problem).expect("bulk-DMI frequency response should plan for FEM");
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-production-cpu-dmi-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = run_planned_problem(&problem, &plan, 0.0, &output_dir)
            .expect("bulk-DMI frequency response should run through native production CPU");

        assert_eq!(result.status, RunStatus::Completed);
        let family_manifest_path = output_dir.join("frequency_domain/manifest.v1.json");
        let sweep_v2_path = output_dir.join("response/magnetic_response_sweep.v2.json");
        let field_payload_path =
            output_dir.join("response/field_payloads/frequency_0000/vector.bin");
        assert!(family_manifest_path.is_file());
        assert!(sweep_v2_path.is_file());
        assert!(field_payload_path.is_file());
        let family_manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(family_manifest_path)
                .expect("production CPU DMI frequency-domain manifest should be readable"),
        )
        .expect("production CPU DMI frequency-domain manifest should parse");
        assert_eq!(
            family_manifest["resolved_execution"]["engine"],
            "native_fem_mfem_frequency_domain_cpu"
        );
        assert_eq!(
            family_manifest["resolved_execution"]["reference_or_production"],
            "production"
        );
        assert_eq!(
            family_manifest["capabilities"]["production_native_solver_available"],
            true
        );
        assert_eq!(
            family_manifest["capabilities"]["validation_artifact"],
            false
        );

        fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
    }

    #[cfg(feature = "fem-gpu")]
    #[test]
    #[ignore = "requires native FEM library with production CPU frequency-domain DMI support"]
    fn fem_frequency_response_interfacial_dmi_runs_native_production_cpu() {
        let mut problem = fem_frequency_response_validation_problem(vec![0.15915494309189535]);
        problem.energy_terms = vec![
            fullmag_ir::EnergyTermIR::Exchange,
            fullmag_ir::EnergyTermIR::InterfacialDmi {
                d: 1.5e-3,
                interface_normal: Some([0.0, 0.0, 2.0]),
            },
        ];
        if let fullmag_ir::StudyIR::FrequencyResponse {
            excitation,
            k_sampling,
            ..
        } = &mut problem.study
        {
            excitation.field_au_per_m = [0.5, 1.0, 0.0];
            *k_sampling = Some(fullmag_ir::KSamplingIR::Single {
                k_vector: [0.0, 0.0, 0.0],
            });
        }
        let plan = fullmag_plan::plan(&problem)
            .expect("interfacial-DMI frequency response should plan for FEM");
        if let fullmag_ir::BackendPlanIR::FemFrequencyResponse(response) = &plan.backend_plan {
            assert_eq!(response.interfacial_dmi, Some(1.5e-3));
            assert_eq!(response.dmi_interface_normal, Some([0.0, 0.0, 1.0]));
        } else {
            panic!("expected FEM frequency response plan");
        }
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-production-cpu-idmi-{}-{}",
            std::process::id(),
            unique_suffix
        ));

        let result = run_planned_problem(&problem, &plan, 0.0, &output_dir)
            .expect("interfacial-DMI frequency response should run through native production CPU");

        assert_eq!(result.status, RunStatus::Completed);
        let family_manifest_path = output_dir.join("frequency_domain/manifest.v1.json");
        let sweep_v2_path = output_dir.join("response/magnetic_response_sweep.v2.json");
        let field_payload_path =
            output_dir.join("response/field_payloads/frequency_0000/vector.bin");
        assert!(family_manifest_path.is_file());
        assert!(sweep_v2_path.is_file());
        assert!(field_payload_path.is_file());
        let family_manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(family_manifest_path)
                .expect("production CPU iDMI frequency-domain manifest should be readable"),
        )
        .expect("production CPU iDMI frequency-domain manifest should parse");
        assert_eq!(
            family_manifest["resolved_execution"]["engine"],
            "native_fem_mfem_frequency_domain_cpu"
        );
        assert_eq!(
            family_manifest["resolved_execution"]["reference_or_production"],
            "production"
        );
        assert_eq!(
            family_manifest["capabilities"]["production_native_solver_available"],
            true
        );
        assert_eq!(
            family_manifest["capabilities"]["validation_artifact"],
            false
        );

        fs::remove_dir_all(&output_dir).expect("temporary artifact directory should be removable");
    }

    #[cfg(not(feature = "fem-gpu"))]
    #[test]
    fn fem_frequency_response_interrupt_before_first_point_writes_cancelled_manifest() {
        let problem = fem_frequency_response_validation_problem(vec![1.0e9, 2.0e9, 3.0e9]);
        let plan = fullmag_plan::plan(&problem).expect("frequency response should plan");
        let unique_suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock drift")
            .as_nanos();
        let output_dir = std::env::temp_dir().join(format!(
            "fullmag-runner-frequency-response-interrupt-{}-{}",
            std::process::id(),
            unique_suffix
        ));
        let interrupt = AtomicBool::new(true);
        let display_selection = || DisplaySelectionState::default();

        let result = run_planned_problem_with_live_preview_interruptible_with_initial_snapshot(
            &problem,
            &plan,
            0.0,
            &output_dir,
            1,
            &display_selection,
            Some(&interrupt),
            false,
            |_| StepAction::Continue,
        )
        .expect("interrupted frequency response validation should return a cancelled run");

        assert_eq!(result.status, RunStatus::Cancelled);
        let manifest_path = output_dir.join("response/artifact_manifest.json");
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(&manifest_path).expect("response manifest should be readable"),
        )
        .expect("response manifest should parse");
        let family_manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("frequency_domain/manifest.v1.json"))
                .expect("frequency-domain manifest should be readable"),
        )
        .expect("frequency-domain manifest should parse");
        let diagnostics: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(output_dir.join("response/diagnostics/solver.v1.json"))
                .expect("response diagnostics should be readable"),
        )
        .expect("response diagnostics should parse");
        assert_eq!(manifest["status"], "interrupted");
        assert_eq!(manifest["complete"], false);
        assert_eq!(manifest["requested_frequency_point_count"], 3);
        assert_eq!(manifest["completed_frequency_point_count"], 0);
        assert_eq!(manifest["cancellation_reason"], "interrupt_requested");
        assert_eq!(family_manifest["diagnostics"]["status"], "interrupted");
        assert_eq!(family_manifest["diagnostics"]["complete"], false);
        assert_eq!(
            family_manifest["diagnostics"]["completed_frequency_point_count"],
            0
        );
        assert_eq!(diagnostics["status"], "interrupted");
        assert_eq!(diagnostics["complete"], false);
        assert_eq!(diagnostics["completed_frequency_point_count"], 0);
        assert!(!output_dir
            .join("response/frequency_points/frequency_0000.json")
            .exists());
        assert!(!output_dir
            .join("response/field_payloads/frequency_0000/vector.bin")
            .exists());

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
                coupling: fullmag_ir::TransportCouplingIR::OneWay,
                definition: None,
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
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [4, 5, 6, 7]]),
            element_markers: vec![1, 0],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [4, 5, 6]]),
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
        #[cfg(feature = "fem-gpu")]
        assert_eq!(
            fem_frequency_response_session_runtime_defaults(dispatch::FemEngine::CpuNative),
            (
                "fem-frequency-response-production-cpu",
                "fem_frequency_response_production_cpu",
                "bin/fullmag-fem-gpu-bin",
            )
        );
        #[cfg(not(feature = "fem-gpu"))]
        assert_eq!(
            fem_frequency_response_session_runtime_defaults(dispatch::FemEngine::CpuNative),
            (
                "fem-frequency-response-validation",
                "fem_frequency_response_dense_validation",
                "../../bin/fullmag-bin",
            )
        );
    }
}
