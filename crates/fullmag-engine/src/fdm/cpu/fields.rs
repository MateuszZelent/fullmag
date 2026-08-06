//! Field computations, energy calculations, torques, observables, and LLG RHS
//! for `ExchangeLlgProblem`.
//!
//! Every function here lives inside `impl ExchangeLlgProblem`.

use rustfft::num_complex::Complex;

use crate::fdm::cpu::fft::{combine_fields_4, padded_index, zero_vectors};
use crate::fdm::cpu::fft_backend::FdmFftBackend;
use crate::fdm::shared::types::{neighbor_index, AxisBoundary};
use crate::magnetoelastic;
use crate::telemetry::{sections, StepTelemetry};
use crate::vector::{add, cross, dot, max_cross_norm, max_norm, norm, scale, squared_norm, sub};
use crate::{
    EffectiveFieldObservables, ExchangeLlgProblem, FftWorkspace, OerstedCylinderConfig,
    RhsEvaluation, SlonczewskiFormula, SlonczewskiSttConfig, SotConfig, SotFormula, Vector3,
    VectorFieldSoA,
    ZhangLiFormula, ZhangLiSttConfig, MU0,
};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

fn slonczewski_prefactor(
    formula: SlonczewskiFormula,
    current_sign: f64,
    current_density_magnitude: f64,
    gamma0: f64,
    saturation_magnetisation: f64,
    thickness: f64,
) -> f64 {
    const HBAR: f64 = 1.054571817e-34;
    const EXACT_E_CHARGE: f64 = 1.602176634e-19;
    const LEGACY_E_CHARGE: f64 = 1.60217662e-19;
    const MU0_CONST: f64 = 1.2566370614359173e-6;
    let charge = match formula {
        SlonczewskiFormula::FullmagV2 | SlonczewskiFormula::FullmagV1 => EXACT_E_CHARGE,
        SlonczewskiFormula::LegacyFullmagV0 => LEGACY_E_CHARGE,
    };
    let omega_denominator_factor = match formula {
        SlonczewskiFormula::FullmagV2 => 1.0,
        SlonczewskiFormula::FullmagV1 | SlonczewskiFormula::LegacyFullmagV0 => 2.0,
    };
    current_sign * (current_density_magnitude * HBAR * gamma0)
        / (omega_denominator_factor
            * charge
            * MU0_CONST
            * saturation_magnetisation
            * thickness)
}

fn gilbert_slonczewski_scales(
    formula: SlonczewskiFormula,
    omega_j: f64,
    epsilon: f64,
    epsilon_prime: f64,
    alpha: f64,
) -> (f64, f64) {
    let inv_gilbert = 1.0 / (1.0 + alpha * alpha);
    match formula {
        SlonczewskiFormula::FullmagV2 | SlonczewskiFormula::FullmagV1 => (
            omega_j * (epsilon + alpha * epsilon_prime) * inv_gilbert,
            omega_j * (epsilon_prime - alpha * epsilon) * inv_gilbert,
        ),
        SlonczewskiFormula::LegacyFullmagV0 => {
            let beta_stt = omega_j * epsilon;
            (
                beta_stt * (1.0 + alpha * epsilon_prime) * inv_gilbert,
                beta_stt * (epsilon_prime - alpha) * inv_gilbert,
            )
        }
    }
}

fn gilbert_zhang_li_scales(beta: f64, alpha: f64) -> (f64, f64) {
    let inv_gilbert = 1.0 / (1.0 + alpha * alpha);
    (
        (1.0 + alpha * beta) * inv_gilbert,
        (alpha - beta) * inv_gilbert,
    )
}

/// Evaluate the canonical local Slonczewski RHS contribution shared by the
/// FDM and FEM reference realizations.  Target-mask and active-cell policy
/// stay with the caller; this function owns only the SI algebra and Gilbert
/// conversion.
pub(crate) fn slonczewski_torque_from_config(
    magnetization: Vector3,
    cfg: &SlonczewskiSttConfig,
    alpha: f64,
    gyromagnetic_ratio: f64,
    saturation_magnetisation: f64,
) -> Vector3 {
    let ms = saturation_magnetisation.max(1e-30);
    let thickness = cfg.thickness.max(1e-30);
    let prefactor = slonczewski_prefactor(
        cfg.formula,
        cfg.current_sign,
        cfg.current_density_magnitude,
        gyromagnetic_ratio,
        ms,
        thickness,
    );
    let [px, py, pz] = cfg.spin_polarization_axis;
    let m_dot_p = dot(magnetization, [px, py, pz]);
    let lambda_squared = cfg.lambda * cfg.lambda;
    let degree = if cfg.degree > 0.0 { cfg.degree } else { 1.0 };
    let epsilon = (degree * lambda_squared)
        / ((lambda_squared + 1.0) + (lambda_squared - 1.0) * m_dot_p);
    let (damping_like, field_like) = gilbert_slonczewski_scales(
        cfg.formula,
        prefactor,
        epsilon,
        cfg.epsilon_prime,
        alpha,
    );
    let m_cross_p = cross(magnetization, [px, py, pz]);
    let m_cross_m_cross_p = cross(magnetization, m_cross_p);
    add(
        scale(m_cross_m_cross_p, damping_like),
        scale(m_cross_p, field_like),
    )
}

fn anisotropy_energy_density_for_magnetization(
    magnetization: Vector3,
    uniaxial: Option<(Vector3, f64, f64)>,
    cubic: Option<(Vector3, Vector3, Vector3, f64, f64, f64)>,
) -> f64 {
    let mut energy_density = 0.0;
    if let Some((axis, ku1, ku2)) = uniaxial {
        let projection = dot(magnetization, axis);
        energy_density -= ku1 * projection * projection + ku2 * projection.powi(4);
    }
    if let Some((c1, c2, c3, kc1, kc2, kc3)) = cubic {
        let m1 = dot(magnetization, c1);
        let m2 = dot(magnetization, c2);
        let m3 = dot(magnetization, c3);
        let m1_sq = m1 * m1;
        let m2_sq = m2 * m2;
        let m3_sq = m3 * m3;
        let sigma = m1_sq * m2_sq + m2_sq * m3_sq + m1_sq * m3_sq;
        energy_density += kc1 * sigma + kc2 * m1_sq * m2_sq * m3_sq + kc3 * sigma * sigma;
    }
    energy_density
}

fn oersted_envelope_at_time(cfg: &OerstedCylinderConfig, time_seconds: f64) -> f64 {
    match cfg.time_dep_kind {
        0 => 1.0,
        1 => {
            (2.0 * std::f64::consts::PI * cfg.time_dep_freq * time_seconds + cfg.time_dep_phase)
                .sin()
                + cfg.time_dep_offset
        }
        2 => {
            if time_seconds >= cfg.time_dep_t_on && time_seconds < cfg.time_dep_t_off {
                1.0
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

fn prescribed_sot_scales(
    cfg: &SotConfig,
    saturation_magnetisation: f64,
    gamma0: f64,
    alpha: f64,
) -> (f64, f64) {
    const HBAR: f64 = 1.054571817e-34;
    const EXACT_E_CHARGE: f64 = 1.602176634e-19;
    const LEGACY_E_CHARGE: f64 = 1.60217662e-19;
    let envelope_multiplier = match cfg.envelope.as_ref() {
        None => 1.0,
        Some(fullmag_ir::TimeEnvelopeIR::Constant { value }) => *value,
        Some(_) => unreachable!("non-constant SOT envelopes must fail construction"),
    };
    let current_density = cfg.current_density * envelope_multiplier;

    match cfg.formula {
        SotFormula::FullmagV1 => {
            let gamma_e = gamma0 / MU0;
            let omega_base = gamma_e * HBAR * current_density
                / (2.0 * EXACT_E_CHARGE * saturation_magnetisation * cfg.thickness.max(1e-30));
            let omega_dl = omega_base * cfg.xi_dl;
            let omega_fl = omega_base * cfg.xi_fl;
            let inv_gilbert = 1.0 / (1.0 + alpha * alpha);
            (
                (omega_dl - alpha * omega_fl) * inv_gilbert,
                (omega_fl + alpha * omega_dl) * inv_gilbert,
            )
        }
        SotFormula::LegacyFullmagV0 => {
            let amplitude = current_density.abs() * HBAR
                / (2.0
                    * LEGACY_E_CHARGE
                    * MU0
                    * saturation_magnetisation
                    * cfg.thickness.max(1e-30));
            (amplitude * cfg.xi_dl, amplitude * cfg.xi_fl)
        }
    }
}

/// Evaluate the backend-neutral prescribed-SOT local torque for one
/// magnetization vector. FEM and FDM reference paths call this helper so the
/// SI constants, Gilbert conversion, and cross-product signs stay identical.
pub(crate) fn prescribed_sot_torque_from_config(
    magnetization: Vector3,
    cfg: &SotConfig,
    saturation_magnetisation: f64,
    gamma0: f64,
    alpha: f64,
) -> Vector3 {
    let ms = saturation_magnetisation.max(1e-30);
    let (damping_like, field_like) = prescribed_sot_scales(cfg, ms, gamma0, alpha);
    let [sx, sy, sz] = cfg.sigma;
    let snorm = (sx * sx + sy * sy + sz * sz).sqrt().max(1e-30);
    let sigma = [sx / snorm, sy / snorm, sz / snorm];
    let [m0, m1, m2] = magnetization;
    let mxs = [
        m1 * sigma[2] - m2 * sigma[1],
        m2 * sigma[0] - m0 * sigma[2],
        m0 * sigma[1] - m1 * sigma[0],
    ];
    let mmxs = [
        m1 * mxs[2] - m2 * mxs[1],
        m2 * mxs[0] - m0 * mxs[2],
        m0 * mxs[1] - m1 * mxs[0],
    ];
    [
        -damping_like * mmxs[0] + field_like * mxs[0],
        -damping_like * mmxs[1] + field_like * mxs[1],
        -damping_like * mmxs[2] + field_like * mxs[2],
    ]
}

impl ExchangeLlgProblem {
    // ===================================================================
    // Observables
    // ===================================================================

    pub(crate) fn observe_vectors_ws_at_time(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        time_seconds: f64,
    ) -> EffectiveFieldObservables {
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let demag_field = if self.terms.demag {
            self.demag_field_from_vectors_ws(magnetization, ws)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let external_field = self.external_field_vectors();
        let mel_field = self.magnetoelastic_field(magnetization);
        let ani_field = self.anisotropy_field(magnetization);
        let idmi_field = self.interfacial_dmi_field(magnetization);
        let bdmi_field = self.bulk_dmi_field(magnetization);
        let dmi_field = idmi_field
            .iter()
            .zip(bdmi_field.iter())
            .map(|(interfacial, bulk)| add(*interfacial, *bulk))
            .collect::<Vec<_>>();
        let mut effective_field =
            combine_fields_4(&exchange_field, &demag_field, &external_field, &mel_field);
        for (i, h) in effective_field.iter_mut().enumerate() {
            *h = add(add(*h, ani_field[i]), dmi_field[i]);
        }
        let mut cylinder_oersted_field = zero_vectors(self.grid.cell_count());
        self.oersted_field_add_into_at_time(&mut cylinder_oersted_field, time_seconds);
        for (effective, oersted) in effective_field
            .iter_mut()
            .zip(cylinder_oersted_field.iter())
        {
            *effective = add(*effective, *oersted);
        }
        let rhs = {
            let compute = |i: usize| self.llg_rhs_from_field(magnetization[i], effective_field[i]);
            #[cfg(feature = "parallel")]
            {
                (0..magnetization.len())
                    .into_par_iter()
                    .map(compute)
                    .collect::<Vec<_>>()
            }
            #[cfg(not(feature = "parallel"))]
            {
                (0..magnetization.len()).map(compute).collect::<Vec<_>>()
            }
        };

        let exchange_energy_joules = if self.terms.exchange {
            self.exchange_energy_from_field(magnetization, &exchange_field)
        } else {
            0.0
        };
        let demag_energy_joules = if self.terms.demag {
            self.demag_energy_from_fields(magnetization, &demag_field)
        } else {
            0.0
        };
        let external_energy_joules = if self.terms.external_field.is_some()
            || self.terms.per_node_field.is_some()
            || self.terms.oersted_cylinder.is_some()
        {
            let combined_external = external_field
                .iter()
                .zip(cylinder_oersted_field.iter())
                .map(|(external, oersted)| add(*external, *oersted))
                .collect::<Vec<_>>();
            self.external_energy_from_fields(magnetization, &combined_external)
        } else {
            0.0
        };
        let mel_energy_joules = self.magnetoelastic_energy(magnetization);
        let ani_energy_joules = self.anisotropy_energy(magnetization);
        let dmi_energy_joules = self.dmi_energy_from_vectors(magnetization);
        let total_energy_joules = exchange_energy_joules
            + demag_energy_joules
            + external_energy_joules
            + mel_energy_joules
            + ani_energy_joules
            + dmi_energy_joules;

        let max_effective_field_amplitude = max_norm(&effective_field);
        let max_demag_field_amplitude = max_norm(&demag_field);
        let max_rhs_amplitude = max_norm(&rhs);

        EffectiveFieldObservables {
            magnetization: magnetization.to_vec(),
            exchange_field,
            demag_field,
            external_field,
            effective_field: effective_field.clone(),
            dmi_field,
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            anisotropy_energy_joules: ani_energy_joules,
            dmi_energy_joules,
            total_energy_joules,
            max_effective_field_amplitude,
            max_demag_field_amplitude,
            max_rhs_amplitude,
            max_torque_Apm: max_cross_norm(magnetization, &effective_field),
        }
    }

    // ===================================================================
    // Individual field terms (allocating)
    // ===================================================================

    pub(crate) fn cell_exchange_field(
        &self,
        flat_index: usize,
        magnetization: &[Vector3],
        px: bool,
        py: bool,
        pz: bool,
        dx2: f64,
        dy2: f64,
        dz2: f64,
    ) -> Vector3 {
        if !self.is_active(flat_index) {
            return [0.0, 0.0, 0.0];
        }
        let grid = self.grid;
        let x = flat_index % grid.nx;
        let y = (flat_index / grid.nx) % grid.ny;
        let z = flat_index / (grid.nx * grid.ny);
        let center = magnetization[flat_index];
        let ai = self.a_at(flat_index);
        let ms_i = self.ms_at(flat_index);

        let sample_neighbor_contrib = |nx: usize, ny: usize, nz: usize, dist2: f64| -> Vector3 {
            let neighbor_index = grid.index(nx, ny, nz);
            if self.is_active(neighbor_index) {
                let aj = self.a_at(neighbor_index);
                let aij = if ai == 0.0 || aj == 0.0 {
                    0.0
                } else {
                    2.0 * ai * aj / (ai + aj)
                };
                let coeff = 2.0 * aij / (MU0 * ms_i * dist2);
                scale(sub(magnetization[neighbor_index], center), coeff)
            } else {
                [0.0, 0.0, 0.0]
            }
        };

        let x_minus_idx = neighbor_index(x, grid.nx, -1, px);
        let x_plus_idx = neighbor_index(x, grid.nx, 1, px);
        let y_minus_idx = neighbor_index(y, grid.ny, -1, py);
        let y_plus_idx = neighbor_index(y, grid.ny, 1, py);
        let z_minus_idx = neighbor_index(z, grid.nz, -1, pz);
        let z_plus_idx = neighbor_index(z, grid.nz, 1, pz);

        let h_x_minus = sample_neighbor_contrib(x_minus_idx, y, z, dx2);
        let h_x_plus = sample_neighbor_contrib(x_plus_idx, y, z, dx2);
        let h_y_minus = sample_neighbor_contrib(x, y_minus_idx, z, dy2);
        let h_y_plus = sample_neighbor_contrib(x, y_plus_idx, z, dy2);
        let h_z_minus = sample_neighbor_contrib(x, y, z_minus_idx, dz2);
        let h_z_plus = sample_neighbor_contrib(x, y, z_plus_idx, dz2);

        [
            h_x_minus[0] + h_x_plus[0] + h_y_minus[0] + h_y_plus[0] + h_z_minus[0] + h_z_plus[0],
            h_x_minus[1] + h_x_plus[1] + h_y_minus[1] + h_y_plus[1] + h_z_minus[1] + h_z_plus[1],
            h_x_minus[2] + h_x_plus[2] + h_y_minus[2] + h_y_plus[2] + h_z_minus[2] + h_z_plus[2],
        ]
    }

    pub(crate) fn exchange_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let grid = self.grid;
        let dx2 = self.cell_size.dx * self.cell_size.dx;
        let dy2 = self.cell_size.dy * self.cell_size.dy;
        let dz2 = self.cell_size.dz * self.cell_size.dz;
        let px = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let py = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let pz = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

        let compute_cell = |flat_index: usize| -> Vector3 {
            self.cell_exchange_field(flat_index, magnetization, px, py, pz, dx2, dy2, dz2)
        };

        #[cfg(feature = "parallel")]
        {
            (0..grid.cell_count())
                .into_par_iter()
                .map(compute_cell)
                .collect()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..grid.cell_count()).map(compute_cell).collect()
        }
    }

    pub(crate) fn demag_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let mut ws = self.create_workspace();
        self.demag_field_from_vectors_ws(magnetization, &mut ws)
    }

    pub(crate) fn observable_demag_field_from_vectors(
        &self,
        magnetization: &[Vector3],
    ) -> Vec<Vector3> {
        let mut ws = self.create_workspace();
        self.observable_demag_field_from_vectors_ws(magnetization, &mut ws)
    }

    pub(crate) fn demag_field_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        self.demag_field_from_vectors_ws_with_output_mask(magnetization, ws, true)
    }

    pub(crate) fn observable_demag_field_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        self.demag_field_from_vectors_ws_with_output_mask(magnetization, ws, false)
    }

    fn demag_field_from_vectors_ws_with_output_mask(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        mask_inactive_output: bool,
    ) -> Vec<Vector3> {
        let px = ws.px;
        let py = ws.py;
        let pz = ws.pz;
        let padded_len = px * py * pz;

        ws.clear_m_bufs();

        for z in 0..self.grid.nz {
            for y in 0..self.grid.ny {
                for x in 0..self.grid.nx {
                    let src_index = self.grid.index(x, y, z);
                    let dst_index = padded_index(px, py, x, y, z);
                    let moment = if self.is_active(src_index) {
                        scale(magnetization[src_index], self.ms_at(src_index))
                    } else {
                        [0.0, 0.0, 0.0]
                    };
                    ws.buf_mx[dst_index] = Complex::new(moment[0], 0.0);
                    ws.buf_my[dst_index] = Complex::new(moment[1], 0.0);
                    ws.buf_mz[dst_index] = Complex::new(moment[2], 0.0);
                }
            }
        }

        ws.fft3_m_forward();

        #[cfg(feature = "parallel")]
        {
            let (mx_sl, my_sl, mz_sl) = (&ws.buf_mx[..], &ws.buf_my[..], &ws.buf_mz[..]);
            let (kxx, kyy, kzz) = (&ws.kern_xx[..], &ws.kern_yy[..], &ws.kern_zz[..]);
            let (kxy, kxz, kyz) = (&ws.kern_xy[..], &ws.kern_xz[..], &ws.kern_yz[..]);
            let hx = &mut ws.buf_hx[..];
            let hy = &mut ws.buf_hy[..];
            let hz = &mut ws.buf_hz[..];
            hx.par_iter_mut().enumerate().for_each(|(i, h)| {
                *h = -(kxx[i] * mx_sl[i] + kxy[i] * my_sl[i] + kxz[i] * mz_sl[i]);
            });
            hy.par_iter_mut().enumerate().for_each(|(i, h)| {
                *h = -(kxy[i] * mx_sl[i] + kyy[i] * my_sl[i] + kyz[i] * mz_sl[i]);
            });
            hz.par_iter_mut().enumerate().for_each(|(i, h)| {
                *h = -(kxz[i] * mx_sl[i] + kyz[i] * my_sl[i] + kzz[i] * mz_sl[i]);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for i in 0..padded_len {
                let mx = ws.buf_mx[i];
                let my = ws.buf_my[i];
                let mz = ws.buf_mz[i];
                ws.buf_hx[i] = -(ws.kern_xx[i] * mx + ws.kern_xy[i] * my + ws.kern_xz[i] * mz);
                ws.buf_hy[i] = -(ws.kern_xy[i] * mx + ws.kern_yy[i] * my + ws.kern_yz[i] * mz);
                ws.buf_hz[i] = -(ws.kern_xz[i] * mx + ws.kern_yz[i] * my + ws.kern_zz[i] * mz);
            }
        }

        ws.fft3_h_inverse();

        let normalisation = 1.0 / padded_len as f64;
        let mut field = vec![[0.0, 0.0, 0.0]; self.grid.cell_count()];
        for z in 0..self.grid.nz {
            for y in 0..self.grid.ny {
                for x in 0..self.grid.nx {
                    let src_index = padded_index(px, py, x, y, z);
                    let dst_index = self.grid.index(x, y, z);
                    field[dst_index] = if !mask_inactive_output || self.is_active(dst_index) {
                        [
                            ws.buf_hx[src_index].re * normalisation,
                            ws.buf_hy[src_index].re * normalisation,
                            ws.buf_hz[src_index].re * normalisation,
                        ]
                    } else {
                        [0.0, 0.0, 0.0]
                    };
                }
            }
        }

        field
    }

    pub(crate) fn external_field_vectors(&self) -> Vec<Vector3> {
        let external = self.terms.external_field.unwrap_or([0.0, 0.0, 0.0]);
        (0..self.grid.cell_count())
            .map(|i| {
                if !self.is_active(i) {
                    return [0.0, 0.0, 0.0];
                }
                let mut value = external;
                if let Some(per_node_field) = self.terms.per_node_field.as_ref() {
                    if let Some(node_value) = per_node_field.get(i) {
                        value[0] += node_value[0];
                        value[1] += node_value[1];
                        value[2] += node_value[2];
                    }
                }
                value
            })
            .collect()
    }

    pub(crate) fn has_external_zeeman_source(&self) -> bool {
        self.terms.external_field.is_some()
            || self.terms.per_node_field.is_some()
            || self.terms.oersted_cylinder.is_some()
    }

    pub(crate) fn external_zeeman_field_vectors(&self) -> Vec<Vector3> {
        let mut field = self.external_field_vectors();
        self.oersted_field_add_into(&mut field);
        field
    }

    pub(crate) fn magnetoelastic_field(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        match &self.terms.magnetoelastic {
            Some(config) => magnetoelastic::h_mel_field(
                magnetization,
                &config.strain,
                &config.params,
                self.active_mask.as_deref(),
            ),
            None => zero_vectors(self.grid.cell_count()),
        }
    }

    pub(crate) fn magnetoelastic_energy(&self, magnetization: &[Vector3]) -> f64 {
        match &self.terms.magnetoelastic {
            Some(config) => {
                let cell_volume = self.cell_size.dx * self.cell_size.dy * self.cell_size.dz;
                magnetoelastic::e_mel_total(
                    magnetization,
                    &config.strain,
                    &config.params,
                    cell_volume,
                    self.active_mask.as_deref(),
                )
            }
            None => 0.0,
        }
    }

    pub(crate) fn magnetoelastic_energy_soa(&self, magnetization: &VectorFieldSoA) -> f64 {
        let config = match &self.terms.magnetoelastic {
            Some(config) => config,
            None => return 0.0,
        };
        let n = magnetization.len();
        let cell_volume = self.cell_size.volume();

        let compute_cell = |i: usize, strain: &magnetoelastic::StrainVoigt| {
            if self.is_active(i) {
                magnetoelastic::e_mel_density_single(
                    [magnetization.x[i], magnetization.y[i], magnetization.z[i]],
                    strain,
                    &config.params,
                )
            } else {
                0.0
            }
        };

        let sum: f64 = match &config.strain {
            magnetoelastic::PrescribedStrainField::Uniform(strain) => {
                (0..n).map(|i| compute_cell(i, strain)).sum()
            }
            magnetoelastic::PrescribedStrainField::PerCell(strain) => {
                assert_eq!(
                    strain.len(),
                    n,
                    "strain field length must match magnetization"
                );
                (0..n).map(|i| compute_cell(i, &strain[i])).sum()
            }
        };
        sum * cell_volume
    }

    pub fn anisotropy_field(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let has_uni = self.terms.uniaxial_anisotropy.is_some();
        let has_cub = self.terms.cubic_anisotropy.is_some();
        if !has_uni && !has_cub {
            return zero_vectors(self.grid.cell_count());
        }
        magnetization
            .iter()
            .enumerate()
            .map(|(i, m)| {
                if !self.is_active(i) {
                    return [0.0, 0.0, 0.0];
                }
                let ms_safe = self.ms_at(i).max(1e-30);
                let mut h = [0.0f64, 0.0, 0.0];
                if let Some(ref uni) = self.terms.uniaxial_anisotropy {
                    let n = norm(uni.axis).max(1e-30);
                    let u = scale(uni.axis, 1.0 / n);
                    let m_dot_u = dot(*m, u);
                    let coeff = 2.0 * uni.ku1 / (MU0 * ms_safe) * m_dot_u
                        + 4.0 * uni.ku2 / (MU0 * ms_safe) * m_dot_u * m_dot_u * m_dot_u;
                    h = add(h, scale(u, coeff));
                }
                if let Some(ref cub) = self.terms.cubic_anisotropy {
                    let n1 = norm(cub.axis1).max(1e-30);
                    let n2 = norm(cub.axis2).max(1e-30);
                    let c1 = scale(cub.axis1, 1.0 / n1);
                    let c2 = scale(cub.axis2, 1.0 / n2);
                    let c3 = cross(c1, c2);
                    let m1 = dot(*m, c1);
                    let m2 = dot(*m, c2);
                    let m3 = dot(*m, c3);
                    let sigma = m1 * m1 * m2 * m2 + m2 * m2 * m3 * m3 + m1 * m1 * m3 * m3;
                    let pf = 2.0 / (MU0 * ms_safe);
                    let g1 = -pf
                        * (cub.kc1 * m1 * (m2 * m2 + m3 * m3)
                            + cub.kc2 * m1 * m2 * m2 * m3 * m3
                            + 2.0 * cub.kc3 * sigma * m1 * (m2 * m2 + m3 * m3));
                    let g2 = -pf
                        * (cub.kc1 * m2 * (m1 * m1 + m3 * m3)
                            + cub.kc2 * m2 * m1 * m1 * m3 * m3
                            + 2.0 * cub.kc3 * sigma * m2 * (m1 * m1 + m3 * m3));
                    let g3 = -pf
                        * (cub.kc1 * m3 * (m1 * m1 + m2 * m2)
                            + cub.kc2 * m3 * m1 * m1 * m2 * m2
                            + 2.0 * cub.kc3 * sigma * m3 * (m1 * m1 + m2 * m2));
                    h = add(h, add(add(scale(c1, g1), scale(c2, g2)), scale(c3, g3)));
                }
                h
            })
            .collect()
    }

    pub(crate) fn anisotropy_energy(&self, magnetization: &[Vector3]) -> f64 {
        let cell_volume = self.cell_size.volume();
        self.anisotropy_energy_density_from_vectors(magnetization)
            .into_iter()
            .map(|density| density * cell_volume)
            .sum()
    }

    pub(crate) fn anisotropy_energy_from_soa(&self, magnetization: &VectorFieldSoA) -> f64 {
        let uni_data = self.terms.uniaxial_anisotropy.as_ref().map(|uni| {
            let n = norm(uni.axis).max(1e-30);
            (scale(uni.axis, 1.0 / n), uni.ku1, uni.ku2)
        });
        let cub_data = self.terms.cubic_anisotropy.as_ref().map(|cub| {
            let n1 = norm(cub.axis1).max(1e-30);
            let n2 = norm(cub.axis2).max(1e-30);
            let c1 = scale(cub.axis1, 1.0 / n1);
            let c2 = scale(cub.axis2, 1.0 / n2);
            (c1, c2, cross(c1, c2), cub.kc1, cub.kc2, cub.kc3)
        });
        let cell_volume = self.cell_size.volume();

        (0..magnetization.len())
            .filter(|&i| self.is_active(i))
            .map(|i| {
                let m = [magnetization.x[i], magnetization.y[i], magnetization.z[i]];
                anisotropy_energy_density_for_magnetization(m, uni_data, cub_data) * cell_volume
            })
            .sum()
    }

    pub(crate) fn dmi_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        let cell_volume = self.cell_size.volume();
        self.dmi_energy_density_from_vectors(magnetization)
            .into_iter()
            .map(|density| density * cell_volume)
            .sum()
    }

    pub fn dmi_energy_density_from_vectors(&self, magnetization: &[Vector3]) -> Vec<f64> {
        let interfacial_dmi = match self.terms.interfacial_dmi {
            Some(d) if d.abs() > 0.0 => Some(d),
            _ => None,
        };
        let bulk_dmi = match self.terms.bulk_dmi {
            Some(d) if d.abs() > 0.0 => Some(d),
            _ => None,
        };
        if interfacial_dmi.is_none() && bulk_dmi.is_none() {
            return vec![0.0; self.grid.cell_count()];
        }

        let grid = self.grid;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let dz = self.cell_size.dz;
        let bpx = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let bpy = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let bpz = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

        let compute = |flat: usize| -> f64 {
            if !self.is_active(flat) {
                return 0.0;
            }
            let x = flat % grid.nx;
            let y = (flat / grid.nx) % grid.ny;
            let z = flat / (grid.nx * grid.ny);
            let sample = |neighbor: usize| {
                if self.is_active(neighbor) {
                    neighbor
                } else {
                    flat
                }
            };
            let xp = sample(grid.index(neighbor_index(x, grid.nx, 1, bpx), y, z));
            let xm = sample(grid.index(neighbor_index(x, grid.nx, -1, bpx), y, z));
            let yp = sample(grid.index(x, neighbor_index(y, grid.ny, 1, bpy), z));
            let ym = sample(grid.index(x, neighbor_index(y, grid.ny, -1, bpy), z));
            let zp = sample(grid.index(x, y, neighbor_index(z, grid.nz, 1, bpz)));
            let zm = sample(grid.index(x, y, neighbor_index(z, grid.nz, -1, bpz)));

            let m = magnetization[flat];
            let mut energy = 0.0;
            if let Some(d) = interfacial_dmi {
                let dmx_dx = (magnetization[xp][0] - magnetization[xm][0]) / (2.0 * dx);
                let dmy_dy = (magnetization[yp][1] - magnetization[ym][1]) / (2.0 * dy);
                let dmz_dx = (magnetization[xp][2] - magnetization[xm][2]) / (2.0 * dx);
                let dmz_dy = (magnetization[yp][2] - magnetization[ym][2]) / (2.0 * dy);
                energy += d * (m[2] * (dmx_dx + dmy_dy) - m[0] * dmz_dx - m[1] * dmz_dy);
            }
            if let Some(d) = bulk_dmi {
                let curl_x = (magnetization[yp][2] - magnetization[ym][2]) / (2.0 * dy)
                    - (magnetization[zp][1] - magnetization[zm][1]) / (2.0 * dz);
                let curl_y = (magnetization[zp][0] - magnetization[zm][0]) / (2.0 * dz)
                    - (magnetization[xp][2] - magnetization[xm][2]) / (2.0 * dx);
                let curl_z = (magnetization[xp][1] - magnetization[xm][1]) / (2.0 * dx)
                    - (magnetization[yp][0] - magnetization[ym][0]) / (2.0 * dy);
                energy += d * (m[0] * curl_x + m[1] * curl_y + m[2] * curl_z);
            }
            energy
        };

        #[cfg(feature = "parallel")]
        {
            (0..grid.cell_count())
                .into_par_iter()
                .map(compute)
                .collect()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..grid.cell_count()).map(compute).collect()
        }
    }

    pub(crate) fn dmi_energy_from_soa(&self, magnetization: &VectorFieldSoA) -> f64 {
        let interfacial_dmi = match self.terms.interfacial_dmi {
            Some(d) if d.abs() > 0.0 => Some(d),
            _ => None,
        };
        let bulk_dmi = match self.terms.bulk_dmi {
            Some(d) if d.abs() > 0.0 => Some(d),
            _ => None,
        };
        if interfacial_dmi.is_none() && bulk_dmi.is_none() {
            return 0.0;
        }

        let grid = self.grid;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let dz = self.cell_size.dz;
        let cell_volume = self.cell_size.volume();
        let bpx = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let bpy = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let bpz = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

        let mut energy = 0.0;
        for flat in 0..grid.cell_count() {
            if !self.is_active(flat) {
                continue;
            }
            let x = flat % grid.nx;
            let y = (flat / grid.nx) % grid.ny;
            let z = flat / (grid.nx * grid.ny);
            let sample = |neighbor: usize| {
                if self.is_active(neighbor) {
                    neighbor
                } else {
                    flat
                }
            };
            let xp = sample(grid.index(neighbor_index(x, grid.nx, 1, bpx), y, z));
            let xm = sample(grid.index(neighbor_index(x, grid.nx, -1, bpx), y, z));
            let yp = sample(grid.index(x, neighbor_index(y, grid.ny, 1, bpy), z));
            let ym = sample(grid.index(x, neighbor_index(y, grid.ny, -1, bpy), z));
            let zp = sample(grid.index(x, y, neighbor_index(z, grid.nz, 1, bpz)));
            let zm = sample(grid.index(x, y, neighbor_index(z, grid.nz, -1, bpz)));

            let mx = magnetization.x[flat];
            let my = magnetization.y[flat];
            let mz = magnetization.z[flat];
            if let Some(d) = interfacial_dmi {
                let dmx_dx = (magnetization.x[xp] - magnetization.x[xm]) / (2.0 * dx);
                let dmy_dy = (magnetization.y[yp] - magnetization.y[ym]) / (2.0 * dy);
                let dmz_dx = (magnetization.z[xp] - magnetization.z[xm]) / (2.0 * dx);
                let dmz_dy = (magnetization.z[yp] - magnetization.z[ym]) / (2.0 * dy);
                energy += cell_volume * d * (mz * (dmx_dx + dmy_dy) - mx * dmz_dx - my * dmz_dy);
            }
            if let Some(d) = bulk_dmi {
                let curl_x = (magnetization.z[yp] - magnetization.z[ym]) / (2.0 * dy)
                    - (magnetization.y[zp] - magnetization.y[zm]) / (2.0 * dz);
                let curl_y = (magnetization.x[zp] - magnetization.x[zm]) / (2.0 * dz)
                    - (magnetization.z[xp] - magnetization.z[xm]) / (2.0 * dx);
                let curl_z = (magnetization.y[xp] - magnetization.y[xm]) / (2.0 * dx)
                    - (magnetization.x[yp] - magnetization.x[ym]) / (2.0 * dy);
                energy += cell_volume * d * (mx * curl_x + my * curl_y + mz * curl_z);
            }
        }
        energy
    }

    pub(crate) fn interfacial_dmi_field(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let d = match self.terms.interfacial_dmi {
            Some(d) if d.abs() > 0.0 => d,
            _ => return zero_vectors(self.grid.cell_count()),
        };
        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let _nz = self.grid.nz;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let px = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let py = matches!(self.boundary_policy.y, AxisBoundary::Periodic);

        (0..self.grid.cell_count())
            .map(|flat| {
                if !self.is_active(flat) {
                    return [0.0, 0.0, 0.0];
                }
                let ms = self.ms_at(flat).max(1e-30);
                let pf = 2.0 * d / (MU0 * ms);
                let x = flat % nx;
                let y = (flat / nx) % ny;
                let z = flat / (nx * ny);
                let center = magnetization[flat];
                let sample = |neighbor: usize| {
                    if self.is_active(neighbor) {
                        magnetization[neighbor]
                    } else {
                        center
                    }
                };

                let xp = sample(self.grid.index(neighbor_index(x, nx, 1, px), y, z));
                let xm = sample(self.grid.index(neighbor_index(x, nx, -1, px), y, z));
                let yp = sample(self.grid.index(x, neighbor_index(y, ny, 1, py), z));
                let ym = sample(self.grid.index(x, neighbor_index(y, ny, -1, py), z));

                let dx_mz = (xp[2] - xm[2]) / (2.0 * dx);
                let dy_mz = (yp[2] - ym[2]) / (2.0 * dy);
                let dx_mx = (xp[0] - xm[0]) / (2.0 * dx);
                let dy_my = (yp[1] - ym[1]) / (2.0 * dy);

                [pf * dx_mz, pf * dy_mz, -pf * (dx_mx + dy_my)]
            })
            .collect()
    }

    pub(crate) fn bulk_dmi_field(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let d = match self.terms.bulk_dmi {
            Some(d) if d.abs() > 0.0 => d,
            _ => return zero_vectors(self.grid.cell_count()),
        };
        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let nz = self.grid.nz;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let dz = self.cell_size.dz;
        let px = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let py = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let pz = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

        (0..self.grid.cell_count())
            .map(|flat| {
                if !self.is_active(flat) {
                    return [0.0, 0.0, 0.0];
                }
                let ms = self.ms_at(flat).max(1e-30);
                let pf = -2.0 * d / (MU0 * ms);
                let x = flat % nx;
                let y = (flat / nx) % ny;
                let z = flat / (nx * ny);
                let center = magnetization[flat];
                let sample = |neighbor: usize| {
                    if self.is_active(neighbor) {
                        magnetization[neighbor]
                    } else {
                        center
                    }
                };

                let xp = sample(self.grid.index(neighbor_index(x, nx, 1, px), y, z));
                let xm = sample(self.grid.index(neighbor_index(x, nx, -1, px), y, z));
                let yp = sample(self.grid.index(x, neighbor_index(y, ny, 1, py), z));
                let ym = sample(self.grid.index(x, neighbor_index(y, ny, -1, py), z));
                let zp = sample(self.grid.index(x, y, neighbor_index(z, nz, 1, pz)));
                let zm = sample(self.grid.index(x, y, neighbor_index(z, nz, -1, pz)));

                let curl_x = (yp[2] - ym[2]) / (2.0 * dy) - (zp[1] - zm[1]) / (2.0 * dz);
                let curl_y = (zp[0] - zm[0]) / (2.0 * dz) - (xp[2] - xm[2]) / (2.0 * dx);
                let curl_z = (xp[1] - xm[1]) / (2.0 * dx) - (yp[0] - ym[0]) / (2.0 * dy);

                [pf * curl_x, pf * curl_y, pf * curl_z]
            })
            .collect()
    }

    // ===================================================================
    // Zero-allocation in-place field accumulation methods
    // ===================================================================

    pub(crate) fn exchange_field_add_into(&self, magnetization: &[Vector3], h_eff: &mut [Vector3]) {
        #[cfg(not(feature = "parallel"))]
        let grid = self.grid;
        let dx2 = self.cell_size.dx * self.cell_size.dx;
        let dy2 = self.cell_size.dy * self.cell_size.dy;
        let dz2 = self.cell_size.dz * self.cell_size.dz;
        let px = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let py = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let pz = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

        #[cfg(feature = "parallel")]
        {
            h_eff
                .par_iter_mut()
                .enumerate()
                .for_each(|(flat_index, h)| {
                    let h_ex = self.cell_exchange_field(
                        flat_index,
                        magnetization,
                        px,
                        py,
                        pz,
                        dx2,
                        dy2,
                        dz2,
                    );
                    h[0] += h_ex[0];
                    h[1] += h_ex[1];
                    h[2] += h_ex[2];
                });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for flat_index in 0..grid.cell_count() {
                let h_ex =
                    self.cell_exchange_field(flat_index, magnetization, px, py, pz, dx2, dy2, dz2);
                let h = &mut h_eff[flat_index];
                h[0] += h_ex[0];
                h[1] += h_ex[1];
                h[2] += h_ex[2];
            }
        }
    }

    pub(crate) fn demag_field_add_into(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
    ) {
        let px = ws.px;
        let py = ws.py;
        let pz = ws.pz;
        let padded_len = px * py * pz;

        ws.clear_m_bufs();

        for z in 0..self.grid.nz {
            for y in 0..self.grid.ny {
                for x in 0..self.grid.nx {
                    let src_index = self.grid.index(x, y, z);
                    let dst_index = padded_index(px, py, x, y, z);
                    let moment = if self.is_active(src_index) {
                        scale(magnetization[src_index], self.ms_at(src_index))
                    } else {
                        [0.0, 0.0, 0.0]
                    };
                    ws.buf_mx[dst_index] = Complex::new(moment[0], 0.0);
                    ws.buf_my[dst_index] = Complex::new(moment[1], 0.0);
                    ws.buf_mz[dst_index] = Complex::new(moment[2], 0.0);
                }
            }
        }

        ws.fft3_m_forward();

        #[cfg(feature = "parallel")]
        {
            let (mx_sl, my_sl, mz_sl) = (&ws.buf_mx[..], &ws.buf_my[..], &ws.buf_mz[..]);
            let (kxx, kyy, kzz) = (&ws.kern_xx[..], &ws.kern_yy[..], &ws.kern_zz[..]);
            let (kxy, kxz, kyz) = (&ws.kern_xy[..], &ws.kern_xz[..], &ws.kern_yz[..]);
            let hx = &mut ws.buf_hx[..];
            let hy = &mut ws.buf_hy[..];
            let hz = &mut ws.buf_hz[..];
            hx.par_iter_mut().enumerate().for_each(|(i, h)| {
                *h = -(kxx[i] * mx_sl[i] + kxy[i] * my_sl[i] + kxz[i] * mz_sl[i]);
            });
            hy.par_iter_mut().enumerate().for_each(|(i, h)| {
                *h = -(kxy[i] * mx_sl[i] + kyy[i] * my_sl[i] + kyz[i] * mz_sl[i]);
            });
            hz.par_iter_mut().enumerate().for_each(|(i, h)| {
                *h = -(kxz[i] * mx_sl[i] + kyz[i] * my_sl[i] + kzz[i] * mz_sl[i]);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for i in 0..padded_len {
                let mx = ws.buf_mx[i];
                let my = ws.buf_my[i];
                let mz = ws.buf_mz[i];
                ws.buf_hx[i] = -(ws.kern_xx[i] * mx + ws.kern_xy[i] * my + ws.kern_xz[i] * mz);
                ws.buf_hy[i] = -(ws.kern_xy[i] * mx + ws.kern_yy[i] * my + ws.kern_yz[i] * mz);
                ws.buf_hz[i] = -(ws.kern_xz[i] * mx + ws.kern_yz[i] * my + ws.kern_zz[i] * mz);
            }
        }

        ws.fft3_h_inverse();

        let normalisation = 1.0 / padded_len as f64;
        for z in 0..self.grid.nz {
            for y in 0..self.grid.ny {
                for x in 0..self.grid.nx {
                    let src_index = padded_index(px, py, x, y, z);
                    let dst_index = self.grid.index(x, y, z);
                    if self.is_active(dst_index) {
                        h_eff[dst_index][0] += ws.buf_hx[src_index].re * normalisation;
                        h_eff[dst_index][1] += ws.buf_hy[src_index].re * normalisation;
                        h_eff[dst_index][2] += ws.buf_hz[src_index].re * normalisation;
                    }
                }
            }
        }
    }

    pub(crate) fn external_field_add_into(&self, h_eff: &mut [Vector3]) {
        let ext = self.terms.external_field.unwrap_or([0.0, 0.0, 0.0]);
        let per_node_field = self.terms.per_node_field.as_ref();
        if self.terms.external_field.is_some() || per_node_field.is_some() {
            #[cfg(feature = "parallel")]
            {
                h_eff.par_iter_mut().enumerate().for_each(|(i, h)| {
                    if self.is_active(i) {
                        h[0] += ext[0];
                        h[1] += ext[1];
                        h[2] += ext[2];
                        if let Some(value) = per_node_field.and_then(|field| field.get(i)) {
                            h[0] += value[0];
                            h[1] += value[1];
                            h[2] += value[2];
                        }
                    }
                });
            }
            #[cfg(not(feature = "parallel"))]
            {
                for i in 0..h_eff.len() {
                    if self.is_active(i) {
                        h_eff[i][0] += ext[0];
                        h_eff[i][1] += ext[1];
                        h_eff[i][2] += ext[2];
                        if let Some(value) = per_node_field.and_then(|field| field.get(i)) {
                            h_eff[i][0] += value[0];
                            h_eff[i][1] += value[1];
                            h_eff[i][2] += value[2];
                        }
                    }
                }
            }
        }
    }

    pub(crate) fn demag_field_add_into_soa_fft_backend(
        &self,
        magnetization: &VectorFieldSoA,
        fft_backend: &mut dyn FdmFftBackend,
        h_eff: &mut VectorFieldSoA,
    ) {
        fft_backend.convolve_demag(
            magnetization,
            self.material.saturation_magnetisation,
            self.active_mask.as_deref(),
            h_eff,
        );
    }

    /// Whether the problem can step through the persistent SoA CPU fast path.
    pub fn soa_fast_path_supported(&self) -> bool {
        true
    }

    pub(crate) fn exchange_field_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        h_eff: &mut VectorFieldSoA,
    ) {
        let prefactor =
            2.0 * self.material.exchange_stiffness / (MU0 * self.material.saturation_magnetisation);
        let dx2 = self.cell_size.dx * self.cell_size.dx;
        let dy2 = self.cell_size.dy * self.cell_size.dy;
        let dz2 = self.cell_size.dz * self.cell_size.dz;
        let grid = self.grid;
        let px = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let py = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let pz = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

        for flat_index in 0..grid.cell_count() {
            if !self.is_active(flat_index) {
                continue;
            }
            let x = flat_index % grid.nx;
            let y = (flat_index / grid.nx) % grid.ny;
            let z = flat_index / (grid.nx * grid.ny);
            let center_x = magnetization.x[flat_index];
            let center_y = magnetization.y[flat_index];
            let center_z = magnetization.z[flat_index];
            let sample = |nx: usize, ny: usize, nz: usize| -> Vector3 {
                let ni = grid.index(nx, ny, nz);
                if self.is_active(ni) {
                    [
                        magnetization.x[ni],
                        magnetization.y[ni],
                        magnetization.z[ni],
                    ]
                } else {
                    [center_x, center_y, center_z]
                }
            };

            let x_minus = sample(neighbor_index(x, grid.nx, -1, px), y, z);
            let x_plus = sample(neighbor_index(x, grid.nx, 1, px), y, z);
            let y_minus = sample(x, neighbor_index(y, grid.ny, -1, py), z);
            let y_plus = sample(x, neighbor_index(y, grid.ny, 1, py), z);
            let z_minus = sample(x, y, neighbor_index(z, grid.nz, -1, pz));
            let z_plus = sample(x, y, neighbor_index(z, grid.nz, 1, pz));

            h_eff.x[flat_index] += prefactor
                * ((x_plus[0] - 2.0 * center_x + x_minus[0]) / dx2
                    + (y_plus[0] - 2.0 * center_x + y_minus[0]) / dy2
                    + (z_plus[0] - 2.0 * center_x + z_minus[0]) / dz2);
            h_eff.y[flat_index] += prefactor
                * ((x_plus[1] - 2.0 * center_y + x_minus[1]) / dx2
                    + (y_plus[1] - 2.0 * center_y + y_minus[1]) / dy2
                    + (z_plus[1] - 2.0 * center_y + z_minus[1]) / dz2);
            h_eff.z[flat_index] += prefactor
                * ((x_plus[2] - 2.0 * center_z + x_minus[2]) / dx2
                    + (y_plus[2] - 2.0 * center_z + y_minus[2]) / dy2
                    + (z_plus[2] - 2.0 * center_z + z_minus[2]) / dz2);
        }
    }

    pub(crate) fn anisotropy_field_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        h_eff: &mut VectorFieldSoA,
    ) {
        let has_uni = self.terms.uniaxial_anisotropy.is_some();
        let has_cub = self.terms.cubic_anisotropy.is_some();
        if !has_uni && !has_cub {
            return;
        }
        let ms_safe = self.material.saturation_magnetisation.max(1e-30);

        let uni_data = self.terms.uniaxial_anisotropy.as_ref().map(|uni| {
            let n = norm(uni.axis).max(1e-30);
            let u = scale(uni.axis, 1.0 / n);
            (u, uni.ku1, uni.ku2)
        });
        let cub_data = self.terms.cubic_anisotropy.as_ref().map(|cub| {
            let n1 = norm(cub.axis1).max(1e-30);
            let n2 = norm(cub.axis2).max(1e-30);
            let c1 = scale(cub.axis1, 1.0 / n1);
            let c2 = scale(cub.axis2, 1.0 / n2);
            let c3 = cross(c1, c2);
            (c1, c2, c3, cub.kc1, cub.kc2, cub.kc3)
        });

        for i in 0..magnetization.len() {
            if !self.is_active(i) {
                continue;
            }
            let mx = magnetization.x[i];
            let my = magnetization.y[i];
            let mz = magnetization.z[i];

            if let Some((u, ku1, ku2)) = &uni_data {
                let m_dot_u = mx * u[0] + my * u[1] + mz * u[2];
                let coeff = 2.0 * ku1 / (MU0 * ms_safe) * m_dot_u
                    + 4.0 * ku2 / (MU0 * ms_safe) * m_dot_u * m_dot_u * m_dot_u;
                h_eff.x[i] += u[0] * coeff;
                h_eff.y[i] += u[1] * coeff;
                h_eff.z[i] += u[2] * coeff;
            }
            if let Some((c1, c2, c3, kc1, kc2, kc3)) = &cub_data {
                let m1 = mx * c1[0] + my * c1[1] + mz * c1[2];
                let m2 = mx * c2[0] + my * c2[1] + mz * c2[2];
                let m3 = mx * c3[0] + my * c3[1] + mz * c3[2];
                let sigma = m1 * m1 * m2 * m2 + m2 * m2 * m3 * m3 + m1 * m1 * m3 * m3;
                let pf = 2.0 / (MU0 * ms_safe);
                let g1 = -pf
                    * (kc1 * m1 * (m2 * m2 + m3 * m3)
                        + kc2 * m1 * m2 * m2 * m3 * m3
                        + 2.0 * kc3 * sigma * m1 * (m2 * m2 + m3 * m3));
                let g2 = -pf
                    * (kc1 * m2 * (m1 * m1 + m3 * m3)
                        + kc2 * m2 * m1 * m1 * m3 * m3
                        + 2.0 * kc3 * sigma * m2 * (m1 * m1 + m3 * m3));
                let g3 = -pf
                    * (kc1 * m3 * (m1 * m1 + m2 * m2)
                        + kc2 * m3 * m1 * m1 * m2 * m2
                        + 2.0 * kc3 * sigma * m3 * (m1 * m1 + m2 * m2));
                h_eff.x[i] += c1[0] * g1 + c2[0] * g2 + c3[0] * g3;
                h_eff.y[i] += c1[1] * g1 + c2[1] * g2 + c3[1] * g3;
                h_eff.z[i] += c1[2] * g1 + c2[2] * g2 + c3[2] * g3;
            }
        }
    }

    pub(crate) fn interfacial_dmi_field_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        h_eff: &mut VectorFieldSoA,
    ) {
        let d = match self.terms.interfacial_dmi {
            Some(d) if d.abs() > 0.0 => d,
            _ => return,
        };
        let ms = self.material.saturation_magnetisation.max(1e-30);
        let pf = 2.0 * d / (MU0 * ms);
        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let grid = self.grid;
        let bpx = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let bpy = matches!(self.boundary_policy.y, AxisBoundary::Periodic);

        for flat in 0..grid.cell_count() {
            if !self.is_active(flat) {
                continue;
            }
            let x = flat % nx;
            let y = (flat / nx) % ny;
            let z = flat / (nx * ny);
            let sample = |neighbor: usize| {
                if self.is_active(neighbor) {
                    neighbor
                } else {
                    flat
                }
            };

            let xp = sample(grid.index(neighbor_index(x, nx, 1, bpx), y, z));
            let xm = sample(grid.index(neighbor_index(x, nx, -1, bpx), y, z));
            let yp = sample(grid.index(x, neighbor_index(y, ny, 1, bpy), z));
            let ym = sample(grid.index(x, neighbor_index(y, ny, -1, bpy), z));

            let dx_mz = (magnetization.z[xp] - magnetization.z[xm]) / (2.0 * dx);
            let dy_mz = (magnetization.z[yp] - magnetization.z[ym]) / (2.0 * dy);
            let dx_mx = (magnetization.x[xp] - magnetization.x[xm]) / (2.0 * dx);
            let dy_my = (magnetization.y[yp] - magnetization.y[ym]) / (2.0 * dy);

            h_eff.x[flat] += pf * dx_mz;
            h_eff.y[flat] += pf * dy_mz;
            h_eff.z[flat] += -pf * (dx_mx + dy_my);
        }
    }

    pub(crate) fn bulk_dmi_field_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        h_eff: &mut VectorFieldSoA,
    ) {
        let d = match self.terms.bulk_dmi {
            Some(d) if d.abs() > 0.0 => d,
            _ => return,
        };
        let ms = self.material.saturation_magnetisation.max(1e-30);
        let pf = -2.0 * d / (MU0 * ms);
        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let nz = self.grid.nz;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let dz = self.cell_size.dz;
        let grid = self.grid;
        let bpx = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let bpy = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let bpz = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

        for flat in 0..grid.cell_count() {
            if !self.is_active(flat) {
                continue;
            }
            let x = flat % nx;
            let y = (flat / nx) % ny;
            let z = flat / (nx * ny);
            let sample = |neighbor: usize| {
                if self.is_active(neighbor) {
                    neighbor
                } else {
                    flat
                }
            };

            let xp = sample(grid.index(neighbor_index(x, nx, 1, bpx), y, z));
            let xm = sample(grid.index(neighbor_index(x, nx, -1, bpx), y, z));
            let yp = sample(grid.index(x, neighbor_index(y, ny, 1, bpy), z));
            let ym = sample(grid.index(x, neighbor_index(y, ny, -1, bpy), z));
            let zp = sample(grid.index(x, y, neighbor_index(z, nz, 1, bpz)));
            let zm = sample(grid.index(x, y, neighbor_index(z, nz, -1, bpz)));

            let curl_x = (magnetization.z[yp] - magnetization.z[ym]) / (2.0 * dy)
                - (magnetization.y[zp] - magnetization.y[zm]) / (2.0 * dz);
            let curl_y = (magnetization.x[zp] - magnetization.x[zm]) / (2.0 * dz)
                - (magnetization.z[xp] - magnetization.z[xm]) / (2.0 * dx);
            let curl_z = (magnetization.y[xp] - magnetization.y[xm]) / (2.0 * dx)
                - (magnetization.x[yp] - magnetization.x[ym]) / (2.0 * dy);

            h_eff.x[flat] += pf * curl_x;
            h_eff.y[flat] += pf * curl_y;
            h_eff.z[flat] += pf * curl_z;
        }
    }

    pub(crate) fn thermal_field_add_into_soa(&self, h_eff: &mut VectorFieldSoA) {
        if self.temperature <= 0.0
            || self.material.saturation_magnetisation <= 0.0
            || self.thermal_dt <= 0.0
        {
            return;
        }

        let alpha = self.material.damping;
        let ms = self.material.saturation_magnetisation;
        let gamma0 = self.dynamics.gyromagnetic_ratio;
        let v_cell = self.cell_size.dx * self.cell_size.dy * self.cell_size.dz;
        const KB: f64 = 1.380649e-23;
        const MU0_LOCAL: f64 = 1.2566370614359173e-6;

        let sigma = (2.0 * alpha * KB * self.temperature
            / (gamma0 * MU0_LOCAL * ms * v_cell * self.thermal_dt))
            .sqrt();
        let global_seed = self.thermal_seed;
        let step = self.thermal_step();

        #[inline]
        fn splitmix64(mut z: u64) -> u64 {
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
            z ^ (z >> 31)
        }

        #[inline]
        fn counter_uniform(seed: u64, step: u64, cell: u64, stream: u64) -> f64 {
            let key = seed
                .wrapping_add(step.wrapping_mul(0x9E3779B97F4A7C15))
                .wrapping_add(cell.wrapping_mul(0x517CC1B727220A95))
                .wrapping_add(stream.wrapping_mul(0x6C62272E07BB0142));
            let bits = splitmix64(key);
            ((bits >> 11) as f64 + 1.0) / ((1u64 << 53) as f64 + 1.0)
        }

        for i in 0..self.grid.cell_count() {
            if !self.is_active(i) {
                continue;
            }
            let ci = i as u64;
            let u1 = counter_uniform(global_seed, step, ci, 0).max(1e-300);
            let u2 = counter_uniform(global_seed, step, ci, 1);
            let u3 = counter_uniform(global_seed, step, ci, 2).max(1e-300);
            let u4 = counter_uniform(global_seed, step, ci, 3);
            let r1 = (-2.0 * u1.ln()).sqrt();
            let r2 = (-2.0 * u3.ln()).sqrt();
            let theta1 = 2.0 * std::f64::consts::PI * u2;
            let theta2 = 2.0 * std::f64::consts::PI * u4;
            h_eff.x[i] += sigma * r1 * theta1.cos();
            h_eff.y[i] += sigma * r1 * theta1.sin();
            h_eff.z[i] += sigma * r2 * theta2.cos();
        }
    }

    pub(crate) fn magnetoelastic_field_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        h_eff: &mut VectorFieldSoA,
    ) {
        let config = match &self.terms.magnetoelastic {
            Some(config) => config,
            None => return,
        };
        let n = magnetization.len();

        let add_cell =
            |i: usize, strain: &magnetoelastic::StrainVoigt, h_eff: &mut VectorFieldSoA| {
                if !self.is_active(i) {
                    return;
                }
                let h = magnetoelastic::h_mel_single(
                    [magnetization.x[i], magnetization.y[i], magnetization.z[i]],
                    strain,
                    &config.params,
                );
                h_eff.x[i] += h[0];
                h_eff.y[i] += h[1];
                h_eff.z[i] += h[2];
            };

        match &config.strain {
            magnetoelastic::PrescribedStrainField::Uniform(strain) => {
                for i in 0..n {
                    add_cell(i, strain, h_eff);
                }
            }
            magnetoelastic::PrescribedStrainField::PerCell(strain) => {
                assert_eq!(
                    strain.len(),
                    n,
                    "strain field length must match magnetization"
                );
                for (i, cell_strain) in strain.iter().enumerate() {
                    add_cell(i, cell_strain, h_eff);
                }
            }
        }
    }

    #[allow(dead_code)]
    pub(crate) fn oersted_field_add_into_soa(&self, h_eff: &mut VectorFieldSoA) {
        self.oersted_field_add_into_soa_at_time(h_eff, 0.0);
    }

    pub(crate) fn oersted_field_add_into_soa_at_time(
        &self,
        h_eff: &mut VectorFieldSoA,
        time_seconds: f64,
    ) {
        let oe = match self.terms.oersted_cylinder {
            Some(ref cfg) => cfg,
            None => return,
        };

        let envelope = oersted_envelope_at_time(oe, time_seconds);

        let current = oe.current * envelope;
        if current == 0.0 {
            return;
        }

        let r_cyl = oe.radius;
        let cx = oe.center[0];
        let cy = oe.center[1];
        let cz = oe.center[2];

        let ax_len = (oe.axis[0] * oe.axis[0] + oe.axis[1] * oe.axis[1] + oe.axis[2] * oe.axis[2])
            .sqrt()
            .max(1e-30);
        let ax = [
            oe.axis[0] / ax_len,
            oe.axis[1] / ax_len,
            oe.axis[2] / ax_len,
        ];

        let two_pi = 2.0 * std::f64::consts::PI;
        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let nz = self.grid.nz;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let dz = self.cell_size.dz;

        for iz in 0..nz {
            for iy in 0..ny {
                for ix in 0..nx {
                    let idx = ix + nx * (iy + ny * iz);
                    if !self.is_active(idx) {
                        continue;
                    }

                    let px = ix as f64 * dx + 0.5 * dx;
                    let py = iy as f64 * dy + 0.5 * dy;
                    let pz = iz as f64 * dz + 0.5 * dz;

                    let dx_c = px - cx;
                    let dy_c = py - cy;
                    let dz_c = pz - cz;

                    let proj = dx_c * ax[0] + dy_c * ax[1] + dz_c * ax[2];
                    let rx = dx_c - proj * ax[0];
                    let ry = dy_c - proj * ax[1];
                    let rz = dz_c - proj * ax[2];
                    let r_perp = (rx * rx + ry * ry + rz * rz).sqrt();

                    if r_perp < 1e-30 {
                        continue;
                    }

                    let rhat = [rx / r_perp, ry / r_perp, rz / r_perp];
                    let phi = [
                        ax[1] * rhat[2] - ax[2] * rhat[1],
                        ax[2] * rhat[0] - ax[0] * rhat[2],
                        ax[0] * rhat[1] - ax[1] * rhat[0],
                    ];
                    let h_mag = if r_perp <= r_cyl {
                        current * r_perp / (two_pi * r_cyl * r_cyl)
                    } else {
                        current / (two_pi * r_perp)
                    };

                    h_eff.x[idx] += phi[0] * h_mag;
                    h_eff.y[idx] += phi[1] * h_mag;
                    h_eff.z[idx] += phi[2] * h_mag;
                }
            }
        }
    }

    pub(crate) fn external_field_add_into_soa(&self, h_eff: &mut VectorFieldSoA) {
        let ext = self.terms.external_field.unwrap_or([0.0, 0.0, 0.0]);
        let per_node_field = self.terms.per_node_field.as_ref();
        if self.terms.external_field.is_none() && per_node_field.is_none() {
            return;
        }

        for i in 0..self.grid.cell_count() {
            if self.is_active(i) {
                h_eff.x[i] += ext[0];
                h_eff.y[i] += ext[1];
                h_eff.z[i] += ext[2];
                if let Some(value) = per_node_field.and_then(|field| field.get(i)) {
                    h_eff.x[i] += value[0];
                    h_eff.y[i] += value[1];
                    h_eff.z[i] += value[2];
                }
            }
        }
    }

    pub fn effective_field_into_soa_ws(
        &self,
        magnetization: &VectorFieldSoA,
        ws: &mut FftWorkspace,
        h_eff: &mut VectorFieldSoA,
    ) {
        self.effective_field_into_soa_ws_at(magnetization, 0.0, ws, h_eff);
    }

    pub fn effective_field_into_soa_ws_at(
        &self,
        magnetization: &VectorFieldSoA,
        evaluation_time_s: f64,
        ws: &mut FftWorkspace,
        h_eff: &mut VectorFieldSoA,
    ) {
        self.effective_field_into_soa_fft_backend_at_time(
            magnetization,
            ws,
            h_eff,
            evaluation_time_s,
        );
    }

    pub(crate) fn effective_field_into_soa_ws_at_time(
        &self,
        magnetization: &VectorFieldSoA,
        ws: &mut FftWorkspace,
        h_eff: &mut VectorFieldSoA,
        time_seconds: f64,
    ) {
        self.effective_field_into_soa_fft_backend_at_time(magnetization, ws, h_eff, time_seconds);
    }

    pub(crate) fn effective_field_into_soa_fft_backend(
        &self,
        magnetization: &VectorFieldSoA,
        fft_backend: &mut dyn FdmFftBackend,
        h_eff: &mut VectorFieldSoA,
    ) {
        self.effective_field_into_soa_fft_backend_at_time(magnetization, fft_backend, h_eff, 0.0);
    }

    pub(crate) fn effective_field_into_soa_fft_backend_at_time(
        &self,
        magnetization: &VectorFieldSoA,
        fft_backend: &mut dyn FdmFftBackend,
        h_eff: &mut VectorFieldSoA,
        time_seconds: f64,
    ) {
        h_eff.fill_zero();

        if self.terms.exchange {
            self.exchange_field_add_into_soa(magnetization, h_eff);
        }
        if self.terms.demag {
            self.demag_field_add_into_soa_fft_backend(magnetization, fft_backend, h_eff);
        }
        self.magnetoelastic_field_add_into_soa(magnetization, h_eff);
        self.external_field_add_into_soa(h_eff);
        self.anisotropy_field_add_into_soa(magnetization, h_eff);
        self.thermal_field_add_into_soa(h_eff);
        self.interfacial_dmi_field_add_into_soa(magnetization, h_eff);
        self.bulk_dmi_field_add_into_soa(magnetization, h_eff);
        self.oersted_field_add_into_soa_at_time(h_eff, time_seconds);
        for drive in self
            .regional_field_drives
            .iter()
            .filter(|drive| drive.enabled)
        {
            let multiplier = drive.multiplier_at(time_seconds);
            for (index, basis) in drive.basis_field.iter().enumerate().take(h_eff.len()) {
                if self.is_active(index) {
                    h_eff.x[index] += multiplier * basis[0];
                    h_eff.y[index] += multiplier * basis[1];
                    h_eff.z[index] += multiplier * basis[2];
                }
            }
        }
    }

    pub(crate) fn llg_rhs_soa_into(
        &self,
        magnetization: &VectorFieldSoA,
        h_eff: &VectorFieldSoA,
        out: &mut VectorFieldSoA,
    ) {
        let n = magnetization.len();
        debug_assert!(h_eff.len() >= n);
        debug_assert!(out.len() >= n);
        for i in 0..n {
            let rhs = self.llg_rhs_from_field_at(
                i,
                [magnetization.x[i], magnetization.y[i], magnetization.z[i]],
                [h_eff.x[i], h_eff.y[i], h_eff.z[i]],
            );
            out.x[i] = rhs[0];
            out.y[i] = rhs[1];
            out.z[i] = rhs[2];
        }
        self.direct_torques_add_into_soa(magnetization, out);
    }

    pub(crate) fn llg_rhs_from_fields_with_direct_torques_into(
        &self,
        magnetization: &[Vector3],
        h_eff: &[Vector3],
        out: &mut [Vector3],
    ) {
        let n = magnetization.len();
        debug_assert!(h_eff.len() >= n);
        debug_assert!(out.len() >= n);
        for i in 0..n {
            out[i] = self.llg_rhs_from_field_at(i, magnetization[i], h_eff[i]);
        }
        self.direct_torques_add_into(magnetization, out);
    }

    pub(crate) fn direct_torques_add_into(&self, magnetization: &[Vector3], out: &mut [Vector3]) {
        let n = magnetization.len();
        if let Some(ref zl) = self.terms.zhang_li_stt {
            self.zhang_li_stt_torque_add_into(magnetization, zl, &mut out[..n]);
        }
        if let Some(ref slon) = self.terms.slonczewski_stt {
            self.slonczewski_stt_torque_add_into(magnetization, slon, &mut out[..n]);
        }
        if let Some(ref sot) = self.terms.sot {
            self.sot_torque_add_into(magnetization, sot, &mut out[..n]);
        }
    }

    pub(crate) fn direct_torques_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        out: &mut VectorFieldSoA,
    ) {
        if let Some(ref zl) = self.terms.zhang_li_stt {
            self.zhang_li_stt_torque_add_into_soa(magnetization, zl, out);
        }
        if let Some(ref slon) = self.terms.slonczewski_stt {
            self.slonczewski_stt_torque_add_into_soa(magnetization, slon, out);
        }
        if let Some(ref sot) = self.terms.sot {
            self.sot_torque_add_into_soa(magnetization, sot, out);
        }
    }

    pub(crate) fn magnetoelastic_field_add_into(
        &self,
        magnetization: &[Vector3],
        h_eff: &mut [Vector3],
    ) {
        if let Some(ref config) = self.terms.magnetoelastic {
            magnetoelastic::h_mel_field_add_into(
                magnetization,
                &config.strain,
                &config.params,
                self.active_mask.as_deref(),
                h_eff,
            );
        }
    }

    pub(crate) fn anisotropy_field_add_into(
        &self,
        magnetization: &[Vector3],
        h_eff: &mut [Vector3],
    ) {
        let has_uni = self.terms.uniaxial_anisotropy.is_some();
        let has_cub = self.terms.cubic_anisotropy.is_some();
        if !has_uni && !has_cub {
            return;
        }

        let uni_data = self.terms.uniaxial_anisotropy.as_ref().map(|uni| {
            let n = norm(uni.axis).max(1e-30);
            let u = scale(uni.axis, 1.0 / n);
            (u, uni.ku1, uni.ku2)
        });
        let cub_data = self.terms.cubic_anisotropy.as_ref().map(|cub| {
            let n1 = norm(cub.axis1).max(1e-30);
            let n2 = norm(cub.axis2).max(1e-30);
            let c1 = scale(cub.axis1, 1.0 / n1);
            let c2 = scale(cub.axis2, 1.0 / n2);
            let c3 = cross(c1, c2);
            (c1, c2, c3, cub.kc1, cub.kc2, cub.kc3)
        });

        let compute_aniso = |i: usize, m: &Vector3, h: &mut Vector3| {
            if !self.is_active(i) {
                return;
            }
            let ms_safe = self.ms_at(i).max(1e-30);
            if let Some((u, ku1, ku2)) = &uni_data {
                let m_dot_u = dot(*m, *u);
                let coeff = 2.0 * ku1 / (MU0 * ms_safe) * m_dot_u
                    + 4.0 * ku2 / (MU0 * ms_safe) * m_dot_u * m_dot_u * m_dot_u;
                *h = add(*h, scale(*u, coeff));
            }
            if let Some((c1, c2, c3, kc1, kc2, kc3)) = &cub_data {
                let m1 = dot(*m, *c1);
                let m2 = dot(*m, *c2);
                let m3 = dot(*m, *c3);
                let sigma = m1 * m1 * m2 * m2 + m2 * m2 * m3 * m3 + m1 * m1 * m3 * m3;
                let pf = 2.0 / (MU0 * ms_safe);
                let g1 = -pf
                    * (kc1 * m1 * (m2 * m2 + m3 * m3)
                        + kc2 * m1 * m2 * m2 * m3 * m3
                        + 2.0 * kc3 * sigma * m1 * (m2 * m2 + m3 * m3));
                let g2 = -pf
                    * (kc1 * m2 * (m1 * m1 + m3 * m3)
                        + kc2 * m2 * m1 * m1 * m3 * m3
                        + 2.0 * kc3 * sigma * m2 * (m1 * m1 + m3 * m3));
                let g3 = -pf
                    * (kc1 * m3 * (m1 * m1 + m2 * m2)
                        + kc2 * m3 * m1 * m1 * m2 * m2
                        + 2.0 * kc3 * sigma * m3 * (m1 * m1 + m2 * m2));
                *h = add(*h, add(add(scale(*c1, g1), scale(*c2, g2)), scale(*c3, g3)));
            }
        };

        #[cfg(feature = "parallel")]
        {
            h_eff.par_iter_mut().enumerate().for_each(|(i, h)| {
                compute_aniso(i, &magnetization[i], h);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for (i, m) in magnetization.iter().enumerate() {
                compute_aniso(i, m, &mut h_eff[i]);
            }
        }
    }

    pub(crate) fn interfacial_dmi_field_add_into(
        &self,
        magnetization: &[Vector3],
        h_eff: &mut [Vector3],
    ) {
        let d = match self.terms.interfacial_dmi {
            Some(d) if d.abs() > 0.0 => d,
            _ => return,
        };
        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let grid = self.grid;
        let bpx = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let bpy = matches!(self.boundary_policy.y, AxisBoundary::Periodic);

        let compute = |flat: usize, h: &mut Vector3| {
            if !self.is_active(flat) {
                return;
            }
            let ms = self.ms_at(flat).max(1e-30);
            let pf = 2.0 * d / (MU0 * ms);
            let x = flat % nx;
            let y = (flat / nx) % ny;
            let z = flat / (nx * ny);
            let center = magnetization[flat];
            let sample = |neighbor: usize| {
                if self.is_active(neighbor) {
                    magnetization[neighbor]
                } else {
                    center
                }
            };

            let xp = sample(grid.index(neighbor_index(x, nx, 1, bpx), y, z));
            let xm = sample(grid.index(neighbor_index(x, nx, -1, bpx), y, z));
            let yp = sample(grid.index(x, neighbor_index(y, ny, 1, bpy), z));
            let ym = sample(grid.index(x, neighbor_index(y, ny, -1, bpy), z));

            let dx_mz = (xp[2] - xm[2]) / (2.0 * dx);
            let dy_mz = (yp[2] - ym[2]) / (2.0 * dy);
            let dx_mx = (xp[0] - xm[0]) / (2.0 * dx);
            let dy_my = (yp[1] - ym[1]) / (2.0 * dy);

            h[0] += pf * dx_mz;
            h[1] += pf * dy_mz;
            h[2] += -pf * (dx_mx + dy_my);
        };

        #[cfg(feature = "parallel")]
        {
            h_eff.par_iter_mut().enumerate().for_each(|(flat, h)| {
                compute(flat, h);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for flat in 0..grid.cell_count() {
                compute(flat, &mut h_eff[flat]);
            }
        }
    }

    pub(crate) fn bulk_dmi_field_add_into(&self, magnetization: &[Vector3], h_eff: &mut [Vector3]) {
        let d = match self.terms.bulk_dmi {
            Some(d) if d.abs() > 0.0 => d,
            _ => return,
        };
        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let nz = self.grid.nz;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let dz = self.cell_size.dz;
        let grid = self.grid;
        let bpx = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let bpy = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let bpz = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

        let compute = |flat: usize, h: &mut Vector3| {
            if !self.is_active(flat) {
                return;
            }
            let ms = self.ms_at(flat).max(1e-30);
            let pf = -2.0 * d / (MU0 * ms);
            let x = flat % nx;
            let y = (flat / nx) % ny;
            let z = flat / (nx * ny);
            let center = magnetization[flat];
            let sample = |neighbor: usize| {
                if self.is_active(neighbor) {
                    magnetization[neighbor]
                } else {
                    center
                }
            };

            let xp = sample(grid.index(neighbor_index(x, nx, 1, bpx), y, z));
            let xm = sample(grid.index(neighbor_index(x, nx, -1, bpx), y, z));
            let yp = sample(grid.index(x, neighbor_index(y, ny, 1, bpy), z));
            let ym = sample(grid.index(x, neighbor_index(y, ny, -1, bpy), z));
            let zp = sample(grid.index(x, y, neighbor_index(z, nz, 1, bpz)));
            let zm = sample(grid.index(x, y, neighbor_index(z, nz, -1, bpz)));

            let curl_x = (yp[2] - ym[2]) / (2.0 * dy) - (zp[1] - zm[1]) / (2.0 * dz);
            let curl_y = (zp[0] - zm[0]) / (2.0 * dz) - (xp[2] - xm[2]) / (2.0 * dx);
            let curl_z = (xp[1] - xm[1]) / (2.0 * dx) - (yp[0] - ym[0]) / (2.0 * dy);

            h[0] += pf * curl_x;
            h[1] += pf * curl_y;
            h[2] += pf * curl_z;
        };

        #[cfg(feature = "parallel")]
        {
            h_eff.par_iter_mut().enumerate().for_each(|(flat, h)| {
                compute(flat, h);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for flat in 0..grid.cell_count() {
                compute(flat, &mut h_eff[flat]);
            }
        }
    }

    pub(crate) fn thermal_field_add_into(&self, h_eff: &mut [Vector3]) {
        self.thermal_field_add_into_step(h_eff, self.thermal_step());
    }

    /// Counter-based thermal field with an explicit step index for reproducibility.
    pub(crate) fn thermal_field_add_into_step(&self, h_eff: &mut [Vector3], step: u64) {
        if self.temperature <= 0.0
            || self.material.saturation_magnetisation <= 0.0
            || self.thermal_dt <= 0.0
        {
            return;
        }

        let alpha = self.material.damping;
        let ms = self.material.saturation_magnetisation;
        let gamma0 = self.dynamics.gyromagnetic_ratio;
        let v_cell = self.cell_size.dx * self.cell_size.dy * self.cell_size.dz;
        const KB: f64 = 1.380649e-23;
        #[allow(unused)]
        const MU0_LOCAL: f64 = 1.2566370614359173e-6;

        let sigma = (2.0 * alpha * KB * self.temperature
            / (gamma0 * MU0_LOCAL * ms * v_cell * self.thermal_dt))
            .sqrt();

        // ── Counter-based RNG (B7 reproducibility) ─────────────────────
        // Deterministic seed per cell: hash(global_seed, step_counter, cell_index).
        // Result is identical regardless of thread count or decomposition.
        let global_seed = self.thermal_seed;
        // `step` is passed as a parameter for reproducibility

        /// SplitMix64 finaliser — bijective u64→u64, good avalanche.
        #[inline]
        fn splitmix64(mut z: u64) -> u64 {
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
            z ^ (z >> 31)
        }

        /// Generate a uniform f64 in (0,1] from a counter key.
        #[inline]
        fn counter_uniform(seed: u64, step: u64, cell: u64, stream: u64) -> f64 {
            let key = seed
                .wrapping_add(step.wrapping_mul(0x9E3779B97F4A7C15))
                .wrapping_add(cell.wrapping_mul(0x517CC1B727220A95))
                .wrapping_add(stream.wrapping_mul(0x6C62272E07BB0142));
            let bits = splitmix64(key);
            // Convert top 53 bits to f64 in (0, 1]
            ((bits >> 11) as f64 + 1.0) / ((1u64 << 53) as f64 + 1.0)
        }

        let compute_noise = |i: usize, h: &mut Vector3| {
            let ci = i as u64;
            let u1 = counter_uniform(global_seed, step, ci, 0).max(1e-300);
            let u2 = counter_uniform(global_seed, step, ci, 1);
            let u3 = counter_uniform(global_seed, step, ci, 2).max(1e-300);
            let u4 = counter_uniform(global_seed, step, ci, 3);
            let r1 = (-2.0 * u1.ln()).sqrt();
            let r2 = (-2.0 * u3.ln()).sqrt();
            let theta1 = 2.0 * std::f64::consts::PI * u2;
            let theta2 = 2.0 * std::f64::consts::PI * u4;
            h[0] += sigma * r1 * theta1.cos();
            h[1] += sigma * r1 * theta1.sin();
            h[2] += sigma * r2 * theta2.cos();
        };

        #[cfg(feature = "parallel")]
        {
            h_eff.par_iter_mut().enumerate().for_each(|(i, h)| {
                compute_noise(i, h);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for (i, h) in h_eff.iter_mut().enumerate() {
                compute_noise(i, h);
            }
        }
    }

    // ===================================================================
    // B6: Fused local terms (external + anisotropy + thermal)
    // ===================================================================

    /// Fused accumulation of all per-cell local terms into h_eff in a
    /// single parallel pass.  This reduces memory traffic compared to
    /// calling `external_field_add_into`, `anisotropy_field_add_into`,
    /// and `thermal_field_add_into` separately.
    ///
    /// DMI terms are NOT included here because they require neighbor stencils.
    /// Magnetoelastic is NOT included because it has its own complex per-cell / per-strain logic.
    pub(crate) fn fused_local_terms_add_into(
        &self,
        magnetization: &[Vector3],
        h_eff: &mut [Vector3],
    ) {
        let n = magnetization.len();
        let ext = self.terms.external_field;
        let per_node_field = self.terms.per_node_field.as_ref();
        let ms_safe = self.material.saturation_magnetisation.max(1e-30);

        let uni_data = self.terms.uniaxial_anisotropy.as_ref().map(|uni| {
            let n = norm(uni.axis).max(1e-30);
            let u = scale(uni.axis, 1.0 / n);
            (u, uni.ku1, uni.ku2)
        });
        let cub_data = self.terms.cubic_anisotropy.as_ref().map(|cub| {
            let n1 = norm(cub.axis1).max(1e-30);
            let n2 = norm(cub.axis2).max(1e-30);
            let c1 = scale(cub.axis1, 1.0 / n1);
            let c2 = scale(cub.axis2, 1.0 / n2);
            let c3 = cross(c1, c2);
            (c1, c2, c3, cub.kc1, cub.kc2, cub.kc3)
        });

        // Thermal noise setup
        let has_thermal = self.temperature > 0.0
            && self.material.saturation_magnetisation > 0.0
            && self.thermal_dt > 0.0;
        let thermal_sigma = if has_thermal {
            let alpha = self.material.damping;
            let gamma0 = self.dynamics.gyromagnetic_ratio;
            let v_cell = self.cell_size.dx * self.cell_size.dy * self.cell_size.dz;
            const KB: f64 = 1.380649e-23;
            const MU0_LOCAL: f64 = 1.2566370614359173e-6;
            (2.0 * alpha * KB * self.temperature
                / (gamma0
                    * MU0_LOCAL
                    * self.material.saturation_magnetisation
                    * v_cell
                    * self.thermal_dt))
                .sqrt()
        } else {
            0.0
        };
        let thermal_seed = self.thermal_seed;
        let thermal_step = self.thermal_step();

        #[inline]
        fn splitmix64(mut z: u64) -> u64 {
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
            z ^ (z >> 31)
        }

        let fused_cell = |i: usize, h: &mut Vector3| {
            if !self.is_active(i) {
                return;
            }
            let m = &magnetization[i];

            // External field
            if let Some(ext) = ext {
                h[0] += ext[0];
                h[1] += ext[1];
                h[2] += ext[2];
            }
            if let Some(value) = per_node_field.and_then(|field| field.get(i)) {
                h[0] += value[0];
                h[1] += value[1];
                h[2] += value[2];
            }

            // Uniaxial anisotropy
            if let Some((u, ku1, ku2)) = &uni_data {
                let m_dot_u = dot(*m, *u);
                let coeff = 2.0 * ku1 / (MU0 * ms_safe) * m_dot_u
                    + 4.0 * ku2 / (MU0 * ms_safe) * m_dot_u * m_dot_u * m_dot_u;
                h[0] += u[0] * coeff;
                h[1] += u[1] * coeff;
                h[2] += u[2] * coeff;
            }

            // Cubic anisotropy
            if let Some((c1, c2, c3, kc1, kc2, kc3)) = &cub_data {
                let m1 = dot(*m, *c1);
                let m2 = dot(*m, *c2);
                let m3 = dot(*m, *c3);
                let sigma = m1 * m1 * m2 * m2 + m2 * m2 * m3 * m3 + m1 * m1 * m3 * m3;
                let pf = 2.0 / (MU0 * ms_safe);
                let g1 = -pf
                    * (kc1 * m1 * (m2 * m2 + m3 * m3)
                        + kc2 * m1 * m2 * m2 * m3 * m3
                        + 2.0 * kc3 * sigma * m1 * (m2 * m2 + m3 * m3));
                let g2 = -pf
                    * (kc1 * m2 * (m1 * m1 + m3 * m3)
                        + kc2 * m2 * m1 * m1 * m3 * m3
                        + 2.0 * kc3 * sigma * m2 * (m1 * m1 + m3 * m3));
                let g3 = -pf
                    * (kc1 * m3 * (m1 * m1 + m2 * m2)
                        + kc2 * m3 * m1 * m1 * m2 * m2
                        + 2.0 * kc3 * sigma * m3 * (m1 * m1 + m2 * m2));
                h[0] += c1[0] * g1 + c2[0] * g2 + c3[0] * g3;
                h[1] += c1[1] * g1 + c2[1] * g2 + c3[1] * g3;
                h[2] += c1[2] * g1 + c2[2] * g2 + c3[2] * g3;
            }

            // Thermal noise
            if has_thermal {
                let ci = i as u64;
                let counter_uniform = |stream: u64| -> f64 {
                    let key = thermal_seed
                        .wrapping_add(thermal_step.wrapping_mul(0x9E3779B97F4A7C15))
                        .wrapping_add(ci.wrapping_mul(0x517CC1B727220A95))
                        .wrapping_add(stream.wrapping_mul(0x6C62272E07BB0142));
                    let bits = splitmix64(key);
                    ((bits >> 11) as f64 + 1.0) / ((1u64 << 53) as f64 + 1.0)
                };
                let u1 = counter_uniform(0).max(1e-300);
                let u2 = counter_uniform(1);
                let u3 = counter_uniform(2).max(1e-300);
                let u4 = counter_uniform(3);
                let r1 = (-2.0 * u1.ln()).sqrt();
                let r2 = (-2.0 * u3.ln()).sqrt();
                let theta1 = 2.0 * std::f64::consts::PI * u2;
                let theta2 = 2.0 * std::f64::consts::PI * u4;
                h[0] += thermal_sigma * r1 * theta1.cos();
                h[1] += thermal_sigma * r1 * theta1.sin();
                h[2] += thermal_sigma * r2 * theta2.cos();
            }
        };

        #[cfg(feature = "parallel")]
        {
            h_eff[..n].par_iter_mut().enumerate().for_each(|(i, h)| {
                fused_cell(i, h);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for i in 0..n {
                fused_cell(i, &mut h_eff[i]);
            }
        }
    }

    // ===================================================================
    // Oersted field (cylindrical conductor)
    // ===================================================================

    /// Add the Oersted field from an infinite cylindrical conductor to `h_eff`.
    ///
    /// H_φ(r) = I·r / (2π·R²)  for r ≤ R
    /// H_φ(r) = I / (2π·r)      for r > R
    ///
    /// The field is purely azimuthal around the conductor axis.
    /// Sinusoidal and pulse envelopes are evaluated at the explicit RK stage
    /// time supplied by the integrator.
    pub(crate) fn oersted_field_add_into(&self, h_eff: &mut [Vector3]) {
        self.oersted_field_add_into_at_time(h_eff, 0.0);
    }

    pub fn oersted_field_at_time(&self, time_seconds: f64) -> Vec<Vector3> {
        let mut field = self
            .terms
            .per_node_field
            .clone()
            .unwrap_or_else(|| zero_vectors(self.grid.cell_count()));
        for (index, value) in field.iter_mut().enumerate() {
            if !self.is_active(index) {
                *value = [0.0, 0.0, 0.0];
            }
        }
        self.oersted_field_add_into_at_time(&mut field, time_seconds);
        field
    }

    pub(crate) fn oersted_field_add_into_at_time(&self, h_eff: &mut [Vector3], time_seconds: f64) {
        let oe = match self.terms.oersted_cylinder {
            Some(ref cfg) => cfg,
            None => return,
        };

        let envelope = oersted_envelope_at_time(oe, time_seconds);

        let current = oe.current * envelope;
        if current == 0.0 {
            return;
        }

        let r_cyl = oe.radius;
        let cx = oe.center[0];
        let cy = oe.center[1];
        let cz = oe.center[2];

        // Normalise the axis to a unit vector.
        let ax_len = (oe.axis[0] * oe.axis[0] + oe.axis[1] * oe.axis[1] + oe.axis[2] * oe.axis[2])
            .sqrt()
            .max(1e-30);
        let ax = [
            oe.axis[0] / ax_len,
            oe.axis[1] / ax_len,
            oe.axis[2] / ax_len,
        ];

        let two_pi = 2.0 * std::f64::consts::PI;

        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let nz = self.grid.nz;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let dz = self.cell_size.dz;

        for iz in 0..nz {
            for iy in 0..ny {
                for ix in 0..nx {
                    let idx = ix + nx * (iy + ny * iz);
                    if !self.is_active(idx) {
                        continue;
                    }

                    // Cell centre position.
                    let px = ix as f64 * dx + 0.5 * dx;
                    let py = iy as f64 * dy + 0.5 * dy;
                    let pz = iz as f64 * dz + 0.5 * dz;

                    // Vector from conductor centre to cell.
                    let dx_c = px - cx;
                    let dy_c = py - cy;
                    let dz_c = pz - cz;

                    // Project onto the axis to get the component along the axis.
                    let proj = dx_c * ax[0] + dy_c * ax[1] + dz_c * ax[2];

                    // Perpendicular (radial) vector from the axis.
                    let rx = dx_c - proj * ax[0];
                    let ry = dy_c - proj * ax[1];
                    let rz = dz_c - proj * ax[2];
                    let r_perp = (rx * rx + ry * ry + rz * rz).sqrt();

                    if r_perp < 1e-30 {
                        // On the axis — field is zero.
                        continue;
                    }

                    // Azimuthal direction: axis × r_hat  (right-hand rule).
                    let rhat = [rx / r_perp, ry / r_perp, rz / r_perp];
                    let phi = [
                        ax[1] * rhat[2] - ax[2] * rhat[1],
                        ax[2] * rhat[0] - ax[0] * rhat[2],
                        ax[0] * rhat[1] - ax[1] * rhat[0],
                    ];

                    // H magnitude [A/m].
                    let h_mag = if r_perp <= r_cyl {
                        current * r_perp / (two_pi * r_cyl * r_cyl)
                    } else {
                        current / (two_pi * r_perp)
                    };

                    h_eff[idx][0] += phi[0] * h_mag;
                    h_eff[idx][1] += phi[1] * h_mag;
                    h_eff[idx][2] += phi[2] * h_mag;
                }
            }
        }
    }

    // ===================================================================
    // Effective field (composite)
    // ===================================================================

    pub(crate) fn effective_field_into_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
    ) {
        self.effective_field_into_ws_at_time(magnetization, ws, h_eff, 0.0);
    }

    pub(crate) fn effective_field_into_ws_at_time(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        time_seconds: f64,
    ) {
        for h in h_eff.iter_mut() {
            *h = [0.0, 0.0, 0.0];
        }

        if self.terms.exchange {
            self.exchange_field_add_into(magnetization, h_eff);
        }
        if self.terms.demag {
            self.demag_field_add_into(magnetization, ws, h_eff);
        }

        // Magnetoelastic has its own complex per-cell / per-strain logic
        self.magnetoelastic_field_add_into(magnetization, h_eff);

        // B6: Fused single-pass for external + anisotropy + thermal
        // (avoids 3 separate passes over h_eff)
        self.fused_local_terms_add_into(magnetization, h_eff);

        // DMI terms need neighbor stencils — separate passes
        self.interfacial_dmi_field_add_into(magnetization, h_eff);
        self.bulk_dmi_field_add_into(magnetization, h_eff);

        // Oersted field from cylindrical conductor (STNO / MTJ)
        self.oersted_field_add_into_at_time(h_eff, time_seconds);
        for drive in self
            .regional_field_drives
            .iter()
            .filter(|drive| drive.enabled)
        {
            let multiplier = drive.multiplier_at(time_seconds);
            for (index, basis) in drive.basis_field.iter().enumerate().take(h_eff.len()) {
                if self.is_active(index) {
                    h_eff[index][0] += multiplier * basis[0];
                    h_eff[index][1] += multiplier * basis[1];
                    h_eff[index][2] += multiplier * basis[2];
                }
            }
        }
    }

    /// Effective field accumulation with telemetry instrumentation.
    #[allow(dead_code)]
    pub(crate) fn effective_field_into_ws_telem(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        telem: &mut StepTelemetry,
    ) {
        for h in h_eff.iter_mut() {
            *h = [0.0, 0.0, 0.0];
        }

        if self.terms.exchange {
            telem.begin(sections::FIELD_EXCHANGE);
            self.exchange_field_add_into(magnetization, h_eff);
            telem.end(sections::FIELD_EXCHANGE);
        }
        if self.terms.demag {
            telem.begin(sections::FIELD_DEMAG);
            self.demag_field_add_into(magnetization, ws, h_eff);
            telem.end(sections::FIELD_DEMAG);
        }
        telem.begin(sections::FIELD_EXTERNAL);
        self.external_field_add_into(h_eff);
        telem.end(sections::FIELD_EXTERNAL);

        telem.begin(sections::FIELD_MEL);
        self.magnetoelastic_field_add_into(magnetization, h_eff);
        telem.end(sections::FIELD_MEL);

        telem.begin(sections::FIELD_ANISOTROPY);
        self.anisotropy_field_add_into(magnetization, h_eff);
        telem.end(sections::FIELD_ANISOTROPY);

        telem.begin(sections::FIELD_DMI);
        self.interfacial_dmi_field_add_into(magnetization, h_eff);
        self.bulk_dmi_field_add_into(magnetization, h_eff);
        telem.end(sections::FIELD_DMI);

        telem.begin(sections::FIELD_THERMAL);
        self.thermal_field_add_into(h_eff);
        telem.end(sections::FIELD_THERMAL);

        // Oersted field from cylindrical conductor (STNO / MTJ)
        self.oersted_field_add_into(h_eff);
    }

    #[allow(dead_code)]
    pub(crate) fn llg_rhs_into_ws_zero_alloc(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        out: &mut [Vector3],
    ) {
        self.effective_field_into_ws(magnetization, ws, h_eff);
        self.llg_rhs_from_fields_with_direct_torques_into(magnetization, h_eff, out);
    }

    // ===================================================================
    // Torques
    // ===================================================================

    /// Evaluate the MuMax3 `addzhanglitorque2` realization at one cell.
    ///
    /// MuMax3 stores this contribution as a field-like torque divided by the
    /// electron gyromagnetic ratio.  The FDM engine stores direct RHS rates,
    /// so the shared `gamma_e` factor cancels from the source prefactor here.
    /// Non-periodic neighbours are clamped exactly as `hclampx/lclampx` in the
    /// vendored CUDA kernel; periodic axes wrap.
    fn zhang_li_mumax3_torque_at_with<F>(
        &self,
        cfg: &ZhangLiSttConfig,
        flat: usize,
        sample: F,
    ) -> Vector3
    where
        F: Fn(usize) -> Vector3,
    {
        if !self.is_active(flat) {
            return [0.0, 0.0, 0.0];
        }
        const MU_B: f64 = 9.2740091523e-24;
        const E_CHARGE: f64 = 1.60217646e-19;

        let ms = self.material.saturation_magnetisation.max(1e-30);
        let beta = cfg.non_adiabaticity;
        let alpha = self.material.damping;
        let b = (cfg.spin_polarization * MU_B) / (2.0 * E_CHARGE * ms * (1.0 + beta * beta));
        let ux = b * cfg.current_density[0];
        let uy = b * cfg.current_density[1];
        let uz = b * cfg.current_density[2];

        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let nz = self.grid.nz;
        let x = flat % nx;
        let y = (flat / nx) % ny;
        let z = flat / (nx * ny);
        let pbc_x = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let pbc_y = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let pbc_z = matches!(self.boundary_policy.z, AxisBoundary::Periodic);
        let xm = neighbor_index(x, nx, -1, pbc_x);
        let xp = neighbor_index(x, nx, 1, pbc_x);
        let ym = neighbor_index(y, ny, -1, pbc_y);
        let yp = neighbor_index(y, ny, 1, pbc_y);
        let zm = neighbor_index(z, nz, -1, pbc_z);
        let zp = neighbor_index(z, nz, 1, pbc_z);

        // `neighbor_index` clamps for open boundaries and wraps for PBC,
        // matching MuMax3's hclamp/lclamp helpers.
        let x_minus = sample(self.grid.index(xm, y, z));
        let x_plus = sample(self.grid.index(xp, y, z));
        let y_minus = sample(self.grid.index(x, ym, z));
        let y_plus = sample(self.grid.index(x, yp, z));
        let z_minus = sample(self.grid.index(x, y, zm));
        let z_plus = sample(self.grid.index(x, y, zp));
        let [m0, m1, m2] = sample(flat);

        // MuMax3's source prefactor already contains the factor 1/2. Its
        // `deltax`/`deltay`/`deltaz` macros therefore use the unhalved
        // neighbour difference divided by the cell size.
        let inv_dx = 1.0 / self.cell_size.dx;
        let inv_dy = 1.0 / self.cell_size.dy;
        let inv_dz = 1.0 / self.cell_size.dz;
        let dm0 = ux * (x_plus[0] - x_minus[0]) * inv_dx
            + uy * (y_plus[0] - y_minus[0]) * inv_dy
            + uz * (z_plus[0] - z_minus[0]) * inv_dz;
        let dm1 = ux * (x_plus[1] - x_minus[1]) * inv_dx
            + uy * (y_plus[1] - y_minus[1]) * inv_dy
            + uz * (z_plus[1] - z_minus[1]) * inv_dz;
        let dm2 = ux * (x_plus[2] - x_minus[2]) * inv_dx
            + uy * (y_plus[2] - y_minus[2]) * inv_dy
            + uz * (z_plus[2] - z_minus[2]) * inv_dz;

        let cx = m1 * dm2 - m2 * dm1;
        let cy = m2 * dm0 - m0 * dm2;
        let cz = m0 * dm1 - m1 * dm0;
        let dcx = m1 * cz - m2 * cy;
        let dcy = m2 * cx - m0 * cz;
        let dcz = m0 * cy - m1 * cx;
        let inv_gilbert = 1.0 / (1.0 + alpha * alpha);
        [
            -(1.0 + beta * alpha) * dcx * inv_gilbert + (alpha - beta) * cx * inv_gilbert,
            -(1.0 + beta * alpha) * dcy * inv_gilbert + (alpha - beta) * cy * inv_gilbert,
            -(1.0 + beta * alpha) * dcz * inv_gilbert + (alpha - beta) * cz * inv_gilbert,
        ]
    }

    fn zhang_li_mumax3_torque_at(
        &self,
        magnetization: &[Vector3],
        cfg: &ZhangLiSttConfig,
        flat: usize,
    ) -> Vector3 {
        self.zhang_li_mumax3_torque_at_with(cfg, flat, |index| magnetization[index])
    }

    fn zhang_li_mumax3_torque_at_soa(
        &self,
        magnetization: &VectorFieldSoA,
        cfg: &ZhangLiSttConfig,
        flat: usize,
    ) -> Vector3 {
        self.zhang_li_mumax3_torque_at_with(cfg, flat, |index| {
            [
                magnetization.x[index],
                magnetization.y[index],
                magnetization.z[index],
            ]
        })
    }

    #[allow(dead_code)]
    pub(crate) fn zhang_li_stt_torque(
        &self,
        magnetization: &[Vector3],
        cfg: &ZhangLiSttConfig,
    ) -> Vec<Vector3> {
        if cfg.formula == ZhangLiFormula::Mumax3V1 {
            return (0..self.grid.cell_count())
                .map(|flat| self.zhang_li_mumax3_torque_at(magnetization, cfg, flat))
                .collect();
        }
        const MU_B: f64 = 9.274009994e-24;
        // Zhang-Li remains an unversioned legacy evaluator. Preserve its
        // historical literal until a canonical formula version is introduced.
        const E_CHARGE: f64 = 1.60217662e-19;

        let ms = self.material.saturation_magnetisation.max(1e-30);
        let beta = cfg.non_adiabaticity;
        let alpha = self.material.damping;
        let (adiabatic_scale, cross_scale) = gilbert_zhang_li_scales(beta, alpha);
        let b = (cfg.spin_polarization * MU_B) / (E_CHARGE * ms * (1.0 + beta * beta));
        let ux = b * cfg.current_density[0];
        let uy = b * cfg.current_density[1];
        let uz = b * cfg.current_density[2];

        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let nz = self.grid.nz;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let dz = self.cell_size.dz;
        let n = self.grid.cell_count();

        (0..n)
            .map(|flat| {
                if !self.is_active(flat) {
                    return [0.0, 0.0, 0.0];
                }
                let x = flat % nx;
                let y = (flat / nx) % ny;
                let z = flat / (nx * ny);
                let [m0, m1, m2] = magnetization[flat];

                let mut dm0 = 0.0f64;
                let mut dm1 = 0.0f64;
                let mut dm2 = 0.0f64;

                let pbc_x = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
                let pbc_y = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
                let pbc_z = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

                if ux > 0.0 && (pbc_x || x > 0) {
                    let prev = self.grid.index(neighbor_index(x, nx, -1, pbc_x), y, z);
                    let [p0, p1, p2] = magnetization[prev];
                    dm0 += ux * (m0 - p0) / dx;
                    dm1 += ux * (m1 - p1) / dx;
                    dm2 += ux * (m2 - p2) / dx;
                } else if ux < 0.0 && (pbc_x || x + 1 < nx) {
                    let next = self.grid.index(neighbor_index(x, nx, 1, pbc_x), y, z);
                    let [n0, n1, n2] = magnetization[next];
                    dm0 += ux * (n0 - m0) / dx;
                    dm1 += ux * (n1 - m1) / dx;
                    dm2 += ux * (n2 - m2) / dx;
                }

                if uy > 0.0 && (pbc_y || y > 0) {
                    let prev = self.grid.index(x, neighbor_index(y, ny, -1, pbc_y), z);
                    let [p0, p1, p2] = magnetization[prev];
                    dm0 += uy * (m0 - p0) / dy;
                    dm1 += uy * (m1 - p1) / dy;
                    dm2 += uy * (m2 - p2) / dy;
                } else if uy < 0.0 && (pbc_y || y + 1 < ny) {
                    let next = self.grid.index(x, neighbor_index(y, ny, 1, pbc_y), z);
                    let [n0, n1, n2] = magnetization[next];
                    dm0 += uy * (n0 - m0) / dy;
                    dm1 += uy * (n1 - m1) / dy;
                    dm2 += uy * (n2 - m2) / dy;
                }

                if uz > 0.0 && (pbc_z || z > 0) {
                    let prev = self.grid.index(x, y, neighbor_index(z, nz, -1, pbc_z));
                    let [p0, p1, p2] = magnetization[prev];
                    dm0 += uz * (m0 - p0) / dz;
                    dm1 += uz * (m1 - p1) / dz;
                    dm2 += uz * (m2 - p2) / dz;
                } else if uz < 0.0 && (pbc_z || z + 1 < nz) {
                    let next = self.grid.index(x, y, neighbor_index(z, nz, 1, pbc_z));
                    let [n0, n1, n2] = magnetization[next];
                    dm0 += uz * (n0 - m0) / dz;
                    dm1 += uz * (n1 - m1) / dz;
                    dm2 += uz * (n2 - m2) / dz;
                }

                let cx = m1 * dm2 - m2 * dm1;
                let cy = m2 * dm0 - m0 * dm2;
                let cz = m0 * dm1 - m1 * dm0;

                let dcx = m1 * cz - m2 * cy;
                let dcy = m2 * cx - m0 * cz;
                let dcz = m0 * cy - m1 * cx;

                [
                    adiabatic_scale * (-dcx) + cross_scale * cx,
                    adiabatic_scale * (-dcy) + cross_scale * cy,
                    adiabatic_scale * (-dcz) + cross_scale * cz,
                ]
            })
            .collect()
    }

    #[allow(dead_code)]
    pub(crate) fn slonczewski_stt_torque(
        &self,
        magnetization: &[Vector3],
        cfg: &SlonczewskiSttConfig,
    ) -> Vec<Vector3> {
        let n = self.grid.cell_count();

        (0..n)
            .map(|flat| {
                if !self.is_active(flat)
                    || cfg
                        .active_mask
                        .as_ref()
                        .is_some_and(|mask| !mask.get(flat).copied().unwrap_or(false))
                {
                    return [0.0, 0.0, 0.0];
                }
                slonczewski_torque_from_config(
                    magnetization[flat],
                    cfg,
                    self.material.damping,
                    self.dynamics.gyromagnetic_ratio,
                    self.material.saturation_magnetisation,
                )
            })
            .collect()
    }

    #[allow(dead_code)]
    pub(crate) fn sot_torque(&self, magnetization: &[Vector3], cfg: &SotConfig) -> Vec<Vector3> {
        let n = self.grid.cell_count();

        (0..n)
            .map(|flat| {
                if !self.is_active(flat)
                    || cfg
                        .active_mask
                        .as_ref()
                        .is_some_and(|mask| !mask.get(flat).copied().unwrap_or(false))
                {
                    return [0.0, 0.0, 0.0];
                }
                prescribed_sot_torque_from_config(
                    magnetization[flat],
                    cfg,
                    self.material.saturation_magnetisation,
                    self.dynamics.gyromagnetic_ratio,
                    self.material.damping,
                )
            })
            .collect()
    }

    // ── Torque _add_into variants (zero-alloc) ──────────────────────────

    pub(crate) fn zhang_li_stt_torque_add_into(
        &self,
        magnetization: &[Vector3],
        cfg: &ZhangLiSttConfig,
        out: &mut [Vector3],
    ) {
        if cfg.formula == ZhangLiFormula::Mumax3V1 {
            for flat in 0..self.grid.cell_count() {
                let torque = self.zhang_li_mumax3_torque_at(magnetization, cfg, flat);
                out[flat][0] += torque[0];
                out[flat][1] += torque[1];
                out[flat][2] += torque[2];
            }
            return;
        }
        const MU_B: f64 = 9.274009994e-24;
        const E_CHARGE: f64 = 1.60217662e-19;

        let ms = self.material.saturation_magnetisation.max(1e-30);
        let beta = cfg.non_adiabaticity;
        let alpha = self.material.damping;
        let (adiabatic_scale, cross_scale) = gilbert_zhang_li_scales(beta, alpha);
        let b = (cfg.spin_polarization * MU_B) / (E_CHARGE * ms * (1.0 + beta * beta));
        let ux = b * cfg.current_density[0];
        let uy = b * cfg.current_density[1];
        let uz = b * cfg.current_density[2];

        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let nz = self.grid.nz;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let dz = self.cell_size.dz;
        let n = self.grid.cell_count();
        let grid = self.grid;

        let compute = |flat: usize, o: &mut Vector3| {
            if !self.is_active(flat) {
                return;
            }
            let x = flat % nx;
            let y = (flat / nx) % ny;
            let z = flat / (nx * ny);
            let [m0, m1, m2] = magnetization[flat];

            let pbc_x = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
            let pbc_y = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
            let pbc_z = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

            let mut dm0 = 0.0f64;
            let mut dm1 = 0.0f64;
            let mut dm2 = 0.0f64;

            if ux > 0.0 && (pbc_x || x > 0) {
                let prev = grid.index(neighbor_index(x, nx, -1, pbc_x), y, z);
                let [p0, p1, p2] = magnetization[prev];
                dm0 += ux * (m0 - p0) / dx;
                dm1 += ux * (m1 - p1) / dx;
                dm2 += ux * (m2 - p2) / dx;
            } else if ux < 0.0 && (pbc_x || x + 1 < nx) {
                let next = grid.index(neighbor_index(x, nx, 1, pbc_x), y, z);
                let [n0, n1, n2] = magnetization[next];
                dm0 += ux * (n0 - m0) / dx;
                dm1 += ux * (n1 - m1) / dx;
                dm2 += ux * (n2 - m2) / dx;
            }

            if uy > 0.0 && (pbc_y || y > 0) {
                let prev = grid.index(x, neighbor_index(y, ny, -1, pbc_y), z);
                let [p0, p1, p2] = magnetization[prev];
                dm0 += uy * (m0 - p0) / dy;
                dm1 += uy * (m1 - p1) / dy;
                dm2 += uy * (m2 - p2) / dy;
            } else if uy < 0.0 && (pbc_y || y + 1 < ny) {
                let next = grid.index(x, neighbor_index(y, ny, 1, pbc_y), z);
                let [n0, n1, n2] = magnetization[next];
                dm0 += uy * (n0 - m0) / dy;
                dm1 += uy * (n1 - m1) / dy;
                dm2 += uy * (n2 - m2) / dy;
            }

            if uz > 0.0 && (pbc_z || z > 0) {
                let prev = grid.index(x, y, neighbor_index(z, nz, -1, pbc_z));
                let [p0, p1, p2] = magnetization[prev];
                dm0 += uz * (m0 - p0) / dz;
                dm1 += uz * (m1 - p1) / dz;
                dm2 += uz * (m2 - p2) / dz;
            } else if uz < 0.0 && (pbc_z || z + 1 < nz) {
                let next = grid.index(x, y, neighbor_index(z, nz, 1, pbc_z));
                let [n0, n1, n2] = magnetization[next];
                dm0 += uz * (n0 - m0) / dz;
                dm1 += uz * (n1 - m1) / dz;
                dm2 += uz * (n2 - m2) / dz;
            }

            let cx = m1 * dm2 - m2 * dm1;
            let cy = m2 * dm0 - m0 * dm2;
            let cz = m0 * dm1 - m1 * dm0;

            let dcx = m1 * cz - m2 * cy;
            let dcy = m2 * cx - m0 * cz;
            let dcz = m0 * cy - m1 * cx;

            o[0] += adiabatic_scale * (-dcx) + cross_scale * cx;
            o[1] += adiabatic_scale * (-dcy) + cross_scale * cy;
            o[2] += adiabatic_scale * (-dcz) + cross_scale * cz;
        };

        #[cfg(feature = "parallel")]
        {
            out[..n].par_iter_mut().enumerate().for_each(|(flat, o)| {
                compute(flat, o);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for flat in 0..n {
                compute(flat, &mut out[flat]);
            }
        }
    }

    pub(crate) fn zhang_li_stt_torque_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        cfg: &ZhangLiSttConfig,
        out: &mut VectorFieldSoA,
    ) {
        if cfg.formula == ZhangLiFormula::Mumax3V1 {
            for flat in 0..self.grid.cell_count() {
                let torque = self.zhang_li_mumax3_torque_at_soa(magnetization, cfg, flat);
                out.x[flat] += torque[0];
                out.y[flat] += torque[1];
                out.z[flat] += torque[2];
            }
            return;
        }
        const MU_B: f64 = 9.274009994e-24;
        const E_CHARGE: f64 = 1.60217662e-19;

        let ms = self.material.saturation_magnetisation.max(1e-30);
        let beta = cfg.non_adiabaticity;
        let alpha = self.material.damping;
        let (adiabatic_scale, cross_scale) = gilbert_zhang_li_scales(beta, alpha);
        let b = (cfg.spin_polarization * MU_B) / (E_CHARGE * ms * (1.0 + beta * beta));
        let ux = b * cfg.current_density[0];
        let uy = b * cfg.current_density[1];
        let uz = b * cfg.current_density[2];

        let nx = self.grid.nx;
        let ny = self.grid.ny;
        let nz = self.grid.nz;
        let dx = self.cell_size.dx;
        let dy = self.cell_size.dy;
        let dz = self.cell_size.dz;
        let grid = self.grid;

        for flat in 0..grid.cell_count() {
            if !self.is_active(flat) {
                continue;
            }
            let x = flat % nx;
            let y = (flat / nx) % ny;
            let z = flat / (nx * ny);
            let m0 = magnetization.x[flat];
            let m1 = magnetization.y[flat];
            let m2 = magnetization.z[flat];

            let pbc_x = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
            let pbc_y = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
            let pbc_z = matches!(self.boundary_policy.z, AxisBoundary::Periodic);

            let mut dm0 = 0.0f64;
            let mut dm1 = 0.0f64;
            let mut dm2 = 0.0f64;

            if ux > 0.0 && (pbc_x || x > 0) {
                let prev = grid.index(neighbor_index(x, nx, -1, pbc_x), y, z);
                dm0 += ux * (m0 - magnetization.x[prev]) / dx;
                dm1 += ux * (m1 - magnetization.y[prev]) / dx;
                dm2 += ux * (m2 - magnetization.z[prev]) / dx;
            } else if ux < 0.0 && (pbc_x || x + 1 < nx) {
                let next = grid.index(neighbor_index(x, nx, 1, pbc_x), y, z);
                dm0 += ux * (magnetization.x[next] - m0) / dx;
                dm1 += ux * (magnetization.y[next] - m1) / dx;
                dm2 += ux * (magnetization.z[next] - m2) / dx;
            }

            if uy > 0.0 && (pbc_y || y > 0) {
                let prev = grid.index(x, neighbor_index(y, ny, -1, pbc_y), z);
                dm0 += uy * (m0 - magnetization.x[prev]) / dy;
                dm1 += uy * (m1 - magnetization.y[prev]) / dy;
                dm2 += uy * (m2 - magnetization.z[prev]) / dy;
            } else if uy < 0.0 && (pbc_y || y + 1 < ny) {
                let next = grid.index(x, neighbor_index(y, ny, 1, pbc_y), z);
                dm0 += uy * (magnetization.x[next] - m0) / dy;
                dm1 += uy * (magnetization.y[next] - m1) / dy;
                dm2 += uy * (magnetization.z[next] - m2) / dy;
            }

            if uz > 0.0 && (pbc_z || z > 0) {
                let prev = grid.index(x, y, neighbor_index(z, nz, -1, pbc_z));
                dm0 += uz * (m0 - magnetization.x[prev]) / dz;
                dm1 += uz * (m1 - magnetization.y[prev]) / dz;
                dm2 += uz * (m2 - magnetization.z[prev]) / dz;
            } else if uz < 0.0 && (pbc_z || z + 1 < nz) {
                let next = grid.index(x, y, neighbor_index(z, nz, 1, pbc_z));
                dm0 += uz * (magnetization.x[next] - m0) / dz;
                dm1 += uz * (magnetization.y[next] - m1) / dz;
                dm2 += uz * (magnetization.z[next] - m2) / dz;
            }

            let cx = m1 * dm2 - m2 * dm1;
            let cy = m2 * dm0 - m0 * dm2;
            let cz = m0 * dm1 - m1 * dm0;

            let dcx = m1 * cz - m2 * cy;
            let dcy = m2 * cx - m0 * cz;
            let dcz = m0 * cy - m1 * cx;

            out.x[flat] += adiabatic_scale * (-dcx) + cross_scale * cx;
            out.y[flat] += adiabatic_scale * (-dcy) + cross_scale * cy;
            out.z[flat] += adiabatic_scale * (-dcz) + cross_scale * cz;
        }
    }

    pub(crate) fn slonczewski_stt_torque_add_into(
        &self,
        magnetization: &[Vector3],
        cfg: &SlonczewskiSttConfig,
        out: &mut [Vector3],
    ) {
        let n = self.grid.cell_count();

        let compute = |flat: usize, o: &mut Vector3| {
            if !self.is_active(flat)
                || cfg
                    .active_mask
                    .as_ref()
                    .is_some_and(|mask| !mask.get(flat).copied().unwrap_or(false))
            {
                return;
            }
            let torque = slonczewski_torque_from_config(
                magnetization[flat],
                cfg,
                self.material.damping,
                self.dynamics.gyromagnetic_ratio,
                self.material.saturation_magnetisation,
            );
            o[0] += torque[0];
            o[1] += torque[1];
            o[2] += torque[2];
        };

        #[cfg(feature = "parallel")]
        {
            out[..n].par_iter_mut().enumerate().for_each(|(flat, o)| {
                compute(flat, o);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for flat in 0..n {
                compute(flat, &mut out[flat]);
            }
        }
    }

    pub(crate) fn slonczewski_stt_torque_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        cfg: &SlonczewskiSttConfig,
        out: &mut VectorFieldSoA,
    ) {
        for flat in 0..self.grid.cell_count() {
            if !self.is_active(flat)
                || cfg
                    .active_mask
                    .as_ref()
                    .is_some_and(|mask| !mask.get(flat).copied().unwrap_or(false))
            {
                continue;
            }
            let torque = slonczewski_torque_from_config(
                [
                    magnetization.x[flat],
                    magnetization.y[flat],
                    magnetization.z[flat],
                ],
                cfg,
                self.material.damping,
                self.dynamics.gyromagnetic_ratio,
                self.material.saturation_magnetisation,
            );
            out.x[flat] += torque[0];
            out.y[flat] += torque[1];
            out.z[flat] += torque[2];
        }
    }

    pub(crate) fn sot_torque_add_into(
        &self,
        magnetization: &[Vector3],
        cfg: &SotConfig,
        out: &mut [Vector3],
    ) {
        let n = self.grid.cell_count();

        let compute = |flat: usize, o: &mut Vector3| {
            if !self.is_active(flat)
                || cfg
                    .active_mask
                    .as_ref()
                    .is_some_and(|mask| !mask.get(flat).copied().unwrap_or(false))
            {
                return;
            }
            let torque = prescribed_sot_torque_from_config(
                magnetization[flat],
                cfg,
                self.material.saturation_magnetisation,
                self.dynamics.gyromagnetic_ratio,
                self.material.damping,
            );
            o[0] += torque[0];
            o[1] += torque[1];
            o[2] += torque[2];
        };

        #[cfg(feature = "parallel")]
        {
            out[..n].par_iter_mut().enumerate().for_each(|(flat, o)| {
                compute(flat, o);
            });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for flat in 0..n {
                compute(flat, &mut out[flat]);
            }
        }
    }

    pub(crate) fn sot_torque_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        cfg: &SotConfig,
        out: &mut VectorFieldSoA,
    ) {
        for flat in 0..self.grid.cell_count() {
            if !self.is_active(flat)
                || cfg
                    .active_mask
                    .as_ref()
                    .is_some_and(|mask| !mask.get(flat).copied().unwrap_or(false))
            {
                continue;
            }
            let torque = prescribed_sot_torque_from_config(
                [magnetization.x[flat], magnetization.y[flat], magnetization.z[flat]],
                cfg,
                self.material.saturation_magnetisation,
                self.dynamics.gyromagnetic_ratio,
                self.material.damping,
            );
            out.x[flat] += torque[0];
            out.y[flat] += torque[1];
            out.z[flat] += torque[2];
        }
    }

    // ===================================================================
    // Zero-allocation step report computation
    // ===================================================================

    /// Compute step observables (energies, max amplitudes) using pre-allocated
    /// buffers. Zero heap allocations in the hot path.
    ///
    /// Uses `h_scratch` for individual field components to compute decomposed
    /// energies, accumulates into `h_eff`, then computes RHS into `rhs_out`.
    #[allow(dead_code, non_snake_case)]
    pub(crate) fn compute_step_observables_zero_alloc(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        h_scratch: &mut [Vector3],
        rhs_out: &mut [Vector3],
    ) -> RhsEvaluation {
        self.compute_step_observables_zero_alloc_at_time(
            magnetization,
            ws,
            h_eff,
            h_scratch,
            rhs_out,
            0.0,
        )
    }

    #[allow(non_snake_case)]
    pub(crate) fn compute_step_observables_zero_alloc_at_time(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        h_scratch: &mut [Vector3],
        rhs_out: &mut [Vector3],
        time_seconds: f64,
    ) -> RhsEvaluation {
        let n = magnetization.len();

        // Zero h_eff
        for h in h_eff[..n].iter_mut() {
            *h = [0.0, 0.0, 0.0];
        }

        // ── Exchange ──────────────────────────────────────────────────
        let exchange_energy_joules = if self.terms.exchange {
            for h in h_scratch[..n].iter_mut() {
                *h = [0.0, 0.0, 0.0];
            }
            self.exchange_field_add_into(magnetization, &mut h_scratch[..n]);
            let e = self.exchange_energy_from_field(magnetization, &h_scratch[..n]);
            for i in 0..n {
                h_eff[i] = add(h_eff[i], h_scratch[i]);
            }
            e
        } else {
            0.0
        };

        // ── Demag ─────────────────────────────────────────────────────
        let (demag_energy_joules, max_demag_field_amplitude) = if self.terms.demag {
            for h in h_scratch[..n].iter_mut() {
                *h = [0.0, 0.0, 0.0];
            }
            self.demag_field_add_into(magnetization, ws, &mut h_scratch[..n]);
            let e = self.demag_energy_from_fields(magnetization, &h_scratch[..n]);
            let m = max_norm(&h_scratch[..n]);
            for i in 0..n {
                h_eff[i] = add(h_eff[i], h_scratch[i]);
            }
            (e, m)
        } else {
            (0.0, 0.0)
        };

        // ── External ──────────────────────────────────────────────────
        let external_energy_joules = if self.has_external_zeeman_source() {
            for h in h_scratch[..n].iter_mut() {
                *h = [0.0, 0.0, 0.0];
            }
            self.external_field_add_into(&mut h_scratch[..n]);
            self.oersted_field_add_into_at_time(&mut h_scratch[..n], time_seconds);
            let e = self.external_energy_from_fields(magnetization, &h_scratch[..n]);
            for i in 0..n {
                h_eff[i] = add(h_eff[i], h_scratch[i]);
            }
            e
        } else {
            0.0
        };

        // ── Remaining local terms (directly into h_eff) ──────────────
        self.magnetoelastic_field_add_into(magnetization, &mut h_eff[..n]);
        self.anisotropy_field_add_into(magnetization, &mut h_eff[..n]);
        self.interfacial_dmi_field_add_into(magnetization, &mut h_eff[..n]);
        self.bulk_dmi_field_add_into(magnetization, &mut h_eff[..n]);
        self.thermal_field_add_into(&mut h_eff[..n]);

        let mel_energy_joules = self.magnetoelastic_energy(magnetization);
        let ani_energy_joules = self.anisotropy_energy(magnetization);
        let dmi_energy_joules = self.dmi_energy_from_vectors(magnetization);

        let max_effective_field_amplitude = max_norm(&h_eff[..n]);

        // ── RHS ───────────────────────────────────────────────────────
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            rhs_out[..n]
                .par_iter_mut()
                .enumerate()
                .for_each(|(i, out)| {
                    *out = self.llg_rhs_from_field_at(i, magnetization[i], h_eff[i]);
                });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for i in 0..n {
                rhs_out[i] = self.llg_rhs_from_field_at(i, magnetization[i], h_eff[i]);
            }
        }

        // ── Torques ───────────────────────────────────────────────────
        if let Some(ref zl) = self.terms.zhang_li_stt {
            self.zhang_li_stt_torque_add_into(magnetization, zl, &mut rhs_out[..n]);
        }
        if let Some(ref slon) = self.terms.slonczewski_stt {
            self.slonczewski_stt_torque_add_into(magnetization, slon, &mut rhs_out[..n]);
        }
        if let Some(ref sot) = self.terms.sot {
            self.sot_torque_add_into(magnetization, sot, &mut rhs_out[..n]);
        }

        let max_rhs_amplitude = max_norm(&rhs_out[..n]);
        let max_torque_Apm = max_cross_norm(&magnetization[..n], &h_eff[..n]);

        RhsEvaluation {
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            anisotropy_energy_joules: ani_energy_joules,
            dmi_energy_joules,
            total_energy_joules: exchange_energy_joules
                + demag_energy_joules
                + external_energy_joules
                + mel_energy_joules
                + ani_energy_joules
                + dmi_energy_joules,
            max_effective_field_amplitude,
            max_demag_field_amplitude,
            max_rhs_amplitude,
            max_torque_Apm,
        }
    }

    /// Minimal observables: compute h_eff and rhs only, skip per-term energy
    /// decomposition.  Returns `RhsEvaluation` with all energies set to 0.0.
    ///
    /// This avoids the extra scratch-buffer passes needed to separate
    /// exchange / demag / external energy contributions.
    #[allow(dead_code, non_snake_case)]
    pub(crate) fn compute_step_observables_minimal(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        rhs_out: &mut [Vector3],
    ) -> RhsEvaluation {
        self.compute_step_observables_minimal_at_time(magnetization, ws, h_eff, rhs_out, 0.0)
    }

    #[allow(dead_code, non_snake_case)]
    pub(crate) fn compute_step_observables_minimal_at_time(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        rhs_out: &mut [Vector3],
        time_seconds: f64,
    ) -> RhsEvaluation {
        // Compute h_eff in-place (zero + accumulate all terms)
        self.effective_field_into_ws_at_time(magnetization, ws, h_eff, time_seconds);

        let n = magnetization.len();
        let max_effective_field_amplitude = max_norm(&h_eff[..n]);

        // RHS
        #[cfg(feature = "parallel")]
        {
            use rayon::prelude::*;
            rhs_out[..n]
                .par_iter_mut()
                .enumerate()
                .for_each(|(i, out)| {
                    *out = self.llg_rhs_from_field_at(i, magnetization[i], h_eff[i]);
                });
        }
        #[cfg(not(feature = "parallel"))]
        {
            for i in 0..n {
                rhs_out[i] = self.llg_rhs_from_field_at(i, magnetization[i], h_eff[i]);
            }
        }

        // Torques
        if let Some(ref zl) = self.terms.zhang_li_stt {
            self.zhang_li_stt_torque_add_into(magnetization, zl, &mut rhs_out[..n]);
        }
        if let Some(ref slon) = self.terms.slonczewski_stt {
            self.slonczewski_stt_torque_add_into(magnetization, slon, &mut rhs_out[..n]);
        }
        if let Some(ref sot) = self.terms.sot {
            self.sot_torque_add_into(magnetization, sot, &mut rhs_out[..n]);
        }

        let max_rhs_amplitude = max_norm(&rhs_out[..n]);
        let max_torque_Apm = max_cross_norm(&magnetization[..n], &h_eff[..n]);

        RhsEvaluation {
            exchange_energy_joules: 0.0,
            demag_energy_joules: 0.0,
            external_energy_joules: 0.0,
            anisotropy_energy_joules: 0.0,
            dmi_energy_joules: 0.0,
            total_energy_joules: 0.0,
            max_effective_field_amplitude,
            max_demag_field_amplitude: 0.0,
            max_rhs_amplitude,
            max_torque_Apm,
        }
    }

    /// Dispatch to full or minimal observables based on evaluation request.
    #[allow(dead_code)]
    pub(crate) fn compute_step_observables(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        h_scratch: &mut [Vector3],
        rhs_out: &mut [Vector3],
        request: crate::EvaluationRequest,
    ) -> RhsEvaluation {
        self.compute_step_observables_at_time(
            magnetization,
            ws,
            h_eff,
            h_scratch,
            rhs_out,
            request,
            0.0,
        )
    }

    pub(crate) fn compute_step_observables_at_time(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        h_eff: &mut [Vector3],
        h_scratch: &mut [Vector3],
        rhs_out: &mut [Vector3],
        request: crate::EvaluationRequest,
        time_seconds: f64,
    ) -> RhsEvaluation {
        match request {
            crate::EvaluationRequest::Minimal => self.compute_step_observables_minimal_at_time(
                magnetization,
                ws,
                h_eff,
                rhs_out,
                time_seconds,
            ),
            crate::EvaluationRequest::Full => self.compute_step_observables_zero_alloc_at_time(
                magnetization,
                ws,
                h_eff,
                h_scratch,
                rhs_out,
                time_seconds,
            ),
        }
    }

    // ===================================================================
    // Public effective field & LLG RHS API
    // ===================================================================

    #[deprecated(
        since = "0.1.0",
        note = "creates a new FFT workspace per call; use effective_field_from_vectors_ws() instead"
    )]
    pub fn effective_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let mut ws = self.create_workspace();
        self.effective_field_from_vectors_ws(magnetization, &mut ws)
    }

    pub fn effective_field_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        self.effective_field_from_vectors_ws_at_time(magnetization, ws, 0.0)
    }

    pub(crate) fn effective_field_from_vectors_ws_at_time(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        time_seconds: f64,
    ) -> Vec<Vector3> {
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let demag_field = if self.terms.demag {
            self.demag_field_from_vectors_ws(magnetization, ws)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let external_field = self.external_field_vectors();
        let mel_field = self.magnetoelastic_field(magnetization);
        let ani_field = self.anisotropy_field(magnetization);
        let idmi_field = self.interfacial_dmi_field(magnetization);
        let bdmi_field = self.bulk_dmi_field(magnetization);
        let mut h_eff =
            combine_fields_4(&exchange_field, &demag_field, &external_field, &mel_field);
        for (i, h) in h_eff.iter_mut().enumerate() {
            *h = add(add(add(*h, ani_field[i]), idmi_field[i]), bdmi_field[i]);
        }

        // Brown thermal field
        if self.temperature > 0.0
            && self.material.saturation_magnetisation > 0.0
            && self.thermal_dt > 0.0
        {
            use std::cell::RefCell;

            thread_local! {
                static RNG: RefCell<u64> = const { RefCell::new(42u64) };
            }

            let alpha = self.material.damping;
            let ms = self.material.saturation_magnetisation;
            let gamma0 = self.dynamics.gyromagnetic_ratio;
            let v_cell = self.cell_size.dx * self.cell_size.dy * self.cell_size.dz;
            const KB: f64 = 1.380649e-23;
            const MU0: f64 = 1.2566370614359173e-6;

            let sigma = (2.0 * alpha * KB * self.temperature
                / (gamma0 * MU0 * ms * v_cell * self.thermal_dt))
                .sqrt();

            RNG.with(|seed_cell| {
                let mut seed = *seed_cell.borrow();
                for h in h_eff.iter_mut() {
                    let (n0, n1, n2) = {
                        let next_u = |s: &mut u64| -> f64 {
                            *s ^= *s >> 12;
                            *s ^= *s << 25;
                            *s ^= *s >> 27;
                            ((*s).wrapping_mul(0x2545F4914F6CDD1D) >> 11) as f64
                                / (1u64 << 53) as f64
                        };
                        let u1 = next_u(&mut seed).max(1e-300);
                        let u2 = next_u(&mut seed);
                        let u3 = next_u(&mut seed).max(1e-300);
                        let u4 = next_u(&mut seed);
                        let r1 = (-2.0 * u1.ln()).sqrt();
                        let r2 = (-2.0 * u3.ln()).sqrt();
                        let theta1 = 2.0 * std::f64::consts::PI * u2;
                        let theta2 = 2.0 * std::f64::consts::PI * u4;
                        (r1 * theta1.cos(), r1 * theta1.sin(), r2 * theta2.cos())
                    };
                    h[0] += sigma * n0;
                    h[1] += sigma * n1;
                    h[2] += sigma * n2;
                }
                *seed_cell.borrow_mut() = seed;
            });
        }

        // Oersted field from cylindrical conductor (STNO / MTJ)
        self.oersted_field_add_into_at_time(&mut h_eff, time_seconds);

        h_eff
    }

    pub(crate) fn observable_effective_field_from_vectors_ws_at_time(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
        time_seconds: f64,
    ) -> Vec<Vector3> {
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let demag_field = if self.terms.demag {
            self.demag_field_from_vectors_ws(magnetization, ws)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let external_field = self.external_field_vectors();
        let mel_field = self.magnetoelastic_field(magnetization);
        let ani_field = self.anisotropy_field(magnetization);
        let idmi_field = self.interfacial_dmi_field(magnetization);
        let bdmi_field = self.bulk_dmi_field(magnetization);
        let mut h_eff =
            combine_fields_4(&exchange_field, &demag_field, &external_field, &mel_field);
        for (i, h) in h_eff.iter_mut().enumerate() {
            *h = add(add(add(*h, ani_field[i]), idmi_field[i]), bdmi_field[i]);
        }
        self.oersted_field_add_into_at_time(&mut h_eff, time_seconds);
        h_eff
    }

    pub fn tangent_gradient_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        let h_eff = self.effective_field_from_vectors_ws(magnetization, ws);
        magnetization
            .iter()
            .zip(h_eff.iter())
            .map(|(m, h)| {
                let m_dot_h = dot(*m, *h);
                let projected = sub(*h, scale(*m, m_dot_h));
                scale(projected, -1.0)
            })
            .collect()
    }

    pub fn tangent_gradient_from_soa_field_into(
        &self,
        magnetization: &VectorFieldSoA,
        h_eff: &VectorFieldSoA,
        out: &mut VectorFieldSoA,
    ) {
        let n = magnetization.len();
        debug_assert!(h_eff.len() >= n);
        debug_assert!(out.len() >= n);
        for i in 0..n {
            let m_dot_h = magnetization.x[i] * h_eff.x[i]
                + magnetization.y[i] * h_eff.y[i]
                + magnetization.z[i] * h_eff.z[i];
            out.x[i] = -(h_eff.x[i] - magnetization.x[i] * m_dot_h);
            out.y[i] = -(h_eff.y[i] - magnetization.y[i] * m_dot_h);
            out.z[i] = -(h_eff.z[i] - magnetization.z[i] * m_dot_h);
        }
    }

    pub fn tangent_gradient_from_field(
        magnetization: &[Vector3],
        h_eff: &[Vector3],
    ) -> Vec<Vector3> {
        magnetization
            .iter()
            .zip(h_eff.iter())
            .map(|(m, h)| {
                let m_dot_h = dot(*m, *h);
                let projected = sub(*h, scale(*m, m_dot_h));
                scale(projected, -1.0)
            })
            .collect()
    }

    pub fn total_energy_from_soa_ws(
        &self,
        magnetization: &VectorFieldSoA,
        ws: &mut FftWorkspace,
        scratch: &mut VectorFieldSoA,
    ) -> f64 {
        let mut total = 0.0;

        if self.terms.exchange {
            scratch.fill_zero();
            self.exchange_field_add_into_soa(magnetization, scratch);
            total += self.half_field_energy_from_soa(magnetization, scratch);
        }
        if self.terms.demag {
            scratch.fill_zero();
            self.demag_field_add_into_soa_fft_backend(magnetization, ws, scratch);
            total += self.half_field_energy_from_soa(magnetization, scratch);
        }
        if self.has_external_zeeman_source() {
            scratch.fill_zero();
            self.external_field_add_into_soa(scratch);
            self.oersted_field_add_into_soa(scratch);
            total += self.full_field_energy_from_soa(magnetization, scratch);
        }
        if self.regional_field_drives.iter().any(|drive| drive.enabled) {
            scratch.fill_zero();
            for drive in self
                .regional_field_drives
                .iter()
                .filter(|drive| drive.enabled)
            {
                let multiplier = drive.multiplier_at(0.0);
                for (index, basis) in drive.basis_field.iter().enumerate().take(scratch.len()) {
                    if self.is_active(index) {
                        scratch.x[index] += multiplier * basis[0];
                        scratch.y[index] += multiplier * basis[1];
                        scratch.z[index] += multiplier * basis[2];
                    }
                }
            }
            total += self.full_field_energy_from_soa(magnetization, scratch);
        }
        total += self.magnetoelastic_energy_soa(magnetization);
        if self.terms.uniaxial_anisotropy.is_some() || self.terms.cubic_anisotropy.is_some() {
            total += self.anisotropy_energy_from_soa(magnetization);
        }
        total += self.dmi_energy_from_soa(magnetization);

        total
    }

    pub fn total_energy_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> f64 {
        let mut total = 0.0;

        if self.terms.exchange {
            let h_ex = self.exchange_field_from_vectors(magnetization);
            total += self.exchange_energy_from_field(magnetization, &h_ex);
        }
        if self.terms.demag {
            let h_demag = self.demag_field_from_vectors_ws(magnetization, ws);
            total += self.demag_energy_from_fields(magnetization, &h_demag);
        }
        if self.has_external_zeeman_source() {
            let h_ext = self.external_zeeman_field_vectors();
            total += self.external_energy_from_fields(magnetization, &h_ext);
        }
        if self.regional_field_drives.iter().any(|drive| drive.enabled) {
            let h_drive = self.regional_drive_field_at_time(0.0);
            total += self.external_energy_from_fields(magnetization, &h_drive);
        }
        total += self.magnetoelastic_energy(magnetization);
        if self.terms.uniaxial_anisotropy.is_some() || self.terms.cubic_anisotropy.is_some() {
            total += self.anisotropy_energy(magnetization);
        }
        total += self.dmi_energy_from_vectors(magnetization);

        total
    }

    pub(crate) fn half_field_energy_from_soa(
        &self,
        magnetization: &VectorFieldSoA,
        field: &VectorFieldSoA,
    ) -> f64 {
        self.field_energy_from_soa(magnetization, field, -0.5 * MU0)
    }

    pub(crate) fn full_field_energy_from_soa(
        &self,
        magnetization: &VectorFieldSoA,
        field: &VectorFieldSoA,
    ) -> f64 {
        self.field_energy_from_soa(magnetization, field, -MU0)
    }

    pub(crate) fn field_energy_from_soa(
        &self,
        magnetization: &VectorFieldSoA,
        field: &VectorFieldSoA,
        mu0_scale: f64,
    ) -> f64 {
        let n = magnetization.len();
        debug_assert!(field.len() >= n);
        let scale = mu0_scale * self.material.saturation_magnetisation * self.cell_size.volume();
        let compute = |i: usize| {
            scale
                * (magnetization.x[i] * field.x[i]
                    + magnetization.y[i] * field.y[i]
                    + magnetization.z[i] * field.z[i])
        };
        #[cfg(feature = "parallel")]
        {
            (0..n).into_par_iter().map(compute).sum()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..n).map(compute).sum()
        }
    }

    pub(crate) fn llg_rhs_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let mut ws = self.create_workspace();
        self.llg_rhs_from_vectors_ws(magnetization, &mut ws)
    }

    pub(crate) fn llg_rhs_from_vectors_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> Vec<Vector3> {
        let field = self.effective_field_from_vectors_ws(magnetization, ws);
        let mut rhs = zero_vectors(magnetization.len());
        self.llg_rhs_from_fields_with_direct_torques_into(magnetization, &field, &mut rhs);
        rhs
    }

    #[allow(dead_code)]
    pub(crate) fn llg_rhs_full_ws(
        &self,
        magnetization: &[Vector3],
        ws: &mut FftWorkspace,
    ) -> (Vec<Vector3>, RhsEvaluation) {
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let demag_field = if self.terms.demag {
            self.demag_field_from_vectors_ws(magnetization, ws)
        } else {
            zero_vectors(self.grid.cell_count())
        };
        let external_field = self.external_field_vectors();
        let mel_field = self.magnetoelastic_field(magnetization);
        let ani_field = self.anisotropy_field(magnetization);
        let idmi_field = self.interfacial_dmi_field(magnetization);
        let bdmi_field = self.bulk_dmi_field(magnetization);
        let mut effective_field =
            combine_fields_4(&exchange_field, &demag_field, &external_field, &mel_field);
        for (i, h) in effective_field.iter_mut().enumerate() {
            *h = add(add(add(*h, ani_field[i]), idmi_field[i]), bdmi_field[i]);
        }

        // Oersted field from cylindrical conductor (STNO / MTJ)
        self.oersted_field_add_into(&mut effective_field);

        let mut rhs: Vec<Vector3> = magnetization
            .iter()
            .zip(effective_field.iter())
            .enumerate()
            .map(|(i, (m, h))| self.llg_rhs_from_field_at(i, *m, *h))
            .collect();

        if let Some(ref zl) = self.terms.zhang_li_stt {
            let zl_torque = self.zhang_li_stt_torque(magnetization, zl);
            for (r, t) in rhs.iter_mut().zip(zl_torque.iter()) {
                *r = add(*r, *t);
            }
        }
        if let Some(ref slon) = self.terms.slonczewski_stt {
            let slon_torque = self.slonczewski_stt_torque(magnetization, slon);
            for (r, t) in rhs.iter_mut().zip(slon_torque.iter()) {
                *r = add(*r, *t);
            }
        }
        if let Some(ref sot) = self.terms.sot {
            let sot_torque = self.sot_torque(magnetization, sot);
            for (r, t) in rhs.iter_mut().zip(sot_torque.iter()) {
                *r = add(*r, *t);
            }
        }

        let exchange_energy_joules = if self.terms.exchange {
            self.exchange_energy_from_field(magnetization, &exchange_field)
        } else {
            0.0
        };
        let demag_energy_joules = if self.terms.demag {
            self.demag_energy_from_fields(magnetization, &demag_field)
        } else {
            0.0
        };
        let external_energy_joules = if self.has_external_zeeman_source() {
            let external_zeeman_field = self.external_zeeman_field_vectors();
            self.external_energy_from_fields(magnetization, &external_zeeman_field)
        } else {
            0.0
        };
        let mel_energy_joules = self.magnetoelastic_energy(magnetization);
        let ani_energy_joules = self.anisotropy_energy(magnetization);
        let dmi_energy_joules = self.dmi_energy_from_vectors(magnetization);

        let eval = RhsEvaluation {
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            anisotropy_energy_joules: ani_energy_joules,
            dmi_energy_joules,
            total_energy_joules: exchange_energy_joules
                + demag_energy_joules
                + external_energy_joules
                + mel_energy_joules
                + ani_energy_joules
                + dmi_energy_joules,
            max_effective_field_amplitude: max_norm(&effective_field),
            max_demag_field_amplitude: max_norm(&demag_field),
            max_rhs_amplitude: max_norm(&rhs),
            max_torque_Apm: max_cross_norm(magnetization, &effective_field),
        };

        (rhs, eval)
    }

    pub(crate) fn llg_rhs_from_field(&self, magnetization: Vector3, field: Vector3) -> Vector3 {
        let alpha = self.material.damping;
        let gamma_bar = self.dynamics.gyromagnetic_ratio / (1.0 + alpha * alpha);
        let precession = cross(magnetization, field);
        let damping = cross(magnetization, precession);
        let precession_term = if self.dynamics.precession_enabled {
            precession
        } else {
            [0.0, 0.0, 0.0]
        };
        scale(add(precession_term, scale(damping, alpha)), -gamma_bar)
    }

    pub(crate) fn llg_rhs_from_field_at(
        &self,
        i: usize,
        magnetization: Vector3,
        field: Vector3,
    ) -> Vector3 {
        let alpha = self.alpha_at(i);
        let gamma_bar = self.dynamics.gyromagnetic_ratio / (1.0 + alpha * alpha);
        let precession = cross(magnetization, field);
        let damping = cross(magnetization, precession);
        let precession_term = if self.dynamics.precession_enabled {
            precession
        } else {
            [0.0, 0.0, 0.0]
        };
        scale(add(precession_term, scale(damping, alpha)), -gamma_bar)
    }

    // ===================================================================
    // Energy calculations
    // ===================================================================

    pub fn exchange_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        let cell_volume = self.cell_size.volume();
        let grid = self.grid;
        let dx2 = self.cell_size.dx * self.cell_size.dx;
        let dy2 = self.cell_size.dy * self.cell_size.dy;
        let dz2 = self.cell_size.dz * self.cell_size.dz;

        let compute_cell_energy = |flat_index: usize| -> f64 {
            if !self.is_active(flat_index) {
                return 0.0;
            }
            let x = flat_index % grid.nx;
            let y = (flat_index / grid.nx) % grid.ny;
            let z = flat_index / (grid.nx * grid.ny);
            let center = magnetization[flat_index];
            let ai = self.a_at(flat_index);
            let mut e = 0.0;
            if x + 1 < grid.nx {
                let neighbor_index = grid.index(x + 1, y, z);
                if self.is_active(neighbor_index) {
                    let aj = self.a_at(neighbor_index);
                    let aij = if ai == 0.0 || aj == 0.0 {
                        0.0
                    } else {
                        2.0 * ai * aj / (ai + aj)
                    };
                    let neighbor = magnetization[neighbor_index];
                    e += aij * cell_volume * squared_norm(sub(neighbor, center)) / dx2;
                }
            }
            if y + 1 < grid.ny {
                let neighbor_index = grid.index(x, y + 1, z);
                if self.is_active(neighbor_index) {
                    let aj = self.a_at(neighbor_index);
                    let aij = if ai == 0.0 || aj == 0.0 {
                        0.0
                    } else {
                        2.0 * ai * aj / (ai + aj)
                    };
                    let neighbor = magnetization[neighbor_index];
                    e += aij * cell_volume * squared_norm(sub(neighbor, center)) / dy2;
                }
            }
            if z + 1 < grid.nz {
                let neighbor_index = grid.index(x, y, z + 1);
                if self.is_active(neighbor_index) {
                    let aj = self.a_at(neighbor_index);
                    let aij = if ai == 0.0 || aj == 0.0 {
                        0.0
                    } else {
                        2.0 * ai * aj / (ai + aj)
                    };
                    let neighbor = magnetization[neighbor_index];
                    e += aij * cell_volume * squared_norm(sub(neighbor, center)) / dz2;
                }
            }
            e
        };

        #[cfg(feature = "parallel")]
        {
            (0..grid.cell_count())
                .into_par_iter()
                .map(compute_cell_energy)
                .sum()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..grid.cell_count()).map(compute_cell_energy).sum()
        }
    }

    pub(crate) fn exchange_energy_from_field(
        &self,
        magnetization: &[Vector3],
        exchange_field: &[Vector3],
    ) -> f64 {
        let cell_volume = self.cell_size.volume();
        self.exchange_energy_density_from_field(magnetization, exchange_field)
            .into_iter()
            .map(|density| density * cell_volume)
            .sum()
    }

    pub fn exchange_energy_density_from_field(
        &self,
        magnetization: &[Vector3],
        exchange_field: &[Vector3],
    ) -> Vec<f64> {
        self.field_dot_energy_density(magnetization, exchange_field, -0.5)
    }

    pub(crate) fn demag_energy_from_fields(
        &self,
        magnetization: &[Vector3],
        demag_field: &[Vector3],
    ) -> f64 {
        let cell_volume = self.cell_size.volume();
        self.demag_energy_density_from_fields(magnetization, demag_field)
            .into_iter()
            .map(|density| density * cell_volume)
            .sum()
    }

    pub fn demag_energy_density_from_fields(
        &self,
        magnetization: &[Vector3],
        demag_field: &[Vector3],
    ) -> Vec<f64> {
        self.field_dot_energy_density(magnetization, demag_field, -0.5)
    }

    pub(crate) fn external_energy_from_fields(
        &self,
        magnetization: &[Vector3],
        external_field: &[Vector3],
    ) -> f64 {
        let cell_volume = self.cell_size.volume();
        self.external_energy_density_from_fields(magnetization, external_field)
            .into_iter()
            .map(|density| density * cell_volume)
            .sum()
    }

    pub fn external_energy_density_from_fields(
        &self,
        magnetization: &[Vector3],
        external_field: &[Vector3],
    ) -> Vec<f64> {
        self.field_dot_energy_density(magnetization, external_field, -1.0)
    }

    pub fn anisotropy_energy_density_from_vectors(&self, magnetization: &[Vector3]) -> Vec<f64> {
        let uni_data = self.terms.uniaxial_anisotropy.as_ref().map(|uni| {
            let n = norm(uni.axis).max(1e-30);
            (scale(uni.axis, 1.0 / n), uni.ku1, uni.ku2)
        });
        let cub_data = self.terms.cubic_anisotropy.as_ref().map(|cub| {
            let n1 = norm(cub.axis1).max(1e-30);
            let n2 = norm(cub.axis2).max(1e-30);
            let c1 = scale(cub.axis1, 1.0 / n1);
            let c2 = scale(cub.axis2, 1.0 / n2);
            (c1, c2, cross(c1, c2), cub.kc1, cub.kc2, cub.kc3)
        });

        magnetization
            .iter()
            .enumerate()
            .map(|(i, &m)| {
                self.is_active(i)
                    .then(|| anisotropy_energy_density_for_magnetization(m, uni_data, cub_data))
                    .unwrap_or(0.0)
            })
            .collect()
    }

    fn field_dot_energy_density(
        &self,
        magnetization: &[Vector3],
        field: &[Vector3],
        prefactor: f64,
    ) -> Vec<f64> {
        let compute = |i: usize| {
            if self.is_active(i) {
                let ms = self.ms_at(i);
                prefactor * MU0 * ms * dot(magnetization[i], field[i])
            } else {
                0.0
            }
        };
        #[cfg(feature = "parallel")]
        {
            (0..magnetization.len())
                .into_par_iter()
                .map(compute)
                .collect()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..magnetization.len()).map(compute).collect()
        }
    }
}

#[cfg(test)]
mod stt_tests {
    use super::*;
    use crate::{
        CellSize, CubicAnisotropyConfig, EffectiveFieldTerms, GridShape, LlgConfig,
        MaterialParameters, MU0,
    };

    fn check_close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "expected {expected:.17e}, got {actual:.17e}"
        );
    }

    fn one_cell_problem(damping: f64) -> ExchangeLlgProblem {
        ExchangeLlgProblem::new(
            GridShape::new(1, 1, 1).unwrap(),
            CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).unwrap(),
            MaterialParameters::new(800.0e3, 13.0e-12, damping).unwrap(),
            LlgConfig::default(),
        )
    }

    fn canonical_slonczewski_oracle(
        problem: &ExchangeLlgProblem,
        cfg: &SlonczewskiSttConfig,
        m: Vector3,
    ) -> Vector3 {
        const HBAR: f64 = 1.054571817e-34;
        const EXACT_E_CHARGE: f64 = 1.602176634e-19;

        let signed_current = cfg.current_sign * cfg.current_density_magnitude;
        let gamma_e = problem.dynamics.gyromagnetic_ratio / MU0;
        let omega = gamma_e * HBAR * signed_current
            / (EXACT_E_CHARGE
                * problem.material.saturation_magnetisation
                * cfg.thickness);
        let lambda_sq = cfg.lambda * cfg.lambda;
        let c = dot(m, cfg.spin_polarization_axis);
        let epsilon = cfg.degree * lambda_sq
            / ((lambda_sq + 1.0) + (lambda_sq - 1.0) * c);
        let cross_mp = cross(m, cfg.spin_polarization_axis);
        let double_cross = cross(m, cross_mp);
        let inv_gilbert = 1.0 / (1.0 + problem.material.damping.powi(2));
        let damping_like = omega
            * (epsilon + problem.material.damping * cfg.epsilon_prime)
            * inv_gilbert;
        let field_like = omega
            * (cfg.epsilon_prime - problem.material.damping * epsilon)
            * inv_gilbert;
        add(scale(double_cross, damping_like), scale(cross_mp, field_like))
    }

    #[test]
    fn canonical_slonczewski_matches_independent_signed_si_gilbert_oracle() {
        let problem = one_cell_problem(0.2);
        let cfg = SlonczewskiSttConfig {
            formula: crate::SlonczewskiFormula::FullmagV2,
            current_density_magnitude: 7.0e11,
            spin_polarization_axis: [0.0, 0.0, 1.0],
            lambda: 1.7,
            epsilon_prime: 0.13,
            degree: 0.6,
            thickness: 1.5e-9,
            current_sign: -1.0,
            active_mask: None,
        };
        let m = [0.6, 0.8, 0.0];
        let actual = problem.slonczewski_stt_torque(&[m], &cfg)[0];
        let expected = canonical_slonczewski_oracle(&problem, &cfg, m);

        for component in 0..3 {
            check_close(
                actual[component],
                expected[component],
                expected[component].abs() * 1.0e-13 + 1.0e-15,
            );
        }

        let mut reversed = cfg.clone();
        reversed.current_sign *= -1.0;
        let reversed_torque = problem.slonczewski_stt_torque(&[m], &reversed)[0];
        for component in 0..3 {
            check_close(reversed_torque[component], -actual[component], 1.0e-15);
        }
    }

    #[test]
    fn canonical_slonczewski_aos_soa_share_target_mask_and_oracle() {
        let problem = ExchangeLlgProblem::new(
            GridShape::new(2, 1, 1).unwrap(),
            CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).unwrap(),
            MaterialParameters::new(800.0e3, 13.0e-12, 0.2).unwrap(),
            LlgConfig::default(),
        );
        let cfg = SlonczewskiSttConfig {
            formula: crate::SlonczewskiFormula::FullmagV2,
            current_density_magnitude: 7.0e11,
            spin_polarization_axis: [0.0, 0.0, 1.0],
            lambda: 1.7,
            epsilon_prime: 0.13,
            degree: 0.6,
            thickness: 1.5e-9,
            current_sign: 1.0,
            active_mask: Some(vec![true, false]),
        };
        let magnetization = vec![[0.6, 0.8, 0.0]; 2];
        let mut aos_out = vec![[0.0; 3]; 2];
        problem.slonczewski_stt_torque_add_into(&magnetization, &cfg, &mut aos_out);

        let soa_m = VectorFieldSoA::from_aos(&magnetization);
        let mut soa_out = VectorFieldSoA::zeros(2);
        problem.slonczewski_stt_torque_add_into_soa(&soa_m, &cfg, &mut soa_out);
        let soa_out = soa_out.gather_to_aos();
        let expected = canonical_slonczewski_oracle(&problem, &cfg, magnetization[0]);

        for component in 0..3 {
            let tolerance = expected[component].abs() * 1.0e-13 + 1.0e-15;
            check_close(aos_out[0][component], expected[component], tolerance);
            check_close(soa_out[0][component], expected[component], tolerance);
        }
        assert_eq!(aos_out[1], [0.0; 3]);
        assert_eq!(soa_out[1], [0.0; 3]);
    }

    #[test]
    fn legacy_slonczewski_prefactor_is_bit_compatible() {
        const HBAR: f64 = 1.054571817e-34;
        const LEGACY_E_CHARGE: f64 = 1.60217662e-19;
        const MU0_CONST: f64 = 1.2566370614359173e-6;
        let current_sign = -1.0;
        let current_density_magnitude = 7.0e11;
        let gamma0 = 2.211e5;
        let saturation_magnetisation = 8.0e5;
        let thickness = 1.5e-9;
        let historical = current_sign * (current_density_magnitude * HBAR * gamma0)
            / (2.0
                * LEGACY_E_CHARGE
                * MU0_CONST
                * saturation_magnetisation
                * thickness);
        let versioned = slonczewski_prefactor(
            SlonczewskiFormula::LegacyFullmagV0,
            current_sign,
            current_density_magnitude,
            gamma0,
            saturation_magnetisation,
            thickness,
        );
        assert_eq!(versioned.to_bits(), historical.to_bits());
    }

    #[test]
    fn slonczewski_v2_lambda_one_has_standard_hbar_over_two_e_prefactor() {
        const HBAR: f64 = 1.054571817e-34;
        const EXACT_E_CHARGE: f64 = 1.602176634e-19;
        const MU0_CONST: f64 = 1.2566370614359173e-6;
        let current_sign = -1.0;
        let current_density_magnitude = 7.0e11;
        let gamma0 = 2.211e5;
        let saturation_magnetisation = 8.0e5;
        let thickness = 1.5e-9;
        let omega_v2 = slonczewski_prefactor(
            SlonczewskiFormula::FullmagV2,
            current_sign,
            current_density_magnitude,
            gamma0,
            saturation_magnetisation,
            thickness,
        );
        let standard = current_sign * (current_density_magnitude * HBAR * gamma0)
            / (2.0
                * EXACT_E_CHARGE
                * MU0_CONST
                * saturation_magnetisation
                * thickness);
        check_close(omega_v2 * 0.5, standard, standard.abs() * 1.0e-15);

        let omega_v1 = slonczewski_prefactor(
            SlonczewskiFormula::FullmagV1,
            current_sign,
            current_density_magnitude,
            gamma0,
            saturation_magnetisation,
            thickness,
        );
        check_close(omega_v1, standard, standard.abs() * 1.0e-15);
        check_close(omega_v2, 2.0 * omega_v1, standard.abs() * 1.0e-15);
    }

    #[test]
    fn oersted_envelope_is_evaluated_at_requested_stage_time_for_aos_and_soa() {
        let mut problem = one_cell_problem(0.1);
        problem.terms.exchange = false;
        problem.terms.demag = false;
        problem.terms.oersted_cylinder = Some(OerstedCylinderConfig {
            current: 2.0,
            radius: 0.25e-9,
            center: [0.0, 0.5e-9, 0.5e-9],
            axis: [0.0, 0.0, 1.0],
            time_dep_kind: 1,
            time_dep_freq: 1.0,
            time_dep_phase: 0.0,
            time_dep_offset: 0.0,
            time_dep_t_on: 0.0,
            time_dep_t_off: 0.0,
        });

        let mut aos_zero = vec![[0.0; 3]; 1];
        problem.oersted_field_add_into_at_time(&mut aos_zero, 0.0);
        assert_eq!(aos_zero, vec![[0.0; 3]; 1]);

        let mut aos_peak = vec![[0.0; 3]; 1];
        problem.oersted_field_add_into_at_time(&mut aos_peak, 0.25);
        assert!(aos_peak[0][1] > 0.0);

        let mut soa_peak = VectorFieldSoA::zeros(1);
        problem.oersted_field_add_into_soa_at_time(&mut soa_peak, 0.25);
        check_close(soa_peak.x[0], aos_peak[0][0], 1.0e-12);
        check_close(soa_peak.y[0], aos_peak[0][1], 1.0e-12);
        check_close(soa_peak.z[0], aos_peak[0][2], 1.0e-12);

        let cfg = problem.terms.oersted_cylinder.as_mut().unwrap();
        cfg.time_dep_kind = 2;
        cfg.time_dep_t_on = 2.0;
        cfg.time_dep_t_off = 3.0;
        let mut pulse_before = vec![[0.0; 3]; 1];
        problem.oersted_field_add_into_at_time(&mut pulse_before, 1.999);
        assert_eq!(pulse_before, vec![[0.0; 3]; 1]);
        let mut pulse_on = vec![[0.0; 3]; 1];
        problem.oersted_field_add_into_at_time(&mut pulse_on, 2.0);
        assert!(pulse_on[0][1] > 0.0);
        let mut pulse_off = vec![[0.0; 3]; 1];
        problem.oersted_field_add_into_at_time(&mut pulse_off, 3.0);
        assert_eq!(pulse_off, vec![[0.0; 3]; 1]);
    }

    #[test]
    fn kc3_only_cubic_anisotropy_matches_its_analytic_energy_and_field() {
        let kc3 = 4.2e4;
        let ms = 800.0e3;
        let problem = ExchangeLlgProblem::with_terms(
            GridShape::new(1, 1, 1).unwrap(),
            CellSize::new(1.0, 1.0, 1.0).unwrap(),
            MaterialParameters::new(ms, 13.0e-12, 0.02).unwrap(),
            LlgConfig::default(),
            EffectiveFieldTerms {
                exchange: false,
                demag: false,
                cubic_anisotropy: Some(CubicAnisotropyConfig {
                    kc1: 0.0,
                    kc2: 0.0,
                    kc3,
                    axis1: [1.0, 0.0, 0.0],
                    axis2: [0.0, 1.0, 0.0],
                }),
                ..Default::default()
            },
        );
        let component = 3.0_f64.sqrt().recip();
        let magnetization = [[component, component, component]];

        // sigma = 1/3 for <111>, hence e_Kc3 = Kc3 * sigma^2 = Kc3 / 9.
        check_close(
            problem.anisotropy_energy_density_from_vectors(&magnetization)[0],
            kc3 / 9.0,
            kc3.abs() * 1e-13,
        );
        // H_i = -8 Kc3/(9 sqrt(3) mu0 Ms) for the same cubic basis and state.
        let expected_field_component = -8.0 * kc3 * component / (9.0 * MU0 * ms);
        let field = problem.anisotropy_field(&magnetization);
        for actual in field[0] {
            check_close(
                actual,
                expected_field_component,
                expected_field_component.abs() * 1e-12,
            );
        }
    }

    #[test]
    fn brown_thermal_amplitude_uses_bare_gamma_mu0_not_gilbert_reduced_gamma() {
        let mut weak_damping = one_cell_problem(0.2);
        weak_damping.temperature = 300.0;
        weak_damping.thermal_dt = 2.5e-13;
        weak_damping.thermal_seed = 91;
        let mut strong_damping = one_cell_problem(0.5);
        strong_damping.temperature = weak_damping.temperature;
        strong_damping.thermal_dt = weak_damping.thermal_dt;
        strong_damping.thermal_seed = weak_damping.thermal_seed;

        let mut weak_field = [[0.0; 3]];
        let mut strong_field = [[0.0; 3]];
        weak_damping.thermal_field_add_into_step(&mut weak_field, 7);
        strong_damping.thermal_field_add_into_step(&mut strong_field, 7);

        let measured_ratio = strong_field[0][0] / weak_field[0][0];
        let expected_ratio = (0.5_f64 / 0.2_f64).sqrt();
        check_close(measured_ratio, expected_ratio, expected_ratio * 1e-12);
    }

    #[test]
    fn sot_macrospin_is_converted_to_rhs_with_gilbert_projection() {
        let problem = one_cell_problem(0.2);
        let cfg = SotConfig {
            formula: SotFormula::FullmagV1,
            current_density: 1.0e12,
            xi_dl: 0.35,
            xi_fl: 0.15,
            sigma: [0.0, 0.0, 1.0],
            thickness: 1.5e-9,
            active_mask: None,
            envelope: None,
        };
        let magnetization = [[1.0, 0.0, 0.0]];
        let actual = problem.sot_torque(&magnetization, &cfg)[0];

        const HBAR: f64 = 1.054571817e-34;
        const E_CHARGE: f64 = 1.602176634e-19;
        let field_amplitude = cfg.current_density * HBAR
            / (2.0 * E_CHARGE * MU0 * 800.0e3 * cfg.thickness);
        let alpha = problem.material.damping;
        let denominator = 1.0 + alpha * alpha;
        let omega_dl = field_amplitude * problem.dynamics.gyromagnetic_ratio * cfg.xi_dl;
        let omega_fl = field_amplitude * problem.dynamics.gyromagnetic_ratio * cfg.xi_fl;
        let expected = [
            0.0,
            -(omega_fl + alpha * omega_dl) / denominator,
            (omega_dl - alpha * omega_fl) / denominator,
        ];

        for component in 0..3 {
            check_close(
                actual[component],
                expected[component],
                expected[component].abs() * 1e-12,
            );
        }
    }

    #[test]
    fn slonczewski_direct_torque_matches_effective_field_form() {
        let problem = one_cell_problem(0.2);
        let cfg = SlonczewskiSttConfig {
            formula: SlonczewskiFormula::LegacyFullmagV0,
            current_density_magnitude: 1.0e12,
            spin_polarization_axis: [0.0, 0.0, 1.0],
            lambda: 1.0,
            epsilon_prime: 0.35,
            degree: 1.0,
            thickness: 1.0e-9,
            current_sign: 1.0,
            active_mask: None,
        };
        let m = [1.0, 0.0, 0.0];
        let torque = problem.slonczewski_stt_torque(&[m], &cfg);

        let beta_stt =
            cfg.current_density_magnitude * 1.054571817e-34 * problem.dynamics.gyromagnetic_ratio
                / (2.0
                    * 1.60217662e-19
                    * 1.2566370614359173e-6
                    * problem.material.saturation_magnetisation
                    * cfg.thickness)
                * 0.5;
        let m_cross_p = [0.0, -1.0, 0.0];
        let h_st = [
            -beta_stt * m_cross_p[0] / problem.dynamics.gyromagnetic_ratio,
            -beta_stt * m_cross_p[1] / problem.dynamics.gyromagnetic_ratio,
            -beta_stt * (m_cross_p[2] + cfg.epsilon_prime) / problem.dynamics.gyromagnetic_ratio,
        ];
        let expected = problem.llg_rhs_from_field(m, h_st);

        for component in 0..3 {
            check_close(
                torque[0][component],
                expected[component],
                expected[component].abs() * 1e-12,
            );
        }
    }

    #[test]
    fn direct_torque_changes_rhs_without_changing_field_equilibrium_residual() {
        let mut problem = one_cell_problem(0.2);
        problem.terms.exchange = false;
        problem.terms.demag = false;
        problem.terms.slonczewski_stt = Some(SlonczewskiSttConfig {
            formula: SlonczewskiFormula::LegacyFullmagV0,
            current_density_magnitude: 1.0e12,
            spin_polarization_axis: [0.0, 0.0, 1.0],
            lambda: 1.0,
            epsilon_prime: 0.35,
            degree: 1.0,
            thickness: 1.0e-9,
            current_sign: 1.0,
            active_mask: None,
        });
        let magnetization = [[1.0, 0.0, 0.0]];
        let mut workspace = problem.create_workspace();
        let mut effective_field = [[0.0; 3]];
        let mut scratch = [[0.0; 3]];
        let mut rhs = [[0.0; 3]];

        let observables = problem.compute_step_observables_zero_alloc(
            &magnetization,
            &mut workspace,
            &mut effective_field,
            &mut scratch,
            &mut rhs,
        );

        assert_eq!(observables.max_torque_Apm, 0.0);
        assert!(observables.max_rhs_amplitude > 0.0);
    }

    #[test]
    fn prescribed_sot_matches_signed_si_gilbert_source_oracle() {
        const HBAR: f64 = 1.054571817e-34;
        const EXACT_E_CHARGE: f64 = 1.602176634e-19;

        let problem = one_cell_problem(0.2);
        let cfg = SotConfig {
            formula: SotFormula::FullmagV1,
            current_density: -1.0e12,
            xi_dl: 0.12,
            xi_fl: -0.03,
            sigma: [0.0, 1.0, 0.0],
            thickness: 1.5e-9,
            active_mask: None,
            envelope: None,
        };
        let m = [1.0, 0.0, 0.0];
        let torque = problem.sot_torque(&[m], &cfg)[0];

        let gamma_e = problem.dynamics.gyromagnetic_ratio / MU0;
        let omega_base = gamma_e * HBAR * cfg.current_density
            / (2.0 * EXACT_E_CHARGE * problem.material.saturation_magnetisation * cfg.thickness);
        let omega_dl = omega_base * cfg.xi_dl;
        let omega_fl = omega_base * cfg.xi_fl;
        let alpha = problem.material.damping;
        let denominator = 1.0 + alpha * alpha;
        let expected = [
            0.0,
            (omega_dl - alpha * omega_fl) / denominator,
            (omega_fl + alpha * omega_dl) / denominator,
        ];

        for component in 0..3 {
            check_close(
                torque[component],
                expected[component],
                expected[component].abs() * 1.0e-12 + 1.0e-12,
            );
        }
    }

    #[test]
    fn prescribed_sot_reverses_with_signed_current() {
        let problem = one_cell_problem(0.1);
        let mut cfg = SotConfig {
            formula: SotFormula::FullmagV1,
            current_density: 7.0e11,
            xi_dl: 0.2,
            xi_fl: 0.05,
            sigma: [0.0, 1.0, 0.0],
            thickness: 1.0e-9,
            active_mask: None,
            envelope: None,
        };
        let positive = problem.sot_torque(&[[1.0, 0.0, 0.0]], &cfg)[0];
        cfg.current_density = -cfg.current_density;
        let negative = problem.sot_torque(&[[1.0, 0.0, 0.0]], &cfg)[0];

        for component in 0..3 {
            check_close(negative[component], -positive[component], 1.0e-12);
        }
    }

    #[test]
    fn prescribed_sot_applies_only_on_target_mask() {
        let problem = ExchangeLlgProblem::new(
            GridShape::new(2, 1, 1).unwrap(),
            CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).unwrap(),
            MaterialParameters::new(800.0e3, 13.0e-12, 0.1).unwrap(),
            LlgConfig::default(),
        );
        let cfg = SotConfig {
            formula: SotFormula::FullmagV1,
            current_density: 7.0e11,
            xi_dl: 0.2,
            xi_fl: 0.05,
            sigma: [0.0, 1.0, 0.0],
            thickness: 1.0e-9,
            active_mask: Some(vec![true, false]),
            envelope: None,
        };

        let torque = problem.sot_torque(&[[1.0, 0.0, 0.0]; 2], &cfg);
        assert!(torque[0].iter().any(|component| *component != 0.0));
        assert_eq!(torque[1], [0.0; 3]);
    }

    #[test]
    fn legacy_prescribed_sot_preserves_historical_abs_field_like_evaluator() {
        const HBAR: f64 = 1.054571817e-34;
        const LEGACY_E_CHARGE: f64 = 1.60217662e-19;

        let problem = one_cell_problem(0.2);
        let cfg = SotConfig {
            formula: SotFormula::LegacyFullmagV0,
            current_density: -1.0e12,
            xi_dl: 0.12,
            xi_fl: -0.03,
            sigma: [0.0, 1.0, 0.0],
            thickness: 1.5e-9,
            active_mask: None,
            envelope: None,
        };
        let torque = problem.sot_torque(&[[1.0, 0.0, 0.0]], &cfg)[0];
        let amplitude = cfg.current_density.abs() * HBAR
            / (2.0
                * LEGACY_E_CHARGE
                * MU0
                * problem.material.saturation_magnetisation
                * cfg.thickness);
        let expected = [0.0, amplitude * cfg.xi_dl, amplitude * cfg.xi_fl];
        for component in 0..3 {
            check_close(torque[component], expected[component], 1.0e-15);
        }
    }

    #[test]
    fn zhang_li_direct_torque_uses_gilbert_alpha_beta_projection() {
        let problem = ExchangeLlgProblem::new(
            GridShape::new(2, 1, 1).unwrap(),
            CellSize::new(1.0, 1.0, 1.0).unwrap(),
            MaterialParameters::new(800.0e3, 13.0e-12, 0.5).unwrap(),
            LlgConfig::default(),
        );
        let cfg = ZhangLiSttConfig {
            formula: ZhangLiFormula::LegacyFullmagV0,
            current_density: [1.0e12, 0.0, 0.0],
            spin_polarization: 1.0,
            non_adiabaticity: 0.2,
        };
        let m = vec![[1.0, 0.0, 0.0], [1.0, 0.0, 1.0]];
        let torque = problem.zhang_li_stt_torque(&m, &cfg);

        let u_x = cfg.spin_polarization * 9.274009994e-24 * cfg.current_density[0]
            / (1.60217662e-19
                * problem.material.saturation_magnetisation
                * (1.0 + cfg.non_adiabaticity * cfg.non_adiabaticity));
        let alpha = problem.material.damping;
        let inv_gilbert = 1.0 / (1.0 + alpha * alpha);
        let adiabatic = (1.0 + alpha * cfg.non_adiabaticity) * u_x * inv_gilbert;
        let cross_y = (cfg.non_adiabaticity - alpha) * u_x * inv_gilbert;

        check_close(torque[0][0], 0.0, 0.0);
        check_close(torque[0][1], 0.0, 0.0);
        check_close(torque[0][2], 0.0, 0.0);
        check_close(torque[1][0], -adiabatic, adiabatic.abs() * 1e-12);
        check_close(torque[1][1], cross_y, cross_y.abs() * 1e-12);
        check_close(torque[1][2], adiabatic, adiabatic.abs() * 1e-12);
    }

    #[test]
    fn mumax3_zhang_li_uses_central_clamped_stencil_and_source_prefactor() {
        let problem = ExchangeLlgProblem::new(
            GridShape::new(3, 1, 1).unwrap(),
            CellSize::new(2.0, 1.0, 1.0).unwrap(),
            MaterialParameters::new(800.0e3, 13.0e-12, 0.1).unwrap(),
            LlgConfig::default(),
        );
        let cfg = ZhangLiSttConfig {
            formula: ZhangLiFormula::Mumax3V1,
            current_density: [1.0e12, 0.0, 0.0],
            spin_polarization: 1.0,
            non_adiabaticity: 0.05,
        };
        let m = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let torque = problem.zhang_li_stt_torque(&m, &cfg);

        let b =
            1.0 * 9.2740091523e-24 / (2.0 * 1.60217646e-19 * 800.0e3 * (1.0 + 0.05_f64.powi(2)));
        let alpha = 0.1;
        let inv_gilbert = 1.0 / (1.0 + alpha * alpha);
        let expected_for = |flat: usize| {
            let xm = if flat == 0 { 0 } else { flat - 1 };
            let xp = if flat == 2 { 2 } else { flat + 1 };
            let v = [
                b * 1.0e12 * (m[xp][0] - m[xm][0]) / 2.0,
                b * 1.0e12 * (m[xp][1] - m[xm][1]) / 2.0,
                b * 1.0e12 * (m[xp][2] - m[xm][2]) / 2.0,
            ];
            let [m0, m1, m2] = m[flat];
            let c = [
                m1 * v[2] - m2 * v[1],
                m2 * v[0] - m0 * v[2],
                m0 * v[1] - m1 * v[0],
            ];
            let dc = [
                m1 * c[2] - m2 * c[1],
                m2 * c[0] - m0 * c[2],
                m0 * c[1] - m1 * c[0],
            ];
            [
                -(1.0 + 0.05 * alpha) * dc[0] * inv_gilbert + (alpha - 0.05) * c[0] * inv_gilbert,
                -(1.0 + 0.05 * alpha) * dc[1] * inv_gilbert + (alpha - 0.05) * c[1] * inv_gilbert,
                -(1.0 + 0.05 * alpha) * dc[2] * inv_gilbert + (alpha - 0.05) * c[2] * inv_gilbert,
            ]
        };

        for flat in 0..3 {
            let expected = expected_for(flat);
            for component in 0..3 {
                let scale = expected[component].abs().max(1.0);
                assert!((torque[flat][component] - expected[component]).abs() < 1e-12 * scale);
            }
        }
        assert!(torque[0].iter().any(|value| value.abs() > 0.0));

        let mut aos_add = vec![[0.0; 3]; 3];
        problem.zhang_li_stt_torque_add_into(&m, &cfg, &mut aos_add);
        let soa_m = VectorFieldSoA::from_aos(&m);
        let mut soa_add = VectorFieldSoA::zeros(3);
        problem.zhang_li_stt_torque_add_into_soa(&soa_m, &cfg, &mut soa_add);
        let soa_add = soa_add.gather_to_aos();
        assert_eq!(aos_add, torque);
        assert_eq!(soa_add, torque);
    }

    #[test]
    fn observable_demag_field_preserves_stray_field_in_inactive_cells() {
        let problem = ExchangeLlgProblem::with_terms_and_mask(
            GridShape::new(2, 1, 1).unwrap(),
            CellSize::new(1.0e-9, 1.0e-9, 1.0e-9).unwrap(),
            MaterialParameters::new(800.0e3, 13.0e-12, 0.1).unwrap(),
            LlgConfig::default(),
            EffectiveFieldTerms {
                demag: true,
                ..Default::default()
            },
            Some(vec![true, false]),
        )
        .expect("masked FDM problem should build");
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0], [0.0, 0.0, 0.0]])
            .expect("state should build");

        let solver_field = problem
            .demag_field(&state)
            .expect("solver demag should build");
        let observable_field = problem
            .observable_demag_field(&state)
            .expect("observable demag should build");

        assert_eq!(observable_field[0], solver_field[0]);
        assert_eq!(solver_field[1], [0.0; 3]);
        assert!(
            observable_field[1]
                .iter()
                .any(|component| component.abs() > 0.0),
            "airbox cell should retain the physical stray field for H_demag visualization"
        );
        let masked_energy = problem.demag_energy_from_fields(state.magnetization(), &solver_field);
        let observable_energy =
            problem.demag_energy_from_fields(state.magnetization(), &observable_field);
        assert_eq!(observable_energy, masked_energy);
    }
}
