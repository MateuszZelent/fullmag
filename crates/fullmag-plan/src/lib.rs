//! Execution planning: lowers `ProblemIR` into backend-specific `ExecutionPlanIR`.
//!
//! Phase 1 scope: `Box/Cylinder/SinWaveguide/ArchWaveguide/(ImportedGeometry + precomputed grid asset) +
//! (Exchange | Demag | Zeeman combinations) + fdm/strict`
//! is the legal executable path.
//! Additionally, `backend='fem'` produces an executable `FemPlanIR`
//! when a precomputed `MeshIR` asset is attached; runner execution is fully supported.

use fullmag_ir::{
    AntennaFieldSolvePlanIR, BackendTarget, ExecutionMode, ExecutionPlanIR, ProblemIR, StudyIR,
};

#[cfg(test)]
use fullmag_ir::*;

mod antenna_composition;
mod antenna_current_source;
mod antenna_field_solve;
mod antenna_field_only;
mod antenna_projection;
mod antenna_validity;
mod antenna_zeeman;
mod compute_resources;
mod current_transport;
mod error;
mod execution_profile_guard;
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
pub mod preparation;
pub mod quantities;
mod region_conflict;
mod region_textures;
mod regional_field_drive;
mod sampling;
mod selection;
mod spin_torque;
mod spin_transport;
pub mod study_catalog;
pub mod study_lowering;
mod surface_selectors;
mod util;
mod validate;

pub mod boundary_geometry;

pub use antenna_composition::{bind_antenna_field_solve, bind_antenna_field_solve_v03};
pub use antenna_field_only::plan_antenna_field_only_carrier;
pub use antenna_current_source::{materialize_antenna_external_lead_current_input, materialize_antenna_closed_loop_current_input};
pub use antenna_field_solve::{
    plan_antenna_external_lead_inspection, plan_antenna_field_solve_execution,
    AntennaFieldSolveExecutionPlan,
};
pub use antenna_projection::{resolve_fem_antenna_projection_mask, resolve_fem_antenna_transverse_cell_mask};
pub use antenna_validity::{
    antenna_validity_notes, antenna_waveform_bandwidth_aggregate_note,
    antenna_waveform_bandwidth_notes, classify_antenna_waveform_bandwidth,
};
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
pub use preparation::{
    assess_selective_reuse, NativeFemMeshSpaceEvidence, PreparationCertificate,
    PreparationJacobianQualityCertificate, PreparationMarkerCertificate,
    PreparationMaterialization, PreparationPlan, PreparationPlanError, PreparationPlanSource,
    PreparationProducer, PreparationProducerKind, PreparationQualityCertificate,
    PreparationReuseDecision, PreparationReuseDisposition, PreparationReuseReason,
    PreparationSpaceCertificate, PreparationStateTransfer, PREPARATION_CERTIFICATE_SCHEMA,
    PREPARATION_PLAN_ACCEPTED_RUN_SCHEMA, PREPARATION_PLAN_SCHEMA,
    PREPARATION_STATE_TRANSFER_SCHEMA,
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
pub use study_catalog::{
    capture_study_input_references, lower_study_plan_with_catalog, CapturedStudyInputIdentity,
    CapturedStudyInputReferences, StudyCatalogError, StudyProblemCatalog, StudyProblemCatalogEntry,
    CAPTURED_STUDY_INPUT_IDENTITY_SCHEMA_V1, STUDY_PROBLEM_CATALOG_SCHEMA,
    STUDY_PROBLEM_CATALOG_SCHEMA_V1, STUDY_PROBLEM_CATALOG_SCHEMA_V3,
};
pub use study_lowering::{
    lower_study_plan, StudyExecutionPlan, StudyLoweringError, StudyStepExecutionPlan,
    StudyStepLoweringStatus, STUDY_EXECUTION_PLAN_SCHEMA, STUDY_EXECUTION_PLAN_SCHEMA_V1,
    STUDY_EXECUTION_PLAN_SCHEMA_V2,
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
    execution_profile_guard::validate_bound_intent(problem).map_err(|reason| PlanError {
        reasons: vec![reason],
    })?;
    if matches!(problem.study, fullmag_ir::StudyIR::FieldOnly { .. }) {
        let stage_id = util::active_stage_id(problem).ok_or_else(|| PlanError {
            reasons: vec!["field_only requires an explicitly selected antenna stage; drafts are not executable".into()],
        })?;
        let stage = problem.antenna_field_solve_stages.iter().find(|stage| stage.id == stage_id)
            .ok_or_else(|| PlanError { reasons: vec!["field_only selected antenna stage is missing".into()] })?;
        if stage.port_mode_ids.len() != 1 {
            return Err(PlanError { reasons: vec!["field_only requires exactly one selected port mode".into()] });
        }
        return plan_antenna_field_only_carrier(problem, stage_id, &stage.port_mode_ids[0]);
    }
    if matches!(problem.study, StudyIR::AntennaFieldSolve { .. }) {
        return antenna_field_solve::plan_standalone_antenna(problem);
    }
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

    if let Some(resources) =
        fullmag_ir::ComputeResourcesIR::from_problem(problem).map_err(|reason| PlanError {
            reasons: vec![reason],
        })?
    {
        compute_resources::validate_current_runtime_support(&resources)
            .map_err(|reasons| PlanError { reasons })?;
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

    let requests_finite_k = problem
        .problem_meta
        .runtime_metadata
        .get("spin_wave_response")
        .and_then(|request| request.get("analysis"))
        .and_then(|analysis| analysis.as_str())
        == Some("finite_k");
    if requests_finite_k && resolved_backend != BackendTarget::Fem {
        errors.push(
            "spin_wave_response.finite_k_requires_fem_backend; fallback=none".to_string(),
        );
    }
    if requests_finite_k {
        if !has_active_finite_k_source(problem) {
            errors.push("spin_wave_response.finite_k_requires_active_localized_or_solved_antenna_source".into());
        }
        let field_periods = |quantity: &str| {
            problem.study.sampling().outputs.iter().filter_map(|output| match output {
                fullmag_ir::OutputIR::Field { name, every_seconds }
                | fullmag_ir::OutputIR::FieldResolvedAuto { name, every_seconds, .. }
                    if name == quantity => Some(*every_seconds),
                _ => None,
            }).collect::<Vec<_>>()
        };
        let magnetization_periods = field_periods("m");
        let drive_periods = field_periods("H_drive");
        if magnetization_periods.is_empty() || drive_periods.is_empty() {
            errors.push("spin_wave_response.finite_k_requires_m_and_h_drive_field_outputs".into());
        } else {
            let period = magnetization_periods[0];
            if !period.is_finite() || period <= 0.0
                || magnetization_periods.iter().chain(&drive_periods).any(|candidate| *candidate != period)
            {
                errors.push("spin_wave_response.finite_k_requires_matching_field_sampling_periods".into());
            }
        }
    }

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
            if let StudyIR::Eigenmodes {
                bias_field_sweep: Some(_),
                ..
            } = problem.study
            {
                return Err(PlanError {
                    reasons: vec![
                        "eigenmodes.bias_field_sweep_requires_fem_backend; fallback=none"
                            .to_string(),
                    ],
                });
            }
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

    execution_plan
        .provenance
        .notes
        .extend(antenna_waveform_bandwidth_notes(problem));
    execution_plan
        .provenance
        .notes
        .push(antenna_waveform_bandwidth_aggregate_note(problem));
    execution_plan
        .provenance
        .notes
        .extend(antenna_validity_notes(problem));

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

fn has_active_finite_k_source(problem: &ProblemIR) -> bool {
    problem.field_drives.iter().any(|drive| {
        util::field_drive_is_active(drive, problem)
            && (!matches!(drive.target, fullmag_ir::FieldTargetIR::Global {})
                || matches!(drive.spatial_profile, fullmag_ir::FieldSpatialProfileIR::GeometryMask { .. }))
    }) || problem.solved_antenna_drives.iter().any(|drive| {
        drive.peak_current_a.is_finite()
            && drive.peak_current_a != 0.0
            && util::drive_activation_is_active(&drive.activation, problem)
    })
}

#[cfg(test)]
#[test]
fn finite_k_source_gate_respects_antenna_stage_and_current() {
    let mut problem = ProblemIR::bootstrap_example();
    problem.field_drives.clear();
    problem.problem_meta.runtime_metadata.insert("active_stage_id".into(), serde_json::json!("run"));
    problem.solved_antenna_drives = vec![SolvedAntennaDriveIR {
        id: "antenna-drive".into(),
        name: "Antenna drive".into(),
        projection_ref: "projection".into(),
        port_mode_id: "port".into(),
        peak_current_a: 1e-3,
        waveform: TimeDependenceIR::Constant,
        bandwidth_declaration: None,
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::StageIds { stage_ids: vec!["other".into()] },
    }];
    assert!(!has_active_finite_k_source(&problem));
    problem.field_drives.push(RegionalFieldDriveIR {
        id: "global-drive".into(),
        name: "Global drive".into(),
        kind: FieldDriveKindIR::Regional,
        enabled: true,
        target: FieldTargetIR::Global {},
        amplitude_b_t: 1e-3,
        direction: [0.0, 1.0, 0.0],
        spatial_profile: FieldSpatialProfileIR::Uniform {},
        waveform: TimeDependenceIR::Constant,
        time_origin: FieldTimeOriginIR::StageLocal,
        activation: DriveActivationIR::AllTimeEvolution {},
        migration: None,
    });
    assert!(!has_active_finite_k_source(&problem), "global companion must not activate an antenna assigned to another stage");
    problem.field_drives[0].spatial_profile = FieldSpatialProfileIR::GeometryMask {
        object_id: "strip".into(),
        envelope: FieldEnvelopeIR::Uniform {},
    };
    assert!(has_active_finite_k_source(&problem));
    problem.field_drives[0].enabled = false;
    assert!(!has_active_finite_k_source(&problem));
    problem.solved_antenna_drives[0].activation = DriveActivationIR::StageIds { stage_ids: vec!["run".into()] };
    assert!(has_active_finite_k_source(&problem));
    for current in [0.0, f64::NAN, f64::INFINITY] {
        problem.solved_antenna_drives[0].peak_current_a = current;
        assert!(!has_active_finite_k_source(&problem));
    }
    problem.solved_antenna_drives[0].peak_current_a = -1e-3;
    assert!(has_active_finite_k_source(&problem));
}

/// Plan one explicit static antenna basis solve without authorizing LLG,
/// relaxation, eigenmode, or frequency-response execution.
pub fn plan_antenna_field_solve(
    problem: &ProblemIR,
    stage_id: &str,
    port_mode_id: &str,
) -> Result<AntennaFieldSolvePlanIR, PlanError> {
    antenna_field_solve::plan_antenna_field_solve_v03(problem, stage_id, port_mode_id)
}

#[cfg(test)]
mod tests;

pub use study_lowering::{validate_closed_loop_operation, STUDY_EXECUTION_PLAN_SCHEMA_V4};
