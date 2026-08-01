use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileCommandConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_sample_every")]
    pub sample_every: u64,
    #[serde(default)]
    pub sample_interval_wall_ms: u64,
    #[serde(default = "default_max_samples")]
    pub max_samples: usize,
    #[serde(default)]
    pub emit_engine_log: bool,
    #[serde(default)]
    pub persist_artifact: bool,
}

impl Default for SolverProfileCommandConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            sample_every: default_sample_every(),
            sample_interval_wall_ms: 0,
            max_samples: default_max_samples(),
            emit_engine_log: false,
            persist_artifact: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileThreadingResource {
    pub requested_omp_threads: i32,
    pub effective_omp_threads: i32,
    pub thread_mode: String,
    #[serde(default)]
    pub cap_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mfem_device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openmp_compiled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openmp_available: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfilePhaseResource {
    pub id: String,
    pub label: String,
    pub wall_time_ns: u64,
    pub percent_of_total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SolverProfileSampleKindResource {
    NormalStep,
    Publish,
    Preview,
    Finalization,
    Stall,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfilePhaseWindowResource {
    pub id: String,
    pub label: String,
    pub sum_wall_time_ns: u64,
    pub mean_wall_time_ns: u64,
    pub max_wall_time_ns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileStepSampleResource {
    pub step: u64,
    #[serde(default)]
    pub sample_time_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_wall_time_ns: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unprofiled_gap_wall_time_ns: Option<u64>,
    #[serde(default)]
    pub span_first_step: u64,
    #[serde(default)]
    pub span_last_step: u64,
    #[serde(default)]
    pub span_step_count: u64,
    #[serde(default)]
    pub span_monotonic_wall_time_ns: u64,
    #[serde(default)]
    pub profiled_step_total_ns: u64,
    #[serde(default)]
    pub native_solver_wall_time_ns: u64,
    #[serde(default)]
    pub unprofiled_gap_total_ns: u64,
    #[serde(default)]
    pub unprofiled_gap_per_step_ns: u64,
    #[serde(default)]
    pub sample_kinds: Vec<SolverProfileSampleKindResource>,
    #[serde(default)]
    pub phase_windows: Vec<SolverProfilePhaseWindowResource>,
    pub time: f64,
    pub dt: f64,
    pub total_ns: u64,
    #[serde(default)]
    pub backend_create_wall_time_ns: u64,
    pub phase_sum_ns: u64,
    pub missing_ns: u64,
    pub phases: Vec<SolverProfilePhaseResource>,
    pub demag_subphase_sum_ns: u64,
    pub demag_subphases: Vec<SolverProfilePhaseResource>,
    pub rhs_evaluations: u32,
    pub rejected_attempts: u32,
    pub demag_solves: u32,
    pub poisson_iterations: u32,
    pub poisson_final_residual: f64,
    #[serde(default)]
    pub demag_solver_setup_reused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_solver: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_preconditioner: Option<String>,
    #[serde(default)]
    pub field_copy_bytes: u64,
    #[serde(default)]
    pub artifact_enqueue_bytes: u64,
    #[serde(default)]
    pub artifact_queue_depth_max: u64,
    #[serde(default)]
    pub artifact_queue_depth_current: u64,
    #[serde(default)]
    pub artifact_writer_jobs_completed: u64,
    #[serde(default)]
    pub artifact_writer_job_wall_time_ns: u64,
    #[serde(default)]
    pub artifact_scalar_row_writer_wall_time_ns: u64,
    #[serde(default)]
    pub artifact_field_snapshot_writer_wall_time_ns: u64,
    #[serde(default)]
    pub artifact_native_field_snapshot_writer_wall_time_ns: u64,
    #[serde(default)]
    pub native_ffi_overhead_wall_time_ns: u64,
    #[serde(default)]
    pub finalization_wall_time_ns: u64,
    #[serde(default)]
    pub finalization_field_copy_wall_time_ns: u64,
    #[serde(default)]
    pub finalization_field_copy_bytes: u64,
    #[serde(default)]
    pub relaxation_state_copy_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_state_upload_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_retraction_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_gradient_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_metric_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_line_search_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_update_wall_time_ns: u64,
    #[serde(default)]
    pub hot_loop_h2d_bytes: u64,
    #[serde(default)]
    pub hot_loop_d2h_bytes: u64,
    #[serde(default)]
    pub hot_loop_host_sync_count: u64,
    #[serde(default)]
    pub hot_loop_control_scalar_d2h_bytes: u64,
    #[serde(default)]
    pub hot_loop_control_scalar_host_sync_count: u64,
    #[serde(default)]
    pub relaxation_preconditioner_cache_hits: u32,
    #[serde(default)]
    pub relaxation_preconditioner_cache_misses: u32,
    #[serde(default)]
    pub step_update_deep_clone_count: u64,
    pub threading: SolverProfileThreadingResource,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileOverheadDiagnosticsResource {
    pub last_record_wall_time_ns: u64,
    pub total_record_wall_time_ns: u64,
    pub last_persist_wall_time_ns: u64,
    pub total_persist_wall_time_ns: u64,
    #[serde(default)]
    pub persist_enqueued_count: u64,
    #[serde(default)]
    pub persist_completed_count: u64,
    pub last_publisher_replace_wall_time_ns: u64,
    pub total_publisher_replace_wall_time_ns: u64,
    #[serde(default)]
    pub heartbeat_seed_deep_clone_count: u64,
    #[serde(default)]
    pub heartbeat_worker_deep_clone_count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileAggregatesResource {
    pub sample_count: usize,
    pub average_total_ns: u64,
    pub max_total_ns: u64,
    pub average_exchange_ns: u64,
    pub average_demag_ns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RateMetricResource {
    pub value: f64,
    pub window_step_count: u64,
    pub window_wall_time_ns: u64,
    pub source_revision: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct SolverRateDiagnosticsResource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solver_steps_per_second: Option<RateMetricResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_to_end_steps_per_second: Option<RateMetricResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_steps_per_second: Option<RateMetricResource>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct LivePublisherDiagnosticsResource {
    pub replace_count: u64,
    pub publish_count: u64,
    pub coalesced_wake_count: u64,
    pub disconnected_wake_count: u64,
    pub last_payload_estimated_bytes: u64,
    pub max_payload_estimated_bytes: u64,
    pub last_replace_wall_time_ns: u64,
    pub max_replace_wall_time_ns: u64,
    pub total_replace_wall_time_ns: u64,
    pub last_merge_wall_time_ns: u64,
    pub max_merge_wall_time_ns: u64,
    pub total_merge_wall_time_ns: u64,
    pub last_clone_wall_time_ns: u64,
    pub max_clone_wall_time_ns: u64,
    pub total_clone_wall_time_ns: u64,
    pub last_publish_wall_time_ns: u64,
    pub max_publish_wall_time_ns: u64,
    pub total_publish_wall_time_ns: u64,
    pub last_publish_lag_wall_time_ns: u64,
    pub max_publish_lag_wall_time_ns: u64,
    pub total_publish_lag_wall_time_ns: u64,
    #[serde(default)]
    pub successful_publish_step_count: u64,
    #[serde(default)]
    pub successful_publish_window_wall_time_ns: u64,
    #[serde(default)]
    pub successful_publish_source_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileResource {
    pub revision: u64,
    pub state: String,
    pub config: SolverProfileCommandConfig,
    #[serde(default)]
    pub preview_3d_disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threading: Option<SolverProfileThreadingResource>,
    pub latest_samples: Vec<SolverProfileStepSampleResource>,
    pub aggregates: SolverProfileAggregatesResource,
    #[serde(default)]
    pub rates: SolverRateDiagnosticsResource,
    #[serde(default)]
    pub overhead: SolverProfileOverheadDiagnosticsResource,
    pub artifact_refs: Vec<String>,
    #[serde(default)]
    pub persistence_failed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_publisher: Option<LivePublisherDiagnosticsResource>,
}

impl Default for SolverProfileResource {
    fn default() -> Self {
        Self {
            revision: 0,
            state: "disabled".to_string(),
            config: SolverProfileCommandConfig::default(),
            preview_3d_disabled: false,
            threading: None,
            latest_samples: Vec::new(),
            aggregates: SolverProfileAggregatesResource::default(),
            rates: SolverRateDiagnosticsResource::default(),
            overhead: SolverProfileOverheadDiagnosticsResource::default(),
            artifact_refs: Vec::new(),
            persistence_failed: false,
            live_publisher: None,
        }
    }
}

#[cfg(test)]
mod compatibility_tests {
    use super::{SolverProfileResource, SolverProfileStepSampleResource};

    #[test]
    fn solver_profile_resource_serializes_persistence_failure_state() {
        let value = serde_json::to_value(SolverProfileResource::default()).unwrap();

        assert_eq!(value["persistence_failed"], false);
        assert_eq!(value["overhead"]["persist_enqueued_count"], 0);
        assert_eq!(value["overhead"]["persist_completed_count"], 0);
    }

    #[test]
    fn solver_profile_resource_round_trips_persistence_failure_state() {
        let mut value = serde_json::to_value(SolverProfileResource::default()).unwrap();
        value["persistence_failed"] = serde_json::Value::Bool(true);

        let decoded: SolverProfileResource = serde_json::from_value(value).unwrap();
        let encoded = serde_json::to_value(decoded).unwrap();

        assert_eq!(encoded["persistence_failed"], true);
    }

    #[test]
    fn older_cli_sample_defaults_additive_interval_and_clone_fields() {
        let runner_sample = fullmag_runner::SolverProfileStepSample::from_step_stats(
            &fullmag_runner::StepStats::default(),
        );
        let mut value = serde_json::to_value(runner_sample).unwrap();
        let object = value.as_object_mut().unwrap();
        for key in [
            "span_first_step",
            "span_last_step",
            "span_step_count",
            "span_monotonic_wall_time_ns",
            "profiled_step_total_ns",
            "native_solver_wall_time_ns",
            "unprofiled_gap_total_ns",
            "unprofiled_gap_per_step_ns",
            "sample_kinds",
            "phase_windows",
            "step_update_deep_clone_count",
            "backend_create_wall_time_ns",
        ] {
            object.remove(key);
        }
        let decoded: SolverProfileStepSampleResource = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.span_step_count, 0);
        assert!(decoded.phase_windows.is_empty());
        assert_eq!(decoded.step_update_deep_clone_count, 0);
        assert_eq!(decoded.backend_create_wall_time_ns, 0);
    }
}

fn default_sample_every() -> u64 {
    1
}

fn default_max_samples() -> usize {
    128
}
