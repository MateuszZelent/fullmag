//! Safe Rust wrapper around the native MFEM/libCEED FEM backend scaffold.
//!
//! Current stage:
//! - stable C ABI and Rust wrapper
//! - availability probing
//! - native MFEM step with bootstrap transfer-grid demag on MFEM builds
//! - mesh-native/libCEED/hypre demag still pending

#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;

#[cfg(feature = "fem-gpu")]
use crate::preview::{build_mesh_preview_field_with_active_mask, mesh_quantity_active_mask};
#[cfg(feature = "fem-gpu")]
use crate::quantities::{normalize_quantity_id, QuantityId};
#[cfg(feature = "fem-gpu")]
use crate::scalar_metrics::{single_object_scalars, weighted_object_scalars};
#[cfg(feature = "fem-gpu")]
use crate::types::{LivePreviewField, LivePreviewRequest, RunError, StepStats};
#[cfg(feature = "fem-gpu")]
use fullmag_ir::{StageCompletionIR, StageStopReason};

#[cfg(feature = "fem-gpu")]
use std::ffi::c_void;
#[cfg(feature = "fem-gpu")]
use std::ffi::CStr;
#[cfg(feature = "fem-gpu")]
use std::sync::atomic::{AtomicBool, Ordering};

// ── Fallback defaults when air_box_config is absent (FEM-040) ────────────
#[cfg(feature = "fem-gpu")]
const FALLBACK_POISSON_BOUNDARY_MARKER: i32 = 99;
#[cfg(feature = "fem-gpu")]
const FALLBACK_ROBIN_BETA_FACTOR: f64 = 2.0;

#[cfg(feature = "fem-gpu")]
fn has_slonczewski_stt(plan: &fullmag_ir::FemPlanIR) -> bool {
    plan.current_density.is_some()
        && plan.stt_degree.is_some()
        && plan.stt_spin_polarization.is_some()
        && plan.stt_lambda.is_some()
}

#[cfg(feature = "fem-gpu")]
fn has_zhang_li_stt(plan: &fullmag_ir::FemPlanIR) -> bool {
    plan.current_density.is_some() && plan.stt_degree.is_some() && !has_slonczewski_stt(plan)
}

pub(crate) fn is_gpu_available() -> bool {
    #[cfg(feature = "fem-gpu")]
    {
        gpu_availability().available
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        false
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct GpuAvailability {
    pub available: bool,
    pub built_with_mfem_stack: bool,
    pub built_with_cuda_runtime: bool,
    pub built_with_ceed: bool,
    pub visible_cuda_device_count: i32,
    pub requested_gpu_index: i32,
    pub resolved_gpu_index: i32,
    pub reason: String,
}

pub(crate) fn gpu_availability() -> GpuAvailability {
    #[cfg(feature = "fem-gpu")]
    {
        let mut info = ffi::fullmag_fem_availability_info {
            available: 0,
            built_with_mfem_stack: 0,
            built_with_cuda_runtime: 0,
            built_with_ceed: 0,
            visible_cuda_device_count: 0,
            requested_gpu_index: -1,
            resolved_gpu_index: -1,
            reason: [0; 256],
        };
        let rc = unsafe { ffi::fullmag_fem_get_availability_info(&mut info) };
        if rc != ffi::FULLMAG_FEM_OK {
            return GpuAvailability {
                available: false,
                built_with_mfem_stack: false,
                built_with_cuda_runtime: false,
                built_with_ceed: false,
                visible_cuda_device_count: 0,
                requested_gpu_index: -1,
                resolved_gpu_index: -1,
                reason: last_global_error_or(
                    "fullmag_fem_get_availability_info failed without an error message",
                ),
            };
        }

        let reason = unsafe { CStr::from_ptr(info.reason.as_ptr()) }
            .to_string_lossy()
            .to_string();

        GpuAvailability {
            available: info.available == 1,
            built_with_mfem_stack: info.built_with_mfem_stack == 1,
            built_with_cuda_runtime: info.built_with_cuda_runtime == 1,
            built_with_ceed: info.built_with_ceed == 1,
            visible_cuda_device_count: info.visible_cuda_device_count,
            requested_gpu_index: info.requested_gpu_index,
            resolved_gpu_index: info.resolved_gpu_index,
            reason,
        }
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        GpuAvailability {
            available: false,
            built_with_mfem_stack: false,
            built_with_cuda_runtime: false,
            built_with_ceed: false,
            visible_cuda_device_count: 0,
            requested_gpu_index: -1,
            resolved_gpu_index: -1,
            reason: "fullmag-runner was built without the fem-gpu feature".to_string(),
        }
    }
}

#[cfg(feature = "fem-gpu")]
fn single_precision_rejection(plan: &fullmag_ir::FemPlanIR) -> &'static str {
    if plan.mfem_device_string.as_deref() == Some("cpu") {
        "MFEM/libCEED/hypre CPU FEM backend currently supports only double precision; single precision is not implemented"
    } else {
        "native FEM GPU backend requires double precision; single-precision CUDA kernels are not yet implemented"
    }
}

#[cfg(feature = "fem-gpu")]
pub(crate) struct NativeFemBackend {
    handle: *mut ffi::fullmag_fem_backend,
    magnetic_node_mask: Vec<bool>,
    object_weights: Vec<(String, f64)>,
}

#[cfg(feature = "fem-gpu")]
impl NativeFemBackend {
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

    pub fn create(plan: &fullmag_ir::FemPlanIR) -> Result<Self, RunError> {
        if matches!(
            plan.domain_mesh_mode,
            fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh
        ) && plan.demag_realization.is_some_and(|r| r.is_poisson())
        {
            return Err(RunError {
                message:
                    "native FEM air-box demag requires domain_mesh_mode='shared_domain_mesh_with_air'"
                        .to_string(),
            });
        }
        if plan.precision == fullmag_ir::ExecutionPrecision::Single {
            return Err(RunError {
                message: single_precision_rejection(plan).to_string(),
            });
        }
        let nodes_flat: Vec<f64> = plan
            .mesh
            .nodes
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();
        let elements_flat: Vec<u32> = plan
            .mesh
            .elements
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();
        let boundary_flat: Vec<u32> = plan
            .mesh
            .boundary_faces
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();
        let periodic_pairs_flat: Vec<u32> = plan
            .mesh
            .periodic_node_pairs
            .iter()
            .flat_map(|pair| [pair.node_a, pair.node_b])
            .collect();
        let m_flat: Vec<f64> = plan
            .initial_magnetization
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();

        let mesh = ffi::fullmag_fem_mesh_desc {
            nodes_xyz: nodes_flat.as_ptr(),
            n_nodes: plan.mesh.nodes.len() as u32,
            elements: elements_flat.as_ptr(),
            n_elements: plan.mesh.elements.len() as u32,
            element_markers: plan.mesh.element_markers.as_ptr(),
            boundary_faces: boundary_flat.as_ptr(),
            n_boundary_faces: plan.mesh.boundary_faces.len() as u32,
            boundary_markers: plan.mesh.boundary_markers.as_ptr(),
            periodic_node_pairs: periodic_pairs_flat.as_ptr(),
            n_periodic_node_pairs: plan.mesh.periodic_node_pairs.len() as u32,
        };

        let material = ffi::fullmag_fem_material_desc {
            saturation_magnetisation: plan.material.saturation_magnetisation,
            exchange_stiffness: plan.material.exchange_stiffness,
            damping: plan.material.damping,
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
        };
        let resolved_demag_realization = if plan.enable_demag {
            plan.demag_realization.ok_or_else(|| RunError {
                message: "native FEM backend requires a resolved Poisson demag realization when demag is enabled".to_string(),
            })?
        } else {
            fullmag_ir::ResolvedFemDemagIR::PoissonRobin
        };

        let precision = match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => {
                ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_SINGLE
            }
            fullmag_ir::ExecutionPrecision::Double => {
                ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_DOUBLE
            }
        };

        let mut plan_desc = ffi::fullmag_fem_plan_desc {
            mesh,
            material,
            fe_order: plan.fe_order,
            hmax: plan.hmax,
            precision,
            integrator: match plan.integrator {
                fullmag_ir::IntegratorChoice::Heun => {
                    ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_HEUN
                }
                fullmag_ir::IntegratorChoice::Rk4 => {
                    ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_RK4
                }
                fullmag_ir::IntegratorChoice::Rk23 => {
                    ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_RK23_BS
                }
                fullmag_ir::IntegratorChoice::Rk45 => {
                    ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_RK45_DP54
                }
                other => {
                    return Err(RunError {
                        message: format!(
                            "native FEM backend does not support integrator {:?}; \
                             supported integrators: Heun, Rk4, Rk23, Rk45",
                            other
                        ),
                    });
                }
            },
            enable_exchange: if plan.enable_exchange { 1 } else { 0 },
            enable_demag: if plan.enable_demag { 1 } else { 0 },
            has_external_field: if plan.external_field.is_some() { 1 } else { 0 },
            external_field_am: plan.external_field.unwrap_or([0.0, 0.0, 0.0]),
            demag_solver: {
                let policy = plan
                    .demag_solver_policy
                    .as_ref()
                    .cloned()
                    .unwrap_or_default();
                let solver = match policy.solver.as_str() {
                    "CG" => ffi::fullmag_fem_linear_solver::FULLMAG_FEM_LINEAR_SOLVER_CG,
                    "GMRES" => ffi::fullmag_fem_linear_solver::FULLMAG_FEM_LINEAR_SOLVER_GMRES,
                    other => {
                        return Err(RunError {
                            message: format!(
                                "native FEM: unsupported demag linear solver '{}'; \
                                 supported: CG, GMRES",
                                other
                            ),
                        });
                    }
                };
                let preconditioner = match policy.preconditioner.as_str() {
                    "AMG" => ffi::fullmag_fem_preconditioner::FULLMAG_FEM_PRECONDITIONER_AMG,
                    "JACOBI" => ffi::fullmag_fem_preconditioner::FULLMAG_FEM_PRECONDITIONER_JACOBI,
                    "NONE" => ffi::fullmag_fem_preconditioner::FULLMAG_FEM_PRECONDITIONER_NONE,
                    other => {
                        return Err(RunError {
                            message: format!(
                                "native FEM: unsupported demag preconditioner '{}'; \
                                 supported: AMG, JACOBI, NONE",
                                other
                            ),
                        });
                    }
                };
                ffi::fullmag_fem_solver_config {
                    solver,
                    preconditioner,
                    relative_tolerance: policy.rtol,
                    max_iterations: policy.max_iterations,
                }
            },
            air_box_factor: plan.air_box_config.as_ref().map_or(0.0, |c| c.factor),
            demag_realization: match resolved_demag_realization {
                fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => {
                    ffi::fullmag_fem_demag_realization::FULLMAG_FEM_DEMAG_AIRBOX_DIRICHLET
                }
                fullmag_ir::ResolvedFemDemagIR::PoissonRobin => {
                    ffi::fullmag_fem_demag_realization::FULLMAG_FEM_DEMAG_AIRBOX_ROBIN
                }
                fullmag_ir::ResolvedFemDemagIR::Bem
                | fullmag_ir::ResolvedFemDemagIR::FredkinKoehler
                | fullmag_ir::ResolvedFemDemagIR::Fmm => {
                    return Err(RunError {
                        message: format!(
                            "native FEM runner: demag model '{}' is not yet implemented in the backend",
                            resolved_demag_realization.model_name(),
                        ),
                    });
                }
            },
            poisson_boundary_marker: plan
                .air_box_config
                .as_ref()
                .map_or(FALLBACK_POISSON_BOUNDARY_MARKER, |c| {
                    c.boundary_marker as i32
                }),
            robin_beta_mode: plan.air_box_config.as_ref().map_or(0, |c| {
                match c.bc_kind.as_deref() {
                    Some("robin") => match c.robin_beta_mode.as_deref() {
                        Some("legacy") => 1,
                        Some("dipole") | None => 2,
                        Some("user") => 3,
                        _ => 2,
                    },
                    _ => 0,
                }
            }),
            robin_beta_factor: plan
                .air_box_config
                .as_ref()
                .and_then(|c| c.robin_beta_factor)
                .unwrap_or(FALLBACK_ROBIN_BETA_FACTOR),
            initial_magnetization_xyz: m_flat.as_ptr(),
            initial_magnetization_len: m_flat.len() as u64,
            dt_seconds: crate::resolve_initial_timestep(
                plan.fixed_timestep,
                plan.adaptive_timestep.as_ref(),
            )
            .ok_or_else(|| RunError {
                message: "native FEM: no fixed_timestep or adaptive_timestep specified".to_string(),
            })?,
            adaptive_config: std::ptr::null(),
            field_refresh: ffi::fullmag_fem_field_refresh_policy {
                has_demag_interval_s: if plan
                    .field_refresh
                    .as_ref()
                    .and_then(|policy| policy.demag_interval_s)
                    .is_some()
                {
                    1
                } else {
                    0
                },
                demag_interval_s: plan
                    .field_refresh
                    .as_ref()
                    .and_then(|policy| policy.demag_interval_s)
                    .unwrap_or(0.0),
            },
            relax_stop: {
                let stop = plan.relaxation.as_ref().map(|control| &control.stop);
                ffi::fullmag_fem_relax_stop {
                    has_torque_tolerance_apm: if stop
                        .and_then(|cfg| cfg.torque_tolerance_apm)
                        .is_some()
                    {
                        1
                    } else {
                        0
                    },
                    torque_tolerance_apm: stop
                        .and_then(|cfg| cfg.torque_tolerance_apm)
                        .unwrap_or(0.0),
                    has_energy_tolerance_j: if stop.and_then(|cfg| cfg.energy_tolerance_j).is_some()
                    {
                        1
                    } else {
                        0
                    },
                    energy_tolerance_j: stop.and_then(|cfg| cfg.energy_tolerance_j).unwrap_or(0.0),
                    has_max_steps: if stop.and_then(|cfg| cfg.max_steps).is_some() {
                        1
                    } else {
                        0
                    },
                    max_steps: stop.and_then(|cfg| cfg.max_steps).unwrap_or(0),
                    has_max_pseudotime_s: if stop.and_then(|cfg| cfg.max_pseudotime_s).is_some() {
                        1
                    } else {
                        0
                    },
                    max_pseudotime_s: stop.and_then(|cfg| cfg.max_pseudotime_s).unwrap_or(0.0),
                    has_max_physical_time_s: if stop
                        .and_then(|cfg| cfg.max_physical_time_s)
                        .is_some()
                    {
                        1
                    } else {
                        0
                    },
                    max_physical_time_s: stop
                        .and_then(|cfg| cfg.max_physical_time_s)
                        .unwrap_or(0.0),
                }
            },
            // F-05 fix: enable uniaxial anisotropy when ANY of the relevant
            // parameters are set (Ku, Ku2, Ku_field, Ku2_field).
            has_uniaxial_anisotropy: if plan.material.uniaxial_anisotropy.is_some()
                || plan.material.uniaxial_anisotropy_k2.is_some()
                || plan.material.ku_field.is_some()
                || plan.material.ku2_field.is_some()
            {
                1
            } else {
                0
            },
            uniaxial_anisotropy_constant: plan.material.uniaxial_anisotropy.unwrap_or(0.0),
            uniaxial_anisotropy_k2: plan.material.uniaxial_anisotropy_k2.unwrap_or(0.0),
            anisotropy_axis: plan.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
            // F-05 fix: enable interfacial DMI when D or dind_field is present.
            has_interfacial_dmi: if plan.interfacial_dmi.is_some() || plan.dind_field.is_some() {
                1
            } else {
                0
            },
            dmi_constant: plan.interfacial_dmi.unwrap_or(0.0),
            dmi_interface_normal: plan.dmi_interface_normal.unwrap_or([0.0, 0.0, 1.0]),
            // F-05 fix: enable bulk DMI when D or dbulk_field is present.
            has_bulk_dmi: if plan.bulk_dmi.is_some() || plan.dbulk_field.is_some() {
                1
            } else {
                0
            },
            bulk_dmi_constant: plan.bulk_dmi.unwrap_or(0.0),
            // F-05 fix: enable cubic anisotropy when ANY of Kc1/Kc2/Kc3
            // or their per-node fields are present.
            has_cubic_anisotropy: if plan.material.cubic_anisotropy_kc1.is_some()
                || plan.material.cubic_anisotropy_kc2.is_some()
                || plan.material.cubic_anisotropy_kc3.is_some()
                || plan.material.kc1_field.is_some()
                || plan.material.kc2_field.is_some()
                || plan.material.kc3_field.is_some()
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
            // Per-node spatially varying fields
            ms_field: plan
                .material
                .ms_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            ms_field_len: plan
                .material
                .ms_field
                .as_ref()
                .map_or(0, |v| v.len() as u64),
            a_field: plan
                .material
                .a_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            a_field_len: plan.material.a_field.as_ref().map_or(0, |v| v.len() as u64),
            alpha_field: plan
                .material
                .alpha_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            alpha_field_len: plan
                .material
                .alpha_field
                .as_ref()
                .map_or(0, |v| v.len() as u64),
            ku_field: plan
                .material
                .ku_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            ku_field_len: plan
                .material
                .ku_field
                .as_ref()
                .map_or(0, |v| v.len() as u64),
            ku2_field: plan
                .material
                .ku2_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            ku2_field_len: plan
                .material
                .ku2_field
                .as_ref()
                .map_or(0, |v| v.len() as u64),
            dind_field: plan
                .dind_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            dind_field_len: plan.dind_field.as_ref().map_or(0, |v| v.len() as u64),
            dbulk_field: plan
                .dbulk_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            dbulk_field_len: plan.dbulk_field.as_ref().map_or(0, |v| v.len() as u64),
            kc1_field: plan
                .material
                .kc1_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            kc1_field_len: plan
                .material
                .kc1_field
                .as_ref()
                .map_or(0, |v| v.len() as u64),
            kc2_field: plan
                .material
                .kc2_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            kc2_field_len: plan
                .material
                .kc2_field
                .as_ref()
                .map_or(0, |v| v.len() as u64),
            kc3_field: plan
                .material
                .kc3_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            kc3_field_len: plan
                .material
                .kc3_field
                .as_ref()
                .map_or(0, |v| v.len() as u64),
            has_zhang_li_stt: if has_zhang_li_stt(plan) { 1 } else { 0 },
            has_slonczewski_stt: if has_slonczewski_stt(plan) { 1 } else { 0 },
            stt_current_density_am2: plan.current_density.unwrap_or([0.0, 0.0, 0.0]),
            stt_degree: plan.stt_degree.unwrap_or(0.0),
            stt_beta: plan.stt_beta.unwrap_or(0.0),
            stt_spin_polarization: plan.stt_spin_polarization.unwrap_or([0.0, 0.0, 1.0]),
            stt_lambda: plan.stt_lambda.unwrap_or(1.0),
            stt_epsilon_prime: plan.stt_epsilon_prime.unwrap_or(0.0),
            stt_free_layer_thickness: plan.stt_thickness.unwrap_or(0.0),
            stt_current_sign: match plan.stt_fixed_layer_position.as_deref() {
                Some("bottom") if has_slonczewski_stt(plan) => -1.0,
                _ => 1.0,
            },
            // Oersted field
            has_oersted_cylinder: if plan.has_oersted_cylinder { 1 } else { 0 },
            oersted_current: plan.oersted_current.unwrap_or(0.0),
            oersted_radius: plan.oersted_radius.unwrap_or(0.0),
            oersted_center: plan.oersted_center.unwrap_or([0.0, 0.0, 0.0]),
            oersted_axis: plan.oersted_axis.unwrap_or([0.0, 0.0, 1.0]),
            oersted_field_xyz: plan
                .oersted_field_xyz
                .as_deref()
                .map_or(std::ptr::null(), |values| values.as_ptr()),
            oersted_field_len: plan
                .oersted_field_xyz
                .as_ref()
                .map_or(0, |values| values.len() as u64),
            oersted_time_dep_kind: plan.oersted_time_dep_kind,
            oersted_time_dep_freq: plan.oersted_time_dep_freq,
            oersted_time_dep_phase: plan.oersted_time_dep_phase,
            oersted_time_dep_offset: plan.oersted_time_dep_offset,
            oersted_time_dep_t_on: plan.oersted_time_dep_t_on,
            oersted_time_dep_t_off: plan.oersted_time_dep_t_off,
            temperature: plan.temperature.unwrap_or(0.0),
            // Magnetoelastic coupling
            has_magnetoelastic: if plan.magnetoelastic.is_some() { 1 } else { 0 },
            mel_b1: plan.magnetoelastic.as_ref().map_or(0.0, |m| m.b1),
            mel_b2: plan.magnetoelastic.as_ref().map_or(0.0, |m| m.b2),
            mel_uniform_strain: if plan
                .magnetoelastic
                .as_ref()
                .and_then(|m| m.prescribed_strain)
                .is_some()
            {
                1
            } else {
                0
            },
            mel_strain_voigt: std::ptr::null(), // will be set below
            mel_strain_len: 0,
            // FEM-029 fix: pass explicit GPU device index from plan.
            gpu_device_index: plan.gpu_device_index.unwrap_or(-1),
            // FEM-021 fix: pass thermal seed from plan.
            thermal_seed: plan
                .thermal_seed_config
                .as_ref()
                .map_or(0, |c| c.seed.unwrap_or(0)),
            // FEM-030 fix: pass explicit MFEM device string from plan.
            mfem_device_string: std::ptr::null(), // set below if present
            // FND-013: pass consistent-mass flag.
            use_consistent_mass: if plan.use_consistent_mass.unwrap_or(false) {
                1
            } else {
                0
            },
        };

        // Build adaptive config if present
        if let Some(ref a) = plan.adaptive_timestep {
            // Reject adaptive fields not supported by the native FEM backend FFI.
            let mut unsupported = Vec::new();
            if a.max_spin_rotation.is_some() {
                unsupported.push("max_spin_rotation".to_string());
            }
            if a.norm_tolerance.is_some() {
                unsupported.push("norm_tolerance".to_string());
            }
            if !unsupported.is_empty() {
                return Err(RunError {
                    message: format!(
                        "native FEM backend does not support adaptive parameters: {}; \
                         supported: atol, rtol, dt_initial, dt_min, dt_max, safety, \
                         growth_limit, shrink_limit",
                        unsupported.join(", ")
                    ),
                });
            }
        }
        let adaptive_cfg = plan
            .adaptive_timestep
            .as_ref()
            .map(|a| -> Result<ffi::fullmag_fem_adaptive_config, RunError> {
                Ok(ffi::fullmag_fem_adaptive_config {
                    atol: a.atol,
                    rtol: a.rtol,
                    dt_initial: crate::resolve_initial_timestep(plan.fixed_timestep, Some(a))
                        .unwrap_or(crate::DEFAULT_ADAPTIVE_DT_INITIAL),
                    dt_min: a.dt_min,
                    dt_max: a.dt_max.unwrap_or(crate::DEFAULT_ADAPTIVE_DT_MAX),
                    safety: a.safety,
                    growth_limit: a.growth_limit,
                    shrink_limit: a.shrink_limit,
                })
            })
            .transpose()?;
        if let Some(ref cfg) = adaptive_cfg {
            plan_desc.adaptive_config = cfg as *const ffi::fullmag_fem_adaptive_config;
        }

        // Set up prescribed strain if present
        let mel_strain_data: Option<[f64; 6]> = plan
            .magnetoelastic
            .as_ref()
            .and_then(|m| m.prescribed_strain);
        if let Some(ref strain) = mel_strain_data {
            plan_desc.mel_strain_voigt = strain.as_ptr();
            plan_desc.mel_strain_len = 6;
        }

        // FEM-030 fix: pass explicit MFEM device string (must be kept alive until backend_create).
        let mfem_device_cstring = plan
            .mfem_device_string
            .as_deref()
            .map(|s| std::ffi::CString::new(s).expect("mfem_device_string must not contain NUL"));
        if let Some(ref cs) = mfem_device_cstring {
            plan_desc.mfem_device_string = cs.as_ptr();
        }

        let handle = unsafe { ffi::fullmag_fem_backend_create(&plan_desc) };
        if handle.is_null() {
            let availability = gpu_availability();
            return Err(RunError {
                message: last_global_error_or(&format!(
                    "FEM GPU backend_create returned null without an error message ({})",
                    availability.reason
                )),
            });
        }

        let err = unsafe { ffi::fullmag_fem_backend_last_error(handle) };
        if !err.is_null() {
            let msg = unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string();
            unsafe { ffi::fullmag_fem_backend_destroy(handle) };
            return Err(RunError { message: msg });
        }

        Ok(Self {
            handle,
            magnetic_node_mask: mesh_quantity_active_mask("m", &plan.mesh)
                .unwrap_or_else(|| vec![true; plan.mesh.nodes.len()]),
            object_weights: if plan.object_segments.is_empty() {
                vec![("free".to_string(), 1.0)]
            } else {
                let mut weights: std::collections::HashMap<String, f64> =
                    std::collections::HashMap::new();
                for segment in &plan.object_segments {
                    let weight = f64::from(segment.node_count.max(1));
                    *weights.entry(segment.object_id.clone()).or_insert(0.0) += weight;
                }
                let collected = weights.into_iter().collect::<Vec<_>>();
                if collected.is_empty() {
                    vec![("free".to_string(), 1.0)]
                } else {
                    collected
                }
            },
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
            unsafe { ffi::fullmag_fem_backend_set_interrupt_poll(self.handle, poll_fn, user_data) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU set_interrupt_signal failed"));
        }
        Ok(())
    }

    pub fn step_interruptible(
        &mut self,
        dt: f64,
        interrupt_signal: Option<&AtomicBool>,
    ) -> Result<Option<StepStats>, RunError> {
        self.set_interrupt_signal(interrupt_signal)?;
        let mut stats = ffi::fullmag_fem_step_stats {
            step: 0,
            time_seconds: 0.0,
            dt_seconds: 0.0,
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            anisotropy_energy_joules: 0.0,
            dmi_energy_joules: 0.0,
            total_energy_joules: 0.0,
            magnetoelastic_energy_joules: 0.0,
            max_effective_field_amplitude: 0.0,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude: 0.0,
            max_torque_Apm: 0.0,
            demag_linear_iterations: 0,
            demag_linear_residual: 0.0,
            wall_time_ns: 0,
            exchange_wall_time_ns: 0,
            demag_wall_time_ns: 0,
            rhs_wall_time_ns: 0,
            extra_energy_wall_time_ns: 0,
            snapshot_wall_time_ns: 0,
            error_estimate: 0.0,
            rejected_attempts: 0,
            dt_suggested: 0.0,
            rhs_evaluations: 0,
            fsal_reused: 0,
            requested_omp_threads: 0,
            effective_omp_threads: 0,
        };

        let rc = unsafe { ffi::fullmag_fem_backend_step(self.handle, dt, &mut stats) };
        if rc == ffi::FULLMAG_FEM_ERR_INTERRUPTED {
            return Ok(None);
        }
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU step failed"));
        }

        let mut step_stats = StepStats {
            step: stats.step,
            time: stats.time_seconds,
            dt: stats.dt_seconds,
            e_ex: stats.exchange_energy_joules,
            e_demag: stats.demag_energy_joules,
            e_ext: stats.external_energy_joules,
            e_ani: stats.anisotropy_energy_joules,
            e_dmi: stats.dmi_energy_joules,
            e_total: stats.total_energy_joules,
            max_dm_dt: stats.max_rhs_amplitude,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            max_torque_Apm: stats.max_torque_Apm,
            max_torque_T: stats.max_torque_Apm * crate::MU0,
            wall_time_ns: stats.wall_time_ns,
            exchange_wall_time_ns: stats.exchange_wall_time_ns,
            demag_wall_time_ns: stats.demag_wall_time_ns,
            rhs_wall_time_ns: stats.rhs_wall_time_ns,
            extra_energy_wall_time_ns: stats.extra_energy_wall_time_ns,
            snapshot_wall_time_ns: stats.snapshot_wall_time_ns,
            error_estimate: if stats.error_estimate > 0.0 {
                Some(stats.error_estimate)
            } else {
                None
            },
            rejected_attempts: stats.rejected_attempts,
            dt_suggested: if stats.dt_suggested > 0.0 {
                Some(stats.dt_suggested)
            } else {
                None
            },
            rhs_evals: stats.rhs_evaluations,
            fsal_reused: stats.fsal_reused != 0,
            demag_solves: if stats.demag_linear_iterations > 0 {
                1
            } else {
                0
            },
            poisson_iterations: stats.demag_linear_iterations,
            poisson_final_residual: stats.demag_linear_residual,
            demag_refreshed: stats.demag_linear_iterations > 0,
            requested_fem_omp_threads: stats.requested_omp_threads,
            effective_fem_omp_threads: stats.effective_omp_threads,
            ..StepStats::default()
        };
        step_stats.per_object_scalars =
            if self.object_weights.len() == 1 && self.object_weights[0].0 == "free" {
                single_object_scalars("free", &step_stats)
            } else {
                weighted_object_scalars(&step_stats, &self.object_weights)
            };
        Ok(Some(step_stats))
    }

    #[allow(dead_code)]
    pub fn step(&mut self, dt: f64) -> Result<StepStats, RunError> {
        self.step_interruptible(dt, None)?
            .ok_or_else(|| self.last_error_or("FEM GPU step interrupted without a signal"))
    }

    pub fn copy_field(
        &self,
        observable: ffi::fullmag_fem_observable,
        node_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        let len = node_count * 3;
        let mut flat = vec![0.0f64; len];
        let rc = unsafe {
            ffi::fullmag_fem_backend_copy_field_f64(
                self.handle,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU copy_field failed"));
        }
        Ok(flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect())
    }

    pub fn copy_m(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_M,
            node_count,
        )
    }

    pub fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        let flat = magnetization
            .iter()
            .flat_map(|value| value.iter().copied())
            .collect::<Vec<_>>();
        let rc = unsafe {
            ffi::fullmag_fem_backend_upload_magnetization_f64(
                self.handle,
                flat.as_ptr(),
                flat.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU upload magnetization failed"));
        }
        Ok(())
    }

    pub fn snapshot_step_stats(&mut self, node_count: usize) -> Result<StepStats, RunError> {
        let mut stats = ffi::fullmag_fem_step_stats {
            step: 0,
            time_seconds: 0.0,
            dt_seconds: 0.0,
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            anisotropy_energy_joules: 0.0,
            dmi_energy_joules: 0.0,
            total_energy_joules: 0.0,
            magnetoelastic_energy_joules: 0.0,
            max_effective_field_amplitude: 0.0,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude: 0.0,
            max_torque_Apm: 0.0,
            demag_linear_iterations: 0,
            demag_linear_residual: 0.0,
            wall_time_ns: 0,
            exchange_wall_time_ns: 0,
            demag_wall_time_ns: 0,
            rhs_wall_time_ns: 0,
            extra_energy_wall_time_ns: 0,
            snapshot_wall_time_ns: 0,
            error_estimate: 0.0,
            rejected_attempts: 0,
            dt_suggested: 0.0,
            rhs_evaluations: 0,
            fsal_reused: 0,
            requested_omp_threads: 0,
            effective_omp_threads: 0,
        };

        let rc = unsafe { ffi::fullmag_fem_backend_snapshot_stats(self.handle, &mut stats) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU snapshot_step_stats failed"));
        }

        let magnetization = self.copy_m(node_count)?;
        let mut step_stats = StepStats {
            step: stats.step,
            time: stats.time_seconds,
            dt: stats.dt_seconds,
            e_ex: stats.exchange_energy_joules,
            e_demag: stats.demag_energy_joules,
            e_ext: stats.external_energy_joules,
            e_ani: stats.anisotropy_energy_joules,
            e_dmi: stats.dmi_energy_joules,
            e_total: stats.total_energy_joules,
            max_dm_dt: stats.max_rhs_amplitude,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            max_torque_Apm: stats.max_torque_Apm,
            max_torque_T: stats.max_torque_Apm * crate::MU0,
            wall_time_ns: stats.wall_time_ns,
            exchange_wall_time_ns: stats.exchange_wall_time_ns,
            demag_wall_time_ns: stats.demag_wall_time_ns,
            rhs_wall_time_ns: stats.rhs_wall_time_ns,
            extra_energy_wall_time_ns: stats.extra_energy_wall_time_ns,
            snapshot_wall_time_ns: stats.snapshot_wall_time_ns,
            demag_solves: if stats.demag_linear_iterations > 0 {
                1
            } else {
                0
            },
            poisson_iterations: stats.demag_linear_iterations,
            poisson_final_residual: stats.demag_linear_residual,
            demag_refreshed: stats.demag_linear_iterations > 0,
            requested_fem_omp_threads: stats.requested_omp_threads,
            effective_fem_omp_threads: stats.effective_omp_threads,
            ..StepStats::default()
        };
        crate::scalar_metrics::apply_average_m_to_step_stats(&mut step_stats, &magnetization);
        step_stats.per_object_scalars =
            if self.object_weights.len() == 1 && self.object_weights[0].0 == "free" {
                single_object_scalars("free", &step_stats)
            } else {
                weighted_object_scalars(&step_stats, &self.object_weights)
            };
        Ok(step_stats)
    }

    pub fn copy_h_ex(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EX,
            node_count,
        )
    }

    pub fn copy_h_demag(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DEMAG,
            node_count,
        )
    }

    pub fn copy_h_ext(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EXT,
            node_count,
        )
    }

    pub fn copy_h_eff(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EFF,
            node_count,
        )
    }

    pub fn copy_h_ani(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI,
            node_count,
        )
    }

    pub fn copy_h_dmi(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI,
            node_count,
        )
    }

    pub fn copy_h_mel(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_MEL,
            node_count,
        )
    }

    // FND-010 fix: add accessors for F-12 observables (cubic anisotropy, bulk DMI, Oersted, thermal)
    pub fn copy_h_ani_cubic(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC,
            node_count,
        )
    }

    pub fn copy_h_dmi_bulk(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI_BULK,
            node_count,
        )
    }

    pub fn copy_h_oe(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_OE,
            node_count,
        )
    }

    pub fn copy_h_therm(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_THERM,
            node_count,
        )
    }

    pub fn copy_live_preview_field(
        &self,
        request: &LivePreviewRequest,
        node_count: usize,
    ) -> Result<LivePreviewField, RunError> {
        let values = match normalize_quantity_id(&request.quantity)? {
            QuantityId::HEx => self.copy_h_ex(node_count)?,
            QuantityId::HDemag => self.copy_h_demag(node_count)?,
            QuantityId::HExt => self.copy_h_ext(node_count)?,
            QuantityId::HEff => self.copy_h_eff(node_count)?,
            QuantityId::HAni => self.copy_h_ani(node_count)?,
            QuantityId::HDmi => self.copy_h_dmi(node_count)?,
            QuantityId::HMel => self.copy_h_mel(node_count)?,
            // FND-010 fix: support F-12 observable quantities in live preview
            QuantityId::HAniCubic => self.copy_h_ani_cubic(node_count)?,
            QuantityId::HDmiBulk => self.copy_h_dmi_bulk(node_count)?,
            QuantityId::HOe => self.copy_h_oe(node_count)?,
            QuantityId::HTherm => self.copy_h_therm(node_count)?,
            QuantityId::M => self.copy_m(node_count)?,
            other => {
                return Err(RunError {
                    message: format!(
                        "native FEM preview quantity '{}' is not supported",
                        other.as_str()
                    ),
                })
            }
        };
        let active_mask = (crate::quantities::quantity_spatial_domain(&request.quantity)
            == "magnetic_only")
            .then(|| self.magnetic_node_mask.clone());
        Ok(build_mesh_preview_field_with_active_mask(
            request,
            &values,
            active_mask,
        ))
    }

    pub fn device_info(&self) -> Result<DeviceInfo, RunError> {
        let mut info = ffi::fullmag_fem_device_info {
            name: [0; 128],
            is_gpu_enabled: 0,
            compute_capability_major: 0,
            compute_capability_minor: 0,
            driver_version: 0,
            runtime_version: 0,
        };

        let rc = unsafe { ffi::fullmag_fem_backend_get_device_info(self.handle, &mut info) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU get_device_info failed"));
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

    pub fn stage_completion(&self) -> Result<Option<StageCompletionIR>, RunError> {
        let mut completion = ffi::fullmag_fem_stage_completion {
            has_reason: 0,
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_TORQUE,
            has_metric_name: 0,
            metric_name: [0; 64],
            metric_value: 0.0,
            threshold: 0.0,
        };
        let rc = unsafe { ffi::fullmag_fem_backend_stage_completion(self.handle, &mut completion) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU stage_completion failed"));
        }
        if completion.has_reason == 0 {
            return Ok(None);
        }

        let reason = match completion.reason {
            ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_TORQUE => {
                StageStopReason::Torque
            }
            ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_ENERGY => {
                StageStopReason::Energy
            }
            ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS => {
                StageStopReason::MaxSteps
            }
            ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME => {
                StageStopReason::MaxPseudotime
            }
            ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME => {
                StageStopReason::MaxPhysicalTime
            }
            ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED => {
                StageStopReason::UserCancelled
            }
            ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR => {
                StageStopReason::BackendError
            }
        };

        let metric_name = if completion.has_metric_name != 0 {
            let value = unsafe { CStr::from_ptr(completion.metric_name.as_ptr()) }
                .to_string_lossy()
                .to_string();
            if value.is_empty() {
                None
            } else {
                Some(value)
            }
        } else {
            None
        };
        let has_metric = metric_name.is_some();

        Ok(Some(StageCompletionIR {
            status: "completed".to_string(),
            reason: Some(reason),
            metric_name,
            metric_value: if has_metric {
                Some(completion.metric_value)
            } else {
                None
            },
            threshold: if has_metric {
                Some(completion.threshold)
            } else {
                None
            },
        }))
    }

    fn last_error_or(&self, fallback: &str) -> RunError {
        let err = unsafe { ffi::fullmag_fem_backend_last_error(self.handle) };
        let msg = if err.is_null() {
            fallback.to_string()
        } else {
            unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string()
        };
        RunError { message: msg }
    }
}

#[cfg(feature = "fem-gpu")]
impl Drop for NativeFemBackend {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::fullmag_fem_backend_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

#[cfg(feature = "fem-gpu")]
#[derive(Debug, Clone)]
pub(crate) struct DeviceInfo {
    pub name: String,
    pub compute_capability: String,
    pub driver_version: i32,
    pub runtime_version: i32,
}

#[cfg(feature = "fem-gpu")]
fn last_global_error_or(fallback: &str) -> String {
    let err = unsafe { ffi::fullmag_fem_backend_last_error(std::ptr::null_mut()) };
    if !err.is_null() {
        let msg = unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string();
        if !msg.is_empty() {
            return msg;
        }
    }
    fallback.to_string()
}

// ---------------------------------------------------------------------------
// ── GPU Dense Generalized Eigenvalue Solver (Etap A4) ──────────────────────
// ---------------------------------------------------------------------------

/// Result of a GPU dense eigen solve.
pub(crate) struct GpuEigenResult {
    /// Eigenvalues in ascending order.
    pub eigenvalues: Vec<f64>,
    /// Eigenvectors stored column-major (column i = eigenvector i).
    /// Length = n * n_eigenvalues.
    pub eigenvectors_col_major: Vec<f64>,
    #[allow(dead_code)]
    /// Dimension n of the system that was solved.
    pub n: usize,
}

/// Solve the real symmetric generalized eigenvalue problem K·x = λ·M·x on the
/// GPU using cuSolverDN `Dsygvd`.
///
/// `k_col_major` and `m_col_major` must be column-major, n×n `f64` slices.
/// `n` is the matrix dimension, `n_eigenvalues` is how many modes to return.
///
/// Returns `Ok(GpuEigenResult)` on success, `Err(String)` with a reason on
/// failure.  When the GPU/cuSolver stack is not available the error message
/// contains "UNAVAILABLE" so callers can fall back gracefully.
pub(crate) fn gpu_eigen_dense_solve(
    k_col_major: &[f64],
    m_col_major: &[f64],
    n: usize,
    n_eigenvalues: usize,
) -> Result<GpuEigenResult, String> {
    #[cfg(feature = "fem-gpu")]
    {
        if k_col_major.len() != n * n || m_col_major.len() != n * n {
            return Err(format!(
                "gpu_eigen_dense_solve: matrix size mismatch (expected {n}×{n}, got K={}, M={})",
                k_col_major.len(),
                m_col_major.len()
            ));
        }
        let ne = n_eigenvalues.min(n);
        let mut eigenvalues = vec![0.0_f64; ne];
        let mut eigenvectors = vec![0.0_f64; n * ne];
        let mut reason_buf = vec![0i8; 512];

        let mut desc = ffi::fullmag_fem_eigen_dense_desc {
            k_lower_col_major: k_col_major.as_ptr(),
            m_lower_col_major: m_col_major.as_ptr(),
            n: n as u32,
            n_eigenvalues: ne as u32,
            out_eigenvalues: eigenvalues.as_mut_ptr(),
            out_eigenvectors: eigenvectors.as_mut_ptr(),
            out_reason: reason_buf.as_mut_ptr(),
            reason_len: reason_buf.len() as u32,
        };

        let rc = unsafe { ffi::fullmag_fem_eigen_dense(&mut desc) };

        let reason = unsafe {
            std::ffi::CStr::from_ptr(reason_buf.as_ptr())
                .to_string_lossy()
                .into_owned()
        };

        if rc == ffi::FULLMAG_FEM_ERR_UNAVAILABLE {
            return Err(format!("UNAVAILABLE: {reason}"));
        }
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(format!("GPU eigen solve failed (rc={rc}): {reason}"));
        }

        Ok(GpuEigenResult {
            eigenvalues,
            eigenvectors_col_major: eigenvectors,
            n,
        })
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        let _ = (k_col_major, m_col_major, n, n_eigenvalues);
        Err("UNAVAILABLE: fullmag-runner was built without the fem-gpu feature".to_string())
    }
}

#[cfg(all(test, feature = "fem-gpu"))]
mod tests {
    use super::*;
    use fullmag_engine::fem::{FemLlgProblem, FemLlgState, MeshTopology};
    use fullmag_engine::{EffectiveFieldTerms, LlgConfig, MaterialParameters, TimeIntegrator};
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FemPlanIR, IntegratorChoice, MaterialIR,
        MeshIR, MeshPeriodicBoundaryPairIR, MeshPeriodicNodePairIR,
    };

    fn make_test_plan() -> FemPlanIR {
        FemPlanIR {
            mesh_name: "unit_tet".to_string(),
            mesh_source: Some("meshes/unit_tet.msh".to_string()),
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
                per_domain_quality: std::collections::HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 0.4,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
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
            external_field: Some([1.0, 2.0, 3.0]),
            current_modules: vec![],
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
            interfacial_dmi: None,
            dmi_interface_normal: None,
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
            use_consistent_mass: None,
        }
    }

    #[test]
    fn native_fem_rejects_periodic_pairs_in_native_context() {
        let mut plan = make_test_plan();
        plan.interfacial_dmi = Some(1.0e-3);
        plan.mesh.periodic_boundary_pairs = vec![MeshPeriodicBoundaryPairIR {
            pair_id: "x_periodic".to_string(),
            source_marker: Some("x_min".to_string()),
            destination_marker: Some("x_max".to_string()),
            marker_a: 1,
            marker_b: 2,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: None,
        }];
        plan.mesh.periodic_node_pairs = vec![MeshPeriodicNodePairIR {
            pair_id: "x_periodic".to_string(),
            node_a: 0,
            node_b: 1,
        }];

        let err = match NativeFemBackend::create(&plan) {
            Ok(_) => panic!("native FEM time-domain must reject unenforced periodic pairs"),
            Err(err) => err,
        };
        assert!(
            err.message.contains("periodic_node_pairs")
                && err
                    .message
                    .contains("exchange with optional uniform external field"),
            "unexpected periodic rejection message: {}",
            err.message
        );
    }

    #[test]
    fn native_fem_rejects_periodic_incompatible_per_node_material_class() {
        let mut plan = make_test_plan();
        plan.mesh.periodic_boundary_pairs = vec![MeshPeriodicBoundaryPairIR {
            pair_id: "x_periodic".to_string(),
            source_marker: Some("x_min".to_string()),
            destination_marker: Some("x_max".to_string()),
            marker_a: 1,
            marker_b: 2,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: None,
        }];
        plan.mesh.periodic_node_pairs = vec![MeshPeriodicNodePairIR {
            pair_id: "x_periodic".to_string(),
            node_a: 0,
            node_b: 1,
        }];
        plan.material.ms_field = Some(vec![800e3, 700e3, 800e3, 800e3]);

        let err = match NativeFemBackend::create(&plan) {
            Ok(_) => panic!("native FEM must reject incompatible periodic material classes"),
            Err(err) => err,
        };
        assert!(
            err.message.contains("Ms_field") && err.message.contains("periodic node class"),
            "unexpected material-class rejection message: {}",
            err.message
        );
    }

    fn make_exchange_only_plan() -> FemPlanIR {
        FemPlanIR {
            mesh_name: "two_tets".to_string(),
            mesh_source: Some("meshes/two_tets.msh".to_string()),
            mesh: MeshIR {
                mesh_name: "two_tets".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 1.0, 0.0],
                ],
                elements: vec![[0, 1, 2, 3], [1, 4, 2, 3]],
                element_markers: vec![1, 1],
                boundary_faces: vec![
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 4, 2],
                    [1, 4, 3],
                    [4, 2, 3],
                ],
                boundary_markers: vec![1; 6],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 1.0,
            initial_magnetization: vec![
                [1.0, 0.0, 0.0],
                [0.9992009587217894, 0.03996803834887158, 0.0],
                [0.996815278536125, 0.07974522228289, 0.0],
                [0.992876838486922, 0.11914522061843064, 0.0],
                [0.9874406319167053, 0.15799050110667284, 0.0],
            ],
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.1,
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
            external_field: Some([1.5e3, -2.0e3, 7.5e2]),
            current_modules: vec![],
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(2.5e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
            interfacial_dmi: None,
            dmi_interface_normal: None,
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
            use_consistent_mass: None,
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

    fn cpu_reference_single_step(
        plan: &FemPlanIR,
    ) -> (
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        fullmag_engine::StepReport,
    ) {
        let topology = MeshTopology::from_ir(&plan.mesh).expect("topology");
        let material = MaterialParameters::new(
            plan.material.saturation_magnetisation,
            plan.material.exchange_stiffness,
            plan.material.damping,
        )
        .expect("material");
        let dynamics =
            LlgConfig::new(plan.gyromagnetic_ratio, TimeIntegrator::Heun).expect("dynamics");
        let problem = FemLlgProblem::with_terms(
            topology,
            material,
            dynamics,
            EffectiveFieldTerms {
                exchange: plan.enable_exchange,
                demag: plan.enable_demag,
                external_field: plan.external_field,
                per_node_field: plan.oersted_field_xyz.as_ref().map(|field_xyz| {
                    field_xyz
                        .chunks_exact(3)
                        .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                        .collect()
                }),
                magnetoelastic: None,
                uniaxial_anisotropy: None,
                cubic_anisotropy: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                zhang_li_stt: if has_zhang_li_stt(plan) {
                    Some(fullmag_engine::ZhangLiSttConfig {
                        current_density: plan.current_density.expect("current density"),
                        spin_polarization: plan.stt_degree.expect("stt degree"),
                        non_adiabaticity: plan.stt_beta.unwrap_or(0.0),
                    })
                } else {
                    None
                },
                slonczewski_stt: if has_slonczewski_stt(plan) {
                    Some(fullmag_engine::SlonczewskiSttConfig {
                        current_density_magnitude: {
                            let j = plan.current_density.expect("current density");
                            (j[0] * j[0] + j[1] * j[1] + j[2] * j[2]).sqrt()
                        },
                        spin_polarization_axis: plan
                            .stt_spin_polarization
                            .expect("stt spin polarization"),
                        lambda: plan.stt_lambda.expect("stt lambda"),
                        epsilon_prime: plan.stt_epsilon_prime.unwrap_or(0.0),
                        degree: plan.stt_degree.expect("stt degree"),
                        thickness: plan
                            .stt_thickness
                            .unwrap_or_else(|| effective_magnetic_thickness(&plan.mesh)),
                        current_sign: match plan
                            .stt_fixed_layer_position
                            .as_deref()
                            .unwrap_or("top")
                        {
                            "bottom" => -1.0,
                            _ => 1.0,
                        },
                    })
                } else {
                    None
                },
                sot: None,
                oersted_cylinder: None,
            },
        );
        let mut state =
            FemLlgState::new(&problem.topology, plan.initial_magnetization.clone()).expect("state");
        let report = problem
            .step(&mut state, plan.fixed_timestep.expect("fixed dt"))
            .expect("cpu fem step");
        let observables = problem.observe(&state).expect("observe");
        (
            state.magnetization().to_vec(),
            observables.exchange_field,
            observables.effective_field,
            report,
        )
    }

    fn effective_magnetic_thickness(mesh: &MeshIR) -> f64 {
        let (min_z, max_z) = mesh.nodes.iter().fold(
            (f64::INFINITY, f64::NEG_INFINITY),
            |(min_z, max_z), node| (min_z.min(node[2]), max_z.max(node[2])),
        );
        (max_z - min_z).abs().max(1e-12)
    }

    #[test]
    fn native_fem_scaffold_exposes_initial_state_fields() {
        let plan = make_test_plan();
        let backend = match NativeFemBackend::create(&plan) {
            Ok(backend) => backend,
            Err(err) => {
                if !is_gpu_available() {
                    assert!(
                        err.message.contains("MFEM") || err.message.contains("scaffold"),
                        "unexpected unavailable create message: {}",
                        err.message
                    );
                    return;
                }
                if is_gpu_available() && err.message.contains("FDM backend") {
                    eprintln!("skipping native FEM demag bootstrap test: {}", err.message);
                    return;
                }
                panic!("native fem scaffold create: {}", err.message);
            }
        };

        let m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
        let h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");
        let h_demag = backend
            .copy_h_demag(plan.mesh.nodes.len())
            .expect("copy H_demag");
        let h_ext = backend
            .copy_h_ext(plan.mesh.nodes.len())
            .expect("copy H_ext");
        let h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy H_eff");
        let info = backend.device_info().expect("device info");

        assert_eq!(m, plan.initial_magnetization);
        assert!(h_ext.iter().all(|v| *v == [1.0, 2.0, 3.0]));
        if !is_gpu_available() {
            assert!(h_ex.iter().all(|v| *v == [0.0, 0.0, 0.0]));
            assert!(h_demag.iter().all(|v| *v == [0.0, 0.0, 0.0]));
            assert_eq!(h_eff, h_ext);
            assert!(
                info.name == "native_fem_scaffold" || info.name.starts_with("mfem_"),
                "unexpected device info name: {}",
                info.name
            );
        } else {
            for index in 0..h_eff.len() {
                for component in 0..3 {
                    assert_scalar_close(
                        &format!("H_eff init relation [{}][{}]", index, component),
                        h_eff[index][component],
                        h_ex[index][component]
                            + h_demag[index][component]
                            + h_ext[index][component],
                        5e-8,
                        1e-9,
                    );
                }
            }
            assert!(
                info.name.starts_with("mfem_")
                    || info.name.contains("NVIDIA")
                    || info.name.contains("GeForce")
                    || info.name.contains("RTX"),
                "unexpected native FEM device info name: {}",
                info.name
            );
        }
    }

    #[test]
    fn native_fem_scaffold_step_is_honestly_unavailable() {
        let plan = make_test_plan();
        let mut backend = match NativeFemBackend::create(&plan) {
            Ok(backend) => backend,
            Err(err) => {
                if !is_gpu_available() {
                    assert!(
                        err.message.contains("MFEM") || err.message.contains("scaffold"),
                        "unexpected unavailable create message: {}",
                        err.message
                    );
                    return;
                }
                if is_gpu_available() && err.message.contains("FDM backend") {
                    eprintln!(
                        "skipping native FEM demag bootstrap step test: {}",
                        err.message
                    );
                    return;
                }
                panic!("native fem scaffold create: {}", err.message);
            }
        };
        if !is_gpu_available() {
            let err = backend.step(1e-13).expect_err("step should be unavailable");
            assert!(
                err.message.contains("MFEM")
                    || err.message.contains("scaffold")
                    || err.message.contains("demag"),
                "unexpected unavailable message: {}",
                err.message
            );
        } else {
            backend.step(1e-13).expect("native fem step");
        }
    }

    #[test]
    fn native_fem_single_precision_rejection_is_cpu_specific() {
        let mut plan = make_exchange_only_plan();
        plan.precision = ExecutionPrecision::Single;
        plan.mfem_device_string = Some("cpu".to_string());

        let err = match NativeFemBackend::create(&plan) {
            Ok(_) => panic!("CPU single precision should fail"),
            Err(err) => err,
        };
        assert!(err.message.contains("CPU backend"));
        assert!(err.message.contains("double precision"));
    }

    #[test]
    fn native_fem_single_precision_rejection_is_gpu_specific() {
        let mut plan = make_exchange_only_plan();
        plan.precision = ExecutionPrecision::Single;
        plan.mfem_device_string = Some("cuda".to_string());

        let err = match NativeFemBackend::create(&plan) {
            Ok(_) => panic!("GPU single precision should fail"),
            Err(err) => err,
        };
        assert!(err.message.contains("GPU backend"));
        assert!(err.message.contains("single-precision CUDA kernels"));
    }

    #[test]
    fn native_fem_exchange_only_matches_cpu_reference_when_mfem_stack_is_available() {
        if !is_gpu_available() {
            eprintln!(
                "skipping native FEM parity test: backend was built without MFEM; rebuild with FULLMAG_USE_MFEM_STACK=ON on an MFEM host"
            );
            return;
        }

        let plan = make_exchange_only_plan();
        let (expected_m, expected_h_ex, expected_h_eff, expected_report) =
            cpu_reference_single_step(&plan);

        let mut backend = NativeFemBackend::create(&plan).expect("native fem create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native exchange-only fem step");
        let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");
        let actual_h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy H_eff");

        assert_vector_field_close("m", &actual_m, &expected_m, 5e-8, 1e-10);
        assert_vector_field_close("H_ex", &actual_h_ex, &expected_h_ex, 5e-8, 1e-6);
        assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-8, 1e-6);

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
            5e-8,
            1e-18,
        );
        assert_scalar_close(
            "external_energy_joules",
            stats.e_ext,
            expected_report.external_energy_joules,
            5e-8,
            1e-18,
        );
        assert_scalar_close(
            "total_energy_joules",
            stats.e_total,
            expected_report.total_energy_joules,
            5e-8,
            1e-18,
        );
        assert_scalar_close(
            "max_effective_field_amplitude",
            stats.max_h_eff,
            expected_report.max_effective_field_amplitude,
            5e-8,
            1e-9,
        );
        assert_scalar_close(
            "max_rhs_amplitude",
            stats.max_dm_dt,
            expected_report.max_rhs_amplitude,
            5e-8,
            1e-9,
        );
    }

    #[test]
    fn native_fem_periodic_exchange_only_matches_cpu_reference_when_mfem_stack_is_available() {
        if !is_gpu_available() {
            eprintln!(
                "skipping native FEM periodic parity test: backend was built without MFEM; rebuild with FULLMAG_USE_MFEM_STACK=ON on an MFEM host"
            );
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.mesh.periodic_boundary_pairs = vec![MeshPeriodicBoundaryPairIR {
            pair_id: "x_periodic".to_string(),
            source_marker: Some("x_min".to_string()),
            destination_marker: Some("x_max".to_string()),
            marker_a: 1,
            marker_b: 2,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: None,
        }];
        plan.mesh.periodic_node_pairs = vec![MeshPeriodicNodePairIR {
            pair_id: "x_periodic".to_string(),
            node_a: 0,
            node_b: 4,
        }];

        let (expected_m, expected_h_ex, expected_h_eff, expected_report) =
            cpu_reference_single_step(&plan);

        let mut backend = NativeFemBackend::create(&plan).expect("native periodic fem create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native periodic exchange-only fem step");
        let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");
        let actual_h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy H_eff");

        assert_vector_field_close("periodic m", &actual_m, &expected_m, 5e-8, 1e-10);
        assert_vector_field_close("periodic H_ex", &actual_h_ex, &expected_h_ex, 5e-8, 1e-6);
        assert_vector_field_close("periodic H_eff", &actual_h_eff, &expected_h_eff, 5e-8, 1e-6);
        assert_vector_field_close(
            "periodic pair m",
            &actual_m[0..3],
            &actual_m[12..15],
            1e-12,
            1e-12,
        );
        assert_vector_field_close(
            "periodic pair H_ex",
            &actual_h_ex[0..3],
            &actual_h_ex[12..15],
            1e-12,
            1e-6,
        );

        assert_scalar_close(
            "periodic time_seconds",
            stats.time,
            expected_report.time_seconds,
            1e-12,
            1e-18,
        );
        assert_scalar_close(
            "periodic exchange_energy_joules",
            stats.e_ex,
            expected_report.exchange_energy_joules,
            5e-8,
            1e-18,
        );
    }

    #[test]
    fn native_fem_periodic_consistent_mass_exchange_steps_when_mfem_stack_is_available() {
        if !is_gpu_available() {
            eprintln!(
                "skipping native FEM periodic consistent-mass test: backend was built without MFEM; rebuild with FULLMAG_USE_MFEM_STACK=ON on an MFEM host"
            );
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.use_consistent_mass = Some(true);
        plan.mesh.periodic_boundary_pairs = vec![MeshPeriodicBoundaryPairIR {
            pair_id: "x_periodic".to_string(),
            source_marker: Some("x_min".to_string()),
            destination_marker: Some("x_max".to_string()),
            marker_a: 1,
            marker_b: 2,
            translation: Some([1.0, 0.0, 0.0]),
            tolerance: Some(1e-12),
            axis_hint: Some("x".to_string()),
            orientation: None,
            pairing_policy: None,
        }];
        plan.mesh.periodic_node_pairs = vec![MeshPeriodicNodePairIR {
            pair_id: "x_periodic".to_string(),
            node_a: 0,
            node_b: 4,
        }];

        let mut backend =
            NativeFemBackend::create(&plan).expect("native periodic consistent fem create");
        let _stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native periodic consistent-mass exchange step");
        let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");

        assert_vector_field_close(
            "periodic consistent pair m",
            &actual_m[0..3],
            &actual_m[12..15],
            1e-12,
            1e-12,
        );
        assert_vector_field_close(
            "periodic consistent pair H_ex",
            &actual_h_ex[0..3],
            &actual_h_ex[12..15],
            1e-12,
            1e-6,
        );
    }

    #[test]
    fn native_fem_zhang_li_step_matches_cpu_reference_when_mfem_stack_is_available() {
        if !is_gpu_available() {
            eprintln!("skipping native FEM Zhang-Li parity test: MFEM stack unavailable");
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.current_density = Some([8.0e10, 0.0, 0.0]);
        plan.stt_degree = Some(0.55);
        plan.stt_beta = Some(0.08);

        let (expected_m, _, expected_h_eff, expected_report) = cpu_reference_single_step(&plan);
        let mut backend = NativeFemBackend::create(&plan).expect("native fem create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native zhang-li fem step");
        let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
        let actual_h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy H_eff");

        assert_vector_field_close("m", &actual_m, &expected_m, 5e-8, 1e-10);
        assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-8, 1e-6);
        assert_scalar_close(
            "max_rhs_amplitude",
            stats.max_dm_dt,
            expected_report.max_rhs_amplitude,
            5e-8,
            1e-9,
        );
    }

    #[test]
    fn native_fem_slonczewski_step_matches_cpu_reference_when_mfem_stack_is_available() {
        if !is_gpu_available() {
            eprintln!("skipping native FEM Slonczewski parity test: MFEM stack unavailable");
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.current_density = Some([0.0, 0.0, 1.4e11]);
        plan.stt_degree = Some(0.62);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.8);
        plan.stt_epsilon_prime = Some(0.03);

        let (expected_m, _, expected_h_eff, expected_report) = cpu_reference_single_step(&plan);
        let mut backend = NativeFemBackend::create(&plan).expect("native fem create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native slonczewski fem step");
        let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
        let actual_h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy H_eff");

        assert_vector_field_close("m", &actual_m, &expected_m, 5e-8, 1e-10);
        assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-8, 1e-6);
        assert_scalar_close(
            "max_rhs_amplitude",
            stats.max_dm_dt,
            expected_report.max_rhs_amplitude,
            5e-8,
            1e-9,
        );
    }
}
