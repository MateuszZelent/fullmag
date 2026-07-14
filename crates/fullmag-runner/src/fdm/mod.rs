pub(crate) mod artifacts;
pub(crate) mod cpu;
pub(crate) mod gpu;
pub(crate) mod multilayer;
pub(crate) mod schedules;

use crate::types::RunError;
use std::collections::BTreeSet;

/// Resolve the planner's requested FDM PBC demagnetization policy once for
/// every runtime lane.  CPU and CUDA must not infer kernel padding directly
/// from local periodic stencil flags.
pub(crate) fn resolve_fdm_demag_boundary(
    plan: &fullmag_ir::FdmPlanIR,
) -> Result<fullmag_engine::FdmDemagBoundary, RunError> {
    resolve_fdm_demag_boundary_for_periodicity(plan.periodicity.as_ref(), plan.enable_demag)
}

pub(crate) fn resolve_fdm_demag_boundary_for_periodicity(
    periodicity: Option<&fullmag_ir::FdmPeriodicityIR>,
    demag_enabled: bool,
) -> Result<fullmag_engine::FdmDemagBoundary, RunError> {
    let resolved = periodicity
        .map(|pbc| pbc.resolve_demag_boundary(demag_enabled))
        .transpose()
        .map_err(|reason| RunError { message: reason })?
        .unwrap_or(fullmag_ir::ResolvedFdmDemagBoundaryIR::Open);
    Ok(match resolved {
        fullmag_ir::ResolvedFdmDemagBoundaryIR::Open => fullmag_engine::FdmDemagBoundary::Open,
        fullmag_ir::ResolvedFdmDemagBoundaryIR::PeriodicTruncatedImages { image_counts } => {
            fullmag_engine::FdmDemagBoundary::PeriodicTruncatedImages { image_counts }
        }
    })
}

/// Re-check the planner's resolved single-grid budget immediately before any
/// CPU/CUDA engine allocation.  The runner must reject forged or stale plans
/// whose payload lengths do not match the checked grid cell count.
pub(crate) fn validate_single_grid_budget(
    plan: &fullmag_ir::FdmPlanIR,
) -> Result<u64, RunError> {
    // Production callers always use strict certificate enforcement.  The
    // cfg(test) opt-in below exists only for legacy hand-built unit fixtures;
    // planner-produced plans never take this compatibility path.
    validate_single_grid_budget_with_policy(plan, cfg!(test))
}

fn validate_single_grid_budget_with_policy(
    plan: &fullmag_ir::FdmPlanIR,
    allow_legacy_fixture: bool,
) -> Result<u64, RunError> {
    if plan.origin_m.iter().any(|component| !component.is_finite()) {
        return Err(RunError {
            message: format!(
                "FDM grid origin must contain finite metre coordinates, got {:?}",
                plan.origin_m
            ),
        });
    }
    let cost = fullmag_plan::checked_fdm_grid_cost(
        plan.grid.cells,
        fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
    )
    .map_err(|error| RunError {
        message: format!("FDM grid budget rejected before allocation: {error}"),
    })?;
    let _legacy_certificate: fullmag_ir::FdmGridCertificateIR;
    let certificate = match plan.grid_certificate.as_ref() {
        Some(certificate) => certificate,
        None => {
            if allow_legacy_fixture {
                _legacy_certificate = fullmag_ir::FdmGridCertificateIR::new_with_masks(
                    plan.origin_m,
                    plan.grid.cells,
                    plan.cell_size,
                    plan.active_mask
                        .as_ref()
                        .map(|mask| mask.iter().filter(|active| **active).count() as u64)
                        .unwrap_or_else(|| {
                            (plan.grid.cells[0] as u64)
                                * (plan.grid.cells[1] as u64)
                                * (plan.grid.cells[2] as u64)
                        }),
                    cost.estimated_bytes,
                    plan.active_mask.as_deref(),
                    &plan.region_mask,
                )
                .map_err(|message| RunError {
                    message: format!("legacy test FDM grid certificate failed: {message}"),
                })?;
                &_legacy_certificate
            } else {
                return Err(RunError {
                    message: "FDM grid certificate is required before runner allocation".to_string(),
                });
            }
        }
    };
    certificate
        .validate_against_masks(plan.active_mask.as_deref(), &plan.region_mask)
        .map_err(|message| RunError {
            message: format!("FDM grid certificate rejected before allocation: {message}"),
        })?;
    if certificate.origin_m != plan.origin_m
        || certificate.counts != plan.grid.cells
        || certificate.cell_m != plan.cell_size
        || certificate.estimated_bytes != cost.estimated_bytes
    {
        return Err(RunError {
            message: format!(
                "FDM grid certificate does not match resolved plan: certificate_counts={:?} plan_counts={:?}",
                certificate.counts, plan.grid.cells
            ),
        });
    }
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
    let active_cells = plan
        .active_mask
        .as_ref()
        .map(|mask| mask.iter().filter(|active| **active).count() as u64)
        .unwrap_or(cost.cells);
    if certificate.active_cells != active_cells {
        return Err(RunError {
            message: format!(
                "FDM grid certificate active count mismatch: certificate={} resolved={active_cells}",
                certificate.active_cells
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
    let _legacy_certificate: fullmag_ir::FdmGridCertificateIR;
    let certificate = match plan.grid_certificate.as_ref() {
        Some(certificate) => certificate,
        None => {
            #[cfg(test)]
            {
                let topology_tokens = fullmag_ir::fdm_multilayer_topology_tokens(&plan.layers);
                _legacy_certificate = fullmag_ir::FdmGridCertificateIR::new_with_masks(
                    plan.layers
                        .iter()
                        .fold([f64::INFINITY; 3], |mut origin, layer| {
                            for axis in 0..3 {
                                origin[axis] = origin[axis].min(layer.native_origin[axis]);
                            }
                            origin
                        }),
                    plan.common_cells,
                    plan.layers
                        .first()
                        .map(|layer| layer.convolution_cell_size)
                        .unwrap_or([0.0; 3]),
                    (plan.common_cells[0] as u64)
                        * (plan.common_cells[1] as u64)
                        * (plan.common_cells[2] as u64),
                    cost.estimated_bytes,
                    None,
                    &topology_tokens,
                )
                .map_err(|message| RunError {
                    message: format!("legacy test multilayer grid certificate failed: {message}"),
                })?;
                &_legacy_certificate
            }
            #[cfg(not(test))]
            {
                return Err(RunError {
                    message: "FDM multilayer grid certificate is required before runner allocation".to_string(),
                });
            }
        }
    };
    let topology_tokens = fullmag_ir::fdm_multilayer_topology_tokens(&plan.layers);
    certificate
        .validate_against_masks(None, &topology_tokens)
        .map_err(|message| RunError {
        message: format!("FDM multilayer grid certificate rejected before allocation: {message}"),
        })?;
    let expected_origin = plan
        .layers
        .iter()
        .fold([f64::INFINITY; 3], |mut origin, layer| {
            for axis in 0..3 {
                origin[axis] = origin[axis].min(layer.native_origin[axis]);
            }
            origin
        });
    let expected_cell = plan
        .layers
        .first()
        .map(|layer| layer.convolution_cell_size)
        .unwrap_or([0.0; 3]);
    if plan
        .layers
        .iter()
        .any(|layer| layer.convolution_cell_size != expected_cell)
    {
        return Err(RunError {
            message: "FDM multilayer layer convolution cell sizes disagree with the certified common grid"
                .to_string(),
        });
    }
    if certificate.origin_m != expected_origin
        || certificate.counts != plan.common_cells
        || certificate.cell_m != expected_cell
        || certificate.estimated_bytes != cost.estimated_bytes
        || certificate.active_cells != cost.cells
    {
        return Err(RunError {
            message: format!(
                "FDM multilayer grid certificate does not match resolved common grid: certificate_counts={:?} common_counts={:?}",
                certificate.counts, plan.common_cells
            ),
        });
    }
    let mut aggregate_bytes = cost.estimated_bytes;
    for layer in &plan.layers {
        if layer.convolution_grid != plan.common_cells {
            return Err(RunError {
                message: format!(
                    "FDM multilayer convolution grid mismatch: magnet='{}' layer_grid={:?} common_grid={:?}",
                    layer.magnet_name, layer.convolution_grid, plan.common_cells
                ),
            });
        }
        let layer_cost = fullmag_plan::checked_fdm_grid_cost(
            layer.native_grid,
            fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
        )
        .map_err(|error| RunError {
            message: format!("FDM native layer grid budget rejected before allocation: {error}"),
        })?;
        aggregate_bytes = aggregate_bytes
            .checked_add(layer_cost.estimated_bytes)
            .ok_or_else(|| RunError {
                message: "FDM multilayer aggregate grid memory overflow before allocation"
                    .to_string(),
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
    let computed_unique_kernels = if let Some(first_layer) = plan.layers.first() {
        let cell_z = first_layer.convolution_cell_size[2];
        if !cell_z.is_finite() || cell_z <= 0.0 {
            return Err(RunError {
                message: "FDM multilayer convolution cell size must be finite and positive"
                    .to_string(),
            });
        }
        let mut shifts = BTreeSet::new();
        for dst in &plan.layers {
            for src in &plan.layers {
                shifts.insert(
                    ((dst.native_origin[2] - src.native_origin[2]) / cell_z).round() as i64,
                );
            }
        }
        shifts.len() as u64
    } else {
        0
    };
    let padded_cells = plan.common_cells.iter().try_fold(1u64, |acc, cells| {
        acc.checked_mul((*cells as u64).checked_mul(2)?)
    });
    let computed_kernel_bytes = padded_cells
        .and_then(|cells| cells.checked_mul(6))
        .and_then(|bytes| bytes.checked_mul(16))
        .and_then(|bytes| bytes.checked_mul(computed_unique_kernels));
    let computed_kernel_bytes = computed_kernel_bytes.ok_or_else(|| RunError {
        message: "FDM multilayer kernel memory overflow before allocation".to_string(),
    })?;
    if plan.planner_summary.estimated_kernel_bytes != computed_kernel_bytes {
        return Err(RunError {
            message: format!(
                "FDM multilayer kernel estimate mismatch: summary={} recomputed={computed_kernel_bytes}",
                plan.planner_summary.estimated_kernel_bytes
            ),
        });
    }
    aggregate_bytes = aggregate_bytes
        .checked_add(computed_kernel_bytes)
        .ok_or_else(|| RunError {
            message: "FDM multilayer aggregate kernel memory overflow before allocation"
                .to_string(),
        })?;
    if aggregate_bytes > fullmag_plan::FDM_GRID_MAX_BYTES {
        return Err(RunError {
            message: format!(
                "FDM multilayer aggregate memory budget exceeded: estimated_bytes={aggregate_bytes} max_bytes={}",
                fullmag_plan::FDM_GRID_MAX_BYTES
            ),
        });
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
        plan.cell_size = [1.0, 1.0, 1.0];
        plan.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new(
                plan.origin_m,
                plan.grid.cells,
                plan.cell_size,
                4,
                4 * fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
            )
            .expect("test certificate should be valid"),
        );
        plan.initial_magnetization = vec![[0.0, 0.0, 1.0]; 3];

        let error = validate_single_grid_budget(&plan).expect_err("payload length must be checked");
        assert!(error.message.contains("initial_magnetization_len=3"));
        assert!(error.message.contains("resolved_cells=4"));
    }

    #[test]
    fn non_finite_grid_origin_is_rejected_before_allocation() {
        let mut plan = FdmPlanIR::default();
        plan.grid.cells = [1, 1, 1];
        plan.initial_magnetization = vec![[0.0, 0.0, 1.0]];
        plan.origin_m = [f64::NAN, 0.0, 0.0];

        let error = validate_single_grid_budget(&plan)
            .expect_err("non-finite origin must be rejected before allocation");
        assert!(error.message.contains("origin must contain finite"));
    }

    #[test]
    fn grid_certificate_rejects_active_mask_swap() {
        let mut plan = FdmPlanIR::default();
        plan.grid.cells = [2, 1, 1];
        plan.cell_size = [1.0, 1.0, 1.0];
        plan.initial_magnetization = vec![[0.0, 0.0, 1.0]; 2];
        plan.active_mask = Some(vec![true, false]);
        plan.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new_with_masks(
                plan.origin_m,
                plan.grid.cells,
                plan.cell_size,
                1,
                2 * fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
                plan.active_mask.as_deref(),
                &plan.region_mask,
            )
            .expect("test certificate should be valid"),
        );
        plan.active_mask = Some(vec![false, true]);

        let error = validate_single_grid_budget(&plan)
            .expect_err("topology changes must invalidate the grid certificate");
        assert!(error.message.contains("fingerprint mismatch"));
    }

    #[test]
    fn production_policy_rejects_missing_grid_certificate() {
        let mut plan = FdmPlanIR::default();
        plan.grid.cells = [1, 1, 1];
        plan.cell_size = [1.0, 1.0, 1.0];
        plan.initial_magnetization = vec![[0.0, 0.0, 1.0]];

        let error = super::validate_single_grid_budget_with_policy(&plan, false)
            .expect_err("production policy must reject missing certificates");
        assert!(error.message.contains("certificate is required"));
    }
}
