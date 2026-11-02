//! Exchange-field realization for the FDM CPU reference lane.

use super::{
    scale, sub, ExchangeLlgProblem, Vector3, VectorFieldSoA, MU0,
};
use crate::fdm::cpu::soa_par::soa_for_each_row_mut;
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
        let ms_i = self.ms_at(flat_index);
        if let Some(faces) = self.exchange_faces.as_deref() {
            return self.cell_exchange_field_from_faces(
                faces,
                flat_index,
                magnetization,
                [x, y, z],
                [px, py, pz],
                [dx2, dy2, dz2],
                ms_i,
            );
        }
        let ai = self.a_at(flat_index);

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

    /// `H_i = 2/(mu0 Ms_i) sum_f A_f (m_j - m_i)/h_f^2` with the `-axis`
    /// coefficient read from the lower neighbour's `+axis` entry.
    #[allow(clippy::too_many_arguments)]
    fn cell_exchange_field_from_faces(
        &self,
        faces: &crate::ExchangeFaces,
        flat_index: usize,
        magnetization: &[Vector3],
        coords: [usize; 3],
        periodic: [bool; 3],
        dist2: [f64; 3],
        ms_i: f64,
    ) -> Vector3 {
        let grid = self.grid;
        let dims = [grid.nx, grid.ny, grid.nz];
        let center = magnetization[flat_index];
        let mut sum = [0.0, 0.0, 0.0];
        for (axis, plus_faces) in [&faces.x_plus, &faces.y_plus, &faces.z_plus]
            .into_iter()
            .enumerate()
        {
            for delta in [-1, 1] {
                let mut neighbor = coords;
                neighbor[axis] = neighbor_index(coords[axis], dims[axis], delta, periodic[axis]);
                let neighbor_flat = grid.index(neighbor[0], neighbor[1], neighbor[2]);
                if neighbor_flat == flat_index {
                    continue;
                }
                let a_f = if delta > 0 {
                    plus_faces[flat_index]
                } else {
                    plus_faces[neighbor_flat]
                };
                if a_f == 0.0 {
                    continue;
                }
                let weight = a_f / dist2[axis];
                let diff = sub(magnetization[neighbor_flat], center);
                sum[0] += weight * diff[0];
                sum[1] += weight * diff[1];
                sum[2] += weight * diff[2];
            }
        }
        scale(sum, 2.0 / (MU0 * ms_i))
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

        // Rows run along x, so (y, z) and the neighbouring rows' offsets are
        // derived once per row; the per-cell arithmetic is unchanged.
        soa_for_each_row_mut(h_eff, grid.nx, |row, hx, hy, hz| {
            let y = row % grid.ny;
            let z = row / grid.ny;
            let row_start = row * grid.nx;
            let y_minus_start = grid.index(0, neighbor_index(y, grid.ny, -1, py), z);
            let y_plus_start = grid.index(0, neighbor_index(y, grid.ny, 1, py), z);
            let z_minus_start = grid.index(0, y, neighbor_index(z, grid.nz, -1, pz));
            let z_plus_start = grid.index(0, y, neighbor_index(z, grid.nz, 1, pz));
            for x in 0..grid.nx {
                let flat_index = row_start + x;
                if !self.is_active(flat_index) {
                    continue;
                }
                let center_x = magnetization.x[flat_index];
                let center_y = magnetization.y[flat_index];
                let center_z = magnetization.z[flat_index];
                let sample = |ni: usize| -> Vector3 {
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

                let x_minus = sample(row_start + neighbor_index(x, grid.nx, -1, px));
                let x_plus = sample(row_start + neighbor_index(x, grid.nx, 1, px));
                let y_minus = sample(y_minus_start + x);
                let y_plus = sample(y_plus_start + x);
                let z_minus = sample(z_minus_start + x);
                let z_plus = sample(z_plus_start + x);

                hx[x] += prefactor
                    * ((x_plus[0] - 2.0 * center_x + x_minus[0]) / dx2
                        + (y_plus[0] - 2.0 * center_x + y_minus[0]) / dy2
                        + (z_plus[0] - 2.0 * center_x + z_minus[0]) / dz2);
                hy[x] += prefactor
                    * ((x_plus[1] - 2.0 * center_y + x_minus[1]) / dx2
                        + (y_plus[1] - 2.0 * center_y + y_minus[1]) / dy2
                        + (z_plus[1] - 2.0 * center_y + z_minus[1]) / dz2);
                hz[x] += prefactor
                    * ((x_plus[2] - 2.0 * center_z + x_minus[2]) / dx2
                        + (y_plus[2] - 2.0 * center_z + y_minus[2]) / dy2
                        + (z_plus[2] - 2.0 * center_z + z_minus[2]) / dz2);
            }
        });
    }
}

#[cfg(test)]
mod exchange_face_tests {
    use crate::{
        build_exchange_operator, CellSize, EffectiveFieldTerms, ExchangeLlgProblem,
        ExchangeOperatorInputs, GridShape, LlgConfig, MaterialParameters, Vector3, MU0,
    };

    fn problem(
        grid: GridShape,
        ms_field: Vec<f64>,
        a_field: Vec<f64>,
        use_faces: bool,
    ) -> ExchangeLlgProblem {
        let base = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(2.0e-9, 3.0e-9, 4.0e-9).unwrap(),
            MaterialParameters::new(800.0e3, 13.0e-12, 0.1).unwrap(),
            LlgConfig::default(),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                ..Default::default()
            },
        );
        let operator = build_exchange_operator(&ExchangeOperatorInputs {
            grid,
            periodic: [false; 3],
            active: None,
            region_mask: None,
            region_owner: None,
            exchange_stiffness: 13.0e-12,
            a_field: Some(&a_field),
            rules: &[],
        })
        .unwrap();
        let problem = base
            .with_spatial_fields(Some(ms_field), Some(a_field), None)
            .unwrap();
        if use_faces {
            problem.with_exchange_operator(operator).unwrap()
        } else {
            problem
        }
    }

    fn pseudo_random(seed: usize) -> f64 {
        let value = ((seed as f64 + 1.0) * 12.9898).sin() * 43758.5453;
        value - value.floor()
    }

    fn sample(grid: GridShape) -> (Vec<f64>, Vec<f64>, Vec<Vector3>) {
        let cells = grid.cell_count();
        let ms = (0..cells).map(|i| 5.0e5 + 6.0e5 * pseudo_random(i)).collect();
        let a = (0..cells)
            .map(|i| 5.0e-12 + 2.0e-11 * pseudo_random(i + 1000))
            .collect();
        let m = (0..cells)
            .map(|i| {
                let v = [
                    pseudo_random(i + 2000) - 0.5,
                    pseudo_random(i + 3000) - 0.5,
                    pseudo_random(i + 4000) + 0.2,
                ];
                let n = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
                [v[0] / n, v[1] / n, v[2] / n]
            })
            .collect();
        (ms, a, m)
    }

    #[test]
    fn explicit_rule_equal_to_scalar_overrides_variable_a_field() {
        // Two cells, regions [1, 2], a_field = [13, 20] pJ/m, scalar A = 13 pJ/m
        // and explicit A12 = 13 pJ/m: the field must use 13 pJ/m, not H(13, 20).
        let grid = GridShape::new(2, 1, 1).unwrap();
        let a_field = vec![13.0e-12, 20.0e-12];
        let mask = [1u32, 2];
        let rules = [crate::ExchangePairRule {
            region_i: 1,
            region_j: 2,
            mode: crate::ExchangePairMode::Explicit(13.0e-12),
        }];
        let operator = build_exchange_operator(&ExchangeOperatorInputs {
            grid,
            periodic: [false; 3],
            active: None,
            region_mask: Some(&mask),
            region_owner: None,
            exchange_stiffness: 13.0e-12,
            a_field: Some(&a_field),
            rules: &rules,
        })
        .unwrap();
        let problem = ExchangeLlgProblem::with_terms(
            grid,
            CellSize::new(2.0e-9, 3.0e-9, 4.0e-9).unwrap(),
            MaterialParameters::new(800.0e3, 13.0e-12, 0.1).unwrap(),
            LlgConfig::default(),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                ..Default::default()
            },
        )
        .with_spatial_fields(None, Some(a_field), None)
        .unwrap()
        .with_exchange_operator(operator)
        .unwrap();
        let m: Vec<Vector3> = vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let field = problem.exchange_field_from_vectors(&m);
        let expected = 2.0 * 13.0e-12 / (MU0 * 800.0e3 * 4.0e-18);
        assert!((field[0][1] - expected).abs() <= 1e-12 * expected);
        assert!((field[0][0] + expected).abs() <= 1e-12 * expected);
    }

    #[test]
    fn faces_field_matches_harmonic_aos_without_rules() {
        let grid = GridShape::new(5, 4, 3).unwrap();
        let (ms, a, m) = sample(grid);
        let faces = problem(grid, ms.clone(), a.clone(), true);
        let cells = problem(grid, ms, a, false);
        let actual = faces.exchange_field_from_vectors(&m);
        let expected = cells.exchange_field_from_vectors(&m);
        for (cell, (lhs, rhs)) in actual.iter().zip(&expected).enumerate() {
            for component in 0..3 {
                let tolerance = 1e-12 * rhs[component].abs().max(1.0);
                assert!(
                    (lhs[component] - rhs[component]).abs() <= tolerance,
                    "cell {cell} component {component}: {} vs {}",
                    lhs[component],
                    rhs[component]
                );
            }
        }
        let e_faces = faces.exchange_energy_from_vectors(&m);
        let e_cells = cells.exchange_energy_from_vectors(&m);
        assert!((e_faces - e_cells).abs() <= 1e-12 * e_cells.abs());
    }

    #[test]
    fn faces_energy_is_negative_gradient() {
        let grid = GridShape::new(4, 3, 2).unwrap();
        let (ms, a, m) = sample(grid);
        let problem = problem(grid, ms.clone(), a, true);
        let field = problem.exchange_field_from_vectors(&m);
        let volume = 2.0e-9 * 3.0e-9 * 4.0e-9;
        let step = 1.0e-6;
        for cell in [0usize, 7, 23] {
            for component in 0..3 {
                let mut plus = m.clone();
                let mut minus = m.clone();
                plus[cell][component] += step;
                minus[cell][component] -= step;
                let derivative = (problem.exchange_energy_from_vectors(&plus)
                    - problem.exchange_energy_from_vectors(&minus))
                    / (2.0 * step);
                let field_from_energy = -derivative / (MU0 * ms[cell] * volume);
                let reference = field[cell][component];
                assert!(
                    (field_from_energy - reference).abs() <= 1e-6 * reference.abs().max(1.0),
                    "cell {cell} component {component}: {field_from_energy} vs {reference}"
                );
            }
        }
    }

    #[test]
    fn ms_jump_with_uniform_m_gives_zero_exchange() {
        let grid = GridShape::new(2, 1, 1).unwrap();
        let problem = problem(grid, vec![4.0e5, 1.2e6], vec![13.0e-12, 13.0e-12], true);
        let m = vec![[0.0, 0.6, 0.8]; 2];
        for value in problem.exchange_field_from_vectors(&m) {
            assert_eq!(value, [0.0, 0.0, 0.0]);
        }
        assert_eq!(problem.exchange_energy_from_vectors(&m), 0.0);
    }
}
