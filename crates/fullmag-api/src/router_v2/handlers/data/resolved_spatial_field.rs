//! Backend-neutral internal carrier for spatial field resources.
//!
//! Runtime payloads currently enter the API as `f64`; keeping `Vec<f64>` here
//! is therefore an explicit preservation of the existing API-side precision,
//! not a conversion performed by this adapter.

use std::collections::{BTreeMap, BTreeSet};

use fullmag_quantities::{quantity_spec, QuantityComponent, QuantityLocation, QuantityShape};
use fullmag_runner::FemMeshPayload;
use sha2::{Digest, Sha256};

use super::fdm_region_membership::{load_resolved_fdm_membership, ResolvedFdmMembership};
use super::field_resolution::{
    fem_magnetic_node_indices, flatten_json_field_values,
    fem_nodal_visualization_projection_allowed, is_fdm_snapshot, json_field_grid,
};
use crate::artifacts::read_json_artifact_value;
use crate::error::ApiError;
use crate::router_v2::handlers::sessions::status::{
    domain_generation_revision, fdm_grid_geometry, fdm_grid_shape,
};
use crate::schemas::mesh::FdmRegionLegendEntryResource;
use crate::session::{
    current_artifact_dir, resolved_current_field_source, ResolvedCurrentFieldSource,
};
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

#[derive(Debug, Clone)]
pub(crate) struct FdmNativeLayerMembershipCarrier {
    pub layer_id: String,
    pub object_id: String,
    pub magnet_name: String,
    pub cells: [u32; 3],
    pub origin_m: [f64; 3],
    pub cell_size_m: [f64; 3],
    pub grid_fingerprint: String,
    pub membership: FdmCellMembership,
    pub membership_revision: u64,
    pub membership_fingerprint: String,
    pub legend_fingerprint: String,
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
    FdmNativeLayerCells {
        layer_id: String,
        object_id: String,
        magnet_name: String,
        cells: [u32; 3],
        origin_m: [f64; 3],
        cell_size_m: [f64; 3],
        grid_fingerprint: String,
        membership: FdmCellMembership,
        membership_revision: u64,
        membership_fingerprint: String,
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
            SpatialFieldCarrier::FdmNativeLayerCells {
                layer_id,
                object_id,
                magnet_name,
                cells,
                origin_m,
                cell_size_m,
                grid_fingerprint,
                membership,
                membership_revision,
                membership_fingerprint,
                carrier_fingerprint,
            } => {
                validate_grid_count(*cells, local_count, &self.quantity_id)?;
                if layer_id.is_empty()
                    || object_id.is_empty()
                    || magnet_name.is_empty()
                    || origin_m.iter().any(|value| !value.is_finite())
                    || cell_size_m
                        .iter()
                        .any(|value| !value.is_finite() || *value <= 0.0)
                    || !canonical_sha256(grid_fingerprint)
                    || membership.cell_membership.len() != local_count
                    || *membership_revision == 0
                    || !canonical_sha256(membership_fingerprint)
                    || !canonical_sha256(carrier_fingerprint)
                {
                    return Err(ApiError::conflict(format!(
                        "native multilayer carrier metadata is inconsistent for field '{}'",
                        self.quantity_id
                    )));
                }
            }
        }
        Ok(())
    }
}

pub(crate) fn resolve_fdm_multilayer_native_layer_field(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    component_count: usize,
    requested_layer_id: &str,
) -> Result<Option<ResolvedSpatialField<'static>>, ApiError> {
    let Some(metadata) = snapshot.metadata.as_ref() else {
        return Ok(None);
    };
    if let Some(plan_layer) = planned_native_layer(metadata, requested_layer_id)? {
        return resolve_planned_native_layer_field(
            snapshot,
            plan_layer,
            quantity_id,
            component_count,
        )
        .map(Some);
    }
    let Some(layout) = metadata.get("artifact_layout").filter(|layout| {
        layout.get("backend").and_then(serde_json::Value::as_str) == Some("fdm_multilayer")
    }) else {
        return Ok(None);
    };
    let artifact_layers = layout
        .get("layers")
        .and_then(serde_json::Value::as_array)
        .filter(|layers| !layers.is_empty())
        .ok_or_else(|| ApiError::conflict("multilayer FDM artifact layout has no native layers"))?;
    let matching = artifact_layers
        .iter()
        .filter(|layer| {
            layer.get("layer_id").and_then(serde_json::Value::as_str) == Some(requested_layer_id)
        })
        .collect::<Vec<_>>();
    let artifact_layer = match matching.as_slice() {
        [] => {
            return Err(ApiError::not_found(format!(
                "layer_not_found: multilayer FDM layer '{requested_layer_id}' was not found"
            )));
        }
        [layer] => *layer,
        _ => {
            return Err(ApiError::conflict(format!(
                "ambiguous_layer_identity: multilayer FDM layer '{requested_layer_id}' is ambiguous"
            )));
        }
    };
    let layer_id = required_string(artifact_layer, "layer_id", "layer descriptor")?;
    if layer_id != requested_layer_id {
        return Err(ApiError::conflict(
            "multilayer FDM artifact and requested canonical layer identity disagree",
        ));
    }
    let object_id = required_string(artifact_layer, "object_id", "layer descriptor")?.to_string();
    let magnet_name =
        required_string(artifact_layer, "magnet_name", "layer descriptor")?.to_string();
    let cells = required_array3_u32(artifact_layer, "native_grid", requested_layer_id)?;
    let origin_m = required_array3_f64(artifact_layer, "native_origin", requested_layer_id, false)?;
    let cell_size_m =
        required_array3_f64(artifact_layer, "native_cell_size", requested_layer_id, true)?;
    let cell_count = grid_cell_count(cells, requested_layer_id)?;
    let grid_fingerprint = required_string(
        artifact_layer,
        "native_grid_fingerprint",
        "layer descriptor",
    )?;
    if !canonical_sha256(grid_fingerprint) {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{requested_layer_id}' has an invalid native grid fingerprint"
        )));
    }

    let material_descriptor = artifact_layer
        .get("material_fields")
        .and_then(|fields| fields.get(quantity_id))
        .filter(|descriptor| {
            descriptor
                .get("available")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        })
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "quantity_not_materialized: field '{quantity_id}' has no native array for layer '{requested_layer_id}'"
            ))
        })?;
    let spec = quantity_spec(quantity_id).ok_or_else(|| {
        ApiError::not_found(format!(
            "quantity_unavailable: quantity '{quantity_id}' is unknown"
        ))
    })?;
    if component_count != usize::from(spec.n_comp) || component_count != 1 {
        return Err(ApiError::conflict(format!(
            "multilayer material field '{quantity_id}' has an invalid component contract"
        )));
    }
    let material_path =
        required_string(material_descriptor, "artifact_path", "material descriptor")?;
    let artifact_dir = current_artifact_dir(snapshot).ok_or_else(|| {
        ApiError::conflict(format!(
            "declared multilayer material field '{quantity_id}' has no artifact root"
        ))
    })?;
    let material_payload = read_json_artifact_value(&artifact_dir, material_path).map_err(|_| {
        ApiError::conflict(format!(
            "declared multilayer material field '{quantity_id}' artifact is missing or corrupt for layer '{requested_layer_id}'"
        ))
    })?;
    validate_layer_payload_identity(
        &material_payload,
        "fdm_multilayer_material_field.v1",
        &layer_id,
        &object_id,
        &magnet_name,
        cells,
        origin_m,
        cell_size_m,
        grid_fingerprint,
    )?;
    if required_string(&material_payload, "field_id", "material payload")? != quantity_id
        || required_string(material_descriptor, "unit", "material descriptor")? != spec.unit
        || required_string(&material_payload, "unit", "material payload")? != spec.unit
    {
        return Err(ApiError::conflict(format!(
            "multilayer material field '{quantity_id}' unit or identity is inconsistent"
        )));
    }
    let values = strict_finite_values(&material_payload, "values", cell_count, quantity_id)?;
    let value_hash = hash_f64_values(&values);
    validate_content_descriptor(
        material_descriptor,
        &material_payload,
        cell_count,
        "value_sha256",
        &value_hash,
        "material field",
    )?;
    let quantity_revision =
        required_positive_u64(&material_payload, "revision", "material payload")?;
    let field_generation = required_string(&material_payload, "generation_id", "material payload")?;

    let mask_descriptor = artifact_layer
        .get("native_region_mask")
        .filter(|descriptor| {
            descriptor
                .get("available")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        })
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{requested_layer_id}' has no native region membership descriptor"
            ))
        })?;
    let legend_descriptor = artifact_layer
        .get("native_region_legend")
        .filter(|descriptor| {
            descriptor
                .get("available")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        })
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{requested_layer_id}' has no native region legend descriptor"
            ))
        })?;
    let membership_path =
        required_string(mask_descriptor, "artifact_path", "membership descriptor")?;
    if required_string(legend_descriptor, "artifact_path", "legend descriptor")? != membership_path
    {
        return Err(ApiError::conflict(
            "multilayer FDM membership mask and legend refer to different artifacts",
        ));
    }
    let membership_payload =
        read_json_artifact_value(&artifact_dir, membership_path).map_err(|_| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{requested_layer_id}' membership artifact is missing"
            ))
        })?;
    validate_layer_payload_identity(
        &membership_payload,
        "fdm_multilayer_region_membership.v1",
        &layer_id,
        &object_id,
        &magnet_name,
        cells,
        origin_m,
        cell_size_m,
        grid_fingerprint,
    )?;
    let mask = strict_u32_values(
        &membership_payload,
        "native_region_mask",
        cell_count,
        requested_layer_id,
    )?;
    let mask_hash = hash_u32_values(&mask);
    validate_content_descriptor(
        mask_descriptor,
        &membership_payload,
        cell_count,
        "value_sha256",
        &mask_hash,
        "membership mask",
    )?;
    let legend_value = membership_payload
        .get("native_region_legend")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ApiError::conflict("multilayer FDM membership legend is malformed"))?;
    let region_legend = serde_json::from_value::<Vec<FdmRegionLegendEntryResource>>(
        serde_json::Value::Array(legend_value.clone()),
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "multilayer FDM membership legend is malformed: {error}"
        ))
    })?;
    validate_region_legend(&region_legend, &mask, &object_id, requested_layer_id)?;
    let legend_hash = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(legend_value).map_err(|error| {
            ApiError::conflict(format!("failed to canonicalize multilayer legend: {error}"))
        })?)
    );
    validate_hash_agreement(
        legend_descriptor,
        &membership_payload,
        "legend_sha256",
        &legend_hash,
        "membership legend",
    )?;
    if legend_descriptor.get("entries") != Some(&serde_json::Value::Array(legend_value.clone())) {
        return Err(ApiError::conflict(
            "multilayer FDM legend descriptor entries disagree with its payload",
        ));
    }
    let entry_count =
        required_positive_or_zero_u64(legend_descriptor, "entry_count", "legend descriptor")?;
    if entry_count != region_legend.len() as u64 {
        return Err(ApiError::conflict(
            "multilayer FDM legend entry count disagrees with its payload",
        ));
    }
    let membership_revision =
        required_positive_u64(&membership_payload, "revision", "membership payload")?;
    validate_revision_generation_agreement(
        mask_descriptor,
        &membership_payload,
        membership_revision,
        "membership mask",
    )?;
    validate_revision_generation_agreement(
        legend_descriptor,
        &membership_payload,
        membership_revision,
        "membership legend",
    )?;
    let active_cells = mask.iter().filter(|value| **value != u32::MAX).count() as u64;
    let active_mask = mask
        .iter()
        .map(|value| *value != u32::MAX)
        .collect::<Vec<_>>();
    let topology_tokens = mask
        .iter()
        .map(|value| if *value == u32::MAX { 0 } else { *value })
        .collect::<Vec<_>>();
    let computed_grid_fingerprint = format!(
        "sha256:{}",
        fullmag_ir::FdmGridCertificateIR::new_with_topology_tokens(
            origin_m,
            cells,
            cell_size_m,
            active_cells,
            1,
            Some(&active_mask),
            &topology_tokens,
        )
        .map_err(|error| ApiError::conflict(format!("invalid native layer grid: {error}")))?
        .grid_fingerprint
    );
    if computed_grid_fingerprint != grid_fingerprint {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{requested_layer_id}' native grid fingerprint is stale"
        )));
    }
    let membership_fingerprint = native_layer_membership_generation_id(
        &layer_id,
        &object_id,
        &grid_fingerprint,
        membership_revision,
        &mask_hash,
        &legend_hash,
    )?;
    if required_string(&membership_payload, "generation_id", "membership payload")?
        != membership_fingerprint.as_str()
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{requested_layer_id}' membership generation is stale"
        )));
    }
    let carrier_fingerprint = format!(
        "sha256:{:x}",
        Sha256::digest(
            format!(
                "{layer_id}:{object_id}:{magnet_name}:{grid_fingerprint}:{membership_fingerprint}:{field_generation}:{value_hash}:{quantity_revision}"
            )
            .as_bytes()
        )
    );
    let carrier_revision = sha256_revision(&carrier_fingerprint)?;
    let membership = FdmCellMembership {
        object_ids: vec![object_id.clone()],
        region_legend,
        cell_membership: mask,
    };
    let field = ResolvedSpatialField {
        quantity_id: quantity_id.to_string(),
        quantity_kind: spec.shape,
        canonical_unit: spec.unit.to_string(),
        component_count,
        default_component: spec.default_component,
        source_kind: SpatialFieldSourceKind::Persisted,
        provenance: SpatialFieldProvenance {
            backend: snapshot.session.resolved_backend.clone(),
            device: snapshot.session.resolved_device.clone(),
            precision: snapshot.session.resolved_precision.clone(),
        },
        field_generation: Some(field_generation.to_string()),
        quantity_revision,
        mesh_or_grid_revision: carrier_revision,
        source_grid: Some(cells),
        values,
        carrier: SpatialFieldCarrier::FdmNativeLayerCells {
            layer_id: layer_id.to_string(),
            object_id,
            magnet_name,
            cells,
            origin_m,
            cell_size_m,
            grid_fingerprint: grid_fingerprint.to_string(),
            membership,
            membership_revision,
            membership_fingerprint,
            carrier_fingerprint,
        },
    };
    field.validate_contract()?;
    Ok(Some(field))
}

pub(crate) fn load_fdm_multilayer_native_layer_membership(
    snapshot: &SessionStateResponse,
    requested_layer_id: &str,
) -> Result<Option<FdmNativeLayerMembershipCarrier>, ApiError> {
    let Some(metadata) = snapshot.metadata.as_ref() else {
        return Ok(None);
    };
    if let Some(plan_layer) = planned_native_layer(metadata, requested_layer_id)? {
        let carrier = planned_native_layer_membership(snapshot, plan_layer)?;
        cross_check_planned_membership(snapshot, &carrier)?;
        return Ok(Some(carrier));
    }
    let Some(layout) = metadata.get("artifact_layout").filter(|layout| {
        layout.get("backend").and_then(serde_json::Value::as_str) == Some("fdm_multilayer")
    }) else {
        return Ok(None);
    };
    let artifact_layers = layout
        .get("layers")
        .and_then(serde_json::Value::as_array)
        .filter(|layers| !layers.is_empty())
        .ok_or_else(|| ApiError::conflict("multilayer FDM artifact layout has no native layers"))?;
    let matching = artifact_layers
        .iter()
        .filter(|layer| {
            layer.get("layer_id").and_then(serde_json::Value::as_str) == Some(requested_layer_id)
        })
        .collect::<Vec<_>>();
    let artifact_layer = match matching.as_slice() {
        [] => {
            return Err(ApiError::not_found(format!(
                "layer_not_found: multilayer FDM layer '{requested_layer_id}' was not found"
            )));
        }
        [layer] => *layer,
        _ => {
            return Err(ApiError::conflict(format!(
                "ambiguous_layer_identity: multilayer FDM layer '{requested_layer_id}' is ambiguous"
            )));
        }
    };
    let layer_id = required_string(artifact_layer, "layer_id", "layer descriptor")?.to_string();
    let object_id = required_string(artifact_layer, "object_id", "layer descriptor")?.to_string();
    let magnet_name =
        required_string(artifact_layer, "magnet_name", "layer descriptor")?.to_string();
    let cells = required_array3_u32(artifact_layer, "native_grid", requested_layer_id)?;
    let origin_m = required_array3_f64(artifact_layer, "native_origin", requested_layer_id, false)?;
    let cell_size_m =
        required_array3_f64(artifact_layer, "native_cell_size", requested_layer_id, true)?;
    let cell_count = grid_cell_count(cells, requested_layer_id)?;
    let grid_fingerprint = required_string(
        artifact_layer,
        "native_grid_fingerprint",
        "layer descriptor",
    )?
    .to_string();
    if !canonical_sha256(&grid_fingerprint) {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{requested_layer_id}' has an invalid native grid fingerprint"
        )));
    }
    let mask_descriptor = artifact_layer
        .get("native_region_mask")
        .filter(|descriptor| {
            descriptor
                .get("available")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        })
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "quantity_not_materialized: multilayer FDM layer '{requested_layer_id}' has no native region membership"
            ))
        })?;
    let legend_descriptor = artifact_layer
        .get("native_region_legend")
        .filter(|descriptor| {
            descriptor
                .get("available")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        })
        .ok_or_else(|| {
            ApiError::not_found(format!(
                "quantity_not_materialized: multilayer FDM layer '{requested_layer_id}' has no native region legend"
            ))
        })?;
    let membership_path =
        required_string(mask_descriptor, "artifact_path", "membership descriptor")?;
    if required_string(legend_descriptor, "artifact_path", "legend descriptor")? != membership_path
    {
        return Err(ApiError::conflict(
            "multilayer FDM membership mask and legend refer to different artifacts",
        ));
    }
    let artifact_dir = current_artifact_dir(snapshot).ok_or_else(|| {
        ApiError::conflict("declared native multilayer membership has no artifact root")
    })?;
    let payload = read_json_artifact_value(&artifact_dir, membership_path).map_err(|_| {
        ApiError::conflict(format!(
            "declared native membership artifact is missing or corrupt for layer '{requested_layer_id}'"
        ))
    })?;
    validate_layer_payload_identity(
        &payload,
        "fdm_multilayer_region_membership.v1",
        &layer_id,
        &object_id,
        &magnet_name,
        cells,
        origin_m,
        cell_size_m,
        &grid_fingerprint,
    )?;
    let mask = strict_u32_values(
        &payload,
        "native_region_mask",
        cell_count,
        requested_layer_id,
    )?;
    let mask_hash = hash_u32_values(&mask);
    validate_content_descriptor(
        mask_descriptor,
        &payload,
        cell_count,
        "value_sha256",
        &mask_hash,
        "membership mask",
    )?;
    let legend_value = payload
        .get("native_region_legend")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ApiError::conflict("multilayer FDM membership legend is malformed"))?;
    let region_legend = serde_json::from_value::<Vec<FdmRegionLegendEntryResource>>(
        serde_json::Value::Array(legend_value.clone()),
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "multilayer FDM membership legend is malformed: {error}"
        ))
    })?;
    validate_region_legend(&region_legend, &mask, &object_id, requested_layer_id)?;
    let legend_hash = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(legend_value).map_err(|error| {
            ApiError::conflict(format!("failed to canonicalize multilayer legend: {error}"))
        })?)
    );
    validate_hash_agreement(
        legend_descriptor,
        &payload,
        "legend_sha256",
        &legend_hash,
        "membership legend",
    )?;
    if legend_descriptor.get("entries") != Some(&serde_json::Value::Array(legend_value.clone())) {
        return Err(ApiError::conflict(
            "multilayer FDM legend descriptor entries disagree with its payload",
        ));
    }
    if required_positive_or_zero_u64(legend_descriptor, "entry_count", "legend descriptor")?
        != region_legend.len() as u64
    {
        return Err(ApiError::conflict(
            "multilayer FDM legend entry count disagrees with its payload",
        ));
    }
    let membership_revision = required_positive_u64(&payload, "revision", "membership payload")?;
    validate_revision_generation_agreement(
        mask_descriptor,
        &payload,
        membership_revision,
        "membership mask",
    )?;
    validate_revision_generation_agreement(
        legend_descriptor,
        &payload,
        membership_revision,
        "membership legend",
    )?;
    let active_mask = mask
        .iter()
        .map(|value| *value != u32::MAX)
        .collect::<Vec<_>>();
    let topology_tokens = mask
        .iter()
        .map(|value| if *value == u32::MAX { 0 } else { *value })
        .collect::<Vec<_>>();
    let computed_grid_fingerprint = format!(
        "sha256:{}",
        fullmag_ir::FdmGridCertificateIR::new_with_topology_tokens(
            origin_m,
            cells,
            cell_size_m,
            active_mask.iter().filter(|active| **active).count() as u64,
            1,
            Some(&active_mask),
            &topology_tokens,
        )
        .map_err(|error| ApiError::conflict(format!("invalid native layer grid: {error}")))?
        .grid_fingerprint
    );
    if computed_grid_fingerprint != grid_fingerprint {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{requested_layer_id}' native grid fingerprint is stale"
        )));
    }
    let membership_fingerprint = native_layer_membership_generation_id(
        &layer_id,
        &object_id,
        &grid_fingerprint,
        membership_revision,
        &mask_hash,
        &legend_hash,
    )?;
    if required_string(&payload, "generation_id", "membership payload")?
        != membership_fingerprint.as_str()
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{requested_layer_id}' membership generation is stale"
        )));
    }
    Ok(Some(FdmNativeLayerMembershipCarrier {
        layer_id: layer_id.to_string(),
        object_id: object_id.clone(),
        magnet_name,
        cells,
        origin_m,
        cell_size_m,
        grid_fingerprint: grid_fingerprint.to_string(),
        membership: FdmCellMembership {
            object_ids: vec![object_id],
            region_legend,
            cell_membership: mask,
        },
        membership_revision,
        membership_fingerprint,
        legend_fingerprint: legend_hash,
    }))
}

fn planned_native_layer<'a>(
    metadata: &'a serde_json::Value,
    requested_layer_id: &str,
) -> Result<Option<&'a serde_json::Value>, ApiError> {
    let Some(backend_plan) = metadata
        .get("execution_plan")
        .and_then(|plan| plan.get("backend_plan"))
        .filter(|plan| {
            plan.get("kind").and_then(serde_json::Value::as_str) == Some("fdm_multilayer")
        })
    else {
        return Ok(None);
    };
    let layers = backend_plan
        .get("layers")
        .and_then(serde_json::Value::as_array)
        .filter(|layers| !layers.is_empty())
        .ok_or_else(|| ApiError::conflict("multilayer FDM execution plan has no native layers"))?;
    let matching = layers
        .iter()
        .filter(|layer| {
            layer.get("layer_id").and_then(serde_json::Value::as_str) == Some(requested_layer_id)
        })
        .collect::<Vec<_>>();
    match matching.as_slice() {
        [] => Err(ApiError::not_found(format!(
            "layer_not_found: multilayer FDM layer '{requested_layer_id}' was not found"
        ))),
        [layer] => Ok(Some(*layer)),
        _ => Err(ApiError::conflict(format!(
            "ambiguous_layer_identity: multilayer FDM layer '{requested_layer_id}' is ambiguous"
        ))),
    }
}

fn planned_native_layer_membership(
    snapshot: &SessionStateResponse,
    layer: &serde_json::Value,
) -> Result<FdmNativeLayerMembershipCarrier, ApiError> {
    let layer_id = required_string(layer, "layer_id", "execution-plan layer")?.to_string();
    let object_id = required_string(layer, "object_id", "execution-plan layer")?.to_string();
    let magnet_name = required_string(layer, "magnet_name", "execution-plan layer")?.to_string();
    let cells = required_array3_u32(layer, "native_grid", &layer_id)?;
    let origin_m = required_array3_f64(layer, "native_origin", &layer_id, false)?;
    let cell_size_m = required_array3_f64(layer, "native_cell_size", &layer_id, true)?;
    let cell_count = grid_cell_count(cells, &layer_id)?;
    let raw_mask = strict_u32_values(layer, "native_region_mask", cell_count, &layer_id)?;
    let active_mask = layer
        .get("native_active_mask")
        .and_then(serde_json::Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(serde_json::Value::as_bool)
                .collect::<Option<Vec<_>>>()
                .filter(|mask| mask.len() == cell_count)
                .ok_or_else(|| {
                    ApiError::conflict(format!(
                        "layer '{layer_id}' native_active_mask is malformed"
                    ))
                })
        })
        .transpose()?
        .unwrap_or_else(|| vec![true; cell_count]);
    if raw_mask
        .iter()
        .zip(&active_mask)
        .any(|(region, active)| !active && *region != 0)
    {
        return Err(ApiError::conflict(format!(
            "layer '{layer_id}' assigns native membership outside its active mask"
        )));
    }
    let mask = raw_mask
        .iter()
        .zip(&active_mask)
        .map(|(region, active)| if *active { *region } else { u32::MAX })
        .collect::<Vec<_>>();
    let legend_value = layer
        .get("native_region_legend")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            ApiError::conflict(format!("layer '{layer_id}' has no native region legend"))
        })?;
    let region_legend = serde_json::from_value::<Vec<FdmRegionLegendEntryResource>>(
        serde_json::Value::Array(legend_value.clone()),
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "layer '{layer_id}' native region legend is malformed: {error}"
        ))
    })?;
    validate_region_legend(&region_legend, &mask, &object_id, &layer_id)?;
    let grid_fingerprint = format!(
        "sha256:{}",
        fullmag_ir::FdmGridCertificateIR::new_with_topology_tokens(
            origin_m,
            cells,
            cell_size_m,
            active_mask.iter().filter(|active| **active).count() as u64,
            1,
            Some(&active_mask),
            &raw_mask,
        )
        .map_err(|error| ApiError::conflict(format!("invalid native layer grid: {error}")))?
        .grid_fingerprint
    );
    let mask_hash = hash_u32_values(&mask);
    let legend_fingerprint = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(legend_value).map_err(|error| {
            ApiError::conflict(format!("failed to canonicalize multilayer legend: {error}"))
        })?)
    );
    let membership_revision = snapshot.region_realization_revisions.membership.max(1);
    let membership_fingerprint = native_layer_membership_generation_id(
        &layer_id,
        &object_id,
        &grid_fingerprint,
        membership_revision,
        &mask_hash,
        &legend_fingerprint,
    )?;
    Ok(FdmNativeLayerMembershipCarrier {
        layer_id,
        object_id: object_id.clone(),
        magnet_name,
        cells,
        origin_m,
        cell_size_m,
        grid_fingerprint,
        membership: FdmCellMembership {
            object_ids: vec![object_id],
            region_legend,
            cell_membership: mask,
        },
        membership_revision,
        membership_fingerprint,
        legend_fingerprint,
    })
}

pub(crate) fn native_layer_membership_generation_id(
    layer_id: &str,
    object_id: &str,
    grid_fingerprint: &str,
    revision: u64,
    mask_hash: &str,
    legend_hash: &str,
) -> Result<String, ApiError> {
    let identity = serde_json::json!({
        "schema_version": "fdm_multilayer_membership_generation.v1",
        "layer_id": layer_id,
        "object_id": object_id,
        "native_grid_fingerprint": grid_fingerprint,
        "revision": revision,
        "value_sha256": mask_hash,
        "legend_sha256": legend_hash,
    });
    let payload = serde_json::to_vec(&identity).map_err(|error| {
        ApiError::conflict(format!(
            "failed to canonicalize multilayer membership generation: {error}"
        ))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(payload)))
}

fn persisted_native_layer<'a>(
    snapshot: &'a SessionStateResponse,
    layer_id: &str,
) -> Result<Option<&'a serde_json::Value>, ApiError> {
    let Some(layout) = snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("artifact_layout"))
        .filter(|layout| {
            layout.get("backend").and_then(serde_json::Value::as_str) == Some("fdm_multilayer")
        })
    else {
        return Ok(None);
    };
    let layers = layout
        .get("layers")
        .and_then(serde_json::Value::as_array)
        .filter(|layers| !layers.is_empty())
        .ok_or_else(|| ApiError::conflict("multilayer FDM artifact layout has no native layers"))?;
    let matching = layers
        .iter()
        .filter(|layer| layer.get("layer_id").and_then(serde_json::Value::as_str) == Some(layer_id))
        .collect::<Vec<_>>();
    match matching.as_slice() {
        [layer] => Ok(Some(*layer)),
        [] => Err(ApiError::conflict(format!(
            "multilayer FDM artifact layout is missing planned layer '{layer_id}'"
        ))),
        _ => Err(ApiError::conflict(format!(
            "multilayer FDM artifact layout has ambiguous layer '{layer_id}'"
        ))),
    }
}

fn cross_check_planned_layer_identity(
    carrier: &FdmNativeLayerMembershipCarrier,
    artifact_layer: &serde_json::Value,
) -> Result<(), ApiError> {
    let layer_id = carrier.layer_id.as_str();
    let identity_matches = required_string(artifact_layer, "layer_id", "layer descriptor")?
        == layer_id
        && required_string(artifact_layer, "object_id", "layer descriptor")? == carrier.object_id
        && required_string(artifact_layer, "magnet_name", "layer descriptor")?
            == carrier.magnet_name
        && required_array3_u32(artifact_layer, "native_grid", layer_id)? == carrier.cells
        && required_array3_f64(artifact_layer, "native_origin", layer_id, false)?
            == carrier.origin_m
        && required_array3_f64(artifact_layer, "native_cell_size", layer_id, true)?
            == carrier.cell_size_m;
    if !identity_matches {
        return Err(ApiError::conflict(format!(
            "multilayer FDM planned layer '{layer_id}' disagrees with its artifact layout"
        )));
    }
    if let Some(fingerprint) = artifact_layer
        .get("native_grid_fingerprint")
        .and_then(serde_json::Value::as_str)
    {
        if fingerprint != carrier.grid_fingerprint {
            return Err(ApiError::conflict(format!(
                "multilayer FDM planned layer '{layer_id}' grid fingerprint disagrees with its artifact layout"
            )));
        }
    }
    Ok(())
}

fn cross_check_planned_membership(
    snapshot: &SessionStateResponse,
    carrier: &FdmNativeLayerMembershipCarrier,
) -> Result<(), ApiError> {
    let Some(artifact_layer) = persisted_native_layer(snapshot, &carrier.layer_id)? else {
        return Ok(());
    };
    cross_check_planned_layer_identity(carrier, artifact_layer)?;
    let mask_descriptor = artifact_layer
        .get("native_region_mask")
        .filter(|descriptor| {
            descriptor
                .get("available")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        });
    let legend_descriptor = artifact_layer
        .get("native_region_legend")
        .filter(|descriptor| {
            descriptor
                .get("available")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        });
    let (Some(mask_descriptor), Some(legend_descriptor)) = (mask_descriptor, legend_descriptor)
    else {
        if mask_descriptor.is_some() || legend_descriptor.is_some() {
            return Err(ApiError::conflict(format!(
                "multilayer FDM layer '{}' has incomplete persisted membership descriptors",
                carrier.layer_id
            )));
        }
        return Ok(());
    };
    let membership_path =
        required_string(mask_descriptor, "artifact_path", "membership descriptor")?;
    if required_string(legend_descriptor, "artifact_path", "legend descriptor")? != membership_path
    {
        return Err(ApiError::conflict(
            "multilayer FDM membership mask and legend refer to different artifacts",
        ));
    }
    let artifact_dir = current_artifact_dir(snapshot).ok_or_else(|| {
        ApiError::conflict("declared native multilayer membership has no artifact root")
    })?;
    let payload = read_json_artifact_value(&artifact_dir, membership_path).map_err(|_| {
        ApiError::conflict(format!(
            "declared native membership artifact is missing or corrupt for layer '{}'",
            carrier.layer_id
        ))
    })?;
    validate_layer_payload_identity(
        &payload,
        "fdm_multilayer_region_membership.v1",
        &carrier.layer_id,
        &carrier.object_id,
        &carrier.magnet_name,
        carrier.cells,
        carrier.origin_m,
        carrier.cell_size_m,
        &carrier.grid_fingerprint,
    )?;
    let mask = strict_u32_values(
        &payload,
        "native_region_mask",
        carrier.membership.cell_membership.len(),
        &carrier.layer_id,
    )?;
    let mask_hash = hash_u32_values(&mask);
    validate_content_descriptor(
        mask_descriptor,
        &payload,
        mask.len(),
        "value_sha256",
        &mask_hash,
        "membership mask",
    )?;
    let legend_value = payload
        .get("native_region_legend")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ApiError::conflict("multilayer FDM membership legend is malformed"))?;
    let legend = serde_json::from_value::<Vec<FdmRegionLegendEntryResource>>(
        serde_json::Value::Array(legend_value.clone()),
    )
    .map_err(|error| {
        ApiError::conflict(format!(
            "multilayer FDM membership legend is malformed: {error}"
        ))
    })?;
    let legend_hash = format!(
        "sha256:{:x}",
        Sha256::digest(serde_json::to_vec(legend_value).map_err(|error| {
            ApiError::conflict(format!("failed to canonicalize multilayer legend: {error}"))
        })?)
    );
    validate_hash_agreement(
        legend_descriptor,
        &payload,
        "legend_sha256",
        &legend_hash,
        "membership legend",
    )?;
    let entry_count =
        required_positive_or_zero_u64(legend_descriptor, "entry_count", "legend descriptor")?;
    if legend_descriptor.get("entries") != Some(&serde_json::Value::Array(legend_value.clone()))
        || mask != carrier.membership.cell_membership
        || legend != carrier.membership.region_legend
        || legend_hash != carrier.legend_fingerprint
        || entry_count != legend.len() as u64
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM planned membership disagrees with persisted carrier for layer '{}'",
            carrier.layer_id
        )));
    }
    Ok(())
}

fn cross_check_planned_material(
    snapshot: &SessionStateResponse,
    carrier: &FdmNativeLayerMembershipCarrier,
    quantity_id: &str,
    unit: &str,
    planned_values: &[f64],
) -> Result<(), ApiError> {
    let Some(artifact_layer) = persisted_native_layer(snapshot, &carrier.layer_id)? else {
        return Ok(());
    };
    let Some(descriptor) = artifact_layer
        .get("material_fields")
        .and_then(|fields| fields.get(quantity_id))
        .filter(|descriptor| {
            descriptor
                .get("available")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        })
    else {
        return Ok(());
    };
    let artifact_dir = current_artifact_dir(snapshot).ok_or_else(|| {
        ApiError::conflict(format!(
            "declared multilayer material field '{quantity_id}' has no artifact root"
        ))
    })?;
    let material_path = required_string(descriptor, "artifact_path", "material descriptor")?;
    let payload = read_json_artifact_value(&artifact_dir, material_path).map_err(|_| {
        ApiError::conflict(format!(
            "declared multilayer material field '{quantity_id}' artifact is missing or corrupt for layer '{}'",
            carrier.layer_id
        ))
    })?;
    validate_layer_payload_identity(
        &payload,
        "fdm_multilayer_material_field.v1",
        &carrier.layer_id,
        &carrier.object_id,
        &carrier.magnet_name,
        carrier.cells,
        carrier.origin_m,
        carrier.cell_size_m,
        &carrier.grid_fingerprint,
    )?;
    if required_string(&payload, "field_id", "material payload")? != quantity_id
        || required_string(descriptor, "unit", "material descriptor")? != unit
        || required_string(&payload, "unit", "material payload")? != unit
    {
        return Err(ApiError::conflict(format!(
            "multilayer material field '{quantity_id}' unit or identity is inconsistent"
        )));
    }
    let values = strict_finite_values(&payload, "values", planned_values.len(), quantity_id)?;
    let value_hash = hash_f64_values(&values);
    validate_content_descriptor(
        descriptor,
        &payload,
        values.len(),
        "value_sha256",
        &value_hash,
        "material field",
    )?;
    if values != planned_values {
        return Err(ApiError::conflict(format!(
            "multilayer material field '{quantity_id}' plan and persisted payload disagree"
        )));
    }
    Ok(())
}

fn resolve_planned_native_layer_field(
    snapshot: &SessionStateResponse,
    layer: &serde_json::Value,
    quantity_id: &str,
    component_count: usize,
) -> Result<ResolvedSpatialField<'static>, ApiError> {
    let membership = planned_native_layer_membership(snapshot, layer)?;
    cross_check_planned_membership(snapshot, &membership)?;
    let spec = quantity_spec(quantity_id).ok_or_else(|| {
        ApiError::not_found(format!(
            "quantity_unavailable: quantity '{quantity_id}' is unknown"
        ))
    })?;
    if component_count != 1 || usize::from(spec.n_comp) != component_count {
        return Err(ApiError::conflict(format!(
            "multilayer material field '{quantity_id}' has an invalid component contract"
        )));
    }
    let material_key = match quantity_id {
        "mat_ms" => "ms_field",
        "mat_aex" => "a_field",
        "mat_alpha" => "alpha_field",
        _ => {
            return Err(ApiError::not_found(format!(
            "quantity_not_materialized: field '{quantity_id}' has no native array for layer '{}'",
            membership.layer_id
        )))
        }
    };
    let material = layer.get("material").ok_or_else(|| {
        ApiError::conflict(format!(
            "layer '{}' has no material contract",
            membership.layer_id
        ))
    })?;
    if material.get(material_key).is_none() {
        return Err(ApiError::not_found(format!(
            "quantity_not_materialized: field '{quantity_id}' has no native array for layer '{}'",
            membership.layer_id
        )));
    }
    let values = strict_finite_values(
        material,
        material_key,
        membership.membership.cell_membership.len(),
        quantity_id,
    )?;
    cross_check_planned_material(snapshot, &membership, quantity_id, spec.unit, &values)?;
    let value_hash = hash_f64_values(&values);
    let field_generation = format!(
        "sha256:{:x}",
        Sha256::digest(format!(
            "{}:{}:{}",
            membership.layer_id, membership.grid_fingerprint, value_hash
        ))
    );
    let quantity_revision = snapshot
        .field_quantity_revisions
        .get(quantity_id)
        .copied()
        .unwrap_or(snapshot.field_samples_revision)
        .max(1);
    let carrier_fingerprint = format!(
        "sha256:{:x}",
        Sha256::digest(format!(
            "{}:{}:{}:{}:{}:{}:{}:{}",
            membership.layer_id,
            membership.object_id,
            membership.magnet_name,
            membership.grid_fingerprint,
            membership.membership_fingerprint,
            field_generation,
            value_hash,
            quantity_revision
        ))
    );
    let carrier_revision = sha256_revision(&carrier_fingerprint)?;
    let field = ResolvedSpatialField {
        quantity_id: quantity_id.to_string(),
        quantity_kind: spec.shape,
        canonical_unit: spec.unit.to_string(),
        component_count,
        default_component: spec.default_component,
        source_kind: SpatialFieldSourceKind::Materialized,
        provenance: SpatialFieldProvenance {
            backend: snapshot.session.resolved_backend.clone(),
            device: snapshot.session.resolved_device.clone(),
            precision: snapshot.session.resolved_precision.clone(),
        },
        field_generation: Some(field_generation),
        quantity_revision,
        mesh_or_grid_revision: carrier_revision,
        source_grid: Some(membership.cells),
        values,
        carrier: SpatialFieldCarrier::FdmNativeLayerCells {
            layer_id: membership.layer_id,
            object_id: membership.object_id,
            magnet_name: membership.magnet_name,
            cells: membership.cells,
            origin_m: membership.origin_m,
            cell_size_m: membership.cell_size_m,
            grid_fingerprint: membership.grid_fingerprint,
            membership: membership.membership,
            membership_revision: membership.membership_revision,
            membership_fingerprint: membership.membership_fingerprint,
            carrier_fingerprint,
        },
    };
    field.validate_contract()?;
    Ok(field)
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

fn required_string<'a>(
    value: &'a serde_json::Value,
    key: &str,
    context: &str,
) -> Result<&'a str, ApiError> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::conflict(format!("{context} has no valid {key}")))
}

fn required_array3_u32(
    value: &serde_json::Value,
    key: &str,
    layer_id: &str,
) -> Result<[u32; 3], ApiError> {
    let values = value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .filter(|values| values.len() == 3)
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' has no valid {key}"
            ))
        })?;
    let parsed = values
        .iter()
        .map(|value| value.as_u64().and_then(|value| u32::try_from(value).ok()))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' has no valid {key}"
            ))
        })?;
    let result = [parsed[0], parsed[1], parsed[2]];
    if result.contains(&0) {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' {key} must be positive"
        )));
    }
    Ok(result)
}

fn required_array3_f64(
    value: &serde_json::Value,
    key: &str,
    layer_id: &str,
    positive: bool,
) -> Result<[f64; 3], ApiError> {
    let values = value
        .get(key)
        .and_then(serde_json::Value::as_array)
        .filter(|values| values.len() == 3)
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' has no valid {key}"
            ))
        })?;
    let parsed = values
        .iter()
        .map(serde_json::Value::as_f64)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' has no valid {key}"
            ))
        })?;
    let result = [parsed[0], parsed[1], parsed[2]];
    if result
        .iter()
        .any(|entry| !entry.is_finite() || (positive && *entry <= 0.0))
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' has no valid {key}"
        )));
    }
    Ok(result)
}

fn grid_cell_count(cells: [u32; 3], layer_id: &str) -> Result<usize, ApiError> {
    cells
        .into_iter()
        .try_fold(1usize, |count, axis| {
            usize::try_from(axis).ok()?.checked_mul(count)
        })
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' native grid cell count overflows usize"
            ))
        })
}

#[allow(clippy::too_many_arguments)]
fn validate_layer_payload_identity(
    payload: &serde_json::Value,
    schema_version: &str,
    layer_id: &str,
    object_id: &str,
    magnet_name: &str,
    cells: [u32; 3],
    origin_m: [f64; 3],
    cell_size_m: [f64; 3],
    grid_fingerprint: &str,
) -> Result<(), ApiError> {
    let matches = required_string(payload, "schema_version", "native layer payload")?
        == schema_version
        && required_string(payload, "layer_id", "native layer payload")? == layer_id
        && required_string(payload, "object_id", "native layer payload")? == object_id
        && required_string(payload, "magnet_name", "native layer payload")? == magnet_name
        && required_array3_u32(payload, "native_grid", layer_id)? == cells
        && required_array3_f64(payload, "native_origin", layer_id, false)? == origin_m
        && required_array3_f64(payload, "native_cell_size", layer_id, true)? == cell_size_m
        && required_string(payload, "native_grid_fingerprint", "native layer payload")?
            == grid_fingerprint;
    if !matches {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' payload identity or native geometry is stale"
        )));
    }
    Ok(())
}

fn strict_finite_values(
    payload: &serde_json::Value,
    key: &str,
    expected_count: usize,
    quantity_id: &str,
) -> Result<Vec<f64>, ApiError> {
    let values = payload
        .get(key)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer material field '{quantity_id}' values are missing"
            ))
        })?
        .iter()
        .map(serde_json::Value::as_f64)
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| {
            ApiError::conflict(format!(
                "multilayer material field '{quantity_id}' values are malformed"
            ))
        })?;
    if values.len() != expected_count || values.iter().any(|value| !value.is_finite()) {
        return Err(ApiError::conflict(format!(
            "multilayer material field '{quantity_id}' values disagree with its native grid"
        )));
    }
    Ok(values)
}

fn strict_u32_values(
    payload: &serde_json::Value,
    key: &str,
    expected_count: usize,
    layer_id: &str,
) -> Result<Vec<u32>, ApiError> {
    let values = payload
        .get(key)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| ApiError::conflict(format!("layer '{layer_id}' {key} is missing")))?
        .iter()
        .map(|value| value.as_u64().and_then(|value| u32::try_from(value).ok()))
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| ApiError::conflict(format!("layer '{layer_id}' {key} is malformed")))?;
    if values.len() != expected_count {
        return Err(ApiError::conflict(format!(
            "layer '{layer_id}' {key} length disagrees with its native grid"
        )));
    }
    Ok(values)
}

fn required_positive_u64(
    value: &serde_json::Value,
    key: &str,
    context: &str,
) -> Result<u64, ApiError> {
    value
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| ApiError::conflict(format!("{context} has no valid {key}")))
}

fn required_positive_or_zero_u64(
    value: &serde_json::Value,
    key: &str,
    context: &str,
) -> Result<u64, ApiError> {
    value
        .get(key)
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| ApiError::conflict(format!("{context} has no valid {key}")))
}

fn validate_content_descriptor(
    descriptor: &serde_json::Value,
    payload: &serde_json::Value,
    expected_count: usize,
    hash_key: &str,
    actual_hash: &str,
    context: &str,
) -> Result<(), ApiError> {
    let descriptor_count = required_positive_or_zero_u64(descriptor, "value_count", context)?;
    let payload_count = required_positive_or_zero_u64(payload, "value_count", context)?;
    if descriptor_count != expected_count as u64 || payload_count != expected_count as u64 {
        return Err(ApiError::conflict(format!(
            "multilayer FDM {context} count disagrees with its native grid"
        )));
    }
    validate_hash_agreement(descriptor, payload, hash_key, actual_hash, context)?;
    let revision = required_positive_u64(payload, "revision", context)?;
    validate_revision_generation_agreement(descriptor, payload, revision, context)
}

fn validate_hash_agreement(
    descriptor: &serde_json::Value,
    payload: &serde_json::Value,
    key: &str,
    actual: &str,
    context: &str,
) -> Result<(), ApiError> {
    let descriptor_hash = required_string(descriptor, key, context)?;
    let payload_hash = required_string(payload, key, context)?;
    if !canonical_sha256(descriptor_hash)
        || descriptor_hash != payload_hash
        || descriptor_hash != actual
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM {context} hash disagrees with its payload"
        )));
    }
    Ok(())
}

fn validate_revision_generation_agreement(
    descriptor: &serde_json::Value,
    payload: &serde_json::Value,
    revision: u64,
    context: &str,
) -> Result<(), ApiError> {
    let descriptor_revision = required_positive_u64(descriptor, "revision", context)?;
    let descriptor_generation = required_string(descriptor, "generation_id", context)?;
    let payload_generation = required_string(payload, "generation_id", context)?;
    if descriptor_revision != revision
        || !canonical_sha256(descriptor_generation)
        || descriptor_generation != payload_generation
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM {context} revision or generation is stale"
        )));
    }
    Ok(())
}

fn validate_region_legend(
    legend: &[FdmRegionLegendEntryResource],
    mask: &[u32],
    object_id: &str,
    layer_id: &str,
) -> Result<(), ApiError> {
    let mut numeric_ids = BTreeSet::new();
    let mut identities = BTreeSet::new();
    for entry in legend {
        if entry.numeric_id == 0
            || entry.numeric_id == u32::MAX
            || entry.object_id != object_id
            || entry.region_id.is_empty()
            || !numeric_ids.insert(entry.numeric_id)
            || !identities.insert((entry.object_id.as_str(), entry.region_id.as_str()))
        {
            return Err(ApiError::conflict(format!(
                "multilayer FDM layer '{layer_id}' has an invalid native region legend"
            )));
        }
    }
    if mask
        .iter()
        .any(|value| *value != 0 && *value != u32::MAX && !numeric_ids.contains(value))
    {
        return Err(ApiError::conflict(format!(
            "multilayer FDM layer '{layer_id}' region mask references an unknown legend id"
        )));
    }
    Ok(())
}

fn hash_f64_values(values: &[f64]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.to_le_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn hash_u32_values(values: &[u32]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.to_le_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn canonical_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn sha256_revision(value: &str) -> Result<u64, ApiError> {
    if !canonical_sha256(value) {
        return Err(ApiError::conflict("invalid canonical carrier fingerprint"));
    }
    let hash = value
        .strip_prefix("sha256:")
        .ok_or_else(|| ApiError::conflict("invalid canonical carrier fingerprint"))?;
    let bytes = (0..16)
        .step_by(2)
        .map(|index| u8::from_str_radix(&hash[index..index + 2], 16).ok())
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| ApiError::conflict("invalid canonical carrier fingerprint"))?;
    let revision = u64::from_be_bytes(bytes.try_into().expect("eight parsed hash bytes"));
    Ok(revision.max(1))
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
                .filter(|revision| *revision > 0)
                .or_else(|| {
                    snapshot
                        .live_state
                        .as_ref()
                        .map(|state| state.latest_step.step)
                })
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
            QuantityLocation::Cell
                if fem_nodal_visualization_projection_allowed(
                    snapshot,
                    quantity_id,
                    point_count,
                ) => SpatialFieldCarrier::FemNodes {
                topology: mesh,
                topology_fingerprint,
                mapping: EntityMapping::Identity {
                    entity_count: point_count,
                },
            },
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
