#[allow(unused_imports)]
use crate::{
    ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, FdmPeriodicityIR,
    FemLinearSolverPolicy, FieldRefreshPolicyIR, HybridHintsIR, IntegratorChoice,
    RelaxationControlIR,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DiscretizationHintsIR {
    pub fdm: Option<FdmHintsIR>,
    pub fem: Option<FemHintsIR>,
    pub hybrid: Option<HybridHintsIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmHintsIR {
    /// Legacy single-cell hint (backward compatible).
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
        for (index, pair) in self.periodic_boundary_pairs.iter().enumerate() {
            if pair.pair_id.trim().is_empty() {
                errors.push(format!(
                    "mesh periodic boundary pair {index} must have a non-empty pair_id"
                ));
            }
            if !periodic_pair_ids.insert(pair.pair_id.clone()) {
                errors.push(format!(
                    "mesh periodic boundary pair id '{}' is duplicated",
                    pair.pair_id
                ));
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
}
