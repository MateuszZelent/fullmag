//! Safe Rust wrapper around the native FDM CUDA backend.
//!
//! This module wraps the raw FFI from `fullmag-fdm-sys` with:
//! - RAII handle management (Drop)
//! - Result-based error handling
//! - AoS ↔ SoA boundary abstraction
//!
//! Phase 2: this is the Rust side of the CUDA execution path.
//! The actual native library must be built and available for linking.

#[cfg(feature = "cuda")]
use fullmag_fdm_sys as ffi;

use crate::types::RunError;

#[cfg(feature = "cuda")]
use std::ffi::CStr;

/// Check whether the native CUDA FDM backend is compiled and available.
pub(crate) fn is_cuda_available() -> bool {
    #[cfg(feature = "cuda")]
    {
        unsafe { ffi::fullmag_fdm_is_available() == 1 }
    }
    #[cfg(not(feature = "cuda"))]
    {
        false
    }
}

/// Safe wrapper around the native FDM backend handle.
#[cfg(feature = "cuda")]
pub(crate) struct NativeFdmBackend {
    handle: *mut ffi::fullmag_fdm_backend,
}

#[cfg(feature = "cuda")]
impl NativeFdmBackend {
    /// Create a new backend from an FDM execution plan.
    pub fn create(plan: &fullmag_ir::FdmPlanIR) -> Result<Self, RunError> {
        let grid = ffi::fullmag_fdm_grid_desc {
            nx: plan.grid.cells[0],
            ny: plan.grid.cells[1],
            nz: plan.grid.cells[2],
            dx: plan.cell_size[0],
            dy: plan.cell_size[1],
            dz: plan.cell_size[2],
        };

        let material = ffi::fullmag_fdm_material_desc {
            saturation_magnetisation: plan.material.saturation_magnetisation,
            exchange_stiffness: plan.material.exchange_stiffness,
            damping: plan.material.damping,
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
        };

        let precision = match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => {
                ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE
            }
            fullmag_ir::ExecutionPrecision::Double => {
                ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE
            }
        };

        let integrator = ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN;

        // Flatten [f64; 3] AoS → contiguous f64 buffer
        let m_flat: Vec<f64> = plan
            .initial_magnetization
            .iter()
            .flat_map(|v| v.iter().copied())
            .collect();

        let plan_desc = ffi::fullmag_fdm_plan_desc {
            grid,
            material,
            precision,
            integrator,
            initial_magnetization_xyz: m_flat.as_ptr(),
            initial_magnetization_len: m_flat.len() as u64,
        };

        let handle = unsafe { ffi::fullmag_fdm_backend_create(&plan_desc) };
        if handle.is_null() {
            return Err(RunError {
                message: "CUDA FDM backend_create returned null".to_string(),
            });
        }

        // Check for deferred creation errors
        let err = unsafe { ffi::fullmag_fdm_backend_last_error(handle) };
        if !err.is_null() {
            let msg = unsafe { CStr::from_ptr(err) }
                .to_string_lossy()
                .to_string();
            unsafe { ffi::fullmag_fdm_backend_destroy(handle) };
            return Err(RunError { message: msg });
        }

        Ok(Self { handle })
    }

    /// Execute one Heun time step.
    pub fn step(&mut self, dt: f64) -> Result<StepStats, RunError> {
        let mut stats = ffi::fullmag_fdm_step_stats {
            step: 0,
            time_seconds: 0.0,
            dt_seconds: 0.0,
            exchange_energy_joules: 0.0,
            max_effective_field_amplitude: 0.0,
            max_rhs_amplitude: 0.0,
            wall_time_ns: 0,
        };

        let rc = unsafe { ffi::fullmag_fdm_backend_step(self.handle, dt, &mut stats) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("step failed"));
        }

        Ok(StepStats {
            step: stats.step,
            time: stats.time_seconds,
            dt: stats.dt_seconds,
            e_ex: stats.exchange_energy_joules,
            max_h_eff: stats.max_effective_field_amplitude,
            max_dm_dt: stats.max_rhs_amplitude,
            wall_time_ns: stats.wall_time_ns,
        })
    }

    /// Copy a field observable from device to host as [f64; 3] AoS.
    pub fn copy_field(
        &self,
        observable: ffi::fullmag_fdm_observable,
        cell_count: usize,
    ) -> Result<Vec<[f64; 3]>, RunError> {
        let len = cell_count * 3;
        let mut flat = vec![0.0f64; len];

        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_field_f64(
                self.handle as *mut _,
                observable,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("copy_field failed"));
        }

        // Re-pack flat f64 → [f64; 3]
        let result: Vec<[f64; 3]> = flat
            .chunks_exact(3)
            .map(|c| [c[0], c[1], c[2]])
            .collect();

        Ok(result)
    }

    /// Query device info.
    pub fn device_info(&self) -> Result<DeviceInfo, RunError> {
        let mut info = ffi::fullmag_fdm_device_info {
            name: [0; 128],
            compute_capability_major: 0,
            compute_capability_minor: 0,
            driver_version: 0,
            runtime_version: 0,
        };

        let rc = unsafe {
            ffi::fullmag_fdm_backend_get_device_info(self.handle as *mut _, &mut info)
        };
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

    fn last_error_or(&self, fallback: &str) -> RunError {
        let err = unsafe { ffi::fullmag_fdm_backend_last_error(self.handle as *mut _) };
        let msg = if err.is_null() {
            fallback.to_string()
        } else {
            unsafe { CStr::from_ptr(err) }
                .to_string_lossy()
                .to_string()
        };
        RunError { message: msg }
    }
}

#[cfg(feature = "cuda")]
impl Drop for NativeFdmBackend {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::fullmag_fdm_backend_destroy(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

/// Parsed device info.
#[derive(Debug, Clone)]
pub(crate) struct DeviceInfo {
    pub name: String,
    pub compute_capability: String,
    pub driver_version: i32,
    pub runtime_version: i32,
}
