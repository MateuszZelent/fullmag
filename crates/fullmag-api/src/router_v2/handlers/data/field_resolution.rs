use crate::field_slice::{FdmField, FemField};
use crate::router_v2::handlers::data::resolved_spatial_field::{
    resolve_fem_node_mapping, EntityMapping,
};
use crate::router_v2::handlers::sessions::status::{fdm_grid_geometry, fdm_grid_shape};
use crate::session::{resolved_current_field_source, ResolvedCurrentFieldSource};
use crate::types::SessionStateResponse;
use fullmag_quantities::{quantity_spec, QuantityLocation};
use fullmag_runner::FemMeshPayload;

pub(crate) fn live_magnetization_available(snapshot: &SessionStateResponse) -> bool {
    live_magnetization_values_ref(snapshot).is_some()
}

pub(crate) fn field_values_match_current_domain(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
    values: &[f64],
) -> bool {
    field_value_count_matches_current_domain(snapshot, quantity_id, n_comp, values.len())
}

pub(crate) fn field_value_count_matches_current_domain(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
    value_count: usize,
) -> bool {
    if n_comp == 0 || value_count == 0 || value_count % n_comp != 0 {
        return false;
    }
    let point_count = value_count / n_comp;
    field_point_count_matches_current_domain(snapshot, quantity_id, point_count)
}

/// Return whether a serialized backend label belongs to an executable FDM
/// structured-grid lane.  The multilayer lane is still FDM for field/domain
/// routing even when a stale FEM mesh is retained in the session snapshot.
pub(crate) fn is_fdm_backend_kind(kind: &str) -> bool {
    let kind = kind.trim();
    kind.eq_ignore_ascii_case("fdm") || kind.eq_ignore_ascii_case("fdm_multilayer")
}

pub(super) fn field_point_count_matches_current_domain(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    point_count: usize,
) -> bool {
    if is_fdm_snapshot(snapshot) {
        if multilayer_native_point_count(snapshot) == Some(point_count) {
            return true;
        }
        return fdm_grid_point_count(snapshot)
            .is_some_and(|expected_count| point_count == expected_count);
    }

    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return true;
    };
    if point_count == 0 || mesh.nodes.is_empty() || mesh.cells.is_empty() {
        return false;
    }
    match quantity_spec(quantity_id).map(|spec| spec.location) {
        Some(QuantityLocation::Node) => {
            resolve_fem_node_mapping(mesh, quantity_id, point_count).is_ok()
        }
        Some(QuantityLocation::Cell) => point_count == mesh.cell_count(),
        Some(QuantityLocation::Global) | None => false,
    }
}

fn multilayer_native_point_count(snapshot: &SessionStateResponse) -> Option<usize> {
    let layout = snapshot.metadata.as_ref()?.get("artifact_layout")?;
    if layout.get("backend")?.as_str()? != "fdm_multilayer" {
        return None;
    }
    layout
        .get("layers")?
        .as_array()?
        .iter()
        .try_fold(0usize, |total, layer| {
            let count = usize::try_from(layer.get("value_count")?.as_u64()?).ok()?;
            total.checked_add(count)
        })
}

fn fdm_grid_point_count(snapshot: &SessionStateResponse) -> Option<usize> {
    let latest_grid = snapshot
        .live_state
        .as_ref()
        .map(|state| state.latest_step.grid);
    let grid = fdm_grid_shape(snapshot, latest_grid);
    grid.iter()
        .copied()
        .try_fold(1u64, |count, dimension| {
            (dimension > 0).then_some(count.saturating_mul(u64::from(dimension)))
        })
        .and_then(|count| usize::try_from(count).ok())
}

pub(crate) fn is_fdm_snapshot(snapshot: &SessionStateResponse) -> bool {
    let backend_kind = snapshot.metadata.as_ref().and_then(|metadata| {
        metadata
            .get("execution_plan")
            .and_then(|plan| plan.get("backend_plan"))
            .and_then(|plan| plan.get("kind"))
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                metadata
                    .get("artifact_layout")
                    .and_then(|layout| layout.get("backend"))
                    .and_then(serde_json::Value::as_str)
            })
    });
    if let Some(kind) = backend_kind {
        return is_fdm_backend_kind(kind);
    }
    // A present FEM solver mesh is authoritative until an explicit FDM plan
    // replaces it. This keeps legacy FEM snapshots from being reclassified
    // merely because their test/session manifest requested a CPU-FDM lane.
    if snapshot.fem_mesh.is_some() {
        return false;
    }
    if let Some(resolved_backend) = snapshot.session.resolved_backend.as_deref() {
        if resolved_backend.to_ascii_lowercase().contains("fem") {
            return false;
        }
        if resolved_backend.to_ascii_lowercase().contains("fdm") {
            return fdm_grid_point_count(snapshot).is_some();
        }
    }
    let backend_requested_fdm = snapshot
        .session
        .requested_backend
        .to_ascii_lowercase()
        .contains("fdm")
        || snapshot
            .session
            .resolved_backend
            .as_deref()
            .is_some_and(|backend| backend.to_ascii_lowercase().contains("fdm"));
    backend_requested_fdm && fdm_grid_point_count(snapshot).is_some()
}

fn visit_json_field_values(raw: &serde_json::Value, mut visit: impl FnMut(f64)) -> usize {
    let Some(values) = raw.get("values").and_then(serde_json::Value::as_array) else {
        return 0;
    };
    let mut count = 0;
    for value in values {
        if let Some(components) = value.as_array() {
            for component in components {
                if let Some(component) = component.as_f64() {
                    count += 1;
                    visit(component);
                }
            }
        } else if let Some(value) = value.as_f64() {
            count += 1;
            visit(value);
        }
    }
    count
}

pub(crate) fn flatten_json_field_values(raw: &serde_json::Value) -> Vec<f64> {
    let mut values = Vec::new();
    visit_json_field_values(raw, |value| values.push(value));
    values
}

pub(crate) fn json_field_value_count(raw: &serde_json::Value) -> usize {
    visit_json_field_values(raw, |_| {})
}

fn hash_field_value(hash: u64, value: f64) -> u64 {
    hash.wrapping_mul(1099511628211)
        .wrapping_add(value.to_bits())
}

pub(crate) fn field_values_hash(values: &[f64]) -> u64 {
    values.iter().fold(1469598103934665603_u64, |hash, value| {
        hash_field_value(hash, *value)
    })
}

pub(crate) fn json_field_payload_signature(raw: &serde_json::Value) -> (usize, u64) {
    let mut hash = 1469598103934665603_u64;
    let count = visit_json_field_values(raw, |value| hash = hash_field_value(hash, value));
    (count, hash)
}

pub(crate) fn strict_flat_json_field_values(raw: &serde_json::Value) -> Option<Vec<f64>> {
    raw.get("values")?
        .as_array()?
        .iter()
        .map(|value| value.as_f64().filter(|value| value.is_finite()))
        .collect()
}

#[cfg(test)]
mod strict_json_tests {
    use super::strict_flat_json_field_values;

    #[test]
    fn strict_flat_field_values_reject_non_numbers_nulls_and_nested_arrays() {
        for raw in [
            serde_json::json!({"values": [1.0, "2.0"]}),
            serde_json::json!({"values": [1.0, null]}),
            serde_json::json!({"values": [[1.0], 2.0]}),
        ] {
            assert!(strict_flat_json_field_values(&raw).is_none(), "{raw}");
        }
        assert_eq!(
            strict_flat_json_field_values(&serde_json::json!({"values": [1.0, -2.0]})),
            Some(vec![1.0, -2.0])
        );
        assert!(serde_json::from_str::<serde_json::Value>(r#"{"values":[NaN]}"#).is_err());
    }
}

pub(crate) fn json_field_grid(raw: &serde_json::Value) -> Option<[u32; 3]> {
    raw.get("layout")
        .and_then(|l| l.get("grid_cells"))
        .and_then(|g| g.as_array())
        .and_then(|g| {
            if g.len() == 3 {
                Some([
                    g[0].as_u64().unwrap_or(0) as u32,
                    g[1].as_u64().unwrap_or(0) as u32,
                    g[2].as_u64().unwrap_or(0) as u32,
                ])
            } else {
                None
            }
        })
}

pub(crate) fn live_magnetization_values(
    snapshot: &SessionStateResponse,
) -> Option<(Vec<f64>, [u32; 3])> {
    live_magnetization_values_ref(snapshot).map(|(values, grid)| (values.to_vec(), grid))
}

pub(crate) fn live_magnetization_values_ref(
    snapshot: &SessionStateResponse,
) -> Option<(&[f64], [u32; 3])> {
    snapshot.live_state.as_ref().and_then(|ls| {
        let mag = ls.latest_step.magnetization.as_deref()?;
        if mag.is_empty() || mag.len() % 3 != 0 || mag.iter().any(|value| !value.is_finite()) {
            return None;
        }
        let point_count = mag.len() / 3;
        if !field_point_count_matches_current_domain(snapshot, "m", point_count) {
            return None;
        }
        let grid = if ls.latest_step.grid.iter().any(|v| *v > 0) {
            ls.latest_step.grid
        } else {
            [point_count as u32, 1, 1]
        };
        Some((mag, grid))
    })
}

pub(crate) fn fem_magnetic_node_indices(mesh: &FemMeshPayload) -> Option<Vec<u32>> {
    let mut active = vec![false; mesh.nodes.len()];

    if mark_magnetic_mesh_parts(mesh, &mut active) {
        return active_node_indices(&active);
    }
    if mark_magnetic_object_segments(mesh, &mut active) {
        return active_node_indices(&active);
    }
    if mark_nonzero_marker_elements(mesh, &mut active) {
        return active_node_indices(&active);
    }
    None
}

fn mark_magnetic_mesh_parts(mesh: &FemMeshPayload, active: &mut [bool]) -> bool {
    let mut saw_magnetic_part = false;
    for part in &mesh.mesh_parts {
        if part.role != "magnetic_object" {
            continue;
        }
        saw_magnetic_part = true;
        if !part.node_indices.is_empty() {
            for node_index in &part.node_indices {
                if let Some(slot) = active.get_mut(*node_index as usize) {
                    *slot = true;
                }
            }
            continue;
        }
        mark_node_range(active, part.node_start as usize, part.node_count as usize);
    }
    saw_magnetic_part
}

fn mark_magnetic_object_segments(mesh: &FemMeshPayload, active: &mut [bool]) -> bool {
    let mut saw_magnetic_segment = false;
    for segment in &mesh.object_segments {
        if segment.object_id == "__air__" {
            continue;
        }
        saw_magnetic_segment = true;
        mark_node_range(
            active,
            segment.node_start as usize,
            segment.node_count as usize,
        );
        let element_start = segment.element_start as usize;
        let element_end = element_start
            .saturating_add(segment.element_count as usize)
            .min(mesh.cell_count());
        for element_index in element_start..element_end {
            let Some(element) = mesh.cells.item_nodes(element_index) else {
                continue;
            };
            for node_index in element {
                if let Some(slot) = active.get_mut(*node_index as usize) {
                    *slot = true;
                }
            }
        }
    }
    saw_magnetic_segment
}

fn mark_nonzero_marker_elements(mesh: &FemMeshPayload, active: &mut [bool]) -> bool {
    if mesh.element_markers.len() != mesh.cell_count() || mesh.cells.is_empty() {
        return false;
    }
    let mut marked = false;
    for cell in mesh.cells.iter() {
        if mesh.element_markers[cell.ordinal] == 0 {
            continue;
        }
        marked = true;
        for node_index in cell.nodes {
            if let Some(slot) = active.get_mut(*node_index as usize) {
                *slot = true;
            }
        }
    }
    marked
}

fn mark_node_range(active: &mut [bool], start: usize, count: usize) {
    let end = start.saturating_add(count).min(active.len());
    if start < end {
        active[start..end].fill(true);
    }
}

fn active_node_indices(active: &[bool]) -> Option<Vec<u32>> {
    let indices = active
        .iter()
        .enumerate()
        .filter_map(|(index, value)| value.then_some(index as u32))
        .collect::<Vec<_>>();
    (!indices.is_empty()).then_some(indices)
}

pub(super) fn extract_fdm_field(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<FdmField> {
    let (values, grid) = match resolved_current_field_source(snapshot, quantity_id, n_comp)? {
        ResolvedCurrentFieldSource::Latest(raw) => {
            let values = flatten_json_field_values(raw);
            let point_count = values.len().checked_div(n_comp.max(1))?;
            (
                values,
                json_field_grid(raw)
                    .or_else(|| fdm_grid_shape_for_point_count(snapshot, point_count))?,
            )
        }
        ResolvedCurrentFieldSource::Preview(field) => {
            (field.vector_field_values.clone(), field.preview_grid)
        }
        ResolvedCurrentFieldSource::LegacyLiveMagnetization { values, grid } => {
            (values.to_vec(), grid)
        }
    };
    Some(fdm_field_with_plan_geometry(
        snapshot,
        FdmField {
            n_comp,
            grid,
            values,
            origin: None,
            spacing: None,
            active_mask: None,
        },
    ))
}

fn fdm_field_with_plan_geometry(snapshot: &SessionStateResponse, mut field: FdmField) -> FdmField {
    if let Some((origin, spacing)) = fdm_grid_geometry(snapshot) {
        if fdm_grid_shape(snapshot, None) == field.grid {
            field.origin = Some(origin);
            field.spacing = Some(spacing);
        }
    }
    field
}

fn fdm_grid_shape_for_point_count(
    snapshot: &SessionStateResponse,
    point_count: usize,
) -> Option<[u32; 3]> {
    let shape = fdm_grid_shape(
        snapshot,
        snapshot
            .live_state
            .as_ref()
            .map(|state| state.latest_step.grid),
    );
    let expected = shape.into_iter().try_fold(1usize, |count, axis| {
        usize::try_from(axis).ok()?.checked_mul(count)
    })?;
    (expected == point_count).then_some(shape)
}

fn extract_raw_field_values(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<Vec<f64>> {
    match resolved_current_field_source(snapshot, quantity_id, n_comp)? {
        ResolvedCurrentFieldSource::Latest(raw) => Some(flatten_json_field_values(raw)),
        ResolvedCurrentFieldSource::Preview(field) => Some(field.vector_field_values.clone()),
        ResolvedCurrentFieldSource::LegacyLiveMagnetization { values, .. } => Some(values.to_vec()),
    }
}

pub(super) fn extract_fem_field(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<FemField> {
    let mesh = snapshot.fem_mesh.as_ref()?;
    if mesh.nodes.is_empty() || mesh.cells.is_empty() {
        return None;
    }
    let values = extract_raw_field_values(snapshot, quantity_id, n_comp)?;
    if n_comp == 0
        || !matches!(
            resolve_fem_node_mapping(mesh, quantity_id, values.len() / n_comp).ok()?,
            EntityMapping::Identity { .. }
        )
    {
        return None;
    }
    let elements = mesh.require_tet4_elements().ok()?;
    Some(FemField {
        n_comp,
        nodes: mesh.nodes.clone(),
        elements,
        element_markers: mesh.element_markers.clone(),
        values,
    })
}
