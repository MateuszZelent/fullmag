use crate::field_slice::{FdmField, FemField};
use crate::preview::quantity_spatial_domain;
use crate::types::SessionStateResponse;
use fullmag_runner::FemMeshPayload;

pub(super) fn live_magnetization_available(snapshot: &SessionStateResponse) -> bool {
    live_magnetization_values(snapshot).is_some()
}

pub(super) fn field_values_match_current_domain(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
    values: &[f64],
) -> bool {
    if n_comp == 0 || values.is_empty() || values.len() % n_comp != 0 {
        return false;
    }
    let point_count = values.len() / n_comp;
    field_point_count_matches_current_domain(snapshot, quantity_id, point_count)
}

pub(super) fn field_point_count_matches_current_domain(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    point_count: usize,
) -> bool {
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return true;
    };
    if point_count == 0 || mesh.nodes.is_empty() || mesh.elements.is_empty() {
        return false;
    }
    if point_count == mesh.nodes.len() {
        return true;
    }
    quantity_spatial_domain(quantity_id) == "magnetic_only"
        && fem_magnetic_node_count(mesh).is_some_and(|count| point_count == count)
}

pub(super) fn flatten_json_field_values(raw: &serde_json::Value) -> Vec<f64> {
    raw.get("values")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .flat_map(|v| {
                    if let Some(inner) = v.as_array() {
                        inner.iter().filter_map(|c| c.as_f64()).collect::<Vec<_>>()
                    } else if let Some(f) = v.as_f64() {
                        vec![f]
                    } else {
                        vec![]
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn json_field_grid(raw: &serde_json::Value) -> Option<[u32; 3]> {
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

pub(super) fn live_magnetization_values(
    snapshot: &SessionStateResponse,
) -> Option<(Vec<f64>, [u32; 3])> {
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
        Some((mag.to_vec(), grid))
    })
}

fn fem_magnetic_node_count(mesh: &FemMeshPayload) -> Option<usize> {
    let mut active = vec![false; mesh.nodes.len()];

    if mark_magnetic_mesh_parts(mesh, &mut active) {
        return count_active_nodes(&active);
    }
    if mark_magnetic_object_segments(mesh, &mut active) {
        return count_active_nodes(&active);
    }
    if mark_nonzero_marker_elements(mesh, &mut active) {
        return count_active_nodes(&active);
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
            .min(mesh.elements.len());
        for element in &mesh.elements[element_start..element_end] {
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
    if mesh.element_markers.len() != mesh.elements.len() || mesh.elements.is_empty() {
        return false;
    }
    let mut marked = false;
    for (element_index, element) in mesh.elements.iter().enumerate() {
        if mesh.element_markers[element_index] == 0 {
            continue;
        }
        marked = true;
        for node_index in element {
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

fn count_active_nodes(active: &[bool]) -> Option<usize> {
    let count = active.iter().filter(|value| **value).count();
    (count > 0).then_some(count)
}

pub(super) fn extract_fdm_field(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<FdmField> {
    if quantity_id == "m" {
        if let Some((values, grid)) = live_magnetization_values(snapshot) {
            return Some(FdmField {
                n_comp: 3,
                grid,
                values,
                origin: None,
                spacing: None,
            });
        }
    }
    if let Some(raw) = snapshot.latest_fields.get(quantity_id) {
        let values = flatten_json_field_values(raw);
        let grid = json_field_grid(raw)?;
        return Some(FdmField {
            n_comp,
            grid,
            values,
            origin: None,
            spacing: None,
        });
    }
    if let Some(field) = snapshot.preview_cache.get(quantity_id) {
        return Some(FdmField {
            n_comp,
            grid: field.preview_grid,
            values: field.vector_field_values.clone(),
            origin: None,
            spacing: None,
        });
    }
    None
}

fn extract_raw_field_values(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<Vec<f64>> {
    if quantity_id == "m" {
        if let Some((values, _grid)) = live_magnetization_values(snapshot) {
            return Some(values);
        }
    }
    if let Some(raw) = snapshot.latest_fields.get(quantity_id) {
        return Some(flatten_json_field_values(raw));
    }
    snapshot
        .preview_cache
        .get(quantity_id)
        .map(|field| field.vector_field_values.clone())
        .filter(|values| n_comp == 0 || values.len() % n_comp == 0)
}

pub(super) fn extract_fem_field(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    n_comp: usize,
) -> Option<FemField> {
    let mesh = snapshot.fem_mesh.as_ref()?;
    if mesh.nodes.is_empty() || mesh.elements.is_empty() {
        return None;
    }
    let values = extract_raw_field_values(snapshot, quantity_id, n_comp)?;
    if n_comp == 0 || values.len() / n_comp != mesh.nodes.len() {
        return None;
    }
    Some(FemField {
        n_comp,
        nodes: mesh.nodes.clone(),
        elements: mesh.elements.clone(),
        element_markers: mesh.element_markers.clone(),
        values,
    })
}
