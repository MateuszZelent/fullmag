//! Uniaxial and cubic anisotropy realization for the FDM CPU reference lane.

use super::{
    add, anisotropy_energy_density_for_magnetization, cross, dot, norm, scale, zero_vectors,
    ExchangeLlgProblem, Vector3, VectorFieldSoA, MU0,
};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

impl ExchangeLlgProblem {
    /// Return the uniaxial and cubic contributions separately.  The solver
    /// uses their sum, while field materialization needs the canonical
    /// quantity split (`H_ani` versus `H_ani_cubic`).
    pub fn anisotropy_field_components(
        &self,
        magnetization: &[Vector3],
    ) -> (Vec<Vector3>, Vec<Vector3>) {
        let mut uniaxial = zero_vectors(self.grid.cell_count());
        let mut cubic = zero_vectors(self.grid.cell_count());
        if self.terms.uniaxial_anisotropy.is_none() && self.terms.cubic_anisotropy.is_none() {
            return (uniaxial, cubic);
        }
        for (i, m) in magnetization.iter().enumerate() {
            if !self.is_active(i) {
                continue;
            }
            let ms_safe = self.ms_at(i).max(1e-30);
            if let Some(ref uni) = self.terms.uniaxial_anisotropy {
                let n = norm(uni.axis).max(1e-30);
                let u = scale(uni.axis, 1.0 / n);
                let m_dot_u = dot(*m, u);
                let coeff = 2.0 * uni.ku1 / (MU0 * ms_safe) * m_dot_u
                    + 4.0 * uni.ku2 / (MU0 * ms_safe) * m_dot_u * m_dot_u * m_dot_u;
                uniaxial[i] = scale(u, coeff);
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
                cubic[i] = add(add(scale(c1, g1), scale(c2, g2)), scale(c3, g3));
            }
        }
        (uniaxial, cubic)
    }

    pub fn anisotropy_field(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let (uniaxial, cubic) = self.anisotropy_field_components(magnetization);
        uniaxial
            .into_iter()
            .zip(cubic)
            .map(|(uniaxial, cubic)| add(uniaxial, cubic))
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
}
