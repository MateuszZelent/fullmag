//! Shared FDM artifact helpers.

use crate::types::{AuxiliaryArtifact, RunError, StateObservables};
use fullmag_ir::{BackendPlanIR, ExecutionPlanIR};

/// Serialize the planner-owned FDM grid certificate as a standalone artifact.
///
/// The runner never reconstructs certificate values from geometry; it only
/// publishes the validated resolved certificate carried by the execution plan.
pub(crate) fn grid_certificate_artifacts(
    plan: &ExecutionPlanIR,
) -> Vec<AuxiliaryArtifact> {
    let certificate = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => fdm.grid_certificate.as_ref(),
        BackendPlanIR::FdmMultilayer(multilayer) => multilayer.grid_certificate.as_ref(),
        _ => None,
    };
    let Some(certificate) = certificate else {
        return Vec::new();
    };
    let Ok(bytes) = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": "fdm_grid_certificate.v1",
        "certificate": certificate,
    })) else {
        return Vec::new();
    };
    vec![AuxiliaryArtifact {
        relative_path: "mesh/fdm_grid_certificate.json".to_string(),
        bytes,
    }]
}

/// Persist the resolved native-to-convolution transfer contract for a
/// multilayer FDM run.  The artifact is intentionally derived from the
/// planner certificate and periodicity, never from runtime-local grid state.
pub(crate) fn transfer_provenance_artifacts(
    plan: &ExecutionPlanIR,
) -> Vec<AuxiliaryArtifact> {
    let BackendPlanIR::FdmMultilayer(multilayer) = &plan.backend_plan else {
        return Vec::new();
    };
    let Some(target_certificate) = multilayer.grid_certificate.as_ref() else {
        return Vec::new();
    };
    let periodic_axes = multilayer
        .periodicity
        .as_ref()
        .map(|pbc| {
            pbc.axes
                .map(|axis| matches!(axis, fullmag_ir::AxisBoundary::Periodic))
        })
        .unwrap_or([false; 3]);
    let boundary_policy = multilayer
        .periodicity
        .as_ref()
        .map(|pbc| {
            pbc.axes.map(|axis| match axis {
                fullmag_ir::AxisBoundary::Periodic => "periodic",
                fullmag_ir::AxisBoundary::Open => "open",
            })
        })
        .unwrap_or(["open"; 3]);
    let transfers = multilayer
        .layers
        .iter()
        .filter_map(|layer| {
            let active_cells = layer
                .native_active_mask
                .as_ref()
                .map(|mask| mask.iter().filter(|is_active| **is_active).count() as u64)
                .unwrap_or_else(|| {
                    u64::from(layer.native_grid[0])
                        * u64::from(layer.native_grid[1])
                        * u64::from(layer.native_grid[2])
                });
            let source_certificate = fullmag_ir::FdmGridCertificateIR::new(
                layer.native_origin,
                layer.native_grid,
                layer.native_cell_size,
                active_cells,
                1,
            )
            .ok()?;
            Some(serde_json::json!({
                "magnet_name": layer.magnet_name,
                "transfer_kind": layer.transfer_kind,
                "source_grid_fingerprint": source_certificate.grid_fingerprint,
                "target_grid_fingerprint": target_certificate.grid_fingerprint,
                "source_grid": {
                    "origin_m": layer.native_origin,
                    "cells": layer.native_grid,
                    "cell_m": layer.native_cell_size,
                },
                "target_grid": {
                    "origin_m": target_certificate.origin_m,
                    "cells": target_certificate.counts,
                    "cell_m": target_certificate.cell_m,
                },
                "periodic_axes": periodic_axes,
                "boundary_policy": boundary_policy,
            }))
        })
        .collect::<Vec<_>>();
    let Ok(bytes) = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": "fdm_transfer_provenance.v1",
        "backend": "fdm_multilayer",
        "target_grid_fingerprint": target_certificate.grid_fingerprint,
        "periodic_axes": periodic_axes,
        "boundary_policy": boundary_policy,
        "transfers": transfers,
    })) else {
        return Vec::new();
    };
    vec![AuxiliaryArtifact {
        relative_path: "mesh/fdm_transfer_provenance.v1.json".to_string(),
        bytes,
    }]
}

pub(crate) fn select_state_observable_field(
    observables: &StateObservables,
    name: &str,
    include_oersted: bool,
) -> Result<Vec<[f64; 3]>, RunError> {
    if let Some(dot_pos) = name.find('.') {
        let base = &name[..dot_pos];
        let component = &name[dot_pos + 1..];
        let full = select_base_field(observables, base, include_oersted)?;
        let idx = match component {
            "x" => 0,
            "y" => 1,
            "z" => 2,
            _ => {
                return Err(RunError {
                    message: format!(
                        "snapshot '{}': unsupported component '{}' (use x, y, or z)",
                        name, component
                    ),
                });
            }
        };
        return Ok(full.iter().map(|value| [value[idx], 0.0, 0.0]).collect());
    }

    select_base_field(observables, name, include_oersted)
}

fn select_base_field(
    observables: &StateObservables,
    name: &str,
    include_oersted: bool,
) -> Result<Vec<[f64; 3]>, RunError> {
    Ok(match name {
        "m" => observables.magnetization.clone(),
        "H_ex" => observables.exchange_field.clone(),
        "H_demag" => observables.demag_field.clone(),
        "H_ext" => observables.external_field.clone(),
        "H_ani" => observables.anisotropy_field.clone(),
        "H_dmi" => observables.dmi_field.clone(),
        "H_eff" => observables.effective_field.clone(),
        "torque" => observables.torque_field.clone(),
        "H_OE" if include_oersted => observables.oersted_field.clone(),
        other => {
            let available = if include_oersted {
                "m, H_ex, H_demag, H_ext, H_ani, H_dmi, H_OE, H_eff, torque"
            } else {
                "m, H_ex, H_demag, H_ext, H_ani, H_dmi, H_eff, torque"
            };
            return Err(RunError {
                message: format!(
                    "FDM snapshot: field '{}' is not available in this execution path \
                     (available: {})",
                    other, available
                ),
            });
        }
    })
}
