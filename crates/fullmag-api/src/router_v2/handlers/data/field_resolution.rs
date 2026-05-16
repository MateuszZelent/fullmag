use crate::field_slice::{FdmField, FemField};
use crate::types::SessionStateResponse;

pub(super) fn live_magnetization_available(snapshot: &SessionStateResponse) -> bool {
    live_magnetization_values(snapshot).is_some()
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
        let grid = if ls.latest_step.grid.iter().any(|v| *v > 0) {
            ls.latest_step.grid
        } else {
            [(mag.len() / 3) as u32, 1, 1]
        };
        Some((mag.to_vec(), grid))
    })
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
