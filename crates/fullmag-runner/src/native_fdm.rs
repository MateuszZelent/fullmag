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

#[cfg(feature = "cuda")]
use crate::preview::{
    build_grid_preview_field, build_grid_preview_field_from_flat_plan, normalize_quantity_id,
    plan_grid_preview,
};
#[cfg(feature = "cuda")]
use crate::types::{LivePreviewField, LivePreviewRequest, RunError};
#[cfg(feature = "cuda")]
use crate::types::StepStats;

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
        let active_mask_flat: Option<Vec<u8>> = plan.active_mask.as_ref().map(|mask| {
            mask.iter()
                .map(|is_active| if *is_active { 1u8 } else { 0u8 })
                .collect()
        });
        let region_mask_flat = if plan.region_mask.is_empty() {
            None
        } else {
            Some(plan.region_mask.clone())
        };
        let demag_kernel_spectra = if plan.enable_demag {
            if plan.grid.cells[2] == 1 {
                Some(fullmag_engine::compute_newell_kernel_spectra_thin_film_2d(
                    plan.grid.cells[0] as usize,
                    plan.grid.cells[1] as usize,
                    plan.cell_size[0],
                    plan.cell_size[1],
                    plan.cell_size[2],
                ))
            } else {
                Some(fullmag_engine::compute_newell_kernel_spectra(
                    plan.grid.cells[0] as usize,
                    plan.grid.cells[1] as usize,
                    plan.grid.cells[2] as usize,
                    plan.cell_size[0],
                    plan.cell_size[1],
                    plan.cell_size[2],
                ))
            }
        } else {
            None
        };

        let plan_desc = ffi::fullmag_fdm_plan_desc {
            grid,
            material,
            precision,
            integrator,
            enable_exchange: if plan.enable_exchange { 1 } else { 0 },
            enable_demag: if plan.enable_demag { 1 } else { 0 },
            has_external_field: if plan.external_field.is_some() { 1 } else { 0 },
            external_field_am: plan.external_field.unwrap_or([0.0, 0.0, 0.0]),
            demag_kernel_xx_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_xx.as_ptr()),
            demag_kernel_yy_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_yy.as_ptr()),
            demag_kernel_zz_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_zz.as_ptr()),
            demag_kernel_xy_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_xy.as_ptr()),
            demag_kernel_xz_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_xz.as_ptr()),
            demag_kernel_yz_spectrum: demag_kernel_spectra
                .as_ref()
                .map_or(std::ptr::null(), |kernels| kernels.n_yz.as_ptr()),
            demag_kernel_spectrum_len: demag_kernel_spectra
                .as_ref()
                .map_or(0, |kernels| kernels.n_xx.len() as u64),
            active_mask: active_mask_flat
                .as_ref()
                .map_or(std::ptr::null(), |mask| mask.as_ptr()),
            active_mask_len: active_mask_flat
                .as_ref()
                .map_or(0, |mask| mask.len() as u64),
            region_mask: region_mask_flat
                .as_ref()
                .map_or(std::ptr::null(), |mask| mask.as_ptr()),
            region_mask_len: region_mask_flat
                .as_ref()
                .map_or(0, |mask| mask.len() as u64),
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
            let msg = unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string();
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
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            total_energy_joules: 0.0,
            max_effective_field_amplitude: 0.0,
            max_demag_field_amplitude: 0.0,
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
            e_demag: stats.demag_energy_joules,
            e_ext: stats.external_energy_joules,
            e_total: stats.total_energy_joules,
            max_h_eff: stats.max_effective_field_amplitude,
            max_h_demag: stats.max_demag_field_amplitude,
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
        let result: Vec<[f64; 3]> = flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();

        Ok(result)
    }

    pub fn copy_m(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
            cell_count,
        )
    }

    pub fn copy_h_ex(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
            cell_count,
        )
    }

    pub fn copy_h_demag(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            cell_count,
        )
    }

    pub fn copy_h_ext(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
            cell_count,
        )
    }

    pub fn copy_h_eff(&self, cell_count: usize) -> Result<Vec<[f64; 3]>, RunError> {
        self.copy_field(
            ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
            cell_count,
        )
    }

    pub fn copy_live_preview_field(
        &self,
        request: &LivePreviewRequest,
        original_grid: [u32; 3],
    ) -> Result<LivePreviewField, RunError> {
        let plan = plan_grid_preview(request, original_grid);
        let quantity = normalize_quantity_id(&request.quantity);
        let preview_count = (plan.preview_grid[0] as usize)
            * (plan.preview_grid[1] as usize)
            * (plan.preview_grid[2] as usize);
        if preview_count == 0 {
            return Err(RunError {
                message: "copy_field_preview planned an empty preview grid".to_string(),
            });
        }

        let observable = match quantity {
            "H_ex" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EX,
            "H_demag" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_DEMAG,
            "H_ext" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EXT,
            "H_eff" => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_H_EFF,
            _ => ffi::fullmag_fdm_observable::FULLMAG_FDM_OBSERVABLE_M,
        };
        let len = preview_count * 3;
        let mut flat = vec![0.0f64; len];
        let rc = unsafe {
            ffi::fullmag_fdm_backend_copy_field_preview_f64(
                self.handle as *mut _,
                observable,
                plan.preview_grid[0],
                plan.preview_grid[1],
                plan.preview_grid[2],
                plan.z_origin,
                plan.applied_layer_stride,
                flat.as_mut_ptr(),
                len as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("copy_field_preview failed"));
        }
        Ok(build_grid_preview_field_from_flat_plan(
            request, &plan, flat, quantity,
        ))
    }

    pub fn upload_magnetization(&mut self, magnetization: &[[f64; 3]]) -> Result<(), RunError> {
        let flat: Vec<f64> = magnetization
            .iter()
            .flat_map(|vector| vector.iter().copied())
            .collect();
        let rc = unsafe {
            ffi::fullmag_fdm_backend_upload_magnetization_f64(
                self.handle as *mut _,
                flat.as_ptr(),
                flat.len() as u64,
            )
        };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("upload_magnetization failed"));
        }
        Ok(())
    }

    pub fn refresh_observables(&mut self) -> Result<(), RunError> {
        let rc = unsafe { ffi::fullmag_fdm_backend_refresh_observables(self.handle as *mut _) };
        if rc != ffi::FULLMAG_FDM_OK {
            return Err(self.last_error_or("refresh_observables failed"));
        }
        Ok(())
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

    fn last_error_or(&self, fallback: &str) -> RunError {
        let err = unsafe { ffi::fullmag_fdm_backend_last_error(self.handle as *mut _) };
        let msg = if err.is_null() {
            fallback.to_string()
        } else {
            unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string()
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
#[cfg(feature = "cuda")]
#[derive(Debug, Clone)]
pub(crate) struct DeviceInfo {
    pub name: String,
    pub compute_capability: String,
    pub driver_version: i32,
    pub runtime_version: i32,
}

#[cfg(all(test, feature = "cuda"))]
mod tests {
    use super::*;
    use fullmag_engine::{
        CellSize, EffectiveFieldTerms, ExchangeLlgProblem, LlgConfig, MaterialParameters,
        TimeIntegrator,
    };
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, FdmPlanIR, GridDimensions,
        IntegratorChoice,
    };

    fn make_masked_test_plan(enable_demag: bool) -> FdmPlanIR {
        FdmPlanIR {
            grid: GridDimensions { cells: [3, 3, 1] },
            cell_size: [5e-9, 5e-9, 10e-9],
            region_mask: vec![0; 9],
            active_mask: Some(vec![true, true, true, true, false, true, true, true, false]),
            initial_magnetization: vec![
                [1.0, 0.0, 0.0],
                [0.9950041652780258, 0.09983341664682815, 0.0],
                [0.9800665778412416, 0.19866933079506122, 0.0],
                [0.9992009587217894, 0.0, 0.03996803834887158],
                [0.9937606691655043, 0.09970865087213879, 0.04972948160146045],
                [0.9778332467629838, 0.19771314245924698, 0.06988589031642899],
                [
                    0.9968017063026194,
                    -0.039904089712529575,
                    0.06972124896577284,
                ],
                [0.9892364775387807, 0.05946310942269411, 0.1338082836649087],
                [0.9711213242426827, 0.15730105252897553, 0.17902957342582418],
            ],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.1,
            },
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(2.5e-13),
            relaxation: None,
            enable_exchange: true,
            enable_demag,
            external_field: Some([1.5e3, -2.0e3, 7.5e2]),
        }
    }

    fn make_thin_film_demag_plan() -> FdmPlanIR {
        let nx = 8usize;
        let ny = 6usize;
        let nz = 1usize;
        let mut initial_magnetization = Vec::with_capacity(nx * ny * nz);
        for y in 0..ny {
            for x in 0..nx {
                let theta = 0.11 * x as f64;
                let phi = 0.07 * y as f64;
                let mx = theta.cos() * phi.cos();
                let my = theta.sin() * phi.cos();
                let mz = 0.2 * phi.sin();
                let norm = (mx * mx + my * my + mz * mz).sqrt();
                initial_magnetization.push([mx / norm, my / norm, mz / norm]);
            }
        }

        FdmPlanIR {
            grid: GridDimensions {
                cells: [nx as u32, ny as u32, nz as u32],
            },
            cell_size: [4e-9, 4e-9, 10e-9],
            region_mask: vec![0; nx * ny * nz],
            active_mask: None,
            initial_magnetization,
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.1,
            },
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(2.0e-13),
            relaxation: None,
            enable_exchange: true,
            enable_demag: true,
            external_field: Some([2.0e3, -1.0e3, 5.0e2]),
        }
    }

    fn assert_scalar_close(label: &str, actual: f64, expected: f64, rel_tol: f64, abs_tol: f64) {
        let diff = (actual - expected).abs();
        let scale = expected.abs().max(actual.abs()).max(1.0);
        assert!(
            diff <= abs_tol.max(rel_tol * scale),
            "{} mismatch: actual={} expected={} diff={}",
            label,
            actual,
            expected,
            diff
        );
    }

    fn assert_vector_field_close(
        label: &str,
        actual: &[[f64; 3]],
        expected: &[[f64; 3]],
        rel_tol: f64,
        abs_tol: f64,
    ) {
        assert_eq!(actual.len(), expected.len(), "{} length mismatch", label);
        for (index, (a, e)) in actual.iter().zip(expected.iter()).enumerate() {
            for component in 0..3 {
                assert_scalar_close(
                    &format!("{}[{}][{}]", label, index, component),
                    a[component],
                    e[component],
                    rel_tol,
                    abs_tol,
                );
            }
        }
    }

    fn cpu_reference_single_step(
        plan: &FdmPlanIR,
    ) -> (
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        Vec<[f64; 3]>,
        fullmag_engine::StepReport,
    ) {
        let grid = fullmag_engine::GridShape::new(
            plan.grid.cells[0] as usize,
            plan.grid.cells[1] as usize,
            plan.grid.cells[2] as usize,
        )
        .expect("grid");
        let cell_size =
            CellSize::new(plan.cell_size[0], plan.cell_size[1], plan.cell_size[2]).expect("cell");
        let material = MaterialParameters::new(
            plan.material.saturation_magnetisation,
            plan.material.exchange_stiffness,
            plan.material.damping,
        )
        .expect("material");
        let dynamics =
            LlgConfig::new(plan.gyromagnetic_ratio, TimeIntegrator::Heun).expect("dynamics");
        let problem = ExchangeLlgProblem::with_terms_and_mask(
            grid,
            cell_size,
            material,
            dynamics,
            EffectiveFieldTerms {
                exchange: plan.enable_exchange,
                demag: plan.enable_demag,
                external_field: plan.external_field,
            },
            plan.active_mask.clone(),
        )
        .expect("problem");

        let mut state = problem
            .new_state(plan.initial_magnetization.clone())
            .expect("state");
        let mut workspace = problem.create_workspace();
        let report = problem
            .step_with_workspace(
                &mut state,
                plan.fixed_timestep.expect("fixed dt"),
                &mut workspace,
            )
            .expect("cpu step");
        let observables = problem.observe(&state).expect("observe");
        (
            state.magnetization().to_vec(),
            observables.exchange_field,
            observables.demag_field,
            observables.external_field,
            observables.effective_field,
            report,
        )
    }

    #[test]
    fn native_fdm_masked_exchange_only_matches_cpu_reference_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM masked parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let plan = make_masked_test_plan(false);
        let active_mask = plan.active_mask.clone().expect("active mask");
        let cell_count = plan.initial_magnetization.len();
        let (
            expected_m,
            expected_h_ex,
            _expected_h_demag,
            expected_h_ext,
            expected_h_eff,
            expected_report,
        ) = cpu_reference_single_step(&plan);

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");
        let actual_m = backend.copy_m(cell_count).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
        let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
        let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

        assert_vector_field_close("m", &actual_m, &expected_m, 5e-6, 1e-8);
        assert_vector_field_close("H_ex", &actual_h_ex, &expected_h_ex, 5e-5, 1e-2);
        assert_vector_field_close("H_ext", &actual_h_ext, &expected_h_ext, 1e-12, 1e-12);
        assert_vector_field_close("H_eff", &actual_h_eff, &expected_h_eff, 5e-5, 1e-2);

        for (index, is_active) in active_mask.iter().enumerate() {
            if !is_active {
                assert_eq!(
                    actual_m[index],
                    [0.0, 0.0, 0.0],
                    "inactive m leak at {index}"
                );
                assert_eq!(
                    actual_h_ex[index],
                    [0.0, 0.0, 0.0],
                    "inactive H_ex leak at {index}"
                );
                assert_eq!(
                    actual_h_ext[index],
                    [0.0, 0.0, 0.0],
                    "inactive H_ext leak at {index}"
                );
                assert_eq!(
                    actual_h_eff[index],
                    [0.0, 0.0, 0.0],
                    "inactive H_eff leak at {index}"
                );
            }
        }

        assert_scalar_close(
            "time_seconds",
            stats.time,
            expected_report.time_seconds,
            1e-12,
            1e-18,
        );
        assert_scalar_close(
            "exchange_energy_joules",
            stats.e_ex,
            expected_report.exchange_energy_joules,
            5e-6,
            1e-18,
        );
        assert_scalar_close(
            "external_energy_joules",
            stats.e_ext,
            expected_report.external_energy_joules,
            1e-6,
            1e-18,
        );
        assert_scalar_close(
            "total_energy_joules",
            stats.e_total,
            expected_report.total_energy_joules,
            5e-6,
            1e-18,
        );
        assert_scalar_close(
            "max_effective_field_amplitude",
            stats.max_h_eff,
            expected_report.max_effective_field_amplitude,
            5e-5,
            1e-4,
        );
        assert_scalar_close(
            "max_rhs_amplitude",
            stats.max_dm_dt,
            expected_report.max_rhs_amplitude,
            5e-5,
            1e-4,
        );
    }

    #[test]
    fn native_fdm_masked_demag_fields_stay_zero_outside_active_domain_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM masked demag test: CUDA backend is not available on this host"
            );
            return;
        }

        let plan = make_masked_test_plan(true);
        let active_mask = plan.active_mask.clone().expect("active mask");
        let cell_count = plan.initial_magnetization.len();

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");

        let actual_m = backend.copy_m(cell_count).expect("copy m");
        let actual_h_demag = backend.copy_h_demag(cell_count).expect("copy H_demag");
        let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
        let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

        for (index, is_active) in active_mask.iter().enumerate() {
            if !is_active {
                assert_eq!(
                    actual_m[index],
                    [0.0, 0.0, 0.0],
                    "inactive m leak at {index}"
                );
                assert_eq!(
                    actual_h_demag[index],
                    [0.0, 0.0, 0.0],
                    "inactive H_demag leak at {index}"
                );
                assert_eq!(
                    actual_h_ext[index],
                    [0.0, 0.0, 0.0],
                    "inactive H_ext leak at {index}"
                );
                assert_eq!(
                    actual_h_eff[index],
                    [0.0, 0.0, 0.0],
                    "inactive H_eff leak at {index}"
                );
            } else {
                assert_eq!(
                    actual_h_ext[index],
                    plan.external_field.expect("external field"),
                    "active H_ext mismatch at {index}"
                );
            }
        }

        assert!(
            actual_h_demag
                .iter()
                .zip(active_mask.iter())
                .any(|(value, is_active)| *is_active && *value != [0.0, 0.0, 0.0]),
            "expected at least one active cell to carry non-zero H_demag"
        );
    }

    #[test]
    fn native_fdm_thin_film_demag_matches_cpu_reference_when_cuda_is_available() {
        if !is_cuda_available() {
            eprintln!(
                "skipping native CUDA FDM thin-film demag parity test: CUDA backend is not available on this host"
            );
            return;
        }

        let plan = make_thin_film_demag_plan();
        let cell_count = plan.initial_magnetization.len();
        let (
            expected_m,
            expected_h_ex,
            expected_h_demag,
            expected_h_ext,
            expected_h_eff,
            expected_report,
        ) = cpu_reference_single_step(&plan);

        let mut backend = NativeFdmBackend::create(&plan).expect("native fdm create");
        let stats = backend
            .step(plan.fixed_timestep.expect("fixed dt"))
            .expect("native fdm step");
        let actual_m = backend.copy_m(cell_count).expect("copy m");
        let actual_h_ex = backend.copy_h_ex(cell_count).expect("copy H_ex");
        let actual_h_demag = backend.copy_h_demag(cell_count).expect("copy H_demag");
        let actual_h_ext = backend.copy_h_ext(cell_count).expect("copy H_ext");
        let actual_h_eff = backend.copy_h_eff(cell_count).expect("copy H_eff");

        assert_vector_field_close("thin.m", &actual_m, &expected_m, 5e-6, 1e-8);
        assert_vector_field_close("thin.H_ex", &actual_h_ex, &expected_h_ex, 5e-5, 5e-2);
        assert_vector_field_close(
            "thin.H_demag",
            &actual_h_demag,
            &expected_h_demag,
            5e-4,
            1e-1,
        );
        assert_vector_field_close("thin.H_ext", &actual_h_ext, &expected_h_ext, 1e-12, 1e-12);
        assert_vector_field_close("thin.H_eff", &actual_h_eff, &expected_h_eff, 5e-4, 1e-1);

        assert_scalar_close(
            "thin.exchange_energy",
            stats.e_ex,
            expected_report.exchange_energy_joules,
            5e-5,
            1e-21,
        );
        assert_scalar_close(
            "thin.demag_energy",
            stats.e_demag,
            expected_report.demag_energy_joules,
            5e-4,
            1e-21,
        );
        assert_scalar_close(
            "thin.external_energy",
            stats.e_ext,
            expected_report.external_energy_joules,
            5e-6,
            1e-21,
        );
        assert_scalar_close(
            "thin.total_energy",
            stats.e_total,
            expected_report.total_energy_joules,
            5e-4,
            1e-21,
        );
    }
}
