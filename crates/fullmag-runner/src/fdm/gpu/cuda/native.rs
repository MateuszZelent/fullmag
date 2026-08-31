//! Safe Rust wrapper around the native FDM CUDA backend.
//!
//! This module wraps the raw FFI from `fullmag-fdm-sys` with:
//! - RAII handle management (Drop)
//! - Result-based error handling
//! - AoS ↔ SoA boundary abstraction
//!
//! Phase 2: this is the Rust side of the CUDA execution path.
//! The actual native library must be built and available for linking.

#[cfg(feature = "cuda")]
use fullmag_fdm_sys as ffi;

#[cfg(feature = "cuda")]
use crate::derived_fields::compute_torque_field;
#[cfg(feature = "cuda")]
use crate::fdm::{validate_multilayer_grid_budget, validate_single_grid_budget};
#[cfg(feature = "cuda")]
use crate::preview::{
    build_grid_preview_field_from_flat_plan, build_grid_scalar_preview_field, plan_grid_preview,
    resample_grid_mask, resample_grid_scalars, GridPreviewPlan,
};
#[cfg(feature = "cuda")]
use crate::quantities::normalized_quantity_name;
use crate::quantities::QuantityId;
#[cfg(feature = "cuda")]
use crate::relaxation::llg_overdamped_uses_pure_damping;
#[cfg(feature = "cuda")]
use crate::scalar_metrics::single_object_scalars;
#[cfg(feature = "cuda")]
use crate::types::StepStats;
#[cfg(any(feature = "cuda", test))]
use crate::types::{FdmMultilayerStageTelemetry, RunError};
#[cfg(feature = "cuda")]
use crate::types::{LivePreviewField, LivePreviewRequest};
#[cfg(feature = "cuda")]
use sha2::{Digest, Sha256};

#[cfg(feature = "cuda")]
use std::ffi::c_void;
#[cfg(feature = "cuda")]
use std::ffi::CStr;
#[cfg(feature = "cuda")]
use std::io::Write;
#[cfg(feature = "cuda")]
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CudaSnapshotObservable {
    M,
    HEx,
    HDemag,
    HExt,
    HOe,
    HAni,
    HEff,
    EdenEx,
    EdenDemag,
    EdenExt,
    EdenDrive,
    EdenAni,
    EdenDmi,
    EdenTotal,
}

impl CudaSnapshotObservable {
    fn from_quantity(id: QuantityId) -> Option<Self> {
        Some(match id {
            QuantityId::M => Self::M,
            QuantityId::HEx => Self::HEx,
            QuantityId::HDemag => Self::HDemag,
            QuantityId::HExt => Self::HExt,
            QuantityId::HOe => Self::HOe,
            QuantityId::HAni => Self::HAni,
            QuantityId::HEff => Self::HEff,
            QuantityId::EdenEx => Self::EdenEx,
            QuantityId::EdenDemag => Self::EdenDemag,
            QuantityId::EdenExt => Self::EdenExt,
            QuantityId::EdenDrive => Self::EdenDrive,
            QuantityId::EdenAni => Self::EdenAni,
            QuantityId::EdenDmi => Self::EdenDmi,
            QuantityId::EdenTotal => Self::EdenTotal,
            _ => return None,
        })
    }

    #[cfg(feature = "cuda")]
    fn is_scalar(self) -> bool {
        matches!(
            self,
            Self::EdenEx
                | Self::EdenDemag
                | Self::EdenExt
                | Self::EdenDrive
                | Self::EdenAni
                | Self::EdenDmi
                | Self::EdenTotal
        )
    }
}

pub(crate) fn can_materialize_preview_quantity(id: QuantityId) -> bool {
    matches!(id, QuantityId::Torque | QuantityId::FrozenSpins)
        || CudaSnapshotObservable::from_quantity(id).is_some()
}

/// Check whether the native CUDA FDM backend is compiled and available.
pub(crate) fn is_cuda_available() -> bool {
    #[cfg(feature = "cuda")]
    {
        unsafe { ffi::fullmag_fdm_is_available() == 1 }
    }
    #[cfg(not(feature = "cuda"))]
    {
        false
    }
}

#[cfg(any(feature = "cuda", test))]
pub(crate) fn reject_cuda_multilayer_containment(
    enable_demag: bool,
    mode: &str,
    layers: &[fullmag_ir::FdmLayerPlanIR],
) -> Result<(), RunError> {
    let reason_codes =
        fullmag_plan::fdm_multilayer_cuda_containment_reason_codes(enable_demag, mode, layers);
    if reason_codes.is_empty() {
        return Ok(());
    }
    Err(RunError {
        message: format!(
            "{}: CUDA multilayer execution rejected before device probe or allocation",
            reason_codes.join(",")
        ),
    })
}

#[cfg(any(feature = "cuda", test))]
fn validate_native_adaptive_policy(
    integrator: fullmag_ir::IntegratorChoice,
    adaptive: Option<&fullmag_ir::AdaptiveTimeStepIR>,
    thermal_active: bool,
    dynamic_oersted_active: bool,
    spin_transport_active: bool,
) -> Result<(), RunError> {
    let Some(policy) = adaptive else {
        return Ok(());
    };
    if !matches!(
        integrator,
        fullmag_ir::IntegratorChoice::Rk23 | fullmag_ir::IntegratorChoice::Rk45
    ) {
        return Err(RunError {
            message: "adaptive CUDA FDM requires RK23 or RK45".to_string(),
        });
    }
    match policy.tolerance_mode {
        fullmag_ir::AdaptiveToleranceModeIR::MaxError if policy.rtol != 0.0 => {
            return Err(RunError {
                message: "maximum-error CUDA FDM requires rtol=0".to_string(),
            });
        }
        fullmag_ir::AdaptiveToleranceModeIR::Advanced
            if policy.atol <= 0.0 && policy.rtol <= 0.0 =>
        {
            return Err(RunError {
                message: "advanced CUDA FDM requires positive atol or rtol".to_string(),
            });
        }
        _ => {}
    }
    for (name, value) in [
        ("max_spin_rotation", policy.max_spin_rotation),
        ("norm_tolerance", policy.norm_tolerance),
    ] {
        if value.is_some_and(|value| !value.is_finite() || value <= 0.0) {
            return Err(RunError {
                message: format!(
                    "adaptive CUDA FDM {name} must be finite and positive when enabled"
                ),
            });
        }
    }
    if thermal_active {
        return Err(RunError {
            message: "adaptive_cuda_fdm_thermal_unsupported: Brown thermal noise requires a qualified accepted-step SDE replay contract".to_string(),
        });
    }
    if dynamic_oersted_active {
        return Err(RunError {
            message: "adaptive_cuda_fdm_dynamic_oersted_unsupported: every adaptive RK stage requires a device-resident source-time contract".to_string(),
        });
    }
    if spin_transport_active {
        return Err(RunError {
            message: "adaptive_cuda_fdm_spin_transport_unsupported: device-side retry cannot bind the current host-owned transport transaction".to_string(),
        });
    }
    Ok(())
}

#[cfg(feature = "cuda")]
fn native_time_policy(
    adaptive: Option<&fullmag_ir::AdaptiveTimeStepIR>,
) -> Result<ffi::fullmag_fdm_time_policy_desc_v2, RunError> {
    let Some(policy) = adaptive else {
        return Ok(ffi::fullmag_fdm_time_policy_desc_v2 {
            adaptive_enabled: 0,
            adaptive_tolerance_mode:
                ffi::fullmag_fdm_adaptive_tolerance_mode::FULLMAG_FDM_ADAPTIVE_MAX_ERROR,
            adaptive_atol: 0.0,
            adaptive_rtol: 0.0,
            adaptive_dt_min: 0.0,
            adaptive_dt_max: 0.0,
            adaptive_safety: 0.0,
            adaptive_growth_limit: 0.0,
            adaptive_shrink_limit: 0.0,
            has_adaptive_max_spin_rotation: 0,
            adaptive_max_spin_rotation: 0.0,
            has_adaptive_norm_tolerance: 0,
            adaptive_norm_tolerance: 0.0,
        });
    };
    let mode = match policy.tolerance_mode {
        fullmag_ir::AdaptiveToleranceModeIR::MaxError => {
            ffi::fullmag_fdm_adaptive_tolerance_mode::FULLMAG_FDM_ADAPTIVE_MAX_ERROR
        }
        fullmag_ir::AdaptiveToleranceModeIR::Advanced => {
            ffi::fullmag_fdm_adaptive_tolerance_mode::FULLMAG_FDM_ADAPTIVE_ADVANCED
        }
    };
    Ok(ffi::fullmag_fdm_time_policy_desc_v2 {
        adaptive_enabled: 1,
        adaptive_tolerance_mode: mode,
        adaptive_atol: policy.atol,
        adaptive_rtol: policy.rtol,
        adaptive_dt_min: policy.dt_min,
        adaptive_dt_max: policy.dt_max.ok_or_else(|| RunError {
            message: "adaptive CUDA FDM requires explicit dt_max".to_string(),
        })?,
        adaptive_safety: policy.safety,
        adaptive_growth_limit: policy.growth_limit,
        adaptive_shrink_limit: policy.shrink_limit,
        has_adaptive_max_spin_rotation: i32::from(policy.max_spin_rotation.is_some()),
        adaptive_max_spin_rotation: policy.max_spin_rotation.unwrap_or(0.0),
        has_adaptive_norm_tolerance: i32::from(policy.norm_tolerance.is_some()),
        adaptive_norm_tolerance: policy.norm_tolerance.unwrap_or(0.0),
    })
}

#[cfg(test)]
mod adaptive_policy_validation_tests {
    use super::*;
    fn policy(mode: fullmag_ir::AdaptiveToleranceModeIR) -> fullmag_ir::AdaptiveTimeStepIR {
        fullmag_ir::AdaptiveTimeStepIR {
            tolerance_mode: mode,
            atol: 1e-6,
            rtol: 0.0,
            dt_initial: Some(1e-15),
            dt_min: 1e-16,
            dt_max: Some(1e-14),
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: None,
            norm_tolerance: None,
        }
    }
    #[test]
    fn incompatible_adaptive_cuda_policies_fail_before_ffi() {
        assert!(validate_native_adaptive_policy(
            fullmag_ir::IntegratorChoice::Heun,
            Some(&policy(fullmag_ir::AdaptiveToleranceModeIR::MaxError)),
            false,
            false,
            false,
        )
        .is_err());
        let absolute = policy(fullmag_ir::AdaptiveToleranceModeIR::Advanced);
        validate_native_adaptive_policy(
            fullmag_ir::IntegratorChoice::Rk45,
            Some(&absolute),
            false,
            false,
            false,
        )
        .unwrap();
        let mut relative = absolute.clone();
        relative.atol = 0.0;
        relative.rtol = 1e-4;
        validate_native_adaptive_policy(
            fullmag_ir::IntegratorChoice::Rk45,
            Some(&relative),
            false,
            false,
            false,
        )
        .unwrap();
        relative.rtol = 0.0;
        assert!(validate_native_adaptive_policy(
            fullmag_ir::IntegratorChoice::Rk45,
            Some(&relative),
            false,
            false,
            false,
        )
        .is_err());
        let mut guarded = absolute.clone();
        guarded.max_spin_rotation = Some(0.2);
        guarded.norm_tolerance = Some(1.0e-6);
        validate_native_adaptive_policy(
            fullmag_ir::IntegratorChoice::Rk45,
            Some(&guarded),
            false,
            false,
            false,
        )
        .expect("native CUDA enforces transported norm and rotation guards");
        guarded.norm_tolerance = Some(f64::NAN);
        assert!(validate_native_adaptive_policy(
            fullmag_ir::IntegratorChoice::Rk45,
            Some(&guarded),
            false,
            false,
            false,
        )
        .is_err());
        for unsupported in [
            (true, false, false),
            (false, true, false),
            (false, false, true),
        ] {
            assert!(validate_native_adaptive_policy(
                fullmag_ir::IntegratorChoice::Rk45,
                Some(&absolute),
                unsupported.0,
                unsupported.1,
                unsupported.2,
            )
            .is_err());
        }
    }
}

#[cfg(any(feature = "cuda", test))]
#[derive(Debug, Clone, Copy, PartialEq)]
struct NativeStepMetrics {
    max_torque_apm: f64,
    max_rhs_norm_per_s: f64,
}

#[cfg(any(feature = "cuda", test))]
fn validate_native_step_metrics(
    max_torque_apm: f64,
    max_rhs_norm_per_s: f64,
) -> Result<NativeStepMetrics, RunError> {
    for (name, value) in [
        ("max_torque_Apm", max_torque_apm),
        ("max_rhs_amplitude", max_rhs_norm_per_s),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(RunError {
                message: format!("native FDM {name} must be finite and non-negative, got {value}"),
            });
        }
    }
    Ok(NativeStepMetrics {
        max_torque_apm,
        max_rhs_norm_per_s,
    })
}

#[cfg(feature = "cuda")]
fn validate_adaptive_attempt_batch(
    records: &[ffi::fullmag_fdm_adaptive_attempt_v1],
) -> Result<(u32, f64), RunError> {
    if records.is_empty() || records.len() > ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1 {
        return Err(RunError {
            message: format!(
                "native FDM adaptive attempt count is invalid: {}",
                records.len()
            ),
        });
    }
    for (index, record) in records.iter().enumerate() {
        if record.abi_version != ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_ABI_V1
            || record.struct_size as usize
                != std::mem::size_of::<ffi::fullmag_fdm_adaptive_attempt_v1>()
            || record.attempt_index as usize != index
            || !record.dt_attempt_seconds.is_finite()
            || record.dt_attempt_seconds <= 0.0
            || !record.normalized_error.is_finite()
            || record.normalized_error < 0.0
            || !record.ratio.is_finite()
            || record.ratio <= 0.0
            || !record.dt_next_seconds.is_finite()
            || record.dt_next_seconds <= 0.0
        {
            return Err(RunError {
                message: format!("native FDM adaptive attempt record {index} is invalid"),
            });
        }
    }
    let last = records.last().expect("non-empty adaptive trace");
    if last.decision != ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_ACCEPTED
        || last.reason != ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_WITHIN_TOLERANCE
    {
        return Err(RunError {
            message: "successful native FDM step did not end with an accepted adaptive attempt"
                .to_string(),
        });
    }
    Ok((records.len() as u32 - 1, last.normalized_error))
}

#[cfg(any(feature = "cuda", test))]
fn validate_multilayer_stage_telemetry(
    layer_count: u64,
    refresh_count: u64,
    forward_fft_count: u64,
    inverse_fft_count: u64,
    pair_accumulation_count: u64,
) -> Result<FdmMultilayerStageTelemetry, RunError> {
    if refresh_count == 0
        && forward_fft_count == 0
        && inverse_fft_count == 0
        && pair_accumulation_count == 0
    {
        return Err(RunError {
            message:
                "d07_stage_telemetry_not_recorded: native multilayer demag counters are absent"
                    .to_string(),
        });
    }
    let expected_pairs = layer_count
        .checked_mul(layer_count)
        .ok_or_else(|| RunError {
            message: "d07_stage_telemetry_counter_overflow: L^2 does not fit u64".to_string(),
        })?;
    if refresh_count != 1
        || forward_fft_count != layer_count
        || inverse_fft_count != layer_count
        || pair_accumulation_count != expected_pairs
    {
        return Err(RunError {
            message: format!(
                "d07_stage_telemetry_counter_mismatch: expected refresh=1 forward={layer_count} inverse={layer_count} pairs={expected_pairs}, got refresh={refresh_count} forward={forward_fft_count} inverse={inverse_fft_count} pairs={pair_accumulation_count}"
            ),
        });
    }
    Ok(FdmMultilayerStageTelemetry {
        status: "recorded".to_string(),
        execution_engine: "cuda_native_multilayer_demag_v2".to_string(),
        data_residency: "device_resident_per_refresh".to_string(),
        fft_backend: "cuFFT".to_string(),
        layer_count,
        refresh_count,
        forward_fft_count,
        inverse_fft_count,
        pair_accumulation_count,
    })
}

#[cfg(feature = "cuda")]
fn has_slonczewski_stt(plan: &fullmag_ir::FdmPlanIR) -> bool {
    plan.current_density.is_some()
        && plan.stt_degree.is_some()
        && plan.stt_spin_polarization.is_some()
        && plan.stt_lambda.is_some()
}

#[cfg(any(feature = "cuda", test))]
fn ensure_cuda_slonczewski_supported(plan: &fullmag_ir::FdmPlanIR) -> Result<(), RunError> {
    match plan.slonczewski_formula_version.as_deref() {
        None | Some("slonczewski.legacy_fullmag.v0") => Ok(()),
        Some("slonczewski.fullmag.v2") => {
            let normal = plan.slonczewski_stack_normal.ok_or_else(|| RunError {
                message: "slonczewski.fullmag.v2 on FDM CUDA requires a stack normal".to_string(),
            })?;
            let normal_norm =
                (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
            if !normal_norm.is_finite() || normal_norm <= 0.0 {
                return Err(RunError {
                    message:
                        "slonczewski.fullmag.v2 on FDM CUDA requires a finite nonzero stack normal"
                            .to_string(),
                });
            }
            let target_mask = plan
                .slonczewski_active_mask
                .as_ref()
                .ok_or_else(|| RunError {
                    message: "slonczewski.fullmag.v2 on FDM CUDA requires a separate target mask"
                        .to_string(),
                })?;
            if target_mask.len() != plan.initial_magnetization.len() {
                return Err(RunError {
                    message: "slonczewski.fullmag.v2 on FDM CUDA target mask length must equal cell count".to_string(),
                });
            }
            Ok(())
        }
        Some(other) => Err(RunError {
            message: format!("unsupported FDM CUDA Slonczewski formula_version '{other}'"),
        }),
    }
}

#[cfg(feature = "cuda")]
fn ensure_cuda_frozen_spins_supported(
    requested: bool,
    capability_bits: u64,
) -> Result<(), RunError> {
    if requested && capability_bits & ffi::FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1 == 0 {
        return Err(RunError {
            message: "frozen_spins_cuda_unqualified: native CUDA frozen-spin kernels are not capability-qualified".to_string(),
        });
    }
    Ok(())
}

#[cfg(any(feature = "cuda", test))]
fn validate_native_frozen_spins_plan(plan: &fullmag_ir::FdmPlanIR) -> Result<(), RunError> {
    let Some(frozen_spins) = plan.frozen_spins.as_ref() else {
        return Ok(());
    };
    frozen_spins.validate_intrinsic().map_err(|message| RunError {
        message: format!(
            "frozen_spins_native_plan_invalid: rejected before CUDA device probe or allocation: {message}"
        ),
    })?;

    let cell_count = plan.initial_magnetization.len();
    let all_active;
    let active_mask = if let Some(active_mask) = plan.active_mask.as_deref() {
        if active_mask.len() != cell_count {
            return Err(RunError {
                message: format!(
                    "frozen_spins_native_plan_invalid: active mask length {} differs from initial magnetization cell count {cell_count}",
                    active_mask.len()
                ),
            });
        }
        active_mask
    } else {
        all_active = vec![true; cell_count];
        &all_active
    };
    frozen_spins
        .validate_against_active_mask(active_mask)
        .map_err(|message| RunError {
            message: format!(
                "frozen_spins_native_plan_invalid: rejected before CUDA device probe or allocation: {message}"
            ),
        })?;

    let Some(grid_certificate) = plan.grid_certificate.as_ref() else {
        return Err(RunError {
            message: "frozen_spins_native_plan_invalid: Frozen Spins requires an authoritative FDM grid certificate before CUDA device probe or allocation"
                .to_string(),
        });
    };
    grid_certificate
        .validate_against_masks(plan.active_mask.as_deref(), &plan.region_mask)
        .map_err(|message| RunError {
            message: format!(
                "frozen_spins_native_plan_invalid: grid certificate rejected before CUDA device probe or allocation: {message}"
            ),
        })?;
    if frozen_spins.grid_or_mesh_fingerprint != grid_certificate.grid_fingerprint {
        return Err(RunError {
            message: "frozen_spins_native_plan_invalid: resolved Frozen Spins topology fingerprint differs from the FDM grid certificate"
                .to_string(),
        });
    }
    Ok(())
}

#[cfg(feature = "cuda")]
fn ffi_prescribed_sot_formula(
    plan: &fullmag_ir::FdmPlanIR,
) -> Result<ffi::fullmag_fdm_prescribed_sot_formula, RunError> {
    match plan.sot_formula_version.as_deref() {
        None | Some("prescribed_sot.legacy_fullmag.v0") => {
            Ok(ffi::fullmag_fdm_prescribed_sot_formula::FULLMAG_FDM_PRESCRIBED_SOT_LEGACY_V0)
        }
        Some("prescribed_sot.fullmag.v1") => {
            Ok(ffi::fullmag_fdm_prescribed_sot_formula::FULLMAG_FDM_PRESCRIBED_SOT_V1)
        }
        Some(other) => Err(RunError {
            message: format!("unsupported prescribed SOT formula_version '{other}'"),
        }),
    }
}

#[cfg(feature = "cuda")]
fn ffi_zhang_li_formula(
    plan: &fullmag_ir::FdmPlanIR,
) -> Result<ffi::fullmag_fdm_zhang_li_formula, RunError> {
    match plan.zhang_li_formula_version.as_deref() {
        None | Some("zhang_li.legacy_fullmag.v0") => Ok(
            ffi::fullmag_fdm_zhang_li_formula::FULLMAG_FDM_ZHANG_LI_LEGACY_FULLMAG_V0,
        ),
        Some("zhang_li.mumax3.v1") => Ok(
            ffi::fullmag_fdm_zhang_li_formula::FULLMAG_FDM_ZHANG_LI_MUMAX3_CENTRAL_V1,
        ),
        Some("zhang_li.fullmag.v1") => Err(RunError {
            message: "zhang_li.fullmag.v1 is the canonical FEM realization and is not executable on FDM CUDA; select zhang_li.mumax3.v1 or use the FDM CPU reference"
                .to_string(),
        }),
        Some(other) => Err(RunError {
            message: format!("unsupported FDM CUDA Zhang-Li formula_version '{other}'"),
        }),
    }
}

#[cfg(feature = "cuda")]
fn ffi_transfer_kind(kind: &str) -> Result<ffi::fullmag_fdm_transfer_kind, RunError> {
    match kind {
        "identity" => Ok(ffi::fullmag_fdm_transfer_kind::FULLMAG_FDM_TRANSFER_IDENTITY),
        "push_pull" => Ok(ffi::fullmag_fdm_transfer_kind::FULLMAG_FDM_TRANSFER_PUSH_PULL),
        other => Err(RunError {
            message: format!("unsupported native FDM multilayer transfer_kind '{other}'"),
        }),
    }
}

/// Safe wrapper around the native FDM backend handle.
#[cfg(feature = "cuda")]
pub(crate) struct NativeFdmBackend {
    handle: *mut ffi::fullmag_fdm_backend,
    cell_count: usize,
    active_mask: Option<Vec<bool>>,
    frozen_mask: Option<Vec<bool>>,
    precision: fullmag_ir::ExecutionPrecision,
    precision_policy: fullmag_ir::FdmPrecisionPolicyIR,
    damping: f64,
    precession_enabled: bool,
    gpu_transport_bound: bool,
    adaptive_timestep_enabled: bool,
    stats_policy: NativeStatsPolicy,
}

#[cfg(feature = "cuda")]
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct AdaptiveBatchStep {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub suggested_next_dt: f64,
    pub normalized_error: f64,
    pub rejected_attempts: u32,
}

#[cfg(feature = "cuda")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EndpointCacheTelemetry {
    pub cache_identity_valid: bool,
    pub stats_valid: bool,
    pub accepted_state_revision: u64,
    pub valid_field_mask: u64,
    pub refresh_request_count: u64,
    pub refresh_execution_count: u64,
    pub refresh_cache_hit_count: u64,
    pub invalidation_count: u64,
    pub stats_snapshot_request_count: u64,
    pub stats_snapshot_cache_hit_count: u64,
    pub field_snapshot_request_count: u64,
    pub field_snapshot_latency_total_ns: u64,
    pub field_snapshot_latency_max_ns: u64,
    pub exchange_evaluation_count: u64,
    pub demag_evaluation_count: u64,
    pub demag_forward_fft_count: u64,
    pub demag_inverse_fft_count: u64,
    pub effective_field_evaluation_count: u64,
    pub energy_reduction_count: u64,
    pub last_step_exchange_evaluation_count: u64,
    pub last_step_demag_evaluation_count: u64,
    pub last_step_demag_forward_fft_count: u64,
    pub last_step_demag_inverse_fft_count: u64,
    pub last_step_effective_field_evaluation_count: u64,
    pub last_step_energy_reduction_count: u64,
}

#[cfg(feature = "cuda")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeStatsMode {
    Full,
    None,
    #[allow(dead_code)]
    Control,
    Requested,
}

#[cfg(feature = "cuda")]
impl NativeStatsMode {
    fn as_ffi(self) -> ffi::fullmag_fdm_stats_mode {
        match self {
            Self::Full => ffi::fullmag_fdm_stats_mode::FULLMAG_FDM_STATS_FULL,
            Self::None => ffi::fullmag_fdm_stats_mode::FULLMAG_FDM_STATS_NONE,
            Self::Control => ffi::fullmag_fdm_stats_mode::FULLMAG_FDM_STATS_CONTROL,
            Self::Requested => ffi::fullmag_fdm_stats_mode::FULLMAG_FDM_STATS_REQUESTED,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::None => "none",
            Self::Control => "control",
            Self::Requested => "requested",
        }
    }
}

#[cfg(feature = "cuda")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NativeStatsPolicy {
    pub mode: NativeStatsMode,
    pub stride: u32,
    pub quantity_mask: u64,
}

#[cfg(feature = "cuda")]
impl NativeStatsPolicy {
    pub(crate) const fn full(stride: u32) -> Self {
        Self {
            mode: NativeStatsMode::Full,
            stride,
            quantity_mask: ffi::FULLMAG_FDM_STATS_QUANTITY_ALL,
        }
    }

    pub(crate) const fn none(stride: u32) -> Self {
        Self {
            mode: NativeStatsMode::None,
            stride,
            quantity_mask: 0,
        }
    }

    pub(crate) const fn requested(stride: u32, quantity_mask: u64) -> Self {
        Self {
            mode: NativeStatsMode::Requested,
            stride,
            quantity_mask,
        }
    }
}

#[cfg(feature = "cuda")]
mod device;
#[cfg(any(feature = "cuda", test))]
pub(crate) mod residency;
#[cfg(feature = "cuda")]
pub(crate) use device::DeviceInfo;

#[cfg(feature = "cuda")]
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(crate) struct NativeLlgCheckpointV4 {
    pub info: ffi::fullmag_fdm_llg_checkpoint_info_v4,
    pub payload_sha256: [u8; 32],
    pub payload: Vec<u8>,
}

#[cfg(feature = "cuda")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeFieldSnapshotScalarType {
    F32,
    F64,
}

#[cfg(feature = "cuda")]
#[derive(Debug, Clone, Copy)]
pub(crate) struct NativeFieldSnapshotInfo {
    pub cell_count: usize,
    pub component_count: usize,
    pub scalar_bytes: usize,
    pub scalar_type: NativeFieldSnapshotScalarType,
}

#[cfg(feature = "cuda")]
#[derive(Debug)]
struct NativeFieldSnapshotReady {
    /// Owned copy of the snapshot bytes, copied from the native buffer at the
    /// FFI boundary.  No raw pointer escapes after `ensure_ready` returns.
    data: Vec<u8>,
    info: NativeFieldSnapshotInfo,
}

#[cfg(feature = "cuda")]
struct NativeMultilayerTensorKernelHost {
    k_xx: Vec<ffi::fullmag_fdm_complex64>,
    k_yy: Vec<ffi::fullmag_fdm_complex64>,
    k_zz: Vec<ffi::fullmag_fdm_complex64>,
    k_xy: Vec<ffi::fullmag_fdm_complex64>,
    k_xz: Vec<ffi::fullmag_fdm_complex64>,
    k_yz: Vec<ffi::fullmag_fdm_complex64>,
}

#[cfg(feature = "cuda")]
#[derive(Debug)]
pub(crate) struct NativeFdmFieldSnapshot {
    handle: *mut ffi::fullmag_fdm_field_snapshot,
    pub name: String,
    pub step: u64,
    pub time: f64,
    pub solver_dt: f64,
    ready: Option<NativeFieldSnapshotReady>,
}

#[cfg(feature = "cuda")]
// SAFETY: `NativeFdmFieldSnapshot` is sent between threads only between its
// construction (on the runner thread) and its consumption (on the writer
// thread).  The native handle is valid for the object's lifetime and is only
// freed via `Drop`.  Snapshot data is copied into `ready.data: Vec<u8>` at the
// FFI boundary, so no aliased raw pointer to CUDA-managed memory is
// reachable from other threads.
unsafe impl Send for NativeFdmFieldSnapshot {}

#[cfg(feature = "cuda")]
#[derive(Debug)]
pub(crate) struct NativeFdmPreviewSnapshot {
    handle: *mut ffi::fullmag_fdm_preview_snapshot,
    request: LivePreviewRequest,
    plan: GridPreviewPlan,
    quantity: String,
    ready: Option<NativeFieldSnapshotReady>,
}

#[cfg(feature = "cuda")]
// SAFETY: same invariants as `NativeFdmFieldSnapshot` above.
unsafe impl Send for NativeFdmPreviewSnapshot {}

#[cfg(feature = "cuda")]
impl NativeFdmBackend {
    unsafe extern "C" fn poll_atomic_interrupt_flag(user_data: *mut c_void) -> i32 {
        let flag = user_data.cast::<AtomicBool>();
        if flag.is_null() {
            return 0;
        }
        if unsafe { (*flag).load(Ordering::Relaxed) } {
            1
        } else {
            0
        }
    }

    pub fn create_multilayer_v2(plan: &fullmag_ir::FdmMultilayerPlanIR) -> Result<Self, RunError> {
        reject_cuda_multilayer_containment(plan.enable_demag, &plan.mode, &plan.layers)?;
        validate_multilayer_grid_budget(
            plan,
            fullmag_fdm_demag::KernelAdmissionModel::CudaAbiV2PairPayload,
        )?;
        for layer in &plan.layers {
            if layer.material.ms_field.is_some()
                || layer.material.a_field.is_some()
                || layer.material.alpha_field.is_some()
            {
                return Err(RunError {
                    message: "FDM CUDA native does not yet support cellwise material fields (Ms/Aex/alpha); use FDM CPU reference or disable region material overrides".to_string(),
                });
            }
        }
        let precision = match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => {
                ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE
            }
            fullmag_ir::ExecutionPrecision::Double => {
                ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE
            }
        };

        let integrator = match plan.integrator {
            fullmag_ir::IntegratorChoice::Heun => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN
            }
            fullmag_ir::IntegratorChoice::Rk4 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4
            }
            fullmag_ir::IntegratorChoice::Rk23 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK23
            }
            fullmag_ir::IntegratorChoice::Rk45 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_DP45
            }
            fullmag_ir::IntegratorChoice::Abm3 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_ABM3
            }
        };

        let magnetization_storage = plan
            .layers
            .iter()
            .map(|layer| flatten_vectors_f64(&layer.initial_magnetization))
            .collect::<Vec<_>>();
        let active_mask_storage = plan
            .layers
            .iter()
            .map(|layer| {
                layer.native_active_mask.as_ref().map(|mask| {
                    mask.iter()
                        .map(|is_active| if *is_active { 1u8 } else { 0u8 })
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>();

        let layer_descs = plan
            .layers
            .iter()
            .enumerate()
            .map(|(index, layer)| {
                let z_offset_cells = ((layer.native_origin[2] - layer.convolution_origin[2])
                    / layer.convolution_cell_size[2])
                    .round() as i32;
                Ok(ffi::fullmag_fdm_layer_desc_v2 {
                    native_grid: ffi_grid(layer.native_grid, layer.native_cell_size),
                    convolution_grid: ffi_grid(layer.convolution_grid, layer.convolution_cell_size),
                    transfer_kind: ffi_transfer_kind(&layer.transfer_kind)?,
                    layer_index: index as u32,
                    z_offset_cells,
                    material: ffi::fullmag_fdm_material_desc {
                        saturation_magnetisation: layer.material.saturation_magnetisation,
                        exchange_stiffness: layer.material.exchange_stiffness,
                        damping: layer.material.damping,
                        gyromagnetic_ratio: plan.gyromagnetic_ratio,
                    },
                    has_uniaxial_anisotropy: if layer.material.uniaxial_anisotropy_ku1.is_some() {
                        1
                    } else {
                        0
                    },
                    uniaxial_anisotropy_constant: layer
                        .material
                        .uniaxial_anisotropy_ku1
                        .unwrap_or(0.0),
                    uniaxial_anisotropy_k2: layer.material.uniaxial_anisotropy_ku2.unwrap_or(0.0),
                    anisotropy_axis: layer.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
                    has_cubic_anisotropy: if layer.material.cubic_anisotropy_kc1.is_some()
                        || layer.material.cubic_anisotropy_kc2.is_some()
                        || layer.material.cubic_anisotropy_kc3.is_some()
                    {
                        1
                    } else {
                        0
                    },
                    cubic_kc1: layer.material.cubic_anisotropy_kc1.unwrap_or(0.0),
                    cubic_kc2: layer.material.cubic_anisotropy_kc2.unwrap_or(0.0),
                    cubic_kc3: layer.material.cubic_anisotropy_kc3.unwrap_or(0.0),
                    cubic_axis1: layer
                        .material
                        .cubic_anisotropy_axis1
                        .unwrap_or([1.0, 0.0, 0.0]),
                    cubic_axis2: layer
                        .material
                        .cubic_anisotropy_axis2
                        .unwrap_or([0.0, 1.0, 0.0]),
                    initial_magnetization_xyz: magnetization_storage[index].as_ptr(),
                    initial_magnetization_len: magnetization_storage[index].len() as u64,
                    active_mask: active_mask_storage[index]
                        .as_ref()
                        .map_or(std::ptr::null(), |mask| mask.as_ptr()),
                    active_mask_len: active_mask_storage[index]
                        .as_ref()
                        .map_or(0, |mask| mask.len() as u64),
                })
            })
            .collect::<Result<Vec<_>, RunError>>()?;

        let conv_grid = [
            plan.common_cells[0] as usize,
            plan.common_cells[1] as usize,
            plan.common_cells[2] as usize,
        ];
        let conv_cell_size = plan
            .layers
            .first()
            .map(|layer| layer.convolution_cell_size)
            .unwrap_or([1.0, 1.0, 1.0]);

        let mut kernel_payloads = Vec::new();
        let mut kernel_descs = Vec::new();
        if plan.enable_demag {
            kernel_payloads.reserve(plan.layers.len() * plan.layers.len());
            for (src_index, src_layer) in plan.layers.iter().enumerate() {
                for (dst_index, dst_layer) in plan.layers.iter().enumerate() {
                    let z_shift = dst_layer.native_origin[2] - src_layer.native_origin[2];
                    let kernel = if src_index == dst_index {
                        fullmag_fdm_demag::compute_exact_self_kernel(
                            conv_grid[0],
                            conv_grid[1],
                            conv_grid[2],
                            conv_cell_size[0],
                            conv_cell_size[1],
                            conv_cell_size[2],
                        )
                    } else {
                        fullmag_fdm_demag::compute_shifted_kernel(
                            conv_grid,
                            conv_cell_size,
                            z_shift,
                        )
                    };
                    kernel_payloads.push(NativeMultilayerTensorKernelHost {
                        k_xx: ffi_complex64_vec(&kernel.k_xx),
                        k_yy: ffi_complex64_vec(&kernel.k_yy),
                        k_zz: ffi_complex64_vec(&kernel.k_zz),
                        k_xy: ffi_complex64_vec(&kernel.k_xy),
                        k_xz: ffi_complex64_vec(&kernel.k_xz),
                        k_yz: ffi_complex64_vec(&kernel.k_yz),
                    });
                    let payload = kernel_payloads.last().expect("just pushed kernel payload");
                    kernel_descs.push(ffi::fullmag_fdm_tensor_kernel_desc_v2 {
                        fft_grid: ffi_grid(
                            [
                                kernel.fft_shape[0] as u32,
                                kernel.fft_shape[1] as u32,
                                kernel.fft_shape[2] as u32,
                            ],
                            conv_cell_size,
                        ),
                        dst_layer: dst_index as u32,
                        src_layer: src_index as u32,
                        z_shift_meters: z_shift,
                        kernel_xx: payload.k_xx.as_ptr(),
                        kernel_yy: payload.k_yy.as_ptr(),
                        kernel_zz: payload.k_zz.as_ptr(),
                        kernel_xy: payload.k_xy.as_ptr(),
                        kernel_xz: payload.k_xz.as_ptr(),
                        kernel_yz: payload.k_yz.as_ptr(),
                        kernel_len: payload.k_xx.len() as u64,
                    });
                }
            }
        }

        let plan_desc = ffi::fullmag_fdm_multilayer_plan_desc_v2 {
            kind: ffi::fullmag_fdm_plan_kind::FULLMAG_FDM_PLAN_MULTILAYER_CONV,
            precision,
            integrator,
            disable_precession: if llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()) {
                1
            } else {
                0
            },
            enable_exchange: if plan.enable_exchange { 1 } else { 0 },
            enable_demag: if plan.enable_demag { 1 } else { 0 },
            has_external_field: if plan.external_field.is_some() { 1 } else { 0 },
            external_field_am: plan.external_field.unwrap_or([0.0, 0.0, 0.0]),
            has_interfacial_dmi: if plan.interfacial_dmi.is_some() { 1 } else { 0 },
            dmi_d_interfacial: plan.interfacial_dmi.unwrap_or(0.0),
            has_bulk_dmi: if plan.bulk_dmi.is_some() { 1 } else { 0 },
            dmi_d_bulk: plan.bulk_dmi.unwrap_or(0.0),
            layers: layer_descs.as_ptr(),
            layer_count: layer_descs.len() as u32,
            kernels: if kernel_descs.is_empty() {
                std::ptr::null()
            } else {
                kernel_descs.as_ptr()
            },
            kernel_count: kernel_descs.len() as u32,
            adaptive_max_error: 0.0,
            adaptive_dt_min: 0.0,
            adaptive_dt_max: 0.0,
            adaptive_headroom: 0.0,
            stats_mode: ffi::fullmag_fdm_stats_mode::FULLMAG_FDM_STATS_FULL,
            stats_stride: 1,
        };

        let handle = unsafe { ffi::fullmag_fdm_backend_create_v2(&plan_desc) };
        if handle.is_null() {
            return Err(RunError {
                message: "CUDA FDM backend_create_v2 returned null".to_string(),
            });
        }

        let err = unsafe { ffi::fullmag_fdm_backend_last_error(handle) };
        if !err.is_null() {
            let msg = unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string();
            if !msg.contains(
                "native Heun/RK4/fixed-step RK23 timestep with optional demag and layer-local exchange is available",
            ) && !msg
                .contains("native Heun timestep with demag and layer-local exchange is available")
                && !msg.contains("native demag-only Heun timestep is available")
            {
                unsafe { ffi::fullmag_fdm_backend_destroy(handle) };
                return Err(RunError { message: msg });
            }
        }

        let first_material = plan.layers.first().map(|layer| &layer.material);
        let cell_count = plan
            .layers
            .iter()
            .map(|layer| layer.initial_magnetization.len())
            .sum();
        let active_mask = if plan
            .layers
            .iter()
            .any(|layer| layer.native_active_mask.is_some())
        {
            Some(
                plan.layers
                    .iter()
                    .flat_map(|layer| {
                        layer.native_active_mask.as_deref().map_or_else(
                            || vec![true; layer.initial_magnetization.len()],
                            ToOwned::to_owned,
                        )
                    })
                    .collect(),
            )
        } else {
            None
        };
        Ok(Self {
            handle,
            cell_count,
            active_mask,
            frozen_mask: None,
            precision: plan.precision,
            precision_policy: plan.precision_policy.clone(),
            damping: first_material.map_or(0.0, |material| material.damping),
            precession_enabled: !llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
            gpu_transport_bound: false,
            adaptive_timestep_enabled: false,
            stats_policy: NativeStatsPolicy::full(1),
        })
    }

    pub fn create(plan: &fullmag_ir::FdmPlanIR) -> Result<Self, RunError> {
        Self::create_with_stats_policy(plan, NativeStatsPolicy::full(1))
    }

    #[allow(dead_code)]
    pub(crate) fn create_for_adaptive_batch(
        plan: &fullmag_ir::FdmPlanIR,
    ) -> Result<Self, RunError> {
        Self::create_for_adaptive_batch_with_policy(plan, NativeStatsPolicy::none(1))
    }

    pub(crate) fn create_for_adaptive_batch_with_policy(
        plan: &fullmag_ir::FdmPlanIR,
        stats_policy: NativeStatsPolicy,
    ) -> Result<Self, RunError> {
        if plan.adaptive_timestep.is_none() {
            return Err(RunError {
                message: "batched CUDA FDM construction requires an adaptive timestep policy"
                    .to_string(),
            });
        }
        Self::create_with_stats_policy(plan, stats_policy)
    }

    pub(crate) fn create_with_stats_policy(
        plan: &fullmag_ir::FdmPlanIR,
        stats_policy: NativeStatsPolicy,
    ) -> Result<Self, RunError> {
        // This is the last typed boundary before the dense carrier is flattened
        // into nullable ABI pointers. Never let malformed or stale selection
        // evidence reach a device probe, allocation, or native repair path.
        validate_native_frozen_spins_plan(plan)?;
        let integrator_choice = plan
            .integrator
            .unwrap_or(fullmag_ir::IntegratorChoice::Heun);
        validate_native_adaptive_policy(
            integrator_choice,
            plan.adaptive_timestep.as_ref(),
            plan.temperature.unwrap_or(0.0) > 0.0,
            plan.oersted_time_dep_kind != 0,
            !plan.spin_transport_plans.is_empty(),
        )?;
        let frozen_capabilities = if plan.frozen_spins.is_some() {
            unsafe { ffi::fullmag_fdm_capability_bits_v1() }
        } else {
            0
        };
        ensure_cuda_frozen_spins_supported(plan.frozen_spins.is_some(), frozen_capabilities)?;
        ensure_cuda_slonczewski_supported(plan)?;
        validate_single_grid_budget(plan)?;
        let sot_formula = ffi_prescribed_sot_formula(plan)?;
        let zhang_li_formula = ffi_zhang_li_formula(plan)?;
        let resolved_demag_boundary = crate::fdm::resolve_fdm_demag_boundary(plan)?;
        if plan.material.ms_field.is_some()
            || plan.material.a_field.is_some()
            || plan.material.alpha_field.is_some()
        {
            return Err(RunError {
                message: "FDM CUDA native does not yet support cellwise material fields (Ms/Aex/alpha); use FDM CPU reference or disable region material overrides".to_string(),
            });
        }
        let grid = ffi::fullmag_fdm_grid_desc {
            nx: plan.grid.cells[0],
            ny: plan.grid.cells[1],
            nz: plan.grid.cells[2],
            dx: plan.cell_size[0],
            dy: plan.cell_size[1],
            dz: plan.cell_size[2],
        };

        let material = ffi::fullmag_fdm_material_desc {
            saturation_magnetisation: plan.material.saturation_magnetisation,
            exchange_stiffness: plan.material.exchange_stiffness,
            damping: plan.material.damping,
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
        };

        let precision = match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => {
                ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE
            }
            fullmag_ir::ExecutionPrecision::Double => {
                ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE
            }
        };

        // The native descriptor retains an ABI-only slot that direct
        // minimizers do not consume.
        let integrator = match integrator_choice {
            fullmag_ir::IntegratorChoice::Heun => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN
            }
            fullmag_ir::IntegratorChoice::Rk4 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4
            }
            fullmag_ir::IntegratorChoice::Rk23 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK23
            }
            fullmag_ir::IntegratorChoice::Rk45 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_DP45
            }
            fullmag_ir::IntegratorChoice::Abm3 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_ABM3
            }
        };

        // Flatten [f64; 3] AoS → contiguous f64 buffer
        let m_flat: Vec<f64> = plan
            .initial_magnetization
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();
        let active_mask_flat: Option<Vec<u8>> = plan.active_mask.as_ref().map(|mask| {
            mask.iter()
                .map(|is_active| if *is_active { 1u8 } else { 0u8 })
                .collect()
        });
        let frozen_mask_flat: Option<Vec<u8>> = plan.frozen_spins.as_ref().map(|frozen| {
            frozen
                .frozen_mask
                .iter()
                .map(|is_frozen| if *is_frozen { 1u8 } else { 0u8 })
                .collect()
        });
        let sot_active_mask_flat: Option<Vec<u8>> = plan.sot_active_mask.as_ref().map(|mask| {
            mask.iter()
                .map(|is_target| if *is_target { 1u8 } else { 0u8 })
                .collect()
        });
        let slonczewski_active_mask_flat: Option<Vec<u8>> =
            plan.slonczewski_active_mask.as_ref().map(|mask| {
                mask.iter()
                    .map(|is_target| if *is_target { 1u8 } else { 0u8 })
                    .collect()
            });
        let region_mask_flat = if plan.region_mask.is_empty() {
            None
        } else {
            Some(plan.region_mask.clone())
        };
        let demag_kernel_spectra = if plan.enable_demag {
            if let fullmag_engine::FdmDemagBoundary::PeriodicTruncatedImages { image_counts } =
                resolved_demag_boundary
            {
                Some(fullmag_engine::compute_periodic_newell_kernel_spectra(
                    plan.grid.cells[0] as usize,
                    plan.grid.cells[1] as usize,
                    plan.grid.cells[2] as usize,
                    plan.cell_size[0],
                    plan.cell_size[1],
                    plan.cell_size[2],
                    plan.periodicity
                        .as_ref()
                        .map(|pbc| [pbc.is_periodic(0), pbc.is_periodic(1), pbc.is_periodic(2)])
                        .unwrap_or([false, false, false]),
                    image_counts,
                ))
            } else if plan.grid.cells[2] == 1 {
                Some(fullmag_engine::compute_newell_kernel_spectra_thin_film_2d(
                    plan.grid.cells[0] as usize,
                    plan.grid.cells[1] as usize,
                    plan.cell_size[0],
                    plan.cell_size[1],
                    plan.cell_size[2],
                ))
            } else {
                Some(fullmag_engine::compute_newell_kernel_spectra(
                    plan.grid.cells[0] as usize,
                    plan.grid.cells[1] as usize,
                    plan.grid.cells[2] as usize,
                    plan.cell_size[0],
                    plan.cell_size[1],
                    plan.cell_size[2],
                ))
            }
        } else {
            None
        };
        let adaptive = plan.adaptive_timestep.as_ref();
        let oersted_field_flat: Option<Vec<f64>> = plan.oersted_field_xyz.as_ref().map(|field| {
            field
                .iter()
                .flat_map(|value| value.iter().copied())
                .collect()
        });
        let static_external_field_flat: Option<Vec<f64>> =
            plan.static_external_field_xyz.as_ref().map(|field| {
                field
                    .iter()
                    .flat_map(|value| value.iter().copied())
                    .collect()
            });
        // The legacy descriptor has one append-only Oersted pointer.  A
        // static H_ext profile is uploaded through its separate role setter
        // after creation, so it must never be advertised as H_OE here.
        let uploaded_profile_flat = oersted_field_flat.as_ref();

        // Current region-owned semantics keep exchange continuous by default.
        // Explicit triples are compact pair descriptors; the native backend
        // expands them into the low-level LUT after applying the default.
        let exchange_pairs = build_region_exchange_pairs(plan, region_mask_flat.is_some())?;

        let current_sign: f64 = if has_slonczewski_stt(plan) {
            match plan.stt_fixed_layer_position.as_deref() {
                Some("bottom") => -1.0,
                _ => 1.0,
            }
        } else {
            1.0
        };

        let plan_desc = ffi::fullmag_fdm_plan_desc {
            grid,
            material,
            precision,
            integrator,
            disable_precession: if llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()) {
                1
            } else {
                0
            },
            enable_exchange: if plan.enable_exchange { 1 } else { 0 },
            enable_demag: if plan.enable_demag { 1 } else { 0 },
            has_external_field: if plan.external_field.is_some() { 1 } else { 0 },
            external_field_am: plan.external_field.unwrap_or([0.0, 0.0, 0.0]),

            ms_field: plan
                .material
                .ms_field
                .as_ref()
                .map_or(std::ptr::null(), |values| values.as_ptr()),
            ms_field_len: plan
                .material
                .ms_field
                .as_ref()
                .map_or(0, |values| values.len() as u64),
            a_field: plan
                .material
                .a_field
                .as_ref()
                .map_or(std::ptr::null(), |values| values.as_ptr()),
            a_field_len: plan
                .material
                .a_field
                .as_ref()
                .map_or(0, |values| values.len() as u64),
            alpha_field: plan
                .material
                .alpha_field
                .as_ref()
                .map_or(std::ptr::null(), |values| values.as_ptr()),
            alpha_field_len: plan
                .material
                .alpha_field
                .as_ref()
                .map_or(0, |values| values.len() as u64),

            current_density_x: plan.current_density.map_or(0.0, |j| j[0]),
            current_density_y: plan.current_density.map_or(0.0, |j| j[1]),
            current_density_z: plan.current_density.map_or(0.0, |j| j[2]),
            stt_degree: plan.stt_degree.unwrap_or(0.0),
            stt_beta: plan.stt_beta.unwrap_or(0.0),
            zhang_li_formula,

            stt_p_x: plan.stt_spin_polarization.map_or(0.0, |p| p[0]),
            stt_p_y: plan.stt_spin_polarization.map_or(0.0, |p| p[1]),
            stt_p_z: plan.stt_spin_polarization.map_or(0.0, |p| p[2]),
            stt_lambda: plan.stt_lambda.unwrap_or(0.0),
            stt_epsilon_prime: plan.stt_epsilon_prime.unwrap_or(0.0),
            stt_free_layer_thickness: plan.stt_thickness.unwrap_or(0.0),
            stt_current_sign: current_sign,
            slonczewski_formula: match plan.slonczewski_formula_version.as_deref() {
                Some("slonczewski.fullmag.v2") => {
                    ffi::fullmag_fdm_slonczewski_formula::FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2
                }
                _ => {
                    ffi::fullmag_fdm_slonczewski_formula::FULLMAG_FDM_SLONCZEWSKI_LEGACY_FULLMAG_V0
                }
            },
            stt_stack_normal: plan.slonczewski_stack_normal.unwrap_or([0.0, 0.0, 1.0]),
            slonczewski_active_mask: slonczewski_active_mask_flat
                .as_ref()
                .map_or(std::ptr::null(), |mask| mask.as_ptr()),
            slonczewski_active_mask_len: slonczewski_active_mask_flat
                .as_ref()
                .map_or(0, |mask| mask.len() as u64),

            has_sot: if plan.sot_current_density.is_some()
                && plan.sot_sigma.is_some()
                && plan.sot_thickness.is_some()
            {
                1
            } else {
                0
            },
            sot_formula,
            sot_je: plan.sot_current_density.unwrap_or(0.0),
            sot_xi_dl: plan.sot_xi_dl.unwrap_or(0.0),
            sot_xi_fl: plan.sot_xi_fl.unwrap_or(0.0),
            sot_sigma: plan.sot_sigma.unwrap_or([0.0, 0.0, 1.0]),
            sot_thickness: plan.sot_thickness.unwrap_or(1.0e-9),
            sot_active_mask: sot_active_mask_flat
                .as_ref()
                .map_or(std::ptr::null(), |mask| mask.as_ptr()),
            sot_active_mask_len: sot_active_mask_flat
                .as_ref()
                .map_or(0, |mask| mask.len() as u64),

            has_oersted_cylinder: if plan.has_oersted_cylinder { 1 } else { 0 },
            oersted_current: plan.oersted_current.unwrap_or(0.0),
            oersted_radius: plan.oersted_radius.unwrap_or(0.0),
            oersted_center: plan.oersted_center.unwrap_or([0.0, 0.0, 0.0]),
            oersted_axis: plan.oersted_axis.unwrap_or([0.0, 0.0, 1.0]),
            oersted_time_dep_kind: plan.oersted_time_dep_kind,
            oersted_time_dep_freq: plan.oersted_time_dep_freq,
            oersted_time_dep_phase: plan.oersted_time_dep_phase,
            oersted_time_dep_offset: plan.oersted_time_dep_offset,
            oersted_time_dep_t_on: plan.oersted_time_dep_t_on,
            oersted_time_dep_t_off: plan.oersted_time_dep_t_off,
            oersted_field_xyz: uploaded_profile_flat
                .as_ref()
                .map_or(std::ptr::null(), |field| field.as_ptr()),
            oersted_field_len: uploaded_profile_flat
                .as_ref()
                .map_or(0, |field| field.len() as u64),

            has_uniaxial_anisotropy: if plan.material.uniaxial_anisotropy_ku1.is_some() {
                1
            } else {
                0
            },
            uniaxial_anisotropy_constant: plan.material.uniaxial_anisotropy_ku1.unwrap_or(0.0),
            uniaxial_anisotropy_k2: plan.material.uniaxial_anisotropy_ku2.unwrap_or(0.0),
            anisotropy_axis: plan.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),

            ku1_field: std::ptr::null(),
            ku2_field: std::ptr::null(),

            has_cubic_anisotropy: if plan.material.cubic_anisotropy_kc1.is_some()
                || plan.material.cubic_anisotropy_kc2.is_some()
                || plan.material.cubic_anisotropy_kc3.is_some()
            {
                1
            } else {
                0
            },
            cubic_Kc1: plan.material.cubic_anisotropy_kc1.unwrap_or(0.0),
            cubic_Kc2: plan.material.cubic_anisotropy_kc2.unwrap_or(0.0),
            cubic_Kc3: plan.material.cubic_anisotropy_kc3.unwrap_or(0.0),
            cubic_axis1: plan
                .material
                .cubic_anisotropy_axis1
                .unwrap_or([1.0, 0.0, 0.0]),
            cubic_axis2: plan
                .material
                .cubic_anisotropy_axis2
                .unwrap_or([0.0, 1.0, 0.0]),
            kc1_field: std::ptr::null(),
            kc2_field: std::ptr::null(),
            kc3_field: std::ptr::null(),

            has_interfacial_dmi: if plan.interfacial_dmi.is_some() { 1 } else { 0 },
            dmi_D_interfacial: plan.interfacial_dmi.unwrap_or(0.0),
            has_bulk_dmi: if plan.bulk_dmi.is_some() { 1 } else { 0 },
            dmi_D_bulk: plan.bulk_dmi.unwrap_or(0.0),
            dind_field: plan
                .dind_field
                .as_ref()
                .map_or(std::ptr::null(), |values| values.as_ptr()),
            dind_field_len: plan
                .dind_field
                .as_ref()
                .map_or(0, |values| values.len() as u64),
            dbulk_field: plan
                .dbulk_field
                .as_ref()
                .map_or(std::ptr::null(), |values| values.as_ptr()),
            dbulk_field_len: plan
                .dbulk_field
                .as_ref()
                .map_or(0, |values| values.len() as u64),

            has_magnetoelastic: if plan.mel_b1.is_some() && plan.mel_uniform_strain.is_some() {
                1
            } else {
                0
            },
            mel_b1: plan.mel_b1.unwrap_or(0.0),
            mel_b2: plan.mel_b2.unwrap_or(0.0),
            mel_strain: plan.mel_uniform_strain.unwrap_or([0.0; 6]),

            temperature: plan.temperature.unwrap_or(0.0),
            thermal_seed: plan
                .thermal_seed_config
                .as_ref()
                .and_then(|config| config.seed)
                .unwrap_or(0),

            demag_kernel_xx_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_xx.as_ptr()),
            demag_kernel_yy_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_yy.as_ptr()),
            demag_kernel_zz_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_zz.as_ptr()),
            demag_kernel_xy_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_xy.as_ptr()),
            demag_kernel_xz_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_xz.as_ptr()),
            demag_kernel_yz_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_yz.as_ptr()),
            demag_kernel_spectrum_len: demag_kernel_spectra
                .as_ref()
                .map_or(0, |kernels| kernels.n_xx.len() as u64),
            demag_fft_nx: demag_kernel_spectra
                .as_ref()
                .map_or(0, |kernels| kernels.px as u32),
            demag_fft_ny: demag_kernel_spectra
                .as_ref()
                .map_or(0, |kernels| kernels.py as u32),
            demag_fft_nz: demag_kernel_spectra
                .as_ref()
                .map_or(0, |kernels| kernels.pz as u32),
            active_mask: active_mask_flat
                .as_ref()
                .map_or(std::ptr::null(), |mask| mask.as_ptr()),
            active_mask_len: active_mask_flat
                .as_ref()
                .map_or(0, |mask| mask.len() as u64),
            region_mask: region_mask_flat
                .as_ref()
                .map_or(std::ptr::null(), |mask| mask.as_ptr()),
            region_mask_len: region_mask_flat
                .as_ref()
                .map_or(0, |mask| mask.len() as u64),
            exchange_lut: std::ptr::null(),
            exchange_lut_len: 0,
            exchange_pair_default:
                ffi::fullmag_fdm_exchange_pair_mode::FULLMAG_FDM_EXCHANGE_PAIR_HARMONIC_MEAN,
            exchange_pairs: exchange_pairs
                .as_ref()
                .map_or(std::ptr::null(), |pairs| pairs.as_ptr()),
            exchange_pair_count: exchange_pairs
                .as_ref()
                .map_or(0, |pairs| pairs.len() as u64),
            // Boundary correction — wire geometry data from planner when available.
            boundary_correction: match plan.boundary_correction.as_deref() {
                Some("volume") => ffi::fullmag_fdm_boundary_correction::FULLMAG_FDM_BOUNDARY_VOLUME,
                Some("full") => ffi::fullmag_fdm_boundary_correction::FULLMAG_FDM_BOUNDARY_FULL,
                _ => ffi::fullmag_fdm_boundary_correction::FULLMAG_FDM_BOUNDARY_NONE,
            },
            boundary_phi_floor: plan.boundary_phi_floor.unwrap_or(0.0),
            boundary_delta_min: plan.boundary_delta_min.unwrap_or(0.0),
            volume_fraction: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.volume_fraction.as_ptr()),
            volume_fraction_len: plan
                .boundary_geometry
                .as_ref()
                .map_or(0, |bg| bg.volume_fraction.len() as u64),
            face_link_xp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_xp.as_ptr()),
            face_link_xm: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_xm.as_ptr()),
            face_link_yp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_yp.as_ptr()),
            face_link_ym: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_ym.as_ptr()),
            face_link_zp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_zp.as_ptr()),
            face_link_zm: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_zm.as_ptr()),
            delta_xp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_xp.as_ptr()),
            delta_xm: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_xm.as_ptr()),
            delta_yp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_yp.as_ptr()),
            delta_ym: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_ym.as_ptr()),
            delta_zp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_zp.as_ptr()),
            delta_zm: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_zm.as_ptr()),
            has_demag_boundary_corr: plan.boundary_geometry.as_ref().map_or(0, |bg| {
                if bg.demag_corr_target_idx.is_empty() {
                    0
                } else {
                    1
                }
            }),
            demag_corr_target_idx: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.demag_corr_target_idx.as_ptr()),
            demag_corr_source_idx: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.demag_corr_source_idx.as_ptr()),
            demag_corr_tensor: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.demag_corr_tensor.as_ptr()),
            demag_corr_target_count: plan
                .boundary_geometry
                .as_ref()
                .map_or(0, |bg| bg.demag_corr_target_idx.len() as u32),
            demag_corr_stencil_size: plan
                .boundary_geometry
                .as_ref()
                .map_or(0, |bg| bg.demag_corr_stencil_size),
            initial_magnetization_xyz: m_flat.as_ptr(),
            initial_magnetization_len: m_flat.len() as u64,
            periodic_x: plan
                .periodicity
                .as_ref()
                .map_or(0, |p| if p.is_periodic(0) { 1 } else { 0 }),
            periodic_y: plan
                .periodicity
                .as_ref()
                .map_or(0, |p| if p.is_periodic(1) { 1 } else { 0 }),
            periodic_z: plan
                .periodicity
                .as_ref()
                .map_or(0, |p| if p.is_periodic(2) { 1 } else { 0 }),
            adaptive_max_error: 0.0,
            adaptive_dt_min: 0.0,
            adaptive_dt_max: 0.0,
            adaptive_headroom: 0.0,
            stats_mode: if stats_policy.mode == NativeStatsMode::Requested {
                NativeStatsMode::None.as_ffi()
            } else {
                stats_policy.mode.as_ffi()
            },
            stats_stride: stats_policy.stride,
            frozen_mask: frozen_mask_flat
                .as_ref()
                .map_or(std::ptr::null(), |mask| mask.as_ptr()),
            frozen_mask_len: frozen_mask_flat
                .as_ref()
                .map_or(0, |mask| mask.len() as u64),
            frozen_reference_xyz: if frozen_mask_flat.is_some() {
                m_flat.as_ptr()
            } else {
                std::ptr::null()
            },
            frozen_reference_len: if frozen_mask_flat.is_some() {
                m_flat.len() as u64
            } else {
                0
            },
        };

        let time_policy = native_time_policy(adaptive)?;
        let plan_desc_v2 = ffi::fullmag_fdm_plan_desc_v2 {
            abi_version: ffi::FULLMAG_FDM_PLAN_DESC_ABI_V2,
            struct_size: std::mem::size_of::<ffi::fullmag_fdm_plan_desc_v2>() as u32,
            base: plan_desc,
            time_policy,
        };

        let mut handle = std::ptr::null_mut();
        let create_status = unsafe {
            ffi::fullmag_fdm_backend_create_time_policy_v2_checked(&plan_desc_v2, &mut handle)
        };
        if create_status != ffi::FULLMAG_FDM_OK {
            let message = match create_status {
                ffi::FULLMAG_FDM_ERR_INVALID => "CUDA FDM plan descriptor is invalid",
                ffi::FULLMAG_FDM_ERR_CUDA => "CUDA FDM backend initialization failed",
                ffi::FULLMAG_FDM_ERR_INTERNAL => {
                    "CUDA FDM backend initialization failed internally"
                }
                ffi::FULLMAG_FDM_ERR_INTERRUPTED => {
                    "CUDA FDM backend initialization was interrupted"
                }
                ffi::FULLMAG_FDM_ERR_DT_MIN_EXHAUSTED => {
                    "CUDA FDM backend exhausted dt_min during initialization"
                }
                ffi::FULLMAG_FDM_ERR_ABI => "CUDA FDM plan descriptor ABI mismatch",
                _ => "CUDA FDM backend returned an unknown initialization status",
            };
            return Err(RunError {
                message: format!("{message} (status {create_status})"),
            });
        }
        if handle.is_null() {
            return Err(RunError {
                message: "CUDA FDM backend_create returned null".to_string(),
            });
        }

        // Check for deferred creation errors
        let err = unsafe { ffi::fullmag_fdm_backend_last_error(handle) };
        if !err.is_null() {
            let msg = unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string();
            unsafe { ffi::fullmag_fdm_backend_destroy(handle) };
            return Err(RunError { message: msg });
        }

        let native_stats_policy = ffi::fullmag_fdm_stats_policy_v1 {
            abi_version: ffi::FULLMAG_FDM_STATS_POLICY_ABI_V1,
            struct_size: std::mem::size_of::<ffi::fullmag_fdm_stats_policy_v1>() as u32,
            mode: stats_policy.mode.as_ffi(),
            stride: stats_policy.stride,
            quantity_mask: stats_policy.quantity_mask,
        };
        let policy_status =
            unsafe { ffi::fullmag_fdm_backend_set_stats_policy_v1(handle, &native_stats_policy) };
        if policy_status != ffi::FULLMAG_FDM_OK {
            let message = unsafe {
                let err = ffi::fullmag_fdm_backend_last_error(handle);
                if err.is_null() {
                    "failed to apply resolved CUDA FDM stats policy".to_string()
                } else {
                    CStr::from_ptr(err).to_string_lossy().to_string()
                }
            };
            unsafe { ffi::fullmag_fdm_backend_destroy(handle) };
            return Err(RunError { message });
        }

        if let Some(field) = static_external_field_flat.as_ref() {
            let marked = unsafe {
                ffi::fullmag_fdm_backend_set_static_external_field_f64(
                    handle,
                    field.as_ptr(),
                    field.len() as u64,
                )
            };
            if marked != ffi::FULLMAG_FDM_OK {
                let message = unsafe {
                    let err = ffi::fullmag_fdm_backend_last_error(handle);
                    if err.is_null() {
                        "failed to mark static external field profile".to_string()
                    } else {
                        CStr::from_ptr(err).to_string_lossy().to_string()
                    }
                };
                unsafe { ffi::fullmag_fdm_backend_destroy(handle) };
                return Err(RunError { message });
            }
        }

        Ok(Self {
            handle,
            cell_count: m_flat.len() / 3,
            active_mask: plan.active_mask.clone(),
            frozen_mask: plan
                .frozen_spins
                .as_ref()
                .map(|frozen_spins| frozen_spins.frozen_mask.clone()),
            precision: plan.precision,
            precision_policy: plan.precision_policy.clone(),
            damping: plan.material.damping,
            precession_enabled: !llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
            gpu_transport_bound: false,
            adaptive_timestep_enabled: adaptive.is_some(),
            stats_policy,
        })
    }

    pub(crate) fn stats_policy(&self) -> NativeStatsPolicy {
        self.stats_policy
    }

    #[allow(dead_code)]
    pub(crate) fn set_stats_policy(
        &mut self,
        stats_policy: NativeStatsPolicy,
    ) -> Result<(), RunError> {
        let policy = ffi::fullmag_fdm_stats_policy_v1 {
            abi_version: ffi::FULLMAG_FDM_STATS_POLICY_ABI_V1,
            struct_size: std::mem::size_of::<ffi::fullmag_fdm_stats_policy_v1>() as u32,
            mode: stats_policy.mode.as_ffi(),
            stride: stats_policy.stride,
            quantity_mask: stats_policy.quantity_mask,
        };
        let status = unsafe { ffi::fullmag_fdm_backend_set_stats_policy_v1(self.handle, &policy) };
        if status != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("setting CUDA FDM stats policy failed"));
        }
        self.stats_policy = stats_policy;
        Ok(())
    }

    pub(crate) fn bind_gpu_transport(
        &mut self,
        binding: &fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_gpu_transport_llg_binding_v1,
    ) -> Result<(), RunError> {
        if self.gpu_transport_bound {
            return Err(RunError {
                message: "GPU transport is already bound to this FDM context".to_string(),
            });
        }
        let status = unsafe {
            fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_context_bind_gpu_transport_v1(
                self.handle,
                binding,
            )
        };
        if status != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("binding GPU transport to the FDM LLG context failed"));
        }
        self.gpu_transport_bound = true;
        Ok(())
    }

    pub(crate) fn unbind_gpu_transport(&mut self) -> Result<(), RunError> {
        if !self.gpu_transport_bound {
            return Ok(());
        }
        let status = unsafe {
            fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_context_unbind_gpu_transport_v1(
                self.handle,
            )
        };
        if status != ffi::FULLMAG_FDM_OK {
            return Err(
                self.last_error_or("unbinding GPU transport from the FDM LLG context failed")
            );
        }
        self.gpu_transport_bound = false;
        Ok(())
    }

    pub fn set_interrupt_signal(&mut self, signal: Option<&AtomicBool>) -> Result<(), RunError> {
        let (poll_fn, user_data) = signal.map_or((None, std::ptr::null_mut()), |flag| {
            (
                Some(Self::poll_atomic_interrupt_flag as unsafe extern "C" fn(*mut c_void) -> i32),
                flag as *const AtomicBool as *mut c_void,
            )
        });
        let rc =
            unsafe { ffi::fullmag_fdm_backend_set_interrupt_poll(self.handle, poll_fn, user_data) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("set_interrupt_signal failed"));
        }
        Ok(())
    }

    pub fn step_interruptible(
        &mut self,
        dt: f64,
        interrupt_signal: Option<&AtomicBool>,
    ) -> Result<Option<StepStats>, RunError> {
        self.set_interrupt_signal(interrupt_signal)?;
        let mut stats = ffi::fullmag_fdm_step_stats {
            step: 0,
            time_seconds: 0.0,
            dt_seconds: 0.0,
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            anisotropy_energy_joules: 0.0,
            cubic_energy_joules: 0.0,
            dmi_energy_joules: 0.0,
            total_energy_joules: 0.0,
            max_effective_field_amplitude: 0.0,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude: 0.0,
            max_torque_Apm: 0.0,
            suggested_next_dt: 0.0,
            wall_time_ns: 0,
            hot_loop_d2h_bytes: 0,
            hot_loop_host_sync_count: 0,
            hot_loop_control_scalar_d2h_bytes: 0,
            hot_loop_control_scalar_host_sync_count: 0,
            multilayer_refresh_count: 0,
            multilayer_forward_fft_count: 0,
            multilayer_inverse_fft_count: 0,
            multilayer_pair_accumulation_count: 0,
        };

        let rc = unsafe { ffi::fullmag_fdm_backend_step(self.handle, dt, &mut stats) };
        if rc == ffi::FULLMAG_FDM_ERR_INTERRUPTED {
            return Ok(None);
        }
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("step failed"));
        }

        let adaptive_summary = self.copy_adaptive_attempt_summary()?;

        let native_metrics =
            validate_native_step_metrics(stats.max_torque_Apm, stats.max_rhs_amplitude)?;
        let mut step_stats = StepStats {
            step: stats.step,
            time: stats.time_seconds,
            dt: stats.dt_seconds,
            e_ex: stats.exchange_energy_joules,
            e_demag: stats.demag_energy_joules,
            e_ext: stats.external_energy_joules,
            e_ani: stats.anisotropy_energy_joules + stats.cubic_energy_joules,
            e_dmi: stats.dmi_energy_joules,
            e_total: stats.total_energy_joules,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            max_dm_dt: stats.max_rhs_amplitude,
            max_rhs_norm_per_s: native_metrics.max_rhs_norm_per_s,
            max_torque_Apm: native_metrics.max_torque_apm,
            max_torque_T: native_metrics.max_torque_apm * crate::MU0,
            wall_time_ns: stats.wall_time_ns,
            hot_loop_d2h_bytes: stats.hot_loop_d2h_bytes,
            hot_loop_host_sync_count: stats.hot_loop_host_sync_count,
            hot_loop_control_scalar_d2h_bytes: stats.hot_loop_control_scalar_d2h_bytes,
            hot_loop_control_scalar_host_sync_count: stats.hot_loop_control_scalar_host_sync_count,
            error_estimate: adaptive_summary.map(|(_, error)| error),
            rejected_attempts: adaptive_summary.map_or(0, |(rejected, _)| rejected),
            dt_suggested: if stats.suggested_next_dt > 0.0 {
                Some(stats.suggested_next_dt)
            } else {
                None
            },
            ..StepStats::default()
        };
        step_stats.per_object_scalars = single_object_scalars("free", &step_stats);
        Ok(Some(step_stats))
    }

    pub(crate) fn step_adaptive_batch_interruptible(
        &mut self,
        initial_dt: f64,
        target_time: f64,
        max_steps: u32,
        interrupt_signal: Option<&AtomicBool>,
    ) -> Result<Option<Vec<AdaptiveBatchStep>>, RunError> {
        self.set_interrupt_signal(interrupt_signal)?;
        if !self.adaptive_timestep_enabled {
            return Err(RunError {
                message: "adaptive CUDA batch requested for a fixed-step backend".to_string(),
            });
        }
        if max_steps == 0 || max_steps as usize > ffi::FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1 {
            return Err(RunError {
                message: format!(
                    "adaptive CUDA batch max_steps must be in 1..={}, got {max_steps}",
                    ffi::FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1
                ),
            });
        }

        let mut records =
            [std::mem::MaybeUninit::<ffi::fullmag_fdm_adaptive_batch_step_v1>::uninit();
                ffi::FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1];
        let mut count = 0u32;
        let rc = unsafe {
            ffi::fullmag_fdm_backend_step_adaptive_batch_v1(
                self.handle,
                initial_dt,
                target_time,
                max_steps,
                records.as_mut_ptr().cast(),
                records.len() as u32,
                &mut count,
            )
        };
        if rc == ffi::FULLMAG_FDM_ERR_INTERRUPTED {
            return Ok(None);
        }
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("adaptive CUDA batch step failed"));
        }
        if count == 0 || count > max_steps {
            return Err(RunError {
                message: format!(
                    "native adaptive CUDA batch returned invalid record count {count} for max_steps={max_steps}"
                ),
            });
        }
        let records = unsafe {
            std::slice::from_raw_parts(
                records
                    .as_ptr()
                    .cast::<ffi::fullmag_fdm_adaptive_batch_step_v1>(),
                count as usize,
            )
        };
        let mut batch = Vec::with_capacity(records.len());
        let mut previous_step = None;
        let mut previous_time = None;
        for record in records {
            if record.abi_version != ffi::FULLMAG_FDM_ADAPTIVE_BATCH_STEP_ABI_V1
                || record.struct_size
                    != std::mem::size_of::<ffi::fullmag_fdm_adaptive_batch_step_v1>() as u32
                || record.decision != ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_ACCEPTED
                || record.reason != ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_WITHIN_TOLERANCE
                || !record.time_seconds.is_finite()
                || !record.dt_seconds.is_finite()
                || record.dt_seconds <= 0.0
                || !record.suggested_next_dt_seconds.is_finite()
                || record.suggested_next_dt_seconds <= 0.0
                || !record.normalized_error.is_finite()
                || record.normalized_error < 0.0
                || previous_step.is_some_and(|step| record.step != step + 1)
                || previous_time.is_some_and(|time| record.time_seconds <= time)
            {
                return Err(RunError {
                    message: "native adaptive CUDA batch returned an invalid accepted-step trace"
                        .to_string(),
                });
            }
            previous_step = Some(record.step);
            previous_time = Some(record.time_seconds);
            batch.push(AdaptiveBatchStep {
                step: record.step,
                time: record.time_seconds,
                dt: record.dt_seconds,
                suggested_next_dt: record.suggested_next_dt_seconds,
                normalized_error: record.normalized_error,
                rejected_attempts: record.rejected_attempts,
            });
        }
        if batch.last().is_some_and(|record| {
            record.time > target_time + crate::schedules::OUTPUT_TIME_TOLERANCE
        }) {
            return Err(RunError {
                message: "native adaptive CUDA batch advanced beyond its target time".to_string(),
            });
        }
        Ok(Some(batch))
    }

    fn copy_adaptive_attempt_summary(&self) -> Result<Option<(u32, f64)>, RunError> {
        if !self.adaptive_timestep_enabled {
            return Ok(None);
        }
        let mut count = 0u32;
        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_adaptive_attempts_v1(
                self.handle,
                std::ptr::null_mut(),
                0,
                &mut count,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("adaptive attempt count query failed"));
        }
        if count == 0 || count as usize > ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1 {
            return Err(RunError {
                message: format!("native FDM adaptive attempt count is invalid: {count}"),
            });
        }

        let mut records = [std::mem::MaybeUninit::<ffi::fullmag_fdm_adaptive_attempt_v1>::uninit();
            ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1];
        let mut copied = 0u32;
        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_adaptive_attempts_v1(
                self.handle,
                records.as_mut_ptr().cast(),
                records.len() as u32,
                &mut copied,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK || copied != count {
            return Err(self.last_error_or("adaptive attempt batch copy failed"));
        }
        let records = unsafe {
            std::slice::from_raw_parts(
                records
                    .as_ptr()
                    .cast::<ffi::fullmag_fdm_adaptive_attempt_v1>(),
                copied as usize,
            )
        };
        validate_adaptive_attempt_batch(records).map(Some)
    }

    pub fn apply_average_m_to_step_stats(&self, stats: &mut StepStats) -> Result<(), RunError> {
        let magnetization = self.copy_m(self.cell_count)?;
        self.apply_average_m_to_step_stats_from_values(stats, &magnetization);
        Ok(())
    }

    pub(crate) fn apply_average_m_to_step_stats_from_values(
        &self,
        stats: &mut StepStats,
        magnetization: &[[f64; 3]],
    ) {
        crate::scalar_metrics::apply_average_m_to_step_stats_with_active_mask(
            stats,
            &magnetization,
            self.active_mask.as_deref(),
        );
        // Keep the object-scoped telemetry synchronized with the sampled
        // magnetization. This path is also used when a scalar output is due,
        // without going through `apply_average_m_to_step_stats`.
        stats.per_object_scalars = single_object_scalars("free", stats);
    }

    /// Execute one time step.
    pub fn step(&mut self, dt: f64) -> Result<StepStats, RunError> {
        self.step_interruptible(dt, None)?
            .ok_or_else(|| self.last_error_or("step interrupted without an interrupt signal"))
    }

    pub(crate) fn set_checkpoint_execution_identity(
        &mut self,
        requested_backend: fullmag_ir::BackendTarget,
        requested_device: &str,
        execution_mode: fullmag_ir::ExecutionMode,
        integrator: fullmag_ir::IntegratorChoice,
    ) -> Result<(), RunError> {
        let requested_backend = match requested_backend {
            fullmag_ir::BackendTarget::Auto => ffi::FULLMAG_FDM_CHECKPOINT_BACKEND_AUTO,
            fullmag_ir::BackendTarget::Fdm => ffi::FULLMAG_FDM_CHECKPOINT_BACKEND_FDM,
            other => {
                return Err(RunError {
                    message: format!(
                        "FDM CUDA checkpoint identity cannot request backend '{other:?}'"
                    ),
                });
            }
        };
        let requested_device = match requested_device {
            "auto" => ffi::FULLMAG_FDM_CHECKPOINT_DEVICE_AUTO,
            "gpu" | "cuda" => ffi::FULLMAG_FDM_CHECKPOINT_DEVICE_GPU,
            other => {
                return Err(RunError {
                    message: format!(
                        "FDM CUDA checkpoint identity cannot request device '{other}'"
                    ),
                });
            }
        };
        let policy = match execution_mode {
            fullmag_ir::ExecutionMode::Strict => ffi::FULLMAG_FDM_CHECKPOINT_POLICY_STRICT,
            fullmag_ir::ExecutionMode::Extended => ffi::FULLMAG_FDM_CHECKPOINT_POLICY_EXTENDED,
            fullmag_ir::ExecutionMode::Hybrid => {
                return Err(RunError {
                    message: "FDM CUDA checkpoint identity does not support hybrid execution"
                        .to_string(),
                });
            }
        };
        let precision = match self.precision {
            fullmag_ir::ExecutionPrecision::Single => {
                ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE as u32
            }
            fullmag_ir::ExecutionPrecision::Double => {
                ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE as u32
            }
        };
        let integrator = match integrator {
            fullmag_ir::IntegratorChoice::Heun => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN as u32
            }
            fullmag_ir::IntegratorChoice::Rk4 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4 as u32
            }
            fullmag_ir::IntegratorChoice::Rk23 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK23 as u32
            }
            fullmag_ir::IntegratorChoice::Rk45 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_DP45 as u32
            }
            fullmag_ir::IntegratorChoice::Abm3 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_ABM3 as u32
            }
        };
        let requested_realization = if requested_device == ffi::FULLMAG_FDM_CHECKPOINT_DEVICE_AUTO {
            0
        } else {
            ffi::FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM
        };
        let device_ordinal = residency::query_execution_device_ordinal(self)?;
        let identity = ffi::fullmag_fdm_checkpoint_execution_identity_v3 {
            abi_version: ffi::FULLMAG_FDM_CHECKPOINT_EXECUTION_IDENTITY_ABI_V3,
            struct_size: std::mem::size_of::<ffi::fullmag_fdm_checkpoint_execution_identity_v3>()
                as u32,
            requested_backend,
            resolved_backend: ffi::FULLMAG_FDM_CHECKPOINT_BACKEND_FDM,
            executed_backend: ffi::FULLMAG_FDM_CHECKPOINT_BACKEND_FDM,
            requested_policy: policy,
            resolved_policy: policy,
            executed_policy: policy,
            requested_realization,
            resolved_realization: ffi::FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM,
            executed_realization: ffi::FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM,
            requested_device,
            resolved_device: ffi::FULLMAG_FDM_CHECKPOINT_DEVICE_GPU,
            executed_device: ffi::FULLMAG_FDM_CHECKPOINT_DEVICE_GPU,
            requested_precision: precision,
            resolved_precision: precision,
            executed_precision: precision,
            requested_integrator: integrator,
            resolved_integrator: integrator,
            executed_integrator: integrator,
            device_ordinal,
            reserved0: 0,
        };
        let rc = unsafe {
            ffi::fullmag_fdm_backend_set_checkpoint_execution_identity_v3(self.handle, &identity)
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("committing LLG checkpoint execution identity failed"));
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn export_llg_checkpoint(&self) -> Result<NativeLlgCheckpointV4, RunError> {
        let mut required_bytes = 0u64;
        let rc = unsafe {
            ffi::fullmag_fdm_backend_llg_checkpoint_query_size_v4(self.handle, &mut required_bytes)
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("LLG checkpoint size query failed"));
        }
        let payload_len = usize::try_from(required_bytes).map_err(|_| RunError {
            message: "LLG checkpoint size exceeds host address space".to_string(),
        })?;
        let mut payload = Vec::new();
        payload
            .try_reserve_exact(payload_len)
            .map_err(|_| RunError {
                message: format!("failed to allocate {required_bytes} bytes for LLG checkpoint"),
            })?;
        payload.resize(payload_len, 0);
        let mut info = ffi::fullmag_fdm_llg_checkpoint_info_v4::default();
        let rc = unsafe {
            ffi::fullmag_fdm_backend_llg_checkpoint_export_v4(
                self.handle,
                payload.as_mut_ptr().cast(),
                required_bytes,
                &mut info,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("LLG checkpoint export failed"));
        }
        if info.schema_version != ffi::FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V4
            || info.payload_bytes != required_bytes
            || info.cell_count != self.cell_count as u64
        {
            return Err(RunError {
                message: "native LLG checkpoint metadata does not match the backend".to_string(),
            });
        }
        Ok(NativeLlgCheckpointV4 {
            info,
            payload_sha256: Sha256::digest(&payload).into(),
            payload,
        })
    }

    #[allow(dead_code)]
    pub(crate) fn restore_llg_checkpoint(
        &mut self,
        checkpoint: &NativeLlgCheckpointV4,
    ) -> Result<(), RunError> {
        let payload_bytes = u64::try_from(checkpoint.payload.len()).map_err(|_| RunError {
            message: "LLG checkpoint payload exceeds u64".to_string(),
        })?;
        let payload_sha256: [u8; 32] = Sha256::digest(&checkpoint.payload).into();
        if checkpoint.info.schema_version != ffi::FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V4
            || checkpoint.info.payload_bytes != payload_bytes
            || checkpoint.info.cell_count != self.cell_count as u64
            || checkpoint.payload_sha256 != payload_sha256
        {
            return Err(RunError {
                message: "LLG checkpoint identity or SHA-256 mismatch".to_string(),
            });
        }
        let rc = unsafe {
            ffi::fullmag_fdm_backend_llg_checkpoint_import_v4(
                self.handle,
                checkpoint.payload.as_ptr().cast(),
                payload_bytes,
                &checkpoint.info,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("LLG checkpoint restore failed"));
        }
        Ok(())
    }

    pub fn stage_completion(&self) -> Result<Option<fullmag_ir::StageCompletionIR>, RunError> {
        Ok(None)
    }

    /// Copy a field observable from device to host as [f64; 3] AoS.
    pub fn copy_field(
        &self,
        observable: ffi::fullmag_fdm_observable,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        let len = cell_count * 3;
        let mut flat = vec![0.0f64; len];

        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_field_f64(
                self.handle as *mut _,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("copy_field failed"));
        }

        Ok(unpack_flat_f64(&flat))
    }

    /// Copy a field observable from device to host as [f32; 3] AoS.
    pub fn copy_field_f32(
        &self,
        observable: ffi::fullmag_fdm_observable,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        let len = cell_count * 3;
        let mut flat = vec![0.0f32; len];

        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_field_f32(
                self.handle as *mut _,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("copy_field_f32 failed"));
        }

        Ok(unpack_flat_f32(&flat))
    }

    /// Copy a per-cell scalar observable from device to host as f64.
    pub fn copy_scalar_field(
        &self,
        observable: ffi::fullmag_fdm_observable,
        cell_count: usize,
    ) -> Result<Vec<f64>, RunError> {
        if self.precision == fullmag_ir::ExecutionPrecision::Single {
            let mut values = vec![0.0f32; cell_count];
            let rc = unsafe {
                ffi::fullmag_fdm_backend_copy_scalar_field_f32(
                    self.handle as *mut _,
                    observable,
                    values.as_mut_ptr(),
                    cell_count as u64,
                )
            };
            if rc != ffi::FULLMAG_FDM_OK {
                return Err(self.last_error_or("copy_scalar_field_f32 failed"));
            }
            Ok(values.into_iter().map(f64::from).collect())
        } else {
            let mut values = vec![0.0f64; cell_count];
            let rc = unsafe {
                ffi::fullmag_fdm_backend_copy_scalar_field_f64(
                    self.handle as *mut _,
                    observable,
                    values.as_mut_ptr(),
                    cell_count as u64,
                )
            };
            if rc != ffi::FULLMAG_FDM_OK {
                return Err(self.last_error_or("copy_scalar_field failed"));
            }
            Ok(values)
        }
    }

    /// Copy a canonical scalar quantity from device to host as f64.
    #[allow(dead_code)]
    pub fn copy_scalar_quantity(
        &self,
        quantity: &str,
        cell_count: usize,
    ) -> Result<Vec<f64>, RunError> {
        let observable =
            snapshot_observable(quantity).filter(|_| is_scalar_quantity_name(quantity));
        let observable = observable.ok_or_else(|| RunError {
            message: format!("unsupported CUDA scalar field snapshot '{quantity}'"),
        })?;
        self.copy_scalar_field(observable, cell_count)
    }

    pub fn copy_layer_field(
        &self,
        layer_index: u32,
        observable: ffi::fullmag_fdm_observable,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        let len = cell_count * 3;
        let mut flat = vec![0.0f64; len];

        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_layer_field_f64(
                self.handle as *mut _,
                layer_index,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("copy_layer_field failed"));
        }

        Ok(unpack_flat_f64(&flat))
    }

    pub fn copy_layer_field_f32(
        &self,
        layer_index: u32,
        observable: ffi::fullmag_fdm_observable,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        let len = cell_count * 3;
        let mut flat = vec![0.0f32; len];

        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_layer_field_f32(
                self.handle as *mut _,
                layer_index,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("copy_layer_field_f32 failed"));
        }

        Ok(unpack_flat_f32(&flat))
    }

    pub fn copy_m(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
            cell_count,
        )
    }

    pub fn copy_h_ex(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
            cell_count,
        )
    }

    pub fn copy_h_demag(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            cell_count,
        )
    }

    pub fn copy_h_ext(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_oe(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_OE,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_ani(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
            cell_count,
        )
    }

    pub fn copy_h_eff(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
            cell_count,
        )
    }

    pub fn copy_torque(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        let magnetization = self.copy_m(cell_count)?;
        let effective_field = self.copy_h_eff(cell_count)?;
        Ok(compute_torque_field(
            &magnetization,
            &effective_field,
            self.damping,
            self.precession_enabled,
        ))
    }

    #[allow(dead_code)]
    pub fn copy_m_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
            cell_count,
        )
    }

    pub fn copy_h_ex_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_demag_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            cell_count,
        )
    }

    pub fn copy_layer_h_demag(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            cell_count,
        )
    }

    pub fn copy_layer_m(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
            cell_count,
        )
    }

    pub fn copy_layer_h_ex(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
            cell_count,
        )
    }

    pub fn copy_layer_h_demag_f32(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_layer_field_f32(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_dmi(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DMI,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_dmi_f32(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_layer_field_f32(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DMI,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_ext(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_ext_f32(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_layer_field_f32(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_ani(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_ani_f32(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_layer_field_f32(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_eff(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_layer_field(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_layer_h_eff_f32(
        &self,
        layer_index: u32,
        cell_count: usize,
    ) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_layer_field_f32(
            layer_index,
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_ext_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_ani_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
            cell_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_eff_f32(&self, cell_count: usize) -> Result<Vec<[f32; 3]>, RunError> {
        self.copy_field_f32(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
            cell_count,
        )
    }

    pub fn begin_field_snapshot(
        &self,
        name: &str,
        step: u64,
        time: f64,
        solver_dt: f64,
    ) -> Result<NativeFdmFieldSnapshot, RunError> {
        let observable = snapshot_observable(name).ok_or_else(|| RunError {
            message: format!("unsupported CUDA field snapshot '{}'", name),
        })?;
        let handle =
            unsafe { ffi::fullmag_fdm_backend_begin_field_snapshot(self.handle, observable) };
        if handle.is_null() {
            return Err(self.last_error_or("begin_field_snapshot failed"));
        }
        Ok(NativeFdmFieldSnapshot {
            handle,
            name: name.to_string(),
            step,
            time,
            solver_dt,
            ready: None,
        })
    }

    pub fn begin_live_preview_snapshot(
        &self,
        request: &LivePreviewRequest,
        original_grid: [u32; 3],
    ) -> Result<NativeFdmPreviewSnapshot, RunError> {
        let plan = plan_grid_preview(request, original_grid);
        let quantity = normalized_quantity_name(&request.quantity)?.to_string();
        if quantity == QuantityId::FrozenSpins.as_str() {
            let values = self.frozen_mask_values()?;
            let sampled = resample_grid_scalars(&values, &plan);
            let mut data = Vec::with_capacity(sampled.len() * std::mem::size_of::<f64>());
            for value in &sampled {
                data.extend_from_slice(&value.to_ne_bytes());
            }
            return Ok(NativeFdmPreviewSnapshot {
                handle: std::ptr::null_mut(),
                request: request.clone(),
                plan,
                quantity,
                ready: Some(NativeFieldSnapshotReady {
                    data,
                    info: NativeFieldSnapshotInfo {
                        cell_count: sampled.len(),
                        component_count: 1,
                        scalar_bytes: std::mem::size_of::<f64>(),
                        scalar_type: NativeFieldSnapshotScalarType::F64,
                    },
                }),
            });
        }
        let observable = snapshot_observable(&quantity).ok_or_else(|| RunError {
            message: format!("unsupported CUDA preview snapshot '{}'", request.quantity),
        })?;
        let handle = unsafe {
            ffi::fullmag_fdm_backend_begin_preview_snapshot(
                self.handle,
                observable,
                plan.preview_grid[0],
                plan.preview_grid[1],
                plan.preview_grid[2],
                plan.z_origin,
                plan.applied_layer_stride,
            )
        };
        if handle.is_null() {
            return Err(self.last_error_or("begin_live_preview_snapshot failed"));
        }
        Ok(NativeFdmPreviewSnapshot {
            handle,
            request: request.clone(),
            plan,
            quantity,
            ready: None,
        })
    }

    pub fn copy_live_preview_field(
        &self,
        request: &LivePreviewRequest,
        original_grid: [u32; 3],
        active_mask: Option<&[bool]>,
    ) -> Result<LivePreviewField, RunError> {
        let plan = plan_grid_preview(request, original_grid);
        let quantity = normalized_quantity_name(&request.quantity)?;
        let preview_count = (plan.preview_grid[0] as usize)
            * (plan.preview_grid[1] as usize)
            * (plan.preview_grid[2] as usize);
        if preview_count == 0 {
            return Err(RunError {
                message: "copy_field_preview planned an empty preview grid".to_string(),
            });
        }

        if quantity == QuantityId::FrozenSpins.as_str() {
            return Ok(build_grid_scalar_preview_field(
                request,
                &self.frozen_mask_values()?,
                original_grid,
                active_mask,
            ));
        }

        if is_scalar_quantity_name(quantity) {
            let observable = snapshot_observable(quantity).ok_or_else(|| RunError {
                message: format!("unsupported CUDA scalar preview snapshot '{quantity}'"),
            })?;
            let values = self.copy_scalar_field(
                observable,
                (original_grid[0] as usize)
                    * (original_grid[1] as usize)
                    * (original_grid[2] as usize),
            )?;
            return Ok(build_grid_scalar_preview_field(
                request,
                &values,
                original_grid,
                active_mask,
            ));
        }

        let flat = if quantity == "torque" {
            let cell_count = (original_grid[0] as usize)
                * (original_grid[1] as usize)
                * (original_grid[2] as usize);
            let magnetization = self.copy_m(cell_count)?;
            let effective_field = self.copy_h_eff(cell_count)?;
            let torque = compute_torque_field(
                &magnetization,
                &effective_field,
                self.damping,
                self.precession_enabled,
            );
            let sampled = crate::preview::resample_grid_vectors(&torque, &plan);
            crate::preview::flatten_vectors(&sampled)
        } else {
            let observable = snapshot_observable(quantity).ok_or_else(|| RunError {
                message: format!("unsupported CUDA vector preview snapshot '{quantity}'"),
            })?;
            let len = preview_count * 3;
            if self.precision == fullmag_ir::ExecutionPrecision::Single {
                let mut flat = vec![0.0f32; len];
                let rc = unsafe {
                    ffi::fullmag_fdm_backend_copy_field_preview_f32(
                        self.handle as *mut _,
                        observable,
                        plan.preview_grid[0],
                        plan.preview_grid[1],
                        plan.preview_grid[2],
                        plan.z_origin,
                        plan.applied_layer_stride,
                        flat.as_mut_ptr(),
                        len as u64,
                    )
                };
                if rc != ffi::FULLMAG_FDM_OK {
                    return Err(self.last_error_or("copy_field_preview_f32 failed"));
                }
                flat.into_iter().map(f64::from).collect()
            } else {
                let mut flat = vec![0.0f64; len];
                let rc = unsafe {
                    ffi::fullmag_fdm_backend_copy_field_preview_f64(
                        self.handle as *mut _,
                        observable,
                        plan.preview_grid[0],
                        plan.preview_grid[1],
                        plan.preview_grid[2],
                        plan.z_origin,
                        plan.applied_layer_stride,
                        flat.as_mut_ptr(),
                        len as u64,
                    )
                };
                if rc != ffi::FULLMAG_FDM_OK {
                    return Err(self.last_error_or("copy_field_preview failed"));
                }
                flat
            }
        };
        Ok(build_grid_preview_field_from_flat_plan(
            request,
            &plan,
            flat,
            quantity,
            active_mask.map(|mask| resample_grid_mask(mask, &plan)),
        ))
    }

    fn frozen_mask_values(&self) -> Result<Vec<f64>, RunError> {
        self.frozen_mask
            .as_deref()
            .map(|mask| mask.iter().map(|frozen| f64::from(*frozen)).collect())
            .ok_or_else(|| RunError {
                message: "CUDA FDM snapshot 'frozen_spins': constraint is not active".to_string(),
            })
    }

    pub fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        let flat = flatten_vectors_f64(magnetization);
        let rc = unsafe {
            ffi::fullmag_fdm_backend_upload_magnetization_f64(
                self.handle as *mut _,
                flat.as_ptr(),
                flat.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("upload_magnetization failed"));
        }
        Ok(())
    }

    pub fn upload_magnetization_f32(&mut self, magnetization: &[[f32; 3]]) -> Result<(), RunError> {
        let flat = flatten_vectors_f32(magnetization);
        let rc = unsafe {
            ffi::fullmag_fdm_backend_upload_magnetization_f32(
                self.handle as *mut _,
                flat.as_ptr(),
                flat.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("upload_magnetization_f32 failed"));
        }
        Ok(())
    }

    pub fn upload_layer_magnetization(
        &mut self,
        layer_index: u32,
        magnetization: &[[f64; 3]],
    ) -> Result<(), RunError> {
        let flat = flatten_vectors_f64(magnetization);
        let rc = unsafe {
            ffi::fullmag_fdm_backend_upload_layer_magnetization_f64(
                self.handle as *mut _,
                layer_index,
                flat.as_ptr(),
                flat.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("upload_layer_magnetization failed"));
        }
        Ok(())
    }

    pub fn upload_layer_magnetization_f32(
        &mut self,
        layer_index: u32,
        magnetization: &[[f32; 3]],
    ) -> Result<(), RunError> {
        let flat = flatten_vectors_f32(magnetization);
        let rc = unsafe {
            ffi::fullmag_fdm_backend_upload_layer_magnetization_f32(
                self.handle as *mut _,
                layer_index,
                flat.as_ptr(),
                flat.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("upload_layer_magnetization_f32 failed"));
        }
        Ok(())
    }

    pub fn refresh_multilayer_demag(&mut self) -> Result<(), RunError> {
        let rc = unsafe { ffi::fullmag_fdm_backend_refresh_multilayer_demag(self.handle) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("refresh_multilayer_demag failed"));
        }
        Ok(())
    }

    pub fn snapshot_multilayer_demag_stage_telemetry(
        &mut self,
        layer_count: u64,
    ) -> Result<FdmMultilayerStageTelemetry, RunError> {
        let mut stats = ffi::fullmag_fdm_step_stats {
            step: 0,
            time_seconds: 0.0,
            dt_seconds: 0.0,
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            anisotropy_energy_joules: 0.0,
            cubic_energy_joules: 0.0,
            dmi_energy_joules: 0.0,
            total_energy_joules: 0.0,
            max_effective_field_amplitude: 0.0,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude: 0.0,
            max_torque_Apm: 0.0,
            suggested_next_dt: 0.0,
            wall_time_ns: 0,
            hot_loop_d2h_bytes: 0,
            hot_loop_host_sync_count: 0,
            hot_loop_control_scalar_d2h_bytes: 0,
            hot_loop_control_scalar_host_sync_count: 0,
            multilayer_refresh_count: 0,
            multilayer_forward_fft_count: 0,
            multilayer_inverse_fft_count: 0,
            multilayer_pair_accumulation_count: 0,
        };
        let rc =
            unsafe { ffi::fullmag_fdm_backend_snapshot_stats(self.handle as *mut _, &mut stats) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("snapshot multilayer demag telemetry failed"));
        }
        validate_multilayer_stage_telemetry(
            layer_count,
            stats.multilayer_refresh_count,
            stats.multilayer_forward_fft_count,
            stats.multilayer_inverse_fft_count,
            stats.multilayer_pair_accumulation_count,
        )
    }

    pub fn refresh_observables(&mut self) -> Result<(), RunError> {
        let rc = unsafe { ffi::fullmag_fdm_backend_refresh_observables(self.handle as *mut _) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("refresh_observables failed"));
        }
        Ok(())
    }

    pub(crate) fn endpoint_cache_telemetry(&self) -> Result<EndpointCacheTelemetry, RunError> {
        let mut telemetry = ffi::fullmag_fdm_endpoint_cache_telemetry_v1 {
            abi_version: ffi::FULLMAG_FDM_ENDPOINT_CACHE_TELEMETRY_ABI_V1,
            struct_size: std::mem::size_of::<ffi::fullmag_fdm_endpoint_cache_telemetry_v1>() as u32,
            cache_identity_valid: 0,
            stats_valid: 0,
            accepted_state_revision: 0,
            accepted_time_bits: 0,
            source_revision: 0,
            field_revision: 0,
            transport_revision: 0,
            projection_policy_identity: 0,
            valid_field_mask: 0,
            refresh_request_count: 0,
            refresh_execution_count: 0,
            refresh_cache_hit_count: 0,
            invalidation_count: 0,
            stats_snapshot_request_count: 0,
            stats_snapshot_cache_hit_count: 0,
            field_snapshot_request_count: 0,
            field_snapshot_latency_total_ns: 0,
            field_snapshot_latency_max_ns: 0,
            exchange_evaluation_count: 0,
            demag_evaluation_count: 0,
            demag_forward_fft_count: 0,
            demag_inverse_fft_count: 0,
            effective_field_evaluation_count: 0,
            energy_reduction_count: 0,
            last_step_exchange_evaluation_count: 0,
            last_step_demag_evaluation_count: 0,
            last_step_demag_forward_fft_count: 0,
            last_step_demag_inverse_fft_count: 0,
            last_step_effective_field_evaluation_count: 0,
            last_step_energy_reduction_count: 0,
        };
        let rc = unsafe {
            ffi::fullmag_fdm_backend_get_endpoint_cache_telemetry_v1(self.handle, &mut telemetry)
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("endpoint cache telemetry query failed"));
        }
        Ok(EndpointCacheTelemetry {
            cache_identity_valid: telemetry.cache_identity_valid != 0,
            stats_valid: telemetry.stats_valid != 0,
            accepted_state_revision: telemetry.accepted_state_revision,
            valid_field_mask: telemetry.valid_field_mask,
            refresh_request_count: telemetry.refresh_request_count,
            refresh_execution_count: telemetry.refresh_execution_count,
            refresh_cache_hit_count: telemetry.refresh_cache_hit_count,
            invalidation_count: telemetry.invalidation_count,
            stats_snapshot_request_count: telemetry.stats_snapshot_request_count,
            stats_snapshot_cache_hit_count: telemetry.stats_snapshot_cache_hit_count,
            field_snapshot_request_count: telemetry.field_snapshot_request_count,
            field_snapshot_latency_total_ns: telemetry.field_snapshot_latency_total_ns,
            field_snapshot_latency_max_ns: telemetry.field_snapshot_latency_max_ns,
            exchange_evaluation_count: telemetry.exchange_evaluation_count,
            demag_evaluation_count: telemetry.demag_evaluation_count,
            demag_forward_fft_count: telemetry.demag_forward_fft_count,
            demag_inverse_fft_count: telemetry.demag_inverse_fft_count,
            effective_field_evaluation_count: telemetry.effective_field_evaluation_count,
            energy_reduction_count: telemetry.energy_reduction_count,
            last_step_exchange_evaluation_count: telemetry.last_step_exchange_evaluation_count,
            last_step_demag_evaluation_count: telemetry.last_step_demag_evaluation_count,
            last_step_demag_forward_fft_count: telemetry.last_step_demag_forward_fft_count,
            last_step_demag_inverse_fft_count: telemetry.last_step_demag_inverse_fft_count,
            last_step_effective_field_evaluation_count: telemetry
                .last_step_effective_field_evaluation_count,
            last_step_energy_reduction_count: telemetry.last_step_energy_reduction_count,
        })
    }

    pub fn snapshot_step_stats(&mut self, grid: [u32; 3]) -> Result<StepStats, RunError> {
        let mut stats = ffi::fullmag_fdm_step_stats {
            step: 0,
            time_seconds: 0.0,
            dt_seconds: 0.0,
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            anisotropy_energy_joules: 0.0,
            cubic_energy_joules: 0.0,
            dmi_energy_joules: 0.0,
            total_energy_joules: 0.0,
            max_effective_field_amplitude: 0.0,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude: 0.0,
            max_torque_Apm: 0.0,
            suggested_next_dt: 0.0,
            wall_time_ns: 0,
            hot_loop_d2h_bytes: 0,
            hot_loop_host_sync_count: 0,
            hot_loop_control_scalar_d2h_bytes: 0,
            hot_loop_control_scalar_host_sync_count: 0,
            multilayer_refresh_count: 0,
            multilayer_forward_fft_count: 0,
            multilayer_inverse_fft_count: 0,
            multilayer_pair_accumulation_count: 0,
        };

        let rc =
            unsafe { ffi::fullmag_fdm_backend_snapshot_stats(self.handle as *mut _, &mut stats) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("snapshot_step_stats failed"));
        }

        let cell_count = (grid[0] as usize) * (grid[1] as usize) * (grid[2] as usize);
        let magnetization = self.copy_m(cell_count)?;
        let native_metrics =
            validate_native_step_metrics(stats.max_torque_Apm, stats.max_rhs_amplitude)?;
        let mut step_stats = StepStats {
            step: stats.step,
            time: stats.time_seconds,
            dt: stats.dt_seconds,
            e_ex: stats.exchange_energy_joules,
            e_demag: stats.demag_energy_joules,
            e_ext: stats.external_energy_joules,
            e_ani: stats.anisotropy_energy_joules + stats.cubic_energy_joules,
            e_dmi: stats.dmi_energy_joules,
            e_total: stats.total_energy_joules,
            max_dm_dt: native_metrics.max_rhs_norm_per_s,
            max_rhs_norm_per_s: native_metrics.max_rhs_norm_per_s,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            max_torque_Apm: native_metrics.max_torque_apm,
            max_torque_T: native_metrics.max_torque_apm * crate::MU0,
            wall_time_ns: stats.wall_time_ns,
            hot_loop_d2h_bytes: stats.hot_loop_d2h_bytes,
            hot_loop_host_sync_count: stats.hot_loop_host_sync_count,
            hot_loop_control_scalar_d2h_bytes: stats.hot_loop_control_scalar_d2h_bytes,
            hot_loop_control_scalar_host_sync_count: stats.hot_loop_control_scalar_host_sync_count,
            ..StepStats::default()
        };
        crate::scalar_metrics::apply_average_m_to_step_stats_with_active_mask(
            &mut step_stats,
            &magnetization,
            self.active_mask.as_deref(),
        );
        step_stats.per_object_scalars = single_object_scalars("free", &step_stats);
        Ok(step_stats)
    }

    fn last_error_or(&self, fallback: &str) -> RunError {
        let err = unsafe { ffi::fullmag_fdm_backend_last_error(self.handle as *mut _) };
        let msg = if err.is_null() {
            fallback.to_string()
        } else {
            unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string()
        };
        RunError { message: msg }
    }
}

#[cfg(feature = "cuda")]
impl Drop for NativeFdmBackend {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            if self.gpu_transport_bound {
                let _ = unsafe {
                    fullmag_fdm_sys::gpu_transport_abi_v1::fullmag_fdm_context_unbind_gpu_transport_v1(
                        self.handle,
                    )
                };
                self.gpu_transport_bound = false;
            }
            unsafe { ffi::fullmag_fdm_backend_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

#[cfg(feature = "cuda")]
impl NativeFdmFieldSnapshot {
    fn ensure_ready(&mut self) -> Result<&NativeFieldSnapshotReady, RunError> {
        if self.ready.is_none() {
            let mut data = std::ptr::null();
            let mut len_bytes = 0u64;
            let mut desc = ffi::fullmag_fdm_snapshot_desc {
                cell_count: 0,
                component_count: 0,
                scalar_bytes: 0,
                scalar_type: ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F64,
            };
            let rc = unsafe {
                ffi::fullmag_fdm_field_snapshot_wait(
                    self.handle,
                    &mut data,
                    &mut len_bytes,
                    &mut desc,
                )
            };
            if rc != ffi::FULLMAG_FDM_OK {
                return Err(RunError {
                    message: format!("waiting for CUDA field snapshot '{}' failed", self.name),
                });
            }
            let scalar_type = match desc.scalar_type {
                ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F32 => {
                    NativeFieldSnapshotScalarType::F32
                }
                ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F64 => {
                    NativeFieldSnapshotScalarType::F64
                }
            };
            let len = len_bytes as usize;
            if data.is_null() {
                return Err(RunError {
                    message: format!(
                        "CUDA field snapshot '{}' returned a null payload",
                        self.name
                    ),
                });
            }
            let info = NativeFieldSnapshotInfo {
                cell_count: desc.cell_count as usize,
                component_count: desc.component_count as usize,
                scalar_bytes: desc.scalar_bytes as usize,
                scalar_type,
            };
            validate_native_snapshot_payload(&self.name, info, len)?;
            // SAFETY: `data` points to a CUDA-managed buffer valid until the
            // handle is destroyed.  We copy immediately into an owned Vec so
            // the raw pointer does not escape this block.
            let owned = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }.to_vec();
            self.ready = Some(NativeFieldSnapshotReady { data: owned, info });
        }
        Ok(self.ready.as_ref().expect("snapshot ready cached"))
    }

    pub(crate) fn info(&mut self) -> Result<NativeFieldSnapshotInfo, RunError> {
        Ok(self.ensure_ready()?.info)
    }

    pub(crate) fn write_payload(
        &mut self,
        writer: &mut impl Write,
    ) -> Result<NativeFieldSnapshotInfo, RunError> {
        let snapshot_name = self.name.clone();
        let ready = self.ensure_ready()?;
        writer.write_all(&ready.data).map_err(|error| RunError {
            message: format!(
                "failed to write CUDA field snapshot payload for '{}': {}",
                snapshot_name, error
            ),
        })?;
        Ok(ready.info)
    }
}

#[cfg(feature = "cuda")]
impl NativeFdmPreviewSnapshot {
    fn ensure_ready(&mut self) -> Result<&NativeFieldSnapshotReady, RunError> {
        if self.ready.is_none() {
            let mut data = std::ptr::null();
            let mut len_bytes = 0u64;
            let mut desc = ffi::fullmag_fdm_snapshot_desc {
                cell_count: 0,
                component_count: 0,
                scalar_bytes: 0,
                scalar_type: ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F64,
            };
            let rc = unsafe {
                ffi::fullmag_fdm_preview_snapshot_wait(
                    self.handle,
                    &mut data,
                    &mut len_bytes,
                    &mut desc,
                )
            };
            if rc != ffi::FULLMAG_FDM_OK {
                return Err(RunError {
                    message: format!(
                        "waiting for CUDA preview snapshot '{}' failed",
                        self.quantity
                    ),
                });
            }
            let scalar_type = match desc.scalar_type {
                ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F32 => {
                    NativeFieldSnapshotScalarType::F32
                }
                ffi::fullmag_fdm_snapshot_scalar_type::FULLMAG_FDM_SNAPSHOT_SCALAR_F64 => {
                    NativeFieldSnapshotScalarType::F64
                }
            };
            if data.is_null() {
                return Err(RunError {
                    message: format!(
                        "CUDA preview snapshot '{}' returned a null payload",
                        self.quantity
                    ),
                });
            }
            let info = NativeFieldSnapshotInfo {
                cell_count: desc.cell_count as usize,
                component_count: desc.component_count as usize,
                scalar_bytes: desc.scalar_bytes as usize,
                scalar_type,
            };
            validate_native_snapshot_payload(&self.quantity, info, len_bytes as usize)?;
            self.ready = Some(NativeFieldSnapshotReady {
                // SAFETY: `data` is valid until the handle is destroyed.
                // We copy immediately so the raw pointer does not escape.
                data: unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len_bytes as usize) }
                    .to_vec(),
                info,
            });
        }
        Ok(self.ready.as_ref().expect("preview snapshot ready cached"))
    }

    pub fn into_live_preview_field(
        mut self,
        active_mask: Option<&[bool]>,
    ) -> Result<LivePreviewField, RunError> {
        let ready = self.ensure_ready()?;
        let expected_len = ready.info.cell_count * ready.info.component_count;
        let vector_field_values: Vec<f64> = match ready.info.scalar_type {
            NativeFieldSnapshotScalarType::F32 => ready
                .data
                .chunks_exact(std::mem::size_of::<f32>())
                .map(|b| f64::from(f32::from_ne_bytes(b.try_into().unwrap())))
                .collect(),
            NativeFieldSnapshotScalarType::F64 => ready
                .data
                .chunks_exact(std::mem::size_of::<f64>())
                .map(|b| f64::from_ne_bytes(b.try_into().unwrap()))
                .collect(),
        };
        debug_assert_eq!(vector_field_values.len(), expected_len);
        Ok(build_grid_preview_field_from_flat_plan(
            &self.request,
            &self.plan,
            vector_field_values,
            &self.quantity,
            active_mask.map(|mask| resample_grid_mask(mask, &self.plan)),
        ))
    }
}

#[cfg(feature = "cuda")]
impl Drop for NativeFdmFieldSnapshot {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::fullmag_fdm_field_snapshot_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

#[cfg(feature = "cuda")]
impl Drop for NativeFdmPreviewSnapshot {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::fullmag_fdm_preview_snapshot_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

#[cfg(feature = "cuda")]
fn ffi_grid(cells: [u32; 3], cell_size: [f64; 3]) -> ffi::fullmag_fdm_grid_desc {
    ffi::fullmag_fdm_grid_desc {
        nx: cells[0],
        ny: cells[1],
        nz: cells[2],
        dx: cell_size[0],
        dy: cell_size[1],
        dz: cell_size[2],
    }
}

#[cfg(feature = "cuda")]
fn ffi_complex64_vec(values: &[num_complex::Complex<f64>]) -> Vec<ffi::fullmag_fdm_complex64> {
    values
        .iter()
        .map(|value| ffi::fullmag_fdm_complex64 {
            re: value.re,
            im: value.im,
        })
        .collect()
}

#[cfg(feature = "cuda")]
fn unpack_flat_f64(flat: &[f64]) -> Vec<[f64; 3]> {
    flat.chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect()
}

#[cfg(feature = "cuda")]
fn unpack_flat_f32(flat: &[f32]) -> Vec<[f32; 3]> {
    flat.chunks_exact(3)
        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
        .collect()
}

#[cfg(feature = "cuda")]
fn flatten_vectors_f64(vectors: &[[f64; 3]]) -> Vec<f64> {
    vectors
        .iter()
        .flat_map(|vector| vector.iter().copied())
        .collect()
}

#[cfg(feature = "cuda")]
fn flatten_vectors_f32(vectors: &[[f32; 3]]) -> Vec<f32> {
    vectors
        .iter()
        .flat_map(|vector| vector.iter().copied())
        .collect()
}

#[cfg(feature = "cuda")]
fn snapshot_observable(name: &str) -> Option<ffi::fullmag_fdm_observable> {
    let id = crate::quantities::normalize_quantity_id(name).ok()?;
    Some(match CudaSnapshotObservable::from_quantity(id)? {
        CudaSnapshotObservable::M => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
        CudaSnapshotObservable::HEx => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
        CudaSnapshotObservable::HDemag => {
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG
        }
        CudaSnapshotObservable::HExt => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
        CudaSnapshotObservable::HOe => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_OE,
        CudaSnapshotObservable::HAni => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
        CudaSnapshotObservable::HEff => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
        CudaSnapshotObservable::EdenEx => {
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_EX
        }
        CudaSnapshotObservable::EdenDemag => {
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_DEMAG
        }
        CudaSnapshotObservable::EdenExt => {
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_EXT
        }
        CudaSnapshotObservable::EdenDrive => {
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_DRIVE
        }
        CudaSnapshotObservable::EdenAni => {
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_ANI
        }
        CudaSnapshotObservable::EdenDmi => {
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_DMI
        }
        CudaSnapshotObservable::EdenTotal => {
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL
        }
    })
}

#[cfg(feature = "cuda")]
fn is_scalar_quantity_name(name: &str) -> bool {
    crate::quantities::normalize_quantity_id(name)
        .ok()
        .is_some_and(|id| {
            id == QuantityId::FrozenSpins
                || CudaSnapshotObservable::from_quantity(id)
                    .is_some_and(CudaSnapshotObservable::is_scalar)
        })
}

#[cfg(feature = "cuda")]
fn validate_native_snapshot_payload(
    quantity: &str,
    info: NativeFieldSnapshotInfo,
    len_bytes: usize,
) -> Result<(), RunError> {
    let expected_components = if is_scalar_quantity_name(quantity) {
        1
    } else {
        3
    };
    if info.component_count != expected_components {
        return Err(RunError {
            message: format!(
                "CUDA snapshot '{quantity}' component_count={} does not match expected {expected_components}",
                info.component_count
            ),
        });
    }
    let expected_scalar_bytes = match info.scalar_type {
        NativeFieldSnapshotScalarType::F32 => std::mem::size_of::<f32>(),
        NativeFieldSnapshotScalarType::F64 => std::mem::size_of::<f64>(),
    };
    if info.scalar_bytes != expected_scalar_bytes {
        return Err(RunError {
            message: format!(
                "CUDA snapshot '{quantity}' scalar_bytes={} does not match scalar type ({expected_scalar_bytes})",
                info.scalar_bytes
            ),
        });
    }
    let expected_len = info
        .cell_count
        .checked_mul(info.component_count)
        .and_then(|count| count.checked_mul(info.scalar_bytes))
        .ok_or_else(|| RunError {
            message: format!("CUDA snapshot '{quantity}' payload length overflows usize"),
        })?;
    if len_bytes != expected_len {
        return Err(RunError {
            message: format!(
                "CUDA snapshot '{quantity}' payload length {len_bytes} does not match expected {expected_len} bytes"
            ),
        });
    }
    Ok(())
}

#[cfg(feature = "cuda")]
fn build_region_exchange_pairs(
    plan: &fullmag_ir::FdmPlanIR,
    has_region_mask: bool,
) -> Result<Option<Vec<ffi::fullmag_fdm_exchange_pair_desc>>, RunError> {
    if !has_region_mask {
        if plan.inter_region_exchange.is_empty() {
            return Ok(None);
        }
        return Err(RunError {
            message:
                "inter_region_exchange overrides require a region_mask; refusing to drop exchange pair intent"
                    .to_string(),
        });
    }
    Ok(Some(
        plan.inter_region_exchange
            .iter()
            .map(|&(region_i, region_j, inter_exchange)| {
                if !inter_exchange.is_finite() || inter_exchange < 0.0 {
                    return Err(RunError {
                        message: format!(
                            "inter_region_exchange ({region_i}, {region_j}) must be finite and >= 0"
                        ),
                    });
                }
                Ok(ffi::fullmag_fdm_exchange_pair_desc {
                    region_i,
                    region_j,
                    mode: ffi::fullmag_fdm_exchange_pair_mode::FULLMAG_FDM_EXCHANGE_PAIR_EXPLICIT,
                    scale: 1.0,
                    inter_exchange,
                })
            })
            .collect::<Result<Vec<_>, RunError>>()?,
    ))
}

#[cfg(test)]
fn canonical_frozen_spins_cpu_gpu_parity_plan() -> fullmag_ir::FdmPlanIR {
    use std::collections::BTreeMap;

    use fullmag_ir::{
        ConstraintActivationIR, EmptySelectionPolicyIR, ExchangeBoundaryCondition,
        ExecutionPrecision, FdmGridCertificateIR, FdmMaterialIR, FrozenReferencePolicyIR,
        FrozenSpinsIR, GridDimensions, InactiveSelectionPolicyIR, IntegratorChoice,
        SelectionExprIR, SelectionMembershipPolicyIR, SelectionValidationContext,
        FROZEN_SPINS_SCHEMA_VERSION,
    };
    use fullmag_plan::{
        compile_fdm_frozen_spins, FdmFrozenSpinsDomain, FrozenSpinsCompileRequest,
        ResolvedFrozenSpinsReference, SelectionDofMembership,
    };

    let origin_m = [0.0, 0.0, 0.0];
    let grid_cells = [3, 3, 1];
    let cell_size = [5e-9, 5e-9, 10e-9];
    let active_mask = vec![true, true, true, true, false, true, true, true, false];
    let frozen_mask = vec![true, false, false, true, false, false, true, false, false];
    let region_mask = vec![0; 9];
    let initial_magnetization = vec![
        [1.0, 0.0, 0.0],
        [0.9950041652780258, 0.09983341664682815, 0.0],
        [0.9800665778412416, 0.19866933079506122, 0.0],
        // Every canonical parity vector is exactly unit-length in binary64.
        // The CPU reference normalizes at state construction; keeping the
        // fixture on the unit sphere makes the native frozen reference and
        // the captured CPU activation reference the same contract.
        [0.8, 0.0, 0.6],
        [0.6, 0.8, 0.0],
        [0.48, 0.64, 0.6],
        [0.8, -0.6, 0.0],
        [0.28, 0.96, 0.0],
        [0.36, 0.48, 0.8],
    ];
    let active_count = active_mask.iter().filter(|active| **active).count() as u64;
    let grid_certificate = FdmGridCertificateIR::new_with_masks(
        origin_m,
        grid_cells,
        cell_size,
        active_count,
        9 * fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
        Some(&active_mask),
        &region_mask,
    )
    .expect("canonical parity FDM grid certificate");

    let memberships = (0..initial_magnetization.len())
        .map(|index| SelectionDofMembership {
            object_ids: vec!["parity-magnet".to_string()],
            region_ids: frozen_mask[index]
                .then(|| ("parity-magnet".to_string(), "frozen-column".to_string()))
                .into_iter()
                .collect(),
        })
        .collect::<Vec<_>>();
    let constraints = [FrozenSpinsIR {
        schema_version: FROZEN_SPINS_SCHEMA_VERSION.to_string(),
        id: "cpu-gpu-parity".to_string(),
        name: "CPU/GPU parity frozen column".to_string(),
        enabled: true,
        selector: SelectionExprIR::InRegion {
            object_id: "parity-magnet".to_string(),
            region_id: "frozen-column".to_string(),
        },
        reference: FrozenReferencePolicyIR::CaptureCurrentAtActivation {},
        membership: SelectionMembershipPolicyIR::Static {},
        activation: ConstraintActivationIR::AllStages {},
        empty_selection: EmptySelectionPolicyIR::Error,
        inactive_selection: InactiveSelectionPolicyIR::Error,
    }];
    let references = [ResolvedFrozenSpinsReference {
        constraint_id: "cpu-gpu-parity",
        values: &initial_magnetization,
        source_state_revision: Some(1),
        topology_fingerprint: &grid_certificate.grid_fingerprint,
    }];
    let object_transforms = BTreeMap::new();
    let known_entities =
        SelectionValidationContext::new(["parity-magnet"], [("parity-magnet", "frozen-column")]);
    let resolved = compile_fdm_frozen_spins(
        &FdmFrozenSpinsDomain {
            origin_m,
            counts: grid_cells,
            cell_m: cell_size,
            active_mask: &active_mask,
            memberships: &memberships,
            grid_fingerprint: &grid_certificate.grid_fingerprint,
        },
        &FrozenSpinsCompileRequest {
            constraints: &constraints,
            selections: &[],
            activation_stage_id: None,
            object_transforms: &object_transforms,
            known_entities: &known_entities,
            state_snapshot: None,
            resolved_references: &references,
            expected_source_state_revision: Some(1),
            expected_grid_or_mesh_fingerprint: &grid_certificate.grid_fingerprint,
        },
    )
    .expect("compile canonical Frozen Spins parity carrier through fullmag-plan");
    assert_eq!(resolved.frozen_mask, frozen_mask);
    resolved
        .validate_intrinsic()
        .expect("canonical Frozen Spins carrier intrinsic validation");
    resolved
        .validate_against_active_mask(&active_mask)
        .expect("canonical Frozen Spins carrier active-domain validation");

    let mut plan = fullmag_ir::FdmPlanIR::default();
    plan.origin_m = origin_m;
    plan.grid = GridDimensions { cells: grid_cells };
    plan.cell_size = cell_size;
    plan.grid_certificate = Some(grid_certificate);
    plan.region_mask = region_mask;
    plan.active_mask = Some(active_mask);
    plan.initial_magnetization = initial_magnetization;
    plan.material = FdmMaterialIR {
        name: "Py".to_string(),
        saturation_magnetisation: 800e3,
        exchange_stiffness: 13e-12,
        damping: 0.1,
        ..Default::default()
    };
    plan.gyromagnetic_ratio = 2.211e5;
    plan.precision = ExecutionPrecision::Double;
    plan.precision_policy = fullmag_ir::FdmPrecisionPolicyIR::resolve(plan.precision);
    plan.exchange_bc = ExchangeBoundaryCondition::Neumann;
    plan.integrator = Some(IntegratorChoice::Heun);
    plan.fixed_timestep = Some(2.5e-13);
    plan.enable_exchange = true;
    plan.enable_demag = false;
    plan.external_field = Some([1.5e3, -2.0e3, 7.5e2]);
    plan.frozen_spins = Some(resolved);
    plan
}

#[cfg(test)]
mod frozen_spins_native_boundary_tests {
    use super::*;

    #[test]
    fn malformed_frozen_spins_plan_is_rejected_before_cuda_ffi_boundary() {
        let mut plan = canonical_frozen_spins_cpu_gpu_parity_plan();
        plan.frozen_spins
            .as_mut()
            .expect("canonical carrier")
            .mask_sha256 = "0".repeat(64);

        let error = validate_native_frozen_spins_plan(&plan)
            .expect_err("tampered dense mask must fail before CUDA FFI");
        assert!(error.message.contains("rejected before CUDA device probe"));
        assert!(error.message.contains("mask hash"));
    }

    #[test]
    fn intrinsically_consistent_frozen_spin_outside_active_domain_is_rejected_before_cuda_ffi() {
        use sha2::{Digest, Sha256};

        let mut plan = canonical_frozen_spins_cpu_gpu_parity_plan();
        let resolved = plan.frozen_spins.as_mut().expect("canonical carrier");
        resolved.frozen_mask[4] = true;
        let mut hash = Sha256::new();
        hash.update((resolved.frozen_mask.len() as u64).to_le_bytes());
        hash.update(
            resolved
                .frozen_mask
                .iter()
                .map(|value| u8::from(*value))
                .collect::<Vec<_>>(),
        );
        let mask_sha256 = format!("{:x}", hash.finalize());
        resolved.frozen_dof_count = 4;
        resolved.free_dof_count = 3;
        resolved.mask_sha256 = mask_sha256.clone();
        resolved.certificate.raw_candidate_dof_count = 4;
        resolved.certificate.frozen_dof_count = 4;
        resolved.certificate.free_dof_count = 3;
        resolved.certificate.mask_sha256 = mask_sha256;
        resolved
            .validate_intrinsic()
            .expect("fixture must pass intrinsic validation before active-domain validation");

        let error = validate_native_frozen_spins_plan(&plan)
            .expect_err("frozen inactive DOF must fail before CUDA FFI");
        assert!(error.message.contains("rejected before CUDA device probe"));
        assert!(error.message.contains("outside_active_domain"));
    }

    #[test]
    fn frozen_spins_plan_without_grid_certificate_is_rejected_before_cuda_ffi() {
        let mut plan = canonical_frozen_spins_cpu_gpu_parity_plan();
        plan.grid_certificate = None;

        let error = validate_native_frozen_spins_plan(&plan)
            .expect_err("native boundary must require a topology certificate in every build");
        assert!(error.message.contains("authoritative FDM grid certificate"));
        assert!(error.message.contains("before CUDA device probe"));
    }
}

#[cfg(all(test, feature = "cuda"))]
mod tests {
    use super::*;
    use crate::preview::build_grid_preview_field;
    use crate::types::LivePreviewRequest;
    use fullmag_engine::{
        CellSize, CubicAnisotropyConfig, EffectiveFieldTerms, ExchangeLlgProblem, LlgConfig,
        MaterialParameters, TimeIntegrator, UniaxialAnisotropyConfig,
    };

    #[test]
    fn copy_adaptive_attempt_summary_validates_one_accepted_batch() {
        let record = ffi::fullmag_fdm_adaptive_attempt_v1 {
            abi_version: ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_ABI_V1,
            struct_size: std::mem::size_of::<ffi::fullmag_fdm_adaptive_attempt_v1>() as u32,
            attempt_index: 0,
            decision: ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_ACCEPTED,
            reason: ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_WITHIN_TOLERANCE,
            reserved0: 0,
            dt_attempt_seconds: 1e-15,
            normalized_error: 0.25,
            ratio: 1.5,
            dt_next_seconds: 1.5e-15,
        };
        assert_eq!(
            validate_adaptive_attempt_batch(&[record]).unwrap(),
            (0, 0.25)
        );
    }

    #[test]
    fn copy_adaptive_attempt_summary_rejects_nonterminal_batch() {
        let record = ffi::fullmag_fdm_adaptive_attempt_v1 {
            abi_version: ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_ABI_V1,
            struct_size: std::mem::size_of::<ffi::fullmag_fdm_adaptive_attempt_v1>() as u32,
            attempt_index: 0,
            decision: ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_RETRY,
            reason: ffi::FULLMAG_FDM_ADAPTIVE_ATTEMPT_ERROR_ABOVE_TOLERANCE,
            reserved0: 0,
            dt_attempt_seconds: 1e-15,
            normalized_error: 2.0,
            ratio: 0.5,
            dt_next_seconds: 5e-16,
        };
        assert!(validate_adaptive_attempt_batch(&[record]).is_err());
    }

    #[test]
    fn native_fdm_frozen_spins_capability_gate_accepts_advertised_single_grid_lane() {
        ensure_cuda_frozen_spins_supported(false, 0)
            .expect("the legacy null-mask path must remain available");
        let error = ensure_cuda_frozen_spins_supported(true, 0)
            .expect_err("an unadvertised frozen-spin request must fail closed");
        assert!(error.message.contains("frozen_spins_cuda_unqualified"));
        ensure_cuda_frozen_spins_supported(true, ffi::FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1)
            .expect("the versioned capability bit admits the single-grid ABI payload");
    }

    #[test]
    fn frozen_spins_preview_uses_retained_plan_mask_without_cuda_snapshot() {
        let backend = NativeFdmBackend {
            handle: std::ptr::null_mut(),
            cell_count: 4,
            active_mask: None,
            frozen_mask: Some(vec![true, false, false, true]),
            precision: ExecutionPrecision::Double,
            precision_policy: fullmag_ir::FdmPrecisionPolicyIR::default(),
            damping: 0.01,
            precession_enabled: true,
            gpu_transport_bound: false,
            adaptive_timestep_enabled: false,
            stats_policy: NativeStatsPolicy::full(1),
        };
        let request = LivePreviewRequest {
            quantity: "frozen_spins".to_string(),
            auto_scale_enabled: false,
            ..Default::default()
        };

        let sync = backend
            .copy_live_preview_field(&request, [2, 2, 1], None)
            .expect("synchronous Frozen Spins preview");
        let asynchronous = backend
            .begin_live_preview_snapshot(&request, [2, 2, 1])
            .expect("begin host-backed Frozen Spins preview")
            .into_live_preview_field(None)
            .expect("collect host-backed Frozen Spins preview");

        assert_eq!(sync.quantity, "frozen_spins");
        assert_eq!(sync.unit, "1");
        assert_eq!(sync.vector_field_values, vec![1.0, 0.0, 0.0, 1.0]);
        assert_eq!(asynchronous, sync);
        assert!(can_materialize_preview_quantity(QuantityId::FrozenSpins));
    }

    #[test]
    fn prescribed_sot_formula_mapping_preserves_legacy_and_selects_v1_explicitly() {
        let mut plan = fullmag_ir::FdmPlanIR::default();
        assert_eq!(
            ffi_prescribed_sot_formula(&plan).unwrap(),
            ffi::fullmag_fdm_prescribed_sot_formula::FULLMAG_FDM_PRESCRIBED_SOT_LEGACY_V0
        );

        plan.sot_formula_version = Some("prescribed_sot.legacy_fullmag.v0".to_string());
        assert_eq!(
            ffi_prescribed_sot_formula(&plan).unwrap(),
            ffi::fullmag_fdm_prescribed_sot_formula::FULLMAG_FDM_PRESCRIBED_SOT_LEGACY_V0
        );

        plan.sot_formula_version = Some("prescribed_sot.fullmag.v1".to_string());
        assert_eq!(
            ffi_prescribed_sot_formula(&plan).unwrap(),
            ffi::fullmag_fdm_prescribed_sot_formula::FULLMAG_FDM_PRESCRIBED_SOT_V1
        );

        plan.sot_formula_version = Some("prescribed_sot.unknown".to_string());
        assert!(ffi_prescribed_sot_formula(&plan).is_err());
    }
    use fullmag_ir::{
        AxisBoundary, ExchangeBoundaryCondition, ExecutionPrecision, FdmDemagPeriodicityIR,
        FdmMaterialIR, FdmPeriodicityIR, FdmPlanIR, GridDimensions, IntegratorChoice,
        RelaxationAlgorithmIR, RelaxationControlIR,
    };

    #[test]
    fn native_fdm_snapshot_observable_accepts_anisotropy_field() {
        assert!(
            snapshot_observable("H_ani").is_some(),
            "native CUDA FDM must expose H_ani as a first-class observable"
        );
        assert!(
            snapshot_observable("H_ANI").is_some(),
            "native CUDA FDM must accept ABI-style H_ANI snapshot names"
        );
    }

    #[test]
    fn native_fdm_snapshot_observable_accepts_all_scalar_energy_densities() {
        let scalar_observables = [
            (
                "eden_ex",
                ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_EX,
            ),
            (
                "eden_demag",
                ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_DEMAG,
            ),
            (
                "eden_ext",
                ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_EXT,
            ),
            (
                "eden_drive",
                ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_DRIVE,
            ),
            (
                "eden_ani",
                ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_ANI,
            ),
            (
                "eden_dmi",
                ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_DMI,
            ),
            (
                "eden_total",
                ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL,
            ),
        ];

        for (name, expected) in scalar_observables {
            assert_eq!(snapshot_observable(name), Some(expected), "{name}");
            assert!(is_scalar_quantity_name(name), "{name} must be scalar");
        }
        assert!(snapshot_observable("not_a_quantity").is_none());
        assert!(!is_scalar_quantity_name("not_a_quantity"));
    }

    #[test]
    fn native_fdm_snapshot_descriptor_requires_quantity_shape_and_exact_payload() {
        let info = NativeFieldSnapshotInfo {
            cell_count: 4,
            component_count: 1,
            scalar_bytes: 8,
            scalar_type: NativeFieldSnapshotScalarType::F64,
        };
        validate_native_snapshot_payload("eden_total", info, 32)
            .expect("scalar snapshot descriptor should be accepted");

        let error = validate_native_snapshot_payload("eden_total", info, 96)
            .expect_err("scalar payload with vector byte length must fail closed");
        assert!(error.message.contains("payload length"));

        let error = validate_native_snapshot_payload(
            "H_demag",
            NativeFieldSnapshotInfo {
                component_count: 1,
                ..info
            },
            32,
        )
        .expect_err("vector quantity must not accept scalar descriptor");
        assert!(error.message.contains("component_count"));
    }

    #[test]
    fn native_fdm_region_exchange_pairs_leave_default_to_backend() {
        let mut plan = make_relaxation_precession_test_plan();
        plan.region_mask = vec![1, 2];
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        plan.grid = GridDimensions { cells: [2, 1, 1] };
        let pairs = build_region_exchange_pairs(&plan, true)
            .expect("region exchange pairs")
            .expect("region mask should produce pair list");
        assert!(pairs.is_empty());
    }

    #[test]
    fn native_fdm_region_exchange_pairs_carry_explicit_overrides() {
        let mut plan = make_relaxation_precession_test_plan();
        plan.region_mask = vec![1, 2];
        plan.inter_region_exchange = vec![(1, 2, 4.0e-12)];
        let pairs = build_region_exchange_pairs(&plan, true)
            .expect("region exchange pairs")
            .expect("region mask should produce pair list");
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].region_i, 1);
        assert_eq!(pairs[0].region_j, 2);
        assert_eq!(
            pairs[0].mode,
            ffi::fullmag_fdm_exchange_pair_mode::FULLMAG_FDM_EXCHANGE_PAIR_EXPLICIT
        );
        assert_eq!(pairs[0].scale, 1.0);
        assert_eq!(pairs[0].inter_exchange, 4.0e-12);
    }

    #[test]
    fn native_fdm_region_exchange_pairs_require_region_mask() {
        let mut plan = make_relaxation_precession_test_plan();
        plan.region_mask = Vec::new();
        plan.inter_region_exchange = vec![(1, 2, 4.0e-12)];

        let err = build_region_exchange_pairs(&plan, false)
            .expect_err("explicit exchange overrides must not be dropped without a region mask");
        assert!(err.message.contains("require a region_mask"));
    }

    #[test]
    fn native_fdm_cuda_rejects_heterogeneous_ms_before_ffi() {
        let mut plan = make_relaxation_precession_test_plan();
        plan.material.ms_field = Some(vec![7.5e5; plan.initial_magnetization.len()]);

        let error = match NativeFdmBackend::create(&plan) {
            Ok(_) => panic!("cellwise Ms must remain fail-closed on native FDM CUDA"),
            Err(error) => error,
        };

        assert!(error
            .message
            .contains("does not yet support cellwise material fields"));
        assert!(error.message.contains("FDM CPU reference"));
    }

    #[test]
    fn native_fdm_cuda_preserves_complete_adaptive_policy_before_ffi() {
        let adaptive = fullmag_ir::AdaptiveTimeStepIR {
            tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::MaxError,
            atol: 1e-6,
            rtol: 0.0,
            dt_initial: Some(1e-15),
            dt_min: 1e-16,
            dt_max: Some(1e-14),
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: None,
            norm_tolerance: None,
        };
        let policy = native_time_policy(Some(&adaptive)).expect("complete policy is representable");
        assert_eq!(policy.adaptive_enabled, 1);
        assert_eq!(policy.adaptive_atol, 1e-6);
        assert_eq!(policy.adaptive_rtol, 0.0);
        assert_eq!(policy.adaptive_dt_min, 1e-16);
        assert_eq!(policy.adaptive_dt_max, 1e-14);
        assert_eq!(policy.adaptive_safety, 0.9);
        assert_eq!(policy.adaptive_growth_limit, 2.0);
        assert_eq!(policy.adaptive_shrink_limit, 0.2);
    }

    #[test]
    fn native_fdm_region_exchange_pairs_reject_invalid_exchange() {
        let mut plan = make_relaxation_precession_test_plan();
        plan.region_mask = vec![1, 2];
        plan.inter_region_exchange = vec![(1, 2, -1.0e-12)];

        let err = build_region_exchange_pairs(&plan, true)
            .expect_err("invalid explicit exchange must be rejected before FFI");
        assert!(err.message.contains("must be finite and >= 0"));
    }

    #[test]
    fn llg_checkpoint_wrapper_restores_bitwise_and_rejects_corruption() {
        assert_llg_checkpoint_round_trip(false);
        assert_llg_checkpoint_round_trip(true);
    }

    fn assert_llg_checkpoint_round_trip(thermal: bool) {
        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.enable_exchange = false;
        plan.fixed_timestep = Some(1.0e-15);
        if thermal {
            plan.temperature = Some(300.0);
            plan.thermal_seed_config = Some(fullmag_ir::ThermalSeedConfig {
                policy: fullmag_ir::SeedPolicy::Fixed,
                seed: Some(0x5a17),
            });
        }
        let dt = plan.fixed_timestep.expect("fixed timestep");
        let configure_identity = |backend: &mut NativeFdmBackend| {
            backend
                .set_checkpoint_execution_identity(
                    fullmag_ir::BackendTarget::Fdm,
                    "gpu",
                    fullmag_ir::ExecutionMode::Strict,
                    plan.integrator.expect("checkpoint integrator"),
                )
                .expect("checkpoint execution identity");
        };

        let mut continuous = NativeFdmBackend::create(&plan).expect("continuous backend");
        configure_identity(&mut continuous);
        for _ in 0..4 {
            continuous.step(dt).expect("checkpoint prefix step");
        }
        let checkpoint = continuous
            .export_llg_checkpoint()
            .expect("export LLG checkpoint");
        for _ in 0..3 {
            continuous.step(dt).expect("continuous suffix step");
        }
        let expected = continuous
            .copy_m(plan.initial_magnetization.len())
            .expect("continuous magnetization");

        let mut restored = NativeFdmBackend::create(&plan).expect("restored backend");
        configure_identity(&mut restored);
        restored
            .restore_llg_checkpoint(&checkpoint)
            .expect("restore LLG checkpoint");
        for _ in 0..3 {
            restored.step(dt).expect("restored suffix step");
        }
        assert_eq!(
            restored
                .copy_m(plan.initial_magnetization.len())
                .expect("restored magnetization"),
            expected
        );

        let mut corrupt = checkpoint.clone();
        corrupt.payload[0] ^= 1;
        let mut corrupt_target = NativeFdmBackend::create(&plan).expect("corrupt target");
        configure_identity(&mut corrupt_target);
        let error = corrupt_target
            .restore_llg_checkpoint(&corrupt)
            .expect_err("corrupt checkpoint must fail closed");
        assert!(error.message.contains("SHA-256 mismatch"));
    }

    struct StageFaultPoll {
        polls: u32,
        fail_at: u32,
    }

    unsafe extern "C" fn fail_at_stage_poll(user_data: *mut c_void) -> i32 {
        let state = unsafe { &mut *user_data.cast::<StageFaultPoll>() };
        state.polls += 1;
        i32::from(state.polls == state.fail_at)
    }

    fn step_stats_bytes(stats: &ffi::fullmag_fdm_step_stats) -> Vec<u8> {
        unsafe {
            std::slice::from_raw_parts(
                std::ptr::from_ref(stats).cast::<u8>(),
                std::mem::size_of_val(stats),
            )
            .to_vec()
        }
    }

    #[test]
    fn public_cuda_step_rolls_back_after_every_integrator_and_final_stats_poll() {
        for precision in [ExecutionPrecision::Single, ExecutionPrecision::Double] {
            for integrator in [
                IntegratorChoice::Heun,
                IntegratorChoice::Rk4,
                IntegratorChoice::Abm3,
                IntegratorChoice::Rk23,
                IntegratorChoice::Rk45,
            ] {
                let mut plan = make_masked_test_plan(false, precision);
                plan.enable_exchange = false;
                plan.external_field = Some([1.5e3, -2.0e3, 7.5e2]);
                plan.integrator = Some(integrator);
                plan.fixed_timestep = Some(1.0e-15);
                let dt = plan.fixed_timestep.expect("fault-matrix timestep");

                let mut baseline = NativeFdmBackend::create(&plan).expect("baseline backend");
                baseline.step(dt).expect("baseline accepted step");
                let expected = baseline
                    .copy_m(plan.initial_magnetization.len())
                    .expect("baseline magnetization");

                let mut interrupted_polls = 0u32;
                let mut completed_without_injection = false;
                for fail_at in 1..=32u32 {
                    let mut backend =
                        NativeFdmBackend::create(&plan).expect("fault-injected backend");
                    let initial = backend
                        .copy_m(plan.initial_magnetization.len())
                        .expect("initial magnetization");
                    let mut poll = StageFaultPoll { polls: 0, fail_at };
                    let rc = unsafe {
                        ffi::fullmag_fdm_backend_set_interrupt_poll(
                            backend.handle,
                            Some(fail_at_stage_poll),
                            std::ptr::from_mut(&mut poll).cast::<c_void>(),
                        )
                    };
                    assert_eq!(rc, ffi::FULLMAG_FDM_OK);

                    let mut stats: ffi::fullmag_fdm_step_stats = unsafe {
                        let mut value = std::mem::MaybeUninit::uninit();
                        std::ptr::write_bytes(value.as_mut_ptr(), 0x5a, 1);
                        value.assume_init()
                    };
                    let stats_before = step_stats_bytes(&stats);
                    let rc =
                        unsafe { ffi::fullmag_fdm_backend_step(backend.handle, dt, &mut stats) };
                    if rc == ffi::FULLMAG_FDM_OK {
                        assert_eq!(fail_at, interrupted_polls + 1);
                        completed_without_injection = true;
                        break;
                    }
                    assert_eq!(rc, ffi::FULLMAG_FDM_ERR_INTERRUPTED);
                    interrupted_polls += 1;
                    assert_eq!(step_stats_bytes(&stats), stats_before);
                    assert_eq!(
                        backend
                            .copy_m(plan.initial_magnetization.len())
                            .expect("rolled-back magnetization"),
                        initial
                    );

                    let rc = unsafe {
                        ffi::fullmag_fdm_backend_set_interrupt_poll(
                            backend.handle,
                            None,
                            std::ptr::null_mut(),
                        )
                    };
                    assert_eq!(rc, ffi::FULLMAG_FDM_OK);
                    backend.step(dt).expect("retry after injected fault");
                    assert_eq!(
                        backend
                            .copy_m(plan.initial_magnetization.len())
                            .expect("retried magnetization"),
                        expected
                    );
                }
                assert!(
                    interrupted_polls >= 2,
                    "{integrator:?}/{precision:?} must expose integrator and final-stats polls"
                );
                assert!(
                    completed_without_injection,
                    "fault poll matrix must terminate"
                );
            }
        }
    }

    fn make_masked_test_plan(enable_demag: bool, precision: ExecutionPrecision) -> FdmPlanIR {
        FdmPlanIR {
            origin_m: [0.0, 0.0, 0.0],
            grid: GridDimensions { cells: [3, 3, 1] },
            cell_size: [5e-9, 5e-9, 10e-9],
            grid_certificate: None,
            region_mask: vec![0; 9],
            active_mask: Some(vec![true, true, true, true, false, true, true, true, false]),
            initial_magnetization: vec![
                [1.0, 0.0, 0.0],
                [0.9950041652780258, 0.09983341664682815, 0.0],
                [0.9800665778412416, 0.19866933079506122, 0.0],
                [0.8, 0.0, 0.6],
                [0.6, 0.8, 0.0],
                [0.48, 0.64, 0.6],
                [0.8, -0.6, 0.0],
                [0.28, 0.96, 0.0],
                [0.36, 0.48, 0.8],
            ],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.1,
                ..Default::default()
            },
            gyromagnetic_ratio: 2.211e5,
            precision,
            precision_policy: fullmag_ir::FdmPrecisionPolicyIR::resolve(precision),
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(2.5e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            enable_exchange: true,
            enable_demag,
            external_field: Some([1.5e3, -2.0e3, 7.5e2]),
            field_drives: Vec::new(),
            regional_field_drive_bases: Vec::new(),
            time_stage: Default::default(),
            inter_region_exchange: vec![],
            periodicity: None,
            resolved_periodic_images: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
            boundary_geometry: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            sot_current_density: None,
            sot_xi_dl: None,
            sot_xi_fl: None,
            sot_sigma: None,
            sot_thickness: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            static_external_field_xyz: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
            temperature: None,
            thermal_seed_config: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
            mel_b1: None,
            mel_b2: None,
            mel_uniform_strain: None,
            antenna_zeeman_masks: Vec::new(),
            ..Default::default()
        }
    }

    fn make_thin_film_demag_plan() -> FdmPlanIR {
        let nx = 8usize;
        let ny = 6usize;
        let nz = 1usize;
        let mut initial_magnetization = Vec::with_capacity(nx * ny * nz);
        for y in 0..ny {
            for x in 0..nx {
                let theta = 0.11 * x as f64;
                let phi = 0.07 * y as f64;
                let mx = theta.cos() * phi.cos();
                let my = theta.sin() * phi.cos();
                let mz = 0.2 * phi.sin();
                let norm = (mx * mx + my * my + mz * mz).sqrt();
                initial_magnetization.push([mx / norm, my / norm, mz / norm]);
            }
        }

        FdmPlanIR {
            origin_m: [0.0, 0.0, 0.0],
            grid: GridDimensions {
                cells: [nx as u32, ny as u32, nz as u32],
            },
            cell_size: [4e-9, 4e-9, 10e-9],
            grid_certificate: None,
            region_mask: vec![0; nx * ny * nz],
            active_mask: None,
            initial_magnetization,
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.1,
                ..Default::default()
            },
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(2.0e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            enable_exchange: true,
            enable_demag: true,
            external_field: Some([2.0e3, -1.0e3, 5.0e2]),
            field_drives: Vec::new(),
            regional_field_drive_bases: Vec::new(),
            time_stage: Default::default(),
            inter_region_exchange: vec![],
            periodicity: None,
            resolved_periodic_images: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
            boundary_geometry: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            sot_current_density: None,
            sot_xi_dl: None,
            sot_xi_fl: None,
            sot_sigma: None,
            sot_thickness: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            static_external_field_xyz: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
            temperature: None,
            thermal_seed_config: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
            mel_b1: None,
            mel_b2: None,
            mel_uniform_strain: None,
            antenna_zeeman_masks: Vec::new(),
            ..Default::default()
        }
    }

    fn make_relaxation_precession_test_plan() -> FdmPlanIR {
        FdmPlanIR {
            origin_m: [0.0, 0.0, 0.0],
            grid: GridDimensions { cells: [1, 1, 1] },
            cell_size: [5e-9, 5e-9, 5e-9],
            grid_certificate: None,
            region_mask: vec![0],
            active_mask: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.1,
                ..Default::default()
            },
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Rk23),
            fixed_timestep: Some(1e-15),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: Some(RelaxationControlIR {
                algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                stop: fullmag_ir::RelaxStopIR {
                    torque_tolerance_apm: Some(1e-6),
                    energy_tolerance_j: None,
                    max_steps: Some(10),
                    max_relaxation_time_s: None,
                },
            }),
            enable_exchange: false,
            enable_demag: false,
            external_field: Some([0.0, 0.0, 8.0e5]),
            field_drives: Vec::new(),
            regional_field_drive_bases: Vec::new(),
            time_stage: Default::default(),
            inter_region_exchange: vec![],
            periodicity: None,
            resolved_periodic_images: None,
            boundary_correction: None,
            boundary_phi_floor: None,
            boundary_delta_min: None,
            boundary_geometry: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            sot_current_density: None,
            sot_xi_dl: None,
            sot_xi_fl: None,
            sot_sigma: None,
            sot_thickness: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            static_external_field_xyz: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            oersted_realization: None,
            temperature: None,
            thermal_seed_config: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
            mel_b1: None,
            mel_b2: None,
            mel_uniform_strain: None,
            antenna_zeeman_masks: Vec::new(),
            ..Default::default()
        }
    }

    fn assert_scalar_close(label: &str, actual: f64, expected: f64, rel_tol: f64, abs_tol: f64) {
        let diff = (actual - expected).abs();
        let scale = expected.abs().max(actual.abs()).max(1.0);
        assert!(
            diff <= abs_tol.max(rel_tol * scale),
            "{} mismatch: actual={} expected={} diff={}",
            label,
            actual,
            expected,
            diff
        );
    }

    fn assert_vector_field_close(
        label: &str,
        actual: &[[f64; 3]],
        expected: &[[f64; 3]],
        rel_tol: f64,
        abs_tol: f64,
    ) {
        assert_eq!(actual.len(), expected.len(), "{} length mismatch", label);
        for (index, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
            for component in 0..3 {
                assert_scalar_close(
                    &format!("{}[{}][{}]", label, index, component),
                    a[component],
                    e[component],
                    rel_tol,
                    abs_tol,
                );
            }
        }
    }

    fn assert_flat_field_close(
        label: &str,
        actual: &[f64],
        expected: &[f64],
        rel_tol: f64,
        abs_tol: f64,
    ) {
        assert_eq!(actual.len(), expected.len(), "{} length mismatch", label);
        for (index, (actual, expected)) in actual.iter().zip(expected.iter()).enumerate() {
            assert_scalar_close(
                &format!("{}[{}]", label, index),
                *actual,
                *expected,
                rel_tol,
                abs_tol,
            );
        }
    }

    fn max_vector_component_diff(actual: &[[f64; 3]], expected: &[[f64; 3]]) -> f64 {
        actual
            .iter()
            .zip(expected.iter())
            .flat_map(|(a, e)| (0..3).map(move |component| (a[component] - e[component]).abs()))
            .fold(0.0, f64::max)
    }

    fn max_vector_component_diff_f32(actual: &[[f32; 3]], expected: &[[f64; 3]]) -> f64 {
        actual
            .iter()
            .zip(expected.iter())
            .flat_map(|(a, e)| {
                (0..3).map(move |component| (f64::from(a[component]) - e[component]).abs())
            })
            .fold(0.0, f64::max)
    }

    fn vector_field_sha256(values: &[[f64; 3]]) -> String {
        let mut hasher = Sha256::new();
        for value in values {
            for component in value {
                hasher.update(component.to_bits().to_le_bytes());
            }
        }
        format!("{:x}", hasher.finalize())
    }

    fn frozen_spins_parity_plan_binding_sha256(plan: &FdmPlanIR, active_mask: &[bool]) -> String {
        const DOMAIN: &[u8] = b"fullmag:frozen-spins:fdm-cpu-gpu-plan-binding:v1\0";
        let resolved = plan.frozen_spins.as_ref().expect("resolved Frozen Spins");
        let mut hasher = Sha256::new();
        hasher.update(DOMAIN);
        hasher.update((resolved.constraint_ids.len() as u64).to_le_bytes());
        for constraint_id in &resolved.constraint_ids {
            hasher.update((constraint_id.len() as u64).to_le_bytes());
            hasher.update(constraint_id.as_bytes());
        }
        hasher.update((resolved.grid_or_mesh_fingerprint.len() as u64).to_le_bytes());
        hasher.update(resolved.grid_or_mesh_fingerprint.as_bytes());
        hasher.update((resolved.mask_sha256.len() as u64).to_le_bytes());
        hasher.update(resolved.mask_sha256.as_bytes());
        let reference_sha256 = &resolved.certificate.resolved_reference_sha256;
        hasher.update((reference_sha256.len() as u64).to_le_bytes());
        hasher.update(reference_sha256.as_bytes());
        hasher.update(
            resolved
                .source_state_revision
                .expect("canonical parity source state revision")
                .to_le_bytes(),
        );
        hasher.update((active_mask.len() as u64).to_le_bytes());
        hasher.update(
            active_mask
                .iter()
                .map(|value| u8::from(*value))
                .collect::<Vec<_>>(),
        );
        hasher.update((resolved.frozen_mask.len() as u64).to_le_bytes());
        hasher.update(
            resolved
                .frozen_mask
                .iter()
                .map(|value| u8::from(*value))
                .collect::<Vec<_>>(),
        );
        format!("{:x}", hasher.finalize())
    }

    fn required_frozen_spins_evidence_env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("{name} must bind the parity evidence run"))
    }

    fn write_json_atomic(path: &std::path::Path, payload: &serde_json::Value) {
        use std::io::Write as _;

        let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .expect("parity evidence path must have a UTF-8 file name");
        let temporary = parent.join(format!(".{file_name}.{}.write.tmp", std::process::id()));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .expect("create unique parity evidence temporary file");
        let mut bytes = serde_json::to_vec_pretty(payload).expect("serialize parity evidence");
        bytes.push(b'\n');
        file.write_all(&bytes).expect("write parity evidence bytes");
        file.sync_all().expect("fsync parity evidence bytes");
        drop(file);
        std::fs::rename(&temporary, path).expect("atomically publish CPU/GPU parity evidence");
        std::fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .expect("fsync parity evidence directory");
    }

    fn masked_oersted_field(plan: &FdmPlanIR) -> Vec<[f64; 3]> {
        let raw = plan
            .oersted_field_xyz
            .clone()
            .expect("test plan should carry oersted field");
        let active_mask = plan
            .active_mask
            .as_ref()
            .expect("test plan should carry active mask");
        raw.into_iter()
            .zip(active_mask.iter())
            .map(|(value, is_active)| if *is_active { value } else { [0.0, 0.0, 0.0] })
            .collect()
    }

    fn generalized_oersted_preview_request() -> LivePreviewRequest {
        LivePreviewRequest {
            revision: 7,
            quantity: "H_OE".to_string(),
            component: "3D".to_string(),
            layer: 0,
            all_layers: false,
            every_n: 1,
            x_chosen_size: 3,
            y_chosen_size: 3,
            auto_scale_enabled: false,
            max_points: 9,
        }
    }

    fn anisotropy_preview_request() -> LivePreviewRequest {
        LivePreviewRequest {
            quantity: "H_ani".to_string(),
            ..generalized_oersted_preview_request()
        }
    }

    fn decode_snapshot_payload(info: NativeFieldSnapshotInfo, payload: &[u8]) -> Vec<[f64; 3]> {
        assert_eq!(info.component_count, 3, "expected vector snapshot payload");
        let scalars = match info.scalar_type {
            NativeFieldSnapshotScalarType::F32 => payload
                .chunks_exact(std::mem::size_of::<f32>())
                .map(|chunk| f64::from(f32::from_ne_bytes(chunk.try_into().unwrap())))
                .collect::<Vec<_>>(),
            NativeFieldSnapshotScalarType::F64 => payload
                .chunks_exact(std::mem::size_of::<f64>())
                .map(|chunk| f64::from_ne_bytes(chunk.try_into().unwrap()))
                .collect::<Vec<_>>(),
        };
        assert_eq!(
            scalars.len(),
            info.cell_count * info.component_count,
            "decoded snapshot scalar count should match descriptor"
        );
        let mut vectors = vec![[0.0, 0.0, 0.0]; info.cell_count];
        for cell in 0..info.cell_count {
            vectors[cell][0] = scalars[cell];
            vectors[cell][1] = scalars[info.cell_count + cell];
            vectors[cell][2] = scalars[(2 * info.cell_count) + cell];
        }
        vectors
    }

    fn cpu_reference_problem(plan: &FdmPlanIR) -> ExchangeLlgProblem {
        let grid = fullmag_engine::GridShape::new(
            plan.grid.cells[0] as usize,
            plan.grid.cells[1] as usize,
            plan.grid.cells[2] as usize,
        )
        .expect("grid");
        let cell_size =
            CellSize::new(plan.cell_size[0], plan.cell_size[1], plan.cell_size[2]).expect("cell");
        let material = MaterialParameters::new(
            plan.material.saturation_magnetisation,
            plan.material.exchange_stiffness,
            plan.material.damping,
        )
        .expect("material");
        let integrator = match plan.integrator.unwrap_or(IntegratorChoice::Heun) {
            fullmag_ir::IntegratorChoice::Heun => TimeIntegrator::Heun,
            fullmag_ir::IntegratorChoice::Rk4 => TimeIntegrator::RK4,
            fullmag_ir::IntegratorChoice::Rk23 => TimeIntegrator::RK23,
            fullmag_ir::IntegratorChoice::Rk45 => TimeIntegrator::RK45,
            fullmag_ir::IntegratorChoice::Abm3 => TimeIntegrator::ABM3,
        };
        let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, integrator)
            .expect("dynamics")
            .with_precession_enabled(!llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()));
        let mut problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            cell_size,
            material,
            dynamics,
            EffectiveFieldTerms {
                exchange: plan.enable_exchange,
                demag: plan.enable_demag,
                external_field: plan.external_field,
                per_node_field: plan.oersted_field_xyz.clone(),
                magnetoelastic: None,
                uniaxial_anisotropy: plan.material.uniaxial_anisotropy_ku1.map(|ku1| {
                    UniaxialAnisotropyConfig {
                        ku1,
                        ku2: plan.material.uniaxial_anisotropy_ku2.unwrap_or(0.0),
                        axis: plan.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
                    }
                }),
                cubic_anisotropy: plan
                    .material
                    .cubic_anisotropy_kc1
                    .or(plan.material.cubic_anisotropy_kc2)
                    .or(plan.material.cubic_anisotropy_kc3)
                    .map(|_| CubicAnisotropyConfig {
                        kc1: plan.material.cubic_anisotropy_kc1.unwrap_or(0.0),
                        kc2: plan.material.cubic_anisotropy_kc2.unwrap_or(0.0),
                        kc3: plan.material.cubic_anisotropy_kc3.unwrap_or(0.0),
                        axis1: plan
                            .material
                            .cubic_anisotropy_axis1
                            .unwrap_or([1.0, 0.0, 0.0]),
                        axis2: plan
                            .material
                            .cubic_anisotropy_axis2
                            .unwrap_or([0.0, 1.0, 0.0]),
                    }),
                interfacial_dmi: plan.interfacial_dmi,
                bulk_dmi: plan.bulk_dmi,
                zhang_li_stt: None,
                slonczewski_stt: None,
                sot: None,
                oersted_cylinder: None,
            },
            plan.active_mask.clone(),
        )
        .expect("problem");
        if let Some(periodicity) = plan.periodicity.as_ref() {
            let map_axis = |axis: &fullmag_ir::AxisBoundary| match axis {
                fullmag_ir::AxisBoundary::Periodic => fullmag_engine::AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Open => fullmag_engine::AxisBoundary::Open,
            };
            problem.boundary_policy = fullmag_engine::FdmBoundaryPolicy {
                x: map_axis(&periodicity.axes[0]),
                y: map_axis(&periodicity.axes[1]),
                z: map_axis(&periodicity.axes[2]),
            };
            if let Some(image_counts) = periodicity.image_counts {
                problem.demag_image_counts = image_counts;
            }
        }
        problem.set_demag_boundary(
            crate::fdm::resolve_fdm_demag_boundary(plan).expect("resolved demag boundary"),
        );
        problem.set_resolved_periodic_workspace(plan.resolved_periodic_images.as_ref().map(
            |resolved| fullmag_engine::ResolvedFdmPeriodicWorkspace {
                image_counts: resolved.resolved_image_counts,
                padded_counts: resolved.padded_counts,
                image_terms: resolved.image_terms,
                estimated_bytes: resolved.estimated_bytes,
            },
        ));
        problem
    }

    fn cpu_reference_single_step(
        plan: &FdmPlanIR,
    ) -> (
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        fullmag_engine::StepReport,
    ) {
        let problem = cpu_reference_problem(plan);

        let mut state = problem
            .new_state(plan.initial_magnetization.clone())
            .expect("state");
        let mut workspace = problem.create_workspace();
        let report = problem
            .step_with_workspace(
                &mut state,
                plan.fixed_timestep.expect("fixed dt"),
                &mut workspace,
            )
            .expect("cpu step");
        let observables = problem.observe(&state).expect("observe");
        let anisotropy_field = problem.anisotropy_field(state.magnetization());
        (
            state.magnetization().to_vec(),
            observables.exchange_field,
            observables.demag_field,
            observables.external_field,
            anisotropy_field,
            observables.effective_field,
            report,
        )
    }

    fn cpu_reference_energy_densities_after_single_step(plan: &FdmPlanIR) -> [Vec<f64>; 6] {
        let problem = cpu_reference_problem(plan);
        let mut state = problem
            .new_state(plan.initial_magnetization.clone())
            .expect("state");
        let mut workspace = problem.create_workspace();
        problem
            .step_with_workspace(
                &mut state,
                plan.fixed_timestep.expect("fixed dt"),
                &mut workspace,
            )
            .expect("cpu step");
        [
            problem
                .exchange_energy_density(&state)
                .expect("CPU exchange density"),
            problem
                .demag_energy_density(&state)
                .expect("CPU demag density"),
            problem
                .external_energy_density(&state)
                .expect("CPU external density"),
            problem
                .anisotropy_energy_density(&state)
                .expect("CPU anisotropy density"),
            problem.dmi_energy_density(&state).expect("CPU DMI density"),
            problem
                .total_energy_density(&state)
                .expect("CPU total density"),
        ]
    }

    #[test]
    fn native_fdm_masked_exchange_only_matches_cpu_reference_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM masked parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        let active_mask = plan.active_mask.clone().expect("active mask");
        let cell_count = plan.initial_magnetization.len();
        let (
            expected_m,
            expected_h_ex,
            _expected_h_demag,
            expected_h_ext,
            _expected_h_ani,
            expected_h_eff,
            expected_report,
        ) = cpu_reference_single_step(&plan);

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");
        let actual_m = backend.copy_m(cell_count).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
        let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
        let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

        assert_vector_field_close("m", &actual_m, &expected_m, 5e-6, 1e-8);
        assert_vector_field_close("H_ex", &actual_h_ex, &expected_h_ex, 5e-5, 1e-2);
        assert_vector_field_close("H_ext", &actual_h_ext, &expected_h_ext, 1e-12, 1e-12);
        assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-5, 1e-2);

        for (index, is_active) in active_mask.iter().enumerate() {
            if !is_active {
                assert_eq!(
                    actual_m[index],
                    [0.0, 0.0, 0.0],
                    "inactive m leak at {index}"
                );
                assert_eq!(
                    actual_h_ex[index],
                    [0.0, 0.0, 0.0],
                    "inactive H_ex leak at {index}"
                );
                assert_eq!(
                    actual_h_ext[index],
                    [0.0, 0.0, 0.0],
                    "inactive H_ext leak at {index}"
                );
                assert_eq!(
                    actual_h_eff[index],
                    [0.0, 0.0, 0.0],
                    "inactive H_eff leak at {index}"
                );
            }
        }

        assert_scalar_close(
            "time_seconds",
            stats.time,
            expected_report.time_seconds,
            1e-12,
            1e-18,
        );
        assert_scalar_close(
            "exchange_energy_joules",
            stats.e_ex,
            expected_report.exchange_energy_joules,
            5e-6,
            1e-18,
        );
        assert_scalar_close(
            "external_energy_joules",
            stats.e_ext,
            expected_report.external_energy_joules,
            1e-6,
            1e-18,
        );
        assert_scalar_close(
            "total_energy_joules",
            stats.e_total,
            expected_report.total_energy_joules,
            5e-6,
            1e-18,
        );
        assert_scalar_close(
            "max_effective_field_amplitude",
            stats.max_h_eff,
            expected_report.max_effective_field_amplitude,
            5e-5,
            1e-4,
        );
        assert_scalar_close(
            "max_rhs_amplitude",
            stats.max_dm_dt,
            expected_report.max_rhs_amplitude,
            5e-5,
            1e-4,
        );
    }

    #[test]
    fn native_fdm_frozen_spins_cpu_gpu_parity_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM Frozen Spins CPU/GPU parity: CUDA backend is not available"
            );
            return;
        }

        const REL_TOL: f64 = 5.0e-6;
        const ABS_TOL: f64 = 1.0e-8;
        const STEP_COUNT: u64 = 4;
        let plan = canonical_frozen_spins_cpu_gpu_parity_plan();
        validate_native_frozen_spins_plan(&plan)
            .expect("canonical Frozen Spins carrier must pass the native boundary");
        let resolved = plan.frozen_spins.as_ref().expect("resolved Frozen Spins");
        let frozen_mask = &resolved.frozen_mask;
        let active_mask = plan.active_mask.as_deref().expect("active mask");
        let plan_binding_sha256 = frozen_spins_parity_plan_binding_sha256(&plan, active_mask);
        let dt = plan.fixed_timestep.expect("fixed timestep");
        let until_seconds = dt * STEP_COUNT as f64;
        let cpu = crate::fdm::cpu::reference::execute_reference_fdm(
            &plan,
            until_seconds,
            &[],
            None,
            None,
        )
        .expect("CPU Frozen Spins parity execution");
        let cpu_accepted_steps = cpu
            .provenance
            .fdm_cpu_step_transaction_telemetry
            .as_ref()
            .expect("CPU accepted-step telemetry")
            .accepted_step_count;
        let cpu_step_stats = cpu
            .result
            .steps
            .last()
            .cloned()
            .expect("CPU final observed step stats");
        assert_eq!(cpu_accepted_steps, STEP_COUNT);
        assert_eq!(cpu_step_stats.step, STEP_COUNT);
        // The CPU transaction computes the accepted step through the adaptive
        // time-policy path, so the decimal product can differ from the
        // literal fixture by one binary64 rounding ulp.  Keep this tolerance
        // limited to the time scalar; state and Frozen Spins parity below
        // retain the strict component tolerances.
        assert_scalar_close("cpu final dt", cpu_step_stats.dt, dt, 1.0e-12, 1.0e-30);
        assert_scalar_close(
            "cpu final time",
            cpu_step_stats.time,
            until_seconds,
            1.0e-12,
            1.0e-30,
        );
        let cpu_m = cpu.result.final_magnetization;

        let mut gpu = NativeFdmBackend::create(&plan).expect("native CUDA Frozen Spins create");
        let mut gpu_step_stats = None;
        for expected_step in 1..=STEP_COUNT {
            let observed = gpu.step(dt).expect("native CUDA Frozen Spins parity step");
            assert_eq!(observed.step, expected_step);
            assert_scalar_close("gpu observed dt", observed.dt, dt, 1.0e-12, 1.0e-30);
            assert_scalar_close(
                "gpu observed time",
                observed.time,
                dt * expected_step as f64,
                1.0e-12,
                1.0e-30,
            );
            gpu_step_stats = Some(observed);
        }
        let gpu_step_stats = gpu_step_stats.expect("GPU final observed step stats");
        assert_eq!(gpu_step_stats.step, cpu_accepted_steps);
        assert_scalar_close(
            "CPU/GPU final time",
            gpu_step_stats.time,
            cpu_step_stats.time,
            1.0e-12,
            1.0e-30,
        );
        let gpu_device = gpu.device_info().expect("native CUDA device identity");
        let gpu_device_ordinal = residency::query_execution_device_ordinal(&gpu)
            .expect("native CUDA execution device ordinal");
        let gpu_m = gpu
            .copy_m(plan.initial_magnetization.len())
            .expect("copy CUDA parity magnetization");

        assert_vector_field_close("frozen_spins.cpu_gpu.m", &gpu_m, &cpu_m, REL_TOL, ABS_TOL);

        let mut max_abs_component_diff = 0.0_f64;
        let mut max_normalized_error = 0.0_f64;
        for (gpu_value, cpu_value) in gpu_m.iter().zip(cpu_m.iter()) {
            for component in 0..3 {
                let difference = (gpu_value[component] - cpu_value[component]).abs();
                let scale = gpu_value[component]
                    .abs()
                    .max(cpu_value[component].abs())
                    .max(1.0);
                let allowed = ABS_TOL.max(REL_TOL * scale);
                max_abs_component_diff = max_abs_component_diff.max(difference);
                max_normalized_error = max_normalized_error.max(difference / allowed);
            }
        }
        assert!(max_normalized_error <= 1.0);

        let mut cpu_frozen_bitwise = true;
        let mut gpu_frozen_bitwise = true;
        let mut max_cpu_free_displacement = 0.0_f64;
        let mut max_gpu_free_displacement = 0.0_f64;
        for index in 0..plan.initial_magnetization.len() {
            if frozen_mask[index] {
                cpu_frozen_bitwise &= cpu_m[index].map(f64::to_bits)
                    == plan.initial_magnetization[index].map(f64::to_bits);
                gpu_frozen_bitwise &= gpu_m[index].map(f64::to_bits)
                    == plan.initial_magnetization[index].map(f64::to_bits);
            } else if active_mask[index] {
                let displacement = |value: [f64; 3]| {
                    ((value[0] - plan.initial_magnetization[index][0]).powi(2)
                        + (value[1] - plan.initial_magnetization[index][1]).powi(2)
                        + (value[2] - plan.initial_magnetization[index][2]).powi(2))
                    .sqrt()
                };
                max_cpu_free_displacement =
                    max_cpu_free_displacement.max(displacement(cpu_m[index]));
                max_gpu_free_displacement =
                    max_gpu_free_displacement.max(displacement(gpu_m[index]));
            }
        }
        assert!(
            cpu_frozen_bitwise,
            "CPU frozen references must be bitwise exact"
        );
        assert!(
            gpu_frozen_bitwise,
            "GPU frozen references must be bitwise exact"
        );
        assert!(max_cpu_free_displacement > 0.0, "CPU free spins must move");
        assert!(max_gpu_free_displacement > 0.0, "GPU free spins must move");

        if let Some(path) = std::env::var_os("FULLMAG_FDM_FROZEN_SPINS_CPU_GPU_PARITY_PATH") {
            let run_id = required_frozen_spins_evidence_env("FULLMAG_FROZEN_SPINS_RUN_ID");
            let source_snapshot_sha256 =
                required_frozen_spins_evidence_env("FULLMAG_FROZEN_SPINS_SOURCE_SNAPSHOT_SHA256");
            let native_build_sha256 =
                required_frozen_spins_evidence_env("FULLMAG_FROZEN_SPINS_NATIVE_BUILD_SHA256");
            let requested_gpu_ordinal = required_frozen_spins_evidence_env("FULLMAG_FDM_GPU_INDEX")
                .parse::<i32>()
                .expect("FULLMAG_FDM_GPU_INDEX must be an i32");
            assert_eq!(
                gpu_device_ordinal, requested_gpu_ordinal,
                "parity evidence must bind the actually executing CUDA ordinal"
            );
            // `SelectionCertificateIR::warnings` is intentionally omitted by
            // serde when empty for the general IR/API contract.  The managed
            // qualification receipt is stricter: it must state explicitly
            // that canonical selection produced no warnings, so materialize
            // the empty array in this evidence-only projection.
            let mut resolved_evidence =
                serde_json::to_value(resolved).expect("serialize resolved Frozen Spins plan");
            resolved_evidence["certificate"]["warnings"] =
                serde_json::json!(resolved.certificate.warnings);
            let evidence = serde_json::json!({
                "schema_version": "fullmag.frozen_spins.fdm_cpu_gpu_parity.evidence.v1",
                "status": "PASS",
                "run_binding": {
                    "run_id": run_id,
                    "source_snapshot_sha256": source_snapshot_sha256,
                    "native_build_sha256": native_build_sha256,
                    "requested_gpu_ordinal": requested_gpu_ordinal,
                    "plan_binding_sha256": plan_binding_sha256,
                },
                "backend_pair": ["fdm_cpu_reference", "fdm_cuda"],
                "precision": "fp64",
                "integrator": "heun",
                "scientific_scope": "fdm_single_grid_fp64_heun_exchange_external_field_four_fixed_steps_no_demag",
                "known_limitations": ["no_demag", "single_integrator", "single_precision"],
                "steps": gpu_step_stats.step,
                "cell_count": plan.initial_magnetization.len(),
                "active_cell_count": resolved.active_dof_count,
                "frozen_cell_count": resolved.frozen_dof_count,
                "free_cell_count": resolved.free_dof_count,
                "mask_sha256": resolved.mask_sha256,
                "plan_binding_sha256": plan_binding_sha256,
                "active_mask": active_mask,
                "resolved_plan": resolved_evidence,
                "initial_magnetization_sha256": vector_field_sha256(&plan.initial_magnetization),
                "workload": {
                    "grid_cells": plan.grid.cells,
                    "cell_size_m": plan.cell_size,
                    "fixed_timestep_seconds": dt,
                    "physics_terms": ["exchange", "external_field"],
                    "demag_enabled": plan.enable_demag,
                },
                "gpu_device": {
                    "ordinal": gpu_device_ordinal,
                    "name": gpu_device.name,
                    "driver_version": gpu_device.driver_version.to_string(),
                    "runtime_version": gpu_device.runtime_version.to_string(),
                    "compute_capability": gpu_device.compute_capability,
                },
                "observed_step_stats": {
                    "cpu": {
                        "accepted_step_count": cpu_accepted_steps,
                        "step": cpu_step_stats.step,
                        "time_seconds": cpu_step_stats.time,
                        "dt_seconds": cpu_step_stats.dt,
                    },
                    "gpu": {
                        "step": gpu_step_stats.step,
                        "time_seconds": gpu_step_stats.time,
                        "dt_seconds": gpu_step_stats.dt,
                    },
                },
                "relative_tolerance": REL_TOL,
                "absolute_tolerance": ABS_TOL,
                "max_abs_component_diff": max_abs_component_diff,
                "max_normalized_error": max_normalized_error,
                "cpu_frozen_reference_bitwise": cpu_frozen_bitwise,
                "gpu_frozen_reference_bitwise": gpu_frozen_bitwise,
                "max_cpu_free_displacement": max_cpu_free_displacement,
                "max_gpu_free_displacement": max_gpu_free_displacement,
                "cpu_final_state_sha256": vector_field_sha256(&cpu_m),
                "gpu_final_state_sha256": vector_field_sha256(&gpu_m),
                "initial_magnetization": &plan.initial_magnetization,
                "cpu_final_magnetization": &cpu_m,
                "gpu_final_magnetization": &gpu_m,
            });
            write_json_atomic(std::path::Path::new(&path), &evidence);
            println!(
                "FROZEN_SPINS_CPU_GPU_PARITY_EVIDENCE={}",
                std::path::Path::new(&path).display()
            );
        }
    }

    #[test]
    fn native_fdm_anisotropy_copy_preview_and_snapshot_match_cpu_reference_when_cuda_is_available()
    {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM anisotropy observable test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.material.uniaxial_anisotropy_ku1 = Some(8.0e4);
        plan.material.uniaxial_anisotropy_ku2 = Some(1.0e4);
        plan.material.anisotropy_axis = Some([0.0, 0.0, 1.0]);
        let cell_count = plan.initial_magnetization.len();
        let (_, _, _, _, expected_h_ani, _, _) = cpu_reference_single_step(&plan);

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");

        let actual_h_ani = backend.copy_h_ani(cell_count).expect("copy H_ani");
        assert_vector_field_close("H_ani", &actual_h_ani, &expected_h_ani, 5e-5, 1e-2);

        let request = anisotropy_preview_request();
        let expected_preview = build_grid_preview_field(
            &request,
            &expected_h_ani,
            plan.grid.cells,
            plan.active_mask.as_deref(),
        );
        let actual_sync = backend
            .copy_live_preview_field(&request, plan.grid.cells, plan.active_mask.as_deref())
            .expect("copy H_ani preview");
        let actual_async = backend
            .begin_live_preview_snapshot(&request, plan.grid.cells)
            .expect("begin H_ani preview snapshot")
            .into_live_preview_field(plan.active_mask.as_deref())
            .expect("collect H_ani preview snapshot");

        assert_eq!(actual_sync.quantity, "H_ani");
        assert_eq!(actual_sync.unit, expected_preview.unit);
        assert_eq!(actual_sync.preview_grid, expected_preview.preview_grid);
        assert_flat_field_close(
            "H_ani.preview",
            &actual_sync.vector_field_values,
            &expected_preview.vector_field_values,
            5e-5,
            1e-2,
        );
        assert_flat_field_close(
            "H_ani.preview_async",
            &actual_async.vector_field_values,
            &expected_preview.vector_field_values,
            5e-5,
            1e-2,
        );

        let mut snapshot = backend
            .begin_field_snapshot("H_ani", 3, 0.0, plan.fixed_timestep.unwrap_or(0.0))
            .expect("begin H_ani field snapshot");
        let mut payload = Vec::new();
        let written_info = snapshot
            .write_payload(&mut payload)
            .expect("H_ani snapshot payload");
        let decoded = decode_snapshot_payload(written_info, &payload);
        assert_vector_field_close("H_ani.snapshot", &decoded, &expected_h_ani, 5e-5, 1e-2);
    }

    #[test]
    fn native_fdm_slonczewski_matches_cpu_reference_without_zhang_li_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM Slonczewski parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.current_density = Some([1.4e11, 0.0, 0.0]);
        plan.stt_degree = Some(0.62);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.8);
        plan.stt_epsilon_prime = Some(0.03);

        let expected =
            crate::fdm::cpu::reference::execute_reference_fdm(&plan, 2.5e-13, &[], None, None)
                .expect("cpu reference slonczewski run");
        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm slonczewski step");
        let actual_m = backend
            .copy_m(plan.initial_magnetization.len())
            .expect("copy m");

        assert_vector_field_close(
            "m",
            &actual_m,
            &expected.result.final_magnetization,
            1e-6,
            1e-10,
        );
    }

    #[test]
    fn native_fdm_canonical_slonczewski_matches_cpu_reference_with_target_mask_when_cuda_is_available(
    ) {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM canonical Slonczewski parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.current_density = Some([1.4e11, 0.0, 0.0]);
        plan.stt_degree = Some(0.62);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.8);
        plan.stt_epsilon_prime = Some(0.03);
        plan.slonczewski_formula_version = Some("slonczewski.fullmag.v2".to_string());
        plan.slonczewski_stack_normal = Some([2.0, 0.0, 0.0]);
        plan.slonczewski_active_mask = Some(vec![
            true, false, true, false, true, false, true, false, true,
        ]);

        let expected =
            crate::fdm::cpu::reference::execute_reference_fdm(&plan, 2.5e-13, &[], None, None)
                .expect("cpu reference canonical Slonczewski run");
        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm canonical Slonczewski step");
        let actual_m = backend
            .copy_m(plan.initial_magnetization.len())
            .expect("copy m");

        assert_vector_field_close(
            "canonical Slonczewski m",
            &actual_m,
            &expected.result.final_magnetization,
            1e-6,
            1e-10,
        );
    }

    #[test]
    fn native_fdm_canonical_slonczewski_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available(
    ) {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM canonical Slonczewski trajectory parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.current_density = Some([1.4e11, 0.0, 0.0]);
        plan.stt_degree = Some(0.62);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.8);
        plan.stt_epsilon_prime = Some(0.03);
        plan.slonczewski_formula_version = Some("slonczewski.fullmag.v2".to_string());
        plan.slonczewski_stack_normal = Some([2.0, 0.0, 0.0]);
        plan.slonczewski_active_mask = Some(vec![
            true, false, true, false, true, false, true, false, true,
        ]);

        let dt = plan.fixed_timestep.expect("fixed timestep");
        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        for step in 1..=8 {
            backend
                .step(dt)
                .expect("native fdm canonical Slonczewski trajectory step");
            let expected = crate::fdm::cpu::reference::execute_reference_fdm(
                &plan,
                dt * step as f64,
                &[],
                None,
                None,
            )
            .expect("cpu reference canonical Slonczewski trajectory");
            let actual_m = backend
                .copy_m(plan.initial_magnetization.len())
                .expect("copy canonical Slonczewski trajectory m");

            assert_vector_field_close(
                &format!("canonical Slonczewski trajectory step {step}"),
                &actual_m,
                &expected.result.final_magnetization,
                1e-6,
                1e-10,
            );
        }
    }

    #[test]
    fn native_fdm_canonical_slonczewski_has_bounded_current_scaling_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM canonical Slonczewski current-scaling test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut base_plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        base_plan.enable_exchange = false;
        base_plan.external_field = None;
        base_plan.fixed_timestep = Some(1.0e-15);

        let mut baseline_backend =
            NativeFdmBackend::create(&base_plan).expect("native fdm baseline create");
        baseline_backend
            .step(base_plan.fixed_timestep.expect("fixed timestep"))
            .expect("native fdm baseline step");
        let baseline = baseline_backend
            .copy_m(base_plan.initial_magnetization.len())
            .expect("copy baseline m");

        let run_at_scale = |scale: f64| {
            let mut plan = base_plan.clone();
            plan.current_density = Some([1.4e11 * scale, 0.0, 0.0]);
            plan.stt_degree = Some(0.62);
            plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
            plan.stt_lambda = Some(1.8);
            plan.stt_epsilon_prime = Some(0.03);
            plan.slonczewski_formula_version = Some("slonczewski.fullmag.v2".to_string());
            plan.slonczewski_stack_normal = Some([2.0, 0.0, 0.0]);
            plan.slonczewski_active_mask = plan.active_mask.clone();

            let mut backend = NativeFdmBackend::create(&plan).expect("native fdm scaled create");
            backend
                .step(plan.fixed_timestep.expect("fixed timestep"))
                .expect("native fdm scaled step");
            backend
                .copy_m(plan.initial_magnetization.len())
                .expect("copy scaled m")
        };

        let half = run_at_scale(0.5);
        let unit = run_at_scale(1.0);
        let double = run_at_scale(2.0);
        let active_mask = base_plan.active_mask.as_ref().expect("active mask");

        for index in 0..baseline.len() {
            if !active_mask[index] {
                assert_eq!(
                    half[index], baseline[index],
                    "inactive half-current leak at {index}"
                );
                assert_eq!(
                    unit[index], baseline[index],
                    "inactive unit-current leak at {index}"
                );
                assert_eq!(
                    double[index], baseline[index],
                    "inactive double-current leak at {index}"
                );
                continue;
            }

            let increment_norm = |state: &[f64; 3]| {
                state
                    .iter()
                    .zip(baseline[index].iter())
                    .map(|(value, reference)| (value - reference).powi(2))
                    .sum::<f64>()
                    .sqrt()
            };
            let half_norm = increment_norm(&half[index]);
            let unit_norm = increment_norm(&unit[index]);
            let double_norm = increment_norm(&double[index]);
            assert!(
                unit_norm > 1.0e-10,
                "current-scaling response is numerically zero at active cell {index}: {unit_norm:.6e}"
            );

            let half_error = (unit_norm - 2.0 * half_norm).abs();
            let double_error = (double_norm - 4.0 * half_norm).abs();
            let scale = unit_norm.max(double_norm).max(1.0e-30);
            assert!(
                half_error <= 2.0e-4 * scale,
                "0.5x/1x current scaling mismatch at active cell {index}: half={half_norm:.9e} unit={unit_norm:.9e} error={half_error:.3e}"
            );
            assert!(
                double_error <= 4.0e-4 * scale,
                "1x/2x current scaling mismatch at active cell {index}: half={half_norm:.9e} double={double_norm:.9e} error={double_error:.3e}"
            );
        }
    }

    #[test]
    fn native_fdm_prescribed_sot_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available()
    {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM prescribed SOT trajectory parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.enable_exchange = false;
        plan.external_field = None;
        plan.fixed_timestep = Some(1.0e-15);
        plan.sot_formula_version = Some("prescribed_sot.fullmag.v1".to_string());
        plan.sot_current_density = Some(-4.0e11);
        plan.sot_xi_dl = Some(0.12);
        plan.sot_xi_fl = Some(-0.03);
        plan.sot_sigma = Some([0.0, 1.0, 0.0]);
        plan.sot_thickness = Some(1.5e-9);
        plan.sot_target = Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        });
        plan.sot_drive = Some(fullmag_ir::PrescribedSotV1DriveIR::SignedScalar {
            current_density_apm2: -4.0e11,
            sigma_hat: [0.0, 1.0, 0.0],
            envelope: None,
        });
        plan.sot_active_mask = Some(vec![
            true, false, true, false, false, false, true, false, false,
        ]);

        let dt = plan.fixed_timestep.expect("fixed timestep");
        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        for step in 1..=8 {
            backend
                .step(dt)
                .expect("native fdm prescribed SOT trajectory step");
            let expected = crate::fdm::cpu::reference::execute_reference_fdm(
                &plan,
                dt * step as f64,
                &[],
                None,
                None,
            )
            .expect("cpu reference prescribed SOT trajectory");
            let actual_m = backend
                .copy_m(plan.initial_magnetization.len())
                .expect("copy prescribed SOT trajectory m");

            assert_vector_field_close(
                &format!("prescribed SOT trajectory step {step}"),
                &actual_m,
                &expected.result.final_magnetization,
                1e-6,
                1e-10,
            );
        }
    }

    #[test]
    fn native_fdm_prescribed_sot_has_bounded_current_scaling_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM prescribed SOT current-scaling test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut base_plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        base_plan.enable_exchange = false;
        base_plan.external_field = None;
        base_plan.fixed_timestep = Some(1.0e-15);

        let mut baseline_backend =
            NativeFdmBackend::create(&base_plan).expect("native fdm SOT baseline create");
        baseline_backend
            .step(base_plan.fixed_timestep.expect("fixed timestep"))
            .expect("native fdm SOT baseline step");
        let baseline = baseline_backend
            .copy_m(base_plan.initial_magnetization.len())
            .expect("copy SOT baseline m");

        let run_at_scale = |scale: f64| {
            let mut plan = base_plan.clone();
            plan.sot_formula_version = Some("prescribed_sot.fullmag.v1".to_string());
            plan.sot_current_density = Some(-4.0e11 * scale);
            plan.sot_xi_dl = Some(0.12);
            plan.sot_xi_fl = Some(-0.03);
            plan.sot_sigma = Some([0.0, 1.0, 0.0]);
            plan.sot_thickness = Some(1.5e-9);
            plan.sot_target = Some(fullmag_ir::RegionRefIR {
                object_id: "strip".to_string(),
                region_id: None,
            });
            plan.sot_drive = Some(fullmag_ir::PrescribedSotV1DriveIR::SignedScalar {
                current_density_apm2: -4.0e11 * scale,
                sigma_hat: [0.0, 1.0, 0.0],
                envelope: None,
            });
            plan.sot_active_mask = Some(vec![
                true, false, true, false, false, false, true, false, false,
            ]);

            let mut backend =
                NativeFdmBackend::create(&plan).expect("native fdm scaled SOT create");
            backend
                .step(plan.fixed_timestep.expect("fixed timestep"))
                .expect("native fdm scaled SOT step");
            backend
                .copy_m(plan.initial_magnetization.len())
                .expect("copy scaled SOT m")
        };

        let half = run_at_scale(0.5);
        let unit = run_at_scale(1.0);
        let double = run_at_scale(2.0);
        let active_mask = base_plan.active_mask.as_ref().expect("active mask");
        let target_mask = [true, false, true, false, false, false, true, false, false];

        for index in 0..baseline.len() {
            if !active_mask[index] || !target_mask[index] {
                assert_eq!(
                    half[index], baseline[index],
                    "inactive/untargeted half-current SOT leak at {index}"
                );
                assert_eq!(
                    unit[index], baseline[index],
                    "inactive/untargeted unit-current SOT leak at {index}"
                );
                assert_eq!(
                    double[index], baseline[index],
                    "inactive/untargeted double-current SOT leak at {index}"
                );
                continue;
            }

            let increment_norm = |state: &[f64; 3]| {
                state
                    .iter()
                    .zip(baseline[index].iter())
                    .map(|(value, reference)| (value - reference).powi(2))
                    .sum::<f64>()
                    .sqrt()
            };
            let half_norm = increment_norm(&half[index]);
            let unit_norm = increment_norm(&unit[index]);
            let double_norm = increment_norm(&double[index]);
            assert!(
                unit_norm > 1.0e-10,
                "SOT current-scaling response is numerically zero at active target cell {index}: {unit_norm:.6e}"
            );

            let half_error = (unit_norm - 2.0 * half_norm).abs();
            let double_error = (double_norm - 4.0 * half_norm).abs();
            let scale = unit_norm.max(double_norm).max(1.0e-30);
            assert!(
                half_error <= 2.0e-4 * scale,
                "0.5x/1x SOT current scaling mismatch at cell {index}: half={half_norm:.9e} unit={unit_norm:.9e} error={half_error:.3e}"
            );
            assert!(
                double_error <= 4.0e-4 * scale,
                "1x/2x SOT current scaling mismatch at cell {index}: half={half_norm:.9e} double={double_norm:.9e} error={double_error:.3e}"
            );
        }
    }

    #[test]
    fn native_fdm_mumax3_zhang_li_matches_cpu_reference_for_one_masked_step_when_cuda_is_available()
    {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM MuMax3 Zhang-Li parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.enable_exchange = false;
        plan.external_field = None;
        plan.current_density = Some([1.4e11, -2.0e10, 3.0e10]);
        plan.stt_degree = Some(0.62);
        plan.stt_beta = Some(0.07);
        plan.zhang_li_formula_version = Some("zhang_li.mumax3.v1".to_string());
        plan.zhang_li_operator_version = Some("zl_mumax3_central_v1".to_string());
        plan.zhang_li_lande_g = Some(2.0);

        let expected =
            crate::fdm::cpu::reference::execute_reference_fdm(&plan, 2.5e-13, &[], None, None)
                .expect("cpu reference MuMax3 Zhang-Li run");
        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm MuMax3 Zhang-Li step");
        let actual_m = backend
            .copy_m(plan.initial_magnetization.len())
            .expect("copy m");

        assert_vector_field_close(
            "m",
            &actual_m,
            &expected.result.final_magnetization,
            5e-8,
            1e-10,
        );
    }

    #[test]
    fn native_fdm_observable_fields_keep_full_domain_stray_field_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM masked demag test: CUDA backend is not available on this host"
            );
            return;
        }

        let plan = make_masked_test_plan(true, ExecutionPrecision::Double);
        let active_mask = plan.active_mask.clone().expect("active mask");
        let cell_count = plan.initial_magnetization.len();

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");

        let actual_m = backend.copy_m(cell_count).expect("copy m");
        let actual_h_demag = backend.copy_h_demag(cell_count).expect("copy H_demag");
        let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
        let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

        for (index, is_active) in active_mask.iter().enumerate() {
            if !is_active {
                assert_eq!(
                    actual_m[index],
                    [0.0, 0.0, 0.0],
                    "inactive m leak at {index}"
                );
                assert_eq!(
                    actual_h_ext[index],
                    plan.external_field.expect("external field"),
                    "inactive H_ext should remain full-domain at {index}"
                );
                assert_eq!(
                    actual_h_eff[index],
                    [
                        actual_h_demag[index][0] + actual_h_ext[index][0],
                        actual_h_demag[index][1] + actual_h_ext[index][1],
                        actual_h_demag[index][2] + actual_h_ext[index][2],
                    ],
                    "inactive H_eff should combine full-domain demag and external field at {index}"
                );
            } else {
                assert_eq!(
                    actual_h_ext[index],
                    plan.external_field.expect("external field"),
                    "active H_ext mismatch at {index}"
                );
            }
        }

        assert!(
            actual_h_demag
                .iter()
                .zip(active_mask.iter())
                .any(|(value, is_active)| !*is_active && *value != [0.0, 0.0, 0.0]),
            "expected at least one inactive Airbox cell to carry non-zero H_demag"
        );
    }

    #[test]
    fn native_fdm_generalized_oersted_matches_cpu_reference_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM generalized Oersted parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.oersted_field_xyz = Some(vec![
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.5, 0.5, 0.5],
            [0.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [-1.0, 0.0, 0.0],
            [-0.5, -0.5, -0.5],
            [0.25, 0.0, 0.0],
        ]);
        plan.oersted_realization = Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);
        let cell_count = plan.initial_magnetization.len();

        let (
            expected_m,
            expected_h_ex,
            _expected_h_demag,
            expected_h_ext,
            _expected_h_ani,
            expected_h_eff,
            expected_report,
        ) = cpu_reference_single_step(&plan);
        let mut expected_h_oe = plan.oersted_field_xyz.clone().expect("oersted field");
        for (i, val) in expected_h_oe.iter_mut().enumerate() {
            if !plan.active_mask.as_ref().map_or(true, |mask| mask[i]) {
                val[0] = 0.0;
                val[1] = 0.0;
                val[2] = 0.0;
            }
        }

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");
        let actual_m = backend.copy_m(cell_count).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
        let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
        let actual_h_oe = backend.copy_h_oe(cell_count).expect("copy H_OE");
        let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

        let mut expected_h_ext_without_oe = expected_h_ext.clone();
        for (i, val) in expected_h_ext_without_oe.iter_mut().enumerate() {
            if plan.active_mask.as_ref().map_or(true, |mask| mask[i]) {
                val[0] -= expected_h_oe[i][0];
                val[1] -= expected_h_oe[i][1];
                val[2] -= expected_h_oe[i][2];
            }
        }

        assert_vector_field_close("m", &actual_m, &expected_m, 5e-6, 1e-8);
        assert_vector_field_close("H_ex", &actual_h_ex, &expected_h_ex, 5e-5, 1e-2);
        assert_vector_field_close(
            "H_ext",
            &actual_h_ext,
            &expected_h_ext_without_oe,
            1e-12,
            1e-12,
        );
        assert_vector_field_close("H_OE", &actual_h_oe, &expected_h_oe, 1e-12, 1e-12);
        let mut expected_h_eff_masked = expected_h_eff.clone();
        for (i, val) in expected_h_eff_masked.iter_mut().enumerate() {
            if !plan.active_mask.as_ref().map_or(true, |mask| mask[i]) {
                val[0] = actual_h_eff[i][0];
                val[1] = actual_h_eff[i][1];
                val[2] = actual_h_eff[i][2];
            }
        }
        assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff_masked, 5e-5, 1e-2);

        assert_scalar_close(
            "time_seconds",
            stats.time,
            expected_report.time_seconds,
            1e-12,
            1e-18,
        );
    }

    #[test]
    fn native_fdm_static_external_profile_reaches_single_grid_effective_field_when_cuda_is_available(
    ) {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM static external profile test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.enable_exchange = false;
        plan.external_field = None;
        plan.static_external_field_xyz = Some(vec![
            [120.0, -30.0, 5.0],
            [80.0, 40.0, -10.0],
            [-25.0, 15.0, 70.0],
            [11.0, 22.0, 33.0],
            [90.0, 100.0, 110.0],
            [-4.0, -5.0, -6.0],
            [7.0, 8.0, 9.0],
            [-12.0, -13.0, -14.0],
            [1.0, 2.0, 3.0],
        ]);
        let expected = plan
            .static_external_field_xyz
            .clone()
            .expect("static profile");
        let active_mask = plan.active_mask.clone().expect("active mask");
        let cell_count = plan.initial_magnetization.len();

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        let receipt = backend
            .execution_receipt("gpu", fullmag_ir::ExecutionMode::Strict)
            .expect("static profile construction receipt");
        let workspace = receipt
            .gpu_workspace
            .expect("static profile GPU workspace receipt");
        assert!(workspace.accounting_valid);
        assert!(workspace.setup_complete);
        assert_eq!(
            workspace.total_device_allocation_count,
            workspace.setup_device_allocation_count
        );
        assert_eq!(
            workspace.total_device_allocation_bytes,
            workspace.setup_device_allocation_bytes
        );
        assert_eq!(workspace.observed_step_count, 0);
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm static profile step");

        let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
        let actual_h_oe = backend.copy_h_oe(cell_count).expect("copy H_OE");
        let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");
        let expected_active = expected
            .iter()
            .zip(active_mask.iter())
            .map(|(value, active)| if *active { *value } else { [0.0, 0.0, 0.0] })
            .collect::<Vec<_>>();

        assert_vector_field_close("H_ext", &actual_h_ext, &expected_active, 1e-12, 1e-12);
        assert_vector_field_close(
            "H_OE",
            &actual_h_oe,
            &vec![[0.0, 0.0, 0.0]; cell_count],
            1e-12,
            1e-12,
        );
        assert_vector_field_close("H_eff", &actual_h_eff, &expected_active, 1e-12, 1e-12);
    }

    #[test]
    fn native_fdm_generalized_oersted_preview_matches_expected_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM generalized Oersted preview test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.oersted_field_xyz = Some(vec![
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.5, 0.5, 0.5],
            [0.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [-1.0, 0.0, 0.0],
            [-0.5, -0.5, -0.5],
            [0.25, 0.0, 0.0],
        ]);
        plan.oersted_realization = Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);

        let request = generalized_oersted_preview_request();
        let expected_preview = build_grid_preview_field(
            &request,
            &masked_oersted_field(&plan),
            plan.grid.cells,
            plan.active_mask.as_deref(),
        );

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");

        let actual_sync = backend
            .copy_live_preview_field(&request, plan.grid.cells, plan.active_mask.as_deref())
            .expect("copy preview");
        let actual_async = backend
            .begin_live_preview_snapshot(&request, plan.grid.cells)
            .expect("begin preview snapshot")
            .into_live_preview_field(plan.active_mask.as_deref())
            .expect("collect preview snapshot");

        assert_eq!(actual_sync.quantity, "H_oe");
        assert_eq!(actual_sync.unit, expected_preview.unit);
        assert_eq!(
            actual_sync.quantity_domain,
            expected_preview.quantity_domain
        );
        assert_eq!(actual_sync.preview_grid, expected_preview.preview_grid);
        assert_eq!(actual_sync.active_mask, expected_preview.active_mask);
        assert_eq!(actual_async.active_mask, expected_preview.active_mask);
        assert_eq!(
            actual_sync.vector_field_values, expected_preview.vector_field_values,
            "synchronous preview should preserve H_OE values"
        );
        assert_eq!(
            actual_async.vector_field_values, expected_preview.vector_field_values,
            "async preview snapshot should preserve H_OE values"
        );
    }

    #[test]
    fn native_fdm_generalized_oersted_field_snapshot_matches_expected_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM generalized Oersted field snapshot test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(false, ExecutionPrecision::Double);
        plan.oersted_field_xyz = Some(vec![
            [0.0, 0.0, 1.0],
            [0.0, 1.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.5, 0.5, 0.5],
            [0.0, 0.0, 0.0],
            [0.0, -1.0, 0.0],
            [-1.0, 0.0, 0.0],
            [-0.5, -0.5, -0.5],
            [0.25, 0.0, 0.0],
        ]);
        plan.oersted_realization = Some(fullmag_ir::OerstedRealization::BiotSavartMidpoint);

        let expected_h_oe = masked_oersted_field(&plan);
        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");

        let mut snapshot = backend
            .begin_field_snapshot("H_OE", 3, 0.0, plan.fixed_timestep.unwrap_or(0.0))
            .expect("begin H_OE field snapshot");
        let _info = snapshot.info().expect("snapshot info");
        let mut payload = Vec::new();
        let written_info = snapshot
            .write_payload(&mut payload)
            .expect("snapshot payload");
        assert_eq!(written_info.cell_count, expected_h_oe.len());
        assert_eq!(written_info.component_count, 3);
        let decoded = decode_snapshot_payload(written_info, &payload);
        assert_vector_field_close("H_OE.snapshot", &decoded, &expected_h_oe, 1e-12, 1e-12);
    }

    #[test]
    fn native_fdm_single_precision_stays_close_to_double_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM single-precision parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let double_plan = make_masked_test_plan(true, ExecutionPrecision::Double);
        let mut single_plan = double_plan.clone();
        single_plan.precision = ExecutionPrecision::Single;
        let cell_count = double_plan.initial_magnetization.len();

        let mut backend_double =
            NativeFdmBackend::create(&double_plan).expect("native fdm create double");
        let stats_double = backend_double
            .step(double_plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm double step");
        let m_double = backend_double.copy_m(cell_count).expect("copy m double");
        let h_eff_double = backend_double
            .copy_h_eff(cell_count)
            .expect("copy H_eff double");

        let mut backend_single =
            NativeFdmBackend::create(&single_plan).expect("native fdm create single");
        let stats_single = backend_single
            .step(single_plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm single step");
        let m_single = backend_single.copy_m(cell_count).expect("copy m single");
        let h_eff_single = backend_single
            .copy_h_eff(cell_count)
            .expect("copy H_eff single");

        let max_m_diff = max_vector_component_diff(&m_single, &m_double);
        assert!(
            max_m_diff <= 1e-5,
            "single precision magnetization drift too large: {max_m_diff:.6e}"
        );

        let max_h_eff_diff = max_vector_component_diff(&h_eff_single, &h_eff_double);
        assert!(
            max_h_eff_diff <= 5e-1,
            "single precision H_eff drift too large: {max_h_eff_diff:.6e}"
        );

        assert_scalar_close(
            "single_vs_double.exchange_energy",
            stats_single.e_ex,
            stats_double.e_ex,
            1e-4,
            1e-18,
        );
        assert_scalar_close(
            "single_vs_double.demag_energy",
            stats_single.e_demag,
            stats_double.e_demag,
            1e-4,
            1e-18,
        );
        assert_scalar_close(
            "single_vs_double.total_energy",
            stats_single.e_total,
            stats_double.e_total,
            1e-4,
            1e-18,
        );
        assert_scalar_close(
            "single_vs_double.max_rhs",
            stats_single.max_dm_dt,
            stats_double.max_dm_dt,
            1e-4,
            1e-8,
        );
    }

    #[test]
    fn native_fdm_single_precision_f32_transfers_match_f64_exports_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM single-precision transfer test: CUDA backend is not available on this host"
            );
            return;
        }

        let plan = make_masked_test_plan(true, ExecutionPrecision::Single);
        let active_mask = plan.active_mask.clone().expect("active mask");
        let cell_count = plan.initial_magnetization.len();

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create single");
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm single step");

        let m_f64 = backend.copy_m(cell_count).expect("copy m f64");
        let h_eff_f64 = backend.copy_h_eff(cell_count).expect("copy H_eff f64");
        let m_f32 = backend.copy_m_f32(cell_count).expect("copy m f32");
        let h_eff_f32 = backend.copy_h_eff_f32(cell_count).expect("copy H_eff f32");

        assert!(
            max_vector_component_diff_f32(&m_f32, &m_f64) <= 1e-6,
            "f32 m export diverged from f64 export"
        );
        assert!(
            max_vector_component_diff_f32(&h_eff_f32, &h_eff_f64) <= 1e-3,
            "f32 H_eff export diverged from f64 export"
        );

        let upload = plan
            .initial_magnetization
            .iter()
            .enumerate()
            .map(|(index, value)| {
                let sign = if index % 2 == 0 { -1.0f32 } else { 1.0f32 };
                [
                    sign * value[0] as f32,
                    sign * value[1] as f32,
                    sign * value[2] as f32,
                ]
            })
            .collect::<Vec<_>>();

        backend
            .upload_magnetization_f32(&upload)
            .expect("upload f32 magnetization");
        backend
            .refresh_observables()
            .expect("refresh observables after f32 upload");
        let roundtrip = backend
            .copy_m_f32(cell_count)
            .expect("roundtrip copy m f32");

        for (index, is_active) in active_mask.iter().enumerate() {
            let expected = if *is_active {
                upload[index]
            } else {
                [0.0, 0.0, 0.0]
            };
            for component in 0..3 {
                let diff = (roundtrip[index][component] - expected[component]).abs();
                assert!(
                    diff <= 1e-6,
                    "roundtrip mismatch at cell {index} component {component}: actual={} expected={}",
                    roundtrip[index][component],
                    expected[component]
                );
            }
        }
    }

    #[test]
    fn native_fdm_single_precision_energy_density_snapshots_match_double_and_global_energy_when_cuda_is_available(
    ) {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM single-precision energy-density qualification: CUDA backend is not available on this host"
            );
            return;
        }

        let mut double_plan = make_masked_test_plan(true, ExecutionPrecision::Double);
        double_plan.material.uniaxial_anisotropy_ku1 = Some(8.0e4);
        double_plan.material.uniaxial_anisotropy_ku2 = Some(1.0e4);
        double_plan.material.anisotropy_axis = Some([0.0, 0.0, 1.0]);
        double_plan.interfacial_dmi = Some(1.2e-3);
        let mut single_plan = double_plan.clone();
        single_plan.precision = ExecutionPrecision::Single;

        let cell_count = double_plan.initial_magnetization.len();
        let active_mask = double_plan.active_mask.as_ref().expect("active mask");
        let cell_volume = double_plan.cell_size.iter().product::<f64>();

        let mut backend_double = NativeFdmBackend::create(&double_plan)
            .expect("native fdm create double energy-density qualification");
        let stats_double = backend_double
            .step(double_plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm double step");
        let mut backend_single = NativeFdmBackend::create(&single_plan)
            .expect("native fdm create single energy-density qualification");
        let stats_single = backend_single
            .step(single_plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm single step");

        let quantities = [
            ("eden_ex", stats_double.e_ex, stats_single.e_ex),
            ("eden_demag", stats_double.e_demag, stats_single.e_demag),
            ("eden_ext", stats_double.e_ext, stats_single.e_ext),
            ("eden_ani", stats_double.e_ani, stats_single.e_ani),
            ("eden_dmi", stats_double.e_dmi, stats_single.e_dmi),
            ("eden_total", stats_double.e_total, stats_single.e_total),
        ];

        for (quantity, expected_double, expected_single) in quantities {
            let values_double = backend_double
                .copy_scalar_quantity(quantity, cell_count)
                .expect("double scalar energy-density copy");
            let values_single = backend_single
                .copy_scalar_quantity(quantity, cell_count)
                .expect("single scalar energy-density copy");
            assert_eq!(values_double.len(), cell_count);
            assert_eq!(values_single.len(), cell_count);

            let max_double = values_double
                .iter()
                .copied()
                .map(f64::abs)
                .fold(0.0, f64::max);
            let max_diff = values_double
                .iter()
                .zip(values_single.iter())
                .map(|(double, single)| (double - single).abs())
                .fold(0.0, f64::max);
            assert!(
                max_diff <= max_double * 5.0e-3 + 1.0e-6,
                "{quantity} FP32/FP64 pointwise drift too large: max_diff={max_diff:.6e}, max_double={max_double:.6e}"
            );

            for (index, is_active) in active_mask.iter().copied().enumerate() {
                if !is_active {
                    assert_eq!(values_double[index], 0.0, "inactive {quantity} double leak");
                    assert_eq!(values_single[index], 0.0, "inactive {quantity} single leak");
                }
            }

            let integral_double = values_double.iter().sum::<f64>() * cell_volume;
            let integral_single = values_single.iter().sum::<f64>() * cell_volume;
            assert_scalar_close(
                &format!("{quantity}.double_integral"),
                integral_double,
                expected_double,
                5.0e-4,
                1.0e-21,
            );
            assert_scalar_close(
                &format!("{quantity}.single_integral"),
                integral_single,
                expected_single,
                5.0e-3,
                1.0e-21,
            );
        }
    }

    #[test]
    fn native_fdm_fp64_observable_fields_and_densities_match_cpu_reference_when_cuda_is_available()
    {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM CPU/FP64 observable parity: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_masked_test_plan(true, ExecutionPrecision::Double);
        plan.material.uniaxial_anisotropy_ku1 = Some(8.0e4);
        plan.material.uniaxial_anisotropy_ku2 = Some(1.0e4);
        plan.material.anisotropy_axis = Some([0.0, 0.0, 1.0]);
        let active_mask = plan.active_mask.as_ref().expect("active mask");
        let cell_count = plan.initial_magnetization.len();

        let (
            expected_m,
            expected_h_ex,
            expected_h_demag,
            expected_h_ext,
            expected_h_ani,
            expected_h_eff,
            _expected_report,
        ) = cpu_reference_single_step(&plan);
        let expected_densities = cpu_reference_energy_densities_after_single_step(&plan);

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");
        let actual_m = backend.copy_m(cell_count).expect("copy m");
        assert_vector_field_close("m", &actual_m, &expected_m, 5.0e-3, 1.0e-6);

        backend
            .upload_magnetization(&expected_m)
            .expect("upload CPU reference endpoint magnetization");
        let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
        let actual_h_demag = backend.copy_h_demag(cell_count).expect("copy H_demag");
        let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
        let actual_h_ani = backend.copy_h_ani(cell_count).expect("copy H_ani");
        let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

        for index in 0..cell_count {
            if active_mask[index] {
                for (label, actual, expected) in [
                    ("H_ex", actual_h_ex[index], expected_h_ex[index]),
                    ("H_demag", actual_h_demag[index], expected_h_demag[index]),
                    ("H_ext", actual_h_ext[index], expected_h_ext[index]),
                    ("H_ani", actual_h_ani[index], expected_h_ani[index]),
                    ("H_eff", actual_h_eff[index], expected_h_eff[index]),
                ] {
                    for component in 0..3 {
                        assert_scalar_close(
                            &format!("CPU/FP64 {label}[{index}][{component}]"),
                            actual[component],
                            expected[component],
                            5.0e-3,
                            1.0e-6,
                        );
                    }
                }
            } else {
                assert_eq!(actual_m[index], [0.0, 0.0, 0.0]);
                assert_eq!(actual_h_ex[index], [0.0, 0.0, 0.0]);
                assert_eq!(actual_h_ani[index], [0.0, 0.0, 0.0]);
            }
        }

        let quantities = [
            "eden_ex",
            "eden_demag",
            "eden_ext",
            "eden_ani",
            "eden_dmi",
            "eden_total",
        ];
        let mut max_density_drift: f64 = 0.0;
        for (quantity_index, quantity) in quantities.iter().enumerate() {
            let actual = backend
                .copy_scalar_quantity(quantity, cell_count)
                .expect("CUDA scalar density copy");
            let expected = &expected_densities[quantity_index];
            for (index, (&actual_value, &expected_value)) in
                actual.iter().zip(expected.iter()).enumerate()
            {
                if active_mask[index] {
                    assert_scalar_close(
                        &format!("CPU/FP64 {quantity}[{index}]"),
                        actual_value,
                        expected_value,
                        5.0e-3,
                        1.0e-3,
                    );
                    max_density_drift =
                        max_density_drift.max((actual_value - expected_value).abs());
                } else {
                    assert_eq!(actual_value, 0.0, "inactive {quantity} must be zero");
                }
            }
        }
        println!(
            "FDM observable CPU/FP64 parity: max_density_abs_drift={max_density_drift:.6e}, active_cells={}",
            active_mask.iter().filter(|active| **active).count()
        );
    }

    #[test]
    fn native_fdm_thin_film_demag_matches_cpu_reference_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM thin-film demag parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let plan = make_thin_film_demag_plan();
        let cell_count = plan.initial_magnetization.len();
        let (
            expected_m,
            expected_h_ex,
            expected_h_demag,
            expected_h_ext,
            _expected_h_ani,
            expected_h_eff,
            expected_report,
        ) = cpu_reference_single_step(&plan);

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");
        let actual_m = backend.copy_m(cell_count).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
        let actual_h_demag = backend.copy_h_demag(cell_count).expect("copy H_demag");
        let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
        let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

        assert_vector_field_close("thin.m", &actual_m, &expected_m, 5e-6, 1e-8);
        assert_vector_field_close("thin.H_ex", &actual_h_ex, &expected_h_ex, 5e-5, 5e-2);
        assert_vector_field_close(
            "thin.H_demag",
            &actual_h_demag,
            &expected_h_demag,
            5e-4,
            1e-1,
        );
        assert_vector_field_close("thin.H_ext", &actual_h_ext, &expected_h_ext, 1e-12, 1e-12);
        assert_vector_field_close("thin.H_eff", &actual_h_eff, &expected_h_eff, 5e-4, 1e-1);

        assert_scalar_close(
            "thin.exchange_energy",
            stats.e_ex,
            expected_report.exchange_energy_joules,
            5e-5,
            1e-21,
        );
        assert_scalar_close(
            "thin.demag_energy",
            stats.e_demag,
            expected_report.demag_energy_joules,
            5e-4,
            1e-21,
        );
        assert_scalar_close(
            "thin.external_energy",
            stats.e_ext,
            expected_report.external_energy_joules,
            5e-6,
            1e-21,
        );
        assert_scalar_close(
            "thin.total_energy",
            stats.e_total,
            expected_report.total_energy_joules,
            5e-4,
            1e-21,
        );
    }

    #[test]
    fn native_fdm_periodic_truncated_demag_matches_cpu_reference_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM periodic demag parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_thin_film_demag_plan();
        plan.periodicity = Some(FdmPeriodicityIR {
            axes: [
                AxisBoundary::Periodic,
                AxisBoundary::Periodic,
                AxisBoundary::Open,
            ],
            demag: FdmDemagPeriodicityIR::TruncatedImages,
            image_counts: Some([2, 2, 0]),
        });
        plan.resolved_periodic_images = plan
            .periodicity
            .as_ref()
            .expect("periodic request")
            .resolve_periodic_images(plan.grid.cells, plan.precision)
            .expect("valid periodic image request");
        let cell_count = plan.initial_magnetization.len();
        let (
            expected_m,
            _expected_h_ex,
            expected_h_demag,
            _expected_h_ext,
            _expected_h_ani,
            _expected_h_eff,
            expected_report,
        ) = cpu_reference_single_step(&plan);

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");
        let actual_m = backend.copy_m(cell_count).expect("copy m");
        let actual_h_demag = backend.copy_h_demag(cell_count).expect("copy H_demag");

        assert_vector_field_close("periodic_demag.m", &actual_m, &expected_m, 5e-6, 1e-8);
        assert_vector_field_close(
            "periodic_demag.H_demag",
            &actual_h_demag,
            &expected_h_demag,
            1e-3,
            1e-1,
        );
        assert_scalar_close(
            "periodic_demag.demag_energy",
            stats.e_demag,
            expected_report.demag_energy_joules,
            1e-3,
            1e-21,
        );
    }

    #[test]
    fn native_fdm_periodic_exchange_matches_cpu_reference_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM periodic exchange parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let mut plan = make_thin_film_demag_plan();
        plan.enable_demag = false;
        plan.periodicity = Some(FdmPeriodicityIR {
            axes: [
                AxisBoundary::Periodic,
                AxisBoundary::Periodic,
                AxisBoundary::Open,
            ],
            demag: FdmDemagPeriodicityIR::Open,
            image_counts: None,
        });
        let cell_count = plan.initial_magnetization.len();
        let (
            expected_m,
            expected_h_ex,
            _expected_h_demag,
            expected_h_ext,
            _expected_h_ani,
            expected_h_eff,
            expected_report,
        ) = cpu_reference_single_step(&plan);

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");
        let actual_m = backend.copy_m(cell_count).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
        let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
        let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

        assert_vector_field_close("periodic_exchange.m", &actual_m, &expected_m, 5e-6, 1e-8);
        assert_vector_field_close(
            "periodic_exchange.H_ex",
            &actual_h_ex,
            &expected_h_ex,
            5e-5,
            5e-2,
        );
        assert_vector_field_close(
            "periodic_exchange.H_ext",
            &actual_h_ext,
            &expected_h_ext,
            1e-12,
            1e-12,
        );
        assert_vector_field_close(
            "periodic_exchange.H_eff",
            &actual_h_eff,
            &expected_h_eff,
            5e-5,
            5e-2,
        );
        assert_scalar_close(
            "periodic_exchange.exchange_energy",
            stats.e_ex,
            expected_report.exchange_energy_joules,
            5e-5,
            1e-21,
        );
    }

    #[test]
    fn native_fdm_relaxation_disables_precession_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM relaxation test: CUDA backend is not available on this host"
            );
            return;
        }

        let plan = make_relaxation_precession_test_plan();
        let cell_count = plan.initial_magnetization.len();
        let (expected_m, _, _, _, _, _, expected_report) = cpu_reference_single_step(&plan);

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");
        let actual_m = backend.copy_m(cell_count).expect("copy m");

        assert_vector_field_close("relax.m", &actual_m, &expected_m, 5e-6, 1e-10);
        assert!(
            actual_m[0][1].abs() <= 1e-10,
            "relaxation should not precess into y, got {:?}",
            actual_m[0]
        );
        assert!(
            actual_m[0][2] > 0.0,
            "relaxation should move toward +z field, got {:?}",
            actual_m[0]
        );
        assert_scalar_close(
            "relax.max_rhs",
            stats.max_dm_dt,
            expected_report.max_rhs_amplitude,
            5e-6,
            1e-10,
        );
    }
}

#[cfg(test)]
mod exact_metric_contract_tests {
    use super::{
        ensure_cuda_slonczewski_supported, reject_cuda_multilayer_containment,
        validate_multilayer_stage_telemetry, validate_native_step_metrics,
    };

    fn containment_layer(name: &str, z: f64) -> fullmag_ir::FdmLayerPlanIR {
        fullmag_ir::FdmLayerPlanIR {
            magnet_name: name.to_string(),
            layer_id: format!("layer:{name}"),
            object_id: name.to_string(),
            native_grid: [2, 2, 1],
            native_cell_size: [2e-9, 2e-9, 1e-9],
            native_origin: [-2e-9, -2e-9, z],
            native_active_mask: None,
            native_region_mask: None,
            native_region_legend: None,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: fullmag_ir::FdmMaterialIR::default(),
            convolution_grid: [2, 2, 1],
            convolution_cell_size: [2e-9, 2e-9, 1e-9],
            convolution_origin: [-2e-9, -2e-9, z],
            transfer_kind: "identity".to_string(),
        }
    }

    #[test]
    fn cuda_multilayer_containment_guard_runs_without_cuda_or_allocation() {
        let legal = vec![
            containment_layer("free", 0.0),
            containment_layer("ref", 3e-9),
        ];
        reject_cuda_multilayer_containment(false, "two_d_stack", &legal)
            .expect("inactive demag does not activate containment");
        reject_cuda_multilayer_containment(true, "three_d", &legal)
            .expect("three_d identity stack remains legal");

        let two_d = reject_cuda_multilayer_containment(true, "two_d_stack", &legal)
            .expect_err("two_d_stack must fail before CUDA interaction");
        assert!(two_d
            .message
            .contains("fdm_cuda_multilayer_two_d_stack_unqualified"));

        let mut push_pull = legal.clone();
        push_pull[1].transfer_kind = "push_pull".to_string();
        let push_pull = reject_cuda_multilayer_containment(true, "three_d", &push_pull)
            .expect_err("push_pull must fail before CUDA interaction");
        assert!(push_pull
            .message
            .contains("fdm_cuda_multilayer_push_pull_unqualified"));

        let mut heterogeneous_hz = legal.clone();
        heterogeneous_hz[1].native_cell_size[2] = 2e-9;
        let heterogeneous_hz =
            reject_cuda_multilayer_containment(true, "three_d", &heterogeneous_hz)
                .expect_err("heterogeneous native h_z must fail before CUDA interaction");
        assert!(heterogeneous_hz
            .message
            .contains("fdm_cuda_multilayer_heterogeneous_native_hz_unqualified"));

        let mut xy_offset = legal;
        xy_offset[1].native_origin[0] += 2e-9;
        let xy_offset = reject_cuda_multilayer_containment(true, "three_d", &xy_offset)
            .expect_err("XY offset must fail before CUDA interaction");
        assert!(xy_offset
            .message
            .contains("fdm_cuda_multilayer_xy_offset_unqualified"));
    }

    #[test]
    fn canonical_slonczewski_requires_stack_normal_and_target_mask_before_native_cuda_construction()
    {
        let mut plan = fullmag_ir::FdmPlanIR::default();
        plan.slonczewski_formula_version = Some("slonczewski.fullmag.v2".to_string());
        plan.current_density = Some([0.0, 0.0, 7.0e11]);
        plan.stt_degree = Some(0.6);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.7);
        plan.slonczewski_stack_normal = Some([0.0, 0.0, 1.0]);

        let error = ensure_cuda_slonczewski_supported(&plan)
            .expect_err("canonical Slonczewski must fail closed without its target contract");
        assert!(error.message.contains("slonczewski.fullmag.v2"));
        assert!(error.message.contains("CUDA"));
        assert!(error.message.contains("target mask"));
    }

    #[test]
    fn canonical_slonczewski_with_complete_target_contract_reaches_native_descriptor() {
        let mut plan = fullmag_ir::FdmPlanIR::default();
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]];
        plan.slonczewski_formula_version = Some("slonczewski.fullmag.v2".to_string());
        plan.current_density = Some([0.0, 0.0, 7.0e11]);
        plan.stt_degree = Some(0.6);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.7);
        plan.slonczewski_stack_normal = Some([0.0, 0.0, 1.0]);
        plan.slonczewski_active_mask = Some(vec![true]);

        ensure_cuda_slonczewski_supported(&plan)
            .expect("complete canonical Slonczewski target contract should be accepted");
    }

    #[test]
    fn fdm_native_exact_torque_value_is_independent_of_rhs_norm() {
        let metrics = validate_native_step_metrics(7.0, 13.0).expect("valid native metrics");

        assert_eq!(metrics.max_torque_apm, 7.0);
        assert_eq!(metrics.max_rhs_norm_per_s, 13.0);
    }

    #[test]
    fn fdm_native_exact_zero_torque_is_not_replaced_by_nonzero_rhs() {
        let metrics = validate_native_step_metrics(0.0, 13.0).expect("valid native metrics");

        assert_eq!(metrics.max_torque_apm, 0.0);
        assert_eq!(metrics.max_rhs_norm_per_s, 13.0);
    }

    #[test]
    fn fdm_native_rejects_nonfinite_or_negative_metrics() {
        for (torque, rhs) in [
            (f64::NAN, 1.0),
            (f64::INFINITY, 1.0),
            (-1.0, 1.0),
            (1.0, f64::NAN),
            (1.0, f64::INFINITY),
            (1.0, -1.0),
        ] {
            assert!(validate_native_step_metrics(torque, rhs).is_err());
        }
    }

    #[test]
    fn d07_l3_stage_telemetry_requires_exact_counts() {
        let telemetry =
            validate_multilayer_stage_telemetry(3, 1, 3, 3, 9).expect("exact L=3 D-07 telemetry");

        assert_eq!(telemetry.layer_count, 3);
        assert_eq!(telemetry.refresh_count, 1);
        assert_eq!(telemetry.forward_fft_count, 3);
        assert_eq!(telemetry.inverse_fft_count, 3);
        assert_eq!(telemetry.pair_accumulation_count, 9);
    }

    #[test]
    fn d07_stage_telemetry_fails_closed_when_counters_are_absent() {
        let error = validate_multilayer_stage_telemetry(3, 0, 0, 0, 0)
            .expect_err("absent D-07 counters must not become recorded provenance");

        assert!(error.message.contains("not_recorded"));
    }

    #[test]
    fn d07_stage_telemetry_rejects_inexact_stage_counts() {
        let error = validate_multilayer_stage_telemetry(3, 1, 3, 2, 9)
            .expect_err("inexact D-07 counters must fail closed");

        assert!(error.message.contains("counter_mismatch"));
    }

    #[test]
    fn fdm_native_preserves_exact_torque_instead_of_reconstructing_from_rhs() {
        let source = include_str!("native.rs");
        let production_source = source
            .split("#[cfg(test)]\nmod exact_metric_contract_tests")
            .next()
            .expect("production source prefix");

        assert!(
            production_source.contains("max_torque_Apm: native_metrics.max_torque_apm"),
            "native CUDA stats must map the exact native torque directly"
        );
        assert!(
            production_source.contains("max_rhs_norm_per_s: native_metrics.max_rhs_norm_per_s"),
            "native CUDA stats must publish the RHS norm as a separate observable"
        );
        assert!(
            !production_source.contains("approximate_max_torque("),
            "native CUDA stats must never reconstruct equilibrium torque from RHS"
        );
    }

    #[test]
    fn dynamic_native_stats_map_the_same_energy_components_as_snapshot_stats() {
        let source = include_str!("native.rs");
        let dynamic_stats = source
            .split("pub fn step_interruptible")
            .nth(1)
            .and_then(|source| source.split("pub fn refresh_multilayer_demag").next())
            .expect("dynamic native stats implementation");

        assert!(
            dynamic_stats
                .contains("e_ani: stats.anisotropy_energy_joules + stats.cubic_energy_joules"),
            "dynamic native stats must include cubic anisotropy in e_ani"
        );
        assert!(
            dynamic_stats.contains("e_dmi: stats.dmi_energy_joules"),
            "dynamic native stats must map the native DMI energy"
        );
        let average_stats = source
            .split("pub fn apply_average_m_to_step_stats(")
            .nth(1)
            .and_then(|source| source.split("    /// Execute one time step.").next())
            .expect("native average-m helper");
        assert!(
            average_stats.contains("apply_average_m_to_step_stats_with_active_mask"),
            "native average-m helper must publish averaged magnetization components"
        );
        assert!(
            average_stats
                .contains("stats.per_object_scalars = single_object_scalars(\"free\", stats)"),
            "native average-m helper must refresh object-scoped telemetry"
        );
    }
}
