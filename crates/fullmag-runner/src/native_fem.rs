//! Safe Rust wrapper around the native MFEM/libCEED FEM backend scaffold.
//!
//! Current stage:
//! - stable C ABI and Rust wrapper
//! - availability probing
//! - native MFEM/libCEED/hypre time-domain FEM execution
//! - mesh-native Poisson demag on shared-domain meshes with air

#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;

mod availability;
mod eigen;
mod frequency_domain;
mod plan;
#[cfg(feature = "fem-gpu")]
mod runtime_info;
#[allow(unused_imports)]
pub(crate) use availability::{
    is_cpu_available, is_gpu_available, native_availability, native_frequency_domain_availability,
    FrequencyDomainAvailability, FrequencyDomainAvailabilityRequest,
    FrequencyDomainPhaseConvention, FrequencyDomainStudyKind, FrequencyDomainSweepProgress,
    GpuAvailability,
};
#[allow(unused_imports)]
pub(crate) use eigen::{gpu_eigen_dense_solve, GpuEigenResult};
#[allow(unused_imports)]
pub(crate) use frequency_domain::{
    solve_native_driven_frequency_response, solve_native_driven_response_contract,
    solve_native_modal_eigen, NativeDrivenFrequencyResponseDmiElement,
    NativeDrivenFrequencyResponseDmiKind, NativeDrivenFrequencyResponseExchangeEdge,
    NativeDrivenFrequencyResponseFloquetPeriodicPair,
    NativeDrivenFrequencyResponseMfemOperatorProblem,
    NativeDrivenFrequencyResponsePeriodicAirboxCoupledBlockProblem,
    NativeDrivenFrequencyResponsePeriodicNodePair, NativeDrivenFrequencyResponseRequest,
    NativeDrivenFrequencyResponseResult, NativeDrivenFrequencyResponseTinyValidationProblem,
    NativeDrivenResponseContractRequest, NativeFrequencyDomainCancelCallback,
    NativeFrequencyDomainContractResult, NativeFrequencyDomainExecutionLane,
    NativeFrequencyDomainProgress, NativeFrequencyDomainProgressCallback,
    NativeFrequencyDomainStatus, NativeModalEigenCsrMatrixView,
    NativeModalEigenFloquetPeriodicPair, NativeModalEigenMfemOperatorProblem,
    NativeModalEigenRequest, NativeModalEigenSparseOperatorProblem,
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
    stage_completion_from_ffi, DeviceInfo, NativeFemDataResidency, NativeFemGpuRkPlanInfo,
    NativeFemGpuStateInfo,
};

#[cfg(feature = "fem-gpu")]
use crate::preview::{
    build_mesh_preview_field_with_active_mask, build_mesh_scalar_preview_field_with_active_mask,
    mesh_quantity_active_mask,
};
#[cfg(feature = "fem-gpu")]
use crate::quantities::{normalize_quantity_id, QuantityId};
#[cfg(feature = "fem-gpu")]
use crate::scalar_metrics::{single_object_scalars, weighted_object_scalars};
#[cfg(feature = "fem-gpu")]
use crate::types::{LivePreviewField, LivePreviewRequest, RunError, StepStats};
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
use std::collections::{BTreeSet, HashMap};
#[cfg(feature = "fem-gpu")]
use std::ffi::c_void;
#[cfg(feature = "fem-gpu")]
use std::ffi::CStr;
#[cfg(feature = "fem-gpu")]
use std::io::Write;
#[cfg(feature = "fem-gpu")]
use std::path::{Path, PathBuf};
#[cfg(feature = "fem-gpu")]
use std::ptr;
#[cfg(feature = "fem-gpu")]
use std::sync::atomic::{AtomicBool, Ordering};

// ── Fallback defaults when air_box_config is absent (FEM-040) ────────────
#[cfg(feature = "fem-gpu")]
const FALLBACK_POISSON_BOUNDARY_MARKER: i32 = 99;
#[cfg(feature = "fem-gpu")]
const FALLBACK_ROBIN_BETA_FACTOR: f64 = 2.0;

#[cfg(feature = "fem-gpu")]
fn optional_slice_ptr<T>(slice: &[T]) -> *const T {
    if slice.is_empty() {
        std::ptr::null()
    } else {
        slice.as_ptr()
    }
}

#[cfg(feature = "fem-gpu")]
fn resolve_native_fem_plan_dt_seconds(plan: &fullmag_ir::FemPlanIR) -> Result<f64, RunError> {
    if let Some(dt) =
        crate::resolve_initial_timestep(plan.fixed_timestep, plan.adaptive_timestep.as_ref())
    {
        return Ok(dt);
    }
    if plan
        .relaxation
        .as_ref()
        .is_some_and(|control| crate::fem::relax::algorithm::is_direct_minimizer(control.algorithm))
    {
        return Ok(crate::DEFAULT_ADAPTIVE_DT_INITIAL);
    }
    Err(RunError {
        message: "native FEM: no fixed_timestep or adaptive_timestep specified".to_string(),
    })
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

    let element_count = plan.mesh.elements.len();
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

#[cfg(feature = "fem-gpu")]
fn fem_preview_observable(quantity: &str) -> Result<ffi::fullmag_fem_observable, RunError> {
    Ok(match normalize_quantity_id(quantity)? {
        QuantityId::HEx => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EX,
        QuantityId::HDemag => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DEMAG,
        QuantityId::DemagPhi => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_DEMAG_PHI,
        QuantityId::HExt => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EXT,
        QuantityId::HEff => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EFF,
        QuantityId::Torque => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_TORQUE,
        QuantityId::HAni => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI,
        QuantityId::HDmi => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI,
        QuantityId::HMel => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_MEL,
        QuantityId::HAniCubic => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI_CUBIC,
        QuantityId::HDmiBulk => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI_BULK,
        QuantityId::HOe => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_OE,
        QuantityId::HTherm => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_THERM,
        QuantityId::M => ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_M,
        other => {
            return Err(RunError {
                message: format!(
                    "native FEM preview quantity '{}' is not supported",
                    other.as_str()
                ),
            });
        }
    })
}

#[cfg(feature = "fem-gpu")]
pub(crate) struct NativeFemBackend {
    handle: *mut ffi::fullmag_fem_backend,
    magnetic_node_mask: Vec<bool>,
    saturation_magnetisation: f64,
    energy_density_terms: NativeFemEnergyDensityTerms,
    object_weights: Vec<(String, f64)>,
    object_node_indices: Vec<(String, Vec<u32>)>,
    demag_solver: Option<String>,
    demag_preconditioner: Option<String>,
}

#[cfg(feature = "fem-gpu")]
#[derive(Debug, Clone, Copy)]
struct NativeFemEnergyDensityTerms {
    exchange: bool,
    demag: bool,
    external: bool,
    anisotropy: bool,
    dmi: bool,
}

#[cfg(feature = "fem-gpu")]
impl NativeFemEnergyDensityTerms {
    fn from_plan(plan: &fullmag_ir::FemPlanIR) -> Self {
        Self {
            exchange: plan.enable_exchange,
            demag: plan.enable_demag,
            external: plan.external_field.is_some(),
            anisotropy: native_fem_plan_has_anisotropy(plan),
            dmi: native_fem_plan_has_dmi(plan),
        }
    }
}

#[cfg(feature = "fem-gpu")]
fn native_fem_plan_has_anisotropy(plan: &fullmag_ir::FemPlanIR) -> bool {
    plan.material.uniaxial_anisotropy.is_some()
        || plan.material.uniaxial_anisotropy_k2.is_some()
        || plan.material.cubic_anisotropy_kc1.is_some()
        || plan.material.cubic_anisotropy_kc2.is_some()
        || plan.material.cubic_anisotropy_kc3.is_some()
}

#[cfg(feature = "fem-gpu")]
fn native_fem_plan_has_dmi(plan: &fullmag_ir::FemPlanIR) -> bool {
    plan.interfacial_dmi.is_some()
        || plan.bulk_dmi.is_some()
        || plan
            .dind_field
            .as_ref()
            .is_some_and(|values| !values.is_empty())
        || plan
            .dbulk_field
            .as_ref()
            .is_some_and(|values| !values.is_empty())
}

#[cfg(feature = "fem-gpu")]
#[derive(Debug)]
pub(crate) struct NativeFemPreviewSnapshot {
    handle: *mut ffi::fullmag_fem_preview_snapshot,
    request: LivePreviewRequest,
    active_mask: Option<Vec<bool>>,
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

#[cfg(feature = "fem-gpu")]
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

#[cfg(feature = "fem-gpu")]
fn set_env_if_missing(key: &str, value: impl AsRef<std::ffi::OsStr>) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

#[cfg(feature = "fem-gpu")]
fn configure_openmpi_loopback_oob_if_missing() {
    set_env_if_missing("OMPI_MCA_oob", "tcp");
    if std::env::var_os("OMPI_MCA_oob_tcp_if_include").is_none()
        && std::env::var_os("OMPI_MCA_oob_tcp_if_exclude").is_none()
    {
        std::env::set_var("OMPI_MCA_oob_tcp_if_include", "lo");
    }
}

#[cfg(feature = "fem-gpu")]
fn configure_pmix_loopback_ptl_if_missing() {
    if std::env::var_os("PMIX_MCA_ptl_tcp_if_include").is_none()
        && std::env::var_os("PMIX_MCA_ptl_tcp_if_exclude").is_none()
    {
        std::env::set_var("PMIX_MCA_ptl_tcp_if_include", "lo");
    }
}

#[cfg(feature = "fem-gpu")]
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
            element_markers: optional_slice_ptr(&plan.mesh.element_markers),
            boundary_faces: optional_slice_ptr(&boundary_flat),
            n_boundary_faces: plan.mesh.boundary_faces.len() as u32,
            boundary_markers: optional_slice_ptr(&plan.mesh.boundary_markers),
            periodic_node_pairs: optional_slice_ptr(&periodic_pairs_flat),
            n_periodic_node_pairs: plan.mesh.periodic_node_pairs.len() as u32,
            periodic_boundary_pair_markers: optional_slice_ptr(
                &periodic_boundary_pair_markers_flat,
            ),
            periodic_boundary_pair_count: plan.mesh.periodic_boundary_pairs.len() as u32,
        };

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

        let demag_policy = plan
            .enable_demag
            .then(|| resolved_native_fem_demag_solver_policy(plan));

        Ok(Self {
            handle,
            magnetic_node_mask: mesh_quantity_active_mask("m", &plan.mesh)
                .unwrap_or_else(|| vec![true; plan.mesh.nodes.len()]),
            saturation_magnetisation: plan.material.saturation_magnetisation,
            energy_density_terms: NativeFemEnergyDensityTerms::from_plan(plan),
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
        })
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
            cpu_thread_cap_reason: 0,
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

        let relaxation_subphase_wall_time_ns = relaxation_driver_subphase_wall_time_ns(&stats);
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
            wall_time_ns: stats.wall_time_ns.max(ffi_wall_time_ns),
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
        self.apply_demag_solver_policy_to_step_stats(&mut step_stats);
        self.attach_transfer_audit(&mut step_stats)?;
        step_stats.per_object_scalars =
            if self.object_weights.len() == 1 && self.object_weights[0].0 == "free" {
                single_object_scalars("free", &step_stats)
            } else {
                weighted_object_scalars(&step_stats, &self.object_weights)
            };
        self.attach_native_object_average_m(&mut step_stats)?;
        Ok(Some(step_stats))
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
            cpu_thread_cap_reason: 0,
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

        let relaxation_subphase_wall_time_ns = relaxation_driver_subphase_wall_time_ns(&stats);
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
            wall_time_ns: stats.wall_time_ns.max(ffi_wall_time_ns),
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
        self.apply_demag_solver_policy_to_step_stats(&mut step_stats);
        self.attach_transfer_audit(&mut step_stats)?;
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
            cpu_thread_cap_reason: 0,
        };

        let rc = unsafe { ffi::fullmag_fem_backend_snapshot_stats(self.handle, &mut stats) };
        if rc != ffi::FULLMAG_FEM_OK {
            return Err(self.last_error_or("FEM GPU snapshot_step_stats failed"));
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
        self.apply_demag_solver_policy_to_step_stats(&mut step_stats);
        self.attach_transfer_audit(&mut step_stats)?;
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
        })
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
        if let Some(values) = self.copy_energy_density_values(&request.quantity, node_count)? {
            return Ok(build_mesh_scalar_preview_field_with_active_mask(
                request,
                &values,
                Some(self.magnetic_node_mask.clone()),
            ));
        }
        let values = self.copy_field(fem_preview_observable(&request.quantity)?, node_count)?;
        let active_mask = (crate::quantities::quantity_spatial_domain(&request.quantity)
            == "magnetic_only")
            .then(|| self.magnetic_node_mask.clone());
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
        let values = match quantity {
            "eden_ex" => self.copy_field_energy_density(
                ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EX,
                node_count,
                -0.5,
            )?,
            "eden_demag" => self.copy_field_energy_density(
                ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DEMAG,
                node_count,
                -0.5,
            )?,
            "eden_ext" => self.copy_field_energy_density(
                ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EXT,
                node_count,
                -1.0,
            )?,
            "eden_ani" => self.copy_field_energy_density(
                ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_ANI,
                node_count,
                -0.5,
            )?,
            "eden_dmi" => {
                let mut values = self.copy_field_energy_density(
                    ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI,
                    node_count,
                    -0.5,
                )?;
                let bulk = self.copy_field_energy_density(
                    ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DMI_BULK,
                    node_count,
                    -0.5,
                )?;
                for (value, bulk_value) in values.iter_mut().zip(bulk) {
                    *value += bulk_value;
                }
                values
            }
            "eden_total" => {
                let mut total = vec![0.0; node_count];
                let terms = [
                    (self.energy_density_terms.exchange, "eden_ex"),
                    (self.energy_density_terms.demag, "eden_demag"),
                    (self.energy_density_terms.external, "eden_ext"),
                    (self.energy_density_terms.anisotropy, "eden_ani"),
                    (self.energy_density_terms.dmi, "eden_dmi"),
                ];
                for (_, term) in terms.into_iter().filter(|(enabled, _)| *enabled) {
                    if let Some(values) = self.copy_energy_density_values(term, node_count)? {
                        for (accum, value) in total.iter_mut().zip(values) {
                            *accum += value;
                        }
                    }
                }
                total
            }
            _ => return Ok(None),
        };
        Ok(Some(values))
    }

    fn copy_field_energy_density(
        &self,
        observable: ffi::fullmag_fem_observable,
        node_count: usize,
        prefactor: f64,
    ) -> Result<Vec<f64>, RunError> {
        let magnetization = self.copy_field(
            ffi::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_M,
            node_count,
        )?;
        let field = self.copy_field(observable, node_count)?;
        Ok(magnetization
            .iter()
            .zip(field.iter())
            .enumerate()
            .map(|(index, (m, h))| {
                if !self.magnetic_node_mask.get(index).copied().unwrap_or(true) {
                    0.0
                } else {
                    prefactor * MU0 * self.saturation_magnetisation * dot(*m, *h)
                }
            })
            .collect())
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
        Ok(stage_completion_from_ffi(completion))
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
impl NativeFemPreviewSnapshot {
    pub(crate) fn is_ready(&self) -> bool {
        unsafe { ffi::fullmag_fem_preview_snapshot_ready(self.handle) != 0 }
    }

    pub fn into_live_preview_field(mut self) -> Result<LivePreviewField, RunError> {
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
            self.active_mask.take(),
        ))
    }
}

#[cfg(feature = "fem-gpu")]
impl NativeFemFieldSnapshot {
    pub(crate) fn is_ready(&self) -> bool {
        unsafe { ffi::fullmag_fem_field_snapshot_ready(self.handle) != 0 }
    }

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
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: false,
            external_field: Some([1.0, 2.0, 3.0]),
            antenna_zeeman_masks: Vec::new(),
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
                max_pseudotime_s: None,
                max_physical_time_s: None,
            },
        });

        assert_eq!(
            resolve_native_fem_plan_dt_seconds(&plan).expect("direct minimizer seed dt"),
            crate::DEFAULT_ADAPTIVE_DT_INITIAL
        );
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
        plan.mesh.elements = vec![[0, 1, 2, 3], [1, 2, 3, 4]];
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
                surface_faces: Vec::new(),
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
                surface_faces: Vec::new(),
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
        plan.mesh.elements = vec![[0, 1, 2, 3], [0, 1, 2, 4], [1, 2, 3, 4]];
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
        plan.mesh.elements = vec![[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]];
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
        plan.mesh.elements = vec![[0, 1, 2, 3], [0, 1, 2, 3], [0, 1, 2, 3]];
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
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
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
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
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
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
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
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
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
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
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
                Some("max_torque_Apm"),
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
                    max_pseudotime_s: None,
                    max_physical_time_s: None,
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
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
        plan.mesh.boundary_faces = vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
        plan.mesh.boundary_markers = vec![1, 1, 1, 1];
        plan.relaxation = Some(RelaxationControlIR {
            algorithm: RelaxationAlgorithmIR::TangentPlaneImplicit,
            stop: RelaxStopIR {
                torque_tolerance_apm: None,
                energy_tolerance_j: None,
                max_steps: Some(1),
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: false,
            external_field: Some([1.5e3, -2.0e3, 7.5e2]),
            antenna_zeeman_masks: Vec::new(),
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
        assert_eq!(cpu_plan.mesh.elements, gpu_plan.mesh.elements);
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
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
                max_pseudotime_s: None,
                max_physical_time_s: None,
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
    fn native_fem_demag_amg_profile_reads_recorded_env_overrides() {
        let cpu_source =
            include_str!("../../../backends/fem/cpu/mfem/interactions/demag_poisson_hypre.cpp");
        let gpu_source =
            include_str!("../../../backends/fem/gpu/cuda/demag_poisson/hypre_device_solver.cpp");
        for source in [cpu_source, gpu_source] {
            assert!(
                source.contains("FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE") &&
                    source.contains("demag_amg_int_env(\"FULLMAG_FEM_DEMAG_AMG_RELAX_TYPE\", 18)"),
                "native demag AMG profile must read the recorded relax_type env override with default"
            );
            assert!(
                source.contains("FULLMAG_FEM_DEMAG_AMG_COARSENING") &&
                    source.contains("demag_amg_int_env(\"FULLMAG_FEM_DEMAG_AMG_COARSENING\", 8)"),
                "native demag AMG profile must read the recorded coarsening env override with default"
            );
            assert!(
                source.contains("FULLMAG_FEM_DEMAG_AMG_INTERPOLATION") &&
                    source.contains("demag_amg_int_env(\"FULLMAG_FEM_DEMAG_AMG_INTERPOLATION\", 6)"),
                "native demag AMG profile must read the recorded interpolation env override with default"
            );
            assert!(
                source.contains("FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING") &&
                    source.contains(
                        "demag_amg_int_env(\"FULLMAG_FEM_DEMAG_AMG_AGGRESSIVE_COARSENING\", 1)"
                    ),
                "native demag AMG profile must read the recorded aggressive coarsening env override with default"
            );
            assert!(
                source.contains("FULLMAG_FEM_DEMAG_AMG_STRENGTH_THRESHOLD")
                    && source.contains("amg.SetStrengthThresh(strength_threshold)"),
                "native demag AMG profile must apply the optional strength threshold env override"
            );
            assert!(
                source.contains("FULLMAG_FEM_DEMAG_AMG_MAX_LEVELS")
                    && source.contains("amg.SetMaxLevels(max_levels)"),
                "native demag AMG profile must apply the optional max-levels env override"
            );
        }
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
            .find("if (final_stage_cache_valid) {\n        max_rhs_final = max_norm_aos(ws.k[0]);")
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
