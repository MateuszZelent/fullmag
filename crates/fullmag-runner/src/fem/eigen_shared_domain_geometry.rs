use super::eigen_digest::shared_domain_content_digest;
use crate::native_fem;
use crate::types::RunError;
use fullmag_engine::fem::MeshTopology;
use fullmag_ir::FemEigenPlanIR;

#[derive(Debug, Clone)]
pub(super) struct PeriodicDomainPairStats {
    pub(super) magnetic_pair_count: u64,
    pub(super) airbox_pair_count: u64,
    pub(super) magnetic_pair_masses: Vec<f64>,
    pub(super) airbox_pair_lengths_m: Vec<f64>,
}

fn tetra_volume_abs(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let cross = [
        ac[1] * ad[2] - ac[2] * ad[1],
        ac[2] * ad[0] - ac[0] * ad[2],
        ac[0] * ad[1] - ac[1] * ad[0],
    ];
    ((ab[0] * cross[0] + ab[1] * cross[1] + ab[2] * cross[2]) / 6.0).abs()
}

pub(super) fn periodic_domain_pair_stats(
    mesh: &fullmag_ir::MeshIR,
) -> Result<PeriodicDomainPairStats, RunError> {
    let elements = mesh.require_tet4_elements().map_err(|error| RunError {
        message: format!("periodic eigen domain statistics are tet4-only: {error}"),
    })?;
    let mut magnetic_nodes = std::collections::BTreeSet::new();
    let mut airbox_nodes = std::collections::BTreeSet::new();
    let mut magnetic_node_lumped_volumes = vec![0.0; mesh.nodes.len()];
    for (element_index, element) in elements.iter().enumerate() {
        let marker = mesh
            .element_markers
            .get(element_index)
            .copied()
            .unwrap_or(1);
        let target = if marker == 0 {
            &mut airbox_nodes
        } else {
            &mut magnetic_nodes
        };
        target.extend(element.iter().copied());
        if marker != 0 {
            let a = mesh
                .nodes
                .get(element[0] as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload magnetic element references missing node"
                            .to_string(),
                })?;
            let b = mesh
                .nodes
                .get(element[1] as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload magnetic element references missing node"
                            .to_string(),
                })?;
            let c = mesh
                .nodes
                .get(element[2] as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload magnetic element references missing node"
                            .to_string(),
                })?;
            let d = mesh
                .nodes
                .get(element[3] as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload magnetic element references missing node"
                            .to_string(),
                })?;
            let volume = tetra_volume_abs(*a, *b, *c, *d);
            if !(volume.is_finite() && volume > 0.0) {
                return Err(RunError {
                    message: "PA-E4b periodic_airbox_k0 payload requires positive magnetic element volumes".to_string(),
                });
            }
            let lumped = volume / 4.0;
            for node in element {
                magnetic_node_lumped_volumes[*node as usize] += lumped;
            }
        }
    }
    let mut magnetic_count = 0_u64;
    let mut airbox_count = 0_u64;
    let mut magnetic_pair_masses = Vec::new();
    let mut airbox_pair_lengths_m = Vec::new();
    for pair in &mesh.periodic_node_pairs {
        let a_magnetic = magnetic_nodes.contains(&pair.node_a);
        let b_magnetic = magnetic_nodes.contains(&pair.node_b);
        let a_airbox = airbox_nodes.contains(&pair.node_a);
        let b_airbox = airbox_nodes.contains(&pair.node_b);
        if a_magnetic && b_magnetic {
            magnetic_count += 1;
            let mass = (magnetic_node_lumped_volumes[pair.node_a as usize]
                + magnetic_node_lumped_volumes[pair.node_b as usize])
                * 0.5;
            if !(mass.is_finite() && mass > 0.0) {
                return Err(RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload requires positive magnetic pair masses"
                            .to_string(),
                });
            }
            magnetic_pair_masses.push(mass);
        } else if !a_magnetic && !b_magnetic && (a_airbox || b_airbox) {
            airbox_count += 1;
            let a = mesh
                .nodes
                .get(pair.node_a as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload airbox pair references missing node"
                            .to_string(),
                })?;
            let b = mesh
                .nodes
                .get(pair.node_b as usize)
                .ok_or_else(|| RunError {
                    message:
                        "PA-E4b periodic_airbox_k0 payload airbox pair references missing node"
                            .to_string(),
                })?;
            let length =
                ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
            if !(length.is_finite() && length > 0.0) {
                return Err(RunError {
                    message: "PA-E4b periodic_airbox_k0 payload requires positive airbox periodic pair lengths".to_string(),
                });
            }
            airbox_pair_lengths_m.push(length);
        }
    }
    Ok(PeriodicDomainPairStats {
        magnetic_pair_count: magnetic_count,
        airbox_pair_count: airbox_count,
        magnetic_pair_masses,
        airbox_pair_lengths_m,
    })
}

pub(super) fn pa_e4b_airbox_size_m(plan: &FemEigenPlanIR) -> Result<f64, RunError> {
    let factor = plan
        .air_box_config
        .as_ref()
        .map(|config| config.factor)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires positive air_box_config.factor and mesh extent".to_string(),
        })?;
    let mut min_corner = [f64::INFINITY; 3];
    let mut max_corner = [f64::NEG_INFINITY; 3];
    for node in &plan.mesh.nodes {
        for axis in 0..3 {
            min_corner[axis] = min_corner[axis].min(node[axis]);
            max_corner[axis] = max_corner[axis].max(node[axis]);
        }
    }
    let max_extent = (0..3)
        .map(|axis| max_corner[axis] - min_corner[axis])
        .filter(|extent| extent.is_finite() && *extent > 0.0)
        .fold(0.0_f64, f64::max);
    if !(max_extent.is_finite() && max_extent > 0.0) {
        return Err(RunError {
            message: "PA-E4b periodic_airbox_k0 payload requires positive air_box_config.factor and mesh extent".to_string(),
        });
    }
    Ok(max_extent * factor)
}

/// Resolve the physical Robin coefficient used by both the native static
/// FEM demag path and the shared-domain modal operator.  The coefficient is
/// based on the open-axis extent of the actual mesh; the public airbox
/// `factor` controls domain construction/metadata and is not an additional
/// multiplier for the boundary condition.
fn robin_reference_extent_m(
    min_corner: [f64; 3],
    max_corner: [f64; 3],
    periodic_axis: [bool; 3],
) -> f64 {
    let open_axis_extent = (0..3)
        .filter(|axis| !periodic_axis[*axis])
        .map(|axis| max_corner[axis] - min_corner[axis])
        .filter(|extent| extent.is_finite() && *extent > 0.0)
        .fold(0.0_f64, f64::max);
    if open_axis_extent > 0.0 {
        open_axis_extent
    } else {
        // A fully periodic mesh has no distinguished open axis.  Preserve a
        // deterministic fallback for that invalid-for-airbox configuration,
        // while ensuring a normal x/y-PBC, open-z mesh never uses its periodic
        // cell width to set the Robin length scale.
        (0..3)
            .map(|axis| max_corner[axis] - min_corner[axis])
            .filter(|extent| extent.is_finite() && *extent > 0.0)
            .fold(0.0_f64, f64::max)
    }
}

pub(super) fn shared_domain_robin_beta_m(plan: &FemEigenPlanIR) -> Result<Option<f64>, RunError> {
    let Some(config) = plan.air_box_config.as_ref() else {
        return Ok(None);
    };
    if matches!(
        config.bc_kind.as_deref(),
        Some("dirichlet") | Some("pure_neumann")
    ) {
        return Ok(None);
    }
    let coefficient_factor = config.robin_beta_factor.unwrap_or(2.0);
    if !coefficient_factor.is_finite() || coefficient_factor <= 0.0 {
        return Err(RunError {
            message: "shared-domain Robin beta factor must be positive".to_string(),
        });
    }
    let mut min_corner = [f64::INFINITY; 3];
    let mut max_corner = [f64::NEG_INFINITY; 3];
    for node in &plan.mesh.nodes {
        for axis in 0..3 {
            min_corner[axis] = min_corner[axis].min(node[axis]);
            max_corner[axis] = max_corner[axis].max(node[axis]);
        }
    }
    let mut periodic_axis = [false; 3];
    for pair in &plan.mesh.periodic_boundary_pairs {
        if let Some(translation) = pair.translation {
            for axis in 0..3 {
                periodic_axis[axis] |= translation[axis].abs() > 1.0e-15;
            }
        }
    }
    let reference_extent = robin_reference_extent_m(min_corner, max_corner, periodic_axis);
    if !(reference_extent.is_finite() && reference_extent > 0.0) {
        return Err(RunError {
            message: "shared-domain Robin beta requires a positive mesh extent".to_string(),
        });
    }
    Ok(Some(coefficient_factor / (reference_extent * 0.5)))
}

#[cfg(test)]
mod tests {
    use super::robin_reference_extent_m;

    #[test]
    fn robin_reference_extent_ignores_periodic_cell_width() {
        let extent = robin_reference_extent_m(
            [-80.0e-9, -40.0e-9, -25.0e-9],
            [80.0e-9, 40.0e-9, 25.0e-9],
            [true, true, false],
        );
        assert!((extent - 50.0e-9).abs() < 1.0e-18);
    }

    #[test]
    fn robin_reference_extent_uses_largest_open_axis() {
        let extent = robin_reference_extent_m(
            [-1.0, -5.0, -2.0],
            [1.0, 5.0, 2.0],
            [true, false, false],
        );
        assert!((extent - 10.0).abs() < 1.0e-12);
    }

    #[test]
    fn robin_reference_extent_has_deterministic_all_periodic_fallback() {
        let extent = robin_reference_extent_m(
            [-1.0, -2.0, -3.0],
            [1.0, 2.0, 3.0],
            [true, true, true],
        );
        assert!((extent - 6.0).abs() < 1.0e-12);
    }
}

#[derive(Debug, Clone)]
pub(super) struct OwnedModalEigenCsrMatrix {
    pub(super) row_count: u64,
    pub(super) column_count: u64,
    pub(super) row_offsets: Vec<u32>,
    pub(super) column_indices: Vec<u32>,
    pub(super) values: Vec<f64>,
}

impl OwnedModalEigenCsrMatrix {
    pub(super) fn from_dense(
        row_count: u64,
        column_count: u64,
        values: &[f64],
    ) -> Result<Self, RunError> {
        let expected = row_count
            .checked_mul(column_count)
            .and_then(|count| usize::try_from(count).ok())
            .ok_or_else(|| RunError {
                message: "PA-E4b Poisson-airbox payload dense block dimensions overflow"
                    .to_string(),
            })?;
        if values.len() != expected {
            return Err(RunError {
                message: "PA-E4b Poisson-airbox payload dense block shape mismatch".to_string(),
            });
        }
        let mut row_offsets = Vec::with_capacity(row_count as usize + 1);
        let mut column_indices = Vec::new();
        let mut csr_values = Vec::new();
        row_offsets.push(0);
        for row in 0..row_count {
            for column in 0..column_count {
                let value = values[(row * column_count + column) as usize];
                if value != 0.0 {
                    let column = u32::try_from(column).map_err(|_| RunError {
                        message: "PA-E4b Poisson-airbox payload CSR column index overflow"
                            .to_string(),
                    })?;
                    column_indices.push(column);
                    csr_values.push(value);
                }
            }
            row_offsets.push(u32::try_from(csr_values.len()).map_err(|_| RunError {
                message: "PA-E4b Poisson-airbox payload CSR nnz overflow".to_string(),
            })?);
        }
        Ok(Self {
            row_count,
            column_count,
            row_offsets,
            column_indices,
            values: csr_values,
        })
    }

    pub(super) fn view(&self) -> native_fem::NativeModalEigenCsrMatrixView<'_> {
        native_fem::NativeModalEigenCsrMatrixView {
            row_count: self.row_count,
            column_count: self.column_count,
            row_offsets: &self.row_offsets,
            column_indices: &self.column_indices,
            values: &self.values,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct OwnedModalEigenPoissonAirboxBlockProblem {
    pub(super) q_dof_count: u64,
    pub(super) phi_dof_count: u64,
    pub(super) a_qq_csr: OwnedModalEigenCsrMatrix,
    pub(super) a_qphi_csr: OwnedModalEigenCsrMatrix,
    pub(super) a_phiq_csr: OwnedModalEigenCsrMatrix,
    pub(super) a_phiphi_csr: OwnedModalEigenCsrMatrix,
    pub(super) b_qq_csr: OwnedModalEigenCsrMatrix,
    pub(super) phi_mean_weights: Vec<f64>,
    pub(super) target_frequency_hz: f64,
    pub(super) expected_reference_frequency_hz: f64,
    pub(super) magnetic_pair_count: u64,
    pub(super) airbox_pair_count: u64,
    pub(super) outer_boundary_kind: &'static str,
    pub(super) robin_beta: f64,
    pub(super) gauge_policy: &'static str,
    pub(super) gauge_reason: &'static str,
    pub(super) assembly_kind: &'static str,
}

pub(super) fn modal_shared_domain_equivalence_classes(
    topology: &MeshTopology,
) -> Result<(Vec<u32>, u64, Vec<u32>, u64), RunError> {
    let node_count = topology.n_nodes;
    let mut parent: Vec<usize> = (0..node_count).collect();
    fn find(parent: &mut [usize], node: usize) -> usize {
        if parent[node] != node {
            let root = find(parent, parent[node]);
            parent[node] = root;
        }
        parent[node]
    }
    for (_, node_a, node_b) in &topology.periodic_node_pairs {
        let a = *node_a as usize;
        let b = *node_b as usize;
        if a >= node_count || b >= node_count {
            return Err(RunError {
                message: "shared-domain modal periodic node pair is outside the mesh".to_string(),
            });
        }
        let root_a = find(&mut parent, a);
        let root_b = find(&mut parent, b);
        if root_a != root_b {
            parent[root_b] = root_a;
        }
    }
    let mut scalar_roots = std::collections::BTreeMap::<usize, u32>::new();
    let mut scalar_classes = vec![0_u32; node_count];
    for node in 0..node_count {
        let root = find(&mut parent, node);
        let class = if let Some(class) = scalar_roots.get(&root) {
            *class
        } else {
            let class = scalar_roots.len() as u32;
            scalar_roots.insert(root, class);
            class
        };
        scalar_classes[node] = class;
    }
    let mut magnetic_roots = std::collections::BTreeMap::<usize, u32>::new();
    let mut root_has_magnetic = std::collections::BTreeMap::<usize, bool>::new();
    let mut root_has_air = std::collections::BTreeMap::<usize, bool>::new();
    for node in 0..node_count {
        let root = find(&mut parent, node);
        if topology.magnetic_node_volumes[node] > 0.0 {
            root_has_magnetic.insert(root, true);
        } else {
            root_has_air.insert(root, true);
        }
    }
    for root in root_has_magnetic.keys() {
        if root_has_air.get(root).copied().unwrap_or(false) {
            return Err(RunError {
                message:
                    "shared-domain modal periodic equivalence class mixes magnetic and air nodes"
                        .to_string(),
            });
        }
        magnetic_roots.insert(*root, magnetic_roots.len() as u32);
    }
    let mut magnetic_classes = vec![u32::MAX; node_count];
    for node in 0..node_count {
        if topology.magnetic_node_volumes[node] > 0.0 {
            let root = find(&mut parent, node);
            magnetic_classes[node] = *magnetic_roots.get(&root).ok_or_else(|| RunError {
                message: "shared-domain modal magnetic equivalence class is incomplete".to_string(),
            })?;
        }
    }
    Ok((
        scalar_classes,
        scalar_roots.len() as u64,
        magnetic_classes,
        magnetic_roots.len() as u64,
    ))
}

/// Bind the class maps handed to native to the accepted periodic certificate.
///
/// The native ABI receives compact class maps rather than the full certificate
/// object.  Rebuilding the maps here and recording their content digests makes
/// that projection fail closed: a stale/tampered map cannot be paired with a
/// current certificate or linearization state and still reach the solver.
pub(super) fn build_modal_certificate_map_binding(
    plan: &FemEigenPlanIR,
    topology: &MeshTopology,
    certificate: &fullmag_ir::PeriodicMeshCertificateV6IR,
    scalar_classes: &[u32],
    scalar_class_count: u64,
    magnetic_classes: &[u32],
    magnetic_class_count: u64,
) -> Result<(serde_json::Value, String), RunError> {
    if certificate.schema_version != "periodic_mesh_certificate.v6"
        || certificate.certificate_status != "accepted"
    {
        return Err(RunError {
            message: "periodic_mesh_certificate_equivalence_map_binding_requires_accepted_v6"
                .to_string(),
        });
    }
    let expected_topology_fingerprint = plan.mesh.topology_fingerprint_v6();
    if certificate.topology_fingerprint != expected_topology_fingerprint {
        return Err(RunError {
            message: format!(
                "periodic_mesh_certificate_equivalence_map_binding_topology_mismatch: certificate='{}' mesh='{}'",
                certificate.topology_fingerprint, expected_topology_fingerprint
            ),
        });
    }
    let (expected_scalar, expected_scalar_count, expected_magnetic, expected_magnetic_count) =
        modal_shared_domain_equivalence_classes(topology)?;
    if scalar_classes != expected_scalar
        || scalar_class_count != expected_scalar_count
        || magnetic_classes != expected_magnetic
        || magnetic_class_count != expected_magnetic_count
    {
        return Err(RunError {
            message: "periodic_mesh_certificate_equivalence_map_binding_map_mismatch".to_string(),
        });
    }

    let scalar_map_sha256 =
        shared_domain_content_digest("periodic_modal_scalar_reduced_node_map", scalar_classes)?;
    let magnetic_map_sha256 =
        shared_domain_content_digest("periodic_modal_magnetic_reduced_node_map", magnetic_classes)?;
    let binding = serde_json::json!({
        "schema_version": "periodic_modal_equivalence_map_binding.v1",
        "certificate_schema": certificate.schema_version,
        "certificate_status": certificate.certificate_status,
        "certificate_topology_fingerprint": certificate.topology_fingerprint,
        "certificate_scalar_equivalence_classes_sha256": certificate.scalar_equivalence_classes_sha256,
        "certificate_magnetic_equivalence_classes_sha256": certificate.magnetic_equivalence_classes_sha256,
        "scalar_reduced_node_count": scalar_classes.len(),
        "scalar_reduced_node_class_count": scalar_class_count,
        "scalar_reduced_node_sha256": scalar_map_sha256,
        "magnetic_reduced_node_count": magnetic_classes.len(),
        "magnetic_reduced_node_class_count": magnetic_class_count,
        "magnetic_reduced_node_sha256": magnetic_map_sha256,
    });
    let binding_digest =
        shared_domain_content_digest("periodic_modal_equivalence_map_binding", &binding)?;
    Ok((binding, binding_digest))
}
