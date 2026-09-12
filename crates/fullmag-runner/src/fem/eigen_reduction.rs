use super::eigen_constants::TANGENT_FRAME_IDENTITY_TOLERANCE;
use super::eigen_math::dot;
use super::eigen_projection::tangent_bases;
use crate::types::RunError;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::periodic::constraints::PeriodicDofMap;
use fullmag_engine::Vector3;
use fullmag_ir::FemEigenPlanIR;
use fullmag_ir::KSamplingIR;
use fullmag_ir::SpinWaveBoundaryConditionIR;
use fullmag_ir::SpinWaveBoundaryKindIR;
use num_complex::Complex64;

#[derive(Debug, Clone)]
pub(super) struct ReductionMap {
    pub(super) active_nodes: Vec<usize>,
    pub(super) node_map: Vec<Option<usize>>,
    pub(super) node_phases: Vec<Complex64>,
    pub(super) complex_reduction: bool,
}

pub(super) fn build_reduction_map(
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

pub(super) fn is_gamma_k_sampling(k_sampling: Option<&KSamplingIR>) -> bool {
    match k_sampling {
        None => true,
        Some(KSamplingIR::Single { k_vector }) => k_vector.iter().all(|value| *value == 0.0),
        Some(KSamplingIR::Path { points, .. }) => {
            !points.is_empty()
                && points
                    .iter()
                    .all(|point| point.k_vector.iter().all(|value| *value == 0.0))
        }
    }
}

pub(super) fn k_sampling_contains_nonzero(k_sampling: Option<&KSamplingIR>) -> bool {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => k_vector.iter().any(|value| *value != 0.0),
        Some(KSamplingIR::Path { points, .. }) => points
            .iter()
            .any(|point| point.k_vector.iter().any(|value| *value != 0.0)),
        None => false,
    }
}

pub(super) fn validate_tangent_frame_transport_support(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    equilibrium: &[Vector3],
) -> Result<(), RunError> {
    let kind = plan.spin_wave_bc.kind();
    if !matches!(
        kind,
        SpinWaveBoundaryKindIR::Periodic | SpinWaveBoundaryKindIR::Floquet
    ) || topology.periodic_node_pairs.is_empty()
    {
        return Ok(());
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
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
        return Ok(());
    }
    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        return Ok(());
    }
    reject_nonidentity_tangent_frame_transport(topology, &selected_pairs, equilibrium)
}

#[derive(Debug, Clone)]
pub(super) struct PhaseGroups {
    pub(super) roots: Vec<usize>,
    pub(super) phases: Vec<Complex64>,
}

pub(super) fn phase_reduction(
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
                match kind {
                    SpinWaveBoundaryKindIR::Periodic => "periodic",
                    _ => "floquet",
                }
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

fn reject_nonidentity_tangent_frame_transport(
    topology: &MeshTopology,
    selected_pairs: &[(String, u32, u32)],
    equilibrium: &[Vector3],
) -> Result<(), RunError> {
    if equilibrium.len() < topology.n_nodes {
        return Err(RunError {
            message: format!(
                "periodic/Floquet modal tangent-frame transport cannot be validated: \
                 equilibrium has {} nodes but mesh has {} nodes",
                equilibrium.len(),
                topology.n_nodes
            ),
        });
    }
    let bases = tangent_bases(equilibrium);
    let mut max_mismatch: f64 = 0.0;
    let mut worst_pair: Option<(&str, usize, usize)> = None;
    for (pair_id, node_a, node_b) in selected_pairs {
        let node_a = *node_a as usize;
        let node_b = *node_b as usize;
        if topology.magnetic_node_volumes[node_a] <= 0.0
            || topology.magnetic_node_volumes[node_b] <= 0.0
        {
            continue;
        }
        let mismatch = tangent_frame_identity_mismatch(bases[node_a], bases[node_b]);
        if mismatch > max_mismatch {
            max_mismatch = mismatch;
            worst_pair = Some((pair_id.as_str(), node_a, node_b));
        }
    }
    if max_mismatch > TANGENT_FRAME_IDENTITY_TOLERANCE {
        let (pair_id, node_a, node_b) = worst_pair.unwrap_or(("unknown", 0, 0));
        return Err(RunError {
            message: format!(
                "periodic/Floquet modal tangent-frame transport requires full \
                 phase*(T_dst^T T_src) support; the current reference runner only \
                 supports identity tangent-frame transport. pair_id='{pair_id}' \
                 node_a={node_a} node_b={node_b} \
                 tangent_frame_mismatch={max_mismatch:.6e} \
                 tolerance={TANGENT_FRAME_IDENTITY_TOLERANCE:.6e}"
            ),
        });
    }
    Ok(())
}

pub(super) fn tangent_frame_identity_mismatch(
    src: (Vector3, Vector3),
    dst: (Vector3, Vector3),
) -> f64 {
    let transport = tangent_transport_matrix(src, dst);
    ((transport[0][0] - 1.0).powi(2)
        + transport[0][1].powi(2)
        + transport[1][0].powi(2)
        + (transport[1][1] - 1.0).powi(2))
    .sqrt()
}

pub(super) fn tangent_transport_matrix(
    src: (Vector3, Vector3),
    dst: (Vector3, Vector3),
) -> [[f64; 2]; 2] {
    let (src_e1, src_e2) = src;
    let (dst_e1, dst_e2) = dst;
    [
        [dot(dst_e1, src_e1), dot(dst_e1, src_e2)],
        [dot(dst_e2, src_e1), dot(dst_e2, src_e2)],
    ]
}

pub(super) fn tangent_transport_nonunitarity(transport: [[f64; 2]; 2]) -> f64 {
    let c00 = transport[0][0] * transport[0][0] + transport[1][0] * transport[1][0];
    let c01 = transport[0][0] * transport[0][1] + transport[1][0] * transport[1][1];
    let c10 = transport[0][1] * transport[0][0] + transport[1][1] * transport[1][0];
    let c11 = transport[0][1] * transport[0][1] + transport[1][1] * transport[1][1];
    ((c00 - 1.0).powi(2) + c01.powi(2) + c10.powi(2) + (c11 - 1.0).powi(2)).sqrt()
}

pub(super) fn tangent_transport_to_root(
    node: usize,
    root: usize,
    bases: &[(Vector3, Vector3)],
) -> [[f64; 2]; 2] {
    let (node_e1, node_e2) = bases[node];
    let (root_e1, root_e2) = bases[root];
    [
        [dot(node_e1, root_e1), dot(node_e1, root_e2)],
        [dot(node_e2, root_e1), dot(node_e2, root_e2)],
    ]
}

pub(super) fn project_local_tangent_block_to_reduced(
    coeff: Complex64,
    row_transport: [[f64; 2]; 2],
    local_block: [[f64; 2]; 2],
    col_transport: [[f64; 2]; 2],
) -> [[Complex64; 2]; 2] {
    let mut reduced = [[Complex64::new(0.0, 0.0); 2]; 2];
    for row_component in 0..2 {
        for col_component in 0..2 {
            let mut value = 0.0;
            for local_row in 0..2 {
                for local_col in 0..2 {
                    value += row_transport[local_row][row_component]
                        * local_block[local_row][local_col]
                        * col_transport[local_col][col_component];
                }
            }
            reduced[row_component][col_component] = coeff * value;
        }
    }
    reduced
}

pub(super) fn add_complex_tangent_block(
    matrix: &mut [Vec<Complex64>],
    n: usize,
    row: usize,
    col: usize,
    block: [[Complex64; 2]; 2],
) {
    matrix[row][col] += block[0][0];
    matrix[row][col + n] += block[0][1];
    matrix[row + n][col] += block[1][0];
    matrix[row + n][col + n] += block[1][1];
}

/// Returns the set of indices of nodes that lie on the surface of the magnetic
/// region (i.e. surface relevant for spin-wave pinning BC).
///
/// * Standalone magnetic mesh (no airbox):
///   `topology.boundary_nodes` are all on the outer surface of the magnet.
///
/// * Shared-domain mesh with airbox:
///   `topology.boundary_nodes` are on the outer airbox surface, NOT the magnet
///   surface.  We instead find nodes that are magnetic AND appear in at least
///   one non-magnetic (airbox) element — these are exactly on the interface.
fn magnetic_boundary_nodes(topology: &MeshTopology) -> std::collections::HashSet<usize> {
    let has_airbox = topology
        .magnetic_element_mask
        .iter()
        .any(|&is_magnetic| !is_magnetic);

    if !has_airbox {
        // Standalone magnetic mesh: outer boundary = magnet surface.
        return topology
            .boundary_nodes
            .iter()
            .map(|&n| n as usize)
            .collect();
    }

    // Shared-domain mesh: collect nodes that appear in non-magnetic elements.
    let mut in_airbox_element: std::collections::HashSet<usize> = std::collections::HashSet::new();
    for (element_idx, element) in topology.elements.iter().enumerate() {
        if !topology.magnetic_element_mask[element_idx] {
            for &node in element.iter() {
                in_airbox_element.insert(node as usize);
            }
        }
    }
    // Magnetic boundary = magnetic nodes that are also in an airbox element.
    (0..topology.n_nodes)
        .filter(|&i| topology.magnetic_node_volumes[i] > 0.0 && in_airbox_element.contains(&i))
        .collect()
}
