//! Consistent P1 mass metric for modal post-processing without dense matrices.
//! This is the same observation/normalization metric as the dense reference,
//! not an eigensolver or an alternative native FEM assembly owner.
use crate::types::RunError;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::periodic::constraints::PeriodicDofMap;
use fullmag_ir::{FemEigenPlanIR, KSamplingIR, SpinWaveBoundaryKindIR};
use nalgebra::DMatrix;
use num_complex::Complex64;
use std::collections::BTreeSet;

/// Build the phase vector used by the native shared-domain class map.
///
/// The native shared-domain assembler always unions every periodic node pair.
/// Do not reuse the ordinary `ReductionMap` phases here: that map may honor a
/// caller-selected subset of pair IDs and therefore can have different class
/// representatives or disconnected components.
pub(super) fn canonical_shared_domain_phases(
    topology: &MeshTopology,
    plan: &FemEigenPlanIR,
) -> Result<Vec<Complex64>, RunError> {
    if topology.periodic_node_pairs.is_empty() {
        return Err(RunError {
            message: "shared-domain modal phase map requires periodic node pairs".to_string(),
        });
    }
    let topology_pair_ids = topology
        .periodic_node_pairs
        .iter()
        .map(|(pair_id, _, _)| pair_id.as_str())
        .collect::<BTreeSet<_>>();
    let requested_pair_ids = plan
        .spin_wave_bc
        .boundary_pair_ids()
        .into_iter()
        .collect::<BTreeSet<_>>();
    if !requested_pair_ids.is_empty() && requested_pair_ids != topology_pair_ids {
        return Err(RunError {
            message: "shared-domain modal phase map cannot honor a periodic pair subset; the authored pair IDs must cover every mesh periodic node pair".to_string(),
        });
    }
    let dof_map = match plan.spin_wave_bc.kind() {
        SpinWaveBoundaryKindIR::Periodic => PeriodicDofMap::from_periodic_pair_tuples_static(
            topology.n_nodes,
            &topology.periodic_node_pairs,
        ),
        SpinWaveBoundaryKindIR::Floquet => {
            let Some(KSamplingIR::Single { k_vector }) = plan.k_sampling.as_ref() else {
                return Err(RunError {
                    message: "shared-domain Floquet phase map requires single-k sampling"
                        .to_string(),
                });
            };
            PeriodicDofMap::from_periodic_pair_tuples_floquet(
                topology.n_nodes,
                &topology.periodic_node_pairs,
                &topology.periodic_boundary_pairs,
                &topology.coords,
                *k_vector,
                plan.spin_wave_bc.phase_convention(),
            )
        }
        kind => {
            return Err(RunError {
                message: format!(
                    "shared-domain modal phase map does not support spin-wave BC '{kind:?}'"
                ),
            });
        }
    }
    .map_err(|error| RunError {
        message: format!(
            "failed to build canonical shared-domain phase map: {}",
            error.message
        ),
    })?;
    let phases = (0..topology.n_nodes)
        .map(|node| {
            let phase = dof_map.phase(node);
            Complex64::new(phase.re, phase.im)
        })
        .collect::<Vec<_>>();
    if phases.iter().any(|phase| {
        !phase.re.is_finite() || !phase.im.is_finite() || (phase.norm_sqr() - 1.0).abs() > 1.0e-10
    }) {
        return Err(RunError {
            message: "canonical shared-domain phase map contains an invalid phase".to_string(),
        });
    }
    if dof_map
        .representative_nodes
        .iter()
        .any(|&node| (phases[node] - Complex64::new(1.0, 0.0)).norm() > 1.0e-10)
    {
        return Err(RunError {
            message: "canonical shared-domain phase map is not anchored at class representatives"
                .to_string(),
        });
    }
    Ok(phases)
}

/// Check that node-indexed phases use the same lowest-node anchor as the
/// native scalar class map. A compact class ID has no representative meaning
/// by itself, so this binds the phase convention to the scalar map used for
/// potential expansion.
pub(super) fn validate_shared_domain_phase_anchors(
    scalar_classes: &[u32],
    scalar_class_count: usize,
    phases: &[Complex64],
) -> Result<(), RunError> {
    if scalar_class_count == 0 || scalar_classes.len() != phases.len() {
        return Err(RunError {
            message: "shared-domain scalar phase-anchor dimensions are inconsistent".to_string(),
        });
    }
    let mut anchors = vec![usize::MAX; scalar_class_count];
    for (node, &class) in scalar_classes.iter().enumerate() {
        let class = class as usize;
        if class >= scalar_class_count {
            return Err(RunError {
                message: "shared-domain scalar phase-anchor class is out of range".to_string(),
            });
        }
        anchors[class] = anchors[class].min(node);
    }
    for (class, &node) in anchors.iter().enumerate() {
        if node == usize::MAX {
            return Err(RunError {
                message: format!("shared-domain scalar class {class} has no phase anchor"),
            });
        }
        if (phases[node] - Complex64::new(1.0, 0.0)).norm() > 1.0e-10 {
            return Err(RunError {
                message: format!(
                    "shared-domain scalar class {class} phase anchor is not unity at node {node}"
                ),
            });
        }
    }
    Ok(())
}

pub(super) trait ModalMassMetric {
    fn nrows(&self) -> usize;
    fn quadratic_form(&self, vector: &[Complex64]) -> Complex64;
}

impl ModalMassMetric for DMatrix<f64> {
    fn nrows(&self) -> usize {
        self.nrows()
    }
    fn quadratic_form(&self, vector: &[Complex64]) -> Complex64 {
        let mut value = Complex64::new(0.0, 0.0);
        for row in 0..self.nrows() {
            for col in 0..self.ncols() {
                value += vector[row].conj() * self[(row, col)] * vector[col];
            }
        }
        value
    }
}

/// Element contributions need O(magnetic elements) storage. Duplicate sparse
/// entries are intentionally summed during evaluation, exactly as in assembly.
#[derive(Debug)]
pub(super) struct SharedDomainSparseMass {
    class_count: usize,
    entries: Vec<(usize, usize, Complex64)>,
    pub(super) active_nodes: Vec<usize>,
    pub(super) node_diagonal_weights: Vec<f64>,
}

impl SharedDomainSparseMass {
    pub(super) fn from_topology(
        topology: &MeshTopology,
        classes: &[u32],
        class_count: usize,
        phases: &[Complex64],
    ) -> Result<Self, RunError> {
        let error = |message: &str| RunError {
            message: message.to_string(),
        };
        if class_count == 0 || classes.len() != topology.n_nodes || phases.len() != topology.n_nodes
        {
            return Err(error(
                "shared-domain sparse mass has inconsistent class/phase dimensions",
            ));
        }
        let active_nodes: Vec<_> = topology
            .magnetic_node_volumes
            .iter()
            .enumerate()
            .filter_map(|(i, volume)| (*volume > 0.0).then_some(i))
            .collect();
        let mut diagonal = vec![0.0; topology.n_nodes];
        let mut entries = Vec::new();
        for (element_index, nodes) in topology.elements.iter().enumerate() {
            if !topology.magnetic_element_mask[element_index] {
                continue;
            }
            let volume = topology.element_volumes[element_index];
            if !volume.is_finite() || volume <= 0.0 {
                return Err(error(
                    "shared-domain sparse mass requires positive finite element volumes",
                ));
            }
            for (i, node_i) in nodes.iter().enumerate() {
                let ni = *node_i as usize;
                let row = classes[ni] as usize;
                if row >= class_count
                    || !phases[ni].re.is_finite()
                    || !phases[ni].im.is_finite()
                    || (phases[ni].norm_sqr() - 1.0).abs() > 1.0e-10
                {
                    return Err(error(
                        "shared-domain sparse mass has invalid magnetic class or Bloch phase",
                    ));
                }
                diagonal[ni] += volume / 10.0;
                for (j, node_j) in nodes.iter().enumerate() {
                    let nj = *node_j as usize;
                    let col = classes[nj] as usize;
                    if col >= class_count {
                        return Err(error(
                            "shared-domain sparse mass has invalid magnetic class",
                        ));
                    }
                    let local = volume * if i == j { 0.1 } else { 0.05 };
                    entries.push((row, col, phases[ni].conj() * local * phases[nj]));
                }
            }
        }
        let weights: Vec<_> = active_nodes.iter().map(|node| diagonal[*node]).collect();
        if entries.is_empty() || weights.iter().any(|w| !w.is_finite() || *w <= 0.0) {
            return Err(error(
                "shared-domain sparse mass contains no valid magnetic support",
            ));
        }
        Ok(Self {
            class_count,
            entries,
            active_nodes,
            node_diagonal_weights: weights,
        })
    }
}

impl ModalMassMetric for SharedDomainSparseMass {
    fn nrows(&self) -> usize {
        2 * self.class_count
    }
    fn quadratic_form(&self, vector: &[Complex64]) -> Complex64 {
        let mut value = Complex64::new(0.0, 0.0);
        for &(row, col, weight) in &self.entries {
            value += vector[row].conj() * weight * vector[col];
            value +=
                vector[row + self.class_count].conj() * weight * vector[col + self.class_count];
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sparse_phase_mass_matches_expanded_consistent_tetrahedron_metric() {
        let phase = Complex64::from_polar(1.0, 0.73);
        let phases = [
            Complex64::new(1.0, 0.0),
            phase,
            phase.conj(),
            Complex64::new(1.0, 0.0),
        ];
        let classes = [0, 1, 0, 1];
        let volume = 2.7e-24;
        let mut entries = Vec::new();
        for i in 0..4 {
            for j in 0..4 {
                entries.push((
                    classes[i],
                    classes[j],
                    phases[i].conj() * volume * if i == j { 0.1 } else { 0.05 } * phases[j],
                ));
            }
        }
        let metric = SharedDomainSparseMass {
            class_count: 2,
            entries,
            active_nodes: vec![],
            node_diagonal_weights: vec![],
        };
        let q = [
            Complex64::new(2., -1.),
            Complex64::new(-3., 4.),
            Complex64::new(1., 1.),
            Complex64::new(0.5, -2.),
        ];
        let mut full = vec![Complex64::new(0., 0.); 8];
        let mut mass = DMatrix::<f64>::zeros(8, 8);
        for c in 0..2 {
            for i in 0..4 {
                full[4 * c + i] = phases[i] * q[2 * c + classes[i]];
                for j in 0..4 {
                    mass[(4 * c + i, 4 * c + j)] = volume * if i == j { 0.1 } else { 0.05 };
                }
            }
        }
        let expected = mass.quadratic_form(&full);
        let actual = metric.quadratic_form(&q);
        assert!((actual - expected).norm() < expected.norm() * 1e-14);
        assert!(actual.re > 0.0 && actual.im.abs() < actual.re * 1e-14);
    }
    #[test]
    fn sparse_mass_dimension_does_not_require_quadratic_storage() {
        let metric = SharedDomainSparseMass {
            class_count: 100_000,
            entries: vec![(0, 0, Complex64::new(2., 0.))],
            active_nodes: vec![],
            node_diagonal_weights: vec![],
        };
        let mut q = vec![Complex64::new(0., 0.); metric.nrows()];
        q[0] = Complex64::new(3., 0.);
        assert_eq!(metric.quadratic_form(&q), Complex64::new(18., 0.));
        assert_eq!(metric.entries.len(), 1);
    }

    #[test]
    fn shared_domain_phase_anchor_validation_binds_lowest_node_per_scalar_class() {
        let phase = Complex64::from_polar(1.0, 0.37);
        let classes = [0, 0, 1, 1, 2];
        let phases = [
            Complex64::new(1.0, 0.0),
            phase,
            Complex64::new(1.0, 0.0),
            phase.conj(),
            Complex64::new(1.0, 0.0),
        ];
        assert!(validate_shared_domain_phase_anchors(&classes, 3, &phases).is_ok());

        let mut wrong_anchor = phases;
        wrong_anchor[0] = phase;
        assert!(validate_shared_domain_phase_anchors(&classes, 3, &wrong_anchor).is_err());
        assert!(validate_shared_domain_phase_anchors(&[0, 0, 2], 2, &phases[..3]).is_err());
    }
}
