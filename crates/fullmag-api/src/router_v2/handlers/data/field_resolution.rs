use crate::field_slice::{FdmField, FemField};
use crate::preview::quantity_spatial_domain;
use crate::session::{resolved_current_field_source, ResolvedCurrentFieldSource};
use crate::types::SessionStateResponse;
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

pub(super) fn field_point_count_matches_current_domain(
    snapshot: &SessionStateResponse,
    quantity_id: &str,
    point_count: usize,
) -> bool {
    let Some(mesh) = snapshot.fem_mesh.as_ref() else {
        return true;
    };
    if point_count == 0 || mesh.nodes.is_empty() || mesh.cells.is_empty() {
        return false;
    }
    if point_count == mesh.nodes.len() {
        return true;
    }
    quantity_spatial_domain(quantity_id) == "magnetic_only"
        && fem_magnetic_node_count(mesh).is_some_and(|count| point_count == count)
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

fn fem_magnetic_node_count(mesh: &FemMeshPayload) -> Option<usize> {
    fem_magnetic_node_indices(mesh).map(|indices| indices.len())
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
            (flatten_json_field_values(raw), json_field_grid(raw)?)
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
    let Some(plan_value) = snapshot
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("execution_plan"))
    else {
        return field;
    };
    let Ok(plan) = serde_json::from_value::<fullmag_ir::ExecutionPlanIR>(plan_value.clone()) else {
        return field;
    };
    let fullmag_ir::BackendPlanIR::Fdm(plan) = plan.backend_plan else {
        return field;
    };
    if plan.grid.cells == field.grid {
        field.origin = Some(plan.origin_m);
        field.spacing = Some(plan.cell_size);
    }
    field
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
    if n_comp == 0 || values.len() / n_comp != mesh.nodes.len() {
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
