use crate::fdm::shared::types::{CellSize, EngineError, GridShape, Result};
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PotentialGauge {
    ZeroMean,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ChargeBoundaryConditions {
    pub x_min: Option<f64>,
    pub x_max: Option<f64>,
    pub y_min: Option<f64>,
    pub y_max: Option<f64>,
    pub z_min: Option<f64>,
    pub z_max: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ChargeSolverConfig {
    pub relative_tolerance: f64,
    pub absolute_tolerance: f64,
    pub max_iterations: usize,
    pub gauge: Option<PotentialGauge>,
}

impl Default for ChargeSolverConfig {
    fn default() -> Self {
        Self {
            relative_tolerance: 1.0e-12,
            absolute_tolerance: 1.0e-14,
            max_iterations: 10_000,
            gauge: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrientedFaceFluxes {
    pub x: Vec<f64>,
    pub y: Vec<f64>,
    pub z: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChargeSolution {
    pub potential_volts: Vec<f64>,
    pub current_density: OrientedFaceFluxes,
    pub iterations: usize,
    pub residual_l2: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StructuredChargeProblem {
    pub grid: GridShape,
    pub cell_size: CellSize,
    pub conductivity_s_per_m: Vec<f64>,
    pub active_cells: Vec<bool>,
    pub boundary: ChargeBoundaryConditions,
}

impl StructuredChargeProblem {
    pub fn new(
        grid: GridShape,
        cell_size: CellSize,
        conductivity_s_per_m: Vec<f64>,
        active_cells: Option<Vec<bool>>,
        boundary: ChargeBoundaryConditions,
    ) -> Result<Self> {
        let count = grid.cell_count();
        if conductivity_s_per_m.len() != count {
            return Err(EngineError::new(format!(
                "conductivity_s_per_m must contain {count} cell values"
            )));
        }
        if conductivity_s_per_m
            .iter()
            .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err(EngineError::new(
                "conductivity_s_per_m must be finite and non-negative",
            ));
        }
        let active_cells = active_cells.unwrap_or_else(|| vec![true; count]);
        if active_cells.len() != count {
            return Err(EngineError::new(format!(
                "active_cells must contain {count} cell values"
            )));
        }
        if !active_cells.iter().any(|active| *active) {
            return Err(EngineError::new(
                "charge transport requires at least one active cell",
            ));
        }
        if active_cells
            .iter()
            .zip(&conductivity_s_per_m)
            .any(|(&active, &conductivity)| active && conductivity <= 0.0)
        {
            return Err(EngineError::new(
                "every active charge-transport cell must have positive conductivity",
            ));
        }
        for value in [
            boundary.x_min,
            boundary.x_max,
            boundary.y_min,
            boundary.y_max,
            boundary.z_min,
            boundary.z_max,
        ]
        .into_iter()
        .flatten()
        {
            if !value.is_finite() {
                return Err(EngineError::new(
                    "Dirichlet boundary potentials must be finite",
                ));
            }
        }
        Ok(Self {
            grid,
            cell_size,
            conductivity_s_per_m,
            active_cells,
            boundary,
        })
    }

    pub fn face_fluxes(&self, potential_volts: &[f64]) -> Result<OrientedFaceFluxes> {
        self.validate_cell_values(potential_volts, "potential_volts")?;
        let GridShape { nx, ny, nz } = self.grid;
        let mut fluxes = OrientedFaceFluxes {
            x: vec![0.0; (nx + 1) * ny * nz],
            y: vec![0.0; nx * (ny + 1) * nz],
            z: vec![0.0; nx * ny * (nz + 1)],
        };

        for z in 0..nz {
            for y in 0..ny {
                for face_x in 0..=nx {
                    let face = face_x + (nx + 1) * (y + ny * z);
                    fluxes.x[face] = if face_x == 0 {
                        self.boundary_flux(
                            self.grid.index(0, y, z),
                            self.boundary.x_min,
                            potential_volts,
                            self.cell_size.dx,
                            false,
                        )
                    } else if face_x == nx {
                        self.boundary_flux(
                            self.grid.index(nx - 1, y, z),
                            self.boundary.x_max,
                            potential_volts,
                            self.cell_size.dx,
                            true,
                        )
                    } else {
                        self.internal_flux(
                            self.grid.index(face_x - 1, y, z),
                            self.grid.index(face_x, y, z),
                            potential_volts,
                            self.cell_size.dx,
                        )
                    };
                }
            }
        }
        for z in 0..nz {
            for face_y in 0..=ny {
                for x in 0..nx {
                    let face = x + nx * (face_y + (ny + 1) * z);
                    fluxes.y[face] = if face_y == 0 {
                        self.boundary_flux(
                            self.grid.index(x, 0, z),
                            self.boundary.y_min,
                            potential_volts,
                            self.cell_size.dy,
                            false,
                        )
                    } else if face_y == ny {
                        self.boundary_flux(
                            self.grid.index(x, ny - 1, z),
                            self.boundary.y_max,
                            potential_volts,
                            self.cell_size.dy,
                            true,
                        )
                    } else {
                        self.internal_flux(
                            self.grid.index(x, face_y - 1, z),
                            self.grid.index(x, face_y, z),
                            potential_volts,
                            self.cell_size.dy,
                        )
                    };
                }
            }
        }
        for face_z in 0..=nz {
            for y in 0..ny {
                for x in 0..nx {
                    let face = x + nx * (y + ny * face_z);
                    fluxes.z[face] = if face_z == 0 {
                        self.boundary_flux(
                            self.grid.index(x, y, 0),
                            self.boundary.z_min,
                            potential_volts,
                            self.cell_size.dz,
                            false,
                        )
                    } else if face_z == nz {
                        self.boundary_flux(
                            self.grid.index(x, y, nz - 1),
                            self.boundary.z_max,
                            potential_volts,
                            self.cell_size.dz,
                            true,
                        )
                    } else {
                        self.internal_flux(
                            self.grid.index(x, y, face_z - 1),
                            self.grid.index(x, y, face_z),
                            potential_volts,
                            self.cell_size.dz,
                        )
                    };
                }
            }
        }
        Ok(fluxes)
    }

    pub fn conservative_divergence(&self, fluxes: &OrientedFaceFluxes) -> Result<Vec<f64>> {
        let GridShape { nx, ny, nz } = self.grid;
        if fluxes.x.len() != (nx + 1) * ny * nz
            || fluxes.y.len() != nx * (ny + 1) * nz
            || fluxes.z.len() != nx * ny * (nz + 1)
        {
            return Err(EngineError::new(
                "oriented face-flux dimensions do not match the charge grid",
            ));
        }
        let mut divergence = vec![0.0; self.grid.cell_count()];
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    let cell = self.grid.index(x, y, z);
                    if !self.active_cells[cell] {
                        continue;
                    }
                    let x0 = x + (nx + 1) * (y + ny * z);
                    let y0 = x + nx * (y + (ny + 1) * z);
                    let z0 = x + nx * (y + ny * z);
                    divergence[cell] = (fluxes.x[x0 + 1] - fluxes.x[x0]) / self.cell_size.dx
                        + (fluxes.y[y0 + nx] - fluxes.y[y0]) / self.cell_size.dy
                        + (fluxes.z[z0 + nx * ny] - fluxes.z[z0]) / self.cell_size.dz;
                }
            }
        }
        Ok(divergence)
    }

    pub fn solve(&self, config: ChargeSolverConfig) -> Result<ChargeSolution> {
        self.validate_solver_config(config)?;
        let has_dirichlet = [
            self.boundary.x_min,
            self.boundary.x_max,
            self.boundary.y_min,
            self.boundary.y_max,
            self.boundary.z_min,
            self.boundary.z_max,
        ]
        .iter()
        .any(Option::is_some);
        if !has_dirichlet && config.gauge.is_none() {
            return Err(EngineError::new(
                "a pure-Neumann charge problem requires an explicit potential gauge",
            ));
        }
        if has_dirichlet {
            self.validate_dirichlet_anchors()?;
        }

        let count = self.grid.cell_count();
        let zero = vec![0.0; count];
        let affine_offset = self.charge_residual(&zero)?;
        let mut rhs: Vec<f64> = affine_offset.iter().map(|value| -value).collect();
        let project_zero_mean = !has_dirichlet && config.gauge == Some(PotentialGauge::ZeroMean);
        if project_zero_mean {
            project_active_zero_mean(&mut rhs, &self.active_cells);
        }
        let rhs_norm = l2_norm_active(&rhs, &self.active_cells);
        let tolerance = config
            .absolute_tolerance
            .max(config.relative_tolerance * rhs_norm);
        let mut potential = vec![0.0; count];
        let mut residual = rhs.clone();
        let mut direction = residual.clone();
        let mut residual_squared = dot_active(&residual, &residual, &self.active_cells);
        let mut iterations = 0;

        while residual_squared.sqrt() > tolerance && iterations < config.max_iterations {
            let mut applied = self.apply_linear(&direction, &affine_offset)?;
            if project_zero_mean {
                project_active_zero_mean(&mut applied, &self.active_cells);
            }
            let denominator = dot_active(&direction, &applied, &self.active_cells);
            if !denominator.is_finite() || denominator <= 0.0 {
                return Err(EngineError::new(
                    "charge operator is singular or not positive definite on the active domain",
                ));
            }
            let alpha = residual_squared / denominator;
            axpy_active(&mut potential, alpha, &direction, &self.active_cells);
            axpy_active(&mut residual, -alpha, &applied, &self.active_cells);
            if project_zero_mean {
                project_active_zero_mean(&mut potential, &self.active_cells);
                project_active_zero_mean(&mut residual, &self.active_cells);
            }
            let next_squared = dot_active(&residual, &residual, &self.active_cells);
            iterations += 1;
            if next_squared.sqrt() <= tolerance {
                residual_squared = next_squared;
                break;
            }
            let beta = next_squared / residual_squared;
            for cell in 0..count {
                if self.active_cells[cell] {
                    direction[cell] = residual[cell] + beta * direction[cell];
                }
            }
            residual_squared = next_squared;
        }
        if residual_squared.sqrt() > tolerance {
            return Err(EngineError::new(format!(
                "charge CG did not converge in {} iterations (residual {:.6e}, tolerance {:.6e})",
                config.max_iterations,
                residual_squared.sqrt(),
                tolerance
            )));
        }
        let current_density = self.face_fluxes(&potential)?;
        let physical_residual = self.charge_residual(&potential)?;
        Ok(ChargeSolution {
            potential_volts: potential,
            current_density,
            iterations,
            residual_l2: l2_norm_active(&physical_residual, &self.active_cells),
        })
    }

    fn validate_cell_values(&self, values: &[f64], name: &str) -> Result<()> {
        if values.len() != self.grid.cell_count() {
            return Err(EngineError::new(format!(
                "{name} must contain {} cell values",
                self.grid.cell_count()
            )));
        }
        if values.iter().any(|value| !value.is_finite()) {
            return Err(EngineError::new(format!("{name} must be finite")));
        }
        Ok(())
    }

    fn validate_solver_config(&self, config: ChargeSolverConfig) -> Result<()> {
        if !config.relative_tolerance.is_finite()
            || config.relative_tolerance < 0.0
            || !config.absolute_tolerance.is_finite()
            || config.absolute_tolerance < 0.0
            || config.max_iterations == 0
        {
            return Err(EngineError::new(
                "charge solver tolerances must be finite and non-negative, and max_iterations > 0",
            ));
        }
        Ok(())
    }

    fn validate_dirichlet_anchors(&self) -> Result<()> {
        let count = self.grid.cell_count();
        let mut visited = vec![false; count];
        for seed in 0..count {
            if visited[seed] || !self.active_cells[seed] {
                continue;
            }
            let mut queue = VecDeque::from([seed]);
            visited[seed] = true;
            let mut anchored = false;
            while let Some(cell) = queue.pop_front() {
                let x = cell % self.grid.nx;
                let yz = cell / self.grid.nx;
                let y = yz % self.grid.ny;
                let z = yz / self.grid.ny;
                anchored |= (x == 0 && self.boundary.x_min.is_some())
                    || (x + 1 == self.grid.nx && self.boundary.x_max.is_some())
                    || (y == 0 && self.boundary.y_min.is_some())
                    || (y + 1 == self.grid.ny && self.boundary.y_max.is_some())
                    || (z == 0 && self.boundary.z_min.is_some())
                    || (z + 1 == self.grid.nz && self.boundary.z_max.is_some());

                for neighbor in self.active_neighbors(x, y, z) {
                    if !visited[neighbor] {
                        visited[neighbor] = true;
                        queue.push_back(neighbor);
                    }
                }
            }
            if !anchored {
                return Err(EngineError::new(
                    "every disconnected active conductor component requires a Dirichlet anchor",
                ));
            }
        }
        Ok(())
    }

    fn active_neighbors(&self, x: usize, y: usize, z: usize) -> Vec<usize> {
        let mut neighbors = Vec::with_capacity(6);
        for (nx, ny, nz) in [
            x.checked_sub(1).map(|value| (value, y, z)),
            (x + 1 < self.grid.nx).then_some((x + 1, y, z)),
            y.checked_sub(1).map(|value| (x, value, z)),
            (y + 1 < self.grid.ny).then_some((x, y + 1, z)),
            z.checked_sub(1).map(|value| (x, y, value)),
            (z + 1 < self.grid.nz).then_some((x, y, z + 1)),
        ]
        .into_iter()
        .flatten()
        {
            let neighbor = self.grid.index(nx, ny, nz);
            if self.active_cells[neighbor] {
                neighbors.push(neighbor);
            }
        }
        neighbors
    }

    fn internal_flux(&self, left: usize, right: usize, potential: &[f64], distance: f64) -> f64 {
        if !self.active_cells[left] || !self.active_cells[right] {
            return 0.0;
        }
        let conductivity = harmonic_mean(
            self.conductivity_s_per_m[left],
            self.conductivity_s_per_m[right],
        );
        -conductivity * (potential[right] - potential[left]) / distance
    }

    fn boundary_flux(
        &self,
        cell: usize,
        boundary_potential: Option<f64>,
        potential: &[f64],
        cell_width: f64,
        positive_face: bool,
    ) -> f64 {
        if !self.active_cells[cell] {
            return 0.0;
        }
        let Some(boundary_potential) = boundary_potential else {
            return 0.0;
        };
        let oriented_difference = if positive_face {
            boundary_potential - potential[cell]
        } else {
            potential[cell] - boundary_potential
        };
        -self.conductivity_s_per_m[cell] * oriented_difference / (0.5 * cell_width)
    }

    fn charge_residual(&self, potential: &[f64]) -> Result<Vec<f64>> {
        self.conservative_divergence(&self.face_fluxes(potential)?)
    }

    fn apply_linear(&self, values: &[f64], affine_offset: &[f64]) -> Result<Vec<f64>> {
        Ok(self
            .charge_residual(values)?
            .into_iter()
            .zip(affine_offset)
            .map(|(value, offset)| value - offset)
            .collect())
    }
}

fn harmonic_mean(left: f64, right: f64) -> f64 {
    if left == 0.0 || right == 0.0 {
        0.0
    } else {
        2.0 * left * right / (left + right)
    }
}

fn dot_active(left: &[f64], right: &[f64], active: &[bool]) -> f64 {
    left.iter()
        .zip(right)
        .zip(active)
        .filter_map(|((&left, &right), &active)| active.then_some(left * right))
        .sum()
}

fn l2_norm_active(values: &[f64], active: &[bool]) -> f64 {
    dot_active(values, values, active).sqrt()
}

fn axpy_active(target: &mut [f64], scale: f64, values: &[f64], active: &[bool]) {
    for ((target, value), active) in target.iter_mut().zip(values).zip(active) {
        if *active {
            *target += scale * value;
        }
    }
}

fn project_active_zero_mean(values: &mut [f64], active: &[bool]) {
    let count = active.iter().filter(|value| **value).count();
    if count == 0 {
        return;
    }
    let mean = values
        .iter()
        .zip(active)
        .filter_map(|(&value, &active)| active.then_some(value))
        .sum::<f64>()
        / count as f64;
    for (value, active) in values.iter_mut().zip(active) {
        if *active {
            *value -= mean;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(actual: f64, expected: f64, tolerance: f64) {
        assert!(
            (actual - expected).abs() <= tolerance,
            "expected {expected:.16e}, got {actual:.16e}"
        );
    }

    #[test]
    fn charge_uniform_bar_v1_matches_linear_potential_and_ohms_law() {
        let grid = GridShape::new(8, 1, 1).unwrap();
        let dx = 2.0e-9;
        let sigma = 5.8e7;
        let problem = StructuredChargeProblem::new(
            grid,
            CellSize::new(dx, 3.0e-9, 4.0e-9).unwrap(),
            vec![sigma; grid.cell_count()],
            None,
            ChargeBoundaryConditions {
                x_min: Some(0.0),
                x_max: Some(0.16),
                ..Default::default()
            },
        )
        .unwrap();

        let solution = problem.solve(ChargeSolverConfig::default()).unwrap();
        let length = grid.nx as f64 * dx;
        let expected_jx = -sigma * 0.16 / length;
        for (x, &potential) in solution.potential_volts.iter().enumerate() {
            let expected = 0.16 * (x as f64 + 0.5) / grid.nx as f64;
            assert_close(potential, expected, 5.0e-12);
        }
        for &jx in &solution.current_density.x {
            assert_close(jx, expected_jx, expected_jx.abs() * 1.0e-10);
        }
        let residual_scale = expected_jx.abs() / dx * (grid.cell_count() as f64).sqrt();
        assert!(solution.residual_l2 / residual_scale < 1.0e-10);
    }

    #[test]
    fn charge_layered_series_v1_uses_harmonic_face_conductivity() {
        let grid = GridShape::new(2, 1, 1).unwrap();
        let cell_size = CellSize::new(1.0, 1.0, 1.0).unwrap();
        let sigma_left = 2.0;
        let sigma_right = 8.0;
        let problem = StructuredChargeProblem::new(
            grid,
            cell_size,
            vec![sigma_left, sigma_right],
            None,
            ChargeBoundaryConditions {
                x_min: Some(0.0),
                x_max: Some(1.0),
                ..Default::default()
            },
        )
        .unwrap();

        let solution = problem.solve(ChargeSolverConfig::default()).unwrap();
        let resistance_per_area = 1.0 / sigma_left + 1.0 / sigma_right;
        let expected_jx = -1.0 / resistance_per_area;
        for &jx in &solution.current_density.x {
            assert_close(jx, expected_jx, 1.0e-11);
        }
        assert_close(solution.potential_volts[0], 0.4, 1.0e-11);
        assert_close(solution.potential_volts[1], 0.9, 1.0e-11);
    }

    #[test]
    fn one_internal_face_is_shared_by_both_cell_balances() {
        let grid = GridShape::new(2, 1, 1).unwrap();
        let problem = StructuredChargeProblem::new(
            grid,
            CellSize::new(1.0, 2.0, 3.0).unwrap(),
            vec![2.0, 8.0],
            None,
            ChargeBoundaryConditions::default(),
        )
        .unwrap();
        let flux = problem.face_fluxes(&[0.0, 1.0]).unwrap();
        assert_close(flux.x[1], -3.2, 1.0e-14);
        let divergence = problem.conservative_divergence(&flux).unwrap();
        assert_close(divergence[0], -3.2, 1.0e-14);
        assert_close(divergence[1], 3.2, 1.0e-14);
        assert_close(divergence.iter().sum(), 0.0, 1.0e-14);
    }

    #[test]
    fn pure_neumann_problem_requires_an_explicit_gauge() {
        let grid = GridShape::new(2, 1, 1).unwrap();
        let problem = StructuredChargeProblem::new(
            grid,
            CellSize::new(1.0, 1.0, 1.0).unwrap(),
            vec![1.0; 2],
            None,
            ChargeBoundaryConditions::default(),
        )
        .unwrap();
        let error = problem.solve(ChargeSolverConfig::default()).unwrap_err();
        assert!(error.to_string().contains("gauge"));
    }

    #[test]
    fn active_cells_must_have_positive_conductivity() {
        let grid = GridShape::new(1, 1, 1).unwrap();
        let error = StructuredChargeProblem::new(
            grid,
            CellSize::new(1.0, 1.0, 1.0).unwrap(),
            vec![0.0],
            None,
            ChargeBoundaryConditions::default(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("positive conductivity"));
    }

    #[test]
    fn every_disconnected_conductor_component_needs_a_dirichlet_anchor() {
        let grid = GridShape::new(3, 1, 1).unwrap();
        let problem = StructuredChargeProblem::new(
            grid,
            CellSize::new(1.0, 1.0, 1.0).unwrap(),
            vec![1.0; 3],
            Some(vec![true, false, true]),
            ChargeBoundaryConditions {
                x_min: Some(0.0),
                ..Default::default()
            },
        )
        .unwrap();
        let error = problem.solve(ChargeSolverConfig::default()).unwrap_err();
        assert!(error.to_string().contains("Dirichlet anchor"));
    }
}
