use fullmag_fem_sys as ffi;
use fullmag_ir::{StageCompletionIR, StageMetricKind, StageStopReason};

use crate::fem::execution_receipt::{
    validate_fem_gpu_performance_snapshot, FemGpuPerformanceSnapshotSummary,
    FemGpuPerformanceSnapshotValidationError, FEM_GPU_PERFORMANCE_SNAPSHOT_ABI_V1,
    FEM_GPU_PERFORMANCE_SNAPSHOT_V1_SIZE,
};
use crate::types::{
    FemBemDemagProvenance, FemGpuExecutionClass, FemGpuExecutionReceipt, RunError,
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

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NativeFemDemagFemBemProvenance {
    pub(crate) operator_mode: String,
    pub(crate) operator_fingerprint: String,
    pub(crate) boundary_node_count: u64,
    pub(crate) boundary_triangle_count: u64,
    pub(crate) near_block_count: u64,
    pub(crate) far_block_count: u64,
    pub(crate) near_entry_count: u64,
    pub(crate) far_row_count: u64,
    pub(crate) max_rank: u32,
    pub(crate) relative_error_estimate: f64,
    pub(crate) resident_bytes: u64,
    pub(crate) device_bytes: u64,
    pub(crate) operator_build_count: u64,
    pub(crate) operator_upload_count: u64,
    pub(crate) apply_count: u64,
}

impl NativeFemDemagFemBemProvenance {
    fn is_sha256_fingerprint(value: &str) -> bool {
        let digest = value.strip_prefix("sha256:").unwrap_or(value);
        digest.len() == 64
            && digest.bytes().all(|byte| {
                matches!(
                    byte,
                    b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F'
                )
            })
    }

    pub(crate) fn from_ffi(
        raw: ffi::fullmag_fem_demag_fem_bem_provenance_v1,
    ) -> Result<Option<Self>, RunError> {
        if raw.abi_version != ffi::FULLMAG_FEM_DEMAG_FEM_BEM_PROVENANCE_V1_ABI_VERSION
            || raw.struct_size
                != std::mem::size_of::<ffi::fullmag_fem_demag_fem_bem_provenance_v1>() as u32
        {
            return Err(receipt_error("demag_fem_bem_provenance_abi_mismatch"));
        }
        if raw.available == 0 {
            return Ok(None);
        }

        fn bounded_string(
            bytes: &[std::ffi::c_char],
            label: &str,
        ) -> Result<String, RunError> {
            let Some(end) = bytes.iter().position(|byte| *byte == 0) else {
                return Err(receipt_error(&format!(
                    "demag_fem_bem_provenance_{label}_not_terminated"
                )));
            };
            let value = std::str::from_utf8(unsafe {
                std::slice::from_raw_parts(bytes.as_ptr().cast::<u8>(), end)
            })
            .map_err(|_| receipt_error(&format!("demag_fem_bem_provenance_{label}_not_utf8")))?
            .to_string();
            if value.is_empty() {
                return Err(receipt_error(&format!(
                    "demag_fem_bem_provenance_{label}_empty"
                )));
            }
            Ok(value)
        }

        let operator_mode = bounded_string(&raw.operator_mode, "operator_mode")?;
        if !matches!(operator_mode.as_str(), "hierarchical_h2" | "device_hypre_fem_bem") {
            return Err(receipt_error("demag_fem_bem_provenance_unknown_operator_mode"));
        }
        let operator_fingerprint = bounded_string(&raw.operator_fingerprint, "fingerprint")?;
        if !Self::is_sha256_fingerprint(&operator_fingerprint) {
            return Err(receipt_error("demag_fem_bem_provenance_fingerprint_not_sha256"));
        }
        if raw.boundary_node_count == 0
            || raw.boundary_triangle_count == 0
            || raw.operator_build_count == 0
            || !raw.relative_error_estimate.is_finite()
            || raw.relative_error_estimate < 0.0
        {
            return Err(receipt_error("demag_fem_bem_provenance_invalid_metrics"));
        }
        Ok(Some(Self {
            operator_mode,
            operator_fingerprint,
            boundary_node_count: raw.boundary_node_count,
            boundary_triangle_count: raw.boundary_triangle_count,
            near_block_count: raw.near_block_count,
            far_block_count: raw.far_block_count,
            near_entry_count: raw.near_entry_count,
            far_row_count: raw.far_row_count,
            max_rank: raw.max_rank,
            relative_error_estimate: raw.relative_error_estimate,
            resident_bytes: raw.resident_bytes,
            device_bytes: raw.device_bytes,
            operator_build_count: raw.operator_build_count,
            operator_upload_count: raw.operator_upload_count,
            apply_count: raw.apply_count,
        }))
    }

    pub(crate) fn into_provenance(self) -> FemBemDemagProvenance {
        FemBemDemagProvenance {
            operator_mode: self.operator_mode,
            operator_fingerprint: self.operator_fingerprint,
            boundary_node_count: self.boundary_node_count,
            boundary_triangle_count: self.boundary_triangle_count,
            near_block_count: self.near_block_count,
            far_block_count: self.far_block_count,
            near_entry_count: self.near_entry_count,
            far_row_count: self.far_row_count,
            max_rank: self.max_rank,
            relative_error_estimate: self.relative_error_estimate,
            resident_bytes: self.resident_bytes,
            device_bytes: self.device_bytes,
            operator_build_count: self.operator_build_count,
            operator_upload_count: self.operator_upload_count,
            apply_count: self.apply_count,
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

/// Validated native performance evidence.  The raw append-only ABI is kept
/// alongside the compact summary so diagnostics can expose every counter
/// without inventing a second counter vocabulary in Rust.
#[derive(Debug, Clone, Copy)]
pub(crate) struct NativeFemGpuPerformanceSnapshot {
    pub(crate) summary: FemGpuPerformanceSnapshotSummary,
    pub(crate) raw: ffi::fullmag_fem_gpu_performance_snapshot_v1,
}

impl NativeFemGpuPerformanceSnapshot {
    pub(crate) fn from_ffi(
        snapshot: ffi::fullmag_fem_gpu_performance_snapshot_v1,
    ) -> Result<Self, RunError> {
        let execution_class = match snapshot.execution_class {
            value
                if value
                    == ffi::fullmag_fem_gpu_execution_class_v1::
                        FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT
                        as u32 => FemGpuExecutionClass::DeviceResident,
            value
                if value
                    == ffi::fullmag_fem_gpu_execution_class_v1::
                        FULLMAG_FEM_GPU_EXECUTION_GPU_OPERATOR_HOST_SOLVER
                        as u32 => FemGpuExecutionClass::GpuOperatorHostSolver,
            value
                if value
                    == ffi::fullmag_fem_gpu_execution_class_v1::
                        FULLMAG_FEM_GPU_EXECUTION_HYBRID_CPU_POISSON
                        as u32 => FemGpuExecutionClass::HybridCpuPoisson,
            value
                if value
                    == ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_CPU
                        as u32 => FemGpuExecutionClass::Cpu,
            _ => return Err(receipt_error("performance_snapshot_unknown_execution_class")),
        };
        let summary = FemGpuPerformanceSnapshotSummary {
            abi_version: snapshot.abi_version,
            struct_size: snapshot.struct_size,
            available: snapshot.available != 0,
            execution_class,
            completed_step: snapshot.completed_step,
            completed_attempt_count: snapshot.completed_attempt_count,
            rejected_attempt_count: snapshot.rejected_attempt_count,
            failed_attempt_count: snapshot.failed_attempt_count,
            physical_rhs_evaluations: snapshot.physical_rhs_evaluations,
            accepted_rhs_evaluations: snapshot.accepted_rhs_evaluations,
            physical_device_to_device_bytes: snapshot.physical_device_to_device_bytes,
            accepted_device_to_device_bytes: snapshot.accepted_device_to_device_bytes,
        };
        validate_fem_gpu_performance_snapshot(&summary).map_err(|error| {
            let token = match error {
                FemGpuPerformanceSnapshotValidationError::AbiMismatch => {
                    "performance_snapshot_abi_mismatch"
                }
                FemGpuPerformanceSnapshotValidationError::Unavailable => {
                    "performance_snapshot_unavailable"
                }
                FemGpuPerformanceSnapshotValidationError::ExecutionClassMismatch => {
                    "performance_snapshot_execution_class_mismatch"
                }
                FemGpuPerformanceSnapshotValidationError::NoCompletedStep => {
                    "performance_snapshot_no_completed_step"
                }
                FemGpuPerformanceSnapshotValidationError::AcceptedCountersExceedPhysical => {
                    "performance_snapshot_accounting_invalid"
                }
            };
            receipt_error(token)
        })?;
        Ok(Self {
            summary,
            raw: snapshot,
        })
    }

    pub(crate) fn abi_is_current(&self) -> bool {
        self.summary.abi_version == FEM_GPU_PERFORMANCE_SNAPSHOT_ABI_V1
            && self.summary.struct_size == FEM_GPU_PERFORMANCE_SNAPSHOT_V1_SIZE
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

    fn bem_provenance_fixture() -> ffi::fullmag_fem_demag_fem_bem_provenance_v1 {
        fn text<const N: usize>(value: &str) -> [std::ffi::c_char; N] {
            let mut output = [0; N];
            for (slot, byte) in output.iter_mut().zip(value.as_bytes()) {
                *slot = *byte as std::ffi::c_char;
            }
            output
        }

        ffi::fullmag_fem_demag_fem_bem_provenance_v1 {
            abi_version: ffi::FULLMAG_FEM_DEMAG_FEM_BEM_PROVENANCE_V1_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_demag_fem_bem_provenance_v1>()
                as u32,
            available: 1,
            reserved: 0,
            operator_mode: text("hierarchical_h2"),
            operator_fingerprint: text(
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            ),
            boundary_node_count: 128,
            boundary_triangle_count: 252,
            near_block_count: 32,
            far_block_count: 64,
            near_entry_count: 2048,
            far_row_count: 512,
            max_rank: 12,
            reserved2: 0,
            relative_error_estimate: 1.0e-7,
            resident_bytes: 1_048_576,
            device_bytes: 0,
            operator_build_count: 1,
            operator_upload_count: 0,
            apply_count: 4,
        }
    }

    #[test]
    fn demag_fem_bem_provenance_maps_metrics_and_fails_closed() {
        let mut raw = bem_provenance_fixture();
        let parsed = NativeFemDemagFemBemProvenance::from_ffi(raw)
            .unwrap()
            .expect("available BEM provenance should map");
        assert_eq!(parsed.operator_mode, "hierarchical_h2");
        assert_eq!(parsed.boundary_node_count, 128);
        assert_eq!(parsed.boundary_triangle_count, 252);
        assert_eq!(parsed.near_block_count, 32);
        assert_eq!(parsed.far_block_count, 64);
        assert_eq!(parsed.max_rank, 12);
        assert_eq!(parsed.apply_count, 4);

        raw.available = 0;
        assert!(NativeFemDemagFemBemProvenance::from_ffi(raw)
            .unwrap()
            .is_none());

        let mut invalid = bem_provenance_fixture();
        invalid.relative_error_estimate = f64::NAN;
        assert!(NativeFemDemagFemBemProvenance::from_ffi(invalid).is_err());

        let mut invalid_fingerprint = bem_provenance_fixture();
        invalid_fingerprint.operator_fingerprint[0] = b'x' as std::ffi::c_char;
        assert!(NativeFemDemagFemBemProvenance::from_ffi(invalid_fingerprint).is_err());

        let mut unterminated = bem_provenance_fixture();
        unterminated.operator_mode = [b'x' as std::ffi::c_char; 64];
        assert!(NativeFemDemagFemBemProvenance::from_ffi(unterminated).is_err());
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
    fn performance_snapshot_maps_and_validates_native_evidence() {
        let mut raw = ffi::fullmag_fem_gpu_performance_snapshot_v1 {
            abi_version: FEM_GPU_PERFORMANCE_SNAPSHOT_ABI_V1,
            struct_size: FEM_GPU_PERFORMANCE_SNAPSHOT_V1_SIZE,
            available: 1,
            execution_class:
                ffi::fullmag_fem_gpu_execution_class_v1::FULLMAG_FEM_GPU_EXECUTION_DEVICE_RESIDENT
                    as u32,
            precision: ffi::fullmag_fem_precision::FULLMAG_FEM_PRECISION_DOUBLE as u32,
            integrator: ffi::fullmag_fem_integrator::FULLMAG_FEM_INTEGRATOR_RK23_BS as u32,
            device_ordinal: 0,
            completed_step: 1,
            completed_attempt_count: 1,
            physical_rhs_evaluations: 4,
            accepted_rhs_evaluations: 3,
            physical_device_to_device_bytes: 96,
            accepted_device_to_device_bytes: 72,
            ..Default::default()
        };
        let parsed = NativeFemGpuPerformanceSnapshot::from_ffi(raw).unwrap();
        assert!(parsed.abi_is_current());
        assert_eq!(
            parsed.summary.execution_class,
            FemGpuExecutionClass::DeviceResident
        );
        assert_eq!(parsed.summary.accepted_rhs_evaluations, 3);
        raw.available = 0;
        assert!(NativeFemGpuPerformanceSnapshot::from_ffi(raw).is_err());
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
