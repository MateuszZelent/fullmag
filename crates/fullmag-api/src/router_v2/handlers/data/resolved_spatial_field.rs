//! Backend-neutral internal carrier for spatial field resources.
//!
//! Runtime payloads currently enter the API as `f64`; keeping `Vec<f64>` here
//! is therefore an explicit preservation of the existing API-side precision,
//! not a conversion performed by this adapter.

use std::collections::{BTreeMap, BTreeSet};

use fullmag_quantities::{quantity_spec, QuantityComponent, QuantityLocation, QuantityShape};
use fullmag_runner::FemMeshPayload;

use super::fdm_region_membership::{load_resolved_fdm_membership, ResolvedFdmMembership};
use super::field_resolution::{
    fem_magnetic_node_indices, flatten_json_field_values, is_fdm_snapshot, json_field_grid,
};
use crate::error::ApiError;
use crate::router_v2::handlers::sessions::status::{
    domain_generation_revision, fdm_grid_geometry, fdm_grid_shape,
};
use crate::schemas::mesh::FdmRegionLegendEntryResource;
use crate::session::{resolved_current_field_source, ResolvedCurrentFieldSource};
use crate::types::SessionStateResponse;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SpatialFieldSourceKind {
    Live,
    Materialized,
    Preview,
    Persisted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SpatialFieldProvenance {
    pub backend: Option<String>,
    pub device: Option<String>,
    pub precision: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum EntityMapping {
    Identity { entity_count: usize },
    ExplicitLocalToGlobal(Vec<u32>),
}

impl EntityMapping {
    pub(crate) fn global_entity_ids(&self) -> Option<&[u32]> {
        match self {
            Self::Identity { .. } => None,
            Self::ExplicitLocalToGlobal(indices) => Some(indices),
        }
    }

    pub(crate) fn value_indices_for_global_entities(
        &self,
        global_entity_ids: &[usize],
    ) -> Vec<usize> {
        match self {
            Self::Identity { entity_count } => global_entity_ids
                .iter()
                .copied()
                .filter(|index| *index < *entity_count)
                .collect(),
            Self::ExplicitLocalToGlobal(local_to_global) => {
                let local_index_by_global = local_to_global
                    .iter()
                    .enumerate()
                    .map(|(local, global)| (*global as usize, local))
                    .collect::<BTreeMap<_, _>>();
                global_entity_ids
                    .iter()
                    .filter_map(|global| local_index_by_global.get(global).copied())
                    .collect()
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FdmCellMembership {
    pub object_ids: Vec<String>,
    pub region_legend: Vec<FdmRegionLegendEntryResource>,
    pub cell_membership: Vec<u32>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct FdmMultilayerScopeCarrier<'a> {
    pub artifact_layout: &'a serde_json::Value,
    pub execution_plan: &'a serde_json::Value,
}

impl From<&ResolvedFdmMembership> for FdmCellMembership {
    fn from(value: &ResolvedFdmMembership) -> Self {
        Self {
            object_ids: value.object_ids.clone(),
            region_legend: value.region_legend.clone(),
            cell_membership: value.cell_membership.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) enum SpatialFieldCarrier<'a> {
    FdmCells {
        cells: [u32; 3],
        origin_m: Option<[f64; 3]>,
        cell_size_m: Option<[f64; 3]>,
        grid_fingerprint: Option<String>,
        membership: Option<FdmCellMembership>,
        multilayer_scope: Option<FdmMultilayerScopeCarrier<'a>>,
    },
    FemNodes {
        topology: &'a FemMeshPayload,
        topology_fingerprint: String,
        mapping: EntityMapping,
    },
    FemElements {
        topology: &'a FemMeshPayload,
        topology_fingerprint: String,
        mapping: EntityMapping,
    },
    ArtifactLinear {
        point_count: usize,
        grid: [u32; 3],
        quantity_domain: String,
        artifact_identity: String,
    },
    FdmAirboxCells {
        cells: [u32; 3],
        origin_m: [f64; 3],
        cell_size_m: [f64; 3],
        grid_revision: u64,
        carrier_fingerprint: String,
    },
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedSpatialField<'a> {
    pub quantity_id: String,
    pub quantity_kind: QuantityShape,
    pub canonical_unit: String,
    pub component_count: usize,
    pub default_component: QuantityComponent,
    pub source_kind: SpatialFieldSourceKind,
    pub provenance: SpatialFieldProvenance,
    pub field_generation: Option<String>,
    pub quantity_revision: u64,
    pub mesh_or_grid_revision: u64,
    pub source_grid: Option<[u32; 3]>,
    pub values: Vec<f64>,
    pub carrier: SpatialFieldCarrier<'a>,
}

impl ResolvedSpatialField<'static> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_artifact_linear(
        quantity_id: &str,
        component_count: usize,
        values: Vec<f64>,
        grid: [u32; 3],
        quantity_revision: u64,
        artifact_identity: String,
        provenance: SpatialFieldProvenance,
    ) -> Result<Self, ApiError> {
        let spec = quantity_spec(quantity_id).ok_or_else(|| {
            ApiError::not_found(format!("unknown spatial quantity '{quantity_id}'"))
        })?;
        if component_count == 0
            || component_count != usize::from(spec.n_comp)
            || values.is_empty()
            || values.len() % component_count != 0
            || values.iter().any(|value| !value.is_finite())
            || quantity_revision == 0
            || artifact_identity.is_empty()
        {
            return Err(ApiError::conflict(format!(
                "artifact field '{quantity_id}' violates its canonical quantity contract"
            )));
        }
        let point_count = values.len() / component_count;
        let field = Self {
            quantity_id: quantity_id.to_string(),
            quantity_kind: spec.shape,
            canonical_unit: spec.unit.to_string(),
            component_count,
            default_component: spec.default_component,
            source_kind: SpatialFieldSourceKind::Persisted,
            provenance,
            field_generation: Some(artifact_identity.clone()),
            quantity_revision,
            mesh_or_grid_revision: quantity_revision,
            source_grid: Some(grid),
            values,
            carrier: SpatialFieldCarrier::ArtifactLinear {
                point_count,
                grid,
                quantity_domain: spec.domain.as_str().to_string(),
                artifact_identity,
            },
        };
        field.validate_contract()?;
        Ok(field)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_airbox(
        quantity_id: &str,
        carrier_quantity_id: &str,
        unit: &str,
        component_count: usize,
        values: Vec<f64>,
        cells: [u32; 3],
        origin_m: [f64; 3],
        cell_size_m: [f64; 3],
        carrier_fingerprint: String,
        quantity_revision: u64,
        grid_revision: u64,
        carrier_revision: u64,
        source_kind: SpatialFieldSourceKind,
    ) -> Result<Self, ApiError> {
        if quantity_id != carrier_quantity_id {
            return Err(ApiError::not_found(format!(
                "field '{quantity_id}' is not published on Airbox carrier '{carrier_quantity_id}'"
            )));
        }
        let spec = quantity_spec(quantity_id).ok_or_else(|| {
            ApiError::not_found(format!("unknown spatial quantity '{quantity_id}'"))
        })?;
        if spec.unit != unit || spec.n_comp as usize != component_count {
            return Err(ApiError::conflict(format!(
                "airbox carrier metadata does not match quantity '{quantity_id}'"
            )));
        }
        let point_count = cells.into_iter().try_fold(1usize, |count, axis| {
            usize::try_from(axis).ok()?.checked_mul(count)
        });
        if point_count != Some(values.len() / component_count.max(1))
            || component_count == 0
            || values.len() % component_count != 0
        {
            return Err(ApiError::conflict(format!(
                "airbox carrier length does not match quantity '{quantity_id}' grid"
            )));
        }
        let field = Self {
            quantity_id: quantity_id.to_string(),
            quantity_kind: spec.shape,
            canonical_unit: spec.unit.to_string(),
            component_count,
            default_component: spec.default_component,
            source_kind,
            provenance: SpatialFieldProvenance {
                backend: None,
                device: None,
                precision: None,
            },
            field_generation: None,
            quantity_revision,
            mesh_or_grid_revision: carrier_revision,
            source_grid: Some(cells),
            values,
            carrier: SpatialFieldCarrier::FdmAirboxCells {
                cells,
                origin_m,
                cell_size_m,
                grid_revision,
                carrier_fingerprint,
            },
        };
        field.validate_contract()?;
        Ok(field)
    }
}

impl ResolvedSpatialField<'_> {
    pub(crate) fn validate_contract(&self) -> Result<(), ApiError> {
        let spec = quantity_spec(&self.quantity_id).ok_or_else(|| {
            ApiError::not_found(format!("unknown spatial quantity '{}'", self.quantity_id))
        })?;
        if self.quantity_kind != spec.shape
            || self.canonical_unit != spec.unit
            || self.component_count != spec.n_comp as usize
            || self.default_component != spec.default_component
            || self.component_count == 0
            || self.values.len() % self.component_count != 0
        {
            return Err(ApiError::conflict(format!(
                "resolved field '{}' disagrees with the canonical quantity contract",
                self.quantity_id
            )));
        }
        if self.field_generation.as_deref().is_some_and(str::is_empty) {
            return Err(ApiError::conflict(format!(
                "resolved field '{}' has an empty generation identity",
                self.quantity_id
            )));
        }
        let local_count = self.values.len() / self.component_count;
        match &self.carrier {
            SpatialFieldCarrier::FdmCells {
                cells,
                origin_m,
                cell_size_m,
                grid_fingerprint,
                membership,
                multilayer_scope,
            } => {
                validate_grid_count(*cells, local_count, &self.quantity_id)?;
                if origin_m.is_some() != cell_size_m.is_some()
                    || origin_m.is_some_and(|origin| origin.iter().any(|value| !value.is_finite()))
                    || cell_size_m.is_some_and(|spacing| {
                        spacing
                            .iter()
                            .any(|value| !value.is_finite() || *value <= 0.0)
                    })
                    || membership
                        .as_ref()
                        .is_some_and(|membership| membership.cell_membership.len() != local_count)
                    || (membership.is_some() && grid_fingerprint.is_none())
                    || multilayer_scope.is_some_and(|scope| {
                        scope
                            .artifact_layout
                            .get("backend")
                            .and_then(serde_json::Value::as_str)
                            != Some("fdm_multilayer")
                    })
                {
                    return Err(ApiError::conflict(format!(
                        "FDM carrier metadata is inconsistent for field '{}'",
                        self.quantity_id
                    )));
                }
            }
            SpatialFieldCarrier::FemNodes {
                topology,
                topology_fingerprint,
                mapping,
            } => validate_entity_mapping(
                mapping,
                local_count,
                topology.nodes.len(),
                topology_fingerprint,
                &self.quantity_id,
            )?,
            SpatialFieldCarrier::FemElements {
                topology,
                topology_fingerprint,
                mapping,
            } => validate_entity_mapping(
                mapping,
                local_count,
                topology.cell_count(),
                topology_fingerprint,
                &self.quantity_id,
            )?,
            SpatialFieldCarrier::ArtifactLinear {
                point_count,
                grid,
                quantity_domain,
                artifact_identity,
            } => {
                validate_grid_count(*grid, local_count, &self.quantity_id)?;
                if *point_count != local_count
                    || quantity_domain != spec.domain.as_str()
                    || artifact_identity.is_empty()
                    || self.source_kind != SpatialFieldSourceKind::Persisted
                {
                    return Err(ApiError::conflict(format!(
                        "artifact carrier metadata is inconsistent for field '{}'",
                        self.quantity_id
                    )));
                }
            }
            SpatialFieldCarrier::FdmAirboxCells {
                cells,
                origin_m,
                cell_size_m,
                grid_revision,
                carrier_fingerprint,
            } => {
                validate_grid_count(*cells, local_count, &self.quantity_id)?;
                if origin_m.iter().any(|value| !value.is_finite())
                    || cell_size_m
                        .iter()
                        .any(|value| !value.is_finite() || *value <= 0.0)
                    || *grid_revision == 0
                    || carrier_fingerprint.is_empty()
                {
                    return Err(ApiError::conflict(format!(
                        "Airbox carrier metadata is inconsistent for field '{}'",
                        self.quantity_id
                    )));
                }
            }
        }
        Ok(())
    }
}

fn validate_grid_count(
    cells: [u32; 3],
    local_count: usize,
    quantity_id: &str,
) -> Result<(), ApiError> {
    let grid_count = cells.into_iter().try_fold(1usize, |count, axis| {
        usize::try_from(axis).ok()?.checked_mul(count)
    });
    if grid_count != Some(local_count) {
        return Err(ApiError::conflict(format!(
            "field '{quantity_id}' length does not match its structured-grid carrier"
        )));
    }
    Ok(())
}

fn validate_entity_mapping(
    mapping: &EntityMapping,
    local_count: usize,
    global_count: usize,
    topology_fingerprint: &str,
    quantity_id: &str,
) -> Result<(), ApiError> {
    let valid = match mapping {
        EntityMapping::Identity { entity_count } => {
            *entity_count == local_count && *entity_count == global_count
        }
        EntityMapping::ExplicitLocalToGlobal(indices) => {
            indices.len() == local_count
                && indices.iter().all(|index| (*index as usize) < global_count)
                && indices.iter().copied().collect::<BTreeSet<_>>().len() == indices.len()
        }
    };
    if !valid || topology_fingerprint.is_empty() {
        return Err(ApiError::conflict(format!(
            "field '{quantity_id}' entity mapping disagrees with its FEM topology"
        )));
    }
    Ok(())
}

pub(crate) fn resolve_fem_node_mapping(
    mesh: &FemMeshPayload,
    quantity_id: &str,
    point_count: usize,
) -> Result<EntityMapping, ApiError> {
    if point_count == mesh.nodes.len() {
        return Ok(EntityMapping::Identity {
            entity_count: point_count,
        });
    }
    let spec = quantity_spec(quantity_id)
        .ok_or_else(|| ApiError::not_found(format!("unknown spatial quantity '{quantity_id}'")))?;
    if spec.domain.as_str() != "magnetic_only" {
        return Err(ApiError::conflict(format!(
            "field '{quantity_id}' length does not match the FEM node layout"
        )));
    }
    let mapping = fem_magnetic_node_indices(mesh).ok_or_else(|| {
        ApiError::conflict(format!(
            "compact field '{quantity_id}' has no resolvable magnetic-node mapping"
        ))
    })?;
    if mapping.len() != point_count {
        return Err(ApiError::conflict(format!(
            "compact field '{quantity_id}' length does not match the FEM magnetic-node mapping"
        )));
    }
    Ok(EntityMapping::ExplicitLocalToGlobal(mapping))
}

pub(crate) fn resolve_fdm_object_indices(
    membership: &FdmCellMembership,
    object_id: &str,
) -> Result<Vec<usize>, ApiError> {
    if !membership
        .object_ids
        .iter()
        .any(|candidate| object_ids_match(candidate, object_id))
    {
        return Err(ApiError::not_found(format!(
            "FDM object membership not found: {object_id}"
        )));
    }
    let numeric_ids = membership
        .region_legend
        .iter()
        .filter(|entry| object_ids_match(&entry.object_id, object_id))
        .map(|entry| entry.numeric_id)
        .collect::<BTreeSet<_>>();
    let canonical_objects = membership
        .object_ids
        .iter()
        .map(|id| canonical_object_id(id))
        .collect::<BTreeSet<_>>();
    if canonical_objects.len() > 1 && membership.cell_membership.contains(&0) {
        return Err(ApiError::conflict(format!(
            "ambiguous_membership: FDM default membership is ambiguous for object '{object_id}'"
        )));
    }
    let selected = membership
        .cell_membership
        .iter()
        .enumerate()
        .filter_map(|(index, numeric_id)| {
            (numeric_ids.contains(numeric_id) || (*numeric_id == 0 && canonical_objects.len() == 1))
                .then_some(index)
        })
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Err(ApiError::not_found(format!(
            "FDM object membership has no realized cells: {object_id}"
        )));
    }
    Ok(selected)
}

fn canonical_object_id(id: &str) -> &str {
    id.strip_suffix("_geom")
        .or_else(|| id.strip_suffix("_geometry"))
        .or_else(|| id.strip_suffix("-geometry"))
        .unwrap_or(id)
}

fn object_ids_match(left: &str, right: &str) -> bool {
    left == right || canonical_object_id(left) == canonical_object_id(right)
}

pub(crate) fn resolve_current_spatial_field<'a>(
    snapshot: &'a SessionStateResponse,
    quantity_id: &str,
    component_count: usize,
) -> Result<Option<ResolvedSpatialField<'a>>, ApiError> {
    let Some(_) = quantity_spec(quantity_id) else {
        return Ok(None);
    };
    let Some(source) = resolved_current_field_source(snapshot, quantity_id, component_count) else {
        return Ok(None);
    };
    let (values, grid, source_kind, quantity_revision, field_generation) = match source {
        ResolvedCurrentFieldSource::Latest(raw) => (
            flatten_json_field_values(raw),
            json_field_grid(raw),
            SpatialFieldSourceKind::Materialized,
            exact_latest_quantity_revision(snapshot, raw, quantity_id),
            exact_latest_field_generation(snapshot, raw),
        ),
        ResolvedCurrentFieldSource::Preview(field) => (
            field.vector_field_values.clone(),
            Some(field.preview_grid),
            SpatialFieldSourceKind::Preview,
            snapshot
                .field_quantity_revisions
                .get(quantity_id)
                .copied()
                .unwrap_or(0),
            None,
        ),
        ResolvedCurrentFieldSource::LegacyLiveMagnetization { values, grid } => (
            values.to_vec(),
            Some(grid),
            SpatialFieldSourceKind::Live,
            snapshot
                .field_quantity_revisions
                .get(quantity_id)
                .copied()
                .unwrap_or(0),
            None,
        ),
    };
    resolve_spatial_field_from_values(
        snapshot,
        quantity_id,
        component_count,
        values,
        grid,
        source_kind,
        quantity_revision,
        field_generation,
        SpatialFieldProvenance {
            backend: snapshot.session.resolved_backend.clone(),
            device: snapshot.session.resolved_device.clone(),
            precision: snapshot.session.resolved_precision.clone(),
        },
    )
    .map(Some)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn resolve_spatial_field_from_values<'a>(
    snapshot: &'a SessionStateResponse,
    quantity_id: &str,
    component_count: usize,
    values: Vec<f64>,
    grid: Option<[u32; 3]>,
    source_kind: SpatialFieldSourceKind,
    quantity_revision: u64,
    field_generation: Option<String>,
    provenance: SpatialFieldProvenance,
) -> Result<ResolvedSpatialField<'a>, ApiError> {
    let spec = quantity_spec(quantity_id)
        .ok_or_else(|| ApiError::not_found(format!("unknown spatial quantity '{quantity_id}'")))?;
    if component_count == 0
        || values.is_empty()
        || values.len() % component_count != 0
        || values.iter().any(|value| !value.is_finite())
    {
        return Err(ApiError::conflict(format!(
            "field '{quantity_id}' values violate the canonical component contract"
        )));
    }
    let point_count = values.len() / component_count;
    let carrier = if is_fdm_snapshot(snapshot) {
        let cells = resolved_grid(snapshot, grid, point_count);
        let (origin_m, cell_size_m) = fdm_grid_geometry(snapshot)
            .map(|(origin, spacing)| (Some(origin), Some(spacing)))
            .unwrap_or((None, None));
        let membership = load_resolved_fdm_membership(snapshot).ok();
        let multilayer_scope = snapshot.metadata.as_ref().and_then(|metadata| {
            let artifact_layout = metadata.get("artifact_layout")?;
            let execution_plan = metadata.get("execution_plan")?;
            (artifact_layout
                .get("backend")
                .and_then(serde_json::Value::as_str)
                == Some("fdm_multilayer"))
            .then(|| FdmMultilayerScopeCarrier {
                artifact_layout,
                execution_plan,
            })
        });
        let grid_fingerprint = membership
            .as_ref()
            .map(|membership| membership.grid_fingerprint.clone());
        SpatialFieldCarrier::FdmCells {
            cells,
            origin_m,
            cell_size_m,
            grid_fingerprint,
            membership: membership.as_ref().map(FdmCellMembership::from),
            multilayer_scope,
        }
    } else {
        let mesh = snapshot.fem_mesh.as_ref().ok_or_else(|| {
            ApiError::conflict(format!("field '{quantity_id}' has no FEM topology carrier"))
        })?;
        let topology_fingerprint = fullmag_runner::fem_mesh_topology_fingerprint(mesh);
        match spec.location {
            QuantityLocation::Cell if point_count == mesh.cell_count() => {
                SpatialFieldCarrier::FemElements {
                    topology: mesh,
                    topology_fingerprint,
                    mapping: EntityMapping::Identity {
                        entity_count: point_count,
                    },
                }
            }
            QuantityLocation::Cell => {
                return Err(ApiError::conflict(format!(
                    "element field '{quantity_id}' length does not match the FEM element layout"
                )));
            }
            QuantityLocation::Node => SpatialFieldCarrier::FemNodes {
                topology: mesh,
                topology_fingerprint,
                mapping: resolve_fem_node_mapping(mesh, quantity_id, point_count)?,
            },
            QuantityLocation::Global => {
                return Err(ApiError::conflict(format!(
                    "global quantity '{quantity_id}' has no spatial FEM carrier"
                )));
            }
        }
    };
    let field = ResolvedSpatialField {
        quantity_id: quantity_id.to_string(),
        quantity_kind: spec.shape,
        canonical_unit: spec.unit.to_string(),
        component_count,
        default_component: spec.default_component,
        source_kind,
        provenance,
        field_generation,
        quantity_revision,
        mesh_or_grid_revision: if is_fdm_snapshot(snapshot) {
            domain_generation_revision(snapshot)
        } else {
            snapshot.mesh_revision
        },
        source_grid: grid,
        values,
        carrier,
    };
    field.validate_contract()?;
    Ok(field)
}

fn exact_latest_quantity_revision(
    snapshot: &SessionStateResponse,
    raw: &serde_json::Value,
    quantity_id: &str,
) -> u64 {
    raw.get("field_revision")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| raw.get("revision").and_then(serde_json::Value::as_u64))
        .or_else(|| snapshot.field_quantity_revisions.get(quantity_id).copied())
        .unwrap_or(0)
}

fn exact_latest_field_generation(
    snapshot: &SessionStateResponse,
    raw: &serde_json::Value,
) -> Option<String> {
    raw.get("field_generation")
        .and_then(serde_json::Value::as_str)
        .filter(|generation| !generation.is_empty())
        .map(str::to_string)
        .or_else(|| {
            snapshot
                .accepted_terminal_field_generation
                .as_ref()
                .map(|generation| format!("{}:{}", generation.run_id, generation.sequence))
        })
}

fn resolved_grid(
    snapshot: &SessionStateResponse,
    grid: Option<[u32; 3]>,
    point_count: usize,
) -> [u32; 3] {
    let candidate = grid.unwrap_or_else(|| fdm_grid_shape(snapshot, None));
    let candidate_count = candidate.into_iter().try_fold(1usize, |count, axis| {
        usize::try_from(axis).ok()?.checked_mul(count)
    });
    if candidate_count == Some(point_count) {
        candidate
    } else {
        [point_count as u32, 1, 1]
    }
}

#[cfg(test)]
mod tests {
    use fullmag_quantities::{QuantityComponent, QuantityShape};
    use fullmag_runner::{FemMeshPartPayload, FemMeshPayload};

    use crate::schemas::mesh::FdmRegionLegendEntryResource;

    use super::{
        resolve_fdm_object_indices, resolve_fem_node_mapping, EntityMapping, FdmCellMembership,
        ResolvedSpatialField, SpatialFieldCarrier, SpatialFieldProvenance, SpatialFieldSourceKind,
    };

    fn fem_mesh() -> FemMeshPayload {
        FemMeshPayload {
            mesh_name: "resolved-spatial-field-test".to_string(),
            mesh_id: "resolved-spatial-field-test:1".to_string(),
            nodes: vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 1.0, 1.0],
            ],
            cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
            element_markers: vec![1],
            facets: fullmag_ir::FemFacetConnectivityIR::empty(),
            boundary_markers: Vec::new(),
            periodic_boundary_pairs: Vec::new(),
            periodic_node_pairs: Vec::new(),
            object_segments: Vec::new(),
            mesh_parts: vec![FemMeshPartPayload {
                id: "magnet".to_string(),
                label: "magnet".to_string(),
                role: "magnetic_object".to_string(),
                object_id: Some("magnet".to_string()),
                geometry_id: Some("magnet-geometry".to_string()),
                material_id: Some("permalloy".to_string()),
                element_start: 0,
                element_count: 1,
                boundary_face_start: 0,
                boundary_face_count: 0,
                boundary_face_indices: Vec::new(),
                node_start: 0,
                node_count: 0,
                node_indices: vec![1, 3],
                facet_global_ordinals: Vec::new(),
                bounds_min: None,
                bounds_max: None,
            }],
            domain_mesh_mode: Some("shared_domain".to_string()),
            domain_frame: None,
            generation_id: Some("mesh-generation-7".to_string()),
            per_domain_quality: Default::default(),
            build_report: None,
        }
    }

    fn membership(
        object_ids: &[&str],
        legend: &[(&str, &str, u32)],
        cells: &[u32],
    ) -> FdmCellMembership {
        FdmCellMembership {
            object_ids: object_ids.iter().map(|id| (*id).to_string()).collect(),
            region_legend: legend
                .iter()
                .map(
                    |(object_id, region_id, numeric_id)| FdmRegionLegendEntryResource {
                        numeric_id: *numeric_id,
                        object_id: (*object_id).to_string(),
                        region_id: (*region_id).to_string(),
                        priority: 0,
                    },
                )
                .collect(),
            cell_membership: cells.to_vec(),
        }
    }

    #[test]
    fn compact_fem_field_resolves_global_node_ids() {
        let mapping = resolve_fem_node_mapping(&fem_mesh(), "m", 2)
            .expect("compact magnetic field should resolve its global node identities");

        assert_eq!(mapping, EntityMapping::ExplicitLocalToGlobal(vec![1, 3]));
    }

    #[test]
    fn full_fem_field_keeps_identity_mapping() {
        let mapping = resolve_fem_node_mapping(&fem_mesh(), "H_demag", 5)
            .expect("full nodal field should keep the mesh node identity");

        assert_eq!(mapping, EntityMapping::Identity { entity_count: 5 });
    }

    #[test]
    fn fdm_object_scope_selects_only_requested_object() {
        let membership = membership(
            &["left", "right"],
            &[("left", "core", 1), ("right", "core", 2)],
            &[1, 2, 2],
        );

        let indices = resolve_fdm_object_indices(&membership, "right")
            .expect("right object has exact membership");

        assert_eq!(indices, vec![1, 2]);
    }

    #[test]
    fn fdm_ambiguous_default_membership_fails_closed() {
        let membership = membership(&["left", "right"], &[], &[0, 0]);

        let error = resolve_fdm_object_indices(&membership, "left")
            .expect_err("default membership cannot identify one of multiple objects");

        assert!(error.to_string().contains("ambiguous"));
    }

    #[test]
    fn fdm_mixed_default_and_numeric_membership_fails_closed() {
        let membership = membership(
            &["left", "right"],
            &[("left", "core", 1), ("right", "core", 2)],
            &[0, 1, 2],
        );

        let error = resolve_fdm_object_indices(&membership, "left")
            .expect_err("default cells cannot be assigned in a multi-object numeric map");

        assert!(error.to_string().contains("ambiguous"));
    }

    #[test]
    fn fdm_airbox_quantity_uses_airbox_carrier() {
        let field = ResolvedSpatialField::from_airbox(
            "H_demag",
            "H_demag",
            "A/m",
            3,
            vec![1.0, 2.0, 3.0],
            [1, 1, 1],
            [0.0, 0.0, 0.0],
            [1.0e-9, 1.0e-9, 1.0e-9],
            "airbox-grid-7".to_string(),
            11,
            4,
            9,
            SpatialFieldSourceKind::Persisted,
        )
        .expect("H_demag has a validated airbox carrier");

        let SpatialFieldCarrier::FdmAirboxCells {
            cells,
            origin_m,
            cell_size_m,
            grid_revision,
            carrier_fingerprint,
        } = &field.carrier
        else {
            panic!("H_demag should preserve the validated Airbox carrier");
        };
        assert_eq!(*cells, [1, 1, 1]);
        assert_eq!(*origin_m, [0.0, 0.0, 0.0]);
        assert_eq!(*cell_size_m, [1.0e-9, 1.0e-9, 1.0e-9]);
        assert_eq!(*grid_revision, 4);
        assert_eq!(carrier_fingerprint, "airbox-grid-7");
        assert_eq!(field.quantity_id, "H_demag");
        assert_eq!(field.quantity_kind, QuantityShape::VectorField);
        assert_eq!(field.canonical_unit, "A/m");
        assert_eq!(field.component_count, 3);
        assert_eq!(field.default_component, QuantityComponent::Vector3);
        assert_eq!(field.quantity_revision, 11);
        assert_eq!(field.mesh_or_grid_revision, 9);
        assert!(ResolvedSpatialField::from_airbox(
            "H_eff",
            "H_demag",
            "A/m",
            3,
            vec![1.0, 2.0, 3.0],
            [1, 1, 1],
            [0.0, 0.0, 0.0],
            [1.0e-9, 1.0e-9, 1.0e-9],
            "airbox-grid-7".to_string(),
            11,
            4,
            9,
            SpatialFieldSourceKind::Persisted,
        )
        .is_err());
    }

    fn fdm_field_with_geometry(
        origin_m: [f64; 3],
        cell_size_m: [f64; 3],
    ) -> ResolvedSpatialField<'static> {
        let spec = fullmag_quantities::quantity_spec("m").expect("m quantity contract");
        ResolvedSpatialField {
            quantity_id: "m".to_string(),
            quantity_kind: spec.shape,
            canonical_unit: spec.unit.to_string(),
            component_count: spec.n_comp as usize,
            default_component: spec.default_component,
            source_kind: SpatialFieldSourceKind::Materialized,
            provenance: SpatialFieldProvenance {
                backend: Some("fdm".to_string()),
                device: None,
                precision: Some("double".to_string()),
            },
            field_generation: Some("run-7:3".to_string()),
            quantity_revision: 7,
            mesh_or_grid_revision: 4,
            source_grid: Some([1, 1, 1]),
            values: vec![1.0, 0.0, 0.0],
            carrier: SpatialFieldCarrier::FdmCells {
                cells: [1, 1, 1],
                origin_m: Some(origin_m),
                cell_size_m: Some(cell_size_m),
                grid_fingerprint: None,
                membership: None,
                multilayer_scope: None,
            },
        }
    }

    #[test]
    fn fdm_structured_grid_rejects_non_finite_origin() {
        assert!(fdm_field_with_geometry([0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
            .validate_contract()
            .is_ok());
        let field = fdm_field_with_geometry([f64::NAN, 0.0, 0.0], [1.0, 1.0, 1.0]);

        assert!(field.validate_contract().is_err());
    }

    #[test]
    fn fdm_structured_grid_rejects_non_finite_spacing() {
        assert!(fdm_field_with_geometry([0.0, 0.0, 0.0], [1.0, 1.0, 1.0])
            .validate_contract()
            .is_ok());
        for spacing in [
            [f64::INFINITY, 1.0, 1.0],
            [f64::NAN, 1.0, 1.0],
            [0.0, 1.0, 1.0],
        ] {
            let field = fdm_field_with_geometry([0.0, 0.0, 0.0], spacing);
            assert!(field.validate_contract().is_err(), "accepted {spacing:?}");
        }
    }
}
