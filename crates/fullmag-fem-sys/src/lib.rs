//! Raw FFI declarations for the Fullmag FEM GPU backend scaffold.
//!
//! These match `native/include/fullmag_fem.h` exactly.
//! All safe wrappers live in `fullmag-runner::native_fem`.

#![allow(non_camel_case_types)]

use std::os::raw::c_char;

pub const FULLMAG_FEM_OK: i32 = 0;
pub const FULLMAG_FEM_ERR_INVALID: i32 = -1;
pub const FULLMAG_FEM_ERR_UNAVAILABLE: i32 = -2;
pub const FULLMAG_FEM_ERR_INTERNAL: i32 = -3;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_precision {
    FULLMAG_FEM_PRECISION_SINGLE = 1,
    FULLMAG_FEM_PRECISION_DOUBLE = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_integrator {
    FULLMAG_FEM_INTEGRATOR_HEUN = 1,
    FULLMAG_FEM_INTEGRATOR_RK4 = 2,
    FULLMAG_FEM_INTEGRATOR_RK23_BS = 3,
    FULLMAG_FEM_INTEGRATOR_RK45_DP54 = 4,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_adaptive_config {
    pub atol: f64,
    pub rtol: f64,
    pub dt_initial: f64,
    pub dt_min: f64,
    pub dt_max: f64,
    pub safety: f64,
    pub growth_limit: f64,
    pub shrink_limit: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_observable {
    FULLMAG_FEM_OBSERVABLE_M = 1,
    FULLMAG_FEM_OBSERVABLE_H_EX = 2,
    FULLMAG_FEM_OBSERVABLE_H_DEMAG = 3,
    FULLMAG_FEM_OBSERVABLE_H_EXT = 4,
    FULLMAG_FEM_OBSERVABLE_H_EFF = 5,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_linear_solver {
    FULLMAG_FEM_LINEAR_SOLVER_CG = 1,
    FULLMAG_FEM_LINEAR_SOLVER_GMRES = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_preconditioner {
    FULLMAG_FEM_PRECONDITIONER_NONE = 0,
    FULLMAG_FEM_PRECONDITIONER_JACOBI = 1,
    FULLMAG_FEM_PRECONDITIONER_AMG = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_demag_realization {
    FULLMAG_FEM_DEMAG_TRANSFER_GRID = 0,
    FULLMAG_FEM_DEMAG_POISSON_AIRBOX = 1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_mesh_desc {
    pub nodes_xyz: *const f64,
    pub n_nodes: u32,
    pub elements: *const u32,
    pub n_elements: u32,
    pub element_markers: *const u32,
    pub boundary_faces: *const u32,
    pub n_boundary_faces: u32,
    pub boundary_markers: *const u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_material_desc {
    pub saturation_magnetisation: f64,
    pub exchange_stiffness: f64,
    pub damping: f64,
    pub gyromagnetic_ratio: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_solver_config {
    pub solver: fullmag_fem_linear_solver,
    pub preconditioner: fullmag_fem_preconditioner,
    pub relative_tolerance: f64,
    pub max_iterations: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_plan_desc {
    pub mesh: fullmag_fem_mesh_desc,
    pub material: fullmag_fem_material_desc,
    pub fe_order: u32,
    pub hmax: f64,
    pub precision: fullmag_fem_precision,
    pub integrator: fullmag_fem_integrator,
    pub enable_exchange: i32,
    pub enable_demag: i32,
    pub has_external_field: i32,
    pub external_field_am: [f64; 3],
    pub demag_solver: fullmag_fem_solver_config,
    pub air_box_factor: f64,
    pub demag_realization: fullmag_fem_demag_realization,
    pub poisson_boundary_marker: i32,
    pub demag_kernel_xx_spectrum: *const f64,
    pub demag_kernel_yy_spectrum: *const f64,
    pub demag_kernel_zz_spectrum: *const f64,
    pub demag_kernel_xy_spectrum: *const f64,
    pub demag_kernel_xz_spectrum: *const f64,
    pub demag_kernel_yz_spectrum: *const f64,
    pub demag_kernel_spectrum_len: u64,
    pub initial_magnetization_xyz: *const f64,
    pub initial_magnetization_len: u64,
    pub dt_seconds: f64,
    pub adaptive_config: *const fullmag_fem_adaptive_config,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_step_stats {
    pub step: u64,
    pub time_seconds: f64,
    pub dt_seconds: f64,
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub total_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
    pub demag_linear_iterations: u32,
    pub demag_linear_residual: f64,
    pub wall_time_ns: u64,
    pub error_estimate: f64,
    pub rejected_attempts: u32,
    pub dt_suggested: f64,
    pub rhs_evaluations: u32,
    pub fsal_reused: i32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_device_info {
    pub name: [c_char; 128],
    pub is_gpu_enabled: i32,
    pub compute_capability_major: i32,
    pub compute_capability_minor: i32,
    pub driver_version: i32,
    pub runtime_version: i32,
}

#[repr(C)]
pub struct fullmag_fem_backend {
    _private: [u8; 0],
}

extern "C" {
    pub fn fullmag_fem_is_available() -> i32;

    pub fn fullmag_fem_backend_create(
        plan: *const fullmag_fem_plan_desc,
    ) -> *mut fullmag_fem_backend;

    pub fn fullmag_fem_backend_step(
        handle: *mut fullmag_fem_backend,
        dt_seconds: f64,
        out_stats: *mut fullmag_fem_step_stats,
    ) -> i32;

    pub fn fullmag_fem_backend_copy_field_f64(
        handle: *mut fullmag_fem_backend,
        observable: fullmag_fem_observable,
        out_xyz: *mut f64,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fem_backend_get_device_info(
        handle: *mut fullmag_fem_backend,
        out_info: *mut fullmag_fem_device_info,
    ) -> i32;

    pub fn fullmag_fem_backend_last_error(handle: *mut fullmag_fem_backend) -> *const c_char;

    pub fn fullmag_fem_backend_destroy(handle: *mut fullmag_fem_backend);
}
