//! Raw FFI declarations for the Fullmag FDM CUDA backend.
//!
//! These match `native/include/fullmag_fdm.h` exactly.
//! All safe wrappers live in `fullmag-runner::native_fdm`.

#![allow(non_camel_case_types)]

use std::os::raw::c_char;

// ── Return codes ──

pub const FULLMAG_FDM_OK: i32 = 0;
pub const FULLMAG_FDM_ERR_INVALID: i32 = -1;
pub const FULLMAG_FDM_ERR_CUDA: i32 = -2;
pub const FULLMAG_FDM_ERR_INTERNAL: i32 = -3;

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
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fdm_observable {
    FULLMAG_FDM_OBSERVABLE_M = 1,
    FULLMAG_FDM_OBSERVABLE_H_EX = 2,
}

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
    pub initial_magnetization_xyz: *const f64,
    pub initial_magnetization_len: u64,
}

// ── Step stats ──

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fdm_step_stats {
    pub step: u64,
    pub time_seconds: f64,
    pub dt_seconds: f64,
    pub exchange_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
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

// ── Opaque handle ──

#[repr(C)]
pub struct fullmag_fdm_backend {
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

    pub fn fullmag_fdm_backend_copy_field_f64(
        handle: *mut fullmag_fdm_backend,
        observable: fullmag_fdm_observable,
        out_xyz: *mut f64,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fdm_backend_get_device_info(
        handle: *mut fullmag_fdm_backend,
        out_info: *mut fullmag_fdm_device_info,
    ) -> i32;

    pub fn fullmag_fdm_backend_last_error(handle: *mut fullmag_fdm_backend) -> *const c_char;

    pub fn fullmag_fdm_backend_destroy(handle: *mut fullmag_fdm_backend);
}
