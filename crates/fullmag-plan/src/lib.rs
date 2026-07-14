//! Execution planning: lowers `ProblemIR` into backend-specific `ExecutionPlanIR`.
//!
//! Phase 1 scope: `Box/Cylinder/SinWaveguide/ArchWaveguide/(ImportedGeometry + precomputed grid asset) +
//! (Exchange | Demag | Zeeman combinations) + fdm/strict`
//! is the legal executable path.
//! Additionally, `backend='fem'` produces an executable `FemPlanIR`
//! when a precomputed `MeshIR` asset is attached; runner execution is fully supported.

use fullmag_ir::{BackendTarget, ExecutionMode, ExecutionPlanIR, ProblemIR, StudyIR};

#[cfg(test)]
use fullmag_ir::*;

mod antenna_zeeman;
mod current_transport;
mod error;
mod fdm;
mod fem;
mod geometry;
mod magnetization_textures;
mod material;
mod material_transition;
mod mesh;
mod oersted;
pub mod quantities;
mod region_conflict;
mod spin_torque;
mod surface_selectors;
mod util;
mod validate;

pub mod boundary_geometry;

pub use error::PlanError;
pub use geometry::{
    checked_fdm_grid_cost, FdmGridCost, FDM_GRID_ESTIMATED_BYTES_PER_CELL,
    FDM_GRID_MAX_BYTES, FDM_GRID_MAX_CELLS,
};
pub use magnetization_textures::{sample_preset_texture, TextureSamplePoint};
pub use quantities::{
    default_capability_matrix, validate_quantity_requests, BackendFamily, CapabilityMatrix,
    QuantityCapability,
};
pub use surface_selectors::{resolve_fem_surface_selector, ResolvedFemSurfaceSelector};
pub use util::generate_random_unit_vectors;

/// Plans a `ProblemIR` into an `ExecutionPlanIR`.
///
/// Current planner coverage:
/// - executable FDM: `Box | Cylinder | SinWaveguide | ArchWaveguide | ImportedGeometry + precomputed active_mask`
///   with the narrow interaction subset,
/// - executable multilayer FDM for stacked multi-body cases,
/// - executable FEM / FEM eigen with precomputed mesh assets.
pub fn plan(problem: &ProblemIR) -> Result<ExecutionPlanIR, PlanError> {
    if let Err(validation_errors) = problem.validate() {
        return Err(PlanError {
            reasons: validation_errors,
        });
    }

    let mut errors = Vec::new();
    let resolved_backend = match problem.backend_policy.requested_backend {
        BackendTarget::Fdm => BackendTarget::Fdm,
        BackendTarget::Auto => validate::resolve_auto_backend(problem),
        BackendTarget::Fem => BackendTarget::Fem,
        other => {
            errors.push(format!(
                "backend '{}' is not yet supported by the current planner entry point",
                other.as_str()
            ));
            BackendTarget::Fdm
        }
    };

    if problem.validation_profile.execution_mode == ExecutionMode::Hybrid {
        errors.push("execution_mode='hybrid' is not supported by the current planner".to_string());
    }
    validate::validate_region_owned_planning(problem, resolved_backend, &mut errors);

    if !errors.is_empty() {
        return Err(PlanError { reasons: errors });
    }

    match resolved_backend {
        BackendTarget::Fem => match &problem.study {
            StudyIR::Eigenmodes { .. } => fem::plan_fem_eigen(problem, resolved_backend),
            StudyIR::FrequencyResponse { .. } => {
                fem::plan_fem_frequency_response(problem, resolved_backend)
            }
            _ => fem::plan_fem(problem, resolved_backend),
        },
        BackendTarget::Fdm => {
            if matches!(problem.study, StudyIR::Eigenmodes { .. }) {
                return Err(PlanError {
                    reasons: vec![
                        "StudyIR::Eigenmodes is currently executable only with backend='fem'"
                            .to_string(),
                    ],
                });
            }
            if matches!(problem.study, StudyIR::FrequencyResponse { .. }) {
                return Err(PlanError {
                    reasons: vec![
                        "StudyIR::FrequencyResponse is not executable on backend='fdm'; use backend='fem' for the dense validation frequency-response path or wait for a production FDM frequency-domain backend"
                            .to_string(),
                    ],
                });
            }
            if problem.magnets.len() > 1 {
                fdm::plan_fdm_multilayer(problem, resolved_backend)
            } else {
                fdm::plan_fdm(problem, resolved_backend)
            }
        }
        BackendTarget::Hybrid => Err(PlanError {
            reasons: vec![
                "backend 'hybrid' is not yet supported by the current planner entry point"
                    .to_string(),
            ],
        }),
        BackendTarget::Auto => unreachable!("auto backend should resolve before dispatch"),
    }
}

#[cfg(test)]
mod tests;
