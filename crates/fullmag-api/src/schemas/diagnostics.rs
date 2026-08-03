use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SolverProfileTimingSemanticKindResource {
    Exclusive,
    Inclusive,
    Overlapped,
    EnqueueOnly,
    DeviceElapsed,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct SolverProfileTimingSemanticResource {
    pub id: String,
    pub kind: SolverProfileTimingSemanticKindResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverTraceIdResource {
    pub value: String,
    pub run_generation: String,
    pub stage_sequence: u64,
    pub accepted_step: u64,
    pub sample_sequence: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SolverTraceClockDomainResource {
    ServerMonotonic,
    BrowserPerformance,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SolverTraceSegmentKindResource {
    NativeToRunnerCallback,
    RunnerCallbackToPublisherEnqueue,
    PublisherQueue,
    PublisherApply,
    ApiRevisionVisibility,
    BrowserFetch,
    BrowserDecodeToCommit,
    CommitToAnimationFrame,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverTraceSegmentResource {
    pub kind: SolverTraceSegmentKindResource,
    pub duration_ns: u64,
    pub clock_domain: SolverTraceClockDomainResource,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SolverTraceCompletenessResource {
    ServerOnly,
    Complete,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverTraceResource {
    pub format: String,
    pub trace_id: SolverTraceIdResource,
    pub segments: BTreeMap<String, SolverTraceSegmentResource>,
    pub api_revision: Option<u64>,
    pub completeness: SolverTraceCompletenessResource,
    pub unaccounted_server_ns: u64,
    pub unaccounted_browser_ns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SolverProfileStepSampleResource {
    pub step: u64,
    #[serde(default)]
    pub sample_time_unix_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trace: Option<SolverTraceResource>,
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
    #[serde(default)]
    pub timing_semantics: Vec<SolverProfileTimingSemanticResource>,
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
    #[serde(default)]
    pub rk_transaction_capture_host_wall_time_ns: u64,
    #[serde(default)]
    pub rk_transaction_capture_device_elapsed_time_ns: u64,
    #[serde(default)]
    pub rk_transaction_capture_bytes: u64,
    #[serde(default)]
    pub rk_transaction_restore_host_wall_time_ns: u64,
    #[serde(default)]
    pub rk_transaction_restore_device_elapsed_time_ns: u64,
    #[serde(default)]
    pub rk_transaction_restore_bytes: u64,
    #[serde(default)]
    pub rk_transaction_rollback_count: u64,
    #[serde(default)]
    pub rk_transaction_commit_count: u64,
    #[serde(default)]
    pub demag_hypre_wait_in_enqueue_wall_time_ns: u64,
    #[serde(default)]
    pub demag_hypre_host_api_wall_time_ns: u64,
    #[serde(default)]
    pub demag_hypre_device_elapsed_time_ns: u64,
    #[serde(default)]
    pub demag_hypre_wait_out_enqueue_wall_time_ns: u64,
    #[serde(default)]
    pub demag_hypre_event_wait_count: u64,
    #[serde(default)]
    pub demag_hypre_timed_solve_count: u64,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestep_qualification: Option<TimestepQualificationResource>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimestepValidationStateResource {
    Unvalidated,
    AlgebraValidated,
    PhysicsValidated,
    ProductionQualified,
}

impl TimestepValidationStateResource {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Unvalidated => "unvalidated",
            Self::AlgebraValidated => "algebra_validated",
            Self::PhysicsValidated => "physics_validated",
            Self::ProductionQualified => "production_qualified",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct TimestepQualificationResource {
    pub capability_id: String,
    pub qualification_id: String,
    pub backend: String,
    pub device: String,
    pub precision: String,
    pub integrator: String,
    pub timestep_policy: String,
    pub validation_state: TimestepValidationStateResource,
    pub qualification_registry_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualification_artifact_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_source_inputs_sha256: Option<String>,
    #[schema(value_type = Object, nullable = true)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validated_scope: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualification_validated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualification_validator_schema: Option<String>,
}

impl Default for TimestepQualificationResource {
    fn default() -> Self {
        Self {
            capability_id: "llg_td_policy_v1".to_string(),
            qualification_id: "unknown".to_string(),
            backend: "unknown".to_string(),
            device: "unknown".to_string(),
            precision: "unknown".to_string(),
            integrator: "unknown".to_string(),
            timestep_policy: "unknown".to_string(),
            validation_state: TimestepValidationStateResource::Unvalidated,
            qualification_registry_version:
                "fullmag.llg_timestep_qualification_registry.v1".to_string(),
            qualification_artifact_sha256: None,
            runtime_source_inputs_sha256: None,
            validated_scope: None,
            qualification_validated_at: None,
            qualification_validator_schema: None,
        }
    }
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
            timestep_qualification: None,
        }
    }
}

#[cfg(test)]
mod compatibility_tests {
    use super::{
        SolverProfileResource, SolverProfileStepSampleResource,
        SolverTraceCompletenessResource, TimestepValidationStateResource,
    };

    #[test]
    fn timestep_validation_state_vocabulary_roundtrips_exactly() {
        for (state, expected) in [
            (TimestepValidationStateResource::Unvalidated, "unvalidated"),
            (
                TimestepValidationStateResource::AlgebraValidated,
                "algebra_validated",
            ),
            (
                TimestepValidationStateResource::PhysicsValidated,
                "physics_validated",
            ),
            (
                TimestepValidationStateResource::ProductionQualified,
                "production_qualified",
            ),
        ] {
            assert_eq!(serde_json::to_value(&state).unwrap(), expected);
        }
    }

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
            "timing_semantics",
            "rk_transaction_capture_host_wall_time_ns",
            "rk_transaction_capture_device_elapsed_time_ns",
            "rk_transaction_capture_bytes",
            "rk_transaction_restore_host_wall_time_ns",
            "rk_transaction_restore_device_elapsed_time_ns",
            "rk_transaction_restore_bytes",
            "rk_transaction_rollback_count",
            "rk_transaction_commit_count",
            "demag_hypre_wait_in_enqueue_wall_time_ns",
            "demag_hypre_host_api_wall_time_ns",
            "demag_hypre_device_elapsed_time_ns",
            "demag_hypre_wait_out_enqueue_wall_time_ns",
            "demag_hypre_event_wait_count",
            "demag_hypre_timed_solve_count",
            "step_update_deep_clone_count",
            "backend_create_wall_time_ns",
        ] {
            object.remove(key);
        }
        let decoded: SolverProfileStepSampleResource = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.span_step_count, 0);
        assert!(decoded.phase_windows.is_empty());
        assert!(decoded.timing_semantics.is_empty());
        assert_eq!(decoded.rk_transaction_capture_bytes, 0);
        assert_eq!(decoded.demag_hypre_timed_solve_count, 0);
        assert_eq!(decoded.step_update_deep_clone_count, 0);
        assert_eq!(decoded.backend_create_wall_time_ns, 0);
    }

    #[test]
    fn solver_profile_preserves_rk_and_hypre_timing_counters() {
        let mut stats = fullmag_runner::StepStats::default();
        stats.rk_transaction_capture_host_wall_time_ns = 11;
        stats.rk_transaction_capture_device_elapsed_time_ns = 12;
        stats.rk_transaction_capture_bytes = 13;
        stats.rk_transaction_restore_host_wall_time_ns = 14;
        stats.rk_transaction_restore_device_elapsed_time_ns = 15;
        stats.rk_transaction_restore_bytes = 16;
        stats.rk_transaction_rollback_count = 17;
        stats.rk_transaction_commit_count = 18;
        stats.demag_hypre_wait_in_enqueue_wall_time_ns = 21;
        stats.demag_hypre_host_api_wall_time_ns = 22;
        stats.demag_hypre_device_elapsed_time_ns = 23;
        stats.demag_hypre_wait_out_enqueue_wall_time_ns = 24;
        stats.demag_hypre_event_wait_count = 25;
        stats.demag_hypre_timed_solve_count = 26;

        let runner_sample = fullmag_runner::SolverProfileStepSample::from_step_stats(&stats);
        let value = serde_json::to_value(runner_sample).unwrap();
        let decoded: SolverProfileStepSampleResource = serde_json::from_value(value).unwrap();
        let encoded = serde_json::to_value(decoded).unwrap();

        for (key, expected) in [
            ("rk_transaction_capture_host_wall_time_ns", 11),
            ("rk_transaction_capture_device_elapsed_time_ns", 12),
            ("rk_transaction_capture_bytes", 13),
            ("rk_transaction_restore_host_wall_time_ns", 14),
            ("rk_transaction_restore_device_elapsed_time_ns", 15),
            ("rk_transaction_restore_bytes", 16),
            ("rk_transaction_rollback_count", 17),
            ("rk_transaction_commit_count", 18),
            ("demag_hypre_wait_in_enqueue_wall_time_ns", 21),
            ("demag_hypre_host_api_wall_time_ns", 22),
            ("demag_hypre_device_elapsed_time_ns", 23),
            ("demag_hypre_wait_out_enqueue_wall_time_ns", 24),
            ("demag_hypre_event_wait_count", 25),
            ("demag_hypre_timed_solve_count", 26),
        ] {
            assert_eq!(encoded[key], expected);
        }
        assert!(encoded["timing_semantics"].as_array().unwrap().iter().any(|entry| {
            entry["id"] == "demag_hypre_device_elapsed_time_ns"
                && entry["kind"] == "device_elapsed"
        }));
    }

    #[test]
    fn solver_trace_round_trips_through_the_profile_resource() {
        let mut runner_sample = fullmag_runner::SolverProfileStepSample::from_step_stats(
            &fullmag_runner::StepStats {
                step: 7,
                ..fullmag_runner::StepStats::default()
            },
        );
        runner_sample.trace = Some(fullmag_runner::SolverTrace::server_only(
            fullmag_runner::SolverTraceId::new("run-1", 2, 7, 1).unwrap(),
        ));
        let decoded: SolverProfileStepSampleResource =
            serde_json::from_value(serde_json::to_value(runner_sample).unwrap()).unwrap();

        let trace = decoded.trace.expect("trace should be exposed by the API resource");
        assert_eq!(trace.trace_id.value, "run-1:2:7:1");
        assert_eq!(trace.completeness, SolverTraceCompletenessResource::ServerOnly);
        assert!(trace.segments.is_empty());
    }
}

fn default_sample_every() -> u64 {
    1
}

fn default_max_samples() -> usize {
    128
}
