#[cfg(feature = "fem-gpu")]
use fullmag_fem_sys as ffi;

#[cfg(feature = "fem-gpu")]
use std::ffi::CStr;

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub(crate) struct GpuAvailability {
    pub available: bool,
    pub available_any: bool,
    pub available_cpu: bool,
    pub available_gpu: bool,
    pub built_with_mfem_stack: bool,
    pub built_with_cuda_runtime: bool,
    pub built_with_ceed: bool,
    pub native_fem_cpu_available: bool,
    pub native_fem_gpu_available: bool,
    pub native_fem_gpu_full_demag_available: bool,
    pub mfem_cuda_available: bool,
    pub hypre_gpu_available: bool,
    pub libceed_used_hot_path: bool,
    pub visible_cuda_device_count: i32,
    pub requested_gpu_index: i32,
    pub resolved_gpu_index: i32,
    pub memory_free_bytes: u64,
    pub memory_total_bytes: u64,
    pub reason: String,
    pub reason_cpu: String,
    pub reason_gpu: String,
}

pub(crate) fn is_gpu_available() -> bool {
    native_availability().native_fem_gpu_available
}

pub(crate) fn is_cpu_available() -> bool {
    native_availability().native_fem_cpu_available
}

pub(crate) fn native_availability() -> GpuAvailability {
    #[cfg(feature = "fem-gpu")]
    {
        let mut info = ffi::fullmag_fem_availability_info {
            available: 0,
            built_with_mfem_stack: 0,
            built_with_cuda_runtime: 0,
            built_with_ceed: 0,
            native_fem_cpu_available: 0,
            native_fem_gpu_available: 0,
            native_fem_gpu_full_demag_available: 0,
            mfem_cuda_available: 0,
            hypre_gpu_available: 0,
            libceed_used_hot_path: 0,
            visible_cuda_device_count: 0,
            requested_gpu_index: -1,
            resolved_gpu_index: -1,
            gpu_memory_free_bytes: 0,
            gpu_memory_total_bytes: 0,
            reason: [0; 256],
            available_any: 0,
            available_cpu: 0,
            available_gpu: 0,
            reason_cpu: [0; 256],
            reason_gpu: [0; 256],
        };
        let rc = unsafe { ffi::fullmag_fem_get_availability_info(&mut info) };
        if rc != ffi::FULLMAG_FEM_OK {
            return GpuAvailability {
                available: false,
                available_any: false,
                available_cpu: false,
                available_gpu: false,
                built_with_mfem_stack: false,
                built_with_cuda_runtime: false,
                built_with_ceed: false,
                native_fem_cpu_available: false,
                native_fem_gpu_available: false,
                native_fem_gpu_full_demag_available: false,
                mfem_cuda_available: false,
                hypre_gpu_available: false,
                libceed_used_hot_path: false,
                visible_cuda_device_count: 0,
                requested_gpu_index: -1,
                resolved_gpu_index: -1,
                memory_free_bytes: 0,
                memory_total_bytes: 0,
                reason: last_global_error_or(
                    "fullmag_fem_get_availability_info failed without an error message",
                ),
                reason_cpu: String::new(),
                reason_gpu: String::new(),
            };
        }

        let reason = unsafe { CStr::from_ptr(info.reason.as_ptr()) }
            .to_string_lossy()
            .to_string();
        let reason_cpu = unsafe { CStr::from_ptr(info.reason_cpu.as_ptr()) }
            .to_string_lossy()
            .to_string();
        let reason_gpu = unsafe { CStr::from_ptr(info.reason_gpu.as_ptr()) }
            .to_string_lossy()
            .to_string();

        GpuAvailability {
            available: info.available == 1,
            available_any: info.available_any == 1,
            available_cpu: info.available_cpu == 1,
            available_gpu: info.available_gpu == 1,
            built_with_mfem_stack: info.built_with_mfem_stack == 1,
            built_with_cuda_runtime: info.built_with_cuda_runtime == 1,
            built_with_ceed: info.built_with_ceed == 1,
            native_fem_cpu_available: info.native_fem_cpu_available == 1,
            native_fem_gpu_available: info.native_fem_gpu_available == 1,
            native_fem_gpu_full_demag_available: info.native_fem_gpu_full_demag_available == 1,
            mfem_cuda_available: info.mfem_cuda_available == 1,
            hypre_gpu_available: info.hypre_gpu_available == 1,
            libceed_used_hot_path: info.libceed_used_hot_path == 1,
            visible_cuda_device_count: info.visible_cuda_device_count,
            requested_gpu_index: info.requested_gpu_index,
            resolved_gpu_index: info.resolved_gpu_index,
            memory_free_bytes: info.gpu_memory_free_bytes,
            memory_total_bytes: info.gpu_memory_total_bytes,
            reason,
            reason_cpu,
            reason_gpu,
        }
    }
    #[cfg(not(feature = "fem-gpu"))]
    {
        GpuAvailability {
            available: false,
            available_any: false,
            available_cpu: false,
            available_gpu: false,
            built_with_mfem_stack: false,
            built_with_cuda_runtime: false,
            built_with_ceed: false,
            native_fem_cpu_available: false,
            native_fem_gpu_available: false,
            native_fem_gpu_full_demag_available: false,
            mfem_cuda_available: false,
            hypre_gpu_available: false,
            libceed_used_hot_path: false,
            visible_cuda_device_count: 0,
            requested_gpu_index: -1,
            resolved_gpu_index: -1,
            memory_free_bytes: 0,
            memory_total_bytes: 0,
            reason: "fullmag-runner was built without the fem-gpu feature".to_string(),
            reason_cpu: "fullmag-runner was built without the fem-gpu feature".to_string(),
            reason_gpu: "fullmag-runner was built without the fem-gpu feature".to_string(),
        }
    }
}

#[cfg(feature = "fem-gpu")]
fn last_global_error_or(fallback: &str) -> String {
    let err = unsafe { ffi::fullmag_fem_backend_last_error(std::ptr::null_mut()) };
    if !err.is_null() {
        let msg = unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string();
        if !msg.is_empty() {
            return msg;
        }
    }
    fallback.to_string()
}
