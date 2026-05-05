//! Raw FFI declarations for the Fullmag FDM CUDA backend.
//!
//! These match `native/include/fullmag_fdm.h` exactly.
//! All safe wrappers live in `fullmag-runner::native_fdm`.

#![allow(non_camel_case_types)]

use std::ffi::c_void;
use std::os::raw::c_char;

// ── Constants ──

pub const FULLMAG_FDM_MAX_EXCHANGE_REGIONS: usize = 256;

// ── Return codes ──

pub const FULLMAG_FDM_OK: i32 = 0;
pub const FULLMAG_FDM_ERR_INVALID: i32 = -1;
pub const FULLMAG_FDM_ERR_CUDA: i32 = -2;
pub const FULLMAG_FDM_ERR_INTERNAL: i32 = -3;
pub const FULLMAG_FDM_ERR_INTERRUPTED: i32 = -4;

// ── Enums ──

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_precision {
    FULLMAG_FDM_PRECISION_SINGLE = 1,
    FULLMAG_FDM_PRECISION_DOUBLE = 2,
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
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_snapshot_scalar_type {
    FULLMAG_FDM_SNAPSHOT_SCALAR_F32 = 1,
    FULLMAG_FDM_SNAPSHOT_SCALAR_F64 = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_boundary_correction {
    FULLMAG_FDM_BOUNDARY_NONE = 0,
    FULLMAG_FDM_BOUNDARY_VOLUME = 1,
    FULLMAG_FDM_BOUNDARY_FULL = 2,
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

    // Uniaxial anisotropy
    pub has_uniaxial_anisotropy: i32,
    pub uniaxial_anisotropy_constant: f64,
    pub uniaxial_anisotropy_k2: f64,
    pub anisotropy_axis: [f64; 3],

    pub ku1_field: *const f64,
    pub ku2_field: *const f64,

    // Cubic anisotropy
    pub has_cubic_anisotropy: i32,
    pub cubic_kc1: f64,
    pub cubic_kc2: f64,
    pub cubic_kc3: f64,
    pub cubic_axis1: [f64; 3],
    pub cubic_axis2: [f64; 3],

    pub kc1_field: *const f64,
    pub kc2_field: *const f64,
    pub kc3_field: *const f64,

    // DMI
    pub has_interfacial_dmi: i32,
    pub dmi_d_interfacial: f64,
    pub has_bulk_dmi: i32,
    pub dmi_d_bulk: f64,

    // Magnetoelastic coupling
    pub has_magnetoelastic: i32,
    pub mel_b1: f64,
    pub mel_b2: f64,
    pub mel_strain: [f64; 6],

    pub temperature: f64,

    pub current_density_x: f64,
    pub current_density_y: f64,
    pub current_density_z: f64,
    pub stt_degree: f64,
    pub stt_beta: f64,

    pub stt_p_x: f64,
    pub stt_p_y: f64,
    pub stt_p_z: f64,
    pub stt_lambda: f64,
    pub stt_epsilon_prime: f64,
    pub stt_free_layer_thickness: f64,

    // Spin-Orbit Torque (SOT)
    pub has_sot: i32,
    pub sot_je: f64,
    pub sot_xi_dl: f64,
    pub sot_xi_fl: f64,
    pub sot_sigma: [f64; 3],
    pub sot_thickness: f64,

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
    pub active_mask: *const u8,
    pub active_mask_len: u64,
    pub region_mask: *const u32,
    pub region_mask_len: u64,
    pub exchange_lut: *const f64,
    pub exchange_lut_len: u64,
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

#[repr(C)]
pub struct fullmag_fdm_field_snapshot {
    _private: [u8; 0],
}

#[repr(C)]
pub struct fullmag_fdm_preview_snapshot {
    _private: [u8; 0],
}

// ── Functions ──

#[cfg_attr(not(feature = "build-native"), allow(dead_code))]
extern "C" {
    pub fn fullmag_fdm_is_available() -> i32;

    pub fn fullmag_fdm_backend_create(
        plan: *const fullmag_fdm_plan_desc,
    ) -> *mut fullmag_fdm_backend;

    pub fn fullmag_fdm_backend_step(
        handle: *mut fullmag_fdm_backend,
        dt_seconds: f64,
        out_stats: *mut fullmag_fdm_step_stats,
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

    pub fn fullmag_fdm_backend_last_error(handle: *mut fullmag_fdm_backend) -> *const c_char;

    pub fn fullmag_fdm_backend_destroy(handle: *mut fullmag_fdm_backend);
}
