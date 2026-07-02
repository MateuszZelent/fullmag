use super::*;

pub(crate) fn display_refresh_due(
    last_preview_revision: Option<u64>,
    display_state: &DisplaySelectionState,
    local_step: u64,
) -> bool {
    let cadence = u64::from(display_state.selection.every_n.max(1));
    last_preview_revision != Some(display_state.revision)
        || local_step <= 1
        || local_step % cadence == 0
}

pub(crate) fn cached_display_refresh_due(
    last_cached_preview_revision: Option<u64>,
    display_state: &DisplaySelectionState,
    local_step: u64,
    field_every_n: u64,
) -> bool {
    let cadence = field_every_n.max(1);
    last_cached_preview_revision != Some(display_state.revision)
        || local_step <= 1
        || local_step % cadence == 0
}

pub(crate) fn cached_preview_quantities_for(
    display_state: &DisplaySelectionState,
) -> Vec<&'static str> {
    let active_quantity = (!display_is_global_scalar(display_state))
        .then_some(display_state.selection.quantity.as_str());
    crate::quantities::cached_preview_quantity_ids()
        .into_iter()
        .filter(|quantity| Some(*quantity) != active_quantity)
        .collect()
}

pub(crate) fn build_cached_grid_preview_fields(
    display_state: &DisplaySelectionState,
    observables: &StateObservables,
    grid: [u32; 3],
    active_mask: Option<&[bool]>,
) -> Option<Vec<LivePreviewField>> {
    let quantities = cached_preview_quantities_for(display_state);
    if quantities.is_empty() {
        return None;
    }
    let expected_len = grid[0] as usize * grid[1] as usize * grid[2] as usize;
    let base_request = display_state.preview_request();
    let mut cached = Vec::new();
    for quantity in quantities {
        let mut request = base_request.clone();
        request.quantity = quantity.to_string();
        let Ok(values) = select_observables(observables, quantity) else {
            continue;
        };
        if values.len() != expected_len {
            continue;
        }
        cached.push(build_grid_preview_field(
            &request,
            values,
            grid,
            active_mask,
        ));
    }
    (!cached.is_empty()).then_some(cached)
}

pub(crate) fn build_cached_mesh_preview_fields(
    display_state: &DisplaySelectionState,
    observables: &StateObservables,
    mesh: &fullmag_ir::MeshIR,
) -> Option<Vec<LivePreviewField>> {
    let quantities = cached_preview_quantities_for(display_state);
    if quantities.is_empty() {
        return None;
    }
    let expected_len = mesh.nodes.len();
    let base_request = display_state.preview_request();
    let mut cached = Vec::new();
    for quantity in quantities {
        let mut request = base_request.clone();
        request.quantity = quantity.to_string();
        let Ok(values) = select_observables(observables, quantity) else {
            continue;
        };
        if values.len() != expected_len {
            continue;
        }
        cached.push(build_mesh_preview_field_with_active_mask(
            &request,
            values,
            mesh_quantity_active_mask(quantity, mesh),
        ));
    }
    (!cached.is_empty()).then_some(cached)
}

pub(crate) fn display_is_global_scalar(display_state: &DisplaySelectionState) -> bool {
    matches!(
        display_state.selection.kind,
        crate::DisplayKind::GlobalScalar
    )
}
