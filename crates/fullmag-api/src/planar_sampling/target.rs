use std::collections::BTreeSet;

use fullmag_ir::{
    MonitorTargetIR, PlanarExtentIR, PlanarFrameIR, PlanarOperatorIR, SurfaceBoundarySelectorIR,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::router_v2::handlers::data::resolved_spatial_field::{
    resolve_fdm_object_indices, EntityMapping, ResolvedSpatialField, SpatialFieldCarrier,
};

use super::{
    FdmPlanarField, FemPlanarField, PlanarSampleResult, PlanarSamplingEngine,
    ResolvedPlanarSampleRequest,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ResolvedSpatialScope {
    MonitorTarget,
    MeshPart { scope_id: String },
    Airbox { scope_id: Option<String> },
}

#[derive(Debug, Clone)]
enum TargetField {
    Fdm(FdmPlanarField),
    Fem(FemPlanarField),
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedSpatialTarget {
    field: TargetField,
    selected_entity_ids: Vec<u32>,
    target_bounds_world_m: [[f64; 3]; 2],
    magnetic_bounds_world_m: Option<[[f64; 3]; 2]>,
    universe_bounds_world_m: [[f64; 3]; 2],
    fingerprint: String,
    target_kind: &'static str,
    target_id: Option<String>,
    source_entity_kind: &'static str,
}

impl ResolvedSpatialTarget {
    pub(crate) fn selected_entity_ids(&self) -> &[u32] {
        &self.selected_entity_ids
    }

    #[cfg(test)]
    pub(crate) fn bounds_world_m(&self) -> [[f64; 3]; 2] {
        self.target_bounds_world_m
    }

    pub(crate) fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub(crate) fn target_kind(&self) -> &'static str {
        self.target_kind
    }

    pub(crate) fn target_id(&self) -> Option<&str> {
        self.target_id.as_deref()
    }

    pub(crate) fn source_entity_kind(&self) -> &'static str {
        self.source_entity_kind
    }

    pub(crate) fn resolve_dynamic_extent(&self, frame: &mut PlanarFrameIR) -> Result<(), ApiError> {
        let (bounds, padding_m) = match frame.extent {
            PlanarExtentIR::Explicit { .. } => return Ok(()),
            PlanarExtentIR::TargetBounds { padding_m } => (self.target_bounds_world_m, padding_m),
            PlanarExtentIR::MagneticDomain { padding_m } => {
                let bounds = self.magnetic_bounds_world_m.ok_or_else(|| {
                    ApiError::unprocessable(
                        "planar_extent_empty: resolved carrier has no magnetic-domain bounds",
                    )
                })?;
                (bounds, padding_m)
            }
            PlanarExtentIR::Universe { padding_m } => (self.universe_bounds_world_m, padding_m),
        };
        if !padding_m.is_finite() || padding_m < 0.0 {
            return Err(ApiError::bad_request(
                "invalid_planar_extent: padding must be finite and non-negative",
            ));
        }
        let mut projected = [
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ];
        for z in [bounds[0][2], bounds[1][2]] {
            for y in [bounds[0][1], bounds[1][1]] {
                for x in [bounds[0][0], bounds[1][0]] {
                    let delta = [
                        x - frame.origin_m[0],
                        y - frame.origin_m[1],
                        z - frame.origin_m[2],
                    ];
                    let u = dot(delta, frame.u_axis);
                    let v = dot(delta, frame.v_axis);
                    projected[0] = projected[0].min(u);
                    projected[1] = projected[1].max(u);
                    projected[2] = projected[2].min(v);
                    projected[3] = projected[3].max(v);
                }
            }
        }
        frame.extent = PlanarExtentIR::Explicit {
            u_min_m: projected[0] - padding_m,
            u_max_m: projected[1] + padding_m,
            v_min_m: projected[2] - padding_m,
            v_max_m: projected[3] + padding_m,
        };
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn refine_uniform_p1_for_test(&self) -> Self {
        let field = match &self.field {
            TargetField::Fem(field) => TargetField::Fem(field.refine_uniform_p1()),
            TargetField::Fdm(field) => TargetField::Fdm(field.clone()),
        };
        Self {
            field,
            selected_entity_ids: self.selected_entity_ids.clone(),
            target_bounds_world_m: self.target_bounds_world_m,
            magnetic_bounds_world_m: self.magnetic_bounds_world_m,
            universe_bounds_world_m: self.universe_bounds_world_m,
            fingerprint: format!("{}:refined", self.fingerprint),
            target_kind: self.target_kind,
            target_id: self.target_id.clone(),
            source_entity_kind: self.source_entity_kind,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct PlanarSampleIdentity {
    pub session_id: String,
    pub monitor_id: String,
    pub monitor_revision: u64,
    pub monitor_hash: String,
    pub scene_revision: u64,
    pub target_fingerprint: String,
    pub target_kind: String,
    pub target_id: Option<String>,
    pub target_entity_count: usize,
    pub scope_kind: String,
    pub scope_id: Option<String>,
    pub quantity_id: String,
    pub component: String,
    pub quantity_revision: u64,
    pub field_generation: Option<String>,
    pub field_content_fingerprint: Option<String>,
    pub carrier_revision: u64,
    pub source_kind: String,
    pub source_backend: Option<String>,
    pub source_device: Option<String>,
    pub source_precision: Option<String>,
    pub frame: PlanarFrameIR,
    pub operator: PlanarOperatorIR,
    pub resolution: [u32; 2],
    pub quality: String,
}

impl PlanarSampleIdentity {
    pub(crate) fn cache_key(&self) -> String {
        let bytes = serde_json::to_vec(self).expect("planar sample identity is serializable");
        format!("planar-sample-v2:{:x}", Sha256::digest(bytes))
    }
}

pub(crate) fn sample_resolved_target(
    target: &ResolvedSpatialTarget,
    request: &ResolvedPlanarSampleRequest,
) -> Result<PlanarSampleResult, ApiError> {
    match &target.field {
        TargetField::Fdm(field) => PlanarSamplingEngine::sample_fdm(field, request),
        TargetField::Fem(field) => PlanarSamplingEngine::sample_fem(field, request),
    }
}

pub(crate) fn resolve_spatial_target(
    field: &ResolvedSpatialField<'_>,
    target: &MonitorTargetIR,
    scope: ResolvedSpatialScope,
    operator: &PlanarOperatorIR,
) -> Result<ResolvedSpatialTarget, ApiError> {
    field.validate_contract()?;
    match &field.carrier {
        SpatialFieldCarrier::FdmCells {
            cells,
            origin_m,
            cell_size_m,
            grid_fingerprint,
            membership,
            ..
        } => {
            if matches!(operator, PlanarOperatorIR::SurfaceProjection { .. }) {
                return Err(ApiError::unprocessable(
                    "unsupported_planar_surface: FDM boundary topology is not published",
                ));
            }
            if !matches!(scope, ResolvedSpatialScope::MonitorTarget) {
                return Err(ApiError::unprocessable(
                    "planar_scope_unsupported: FDM cell fields are not an airbox carrier and support monitor_target only",
                ));
            }
            let origin = origin_m.ok_or_else(|| {
                ApiError::conflict("missing_fdm_geometry: exact grid origin is unavailable")
            })?;
            let spacing = cell_size_m.ok_or_else(|| {
                ApiError::conflict("missing_fdm_geometry: exact cell size is unavailable")
            })?;
            let selected = select_fdm_target(*cells, membership.as_ref(), target)?;
            let carrier_identity = grid_fingerprint
                .clone()
                .unwrap_or_else(|| format!("fdm:{cells:?}:{origin:?}:{spacing:?}"));
            build_fdm_target(
                field,
                *cells,
                origin,
                spacing,
                selected,
                &carrier_identity,
                target,
                membership.as_ref(),
            )
        }
        SpatialFieldCarrier::FdmAirboxCells {
            cells,
            origin_m,
            cell_size_m,
            carrier_fingerprint,
            ..
        } => {
            if matches!(operator, PlanarOperatorIR::SurfaceProjection { .. }) {
                return Err(ApiError::unprocessable(
                    "unsupported_planar_surface: FDM Airbox boundary topology is not published",
                ));
            }
            if !matches!(scope, ResolvedSpatialScope::Airbox { scope_id: None }) {
                return Err(ApiError::unprocessable(
                    "planar_scope_unsupported: Airbox carrier requires exact airbox scope",
                ));
            }
            if !matches!(target, MonitorTargetIR::Domain) {
                return Err(ApiError::unprocessable(
                    "planar_scope_empty: Airbox carrier is legal only for a domain monitor target",
                ));
            }
            let selected = vec![true; cell_count(*cells)?];
            build_fdm_target(
                field,
                *cells,
                *origin_m,
                *cell_size_m,
                selected,
                carrier_fingerprint,
                target,
                None,
            )
        }
        SpatialFieldCarrier::FemNodes {
            topology,
            topology_fingerprint,
            mapping,
        } => build_fem_target(
            field,
            topology,
            topology_fingerprint,
            mapping,
            target,
            &scope,
            operator,
        ),
        SpatialFieldCarrier::FemElements { .. } => Err(ApiError::unprocessable(
            "unsupported_fem_carrier: planar sampling requires P1 nodal values",
        )),
        SpatialFieldCarrier::ArtifactLinear { .. } => Err(ApiError::unprocessable(
            "unsupported_artifact_carrier: linear artifacts have no exact spatial coordinates",
        )),
    }
}

fn build_fdm_target(
    resolved: &ResolvedSpatialField<'_>,
    cells: [u32; 3],
    origin: [f64; 3],
    spacing: [f64; 3],
    selected: Vec<bool>,
    carrier_fingerprint: &str,
    target: &MonitorTargetIR,
    membership: Option<
        &crate::router_v2::handlers::data::resolved_spatial_field::FdmCellMembership,
    >,
) -> Result<ResolvedSpatialTarget, ApiError> {
    let selected_entity_ids = selected
        .iter()
        .enumerate()
        .filter_map(|(index, selected)| selected.then_some(index as u32))
        .collect::<Vec<_>>();
    if selected_entity_ids.is_empty() {
        return Err(ApiError::unprocessable(
            "planar_scope_empty: resolved FDM target has no cells",
        ));
    }
    let target_bounds = fdm_bounds(cells, origin, spacing, &selected)?;
    let universe = vec![true; selected.len()];
    let magnetic = membership
        .map(|membership| {
            membership
                .cell_membership
                .iter()
                .map(|id| *id != u32::MAX)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| universe.clone());
    let source = FdmPlanarField::new(
        resolved.component_count,
        cells,
        origin,
        spacing,
        resolved.values.clone(),
    )?
    .with_membership_mask(selected)?;
    Ok(ResolvedSpatialTarget {
        field: TargetField::Fdm(source),
        selected_entity_ids: selected_entity_ids.clone(),
        target_bounds_world_m: target_bounds,
        magnetic_bounds_world_m: optional_fdm_bounds(cells, origin, spacing, &magnetic)?,
        universe_bounds_world_m: fdm_bounds(cells, origin, spacing, &universe)?,
        fingerprint: target_fingerprint(
            carrier_fingerprint,
            resolved.mesh_or_grid_revision,
            &selected_entity_ids,
            target,
        ),
        target_kind: monitor_target_kind(target),
        target_id: monitor_target_id(target),
        source_entity_kind: "cell",
    })
}

fn select_fdm_target(
    cells: [u32; 3],
    membership: Option<
        &crate::router_v2::handlers::data::resolved_spatial_field::FdmCellMembership,
    >,
    target: &MonitorTargetIR,
) -> Result<Vec<bool>, ApiError> {
    let count = cell_count(cells)?;
    match target {
        MonitorTargetIR::Domain => Ok(vec![true; count]),
        MonitorTargetIR::MagneticDomain => {
            let membership = require_fdm_membership(membership, count)?;
            Ok(membership
                .cell_membership
                .iter()
                .map(|id| *id != u32::MAX)
                .collect())
        }
        MonitorTargetIR::Object { object_id } => {
            let membership = require_fdm_membership(membership, count)?;
            let indices = resolve_fdm_object_indices(membership, object_id)?;
            Ok(mask_from_indices(count, indices))
        }
        MonitorTargetIR::Region {
            object_id,
            region_id,
        } => {
            let membership = require_fdm_membership(membership, count)?;
            let numeric_ids = membership
                .region_legend
                .iter()
                .filter(|entry| entry.object_id == *object_id && entry.region_id == *region_id)
                .map(|entry| entry.numeric_id)
                .collect::<BTreeSet<_>>();
            if numeric_ids.is_empty() {
                return Err(ApiError::not_found(format!(
                    "FDM region membership not found: {object_id}/{region_id}"
                )));
            }
            Ok(membership
                .cell_membership
                .iter()
                .map(|id| numeric_ids.contains(id))
                .collect())
        }
    }
}

fn require_fdm_membership(
    membership: Option<
        &crate::router_v2::handlers::data::resolved_spatial_field::FdmCellMembership,
    >,
    count: usize,
) -> Result<&crate::router_v2::handlers::data::resolved_spatial_field::FdmCellMembership, ApiError>
{
    let membership = membership.ok_or_else(|| {
        ApiError::conflict("missing_fdm_membership: target cannot be resolved exactly")
    })?;
    if membership.cell_membership.len() != count {
        return Err(ApiError::conflict(
            "stale_fdm_membership: membership length differs from field carrier",
        ));
    }
    Ok(membership)
}

fn build_fem_target(
    resolved: &ResolvedSpatialField<'_>,
    mesh: &fullmag_runner::FemMeshPayload,
    topology_fingerprint: &str,
    mapping: &EntityMapping,
    target: &MonitorTargetIR,
    scope: &ResolvedSpatialScope,
    operator: &PlanarOperatorIR,
) -> Result<ResolvedSpatialTarget, ApiError> {
    if let PlanarOperatorIR::SurfaceProjection { boundary, .. } = operator {
        if !matches!(boundary, SurfaceBoundarySelectorIR::ObjectBoundary) {
            return Err(ApiError::unprocessable(
                "unsupported_planar_surface: only object_boundary is published for FEM",
            ));
        }
    }
    let elements = mesh.require_tet4_elements().map_err(|error| {
        ApiError::unprocessable(format!(
            "unsupported_fem_element_order_or_carrier: tet4 P1 nodal carrier required: {error}"
        ))
    })?;
    let mut selected = select_fem_monitor_target(mesh, &elements, target);
    match scope {
        ResolvedSpatialScope::MonitorTarget => {}
        ResolvedSpatialScope::MeshPart { scope_id } => {
            let runtime = select_fem_parts(mesh, elements.len(), |part| part.id == *scope_id);
            intersect_masks(&mut selected, &runtime);
        }
        ResolvedSpatialScope::Airbox { scope_id } => {
            if scope_id.as_deref().is_some_and(|id| id != "airbox") {
                return Err(ApiError::not_found("FEM Airbox scope not found"));
            }
            let runtime = select_fem_parts(mesh, elements.len(), |part| {
                part.role.contains("air") || part.id.contains("airbox")
            });
            intersect_masks(&mut selected, &runtime);
        }
    }
    let selected_entity_ids = selected
        .iter()
        .enumerate()
        .filter_map(|(index, selected)| selected.then_some(index as u32))
        .collect::<Vec<_>>();
    if selected_entity_ids.is_empty() {
        return Err(ApiError::unprocessable(
            "planar_scope_empty: resolved FEM target has no elements",
        ));
    }
    let values = expand_fem_values(resolved, mapping, mesh.nodes.len(), &elements, &selected)?;
    let source = FemPlanarField::new(
        resolved.component_count,
        mesh.nodes.clone(),
        elements.clone(),
        selected.iter().map(|value| u32::from(*value)).collect(),
        values,
    )?;
    let magnetic = mesh
        .element_markers
        .iter()
        .map(|marker| *marker != 0)
        .collect::<Vec<_>>();
    let universe = vec![true; elements.len()];
    Ok(ResolvedSpatialTarget {
        field: TargetField::Fem(source),
        selected_entity_ids: selected_entity_ids.clone(),
        target_bounds_world_m: fem_bounds(&mesh.nodes, &elements, &selected)?,
        magnetic_bounds_world_m: optional_fem_bounds(&mesh.nodes, &elements, &magnetic)?,
        universe_bounds_world_m: fem_bounds(&mesh.nodes, &elements, &universe)?,
        fingerprint: target_fingerprint(
            &fem_carrier_identity(topology_fingerprint, mapping),
            resolved.mesh_or_grid_revision,
            &selected_entity_ids,
            target,
        ),
        target_kind: monitor_target_kind(target),
        target_id: monitor_target_id(target),
        source_entity_kind: "element",
    })
}

fn select_fem_monitor_target(
    mesh: &fullmag_runner::FemMeshPayload,
    elements: &[[u32; 4]],
    target: &MonitorTargetIR,
) -> Vec<bool> {
    match target {
        MonitorTargetIR::Domain => vec![true; elements.len()],
        MonitorTargetIR::MagneticDomain => mesh
            .element_markers
            .iter()
            .map(|marker| *marker != 0)
            .collect(),
        MonitorTargetIR::Object { object_id } => select_fem_parts(mesh, elements.len(), |part| {
            part.object_id.as_deref() == Some(object_id.as_str())
        }),
        MonitorTargetIR::Region {
            object_id,
            region_id,
        } => select_fem_parts(mesh, elements.len(), |part| {
            part.object_id.as_deref() == Some(object_id.as_str())
                && (part.id == *region_id
                    || part.geometry_id.as_deref() == Some(region_id.as_str()))
        }),
    }
}

fn select_fem_parts(
    mesh: &fullmag_runner::FemMeshPayload,
    element_count: usize,
    predicate: impl Fn(&fullmag_runner::FemMeshPartPayload) -> bool,
) -> Vec<bool> {
    let mut selected = vec![false; element_count];
    for part in mesh.mesh_parts.iter().filter(|part| predicate(part)) {
        let start = (part.element_start as usize).min(element_count);
        let end = start
            .saturating_add(part.element_count as usize)
            .min(element_count);
        selected[start..end].fill(true);
    }
    selected
}

fn expand_fem_values(
    resolved: &ResolvedSpatialField<'_>,
    mapping: &EntityMapping,
    global_node_count: usize,
    elements: &[[u32; 4]],
    selected: &[bool],
) -> Result<Vec<f64>, ApiError> {
    let mut values = vec![f64::NAN; global_node_count.saturating_mul(resolved.component_count)];
    match mapping {
        EntityMapping::Identity { entity_count } => {
            if *entity_count != global_node_count {
                return Err(ApiError::conflict(
                    "invalid_fem_mapping: identity mapping differs from topology",
                ));
            }
            values.copy_from_slice(&resolved.values);
        }
        EntityMapping::ExplicitLocalToGlobal(local_to_global) => {
            for (local, global) in local_to_global.iter().copied().enumerate() {
                let global = global as usize;
                let src = local * resolved.component_count;
                let dst = global * resolved.component_count;
                values[dst..dst + resolved.component_count]
                    .copy_from_slice(&resolved.values[src..src + resolved.component_count]);
            }
        }
    }
    let required_nodes = elements
        .iter()
        .zip(selected)
        .filter(|(_, selected)| **selected)
        .flat_map(|(element, _)| element)
        .map(|node| *node as usize)
        .collect::<BTreeSet<_>>();
    if required_nodes.iter().any(|node| {
        values[*node * resolved.component_count..(*node + 1) * resolved.component_count]
            .iter()
            .any(|value| !value.is_finite())
    }) {
        return Err(ApiError::unprocessable(
            "unsupported_compact_fem_target: selected elements lack complete P1 nodal values",
        ));
    }
    Ok(values)
}

fn fdm_bounds(
    cells: [u32; 3],
    origin: [f64; 3],
    spacing: [f64; 3],
    selected: &[bool],
) -> Result<[[f64; 3]; 2], ApiError> {
    let mut low = [u32::MAX; 3];
    let mut high = [0u32; 3];
    for (index, selected) in selected.iter().enumerate() {
        if !selected {
            continue;
        }
        let x = index as u32 % cells[0];
        let yz = index as u32 / cells[0];
        let y = yz % cells[1];
        let z = yz / cells[1];
        for (axis, coordinate) in [x, y, z].into_iter().enumerate() {
            low[axis] = low[axis].min(coordinate);
            high[axis] = high[axis].max(coordinate + 1);
        }
    }
    if low.contains(&u32::MAX) {
        return Err(ApiError::unprocessable(
            "planar_scope_empty: resolved FDM bounds are empty",
        ));
    }
    Ok([
        [0, 1, 2].map(|axis| origin[axis] + spacing[axis] * low[axis] as f64),
        [0, 1, 2].map(|axis| origin[axis] + spacing[axis] * high[axis] as f64),
    ])
}

fn fem_bounds(
    nodes: &[[f64; 3]],
    elements: &[[u32; 4]],
    selected: &[bool],
) -> Result<[[f64; 3]; 2], ApiError> {
    let node_ids = elements
        .iter()
        .zip(selected)
        .filter(|(_, selected)| **selected)
        .flat_map(|(element, _)| element)
        .map(|node| *node as usize)
        .collect::<BTreeSet<_>>();
    if node_ids.is_empty() {
        return Err(ApiError::unprocessable(
            "planar_scope_empty: resolved FEM bounds are empty",
        ));
    }
    let mut bounds = [[f64::INFINITY; 3], [f64::NEG_INFINITY; 3]];
    for node in node_ids {
        for axis in 0..3 {
            bounds[0][axis] = bounds[0][axis].min(nodes[node][axis]);
            bounds[1][axis] = bounds[1][axis].max(nodes[node][axis]);
        }
    }
    Ok(bounds)
}

fn optional_fdm_bounds(
    cells: [u32; 3],
    origin: [f64; 3],
    spacing: [f64; 3],
    selected: &[bool],
) -> Result<Option<[[f64; 3]; 2]>, ApiError> {
    if selected.iter().any(|selected| *selected) {
        fdm_bounds(cells, origin, spacing, selected).map(Some)
    } else {
        Ok(None)
    }
}

fn optional_fem_bounds(
    nodes: &[[f64; 3]],
    elements: &[[u32; 4]],
    selected: &[bool],
) -> Result<Option<[[f64; 3]; 2]>, ApiError> {
    if selected.iter().any(|selected| *selected) {
        fem_bounds(nodes, elements, selected).map(Some)
    } else {
        Ok(None)
    }
}

fn fem_carrier_identity(topology_fingerprint: &str, mapping: &EntityMapping) -> String {
    let mut hasher = Sha256::new();
    hasher.update(topology_fingerprint.as_bytes());
    match mapping {
        EntityMapping::Identity { entity_count } => {
            hasher.update(b"identity");
            hasher.update(entity_count.to_le_bytes());
        }
        EntityMapping::ExplicitLocalToGlobal(local_to_global) => {
            hasher.update(b"explicit");
            for global in local_to_global {
                hasher.update(global.to_le_bytes());
            }
        }
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn target_fingerprint(
    carrier: &str,
    revision: u64,
    selected: &[u32],
    target: &MonitorTargetIR,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(carrier.as_bytes());
    hasher.update(revision.to_le_bytes());
    hasher.update(
        serde_json::to_vec(target).expect("canonical monitor target identity is serializable"),
    );
    for entity in selected {
        hasher.update(entity.to_le_bytes());
    }
    format!("sha256:{:x}", hasher.finalize())
}

fn monitor_target_kind(target: &MonitorTargetIR) -> &'static str {
    match target {
        MonitorTargetIR::MagneticDomain => "magnetic_domain",
        MonitorTargetIR::Domain => "domain",
        MonitorTargetIR::Object { .. } => "object",
        MonitorTargetIR::Region { .. } => "region",
    }
}

fn monitor_target_id(target: &MonitorTargetIR) -> Option<String> {
    match target {
        MonitorTargetIR::MagneticDomain | MonitorTargetIR::Domain => None,
        MonitorTargetIR::Object { object_id } => Some(object_id.clone()),
        MonitorTargetIR::Region {
            object_id,
            region_id,
        } => Some(format!("{object_id}/{region_id}")),
    }
}

fn mask_from_indices(count: usize, indices: Vec<usize>) -> Vec<bool> {
    let mut mask = vec![false; count];
    for index in indices.into_iter().filter(|index| *index < count) {
        mask[index] = true;
    }
    mask
}

fn intersect_masks(left: &mut [bool], right: &[bool]) {
    for (left, right) in left.iter_mut().zip(right) {
        *left &= *right;
    }
}

fn cell_count(cells: [u32; 3]) -> Result<usize, ApiError> {
    cells
        .into_iter()
        .try_fold(1usize, |count, axis| {
            usize::try_from(axis).ok()?.checked_mul(count)
        })
        .ok_or_else(|| ApiError::conflict("invalid_fdm_field: grid size overflow"))
}

fn dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    left[0] * right[0] + left[1] * right[1] + left[2] * right[2]
}
