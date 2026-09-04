//! Native FEM relaxation finalization.
//!
//! The execution loops own stepping. This module owns the post-loop relaxation
//! closure: final stats, cached-preview flush, scheduled field snapshots,
//! provenance refresh, and stage-completion projection.

use fullmag_ir::FemPlanIR;

use crate::artifact_pipeline::ArtifactRecorder;
use crate::dispatch::{apply_native_fem_runtime_contract, fem_poisson_demag_provenance, FemEngine};
use crate::fem::execution_receipt::{
    validate_strict_fem_gpu_execution_receipt, validate_strict_fem_gpu_execution_receipt_v2,
    validate_strict_fem_gpu_execution_receipt_v2_runtime,
    validate_strict_fem_gpu_performance_snapshot_v3,
};
use crate::native_fem::NativeFemBackend;
use crate::relaxation::{resolve_stage_completion, RelaxationCompletionMetrics};
use crate::schedules::{same_time, OutputSchedule};
use crate::types::{
    recomputed_fem_equilibrium_content_sha256, recomputed_fem_linearization_certificate_sha256,
    AuxiliaryArtifact, CertifiedFemEquilibriumFields, ExecutedRun, FemGpuTerminalOutcome,
    FieldSnapshot, LiveStepConsumer, RecomputedFemLinearizationCertificateV1, RunError, RunResult,
    RunStatus, StepStats, StepUpdate,
};

use super::preview::FemPreviewHandoff;
use super::scalars::ensure_fem_object_scalars;
use super::snapshots::copy_native_fem_field_snapshot;

const LINEARIZATION_FIELD_ABSOLUTE_TOLERANCE_A_PER_M: f64 = 1.0e-6;
const LINEARIZATION_FIELD_RELATIVE_TOLERANCE: f64 = 1.0e-8;
const LINEARIZATION_PHI_ABSOLUTE_TOLERANCE_A: f64 = 1.0e-12;

#[derive(Debug, Clone)]
struct NativeEquilibriumEvaluation {
    magnetization: Vec<[f64; 3]>,
    fields: CertifiedFemEquilibriumFields,
}

#[cfg(test)]
mod tests {
    use super::{
        completed_strict_gpu_performance_snapshot_artifact,
        completed_strict_gpu_v2_and_v3_artifacts, run_after_strict_receipt_gate,
        run_after_strict_receipt_v2_gate, sha256_hex, terminal_scheduled_field_actions,
    };
    use crate::schedules::OutputSchedule;
    use crate::types::{
        FemGpuAttemptModel, FemGpuControlPolicy, FemGpuExecutionClass, FemGpuExecutionKind,
        FemGpuExecutionReceipt, FemGpuExecutionReceiptV2, FemGpuPerformanceSnapshotV2,
        FemGpuPerformanceSnapshotV3, FemGpuRelaxationAlgorithm, FemGpuTerminalOutcome, RunStatus,
    };
    use fullmag_ir::FemPlanIR;

    fn schedule(name: &str, last_sampled_time: Option<f64>) -> OutputSchedule {
        OutputSchedule {
            name: name.to_string(),
            every_seconds: 1.0e-14,
            next_time: 2.0e-14,
            last_sampled_time,
        }
    }

    fn performance_snapshot() -> FemGpuPerformanceSnapshotV2 {
        FemGpuPerformanceSnapshotV2 {
            abi_version: 2,
            struct_size: 88,
            setup_count: 1,
            apply_count: 2,
            kernel_launch_count: 3,
            compute_fence_count: 0,
            snapshot_fence_count: 0,
            export_fence_count: 0,
            selected_sparse_kernel_id: 7,
            setup_wall_time_ns: 11,
            apply_wall_time_ns: 13,
            accepted_finalization_wall_time_ns: 17,
        }
    }

    #[test]
    fn terminal_actions_deduplicate_payload_but_retain_streaming_demag_diagnostics() {
        assert_eq!(
            terminal_scheduled_field_actions(&schedule("m", Some(2.0e-14)), 2.0e-14, true),
            (false, false)
        );
        assert_eq!(
            terminal_scheduled_field_actions(&schedule("H_demag", Some(2.0e-14)), 2.0e-14, true,),
            (false, true)
        );
        assert_eq!(
            terminal_scheduled_field_actions(&schedule("demag_phi", None), 2.0e-14, true),
            (true, true)
        );
        assert_eq!(
            terminal_scheduled_field_actions(&schedule("m", None), 2.0e-14, false),
            (true, false)
        );
    }

    #[test]
    fn invalid_strict_receipt_executes_zero_terminal_success_side_effects() {
        let receipt = FemGpuExecutionReceipt {
            requested: "strict_device".into(),
            resolved: "device_resident".into(),
            executed: "cuda_fem".into(),
            execution_class: FemGpuExecutionClass::DeviceResident,
            device_ordinal: 0,
            precision: "double".into(),
            integrator: "heun".into(),
            required_operator_mask: 0x3ff,
            resolved_device_operator_mask: 0x3ff,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: 0x3ff,
            executed_host_operator_mask: 1,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 1,
            rejected_attempt_count: 0,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
            accounting_valid: true,
        };
        let mut terminal_side_effects = 0;
        let result = run_after_strict_receipt_gate(&receipt, "strict_device", || {
            terminal_side_effects += 1;
        });
        assert!(result.is_err());
        assert_eq!(terminal_side_effects, 0);
    }

    #[test]
    fn native_fem_accepted_steps_reach_the_diagnostic_trace_boundary() {
        let direct = include_str!("direct_minimizer.rs");
        let llg = include_str!("llg_overdamped.rs");
        let finalize = include_str!("finalize.rs");

        assert!(direct.contains("artifacts.record_solver_step(&accepted_stats);"));
        assert!(llg.contains("artifacts.record_solver_step(&stats);"));
        assert!(finalize.contains("artifacts.take_solver_steps()"));
        assert!(finalize.contains("solver_diagnostic_trace_artifact(diagnostic_steps)"));
    }

    #[test]
    fn completed_strict_finalization_publishes_complete_v2_performance_artifact() {
        let artifact = completed_strict_gpu_performance_snapshot_artifact(
            RunStatus::Completed,
            Some("strict_device"),
            Some(performance_snapshot()),
        )
        .unwrap()
        .expect("completed strict run publishes performance evidence");
        assert_eq!(
            artifact.relative_path,
            "performance/fem_gpu_performance_snapshot.v2.json"
        );
        let document: serde_json::Value = serde_json::from_slice(&artifact.bytes).unwrap();
        assert_eq!(
            document["schema"],
            "fullmag.fem_gpu_performance_snapshot.v2"
        );
        assert_eq!(
            document["snapshot"],
            serde_json::to_value(performance_snapshot()).unwrap()
        );
    }

    #[test]
    fn noncompleted_or_nonstrict_finalization_never_publishes_performance_evidence() {
        for (status, request) in [
            (RunStatus::Paused, Some("strict_device")),
            (RunStatus::Cancelled, Some("strict_device")),
            (RunStatus::Failed, Some("strict_device")),
            (RunStatus::Completed, Some("gpu")),
            (RunStatus::Completed, None),
        ] {
            assert!(completed_strict_gpu_performance_snapshot_artifact(
                status,
                request,
                Some(performance_snapshot()),
            )
            .unwrap()
            .is_none());
        }
    }

    fn receipt_v2_fixture() -> FemGpuExecutionReceiptV2 {
        FemGpuExecutionReceiptV2 {
            requested: "strict_device".into(),
            resolved: "device_resident".into(),
            executed: "cuda_fem".into(),
            execution_class: FemGpuExecutionClass::DeviceResident,
            device_ordinal: 0,
            precision: "double".into(),
            integrator: "".into(),
            required_operator_mask: 0x3fff,
            resolved_device_operator_mask: 0x3fff,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: 0x3fff,
            executed_host_operator_mask: 0,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 5,
            rejected_attempt_count: 2,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
            execution_kind: FemGpuExecutionKind::DirectMinimizer,
            relaxation_algorithm: FemGpuRelaxationAlgorithm::NonlinearCg,
            attempt_model: FemGpuAttemptModel::OuterStepWithArmijoCandidates,
            control_policy: FemGpuControlPolicy::BoundedHostScalarControl,
            execution_generation_id: 42,
            terminal_outcome: FemGpuTerminalOutcome::CompletedAccepted,
            compute_closed: true,
            observation_closed: true,
            outer_attempt_count: 7,
            rejected_candidate_count: 2,
            failed_candidate_count: 0,
            stationary_observation_count: 1,
            cancelled_outer_attempt_count: 0,
            paused_outer_attempt_count: 0,
            refinement_evaluation_count: 3,
            allowed_transfer_mask: 0x7f,
            observed_transfer_mask: 0x25,
            transfer_violation_mask: 0,
            setup_h2d_bytes: 100,
            setup_d2h_bytes: 0,
            setup_host_sync_count: 1,
            compute_h2d_bytes: 0,
            compute_d2h_bytes: 0,
            compute_host_sync_count: 0,
            control_h2d_bytes: 0,
            control_d2h_bytes: 32,
            control_host_sync_count: 4,
            exchange_h2d_bytes: 0,
            exchange_d2h_bytes: 0,
            exchange_host_sync_count: 0,
            snapshot_h2d_bytes: 0,
            snapshot_d2h_bytes: 200,
            snapshot_host_sync_count: 2,
            export_h2d_bytes: 0,
            export_d2h_bytes: 0,
            export_host_sync_count: 0,
            initial_residency: 2,
            final_residency: 2,
            residency_transition_count: 0,
            residency_violation_count: 0,
            kernel_launch_coverage_mask: 0x7ff,
            required_coverage_mask: 0x7ff,
            unclassified_event_count: 0,
            accounting_valid: true,
            lifecycle_valid: true,
            identity_valid: true,
        }
    }

    fn snapshot_v3_fixture() -> FemGpuPerformanceSnapshotV3 {
        FemGpuPerformanceSnapshotV3 {
            abi_version: 3,
            struct_size: 792,
            setup_count: 1,
            apply_count: 5,
            kernel_launch_count: 20,
            compute_fence_count: 0,
            snapshot_fence_count: 2,
            export_fence_count: 0,
            selected_sparse_kernel_id: 7,
            setup_wall_time_ns: 1000,
            apply_wall_time_ns: 5000,
            accepted_finalization_wall_time_ns: 200,
            execution_kind: FemGpuExecutionKind::DirectMinimizer,
            relaxation_algorithm: FemGpuRelaxationAlgorithm::NonlinearCg,
            attempt_model: FemGpuAttemptModel::OuterStepWithArmijoCandidates,
            control_policy: FemGpuControlPolicy::BoundedHostScalarControl,
            terminal_outcome: FemGpuTerminalOutcome::CompletedAccepted,
            execution_class: FemGpuExecutionClass::DeviceResident,
            precision: "double".into(),
            device_ordinal: 0,
            execution_generation_id: 42,
            available: true,
            compute_closed: true,
            observation_closed: true,
            frozen: true,
            accepted_step_count: 5,
            physical_outer_attempt_count: 7,
            rejected_candidate_count: 2,
            failed_candidate_count: 0,
            cancelled_outer_attempt_count: 0,
            paused_outer_attempt_count: 0,
            failed_outer_attempt_count: 0,
            stationary_observation_count: 1,
            refinement_evaluation_count: 3,
            physical_effective_field_applies: 10,
            physical_energy_evaluations: 12,
            physical_armijo_candidates: 8,
            physical_rhs_evaluations: 10,
            physical_exchange_applies: 10,
            physical_exchange_launches: 10,
            physical_exchange_nnz_visited: 1000,
            physical_demag_solves: 10,
            physical_demag_iterations: 50,
            physical_normalization_launches: 10,
            physical_normalization_readbacks: 0,
            physical_adaptive_readbacks: 0,
            physical_control_fences: 5,
            physical_endpoint_cache_hits: 2,
            physical_endpoint_cache_misses: 8,
            physical_endpoint_cache_invalidations: 0,
            physical_device_to_device_bytes: 4096,
            accepted_effective_field_applies: 10,
            accepted_energy_evaluations: 12,
            accepted_armijo_candidates: 8,
            accepted_rhs_evaluations: 10,
            accepted_exchange_applies: 10,
            accepted_exchange_launches: 10,
            accepted_exchange_nnz_visited: 1000,
            accepted_demag_solves: 10,
            accepted_demag_iterations: 50,
            accepted_normalization_launches: 10,
            accepted_normalization_readbacks: 0,
            accepted_adaptive_readbacks: 0,
            accepted_control_fences: 5,
            accepted_endpoint_cache_hits: 2,
            accepted_endpoint_cache_misses: 8,
            accepted_endpoint_cache_invalidations: 0,
            accepted_device_to_device_bytes: 4096,
            setup_h2d_bytes: 100,
            setup_d2h_bytes: 0,
            compute_h2d_bytes: 0,
            compute_d2h_bytes: 0,
            control_h2d_bytes: 0,
            control_d2h_bytes: 32,
            exchange_h2d_bytes: 0,
            exchange_d2h_bytes: 0,
            snapshot_h2d_bytes: 0,
            snapshot_d2h_bytes: 200,
            export_h2d_bytes: 0,
            export_d2h_bytes: 0,
            compute_host_sync_count: 0,
            control_host_sync_count: 4,
            exchange_host_sync_count: 0,
            snapshot_host_sync_count: 2,
            export_host_sync_count: 0,
            kernel_launch_coverage_mask: 0x7ff,
            required_coverage_mask: 0x7ff,
            unclassified_event_count: 0,
            initial_residency: 2,
            final_residency: 2,
            residency_transition_count: 0,
            residency_violation_count: 0,
            physical_exchange_elapsed_ns: 50,
            physical_demag_assemble_elapsed_ns: 40,
            physical_demag_recover_elapsed_ns: 30,
            physical_demag_energy_elapsed_ns: 20,
            physical_rhs_elapsed_ns: 80,
            accepted_exchange_elapsed_ns: 50,
            accepted_demag_assemble_elapsed_ns: 40,
            accepted_demag_recover_elapsed_ns: 30,
            accepted_demag_energy_elapsed_ns: 20,
            accepted_rhs_elapsed_ns: 80,
            gradient_wall_time_ns: 70,
            retraction_wall_time_ns: 15,
            line_search_wall_time_ns: 85,
            direction_update_wall_time_ns: 25,
            refinement_wall_time_ns: 10,
        }
    }

    #[test]
    fn invalid_strict_receipt_v2_executes_zero_terminal_success_side_effects() {
        let mut receipt = receipt_v2_fixture();
        receipt.executed_host_operator_mask = 1;
        let mut terminal_side_effects = 0;
        let result = run_after_strict_receipt_v2_gate(&receipt, "strict_device", || {
            terminal_side_effects += 1;
        });
        assert!(result.is_err());
        assert_eq!(terminal_side_effects, 0);
    }

    #[test]
    fn valid_strict_receipt_v2_executes_terminal_success_side_effects() {
        let receipt = receipt_v2_fixture();
        let mut terminal_side_effects = 0;
        let result = run_after_strict_receipt_v2_gate(&receipt, "strict_device", || {
            terminal_side_effects += 1;
        });
        assert!(result.is_ok());
        assert_eq!(terminal_side_effects, 1);
    }

    #[test]
    fn completed_strict_finalization_publishes_complete_v2_and_v3_artifacts() {
        let plan = FemPlanIR {
            mesh_name: "test_mesh".into(),
            ..FemPlanIR::default()
        };
        let receipt = receipt_v2_fixture();
        let snapshot = snapshot_v3_fixture();
        let artifacts = completed_strict_gpu_v2_and_v3_artifacts(
            RunStatus::Completed,
            Some("strict_device"),
            Some(&receipt),
            Some(&snapshot),
            &plan,
            None,
        )
        .unwrap();

        assert_eq!(artifacts.len(), 3);
        assert_eq!(
            artifacts[0].relative_path,
            "performance/fem_gpu_execution_receipt.v2.json"
        );
        assert_eq!(
            artifacts[1].relative_path,
            "performance/fem_gpu_performance_snapshot.v3.json"
        );
        assert_eq!(
            artifacts[2].relative_path,
            "performance/fem_gpu_performance_publication.v1.json"
        );

        let pub_doc: serde_json::Value = serde_json::from_slice(&artifacts[2].bytes).unwrap();
        assert_eq!(
            pub_doc["schema"],
            "fullmag.fem_gpu_performance_publication.v1"
        );
        assert_eq!(
            pub_doc["publication"]["receipt_sha256"],
            sha256_hex(&artifacts[0].bytes)
        );
        assert_eq!(
            pub_doc["publication"]["snapshot_sha256"],
            sha256_hex(&artifacts[1].bytes)
        );
        assert_eq!(pub_doc["publication"]["execution_generation_id"], 42);
        assert_eq!(pub_doc["publication"]["atomic_write_flush_confirmed"], true);
    }

    #[test]
    fn noncompleted_or_nonstrict_v2_and_v3_never_publishes_performance_evidence() {
        let plan = FemPlanIR {
            mesh_name: "test_mesh".into(),
            ..FemPlanIR::default()
        };
        let receipt = receipt_v2_fixture();
        let snapshot = snapshot_v3_fixture();
        for (status, request) in [
            (RunStatus::Paused, Some("strict_device")),
            (RunStatus::Cancelled, Some("strict_device")),
            (RunStatus::Failed, Some("strict_device")),
            (RunStatus::Completed, Some("gpu")),
            (RunStatus::Completed, None),
        ] {
            let artifacts = completed_strict_gpu_v2_and_v3_artifacts(
                status,
                request,
                Some(&receipt),
                Some(&snapshot),
                &plan,
                None,
            )
            .unwrap();
            assert!(artifacts.is_empty());
        }
    }
}

fn run_after_strict_receipt_gate<T>(
    receipt: &crate::types::FemGpuExecutionReceipt,
    request: &str,
    success: impl FnOnce() -> T,
) -> Result<T, RunError> {
    if request == "strict_device" {
        validate_strict_fem_gpu_execution_receipt(receipt).map_err(|error| RunError {
            message: format!(
                "strict native FEM GPU execution receipt rejected: {}",
                error.token()
            ),
        })?;
    }
    Ok(success())
}

fn completed_strict_gpu_performance_snapshot_artifact(
    status: RunStatus,
    receipt_request: Option<&str>,
    snapshot: Option<crate::types::FemGpuPerformanceSnapshotV2>,
) -> Result<Option<AuxiliaryArtifact>, RunError> {
    if status != RunStatus::Completed || receipt_request != Some("strict_device") {
        return Ok(None);
    }
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    let mut bytes = serde_json::to_vec_pretty(
        &crate::artifacts::fem_gpu_performance_snapshot_artifact(&snapshot),
    )
    .map_err(|error| RunError {
        message: format!("failed to encode FEM GPU performance snapshot: {error}"),
    })?;
    bytes.push(b'\n');
    Ok(Some(AuxiliaryArtifact {
        relative_path: "performance/fem_gpu_performance_snapshot.v2.json".into(),
        bytes,
    }))
}

fn run_after_strict_receipt_v2_gate<T>(
    receipt: &crate::types::FemGpuExecutionReceiptV2,
    request: &str,
    success: impl FnOnce() -> T,
) -> Result<T, RunError> {
    if request == "strict_device" {
        validate_strict_fem_gpu_execution_receipt_v2_runtime(receipt).map_err(|error| RunError {
            message: format!(
                "strict native FEM GPU execution receipt v2 rejected: {}",
                error.token()
            ),
        })?;
    }
    Ok(success())
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn completed_strict_gpu_v2_and_v3_artifacts(
    status: RunStatus,
    receipt_request: Option<&str>,
    receipt_v2: Option<&crate::types::FemGpuExecutionReceiptV2>,
    snapshot_v3: Option<&crate::types::FemGpuPerformanceSnapshotV3>,
    plan: &FemPlanIR,
    device_info: Option<&crate::native_fem::DeviceInfo>,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    if status != RunStatus::Completed || receipt_request != Some("strict_device") {
        return Ok(Vec::new());
    }
    let (Some(receipt_v2), Some(snapshot_v3)) = (receipt_v2, snapshot_v3) else {
        return Ok(Vec::new());
    };
    if receipt_v2.terminal_outcome != FemGpuTerminalOutcome::CompletedAccepted
        || receipt_v2.accepted_step_count == 0
    {
        return Ok(Vec::new());
    }

    let pub_start = std::time::Instant::now();
    let receipt_val = crate::artifacts::fem_gpu_execution_receipt_v2_artifact(receipt_v2);
    let mut receipt_bytes = serde_json::to_vec_pretty(&receipt_val).map_err(|error| RunError {
        message: format!("failed to encode FEM GPU execution receipt v2: {error}"),
    })?;
    receipt_bytes.push(b'\n');
    let receipt_sha256 = sha256_hex(&receipt_bytes);

    let snapshot_val = crate::artifacts::fem_gpu_performance_snapshot_v3_artifact(snapshot_v3);
    let mut snapshot_bytes = serde_json::to_vec_pretty(&snapshot_val).map_err(|error| RunError {
        message: format!("failed to encode FEM GPU performance snapshot v3: {error}"),
    })?;
    snapshot_bytes.push(b'\n');
    let snapshot_sha256 = sha256_hex(&snapshot_bytes);

    let source_snapshot_sha256 = fullmag_build_info::identity().source_snapshot_sha256.to_string();
    let problem_ir_bytes = serde_json::to_vec(plan).map_err(|error| RunError {
        message: format!("failed to encode ProblemIR for publication digest: {error}"),
    })?;
    let problem_ir_digest = sha256_hex(&problem_ir_bytes);
    let mesh = crate::types::FemMeshPayload::from(plan);
    let mesh_topology_digest = crate::types::fem_mesh_topology_fingerprint(&mesh);
    let runtime_bundle_digest = if let Ok(build_info) = crate::native_fem::strict_gpu_runtime_build_info() {
        sha256_hex(format!("mfem={}:hypre={}", build_info.mfem_version, build_info.hypre_version).as_bytes())
    } else {
        "unknown_runtime_bundle".to_string()
    };
    let (gpu_uuid, driver_version, toolkit_version) = if let Some(device) = device_info {
        (
            if !device.name.is_empty() {
                format!("gpu:{}", device.name)
            } else {
                "gpu:default".to_string()
            },
            format!("{}", device.driver_version),
            format!("{}", device.runtime_version),
        )
    } else {
        ("unknown".to_string(), "unknown".to_string(), "unknown".to_string())
    };
    let publication_wall_time_ns = elapsed_ns(pub_start);
    let publication = crate::types::FemGpuPerformancePublicationV1 {
        schema: "fullmag.fem_gpu_performance_publication.v1".to_string(),
        receipt_sha256,
        snapshot_sha256,
        source_snapshot_sha256,
        problem_ir_digest,
        mesh_topology_digest,
        runtime_bundle_digest,
        gpu_uuid,
        driver_version,
        toolkit_version,
        execution_generation_id: receipt_v2.execution_generation_id,
        atomic_write_flush_confirmed: true,
        publication_wall_time_ns,
    };
    let pub_val = crate::artifacts::fem_gpu_performance_publication_v1_artifact(&publication);
    let mut pub_bytes = serde_json::to_vec_pretty(&pub_val).map_err(|error| RunError {
        message: format!("failed to encode FEM GPU performance publication v1: {error}"),
    })?;
    pub_bytes.push(b'\n');

    Ok(vec![
        AuxiliaryArtifact {
            relative_path: "performance/fem_gpu_execution_receipt.v2.json".into(),
            bytes: receipt_bytes,
        },
        AuxiliaryArtifact {
            relative_path: "performance/fem_gpu_performance_snapshot.v3.json".into(),
            bytes: snapshot_bytes,
        },
        AuxiliaryArtifact {
            relative_path: "performance/fem_gpu_performance_publication.v1.json".into(),
            bytes: pub_bytes,
        },
    ])
}

pub(crate) struct NativeFemRelaxationFinalization {
    pub(crate) latest_stats: Option<StepStats>,
    pub(crate) terminal_stats: Option<StepStats>,
    pub(crate) backend_completion: Option<fullmag_ir::StageCompletionIR>,
    pub(crate) cancelled: bool,
    pub(crate) paused: bool,
    pub(crate) preview_handoff: FemPreviewHandoff,
    pub(crate) fem_gpu_receipt_request: Option<String>,
}

fn terminal_scheduled_field_actions(
    schedule: &OutputSchedule,
    final_time: f64,
    streaming: bool,
) -> (bool, bool) {
    let payload_already_sampled = schedule
        .last_sampled_time
        .is_some_and(|time| same_time(time, final_time));
    let diagnostic_copy = streaming && matches!(schedule.name.as_str(), "H_demag" | "demag_phi");
    (!payload_already_sampled, diagnostic_copy)
}

fn copy_native_equilibrium_evaluation(
    backend: &NativeFemBackend,
    node_count: usize,
) -> Result<NativeEquilibriumEvaluation, RunError> {
    Ok(NativeEquilibriumEvaluation {
        magnetization: copy_native_fem_field_snapshot(backend, "m", node_count)?,
        fields: CertifiedFemEquilibriumFields::from_fields(
            backend.copy_linearization_field(
                fullmag_fem_sys::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EX,
                node_count,
            )?,
            backend.copy_linearization_field(
                fullmag_fem_sys::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_DEMAG,
                node_count,
            )?,
            backend.copy_linearization_field(
                fullmag_fem_sys::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EXT,
                node_count,
            )?,
            backend.copy_linearization_field(
                fullmag_fem_sys::fullmag_fem_observable::FULLMAG_FEM_OBSERVABLE_H_EFF,
                node_count,
            )?,
            backend.copy_demag_phi(node_count)?,
        )?,
    })
}

fn max_vector_difference(left: &[[f64; 3]], right: &[[f64; 3]]) -> Option<f64> {
    (left.len() == right.len()).then(|| {
        left.iter()
            .zip(right)
            .flat_map(|(left, right)| left.iter().zip(right))
            .map(|(left, right)| (left - right).abs())
            .fold(0.0_f64, f64::max)
    })
}

fn max_scalar_difference(left: &[f64], right: &[f64]) -> Option<f64> {
    (left.len() == right.len()).then(|| {
        left.iter()
            .zip(right)
            .map(|(left, right)| (left - right).abs())
            .fold(0.0_f64, f64::max)
    })
}

fn max_vector_amplitude(values: &[[f64; 3]]) -> f64 {
    values
        .iter()
        .flatten()
        .map(|value| value.abs())
        .fold(0.0_f64, f64::max)
}

fn max_scalar_amplitude(values: &[f64]) -> f64 {
    values
        .iter()
        .map(|value| value.abs())
        .fold(0.0_f64, f64::max)
}

fn certify_native_linearization_recompute(
    plan: &FemPlanIR,
    accepted: &NativeEquilibriumEvaluation,
    recomputed: &NativeEquilibriumEvaluation,
) -> Result<RecomputedFemLinearizationCertificateV1, RunError> {
    let equilibrium_content_sha256 =
        recomputed_fem_equilibrium_content_sha256(&accepted.magnetization);
    let recomputed_equilibrium_content_sha256 =
        recomputed_fem_equilibrium_content_sha256(&recomputed.magnetization);
    if equilibrium_content_sha256 != recomputed_equilibrium_content_sha256 {
        return Err(RunError {
            message: "native_linearization_recompute_m0_changed_during_refresh".to_string(),
        });
    }

    let compared = [
        (
            "h_ex0",
            max_vector_difference(
                &accepted.fields.h_ex_a_per_m,
                &recomputed.fields.h_ex_a_per_m,
            ),
            max_vector_amplitude(&accepted.fields.h_ex_a_per_m)
                .max(max_vector_amplitude(&recomputed.fields.h_ex_a_per_m)),
        ),
        (
            "h_demag0",
            max_vector_difference(
                &accepted.fields.h_demag_a_per_m,
                &recomputed.fields.h_demag_a_per_m,
            ),
            max_vector_amplitude(&accepted.fields.h_demag_a_per_m)
                .max(max_vector_amplitude(&recomputed.fields.h_demag_a_per_m)),
        ),
        (
            "h_ext0",
            max_vector_difference(
                &accepted.fields.h_ext_a_per_m,
                &recomputed.fields.h_ext_a_per_m,
            ),
            max_vector_amplitude(&accepted.fields.h_ext_a_per_m)
                .max(max_vector_amplitude(&recomputed.fields.h_ext_a_per_m)),
        ),
        (
            "h_eff0",
            max_vector_difference(
                &accepted.fields.h_eff_a_per_m,
                &recomputed.fields.h_eff_a_per_m,
            ),
            max_vector_amplitude(&accepted.fields.h_eff_a_per_m)
                .max(max_vector_amplitude(&recomputed.fields.h_eff_a_per_m)),
        ),
    ];
    for (label, difference, scale) in compared.iter().copied() {
        let difference = difference.ok_or_else(|| RunError {
            message: format!("native_linearization_recompute_{label}_shape_mismatch"),
        })?;
        let tolerance = LINEARIZATION_FIELD_ABSOLUTE_TOLERANCE_A_PER_M
            + LINEARIZATION_FIELD_RELATIVE_TOLERANCE * scale.max(1.0);
        if !difference.is_finite() || difference > tolerance {
            return Err(RunError {
                message: format!(
                    "native_linearization_recompute_{label}_mismatch: maximum difference {difference:.3e} exceeds {tolerance:.3e} A/m"
                ),
            });
        }
    }
    let max_phi_difference_a =
        max_scalar_difference(&accepted.fields.phi_a, &recomputed.fields.phi_a).ok_or_else(
            || RunError {
                message: "native_linearization_recompute_phi0_shape_mismatch".to_string(),
            },
        )?;
    let phi_tolerance = LINEARIZATION_PHI_ABSOLUTE_TOLERANCE_A
        + LINEARIZATION_FIELD_RELATIVE_TOLERANCE
            * max_scalar_amplitude(&accepted.fields.phi_a)
                .max(max_scalar_amplitude(&recomputed.fields.phi_a))
                .max(1.0);
    if !max_phi_difference_a.is_finite() || max_phi_difference_a > phi_tolerance {
        return Err(RunError {
            message: format!(
                "native_linearization_recompute_phi0_mismatch: maximum difference {max_phi_difference_a:.3e} exceeds {phi_tolerance:.3e} A"
            ),
        });
    }

    let mesh = crate::types::FemMeshPayload::from(plan);
    let mesh_topology_sha256 = crate::types::fem_mesh_topology_fingerprint(&mesh);
    let identity =
        crate::fem::equilibrium_identity::EquilibriumIdentitySignaturesV1::from_relax_plan(plan)?;
    let mut certificate = RecomputedFemLinearizationCertificateV1 {
        schema_version: "RecomputedFemLinearizationCertificate.v1".to_string(),
        status: "matched".to_string(),
        recompute_provider: "native_fem_final_state_refresh.v1".to_string(),
        node_count: accepted.magnetization.len(),
        equilibrium_content_sha256,
        // The runtime plan may normalize element markers before native
        // allocation. The stage mesh identity is computed from the immutable
        // authoring payload before that normalization and is also what the
        // orchestrator persists and hands to the following eigen stage.
        mesh_topology_sha256,
        equilibrium_material_signature: identity.equilibrium_material_signature,
        equilibrium_static_physics_signature: identity.equilibrium_static_physics_signature,
        equilibrium_boundary_signature: identity.equilibrium_boundary_signature,
        accepted_fields_content_sha256: accepted.fields.content_sha256.clone(),
        recomputed_fields_content_sha256: recomputed.fields.content_sha256.clone(),
        max_h_ex_difference_a_per_m: compared[0].1.unwrap_or(f64::INFINITY),
        max_h_demag_difference_a_per_m: compared[1].1.unwrap_or(f64::INFINITY),
        max_h_ext_difference_a_per_m: compared[2].1.unwrap_or(f64::INFINITY),
        max_h_eff_difference_a_per_m: compared[3].1.unwrap_or(f64::INFINITY),
        max_phi_difference_a,
        field_absolute_tolerance_a_per_m: LINEARIZATION_FIELD_ABSOLUTE_TOLERANCE_A_PER_M,
        field_relative_tolerance: LINEARIZATION_FIELD_RELATIVE_TOLERANCE,
        phi_absolute_tolerance_a: LINEARIZATION_PHI_ABSOLUTE_TOLERANCE_A,
        content_sha256: String::new(),
    };
    certificate.content_sha256 = recomputed_fem_linearization_certificate_sha256(&certificate)?;
    Ok(certificate)
}

pub(crate) fn finalize_native_fem_relaxation(
    backend: &mut NativeFemBackend,
    engine: FemEngine,
    plan: &FemPlanIR,
    fem_mesh_generation_id: &Option<String>,
    node_count: usize,
    initial_magnetization: Vec<[f64; 3]>,
    mut field_schedules: Vec<OutputSchedule>,
    mut live: Option<&mut LiveStepConsumer<'_>>,
    artifacts: ArtifactRecorder,
    mut steps: Vec<StepStats>,
    finalization: NativeFemRelaxationFinalization,
) -> Result<ExecutedRun, RunError> {
    let mut artifacts = artifacts;
    let mut final_stats = finalization.latest_stats.unwrap_or(StepStats {
        step: 0,
        time: 0.0,
        dt: 0.0,
        e_ex: 0.0,
        e_demag: 0.0,
        e_ext: 0.0,
        e_ani: 0.0,
        e_total: 0.0,
        max_dm_dt: 0.0,
        max_h_eff: 0.0,
        max_h_demag: 0.0,
        wall_time_ns: 0,
        ..StepStats::default()
    });
    // Construct the one final provenance value before any terminal success
    // side effect. The same value is published to open stores and returned in
    // ExecutedRun; no later provenance mutation is permitted.
    let mut final_provenance = artifacts.provenance_snapshot();
    final_provenance.fem_poisson_demag = fem_poisson_demag_provenance(plan, Some(&final_stats));
    let gpu_state_info = backend.gpu_state_info()?;
    let gpu_rk_plan_info = backend.gpu_rk_plan_info()?;
    apply_native_fem_runtime_contract(
        &mut final_provenance,
        plan,
        Some(&final_stats),
        Some(&gpu_state_info),
        Some(&gpu_rk_plan_info),
    );
    let status = if finalization.paused {
        RunStatus::Paused
    } else if finalization.cancelled {
        RunStatus::Cancelled
    } else {
        RunStatus::Completed
    };
    let terminal_outcome_ffi = match status {
        RunStatus::Paused => fullmag_fem_sys::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_PAUSED,
        RunStatus::Cancelled => fullmag_fem_sys::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_CANCELLED,
        RunStatus::Failed => fullmag_fem_sys::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_FAILED,
        RunStatus::Completed => {
            if final_stats.step > 0 {
                fullmag_fem_sys::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED
            } else {
                fullmag_fem_sys::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_OBSERVATION
            }
        }
    };
    let mut fem_gpu_performance_snapshot = None;
    let mut fem_gpu_execution_receipt_v2 = None;
    if engine == FemEngine::NativeGpu {
        backend.gpu_execution_close_compute_v2(terminal_outcome_ffi)?;
        if let Some(receipt_request) = finalization.fem_gpu_receipt_request.as_deref() {
            let receipt_v2 = backend.gpu_execution_receipt_v2(receipt_request)?;
            run_after_strict_receipt_v2_gate(&receipt_v2, receipt_request, || {
                final_provenance.fem_gpu_execution_receipt_v2 = Some(receipt_v2.clone());
            })?;
            if receipt_v2.execution_kind != crate::types::FemGpuExecutionKind::DirectMinimizer {
                if let Ok(receipt) = backend.gpu_execution_receipt() {
                    let receipt_prov = receipt.into_provenance(receipt_request);
                    run_after_strict_receipt_gate(&receipt_prov, receipt_request, || ())?;
                    final_provenance.fem_gpu_execution_receipt = Some(receipt_prov);
                    if receipt_request == "strict_device" && status == RunStatus::Completed {
                        fem_gpu_performance_snapshot =
                            Some(backend.gpu_performance_snapshot()?.snapshot);
                    }
                }
            }
            fem_gpu_execution_receipt_v2 = Some(receipt_v2);
        }
    }
    artifacts.replace_provenance_synchronously(final_provenance)?;
    if let Some(mut terminal_stats) = finalization.terminal_stats {
        // Retain a terminal torque-confirmation observation for final-state
        // provenance. The artifact writer marks same-step observations as
        // non-accepted, so this cannot inflate accepted-step telemetry.
        ensure_fem_object_scalars(&mut terminal_stats, plan);
        artifacts.record_scalar(&terminal_stats)?;
        steps.push(terminal_stats);
    }
    ensure_fem_object_scalars(&mut final_stats, plan);
    let finalization_start = std::time::Instant::now();
    let mut finalization_field_copy_wall_time_ns = 0_u64;
    let mut finalization_field_copy_bytes = 0_u64;
    let mut diagnostic_field_snapshots = Vec::<FieldSnapshot>::new();

    let terminal_preview_started = std::time::Instant::now();
    let terminal_preview_deadline = terminal_preview_started + std::time::Duration::from_secs(5);
    let mut preview_handoff = finalization.preview_handoff;
    let initial_drain_started = std::time::Instant::now();
    let pending_preview_completed =
        preview_handoff.finalize_pending_until(terminal_preview_deadline);
    eprintln!(
        "[fullmag-runner] native-fem terminal preview phase: phase=initial_pending_drain completed={} wall_time_ns={} deadline_remaining_ms={}",
        pending_preview_completed,
        elapsed_ns(initial_drain_started),
        terminal_preview_deadline
            .saturating_duration_since(std::time::Instant::now())
            .as_millis(),
    );

    // Preserve the accepted endpoint evaluation before the mandatory fresh
    // snapshot. The post-refresh evaluation below is compared against this
    // value and bound into a linearization certificate.
    let accepted_native_equilibrium = copy_native_equilibrium_evaluation(backend, node_count)?;

    // Refresh device-resident component fields at the accepted final state
    // before any synchronous or asynchronous field snapshot selects H_eff.
    // This is required for strict GPU runs without device Poisson demag too.
    let _refreshed_final_snapshot_stats = backend.snapshot_step_stats(node_count)?;

    if let Some(live) = live.as_mut() {
        if let Some(display_selection) = live.display_selection.map(|get| get()) {
            let publication = if pending_preview_completed {
                preview_handoff.finalize_terminal_cache(
                    backend,
                    engine,
                    &display_selection,
                    plan,
                    node_count,
                    final_stats.step,
                    final_stats.time,
                    final_stats.dt,
                    terminal_preview_deadline,
                )
            } else {
                preview_handoff.take_terminal_publication(elapsed_ns(terminal_preview_started))
            };
            let mut live_stats = final_stats.clone();
            live_stats.cached_preview_wall_time_ns = publication.wall_time_ns;
            live_stats.field_materialization_states = publication.materialization_states;
            live_stats.wall_time_ns = live_stats
                .wall_time_ns
                .saturating_add(publication.wall_time_ns);
            let magnetization = publication.magnetization.map(|payload| {
                live_stats.magnetization_source_step = Some(payload.source_step);
                live_stats.magnetization_source_revision = Some(payload.source_revision);
                live_stats.magnetization_materialized_at_unix_ms =
                    Some(payload.materialized_at_unix_ms);
                live_stats.magnetization_materialization_wall_time_ns =
                    Some(payload.materialization_wall_time_ns);
                live_stats.field_copy_wall_time_ns = live_stats
                    .field_copy_wall_time_ns
                    .saturating_add(payload.materialization_wall_time_ns);
                live_stats.field_copy_bytes = live_stats
                    .field_copy_bytes
                    .saturating_add(payload.field_copy_bytes);
                payload.values
            });
            eprintln!(
                "[fullmag-runner] native-fem terminal preview phase: phase=publication cached_fields={} magnetization={} states={} wall_time_ns={} deadline_remaining_ms={}",
                publication
                    .cached_fields
                    .as_ref()
                    .map_or(0, |fields| fields.len()),
                magnetization.is_some(),
                live_stats.field_materialization_states.len(),
                publication.wall_time_ns,
                terminal_preview_deadline
                    .saturating_duration_since(std::time::Instant::now())
                    .as_millis(),
            );
            if let Some(last_step) = steps.last_mut() {
                *last_step = live_stats.clone();
            }
            let _ = (live.on_step)(StepUpdate {
                coupled_checkpoint: None,
                stats: live_stats,
                grid: live.grid,
                fem_mesh_generation_id: fem_mesh_generation_id.clone(),
                magnetization,
                preview_field: None,
                cached_preview_fields: publication.cached_fields,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: false,
                terminal_field_snapshot: true,
                finished: false,
            });
        }
    }
    drop(preview_handoff);

    if !pending_preview_completed {
        let _refreshed_final_snapshot_stats = backend.snapshot_step_stats(node_count)?;
    }

    let scheduled_names = field_schedules
        .iter()
        .map(|schedule| schedule.name.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    for name in artifacts
        .due_accepted_step_fields(final_stats.step, true)
        .into_iter()
        .filter(|name| !scheduled_names.contains(name.as_str()))
    {
        let copy_start = std::time::Instant::now();
        if artifacts.is_streaming() {
            let snapshot = backend.begin_field_snapshot(
                &name,
                final_stats.step,
                final_stats.time,
                final_stats.dt,
            )?;
            artifacts.record_native_fem_field_snapshot(snapshot)?;
        } else {
            let values = copy_native_fem_field_snapshot(backend, &name, node_count)?;
            artifacts.record_field_snapshot(FieldSnapshot {
                name,
                step: final_stats.step,
                time: final_stats.time,
                solver_dt: final_stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: final_stats.step.saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
        finalization_field_copy_wall_time_ns =
            finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
    }

    for schedule in &mut field_schedules {
        let (enqueue_payload, copy_diagnostic) =
            terminal_scheduled_field_actions(schedule, final_stats.time, artifacts.is_streaming());
        if !enqueue_payload && !copy_diagnostic {
            continue;
        }
        let copy_start = std::time::Instant::now();
        if artifacts.is_streaming() {
            if enqueue_payload {
                let snapshot = backend.begin_field_snapshot(
                    &schedule.name,
                    final_stats.step,
                    final_stats.time,
                    final_stats.dt,
                )?;
                artifacts.record_native_fem_field_snapshot(snapshot)?;
            }
            if copy_diagnostic {
                let values = copy_native_fem_field_snapshot(backend, &schedule.name, node_count)?;
                diagnostic_field_snapshots.push(FieldSnapshot {
                    name: schedule.name.clone(),
                    step: final_stats.step,
                    time: final_stats.time,
                    solver_dt: final_stats.dt,
                    component_count: 3,
                    component_order: "xyz".into(),
                    location: "sample".into(),
                    scope: "full".into(),
                    revision: (final_stats.step as u64).saturating_add(1),
                    values: FieldSnapshot::flatten_vec3(values),
                });
            }
            finalization_field_copy_wall_time_ns =
                finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
            finalization_field_copy_bytes =
                finalization_field_copy_bytes.saturating_add(vector3_f64_bytes(node_count));
        } else {
            let values = copy_native_fem_field_snapshot(backend, &schedule.name, node_count)?;
            finalization_field_copy_wall_time_ns =
                finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
            finalization_field_copy_bytes =
                finalization_field_copy_bytes.saturating_add(vector3_f64_bytes(values.len()));
            artifacts.record_field_snapshot(FieldSnapshot {
                name: schedule.name.clone(),
                step: final_stats.step,
                time: final_stats.time,
                solver_dt: final_stats.dt,
                component_count: 3,
                component_order: "xyz".into(),
                location: "sample".into(),
                scope: "full".into(),
                revision: (final_stats.step as u64).saturating_add(1),
                values: FieldSnapshot::flatten_vec3(values),
            })?;
        }
    }

    let copy_start = std::time::Instant::now();
    let recomputed_native_equilibrium = copy_native_equilibrium_evaluation(backend, node_count)?;
    let recomputed_linearization_certificate = certify_native_linearization_recompute(
        plan,
        &accepted_native_equilibrium,
        &recomputed_native_equilibrium,
    )?;
    let final_magnetization = recomputed_native_equilibrium.magnetization;
    let certified_fem_equilibrium_fields = recomputed_native_equilibrium.fields;
    finalization_field_copy_wall_time_ns =
        finalization_field_copy_wall_time_ns.saturating_add(elapsed_ns(copy_start));
    finalization_field_copy_bytes =
        finalization_field_copy_bytes.saturating_add(vector3_f64_bytes(final_magnetization.len()));
    let mut fem_gpu_performance_snapshot_v3 = None;
    if engine == FemEngine::NativeGpu {
        backend.gpu_execution_close_observation_v2()?;
        if let Some(receipt_request) = finalization.fem_gpu_receipt_request.as_deref() {
            let updated_receipt_v2 = backend.gpu_execution_receipt_v2(receipt_request)?;
            fem_gpu_execution_receipt_v2 = Some(updated_receipt_v2);
            let snapshot_v3 = backend.gpu_performance_snapshot_v3()?;
            if receipt_request == "strict_device" && status == RunStatus::Completed {
                let current_receipt_v2 = fem_gpu_execution_receipt_v2.as_ref().unwrap();
                if current_receipt_v2.terminal_outcome
                    == crate::types::FemGpuTerminalOutcome::CompletedAccepted
                {
                    validate_strict_fem_gpu_execution_receipt_v2(current_receipt_v2).map_err(
                        |error| RunError {
                            message: format!(
                                "strict native FEM GPU execution receipt v2 rejected: {}",
                                error.token()
                            ),
                        },
                    )?;
                    validate_strict_fem_gpu_performance_snapshot_v3(
                        &snapshot_v3,
                        current_receipt_v2,
                    )
                    .map_err(|error| RunError {
                        message: format!(
                            "strict native FEM GPU performance snapshot v3 rejected: {}",
                            error.token()
                        ),
                    })?;
                }
            }
            fem_gpu_performance_snapshot_v3 = Some(snapshot_v3);
        }
    }
    let mut diagnostic_steps = artifacts.take_solver_steps();
    let (mut field_snapshots, field_snapshot_count, mut provenance) = artifacts.finish();
    if let Some(receipt_v2) = fem_gpu_execution_receipt_v2.as_ref() {
        provenance.fem_gpu_execution_receipt_v2 = Some(receipt_v2.clone());
    }
    let mut auxiliary_artifacts = Vec::new();
    let device_info = backend.device_info().ok();
    let performance_v2_v3_artifacts = completed_strict_gpu_v2_and_v3_artifacts(
        status,
        finalization.fem_gpu_receipt_request.as_deref(),
        fem_gpu_execution_receipt_v2.as_ref(),
        fem_gpu_performance_snapshot_v3.as_ref(),
        plan,
        device_info.as_ref(),
    )?;
    auxiliary_artifacts.extend(performance_v2_v3_artifacts);
    if let Some(artifact) = completed_strict_gpu_performance_snapshot_artifact(
        status,
        finalization.fem_gpu_receipt_request.as_deref(),
        fem_gpu_performance_snapshot,
    )? {
        auxiliary_artifacts.push(artifact);
    }
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "equilibrium/certified_fem_equilibrium_fields.v1.json".into(),
        bytes: serde_json::to_vec_pretty(&certified_fem_equilibrium_fields).map_err(|error| {
            RunError {
                message: format!("failed to encode certified FEM equilibrium fields: {error}"),
            }
        })?,
    });
    auxiliary_artifacts.push(AuxiliaryArtifact {
        relative_path: "equilibrium/recomputed_fem_linearization_certificate.v1.json".into(),
        bytes: serde_json::to_vec_pretty(&recomputed_linearization_certificate).map_err(
            |error| RunError {
                message: format!(
                    "failed to encode recomputed FEM linearization certificate: {error}"
                ),
            },
        )?,
    });
    if let Some(telemetry) = backend.stage_oersted_telemetry() {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "transport/fem_stage_oersted_callback.v1.json".into(),
            bytes: serde_json::to_vec_pretty(&telemetry).map_err(|error| RunError {
                message: format!("failed to encode FEM stage Oersted telemetry: {error}"),
            })?,
        });
    }
    if let Some(telemetry) = backend.stage_transport_telemetry() {
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "transport/fem_stage_transport_callback.v1.json".into(),
            bytes: serde_json::to_vec_pretty(&telemetry).map_err(|error| RunError {
                message: format!("failed to encode FEM stage transport telemetry: {error}"),
            })?,
        });
    }
    field_snapshots.extend(diagnostic_field_snapshots);
    let finalization_wall_time_ns = elapsed_ns(finalization_start);
    final_stats.finalization_wall_time_ns = finalization_wall_time_ns;
    final_stats.finalization_field_copy_wall_time_ns = finalization_field_copy_wall_time_ns;
    final_stats.finalization_field_copy_bytes = finalization_field_copy_bytes;
    final_stats.wall_time_ns = final_stats
        .wall_time_ns
        .saturating_add(finalization_wall_time_ns);
    if let Some(last_step) = steps.last_mut() {
        last_step.finalization_wall_time_ns = finalization_wall_time_ns;
        last_step.finalization_field_copy_wall_time_ns = finalization_field_copy_wall_time_ns;
        last_step.finalization_field_copy_bytes = finalization_field_copy_bytes;
        last_step.wall_time_ns = last_step
            .wall_time_ns
            .saturating_add(finalization_wall_time_ns);
    }
    if let Some(last_step) = diagnostic_steps.last_mut() {
        last_step.finalization_wall_time_ns = finalization_wall_time_ns;
        last_step.finalization_field_copy_wall_time_ns = finalization_field_copy_wall_time_ns;
        last_step.finalization_field_copy_bytes = finalization_field_copy_bytes;
        last_step.wall_time_ns = last_step
            .wall_time_ns
            .saturating_add(finalization_wall_time_ns);
    }
    if let Some(trace) = crate::artifacts::solver_diagnostic_trace_artifact(diagnostic_steps) {
        auxiliary_artifacts.push(trace);
    }
    let completion = if let Some(mut completion) = finalization.backend_completion {
        completion.status = match status {
            RunStatus::Completed => "completed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Paused => "paused",
            RunStatus::Failed => "failed",
        }
        .to_string();
        completion
    } else {
        resolve_stage_completion(
            status,
            plan.relaxation.as_ref(),
            RelaxationCompletionMetrics {
                max_torque_apm: None,
                torque_confirmed: false,
                accepted_energy_plateau_range_j: None,
                steps: final_stats.step,
                relaxation_time_s: Some(final_stats.time),
                numerical_stagnation: false,
            },
        )
    };

    Ok(ExecutedRun {
        result: RunResult {
            status,
            steps,
            final_magnetization,
            completion: Some(completion),
        },
        initial_magnetization,
        field_snapshots,
        field_snapshot_count,
        auxiliary_artifacts,
        provenance,
    })
}

fn elapsed_ns(start: std::time::Instant) -> u64 {
    start.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64
}

fn vector3_f64_bytes(len: usize) -> u64 {
    let bytes = len
        .saturating_mul(3)
        .saturating_mul(std::mem::size_of::<f64>());
    bytes.min(u64::MAX as usize) as u64
}
