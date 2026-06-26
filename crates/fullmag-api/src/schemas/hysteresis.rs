use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use utoipa::ToSchema;

fn default_magnetization_average_weighting() -> String {
    "uniform_sample_average".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisPointSchema {
    pub point_id: usize,
    #[serde(rename = "field_value_mT")]
    pub field_value_m_t: f64,
    pub m_parallel: f64,
    pub m_oop: f64,
    pub m_ip: f64,
    pub m_avg: [f64; 3],
    pub status: String,
    pub run_status: Option<String>,
    pub settle_status: Option<String>,
    pub has_non_converged_steps: Option<bool>,
    pub terminal_settle_reason: Option<String>,
    pub warning_count: Option<u32>,
    pub snapshot_id: Option<String>,
    pub protocol_role: Option<String>,
    pub branch_id: Option<String>,
    pub branch_ids: Option<Vec<String>>,
    pub branch_index: Option<u32>,
    pub parent_branch_id: Option<String>,
    pub minor_loop_id: Option<String>,
    pub snapshot_resource_ref: Option<String>,
    pub snapshot_vector_resource_ref: Option<String>,
    pub snapshot_json_artifact_ref: Option<String>,
    pub snapshot_zarr_store_ref: Option<String>,
    pub snapshot_storage_format: Option<String>,
    pub snapshot_storage_status: Option<String>,
    pub snapshot_storage_reason: Option<String>,
    #[serde(rename = "field_vector_A_per_m")]
    pub field_vector_a_per_m: Option<[f64; 3]>,
    pub field_orientation: Option<Value>,
    pub measurement_axis: Option<Value>,
    pub field_display_unit: Option<String>,
    pub is_reversal_field: Option<bool>,
    pub reversal_index: Option<u32>,
    pub recoil_start_point_id: Option<usize>,
    pub adaptive_inserted: Option<bool>,
    pub refinement_reason: Option<Vec<String>>,
    pub refinement_parent_left_point_id: Option<usize>,
    pub refinement_parent_right_point_id: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisPointsResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub points: Vec<HysteresisPointSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisBranchSchema {
    pub branch_id: String,
    pub branch_index: u32,
    pub branch_role: String,
    pub direction: i32,
    pub point_count: u32,
    pub start_point_id: usize,
    pub end_point_id: usize,
    #[serde(rename = "start_field_mT")]
    pub start_field_m_t: f64,
    #[serde(rename = "end_field_mT")]
    pub end_field_m_t: f64,
    pub parent_branch_id: Option<String>,
    pub minor_loop_id: Option<String>,
    pub points: Vec<HysteresisPointSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisBranchesResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub branches: Vec<HysteresisBranchSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisAngularFamilyResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub family_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_variant_id: Option<String>,
    pub series: Vec<HysteresisAngularFamilySeriesSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisAngularFamilySeriesSchema {
    pub variant_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub orientation: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measurement_axis: Option<Value>,
    pub data_status: String,
    pub point_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<HysteresisMetricsSchema>,
    pub points: Vec<HysteresisPointSchema>,
    pub points_resource_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisMinorLoopSchema {
    pub loop_id: String,
    #[serde(rename = "reversal_field_mT")]
    pub reversal_field_m_t: f64,
    #[serde(rename = "return_field_mT")]
    pub return_field_m_t: f64,
    pub parent_branch_id: Option<String>,
    pub reversal_point_id: Option<usize>,
    pub return_point_id: Option<usize>,
    pub policy: Option<String>,
    pub closure_status: Option<String>,
    pub closure_error_m_parallel: Option<f64>,
    pub recoil_susceptibility: Option<f64>,
    pub minor_loop_area: Option<f64>,
    #[serde(default)]
    pub settle_trace: Vec<HysteresisSettleTraceEntrySchema>,
    pub points: Vec<HysteresisPointSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisMinorLoopsResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub minor_loops: Vec<HysteresisMinorLoopSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisSettleTraceEntrySchema {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_id: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_role: Option<String>,
    #[serde(rename = "field_value_mT")]
    pub field_value_m_t: f64,
    pub step_index: usize,
    pub algorithm_id: String,
    pub method: String,
    pub status: String,
    pub stop_reason: Option<String>,
    pub metric_name: Option<String>,
    pub metric_value: Option<f64>,
    pub threshold: Option<f64>,
    pub fallback_reason: Option<String>,
    pub retry_attempt: u32,
    pub resolved_timestep_s: Option<f64>,
    pub resolved_parameters: Option<Value>,
    pub torque: Option<f64>,
    pub energy: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisSettleTraceResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub settle_trace: Vec<HysteresisSettleTraceEntrySchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisMetricsSchema {
    #[serde(rename = "H_c_plus")]
    pub h_c_plus: Option<f64>,
    #[serde(rename = "H_c_minus")]
    pub h_c_minus: Option<f64>,
    #[serde(rename = "H_c")]
    pub h_c: Option<f64>,
    #[serde(rename = "H_eb")]
    pub h_eb: Option<f64>,
    #[serde(rename = "M_r_plus")]
    pub m_r_plus: Option<f64>,
    #[serde(rename = "M_r_minus")]
    pub m_r_minus: Option<f64>,
    pub loop_area: f64,
    #[serde(default = "default_magnetization_average_weighting")]
    pub magnetization_average_weighting: String,
    pub saturation_status: String,
    #[serde(rename = "saturation_preparation_field_mT")]
    pub saturation_preparation_field_m_t: Option<f64>,
    #[serde(default)]
    pub metric_statuses: BTreeMap<String, HysteresisMetricStatusSchema>,
    #[serde(default)]
    pub loop_closure_summary: Option<HysteresisLoopClosureSummarySchema>,
    pub max_differential_susceptibility: Option<f64>,
    #[serde(default)]
    pub switching_field_candidates: Vec<HysteresisSwitchingFieldCandidateSchema>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub convergence_quality_summary: Option<HysteresisConvergenceQualitySummarySchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisMetricsResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub metrics: HysteresisMetricsSchema,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisMetricStatusSchema {
    pub status: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisLoopClosureSummarySchema {
    pub status: String,
    #[serde(rename = "field_gap_mT")]
    pub field_gap_m_t: f64,
    pub m_parallel_gap: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisSwitchingFieldCandidateSchema {
    #[serde(rename = "field_value_mT")]
    pub field_value_m_t: f64,
    #[serde(rename = "susceptibility_per_mT")]
    pub susceptibility_per_m_t: f64,
    pub point_id_before: usize,
    pub point_id_after: usize,
    pub branch_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisConvergenceQualitySummarySchema {
    pub status: String,
    pub total_points: usize,
    pub converged_points: usize,
    pub warning_points: usize,
    pub non_converged_points: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisAdaptiveRefinementSchema {
    pub kind: String,
    pub status: String,
    pub enabled: bool,
    pub source_point_count: usize,
    pub max_passes: u32,
    pub max_insertions_per_pass: u32,
    #[serde(default)]
    pub candidates: Vec<HysteresisAdaptiveRefinementCandidateSchema>,
    #[serde(default)]
    pub points: Vec<HysteresisPointSchema>,
    #[serde(default)]
    pub settle_trace: Vec<HysteresisSettleTraceEntrySchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisAdaptiveRefinementResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub adaptive_refinement: HysteresisAdaptiveRefinementSchema,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisAdaptiveRefinementCandidateSchema {
    pub candidate_id: String,
    pub pass_index: u32,
    #[serde(rename = "field_value_mT")]
    pub field_value_m_t: f64,
    pub parent_left_point_id: usize,
    pub parent_right_point_id: usize,
    #[serde(rename = "parent_left_field_mT")]
    pub parent_left_field_m_t: f64,
    #[serde(rename = "parent_right_field_mT")]
    pub parent_right_field_m_t: f64,
    #[serde(rename = "dm_dh_per_mT")]
    pub dm_dh_per_m_t: f64,
    pub reasons: Vec<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisSaturationProbePointSchema {
    pub probe_index: usize,
    #[serde(rename = "field_value_mT")]
    pub field_value_m_t: f64,
    pub m_parallel: f64,
    pub m_transverse: f64,
    pub torque: Option<f64>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisSaturationResultSchema {
    pub status: String,
    pub reason: String,
    pub direction: i32,
    #[serde(rename = "max_probe_field_mT")]
    pub max_probe_field_m_t: f64,
    #[serde(rename = "preparation_field_mT")]
    pub preparation_field_m_t: Option<f64>,
    pub susceptibility_threshold: f64,
    pub transverse_threshold: f64,
    pub points: Vec<HysteresisSaturationProbePointSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisSaturationResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub saturation: HysteresisSaturationResultSchema,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisReversalFieldsResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub reversal_fields: Vec<HysteresisPointSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisStageSaturationSchema {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested: Option<Value>,
    pub result_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<HysteresisSaturationResultSchema>,
    pub analysis_resource_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisProgressSchema {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_kind: Option<String>,
    pub status: String,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_points: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_points: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_point_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_points: Option<u32>,
    #[serde(rename = "current_field_mT", skip_serializing_if = "Option::is_none")]
    pub current_field_m_t: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_point_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_settle_step_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_settle_step_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_settle_step_method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_m_avg: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_m_parallel: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisStorageEstimateSchema {
    pub policy: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_count: Option<u64>,
    pub components_per_site: u32,
    pub bytes_per_component: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_bytes: Option<u64>,
    pub status: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisFieldUnitProvenanceSchema {
    pub authored_quantity: String,
    pub authored_unit: String,
    pub canonical_quantity: String,
    pub canonical_unit: String,
    pub display_unit: String,
    pub mu0_h_per_m: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisStagePlanSchema {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    #[serde(rename = "field_min_mT", skip_serializing_if = "Option::is_none")]
    pub field_min_m_t: Option<f64>,
    #[serde(rename = "field_max_mT", skip_serializing_if = "Option::is_none")]
    pub field_max_m_t: Option<f64>,
    #[serde(rename = "field_step_mT", skip_serializing_if = "Option::is_none")]
    pub field_step_m_t: Option<f64>,
    #[serde(rename = "field_values_mT", skip_serializing_if = "Option::is_none")]
    pub field_values_m_t: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_unit_provenance: Option<HysteresisFieldUnitProvenanceSchema>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_schedule: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule_refinements: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angular_family: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adaptive_refinement: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minor_loops: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_estimate: Option<HysteresisStorageEstimateSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisProtocolSchema {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saturation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisOrientationSchema {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orientation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measurement_axis: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisSettlePipelineSchema {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settle_pipeline: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolved_steps: Vec<HysteresisResolvedSettleStepSchema>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resolved_branch_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisResolvedSettleStepSchema {
    pub step_index: u32,
    pub step_id: String,
    pub kind: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applies_to: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_non_convergence: Option<String>,
    pub resolved_parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisBookmarkPointRequest {
    pub point_id: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisBookmarkSchema {
    pub bookmark_id: String,
    pub stage_id: String,
    pub point_id: u32,
    pub label: String,
    pub resource_ref: String,
    pub selection_ref: String,
    pub created_at_unix_ms: String,
    #[serde(rename = "field_value_mT")]
    pub field_value_m_t: f64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot_resource_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_orientation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measurement_axis: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisBookmarksResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub bookmarks: Vec<HysteresisBookmarkSchema>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisExecutionTreeResource {
    pub revision: u64,
    pub stage_id: String,
    pub stage_index: u32,
    pub window: String,
    pub before: u32,
    pub after: u32,
    pub include_bookmarks: bool,
    pub include_warnings: bool,
    pub include_snapshots: bool,
    pub total_points: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_point_index: Option<u32>,
    pub nodes: Vec<HysteresisExecutionTreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HysteresisExecutionTreeNode {
    pub node_id: String,
    pub kind: String,
    pub stage_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settle_step_id: Option<String>,
    pub status: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_orientation: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measurement_axis: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_revision: Option<u64>,
    pub updated_revision: u64,
    #[schema(no_recursion)]
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<HysteresisExecutionTreeNode>,
}
