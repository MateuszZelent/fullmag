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
pub const FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION: u32 = 1;
pub const FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION: u32 = 1;

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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_relax_algorithm {
    FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB = 1,
    FULLMAG_FEM_RELAX_NONLINEAR_CG = 2,
    FULLMAG_FEM_RELAX_TANGENT_PLANE_IMPLICIT = 3,
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

pub const FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION: u32 = 2;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct fullmag_fem_adaptive_config_v2 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub base: fullmag_fem_adaptive_config,
    pub has_max_spin_rotation: i32,
    pub max_spin_rotation: f64,
    pub has_norm_tolerance: i32,
    pub norm_tolerance: f64,
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
    FULLMAG_FEM_OBSERVABLE_TORQUE = 13,
    FULLMAG_FEM_OBSERVABLE_DEMAG_PHI = 14,
    FULLMAG_FEM_OBSERVABLE_H_DRIVE = 15,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_time_dependence_kind {
    FULLMAG_FEM_TIME_CONSTANT = 0,
    FULLMAG_FEM_TIME_SINUSOIDAL = 1,
    FULLMAG_FEM_TIME_PULSE = 2,
    FULLMAG_FEM_TIME_PIECEWISE_LINEAR = 3,
    FULLMAG_FEM_TIME_SINC_PULSE = 4,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_time_origin {
    FULLMAG_FEM_TIME_STAGE_LOCAL = 0,
    FULLMAG_FEM_TIME_ABSOLUTE = 1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_time_point {
    pub time_s: f64,
    pub value: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub union fullmag_fem_time_dependence_parameters {
    pub sinusoidal: fullmag_fem_sinusoidal_time_desc,
    pub pulse: fullmag_fem_pulse_time_desc,
    pub sinc_pulse: fullmag_fem_sinc_pulse_time_desc,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_sinusoidal_time_desc {
    pub frequency_hz: f64,
    pub phase_rad: f64,
    pub offset: f64,
}
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_pulse_time_desc {
    pub t_on_s: f64,
    pub t_off_s: f64,
}
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_sinc_pulse_time_desc {
    pub cutoff_hz: f64,
    pub t0_s: f64,
    pub amplitude: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct fullmag_fem_time_dependence_desc {
    pub abi_version: u32,
    pub struct_size: u32,
    pub kind: u32,
    pub parameters: fullmag_fem_time_dependence_parameters,
    pub points: *const fullmag_fem_time_point,
    pub point_count: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_field_target_desc {
    pub abi_version: u32,
    pub struct_size: u32,
    pub kind: u32,
    pub element_markers: *const u32,
    pub element_marker_count: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_geometry_mask_node {
    pub kind: u32,
    pub child_a: u32,
    pub child_b: u32,
    pub center_m: [f64; 3],
    pub size_m: [f64; 3],
    pub axis: [f64; 3],
    pub radius_m: f64,
    pub height_m: f64,
    pub translation_m: [f64; 3],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_geometry_mask_desc {
    pub abi_version: u32,
    pub struct_size: u32,
    pub nodes: *const fullmag_fem_geometry_mask_node,
    pub node_count: u64,
    pub root_index: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_spatial_profile_desc {
    pub abi_version: u32,
    pub struct_size: u32,
    pub kind: u32,
    pub sinc_axis: [f64; 3],
    pub sinc_period_m: f64,
    pub sinc_center_m: f64,
    pub sinc_width_m: f64,
    pub sinc_window: u32,
    pub geometry_mask: *const fullmag_fem_geometry_mask_desc,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct fullmag_fem_regional_field_drive_desc {
    pub abi_version: u32,
    pub struct_size: u32,
    pub stable_id_hash: u64,
    pub target: fullmag_fem_field_target_desc,
    pub spatial_profile: fullmag_fem_spatial_profile_desc,
    pub amplitude_b_t: f64,
    pub direction: [f64; 3],
    pub waveform: fullmag_fem_time_dependence_desc,
    pub time_origin: u32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_regional_field_drive_abi_layout {
    pub abi_version: u32,
    pub struct_size: u32,
    pub time_dependence_desc_size: u64,
    pub field_target_desc_size: u64,
    pub spatial_profile_desc_size: u64,
    pub regional_field_drive_desc_size: u64,
    pub plan_desc_size: u64,
    pub plan_regional_field_drives_offset: u64,
    pub plan_regional_field_drive_count_offset: u64,
    pub plan_stage_start_time_s_offset: u64,
    pub step_stats_size: u64,
    pub step_stats_drive_energy_joules_offset: u64,
    pub step_stats_rk_transaction_capture_host_wall_time_ns_offset: u64,
    pub step_stats_demag_hypre_timed_solve_count_offset: u64,
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
    FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER = 3,
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
    FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT = 8,
}

pub type fullmag_fem_interrupt_poll_fn = Option<unsafe extern "C" fn(*mut c_void) -> i32>;

pub const FULLMAG_FEM_MESH_DESC_ABI_VERSION: u32 = 2;
pub const FULLMAG_FEM_MESH_DESC_ABI_LAYOUT_FINGERPRINT: &str =
    "fullmag:fem-mesh-desc:abi:v2:lp64:size232:typed-csr-global-ordinals";
pub const FULLMAG_FEM_MESH_ABI_LAYOUT_VERSION: u32 = 1;
pub const FULLMAG_FEM_MESH_ABI_FIELD_COUNT: usize = 30;
pub const FULLMAG_FEM_MESH_ABI_FINGERPRINT_CAPACITY: usize = 96;
pub const FULLMAG_FEM_CELL_TET4: u32 = 1;
pub const FULLMAG_FEM_CELL_PRISM6: u32 = 2;
pub const FULLMAG_FEM_CELL_PYRAMID5: u32 = 3;
pub const FULLMAG_FEM_CELL_HEX8: u32 = 4;
pub const FULLMAG_FEM_FACET_TRI3: u32 = 1;
pub const FULLMAG_FEM_FACET_QUAD4: u32 = 2;
pub const FULLMAG_FEM_FACET_ROLE_EXTERIOR: u32 = 1;
pub const FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE: u32 = 2;
pub const FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM: u32 = 3;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_mesh_desc {
    pub abi_version: u32,
    pub struct_size: u32,
    pub nodes_xyz: *const f64,
    pub nodes_xyz_len: u64,
    pub cell_types: *const u32,
    pub cell_types_len: u64,
    pub cell_offsets: *const u32,
    pub cell_offsets_len: u64,
    pub cell_nodes: *const u32,
    pub cell_nodes_len: u64,
    pub cell_global_ordinals: *const u64,
    pub cell_global_ordinals_len: u64,
    pub cell_markers: *const u32,
    pub cell_markers_len: u64,
    pub facet_types: *const u32,
    pub facet_types_len: u64,
    pub facet_roles: *const u32,
    pub facet_roles_len: u64,
    pub facet_offsets: *const u32,
    pub facet_offsets_len: u64,
    pub facet_nodes: *const u32,
    pub facet_nodes_len: u64,
    pub facet_global_ordinals: *const u64,
    pub facet_global_ordinals_len: u64,
    pub facet_markers: *const u32,
    pub facet_markers_len: u64,
    pub periodic_node_pairs: *const u32,
    pub periodic_node_pairs_len: u64,
    /// MFEM boundary attribute markers for periodic seam face pairs:
    /// flat `[marker_a, marker_b] × count`.  Null/0 when not applicable.
    pub periodic_boundary_pair_markers: *const u32,
    pub periodic_boundary_pair_markers_len: u64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct fullmag_fem_mesh_abi_layout {
    pub abi_version: u32,
    pub struct_size: u32,
    pub mesh_desc_abi_version: u32,
    pub mesh_desc_struct_size: u32,
    pub field_count: u32,
    pub reserved: u32,
    pub field_offsets: [u64; FULLMAG_FEM_MESH_ABI_FIELD_COUNT],
    pub layout_fingerprint: [c_char; FULLMAG_FEM_MESH_ABI_FINGERPRINT_CAPACITY],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct fullmag_fem_mesh_abi_record {
    pub magic: [c_char; 40],
    pub record_version: u32,
    pub record_size: u32,
    pub endian_tag: u32,
    pub reserved: u32,
    pub layout: fullmag_fem_mesh_abi_layout,
}

const _: () = {
    assert!(std::mem::size_of::<fullmag_fem_mesh_desc>() == 232);
    assert!(std::mem::align_of::<fullmag_fem_mesh_desc>() == 8);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, abi_version) == 0);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, struct_size) == 4);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, nodes_xyz) == 8);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, nodes_xyz_len) == 16);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_types) == 24);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_types_len) == 32);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_offsets) == 40);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_offsets_len) == 48);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_nodes) == 56);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_nodes_len) == 64);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_global_ordinals) == 72);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_global_ordinals_len) == 80);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_markers) == 88);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_markers_len) == 96);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_types) == 104);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_types_len) == 112);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_roles) == 120);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_roles_len) == 128);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_offsets) == 136);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_offsets_len) == 144);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_nodes) == 152);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_nodes_len) == 160);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_global_ordinals) == 168);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_global_ordinals_len) == 176);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_markers) == 184);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, facet_markers_len) == 192);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, periodic_node_pairs) == 200);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, periodic_node_pairs_len) == 208);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, periodic_boundary_pair_markers) == 216);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_desc, periodic_boundary_pair_markers_len) == 224);
    assert!(std::mem::size_of::<fullmag_fem_mesh_abi_layout>() == 360);
    assert!(std::mem::align_of::<fullmag_fem_mesh_abi_layout>() == 8);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_layout, abi_version) == 0);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_layout, struct_size) == 4);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_layout, mesh_desc_abi_version) == 8);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_layout, mesh_desc_struct_size) == 12);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_layout, field_count) == 16);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_layout, reserved) == 20);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_layout, field_offsets) == 24);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_layout, layout_fingerprint) == 264);
    assert!(std::mem::size_of::<fullmag_fem_mesh_abi_record>() == 416);
    assert!(std::mem::align_of::<fullmag_fem_mesh_abi_record>() == 8);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_record, magic) == 0);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_record, record_version) == 40);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_record, record_size) == 44);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_record, endian_tag) == 48);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_record, reserved) == 52);
    assert!(std::mem::offset_of!(fullmag_fem_mesh_abi_record, layout) == 56);
};

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
    // Raw integer by design: C publishes 0 while has_reason == 0, which is
    // not a valid fullmag_fem_stage_stop_reason discriminant.
    pub reason: i32,
    pub has_metric_name: i32,
    pub metric_name: [std::os::raw::c_char; 64],
    pub metric_value: f64,
    pub threshold: f64,
    pub relaxation_controller_policy_version: u32,
    pub torque_confirmation_samples_required: u32,
    pub torque_confirmation_samples_current: u32,
    pub energy_rejected_attempts: u64,
    pub controller_tightening_count: u64,
    pub controller_at_floor: i32,
    pub energy_increase_relative_tolerance: f64,
    pub energy_increase_absolute_tolerance_j: f64,
    pub controller_tightening_factor: f64,
    pub max_error_floor: f64,
}

impl Default for fullmag_fem_stage_completion {
    fn default() -> Self {
        Self {
            has_reason: 0,
            reason: fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_TORQUE as i32,
            has_metric_name: 0,
            metric_name: [0; 64],
            metric_value: 0.0,
            threshold: 0.0,
            relaxation_controller_policy_version: 0,
            torque_confirmation_samples_required: 0,
            torque_confirmation_samples_current: 0,
            energy_rejected_attempts: 0,
            controller_tightening_count: 0,
            controller_at_floor: 0,
            energy_increase_relative_tolerance: 0.0,
            energy_increase_absolute_tolerance_j: 0.0,
            controller_tightening_factor: 0.0,
            max_error_floor: 0.0,
        }
    }
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
    pub anisotropy_axis_x_field: *const f64,
    pub anisotropy_axis_x_field_len: u64,
    pub anisotropy_axis_y_field: *const f64,
    pub anisotropy_axis_y_field_len: u64,
    pub anisotropy_axis_z_field: *const f64,
    pub anisotropy_axis_z_field_len: u64,
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
    pub ms_element_field: *const f64,
    pub ms_element_field_len: u64,
    pub a_element_field: *const f64,
    pub a_element_field_len: u64,
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
    /// Strict FEM GPU demag policy. 0 = runner/default policy.
    pub gpu_demag_mode: i32,
    /// FND-013: use consistent (full) mass matrix for exchange. 0 = lumped, 1 = consistent.
    pub use_consistent_mass: i32,
    /// Compute initial effective field during backend creation. 0 = lazy, 1 = eager.
    pub eager_initial_effective_field: i32,
    /// Whether precession mode is explicitly set. 0 = default precessional mode.
    pub has_precession_enabled: i32,
    /// 1 = full Gilbert LLG, 0 = pure damping relaxation.
    pub precession_enabled: i32,
    pub regional_field_drives: *const fullmag_fem_regional_field_drive_desc,
    pub regional_field_drive_count: u64,
    pub stage_start_time_s: f64,
    // Append-only versioned STT extension. Keep after the established plan prefix.
    pub stt_formula_version: u32,
    pub stt_realization_version: u32,
    pub stt_operator_version: u32,
    pub stt_stack_normal: [f64; 3],
    pub stt_lande_g: f64,
    pub stt_active_node_mask: *const u8,
    pub stt_active_node_mask_len: u64,
    pub stt_active_element_mask: *const u8,
    pub stt_active_element_mask_len: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_host_thread_policy_reason {
    FULLMAG_FEM_HOST_THREAD_POLICY_NONE = 0,
    FULLMAG_FEM_HOST_THREAD_POLICY_EXTERNAL_AUTO_RESOLVED = 1,
    FULLMAG_FEM_HOST_THREAD_POLICY_SMALL_MESH = 2,
    FULLMAG_FEM_HOST_THREAD_POLICY_MEDIUM_MESH = 3,
    FULLMAG_FEM_HOST_THREAD_POLICY_GPU_DEFAULT_ONE = 4,
    FULLMAG_FEM_HOST_THREAD_POLICY_AUTO_UNCAPPED = 5,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_steady_transport_execution_lane {
    FULLMAG_FEM_STEADY_TRANSPORT_CPU_DOUBLE = 1,
    FULLMAG_FEM_STEADY_TRANSPORT_GPU_DOUBLE = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_steady_transport_interface_model {
    FULLMAG_FEM_STEADY_TRANSPORT_TRANSPARENT_CONFORMING_H1 = 1,
    FULLMAG_FEM_STEADY_TRANSPORT_MIXING_BROKEN_H1 = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_steady_transport_charge_gauge {
    FULLMAG_FEM_STEADY_TRANSPORT_BOUNDARY_REFERENCE = 1,
    FULLMAG_FEM_STEADY_TRANSPORT_ZERO_MEAN_POTENTIAL = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_steady_transport_request_v1 {
    pub abi_version: u32,
    pub reserved_flags: u32,
    pub struct_size: u64,
    pub execution_lane: fullmag_fem_steady_transport_execution_lane,
    pub interface_model: fullmag_fem_steady_transport_interface_model,
    pub charge_gauge: fullmag_fem_steady_transport_charge_gauge,
    pub constitutive_version: *const c_char,
    pub operator_version: *const c_char,
    pub physical_residual_version: *const c_char,
    pub mesh: fullmag_fem_mesh_desc,
    pub charge_conductivity_spm_per_element: *const f64,
    pub charge_conductivity_spm_per_element_len: u64,
    pub magnetization_xyz: *const f64,
    pub magnetization_xyz_len: u64,
    pub sigma_s_spm: f64,
    pub polarization_p: f64,
    pub theta_sh: f64,
    pub lambda_sf_m: f64,
    pub has_lambda_j: i32,
    pub lambda_j_m: f64,
    pub has_lambda_phi: i32,
    pub lambda_phi_m: f64,
    pub gamma_e_per_ts: f64,
    pub saturation_magnetization_apm: f64,
    pub relative_tolerance: f64,
    pub absolute_tolerance: f64,
    pub maximum_iterations: u32,
    pub charge_dirichlet_boundary_attributes: *const u32,
    pub charge_dirichlet_values_v: *const f64,
    pub charge_dirichlet_count: u64,
    pub spin_dirichlet_boundary_attributes: *const u32,
    pub spin_dirichlet_values_v: *const f64,
    pub spin_dirichlet_count: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_steady_transport_result_v1 {
    pub abi_version: u32,
    pub reserved_flags: u32,
    pub struct_size: u64,
    pub electric_potential_v: *mut f64,
    pub electric_potential_v_len: u64,
    pub charge_current_density_xyz_apm2: *mut f64,
    pub charge_current_density_xyz_apm2_len: u64,
    pub spin_potential_xyz_v: *mut f64,
    pub spin_potential_xyz_v_len: u64,
    pub spin_current_tensor_row_major_qia_apm2: *mut f64,
    pub spin_current_tensor_row_major_qia_apm2_len: u64,
    pub torque_xyz_per_s: *mut f64,
    pub torque_xyz_len: u64,
    pub charge_converged: i32,
    pub charge_iterations: u32,
    pub charge_relative_residual: f64,
    pub net_boundary_current_a: f64,
    pub current_density_volume_average_apm2: [f64; 3],
    pub spin_converged: i32,
    pub spin_iterations: u32,
    pub spin_relative_residual: f64,
    pub boundary_spin_flux_a: [f64; 3],
    pub reaction_integral_a: [f64; 3],
    pub angular_momentum_balance_apm2: [f64; 3],
    pub torque_volume_average_per_s: [f64; 3],
    pub torque_l2_per_s: f64,
    pub error_message: [c_char; 256],
    pub diagnostics_json: [c_char; 1024],
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
    pub drive_energy_joules: f64,
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
    pub relaxation_preconditioner_wall_time_ns: u64,
    pub relaxation_state_copy_wall_time_ns: u64,
    pub relaxation_state_upload_wall_time_ns: u64,
    pub relaxation_retraction_wall_time_ns: u64,
    pub relaxation_gradient_wall_time_ns: u64,
    pub relaxation_metric_wall_time_ns: u64,
    pub relaxation_line_search_wall_time_ns: u64,
    pub relaxation_update_wall_time_ns: u64,
    pub relaxation_preconditioner_cache_hits: u32,
    pub relaxation_preconditioner_cache_misses: u32,
    pub error_estimate: f64,
    pub rejected_attempts: u32,
    pub dt_suggested: f64,
    pub rhs_evaluations: u32,
    pub fsal_reused: i32,
    /// Requested OMP thread count (from env / config).
    pub requested_omp_threads: i32,
    /// Effective OMP thread count (after auto-capping).
    pub effective_omp_threads: i32,
    /// Native FEM CPU thread cap reason enum.
    pub cpu_thread_cap_reason: i32,
    /// Effective native BoomerAMG relaxation type; zero when AMG is inactive.
    pub demag_amg_relax_type: i32,
    pub demag_amg_coarsening: i32,
    pub demag_amg_interpolation: i32,
    pub demag_amg_aggressive_coarsening: i32,
    pub demag_amg_strength_threshold: f64,
    pub demag_amg_strength_threshold_is_set: i32,
    pub demag_amg_max_levels: i32,
    pub demag_amg_max_levels_is_set: i32,
    pub rk_transaction_capture_host_wall_time_ns: u64,
    pub rk_transaction_capture_device_elapsed_time_ns: u64,
    pub rk_transaction_capture_bytes: u64,
    pub rk_transaction_restore_host_wall_time_ns: u64,
    pub rk_transaction_restore_device_elapsed_time_ns: u64,
    pub rk_transaction_restore_bytes: u64,
    pub rk_transaction_rollback_count: u64,
    pub rk_transaction_commit_count: u64,
    pub demag_hypre_wait_in_enqueue_wall_time_ns: u64,
    pub demag_hypre_host_api_wall_time_ns: u64,
    pub demag_hypre_device_elapsed_time_ns: u64,
    pub demag_hypre_wait_out_enqueue_wall_time_ns: u64,
    pub demag_hypre_event_wait_count: u64,
    pub demag_hypre_timed_solve_count: u64,
}

pub const FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION: u32 = 1;

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct fullmag_fem_accepted_energy_proof_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub accepted_energy_proof_available: i32,
    pub accepted_energy_delta_j: f64,
    pub accepted_energy_roundoff_bound_j: f64,
    pub accepted_energy_delta_upper_j: f64,
    pub armijo_increment_rhs_j: f64,
}

pub const FULLMAG_FEM_SOLVER_ATTEMPT_RECORD_V1_ABI_VERSION: u32 = 1;

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct fullmag_fem_solver_attempt_record_v1 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub attempt: u64,
    pub target_step: u64,
    pub time_seconds: f64,
    pub dt_attempt_seconds: f64,
    pub eta: f64,
    pub max_norm_defect: f64,
    pub max_spin_rotation: f64,
    pub decision: u32,
    pub reason: u32,
    pub dt_next_seconds: f64,
    pub demag_solve_count: u32,
    pub demag_linear_iterations: u32,
    pub demag_linear_residual: f64,
    pub rhs_evaluations: u32,
    pub estimator_order: i32,
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
    pub gpu_memory_free_bytes: u64,
    pub gpu_memory_total_bytes: u64,
}

pub const FULLMAG_FEM_RUNTIME_BUILD_INFO_V1_ABI_VERSION: u32 = 1;
pub const FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY: usize = 32;
pub const FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY: usize = 32;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_runtime_build_info {
    pub abi_version: u32,
    pub struct_size: u32,
    pub mfem_version: [c_char; FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
}

pub const FULLMAG_FEM_RUNTIME_BUILD_INFO_V2_ABI_VERSION: u32 = 2;

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_runtime_build_info_v2 {
    pub abi_version: u32,
    pub struct_size: u32,
    pub mfem_version: [c_char; FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
    pub hypre_version: [c_char; FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY],
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
    pub native_fem_gpu_full_demag_available: i32,
    pub mfem_cuda_available: i32,
    pub hypre_gpu_available: i32,
    pub libceed_used_hot_path: i32,
    pub visible_cuda_device_count: i32,
    pub requested_gpu_index: i32,
    pub resolved_gpu_index: i32,
    pub gpu_memory_free_bytes: u64,
    pub gpu_memory_total_bytes: u64,
    pub reason: [c_char; 256],
    pub available_any: i32,
    pub available_cpu: i32,
    pub available_gpu: i32,
    pub reason_cpu: [c_char; 256],
    pub reason_gpu: [c_char; 256],
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_frequency_domain_status {
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK = 0,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE = 1,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR = 2,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR = 3,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_SOLVE_ERROR = 4,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_ARTIFACT_ERROR = 5,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED = 6,
}

pub type fullmag_fem_frequency_domain_apply_callback = Option<
    unsafe extern "C" fn(
        user_data: *mut c_void,
        in_: *const f64,
        out: *mut f64,
        error_message: *mut c_char,
    ) -> fullmag_fem_frequency_domain_status,
>;

pub type fullmag_fem_frequency_domain_complex_apply_callback = Option<
    unsafe extern "C" fn(
        user_data: *mut c_void,
        in_real: *const f64,
        in_imag: *const f64,
        out_real: *mut f64,
        out_imag: *mut f64,
        error_message: *mut c_char,
    ) -> fullmag_fem_frequency_domain_status,
>;

pub type fullmag_fem_frequency_domain_apply_with_potential_callback = Option<
    unsafe extern "C" fn(
        user_data: *mut c_void,
        in_: *const f64,
        out: *mut f64,
        out_phi: *mut f64,
        out_phi_len: u64,
        error_message: *mut c_char,
    ) -> fullmag_fem_frequency_domain_status,
>;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_frequency_domain_study_kind {
    FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE = 1,
    FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_EIGENMODES = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_frequency_domain_execution_lane {
    FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_VALIDATION = 0,
    FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_CPU = 1,
    FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_PRODUCTION_GPU = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_frequency_domain_phase_convention {
    FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T = 0,
    FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T = 1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_frequency_domain_drive_kind {
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_UNSPECIFIED = 0,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_DYNAMIC_FIELD_PHASOR_A_PER_M = 1,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_TANGENT_RHS = 2,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_CARTESIAN_TORQUE_PHASOR = 3,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_STT_CURRENT_PHASOR = 4,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_COUPLED_EXTERNAL_PROVIDER = 5,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_frequency_domain_availability_request {
    pub study_kind: fullmag_fem_frequency_domain_study_kind,
    pub requires_driven_solver: i32,
    pub requires_modal_solver: i32,
    pub requires_static_periodic_boundary: i32,
    pub requires_floquet_boundary: i32,
    pub requires_nonzero_k_dynamic_demag: i32,
    pub requires_gpu: i32,
    pub strict_device: i32,
    pub has_floquet_k_vector: i32,
    pub floquet_k_vector_rad_per_m: [f64; 3],
    pub phase_convention: fullmag_fem_frequency_domain_phase_convention,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_frequency_domain_availability_info {
    pub status: fullmag_fem_frequency_domain_status,
    pub driven_response_available: i32,
    pub modal_solver_available: i32,
    pub static_periodic_response_available: i32,
    pub floquet_modal_available: i32,
    pub floquet_response_available: i32,
    pub dynamic_demag_k_available: i32,
    pub gpu_available: i32,
    pub status_name: [c_char; 64],
    pub study_kind_name: [c_char; 64],
    pub reason: [c_char; 256],
    pub diagnostics_json: [c_char; 512],
}

#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct fullmag_fem_frequency_domain_dependency_info {
    pub petsc_available: i32,
    pub slepc_available: i32,
    pub modal_eigen_native_cpu_slepc_available: i32,
    pub petsc_version: [c_char; 64],
    pub slepc_version: [c_char; 64],
    pub petsc_pkgconfig_dir: [c_char; 256],
    pub slepc_pkgconfig_dir: [c_char; 256],
    pub petsc_find_module_file: [c_char; 256],
    pub slepc_find_module_file: [c_char; 256],
    pub petsc_library_path: [c_char; 256],
    pub slepc_library_path: [c_char; 256],
    pub reason: [c_char; 256],
    pub diagnostics_json: [c_char; 1024],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_frequency_domain_sweep_progress {
    pub total_frequency_points: u64,
    pub completed_frequency_points: u64,
    pub written_frequency_point_artifacts: u64,
    pub current_frequency_hz: f64,
    pub partial_artifacts_available: i32,
    pub latest_artifact_manifest_path: [c_char; 256],
    pub progress_json: [c_char; 512],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_frequency_domain_progress {
    pub frequency_index: u64,
    pub completed_frequency_count: u64,
    pub total_frequency_count: u64,
    pub iteration_count: u64,
    pub frequency_hz: f64,
    pub residual_l2_norm: f64,
    pub relative_residual_l2_norm: f64,
    pub converged: i32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_frequency_domain_exchange_edge {
    pub node_i: u64,
    pub node_j: u64,
    pub stiffness: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_frequency_domain_periodic_node_pair {
    pub node_a: u64,
    pub node_b: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_frequency_domain_floquet_periodic_pair {
    pub pair_id: *const c_char,
    pub node_a: u64,
    pub node_b: u64,
    pub has_translation: i32,
    pub translation_m: [f64; 3],
    pub has_phase: i32,
    pub phase_rad: f64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_frequency_domain_dmi_kind {
    FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_INTERFACIAL = 0,
    FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_BULK = 1,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_frequency_domain_dmi_element {
    pub kind: fullmag_fem_frequency_domain_dmi_kind,
    pub node_indices: [u32; 4],
    pub shape: [f64; 4],
    pub grad_shape: [f64; 12],
    pub weight: f64,
    pub d: f64,
    pub normal: [f64; 3],
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_frequency_domain_driven_response_request {
    pub node_count: u64,
    pub tangent_dof_count: u64,
    pub alpha: f64,
    pub gamma0: f64,
    pub requested_execution_lane: fullmag_fem_frequency_domain_execution_lane,
    pub frequencies_hz: *const f64,
    pub frequency_count: u64,
    pub output_directory: *const c_char,
    pub write_response_fields: i32,
    pub write_partial_artifacts: i32,
    pub operator_diagnostics_json: *const c_char,
    pub cancel_requested: Option<unsafe extern "C" fn(user_data: *mut c_void) -> i32>,
    pub cancel_user_data: *mut c_void,
    pub progress_callback: Option<
        unsafe extern "C" fn(
            user_data: *mut c_void,
            progress: *const fullmag_fem_frequency_domain_progress,
        ),
    >,
    pub progress_user_data: *mut c_void,
    pub tiny_validation_enabled: i32,
    pub tiny_validation_tangent_dof_count: u64,
    pub tiny_validation_stiffness_matrix_row_major: *const f64,
    pub tiny_validation_mass_matrix_row_major: *const f64,
    pub tiny_validation_stiffness_diagonal: *const f64,
    pub tiny_validation_mass_diagonal: *const f64,
    pub tiny_validation_drive_real: *const f64,
    pub mfem_operator_enabled: i32,
    pub mfem_include_zeeman: i32,
    pub mfem_equilibrium_m: *const f64,
    pub mfem_h_ext_a_per_m: *const f64,
    pub mfem_uniaxial_anisotropy_axis: *const f64,
    pub mfem_uniaxial_anisotropy_field_a_per_m: f64,
    pub mfem_alpha_per_node: *const f64,
    pub mfem_drive_real: *const f64,
    pub mfem_exchange_edges: *const fullmag_fem_frequency_domain_exchange_edge,
    pub mfem_exchange_edge_count: u64,
    pub mfem_dmi_elements: *const fullmag_fem_frequency_domain_dmi_element,
    pub mfem_dmi_element_count: u64,
    pub mfem_dmi_lumped_mass: *const f64,
    pub mfem_dmi_ms_field: *const f64,
    pub mfem_dmi_uniform_ms: f64,
    pub tiny_validation_drive_imag: *const f64,
    pub mfem_drive_imag: *const f64,
    pub mfem_static_periodic_node_pairs: *const fullmag_fem_frequency_domain_periodic_node_pair,
    pub mfem_static_periodic_node_pair_count: u64,
    pub has_floquet_k_vector: i32,
    pub floquet_k_vector_rad_per_m: [f64; 3],
    pub phase_convention: fullmag_fem_frequency_domain_phase_convention,
    pub drive_kind: fullmag_fem_frequency_domain_drive_kind,
    pub require_nonzero_rhs: i32,
    pub mfem_floquet_periodic_pairs: *const fullmag_fem_frequency_domain_floquet_periodic_pair,
    pub mfem_floquet_periodic_pair_count: u64,
    pub requires_periodic_airbox_dynamic_demag: i32,
    pub requires_floquet_airbox_dynamic_demag: i32,
    pub magnetic_periodic_constraint_set_count: u64,
    pub magnetostatic_periodic_constraint_set_count: u64,
    pub periodic_airbox_delta_m_tangent_dof_count: u64,
    pub periodic_airbox_delta_phi_dof_count: u64,
    pub periodic_airbox_magnetostatic_periodic_node_pairs:
        *const fullmag_fem_frequency_domain_periodic_node_pair,
    pub periodic_airbox_magnetostatic_periodic_node_pair_count: u64,
    pub periodic_airbox_coupled_block_enabled: i32,
    pub periodic_airbox_coupled_block_delta_m_tangent_dof_count: u64,
    pub periodic_airbox_coupled_block_delta_phi_dof_count: u64,
    pub periodic_airbox_coupled_block_stiffness_matrix_row_major: *const f64,
    pub periodic_airbox_coupled_block_mass_matrix_row_major: *const f64,
    pub periodic_airbox_coupled_block_apply_stiffness: fullmag_fem_frequency_domain_apply_callback,
    pub periodic_airbox_coupled_block_apply_mass: fullmag_fem_frequency_domain_apply_callback,
    pub periodic_airbox_coupled_block_apply_complex_stiffness:
        fullmag_fem_frequency_domain_complex_apply_callback,
    pub periodic_airbox_coupled_block_apply_complex_mass:
        fullmag_fem_frequency_domain_complex_apply_callback,
    pub periodic_airbox_coupled_block_operator_user_data: *mut c_void,
    pub periodic_airbox_coupled_block_drive_real: *const f64,
    pub periodic_airbox_coupled_block_drive_imag: *const f64,
    pub mfem_apply_demag_tangent: fullmag_fem_frequency_domain_apply_callback,
    pub mfem_demag_tangent_user_data: *mut c_void,
    pub mfem_demag_tangent_matrix_row_major: *const f64,
    pub mfem_observable_ms_field: *const f64,
    pub mfem_observable_ms_field_len: u64,
    pub mfem_observable_uniform_ms: f64,
    pub abi_version: u32,
    pub reserved_contract_flags: u32,
    pub struct_size: u64,
    pub solver_relative_tolerance: f64,
    pub solver_absolute_tolerance: f64,
    pub solver_max_iterations: u64,
    pub solver_restart_iterations: u64,
    pub solver_progress_interval_iterations: u64,
    pub tiny_validation_stiffness_matrix_value_count: u64,
    pub tiny_validation_mass_matrix_value_count: u64,
    pub tiny_validation_stiffness_diagonal_value_count: u64,
    pub tiny_validation_mass_diagonal_value_count: u64,
    pub tiny_validation_drive_real_value_count: u64,
    pub tiny_validation_drive_imag_value_count: u64,
    pub mfem_equilibrium_m_value_count: u64,
    pub mfem_h_ext_value_count: u64,
    pub mfem_uniaxial_anisotropy_axis_value_count: u64,
    pub mfem_alpha_value_count: u64,
    pub mfem_drive_real_value_count: u64,
    pub mfem_drive_imag_value_count: u64,
    pub mfem_dmi_lumped_mass_value_count: u64,
    pub mfem_dmi_ms_field_value_count: u64,
    pub mfem_demag_tangent_matrix_value_count: u64,
    pub periodic_airbox_coupled_block_stiffness_matrix_value_count: u64,
    pub periodic_airbox_coupled_block_mass_matrix_value_count: u64,
    pub periodic_airbox_coupled_block_drive_real_value_count: u64,
    pub periodic_airbox_coupled_block_drive_imag_value_count: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_frequency_domain_solve_result {
    pub status: fullmag_fem_frequency_domain_status,
    pub total_frequency_count: u64,
    pub completed_frequency_count: u64,
    pub written_frequency_point_artifacts: u64,
    pub error_message: *mut c_char,
    pub diagnostics_json: *mut c_char,
    pub result_json: *mut c_char,
    pub artifact_manifest_path: *mut c_char,
}

pub const FULLMAG_FEM_FREQUENCY_DOMAIN_ABI_VERSION: u32 = 12;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FullmagFemFrequencyDomainStatus {
    FULLMAG_FEM_FD_OK = 0,
    FULLMAG_FEM_FD_UNAVAILABLE = 1,
    FULLMAG_FEM_FD_VALIDATION_ERROR = 2,
    FULLMAG_FEM_FD_OPERATOR_ERROR = 3,
    FULLMAG_FEM_FD_SOLVE_ERROR = 4,
    FULLMAG_FEM_FD_ARTIFACT_ERROR = 5,
    FULLMAG_FEM_FD_INTERRUPTED = 6,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
#[allow(non_snake_case)]
pub struct FullmagFemLinearizedOperatorRequest {
    pub abi_version: u32,
    pub mesh_asset_id: *const c_char,
    pub equilibrium_source_kind: *const c_char,
    pub gamma_rad_s_T: f64,
    pub mu0_T_m_A: f64,
    pub alpha: f64,
    pub include_exchange: i32,
    pub include_demag: i32,
    pub demag_realization: *const c_char,
    pub damping_policy: *const c_char,
    pub spin_wave_bc_kind: *const c_char,
    pub k_vector_rad_m: *const f64,
    pub k_vector_len: i32,
    pub operator_diagnostics_json: *const c_char,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct FullmagFemCsrMatrixView {
    pub row_count: u64,
    pub column_count: u64,
    pub row_offsets: *const u32,
    pub row_offsets_len: u64,
    pub column_indices: *const u32,
    pub column_indices_len: u64,
    pub values: *const f64,
    pub values_len: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct FullmagFemModalEigenRequest {
    pub abi_version: u32,
    pub operator_request: FullmagFemLinearizedOperatorRequest,
    pub requested_mode_count: i32,
    pub target_kind: *const c_char,
    pub target_frequency_hz: f64,
    pub frequency_min_hz: f64,
    pub frequency_max_hz: f64,
    pub residual_tolerance: f64,
    pub max_outer_iterations: i32,
    pub max_linear_iterations: i32,
    pub output_directory: *const c_char,
    pub write_partial_artifacts: i32,
    pub completeness_policy: i32,
    pub eigensolver_family: i32,
    pub spectral_transform_kind: i32,
    pub cancel_user_data: *mut c_void,
    pub cancel_requested: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    pub progress_user_data: *mut c_void,
    pub progress_callback: Option<unsafe extern "C" fn(*mut c_void, *const c_char)>,
    pub tiny_validation_enabled: i32,
    pub tiny_validation_tangent_dof_count: u64,
    pub tiny_validation_stiffness_matrix_row_major: *const f64,
    pub tiny_validation_mass_matrix_row_major: *const f64,
    pub tiny_validation_stiffness_diagonal: *const f64,
    pub tiny_validation_mass_diagonal: *const f64,
    pub mfem_operator_enabled: i32,
    pub mfem_tangent_dof_count: u64,
    pub mfem_stiffness_matrix_row_major: *const f64,
    pub mfem_gyrotropic_matrix_row_major: *const f64,
    pub mfem_mass_matrix_row_major: *const f64,
    pub mfem_linearized_pencil_dependency_digest: *const c_char,
    pub mfem_linearized_pencil_gamma0_m_per_a_s: f64,
    pub mfem_sparse_operator_enabled: i32,
    pub mfem_sparse_stiffness_csr: FullmagFemCsrMatrixView,
    pub mfem_sparse_gyrotropic_csr: FullmagFemCsrMatrixView,
    pub mfem_sparse_mass_csr: FullmagFemCsrMatrixView,
    pub has_floquet_k_vector: i32,
    pub floquet_k_vector_rad_per_m: [f64; 3],
    pub phase_convention: fullmag_fem_frequency_domain_phase_convention,
    pub mfem_floquet_periodic_pairs: *const fullmag_fem_frequency_domain_floquet_periodic_pair,
    pub mfem_floquet_periodic_pair_count: u64,
    pub poisson_airbox_block_enabled: i32,
    pub poisson_airbox_q_dof_count: u64,
    pub poisson_airbox_phi_dof_count: u64,
    pub poisson_airbox_a_qq_csr: FullmagFemCsrMatrixView,
    pub poisson_airbox_a_qphi_csr: FullmagFemCsrMatrixView,
    pub poisson_airbox_a_phiq_csr: FullmagFemCsrMatrixView,
    pub poisson_airbox_a_phiphi_csr: FullmagFemCsrMatrixView,
    pub poisson_airbox_b_qq_csr: FullmagFemCsrMatrixView,
    pub poisson_airbox_phi_mean_weights: *const f64,
    pub poisson_airbox_phi_mean_weights_count: u64,
    pub poisson_airbox_target_frequency_hz: f64,
    pub poisson_airbox_expected_reference_frequency_hz: f64,
    pub poisson_airbox_periodic_mesh_certificate_schema: *const c_char,
    pub poisson_airbox_magnetic_pair_count: u64,
    pub poisson_airbox_airbox_pair_count: u64,
    pub poisson_airbox_shift_invert_action_enabled: i32,
    pub poisson_airbox_shift_invert_action_device: i32,
    pub poisson_airbox_shift_sigma_real: f64,
    pub poisson_airbox_shift_sigma_imag: f64,
    pub poisson_airbox_shift_action_vector_real: *const f64,
    pub poisson_airbox_shift_action_vector_imag: *const f64,
    pub poisson_airbox_shift_action_vector_count: u64,
    pub poisson_airbox_outer_boundary_kind: *const c_char,
    pub poisson_airbox_robin_beta: f64,
    pub poisson_airbox_gauge_policy: *const c_char,
    pub poisson_airbox_gauge_reason: *const c_char,
    pub poisson_airbox_assembly_kind: *const c_char,
    pub dynamic_demag_k_tangent_matrix_row_major: *const f64,
    pub dynamic_demag_k_tangent_matrix_value_count: u64,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
#[allow(non_snake_case)]
pub struct FullmagFemDrivenResponseRequest {
    pub abi_version: u32,
    pub operator_request: FullmagFemLinearizedOperatorRequest,
    pub frequencies_hz: *const f64,
    pub frequency_count: i32,
    pub excitation_field_A_m: *const f64,
    pub excitation_field_len: i32,
    pub excitation_phase_rad: f64,
    pub residual_tolerance: f64,
    pub max_linear_iterations: i32,
    pub output_directory: *const c_char,
    pub write_partial_artifacts: i32,
    pub cancel_user_data: *mut c_void,
    pub cancel_requested: Option<unsafe extern "C" fn(*mut c_void) -> i32>,
    pub progress_user_data: *mut c_void,
    pub progress_callback: Option<unsafe extern "C" fn(*mut c_void, *const c_char)>,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct FullmagFemFrequencyDomainResult {
    pub abi_version: u32,
    pub status: FullmagFemFrequencyDomainStatus,
    pub error_message: *mut c_char,
    pub diagnostics_json: *mut c_char,
    pub result_json: *mut c_char,
    pub artifact_manifest_path: *mut c_char,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct fullmag_fem_frequency_domain_abi_layout {
    pub availability_request_size: u64,
    pub availability_request_phase_convention_offset: u64,
    pub availability_info_size: u64,
    pub availability_info_diagnostics_json_offset: u64,
    pub dependency_info_size: u64,
    pub dependency_info_modal_eigen_native_cpu_slepc_available_offset: u64,
    pub dependency_info_diagnostics_json_offset: u64,
    pub sweep_progress_size: u64,
    pub sweep_progress_progress_json_offset: u64,
    pub progress_size: u64,
    pub progress_converged_offset: u64,
    pub exchange_edge_size: u64,
    pub exchange_edge_stiffness_offset: u64,
    pub periodic_node_pair_size: u64,
    pub periodic_node_pair_node_b_offset: u64,
    pub floquet_periodic_pair_size: u64,
    pub floquet_periodic_pair_phase_rad_offset: u64,
    pub dmi_element_size: u64,
    pub dmi_element_normal_offset: u64,
    pub driven_response_request_size: u64,
    pub driven_response_request_abi_version_offset: u64,
    pub driven_response_request_struct_size_offset: u64,
    pub driven_response_request_requested_execution_lane_offset: u64,
    pub driven_response_request_progress_callback_offset: u64,
    pub driven_response_request_tiny_validation_drive_imag_offset: u64,
    pub driven_response_request_phase_convention_offset: u64,
    pub driven_response_request_drive_kind_offset: u64,
    pub driven_response_request_require_nonzero_rhs_offset: u64,
    pub driven_response_request_mfem_floquet_periodic_pair_count_offset: u64,
    pub driven_response_request_periodic_airbox_magnetostatic_periodic_node_pairs_offset: u64,
    pub driven_response_request_periodic_airbox_coupled_block_enabled_offset: u64,
    pub driven_response_request_periodic_airbox_coupled_block_apply_stiffness_offset: u64,
    pub driven_response_request_periodic_airbox_coupled_block_apply_complex_stiffness_offset: u64,
    pub driven_response_request_periodic_airbox_coupled_block_operator_user_data_offset: u64,
    pub driven_response_request_mfem_apply_demag_tangent_offset: u64,
    pub driven_response_request_mfem_demag_tangent_user_data_offset: u64,
    pub driven_response_request_mfem_demag_tangent_matrix_row_major_offset: u64,
    pub driven_response_request_solver_relative_tolerance_offset: u64,
    pub driven_response_request_solver_absolute_tolerance_offset: u64,
    pub driven_response_request_solver_max_iterations_offset: u64,
    pub driven_response_request_solver_restart_iterations_offset: u64,
    pub driven_response_request_solver_progress_interval_iterations_offset: u64,
    pub driven_response_request_tiny_validation_drive_real_value_count_offset: u64,
    pub driven_response_request_mfem_equilibrium_m_value_count_offset: u64,
    pub driven_response_request_mfem_drive_real_value_count_offset: u64,
    pub driven_response_request_periodic_airbox_coupled_block_drive_real_value_count_offset: u64,
    pub solve_result_size: u64,
    pub solve_result_artifact_manifest_path_offset: u64,
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
    pub hot_loop_control_scalar_d2h_bytes: u64,
    pub hot_loop_control_scalar_host_sync_count: u64,
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
pub enum fullmag_fem_gpu_demag_mode {
    FULLMAG_FEM_GPU_DEMAG_UNSPECIFIED = 0,
    FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON = 1,
    FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON = 2,
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
    pub uses_gpu_poisson: i32,
    pub exchange_operator_mode: [c_char; 64],
    pub demag_operator_mode: [c_char; 64],
    pub hypre_execution_policy: [c_char; 32],
    pub demag_residency: [c_char; 32],
    pub reason: [c_char; 256],
}

#[repr(C)]
pub struct fullmag_fem_backend {
    _private: [u8; 0],
}

#[repr(C)]
pub struct fullmag_fem_field_snapshot {
    _private: [u8; 0],
}

#[repr(C)]
pub struct fullmag_fem_preview_snapshot {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum fullmag_fem_snapshot_scalar_type {
    FULLMAG_FEM_SNAPSHOT_SCALAR_F64 = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct fullmag_fem_snapshot_desc {
    pub node_count: u64,
    pub component_count: u32,
    pub scalar_bytes: u32,
    pub scalar_type: fullmag_fem_snapshot_scalar_type,
}

extern "C" {
    pub static fullmag_fem_mesh_abi_record_v1: fullmag_fem_mesh_abi_record;
    pub fn fullmag_fem_is_available() -> i32;
    pub fn fullmag_fem_get_regional_field_drive_abi_layout(
        out_layout: *mut fullmag_fem_regional_field_drive_abi_layout,
    ) -> i32;
    pub fn fullmag_fem_get_mesh_abi_layout(out_layout: *mut fullmag_fem_mesh_abi_layout) -> i32;
    pub fn fullmag_fem_solve_steady_transport_v1(
        request: *const fullmag_fem_steady_transport_request_v1,
        result: *mut fullmag_fem_steady_transport_result_v1,
    ) -> i32;
    pub fn fullmag_fem_get_availability_info(out_info: *mut fullmag_fem_availability_info) -> i32;
    pub fn fullmag_fem_get_frequency_domain_availability_info(
        request: *const fullmag_fem_frequency_domain_availability_request,
        out_info: *mut fullmag_fem_frequency_domain_availability_info,
    ) -> i32;
    pub fn fullmag_fem_get_frequency_domain_dependency_info(
        out_info: *mut fullmag_fem_frequency_domain_dependency_info,
    ) -> i32;
    pub fn fullmag_fem_get_frequency_domain_abi_layout(
        out_layout: *mut fullmag_fem_frequency_domain_abi_layout,
    ) -> i32;
    pub fn fullmag_fem_frequency_domain_initial_sweep_progress(
        total_frequency_points: u64,
        out_progress: *mut fullmag_fem_frequency_domain_sweep_progress,
    ) -> i32;
    pub fn fullmag_fem_frequency_domain_interrupted_sweep_progress(
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        latest_artifact_manifest_path: *const c_char,
        out_progress: *mut fullmag_fem_frequency_domain_sweep_progress,
    ) -> i32;
    pub fn fullmag_fem_frequency_domain_cancelling_sweep_progress(
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        latest_artifact_manifest_path: *const c_char,
        out_progress: *mut fullmag_fem_frequency_domain_sweep_progress,
    ) -> i32;
    pub fn fullmag_fem_frequency_domain_completed_sweep_progress(
        total_frequency_points: u64,
        completed_frequency_points: u64,
        written_frequency_point_artifacts: u64,
        current_frequency_hz: f64,
        latest_artifact_manifest_path: *const c_char,
        out_progress: *mut fullmag_fem_frequency_domain_sweep_progress,
    ) -> i32;
    pub fn fullmag_fem_frequency_domain_solve_driven_response(
        request: *const fullmag_fem_frequency_domain_driven_response_request,
        out_result: *mut fullmag_fem_frequency_domain_solve_result,
    ) -> i32;
    pub fn fullmag_fem_frequency_domain_solve_driven_response_v9(
        request: *const fullmag_fem_frequency_domain_driven_response_request,
        mfem_apply_demag_tangent_with_potential:
            fullmag_fem_frequency_domain_apply_with_potential_callback,
        out_result: *mut fullmag_fem_frequency_domain_solve_result,
    ) -> i32;
    pub fn fullmag_fem_frequency_domain_solve_driven_response_v10(
        request: *const fullmag_fem_frequency_domain_driven_response_request,
        mfem_apply_demag_tangent_with_potential:
            fullmag_fem_frequency_domain_apply_with_potential_callback,
        out_result: *mut fullmag_fem_frequency_domain_solve_result,
    ) -> i32;
    pub fn fullmag_fem_frequency_domain_solve_result_release(
        result: *mut fullmag_fem_frequency_domain_solve_result,
    );
    pub fn fullmag_fem_modal_eigen_solve(
        request: *const FullmagFemModalEigenRequest,
    ) -> FullmagFemFrequencyDomainResult;
    pub fn fullmag_fem_driven_response_solve(
        request: *const FullmagFemDrivenResponseRequest,
    ) -> FullmagFemFrequencyDomainResult;
    pub fn fullmag_fem_frequency_domain_result_destroy(
        result: *mut FullmagFemFrequencyDomainResult,
    );

    pub fn fullmag_fem_backend_create(
        plan: *const fullmag_fem_plan_desc,
    ) -> *mut fullmag_fem_backend;
    pub fn fullmag_fem_backend_create_v2(
        plan: *const fullmag_fem_plan_desc,
        adaptive_config: *const fullmag_fem_adaptive_config_v2,
    ) -> *mut fullmag_fem_backend;
    pub fn fullmag_fem_backend_begin_stage(
        handle: *mut fullmag_fem_backend,
        stage_start_time_s: f64,
    ) -> i32;
    pub fn fullmag_fem_backend_reconfigure_regional_field_drives(
        handle: *mut fullmag_fem_backend,
        drives: *const fullmag_fem_regional_field_drive_desc,
        drive_count: u64,
        stage_start_time_s: f64,
    ) -> i32;
    pub fn fullmag_fem_backend_invalidate_fsal(handle: *mut fullmag_fem_backend) -> i32;

    pub fn fullmag_fem_backend_step(
        handle: *mut fullmag_fem_backend,
        dt_seconds: f64,
        out_stats: *mut fullmag_fem_step_stats,
    ) -> i32;

    pub fn fullmag_fem_backend_relax_step(
        handle: *mut fullmag_fem_backend,
        algorithm: fullmag_fem_relax_algorithm,
        out_stats: *mut fullmag_fem_step_stats,
    ) -> i32;

    pub fn fullmag_fem_backend_set_interrupt_poll(
        handle: *mut fullmag_fem_backend,
        poll_fn: fullmag_fem_interrupt_poll_fn,
        user_data: *mut c_void,
    ) -> i32;

    pub fn fullmag_fem_backend_set_step_profile(
        handle: *mut fullmag_fem_backend,
        enabled: i32,
    ) -> i32;

    pub fn fullmag_fem_backend_copy_field_f64(
        handle: *mut fullmag_fem_backend,
        observable: fullmag_fem_observable,
        out_xyz: *mut f64,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fem_backend_average_m_for_nodes_f64(
        handle: *mut fullmag_fem_backend,
        node_indices: *const u32,
        node_count: u64,
        out_xyz: *mut f64,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fem_backend_begin_field_snapshot(
        handle: *mut fullmag_fem_backend,
        observable: fullmag_fem_observable,
    ) -> *mut fullmag_fem_field_snapshot;

    pub fn fullmag_fem_backend_begin_preview_snapshot(
        handle: *mut fullmag_fem_backend,
        observable: fullmag_fem_observable,
    ) -> *mut fullmag_fem_preview_snapshot;

    pub fn fullmag_fem_field_snapshot_wait(
        snapshot: *mut fullmag_fem_field_snapshot,
        out_data: *mut *const c_void,
        out_len_bytes: *mut u64,
        out_desc: *mut fullmag_fem_snapshot_desc,
    ) -> i32;

    pub fn fullmag_fem_preview_snapshot_wait(
        snapshot: *mut fullmag_fem_preview_snapshot,
        out_data: *mut *const c_void,
        out_len_bytes: *mut u64,
        out_desc: *mut fullmag_fem_snapshot_desc,
    ) -> i32;

    pub fn fullmag_fem_preview_snapshot_ready(snapshot: *mut fullmag_fem_preview_snapshot) -> i32;

    pub fn fullmag_fem_field_snapshot_ready(snapshot: *mut fullmag_fem_field_snapshot) -> i32;

    pub fn fullmag_fem_field_snapshot_destroy(snapshot: *mut fullmag_fem_field_snapshot);

    pub fn fullmag_fem_preview_snapshot_destroy(snapshot: *mut fullmag_fem_preview_snapshot);

    pub fn fullmag_fem_backend_upload_magnetization_f64(
        handle: *mut fullmag_fem_backend,
        m_xyz: *const f64,
        len: u64,
    ) -> i32;

    pub fn fullmag_fem_backend_apply_demag_tangent_f64(
        handle: *mut fullmag_fem_backend,
        delta_m_xyz: *const f64,
        delta_m_len: u64,
        out_delta_h_demag_xyz: *mut f64,
        out_len: u64,
    ) -> i32;

    pub fn fullmag_fem_backend_apply_demag_tangent_with_potential_f64(
        handle: *mut fullmag_fem_backend,
        delta_m_xyz: *const f64,
        delta_m_len: u64,
        out_delta_h_demag_xyz: *mut f64,
        out_len: u64,
        out_delta_phi: *mut f64,
        out_phi_len: u64,
    ) -> i32;

    pub fn fullmag_fem_backend_snapshot_stats(
        handle: *mut fullmag_fem_backend,
        out_stats: *mut fullmag_fem_step_stats,
    ) -> i32;

    pub fn fullmag_fem_backend_solver_attempt_count_v1(
        handle: *mut fullmag_fem_backend,
        out_count: *mut u64,
    ) -> i32;

    pub fn fullmag_fem_backend_copy_solver_attempts_v1(
        handle: *mut fullmag_fem_backend,
        out_records: *mut fullmag_fem_solver_attempt_record_v1,
        capacity: u64,
        out_count: *mut u64,
    ) -> i32;

    pub fn fullmag_fem_backend_take_accepted_energy_proof_v1(
        handle: *mut fullmag_fem_backend,
        out_proof: *mut fullmag_fem_accepted_energy_proof_v1,
    ) -> i32;

    pub fn fullmag_fem_backend_stage_completion(
        handle: *mut fullmag_fem_backend,
        out_completion: *mut fullmag_fem_stage_completion,
    ) -> i32;

    pub fn fullmag_fem_backend_get_device_info(
        handle: *mut fullmag_fem_backend,
        out_info: *mut fullmag_fem_device_info,
    ) -> i32;

    pub fn fullmag_fem_get_runtime_build_info(out_info: *mut fullmag_fem_runtime_build_info)
        -> i32;
    pub fn fullmag_fem_get_runtime_build_info_v2(
        out_info: *mut fullmag_fem_runtime_build_info_v2,
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

    #[test]
    fn typed_mesh_v2_abi_layout_and_wire_codes_are_frozen() {
        assert_eq!(FULLMAG_FEM_MESH_DESC_ABI_VERSION, 2);
        assert_eq!(FULLMAG_FEM_CELL_TET4, 1);
        assert_eq!(FULLMAG_FEM_CELL_PRISM6, 2);
        assert_eq!(FULLMAG_FEM_CELL_PYRAMID5, 3);
        assert_eq!(FULLMAG_FEM_CELL_HEX8, 4);
        assert_eq!(FULLMAG_FEM_FACET_TRI3, 1);
        assert_eq!(FULLMAG_FEM_FACET_QUAD4, 2);
        assert_eq!(FULLMAG_FEM_FACET_ROLE_EXTERIOR, 1);
        assert_eq!(FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE, 2);
        assert_eq!(FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM, 3);

        assert_eq!(std::mem::size_of::<fullmag_fem_mesh_desc>(), 232);
        assert_eq!(std::mem::align_of::<fullmag_fem_mesh_desc>(), 8);
        assert_eq!(std::mem::offset_of!(fullmag_fem_mesh_desc, abi_version), 0);
        assert_eq!(std::mem::offset_of!(fullmag_fem_mesh_desc, struct_size), 4);
        assert_eq!(std::mem::offset_of!(fullmag_fem_mesh_desc, nodes_xyz), 8);
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, nodes_xyz_len),
            16
        );
        assert_eq!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_types), 24);
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, cell_types_len),
            32
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, cell_offsets),
            40
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, cell_offsets_len),
            48
        );
        assert_eq!(std::mem::offset_of!(fullmag_fem_mesh_desc, cell_nodes), 56);
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, cell_nodes_len),
            64
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, cell_global_ordinals),
            72
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, cell_global_ordinals_len),
            80
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, cell_markers),
            88
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, cell_markers_len),
            96
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_types),
            104
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_types_len),
            112
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_roles),
            120
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_roles_len),
            128
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_offsets),
            136
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_offsets_len),
            144
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_nodes),
            152
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_nodes_len),
            160
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_global_ordinals),
            168
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_global_ordinals_len),
            176
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_markers),
            184
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, facet_markers_len),
            192
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, periodic_node_pairs),
            200
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, periodic_node_pairs_len),
            208
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, periodic_boundary_pair_markers),
            216
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_mesh_desc, periodic_boundary_pair_markers_len),
            224
        );
    }

    #[test]
    fn adaptive_v2_keeps_legacy_layout_as_a_versioned_base() {
        assert_eq!(
            std::mem::size_of::<fullmag_fem_adaptive_config>(),
            8 * std::mem::size_of::<f64>() + 2 * std::mem::size_of::<u32>()
        );
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_adaptive_config_v2, base),
            2 * std::mem::size_of::<u32>()
        );
        assert_eq!(FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION, 2);
    }

    /// Verify the Rust observable enum has the expected number of variants
    /// matching the C header (M=1 .. DEMAG_PHI=14 -> 14 variants).
    #[test]
    fn observable_enum_has_15_variants() {
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
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_TORQUE,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_DEMAG_PHI,
            fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DRIVE,
        ];
        assert_eq!(variants.len(), 15);
        // Verify sequential discriminants 1..=15
        for (i, v) in variants.iter().enumerate() {
            assert_eq!(
                *v as i32,
                (i + 1) as i32,
                "variant {i} discriminant mismatch"
            );
        }
    }

    #[test]
    fn regional_field_drive_ffi_layout_matches_native_runtime() {
        let mut layout =
            std::mem::MaybeUninit::<fullmag_fem_regional_field_drive_abi_layout>::zeroed();
        let rc = unsafe { fullmag_fem_get_regional_field_drive_abi_layout(layout.as_mut_ptr()) };
        assert_eq!(rc, FULLMAG_FEM_OK);
        let layout = unsafe { layout.assume_init() };
        assert_eq!(
            layout.abi_version,
            FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION
        );
        assert_eq!(layout.struct_size as usize, std::mem::size_of_val(&layout));
        assert_eq!(
            layout.time_dependence_desc_size as usize,
            std::mem::size_of::<fullmag_fem_time_dependence_desc>()
        );
        assert_eq!(
            layout.field_target_desc_size as usize,
            std::mem::size_of::<fullmag_fem_field_target_desc>()
        );
        assert_eq!(
            layout.spatial_profile_desc_size as usize,
            std::mem::size_of::<fullmag_fem_spatial_profile_desc>()
        );
        assert_eq!(
            layout.regional_field_drive_desc_size as usize,
            std::mem::size_of::<fullmag_fem_regional_field_drive_desc>()
        );
        assert_eq!(
            layout.plan_desc_size as usize,
            std::mem::size_of::<fullmag_fem_plan_desc>()
        );
        assert_eq!(
            layout.step_stats_size as usize,
            std::mem::size_of::<fullmag_fem_step_stats>()
        );
        assert_eq!(
            layout.plan_regional_field_drives_offset as usize,
            std::mem::offset_of!(fullmag_fem_plan_desc, regional_field_drives)
        );
        assert_eq!(
            layout.plan_regional_field_drive_count_offset as usize,
            std::mem::offset_of!(fullmag_fem_plan_desc, regional_field_drive_count)
        );
        assert_eq!(
            layout.plan_stage_start_time_s_offset as usize,
            std::mem::offset_of!(fullmag_fem_plan_desc, stage_start_time_s)
        );
        assert_eq!(
            layout.step_stats_drive_energy_joules_offset as usize,
            std::mem::offset_of!(fullmag_fem_step_stats, drive_energy_joules)
        );
        assert_eq!(
            layout.step_stats_rk_transaction_capture_host_wall_time_ns_offset as usize,
            std::mem::offset_of!(
                fullmag_fem_step_stats,
                rk_transaction_capture_host_wall_time_ns
            )
        );
        assert_eq!(
            layout.step_stats_demag_hypre_timed_solve_count_offset as usize,
            std::mem::offset_of!(fullmag_fem_step_stats, demag_hypre_timed_solve_count)
        );
    }

    /// Verify plan desc contains the use_consistent_mass field (FND-013).
    #[test]
    fn plan_desc_has_consistent_mass_field() {
        let plan = std::mem::MaybeUninit::<fullmag_fem_plan_desc>::zeroed();
        let plan = unsafe { plan.assume_init() };
        assert_eq!(plan.use_consistent_mass, 0);
        assert_eq!(plan.eager_initial_effective_field, 0);
        assert_eq!(plan.has_precession_enabled, 0);
        assert_eq!(plan.precession_enabled, 0);
    }

    #[test]
    fn versioned_stt_extension_is_append_only_after_legacy_plan_prefix() {
        let legacy_tail = std::mem::offset_of!(fullmag_fem_plan_desc, precession_enabled);
        assert!(
            std::mem::offset_of!(fullmag_fem_plan_desc, stt_formula_version) > legacy_tail,
            "versioned STT fields must not shift the established time-domain plan ABI prefix"
        );
        assert!(
            std::mem::offset_of!(fullmag_fem_plan_desc, stt_active_element_mask_len)
                > std::mem::offset_of!(fullmag_fem_plan_desc, stt_formula_version)
        );
    }

    #[test]
    fn steady_transport_v1_request_and_result_are_self_describing_and_append_only() {
        assert_eq!(FULLMAG_FEM_STEADY_TRANSPORT_ABI_VERSION, 1);
        assert_eq!(
            std::mem::offset_of!(fullmag_fem_steady_transport_request_v1, abi_version),
            0
        );
        assert!(
            std::mem::offset_of!(fullmag_fem_steady_transport_request_v1, struct_size)
                > std::mem::offset_of!(fullmag_fem_steady_transport_request_v1, abi_version)
        );
        assert!(
            std::mem::offset_of!(
                fullmag_fem_steady_transport_request_v1,
                spin_dirichlet_values_v
            ) > std::mem::offset_of!(fullmag_fem_steady_transport_request_v1, mesh)
        );
        assert!(
            std::mem::offset_of!(fullmag_fem_steady_transport_result_v1, torque_xyz_len)
                > std::mem::offset_of!(
                    fullmag_fem_steady_transport_result_v1,
                    electric_potential_v
                )
        );
    }

    /// Verify plan desc carries optional discontinuous per-element A/Ms coefficients.
    #[test]
    fn plan_desc_has_element_material_coefficient_fields() {
        let plan = std::mem::MaybeUninit::<fullmag_fem_plan_desc>::zeroed();
        let plan = unsafe { plan.assume_init() };
        assert!(plan.ms_element_field.is_null());
        assert_eq!(plan.ms_element_field_len, 0);
        assert!(plan.a_element_field.is_null());
        assert_eq!(plan.a_element_field_len, 0);
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
        assert_eq!(mesh.periodic_node_pairs_len, 0);
    }

    /// Verify mesh desc carries periodic boundary pair marker fields for native demag PBC.
    #[test]
    fn mesh_desc_has_periodic_boundary_pair_marker_fields() {
        let mesh = std::mem::MaybeUninit::<fullmag_fem_mesh_desc>::zeroed();
        let mesh = unsafe { mesh.assume_init() };
        assert!(mesh.periodic_boundary_pair_markers.is_null());
        assert_eq!(mesh.periodic_boundary_pair_markers_len, 0);
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
        assert_eq!(audit.hot_loop_control_scalar_d2h_bytes, 0);
        assert_eq!(audit.hot_loop_control_scalar_host_sync_count, 0);
    }

    /// Verify availability ABI separates build-time and hot-path GPU capabilities.
    #[test]
    fn availability_abi_has_split_fem_gpu_capability_fields() {
        let info = std::mem::MaybeUninit::<fullmag_fem_availability_info>::zeroed();
        let info = unsafe { info.assume_init() };
        assert_eq!(info.native_fem_cpu_available, 0);
        assert_eq!(info.native_fem_gpu_available, 0);
        assert_eq!(info.native_fem_gpu_full_demag_available, 0);
        assert_eq!(info.mfem_cuda_available, 0);
        assert_eq!(info.hypre_gpu_available, 0);
        assert_eq!(info.libceed_used_hot_path, 0);
        assert_eq!(info.gpu_memory_free_bytes, 0);
        assert_eq!(info.gpu_memory_total_bytes, 0);
    }

    #[test]
    fn frequency_domain_availability_abi_has_status_and_capability_fields() {
        let request = fullmag_fem_frequency_domain_availability_request {
            study_kind:
                fullmag_fem_frequency_domain_study_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE,
            requires_driven_solver: 0,
            requires_modal_solver: 0,
            requires_static_periodic_boundary: 0,
            requires_floquet_boundary: 0,
            requires_nonzero_k_dynamic_demag: 0,
            requires_gpu: 0,
            strict_device: 0,
            has_floquet_k_vector: 0,
            floquet_k_vector_rad_per_m: [0.0; 3],
            phase_convention:
                fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T,
        };
        assert_eq!(
            request.study_kind,
            fullmag_fem_frequency_domain_study_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_STUDY_RESPONSE
        );
        assert_eq!(request.requires_driven_solver, 0);
        assert_eq!(request.requires_modal_solver, 0);
        assert_eq!(request.requires_static_periodic_boundary, 0);
        assert_eq!(request.requires_floquet_boundary, 0);
        assert_eq!(request.requires_nonzero_k_dynamic_demag, 0);
        assert_eq!(request.requires_gpu, 0);
        assert_eq!(request.strict_device, 0);
        assert_eq!(request.has_floquet_k_vector, 0);
        assert_eq!(request.floquet_k_vector_rad_per_m, [0.0; 3]);
        assert_eq!(
            request.phase_convention,
            fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T
        );

        let info =
            std::mem::MaybeUninit::<fullmag_fem_frequency_domain_availability_info>::zeroed();
        let info = unsafe { info.assume_init() };
        assert_eq!(
            info.status,
            fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK
        );
        assert_eq!(info.driven_response_available, 0);
        assert_eq!(info.modal_solver_available, 0);
        assert_eq!(info.static_periodic_response_available, 0);
        assert_eq!(info.floquet_modal_available, 0);
        assert_eq!(info.floquet_response_available, 0);
        assert_eq!(info.dynamic_demag_k_available, 0);
        assert_eq!(info.gpu_available, 0);
        assert_eq!(info.status_name[0], 0);
        assert_eq!(info.study_kind_name[0], 0);
        assert_eq!(info.reason[0], 0);
        assert_eq!(info.diagnostics_json[0], 0);
    }

    #[test]
    fn frequency_domain_status_abi_discriminants_are_stable() {
        assert_eq!(
            fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK as i32,
            0
        );
        assert_eq!(
            fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_UNAVAILABLE
                as i32,
            1
        );
        assert_eq!(
            fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_VALIDATION_ERROR
                as i32,
            2
        );
        assert_eq!(
            fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OPERATOR_ERROR
                as i32,
            3
        );
        assert_eq!(
            fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_SOLVE_ERROR
                as i32,
            4
        );
        assert_eq!(
            fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_ARTIFACT_ERROR
                as i32,
            5
        );
        assert_eq!(
            fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_INTERRUPTED
                as i32,
            6
        );
    }

    #[test]
    fn frequency_domain_phase_convention_abi_discriminants_are_stable() {
        assert_eq!(
            fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T
                as i32,
            0
        );
        assert_eq!(
            fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_MINUS_I_OMEGA_T
                as i32,
            1
        );
    }

    #[test]
    fn frequency_domain_drive_kind_abi_discriminants_are_stable() {
        assert_eq!(
            fullmag_fem_frequency_domain_drive_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_UNSPECIFIED
                as i32,
            0
        );
        assert_eq!(
            fullmag_fem_frequency_domain_drive_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_DYNAMIC_FIELD_PHASOR_A_PER_M
                as i32,
            1
        );
        assert_eq!(
            fullmag_fem_frequency_domain_drive_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_TANGENT_RHS
                as i32,
            2
        );
    }

    #[test]
    fn frequency_domain_runtime_abi_layout_matches_rust_bindings() {
        let mut layout = fullmag_fem_frequency_domain_abi_layout::default();
        let status = unsafe { fullmag_fem_get_frequency_domain_abi_layout(&mut layout) };
        assert_eq!(status, 0);

        type AvailabilityRequest = fullmag_fem_frequency_domain_availability_request;
        type AvailabilityInfo = fullmag_fem_frequency_domain_availability_info;
        type DependencyInfo = fullmag_fem_frequency_domain_dependency_info;
        type SweepProgress = fullmag_fem_frequency_domain_sweep_progress;
        type Progress = fullmag_fem_frequency_domain_progress;
        type ExchangeEdge = fullmag_fem_frequency_domain_exchange_edge;
        type PeriodicNodePair = fullmag_fem_frequency_domain_periodic_node_pair;
        type FloquetPeriodicPair = fullmag_fem_frequency_domain_floquet_periodic_pair;
        type DmiElement = fullmag_fem_frequency_domain_dmi_element;
        type DrivenRequest = fullmag_fem_frequency_domain_driven_response_request;
        type SolveResult = fullmag_fem_frequency_domain_solve_result;

        assert_eq!(
            layout.availability_request_size,
            std::mem::size_of::<AvailabilityRequest>() as u64
        );
        assert_eq!(
            layout.availability_request_phase_convention_offset,
            std::mem::offset_of!(AvailabilityRequest, phase_convention) as u64
        );
        assert_eq!(
            layout.availability_info_size,
            std::mem::size_of::<AvailabilityInfo>() as u64
        );
        assert_eq!(
            layout.availability_info_diagnostics_json_offset,
            std::mem::offset_of!(AvailabilityInfo, diagnostics_json) as u64
        );
        assert_eq!(
            layout.dependency_info_size,
            std::mem::size_of::<DependencyInfo>() as u64
        );
        assert_eq!(
            layout.dependency_info_modal_eigen_native_cpu_slepc_available_offset,
            std::mem::offset_of!(DependencyInfo, modal_eigen_native_cpu_slepc_available) as u64
        );
        assert_eq!(
            layout.dependency_info_diagnostics_json_offset,
            std::mem::offset_of!(DependencyInfo, diagnostics_json) as u64
        );
        assert_eq!(
            layout.sweep_progress_size,
            std::mem::size_of::<SweepProgress>() as u64
        );
        assert_eq!(
            layout.sweep_progress_progress_json_offset,
            std::mem::offset_of!(SweepProgress, progress_json) as u64
        );
        assert_eq!(layout.progress_size, std::mem::size_of::<Progress>() as u64);
        assert_eq!(
            layout.progress_converged_offset,
            std::mem::offset_of!(Progress, converged) as u64
        );
        assert_eq!(
            layout.exchange_edge_size,
            std::mem::size_of::<ExchangeEdge>() as u64
        );
        assert_eq!(
            layout.exchange_edge_stiffness_offset,
            std::mem::offset_of!(ExchangeEdge, stiffness) as u64
        );
        assert_eq!(
            layout.periodic_node_pair_size,
            std::mem::size_of::<PeriodicNodePair>() as u64
        );
        assert_eq!(
            layout.periodic_node_pair_node_b_offset,
            std::mem::offset_of!(PeriodicNodePair, node_b) as u64
        );
        assert_eq!(
            layout.floquet_periodic_pair_size,
            std::mem::size_of::<FloquetPeriodicPair>() as u64
        );
        assert_eq!(
            layout.floquet_periodic_pair_phase_rad_offset,
            std::mem::offset_of!(FloquetPeriodicPair, phase_rad) as u64
        );
        assert_eq!(
            layout.dmi_element_size,
            std::mem::size_of::<DmiElement>() as u64
        );
        assert_eq!(
            layout.dmi_element_normal_offset,
            std::mem::offset_of!(DmiElement, normal) as u64
        );
        assert_eq!(
            layout.driven_response_request_size,
            std::mem::size_of::<DrivenRequest>() as u64
        );
        assert_eq!(
            layout.driven_response_request_requested_execution_lane_offset,
            std::mem::offset_of!(DrivenRequest, requested_execution_lane) as u64
        );
        assert_eq!(
            layout.driven_response_request_progress_callback_offset,
            std::mem::offset_of!(DrivenRequest, progress_callback) as u64
        );
        assert_eq!(
            layout.driven_response_request_tiny_validation_drive_imag_offset,
            std::mem::offset_of!(DrivenRequest, tiny_validation_drive_imag) as u64
        );
        assert_eq!(
            layout.driven_response_request_phase_convention_offset,
            std::mem::offset_of!(DrivenRequest, phase_convention) as u64
        );
        assert_eq!(
            layout.driven_response_request_drive_kind_offset,
            std::mem::offset_of!(DrivenRequest, drive_kind) as u64
        );
        assert_eq!(
            layout.driven_response_request_require_nonzero_rhs_offset,
            std::mem::offset_of!(DrivenRequest, require_nonzero_rhs) as u64
        );
        assert_eq!(
            layout.driven_response_request_mfem_floquet_periodic_pair_count_offset,
            std::mem::offset_of!(DrivenRequest, mfem_floquet_periodic_pair_count) as u64
        );
        assert_eq!(
            layout.driven_response_request_periodic_airbox_magnetostatic_periodic_node_pairs_offset,
            std::mem::offset_of!(
                DrivenRequest,
                periodic_airbox_magnetostatic_periodic_node_pairs
            ) as u64
        );
        assert_eq!(
            layout.driven_response_request_periodic_airbox_coupled_block_enabled_offset,
            std::mem::offset_of!(DrivenRequest, periodic_airbox_coupled_block_enabled) as u64
        );
        assert_eq!(
            layout.driven_response_request_periodic_airbox_coupled_block_apply_stiffness_offset,
            std::mem::offset_of!(DrivenRequest, periodic_airbox_coupled_block_apply_stiffness)
                as u64
        );
        assert_eq!(
            layout
                .driven_response_request_periodic_airbox_coupled_block_apply_complex_stiffness_offset,
            std::mem::offset_of!(
                DrivenRequest,
                periodic_airbox_coupled_block_apply_complex_stiffness
            ) as u64
        );
        assert_eq!(
            layout.driven_response_request_periodic_airbox_coupled_block_operator_user_data_offset,
            std::mem::offset_of!(
                DrivenRequest,
                periodic_airbox_coupled_block_operator_user_data
            ) as u64
        );
        assert_eq!(
            layout.driven_response_request_mfem_apply_demag_tangent_offset,
            std::mem::offset_of!(DrivenRequest, mfem_apply_demag_tangent) as u64
        );
        assert_eq!(
            layout.driven_response_request_mfem_demag_tangent_user_data_offset,
            std::mem::offset_of!(DrivenRequest, mfem_demag_tangent_user_data) as u64
        );
        assert_eq!(
            layout.driven_response_request_mfem_demag_tangent_matrix_row_major_offset,
            std::mem::offset_of!(DrivenRequest, mfem_demag_tangent_matrix_row_major) as u64
        );
        assert_eq!(
            layout.driven_response_request_solver_relative_tolerance_offset,
            std::mem::offset_of!(DrivenRequest, solver_relative_tolerance) as u64
        );
        assert_eq!(
            layout.driven_response_request_solver_absolute_tolerance_offset,
            std::mem::offset_of!(DrivenRequest, solver_absolute_tolerance) as u64
        );
        assert_eq!(
            layout.driven_response_request_solver_max_iterations_offset,
            std::mem::offset_of!(DrivenRequest, solver_max_iterations) as u64
        );
        assert_eq!(
            layout.driven_response_request_solver_restart_iterations_offset,
            std::mem::offset_of!(DrivenRequest, solver_restart_iterations) as u64
        );
        assert_eq!(
            layout.driven_response_request_solver_progress_interval_iterations_offset,
            std::mem::offset_of!(DrivenRequest, solver_progress_interval_iterations) as u64
        );
        assert_eq!(
            layout.driven_response_request_tiny_validation_drive_real_value_count_offset,
            std::mem::offset_of!(DrivenRequest, tiny_validation_drive_real_value_count) as u64
        );
        assert_eq!(
            layout.driven_response_request_mfem_equilibrium_m_value_count_offset,
            std::mem::offset_of!(DrivenRequest, mfem_equilibrium_m_value_count) as u64
        );
        assert_eq!(
            layout.driven_response_request_mfem_drive_real_value_count_offset,
            std::mem::offset_of!(DrivenRequest, mfem_drive_real_value_count) as u64
        );
        assert_eq!(
            layout
                .driven_response_request_periodic_airbox_coupled_block_drive_real_value_count_offset,
            std::mem::offset_of!(
                DrivenRequest,
                periodic_airbox_coupled_block_drive_real_value_count
            ) as u64
        );
        assert_eq!(
            layout.solve_result_size,
            std::mem::size_of::<SolveResult>() as u64
        );
        assert_eq!(
            layout.solve_result_artifact_manifest_path_offset,
            std::mem::offset_of!(SolveResult, artifact_manifest_path) as u64
        );
    }

    #[test]
    fn frequency_domain_sweep_progress_abi_exposes_partial_artifact_state() {
        let progress =
            std::mem::MaybeUninit::<fullmag_fem_frequency_domain_sweep_progress>::zeroed();
        let progress = unsafe { progress.assume_init() };
        assert_eq!(progress.total_frequency_points, 0);
        assert_eq!(progress.completed_frequency_points, 0);
        assert_eq!(progress.written_frequency_point_artifacts, 0);
        assert_eq!(progress.current_frequency_hz, 0.0);
        assert_eq!(progress.partial_artifacts_available, 0);
        assert_eq!(progress.latest_artifact_manifest_path[0], 0);
        assert_eq!(progress.progress_json[0], 0);
    }

    #[test]
    fn frequency_domain_progress_abi_exposes_iteration_state() {
        let progress = std::mem::MaybeUninit::<fullmag_fem_frequency_domain_progress>::zeroed();
        let progress = unsafe { progress.assume_init() };
        assert_eq!(progress.frequency_index, 0);
        assert_eq!(progress.completed_frequency_count, 0);
        assert_eq!(progress.total_frequency_count, 0);
        assert_eq!(progress.iteration_count, 0);
        assert_eq!(progress.frequency_hz, 0.0);
        assert_eq!(progress.residual_l2_norm, 0.0);
        assert_eq!(progress.relative_residual_l2_norm, 0.0);
        assert_eq!(progress.converged, 0);
    }

    #[test]
    fn modal_eigen_request_abi_exposes_mfem_payload_fields() {
        let request = std::mem::MaybeUninit::<FullmagFemModalEigenRequest>::zeroed();
        let request = unsafe { request.assume_init() };
        assert_eq!(request.mfem_operator_enabled, 0);
        assert_eq!(request.mfem_tangent_dof_count, 0);
        assert!(request.mfem_stiffness_matrix_row_major.is_null());
        assert!(request.mfem_gyrotropic_matrix_row_major.is_null());
        assert!(request.mfem_mass_matrix_row_major.is_null());
        assert_eq!(request.mfem_sparse_operator_enabled, 0);
        assert_eq!(request.mfem_sparse_stiffness_csr.row_count, 0);
        assert_eq!(request.mfem_sparse_stiffness_csr.column_count, 0);
        assert!(request.mfem_sparse_stiffness_csr.row_offsets.is_null());
        assert_eq!(request.mfem_sparse_stiffness_csr.row_offsets_len, 0);
        assert!(request.mfem_sparse_stiffness_csr.column_indices.is_null());
        assert_eq!(request.mfem_sparse_stiffness_csr.column_indices_len, 0);
        assert!(request.mfem_sparse_stiffness_csr.values.is_null());
        assert_eq!(request.mfem_sparse_stiffness_csr.values_len, 0);
        assert_eq!(request.mfem_sparse_gyrotropic_csr.row_count, 0);
        assert_eq!(request.mfem_sparse_mass_csr.row_count, 0);
    }

    #[test]
    fn modal_eigen_request_abi_exposes_floquet_tail_layout() {
        type Request = FullmagFemModalEigenRequest;
        let request = std::mem::MaybeUninit::<Request>::zeroed();
        let request = unsafe { request.assume_init() };

        assert_eq!(request.has_floquet_k_vector, 0);
        assert_eq!(request.floquet_k_vector_rad_per_m, [0.0; 3]);
        assert_eq!(
            request.phase_convention,
            fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T
        );
        assert!(request.mfem_floquet_periodic_pairs.is_null());
        assert_eq!(request.mfem_floquet_periodic_pair_count, 0);

        let sparse_mass = std::mem::offset_of!(Request, mfem_sparse_mass_csr);
        let has_floquet_k_vector = std::mem::offset_of!(Request, has_floquet_k_vector);
        let floquet_k_vector = std::mem::offset_of!(Request, floquet_k_vector_rad_per_m);
        let phase_convention = std::mem::offset_of!(Request, phase_convention);
        let floquet_pair_ptr = std::mem::offset_of!(Request, mfem_floquet_periodic_pairs);
        let floquet_pair_count = std::mem::offset_of!(Request, mfem_floquet_periodic_pair_count);

        assert!(sparse_mass < has_floquet_k_vector);
        assert!(has_floquet_k_vector < floquet_k_vector);
        assert!(floquet_k_vector < phase_convention);
        assert!(phase_convention < floquet_pair_ptr);
        assert!(floquet_pair_ptr < floquet_pair_count);
    }

    #[test]
    fn modal_eigen_request_abi_exposes_poisson_airbox_tail_layout() {
        type Request = FullmagFemModalEigenRequest;
        let request = std::mem::MaybeUninit::<Request>::zeroed();
        let request = unsafe { request.assume_init() };

        assert_eq!(request.poisson_airbox_block_enabled, 0);
        assert_eq!(request.poisson_airbox_q_dof_count, 0);
        assert_eq!(request.poisson_airbox_phi_dof_count, 0);
        assert_eq!(request.poisson_airbox_a_qq_csr.row_count, 0);
        assert_eq!(request.poisson_airbox_a_qphi_csr.row_count, 0);
        assert_eq!(request.poisson_airbox_a_phiq_csr.row_count, 0);
        assert_eq!(request.poisson_airbox_a_phiphi_csr.row_count, 0);
        assert_eq!(request.poisson_airbox_b_qq_csr.row_count, 0);
        assert!(request.poisson_airbox_phi_mean_weights.is_null());
        assert_eq!(request.poisson_airbox_phi_mean_weights_count, 0);
        assert_eq!(request.poisson_airbox_target_frequency_hz, 0.0);
        assert_eq!(request.poisson_airbox_expected_reference_frequency_hz, 0.0);
        assert!(request
            .poisson_airbox_periodic_mesh_certificate_schema
            .is_null());
        assert_eq!(request.poisson_airbox_magnetic_pair_count, 0);
        assert_eq!(request.poisson_airbox_airbox_pair_count, 0);
        assert_eq!(request.poisson_airbox_shift_invert_action_enabled, 0);
        assert_eq!(request.poisson_airbox_shift_invert_action_device, 0);
        assert_eq!(request.poisson_airbox_shift_sigma_real, 0.0);
        assert_eq!(request.poisson_airbox_shift_sigma_imag, 0.0);
        assert!(request.poisson_airbox_shift_action_vector_real.is_null());
        assert!(request.poisson_airbox_shift_action_vector_imag.is_null());
        assert_eq!(request.poisson_airbox_shift_action_vector_count, 0);
        assert!(request.poisson_airbox_outer_boundary_kind.is_null());
        assert_eq!(request.poisson_airbox_robin_beta, 0.0);
        assert!(request.poisson_airbox_gauge_policy.is_null());
        assert!(request.poisson_airbox_gauge_reason.is_null());
        assert!(request.poisson_airbox_assembly_kind.is_null());
        assert!(request.mfem_linearized_pencil_dependency_digest.is_null());
        assert_eq!(request.mfem_linearized_pencil_gamma0_m_per_a_s, 0.0);
        assert!(request.dynamic_demag_k_tangent_matrix_row_major.is_null());
        assert_eq!(request.dynamic_demag_k_tangent_matrix_value_count, 0);

        let floquet_pair_count = std::mem::offset_of!(Request, mfem_floquet_periodic_pair_count);
        let magnetic_pencil_dependency =
            std::mem::offset_of!(Request, mfem_linearized_pencil_dependency_digest);
        let magnetic_pencil_gamma0 =
            std::mem::offset_of!(Request, mfem_linearized_pencil_gamma0_m_per_a_s);
        let poisson_enabled = std::mem::offset_of!(Request, poisson_airbox_block_enabled);
        let poisson_a_qq = std::mem::offset_of!(Request, poisson_airbox_a_qq_csr);
        let poisson_reference =
            std::mem::offset_of!(Request, poisson_airbox_expected_reference_frequency_hz);
        let poisson_certificate =
            std::mem::offset_of!(Request, poisson_airbox_periodic_mesh_certificate_schema);
        let poisson_pair_count = std::mem::offset_of!(Request, poisson_airbox_airbox_pair_count);
        let poisson_shift_action =
            std::mem::offset_of!(Request, poisson_airbox_shift_invert_action_enabled);
        let poisson_shift_device =
            std::mem::offset_of!(Request, poisson_airbox_shift_invert_action_device);
        let poisson_shift_vector_count =
            std::mem::offset_of!(Request, poisson_airbox_shift_action_vector_count);
        let poisson_outer_boundary_kind =
            std::mem::offset_of!(Request, poisson_airbox_outer_boundary_kind);
        let poisson_robin_beta = std::mem::offset_of!(Request, poisson_airbox_robin_beta);
        let poisson_gauge_policy = std::mem::offset_of!(Request, poisson_airbox_gauge_policy);
        let poisson_gauge_reason = std::mem::offset_of!(Request, poisson_airbox_gauge_reason);
        let poisson_assembly_kind = std::mem::offset_of!(Request, poisson_airbox_assembly_kind);
        let dynamic_demag_k_matrix =
            std::mem::offset_of!(Request, dynamic_demag_k_tangent_matrix_row_major);
        let dynamic_demag_k_count =
            std::mem::offset_of!(Request, dynamic_demag_k_tangent_matrix_value_count);

        assert!(floquet_pair_count < poisson_enabled);
        assert!(magnetic_pencil_dependency < magnetic_pencil_gamma0);
        assert!(magnetic_pencil_gamma0 < floquet_pair_count);
        assert!(poisson_enabled < poisson_a_qq);
        assert!(poisson_a_qq < poisson_reference);
        assert!(poisson_reference < poisson_certificate);
        assert!(poisson_certificate < poisson_pair_count);
        assert!(poisson_pair_count < poisson_shift_action);
        assert!(poisson_shift_action < poisson_shift_device);
        assert!(poisson_shift_device < poisson_shift_vector_count);
        assert!(poisson_shift_vector_count < poisson_outer_boundary_kind);
        assert!(poisson_outer_boundary_kind < poisson_robin_beta);
        assert!(poisson_robin_beta < poisson_gauge_policy);
        assert!(poisson_gauge_policy < poisson_gauge_reason);
        assert!(poisson_gauge_reason < poisson_assembly_kind);
        assert!(poisson_assembly_kind < dynamic_demag_k_matrix);
        assert!(dynamic_demag_k_matrix < dynamic_demag_k_count);
    }

    #[test]
    fn frequency_domain_driven_response_solve_abi_has_owned_result_boundary() {
        let request =
            std::mem::MaybeUninit::<fullmag_fem_frequency_domain_driven_response_request>::zeroed();
        let request = unsafe { request.assume_init() };
        assert_eq!(request.node_count, 0);
        assert_eq!(request.tangent_dof_count, 0);
        assert_eq!(request.alpha, 0.0);
        assert_eq!(request.gamma0, 0.0);
        assert_eq!(
            request.requested_execution_lane,
            fullmag_fem_frequency_domain_execution_lane::FULLMAG_FEM_FREQUENCY_DOMAIN_EXECUTION_VALIDATION
        );
        assert!(request.frequencies_hz.is_null());
        assert_eq!(request.frequency_count, 0);
        assert!(request.output_directory.is_null());
        assert_eq!(request.write_response_fields, 0);
        assert_eq!(request.write_partial_artifacts, 0);
        assert!(request.operator_diagnostics_json.is_null());
        assert!(request.cancel_requested.is_none());
        assert!(request.cancel_user_data.is_null());
        assert!(request.progress_callback.is_none());
        assert!(request.progress_user_data.is_null());
        assert_eq!(request.tiny_validation_enabled, 0);
        assert_eq!(request.tiny_validation_tangent_dof_count, 0);
        assert!(request.tiny_validation_stiffness_matrix_row_major.is_null());
        assert!(request.tiny_validation_mass_matrix_row_major.is_null());
        assert!(request.tiny_validation_stiffness_diagonal.is_null());
        assert!(request.tiny_validation_mass_diagonal.is_null());
        assert!(request.tiny_validation_drive_real.is_null());
        assert_eq!(request.mfem_operator_enabled, 0);
        assert_eq!(request.mfem_include_zeeman, 0);
        assert!(request.mfem_equilibrium_m.is_null());
        assert!(request.mfem_h_ext_a_per_m.is_null());
        assert!(request.mfem_uniaxial_anisotropy_axis.is_null());
        assert_eq!(request.mfem_uniaxial_anisotropy_field_a_per_m, 0.0);
        assert!(request.mfem_alpha_per_node.is_null());
        assert!(request.mfem_drive_real.is_null());
        assert!(request.mfem_exchange_edges.is_null());
        assert_eq!(request.mfem_exchange_edge_count, 0);
        assert!(request.mfem_dmi_elements.is_null());
        assert_eq!(request.mfem_dmi_element_count, 0);
        assert!(request.mfem_dmi_lumped_mass.is_null());
        assert!(request.mfem_dmi_ms_field.is_null());
        assert!(request.mfem_observable_ms_field.is_null());
        assert_eq!(request.mfem_observable_ms_field_len, 0);
        assert_eq!(request.mfem_observable_uniform_ms, 0.0);
        assert!(request.tiny_validation_drive_imag.is_null());
        assert!(request.mfem_drive_imag.is_null());
        assert!(request.mfem_static_periodic_node_pairs.is_null());
        assert_eq!(request.mfem_static_periodic_node_pair_count, 0);
        assert_eq!(request.has_floquet_k_vector, 0);
        assert_eq!(request.floquet_k_vector_rad_per_m, [0.0; 3]);
        assert_eq!(
            request.phase_convention,
            fullmag_fem_frequency_domain_phase_convention::FULLMAG_FEM_FREQUENCY_DOMAIN_PHASE_EXP_I_OMEGA_T
        );
        assert_eq!(
            request.drive_kind,
            fullmag_fem_frequency_domain_drive_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DRIVE_UNSPECIFIED
        );
        assert_eq!(request.require_nonzero_rhs, 0);
        assert!(request.mfem_floquet_periodic_pairs.is_null());
        assert_eq!(request.mfem_floquet_periodic_pair_count, 0);
        assert_eq!(request.mfem_dmi_uniform_ms, 0.0);
        assert_eq!(request.requires_periodic_airbox_dynamic_demag, 0);
        assert_eq!(request.requires_floquet_airbox_dynamic_demag, 0);
        assert_eq!(request.magnetic_periodic_constraint_set_count, 0);
        assert_eq!(request.magnetostatic_periodic_constraint_set_count, 0);
        assert_eq!(request.periodic_airbox_delta_m_tangent_dof_count, 0);
        assert_eq!(request.periodic_airbox_delta_phi_dof_count, 0);
        assert!(request
            .periodic_airbox_magnetostatic_periodic_node_pairs
            .is_null());
        assert_eq!(
            request.periodic_airbox_magnetostatic_periodic_node_pair_count,
            0
        );
        assert_eq!(request.periodic_airbox_coupled_block_enabled, 0);
        assert_eq!(
            request.periodic_airbox_coupled_block_delta_m_tangent_dof_count,
            0
        );
        assert_eq!(request.periodic_airbox_coupled_block_delta_phi_dof_count, 0);
        assert!(request
            .periodic_airbox_coupled_block_stiffness_matrix_row_major
            .is_null());
        assert!(request
            .periodic_airbox_coupled_block_mass_matrix_row_major
            .is_null());
        assert!(request
            .periodic_airbox_coupled_block_apply_stiffness
            .is_none());
        assert!(request.periodic_airbox_coupled_block_apply_mass.is_none());
        assert!(request
            .periodic_airbox_coupled_block_apply_complex_stiffness
            .is_none());
        assert!(request
            .periodic_airbox_coupled_block_apply_complex_mass
            .is_none());
        assert!(request
            .periodic_airbox_coupled_block_operator_user_data
            .is_null());
        assert!(request.periodic_airbox_coupled_block_drive_real.is_null());
        assert!(request.periodic_airbox_coupled_block_drive_imag.is_null());
        assert!(request.mfem_apply_demag_tangent.is_none());
        assert!(request.mfem_demag_tangent_user_data.is_null());
        assert!(request.mfem_demag_tangent_matrix_row_major.is_null());

        let result = std::mem::MaybeUninit::<fullmag_fem_frequency_domain_solve_result>::zeroed();
        let result = unsafe { result.assume_init() };
        assert_eq!(
            result.status,
            fullmag_fem_frequency_domain_status::FULLMAG_FEM_FREQUENCY_DOMAIN_STATUS_OK
        );
        assert_eq!(result.total_frequency_count, 0);
        assert_eq!(result.completed_frequency_count, 0);
        assert_eq!(result.written_frequency_point_artifacts, 0);
        assert!(result.error_message.is_null());
        assert!(result.diagnostics_json.is_null());
        assert!(result.result_json.is_null());
        assert!(result.artifact_manifest_path.is_null());
    }

    #[test]
    fn frequency_domain_driven_response_solve_abi_keeps_floquet_tail_layout() {
        type Request = fullmag_fem_frequency_domain_driven_response_request;

        let static_pair_ptr = std::mem::offset_of!(Request, mfem_static_periodic_node_pairs);
        let static_pair_count = std::mem::offset_of!(Request, mfem_static_periodic_node_pair_count);
        let has_floquet_k_vector = std::mem::offset_of!(Request, has_floquet_k_vector);
        let floquet_k_vector = std::mem::offset_of!(Request, floquet_k_vector_rad_per_m);
        let phase_convention = std::mem::offset_of!(Request, phase_convention);
        let drive_kind = std::mem::offset_of!(Request, drive_kind);
        let require_nonzero_rhs = std::mem::offset_of!(Request, require_nonzero_rhs);
        let floquet_pair_ptr = std::mem::offset_of!(Request, mfem_floquet_periodic_pairs);
        let floquet_pair_count = std::mem::offset_of!(Request, mfem_floquet_periodic_pair_count);
        let airbox_phi_pair_ptr =
            std::mem::offset_of!(Request, periodic_airbox_magnetostatic_periodic_node_pairs);
        let airbox_phi_pair_count = std::mem::offset_of!(
            Request,
            periodic_airbox_magnetostatic_periodic_node_pair_count
        );
        let mfem_apply_demag_tangent = std::mem::offset_of!(Request, mfem_apply_demag_tangent);
        let mfem_demag_tangent_user_data =
            std::mem::offset_of!(Request, mfem_demag_tangent_user_data);
        let mfem_demag_tangent_matrix =
            std::mem::offset_of!(Request, mfem_demag_tangent_matrix_row_major);
        let observable_ms_field = std::mem::offset_of!(Request, mfem_observable_ms_field);
        let observable_ms_field_len = std::mem::offset_of!(Request, mfem_observable_ms_field_len);
        let observable_uniform_ms = std::mem::offset_of!(Request, mfem_observable_uniform_ms);

        assert!(static_pair_ptr < static_pair_count);
        assert!(static_pair_count < has_floquet_k_vector);
        assert!(has_floquet_k_vector < floquet_k_vector);
        assert!(floquet_k_vector < phase_convention);
        assert!(phase_convention < drive_kind);
        assert!(drive_kind < require_nonzero_rhs);
        assert!(require_nonzero_rhs < floquet_pair_ptr);
        assert!(floquet_pair_ptr < floquet_pair_count);
        assert!(floquet_pair_count < airbox_phi_pair_ptr);
        assert!(airbox_phi_pair_ptr < airbox_phi_pair_count);
        assert!(mfem_apply_demag_tangent < mfem_demag_tangent_user_data);
        assert!(mfem_demag_tangent_user_data < mfem_demag_tangent_matrix);
        assert!(mfem_demag_tangent_matrix < observable_ms_field);
        assert!(observable_ms_field < observable_ms_field_len);
        assert!(observable_ms_field_len < observable_uniform_ms);
        assert!(
            std::mem::size_of::<fullmag_fem_frequency_domain_floquet_periodic_pair>()
                <= std::mem::size_of::<Request>()
        );
    }

    #[test]
    fn frequency_domain_dmi_element_abi_exposes_tetra_payload() {
        let element = std::mem::MaybeUninit::<fullmag_fem_frequency_domain_dmi_element>::zeroed();
        let element = unsafe { element.assume_init() };
        assert_eq!(
            element.kind,
            fullmag_fem_frequency_domain_dmi_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_INTERFACIAL
        );
        assert_eq!(element.node_indices, [0; 4]);
        assert_eq!(element.shape, [0.0; 4]);
        assert_eq!(element.grad_shape, [0.0; 12]);
        assert_eq!(element.weight, 0.0);
        assert_eq!(element.d, 0.0);
        assert_eq!(element.normal, [0.0; 3]);
        assert_eq!(
            fullmag_fem_frequency_domain_dmi_kind::FULLMAG_FEM_FREQUENCY_DOMAIN_DMI_BULK as i32,
            1
        );
    }

    #[test]
    fn frequency_domain_periodic_node_pair_abi_exposes_node_indices() {
        let pair =
            std::mem::MaybeUninit::<fullmag_fem_frequency_domain_periodic_node_pair>::zeroed();
        let pair = unsafe { pair.assume_init() };
        assert_eq!(pair.node_a, 0);
        assert_eq!(pair.node_b, 0);
    }

    #[test]
    fn frequency_domain_floquet_periodic_pair_abi_exposes_source_contract_metadata() {
        let pair =
            std::mem::MaybeUninit::<fullmag_fem_frequency_domain_floquet_periodic_pair>::zeroed();
        let pair = unsafe { pair.assume_init() };
        assert!(pair.pair_id.is_null());
        assert_eq!(pair.node_a, 0);
        assert_eq!(pair.node_b, 0);
        assert_eq!(pair.has_translation, 0);
        assert_eq!(pair.translation_m, [0.0; 3]);
        assert_eq!(pair.has_phase, 0);
        assert_eq!(pair.phase_rad, 0.0);
    }

    #[test]
    fn device_info_abi_exposes_gpu_memory_budget() {
        let info = std::mem::MaybeUninit::<fullmag_fem_device_info>::zeroed();
        let info = unsafe { info.assume_init() };
        assert_eq!(info.gpu_memory_free_bytes, 0);
        assert_eq!(info.gpu_memory_total_bytes, 0);
    }

    #[test]
    fn runtime_build_info_abi_exposes_versioned_mfem_identity() {
        let info = std::mem::MaybeUninit::<fullmag_fem_runtime_build_info>::zeroed();
        let info = unsafe { info.assume_init() };
        assert_eq!(info.abi_version, 0);
        assert_eq!(info.struct_size, 0);
        assert_eq!(info.mfem_version, [0; 32]);
        assert_eq!(std::mem::size_of::<fullmag_fem_runtime_build_info>(), 40);
        assert_eq!(std::mem::offset_of!(fullmag_fem_runtime_build_info, abi_version), 0);
        assert_eq!(std::mem::offset_of!(fullmag_fem_runtime_build_info, struct_size), 4);
        assert_eq!(std::mem::offset_of!(fullmag_fem_runtime_build_info, mfem_version), 8);
    }

    #[test]
    fn runtime_build_info_v2_abi_keeps_v1_layout_and_adds_hypre_identity() {
        let info = std::mem::MaybeUninit::<fullmag_fem_runtime_build_info_v2>::zeroed();
        let info = unsafe { info.assume_init() };
        assert_eq!(info.abi_version, 0);
        assert_eq!(info.struct_size, 0);
        assert_eq!(info.mfem_version, [0; 32]);
        assert_eq!(info.hypre_version, [0; 32]);
        assert_eq!(std::mem::size_of::<fullmag_fem_runtime_build_info>(), 40);
        assert_eq!(std::mem::size_of::<fullmag_fem_runtime_build_info_v2>(), 72);
        assert_eq!(std::mem::offset_of!(fullmag_fem_runtime_build_info_v2, abi_version), 0);
        assert_eq!(std::mem::offset_of!(fullmag_fem_runtime_build_info_v2, struct_size), 4);
        assert_eq!(std::mem::offset_of!(fullmag_fem_runtime_build_info_v2, mfem_version), 8);
        assert_eq!(std::mem::offset_of!(fullmag_fem_runtime_build_info_v2, hypre_version), 40);
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
        assert_eq!(stats.relaxation_preconditioner_wall_time_ns, 0);
        assert_eq!(stats.relaxation_state_copy_wall_time_ns, 0);
        assert_eq!(stats.relaxation_state_upload_wall_time_ns, 0);
        assert_eq!(stats.relaxation_retraction_wall_time_ns, 0);
        assert_eq!(stats.relaxation_gradient_wall_time_ns, 0);
        assert_eq!(stats.relaxation_metric_wall_time_ns, 0);
        assert_eq!(stats.relaxation_line_search_wall_time_ns, 0);
        assert_eq!(stats.relaxation_update_wall_time_ns, 0);
        assert_eq!(stats.relaxation_preconditioner_cache_hits, 0);
        assert_eq!(stats.relaxation_preconditioner_cache_misses, 0);
        assert_eq!(stats.cpu_thread_cap_reason, 0);
        assert_eq!(
            fullmag_fem_host_thread_policy_reason::FULLMAG_FEM_HOST_THREAD_POLICY_GPU_DEFAULT_ONE
                as i32,
            4
        );
        assert_eq!(stats.demag_amg_strength_threshold, 0.0);
        assert_eq!(stats.demag_amg_strength_threshold_is_set, 0);
        assert_eq!(stats.demag_amg_max_levels, 0);
        assert_eq!(stats.demag_amg_max_levels_is_set, 0);
    }

    #[test]
    fn accepted_energy_proof_v1_has_stable_sized_layout() {
        assert_eq!(FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION, 1);
        assert_eq!(
            std::mem::size_of::<fullmag_fem_accepted_energy_proof_v1>(),
            48
        );
        let proof = std::mem::MaybeUninit::<fullmag_fem_accepted_energy_proof_v1>::uninit();
        let base = proof.as_ptr() as usize;
        unsafe {
            assert_eq!(
                std::ptr::addr_of!((*proof.as_ptr()).abi_version) as usize - base,
                0
            );
            assert_eq!(
                std::ptr::addr_of!((*proof.as_ptr()).struct_size) as usize - base,
                4
            );
            assert_eq!(
                std::ptr::addr_of!((*proof.as_ptr()).accepted_energy_proof_available) as usize
                    - base,
                8
            );
            assert_eq!(
                std::ptr::addr_of!((*proof.as_ptr()).armijo_increment_rhs_j) as usize - base,
                40
            );
        }
        let _take_symbol: unsafe extern "C" fn(
            *mut fullmag_fem_backend,
            *mut fullmag_fem_accepted_energy_proof_v1,
        ) -> i32 = fullmag_fem_backend_take_accepted_energy_proof_v1;
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
        assert_eq!(info.uses_gpu_poisson, 0);
        assert_eq!(info.exchange_operator_mode[0], 0);
        assert_eq!(info.demag_operator_mode[0], 0);
        assert_eq!(info.hypre_execution_policy[0], 0);
        assert_eq!(info.demag_residency[0], 0);
        assert_eq!(info.reason[0], 0);
    }
}
