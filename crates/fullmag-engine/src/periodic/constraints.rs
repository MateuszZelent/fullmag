use fullmag_ir::{MeshPeriodicBoundaryPairIR, MeshPeriodicNodePairIR, PhaseConventionIR};
use rustfft::num_complex::Complex;
use std::collections::{BTreeMap, VecDeque};

pub type Complex64 = Complex<f64>;

#[derive(Clone, Debug, PartialEq)]
pub struct PeriodicNodeRepresentative {
    pub representative_node: usize,
    pub phase: Complex64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PeriodicDofMap {
    pub node_map: Vec<PeriodicNodeRepresentative>,
    pub full_node_count: usize,
    pub reduced_node_count: usize,
    pub representative_nodes: Vec<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PeriodicError {
    pub message: String,
}

impl PeriodicError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for PeriodicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PeriodicError {}

impl PeriodicDofMap {
    pub fn identity(node_count: usize) -> Self {
        Self {
            node_map: (0..node_count)
                .map(|node| PeriodicNodeRepresentative {
                    representative_node: node,
                    phase: Complex64::new(1.0, 0.0),
                })
                .collect(),
            full_node_count: node_count,
            reduced_node_count: node_count,
            representative_nodes: (0..node_count).collect(),
        }
    }

    pub fn from_periodic_pairs_static(
        node_count: usize,
        pairs: &[MeshPeriodicNodePairIR],
    ) -> Result<Self, PeriodicError> {
        let adjacency = adjacency_from_pairs(node_count, pairs, |_| Ok(Complex64::new(1.0, 0.0)))?;
        Self::from_adjacency(node_count, adjacency)
    }

    pub fn from_periodic_pair_tuples_static(
        node_count: usize,
        pairs: &[(String, u32, u32)],
    ) -> Result<Self, PeriodicError> {
        let pairs = pairs
            .iter()
            .map(|(pair_id, node_a, node_b)| MeshPeriodicNodePairIR {
                pair_id: pair_id.clone(),
                node_a: *node_a,
                node_b: *node_b,
            })
            .collect::<Vec<_>>();
        Self::from_periodic_pairs_static(node_count, &pairs)
    }

    pub fn from_periodic_pairs_floquet(
        node_count: usize,
        pairs: &[MeshPeriodicNodePairIR],
        pair_metadata: &[MeshPeriodicBoundaryPairIR],
        k_vector_rad_per_m: [f64; 3],
        phase_convention: PhaseConventionIR,
    ) -> Result<Self, PeriodicError> {
        let translations = pair_metadata
            .iter()
            .map(|pair| (pair.pair_id.as_str(), pair.translation))
            .collect::<BTreeMap<_, _>>();
        let adjacency = adjacency_from_node_pairs(node_count, pairs, |pair| {
            let translation = translations
                .get(pair.pair_id.as_str())
                .copied()
                .flatten()
                .ok_or_else(|| {
                    PeriodicError::new(format!(
                        "periodic boundary pair '{}' requires translation for Floquet phase",
                        pair.pair_id
                    ))
                })?;
            Ok(floquet_phase(
                k_vector_rad_per_m,
                translation,
                phase_convention,
            ))
        })?;
        Self::from_adjacency(node_count, adjacency)
    }

    pub fn from_periodic_pair_tuples_floquet(
        node_count: usize,
        pairs: &[(String, u32, u32)],
        pair_metadata: &[(String, Option<[f64; 3]>)],
        coords: &[[f64; 3]],
        k_vector_rad_per_m: [f64; 3],
        phase_convention: PhaseConventionIR,
    ) -> Result<Self, PeriodicError> {
        let pairs = pairs
            .iter()
            .map(|(pair_id, node_a, node_b)| MeshPeriodicNodePairIR {
                pair_id: pair_id.clone(),
                node_a: *node_a,
                node_b: *node_b,
            })
            .collect::<Vec<_>>();
        let translations = pair_metadata
            .iter()
            .map(|(pair_id, translation)| (pair_id.as_str(), *translation))
            .collect::<BTreeMap<_, _>>();
        let adjacency = adjacency_from_node_pairs(node_count, &pairs, |pair| {
            let a = pair.node_a as usize;
            let b = pair.node_b as usize;
            let delta = translations
                .get(pair.pair_id.as_str())
                .copied()
                .flatten()
                .unwrap_or_else(|| {
                    [
                        coords[b][0] - coords[a][0],
                        coords[b][1] - coords[a][1],
                        coords[b][2] - coords[a][2],
                    ]
                });
            Ok(floquet_phase(k_vector_rad_per_m, delta, phase_convention))
        })?;
        Self::from_adjacency(node_count, adjacency)
    }

    pub fn reduced_node(&self, full_node: usize) -> usize {
        self.node_map[full_node].representative_node
    }

    pub fn phase(&self, full_node: usize) -> Complex64 {
        self.node_map[full_node].phase
    }

    fn from_adjacency(
        node_count: usize,
        adjacency: Vec<Vec<(usize, Complex64)>>,
    ) -> Result<Self, PeriodicError> {
        let mut visited = vec![false; node_count];
        let mut root_for_node: Vec<usize> = (0..node_count).collect();
        let mut phase_for_node = vec![Complex64::new(1.0, 0.0); node_count];
        let mut representative_nodes = Vec::new();

        for start in 0..node_count {
            if visited[start] {
                continue;
            }
            representative_nodes.push(start);
            let mut queue = VecDeque::new();
            visited[start] = true;
            root_for_node[start] = start;
            queue.push_back(start);

            while let Some(node) = queue.pop_front() {
                for (next, phase) in &adjacency[node] {
                    let expected_phase = phase_for_node[node] * *phase;
                    if visited[*next] {
                        if (phase_for_node[*next] - expected_phase).norm() > 1e-10 {
                            return Err(PeriodicError::new(format!(
                                "conflicting periodic phase constraints for node {next}"
                            )));
                        }
                        continue;
                    }
                    visited[*next] = true;
                    root_for_node[*next] = start;
                    phase_for_node[*next] = expected_phase;
                    queue.push_back(*next);
                }
            }
        }

        let root_to_reduced = representative_nodes
            .iter()
            .enumerate()
            .map(|(reduced, root)| (*root, reduced))
            .collect::<BTreeMap<_, _>>();
        let node_map = (0..node_count)
            .map(|node| PeriodicNodeRepresentative {
                representative_node: root_to_reduced[&root_for_node[node]],
                phase: phase_for_node[node],
            })
            .collect::<Vec<_>>();

        Ok(Self {
            node_map,
            full_node_count: node_count,
            reduced_node_count: representative_nodes.len(),
            representative_nodes,
        })
    }
}

pub fn floquet_phase(
    k: [f64; 3],
    delta_r: [f64; 3],
    phase_convention: PhaseConventionIR,
) -> Complex64 {
    let dot = k[0] * delta_r[0] + k[1] * delta_r[1] + k[2] * delta_r[2];
    match phase_convention {
        PhaseConventionIR::ExpMinusIKDotDeltaR => Complex64::from_polar(1.0, -dot),
    }
}

fn adjacency_from_pairs<F>(
    node_count: usize,
    pairs: &[MeshPeriodicNodePairIR],
    mut phase_for_pair: F,
) -> Result<Vec<Vec<(usize, Complex64)>>, PeriodicError>
where
    F: FnMut(&str) -> Result<Complex64, PeriodicError>,
{
    adjacency_from_node_pairs(node_count, pairs, |pair| phase_for_pair(&pair.pair_id))
}

fn adjacency_from_node_pairs<F>(
    node_count: usize,
    pairs: &[MeshPeriodicNodePairIR],
    mut phase_for_pair: F,
) -> Result<Vec<Vec<(usize, Complex64)>>, PeriodicError>
where
    F: FnMut(&MeshPeriodicNodePairIR) -> Result<Complex64, PeriodicError>,
{
    let mut adjacency = vec![Vec::new(); node_count];
    for pair in pairs {
        let a = pair.node_a as usize;
        let b = pair.node_b as usize;
        if a >= node_count || b >= node_count {
            return Err(PeriodicError::new(format!(
                "periodic node pair '{}' references node outside mesh",
                pair.pair_id
            )));
        }
        let phase = phase_for_pair(pair)?;
        adjacency[a].push((b, phase));
        adjacency[b].push((a, phase.conj()));
    }
    Ok(adjacency)
}
