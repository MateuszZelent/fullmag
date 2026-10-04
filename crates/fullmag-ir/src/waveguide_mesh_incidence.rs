//! Combinatorial incidence and local-manifold checks for the raw waveguide mesh.
//!
//! This is not geometric embedding validation, an admission certificate, or a
//! provider-readiness check. Coordinates and loop-kind geometry are deliberately
//! not inspected. Component air-edge counts are descriptive topology only and
//! do not infer boundary conditions or anchoring.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::error::Error;
use std::fmt;

use serde::Serialize;

use crate::waveguide_mesh::{WaveguideCrossSectionMeshIR, WaveguideCrossSectionRegionIR};

type HalfEdgeKey = (usize, u8);

/// Input collection associated with a structured incidence error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaveguideMeshIncidenceCollection {
    Nodes,
    Triangles,
    Regions,
    Edges,
    BoundaryComponents,
}

/// Region or contour identifier field associated with an identifier error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaveguideMeshIncidenceIdentifierField {
    RegionId,
    ObjectId,
    MaterialId,
    BoundaryComponentId,
}

/// Stable category for a malformed combinatorial mesh.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaveguideMeshIncidenceErrorCode {
    EmptyCollection,
    EmptyIdentifier,
    DuplicateIdentifier,
    UnknownRegion,
    IndexDomainTooLarge,
    NodeIndexOutOfBounds,
    TriangleIndexOutOfBounds,
    InvalidLocalEdgeIndex,
    RepeatedTriangleNode,
    DuplicateTriangle,
    OrphanNode,
    OrphanRegion,
    NonManifoldEdge,
    NonCanonicalEdge,
    DuplicateEdge,
    OrphanEdge,
    InvalidEdgeIncidenceCount,
    DuplicateHalfEdgeIncidence,
    IncidenceEndpointMismatch,
    RepeatedTriangleOwner,
    SameDirectionIncidences,
    MissingEdge,
    MissingHalfEdgeIncidence,
    MissingContourCoverage,
    UnexpectedBoundaryHalfEdge,
    BoundaryOwnerMismatch,
    ContourTooShort,
    DuplicateContourHalfEdge,
    ContourNotClosed,
    ContourRepeatedNode,
    SameRegionContoursTouch,
    DisconnectedVertexFan,
    InvalidVertexBoundaryDegree,
}

/// Structured failure returned by the incidence validator.
///
/// item_index and nested_index are zero-based indices in the collection named
/// by collection; they are absent when the failure is collection-wide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WaveguideMeshIncidenceError {
    code: WaveguideMeshIncidenceErrorCode,
    collection: Option<WaveguideMeshIncidenceCollection>,
    item_index: Option<usize>,
    nested_index: Option<usize>,
    identifier_field: Option<WaveguideMeshIncidenceIdentifierField>,
}

impl WaveguideMeshIncidenceError {
    const fn new(
        code: WaveguideMeshIncidenceErrorCode,
        collection: Option<WaveguideMeshIncidenceCollection>,
        item_index: Option<usize>,
        nested_index: Option<usize>,
        identifier_field: Option<WaveguideMeshIncidenceIdentifierField>,
    ) -> Self {
        Self {
            code,
            collection,
            item_index,
            nested_index,
            identifier_field,
        }
    }

    /// Return the stable category for this failure.
    pub const fn code(&self) -> WaveguideMeshIncidenceErrorCode {
        self.code
    }

    /// Return the input collection related to this failure, if applicable.
    pub const fn collection(&self) -> Option<WaveguideMeshIncidenceCollection> {
        self.collection
    }

    /// Return the zero-based collection item index, if applicable.
    pub const fn item_index(&self) -> Option<usize> {
        self.item_index
    }

    /// Return the nested item index, if applicable.
    pub const fn nested_index(&self) -> Option<usize> {
        self.nested_index
    }

    /// Return the identifier field related to an identifier failure.
    pub const fn identifier_field(&self) -> Option<WaveguideMeshIncidenceIdentifierField> {
        self.identifier_field
    }
}

impl fmt::Display for WaveguideMeshIncidenceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "waveguide mesh incidence {:?} in {:?} at {:?} ({:?})",
            self.code, self.collection, self.item_index, self.nested_index
        )
    }
}

impl Error for WaveguideMeshIncidenceError {}

/// Topological summary produced only after the incidence checks pass.
///
/// Component order is deterministic: components are ordered by their lowest
/// triangle index. Counts describe one-owner exterior edges whose owning region
/// is tagged air; they do not imply a boundary condition or anchoring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WaveguideMeshIncidenceReport {
    scalar_mesh_component_count: usize,
    external_air_edge_counts_by_component: Vec<usize>,
}

impl WaveguideMeshIncidenceReport {
    /// Return the number of connected components of the whole scalar mesh.
    pub const fn scalar_mesh_component_count(&self) -> usize {
        self.scalar_mesh_component_count
    }

    /// Return one external-air-edge count per component in deterministic order.
    pub fn external_air_edge_counts_by_component(&self) -> &[usize] {
        &self.external_air_edge_counts_by_component
    }
}

#[derive(Debug, Clone, Copy)]
struct DirectedHalfEdge {
    triangle_index: usize,
    local_edge_index: u8,
    start_node: u64,
    end_node: u64,
}

/// Validate edge incidence, regional contours, and local vertex manifold
/// structure for a raw typed waveguide mesh.
///
/// The check uses combinatorial node IDs only. It does not inspect coordinate
/// values, intersections, loop-kind orientation or nesting, registry bindings,
/// frame invariance, material existence, structural fields, boundary conditions,
/// equilibrium, or provider availability.
pub fn validate_waveguide_mesh_incidence(
    mesh: &WaveguideCrossSectionMeshIR,
) -> Result<WaveguideMeshIncidenceReport, WaveguideMeshIncidenceError> {
    require_nonempty(
        mesh.nodes_uv_m.len(),
        WaveguideMeshIncidenceCollection::Nodes,
    )?;
    require_nonempty(
        mesh.triangles.len(),
        WaveguideMeshIncidenceCollection::Triangles,
    )?;
    require_nonempty(
        mesh.regions.len(),
        WaveguideMeshIncidenceCollection::Regions,
    )?;
    require_nonempty(mesh.edges.len(), WaveguideMeshIncidenceCollection::Edges)?;
    require_nonempty(
        mesh.boundary_components.len(),
        WaveguideMeshIncidenceCollection::BoundaryComponents,
    )?;

    let node_count_u64 = u64::try_from(mesh.nodes_uv_m.len()).map_err(|_| {
        incidence_error(
            WaveguideMeshIncidenceErrorCode::IndexDomainTooLarge,
            Some(WaveguideMeshIncidenceCollection::Nodes),
            None,
            None,
        )
    })?;
    let triangle_count_u64 = u64::try_from(mesh.triangles.len()).map_err(|_| {
        incidence_error(
            WaveguideMeshIncidenceErrorCode::IndexDomainTooLarge,
            Some(WaveguideMeshIncidenceCollection::Triangles),
            None,
            None,
        )
    })?;

    let mut region_index_by_id = HashMap::<&str, usize>::new();
    let mut region_is_air = Vec::with_capacity(mesh.regions.len());
    for (region_index, region) in mesh.regions.iter().enumerate() {
        let (region_id, object_id, material_id, is_air) = region_details(region);
        require_identifier(
            region_id,
            WaveguideMeshIncidenceCollection::Regions,
            region_index,
            WaveguideMeshIncidenceIdentifierField::RegionId,
        )?;
        require_identifier(
            object_id,
            WaveguideMeshIncidenceCollection::Regions,
            region_index,
            WaveguideMeshIncidenceIdentifierField::ObjectId,
        )?;
        if let Some(material_id) = material_id {
            require_identifier(
                material_id,
                WaveguideMeshIncidenceCollection::Regions,
                region_index,
                WaveguideMeshIncidenceIdentifierField::MaterialId,
            )?;
        }
        if region_index_by_id.insert(region_id, region_index).is_some() {
            return Err(incidence_error_with_field(
                WaveguideMeshIncidenceErrorCode::DuplicateIdentifier,
                WaveguideMeshIncidenceCollection::Regions,
                region_index,
                None,
                WaveguideMeshIncidenceIdentifierField::RegionId,
            ));
        }
        region_is_air.push(is_air);
    }

    let mut used_regions = vec![false; mesh.regions.len()];
    let mut node_to_triangles = vec![Vec::<usize>::new(); mesh.nodes_uv_m.len()];
    let mut derived_edges = BTreeMap::<[u64; 2], Vec<DirectedHalfEdge>>::new();
    let mut triangle_regions = Vec::with_capacity(mesh.triangles.len());
    let mut unique_cells = BTreeSet::<[u64; 3]>::new();

    for (triangle_index, triangle) in mesh.triangles.iter().enumerate() {
        let Some(&region_index) = region_index_by_id.get(triangle.region_id.as_str()) else {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::UnknownRegion,
                Some(WaveguideMeshIncidenceCollection::Triangles),
                Some(triangle_index),
                None,
            ));
        };
        used_regions[region_index] = true;
        triangle_regions.push(region_index);

        let mut checked_nodes = [0usize; 3];
        for (local_node_index, node_index) in triangle.nodes.iter().copied().enumerate() {
            checked_nodes[local_node_index] = checked_node_index(
                node_index,
                node_count_u64,
                WaveguideMeshIncidenceCollection::Triangles,
                triangle_index,
                local_node_index,
            )?;
        }
        if checked_nodes[0] == checked_nodes[1]
            || checked_nodes[1] == checked_nodes[2]
            || checked_nodes[2] == checked_nodes[0]
        {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::RepeatedTriangleNode,
                Some(WaveguideMeshIncidenceCollection::Triangles),
                Some(triangle_index),
                None,
            ));
        }

        let mut cell_key = triangle.nodes;
        cell_key.sort_unstable();
        if !unique_cells.insert(cell_key) {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::DuplicateTriangle,
                Some(WaveguideMeshIncidenceCollection::Triangles),
                Some(triangle_index),
                None,
            ));
        }

        for node_index in checked_nodes {
            node_to_triangles[node_index].push(triangle_index);
        }
        for local_edge_index in 0_u8..=2 {
            let (start_node, end_node) =
                directed_side(triangle.nodes, local_edge_index).expect("closed local side range");
            derived_edges
                .entry(canonical_pair(start_node, end_node))
                .or_default()
                .push(DirectedHalfEdge {
                    triangle_index,
                    local_edge_index,
                    start_node,
                    end_node,
                });
        }
    }

    if let Some(node_index) = node_to_triangles.iter().position(|items| items.is_empty()) {
        return Err(incidence_error(
            WaveguideMeshIncidenceErrorCode::OrphanNode,
            Some(WaveguideMeshIncidenceCollection::Nodes),
            Some(node_index),
            None,
        ));
    }
    if let Some(region_index) = used_regions.iter().position(|is_used| !is_used) {
        return Err(incidence_error(
            WaveguideMeshIncidenceErrorCode::OrphanRegion,
            Some(WaveguideMeshIncidenceCollection::Regions),
            Some(region_index),
            None,
        ));
    }

    for owners in derived_edges.values() {
        if owners.len() > 2 {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::NonManifoldEdge,
                Some(WaveguideMeshIncidenceCollection::Triangles),
                owners.first().map(|owner| owner.triangle_index),
                Some(owners.len()),
            ));
        }
    }

    let mut declared_edge_keys = BTreeSet::<[u64; 2]>::new();
    let mut seen_triangle_sides = vec![[false; 3]; mesh.triangles.len()];
    let mut expected_boundary_sides = BTreeSet::<HalfEdgeKey>::new();
    let mut triangle_side_neighbors = vec![[None; 3]; mesh.triangles.len()];
    let mut triangle_neighbors = vec![Vec::<usize>::new(); mesh.triangles.len()];
    let mut exterior_edge_count_by_node = vec![0usize; mesh.nodes_uv_m.len()];
    let mut external_air_edge_owners = Vec::<usize>::new();

    for (edge_index, edge) in mesh.edges.iter().enumerate() {
        if edge.nodes[0] >= edge.nodes[1] {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::NonCanonicalEdge,
                Some(WaveguideMeshIncidenceCollection::Edges),
                Some(edge_index),
                None,
            ));
        }
        let node0 = checked_node_index(
            edge.nodes[0],
            node_count_u64,
            WaveguideMeshIncidenceCollection::Edges,
            edge_index,
            0,
        )?;
        let node1 = checked_node_index(
            edge.nodes[1],
            node_count_u64,
            WaveguideMeshIncidenceCollection::Edges,
            edge_index,
            1,
        )?;
        if !declared_edge_keys.insert(edge.nodes) {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::DuplicateEdge,
                Some(WaveguideMeshIncidenceCollection::Edges),
                Some(edge_index),
                None,
            ));
        }

        let Some(expected_owners) = derived_edges.get(&edge.nodes) else {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::OrphanEdge,
                Some(WaveguideMeshIncidenceCollection::Edges),
                Some(edge_index),
                None,
            ));
        };
        if !(1..=2).contains(&edge.incidences.len()) {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::InvalidEdgeIncidenceCount,
                Some(WaveguideMeshIncidenceCollection::Edges),
                Some(edge_index),
                None,
            ));
        }

        let mut owners = Vec::<DirectedHalfEdge>::with_capacity(edge.incidences.len());
        for (incidence_index, incidence) in edge.incidences.iter().enumerate() {
            let triangle_index = checked_triangle_index(
                incidence.triangle_index,
                triangle_count_u64,
                WaveguideMeshIncidenceCollection::Edges,
                edge_index,
                incidence_index,
            )?;
            let local_edge_index = incidence.local_edge_index.as_u8();
            if local_edge_index > 2 {
                return Err(incidence_error(
                    WaveguideMeshIncidenceErrorCode::InvalidLocalEdgeIndex,
                    Some(WaveguideMeshIncidenceCollection::Edges),
                    Some(edge_index),
                    Some(incidence_index),
                ));
            }
            let local_edge_slot = usize::from(local_edge_index);
            let triangle = &mesh.triangles[triangle_index];
            let (start_node, end_node) =
                directed_side(triangle.nodes, local_edge_index).expect("checked local side");
            if canonical_pair(start_node, end_node) != edge.nodes
                || !expected_owners.iter().any(|expected| {
                    expected.triangle_index == triangle_index
                        && expected.local_edge_index == local_edge_index
                })
            {
                return Err(incidence_error(
                    WaveguideMeshIncidenceErrorCode::IncidenceEndpointMismatch,
                    Some(WaveguideMeshIncidenceCollection::Edges),
                    Some(edge_index),
                    Some(incidence_index),
                ));
            }
            if seen_triangle_sides[triangle_index][local_edge_slot] {
                return Err(incidence_error(
                    WaveguideMeshIncidenceErrorCode::DuplicateHalfEdgeIncidence,
                    Some(WaveguideMeshIncidenceCollection::Edges),
                    Some(edge_index),
                    Some(incidence_index),
                ));
            }
            seen_triangle_sides[triangle_index][local_edge_slot] = true;
            owners.push(DirectedHalfEdge {
                triangle_index,
                local_edge_index,
                start_node,
                end_node,
            });
        }

        if owners.len() < expected_owners.len() {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::MissingHalfEdgeIncidence,
                Some(WaveguideMeshIncidenceCollection::Edges),
                Some(edge_index),
                None,
            ));
        }
        if owners.len() != expected_owners.len() {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::IncidenceEndpointMismatch,
                Some(WaveguideMeshIncidenceCollection::Edges),
                Some(edge_index),
                None,
            ));
        }
        if owners.len() == 2 {
            if owners[0].triangle_index == owners[1].triangle_index {
                return Err(incidence_error(
                    WaveguideMeshIncidenceErrorCode::RepeatedTriangleOwner,
                    Some(WaveguideMeshIncidenceCollection::Edges),
                    Some(edge_index),
                    None,
                ));
            }
            if owners[0].start_node != owners[1].end_node
                || owners[0].end_node != owners[1].start_node
            {
                return Err(incidence_error(
                    WaveguideMeshIncidenceErrorCode::SameDirectionIncidences,
                    Some(WaveguideMeshIncidenceCollection::Edges),
                    Some(edge_index),
                    None,
                ));
            }

            let first = owners[0];
            let second = owners[1];
            triangle_side_neighbors[first.triangle_index][usize::from(first.local_edge_index)] =
                Some(second.triangle_index);
            triangle_side_neighbors[second.triangle_index][usize::from(second.local_edge_index)] =
                Some(first.triangle_index);
            triangle_neighbors[first.triangle_index].push(second.triangle_index);
            triangle_neighbors[second.triangle_index].push(first.triangle_index);

            if mesh.triangles[first.triangle_index].region_id
                != mesh.triangles[second.triangle_index].region_id
            {
                expected_boundary_sides.insert((first.triangle_index, first.local_edge_index));
                expected_boundary_sides.insert((second.triangle_index, second.local_edge_index));
            }
        } else {
            let owner = owners[0];
            expected_boundary_sides.insert((owner.triangle_index, owner.local_edge_index));
            exterior_edge_count_by_node[node0] += 1;
            exterior_edge_count_by_node[node1] += 1;
            if region_is_air[triangle_regions[owner.triangle_index]] {
                external_air_edge_owners.push(owner.triangle_index);
            }
        }
    }

    for (edge_nodes, owners) in &derived_edges {
        if !declared_edge_keys.contains(edge_nodes) {
            let owner = owners.first().expect("derived edges have a triangle side");
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::MissingEdge,
                Some(WaveguideMeshIncidenceCollection::Triangles),
                Some(owner.triangle_index),
                Some(usize::from(owner.local_edge_index)),
            ));
        }
    }
    for (triangle_index, sides) in seen_triangle_sides.iter().enumerate() {
        if let Some(local_edge_index) = sides.iter().position(|was_seen| !was_seen) {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::MissingHalfEdgeIncidence,
                Some(WaveguideMeshIncidenceCollection::Triangles),
                Some(triangle_index),
                Some(local_edge_index),
            ));
        }
    }

    validate_boundary_components(mesh, &region_index_by_id, &expected_boundary_sides)?;
    validate_vertex_stars(
        mesh,
        &node_to_triangles,
        &triangle_side_neighbors,
        &exterior_edge_count_by_node,
    )?;

    let (scalar_mesh_component_count, external_air_edge_counts_by_component) =
        summarize_scalar_components(&triangle_neighbors, &external_air_edge_owners);

    Ok(WaveguideMeshIncidenceReport {
        scalar_mesh_component_count,
        external_air_edge_counts_by_component,
    })
}

fn require_nonempty(
    length: usize,
    collection: WaveguideMeshIncidenceCollection,
) -> Result<(), WaveguideMeshIncidenceError> {
    if length == 0 {
        return Err(incidence_error(
            WaveguideMeshIncidenceErrorCode::EmptyCollection,
            Some(collection),
            None,
            None,
        ));
    }
    Ok(())
}

fn require_identifier(
    value: &str,
    collection: WaveguideMeshIncidenceCollection,
    item_index: usize,
    field: WaveguideMeshIncidenceIdentifierField,
) -> Result<(), WaveguideMeshIncidenceError> {
    if value.is_empty() {
        return Err(incidence_error_with_field(
            WaveguideMeshIncidenceErrorCode::EmptyIdentifier,
            collection,
            item_index,
            None,
            field,
        ));
    }
    Ok(())
}

fn region_details(region: &WaveguideCrossSectionRegionIR) -> (&str, &str, Option<&str>, bool) {
    match region {
        WaveguideCrossSectionRegionIR::Magnetic {
            region_id,
            object_id,
            material_id,
        } => (region_id, object_id, Some(material_id), false),
        WaveguideCrossSectionRegionIR::Air {
            region_id,
            object_id,
        } => (region_id, object_id, None, true),
    }
}

fn checked_node_index(
    node_index: u64,
    node_count_u64: u64,
    collection: WaveguideMeshIncidenceCollection,
    item_index: usize,
    nested_index: usize,
) -> Result<usize, WaveguideMeshIncidenceError> {
    if node_index >= node_count_u64 {
        return Err(incidence_error(
            WaveguideMeshIncidenceErrorCode::NodeIndexOutOfBounds,
            Some(collection),
            Some(item_index),
            Some(nested_index),
        ));
    }
    usize::try_from(node_index).map_err(|_| {
        incidence_error(
            WaveguideMeshIncidenceErrorCode::NodeIndexOutOfBounds,
            Some(collection),
            Some(item_index),
            Some(nested_index),
        )
    })
}

fn checked_triangle_index(
    triangle_index: u64,
    triangle_count_u64: u64,
    collection: WaveguideMeshIncidenceCollection,
    item_index: usize,
    nested_index: usize,
) -> Result<usize, WaveguideMeshIncidenceError> {
    if triangle_index >= triangle_count_u64 {
        return Err(incidence_error(
            WaveguideMeshIncidenceErrorCode::TriangleIndexOutOfBounds,
            Some(collection),
            Some(item_index),
            Some(nested_index),
        ));
    }
    usize::try_from(triangle_index).map_err(|_| {
        incidence_error(
            WaveguideMeshIncidenceErrorCode::TriangleIndexOutOfBounds,
            Some(collection),
            Some(item_index),
            Some(nested_index),
        )
    })
}

fn directed_side(nodes: [u64; 3], local_edge_index: u8) -> Option<(u64, u64)> {
    match local_edge_index {
        0 => Some((nodes[0], nodes[1])),
        1 => Some((nodes[1], nodes[2])),
        2 => Some((nodes[2], nodes[0])),
        _ => None,
    }
}

fn canonical_pair(first: u64, second: u64) -> [u64; 2] {
    if first < second {
        [first, second]
    } else {
        [second, first]
    }
}

fn incidence_error(
    code: WaveguideMeshIncidenceErrorCode,
    collection: Option<WaveguideMeshIncidenceCollection>,
    item_index: Option<usize>,
    nested_index: Option<usize>,
) -> WaveguideMeshIncidenceError {
    WaveguideMeshIncidenceError::new(code, collection, item_index, nested_index, None)
}

fn incidence_error_with_field(
    code: WaveguideMeshIncidenceErrorCode,
    collection: WaveguideMeshIncidenceCollection,
    item_index: usize,
    nested_index: Option<usize>,
    identifier_field: WaveguideMeshIncidenceIdentifierField,
) -> WaveguideMeshIncidenceError {
    WaveguideMeshIncidenceError::new(
        code,
        Some(collection),
        Some(item_index),
        nested_index,
        Some(identifier_field),
    )
}

fn validate_boundary_components(
    mesh: &WaveguideCrossSectionMeshIR,
    region_index_by_id: &HashMap<&str, usize>,
    expected_boundary_sides: &BTreeSet<HalfEdgeKey>,
) -> Result<(), WaveguideMeshIncidenceError> {
    let mut boundary_ids = HashSet::<&str>::new();
    let mut covered_boundary_sides = BTreeSet::<HalfEdgeKey>::new();
    let mut nodes_by_region = HashMap::<&str, HashSet<u64>>::new();
    let triangle_count_u64 = u64::try_from(mesh.triangles.len()).map_err(|_| {
        incidence_error(
            WaveguideMeshIncidenceErrorCode::IndexDomainTooLarge,
            Some(WaveguideMeshIncidenceCollection::Triangles),
            None,
            None,
        )
    })?;

    for (component_index, component) in mesh.boundary_components.iter().enumerate() {
        require_identifier(
            &component.boundary_component_id,
            WaveguideMeshIncidenceCollection::BoundaryComponents,
            component_index,
            WaveguideMeshIncidenceIdentifierField::BoundaryComponentId,
        )?;
        if !boundary_ids.insert(component.boundary_component_id.as_str()) {
            return Err(incidence_error_with_field(
                WaveguideMeshIncidenceErrorCode::DuplicateIdentifier,
                WaveguideMeshIncidenceCollection::BoundaryComponents,
                component_index,
                None,
                WaveguideMeshIncidenceIdentifierField::BoundaryComponentId,
            ));
        }
        require_identifier(
            &component.region_id,
            WaveguideMeshIncidenceCollection::BoundaryComponents,
            component_index,
            WaveguideMeshIncidenceIdentifierField::RegionId,
        )?;
        if !region_index_by_id.contains_key(component.region_id.as_str()) {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::UnknownRegion,
                Some(WaveguideMeshIncidenceCollection::BoundaryComponents),
                Some(component_index),
                None,
            ));
        }
        if component.half_edges.len() < 3 {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::ContourTooShort,
                Some(WaveguideMeshIncidenceCollection::BoundaryComponents),
                Some(component_index),
                None,
            ));
        }

        // loop_kind is intentionally ignored: outer/hole orientation and nesting
        // require geometric checks owned by a separate validator.
        let mut contour_start_nodes = HashSet::<u64>::new();
        let mut first_start_node = None;
        let mut previous_end_node = None;
        for (half_edge_index, half_edge) in component.half_edges.iter().enumerate() {
            let triangle_index = checked_triangle_index(
                half_edge.triangle_index,
                triangle_count_u64,
                WaveguideMeshIncidenceCollection::BoundaryComponents,
                component_index,
                half_edge_index,
            )?;
            let local_edge_index = half_edge.local_edge_index.as_u8();
            if local_edge_index > 2 {
                return Err(incidence_error(
                    WaveguideMeshIncidenceErrorCode::InvalidLocalEdgeIndex,
                    Some(WaveguideMeshIncidenceCollection::BoundaryComponents),
                    Some(component_index),
                    Some(half_edge_index),
                ));
            }
            let side_key = (triangle_index, local_edge_index);
            if !expected_boundary_sides.contains(&side_key) {
                return Err(incidence_error(
                    WaveguideMeshIncidenceErrorCode::UnexpectedBoundaryHalfEdge,
                    Some(WaveguideMeshIncidenceCollection::BoundaryComponents),
                    Some(component_index),
                    Some(half_edge_index),
                ));
            }
            if !covered_boundary_sides.insert(side_key) {
                return Err(incidence_error(
                    WaveguideMeshIncidenceErrorCode::DuplicateContourHalfEdge,
                    Some(WaveguideMeshIncidenceCollection::BoundaryComponents),
                    Some(component_index),
                    Some(half_edge_index),
                ));
            }
            if mesh.triangles[triangle_index].region_id != component.region_id {
                return Err(incidence_error(
                    WaveguideMeshIncidenceErrorCode::BoundaryOwnerMismatch,
                    Some(WaveguideMeshIncidenceCollection::BoundaryComponents),
                    Some(component_index),
                    Some(half_edge_index),
                ));
            }

            let (start_node, end_node) =
                directed_side(mesh.triangles[triangle_index].nodes, local_edge_index)
                    .expect("checked local side");
            if let Some(previous_end_node) = previous_end_node {
                if previous_end_node != start_node {
                    return Err(incidence_error(
                        WaveguideMeshIncidenceErrorCode::ContourNotClosed,
                        Some(WaveguideMeshIncidenceCollection::BoundaryComponents),
                        Some(component_index),
                        Some(half_edge_index),
                    ));
                }
            } else {
                first_start_node = Some(start_node);
            }
            if !contour_start_nodes.insert(start_node) {
                return Err(incidence_error(
                    WaveguideMeshIncidenceErrorCode::ContourRepeatedNode,
                    Some(WaveguideMeshIncidenceCollection::BoundaryComponents),
                    Some(component_index),
                    Some(half_edge_index),
                ));
            }
            previous_end_node = Some(end_node);
        }

        if previous_end_node != first_start_node {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::ContourNotClosed,
                Some(WaveguideMeshIncidenceCollection::BoundaryComponents),
                Some(component_index),
                None,
            ));
        }

        let region_nodes = nodes_by_region
            .entry(component.region_id.as_str())
            .or_default();
        if contour_start_nodes
            .iter()
            .any(|node_index| region_nodes.contains(node_index))
        {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::SameRegionContoursTouch,
                Some(WaveguideMeshIncidenceCollection::BoundaryComponents),
                Some(component_index),
                None,
            ));
        }
        region_nodes.extend(contour_start_nodes);
    }

    for (triangle_index, local_edge_index) in expected_boundary_sides {
        if !covered_boundary_sides.contains(&(*triangle_index, *local_edge_index)) {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::MissingContourCoverage,
                Some(WaveguideMeshIncidenceCollection::Triangles),
                Some(*triangle_index),
                Some(usize::from(*local_edge_index)),
            ));
        }
    }
    Ok(())
}

fn validate_vertex_stars(
    mesh: &WaveguideCrossSectionMeshIR,
    node_to_triangles: &[Vec<usize>],
    triangle_side_neighbors: &[[Option<usize>; 3]],
    exterior_edge_count_by_node: &[usize],
) -> Result<(), WaveguideMeshIncidenceError> {
    let mut visited_at_node = vec![usize::MAX; mesh.triangles.len()];
    let mut stack = Vec::<usize>::new();

    for (node_index, incident_triangles) in node_to_triangles.iter().enumerate() {
        let node_id = u64::try_from(node_index).map_err(|_| {
            incidence_error(
                WaveguideMeshIncidenceErrorCode::IndexDomainTooLarge,
                Some(WaveguideMeshIncidenceCollection::Nodes),
                Some(node_index),
                None,
            )
        })?;
        let first_triangle = *incident_triangles
            .first()
            .expect("orphan nodes were rejected before vertex-star validation");
        stack.clear();
        stack.push(first_triangle);
        visited_at_node[first_triangle] = node_index;
        let mut visited_count = 0usize;

        while let Some(triangle_index) = stack.pop() {
            visited_count += 1;
            let triangle_nodes = mesh.triangles[triangle_index].nodes;
            let local_vertex_index = triangle_nodes
                .iter()
                .position(|candidate| *candidate == node_id)
                .expect("node-to-triangle incidence is built from these triangle nodes");
            let incident_sides = match local_vertex_index {
                0 => [0, 2],
                1 => [0, 1],
                _ => [1, 2],
            };
            for side in incident_sides {
                if let Some(neighbor) = triangle_side_neighbors[triangle_index][side] {
                    if visited_at_node[neighbor] != node_index {
                        visited_at_node[neighbor] = node_index;
                        stack.push(neighbor);
                    }
                }
            }
        }

        if visited_count != incident_triangles.len() {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::DisconnectedVertexFan,
                Some(WaveguideMeshIncidenceCollection::Nodes),
                Some(node_index),
                None,
            ));
        }
        if !matches!(exterior_edge_count_by_node[node_index], 0 | 2) {
            return Err(incidence_error(
                WaveguideMeshIncidenceErrorCode::InvalidVertexBoundaryDegree,
                Some(WaveguideMeshIncidenceCollection::Nodes),
                Some(node_index),
                Some(exterior_edge_count_by_node[node_index]),
            ));
        }
    }

    Ok(())
}

fn summarize_scalar_components(
    triangle_neighbors: &[Vec<usize>],
    external_air_edge_owners: &[usize],
) -> (usize, Vec<usize>) {
    let mut component_by_triangle = vec![usize::MAX; triangle_neighbors.len()];
    let mut component_count = 0usize;
    let mut stack = Vec::<usize>::new();

    for root in 0..triangle_neighbors.len() {
        if component_by_triangle[root] != usize::MAX {
            continue;
        }
        stack.clear();
        stack.push(root);
        component_by_triangle[root] = component_count;
        while let Some(triangle_index) = stack.pop() {
            for neighbor in &triangle_neighbors[triangle_index] {
                if component_by_triangle[*neighbor] == usize::MAX {
                    component_by_triangle[*neighbor] = component_count;
                    stack.push(*neighbor);
                }
            }
        }
        component_count += 1;
    }

    let mut external_air_edge_counts = vec![0usize; component_count];
    for triangle_index in external_air_edge_owners {
        external_air_edge_counts[component_by_triangle[*triangle_index]] += 1;
    }
    (component_count, external_air_edge_counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const FIXTURE: &str = include_str!("../tests/fixtures/waveguide_cross_section_mesh.v1.json");

    fn fixture_value() -> Value {
        serde_json::from_str(FIXTURE).expect("shared raw mesh fixture must be valid JSON")
    }

    fn fixture_mesh() -> WaveguideCrossSectionMeshIR {
        serde_json::from_str(FIXTURE).expect("shared raw mesh fixture must deserialize")
    }

    fn assert_error(value: Value, expected: WaveguideMeshIncidenceErrorCode) {
        let mesh: WaveguideCrossSectionMeshIR =
            serde_json::from_value(value).expect("mutation must preserve the raw wire shape");
        let error = validate_waveguide_mesh_incidence(&mesh)
            .expect_err("mutated incidence graph must be rejected");
        assert_eq!(error.code(), expected);
    }

    fn half_edge(triangle_index: u64, local_edge_index: u8) -> Value {
        json!({
            "triangle_index": triangle_index,
            "local_edge_index": local_edge_index
        })
    }

    fn point_contact_fixture(same_region: bool, merged_contour: bool) -> Value {
        let triangles = if same_region {
            json!([
                {"nodes": [0, 1, 2], "region_id": "region-a"},
                {"nodes": [0, 3, 4], "region_id": "region-a"}
            ])
        } else {
            json!([
                {"nodes": [0, 1, 2], "region_id": "region-a"},
                {"nodes": [0, 3, 4], "region_id": "region-b"}
            ])
        };
        let regions = if same_region {
            json!([{"kind": "air", "region_id": "region-a", "object_id": "object-a"}])
        } else {
            json!([
                {"kind": "air", "region_id": "region-a", "object_id": "object-a"},
                {
                    "kind": "magnetic",
                    "region_id": "region-b",
                    "object_id": "object-b",
                    "material_id": "material-b"
                }
            ])
        };
        let boundary_components = if merged_contour {
            json!([{
                "boundary_component_id": "boundary-a",
                "region_id": "region-a",
                "loop_kind": "outer",
                "half_edges": [
                    {"triangle_index": 0, "local_edge_index": 0},
                    {"triangle_index": 0, "local_edge_index": 1},
                    {"triangle_index": 0, "local_edge_index": 2},
                    {"triangle_index": 1, "local_edge_index": 0},
                    {"triangle_index": 1, "local_edge_index": 1},
                    {"triangle_index": 1, "local_edge_index": 2}
                ]
            }])
        } else if same_region {
            json!([
                {
                    "boundary_component_id": "boundary-a",
                    "region_id": "region-a",
                    "loop_kind": "outer",
                    "half_edges": [
                        {"triangle_index": 0, "local_edge_index": 0},
                        {"triangle_index": 0, "local_edge_index": 1},
                        {"triangle_index": 0, "local_edge_index": 2}
                    ]
                },
                {
                    "boundary_component_id": "boundary-b",
                    "region_id": "region-a",
                    "loop_kind": "outer",
                    "half_edges": [
                        {"triangle_index": 1, "local_edge_index": 0},
                        {"triangle_index": 1, "local_edge_index": 1},
                        {"triangle_index": 1, "local_edge_index": 2}
                    ]
                }
            ])
        } else {
            json!([
                {
                    "boundary_component_id": "boundary-a",
                    "region_id": "region-a",
                    "loop_kind": "outer",
                    "half_edges": [
                        {"triangle_index": 0, "local_edge_index": 0},
                        {"triangle_index": 0, "local_edge_index": 1},
                        {"triangle_index": 0, "local_edge_index": 2}
                    ]
                },
                {
                    "boundary_component_id": "boundary-b",
                    "region_id": "region-b",
                    "loop_kind": "outer",
                    "half_edges": [
                        {"triangle_index": 1, "local_edge_index": 0},
                        {"triangle_index": 1, "local_edge_index": 1},
                        {"triangle_index": 1, "local_edge_index": 2}
                    ]
                }
            ])
        };

        json!({
            "schema": "fullmag.waveguide-cross-section-mesh.v1",
            "nodes_uv_m": [
                [0.0, 0.0],
                [1.0, 0.0],
                [0.0, 1.0],
                [-1.0, 0.0],
                [0.0, -1.0]
            ],
            "triangles": triangles,
            "edges": [
                {"nodes": [0, 1], "incidences": [half_edge(0, 0)]},
                {"nodes": [1, 2], "incidences": [half_edge(0, 1)]},
                {"nodes": [0, 2], "incidences": [half_edge(0, 2)]},
                {"nodes": [0, 3], "incidences": [half_edge(1, 0)]},
                {"nodes": [3, 4], "incidences": [half_edge(1, 1)]},
                {"nodes": [0, 4], "incidences": [half_edge(1, 2)]}
            ],
            "regions": regions,
            "boundary_components": boundary_components
        })
    }

    #[test]
    fn shared_fixture_reports_whole_scalar_mesh_and_external_air_edges() {
        let mesh = fixture_mesh();
        let report = validate_waveguide_mesh_incidence(&mesh)
            .expect("shared magnetic-in-air fixture has closed incidence");

        assert_eq!(report.scalar_mesh_component_count(), 1);
        assert_eq!(report.external_air_edge_counts_by_component(), &[12]);
    }

    #[test]
    fn closed_air_island_inside_magnetic_region_passes_without_outer_air_edges() {
        let mut value = fixture_value();
        for region in value["regions"]
            .as_array_mut()
            .expect("fixture regions array")
        {
            if region["kind"].as_str() == Some("magnetic") {
                region["kind"] = json!("air");
                region
                    .as_object_mut()
                    .expect("region object")
                    .remove("material_id");
            } else {
                region["kind"] = json!("magnetic");
                region["material_id"] = json!("material-former-air");
            }
        }
        let mesh: WaveguideCrossSectionMeshIR =
            serde_json::from_value(value).expect("relabelled regions preserve raw shape");
        let report = validate_waveguide_mesh_incidence(&mesh)
            .expect("a closed air island is valid combinatorial topology");

        assert_eq!(report.scalar_mesh_component_count(), 1);
        assert_eq!(report.external_air_edge_counts_by_component(), &[0]);
    }

    #[test]
    fn missing_edges_half_edges_and_duplicate_edges_are_rejected() {
        let mut missing_edge = fixture_value();
        missing_edge["edges"].as_array_mut().unwrap().remove(0);
        assert_error(missing_edge, WaveguideMeshIncidenceErrorCode::MissingEdge);

        let mesh = fixture_mesh();
        let shared_edge_index = mesh
            .edges
            .iter()
            .position(|edge| edge.incidences.len() == 2)
            .expect("fixture has a shared edge");
        let mut missing_half_edge = fixture_value();
        missing_half_edge["edges"][shared_edge_index]["incidences"]
            .as_array_mut()
            .unwrap()
            .pop();
        assert_error(
            missing_half_edge,
            WaveguideMeshIncidenceErrorCode::MissingHalfEdgeIncidence,
        );

        let mut duplicate_edge = fixture_value();
        let duplicate = duplicate_edge["edges"][0].clone();
        duplicate_edge["edges"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert_error(
            duplicate_edge,
            WaveguideMeshIncidenceErrorCode::DuplicateEdge,
        );
    }

    #[test]
    fn wrong_incidence_cell_and_region_owner_are_rejected() {
        let mesh = fixture_mesh();
        let edge_index = mesh
            .edges
            .iter()
            .position(|edge| edge.incidences.len() == 1)
            .expect("fixture has an exterior edge");
        let owner = usize::try_from(mesh.edges[edge_index].incidences[0].triangle_index)
            .expect("fixture triangle index fits usize");
        let replacement = (0..mesh.triangles.len())
            .find(|candidate| {
                *candidate != owner
                    && (0_u8..=2).all(|side| {
                        let (start, end) =
                            directed_side(mesh.triangles[*candidate].nodes, side).unwrap();
                        canonical_pair(start, end) != mesh.edges[edge_index].nodes
                    })
            })
            .expect("fixture has a triangle that does not own this edge");
        let mut wrong_cell = fixture_value();
        wrong_cell["edges"][edge_index]["incidences"][0]["triangle_index"] = json!(replacement);
        assert_error(
            wrong_cell,
            WaveguideMeshIncidenceErrorCode::IncidenceEndpointMismatch,
        );

        let mut wrong_region = fixture_value();
        wrong_region["boundary_components"][0]["region_id"] = json!("region-air");
        assert_error(
            wrong_region,
            WaveguideMeshIncidenceErrorCode::BoundaryOwnerMismatch,
        );
    }

    #[test]
    fn missing_extra_wrong_and_nonclosed_contours_are_rejected() {
        let mut missing_contour = fixture_value();
        missing_contour["boundary_components"]
            .as_array_mut()
            .unwrap()
            .remove(0);
        assert_error(
            missing_contour,
            WaveguideMeshIncidenceErrorCode::MissingContourCoverage,
        );

        let mesh = fixture_mesh();
        let internal_same_region = mesh
            .edges
            .iter()
            .find(|edge| {
                edge.incidences.len() == 2
                    && mesh.triangles[usize::try_from(edge.incidences[0].triangle_index).unwrap()]
                        .region_id
                        == mesh.triangles
                            [usize::try_from(edge.incidences[1].triangle_index).unwrap()]
                        .region_id
            })
            .and_then(|edge| edge.incidences.first())
            .expect("fixture has a same-region internal edge");
        let extra_half_edge = serde_json::to_value(internal_same_region).unwrap();
        let mut extra_contour = fixture_value();
        extra_contour["boundary_components"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "boundary_component_id": "boundary-extra",
                "region_id": "region-air",
                "loop_kind": "outer",
                "half_edges": [
                    extra_half_edge.clone(),
                    extra_half_edge.clone(),
                    extra_half_edge
                ]
            }));
        assert_error(
            extra_contour,
            WaveguideMeshIncidenceErrorCode::UnexpectedBoundaryHalfEdge,
        );

        let mut nonclosed_contour = fixture_value();
        nonclosed_contour["boundary_components"][0]["half_edges"]
            .as_array_mut()
            .unwrap()
            .swap(0, 1);
        assert_error(
            nonclosed_contour,
            WaveguideMeshIncidenceErrorCode::ContourNotClosed,
        );
    }

    #[test]
    fn duplicate_ids_and_orphan_nodes_regions_and_edges_are_rejected() {
        let mut duplicate_region_id = fixture_value();
        let duplicate_region_id_value = duplicate_region_id["regions"][0]["region_id"].clone();
        duplicate_region_id["regions"][1]["region_id"] = duplicate_region_id_value;
        assert_error(
            duplicate_region_id,
            WaveguideMeshIncidenceErrorCode::DuplicateIdentifier,
        );

        let mut duplicate_boundary_id = fixture_value();
        let duplicate_boundary_id_value =
            duplicate_boundary_id["boundary_components"][0]["boundary_component_id"].clone();
        duplicate_boundary_id["boundary_components"][1]["boundary_component_id"] =
            duplicate_boundary_id_value;
        assert_error(
            duplicate_boundary_id,
            WaveguideMeshIncidenceErrorCode::DuplicateIdentifier,
        );

        let mut orphan_node = fixture_value();
        orphan_node["nodes_uv_m"]
            .as_array_mut()
            .unwrap()
            .push(json!([4.0e-9, 4.0e-9]));
        assert_error(orphan_node, WaveguideMeshIncidenceErrorCode::OrphanNode);

        let mut orphan_region = fixture_value();
        orphan_region["regions"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "kind": "air",
                "region_id": "region-unused",
                "object_id": "object-unused"
            }));
        assert_error(orphan_region, WaveguideMeshIncidenceErrorCode::OrphanRegion);

        let mut orphan_edge = fixture_value();
        orphan_edge["edges"][0]["nodes"] = json!([0, 15]);
        assert_error(orphan_edge, WaveguideMeshIncidenceErrorCode::OrphanEdge);
    }

    #[test]
    fn self_touching_contour_repeated_nodes_are_rejected() {
        let value = point_contact_fixture(true, true);
        assert_error(value, WaveguideMeshIncidenceErrorCode::ContourRepeatedNode);
    }

    #[test]
    fn separate_contours_of_one_region_cannot_touch_at_a_node() {
        let value = point_contact_fixture(true, false);
        assert_error(
            value,
            WaveguideMeshIncidenceErrorCode::SameRegionContoursTouch,
        );
    }

    #[test]
    fn point_contact_between_different_regions_has_a_disconnected_vertex_fan() {
        let value = point_contact_fixture(false, false);
        assert_error(
            value,
            WaveguideMeshIncidenceErrorCode::DisconnectedVertexFan,
        );
    }
}
