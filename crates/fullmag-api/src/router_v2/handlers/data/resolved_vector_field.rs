//! Authoritative vector-field resolution for analysis resources.
//!
//! Analysis never consumes `preview_cache`: previews are a rendering aid, not a
//! completed numerical state.  The ordering below is part of the public
//! reproducibility contract.

use std::sync::Arc;

use crate::error::ApiError;
use crate::router_v2::handlers::data::field_resolution::{
    fem_magnetic_node_indices, field_values_match_current_domain, flatten_json_field_values,
    json_field_grid, live_magnetization_values,
};
use crate::router_v2::handlers::data::fields::{
    persisted_hysteresis_magnetization_values, validate_hysteresis_snapshot_stage_scope,
};
use crate::router_v2::handlers::sessions::status::field_quantity_revision;
use crate::types::{AppState, SessionStateResponse};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResolvedFieldSourceKind {
    PersistedSnapshot,
    CurrentLive,
    CurrentMaterialized,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedObjectVectorField {
    pub values: Vec<[f64; 3]>,
    pub grid: Option<[u32; 3]>,
    /// Global FEM node ids when `values` is compacted to magnetic nodes.
    pub global_node_ids: Option<Vec<u32>>,
    pub object_mask: Option<Vec<bool>>,
    pub field_revision: u64,
    pub field_storage_domain: String,
    pub field_node_mapping_id: Option<String>,
    pub snapshot_id: Option<String>,
    pub stage_id: Option<String>,
    pub source_kind: ResolvedFieldSourceKind,
}

/// Resolve the only vector field accepted by the topological-charge resource:
/// magnetization `m`.  A persisted snapshot is exact and stage-scoped; without
/// one, a current live state wins over a current materialized field.  Preview
/// data is deliberately excluded.
pub(crate) async fn resolve_topological_charge_magnetization(
    state: &Arc<AppState>,
    snapshot: &SessionStateResponse,
    snapshot_id: Option<&str>,
    stage_id: Option<&str>,
) -> Result<Option<ResolvedObjectVectorField>, ApiError> {
    let (values, grid, source) = if let Some(snapshot_id) = snapshot_id {
        let snapshot_id = snapshot_id.trim();
        if snapshot_id.is_empty() {
            return Err(ApiError::bad_request("snapshot_id must not be empty"));
        }
        validate_hysteresis_snapshot_stage_scope(state, stage_id, snapshot_id).await?;
        let (values, grid) = persisted_hysteresis_magnetization_values(snapshot, snapshot_id)?;
        (values, grid, ResolvedFieldSourceKind::PersistedSnapshot)
    } else if let Some((values, grid)) = live_magnetization_values(snapshot) {
        (values, grid, ResolvedFieldSourceKind::CurrentLive)
    } else if let Some(raw) = snapshot.latest_fields.get("m") {
        let values = flatten_json_field_values(raw);
        if !field_values_match_current_domain(snapshot, "m", 3, &values)
            || values.iter().any(|value| !value.is_finite())
        {
            return Ok(None);
        }
        let point_count = values.len() / 3;
        let grid = json_field_grid(raw).unwrap_or([point_count as u32, 1, 1]);
        (values, grid, ResolvedFieldSourceKind::CurrentMaterialized)
    } else {
        return Ok(None);
    };

    let values = values
        .chunks_exact(3)
        .map(|sample| [sample[0], sample[1], sample[2]])
        .collect::<Vec<_>>();
    let global_node_ids = resolve_global_node_ids(snapshot, values.len())?;
    Ok(Some(ResolvedObjectVectorField {
        values,
        grid: Some(grid),
        field_revision: field_quantity_revision(snapshot, "m").max(1),
        field_storage_domain: if snapshot.fem_mesh.is_some() {
            "fem_nodal".to_string()
        } else {
            "fdm_cell_centered".to_string()
        },
        field_node_mapping_id: global_node_ids
            .as_ref()
            .map(|_| "magnetic_node_indices.v1".to_string()),
        global_node_ids,
        object_mask: None,
        snapshot_id: snapshot_id.map(str::to_string),
        stage_id: stage_id.map(str::to_string),
        source_kind: source,
    }))
}

fn resolve_global_node_ids(
    snapshot: &SessionStateResponse,
    point_count: usize,
) -> Result<Option<Vec<u32>>, ApiError> {
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return Ok(None);
    };
    if point_count == mesh.nodes.len() {
        return Ok(None);
    }
    let magnetic_nodes = fem_magnetic_node_indices(mesh).ok_or_else(|| {
        ApiError::conflict("compact magnetization field has no resolvable magnetic-node mapping")
    })?;
    if point_count != magnetic_nodes.len() {
        return Err(ApiError::conflict(
            "magnetization field length does not match the FEM node layout",
        ));
    }
    Ok(Some(magnetic_nodes))
}

#[cfg(test)]
mod tests {
    use super::ResolvedFieldSourceKind;

    #[test]
    fn preview_is_not_an_analysis_source() {
        let accepted = [
            ResolvedFieldSourceKind::PersistedSnapshot,
            ResolvedFieldSourceKind::CurrentLive,
            ResolvedFieldSourceKind::CurrentMaterialized,
        ];
        assert_eq!(accepted.len(), 3);
    }
}
