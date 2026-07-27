#[allow(unused_imports)]
use crate::{
    ExchangeBoundaryCondition, ExecutionPrecision, FdmMaterialIR, FdmPeriodicityIR,
    FemLinearSolverPolicy, FieldRefreshPolicyIR, HybridHintsIR, IntegratorChoice,
    RelaxationControlIR,
};
use serde::{de::Error as DeError, Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

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
#[serde(deny_unknown_fields)]
pub struct FdmDemagHintsIR {
    pub strategy: String,
    pub mode: String,
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
    /// Validated certificate for the resolved common convolution grid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid_certificate: Option<crate::plan::FdmGridCertificateIR>,
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
    /// Planner-resolved periodic image/padding budget consumed by runtime
    /// allocators for the common convolution grid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_periodic_images: Option<crate::execution::ResolvedPeriodicImagesIR>,
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

/// Canonical topology payload for a multilayer FDM certificate.
///
/// The payload is intentionally integer-encoded so the planner and runner can
/// hash identical layer geometry/mask facts without floating-point formatting.
pub fn fdm_multilayer_topology_tokens(layers: &[FdmLayerPlanIR]) -> Vec<u32> {
    fn push_f64(tokens: &mut Vec<u32>, value: f64) {
        let bits = value.to_bits();
        tokens.push((bits >> 32) as u32);
        tokens.push(bits as u32);
    }
    fn push_text(tokens: &mut Vec<u32>, value: &str) {
        tokens.push(value.len() as u32);
        tokens.extend(value.as_bytes().chunks(4).map(|chunk| {
            chunk
                .iter()
                .enumerate()
                .fold(0u32, |packed, (index, byte)| {
                    packed | (*byte as u32) << (index * 8)
                })
        }));
    }

    let mut tokens = Vec::new();
    tokens.push(layers.len() as u32);
    for layer in layers {
        push_text(&mut tokens, &layer.magnet_name);
        tokens.extend(layer.native_grid);
        for value in layer.native_cell_size {
            push_f64(&mut tokens, value);
        }
        for value in layer.native_origin {
            push_f64(&mut tokens, value);
        }
        match layer.native_active_mask.as_deref() {
            Some(mask) => {
                tokens.push(mask.len() as u32);
                tokens.extend(mask.iter().map(|active| u32::from(*active)));
            }
            None => tokens.push(u32::MAX),
        }
        tokens.extend(layer.convolution_grid);
        for value in layer.convolution_cell_size {
            push_f64(&mut tokens, value);
        }
        for value in layer.convolution_origin {
            push_f64(&mut tokens, value);
        }
        push_text(&mut tokens, &layer.transfer_kind);
    }
    tokens
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum FemCellTypeIR {
    Tet4,
    Prism6,
    Pyramid5,
    Hex8,
}

impl FemCellTypeIR {
    pub const fn arity(self) -> usize {
        match self {
            Self::Tet4 => 4,
            Self::Prism6 => 6,
            Self::Pyramid5 => 5,
            Self::Hex8 => 8,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum FemFacetTypeIR {
    Tri3,
    Quad4,
}

impl FemFacetTypeIR {
    pub const fn arity(self) -> usize {
        match self {
            Self::Tri3 => 3,
            Self::Quad4 => 4,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum FemFacetRoleIR {
    Exterior,
    MaterialInterface,
    PeriodicSeam,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FemConnectivityIR {
    pub types: Vec<FemCellTypeIR>,
    pub offsets: Vec<u32>,
    pub nodes: Vec<u32>,
}

impl FemConnectivityIR {
    pub fn empty() -> Self {
        Self {
            types: Vec::new(),
            offsets: vec![0],
            nodes: Vec::new(),
        }
    }

    pub fn from_tet4(elements: Vec<[u32; 4]>) -> Self {
        let mut nodes = Vec::with_capacity(elements.len() * 4);
        for element in &elements {
            nodes.extend(element);
        }
        Self {
            types: vec![FemCellTypeIR::Tet4; elements.len()],
            offsets: (0..=elements.len())
                .map(|index| (index * 4) as u32)
                .collect(),
            nodes,
        }
    }

    pub fn len(&self) -> usize {
        self.types.len()
    }

    pub fn is_empty(&self) -> bool {
        self.types.is_empty()
    }

    pub fn item_nodes(&self, ordinal: usize) -> Option<&[u32]> {
        let start = *self.offsets.get(ordinal)? as usize;
        let end = *self.offsets.get(ordinal + 1)? as usize;
        self.nodes.get(start..end)
    }

    pub fn iter(&self) -> impl Iterator<Item = FemCellView<'_>> {
        self.types
            .iter()
            .copied()
            .enumerate()
            .filter_map(|(ordinal, cell_type)| {
                self.item_nodes(ordinal).map(|nodes| FemCellView {
                    global_ordinal: ordinal,
                    cell_type,
                    nodes,
                })
            })
    }

    pub fn require_tet4(&self) -> Result<Vec<[u32; 4]>, String> {
        self.iter()
            .map(|cell| {
                if cell.cell_type != FemCellTypeIR::Tet4 || cell.nodes.len() != 4 {
                    return Err(format!(
                        "tet4 topology required, but cell {} is {:?}",
                        cell.global_ordinal, cell.cell_type
                    ));
                }
                Ok([cell.nodes[0], cell.nodes[1], cell.nodes[2], cell.nodes[3]])
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FemCellView<'a> {
    pub global_ordinal: usize,
    pub cell_type: FemCellTypeIR,
    pub nodes: &'a [u32],
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FemFacetConnectivityIR {
    pub types: Vec<FemFacetTypeIR>,
    pub roles: Vec<FemFacetRoleIR>,
    pub offsets: Vec<u32>,
    pub nodes: Vec<u32>,
}

impl FemFacetConnectivityIR {
    pub fn empty() -> Self {
        Self {
            types: Vec::new(),
            roles: Vec::new(),
            offsets: vec![0],
            nodes: Vec::new(),
        }
    }

    pub fn from_tri3(boundary_faces: Vec<[u32; 3]>) -> Self {
        let mut nodes = Vec::with_capacity(boundary_faces.len() * 3);
        for face in &boundary_faces {
            nodes.extend(face);
        }
        Self {
            types: vec![FemFacetTypeIR::Tri3; boundary_faces.len()],
            roles: vec![FemFacetRoleIR::Exterior; boundary_faces.len()],
            offsets: (0..=boundary_faces.len())
                .map(|index| (index * 3) as u32)
                .collect(),
            nodes,
        }
    }

    pub fn len(&self) -> usize {
        self.types.len()
    }

    pub fn is_empty(&self) -> bool {
        self.types.is_empty()
    }

    pub fn item_nodes(&self, ordinal: usize) -> Option<&[u32]> {
        let start = *self.offsets.get(ordinal)? as usize;
        let end = *self.offsets.get(ordinal + 1)? as usize;
        self.nodes.get(start..end)
    }

    pub fn iter(&self) -> impl Iterator<Item = FemFacetView<'_>> {
        self.types
            .iter()
            .copied()
            .zip(self.roles.iter().copied())
            .enumerate()
            .filter_map(|(global_ordinal, (facet_type, role))| {
                self.item_nodes(global_ordinal).map(|nodes| FemFacetView {
                    global_ordinal,
                    facet_type,
                    role,
                    nodes,
                })
            })
    }

    pub fn require_tri3(&self) -> Result<Vec<[u32; 3]>, String> {
        self.iter()
            .map(|facet| {
                if facet.facet_type != FemFacetTypeIR::Tri3 || facet.nodes.len() != 3 {
                    return Err(format!(
                        "tri3 topology required, but facet {} is {:?}",
                        facet.global_ordinal, facet.facet_type
                    ));
                }
                Ok([facet.nodes[0], facet.nodes[1], facet.nodes[2]])
            })
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FemFacetView<'a> {
    pub global_ordinal: usize,
    pub facet_type: FemFacetTypeIR,
    pub role: FemFacetRoleIR,
    pub nodes: &'a [u32],
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MeshIR {
    pub mesh_name: String,
    pub nodes: Vec<[f64; 3]>,
    pub cells: FemConnectivityIR,
    pub element_markers: Vec<u32>,
    pub facets: FemFacetConnectivityIR,
    pub boundary_markers: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periodic_boundary_pairs: Vec<MeshPeriodicBoundaryPairIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periodic_node_pairs: Vec<MeshPeriodicNodePairIR>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub per_domain_quality: HashMap<u32, MeshQualityIR>,
}

#[derive(Deserialize)]
struct MeshIRWire {
    mesh_name: String,
    nodes: Vec<[f64; 3]>,
    #[serde(default)]
    cells: Option<FemConnectivityIR>,
    #[serde(default)]
    facets: Option<FemFacetConnectivityIR>,
    #[serde(default)]
    elements: Option<Vec<[u32; 4]>>,
    #[serde(default)]
    boundary_faces: Option<Vec<[u32; 3]>>,
    element_markers: Vec<u32>,
    boundary_markers: Vec<u32>,
    #[serde(default)]
    periodic_boundary_pairs: Vec<MeshPeriodicBoundaryPairIR>,
    #[serde(default)]
    periodic_node_pairs: Vec<MeshPeriodicNodePairIR>,
    #[serde(default)]
    per_domain_quality: HashMap<u32, MeshQualityIR>,
}

impl<'de> Deserialize<'de> for MeshIR {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = MeshIRWire::deserialize(deserializer)?;
        let has_v2 = wire.cells.is_some() || wire.facets.is_some();
        let has_legacy = wire.elements.is_some() || wire.boundary_faces.is_some();
        if has_v2 && has_legacy {
            return Err(D::Error::custom(
                "mesh payload contains both legacy and v2 topology",
            ));
        }
        let (cells, facets) =
            if has_v2 {
                (
                    wire.cells
                        .ok_or_else(|| D::Error::custom("v2 mesh topology requires cells"))?,
                    wire.facets
                        .ok_or_else(|| D::Error::custom("v2 mesh topology requires facets"))?,
                )
            } else if has_legacy {
                (
                    FemConnectivityIR::from_tet4(wire.elements.ok_or_else(|| {
                        D::Error::custom("legacy mesh topology requires elements")
                    })?),
                    FemFacetConnectivityIR::from_tri3(wire.boundary_faces.ok_or_else(|| {
                        D::Error::custom("legacy mesh topology requires boundary_faces")
                    })?),
                )
            } else {
                return Err(D::Error::custom(
                    "mesh payload must provide either v2 or legacy topology",
                ));
            };
        Ok(Self {
            mesh_name: wire.mesh_name,
            nodes: wire.nodes,
            cells,
            element_markers: wire.element_markers,
            facets,
            boundary_markers: wire.boundary_markers,
            periodic_boundary_pairs: wire.periodic_boundary_pairs,
            periodic_node_pairs: wire.periodic_node_pairs,
            per_domain_quality: wire.per_domain_quality,
        })
    }
}

impl MeshIR {
    #[allow(clippy::too_many_arguments)]
    pub fn from_legacy_tet4(
        mesh_name: String,
        nodes: Vec<[f64; 3]>,
        elements: Vec<[u32; 4]>,
        element_markers: Vec<u32>,
        boundary_faces: Vec<[u32; 3]>,
        boundary_markers: Vec<u32>,
        periodic_boundary_pairs: Vec<MeshPeriodicBoundaryPairIR>,
        periodic_node_pairs: Vec<MeshPeriodicNodePairIR>,
        per_domain_quality: HashMap<u32, MeshQualityIR>,
    ) -> Self {
        Self {
            mesh_name,
            nodes,
            cells: FemConnectivityIR::from_tet4(elements),
            element_markers,
            facets: FemFacetConnectivityIR::from_tri3(boundary_faces),
            boundary_markers,
            periodic_boundary_pairs,
            periodic_node_pairs,
            per_domain_quality,
        }
    }

    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }

    pub fn facet_count(&self) -> usize {
        self.facets.len()
    }

    pub fn require_tet4_elements(&self) -> Result<Vec<[u32; 4]>, String> {
        self.cells.require_tet4()
    }

    pub fn require_tri3_boundary_faces(&self) -> Result<Vec<[u32; 3]>, String> {
        self.facets.require_tri3()
    }

    pub fn set_tet4_cells(&mut self, elements: Vec<[u32; 4]>) {
        self.cells = FemConnectivityIR::from_tet4(elements);
    }

    pub fn push_tet4_cell(&mut self, element: [u32; 4]) -> Result<(), String> {
        let mut elements = self.require_tet4_elements()?;
        elements.push(element);
        self.set_tet4_cells(elements);
        Ok(())
    }

    pub fn set_tri3_facets(&mut self, faces: Vec<[u32; 3]>) {
        self.facets = FemFacetConnectivityIR::from_tri3(faces);
    }

    pub fn push_tri3_facet(&mut self, face: [u32; 3]) -> Result<(), String> {
        let mut faces = self.require_tri3_boundary_faces()?;
        faces.push(face);
        self.set_tri3_facets(faces);
        Ok(())
    }

    pub fn extend_tri3_facets(
        &mut self,
        faces: impl IntoIterator<Item = [u32; 3]>,
    ) -> Result<(), String> {
        let mut existing = self.require_tri3_boundary_faces()?;
        existing.extend(faces);
        self.set_tri3_facets(existing);
        Ok(())
    }
}

/// Production v6 evidence for a mirrored FEM periodic mesh.
///
/// Pair lists are only input evidence; this certificate records the checked
/// face/node bijections and the closed equivalence-class identity consumed by
/// planner/runtime layers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeriodicMeshCertificateV6IR {
    pub schema_version: String,
    pub certificate_status: String,
    pub topology_fingerprint: String,
    pub axis_pairs: Vec<PeriodicAxisCertificateV6IR>,
    pub magnetic_class_count: u64,
    pub magnetic_pair_count: u64,
    pub scalar_class_count: u64,
    pub scalar_pair_count: u64,
    pub magnetic_equivalence_classes_sha256: String,
    pub scalar_equivalence_classes_sha256: String,
    pub translation_residual_max_m: f64,
    pub orientation_residual_max: f64,
    pub normal_mismatch_max: f64,
    pub boundary_topology_match: bool,
    pub fe_order_match: bool,
    pub material_region_match: bool,
    pub corner_edge_cycle_unique: bool,
    /// Number of audited two-axis seam node classes.
    #[serde(default)]
    pub edge_class_count: u64,
    /// Number of audited three-or-more-axis seam node classes.
    #[serde(default)]
    pub corner_class_count: u64,
    /// Largest translation residual observed while checking commuting paths.
    #[serde(default)]
    pub max_commutation_residual_m: f64,
    pub m0_seam_mismatch_max: f64,
    pub h_demag0_seam_mismatch_max: f64,
    /// Stable identity of the marker/region assignment consumed by the seam.
    #[serde(default)]
    pub marker_map_fingerprint: String,
    /// Stable identity of realized FEM material coefficient payloads.
    #[serde(default)]
    pub material_realization_fingerprint: String,
    /// Number of non-trivial region/material equivalence classes.
    #[serde(default)]
    pub region_class_count: u64,
    /// Maximum normalized residual across paired realized coefficient values.
    #[serde(default)]
    pub max_material_residual: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeriodicAxisCertificateV6IR {
    pub pair_id: String,
    pub axis: Option<String>,
    pub node_pair_count: u64,
    pub face_pair_count: u64,
    #[serde(default)]
    pub face_pairs: Vec<PeriodicFacePairCertificateV6IR>,
    pub translation_residual_max_m: f64,
    pub orientation_residual_max: f64,
    pub normal_mismatch_max: f64,
    pub boundary_topology_match: bool,
    pub material_region_match: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PeriodicFacePairCertificateV6IR {
    pub face_a: u64,
    pub face_b: u64,
    pub vertex_pairs: Vec<[u32; 2]>,
    pub translation_residual_max_m: f64,
    pub area_residual_m2: f64,
    pub normal_dot: f64,
    pub source_marker: u32,
    pub destination_marker: u32,
    pub source_element_markers: Vec<u32>,
    pub destination_element_markers: Vec<u32>,
}

fn sorted_face(face: [u32; 3]) -> [u32; 3] {
    let mut sorted = face;
    sorted.sort_unstable();
    sorted
}

fn mesh_topology_fingerprint(mesh: &MeshIR) -> String {
    let payload = serde_json::json!({
        "nodes": mesh.nodes,
        "cells": mesh.cells,
        "element_markers": mesh.element_markers,
        "facets": mesh.facets,
        "boundary_markers": mesh.boundary_markers,
        "periodic_boundary_pairs": mesh.periodic_boundary_pairs,
        "periodic_node_pairs": mesh.periodic_node_pairs,
    });
    let encoded = serde_json::to_vec(&payload).unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(encoded))
}

fn mesh_face_element_markers(mesh: &MeshIR) -> BTreeMap<[u32; 3], BTreeSet<u32>> {
    let mut result = BTreeMap::new();
    let Ok(elements) = mesh.require_tet4_elements() else {
        return result;
    };
    for (index, element) in elements.iter().enumerate() {
        let marker = mesh.element_markers.get(index).copied().unwrap_or(0);
        for face in [
            [element[0], element[1], element[2]],
            [element[0], element[1], element[3]],
            [element[0], element[2], element[3]],
            [element[1], element[2], element[3]],
        ] {
            result
                .entry(sorted_face(face))
                .or_insert_with(BTreeSet::new)
                .insert(marker);
        }
    }
    result
}

fn mesh_face_element_indices(mesh: &MeshIR) -> BTreeMap<[u32; 3], Vec<usize>> {
    let mut result = BTreeMap::<[u32; 3], Vec<usize>>::new();
    let Ok(elements) = mesh.require_tet4_elements() else {
        return result;
    };
    for (index, element) in elements.iter().enumerate() {
        for face in [
            [element[0], element[1], element[2]],
            [element[0], element[1], element[3]],
            [element[0], element[2], element[3]],
            [element[1], element[2], element[3]],
        ] {
            result.entry(sorted_face(face)).or_default().push(index);
        }
    }
    result
}

fn marker_map_fingerprint(mesh: &MeshIR) -> String {
    let payload = serde_json::json!({
        "element_markers": mesh.element_markers,
        "boundary_markers": mesh.boundary_markers,
        "periodic_boundary_pairs": mesh.periodic_boundary_pairs.iter().map(|pair| {
            serde_json::json!({
                "pair_id": pair.pair_id,
                "marker_a": pair.marker_a,
                "marker_b": pair.marker_b,
                "axis": pair.axis_hint,
            })
        }).collect::<Vec<_>>(),
    });
    let encoded = serde_json::to_vec(&payload).unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(encoded))
}

fn material_realization_fingerprint(
    ms_element_field: Option<&[f64]>,
    a_element_field: Option<&[f64]>,
) -> String {
    material_realization_fingerprint_with_nodal(ms_element_field, a_element_field, None, None)
}

fn material_realization_fingerprint_with_nodal(
    ms_element_field: Option<&[f64]>,
    a_element_field: Option<&[f64]>,
    ms_nodal_field: Option<&[f64]>,
    a_nodal_field: Option<&[f64]>,
) -> String {
    let payload = serde_json::json!({
      "ms_element_field": ms_element_field,
      "a_element_field": a_element_field,
      "ms_nodal_field": ms_nodal_field,
      "a_nodal_field": a_nodal_field,
    });
    let encoded = serde_json::to_vec(&payload).unwrap_or_default();
    format!("sha256:{:x}", Sha256::digest(encoded))
}

fn normalized_material_residual(left: f64, right: f64) -> f64 {
    if !left.is_finite() || !right.is_finite() {
        return f64::INFINITY;
    }
    (left - right).abs() / (1.0 + left.abs().max(right.abs()))
}

fn seam_material_residual(
    mesh: &MeshIR,
    certificate: &PeriodicMeshCertificateV6IR,
    ms_element_field: Option<&[f64]>,
    a_element_field: Option<&[f64]>,
) -> Result<f64, Vec<String>> {
    let boundary_faces = mesh.require_tri3_boundary_faces().map_err(|error| {
        vec![format!(
            "periodic material certification is tri3-only: {error}"
        )]
    })?;
    let face_elements = mesh_face_element_indices(mesh);
    let mut residual = 0.0_f64;
    let mut errors = Vec::new();
    for axis in &certificate.axis_pairs {
        for face in &axis.face_pairs {
            let source_face = boundary_faces
                .get(face.face_a as usize)
                .copied()
                .map(sorted_face);
            let destination_face = boundary_faces
                .get(face.face_b as usize)
                .copied()
                .map(sorted_face);
            let (Some(source_face), Some(destination_face)) = (source_face, destination_face)
            else {
                errors.push(format!(
                    "periodic material certificate '{}' references an invalid face pair",
                    axis.pair_id
                ));
                continue;
            };
            let source_indices = face_elements.get(&source_face).cloned().unwrap_or_default();
            let destination_indices = face_elements
                .get(&destination_face)
                .cloned()
                .unwrap_or_default();
            if source_indices.len() != destination_indices.len() {
                errors.push(format!(
                    "periodic material certificate '{}' has unequal adjacent element counts",
                    axis.pair_id
                ));
                continue;
            }
            for source_index in source_indices {
                let source_marker = mesh.element_markers.get(source_index).copied();
                let destination_index = destination_indices
                    .iter()
                    .copied()
                    .find(|index| mesh.element_markers.get(*index).copied() == source_marker);
                let Some(destination_index) = destination_index else {
                    errors.push(format!(
                        "periodic material certificate '{}' has mismatched adjacent region markers",
                        axis.pair_id
                    ));
                    continue;
                };
                for (label, field) in [("Ms", ms_element_field), ("A", a_element_field)] {
                    let Some(field) = field else { continue };
                    let (Some(left), Some(right)) =
                        (field.get(source_index), field.get(destination_index))
                    else {
                        errors.push(format!(
                            "periodic material certificate '{}' {} field length does not cover seam elements",
                            axis.pair_id, label
                        ));
                        continue;
                    };
                    residual = residual.max(normalized_material_residual(*left, *right));
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(residual)
    } else {
        Err(errors)
    }
}

fn seam_nodal_material_residual(
    mesh: &MeshIR,
    certificate: &PeriodicMeshCertificateV6IR,
    ms_nodal_field: Option<&[f64]>,
    a_nodal_field: Option<&[f64]>,
) -> Result<f64, Vec<String>> {
    let mut residual = 0.0_f64;
    let mut errors = Vec::new();
    for axis in &certificate.axis_pairs {
        for pair in mesh
            .periodic_node_pairs
            .iter()
            .filter(|pair| pair.pair_id == axis.pair_id)
        {
            for (label, field) in [("Ms", ms_nodal_field), ("A", a_nodal_field)] {
                let Some(field) = field else { continue };
                let (Some(left), Some(right)) = (
                    field.get(pair.node_a as usize),
                    field.get(pair.node_b as usize),
                ) else {
                    errors.push(format!(
                        "periodic material certificate '{}' {} nodal field length does not cover paired nodes",
                        axis.pair_id, label
                    ));
                    continue;
                };
                residual = residual.max(normalized_material_residual(*left, *right));
            }
        }
    }
    if errors.is_empty() {
        Ok(residual)
    } else {
        Err(errors)
    }
}

fn euclidean_residual(actual: [f64; 3], expected: [f64; 3]) -> f64 {
    ((actual[0] - expected[0]).powi(2)
        + (actual[1] - expected[1]).powi(2)
        + (actual[2] - expected[2]).powi(2))
    .sqrt()
}

fn triangle_normal(mesh: &MeshIR, face: [u32; 3]) -> [f64; 3] {
    let a = mesh.nodes[face[0] as usize];
    let b = mesh.nodes[face[1] as usize];
    let c = mesh.nodes[face[2] as usize];
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ]
}

fn triangle_area(mesh: &MeshIR, face: [u32; 3]) -> f64 {
    let normal = triangle_normal(mesh, face);
    0.5 * (normal[0].powi(2) + normal[1].powi(2) + normal[2].powi(2)).sqrt()
}

fn normalized_dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    let left_norm = (left[0].powi(2) + left[1].powi(2) + left[2].powi(2)).sqrt();
    let right_norm = (right[0].powi(2) + right[1].powi(2) + right[2].powi(2)).sqrt();
    if left_norm <= f64::MIN_POSITIVE || right_norm <= f64::MIN_POSITIVE {
        return 1.0;
    }
    (left[0] * right[0] + left[1] * right[1] + left[2] * right[2]) / (left_norm * right_norm)
}

#[derive(Debug, Clone, Copy, Default)]
struct EdgeCornerClosureAudit {
    valid: bool,
    edge_class_count: u64,
    corner_class_count: u64,
    max_commutation_residual_m: f64,
}

fn audit_edge_corner_closure(mesh: &MeshIR, errors: &mut Vec<String>) -> EdgeCornerClosureAudit {
    type EdgeKey = (String, u32);
    type EdgeValue = (u32, [f64; 3]);

    let mut edges = BTreeMap::<EdgeKey, EdgeValue>::new();
    let mut tolerances = BTreeMap::<String, f64>::new();
    let mut audit = EdgeCornerClosureAudit {
        valid: true,
        ..EdgeCornerClosureAudit::default()
    };
    for boundary in &mesh.periodic_boundary_pairs {
        let axis = boundary
            .axis_hint
            .clone()
            .unwrap_or_else(|| boundary.pair_id.clone());
        tolerances.insert(axis.clone(), boundary.tolerance.unwrap_or(1.0e-9).max(0.0));
        let Some(translation) = boundary.translation else {
            continue;
        };
        for pair in mesh
            .periodic_node_pairs
            .iter()
            .filter(|pair| pair.pair_id == boundary.pair_id)
        {
            let forward = (pair.node_b, translation);
            let reverse = (
                pair.node_a,
                [-translation[0], -translation[1], -translation[2]],
            );
            for (key, value) in [
                ((axis.clone(), pair.node_a), forward),
                ((axis.clone(), pair.node_b), reverse),
            ] {
                if let Some(previous) = edges.insert(key.clone(), value) {
                    let tolerance = tolerances.get(&key.0).copied().unwrap_or(1.0e-9);
                    if previous.0 != value.0 || euclidean_residual(previous.1, value.1) > tolerance
                    {
                        errors.push(format!(
                            "periodic v6 edge/corner mapping is not unique for axis '{}' at node {}",
                            key.0, key.1
                        ));
                        audit.valid = false;
                    }
                }
            }
        }
    }

    let mut axes_by_node = BTreeMap::<u32, BTreeSet<String>>::new();
    for (axis, node) in edges.keys() {
        axes_by_node.entry(*node).or_default().insert(axis.clone());
    }
    for axes in axes_by_node.values() {
        if axes.len() == 2 {
            audit.edge_class_count += 1;
        } else if axes.len() >= 3 {
            audit.corner_class_count += 1;
        }
    }
    for (node, axes) in axes_by_node.iter().filter(|(_, axes)| axes.len() > 1) {
        let axes = axes.iter().cloned().collect::<Vec<_>>();
        for (index, axis_a) in axes.iter().enumerate() {
            for axis_b in axes.iter().skip(index + 1) {
                let Some((mid_ab, translation_ab)) = edges.get(&(axis_a.clone(), *node)) else {
                    continue;
                };
                let Some((end_ab, translation_ba)) = edges.get(&(axis_b.clone(), *mid_ab)) else {
                    errors.push(format!(
                        "periodic v6 edge/corner closure is incomplete at node {} for axes '{}'/'{}'",
                        node, axis_a, axis_b
                    ));
                    audit.valid = false;
                    continue;
                };
                let Some((mid_ba, translation_b)) = edges.get(&(axis_b.clone(), *node)) else {
                    continue;
                };
                let Some((end_ba, translation_ab_again)) = edges.get(&(axis_a.clone(), *mid_ba))
                else {
                    errors.push(format!(
                        "periodic v6 edge/corner closure is incomplete at node {} for axes '{}'/'{}'",
                        node, axis_a, axis_b
                    ));
                    audit.valid = false;
                    continue;
                };
                let tolerance = tolerances
                    .get(axis_a)
                    .copied()
                    .unwrap_or(1.0e-9)
                    .max(tolerances.get(axis_b).copied().unwrap_or(1.0e-9));
                let composed_ab = [
                    translation_ab[0] + translation_ba[0],
                    translation_ab[1] + translation_ba[1],
                    translation_ab[2] + translation_ba[2],
                ];
                let composed_ba = [
                    translation_b[0] + translation_ab_again[0],
                    translation_b[1] + translation_ab_again[1],
                    translation_b[2] + translation_ab_again[2],
                ];
                let commutation_residual = euclidean_residual(composed_ab, composed_ba);
                audit.max_commutation_residual_m =
                    audit.max_commutation_residual_m.max(commutation_residual);
                if end_ab != end_ba || commutation_residual > tolerance {
                    errors.push(format!(
                        "periodic v6 edge/corner translations do not commute at node {} for axes '{}'/'{}'",
                        node, axis_a, axis_b
                    ));
                    audit.valid = false;
                }
            }
        }
    }
    audit
}

fn periodic_equivalence_classes(mesh: &MeshIR) -> (Vec<Vec<(u32, [f64; 3])>>, Vec<String>) {
    let mut graph: BTreeMap<u32, Vec<(u32, [f64; 3])>> = BTreeMap::new();
    let mut errors = Vec::new();
    for pair in &mesh.periodic_node_pairs {
        let Some(boundary_pair) = mesh
            .periodic_boundary_pairs
            .iter()
            .find(|boundary| boundary.pair_id == pair.pair_id)
        else {
            continue;
        };
        let Some(translation) = boundary_pair.translation else {
            continue;
        };
        graph
            .entry(pair.node_a)
            .or_default()
            .push((pair.node_b, translation));
        graph.entry(pair.node_b).or_default().push((
            pair.node_a,
            [-translation[0], -translation[1], -translation[2]],
        ));
    }
    let tolerance = mesh
        .periodic_boundary_pairs
        .iter()
        .filter_map(|pair| pair.tolerance)
        .fold(1.0e-9_f64, f64::max);
    let mut visited = BTreeSet::new();
    let mut classes = Vec::new();
    for &representative in graph.keys() {
        if visited.contains(&representative) {
            continue;
        }
        let mut queue = VecDeque::from([(representative, [0.0, 0.0, 0.0])]);
        let mut translations = BTreeMap::new();
        while let Some((node, translation_from_rep)) = queue.pop_front() {
            if let Some(previous) = translations.insert(node, translation_from_rep) {
                if euclidean_residual(previous, translation_from_rep) > tolerance {
                    errors.push(format!(
                        "periodic v6 equivalence class has path-dependent translation at node {node}"
                    ));
                }
                continue;
            }
            visited.insert(node);
            for (neighbor, edge_translation) in graph.get(&node).into_iter().flatten() {
                queue.push_back((
                    *neighbor,
                    [
                        translation_from_rep[0] + edge_translation[0],
                        translation_from_rep[1] + edge_translation[1],
                        translation_from_rep[2] + edge_translation[2],
                    ],
                ));
            }
        }
        classes.push(translations.into_iter().collect());
    }
    (classes, errors)
}

/// Semantic role assigned to a certified boundary marker.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum BoundaryRole {
    MagneticBoundary,
    MagneticAirInterface,
    GammaOut,
}

/// Topology-backed proof that a marker has one boundary role.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BoundaryRoleIR {
    pub marker: i32,
    pub role: BoundaryRole,
    pub face_count: u64,
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
    /// Return the topology identity consumed by periodic certificate v6.
    pub fn topology_fingerprint_v6(&self) -> String {
        mesh_topology_fingerprint(self)
    }

    /// Build the v6 mirrored-periodic certificate from explicit mesh topology.
    ///
    /// This is intentionally strict: a pair list without a complete translated
    /// face bijection, opposite outward normals, material-domain agreement, or
    /// closed multi-axis equivalence classes is not a certificate.
    pub fn periodic_mesh_certificate_v6(&self) -> Result<PeriodicMeshCertificateV6IR, Vec<String>> {
        let mut errors = Vec::new();
        let boundary_faces = match self.require_tri3_boundary_faces() {
            Ok(faces) => faces,
            Err(error) => {
                errors.push(format!("periodic v6 certification is tri3-only: {error}"));
                Vec::new()
            }
        };
        if let Err(error) = self.require_tet4_elements() {
            errors.push(format!("periodic v6 certification is tet4-only: {error}"));
        }
        if self.periodic_boundary_pairs.is_empty() {
            errors.push("periodic v6 certificate requires boundary pair metadata".to_string());
        }
        if self.periodic_node_pairs.is_empty() {
            errors.push("periodic v6 certificate requires node pair metadata".to_string());
        }

        let topology_fingerprint = self.topology_fingerprint_v6();
        let element_markers_by_face = mesh_face_element_markers(self);
        let mut axis_pairs = Vec::new();
        let mut global_translation_residual = 0.0_f64;
        let mut global_orientation_residual = 0.0_f64;
        let mut global_normal_mismatch = 0.0_f64;
        let mut boundary_topology_match = true;
        let mut material_region_match = true;

        for boundary_pair in &self.periodic_boundary_pairs {
            let Some(translation) = boundary_pair.translation else {
                errors.push(format!(
                    "periodic v6 pair '{}' is missing an explicit translation",
                    boundary_pair.pair_id
                ));
                continue;
            };
            let tolerance = boundary_pair.tolerance.unwrap_or(1.0e-9).max(0.0);
            let source_faces = boundary_faces
                .iter()
                .zip(self.boundary_markers.iter())
                .enumerate()
                .filter_map(|(index, (face, marker))| {
                    (*marker == boundary_pair.marker_a).then_some((index, *face))
                })
                .collect::<Vec<_>>();
            let destination_faces = boundary_faces
                .iter()
                .zip(self.boundary_markers.iter())
                .enumerate()
                .filter_map(|(index, (face, marker))| {
                    (*marker == boundary_pair.marker_b).then_some((index, *face))
                })
                .collect::<Vec<_>>();
            let source_face_nodes = source_faces
                .iter()
                .flat_map(|(_, face)| face.iter().copied())
                .collect::<BTreeSet<_>>();
            let destination_face_nodes = destination_faces
                .iter()
                .flat_map(|(_, face)| face.iter().copied())
                .collect::<BTreeSet<_>>();
            // A single axis may be represented by several disjoint surface
            // pairs after OCC fragmentation. Scope the shared pair-id node
            // list to this marker pair before checking its bijection.
            let node_pairs = self
                .periodic_node_pairs
                .iter()
                .filter(|pair| {
                    pair.pair_id == boundary_pair.pair_id
                        && source_face_nodes.contains(&pair.node_a)
                        && destination_face_nodes.contains(&pair.node_b)
                })
                .collect::<Vec<_>>();
            let mut sources = BTreeSet::new();
            let mut destinations = BTreeSet::new();
            let mut translation_residual = 0.0_f64;
            for pair in &node_pairs {
                if !sources.insert(pair.node_a) || !destinations.insert(pair.node_b) {
                    errors.push(format!(
                        "periodic v6 pair '{}' does not form a node bijection",
                        boundary_pair.pair_id
                    ));
                }
                let (Some(src), Some(dst)) = (
                    self.nodes.get(pair.node_a as usize),
                    self.nodes.get(pair.node_b as usize),
                ) else {
                    errors.push(format!(
                        "periodic v6 pair '{}' references an invalid node",
                        boundary_pair.pair_id
                    ));
                    continue;
                };
                let residual = euclidean_residual(
                    [dst[0] - src[0], dst[1] - src[1], dst[2] - src[2]],
                    translation,
                );
                translation_residual = translation_residual.max(residual);
            }
            if node_pairs.is_empty() || sources.len() != destinations.len() {
                errors.push(format!(
                    "periodic v6 pair '{}' has incomplete node bijection",
                    boundary_pair.pair_id
                ));
            }
            if translation_residual > tolerance {
                errors.push(format!(
                    "periodic v6 pair '{}' translation residual {translation_residual:.3e} exceeds tolerance {tolerance:.3e}",
                    boundary_pair.pair_id
                ));
            }

            if sources != source_face_nodes || destinations != destination_face_nodes {
                errors.push(format!(
                    "periodic v6 pair '{}' node bijection does not cover exactly the paired boundary faces",
                    boundary_pair.pair_id
                ));
            }
            let mut face_topology_match =
                !source_faces.is_empty() && source_faces.len() == destination_faces.len();
            let mut axis_normal_mismatch = 0.0_f64;
            let mut axis_orientation_residual = 0.0_f64;
            let mut axis_material_match = true;
            let mut used_destination_faces = BTreeSet::new();
            let mut axis_face_pairs = Vec::new();
            let node_map = node_pairs
                .iter()
                .map(|pair| (pair.node_a, pair.node_b))
                .collect::<BTreeMap<_, _>>();
            for (source_face_index, source_face) in &source_faces {
                let destination_index = source_face
                    .iter()
                    .map(|node| node_map.get(node).copied())
                    .collect::<Option<Vec<_>>>()
                    .and_then(|nodes| <[u32; 3]>::try_from(nodes).ok())
                    .map(sorted_face)
                    .and_then(|expected| {
                        destination_faces.iter().enumerate().find_map(
                            |(index, (_, destination_face))| {
                                (!used_destination_faces.contains(&index)
                                    && sorted_face(*destination_face) == expected)
                                    .then_some(index)
                            },
                        )
                    });
                let Some(destination_index) = destination_index else {
                    face_topology_match = false;
                    continue;
                };
                used_destination_faces.insert(destination_index);
                let (destination_face_index, destination_face) =
                    destination_faces[destination_index];
                let source_normal = triangle_normal(self, *source_face);
                let destination_normal = triangle_normal(self, destination_face);
                let normal_dot = normalized_dot(source_normal, destination_normal);
                let normal_mismatch = (normal_dot + 1.0).abs();
                axis_normal_mismatch = axis_normal_mismatch.max(normal_mismatch);
                let area_residual_m2 = (triangle_area(self, *source_face)
                    - triangle_area(self, destination_face))
                .abs();
                axis_orientation_residual = axis_orientation_residual.max(area_residual_m2);
                if normal_dot > -1.0 + 1.0e-8 {
                    face_topology_match = false;
                }
                let source_regions = element_markers_by_face
                    .get(&sorted_face(*source_face))
                    .cloned()
                    .unwrap_or_default();
                let destination_regions = element_markers_by_face
                    .get(&sorted_face(destination_face))
                    .cloned()
                    .unwrap_or_default();
                if source_regions != destination_regions {
                    axis_material_match = false;
                }
                let vertex_pairs = source_face
                    .iter()
                    .filter_map(|node_a| node_map.get(node_a).map(|node_b| [*node_a, *node_b]))
                    .collect::<Vec<_>>();
                let face_translation_residual = vertex_pairs
                    .iter()
                    .filter_map(|[node_a, node_b]| {
                        self.nodes
                            .get(*node_a as usize)
                            .zip(self.nodes.get(*node_b as usize))
                            .map(|(src, dst)| {
                                euclidean_residual(
                                    [dst[0] - src[0], dst[1] - src[1], dst[2] - src[2]],
                                    translation,
                                )
                            })
                    })
                    .fold(0.0_f64, f64::max);
                if vertex_pairs.len() != source_face.len()
                    || vertex_pairs
                        .iter()
                        .map(|pair| pair[1])
                        .collect::<BTreeSet<_>>()
                        != destination_face.iter().copied().collect::<BTreeSet<_>>()
                {
                    face_topology_match = false;
                    errors.push(format!(
                        "periodic v6 pair '{}' face {} to {} lacks an explicit vertex bijection",
                        boundary_pair.pair_id, source_face_index, destination_face_index
                    ));
                }
                axis_face_pairs.push(PeriodicFacePairCertificateV6IR {
                    face_a: *source_face_index as u64,
                    face_b: destination_face_index as u64,
                    vertex_pairs,
                    translation_residual_max_m: face_translation_residual,
                    area_residual_m2,
                    normal_dot,
                    source_marker: boundary_pair.marker_a,
                    destination_marker: boundary_pair.marker_b,
                    source_element_markers: source_regions.iter().copied().collect(),
                    destination_element_markers: destination_regions.iter().copied().collect(),
                });
            }
            if used_destination_faces.len() != destination_faces.len() {
                face_topology_match = false;
            }
            if !face_topology_match {
                errors.push(format!(
                    "periodic v6 pair '{}' face topology/orientation is not a bijection",
                    boundary_pair.pair_id
                ));
            }
            if !axis_material_match {
                errors.push(format!(
                    "periodic v6 pair '{}' has mismatched material regions on seam faces",
                    boundary_pair.pair_id
                ));
            }
            boundary_topology_match &= face_topology_match;
            material_region_match &= axis_material_match;
            global_translation_residual = global_translation_residual.max(translation_residual);
            global_orientation_residual =
                global_orientation_residual.max(axis_orientation_residual);
            global_normal_mismatch = global_normal_mismatch.max(axis_normal_mismatch);
            axis_pairs.push(PeriodicAxisCertificateV6IR {
                pair_id: boundary_pair.pair_id.clone(),
                axis: boundary_pair.axis_hint.clone(),
                node_pair_count: node_pairs.len() as u64,
                face_pair_count: axis_face_pairs.len() as u64,
                face_pairs: axis_face_pairs,
                translation_residual_max_m: translation_residual,
                orientation_residual_max: axis_orientation_residual,
                normal_mismatch_max: axis_normal_mismatch,
                boundary_topology_match: face_topology_match,
                material_region_match: axis_material_match,
            });
        }

        let (classes, class_errors) = periodic_equivalence_classes(self);
        errors.extend(class_errors);
        let edge_corner_audit = audit_edge_corner_closure(self, &mut errors);
        let class_count = classes.iter().filter(|class| class.len() > 1).count() as u64;
        let pair_count = classes
            .iter()
            .map(|class| class.len().saturating_sub(1) as u64)
            .sum::<u64>();
        let class_payload = serde_json::to_vec(&classes).unwrap_or_default();
        let class_hash = format!("sha256:{:x}", Sha256::digest(class_payload));
        if errors.is_empty() {
            Ok(PeriodicMeshCertificateV6IR {
                schema_version: "periodic_mesh_certificate.v6".to_string(),
                certificate_status: "accepted".to_string(),
                topology_fingerprint,
                axis_pairs,
                magnetic_class_count: class_count,
                magnetic_pair_count: pair_count,
                scalar_class_count: class_count,
                scalar_pair_count: pair_count,
                magnetic_equivalence_classes_sha256: class_hash.clone(),
                scalar_equivalence_classes_sha256: class_hash,
                translation_residual_max_m: global_translation_residual,
                orientation_residual_max: global_orientation_residual,
                normal_mismatch_max: global_normal_mismatch,
                boundary_topology_match,
                fe_order_match: true,
                material_region_match,
                corner_edge_cycle_unique: edge_corner_audit.valid,
                edge_class_count: edge_corner_audit.edge_class_count,
                corner_class_count: edge_corner_audit.corner_class_count,
                max_commutation_residual_m: edge_corner_audit.max_commutation_residual_m,
                m0_seam_mismatch_max: 0.0,
                h_demag0_seam_mismatch_max: 0.0,
                marker_map_fingerprint: marker_map_fingerprint(self),
                material_realization_fingerprint: material_realization_fingerprint(None, None),
                region_class_count: class_count,
                max_material_residual: 0.0,
            })
        } else {
            Err(errors)
        }
    }

    /// Extend the structural v6 certificate with the realized element-DG0
    /// material lane used by conformal FEM regions.  The base certificate is
    /// still the sole PBC certificate; this method only adds its material
    /// evidence and rejects a seam before solver allocation when coefficients
    /// disagree across a paired face.
    pub fn periodic_mesh_certificate_v6_with_material_fields(
        &self,
        ms_element_field: Option<&[f64]>,
        a_element_field: Option<&[f64]>,
    ) -> Result<PeriodicMeshCertificateV6IR, Vec<String>> {
        self.periodic_mesh_certificate_v6_with_material_and_nodal_fields(
            ms_element_field,
            a_element_field,
            None,
            None,
        )
    }

    /// Extend the v6 certificate with both element-DG0 and nodal-P1 material
    /// realizations. Every published nodal coefficient must agree across the
    /// explicit periodic node bijection before a seam can be accepted.
    pub fn periodic_mesh_certificate_v6_with_material_and_nodal_fields(
        &self,
        ms_element_field: Option<&[f64]>,
        a_element_field: Option<&[f64]>,
        ms_nodal_field: Option<&[f64]>,
        a_nodal_field: Option<&[f64]>,
    ) -> Result<PeriodicMeshCertificateV6IR, Vec<String>> {
        let mut certificate = self.periodic_mesh_certificate_v6()?;
        let element_residual =
            seam_material_residual(self, &certificate, ms_element_field, a_element_field)?;
        let nodal_residual =
            seam_nodal_material_residual(self, &certificate, ms_nodal_field, a_nodal_field)?;
        let residual = element_residual.max(nodal_residual);
        if residual > 1.0e-12 {
            return Err(vec![format!(
                "periodic material certificate seam coefficient residual {residual:.3e} exceeds tolerance 1.000e-12"
            )]);
        }
        certificate.material_realization_fingerprint = material_realization_fingerprint_with_nodal(
            ms_element_field,
            a_element_field,
            ms_nodal_field,
            a_nodal_field,
        );
        certificate.max_material_residual = residual;
        Ok(certificate)
    }

    /// Bind the certificate to the canonical authored region/owner identity.
    /// Marker numbers alone are not sufficient: a remesh that reuses numeric
    /// markers for a different owner or region must produce a different seam
    /// identity. The caller supplies the serialized ProblemIR region list.
    pub fn periodic_certificate_with_region_identity<T: Serialize>(
        mut certificate: PeriodicMeshCertificateV6IR,
        region_identity: &T,
    ) -> PeriodicMeshCertificateV6IR {
        let payload = serde_json::json!({
            "marker_map_fingerprint": certificate.marker_map_fingerprint,
            "region_identity": region_identity,
        });
        let encoded = serde_json::to_vec(&payload).unwrap_or_default();
        certificate.marker_map_fingerprint = format!("sha256:{:x}", Sha256::digest(encoded));
        certificate.region_class_count = serde_json::to_value(region_identity)
            .ok()
            .and_then(|value| value.as_array().map(|items| items.len() as u64))
            .unwrap_or(certificate.region_class_count);
        certificate
    }

    /// Certify semantic boundary roles from volume adjacency.
    ///
    /// Marker values are treated as opaque IDs.  The outer air-box role is
    /// assigned only to faces that are topological exterior faces of an air
    /// element; an air/magnetic two-sided face is an interface.  This makes a
    /// marker usable for a boundary condition only after completeness and
    /// disjointness have been proven.
    pub fn certify_airbox_boundary_roles(&self) -> Result<Vec<BoundaryRoleIR>, Vec<String>> {
        let has_air = self.element_markers.iter().any(|marker| *marker == 0);
        if !has_air {
            return Ok(Vec::new());
        }
        let elements = self.require_tet4_elements().map_err(|error| {
            vec![format!(
                "airbox boundary-role certification is tet4-only: {error}"
            )]
        })?;
        let boundary_faces = self.require_tri3_boundary_faces().map_err(|error| {
            vec![format!(
                "airbox boundary-role certification is tri3-only: {error}"
            )]
        })?;

        type FaceKey = [u32; 3];
        let mut topology: BTreeMap<FaceKey, Vec<bool>> = BTreeMap::new();
        for (index, element) in elements.iter().enumerate() {
            let marker = self.element_markers.get(index).copied().unwrap_or(1);
            let is_air = marker == 0;
            let faces = [
                [element[0], element[1], element[2]],
                [element[0], element[1], element[3]],
                [element[0], element[2], element[3]],
                [element[1], element[2], element[3]],
            ];
            for mut face in faces {
                face.sort_unstable();
                topology.entry(face).or_default().push(is_air);
            }
        }

        let mut physical: BTreeMap<FaceKey, Vec<u32>> = BTreeMap::new();
        for (index, face) in boundary_faces.iter().enumerate() {
            let mut key = *face;
            key.sort_unstable();
            let marker = self.boundary_markers.get(index).copied().unwrap_or(0);
            physical.entry(key).or_default().push(marker);
        }
        let periodic_markers = self
            .periodic_boundary_pairs
            .iter()
            .flat_map(|pair| [pair.marker_a, pair.marker_b])
            .collect::<BTreeSet<_>>();

        let mut errors = Vec::new();
        let mut expected_outer = BTreeSet::new();
        let mut expected_interface = BTreeSet::new();
        let mut expected_magnetic = BTreeSet::new();
        for (face, adjacent) in &topology {
            match adjacent.as_slice() {
                [is_air] if *is_air => {
                    expected_outer.insert(*face);
                }
                [is_air] if !*is_air => {
                    expected_magnetic.insert(*face);
                }
                [first, second] if first != second => {
                    expected_interface.insert(*face);
                }
                _ => {}
            }
        }

        for face in &expected_outer {
            if !physical.contains_key(face) {
                errors.push(format!(
                    "airbox Gamma_out is incomplete: outer air face {:?} has no boundary marker",
                    face
                ));
            }
        }
        for face in &expected_interface {
            if !physical.contains_key(face) {
                errors.push(format!(
                    "magnetic-air interface is incomplete: interface face {:?} has no boundary marker",
                    face
                ));
            }
        }
        for face in &expected_magnetic {
            if !physical.contains_key(face) {
                errors.push(format!(
                    "magnetic boundary is incomplete: exterior magnetic face {:?} has no boundary marker",
                    face
                ));
            }
        }
        // Periodic airbox seams are topological exterior faces, but they are
        // not open Gamma_out boundaries. Their dedicated seam markers are
        // certified by periodic_mesh_certificate_v6 instead of the single
        // open-boundary Gamma_out role.
        expected_outer.retain(|face| {
            !physical.get(face).is_some_and(|markers| {
                markers
                    .iter()
                    .all(|marker| periodic_markers.contains(marker))
            })
        });

        let mut marker_roles: BTreeMap<(u32, BoundaryRole), u64> = BTreeMap::new();
        for (face, markers) in &physical {
            let Some(adjacent) = topology.get(face) else {
                errors.push(format!(
                    "boundary face {:?} is not present in tetrahedral topology",
                    face
                ));
                continue;
            };
            let role = match adjacent.as_slice() {
                [is_air] if *is_air => BoundaryRole::GammaOut,
                [is_air] if !*is_air => BoundaryRole::MagneticBoundary,
                [first, second] if first != second => BoundaryRole::MagneticAirInterface,
                _ => {
                    errors.push(format!(
                        "boundary face {:?} has ambiguous tetrahedral adjacency",
                        face
                    ));
                    continue;
                }
            };
            let Some(first_marker) = markers.first().copied() else {
                continue;
            };
            if role == BoundaryRole::GammaOut
                && !periodic_markers.is_empty()
                && markers
                    .iter()
                    .all(|marker| periodic_markers.contains(marker))
            {
                continue;
            }
            if markers.len() != 1 {
                errors.push(format!(
                    "boundary face {:?} is listed {} times in physical boundary groups",
                    face,
                    markers.len()
                ));
            }
            if markers.iter().any(|marker| *marker != first_marker) {
                errors.push(format!(
                    "boundary face {:?} has conflicting physical markers {:?}",
                    face, markers
                ));
            }
            if first_marker == 0 {
                errors.push(format!(
                    "boundary face {:?} uses reserved marker 0 for {:?}",
                    face, role
                ));
            }
            if first_marker > i32::MAX as u32 {
                errors.push(format!(
                    "boundary face {:?} marker {} does not fit certified i32 marker range",
                    face, first_marker
                ));
            }
            *marker_roles.entry((first_marker, role)).or_default() += 1;
        }

        let outer_markers = marker_roles
            .keys()
            .filter_map(|(marker, role)| (*role == BoundaryRole::GammaOut).then_some(*marker))
            .collect::<BTreeSet<_>>();
        if outer_markers.len() != 1 {
            errors.push(format!(
                "airbox Gamma_out must have exactly one certified marker, found {:?}",
                outer_markers
            ));
        }
        for marker in &outer_markers {
            if marker_roles
                .keys()
                .any(|(other, role)| other == marker && *role != BoundaryRole::GammaOut)
            {
                errors.push(format!(
                    "airbox Gamma_out marker {} is shared with another boundary role",
                    marker
                ));
            }
        }
        let mut roles_by_marker: BTreeMap<u32, BTreeSet<BoundaryRole>> = BTreeMap::new();
        for (marker, role) in marker_roles.keys() {
            roles_by_marker.entry(*marker).or_default().insert(*role);
        }
        for (marker, roles) in roles_by_marker {
            if roles.len() > 1 {
                errors.push(format!(
                    "boundary marker {} is shared across roles {:?}",
                    marker, roles
                ));
            }
        }
        if expected_outer.is_empty() {
            errors.push("airbox mesh must expose at least one Gamma_out face".to_string());
        }

        if errors.is_empty() {
            Ok(marker_roles
                .into_iter()
                .map(|((marker, role), face_count)| BoundaryRoleIR {
                    marker: marker as i32,
                    role,
                    face_count,
                })
                .collect())
        } else {
            Err(errors)
        }
    }

    /// Return the stable SHA-256 identity of the certified boundary-role set.
    pub fn airbox_boundary_certificate_sha256(&self) -> Result<String, Vec<String>> {
        let roles = self.certify_airbox_boundary_roles()?;
        let payload = serde_json::to_vec(&roles).map_err(|error| {
            vec![format!(
                "failed to serialize boundary-role certificate: {error}"
            )]
        })?;
        let digest = Sha256::digest(payload);
        Ok(format!("sha256:{digest:x}"))
    }

    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errors = Vec::new();

        if self.mesh_name.trim().is_empty() {
            errors.push("mesh_name must not be empty".to_string());
        }
        if self.nodes.is_empty() {
            errors.push("mesh.nodes must not be empty".to_string());
        }
        if self.cells.is_empty() {
            errors.push("mesh.cells must not be empty".to_string());
        }
        if self.element_markers.len() != self.cells.len() {
            errors.push("mesh.element_markers length must match mesh.cells length".to_string());
        }
        if self.boundary_markers.len() != self.facets.len() {
            errors.push("mesh.boundary_markers length must match mesh.facets length".to_string());
        }

        let node_count = self.nodes.len() as u32;
        validate_cell_connectivity(&self.cells, node_count, &mut errors);
        validate_facet_connectivity(&self.facets, node_count, &mut errors);
        let has_mixed_cells = self
            .cells
            .types
            .iter()
            .any(|cell_type| *cell_type != FemCellTypeIR::Tet4);
        if has_mixed_cells
            && (!self.periodic_boundary_pairs.is_empty()
                || !self.periodic_node_pairs.is_empty()
                || self
                    .facets
                    .roles
                    .iter()
                    .any(|role| *role == FemFacetRoleIR::PeriodicSeam))
        {
            errors.push(
                "mixed topology with periodic pairs or periodic_seam facets is not qualified; use tet4 or remove periodic topology"
                    .to_string(),
            );
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

        if self.element_markers.len() != self.cells.len() {
            errors.push("mesh.element_markers must cover every FEM cell".to_string());
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

        for cell in self.cells.iter() {
            let Some(coordinates) = cell
                .nodes
                .iter()
                .map(|node| self.nodes.get(*node as usize).copied())
                .collect::<Option<Vec<_>>>()
            else {
                continue;
            };
            let determinants = cell_jacobian_determinants(cell.cell_type, &coordinates);
            if cell.cell_type == FemCellTypeIR::Tet4 {
                let determinant = determinants[0];
                let volume = determinant / 6.0;
                if volume.abs() <= eps {
                    errors.push(format!(
                        "mesh element {} has degenerate tetra volume {volume:.6e} <= eps {eps:.6e}",
                        cell.global_ordinal
                    ));
                } else if policy.require_positive_orientation && volume < 0.0 {
                    errors.push(format!(
                        "mesh element {} has negative tetra orientation {volume:.6e}",
                        cell.global_ordinal
                    ));
                }
                continue;
            }
            let determinant_eps = eps * 6.0;
            let minimum_abs = determinants
                .iter()
                .map(|value| value.abs())
                .fold(f64::INFINITY, f64::min);
            if minimum_abs <= determinant_eps {
                errors.push(format!(
                    "mesh cell {} has degenerate {:?} Jacobian {minimum_abs:.6e} <= eps {determinant_eps:.6e}",
                    cell.global_ordinal, cell.cell_type
                ));
            } else if policy.require_positive_orientation
                && determinants.iter().any(|determinant| *determinant < 0.0)
            {
                let minimum = determinants.iter().copied().fold(f64::INFINITY, f64::min);
                errors.push(format!(
                    "mesh cell {} has negative {:?} Jacobian {minimum:.6e}",
                    cell.global_ordinal, cell.cell_type
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

fn validate_cell_connectivity(
    cells: &FemConnectivityIR,
    node_count: u32,
    errors: &mut Vec<String>,
) {
    validate_offsets(
        "cell",
        cells.types.len(),
        &cells.offsets,
        cells.nodes.len(),
        errors,
    );
    for (index, cell_type) in cells.types.iter().copied().enumerate() {
        validate_item_nodes(
            "cell",
            index,
            cell_type.arity(),
            cells.item_nodes(index),
            node_count,
            errors,
        );
    }
}

fn validate_facet_connectivity(
    facets: &FemFacetConnectivityIR,
    node_count: u32,
    errors: &mut Vec<String>,
) {
    validate_offsets(
        "facet",
        facets.types.len(),
        &facets.offsets,
        facets.nodes.len(),
        errors,
    );
    if facets.roles.len() != facets.types.len() {
        errors.push("mesh.facets.roles length must match mesh.facets.types length".to_string());
    }
    for (index, facet_type) in facets.types.iter().copied().enumerate() {
        validate_item_nodes(
            "facet",
            index,
            facet_type.arity(),
            facets.item_nodes(index),
            node_count,
            errors,
        );
    }
}

fn validate_offsets(
    kind: &str,
    item_count: usize,
    offsets: &[u32],
    connectivity_len: usize,
    errors: &mut Vec<String>,
) {
    if offsets.len() != item_count + 1 {
        errors.push(format!(
            "mesh.{kind}s.offsets length must equal {kind} count + 1"
        ));
        return;
    }
    if offsets.first().copied() != Some(0) {
        errors.push(format!("mesh.{kind}s.offsets must start at 0"));
    }
    if offsets.windows(2).any(|pair| pair[1] < pair[0]) {
        errors.push(format!("mesh.{kind}s.offsets must be monotone"));
    }
    if offsets.last().copied().map(|value| value as usize) != Some(connectivity_len) {
        errors.push(format!(
            "mesh.{kind}s.offsets must end at mesh.{kind}s.nodes length"
        ));
    }
}

fn validate_item_nodes(
    kind: &str,
    index: usize,
    expected_arity: usize,
    nodes: Option<&[u32]>,
    node_count: u32,
    errors: &mut Vec<String>,
) {
    let Some(nodes) = nodes else {
        errors.push(format!("mesh {kind} {index} has invalid CSR range"));
        return;
    };
    if nodes.len() != expected_arity {
        errors.push(format!(
            "mesh {kind} {index} has wrong arity {}; expected {expected_arity}",
            nodes.len()
        ));
    }
    if nodes.iter().any(|node| *node >= node_count) {
        errors.push(format!("mesh {kind} {index} contains invalid node index"));
    }
    if nodes.iter().copied().collect::<BTreeSet<_>>().len() != nodes.len() {
        errors.push(format!(
            "mesh {kind} {index} contains duplicate node indices"
        ));
    }
}

fn determinant3(matrix: [[f64; 3]; 3]) -> f64 {
    matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
}

fn mapped_jacobian_determinant(coordinates: &[[f64; 3]], derivatives: &[[f64; 3]]) -> f64 {
    let mut jacobian = [[0.0; 3]; 3];
    for (coordinate, derivative) in coordinates.iter().zip(derivatives) {
        for physical_axis in 0..3 {
            for reference_axis in 0..3 {
                jacobian[physical_axis][reference_axis] +=
                    coordinate[physical_axis] * derivative[reference_axis];
            }
        }
    }
    determinant3(jacobian)
}

fn cell_jacobian_determinants(cell_type: FemCellTypeIR, coordinates: &[[f64; 3]]) -> Vec<f64> {
    let q = 1.0 / 3.0_f64.sqrt();
    match cell_type {
        FemCellTypeIR::Tet4 => vec![determinant3([
            [
                coordinates[1][0] - coordinates[0][0],
                coordinates[2][0] - coordinates[0][0],
                coordinates[3][0] - coordinates[0][0],
            ],
            [
                coordinates[1][1] - coordinates[0][1],
                coordinates[2][1] - coordinates[0][1],
                coordinates[3][1] - coordinates[0][1],
            ],
            [
                coordinates[1][2] - coordinates[0][2],
                coordinates[2][2] - coordinates[0][2],
                coordinates[3][2] - coordinates[0][2],
            ],
        ])],
        FemCellTypeIR::Prism6 => [(1.0 / 6.0, 1.0 / 6.0, -q), (2.0 / 3.0, 1.0 / 6.0, q)]
            .into_iter()
            .map(|(r, s, t)| {
                let derivatives = [
                    [-(1.0 - t) / 2.0, -(1.0 - t) / 2.0, -(1.0 - r - s) / 2.0],
                    [(1.0 - t) / 2.0, 0.0, -r / 2.0],
                    [0.0, (1.0 - t) / 2.0, -s / 2.0],
                    [-(1.0 + t) / 2.0, -(1.0 + t) / 2.0, (1.0 - r - s) / 2.0],
                    [(1.0 + t) / 2.0, 0.0, r / 2.0],
                    [0.0, (1.0 + t) / 2.0, s / 2.0],
                ];
                mapped_jacobian_determinant(coordinates, &derivatives)
            })
            .collect(),
        FemCellTypeIR::Pyramid5 => [(-q, -q, 0.5 - q / 2.0), (q, q, 0.5 + q / 2.0)]
            .into_iter()
            .map(|(r, s, t)| {
                let derivatives = [
                    [
                        -(1.0 - s) * (1.0 - t) / 4.0,
                        -(1.0 - r) * (1.0 - t) / 4.0,
                        -(1.0 - r) * (1.0 - s) / 4.0,
                    ],
                    [
                        (1.0 - s) * (1.0 - t) / 4.0,
                        -(1.0 + r) * (1.0 - t) / 4.0,
                        -(1.0 + r) * (1.0 - s) / 4.0,
                    ],
                    [
                        (1.0 + s) * (1.0 - t) / 4.0,
                        (1.0 + r) * (1.0 - t) / 4.0,
                        -(1.0 + r) * (1.0 + s) / 4.0,
                    ],
                    [
                        -(1.0 + s) * (1.0 - t) / 4.0,
                        (1.0 - r) * (1.0 - t) / 4.0,
                        -(1.0 - r) * (1.0 + s) / 4.0,
                    ],
                    [0.0, 0.0, 1.0],
                ];
                mapped_jacobian_determinant(coordinates, &derivatives)
            })
            .collect(),
        FemCellTypeIR::Hex8 => {
            let signs = [
                [-1.0, -1.0, -1.0],
                [1.0, -1.0, -1.0],
                [1.0, 1.0, -1.0],
                [-1.0, 1.0, -1.0],
                [-1.0, -1.0, 1.0],
                [1.0, -1.0, 1.0],
                [1.0, 1.0, 1.0],
                [-1.0, 1.0, 1.0],
            ];
            [(-q, -q, -q), (q, q, q)]
                .into_iter()
                .map(|(r, s, t)| {
                    let derivatives = signs.map(|sign| {
                        [
                            sign[0] * (1.0 + sign[1] * s) * (1.0 + sign[2] * t) / 8.0,
                            sign[1] * (1.0 + sign[0] * r) * (1.0 + sign[2] * t) / 8.0,
                            sign[2] * (1.0 + sign[0] * r) * (1.0 + sign[1] * s) / 8.0,
                        ]
                    });
                    mapped_jacobian_determinant(coordinates, &derivatives)
                })
                .collect()
        }
    }
}

#[cfg(test)]
mod mesh_validation_tests {
    use super::*;

    fn certified_airbox_mesh() -> MeshIR {
        MeshIR {
            mesh_name: "certified-airbox".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 0.0, 2.0],
            ],
            cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [1, 3, 2, 4]]),
            element_markers: vec![1, 0],
            facets: FemFacetConnectivityIR::from_tri3(vec![
                [0, 1, 2],
                [0, 1, 3],
                [0, 2, 3],
                [1, 2, 4],
                [1, 3, 4],
                [2, 3, 4],
                [1, 2, 3],
            ]),
            boundary_markers: vec![99, 98, 97, 7, 7, 7, 10],
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            per_domain_quality: HashMap::new(),
        }
    }

    #[test]
    fn airbox_roles_are_topology_derived_not_max_marker() {
        let roles = certified_airbox_mesh()
            .certify_airbox_boundary_roles()
            .expect("complete airbox should certify");
        assert!(roles.iter().any(|entry| {
            entry.role == BoundaryRole::GammaOut && entry.marker == 7 && entry.face_count == 3
        }));
    }

    #[test]
    fn airbox_roles_reject_incomplete_outer_boundary() {
        let mut mesh = certified_airbox_mesh();
        let mut faces = mesh.require_tri3_boundary_faces().unwrap();
        faces.remove(5);
        mesh.facets = FemFacetConnectivityIR::from_tri3(faces);
        mesh.boundary_markers.remove(5);
        let errors = mesh
            .certify_airbox_boundary_roles()
            .expect_err("missing outer face must fail certification");
        assert!(errors
            .iter()
            .any(|error| error.contains("Gamma_out is incomplete")));
    }

    #[test]
    fn airbox_roles_reject_marker_shared_with_interface() {
        let mut mesh = certified_airbox_mesh();
        mesh.boundary_markers[6] = 7;
        let errors = mesh
            .certify_airbox_boundary_roles()
            .expect_err("shared Gamma_out/interface marker must fail certification");
        assert!(errors
            .iter()
            .any(|error| error.contains("shared with another boundary role")));
    }

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
            cells: FemConnectivityIR::from_tet4(elements),
            facets: FemFacetConnectivityIR::empty(),
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

    fn mirrored_periodic_mesh() -> MeshIR {
        MeshIR {
            mesh_name: "mirrored-periodic".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
                [1.0, 1.0, 0.0],
                [1.0, 0.0, 1.0],
            ],
            cells: FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3], [3, 5, 4, 0]]),
            element_markers: vec![1, 1],
            facets: FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2], [3, 5, 4]]),
            boundary_markers: vec![10, 11],
            periodic_boundary_pairs: vec![MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 10,
                marker_b: 11,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            }],
            periodic_node_pairs: vec![
                MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 0,
                    node_b: 3,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 1,
                    node_b: 4,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 2,
                    node_b: 5,
                },
            ],
            per_domain_quality: HashMap::new(),
        }
    }

    fn two_axis_periodic_nodes() -> MeshIR {
        MeshIR {
            mesh_name: "two-axis-periodic".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [0.0, 1.0, 1.0],
                [1.0, 0.0, 0.0],
                [1.0, 1.0, 0.0],
                [1.0, 0.0, 1.0],
                [1.0, 1.0, 1.0],
            ],
            cells: FemConnectivityIR::empty(),
            element_markers: Vec::new(),
            facets: FemFacetConnectivityIR::empty(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: vec![
                MeshPeriodicBoundaryPairIR {
                    pair_id: "x_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 10,
                    marker_b: 11,
                    translation: Some([1.0, 0.0, 0.0]),
                    tolerance: Some(1.0e-12),
                    axis_hint: Some("x".to_string()),
                    orientation: None,
                    pairing_policy: None,
                },
                MeshPeriodicBoundaryPairIR {
                    pair_id: "y_faces".to_string(),
                    source_marker: None,
                    destination_marker: None,
                    marker_a: 12,
                    marker_b: 13,
                    translation: Some([0.0, 1.0, 0.0]),
                    tolerance: Some(1.0e-12),
                    axis_hint: Some("y".to_string()),
                    orientation: None,
                    pairing_policy: None,
                },
            ],
            periodic_node_pairs: vec![
                MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 0,
                    node_b: 4,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 1,
                    node_b: 5,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 2,
                    node_b: 6,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "x_faces".to_string(),
                    node_a: 3,
                    node_b: 7,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "y_faces".to_string(),
                    node_a: 0,
                    node_b: 1,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "y_faces".to_string(),
                    node_a: 2,
                    node_b: 3,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "y_faces".to_string(),
                    node_a: 4,
                    node_b: 5,
                },
                MeshPeriodicNodePairIR {
                    pair_id: "y_faces".to_string(),
                    node_a: 6,
                    node_b: 7,
                },
            ],
            per_domain_quality: HashMap::new(),
        }
    }

    fn three_axis_periodic_nodes() -> MeshIR {
        let mut mesh = two_axis_periodic_nodes();
        mesh.periodic_boundary_pairs
            .push(MeshPeriodicBoundaryPairIR {
                pair_id: "z_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 14,
                marker_b: 15,
                translation: Some([0.0, 0.0, 1.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("z".to_string()),
                orientation: None,
                pairing_policy: None,
            });
        mesh.periodic_node_pairs.extend([
            MeshPeriodicNodePairIR {
                pair_id: "z_faces".to_string(),
                node_a: 0,
                node_b: 2,
            },
            MeshPeriodicNodePairIR {
                pair_id: "z_faces".to_string(),
                node_a: 1,
                node_b: 3,
            },
            MeshPeriodicNodePairIR {
                pair_id: "z_faces".to_string(),
                node_a: 4,
                node_b: 6,
            },
            MeshPeriodicNodePairIR {
                pair_id: "z_faces".to_string(),
                node_a: 5,
                node_b: 7,
            },
        ]);
        mesh
    }

    #[test]
    fn periodic_edge_corner_closure_is_order_independent() {
        let mesh = two_axis_periodic_nodes();
        let mut first_errors = Vec::new();
        assert!(audit_edge_corner_closure(&mesh, &mut first_errors).valid);
        assert!(first_errors.is_empty());

        let mut permuted = mesh.clone();
        permuted.periodic_node_pairs.reverse();
        let mut permuted_errors = Vec::new();
        assert!(audit_edge_corner_closure(&permuted, &mut permuted_errors).valid);
        assert_eq!(permuted_errors, first_errors);
    }

    #[test]
    fn periodic_edge_corner_closure_rejects_missing_diagonal_mapping() {
        let mut mesh = two_axis_periodic_nodes();
        mesh.periodic_node_pairs
            .retain(|pair| !(pair.pair_id == "y_faces" && pair.node_a == 4));
        let mut errors = Vec::new();
        assert!(!audit_edge_corner_closure(&mesh, &mut errors).valid);
        assert!(errors
            .iter()
            .any(|error| { error.contains("edge/corner closure is incomplete") }));
    }

    #[test]
    fn periodic_edge_corner_closure_reports_three_axis_corner_classes() {
        let mesh = three_axis_periodic_nodes();
        let mut errors = Vec::new();
        let audit = audit_edge_corner_closure(&mesh, &mut errors);
        assert!(audit.valid, "unexpected closure errors: {errors:?}");
        assert_eq!(audit.edge_class_count, 0);
        assert_eq!(audit.corner_class_count, 8);
        assert_eq!(audit.max_commutation_residual_m, 0.0);
    }

    #[test]
    fn periodic_certificate_v6_accepts_mirrored_faces_and_hashes_topology() {
        let certificate = mirrored_periodic_mesh()
            .periodic_mesh_certificate_v6()
            .expect("mirrored periodic faces should certify");
        assert_eq!(certificate.schema_version, "periodic_mesh_certificate.v6");
        assert_eq!(certificate.axis_pairs.len(), 1);
        assert_eq!(certificate.axis_pairs[0].node_pair_count, 3);
        assert_eq!(certificate.axis_pairs[0].face_pair_count, 1);
        assert_eq!(certificate.edge_class_count, 0);
        assert_eq!(certificate.corner_class_count, 0);
        assert_eq!(certificate.max_commutation_residual_m, 0.0);
        assert!(certificate.boundary_topology_match);
        assert!(certificate.corner_edge_cycle_unique);
        assert!(certificate.topology_fingerprint.starts_with("sha256:"));
        assert!(certificate.marker_map_fingerprint.starts_with("sha256:"));
        assert!(certificate
            .material_realization_fingerprint
            .starts_with("sha256:"));
        assert_eq!(certificate.max_material_residual, 0.0);
    }

    #[test]
    fn periodic_certificate_v6_scopes_fragmented_faces_with_shared_axis_pair_id() {
        let mut mesh = mirrored_periodic_mesh();
        mesh.nodes.extend([
            [0.0, 2.0, 0.0],
            [0.0, 2.0, 1.0],
            [0.0, 3.0, 0.0],
            [1.0, 2.0, 0.0],
            [1.0, 2.0, 1.0],
            [1.0, 3.0, 0.0],
        ]);
        let mut faces = mesh.require_tri3_boundary_faces().unwrap();
        faces.extend([[6, 8, 7], [9, 10, 11]]);
        mesh.facets = FemFacetConnectivityIR::from_tri3(faces);
        mesh.boundary_markers.extend([12, 13]);
        mesh.periodic_boundary_pairs
            .push(MeshPeriodicBoundaryPairIR {
                pair_id: "x_faces".to_string(),
                source_marker: None,
                destination_marker: None,
                marker_a: 12,
                marker_b: 13,
                translation: Some([1.0, 0.0, 0.0]),
                tolerance: Some(1.0e-12),
                axis_hint: Some("x".to_string()),
                orientation: None,
                pairing_policy: None,
            });
        mesh.periodic_node_pairs.extend([
            MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 6,
                node_b: 9,
            },
            MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 7,
                node_b: 10,
            },
            MeshPeriodicNodePairIR {
                pair_id: "x_faces".to_string(),
                node_a: 8,
                node_b: 11,
            },
        ]);

        let certificate = mesh
            .periodic_mesh_certificate_v6()
            .expect("fragmented faces sharing an axis pair id should certify independently");
        assert_eq!(certificate.axis_pairs.len(), 2);
        assert_eq!(certificate.axis_pairs[0].node_pair_count, 3);
        assert_eq!(certificate.axis_pairs[1].node_pair_count, 3);
    }

    #[test]
    fn periodic_region_material_certificate_rejects_dg0_seam_mismatch() {
        let mesh = mirrored_periodic_mesh();
        let errors = mesh
            .periodic_mesh_certificate_v6_with_material_fields(
                Some(&[800_000.0, 801_000.0]),
                Some(&[13.0e-12, 13.0e-12]),
            )
            .expect_err("DG0 Ms mismatch must fail mirrored seam certification");
        assert!(errors
            .iter()
            .any(|error| error.contains("coefficient residual")));
    }

    #[test]
    fn periodic_region_material_certificate_records_realized_dg0_hashes() {
        let mesh = mirrored_periodic_mesh();
        let certificate = mesh
            .periodic_mesh_certificate_v6_with_material_fields(
                Some(&[800_000.0, 800_000.0]),
                Some(&[13.0e-12, 13.0e-12]),
            )
            .expect("equal DG0 material values must certify");
        assert!(certificate
            .material_realization_fingerprint
            .starts_with("sha256:"));
        assert_eq!(certificate.max_material_residual, 0.0);
    }

    #[test]
    fn periodic_region_material_certificate_rejects_nodal_seam_mismatch() {
        let mesh = mirrored_periodic_mesh();
        let errors = mesh
            .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
                None,
                None,
                Some(&[
                    800_000.0, 800_000.0, 800_000.0, 801_000.0, 800_000.0, 800_000.0,
                ]),
                None,
            )
            .expect_err("nodal Ms mismatch must fail mirrored seam certification");
        assert!(errors
            .iter()
            .any(|error| error.contains("coefficient residual")));
    }

    #[test]
    fn periodic_region_material_certificate_records_nodal_material_hashes() {
        let mesh = mirrored_periodic_mesh();
        let certificate = mesh
            .periodic_mesh_certificate_v6_with_material_and_nodal_fields(
                None,
                None,
                Some(&[800_000.0; 6]),
                Some(&[13.0e-12; 6]),
            )
            .expect("equal nodal material values must certify");
        assert!(certificate
            .material_realization_fingerprint
            .starts_with("sha256:"));
        assert_eq!(certificate.max_material_residual, 0.0);
    }

    #[test]
    fn periodic_certificate_binds_authored_region_identity() {
        let mesh = mirrored_periodic_mesh();
        let certificate = mesh
            .periodic_mesh_certificate_v6()
            .expect("structural certificate should certify");
        let first = MeshIR::periodic_certificate_with_region_identity(
            certificate.clone(),
            &serde_json::json!([{"owner": "magnet", "region": "core", "marker": 1}]),
        );
        let second = MeshIR::periodic_certificate_with_region_identity(
            certificate,
            &serde_json::json!([{"owner": "magnet", "region": "shell", "marker": 1}]),
        );
        assert_ne!(first.marker_map_fingerprint, second.marker_map_fingerprint);
        assert_eq!(first.region_class_count, 1);
    }

    #[test]
    fn periodic_certificate_v6_rejects_non_bijective_face_mapping() {
        let mut mesh = mirrored_periodic_mesh();
        mesh.periodic_node_pairs[2].node_b = 4;
        let errors = mesh
            .periodic_mesh_certificate_v6()
            .expect_err("duplicate destination node must fail certificate");
        assert!(errors.iter().any(|error| error.contains("bijection")));
    }

    #[test]
    fn periodic_certificate_v6_rejects_mismatched_face_topology() {
        let mut mesh = mirrored_periodic_mesh();
        let mut faces = mesh.require_tri3_boundary_faces().unwrap();
        faces[1] = [3, 4, 5];
        mesh.facets = FemFacetConnectivityIR::from_tri3(faces);
        let errors = mesh
            .periodic_mesh_certificate_v6()
            .expect_err("wrong destination face orientation/topology must fail");
        assert!(errors
            .iter()
            .any(|error| error.contains("face topology") || error.contains("normal")));
    }

    #[test]
    fn periodic_certificate_v6_rejects_unpaired_boundary_face_node() {
        let mut mesh = mirrored_periodic_mesh();
        let mut faces = mesh.require_tri3_boundary_faces().unwrap();
        faces[0] = [0, 1, 3];
        mesh.facets = FemFacetConnectivityIR::from_tri3(faces);
        let errors = mesh
            .periodic_mesh_certificate_v6()
            .expect_err("every periodic boundary node must be represented by a pair");
        assert!(errors
            .iter()
            .any(|error| { error.contains("does not cover exactly the paired boundary faces") }));
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
