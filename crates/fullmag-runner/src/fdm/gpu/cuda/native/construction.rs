#[cfg(feature = "cuda")]
use super::math::flatten_vectors_f64;
#[cfg(feature = "cuda")]
use super::{ffi, NativeFdmBackend};
#[cfg(feature = "cuda")]
use crate::fdm::{validate_multilayer_grid_budget, validate_single_grid_budget};
#[cfg(feature = "cuda")]
use crate::relaxation::llg_overdamped_uses_pure_damping;
#[cfg(feature = "cuda")]
use crate::types::RunError;
#[cfg(feature = "cuda")]
use std::ffi::CStr;

#[cfg(feature = "cuda")]
fn has_slonczewski_stt(plan: &fullmag_ir::FdmPlanIR) -> bool {
    plan.current_density.is_some()
        && plan.stt_degree.is_some()
        && plan.stt_spin_polarization.is_some()
        && plan.stt_lambda.is_some()
}

#[cfg(feature = "cuda")]
fn ffi_transfer_kind(kind: &str) -> Result<ffi::fullmag_fdm_transfer_kind, RunError> {
    match kind {
        "identity" => Ok(ffi::fullmag_fdm_transfer_kind::FULLMAG_FDM_TRANSFER_IDENTITY),
        "push_pull" => Ok(ffi::fullmag_fdm_transfer_kind::FULLMAG_FDM_TRANSFER_PUSH_PULL),
        other => Err(RunError {
            message: format!("unsupported native FDM multilayer transfer_kind '{other}'"),
        }),
    }
}

#[cfg(feature = "cuda")]
struct NativeMultilayerTensorKernelHost {
    k_xx: Vec<ffi::fullmag_fdm_complex64>,
    k_yy: Vec<ffi::fullmag_fdm_complex64>,
    k_zz: Vec<ffi::fullmag_fdm_complex64>,
    k_xy: Vec<ffi::fullmag_fdm_complex64>,
    k_xz: Vec<ffi::fullmag_fdm_complex64>,
    k_yz: Vec<ffi::fullmag_fdm_complex64>,
}

#[cfg(feature = "cuda")]
impl NativeFdmBackend {
    pub fn create_multilayer_v2(plan: &fullmag_ir::FdmMultilayerPlanIR) -> Result<Self, RunError> {
        validate_multilayer_grid_budget(
            plan,
            fullmag_fdm_demag::KernelAdmissionModel::CudaAbiV2PairPayload,
        )?;
        let precision = match plan.precision {
            fullmag_ir::ExecutionPrecision::Single => {
                ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE
            }
            fullmag_ir::ExecutionPrecision::Double => {
                ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE
            }
        };

        let integrator = match plan.integrator {
            fullmag_ir::IntegratorChoice::Heun => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN
            }
            fullmag_ir::IntegratorChoice::Rk4 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4
            }
            fullmag_ir::IntegratorChoice::Rk23 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK23
            }
            fullmag_ir::IntegratorChoice::Rk45 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_DP45
            }
            fullmag_ir::IntegratorChoice::Abm3 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_ABM3
            }
        };

        let magnetization_storage = plan
            .layers
            .iter()
            .map(|layer| flatten_vectors_f64(&layer.initial_magnetization))
            .collect::<Vec<_>>();
        let active_mask_storage = plan
            .layers
            .iter()
            .map(|layer| {
                layer.native_active_mask.as_ref().map(|mask| {
                    mask.iter()
                        .map(|is_active| if *is_active { 1u8 } else { 0u8 })
                        .collect::<Vec<_>>()
                })
            })
            .collect::<Vec<_>>();

        let layer_descs = plan
            .layers
            .iter()
            .enumerate()
            .map(|(index, layer)| {
                let z_offset_cells = ((layer.native_origin[2] - layer.convolution_origin[2])
                    / layer.convolution_cell_size[2])
                    .round() as i32;
                Ok(ffi::fullmag_fdm_layer_desc_v2 {
                    native_grid: ffi_grid(layer.native_grid, layer.native_cell_size),
                    convolution_grid: ffi_grid(layer.convolution_grid, layer.convolution_cell_size),
                    transfer_kind: ffi_transfer_kind(&layer.transfer_kind)?,
                    layer_index: index as u32,
                    z_offset_cells,
                    material: ffi::fullmag_fdm_material_desc {
                        saturation_magnetisation: layer.material.saturation_magnetisation,
                        exchange_stiffness: layer.material.exchange_stiffness,
                        damping: layer.material.damping,
                        gyromagnetic_ratio: plan.gyromagnetic_ratio,
                    },
                    has_uniaxial_anisotropy: if layer.material.uniaxial_anisotropy_ku1.is_some() {
                        1
                    } else {
                        0
                    },
                    uniaxial_anisotropy_constant: layer
                        .material
                        .uniaxial_anisotropy_ku1
                        .unwrap_or(0.0),
                    uniaxial_anisotropy_k2: layer.material.uniaxial_anisotropy_ku2.unwrap_or(0.0),
                    anisotropy_axis: layer.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),
                    has_cubic_anisotropy: if layer.material.cubic_anisotropy_kc1.is_some()
                        || layer.material.cubic_anisotropy_kc2.is_some()
                        || layer.material.cubic_anisotropy_kc3.is_some()
                    {
                        1
                    } else {
                        0
                    },
                    cubic_kc1: layer.material.cubic_anisotropy_kc1.unwrap_or(0.0),
                    cubic_kc2: layer.material.cubic_anisotropy_kc2.unwrap_or(0.0),
                    cubic_kc3: layer.material.cubic_anisotropy_kc3.unwrap_or(0.0),
                    cubic_axis1: layer
                        .material
                        .cubic_anisotropy_axis1
                        .unwrap_or([1.0, 0.0, 0.0]),
                    cubic_axis2: layer
                        .material
                        .cubic_anisotropy_axis2
                        .unwrap_or([0.0, 1.0, 0.0]),
                    initial_magnetization_xyz: magnetization_storage[index].as_ptr(),
                    initial_magnetization_len: magnetization_storage[index].len() as u64,
                    active_mask: active_mask_storage[index]
                        .as_ref()
                        .map_or(std::ptr::null(), |mask| mask.as_ptr()),
                    active_mask_len: active_mask_storage[index]
                        .as_ref()
                        .map_or(0, |mask| mask.len() as u64),
                })
            })
            .collect::<Result<Vec<_>, RunError>>()?;

        let conv_grid = [
            plan.common_cells[0] as usize,
            plan.common_cells[1] as usize,
            plan.common_cells[2] as usize,
        ];
        let conv_cell_size = plan
            .layers
            .first()
            .map(|layer| layer.convolution_cell_size)
            .unwrap_or([1.0, 1.0, 1.0]);

        let mut kernel_payloads = Vec::new();
        let mut kernel_descs = Vec::new();
        if plan.enable_demag {
            kernel_payloads.reserve(plan.layers.len() * plan.layers.len());
            for (src_index, src_layer) in plan.layers.iter().enumerate() {
                for (dst_index, dst_layer) in plan.layers.iter().enumerate() {
                    let z_shift = dst_layer.native_origin[2] - src_layer.native_origin[2];
                    let kernel = if src_index == dst_index {
                        fullmag_fdm_demag::compute_exact_self_kernel(
                            conv_grid[0],
                            conv_grid[1],
                            conv_grid[2],
                            conv_cell_size[0],
                            conv_cell_size[1],
                            conv_cell_size[2],
                        )
                    } else {
                        fullmag_fdm_demag::compute_shifted_kernel(
                            conv_grid,
                            conv_cell_size,
                            z_shift,
                        )
                    };
                    kernel_payloads.push(NativeMultilayerTensorKernelHost {
                        k_xx: ffi_complex64_vec(&kernel.k_xx),
                        k_yy: ffi_complex64_vec(&kernel.k_yy),
                        k_zz: ffi_complex64_vec(&kernel.k_zz),
                        k_xy: ffi_complex64_vec(&kernel.k_xy),
                        k_xz: ffi_complex64_vec(&kernel.k_xz),
                        k_yz: ffi_complex64_vec(&kernel.k_yz),
                    });
                    let payload = kernel_payloads.last().expect("just pushed kernel payload");
                    kernel_descs.push(ffi::fullmag_fdm_tensor_kernel_desc_v2 {
                        fft_grid: ffi_grid(
                            [
                                kernel.fft_shape[0] as u32,
                                kernel.fft_shape[1] as u32,
                                kernel.fft_shape[2] as u32,
                            ],
                            conv_cell_size,
                        ),
                        dst_layer: dst_index as u32,
                        src_layer: src_index as u32,
                        z_shift_meters: z_shift,
                        kernel_xx: payload.k_xx.as_ptr(),
                        kernel_yy: payload.k_yy.as_ptr(),
                        kernel_zz: payload.k_zz.as_ptr(),
                        kernel_xy: payload.k_xy.as_ptr(),
                        kernel_xz: payload.k_xz.as_ptr(),
                        kernel_yz: payload.k_yz.as_ptr(),
                        kernel_len: payload.k_xx.len() as u64,
                    });
                }
            }
        }

        let plan_desc = ffi::fullmag_fdm_multilayer_plan_desc_v2 {
            kind: ffi::fullmag_fdm_plan_kind::FULLMAG_FDM_PLAN_MULTILAYER_CONV,
            precision,
            integrator,
            disable_precession: if llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()) {
                1
            } else {
                0
            },
            enable_exchange: if plan.enable_exchange { 1 } else { 0 },
            enable_demag: if plan.enable_demag { 1 } else { 0 },
            has_external_field: if plan.external_field.is_some() { 1 } else { 0 },
            external_field_am: plan.external_field.unwrap_or([0.0, 0.0, 0.0]),
            has_interfacial_dmi: if plan.interfacial_dmi.is_some() { 1 } else { 0 },
            dmi_d_interfacial: plan.interfacial_dmi.unwrap_or(0.0),
            has_bulk_dmi: if plan.bulk_dmi.is_some() { 1 } else { 0 },
            dmi_d_bulk: plan.bulk_dmi.unwrap_or(0.0),
            layers: layer_descs.as_ptr(),
            layer_count: layer_descs.len() as u32,
            kernels: if kernel_descs.is_empty() {
                std::ptr::null()
            } else {
                kernel_descs.as_ptr()
            },
            kernel_count: kernel_descs.len() as u32,
            adaptive_max_error: 0.0,
            adaptive_dt_min: 0.0,
            adaptive_dt_max: 0.0,
            adaptive_headroom: 0.0,
            stats_mode: ffi::fullmag_fdm_stats_mode::FULLMAG_FDM_STATS_FULL,
            stats_stride: 1,
        };

        let handle = unsafe { ffi::fullmag_fdm_backend_create_v2(&plan_desc) };
        if handle.is_null() {
            return Err(RunError {
                message: "CUDA FDM backend_create_v2 returned null".to_string(),
            });
        }

        let err = unsafe { ffi::fullmag_fdm_backend_last_error(handle) };
        if !err.is_null() {
            let msg = unsafe { CStr::from_ptr(err) }.to_string_lossy().to_string();
            if !msg.contains(
                "native Heun/RK4/fixed-step RK23 timestep with optional demag and layer-local exchange is available",
            ) && !msg
                .contains("native Heun timestep with demag and layer-local exchange is available")
                && !msg.contains("native demag-only Heun timestep is available")
            {
                unsafe { ffi::fullmag_fdm_backend_destroy(handle) };
                return Err(RunError { message: msg });
            }
        }

        let first_material = plan.layers.first().map(|layer| &layer.material);
        Ok(Self {
            handle,
            precision: plan.precision,
            damping: first_material.map_or(0.0, |material| material.damping),
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
            precession_enabled: !llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
        })
    }

    /// Create a new backend from an FDM execution plan.
    pub fn create(plan: &fullmag_ir::FdmPlanIR) -> Result<Self, RunError> {
        validate_single_grid_budget(plan)?;
        let sot_formula = super::ffi_prescribed_sot_formula(plan)?;
        let resolved_demag_boundary = crate::fdm::resolve_fdm_demag_boundary(plan)?;
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

        // The native descriptor retains an ABI-only slot that direct
        // minimizers do not consume.
        let integrator = match plan
            .integrator
            .unwrap_or(fullmag_ir::IntegratorChoice::Heun)
        {
            fullmag_ir::IntegratorChoice::Heun => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN
            }
            fullmag_ir::IntegratorChoice::Rk4 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4
            }
            fullmag_ir::IntegratorChoice::Rk23 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK23
            }
            fullmag_ir::IntegratorChoice::Rk45 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_DP45
            }
            fullmag_ir::IntegratorChoice::Abm3 => {
                ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_ABM3
            }
        };

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
        let sot_active_mask_flat: Option<Vec<u8>> = plan.sot_active_mask.as_ref().map(|mask| {
            mask.iter()
                .map(|is_target| if *is_target { 1u8 } else { 0u8 })
                .collect()
        });
        let region_mask_flat = if plan.region_mask.is_empty() {
            None
        } else {
            Some(plan.region_mask.clone())
        };
        let demag_kernel_spectra = if plan.enable_demag {
            if let fullmag_engine::FdmDemagBoundary::PeriodicTruncatedImages { image_counts } =
                resolved_demag_boundary
            {
                Some(fullmag_engine::compute_periodic_newell_kernel_spectra(
                    plan.grid.cells[0] as usize,
                    plan.grid.cells[1] as usize,
                    plan.grid.cells[2] as usize,
                    plan.cell_size[0],
                    plan.cell_size[1],
                    plan.cell_size[2],
                    plan.periodicity
                        .as_ref()
                        .map(|pbc| [pbc.is_periodic(0), pbc.is_periodic(1), pbc.is_periodic(2)])
                        .unwrap_or([false, false, false]),
                    image_counts,
                ))
            } else if plan.grid.cells[2] == 1 {
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
        let adaptive = plan.adaptive_timestep.as_ref();
        let oersted_field_flat: Option<Vec<f64>> = plan.oersted_field_xyz.as_ref().map(|field| {
            field
                .iter()
                .flat_map(|value| value.iter().copied())
                .collect()
        });
        let static_external_field_flat: Option<Vec<f64>> =
            plan.static_external_field_xyz.as_ref().map(|field| {
                field
                    .iter()
                    .flat_map(|value| value.iter().copied())
                    .collect()
            });
        let uploaded_profile_flat = static_external_field_flat
            .as_ref()
            .or(oersted_field_flat.as_ref());

        // Build exchange LUT when region mask is present.
        // Default: A_ii = A_material, A_ij (i≠j) = 0 (no inter-region coupling).
        // User-provided inter_region_exchange triples override specific pairs.
        let exchange_lut: Option<Vec<f64>> = if region_mask_flat.is_some() {
            let n = ffi::FULLMAG_FDM_MAX_EXCHANGE_REGIONS;
            let mut lut = vec![0.0f64; n * n];
            // Diagonal: self-exchange = material A
            for r in 0..n {
                lut[r * n + r] = plan.material.exchange_stiffness;
            }
            // Apply caller overrides (symmetric)
            for &(ri, rj, a_ij) in &plan.inter_region_exchange {
                let ri = ri as usize;
                let rj = rj as usize;
                if ri < n && rj < n {
                    lut[ri * n + rj] = a_ij;
                    lut[rj * n + ri] = a_ij;
                }
            }
            Some(lut)
        } else {
            None
        };

        let current_sign: f64 = if has_slonczewski_stt(plan) {
            match plan.stt_fixed_layer_position.as_deref() {
                Some("bottom") => -1.0,
                _ => 1.0,
            }
        } else {
            1.0
        };

        let plan_desc = ffi::fullmag_fdm_plan_desc {
            grid,
            material,
            precision,
            integrator,
            disable_precession: if llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()) {
                1
            } else {
                0
            },
            enable_exchange: if plan.enable_exchange { 1 } else { 0 },
            enable_demag: if plan.enable_demag { 1 } else { 0 },
            has_external_field: if plan.external_field.is_some() { 1 } else { 0 },
            external_field_am: plan.external_field.unwrap_or([0.0, 0.0, 0.0]),

            current_density_x: plan.current_density.map_or(0.0, |j| j[0]),
            current_density_y: plan.current_density.map_or(0.0, |j| j[1]),
            current_density_z: plan.current_density.map_or(0.0, |j| j[2]),
            stt_degree: plan.stt_degree.unwrap_or(0.0),
            stt_beta: plan.stt_beta.unwrap_or(0.0),

            stt_p_x: plan.stt_spin_polarization.map_or(0.0, |p| p[0]),
            stt_p_y: plan.stt_spin_polarization.map_or(0.0, |p| p[1]),
            stt_p_z: plan.stt_spin_polarization.map_or(0.0, |p| p[2]),
            stt_lambda: plan.stt_lambda.unwrap_or(0.0),
            stt_epsilon_prime: plan.stt_epsilon_prime.unwrap_or(0.0),
            stt_free_layer_thickness: plan.stt_thickness.unwrap_or(0.0),
            stt_current_sign: current_sign,

            has_sot: if plan.sot_current_density.is_some()
                && plan.sot_sigma.is_some()
                && plan.sot_thickness.is_some()
            {
                1
            } else {
                0
            },
            sot_formula,
            sot_je: plan.sot_current_density.unwrap_or(0.0),
            sot_xi_dl: plan.sot_xi_dl.unwrap_or(0.0),
            sot_xi_fl: plan.sot_xi_fl.unwrap_or(0.0),
            sot_sigma: plan.sot_sigma.unwrap_or([0.0, 0.0, 1.0]),
            sot_thickness: plan.sot_thickness.unwrap_or(1.0e-9),
            sot_active_mask: sot_active_mask_flat
                .as_ref()
                .map_or(std::ptr::null(), |mask| mask.as_ptr()),
            sot_active_mask_len: sot_active_mask_flat
                .as_ref()
                .map_or(0, |mask| mask.len() as u64),

            has_oersted_cylinder: if plan.has_oersted_cylinder { 1 } else { 0 },
            oersted_current: plan.oersted_current.unwrap_or(0.0),
            oersted_radius: plan.oersted_radius.unwrap_or(0.0),
            oersted_center: plan.oersted_center.unwrap_or([0.0, 0.0, 0.0]),
            oersted_axis: plan.oersted_axis.unwrap_or([0.0, 0.0, 1.0]),
            oersted_time_dep_kind: plan.oersted_time_dep_kind,
            oersted_time_dep_freq: plan.oersted_time_dep_freq,
            oersted_time_dep_phase: plan.oersted_time_dep_phase,
            oersted_time_dep_offset: plan.oersted_time_dep_offset,
            oersted_time_dep_t_on: plan.oersted_time_dep_t_on,
            oersted_time_dep_t_off: plan.oersted_time_dep_t_off,
            oersted_field_xyz: uploaded_profile_flat
                .as_ref()
                .map_or(std::ptr::null(), |field| field.as_ptr()),
            oersted_field_len: uploaded_profile_flat
                .as_ref()
                .map_or(0, |field| field.len() as u64),

            has_uniaxial_anisotropy: if plan.material.uniaxial_anisotropy_ku1.is_some() {
                1
            } else {
                0
            },
            uniaxial_anisotropy_constant: plan.material.uniaxial_anisotropy_ku1.unwrap_or(0.0),
            uniaxial_anisotropy_k2: plan.material.uniaxial_anisotropy_ku2.unwrap_or(0.0),
            anisotropy_axis: plan.material.anisotropy_axis.unwrap_or([0.0, 0.0, 1.0]),

            ku1_field: std::ptr::null(),
            ku2_field: std::ptr::null(),

            has_cubic_anisotropy: if plan.material.cubic_anisotropy_kc1.is_some()
                || plan.material.cubic_anisotropy_kc2.is_some()
                || plan.material.cubic_anisotropy_kc3.is_some()
            {
                1
            } else {
                0
            },
            cubic_kc1: plan.material.cubic_anisotropy_kc1.unwrap_or(0.0),
            cubic_kc2: plan.material.cubic_anisotropy_kc2.unwrap_or(0.0),
            cubic_kc3: plan.material.cubic_anisotropy_kc3.unwrap_or(0.0),
            cubic_axis1: plan
                .material
                .cubic_anisotropy_axis1
                .unwrap_or([1.0, 0.0, 0.0]),
            cubic_axis2: plan
                .material
                .cubic_anisotropy_axis2
                .unwrap_or([0.0, 1.0, 0.0]),
            kc1_field: std::ptr::null(),
            kc2_field: std::ptr::null(),
            kc3_field: std::ptr::null(),

            has_interfacial_dmi: if plan.interfacial_dmi.is_some() { 1 } else { 0 },
            dmi_d_interfacial: plan.interfacial_dmi.unwrap_or(0.0),
            has_bulk_dmi: if plan.bulk_dmi.is_some() { 1 } else { 0 },
            dmi_d_bulk: plan.bulk_dmi.unwrap_or(0.0),

            has_magnetoelastic: if plan.mel_b1.is_some() && plan.mel_uniform_strain.is_some() {
                1
            } else {
                0
            },
            mel_b1: plan.mel_b1.unwrap_or(0.0),
            mel_b2: plan.mel_b2.unwrap_or(0.0),
            mel_strain: plan.mel_uniform_strain.unwrap_or([0.0; 6]),

            temperature: plan.temperature.unwrap_or(0.0),
            thermal_seed: plan
                .thermal_seed_config
                .as_ref()
                .and_then(|config| config.seed)
                .unwrap_or(0),

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
            demag_fft_nx: demag_kernel_spectra
                .as_ref()
                .map_or(0, |kernels| kernels.px as u32),
            demag_fft_ny: demag_kernel_spectra
                .as_ref()
                .map_or(0, |kernels| kernels.py as u32),
            demag_fft_nz: demag_kernel_spectra
                .as_ref()
                .map_or(0, |kernels| kernels.pz as u32),
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
            exchange_lut: exchange_lut
                .as_ref()
                .map_or(std::ptr::null(), |lut| lut.as_ptr()),
            exchange_lut_len: exchange_lut.as_ref().map_or(0, |lut| lut.len() as u64),
            // Boundary correction — wire geometry data from planner when available.
            boundary_correction: match plan.boundary_correction.as_deref() {
                Some("volume") => ffi::fullmag_fdm_boundary_correction::FULLMAG_FDM_BOUNDARY_VOLUME,
                Some("full") => ffi::fullmag_fdm_boundary_correction::FULLMAG_FDM_BOUNDARY_FULL,
                _ => ffi::fullmag_fdm_boundary_correction::FULLMAG_FDM_BOUNDARY_NONE,
            },
            boundary_phi_floor: plan.boundary_phi_floor.unwrap_or(0.0),
            boundary_delta_min: plan.boundary_delta_min.unwrap_or(0.0),
            volume_fraction: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.volume_fraction.as_ptr()),
            volume_fraction_len: plan
                .boundary_geometry
                .as_ref()
                .map_or(0, |bg| bg.volume_fraction.len() as u64),
            face_link_xp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_xp.as_ptr()),
            face_link_xm: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_xm.as_ptr()),
            face_link_yp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_yp.as_ptr()),
            face_link_ym: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_ym.as_ptr()),
            face_link_zp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_zp.as_ptr()),
            face_link_zm: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.face_link_zm.as_ptr()),
            delta_xp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_xp.as_ptr()),
            delta_xm: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_xm.as_ptr()),
            delta_yp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_yp.as_ptr()),
            delta_ym: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_ym.as_ptr()),
            delta_zp: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_zp.as_ptr()),
            delta_zm: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.delta_zm.as_ptr()),
            has_demag_boundary_corr: plan.boundary_geometry.as_ref().map_or(0, |bg| {
                if bg.demag_corr_target_idx.is_empty() {
                    0
                } else {
                    1
                }
            }),
            demag_corr_target_idx: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.demag_corr_target_idx.as_ptr()),
            demag_corr_source_idx: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.demag_corr_source_idx.as_ptr()),
            demag_corr_tensor: plan
                .boundary_geometry
                .as_ref()
                .map_or(std::ptr::null(), |bg| bg.demag_corr_tensor.as_ptr()),
            demag_corr_target_count: plan
                .boundary_geometry
                .as_ref()
                .map_or(0, |bg| bg.demag_corr_target_idx.len() as u32),
            demag_corr_stencil_size: plan
                .boundary_geometry
                .as_ref()
                .map_or(0, |bg| bg.demag_corr_stencil_size),
            initial_magnetization_xyz: m_flat.as_ptr(),
            initial_magnetization_len: m_flat.len() as u64,
            periodic_x: plan
                .periodicity
                .as_ref()
                .map_or(0, |p| if p.is_periodic(0) { 1 } else { 0 }),
            periodic_y: plan
                .periodicity
                .as_ref()
                .map_or(0, |p| if p.is_periodic(1) { 1 } else { 0 }),
            periodic_z: plan
                .periodicity
                .as_ref()
                .map_or(0, |p| if p.is_periodic(2) { 1 } else { 0 }),
            adaptive_max_error: adaptive.map_or(0.0, |cfg| cfg.atol),
            adaptive_dt_min: adaptive.map_or(0.0, |cfg| cfg.dt_min),
            adaptive_dt_max: adaptive.and_then(|cfg| cfg.dt_max).unwrap_or(0.0),
            adaptive_headroom: adaptive.map_or(0.0, |cfg| cfg.safety),
            stats_mode: ffi::fullmag_fdm_stats_mode::FULLMAG_FDM_STATS_FULL,
            stats_stride: 1,
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

        if let Some(field) = static_external_field_flat.as_ref() {
            let marked = unsafe {
                ffi::fullmag_fdm_backend_set_static_external_field_f64(
                    handle,
                    field.as_ptr(),
                    field.len() as u64,
                )
            };
            if marked != 1 {
                let message = unsafe {
                    let err = ffi::fullmag_fdm_backend_last_error(handle);
                    if err.is_null() {
                        "failed to mark static external field profile".to_string()
                    } else {
                        CStr::from_ptr(err).to_string_lossy().to_string()
                    }
                };
                unsafe { ffi::fullmag_fdm_backend_destroy(handle) };
                return Err(RunError { message });
            }
        }

        Ok(Self {
            handle,
            precision: plan.precision,
            damping: plan.material.damping,
            gyromagnetic_ratio: plan.gyromagnetic_ratio,
            precession_enabled: !llg_overdamped_uses_pure_damping(plan.relaxation.as_ref()),
        })
    }
}

#[cfg(feature = "cuda")]
fn ffi_grid(cells: [u32; 3], cell_size: [f64; 3]) -> ffi::fullmag_fdm_grid_desc {
    ffi::fullmag_fdm_grid_desc {
        nx: cells[0],
        ny: cells[1],
        nz: cells[2],
        dx: cell_size[0],
        dy: cell_size[1],
        dz: cell_size[2],
    }
}

#[cfg(feature = "cuda")]
fn ffi_complex64_vec(values: &[num_complex::Complex<f64>]) -> Vec<ffi::fullmag_fdm_complex64> {
    values
        .iter()
        .map(|value| ffi::fullmag_fdm_complex64 {
            re: value.re,
            im: value.im,
        })
        .collect()
}
