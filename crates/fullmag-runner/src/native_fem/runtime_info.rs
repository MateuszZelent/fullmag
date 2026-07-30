use fullmag_fem_sys as ffi;
use fullmag_ir::{StageCompletionIR, StageMetricKind, StageStopReason};

use crate::types::RunError;

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
}

pub(crate) fn runtime_build_info() -> Result<RuntimeBuildInfo, RunError> {
    let mut info = ffi::fullmag_fem_runtime_build_info {
        abi_version: 0,
        struct_size: 0,
        mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
    };
    let rc = unsafe { ffi::fullmag_fem_get_runtime_build_info(&mut info) };
    if rc != ffi::FULLMAG_FEM_OK {
        return Err(RunError {
            message: "native FEM runtime build identity is unavailable".to_string(),
        });
    }
    RuntimeBuildInfo::from_ffi(info)
}

impl RuntimeBuildInfo {
    fn from_ffi(info: ffi::fullmag_fem_runtime_build_info) -> Result<Self, RunError> {
        if info.abi_version != ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_V1_ABI_VERSION
            || info.struct_size != std::mem::size_of::<ffi::fullmag_fem_runtime_build_info>() as u32
        {
            return Err(RunError {
                message: "native FEM runtime build identity ABI is incompatible".to_string(),
            });
        }
        let mfem_version = unsafe { CStr::from_ptr(info.mfem_version.as_ptr()) }
            .to_string_lossy()
            .to_string();
        if mfem_version.is_empty() {
            return Err(RunError {
                message: "native FEM runtime build identity did not publish MFEM version"
                    .to_string(),
            });
        }
        Ok(Self { mfem_version })
    }
}

#[cfg(test)]
mod runtime_build_info_tests {
    use super::*;

    #[test]
    fn accepts_versioned_mfem_identity_from_loaded_native_abi() {
        let mut info = ffi::fullmag_fem_runtime_build_info {
            abi_version: ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_V1_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_runtime_build_info>() as u32,
            mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
        };
        info.mfem_version[..4].copy_from_slice(&[b'4' as _, b'.' as _, b'9' as _, 0]);

        assert_eq!(
            RuntimeBuildInfo::from_ffi(info).unwrap().mfem_version,
            "4.9"
        );
    }

    #[test]
    fn rejects_missing_mfem_identity_from_loaded_native_abi() {
        let info = ffi::fullmag_fem_runtime_build_info {
            abi_version: ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_V1_ABI_VERSION,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_runtime_build_info>() as u32,
            mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
        };

        assert!(RuntimeBuildInfo::from_ffi(info).is_err());
    }

    #[test]
    fn rejects_incompatible_runtime_build_identity_abi() {
        let mut info = ffi::fullmag_fem_runtime_build_info {
            abi_version: 0,
            struct_size: std::mem::size_of::<ffi::fullmag_fem_runtime_build_info>() as u32,
            mfem_version: [0; ffi::FULLMAG_FEM_RUNTIME_BUILD_INFO_MFEM_VERSION_CAPACITY],
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
