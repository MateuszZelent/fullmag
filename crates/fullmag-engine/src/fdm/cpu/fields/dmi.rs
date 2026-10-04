//! DMI energy and field realizations for the FDM CPU reference lane.

use super::{zero_vectors, ExchangeLlgProblem, Vector3, VectorFieldSoA, MU0};
use crate::fdm::shared::types::{neighbor_index, AxisBoundary};

#[cfg(feature = "parallel")]
use rayon::prelude::*;

impl ExchangeLlgProblem {
    pub(crate) fn dmi_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        self.dmi_energy_with(|flat| magnetization[flat])
    }

    pub fn rotated_interfacial_dmi_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        let Some(rotated) = self
            .terms
            .rotated_interfacial_dmi
            .filter(|coefficient| coefficient.abs() > 0.0)
        else {
            return 0.0;
        };
        self.dmi_energy_with_coefficients(|flat| magnetization[flat], 0.0, rotated, 0.0)
    }

    pub fn dmi_energy_density_from_vectors(&self, magnetization: &[Vector3]) -> Vec<f64> {
        self.dmi_energy_density_with_coefficients(
            magnetization,
            self.terms.interfacial_dmi.unwrap_or(0.0),
            self.terms.rotated_interfacial_dmi.unwrap_or(0.0),
            self.terms.bulk_dmi.unwrap_or(0.0),
        )
    }

    pub fn rotated_interfacial_dmi_energy_density_from_vectors(
        &self,
        magnetization: &[Vector3],
    ) -> Vec<f64> {
        let Some(rotated) = self
            .terms
            .rotated_interfacial_dmi
            .filter(|coefficient| coefficient.abs() > 0.0)
        else {
            return vec![0.0; self.grid.cell_count()];
        };
        self.dmi_energy_density_with_coefficients(magnetization, 0.0, rotated, 0.0)
    }

    fn dmi_energy_density_with_coefficients(
        &self,
        magnetization: &[Vector3],
        interfacial: f64,
        rotated: f64,
        bulk: f64,
    ) -> Vec<f64> {
        if interfacial == 0.0 && rotated == 0.0 && bulk == 0.0 {
            return vec![0.0; self.grid.cell_count()];
        }

        let cell_volume = self.cell_size.volume();
        let compute = |flat: usize| {
            if self.is_active(flat) {
                self.dmi_cell_face_energy_with_coefficients(
                    &|index| magnetization[index],
                    flat,
                    interfacial,
                    rotated,
                    bulk,
                ) / cell_volume
            } else {
                0.0
            }
        };

        #[cfg(feature = "parallel")]
        {
            (0..self.grid.cell_count())
                .into_par_iter()
                .map(compute)
                .collect()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..self.grid.cell_count()).map(compute).collect()
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
        let rotated_interfacial_dmi = match self.terms.rotated_interfacial_dmi {
            Some(d) if d.abs() > 0.0 => Some(d),
            _ => None,
        };
        if interfacial_dmi.is_none() && rotated_interfacial_dmi.is_none() && bulk_dmi.is_none() {
            return 0.0;
        }

        self.dmi_energy_with(|flat| {
            [
                magnetization.x[flat],
                magnetization.y[flat],
                magnetization.z[flat],
            ]
        })
    }

    fn dmi_energy_with<F>(&self, value: F) -> f64
    where
        F: Fn(usize) -> Vector3 + Sync,
    {
        self.dmi_energy_with_coefficients(
            value,
            self.terms.interfacial_dmi.unwrap_or(0.0),
            self.terms.rotated_interfacial_dmi.unwrap_or(0.0),
            self.terms.bulk_dmi.unwrap_or(0.0),
        )
    }

    fn dmi_energy_with_coefficients<F>(
        &self,
        value: F,
        interfacial: f64,
        rotated: f64,
        bulk: f64,
    ) -> f64
    where
        F: Fn(usize) -> Vector3 + Sync,
    {
        #[cfg(feature = "parallel")]
        {
            (0..self.grid.cell_count())
                .into_par_iter()
                .filter(|&flat| self.is_active(flat))
                .map(|flat| {
                    self.dmi_cell_face_energy_with_coefficients(
                        &value,
                        flat,
                        interfacial,
                        rotated,
                        bulk,
                    )
                })
                .sum()
        }
        #[cfg(not(feature = "parallel"))]
        {
            (0..self.grid.cell_count())
                .filter(|&flat| self.is_active(flat))
                .map(|flat| {
                    self.dmi_cell_face_energy_with_coefficients(
                        &value,
                        flat,
                        interfacial,
                        rotated,
                        bulk,
                    )
                })
                .sum()
        }
    }

    fn dmi_cell_face_energy_with_coefficients<F>(
        &self,
        value: &F,
        flat: usize,
        interfacial: f64,
        rotated: f64,
        bulk: f64,
    ) -> f64
    where
        F: Fn(usize) -> Vector3,
    {
        let x = flat % self.grid.nx;
        let y = (flat / self.grid.nx) % self.grid.ny;
        let z = flat / (self.grid.nx * self.grid.ny);
        let px = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let py = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let pz = matches!(self.boundary_policy.z, AxisBoundary::Periodic);
        let sx = self.cell_size.dy * self.cell_size.dz;
        let sy = self.cell_size.dx * self.cell_size.dz;
        let sz = self.cell_size.dx * self.cell_size.dy;
        let mut energy = 0.0;

        if px || x + 1 < self.grid.nx {
            let neighbor = self
                .grid
                .index(neighbor_index(x, self.grid.nx, 1, px), y, z);
            if self.is_active(neighbor) {
                energy += 0.5
                    * Self::dmi_face_energy_with_coefficients(
                        value(flat),
                        value(neighbor),
                        0,
                        sx,
                        interfacial,
                        rotated,
                        bulk,
                    );
            }
        }
        if px || x > 0 {
            let neighbor = self
                .grid
                .index(neighbor_index(x, self.grid.nx, -1, px), y, z);
            if self.is_active(neighbor) {
                energy += 0.5
                    * Self::dmi_face_energy_with_coefficients(
                        value(neighbor),
                        value(flat),
                        0,
                        sx,
                        interfacial,
                        rotated,
                        bulk,
                    );
            }
        }
        if py || y + 1 < self.grid.ny {
            let neighbor = self
                .grid
                .index(x, neighbor_index(y, self.grid.ny, 1, py), z);
            if self.is_active(neighbor) {
                energy += 0.5
                    * Self::dmi_face_energy_with_coefficients(
                        value(flat),
                        value(neighbor),
                        1,
                        sy,
                        interfacial,
                        rotated,
                        bulk,
                    );
            }
        }
        if py || y > 0 {
            let neighbor = self
                .grid
                .index(x, neighbor_index(y, self.grid.ny, -1, py), z);
            if self.is_active(neighbor) {
                energy += 0.5
                    * Self::dmi_face_energy_with_coefficients(
                        value(neighbor),
                        value(flat),
                        1,
                        sy,
                        interfacial,
                        rotated,
                        bulk,
                    );
            }
        }
        if pz || z + 1 < self.grid.nz {
            let neighbor = self
                .grid
                .index(x, y, neighbor_index(z, self.grid.nz, 1, pz));
            if self.is_active(neighbor) {
                energy += 0.5
                    * Self::dmi_face_energy_with_coefficients(
                        value(flat),
                        value(neighbor),
                        2,
                        sz,
                        interfacial,
                        rotated,
                        bulk,
                    );
            }
        }
        if pz || z > 0 {
            let neighbor = self
                .grid
                .index(x, y, neighbor_index(z, self.grid.nz, -1, pz));
            if self.is_active(neighbor) {
                energy += 0.5
                    * Self::dmi_face_energy_with_coefficients(
                        value(neighbor),
                        value(flat),
                        2,
                        sz,
                        interfacial,
                        rotated,
                        bulk,
                    );
            }
        }
        energy
    }

    fn dmi_face_energy_with_coefficients(
        left: Vector3,
        right: Vector3,
        axis: usize,
        surface: f64,
        interfacial: f64,
        rotated: f64,
        bulk: f64,
    ) -> f64 {
        let average = [
            0.5 * (left[0] + right[0]),
            0.5 * (left[1] + right[1]),
            0.5 * (left[2] + right[2]),
        ];
        let jump = [right[0] - left[0], right[1] - left[1], right[2] - left[2]];
        let density_integral = match axis {
            0 => {
                interfacial * (average[2] * jump[0] - average[0] * jump[2])
                    + rotated * (average[2] * jump[0] - average[0] * jump[2])
                    + bulk * (average[2] * jump[1] - average[1] * jump[2])
            }
            1 => {
                interfacial * (average[2] * jump[1] - average[1] * jump[2])
                    + rotated * (average[0] * jump[1] - average[1] * jump[0])
                    + bulk * (average[0] * jump[2] - average[2] * jump[0])
            }
            2 => bulk * (average[1] * jump[0] - average[0] * jump[1]),
            _ => unreachable!("DMI face axis must be x, y, or z"),
        };
        surface * density_integral
    }

    fn dmi_boundary_faces(&self, flat: usize) -> [bool; 6] {
        let x = flat % self.grid.nx;
        let y = (flat / self.grid.nx) % self.grid.ny;
        let z = flat / (self.grid.nx * self.grid.ny);
        let px = matches!(self.boundary_policy.x, AxisBoundary::Periodic);
        let py = matches!(self.boundary_policy.y, AxisBoundary::Periodic);
        let pz = matches!(self.boundary_policy.z, AxisBoundary::Periodic);
        let xp = self
            .grid
            .index(neighbor_index(x, self.grid.nx, 1, px), y, z);
        let xm = self
            .grid
            .index(neighbor_index(x, self.grid.nx, -1, px), y, z);
        let yp = self
            .grid
            .index(x, neighbor_index(y, self.grid.ny, 1, py), z);
        let ym = self
            .grid
            .index(x, neighbor_index(y, self.grid.ny, -1, py), z);
        let zp = self
            .grid
            .index(x, y, neighbor_index(z, self.grid.nz, 1, pz));
        let zm = self
            .grid
            .index(x, y, neighbor_index(z, self.grid.nz, -1, pz));
        [
            (!px && x + 1 == self.grid.nx) || !self.is_active(xp),
            (!px && x == 0) || !self.is_active(xm),
            (!py && y + 1 == self.grid.ny) || !self.is_active(yp),
            (!py && y == 0) || !self.is_active(ym),
            (!pz && z + 1 == self.grid.nz) || !self.is_active(zp),
            (!pz && z == 0) || !self.is_active(zm),
        ]
    }

    fn interfacial_dmi_boundary_correction(
        &self,
        flat: usize,
        magnetization: Vector3,
        d: f64,
        ms: f64,
    ) -> Vector3 {
        let [xp, xm, yp, ym, _, _] = self.dmi_boundary_faces(flat);
        let qx = d / (MU0 * ms.max(1e-30) * self.cell_size.dx);
        let qy = d / (MU0 * ms.max(1e-30) * self.cell_size.dy);
        let mut correction = [0.0, 0.0, 0.0];
        if xp {
            correction[0] -= qx * magnetization[2];
            correction[2] += qx * magnetization[0];
        }
        if xm {
            correction[0] += qx * magnetization[2];
            correction[2] -= qx * magnetization[0];
        }
        if yp {
            correction[1] -= qy * magnetization[2];
            correction[2] += qy * magnetization[1];
        }
        if ym {
            correction[1] += qy * magnetization[2];
            correction[2] -= qy * magnetization[1];
        }
        correction
    }

    fn rotated_interfacial_dmi_boundary_correction(
        &self,
        flat: usize,
        magnetization: Vector3,
        d: f64,
        ms: f64,
    ) -> Vector3 {
        let [xp, xm, yp, ym, _, _] = self.dmi_boundary_faces(flat);
        let qx = d / (MU0 * ms.max(1e-30) * self.cell_size.dx);
        let qy = d / (MU0 * ms.max(1e-30) * self.cell_size.dy);
        let mut correction = [0.0, 0.0, 0.0];
        if xp {
            correction[0] -= qx * magnetization[2];
            correction[2] += qx * magnetization[0];
        }
        if xm {
            correction[0] += qx * magnetization[2];
            correction[2] -= qx * magnetization[0];
        }
        if yp {
            correction[0] += qy * magnetization[1];
            correction[1] -= qy * magnetization[0];
        }
        if ym {
            correction[0] -= qy * magnetization[1];
            correction[1] += qy * magnetization[0];
        }
        correction
    }

    fn bulk_dmi_boundary_correction(
        &self,
        flat: usize,
        magnetization: Vector3,
        d: f64,
        ms: f64,
    ) -> Vector3 {
        let [xp, xm, yp, ym, zp, zm] = self.dmi_boundary_faces(flat);
        let factor = 1.0 / (MU0 * ms.max(1e-30));
        let qx = d * factor / self.cell_size.dx;
        let qy = d * factor / self.cell_size.dy;
        let qz = d * factor / self.cell_size.dz;
        let mut correction = [0.0, 0.0, 0.0];
        if xp {
            correction[1] -= qx * magnetization[2];
            correction[2] += qx * magnetization[1];
        }
        if xm {
            correction[1] += qx * magnetization[2];
            correction[2] -= qx * magnetization[1];
        }
        if yp {
            correction[0] += qy * magnetization[2];
            correction[2] -= qy * magnetization[0];
        }
        if ym {
            correction[0] -= qy * magnetization[2];
            correction[2] += qy * magnetization[0];
        }
        if zp {
            correction[0] -= qz * magnetization[1];
            correction[1] += qz * magnetization[0];
        }
        if zm {
            correction[0] += qz * magnetization[1];
            correction[1] -= qz * magnetization[0];
        }
        correction
    }

    pub fn interfacial_dmi_field(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
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

                let boundary = self.interfacial_dmi_boundary_correction(flat, center, d, ms);
                [
                    pf * dx_mz + boundary[0],
                    pf * dy_mz + boundary[1],
                    -pf * (dx_mx + dy_my) + boundary[2],
                ]
            })
            .collect()
    }

    pub fn rotated_interfacial_dmi_field(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let d = match self.terms.rotated_interfacial_dmi {
            Some(d) if d.abs() > 0.0 => d,
            _ => return zero_vectors(self.grid.cell_count()),
        };
        let nx = self.grid.nx;
        let ny = self.grid.ny;
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
                let dy_my = (yp[1] - ym[1]) / (2.0 * dy);
                let dy_mx = (yp[0] - ym[0]) / (2.0 * dy);
                let dx_mx = (xp[0] - xm[0]) / (2.0 * dx);
                let boundary =
                    self.rotated_interfacial_dmi_boundary_correction(flat, center, d, ms);

                [
                    pf * (dx_mz - dy_my) + boundary[0],
                    pf * dy_mx + boundary[1],
                    -pf * dx_mx + boundary[2],
                ]
            })
            .collect()
    }

    pub fn bulk_dmi_field(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
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

                let boundary = self.bulk_dmi_boundary_correction(flat, center, d, ms);
                [
                    pf * curl_x + boundary[0],
                    pf * curl_y + boundary[1],
                    pf * curl_z + boundary[2],
                ]
            })
            .collect()
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

            let boundary = self.interfacial_dmi_boundary_correction(
                flat,
                [
                    magnetization.x[flat],
                    magnetization.y[flat],
                    magnetization.z[flat],
                ],
                d,
                ms,
            );
            h_eff.x[flat] += pf * dx_mz;
            h_eff.y[flat] += pf * dy_mz;
            h_eff.z[flat] += -pf * (dx_mx + dy_my);
            h_eff.x[flat] += boundary[0];
            h_eff.y[flat] += boundary[1];
            h_eff.z[flat] += boundary[2];
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

            let boundary = self.bulk_dmi_boundary_correction(
                flat,
                [
                    magnetization.x[flat],
                    magnetization.y[flat],
                    magnetization.z[flat],
                ],
                d,
                ms,
            );
            h_eff.x[flat] += pf * curl_x;
            h_eff.y[flat] += pf * curl_y;
            h_eff.z[flat] += pf * curl_z;
            h_eff.x[flat] += boundary[0];
            h_eff.y[flat] += boundary[1];
            h_eff.z[flat] += boundary[2];
        }
    }

    pub(crate) fn rotated_interfacial_dmi_field_add_into_soa(
        &self,
        magnetization: &VectorFieldSoA,
        h_eff: &mut VectorFieldSoA,
    ) {
        let d = match self.terms.rotated_interfacial_dmi {
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

        for flat in 0..grid.cell_count() {
            if !self.is_active(flat) {
                continue;
            }
            let ms = self.ms_at(flat).max(1e-30);
            let pf = 2.0 * d / (MU0 * ms);
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
            let dy_my = (magnetization.y[yp] - magnetization.y[ym]) / (2.0 * dy);
            let dy_mx = (magnetization.x[yp] - magnetization.x[ym]) / (2.0 * dy);
            let dx_mx = (magnetization.x[xp] - magnetization.x[xm]) / (2.0 * dx);
            let boundary = self.rotated_interfacial_dmi_boundary_correction(
                flat,
                [
                    magnetization.x[flat],
                    magnetization.y[flat],
                    magnetization.z[flat],
                ],
                d,
                ms,
            );

            h_eff.x[flat] += pf * (dx_mz - dy_my) + boundary[0];
            h_eff.y[flat] += pf * dy_mx + boundary[1];
            h_eff.z[flat] += -pf * dx_mx + boundary[2];
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

            let boundary = self.interfacial_dmi_boundary_correction(flat, center, d, ms);
            h[0] += pf * dx_mz;
            h[1] += pf * dy_mz;
            h[2] += -pf * (dx_mx + dy_my);
            h[0] += boundary[0];
            h[1] += boundary[1];
            h[2] += boundary[2];
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

            let boundary = self.bulk_dmi_boundary_correction(flat, center, d, ms);
            h[0] += pf * curl_x;
            h[1] += pf * curl_y;
            h[2] += pf * curl_z;
            h[0] += boundary[0];
            h[1] += boundary[1];
            h[2] += boundary[2];
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

    pub(crate) fn rotated_interfacial_dmi_field_add_into(
        &self,
        magnetization: &[Vector3],
        h_eff: &mut [Vector3],
    ) {
        let d = match self.terms.rotated_interfacial_dmi {
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
            let dy_my = (yp[1] - ym[1]) / (2.0 * dy);
            let dy_mx = (yp[0] - ym[0]) / (2.0 * dy);
            let dx_mx = (xp[0] - xm[0]) / (2.0 * dx);
            let boundary = self.rotated_interfacial_dmi_boundary_correction(flat, center, d, ms);

            h[0] += pf * (dx_mz - dy_my) + boundary[0];
            h[1] += pf * dy_mx + boundary[1];
            h[2] += -pf * dx_mx + boundary[2];
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
}
