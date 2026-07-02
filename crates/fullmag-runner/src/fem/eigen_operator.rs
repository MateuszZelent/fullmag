use crate::eigen::assembly_scalar::AssembledScalarOperator;
use crate::fem::eigen_anisotropy::volume_anisotropy_field;
use crate::fem::eigen_output::{add_vector, cross, dot, norm, normalize_vector};
use crate::fem::eigen_reduction::ReductionMap;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::{sub, EffectiveFieldObservables, Vector3, MU0};
use fullmag_ir::{FemEigenPlanIR, KSamplingIR};
use nalgebra::DMatrix;
use num_complex::Complex64;

pub(crate) fn assemble_projected_scalar_operator_real(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
) -> AssembledScalarOperator {
    let active_count = reduction.active_nodes.len();
    let mut stiffness = DMatrix::<f64>::zeros(active_count, active_count);
    let mut mass = DMatrix::<f64>::zeros(active_count, active_count);
    let parallel_field = observables
        .magnetization
        .iter()
        .enumerate()
        .map(|(index, m)| {
            let mut selected_field = [0.0, 0.0, 0.0];
            if plan.enable_exchange {
                selected_field = add_vector(selected_field, observables.exchange_field[index]);
            }
            if plan.enable_demag {
                selected_field = add_vector(selected_field, observables.demag_field[index]);
            }
            if plan.external_field.is_some() {
                selected_field = add_vector(selected_field, observables.external_field[index]);
            }
            selected_field = add_vector(selected_field, volume_anisotropy_field(*m, plan));
            dot(*m, selected_field).max(0.0)
        })
        .collect::<Vec<_>>();

    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        let local_mass = [
            [
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
            ],
        ];
        let local_shift = [
            parallel_field[element[0] as usize],
            parallel_field[element[1] as usize],
            parallel_field[element[2] as usize],
            parallel_field[element[3] as usize],
        ];
        for i in 0..4 {
            let Some(row) = reduction.node_map[element[i] as usize] else {
                continue;
            };
            for j in 0..4 {
                let Some(col) = reduction.node_map[element[j] as usize] else {
                    continue;
                };
                mass[(row, col)] += local_mass[i][j];
                if plan.enable_exchange {
                    stiffness[(row, col)] += topology.element_stiffness[element_index][i][j];
                }
                let shift = 0.5 * (local_shift[i] + local_shift[j]);
                stiffness[(row, col)] += local_mass[i][j] * shift;
            }
        }
    }

    add_surface_anisotropy_real(plan, topology, reduction, equilibrium, &mut stiffness);
    add_dmi_real(plan, topology, reduction, &mut stiffness);

    AssembledScalarOperator::new(stiffness, mass)
}

/// Assemble the full 2x2 Herring-Kittel block operator.
///
/// The operator is 2N x 2N with blocks:
/// ```text
///   K = [ K_11  K_12 ]    M_block = [ M  0 ]
///       [ K_21  K_22 ]              [ 0  M ]
/// ```
///
/// Block layout: rows/cols [0..N) correspond to the e1 tangent component,
/// rows/cols [N..2N) correspond to the e2 tangent component.
pub(crate) fn assemble_full_2x2_operator_real(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
    bases: &[(Vector3, Vector3)],
) -> (DMatrix<f64>, DMatrix<f64>) {
    let n = reduction.active_nodes.len();
    let dim = 2 * n;
    let mut stiffness = DMatrix::<f64>::zeros(dim, dim);
    let mut mass = DMatrix::<f64>::zeros(dim, dim);

    let field_blocks: Vec<[f64; 4]> = observables
        .magnetization
        .iter()
        .enumerate()
        .map(|(idx, m)| {
            let mut h_eff = [0.0, 0.0, 0.0];
            if plan.enable_exchange {
                h_eff = add_vector(h_eff, observables.exchange_field[idx]);
            }
            if plan.enable_demag {
                h_eff = add_vector(h_eff, observables.demag_field[idx]);
            }
            if plan.external_field.is_some() {
                h_eff = add_vector(h_eff, observables.external_field[idx]);
            }
            h_eff = add_vector(h_eff, volume_anisotropy_field(*m, plan));

            let (e1, e2) = bases[idx];
            let h_parallel = dot(*m, h_eff).max(0.0);
            let h_e1 = dot(e1, h_eff);
            let h_e2 = dot(e2, h_eff);
            [
                h_parallel,
                h_e1 * h_e2 / (h_parallel.max(1e-30)),
                h_e1 * h_e2 / (h_parallel.max(1e-30)),
                h_parallel,
            ]
        })
        .collect();

    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        let local_mass = [
            [
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
            ],
        ];
        for i in 0..4 {
            let node_i = element[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            for j in 0..4 {
                let node_j = element[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let m_ij = local_mass[i][j];
                let fb_i = &field_blocks[node_i];
                let fb_j = &field_blocks[node_j];

                mass[(row, col)] += m_ij;
                mass[(row + n, col + n)] += m_ij;

                if plan.enable_exchange {
                    let ex = topology.element_stiffness[element_index][i][j];
                    stiffness[(row, col)] += ex;
                    stiffness[(row + n, col + n)] += ex;
                }

                let h11 = 0.5 * (fb_i[0] + fb_j[0]);
                stiffness[(row, col)] += m_ij * h11;

                let h22 = 0.5 * (fb_i[3] + fb_j[3]);
                stiffness[(row + n, col + n)] += m_ij * h22;

                let h12 = 0.5 * (fb_i[1] + fb_j[1]);
                stiffness[(row, col + n)] += m_ij * h12;

                let h21 = 0.5 * (fb_i[2] + fb_j[2]);
                stiffness[(row + n, col)] += m_ij * h21;
            }
        }
    }

    add_surface_anisotropy_2x2(plan, topology, reduction, equilibrium, &mut stiffness, n);
    add_dmi_2x2(plan, topology, reduction, &mut stiffness, n);

    (stiffness, mass)
}

pub(crate) fn assemble_projected_scalar_operator_complex(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    observables: &EffectiveFieldObservables,
    equilibrium: &[Vector3],
) -> (Vec<Vec<Complex64>>, Vec<Vec<Complex64>>) {
    let active_count = reduction.active_nodes.len();
    let mut stiffness = vec![vec![Complex64::new(0.0, 0.0); active_count]; active_count];
    let mut mass = vec![vec![Complex64::new(0.0, 0.0); active_count]; active_count];
    let parallel_field = observables
        .magnetization
        .iter()
        .enumerate()
        .map(|(index, m)| {
            let mut selected_field = [0.0, 0.0, 0.0];
            if plan.enable_exchange {
                selected_field = add_vector(selected_field, observables.exchange_field[index]);
            }
            if plan.enable_demag {
                selected_field = add_vector(selected_field, observables.demag_field[index]);
            }
            if plan.external_field.is_some() {
                selected_field = add_vector(selected_field, observables.external_field[index]);
            }
            selected_field = add_vector(selected_field, volume_anisotropy_field(*m, plan));
            dot(*m, selected_field).max(0.0)
        })
        .collect::<Vec<_>>();

    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let volume = topology.element_volumes[element_index];
        let local_mass = [
            [
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
                volume / 20.0,
            ],
            [
                volume / 20.0,
                volume / 20.0,
                volume / 20.0,
                2.0 * volume / 20.0,
            ],
        ];
        let local_shift = [
            parallel_field[element[0] as usize],
            parallel_field[element[1] as usize],
            parallel_field[element[2] as usize],
            parallel_field[element[3] as usize],
        ];
        for i in 0..4 {
            let node_i = element[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            let phase_i = reduction.node_phases[node_i];
            for j in 0..4 {
                let node_j = element[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let phase_j = reduction.node_phases[node_j];
                let coeff = phase_i.conj() * phase_j;
                mass[row][col] += coeff * local_mass[i][j];
                if plan.enable_exchange {
                    stiffness[row][col] += coeff * topology.element_stiffness[element_index][i][j];
                }
                let shift = 0.5 * (local_shift[i] + local_shift[j]);
                stiffness[row][col] += coeff * (local_mass[i][j] * shift);
            }
        }
    }

    add_surface_anisotropy_complex(plan, topology, reduction, equilibrium, &mut stiffness);
    add_dmi_complex(plan, reduction, &mut stiffness, plan.k_sampling.as_ref());
    (stiffness, mass)
}

fn add_surface_anisotropy_real(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut DMatrix<f64>,
) {
    let Some((axis, coefficient)) = surface_anisotropy_config(plan) else {
        return;
    };
    for face in &plan.mesh.boundary_faces {
        let local = triangle_surface_matrix(face, &plan.mesh.nodes, axis, equilibrium, coefficient);
        for i in 0..3 {
            let Some(row) = reduction.node_map[face[i] as usize] else {
                continue;
            };
            for j in 0..3 {
                let Some(col) = reduction.node_map[face[j] as usize] else {
                    continue;
                };
                stiffness[(row, col)] += local[i][j];
            }
        }
    }
}

fn add_surface_anisotropy_complex(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut [Vec<Complex64>],
) {
    let Some((axis, coefficient)) = surface_anisotropy_config(plan) else {
        return;
    };
    for face in &plan.mesh.boundary_faces {
        let local = triangle_surface_matrix(face, &plan.mesh.nodes, axis, equilibrium, coefficient);
        for i in 0..3 {
            let node_i = face[i] as usize;
            let Some(row) = reduction.node_map[node_i] else {
                continue;
            };
            let phase_i = reduction.node_phases[node_i];
            for j in 0..3 {
                let node_j = face[j] as usize;
                let Some(col) = reduction.node_map[node_j] else {
                    continue;
                };
                let phase_j = reduction.node_phases[node_j];
                stiffness[row][col] += phase_i.conj() * phase_j * local[i][j];
            }
        }
    }
}

fn add_dmi_real(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    stiffness: &mut DMatrix<f64>,
) {
    let scale = plan.interfacial_dmi.map(f64::abs).unwrap_or(0.0)
        + plan.bulk_dmi.map(f64::abs).unwrap_or(0.0);
    if scale <= 0.0 {
        return;
    }
    let coeff =
        scale / (MU0 * plan.material.saturation_magnetisation.max(1e-30) * plan.hmax.max(1e-30));
    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let gradients = &topology.grad_phi[element_index];
        for i in 0..4 {
            let Some(row) = reduction.node_map[element[i] as usize] else {
                continue;
            };
            for j in 0..4 {
                let Some(col) = reduction.node_map[element[j] as usize] else {
                    continue;
                };
                let skew = coeff
                    * (gradients[i][0] * gradients[j][1] - gradients[i][1] * gradients[j][0])
                    * topology.element_volumes[element_index];
                stiffness[(row, col)] += skew;
            }
        }
    }
}

fn add_dmi_complex(
    plan: &FemEigenPlanIR,
    reduction: &ReductionMap,
    stiffness: &mut [Vec<Complex64>],
    k_sampling: Option<&KSamplingIR>,
) {
    let interfacial = plan.interfacial_dmi.unwrap_or(0.0);
    let bulk = plan.bulk_dmi.unwrap_or(0.0);
    if interfacial == 0.0 && bulk == 0.0 {
        return;
    }
    let k = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let ms = plan.material.saturation_magnetisation.max(1e-30);
    let interfacial_coeff = interfacial / (MU0 * ms);
    let bulk_coeff = bulk / (MU0 * ms);
    let nonreciprocal_shift = interfacial_coeff * (k[0] + k[1]) + bulk_coeff * (k[0] + k[1] + k[2]);
    if nonreciprocal_shift.abs() <= 0.0 {
        return;
    }
    for index in 0..reduction.active_nodes.len() {
        stiffness[index][index] += Complex64::new(nonreciprocal_shift, 0.0);
    }
}

fn add_surface_anisotropy_2x2(
    plan: &FemEigenPlanIR,
    _topology: &MeshTopology,
    reduction: &ReductionMap,
    equilibrium: &[Vector3],
    stiffness: &mut DMatrix<f64>,
    n: usize,
) {
    let Some((axis, coefficient)) = surface_anisotropy_config(plan) else {
        return;
    };
    for face in &plan.mesh.boundary_faces {
        let local = triangle_surface_matrix(face, &plan.mesh.nodes, axis, equilibrium, coefficient);
        for i in 0..3 {
            let Some(row) = reduction.node_map[face[i] as usize] else {
                continue;
            };
            for j in 0..3 {
                let Some(col) = reduction.node_map[face[j] as usize] else {
                    continue;
                };
                stiffness[(row, col)] += local[i][j];
                stiffness[(row + n, col + n)] += local[i][j];
            }
        }
    }
}

fn add_dmi_2x2(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    reduction: &ReductionMap,
    stiffness: &mut DMatrix<f64>,
    n: usize,
) {
    let scale = plan.interfacial_dmi.map(f64::abs).unwrap_or(0.0)
        + plan.bulk_dmi.map(f64::abs).unwrap_or(0.0);
    if scale <= 0.0 {
        return;
    }
    let coeff =
        scale / (MU0 * plan.material.saturation_magnetisation.max(1e-30) * plan.hmax.max(1e-30));
    for (element_index, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_index] {
            continue;
        }
        let gradients = &topology.grad_phi[element_index];
        for i in 0..4 {
            let Some(row) = reduction.node_map[element[i] as usize] else {
                continue;
            };
            for j in 0..4 {
                let Some(col) = reduction.node_map[element[j] as usize] else {
                    continue;
                };
                let skew = coeff
                    * (gradients[i][0] * gradients[j][1] - gradients[i][1] * gradients[j][0])
                    * topology.element_volumes[element_index];
                stiffness[(row, col)] += skew;
                stiffness[(row + n, col + n)] += skew;
            }
        }
    }
}

fn surface_anisotropy_config(plan: &FemEigenPlanIR) -> Option<(Vector3, f64)> {
    let ks = plan.spin_wave_bc.surface_anisotropy_ks()?;
    let axis = normalize_vector(plan.spin_wave_bc.surface_anisotropy_axis()?);
    let coefficient = ks / (MU0 * plan.material.saturation_magnetisation.max(1e-30));
    Some((axis, coefficient))
}

fn triangle_surface_matrix(
    face: &[u32; 3],
    nodes: &[[f64; 3]],
    axis: Vector3,
    equilibrium: &[Vector3],
    coefficient: f64,
) -> [[f64; 3]; 3] {
    let p0 = nodes[face[0] as usize];
    let p1 = nodes[face[1] as usize];
    let p2 = nodes[face[2] as usize];
    let area = 0.5 * norm(cross(sub(p1, p0), sub(p2, p0)));
    let local_mass = [
        [2.0 * area / 12.0, area / 12.0, area / 12.0],
        [area / 12.0, 2.0 * area / 12.0, area / 12.0],
        [area / 12.0, area / 12.0, 2.0 * area / 12.0],
    ];
    let alignment = face
        .iter()
        .map(|node| {
            let m = equilibrium[*node as usize];
            1.0 - dot(m, axis).powi(2)
        })
        .sum::<f64>()
        / 3.0;
    let mut local = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            local[i][j] = coefficient * alignment.max(0.0) * local_mass[i][j];
        }
    }
    local
}

pub(crate) fn tangent_bases(equilibrium: &[Vector3]) -> Vec<(Vector3, Vector3)> {
    equilibrium
        .iter()
        .map(|m| {
            let reference = if m[2].abs() < 0.9 {
                [0.0, 0.0, 1.0]
            } else {
                [0.0, 1.0, 0.0]
            };
            let e1 = normalize_vector(cross(reference, *m));
            let e2 = normalize_vector(cross(*m, e1));
            (e1, e2)
        })
        .collect()
}
