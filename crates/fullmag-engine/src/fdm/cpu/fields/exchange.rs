//! Exchange-field realization for the FDM CPU reference lane.

use super::{
    scale, sub, ExchangeLlgProblem, Vector3, VectorFieldSoA, MU0,
};
use crate::fdm::shared::types::{neighbor_index, AxisBoundary};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

impl ExchangeLlgProblem {
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
}
