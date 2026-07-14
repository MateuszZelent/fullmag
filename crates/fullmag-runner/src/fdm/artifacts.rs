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
