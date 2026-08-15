pub(crate) mod artifacts;
pub(crate) mod cpu;
pub(crate) mod gpu;
pub(crate) mod multilayer;
pub(crate) mod schedules;

use crate::types::RunError;

#[cfg(any(feature = "cuda", test))]
pub(crate) fn next_fdm_attempt_dt(
    adaptive: bool,
    current_dt: f64,
    suggested_dt: Option<f64>,
) -> f64 {
    if adaptive {
        suggested_dt.unwrap_or(current_dt)
    } else {
        current_dt
    }
}

#[cfg(test)]
mod timestep_tests {
    use super::next_fdm_attempt_dt;

    #[test]
    fn cuda_batch_consumes_accepted_dt_suggested_only_for_adaptive_policy() {
        assert_eq!(next_fdm_attempt_dt(true, 1.0e-15, Some(4.0e-16)), 4.0e-16);
        assert_eq!(next_fdm_attempt_dt(true, 1.0e-15, None), 1.0e-15);
        assert_eq!(next_fdm_attempt_dt(false, 1.0e-15, Some(4.0e-16)), 1.0e-15);
    }
}

pub(crate) fn reject_adaptive_multilayer_plan(
    plan: &fullmag_ir::FdmMultilayerPlanIR,
) -> Result<(), RunError> {
    if plan.fixed_timestep.is_none() {
        return Err(RunError {
            message: "adaptive time stepping is unsupported for multilayer FDM runtimes; an explicit fixed_timestep is required before native materialization".to_string(),
        });
    }
    Ok(())
}

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
pub(crate) fn validate_single_grid_budget(plan: &fullmag_ir::FdmPlanIR) -> Result<u64, RunError> {
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
    let cells = usize::try_from(cost.cells).map_err(|_| RunError {
        message: format!(
            "FDM grid cell count {} is not addressable on this runtime",
            cost.cells
        ),
    })?;
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
    if plan
        .sot_active_mask
        .as_ref()
        .is_some_and(|mask| mask.len() != cells)
    {
        return Err(RunError {
            message: format!(
                "prescribed SOT runtime contract target-mask length does not equal resolved_cells={cells}"
            ),
        });
    }
    validate_resolved_periodic_workspace(
        plan.periodicity.as_ref(),
        plan.resolved_periodic_images.as_ref(),
        plan.grid.cells,
        plan.precision,
    )?;
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
                    message: "FDM grid certificate is required before runner allocation"
                        .to_string(),
                });
            }
        }
    };
    certificate
        .validate_against_masks(plan.active_mask.as_deref(), &plan.region_mask)
        .map_err(|message| RunError {
            message: format!("FDM grid certificate rejected before allocation: {message}"),
        })?;
    fullmag_ir::validate_fdm_region_lut_indices(&plan.region_mask, &plan.inter_region_exchange)
        .map_err(|message| RunError { message })?;
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
    if plan.initial_magnetization.len() != cells {
        return Err(RunError {
            message: format!(
                "FDM grid payload mismatch: initial_magnetization_len={} resolved_cells={cells}",
                plan.initial_magnetization.len()
            ),
        });
    }
    let has_any_prescribed_sot = plan.sot_current_density.is_some()
        || plan.sot_xi_dl.is_some()
        || plan.sot_xi_fl.is_some()
        || plan.sot_sigma.is_some()
        || plan.sot_thickness.is_some()
        || plan.sot_formula_version.is_some()
        || plan.sot_target.is_some()
        || plan.sot_active_mask.is_some()
        || plan.sot_envelope.is_some()
        || plan.sot_drive.is_some();
    if has_any_prescribed_sot {
        let base_complete = plan.sot_current_density.is_some()
            && plan.sot_xi_dl.is_some()
            && plan.sot_xi_fl.is_some()
            && plan.sot_sigma.is_some()
            && plan.sot_thickness.is_some();
        if !base_complete {
            return Err(RunError {
                message: "prescribed SOT runtime contract requires a complete current, efficiency, polarization, and thickness payload"
                    .to_string(),
            });
        }
        let current_density = plan
            .sot_current_density
            .expect("complete contract checked above");
        let xi_dl = plan.sot_xi_dl.expect("complete contract checked above");
        let xi_fl = plan.sot_xi_fl.expect("complete contract checked above");
        let sigma = plan.sot_sigma.expect("complete contract checked above");
        let thickness = plan.sot_thickness.expect("complete contract checked above");
        let sigma_norm_sq = sigma
            .iter()
            .map(|component| component * component)
            .sum::<f64>();
        if !current_density.is_finite()
            || !xi_dl.is_finite()
            || !xi_fl.is_finite()
            || !thickness.is_finite()
            || thickness <= 0.0
            || sigma.iter().any(|component| !component.is_finite())
            || !sigma_norm_sq.is_finite()
        {
            return Err(RunError {
                message: "prescribed SOT runtime contract contains invalid physical parameters"
                    .to_string(),
            });
        }
        match plan.sot_formula_version.as_deref() {
            Some("prescribed_sot.fullmag.v1") => {
                if plan.sot_envelope.as_ref().is_some_and(|envelope| {
                    !matches!(envelope, fullmag_ir::TimeEnvelopeIR::Constant { .. })
                }) {
                    return Err(RunError {
                        message:
                            "prescribed SOT non-constant envelope requires_stage_time_execution"
                                .to_string(),
                    });
                }
                if sigma_norm_sq <= 0.0
                    || plan.sot_target.is_none()
                    || plan.sot_active_mask.is_none()
                    || plan.sot_drive.is_none()
                {
                    return Err(RunError {
                        message: "prescribed SOT runtime contract v1 requires nonzero sigma, target, and target mask"
                            .to_string(),
                    });
                }
                let target_mask = plan.sot_active_mask.as_ref().expect("checked above");
                if !target_mask.iter().any(|selected| *selected) {
                    return Err(RunError {
                        message: "prescribed SOT runtime contract target mask selects no active FDM cells"
                            .to_string(),
                    });
                }
                if target_mask.iter().enumerate().any(|(index, selected)| {
                    *selected
                        && plan
                            .active_mask
                            .as_ref()
                            .is_some_and(|active| !active.get(index).copied().unwrap_or(false))
                }) {
                    return Err(RunError {
                        message: "prescribed SOT runtime contract target mask selects an inactive FDM cell"
                            .to_string(),
                    });
                }
            }
            None | Some("prescribed_sot.legacy_fullmag.v0") => {
                if plan.sot_target.is_some()
                    || plan.sot_active_mask.is_some()
                    || plan.sot_envelope.is_some()
                    || plan.sot_drive.is_some()
                {
                    return Err(RunError {
                        message: "legacy prescribed SOT runtime contract requires historical global target semantics without a target mask"
                            .to_string(),
                    });
                }
            }
            Some(other) => {
                return Err(RunError {
                    message: format!("unsupported prescribed SOT formula_version '{other}'"),
                });
            }
        }
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
    admission_model: fullmag_fdm_demag::KernelAdmissionModel,
) -> Result<u64, RunError> {
    if let Err(errors) = plan.validate() {
        return Err(RunError {
            message: format!(
                "FDM multilayer plan contract rejected before allocation: {}",
                errors.join("; ")
            ),
        });
    }
    if let Some(layer) = plan
        .layers
        .iter()
        .find(|layer| layer.transfer_kind == "unsupported")
    {
        return Err(RunError {
            message: format!(
                "FDM multilayer layer '{}' has unsupported transfer; refusing runtime allocation",
                layer.layer_id
            ),
        });
    }
    let cost = fullmag_plan::checked_fdm_grid_cost(
        plan.common_cells,
        fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
    )
    .map_err(|error| RunError {
        message: format!("FDM common grid budget rejected before allocation: {error}"),
    })?;
    validate_resolved_periodic_workspace(
        plan.periodicity.as_ref(),
        plan.resolved_periodic_images.as_ref(),
        plan.common_cells,
        plan.precision,
    )?;
    let _legacy_certificate: fullmag_ir::FdmGridCertificateIR;
    let certificate = match plan.grid_certificate.as_ref() {
        Some(certificate) => certificate,
        None => {
            #[cfg(test)]
            {
                let topology_tokens =
                    fullmag_ir::fdm_multilayer_topology_tokens(&plan.mode, &plan.layers);
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
                    message: "FDM multilayer grid certificate is required before runner allocation"
                        .to_string(),
                });
            }
        }
    };
    let topology_tokens = fullmag_ir::fdm_multilayer_topology_tokens(&plan.mode, &plan.layers);
    certificate
        .validate_against_topology_tokens(None, &topology_tokens)
        .map_err(|message| RunError {
            message: format!(
                "FDM multilayer grid certificate rejected before allocation: {message}"
            ),
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
    let resolved_kernel_memory = fullmag_plan::resolve_multilayer_kernel_memory(
        &plan.mode,
        plan.common_cells,
        &plan.layers,
        plan.precision,
        plan.enable_demag,
        admission_model,
    )
    .map_err(|error| RunError {
        message: format!(
            "FDM multilayer kernel catalog rejected before allocation: {}",
            error.reasons.join("; ")
        ),
    })?;
    let computed_kernel_bytes = resolved_kernel_memory.accounting.admission_bytes;
    let computed_unique_kernels = resolved_kernel_memory.catalog.keys.len() as u32;
    let computed_pair_kernels = resolved_kernel_memory.catalog.pair_bindings.len() as u32;
    if plan.planner_summary.estimated_unique_kernels != computed_unique_kernels
        || plan.planner_summary.estimated_pair_kernels != computed_pair_kernels
    {
        return Err(RunError {
            message: format!(
                "FDM multilayer kernel catalog count mismatch: summary_unique={} recomputed_unique={computed_unique_kernels} summary_pairs={} recomputed_pairs={computed_pair_kernels}",
                plan.planner_summary.estimated_unique_kernels,
                plan.planner_summary.estimated_pair_kernels
            ),
        });
    }
    if plan.planner_summary.estimated_kernel_bytes != computed_kernel_bytes {
        return Err(RunError {
            message: format!(
                "FDM multilayer kernel estimate mismatch: model={} summary={} recomputed={computed_kernel_bytes}",
                admission_model.as_str(), plan.planner_summary.estimated_kernel_bytes
            ),
        });
    }
    debug_assert_eq!(
        resolved_kernel_memory.common_grid_bytes,
        cost.estimated_bytes
    );
    Ok(cost.cells)
}

fn validate_resolved_periodic_workspace(
    periodicity: Option<&fullmag_ir::FdmPeriodicityIR>,
    resolved: Option<&fullmag_ir::ResolvedPeriodicImagesIR>,
    grid_counts: [u32; 3],
    precision: fullmag_ir::ExecutionPrecision,
) -> Result<(), RunError> {
    let Some(periodicity) = periodicity else {
        if resolved.is_some() {
            return Err(RunError {
                message: "resolved periodic workspace is present without requested periodicity"
                    .to_string(),
            });
        }
        return Ok(());
    };
    let expected = periodicity
        .resolve_periodic_images(grid_counts, precision)
        .map_err(|reason| RunError { message: reason })?;
    if expected.as_ref() != resolved {
        return Err(RunError {
            message: format!(
                "resolved periodic workspace contract mismatch: expected={expected:?} plan={resolved:?}"
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{validate_multilayer_grid_budget, validate_single_grid_budget};
    use fullmag_fdm_demag::KernelAdmissionModel;
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FdmLayerPlanIR, FdmMaterialIR,
        FdmMultilayerPlanIR, FdmMultilayerSummaryIR, FdmPlanIR, IntegratorChoice,
    };

    fn valid_multilayer_plan() -> FdmMultilayerPlanIR {
        let layer = |name: &str, origin_z: f64, magnetization: [f64; 3]| FdmLayerPlanIR {
            magnet_name: name.to_string(),
            layer_id: format!("layer:{name}"),
            object_id: name.to_string(),
            native_grid: [1, 1, 1],
            native_cell_size: [1.0, 1.0, 1.0],
            native_origin: [0.0, 0.0, origin_z],
            native_active_mask: None,
            native_region_mask: None,
            native_region_legend: None,
            initial_magnetization: vec![magnetization],
            material: FdmMaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.1,
                ..Default::default()
            },
            convolution_grid: [1, 1, 1],
            convolution_cell_size: [1.0, 1.0, 1.0],
            convolution_origin: [0.0, 0.0, origin_z],
            transfer_kind: "identity".to_string(),
        };
        let mut plan = FdmMultilayerPlanIR {
            mode: "three_d".to_string(),
            common_cells: [1, 1, 1],
            requested_common_cell_size: None,
            grid_certificate: None,
            layers: vec![
                layer("free", 0.0, [1.0, 0.0, 0.0]),
                layer("ref", 2.0, [0.0, 1.0, 0.0]),
            ],
            enable_exchange: true,
            enable_demag: true,
            external_field: None,
            interfacial_dmi: None,
            bulk_dmi: None,
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            periodicity: None,
            resolved_periodic_images: None,
            integrator: IntegratorChoice::Heun,
            fixed_timestep: Some(1e-13),
            field_refresh: None,
            relaxation: None,
            planner_summary: FdmMultilayerSummaryIR {
                requested_strategy: "multilayer_convolution".to_string(),
                selected_strategy: "multilayer_convolution".to_string(),
                requested_mode: "three_d".to_string(),
                resolved_mode: "three_d".to_string(),
                eligibility: "eligible".to_string(),
                estimated_pair_kernels: 4,
                estimated_unique_kernels: 3,
                estimated_kernel_bytes: 2_304,
                warnings: Vec::new(),
            },
        };
        let topology_tokens = fullmag_ir::fdm_multilayer_topology_tokens(&plan.mode, &plan.layers);
        plan.grid_certificate = Some(
            fullmag_ir::FdmGridCertificateIR::new_with_topology_tokens(
                [0.0, 0.0, 0.0],
                [1, 1, 1],
                [1.0, 1.0, 1.0],
                1,
                fullmag_plan::FDM_GRID_ESTIMATED_BYTES_PER_CELL,
                None,
                &topology_tokens,
            )
            .expect("test certificate should bind the multilayer topology"),
        );
        plan
    }

    #[test]
    fn stale_multilayer_kernel_summary_is_rejected_before_allocation() {
        let mut plan = valid_multilayer_plan();
        plan.planner_summary.estimated_kernel_bytes = 3_072;
        let error = validate_multilayer_grid_budget(&plan, KernelAdmissionModel::CpuFp64Catalog)
            .expect_err("pair-payload summary must fail CPU catalog admission");
        assert!(
            error.message.contains("kernel estimate mismatch"),
            "unexpected preflight error: {}",
            error.message
        );
        assert!(
            error.message.contains("summary=3072"),
            "unexpected preflight error: {}",
            error.message
        );
        assert!(
            error.message.contains("recomputed=2352"),
            "unexpected preflight error: {}",
            error.message
        );
    }

    #[test]
    fn stale_multilayer_pair_and_unique_counts_are_rejected_before_allocation() {
        let mut stale_pair = valid_multilayer_plan();
        stale_pair.planner_summary.estimated_pair_kernels -= 1;
        let pair_error =
            validate_multilayer_grid_budget(&stale_pair, KernelAdmissionModel::CpuFp64Catalog)
                .expect_err("stale pair count must fail before allocation");
        assert!(pair_error.message.contains("kernel catalog count mismatch"));

        let mut stale_unique = valid_multilayer_plan();
        stale_unique.planner_summary.estimated_unique_kernels -= 1;
        let unique_error =
            validate_multilayer_grid_budget(&stale_unique, KernelAdmissionModel::CpuFp64Catalog)
                .expect_err("stale unique count must fail before allocation");
        assert!(unique_error
            .message
            .contains("kernel catalog count mismatch"));
    }

    #[test]
    fn cuda_abi_v2_preflight_requires_l_squared_pair_payload() {
        let mut plan = valid_multilayer_plan();
        plan.planner_summary.estimated_kernel_bytes = 3_120;

        validate_multilayer_grid_budget(&plan, KernelAdmissionModel::CudaAbiV2PairPayload)
            .expect("CUDA ABI v2 must admit all four ordered pair tensors");
    }

    #[test]
    fn native_stacked_preflight_requires_zero_multilayer_kernel_payload() {
        let mut plan = valid_multilayer_plan();
        plan.planner_summary.estimated_pair_kernels = 0;
        plan.planner_summary.estimated_unique_kernels = 0;
        plan.planner_summary.estimated_kernel_bytes = 0;

        validate_multilayer_grid_budget(&plan, KernelAdmissionModel::CudaNativeSingleGrid)
            .expect("native stacked single-grid path must not admit multilayer pair tensors");
    }

    #[test]
    fn inactive_demag_accepts_zero_kernel_summary_without_payload_admission() {
        let mut plan = valid_multilayer_plan();
        plan.enable_demag = false;
        plan.planner_summary.estimated_kernel_bytes = 0;

        validate_multilayer_grid_budget(&plan, KernelAdmissionModel::CpuFp64Catalog)
            .expect("inactive demag must not admit a pair-kernel payload");
    }

    #[test]
    fn inactive_demag_rejects_stale_nonzero_kernel_summary() {
        let mut plan = valid_multilayer_plan();
        plan.enable_demag = false;
        plan.planner_summary.estimated_kernel_bytes = 3_072;

        let error = validate_multilayer_grid_budget(&plan, KernelAdmissionModel::CpuFp64Catalog)
            .expect_err("inactive demag must reject stale nonzero kernel telemetry");
        assert!(
            error.message.contains("kernel estimate mismatch"),
            "unexpected preflight error: {}",
            error.message
        );
        assert!(
            error.message.contains("summary=3072"),
            "unexpected preflight error: {}",
            error.message
        );
        assert!(
            error.message.contains("recomputed=0"),
            "unexpected preflight error: {}",
            error.message
        );
    }

    fn valid_prescribed_sot_plan() -> FdmPlanIR {
        let mut plan = FdmPlanIR::default();
        plan.grid.cells = [2, 1, 1];
        plan.cell_size = [1.0, 1.0, 1.0];
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]; 2];
        plan.active_mask = Some(vec![true, false]);
        plan.sot_formula_version = Some("prescribed_sot.fullmag.v1".to_string());
        plan.sot_target = Some(fullmag_ir::RegionRefIR {
            object_id: "strip".to_string(),
            region_id: None,
        });
        plan.sot_active_mask = Some(vec![true, false]);
        plan.sot_current_density = Some(-1.0e11);
        plan.sot_xi_dl = Some(0.1);
        plan.sot_xi_fl = Some(0.0);
        plan.sot_sigma = Some([0.0, 1.0, 0.0]);
        plan.sot_thickness = Some(1.0e-9);
        plan.sot_drive = Some(fullmag_ir::PrescribedSotV1DriveIR::SignedScalar {
            current_density_apm2: -1.0e11,
            sigma_hat: [0.0, 1.0, 0.0],
            envelope: None,
        });
        plan
    }

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

    #[test]
    fn unversioned_legacy_sot_payload_retains_global_compatibility_execution() {
        let mut plan = FdmPlanIR::default();
        plan.grid.cells = [1, 1, 1];
        plan.cell_size = [1.0, 1.0, 1.0];
        plan.initial_magnetization = vec![[1.0, 0.0, 0.0]];
        plan.sot_current_density = Some(1.0e11);
        plan.sot_xi_dl = Some(0.1);
        plan.sot_xi_fl = Some(0.0);
        plan.sot_sigma = Some([0.0, 1.0, 0.0]);
        plan.sot_thickness = Some(1.0e-9);

        assert_eq!(validate_single_grid_budget(&plan).unwrap(), 1);
    }

    #[test]
    fn prescribed_sot_forged_plan_cases_fail_closed_without_panicking() {
        let mut cases = Vec::new();

        let mut wrong_formula = valid_prescribed_sot_plan();
        wrong_formula.sot_formula_version = Some("prescribed_sot.unknown".to_string());
        cases.push((wrong_formula, "unsupported prescribed SOT formula_version"));

        let mut short_mask = valid_prescribed_sot_plan();
        short_mask.sot_active_mask = Some(vec![true]);
        cases.push((short_mask, "target-mask length"));

        let mut empty_mask = valid_prescribed_sot_plan();
        empty_mask.sot_active_mask = Some(vec![false, false]);
        cases.push((empty_mask, "selects no active"));

        let mut inactive_mask = valid_prescribed_sot_plan();
        inactive_mask.sot_active_mask = Some(vec![false, true]);
        cases.push((inactive_mask, "selects an inactive"));

        let mut nonfinite = valid_prescribed_sot_plan();
        nonfinite.sot_current_density = Some(f64::NAN);
        cases.push((nonfinite, "invalid physical parameters"));

        let mut zero_sigma = valid_prescribed_sot_plan();
        zero_sigma.sot_sigma = Some([0.0; 3]);
        cases.push((zero_sigma, "requires nonzero sigma"));

        let mut bad_thickness = valid_prescribed_sot_plan();
        bad_thickness.sot_thickness = Some(0.0);
        cases.push((bad_thickness, "invalid physical parameters"));

        for (plan, expected) in cases {
            let result = std::panic::catch_unwind(|| validate_single_grid_budget(&plan));
            let error = result
                .expect("forged SOT plan validation must not panic")
                .expect_err("forged SOT plan must fail closed");
            assert!(
                error.message.contains(expected),
                "expected {expected:?} in {:?}",
                error.message
            );
        }
    }

    #[test]
    fn short_global_active_mask_fails_before_certificate_or_sot_indexing() {
        let mut plan = valid_prescribed_sot_plan();
        plan.active_mask = Some(vec![true]);
        let result = std::panic::catch_unwind(|| validate_single_grid_budget(&plan));
        let error = result
            .expect("short global active mask must not panic")
            .expect_err("short global active mask must fail closed");
        assert!(error.message.contains("active_mask_len"));
    }

    #[test]
    fn stale_resolved_periodic_workspace_is_rejected_before_lane_allocation() {
        let mut plan = FdmPlanIR::default();
        plan.grid.cells = [8, 8, 8];
        plan.cell_size = [1.0, 1.0, 1.0];
        plan.initial_magnetization = vec![[0.0, 0.0, 1.0]; 512];
        plan.periodicity = Some(fullmag_ir::FdmPeriodicityIR {
            axes: [
                fullmag_ir::AxisBoundary::Periodic,
                fullmag_ir::AxisBoundary::Open,
                fullmag_ir::AxisBoundary::Open,
            ],
            demag: fullmag_ir::FdmDemagPeriodicityIR::TruncatedImages,
            image_counts: Some([3, 0, 0]),
        });
        plan.resolved_periodic_images = Some(fullmag_ir::ResolvedPeriodicImagesIR {
            requested_image_counts: [3, 0, 0],
            resolved_image_counts: [3, 0, 0],
            padded_counts: [7, 16, 16],
            image_terms: 7,
            estimated_bytes: 393_216,
            kernel: "newell_truncated_images_fft".to_string(),
        });
        let error = validate_single_grid_budget(&plan)
            .expect_err("stale resolved workspace must fail before allocation");
        assert!(error
            .message
            .contains("resolved periodic workspace contract mismatch"));
    }
}
