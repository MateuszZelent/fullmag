#[allow(unused_imports)]
use crate::{
    ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, FdmPeriodicityIR,
    FemLinearSolverPolicy, FieldRefreshPolicyIR, HybridHintsIR, IntegratorChoice,
    RelaxationControlIR,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiscretizationHintsIR {
    pub fdm: Option<FdmHintsIR>,
    pub fem: Option<FemHintsIR>,
    pub hybrid: Option<HybridHintsIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmHintsIR {
    /// Legacy single-cell hint (backward compatible).
    #[serde(default, skip_serializing_if = "is_zero_cell")]
    pub cell: [f64; 3],
    /// New: explicit default cell (may differ from `cell` in future).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_cell: Option<[f64; 3]>,
    /// Per-magnet native grid overrides, keyed by magnet name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_magnet: Option<std::collections::BTreeMap<String, FdmGridHintsIR>>,
    /// Demagnetization solver policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag: Option<FdmDemagHintsIR>,
    /// Boundary correction: "none" | "volume" (T0) | "full" (T1)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_correction: Option<String>,
    /// Minimum volume fraction φ for T0/T1 stability clamping (0 < φ < 1, default 0.05).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_phi_floor: Option<f64>,
    /// Minimum intersection distance δ_min for T1 ECB stencil stability [physical length, m].
    /// Backend default: 0.1 × min(dx, dy, dz).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_delta_min: Option<f64>,
}

fn is_zero_cell(cell: &[f64; 3]) -> bool {
    cell.iter().all(|component| *component == 0.0)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmGridHintsIR {
    pub cell: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmDemagHintsIR {
    pub strategy: String,
    pub mode: String,
    #[serde(default)]
    pub allow_single_grid_fallback: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub common_cells: Option<[u32; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub common_cells_xy: Option<[u32; 2]>,
}

// ---------------------------------------------------------------------------
// Multilayer convolution plan IR types
// ---------------------------------------------------------------------------
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmMultilayerPlanIR {
    pub mode: String,
    pub common_cells: [u32; 3],
    pub layers: Vec<FdmLayerPlanIR>,
    pub enable_exchange: bool,
    pub enable_demag: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_field: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interfacial_dmi: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bulk_dmi: Option<f64>,
    pub gyromagnetic_ratio: f64,
    pub precision: ExecutionPrecision,
    pub exchange_bc: ExchangeBoundaryCondition,
    /// Periodic boundary conditions configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub periodicity: Option<FdmPeriodicityIR>,
    pub integrator: IntegratorChoice,
    pub fixed_timestep: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field_refresh: Option<FieldRefreshPolicyIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relaxation: Option<RelaxationControlIR>,
    pub planner_summary: FdmMultilayerSummaryIR,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmLayerPlanIR {
    pub magnet_name: String,
    pub native_grid: [u32; 3],
    pub native_cell_size: [f64; 3],
    pub native_origin: [f64; 3],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_active_mask: Option<Vec<bool>>,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub material: FdmMaterialIR,
    pub convolution_grid: [u32; 3],
    pub convolution_cell_size: [f64; 3],
    pub convolution_origin: [f64; 3],
    pub transfer_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmMultilayerSummaryIR {
    pub requested_strategy: String,
    pub selected_strategy: String,
    pub eligibility: String,
    pub estimated_pair_kernels: u32,
    pub estimated_unique_kernels: u32,
    pub estimated_kernel_bytes: u64,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemHintsIR {
    pub order: u32,
    pub hmax: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_solver_policy: Option<FemLinearSolverPolicy>,
}

/// Per-domain element quality metrics, mirroring ``MeshQualityReport`` in Python.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeshQualityIR {
    pub n_elements: u32,
    pub sicn_min: f64,
    pub sicn_max: f64,
    pub sicn_mean: f64,
    pub sicn_p5: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sicn_histogram: Vec<u32>,
    pub gamma_min: f64,
    pub gamma_mean: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gamma_histogram: Vec<u32>,
    pub volume_min: f64,
    pub volume_max: f64,
    pub volume_mean: f64,
    pub volume_std: f64,
    pub avg_quality: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeshIR {
    pub mesh_name: String,
    pub nodes: Vec<[f64; 3]>,
    pub elements: Vec<[u32; 4]>,
    pub element_markers: Vec<u32>,
    pub boundary_faces: Vec<[u32; 3]>,
    pub boundary_markers: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periodic_boundary_pairs: Vec<MeshPeriodicBoundaryPairIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periodic_node_pairs: Vec<MeshPeriodicNodePairIR>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub per_domain_quality: HashMap<u32, MeshQualityIR>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct MeshValidationPolicy {
    #[serde(default = "default_require_positive_orientation")]
    pub require_positive_orientation: bool,
    #[serde(default)]
    pub eps_volume: Option<f64>,
}

fn default_require_positive_orientation() -> bool {
    true
}

impl Default for MeshValidationPolicy {
    fn default() -> Self {
        Self {
            require_positive_orientation: true,
            eps_volume: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MeshPeriodicBoundaryPairIR {
    pub pair_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_marker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination_marker: Option<String>,
    #[serde(default)]
    pub marker_a: u32,
    #[serde(default)]
    pub marker_b: u32,
    /// Lattice translation vector connecting face A to face B [m].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation: Option<[f64; 3]>,
    /// Node-pairing tolerance [m]. When absent the mesher/planner chooses a
    /// default based on mesh element size.
    #[serde(
        default,
        alias = "tolerance_m",
        skip_serializing_if = "Option::is_none"
    )]
    pub tolerance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub axis_hint: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairing_policy: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MeshPeriodicNodePairIR {
    pub pair_id: String,
    pub node_a: u32,
    pub node_b: u32,
}

impl MeshIR {
    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if self.mesh_name.trim().is_empty() {
            errors.push("mesh_name must not be empty".to_string());
        }
        if self.nodes.is_empty() {
            errors.push("mesh.nodes must not be empty".to_string());
        }
        if self.elements.is_empty() {
            errors.push("mesh.elements must not be empty".to_string());
        }
        if self.element_markers.len() != self.elements.len() {
            errors.push("mesh.element_markers length must match mesh.elements length".to_string());
        }
        if self.boundary_markers.len() != self.boundary_faces.len() {
            errors.push(
                "mesh.boundary_markers length must match mesh.boundary_faces length".to_string(),
            );
        }

        let node_count = self.nodes.len() as u32;
        for (index, element) in self.elements.iter().enumerate() {
            if element.iter().any(|node| *node >= node_count) {
                errors.push(format!("mesh element {index} contains invalid node index"));
            }
        }
        for (index, face) in self.boundary_faces.iter().enumerate() {
            if face.iter().any(|node| *node >= node_count) {
                errors.push(format!(
                    "mesh boundary face {index} contains invalid node index"
                ));
            }
        }

        let mut periodic_pair_ids = BTreeSet::new();
        let mut periodic_pair_translations = BTreeMap::new();
        for (index, pair) in self.periodic_boundary_pairs.iter().enumerate() {
            if pair.pair_id.trim().is_empty() {
                errors.push(format!(
                    "mesh periodic boundary pair {index} must have a non-empty pair_id"
                ));
            }
            periodic_pair_ids.insert(pair.pair_id.clone());
            if let Some(previous) =
                periodic_pair_translations.insert(pair.pair_id.clone(), pair.translation)
            {
                if previous != pair.translation {
                    errors.push(format!(
                        "mesh periodic boundary pair id '{}' has inconsistent translations",
                        pair.pair_id
                    ));
                }
            }
        }

        for (index, pair) in self.periodic_node_pairs.iter().enumerate() {
            if pair.pair_id.trim().is_empty() {
                errors.push(format!(
                    "mesh periodic node pair {index} must have a non-empty pair_id"
                ));
            }
            if !periodic_pair_ids.contains(&pair.pair_id) {
                errors.push(format!(
                    "mesh periodic node pair {index} references unknown pair_id '{}'",
                    pair.pair_id
                ));
            }
            if pair.node_a >= node_count || pair.node_b >= node_count {
                errors.push(format!(
                    "mesh periodic node pair {index} contains invalid node index"
                ));
            }
            if pair.node_a == pair.node_b {
                errors.push(format!(
                    "mesh periodic node pair {index} must connect two distinct nodes"
                ));
            }
        }
        let mut source_nodes = BTreeSet::new();
        let mut destination_nodes = BTreeSet::new();
        for (index, pair) in self.periodic_node_pairs.iter().enumerate() {
            if !source_nodes.insert((pair.pair_id.clone(), pair.node_a)) {
                errors.push(format!(
                    "mesh periodic node pair {index} duplicates source node {} for pair_id '{}'",
                    pair.node_a, pair.pair_id
                ));
            }
            if !destination_nodes.insert((pair.pair_id.clone(), pair.node_b)) {
                errors.push(format!(
                    "mesh periodic node pair {index} duplicates destination node {} for pair_id '{}'",
                    pair.node_b, pair.pair_id
                ));
            }
            if pair.node_a >= node_count || pair.node_b >= node_count {
                continue;
            }
            let Some(boundary_pair) = self
                .periodic_boundary_pairs
                .iter()
                .find(|boundary_pair| boundary_pair.pair_id == pair.pair_id)
            else {
                continue;
            };
            let Some(translation) = boundary_pair.translation else {
                continue;
            };
            let src = self.nodes[pair.node_a as usize];
            let dst = self.nodes[pair.node_b as usize];
            let residual = [
                dst[0] - src[0] - translation[0],
                dst[1] - src[1] - translation[1],
                dst[2] - src[2] - translation[2],
            ];
            let residual_norm =
                (residual[0] * residual[0] + residual[1] * residual[1] + residual[2] * residual[2])
                    .sqrt();
            let tolerance = boundary_pair.tolerance.unwrap_or(1e-9).max(0.0);
            if residual_norm > tolerance {
                errors.push(format!(
                    "mesh periodic node pair {index} residual {residual_norm:.3e} m exceeds tolerance {tolerance:.3e} m for pair_id '{}'",
                    pair.pair_id
                ));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    pub fn validate_strict(&self, policy: &MeshValidationPolicy) -> Result<(), Vec<String>> {
        let mut errors = self.validate().err().unwrap_or_default();

        for (index, node) in self.nodes.iter().enumerate() {
            if node.iter().any(|value| !value.is_finite()) {
                errors.push(format!("mesh node {index} contains non-finite coordinates"));
            }
        }

        if self.element_markers.len() != self.elements.len() {
            errors.push("mesh.element_markers must cover every tetrahedral element".to_string());
        }

        let bbox_scale = self
            .nodes
            .iter()
            .fold(None::<([f64; 3], [f64; 3])>, |acc, node| match acc {
                Some((mut min, mut max)) => {
                    for axis in 0..3 {
                        min[axis] = min[axis].min(node[axis]);
                        max[axis] = max[axis].max(node[axis]);
                    }
                    Some((min, max))
                }
                None => Some((*node, *node)),
            })
            .map(|(min, max)| {
                (max[0] - min[0])
                    .abs()
                    .max((max[1] - min[1]).abs())
                    .max((max[2] - min[2]).abs())
            })
            .unwrap_or(1.0);
        let eps = policy
            .eps_volume
            .unwrap_or_else(|| {
                let scale = if bbox_scale > 0.0 { bbox_scale } else { 1.0 };
                scale.powi(3) * 1e-18
            })
            .max(f64::MIN_POSITIVE);

        for (index, element) in self.elements.iter().enumerate() {
            let mut unique = BTreeSet::new();
            for node in element {
                unique.insert(*node);
            }
            if unique.len() != 4 {
                errors.push(format!(
                    "mesh element {index} contains duplicate node indices"
                ));
                continue;
            }
            let Some(a) = self.nodes.get(element[0] as usize) else {
                continue;
            };
            let Some(b) = self.nodes.get(element[1] as usize) else {
                continue;
            };
            let Some(c) = self.nodes.get(element[2] as usize) else {
                continue;
            };
            let Some(d) = self.nodes.get(element[3] as usize) else {
                continue;
            };
            let volume = tet_signed_volume(*a, *b, *c, *d);
            if volume.abs() <= eps {
                errors.push(format!(
                    "mesh element {index} has degenerate tetra volume {volume:.6e} <= eps {eps:.6e}"
                ));
            } else if policy.require_positive_orientation && volume < 0.0 {
                errors.push(format!(
                    "mesh element {index} has negative tetra orientation {volume:.6e}"
                ));
            }
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }
}

/// Validate a mesh at the boundary of an executable pipeline.
///
/// Production callers must use this entry point instead of the structural
/// [`MeshIR::validate`] check.  Strict validation rejects non-finite nodes,
/// duplicate element nodes, degenerate tetrahedra, and (by default) inverted
/// tetrahedra before the mesh can reach a planner or native ABI.
pub fn validate_mesh_for_execution(mesh: &MeshIR) -> Result<(), Vec<String>> {
    mesh.validate()?;
    mesh.validate_strict(&MeshValidationPolicy::default())
}

fn tet_signed_volume(a: [f64; 3], b: [f64; 3], c: [f64; 3], d: [f64; 3]) -> f64 {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let ad = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let cross = [
        ac[1] * ad[2] - ac[2] * ad[1],
        ac[2] * ad[0] - ac[0] * ad[2],
        ac[0] * ad[1] - ac[1] * ad[0],
    ];
    (ab[0] * cross[0] + ab[1] * cross[1] + ab[2] * cross[2]) / 6.0
}

#[cfg(test)]
mod mesh_validation_tests {
    use super::*;

    fn base_mesh(elements: Vec<[u32; 4]>) -> MeshIR {
        MeshIR {
            mesh_name: "unit".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
            ],
            element_markers: vec![1; elements.len()],
            elements,
            boundary_faces: Vec::new(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: HashMap::new(),
        }
    }

    #[test]
    fn validate_strict_rejects_duplicate_nodes() {
        let mesh = base_mesh(vec![[0, 1, 1, 3]]);

        let errors = mesh
            .validate_strict(&MeshValidationPolicy::default())
            .expect_err("duplicate nodes must fail strict validation");

        assert!(errors
            .iter()
            .any(|error| error.contains("duplicate node indices")));
    }

    #[test]
    fn validate_strict_rejects_zero_volume_tetra() {
        let mut mesh = base_mesh(vec![[0, 1, 2, 3]]);
        mesh.nodes[3] = [2.0, 2.0, 0.0];

        let errors = mesh
            .validate_strict(&MeshValidationPolicy::default())
            .expect_err("zero-volume tetra must fail strict validation");

        assert!(errors
            .iter()
            .any(|error| error.contains("degenerate tetra volume")));
    }

    #[test]
    fn validate_strict_rejects_inverted_tetra() {
        let mesh = base_mesh(vec![[0, 1, 3, 2]]);

        let errors = mesh
            .validate_strict(&MeshValidationPolicy::default())
            .expect_err("inverted tetra must fail strict validation");

        assert!(errors
            .iter()
            .any(|error| error.contains("negative tetra orientation")));
    }
}
