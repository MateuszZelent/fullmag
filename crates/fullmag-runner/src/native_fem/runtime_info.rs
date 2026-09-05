use fullmag_fem_sys as ffi;
use fullmag_ir::{StageCompletionIR, StageMetricKind, StageStopReason};

use crate::types::{
    FemGpuAttemptModel, FemGpuControlPolicy, FemGpuExecutionClass, FemGpuExecutionKind,
    FemGpuExecutionReceipt, FemGpuExecutionReceiptV2, FemGpuPerformanceSnapshotV2,
    FemGpuPerformanceSnapshotV3, FemGpuRelaxationAlgorithm, FemGpuTerminalOutcome, RunError,
};

use std::ffi::CStr;

#[derive(Debug, Clone)]
pub(crate) struct DeviceInfo {
    pub name: String,
    pub compute_capability: String,
    pub driver_version: i32,
    pub runtime_version: i32,
    pub memory_free_bytes: u64,
    pub memory_total_bytes: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct RuntimeBuildInfo {
    pub mfem_version: String,
    pub hypre_version: String,
}

pub(crate) fn runtime_build_info() -> Result<RuntimeBuildInfo, RunError> {
    let mut info = ffi::fullmag_fem_runtime_build_info_v2 {
        abi_version: 0,
        struct_size: 0,
        mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
        hypre_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY],
    };
    let rc = unsafe { ffi::fullmag_fem_get_runtime_build_info_v2(&mut info) };
    if rc != ffi::FULLMAG_FEM_OK {
        return Err(RunError {
            message: "native FEM runtime build identity is unavailable".to_string(),
        });
    }
    RuntimeBuildInfo::from_ffi(info)
}

pub(crate) fn strict_gpu_mfem_version() -> Result<String, RunError> {
    runtime_build_info().map(|info| info.mfem_version)
}

pub(crate) fn strict_gpu_runtime_build_info() -> Result<RuntimeBuildInfo, RunError> {
    runtime_build_info()
}

impl RuntimeBuildInfo {
    fn from_ffi(info: ffi::fullmag_fem_runtime_build_info_v2) -> Result<Self, RunError> {
        if info.abi_version != ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_V2_ABI_VERSION
            || info.struct_size
                != std::mem::size_of::<ffi::fullmag_fem_runtime_build_info_v2>() as u32
        {
            return Err(RunError {
                message: "native FEM runtime build identity ABI is incompatible".to_string(),
            });
        }
        fn parse_version(bytes: &[std::ffi::c_char], library: &str) -> Result<String, RunError> {
            let Some(nul_index) = bytes.iter().position(|byte| *byte == 0) else {
                return Err(RunError {
                    message: format!(
                        "native FEM runtime build identity {library} version is not NUL terminated"
                    ),
                });
            };
            let version = std::str::from_utf8(unsafe {
                std::slice::from_raw_parts(bytes.as_ptr().cast::<u8>(), nul_index)
            })
            .map_err(|_| RunError {
                message: format!(
                    "native FEM runtime build identity {library} version is not UTF-8"
                ),
            })?
            .to_string();
            if version.is_empty() {
                return Err(RunError {
                    message: format!(
                        "native FEM runtime build identity did not publish {library} version"
                    ),
                });
            }
            Ok(version)
        }
        Ok(Self {
            mfem_version: parse_version(&info.mfem_version, "MFEM")?,
            hypre_version: parse_version(&info.hypre_version, "HYPRE")?,
        })
    }
}

#[cfg(test)]
mod runtime_build_info_tests {
    use super::*;

    #[test]
    fn accepts_versioned_mfem_identity_from_loaded_native_abi() {
        let mut info = ffi::fullmag_fem_runtime_build_info_v2 {
            abi_version: ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_V2_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_runtime_build_info_v2>() as u32,
            mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
            hypre_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY],
        };
        info.mfem_version[..4].copy_from_slice(&[b'4' as _, b'.' as _, b'9' as _, 0]);
        info.hypre_version[..6]
            .copy_from_slice(&[b'3' as _, b'.' as _, b'1' as _, b'.' as _, b'0' as _, 0]);

        let parsed = RuntimeBuildInfo::from_ffi(info).unwrap();
        assert_eq!(parsed.mfem_version, "4.9");
        assert_eq!(parsed.hypre_version, "3.1.0");
    }

    #[test]
    fn rejects_missing_mfem_identity_from_loaded_native_abi() {
        let info = ffi::fullmag_fem_runtime_build_info_v2 {
            abi_version: ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_V2_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_runtime_build_info_v2>() as u32,
            mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
            hypre_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY],
        };

        assert!(RuntimeBuildInfo::from_ffi(info).is_err());
    }

    #[test]
    fn rejects_missing_hypre_identity_from_loaded_native_abi() {
        let mut info = ffi::fullmag_fem_runtime_build_info_v2 {
            abi_version: ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_V2_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_runtime_build_info_v2>() as u32,
            mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
            hypre_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY],
        };
        info.mfem_version[..4].copy_from_slice(&[b'4' as _, b'.' as _, b'9' as _, 0]);

        assert!(RuntimeBuildInfo::from_ffi(info).is_err());
    }

    #[test]
    fn rejects_incompatible_runtime_build_identity_abi() {
        let mut info = ffi::fullmag_fem_runtime_build_info_v2 {
            abi_version: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_runtime_build_info_v2>() as u32,
            mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
            hypre_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY],
        };
        info.mfem_version[..4].copy_from_slice(&[b'4' as _, b'.' as _, b'9' as _, 0]);

        assert!(RuntimeBuildInfo::from_ffi(info).is_err());
    }

    #[test]
    fn rejects_runtime_build_identity_without_bounded_nul_terminator() {
        let info = ffi::fullmag_fem_runtime_build_info_v2 {
            abi_version: ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_V2_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_runtime_build_info_v2>() as u32,
            mfem_version: [b'4' as _; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
            hypre_version: [b'3' as _; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY],
        };

        assert!(RuntimeBuildInfo::from_ffi(info).is_err());
    }

    #[test]
    fn rejects_nonterminated_hypre_identity_from_loaded_native_abi() {
        let mut info = ffi::fullmag_fem_runtime_build_info_v2 {
            abi_version: ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_V2_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_runtime_build_info_v2>() as u32,
            mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
            hypre_version: [b'3' as _; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY],
        };
        info.mfem_version[..4].copy_from_slice(&[b'4' as _, b'.' as _, b'9' as _, 0]);

        assert!(RuntimeBuildInfo::from_ffi(info).is_err());
    }

    #[test]
    fn rejects_runtime_build_identity_with_struct_size_mismatch() {
        let mut info = ffi::fullmag_fem_runtime_build_info_v2 {
            abi_version: ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_V2_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_runtime_build_info_v2>() as u32 - 1,
            mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
            hypre_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_HYPRE_VERSION_CAPACITY],
        };
        info.mfem_version[..4].copy_from_slice(&[b'4' as _, b'.' as _, b'9' as _, 0]);

        assert!(RuntimeBuildInfo::from_ffi(info).is_err());
    }
}

impl DeviceInfo {
    pub(crate) fn from_ffi(info: ffi::fullmag_fem_device_info) -> Self {
        let name = unsafe { CStr::from_ptr(info.name.as_ptr()) }
            .to_string_lossy()
            .to_string();
        Self {
            name,
            compute_capability: format!(
                "{}.{}",
                info.compute_capability_major, info.compute_capability_minor
            ),
            driver_version: info.driver_version,
            runtime_version: info.runtime_version,
            memory_free_bytes: info.gpu_memory_free_bytes,
            memory_total_bytes: info.gpu_memory_total_bytes,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeFemDataResidency {
    HostSourceOfTruth,
    Mixed,
    DeviceSourceOfTruth,
}

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

const FEM_GPU_KNOWN_OPERATOR_MASK: u64 = ffi::FULLMAG_FEM_GPU_OPERATOR_EXCHANGE
    | ffi::FULLMAG_FEM_GPU_OPERATOR_DEMAG_RHS
    | ffi::FULLMAG_FEM_GPU_OPERATOR_DEMAG_SOLVE
    | ffi::FULLMAG_FEM_GPU_OPERATOR_DEMAG_RECOVERY
    | ffi::FULLMAG_FEM_GPU_OPERATOR_LOCAL_FIELDS
    | ffi::FULLMAG_FEM_GPU_OPERATOR_DIRECT_TORQUES
    | ffi::FULLMAG_FEM_GPU_OPERATOR_LLG_RHS
    | ffi::FULLMAG_FEM_GPU_OPERATOR_RK_STEPPER
    | ffi::FULLMAG_FEM_GPU_OPERATOR_REDUCTIONS
    | ffi::FULLMAG_FEM_GPU_OPERATOR_PRECONDITIONER;

const FEM_GPU_KNOWN_OPERATOR_MASK_V2: u64 = FEM_GPU_KNOWN_OPERATOR_MASK
    | ffi::FULLMAG_FEM_GPU_OPERATOR_DIRECT_MINIMIZER
    | ffi::FULLMAG_FEM_GPU_OPERATOR_NONLINEAR_CG_UPDATE
    | ffi::FULLMAG_FEM_GPU_OPERATOR_RETRACTION
    | ffi::FULLMAG_FEM_GPU_OPERATOR_LINE_SEARCH
    | ffi::FULLMAG_FEM_GPU_OPERATOR_ARMIJO_ENERGY
    | ffi::FULLMAG_FEM_GPU_OPERATOR_DIRECT_ENERGY_REFINEMENT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NativeFemGpuExecutionReceipt {
    execution_class: FemGpuExecutionClass,
    device_ordinal: i32,
    precision: &'static str,
    integrator: &'static str,
    required_operator_mask: u64,
    resolved_device_operator_mask: u64,
    resolved_host_operator_mask: u64,
    resolved_unknown_operator_mask: u64,
    executed_device_operator_mask: u64,
    executed_host_operator_mask: u64,
    executed_unknown_operator_mask: u64,
    fallback_count: u64,
    accepted_step_count: u64,
    rejected_attempt_count: u64,
    failed_attempt_count: u64,
    hot_loop_compute_h2d_bytes: u64,
    hot_loop_compute_d2h_bytes: u64,
    hot_loop_compute_host_sync_count: u64,
}

impl NativeFemGpuExecutionReceipt {
    pub(crate) fn from_ffi(
        receipt: ffi::fullmag_fem_gpu_execution_receipt_v1,
    ) -> Result<Self, RunError> {
        if receipt.abi_version != ffi::FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1
            || receipt.struct_size
                != std::mem::size_of::<ffi::fullmag_fem_gpu_execution_receipt_v1>() as u32
        {
            return Err(receipt_error("abi_mismatch"));
        }
        let execution_class = match receipt.execution_class {
            value if value
                == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT
                    as u32 => FemGpuExecutionClass::DeviceResident,
            value if value
                == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_GPU_OPERATOR_HOST_SOLVER
                    as u32 => FemGpuExecutionClass::GpuOperatorHostSolver,
            value if value
                == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_HYBRID_CPU_POISSON
                    as u32 => FemGpuExecutionClass::HybridCpuPoisson,
            value if value
                == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_CPU as u32 => {
                    FemGpuExecutionClass::Cpu
                }
            _ => return Err(receipt_error("unknown_execution_class")),
        };
        let precision = match receipt.precision {
            value if value == ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_SINGLE as u32 => {
                "single"
            }
            value if value == ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_DOUBLE as u32 => {
                "double"
            }
            _ => return Err(receipt_error("unknown_precision")),
        };
        let integrator = match receipt.integrator {
            value if value == ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_HEUN as u32 => {
                "heun"
            }
            value if value == ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_RK4 as u32 => {
                "rk4"
            }
            value
                if value == ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_RK23_BS as u32 =>
            {
                "rk23"
            }
            value
                if value
                    == ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_RK45_DP54 as u32 =>
            {
                "rk45"
            }
            _ => return Err(receipt_error("unknown_integrator")),
        };
        let all_masks = receipt.required_operator_mask
            | receipt.resolved_device_operator_mask
            | receipt.resolved_host_operator_mask
            | receipt.resolved_unknown_operator_mask
            | receipt.executed_device_operator_mask
            | receipt.executed_host_operator_mask
            | receipt.executed_unknown_operator_mask;
        if all_masks & !FEM_GPU_KNOWN_OPERATOR_MASK != 0 {
            return Err(receipt_error("unknown_operator_bits"));
        }
        Ok(Self {
            execution_class,
            device_ordinal: receipt.device_ordinal,
            precision,
            integrator,
            required_operator_mask: receipt.required_operator_mask,
            resolved_device_operator_mask: receipt.resolved_device_operator_mask,
            resolved_host_operator_mask: receipt.resolved_host_operator_mask,
            resolved_unknown_operator_mask: receipt.resolved_unknown_operator_mask,
            executed_device_operator_mask: receipt.executed_device_operator_mask,
            executed_host_operator_mask: receipt.executed_host_operator_mask,
            executed_unknown_operator_mask: receipt.executed_unknown_operator_mask,
            fallback_count: receipt.fallback_count,
            accepted_step_count: receipt.accepted_step_count,
            rejected_attempt_count: receipt.rejected_attempt_count,
            failed_attempt_count: receipt.failed_attempt_count,
            hot_loop_compute_h2d_bytes: receipt.hot_loop_compute_h2d_bytes,
            hot_loop_compute_d2h_bytes: receipt.hot_loop_compute_d2h_bytes,
            hot_loop_compute_host_sync_count: receipt.hot_loop_compute_host_sync_count,
        })
    }

    pub(crate) fn into_provenance(self, requested: &str) -> FemGpuExecutionReceipt {
        let resolved = execution_class_name(self.execution_class);
        let executed = if self.accepted_step_count == 0 {
            "none"
        } else {
            match self.execution_class {
                FemGpuExecutionClass::DeviceResident => "cuda_fem",
                FemGpuExecutionClass::GpuOperatorHostSolver => "cuda_fem_host_solver",
                FemGpuExecutionClass::HybridCpuPoisson => "cuda_fem_hybrid_cpu_poisson",
                FemGpuExecutionClass::Cpu => "cpu_fem",
            }
        };
        FemGpuExecutionReceipt {
            requested: requested.to_string(),
            resolved: resolved.to_string(),
            executed: executed.to_string(),
            execution_class: self.execution_class,
            device_ordinal: self.device_ordinal,
            precision: self.precision.to_string(),
            integrator: self.integrator.to_string(),
            required_operator_mask: self.required_operator_mask,
            resolved_device_operator_mask: self.resolved_device_operator_mask,
            resolved_host_operator_mask: self.resolved_host_operator_mask,
            resolved_unknown_operator_mask: self.resolved_unknown_operator_mask,
            executed_device_operator_mask: self.executed_device_operator_mask,
            executed_host_operator_mask: self.executed_host_operator_mask,
            executed_unknown_operator_mask: self.executed_unknown_operator_mask,
            fallback_count: self.fallback_count,
            accepted_step_count: self.accepted_step_count,
            rejected_attempt_count: self.rejected_attempt_count,
            failed_attempt_count: self.failed_attempt_count,
            hot_loop_compute_h2d_bytes: self.hot_loop_compute_h2d_bytes,
            hot_loop_compute_d2h_bytes: self.hot_loop_compute_d2h_bytes,
            hot_loop_compute_host_sync_count: self.hot_loop_compute_host_sync_count,
            // ABI v1 intentionally omits this field. Native query success is
            // fail-closed on both plan_resolved and accounting_valid, so Rust
            // may publish true only after that successful query.
            accounting_valid: true,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct NativeFemGpuPerformanceSnapshot {
    pub(crate) snapshot: FemGpuPerformanceSnapshotV2,
}

impl NativeFemGpuPerformanceSnapshot {
    pub(crate) fn from_ffi(
        snapshot: ffi::fullmag_fem_gpu_performance_snapshot_v2,
    ) -> Result<Self, RunError> {
        if snapshot.abi_version != ffi::FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION
            || snapshot.struct_size
                != std::mem::size_of::<ffi::fullmag_fem_gpu_performance_snapshot_v2>() as u32
        {
            return Err(receipt_error("performance_snapshot_v2_abi_mismatch"));
        }
        Ok(Self {
            snapshot: FemGpuPerformanceSnapshotV2 {
                abi_version: snapshot.abi_version,
                struct_size: snapshot.struct_size,
                setup_count: snapshot.setup_count,
                apply_count: snapshot.apply_count,
                kernel_launch_count: snapshot.kernel_launch_count,
                compute_fence_count: snapshot.compute_fence_count,
                snapshot_fence_count: snapshot.snapshot_fence_count,
                export_fence_count: snapshot.export_fence_count,
                selected_sparse_kernel_id: snapshot.selected_sparse_kernel_id,
                setup_wall_time_ns: snapshot.setup_wall_time_ns,
                apply_wall_time_ns: snapshot.apply_wall_time_ns,
                accepted_finalization_wall_time_ns: snapshot.accepted_finalization_wall_time_ns,
            },
        })
    }

    pub(crate) fn abi_is_current(&self) -> bool {
        self.snapshot.abi_version == ffi::FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION
            && self.snapshot.struct_size
                == std::mem::size_of::<ffi::fullmag_fem_gpu_performance_snapshot_v2>() as u32
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeFemGpuExecutionReceiptV2 {
    pub(crate) receipt: FemGpuExecutionReceiptV2,
}

impl NativeFemGpuExecutionReceiptV2 {
    pub(crate) fn from_ffi(
        receipt: ffi::fullmag_fem_gpu_execution_receipt_v2,
        requested: &str,
    ) -> Result<Self, RunError> {
        if receipt.abi_version != ffi::FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2
            || receipt.struct_size
                != std::mem::size_of::<ffi::fullmag_fem_gpu_execution_receipt_v2>() as u32
        {
            return Err(receipt_error("execution_receipt_v2_abi_mismatch"));
        }
        let execution_class = match receipt.execution_class {
            x if x
                == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT
                    as u32 =>
            {
                FemGpuExecutionClass::DeviceResident
            }
            x if x
                == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_GPU_OPERATOR_HOST_SOLVER
                    as u32 =>
            {
                FemGpuExecutionClass::GpuOperatorHostSolver
            }
            x if x
                == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_HYBRID_CPU_POISSON
                    as u32 =>
            {
                FemGpuExecutionClass::HybridCpuPoisson
            }
            x if x == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_CPU as u32 => {
                FemGpuExecutionClass::Cpu
            }
            _ => return Err(receipt_error("unknown_execution_class")),
        };
        let precision = match receipt.precision {
            x if x == ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_SINGLE as u32 => "single",
            x if x == ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_DOUBLE as u32 => "double",
            _ => return Err(receipt_error("unknown_precision")),
        };
        let integrator = match receipt.integrator {
            0 => "none",
            value if value == ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_HEUN as u32 => {
                "heun"
            }
            value if value == ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_RK4 as u32 => {
                "rk4"
            }
            value
                if value == ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_RK23_BS as u32 =>
            {
                "rk23"
            }
            value
                if value
                    == ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_RK45_DP54 as u32 =>
            {
                "rk45"
            }
            _ => return Err(receipt_error("unknown_integrator")),
        };
        let execution_kind = match receipt.execution_kind {
            x if x
                == ffi::fullmag_fem_gpu_execution_kind_v2::FULLMAG_FEM_GPU_EXECUTION_KIND_UNKNOWN
                    as u32 =>
            {
                FemGpuExecutionKind::Unknown
            }
            x if x
                == ffi::fullmag_fem_gpu_execution_kind_v2::FULLMAG_FEM_GPU_EXECUTION_KIND_RK_TIME_INTEGRATOR
                    as u32 =>
            {
                FemGpuExecutionKind::RkTimeIntegrator
            }
            x if x
                == ffi::fullmag_fem_gpu_execution_kind_v2::FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER
                    as u32 =>
            {
                FemGpuExecutionKind::DirectMinimizer
            }
            _ => return Err(receipt_error("unknown_execution_kind")),
        };
        let relaxation_algorithm = match receipt.relaxation_algorithm {
            x if x
                == ffi::fullmag_fem_gpu_relaxation_algorithm_v2::FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONE
                    as u32 =>
            {
                FemGpuRelaxationAlgorithm::None
            }
            x if x
                == ffi::fullmag_fem_gpu_relaxation_algorithm_v2::FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG
                    as u32 =>
            {
                FemGpuRelaxationAlgorithm::NonlinearCg
            }
            x if x
                == ffi::fullmag_fem_gpu_relaxation_algorithm_v2::FULLMAG_FEM_GPU_RELAX_ALGORITHM_PROJECTED_GRADIENT_BB
                    as u32 =>
            {
                FemGpuRelaxationAlgorithm::ProjectedGradientBb
            }
            _ => return Err(receipt_error("unknown_relaxation_algorithm")),
        };
        let attempt_model = match receipt.attempt_model {
            x if x
                == ffi::fullmag_fem_gpu_attempt_model_v2::FULLMAG_FEM_GPU_ATTEMPT_MODEL_UNKNOWN
                    as u32 =>
            {
                FemGpuAttemptModel::Unknown
            }
            x if x
                == ffi::fullmag_fem_gpu_attempt_model_v2::FULLMAG_FEM_GPU_ATTEMPT_MODEL_RK_CANDIDATE
                    as u32 =>
            {
                FemGpuAttemptModel::RkCandidate
            }
            x if x
                == ffi::fullmag_fem_gpu_attempt_model_v2::FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES
                    as u32 =>
            {
                FemGpuAttemptModel::OuterStepWithArmijoCandidates
            }
            _ => return Err(receipt_error("unknown_attempt_model")),
        };
        let control_policy = match receipt.control_policy {
            x if x
                == ffi::fullmag_fem_gpu_control_policy_v2::FULLMAG_FEM_GPU_CONTROL_POLICY_UNKNOWN
                    as u32 =>
            {
                FemGpuControlPolicy::Unknown
            }
            x if x
                == ffi::fullmag_fem_gpu_control_policy_v2::FULLMAG_FEM_GPU_CONTROL_POLICY_DEVICE_CONTROL
                    as u32 =>
            {
                FemGpuControlPolicy::DeviceControl
            }
            x if x
                == ffi::fullmag_fem_gpu_control_policy_v2::FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL
                    as u32 =>
            {
                FemGpuControlPolicy::BoundedHostScalarControl
            }
            _ => return Err(receipt_error("unknown_control_policy")),
        };
        let terminal_outcome = match receipt.terminal_outcome {
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_NONE
                    as u32 =>
            {
                FemGpuTerminalOutcome::None
            }
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED
                    as u32 =>
            {
                FemGpuTerminalOutcome::CompletedAccepted
            }
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_OBSERVATION
                    as u32 =>
            {
                FemGpuTerminalOutcome::CompletedObservation
            }
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_CANCELLED
                    as u32 =>
            {
                FemGpuTerminalOutcome::Cancelled
            }
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_PAUSED
                    as u32 =>
            {
                FemGpuTerminalOutcome::Paused
            }
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_FAILED
                    as u32 =>
            {
                FemGpuTerminalOutcome::Failed
            }
            _ => return Err(receipt_error("unknown_terminal_outcome")),
        };
        let all_masks = receipt.required_operator_mask
            | receipt.resolved_device_operator_mask
            | receipt.resolved_host_operator_mask
            | receipt.resolved_unknown_operator_mask
            | receipt.executed_device_operator_mask
            | receipt.executed_host_operator_mask
            | receipt.executed_unknown_operator_mask;
        if all_masks & !FEM_GPU_KNOWN_OPERATOR_MASK_V2 != 0 {
            return Err(receipt_error("unknown_operator_bits"));
        }
        let resolved = execution_class_name(execution_class);
        let has_execution_evidence = receipt.executed_device_operator_mask != 0
            || receipt.executed_host_operator_mask != 0
            || receipt.executed_unknown_operator_mask != 0;
        let executed = if !has_execution_evidence {
            "none"
        } else {
            match execution_class {
                FemGpuExecutionClass::DeviceResident => "cuda_fem",
                FemGpuExecutionClass::GpuOperatorHostSolver => "cuda_fem_host_solver",
                FemGpuExecutionClass::HybridCpuPoisson => "cuda_fem_hybrid_cpu_poisson",
                FemGpuExecutionClass::Cpu => "cpu_fem",
            }
        };
        Ok(Self {
            receipt: FemGpuExecutionReceiptV2 {
                requested: requested.to_string(),
                resolved: resolved.to_string(),
                executed: executed.to_string(),
                execution_class,
                device_ordinal: receipt.device_ordinal,
                precision: precision.to_string(),
                integrator: integrator.to_string(),
                required_operator_mask: receipt.required_operator_mask,
                resolved_device_operator_mask: receipt.resolved_device_operator_mask,
                resolved_host_operator_mask: receipt.resolved_host_operator_mask,
                resolved_unknown_operator_mask: receipt.resolved_unknown_operator_mask,
                executed_device_operator_mask: receipt.executed_device_operator_mask,
                executed_host_operator_mask: receipt.executed_host_operator_mask,
                executed_unknown_operator_mask: receipt.executed_unknown_operator_mask,
                fallback_count: receipt.fallback_count,
                accepted_step_count: receipt.accepted_step_count,
                rejected_attempt_count: receipt.rejected_attempt_count,
                failed_attempt_count: receipt.failed_attempt_count,
                hot_loop_compute_h2d_bytes: receipt.hot_loop_compute_h2d_bytes,
                hot_loop_compute_d2h_bytes: receipt.hot_loop_compute_d2h_bytes,
                hot_loop_compute_host_sync_count: receipt.hot_loop_compute_host_sync_count,
                execution_kind,
                relaxation_algorithm,
                attempt_model,
                control_policy,
                execution_generation_id: receipt.execution_generation_id,
                terminal_outcome,
                compute_closed: receipt.compute_closed != 0,
                observation_closed: receipt.observation_closed != 0,
                outer_attempt_count: receipt.outer_attempt_count,
                rejected_candidate_count: receipt.rejected_candidate_count,
                failed_candidate_count: receipt.failed_candidate_count,
                stationary_observation_count: receipt.stationary_observation_count,
                cancelled_outer_attempt_count: receipt.cancelled_outer_attempt_count,
                paused_outer_attempt_count: receipt.paused_outer_attempt_count,
                refinement_evaluation_count: receipt.refinement_evaluation_count,
                allowed_transfer_mask: receipt.allowed_transfer_mask,
                observed_transfer_mask: receipt.observed_transfer_mask,
                transfer_violation_mask: receipt.transfer_violation_mask,
                setup_h2d_bytes: receipt.setup_h2d_bytes,
                setup_d2h_bytes: receipt.setup_d2h_bytes,
                setup_host_sync_count: receipt.setup_host_sync_count,
                compute_h2d_bytes: receipt.compute_h2d_bytes,
                compute_d2h_bytes: receipt.compute_d2h_bytes,
                compute_host_sync_count: receipt.compute_host_sync_count,
                control_h2d_bytes: receipt.control_h2d_bytes,
                control_d2h_bytes: receipt.control_d2h_bytes,
                control_host_sync_count: receipt.control_host_sync_count,
                exchange_h2d_bytes: receipt.exchange_h2d_bytes,
                exchange_d2h_bytes: receipt.exchange_d2h_bytes,
                exchange_host_sync_count: receipt.exchange_host_sync_count,
                snapshot_h2d_bytes: receipt.snapshot_h2d_bytes,
                snapshot_d2h_bytes: receipt.snapshot_d2h_bytes,
                snapshot_host_sync_count: receipt.snapshot_host_sync_count,
                export_h2d_bytes: receipt.export_h2d_bytes,
                export_d2h_bytes: receipt.export_d2h_bytes,
                export_host_sync_count: receipt.export_host_sync_count,
                initial_residency: receipt.initial_residency,
                final_residency: receipt.final_residency,
                residency_transition_count: receipt.residency_transition_count,
                residency_violation_count: receipt.residency_violation_count,
                kernel_launch_coverage_mask: receipt.kernel_launch_coverage_mask,
                required_coverage_mask: receipt.required_coverage_mask,
                unclassified_event_count: receipt.unclassified_event_count,
                accounting_valid: receipt.accounting_valid != 0,
                lifecycle_valid: receipt.lifecycle_valid != 0,
                identity_valid: receipt.identity_valid != 0,
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeFemGpuPerformanceSnapshotV3 {
    pub(crate) snapshot: FemGpuPerformanceSnapshotV3,
}

impl NativeFemGpuPerformanceSnapshotV3 {
    pub(crate) fn from_ffi(
        snapshot: ffi::fullmag_fem_gpu_performance_snapshot_v3,
    ) -> Result<Self, RunError> {
        if snapshot.abi_version != ffi::FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V3_ABI_VERSION
            || snapshot.struct_size
                != std::mem::size_of::<ffi::fullmag_fem_gpu_performance_snapshot_v3>() as u32
        {
            return Err(receipt_error("performance_snapshot_v3_abi_mismatch"));
        }
        let execution_class = match snapshot.execution_class {
            x if x
                == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT
                    as u32 =>
            {
                FemGpuExecutionClass::DeviceResident
            }
            x if x
                == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_GPU_OPERATOR_HOST_SOLVER
                    as u32 =>
            {
                FemGpuExecutionClass::GpuOperatorHostSolver
            }
            x if x
                == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_HYBRID_CPU_POISSON
                    as u32 =>
            {
                FemGpuExecutionClass::HybridCpuPoisson
            }
            x if x == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_CPU as u32 => {
                FemGpuExecutionClass::Cpu
            }
            _ => return Err(receipt_error("unknown_execution_class")),
        };
        let precision = match snapshot.precision {
            x if x == ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_SINGLE as u32 => "single",
            x if x == ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_DOUBLE as u32 => "double",
            _ => return Err(receipt_error("unknown_precision")),
        };
        let execution_kind = match snapshot.execution_kind {
            x if x
                == ffi::fullmag_fem_gpu_execution_kind_v2::FULLMAG_FEM_GPU_EXECUTION_KIND_UNKNOWN
                    as u32 =>
            {
                FemGpuExecutionKind::Unknown
            }
            x if x
                == ffi::fullmag_fem_gpu_execution_kind_v2::FULLMAG_FEM_GPU_EXECUTION_KIND_RK_TIME_INTEGRATOR
                    as u32 =>
            {
                FemGpuExecutionKind::RkTimeIntegrator
            }
            x if x
                == ffi::fullmag_fem_gpu_execution_kind_v2::FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER
                    as u32 =>
            {
                FemGpuExecutionKind::DirectMinimizer
            }
            _ => return Err(receipt_error("unknown_execution_kind")),
        };
        let relaxation_algorithm = match snapshot.relaxation_algorithm {
            x if x
                == ffi::fullmag_fem_gpu_relaxation_algorithm_v2::FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONE
                    as u32 =>
            {
                FemGpuRelaxationAlgorithm::None
            }
            x if x
                == ffi::fullmag_fem_gpu_relaxation_algorithm_v2::FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG
                    as u32 =>
            {
                FemGpuRelaxationAlgorithm::NonlinearCg
            }
            x if x
                == ffi::fullmag_fem_gpu_relaxation_algorithm_v2::FULLMAG_FEM_GPU_RELAX_ALGORITHM_PROJECTED_GRADIENT_BB
                    as u32 =>
            {
                FemGpuRelaxationAlgorithm::ProjectedGradientBb
            }
            _ => return Err(receipt_error("unknown_relaxation_algorithm")),
        };
        let attempt_model = match snapshot.attempt_model {
            x if x
                == ffi::fullmag_fem_gpu_attempt_model_v2::FULLMAG_FEM_GPU_ATTEMPT_MODEL_UNKNOWN
                    as u32 =>
            {
                FemGpuAttemptModel::Unknown
            }
            x if x
                == ffi::fullmag_fem_gpu_attempt_model_v2::FULLMAG_FEM_GPU_ATTEMPT_MODEL_RK_CANDIDATE
                    as u32 =>
            {
                FemGpuAttemptModel::RkCandidate
            }
            x if x
                == ffi::fullmag_fem_gpu_attempt_model_v2::FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES
                    as u32 =>
            {
                FemGpuAttemptModel::OuterStepWithArmijoCandidates
            }
            _ => return Err(receipt_error("unknown_attempt_model")),
        };
        let control_policy = match snapshot.control_policy {
            x if x
                == ffi::fullmag_fem_gpu_control_policy_v2::FULLMAG_FEM_GPU_CONTROL_POLICY_UNKNOWN
                    as u32 =>
            {
                FemGpuControlPolicy::Unknown
            }
            x if x
                == ffi::fullmag_fem_gpu_control_policy_v2::FULLMAG_FEM_GPU_CONTROL_POLICY_DEVICE_CONTROL
                    as u32 =>
            {
                FemGpuControlPolicy::DeviceControl
            }
            x if x
                == ffi::fullmag_fem_gpu_control_policy_v2::FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL
                    as u32 =>
            {
                FemGpuControlPolicy::BoundedHostScalarControl
            }
            _ => return Err(receipt_error("unknown_control_policy")),
        };
        let terminal_outcome = match snapshot.terminal_outcome {
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_NONE
                    as u32 =>
            {
                FemGpuTerminalOutcome::None
            }
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED
                    as u32 =>
            {
                FemGpuTerminalOutcome::CompletedAccepted
            }
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_OBSERVATION
                    as u32 =>
            {
                FemGpuTerminalOutcome::CompletedObservation
            }
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_CANCELLED
                    as u32 =>
            {
                FemGpuTerminalOutcome::Cancelled
            }
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_PAUSED
                    as u32 =>
            {
                FemGpuTerminalOutcome::Paused
            }
            x if x
                == ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_FAILED
                    as u32 =>
            {
                FemGpuTerminalOutcome::Failed
            }
            _ => return Err(receipt_error("unknown_terminal_outcome")),
        };
        Ok(Self {
            snapshot: FemGpuPerformanceSnapshotV3 {
                abi_version: snapshot.abi_version,
                struct_size: snapshot.struct_size,
                setup_count: snapshot.setup_count,
                apply_count: snapshot.apply_count,
                kernel_launch_count: snapshot.kernel_launch_count,
                compute_fence_count: snapshot.compute_fence_count,
                snapshot_fence_count: snapshot.snapshot_fence_count,
                export_fence_count: snapshot.export_fence_count,
                selected_sparse_kernel_id: snapshot.selected_sparse_kernel_id,
                setup_wall_time_ns: snapshot.setup_wall_time_ns,
                apply_wall_time_ns: snapshot.apply_wall_time_ns,
                accepted_finalization_wall_time_ns: snapshot.accepted_finalization_wall_time_ns,
                execution_kind,
                relaxation_algorithm,
                attempt_model,
                control_policy,
                terminal_outcome,
                execution_class,
                precision: precision.to_string(),
                device_ordinal: snapshot.device_ordinal,
                execution_generation_id: snapshot.execution_generation_id,
                available: snapshot.available != 0,
                compute_closed: snapshot.compute_closed != 0,
                observation_closed: snapshot.observation_closed != 0,
                frozen: snapshot.frozen != 0,
                accepted_step_count: snapshot.accepted_step_count,
                physical_outer_attempt_count: snapshot.physical_outer_attempt_count,
                rejected_candidate_count: snapshot.rejected_candidate_count,
                failed_candidate_count: snapshot.failed_candidate_count,
                cancelled_outer_attempt_count: snapshot.cancelled_outer_attempt_count,
                paused_outer_attempt_count: snapshot.paused_outer_attempt_count,
                failed_outer_attempt_count: snapshot.failed_outer_attempt_count,
                stationary_observation_count: snapshot.stationary_observation_count,
                refinement_evaluation_count: snapshot.refinement_evaluation_count,
                physical_effective_field_applies: snapshot.physical_effective_field_applies,
                physical_energy_evaluations: snapshot.physical_energy_evaluations,
                physical_armijo_candidates: snapshot.physical_armijo_candidates,
                physical_rhs_evaluations: snapshot.physical_rhs_evaluations,
                physical_exchange_applies: snapshot.physical_exchange_applies,
                physical_exchange_launches: snapshot.physical_exchange_launches,
                physical_exchange_nnz_visited: snapshot.physical_exchange_nnz_visited,
                physical_demag_solves: snapshot.physical_demag_solves,
                physical_demag_iterations: snapshot.physical_demag_iterations,
                physical_normalization_launches: snapshot.physical_normalization_launches,
                physical_normalization_readbacks: snapshot.physical_normalization_readbacks,
                physical_adaptive_readbacks: snapshot.physical_adaptive_readbacks,
                physical_control_fences: snapshot.physical_control_fences,
                physical_endpoint_cache_hits: snapshot.physical_endpoint_cache_hits,
                physical_endpoint_cache_misses: snapshot.physical_endpoint_cache_misses,
                physical_endpoint_cache_invalidations: snapshot.physical_endpoint_cache_invalidations,
                accepted_effective_field_applies: snapshot.accepted_effective_field_applies,
                accepted_energy_evaluations: snapshot.accepted_energy_evaluations,
                accepted_armijo_candidates: snapshot.accepted_armijo_candidates,
                accepted_rhs_evaluations: snapshot.accepted_rhs_evaluations,
                accepted_exchange_applies: snapshot.accepted_exchange_applies,
                accepted_exchange_launches: snapshot.accepted_exchange_launches,
                accepted_exchange_nnz_visited: snapshot.accepted_exchange_nnz_visited,
                accepted_demag_solves: snapshot.accepted_demag_solves,
                accepted_demag_iterations: snapshot.accepted_demag_iterations,
                accepted_normalization_launches: snapshot.accepted_normalization_launches,
                accepted_normalization_readbacks: snapshot.accepted_normalization_readbacks,
                accepted_adaptive_readbacks: snapshot.accepted_adaptive_readbacks,
                accepted_control_fences: snapshot.accepted_control_fences,
                accepted_endpoint_cache_hits: snapshot.accepted_endpoint_cache_hits,
                accepted_endpoint_cache_misses: snapshot.accepted_endpoint_cache_misses,
                accepted_endpoint_cache_invalidations: snapshot.accepted_endpoint_cache_invalidations,
                physical_device_to_device_bytes: snapshot.physical_device_to_device_bytes,
                accepted_device_to_device_bytes: snapshot.accepted_device_to_device_bytes,
                setup_h2d_bytes: snapshot.setup_h2d_bytes,
                setup_d2h_bytes: snapshot.setup_d2h_bytes,
                compute_h2d_bytes: snapshot.compute_h2d_bytes,
                compute_d2h_bytes: snapshot.compute_d2h_bytes,
                control_h2d_bytes: snapshot.control_h2d_bytes,
                control_d2h_bytes: snapshot.control_d2h_bytes,
                exchange_h2d_bytes: snapshot.exchange_h2d_bytes,
                exchange_d2h_bytes: snapshot.exchange_d2h_bytes,
                snapshot_h2d_bytes: snapshot.snapshot_h2d_bytes,
                snapshot_d2h_bytes: snapshot.snapshot_d2h_bytes,
                export_h2d_bytes: snapshot.export_h2d_bytes,
                export_d2h_bytes: snapshot.export_d2h_bytes,
                compute_host_sync_count: snapshot.compute_host_sync_count,
                control_host_sync_count: snapshot.control_host_sync_count,
                exchange_host_sync_count: snapshot.exchange_host_sync_count,
                snapshot_host_sync_count: snapshot.snapshot_host_sync_count,
                export_host_sync_count: snapshot.export_host_sync_count,
                kernel_launch_coverage_mask: snapshot.kernel_launch_coverage_mask,
                required_coverage_mask: snapshot.required_coverage_mask,
                unclassified_event_count: snapshot.unclassified_event_count,
                initial_residency: snapshot.initial_residency,
                final_residency: snapshot.final_residency,
                residency_transition_count: snapshot.residency_transition_count,
                residency_violation_count: snapshot.residency_violation_count,
                physical_exchange_elapsed_ns: snapshot.physical_exchange_elapsed_ns,
                physical_demag_assemble_elapsed_ns: snapshot.physical_demag_assemble_elapsed_ns,
                physical_demag_recover_elapsed_ns: snapshot.physical_demag_recover_elapsed_ns,
                physical_demag_energy_elapsed_ns: snapshot.physical_demag_energy_elapsed_ns,
                physical_rhs_elapsed_ns: snapshot.physical_rhs_elapsed_ns,
                accepted_exchange_elapsed_ns: snapshot.accepted_exchange_elapsed_ns,
                accepted_demag_assemble_elapsed_ns: snapshot.accepted_demag_assemble_elapsed_ns,
                accepted_demag_recover_elapsed_ns: snapshot.accepted_demag_recover_elapsed_ns,
                accepted_demag_energy_elapsed_ns: snapshot.accepted_demag_energy_elapsed_ns,
                accepted_rhs_elapsed_ns: snapshot.accepted_rhs_elapsed_ns,
                gradient_wall_time_ns: snapshot.gradient_wall_time_ns,
                retraction_wall_time_ns: snapshot.retraction_wall_time_ns,
                line_search_wall_time_ns: snapshot.line_search_wall_time_ns,
                direction_update_wall_time_ns: snapshot.direction_update_wall_time_ns,
                refinement_wall_time_ns: snapshot.refinement_wall_time_ns,
            },
        })
    }

    pub(crate) fn abi_is_current(&self) -> bool {
        self.snapshot.abi_version == ffi::FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V3_ABI_VERSION
            && self.snapshot.struct_size
                == std::mem::size_of::<ffi::fullmag_fem_gpu_performance_snapshot_v3>() as u32
    }
}

fn execution_class_name(class: FemGpuExecutionClass) -> &'static str {
    match class {
        FemGpuExecutionClass::DeviceResident => "device_resident",
        FemGpuExecutionClass::GpuOperatorHostSolver => "gpu_operator_host_solver",
        FemGpuExecutionClass::HybridCpuPoisson => "hybrid_cpu_poisson",
        FemGpuExecutionClass::Cpu => "cpu",
    }
}

fn receipt_error(token: &str) -> RunError {
    RunError {
        message: format!("native FEM GPU execution receipt rejected: {token}"),
    }
}

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

pub(crate) fn stage_completion_from_ffi(
    completion: ffi::fullmag_fem_stage_completion,
) -> Option<StageCompletionIR> {
    if completion.has_reason == 0 {
        return None;
    }

    let reason = match completion.reason {
        x if x
            == ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_TORQUE as i32 =>
        {
            StageStopReason::Torque
        }
        x if x
            == ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_ENERGY as i32 =>
        {
            StageStopReason::Energy
        }
        x if x
            == ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS
                as i32 =>
        {
            StageStopReason::MaxSteps
        }
        x if x
            == ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME
                as i32 =>
        {
            StageStopReason::MaxPseudotime
        }
        x if x
            == ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME
                as i32 =>
        {
            StageStopReason::MaxPhysicalTime
        }
        x if x
            == ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED
                as i32 =>
        {
            StageStopReason::UserCancelled
        }
        x if x
            == ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR
                as i32 =>
        {
            StageStopReason::BackendError
        }
        x if x
            == ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT
                as i32 =>
        {
            StageStopReason::Gradient
        }
        _ => StageStopReason::BackendError,
    };

    let representability_stationary = stage_completion_is_representability_stationary(&completion);
    let (status, converged, metric) = match reason {
        StageStopReason::Torque => ("completed", true, Some(StageMetricKind::MaxTorqueApm)),
        StageStopReason::Energy => (
            "completed",
            true,
            Some(StageMetricKind::TotalEnergyPlateauRangeJ),
        ),
        StageStopReason::MaxSteps => ("completed", false, Some(StageMetricKind::Steps)),
        StageStopReason::MaxPseudotime | StageStopReason::MaxPhysicalTime => {
            ("completed", false, Some(StageMetricKind::RelaxationTimeS))
        }
        StageStopReason::Gradient if representability_stationary => (
            "completed",
            false,
            Some(StageMetricKind::NumericalStagnation),
        ),
        StageStopReason::Gradient => ("failed", false, Some(StageMetricKind::NumericalStagnation)),
        StageStopReason::UserCancelled => ("cancelled", false, None),
        StageStopReason::BackendError => ("failed", false, None),
    };
    let has_metric_value = completion.has_metric_name != 0 && metric.is_some();
    let metric_name = metric.map(|kind| match kind {
        StageMetricKind::MaxTorqueApm => "max_torque_apm",
        StageMetricKind::TotalEnergyPlateauRangeJ => "total_energy_plateau_range_J",
        StageMetricKind::RelaxationTimeS => "relaxation_time_s",
        StageMetricKind::Steps => "steps",
        StageMetricKind::NumericalStagnation if representability_stationary => {
            "representability_stationary"
        }
        StageMetricKind::NumericalStagnation => "numerical_stagnation",
    });

    Some(StageCompletionIR {
        status: status.to_string(),
        converged,
        reason: Some(reason),
        metric,
        metric_name: metric_name.map(str::to_string),
        metric_value: if has_metric_value {
            Some(completion.metric_value)
        } else {
            None
        },
        threshold: if has_metric_value {
            Some(completion.threshold)
        } else {
            None
        },
    })
}

pub(crate) fn stage_completion_is_representability_stationary(
    completion: &ffi::fullmag_fem_stage_completion,
) -> bool {
    if completion.has_reason == 0
        || completion.reason
            != ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT as i32
        || completion.has_metric_name == 0
    {
        return false;
    }

    let expected = b"representability_stationary";
    completion
        .metric_name
        .iter()
        .map(|byte| *byte as u8)
        .take_while(|byte| *byte != 0)
        .eq(expected.iter().copied())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn execution_receipt_fixture() -> ffi::fullmag_fem_gpu_execution_receipt_v1 {
        ffi::fullmag_fem_gpu_execution_receipt_v1 {
            abi_version: ffi::FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V1,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_gpu_execution_receipt_v1>() as u32,
            execution_class:
                ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT
                    as u32,
            precision: ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_DOUBLE as u32,
            integrator: ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_HEUN as u32,
            device_ordinal: 0,
            required_operator_mask: FEM_GPU_KNOWN_OPERATOR_MASK,
            resolved_device_operator_mask: FEM_GPU_KNOWN_OPERATOR_MASK,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: FEM_GPU_KNOWN_OPERATOR_MASK,
            executed_host_operator_mask: 0,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 1,
            rejected_attempt_count: 0,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
        }
    }

    #[test]
    fn gpu_execution_receipt_maps_only_native_executed_evidence() {
        let parsed = NativeFemGpuExecutionReceipt::from_ffi(execution_receipt_fixture()).unwrap();
        let receipt = parsed.into_provenance("strict_device");
        assert_eq!(receipt.resolved, "device_resident");
        assert_eq!(receipt.executed, "cuda_fem");
        assert_eq!(
            receipt.executed_device_operator_mask,
            FEM_GPU_KNOWN_OPERATOR_MASK
        );
        assert!(
            receipt.accounting_valid,
            "the safe wrapper exposes accounting validity only after native query success"
        );
    }

    #[test]
    fn gpu_execution_receipt_preserves_explicit_hybrid_host_evidence() {
        let mut raw = execution_receipt_fixture();
        raw.execution_class =
            ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_HYBRID_CPU_POISSON
                as u32;
        raw.resolved_device_operator_mask = FEM_GPU_KNOWN_OPERATOR_MASK & !0x204;
        raw.resolved_host_operator_mask = 0x204;
        raw.executed_device_operator_mask = FEM_GPU_KNOWN_OPERATOR_MASK & !0x204;
        raw.executed_host_operator_mask = 0x204;
        raw.hot_loop_compute_h2d_bytes = 24;
        raw.hot_loop_compute_d2h_bytes = 24;
        raw.hot_loop_compute_host_sync_count = 2;
        let receipt = NativeFemGpuExecutionReceipt::from_ffi(raw)
            .unwrap()
            .into_provenance("hybrid");
        assert_eq!(receipt.resolved, "hybrid_cpu_poisson");
        assert_eq!(receipt.executed, "cuda_fem_hybrid_cpu_poisson");
        assert_eq!(receipt.executed_host_operator_mask, 0x204);
        assert_eq!(receipt.hot_loop_compute_d2h_bytes, 24);
    }

    #[test]
    fn gpu_execution_receipt_rejects_unknown_abi_values_and_operator_bits() {
        for mutation in 0..4 {
            let mut raw = execution_receipt_fixture();
            match mutation {
                0 => raw.execution_class = u32::MAX,
                1 => raw.precision = u32::MAX,
                2 => raw.integrator = u32::MAX,
                3 => raw.executed_unknown_operator_mask = 1 << 63,
                _ => unreachable!(),
            }
            assert!(NativeFemGpuExecutionReceipt::from_ffi(raw).is_err());
        }
    }

    #[test]
    fn performance_snapshot_v2_maps_every_native_field_without_v1_derivation() {
        let mut raw = ffi::fullmag_fem_gpu_performance_snapshot_v2 {
            abi_version: ffi::FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V2_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_gpu_performance_snapshot_v2>() as u32,
            setup_count: 1,
            apply_count: 2,
            kernel_launch_count: 3,
            compute_fence_count: 4,
            snapshot_fence_count: 5,
            export_fence_count: 6,
            selected_sparse_kernel_id: 7,
            setup_wall_time_ns: 8,
            apply_wall_time_ns: 9,
            accepted_finalization_wall_time_ns: 10,
        };
        let parsed = NativeFemGpuPerformanceSnapshot::from_ffi(raw).unwrap();
        assert!(parsed.abi_is_current());
        assert_eq!(parsed.snapshot.setup_count, 1);
        assert_eq!(parsed.snapshot.apply_count, 2);
        assert_eq!(parsed.snapshot.kernel_launch_count, 3);
        assert_eq!(parsed.snapshot.compute_fence_count, 4);
        assert_eq!(parsed.snapshot.snapshot_fence_count, 5);
        assert_eq!(parsed.snapshot.export_fence_count, 6);
        assert_eq!(parsed.snapshot.selected_sparse_kernel_id, 7);
        assert_eq!(parsed.snapshot.setup_wall_time_ns, 8);
        assert_eq!(parsed.snapshot.apply_wall_time_ns, 9);
        assert_eq!(parsed.snapshot.accepted_finalization_wall_time_ns, 10);
        raw.abi_version = 0;
        assert!(NativeFemGpuPerformanceSnapshot::from_ffi(raw).is_err());
    }

    fn execution_receipt_v2_fixture() -> ffi::fullmag_fem_gpu_execution_receipt_v2 {
        ffi::fullmag_fem_gpu_execution_receipt_v2 {
            abi_version: ffi::FULLMAG_FEM_GPU_EXECUTION_RECEIPT_ABI_V2,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_gpu_execution_receipt_v2>() as u32,
            execution_class: ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT as u32,
            precision: ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_DOUBLE as u32,
            integrator: 0,
            device_ordinal: 0,
            required_operator_mask: FEM_GPU_KNOWN_OPERATOR_MASK_V2,
            resolved_device_operator_mask: FEM_GPU_KNOWN_OPERATOR_MASK_V2,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: FEM_GPU_KNOWN_OPERATOR_MASK_V2,
            executed_host_operator_mask: 0,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 5,
            rejected_attempt_count: 1,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
            execution_kind: ffi::fullmag_fem_gpu_execution_kind_v2::FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER as u32,
            relaxation_algorithm: ffi::fullmag_fem_gpu_relaxation_algorithm_v2::FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG as u32,
            attempt_model: ffi::fullmag_fem_gpu_attempt_model_v2::FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES as u32,
            control_policy: ffi::fullmag_fem_gpu_control_policy_v2::FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL as u32,
            execution_generation_id: 1001,
            terminal_outcome: ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED as u32,
            compute_closed: 1,
            observation_closed: 1,
            reserved_terminal: 0,
            outer_attempt_count: 5,
            rejected_candidate_count: 2,
            failed_candidate_count: 0,
            stationary_observation_count: 1,
            cancelled_outer_attempt_count: 0,
            paused_outer_attempt_count: 0,
            refinement_evaluation_count: 3,
            allowed_transfer_mask: ffi::FULLMAG_FEM_GPU_TRANSFER_SETUP | ffi::FULLMAG_FEM_GPU_TRANSFER_CONTROL_SCALAR,
            observed_transfer_mask: ffi::FULLMAG_FEM_GPU_TRANSFER_SETUP,
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
            accounting_valid: 1,
            lifecycle_valid: 1,
            identity_valid: 1,
            reserved_valid: 0,
        }
    }

    #[test]
    fn execution_receipt_v2_maps_every_native_field() {
        let raw = execution_receipt_v2_fixture();
        let parsed = NativeFemGpuExecutionReceiptV2::from_ffi(raw, "strict_device").unwrap();
        assert_eq!(parsed.receipt.requested, "strict_device");
        assert_eq!(parsed.receipt.resolved, "device_resident");
        assert_eq!(parsed.receipt.executed, "cuda_fem");
        assert_eq!(parsed.receipt.execution_kind, FemGpuExecutionKind::DirectMinimizer);
        assert_eq!(parsed.receipt.relaxation_algorithm, FemGpuRelaxationAlgorithm::NonlinearCg);
        assert_eq!(parsed.receipt.attempt_model, FemGpuAttemptModel::OuterStepWithArmijoCandidates);
        assert_eq!(parsed.receipt.control_policy, FemGpuControlPolicy::BoundedHostScalarControl);
        assert_eq!(parsed.receipt.execution_generation_id, 1001);
        assert_eq!(parsed.receipt.terminal_outcome, FemGpuTerminalOutcome::CompletedAccepted);
        assert!(parsed.receipt.compute_closed);
        assert!(parsed.receipt.observation_closed);
        assert_eq!(parsed.receipt.outer_attempt_count, 5);
        assert_eq!(parsed.receipt.rejected_candidate_count, 2);
        assert_eq!(parsed.receipt.refinement_evaluation_count, 3);
        assert_eq!(parsed.receipt.setup_h2d_bytes, 1024);
        assert_eq!(parsed.receipt.control_d2h_bytes, 32);
        assert_eq!(parsed.receipt.control_host_sync_count, 4);
        assert!(parsed.receipt.accounting_valid);
        assert!(parsed.receipt.lifecycle_valid);
        assert!(parsed.receipt.identity_valid);
    }

    #[test]
    fn execution_receipt_v2_maps_stationary_device_evidence_as_cuda_execution() {
        let mut raw = execution_receipt_v2_fixture();
        const TRIAL_OPERATORS: u64 = (1 << 10) | (1 << 12) | (1 << 13) | (1 << 14);
        const DIRECT_ENERGY_REFINEMENT: u64 = 1 << 15;
        raw.executed_device_operator_mask =
            (raw.required_operator_mask & !TRIAL_OPERATORS) | DIRECT_ENERGY_REFINEMENT;
        raw.accepted_step_count = 0;
        raw.stationary_observation_count = 1;
        raw.terminal_outcome =
            ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_OBSERVATION as u32;

        let parsed = NativeFemGpuExecutionReceiptV2::from_ffi(raw, "strict_device").unwrap();
        assert_eq!(parsed.receipt.executed, "cuda_fem");
        assert_eq!(parsed.receipt.accepted_step_count, 0);
        assert_eq!(parsed.receipt.stationary_observation_count, 1);
    }

    #[test]
    fn performance_snapshot_v3_maps_every_native_field() {
        let raw = ffi::fullmag_fem_gpu_performance_snapshot_v3 {
            abi_version: ffi::FULLMAG_FEM_GPU_PERFORMANCE_SNAPSHOT_V3_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_gpu_performance_snapshot_v3>() as u32,
            setup_count: 1,
            apply_count: 2,
            kernel_launch_count: 15,
            compute_fence_count: 0,
            snapshot_fence_count: 1,
            export_fence_count: 0,
            selected_sparse_kernel_id: 3,
            setup_wall_time_ns: 100,
            apply_wall_time_ns: 200,
            accepted_finalization_wall_time_ns: 50,
            execution_kind: ffi::fullmag_fem_gpu_execution_kind_v2::FULLMAG_FEM_GPU_EXECUTION_KIND_DIRECT_MINIMIZER as u32,
            relaxation_algorithm: ffi::fullmag_fem_gpu_relaxation_algorithm_v2::FULLMAG_FEM_GPU_RELAX_ALGORITHM_NONLINEAR_CG as u32,
            attempt_model: ffi::fullmag_fem_gpu_attempt_model_v2::FULLMAG_FEM_GPU_ATTEMPT_MODEL_OUTER_STEP_WITH_ARMIJO_CANDIDATES as u32,
            control_policy: ffi::fullmag_fem_gpu_control_policy_v2::FULLMAG_FEM_GPU_CONTROL_POLICY_BOUNDED_HOST_SCALAR_CONTROL as u32,
            terminal_outcome: ffi::fullmag_fem_gpu_terminal_outcome_v2::FULLMAG_FEM_GPU_TERMINAL_OUTCOME_COMPLETED_ACCEPTED as u32,
            execution_class: ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT as u32,
            precision: ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_DOUBLE as u32,
            device_ordinal: 0,
            execution_generation_id: 1001,
            available: 1,
            compute_closed: 1,
            observation_closed: 1,
            frozen: 1,
            accepted_step_count: 2,
            physical_outer_attempt_count: 2,
            rejected_candidate_count: 1,
            failed_candidate_count: 0,
            cancelled_outer_attempt_count: 0,
            paused_outer_attempt_count: 0,
            failed_outer_attempt_count: 0,
            stationary_observation_count: 0,
            refinement_evaluation_count: 1,
            physical_effective_field_applies: 10,
            physical_energy_evaluations: 12,
            physical_armijo_candidates: 3,
            physical_rhs_evaluations: 10,
            physical_exchange_applies: 10,
            physical_exchange_launches: 10,
            physical_exchange_nnz_visited: 5000,
            physical_demag_solves: 10,
            physical_demag_iterations: 40,
            physical_normalization_launches: 15,
            physical_normalization_readbacks: 3,
            physical_adaptive_readbacks: 0,
            physical_control_fences: 3,
            physical_endpoint_cache_hits: 2,
            physical_endpoint_cache_misses: 1,
            physical_endpoint_cache_invalidations: 0,
            accepted_effective_field_applies: 8,
            accepted_energy_evaluations: 10,
            accepted_armijo_candidates: 2,
            accepted_rhs_evaluations: 8,
            accepted_exchange_applies: 8,
            accepted_exchange_launches: 8,
            accepted_exchange_nnz_visited: 4000,
            accepted_demag_solves: 8,
            accepted_demag_iterations: 32,
            accepted_normalization_launches: 12,
            accepted_normalization_readbacks: 2,
            accepted_adaptive_readbacks: 0,
            accepted_control_fences: 2,
            accepted_endpoint_cache_hits: 2,
            accepted_endpoint_cache_misses: 0,
            accepted_endpoint_cache_invalidations: 0,
            physical_device_to_device_bytes: 4096,
            accepted_device_to_device_bytes: 3072,
            setup_h2d_bytes: 1024,
            setup_d2h_bytes: 0,
            compute_h2d_bytes: 0,
            compute_d2h_bytes: 0,
            control_h2d_bytes: 0,
            control_d2h_bytes: 64,
            exchange_h2d_bytes: 0,
            exchange_d2h_bytes: 0,
            snapshot_h2d_bytes: 0,
            snapshot_d2h_bytes: 512,
            export_h2d_bytes: 0,
            export_d2h_bytes: 0,
            compute_host_sync_count: 0,
            control_host_sync_count: 2,
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
            accepted_exchange_elapsed_ns: 40,
            accepted_demag_assemble_elapsed_ns: 30,
            accepted_demag_recover_elapsed_ns: 25,
            accepted_demag_energy_elapsed_ns: 15,
            accepted_rhs_elapsed_ns: 65,
            gradient_wall_time_ns: 70,
            retraction_wall_time_ns: 15,
            line_search_wall_time_ns: 85,
            direction_update_wall_time_ns: 25,
            refinement_wall_time_ns: 10,
        };
        let parsed = NativeFemGpuPerformanceSnapshotV3::from_ffi(raw).unwrap();
        assert!(parsed.abi_is_current());
        assert_eq!(parsed.snapshot.setup_count, 1);
        assert_eq!(parsed.snapshot.apply_count, 2);
        assert_eq!(parsed.snapshot.execution_generation_id, 1001);
        assert_eq!(parsed.snapshot.execution_kind, FemGpuExecutionKind::DirectMinimizer);
        assert_eq!(parsed.snapshot.relaxation_algorithm, FemGpuRelaxationAlgorithm::NonlinearCg);
        assert_eq!(parsed.snapshot.terminal_outcome, FemGpuTerminalOutcome::CompletedAccepted);
        assert!(parsed.snapshot.available);
        assert!(parsed.snapshot.compute_closed);
        assert!(parsed.snapshot.observation_closed);
        assert!(parsed.snapshot.frozen);
        assert_eq!(parsed.snapshot.accepted_effective_field_applies, 8);
        assert_eq!(parsed.snapshot.physical_effective_field_applies, 10);
        assert_eq!(parsed.snapshot.refinement_wall_time_ns, 10);
    }

    fn metric_name(name: &str) -> [i8; 64] {
        let mut buffer = [0; 64];
        for (slot, byte) in buffer.iter_mut().zip(name.as_bytes()) {
            *slot = *byte as i8;
        }
        buffer
    }

    #[test]
    fn stage_completion_from_ffi_maps_metric_completion() {
        let completion = stage_completion_from_ffi(ffi::fullmag_fem_stage_completion {
            has_reason: 1,
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_ENERGY as i32,
            has_metric_name: 1,
            metric_name: metric_name("energy_delta_j"),
            metric_value: 1.0e-21,
            threshold: 1.0e-20,
            ..Default::default()
        })
        .expect("completion should map when reason is present");

        assert_eq!(completion.status, "completed");
        assert!(completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::Energy));
        assert_eq!(
            completion.metric,
            Some(fullmag_ir::StageMetricKind::TotalEnergyPlateauRangeJ)
        );
        assert_eq!(
            completion.metric_name.as_deref(),
            Some("total_energy_plateau_range_J")
        );
        assert_eq!(completion.metric_value, Some(1.0e-21));
        assert_eq!(completion.threshold, Some(1.0e-20));
    }

    #[test]
    fn stage_completion_from_ffi_maps_max_steps_as_non_converged() {
        let completion = stage_completion_from_ffi(ffi::fullmag_fem_stage_completion {
            has_reason: 1,
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS
                as i32,
            has_metric_name: 1,
            metric_name: metric_name("steps"),
            metric_value: 50_000.0,
            threshold: 50_000.0,
            ..Default::default()
        })
        .expect("max-steps completion should map");

        assert_eq!(completion.status, "completed");
        assert!(!completion.converged);
        assert_eq!(completion.metric, Some(fullmag_ir::StageMetricKind::Steps));
        assert_eq!(completion.metric_name.as_deref(), Some("steps"));
    }

    #[test]
    fn stage_completion_from_ffi_maps_backend_error_as_failed() {
        let completion = stage_completion_from_ffi(ffi::fullmag_fem_stage_completion {
            has_reason: 1,
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR
                as i32,
            has_metric_name: 0,
            metric_name: [0; 64],
            metric_value: 0.0,
            threshold: 0.0,
            ..Default::default()
        })
        .expect("backend-error completion should map");

        assert_eq!(completion.status, "failed");
        assert!(!completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::BackendError));
        assert_eq!(completion.metric, None);
    }

    #[test]
    fn stage_completion_from_ffi_maps_torque_as_converged() {
        let completion = stage_completion_from_ffi(ffi::fullmag_fem_stage_completion {
            has_reason: 1,
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_TORQUE as i32,
            has_metric_name: 1,
            metric_name: metric_name("max_torque_apm"),
            metric_value: 0.0,
            threshold: 1.0e-4,
            ..Default::default()
        })
        .expect("torque completion should map");

        assert_eq!(completion.status, "completed");
        assert!(completion.converged);
        assert_eq!(
            completion.metric,
            Some(fullmag_ir::StageMetricKind::MaxTorqueApm)
        );
        assert_eq!(completion.metric_value, Some(0.0));
    }

    #[test]
    fn stage_completion_from_ffi_maps_gradient_completion() {
        let completion = stage_completion_from_ffi(ffi::fullmag_fem_stage_completion {
            has_reason: 1,
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT
                as i32,
            has_metric_name: 1,
            metric_name: metric_name("tangent_gradient_norm_sq"),
            metric_value: 0.0,
            threshold: 1.0e-30,
            ..Default::default()
        })
        .expect("gradient completion should map when reason is present");

        assert_eq!(completion.status, "failed");
        assert!(!completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::Gradient));
        assert_eq!(
            completion.metric,
            Some(fullmag_ir::StageMetricKind::NumericalStagnation)
        );
        assert_eq!(
            completion.metric_name.as_deref(),
            Some("numerical_stagnation")
        );
        assert_eq!(completion.metric_value, Some(0.0));
        assert_eq!(completion.threshold, Some(1.0e-30));
    }

    #[test]
    fn stage_completion_from_ffi_maps_representability_stationary_without_convergence() {
        let completion = stage_completion_from_ffi(ffi::fullmag_fem_stage_completion {
            has_reason: 1,
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT
                as i32,
            has_metric_name: 1,
            metric_name: metric_name("representability_stationary"),
            metric_value: 1.0,
            threshold: 1.0,
            ..Default::default()
        })
        .expect("representability-stationary completion should map");

        assert_eq!(completion.status, "completed");
        assert!(!completion.converged);
        assert_eq!(completion.reason, Some(StageStopReason::Gradient));
        assert_eq!(
            completion.metric,
            Some(fullmag_ir::StageMetricKind::NumericalStagnation)
        );
        assert_eq!(
            completion.metric_name.as_deref(),
            Some("representability_stationary")
        );
        assert_eq!(completion.metric_value, Some(1.0));
        assert_eq!(completion.threshold, Some(1.0));
    }

    #[test]
    fn stage_completion_from_ffi_omits_empty_completion() {
        let completion = stage_completion_from_ffi(ffi::fullmag_fem_stage_completion {
            has_reason: 0,
            reason: 0,
            has_metric_name: 0,
            metric_name: [0; 64],
            metric_value: 0.0,
            threshold: 0.0,
            ..Default::default()
        });

        assert!(completion.is_none());
    }
}
