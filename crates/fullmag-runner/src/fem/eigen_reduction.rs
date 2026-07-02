use fullmag_engine::fem::MeshTopology;
use fullmag_engine::periodic::constraints::PeriodicDofMap;
use fullmag_ir::{KSamplingIR, SpinWaveBoundaryConditionIR, SpinWaveBoundaryKindIR};
use num_complex::Complex64;

use crate::fem::eigen_output::spin_wave_bc_label;
use crate::types::RunError;

#[derive(Debug, Clone)]
pub(crate) struct ReductionMap {
    pub(crate) active_nodes: Vec<usize>,
    pub(crate) node_map: Vec<Option<usize>>,
    pub(crate) node_phases: Vec<Complex64>,
    pub(crate) complex_reduction: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct PhaseGroups {
    pub(crate) roots: Vec<usize>,
    pub(crate) phases: Vec<Complex64>,
}

pub(crate) fn build_reduction_map(
    topology: &MeshTopology,
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
    k_sampling: Option<&KSamplingIR>,
) -> Result<ReductionMap, RunError> {
    let pinned: std::collections::HashSet<usize> =
        if matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Pinned) {
            magnetic_boundary_nodes(topology)
        } else {
            std::collections::HashSet::new()
        };

    let phase_groups = phase_reduction(topology, spin_wave_bc, k_sampling)?;

    let mut active_nodes = Vec::new();
    let mut mapping = vec![None; topology.n_nodes];
    let mut node_phases = vec![Complex64::new(1.0, 0.0); topology.n_nodes];

    if let Some(groups) = phase_groups {
        let mut root_to_reduced = std::collections::BTreeMap::new();
        for (node_index, volume) in topology.magnetic_node_volumes.iter().enumerate() {
            if *volume <= 0.0 || pinned.contains(&node_index) {
                continue;
            }
            let root = groups.roots[node_index];
            let reduced_index = if let Some(existing) = root_to_reduced.get(&root) {
                *existing
            } else {
                let next = active_nodes.len();
                root_to_reduced.insert(root, next);
                active_nodes.push(root);
                next
            };
            mapping[node_index] = Some(reduced_index);
            node_phases[node_index] = groups.phases[node_index];
        }
        Ok(ReductionMap {
            active_nodes,
            node_map: mapping,
            node_phases,
            complex_reduction: matches!(spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet)
                && !is_gamma_k_sampling(k_sampling),
        })
    } else {
        for (node_index, volume) in topology.magnetic_node_volumes.iter().enumerate() {
            if *volume <= 0.0 || pinned.contains(&node_index) {
                continue;
            }
            let reduced_index = active_nodes.len();
            active_nodes.push(node_index);
            mapping[node_index] = Some(reduced_index);
        }
        Ok(ReductionMap {
            active_nodes,
            node_map: mapping,
            node_phases,
            complex_reduction: false,
        })
    }
}

fn is_gamma_k_sampling(k_sampling: Option<&KSamplingIR>) -> bool {
    match k_sampling {
        None => true,
        Some(KSamplingIR::Single { k_vector }) => k_vector.iter().all(|value| *value == 0.0),
        Some(KSamplingIR::Path { .. }) => false,
    }
}

pub(crate) fn phase_reduction(
    topology: &MeshTopology,
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
    k_sampling: Option<&KSamplingIR>,
) -> Result<Option<PhaseGroups>, RunError> {
    let kind = spin_wave_bc.kind();
    if !matches!(
        kind,
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) {
        return Ok(None);
    }
    if topology.periodic_node_pairs.is_empty() {
        return Err(RunError {
            message: format!(
                "spin_wave_bc.kind='{kind}' requires mesh.periodic_node_pairs metadata — \
                 the mesh contains no periodic node pairs; add periodic_node_pairs to the mesh IR \
                 or use spin_wave_bc.kind='free'",
                kind = match kind {
                    SpinWaveBoundaryKindIR::Periodic => "periodic",
                    _ => "floquet",
                }
            ),
        });
    }

    let requested_pair_ids = spin_wave_bc.boundary_pair_ids();
    let k_vector = match (kind, k_sampling) {
        (SpinWaveBoundaryKindIR::Floquet, Some(KSamplingIR::Single { k_vector })) => {
            Some(*k_vector)
        }
        (SpinWaveBoundaryKindIR::Floquet, Some(KSamplingIR::Path { .. })) => {
            return Err(RunError {
                message: "floquet spin-wave BC with KSampling::Path is not yet supported in single-k runner; use the multi-k orchestrator".to_string(),
            });
        }
        (SpinWaveBoundaryKindIR::Floquet, None) => {
            return Err(RunError {
                message: "floquet spin-wave BC requires k_sampling=Single{...}".to_string(),
            });
        }
        _ => None,
    };

    let selected_pairs = topology
        .periodic_node_pairs
        .iter()
        .filter(|(pair_id, _, _)| {
            requested_pair_ids.is_empty()
                || requested_pair_ids
                    .iter()
                    .any(|requested| *requested == pair_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    if selected_pairs.is_empty() {
        return Err(RunError {
            message: format!(
                "spin_wave_bc.kind='{}' did not match any mesh.periodic_node_pairs pair_id",
                spin_wave_bc_label(spin_wave_bc.clone())
            ),
        });
    }

    let dof_map = if let Some(k) = k_vector {
        PeriodicDofMap::from_periodic_pair_tuples_floquet(
            topology.n_nodes,
            &selected_pairs,
            &topology.periodic_boundary_pairs,
            &topology.coords,
            k,
            spin_wave_bc.phase_convention(),
        )
    } else {
        PeriodicDofMap::from_periodic_pair_tuples_static(topology.n_nodes, &selected_pairs)
    }
    .map_err(|error| RunError {
        message: format!("failed to build periodic DOF map: {}", error.message),
    })?;

    let roots = (0..topology.n_nodes)
        .map(|node| dof_map.representative_nodes[dof_map.reduced_node(node)])
        .collect::<Vec<_>>();
    let phases = (0..topology.n_nodes)
        .map(|node| {
            let phase = dof_map.phase(node);
            Complex64::new(phase.re, phase.im)
        })
        .collect::<Vec<_>>();

    Ok(Some(PhaseGroups { roots, phases }))
}

/// Returns the set of indices of nodes that lie on the surface of the magnetic
/// region, i.e. the surface relevant for spin-wave pinning BC.
fn magnetic_boundary_nodes(topology: &MeshTopology) -> std::collections::HashSet<usize> {
    let has_airbox = topology
        .magnetic_element_mask
        .iter()
        .any(|&is_magnetic| !is_magnetic);

    if !has_airbox {
        return topology
            .boundary_nodes
            .iter()
            .map(|&n| n as usize)
            .collect();
    }

    let mut in_airbox_element: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for (element_idx, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_idx] {
            for &node in element.iter() {
                in_airbox_element.insert(node as usize);
            }
        }
    }
    (0..topology.n_nodes)
        .filter(|&i| topology.magnetic_node_volumes[i] > 0.0 && in_airbox_element.contains(&i))
        .collect()
}
