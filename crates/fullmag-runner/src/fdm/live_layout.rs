//! Compact grid summaries published alongside Live execution plans.
use fullmag_ir::{FdmMultilayerPlanIR, FdmPlanIR};
use serde_json::{json, Value};

pub fn live_fdm_grid_layout(fdm: &FdmPlanIR) -> Value {
    let total_cells = fdm.grid.cells[0] as usize
        * fdm.grid.cells[1] as usize
        * fdm.grid.cells[2] as usize;
    let active_cell_count = fdm
        .active_mask
        .as_ref()
        .map(|mask| mask.iter().filter(|is_active| **is_active).count())
        .unwrap_or(total_cells);
    json!({
        "backend": "fdm",
        "grid_cells": fdm.grid.cells,
        "cell_size": fdm.cell_size,
        "origin_m": fdm.origin_m,
        "total_cell_count": total_cells,
        "active_mask_present": fdm.active_mask.is_some(),
        "active_cell_count": active_cell_count,
        "inactive_cell_count": total_cells.saturating_sub(active_cell_count),
        "active_fraction": if total_cells > 0 {
            active_cell_count as f64 / total_cells as f64
        } else {
            0.0
        },
    })
}

pub fn live_fdm_multilayer_grid_layout(multilayer: &FdmMultilayerPlanIR) -> Value {
    json!({
        "backend": "fdm_multilayer",
        "mode": multilayer.mode,
        "common_cells": multilayer.common_cells,
        "layer_count": multilayer.layers.len(),
        "layers": multilayer.layers.iter().scan(0usize, |offset, layer| {
            let total_cells = layer.native_grid[0] as usize
                * layer.native_grid[1] as usize
                * layer.native_grid[2] as usize;
            let active_cell_count = layer
                .native_active_mask
                .as_ref()
                .map(|mask| mask.iter().filter(|is_active| **is_active).count())
                .unwrap_or(total_cells);
            let current_offset = *offset;
            *offset += total_cells;
            Some(json!({
                "magnet_name": layer.magnet_name,
                "native_grid": layer.native_grid,
                "native_cell_size": layer.native_cell_size,
                "native_origin": layer.native_origin,
                "convolution_grid": layer.convolution_grid,
                "convolution_cell_size": layer.convolution_cell_size,
                "transfer_kind": layer.transfer_kind,
                "total_cell_count": total_cells,
                "active_mask_present": layer.native_active_mask.is_some(),
                "active_cell_count": active_cell_count,
                "inactive_cell_count": total_cells.saturating_sub(active_cell_count),
                "value_offset": current_offset,
                "value_count": total_cells,
            }))
        }).collect::<Vec<_>>(),
        "planner_summary": multilayer.planner_summary,
    })
}
