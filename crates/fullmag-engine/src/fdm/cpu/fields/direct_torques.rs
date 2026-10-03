//! Direct STT/SOT realization for the FDM CPU reference lane.

use super::{
    add, cross, dot, scale, ExchangeLlgProblem, SlonczewskiFormula,
    SlonczewskiSttConfig, SotConfig, SotFormula, Vector3, VectorFieldSoA, ZhangLiFormula,
    ZhangLiSttConfig, MU0,
};
use crate::fdm::shared::types::{neighbor_index, AxisBoundary};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

pub(super) fn slonczewski_prefactor(
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
        / (omega_denominator_factor * charge * MU0_CONST * saturation_magnetisation * thickness)
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
    let epsilon =
        (degree * lambda_squared) / ((lambda_squared + 1.0) + (lambda_squared - 1.0) * m_dot_p);
    let (damping_like, field_like) =
        gilbert_slonczewski_scales(cfg.formula, prefactor, epsilon, cfg.epsilon_prime, alpha);
    let m_cross_p = cross(magnetization, [px, py, pz]);
    let m_cross_m_cross_p = cross(magnetization, m_cross_p);
    add(
        scale(m_cross_m_cross_p, damping_like),
        scale(m_cross_p, field_like),
    )
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

        let ms = self.ms_at(flat).max(1e-30);
        let beta = cfg.non_adiabaticity;
        let alpha = self.alpha_at(flat);
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

        let beta = cfg.non_adiabaticity;

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
                let ms = self.ms_at(flat).max(1e-30);
                let alpha = self.alpha_at(flat);
                let (adiabatic_scale, cross_scale) = gilbert_zhang_li_scales(beta, alpha);
                let b = (cfg.spin_polarization * MU_B) / (E_CHARGE * ms * (1.0 + beta * beta));
                let ux = b * cfg.current_density[0];
                let uy = b * cfg.current_density[1];
                let uz = b * cfg.current_density[2];
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
                    self.alpha_at(flat),
                    self.dynamics.gyromagnetic_ratio,
                    self.ms_at(flat),
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
                    self.ms_at(flat),
                    self.dynamics.gyromagnetic_ratio,
                    self.alpha_at(flat),
                )
            })
            .collect()
    }

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

        let beta = cfg.non_adiabaticity;

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
            let ms = self.ms_at(flat).max(1e-30);
            let alpha = self.alpha_at(flat);
            let (adiabatic_scale, cross_scale) = gilbert_zhang_li_scales(beta, alpha);
            let b = (cfg.spin_polarization * MU_B) / (E_CHARGE * ms * (1.0 + beta * beta));
            let ux = b * cfg.current_density[0];
            let uy = b * cfg.current_density[1];
            let uz = b * cfg.current_density[2];
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

        let beta = cfg.non_adiabaticity;

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
            let ms = self.ms_at(flat).max(1e-30);
            let alpha = self.alpha_at(flat);
            let (adiabatic_scale, cross_scale) = gilbert_zhang_li_scales(beta, alpha);
            let b = (cfg.spin_polarization * MU_B) / (E_CHARGE * ms * (1.0 + beta * beta));
            let ux = b * cfg.current_density[0];
            let uy = b * cfg.current_density[1];
            let uz = b * cfg.current_density[2];
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
                self.alpha_at(flat),
                self.dynamics.gyromagnetic_ratio,
                self.ms_at(flat),
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
                self.alpha_at(flat),
                self.dynamics.gyromagnetic_ratio,
                self.ms_at(flat),
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
                self.ms_at(flat),
                self.dynamics.gyromagnetic_ratio,
                self.alpha_at(flat),
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
                [
                    magnetization.x[flat],
                    magnetization.y[flat],
                    magnetization.z[flat],
                ],
                cfg,
                self.ms_at(flat),
                self.dynamics.gyromagnetic_ratio,
                self.alpha_at(flat),
            );
            out.x[flat] += torque[0];
            out.y[flat] += torque[1];
            out.z[flat] += torque[2];
        }
    }
}
