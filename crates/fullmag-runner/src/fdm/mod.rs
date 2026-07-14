pub(crate) mod artifacts;
pub(crate) mod cpu;
pub(crate) mod gpu;
pub(crate) mod multilayer;
pub(crate) mod schedules;

use crate::types::RunError;

/// Re-check the planner's resolved single-grid budget immediately before any
/// CPU/CUDA engine allocation.  The runner must reject forged or stale plans
/// whose payload lengths do not match the checked grid cell count.
pub(crate) fn validate_single_grid_budget(
    plan: &fullmag_ir::FdmPlanIR,
) -> Result<u64, RunError> {
    let cost = fullmag_plan::checked_fdm_grid_cost(
        plan.grid.cells,
        fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
    )
    .map_err(|error| RunError {
        message: format!("FDM grid budget rejected before allocation: {error}"),
    })?;
    let cells = usize::try_from(cost.cells).map_err(|_| RunError {
        message: format!(
            "FDM grid cell count {} is not addressable on this runtime",
            cost.cells
        ),
    })?;
    if plan.initial_magnetization.len() != cells {
        return Err(RunError {
            message: format!(
                "FDM grid payload mismatch: initial_magnetization_len={} resolved_cells={cells}",
                plan.initial_magnetization.len()
            ),
        });
    }
    if plan
        .active_mask
        .as_ref()
        .is_some_and(|mask| mask.len() != cells)
    {
        return Err(RunError {
            message: format!(
                "FDM grid payload mismatch: active_mask_len does not equal resolved_cells={cells}"
            ),
        });
    }
    if !plan.region_mask.is_empty() && plan.region_mask.len() != cells {
        return Err(RunError {
            message: format!(
                "FDM grid payload mismatch: region_mask_len={} resolved_cells={cells}",
                plan.region_mask.len()
            ),
        });
    }
    Ok(cost.cells)
}

pub(crate) fn validate_multilayer_grid_budget(
    plan: &fullmag_ir::FdmMultilayerPlanIR,
) -> Result<u64, RunError> {
    let cost = fullmag_plan::checked_fdm_grid_cost(
        plan.common_cells,
        fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
    )
    .map_err(|error| RunError {
        message: format!("FDM common grid budget rejected before allocation: {error}"),
    })?;
    for layer in &plan.layers {
        let layer_cost = fullmag_plan::checked_fdm_grid_cost(
            layer.native_grid,
            fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
        )
        .map_err(|error| RunError {
            message: format!("FDM native layer grid budget rejected before allocation: {error}"),
        })?;
        let native_cells = usize::try_from(layer_cost.cells).map_err(|_| RunError {
            message: format!(
                "FDM native layer cell count {} is not addressable on this runtime",
                layer_cost.cells
            ),
        })?;
        if layer.initial_magnetization.len() != native_cells {
            return Err(RunError {
                message: format!(
                    "FDM native layer payload mismatch: magnet='{}' initial_magnetization_len={} resolved_cells={native_cells}",
                    layer.magnet_name,
                    layer.initial_magnetization.len()
                ),
            });
        }
        if layer
            .native_active_mask
            .as_ref()
            .is_some_and(|mask| mask.len() != native_cells)
        {
            return Err(RunError {
                message: format!(
                    "FDM native layer payload mismatch: magnet='{}' active_mask_len does not equal resolved_cells={native_cells}",
                    layer.magnet_name
                ),
            });
        }
    }
    Ok(cost.cells)
}

#[cfg(test)]
mod tests {
    use super::validate_single_grid_budget;
    use fullmag_ir::FdmPlanIR;

    #[test]
    fn forged_single_grid_payload_is_rejected_before_allocation() {
        let mut plan = FdmPlanIR::default();
        plan.grid.cells = [2, 2, 1];
        plan.initial_magnetization = vec![[0.0, 0.0, 1.0]; 3];

        let error = validate_single_grid_budget(&plan).expect_err("payload length must be checked");
        assert!(error.message.contains("initial_magnetization_len=3"));
        assert!(error.message.contains("resolved_cells=4"));
    }
}
