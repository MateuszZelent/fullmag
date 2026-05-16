//! Raw FFI declarations for the Fullmag FEM GPU backend scaffold.
//!
//! These match `native/include/fullmag_fem.h` exactly.
//! All safe wrappers live in `fullmag-runner::native_fem`.

#![allow(non_camel_case_types)]

use std::ffi::c_void;
use std::os::raw::c_char;

pub const FULLMAG_FEM_OK: i32 = 0;
pub const FULLMAG_FEM_ERR_INVALID: i32 = -1;
pub const FULLMAG_FEM_ERR_UNAVAILABLE: i32 = -2;
pub const FULLMAG_FEM_ERR_INTERNAL: i32 = -3;
pub const FULLMAG_FEM_ERR_INTERRUPTED: i32 = -4;

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
    pub max_reject: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_observable {
    FULLMAG_FEM_OBSERVABLE_M = 1,
    FULLMAG_FEM_OBSERVABLE_H_EX = 2,
    FULLMAG_FEM_OBSERVABLE_H_DEMAG = 3,
    FULLMAG_FEM_OBSERVABLE_H_EXT = 4,
    FULLMAG_FEM_OBSERVABLE_H_EFF = 5,
    FULLMAG_FEM_OBSERVABLE_H_ANI = 6,
    FULLMAG_FEM_OBSERVABLE_H_DMI = 7,
    FULLMAG_FEM_OBSERVABLE_H_MEL = 8,
    // FND-010 fix: added F-12 observables to match native/include/fullmag_fem.h
    FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC = 9,
    FULLMAG_FEM_OBSERVABLE_H_DMI_BULK = 10,
    FULLMAG_FEM_OBSERVABLE_H_OE = 11,
    FULLMAG_FEM_OBSERVABLE_H_THERM = 12,
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
    FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET = 1,
    FULLMAG_FEM_DEMAG_AIRBOX_ROBIN = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_stage_stop_reason {
    FULLMAG_FEM_STAGE_STOP_REASON_TORQUE = 1,
    FULLMAG_FEM_STAGE_STOP_REASON_ENERGY = 2,
    FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS = 3,
    FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME = 4,
    FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME = 5,
    FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED = 6,
    FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR = 7,
}

pub type fullmag_fem_interrupt_poll_fn = Option<unsafe extern "C" fn(*mut c_void) -> i32>;

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
    pub periodic_node_pairs: *const u32,
    pub n_periodic_node_pairs: u32,
    /// MFEM boundary attribute markers for periodic seam face pairs:
    /// flat `[marker_a, marker_b] × count`.  Null/0 when not applicable.
    pub periodic_boundary_pair_markers: *const u32,
    pub periodic_boundary_pair_count: u32,
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
    pub has_absolute_tolerance: i32,
    pub absolute_tolerance: f64,
    pub max_iterations: u32,
    pub print_level: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_field_refresh_policy {
    pub has_demag_interval_s: i32,
    pub demag_interval_s: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_relax_stop {
    pub has_torque_tolerance_apm: i32,
    pub torque_tolerance_apm: f64,
    pub has_energy_tolerance_j: i32,
    pub energy_tolerance_j: f64,
    pub has_max_steps: i32,
    pub max_steps: u64,
    pub has_max_pseudotime_s: i32,
    pub max_pseudotime_s: f64,
    pub has_max_physical_time_s: i32,
    pub max_physical_time_s: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_stage_completion {
    pub has_reason: i32,
    pub reason: fullmag_fem_stage_stop_reason,
    pub has_metric_name: i32,
    pub metric_name: [std::os::raw::c_char; 64],
    pub metric_value: f64,
    pub threshold: f64,
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
    pub robin_beta_mode: i32,
    pub robin_beta_factor: f64,
    pub initial_magnetization_xyz: *const f64,
    pub initial_magnetization_len: u64,
    pub dt_seconds: f64,
    pub adaptive_config: *const fullmag_fem_adaptive_config,
    pub field_refresh: fullmag_fem_field_refresh_policy,
    pub relax_stop: fullmag_fem_relax_stop,
    pub has_uniaxial_anisotropy: i32,
    pub uniaxial_anisotropy_constant: f64,
    pub uniaxial_anisotropy_k2: f64,
    pub anisotropy_axis: [f64; 3],
    pub has_interfacial_dmi: i32,
    pub dmi_constant: f64,
    pub dmi_interface_normal: [f64; 3], // FND-009
    pub has_bulk_dmi: i32,
    pub bulk_dmi_constant: f64,
    pub has_cubic_anisotropy: i32,
    pub cubic_kc1: f64,
    pub cubic_kc2: f64,
    pub cubic_kc3: f64,
    pub cubic_axis1: [f64; 3],
    pub cubic_axis2: [f64; 3],
    // Per-node spatially varying fields (null + 0 = uniform)
    pub ms_field: *const f64,
    pub ms_field_len: u64,
    pub a_field: *const f64,
    pub a_field_len: u64,
    pub alpha_field: *const f64,
    pub alpha_field_len: u64,
    pub ku_field: *const f64,
    pub ku_field_len: u64,
    pub ku2_field: *const f64,
    pub ku2_field_len: u64,
    pub dind_field: *const f64,
    pub dind_field_len: u64,
    pub dbulk_field: *const f64,
    pub dbulk_field_len: u64,
    pub kc1_field: *const f64,
    pub kc1_field_len: u64,
    pub kc2_field: *const f64,
    pub kc2_field_len: u64,
    pub kc3_field: *const f64,
    pub kc3_field_len: u64,
    // Spin-transfer torque
    pub has_zhang_li_stt: i32,
    pub has_slonczewski_stt: i32,
    pub stt_current_density_am2: [f64; 3],
    pub stt_degree: f64,
    pub stt_beta: f64,
    pub stt_spin_polarization: [f64; 3],
    pub stt_lambda: f64,
    pub stt_epsilon_prime: f64,
    pub stt_free_layer_thickness: f64,
    pub stt_current_sign: f64,
    // Oersted field (cylindrical conductor)
    pub has_oersted_cylinder: i32,
    pub oersted_current: f64,
    pub oersted_radius: f64,
    pub oersted_center: [f64; 3],
    pub oersted_axis: [f64; 3],
    pub oersted_field_xyz: *const f64,
    pub oersted_field_len: u64,
    pub oersted_time_dep_kind: u32,
    pub oersted_time_dep_freq: f64,
    pub oersted_time_dep_phase: f64,
    pub oersted_time_dep_offset: f64,
    pub oersted_time_dep_t_on: f64,
    pub oersted_time_dep_t_off: f64,
    // Thermal noise
    pub temperature: f64,
    // Magnetoelastic coupling (prescribed-strain)
    pub has_magnetoelastic: i32,
    pub mel_b1: f64,
    pub mel_b2: f64,
    pub mel_uniform_strain: i32,
    pub mel_strain_voigt: *const f64,
    pub mel_strain_len: u64,
    // FEM-029/030 fix: explicit GPU device and MFEM device selection.
    // -1 means "use default / env fallback".
    pub gpu_device_index: i32,
    /// Thermal seed for reproducibility. 0 = use random device.
    pub thermal_seed: u64,
    /// FEM-030: explicit MFEM device string. null = use env / compiled default.
    pub mfem_device_string: *const std::ffi::c_char,
    /// FND-013: use consistent (full) mass matrix for exchange. 0 = lumped, 1 = consistent.
    pub use_consistent_mass: i32,
    /// Compute initial effective field during backend creation. 0 = lazy, 1 = eager.
    pub eager_initial_effective_field: i32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
#[allow(non_snake_case)]
pub struct fullmag_fem_step_stats {
    pub step: u64,
    pub time_seconds: f64,
    pub dt_seconds: f64,
    pub mx: f64,
    pub my: f64,
    pub mz: f64,
    pub exchange_energy_joules: f64,
    pub demag_energy_joules: f64,
    pub external_energy_joules: f64,
    pub anisotropy_energy_joules: f64,
    pub dmi_energy_joules: f64,
    pub total_energy_joules: f64,
    pub magnetoelastic_energy_joules: f64,
    pub max_effective_field_amplitude: f64,
    pub max_demag_field_amplitude: f64,
    pub max_rhs_amplitude: f64,
    pub max_torque_Apm: f64,
    pub demag_solve_count: u32,
    pub demag_linear_iterations: u32,
    pub demag_linear_residual: f64,
    pub wall_time_ns: u64,
    pub exchange_wall_time_ns: u64,
    pub demag_wall_time_ns: u64,
    pub demag_assemble_wall_time_ns: u64,
    pub demag_solve_wall_time_ns: u64,
    pub demag_solver_setup_wall_time_ns: u64,
    pub demag_solver_apply_wall_time_ns: u64,
    pub demag_solver_setup_reused: i32,
    pub demag_recover_wall_time_ns: u64,
    pub demag_energy_wall_time_ns: u64,
    pub rhs_wall_time_ns: u64,
    pub extra_energy_wall_time_ns: u64,
    pub snapshot_wall_time_ns: u64,
    pub error_estimate: f64,
    pub rejected_attempts: u32,
    pub dt_suggested: f64,
    pub rhs_evaluations: u32,
    pub fsal_reused: i32,
    /// Requested OMP thread count (from env / config).
    pub requested_omp_threads: i32,
    /// Effective OMP thread count (after auto-capping).
    pub effective_omp_threads: i32,
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
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_availability_info {
    pub available: i32,
    pub built_with_mfem_stack: i32,
    pub built_with_cuda_runtime: i32,
    pub built_with_ceed: i32,
    pub native_fem_cpu_available: i32,
    pub native_fem_gpu_available: i32,
    pub mfem_cuda_available: i32,
    pub hypre_gpu_available: i32,
    pub libceed_used_hot_path: i32,
    pub visible_cuda_device_count: i32,
    pub requested_gpu_index: i32,
    pub resolved_gpu_index: i32,
    pub reason: [c_char; 256],
    pub available_any: i32,
    pub available_cpu: i32,
    pub available_gpu: i32,
    pub reason_cpu: [c_char; 256],
    pub reason_gpu: [c_char; 256],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_transfer_audit {
    pub h2d_bytes: u64,
    pub d2h_bytes: u64,
    pub host_read_count: u64,
    pub host_write_count: u64,
    pub host_read_write_count: u64,
    pub hot_loop_h2d_bytes: u64,
    pub hot_loop_d2h_bytes: u64,
    pub hot_loop_host_read_count: u64,
    pub hot_loop_host_write_count: u64,
    pub hot_loop_host_read_write_count: u64,
    pub hot_loop_host_sync_count: u64,
    pub hot_loop_exchange_h2d_bytes: u64,
    pub hot_loop_exchange_d2h_bytes: u64,
    pub hot_loop_exchange_host_sync_count: u64,
    pub hot_loop_compute_h2d_bytes: u64,
    pub hot_loop_compute_d2h_bytes: u64,
    pub hot_loop_compute_host_sync_count: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_data_residency {
    FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH = 0,
    FULLMAG_FEM_RESIDENCY_MIXED = 1,
    FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct fullmag_fem_gpu_state_info {
    pub allocated: i32,
    pub node_count: u64,
    pub dof_len: u64,
    pub stage_count: u32,
    pub device_bytes: u64,
    pub reduction_workspace_bytes: u64,
    pub source_of_truth: fullmag_fem_data_residency,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_gpu_rk_plan_info {
    pub exchange_only_enabled: i32,
    pub stage_count: u32,
    pub uses_cuda_kernels: i32,
    pub allows_exchange_host_sync: i32,
    pub stage_exchange_device_resident: i32,
    pub exchange_operator_mode: [c_char; 64],
    pub reason: [c_char; 256],
}

#[repr(C)]
pub struct fullmag_fem_backend {
    _private: [u8; 0],
}

extern "C" {
    pub fn fullmag_fem_is_available() -> i32;
    pub fn fullmag_fem_get_availability_info(out_info: *mut fullmag_fem_availability_info) -> i32;

    pub fn fullmag_fem_backend_create(
        plan: *const fullmag_fem_plan_desc,
    ) -> *mut fullmag_fem_backend;

    pub fn fullmag_fem_backend_step(
        handle: *mut fullmag_fem_backend,
        dt_seconds: f64,
        out_stats: *mut fullmag_fem_step_stats,
    ) -> i32;

    pub fn fullmag_fem_backend_set_interrupt_poll(
        handle: *mut fullmag_fem_backend,
        poll_fn: fullmag_fem_interrupt_poll_fn,
        user_data: *mut c_void,
    ) -> i32;

    pub fn fullmag_fem_backend_copy_field_f64(
        handle: *mut fullmag_fem_backend,
        observable: fullmag_fem_observable,
        out_xyz: *mut f64,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fem_backend_upload_magnetization_f64(
        handle: *mut fullmag_fem_backend,
        m_xyz: *const f64,
        len: u64,
    ) -> i32;

    pub fn fullmag_fem_backend_snapshot_stats(
        handle: *mut fullmag_fem_backend,
        out_stats: *mut fullmag_fem_step_stats,
    ) -> i32;

    pub fn fullmag_fem_backend_stage_completion(
        handle: *mut fullmag_fem_backend,
        out_completion: *mut fullmag_fem_stage_completion,
    ) -> i32;

    pub fn fullmag_fem_backend_get_device_info(
        handle: *mut fullmag_fem_backend,
        out_info: *mut fullmag_fem_device_info,
    ) -> i32;

    pub fn fullmag_fem_backend_get_transfer_audit(
        handle: *mut fullmag_fem_backend,
        out_audit: *mut fullmag_fem_transfer_audit,
    ) -> i32;

    pub fn fullmag_fem_backend_get_gpu_state_info(
        handle: *mut fullmag_fem_backend,
        out_info: *mut fullmag_fem_gpu_state_info,
    ) -> i32;

    pub fn fullmag_fem_backend_get_gpu_rk_plan_info(
        handle: *mut fullmag_fem_backend,
        out_info: *mut fullmag_fem_gpu_rk_plan_info,
    ) -> i32;

    pub fn fullmag_fem_backend_last_error(handle: *mut fullmag_fem_backend) -> *const c_char;

    pub fn fullmag_fem_backend_destroy(handle: *mut fullmag_fem_backend);

    pub fn fullmag_fem_backend_upload_strain(
        handle: *mut fullmag_fem_backend,
        strain_voigt: *const f64,
        len: u64,
        uniform: i32,
    ) -> i32;
}

// ── GPU Dense Generalized Eigenvalue Solver (Etap A4) ────────────────────
//
// Descriptor for `fullmag_fem_eigen_dense`.  Mirrors the C struct exactly.

#[repr(C)]
pub struct fullmag_fem_eigen_dense_desc {
    /// Stiffness matrix K — lower triangle, column-major, n*n f64.
    pub k_lower_col_major: *const f64,
    /// Mass matrix M — lower triangle, column-major, n*n f64.
    pub m_lower_col_major: *const f64,
    /// Matrix dimension (number of active DOF).
    pub n: u32,
    /// How many eigenvalues/vectors to return (≤ n).
    pub n_eigenvalues: u32,
    /// Caller-allocated output: `n_eigenvalues` eigenvalues.
    pub out_eigenvalues: *mut f64,
    /// Caller-allocated output: n * n_eigenvalues doubles, col-major.
    pub out_eigenvectors: *mut f64,
    /// Optional human-readable message buffer (may be null).
    pub out_reason: *mut std::os::raw::c_char,
    /// Capacity of `out_reason` including null terminator.
    pub reason_len: u32,
}

extern "C" {
    /// Solve K·x = λ·M·x on the GPU using cuSolverDN Dsygvd.
    ///
    /// Returns `FULLMAG_FEM_OK` on success.
    /// Returns `FULLMAG_FEM_ERR_UNAVAILABLE` (-2) when the GPU/cuSolver stack
    /// is not compiled in; the caller should fall back to the CPU path.
    pub fn fullmag_fem_eigen_dense(desc: *mut fullmag_fem_eigen_dense_desc) -> i32;
}

// ── FND-010: compile-time FFI enum parity checks ──

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify the Rust observable enum has the expected number of variants
    /// matching the C header (M=1 .. H_THERM=12 → 12 variants).
    #[test]
    fn observable_enum_has_12_variants() {
        let variants = [
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_M,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EX,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DEMAG,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EXT,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EFF,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_MEL,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI_BULK,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_OE,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_THERM,
        ];
        assert_eq!(variants.len(), 12);
        // Verify sequential discriminants 1..=12
        for (i, v) in variants.iter().enumerate() {
            assert_eq!(
                *v as i32,
                (i + 1) as i32,
                "variant {i} discriminant mismatch"
            );
        }
    }

    /// Verify plan desc contains the use_consistent_mass field (FND-013).
    #[test]
    fn plan_desc_has_consistent_mass_field() {
        let plan = std::mem::MaybeUninit::<fullmag_fem_plan_desc>::zeroed();
        let plan = unsafe { plan.assume_init() };
        assert_eq!(plan.use_consistent_mass, 0);
        assert_eq!(plan.eager_initial_effective_field, 0);
    }

    /// Verify native solver policy ABI carries the Hypre print level knob.
    #[test]
    fn solver_config_abi_has_print_level_field() {
        let config = std::mem::MaybeUninit::<fullmag_fem_solver_config>::zeroed();
        let config = unsafe { config.assume_init() };
        assert_eq!(config.has_absolute_tolerance, 0);
        assert_eq!(config.absolute_tolerance, 0.0);
        assert_eq!(config.print_level, 0);
    }

    /// Verify mesh desc carries periodic node-pair metadata for native FEM PBC gates.
    #[test]
    fn mesh_desc_has_periodic_node_pair_fields() {
        let mesh = std::mem::MaybeUninit::<fullmag_fem_mesh_desc>::zeroed();
        let mesh = unsafe { mesh.assume_init() };
        assert!(mesh.periodic_node_pairs.is_null());
        assert_eq!(mesh.n_periodic_node_pairs, 0);
    }

    /// Verify mesh desc carries periodic boundary pair marker fields for native demag PBC.
    #[test]
    fn mesh_desc_has_periodic_boundary_pair_marker_fields() {
        let mesh = std::mem::MaybeUninit::<fullmag_fem_mesh_desc>::zeroed();
        let mesh = unsafe { mesh.assume_init() };
        assert!(mesh.periodic_boundary_pair_markers.is_null());
        assert_eq!(mesh.periodic_boundary_pair_count, 0);
    }

    /// Verify transfer-audit ABI fields required by the ALL IN GPU FEM rollout.
    #[test]
    fn transfer_audit_abi_has_hot_loop_fields() {
        let audit = std::mem::MaybeUninit::<fullmag_fem_transfer_audit>::zeroed();
        let audit = unsafe { audit.assume_init() };
        assert_eq!(audit.hot_loop_h2d_bytes, 0);
        assert_eq!(audit.hot_loop_d2h_bytes, 0);
        assert_eq!(audit.hot_loop_host_read_count, 0);
        assert_eq!(audit.hot_loop_host_write_count, 0);
        assert_eq!(audit.hot_loop_host_sync_count, 0);
        assert_eq!(audit.hot_loop_exchange_h2d_bytes, 0);
        assert_eq!(audit.hot_loop_exchange_d2h_bytes, 0);
        assert_eq!(audit.hot_loop_exchange_host_sync_count, 0);
        assert_eq!(audit.hot_loop_compute_h2d_bytes, 0);
        assert_eq!(audit.hot_loop_compute_d2h_bytes, 0);
        assert_eq!(audit.hot_loop_compute_host_sync_count, 0);
    }

    /// Verify availability ABI separates build-time and hot-path GPU capabilities.
    #[test]
    fn availability_abi_has_split_fem_gpu_capability_fields() {
        let info = std::mem::MaybeUninit::<fullmag_fem_availability_info>::zeroed();
        let info = unsafe { info.assume_init() };
        assert_eq!(info.native_fem_cpu_available, 0);
        assert_eq!(info.native_fem_gpu_available, 0);
        assert_eq!(info.mfem_cuda_available, 0);
        assert_eq!(info.hypre_gpu_available, 0);
        assert_eq!(info.libceed_used_hot_path, 0);
    }

    /// Verify native FEM demag timing totals are ABI-visible.
    #[test]
    fn demag_profile_abi_has_timing_fields() {
        let stats = std::mem::MaybeUninit::<fullmag_fem_step_stats>::zeroed();
        let stats = unsafe { stats.assume_init() };
        assert_eq!(stats.demag_wall_time_ns, 0);
        assert_eq!(stats.demag_assemble_wall_time_ns, 0);
        assert_eq!(stats.demag_solve_wall_time_ns, 0);
        assert_eq!(stats.demag_solver_setup_wall_time_ns, 0);
        assert_eq!(stats.demag_solver_apply_wall_time_ns, 0);
        assert_eq!(stats.demag_solver_setup_reused, 0);
        assert_eq!(stats.demag_recover_wall_time_ns, 0);
        assert_eq!(stats.demag_energy_wall_time_ns, 0);
        assert_eq!(stats.extra_energy_wall_time_ns, 0);
    }

    /// Verify Phase 1 exposes GPU state residency metadata through C ABI.
    #[test]
    fn gpu_state_info_abi_has_residency_and_allocation_fields() {
        let info = std::mem::MaybeUninit::<fullmag_fem_gpu_state_info>::zeroed();
        let info = unsafe { info.assume_init() };
        assert_eq!(info.allocated, 0);
        assert_eq!(info.node_count, 0);
        assert_eq!(info.dof_len, 0);
        assert_eq!(info.stage_count, 0);
        assert_eq!(info.device_bytes, 0);
        assert_eq!(info.reduction_workspace_bytes, 0);
        assert_eq!(
            info.source_of_truth,
            fullmag_fem_data_residency::FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH
        );
    }

    /// Verify Phase 2 exposes the exchange-only GPU RK decision through C ABI.
    #[test]
    fn gpu_rk_plan_info_abi_has_exchange_only_gate_fields() {
        let info = std::mem::MaybeUninit::<fullmag_fem_gpu_rk_plan_info>::zeroed();
        let info = unsafe { info.assume_init() };
        assert_eq!(info.exchange_only_enabled, 0);
        assert_eq!(info.stage_count, 0);
        assert_eq!(info.uses_cuda_kernels, 0);
        assert_eq!(info.allows_exchange_host_sync, 0);
        assert_eq!(info.stage_exchange_device_resident, 0);
        assert_eq!(info.exchange_operator_mode[0], 0);
        assert_eq!(info.reason[0], 0);
    }
}
