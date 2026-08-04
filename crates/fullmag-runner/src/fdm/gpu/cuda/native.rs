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
    build_grid_preview_field_from_flat_plan, plan_grid_preview, resample_grid_mask, GridPreviewPlan,
};
#[cfg(feature = "cuda")]
use crate::quantities::normalized_quantity_name;
#[cfg(feature = "cuda")]
use crate::relaxation::llg_overdamped_uses_pure_damping;
#[cfg(feature = "cuda")]
use crate::scalar_metrics::single_object_scalars;
#[cfg(any(feature = "cuda", test))]
use crate::types::RunError;
#[cfg(feature = "cuda")]
use crate::types::StepStats;
#[cfg(feature = "cuda")]
use crate::types::{LivePreviewField, LivePreviewRequest};

#[cfg(feature = "cuda")]
use std::ffi::c_void;
#[cfg(feature = "cuda")]
use std::ffi::CStr;
#[cfg(feature = "cuda")]
use std::io::Write;
#[cfg(feature = "cuda")]
use std::sync::atomic::{AtomicBool, Ordering};

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
fn validate_native_adaptive_policy(
    integrator: fullmag_ir::IntegratorChoice,
    adaptive: Option<&fullmag_ir::AdaptiveTimeStepIR>,
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
            })
        }
        fullmag_ir::AdaptiveToleranceModeIR::Advanced
            if policy.atol <= 0.0 && policy.rtol <= 0.0 =>
        {
            return Err(RunError {
                message: "advanced CUDA FDM requires positive atol or rtol".to_string(),
            })
        }
        _ => {}
    }
    if policy.max_spin_rotation.is_some() || policy.norm_tolerance.is_some() {
        return Err(RunError { message: "adaptive CUDA FDM norm/rotation guards are transported but unsupported until native enforcement is implemented".to_string() });
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
            Some(&policy(fullmag_ir::AdaptiveToleranceModeIR::MaxError))
        )
        .is_err());
        let absolute = policy(fullmag_ir::AdaptiveToleranceModeIR::Advanced);
        validate_native_adaptive_policy(fullmag_ir::IntegratorChoice::Rk45, Some(&absolute))
            .unwrap();
        let mut relative = absolute.clone();
        relative.atol = 0.0;
        relative.rtol = 1e-4;
        validate_native_adaptive_policy(fullmag_ir::IntegratorChoice::Rk45, Some(&relative))
            .unwrap();
        relative.rtol = 0.0;
        assert!(validate_native_adaptive_policy(
            fullmag_ir::IntegratorChoice::Rk45,
            Some(&relative)
        )
        .is_err());
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
            let normal_norm = (normal[0] * normal[0]
                + normal[1] * normal[1]
                + normal[2] * normal[2])
                .sqrt();
            if !normal_norm.is_finite() || normal_norm <= 0.0 {
                return Err(RunError {
                    message: "slonczewski.fullmag.v2 on FDM CUDA requires a finite nonzero stack normal".to_string(),
                });
            }
            let target_mask = plan.slonczewski_active_mask.as_ref().ok_or_else(|| RunError {
                message: "slonczewski.fullmag.v2 on FDM CUDA requires a separate target mask".to_string(),
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
fn ffi_prescribed_sot_formula(
    plan: &fullmag_ir::FdmPlanIR,
) -> Result<ffi::fullmag_fdm_prescribed_sot_formula, RunError> {
    match plan.sot_formula_version.as_deref() {
        None | Some("prescribed_sot.legacy_fullmag.v0") => Ok(
            ffi::fullmag_fdm_prescribed_sot_formula::FULLMAG_FDM_PRESCRIBED_SOT_LEGACY_V0,
        ),
        Some("prescribed_sot.fullmag.v1") => Ok(
            ffi::fullmag_fdm_prescribed_sot_formula::FULLMAG_FDM_PRESCRIBED_SOT_V1,
        ),
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
    precision: fullmag_ir::ExecutionPrecision,
    damping: f64,
    precession_enabled: bool,
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
        validate_multilayer_grid_budget(plan)?;
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
                        layer
                            .native_active_mask
                            .as_deref()
                            .map_or_else(|| vec![true; layer.initial_magnetization.len()], ToOwned::to_owned)
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
            precision: plan.precision,
            damping: first_material.map_or(0.0, |material| material.damping),
            precession_enabled: !llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
        })
    }

    pub fn create(plan: &fullmag_ir::FdmPlanIR) -> Result<Self, RunError> {
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
        let integrator = match plan
            .integrator
            .unwrap_or(fullmag_ir::IntegratorChoice::Heun)
        {
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
                _ => ffi::fullmag_fdm_slonczewski_formula::FULLMAG_FDM_SLONCZEWSKI_LEGACY_FULLMAG_V0,
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
            oersted_field_xyz: oersted_field_flat
                .as_ref()
                .map_or(std::ptr::null(), |field| field.as_ptr()),
            oersted_field_len: oersted_field_flat
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
            cubic_kc1: plan.material.cubic_anisotropy_kc1.unwrap_or(0.0),
            cubic_kc2: plan.material.cubic_anisotropy_kc2.unwrap_or(0.0),
            cubic_kc3: plan.material.cubic_anisotropy_kc3.unwrap_or(0.0),
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
            dmi_d_interfacial: plan.interfacial_dmi.unwrap_or(0.0),
            has_bulk_dmi: if plan.bulk_dmi.is_some() { 1 } else { 0 },
            dmi_d_bulk: plan.bulk_dmi.unwrap_or(0.0),
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
            stats_mode: ffi::fullmag_fdm_stats_mode::FULLMAG_FDM_STATS_FULL,
            stats_stride: 1,
        };

        let time_policy = native_time_policy(adaptive)?;
        let plan_desc_v2 = ffi::fullmag_fdm_plan_desc_v2 {
            base: plan_desc,
            time_policy,
        };

        let handle = unsafe { ffi::fullmag_fdm_backend_create_time_policy_v2(&plan_desc_v2) };
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

        Ok(Self {
            handle,
            cell_count: m_flat.len() / 3,
            active_mask: plan.active_mask.clone(),
            precision: plan.precision,
            damping: plan.material.damping,
            precession_enabled: !llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
        })
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
        };

        let rc = unsafe { ffi::fullmag_fdm_backend_step(self.handle, dt, &mut stats) };
        if rc == ffi::FULLMAG_FDM_ERR_INTERRUPTED {
            return Ok(None);
        }
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("step failed"));
        }

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

    pub fn apply_average_m_to_step_stats(&self, stats: &mut StepStats) -> Result<(), RunError> {
        let magnetization = self.copy_m(self.cell_count)?;
        self.apply_average_m_to_step_stats_from_values(stats, &magnetization);
        stats.per_object_scalars = single_object_scalars("free", stats);
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
    }

    /// Execute one time step.
    pub fn step(&mut self, dt: f64) -> Result<StepStats, RunError> {
        self.step_interruptible(dt, None)?
            .ok_or_else(|| self.last_error_or("step interrupted without an interrupt signal"))
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
            let observable = match quantity {
                "H_ex" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
                "H_demag" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
                "H_ext" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
                "H_oe" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_OE,
                "H_ani" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
                "H_eff" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
                _ => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
            };
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

    pub fn refresh_observables(&mut self) -> Result<(), RunError> {
        let rc = unsafe { ffi::fullmag_fdm_backend_refresh_observables(self.handle as *mut _) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("refresh_observables failed"));
        }
        Ok(())
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

    /// Query device info.
    pub fn device_info(&self) -> Result<DeviceInfo, RunError> {
        let mut info = ffi::fullmag_fdm_device_info {
            name: [0; 128],
            compute_capability_major: 0,
            compute_capability_minor: 0,
            driver_version: 0,
            runtime_version: 0,
        };

        let rc =
            unsafe { ffi::fullmag_fdm_backend_get_device_info(self.handle as *mut _, &mut info) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("get_device_info failed"));
        }

        let name = unsafe { CStr::from_ptr(info.name.as_ptr()) }
            .to_string_lossy()
            .to_string();

        Ok(DeviceInfo {
            name,
            compute_capability: format!(
                "{}.{}",
                info.compute_capability_major, info.compute_capability_minor
            ),
            driver_version: info.driver_version,
            runtime_version: info.runtime_version,
        })
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
            // SAFETY: `data` points to a CUDA-managed buffer valid until the
            // handle is destroyed.  We copy immediately into an owned Vec so
            // the raw pointer does not escape this block.
            let owned = unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }.to_vec();
            self.ready = Some(NativeFieldSnapshotReady {
                data: owned,
                info: NativeFieldSnapshotInfo {
                    cell_count: desc.cell_count as usize,
                    component_count: desc.component_count as usize,
                    scalar_bytes: desc.scalar_bytes as usize,
                    scalar_type,
                },
            });
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
            self.ready = Some(NativeFieldSnapshotReady {
                // SAFETY: `data` is valid until the handle is destroyed.
                // We copy immediately so the raw pointer does not escape.
                data: unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len_bytes as usize) }
                    .to_vec(),
                info: NativeFieldSnapshotInfo {
                    cell_count: desc.cell_count as usize,
                    component_count: desc.component_count as usize,
                    scalar_bytes: desc.scalar_bytes as usize,
                    scalar_type,
                },
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

/// Parsed device info.
#[cfg(feature = "cuda")]
#[derive(Debug, Clone)]
pub(crate) struct DeviceInfo {
    pub name: String,
    pub compute_capability: String,
    pub driver_version: i32,
    pub runtime_version: i32,
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
    Some(match name {
        "m" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
        "H_ex" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
        "H_demag" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
        "H_ext" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
        "H_oe" | "H_OE" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_OE,
        "H_ani" | "H_ANI" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_ANI,
        "H_eff" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
        _ => return None,
    })
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
                [0.9992009587217894, 0.0, 0.03996803834887158],
                [0.9937606691655043, 0.09970865087213879, 0.04972948160146045],
                [0.9778332467629838, 0.19771314245924698, 0.06988589031642899],
                [
                    0.9968017063026194,
                    -0.039904089712529575,
                    0.06972124896577284,
                ],
                [0.9892364775387807, 0.05946310942269411, 0.1338082836649087],
                [0.9711213242426827, 0.15730105252897553, 0.17902957342582418],
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
        let problem = ExchangeLlgProblem::with_terms_and_mask(
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
    fn native_fdm_canonical_slonczewski_matches_cpu_reference_with_target_mask_when_cuda_is_available()
    {
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
    fn native_fdm_canonical_slonczewski_matches_cpu_reference_for_fixed_trajectory_when_cuda_is_available()
    {
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

        let mut baseline_backend = NativeFdmBackend::create(&base_plan)
            .expect("native fdm baseline create");
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
    fn native_fdm_masked_demag_fields_stay_zero_outside_active_domain_when_cuda_is_available() {
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
                    actual_h_demag[index],
                    [0.0, 0.0, 0.0],
                    "inactive H_demag leak at {index}"
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
                .any(|(value, is_active)| *is_active && *value != [0.0, 0.0, 0.0]),
            "expected at least one active cell to carry non-zero H_demag"
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
    use super::{ensure_cuda_slonczewski_supported, validate_native_step_metrics};

    #[test]
    fn canonical_slonczewski_requires_stack_normal_and_target_mask_before_native_cuda_construction() {
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
    }
}
