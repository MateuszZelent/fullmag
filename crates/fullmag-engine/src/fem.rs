use crate::{
    add, cross, dot, norm, normalized, scale, sub, EffectiveFieldObservables, EffectiveFieldTerms,
    EngineError, LlgConfig, MaterialParameters, Result, StepReport, TimeIntegrator, Vector3, MU0,
};
use fullmag_ir::MeshIR;
use std::collections::BTreeSet;
use std::f64::consts::PI;

#[derive(Debug, Clone, PartialEq)]
pub struct MeshTopology {
    pub coords: Vec<[f64; 3]>,
    pub elements: Vec<[u32; 4]>,
    pub element_markers: Vec<u32>,
    pub magnetic_element_mask: Vec<bool>,
    pub boundary_faces: Vec<[u32; 3]>,
    pub boundary_nodes: Vec<u32>,
    pub element_volumes: Vec<f64>,
    pub node_volumes: Vec<f64>,
    pub magnetic_node_volumes: Vec<f64>,
    pub grad_phi: Vec<[[f64; 3]; 4]>,
    pub element_stiffness: Vec<[[f64; 4]; 4]>,
    pub demag_system: Vec<f64>,
    pub total_volume: f64,
    pub magnetic_total_volume: f64,
    pub robin_beta: f64,
    pub n_nodes: usize,
    pub n_elements: usize,
}

impl MeshTopology {
    pub fn from_ir(mesh: &MeshIR) -> Result<Self> {
        mesh.validate()
            .map_err(|errors| EngineError::new(errors.join("; ")))?;

        let coords = mesh.nodes.clone();
        let elements = mesh.elements.clone();
        let n_nodes = coords.len();
        let n_elements = elements.len();
        let magnetic_element_mask = magnetic_element_mask_from_markers(&mesh.element_markers);

        let mut element_volumes = Vec::with_capacity(n_elements);
        let mut node_volumes = vec![0.0; n_nodes];
        let mut magnetic_node_volumes = vec![0.0; n_nodes];
        let mut grad_phi = Vec::with_capacity(n_elements);
        let mut element_stiffness = Vec::with_capacity(n_elements);
        let mut global_stiffness = vec![0.0; n_nodes * n_nodes];
        let mut magnetic_total_volume = 0.0;

        for (element_index, element) in elements.iter().enumerate() {
            let p0 = coords[element[0] as usize];
            let p1 = coords[element[1] as usize];
            let p2 = coords[element[2] as usize];
            let p3 = coords[element[3] as usize];

            let d1 = sub(p1, p0);
            let d2 = sub(p2, p0);
            let d3 = sub(p3, p0);
            let det = dot(d1, cross(d2, d3));
            if det.abs() <= 1e-30 {
                return Err(EngineError::new(
                    "degenerate tetrahedral element encountered in MeshIR",
                ));
            }

            let inv_t = inverse_transpose_3x3([d1, d2, d3], det);
            let grad1 = [inv_t[0][0], inv_t[1][0], inv_t[2][0]];
            let grad2 = [inv_t[0][1], inv_t[1][1], inv_t[2][1]];
            let grad3 = [inv_t[0][2], inv_t[1][2], inv_t[2][2]];
            let grad0 = scale(add(add(grad1, grad2), grad3), -1.0);
            let gradients = [grad0, grad1, grad2, grad3];

            let volume = det.abs() / 6.0;
            let mut stiffness = [[0.0; 4]; 4];
            for i in 0..4 {
                for j in 0..4 {
                    stiffness[i][j] = volume * dot(gradients[i], gradients[j]);
                }
            }

            add_tet_local_matrix(&mut global_stiffness, n_nodes, element, &stiffness);

            for &node in element {
                node_volumes[node as usize] += volume / 4.0;
                if magnetic_element_mask[element_index] {
                    magnetic_node_volumes[node as usize] += volume / 4.0;
                }
            }

            if magnetic_element_mask[element_index] {
                magnetic_total_volume += volume;
            }

            element_volumes.push(volume);
            grad_phi.push(gradients);
            element_stiffness.push(stiffness);
        }

        let boundary_nodes = mesh
            .boundary_faces
            .iter()
            .flat_map(|face| face.iter().copied())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();

        let mut boundary_mass = vec![0.0; n_nodes * n_nodes];
        for face in &mesh.boundary_faces {
            let p0 = coords[face[0] as usize];
            let p1 = coords[face[1] as usize];
            let p2 = coords[face[2] as usize];
            let area = triangle_area(p0, p1, p2);
            let local = [
                [2.0 * area / 12.0, area / 12.0, area / 12.0],
                [area / 12.0, 2.0 * area / 12.0, area / 12.0],
                [area / 12.0, area / 12.0, 2.0 * area / 12.0],
            ];
            add_triangle_local_matrix(&mut boundary_mass, n_nodes, face, &local);
        }

        let total_volume: f64 = element_volumes.iter().sum();
        let equivalent_radius = equivalent_radius(total_volume.max(1e-30));
        let robin_beta = if boundary_nodes.is_empty() {
            0.0
        } else {
            1.0 / equivalent_radius.max(1e-30)
        };
        let mut demag_system = global_stiffness;
        if robin_beta > 0.0 {
            for (value, boundary) in demag_system.iter_mut().zip(boundary_mass.iter()) {
                *value += robin_beta * *boundary;
            }
        }

        Ok(Self {
            coords,
            elements,
            element_markers: mesh.element_markers.clone(),
            magnetic_element_mask,
            boundary_faces: mesh.boundary_faces.clone(),
            boundary_nodes,
            total_volume,
            magnetic_total_volume,
            robin_beta,
            element_volumes,
            node_volumes,
            magnetic_node_volumes,
            grad_phi,
            element_stiffness,
            demag_system,
            n_nodes,
            n_elements,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FemLlgState {
    magnetization: Vec<Vector3>,
    pub time_seconds: f64,
}

impl FemLlgState {
    pub fn new(topology: &MeshTopology, magnetization: Vec<Vector3>) -> Result<Self> {
        if magnetization.len() != topology.n_nodes {
            return Err(EngineError::new(format!(
                "magnetization length {} does not match FEM node count {}",
                magnetization.len(),
                topology.n_nodes
            )));
        }
        let magnetization = magnetization
            .into_iter()
            .map(normalized)
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            magnetization,
            time_seconds: 0.0,
        })
    }

    pub fn magnetization(&self) -> &[Vector3] {
        &self.magnetization
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FemLlgProblem {
    pub topology: MeshTopology,
    pub material: MaterialParameters,
    pub dynamics: LlgConfig,
    pub terms: EffectiveFieldTerms,
}

impl FemLlgProblem {
    pub fn with_terms(
        topology: MeshTopology,
        material: MaterialParameters,
        dynamics: LlgConfig,
        terms: EffectiveFieldTerms,
    ) -> Self {
        Self {
            topology,
            material,
            dynamics,
            terms,
        }
    }

    pub fn new_state(&self, magnetization: Vec<Vector3>) -> Result<FemLlgState> {
        FemLlgState::new(&self.topology, magnetization)
    }

    pub fn exchange_field(&self, state: &FemLlgState) -> Result<Vec<Vector3>> {
        self.ensure_state_matches_topology(state)?;
        Ok(if self.terms.exchange {
            self.exchange_field_from_vectors(state.magnetization())
        } else {
            vec![[0.0, 0.0, 0.0]; self.topology.n_nodes]
        })
    }

    pub fn observe(&self, state: &FemLlgState) -> Result<EffectiveFieldObservables> {
        self.ensure_state_matches_topology(state)?;
        self.observe_vectors(state.magnetization())
    }

    pub fn step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        self.ensure_state_matches_topology(state)?;
        if dt <= 0.0 {
            return Err(EngineError::new("dt must be positive"));
        }

        match self.dynamics.integrator {
            TimeIntegrator::Heun => self.heun_step(state, dt),
        }
    }

    fn heun_step(&self, state: &mut FemLlgState, dt: f64) -> Result<StepReport> {
        let initial = state.magnetization.clone();
        let k1 = self.llg_rhs_from_vectors(&initial)?;
        let predicted = initial
            .iter()
            .zip(k1.iter())
            .map(|(m, rhs)| normalized(add(*m, scale(*rhs, dt))))
            .collect::<Result<Vec<_>>>()?;
        let k2 = self.llg_rhs_from_vectors(&predicted)?;
        let corrected = initial
            .iter()
            .zip(k1.iter().zip(k2.iter()))
            .map(|(m, (rhs1, rhs2))| normalized(add(*m, scale(add(*rhs1, *rhs2), 0.5 * dt))))
            .collect::<Result<Vec<_>>>()?;

        state.magnetization = corrected;
        state.time_seconds += dt;

        let observables = self.observe_vectors(state.magnetization())?;
        Ok(StepReport {
            time_seconds: state.time_seconds,
            exchange_energy_joules: observables.exchange_energy_joules,
            demag_energy_joules: observables.demag_energy_joules,
            external_energy_joules: observables.external_energy_joules,
            total_energy_joules: observables.total_energy_joules,
            max_effective_field_amplitude: observables.max_effective_field_amplitude,
            max_demag_field_amplitude: observables.max_demag_field_amplitude,
            max_rhs_amplitude: observables.max_rhs_amplitude,
        })
    }

    fn ensure_state_matches_topology(&self, state: &FemLlgState) -> Result<()> {
        if state.magnetization.len() != self.topology.n_nodes {
            return Err(EngineError::new(
                "state magnetization length does not match FEM topology node count",
            ));
        }
        Ok(())
    }

    fn observe_vectors(&self, magnetization: &[Vector3]) -> Result<EffectiveFieldObservables> {
        let exchange_field = if self.terms.exchange {
            self.exchange_field_from_vectors(magnetization)
        } else {
            vec![[0.0, 0.0, 0.0]; self.topology.n_nodes]
        };
        let (demag_field, demag_energy_joules) = if self.terms.demag {
            self.demag_observables_from_vectors(magnetization)?
        } else {
            (vec![[0.0, 0.0, 0.0]; self.topology.n_nodes], 0.0)
        };
        let external_field = self.external_field_vectors();
        let effective_field = exchange_field
            .iter()
            .zip(demag_field.iter())
            .zip(external_field.iter())
            .map(|((h_ex, h_demag), h_ext)| add(add(*h_ex, *h_demag), *h_ext))
            .collect::<Vec<_>>();
        let rhs = magnetization
            .iter()
            .enumerate()
            .map(|(node, m)| {
                if self.topology.magnetic_node_volumes[node] > 0.0 {
                    self.llg_rhs_from_field(*m, effective_field[node])
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect::<Vec<_>>();
        let exchange_energy_joules = if self.terms.exchange {
            self.exchange_energy_from_vectors(magnetization)
        } else {
            0.0
        };
        let external_energy_joules = if self.terms.external_field.is_some() {
            self.external_energy_from_fields(magnetization, &external_field)
        } else {
            0.0
        };
        let total_energy_joules =
            exchange_energy_joules + demag_energy_joules + external_energy_joules;

        Ok(EffectiveFieldObservables {
            magnetization: magnetization.to_vec(),
            exchange_field,
            demag_field: demag_field.clone(),
            external_field,
            effective_field: effective_field.clone(),
            exchange_energy_joules,
            demag_energy_joules,
            external_energy_joules,
            total_energy_joules,
            max_effective_field_amplitude: max_norm(&effective_field),
            max_demag_field_amplitude: max_norm(&demag_field),
            max_rhs_amplitude: max_norm(&rhs),
        })
    }

    fn exchange_field_from_vectors(&self, magnetization: &[Vector3]) -> Vec<Vector3> {
        let coeff =
            2.0 * self.material.exchange_stiffness / (MU0 * self.material.saturation_magnetisation);
        let mut field = vec![[0.0, 0.0, 0.0]; self.topology.n_nodes];

        for (element_index, (element, stiffness)) in self
            .topology
            .elements
            .iter()
            .zip(self.topology.element_stiffness.iter())
            .enumerate()
        {
            if !self.topology.magnetic_element_mask[element_index] {
                continue;
            }
            let local_m = [
                magnetization[element[0] as usize],
                magnetization[element[1] as usize],
                magnetization[element[2] as usize],
                magnetization[element[3] as usize],
            ];
            for i in 0..4 {
                let mut contribution = [0.0, 0.0, 0.0];
                for j in 0..4 {
                    contribution = add(contribution, scale(local_m[j], stiffness[i][j]));
                }
                let node = element[i] as usize;
                field[node] = add(field[node], scale(contribution, -coeff));
            }
        }

        for (index, value) in field.iter_mut().enumerate() {
            let lumped_mass = self.topology.magnetic_node_volumes[index];
            if lumped_mass > 0.0 {
                *value = scale(*value, 1.0 / lumped_mass);
            }
        }

        field
    }

    fn exchange_energy_from_vectors(&self, magnetization: &[Vector3]) -> f64 {
        let mut energy = 0.0;
        for (element_index, (element, stiffness)) in self
            .topology
            .elements
            .iter()
            .zip(self.topology.element_stiffness.iter())
            .enumerate()
        {
            if !self.topology.magnetic_element_mask[element_index] {
                continue;
            }
            let local_m = [
                magnetization[element[0] as usize],
                magnetization[element[1] as usize],
                magnetization[element[2] as usize],
                magnetization[element[3] as usize],
            ];
            for component in 0..3 {
                let local_values = [
                    local_m[0][component],
                    local_m[1][component],
                    local_m[2][component],
                    local_m[3][component],
                ];
                for i in 0..4 {
                    for j in 0..4 {
                        energy += self.material.exchange_stiffness
                            * local_values[i]
                            * stiffness[i][j]
                            * local_values[j];
                    }
                }
            }
        }
        energy
    }

    fn demag_observables_from_vectors(
        &self,
        magnetization: &[Vector3],
    ) -> Result<(Vec<Vector3>, f64)> {
        let rhs = self.demag_rhs_from_vectors(magnetization);
        let potential = solve_dense_linear_system(&self.topology.demag_system, &rhs)?;
        let field = self.demag_field_from_potential(&potential);
        let energy = 0.5
            * MU0
            * potential
                .iter()
                .zip(rhs.iter())
                .map(|(u, b)| u * b)
                .sum::<f64>();
        Ok((field, energy))
    }

    fn demag_rhs_from_vectors(&self, magnetization: &[Vector3]) -> Vec<f64> {
        let mut rhs = vec![0.0; self.topology.n_nodes];
        for (element_index, element) in self.topology.elements.iter().enumerate() {
            if !self.topology.magnetic_element_mask[element_index] {
                continue;
            }
            let local_m = [
                magnetization[element[0] as usize],
                magnetization[element[1] as usize],
                magnetization[element[2] as usize],
                magnetization[element[3] as usize],
            ];
            let avg_m = scale(
                add(add(local_m[0], local_m[1]), add(local_m[2], local_m[3])),
                0.25 * self.material.saturation_magnetisation,
            );
            let volume = self.topology.element_volumes[element_index];
            let gradients = self.topology.grad_phi[element_index];
            for local_index in 0..4 {
                rhs[element[local_index] as usize] += volume * dot(avg_m, gradients[local_index]);
            }
        }
        rhs
    }

    fn demag_field_from_potential(&self, potential: &[f64]) -> Vec<Vector3> {
        let mut field = vec![[0.0, 0.0, 0.0]; self.topology.n_nodes];
        let mut weights = vec![0.0; self.topology.n_nodes];

        for (element_index, element) in self.topology.elements.iter().enumerate() {
            if !self.topology.magnetic_element_mask[element_index] {
                continue;
            }
            let gradients = self.topology.grad_phi[element_index];
            let mut grad_u = [0.0, 0.0, 0.0];
            for local_index in 0..4 {
                grad_u = add(
                    grad_u,
                    scale(gradients[local_index], potential[element[local_index] as usize]),
                );
            }
            let h_elem = scale(grad_u, -1.0);
            let volume = self.topology.element_volumes[element_index];
            for &node in element {
                let node = node as usize;
                field[node] = add(field[node], scale(h_elem, volume / 4.0));
                weights[node] += volume / 4.0;
            }
        }

        for (index, value) in field.iter_mut().enumerate() {
            if weights[index] > 0.0 {
                *value = scale(*value, 1.0 / weights[index]);
            }
        }

        field
    }

    fn external_field_vectors(&self) -> Vec<Vector3> {
        let external = self.terms.external_field.unwrap_or([0.0, 0.0, 0.0]);
        self.topology
            .magnetic_node_volumes
            .iter()
            .map(|volume| if *volume > 0.0 { external } else { [0.0, 0.0, 0.0] })
            .collect()
    }

    fn external_energy_from_fields(
        &self,
        magnetization: &[Vector3],
        external_field: &[Vector3],
    ) -> f64 {
        magnetization
            .iter()
            .zip(external_field.iter())
            .zip(self.topology.magnetic_node_volumes.iter())
            .map(|((m, h), node_volume)| {
                -MU0 * self.material.saturation_magnetisation * dot(*m, *h) * node_volume
            })
            .sum()
    }

    fn llg_rhs_from_vectors(&self, magnetization: &[Vector3]) -> Result<Vec<Vector3>> {
        let observables = self.observe_vectors(magnetization)?;
        Ok(magnetization
            .iter()
            .enumerate()
            .map(|(node, m)| {
                if self.topology.magnetic_node_volumes[node] > 0.0 {
                    self.llg_rhs_from_field(*m, observables.effective_field[node])
                } else {
                    [0.0, 0.0, 0.0]
                }
            })
            .collect())
    }

    fn llg_rhs_from_field(&self, magnetization: Vector3, field: Vector3) -> Vector3 {
        let alpha = self.material.damping;
        let gamma_bar = self.dynamics.gyromagnetic_ratio / (1.0 + alpha * alpha);
        let precession = cross(magnetization, field);
        let damping = cross(magnetization, precession);
        scale(add(precession, scale(damping, alpha)), -gamma_bar)
    }
}

fn inverse_transpose_3x3(columns: [[f64; 3]; 3], det: f64) -> [[f64; 3]; 3] {
    let a = columns[0][0];
    let b = columns[1][0];
    let c = columns[2][0];
    let d = columns[0][1];
    let e = columns[1][1];
    let f = columns[2][1];
    let g = columns[0][2];
    let h = columns[1][2];
    let i = columns[2][2];

    let inv_det = 1.0 / det;
    let inv = [
        [
            (e * i - f * h) * inv_det,
            (c * h - b * i) * inv_det,
            (b * f - c * e) * inv_det,
        ],
        [
            (f * g - d * i) * inv_det,
            (a * i - c * g) * inv_det,
            (c * d - a * f) * inv_det,
        ],
        [
            (d * h - e * g) * inv_det,
            (b * g - a * h) * inv_det,
            (a * e - b * d) * inv_det,
        ],
    ];

    [
        [inv[0][0], inv[1][0], inv[2][0]],
        [inv[0][1], inv[1][1], inv[2][1]],
        [inv[0][2], inv[1][2], inv[2][2]],
    ]
}

fn magnetic_element_mask_from_markers(markers: &[u32]) -> Vec<bool> {
    let has_marker_one = markers.iter().any(|&marker| marker == 1);
    let has_non_one = markers.iter().any(|&marker| marker != 1);
    if has_marker_one && has_non_one {
        markers.iter().map(|&marker| marker == 1).collect()
    } else {
        vec![true; markers.len()]
    }
}

fn add_tet_local_matrix(
    matrix: &mut [f64],
    n_nodes: usize,
    element: &[u32; 4],
    local: &[[f64; 4]; 4],
) {
    for i in 0..4 {
        let row = element[i] as usize;
        for j in 0..4 {
            let col = element[j] as usize;
            matrix[dense_index(n_nodes, row, col)] += local[i][j];
        }
    }
}

fn add_triangle_local_matrix(
    matrix: &mut [f64],
    n_nodes: usize,
    face: &[u32; 3],
    local: &[[f64; 3]; 3],
) {
    for i in 0..3 {
        let row = face[i] as usize;
        for j in 0..3 {
            let col = face[j] as usize;
            matrix[dense_index(n_nodes, row, col)] += local[i][j];
        }
    }
}

fn triangle_area(p0: Vector3, p1: Vector3, p2: Vector3) -> f64 {
    0.5 * norm(cross(sub(p1, p0), sub(p2, p0)))
}

fn equivalent_radius(volume: f64) -> f64 {
    ((3.0 * volume) / (4.0 * PI)).cbrt()
}

fn dense_index(n: usize, row: usize, col: usize) -> usize {
    row * n + col
}

fn solve_dense_linear_system(matrix: &[f64], rhs: &[f64]) -> Result<Vec<f64>> {
    let n = rhs.len();
    if matrix.len() != n * n {
        return Err(EngineError::new("dense linear system has inconsistent dimensions"));
    }
    if n == 0 {
        return Ok(Vec::new());
    }

    let mut a = matrix.to_vec();
    let mut b = rhs.to_vec();

    for pivot in 0..n {
        let mut pivot_row = pivot;
        let mut pivot_value = a[dense_index(n, pivot, pivot)].abs();
        for row in (pivot + 1)..n {
            let value = a[dense_index(n, row, pivot)].abs();
            if value > pivot_value {
                pivot_value = value;
                pivot_row = row;
            }
        }
        if pivot_value <= 1e-30 {
            return Err(EngineError::new(
                "FEM demag dense solve encountered a singular system",
            ));
        }
        if pivot_row != pivot {
            for col in pivot..n {
                a.swap(dense_index(n, pivot, col), dense_index(n, pivot_row, col));
            }
            b.swap(pivot, pivot_row);
        }

        let pivot_diagonal = a[dense_index(n, pivot, pivot)];
        for row in (pivot + 1)..n {
            let factor = a[dense_index(n, row, pivot)] / pivot_diagonal;
            if factor == 0.0 {
                continue;
            }
            a[dense_index(n, row, pivot)] = 0.0;
            for col in (pivot + 1)..n {
                a[dense_index(n, row, col)] -= factor * a[dense_index(n, pivot, col)];
            }
            b[row] -= factor * b[pivot];
        }
    }

    let mut x = vec![0.0; n];
    for row in (0..n).rev() {
        let mut sum = b[row];
        for col in (row + 1)..n {
            sum -= a[dense_index(n, row, col)] * x[col];
        }
        x[row] = sum / a[dense_index(n, row, row)];
    }

    Ok(x)
}

fn max_norm(values: &[Vector3]) -> f64 {
    values.iter().map(|value| norm(*value)).fold(0.0, f64::max)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DEFAULT_GYROMAGNETIC_RATIO, EffectiveFieldTerms};

    fn unit_tet_problem() -> FemLlgProblem {
        let mesh = MeshIR {
            mesh_name: "unit_tet".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            elements: vec![[0, 1, 2, 3]],
            element_markers: vec![1],
            boundary_faces: vec![[0, 1, 2]],
            boundary_markers: vec![1],
        };
        let topology = MeshTopology::from_ir(&mesh).expect("unit tet topology");
        FemLlgProblem::with_terms(
            topology,
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: true,
                demag: false,
                external_field: None,
            },
        )
    }

    fn coarse_box_problem(demag: bool) -> FemLlgProblem {
        let mesh = MeshIR {
            mesh_name: "box_40x20x10_coarse".to_string(),
            nodes: vec![
                [-20e-9, -10e-9, -5e-9],
                [20e-9, -10e-9, -5e-9],
                [20e-9, 10e-9, -5e-9],
                [-20e-9, 10e-9, -5e-9],
                [-20e-9, -10e-9, 5e-9],
                [20e-9, -10e-9, 5e-9],
                [20e-9, 10e-9, 5e-9],
                [-20e-9, 10e-9, 5e-9],
            ],
            elements: vec![
                [0, 1, 2, 6],
                [0, 2, 3, 6],
                [0, 3, 7, 6],
                [0, 7, 4, 6],
                [0, 4, 5, 6],
                [0, 5, 1, 6],
            ],
            element_markers: vec![1, 1, 1, 1, 1, 1],
            boundary_faces: vec![
                [0, 1, 2],
                [0, 1, 5],
                [1, 2, 6],
                [0, 2, 3],
                [2, 3, 6],
                [0, 3, 7],
                [3, 6, 7],
                [0, 4, 7],
                [4, 6, 7],
                [0, 4, 5],
                [4, 5, 6],
                [1, 5, 6],
            ],
            boundary_markers: vec![1; 12],
        };
        let topology = MeshTopology::from_ir(&mesh).expect("coarse box topology");
        FemLlgProblem::with_terms(
            topology,
            MaterialParameters::new(800e3, 13e-12, 0.5).expect("material"),
            LlgConfig::new(DEFAULT_GYROMAGNETIC_RATIO, TimeIntegrator::Heun).expect("llg"),
            EffectiveFieldTerms {
                exchange: true,
                demag,
                external_field: None,
            },
        )
    }

    #[test]
    fn uniform_state_has_zero_exchange_field() {
        let problem = unit_tet_problem();
        let state = problem
            .new_state(vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes])
            .expect("uniform state");

        let field = problem.exchange_field(&state).expect("exchange field");
        for value in field {
            assert!(norm(value) < 1e-20, "uniform field should vanish, got {:?}", value);
        }
    }

    #[test]
    fn zeeman_only_relaxation_reduces_external_energy() {
        let mut problem = unit_tet_problem();
        problem.terms.exchange = false;
        problem.terms.external_field = Some([0.0, 0.0, 1.0e5]);

        let mut state = problem
            .new_state(vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes])
            .expect("state");
        let initial_energy = problem.observe(&state).expect("observables").external_energy_joules;
        for _ in 0..20 {
            problem.step(&mut state, 1e-13).expect("step");
        }
        let final_energy = problem.observe(&state).expect("observables").external_energy_joules;
        assert!(
            final_energy <= initial_energy,
            "external energy should decrease: {} -> {}",
            initial_energy,
            final_energy
        );
    }

    #[test]
    fn exchange_relaxation_reduces_exchange_energy() {
        let problem = unit_tet_problem();
        let mut state = problem
            .new_state(vec![
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
            ])
            .expect("state");
        let initial_energy = problem.observe(&state).expect("observables").exchange_energy_joules;
        for _ in 0..20 {
            problem.step(&mut state, 1e-13).expect("step");
        }
        let final_energy = problem.observe(&state).expect("observables").exchange_energy_joules;
        assert!(
            final_energy <= initial_energy,
            "exchange energy should decrease: {} -> {}",
            initial_energy,
            final_energy
        );
    }

    #[test]
    fn demag_energy_is_non_negative_for_uniform_box_state() {
        let problem = coarse_box_problem(true);
        let state = problem
            .new_state(vec![[0.0, 0.0, 1.0]; problem.topology.n_nodes])
            .expect("state");
        let observables = problem.observe(&state).expect("observables");
        assert!(observables.demag_energy_joules >= 0.0);
        assert!(observables.max_demag_field_amplitude > 0.0);
    }

    #[test]
    fn out_of_plane_box_demag_energy_exceeds_in_plane_energy() {
        let problem = coarse_box_problem(true);
        let z_state = problem
            .new_state(vec![[0.0, 0.0, 1.0]; problem.topology.n_nodes])
            .expect("z state");
        let x_state = problem
            .new_state(vec![[1.0, 0.0, 0.0]; problem.topology.n_nodes])
            .expect("x state");

        let z_energy = problem.observe(&z_state).expect("z observables").demag_energy_joules;
        let x_energy = problem.observe(&x_state).expect("x observables").demag_energy_joules;
        assert!(
            z_energy > x_energy,
            "flat box should penalize out-of-plane state more strongly: {} <= {}",
            z_energy,
            x_energy
        );
    }
}
