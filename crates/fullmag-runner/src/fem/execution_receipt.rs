//! Validation boundary for native FEM GPU execution receipts.

use crate::types::{FemGpuExecutionClass, FemGpuExecutionReceipt};

pub(crate) const FEM_GPU_PERFORMANCE_SNAPSHOT_ABI_V1: u32 = 1;
pub(crate) const FEM_GPU_PERFORMANCE_SNAPSHOT_V1_SIZE: u32 = 480;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FemGpuPerformanceSnapshotValidationError {
    AbiMismatch,
    Unavailable,
    ExecutionClassMismatch,
    NoCompletedStep,
    AcceptedCountersExceedPhysical,
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
}
