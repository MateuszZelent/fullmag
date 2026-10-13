//! Explicit finite-air Dirichlet selections tied to a borrowed registry mesh.
//! This prerequisite establishes scalar anchoring, not provider admission.
use crate::waveguide_mesh::{WaveguideCrossSectionLoopKindIR, WaveguideCrossSectionRegionIR};
use crate::waveguide_mesh_bindings::ValidatedWaveguideRegistryBindings;
use crate::waveguide_mesh_incidence::{
    validate_waveguide_mesh_incidence, WaveguideMeshIncidenceError,
};
use std::collections::{BTreeMap, BTreeSet};
use std::{error::Error, fmt};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FiniteAirDirichletBindingsError {
    InvalidIncidence(WaveguideMeshIncidenceError),
    EmptySelection,
    EmptyBoundaryId,
    DuplicateBoundaryId(String),
    MissingBoundaryId(String),
    NonAirBoundary(String),
    AirHoleBoundary(String),
    InterfaceBoundary {
        boundary_id: String,
        edge_index: usize,
    },
    BoundaryLookupInvariant,
    BoundaryCrossesScalarComponents(String),
    UnanchoredScalarComponent {
        component_index: usize,
    },
}
impl fmt::Display for FiniteAirDirichletBindingsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "finite-air Dirichlet binding error: {self:?}")
    }
}
impl Error for FiniteAirDirichletBindingsError {}

/// Immutable essential-node selection, valid only for these borrowed inputs.
/// No constructor or deserializer permits bypassing the binding checks.
#[derive(Debug)]
pub(crate) struct ValidatedFiniteAirDirichletBindings<'b, 'i> {
    registry: &'b ValidatedWaveguideRegistryBindings<'i>,
    boundary_component_indices: Vec<usize>,
    essential_node_indices: Vec<u64>,
    selected_edge_counts_by_component: Vec<usize>,
    essential_node_counts_by_component: Vec<usize>,
}
impl<'b, 'i> ValidatedFiniteAirDirichletBindings<'b, 'i> {
    pub(crate) fn registry(&self) -> &'b ValidatedWaveguideRegistryBindings<'i> {
        self.registry
    }
    pub(crate) fn boundary_component_indices(&self) -> &[usize] {
        &self.boundary_component_indices
    }
    pub(crate) fn essential_node_indices(&self) -> &[u64] {
        &self.essential_node_indices
    }
    pub(crate) fn selected_edge_counts_by_component(&self) -> &[usize] {
        &self.selected_edge_counts_by_component
    }
    pub(crate) fn essential_node_counts_by_component(&self) -> &[usize] {
        &self.essential_node_counts_by_component
    }
}

/// Bind exact user-selected outer-air contours; every scalar component must
/// receive essential nodes from actual one-owner exterior edges.
pub(crate) fn validate_finite_air_dirichlet_bindings<'b, 'i>(
    registry: &'b ValidatedWaveguideRegistryBindings<'i>,
    boundary_component_ids: &[String],
) -> Result<ValidatedFiniteAirDirichletBindings<'b, 'i>, FiniteAirDirichletBindingsError> {
    use FiniteAirDirichletBindingsError as E;
    let mesh = registry.mesh();
    // Never accept an independently supplied topology report from another mesh.
    let incidence = validate_waveguide_mesh_incidence(mesh).map_err(E::InvalidIncidence)?;
    if boundary_component_ids.is_empty() {
        return Err(E::EmptySelection);
    }
    let boundary_by_id = mesh
        .boundary_components
        .iter()
        .enumerate()
        .map(|(i, b)| (b.boundary_component_id.as_str(), i))
        .collect::<BTreeMap<_, _>>();
    let mut requested = BTreeSet::new();
    let mut selected = BTreeSet::new();
    for id in boundary_component_ids {
        if id.trim().is_empty() {
            return Err(E::EmptyBoundaryId);
        }
        if !requested.insert(id.as_str()) {
            return Err(E::DuplicateBoundaryId(id.clone()));
        }
        let i = boundary_by_id
            .get(id.as_str())
            .ok_or_else(|| E::MissingBoundaryId(id.clone()))?;
        selected.insert(*i);
    }
    let mut edge_by_half_edge = BTreeMap::new();
    for (edge_index, edge) in mesh.edges.iter().enumerate() {
        for side in &edge.incidences {
            let key = (side.triangle_index, side.local_edge_index.as_u8());
            if edge_by_half_edge.insert(key, edge_index).is_some() {
                return Err(E::BoundaryLookupInvariant);
            }
        }
    }
    let component_count = incidence.scalar_mesh_component_count();
    let mut edge_counts = vec![0usize; component_count];
    let mut nodes_by_component = vec![BTreeSet::<u64>::new(); component_count];
    let mut all_nodes = BTreeSet::new();
    for &boundary_index in &selected {
        let boundary = &mesh.boundary_components[boundary_index];
        let bound_region = registry
            .region_binding(&boundary.region_id)
            .ok_or(E::BoundaryLookupInvariant)?;
        if !matches!(
            bound_region.mesh_region(),
            WaveguideCrossSectionRegionIR::Air { .. }
        ) {
            return Err(E::NonAirBoundary(boundary.boundary_component_id.clone()));
        }
        if boundary.loop_kind != WaveguideCrossSectionLoopKindIR::Outer {
            return Err(E::AirHoleBoundary(boundary.boundary_component_id.clone()));
        }
        let mut contour_component = None;
        for half_edge in &boundary.half_edges {
            let edge_index = *edge_by_half_edge
                .get(&(half_edge.triangle_index, half_edge.local_edge_index.as_u8()))
                .ok_or(E::BoundaryLookupInvariant)?;
            if mesh.edges[edge_index].incidences.len() != 1 {
                return Err(E::InterfaceBoundary {
                    boundary_id: boundary.boundary_component_id.clone(),
                    edge_index,
                });
            }
            let triangle_index = usize::try_from(half_edge.triangle_index)
                .map_err(|_| E::BoundaryLookupInvariant)?;
            let triangle = mesh
                .triangles
                .get(triangle_index)
                .ok_or(E::BoundaryLookupInvariant)?;
            let component = *incidence
                .scalar_component_by_triangle()
                .get(triangle_index)
                .ok_or(E::BoundaryLookupInvariant)?;
            if let Some(previous) = contour_component {
                if previous != component {
                    return Err(E::BoundaryCrossesScalarComponents(
                        boundary.boundary_component_id.clone(),
                    ));
                }
            }
            contour_component = Some(component);
            let side = usize::from(half_edge.local_edge_index.as_u8());
            let nodes = [triangle.nodes[side], triangle.nodes[(side + 1) % 3]];
            edge_counts[component] += 1;
            for node in nodes {
                nodes_by_component[component].insert(node);
                all_nodes.insert(node);
            }
        }
    }
    for component_index in 0..component_count {
        if edge_counts[component_index] == 0 || nodes_by_component[component_index].is_empty() {
            return Err(E::UnanchoredScalarComponent { component_index });
        }
    }
    Ok(ValidatedFiniteAirDirichletBindings {
        registry,
        boundary_component_indices: selected.into_iter().collect(),
        essential_node_indices: all_nodes.into_iter().collect(),
        selected_edge_counts_by_component: edge_counts,
        essential_node_counts_by_component: nodes_by_component.iter().map(BTreeSet::len).collect(),
    })
}
