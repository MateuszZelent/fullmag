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
mod magnetization_textures_v2;
mod material;
mod material_transition;
mod mesh;
mod oersted;
mod physics_graph;
pub mod quantities;
mod region_conflict;
mod region_textures;
mod regional_field_drive;
mod sampling;
mod selection;
mod spin_torque;
mod spin_transport;
mod surface_selectors;
mod util;
mod validate;

pub mod boundary_geometry;

pub use error::PlanError;
pub use fdm::{
    checked_multilayer_aggregate_memory_bytes, checked_multilayer_pair_kernel_footprint,
    fdm_multilayer_cuda_containment_reason_codes, fdm_multilayer_cuda_material_field_errors,
    fdm_multilayer_cuda_native_single_grid_eligible, resolve_multilayer_kernel_memory,
    ResolvedMultilayerKernelMemory, FDM_CUDA_MULTILAYER_HETEROGENEOUS_NATIVE_HZ_UNQUALIFIED,
    FDM_CUDA_MULTILAYER_MATERIAL_FIELD_UNQUALIFIED, FDM_CUDA_MULTILAYER_PUSH_PULL_UNQUALIFIED,
    FDM_CUDA_MULTILAYER_TWO_D_STACK_UNQUALIFIED, FDM_CUDA_MULTILAYER_XY_OFFSET_UNQUALIFIED,
};
pub use geometry::{
    checked_fdm_grid_cost, FdmGridCost, FDM_GRID_ESTIMATED_BYTES_PER_CELL, FDM_GRID_MAX_BYTES,
    FDM_GRID_MAX_CELLS,
};
pub use magnetization_textures::{sample_preset_texture, TextureSamplePoint};
pub use magnetization_textures_v2::{
    sample_preset_texture_versioned, OrientedPlaneFrame, TextureError,
};
pub use physics_graph::{
    physics_graph_provenance_notes, physics_graph_realization_provenance,
    physics_graph_runtime_provenance, physics_graph_sha256, resolve_physics_graph,
    resolve_physics_modules, ResolvedPhysicsModule,
};
pub use quantities::{
    default_capability_matrix, validate_quantity_requests, BackendFamily, CapabilityMatrix,
    QuantityCapability,
};
pub use sampling::{
    resolve_auto_sampling_for_stage, validate_continuous_autosave_targets,
    validate_stage_autosave_capabilities, ResolvedAutosaveClock, ResolvedStageAutosave,
    SamplingResolutionIR, SAMPLING_RESOLUTION_SCHEMA_VERSION,
};
pub use selection::geometry::{
    evaluate_geometry_predicate, AffineTransform3, BoundaryMembership, GeometryPredicate,
    SelectionError,
};
pub use selection::{
    compile_fdm_frozen_spins, compile_fem_frozen_spins, FdmFrozenSpinsDomain, FemIncidentElement,
    FemTrueDofDomain, FrozenSpinsCompileRequest, FrozenSpinsStateSnapshot,
    ResolvedFrozenSpinsReference, SelectionDofMembership,
};
pub use surface_selectors::{resolve_fem_surface_selector, ResolvedFemSurfaceSelector};
pub use util::generate_random_unit_vectors;

fn routes_to_fdm_multilayer(problem: &ProblemIR) -> bool {
    let requested_demag_strategy = problem
        .backend_policy
        .discretization_hints
        .as_ref()
        .and_then(|hints| hints.fdm.as_ref())
        .and_then(|fdm| fdm.demag.as_ref())
        .map(|demag| demag.strategy.as_str())
        .unwrap_or("auto");
    problem.magnets.len() > 1 || requested_demag_strategy == "multilayer_convolution"
}

/// Plans a `ProblemIR` into an `ExecutionPlanIR`.
///
/// Current planner coverage:
/// - executable FDM: `Box | Cylinder | SinWaveguide | ArchWaveguide | ImportedGeometry + precomputed active_mask`
///   with the narrow interaction subset,
/// - executable multilayer FDM for stacked multi-body cases,
/// - executable FEM / FEM eigen with precomputed mesh assets.
pub fn plan(problem: &ProblemIR) -> Result<ExecutionPlanIR, PlanError> {
    if sampling::has_unresolved_auto_sampling(problem) {
        let context = if util::active_stage_id(problem).is_none() {
            "runtime_metadata.active_stage_id and an enabled active sinc drive"
        } else {
            "per-stage automatic sampling resolution"
        };
        return Err(PlanError {
            reasons: vec![format!(
                "automatic sampling is unresolved; {context} are required before backend planning"
            )],
        });
    }
    if let Err(validation_errors) = problem.validate() {
        return Err(PlanError {
            reasons: validation_errors,
        });
    }
    if let Err(graph_errors) = resolve_physics_graph(problem) {
        return Err(PlanError {
            reasons: graph_errors,
        });
    }

    let mut errors = Vec::new();
    let resolved_backend = match problem.backend_policy.requested_backend {
        BackendTarget::Fdm => BackendTarget::Fdm,
        BackendTarget::Auto => {
            if let Err(reason) = mesh::reject_auto_backend_mixed_fem_topology(problem) {
                errors.push(reason);
            }
            validate::resolve_auto_backend(problem)
        }
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

    let mut execution_plan = match resolved_backend {
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
            if routes_to_fdm_multilayer(problem) {
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
    }?;

    if problem.physics_graph.is_some() {
        let notes = physics_graph_provenance_notes(problem, resolved_backend)
            .map_err(|reasons| PlanError { reasons })?;
        execution_plan.provenance.notes.extend(notes);
        execution_plan.provenance.physics_graph =
            physics_graph_runtime_provenance(problem, &execution_plan.backend_plan)
                .map_err(|reasons| PlanError { reasons })?;
    }

    Ok(execution_plan)
}

#[cfg(test)]
mod tests;
