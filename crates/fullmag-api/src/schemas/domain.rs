use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use utoipa::ToSchema;

use crate::field_slice::SlicePlane;
use crate::schemas::relaxation::{
    RelaxationAlgorithm, StageMetricKind, StageMetricUnit, StageStopReason,
};

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DomainMeta {
    pub domain_id: String,
    #[schema(example = "fem")]
    pub discretization: String,
    pub generation_id: String,
    pub dimension: u8,
    pub coordinate_system: String,
    pub units: HashMap<String, String>,
    /// Physical cell-edge bounds in meters. For structured FDM grids, `min`
    /// is the grid edge origin and `max` is `origin + shape * spacing`.
    /// Cell centers are offset by `spacing / 2` on non-zero axes.
    pub bounds: Bounds3,
    pub counts: DomainCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grid: Option<StructuredGridDescriptor>,
    pub element_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct Bounds3 {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DomainCounts {
    pub cells: Option<u64>,
    pub nodes: Option<u64>,
    pub elements: Option<u64>,
    pub boundary_faces: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StructuredGridDescriptor {
    pub shape: [u32; 3],
    /// Physical grid edge origin in meters. Cell centers are
    /// `origin + (i + 0.5) * spacing` on non-zero axes.
    pub origin: [f64; 3],
    pub spacing: [f64; 3],
}

/// Thin, revision-driven description of the native carriers used by an FDM
/// multilayer convolution.  The common transform layout is an FFT scratch
/// layout and must never be interpreted as a physical mesh.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FdmMultilayerLayoutResource {
    pub schema_version: String,
    pub domain_generation_id: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub backend: String,
    pub layout_revision: u64,
    pub observation_revision: u64,
    pub execution_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub common_transform_layout: Option<FdmCommonTransformLayoutResource>,
    pub layers: Vec<FdmLayerLayoutResource>,
    pub airbox: FdmMultilayerAirboxResource,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FdmCommonTransformLayoutResource {
    pub shape: [u32; 3],
    pub cell_size: [f64; 3],
    pub origin: [f64; 3],
    pub fft_shape: [u32; 3],
    pub is_physical_mesh: bool,
    pub provenance: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FdmLayerLayoutResource {
    pub layer_id: String,
    pub object_id: String,
    pub magnet_name: String,
    pub native_grid: [u32; 3],
    pub native_cell_size: [f64; 3],
    pub native_origin: [f64; 3],
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_grid_fingerprint: Option<String>,
    pub convolution_grid: [u32; 3],
    pub convolution_cell_size: [f64; 3],
    pub transfer_kind: String,
    pub active_mask_present: bool,
    pub active_cell_count: u64,
    pub inactive_cell_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_mask_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask_provenance: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FdmMultilayerAirboxResource {
    pub carrier_available: bool,
    pub h_demag_available: bool,
    pub h_eff_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub h_eff_unavailable_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cells: Option<[u32; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_m: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cell_size_m: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub carrier_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub carrier_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_grid_fingerprints: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_runtime_identity: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FemCpuRelaxationQualificationMetadata {
    pub schema_version: String,
    pub benchmark_gate_version: String,
    pub physics_terms: Vec<String>,
    pub solver_mesh_signature: String,
    pub demag_policy: FemCpuRelaxationDemagPolicyMetadata,
    pub assembly_mode: Option<String>,
    pub relaxation_algorithm: Option<RelaxationAlgorithm>,
    pub converged: bool,
    pub stop_reason: Option<StageStopReason>,
    pub stop_metric_kind: Option<StageMetricKind>,
    pub stop_metric_unit: Option<StageMetricUnit>,
    pub stop_metric_name: Option<String>,
    pub stop_metric_value: Option<f64>,
    pub stop_threshold: Option<f64>,
    pub final_energy_terms_j: FemCpuRelaxationEnergyTerms,
    pub final_torque_apm: f64,
    pub final_torque_t: f64,
    pub norm_defect: f64,
    pub executed_steps: u64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FemCpuRelaxationDemagPolicyMetadata {
    pub model: Option<String>,
    pub boundary_variant: Option<String>,
    pub linear_solver: Option<String>,
    pub preconditioner: Option<String>,
    pub relative_tolerance: Option<f64>,
    pub absolute_tolerance: Option<f64>,
    pub max_iterations: Option<u32>,
    pub print_level: Option<i32>,
    pub actual_iterations: Option<u32>,
    pub final_residual_norm: Option<f64>,
    pub solver_setup_reused: Option<bool>,
    pub timings_ns: Option<FemCpuRelaxationDemagTimingsNs>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FemCpuRelaxationDemagTimingsNs {
    pub assemble: u64,
    pub solve: u64,
    pub solver_setup: u64,
    pub solver_apply: u64,
    pub recover: u64,
    pub energy: u64,
    pub total: u64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[allow(non_snake_case)]
pub struct FemCpuRelaxationEnergyTerms {
    #[serde(rename = "E_ex")]
    pub e_ex: f64,
    #[serde(rename = "E_demag")]
    pub e_demag: f64,
    #[serde(rename = "E_ext")]
    pub e_ext: f64,
    #[serde(rename = "E_ani")]
    pub e_ani: f64,
    #[serde(rename = "E_dmi")]
    pub e_dmi: f64,
    #[serde(rename = "E_total")]
    pub e_total: f64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DomainSliceMeshOverlay {
    pub schema: String,
    pub plane: SlicePlane,
    pub cut_kind: String,
    pub cut_world: f64,
    pub cut_norm: f64,
    pub u_axis: String,
    pub v_axis: String,
    pub normal_axis: String,
    pub bounds: Bounds2,
    pub segments: Vec<DomainSliceMeshOverlaySegment>,
    pub truncated: bool,
    pub segment_count: usize,
    pub point_count: usize,
    pub topology_revision: u64,
    pub domain_generation_id: String,
    pub etag: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct Bounds2 {
    pub u_min: f64,
    pub u_max: f64,
    pub v_min: f64,
    pub v_max: f64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DomainSliceMeshOverlaySegment {
    pub a: [f64; 2],
    pub b: [f64; 2],
}
