//! Shared FDM artifact helpers.

use crate::{
    artifacts::build_identity_json,
    types::{AuxiliaryArtifact, ExecutionProvenance, RunError, StateObservables},
};
use fullmag_ir::{BackendPlanIR, ExecutionPlanIR};
use serde::Serialize;

#[derive(Debug, Serialize)]
struct FdmMagneticSupportSummary<'a> {
    semantic_role: &'static str,
    grid_fingerprint: &'a str,
    bounds_min_m: [f64; 3],
    bounds_max_m: [f64; 3],
    active_cell_count: u64,
    inactive_cell_count: u64,
    active_unassigned_cell_count: u64,
}

fn magnetic_support_summary<'a>(
    origin_m: [f64; 3],
    counts: [u32; 3],
    cell_m: [f64; 3],
    active_mask: Option<&[bool]>,
    region_mask: &[u32],
    grid_fingerprint: &'a str,
) -> Result<FdmMagneticSupportSummary<'a>, String> {
    let expected_cells = usize::try_from(
        counts
            .into_iter()
            .try_fold(1u64, |product, count| product.checked_mul(u64::from(count)))
            .ok_or_else(|| "FDM region membership cell count overflows u64".to_string())?,
    )
    .map_err(|_| "FDM region membership cell count is not addressable".to_string())?;
    if region_mask.len() != expected_cells
        || active_mask.is_some_and(|mask| mask.len() != expected_cells)
    {
        return Err("FDM magnetic-support mask length disagrees with grid cell count".to_string());
    }
    let nx = usize::try_from(counts[0])
        .map_err(|_| "FDM grid x cell count is not addressable".to_string())?;
    let ny = usize::try_from(counts[1])
        .map_err(|_| "FDM grid y cell count is not addressable".to_string())?;
    let plane_stride = nx
        .checked_mul(ny)
        .ok_or_else(|| "FDM grid xy plane size overflows usize".to_string())?;
    let mut support_min = [u32::MAX; 3];
    let mut support_max_exclusive = [0u32; 3];
    let mut active_cell_count = 0u64;
    let mut inactive_cell_count = 0u64;
    let mut active_unassigned_cell_count = 0u64;
    for (index, region_id) in region_mask.iter().enumerate() {
        if active_mask.is_some_and(|mask| !mask[index]) {
            inactive_cell_count = inactive_cell_count
                .checked_add(1)
                .ok_or_else(|| "FDM inactive cell count overflows u64".to_string())?;
            continue;
        }
        active_cell_count = active_cell_count
            .checked_add(1)
            .ok_or_else(|| "FDM active cell count overflows u64".to_string())?;
        if *region_id == 0 {
            active_unassigned_cell_count = active_unassigned_cell_count
                .checked_add(1)
                .ok_or_else(|| "FDM active-unassigned cell count overflows u64".to_string())?;
        }
        let coordinates = [
            u32::try_from(index % nx).map_err(|_| "FDM support x index exceeds u32".to_string())?,
            u32::try_from((index / nx) % ny)
                .map_err(|_| "FDM support y index exceeds u32".to_string())?,
            u32::try_from(index / plane_stride)
                .map_err(|_| "FDM support z index exceeds u32".to_string())?,
        ];
        for (axis, coordinate) in coordinates.into_iter().enumerate() {
            support_min[axis] = support_min[axis].min(coordinate);
            support_max_exclusive[axis] = support_max_exclusive[axis].max(
                coordinate
                    .checked_add(1)
                    .ok_or_else(|| "FDM support cell-edge index exceeds u32".to_string())?,
            );
        }
    }
    if active_cell_count == 0 {
        return Err("FDM magnetic support contains no active cells".to_string());
    }
    Ok(FdmMagneticSupportSummary {
        semantic_role: "magnetic-support",
        grid_fingerprint,
        bounds_min_m: std::array::from_fn(|axis| {
            origin_m[axis] + f64::from(support_min[axis]) * cell_m[axis]
        }),
        bounds_max_m: std::array::from_fn(|axis| {
            origin_m[axis] + f64::from(support_max_exclusive[axis]) * cell_m[axis]
        }),
        active_cell_count,
        inactive_cell_count,
        active_unassigned_cell_count,
    })
}

/// Serialize the planner-owned FDM grid certificate as a standalone artifact.
///
/// The runner never reconstructs certificate values from geometry; it only
/// publishes the validated resolved certificate carried by the execution plan.
pub(crate) fn grid_certificate_artifacts(plan: &ExecutionPlanIR) -> Vec<AuxiliaryArtifact> {
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
        "build_identity": build_identity_json(),
        "certificate": certificate,
    })) else {
        return Vec::new();
    };
    vec![AuxiliaryArtifact {
        relative_path: "mesh/fdm_grid_certificate.json".to_string(),
        bytes,
    }]
}

/// Persist realized single-grid FDM region membership on the data plane.
///
/// The numeric mask is intentionally kept out of thin JSON metadata.  The
/// companion JSON document contains only the grid/legend identity needed to
/// decode and scope the binary payload. Multilayer FDM deliberately returns
/// no artifact: its independent native grids cannot be truthfully encoded in
/// the one-grid FMRM contract, and publishing a synthetic all-active mask
/// would corrupt object/region ownership.
pub(crate) fn region_membership_artifacts(
    plan: &ExecutionPlanIR,
) -> Result<Vec<AuxiliaryArtifact>, String> {
    let BackendPlanIR::Fdm(fdm) = &plan.backend_plan else {
        return Ok(Vec::new());
    };
    if fdm.region_mask.is_empty() {
        return Ok(Vec::new());
    }
    let certificate = fdm
        .grid_certificate
        .as_ref()
        .ok_or_else(|| "FDM region membership requires a grid certificate".to_string())?;
    certificate.validate_against_masks(fdm.active_mask.as_deref(), &fdm.region_mask)?;
    let expected_cells = usize::try_from(
        u64::from(fdm.grid.cells[0])
            .checked_mul(u64::from(fdm.grid.cells[1]))
            .and_then(|value| value.checked_mul(u64::from(fdm.grid.cells[2])))
            .ok_or_else(|| "FDM region membership cell count overflows u64".to_string())?,
    )
    .map_err(|_| "FDM region membership cell count is not addressable".to_string())?;
    if fdm.region_mask.len() != expected_cells {
        return Err(format!(
            "FDM region membership mask length {} disagrees with grid cell count {}",
            fdm.region_mask.len(),
            expected_cells
        ));
    }

    let magnetic_support = magnetic_support_summary(
        certificate.origin_m,
        certificate.counts,
        certificate.cell_m,
        fdm.active_mask.as_deref(),
        &fdm.region_mask,
        &certificate.grid_fingerprint,
    )?;

    let fingerprint = decode_grid_fingerprint(&certificate.grid_fingerprint)?;
    let mut binary = Vec::with_capacity(64 + fdm.region_mask.len() * std::mem::size_of::<u32>());
    binary.extend_from_slice(b"FMRM");
    binary.push(2); // format version
    binary.push(2); // payload kind: u32 membership (MAX = inactive, 0 = active/unassigned)
    binary.extend_from_slice(&0u16.to_le_bytes());
    for count in fdm.grid.cells {
        binary.extend_from_slice(&count.to_le_bytes());
    }
    let binary_cell_count = u32::try_from(fdm.region_mask.len())
        .map_err(|_| "FDM membership cell count exceeds u32".to_string())?;
    let binary_legend_count = u32::try_from(certificate.region_legend.len())
        .map_err(|_| "FDM region legend count exceeds u32".to_string())?;
    binary.extend_from_slice(&binary_cell_count.to_le_bytes());
    binary.extend_from_slice(&binary_legend_count.to_le_bytes());
    binary.extend_from_slice(&fingerprint);
    binary.extend_from_slice(&[0u8; 4]);
    for (index, region_id) in fdm.region_mask.iter().enumerate() {
        let membership = if fdm.active_mask.as_ref().is_some_and(|mask| !mask[index]) {
            u32::MAX
        } else {
            *region_id
        };
        binary.extend_from_slice(&membership.to_le_bytes());
    }

    let descriptor = serde_json::to_vec_pretty(&serde_json::json!({
        "schema_version": "fdm_region_membership.v2",
        "binary_path": "mesh/fdm_region_membership.v2.bin",
        "domain_generation_id": certificate.grid_fingerprint,
        "grid_fingerprint": certificate.grid_fingerprint,
        "region_legend_fingerprint": certificate.region_legend_fingerprint,
        "origin_m": certificate.origin_m,
        "counts": certificate.counts,
        "cell_m": certificate.cell_m,
        "cell_count": fdm.region_mask.len(),
        "magnetic_support": magnetic_support,
        "object_ids": certificate.object_ids,
        "region_legend": certificate.region_legend,
        "encoding": "FMRM:u32_membership_le",
    }))
    .map_err(|error| format!("FDM region membership descriptor serialization failed: {error}"))?;
    Ok(vec![
        AuxiliaryArtifact {
            relative_path: "mesh/fdm_region_membership.v2.json".to_string(),
            bytes: descriptor,
        },
        AuxiliaryArtifact {
            relative_path: "mesh/fdm_region_membership.v2.bin".to_string(),
            bytes: binary,
        },
    ])
}

fn decode_grid_fingerprint(value: &str) -> Result<[u8; 32], String> {
    if value.len() != 64 {
        return Err(format!(
            "FDM grid fingerprint must contain 64 hexadecimal characters, got {}",
            value.len()
        ));
    }
    let mut bytes = [0u8; 32];
    for (index, chunk) in value.as_bytes().chunks_exact(2).enumerate() {
        let high = (chunk[0] as char)
            .to_digit(16)
            .ok_or_else(|| "FDM grid fingerprint contains non-hexadecimal data".to_string())?;
        let low = (chunk[1] as char)
            .to_digit(16)
            .ok_or_else(|| "FDM grid fingerprint contains non-hexadecimal data".to_string())?;
        bytes[index] = ((high << 4) | low) as u8;
    }
    Ok(bytes)
}

/// Persist the resolved native-to-convolution transfer contract for a
/// multilayer FDM run.  The artifact is intentionally derived from the
/// planner certificate and periodicity, never from runtime-local grid state.
pub(crate) fn transfer_provenance_artifacts(plan: &ExecutionPlanIR) -> Vec<AuxiliaryArtifact> {
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
        "build_identity": build_identity_json(),
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

/// Persist the complete requested/resolved FDM PBC execution contract.
pub(crate) fn pbc_provenance_artifacts(
    plan: &ExecutionPlanIR,
    provenance: &ExecutionProvenance,
) -> Vec<AuxiliaryArtifact> {
    let (
        requested_periodicity,
        origin_m,
        counts,
        cell_m,
        grid_fingerprint,
        enable_demag,
        resolved_periodic_images,
    ) = match &plan.backend_plan {
        BackendPlanIR::Fdm(fdm) => (
            fdm.periodicity.as_ref(),
            fdm.origin_m,
            fdm.grid.cells,
            fdm.cell_size,
            fdm.grid_certificate
                .as_ref()
                .map(|certificate| certificate.grid_fingerprint.clone()),
            fdm.enable_demag,
            fdm.resolved_periodic_images.as_ref(),
        ),
        BackendPlanIR::FdmMultilayer(fdm) => {
            let Some(certificate) = fdm.grid_certificate.as_ref() else {
                return Vec::new();
            };
            (
                fdm.periodicity.as_ref(),
                certificate.origin_m,
                certificate.counts,
                certificate.cell_m,
                Some(certificate.grid_fingerprint.clone()),
                fdm.enable_demag,
                fdm.resolved_periodic_images.as_ref(),
            )
        }
        _ => return Vec::new(),
    };
    let axes = requested_periodicity
        .map(|pbc| {
            pbc.axes
                .map(|axis| matches!(axis, fullmag_ir::AxisBoundary::Periodic))
        })
        .unwrap_or([false; 3]);
    let period_m = [
        f64::from(counts[0]) * cell_m[0],
        f64::from(counts[1]) * cell_m[1],
        f64::from(counts[2]) * cell_m[2],
    ];
    let resolved_demag_boundary =
        requested_periodicity.and_then(|pbc| pbc.resolve_demag_boundary(enable_demag).ok());
    let resolved_periodic_images = resolved_periodic_images.cloned();
    let padded_counts = resolved_periodic_images
        .as_ref()
        .map(|images| images.padded_counts)
        .or_else(|| enable_demag.then_some(counts.map(|value| u64::from(value) * 2)));
    let fft_kernel = resolved_periodic_images
        .as_ref()
        .map(|images| images.kernel.clone())
        .or_else(|| provenance.demag_operator_kind.clone());
    let value = serde_json::json!({
        "schema_version": "fdm_pbc_provenance.v1",
        "build_identity": build_identity_json(),
        "requested_periodicity": requested_periodicity,
        "resolved": {
            "origin_m": origin_m,
            "counts": counts,
            "cell_m": cell_m,
            "period_m": period_m,
            "grid_fingerprint": grid_fingerprint,
            "axes": axes,
            "demag": resolved_demag_boundary,
            "periodic_images": resolved_periodic_images,
            "fft_kernel": fft_kernel,
            "fft_backend": provenance.fft_backend,
            "padded_counts": padded_counts,
        },
        "fallback": provenance.resolved_fallback,
    });
    let Ok(bytes) = serde_json::to_vec_pretty(&value) else {
        return Vec::new();
    };
    vec![AuxiliaryArtifact {
        relative_path: "mesh/fdm_pbc_provenance.v1.json".to_string(),
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
        "H_drive" => observables.drive_field.clone(),
        "H_ani" => observables.anisotropy_field.clone(),
        "H_dmi" => observables.dmi_field.clone(),
        "H_eff" => observables.effective_field.clone(),
        "torque" => observables.torque_field.clone(),
        "H_OE" if include_oersted => observables.oersted_field.clone(),
        other => {
            let available = if include_oersted {
                "m, H_ex, H_demag, H_ext, H_drive, H_ani, H_dmi, H_OE, H_eff, torque"
            } else {
                "m, H_ex, H_demag, H_ext, H_drive, H_ani, H_dmi, H_eff, torque"
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

#[cfg(test)]
mod tests {
    use super::magnetic_support_summary;

    #[test]
    fn magnetic_support_rejects_a_grid_without_active_cells() {
        let error = magnetic_support_summary(
            [1.0e-9, -3.0e-9, 7.0e-9],
            [2, 1, 1],
            [2.0e-9, 3.0e-9, 4.0e-9],
            Some(&[false, false]),
            &[0, 0],
            "grid-fingerprint",
        )
        .expect_err("zero-active support must reject");
        assert!(error.contains("no active cells"));
    }
}
