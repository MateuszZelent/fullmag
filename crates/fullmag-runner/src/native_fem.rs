//! Safe Rust wrapper around the native MFEM/libCEED FEM backend scaffold.
//!
//! Current stage:
//! - stable C ABI and Rust wrapper
//! - availability probing
//! - native MFEM/libCEED/hypre time-domain FEM execution
//! - mesh-native Poisson demag on shared-domain meshes with air

#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;

#[cfg(feature = "fem-gpu")]
use crate::derived_fields::{compute_torque_field, max_torque_residual_apm_from_field};
#[cfg(feature = "fem-gpu")]
use crate::preview::{build_mesh_preview_field_with_active_mask, mesh_quantity_active_mask};
#[cfg(feature = "fem-gpu")]
use crate::quantities::{normalize_quantity_id, QuantityId};
#[cfg(feature = "fem-gpu")]
use crate::relaxation::llg_overdamped_uses_pure_damping;
#[cfg(feature = "fem-gpu")]
use crate::scalar_metrics::{single_object_scalars, weighted_object_scalars};
#[cfg(feature = "fem-gpu")]
use crate::types::{LivePreviewField, LivePreviewRequest, RunError, StepStats};
#[cfg(feature = "fem-gpu")]
use fullmag_ir::{StageCompletionIR, StageStopReason};

#[cfg(feature = "fem-gpu")]
use std::collections::BTreeSet;
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

#[cfg(feature = "fem-gpu")]
pub(crate) fn native_fem_precession_enabled(plan: &fullmag_ir::FemPlanIR) -> bool {
    !llg_overdamped_uses_pure_damping(plan.relaxation.as_ref())
}

pub(crate) fn is_gpu_available() -> bool {
    native_availability().native_fem_gpu_available
}

pub(crate) fn is_cpu_available() -> bool {
    native_availability().native_fem_cpu_available
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct GpuAvailability {
    pub available: bool,
    pub available_any: bool,
    pub available_cpu: bool,
    pub available_gpu: bool,
    pub built_with_mfem_stack: bool,
    pub built_with_cuda_runtime: bool,
    pub built_with_ceed: bool,
    pub native_fem_cpu_available: bool,
    pub native_fem_gpu_available: bool,
    pub native_fem_gpu_full_demag_available: bool,
    pub mfem_cuda_available: bool,
    pub hypre_gpu_available: bool,
    pub libceed_used_hot_path: bool,
    pub visible_cuda_device_count: i32,
    pub requested_gpu_index: i32,
    pub resolved_gpu_index: i32,
    pub memory_free_bytes: u64,
    pub memory_total_bytes: u64,
    pub reason: String,
    pub reason_cpu: String,
    pub reason_gpu: String,
}

pub(crate) fn native_availability() -> GpuAvailability {
    #[cfg(feature = "fem-gpu")]
    {
        let mut info = ffi::fullmag_fem_availability_info {
            available: 0,
            built_with_mfem_stack: 0,
            built_with_cuda_runtime: 0,
            built_with_ceed: 0,
            native_fem_cpu_available: 0,
            native_fem_gpu_available: 0,
            native_fem_gpu_full_demag_available: 0,
            mfem_cuda_available: 0,
            hypre_gpu_available: 0,
            libceed_used_hot_path: 0,
            visible_cuda_device_count: 0,
            requested_gpu_index: -1,
            resolved_gpu_index: -1,
            gpu_memory_free_bytes: 0,
            gpu_memory_total_bytes: 0,
            reason: [0; 256],
            available_any: 0,
            available_cpu: 0,
            available_gpu: 0,
            reason_cpu: [0; 256],
            reason_gpu: [0; 256],
        };
        let rc = unsafe { ffi::fullmag_fem_get_availability_info(&mut info) };
        if rc != ffi::FULLMAG_FEM_OK {
            return GpuAvailability {
                available: false,
                available_any: false,
                available_cpu: false,
                available_gpu: false,
                built_with_mfem_stack: false,
                built_with_cuda_runtime: false,
                built_with_ceed: false,
                native_fem_cpu_available: false,
                native_fem_gpu_available: false,
                native_fem_gpu_full_demag_available: false,
                mfem_cuda_available: false,
                hypre_gpu_available: false,
                libceed_used_hot_path: false,
                visible_cuda_device_count: 0,
                requested_gpu_index: -1,
                resolved_gpu_index: -1,
                memory_free_bytes: 0,
                memory_total_bytes: 0,
                reason: last_global_error_or(
                    "fullmag_fem_get_availability_info failed without an error message",
                ),
                reason_cpu: String::new(),
                reason_gpu: String::new(),
            };
        }

        let reason = unsafe { CStr::from_ptr(info.reason.as_ptr()) }
            .to_string_lossy()
            .to_string();
        let reason_cpu = unsafe { CStr::from_ptr(info.reason_cpu.as_ptr()) }
            .to_string_lossy()
            .to_string();
        let reason_gpu = unsafe { CStr::from_ptr(info.reason_gpu.as_ptr()) }
            .to_string_lossy()
            .to_string();

        GpuAvailability {
            available: info.available == 1,
            available_any: info.available_any == 1,
            available_cpu: info.available_cpu == 1,
            available_gpu: info.available_gpu == 1,
            built_with_mfem_stack: info.built_with_mfem_stack == 1,
            built_with_cuda_runtime: info.built_with_cuda_runtime == 1,
            built_with_ceed: info.built_with_ceed == 1,
            native_fem_cpu_available: info.native_fem_cpu_available == 1,
            native_fem_gpu_available: info.native_fem_gpu_available == 1,
            native_fem_gpu_full_demag_available: info.native_fem_gpu_full_demag_available == 1,
            mfem_cuda_available: info.mfem_cuda_available == 1,
            hypre_gpu_available: info.hypre_gpu_available == 1,
            libceed_used_hot_path: info.libceed_used_hot_path == 1,
            visible_cuda_device_count: info.visible_cuda_device_count,
            requested_gpu_index: info.requested_gpu_index,
            resolved_gpu_index: info.resolved_gpu_index,
            memory_free_bytes: info.gpu_memory_free_bytes,
            memory_total_bytes: info.gpu_memory_total_bytes,
            reason,
            reason_cpu,
            reason_gpu,
        }
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        GpuAvailability {
            available: false,
            available_any: false,
            available_cpu: false,
            available_gpu: false,
            built_with_mfem_stack: false,
            built_with_cuda_runtime: false,
            built_with_ceed: false,
            native_fem_cpu_available: false,
            native_fem_gpu_available: false,
            native_fem_gpu_full_demag_available: false,
            mfem_cuda_available: false,
            hypre_gpu_available: false,
            libceed_used_hot_path: false,
            visible_cuda_device_count: 0,
            requested_gpu_index: -1,
            resolved_gpu_index: -1,
            memory_free_bytes: 0,
            memory_total_bytes: 0,
            reason: "fullmag-runner was built without the fem-gpu feature".to_string(),
            reason_cpu: "fullmag-runner was built without the fem-gpu feature".to_string(),
            reason_gpu: "fullmag-runner was built without the fem-gpu feature".to_string(),
        }
    }
}

#[cfg(feature = "fem-gpu")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeFemDataResidency {
    HostSourceOfTruth,
    Mixed,
    DeviceSourceOfTruth,
}

#[cfg(feature = "fem-gpu")]
impl NativeFemDataResidency {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::HostSourceOfTruth => "host_source_of_truth",
            Self::Mixed => "mixed",
            Self::DeviceSourceOfTruth => "device_source_of_truth",
        }
    }

    fn from_ffi(value: ffi::fullmag_fem_data_residency) -> Self {
        match value {
            ffi::fullmag_fem_data_residency::FULLMAG_FEM_RESIDENCY_MIXED => Self::Mixed,
            ffi::fullmag_fem_data_residency::FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH => {
                Self::DeviceSourceOfTruth
            }
            ffi::fullmag_fem_data_residency::FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH => {
                Self::HostSourceOfTruth
            }
        }
    }
}

#[cfg(feature = "fem-gpu")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NativeFemGpuStateInfo {
    pub(crate) allocated: bool,
    pub(crate) node_count: u64,
    pub(crate) dof_len: u64,
    pub(crate) stage_count: u32,
    pub(crate) device_bytes: u64,
    pub(crate) reduction_workspace_bytes: u64,
    pub(crate) source_of_truth: NativeFemDataResidency,
}

#[cfg(feature = "fem-gpu")]
impl NativeFemGpuStateInfo {
    pub(crate) fn from_ffi(info: ffi::fullmag_fem_gpu_state_info) -> Self {
        Self {
            allocated: info.allocated != 0,
            node_count: info.node_count,
            dof_len: info.dof_len,
            stage_count: info.stage_count,
            device_bytes: info.device_bytes,
            reduction_workspace_bytes: info.reduction_workspace_bytes,
            source_of_truth: NativeFemDataResidency::from_ffi(info.source_of_truth),
        }
    }
}

#[cfg(feature = "fem-gpu")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeFemGpuRkPlanInfo {
    pub(crate) exchange_only_enabled: bool,
    pub(crate) stage_count: u32,
    pub(crate) uses_cuda_kernels: bool,
    pub(crate) allows_exchange_host_sync: bool,
    pub(crate) stage_exchange_device_resident: bool,
    pub(crate) uses_gpu_poisson: bool,
    pub(crate) exchange_operator_mode: String,
    pub(crate) demag_operator_mode: String,
    pub(crate) hypre_execution_policy: String,
    pub(crate) demag_residency: String,
    pub(crate) reason: String,
}

#[cfg(feature = "fem-gpu")]
impl NativeFemGpuRkPlanInfo {
    pub(crate) fn from_ffi(info: ffi::fullmag_fem_gpu_rk_plan_info) -> Self {
        let exchange_operator_mode =
            unsafe { CStr::from_ptr(info.exchange_operator_mode.as_ptr()) }
                .to_string_lossy()
                .to_string();
        let demag_operator_mode = unsafe { CStr::from_ptr(info.demag_operator_mode.as_ptr()) }
            .to_string_lossy()
            .to_string();
        let hypre_execution_policy =
            unsafe { CStr::from_ptr(info.hypre_execution_policy.as_ptr()) }
                .to_string_lossy()
                .to_string();
        let demag_residency = unsafe { CStr::from_ptr(info.demag_residency.as_ptr()) }
            .to_string_lossy()
            .to_string();
        let reason = unsafe { CStr::from_ptr(info.reason.as_ptr()) }
            .to_string_lossy()
            .to_string();
        Self {
            exchange_only_enabled: info.exchange_only_enabled != 0,
            stage_count: info.stage_count,
            uses_cuda_kernels: info.uses_cuda_kernels != 0,
            allows_exchange_host_sync: info.allows_exchange_host_sync != 0,
            stage_exchange_device_resident: info.stage_exchange_device_resident != 0,
            uses_gpu_poisson: info.uses_gpu_poisson != 0,
            exchange_operator_mode,
            demag_operator_mode,
            hypre_execution_policy,
            demag_residency,
            reason,
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
fn native_fem_gpu_demag_mode(plan: &fullmag_ir::FemPlanIR) -> i32 {
    if plan.mfem_device_string.as_deref() == Some("cpu") || !plan.enable_demag {
        return ffi::fullmag_fem_gpu_demag_mode::FULLMAG_FEM_GPU_DEMAG_UNSPECIFIED as i32;
    }
    match std::env::var("FULLMAG_FEM_GPU_DEMAG_MODE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("hybrid_cpu_poisson") | Some("hybrid") | Some("compat") => {
            ffi::fullmag_fem_gpu_demag_mode::FULLMAG_FEM_GPU_DEMAG_HYBRID_CPU_POISSON as i32
        }
        _ => ffi::fullmag_fem_gpu_demag_mode::FULLMAG_FEM_GPU_DEMAG_DEVICE_HYPRE_POISSON as i32,
    }
}

#[cfg(feature = "fem-gpu")]
pub(crate) struct NativeFemBackend {
    handle: *mut ffi::fullmag_fem_backend,
    magnetic_node_mask: Vec<bool>,
    object_weights: Vec<(String, f64)>,
    damping: f64,
}

#[cfg(feature = "fem-gpu")]
fn native_fem_segment_weight(
    plan: &fullmag_ir::FemPlanIR,
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> f64 {
    let explicit_count = plan
        .mesh_parts
        .iter()
        .find(|part| {
            part.role == fullmag_ir::FemMeshPartRole::MagneticObject
                && (part
                    .object_id
                    .as_deref()
                    .is_some_and(|id| native_fem_object_ids_match(id, &segment.object_id))
                    || part
                        .geometry_id
                        .as_deref()
                        .zip(segment.geometry_id.as_deref())
                        .is_some_and(|(part_geometry, segment_geometry)| {
                            native_fem_object_ids_match(part_geometry, segment_geometry)
                        })
                    || native_fem_object_ids_match(&part.id, &segment.object_id))
        })
        .map(|part| {
            part.node_indices
                .iter()
                .filter(|index| (**index as usize) < plan.mesh.nodes.len())
                .collect::<BTreeSet<_>>()
                .len()
        })
        .unwrap_or(0);
    if explicit_count > 0 {
        explicit_count as f64
    } else {
        f64::from(segment.node_count.max(1))
    }
}

#[cfg(feature = "fem-gpu")]
fn native_fem_object_ids_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let clean_a = a.strip_suffix("_geom").unwrap_or(a);
    let clean_b = b.strip_suffix("_geom").unwrap_or(b);
    clean_a == clean_b
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
        Self::create_with_initial_effective_field(plan, true)
    }

    pub fn create_with_initial_effective_field(
        plan: &fullmag_ir::FemPlanIR,
        eager_initial_effective_field: bool,
    ) -> Result<Self, RunError> {
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
        let periodic_boundary_pair_markers_flat: Vec<u32> = plan
            .mesh
            .periodic_boundary_pairs
            .iter()
            .flat_map(|p| [p.marker_a, p.marker_b])
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
            periodic_boundary_pair_markers: if periodic_boundary_pair_markers_flat.is_empty() {
                std::ptr::null()
            } else {
                periodic_boundary_pair_markers_flat.as_ptr()
            },
            periodic_boundary_pair_count: plan.mesh.periodic_boundary_pairs.len() as u32,
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
                    has_absolute_tolerance: if policy.atol.is_some() { 1 } else { 0 },
                    absolute_tolerance: policy.atol.unwrap_or(0.0),
                    max_iterations: policy.max_iterations,
                    print_level: policy.print_level,
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
                fullmag_ir::ResolvedFemDemagIR::FredkinKoehler => {
                    ffi::fullmag_fem_demag_realization::FULLMAG_FEM_DEMAG_FREDKIN_KOEHLER
                }
                fullmag_ir::ResolvedFemDemagIR::Bem | fullmag_ir::ResolvedFemDemagIR::Fmm => {
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
            gpu_demag_mode: native_fem_gpu_demag_mode(plan),
            // FND-013: pass consistent-mass flag.
            use_consistent_mass: if plan.use_consistent_mass.unwrap_or(false) {
                1
            } else {
                0
            },
            eager_initial_effective_field: if eager_initial_effective_field { 1 } else { 0 },
            has_precession_enabled: 1,
            precession_enabled: if native_fem_precession_enabled(plan) {
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
                    max_reject: 50,
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
            let availability = native_availability();
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
                    let weight = native_fem_segment_weight(plan, segment);
                    *weights.entry(segment.object_id.clone()).or_insert(0.0) += weight;
                }
                let collected = weights.into_iter().collect::<Vec<_>>();
                if collected.is_empty() {
                    vec![("free".to_string(), 1.0)]
                } else {
                    collected
                }
            },
            damping: plan.material.damping,
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

    fn transfer_audit(&self) -> Result<ffi::fullmag_fem_transfer_audit, RunError> {
        let mut audit = ffi::fullmag_fem_transfer_audit {
            h2d_bytes: 0,
            d2h_bytes: 0,
            host_read_count: 0,
            host_write_count: 0,
            host_read_write_count: 0,
            hot_loop_h2d_bytes: 0,
            hot_loop_d2h_bytes: 0,
            hot_loop_host_read_count: 0,
            hot_loop_host_write_count: 0,
            hot_loop_host_read_write_count: 0,
            hot_loop_host_sync_count: 0,
            hot_loop_exchange_h2d_bytes: 0,
            hot_loop_exchange_d2h_bytes: 0,
            hot_loop_exchange_host_sync_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
        };
        let rc = unsafe { ffi::fullmag_fem_backend_get_transfer_audit(self.handle, &mut audit) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU transfer audit read failed"));
        }
        Ok(audit)
    }

    pub(crate) fn gpu_state_info(&self) -> Result<NativeFemGpuStateInfo, RunError> {
        let mut info = ffi::fullmag_fem_gpu_state_info {
            allocated: 0,
            node_count: 0,
            dof_len: 0,
            stage_count: 0,
            device_bytes: 0,
            reduction_workspace_bytes: 0,
            source_of_truth:
                ffi::fullmag_fem_data_residency::FULLMAG_FEM_RESIDENCY_HOST_SOURCE_OF_TRUTH,
        };
        let rc = unsafe { ffi::fullmag_fem_backend_get_gpu_state_info(self.handle, &mut info) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU state info read failed"));
        }
        Ok(NativeFemGpuStateInfo::from_ffi(info))
    }

    pub(crate) fn gpu_rk_plan_info(&self) -> Result<NativeFemGpuRkPlanInfo, RunError> {
        let mut info = ffi::fullmag_fem_gpu_rk_plan_info {
            exchange_only_enabled: 0,
            stage_count: 0,
            uses_cuda_kernels: 0,
            allows_exchange_host_sync: 0,
            stage_exchange_device_resident: 0,
            uses_gpu_poisson: 0,
            exchange_operator_mode: [0; 64],
            demag_operator_mode: [0; 64],
            hypre_execution_policy: [0; 32],
            demag_residency: [0; 32],
            reason: [0; 256],
        };
        let rc = unsafe { ffi::fullmag_fem_backend_get_gpu_rk_plan_info(self.handle, &mut info) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU RK plan info read failed"));
        }
        Ok(NativeFemGpuRkPlanInfo::from_ffi(info))
    }

    fn attach_transfer_audit(&self, stats: &mut StepStats) -> Result<(), RunError> {
        let audit = self.transfer_audit()?;
        stats.hot_loop_h2d_bytes = audit.hot_loop_h2d_bytes;
        stats.hot_loop_d2h_bytes = audit.hot_loop_d2h_bytes;
        stats.hot_loop_host_read_count = audit.hot_loop_host_read_count;
        stats.hot_loop_host_write_count = audit.hot_loop_host_write_count;
        stats.hot_loop_host_sync_count = audit.hot_loop_host_sync_count;
        stats.hot_loop_exchange_h2d_bytes = audit.hot_loop_exchange_h2d_bytes;
        stats.hot_loop_exchange_d2h_bytes = audit.hot_loop_exchange_d2h_bytes;
        stats.hot_loop_exchange_host_sync_count = audit.hot_loop_exchange_host_sync_count;
        stats.hot_loop_compute_h2d_bytes = audit.hot_loop_compute_h2d_bytes;
        stats.hot_loop_compute_d2h_bytes = audit.hot_loop_compute_d2h_bytes;
        stats.hot_loop_compute_host_sync_count = audit.hot_loop_compute_host_sync_count;
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
            mx: 0.0,
            my: 0.0,
            mz: 0.0,
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
            demag_solve_count: 0,
            demag_linear_iterations: 0,
            demag_linear_residual: 0.0,
            wall_time_ns: 0,
            exchange_wall_time_ns: 0,
            demag_wall_time_ns: 0,
            demag_assemble_wall_time_ns: 0,
            demag_solve_wall_time_ns: 0,
            demag_solver_setup_wall_time_ns: 0,
            demag_solver_apply_wall_time_ns: 0,
            demag_solver_setup_reused: 0,
            demag_recover_wall_time_ns: 0,
            demag_energy_wall_time_ns: 0,
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

        let torque_apm = if stats.max_torque_Apm.is_finite() && stats.max_torque_Apm >= 0.0 {
            stats.max_torque_Apm
        } else {
            0.0
        };
        let mut step_stats = StepStats {
            step: stats.step,
            time: stats.time_seconds,
            dt: stats.dt_seconds,
            mx: stats.mx,
            my: stats.my,
            mz: stats.mz,
            e_ex: stats.exchange_energy_joules,
            e_demag: stats.demag_energy_joules,
            e_ext: stats.external_energy_joules,
            e_ani: stats.anisotropy_energy_joules,
            e_dmi: stats.dmi_energy_joules,
            e_total: stats.total_energy_joules,
            max_dm_dt: stats.max_rhs_amplitude,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            max_torque_Apm: torque_apm,
            max_torque_T: torque_apm * crate::MU0,
            wall_time_ns: stats.wall_time_ns,
            exchange_wall_time_ns: stats.exchange_wall_time_ns,
            demag_wall_time_ns: stats.demag_wall_time_ns,
            demag_assemble_wall_time_ns: stats.demag_assemble_wall_time_ns,
            demag_solve_wall_time_ns: stats.demag_solve_wall_time_ns,
            demag_solver_setup_wall_time_ns: stats.demag_solver_setup_wall_time_ns,
            demag_solver_apply_wall_time_ns: stats.demag_solver_apply_wall_time_ns,
            demag_solver_setup_reused: stats.demag_solver_setup_reused != 0,
            demag_recover_wall_time_ns: stats.demag_recover_wall_time_ns,
            demag_energy_wall_time_ns: stats.demag_energy_wall_time_ns,
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
            demag_solves: stats.demag_solve_count,
            poisson_iterations: stats.demag_linear_iterations,
            poisson_final_residual: stats.demag_linear_residual,
            demag_refreshed: stats.demag_solve_count > 0,
            requested_fem_omp_threads: stats.requested_omp_threads,
            effective_fem_omp_threads: stats.effective_omp_threads,
            ..StepStats::default()
        };
        self.attach_transfer_audit(&mut step_stats)?;
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
            mx: 0.0,
            my: 0.0,
            mz: 0.0,
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
            demag_solve_count: 0,
            demag_linear_iterations: 0,
            demag_linear_residual: 0.0,
            wall_time_ns: 0,
            exchange_wall_time_ns: 0,
            demag_wall_time_ns: 0,
            demag_assemble_wall_time_ns: 0,
            demag_solve_wall_time_ns: 0,
            demag_solver_setup_wall_time_ns: 0,
            demag_solver_apply_wall_time_ns: 0,
            demag_solver_setup_reused: 0,
            demag_recover_wall_time_ns: 0,
            demag_energy_wall_time_ns: 0,
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
        let effective_field = self.copy_h_eff(node_count)?;
        let torque_apm = max_torque_residual_apm_from_field(&magnetization, &effective_field);
        let mut step_stats = StepStats {
            step: stats.step,
            time: stats.time_seconds,
            dt: stats.dt_seconds,
            mx: stats.mx,
            my: stats.my,
            mz: stats.mz,
            e_ex: stats.exchange_energy_joules,
            e_demag: stats.demag_energy_joules,
            e_ext: stats.external_energy_joules,
            e_ani: stats.anisotropy_energy_joules,
            e_dmi: stats.dmi_energy_joules,
            e_total: stats.total_energy_joules,
            max_dm_dt: stats.max_rhs_amplitude,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            max_torque_Apm: torque_apm,
            max_torque_T: torque_apm * crate::MU0,
            wall_time_ns: stats.wall_time_ns,
            exchange_wall_time_ns: stats.exchange_wall_time_ns,
            demag_wall_time_ns: stats.demag_wall_time_ns,
            demag_assemble_wall_time_ns: stats.demag_assemble_wall_time_ns,
            demag_solve_wall_time_ns: stats.demag_solve_wall_time_ns,
            demag_solver_setup_wall_time_ns: stats.demag_solver_setup_wall_time_ns,
            demag_solver_apply_wall_time_ns: stats.demag_solver_apply_wall_time_ns,
            demag_solver_setup_reused: stats.demag_solver_setup_reused != 0,
            demag_recover_wall_time_ns: stats.demag_recover_wall_time_ns,
            demag_energy_wall_time_ns: stats.demag_energy_wall_time_ns,
            rhs_wall_time_ns: stats.rhs_wall_time_ns,
            extra_energy_wall_time_ns: stats.extra_energy_wall_time_ns,
            snapshot_wall_time_ns: stats.snapshot_wall_time_ns,
            demag_solves: stats.demag_solve_count,
            poisson_iterations: stats.demag_linear_iterations,
            poisson_final_residual: stats.demag_linear_residual,
            demag_refreshed: stats.demag_solve_count > 0,
            requested_fem_omp_threads: stats.requested_omp_threads,
            effective_fem_omp_threads: stats.effective_omp_threads,
            ..StepStats::default()
        };
        self.attach_transfer_audit(&mut step_stats)?;
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

    pub fn copy_torque(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        let magnetization = self.copy_m(node_count)?;
        let effective_field = self.copy_h_eff(node_count)?;
        Ok(compute_torque_field(
            &magnetization,
            &effective_field,
            self.damping,
            true,
        ))
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
            QuantityId::Torque => self.copy_torque(node_count)?,
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
            gpu_memory_free_bytes: 0,
            gpu_memory_total_bytes: 0,
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
            memory_free_bytes: info.gpu_memory_free_bytes,
            memory_total_bytes: info.gpu_memory_total_bytes,
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
    pub memory_free_bytes: u64,
    pub memory_total_bytes: u64,
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
        AdaptiveTimeStepIR, AirBoxConfigIR, ExchangeBoundaryCondition, ExecutionPrecision,
        FemPlanIR, IntegratorChoice, MaterialIR, MeshIR, MeshPeriodicBoundaryPairIR,
        MeshPeriodicNodePairIR, RelaxStopIR, RelaxationAlgorithmIR, RelaxationControlIR,
        ResolvedFemDemagIR,
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
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
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
            mechanics: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            use_consistent_mass: None,
        }
    }

    #[test]
    fn native_fem_disables_precession_for_llg_overdamped_relaxation() {
        let mut plan = make_test_plan();
        assert!(native_fem_precession_enabled(&plan));

        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::LlgOverdamped,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        });
        assert!(!native_fem_precession_enabled(&plan));

        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: None,
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        });
        assert!(native_fem_precession_enabled(&plan));
    }

    #[test]
    fn native_fem_ffi_plan_carries_precession_mode() {
        let source = include_str!("native_fem.rs");
        let plan_desc_start = source
            .find("let mut plan_desc = ffi::fullmag_fem_plan_desc")
            .expect("native FEM FFI plan desc literal");
        let plan_desc_body = &source[plan_desc_start..];
        let plan_desc_end = plan_desc_body
            .find("        // Build adaptive config if present")
            .expect("native FEM FFI plan desc end");
        let plan_desc_body = &plan_desc_body[..plan_desc_end];
        assert!(
            plan_desc_body.contains("has_precession_enabled: 1"),
            "native FEM FFI plan must explicitly set the precession mode field"
        );
        assert!(
            plan_desc_body.contains("precession_enabled: if native_fem_precession_enabled(plan)"),
            "native FEM FFI plan must lower llg_overdamped into the native precession flag"
        );
    }

    #[test]
    fn native_fem_accepts_periodic_dmi_pairs_in_native_context() {
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

        if let Err(err) = NativeFemBackend::create(&plan) {
            if !is_gpu_available()
                && (err.message.contains("MFEM") || err.message.contains("scaffold"))
            {
                return;
            }
            panic!(
                "native FEM time-domain should accept periodic DMI pairs with class projection: {}",
                err.message
            );
        }
    }

    #[test]
    fn native_fem_cpu_dmi_step_exposes_fields_and_energy_when_mfem_stack_is_available() {
        let mut plan = make_test_plan();
        plan.mfem_device_string = Some("cpu".to_string());
        plan.initial_magnetization = vec![
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
        ];
        plan.interfacial_dmi = Some(1.0e-3);
        plan.dmi_interface_normal = Some([0.0, 0.0, 1.0]);
        plan.bulk_dmi = Some(2.0e-3);

        let mut backend = match NativeFemBackend::create(&plan) {
            Ok(backend) => backend,
            Err(err) => {
                if err.message.contains("MFEM") || err.message.contains("scaffold") {
                    eprintln!("skipping native FEM CPU DMI runtime test: {}", err.message);
                    return;
                }
                panic!("native FEM CPU DMI create: {}", err.message);
            }
        };

        let stats = backend.step(1e-13).expect("native FEM CPU DMI step");
        assert!(stats.e_dmi.is_finite(), "DMI energy must be finite");
        assert!(
            stats.e_dmi.abs() > 0.0,
            "non-uniform magnetization with active DMI should report non-zero DMI energy"
        );

        let h_dmi = backend
            .copy_h_dmi(plan.mesh.nodes.len())
            .expect("copy interfacial DMI field");
        let h_bulk_dmi = backend
            .copy_h_dmi_bulk(plan.mesh.nodes.len())
            .expect("copy bulk DMI field");
        assert!(
            h_dmi
                .iter()
                .flatten()
                .any(|component| component.abs() > 0.0),
            "active interfacial DMI should expose a non-zero H_dmi field"
        );
        assert!(
            h_bulk_dmi
                .iter()
                .flatten()
                .any(|component| component.abs() > 0.0),
            "active bulk DMI should expose a non-zero H_dmi_bulk field"
        );
    }

    #[test]
    fn native_fem_gpu_dmi_step_exposes_fields_and_energy_when_cuda_is_available() {
        if !is_gpu_available() {
            eprintln!(
                "skipping native FEM GPU DMI runtime test: CUDA/MFEM GPU runtime unavailable"
            );
            return;
        }

        let mut plan = make_test_plan();
        plan.mfem_device_string = Some("cuda".to_string());
        plan.initial_magnetization = vec![
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
        ];
        plan.interfacial_dmi = Some(1.0e-3);
        plan.dmi_interface_normal = Some([0.0, 0.0, 1.0]);
        plan.bulk_dmi = Some(2.0e-3);

        let mut backend = NativeFemBackend::create(&plan).expect("native FEM GPU DMI create");
        let stats = backend.step(1e-13).expect("native FEM GPU DMI step");
        assert!(stats.e_dmi.is_finite(), "GPU DMI energy must be finite");
        assert!(
            stats.e_dmi.abs() > 0.0,
            "non-uniform magnetization with active GPU DMI should report non-zero DMI energy"
        );

        let h_dmi = backend
            .copy_h_dmi(plan.mesh.nodes.len())
            .expect("copy GPU interfacial DMI field");
        let h_bulk_dmi = backend
            .copy_h_dmi_bulk(plan.mesh.nodes.len())
            .expect("copy GPU bulk DMI field");
        assert!(
            h_dmi
                .iter()
                .flatten()
                .any(|component| component.abs() > 0.0),
            "active GPU interfacial DMI should expose a non-zero H_dmi field"
        );
        assert!(
            h_bulk_dmi
                .iter()
                .flatten()
                .any(|component| component.abs() > 0.0),
            "active GPU bulk DMI should expose a non-zero H_dmi_bulk field"
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

    #[test]
    fn native_fem_accepts_fredkin_koehler_demag_at_runner_boundary() {
        let mut plan = make_test_plan();
        plan.enable_exchange = false;
        plan.enable_demag = true;
        plan.mfem_device_string = Some("cpu".to_string());
        plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::FredkinKoehler);
        plan.air_box_config = None;
        plan.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh;
        plan.mesh.boundary_faces = vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
        plan.mesh.boundary_markers = vec![1, 1, 1, 1];

        if let Err(err) = NativeFemBackend::create_with_initial_effective_field(&plan, false) {
            assert!(
                !err.message.contains("not yet implemented")
                    && !err.message.contains("air-box demag requires"),
                "runner must route Fredkin-Koehler demag to the native FEM/BEM backend, got: {}",
                err.message
            );
            if !is_gpu_available()
                && (err.message.contains("MFEM") || err.message.contains("scaffold"))
            {
                return;
            }
            panic!(
                "unexpected native FEM Fredkin-Koehler create error: {}",
                err.message
            );
        }
    }

    #[test]
    fn gpu_state_info_maps_residency_and_allocation_from_ffi() {
        let info = NativeFemGpuStateInfo::from_ffi(ffi::fullmag_fem_gpu_state_info {
            allocated: 1,
            node_count: 4,
            dof_len: 12,
            stage_count: 2,
            device_bytes: 8192,
            reduction_workspace_bytes: 64,
            source_of_truth:
                ffi::fullmag_fem_data_residency::FULLMAG_FEM_RESIDENCY_DEVICE_SOURCE_OF_TRUTH,
        });

        assert!(info.allocated);
        assert_eq!(info.node_count, 4);
        assert_eq!(info.dof_len, 12);
        assert_eq!(info.stage_count, 2);
        assert_eq!(info.device_bytes, 8192);
        assert_eq!(info.reduction_workspace_bytes, 64);
        assert_eq!(info.source_of_truth.as_str(), "device_source_of_truth");
    }

    #[test]
    fn gpu_rk_plan_info_maps_exchange_only_gate_from_ffi() {
        let mut reason = [0; 256];
        let raw = b"requires CUDA\0";
        for (dst, src) in reason.iter_mut().zip(raw.iter().copied()) {
            *dst = src as std::os::raw::c_char;
        }
        let mut exchange_operator_mode = [0; 64];
        let raw_mode = b"unsupported\0";
        for (dst, src) in exchange_operator_mode
            .iter_mut()
            .zip(raw_mode.iter().copied())
        {
            *dst = src as std::os::raw::c_char;
        }
        let mut demag_operator_mode = [0; 64];
        let raw_demag = b"device_hypre_poisson\0";
        for (dst, src) in demag_operator_mode
            .iter_mut()
            .zip(raw_demag.iter().copied())
        {
            *dst = src as std::os::raw::c_char;
        }
        let mut hypre_execution_policy = [0; 32];
        let raw_policy = b"device\0";
        for (dst, src) in hypre_execution_policy
            .iter_mut()
            .zip(raw_policy.iter().copied())
        {
            *dst = src as std::os::raw::c_char;
        }
        let mut demag_residency = [0; 32];
        let raw_residency = b"device\0";
        for (dst, src) in demag_residency
            .iter_mut()
            .zip(raw_residency.iter().copied())
        {
            *dst = src as std::os::raw::c_char;
        }

        let info = NativeFemGpuRkPlanInfo::from_ffi(ffi::fullmag_fem_gpu_rk_plan_info {
            exchange_only_enabled: 1,
            stage_count: 4,
            uses_cuda_kernels: 1,
            allows_exchange_host_sync: 1,
            stage_exchange_device_resident: 0,
            uses_gpu_poisson: 1,
            exchange_operator_mode,
            demag_operator_mode,
            hypre_execution_policy,
            demag_residency,
            reason,
        });

        assert!(info.exchange_only_enabled);
        assert_eq!(info.stage_count, 4);
        assert!(info.uses_cuda_kernels);
        assert!(info.allows_exchange_host_sync);
        assert!(!info.stage_exchange_device_resident);
        assert!(info.uses_gpu_poisson);
        assert_eq!(info.exchange_operator_mode, "unsupported");
        assert_eq!(info.demag_operator_mode, "device_hypre_poisson");
        assert_eq!(info.hypre_execution_policy, "device");
        assert_eq!(info.demag_residency, "device");
        assert_eq!(info.reason, "requires CUDA");
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
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
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
            mechanics: None,
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

    fn vector_field_error_norms(actual: &[[f64; 3]], expected: &[[f64; 3]]) -> (f64, f64) {
        assert_eq!(actual.len(), expected.len(), "field length mismatch");
        let mut sum_sq = 0.0;
        let mut linf = 0.0;
        for (a, e) in actual.iter().zip(expected.iter()) {
            for component in 0..3 {
                let diff = (a[component] - e[component]).abs();
                sum_sq += diff * diff;
                if diff > linf {
                    linf = diff;
                }
            }
        }
        (sum_sq.sqrt(), linf)
    }

    fn assert_vector_field_parity(
        label: &str,
        cpu: &[[f64; 3]],
        gpu: &[[f64; 3]],
        rel_tol: f64,
        abs_tol: f64,
    ) {
        let (l2, linf) = vector_field_error_norms(gpu, cpu);
        assert_vector_field_close(label, gpu, cpu, rel_tol, abs_tol);
        eprintln!("{label} CPU/GPU parity: L2={l2:.6e} Linf={linf:.6e}");
    }

    fn native_cpu_gpu_parity_available(require_full_demag: bool) -> bool {
        let availability = native_availability();
        let available = availability.native_fem_cpu_available
            && availability.native_fem_gpu_available
            && (!require_full_demag || availability.native_fem_gpu_full_demag_available);
        if !available {
            eprintln!(
                "skipping native FEM CPU/GPU parity test: cpu={} gpu={} full_demag={} mfem_stack={} cuda_runtime={}",
                availability.native_fem_cpu_available,
                availability.native_fem_gpu_available,
                availability.native_fem_gpu_full_demag_available,
                availability.built_with_mfem_stack,
                availability.built_with_cuda_runtime
            );
        }
        available
    }

    fn native_plan_for_device(plan: &FemPlanIR, device: &str) -> FemPlanIR {
        let mut copy = plan.clone();
        copy.mfem_device_string = Some(device.to_string());
        copy
    }

    struct NativeParityStep {
        m: Vec<[f64; 3]>,
        h_ex: Vec<[f64; 3]>,
        h_demag: Vec<[f64; 3]>,
        h_eff: Vec<[f64; 3]>,
        stats: StepStats,
        device_name: String,
    }

    fn run_native_parity_step(plan: &FemPlanIR) -> NativeParityStep {
        let mut backend = NativeFemBackend::create(plan).expect("native fem parity create");
        let stats = backend
            .step(
                crate::resolve_initial_timestep(
                    plan.fixed_timestep,
                    plan.adaptive_timestep.as_ref(),
                )
                .expect("parity plan timestep"),
            )
            .expect("native fem parity step");
        let node_count = plan.mesh.nodes.len();
        let device_name = backend.device_info().expect("device info").name;
        NativeParityStep {
            m: backend.copy_m(node_count).expect("copy m"),
            h_ex: backend.copy_h_ex(node_count).expect("copy H_ex"),
            h_demag: backend.copy_h_demag(node_count).expect("copy H_demag"),
            h_eff: backend.copy_h_eff(node_count).expect("copy H_eff"),
            stats,
            device_name,
        }
    }

    fn assert_same_parity_mesh(cpu_plan: &FemPlanIR, gpu_plan: &FemPlanIR) {
        assert_eq!(cpu_plan.mesh.mesh_name, gpu_plan.mesh.mesh_name);
        assert_eq!(cpu_plan.mesh.nodes, gpu_plan.mesh.nodes);
        assert_eq!(cpu_plan.mesh.elements, gpu_plan.mesh.elements);
        assert_eq!(cpu_plan.precision, ExecutionPrecision::Double);
        assert_eq!(gpu_plan.precision, ExecutionPrecision::Double);
    }

    fn with_poisson_demag(mut plan: FemPlanIR) -> FemPlanIR {
        plan.enable_demag = true;
        plan.demag_realization = Some(ResolvedFemDemagIR::PoissonRobin);
        plan.air_box_config = Some(AirBoxConfigIR {
            factor: 1.5,
            grading: 1.0,
            boundary_marker: 99,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("legacy".to_string()),
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("parity_fixture".to_string()),
            boundary_marker_source: Some("parity_fixture".to_string()),
        });
        plan
    }

    fn with_adaptive_dt(mut plan: FemPlanIR) -> FemPlanIR {
        plan.fixed_timestep = None;
        plan.adaptive_timestep = Some(AdaptiveTimeStepIR {
            atol: 1e-8,
            rtol: 1e-5,
            dt_initial: Some(2.5e-13),
            dt_min: 1e-16,
            dt_max: Some(1e-12),
            safety: 0.9,
            growth_limit: 2.0,
            shrink_limit: 0.5,
            max_spin_rotation: None,
            norm_tolerance: None,
        });
        plan
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
        assert!(err.message.contains("CPU FEM backend"));
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
        assert_eq!(stats.rhs_evals, 3);
        assert_eq!(stats.demag_solves, 0);
        assert!(!stats.demag_refreshed);
    }

    #[test]
    fn native_fem_cpu_gpu_exchange_h_eff_and_rhs_parity_when_available() {
        if !native_cpu_gpu_parity_available(false) {
            return;
        }

        for pure_damping in [false, true] {
            let mut plan = make_exchange_only_plan();
            if pure_damping {
                plan.relaxation = Some(RelaxationControlIR {
                    algorithm: RelaxationAlgorithmIR::LlgOverdamped,
                    stop: RelaxStopIR {
                        torque_tolerance_apm: None,
                        energy_tolerance_j: None,
                        max_steps: None,
                        max_pseudotime_s: None,
                        max_physical_time_s: None,
                    },
                });
            }
            let cpu_plan = native_plan_for_device(&plan, "cpu");
            let gpu_plan = native_plan_for_device(&plan, "cuda");
            assert_same_parity_mesh(&cpu_plan, &gpu_plan);

            let cpu = run_native_parity_step(&cpu_plan);
            let gpu = run_native_parity_step(&gpu_plan);
            assert!(
                cpu.device_name.contains("cpu") || cpu.device_name.contains("mfem"),
                "CPU parity provenance device was {}",
                cpu.device_name
            );
            assert!(
                gpu.device_name.contains("cuda")
                    || gpu.device_name.contains("NVIDIA")
                    || gpu.device_name.contains("GeForce")
                    || gpu.device_name.contains("RTX"),
                "GPU parity provenance device was {}",
                gpu.device_name
            );

            let mode = if pure_damping {
                "pure_damping"
            } else {
                "precessional"
            };
            assert_vector_field_parity(&format!("{mode}.H_ex"), &cpu.h_ex, &gpu.h_ex, 5e-8, 1e-6);
            assert_vector_field_parity(
                &format!("{mode}.H_eff"),
                &cpu.h_eff,
                &gpu.h_eff,
                5e-8,
                1e-6,
            );
            assert_vector_field_parity(&format!("{mode}.m"), &cpu.m, &gpu.m, 5e-8, 1e-10);
            assert_scalar_close(
                &format!("{mode}.max_rhs_amplitude"),
                gpu.stats.max_dm_dt,
                cpu.stats.max_dm_dt,
                5e-8,
                1e-9,
            );
        }
    }

    #[test]
    fn native_fem_cpu_gpu_demag_parity_when_full_gpu_demag_is_available() {
        if !native_cpu_gpu_parity_available(true) {
            return;
        }

        let plan = with_poisson_demag(make_exchange_only_plan());
        let cpu_plan = native_plan_for_device(&plan, "cpu");
        let gpu_plan = native_plan_for_device(&plan, "cuda");
        assert_same_parity_mesh(&cpu_plan, &gpu_plan);

        let cpu = run_native_parity_step(&cpu_plan);
        let gpu = run_native_parity_step(&gpu_plan);
        assert_vector_field_parity("demag.H_demag", &cpu.h_demag, &gpu.h_demag, 5e-8, 1e-6);
        assert_vector_field_parity("demag.H_eff", &cpu.h_eff, &gpu.h_eff, 5e-8, 1e-6);
        assert_scalar_close(
            "demag_energy_joules",
            gpu.stats.e_demag,
            cpu.stats.e_demag,
            5e-8,
            1e-18,
        );
        assert!(
            gpu.stats.demag_solves > 0,
            "GPU demag parity fixture must exercise the Poisson solve"
        );
    }

    #[test]
    fn native_fem_cpu_gpu_integrator_parity_when_available() {
        if !native_cpu_gpu_parity_available(false) {
            return;
        }

        for integrator in [
            IntegratorChoice::Heun,
            IntegratorChoice::Rk4,
            IntegratorChoice::Rk23,
            IntegratorChoice::Rk45,
        ] {
            let mut plan = make_exchange_only_plan();
            plan.integrator = integrator;
            if matches!(integrator, IntegratorChoice::Rk23 | IntegratorChoice::Rk45) {
                plan = with_adaptive_dt(plan);
            }
            let cpu_plan = native_plan_for_device(&plan, "cpu");
            let gpu_plan = native_plan_for_device(&plan, "cuda");
            assert_same_parity_mesh(&cpu_plan, &gpu_plan);

            let cpu = run_native_parity_step(&cpu_plan);
            let gpu = run_native_parity_step(&gpu_plan);
            assert_vector_field_parity(&format!("{integrator:?}.m"), &cpu.m, &gpu.m, 5e-8, 1e-10);
            assert_vector_field_parity(
                &format!("{integrator:?}.H_eff"),
                &cpu.h_eff,
                &gpu.h_eff,
                5e-8,
                1e-6,
            );
            assert_eq!(
                gpu.stats.rhs_evals, cpu.stats.rhs_evals,
                "RHS evaluation count mismatch for {integrator:?}"
            );
        }
    }

    #[test]
    fn native_fem_explicit_rk_reports_real_rhs_cost_when_mfem_stack_is_available() {
        if !is_gpu_available() {
            eprintln!(
                "skipping native FEM RK cost test: backend was built without MFEM; rebuild with FULLMAG_USE_MFEM_STACK=ON on an MFEM host"
            );
            return;
        }

        let cases = [
            (IntegratorChoice::Heun, 3, 3, false),
            (IntegratorChoice::Rk4, 5, 5, false),
            (IntegratorChoice::Rk23, 4, 3, true),
            (IntegratorChoice::Rk45, 7, 6, true),
        ];

        for (integrator, expected_first_rhs, expected_second_rhs, expected_second_fsal) in cases {
            let mut plan = make_exchange_only_plan();
            plan.integrator = integrator;
            let mut backend = NativeFemBackend::create(&plan).expect("native fem create");

            let first = backend
                .step(plan.fixed_timestep.expect("fixed dt"))
                .expect("first native FEM RK step");
            assert_eq!(
                first.rhs_evals, expected_first_rhs,
                "unexpected first-step RHS count for {:?}",
                integrator
            );
            assert_eq!(
                first.demag_solves, 0,
                "exchange-only should not solve demag"
            );
            assert!(
                !first.demag_refreshed,
                "exchange-only should not refresh demag"
            );

            let second = backend
                .step(plan.fixed_timestep.expect("fixed dt"))
                .expect("second native FEM RK step");
            assert_eq!(
                second.rhs_evals, expected_second_rhs,
                "unexpected second-step RHS count for {:?}",
                integrator
            );
            assert_eq!(
                second.fsal_reused, expected_second_fsal,
                "unexpected FSAL reuse for {:?}",
                integrator
            );
            assert_eq!(
                second.demag_solves, 0,
                "exchange-only should not solve demag"
            );
            assert!(
                !second.demag_refreshed,
                "exchange-only should not refresh demag"
            );
        }
    }

    #[test]
    fn native_fem_poisson_rhs_hot_path_reuses_workspace() {
        let source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let coeff_start = source
            .find("class MagnetizationCoefficient")
            .expect("MagnetizationCoefficient definition");
        let coeff_rest = &source[coeff_start..];
        let coeff_end = coeff_rest
            .find("\nstruct PoissonRhsWorkspace")
            .expect("MagnetizationCoefficient end marker");
        let coeff_body = &coeff_rest[..coeff_end];
        let start = source
            .find("bool assemble_poisson_rhs(")
            .expect("assemble_poisson_rhs definition");
        let rest = &source[start..];
        let end = rest
            .find("\nvoid zero_poisson_essential_values")
            .expect("assemble_poisson_rhs end marker");
        let body = &rest[..end];

        assert!(
            !body.contains("mfem::LinearForm b(fes)"),
            "assemble_poisson_rhs must reuse the context-owned LinearForm workspace"
        );
        assert!(
            !body.contains("AddDomainIntegrator("),
            "assemble_poisson_rhs must not allocate/add RHS integrators in the hot path"
        );
        let eval_start = coeff_body
            .find("void Eval(")
            .expect("MagnetizationCoefficient::Eval definition");
        let eval_rest = &coeff_body[eval_start..];
        let eval_end = eval_rest
            .find("\nprivate:")
            .expect("MagnetizationCoefficient::Eval end marker");
        let eval_body = &eval_rest[..eval_end];

        assert!(
            eval_body.contains("thread_local EvalScratch scratch"),
            "MagnetizationCoefficient::Eval must reuse thread-local element scratch"
        );
        assert!(
            !eval_body.contains("mfem::Array<int> dofs;"),
            "MagnetizationCoefficient::Eval must not allocate DOF scratch per coefficient evaluation"
        );
        assert!(
            !eval_body.contains("mfem::Vector shape(ndof)"),
            "MagnetizationCoefficient::Eval must not allocate shape scratch per coefficient evaluation"
        );
    }

    #[test]
    fn native_fem_poisson_essential_zeroing_uses_context_tdof_list_directly() {
        let source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let start = source
            .find("void zero_poisson_essential_values(")
            .expect("zero_poisson_essential_values definition");
        let rest = &source[start..];
        let end = rest
            .find("\n#ifdef MFEM_USE_MPI")
            .expect("zero_poisson_essential_values end marker");
        let body = &rest[..end];

        assert!(
            body.contains("for (const int tdof : ctx.poisson_ess_tdof_list)"),
            "essential value zeroing must iterate the context-owned tdof list directly"
        );
        assert!(
            !source.contains("poisson_essential_tdofs("),
            "hot path must not construct a temporary mfem::Array wrapper for essential tdofs"
        );
    }

    #[test]
    fn native_fem_demag_recovery_reuses_context_workspace() {
        let source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let start = source
            .find("bool recover_demag_field(")
            .expect("recover_demag_field definition");
        let rest = &source[start..];
        let end = rest
            .find("\n} // namespace")
            .expect("recover_demag_field end marker");
        let body = &rest[..end];

        assert!(
            body.contains("demag_recovery_workspace"),
            "recover_demag_field must use context-owned demag recovery workspace"
        );
        assert!(
            !body.contains("std::vector<std::vector<double>> field_partials("),
            "recover_demag_field must not allocate per-call full-size field partials"
        );
        assert!(
            !body.contains("std::vector<std::vector<double>> weight_partials("),
            "recover_demag_field must not allocate per-call full-size weight partials"
        );
        assert!(
            body.contains("serial_scratch"),
            "recover_demag_field must reuse context-owned serial element scratch"
        );
        assert!(
            body.contains("thread_scratch"),
            "recover_demag_field must reuse context-owned per-thread element scratch"
        );
        assert!(
            !body.contains("mfem::DenseMatrix dshape;"),
            "recover_demag_field must not allocate element DenseMatrix scratch per call/thread"
        );
        assert!(
            body.contains("robin_boundary_tmp"),
            "recover_demag_field must reuse context-owned Robin boundary scratch"
        );
        assert!(
            !body.contains("mfem::Vector Bu("),
            "recover_demag_field must not allocate Robin boundary scratch per recovery"
        );
    }

    #[test]
    fn native_fem_hypre_solve_reuses_transfer_vectors() {
        let source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let start = source
            .find("bool solve_poisson_hypre(")
            .expect("solve_poisson_hypre definition");
        let rest = &source[start..];
        let end = rest
            .find("\n#endif // MFEM_USE_MPI")
            .expect("solve_poisson_hypre end marker");
        let body = &rest[..end];

        assert!(
            body.contains("poisson_hypre_workspace"),
            "solve_poisson_hypre must use context-owned Hypre transfer workspace"
        );
        assert!(
            !body.contains("mfem::HypreParVector b_par("),
            "solve_poisson_hypre must not allocate a fresh RHS HypreParVector per solve"
        );
        assert!(
            !body.contains("mfem::HypreParVector x_par("),
            "solve_poisson_hypre must not allocate a fresh solution HypreParVector per solve"
        );
    }

    #[test]
    fn native_fem_hypre_solve_reuses_persistent_warm_start_vector() {
        let source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let start = source
            .find("bool solve_poisson_hypre(")
            .expect("solve_poisson_hypre definition");
        let rest = &source[start..];
        let end = rest
            .find("\n#endif // MFEM_USE_MPI")
            .expect("solve_poisson_hypre end marker");
        let body = &rest[..end];

        let guard = body
            .find("if (!poisson_hypre_workspace->x_par_contains_solution)")
            .expect("Hypre warm-start copy must be guarded by workspace validity");
        let solution_read = body
            .find("const double *sol_host = audited_host_read(solution)")
            .expect("first Hypre solve still needs to seed x_par from solution");
        let solved_copy = body
            .find("const double *x_solved = audited_host_read(x_par)")
            .expect("solved Hypre vector must still be copied back to MFEM solution");

        assert!(
            guard < solution_read && solution_read < solved_copy,
            "solution-to-Hypre warm-start copy must happen only inside the guarded seed block"
        );
        assert!(
            body.contains("poisson_hypre_workspace->x_par_contains_solution = true"),
            "solve_poisson_hypre must mark the persistent Hypre solution vector valid after solve"
        );
    }

    #[test]
    fn native_fem_non_pbc_demag_reuses_solution_workspace() {
        let source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let start = source
            .find("bool context_compute_demag_poisson(")
            .expect("context_compute_demag_poisson definition");
        let rest = &source[start..];
        let end = rest
            .find("\nbool context_refresh_exchange_field_mfem")
            .expect("context_compute_demag_poisson end marker");
        let body = &rest[..end];

        assert!(
            source.contains("ctx.mfem_poisson_solution_vec ="),
            "Poisson initialization must allocate a context-owned solution workspace"
        );
        assert!(
            source.contains("delete static_cast<mfem::Vector *>(ctx.mfem_poisson_solution_vec)"),
            "Poisson destruction must release the context-owned solution workspace"
        );
        assert!(
            body.contains("ctx.mfem_poisson_solution_vec"),
            "non-PBC demag solve must use the context-owned solution workspace"
        );
        assert!(
            !body.contains("mfem::Vector solution(fes->GetTrueVSize())"),
            "non-PBC demag solve must not allocate a fresh true-DOF solution vector per solve"
        );
        assert!(
            body.contains("if (!poisson_hypre_has_warm_start(ctx))"),
            "non-PBC demag solve should skip GridFunction warm-start extraction when Hypre already has a persistent solution"
        );
    }

    #[test]
    fn native_fem_hypre_solve_enables_iterative_mode_for_warm_start() {
        let source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let start = source
            .find("bool solve_poisson_hypre(")
            .expect("solve_poisson_hypre definition");
        let rest = &source[start..];
        let end = rest
            .find("\n#endif // MFEM_USE_MPI")
            .expect("solve_poisson_hypre end marker");
        let body = &rest[..end];

        assert!(
            body.contains("pcg->iterative_mode = true"),
            "HyprePCG must use the persistent x_par vector as a nonzero initial guess"
        );
        assert!(
            body.contains("gmres->iterative_mode = true"),
            "HypreGMRES must use the persistent x_par vector as a nonzero initial guess"
        );
    }

    #[test]
    fn native_fem_hypre_solve_honors_configured_print_level() {
        let source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let start = source
            .find("bool solve_poisson_hypre(")
            .expect("solve_poisson_hypre definition");
        let rest = &source[start..];
        let end = rest
            .find("\n#endif // MFEM_USE_MPI")
            .expect("solve_poisson_hypre end marker");
        let body = &rest[..end];

        assert!(
            body.contains("ctx.demag_solver.print_level"),
            "native Hypre solver setup must use the configured demag print level"
        );
        assert!(
            body.contains("SetAbsTol(ctx.demag_solver.absolute_tolerance)"),
            "native Hypre solver setup must apply configured absolute tolerance"
        );
        assert!(
            !body.contains("SetPrintLevel(0)"),
            "native Hypre solver setup must not force print level to zero"
        );
    }

    #[test]
    fn native_fem_periodic_demag_reduced_solve_reuses_workspace_and_warm_start() {
        let source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let start = source
            .find("Periodic demag: solve in reduced class space")
            .expect("periodic demag solve block");
        let rest = &source[start..];
        let end = rest
            .find("End periodic demag path")
            .expect("periodic demag solve end marker");
        let body = &rest[..end];

        assert!(
            body.contains("mfem_periodic_poisson_workspace"),
            "periodic reduced demag solve must use a context-owned solver workspace"
        );
        assert!(
            !body.contains("*x_p = 0.0;"),
            "periodic reduced demag solve must retain x_p as the warm-start vector"
        );
        assert!(
            !body.contains("mfem::CGSolver solver;"),
            "periodic reduced demag solve must not allocate a fresh CGSolver per solve"
        );
        assert!(
            !body.contains("mfem::GSSmoother prec("),
            "periodic reduced demag solve must not allocate a fresh GSSmoother per solve"
        );
    }

    #[test]
    fn native_fem_dmi_element_loops_reuse_context_workspace() {
        let sources = [
            (
                "compute_interfacial_dmi_field(",
                include_str!(
                    "../../../native/backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp"
                ),
            ),
            (
                "compute_bulk_dmi_field(",
                include_str!("../../../native/backends/fem/cpu/mfem/interactions/dmi_bulk.cpp"),
            ),
        ];

        for (function_name, source) in sources {
            let start = source.find(function_name).expect("DMI function definition");
            let rest = &source[start..];
            let end = rest
                .find("\n} // namespace fullmag::fem")
                .expect("DMI function end marker");
            let body = &rest[..end];

            assert!(
                body.contains("dmi_element_workspace(ctx)"),
                "{function_name} must use context-owned DMI element workspace"
            );
            assert!(
                !body.contains("mfem::Vector mx_elem("),
                "{function_name} must not allocate mx_elem in the element loop"
            );
            assert!(
                !body.contains("mfem::Vector my_elem("),
                "{function_name} must not allocate my_elem in the element loop"
            );
            assert!(
                !body.contains("mfem::Vector mz_elem("),
                "{function_name} must not allocate mz_elem in the element loop"
            );
            assert!(
                !body.contains("mfem::DenseMatrix dshape("),
                "{function_name} must not allocate dshape in the quadrature loop"
            );
            assert!(
                !body.contains("mfem::Vector shape("),
                "{function_name} must not allocate shape in the quadrature loop"
            );
        }
    }

    #[test]
    fn native_fem_fsal_cached_fields_move_without_copying() {
        let source =
            include_str!("../../../native/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp");
        let start = source
            .find("if (final_stage_cache_valid) {")
            .expect("FSAL final-stage cache block");
        let rest = &source[start..];
        let end = rest
            .find("\n    } else {")
            .expect("FSAL final-stage cache block end");
        let body = &rest[..end];

        assert!(
            body.contains("std::swap(ctx.exchange.h_xyz, ws.h_ex_tmp)"),
            "FSAL accepted step should publish cached exchange field by swapping buffers"
        );
        assert!(
            body.contains("std::swap(ctx.demag.h_xyz, ws.h_demag_tmp)"),
            "FSAL accepted step should publish cached demag field by swapping buffers"
        );
        assert!(
            body.contains("std::swap(ctx.effective_field.h_xyz, ws.h_eff_tmp)"),
            "FSAL accepted step should publish cached effective field by swapping buffers"
        );
        assert!(
            !body.contains("ctx.exchange.h_xyz = ws.h_ex_tmp")
                && !body.contains("ctx.demag.h_xyz = ws.h_demag_tmp")
                && !body.contains("ctx.effective_field.h_xyz = ws.h_eff_tmp"),
            "FSAL accepted step must not copy full field buffers out of the stepper workspace"
        );
    }

    #[test]
    fn native_fem_non_fsal_final_refresh_reuses_stepper_workspace() {
        let source =
            include_str!("../../../native/backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp");
        let start = source
            .find("if (final_stage_cache_valid) {")
            .expect("final field publish block");
        let rest = &source[start..];
        let end = rest
            .find("\n    ctx.current_time += dt;")
            .expect("final field publish block end");
        let body = &rest[..end];

        assert!(
            body.contains("ws.h_ex_tmp")
                && body.contains("ws.h_demag_tmp")
                && body.contains("ws.h_eff_tmp"),
            "non-FSAL final refresh should reuse stepper field workspace"
        );
        assert!(
            !body.contains("std::vector<double> h_ex_final")
                && !body.contains("std::vector<double> h_demag_final")
                && !body.contains("std::vector<double> h_eff_final"),
            "non-FSAL final refresh must not allocate local full-size field buffers"
        );

        let rhs_start = source
            .find("if (final_stage_cache_valid) {\n        max_rhs_final = max_norm_aos(ws.k[0]);")
            .expect("post-step RHS block");
        let rhs_rest = &source[rhs_start..];
        let rhs_end = rhs_rest
            .find("\n    stats.step = ctx.step_count;")
            .expect("post-step RHS block end");
        let rhs_body = &rhs_rest[..rhs_end];
        assert!(
            rhs_body.contains("ws.k[0], max_rhs_final"),
            "non-FSAL post-step RHS should reuse an existing stepper derivative buffer"
        );
        assert!(
            !rhs_body.contains("std::vector<double> rhs_final"),
            "non-FSAL post-step RHS must not allocate a local full-size RHS buffer"
        );
    }

    #[test]
    fn native_fem_disabled_local_terms_are_not_zeroed_each_effective_field_eval() {
        let bridge_source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let start = bridge_source
            .find("bool compute_effective_fields_for_magnetization_impl(")
            .expect("effective field implementation");
        let rest = &bridge_source[start..];
        let end = rest
            .find("\nvoid fill_demag_solver_stats")
            .expect("effective field implementation end");
        let body = &rest[..end];

        assert!(
            !body.contains("ctx.h_dmi_xyz.assign(m_xyz.size(), 0.0)")
                && !body.contains("ctx.h_cubic_ani_xyz.assign(m_xyz.size(), 0.0)")
                && !body.contains("ctx.h_bulk_dmi_xyz.assign(m_xyz.size(), 0.0)"),
            "disabled DMI/cubic/bulk-DMI buffers should not be cleared on every effective-field evaluation"
        );
        assert!(
            body.contains("if (ctx.enable_exchange) {\n        h_ex_xyz.resize(m_xyz.size());")
                && body
                    .contains("if (ctx.enable_demag) {\n        h_demag_xyz.resize(m_xyz.size());")
                && body.contains("h_eff_xyz.resize(m_xyz.size());"),
            "active exchange/demag/H_eff buffers should avoid pre-zeroing before being overwritten"
        );
        assert!(
            !body.contains("h_eff_xyz.assign(m_xyz.size(), 0.0)"),
            "H_eff is fully overwritten later and must not be pre-zeroed every evaluation"
        );

        let context_source = include_str!("../../../native/backends/fem/src/context.cpp");
        assert!(
            context_source.contains("fill_zero_vector_field(ctx.h_dmi_xyz, ctx.n_nodes)")
                && context_source
                    .contains("fill_zero_vector_field(ctx.h_cubic_ani_xyz, ctx.n_nodes)")
                && context_source
                    .contains("fill_zero_vector_field(ctx.h_bulk_dmi_xyz, ctx.n_nodes)"),
            "disabled local-term observable buffers must be initialized once in context_from_plan"
        );
    }

    #[test]
    fn native_fem_demag_cache_copy_is_guarded_by_field_refresh_policy() {
        let source = include_str!("../../../native/backends/fem/src/mfem_bridge.cpp");
        let start = source
            .find("bool compute_effective_fields_for_magnetization_impl(")
            .expect("effective field implementation");
        let rest = &source[start..];
        let end = rest
            .find("\nvoid fill_demag_solver_stats")
            .expect("effective field implementation end");
        let body = &rest[..end];
        let cache_copy = body
            .find("ctx.h_demag_cached_xyz = h_demag_xyz")
            .expect("demag cache copy");
        let policy_guard = body
            .find("if (ctx.field_refresh.has_demag_interval_s != 0) {")
            .expect("field-refresh cache guard");

        assert!(
            policy_guard < cache_copy,
            "fresh Poisson demag should copy full fields into frozen-field cache only when field_refresh is active"
        );
    }

    #[test]
    fn native_fem_dmi_formula_smoke_has_directional_derivative_oracle() {
        let source = include_str!("../../../native/backends/fem/tests/dmi_weak_residual.cpp");

        assert!(
            source.contains("interfacial_energy_directional_derivative"),
            "native DMI formula smoke must compare interfacial dE/deps against field action"
        );
        assert!(
            source.contains("bulk_energy_directional_derivative"),
            "native DMI formula smoke must compare bulk dE/deps against field action"
        );
        assert!(
            source.contains("run_interfacial_directional_derivative_fixture"),
            "native DMI formula smoke must execute the interfacial directional-derivative fixture"
        );
        assert!(
            source.contains("run_bulk_directional_derivative_fixture"),
            "native DMI formula smoke must execute the bulk directional-derivative fixture"
        );
    }

    #[test]
    fn native_fem_step_metrics_reuse_effective_field_local_energies() {
        let source = include_str!("../../../native/backends/fem/cpu/mfem/runtime/step_metrics.cpp");
        let start = source
            .find("void fill_common_step_metrics(")
            .expect("fill_common_step_metrics definition");
        let rest = &source[start..];
        let end = rest
            .find("\n} // namespace fullmag::fem")
            .expect("fill_common_step_metrics end marker");
        let body = &rest[..end];

        assert!(
            body.contains("ctx.anisotropy.energy_joules"),
            "step metrics must reuse the anisotropy energy from the final effective-field evaluation"
        );
        assert!(
            body.contains("ctx.dmi.energy_joules"),
            "step metrics must reuse the DMI energy from the final effective-field evaluation"
        );
        assert!(
            body.contains("ctx.magnetoelastic.energy_joules"),
            "step metrics must reuse the magnetoelastic energy from the final effective-field evaluation"
        );
        assert!(
            !body.contains("compute_uniaxial_anisotropy_field("),
            "step metrics must not recompute uniaxial anisotropy fields"
        );
        assert!(
            !body.contains("compute_cubic_anisotropy_field("),
            "step metrics must not recompute cubic anisotropy fields"
        );
        assert!(
            !body.contains("compute_interfacial_dmi_field("),
            "step metrics must not recompute interfacial DMI fields"
        );
        assert!(
            !body.contains("compute_bulk_dmi_field("),
            "step metrics must not recompute bulk DMI fields"
        );
        assert!(
            !body.contains("compute_magnetoelastic_field("),
            "step metrics must not recompute magnetoelastic fields"
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
