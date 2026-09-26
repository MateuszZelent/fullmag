//! FDM reference energy calculations for `ExchangeLlgProblem`.

use super::anisotropy_energy_density_for_magnetization;
use crate::fdm::shared::VectorFieldSoA;
use crate::vector::{cross, dot, norm, scale, squared_norm, sub};
use crate::{ExchangeLlgProblem, FftWorkspace, Vector3, MU0};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

impl ExchangeLlgProblem {
    // Total-energy ownership stays together while the field and RHS modules are split.
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
}

impl ExchangeLlgProblem {
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
