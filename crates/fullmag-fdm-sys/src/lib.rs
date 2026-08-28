//! Raw FFI declarations for the Fullmag FDM CUDA backend.
//!
//! These match `native/include/fullmag_fdm.h` exactly.
//! All safe wrappers live in `fullmag-runner::native_fdm`.

#![allow(non_camel_case_types)]

pub mod gpu_transport_abi_v1;

use std::ffi::c_void;
use std::os::raw::c_char;

// ── Constants ──

pub const FULLMAG_FDM_MAX_EXCHANGE_REGIONS: usize = 256;
pub const FULLMAG_FDM_MAX_REGION_ID: u32 = (FULLMAG_FDM_MAX_EXCHANGE_REGIONS - 1) as u32;
pub const FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V1: u32 = 1;
pub const FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V2: u32 = 2;
pub const FULLMAG_FDM_CHECKPOINT_BACKEND_FDM: u32 = 1;
pub const FULLMAG_FDM_CHECKPOINT_POLICY_GPU_REQUIRED: u32 = 1;
pub const FULLMAG_FDM_CHECKPOINT_REALIZATION_CUDA_FDM: u32 = 1;
pub const FULLMAG_FDM_FROZEN_SPINS_ABI_V1: u32 = 1;
pub const FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1: u64 = 1_u64 << 0;
pub const FULLMAG_FDM_PLAN_DESC_ABI_V2: u32 = 2;

// ── Return codes ──

pub const FULLMAG_FDM_OK: i32 = 0;
pub const FULLMAG_FDM_ERR_INVALID: i32 = -1;
pub const FULLMAG_FDM_ERR_CUDA: i32 = -2;
pub const FULLMAG_FDM_ERR_INTERNAL: i32 = -3;
pub const FULLMAG_FDM_ERR_INTERRUPTED: i32 = -4;
pub const FULLMAG_FDM_ERR_DT_MIN_EXHAUSTED: i32 = -5;
pub const FULLMAG_FDM_ERR_ABI: i32 = -6;

// ── Enums ──

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_precision {
    FULLMAG_FDM_PRECISION_SINGLE = 1,
    FULLMAG_FDM_PRECISION_DOUBLE = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_plan_kind {
    FULLMAG_FDM_PLAN_UNIFORM_GRID = 0,
    FULLMAG_FDM_PLAN_MULTILAYER_CONV = 1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_transfer_kind {
    FULLMAG_FDM_TRANSFER_IDENTITY = 0,
    FULLMAG_FDM_TRANSFER_PUSH_PULL = 1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_integrator {
    FULLMAG_FDM_INTEGRATOR_HEUN = 1,
    FULLMAG_FDM_INTEGRATOR_DP45 = 2,
    FULLMAG_FDM_INTEGRATOR_ABM3 = 3,
    FULLMAG_FDM_INTEGRATOR_RK4 = 4,
    FULLMAG_FDM_INTEGRATOR_RK23 = 5,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_observable {
    FULLMAG_FDM_OBSERVABLE_M = 1,
    FULLMAG_FDM_OBSERVABLE_H_EX = 2,
    FULLMAG_FDM_OBSERVABLE_H_DEMAG = 3,
    FULLMAG_FDM_OBSERVABLE_H_EXT = 4,
    FULLMAG_FDM_OBSERVABLE_H_EFF = 5,
    FULLMAG_FDM_OBSERVABLE_H_OE = 6,
    FULLMAG_FDM_OBSERVABLE_H_DMI = 7,
    FULLMAG_FDM_OBSERVABLE_H_ANI = 8,
    FULLMAG_FDM_OBSERVABLE_EDEN_EX = 9,
    FULLMAG_FDM_OBSERVABLE_EDEN_DEMAG = 10,
    FULLMAG_FDM_OBSERVABLE_EDEN_EXT = 11,
    FULLMAG_FDM_OBSERVABLE_EDEN_DRIVE = 12,
    FULLMAG_FDM_OBSERVABLE_EDEN_ANI = 13,
    FULLMAG_FDM_OBSERVABLE_EDEN_DMI = 14,
    FULLMAG_FDM_OBSERVABLE_EDEN_TOTAL = 15,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_snapshot_scalar_type {
    FULLMAG_FDM_SNAPSHOT_SCALAR_F32 = 1,
    FULLMAG_FDM_SNAPSHOT_SCALAR_F64 = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_prescribed_sot_formula {
    FULLMAG_FDM_PRESCRIBED_SOT_LEGACY_V0 = 0,
    FULLMAG_FDM_PRESCRIBED_SOT_V1 = 1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_zhang_li_formula {
    FULLMAG_FDM_ZHANG_LI_LEGACY_FULLMAG_V0 = 0,
    FULLMAG_FDM_ZHANG_LI_MUMAX3_CENTRAL_V1 = 1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_slonczewski_formula {
    FULLMAG_FDM_SLONCZEWSKI_LEGACY_FULLMAG_V0 = 0,
    FULLMAG_FDM_SLONCZEWSKI_FULLMAG_V2 = 1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_boundary_correction {
    FULLMAG_FDM_BOUNDARY_NONE = 0,
    FULLMAG_FDM_BOUNDARY_VOLUME = 1,
    FULLMAG_FDM_BOUNDARY_FULL = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_exchange_pair_mode {
    FULLMAG_FDM_EXCHANGE_PAIR_UNSPECIFIED = 0,
    FULLMAG_FDM_EXCHANGE_PAIR_HARMONIC_MEAN = 1,
    FULLMAG_FDM_EXCHANGE_PAIR_EXPLICIT = 2,
    FULLMAG_FDM_EXCHANGE_PAIR_DISABLED = 3,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_exchange_pair_desc {
    pub region_i: u32,
    pub region_j: u32,
    pub mode: fullmag_fdm_exchange_pair_mode,
    pub scale: f64,
    pub inter_exchange: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_stats_mode {
    FULLMAG_FDM_STATS_FULL = 0,
    FULLMAG_FDM_STATS_NONE = 1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_llg_checkpoint_info_v1 {
    pub schema_version: u32,
    pub integrator: u32,
    pub precision: u32,
    pub array_mask: u32,
    pub cell_count: u64,
    pub payload_bytes: u64,
    pub step_count: u64,
    pub current_time: f64,
    pub current_dt: f64,
    pub transport_attempt_generation: u64,
    pub fsal_valid: u32,
    pub abm_startup: u32,
    pub abm_last_dt: f64,
    pub adaptive_has_previous_error: u32,
    pub reserved0: u32,
    pub adaptive_previous_error: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_adaptive_tolerance_mode {
    FULLMAG_FDM_ADAPTIVE_MAX_ERROR = 1,
    FULLMAG_FDM_ADAPTIVE_ADVANCED = 2,
}

pub type fullmag_fdm_interrupt_poll_fn = Option<unsafe extern "C" fn(*mut c_void) -> i32>;

// ── Descriptors ──

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_grid_desc {
    pub nx: u32,
    pub ny: u32,
    pub nz: u32,
    pub dx: f64,
    pub dy: f64,
    pub dz: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_material_desc {
    pub saturation_magnetisation: f64,
    pub exchange_stiffness: f64,
    pub damping: f64,
    pub gyromagnetic_ratio: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_complex64 {
    pub re: f64,
    pub im: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_complex32 {
    pub re: f32,
    pub im: f32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_layer_desc_v2 {
    pub native_grid: fullmag_fdm_grid_desc,
    pub convolution_grid: fullmag_fdm_grid_desc,
    pub transfer_kind: fullmag_fdm_transfer_kind,
    pub layer_index: u32,
    pub z_offset_cells: i32,
    pub material: fullmag_fdm_material_desc,
    pub has_uniaxial_anisotropy: i32,
    pub uniaxial_anisotropy_constant: f64,
    pub uniaxial_anisotropy_k2: f64,
    pub anisotropy_axis: [f64; 3],
    pub has_cubic_anisotropy: i32,
    pub cubic_kc1: f64,
    pub cubic_kc2: f64,
    pub cubic_kc3: f64,
    pub cubic_axis1: [f64; 3],
    pub cubic_axis2: [f64; 3],
    pub initial_magnetization_xyz: *const f64,
    pub initial_magnetization_len: u64,
    pub active_mask: *const u8,
    pub active_mask_len: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_tensor_kernel_desc_v2 {
    pub fft_grid: fullmag_fdm_grid_desc,
    pub dst_layer: u32,
    pub src_layer: u32,
    pub z_shift_meters: f64,
    pub kernel_xx: *const fullmag_fdm_complex64,
    pub kernel_yy: *const fullmag_fdm_complex64,
    pub kernel_zz: *const fullmag_fdm_complex64,
    pub kernel_xy: *const fullmag_fdm_complex64,
    pub kernel_xz: *const fullmag_fdm_complex64,
    pub kernel_yz: *const fullmag_fdm_complex64,
    pub kernel_len: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_multilayer_plan_desc_v2 {
    pub kind: fullmag_fdm_plan_kind,
    pub precision: fullmag_fdm_precision,
    pub integrator: fullmag_fdm_integrator,
    pub disable_precession: i32,
    pub enable_exchange: i32,
    pub enable_demag: i32,
    pub has_external_field: i32,
    pub external_field_am: [f64; 3],
    pub has_interfacial_dmi: i32,
    pub dmi_d_interfacial: f64,
    pub has_bulk_dmi: i32,
    pub dmi_d_bulk: f64,
    pub layers: *const fullmag_fdm_layer_desc_v2,
    pub layer_count: u32,
    pub kernels: *const fullmag_fdm_tensor_kernel_desc_v2,
    pub kernel_count: u32,
    pub adaptive_max_error: f64,
    pub adaptive_dt_min: f64,
    pub adaptive_dt_max: f64,
    pub adaptive_headroom: f64,
    pub stats_mode: fullmag_fdm_stats_mode,
    pub stats_stride: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
#[allow(non_snake_case)]
pub struct fullmag_fdm_plan_desc {
    pub grid: fullmag_fdm_grid_desc,
    pub material: fullmag_fdm_material_desc,
    pub precision: fullmag_fdm_precision,
    pub integrator: fullmag_fdm_integrator,
    pub disable_precession: i32,
    pub enable_exchange: i32,
    pub enable_demag: i32,
    pub has_external_field: i32,
    pub external_field_am: [f64; 3],

    pub ms_field: *const f64,
    pub ms_field_len: u64,
    pub a_field: *const f64,
    pub a_field_len: u64,
    pub alpha_field: *const f64,
    pub alpha_field_len: u64,

    // Uniaxial anisotropy
    pub has_uniaxial_anisotropy: i32,
    pub uniaxial_anisotropy_constant: f64,
    pub uniaxial_anisotropy_k2: f64,
    pub anisotropy_axis: [f64; 3],

    pub ku1_field: *const f64,
    pub ku2_field: *const f64,

    // Cubic anisotropy
    pub has_cubic_anisotropy: i32,
    pub cubic_Kc1: f64,
    pub cubic_Kc2: f64,
    pub cubic_Kc3: f64,
    pub cubic_axis1: [f64; 3],
    pub cubic_axis2: [f64; 3],

    pub kc1_field: *const f64,
    pub kc2_field: *const f64,
    pub kc3_field: *const f64,

    // DMI
    pub has_interfacial_dmi: i32,
    pub dmi_D_interfacial: f64,
    pub has_bulk_dmi: i32,
    pub dmi_D_bulk: f64,
    pub dind_field: *const f64,
    pub dind_field_len: u64,
    pub dbulk_field: *const f64,
    pub dbulk_field_len: u64,

    // Magnetoelastic coupling
    pub has_magnetoelastic: i32,
    pub mel_b1: f64,
    pub mel_b2: f64,
    pub mel_strain: [f64; 6],

    pub temperature: f64,
    pub thermal_seed: u64,

    pub current_density_x: f64,
    pub current_density_y: f64,
    pub current_density_z: f64,
    pub stt_degree: f64,
    pub stt_beta: f64,
    pub zhang_li_formula: fullmag_fdm_zhang_li_formula,

    pub stt_p_x: f64,
    pub stt_p_y: f64,
    pub stt_p_z: f64,
    pub stt_lambda: f64,
    pub stt_epsilon_prime: f64,
    pub stt_free_layer_thickness: f64,
    pub stt_current_sign: f64,
    pub slonczewski_formula: fullmag_fdm_slonczewski_formula,
    pub stt_stack_normal: [f64; 3],
    pub slonczewski_active_mask: *const u8,
    pub slonczewski_active_mask_len: u64,

    // Spin-Orbit Torque (SOT)
    pub has_sot: i32,
    pub sot_formula: fullmag_fdm_prescribed_sot_formula,
    pub sot_je: f64,
    pub sot_xi_dl: f64,
    pub sot_xi_fl: f64,
    pub sot_sigma: [f64; 3],
    pub sot_thickness: f64,
    pub sot_active_mask: *const u8,
    pub sot_active_mask_len: u64,

    // Oersted field (cylindrical conductor)
    pub has_oersted_cylinder: i32,
    pub oersted_current: f64,
    pub oersted_radius: f64,
    pub oersted_center: [f64; 3],
    pub oersted_axis: [f64; 3],
    pub oersted_time_dep_kind: u32,
    pub oersted_time_dep_freq: f64,
    pub oersted_time_dep_phase: f64,
    pub oersted_time_dep_offset: f64,
    pub oersted_time_dep_t_on: f64,
    pub oersted_time_dep_t_off: f64,
    pub oersted_field_xyz: *const f64,
    pub oersted_field_len: u64,

    pub demag_kernel_xx_spectrum: *const f64,
    pub demag_kernel_yy_spectrum: *const f64,
    pub demag_kernel_zz_spectrum: *const f64,
    pub demag_kernel_xy_spectrum: *const f64,
    pub demag_kernel_xz_spectrum: *const f64,
    pub demag_kernel_yz_spectrum: *const f64,
    pub demag_kernel_spectrum_len: u64,
    pub demag_fft_nx: u32,
    pub demag_fft_ny: u32,
    pub demag_fft_nz: u32,
    pub active_mask: *const u8,
    pub active_mask_len: u64,
    pub region_mask: *const u32,
    pub region_mask_len: u64,
    pub exchange_lut: *const f64,
    pub exchange_lut_len: u64,
    pub exchange_pair_default: fullmag_fdm_exchange_pair_mode,
    pub exchange_pairs: *const fullmag_fdm_exchange_pair_desc,
    pub exchange_pair_count: u64,
    // Boundary correction
    pub boundary_correction: fullmag_fdm_boundary_correction,
    pub boundary_phi_floor: f64,
    pub boundary_delta_min: f64,
    pub volume_fraction: *const f64,
    pub volume_fraction_len: u64,
    pub face_link_xp: *const f64,
    pub face_link_xm: *const f64,
    pub face_link_yp: *const f64,
    pub face_link_ym: *const f64,
    pub face_link_zp: *const f64,
    pub face_link_zm: *const f64,
    pub delta_xp: *const f64,
    pub delta_xm: *const f64,
    pub delta_yp: *const f64,
    pub delta_ym: *const f64,
    pub delta_zp: *const f64,
    pub delta_zm: *const f64,
    pub has_demag_boundary_corr: i32,
    pub demag_corr_target_idx: *const i32,
    pub demag_corr_source_idx: *const i32,
    pub demag_corr_tensor: *const f64,
    pub demag_corr_target_count: u32,
    pub demag_corr_stencil_size: u32,
    // Initial magnetization
    pub initial_magnetization_xyz: *const f64,
    pub initial_magnetization_len: u64,
    // Periodic boundary conditions per axis (exchange wrapping)
    pub periodic_x: i32,
    pub periodic_y: i32,
    pub periodic_z: i32,
    // Adaptive step configuration (DP45 only)
    pub adaptive_max_error: f64,
    pub adaptive_dt_min: f64,
    pub adaptive_dt_max: f64,
    pub adaptive_headroom: f64,
    pub stats_mode: fullmag_fdm_stats_mode,
    pub stats_stride: u32,
    /// Nullable append-only frozen-spin mask/reference extension.
    pub frozen_mask: *const u8,
    pub frozen_mask_len: u64,
    pub frozen_reference_xyz: *const f64,
    pub frozen_reference_len: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_time_policy_desc_v2 {
    pub adaptive_enabled: i32,
    pub adaptive_tolerance_mode: fullmag_fdm_adaptive_tolerance_mode,
    pub adaptive_atol: f64,
    pub adaptive_rtol: f64,
    pub adaptive_dt_min: f64,
    pub adaptive_dt_max: f64,
    pub adaptive_safety: f64,
    pub adaptive_growth_limit: f64,
    pub adaptive_shrink_limit: f64,
    pub has_adaptive_max_spin_rotation: i32,
    pub adaptive_max_spin_rotation: f64,
    pub has_adaptive_norm_tolerance: i32,
    pub adaptive_norm_tolerance: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_plan_desc_v2 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub base: fullmag_fdm_plan_desc,
    pub time_policy: fullmag_fdm_time_policy_desc_v2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct fullmag_fdm_llg_checkpoint_info_v2 {
    pub schema_version: u32,
    pub struct_size: u32,
    pub integrator: u32,
    pub precision: u32,
    pub requested_backend: u32,
    pub resolved_backend: u32,
    pub executed_backend: u32,
    pub requested_policy: u32,
    pub resolved_policy: u32,
    pub execution_realization: u32,
    pub device_ordinal: i32,
    pub array_mask: u32,
    pub cell_count: u64,
    pub payload_bytes: u64,
    pub step_count: u64,
    pub accepted_step_index: u64,
    pub accepted_state_revision: u64,
    pub current_time: f64,
    pub current_dt: f64,
    pub transport_attempt_generation: u64,
    pub rhs_source_revision: u64,
    pub rhs_field_revision: u64,
    pub rhs_transport_revision: u64,
    pub projection_policy_identity: u64,
    pub fsal_valid: u32,
    pub abm_startup: u32,
    pub abm_last_dt: f64,
    pub adaptive_enabled: u32,
    pub adaptive_has_previous_error: u32,
    pub adaptive_previous_error: f64,
    pub fsal_accepted_state_revision: u64,
    pub fsal_accepted_time_bits: u64,
    pub fsal_accepted_dt_bits: u64,
    pub fsal_source_revision: u64,
    pub fsal_field_revision: u64,
    pub fsal_transport_revision: u64,
    pub fsal_transport_state_identity: u64,
    pub fsal_projection_policy_identity: u64,
    pub fsal_integrator_identity: u32,
    pub fsal_precision_identity: u32,
}

pub const FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V3: u32 = 3;
pub const FULLMAG_FDM_CHECKPOINT_EXECUTION_IDENTITY_ABI_V3: u32 = 3;
pub const FULLMAG_FDM_CHECKPOINT_BACKEND_AUTO: u32 = 2;
pub const FULLMAG_FDM_CHECKPOINT_POLICY_STRICT: u32 = 1;
pub const FULLMAG_FDM_CHECKPOINT_POLICY_EXTENDED: u32 = 2;
pub const FULLMAG_FDM_CHECKPOINT_DEVICE_AUTO: u32 = 1;
pub const FULLMAG_FDM_CHECKPOINT_DEVICE_GPU: u32 = 2;
pub const FULLMAG_FDM_CHECKPOINT_RNG_NONE: u32 = 0;
pub const FULLMAG_FDM_CHECKPOINT_RNG_CURAND_PHILOX4X32_10: u32 = 1;
pub const FULLMAG_FDM_CHECKPOINT_RNG_REALIZATION_DISABLED: u32 = 0;
pub const FULLMAG_FDM_CHECKPOINT_RNG_REALIZATION_CUDA_FP32: u32 = 1;
pub const FULLMAG_FDM_CHECKPOINT_RNG_REALIZATION_CUDA_FP64: u32 = 2;

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct fullmag_fdm_checkpoint_execution_identity_v3 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub requested_backend: u32,
    pub resolved_backend: u32,
    pub executed_backend: u32,
    pub requested_policy: u32,
    pub resolved_policy: u32,
    pub executed_policy: u32,
    pub requested_realization: u32,
    pub resolved_realization: u32,
    pub executed_realization: u32,
    pub requested_device: u32,
    pub resolved_device: u32,
    pub executed_device: u32,
    pub requested_precision: u32,
    pub resolved_precision: u32,
    pub executed_precision: u32,
    pub requested_integrator: u32,
    pub resolved_integrator: u32,
    pub executed_integrator: u32,
    pub device_ordinal: i32,
    pub reserved0: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct fullmag_fdm_llg_checkpoint_info_v3 {
    pub schema_version: u32,
    pub struct_size: u32,
    pub execution_identity: fullmag_fdm_checkpoint_execution_identity_v3,
    pub array_mask: u32,
    pub reserved0: u32,
    pub cell_count: u64,
    pub payload_bytes: u64,
    pub step_count: u64,
    pub accepted_step_index: u64,
    pub accepted_state_revision: u64,
    pub current_time: f64,
    pub current_dt: f64,
    pub thermal_seed: u64,
    pub rng_algorithm: u32,
    pub rng_realization: u32,
    pub transport_attempt_generation: u64,
    pub rhs_source_revision: u64,
    pub rhs_field_revision: u64,
    pub rhs_transport_revision: u64,
    pub projection_policy_identity: u64,
    pub fsal_valid: u32,
    pub abm_startup: u32,
    pub abm_last_dt: f64,
    pub adaptive_enabled: u32,
    pub adaptive_has_previous_error: u32,
    pub adaptive_previous_error: f64,
    pub fsal_accepted_state_revision: u64,
    pub fsal_accepted_time_bits: u64,
    pub fsal_accepted_dt_bits: u64,
    pub fsal_source_revision: u64,
    pub fsal_field_revision: u64,
    pub fsal_transport_revision: u64,
    pub fsal_transport_state_identity: u64,
    pub fsal_projection_policy_identity: u64,
    pub fsal_integrator_identity: u32,
    pub fsal_precision_identity: u32,
}

// ── Step stats ──

#[repr(C)]
#[derive(Debug, Clone, Copy)]
#[allow(non_snake_case)]
pub struct fullmag_fdm_step_stats {
    pub step: u64,
    pub time_seconds: f64,
    pub dt_seconds: f64,
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub anisotropy_energy_joules: f64,
    pub cubic_energy_joules: f64,
    pub dmi_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
    pub max_torque_Apm: f64,
    pub suggested_next_dt: f64,
    pub wall_time_ns: u64,
    pub hot_loop_d2h_bytes: u64,
    pub hot_loop_host_sync_count: u64,
    pub hot_loop_control_scalar_d2h_bytes: u64,
    pub hot_loop_control_scalar_host_sync_count: u64,
    pub multilayer_refresh_count: u64,
    pub multilayer_forward_fft_count: u64,
    pub multilayer_inverse_fft_count: u64,
    pub multilayer_pair_accumulation_count: u64,
}

pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_ABI_V1: u32 = 1;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1: usize = 51;
pub type fullmag_fdm_adaptive_attempt_decision_v1 = u32;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_ACCEPTED: fullmag_fdm_adaptive_attempt_decision_v1 = 1;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_RETRY: fullmag_fdm_adaptive_attempt_decision_v1 = 2;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_FAILED: fullmag_fdm_adaptive_attempt_decision_v1 = 3;
pub type fullmag_fdm_adaptive_attempt_reason_v1 = u32;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_WITHIN_TOLERANCE: fullmag_fdm_adaptive_attempt_reason_v1 = 1;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_ERROR_ABOVE_TOLERANCE: fullmag_fdm_adaptive_attempt_reason_v1 = 2;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_DT_MIN_EXHAUSTED: fullmag_fdm_adaptive_attempt_reason_v1 = 3;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_INVALID_TIMESTEP: fullmag_fdm_adaptive_attempt_reason_v1 = 4;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_INVALID_CURRENT_ERROR: fullmag_fdm_adaptive_attempt_reason_v1 = 5;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_INVALID_PREVIOUS_ERROR: fullmag_fdm_adaptive_attempt_reason_v1 = 6;
pub const FULLMAG_FDM_ADAPTIVE_ATTEMPT_RETRY_LIMIT_EXHAUSTED: fullmag_fdm_adaptive_attempt_reason_v1 = 7;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_adaptive_attempt_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub attempt_index: u32,
    pub decision: fullmag_fdm_adaptive_attempt_decision_v1,
    pub reason: fullmag_fdm_adaptive_attempt_reason_v1,
    pub reserved0: u32,
    pub dt_attempt_seconds: f64,
    pub normalized_error: f64,
    pub ratio: f64,
    pub dt_next_seconds: f64,
}

pub const FULLMAG_FDM_ADAPTIVE_BATCH_STEP_ABI_V1: u32 = 1;
pub const FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1: usize = 64;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_adaptive_batch_step_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub decision: fullmag_fdm_adaptive_attempt_decision_v1,
    pub reason: fullmag_fdm_adaptive_attempt_reason_v1,
    pub step: u64,
    pub time_seconds: f64,
    pub dt_seconds: f64,
    pub suggested_next_dt_seconds: f64,
    pub normalized_error: f64,
    pub rejected_attempts: u32,
    pub reserved0: u32,
}

// ── Device info ──

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_device_info {
    pub name: [c_char; 128],
    pub compute_capability_major: i32,
    pub compute_capability_minor: i32,
    pub driver_version: i32,
    pub runtime_version: i32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_snapshot_desc {
    pub cell_count: u64,
    pub component_count: u32,
    pub scalar_bytes: u32,
    pub scalar_type: fullmag_fdm_snapshot_scalar_type,
}

// ── Opaque handle ──

#[repr(C)]
pub struct fullmag_fdm_backend {
    _private: [u8; 0],
}

pub type fullmag_fdm_fsal_invalidation_reason = u32;
pub const FULLMAG_FDM_FSAL_INVALIDATION_NONE: fullmag_fdm_fsal_invalidation_reason = 0;
pub const FULLMAG_FDM_FSAL_INVALIDATION_CACHE_EMPTY: fullmag_fdm_fsal_invalidation_reason = 1;
pub const FULLMAG_FDM_FSAL_INVALIDATION_UNKNOWN_IDENTITY: fullmag_fdm_fsal_invalidation_reason = 2;
pub const FULLMAG_FDM_FSAL_INVALIDATION_THERMAL_ACTIVE: fullmag_fdm_fsal_invalidation_reason = 3;
pub const FULLMAG_FDM_FSAL_INVALIDATION_WAVEFORM_DISCONTINUITY:
    fullmag_fdm_fsal_invalidation_reason = 4;
pub const FULLMAG_FDM_FSAL_INVALIDATION_STATE_MISMATCH: fullmag_fdm_fsal_invalidation_reason = 5;
pub const FULLMAG_FDM_FSAL_INVALIDATION_TIME_MISMATCH: fullmag_fdm_fsal_invalidation_reason = 6;
pub const FULLMAG_FDM_FSAL_INVALIDATION_SOURCE_MISMATCH: fullmag_fdm_fsal_invalidation_reason = 7;
pub const FULLMAG_FDM_FSAL_INVALIDATION_FIELD_MISMATCH: fullmag_fdm_fsal_invalidation_reason = 8;
pub const FULLMAG_FDM_FSAL_INVALIDATION_TRANSPORT_STATE_MISMATCH:
    fullmag_fdm_fsal_invalidation_reason = 9;
pub const FULLMAG_FDM_FSAL_INVALIDATION_PROJECTION_MISMATCH: fullmag_fdm_fsal_invalidation_reason =
    10;
pub const FULLMAG_FDM_FSAL_INVALIDATION_REALIZATION_MISMATCH: fullmag_fdm_fsal_invalidation_reason =
    11;
pub const FULLMAG_FDM_FSAL_INVALIDATION_REJECTED_STEP: fullmag_fdm_fsal_invalidation_reason = 12;
pub const FULLMAG_FDM_FSAL_INVALIDATION_STEP_ERROR: fullmag_fdm_fsal_invalidation_reason = 13;
pub const FULLMAG_FDM_FSAL_INVALIDATION_CHECKPOINT_RESTORE: fullmag_fdm_fsal_invalidation_reason =
    14;
pub const FULLMAG_FDM_FSAL_INVALIDATION_STALE_PUBLICATION: fullmag_fdm_fsal_invalidation_reason =
    15;
pub const FULLMAG_FDM_FSAL_INVALIDATION_REASON_COUNT: usize = 16;

pub const FULLMAG_FDM_FSAL_TELEMETRY_ABI_V1: u32 = 1;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_fsal_telemetry_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub fsal_reused: u32,
    pub fsal_invalidation_reason: fullmag_fdm_fsal_invalidation_reason,
    pub fsal_invalidation_count: u64,
    pub rhs_evaluations_saved: u64,
    pub thermal_rng_draws: u64,
    pub accepted_step_index: u64,
    pub stale_publication_count: u64,
    pub transaction_commit_count: u64,
}

pub const FULLMAG_FDM_FSAL_TELEMETRY_ABI_V2: u32 = 2;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_fsal_telemetry_v2 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub fsal_reused: u32,
    pub fsal_invalidation_reason: fullmag_fdm_fsal_invalidation_reason,
    pub fsal_invalidation_count: u64,
    pub rhs_evaluations_saved: u64,
    pub thermal_rng_draws: u64,
    pub accepted_step_index: u64,
    pub stale_publication_count: u64,
    pub transaction_commit_count: u64,
    pub invalidation_reason_counts: [u64; FULLMAG_FDM_FSAL_INVALIDATION_REASON_COUNT],
}

pub const FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1: u32 = 1;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_step_transaction_telemetry_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub accounting_valid: u32,
    pub reserved0: u32,
    pub capture_count: u64,
    pub rollback_count: u64,
    pub capture_d2d_bytes: u64,
    pub rollback_d2d_bytes: u64,
    pub rollback_latency_total_ns: u64,
    pub rollback_latency_max_ns: u64,
    pub accepted_step_index: u64,
    pub attempt_generation: u64,
    pub thermal_rng_draws: u64,
    pub stale_publication_count: u64,
}

pub const FULLMAG_FDM_ADAPTIVE_EXECUTION_TELEMETRY_ABI_V1: u32 = 1;
pub type fullmag_fdm_adaptive_control_realization_v1 = u32;
pub const FULLMAG_FDM_ADAPTIVE_CONTROL_NOT_APPLICABLE: fullmag_fdm_adaptive_control_realization_v1 =
    0;
pub const FULLMAG_FDM_ADAPTIVE_CONTROL_LEGACY_HOST_READBACK:
    fullmag_fdm_adaptive_control_realization_v1 = 1;
pub const FULLMAG_FDM_ADAPTIVE_CONTROL_CUDA_CONDITIONAL_GRAPH:
    fullmag_fdm_adaptive_control_realization_v1 = 2;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_adaptive_execution_telemetry_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub realization: fullmag_fdm_adaptive_control_realization_v1,
    pub accounting_valid: u32,
    pub graph_build_count: u64,
    pub graph_launch_count: u64,
    pub terminal_control_d2h_bytes: u64,
    pub terminal_control_host_sync_count: u64,
    pub step_completion_host_sync_count: u64,
    pub stats_none_host_sync_count: u64,
}

pub const FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1: u32 = 1;
pub const FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2: u32 = 2;
pub type fullmag_fdm_execution_class_v1 = u32;
pub const FULLMAG_FDM_EXECUTION_UNKNOWN: fullmag_fdm_execution_class_v1 = 0;
pub const FULLMAG_FDM_EXECUTION_DEVICE_RESIDENT: fullmag_fdm_execution_class_v1 = 1;
pub const FULLMAG_FDM_EXECUTION_GPU_OPERATOR_HOST_CONTROL: fullmag_fdm_execution_class_v1 = 2;
pub const FULLMAG_FDM_EXECUTION_HYBRID: fullmag_fdm_execution_class_v1 = 3;
pub const FULLMAG_FDM_EXECUTION_CPU: fullmag_fdm_execution_class_v1 = 4;

pub type fullmag_fdm_executed_backend_v1 = u32;
pub const FULLMAG_FDM_EXECUTED_UNKNOWN: fullmag_fdm_executed_backend_v1 = 0;
pub const FULLMAG_FDM_EXECUTED_CUDA_FDM: fullmag_fdm_executed_backend_v1 = 1;

pub type fullmag_fdm_operator_location_v1 = u32;
pub const FULLMAG_FDM_LOCATION_UNKNOWN: fullmag_fdm_operator_location_v1 = 0;
pub const FULLMAG_FDM_LOCATION_DEVICE: fullmag_fdm_operator_location_v1 = 1;
pub const FULLMAG_FDM_LOCATION_HOST: fullmag_fdm_operator_location_v1 = 2;
pub const FULLMAG_FDM_LOCATION_MIXED: fullmag_fdm_operator_location_v1 = 3;
pub const FULLMAG_FDM_LOCATION_HOST_SCALAR: fullmag_fdm_operator_location_v1 = 4;

pub const FULLMAG_FDM_OPERATOR_LLG_INTEGRATOR: u64 = 1 << 0;
pub const FULLMAG_FDM_OPERATOR_EXCHANGE: u64 = 1 << 1;
pub const FULLMAG_FDM_OPERATOR_DEMAG: u64 = 1 << 2;
pub const FULLMAG_FDM_OPERATOR_DMI: u64 = 1 << 3;
pub const FULLMAG_FDM_OPERATOR_ANISOTROPY: u64 = 1 << 4;
pub const FULLMAG_FDM_OPERATOR_REDUCTION: u64 = 1 << 5;
pub const FULLMAG_FDM_OPERATOR_EXTERNAL_FIELD: u64 = 1 << 6;
pub const FULLMAG_FDM_OPERATOR_MASKS: u64 = 1 << 7;
pub const FULLMAG_FDM_OPERATOR_MAGNETOELASTIC: u64 = 1 << 8;
pub const FULLMAG_FDM_OPERATOR_THERMAL: u64 = 1 << 9;
pub const FULLMAG_FDM_OPERATOR_ZHANG_LI_STT: u64 = 1 << 10;
pub const FULLMAG_FDM_OPERATOR_SLONCZEWSKI_STT: u64 = 1 << 11;
pub const FULLMAG_FDM_OPERATOR_SOT: u64 = 1 << 12;
pub const FULLMAG_FDM_OPERATOR_OERSTED: u64 = 1 << 13;
pub const FULLMAG_FDM_OPERATOR_BOUNDARY_CORRECTION: u64 = 1 << 14;
pub const FULLMAG_FDM_OPERATOR_MULTILAYER_TRANSFER: u64 = 1 << 15;
pub const FULLMAG_FDM_OPERATOR_MULTILAYER_INTERACTIONS: u64 = 1 << 16;
pub const FULLMAG_FDM_OPERATOR_MULTILAYER_DEMAG: u64 = 1 << 17;
pub const FULLMAG_FDM_OPERATOR_GPU_TRANSPORT: u64 = 1 << 18;
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_execution_receipt_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub execution_class: fullmag_fdm_execution_class_v1,
    pub executed_backend: fullmag_fdm_executed_backend_v1,
    pub device_ordinal: i32,
    // Raw integer discriminants are intentional: receipt validation must be
    // able to reject unknown native values without constructing an invalid
    // Rust enum.
    pub precision: u32,
    pub integrator: u32,
    pub reserved0: u32,
    pub required_operator_mask: u64,
    pub device_operator_mask: u64,
    pub host_operator_mask: u64,
    pub reduction_location: fullmag_fdm_operator_location_v1,
    pub control_location: fullmag_fdm_operator_location_v1,
    pub fallback_count: u64,
    pub setup_full_vector_h2d_count: u64,
    pub setup_full_vector_h2d_bytes: u64,
    pub hot_loop_full_vector_h2d_count: u64,
    pub hot_loop_full_vector_h2d_bytes: u64,
    pub hot_loop_full_vector_d2h_count: u64,
    pub hot_loop_full_vector_d2h_bytes: u64,
    pub hot_loop_host_compute_count: u64,
    pub hot_loop_host_sync_count: u64,
    pub hot_loop_control_scalar_d2h_bytes: u64,
    pub hot_loop_control_scalar_host_sync_count: u64,
    pub setup_full_vector_d2h_count: u64,
    pub setup_full_vector_d2h_bytes: u64,
    pub observation_full_vector_h2d_count: u64,
    pub observation_full_vector_h2d_bytes: u64,
    pub observation_full_vector_d2h_count: u64,
    pub observation_full_vector_d2h_bytes: u64,
    pub accounting_valid: u32,
    pub reserved1: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_execution_receipt_v2 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub execution_class: fullmag_fdm_execution_class_v1,
    pub executed_backend: fullmag_fdm_executed_backend_v1,
    pub device_ordinal: i32,
    pub precision: u32,
    pub integrator: u32,
    pub reserved0: u32,
    pub required_operator_mask: u64,
    pub device_operator_mask: u64,
    pub host_operator_mask: u64,
    pub resolved_unknown_operator_mask: u64,
    pub executed_device_operator_mask: u64,
    pub executed_host_operator_mask: u64,
    pub executed_unknown_operator_mask: u64,
    pub reduction_location: fullmag_fdm_operator_location_v1,
    pub control_location: fullmag_fdm_operator_location_v1,
    pub fallback_count: u64,
    pub setup_full_vector_h2d_count: u64,
    pub setup_full_vector_h2d_bytes: u64,
    pub hot_loop_full_vector_h2d_count: u64,
    pub hot_loop_full_vector_h2d_bytes: u64,
    pub hot_loop_full_vector_d2h_count: u64,
    pub hot_loop_full_vector_d2h_bytes: u64,
    pub hot_loop_host_compute_count: u64,
    pub hot_loop_host_sync_count: u64,
    pub hot_loop_control_scalar_d2h_bytes: u64,
    pub hot_loop_control_scalar_host_sync_count: u64,
    pub setup_full_vector_d2h_count: u64,
    pub setup_full_vector_d2h_bytes: u64,
    pub observation_full_vector_h2d_count: u64,
    pub observation_full_vector_h2d_bytes: u64,
    pub observation_full_vector_d2h_count: u64,
    pub observation_full_vector_d2h_bytes: u64,
    pub accounting_valid: u32,
    pub reserved1: u32,
}

#[cfg(test)]
mod execution_receipt_v1_layout_tests {
    use super::*;

    #[test]
    fn c_and_rust_receipt_layout_is_exact() {
        include!(concat!(
            env!("OUT_DIR"),
            "/execution_receipt_v1_layout_assertions.rs"
        ));
    }

    #[test]
    fn c_and_rust_receipt_values_are_exact() {
        include!(concat!(
            env!("OUT_DIR"),
            "/execution_receipt_v1_value_assertions.rs"
        ));
    }
}

#[cfg(test)]
mod execution_receipt_v2_layout_tests {
    use super::*;

    #[test]
    fn c_and_rust_receipt_v2_layout_is_exact() {
        include!(concat!(
            env!("OUT_DIR"),
            "/execution_receipt_v2_layout_assertions.rs"
        ));
    }
}

#[repr(C)]
pub struct fullmag_fdm_plan_ingestion_v2 {
    _private: [u8; 0],
}

#[repr(C)]
pub struct fullmag_fdm_field_snapshot {
    _private: [u8; 0],
}

#[repr(C)]
pub struct fullmag_fdm_preview_snapshot {
    _private: [u8; 0],
}

// ── FDM CPU steady charge + one-way spin transport ABI v1 ──

pub const FULLMAG_FDM_CPU_TRANSPORT_ABI_V1: u32 = 1;
pub const FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY: usize = 64;
pub const FULLMAG_FDM_CPU_TRANSPORT_ERROR_CAPACITY: usize = 512;
pub const FULLMAG_FDM_CPU_TRANSPORT_OK: i32 = 0;
pub const FULLMAG_FDM_CPU_TRANSPORT_ERR_NULL: i32 = -100;
pub const FULLMAG_FDM_CPU_TRANSPORT_ERR_ABI: i32 = -101;
pub const FULLMAG_FDM_CPU_TRANSPORT_ERR_INVALID: i32 = -102;
pub const FULLMAG_FDM_CPU_TRANSPORT_ERR_BUFFER: i32 = -103;
pub const FULLMAG_FDM_CPU_TRANSPORT_ERR_UNSUPPORTED: i32 = -104;
pub const FULLMAG_FDM_CPU_TRANSPORT_ERR_CONVERGENCE: i32 = -105;
pub const FULLMAG_FDM_CPU_TRANSPORT_ERR_BALANCE: i32 = -106;
pub const FULLMAG_FDM_CPU_TRANSPORT_ERR_NUMERICAL: i32 = -107;
pub const FULLMAG_FDM_CPU_TRANSPORT_ERR_INTERNAL: i32 = -108;
pub const FULLMAG_FDM_CPU_TRANSPORT_DEVICE_CPU: u32 = 1;
pub const FULLMAG_FDM_CPU_TRANSPORT_DEVICE_GPU: u32 = 2;
pub const FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F32: u32 = 1;
pub const FULLMAG_FDM_CPU_TRANSPORT_PRECISION_F64: u32 = 2;
pub const FULLMAG_FDM_CPU_CHARGE_BC_UNSET: u32 = 0;
pub const FULLMAG_FDM_CPU_CHARGE_BC_INSULATING: u32 = 1;
pub const FULLMAG_FDM_CPU_CHARGE_BC_VOLTAGE: u32 = 2;
pub const FULLMAG_FDM_CPU_CHARGE_BC_TOTAL_CURRENT: u32 = 3;
pub const FULLMAG_FDM_CPU_CHARGE_BC_SPECIFIED_OUTWARD_CURRENT_DENSITY: u32 = 4;
pub const FULLMAG_FDM_CPU_CHARGE_GAUGE_NONE: u32 = 0;
pub const FULLMAG_FDM_CPU_CHARGE_GAUGE_ZERO_MEAN: u32 = 1;
pub const FULLMAG_FDM_CPU_SPIN_BC_UNSET: u32 = 0;
pub const FULLMAG_FDM_CPU_SPIN_BC_INSULATING: u32 = 1;
pub const FULLMAG_FDM_CPU_SPIN_BC_SINK: u32 = 2;
pub const FULLMAG_FDM_CPU_SPIN_BC_SPECIFIED_POTENTIAL: u32 = 3;
pub const FULLMAG_FDM_CPU_SPIN_BC_SPECIFIED_OUTWARD_FLUX: u32 = 4;
pub const FULLMAG_FDM_CPU_SPIN_BC_PERIODIC: u32 = 5;
pub const FULLMAG_FDM_CPU_SPIN_INTERFACE_TRANSPARENT: u32 = 0;
pub const FULLMAG_FDM_CPU_SPIN_INTERFACE_MIXING_CONDUCTANCE_V2: u32 = 1;
pub const FULLMAG_FDM_CPU_SPIN_INTERFACE_SML_RESERVOIR_V2: u32 = 2;
pub const FULLMAG_FDM_CPU_OERSTED_ABI_V1: u32 = 1;
pub const FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY: usize = 96;
pub const FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY: usize = 80;
pub const FULLMAG_FDM_CPU_OERSTED_ERROR_CAPACITY: usize = 512;
pub const FULLMAG_FDM_CPU_OERSTED_OK: i32 = 0;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_NULL: i32 = -200;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_ABI: i32 = -201;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_INVALID: i32 = -202;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_BUFFER: i32 = -203;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_PERIODIC: i32 = -204;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_MISSING_CERTIFICATE: i32 = -205;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_STALE_CERTIFICATE: i32 = -206;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_OPEN_CIRCUIT: i32 = -207;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_CLOSURE: i32 = -208;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_NUMERICAL: i32 = -209;
pub const FULLMAG_FDM_CPU_OERSTED_ERR_INTERNAL: i32 = -210;
pub const FULLMAG_FDM_CPU_OERSTED_BOUNDARY_OPEN: u32 = 0;
pub const FULLMAG_FDM_CPU_OERSTED_BOUNDARY_PERIODIC: u32 = 1;
pub const FULLMAG_FDM_CPU_OERSTED_CLOSURE_CLOSED_GEOMETRY: u32 = 0;
pub const FULLMAG_FDM_CPU_OERSTED_CLOSURE_CERTIFIED_IMPORT: u32 = 1;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_transport_grid_v1 {
    pub nx: u64,
    pub ny: u64,
    pub nz: u64,
    pub dx_m: f64,
    pub dy_m: f64,
    pub dz_m: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_f64_buffer_v1 {
    pub data: *mut f64,
    pub capacity: u64,
    pub length: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_charge_boundary_v1 {
    pub kind: u32,
    pub reserved: u32,
    pub value: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_spin_boundary_v1 {
    pub kind: u32,
    pub reserved: u32,
    pub potential_v: [f64; 3],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_specified_current_face_v1 {
    pub axis: u32,
    pub outward_normal_sign: i32,
    pub face_index: u64,
    pub adjacent_cell: u64,
    pub area_m2: f64,
    pub outward_current_density_a_per_m2: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_impressed_potential_jump_face_v1 {
    pub source_cut_index: u64,
    pub axis: u32,
    pub normal_sign: i32,
    pub negative_cell: u64,
    pub positive_cell: u64,
    pub potential_jump_v: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_transport_interface_v1 {
    pub interface_id: u64,
    pub axis: u32,
    pub kind: u32,
    pub negative_cell: u64,
    pub positive_cell: u64,
    pub from_cell: u64,
    pub to_cell: u64,
    pub g_up_s_per_m2: f64,
    pub g_down_s_per_m2: f64,
    pub g_r_s_per_m2: f64,
    pub g_i_s_per_m2: f64,
    pub magnetization: [f64; 3],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_charge_interface_observation_v1 {
    pub interface_id: u64,
    pub axis: u32,
    pub reserved: u32,
    pub negative_cell: u64,
    pub positive_cell: u64,
    pub from_cell: u64,
    pub to_cell: u64,
    pub g_up_s_per_m2: f64,
    pub g_down_s_per_m2: f64,
    pub from_potential_trace_v: f64,
    pub to_potential_trace_v: f64,
    pub delta_potential_trace_v: f64,
    pub from_to_current_density_a_per_m2: f64,
    pub global_face_current_density_a_per_m2: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_charge_interface_observation_buffer_v1 {
    pub data: *mut fullmag_fdm_cpu_charge_interface_observation_v1,
    pub capacity: u64,
    pub length: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_spin_interface_observation_v1 {
    pub interface_id: u64,
    pub axis: u32,
    pub reserved: u32,
    pub negative_cell: u64,
    pub positive_cell: u64,
    pub from_cell: u64,
    pub to_cell: u64,
    pub incoming_longitudinal_a_per_m2: [f64; 3],
    pub backflow_longitudinal_a_per_m2: [f64; 3],
    pub absorbed_transverse_a_per_m2: [f64; 3],
    pub negative_cell_flux_positive_axis_a_per_m2: [f64; 3],
    pub positive_cell_flux_positive_axis_a_per_m2: [f64; 3],
    pub from_side_outgoing_a_per_m2: [f64; 3],
    pub to_side_transmitted_a_per_m2: [f64; 3],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_spin_interface_observation_buffer_v1 {
    pub data: *mut fullmag_fdm_cpu_spin_interface_observation_v1,
    pub capacity: u64,
    pub length: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_spin_reaction_lengths_v1 {
    pub spin_flip_m: f64,
    pub exchange_m: f64,
    pub dephasing_m: f64,
}

#[repr(C)]
pub struct fullmag_fdm_cpu_charge_snapshot_v1 {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_transport_abi_layout_field_v1 {
    pub field_name: *const c_char,
    pub offset: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_transport_abi_layout_record_v1 {
    pub record_name: *const c_char,
    pub size: u64,
    pub alignment: u64,
    pub field_count: u64,
    pub fields: *const fullmag_fdm_cpu_transport_abi_layout_field_v1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_transport_abi_layout_manifest_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub reserved_flags: u64,
    pub record_count: u64,
    pub records: *const fullmag_fdm_cpu_transport_abi_layout_record_v1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_charge_request_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub reserved_flags: u64,
    pub grid: fullmag_fdm_cpu_transport_grid_v1,
    pub device: u32,
    pub precision: u32,
    pub conductivity_s_per_m: *const f64,
    pub conductivity_len: u64,
    pub active_cells: *const u8,
    pub active_cells_len: u64,
    pub boundaries: [fullmag_fdm_cpu_charge_boundary_v1; 6],
    pub specified_current_faces: *const fullmag_fdm_cpu_specified_current_face_v1,
    pub specified_current_face_count: u64,
    pub interfaces: *const fullmag_fdm_cpu_transport_interface_v1,
    pub interface_count: u64,
    pub gauge: u32,
    pub reserved0: u32,
    pub relative_tolerance: f64,
    pub absolute_tolerance_a_per_m3: f64,
    pub max_iterations: u64,
    pub api_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub operator_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub solver_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub residual_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub impressed_potential_jump_faces: *const fullmag_fdm_cpu_impressed_potential_jump_face_v1,
    pub impressed_potential_jump_face_count: u64,
}

#[repr(C)]
#[derive(Debug)]
/// Raw caller-allocated result whose accepted snapshot is a unique owner.
///
/// A successful result must not be copied. Pass its address to spin solve only
/// while it remains alive, then call `fullmag_fdm_cpu_charge_result_destroy_v1`
/// exactly as the owner teardown. Destroying an empty/full-size result is safe
/// and repeated destruction is idempotent. Safe Rust intentionally cannot
/// duplicate this record:
///
/// ```compile_fail
/// use fullmag_fdm_sys::fullmag_fdm_cpu_charge_result_v1;
///
/// let result = unsafe { std::mem::zeroed::<fullmag_fdm_cpu_charge_result_v1>() };
/// let copied = result;
/// let _use_after_move = result;
/// let _ = copied;
/// ```
///
/// ```compile_fail
/// use fullmag_fdm_sys::fullmag_fdm_cpu_charge_result_v1;
///
/// let result = unsafe { std::mem::zeroed::<fullmag_fdm_cpu_charge_result_v1>() };
/// let _duplicate_owner = result.clone();
/// ```
pub struct fullmag_fdm_cpu_charge_result_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub reserved_flags: u64,
    pub status: i32,
    pub reserved0: u32,
    pub potential_v: fullmag_fdm_cpu_f64_buffer_v1,
    pub jc_x_a_per_m2: fullmag_fdm_cpu_f64_buffer_v1,
    pub jc_y_a_per_m2: fullmag_fdm_cpu_f64_buffer_v1,
    pub jc_z_a_per_m2: fullmag_fdm_cpu_f64_buffer_v1,
    pub jc_cell_xyz_a_per_m2: fullmag_fdm_cpu_f64_buffer_v1,
    pub interface_observations: fullmag_fdm_cpu_charge_interface_observation_buffer_v1,
    pub iterations: u64,
    pub algebraic_residual_l2_a_per_m3: f64,
    pub recomputed_algebraic_residual_l2_a_per_m3: f64,
    pub physical_balance_integrated_l2_a: f64,
    pub max_cell_current_imbalance_a: f64,
    pub max_abs_divergence_a_per_m3: f64,
    pub boundary_outward_current_a: [f64; 6],
    pub net_boundary_current_a: f64,
    pub accepted_snapshot_identity: u64,
    pub accepted_snapshot: *mut fullmag_fdm_cpu_charge_snapshot_v1,
    pub api_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub operator_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub interface_operator_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub solver_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub residual_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub runtime_owner: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub error_message: [c_char; FULLMAG_FDM_CPU_TRANSPORT_ERROR_CAPACITY],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_steady_spin_request_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub reserved_flags: u64,
    pub grid: fullmag_fdm_cpu_transport_grid_v1,
    pub device: u32,
    pub precision: u32,
    pub spin_conductivity_s_per_m: *const f64,
    pub spin_conductivity_len: u64,
    pub polarization: *const f64,
    pub polarization_len: u64,
    pub spin_hall_angle: *const f64,
    pub spin_hall_angle_len: u64,
    pub magnetization_xyz: *const f64,
    pub magnetization_xyz_len: u64,
    pub reactions: *const fullmag_fdm_cpu_spin_reaction_lengths_v1,
    pub reaction_count: u64,
    pub active_cells: *const u8,
    pub active_cells_len: u64,
    pub region_ids: *const u32,
    pub region_id_count: u64,
    pub boundaries: [fullmag_fdm_cpu_spin_boundary_v1; 6],
    pub interfaces: *const fullmag_fdm_cpu_transport_interface_v1,
    pub interface_count: u64,
    pub torque_target_cells: *const u8,
    pub torque_target_cells_len: u64,
    pub saturation_magnetization_a_per_m: *const f64,
    pub saturation_magnetization_len: u64,
    pub gamma_e_rad_per_s_t: f64,
    pub relative_tolerance: f64,
    pub absolute_tolerance_a: f64,
    pub local_relative_tolerance: f64,
    pub local_absolute_tolerance_a_per_m3: f64,
    pub max_iterations: u64,
    pub gmres_restart: u64,
    pub api_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub formula_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub operator_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub electric_reconstruction_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub solver_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub residual_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub local_residual_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub interface_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub torque_operator_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_steady_spin_result_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub reserved_flags: u64,
    pub status: i32,
    pub reserved0: u32,
    pub spin_potential_xyz_v: fullmag_fdm_cpu_f64_buffer_v1,
    pub q_x_xyz_a_per_m2: fullmag_fdm_cpu_f64_buffer_v1,
    pub q_y_xyz_a_per_m2: fullmag_fdm_cpu_f64_buffer_v1,
    pub q_z_xyz_a_per_m2: fullmag_fdm_cpu_f64_buffer_v1,
    pub q_cell_ia_a_per_m2: fullmag_fdm_cpu_f64_buffer_v1,
    pub reaction_spin_flip_xyz_a_per_m3: fullmag_fdm_cpu_f64_buffer_v1,
    pub reaction_exchange_xyz_a_per_m3: fullmag_fdm_cpu_f64_buffer_v1,
    pub reaction_dephasing_xyz_a_per_m3: fullmag_fdm_cpu_f64_buffer_v1,
    pub reaction_total_xyz_a_per_m3: fullmag_fdm_cpu_f64_buffer_v1,
    pub transport_torque_xyz_per_s: fullmag_fdm_cpu_f64_buffer_v1,
    pub interface_observations: fullmag_fdm_cpu_spin_interface_observation_buffer_v1,
    pub iterations: u64,
    pub gmres_restart: u64,
    pub initial_rhs_integrated_l2_a: f64,
    pub recursive_residual_integrated_l2_a: f64,
    pub recomputed_balance_integrated_l2_a: f64,
    pub balance_tolerance_integrated_l2_a: f64,
    pub boundary_outward_current_a: [f64; 18],
    pub global_balance_closure_a: [f64; 3],
    pub relative_global_balance: f64,
    pub max_abs_residual_a_per_m3: f64,
    pub api_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub formula_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub operator_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub electric_reconstruction_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub solver_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub residual_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub local_residual_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub interface_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub torque_operator_version: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub runtime_owner: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub convergence_reason: [c_char; FULLMAG_FDM_CPU_TRANSPORT_VERSION_TEXT_CAPACITY],
    pub error_message: [c_char; FULLMAG_FDM_CPU_TRANSPORT_ERROR_CAPACITY],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_oersted_const_f64_buffer_v1 {
    pub data: *const f64,
    pub length: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_oersted_const_u64_buffer_v1 {
    pub data: *const u64,
    pub length: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_oersted_const_i8_buffer_v1 {
    pub data: *const i8,
    pub length: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_oersted_source_cut_v1 {
    pub stable_id: *const c_char,
    pub component_label: u64,
    pub ordered_internal_face_ids: fullmag_fdm_cpu_oersted_const_u64_buffer_v1,
    pub ordered_normals: fullmag_fdm_cpu_oersted_const_i8_buffer_v1,
    pub drive_id: *const c_char,
    pub drive_kind: *const c_char,
    pub drive_value: f64,
    pub drive_si_unit: *const c_char,
    pub revision: u64,
    pub digest: *const c_char,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_oersted_certificate_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub reserved_flags: u64,
    pub closure_kind: u32,
    pub global_continuity_passed: u32,
    pub exterior_flux_passed: u32,
    pub component_flux_passed: u32,
    pub return_path_complete: u32,
    pub reserved0: u32,
    pub revision: u64,
    pub version: *const c_char,
    pub digest: *const c_char,
    pub geometry_digest: *const c_char,
    pub conductor_mask_revision: u64,
    pub conductor_mask_digest: *const c_char,
    pub face_current_revision: u64,
    pub face_current_digest: *const c_char,
    pub component_labels: fullmag_fdm_cpu_oersted_const_u64_buffer_v1,
    pub component_count: u64,
    pub divergence_tolerance_a_per_m3: f64,
    pub exterior_current_tolerance_a: f64,
    pub measured_max_abs_divergence_a_per_m3: f64,
    pub measured_component_exterior_current_a: fullmag_fdm_cpu_oersted_const_f64_buffer_v1,
    pub source_cuts: *const fullmag_fdm_cpu_oersted_source_cut_v1,
    pub source_cut_count: u64,
    pub imported_certification_method: *const c_char,
    pub imported_field_digest: *const c_char,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_oersted_request_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub reserved_flags: u64,
    pub grid: fullmag_fdm_cpu_transport_grid_v1,
    pub origin_m: [f64; 3],
    pub boundaries: [u32; 3],
    pub reserved0: u32,
    pub conductor_mask: *const u8,
    pub conductor_mask_len: u64,
    pub target_mask: *const u8,
    pub target_mask_len: u64,
    pub jc_x_a_per_m2: fullmag_fdm_cpu_oersted_const_f64_buffer_v1,
    pub jc_y_a_per_m2: fullmag_fdm_cpu_oersted_const_f64_buffer_v1,
    pub jc_z_a_per_m2: fullmag_fdm_cpu_oersted_const_f64_buffer_v1,
    pub geometry_revision: u64,
    pub geometry_digest: *const c_char,
    pub conductor_mask_revision: u64,
    pub conductor_mask_digest: *const c_char,
    pub target_mask_revision: u64,
    pub target_mask_digest: *const c_char,
    pub face_current_revision: u64,
    pub face_current_digest: *const c_char,
    pub source_identity: *const c_char,
    pub envelope_revision: u64,
    pub envelope_digest: *const c_char,
    pub stage_identity: u64,
    pub evaluation_time_s: f64,
    pub evaluated_envelope_multiplier: f64,
    pub trusted_snapshot_revision: u64,
    pub trusted_snapshot_digest: *const c_char,
    pub certificate: *const fullmag_fdm_cpu_oersted_certificate_v1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_oersted_result_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub reserved_flags: u64,
    pub status: i32,
    pub reserved0: u32,
    pub field_xyz_a_per_m: fullmag_fdm_cpu_f64_buffer_v1,
    pub face_current_revision: u64,
    pub certificate_revision: u64,
    pub trusted_snapshot_revision: u64,
    pub envelope_revision: u64,
    pub stage_identity: u64,
    pub evaluation_time_s: f64,
    pub evaluated_envelope_multiplier: f64,
    pub plan_build_count: u64,
    pub kernel_build_count: u64,
    pub numerical_buffer_allocation_count: u64,
    pub resolved_field_hit_count: u64,
    pub resolved_field_miss_count: u64,
    pub resolved_field_invalidation_count: u64,
    pub trusted_fast_path_hit_count: u64,
    pub resolved_field_reused: u32,
    pub diagnostics_available: u32,
    pub divergence_current_rms_a_per_m3: f64,
    pub divergence_field_rms_a_per_m2: f64,
    pub curl_h_minus_j_rms_a_per_m2: f64,
    pub api_version: [c_char; FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY],
    pub formula_version: [c_char; FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY],
    pub reconstruction_version: [c_char; FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY],
    pub operator_version: [c_char; FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY],
    pub realization_version: [c_char; FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY],
    pub engine_version: [c_char; FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY],
    pub certificate_version: [c_char; FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY],
    pub face_current_digest: [c_char; FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY],
    pub certificate_digest: [c_char; FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY],
    pub trusted_snapshot_digest: [c_char; FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY],
    pub resolved_field_cache_key_digest: [c_char; FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY],
    pub kernel_plan_cache_key_digest: [c_char; FULLMAG_FDM_CPU_OERSTED_DIGEST_CAPACITY],
    pub source_identity: [c_char; FULLMAG_FDM_CPU_OERSTED_TEXT_CAPACITY],
    pub error_message: [c_char; FULLMAG_FDM_CPU_OERSTED_ERROR_CAPACITY],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_cpu_oersted_abi_layout_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub reserved_flags: u64,
    pub source_cut_size: u64,
    pub source_cut_alignment: u64,
    pub certificate_size: u64,
    pub certificate_alignment: u64,
    pub request_size: u64,
    pub request_alignment: u64,
    pub result_size: u64,
    pub result_alignment: u64,
}

// ── Functions ──

#[cfg_attr(not(feature = "build-native"), allow(dead_code))]
extern "C" {
    pub fn fullmag_fdm_is_available() -> i32;

    pub fn fullmag_fdm_capability_bits_v1() -> u64;

    pub fn fullmag_fdm_backend_create(
        plan: *const fullmag_fdm_plan_desc,
    ) -> *mut fullmag_fdm_backend;

    pub fn fullmag_fdm_backend_create_time_policy_v2(
        plan: *const fullmag_fdm_plan_desc_v2,
    ) -> *mut fullmag_fdm_backend;

    pub fn fullmag_fdm_plan_ingestion_v2_create_checked(
        plan: *const fullmag_fdm_plan_desc_v2,
        out_ingestion: *mut *mut fullmag_fdm_plan_ingestion_v2,
    ) -> i32;

    pub fn fullmag_fdm_plan_ingestion_v2_receipt(
        ingestion: *const fullmag_fdm_plan_ingestion_v2,
        out_receipt: *mut fullmag_fdm_plan_desc_v2,
    ) -> i32;

    pub fn fullmag_fdm_plan_ingestion_v2_destroy(ingestion: *mut fullmag_fdm_plan_ingestion_v2);

    pub fn fullmag_fdm_backend_create_time_policy_v2_checked(
        plan: *const fullmag_fdm_plan_desc_v2,
        out_handle: *mut *mut fullmag_fdm_backend,
    ) -> i32;

    pub fn fullmag_fdm_backend_create_v2(
        plan: *const fullmag_fdm_multilayer_plan_desc_v2,
    ) -> *mut fullmag_fdm_backend;

    pub fn fullmag_fdm_backend_set_static_external_field_f64(
        handle: *mut fullmag_fdm_backend,
        field_xyz: *const f64,
        field_len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_step(
        handle: *mut fullmag_fdm_backend,
        dt_seconds: f64,
        out_stats: *mut fullmag_fdm_step_stats,
    ) -> i32;

    pub fn fullmag_fdm_backend_step_adaptive_batch_v1(
        handle: *mut fullmag_fdm_backend,
        initial_dt_seconds: f64,
        target_time_seconds: f64,
        max_steps: u32,
        out_steps: *mut fullmag_fdm_adaptive_batch_step_v1,
        capacity: u32,
        out_count: *mut u32,
    ) -> i32;

    pub fn fullmag_fdm_backend_copy_adaptive_attempts_v1(
        handle: *mut fullmag_fdm_backend,
        out_attempts: *mut fullmag_fdm_adaptive_attempt_v1,
        capacity: u32,
        out_count: *mut u32,
    ) -> i32;

    pub fn fullmag_fdm_backend_get_fsal_telemetry_v1(
        handle: *mut fullmag_fdm_backend,
        out_telemetry: *mut fullmag_fdm_fsal_telemetry_v1,
    ) -> i32;

    pub fn fullmag_fdm_backend_get_fsal_telemetry_v2(
        handle: *mut fullmag_fdm_backend,
        out_telemetry: *mut fullmag_fdm_fsal_telemetry_v2,
    ) -> i32;

    pub fn fullmag_fdm_backend_get_step_transaction_telemetry_v1(
        handle: *mut fullmag_fdm_backend,
        out_telemetry: *mut fullmag_fdm_step_transaction_telemetry_v1,
    ) -> i32;

    pub fn fullmag_fdm_backend_set_interrupt_poll(
        handle: *mut fullmag_fdm_backend,
        poll_fn: fullmag_fdm_interrupt_poll_fn,
        user_data: *mut c_void,
    ) -> i32;

    pub fn fullmag_fdm_backend_copy_field_f64(
        handle: *mut fullmag_fdm_backend,
        observable: fullmag_fdm_observable,
        out_xyz: *mut f64,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_copy_field_f32(
        handle: *mut fullmag_fdm_backend,
        observable: fullmag_fdm_observable,
        out_xyz: *mut f32,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_copy_scalar_field_f64(
        handle: *mut fullmag_fdm_backend,
        observable: fullmag_fdm_observable,
        out_values: *mut f64,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_copy_scalar_field_f32(
        handle: *mut fullmag_fdm_backend,
        observable: fullmag_fdm_observable,
        out_values: *mut f32,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_copy_layer_field_f64(
        handle: *mut fullmag_fdm_backend,
        layer_index: u32,
        observable: fullmag_fdm_observable,
        out_xyz: *mut f64,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_copy_layer_field_f32(
        handle: *mut fullmag_fdm_backend,
        layer_index: u32,
        observable: fullmag_fdm_observable,
        out_xyz: *mut f32,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_copy_field_preview_f64(
        handle: *mut fullmag_fdm_backend,
        observable: fullmag_fdm_observable,
        preview_nx: u32,
        preview_ny: u32,
        preview_nz: u32,
        z_origin: u32,
        z_stride: u32,
        out_xyz: *mut f64,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_copy_field_preview_f32(
        handle: *mut fullmag_fdm_backend,
        observable: fullmag_fdm_observable,
        preview_nx: u32,
        preview_ny: u32,
        preview_nz: u32,
        z_origin: u32,
        z_stride: u32,
        out_xyz: *mut f32,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_begin_field_snapshot(
        handle: *mut fullmag_fdm_backend,
        observable: fullmag_fdm_observable,
    ) -> *mut fullmag_fdm_field_snapshot;

    pub fn fullmag_fdm_backend_begin_preview_snapshot(
        handle: *mut fullmag_fdm_backend,
        observable: fullmag_fdm_observable,
        preview_nx: u32,
        preview_ny: u32,
        preview_nz: u32,
        z_origin: u32,
        z_stride: u32,
    ) -> *mut fullmag_fdm_preview_snapshot;

    pub fn fullmag_fdm_field_snapshot_wait(
        snapshot: *mut fullmag_fdm_field_snapshot,
        out_data: *mut *const std::ffi::c_void,
        out_len_bytes: *mut u64,
        out_desc: *mut fullmag_fdm_snapshot_desc,
    ) -> i32;

    pub fn fullmag_fdm_preview_snapshot_wait(
        snapshot: *mut fullmag_fdm_preview_snapshot,
        out_data: *mut *const std::ffi::c_void,
        out_len_bytes: *mut u64,
        out_desc: *mut fullmag_fdm_snapshot_desc,
    ) -> i32;

    pub fn fullmag_fdm_field_snapshot_destroy(snapshot: *mut fullmag_fdm_field_snapshot);

    pub fn fullmag_fdm_preview_snapshot_destroy(snapshot: *mut fullmag_fdm_preview_snapshot);

    pub fn fullmag_fdm_backend_upload_magnetization_f64(
        handle: *mut fullmag_fdm_backend,
        m_xyz: *const f64,
        len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_upload_magnetization_f32(
        handle: *mut fullmag_fdm_backend,
        m_xyz: *const f32,
        len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_llg_checkpoint_query_size_v1(
        handle: *mut fullmag_fdm_backend,
        out_required_bytes: *mut u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_llg_checkpoint_export_v1(
        handle: *mut fullmag_fdm_backend,
        destination: *mut c_void,
        exact_capacity: u64,
        out_info: *mut fullmag_fdm_llg_checkpoint_info_v1,
    ) -> i32;

    pub fn fullmag_fdm_backend_llg_checkpoint_import_v1(
        handle: *mut fullmag_fdm_backend,
        source: *const c_void,
        exact_bytes: u64,
        expected_info: *const fullmag_fdm_llg_checkpoint_info_v1,
    ) -> i32;

    pub fn fullmag_fdm_backend_upload_layer_magnetization_f64(
        handle: *mut fullmag_fdm_backend,
        layer_index: u32,
        m_xyz: *const f64,
        len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_upload_layer_magnetization_f32(
        handle: *mut fullmag_fdm_backend,
        layer_index: u32,
        m_xyz: *const f32,
        len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_refresh_multilayer_demag(handle: *mut fullmag_fdm_backend) -> i32;

    pub fn fullmag_fdm_backend_refresh_observables(handle: *mut fullmag_fdm_backend) -> i32;

    pub fn fullmag_fdm_backend_refresh_demag_observable(handle: *mut fullmag_fdm_backend) -> i32;

    pub fn fullmag_fdm_backend_snapshot_stats(
        handle: *mut fullmag_fdm_backend,
        out_stats: *mut fullmag_fdm_step_stats,
    ) -> i32;

    pub fn fullmag_fdm_backend_get_device_info(
        handle: *mut fullmag_fdm_backend,
        out_info: *mut fullmag_fdm_device_info,
    ) -> i32;

    pub fn fullmag_fdm_backend_llg_checkpoint_query_size_v2(
        handle: *mut fullmag_fdm_backend,
        out_required_bytes: *mut u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_llg_checkpoint_export_v2(
        handle: *mut fullmag_fdm_backend,
        destination: *mut c_void,
        exact_capacity: u64,
        out_info: *mut fullmag_fdm_llg_checkpoint_info_v2,
    ) -> i32;

    pub fn fullmag_fdm_backend_llg_checkpoint_import_v2(
        handle: *mut fullmag_fdm_backend,
        source: *const c_void,
        exact_bytes: u64,
        expected_info: *const fullmag_fdm_llg_checkpoint_info_v2,
    ) -> i32;

    pub fn fullmag_fdm_backend_set_checkpoint_execution_identity_v3(
        handle: *mut fullmag_fdm_backend,
        identity: *const fullmag_fdm_checkpoint_execution_identity_v3,
    ) -> i32;

    pub fn fullmag_fdm_backend_llg_checkpoint_query_size_v3(
        handle: *mut fullmag_fdm_backend,
        out_required_bytes: *mut u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_llg_checkpoint_export_v3(
        handle: *mut fullmag_fdm_backend,
        destination: *mut c_void,
        exact_capacity: u64,
        out_info: *mut fullmag_fdm_llg_checkpoint_info_v3,
    ) -> i32;

    pub fn fullmag_fdm_backend_llg_checkpoint_import_v3(
        handle: *mut fullmag_fdm_backend,
        source: *const c_void,
        exact_bytes: u64,
        expected_info: *const fullmag_fdm_llg_checkpoint_info_v3,
    ) -> i32;

    pub fn fullmag_fdm_backend_execution_receipt_v1(
        handle: *mut fullmag_fdm_backend,
        out_receipt: *mut fullmag_fdm_execution_receipt_v1,
    ) -> i32;

    pub fn fullmag_fdm_backend_execution_receipt_v2(
        handle: *mut fullmag_fdm_backend,
        out_receipt: *mut fullmag_fdm_execution_receipt_v2,
    ) -> i32;

    pub fn fullmag_fdm_backend_get_adaptive_execution_telemetry_v1(
        handle: *mut fullmag_fdm_backend,
        out_telemetry: *mut fullmag_fdm_adaptive_execution_telemetry_v1,
    ) -> i32;

    pub fn fullmag_fdm_backend_last_error(handle: *mut fullmag_fdm_backend) -> *const c_char;

    pub fn fullmag_fdm_backend_destroy(handle: *mut fullmag_fdm_backend);

    pub fn fullmag_fdm_cpu_transport_is_available_v1() -> i32;
    pub fn fullmag_fdm_cpu_transport_abi_layout_manifest_get_v1(
    ) -> *const fullmag_fdm_cpu_transport_abi_layout_manifest_v1;
    pub fn fullmag_fdm_cpu_charge_solve_v1(
        request: *const fullmag_fdm_cpu_charge_request_v1,
        result: *mut fullmag_fdm_cpu_charge_result_v1,
    ) -> i32;
    pub fn fullmag_fdm_cpu_steady_spin_solve_v1(
        request: *const fullmag_fdm_cpu_steady_spin_request_v1,
        charge: *const fullmag_fdm_cpu_charge_result_v1,
        result: *mut fullmag_fdm_cpu_steady_spin_result_v1,
    ) -> i32;
    pub fn fullmag_fdm_cpu_charge_result_destroy_v1(result: *mut fullmag_fdm_cpu_charge_result_v1);
    pub fn fullmag_fdm_cpu_oersted_abi_layout_get_v1(
    ) -> *const fullmag_fdm_cpu_oersted_abi_layout_v1;
    pub fn fullmag_fdm_cpu_oersted_abi_layout_manifest_get_v1(
    ) -> *const fullmag_fdm_cpu_transport_abi_layout_manifest_v1;
    pub fn fullmag_fdm_cpu_oersted_solve_v1(
        request: *const fullmag_fdm_cpu_oersted_request_v1,
        result: *mut fullmag_fdm_cpu_oersted_result_v1,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use std::ffi::CStr;
    use std::mem::{align_of, offset_of, size_of};

    use super::*;

    #[test]
    fn adaptive_execution_telemetry_v1_has_stable_layout() {
        assert_eq!(size_of::<fullmag_fdm_adaptive_execution_telemetry_v1>(), 64);
        assert_eq!(align_of::<fullmag_fdm_adaptive_execution_telemetry_v1>(), 8);
    }

    fn layout_record<'a>(
        records: &'a [fullmag_fdm_cpu_transport_abi_layout_record_v1],
        index: usize,
        expected_name: &str,
    ) -> &'a fullmag_fdm_cpu_transport_abi_layout_record_v1 {
        let record = &records[index];
        let actual_name = unsafe { CStr::from_ptr(record.record_name) }
            .to_str()
            .expect("layout record names must be UTF-8");
        assert_eq!(actual_name, expected_name);
        record
    }

    macro_rules! assert_layout_record {
        ($records:expr, $index:expr, $name:literal, $type:ty, [$($field:ident),+ $(,)?]) => {{
            let record = layout_record($records, $index, $name);
            assert_eq!(record.size, size_of::<$type>() as u64, "{} size", $name);
            assert_eq!(record.alignment, align_of::<$type>() as u64, "{} alignment", $name);
            let expected = [$( (stringify!($field), offset_of!($type, $field) as u64) ),+];
            assert_eq!(record.field_count, expected.len() as u64, "{} field count", $name);
            let fields = unsafe {
                std::slice::from_raw_parts(record.fields, record.field_count as usize)
            };
            for (field, (expected_name, expected_offset)) in fields.iter().zip(expected) {
                let actual_name = unsafe { CStr::from_ptr(field.field_name) }
                    .to_str()
                    .expect("layout field names must be UTF-8");
                assert_eq!(actual_name, expected_name, "{} field name", $name);
                assert_eq!(field.offset, expected_offset, "{}.{expected_name} offset", $name);
            }
        }};
    }

    #[test]
    fn cpu_transport_abi_layout_manifest_matches_every_rust_record_field() {
        let manifest = unsafe { fullmag_fdm_cpu_transport_abi_layout_manifest_get_v1() };
        assert!(!manifest.is_null());
        let manifest = unsafe { &*manifest };
        assert_eq!(manifest.abi_version, FULLMAG_FDM_CPU_TRANSPORT_ABI_V1);
        assert_eq!(
            manifest.struct_size as usize,
            size_of::<fullmag_fdm_cpu_transport_abi_layout_manifest_v1>()
        );
        assert_eq!(manifest.reserved_flags, 0);
        let records =
            unsafe { std::slice::from_raw_parts(manifest.records, manifest.record_count as usize) };
        assert_eq!(records.len(), 19);

        assert_layout_record!(
            records,
            0,
            "fullmag_fdm_cpu_transport_grid_v1",
            fullmag_fdm_cpu_transport_grid_v1,
            [nx, ny, nz, dx_m, dy_m, dz_m]
        );
        assert_layout_record!(
            records,
            1,
            "fullmag_fdm_cpu_f64_buffer_v1",
            fullmag_fdm_cpu_f64_buffer_v1,
            [data, capacity, length]
        );
        assert_layout_record!(
            records,
            2,
            "fullmag_fdm_cpu_charge_boundary_v1",
            fullmag_fdm_cpu_charge_boundary_v1,
            [kind, reserved, value]
        );
        assert_layout_record!(
            records,
            3,
            "fullmag_fdm_cpu_spin_boundary_v1",
            fullmag_fdm_cpu_spin_boundary_v1,
            [kind, reserved, potential_v]
        );
        assert_layout_record!(
            records,
            4,
            "fullmag_fdm_cpu_specified_current_face_v1",
            fullmag_fdm_cpu_specified_current_face_v1,
            [
                axis,
                outward_normal_sign,
                face_index,
                adjacent_cell,
                area_m2,
                outward_current_density_a_per_m2
            ]
        );
        assert_layout_record!(
            records,
            5,
            "fullmag_fdm_cpu_transport_interface_v1",
            fullmag_fdm_cpu_transport_interface_v1,
            [
                interface_id,
                axis,
                kind,
                negative_cell,
                positive_cell,
                from_cell,
                to_cell,
                g_up_s_per_m2,
                g_down_s_per_m2,
                g_r_s_per_m2,
                g_i_s_per_m2,
                magnetization
            ]
        );
        assert_layout_record!(
            records,
            6,
            "fullmag_fdm_cpu_charge_interface_observation_v1",
            fullmag_fdm_cpu_charge_interface_observation_v1,
            [
                interface_id,
                axis,
                reserved,
                negative_cell,
                positive_cell,
                from_cell,
                to_cell,
                g_up_s_per_m2,
                g_down_s_per_m2,
                from_potential_trace_v,
                to_potential_trace_v,
                delta_potential_trace_v,
                from_to_current_density_a_per_m2,
                global_face_current_density_a_per_m2
            ]
        );
        assert_layout_record!(
            records,
            7,
            "fullmag_fdm_cpu_charge_interface_observation_buffer_v1",
            fullmag_fdm_cpu_charge_interface_observation_buffer_v1,
            [data, capacity, length]
        );
        assert_layout_record!(
            records,
            8,
            "fullmag_fdm_cpu_spin_interface_observation_v1",
            fullmag_fdm_cpu_spin_interface_observation_v1,
            [
                interface_id,
                axis,
                reserved,
                negative_cell,
                positive_cell,
                from_cell,
                to_cell,
                incoming_longitudinal_a_per_m2,
                backflow_longitudinal_a_per_m2,
                absorbed_transverse_a_per_m2,
                negative_cell_flux_positive_axis_a_per_m2,
                positive_cell_flux_positive_axis_a_per_m2,
                from_side_outgoing_a_per_m2,
                to_side_transmitted_a_per_m2
            ]
        );
        assert_layout_record!(
            records,
            9,
            "fullmag_fdm_cpu_spin_interface_observation_buffer_v1",
            fullmag_fdm_cpu_spin_interface_observation_buffer_v1,
            [data, capacity, length]
        );
        assert_layout_record!(
            records,
            10,
            "fullmag_fdm_cpu_spin_reaction_lengths_v1",
            fullmag_fdm_cpu_spin_reaction_lengths_v1,
            [spin_flip_m, exchange_m, dephasing_m]
        );
        assert_layout_record!(
            records,
            11,
            "fullmag_fdm_cpu_charge_request_v1",
            fullmag_fdm_cpu_charge_request_v1,
            [
                abi_version,
                struct_size,
                reserved_flags,
                grid,
                device,
                precision,
                conductivity_s_per_m,
                conductivity_len,
                active_cells,
                active_cells_len,
                boundaries,
                specified_current_faces,
                specified_current_face_count,
                interfaces,
                interface_count,
                gauge,
                reserved0,
                relative_tolerance,
                absolute_tolerance_a_per_m3,
                max_iterations,
                api_version,
                operator_version,
                solver_version,
                residual_version,
                impressed_potential_jump_faces,
                impressed_potential_jump_face_count
            ]
        );
        assert_layout_record!(
            records,
            12,
            "fullmag_fdm_cpu_charge_result_v1",
            fullmag_fdm_cpu_charge_result_v1,
            [
                abi_version,
                struct_size,
                reserved_flags,
                status,
                reserved0,
                potential_v,
                jc_x_a_per_m2,
                jc_y_a_per_m2,
                jc_z_a_per_m2,
                jc_cell_xyz_a_per_m2,
                interface_observations,
                iterations,
                algebraic_residual_l2_a_per_m3,
                recomputed_algebraic_residual_l2_a_per_m3,
                physical_balance_integrated_l2_a,
                max_cell_current_imbalance_a,
                max_abs_divergence_a_per_m3,
                boundary_outward_current_a,
                net_boundary_current_a,
                accepted_snapshot_identity,
                accepted_snapshot,
                api_version,
                operator_version,
                interface_operator_version,
                solver_version,
                residual_version,
                runtime_owner,
                error_message
            ]
        );
        assert_layout_record!(
            records,
            13,
            "fullmag_fdm_cpu_steady_spin_request_v1",
            fullmag_fdm_cpu_steady_spin_request_v1,
            [
                abi_version,
                struct_size,
                reserved_flags,
                grid,
                device,
                precision,
                spin_conductivity_s_per_m,
                spin_conductivity_len,
                polarization,
                polarization_len,
                spin_hall_angle,
                spin_hall_angle_len,
                magnetization_xyz,
                magnetization_xyz_len,
                reactions,
                reaction_count,
                active_cells,
                active_cells_len,
                region_ids,
                region_id_count,
                boundaries,
                interfaces,
                interface_count,
                torque_target_cells,
                torque_target_cells_len,
                saturation_magnetization_a_per_m,
                saturation_magnetization_len,
                gamma_e_rad_per_s_t,
                relative_tolerance,
                absolute_tolerance_a,
                local_relative_tolerance,
                local_absolute_tolerance_a_per_m3,
                max_iterations,
                gmres_restart,
                api_version,
                formula_version,
                operator_version,
                electric_reconstruction_version,
                solver_version,
                residual_version,
                local_residual_version,
                interface_version,
                torque_operator_version
            ]
        );
        assert_layout_record!(
            records,
            14,
            "fullmag_fdm_cpu_steady_spin_result_v1",
            fullmag_fdm_cpu_steady_spin_result_v1,
            [
                abi_version,
                struct_size,
                reserved_flags,
                status,
                reserved0,
                spin_potential_xyz_v,
                q_x_xyz_a_per_m2,
                q_y_xyz_a_per_m2,
                q_z_xyz_a_per_m2,
                q_cell_ia_a_per_m2,
                reaction_spin_flip_xyz_a_per_m3,
                reaction_exchange_xyz_a_per_m3,
                reaction_dephasing_xyz_a_per_m3,
                reaction_total_xyz_a_per_m3,
                transport_torque_xyz_per_s,
                interface_observations,
                iterations,
                gmres_restart,
                initial_rhs_integrated_l2_a,
                recursive_residual_integrated_l2_a,
                recomputed_balance_integrated_l2_a,
                balance_tolerance_integrated_l2_a,
                boundary_outward_current_a,
                global_balance_closure_a,
                relative_global_balance,
                max_abs_residual_a_per_m3,
                api_version,
                formula_version,
                operator_version,
                electric_reconstruction_version,
                solver_version,
                residual_version,
                local_residual_version,
                interface_version,
                torque_operator_version,
                runtime_owner,
                convergence_reason,
                error_message
            ]
        );
        assert_layout_record!(
            records,
            15,
            "fullmag_fdm_cpu_transport_abi_layout_field_v1",
            fullmag_fdm_cpu_transport_abi_layout_field_v1,
            [field_name, offset]
        );
        assert_layout_record!(
            records,
            16,
            "fullmag_fdm_cpu_transport_abi_layout_record_v1",
            fullmag_fdm_cpu_transport_abi_layout_record_v1,
            [record_name, size, alignment, field_count, fields]
        );
        assert_layout_record!(
            records,
            17,
            "fullmag_fdm_cpu_transport_abi_layout_manifest_v1",
            fullmag_fdm_cpu_transport_abi_layout_manifest_v1,
            [
                abi_version,
                struct_size,
                reserved_flags,
                record_count,
                records
            ]
        );
        assert_layout_record!(
            records,
            18,
            "fullmag_fdm_cpu_impressed_potential_jump_face_v1",
            fullmag_fdm_cpu_impressed_potential_jump_face_v1,
            [
                source_cut_index,
                axis,
                normal_sign,
                negative_cell,
                positive_cell,
                potential_jump_v
            ]
        );
    }

    #[test]
    fn step_stats_abi_carries_hot_loop_scalar_readback_audit() {
        let stats = fullmag_fdm_step_stats {
            step: 1,
            time_seconds: 0.0,
            dt_seconds: 1.0e-12,
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
            hot_loop_d2h_bytes: 24,
            hot_loop_host_sync_count: 1,
            hot_loop_control_scalar_d2h_bytes: 24,
            hot_loop_control_scalar_host_sync_count: 1,
            multilayer_refresh_count: 1,
            multilayer_forward_fft_count: 3,
            multilayer_inverse_fft_count: 3,
            multilayer_pair_accumulation_count: 9,
        };

        assert_eq!(stats.hot_loop_d2h_bytes, 24);
        assert_eq!(stats.hot_loop_host_sync_count, 1);
        assert_eq!(stats.hot_loop_control_scalar_d2h_bytes, 24);
        assert_eq!(stats.hot_loop_control_scalar_host_sync_count, 1);
        assert_eq!(stats.multilayer_refresh_count, 1);
        assert_eq!(stats.multilayer_forward_fft_count, 3);
        assert_eq!(stats.multilayer_inverse_fft_count, 3);
        assert_eq!(stats.multilayer_pair_accumulation_count, 9);
    }

    #[test]
    fn adaptive_attempt_v1_is_a_fixed_batched_trace_record() {
        assert_eq!(size_of::<fullmag_fdm_adaptive_attempt_v1>(), 56);
        assert_eq!(offset_of!(fullmag_fdm_adaptive_attempt_v1, abi_version), 0);
        assert_eq!(offset_of!(fullmag_fdm_adaptive_attempt_v1, attempt_index), 8);
        assert_eq!(offset_of!(fullmag_fdm_adaptive_attempt_v1, dt_attempt_seconds), 24);
        assert_eq!(offset_of!(fullmag_fdm_adaptive_attempt_v1, dt_next_seconds), 48);
        assert_eq!(FULLMAG_FDM_ADAPTIVE_ATTEMPT_CAPACITY_V1, 51);
        let _copy: unsafe extern "C" fn(
            *mut fullmag_fdm_backend,
            *mut fullmag_fdm_adaptive_attempt_v1,
            u32,
            *mut u32,
        ) -> i32 = fullmag_fdm_backend_copy_adaptive_attempts_v1;
    }

    #[test]
    fn adaptive_batch_step_v1_has_stable_layout_and_ffi_symbol() {
        assert_eq!(size_of::<fullmag_fdm_adaptive_batch_step_v1>(), 64);
        assert_eq!(offset_of!(fullmag_fdm_adaptive_batch_step_v1, step), 16);
        assert_eq!(
            offset_of!(fullmag_fdm_adaptive_batch_step_v1, time_seconds),
            24
        );
        assert_eq!(
            offset_of!(fullmag_fdm_adaptive_batch_step_v1, rejected_attempts),
            56
        );
        assert_eq!(FULLMAG_FDM_ADAPTIVE_BATCH_STEP_CAPACITY_V1, 64);
        let _step: unsafe extern "C" fn(
            *mut fullmag_fdm_backend,
            f64,
            f64,
            u32,
            *mut fullmag_fdm_adaptive_batch_step_v1,
            u32,
            *mut u32,
        ) -> i32 = fullmag_fdm_backend_step_adaptive_batch_v1;
    }

    #[test]
    fn fsal_telemetry_v1_is_separate_from_frozen_step_stats_layout() {
        assert_eq!(size_of::<fullmag_fdm_step_stats>(), 192);
        assert_eq!(
            offset_of!(fullmag_fdm_step_stats, multilayer_pair_accumulation_count),
            184
        );
        assert_eq!(size_of::<fullmag_fdm_fsal_telemetry_v1>(), 64);
        assert_eq!(offset_of!(fullmag_fdm_fsal_telemetry_v1, abi_version), 0);
        assert_eq!(offset_of!(fullmag_fdm_fsal_telemetry_v1, struct_size), 4);
        assert_eq!(
            offset_of!(fullmag_fdm_fsal_telemetry_v1, transaction_commit_count),
            56
        );
        let _query: unsafe extern "C" fn(
            *mut fullmag_fdm_backend,
            *mut fullmag_fdm_fsal_telemetry_v1,
        ) -> i32 = fullmag_fdm_backend_get_fsal_telemetry_v1;
    }

    #[test]
    fn fsal_telemetry_v2_appends_typed_reason_counts() {
        assert_eq!(size_of::<fullmag_fdm_fsal_telemetry_v2>(), 192);
        assert_eq!(offset_of!(fullmag_fdm_fsal_telemetry_v2, abi_version), 0);
        assert_eq!(offset_of!(fullmag_fdm_fsal_telemetry_v2, struct_size), 4);
        assert_eq!(
            offset_of!(fullmag_fdm_fsal_telemetry_v2, invalidation_reason_counts),
            64
        );
        let _query: unsafe extern "C" fn(
            *mut fullmag_fdm_backend,
            *mut fullmag_fdm_fsal_telemetry_v2,
        ) -> i32 = fullmag_fdm_backend_get_fsal_telemetry_v2;
    }

    #[test]
    fn step_transaction_telemetry_v1_has_frozen_layout_and_ffi_symbol() {
        assert_eq!(size_of::<fullmag_fdm_step_transaction_telemetry_v1>(), 96);
        assert_eq!(
            offset_of!(fullmag_fdm_step_transaction_telemetry_v1, capture_count),
            16
        );
        assert_eq!(
            offset_of!(
                fullmag_fdm_step_transaction_telemetry_v1,
                stale_publication_count
            ),
            88
        );
        let _query: unsafe extern "C" fn(
            *mut fullmag_fdm_backend,
            *mut fullmag_fdm_step_transaction_telemetry_v1,
        ) -> i32 = fullmag_fdm_backend_get_step_transaction_telemetry_v1;
    }

    #[test]
    fn cpu_oersted_append_only_layout_matches_native_manifest() {
        let layout = unsafe { fullmag_fdm_cpu_oersted_abi_layout_get_v1() };
        assert!(!layout.is_null());
        let layout = unsafe { &*layout };
        assert_eq!(layout.abi_version, FULLMAG_FDM_CPU_OERSTED_ABI_V1);
        assert_eq!(
            layout.struct_size as usize,
            size_of::<fullmag_fdm_cpu_oersted_abi_layout_v1>()
        );
        assert_eq!(layout.reserved_flags, 0);
        assert_eq!(
            (layout.source_cut_size, layout.source_cut_alignment),
            (
                size_of::<fullmag_fdm_cpu_oersted_source_cut_v1>() as u64,
                align_of::<fullmag_fdm_cpu_oersted_source_cut_v1>() as u64
            )
        );
        assert_eq!(
            (layout.certificate_size, layout.certificate_alignment),
            (
                size_of::<fullmag_fdm_cpu_oersted_certificate_v1>() as u64,
                align_of::<fullmag_fdm_cpu_oersted_certificate_v1>() as u64
            )
        );
        assert_eq!(
            (layout.request_size, layout.request_alignment),
            (
                size_of::<fullmag_fdm_cpu_oersted_request_v1>() as u64,
                align_of::<fullmag_fdm_cpu_oersted_request_v1>() as u64
            )
        );
        assert_eq!(
            (layout.result_size, layout.result_alignment),
            (
                size_of::<fullmag_fdm_cpu_oersted_result_v1>() as u64,
                align_of::<fullmag_fdm_cpu_oersted_result_v1>() as u64
            )
        );

        let manifest = unsafe { fullmag_fdm_cpu_oersted_abi_layout_manifest_get_v1() };
        assert!(!manifest.is_null());
        let manifest = unsafe { &*manifest };
        assert_eq!(manifest.abi_version, FULLMAG_FDM_CPU_OERSTED_ABI_V1);
        assert_eq!(manifest.reserved_flags, 0);
        let records =
            unsafe { std::slice::from_raw_parts(manifest.records, manifest.record_count as usize) };
        assert_eq!(records.len(), 8);
        assert_layout_record!(
            records,
            0,
            "fullmag_fdm_cpu_oersted_const_f64_buffer_v1",
            fullmag_fdm_cpu_oersted_const_f64_buffer_v1,
            [data, length]
        );
        assert_layout_record!(
            records,
            1,
            "fullmag_fdm_cpu_oersted_const_u64_buffer_v1",
            fullmag_fdm_cpu_oersted_const_u64_buffer_v1,
            [data, length]
        );
        assert_layout_record!(
            records,
            2,
            "fullmag_fdm_cpu_oersted_const_i8_buffer_v1",
            fullmag_fdm_cpu_oersted_const_i8_buffer_v1,
            [data, length]
        );
        assert_layout_record!(
            records,
            3,
            "fullmag_fdm_cpu_oersted_source_cut_v1",
            fullmag_fdm_cpu_oersted_source_cut_v1,
            [
                stable_id,
                component_label,
                ordered_internal_face_ids,
                ordered_normals,
                drive_id,
                drive_kind,
                drive_value,
                drive_si_unit,
                revision,
                digest
            ]
        );
        assert_layout_record!(
            records,
            4,
            "fullmag_fdm_cpu_oersted_certificate_v1",
            fullmag_fdm_cpu_oersted_certificate_v1,
            [
                abi_version,
                struct_size,
                reserved_flags,
                closure_kind,
                global_continuity_passed,
                exterior_flux_passed,
                component_flux_passed,
                return_path_complete,
                reserved0,
                revision,
                version,
                digest,
                geometry_digest,
                conductor_mask_revision,
                conductor_mask_digest,
                face_current_revision,
                face_current_digest,
                component_labels,
                component_count,
                divergence_tolerance_a_per_m3,
                exterior_current_tolerance_a,
                measured_max_abs_divergence_a_per_m3,
                measured_component_exterior_current_a,
                source_cuts,
                source_cut_count,
                imported_certification_method,
                imported_field_digest
            ]
        );
        assert_layout_record!(
            records,
            5,
            "fullmag_fdm_cpu_oersted_request_v1",
            fullmag_fdm_cpu_oersted_request_v1,
            [
                abi_version,
                struct_size,
                reserved_flags,
                grid,
                origin_m,
                boundaries,
                reserved0,
                conductor_mask,
                conductor_mask_len,
                target_mask,
                target_mask_len,
                jc_x_a_per_m2,
                jc_y_a_per_m2,
                jc_z_a_per_m2,
                geometry_revision,
                geometry_digest,
                conductor_mask_revision,
                conductor_mask_digest,
                target_mask_revision,
                target_mask_digest,
                face_current_revision,
                face_current_digest,
                source_identity,
                envelope_revision,
                envelope_digest,
                stage_identity,
                evaluation_time_s,
                evaluated_envelope_multiplier,
                trusted_snapshot_revision,
                trusted_snapshot_digest,
                certificate
            ]
        );
        assert_layout_record!(
            records,
            6,
            "fullmag_fdm_cpu_oersted_result_v1",
            fullmag_fdm_cpu_oersted_result_v1,
            [
                abi_version,
                struct_size,
                reserved_flags,
                status,
                reserved0,
                field_xyz_a_per_m,
                face_current_revision,
                certificate_revision,
                trusted_snapshot_revision,
                envelope_revision,
                stage_identity,
                evaluation_time_s,
                evaluated_envelope_multiplier,
                plan_build_count,
                kernel_build_count,
                numerical_buffer_allocation_count,
                resolved_field_hit_count,
                resolved_field_miss_count,
                resolved_field_invalidation_count,
                trusted_fast_path_hit_count,
                resolved_field_reused,
                diagnostics_available,
                divergence_current_rms_a_per_m3,
                divergence_field_rms_a_per_m2,
                curl_h_minus_j_rms_a_per_m2,
                api_version,
                formula_version,
                reconstruction_version,
                operator_version,
                realization_version,
                engine_version,
                certificate_version,
                face_current_digest,
                certificate_digest,
                trusted_snapshot_digest,
                resolved_field_cache_key_digest,
                kernel_plan_cache_key_digest,
                source_identity,
                error_message
            ]
        );
        assert_layout_record!(
            records,
            7,
            "fullmag_fdm_cpu_oersted_abi_layout_v1",
            fullmag_fdm_cpu_oersted_abi_layout_v1,
            [
                abi_version,
                struct_size,
                reserved_flags,
                source_cut_size,
                source_cut_alignment,
                certificate_size,
                certificate_alignment,
                request_size,
                request_alignment,
                result_size,
                result_alignment
            ]
        );
    }

    #[test]
    fn llg_checkpoint_info_v1_matches_the_frozen_c_layout() {
        assert_eq!(size_of::<fullmag_fdm_llg_checkpoint_info_v1>(), 96);
        assert_eq!(align_of::<fullmag_fdm_llg_checkpoint_info_v1>(), 8);
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v1, schema_version),
            0
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v1, cell_count),
            16
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v1, current_time),
            40
        );
        assert_eq!(
            offset_of!(
                fullmag_fdm_llg_checkpoint_info_v1,
                transport_attempt_generation
            ),
            56
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v1, abm_last_dt),
            72
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v1, adaptive_previous_error),
            88
        );
    }

    #[test]
    fn llg_checkpoint_info_v2_matches_the_exact_execution_layout() {
        assert_eq!(FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V2, 2);
        assert_eq!(size_of::<fullmag_fdm_llg_checkpoint_info_v2>(), 248);
        assert_eq!(align_of::<fullmag_fdm_llg_checkpoint_info_v2>(), 8);
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v2, device_ordinal),
            40
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v2, cell_count),
            48
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v2, accepted_step_index),
            72
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v2, current_time),
            88
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v2, rhs_source_revision),
            112
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v2, abm_last_dt),
            152
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v2, adaptive_previous_error),
            168
        );
        assert_eq!(
            offset_of!(
                fullmag_fdm_llg_checkpoint_info_v2,
                fsal_accepted_state_revision
            ),
            176
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v2, fsal_integrator_identity),
            240
        );
    }

    #[test]
    fn llg_checkpoint_info_v3_matches_the_exact_execution_and_rng_layout() {
        assert_eq!(FULLMAG_FDM_LLG_CHECKPOINT_SCHEMA_V3, 3);
        assert_eq!(
            size_of::<fullmag_fdm_checkpoint_execution_identity_v3>(),
            88
        );
        assert_eq!(
            align_of::<fullmag_fdm_checkpoint_execution_identity_v3>(),
            4
        );
        assert_eq!(
            offset_of!(fullmag_fdm_checkpoint_execution_identity_v3, device_ordinal),
            80
        );
        assert_eq!(size_of::<fullmag_fdm_llg_checkpoint_info_v3>(), 320);
        assert_eq!(align_of::<fullmag_fdm_llg_checkpoint_info_v3>(), 8);
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v3, execution_identity),
            8
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v3, cell_count),
            104
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v3, thermal_seed),
            160
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v3, rng_algorithm),
            168
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v3, fsal_valid),
            216
        );
        assert_eq!(
            offset_of!(
                fullmag_fdm_llg_checkpoint_info_v3,
                fsal_accepted_state_revision
            ),
            248
        );
        assert_eq!(
            offset_of!(fullmag_fdm_llg_checkpoint_info_v3, fsal_integrator_identity),
            312
        );
    }

    #[test]
    fn frozen_spins_v1_is_an_append_only_nullable_plan_extension() {
        assert_eq!(FULLMAG_FDM_FROZEN_SPINS_ABI_V1, 1);
        assert_eq!(FULLMAG_FDM_CAPABILITY_FROZEN_SPINS_V1, 1_u64 << 0);
        assert!(
            offset_of!(fullmag_fdm_plan_desc, frozen_mask)
                > offset_of!(fullmag_fdm_plan_desc, stats_stride)
        );
        assert!(
            offset_of!(fullmag_fdm_plan_desc, frozen_reference_xyz)
                > offset_of!(fullmag_fdm_plan_desc, frozen_mask_len)
        );
        assert!(
            offset_of!(fullmag_fdm_plan_desc, frozen_reference_len)
                > offset_of!(fullmag_fdm_plan_desc, frozen_reference_xyz)
        );
    }
}
