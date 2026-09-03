//! Safe Rust wrapper around the native MFEM/libCEED FEM backend scaffold.
//!
//! Current stage:
//! - stable C ABI and Rust wrapper
//! - availability probing
//! - native MFEM/libCEED/hypre time-domain FEM execution
//! - mesh-native Poisson demag on shared-domain meshes with air

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
use fullmag_fem_sys as ffi;

mod availability;
mod eigen;
mod frequency_domain;
mod plan;
#[cfg(feature = "fem-gpu")]
mod runtime_info;
#[cfg(feature = "fem-gpu")]
mod stage_coupled;
#[cfg(feature = "fem-gpu")]
mod stage_oersted;
#[cfg(feature = "fem-gpu")]
mod stage_transport;
#[cfg(feature = "fem-gpu")]
mod steady_transport;
#[allow(unused_imports)]
pub(crate) use availability::{
    is_cpu_available, is_gpu_available, native_availability, native_frequency_domain_availability,
    FrequencyDomainAvailability, FrequencyDomainAvailabilityRequest,
    FrequencyDomainPhaseConvention, FrequencyDomainStudyKind, FrequencyDomainSweepProgress,
    GpuAvailability,
};
#[allow(unused_imports)]
pub(crate) use eigen::{gpu_eigen_dense_solve, GpuEigenResult};
#[cfg(test)]
pub(crate) use frequency_domain::measured_modal_gpu_attestation_fixture;
#[allow(unused_imports)]
pub(crate) use frequency_domain::{
    solve_native_driven_frequency_response, solve_native_driven_response_contract,
    solve_native_modal_eigen, validate_planned_modal_execution_attestation,
    NativeDrivenFrequencyResponseDmiElement, NativeDrivenFrequencyResponseDmiKind,
    NativeDrivenFrequencyResponseExchangeEdge, NativeDrivenFrequencyResponseFloquetPeriodicPair,
    NativeDrivenFrequencyResponseMfemOperatorProblem,
    NativeDrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem,
    NativeDrivenFrequencyResponsePeriodicNodePair, NativeDrivenFrequencyResponseRequest,
    NativeDrivenFrequencyResponseResult, NativeDrivenFrequencyResponseTinyValidationProblem,
    NativeDrivenResponseContractRequest, NativeFrequencyDomainCancelCallback,
    NativeFrequencyDomainContractResult, NativeFrequencyDomainExecutionLane,
    NativeFrequencyDomainProgress, NativeFrequencyDomainProgressCallback,
    NativeFrequencyDomainStatus, NativeModalEigenCsrMatrixView,
    NativeModalEigenFloquetPeriodicPair, NativeModalEigenMfemOperatorProblem,
    NativeModalEigenPoissonAirboxBlockProblem, NativeModalEigenRequest,
    NativeModalEigenSharedDomainProblem, NativeModalEigenSparseOperatorProblem,
    NativeModalExecutionTarget, NativeModalGpuAttestation,
};
#[allow(unused_imports)]
#[cfg(feature = "fem-gpu")]
pub(crate) use plan::resolved_native_fem_demag_solver_policy;
#[allow(unused_imports)]
pub(crate) use plan::{
    native_fem_mfem_device_string_requests_gpu, native_fem_plan_requests_gpu_mfem_device,
};
#[cfg(feature = "fem-gpu")]
pub(crate) use runtime_info::{
    stage_completion_from_ffi, stage_completion_is_representability_stationary,
    strict_gpu_runtime_build_info, DeviceInfo, NativeFemDataResidency, NativeFemGpuRkPlanInfo,
    NativeFemGpuStateInfo,
};
#[cfg(feature = "fem-gpu")]
pub(crate) use stage_coupled::StageM2CoupledProvider;
#[cfg(feature = "fem-gpu")]
pub(crate) use stage_oersted::{plan_requests_stage_oersted_callback, StageOerstedProvider};
#[cfg(feature = "fem-gpu")]
pub(crate) use stage_transport::{plan_requests_stage_transport_callback, StageTransportProvider};
#[cfg(all(test, feature = "fem-gpu"))]
pub(crate) use steady_transport::test_resolved_plan as test_resolved_steady_transport_plan;
#[allow(unused_imports)]
#[cfg(feature = "fem-gpu")]
pub(crate) use steady_transport::{
    execute_native_fem_steady_transport_plans, solve_native_fem_steady_transport,
    solve_native_fem_steady_transport_rt0, NativeFemSteadyTransportBundle,
    NativeFemSteadyTransportExecution, NativeFemSteadyTransportGauge,
    NativeFemSteadyTransportInterface, NativeFemSteadyTransportRequest,
    NativeFemSteadyTransportResult, NativeFemSteadyTransportRt0Result,
};

#[cfg(feature = "fem-gpu")]
use crate::preview::{
    build_mesh_preview_field_with_active_mask, build_mesh_scalar_preview_field_with_active_mask,
    mesh_quantity_active_mask,
};
#[cfg(feature = "fem-gpu")]
use crate::quantities::normalize_quantity_id;
use crate::quantities::QuantityId;
#[cfg(feature = "fem-gpu")]
use crate::scalar_metrics::{single_object_scalars, weighted_object_scalars};
#[cfg(feature = "fem-gpu")]
use crate::types::{
    FemMaterialFieldLocation, FemRepresentationReceipt, FemStateRepresentation, LivePreviewField,
    LivePreviewRequest, RunError, SolverAttemptRecord, StepStats,
};
#[cfg(feature = "fem-gpu")]
use fullmag_engine::{dot, MU0};
#[cfg(feature = "fem-gpu")]
use fullmag_ir::StageCompletionIR;
#[cfg(feature = "fem-gpu")]
use plan::{
    has_slonczewski_stt, has_zhang_li_stt, native_fem_gpu_demag_mode,
    native_fem_precession_enabled, single_precision_rejection,
};

#[cfg(feature = "fem-gpu")]
use sha2::{Digest, Sha256};
#[cfg(feature = "fem-gpu")]
use std::collections::{BTreeSet, HashMap};
#[cfg(feature = "fem-gpu")]
use std::ffi::c_void;
#[cfg(feature = "fem-gpu")]
use std::ffi::CStr;
#[cfg(feature = "fem-gpu")]
use std::io::Write;
#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
use std::path::{Path, PathBuf};
#[cfg(feature = "fem-gpu")]
use std::ptr;
#[cfg(feature = "fem-gpu")]
use std::sync::Arc;

#[cfg(feature = "fem-gpu")]
fn checked_native_finite(label: &str, value: f64) -> Result<f64, RunError> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(RunError {
            message: format!("native FEM returned non-finite {label}"),
        })
    }
}

#[cfg(feature = "fem-gpu")]
fn checked_native_nonnegative(label: &str, value: f64) -> Result<f64, RunError> {
    let value = checked_native_finite(label, value)?;
    if value >= 0.0 {
        Ok(value)
    } else {
        Err(RunError {
            message: format!("native FEM returned negative {label}"),
        })
    }
}

#[cfg(feature = "fem-gpu")]
fn copy_demag_diagnostics(step_stats: &mut StepStats, ffi_stats: &ffi::fullmag_fem_step_stats) {
    step_stats.demag_potential_order = ffi_stats.demag_potential_order;
    step_stats.demag_potential_true_dof_count = ffi_stats.demag_potential_true_dof_count;
    step_stats.demag_variational_energy_joules = ffi_stats.demag_variational_energy_joules;
    step_stats.demag_recovered_field_energy_joules = ffi_stats.demag_recovered_field_energy_joules;
}

#[cfg(feature = "fem-gpu")]
fn solver_attempt_decision(value: u32) -> Result<&'static str, RunError> {
    match value {
        1 => Ok("accepted"),
        2 => Ok("retry"),
        3 => Ok("failed"),
        _ => Err(RunError {
            message: format!("native FEM returned unknown solver attempt decision {value}"),
        }),
    }
}

#[cfg(feature = "fem-gpu")]
fn solver_attempt_reason(value: u32) -> Result<&'static str, RunError> {
    const REASONS: [&str; 9] = [
        "within_tolerance",
        "error_above_tolerance",
        "dt_min_exhausted",
        "invalid_order",
        "invalid_bounds",
        "invalid_controller_limits",
        "invalid_timestep",
        "invalid_current_error",
        "invalid_previous_error",
    ];
    value
        .checked_sub(1)
        .and_then(|index| REASONS.get(index as usize).copied())
        .ok_or_else(|| RunError {
            message: format!("native FEM returned unknown solver attempt reason {value}"),
        })
}

#[cfg(feature = "fem-gpu")]
fn solver_attempt_error_norm_type(value: u32) -> Result<Option<&'static str>, RunError> {
    match value {
        ffi::FULLMAG_FEM_SOLVER_ERROR_NORM_NONE => Ok(None),
        ffi::FULLMAG_FEM_SOLVER_ERROR_NORM_MAX => Ok(Some("max")),
        ffi::FULLMAG_FEM_SOLVER_ERROR_NORM_MASS_WEIGHTED_RMS => Ok(Some("mass_weighted_rms")),
        _ => Err(RunError {
            message: format!("native FEM returned unknown solver error norm type {value}"),
        }),
    }
}

#[cfg(feature = "fem-gpu")]
fn endpoint_cache_refresh_reason(value: u32) -> Result<&'static str, RunError> {
    match value {
        ffi::FULLMAG_FEM_ENDPOINT_REFRESH_CACHE_HIT => Ok("cache_hit"),
        ffi::FULLMAG_FEM_ENDPOINT_REFRESH_NON_FSAL_TABLEAU => Ok("non_fsal_tableau"),
        ffi::FULLMAG_FEM_ENDPOINT_REFRESH_CANDIDATE_STATE_MISMATCH => {
            Ok("candidate_state_mismatch")
        }
        ffi::FULLMAG_FEM_ENDPOINT_REFRESH_ENDPOINT_TIME_MISMATCH => Ok("endpoint_time_mismatch"),
        ffi::FULLMAG_FEM_ENDPOINT_REFRESH_DYNAMIC_SOURCE_CHANGED => Ok("dynamic_source_changed"),
        ffi::FULLMAG_FEM_ENDPOINT_REFRESH_TRANSPORT_SOURCE_CHANGED => {
            Ok("transport_source_changed")
        }
        ffi::FULLMAG_FEM_ENDPOINT_REFRESH_PROJECTION_MISMATCH => Ok("projection_mismatch"),
        ffi::FULLMAG_FEM_ENDPOINT_REFRESH_CACHE_UNAVAILABLE => Ok("cache_unavailable"),
        _ => Err(RunError {
            message: format!("native FEM returned unknown endpoint cache refresh reason {value}"),
        }),
    }
}

#[cfg(feature = "fem-gpu")]
fn endpoint_cache_flag(label: &str, value: u32) -> Result<bool, RunError> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(RunError {
            message: format!("native FEM returned invalid endpoint cache flag {label}={value}"),
        }),
    }
}

#[cfg(feature = "fem-gpu")]
fn endpoint_cache_telemetry_from_ffi(
    raw: &ffi::fullmag_fem_endpoint_cache_telemetry_v1,
) -> Result<Option<fullmag_quantities::EndpointCacheTelemetry>, RunError> {
    if raw.abi_version != ffi::FULLMAG_FEM_ENDPOINT_CACHE_TELEMETRY_V1_ABI_VERSION
        || raw.struct_size as usize
            != std::mem::size_of::<ffi::fullmag_fem_endpoint_cache_telemetry_v1>()
    {
        return Err(RunError {
            message: "native FEM returned an incompatible endpoint cache telemetry ABI v1 record"
                .to_string(),
        });
    }
    let available = endpoint_cache_flag("available", raw.available)?;
    if !available {
        if raw.final_refresh_reason != ffi::FULLMAG_FEM_ENDPOINT_REFRESH_NOT_EVALUATED {
            return Err(RunError {
                message:
                    "native FEM marked endpoint cache telemetry unavailable with a refresh reason"
                        .to_string(),
            });
        }
        return Ok(None);
    }
    let final_refresh_reason = endpoint_cache_refresh_reason(raw.final_refresh_reason)?;
    Ok(Some(fullmag_quantities::EndpointCacheTelemetry {
        final_refresh_reason: final_refresh_reason.to_string(),
        cache_state_valid: endpoint_cache_flag("cache_state_valid", raw.cache_state_valid)?,
        cache_time_valid: endpoint_cache_flag("cache_time_valid", raw.cache_time_valid)?,
        cache_dynamic_sources_valid: endpoint_cache_flag(
            "cache_dynamic_sources_valid",
            raw.cache_dynamic_sources_valid,
        )?,
        cache_transport_valid: endpoint_cache_flag(
            "cache_transport_valid",
            raw.cache_transport_valid,
        )?,
        cache_projection_valid: endpoint_cache_flag(
            "cache_projection_valid",
            raw.cache_projection_valid,
        )?,
        final_rhs_evaluations: raw.final_rhs_evaluations,
        extra_poisson_solves: raw.extra_poisson_solves,
        endpoint_cache_hits: raw.endpoint_cache_hits,
        endpoint_refreshes: raw.endpoint_refreshes,
        accepted_step_wall_time_ns: raw.accepted_step_wall_time_ns,
    }))
}

#[cfg(feature = "fem-gpu")]
fn representation_material_location_from_ffi(
    label: &str,
    value: u32,
) -> Result<FemMaterialFieldLocation, RunError> {
    match value {
        ffi::FULLMAG_FEM_MATERIAL_LOCATION_SCALAR => Ok(FemMaterialFieldLocation::Scalar),
        ffi::FULLMAG_FEM_MATERIAL_LOCATION_NODAL_P1 => Ok(FemMaterialFieldLocation::NodalP1),
        ffi::FULLMAG_FEM_MATERIAL_LOCATION_ELEMENT_DG0 => Ok(FemMaterialFieldLocation::ElementDg0),
        _ => Err(RunError {
            message: format!("native FEM returned unknown {label} material location {value}"),
        }),
    }
}

#[cfg(feature = "fem-gpu")]
fn representation_receipt_from_ffi(
    raw: &ffi::fullmag_fem_representation_receipt_v1,
) -> Result<FemRepresentationReceipt, RunError> {
    if raw.abi_version != ffi::FULLMAG_FEM_REPRESENTATION_RECEIPT_V1_ABI_VERSION
        || raw.struct_size as usize
            != std::mem::size_of::<ffi::fullmag_fem_representation_receipt_v1>()
    {
        return Err(RunError {
            message: "native FEM returned an incompatible representation receipt ABI v1 record"
                .to_string(),
        });
    }
    let state_space = match raw.state_space {
        ffi::FULLMAG_FEM_REPRESENTATION_SPACE_LOCAL_NODE_AOS => {
            FemStateRepresentation::LocalNodeAos
        }
        value => {
            return Err(RunError {
                message: format!("native FEM returned unknown state representation {value}"),
            })
        }
    };
    if raw.local_node_count == 0
        || raw.true_node_count == 0
        || raw.true_node_count > raw.local_node_count
        || (raw.true_node_count < raw.local_node_count && raw.periodic_map_revision == 0)
        || raw.reserved0 != 0
        || raw.hot_loop_representation_copy_count > raw.representation_copy_count
        || raw.hot_loop_gather_scatter_bytes > raw.gather_scatter_bytes
    {
        return Err(RunError {
            message: "native FEM returned an internally inconsistent representation receipt"
                .to_string(),
        });
    }
    Ok(FemRepresentationReceipt {
        schema_version: raw.abi_version,
        state_space,
        ms_location: representation_material_location_from_ffi(
            "saturation magnetisation",
            raw.ms_location,
        )?,
        a_location: representation_material_location_from_ffi(
            "exchange stiffness",
            raw.a_location,
        )?,
        local_node_count: raw.local_node_count,
        true_node_count: raw.true_node_count,
        periodic_map_revision: raw.periodic_map_revision,
        representation_copy_count: raw.representation_copy_count,
        gather_scatter_bytes: raw.gather_scatter_bytes,
        invalid_space_assertion_count: raw.invalid_space_assertion_count,
        hot_loop_representation_copy_count: raw.hot_loop_representation_copy_count,
        hot_loop_gather_scatter_bytes: raw.hot_loop_gather_scatter_bytes,
    })
}

#[cfg(feature = "fem-gpu")]
fn validate_native_step_stats(stats: &ffi::fullmag_fem_step_stats) -> Result<f64, RunError> {
    for (label, value) in [
        ("exchange_energy_joules", stats.exchange_energy_joules),
        ("demag_energy_joules", stats.demag_energy_joules),
        ("external_energy_joules", stats.external_energy_joules),
        ("drive_energy_joules", stats.drive_energy_joules),
        ("anisotropy_energy_joules", stats.anisotropy_energy_joules),
        ("dmi_energy_joules", stats.dmi_energy_joules),
        ("total_energy_joules", stats.total_energy_joules),
    ] {
        checked_native_finite(label, value)?;
    }
    for (label, value) in [
        ("max_rhs_amplitude", stats.max_rhs_amplitude),
        (
            "max_effective_field_amplitude",
            stats.max_effective_field_amplitude,
        ),
        ("max_demag_field_amplitude", stats.max_demag_field_amplitude),
        ("error_estimate", stats.error_estimate),
        ("demag_linear_residual", stats.demag_linear_residual),
        (
            "demag_amg_strength_threshold",
            stats.demag_amg_strength_threshold,
        ),
    ] {
        checked_native_nonnegative(label, value)?;
    }
    for (label, value) in [
        ("demag_amg_relax_type", stats.demag_amg_relax_type),
        ("demag_amg_coarsening", stats.demag_amg_coarsening),
        ("demag_amg_interpolation", stats.demag_amg_interpolation),
        (
            "demag_amg_aggressive_coarsening",
            stats.demag_amg_aggressive_coarsening,
        ),
        ("demag_amg_max_levels", stats.demag_amg_max_levels),
    ] {
        if value < 0 {
            return Err(RunError {
                message: format!("native FEM returned negative {label}: {value}"),
            });
        }
    }
    for (label, value) in [
        (
            "demag_amg_strength_threshold_is_set",
            stats.demag_amg_strength_threshold_is_set,
        ),
        (
            "demag_amg_max_levels_is_set",
            stats.demag_amg_max_levels_is_set,
        ),
    ] {
        if !matches!(value, 0 | 1) {
            return Err(RunError {
                message: format!("native FEM returned invalid {label}: {value}"),
            });
        }
    }
    checked_native_nonnegative("max_torque_Apm", stats.max_torque_Apm)
}

#[cfg(feature = "fem-gpu")]
use std::sync::atomic::{AtomicBool, Ordering};

// ── Fallback defaults when air_box_config is absent (FEM-040) ────────────
#[cfg(feature = "fem-gpu")]
const FALLBACK_POISSON_BOUNDARY_MARKER: i32 = 99;
#[cfg(feature = "fem-gpu")]
const FALLBACK_ROBIN_BETA_FACTOR: f64 = 2.0;

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn optional_slice_ptr<T>(slice: &[T]) -> *const T {
    if slice.is_empty() {
        std::ptr::null()
    } else {
        slice.as_ptr()
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
pub(crate) struct PackedNativeMesh {
    nodes_xyz: Vec<f64>,
    cell_types: Vec<u32>,
    cell_markers: Vec<u32>,
    facet_types: Vec<u32>,
    facet_roles: Vec<u32>,
    periodic_node_pairs: Vec<u32>,
    periodic_boundary_pair_markers: Vec<u32>,
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
impl PackedNativeMesh {
    pub(crate) fn new(mesh: &fullmag_ir::MeshIR) -> Self {
        Self {
            nodes_xyz: mesh.nodes.iter().flatten().copied().collect(),
            cell_types: mesh
                .cells
                .types
                .iter()
                .map(|kind| match kind {
                    fullmag_ir::FemCellTypeIR::Tet4 => ffi::FULLMAG_FEM_CELL_TET4,
                    fullmag_ir::FemCellTypeIR::Prism6 => ffi::FULLMAG_FEM_CELL_PRISM6,
                    fullmag_ir::FemCellTypeIR::Pyramid5 => ffi::FULLMAG_FEM_CELL_PYRAMID5,
                    fullmag_ir::FemCellTypeIR::Hex8 => ffi::FULLMAG_FEM_CELL_HEX8,
                })
                .collect(),
            cell_markers: mesh.element_markers.clone(),
            facet_types: mesh
                .facets
                .types
                .iter()
                .map(|kind| match kind {
                    fullmag_ir::FemFacetTypeIR::Tri3 => ffi::FULLMAG_FEM_FACET_TRI3,
                    fullmag_ir::FemFacetTypeIR::Quad4 => ffi::FULLMAG_FEM_FACET_QUAD4,
                })
                .collect(),
            facet_roles: mesh
                .facets
                .roles
                .iter()
                .map(|role| match role {
                    fullmag_ir::FemFacetRoleIR::Exterior => ffi::FULLMAG_FEM_FACET_ROLE_EXTERIOR,
                    fullmag_ir::FemFacetRoleIR::MaterialInterface => {
                        ffi::FULLMAG_FEM_FACET_ROLE_MATERIAL_INTERFACE
                    }
                    fullmag_ir::FemFacetRoleIR::PeriodicSeam => {
                        ffi::FULLMAG_FEM_FACET_ROLE_PERIODIC_SEAM
                    }
                })
                .collect(),
            periodic_node_pairs: mesh
                .periodic_node_pairs
                .iter()
                .flat_map(|pair| [pair.node_a, pair.node_b])
                .collect(),
            periodic_boundary_pair_markers: mesh
                .periodic_boundary_pairs
                .iter()
                .flat_map(|pair| [pair.marker_a, pair.marker_b])
                .collect(),
        }
    }

    pub(crate) fn descriptor(&self, mesh: &fullmag_ir::MeshIR) -> ffi::fullmag_fem_mesh_desc {
        ffi::fullmag_fem_mesh_desc {
            abi_version: ffi::FULLMAG_FEM_MESH_DESC_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_mesh_desc>() as u32,
            nodes_xyz: optional_slice_ptr(&self.nodes_xyz),
            nodes_xyz_len: self.nodes_xyz.len() as u64,
            cell_types: optional_slice_ptr(&self.cell_types),
            cell_types_len: self.cell_types.len() as u64,
            cell_offsets: optional_slice_ptr(&mesh.cells.offsets),
            cell_offsets_len: mesh.cells.offsets.len() as u64,
            cell_nodes: optional_slice_ptr(&mesh.cells.nodes),
            cell_nodes_len: mesh.cells.nodes.len() as u64,
            cell_global_ordinals: optional_slice_ptr(&mesh.cells.global_ordinals),
            cell_global_ordinals_len: mesh.cells.global_ordinals.len() as u64,
            cell_markers: optional_slice_ptr(&self.cell_markers),
            cell_markers_len: self.cell_markers.len() as u64,
            facet_types: optional_slice_ptr(&self.facet_types),
            facet_types_len: self.facet_types.len() as u64,
            facet_roles: optional_slice_ptr(&self.facet_roles),
            facet_roles_len: self.facet_roles.len() as u64,
            facet_offsets: optional_slice_ptr(&mesh.facets.offsets),
            facet_offsets_len: mesh.facets.offsets.len() as u64,
            facet_nodes: optional_slice_ptr(&mesh.facets.nodes),
            facet_nodes_len: mesh.facets.nodes.len() as u64,
            facet_global_ordinals: optional_slice_ptr(&mesh.facets.global_ordinals),
            facet_global_ordinals_len: mesh.facets.global_ordinals.len() as u64,
            facet_markers: optional_slice_ptr(&mesh.boundary_markers),
            facet_markers_len: mesh.boundary_markers.len() as u64,
            periodic_node_pairs: optional_slice_ptr(&self.periodic_node_pairs),
            periodic_node_pairs_len: self.periodic_node_pairs.len() as u64,
            periodic_boundary_pair_markers: optional_slice_ptr(
                &self.periodic_boundary_pair_markers,
            ),
            periodic_boundary_pair_markers_len: self.periodic_boundary_pair_markers.len() as u64,
        }
    }

    pub(crate) fn replace_cell_markers(&mut self, cell_markers: &[u32]) {
        self.cell_markers.clear();
        self.cell_markers.extend_from_slice(cell_markers);
    }
}

#[cfg(feature = "fem-gpu")]
fn resolve_native_fem_plan_dt_seconds(plan: &fullmag_ir::FemPlanIR) -> Result<f64, RunError> {
    if crate::fem::relax::algorithm::native_step_control(plan.relaxation.as_ref()).is_some() {
        return Ok(crate::NON_LLG_RELAXATION_ABI_DT_PLACEHOLDER);
    }
    crate::resolve_timestep_policy(
        plan.integrator,
        plan.fixed_timestep,
        plan.adaptive_timestep.as_ref(),
        if native_fem_plan_requests_gpu_mfem_device(plan) {
            crate::types::TimestepExecutionLane::fem_gpu(plan.precision)
        } else {
            crate::types::TimestepExecutionLane::fem_cpu(plan.precision)
        },
    )
    .map(|policy| policy.initial_dt())
}

#[cfg(feature = "fem-gpu")]
fn assign_runtime_marker_range(
    markers: &mut [Option<u32>],
    start: usize,
    count: usize,
    marker: u32,
    source: &str,
) -> Result<usize, RunError> {
    let end = start.checked_add(count).ok_or_else(|| RunError {
        message: format!("invalid native FEM marker range from {source}: range overflows"),
    })?;
    if end > markers.len() {
        return Err(RunError {
            message: format!(
                "invalid native FEM marker range from {source}: element range {}..{} exceeds mesh element count {}",
                start,
                end,
                markers.len()
            ),
        });
    }

    let mut newly_assigned = 0usize;
    for (offset, slot) in markers[start..end].iter_mut().enumerate() {
        match *slot {
            Some(existing) if existing != marker => {
                return Err(RunError {
                    message: format!(
                        "conflicting native FEM marker inference at element {}: {} vs {} from {}",
                        start + offset,
                        existing,
                        marker,
                        source
                    ),
                });
            }
            Some(_) => {}
            None => {
                *slot = Some(marker);
                newly_assigned += 1;
            }
        }
    }
    Ok(newly_assigned)
}

#[cfg(feature = "fem-gpu")]
fn infer_native_runtime_element_markers(
    plan: &fullmag_ir::FemPlanIR,
) -> Result<Option<Vec<u32>>, RunError> {
    if !plan.mesh.element_markers.is_empty() {
        return Ok(None);
    }

    let element_count = plan.mesh.cell_count();
    if element_count == 0 {
        return Ok(Some(Vec::new()));
    }

    let mut inferred = vec![None; element_count];
    let mut assigned = 0usize;

    for segment in &plan.object_segments {
        if segment.element_count == 0 {
            continue;
        }
        let marker = if segment.object_id == "__air__" { 0 } else { 1 };
        assigned += assign_runtime_marker_range(
            &mut inferred,
            segment.element_start as usize,
            segment.element_count as usize,
            marker,
            &format!("object_segment '{}'", segment.object_id),
        )?;
    }

    for part in &plan.mesh_parts {
        let marker = match part.role {
            fullmag_ir::FemMeshPartRole::MagneticObject => 1,
            fullmag_ir::FemMeshPartRole::Air => 0,
            _ => continue,
        };
        match &part.element_selector {
            fullmag_ir::FemMeshPartSelector::ElementRange { start, count } => {
                assigned += assign_runtime_marker_range(
                    &mut inferred,
                    *start as usize,
                    *count as usize,
                    marker,
                    &format!("mesh_part '{}'", part.id),
                )?;
            }
            fullmag_ir::FemMeshPartSelector::ElementMarkerSet { .. } => {
                return Err(RunError {
                    message: format!(
                        "cannot infer native FEM runtime markers for mesh_part '{}' from ElementMarkerSet because mesh.element_markers is empty",
                        part.id
                    ),
                });
            }
            _ => {}
        }
    }

    if assigned == 0 {
        if plan.domain_mesh_mode == fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir {
            return Err(RunError {
                message:
                    "native FEM shared-domain airbox plan has empty element_markers and no element-range mesh_parts/object_segments"
                        .to_string(),
            });
        }
        return Ok(None);
    }

    if let Some(unassigned) = inferred.iter().position(|marker| marker.is_none()) {
        if plan.domain_mesh_mode == fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir {
            return Err(RunError {
                message: format!(
                    "cannot infer complete native FEM runtime markers: mesh_parts/object_segments leave element {} unclassified in shared-domain airbox mesh",
                    unassigned
                ),
            });
        }
    }

    Ok(Some(
        inferred
            .into_iter()
            .map(|marker| marker.unwrap_or(1))
            .collect(),
    ))
}

#[cfg(feature = "fem-gpu")]
fn native_markers_from_element_selector(
    selector: &fullmag_ir::FemMeshPartSelector,
    mesh_element_markers: &[u32],
) -> BTreeSet<u32> {
    match selector {
        fullmag_ir::FemMeshPartSelector::ElementMarkerSet { markers } => markers
            .iter()
            .copied()
            .filter(|marker| *marker != 0)
            .collect(),
        fullmag_ir::FemMeshPartSelector::ElementRange { start, count } => {
            let start = *start as usize;
            let end = start
                .saturating_add(*count as usize)
                .min(mesh_element_markers.len());
            if start >= end {
                return BTreeSet::new();
            }
            mesh_element_markers[start..end]
                .iter()
                .copied()
                .filter(|marker| *marker != 0)
                .collect()
        }
        _ => BTreeSet::new(),
    }
}

#[cfg(feature = "fem-gpu")]
fn native_magnetic_markers_from_object_segments(plan: &fullmag_ir::FemPlanIR) -> BTreeSet<u32> {
    if plan.mesh.element_markers.is_empty() {
        return BTreeSet::new();
    }
    let mut markers = BTreeSet::new();
    for segment in &plan.object_segments {
        if segment.element_count == 0 {
            continue;
        }
        let start = segment.element_start as usize;
        let end = start
            .saturating_add(segment.element_count as usize)
            .min(plan.mesh.element_markers.len());
        if start >= end {
            continue;
        }
        markers.extend(
            plan.mesh.element_markers[start..end]
                .iter()
                .copied()
                .filter(|marker| *marker != 0),
        );
    }
    markers
}

#[cfg(feature = "fem-gpu")]
fn native_magnetic_markers_from_mesh_parts(plan: &fullmag_ir::FemPlanIR) -> BTreeSet<u32> {
    if plan.mesh.element_markers.is_empty() {
        return BTreeSet::new();
    }
    let mut markers = BTreeSet::new();
    for part in &plan.mesh_parts {
        if part.role != fullmag_ir::FemMeshPartRole::MagneticObject {
            continue;
        }
        markers.extend(native_markers_from_element_selector(
            &part.element_selector,
            &plan.mesh.element_markers,
        ));
    }
    markers
}

#[cfg(feature = "fem-gpu")]
fn normalized_native_runtime_element_markers(
    plan: &fullmag_ir::FemPlanIR,
) -> Result<Option<Vec<u32>>, RunError> {
    if plan.mesh.element_markers.is_empty() {
        return infer_native_runtime_element_markers(plan);
    }

    let distinct_nonzero = plan
        .mesh
        .element_markers
        .iter()
        .copied()
        .filter(|marker| *marker != 0)
        .collect::<BTreeSet<_>>();
    if distinct_nonzero.is_empty() {
        return Ok(Some(vec![0; plan.mesh.element_markers.len()]));
    }

    let magnetic_markers = if !plan.region_materials.is_empty() {
        let markers = plan
            .region_materials
            .iter()
            .map(|region| region.element_marker)
            .collect::<BTreeSet<_>>();
        let unknown = distinct_nonzero
            .difference(&markers)
            .copied()
            .collect::<Vec<_>>();
        if !unknown.is_empty() {
            return Err(RunError {
                message: format!(
                    "ambiguous native FEM magnetic region contract: mesh contains non-zero element markers {:?} that are not declared in region_materials",
                    unknown
                ),
            });
        }
        markers
    } else if distinct_nonzero.len() > 1 {
        let mut inferred = native_magnetic_markers_from_object_segments(plan);
        inferred.extend(native_magnetic_markers_from_mesh_parts(plan));
        if inferred.is_empty() {
            return Err(RunError {
                message: format!(
                    "ambiguous native FEM magnetic region contract: mesh uses multiple non-zero element markers {:?} without region_materials. Refusing to guess which regions are magnetic.",
                    distinct_nonzero
                ),
            });
        } else {
            let unknown = distinct_nonzero
                .difference(&inferred)
                .copied()
                .collect::<Vec<_>>();
            if !unknown.is_empty() {
                return Err(RunError {
                    message: format!(
                        "ambiguous native FEM magnetic region contract: mesh contains non-zero element markers {:?} that are not covered by object_segments/mesh_parts-inferred magnetic markers {:?}",
                        unknown, inferred
                    ),
                });
            }
            inferred
        }
    } else {
        distinct_nonzero
    };

    if magnetic_markers.contains(&0) {
        return Err(RunError {
            message:
                "invalid native FEM plan: magnetic runtime markers must not include element_marker=0"
                    .to_string(),
        });
    }

    Ok(Some(
        plan.mesh
            .element_markers
            .iter()
            .map(|marker| u32::from(magnetic_markers.contains(marker)))
            .collect(),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeFemPreviewObservable {
    M,
    HEx,
    HDemag,
    DemagPhi,
    HExt,
    HDrive,
    HEff,
    Torque,
    HAni,
    HDmi,
    HMel,
    HAniCubic,
    HDmiBulk,
    HOe,
    HTherm,
}

impl NativeFemPreviewObservable {
    fn from_quantity(id: QuantityId) -> Option<Self> {
        Some(match id {
            QuantityId::M => Self::M,
            QuantityId::HEx => Self::HEx,
            QuantityId::HDemag => Self::HDemag,
            QuantityId::DemagPhi => Self::DemagPhi,
            QuantityId::HExt => Self::HExt,
            QuantityId::HDrive => Self::HDrive,
            QuantityId::HEff => Self::HEff,
            QuantityId::Torque => Self::Torque,
            QuantityId::HAni => Self::HAni,
            QuantityId::HDmi => Self::HDmi,
            QuantityId::HMel => Self::HMel,
            QuantityId::HAniCubic => Self::HAniCubic,
            QuantityId::HDmiBulk => Self::HDmiBulk,
            QuantityId::HOe => Self::HOe,
            QuantityId::HTherm => Self::HTherm,
            _ => return None,
        })
    }
}

#[cfg(feature = "fem-gpu")]
fn fem_preview_observable(quantity: &str) -> Result<ffi::fullmag_fem_observable, RunError> {
    let id = normalize_quantity_id(quantity)?;
    let observable = NativeFemPreviewObservable::from_quantity(id).ok_or_else(|| RunError {
        message: format!(
            "native FEM preview quantity '{}' is not supported",
            id.as_str()
        ),
    })?;
    Ok(match observable {
        NativeFemPreviewObservable::M => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_M,
        NativeFemPreviewObservable::HEx => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EX,
        NativeFemPreviewObservable::HDemag => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DEMAG
        }
        NativeFemPreviewObservable::DemagPhi => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_DEMAG_PHI
        }
        NativeFemPreviewObservable::HExt => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EXT
        }
        NativeFemPreviewObservable::HDrive => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DRIVE
        }
        NativeFemPreviewObservable::HEff => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EFF
        }
        NativeFemPreviewObservable::Torque => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_TORQUE
        }
        NativeFemPreviewObservable::HAni => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI
        }
        NativeFemPreviewObservable::HDmi => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI
        }
        NativeFemPreviewObservable::HMel => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_MEL
        }
        NativeFemPreviewObservable::HAniCubic => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC
        }
        NativeFemPreviewObservable::HDmiBulk => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI_BULK
        }
        NativeFemPreviewObservable::HOe => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_OE,
        NativeFemPreviewObservable::HTherm => {
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_THERM
        }
    })
}

#[cfg(feature = "fem-gpu")]
pub(crate) struct NativeFemBackend {
    handle: *mut ffi::fullmag_fem_backend,
    stage_oersted_provider: Option<Box<StageOerstedProvider>>,
    stage_transport_provider: Option<Box<StageTransportProvider>>,
    magnetic_node_mask: Arc<[bool]>,
    frozen_mask: Option<Arc<[bool]>>,
    saturation_magnetisation_by_node: Arc<[f64]>,
    dg0_energy_projection: Option<Arc<Dg0EnergyProjection>>,
    energy_density_terms: NativeFemEnergyDensityTerms,
    cubic_energy_density: Option<Arc<NativeFemCubicEnergyDensity>>,
    object_weights: Vec<(String, f64)>,
    object_node_indices: Vec<(String, Vec<u32>)>,
    demag_solver: Option<String>,
    demag_preconditioner: Option<String>,
    adaptive_max_error: Option<f64>,
    backend_create_wall_time_ns: Option<u64>,
}

#[cfg(feature = "fem-gpu")]
#[derive(Debug)]
struct Dg0EnergyProjection {
    nodes: Arc<[[f64; 3]]>,
    elements: Arc<[[u32; 4]]>,
    magnetic_elements: Arc<[bool]>,
    saturation_magnetisation_by_element: Arc<[f64]>,
}

#[cfg(feature = "fem-gpu")]
fn resolved_drive_target_markers(
    plan: &fullmag_ir::FemPlanIR,
    target: &fullmag_ir::FieldTargetIR,
) -> Result<Vec<u32>, RunError> {
    use fullmag_ir::{FemMeshPartSelector, FieldTargetIR};
    let (object_id, region_id) = match target {
        FieldTargetIR::Global {} => return Ok(Vec::new()),
        FieldTargetIR::Object { object_id } => (object_id.as_str(), None),
        FieldTargetIR::Region {
            object_id,
            region_id,
        } => (object_id.as_str(), Some(region_id.as_str())),
    };
    let mut markers = BTreeSet::new();
    for part in &plan.mesh_parts {
        if part.object_id.as_deref() != Some(object_id)
            || region_id.is_some_and(|region| {
                part.id != region && part.geometry_id.as_deref() != Some(region)
            })
        {
            continue;
        }
        match &part.element_selector {
            FemMeshPartSelector::ElementMarkerSet { markers: values } => {
                markers.extend(values.iter().copied());
            }
            FemMeshPartSelector::ElementRange { start, count } => {
                let end = start.checked_add(*count).ok_or_else(|| RunError {
                    message: "FEM regional field drive element range overflows".to_string(),
                })? as usize;
                let start = *start as usize;
                if end > plan.mesh.element_markers.len() {
                    return Err(RunError {
                        message: "FEM regional field drive element range exceeds marker table"
                            .to_string(),
                    });
                }
                markers.extend(plan.mesh.element_markers[start..end].iter().copied());
            }
            _ => {}
        }
    }
    if markers.is_empty() && region_id.is_none() {
        for segment in &plan.object_segments {
            if segment.object_id != object_id {
                continue;
            }
            let start = segment.element_start as usize;
            let end = start + segment.element_count as usize;
            if end <= plan.mesh.element_markers.len() {
                markers.extend(plan.mesh.element_markers[start..end].iter().copied());
            }
        }
    }
    if markers.is_empty() {
        return Err(RunError {
            message: format!(
                "FEM regional field drive target could not be resolved to canonical element markers: object='{}'{}",
                object_id,
                region_id.map(|region| format!(", region='{region}'")).unwrap_or_default(),
            ),
        });
    }
    Ok(markers.into_iter().collect())
}

#[cfg(feature = "fem-gpu")]
fn flatten_native_geometry_mask(
    geometry: &fullmag_ir::GeometryEntryIR,
    nodes: &mut Vec<ffi::fullmag_fem_geometry_mask_node>,
) -> Result<u32, RunError> {
    use fullmag_ir::GeometryEntryIR;
    let blank = |kind, child_a, child_b| ffi::fullmag_fem_geometry_mask_node {
        kind,
        child_a,
        child_b,
        center_m: [0.0; 3],
        size_m: [0.0; 3],
        axis: [0.0; 3],
        radius_m: 0.0,
        height_m: 0.0,
        translation_m: [0.0; 3],
    };
    let node = match geometry {
        GeometryEntryIR::Box { size, .. } => {
            let mut node = blank(1, 0, 0); node.size_m = *size; node
        }
        GeometryEntryIR::Cylinder { radius, height, axis, .. } => {
            let mut node = blank(2, 0, 0); node.radius_m = *radius; node.height_m = *height; node.axis = *axis; node
        }
        GeometryEntryIR::Translate { base, by, .. } => {
            let child = flatten_native_geometry_mask(base, nodes)?;
            let mut node = blank(3, child, 0); node.translation_m = *by; node
        }
        GeometryEntryIR::Difference { base, tool, .. } => blank(
            4,
            flatten_native_geometry_mask(base, nodes)?,
            flatten_native_geometry_mask(tool, nodes)?,
        ),
        GeometryEntryIR::Union { a, b, .. } => blank(
            5,
            flatten_native_geometry_mask(a, nodes)?,
            flatten_native_geometry_mask(b, nodes)?,
        ),
        GeometryEntryIR::Intersection { a, b, .. } => blank(
            6,
            flatten_native_geometry_mask(a, nodes)?,
            flatten_native_geometry_mask(b, nodes)?,
        ),
        other => return Err(RunError { message: format!(
            "FEM regional field drive geometry mask '{}' uses unsupported primitive; supported: Box, Cylinder, Translate, Difference, Union, Intersection",
            other.name()) }),
    };
    let index = nodes.len() as u32;
    nodes.push(node);
    Ok(index)
}

#[cfg(feature = "fem-gpu")]
fn pack_native_sot_envelope(
    plan: &fullmag_ir::FemPlanIR,
) -> Result<
    (
        ffi::fullmag_fem_sot_envelope_desc,
        Vec<ffi::fullmag_fem_time_point>,
    ),
    RunError,
> {
    let mut descriptor = ffi::fullmag_fem_sot_envelope_desc {
        abi_version: ffi::FULLMAG_FEM_SOT_ENVELOPE_ABI_VERSION,
        struct_size: std::mem::size_of::<ffi::fullmag_fem_sot_envelope_desc>() as u32,
        kind: ffi::fullmag_fem_time_dependence_kind::FULLMAG_FEM_TIME_CONSTANT as u32,
        time_origin: ffi::fullmag_fem_time_origin::FULLMAG_FEM_TIME_ABSOLUTE as u32,
        amplitude: 1.0,
        frequency_hz: 0.0,
        phase_rad: 0.0,
        offset: 0.0,
        t_on_s: 0.0,
        t_off_s: 0.0,
        center_s: 0.0,
        bandwidth_hz: 0.0,
        points: std::ptr::null(),
        point_count: 0,
    };
    let mut points = Vec::new();
    let Some(envelope) = plan
        .spin_torque_contract
        .as_ref()
        .filter(|contract| contract.formula_version == "prescribed_sot.fullmag.v1")
        .and_then(|contract| contract.sot_envelope.as_ref())
    else {
        return Ok((descriptor, points));
    };
    match envelope {
        fullmag_ir::TimeEnvelopeIR::Constant { value } => {
            descriptor.amplitude = *value;
        }
        fullmag_ir::TimeEnvelopeIR::Sinusoidal {
            amplitude,
            frequency_hz,
            phase_rad,
            offset,
        } => {
            descriptor.kind =
                ffi::fullmag_fem_time_dependence_kind::FULLMAG_FEM_TIME_SINUSOIDAL as u32;
            descriptor.amplitude = *amplitude;
            descriptor.frequency_hz = *frequency_hz;
            descriptor.phase_rad = *phase_rad;
            descriptor.offset = *offset;
        }
        fullmag_ir::TimeEnvelopeIR::Pulse {
            amplitude,
            t_on_s,
            t_off_s,
        } => {
            descriptor.kind = ffi::fullmag_fem_time_dependence_kind::FULLMAG_FEM_TIME_PULSE as u32;
            descriptor.amplitude = *amplitude;
            descriptor.t_on_s = *t_on_s;
            descriptor.t_off_s = *t_off_s;
        }
        fullmag_ir::TimeEnvelopeIR::PiecewiseLinear { points: source } => {
            descriptor.kind =
                ffi::fullmag_fem_time_dependence_kind::FULLMAG_FEM_TIME_PIECEWISE_LINEAR as u32;
            points = source
                .iter()
                .map(|point| ffi::fullmag_fem_time_point {
                    time_s: point.time_s,
                    value: point.value,
                })
                .collect();
            descriptor.points = optional_slice_ptr(&points);
            descriptor.point_count = points.len() as u64;
        }
        fullmag_ir::TimeEnvelopeIR::Sinc {
            amplitude,
            center_s,
            bandwidth_hz,
            offset,
        } => {
            descriptor.kind =
                ffi::fullmag_fem_time_dependence_kind::FULLMAG_FEM_TIME_SINC_PULSE as u32;
            descriptor.amplitude = *amplitude;
            descriptor.center_s = *center_s;
            descriptor.bandwidth_hz = *bandwidth_hz;
            descriptor.offset = *offset;
        }
        fullmag_ir::TimeEnvelopeIR::Tabulated { artifact_ref, .. } => {
            return Err(RunError {
                message: format!(
                    "native FEM prescribed SOT tabulated envelope requires materialized artifact '{}'; planner keeps this lane fail-closed",
                    artifact_ref
                ),
            });
        }
    }
    Ok((descriptor, points))
}

#[cfg(feature = "fem-gpu")]
fn pack_native_regional_field_drives(
    plan: &fullmag_ir::FemPlanIR,
) -> Result<
    (
        Vec<ffi::fullmag_fem_regional_field_drive_desc>,
        Vec<Vec<u32>>,
        Vec<Vec<ffi::fullmag_fem_time_point>>,
        Vec<Vec<ffi::fullmag_fem_geometry_mask_node>>,
        Vec<Option<ffi::fullmag_fem_geometry_mask_desc>>,
    ),
    RunError,
> {
    use fullmag_ir::{FieldSpatialProfileIR, FieldTargetIR, FieldTimeOriginIR, TimeDependenceIR};
    let mut marker_storage = Vec::with_capacity(plan.field_drives.len());
    let mut point_storage = Vec::with_capacity(plan.field_drives.len());
    let mut geometry_node_storage = Vec::with_capacity(plan.field_drives.len());
    for drive in plan.field_drives.iter().filter(|drive| drive.enabled) {
        marker_storage.push(resolved_drive_target_markers(plan, &drive.target)?);
        point_storage.push(match &drive.waveform {
            TimeDependenceIR::PiecewiseLinear { points } => points
                .iter()
                .map(|point| ffi::fullmag_fem_time_point {
                    time_s: point[0],
                    value: point[1],
                })
                .collect(),
            _ => Vec::new(),
        });
        let mut nodes = Vec::new();
        if let FieldSpatialProfileIR::GeometryMask { object_id, .. } = &drive.spatial_profile {
            let geometry = plan.field_drive_geometry_masks.iter()
                .find(|entry| entry.name() == object_id)
                .ok_or_else(|| RunError { message: format!(
                    "FEM regional field drive '{}' geometry mask '{}' is absent from the resolved plan",
                    drive.id, object_id) })?;
            flatten_native_geometry_mask(geometry, &mut nodes)?;
        }
        geometry_node_storage.push(nodes);
    }
    let geometry_desc_storage: Vec<Option<ffi::fullmag_fem_geometry_mask_desc>> =
        geometry_node_storage
            .iter()
            .map(|nodes| {
                (!nodes.is_empty()).then(|| ffi::fullmag_fem_geometry_mask_desc {
                    abi_version: ffi::FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION,
                    struct_size: std::mem::size_of::<ffi::fullmag_fem_geometry_mask_desc>() as u32,
                    nodes: nodes.as_ptr(),
                    node_count: nodes.len() as u64,
                    root_index: (nodes.len() - 1) as u32,
                })
            })
            .collect();
    let mut descriptors = Vec::with_capacity(marker_storage.len());
    for (index, ((drive, markers), points)) in plan
        .field_drives
        .iter()
        .filter(|drive| drive.enabled)
        .zip(&marker_storage)
        .zip(&point_storage)
        .enumerate()
    {
        let target_kind = match drive.target {
            FieldTargetIR::Global {} => 0,
            FieldTargetIR::Object { .. } | FieldTargetIR::Region { .. } => 1,
        };
        let spatial_profile = match &drive.spatial_profile {
            FieldSpatialProfileIR::Uniform {} => ffi::fullmag_fem_spatial_profile_desc {
                abi_version: ffi::FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION,
                struct_size: std::mem::size_of::<ffi::fullmag_fem_spatial_profile_desc>() as u32,
                kind: 0,
                sinc_axis: [0.0; 3],
                sinc_period_m: 0.0,
                sinc_center_m: 0.0,
                sinc_width_m: 0.0,
                sinc_window: 0,
                geometry_mask: std::ptr::null(),
                gaussian_center_x_m: 0.0,
                gaussian_center_y_m: 0.0,
                gaussian_carrier_origin_x_m: 0.0,
                gaussian_sigma_x_m: 0.0,
                gaussian_sigma_y_m: 0.0,
                gaussian_wavelength_m: 0.0,
                gaussian_carrier_phase_rad: 0.0,
            },
            FieldSpatialProfileIR::Sinc {
                axis,
                period_m,
                center_m,
                width_m,
                window,
            } => ffi::fullmag_fem_spatial_profile_desc {
                abi_version: ffi::FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION,
                struct_size: std::mem::size_of::<ffi::fullmag_fem_spatial_profile_desc>() as u32,
                kind: 1,
                sinc_axis: *axis,
                sinc_period_m: *period_m,
                sinc_center_m: *center_m,
                sinc_width_m: width_m.unwrap_or(0.0),
                sinc_window: if window == "hann" { 1 } else { 0 },
                geometry_mask: std::ptr::null(),
                gaussian_center_x_m: 0.0,
                gaussian_center_y_m: 0.0,
                gaussian_carrier_origin_x_m: 0.0,
                gaussian_sigma_x_m: 0.0,
                gaussian_sigma_y_m: 0.0,
                gaussian_wavelength_m: 0.0,
                gaussian_carrier_phase_rad: 0.0,
            },
            FieldSpatialProfileIR::GeometryMask { envelope, .. } => {
                let (axis, period, center, width, window) = match envelope {
                    fullmag_ir::FieldEnvelopeIR::Uniform {} => ([0.0; 3], 0.0, 0.0, 0.0, 0),
                    fullmag_ir::FieldEnvelopeIR::Sinc {
                        axis,
                        period_m,
                        center_m,
                        width_m,
                        window,
                    } => (
                        *axis,
                        *period_m,
                        *center_m,
                        width_m.unwrap_or(0.0),
                        if window == "hann" { 1 } else { 0 },
                    ),
                };
                ffi::fullmag_fem_spatial_profile_desc {
                    abi_version: ffi::FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION,
                    struct_size: std::mem::size_of::<ffi::fullmag_fem_spatial_profile_desc>()
                        as u32,
                    kind: 2,
                    sinc_axis: axis,
                    sinc_period_m: period,
                    sinc_center_m: center,
                    sinc_width_m: width,
                    sinc_window: window,
                    geometry_mask: geometry_desc_storage[index]
                        .as_ref()
                        .map_or(std::ptr::null(), |descriptor| descriptor as *const _),
                    gaussian_center_x_m: 0.0,
                    gaussian_center_y_m: 0.0,
                    gaussian_carrier_origin_x_m: 0.0,
                    gaussian_sigma_x_m: 0.0,
                    gaussian_sigma_y_m: 0.0,
                    gaussian_wavelength_m: 0.0,
                    gaussian_carrier_phase_rad: 0.0,
                }
            }
            FieldSpatialProfileIR::GaussianPlaneWave {
                center_x_m,
                center_y_m,
                carrier_origin_x_m,
                sigma_x_m,
                sigma_y_m,
                wavelength_m,
                carrier_phase_rad,
            } => ffi::fullmag_fem_spatial_profile_desc {
                abi_version: ffi::FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION,
                struct_size: std::mem::size_of::<ffi::fullmag_fem_spatial_profile_desc>() as u32,
                kind: 3,
                sinc_axis: [0.0; 3],
                sinc_period_m: 0.0,
                sinc_center_m: 0.0,
                sinc_width_m: 0.0,
                sinc_window: 0,
                geometry_mask: std::ptr::null(),
                gaussian_center_x_m: *center_x_m,
                gaussian_center_y_m: *center_y_m,
                gaussian_carrier_origin_x_m: *carrier_origin_x_m,
                gaussian_sigma_x_m: *sigma_x_m,
                gaussian_sigma_y_m: *sigma_y_m,
                gaussian_wavelength_m: *wavelength_m,
                gaussian_carrier_phase_rad: *carrier_phase_rad,
            },
        };
        let mut parameters = ffi::fullmag_fem_time_dependence_parameters {
            sinusoidal: ffi::fullmag_fem_sinusoidal_time_desc {
                frequency_hz: 0.0,
                phase_rad: 0.0,
                offset: 0.0,
            },
        };
        let waveform_kind = match &drive.waveform {
            TimeDependenceIR::Constant => 0,
            TimeDependenceIR::Sinusoidal {
                frequency_hz,
                phase_rad,
                offset,
            } => {
                parameters.sinusoidal = ffi::fullmag_fem_sinusoidal_time_desc {
                    frequency_hz: *frequency_hz,
                    phase_rad: *phase_rad,
                    offset: *offset,
                };
                1
            }
            TimeDependenceIR::Pulse { t_on, t_off } => {
                parameters.pulse = ffi::fullmag_fem_pulse_time_desc {
                    t_on_s: *t_on,
                    t_off_s: *t_off,
                };
                2
            }
            TimeDependenceIR::PiecewiseLinear { .. } => 3,
            TimeDependenceIR::SincPulse {
                cutoff_hz,
                t0,
                amplitude,
            } => {
                parameters.sinc_pulse = ffi::fullmag_fem_sinc_pulse_time_desc {
                    cutoff_hz: *cutoff_hz,
                    t0_s: *t0,
                    amplitude: *amplitude,
                };
                4
            }
        };
        let digest = Sha256::digest(drive.id.as_bytes());
        let stable_id_hash = u64::from_le_bytes(digest[..8].try_into().expect("SHA-256 prefix"));
        descriptors.push(ffi::fullmag_fem_regional_field_drive_desc {
            abi_version: ffi::FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_regional_field_drive_desc>() as u32,
            stable_id_hash,
            target: ffi::fullmag_fem_field_target_desc {
                abi_version: ffi::FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION,
                struct_size: std::mem::size_of::<ffi::fullmag_fem_field_target_desc>() as u32,
                kind: target_kind,
                element_markers: optional_slice_ptr(markers),
                element_marker_count: markers.len() as u64,
            },
            spatial_profile,
            amplitude_b_t: drive.amplitude_b_t,
            direction: drive.direction,
            waveform: ffi::fullmag_fem_time_dependence_desc {
                abi_version: ffi::FULLMAG_FEM_REGIONAL_FIELD_DRIVE_ABI_VERSION,
                struct_size: std::mem::size_of::<ffi::fullmag_fem_time_dependence_desc>() as u32,
                kind: waveform_kind,
                parameters,
                points: optional_slice_ptr(points),
                point_count: points.len() as u64,
            },
            time_origin: match drive.time_origin {
                FieldTimeOriginIR::StageLocal => 0,
                FieldTimeOriginIR::Absolute => 1,
            },
        });
    }
    Ok((
        descriptors,
        marker_storage,
        point_storage,
        geometry_node_storage,
        geometry_desc_storage,
    ))
}

#[derive(Debug, Clone, Copy)]
#[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
struct NativeFemEnergyDensityTerms {
    exchange: bool,
    demag: bool,
    external: bool,
    uniaxial_anisotropy: bool,
    cubic_anisotropy: bool,
    interfacial_dmi: bool,
    bulk_dmi: bool,
}

impl NativeFemEnergyDensityTerms {
    fn from_plan(plan: &fullmag_ir::FemPlanIR) -> Self {
        Self {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external: plan.external_field.is_some(),
            uniaxial_anisotropy: native_fem_plan_has_uniaxial_anisotropy(plan),
            cubic_anisotropy: native_fem_plan_has_cubic_anisotropy(plan),
            interfacial_dmi: plan.interfacial_dmi.is_some()
                || plan
                    .dind_field
                    .as_ref()
                    .is_some_and(|values| !values.is_empty()),
            bulk_dmi: plan.bulk_dmi.is_some()
                || plan
                    .dbulk_field
                    .as_ref()
                    .is_some_and(|values| !values.is_empty()),
        }
    }

    fn observables_for(&self, quantity: &str) -> Option<Vec<(&'static str, f64)>> {
        let mut terms = Vec::new();
        match quantity {
            "eden_ex" => terms.push(("H_ex", -0.5)),
            "eden_demag" => terms.push(("H_demag", -0.5)),
            "eden_ext" => terms.push(("H_ext", -1.0)),
            "eden_ani" => {
                if self.uniaxial_anisotropy {
                    terms.push(("H_ani", -0.5));
                }
            }
            "eden_dmi" => {
                if self.interfacial_dmi {
                    terms.push(("H_dmi", -0.5));
                }
                if self.bulk_dmi {
                    terms.push(("H_dmi_bulk", -0.5));
                }
            }
            "eden_total" => {
                if self.exchange {
                    terms.push(("H_ex", -0.5));
                }
                if self.demag {
                    terms.push(("H_demag", -0.5));
                }
                if self.external {
                    terms.push(("H_ext", -1.0));
                }
                if self.uniaxial_anisotropy {
                    terms.push(("H_ani", -0.5));
                }
                if self.interfacial_dmi {
                    terms.push(("H_dmi", -0.5));
                }
                if self.bulk_dmi {
                    terms.push(("H_dmi_bulk", -0.5));
                }
            }
            _ => return None,
        }
        Some(terms)
    }

    #[cfg(feature = "fem-gpu")]
    fn includes_cubic(&self, quantity: &str) -> bool {
        self.cubic_anisotropy && matches!(quantity, "eden_ani" | "eden_total")
    }
}

pub(crate) fn can_materialize_preview_quantity(
    plan: &fullmag_ir::FemPlanIR,
    id: QuantityId,
) -> bool {
    (id == QuantityId::FrozenSpins && plan.frozen_spins.is_some())
        || NativeFemPreviewObservable::from_quantity(id).is_some()
        || NativeFemEnergyDensityTerms::from_plan(plan)
            .observables_for(id.as_str())
            .is_some()
}

#[cfg(feature = "fem-gpu")]
#[derive(Debug)]
struct NativeFemCubicEnergyDensity {
    kc1_by_node: Arc<[f64]>,
    kc2_by_node: Arc<[f64]>,
    kc3_by_node: Arc<[f64]>,
    axis1: [f64; 3],
    axis2: [f64; 3],
}

#[cfg(feature = "fem-gpu")]
fn resolved_nodal_material_coefficient(
    name: &str,
    uniform: f64,
    field: Option<&[f64]>,
    node_count: usize,
) -> Result<Arc<[f64]>, RunError> {
    let values = match field {
        Some(values) if values.len() != node_count => {
            return Err(RunError {
                message: format!(
                    "native FEM nodal {name} field has {} values for {node_count} mesh nodes",
                    values.len()
                ),
            });
        }
        Some(values) => values.to_vec(),
        None => vec![uniform; node_count],
    };
    if values.iter().any(|value| !value.is_finite()) {
        return Err(RunError {
            message: format!("native FEM resolved nodal {name} values must be finite"),
        });
    }
    Ok(values.into())
}

#[cfg(feature = "fem-gpu")]
fn resolved_cubic_energy_density(
    plan: &fullmag_ir::FemPlanIR,
) -> Result<Option<Arc<NativeFemCubicEnergyDensity>>, RunError> {
    if !native_fem_plan_has_cubic_anisotropy(plan) {
        return Ok(None);
    }
    let node_count = plan.mesh.nodes.len();
    Ok(Some(Arc::new(NativeFemCubicEnergyDensity {
        kc1_by_node: resolved_nodal_material_coefficient(
            "Kc1",
            plan.material.cubic_anisotropy_kc1.unwrap_or(0.0),
            plan.material.kc1_field.as_deref(),
            node_count,
        )?,
        kc2_by_node: resolved_nodal_material_coefficient(
            "Kc2",
            plan.material.cubic_anisotropy_kc2.unwrap_or(0.0),
            plan.material.kc2_field.as_deref(),
            node_count,
        )?,
        kc3_by_node: resolved_nodal_material_coefficient(
            "Kc3",
            plan.material.cubic_anisotropy_kc3.unwrap_or(0.0),
            plan.material.kc3_field.as_deref(),
            node_count,
        )?,
        axis1: plan
            .material
            .cubic_anisotropy_axis1
            .unwrap_or([1.0, 0.0, 0.0]),
        axis2: plan
            .material
            .cubic_anisotropy_axis2
            .unwrap_or([0.0, 1.0, 0.0]),
    })))
}

fn native_fem_plan_has_uniaxial_anisotropy(plan: &fullmag_ir::FemPlanIR) -> bool {
    plan.material.uniaxial_anisotropy.is_some()
        || plan.material.uniaxial_anisotropy_k2.is_some()
        || plan
            .material
            .ku_field
            .as_ref()
            .is_some_and(|values| !values.is_empty())
        || plan
            .material
            .ku2_field
            .as_ref()
            .is_some_and(|values| !values.is_empty())
}

fn native_fem_plan_has_cubic_anisotropy(plan: &fullmag_ir::FemPlanIR) -> bool {
    plan.material.cubic_anisotropy_kc1.is_some()
        || plan.material.cubic_anisotropy_kc2.is_some()
        || plan.material.cubic_anisotropy_kc3.is_some()
        || plan
            .material
            .kc1_field
            .as_ref()
            .is_some_and(|values| !values.is_empty())
        || plan
            .material
            .kc2_field
            .as_ref()
            .is_some_and(|values| !values.is_empty())
        || plan
            .material
            .kc3_field
            .as_ref()
            .is_some_and(|values| !values.is_empty())
}

#[cfg(feature = "fem-gpu")]
fn project_element_scalars_to_nodes(
    mesh: &fullmag_ir::MeshIR,
    element_values: &[f64],
) -> Result<Vec<f64>, RunError> {
    let elements = mesh.require_tet4_elements().map_err(|error| RunError {
        message: format!(
            "native FEM DG0 projection requires tet4 cells; mixed-cell execution is unavailable: {error}"
        ),
    })?;
    if element_values.len() != elements.len() {
        return Err(RunError {
            message: format!(
                "native FEM DG0 projection received {} coefficients for {} elements",
                element_values.len(),
                elements.len()
            ),
        });
    }
    let mixed_air_domain = mesh.element_markers.iter().any(|marker| *marker == 0)
        && mesh.element_markers.iter().any(|marker| *marker != 0);
    let mut weighted_values = vec![0.0; mesh.nodes.len()];
    let mut lumped_volumes = vec![0.0; mesh.nodes.len()];
    for (element_index, (element, value)) in elements.iter().zip(element_values).enumerate() {
        if mixed_air_domain
            && mesh
                .element_markers
                .get(element_index)
                .is_some_and(|marker| *marker == 0)
        {
            continue;
        }
        if !value.is_finite() || *value < 0.0 {
            return Err(RunError {
                message: format!(
                    "native FEM DG0 projection coefficient at element {element_index} must be finite and non-negative"
                ),
            });
        }
        let [a, b, c, d] = element.map(|index| {
            mesh.nodes
                .get(index as usize)
                .copied()
                .ok_or_else(|| RunError {
                    message: format!(
                        "native FEM DG0 projection element {element_index} references missing node {index}"
                    ),
                })
        });
        let (a, b, c, d) = (a?, b?, c?, d?);
        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        let cross = [
            ac[1] * ad[2] - ac[2] * ad[1],
            ac[2] * ad[0] - ac[0] * ad[2],
            ac[0] * ad[1] - ac[1] * ad[0],
        ];
        let volume = (ab[0] * cross[0] + ab[1] * cross[1] + ab[2] * cross[2]).abs() / 6.0;
        if !volume.is_finite() || volume <= 0.0 {
            return Err(RunError {
                message: format!(
                    "native FEM DG0 projection element {element_index} has non-positive volume"
                ),
            });
        }
        let lumped_volume = volume * 0.25;
        for node_index in element {
            let node_index = *node_index as usize;
            weighted_values[node_index] += lumped_volume * *value;
            lumped_volumes[node_index] += lumped_volume;
        }
    }
    Ok(weighted_values
        .into_iter()
        .zip(lumped_volumes)
        .map(|(weighted_value, lumped_volume)| {
            if lumped_volume > 0.0 {
                weighted_value / lumped_volume
            } else {
                0.0
            }
        })
        .collect())
}

#[cfg(feature = "fem-gpu")]
fn resolved_saturation_magnetisation_by_node(
    plan: &fullmag_ir::FemPlanIR,
) -> Result<Vec<f64>, RunError> {
    let values = if let Some(element_values) = plan.ms_element_field.as_deref() {
        project_element_scalars_to_nodes(&plan.mesh, element_values)?
    } else if let Some(node_values) = plan.material.ms_field.as_ref() {
        if node_values.len() != plan.mesh.nodes.len() {
            return Err(RunError {
                message: format!(
                    "native FEM nodal Ms field has {} values for {} mesh nodes",
                    node_values.len(),
                    plan.mesh.nodes.len()
                ),
            });
        }
        node_values.clone()
    } else {
        vec![plan.material.saturation_magnetisation; plan.mesh.nodes.len()]
    };
    if values
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err(RunError {
            message: "native FEM resolved nodal Ms values must be finite and non-negative"
                .to_string(),
        });
    }
    Ok(values)
}

#[cfg(feature = "fem-gpu")]
fn build_native_fem_energy_density_preview_field(
    request: &LivePreviewRequest,
    values: &[f64],
    active_mask: Vec<bool>,
    conservative_dg0_energy: bool,
) -> LivePreviewField {
    let mut field =
        build_mesh_scalar_preview_field_with_active_mask(request, values, Some(active_mask));
    field.spatial_kind = if conservative_dg0_energy {
        "fem_nodal_conservative_tetra_projection".to_string()
    } else {
        "fem_nodal_visualization_projection".to_string()
    };
    field
}

#[cfg(feature = "fem-gpu")]
fn build_native_fem_frozen_spins_preview_field(
    request: &LivePreviewRequest,
    frozen_mask: &[bool],
    active_mask: &[bool],
) -> Result<LivePreviewField, RunError> {
    if frozen_mask.len() != active_mask.len() {
        return Err(RunError {
            message: format!(
                "native FEM Frozen Spins mask length {} differs from magnetic node mask length {}",
                frozen_mask.len(),
                active_mask.len()
            ),
        });
    }
    let values = frozen_mask
        .iter()
        .map(|frozen| f64::from(*frozen))
        .collect::<Vec<_>>();
    Ok(build_mesh_scalar_preview_field_with_active_mask(
        request,
        &values,
        Some(active_mask.to_vec()),
    ))
}

#[cfg(feature = "fem-gpu")]
#[derive(Debug)]
pub(crate) struct NativeFemPreviewSnapshot {
    handle: *mut ffi::fullmag_fem_preview_snapshot,
    request: LivePreviewRequest,
    active_mask: Option<Arc<[bool]>>,
    host_frozen_mask: Option<Arc<[bool]>>,
}

#[cfg(feature = "fem-gpu")]
unsafe impl Send for NativeFemPreviewSnapshot {}

#[cfg(feature = "fem-gpu")]
#[derive(Debug)]
pub(crate) struct NativeFemFieldSnapshot {
    handle: *mut ffi::fullmag_fem_field_snapshot,
    pub(crate) name: String,
    pub(crate) step: u64,
    pub(crate) time: f64,
    pub(crate) solver_dt: f64,
}

#[cfg(feature = "fem-gpu")]
unsafe impl Send for NativeFemFieldSnapshot {}

#[cfg(feature = "fem-gpu")]
#[derive(Debug)]
pub(crate) struct NativeFemEnergyDensitySnapshot {
    request: LivePreviewRequest,
    magnetization: NativeFemFieldSnapshot,
    terms: Vec<(bool, f64, NativeFemFieldSnapshot)>,
    cubic_energy_density: Option<Arc<NativeFemCubicEnergyDensity>>,
    saturation_magnetisation_by_node: Arc<[f64]>,
    dg0_energy_projection: Option<Arc<Dg0EnergyProjection>>,
    active_mask: Arc<[bool]>,
    node_count: usize,
}

#[cfg(feature = "fem-gpu")]
unsafe impl Send for NativeFemEnergyDensitySnapshot {}

#[cfg(feature = "fem-gpu")]
#[derive(Debug, Clone, Copy)]
pub(crate) struct NativeFemFieldSnapshotInfo {
    pub node_count: usize,
    pub component_count: usize,
    pub scalar_bytes: usize,
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
fn native_fem_matching_object_part<'a>(
    plan: &'a fullmag_ir::FemPlanIR,
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> Option<&'a fullmag_ir::FemMeshPartIR> {
    plan.mesh_parts.iter().find(|part| {
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
}

#[cfg(feature = "fem-gpu")]
fn native_fem_segment_node_indices(
    plan: &fullmag_ir::FemPlanIR,
    segment: &fullmag_ir::FemObjectSegmentIR,
) -> Vec<u32> {
    if let Some(part) = native_fem_matching_object_part(plan, segment) {
        if !part.node_indices.is_empty() {
            return part
                .node_indices
                .iter()
                .copied()
                .filter(|index| (*index as usize) < plan.mesh.nodes.len())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
        }
        if let fullmag_ir::FemMeshPartSelector::NodeRange { start, count } = &part.node_selector {
            let end = start
                .saturating_add(*count)
                .min(plan.mesh.nodes.len() as u32);
            return (*start..end).collect();
        }
    }

    let start = segment.node_start.min(plan.mesh.nodes.len() as u32);
    let end = segment
        .node_start
        .saturating_add(segment.node_count)
        .min(plan.mesh.nodes.len() as u32);
    if end <= start {
        Vec::new()
    } else {
        (start..end).collect()
    }
}

#[cfg(feature = "fem-gpu")]
fn native_fem_object_node_indices(plan: &fullmag_ir::FemPlanIR) -> Vec<(String, Vec<u32>)> {
    if plan.object_segments.is_empty() {
        return vec![(
            "free".to_string(),
            (0..plan.mesh.nodes.len() as u32).collect(),
        )];
    }

    let mut by_object: HashMap<String, BTreeSet<u32>> = HashMap::new();
    for segment in &plan.object_segments {
        if segment.object_id == "__air__" {
            continue;
        }
        let nodes = native_fem_segment_node_indices(plan, segment);
        if nodes.is_empty() {
            continue;
        }
        by_object
            .entry(segment.object_id.clone())
            .or_default()
            .extend(nodes);
    }

    let mut collected = by_object
        .into_iter()
        .map(|(object_id, nodes)| (object_id, nodes.into_iter().collect::<Vec<_>>()))
        .filter(|(_, nodes)| !nodes.is_empty())
        .collect::<Vec<_>>();
    collected.sort_by(|a, b| a.0.cmp(&b.0));
    if collected.is_empty() {
        vec![(
            "free".to_string(),
            (0..plan.mesh.nodes.len() as u32).collect(),
        )]
    } else {
        collected
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

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn managed_fem_runtime_root() -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("FULLMAG_FEM_RUNTIME_ROOT").map(PathBuf::from) {
        if root.join("openmpi/share/openmpi").is_dir() {
            return Some(root);
        }
    }
    if let Some(root) = std::env::var_os("FULLMAG_REPO_ROOT")
        .map(PathBuf::from)
        .map(|root| root.join(".fullmag/runtimes/fem-gpu-host"))
    {
        if root.join("openmpi/share/openmpi").is_dir() {
            return Some(root);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent().and_then(Path::parent) {
            let root = root.to_path_buf();
            if root.join("openmpi/share/openmpi").is_dir() {
                return Some(root);
            }
        }
    }
    let dev_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(".fullmag/runtimes/fem-gpu-host");
    if dev_root.join("openmpi/share/openmpi").is_dir() {
        return Some(dev_root);
    }
    None
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn set_env_if_missing(key: &str, value: impl AsRef<std::ffi::OsStr>) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn configure_openmpi_loopback_oob_if_missing() {
    set_env_if_missing("OMPI_MCA_oob", "tcp");
    if std::env::var_os("OMPI_MCA_oob_tcp_if_include").is_none()
        && std::env::var_os("OMPI_MCA_oob_tcp_if_exclude").is_none()
    {
        std::env::set_var("OMPI_MCA_oob_tcp_if_include", "lo");
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn configure_pmix_loopback_ptl_if_missing() {
    if std::env::var_os("PMIX_MCA_ptl_tcp_if_include").is_none()
        && std::env::var_os("PMIX_MCA_ptl_tcp_if_exclude").is_none()
    {
        std::env::set_var("PMIX_MCA_ptl_tcp_if_include", "lo");
    }
}

#[cfg(any(feature = "fem-gpu", feature = "fem-native"))]
fn configure_managed_openmpi_environment() {
    let Some(runtime_root) = managed_fem_runtime_root() else {
        return;
    };
    let openmpi_root = runtime_root.join("openmpi");
    if openmpi_root
        .join("share/openmpi/help-mpi-runtime.txt")
        .is_file()
    {
        set_env_if_missing("OPAL_PREFIX", &openmpi_root);
        set_env_if_missing(
            "OMPI_MCA_mca_base_component_path",
            openmpi_root.join("lib/openmpi3"),
        );
        set_env_if_missing("OMPI_MCA_orte_launch_agent", openmpi_root.join("bin/orted"));
        set_env_if_missing("OMPI_MCA_ess", "singleton");
        set_env_if_missing("OMPI_MCA_plm", "isolated");
        set_env_if_missing("OMPI_MCA_pmix", "isolated");
        set_env_if_missing("OMPI_MCA_ras", "simulator");
        set_env_if_missing("OMPI_MCA_rmaps", "seq");
        set_env_if_missing("OMPI_MCA_routed", "direct");
        set_env_if_missing("OMPI_MCA_reachable", "weighted");
        set_env_if_missing("OMPI_MCA_mca_base_component_show_load_errors", "0");
        set_env_if_missing("OMPI_MCA_btl", "self");
        configure_openmpi_loopback_oob_if_missing();
    }
    let pmix_root = runtime_root.join("lib/pmix2");
    if pmix_root.join("share/pmix/help-pmix-runtime.txt").is_file() {
        set_env_if_missing("PMIX_PREFIX", &pmix_root);
        set_env_if_missing("PMIX_EXEC_PREFIX", &pmix_root);
        set_env_if_missing("PMIX_DATADIR", pmix_root.join("share"));
        set_env_if_missing("PMIX_PKGDATADIR", pmix_root.join("share/pmix"));
        set_env_if_missing("PMIX_LIBDIR", pmix_root.join("lib"));
        set_env_if_missing(
            "PMIX_MCA_mca_base_component_path",
            pmix_root.join("lib/pmix"),
        );
        set_env_if_missing("PMIX_MCA_pcompress_base_silence_warning", "1");
        configure_pmix_loopback_ptl_if_missing();
    }
}

#[cfg(feature = "fem-gpu")]
impl NativeFemBackend {
    pub(crate) fn install_stage_oersted_provider(
        &mut self,
        mut provider: Box<StageOerstedProvider>,
    ) -> Result<(), RunError> {
        let callback = provider.callback();
        let status = unsafe {
            ffi::fullmag_fem_backend_set_stage_oersted_callback_v1(self.handle, &callback)
        };
        if status != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("installing native FEM stage Oersted callback failed"));
        }
        self.stage_oersted_provider = Some(provider);
        Ok(())
    }

    pub(crate) fn install_stage_transport_provider(
        &mut self,
        mut provider: Box<StageTransportProvider>,
    ) -> Result<(), RunError> {
        let callback = provider.callback();
        let status = unsafe {
            ffi::fullmag_fem_backend_set_stage_transport_callback_v1(self.handle, &callback)
        };
        if status != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("installing native FEM stage transport callback failed"));
        }
        self.stage_transport_provider = Some(provider);
        Ok(())
    }

    pub(crate) fn stage_oersted_telemetry(&self) -> Option<serde_json::Value> {
        self.stage_oersted_provider
            .as_ref()
            .map(|provider| provider.telemetry())
    }

    pub(crate) fn stage_transport_telemetry(&self) -> Option<serde_json::Value> {
        self.stage_transport_provider
            .as_ref()
            .map(|provider| provider.telemetry())
    }

    pub(crate) fn begin_stage(&mut self, stage_start_time_s: f64) -> Result<(), RunError> {
        if !stage_start_time_s.is_finite() || stage_start_time_s < 0.0 {
            return Err(RunError {
                message: "native FEM stage start time must be finite and non-negative".to_string(),
            });
        }
        let rc = unsafe { ffi::fullmag_fem_backend_begin_stage(self.handle, stage_start_time_s) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("beginning native FEM stage failed"));
        }
        Ok(())
    }

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
        let backend_create_started = std::time::Instant::now();
        configure_managed_openmpi_environment();
        let inferred_element_markers = normalized_native_runtime_element_markers(plan)?;
        let runtime_plan;
        let plan = if let Some(element_markers) = inferred_element_markers {
            runtime_plan = {
                let mut runtime_plan = plan.clone();
                runtime_plan.mesh.element_markers = element_markers;
                runtime_plan
            };
            &runtime_plan
        } else {
            plan
        };
        fullmag_ir::validate_mesh_for_execution(&plan.mesh).map_err(|errors| RunError {
            message: format!(
                "native FEM mesh validation failed before ABI packaging: {}",
                errors.join("; ")
            ),
        })?;
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
        let saturation_magnetisation_by_node = resolved_saturation_magnetisation_by_node(plan)?;
        let dg0_energy_projection =
            if plan.enable_exchange && plan.use_consistent_mass == Some(true) {
                plan.ms_element_field
                    .as_ref()
                    .map(|values| -> Result<_, RunError> {
                        let elements =
                            plan.mesh
                                .require_tet4_elements()
                                .map_err(|error| RunError {
                                    message: format!(
                                        "DG0 consistent-mass projection is tet4-only: {error}"
                                    ),
                                })?;
                        Ok(Arc::new(Dg0EnergyProjection {
                            nodes: plan.mesh.nodes.clone().into(),
                            elements: elements.into(),
                            magnetic_elements: plan
                                .mesh
                                .element_markers
                                .iter()
                                .map(|marker| *marker != 0)
                                .collect::<Vec<_>>()
                                .into(),
                            saturation_magnetisation_by_element: values.clone().into(),
                        }))
                    })
                    .transpose()?
            } else {
                None
            };
        let cubic_energy_density = resolved_cubic_energy_density(plan)?;
        let packed_mesh = PackedNativeMesh::new(&plan.mesh);
        let m_flat: Vec<f64> = plan
            .initial_magnetization
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();
        let (
            regional_field_drive_descs,
            _regional_marker_storage,
            _regional_point_storage,
            _regional_geometry_node_storage,
            _regional_geometry_desc_storage,
        ) = pack_native_regional_field_drives(plan)?;
        let (sot_envelope, _sot_envelope_points) = pack_native_sot_envelope(plan)?;

        let mesh = packed_mesh.descriptor(&plan.mesh);

        let material = ffi::fullmag_fem_material_desc {
            saturation_magnetisation: plan.material.saturation_magnetisation,
            exchange_stiffness: plan.material.exchange_stiffness,
            damping: plan.material.damping,
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
        };
        let anisotropy_axis_x_field: Vec<f64> = plan
            .anisotropy_axis_field
            .as_ref()
            .map(|axes| axes.iter().map(|axis| axis[0]).collect())
            .unwrap_or_default();
        let anisotropy_axis_y_field: Vec<f64> = plan
            .anisotropy_axis_field
            .as_ref()
            .map(|axes| axes.iter().map(|axis| axis[1]).collect())
            .unwrap_or_default();
        let anisotropy_axis_z_field: Vec<f64> = plan
            .anisotropy_axis_field
            .as_ref()
            .map(|axes| axes.iter().map(|axis| axis[2]).collect())
            .unwrap_or_default();
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
        let stt_contract = plan.spin_torque_contract.as_ref().filter(|contract| {
            contract.formula_version.starts_with("slonczewski.")
                || contract.formula_version.starts_with("zhang_li.")
        });
        let sot_contract = plan
            .spin_torque_contract
            .as_ref()
            .filter(|contract| contract.formula_version == "prescribed_sot.fullmag.v1");
        let stt_active_node_mask = stt_contract
            .and_then(|contract| contract.active_node_mask.as_ref())
            .map(|mask| {
                mask.iter()
                    .map(|selected| u8::from(*selected))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let stt_active_element_mask = stt_contract
            .and_then(|contract| contract.active_element_mask.as_ref())
            .map(|mask| {
                mask.iter()
                    .map(|selected| u8::from(*selected))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let stt_formula_version = match stt_contract
            .map(|contract| contract.formula_version.as_str())
        {
            None | Some("slonczewski.legacy_fullmag.v0") | Some("zhang_li.legacy_fullmag.v0") => 0,
            Some("slonczewski.fullmag.v2") => 3,
            Some("zhang_li.fullmag.v1") => 2,
            Some(_) => u32::MAX,
        };
        let stt_realization_version =
            match stt_contract.and_then(|contract| contract.realization_version.as_deref()) {
                None => 0,
                Some("slonczewski_thin_layer_homogenized.v1") => 1,
                Some("slonczewski_interface_flux.v1") => 2,
                Some(_) => u32::MAX,
            };
        let stt_operator_version =
            match stt_contract.and_then(|contract| contract.operator_version.as_deref()) {
                None => 0,
                Some("zl_central_reference_v1") => 1,
                Some(_) => u32::MAX,
            };
        let sot_active_node_mask = sot_contract
            .and_then(|contract| contract.active_node_mask.as_ref())
            .map(|mask| {
                mask.iter()
                    .map(|selected| u8::from(*selected))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let sot_envelope_value = sot_contract
            .and_then(|contract| contract.sot_envelope.as_ref())
            .and_then(|envelope| match envelope {
                fullmag_ir::TimeEnvelopeIR::Constant { value } => Some(*value),
                _ => None,
            })
            .unwrap_or(1.0);
        let frozen_mask = plan.frozen_spins.as_ref().map(|frozen| {
            frozen
                .frozen_mask
                .iter()
                .map(|selected| u8::from(*selected))
                .collect::<Vec<_>>()
        });

        let mut plan_desc = ffi::fullmag_fem_plan_desc {
            mesh,
            material,
            fe_order: plan.fe_order,
            hmax: plan.hmax,
            precision,
            // The native descriptor remains layout-compatible across algorithm
            // families; direct minimizers ignore this ABI-only slot.
            integrator: match plan
                .integrator
                .unwrap_or(fullmag_ir::IntegratorChoice::Heun)
            {
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
                let policy = resolved_native_fem_demag_solver_policy(plan);
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
            dt_seconds: resolve_native_fem_plan_dt_seconds(plan)?,
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
                let relaxation = plan.relaxation.as_ref();
                let stop = relaxation.map(|control| &control.stop);
                let llg_relaxation_time_s = relaxation.and_then(|control| {
                    (control.algorithm == fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped)
                        .then_some(control.stop.max_relaxation_time_s)
                        .flatten()
                });
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
                    has_max_pseudotime_s: 0,
                    max_pseudotime_s: 0.0,
                    has_max_physical_time_s: if llg_relaxation_time_s.is_some() {
                        1
                    } else {
                        0
                    },
                    max_physical_time_s: llg_relaxation_time_s.unwrap_or(0.0),
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
            anisotropy_axis_x_field: optional_slice_ptr(&anisotropy_axis_x_field),
            anisotropy_axis_x_field_len: anisotropy_axis_x_field.len() as u64,
            anisotropy_axis_y_field: optional_slice_ptr(&anisotropy_axis_y_field),
            anisotropy_axis_y_field_len: anisotropy_axis_y_field.len() as u64,
            anisotropy_axis_z_field: optional_slice_ptr(&anisotropy_axis_z_field),
            anisotropy_axis_z_field_len: anisotropy_axis_z_field.len() as u64,
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
            ms_element_field: plan
                .ms_element_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            ms_element_field_len: plan.ms_element_field.as_ref().map_or(0, |v| v.len() as u64),
            a_element_field: plan
                .a_element_field
                .as_deref()
                .map_or(std::ptr::null(), |s| s.as_ptr()),
            a_element_field_len: plan.a_element_field.as_ref().map_or(0, |v| v.len() as u64),
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
            stt_formula_version,
            stt_realization_version,
            stt_operator_version,
            stt_stack_normal: stt_contract
                .and_then(|contract| contract.stack_normal)
                .unwrap_or([0.0, 0.0, 1.0]),
            stt_lande_g: stt_contract
                .and_then(|contract| contract.lande_g)
                .unwrap_or(0.0),
            stt_active_node_mask: optional_slice_ptr(&stt_active_node_mask),
            stt_active_node_mask_len: stt_active_node_mask.len() as u64,
            stt_active_element_mask: optional_slice_ptr(&stt_active_element_mask),
            stt_active_element_mask_len: stt_active_element_mask.len() as u64,
            has_prescribed_sot: i32::from(sot_contract.is_some()),
            sot_formula_version: if sot_contract.is_some() {
                ffi::FULLMAG_FEM_SOT_FORMULA_PRESCRIBED_V1
            } else {
                ffi::FULLMAG_FEM_SOT_FORMULA_NONE
            },
            sot_current_density_am2: sot_contract
                .and_then(|contract| contract.sot_current_density)
                .unwrap_or(0.0),
            sot_xi_dl: sot_contract
                .and_then(|contract| contract.sot_xi_dl)
                .unwrap_or(0.0),
            sot_xi_fl: sot_contract
                .and_then(|contract| contract.sot_xi_fl)
                .unwrap_or(0.0),
            sot_thickness: sot_contract
                .and_then(|contract| contract.sot_thickness)
                .unwrap_or(0.0),
            sot_envelope_value,
            sot_sigma: sot_contract
                .and_then(|contract| contract.sot_sigma)
                .unwrap_or([0.0, 0.0, 1.0]),
            sot_active_node_mask: optional_slice_ptr(&sot_active_node_mask),
            sot_active_node_mask_len: sot_active_node_mask.len() as u64,
            sot_envelope,
            frozen_mask: frozen_mask
                .as_deref()
                .map_or(std::ptr::null(), |mask| mask.as_ptr()),
            frozen_mask_len: frozen_mask.as_ref().map_or(0, |mask| mask.len() as u64),
            frozen_reference_xyz: if frozen_mask.is_some() {
                m_flat.as_ptr()
            } else {
                std::ptr::null()
            },
            frozen_reference_len: if frozen_mask.is_some() {
                m_flat.len() as u64
            } else {
                0
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
            regional_field_drives: optional_slice_ptr(&regional_field_drive_descs),
            regional_field_drive_count: regional_field_drive_descs.len() as u64,
            stage_start_time_s: plan.time_stage.start_time_s,
        };

        // Build adaptive config if present.
        let adaptive_cfg = plan
            .adaptive_timestep
            .as_ref()
            .map(
                |a| -> Result<ffi::fullmag_fem_adaptive_config_v2, RunError> {
                    let policy = crate::resolve_timestep_policy(
                        plan.integrator,
                        plan.fixed_timestep,
                        Some(a),
                        if native_fem_plan_requests_gpu_mfem_device(plan) {
                            crate::types::TimestepExecutionLane::fem_gpu(plan.precision)
                        } else {
                            crate::types::TimestepExecutionLane::fem_cpu(plan.precision)
                        },
                    )?;
                    Ok(ffi::fullmag_fem_adaptive_config_v2 {
                        abi_version: ffi::FULLMAG_FEM_ADAPTIVE_CONFIG_V2_ABI_VERSION,
                        struct_size: std::mem::size_of::<ffi::fullmag_fem_adaptive_config_v2>()
                            as u32,
                        base: ffi::fullmag_fem_adaptive_config {
                            atol: a.atol,
                            rtol: a.rtol,
                            dt_initial: policy.initial_dt(),
                            dt_min: a.dt_min,
                            dt_max: a.dt_max.ok_or_else(|| RunError {
                                message: "adaptive timestep requires explicit dt_max".to_string(),
                            })?,
                            safety: a.safety,
                            growth_limit: a.growth_limit,
                            shrink_limit: a.shrink_limit,
                            max_reject: 50,
                        },
                        has_max_spin_rotation: i32::from(a.max_spin_rotation.is_some()),
                        max_spin_rotation: a.max_spin_rotation.unwrap_or(0.0),
                        has_norm_tolerance: i32::from(a.norm_tolerance.is_some()),
                        norm_tolerance: a.norm_tolerance.unwrap_or(0.0),
                    })
                },
            )
            .transpose()?;
        if let Some(ref cfg) = adaptive_cfg {
            plan_desc.adaptive_config = &cfg.base as *const ffi::fullmag_fem_adaptive_config;
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

        let handle = unsafe {
            if let Some(ref cfg) = adaptive_cfg {
                ffi::fullmag_fem_backend_create_v2(&plan_desc, cfg)
            } else {
                ffi::fullmag_fem_backend_create(&plan_desc)
            }
        };
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

        let demag_policy = plan
            .enable_demag
            .then(|| resolved_native_fem_demag_solver_policy(plan));

        let backend = Self {
            handle,
            stage_oersted_provider: None,
            stage_transport_provider: None,
            magnetic_node_mask: mesh_quantity_active_mask("m", &plan.mesh)
                .unwrap_or_else(|| vec![true; plan.mesh.nodes.len()])
                .into(),
            frozen_mask: plan
                .frozen_spins
                .as_ref()
                .map(|frozen_spins| Arc::<[bool]>::from(frozen_spins.frozen_mask.clone())),
            saturation_magnetisation_by_node: saturation_magnetisation_by_node.into(),
            dg0_energy_projection,
            energy_density_terms: NativeFemEnergyDensityTerms::from_plan(plan),
            cubic_energy_density,
            object_weights: if plan.object_segments.is_empty() {
                vec![("free".to_string(), 1.0)]
            } else {
                let mut weights: HashMap<String, f64> = HashMap::new();
                for segment in &plan.object_segments {
                    if segment.object_id == "__air__" {
                        continue;
                    }
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
            object_node_indices: native_fem_object_node_indices(plan),
            demag_solver: demag_policy.as_ref().map(|policy| policy.solver.clone()),
            demag_preconditioner: demag_policy.map(|policy| policy.preconditioner),
            adaptive_max_error: plan
                .adaptive_timestep
                .as_ref()
                .filter(|adaptive| adaptive.rtol == 0.0)
                .map(|adaptive| adaptive.atol),
            backend_create_wall_time_ns: Some(
                backend_create_started
                    .elapsed()
                    .as_nanos()
                    .min(u128::from(u64::MAX)) as u64,
            ),
        };
        Ok(backend)
    }

    fn attach_backend_create_timing(&mut self, stats: &mut StepStats) {
        stats.backend_create_wall_time_ns =
            self.backend_create_wall_time_ns.take().unwrap_or_default();
    }

    fn apply_demag_solver_policy_to_step_stats(&self, stats: &mut StepStats) {
        stats.demag_solver = self.demag_solver.clone();
        stats.demag_preconditioner = self.demag_preconditioner.clone();
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

    pub fn set_step_profile(&mut self, enabled: bool) -> Result<(), RunError> {
        let rc = unsafe {
            ffi::fullmag_fem_backend_set_step_profile(self.handle, if enabled { 1 } else { 0 })
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU set_step_profile failed"));
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
            hot_loop_control_scalar_d2h_bytes: 0,
            hot_loop_control_scalar_host_sync_count: 0,
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

    pub(crate) fn validate_strict_gpu_rk_plan(&self) -> Result<(), RunError> {
        let rc = unsafe { ffi::fullmag_fem_backend_validate_strict_gpu_rk_plan(self.handle) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU strict RK plan validation failed"));
        }
        Ok(())
    }

    pub(crate) fn set_gpu_execution_request(
        &mut self,
        strict_device: bool,
    ) -> Result<(), RunError> {
        let request = if strict_device {
            ffi::fullmag_fem_gpu_execution_request_v1::FULLMAG_FEM_GPU_EXECUTION_REQUEST_STRICT_DEVICE
        } else {
            ffi::fullmag_fem_gpu_execution_request_v1::FULLMAG_FEM_GPU_EXECUTION_REQUEST_COMPATIBILITY
        };
        let rc =
            unsafe { ffi::fullmag_fem_backend_set_gpu_execution_request_v1(self.handle, request) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("setting FEM GPU execution request failed"));
        }
        Ok(())
    }

    pub(crate) fn gpu_execution_receipt(
        &self,
    ) -> Result<runtime_info::NativeFemGpuExecutionReceipt, RunError> {
        let mut receipt = ffi::fullmag_fem_gpu_execution_receipt_v1 {
            abi_version: ffi::FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_gpu_execution_receipt_v1>() as u32,
            execution_class: 0,
            precision: 0,
            integrator: 0,
            device_ordinal: -1,
            required_operator_mask: 0,
            resolved_device_operator_mask: 0,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: 0,
            executed_host_operator_mask: 0,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 0,
            rejected_attempt_count: 0,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
        };
        let rc =
            unsafe { ffi::fullmag_fem_backend_gpu_execution_receipt_v1(self.handle, &mut receipt) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU execution receipt read failed"));
        }
        runtime_info::NativeFemGpuExecutionReceipt::from_ffi(receipt)
    }

    pub(crate) fn gpu_performance_snapshot(
        &self,
    ) -> Result<runtime_info::NativeFemGpuPerformanceSnapshot, RunError> {
        let mut snapshot = ffi::fullmag_fem_gpu_performance_snapshot_v2 {
            abi_version: ffi::FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_gpu_performance_snapshot_v2>() as u32,
            ..Default::default()
        };
        let rc = unsafe {
            ffi::fullmag_fem_backend_gpu_performance_snapshot_v2(self.handle, &mut snapshot)
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU performance snapshot read failed"));
        }
        runtime_info::NativeFemGpuPerformanceSnapshot::from_ffi(snapshot)
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
        stats.hot_loop_control_scalar_d2h_bytes = audit.hot_loop_control_scalar_d2h_bytes;
        stats.hot_loop_control_scalar_host_sync_count =
            audit.hot_loop_control_scalar_host_sync_count;
        Ok(())
    }

    fn attach_representation_receipt(&self, stats: &mut StepStats) -> Result<(), RunError> {
        let mut raw = ffi::fullmag_fem_representation_receipt_v1::default();
        let rc = unsafe {
            ffi::fullmag_fem_backend_snapshot_representation_receipt_v1(self.handle, &mut raw)
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM representation receipt read failed"));
        }
        stats.fem_representation_receipt = Some(representation_receipt_from_ffi(&raw)?);
        Ok(())
    }

    fn average_m_for_nodes(&self, node_indices: &[u32]) -> Result<Option<[f64; 3]>, RunError> {
        if node_indices.is_empty() {
            return Ok(None);
        }
        let mut average = [0.0f64; 3];
        let rc = unsafe {
            ffi::fullmag_fem_backend_average_m_for_nodes_f64(
                self.handle,
                node_indices.as_ptr(),
                node_indices.len() as u64,
                average.as_mut_ptr(),
                average.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM native per-object average_m reduction failed"));
        }
        Ok(Some(average))
    }

    fn attach_native_object_average_m(&self, stats: &mut StepStats) -> Result<(), RunError> {
        if self.object_node_indices.len() == 1 && self.object_node_indices[0].0 == "free" {
            return Ok(());
        }
        for (object_id, node_indices) in &self.object_node_indices {
            let Some([mx, my, mz]) = self.average_m_for_nodes(node_indices)? else {
                continue;
            };
            let values = stats
                .per_object_scalars
                .entry(object_id.clone())
                .or_default();
            values.insert("mx".to_string(), mx);
            values.insert("my".to_string(), my);
            values.insert("mz".to_string(), mz);
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
            mx: 0.0,
            my: 0.0,
            mz: 0.0,
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            drive_energy_joules: 0.0,
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
            rk_transaction_capture_host_wall_time_ns: 0,
            rk_transaction_capture_device_elapsed_time_ns: 0,
            rk_transaction_capture_bytes: 0,
            rk_transaction_restore_host_wall_time_ns: 0,
            rk_transaction_restore_device_elapsed_time_ns: 0,
            rk_transaction_restore_bytes: 0,
            rk_transaction_rollback_count: 0,
            rk_transaction_commit_count: 0,
            rk_transaction_cpu_snapshot_allocation_count: 0,
            rk_transaction_peak_rss_bytes: 0,
            demag_hypre_wait_in_enqueue_wall_time_ns: 0,
            demag_hypre_host_api_wall_time_ns: 0,
            demag_hypre_device_elapsed_time_ns: 0,
            demag_hypre_wait_out_enqueue_wall_time_ns: 0,
            demag_hypre_event_wait_count: 0,
            demag_hypre_timed_solve_count: 0,
            demag_solver_setup_reused: 0,
            demag_recover_wall_time_ns: 0,
            demag_energy_wall_time_ns: 0,
            rhs_wall_time_ns: 0,
            extra_energy_wall_time_ns: 0,
            snapshot_wall_time_ns: 0,
            relaxation_preconditioner_wall_time_ns: 0,
            relaxation_state_copy_wall_time_ns: 0,
            relaxation_state_upload_wall_time_ns: 0,
            relaxation_retraction_wall_time_ns: 0,
            relaxation_gradient_wall_time_ns: 0,
            relaxation_metric_wall_time_ns: 0,
            relaxation_line_search_wall_time_ns: 0,
            relaxation_update_wall_time_ns: 0,
            relaxation_preconditioner_cache_hits: 0,
            relaxation_preconditioner_cache_misses: 0,
            error_estimate: 0.0,
            rejected_attempts: 0,
            dt_suggested: 0.0,
            rhs_evaluations: 0,
            fsal_reused: 0,
            requested_omp_threads: 0,
            effective_omp_threads: 0,
            cpu_thread_cap_reason:
                ffi::fullmag_fem_host_thread_policy_reason::FULLMAG_FEM_HOST_THREAD_POLICY_NONE
                    as i32,
            demag_amg_relax_type: 0,
            demag_amg_coarsening: 0,
            demag_amg_interpolation: 0,
            demag_amg_aggressive_coarsening: 0,
            demag_amg_strength_threshold: 0.0,
            demag_amg_strength_threshold_is_set: 0,
            demag_amg_max_levels: 0,
            demag_amg_max_levels_is_set: 0,
            demag_potential_order: 0,
            demag_potential_true_dof_count: 0,
            demag_variational_energy_joules: 0.0,
            demag_recovered_field_energy_joules: 0.0,
        };

        let ffi_wall_start = std::time::Instant::now();
        let rc = unsafe { ffi::fullmag_fem_backend_step(self.handle, dt, &mut stats) };
        let ffi_wall_time_ns = ffi_wall_start
            .elapsed()
            .as_nanos()
            .min(u128::from(u64::MAX)) as u64;
        if rc == ffi::FULLMAG_FEM_ERR_INTERRUPTED {
            return Ok(None);
        }
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU step failed"));
        }

        let endpoint_cache_telemetry = self.endpoint_cache_telemetry()?;
        let solver_attempts = self.solver_attempts()?;
        let controller_diagnostics = self.stage_completion_snapshot_ffi()?;
        let accepted_energy_proof: Option<(f64, f64, f64, f64)> = None;

        let relaxation_subphase_wall_time_ns = relaxation_driver_subphase_wall_time_ns(&stats);
        let torque_apm = validate_native_step_stats(&stats)?;
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
            e_drive: stats.drive_energy_joules,
            e_ani: stats.anisotropy_energy_joules,
            e_dmi: stats.dmi_energy_joules,
            e_total: stats.total_energy_joules,
            max_dm_dt: stats.max_rhs_amplitude,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            max_torque_Apm: torque_apm,
            max_torque_T: torque_apm * crate::MU0,
            accepted_energy_proof_available: accepted_energy_proof.is_some(),
            accepted_energy_delta_j: accepted_energy_proof.map(|proof| proof.0),
            accepted_energy_roundoff_bound_j: accepted_energy_proof.map(|proof| proof.1),
            accepted_energy_delta_upper_j: accepted_energy_proof.map(|proof| proof.2),
            armijo_increment_rhs_j: accepted_energy_proof.map(|proof| proof.3),
            wall_time_ns: stats.wall_time_ns.max(ffi_wall_time_ns),
            exchange_wall_time_ns: stats.exchange_wall_time_ns,
            demag_wall_time_ns: stats.demag_wall_time_ns,
            demag_assemble_wall_time_ns: stats.demag_assemble_wall_time_ns,
            demag_solve_wall_time_ns: stats.demag_solve_wall_time_ns,
            demag_solver_setup_wall_time_ns: stats.demag_solver_setup_wall_time_ns,
            demag_solver_apply_wall_time_ns: stats.demag_solver_apply_wall_time_ns,
            rk_transaction_capture_host_wall_time_ns: stats
                .rk_transaction_capture_host_wall_time_ns,
            rk_transaction_capture_device_elapsed_time_ns: stats
                .rk_transaction_capture_device_elapsed_time_ns,
            rk_transaction_capture_bytes: stats.rk_transaction_capture_bytes,
            rk_transaction_restore_host_wall_time_ns: stats
                .rk_transaction_restore_host_wall_time_ns,
            rk_transaction_restore_device_elapsed_time_ns: stats
                .rk_transaction_restore_device_elapsed_time_ns,
            rk_transaction_restore_bytes: stats.rk_transaction_restore_bytes,
            rk_transaction_rollback_count: stats.rk_transaction_rollback_count,
            rk_transaction_commit_count: stats.rk_transaction_commit_count,
            rk_transaction_cpu_snapshot_allocation_count: stats
                .rk_transaction_cpu_snapshot_allocation_count,
            rk_transaction_peak_rss_bytes: stats.rk_transaction_peak_rss_bytes,
            demag_hypre_wait_in_enqueue_wall_time_ns: stats
                .demag_hypre_wait_in_enqueue_wall_time_ns,
            demag_hypre_host_api_wall_time_ns: stats.demag_hypre_host_api_wall_time_ns,
            demag_hypre_device_elapsed_time_ns: stats.demag_hypre_device_elapsed_time_ns,
            demag_hypre_wait_out_enqueue_wall_time_ns: stats
                .demag_hypre_wait_out_enqueue_wall_time_ns,
            demag_hypre_event_wait_count: stats.demag_hypre_event_wait_count,
            demag_hypre_timed_solve_count: stats.demag_hypre_timed_solve_count,
            demag_solver_setup_reused: stats.demag_solver_setup_reused != 0,
            demag_amg_relax_type: stats.demag_amg_relax_type,
            demag_amg_coarsening: stats.demag_amg_coarsening,
            demag_amg_interpolation: stats.demag_amg_interpolation,
            demag_amg_aggressive_coarsening: stats.demag_amg_aggressive_coarsening,
            demag_amg_strength_threshold: stats.demag_amg_strength_threshold,
            demag_amg_strength_threshold_is_set: stats.demag_amg_strength_threshold_is_set != 0,
            demag_amg_max_levels: stats.demag_amg_max_levels,
            demag_amg_max_levels_is_set: stats.demag_amg_max_levels_is_set != 0,
            demag_recover_wall_time_ns: stats.demag_recover_wall_time_ns,
            demag_energy_wall_time_ns: stats.demag_energy_wall_time_ns,
            rhs_wall_time_ns: stats.rhs_wall_time_ns,
            extra_energy_wall_time_ns: stats.extra_energy_wall_time_ns,
            snapshot_wall_time_ns: stats.snapshot_wall_time_ns,
            relaxation_preconditioner_wall_time_ns: stats.relaxation_preconditioner_wall_time_ns,
            relaxation_state_copy_wall_time_ns: stats.relaxation_state_copy_wall_time_ns,
            relaxation_state_upload_wall_time_ns: stats.relaxation_state_upload_wall_time_ns,
            relaxation_retraction_wall_time_ns: stats.relaxation_retraction_wall_time_ns,
            relaxation_gradient_wall_time_ns: stats.relaxation_gradient_wall_time_ns,
            relaxation_metric_wall_time_ns: stats.relaxation_metric_wall_time_ns,
            relaxation_line_search_wall_time_ns: stats.relaxation_line_search_wall_time_ns,
            relaxation_update_wall_time_ns: stats.relaxation_update_wall_time_ns,
            relaxation_preconditioner_cache_hits: stats.relaxation_preconditioner_cache_hits,
            relaxation_preconditioner_cache_misses: stats.relaxation_preconditioner_cache_misses,
            native_ffi_overhead_wall_time_ns: ffi_wall_time_ns
                .saturating_sub(stats.wall_time_ns)
                .saturating_sub(relaxation_subphase_wall_time_ns),
            error_estimate: self
                .adaptive_max_error
                .map(|max_error| stats.error_estimate * max_error),
            max_error: self.adaptive_max_error,
            rejected_attempts: stats.rejected_attempts,
            relaxation_energy_rejected_attempts: controller_diagnostics.energy_rejected_attempts,
            relaxation_controller_tightenings: controller_diagnostics.controller_tightening_count,
            relaxation_controller_at_floor: controller_diagnostics.controller_at_floor != 0,
            relaxation_torque_confirmation_count: controller_diagnostics
                .torque_confirmation_samples_current,
            dt_suggested: if stats.dt_suggested > 0.0 {
                Some(stats.dt_suggested)
            } else {
                None
            },
            rhs_evals: stats.rhs_evaluations,
            fsal_reused: stats.fsal_reused != 0,
            endpoint_cache_telemetry,
            solver_attempts,
            demag_solves: stats.demag_solve_count,
            poisson_iterations: stats.demag_linear_iterations,
            poisson_final_residual: stats.demag_linear_residual,
            demag_refreshed: stats.demag_solve_count > 0,
            requested_fem_omp_threads: stats.requested_omp_threads,
            effective_fem_omp_threads: stats.effective_omp_threads,
            fem_cpu_thread_cap_reason: stats.cpu_thread_cap_reason,
            ..StepStats::default()
        };
        copy_demag_diagnostics(&mut step_stats, &stats);
        self.apply_demag_solver_policy_to_step_stats(&mut step_stats);
        self.attach_backend_create_timing(&mut step_stats);
        self.attach_transfer_audit(&mut step_stats)?;
        self.attach_representation_receipt(&mut step_stats)?;
        step_stats.per_object_scalars =
            if self.object_weights.len() == 1 && self.object_weights[0].0 == "free" {
                single_object_scalars("free", &step_stats)
            } else {
                weighted_object_scalars(&step_stats, &self.object_weights)
            };
        self.attach_native_object_average_m(&mut step_stats)?;
        Ok(Some(step_stats))
    }

    fn take_accepted_energy_proof(&self) -> Result<Option<(f64, f64, f64, f64)>, RunError> {
        let mut proof = ffi::fullmag_fem_accepted_energy_proof_v1 {
            abi_version: ffi::FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_accepted_energy_proof_v1>() as u32,
            ..Default::default()
        };
        let rc = unsafe {
            ffi::fullmag_fem_backend_take_accepted_energy_proof_v1(self.handle, &mut proof)
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM accepted-energy proof query failed"));
        }
        if proof.abi_version != ffi::FULLMAG_FEM_ACCEPTED_ENERGY_PROOF_V1_ABI_VERSION
            || proof.struct_size as usize
                != std::mem::size_of::<ffi::fullmag_fem_accepted_energy_proof_v1>()
        {
            return Err(RunError {
                message: "native FEM returned an incompatible accepted-energy proof ABI record"
                    .to_string(),
            });
        }
        if proof.accepted_energy_proof_available == 0 {
            return Ok(None);
        }
        let delta =
            checked_native_finite("accepted_energy_delta_j", proof.accepted_energy_delta_j)?;
        let bound = checked_native_nonnegative(
            "accepted_energy_roundoff_bound_j",
            proof.accepted_energy_roundoff_bound_j,
        )?;
        let upper = checked_native_finite(
            "accepted_energy_delta_upper_j",
            proof.accepted_energy_delta_upper_j,
        )?;
        let rhs = checked_native_finite("armijo_increment_rhs_j", proof.armijo_increment_rhs_j)?;
        if upper != delta + bound || upper > rhs || rhs > 0.0 {
            return Err(RunError {
                message: "native FEM accepted-energy proof violates upper <= Armijo RHS <= 0"
                    .to_string(),
            });
        }
        Ok(Some((delta, bound, upper, rhs)))
    }

    fn solver_attempts(&self) -> Result<Vec<SolverAttemptRecord>, RunError> {
        let mut count = 0u64;
        let rc =
            unsafe { ffi::fullmag_fem_backend_solver_attempt_count_v1(self.handle, &mut count) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM native solver-attempt count failed"));
        }
        if count > 64 {
            return Err(RunError {
                message: format!(
                    "native FEM solver attempt trace exceeded its 64-record contract: {count}"
                ),
            });
        }
        let mut raw = vec![ffi::fullmag_fem_solver_attempt_record_v2::default(); count as usize];
        let mut copied = 0u64;
        let rc = unsafe {
            ffi::fullmag_fem_backend_copy_solver_attempts_v2(
                self.handle,
                raw.as_mut_ptr(),
                count,
                &mut copied,
            )
        };
        if rc != ffi::FULLMAG_FEM_OK || copied != count {
            return Err(self.last_error_or("FEM native solver-attempt copy failed"));
        }
        raw.into_iter()
            .map(|record| {
                if record.abi_version != ffi::FULLMAG_FEM_SOLVER_ATTEMPT_RECORD_V2_ABI_VERSION
                    || record.struct_size as usize
                        != std::mem::size_of::<ffi::fullmag_fem_solver_attempt_record_v2>()
                {
                    return Err(RunError {
                        message: "native FEM returned an incompatible solver-attempt ABI v2 record"
                            .to_string(),
                    });
                }
                let error_norm_type = solver_attempt_error_norm_type(record.error_norm_type)?;
                let (
                    active_node_count,
                    active_measure,
                    normalization_denominator,
                    max_scaled_error,
                    weighted_rms_error,
                ) = if error_norm_type.is_some() {
                    (
                        Some(record.active_node_count),
                        Some(checked_native_nonnegative(
                            "solver attempt active measure",
                            record.active_measure,
                        )?),
                        Some(checked_native_nonnegative(
                            "solver attempt normalization denominator",
                            record.normalization_denominator,
                        )?),
                        Some(checked_native_nonnegative(
                            "solver attempt max scaled error",
                            record.max_scaled_error,
                        )?),
                        Some(checked_native_nonnegative(
                            "solver attempt weighted RMS error",
                            record.weighted_rms_error,
                        )?),
                    )
                } else {
                    (None, None, None, None, None)
                };
                Ok(SolverAttemptRecord {
                    attempt: record.attempt,
                    adaptive_controller_policy_version: None,
                    error_norm_type: error_norm_type.map(str::to_string),
                    active_node_count,
                    active_measure,
                    normalization_denominator,
                    max_scaled_error,
                    weighted_rms_error,
                    target_step: record.target_step,
                    time: checked_native_nonnegative("solver attempt time", record.time_seconds)?,
                    dt_attempt: checked_native_nonnegative(
                        "solver attempt dt",
                        record.dt_attempt_seconds,
                    )?,
                    eta: checked_native_nonnegative("solver attempt eta", record.eta)?,
                    max_norm_defect: (record.max_norm_defect >= 0.0)
                        .then(|| {
                            checked_native_nonnegative(
                                "solver attempt norm defect",
                                record.max_norm_defect,
                            )
                        })
                        .transpose()?,
                    max_spin_rotation: (record.max_spin_rotation >= 0.0)
                        .then(|| {
                            checked_native_nonnegative(
                                "solver attempt spin rotation",
                                record.max_spin_rotation,
                            )
                        })
                        .transpose()?,
                    decision: solver_attempt_decision(record.decision)?.to_string(),
                    reason: solver_attempt_reason(record.reason)?.to_string(),
                    dt_next: checked_native_nonnegative(
                        "solver attempt next dt",
                        record.dt_next_seconds,
                    )?,
                    demag_solves: record.demag_solve_count,
                    demag_iterations: record.demag_linear_iterations,
                    demag_residual: checked_native_nonnegative(
                        "solver attempt demag residual",
                        record.demag_linear_residual,
                    )?,
                    rhs_evals: record.rhs_evaluations,
                    estimator_order: record.estimator_order,
                })
            })
            .collect()
    }

    fn endpoint_cache_telemetry(
        &self,
    ) -> Result<Option<fullmag_quantities::EndpointCacheTelemetry>, RunError> {
        let mut raw = ffi::fullmag_fem_endpoint_cache_telemetry_v1::default();
        let rc = unsafe {
            ffi::fullmag_fem_backend_snapshot_endpoint_cache_telemetry_v1(self.handle, &mut raw)
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM native endpoint cache telemetry snapshot failed"));
        }
        endpoint_cache_telemetry_from_ffi(&raw)
    }

    pub fn invalidate_fsal(&mut self) -> Result<(), RunError> {
        let rc = unsafe { ffi::fullmag_fem_backend_invalidate_fsal(self.handle) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM native FSAL invalidation failed"));
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub fn step(&mut self, dt: f64) -> Result<StepStats, RunError> {
        self.step_interruptible(dt, None)?
            .ok_or_else(|| self.last_error_or("FEM GPU step interrupted without a signal"))
    }

    pub fn relax_step(
        &mut self,
        algorithm: fullmag_ir::RelaxationAlgorithmIR,
        _node_count: usize,
    ) -> Result<Option<StepStats>, RunError> {
        let ffi_algorithm = match algorithm {
            fullmag_ir::RelaxationAlgorithmIR::ProjectedGradientBb => {
                ffi::fullmag_fem_relax_algorithm::FULLMAG_FEM_RELAX_PROJECTED_GRADIENT_BB
            }
            fullmag_ir::RelaxationAlgorithmIR::NonlinearCg => {
                ffi::fullmag_fem_relax_algorithm::FULLMAG_FEM_RELAX_NONLINEAR_CG
            }
            fullmag_ir::RelaxationAlgorithmIR::TangentPlaneImplicit => {
                ffi::fullmag_fem_relax_algorithm::FULLMAG_FEM_RELAX_TANGENT_PLANE_IMPLICIT
            }
            fullmag_ir::RelaxationAlgorithmIR::LlgOverdamped => {
                return Err(RunError {
                    message: "FEM native relaxation step ABI is not used for llg_overdamped"
                        .to_string(),
                });
            }
        };
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
            drive_energy_joules: 0.0,
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
            rk_transaction_capture_host_wall_time_ns: 0,
            rk_transaction_capture_device_elapsed_time_ns: 0,
            rk_transaction_capture_bytes: 0,
            rk_transaction_restore_host_wall_time_ns: 0,
            rk_transaction_restore_device_elapsed_time_ns: 0,
            rk_transaction_restore_bytes: 0,
            rk_transaction_rollback_count: 0,
            rk_transaction_commit_count: 0,
            rk_transaction_cpu_snapshot_allocation_count: 0,
            rk_transaction_peak_rss_bytes: 0,
            demag_hypre_wait_in_enqueue_wall_time_ns: 0,
            demag_hypre_host_api_wall_time_ns: 0,
            demag_hypre_device_elapsed_time_ns: 0,
            demag_hypre_wait_out_enqueue_wall_time_ns: 0,
            demag_hypre_event_wait_count: 0,
            demag_hypre_timed_solve_count: 0,
            demag_solver_setup_reused: 0,
            demag_recover_wall_time_ns: 0,
            demag_energy_wall_time_ns: 0,
            rhs_wall_time_ns: 0,
            extra_energy_wall_time_ns: 0,
            snapshot_wall_time_ns: 0,
            relaxation_preconditioner_wall_time_ns: 0,
            relaxation_state_copy_wall_time_ns: 0,
            relaxation_state_upload_wall_time_ns: 0,
            relaxation_retraction_wall_time_ns: 0,
            relaxation_gradient_wall_time_ns: 0,
            relaxation_metric_wall_time_ns: 0,
            relaxation_line_search_wall_time_ns: 0,
            relaxation_update_wall_time_ns: 0,
            relaxation_preconditioner_cache_hits: 0,
            relaxation_preconditioner_cache_misses: 0,
            error_estimate: 0.0,
            rejected_attempts: 0,
            dt_suggested: 0.0,
            rhs_evaluations: 0,
            fsal_reused: 0,
            requested_omp_threads: 0,
            effective_omp_threads: 0,
            cpu_thread_cap_reason:
                ffi::fullmag_fem_host_thread_policy_reason::FULLMAG_FEM_HOST_THREAD_POLICY_NONE
                    as i32,
            demag_amg_relax_type: 0,
            demag_amg_coarsening: 0,
            demag_amg_interpolation: 0,
            demag_amg_aggressive_coarsening: 0,
            demag_amg_strength_threshold: 0.0,
            demag_amg_strength_threshold_is_set: 0,
            demag_amg_max_levels: 0,
            demag_amg_max_levels_is_set: 0,
            demag_potential_order: 0,
            demag_potential_true_dof_count: 0,
            demag_variational_energy_joules: 0.0,
            demag_recovered_field_energy_joules: 0.0,
        };

        let ffi_wall_start = std::time::Instant::now();
        let rc =
            unsafe { ffi::fullmag_fem_backend_relax_step(self.handle, ffi_algorithm, &mut stats) };
        let ffi_wall_time_ns = ffi_wall_start
            .elapsed()
            .as_nanos()
            .min(u128::from(u64::MAX)) as u64;
        if rc == ffi::FULLMAG_FEM_ERR_INTERRUPTED {
            return Ok(None);
        }
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM native relaxation step failed"));
        }

        let controller_diagnostics = self.stage_completion_snapshot_ffi()?;
        let accepted_energy_proof = self.take_accepted_energy_proof()?;
        if stage_completion_is_representability_stationary(&controller_diagnostics) {
            if accepted_energy_proof.is_some() {
                return Err(RunError {
                    message: "native FEM representability-stationary completion published an accepted-energy proof"
                        .to_string(),
                });
            }
            return Ok(None);
        }
        let relaxation_subphase_wall_time_ns = relaxation_driver_subphase_wall_time_ns(&stats);
        let torque_apm = validate_native_step_stats(&stats)?;
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
            e_drive: stats.drive_energy_joules,
            e_ani: stats.anisotropy_energy_joules,
            e_dmi: stats.dmi_energy_joules,
            e_total: stats.total_energy_joules,
            max_dm_dt: stats.max_rhs_amplitude,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            max_torque_Apm: torque_apm,
            max_torque_T: torque_apm * crate::MU0,
            accepted_energy_proof_available: accepted_energy_proof.is_some(),
            accepted_energy_delta_j: accepted_energy_proof.map(|proof| proof.0),
            accepted_energy_roundoff_bound_j: accepted_energy_proof.map(|proof| proof.1),
            accepted_energy_delta_upper_j: accepted_energy_proof.map(|proof| proof.2),
            armijo_increment_rhs_j: accepted_energy_proof.map(|proof| proof.3),
            wall_time_ns: stats.wall_time_ns.max(ffi_wall_time_ns),
            exchange_wall_time_ns: stats.exchange_wall_time_ns,
            demag_wall_time_ns: stats.demag_wall_time_ns,
            demag_assemble_wall_time_ns: stats.demag_assemble_wall_time_ns,
            demag_solve_wall_time_ns: stats.demag_solve_wall_time_ns,
            demag_solver_setup_wall_time_ns: stats.demag_solver_setup_wall_time_ns,
            demag_solver_apply_wall_time_ns: stats.demag_solver_apply_wall_time_ns,
            rk_transaction_capture_host_wall_time_ns: stats
                .rk_transaction_capture_host_wall_time_ns,
            rk_transaction_capture_device_elapsed_time_ns: stats
                .rk_transaction_capture_device_elapsed_time_ns,
            rk_transaction_capture_bytes: stats.rk_transaction_capture_bytes,
            rk_transaction_restore_host_wall_time_ns: stats
                .rk_transaction_restore_host_wall_time_ns,
            rk_transaction_restore_device_elapsed_time_ns: stats
                .rk_transaction_restore_device_elapsed_time_ns,
            rk_transaction_restore_bytes: stats.rk_transaction_restore_bytes,
            rk_transaction_rollback_count: stats.rk_transaction_rollback_count,
            rk_transaction_commit_count: stats.rk_transaction_commit_count,
            rk_transaction_cpu_snapshot_allocation_count: stats
                .rk_transaction_cpu_snapshot_allocation_count,
            rk_transaction_peak_rss_bytes: stats.rk_transaction_peak_rss_bytes,
            demag_hypre_wait_in_enqueue_wall_time_ns: stats
                .demag_hypre_wait_in_enqueue_wall_time_ns,
            demag_hypre_host_api_wall_time_ns: stats.demag_hypre_host_api_wall_time_ns,
            demag_hypre_device_elapsed_time_ns: stats.demag_hypre_device_elapsed_time_ns,
            demag_hypre_wait_out_enqueue_wall_time_ns: stats
                .demag_hypre_wait_out_enqueue_wall_time_ns,
            demag_hypre_event_wait_count: stats.demag_hypre_event_wait_count,
            demag_hypre_timed_solve_count: stats.demag_hypre_timed_solve_count,
            demag_solver_setup_reused: stats.demag_solver_setup_reused != 0,
            demag_amg_relax_type: stats.demag_amg_relax_type,
            demag_amg_coarsening: stats.demag_amg_coarsening,
            demag_amg_interpolation: stats.demag_amg_interpolation,
            demag_amg_aggressive_coarsening: stats.demag_amg_aggressive_coarsening,
            demag_amg_strength_threshold: stats.demag_amg_strength_threshold,
            demag_amg_strength_threshold_is_set: stats.demag_amg_strength_threshold_is_set != 0,
            demag_amg_max_levels: stats.demag_amg_max_levels,
            demag_amg_max_levels_is_set: stats.demag_amg_max_levels_is_set != 0,
            demag_recover_wall_time_ns: stats.demag_recover_wall_time_ns,
            demag_energy_wall_time_ns: stats.demag_energy_wall_time_ns,
            rhs_wall_time_ns: stats.rhs_wall_time_ns,
            extra_energy_wall_time_ns: stats.extra_energy_wall_time_ns,
            snapshot_wall_time_ns: stats.snapshot_wall_time_ns,
            relaxation_preconditioner_wall_time_ns: stats.relaxation_preconditioner_wall_time_ns,
            relaxation_state_copy_wall_time_ns: stats.relaxation_state_copy_wall_time_ns,
            relaxation_state_upload_wall_time_ns: stats.relaxation_state_upload_wall_time_ns,
            relaxation_retraction_wall_time_ns: stats.relaxation_retraction_wall_time_ns,
            relaxation_gradient_wall_time_ns: stats.relaxation_gradient_wall_time_ns,
            relaxation_metric_wall_time_ns: stats.relaxation_metric_wall_time_ns,
            relaxation_line_search_wall_time_ns: stats.relaxation_line_search_wall_time_ns,
            relaxation_update_wall_time_ns: stats.relaxation_update_wall_time_ns,
            relaxation_preconditioner_cache_hits: stats.relaxation_preconditioner_cache_hits,
            relaxation_preconditioner_cache_misses: stats.relaxation_preconditioner_cache_misses,
            native_ffi_overhead_wall_time_ns: ffi_wall_time_ns
                .saturating_sub(stats.wall_time_ns)
                .saturating_sub(relaxation_subphase_wall_time_ns),
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
            fem_cpu_thread_cap_reason: stats.cpu_thread_cap_reason,
            ..StepStats::default()
        };
        copy_demag_diagnostics(&mut step_stats, &stats);
        self.apply_demag_solver_policy_to_step_stats(&mut step_stats);
        self.attach_backend_create_timing(&mut step_stats);
        self.attach_transfer_audit(&mut step_stats)?;
        self.attach_representation_receipt(&mut step_stats)?;
        step_stats.per_object_scalars =
            if self.object_weights.len() == 1 && self.object_weights[0].0 == "free" {
                single_object_scalars("free", &step_stats)
            } else {
                weighted_object_scalars(&step_stats, &self.object_weights)
            };
        self.attach_native_object_average_m(&mut step_stats)?;
        Ok(Some(step_stats))
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

    pub fn copy_linearization_field(
        &self,
        observable: ffi::fullmag_fem_observable,
        node_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        let len = node_count * 3;
        let mut flat = vec![0.0f64; len];
        let rc = unsafe {
            ffi::fullmag_fem_backend_copy_linearization_field_f64(
                self.handle,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM copy_linearization_field failed"));
        }
        Ok(flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect())
    }

    #[allow(dead_code)]
    pub fn copy_scalar_field(
        &self,
        observable: ffi::fullmag_fem_observable,
        node_count: usize,
    ) -> Result<Vec<f64>, RunError> {
        let mut values = vec![0.0f64; node_count];
        let rc = unsafe {
            ffi::fullmag_fem_backend_copy_field_f64(
                self.handle,
                observable,
                values.as_mut_ptr(),
                values.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU copy scalar field failed"));
        }
        Ok(values)
    }

    pub fn copy_m(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_M,
            node_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_demag_phi(&self, node_count: usize) -> Result<Vec<f64>, RunError> {
        self.copy_scalar_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_DEMAG_PHI,
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

    #[allow(dead_code)]
    pub fn apply_demag_tangent(&mut self, delta_m: &[[f64; 3]]) -> Result<Vec<[f64; 3]>, RunError> {
        let delta_m_flat = delta_m
            .iter()
            .flat_map(|value| value.iter().copied())
            .collect::<Vec<_>>();
        let mut out_delta_h_demag = vec![0.0f64; delta_m_flat.len()];
        let rc = unsafe {
            ffi::fullmag_fem_backend_apply_demag_tangent_f64(
                self.handle,
                delta_m_flat.as_ptr(),
                delta_m_flat.len() as u64,
                out_delta_h_demag.as_mut_ptr(),
                out_delta_h_demag.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU apply demag tangent failed"));
        }
        Ok(out_delta_h_demag
            .chunks_exact(3)
            .map(|chunk| [chunk[0], chunk[1], chunk[2]])
            .collect())
    }

    #[allow(dead_code)]
    pub fn apply_demag_tangent_with_potential(
        &mut self,
        delta_m: &[[f64; 3]],
    ) -> Result<(Vec<[f64; 3]>, Vec<f64>), RunError> {
        let delta_m_flat = delta_m
            .iter()
            .flat_map(|value| value.iter().copied())
            .collect::<Vec<_>>();
        let mut out_delta_h_demag = vec![0.0f64; delta_m_flat.len()];
        let mut out_delta_phi = vec![0.0f64; delta_m.len()];
        let rc = unsafe {
            ffi::fullmag_fem_backend_apply_demag_tangent_with_potential_f64(
                self.handle,
                delta_m_flat.as_ptr(),
                delta_m_flat.len() as u64,
                out_delta_h_demag.as_mut_ptr(),
                out_delta_h_demag.len() as u64,
                out_delta_phi.as_mut_ptr(),
                out_delta_phi.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU apply demag tangent with potential failed"));
        }
        Ok((
            out_delta_h_demag
                .chunks_exact(3)
                .map(|chunk| [chunk[0], chunk[1], chunk[2]])
                .collect(),
            out_delta_phi,
        ))
    }

    pub fn snapshot_step_stats(&mut self, _node_count: usize) -> Result<StepStats, RunError> {
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
            drive_energy_joules: 0.0,
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
            rk_transaction_capture_host_wall_time_ns: 0,
            rk_transaction_capture_device_elapsed_time_ns: 0,
            rk_transaction_capture_bytes: 0,
            rk_transaction_restore_host_wall_time_ns: 0,
            rk_transaction_restore_device_elapsed_time_ns: 0,
            rk_transaction_restore_bytes: 0,
            rk_transaction_rollback_count: 0,
            rk_transaction_commit_count: 0,
            rk_transaction_cpu_snapshot_allocation_count: 0,
            rk_transaction_peak_rss_bytes: 0,
            demag_hypre_wait_in_enqueue_wall_time_ns: 0,
            demag_hypre_host_api_wall_time_ns: 0,
            demag_hypre_device_elapsed_time_ns: 0,
            demag_hypre_wait_out_enqueue_wall_time_ns: 0,
            demag_hypre_event_wait_count: 0,
            demag_hypre_timed_solve_count: 0,
            demag_solver_setup_reused: 0,
            demag_recover_wall_time_ns: 0,
            demag_energy_wall_time_ns: 0,
            rhs_wall_time_ns: 0,
            extra_energy_wall_time_ns: 0,
            snapshot_wall_time_ns: 0,
            relaxation_preconditioner_wall_time_ns: 0,
            relaxation_state_copy_wall_time_ns: 0,
            relaxation_state_upload_wall_time_ns: 0,
            relaxation_retraction_wall_time_ns: 0,
            relaxation_gradient_wall_time_ns: 0,
            relaxation_metric_wall_time_ns: 0,
            relaxation_line_search_wall_time_ns: 0,
            relaxation_update_wall_time_ns: 0,
            relaxation_preconditioner_cache_hits: 0,
            relaxation_preconditioner_cache_misses: 0,
            error_estimate: 0.0,
            rejected_attempts: 0,
            dt_suggested: 0.0,
            rhs_evaluations: 0,
            fsal_reused: 0,
            requested_omp_threads: 0,
            effective_omp_threads: 0,
            cpu_thread_cap_reason:
                ffi::fullmag_fem_host_thread_policy_reason::FULLMAG_FEM_HOST_THREAD_POLICY_NONE
                    as i32,
            demag_amg_relax_type: 0,
            demag_amg_coarsening: 0,
            demag_amg_interpolation: 0,
            demag_amg_aggressive_coarsening: 0,
            demag_amg_strength_threshold: 0.0,
            demag_amg_strength_threshold_is_set: 0,
            demag_amg_max_levels: 0,
            demag_amg_max_levels_is_set: 0,
            demag_potential_order: 0,
            demag_potential_true_dof_count: 0,
            demag_variational_energy_joules: 0.0,
            demag_recovered_field_energy_joules: 0.0,
        };

        let rc = unsafe { ffi::fullmag_fem_backend_snapshot_stats(self.handle, &mut stats) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU snapshot_step_stats failed"));
        }

        let accepted_energy_proof: Option<(f64, f64, f64, f64)> = None;
        let torque_apm = validate_native_step_stats(&stats)?;
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
            e_drive: stats.drive_energy_joules,
            e_ani: stats.anisotropy_energy_joules,
            e_dmi: stats.dmi_energy_joules,
            e_total: stats.total_energy_joules,
            max_dm_dt: stats.max_rhs_amplitude,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
            max_torque_Apm: torque_apm,
            max_torque_T: torque_apm * crate::MU0,
            accepted_energy_proof_available: accepted_energy_proof.is_some(),
            accepted_energy_delta_j: accepted_energy_proof.map(|proof| proof.0),
            accepted_energy_roundoff_bound_j: accepted_energy_proof.map(|proof| proof.1),
            accepted_energy_delta_upper_j: accepted_energy_proof.map(|proof| proof.2),
            armijo_increment_rhs_j: accepted_energy_proof.map(|proof| proof.3),
            wall_time_ns: stats.wall_time_ns,
            exchange_wall_time_ns: stats.exchange_wall_time_ns,
            demag_wall_time_ns: stats.demag_wall_time_ns,
            demag_assemble_wall_time_ns: stats.demag_assemble_wall_time_ns,
            demag_solve_wall_time_ns: stats.demag_solve_wall_time_ns,
            demag_solver_setup_wall_time_ns: stats.demag_solver_setup_wall_time_ns,
            demag_solver_apply_wall_time_ns: stats.demag_solver_apply_wall_time_ns,
            rk_transaction_capture_host_wall_time_ns: stats
                .rk_transaction_capture_host_wall_time_ns,
            rk_transaction_capture_device_elapsed_time_ns: stats
                .rk_transaction_capture_device_elapsed_time_ns,
            rk_transaction_capture_bytes: stats.rk_transaction_capture_bytes,
            rk_transaction_restore_host_wall_time_ns: stats
                .rk_transaction_restore_host_wall_time_ns,
            rk_transaction_restore_device_elapsed_time_ns: stats
                .rk_transaction_restore_device_elapsed_time_ns,
            rk_transaction_restore_bytes: stats.rk_transaction_restore_bytes,
            rk_transaction_rollback_count: stats.rk_transaction_rollback_count,
            rk_transaction_commit_count: stats.rk_transaction_commit_count,
            rk_transaction_cpu_snapshot_allocation_count: stats
                .rk_transaction_cpu_snapshot_allocation_count,
            rk_transaction_peak_rss_bytes: stats.rk_transaction_peak_rss_bytes,
            demag_hypre_wait_in_enqueue_wall_time_ns: stats
                .demag_hypre_wait_in_enqueue_wall_time_ns,
            demag_hypre_host_api_wall_time_ns: stats.demag_hypre_host_api_wall_time_ns,
            demag_hypre_device_elapsed_time_ns: stats.demag_hypre_device_elapsed_time_ns,
            demag_hypre_wait_out_enqueue_wall_time_ns: stats
                .demag_hypre_wait_out_enqueue_wall_time_ns,
            demag_hypre_event_wait_count: stats.demag_hypre_event_wait_count,
            demag_hypre_timed_solve_count: stats.demag_hypre_timed_solve_count,
            demag_solver_setup_reused: stats.demag_solver_setup_reused != 0,
            demag_amg_relax_type: stats.demag_amg_relax_type,
            demag_amg_coarsening: stats.demag_amg_coarsening,
            demag_amg_interpolation: stats.demag_amg_interpolation,
            demag_amg_aggressive_coarsening: stats.demag_amg_aggressive_coarsening,
            demag_amg_strength_threshold: stats.demag_amg_strength_threshold,
            demag_amg_strength_threshold_is_set: stats.demag_amg_strength_threshold_is_set != 0,
            demag_amg_max_levels: stats.demag_amg_max_levels,
            demag_amg_max_levels_is_set: stats.demag_amg_max_levels_is_set != 0,
            demag_recover_wall_time_ns: stats.demag_recover_wall_time_ns,
            demag_energy_wall_time_ns: stats.demag_energy_wall_time_ns,
            rhs_wall_time_ns: stats.rhs_wall_time_ns,
            extra_energy_wall_time_ns: stats.extra_energy_wall_time_ns,
            snapshot_wall_time_ns: stats.snapshot_wall_time_ns,
            relaxation_preconditioner_wall_time_ns: stats.relaxation_preconditioner_wall_time_ns,
            relaxation_state_copy_wall_time_ns: stats.relaxation_state_copy_wall_time_ns,
            relaxation_state_upload_wall_time_ns: stats.relaxation_state_upload_wall_time_ns,
            relaxation_retraction_wall_time_ns: stats.relaxation_retraction_wall_time_ns,
            relaxation_gradient_wall_time_ns: stats.relaxation_gradient_wall_time_ns,
            relaxation_metric_wall_time_ns: stats.relaxation_metric_wall_time_ns,
            relaxation_line_search_wall_time_ns: stats.relaxation_line_search_wall_time_ns,
            relaxation_update_wall_time_ns: stats.relaxation_update_wall_time_ns,
            relaxation_preconditioner_cache_hits: stats.relaxation_preconditioner_cache_hits,
            relaxation_preconditioner_cache_misses: stats.relaxation_preconditioner_cache_misses,
            demag_solves: stats.demag_solve_count,
            poisson_iterations: stats.demag_linear_iterations,
            poisson_final_residual: stats.demag_linear_residual,
            demag_refreshed: stats.demag_solve_count > 0,
            requested_fem_omp_threads: stats.requested_omp_threads,
            effective_fem_omp_threads: stats.effective_omp_threads,
            fem_cpu_thread_cap_reason: stats.cpu_thread_cap_reason,
            ..StepStats::default()
        };
        copy_demag_diagnostics(&mut step_stats, &stats);
        self.apply_demag_solver_policy_to_step_stats(&mut step_stats);
        self.attach_transfer_audit(&mut step_stats)?;
        self.attach_representation_receipt(&mut step_stats)?;
        step_stats.per_object_scalars =
            if self.object_weights.len() == 1 && self.object_weights[0].0 == "free" {
                single_object_scalars("free", &step_stats)
            } else {
                weighted_object_scalars(&step_stats, &self.object_weights)
            };
        self.attach_native_object_average_m(&mut step_stats)?;
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
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_TORQUE,
            node_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_ani(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI,
            node_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_dmi(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI,
            node_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_mel(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_MEL,
            node_count,
        )
    }

    // FND-010 fix: add accessors for F-12 observables (cubic anisotropy, bulk DMI, Oersted, thermal)
    #[allow(dead_code)]
    pub fn copy_h_ani_cubic(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC,
            node_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_dmi_bulk(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI_BULK,
            node_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_oe(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_OE,
            node_count,
        )
    }

    #[allow(dead_code)]
    pub fn copy_h_therm(&self, node_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_THERM,
            node_count,
        )
    }

    pub fn begin_live_preview_snapshot(
        &self,
        request: &LivePreviewRequest,
    ) -> Result<NativeFemPreviewSnapshot, RunError> {
        let quantity = crate::quantities::normalize_quantity_id(&request.quantity)?;
        if quantity == QuantityId::FrozenSpins {
            let frozen_mask = self.frozen_mask.clone().ok_or_else(|| RunError {
                message: "native FEM preview 'frozen_spins': constraint is not active".to_string(),
            })?;
            return Ok(NativeFemPreviewSnapshot {
                handle: ptr::null_mut(),
                request: request.clone(),
                active_mask: Some(self.magnetic_node_mask.clone()),
                host_frozen_mask: Some(frozen_mask),
            });
        }
        let observable = fem_preview_observable(&request.quantity)?;
        let handle =
            unsafe { ffi::fullmag_fem_backend_begin_preview_snapshot(self.handle, observable) };
        if handle.is_null() {
            return Err(self.last_error_or("FEM GPU begin_preview_snapshot failed"));
        }
        let active_mask = (crate::quantities::quantity_spatial_domain(&request.quantity)
            == "magnetic_only")
            .then(|| self.magnetic_node_mask.clone());
        Ok(NativeFemPreviewSnapshot {
            handle,
            request: request.clone(),
            active_mask,
            host_frozen_mask: None,
        })
    }

    pub fn begin_energy_density_snapshot(
        &self,
        request: &LivePreviewRequest,
        node_count: usize,
        step: u64,
        time: f64,
        solver_dt: f64,
    ) -> Result<Option<NativeFemEnergyDensitySnapshot>, RunError> {
        let quantity = crate::quantities::normalized_quantity_name(&request.quantity)?;
        let Some(terms) = self.energy_density_terms.observables_for(quantity) else {
            return Ok(None);
        };
        let magnetization = self.begin_field_snapshot("m", step, time, solver_dt)?;
        let mut snapshots = Vec::with_capacity(terms.len());
        for (field, prefactor) in terms {
            snapshots.push((
                self.dg0_energy_projection.is_some(),
                prefactor,
                self.begin_field_snapshot(field, step, time, solver_dt)?,
            ));
        }
        Ok(Some(NativeFemEnergyDensitySnapshot {
            request: request.clone(),
            magnetization,
            terms: snapshots,
            cubic_energy_density: self
                .energy_density_terms
                .includes_cubic(quantity)
                .then(|| self.cubic_energy_density.clone())
                .flatten(),
            saturation_magnetisation_by_node: self.saturation_magnetisation_by_node.clone(),
            dg0_energy_projection: self.dg0_energy_projection.clone(),
            active_mask: self.magnetic_node_mask.clone(),
            node_count,
        }))
    }

    pub fn begin_field_snapshot(
        &self,
        name: &str,
        step: u64,
        time: f64,
        solver_dt: f64,
    ) -> Result<NativeFemFieldSnapshot, RunError> {
        let observable = fem_preview_observable(name)?;
        let handle =
            unsafe { ffi::fullmag_fem_backend_begin_field_snapshot(self.handle, observable) };
        if handle.is_null() {
            return Err(self.last_error_or("FEM GPU begin_field_snapshot failed"));
        }
        Ok(NativeFemFieldSnapshot {
            handle,
            name: name.to_string(),
            step,
            time,
            solver_dt,
        })
    }

    pub fn copy_live_preview_field(
        &self,
        request: &LivePreviewRequest,
        node_count: usize,
    ) -> Result<LivePreviewField, RunError> {
        if crate::quantities::normalize_quantity_id(&request.quantity)? == QuantityId::FrozenSpins {
            if node_count != self.magnetic_node_mask.len() {
                return Err(RunError {
                    message: format!(
                        "native FEM Frozen Spins preview requested {node_count} nodes for a {}-node carrier",
                        self.magnetic_node_mask.len()
                    ),
                });
            }
            let frozen_mask = self.frozen_mask.as_deref().ok_or_else(|| RunError {
                message: "native FEM preview 'frozen_spins': constraint is not active".to_string(),
            })?;
            return build_native_fem_frozen_spins_preview_field(
                request,
                frozen_mask,
                &self.magnetic_node_mask,
            );
        }
        let conservative_dg0_energy = self.dg0_energy_projection.is_some()
            && matches!(
                crate::quantities::normalized_quantity_name(&request.quantity)?,
                "eden_ex" | "eden_demag" | "eden_ext" | "eden_total"
            );
        if let Some(values) = self.copy_energy_density_values(&request.quantity, node_count)? {
            return Ok(build_native_fem_energy_density_preview_field(
                request,
                &values,
                self.magnetic_node_mask.as_ref().to_vec(),
                conservative_dg0_energy,
            ));
        }
        let values = self.copy_field(fem_preview_observable(&request.quantity)?, node_count)?;
        let active_mask = (crate::quantities::quantity_spatial_domain(&request.quantity)
            == "magnetic_only")
            .then(|| self.magnetic_node_mask.as_ref().to_vec());
        Ok(build_mesh_preview_field_with_active_mask(
            request,
            &values,
            active_mask,
        ))
    }

    fn copy_energy_density_values(
        &self,
        quantity: &str,
        node_count: usize,
    ) -> Result<Option<Vec<f64>>, RunError> {
        let quantity = crate::quantities::normalized_quantity_name(quantity)?;
        let Some(terms) = self.energy_density_terms.observables_for(quantity) else {
            return Ok(None);
        };
        let magnetization = self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_M,
            node_count,
        )?;
        let mut values = vec![0.0; node_count];
        for (field_name, prefactor) in terms {
            let field = self.copy_field(fem_preview_observable(field_name)?, node_count)?;
            if let Some(projection) = self.dg0_energy_projection.as_deref() {
                accumulate_dg0_field_dot_energy_density(
                    &mut values,
                    &magnetization,
                    &field,
                    projection,
                    prefactor,
                )?;
                continue;
            }
            accumulate_energy_density_term(
                &mut values,
                &magnetization,
                &field,
                &self.saturation_magnetisation_by_node,
                &self.magnetic_node_mask,
                prefactor,
            )?;
        }
        if self.energy_density_terms.includes_cubic(quantity) {
            let cubic = self
                .cubic_energy_density
                .as_deref()
                .ok_or_else(|| RunError {
                    message: "native FEM cubic energy-density configuration is missing".to_string(),
                })?;
            accumulate_cubic_energy_density(
                &mut values,
                &magnetization,
                cubic,
                &self.magnetic_node_mask,
            )?;
        }
        Ok(Some(values))
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

        Ok(DeviceInfo::from_ffi(info))
    }

    fn stage_completion_snapshot_ffi(&self) -> Result<ffi::fullmag_fem_stage_completion, RunError> {
        let mut completion = ffi::fullmag_fem_stage_completion {
            has_reason: 0,
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_TORQUE as i32,
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
        };
        let rc = unsafe { ffi::fullmag_fem_backend_stage_completion(self.handle, &mut completion) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU stage_completion failed"));
        }
        Ok(completion)
    }

    pub fn stage_completion(&self) -> Result<Option<StageCompletionIR>, RunError> {
        Ok(stage_completion_from_ffi(
            self.stage_completion_snapshot_ffi()?,
        ))
    }

    fn last_error_or(&self, fallback: &str) -> RunError {
        let err = unsafe { ffi::fullmag_fem_backend_last_error(self.handle) };
        let msg = if err.is_null() {
            fallback.to_string()
        } else {
            let message = unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string();
            if message.trim().is_empty() {
                fallback.to_string()
            } else {
                message
            }
        };
        RunError { message: msg }
    }
}

#[cfg(feature = "fem-gpu")]
impl NativeFemPreviewSnapshot {
    pub fn into_live_preview_field(mut self) -> Result<LivePreviewField, RunError> {
        if let Some(frozen_mask) = self.host_frozen_mask.take() {
            let active_mask = self.active_mask.take().ok_or_else(|| RunError {
                message: "native FEM Frozen Spins preview is missing its magnetic carrier mask"
                    .to_string(),
            })?;
            return build_native_fem_frozen_spins_preview_field(
                &self.request,
                &frozen_mask,
                &active_mask,
            );
        }
        let mut data: *const std::ffi::c_void = ptr::null();
        let mut len_bytes = 0u64;
        let mut desc = ffi::fullmag_fem_snapshot_desc {
            node_count: 0,
            component_count: 0,
            scalar_bytes: 0,
            scalar_type: ffi::fullmag_fem_snapshot_scalar_type::FULLMAG_FEM_SNAPSHOT_SCALAR_F64,
        };
        let rc = unsafe {
            ffi::fullmag_fem_preview_snapshot_wait(
                self.handle,
                &mut data,
                &mut len_bytes,
                &mut desc,
            )
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(RunError {
                message: "waiting for native FEM preview snapshot failed".to_string(),
            });
        }
        if desc.component_count != 3 || desc.scalar_bytes as usize != std::mem::size_of::<f64>() {
            return Err(RunError {
                message: "native FEM preview snapshot returned unsupported layout".to_string(),
            });
        }
        let expected_len = (desc.node_count as usize).saturating_mul(desc.component_count as usize);
        if len_bytes as usize != expected_len.saturating_mul(std::mem::size_of::<f64>()) {
            return Err(RunError {
                message: "native FEM preview snapshot returned mismatched payload length"
                    .to_string(),
            });
        }
        let values = unsafe { std::slice::from_raw_parts(data.cast::<f64>(), expected_len) }
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect::<Vec<_>>();
        Ok(build_mesh_preview_field_with_active_mask(
            &self.request,
            &values,
            self.active_mask
                .take()
                .map(|active_mask| active_mask.as_ref().to_vec()),
        ))
    }
}

#[cfg(feature = "fem-gpu")]
fn accumulate_energy_density_term(
    values: &mut [f64],
    magnetization: &[[f64; 3]],
    field: &[[f64; 3]],
    saturation_magnetisation_by_node: &[f64],
    active_mask: &[bool],
    prefactor: f64,
) -> Result<(), RunError> {
    let node_count = values.len();
    if magnetization.len() != node_count
        || field.len() != node_count
        || saturation_magnetisation_by_node.len() != node_count
        || active_mask.len() != node_count
    {
        return Err(RunError {
            message: "native FEM energy-density snapshot returned mismatched node count"
                .to_string(),
        });
    }
    for index in 0..node_count {
        if active_mask[index] {
            values[index] += prefactor
                * MU0
                * saturation_magnetisation_by_node[index]
                * dot(magnetization[index], field[index]);
        }
    }
    Ok(())
}

#[cfg(feature = "fem-gpu")]
fn tetrahedron_volume(nodes: &[[f64; 3]], element: [u32; 4]) -> Result<f64, RunError> {
    let [a, b, c, d] = element.map(|index| {
        nodes.get(index as usize).copied().ok_or_else(|| RunError {
            message: format!("DG0 energy projection tetrahedron references missing node {index}"),
        })
    });
    let [a, b, c, d] = [a?, b?, c?, d?];
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let cross = [
        ac[1] * ad[2] - ac[2] * ad[1],
        ac[2] * ad[0] - ac[0] * ad[2],
        ac[0] * ad[1] - ac[1] * ad[0],
    ];
    let volume = dot(ab, cross).abs() / 6.0;
    if !volume.is_finite() || volume <= 0.0 {
        return Err(RunError {
            message: "DG0 energy projection requires positive finite tetrahedron volumes"
                .to_string(),
        });
    }
    Ok(volume)
}

#[cfg(all(test, feature = "fem-gpu"))]
fn tetra_dg0_p1_dot_integral(
    nodes: &[[f64; 3]],
    elements: &[[u32; 4]],
    magnetic_elements: &[bool],
    saturation_magnetisation_by_element: &[f64],
    left: &[[f64; 3]],
    right: &[[f64; 3]],
) -> Result<f64, RunError> {
    if elements.len() != magnetic_elements.len()
        || elements.len() != saturation_magnetisation_by_element.len()
        || left.len() != nodes.len()
        || right.len() != nodes.len()
    {
        return Err(RunError {
            message: "DG0 energy projection topology/material/field lengths differ".to_string(),
        });
    }
    let mut integral = 0.0;
    for (element_index, element) in elements.iter().copied().enumerate() {
        if !magnetic_elements[element_index] {
            continue;
        }
        let ms = saturation_magnetisation_by_element[element_index];
        if !ms.is_finite() || ms <= 0.0 {
            return Err(RunError {
                message: format!(
                    "DG0 energy projection requires positive finite Ms on magnetic element {element_index}"
                ),
            });
        }
        let volume = tetrahedron_volume(nodes, element)?;
        let mut left_sum = [0.0; 3];
        let mut right_sum = [0.0; 3];
        let mut diagonal = 0.0;
        for node in element {
            let node = node as usize;
            let left_value = left.get(node).ok_or_else(|| RunError {
                message: format!("DG0 energy projection left field omits node {node}"),
            })?;
            let right_value = right.get(node).ok_or_else(|| RunError {
                message: format!("DG0 energy projection right field omits node {node}"),
            })?;
            diagonal += dot(*left_value, *right_value);
            for component in 0..3 {
                left_sum[component] += left_value[component];
                right_sum[component] += right_value[component];
            }
        }
        // Exact P1 tetra identity: integral (u . v) dV =
        // V/20 * (sum_i u_i . v_i + (sum_i u_i) . (sum_i v_i)).
        integral += ms * volume / 20.0 * (diagonal + dot(left_sum, right_sum));
    }
    Ok(integral)
}

#[cfg(feature = "fem-gpu")]
fn conservative_dg0_p1_dot_projection(
    nodes: &[[f64; 3]],
    elements: &[[u32; 4]],
    magnetic_elements: &[bool],
    saturation_magnetisation_by_element: &[f64],
    left: &[[f64; 3]],
    right: &[[f64; 3]],
) -> Result<Vec<f64>, RunError> {
    if elements.len() != magnetic_elements.len()
        || elements.len() != saturation_magnetisation_by_element.len()
        || left.len() != nodes.len()
        || right.len() != nodes.len()
    {
        return Err(RunError {
            message: "DG0 energy projection topology/material/field lengths differ".to_string(),
        });
    }
    let mut nodal_energy = vec![0.0; nodes.len()];
    let mut nodal_lumped_volume = vec![0.0; nodes.len()];
    for (element_index, element) in elements.iter().copied().enumerate() {
        if !magnetic_elements[element_index] {
            continue;
        }
        let ms = saturation_magnetisation_by_element[element_index];
        if !ms.is_finite() || ms <= 0.0 {
            return Err(RunError {
                message: format!(
                    "DG0 energy projection requires positive finite Ms on magnetic element {element_index}"
                ),
            });
        }
        let volume = tetrahedron_volume(nodes, element)?;
        let mut left_sum = [0.0; 3];
        let mut right_sum = [0.0; 3];
        let mut diagonal = 0.0;
        for node in element {
            let node = node as usize;
            let left_value = left.get(node).ok_or_else(|| RunError {
                message: format!("DG0 energy projection left field omits node {node}"),
            })?;
            let right_value = right.get(node).ok_or_else(|| RunError {
                message: format!("DG0 energy projection right field omits node {node}"),
            })?;
            diagonal += dot(*left_value, *right_value);
            for component in 0..3 {
                left_sum[component] += left_value[component];
                right_sum[component] += right_value[component];
            }
        }
        let element_integral = ms * volume / 20.0 * (diagonal + dot(left_sum, right_sum));
        for node in element {
            let node = node as usize;
            nodal_energy[node] += element_integral / 4.0;
            nodal_lumped_volume[node] += volume / 4.0;
        }
    }
    Ok(nodal_energy
        .into_iter()
        .zip(nodal_lumped_volume)
        .map(|(energy, volume)| if volume > 0.0 { energy / volume } else { 0.0 })
        .collect())
}

#[cfg(feature = "fem-gpu")]
fn accumulate_dg0_field_dot_energy_density(
    values: &mut [f64],
    magnetization: &[[f64; 3]],
    field: &[[f64; 3]],
    projection: &Dg0EnergyProjection,
    prefactor: f64,
) -> Result<(), RunError> {
    if values.len() != projection.nodes.len() {
        return Err(RunError {
            message: "DG0 energy projection output/node lengths differ".to_string(),
        });
    }
    let projected = conservative_dg0_p1_dot_projection(
        &projection.nodes,
        &projection.elements,
        &projection.magnetic_elements,
        &projection.saturation_magnetisation_by_element,
        magnetization,
        field,
    )?;
    for (value, contribution) in values.iter_mut().zip(projected) {
        *value += prefactor * MU0 * contribution;
    }
    Ok(())
}

#[cfg(all(test, feature = "fem-gpu"))]
fn tetra_p1_scalar_integral(
    nodes: &[[f64; 3]],
    elements: &[[u32; 4]],
    magnetic_elements: &[bool],
    values: &[f64],
) -> Result<f64, RunError> {
    if elements.len() != magnetic_elements.len() || values.len() != nodes.len() {
        return Err(RunError {
            message: "P1 scalar integration topology/field lengths differ".to_string(),
        });
    }
    let mut integral = 0.0;
    for (element_index, element) in elements.iter().copied().enumerate() {
        if !magnetic_elements[element_index] {
            continue;
        }
        let volume = tetrahedron_volume(nodes, element)?;
        let mut sum = 0.0;
        for node in element {
            sum += values[node as usize];
        }
        integral += volume * sum / 4.0;
    }
    Ok(integral)
}

#[cfg(feature = "fem-gpu")]
fn accumulate_cubic_energy_density(
    values: &mut [f64],
    magnetization: &[[f64; 3]],
    cubic: &NativeFemCubicEnergyDensity,
    active_mask: &[bool],
) -> Result<(), RunError> {
    let node_count = values.len();
    if magnetization.len() != node_count
        || cubic.kc1_by_node.len() != node_count
        || cubic.kc2_by_node.len() != node_count
        || cubic.kc3_by_node.len() != node_count
        || active_mask.len() != node_count
    {
        return Err(RunError {
            message: "native FEM cubic energy-density snapshot returned mismatched node count"
                .to_string(),
        });
    }
    let axis3 = [
        cubic.axis1[1] * cubic.axis2[2] - cubic.axis1[2] * cubic.axis2[1],
        cubic.axis1[2] * cubic.axis2[0] - cubic.axis1[0] * cubic.axis2[2],
        cubic.axis1[0] * cubic.axis2[1] - cubic.axis1[1] * cubic.axis2[0],
    ];
    for index in 0..node_count {
        if !active_mask[index] {
            continue;
        }
        let m1 = dot(magnetization[index], cubic.axis1);
        let m2 = dot(magnetization[index], cubic.axis2);
        let m3 = dot(magnetization[index], axis3);
        let m1_sq = m1 * m1;
        let m2_sq = m2 * m2;
        let m3_sq = m3 * m3;
        let sigma = m1_sq * m2_sq + m2_sq * m3_sq + m1_sq * m3_sq;
        values[index] += cubic.kc1_by_node[index] * sigma
            + cubic.kc2_by_node[index] * m1_sq * m2_sq * m3_sq
            + cubic.kc3_by_node[index] * sigma * sigma;
    }
    Ok(())
}

#[cfg(feature = "fem-gpu")]
impl NativeFemEnergyDensitySnapshot {
    pub fn into_live_preview_field(self) -> Result<LivePreviewField, RunError> {
        let magnetization = self.magnetization.into_vector_field()?;
        if magnetization.len() != self.node_count
            || self.saturation_magnetisation_by_node.len() != self.node_count
        {
            return Err(RunError {
                message: "native FEM energy-density snapshot returned mismatched node count"
                    .to_string(),
            });
        }
        let mut values = vec![0.0; self.node_count];
        let conservative_dg0_energy = self.terms.iter().any(|(conservative, _, _)| *conservative);
        for (conservative, prefactor, snapshot) in self.terms {
            let field = snapshot.into_vector_field()?;
            if conservative {
                let projection = self
                    .dg0_energy_projection
                    .as_deref()
                    .ok_or_else(|| RunError {
                        message: "DG0 energy projection metadata is missing".to_string(),
                    })?;
                accumulate_dg0_field_dot_energy_density(
                    &mut values,
                    &magnetization,
                    &field,
                    projection,
                    prefactor,
                )?;
                continue;
            }
            accumulate_energy_density_term(
                &mut values,
                &magnetization,
                &field,
                &self.saturation_magnetisation_by_node,
                &self.active_mask,
                prefactor,
            )?;
        }
        if let Some(cubic) = self.cubic_energy_density.as_deref() {
            accumulate_cubic_energy_density(&mut values, &magnetization, cubic, &self.active_mask)?;
        }
        Ok(build_native_fem_energy_density_preview_field(
            &self.request,
            &values,
            self.active_mask.as_ref().to_vec(),
            conservative_dg0_energy,
        ))
    }
}

#[cfg(all(test, feature = "fem-gpu"))]
mod task5_energy_density_tests {
    use super::*;

    #[test]
    fn task5_energy_density_terms_keep_distinct_native_operators() {
        let terms = NativeFemEnergyDensityTerms {
            exchange: true,
            demag: true,
            external: true,
            uniaxial_anisotropy: true,
            cubic_anisotropy: true,
            interfacial_dmi: true,
            bulk_dmi: true,
        };

        assert_eq!(
            terms.observables_for("eden_ani"),
            Some(vec![("H_ani", -0.5)])
        );
        assert!(terms.includes_cubic("eden_ani"));
        assert_eq!(
            terms.observables_for("eden_dmi"),
            Some(vec![("H_dmi", -0.5), ("H_dmi_bulk", -0.5)])
        );
        assert_eq!(
            terms.observables_for("eden_total"),
            Some(vec![
                ("H_ex", -0.5),
                ("H_demag", -0.5),
                ("H_ext", -1.0),
                ("H_ani", -0.5),
                ("H_dmi", -0.5),
                ("H_dmi_bulk", -0.5),
            ])
        );
        assert!(terms.includes_cubic("eden_total"));
    }

    #[test]
    fn task5_cubic_energy_density_uses_native_kc1_kc2_kc3_polynomial() {
        let cubic = NativeFemCubicEnergyDensity {
            kc1_by_node: vec![2.0, 11.0].into(),
            kc2_by_node: vec![3.0, 13.0].into(),
            kc3_by_node: vec![5.0, 17.0].into(),
            axis1: [1.0, 0.0, 0.0],
            axis2: [0.0, 1.0, 0.0],
        };
        let mut values = vec![0.0, 23.0];
        accumulate_cubic_energy_density(
            &mut values,
            &[[0.5, 0.5, std::f64::consts::FRAC_1_SQRT_2], [1.0, 0.0, 0.0]],
            &cubic,
            &[true, false],
        )
        .expect("cubic energy density");

        assert!((values[0] - 1.20703125).abs() < 1.0e-14, "{values:?}");
        assert_eq!(values[1], 23.0, "nonmagnetic node must remain masked");
    }

    #[test]
    fn task5_dg0_ms_projection_is_volume_lumped_at_shared_nodes() {
        let mesh = fullmag_ir::MeshIR {
            mesh_name: "two-tetrahedra".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 2.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [0, 1, 2, 4]]),
            element_markers: vec![1, 2],
            facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(Vec::new()),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: Default::default(),
        };

        let projected =
            project_element_scalars_to_nodes(&mesh, &[2.0, 8.0]).expect("valid DG0 projection");
        assert_eq!(projected, vec![6.0, 6.0, 6.0, 2.0, 8.0]);
    }

    #[test]
    fn task5_dg0_field_dot_energy_terms_preserve_weak_form_energy() {
        let nodes = vec![
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -2.0],
        ];
        let elements = vec![[0, 1, 2, 3], [0, 1, 2, 4]];
        let ms_element = vec![1.0, 3.0];
        let a = -3.0 + 2.0 * 2.0_f64.sqrt();
        let magnetization = vec![
            [1.0, 0.0, 0.0],
            [a, 0.0, 0.0],
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 0.0],
        ];
        let field = magnetization.clone();

        let projected_ms = vec![7.0 / 3.0, 7.0 / 3.0, 7.0 / 3.0, 1.0, 3.0];
        let old_nodal_density = magnetization
            .iter()
            .zip(&field)
            .zip(&projected_ms)
            .map(|((m, h), ms)| ms * dot(*m, *h))
            .collect::<Vec<_>>();
        let old_integral =
            tetra_p1_scalar_integral(&nodes, &elements, &[true, true], &old_nodal_density)
                .expect("old nodal projection integral");
        let weak_form_integral = tetra_dg0_p1_dot_integral(
            &nodes,
            &elements,
            &[true, true],
            &ms_element,
            &magnetization,
            &field,
        )
        .expect("weak-form integral");
        assert!((old_integral / weak_form_integral - 3.0).abs() < 1.0e-12);

        let projected = conservative_dg0_p1_dot_projection(
            &nodes,
            &elements,
            &[true, true],
            &ms_element,
            &magnetization,
            &field,
        )
        .expect("conservative DG0 projection");
        let projected_integral =
            tetra_p1_scalar_integral(&nodes, &elements, &[true, true], &projected)
                .expect("conservative projection integral");
        assert!((projected_integral - weak_form_integral).abs() < 1.0e-14);

        let demag_field = field
            .iter()
            .map(|value| [0.25 * value[0], value[1], value[2]])
            .collect::<Vec<_>>();
        let external_field = vec![[0.4, -0.2, 0.1]; nodes.len()];
        let projection = Dg0EnergyProjection {
            nodes: nodes.clone().into(),
            elements: elements.clone().into(),
            magnetic_elements: vec![true, true].into(),
            saturation_magnetisation_by_element: ms_element.clone().into(),
        };
        let terms = [
            ("exchange", field.as_slice(), -0.5),
            ("demag", demag_field.as_slice(), -0.5),
            ("external", external_field.as_slice(), -1.0),
        ];
        let mut total_values = vec![0.0; nodes.len()];
        let mut expected_total = 0.0;
        for (name, term_field, prefactor) in terms {
            let expected = prefactor
                * MU0
                * tetra_dg0_p1_dot_integral(
                    &nodes,
                    &elements,
                    &[true, true],
                    &ms_element,
                    &magnetization,
                    term_field,
                )
                .expect("term weak-form integral");
            let mut term_values = vec![0.0; nodes.len()];
            accumulate_dg0_field_dot_energy_density(
                &mut term_values,
                &magnetization,
                term_field,
                &projection,
                prefactor,
            )
            .expect("term conservative projection");
            let actual = tetra_p1_scalar_integral(&nodes, &elements, &[true, true], &term_values)
                .expect("term projected integral");
            assert!(
                (actual - expected).abs() < 1.0e-20,
                "{name}: {actual} != {expected}"
            );
            for (total, term) in total_values.iter_mut().zip(term_values) {
                *total += term;
            }
            expected_total += expected;
        }
        let actual_total =
            tetra_p1_scalar_integral(&nodes, &elements, &[true, true], &total_values)
                .expect("total projected integral");
        assert!((actual_total - expected_total).abs() < 1.0e-20);
    }

    #[test]
    fn async_energy_density_uses_per_node_ms_and_preserves_mask() {
        let magnetization = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let field = [[2.0, 0.0, 0.0], [0.0, 3.0, 0.0]];
        let mut values = vec![0.0; 2];

        accumulate_energy_density_term(
            &mut values,
            &magnetization,
            &field,
            &[4.0, 5.0],
            &[true, false],
            -0.5,
        )
        .expect("matching energy-density inputs");

        assert_eq!(values, vec![-4.0 * MU0, 0.0]);
    }
}

#[cfg(feature = "fem-gpu")]
impl NativeFemFieldSnapshot {
    fn wait_payload(
        &mut self,
    ) -> Result<(*const std::ffi::c_void, u64, NativeFemFieldSnapshotInfo), RunError> {
        let mut data: *const std::ffi::c_void = ptr::null();
        let mut len_bytes = 0u64;
        let mut desc = ffi::fullmag_fem_snapshot_desc {
            node_count: 0,
            component_count: 0,
            scalar_bytes: 0,
            scalar_type: ffi::fullmag_fem_snapshot_scalar_type::FULLMAG_FEM_SNAPSHOT_SCALAR_F64,
        };
        let rc = unsafe {
            ffi::fullmag_fem_field_snapshot_wait(self.handle, &mut data, &mut len_bytes, &mut desc)
        };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(RunError {
                message: format!(
                    "waiting for native FEM field snapshot '{}' failed",
                    self.name
                ),
            });
        }
        if !matches!(desc.component_count, 1 | 3)
            || desc.scalar_bytes as usize != std::mem::size_of::<f64>()
        {
            return Err(RunError {
                message: format!(
                    "native FEM field snapshot '{}' returned unsupported layout",
                    self.name
                ),
            });
        }
        let info = NativeFemFieldSnapshotInfo {
            node_count: desc.node_count as usize,
            component_count: desc.component_count as usize,
            scalar_bytes: desc.scalar_bytes as usize,
        };
        let expected_len = info.node_count.saturating_mul(info.component_count);
        if len_bytes as usize != expected_len.saturating_mul(info.scalar_bytes) {
            return Err(RunError {
                message: format!(
                    "native FEM field snapshot '{}' returned mismatched payload length",
                    self.name
                ),
            });
        }
        Ok((data, len_bytes, info))
    }

    pub(crate) fn info(&mut self) -> Result<NativeFemFieldSnapshotInfo, RunError> {
        let (_, _, info) = self.wait_payload()?;
        Ok(info)
    }

    pub(crate) fn write_payload(
        &mut self,
        writer: &mut impl Write,
    ) -> Result<NativeFemFieldSnapshotInfo, RunError> {
        let (data, len_bytes, info) = self.wait_payload()?;
        let scalar_count = info.node_count.saturating_mul(info.component_count);
        if !matches!(info.component_count, 1 | 3) || info.scalar_bytes != std::mem::size_of::<f64>()
        {
            return Err(RunError {
                message: format!(
                    "native FEM field snapshot '{}' returned unsupported payload layout",
                    self.name
                ),
            });
        }
        if len_bytes as usize != scalar_count.saturating_mul(std::mem::size_of::<f64>()) {
            return Err(RunError {
                message: format!(
                    "native FEM field snapshot '{}' returned mismatched payload length",
                    self.name
                ),
            });
        }
        let values = unsafe { std::slice::from_raw_parts(data.cast::<f64>(), scalar_count) };
        if info.component_count == 3 {
            // Native FEM vector snapshots are AoS triples, while the shared
            // Zarr field series is declared as [sample, component, cell].
            // Transpose at the writer boundary so the bytes match metadata.
            write_fem_aos_f64_as_component_major(values, info.node_count, writer).map_err(
                |error| RunError {
                    message: format!(
                        "failed to write native FEM field snapshot payload for '{}': {}",
                        self.name, error
                    ),
                },
            )?;
        } else {
            for value in values {
                writer
                    .write_all(&value.to_le_bytes())
                    .map_err(|error| RunError {
                        message: format!(
                            "failed to write native FEM scalar snapshot payload for '{}': {}",
                            self.name, error
                        ),
                    })?;
            }
        }
        Ok(info)
    }

    pub fn into_vector_field(mut self) -> Result<Vec<[f64; 3]>, RunError> {
        let (data, _, info) = self.wait_payload()?;
        let expected_len = info.node_count.saturating_mul(info.component_count);
        let values = unsafe { std::slice::from_raw_parts(data.cast::<f64>(), expected_len) };
        match info.component_count {
            3 => Ok(values.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()),
            1 => Ok(values.iter().map(|value| [*value, 0.0, 0.0]).collect()),
            _ => Err(RunError {
                message: format!(
                    "native FEM field snapshot '{}' returned unsupported component count {}",
                    self.name, info.component_count
                ),
            }),
        }
    }
}

#[cfg(feature = "fem-gpu")]
fn write_fem_aos_f64_as_component_major(
    values: &[f64],
    node_count: usize,
    writer: &mut impl Write,
) -> std::io::Result<()> {
    for component in 0..3usize {
        for node in 0..node_count {
            writer.write_all(&values[node * 3usize + component].to_le_bytes())?;
        }
    }
    Ok(())
}

#[cfg(feature = "fem-gpu")]
impl Drop for NativeFemPreviewSnapshot {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::fullmag_fem_preview_snapshot_destroy(self.handle) };
            self.handle = ptr::null_mut();
        }
    }
}

#[cfg(feature = "fem-gpu")]
impl Drop for NativeFemFieldSnapshot {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::fullmag_fem_field_snapshot_destroy(self.handle) };
            self.handle = ptr::null_mut();
        }
    }
}

#[cfg(feature = "fem-gpu")]
fn relaxation_driver_subphase_wall_time_ns(stats: &ffi::fullmag_fem_step_stats) -> u64 {
    stats
        .relaxation_state_copy_wall_time_ns
        .saturating_add(stats.relaxation_state_upload_wall_time_ns)
        .saturating_add(stats.relaxation_retraction_wall_time_ns)
        .saturating_add(stats.relaxation_gradient_wall_time_ns)
        .saturating_add(stats.relaxation_metric_wall_time_ns)
        .saturating_add(stats.relaxation_line_search_wall_time_ns)
        .saturating_add(stats.relaxation_update_wall_time_ns)
}

#[cfg(feature = "fem-gpu")]
impl Drop for NativeFemBackend {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            if self.stage_oersted_provider.is_some() {
                unsafe {
                    let _ = ffi::fullmag_fem_backend_set_stage_oersted_callback_v1(
                        self.handle,
                        std::ptr::null(),
                    );
                }
            }
            if self.stage_transport_provider.is_some() {
                unsafe {
                    let _ = ffi::fullmag_fem_backend_set_stage_transport_callback_v1(
                        self.handle,
                        std::ptr::null(),
                    );
                }
            }
            unsafe { ffi::fullmag_fem_backend_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
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

#[cfg(all(test, feature = "fem-gpu"))]
mod tests {
    use super::*;

    #[test]
    fn frozen_spins_preview_is_a_binary_scalar_on_the_magnetic_fem_carrier() {
        let request = LivePreviewRequest {
            quantity: "frozen_spins".to_string(),
            auto_scale_enabled: false,
            ..Default::default()
        };
        let active_mask = Arc::<[bool]>::from(vec![true, true, false, true]);
        let frozen_mask = Arc::<[bool]>::from(vec![true, false, false, true]);

        let direct =
            build_native_fem_frozen_spins_preview_field(&request, &frozen_mask, &active_mask)
                .expect("direct FEM Frozen Spins preview");
        let asynchronous = NativeFemPreviewSnapshot {
            handle: ptr::null_mut(),
            request,
            active_mask: Some(active_mask),
            host_frozen_mask: Some(frozen_mask),
        }
        .into_live_preview_field()
        .expect("host-backed FEM Frozen Spins preview snapshot");

        assert_eq!(direct.quantity, "frozen_spins");
        assert_eq!(direct.unit, "1");
        assert_eq!(direct.vector_field_values, vec![1.0, 0.0, 0.0, 1.0]);
        assert_eq!(direct.active_mask, Some(vec![true, true, false, true]));
        assert_eq!(asynchronous, direct);
    }

    #[test]
    fn demag_diagnostics_mapping_preserves_each_ffi_field() {
        let mut ffi_stats =
            unsafe { std::mem::MaybeUninit::<ffi::fullmag_fem_step_stats>::zeroed().assume_init() };
        ffi_stats.demag_potential_order = 3;
        ffi_stats.demag_potential_true_dof_count = 123_456;
        ffi_stats.demag_variational_energy_joules = -7.25;
        ffi_stats.demag_recovered_field_energy_joules = 9.5;
        let mut step_stats = StepStats::default();

        copy_demag_diagnostics(&mut step_stats, &ffi_stats);

        assert_eq!(step_stats.demag_potential_order, 3);
        assert_eq!(step_stats.demag_potential_true_dof_count, 123_456);
        assert_eq!(step_stats.demag_variational_energy_joules, -7.25);
        assert_eq!(step_stats.demag_recovered_field_energy_joules, 9.5);
    }

    #[test]
    fn endpoint_cache_telemetry_mapping_preserves_public_receipt() {
        let mut raw = ffi::fullmag_fem_endpoint_cache_telemetry_v1::default();
        raw.abi_version = ffi::FULLMAG_FEM_ENDPOINT_CACHE_TELEMETRY_V1_ABI_VERSION;
        raw.struct_size = std::mem::size_of_val(&raw) as u32;
        raw.available = 1;
        raw.final_refresh_reason = ffi::FULLMAG_FEM_ENDPOINT_REFRESH_CACHE_HIT;
        raw.cache_state_valid = 1;
        raw.cache_time_valid = 1;
        raw.cache_dynamic_sources_valid = 1;
        raw.cache_transport_valid = 1;
        raw.cache_projection_valid = 1;
        raw.final_rhs_evaluations = 2;
        raw.extra_poisson_solves = 3;
        raw.endpoint_cache_hits = 4;
        raw.endpoint_refreshes = 5;
        raw.accepted_step_wall_time_ns = 6;

        let telemetry = endpoint_cache_telemetry_from_ffi(&raw)
            .unwrap()
            .expect("available endpoint receipt");
        assert_eq!(telemetry.final_refresh_reason, "cache_hit");
        assert!(telemetry.cache_state_valid);
        assert!(telemetry.cache_time_valid);
        assert!(telemetry.cache_dynamic_sources_valid);
        assert!(telemetry.cache_transport_valid);
        assert!(telemetry.cache_projection_valid);
        assert_eq!(telemetry.final_rhs_evaluations, 2);
        assert_eq!(telemetry.extra_poisson_solves, 3);
        assert_eq!(telemetry.endpoint_cache_hits, 4);
        assert_eq!(telemetry.endpoint_refreshes, 5);
        assert_eq!(telemetry.accepted_step_wall_time_ns, 6);
    }

    #[test]
    fn endpoint_cache_telemetry_mapping_rejects_corrupt_receipts() {
        let mut raw = ffi::fullmag_fem_endpoint_cache_telemetry_v1::default();
        raw.abi_version = ffi::FULLMAG_FEM_ENDPOINT_CACHE_TELEMETRY_V1_ABI_VERSION;
        raw.struct_size = std::mem::size_of_val(&raw) as u32;
        raw.available = 1;
        raw.final_refresh_reason = 99;
        assert!(endpoint_cache_telemetry_from_ffi(&raw).is_err());

        raw.final_refresh_reason = ffi::FULLMAG_FEM_ENDPOINT_REFRESH_CACHE_HIT;
        raw.cache_state_valid = 2;
        assert!(endpoint_cache_telemetry_from_ffi(&raw).is_err());
    }

    #[test]
    fn representation_receipt_mapping_preserves_public_provenance() {
        let raw = ffi::fullmag_fem_representation_receipt_v1 {
            abi_version: ffi::FULLMAG_FEM_REPRESENTATION_RECEIPT_V1_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_representation_receipt_v1>() as u32,
            state_space: ffi::FULLMAG_FEM_REPRESENTATION_SPACE_LOCAL_NODE_AOS,
            ms_location: ffi::FULLMAG_FEM_MATERIAL_LOCATION_ELEMENT_DG0,
            a_location: ffi::FULLMAG_FEM_MATERIAL_LOCATION_NODAL_P1,
            reserved0: 0,
            local_node_count: 8,
            true_node_count: 6,
            periodic_map_revision: 17,
            representation_copy_count: 11,
            gather_scatter_bytes: 1_056,
            invalid_space_assertion_count: 0,
            hot_loop_representation_copy_count: 7,
            hot_loop_gather_scatter_bytes: 672,
        };

        let receipt = representation_receipt_from_ffi(&raw).unwrap();
        assert_eq!(receipt.schema_version, 1);
        assert_eq!(receipt.state_space, FemStateRepresentation::LocalNodeAos);
        assert_eq!(receipt.ms_location, FemMaterialFieldLocation::ElementDg0);
        assert_eq!(receipt.a_location, FemMaterialFieldLocation::NodalP1);
        assert_eq!(receipt.local_node_count, 8);
        assert_eq!(receipt.true_node_count, 6);
        assert_eq!(receipt.periodic_map_revision, 17);
        assert_eq!(receipt.representation_copy_count, 11);
        assert_eq!(receipt.gather_scatter_bytes, 1_056);
        assert_eq!(receipt.hot_loop_representation_copy_count, 7);
        assert_eq!(receipt.hot_loop_gather_scatter_bytes, 672);
    }

    #[test]
    fn representation_receipt_mapping_rejects_corrupt_provenance() {
        let mut raw = ffi::fullmag_fem_representation_receipt_v1 {
            abi_version: ffi::FULLMAG_FEM_REPRESENTATION_RECEIPT_V1_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_representation_receipt_v1>() as u32,
            state_space: ffi::FULLMAG_FEM_REPRESENTATION_SPACE_LOCAL_NODE_AOS,
            ms_location: ffi::FULLMAG_FEM_MATERIAL_LOCATION_SCALAR,
            a_location: ffi::FULLMAG_FEM_MATERIAL_LOCATION_SCALAR,
            local_node_count: 4,
            true_node_count: 2,
            periodic_map_revision: 0,
            ..Default::default()
        };
        assert!(representation_receipt_from_ffi(&raw).is_err());

        raw.periodic_map_revision = 1;
        raw.reserved0 = 1;
        assert!(representation_receipt_from_ffi(&raw).is_err());

        raw.reserved0 = 0;
        raw.hot_loop_representation_copy_count = 2;
        raw.representation_copy_count = 1;
        assert!(representation_receipt_from_ffi(&raw).is_err());
    }

    #[test]
    fn representation_receipt_reaches_public_step_stats() {
        if !is_gpu_available() {
            eprintln!("skipping representation receipt E2E: native MFEM stack unavailable");
            return;
        }
        let plan = make_exchange_only_plan();
        let mut backend = NativeFemBackend::create(&plan).expect("native FEM receipt create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed timestep"))
            .expect("native FEM receipt step");
        let receipt = stats
            .fem_representation_receipt
            .expect("public StepStats representation receipt");
        assert_eq!(receipt.schema_version, 1);
        assert_eq!(receipt.state_space, FemStateRepresentation::LocalNodeAos);
        assert_eq!(receipt.ms_location, FemMaterialFieldLocation::Scalar);
        assert_eq!(receipt.a_location, FemMaterialFieldLocation::Scalar);
        assert_eq!(receipt.local_node_count, plan.mesh.nodes.len() as u64);
        assert_eq!(receipt.true_node_count, plan.mesh.nodes.len() as u64);
        assert_eq!(receipt.periodic_map_revision, 0);
        assert_eq!(receipt.invalid_space_assertion_count, 0);
    }

    #[test]
    fn native_fem_nonfinite_torque_is_error() {
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0] {
            assert!(checked_native_nonnegative("max_torque_Apm", value).is_err());
        }
        assert_eq!(
            checked_native_nonnegative("max_torque_Apm", 0.0).unwrap(),
            0.0
        );
    }

    #[test]
    fn native_fem_rejects_corrupt_mesh_before_ffi_packaging() {
        let mut plan = make_test_plan();
        plan.mesh.set_tet4_cells(vec![[0, 1, 3, 2]]);

        let error = match NativeFemBackend::create_with_initial_effective_field(&plan, false) {
            Ok(_) => panic!("inverted mesh must fail before native ABI packaging"),
            Err(error) => error,
        };
        assert!(error.message.contains("negative tetra orientation"));
        assert!(error.message.contains("before ABI packaging"));
    }

    #[test]
    fn runner_mesh_pack_preserves_all_typed_csr_buffers_and_lifetimes() {
        let mut plan = make_test_plan();
        plan.mesh.nodes.extend([
            [2.0, 0.0, 0.0],
            [3.0, 0.0, 0.0],
            [2.0, 1.0, 0.0],
            [2.0, 0.0, 1.0],
            [3.0, 0.0, 1.0],
            [2.0, 1.0, 1.0],
        ]);
        plan.mesh.cells = fullmag_ir::FemConnectivityIR {
            types: vec![
                fullmag_ir::FemCellTypeIR::Tet4,
                fullmag_ir::FemCellTypeIR::Prism6,
            ],
            offsets: vec![0, 4, 10],
            nodes: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
            global_ordinals: vec![41, 99],
            mesh_parts: Vec::new(),
        };
        plan.mesh.element_markers = vec![7, 8];
        plan.mesh.facets = fullmag_ir::FemFacetConnectivityIR {
            types: vec![
                fullmag_ir::FemFacetTypeIR::Tri3,
                fullmag_ir::FemFacetTypeIR::Quad4,
            ],
            roles: vec![
                fullmag_ir::FemFacetRoleIR::Exterior,
                fullmag_ir::FemFacetRoleIR::PeriodicSeam,
            ],
            offsets: vec![0, 3, 7],
            nodes: vec![0, 2, 1, 4, 5, 8, 7],
            global_ordinals: vec![501, 502],
        };
        plan.mesh.boundary_markers = vec![11, 12];
        plan.mesh.periodic_node_pairs = vec![MeshPeriodicNodePairIR {
            pair_id: "p".into(),
            node_a: 4,
            node_b: 5,
        }];
        plan.mesh.periodic_boundary_pairs = vec![MeshPeriodicBoundaryPairIR {
            pair_id: "p".into(),
            source_marker: None,
            destination_marker: None,
            marker_a: 11,
            marker_b: 12,
            translation: None,
            tolerance: None,
            axis_hint: None,
            orientation: None,
            pairing_policy: None,
        }];
        let packed = PackedNativeMesh::new(&plan.mesh);
        let descriptor = packed.descriptor(&plan.mesh);
        assert_eq!(
            descriptor.abi_version,
            ffi::FULLMAG_FEM_MESH_DESC_ABI_VERSION
        );
        assert_eq!(
            descriptor.struct_size,
            std::mem::size_of::<ffi::fullmag_fem_mesh_desc>() as u32
        );
        assert_eq!(descriptor.nodes_xyz_len, 30);
        assert_eq!(descriptor.cell_types_len, 2);
        assert_eq!(descriptor.cell_offsets_len, 3);
        assert_eq!(descriptor.cell_nodes_len, 10);
        assert_eq!(descriptor.cell_global_ordinals_len, 2);
        assert_eq!(descriptor.cell_markers_len, 2);
        assert_eq!(descriptor.facet_types_len, 2);
        assert_eq!(descriptor.facet_roles_len, 2);
        assert_eq!(descriptor.facet_offsets_len, 3);
        assert_eq!(descriptor.facet_nodes_len, 7);
        assert_eq!(descriptor.facet_global_ordinals_len, 2);
        assert_eq!(descriptor.facet_markers_len, 2);
        assert_eq!(descriptor.periodic_node_pairs_len, 2);
        assert_eq!(descriptor.periodic_boundary_pair_markers_len, 2);
        unsafe {
            assert_eq!(
                std::slice::from_raw_parts(descriptor.nodes_xyz, 30),
                packed.nodes_xyz
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.cell_types, 2),
                &[1, 2]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.cell_offsets, 3),
                &[0, 4, 10]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.cell_nodes, 10),
                &[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.cell_global_ordinals, 2),
                &[41, 99]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.cell_markers, 2),
                &[7, 8]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.facet_types, 2),
                &[1, 2]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.facet_roles, 2),
                &[1, 3]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.facet_offsets, 3),
                &[0, 3, 7]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.facet_nodes, 7),
                &[0, 2, 1, 4, 5, 8, 7]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.facet_global_ordinals, 2),
                &[501, 502]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.facet_markers, 2),
                &[11, 12]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.periodic_node_pairs, 2),
                &[4, 5]
            );
            assert_eq!(
                std::slice::from_raw_parts(descriptor.periodic_boundary_pair_markers, 2),
                &[11, 12]
            );
        }
        assert_eq!(packed.nodes_xyz.len(), plan.mesh.nodes.len() * 3);

        let mut empty_mesh = plan.mesh.clone();
        empty_mesh.nodes.clear();
        empty_mesh.cells.types.clear();
        empty_mesh.cells.offsets.clear();
        empty_mesh.cells.nodes.clear();
        empty_mesh.cells.global_ordinals.clear();
        empty_mesh.element_markers.clear();
        empty_mesh.facets.types.clear();
        empty_mesh.facets.roles.clear();
        empty_mesh.facets.offsets.clear();
        empty_mesh.facets.nodes.clear();
        empty_mesh.facets.global_ordinals.clear();
        empty_mesh.boundary_markers.clear();
        empty_mesh.periodic_node_pairs.clear();
        empty_mesh.periodic_boundary_pairs.clear();
        let empty_packed = PackedNativeMesh::new(&empty_mesh);
        let empty = empty_packed.descriptor(&empty_mesh);
        assert!(empty.nodes_xyz.is_null());
        assert!(empty.cell_types.is_null());
        assert!(empty.cell_offsets.is_null());
        assert!(empty.cell_nodes.is_null());
        assert!(empty.cell_global_ordinals.is_null());
        assert!(empty.cell_markers.is_null());
        assert!(empty.facet_types.is_null());
        assert!(empty.facet_roles.is_null());
        assert!(empty.facet_offsets.is_null());
        assert!(empty.facet_nodes.is_null());
        assert!(empty.facet_global_ordinals.is_null());
        assert!(empty.facet_markers.is_null());
        assert!(empty.periodic_node_pairs.is_null());
        assert!(empty.periodic_boundary_pair_markers.is_null());
        assert_eq!(empty.nodes_xyz_len, 0);
        assert_eq!(empty.cell_types_len, 0);
        assert_eq!(empty.cell_offsets_len, 0);
        assert_eq!(empty.cell_nodes_len, 0);
        assert_eq!(empty.cell_global_ordinals_len, 0);
        assert_eq!(empty.cell_markers_len, 0);
        assert_eq!(empty.facet_types_len, 0);
        assert_eq!(empty.facet_roles_len, 0);
        assert_eq!(empty.facet_offsets_len, 0);
        assert_eq!(empty.facet_nodes_len, 0);
        assert_eq!(empty.facet_global_ordinals_len, 0);
        assert_eq!(empty.facet_markers_len, 0);
        assert_eq!(empty.periodic_node_pairs_len, 0);
        assert_eq!(empty.periodic_boundary_pair_markers_len, 0);
    }

    #[test]
    fn native_fem_completion_uses_canonical_metric_ids() {
        let source = include_str!("../../../backends/fem/cpu/mfem/runtime/stage_completion.cpp");
        assert!(!source.contains("\"max_torque_Apm\""));
        assert!(source.contains("\"max_torque_apm\""));
    }
    use fullmag_engine::fem::{FemLlgProblem, FemLlgState, MeshTopology};
    use fullmag_engine::{EffectiveFieldTerms, LlgConfig, MaterialParameters, TimeIntegrator};
    use fullmag_ir::{
        AdaptiveTimeStepIR, AirBoxConfigIR, ExchangeBoundaryCondition, ExecutionPrecision,
        FemLinearSolverPolicy, FemMeshPartIR, FemMeshPartRole, FemMeshPartSelector,
        FemObjectSegmentIR, FemPlanIR, IntegratorChoice, MaterialIR, MeshIR,
        MeshPeriodicBoundaryPairIR, MeshPeriodicNodePairIR, RelaxStopIR, RelaxationAlgorithmIR,
        RelaxationControlIR, ResolvedFemDemagIR,
    };

    #[test]
    fn fem_snapshot_writer_transposes_aos_payload_to_component_major() {
        let values = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        let mut bytes = Vec::new();

        write_fem_aos_f64_as_component_major(&values, 2, &mut bytes).expect("transpose payload");

        let decoded = bytes
            .chunks_exact(std::mem::size_of::<f64>())
            .map(|chunk| f64::from_le_bytes(chunk.try_into().expect("f64 chunk")))
            .collect::<Vec<_>>();
        assert_eq!(decoded, vec![1.0, 4.0, 2.0, 5.0, 3.0, 6.0]);
    }

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &str) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            if let Some(previous) = self.previous.take() {
                std::env::set_var(self.key, previous);
            } else {
                std::env::remove_var(self.key);
            }
        }
    }

    fn source_block<'a>(source: &'a str, start_marker: &str, end_marker: &str) -> &'a str {
        let start = source.find(start_marker).expect(start_marker);
        let rest = &source[start..];
        let end = rest.find(end_marker).expect(end_marker);
        &rest[..end]
    }

    fn make_test_plan() -> FemPlanIR {
        FemPlanIR {
            frozen_spins: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
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
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: false,
            external_field: Some([1.0, 2.0, 3.0]),
            antenna_zeeman_masks: Vec::new(),
            field_drives: Vec::new(),
            field_drive_geometry_masks: Vec::new(),
            time_stage: Default::default(),
            current_modules: vec![],
            spin_transport_plans: vec![],
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
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
            spin_torque_contract: None,
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
    fn task5_energy_density_terms_follow_resolved_spatial_operator_contracts() {
        let mut plan = make_test_plan();
        plan.enable_exchange = false;
        plan.external_field = None;
        plan.material.ku_field = Some(vec![1.0; plan.mesh.nodes.len()]);
        plan.material.kc2_field = Some(vec![2.0; plan.mesh.nodes.len()]);
        plan.dind_field = Some(vec![3.0; plan.mesh.nodes.len()]);
        plan.dbulk_field = Some(vec![4.0; plan.mesh.nodes.len()]);

        let terms = NativeFemEnergyDensityTerms::from_plan(&plan);
        assert_eq!(
            terms.observables_for("eden_total"),
            Some(vec![("H_ani", -0.5), ("H_dmi", -0.5), ("H_dmi_bulk", -0.5),])
        );
        assert!(terms.includes_cubic("eden_total"));
    }

    #[test]
    fn task5_dg0_ms_contract_takes_precedence_over_nodal_and_uniform_ms() {
        let mut plan = make_test_plan();
        plan.material.saturation_magnetisation = 1.0;
        plan.material.ms_field = Some(vec![3.0; plan.mesh.nodes.len()]);
        plan.ms_element_field = Some(vec![7.0]);

        let values = resolved_saturation_magnetisation_by_node(&plan).expect("resolved DG0 Ms");
        assert!(
            values.iter().all(|value| (*value - 7.0).abs() < 1.0e-12),
            "DG0 Ms must take precedence over nodal and uniform Ms: {values:?}"
        );
    }

    #[test]
    fn native_fem_direct_minimizer_without_solver_timestep_uses_internal_seed() {
        let mut plan = make_test_plan();
        plan.fixed_timestep = None;
        plan.adaptive_timestep = None;
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_relaxation_time_s: None,
            },
        });

        assert_eq!(
            resolve_native_fem_plan_dt_seconds(&plan).expect("direct minimizer seed dt"),
            crate::NON_LLG_RELAXATION_ABI_DT_PLACEHOLDER
        );
    }

    #[test]
    fn native_fem_tangent_plane_without_solver_timestep_uses_internal_abi_seed() {
        let mut plan = make_test_plan();
        plan.fixed_timestep = None;
        plan.adaptive_timestep = None;
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::TangentPlaneImplicit,
            stop: RelaxStopIR {
                torque_tolerance_apm: Some(1e-6),
                energy_tolerance_j: None,
                max_steps: Some(10),
                max_relaxation_time_s: None,
            },
        });

        assert_eq!(
            resolve_native_fem_plan_dt_seconds(&plan).expect("TPI internal ABI seed"),
            crate::NON_LLG_RELAXATION_ABI_DT_PLACEHOLDER
        );
        assert_eq!(plan.fixed_timestep, None);
        assert_eq!(plan.adaptive_timestep, None);
    }

    #[test]
    fn native_fem_non_relaxation_without_solver_timestep_still_errors() {
        let mut plan = make_test_plan();
        plan.fixed_timestep = None;
        plan.adaptive_timestep = None;
        plan.relaxation = None;

        let err = resolve_native_fem_plan_dt_seconds(&plan)
            .expect_err("non-relaxation plan must still require timestep policy");
        assert!(
            err.message
                .contains("no fixed_timestep or adaptive_timestep"),
            "{}",
            err.message
        );
    }

    #[test]
    fn native_runtime_markers_infer_airbox_ranges_when_element_markers_are_empty() {
        let mut plan = make_test_plan();
        plan.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir;
        plan.mesh.nodes.push([2.0, 0.0, 0.0]);
        plan.mesh.set_tet4_cells(vec![[0, 1, 2, 3], [1, 2, 3, 4]]);
        plan.mesh.element_markers.clear();
        plan.object_segments.clear();
        plan.mesh_parts = vec![
            FemMeshPartIR {
                id: "part:magnet".to_string(),
                label: "magnet".to_string(),
                role: FemMeshPartRole::MagneticObject,
                object_id: Some("magnet".to_string()),
                geometry_id: Some("magnet_geom".to_string()),
                material_id: None,
                element_selector: FemMeshPartSelector::ElementRange { start: 0, count: 1 },
                boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                    start: 0,
                    count: 0,
                },
                node_selector: FemMeshPartSelector::NodeRange { start: 0, count: 4 },
                boundary_face_indices: Vec::new(),
                node_indices: Vec::new(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
            FemMeshPartIR {
                id: "part:air".to_string(),
                label: "Airbox".to_string(),
                role: FemMeshPartRole::Air,
                object_id: None,
                geometry_id: None,
                material_id: None,
                element_selector: FemMeshPartSelector::ElementRange { start: 1, count: 1 },
                boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange {
                    start: 0,
                    count: 0,
                },
                node_selector: FemMeshPartSelector::NodeRange { start: 1, count: 4 },
                boundary_face_indices: Vec::new(),
                node_indices: Vec::new(),
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
                parent_id: None,
            },
        ];

        let markers = infer_native_runtime_element_markers(&plan)
            .expect("native marker inference should succeed")
            .expect("shared-domain marker inference should return explicit markers");

        assert_eq!(markers, vec![1, 0]);
    }

    #[test]
    fn native_runtime_markers_normalize_mesh_only_object_region_markers() {
        let mut plan = make_test_plan();
        plan.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir;
        plan.mesh.nodes.push([2.0, 0.0, 0.0]);
        plan.mesh
            .set_tet4_cells(vec![[0, 1, 2, 3], [0, 1, 2, 4], [1, 2, 3, 4]]);
        plan.mesh.element_markers = vec![1, 2, 0];
        plan.object_segments = vec![
            FemObjectSegmentIR {
                object_id: "film".to_string(),
                geometry_id: Some("film".to_string()),
                node_start: 0,
                node_count: 4,
                element_start: 0,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 0,
            },
            FemObjectSegmentIR {
                object_id: "film".to_string(),
                geometry_id: Some("film:refinement".to_string()),
                node_start: 0,
                node_count: 5,
                element_start: 1,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 0,
            },
            FemObjectSegmentIR {
                object_id: "__air__".to_string(),
                geometry_id: None,
                node_start: 0,
                node_count: 0,
                element_start: 2,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 0,
            },
        ];

        let markers = normalized_native_runtime_element_markers(&plan)
            .expect("mesh-only region markers should normalize")
            .expect("non-empty element markers should produce runtime markers");

        assert_eq!(markers, vec![1, 1, 0]);
    }

    #[test]
    fn native_runtime_markers_reject_unexplained_multiple_nonzero_markers() {
        let mut plan = make_test_plan();
        plan.mesh
            .set_tet4_cells(vec![[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]]);
        plan.mesh.element_markers = vec![1, 2, 0];
        plan.object_segments.clear();
        plan.mesh_parts.clear();
        plan.region_materials.clear();

        let error = normalized_native_runtime_element_markers(&plan)
            .expect_err("unexplained multiple nonzero markers must be rejected");

        assert!(error.message.contains("without region_materials"));
    }

    #[test]
    fn native_runtime_markers_reject_region_materials_missing_mesh_marker() {
        let mut plan = make_test_plan();
        plan.mesh
            .set_tet4_cells(vec![[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]]);
        plan.mesh.element_markers = vec![1, 2, 0];
        plan.region_materials = vec![fullmag_ir::FemRegionMaterialIR {
            object_id: "film".to_string(),
            element_marker: 1,
            material: plan.material.clone(),
        }];

        let error = normalized_native_runtime_element_markers(&plan)
            .expect_err("region_materials must declare every nonzero mesh marker");

        assert!(error.message.contains("not declared in region_materials"));
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
                max_relaxation_time_s: None,
            },
        });
        assert!(!native_fem_precession_enabled(&plan));

        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: None,
                max_relaxation_time_s: None,
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
        assert!(
            plan_desc_body.contains(".ms_element_field")
                && plan_desc_body.contains(".a_element_field"),
            "native FEM FFI plan must pass FEM per-element material coefficient arrays through to the native ABI"
        );
    }

    #[test]
    fn native_fem_cpu_relax_step_algorithms_advance_when_mfem_stack_is_available() {
        if !is_cpu_available() {
            eprintln!(
                "skipping native FEM relaxation ABI runtime test: CPU MFEM stack unavailable"
            );
            return;
        }

        for algorithm in [
            RelaxationAlgorithmIR::ProjectedGradientBb,
            RelaxationAlgorithmIR::NonlinearCg,
            RelaxationAlgorithmIR::TangentPlaneImplicit,
        ] {
            let mut plan = make_test_plan();
            plan.mfem_device_string = Some("cpu".to_string());
            plan.relaxation = Some(RelaxationControlIR {
                algorithm,
                stop: RelaxStopIR {
                    torque_tolerance_apm: None,
                    energy_tolerance_j: None,
                    max_steps: Some(1),
                    max_relaxation_time_s: None,
                },
            });

            let mut backend = NativeFemBackend::create_with_initial_effective_field(&plan, true)
                .expect("native FEM relaxation create");
            let initial_stats = backend
                .snapshot_step_stats(plan.mesh.nodes.len())
                .expect("initial native FEM relaxation stats");
            let stats = backend
                .relax_step(algorithm, plan.mesh.nodes.len())
                .expect("native FEM relaxation step")
                .expect("native FEM relaxation step should not be interrupted");
            let magnetization = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");

            assert_eq!(
                stats.step, 1,
                "{algorithm:?} must publish one accepted step"
            );
            assert!(stats.dt.is_finite(), "{algorithm:?} dt must be finite");
            assert!(stats.dt >= 0.0, "{algorithm:?} dt must be non-negative");
            assert!(
                stats.e_total.is_finite(),
                "{algorithm:?} total energy must be finite"
            );
            assert!(
                stats.max_torque_Apm.is_finite(),
                "{algorithm:?} torque must be finite"
            );
            assert!(
                stats.e_total <= initial_stats.e_total + initial_stats.e_total.abs() * 1e-8 + 1e-24,
                "{algorithm:?} must not increase energy beyond tolerance: initial={} final={}",
                initial_stats.e_total,
                stats.e_total
            );
            for (node, m) in magnetization.iter().enumerate() {
                let norm = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
                assert_scalar_close(
                    &format!("{algorithm:?}.m_norm[{node}]"),
                    norm,
                    1.0,
                    5e-12,
                    1e-12,
                );
            }
        }
    }

    #[test]
    fn native_fem_direct_minimizers_advance_with_local_energy_terms_when_mfem_stack_is_available() {
        if !is_cpu_available() {
            eprintln!(
                "skipping native FEM direct-minimizer local-energy test: CPU MFEM stack unavailable"
            );
            return;
        }

        for algorithm in [
            RelaxationAlgorithmIR::ProjectedGradientBb,
            RelaxationAlgorithmIR::NonlinearCg,
        ] {
            let mut plan = make_test_plan();
            plan.mfem_device_string = Some("cpu".to_string());
            plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
            plan.external_field = Some([0.0, 0.0, 2.0e5]);
            plan.material.uniaxial_anisotropy = Some(5.0e4);
            plan.material.uniaxial_anisotropy_k2 = Some(1.0e4);
            plan.material.anisotropy_axis = Some([0.0, 0.0, 1.0]);
            plan.relaxation = Some(RelaxationControlIR {
                algorithm,
                stop: RelaxStopIR {
                    torque_tolerance_apm: None,
                    energy_tolerance_j: None,
                    max_steps: Some(1),
                    max_relaxation_time_s: None,
                },
            });

            let mut backend = NativeFemBackend::create_with_initial_effective_field(&plan, true)
                .expect("native FEM direct-minimizer local-energy create");
            let initial_stats = backend
                .snapshot_step_stats(plan.mesh.nodes.len())
                .expect("initial native FEM direct-minimizer local-energy stats");
            let stats = backend
                .relax_step(algorithm, plan.mesh.nodes.len())
                .expect("native FEM direct-minimizer local-energy step")
                .expect("native FEM direct-minimizer local-energy step should not be interrupted");
            let magnetization = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");

            assert_eq!(
                stats.step, 1,
                "{algorithm:?} local-energy test must publish one accepted step"
            );
            assert!(stats.dt.is_finite(), "{algorithm:?} dt must be finite");
            assert!(stats.dt > 0.0, "{algorithm:?} dt must be positive");
            assert!(
                stats.e_ext.is_finite(),
                "{algorithm:?} Zeeman energy must be finite"
            );
            assert!(
                stats.e_ani.is_finite(),
                "{algorithm:?} anisotropy energy must be finite"
            );
            assert!(
                stats.e_ani.abs() > 0.0,
                "{algorithm:?} active anisotropy must contribute non-zero energy"
            );
            assert!(
                stats.e_ext < initial_stats.e_ext,
                "{algorithm:?} must reduce external-field energy: initial={} final={}",
                initial_stats.e_ext,
                stats.e_ext
            );
            assert!(
                stats.e_total <= initial_stats.e_total + initial_stats.e_total.abs() * 1e-8 + 1e-24,
                "{algorithm:?} local-energy step must not increase total energy beyond tolerance: initial={} final={}",
                initial_stats.e_total,
                stats.e_total
            );
            for (node, m) in magnetization.iter().enumerate() {
                let norm = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
                assert_scalar_close(
                    &format!("{algorithm:?}.local_energy.m_norm[{node}]"),
                    norm,
                    1.0,
                    5e-12,
                    1e-12,
                );
            }
        }
    }

    #[test]
    fn native_fem_forced_hypre_relax_step_returns_controlled_result_when_mfem_stack_is_available() {
        if !is_cpu_available() {
            eprintln!(
                "skipping native FEM forced-Hypre relaxation test: CPU MFEM stack unavailable"
            );
            return;
        }

        let _direct_solver_guard = EnvVarGuard::set(
            "FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER",
            "hypre",
        );
        let _tpi_solver_guard = EnvVarGuard::set("FULLMAG_FEM_TPI_LINEAR_SOLVER", "hypre");

        for algorithm in [
            RelaxationAlgorithmIR::ProjectedGradientBb,
            RelaxationAlgorithmIR::NonlinearCg,
            RelaxationAlgorithmIR::TangentPlaneImplicit,
        ] {
            let mut plan = make_test_plan();
            plan.mfem_device_string = Some("cpu".to_string());
            plan.relaxation = Some(RelaxationControlIR {
                algorithm,
                stop: RelaxStopIR {
                    torque_tolerance_apm: None,
                    energy_tolerance_j: None,
                    max_steps: Some(1),
                    max_relaxation_time_s: None,
                },
            });

            let mut backend = NativeFemBackend::create_with_initial_effective_field(&plan, true)
                .expect("native FEM forced-Hypre relaxation create");
            match backend.relax_step(algorithm, plan.mesh.nodes.len()) {
                Ok(Some(stats)) => {
                    assert_eq!(
                        stats.step, 1,
                        "{algorithm:?} forced-Hypre must publish one accepted step when Hypre is available"
                    );
                    assert!(
                        stats.e_total.is_finite(),
                        "{algorithm:?} forced-Hypre total energy must be finite"
                    );
                }
                Ok(None) => panic!("{algorithm:?} forced-Hypre relaxation was interrupted"),
                Err(error) => {
                    assert!(
                        error.message.contains("OpenMPI singleton socket support"),
                        "{algorithm:?} forced-Hypre must return a controlled OpenMPI preflight error, got: {}",
                        error.message
                    );
                }
            }
        }
    }

    #[test]
    fn native_fem_cpu_relax_step_publishes_max_steps_completion_when_mfem_stack_is_available() {
        if !is_cpu_available() {
            eprintln!(
                "skipping native FEM direct-minimizer completion test: CPU MFEM stack unavailable"
            );
            return;
        }

        for algorithm in [
            RelaxationAlgorithmIR::ProjectedGradientBb,
            RelaxationAlgorithmIR::NonlinearCg,
            RelaxationAlgorithmIR::TangentPlaneImplicit,
        ] {
            let mut plan = make_test_plan();
            plan.mfem_device_string = Some("cpu".to_string());
            plan.relaxation = Some(RelaxationControlIR {
                algorithm,
                stop: RelaxStopIR {
                    torque_tolerance_apm: None,
                    energy_tolerance_j: None,
                    max_steps: Some(1),
                    max_relaxation_time_s: None,
                },
            });

            let mut backend = NativeFemBackend::create_with_initial_effective_field(&plan, true)
                .expect("native FEM direct-minimizer completion create");
            let stats = backend
                .relax_step(algorithm, plan.mesh.nodes.len())
                .expect("native FEM direct-minimizer completion step")
                .expect("native FEM direct-minimizer completion step should not be interrupted");
            let completion = backend
                .stage_completion()
                .expect("native FEM direct-minimizer stage completion")
                .expect("native FEM direct minimizer must publish completion after max_steps");

            assert_eq!(
                stats.step, 1,
                "{algorithm:?} must publish one accepted step"
            );
            assert_eq!(
                completion.reason,
                Some(fullmag_ir::StageStopReason::MaxSteps),
                "{algorithm:?} completion reason"
            );
            assert_eq!(
                completion.metric_name.as_deref(),
                Some("steps"),
                "{algorithm:?} completion metric"
            );
            assert_eq!(
                completion.metric_value,
                Some(1.0),
                "{algorithm:?} completion metric value"
            );
            assert_eq!(
                completion.threshold,
                Some(1.0),
                "{algorithm:?} completion threshold"
            );
        }
    }

    #[test]
    fn native_fem_cpu_relax_step_reports_initial_torque_completion_when_mfem_stack_is_available() {
        if !is_cpu_available() {
            eprintln!(
                "skipping native FEM direct-minimizer initial torque completion test: CPU MFEM stack unavailable"
            );
            return;
        }

        for algorithm in [
            RelaxationAlgorithmIR::ProjectedGradientBb,
            RelaxationAlgorithmIR::NonlinearCg,
            RelaxationAlgorithmIR::TangentPlaneImplicit,
        ] {
            let mut plan = make_test_plan();
            plan.mfem_device_string = Some("cpu".to_string());
            plan.external_field = Some([0.0, 0.0, 2.0e5]);
            plan.relaxation = Some(RelaxationControlIR {
                algorithm,
                stop: RelaxStopIR {
                    torque_tolerance_apm: Some(1.0e30),
                    energy_tolerance_j: None,
                    max_steps: Some(5),
                    max_relaxation_time_s: None,
                },
            });

            let mut backend = NativeFemBackend::create_with_initial_effective_field(&plan, true)
                .expect("native FEM direct-minimizer initial torque completion create");
            let stats = backend
                .relax_step(algorithm, plan.mesh.nodes.len())
                .expect("native FEM direct-minimizer initial torque completion step")
                .expect("native FEM direct-minimizer initial torque completion step should not be interrupted");
            let completion = backend
                .stage_completion()
                .expect("native FEM direct-minimizer initial torque stage completion")
                .expect("native FEM direct minimizer must publish initial torque completion");

            assert_eq!(
                stats.step, 0,
                "{algorithm:?} initial torque completion must not publish a fake accepted step"
            );
            assert_eq!(
                completion.reason,
                Some(fullmag_ir::StageStopReason::Torque),
                "{algorithm:?} completion reason"
            );
            assert_eq!(
                completion.metric_name.as_deref(),
                Some("max_torque_apm"),
                "{algorithm:?} torque metric"
            );
            assert!(
                completion.metric_value.unwrap_or(f64::INFINITY)
                    <= completion.threshold.unwrap_or(f64::NEG_INFINITY),
                "{algorithm:?} torque metric must satisfy threshold: {:?}",
                completion
            );
        }
    }

    #[test]
    fn native_fem_cpu_relax_step_reports_gradient_completion_when_mfem_stack_is_available() {
        if !is_cpu_available() {
            eprintln!(
                "skipping native FEM direct-minimizer gradient completion test: CPU MFEM stack unavailable"
            );
            return;
        }

        for algorithm in [
            RelaxationAlgorithmIR::ProjectedGradientBb,
            RelaxationAlgorithmIR::NonlinearCg,
            RelaxationAlgorithmIR::TangentPlaneImplicit,
        ] {
            let mut plan = make_test_plan();
            plan.mfem_device_string = Some("cpu".to_string());
            plan.external_field = None;
            plan.relaxation = Some(RelaxationControlIR {
                algorithm,
                stop: RelaxStopIR {
                    torque_tolerance_apm: None,
                    energy_tolerance_j: None,
                    max_steps: Some(5),
                    max_relaxation_time_s: None,
                },
            });

            let mut backend = NativeFemBackend::create_with_initial_effective_field(&plan, true)
                .expect("native FEM direct-minimizer gradient completion create");
            let stats = backend
                .relax_step(algorithm, plan.mesh.nodes.len())
                .expect("native FEM direct-minimizer gradient completion step")
                .expect("native FEM direct-minimizer gradient completion step should not be interrupted");
            let completion = backend
                .stage_completion()
                .expect("native FEM direct-minimizer gradient stage completion")
                .expect("native FEM direct minimizer must publish gradient completion");

            assert_eq!(
                stats.step, 0,
                "{algorithm:?} gradient completion must not publish a fake accepted step"
            );
            assert_eq!(
                completion.reason,
                Some(fullmag_ir::StageStopReason::Gradient),
                "{algorithm:?} completion reason"
            );
            assert_eq!(
                completion.metric_name.as_deref(),
                Some("tangent_gradient_norm_sq"),
                "{algorithm:?} gradient metric"
            );
            assert!(
                completion.metric_value.unwrap_or(f64::INFINITY)
                    <= completion.threshold.unwrap_or(f64::NEG_INFINITY),
                "{algorithm:?} gradient metric must satisfy threshold: {:?}",
                completion
            );
        }
    }

    #[test]
    fn native_fem_tpi_advances_with_local_anisotropy_when_mfem_stack_is_available() {
        if !is_cpu_available() {
            eprintln!("skipping native FEM TPI anisotropy test: CPU MFEM stack unavailable");
            return;
        }

        let mut plan = make_test_plan();
        plan.mfem_device_string = Some("cpu".to_string());
        plan.initial_magnetization = vec![[0.6, 0.0, 0.8]; plan.mesh.nodes.len()];
        plan.external_field = Some([0.0, 0.0, 0.0]);
        plan.material.uniaxial_anisotropy = Some(5.0e4);
        plan.material.uniaxial_anisotropy_k2 = Some(1.0e4);
        plan.material.anisotropy_axis = Some([0.0, 0.0, 1.0]);
        plan.material.cubic_anisotropy_kc1 = Some(100.0);
        plan.material.cubic_anisotropy_kc2 = Some(10.0);
        plan.material.cubic_anisotropy_axis1 = Some([1.0, 0.0, 0.0]);
        plan.material.cubic_anisotropy_axis2 = Some([0.0, 1.0, 0.0]);
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::TangentPlaneImplicit,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(1),
                max_relaxation_time_s: None,
            },
        });

        let mut backend = NativeFemBackend::create_with_initial_effective_field(&plan, true)
            .expect("native FEM TPI anisotropy create");
        let initial_stats = backend
            .snapshot_step_stats(plan.mesh.nodes.len())
            .expect("initial native FEM TPI anisotropy stats");
        let stats = backend
            .relax_step(
                RelaxationAlgorithmIR::TangentPlaneImplicit,
                plan.mesh.nodes.len(),
            )
            .expect("native FEM TPI anisotropy step")
            .expect("native FEM TPI anisotropy step should not be interrupted");
        let magnetization = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");

        assert_eq!(
            stats.step, 1,
            "TPI anisotropy must publish one accepted step"
        );
        assert!(stats.dt.is_finite(), "TPI anisotropy dt must be finite");
        assert!(
            stats.e_ani.is_finite(),
            "TPI anisotropy energy must be finite"
        );
        assert!(
            stats.e_ani.abs() > 0.0,
            "active local anisotropy must contribute a non-zero energy"
        );
        assert!(
            stats.e_total <= initial_stats.e_total + initial_stats.e_total.abs() * 1e-8 + 1e-24,
            "TPI anisotropy must not increase energy beyond tolerance: initial={} final={}",
            initial_stats.e_total,
            stats.e_total
        );
        for (node, m) in magnetization.iter().enumerate() {
            let norm = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
            assert_scalar_close(
                &format!("TPI anisotropy.m_norm[{node}]"),
                norm,
                1.0,
                5e-12,
                1e-12,
            );
        }
    }

    #[test]
    fn native_fem_tpi_advances_with_zeeman_curvature_when_mfem_stack_is_available() {
        if !is_cpu_available() {
            eprintln!("skipping native FEM TPI Zeeman test: CPU MFEM stack unavailable");
            return;
        }

        let mut plan = make_test_plan();
        plan.mfem_device_string = Some("cpu".to_string());
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        plan.external_field = Some([0.0, 0.0, 2.0e5]);
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::TangentPlaneImplicit,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(1),
                max_relaxation_time_s: None,
            },
        });

        let mut backend = NativeFemBackend::create_with_initial_effective_field(&plan, true)
            .expect("native FEM TPI Zeeman create");
        let initial_stats = backend
            .snapshot_step_stats(plan.mesh.nodes.len())
            .expect("initial native FEM TPI Zeeman stats");
        let stats = backend
            .relax_step(
                RelaxationAlgorithmIR::TangentPlaneImplicit,
                plan.mesh.nodes.len(),
            )
            .expect("native FEM TPI Zeeman step")
            .expect("native FEM TPI Zeeman step should not be interrupted");
        let magnetization = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");

        assert_eq!(stats.step, 1, "TPI Zeeman must publish one accepted step");
        assert!(stats.dt.is_finite(), "TPI Zeeman dt must be finite");
        assert!(stats.e_ext.is_finite(), "TPI Zeeman energy must be finite");
        assert!(
            stats.e_ext < initial_stats.e_ext,
            "TPI Zeeman must reduce external-field energy: initial={} final={}",
            initial_stats.e_ext,
            stats.e_ext
        );
        assert!(
            stats.e_total <= initial_stats.e_total + initial_stats.e_total.abs() * 1e-8 + 1e-24,
            "TPI Zeeman must not increase total energy beyond tolerance: initial={} final={}",
            initial_stats.e_total,
            stats.e_total
        );
        for (node, m) in magnetization.iter().enumerate() {
            let norm = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
            assert_scalar_close(
                &format!("TPI Zeeman.m_norm[{node}]"),
                norm,
                1.0,
                5e-12,
                1e-12,
            );
        }
    }

    #[test]
    fn native_fem_tpi_advances_with_dmi_operator_when_mfem_stack_is_available() {
        if !is_cpu_available() {
            eprintln!("skipping native FEM TPI DMI test: CPU MFEM stack unavailable");
            return;
        }

        let mut plan = make_test_plan();
        plan.mfem_device_string = Some("cpu".to_string());
        plan.external_field = Some([0.0, 0.0, 0.0]);
        plan.initial_magnetization = vec![
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
        ];
        plan.interfacial_dmi = Some(1.0e-3);
        plan.dmi_interface_normal = Some([0.0, 0.0, 1.0]);
        plan.bulk_dmi = Some(2.0e-3);
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::TangentPlaneImplicit,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(1),
                max_relaxation_time_s: None,
            },
        });

        let mut backend = NativeFemBackend::create_with_initial_effective_field(&plan, true)
            .expect("native FEM TPI DMI create");
        let initial_stats = backend
            .snapshot_step_stats(plan.mesh.nodes.len())
            .expect("initial native FEM TPI DMI stats");
        let stats = backend
            .relax_step(
                RelaxationAlgorithmIR::TangentPlaneImplicit,
                plan.mesh.nodes.len(),
            )
            .expect("native FEM TPI DMI step")
            .expect("native FEM TPI DMI step should not be interrupted");
        let magnetization = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");

        assert_eq!(stats.step, 1, "TPI DMI must publish one accepted step");
        assert!(stats.dt.is_finite(), "TPI DMI dt must be finite");
        assert!(stats.e_dmi.is_finite(), "TPI DMI energy must be finite");
        assert!(
            stats.e_dmi.abs() > 0.0,
            "active DMI must contribute a non-zero energy"
        );
        assert!(
            stats.e_total <= initial_stats.e_total + initial_stats.e_total.abs() * 1e-8 + 1e-24,
            "TPI DMI must not increase total energy beyond tolerance: initial={} final={}",
            initial_stats.e_total,
            stats.e_total
        );
        for (node, m) in magnetization.iter().enumerate() {
            let norm = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
            assert_scalar_close(&format!("TPI DMI.m_norm[{node}]"), norm, 1.0, 5e-12, 1e-12);
        }
    }

    #[test]
    fn native_fem_tpi_advances_with_demag_operator_when_mfem_stack_is_available() {
        if !is_cpu_available() {
            eprintln!("skipping native FEM TPI demag test: CPU MFEM stack unavailable");
            return;
        }

        let mut plan = make_test_plan();
        plan.mfem_device_string = Some("cpu".to_string());
        plan.external_field = Some([0.0, 0.0, 0.0]);
        plan.initial_magnetization = vec![
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
        ];
        plan.enable_demag = true;
        plan.demag_realization = Some(fullmag_ir::ResolvedFemDemagIR::FredkinKoehler);
        plan.air_box_config = None;
        plan.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh;
        plan.mesh
            .set_tri3_facets(vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);
        plan.mesh.boundary_markers = vec![1, 1, 1, 1];
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::TangentPlaneImplicit,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(1),
                max_relaxation_time_s: None,
            },
        });

        let mut backend = NativeFemBackend::create_with_initial_effective_field(&plan, true)
            .expect("native FEM TPI demag create");
        let initial_stats = backend
            .snapshot_step_stats(plan.mesh.nodes.len())
            .expect("initial native FEM TPI demag stats");
        let stats = backend
            .relax_step(
                RelaxationAlgorithmIR::TangentPlaneImplicit,
                plan.mesh.nodes.len(),
            )
            .expect("native FEM TPI demag step")
            .expect("native FEM TPI demag step should not be interrupted");
        let magnetization = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");

        assert_eq!(stats.step, 1, "TPI demag must publish one accepted step");
        assert!(stats.dt.is_finite(), "TPI demag dt must be finite");
        assert!(stats.e_demag.is_finite(), "TPI demag energy must be finite");
        assert!(
            stats.e_demag.abs() > 0.0,
            "active demag must contribute a non-zero energy"
        );
        assert!(
            stats.demag_solves > 0,
            "accepted TPI demag step must perform native demag solves"
        );
        assert!(
            stats.e_total <= initial_stats.e_total + initial_stats.e_total.abs() * 1e-8 + 1e-24,
            "TPI demag must not increase total energy beyond tolerance: initial={} final={}",
            initial_stats.e_total,
            stats.e_total
        );
        for (node, m) in magnetization.iter().enumerate() {
            let norm = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
            assert_scalar_close(
                &format!("TPI demag.m_norm[{node}]"),
                norm,
                1.0,
                5e-12,
                1e-12,
            );
        }
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
        plan.mesh
            .set_tri3_facets(vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]]);
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
            frozen_spins: None,
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
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [1, 4, 2, 3]]),
                element_markers: vec![1, 1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 4, 2],
                    [1, 4, 3],
                    [4, 2, 3],
                ]),
                boundary_markers: vec![1; 6],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: std::collections::HashMap::new(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
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
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: false,
            external_field: Some([1.5e3, -2.0e3, 7.5e2]),
            antenna_zeeman_masks: Vec::new(),
            field_drives: Vec::new(),
            field_drive_geometry_masks: Vec::new(),
            time_stage: Default::default(),
            current_modules: vec![],
            spin_transport_plans: vec![],
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
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
            spin_torque_contract: None,
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
                crate::resolve_timestep_policy(
                    plan.integrator,
                    plan.fixed_timestep,
                    plan.adaptive_timestep.as_ref(),
                    if native_fem_plan_requests_gpu_mfem_device(plan) {
                        crate::types::TimestepExecutionLane::fem_gpu(plan.precision)
                    } else {
                        crate::types::TimestepExecutionLane::fem_cpu(plan.precision)
                    },
                )
                .expect("parity plan timestep")
                .initial_dt(),
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

    struct NativeParityRelaxStep {
        initial_stats: StepStats,
        m: Vec<[f64; 3]>,
        h_eff: Vec<[f64; 3]>,
        stats: StepStats,
        completion: fullmag_ir::StageCompletionIR,
        device_name: String,
    }

    fn run_native_parity_relax_step(
        plan: &FemPlanIR,
        algorithm: RelaxationAlgorithmIR,
    ) -> NativeParityRelaxStep {
        let mut backend = NativeFemBackend::create_with_initial_effective_field(plan, true)
            .expect("native fem relaxation parity create");
        let node_count = plan.mesh.nodes.len();
        let initial_stats = backend
            .snapshot_step_stats(node_count)
            .expect("native fem relaxation parity initial stats");
        let stats = backend
            .relax_step(algorithm, node_count)
            .expect("native fem relaxation parity step")
            .expect("native fem relaxation parity step should not be interrupted");
        let completion = backend
            .stage_completion()
            .expect("native fem relaxation parity stage completion")
            .expect("native fem relaxation parity must publish stage completion");
        let device_name = backend.device_info().expect("device info").name;
        NativeParityRelaxStep {
            initial_stats,
            m: backend.copy_m(node_count).expect("copy m"),
            h_eff: backend.copy_h_eff(node_count).expect("copy H_eff"),
            stats,
            completion,
            device_name,
        }
    }

    fn assert_same_parity_mesh(cpu_plan: &FemPlanIR, gpu_plan: &FemPlanIR) {
        assert_eq!(cpu_plan.mesh.mesh_name, gpu_plan.mesh.mesh_name);
        assert_eq!(cpu_plan.mesh.nodes, gpu_plan.mesh.nodes);
        assert_eq!(cpu_plan.mesh.cells, gpu_plan.mesh.cells);
        assert_eq!(cpu_plan.precision, ExecutionPrecision::Double);
        assert_eq!(gpu_plan.precision, ExecutionPrecision::Double);
    }

    fn with_poisson_demag(mut plan: FemPlanIR) -> FemPlanIR {
        plan.enable_demag = true;
        plan.domain_mesh_mode = fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir;
        plan.demag_realization = Some(ResolvedFemDemagIR::PoissonRobin);
        plan.air_box_config = Some(AirBoxConfigIR {
            factor: 1.5,
            grading: 1.0,
            boundary_marker: 1,
            bc_kind: Some("robin".to_string()),
            robin_beta_mode: Some("legacy".to_string()),
            robin_beta_factor: None,
            shape: Some("bbox".to_string()),
            factor_source: Some("parity_fixture".to_string()),
            boundary_marker_source: Some("parity_fixture".to_string()),
        });
        plan
    }

    #[test]
    fn unresolved_gpu_demag_policy_prefers_jacobi_preconditioner_for_non_pgbb() {
        let mut plan = with_poisson_demag(make_exchange_only_plan());
        plan.mfem_device_string = Some("cuda".to_string());

        let policy = resolved_native_fem_demag_solver_policy(&plan);

        assert_eq!(policy.solver, "CG");
        assert_eq!(policy.preconditioner, "JACOBI");
        assert_eq!(policy.rtol, 1e-8);
        assert_eq!(policy.max_iterations, 500);
    }

    #[test]
    fn unresolved_gpu_demag_policy_prefers_amg_preconditioner_for_pgbb() {
        let mut plan = with_poisson_demag(make_exchange_only_plan());
        plan.mfem_device_string = Some("cuda".to_string());
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(2),
                max_relaxation_time_s: None,
            },
        });

        let policy = resolved_native_fem_demag_solver_policy(&plan);

        assert_eq!(policy.solver, "CG");
        assert_eq!(policy.preconditioner, "AMG");
        assert_eq!(policy.rtol, 1e-8);
        assert_eq!(policy.max_iterations, 500);
    }

    #[test]
    fn unresolved_cpu_demag_policy_keeps_public_default_preconditioner() {
        let mut plan = with_poisson_demag(make_exchange_only_plan());
        plan.mfem_device_string = Some("cpu".to_string());

        let policy = resolved_native_fem_demag_solver_policy(&plan);

        assert_eq!(policy.preconditioner, "AMG");
    }

    #[test]
    fn explicit_gpu_demag_policy_is_not_rewritten() {
        let mut plan = with_poisson_demag(make_exchange_only_plan());
        plan.mfem_device_string = Some("cuda".to_string());
        plan.demag_solver_policy = Some(FemLinearSolverPolicy {
            solver: "GMRES".to_string(),
            preconditioner: "AMG".to_string(),
            rtol: 1e-6,
            max_iterations: 77,
            ..Default::default()
        });

        let policy = resolved_native_fem_demag_solver_policy(&plan);

        assert_eq!(policy.solver, "GMRES");
        assert_eq!(policy.preconditioner, "AMG");
        assert_eq!(policy.rtol, 1e-6);
        assert_eq!(policy.max_iterations, 77);
    }

    fn with_adaptive_dt(mut plan: FemPlanIR) -> FemPlanIR {
        plan.fixed_timestep = None;
        plan.adaptive_timestep = Some(AdaptiveTimeStepIR {
            tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::Advanced,
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
        let stt_contract = plan.spin_torque_contract.as_ref();
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
                        formula: match stt_contract
                            .map(|contract| contract.formula_version.as_str())
                        {
                            Some("zhang_li.fullmag.v1") => {
                                fullmag_engine::ZhangLiFormula::FullmagV1
                            }
                            _ => fullmag_engine::ZhangLiFormula::LegacyFullmagV0,
                        },
                        current_density: plan.current_density.expect("current density"),
                        spin_polarization: plan.stt_degree.expect("stt degree"),
                        non_adiabaticity: plan.stt_beta.unwrap_or(0.0),
                    })
                } else {
                    None
                },
                slonczewski_stt: if has_slonczewski_stt(plan) {
                    let (current_density_magnitude, current_sign) =
                        if stt_contract.is_some_and(|contract| {
                            contract.formula_version == "slonczewski.fullmag.v2"
                        }) {
                            let contract = stt_contract.expect("canonical Slonczewski contract");
                            let normal = contract
                                .stack_normal
                                .expect("canonical Slonczewski stack normal");
                            let normal_norm = (normal[0] * normal[0]
                                + normal[1] * normal[1]
                                + normal[2] * normal[2])
                                .sqrt();
                            let current = plan.current_density.expect("current density");
                            let signed_normal_current = (current[0] * normal[0]
                                + current[1] * normal[1]
                                + current[2] * normal[2])
                                / normal_norm;
                            (
                                signed_normal_current.abs(),
                                if signed_normal_current.is_sign_negative() {
                                    -1.0
                                } else {
                                    1.0
                                },
                            )
                        } else {
                            let current = plan.current_density.expect("current density");
                            (
                                (current[0] * current[0]
                                    + current[1] * current[1]
                                    + current[2] * current[2])
                                    .sqrt(),
                                match plan.stt_fixed_layer_position.as_deref().unwrap_or("top") {
                                    "bottom" => -1.0,
                                    _ => 1.0,
                                },
                            )
                        };
                    Some(fullmag_engine::SlonczewskiSttConfig {
                        active_mask: stt_contract
                            .and_then(|contract| contract.active_node_mask.clone()),
                        formula: match stt_contract
                            .map(|contract| contract.formula_version.as_str())
                        {
                            Some("slonczewski.fullmag.v2") => {
                                fullmag_engine::SlonczewskiFormula::FullmagV2
                            }
                            _ => fullmag_engine::SlonczewskiFormula::LegacyFullmagV0,
                        },
                        current_density_magnitude,
                        spin_polarization_axis: plan
                            .stt_spin_polarization
                            .expect("stt spin polarization"),
                        lambda: plan.stt_lambda.expect("stt lambda"),
                        epsilon_prime: plan.stt_epsilon_prime.unwrap_or(0.0),
                        degree: plan.stt_degree.expect("stt degree"),
                        thickness: plan
                            .stt_thickness
                            .unwrap_or_else(|| effective_magnetic_thickness(&plan.mesh)),
                        current_sign,
                    })
                } else {
                    None
                },
                sot: plan
                    .spin_torque_contract
                    .as_ref()
                    .filter(|contract| contract.formula_version == "prescribed_sot.fullmag.v1")
                    .map(|contract| fullmag_engine::SotConfig {
                        formula: fullmag_engine::SotFormula::FullmagV1,
                        current_density: contract
                            .sot_current_density
                            .expect("prescribed SOT current density"),
                        xi_dl: contract.sot_xi_dl.expect("prescribed SOT xi_dl"),
                        xi_fl: contract.sot_xi_fl.expect("prescribed SOT xi_fl"),
                        sigma: contract.sot_sigma.expect("prescribed SOT sigma"),
                        thickness: contract.sot_thickness.expect("prescribed SOT thickness"),
                        active_mask: contract.active_node_mask.clone(),
                        envelope: contract.sot_envelope.clone(),
                    }),
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

    fn canonical_slonczewski_rhs_reference(plan: &FemPlanIR, m: [f64; 3]) -> [f64; 3] {
        let contract = plan
            .spin_torque_contract
            .as_ref()
            .expect("canonical Slonczewski contract");
        assert_eq!(
            contract.formula_version, "slonczewski.fullmag.v2",
            "SI oracle requires the canonical Slonczewski v2 formula"
        );
        let normal = contract.stack_normal.expect("canonical stack normal");
        let normal_norm =
            (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
        let current = plan.current_density.expect("current density");
        let signed_current =
            (current[0] * normal[0] + current[1] * normal[1] + current[2] * normal[2])
                / normal_norm;
        let p = plan.stt_spin_polarization.expect("spin polarization");
        let p_norm = (p[0] * p[0] + p[1] * p[1] + p[2] * p[2]).sqrt();
        let p = [p[0] / p_norm, p[1] / p_norm, p[2] / p_norm];
        let alpha = plan.material.damping;
        let lambda = plan.stt_lambda.expect("Slonczewski lambda");
        let lambda_sq = lambda * lambda;
        let degree = plan.stt_degree.expect("Slonczewski degree");
        let epsilon_prime = plan.stt_epsilon_prime.unwrap_or(0.0);
        let thickness = plan.stt_thickness.expect("free-layer thickness");
        let prefactor = signed_current * 1.054571817e-34 * plan.gyromagnetic_ratio
            / (1.602176634e-19
                * 1.2566370614359173e-6
                * plan.material.saturation_magnetisation
                * thickness);
        let dot_mp = m[0] * p[0] + m[1] * p[1] + m[2] * p[2];
        let g = (degree * lambda_sq) / ((lambda_sq + 1.0) + (lambda_sq - 1.0) * dot_mp);
        let inv_gilbert = 1.0 / (1.0 + alpha * alpha);
        let damping_like = prefactor * (g + alpha * epsilon_prime) * inv_gilbert;
        let field_like = prefactor * (epsilon_prime - alpha * g) * inv_gilbert;
        let m_cross_p = [
            m[1] * p[2] - m[2] * p[1],
            m[2] * p[0] - m[0] * p[2],
            m[0] * p[1] - m[1] * p[0],
        ];
        let m_cross_m_cross_p = [
            m[1] * m_cross_p[2] - m[2] * m_cross_p[1],
            m[2] * m_cross_p[0] - m[0] * m_cross_p[2],
            m[0] * m_cross_p[1] - m[1] * m_cross_p[0],
        ];
        [
            damping_like * m_cross_m_cross_p[0] + field_like * m_cross_p[0],
            damping_like * m_cross_m_cross_p[1] + field_like * m_cross_p[1],
            damping_like * m_cross_m_cross_p[2] + field_like * m_cross_p[2],
        ]
    }

    fn canonical_prescribed_sot_rhs_reference_at_time(
        plan: &FemPlanIR,
        m: [f64; 3],
        time_s: f64,
    ) -> [f64; 3] {
        let contract = plan
            .spin_torque_contract
            .as_ref()
            .expect("prescribed SOT contract");
        assert_eq!(
            contract.formula_version, "prescribed_sot.fullmag.v1",
            "SI oracle requires prescribed_sot.fullmag.v1"
        );
        let current_density = contract
            .sot_current_density
            .expect("prescribed SOT current density");
        let xi_dl = contract.sot_xi_dl.expect("prescribed SOT xi_dl");
        let xi_fl = contract.sot_xi_fl.expect("prescribed SOT xi_fl");
        let sigma_raw = contract.sot_sigma.expect("prescribed SOT sigma");
        let sigma_norm = (sigma_raw[0] * sigma_raw[0]
            + sigma_raw[1] * sigma_raw[1]
            + sigma_raw[2] * sigma_raw[2])
            .sqrt();
        let sigma = [
            sigma_raw[0] / sigma_norm,
            sigma_raw[1] / sigma_norm,
            sigma_raw[2] / sigma_norm,
        ];
        let envelope = contract
            .sot_envelope
            .as_ref()
            .map(|envelope| match envelope {
                fullmag_ir::TimeEnvelopeIR::Constant { value } => *value,
                fullmag_ir::TimeEnvelopeIR::Sinusoidal {
                    amplitude,
                    frequency_hz,
                    phase_rad,
                    offset,
                } => {
                    offset
                        + amplitude
                            * (2.0 * std::f64::consts::PI * frequency_hz * time_s + phase_rad).sin()
                }
                fullmag_ir::TimeEnvelopeIR::Pulse {
                    amplitude,
                    t_on_s,
                    t_off_s,
                } => {
                    if time_s >= *t_on_s && time_s < *t_off_s {
                        *amplitude
                    } else {
                        0.0
                    }
                }
                fullmag_ir::TimeEnvelopeIR::PiecewiseLinear { points } => {
                    if points.is_empty() {
                        0.0
                    } else if time_s <= points[0].time_s {
                        points[0].value
                    } else if time_s >= points[points.len() - 1].time_s {
                        points[points.len() - 1].value
                    } else {
                        let upper = points
                            .iter()
                            .position(|point| point.time_s > time_s)
                            .expect("piecewise envelope upper point");
                        let lower = upper - 1;
                        let u = (time_s - points[lower].time_s)
                            / (points[upper].time_s - points[lower].time_s);
                        points[lower].value + u * (points[upper].value - points[lower].value)
                    }
                }
                fullmag_ir::TimeEnvelopeIR::Sinc {
                    amplitude,
                    center_s,
                    bandwidth_hz,
                    offset,
                } => {
                    let x = bandwidth_hz * (time_s - center_s);
                    let sinc = if x.abs() <= 1.0e-12 {
                        1.0
                    } else {
                        (std::f64::consts::PI * x).sin() / (std::f64::consts::PI * x)
                    };
                    offset + amplitude * sinc
                }
                fullmag_ir::TimeEnvelopeIR::Tabulated { .. } => {
                    panic!("tabulated prescribed SOT envelope is outside the SI oracle")
                }
            })
            .unwrap_or(1.0);
        let thickness = contract.sot_thickness.expect("prescribed SOT thickness");
        let gamma_e = plan.gyromagnetic_ratio / 1.2566370614359173e-6;
        let omega_base = gamma_e * 1.054571817e-34 * current_density * envelope
            / (2.0 * 1.602176634e-19 * plan.material.saturation_magnetisation * thickness);
        let omega_dl = omega_base * xi_dl;
        let omega_fl = omega_base * xi_fl;
        let alpha = plan.material.damping;
        let inv_gilbert = 1.0 / (1.0 + alpha * alpha);
        let damping_like = (omega_dl - alpha * omega_fl) * inv_gilbert;
        let field_like = (omega_fl + alpha * omega_dl) * inv_gilbert;
        let m_cross_sigma = [
            m[1] * sigma[2] - m[2] * sigma[1],
            m[2] * sigma[0] - m[0] * sigma[2],
            m[0] * sigma[1] - m[1] * sigma[0],
        ];
        let m_cross_m_cross_sigma = [
            m[1] * m_cross_sigma[2] - m[2] * m_cross_sigma[1],
            m[2] * m_cross_sigma[0] - m[0] * m_cross_sigma[2],
            m[0] * m_cross_sigma[1] - m[1] * m_cross_sigma[0],
        ];
        [
            -damping_like * m_cross_m_cross_sigma[0] + field_like * m_cross_sigma[0],
            -damping_like * m_cross_m_cross_sigma[1] + field_like * m_cross_sigma[1],
            -damping_like * m_cross_m_cross_sigma[2] + field_like * m_cross_sigma[2],
        ]
    }

    fn canonical_prescribed_sot_heun_reference(plan: &FemPlanIR) -> (Vec<[f64; 3]>, f64) {
        let dt = plan.fixed_timestep.expect("fixed timestep");
        let k1: Vec<[f64; 3]> = plan
            .initial_magnetization
            .iter()
            .copied()
            .map(|m| canonical_prescribed_sot_rhs_reference_at_time(plan, m, 0.0))
            .collect();
        let stage: Vec<[f64; 3]> = plan
            .initial_magnetization
            .iter()
            .zip(k1.iter())
            .map(|(m, k)| {
                normalize_reference_m([m[0] + dt * k[0], m[1] + dt * k[1], m[2] + dt * k[2]])
            })
            .collect();
        let k2: Vec<[f64; 3]> = stage
            .iter()
            .copied()
            .map(|m| canonical_prescribed_sot_rhs_reference_at_time(plan, m, dt))
            .collect();
        let final_m: Vec<[f64; 3]> = plan
            .initial_magnetization
            .iter()
            .zip(k1.iter().zip(k2.iter()))
            .map(|(m, (k1, k2))| {
                normalize_reference_m([
                    m[0] + 0.5 * dt * (k1[0] + k2[0]),
                    m[1] + 0.5 * dt * (k1[1] + k2[1]),
                    m[2] + 0.5 * dt * (k1[2] + k2[2]),
                ])
            })
            .collect();
        let max_rhs = final_m
            .iter()
            .copied()
            .map(|m| {
                let rhs = canonical_prescribed_sot_rhs_reference_at_time(plan, m, dt);
                (rhs[0] * rhs[0] + rhs[1] * rhs[1] + rhs[2] * rhs[2]).sqrt()
            })
            .fold(0.0, f64::max);
        (final_m, max_rhs)
    }

    fn normalize_reference_m(v: [f64; 3]) -> [f64; 3] {
        let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
        [v[0] / length, v[1] / length, v[2] / length]
    }

    fn canonical_slonczewski_heun_reference(plan: &FemPlanIR) -> (Vec<[f64; 3]>, f64) {
        let dt = plan.fixed_timestep.expect("fixed timestep");
        let k1: Vec<[f64; 3]> = plan
            .initial_magnetization
            .iter()
            .copied()
            .map(|m| canonical_slonczewski_rhs_reference(plan, m))
            .collect();
        let stage: Vec<[f64; 3]> = plan
            .initial_magnetization
            .iter()
            .zip(k1.iter())
            .map(|(m, k)| {
                normalize_reference_m([m[0] + dt * k[0], m[1] + dt * k[1], m[2] + dt * k[2]])
            })
            .collect();
        let k2: Vec<[f64; 3]> = stage
            .iter()
            .copied()
            .map(|m| canonical_slonczewski_rhs_reference(plan, m))
            .collect();
        let final_m: Vec<[f64; 3]> = plan
            .initial_magnetization
            .iter()
            .zip(k1.iter().zip(k2.iter()))
            .map(|(m, (k1, k2))| {
                normalize_reference_m([
                    m[0] + 0.5 * dt * (k1[0] + k2[0]),
                    m[1] + 0.5 * dt * (k1[1] + k2[1]),
                    m[2] + 0.5 * dt * (k1[2] + k2[2]),
                ])
            })
            .collect();
        let max_rhs = final_m
            .iter()
            .copied()
            .map(|m| {
                let rhs = canonical_slonczewski_rhs_reference(plan, m);
                (rhs[0] * rhs[0] + rhs[1] * rhs[1] + rhs[2] * rhs[2]).sqrt()
            })
            .fold(0.0, f64::max);
        (final_m, max_rhs)
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
    fn native_fem_scaffold_step_uses_available_native_backend_or_reports_unavailable() {
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
        if is_cpu_available() || is_gpu_available() {
            backend.step(1e-13).expect("native FEM step");
        } else {
            let err = backend.step(1e-13).expect_err("step should be unavailable");
            assert!(
                err.message.contains("MFEM")
                    || err.message.contains("scaffold")
                    || err.message.contains("demag"),
                "unexpected unavailable message: {}",
                err.message
            );
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
    fn native_fem_single_precision_rejection_treats_cpu_mfem_variants_as_cpu() {
        let mut plan = make_exchange_only_plan();
        plan.precision = ExecutionPrecision::Single;
        plan.mfem_device_string = Some("ceed-cpu".to_string());

        let err = match NativeFemBackend::create(&plan) {
            Ok(_) => panic!("CPU libCEED single precision should fail"),
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
    fn native_fem_mfem_cpu_device_strings_do_not_request_gpu_demag() {
        let mut plan = make_test_plan();
        plan.enable_demag = true;

        for device in [
            "cpu", "omp", "ceed-cpu", "ceed/cpu", "ceed-omp", "ceed/omp", "raja-omp",
        ] {
            plan.mfem_device_string = Some(device.to_string());
            assert_eq!(
                native_fem_gpu_demag_mode(&plan),
                ffi::fullmag_fem_gpu_demag_mode::FULLMAG_FEM_GPU_DEMAG_UNSPECIFIED as i32,
                "MFEM device string {device:?} must not request strict GPU demag"
            );
        }
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
                        max_relaxation_time_s: None,
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
        assert_vector_field_parity("demag.H_demag", &cpu.h_demag, &gpu.h_demag, 5e-6, 1e-6);
        assert_vector_field_parity("demag.H_eff", &cpu.h_eff, &gpu.h_eff, 5e-6, 1e-6);
        assert_scalar_close(
            "demag_energy_joules",
            gpu.stats.e_demag,
            cpu.stats.e_demag,
            5e-6,
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
            plan.integrator = Some(integrator);
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
            if matches!(integrator, IntegratorChoice::Rk23 | IntegratorChoice::Rk45) {
                assert!(
                    (gpu.stats.rhs_evals as i64 - cpu.stats.rhs_evals as i64).abs() <= 1,
                    "RHS evaluation count mismatch for adaptive {integrator:?}: gpu={}, cpu={}",
                    gpu.stats.rhs_evals,
                    cpu.stats.rhs_evals
                );
            } else {
                assert_eq!(
                    gpu.stats.rhs_evals, cpu.stats.rhs_evals,
                    "RHS evaluation count mismatch for fixed {integrator:?}"
                );
            }
        }
    }

    #[test]
    fn native_fem_gpu_projected_gradient_bb_relax_step_when_available() {
        if !native_cpu_gpu_parity_available(false) {
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::ProjectedGradientBb,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(1),
                max_relaxation_time_s: None,
            },
        });
        let cpu_plan = native_plan_for_device(&plan, "cpu");
        let gpu_plan = native_plan_for_device(&plan, "cuda");
        assert_same_parity_mesh(&cpu_plan, &gpu_plan);

        let cpu =
            run_native_parity_relax_step(&cpu_plan, RelaxationAlgorithmIR::ProjectedGradientBb);
        let gpu =
            run_native_parity_relax_step(&gpu_plan, RelaxationAlgorithmIR::ProjectedGradientBb);

        assert!(
            cpu.device_name.contains("cpu") || cpu.device_name.contains("mfem"),
            "CPU relaxation provenance device was {}",
            cpu.device_name
        );
        assert!(
            gpu.device_name.contains("cuda")
                || gpu.device_name.contains("NVIDIA")
                || gpu.device_name.contains("GeForce")
                || gpu.device_name.contains("RTX"),
            "GPU relaxation provenance device was {}",
            gpu.device_name
        );

        for (label, run) in [("cpu", &cpu), ("gpu", &gpu)] {
            assert_eq!(
                run.stats.step, 1,
                "{label} PG-BB must publish one accepted step"
            );
            assert!(run.stats.dt.is_finite(), "{label} PG-BB dt must be finite");
            assert!(run.stats.dt > 0.0, "{label} PG-BB dt must be positive");
            assert!(
                run.stats.e_total.is_finite(),
                "{label} PG-BB total energy must be finite"
            );
            assert!(
                run.stats.e_total
                    <= run.initial_stats.e_total + run.initial_stats.e_total.abs() * 1e-8 + 1e-24,
                "{label} PG-BB must not increase energy beyond tolerance: initial={} final={}",
                run.initial_stats.e_total,
                run.stats.e_total
            );
            assert_eq!(
                run.completion.reason,
                Some(fullmag_ir::StageStopReason::MaxSteps),
                "{label} PG-BB completion reason"
            );
            assert_eq!(
                run.completion.metric_name.as_deref(),
                Some("steps"),
                "{label} PG-BB completion metric"
            );
            assert_eq!(
                run.completion.metric_value,
                Some(1.0),
                "{label} PG-BB completion metric value"
            );
            assert_eq!(
                run.completion.threshold,
                Some(1.0),
                "{label} PG-BB completion threshold"
            );
            for (node, m) in run.m.iter().enumerate() {
                let norm = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
                assert_scalar_close(
                    &format!("{label}.PG-BB.m_norm[{node}]"),
                    norm,
                    1.0,
                    5e-12,
                    1e-12,
                );
            }
            for (node, h_eff) in run.h_eff.iter().enumerate() {
                for (component, value) in h_eff.iter().enumerate() {
                    assert!(
                        value.is_finite(),
                        "{label}.PG-BB.H_eff[{node}][{component}] must be finite"
                    );
                }
            }
        }

        assert!(
            gpu.stats.hot_loop_host_sync_count > 0,
            "GPU PG-BB must expose audited host sync while Armijo/BB decisions remain host-driven"
        );
        assert_eq!(
            gpu.stats.hot_loop_exchange_host_sync_count, 0,
            "GPU PG-BB must not perform exchange host sync inside the native relaxation hot loop"
        );
        assert_eq!(
            gpu.stats.hot_loop_compute_host_sync_count, 0,
            "GPU PG-BB control-scalar sync must not be classified as compute-side readback"
        );
        assert!(
            gpu.stats.hot_loop_control_scalar_host_sync_count > 0,
            "GPU PG-BB must expose host-driven Armijo/BB decisions as control-scalar readback"
        );
    }

    #[test]
    fn native_fem_gpu_nonlinear_cg_relax_step_when_available() {
        if !native_cpu_gpu_parity_available(false) {
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::NonlinearCg,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(1),
                max_relaxation_time_s: None,
            },
        });
        let cpu_plan = native_plan_for_device(&plan, "cpu");
        let gpu_plan = native_plan_for_device(&plan, "cuda");
        assert_same_parity_mesh(&cpu_plan, &gpu_plan);

        let cpu = run_native_parity_relax_step(&cpu_plan, RelaxationAlgorithmIR::NonlinearCg);
        let gpu = run_native_parity_relax_step(&gpu_plan, RelaxationAlgorithmIR::NonlinearCg);

        assert!(
            cpu.device_name.contains("cpu") || cpu.device_name.contains("mfem"),
            "CPU relaxation provenance device was {}",
            cpu.device_name
        );
        assert!(
            gpu.device_name.contains("cuda")
                || gpu.device_name.contains("NVIDIA")
                || gpu.device_name.contains("GeForce")
                || gpu.device_name.contains("RTX"),
            "GPU relaxation provenance device was {}",
            gpu.device_name
        );

        for (label, run) in [("cpu", &cpu), ("gpu", &gpu)] {
            assert_eq!(
                run.stats.step, 1,
                "{label} NCG must publish one accepted step"
            );
            assert!(run.stats.dt.is_finite(), "{label} NCG dt must be finite");
            assert!(run.stats.dt > 0.0, "{label} NCG dt must be positive");
            assert!(
                run.stats.e_total.is_finite(),
                "{label} NCG total energy must be finite"
            );
            assert!(
                run.stats.e_total
                    <= run.initial_stats.e_total + run.initial_stats.e_total.abs() * 1e-8 + 1e-24,
                "{label} NCG must not increase energy beyond tolerance: initial={} final={}",
                run.initial_stats.e_total,
                run.stats.e_total
            );
            assert_eq!(
                run.completion.reason,
                Some(fullmag_ir::StageStopReason::MaxSteps),
                "{label} NCG completion reason"
            );
            assert_eq!(
                run.completion.metric_name.as_deref(),
                Some("steps"),
                "{label} NCG completion metric"
            );
            assert_eq!(
                run.completion.metric_value,
                Some(1.0),
                "{label} NCG completion metric value"
            );
            assert_eq!(
                run.completion.threshold,
                Some(1.0),
                "{label} NCG completion threshold"
            );
            for (node, m) in run.m.iter().enumerate() {
                let norm = (m[0] * m[0] + m[1] * m[1] + m[2] * m[2]).sqrt();
                assert_scalar_close(
                    &format!("{label}.NCG.m_norm[{node}]"),
                    norm,
                    1.0,
                    5e-12,
                    1e-12,
                );
            }
            for (node, h_eff) in run.h_eff.iter().enumerate() {
                for (component, value) in h_eff.iter().enumerate() {
                    assert!(
                        value.is_finite(),
                        "{label}.NCG.H_eff[{node}][{component}] must be finite"
                    );
                }
            }
        }

        assert!(
            gpu.stats.hot_loop_host_sync_count > 0,
            "GPU NCG must expose audited host sync while Armijo/PR+ decisions remain host-driven"
        );
        assert_eq!(
            gpu.stats.hot_loop_exchange_host_sync_count, 0,
            "GPU NCG must not perform exchange host sync inside the native relaxation hot loop"
        );
        assert_eq!(
            gpu.stats.hot_loop_compute_host_sync_count, 0,
            "GPU NCG control-scalar sync must not be classified as compute-side readback"
        );
        assert!(
            gpu.stats.hot_loop_control_scalar_host_sync_count > 0,
            "GPU NCG must expose host-driven Armijo/PR+ decisions as control-scalar readback"
        );
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
            plan.integrator = Some(integrator);
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
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_rhs.cpp");
        let coeff_body = source_block(
            source,
            "class MagnetizationCoefficient",
            "\nstruct PoissonRhsWorkspace",
        );
        let body = source_block(source, "bool assemble_demag_poisson_rhs(", "\n#endif");

        assert!(
            !body.contains("mfem::LinearForm b(fes)"),
            "assemble_demag_poisson_rhs must reuse the context-owned LinearForm workspace"
        );
        assert!(
            !body.contains("AddDomainIntegrator("),
            "assemble_demag_poisson_rhs must not allocate/add RHS integrators in the hot path"
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
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp");
        let body = source_block(
            source,
            "void zero_poisson_essential_values(",
            "\n\n\n} // namespace",
        );

        assert!(
            body.contains("for (const int tdof : ctx.poisson_demag.ess_tdof_list)"),
            "essential value zeroing must iterate the context-owned tdof list directly"
        );
        assert!(
            !source.contains("poisson_essential_tdofs("),
            "hot path must not construct a temporary mfem::Array wrapper for essential tdofs"
        );
    }

    #[test]
    fn native_fem_demag_recovery_reuses_context_workspace() {
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_recovery.cpp");
        let body = source_block(
            source,
            "bool recover_demag_poisson_field(",
            "\n} // namespace fullmag::fem",
        );

        assert!(
            body.contains("demag_recovery_workspace"),
            "recover_demag_poisson_field must use context-owned demag recovery workspace"
        );
        assert!(
            !body.contains("std::vector<std::vector<double>> field_partials("),
            "recover_demag_poisson_field must not allocate per-call full-size field partials"
        );
        assert!(
            !body.contains("std::vector<std::vector<double>> weight_partials("),
            "recover_demag_poisson_field must not allocate per-call full-size weight partials"
        );
        assert!(
            body.contains("serial_scratch"),
            "recover_demag_poisson_field must reuse context-owned serial element scratch"
        );
        assert!(
            body.contains("thread_scratch"),
            "recover_demag_poisson_field must reuse context-owned per-thread element scratch"
        );
        assert!(
            !body.contains("mfem::DenseMatrix dshape;"),
            "recover_demag_poisson_field must not allocate element DenseMatrix scratch per call/thread"
        );
        assert!(
            body.contains("robin_boundary_tmp"),
            "recover_demag_poisson_field must reuse context-owned Robin boundary scratch"
        );
        assert!(
            !body.contains("mfem::Vector Bu("),
            "recover_demag_poisson_field must not allocate Robin boundary scratch per recovery"
        );
    }

    #[test]
    fn native_fem_hypre_solve_reuses_transfer_vectors() {
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp");
        let body = source_block(source, "bool solve_demag_poisson_hypre(", "\n#else");

        assert!(
            body.contains("poisson_hypre_workspace"),
            "solve_demag_poisson_hypre must use context-owned Hypre transfer workspace"
        );
        assert!(
            !body.contains("mfem::HypreParVector b_par("),
            "solve_demag_poisson_hypre must not allocate a fresh RHS HypreParVector per solve"
        );
        assert!(
            !body.contains("mfem::HypreParVector x_par("),
            "solve_demag_poisson_hypre must not allocate a fresh solution HypreParVector per solve"
        );
    }

    #[test]
    fn native_fem_hypre_solve_reuses_persistent_warm_start_vector() {
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp");
        let body = source_block(source, "bool solve_demag_poisson_hypre(", "\n#else");

        let guard = body
            .find("if (!poisson_hypre_workspace->x_par_contains_solution)")
            .expect("Hypre warm-start copy must be guarded by workspace validity");
        let solution_read = body
            .find("const double *sol_host = audited_host_read(warm_start_solution)")
            .expect("first Hypre solve still needs to seed x_par from solution");
        let solved_publish = body
            .find("solved_solution = &x_par")
            .expect("solved Hypre vector must be published without a full-vector copy");

        assert!(
            guard < solution_read && solution_read < solved_publish,
            "solution-to-Hypre warm-start copy must happen only inside the guarded seed block"
        );
        assert!(
            body.contains("poisson_hypre_workspace->x_par_contains_solution = true"),
            "solve_demag_poisson_hypre must mark the persistent Hypre solution vector valid after solve"
        );
    }

    #[test]
    fn native_fem_non_pbc_demag_reuses_solution_workspace() {
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp");
        let lifecycle_source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_lifecycle.cpp");
        let body = source_block(source, "bool context_compute_demag_poisson(", "\n#endif");

        assert!(
            lifecycle_source.contains("ctx.poisson_demag.solution_vec ="),
            "Poisson initialization must allocate a context-owned solution workspace"
        );
        assert!(
            lifecycle_source
                .contains("delete static_cast<mfem::Vector *>(ctx.poisson_demag.solution_vec)"),
            "Poisson destruction must release the context-owned solution workspace"
        );
        assert!(
            body.contains("ctx.poisson_demag.solution_vec"),
            "non-PBC demag solve must use the context-owned solution workspace"
        );
        assert!(
            !body.contains("mfem::Vector solution(fes->GetTrueVSize())"),
            "non-PBC demag solve must not allocate a fresh true-DOF solution vector per solve"
        );
        assert!(
            body.contains("if (!demag_poisson_hypre_has_warm_start(ctx))"),
            "non-PBC demag solve should skip GridFunction warm-start extraction when Hypre already has a persistent solution"
        );
    }

    #[test]
    fn native_fem_hypre_solve_enables_iterative_mode_for_warm_start() {
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp");
        let body = source_block(source, "bool solve_demag_poisson_hypre(", "\n#else");

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
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp");
        let body = source_block(source, "bool solve_demag_poisson_hypre(", "\n#else");

        assert!(
            body.contains("ctx.demag.solver.print_level"),
            "native Hypre solver setup must use the configured demag print level"
        );
        assert!(
            body.contains("SetAbsTol(ctx.demag.solver.absolute_tolerance)"),
            "native Hypre solver setup must apply configured absolute tolerance"
        );
        assert!(
            !body.contains("SetPrintLevel(0)"),
            "native Hypre solver setup must not force print level to zero"
        );
    }

    #[test]
    fn native_fem_demag_amg_policy_has_one_owner_and_effective_abi_provenance() {
        let policy_header = include_str!("../../../backends/fem/core/demag_solver_policy.hpp");
        let policy_source = include_str!("../../../backends/fem/core/demag_solver_policy.cpp");
        let cpu_source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp");
        let gpu_source =
            include_str!("../../../backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp");
        let abi_header = include_str!("../../../native/include/fullmag_fem.h");
        let abi_source = include_str!("../../../backends/fem/src/api.cpp");
        let sys_bindings = include_str!("../../fullmag-fem-sys/src/lib.rs");
        let runner_types = include_str!("types.rs");
        let artifacts_source = include_str!("artifacts.rs");

        assert!(
            policy_header.contains("struct ResolvedDemagAmgPolicy")
                && policy_header.contains("resolve_demag_amg_policy_from_environment()"),
            "the backend-neutral FEM core must own the resolved AMG policy contract"
        );
        for field in ["strength_threshold_is_set", "max_levels_is_set"] {
            assert!(
                policy_header.contains(field),
                "resolved AMG policy must preserve optional override presence for {field}"
            );
            assert!(
                abi_source.contains(&format!("policy.{field}")),
                "native stats publication must copy resolved optional presence for {field}"
            );
        }
        for (env_name, default_literal) in [
            ("FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE", "18"),
            ("FULLMAG_FEM_DEMAG_AMG_COARSENING", "8"),
            ("FULLMAG_FEM_DEMAG_AMG_INTERPOLATION", "6"),
            ("FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING", "1"),
            ("FULLMAG_FEM_DEMAG_AMG_STRENGTH_THRESHOLD", "0.0"),
            ("FULLMAG_FEM_DEMAG_AMG_MAX_LEVELS", "0"),
        ] {
            assert!(
                policy_source.contains(env_name) && policy_source.contains(default_literal),
                "central demag AMG policy owner must resolve {env_name} with its canonical default"
            );
            for (consumer, source) in [("CPU", cpu_source), ("GPU", gpu_source)] {
                assert!(
                    !source.contains(env_name),
                    "{consumer} solver must not independently resolve {env_name}"
                );
            }
            assert!(
                !artifacts_source.contains(env_name),
                "Rust artifacts must copy effective AMG values from the native ABI instead of reading {env_name}"
            );
        }

        for source in [cpu_source, gpu_source] {
            assert!(
                source.contains("ctx.demag.amg_policy"),
                "CPU and GPU solvers must consume the single policy resolved into demag runtime state"
            );
            assert!(
                source.contains("policy.strength_threshold_is_set")
                    && source.contains("policy.max_levels_is_set"),
                "CPU and GPU AMG consumers must distinguish explicit zero overrides from unset values"
            );
        }

        for field in [
            "demag_amg_relax_type",
            "demag_amg_coarsening",
            "demag_amg_interpolation",
            "demag_amg_aggressive_coarsening",
            "demag_amg_strength_threshold",
            "demag_amg_strength_threshold_is_set",
            "demag_amg_max_levels",
            "demag_amg_max_levels_is_set",
        ] {
            assert!(
                abi_header.contains(field),
                "native step stats ABI must expose {field}"
            );
            assert!(
                sys_bindings.contains(field),
                "Rust sys bindings must expose {field}"
            );
            assert!(
                runner_types.contains(field),
                "Rust StepStats must preserve {field}"
            );
        }
        assert!(
            artifacts_source.contains("demag_amg_strength_threshold_is_set")
                && artifacts_source.contains("demag_amg_max_levels_is_set"),
            "artifact provenance must preserve explicit zero optional AMG overrides"
        );
        assert_eq!(
            abi_source
                .matches("apply_demag_solver_policy_to_step_stats(handle->context, *out_stats)")
                .count(),
            3,
            "step, relax_step, and snapshot ABI entrypoints must all publish the effective policy"
        );
    }

    #[test]
    fn native_fem_periodic_demag_reduced_solve_reuses_workspace_and_warm_start() {
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_periodic.cpp");
        let body = source_block(
            source,
            "bool solve_demag_periodic_poisson_reduced(",
            "\n#endif",
        );

        assert!(
            body.contains("periodic_workspace"),
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
                include_str!("../../../backends/fem/cpu/mfem/interactions/dmi_interfacial.cpp"),
            ),
            (
                "compute_bulk_dmi_field(",
                include_str!("../../../backends/fem/cpu/mfem/interactions/dmi_bulk.cpp"),
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
            include_str!("../../../backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp");
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
            include_str!("../../../backends/fem/cpu/mfem/integrators/rk_explicit_step.cpp");
        let start = source
            .find("if (final_stage_cache_valid) {")
            .expect("final field publish block");
        let rest = &source[start..];
        let end = rest
            .find("\n    ctx.state.current_time += dt;")
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
            .find("double max_rhs_final = 0.0;")
            .expect("post-step RHS block");
        let rhs_rest = &source[rhs_start..];
        let rhs_end = rhs_rest
            .find("\n    stats.step = ctx.state.step_count;")
            .expect("post-step RHS block end");
        let rhs_body = &rhs_rest[..rhs_end];
        assert!(
            rhs_body.contains("ws.k[0], max_rhs_final"),
            "non-FSAL post-step RHS should reuse an existing stepper derivative buffer"
        );
        assert!(
            rhs_body.contains(
                "const auto &final_rhs = ws.fsal_valid ? ws.k[0] : ws.k[tab.stages - 1];"
            ),
            "post-step RHS should select the cached first stage only when FSAL is valid"
        );
        assert!(
            !rhs_body.contains("std::vector<double> rhs_final"),
            "non-FSAL post-step RHS must not allocate a local full-size RHS buffer"
        );
    }

    #[test]
    fn native_fem_disabled_local_terms_are_not_zeroed_each_effective_field_eval() {
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/effective_field.cpp");
        let body = source_block(
            source,
            "bool compute_effective_fields_for_magnetization(",
            "\n#endif",
        );

        assert!(
            !body.contains("ctx.dmi.h_interfacial_xyz.assign(m_xyz.size(), 0.0)")
                && !body.contains("ctx.anisotropy.h_cubic_xyz.assign(m_xyz.size(), 0.0)")
                && !body.contains("ctx.dmi.h_bulk_xyz.assign(m_xyz.size(), 0.0)"),
            "disabled DMI/cubic/bulk-DMI buffers should not be cleared on every effective-field evaluation"
        );
        assert!(
            body.contains("if (ctx.exchange.enabled) {\n        h_ex_xyz.resize(m_xyz.size());")
                && body.contains(
                    "if (ctx.demag.enabled) {\n        h_demag_xyz.resize(m_xyz.size());"
                )
                && body.contains("h_eff_xyz.resize(m_xyz.size());"),
            "active exchange/demag/H_eff buffers should avoid pre-zeroing before being overwritten"
        );
        assert!(
            !body.contains("h_eff_xyz.assign(m_xyz.size(), 0.0)"),
            "H_eff is fully overwritten later and must not be pre-zeroed every evaluation"
        );

        let context_source = include_str!("../../../backends/fem/core/fem_field_buffers.cpp");
        assert!(
            context_source
                .contains("fill_zero_vector_field(ctx.dmi.h_interfacial_xyz, ctx.mesh.n_nodes)")
                && context_source.contains(
                    "fill_zero_vector_field(ctx.anisotropy.h_cubic_xyz, ctx.mesh.n_nodes)"
                )
                && context_source
                    .contains("fill_zero_vector_field(ctx.dmi.h_bulk_xyz, ctx.mesh.n_nodes)"),
            "disabled local-term observable buffers must be initialized once in context_from_plan"
        );
    }

    #[test]
    fn native_fem_demag_cache_copy_is_guarded_by_field_refresh_policy() {
        let source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_cache.cpp");
        let body = source_block(
            source,
            "void demag_poisson_store_refreshed_field_cache(",
            "\nbool demag_poisson_try_load_cached_field(",
        );
        let cache_copy = body
            .find("ctx.demag.cached_xyz = h_demag_xyz")
            .expect("demag cache copy");
        let policy_guard = body
            .find("if (ctx.demag.field_refresh.has_demag_interval_s == 0) {")
            .expect("field-refresh cache guard");

        assert!(
            policy_guard < cache_copy,
            "fresh Poisson demag should copy full fields into frozen-field cache only when field_refresh is active"
        );
    }

    #[test]
    fn native_fem_dmi_formula_smoke_has_directional_derivative_oracle() {
        let source = include_str!("../../../backends/fem/tests/dmi_weak_residual.cpp");

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
        let source = include_str!("../../../backends/fem/cpu/mfem/runtime/step_metrics.cpp");
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
    fn native_fem_runner_stats_paths_do_not_copy_full_fields_for_scalar_metrics() {
        let source = include_str!("native_fem.rs");

        for (function_name, end_marker) in [
            ("pub fn relax_step(", "\n    pub fn copy_field("),
            ("pub fn snapshot_step_stats(", "\n    pub fn copy_h_ex("),
        ] {
            let start = source
                .find(function_name)
                .expect("native FEM stats function");
            let rest = &source[start..];
            let end = rest
                .find(end_marker)
                .expect("native FEM stats function end marker");
            let body = &rest[..end];

            assert!(
                !body.contains("self.copy_m("),
                "{function_name} must use native scalar stats instead of copying full m"
            );
            assert!(
                !body.contains("self.copy_h_eff("),
                "{function_name} must use native max_torque_Apm instead of copying full H_eff"
            );
            assert!(
                !body.contains("max_torque_residual_apm_from_field("),
                "{function_name} must not recompute torque from full fields in Rust"
            );
            assert!(
                !body.contains("apply_average_m_to_step_stats("),
                "{function_name} must not recompute mx/my/mz from a full field copy"
            );
            assert!(
                !body.contains("set_object_average_m("),
                "{function_name} must not recompute per-object mx/my/mz from a full field copy"
            );
        }
    }

    #[test]
    fn native_fem_per_object_average_m_uses_native_node_reduction() {
        let source = include_str!("native_fem.rs");
        let header = include_str!("../../../native/include/fullmag_fem.h");
        let api = include_str!("../../../backends/fem/src/api.cpp");

        assert!(
            header.contains("fullmag_fem_backend_average_m_for_nodes_f64"),
            "native FEM C ABI must expose per-node-list average magnetization reduction"
        );
        assert!(
            api.contains("int fullmag_fem_backend_average_m_for_nodes_f64(")
                && api.contains("context_sync_gpu_magnetization_to_host(")
                && api.contains("handle->context.state.m_xyz"),
            "native FEM C ABI implementation must reduce object averages from native state"
        );

        let body = source_block(
            source,
            "fn attach_native_object_average_m(",
            "\n    pub fn step_interruptible(",
        );
        assert!(
            body.contains("self.average_m_for_nodes(node_indices)?"),
            "per-object mx/my/mz must come from native node-index reductions"
        );
        assert!(
            body.contains("values.insert(\"mx\".to_string(), mx)")
                && body.contains("values.insert(\"my\".to_string(), my)")
                && body.contains("values.insert(\"mz\".to_string(), mz)"),
            "native per-object averages must overwrite weighted global mx/my/mz"
        );
        assert!(
            source.contains("ffi::fullmag_fem_backend_average_m_for_nodes_f64("),
            "Rust wrapper must call the native per-object average_m ABI"
        );
    }

    #[test]
    fn native_fem_backend_exposes_demag_tangent_provider_bridge() {
        let source = include_str!("native_fem.rs");
        let header = include_str!("../../../native/include/fullmag_fem.h");
        let api = include_str!("../../../backends/fem/src/api.cpp");

        assert!(
            header.contains("fullmag_fem_backend_apply_demag_tangent_f64"),
            "native FEM C ABI must expose backend demag tangent application"
        );
        assert!(
            api.contains("int fullmag_fem_backend_apply_demag_tangent_f64(")
                && api.contains("compute_fresh_demag_field_for_magnetization(")
                && api.contains("delta_m,")
                && !api.contains("perturbed_demag[index] - baseline_demag[index]"),
            "native FEM C ABI implementation must apply direct H_demag(delta_m), not finite-difference demag tangent"
        );
        let backend_state_io = source_block(
            source,
            "pub fn copy_field(",
            "\n    pub fn snapshot_step_stats(",
        );
        assert!(
            backend_state_io.contains("pub fn apply_demag_tangent(")
                && backend_state_io.contains("ffi::fullmag_fem_backend_apply_demag_tangent_f64("),
            "Rust native FEM backend wrapper must expose the demag tangent provider bridge"
        );
    }

    #[test]
    fn native_fem_backend_exposes_demag_tangent_potential_bridge() {
        let source = include_str!("native_fem.rs");
        let state_io = include_str!("../../../backends/fem/cpu/mfem/runtime/state_io.cpp");
        let solve_source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_solve.cpp");

        assert!(
            state_io.contains("copy_demag_phi_observable_f64")
                && state_io.contains("FULLMAG_FEM_OBSERVABLE_DEMAG_PHI")
                && state_io.contains("gf_potential"),
            "native state I/O must expose the MFEM scalar demag potential observable"
        );
        assert!(
            solve_source.contains("gf_potential_pbc->SetFromTrueDofs(*full_solution)")
                && solve_source.contains("gf_potential->SetFromTrueDofs(*solved_solution)"),
            "fresh Poisson demag solves must leave gf_potential containing the solved scalar potential"
        );
        assert!(
            source.contains("pub fn copy_demag_phi(")
                && source.contains("ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_DEMAG_PHI"),
            "Rust native FEM backend wrapper must expose scalar demag potential copying"
        );
        assert!(
            source.contains("pub fn apply_demag_tangent_with_potential(")
                && source.contains("ffi::fullmag_fem_backend_apply_demag_tangent_with_potential_f64(")
                && !source.contains("let delta_h_demag = self.apply_demag_tangent(delta_m)?"),
            "Rust native FEM backend wrapper must request H_demag(delta_m) and scalar potential through one coherent native ABI"
        );
    }

    #[test]
    fn native_fem_torque_preview_uses_native_observable() {
        let source = include_str!("native_fem.rs");
        let start = source.find("pub fn copy_torque(").expect("copy_torque");
        let rest = &source[start..];
        let end = rest
            .find("\n    pub fn copy_h_ani(")
            .expect("copy_torque end");
        let body = &rest[..end];

        assert!(
            body.contains("FULLMAG_FEM_OBSERVABLE_TORQUE"),
            "copy_torque must request the native torque observable"
        );
        assert!(
            !body.contains("self.copy_m("),
            "copy_torque must not copy full m into Rust"
        );
        assert!(
            !body.contains("self.copy_h_eff("),
            "copy_torque must not copy full H_eff into Rust"
        );
        assert!(
            !body.contains("compute_torque_field("),
            "copy_torque must not rebuild torque from full Rust-side fields"
        );
    }

    #[test]
    fn native_fem_runner_step_total_covers_full_ffi_call_wall_time() {
        let source = include_str!("native_fem.rs");

        for (function_name, end_marker) in [
            ("pub fn step_interruptible(", "\n    #[allow(dead_code)]"),
            ("pub fn relax_step(", "\n    pub fn copy_field("),
        ] {
            let start = source
                .find(function_name)
                .expect("native FEM step function");
            let rest = &source[start..];
            let end = rest.find(end_marker).expect("native FEM step function end");
            let body = &rest[..end];

            assert!(
                body.contains("let ffi_wall_start = std::time::Instant::now();"),
                "{function_name} must measure the whole native FFI step call"
            );
            assert!(
                body.contains("wall_time_ns: stats.wall_time_ns.max(ffi_wall_time_ns),"),
                "{function_name} total wall time must include unprofiled native FFI work"
            );
        }
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
            node_a: 2,
            node_b: 4,
        }];

        let (mut expected_m, mut expected_h_ex, mut expected_h_eff, expected_report) =
            cpu_reference_single_step(&plan);

        // Apply periodic boundary projection to expected reference:
        // Node 4 <- Node 2
        expected_m[4] = expected_m[2];
        expected_h_ex[4] = expected_h_ex[2];
        expected_h_eff[4] = expected_h_eff[2];

        let mut backend = NativeFemBackend::create(&plan).expect("native periodic fem create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native periodic exchange-only fem step");
        let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(plan.mesh.nodes.len()).expect("copy H_ex");
        let actual_h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy H_eff");

        assert_vector_field_close("periodic m", &actual_m, &expected_m, 5e-8, 1e-6);
        assert_vector_field_close("periodic H_ex", &actual_h_ex, &expected_h_ex, 5e-8, 1e-6);
        assert_vector_field_close("periodic H_eff", &actual_h_eff, &expected_h_eff, 5e-8, 1e-6);
        assert_vector_field_close(
            "periodic pair m",
            &actual_m[2..3],
            &actual_m[4..5],
            1e-12,
            1e-12,
        );
        assert_vector_field_close(
            "periodic pair H_ex",
            &actual_h_ex[2..3],
            &actual_h_ex[4..5],
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
            node_a: 2,
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
            &actual_m[2..3],
            &actual_m[4..5],
            1e-12,
            1e-12,
        );
        assert_vector_field_close(
            "periodic consistent pair H_ex",
            &actual_h_ex[2..3],
            &actual_h_ex[4..5],
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
    fn native_fem_prescribed_sot_step_matches_independent_si_reference_when_mfem_stack_is_available(
    ) {
        if !is_cpu_available() {
            eprintln!("skipping native FEM prescribed-SOT parity test: MFEM stack unavailable");
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.external_field = None;
        plan.mfem_device_string = Some("cpu".to_string());
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: "prescribed_sot.fullmag.v1".to_string(),
            operator_version: None,
            realization_version: None,
            target: None,
            stack_normal: None,
            lande_g: None,
            active_node_mask: None,
            active_element_mask: None,
            sot_current_density: Some(1.0e11),
            sot_xi_dl: Some(0.12),
            sot_xi_fl: Some(-0.02),
            sot_sigma: Some([0.0, 1.0, 0.0]),
            sot_thickness: Some(1.5e-9),
            sot_envelope: Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 0.25 }),
            sot_drive: None,
        });

        let (expected_m, expected_max_rhs) = canonical_prescribed_sot_heun_reference(&plan);
        let (reference_m, _, reference_h_eff, reference_report) = cpu_reference_single_step(&plan);
        assert_vector_field_close(
            "independent oracle versus FEM Rust reference m",
            &reference_m,
            &expected_m,
            1e-12,
            1e-14,
        );
        assert_scalar_close(
            "independent oracle versus FEM Rust reference max_rhs",
            reference_report.max_rhs_amplitude,
            expected_max_rhs,
            1e-12,
            1e-9,
        );

        let mut backend =
            NativeFemBackend::create(&plan).expect("native FEM prescribed-SOT create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native prescribed-SOT FEM step");
        let actual_m = backend.copy_m(plan.mesh.nodes.len()).expect("copy SOT m");
        let actual_h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy SOT H_eff");

        assert_vector_field_close("prescribed SOT m", &actual_m, &expected_m, 5e-8, 1e-10);
        assert_vector_field_close(
            "prescribed SOT H_eff",
            &actual_h_eff,
            &reference_h_eff,
            5e-8,
            1e-6,
        );
        assert_scalar_close(
            "prescribed SOT max_rhs_amplitude",
            stats.max_dm_dt,
            expected_max_rhs,
            5e-8,
            1e-9,
        );
    }

    #[test]
    fn native_fem_prescribed_sot_gpu_step_matches_independent_si_reference_when_mfem_stack_is_available(
    ) {
        if !native_cpu_gpu_parity_available(false) {
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.external_field = None;
        plan.mfem_device_string = Some("cuda".to_string());
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: "prescribed_sot.fullmag.v1".to_string(),
            operator_version: None,
            realization_version: None,
            target: None,
            stack_normal: None,
            lande_g: None,
            active_node_mask: None,
            active_element_mask: None,
            sot_current_density: Some(1.0e11),
            sot_xi_dl: Some(0.12),
            sot_xi_fl: Some(-0.02),
            sot_sigma: Some([0.0, 1.0, 0.0]),
            sot_thickness: Some(1.5e-9),
            sot_envelope: Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 1.0 }),
            sot_drive: None,
        });

        let (expected_m, expected_max_rhs) = canonical_prescribed_sot_heun_reference(&plan);
        let (_, _, reference_h_eff, _) = cpu_reference_single_step(&plan);
        let mut backend =
            NativeFemBackend::create(&plan).expect("native FEM GPU prescribed-SOT create");
        let device_name = backend.device_info().expect("GPU SOT device info").name;
        assert!(
            device_name.contains("cuda")
                || device_name.contains("NVIDIA")
                || device_name.contains("GeForce")
                || device_name.contains("RTX"),
            "prescribed-SOT GPU test resolved unexpected device: {device_name}"
        );
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native prescribed-SOT GPU step");
        let actual_m = backend
            .copy_m(plan.mesh.nodes.len())
            .expect("copy GPU SOT m");
        let actual_h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy GPU SOT H_eff");

        assert_vector_field_close("prescribed SOT GPU m", &actual_m, &expected_m, 5e-7, 1e-10);
        assert_vector_field_close(
            "prescribed SOT GPU H_eff",
            &actual_h_eff,
            &reference_h_eff,
            5e-7,
            1e-6,
        );
        assert_scalar_close(
            "prescribed SOT GPU max_rhs_amplitude",
            stats.max_dm_dt,
            expected_max_rhs,
            5e-7,
            1e-9,
        );
    }

    fn make_stage_time_prescribed_sot_plan(device: &str) -> FemPlanIR {
        let mut plan = make_exchange_only_plan();
        plan.external_field = None;
        plan.mfem_device_string = Some(device.to_string());
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: "prescribed_sot.fullmag.v1".to_string(),
            operator_version: None,
            realization_version: None,
            target: None,
            stack_normal: None,
            lande_g: None,
            active_node_mask: None,
            active_element_mask: None,
            sot_current_density: Some(1.0e11),
            sot_xi_dl: Some(0.12),
            sot_xi_fl: Some(-0.02),
            sot_sigma: Some([0.0, 1.0, 0.0]),
            sot_thickness: Some(1.5e-9),
            sot_envelope: Some(fullmag_ir::TimeEnvelopeIR::Sinusoidal {
                amplitude: 0.5,
                frequency_hz: 1.0e12,
                phase_rad: 0.0,
                offset: 1.0,
            }),
            sot_drive: None,
        });
        plan
    }

    fn assert_native_stage_time_prescribed_sot_step(plan: &FemPlanIR, label: &str) {
        let (expected_m, expected_max_rhs) = canonical_prescribed_sot_heun_reference(plan);
        let expected_h_eff = vec![[0.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        let mut backend = NativeFemBackend::create(plan)
            .unwrap_or_else(|error| panic!("{label} native FEM stage-time SOT create: {error}"));
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .unwrap_or_else(|error| panic!("{label} native FEM stage-time SOT step: {error}"));
        let actual_m = backend
            .copy_m(plan.mesh.nodes.len())
            .expect("copy stage-time SOT m");
        let actual_h_eff = backend
            .copy_h_eff(plan.mesh.nodes.len())
            .expect("copy stage-time SOT H_eff");
        assert_vector_field_close(
            &format!("{label} stage-time SOT m"),
            &actual_m,
            &expected_m,
            5e-7,
            1e-10,
        );
        assert_vector_field_close(
            &format!("{label} stage-time SOT H_eff"),
            &actual_h_eff,
            &expected_h_eff,
            5e-7,
            1e-6,
        );
        assert_scalar_close(
            &format!("{label} stage-time SOT max_rhs_amplitude"),
            stats.max_dm_dt,
            expected_max_rhs,
            5e-7,
            1e-9,
        );
    }

    #[test]
    fn native_fem_prescribed_sot_stage_time_envelope_matches_si_reference_on_cpu() {
        if !is_cpu_available() {
            eprintln!("skipping native FEM stage-time SOT CPU test: MFEM stack unavailable");
            return;
        }
        let plan = make_stage_time_prescribed_sot_plan("cpu");
        assert_native_stage_time_prescribed_sot_step(&plan, "CPU");
    }

    #[test]
    fn native_fem_prescribed_sot_stage_time_envelope_matches_si_reference_on_gpu() {
        if !native_cpu_gpu_parity_available(false) {
            return;
        }
        let plan = make_stage_time_prescribed_sot_plan("cuda");
        assert_native_stage_time_prescribed_sot_step(&plan, "GPU");
    }

    fn make_pulse_prescribed_sot_plan(device: &str) -> FemPlanIR {
        let mut plan = make_exchange_only_plan();
        plan.external_field = None;
        plan.mfem_device_string = Some(device.to_string());
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: "prescribed_sot.fullmag.v1".to_string(),
            operator_version: None,
            realization_version: None,
            target: None,
            stack_normal: None,
            lande_g: None,
            active_node_mask: None,
            active_element_mask: None,
            sot_current_density: Some(1.0e11),
            sot_xi_dl: Some(0.12),
            sot_xi_fl: Some(-0.02),
            sot_sigma: Some([0.0, 1.0, 0.0]),
            sot_thickness: Some(1.5e-9),
            sot_envelope: Some(fullmag_ir::TimeEnvelopeIR::Pulse {
                amplitude: 1.0,
                t_on_s: 1.0e-13,
                t_off_s: 2.0e-13,
            }),
            sot_drive: None,
        });
        plan
    }

    fn assert_native_pulse_event_alignment(plan: &FemPlanIR, label: &str) {
        let mut backend = NativeFemBackend::create(plan)
            .unwrap_or_else(|error| panic!("{label} native FEM pulse SOT create: {error}"));
        let first = backend
            .step(2.5e-13)
            .unwrap_or_else(|error| panic!("{label} first event-aligned FEM SOT step: {error}"));
        assert!(
            (first.dt - 1.0e-13).abs() < 1.0e-25,
            "{label} pulse t_on clipped dt: {}",
            first.dt
        );
        assert!(
            (first.time - 1.0e-13).abs() < 1.0e-25,
            "{label} pulse t_on clipped time: {}",
            first.time
        );

        let second = backend
            .step(2.5e-13)
            .unwrap_or_else(|error| panic!("{label} second event-aligned FEM SOT step: {error}"));
        assert!(
            (second.dt - 1.0e-13).abs() < 1.0e-25,
            "{label} pulse t_off clipped dt: {}",
            second.dt
        );
        assert!(
            (second.time - 2.0e-13).abs() < 1.0e-25,
            "{label} pulse t_off clipped time: {}",
            second.time
        );

        let third = backend
            .step(2.5e-13)
            .unwrap_or_else(|error| panic!("{label} post-pulse FEM SOT step: {error}"));
        assert!(
            (third.dt - 2.5e-13).abs() < 1.0e-25,
            "{label} post-pulse dt remains requested: {}",
            third.dt
        );
        assert!(
            (third.time - 4.5e-13).abs() < 1.0e-25,
            "{label} post-pulse time advances: {}",
            third.time
        );
    }

    #[test]
    fn native_fem_prescribed_sot_pulse_clips_steps_at_envelope_knots() {
        if !is_cpu_available() {
            eprintln!("skipping native FEM SOT event-alignment test: MFEM stack unavailable");
            return;
        }
        let plan = make_pulse_prescribed_sot_plan("cpu");
        assert_native_pulse_event_alignment(&plan, "CPU");
    }

    #[test]
    fn native_fem_prescribed_sot_pulse_clips_steps_at_envelope_knots_on_gpu() {
        if !native_cpu_gpu_parity_available(false) {
            return;
        }
        let plan = make_pulse_prescribed_sot_plan("cuda");
        assert_native_pulse_event_alignment(&plan, "GPU");
    }

    #[test]
    fn managed_openmpi_defaults_use_isolated_single_rank_launch() {
        let source = include_str!("native_fem.rs");

        assert!(
            source.contains("set_env_if_missing(\"OMPI_MCA_ess\", \"singleton\")")
                && source.contains("set_env_if_missing(\"OMPI_MCA_plm\", \"isolated\")")
                && source.contains("set_env_if_missing(\"OMPI_MCA_pmix\", \"isolated\")"),
            "managed native FEM OpenMPI setup must use singleton/isolated launch components"
        );
        assert!(
            source.contains("set_env_if_missing(\"OMPI_MCA_ras\", \"simulator\")")
                && source.contains("set_env_if_missing(\"OMPI_MCA_rmaps\", \"seq\")")
                && source.contains("set_env_if_missing(\"OMPI_MCA_routed\", \"direct\")"),
            "managed native FEM OpenMPI setup must avoid distributed host discovery for single-rank runs"
        );
        assert!(
            source.contains("configure_openmpi_loopback_oob_if_missing()")
                && source.contains("set_env_if_missing(\"OMPI_MCA_oob\", \"tcp\")")
                && source.contains(&format!("{}{}", "OMPI_MCA_oob", "_tcp_if_include")),
            "managed native FEM OpenMPI setup must retain OpenMPI loopback OOB fallback"
        );
        assert!(
            source.contains("configure_pmix_loopback_ptl_if_missing()")
                && source.contains(&format!("{}{}", "PMIX_MCA_ptl", "_tcp_if_include")),
            "managed native FEM OpenMPI setup must retain PMIx loopback PTL fallback"
        );
    }

    #[test]
    fn native_fem_slonczewski_step_matches_independent_si_reference_when_mfem_stack_is_available() {
        if !is_gpu_available() {
            eprintln!("skipping native FEM Slonczewski parity test: MFEM stack unavailable");
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.enable_exchange = true;
        plan.external_field = None;
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        plan.stt_thickness = Some(1.0e-9);
        plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: "slonczewski.fullmag.v2".to_string(),
            operator_version: None,
            realization_version: Some("slonczewski_thin_layer_homogenized.v1".to_string()),
            target: None,
            stack_normal: Some([0.0, 0.0, 1.0]),
            lande_g: None,
            active_node_mask: None,
            active_element_mask: None,
            sot_current_density: None,
            sot_xi_dl: None,
            sot_xi_fl: None,
            sot_sigma: None,
            sot_thickness: None,
            sot_envelope: None,
            sot_drive: None,
        });
        assert_eq!(
            plan.spin_torque_contract
                .as_ref()
                .map(|contract| contract.formula_version.as_str()),
            Some("slonczewski.fullmag.v2"),
            "this parity fixture must exercise the canonical Slonczewski v2 contract"
        );
        plan.current_density = Some([0.0, 0.0, 1.4e11]);
        plan.stt_degree = Some(0.62);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.8);
        plan.stt_epsilon_prime = Some(0.03);

        let (expected_m, expected_max_rhs) = canonical_slonczewski_heun_reference(&plan);
        let (reference_m, _, _, reference_report) = cpu_reference_single_step(&plan);
        assert_vector_field_close(
            "independent oracle versus FEM Rust reference m",
            &reference_m,
            &expected_m,
            1e-12,
            1e-14,
        );
        assert_scalar_close(
            "independent oracle versus FEM Rust reference max_rhs",
            reference_report.max_rhs_amplitude,
            expected_max_rhs,
            1e-12,
            1e-9,
        );
        let expected_h_eff = vec![[0.0, 0.0, 0.0]; plan.mesh.nodes.len()];
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
            expected_max_rhs,
            5e-8,
            1e-9,
        );
    }

    #[test]
    fn native_fem_slonczewski_matches_fdm_reference_in_common_limit_when_mfem_stack_is_available() {
        if !is_gpu_available() {
            eprintln!("skipping FEM↔FDM common-limit test: MFEM stack unavailable");
            return;
        }

        let mut fem_plan = make_exchange_only_plan();
        fem_plan.external_field = None;
        fem_plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; fem_plan.mesh.nodes.len()];
        fem_plan.stt_thickness = Some(1.0e-9);
        fem_plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: "slonczewski.fullmag.v2".to_string(),
            operator_version: None,
            realization_version: Some("slonczewski_thin_layer_homogenized.v1".to_string()),
            target: None,
            stack_normal: Some([0.0, 0.0, 1.0]),
            lande_g: None,
            active_node_mask: None,
            active_element_mask: None,
            sot_current_density: None,
            sot_xi_dl: None,
            sot_xi_fl: None,
            sot_sigma: None,
            sot_thickness: None,
            sot_envelope: None,
            sot_drive: None,
        });
        fem_plan.current_density = Some([0.0, 0.0, 1.4e11]);
        fem_plan.stt_degree = Some(0.62);
        fem_plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        fem_plan.stt_lambda = Some(1.8);
        fem_plan.stt_epsilon_prime = Some(0.03);
        let dt = fem_plan
            .fixed_timestep
            .expect("common-limit fixed timestep");

        let mut fdm_plan = fullmag_ir::FdmPlanIR::default();
        fdm_plan.grid = fullmag_ir::GridDimensions { cells: [1, 1, 1] };
        fdm_plan.cell_size = [1.0e-9, 1.0e-9, 1.0e-9];
        fdm_plan.region_mask = vec![1];
        fdm_plan.active_mask = Some(vec![true]);
        fdm_plan.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new_with_masks(
                fdm_plan.origin_m,
                fdm_plan.grid.cells,
                fdm_plan.cell_size,
                1,
                fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
                fdm_plan.active_mask.as_deref(),
                &fdm_plan.region_mask,
            )
            .expect("FDM common-limit grid certificate")
            .with_region_legend(vec![fullmag_ir::FdmRegionLegendEntryIR {
                numeric_id: 1,
                object_id: "common-limit".to_string(),
                region_id: "common-limit:core".to_string(),
                priority: 0,
            }]),
        );
        fdm_plan.initial_magnetization = vec![[1.0, 0.0, 0.0]];
        fdm_plan.material = fullmag_ir::FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.1,
            ..Default::default()
        };
        fdm_plan.enable_exchange = false;
        fdm_plan.enable_demag = false;
        fdm_plan.gyromagnetic_ratio = 2.211e5;
        fdm_plan.precision = fullmag_ir::ExecutionPrecision::Double;
        fdm_plan.exchange_bc = fullmag_ir::ExchangeBoundaryCondition::Neumann;
        fdm_plan.integrator = Some(fullmag_ir::IntegratorChoice::Heun);
        fdm_plan.fixed_timestep = Some(dt);
        fdm_plan.current_density = fem_plan.current_density;
        fdm_plan.stt_degree = fem_plan.stt_degree;
        fdm_plan.stt_spin_polarization = fem_plan.stt_spin_polarization;
        fdm_plan.stt_lambda = fem_plan.stt_lambda;
        fdm_plan.stt_epsilon_prime = fem_plan.stt_epsilon_prime;
        fdm_plan.stt_thickness = fem_plan.stt_thickness;
        fdm_plan.slonczewski_formula_version = Some("slonczewski.fullmag.v2".to_string());
        fdm_plan.slonczewski_stack_normal = Some([0.0, 0.0, 1.0]);
        fdm_plan.slonczewski_active_mask = Some(vec![true]);

        let fdm_run =
            crate::fdm::cpu::reference::execute_reference_fdm(&fdm_plan, dt, &[], None, None)
                .expect("FDM common-limit reference run");
        assert_eq!(
            fdm_run.result.final_magnetization.len(),
            1,
            "one-cell FDM common-limit reference must produce one magnetization"
        );
        let expected = fdm_run.result.final_magnetization[0];

        let mut fem_backend =
            NativeFemBackend::create(&fem_plan).expect("FEM common-limit native create");
        fem_backend.step(dt).expect("FEM common-limit native step");
        let actual = fem_backend
            .copy_m(fem_plan.mesh.nodes.len())
            .expect("FEM common-limit magnetization");
        for (node, value) in actual.iter().enumerate() {
            assert_scalar_close(
                &format!("FEM↔FDM common-limit m[{node}][0]"),
                value[0],
                expected[0],
                5e-8,
                1e-10,
            );
            assert_scalar_close(
                &format!("FEM↔FDM common-limit m[{node}][1]"),
                value[1],
                expected[1],
                5e-8,
                1e-10,
            );
            assert_scalar_close(
                &format!("FEM↔FDM common-limit m[{node}][2]"),
                value[2],
                expected[2],
                5e-8,
                1e-10,
            );
        }
    }

    #[test]
    fn native_fem_prescribed_sot_matches_fdm_reference_in_common_limit_when_mfem_stack_is_available(
    ) {
        if !is_cpu_available() {
            eprintln!("skipping FEM SOT↔FDM common-limit test: MFEM stack unavailable");
            return;
        }

        let mut fem_plan = make_exchange_only_plan();
        fem_plan.enable_exchange = false;
        fem_plan.external_field = None;
        fem_plan.mfem_device_string = Some("cpu".to_string());
        fem_plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; fem_plan.mesh.nodes.len()];
        fem_plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: "prescribed_sot.fullmag.v1".to_string(),
            operator_version: None,
            realization_version: None,
            target: None,
            stack_normal: None,
            lande_g: None,
            active_node_mask: None,
            active_element_mask: None,
            sot_current_density: Some(-4.0e11),
            sot_xi_dl: Some(0.12),
            sot_xi_fl: Some(-0.03),
            sot_sigma: Some([0.0, 1.0, 0.0]),
            sot_thickness: Some(1.5e-9),
            sot_envelope: Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 0.25 }),
            sot_drive: None,
        });
        let dt = fem_plan
            .fixed_timestep
            .expect("SOT common-limit fixed timestep");

        let mut fdm_plan = fullmag_ir::FdmPlanIR::default();
        fdm_plan.grid = fullmag_ir::GridDimensions { cells: [1, 1, 1] };
        fdm_plan.cell_size = [1.0e-9, 1.0e-9, 1.0e-9];
        fdm_plan.region_mask = vec![1];
        fdm_plan.active_mask = Some(vec![true]);
        fdm_plan.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new_with_masks(
                fdm_plan.origin_m,
                fdm_plan.grid.cells,
                fdm_plan.cell_size,
                1,
                fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
                fdm_plan.active_mask.as_deref(),
                &fdm_plan.region_mask,
            )
            .expect("FDM SOT common-limit grid certificate")
            .with_region_legend(vec![fullmag_ir::FdmRegionLegendEntryIR {
                numeric_id: 1,
                object_id: "common-limit".to_string(),
                region_id: "common-limit:core".to_string(),
                priority: 0,
            }]),
        );
        fdm_plan.initial_magnetization = vec![[1.0, 0.0, 0.0]];
        fdm_plan.material = fullmag_ir::FdmMaterialIR {
            name: "Py".to_string(),
            saturation_magnetisation: 800e3,
            exchange_stiffness: 13e-12,
            damping: 0.1,
            ..Default::default()
        };
        fdm_plan.enable_exchange = false;
        fdm_plan.enable_demag = false;
        fdm_plan.gyromagnetic_ratio = 2.211e5;
        fdm_plan.precision = fullmag_ir::ExecutionPrecision::Double;
        fdm_plan.exchange_bc = ExchangeBoundaryCondition::Neumann;
        fdm_plan.integrator = Some(IntegratorChoice::Heun);
        fdm_plan.fixed_timestep = Some(dt);
        fdm_plan.sot_formula_version = Some("prescribed_sot.fullmag.v1".to_string());
        fdm_plan.sot_current_density = Some(-4.0e11);
        fdm_plan.sot_xi_dl = Some(0.12);
        fdm_plan.sot_xi_fl = Some(-0.03);
        fdm_plan.sot_sigma = Some([0.0, 1.0, 0.0]);
        fdm_plan.sot_thickness = Some(1.5e-9);
        fdm_plan.sot_envelope = Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 0.25 });
        fdm_plan.sot_target = Some(fullmag_ir::RegionRefIR {
            object_id: "common-limit".to_string(),
            region_id: None,
        });
        fdm_plan.sot_active_mask = Some(vec![true]);
        fdm_plan.sot_drive = Some(fullmag_ir::PrescribedSotV1DriveIR::SignedScalar {
            current_density_apm2: -4.0e11,
            sigma_hat: [0.0, 1.0, 0.0],
            envelope: Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 0.25 }),
        });

        let fdm_run =
            crate::fdm::cpu::reference::execute_reference_fdm(&fdm_plan, dt, &[], None, None)
                .expect("FDM SOT common-limit reference run");
        assert_eq!(
            fdm_run.result.final_magnetization.len(),
            1,
            "one-cell FDM SOT common-limit reference must produce one magnetization"
        );
        let expected = fdm_run.result.final_magnetization[0];

        let mut fem_backend =
            NativeFemBackend::create(&fem_plan).expect("FEM SOT common-limit native create");
        fem_backend
            .step(dt)
            .expect("FEM SOT common-limit native step");
        let actual = fem_backend
            .copy_m(fem_plan.mesh.nodes.len())
            .expect("FEM SOT common-limit magnetization");
        for (node, value) in actual.iter().enumerate() {
            assert_scalar_close(
                &format!("FEM SOT↔FDM common-limit m[{node}][0]"),
                value[0],
                expected[0],
                5e-8,
                1e-10,
            );
            assert_scalar_close(
                &format!("FEM SOT↔FDM common-limit m[{node}][1]"),
                value[1],
                expected[1],
                5e-8,
                1e-10,
            );
            assert_scalar_close(
                &format!("FEM SOT↔FDM common-limit m[{node}][2]"),
                value[2],
                expected[2],
                5e-8,
                1e-10,
            );
        }
    }

    #[test]
    fn native_fem_prescribed_sot_fixed_trajectory_cpu_gpu_parity_when_mfem_stack_is_available() {
        if !native_cpu_gpu_parity_available(false) {
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.external_field = None;
        plan.fixed_timestep = Some(1.0e-15);
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; plan.mesh.nodes.len()];
        plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: "prescribed_sot.fullmag.v1".to_string(),
            operator_version: None,
            realization_version: None,
            target: None,
            stack_normal: None,
            lande_g: None,
            active_node_mask: Some(vec![true, true, false, true, true]),
            active_element_mask: None,
            sot_current_density: Some(1.0e11),
            sot_xi_dl: Some(0.12),
            sot_xi_fl: Some(-0.02),
            sot_sigma: Some([0.0, 1.0, 0.0]),
            sot_thickness: Some(1.5e-9),
            sot_envelope: Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 1.0 }),
            sot_drive: None,
        });

        let cpu_plan = native_plan_for_device(&plan, "cpu");
        let gpu_plan = native_plan_for_device(&plan, "cuda");
        assert_same_parity_mesh(&cpu_plan, &gpu_plan);
        let dt = plan.fixed_timestep.expect("fixed SOT trajectory timestep");
        let mut cpu = NativeFemBackend::create(&cpu_plan).expect("native FEM SOT CPU create");
        let mut gpu = NativeFemBackend::create(&gpu_plan).expect("native FEM SOT GPU create");

        for step in 1..=8 {
            let cpu_stats = cpu.step(dt).expect("native FEM SOT CPU trajectory step");
            let gpu_stats = gpu.step(dt).expect("native FEM SOT GPU trajectory step");
            let cpu_m = cpu
                .copy_m(plan.mesh.nodes.len())
                .expect("copy FEM SOT CPU trajectory m");
            let gpu_m = gpu
                .copy_m(plan.mesh.nodes.len())
                .expect("copy FEM SOT GPU trajectory m");
            assert_vector_field_parity(
                &format!("prescribed SOT FEM CPU/GPU trajectory step {step}"),
                &cpu_m,
                &gpu_m,
                5e-7,
                1e-10,
            );
            assert_scalar_close(
                &format!("prescribed SOT CPU/GPU time step {step}"),
                cpu_stats.time,
                gpu_stats.time,
                5e-7,
                1e-24,
            );
            assert_scalar_close(
                &format!("prescribed SOT CPU/GPU max_rhs step {step}"),
                cpu_stats.max_dm_dt,
                gpu_stats.max_dm_dt,
                5e-7,
                1e-9,
            );
        }
    }

    #[test]
    fn native_fem_prescribed_sot_cpu_gpu_integrator_parity_when_mfem_stack_is_available() {
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
            plan.external_field = None;
            plan.fixed_timestep = Some(1.0e-15);
            plan.integrator = Some(integrator);
            plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
                formula_version: "prescribed_sot.fullmag.v1".to_string(),
                operator_version: None,
                realization_version: None,
                target: None,
                stack_normal: None,
                lande_g: None,
                active_node_mask: Some(vec![true, true, false, true, true]),
                active_element_mask: None,
                sot_current_density: Some(1.0e11),
                sot_xi_dl: Some(0.12),
                sot_xi_fl: Some(-0.02),
                sot_sigma: Some([0.0, 1.0, 0.0]),
                sot_thickness: Some(1.5e-9),
                sot_envelope: Some(fullmag_ir::TimeEnvelopeIR::Constant { value: 1.0 }),
                sot_drive: None,
            });

            let cpu_plan = native_plan_for_device(&plan, "cpu");
            let gpu_plan = native_plan_for_device(&plan, "cuda");
            assert_same_parity_mesh(&cpu_plan, &gpu_plan);
            let dt = plan.fixed_timestep.expect("fixed SOT integrator timestep");
            let mut cpu = NativeFemBackend::create(&cpu_plan).unwrap_or_else(|error| {
                panic!("native FEM SOT CPU {integrator:?} create: {error}")
            });
            let mut gpu = NativeFemBackend::create(&gpu_plan).unwrap_or_else(|error| {
                panic!("native FEM SOT GPU {integrator:?} create: {error}")
            });
            let cpu_stats = cpu
                .step(dt)
                .unwrap_or_else(|error| panic!("native FEM SOT CPU {integrator:?} step: {error}"));
            let gpu_stats = gpu
                .step(dt)
                .unwrap_or_else(|error| panic!("native FEM SOT GPU {integrator:?} step: {error}"));
            let cpu_m = cpu
                .copy_m(plan.mesh.nodes.len())
                .expect("copy FEM SOT integrator CPU m");
            let gpu_m = gpu
                .copy_m(plan.mesh.nodes.len())
                .expect("copy FEM SOT integrator GPU m");
            assert_vector_field_parity(
                &format!("prescribed SOT {integrator:?} CPU/GPU m"),
                &cpu_m,
                &gpu_m,
                5e-7,
                1e-10,
            );
            assert_scalar_close(
                &format!("prescribed SOT {integrator:?} CPU/GPU max_rhs"),
                cpu_stats.max_dm_dt,
                gpu_stats.max_dm_dt,
                5e-7,
                1e-9,
            );
            if matches!(integrator, IntegratorChoice::Rk23 | IntegratorChoice::Rk45) {
                assert!(
                    (cpu_stats.rhs_evals as i64 - gpu_stats.rhs_evals as i64).abs() <= 1,
                    "prescribed SOT {integrator:?} CPU/GPU embedded RHS count mismatch: cpu={}, gpu={}",
                    cpu_stats.rhs_evals,
                    gpu_stats.rhs_evals
                );
            } else {
                assert_eq!(
                    cpu_stats.rhs_evals, gpu_stats.rhs_evals,
                    "prescribed SOT {integrator:?} CPU/GPU RHS count mismatch"
                );
            }
        }
    }

    #[test]
    fn native_fem_canonical_slonczewski_fixed_trajectory_parity_when_mfem_stack_is_available() {
        if !native_cpu_gpu_parity_available(false) {
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.enable_exchange = true;
        plan.external_field = None;
        plan.fixed_timestep = Some(1.0e-15);
        plan.current_density = Some([1.4e11, 0.0, 0.0]);
        plan.stt_degree = Some(0.62);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.8);
        plan.stt_epsilon_prime = Some(0.03);
        plan.stt_thickness = Some(1.0e-9);
        plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: "slonczewski.fullmag.v2".to_string(),
            operator_version: None,
            realization_version: Some("slonczewski_thin_layer_homogenized.v1".to_string()),
            target: None,
            stack_normal: Some([2.0, 0.0, 0.0]),
            lande_g: None,
            active_node_mask: Some(vec![true, true, false, true, true]),
            active_element_mask: None,
            sot_current_density: None,
            sot_xi_dl: None,
            sot_xi_fl: None,
            sot_sigma: None,
            sot_thickness: None,
            sot_envelope: None,
            sot_drive: None,
        });

        let cpu_plan = native_plan_for_device(&plan, "cpu");
        let gpu_plan = native_plan_for_device(&plan, "cuda");
        assert_same_parity_mesh(&cpu_plan, &gpu_plan);
        let dt = plan.fixed_timestep.expect("fixed timestep");
        let mut cpu = NativeFemBackend::create(&cpu_plan).expect("native FEM canonical CPU create");
        let mut gpu = NativeFemBackend::create(&gpu_plan).expect("native FEM canonical GPU create");

        for step in 1..=8 {
            cpu.step(dt)
                .expect("native FEM canonical CPU trajectory step");
            gpu.step(dt)
                .expect("native FEM canonical GPU trajectory step");
            let cpu_m = cpu
                .copy_m(plan.mesh.nodes.len())
                .expect("copy canonical CPU m");
            let gpu_m = gpu
                .copy_m(plan.mesh.nodes.len())
                .expect("copy canonical GPU m");
            assert_vector_field_close(
                &format!("canonical FEM Slonczewski trajectory step {step}"),
                &gpu_m,
                &cpu_m,
                5e-7,
                1e-10,
            );
        }
    }

    #[test]
    fn native_fem_canonical_slonczewski_has_bounded_current_scaling_when_mfem_stack_is_available() {
        if !native_cpu_gpu_parity_available(false) {
            return;
        }

        let mut plan = make_exchange_only_plan();
        plan.enable_exchange = true;
        plan.external_field = None;
        plan.fixed_timestep = Some(1.0e-15);
        plan.current_density = Some([0.0, 0.0, 0.0]);
        plan.stt_degree = Some(0.62);
        plan.stt_spin_polarization = Some([0.0, 0.0, 1.0]);
        plan.stt_lambda = Some(1.8);
        plan.stt_epsilon_prime = Some(0.03);
        plan.stt_thickness = Some(1.0e-9);
        plan.spin_torque_contract = Some(fullmag_ir::FemSpinTorquePlanIR {
            formula_version: "slonczewski.fullmag.v2".to_string(),
            operator_version: None,
            realization_version: Some("slonczewski_thin_layer_homogenized.v1".to_string()),
            target: None,
            stack_normal: Some([2.0, 0.0, 0.0]),
            lande_g: None,
            active_node_mask: Some(vec![true, true, false, true, true]),
            active_element_mask: None,
            sot_current_density: None,
            sot_xi_dl: None,
            sot_xi_fl: None,
            sot_sigma: None,
            sot_thickness: None,
            sot_envelope: None,
            sot_drive: None,
        });

        let dt = plan.fixed_timestep.expect("fixed timestep");
        let initial = plan.initial_magnetization.clone();
        let run = |device: &str, current_scale: f64| -> Vec<[f64; 3]> {
            let mut scaled_plan = native_plan_for_device(&plan, device);
            scaled_plan.current_density = Some([2.4e13 * current_scale, 0.0, 0.0]);
            let mut backend = NativeFemBackend::create(&scaled_plan)
                .expect("native FEM Slonczewski current-scaling create");
            backend
                .step(dt)
                .expect("native FEM Slonczewski current-scaling step");
            backend
                .copy_m(scaled_plan.mesh.nodes.len())
                .expect("copy current-scaling magnetization")
        };

        for device in ["cpu", "cuda"] {
            let zero = run(device, 0.0);
            let half = run(device, 0.5);
            let one = run(device, 1.0);
            let double = run(device, 2.0);

            for (node, (m0, (((zero, half), one), double))) in initial
                .iter()
                .zip(
                    zero.iter()
                        .zip(half.iter())
                        .zip(one.iter())
                        .zip(double.iter()),
                )
                .enumerate()
            {
                let project_tangent = |state: &[f64; 3], reference: &[f64; 3]| {
                    let delta = [
                        state[0] - reference[0],
                        state[1] - reference[1],
                        state[2] - reference[2],
                    ];
                    let radial = delta[0] * m0[0] + delta[1] * m0[1] + delta[2] * m0[2];
                    [
                        delta[0] - radial * m0[0],
                        delta[1] - radial * m0[1],
                        delta[2] - radial * m0[2],
                    ]
                };
                let t_half = project_tangent(half, zero);
                let t_one = project_tangent(one, zero);
                let t_double = project_tangent(double, zero);
                let mut one_error_sq = 0.0;
                let mut double_error_sq = 0.0;
                let mut scale_sq: f64 = 1e-28;
                for component in 0..3 {
                    let one_error = t_one[component] - 2.0 * t_half[component];
                    let double_error = t_double[component] - 4.0 * t_half[component];
                    one_error_sq += one_error * one_error;
                    double_error_sq += double_error * double_error;
                    scale_sq = scale_sq
                        .max(t_half[component] * t_half[component])
                        .max(t_one[component] * t_one[component])
                        .max(t_double[component] * t_double[component]);
                }
                let scale = scale_sq.sqrt();
                assert!(
                    one_error_sq.sqrt() <= 5e-3 * scale,
                    "{device} Slonczewski tangential 1x response is not 2x 0.5x at node {node}: half={t_half:?} one={t_one:?}"
                );
                assert!(
                    double_error_sq.sqrt() <= 1e-2 * scale,
                    "{device} Slonczewski tangential 2x response is not 4x 0.5x at node {node}: half={t_half:?} double={t_double:?}"
                );
            }
        }
    }

    #[test]
    fn native_fem_external_lead_oersted_callback_advances_one_cpu_llg_step() {
        let plan = steady_transport::test_external_lead_stage_plan();
        let provider = StageOerstedProvider::from_plan(&plan)
            .expect("external-lead stage provider preflight")
            .expect("external-lead plan must request a stage provider");
        let mut backend = NativeFemBackend::create(&plan)
            .expect("native FEM external-lead callback backend create");
        backend
            .install_stage_oersted_provider(Box::new(provider))
            .expect("install external-lead Oersted callback");
        backend.begin_stage(0.0).expect("begin native FEM stage");

        let stats = backend
            .step(plan.fixed_timestep.expect("fixed timestep"))
            .expect("external-lead Oersted callback must advance one LLG step");
        assert!(stats.time.is_finite() && stats.time > 0.0);
        assert!(stats.max_torque_T.is_finite());
        let magnetization = backend
            .copy_m(plan.mesh.nodes.len())
            .expect("copy post-step magnetization");
        assert!(magnetization
            .iter()
            .flatten()
            .all(|component| component.is_finite()));

        let telemetry = backend
            .stage_oersted_telemetry()
            .expect("installed callback telemetry");
        assert_eq!(telemetry["policy"], "fem_stage_oersted_callback.v1");
        assert!(telemetry["begin_count"]
            .as_u64()
            .is_some_and(|count| count >= 1));
        assert!(telemetry["commit_count"]
            .as_u64()
            .is_some_and(|count| count >= 1));
        assert!(telemetry["evaluate_count"]
            .as_u64()
            .is_some_and(|count| count >= 1));
        assert!(telemetry["accepted_observation"]["field_sha256"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("sha256:")));
    }

    #[test]
    fn native_fem_reciprocal_m2_shares_one_stage_solve_for_torque_and_oersted() {
        let plan = steady_transport::test_reciprocal_m2_oersted_stage_plan();
        let coupled = StageM2CoupledProvider::from_plan(&plan)
            .expect("combined FEM M2 provider preflight")
            .expect("combined FEM M2 plan must request the shared provider");
        let oersted = StageOerstedProvider::from_plan_with_coupled(&plan, Some(coupled.clone()))
            .expect("combined Oersted provider preflight")
            .expect("combined plan must request Oersted callback");
        let transport = StageTransportProvider::from_plan_with_coupled(&plan, Some(coupled))
            .expect("combined transport provider preflight")
            .expect("combined plan must request transport callback");
        let mut backend =
            NativeFemBackend::create(&plan).expect("combined FEM M2 callback backend create");
        backend
            .install_stage_oersted_provider(Box::new(oersted))
            .expect("install combined Oersted callback");
        backend
            .install_stage_transport_provider(Box::new(transport))
            .expect("install combined transport callback");
        backend
            .begin_stage(0.0)
            .expect("begin combined FEM M2 stage");

        let stats = backend
            .step(plan.fixed_timestep.expect("fixed timestep"))
            .expect("combined torque/Oersted callback must advance one LLG step");
        assert!(stats.time.is_finite() && stats.time > 0.0);
        assert!(stats.max_torque_T.is_finite());

        let oersted = backend
            .stage_oersted_telemetry()
            .expect("combined Oersted telemetry");
        let transport = backend
            .stage_transport_telemetry()
            .expect("combined transport telemetry");
        assert_eq!(oersted["policy"], "fem_stage_transport_oersted_callback.v1");
        assert_eq!(transport["policy"], oersted["policy"]);
        assert_eq!(
            transport["accepted_observation"]["source_state_revision"],
            oersted["accepted_observation"]["source_state_revision"]
        );
        assert_eq!(
            transport["accepted_observation"]["source_state_digest"],
            oersted["accepted_observation"]["source_view_identity_digest"]
        );
        let solve_count = oersted["shared_evaluator"]["solve_count"]
            .as_u64()
            .expect("shared solve count");
        let cache_hits = oersted["shared_evaluator"]["cache_hit_count"]
            .as_u64()
            .expect("shared cache-hit count");
        let stage_evaluations = oersted["evaluate_count"]
            .as_u64()
            .expect("Oersted evaluate count");
        assert!(solve_count >= 1);
        assert_eq!(solve_count, stage_evaluations);
        assert!(cache_hits >= stage_evaluations);
        assert_eq!(transport["shared_evaluator"], oersted["shared_evaluator"]);
        assert!(transport["accepted_observation"]["torque_l2_per_s"]
            .as_f64()
            .is_some_and(|value| value.is_finite() && value > 0.0));
        assert!(oersted["accepted_observation"]["field_sha256"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("sha256:")));
    }

    #[test]
    fn native_fem_reciprocal_m2_rolls_back_both_callbacks_before_shared_retry() {
        let mut plan = steady_transport::test_reciprocal_m2_oersted_stage_plan();
        plan.integrator = Some(IntegratorChoice::Rk23);
        plan.fixed_timestep = None;
        plan.adaptive_timestep = Some(AdaptiveTimeStepIR {
            tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::Advanced,
            atol: 1.0e-10,
            rtol: 1.0e-8,
            dt_initial: Some(1.0e-8),
            dt_min: 1.0e-16,
            dt_max: Some(1.0e-8),
            safety: 0.8,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: Some(1.0e-12),
            norm_tolerance: Some(1.0e-8),
        });
        let coupled = StageM2CoupledProvider::from_plan(&plan)
            .expect("adaptive combined FEM M2 provider preflight")
            .expect("adaptive combined plan must request the shared provider");
        let oersted = StageOerstedProvider::from_plan_with_coupled(&plan, Some(coupled.clone()))
            .expect("adaptive combined Oersted provider preflight")
            .expect("adaptive combined plan must request Oersted callback");
        let transport = StageTransportProvider::from_plan_with_coupled(&plan, Some(coupled))
            .expect("adaptive combined transport provider preflight")
            .expect("adaptive combined plan must request transport callback");
        let mut backend = NativeFemBackend::create(&plan)
            .expect("adaptive combined FEM M2 callback backend create");
        backend
            .install_stage_oersted_provider(Box::new(oersted))
            .expect("install adaptive combined Oersted callback");
        backend
            .install_stage_transport_provider(Box::new(transport))
            .expect("install adaptive combined transport callback");
        backend
            .begin_stage(0.0)
            .expect("begin adaptive combined FEM M2 stage");

        let stats = backend
            .step(1.0e-8)
            .expect("adaptive combined step must reject and then accept");
        assert!(stats.rejected_attempts >= 1, "{stats:?}");
        let oersted = backend
            .stage_oersted_telemetry()
            .expect("adaptive combined Oersted telemetry");
        let transport = backend
            .stage_transport_telemetry()
            .expect("adaptive combined transport telemetry");
        let rejected = u64::from(stats.rejected_attempts);
        assert_eq!(oersted["rollback_count"], rejected);
        assert_eq!(transport["rollback_count"], rejected);
        assert_eq!(oersted["commit_count"], 1);
        assert_eq!(transport["commit_count"], 1);
        assert_eq!(oersted["begin_count"], rejected + 1);
        assert_eq!(transport["begin_count"], rejected + 1);
        assert_eq!(
            transport["accepted_observation"]["source_state_revision"],
            oersted["accepted_observation"]["source_state_revision"]
        );
        assert_eq!(
            transport["accepted_observation"]["source_state_digest"],
            oersted["accepted_observation"]["source_view_identity_digest"]
        );
        let solve_count = oersted["shared_evaluator"]["solve_count"]
            .as_u64()
            .expect("adaptive shared solve count");
        let cache_hits = oersted["shared_evaluator"]["cache_hit_count"]
            .as_u64()
            .expect("adaptive shared cache-hit count");
        let oersted_evaluations = oersted["evaluate_count"]
            .as_u64()
            .expect("adaptive Oersted evaluate count");
        assert_eq!(solve_count, oersted_evaluations);
        assert!(cache_hits >= oersted_evaluations);
        assert_eq!(transport["shared_evaluator"], oersted["shared_evaluator"]);
    }

    #[test]
    fn native_fem_reciprocal_m2_shares_source_across_all_explicit_rk_integrators() {
        for (integrator, adaptive) in [
            (IntegratorChoice::Heun, false),
            (IntegratorChoice::Rk4, false),
            (IntegratorChoice::Rk23, true),
            (IntegratorChoice::Rk45, true),
        ] {
            let mut plan = steady_transport::test_reciprocal_m2_oersted_stage_plan();
            plan.integrator = Some(integrator);
            if adaptive {
                plan.fixed_timestep = None;
                plan.adaptive_timestep = Some(AdaptiveTimeStepIR {
                    tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::Advanced,
                    atol: 1.0e-8,
                    rtol: 1.0e-5,
                    dt_initial: Some(1.0e-13),
                    dt_min: 1.0e-16,
                    dt_max: Some(1.0e-12),
                    safety: 0.9,
                    growth_limit: 2.0,
                    shrink_limit: 0.5,
                    max_spin_rotation: None,
                    norm_tolerance: None,
                });
            }
            let coupled = StageM2CoupledProvider::from_plan(&plan)
                .unwrap_or_else(|error| panic!("{integrator:?} shared preflight: {error:?}"))
                .unwrap_or_else(|| panic!("{integrator:?} did not request shared provider"));
            let oersted =
                StageOerstedProvider::from_plan_with_coupled(&plan, Some(coupled.clone()))
                    .unwrap_or_else(|error| panic!("{integrator:?} Oersted preflight: {error:?}"))
                    .unwrap_or_else(|| panic!("{integrator:?} did not request Oersted callback"));
            let transport = StageTransportProvider::from_plan_with_coupled(&plan, Some(coupled))
                .unwrap_or_else(|error| panic!("{integrator:?} transport preflight: {error:?}"))
                .unwrap_or_else(|| panic!("{integrator:?} did not request transport callback"));
            let mut backend = NativeFemBackend::create(&plan)
                .unwrap_or_else(|error| panic!("{integrator:?} backend create: {error:?}"));
            backend
                .install_stage_oersted_provider(Box::new(oersted))
                .unwrap_or_else(|error| panic!("{integrator:?} install Oersted: {error:?}"));
            backend
                .install_stage_transport_provider(Box::new(transport))
                .unwrap_or_else(|error| panic!("{integrator:?} install transport: {error:?}"));
            backend
                .begin_stage(0.0)
                .unwrap_or_else(|error| panic!("{integrator:?} begin stage: {error:?}"));

            let mut previous_time = 0.0;
            for step_index in 0..3 {
                let stats = backend.step(1.0e-13).unwrap_or_else(|error| {
                    panic!("{integrator:?} shared trajectory step {step_index}: {error:?}")
                });
                assert!(
                    stats.time.is_finite() && stats.time > previous_time,
                    "{integrator:?} step {step_index}: {stats:?}"
                );
                previous_time = stats.time;
            }
            let oersted = backend
                .stage_oersted_telemetry()
                .unwrap_or_else(|| panic!("{integrator:?} Oersted telemetry"));
            let transport = backend
                .stage_transport_telemetry()
                .unwrap_or_else(|| panic!("{integrator:?} transport telemetry"));
            assert_eq!(oersted["begin_count"], 3, "{integrator:?}");
            assert_eq!(oersted["commit_count"], 3, "{integrator:?}");
            assert_eq!(transport["begin_count"], 3, "{integrator:?}");
            assert_eq!(transport["commit_count"], 3, "{integrator:?}");
            assert_eq!(
                transport["accepted_observation"]["source_state_revision"],
                oersted["accepted_observation"]["source_state_revision"],
                "{integrator:?}"
            );
            assert_eq!(
                transport["accepted_observation"]["source_state_digest"],
                oersted["accepted_observation"]["source_view_identity_digest"],
                "{integrator:?}"
            );
            let solve_count = oersted["shared_evaluator"]["solve_count"]
                .as_u64()
                .unwrap_or_else(|| panic!("{integrator:?} solve count"));
            let cache_hits = oersted["shared_evaluator"]["cache_hit_count"]
                .as_u64()
                .unwrap_or_else(|| panic!("{integrator:?} cache-hit count"));
            let evaluations = oersted["evaluate_count"]
                .as_u64()
                .unwrap_or_else(|| panic!("{integrator:?} Oersted evaluate count"));
            assert_eq!(solve_count, evaluations, "{integrator:?}");
            assert!(cache_hits >= evaluations, "{integrator:?}");
            assert_eq!(
                transport["shared_evaluator"], oersted["shared_evaluator"],
                "{integrator:?}"
            );
        }
    }

    #[test]
    fn native_fem_external_lead_oersted_callback_rolls_back_rejected_adaptive_attempt() {
        let mut plan = steady_transport::test_external_lead_stage_plan();
        plan.integrator = Some(IntegratorChoice::Rk23);
        plan.fixed_timestep = None;
        plan.adaptive_timestep = Some(AdaptiveTimeStepIR {
            tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::Advanced,
            atol: 1.0e-10,
            rtol: 1.0e-8,
            dt_initial: Some(1.0e-8),
            dt_min: 1.0e-16,
            dt_max: Some(1.0e-8),
            safety: 0.8,
            growth_limit: 2.0,
            shrink_limit: 0.2,
            max_spin_rotation: Some(1.0e-12),
            norm_tolerance: Some(1.0e-8),
        });
        let provider = StageOerstedProvider::from_plan(&plan)
            .expect("adaptive external-lead stage provider preflight")
            .expect("adaptive external-lead plan must request a stage provider");
        let mut backend = NativeFemBackend::create(&plan)
            .expect("adaptive native FEM external-lead callback backend create");
        backend
            .install_stage_oersted_provider(Box::new(provider))
            .expect("install adaptive external-lead Oersted callback");
        backend.begin_stage(0.0).expect("begin adaptive FEM stage");

        let stats = backend
            .step(1.0e-8)
            .expect("adaptive external-lead step must reject and then accept");
        assert!(stats.rejected_attempts >= 1, "{stats:?}");
        let telemetry = backend
            .stage_oersted_telemetry()
            .expect("adaptive callback telemetry");
        let rollbacks = telemetry["rollback_count"]
            .as_u64()
            .expect("rollback counter");
        assert_eq!(rollbacks, u64::from(stats.rejected_attempts));
        assert_eq!(telemetry["commit_count"], 1);
        assert!(telemetry["evaluate_count"]
            .as_u64()
            .is_some_and(|count| count > rollbacks));
        assert!(telemetry["accepted_observation"]["field_sha256"]
            .as_str()
            .is_some_and(|digest| digest.starts_with("sha256:")));
    }

    #[test]
    fn native_fem_external_lead_oersted_callback_covers_all_explicit_rk_integrators() {
        for (integrator, adaptive) in [
            (IntegratorChoice::Heun, false),
            (IntegratorChoice::Rk4, false),
            (IntegratorChoice::Rk23, true),
            (IntegratorChoice::Rk45, true),
        ] {
            let mut plan = steady_transport::test_external_lead_stage_plan();
            plan.integrator = Some(integrator);
            if adaptive {
                plan.fixed_timestep = None;
                plan.adaptive_timestep = Some(AdaptiveTimeStepIR {
                    tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::Advanced,
                    atol: 1.0e-8,
                    rtol: 1.0e-5,
                    dt_initial: Some(1.0e-13),
                    dt_min: 1.0e-16,
                    dt_max: Some(1.0e-12),
                    safety: 0.9,
                    growth_limit: 2.0,
                    shrink_limit: 0.5,
                    max_spin_rotation: None,
                    norm_tolerance: None,
                });
            }
            let provider = StageOerstedProvider::from_plan(&plan)
                .unwrap_or_else(|error| panic!("{integrator:?} provider preflight: {error:?}"))
                .unwrap_or_else(|| panic!("{integrator:?} plan did not request a provider"));
            let mut backend = NativeFemBackend::create(&plan)
                .unwrap_or_else(|error| panic!("{integrator:?} backend create: {error:?}"));
            backend
                .install_stage_oersted_provider(Box::new(provider))
                .unwrap_or_else(|error| panic!("{integrator:?} callback install: {error:?}"));
            backend
                .begin_stage(0.0)
                .unwrap_or_else(|error| panic!("{integrator:?} begin stage: {error:?}"));

            let mut previous_time = 0.0;
            for step_index in 0..3 {
                let stats = backend.step(1.0e-13).unwrap_or_else(|error| {
                    panic!("{integrator:?} trajectory step {step_index}: {error:?}")
                });
                assert!(
                    stats.time.is_finite() && stats.time > previous_time,
                    "{integrator:?} step {step_index}: {stats:?}"
                );
                previous_time = stats.time;
            }
            let telemetry = backend
                .stage_oersted_telemetry()
                .unwrap_or_else(|| panic!("{integrator:?} callback telemetry"));
            assert_eq!(telemetry["begin_count"], 3, "{integrator:?}");
            assert_eq!(telemetry["commit_count"], 3, "{integrator:?}");
            assert!(
                telemetry["evaluate_count"]
                    .as_u64()
                    .is_some_and(|count| count >= 6),
                "{integrator:?}: {telemetry}"
            );
            assert!(
                telemetry["accepted_observation"]["field_sha256"]
                    .as_str()
                    .is_some_and(|digest| digest.starts_with("sha256:")),
                "{integrator:?}: {telemetry}"
            );
        }
    }
}
