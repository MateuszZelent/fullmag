use fullmag_fem_sys as ffi;
use fullmag_ir::{StageCompletionIR, StageMetricKind, StageStopReason};

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
        ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_TORQUE => {
            StageStopReason::Torque
        }
        ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_ENERGY => {
            StageStopReason::Energy
        }
        ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS => {
            StageStopReason::MaxSteps
        }
        ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_PSEUDOTIME => {
            StageStopReason::MaxPseudotime
        }
        ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_PHYSICAL_TIME => {
            StageStopReason::MaxPhysicalTime
        }
        ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_USER_CANCELLED => {
            StageStopReason::UserCancelled
        }
        ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR => {
            StageStopReason::BackendError
        }
        ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT => {
            StageStopReason::Gradient
        }
    };

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
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_ENERGY,
            has_metric_name: 1,
            metric_name: metric_name("energy_delta_j"),
            metric_value: 1.0e-21,
            threshold: 1.0e-20,
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
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_MAX_STEPS,
            has_metric_name: 1,
            metric_name: metric_name("steps"),
            metric_value: 50_000.0,
            threshold: 50_000.0,
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
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_BACKEND_ERROR,
            has_metric_name: 0,
            metric_name: [0; 64],
            metric_value: 0.0,
            threshold: 0.0,
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
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_TORQUE,
            has_metric_name: 1,
            metric_name: metric_name("max_torque_apm"),
            metric_value: 0.0,
            threshold: 1.0e-4,
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
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_GRADIENT,
            has_metric_name: 1,
            metric_name: metric_name("tangent_gradient_norm_sq"),
            metric_value: 0.0,
            threshold: 1.0e-30,
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
    fn stage_completion_from_ffi_omits_empty_completion() {
        let completion = stage_completion_from_ffi(ffi::fullmag_fem_stage_completion {
            has_reason: 0,
            reason: ffi::fullmag_fem_stage_stop_reason::FULLMAG_FEM_STAGE_STOP_REASON_TORQUE,
            has_metric_name: 0,
            metric_name: [0; 64],
            metric_value: 0.0,
            threshold: 0.0,
        });

        assert!(completion.is_none());
    }
}
