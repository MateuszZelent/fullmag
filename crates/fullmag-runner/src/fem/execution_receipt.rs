//! Validation boundary for native FEM GPU execution receipts.

use crate::types::{
    FemGpuExecutionClass, FemGpuExecutionReceipt, FemGpuExecutionReceiptV2,
    FemGpuPerformanceSnapshotV3, FemGpuTerminalOutcome,
};

pub(crate) const FEM_GPU_PERFORMANCE_SNAPSHOT_ABI_V1: u32 = 1;
pub(crate) const FEM_GPU_PERFORMANCE_SNAPSHOT_V1_SIZE: u32 = 480;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FemGpuPerformanceSnapshotValidationError {
    AbiMismatch,
    Unavailable,
    ExecutionClassMismatch,
    NoCompletedStep,
    AcceptedCountersExceedPhysical,
    GenerationMismatch,
    SnapshotNotFrozen,
    TerminalOutcomeNotCompletedAccepted,
    NoAcceptedStep,
    CoverageMissing,
    UnclassifiedEventsObserved,
    ResidencyViolationObserved,
    ComputeTransferObserved,
    ExchangeTransferObserved,
}

impl FemGpuPerformanceSnapshotValidationError {
    pub(crate) const fn token(self) -> &'static str {
        match self {
            Self::AbiMismatch => "fem_gpu_snapshot_abi_mismatch",
            Self::Unavailable => "fem_gpu_snapshot_unavailable",
            Self::ExecutionClassMismatch => "fem_gpu_snapshot_execution_class_mismatch",
            Self::NoCompletedStep => "fem_gpu_snapshot_no_completed_step",
            Self::AcceptedCountersExceedPhysical => "fem_gpu_snapshot_accepted_exceeds_physical",
            Self::GenerationMismatch => "fem_gpu_snapshot_generation_mismatch",
            Self::SnapshotNotFrozen => "fem_gpu_snapshot_not_frozen",
            Self::TerminalOutcomeNotCompletedAccepted => {
                "fem_gpu_snapshot_outcome_not_completed_accepted"
            }
            Self::NoAcceptedStep => "fem_gpu_snapshot_no_accepted_step",
            Self::CoverageMissing => "fem_gpu_snapshot_coverage_missing",
            Self::UnclassifiedEventsObserved => "fem_gpu_snapshot_unclassified_events_observed",
            Self::ResidencyViolationObserved => "fem_gpu_snapshot_residency_violation_observed",
            Self::ComputeTransferObserved => "fem_gpu_snapshot_compute_transfer_observed",
            Self::ExchangeTransferObserved => "fem_gpu_snapshot_exchange_transfer_observed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FemGpuPerformanceSnapshotSummary {
    pub(crate) abi_version: u32,
    pub(crate) struct_size: u32,
    pub(crate) available: bool,
    pub(crate) execution_class: FemGpuExecutionClass,
    pub(crate) completed_step: u64,
    pub(crate) completed_attempt_count: u64,
    pub(crate) rejected_attempt_count: u64,
    pub(crate) failed_attempt_count: u64,
    pub(crate) physical_rhs_evaluations: u64,
    pub(crate) accepted_rhs_evaluations: u64,
    pub(crate) physical_device_to_device_bytes: u64,
    pub(crate) accepted_device_to_device_bytes: u64,
}

pub(crate) fn validate_fem_gpu_performance_snapshot(
    snapshot: &FemGpuPerformanceSnapshotSummary,
) -> Result<(), FemGpuPerformanceSnapshotValidationError> {
    if snapshot.abi_version != FEM_GPU_PERFORMANCE_SNAPSHOT_ABI_V1
        || snapshot.struct_size != FEM_GPU_PERFORMANCE_SNAPSHOT_V1_SIZE
    {
        return Err(FemGpuPerformanceSnapshotValidationError::AbiMismatch);
    }
    if !snapshot.available {
        return Err(FemGpuPerformanceSnapshotValidationError::Unavailable);
    }
    if snapshot.execution_class != FemGpuExecutionClass::DeviceResident {
        return Err(FemGpuPerformanceSnapshotValidationError::ExecutionClassMismatch);
    }
    if snapshot.completed_step == 0 || snapshot.completed_attempt_count == 0 {
        return Err(FemGpuPerformanceSnapshotValidationError::NoCompletedStep);
    }
    if snapshot.accepted_rhs_evaluations > snapshot.physical_rhs_evaluations
        || snapshot.accepted_device_to_device_bytes > snapshot.physical_device_to_device_bytes
    {
        return Err(FemGpuPerformanceSnapshotValidationError::AcceptedCountersExceedPhysical);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FemGpuExecutionReceiptValidationError {
    AccountingInvalid,
    ExecutionClassMismatch,
    ResolvedHostOperator,
    ResolvedUnknownOperator,
    HostOperatorExecuted,
    UnknownOperatorExecuted,
    RequiredOperatorMissing,
    FallbackObserved,
    NoAcceptedStep,
    HotLoopTransferObserved,
    LifecycleInvalid,
    IdentityInvalid,
    GenerationMismatch,
    TransferViolationObserved,
    ResidencyViolationObserved,
    ComputeNotClosed,
    ObservationNotClosed,
}

impl FemGpuExecutionReceiptValidationError {
    pub(crate) const fn token(self) -> &'static str {
        match self {
            Self::AccountingInvalid => "fem_gpu_receipt_accounting_invalid",
            Self::ExecutionClassMismatch => "fem_gpu_receipt_execution_class_mismatch",
            Self::ResolvedHostOperator => "fem_gpu_receipt_resolved_host_operator",
            Self::ResolvedUnknownOperator => "fem_gpu_receipt_resolved_unknown_operator",
            Self::HostOperatorExecuted => "fem_gpu_receipt_host_operator_executed",
            Self::UnknownOperatorExecuted => "fem_gpu_receipt_unknown_operator_executed",
            Self::RequiredOperatorMissing => "fem_gpu_receipt_required_operator_missing",
            Self::FallbackObserved => "fem_gpu_receipt_fallback_observed",
            Self::NoAcceptedStep => "fem_gpu_receipt_no_accepted_step",
            Self::HotLoopTransferObserved => "fem_gpu_receipt_hot_loop_transfer_observed",
            Self::LifecycleInvalid => "fem_gpu_receipt_lifecycle_invalid",
            Self::IdentityInvalid => "fem_gpu_receipt_identity_invalid",
            Self::GenerationMismatch => "fem_gpu_receipt_generation_mismatch",
            Self::TransferViolationObserved => "fem_gpu_receipt_transfer_violation_observed",
            Self::ResidencyViolationObserved => "fem_gpu_receipt_residency_violation_observed",
            Self::ComputeNotClosed => "fem_gpu_receipt_compute_not_closed",
            Self::ObservationNotClosed => "fem_gpu_receipt_observation_not_closed",
        }
    }
}

pub(crate) fn validate_strict_fem_gpu_execution_receipt(
    receipt: &FemGpuExecutionReceipt,
) -> Result<(), FemGpuExecutionReceiptValidationError> {
    if !receipt.accounting_valid {
        return Err(FemGpuExecutionReceiptValidationError::AccountingInvalid);
    }
    if receipt.execution_class != FemGpuExecutionClass::DeviceResident
        || receipt.resolved != "device_resident"
        || receipt.executed != "cuda_fem"
    {
        return Err(FemGpuExecutionReceiptValidationError::ExecutionClassMismatch);
    }
    if receipt.resolved_host_operator_mask != 0 {
        return Err(FemGpuExecutionReceiptValidationError::ResolvedHostOperator);
    }
    if receipt.resolved_unknown_operator_mask != 0 {
        return Err(FemGpuExecutionReceiptValidationError::ResolvedUnknownOperator);
    }
    if receipt.executed_host_operator_mask != 0 {
        return Err(FemGpuExecutionReceiptValidationError::HostOperatorExecuted);
    }
    if receipt.executed_unknown_operator_mask != 0 {
        return Err(FemGpuExecutionReceiptValidationError::UnknownOperatorExecuted);
    }
    if receipt.required_operator_mask == 0
        || receipt.resolved_device_operator_mask != receipt.required_operator_mask
        || receipt.executed_device_operator_mask != receipt.required_operator_mask
    {
        return Err(FemGpuExecutionReceiptValidationError::RequiredOperatorMissing);
    }
    if receipt.fallback_count != 0 {
        return Err(FemGpuExecutionReceiptValidationError::FallbackObserved);
    }
    if receipt.accepted_step_count == 0 {
        return Err(FemGpuExecutionReceiptValidationError::NoAcceptedStep);
    }
    if receipt.hot_loop_compute_h2d_bytes != 0
        || receipt.hot_loop_compute_d2h_bytes != 0
        || receipt.hot_loop_compute_host_sync_count != 0
    {
        return Err(FemGpuExecutionReceiptValidationError::HotLoopTransferObserved);
    }
    Ok(())
}

pub(crate) fn validate_strict_fem_gpu_execution_receipt_v2_runtime(
    receipt: &FemGpuExecutionReceiptV2,
) -> Result<(), FemGpuExecutionReceiptValidationError> {
    if !receipt.accounting_valid {
        return Err(FemGpuExecutionReceiptValidationError::AccountingInvalid);
    }
    if !receipt.lifecycle_valid {
        return Err(FemGpuExecutionReceiptValidationError::LifecycleInvalid);
    }
    if !receipt.identity_valid {
        return Err(FemGpuExecutionReceiptValidationError::IdentityInvalid);
    }
    if receipt.execution_generation_id == 0 {
        return Err(FemGpuExecutionReceiptValidationError::GenerationMismatch);
    }
    if receipt.execution_class != FemGpuExecutionClass::DeviceResident
        || receipt.resolved != "device_resident"
        || receipt.executed != "cuda_fem"
    {
        return Err(FemGpuExecutionReceiptValidationError::ExecutionClassMismatch);
    }
    if receipt.resolved_host_operator_mask != 0 {
        return Err(FemGpuExecutionReceiptValidationError::ResolvedHostOperator);
    }
    if receipt.resolved_unknown_operator_mask != 0 {
        return Err(FemGpuExecutionReceiptValidationError::ResolvedUnknownOperator);
    }
    if receipt.executed_host_operator_mask != 0 {
        return Err(FemGpuExecutionReceiptValidationError::HostOperatorExecuted);
    }
    if receipt.executed_unknown_operator_mask != 0 {
        return Err(FemGpuExecutionReceiptValidationError::UnknownOperatorExecuted);
    }
    if receipt.required_operator_mask == 0
        || receipt.resolved_device_operator_mask != receipt.required_operator_mask
        || receipt.executed_device_operator_mask != receipt.required_operator_mask
    {
        return Err(FemGpuExecutionReceiptValidationError::RequiredOperatorMissing);
    }
    if receipt.fallback_count != 0 {
        return Err(FemGpuExecutionReceiptValidationError::FallbackObserved);
    }
    if receipt.accepted_step_count == 0
        && receipt.terminal_outcome == FemGpuTerminalOutcome::CompletedAccepted
    {
        return Err(FemGpuExecutionReceiptValidationError::NoAcceptedStep);
    }
    if receipt.hot_loop_compute_h2d_bytes != 0
        || receipt.hot_loop_compute_d2h_bytes != 0
        || receipt.hot_loop_compute_host_sync_count != 0
        || receipt.compute_h2d_bytes != 0
        || receipt.compute_d2h_bytes != 0
        || receipt.compute_host_sync_count != 0
        || receipt.exchange_h2d_bytes != 0
        || receipt.exchange_d2h_bytes != 0
        || receipt.exchange_host_sync_count != 0
    {
        return Err(FemGpuExecutionReceiptValidationError::HotLoopTransferObserved);
    }
    if receipt.transfer_violation_mask != 0 {
        return Err(FemGpuExecutionReceiptValidationError::TransferViolationObserved);
    }
    if receipt.residency_violation_count != 0 {
        return Err(FemGpuExecutionReceiptValidationError::ResidencyViolationObserved);
    }
    if !receipt.compute_closed {
        return Err(FemGpuExecutionReceiptValidationError::ComputeNotClosed);
    }
    Ok(())
}

pub(crate) fn validate_strict_fem_gpu_execution_receipt_v2(
    receipt: &FemGpuExecutionReceiptV2,
) -> Result<(), FemGpuExecutionReceiptValidationError> {
    validate_strict_fem_gpu_execution_receipt_v2_runtime(receipt)?;
    if !receipt.observation_closed {
        return Err(FemGpuExecutionReceiptValidationError::ObservationNotClosed);
    }
    Ok(())
}

pub(crate) fn validate_strict_fem_gpu_performance_snapshot_v3(
    snapshot: &FemGpuPerformanceSnapshotV3,
    receipt: &FemGpuExecutionReceiptV2,
) -> Result<(), FemGpuPerformanceSnapshotValidationError> {
    if snapshot.execution_generation_id == 0
        || snapshot.execution_generation_id != receipt.execution_generation_id
    {
        return Err(FemGpuPerformanceSnapshotValidationError::GenerationMismatch);
    }
    if !snapshot.frozen {
        return Err(FemGpuPerformanceSnapshotValidationError::SnapshotNotFrozen);
    }
    if snapshot.terminal_outcome != FemGpuTerminalOutcome::CompletedAccepted {
        return Err(FemGpuPerformanceSnapshotValidationError::TerminalOutcomeNotCompletedAccepted);
    }
    if snapshot.accepted_step_count == 0 {
        return Err(FemGpuPerformanceSnapshotValidationError::NoAcceptedStep);
    }
    if snapshot.accepted_effective_field_applies > snapshot.physical_effective_field_applies
        || snapshot.accepted_energy_evaluations > snapshot.physical_energy_evaluations
        || snapshot.accepted_armijo_candidates > snapshot.physical_armijo_candidates
        || snapshot.accepted_rhs_evaluations > snapshot.physical_rhs_evaluations
        || snapshot.accepted_exchange_applies > snapshot.physical_exchange_applies
        || snapshot.accepted_exchange_launches > snapshot.physical_exchange_launches
        || snapshot.accepted_exchange_nnz_visited > snapshot.physical_exchange_nnz_visited
        || snapshot.accepted_demag_solves > snapshot.physical_demag_solves
        || snapshot.accepted_demag_iterations > snapshot.physical_demag_iterations
        || snapshot.accepted_normalization_launches > snapshot.physical_normalization_launches
        || snapshot.accepted_normalization_readbacks > snapshot.physical_normalization_readbacks
        || snapshot.accepted_adaptive_readbacks > snapshot.physical_adaptive_readbacks
        || snapshot.accepted_control_fences > snapshot.physical_control_fences
        || snapshot.accepted_endpoint_cache_hits > snapshot.physical_endpoint_cache_hits
        || snapshot.accepted_endpoint_cache_misses > snapshot.physical_endpoint_cache_misses
        || snapshot.accepted_endpoint_cache_invalidations
            > snapshot.physical_endpoint_cache_invalidations
        || snapshot.accepted_device_to_device_bytes > snapshot.physical_device_to_device_bytes
        || snapshot.accepted_exchange_elapsed_ns > snapshot.physical_exchange_elapsed_ns
        || snapshot.accepted_demag_assemble_elapsed_ns
            > snapshot.physical_demag_assemble_elapsed_ns
        || snapshot.accepted_demag_recover_elapsed_ns > snapshot.physical_demag_recover_elapsed_ns
        || snapshot.accepted_demag_energy_elapsed_ns > snapshot.physical_demag_energy_elapsed_ns
        || snapshot.accepted_rhs_elapsed_ns > snapshot.physical_rhs_elapsed_ns
    {
        return Err(FemGpuPerformanceSnapshotValidationError::AcceptedCountersExceedPhysical);
    }
    if snapshot.compute_h2d_bytes != 0
        || snapshot.compute_d2h_bytes != 0
        || snapshot.compute_host_sync_count != 0
    {
        return Err(FemGpuPerformanceSnapshotValidationError::ComputeTransferObserved);
    }
    if snapshot.exchange_h2d_bytes != 0
        || snapshot.exchange_d2h_bytes != 0
        || snapshot.exchange_host_sync_count != 0
    {
        return Err(FemGpuPerformanceSnapshotValidationError::ExchangeTransferObserved);
    }
    if snapshot.residency_violation_count != 0 {
        return Err(FemGpuPerformanceSnapshotValidationError::ResidencyViolationObserved);
    }
    if snapshot.unclassified_event_count != 0 {
        return Err(FemGpuPerformanceSnapshotValidationError::UnclassifiedEventsObserved);
    }
    if snapshot.required_coverage_mask != 0
        && (snapshot.kernel_launch_coverage_mask & snapshot.required_coverage_mask)
            != snapshot.required_coverage_mask
    {
        return Err(FemGpuPerformanceSnapshotValidationError::CoverageMissing);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn performance_snapshot_fixture() -> FemGpuPerformanceSnapshotSummary {
        FemGpuPerformanceSnapshotSummary {
            abi_version: FEM_GPU_PERFORMANCE_SNAPSHOT_ABI_V1,
            struct_size: FEM_GPU_PERFORMANCE_SNAPSHOT_V1_SIZE,
            available: true,
            execution_class: FemGpuExecutionClass::DeviceResident,
            completed_step: 1,
            completed_attempt_count: 1,
            rejected_attempt_count: 0,
            failed_attempt_count: 0,
            physical_rhs_evaluations: 4,
            accepted_rhs_evaluations: 4,
            physical_device_to_device_bytes: 96,
            accepted_device_to_device_bytes: 96,
        }
    }

    fn strict_receipt_fixture() -> FemGpuExecutionReceipt {
        FemGpuExecutionReceipt {
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
            executed_host_operator_mask: 0,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 1,
            rejected_attempt_count: 0,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
            accounting_valid: true,
        }
    }

    #[test]
    fn accepts_complete_strict_device_execution() {
        assert!(validate_strict_fem_gpu_execution_receipt(&strict_receipt_fixture()).is_ok());
    }

    #[test]
    fn rejects_each_strict_violation_with_stable_code() {
        let cases = [
            (
                "host",
                FemGpuExecutionReceiptValidationError::HostOperatorExecuted,
            ),
            (
                "unknown",
                FemGpuExecutionReceiptValidationError::UnknownOperatorExecuted,
            ),
            (
                "missing",
                FemGpuExecutionReceiptValidationError::RequiredOperatorMissing,
            ),
            (
                "fallback",
                FemGpuExecutionReceiptValidationError::FallbackObserved,
            ),
            (
                "class",
                FemGpuExecutionReceiptValidationError::ExecutionClassMismatch,
            ),
            (
                "transfer",
                FemGpuExecutionReceiptValidationError::HotLoopTransferObserved,
            ),
        ];
        for (case, expected) in cases {
            let mut receipt = strict_receipt_fixture();
            match case {
                "host" => receipt.executed_host_operator_mask = 1,
                "unknown" => receipt.executed_unknown_operator_mask = 1,
                "missing" => receipt.executed_device_operator_mask &= !1,
                "fallback" => receipt.fallback_count = 1,
                "class" => receipt.execution_class = FemGpuExecutionClass::HybridCpuPoisson,
                "transfer" => receipt.hot_loop_compute_d2h_bytes = 8,
                _ => unreachable!(),
            }
            assert_eq!(
                validate_strict_fem_gpu_execution_receipt(&receipt),
                Err(expected)
            );
            assert!(expected.token().starts_with("fem_gpu_receipt_"));
        }
    }

    #[test]
    fn accepts_transactional_performance_snapshot_summary() {
        assert!(validate_fem_gpu_performance_snapshot(&performance_snapshot_fixture()).is_ok());
    }

    #[test]
    fn rejects_unavailable_or_non_monotonic_performance_snapshot() {
        let mut snapshot = performance_snapshot_fixture();
        snapshot.available = false;
        assert_eq!(
            validate_fem_gpu_performance_snapshot(&snapshot),
            Err(FemGpuPerformanceSnapshotValidationError::Unavailable)
        );
        let mut snapshot = performance_snapshot_fixture();
        snapshot.accepted_rhs_evaluations = 5;
        assert_eq!(
            validate_fem_gpu_performance_snapshot(&snapshot),
            Err(FemGpuPerformanceSnapshotValidationError::AcceptedCountersExceedPhysical)
        );
    }

    fn strict_receipt_v2_fixture() -> FemGpuExecutionReceiptV2 {
        FemGpuExecutionReceiptV2 {
            requested: "strict_device".into(),
            resolved: "device_resident".into(),
            executed: "cuda_fem".into(),
            execution_class: FemGpuExecutionClass::DeviceResident,
            device_ordinal: 0,
            precision: "double".into(),
            integrator: "none".into(),
            required_operator_mask: 0x7fff,
            resolved_device_operator_mask: 0x7fff,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: 0x7fff,
            executed_host_operator_mask: 0,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 5,
            rejected_attempt_count: 1,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
            execution_kind: crate::types::FemGpuExecutionKind::DirectMinimizer,
            relaxation_algorithm: crate::types::FemGpuRelaxationAlgorithm::NonlinearCg,
            attempt_model: crate::types::FemGpuAttemptModel::OuterStepWithArmijoCandidates,
            control_policy: crate::types::FemGpuControlPolicy::BoundedHostScalarControl,
            execution_generation_id: 1001,
            terminal_outcome: FemGpuTerminalOutcome::CompletedAccepted,
            compute_closed: true,
            observation_closed: true,
            outer_attempt_count: 5,
            rejected_candidate_count: 2,
            failed_candidate_count: 0,
            stationary_observation_count: 0,
            cancelled_outer_attempt_count: 0,
            paused_outer_attempt_count: 0,
            refinement_evaluation_count: 1,
            allowed_transfer_mask: 0x3,
            observed_transfer_mask: 0x1,
            transfer_violation_mask: 0,
            setup_h2d_bytes: 1024,
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
            snapshot_d2h_bytes: 512,
            snapshot_host_sync_count: 1,
            export_h2d_bytes: 0,
            export_d2h_bytes: 0,
            export_host_sync_count: 0,
            initial_residency: 1,
            final_residency: 1,
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

    fn strict_snapshot_v3_fixture() -> FemGpuPerformanceSnapshotV3 {
        FemGpuPerformanceSnapshotV3 {
            abi_version: 3,
            struct_size: 792,
            setup_count: 1,
            apply_count: 5,
            kernel_launch_count: 20,
            compute_fence_count: 0,
            snapshot_fence_count: 1,
            export_fence_count: 0,
            selected_sparse_kernel_id: 1,
            setup_wall_time_ns: 100,
            apply_wall_time_ns: 500,
            accepted_finalization_wall_time_ns: 50,
            execution_kind: crate::types::FemGpuExecutionKind::DirectMinimizer,
            relaxation_algorithm: crate::types::FemGpuRelaxationAlgorithm::NonlinearCg,
            attempt_model: crate::types::FemGpuAttemptModel::OuterStepWithArmijoCandidates,
            control_policy: crate::types::FemGpuControlPolicy::BoundedHostScalarControl,
            terminal_outcome: FemGpuTerminalOutcome::CompletedAccepted,
            execution_class: FemGpuExecutionClass::DeviceResident,
            precision: "double".into(),
            device_ordinal: 0,
            execution_generation_id: 1001,
            available: true,
            compute_closed: true,
            observation_closed: true,
            frozen: true,
            accepted_step_count: 5,
            physical_outer_attempt_count: 5,
            rejected_candidate_count: 2,
            failed_candidate_count: 0,
            cancelled_outer_attempt_count: 0,
            paused_outer_attempt_count: 0,
            failed_outer_attempt_count: 0,
            stationary_observation_count: 0,
            refinement_evaluation_count: 1,
            physical_effective_field_applies: 10,
            physical_energy_evaluations: 12,
            physical_armijo_candidates: 4,
            physical_rhs_evaluations: 10,
            physical_exchange_applies: 10,
            physical_exchange_launches: 10,
            physical_exchange_nnz_visited: 5000,
            physical_demag_solves: 10,
            physical_demag_iterations: 40,
            physical_normalization_launches: 15,
            physical_normalization_readbacks: 3,
            physical_adaptive_readbacks: 0,
            physical_control_fences: 4,
            physical_endpoint_cache_hits: 2,
            physical_endpoint_cache_misses: 1,
            physical_endpoint_cache_invalidations: 0,
            accepted_effective_field_applies: 10,
            accepted_energy_evaluations: 12,
            accepted_armijo_candidates: 4,
            accepted_rhs_evaluations: 10,
            accepted_exchange_applies: 10,
            accepted_exchange_launches: 10,
            accepted_exchange_nnz_visited: 5000,
            accepted_demag_solves: 10,
            accepted_demag_iterations: 40,
            accepted_normalization_launches: 15,
            accepted_normalization_readbacks: 3,
            accepted_adaptive_readbacks: 0,
            accepted_control_fences: 4,
            accepted_endpoint_cache_hits: 2,
            accepted_endpoint_cache_misses: 1,
            accepted_endpoint_cache_invalidations: 0,
            physical_device_to_device_bytes: 4096,
            accepted_device_to_device_bytes: 4096,
            setup_h2d_bytes: 1024,
            setup_d2h_bytes: 0,
            compute_h2d_bytes: 0,
            compute_d2h_bytes: 0,
            control_h2d_bytes: 0,
            control_d2h_bytes: 32,
            exchange_h2d_bytes: 0,
            exchange_d2h_bytes: 0,
            snapshot_h2d_bytes: 0,
            snapshot_d2h_bytes: 512,
            export_h2d_bytes: 0,
            export_d2h_bytes: 0,
            compute_host_sync_count: 0,
            control_host_sync_count: 4,
            exchange_host_sync_count: 0,
            snapshot_host_sync_count: 1,
            export_host_sync_count: 0,
            kernel_launch_coverage_mask: 0x7ff,
            required_coverage_mask: 0x7ff,
            unclassified_event_count: 0,
            initial_residency: 1,
            final_residency: 1,
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
    fn strict_validation_v2_and_v3() {
        let receipt = strict_receipt_v2_fixture();
        assert!(validate_strict_fem_gpu_execution_receipt_v2(&receipt).is_ok());

        let snapshot = strict_snapshot_v3_fixture();
        assert!(validate_strict_fem_gpu_performance_snapshot_v3(&snapshot, &receipt).is_ok());

        let mut bad_receipt = receipt.clone();
        bad_receipt.transfer_violation_mask = 1;
        assert_eq!(
            validate_strict_fem_gpu_execution_receipt_v2(&bad_receipt),
            Err(FemGpuExecutionReceiptValidationError::TransferViolationObserved)
        );

        let mut bad_snapshot = snapshot.clone();
        bad_snapshot.execution_generation_id = 999;
        assert_eq!(
            validate_strict_fem_gpu_performance_snapshot_v3(&bad_snapshot, &receipt),
            Err(FemGpuPerformanceSnapshotValidationError::GenerationMismatch)
        );
    }
}
