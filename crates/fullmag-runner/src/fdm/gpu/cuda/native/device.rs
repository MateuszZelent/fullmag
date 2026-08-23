use super::{ffi, NativeFdmBackend};
use crate::types::{FdmGpuExecutionReceipt, RunError};
use std::ffi::CStr;

/// Parsed device info.
#[derive(Debug, Clone)]
pub(crate) struct DeviceInfo {
    pub name: String,
    pub compute_capability: String,
    pub driver_version: i32,
    pub runtime_version: i32,
}

impl NativeFdmBackend {
    /// Query device info.
    pub fn device_info(&self) -> Result<DeviceInfo, RunError> {
        let mut info = ffi::fullmag_fdm_device_info {
            name: [0; 128],
            compute_capability_major: 0,
            compute_capability_minor: 0,
            driver_version: 0,
            runtime_version: 0,
        };

        let rc =
            unsafe { ffi::fullmag_fdm_backend_get_device_info(self.handle as *mut _, &mut info) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("get_device_info failed"));
        }

        let name = unsafe { CStr::from_ptr(info.name.as_ptr()) }
            .to_string_lossy()
            .to_string();

        Ok(DeviceInfo {
            name,
            compute_capability: format!(
                "{}.{}",
                info.compute_capability_major, info.compute_capability_minor
            ),
            driver_version: info.driver_version,
            runtime_version: info.runtime_version,
        })
    }

    pub(crate) fn execution_receipt(
        &self,
        requested_mode: fullmag_ir::ExecutionMode,
    ) -> Result<FdmGpuExecutionReceipt, RunError> {
        let device = self.device_info()?;
        super::residency::query_execution_receipt(self, requested_mode, &device.name)
    }
}
